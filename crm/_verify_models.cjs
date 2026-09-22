/**
 * 可切换 Agent 模型 —— 端到端验证 + 截图
 *
 * 覆盖：
 *   A. Agent 管理面板 →「模型管理」Tab：表格渲染、汇总条、开关、编辑、添加、删除
 *   B. CRM AI 助手页（/chat）：输入框底部模型下拉框、切换后请求体带 model 字段
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）。
 * 数据安全：新增的临时模型跑完必删；被改动的模型开关/字段逐项还原。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9951;
const CRM_BASE = "http://127.0.0.1:3100";
const AGENT_BASE = "http://127.0.0.1:8765";
const OUT = path.join(__dirname, "_models_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_ID = "e2e-tmp-model";

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    this.ws.send(JSON.stringify(p));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout: " + method));
        }
      }, 40000);
    });
  }
}

async function evalJS(cdp, sid, expr) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.exceptionDetails)
    throw new Error(`[${expr.slice(0, 70)}] ` + JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result.value;
}

async function waitFor(cdp, sid, expr, label, t = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try {
      if (await evalJS(cdp, sid, expr)) return true;
    } catch {
      /* ignore */
    }
    await sleep(400);
  }
  console.log("  ! 超时:", label);
  return false;
}

/** 受控 input/textarea 的赋值（React 需要 native setter + input 事件） */
const setInput = (sel, val) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

async function shot(cdp, sid, name) {
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  } catch (e) {
    console.log("  ! 截图失败", name, e.message);
  }
}

async function apiModels() {
  const r = await fetch(`${AGENT_BASE}/api/panel/models`, { cache: "no-store" });
  return r.json();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-models-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${udd}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--window-size=1600,1080",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(300);
    }
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1600, height: 1080, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  let pass = 0;
  const fail = [];
  const check = (n, c, extra = "") => {
    if (c) {
      pass++;
      console.log("[PASS]", n);
    } else {
      fail.push(n);
      console.log("[FAIL]", n, "::", extra);
    }
  };

  // 快照：记录初始模型配置，跑完还原
  const before = await apiModels();
  const beforeMap = new Map(before.models.map((m) => [m.id, m]));

  // 前置清理：删掉上一轮可能的残留
  try {
    await fetch(`${AGENT_BASE}/api/panel/models/${TMP_ID}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }

  // 捕获 /api/agent/chat 的请求体，验证 model 字段
  const chatBodies = [];
  cdp.ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Network.requestWillBeSent" && m.sessionId === sessionId) {
      const url = m.params?.request?.url || "";
      if (url.includes("/api/agent/chat")) {
        chatBodies.push(m.params.request.postData || "");
      }
    }
  });

  try {
    /* ---------- 1. 注入管理员登录态 ---------- */
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "login 页加载");
    const store = await evalJS(
      cdp,
      sessionId,
      `fetch('/api/auth/login', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ phone: '13912345678', password: '123123' })
       })
       .then(r => r.json())
       .then(d => {
         if (!d || !d.user || !d.token) return '';
         const v = JSON.stringify({ user: d.user, role: d.role, token: d.token });
         localStorage.setItem('crm_auth', v);
         return v;
       })`,
    );
    check("F1 注入管理员登录态", typeof store === "string" && store.length > 20, String(store).slice(0, 80));

    /* ---------- 2. 打开 Agent 管理面板 → 模型管理 Tab ---------- */
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/agent` }, sessionId);
    await waitFor(cdp, sessionId, "document.body.innerText.includes('Agent 控制面板')", "面板标题");
    await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"tab-model\"]')", "模型管理 Tab");
    await sleep(800);

    const hasTab = await evalJS(cdp, sessionId, `!!document.querySelector('[data-testid="tab-model"]')`);
    check("F2 存在「模型管理」Tab", hasTab);

    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="tab-model"]').click(); true`);
    await waitFor(cdp, sessionId, "document.body.innerText.includes('模型列表')", "模型列表渲染");
    await sleep(900);

    await shot(cdp, sessionId, "01-model-tab.png");

    /* ---------- 3. 表格三列断言 ---------- */
    const rows = await evalJS(
      cdp,
      sessionId,
      `Array.from(document.querySelectorAll('[data-testid^="model-row-"]')).map(r => r.getAttribute('data-testid').replace('model-row-',''))`,
    );
    check("F3 两个种子模型都渲染出行", Array.isArray(rows) && rows.length === 2, JSON.stringify(rows));
    for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
      check(`F4 存在行 ${id}`, Array.isArray(rows) && rows.includes(id));
    }
    check(
      "F4.1 已移除 vision 模型",
      Array.isArray(rows) && !rows.includes("deepseek-v4-flash-vision-exp"),
      JSON.stringify(rows),
    );

    const rowText = await evalJS(
      cdp,
      sessionId,
      `(document.querySelector('[data-testid="model-row-deepseek-flash"]')||{}).innerText || ''`,
    );
    check("F5 行内含模型名称", rowText.includes("deepseek-flash"), rowText.slice(0, 120));
    check("F6 行内含状态", /已开启|已关闭/.test(rowText), rowText.slice(0, 120));

    const btns = await evalJS(
      cdp,
      sessionId,
      `({
        edit: !!document.querySelector('[data-testid="model-edit-deepseek-flash"]'),
        toggle: !!document.querySelector('[data-testid="model-toggle-deepseek-flash"]'),
        del: !!document.querySelector('[data-testid="model-delete-deepseek-flash"]')
      })`,
    );
    check("F7 行内有编辑/开启关闭/删除三个按钮", btns.edit && btns.toggle && btns.del, JSON.stringify(btns));

    const summary = await evalJS(cdp, sessionId, `document.body.innerText`);
    check("F8 汇总条显示共 2 个模型", /共\s*2\s*个模型/.test(summary.replace(/\s+/g, " ")), summary.slice(0, 200));
    check("F9 汇总条显示支持图片识别", summary.includes("支持图片识别"));
    // ⚠️ 数字必须跟随真实能力，不要硬编码 0。
    //    `deepseek-flash` 官方支持图文混排（多模态已并入主线 Flash）→ vision:true，
    //    所以这里应为 1。若将来再加/去掉 vision 模型，改 seed 后同步改这个期望值。
    const visionCount = Number(
      (summary.replace(/\s+/g, " ").match(/支持图片识别\s*(\d+)/) || [])[1] ?? -1,
    );
    check(
      "F9.1 支持图片识别数为 1（deepseek-flash）",
      visionCount === 1,
      `visionCount=${visionCount} :: ${summary.replace(/\s+/g, " ").slice(0, 200)}`,
    );

    /* ---------- 4. 编辑弹窗：5 个字段 ---------- */
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-edit-deepseek-v4-pro"]').click(); true`);
    await waitFor(cdp, sessionId, "document.body.innerText.includes('编辑模型')", "编辑弹窗");
    await sleep(600);
    await shot(cdp, sessionId, "02-model-edit-modal.png");

    const fields = await evalJS(
      cdp,
      sessionId,
      `({
        id: (document.querySelector('[data-testid="model-field-id"]')||{}).value || '',
        name: (document.querySelector('[data-testid="model-field-name"]')||{}).value || '',
        baseUrl: (document.querySelector('[data-testid="model-field-base-url"]')||{}).value || '',
        ctx: (document.querySelector('[data-testid="model-field-context"]')||{}).value || '',
        hasKey: !!document.querySelector('[data-testid="model-field-api-key"]'),
        modalText: (document.querySelector('[data-testid="model-field-api-key"]') ? document.body.innerText : '')
      })`,
    );
    check("F10 弹窗回填模型 ID", fields.id === "deepseek-v4-pro", fields.id);
    check("F11 弹窗回填模型名称", fields.name === "deepseek-v4-pro", fields.name);
    check("F12 弹窗回填 API 地址", fields.baseUrl.includes("api.deepseek.com"), fields.baseUrl);
    check("F13 弹窗回填上下文长度 1048576", String(fields.ctx) === "1048576", String(fields.ctx));
    check("F14 弹窗含模型 key 输入框", fields.hasKey);
    check("F15 弹窗含「是否支持图片识别」", fields.modalText.includes("是否支持图片识别"));
    check("F16 弹窗含「上下文长度」标签", fields.modalText.includes("上下文长度"));

    // 关闭
    await evalJS(
      cdp,
      sessionId,
      `(() => { const b = Array.from(document.querySelectorAll('button')).reverse().find(x => (x.innerText||'').trim() === '取消'); if (b) b.click(); return !!b; })()`,
    );
    await sleep(600);

    /* ---------- 5. 添加模型 ---------- */
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-add"]').click(); true`);
    await waitFor(cdp, sessionId, "document.body.innerText.includes('添加模型')", "添加弹窗");
    await sleep(500);

    const emptyDraft = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="model-field-id"]'); return el ? el.value : '__MISSING__'; })()`,
    );
    check("F17 添加弹窗默认空 ID", emptyDraft === "", JSON.stringify(emptyDraft));

    await evalJS(cdp, sessionId, setInput('[data-testid="model-field-id"]', TMP_ID));
    await sleep(200);
    await evalJS(cdp, sessionId, setInput('[data-testid="model-field-name"]', "e2e-tmp-model"));
    await sleep(200);
    await evalJS(cdp, sessionId, setInput('[data-testid="model-field-base-url"]', "https://api.deepseek.com/v1"));
    await sleep(200);
    await evalJS(cdp, sessionId, setInput('[data-testid="model-field-context"]', "65536"));
    await sleep(400);
    await shot(cdp, sessionId, "03-model-add-modal.png");

    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-save"]').click(); true`);
    await sleep(2200);

    const afterAdd = await apiModels();
    const added = afterAdd.models.find((m) => m.id === TMP_ID);
    check("F18 新增模型成功落库", !!added, JSON.stringify(afterAdd.models.map((m) => m.id)));
    check("F19 新增模型上下文长度正确", added && added.context_length === 65536, String(added && added.context_length));

    await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="model-row-${TMP_ID}"]')`,
      "新增行渲染",
    );
    check(
      "F20 表格出现新增的模型行",
      await evalJS(cdp, sessionId, `!!document.querySelector('[data-testid="model-row-${TMP_ID}"]')`),
    );

    /* ---------- 6. 关闭 / 开启 ---------- */
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-toggle-${TMP_ID}"]').click(); true`);
    await sleep(1800);
    const afterOff = await apiModels();
    const off = afterOff.models.find((m) => m.id === TMP_ID);
    check("F21 关闭模型生效", off && off.enabled === false, JSON.stringify(off));

    const offRowText = await evalJS(
      cdp,
      sessionId,
      `(document.querySelector('[data-testid="model-row-${TMP_ID}"]')||{}).innerText || ''`,
    );
    check("F22 关闭后状态标签变「已关闭」", offRowText.includes("已关闭"), offRowText);
    await shot(cdp, sessionId, "04-model-toggled.png");

    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-toggle-${TMP_ID}"]').click(); true`);
    await sleep(1800);
    const afterOn = await apiModels();
    const on = afterOn.models.find((m) => m.id === TMP_ID);
    check("F23 重新开启模型生效", on && on.enabled === true, JSON.stringify(on));

    /* ---------- 7. 校验失败路径（空名称） ---------- */
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-edit-${TMP_ID}"]').click(); true`);
    await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"model-field-name\"]')", "编辑弹窗2");
    await sleep(400);
    await evalJS(cdp, sessionId, setInput('[data-testid="model-field-name"]', ""));
    await sleep(300);
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-save"]').click(); true`);
    await sleep(700);
    const errText = await evalJS(
      cdp,
      sessionId,
      `(document.querySelector('[data-testid="model-error"]')||{}).innerText || ''`,
    );
    check("F24 空名称给出前端校验提示", errText.includes("名称"), errText);
    await evalJS(
      cdp,
      sessionId,
      `(() => { const b = Array.from(document.querySelectorAll('button')).reverse().find(x => (x.innerText||'').trim() === '取消'); if (b) b.click(); return !!b; })()`,
    );
    await sleep(500);

    /* ---------- 8. 删除 ---------- */
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-delete-${TMP_ID}"]').click(); true`);
    await waitFor(cdp, sessionId, "document.body.innerText.includes('删除模型')", "删除确认弹窗");
    await sleep(500);
    await shot(cdp, sessionId, "05-model-delete-modal.png");
    const delModal = await evalJS(cdp, sessionId, `document.body.innerText`);
    check("F25 删除弹窗提示不可用影响", delModal.includes("不再出现在对话界面的模型下拉框中"));

    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="model-delete-confirm"]').click(); true`);
    await sleep(2000);
    const afterDel = await apiModels();
    check("F26 删除模型成功", !afterDel.models.some((m) => m.id === TMP_ID), JSON.stringify(afterDel.models.map((m) => m.id)));
    check(
      "F27 删除后表格行消失",
      await evalJS(cdp, sessionId, `!document.querySelector('[data-testid="model-row-${TMP_ID}"]')`),
    );

    /* ---------- 9. 对话界面模型下拉框 ---------- */
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页加载");
    await sleep(1800);
    // 回到空会话，保证有输入框
    for (let i = 0; i < 3; i++) {
      const has = await evalJS(cdp, sessionId, `!!document.querySelector('[data-testid="chat-input"]')`);
      if (has) break;
      await sleep(1000);
    }

    const sel = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const s = document.querySelector('[data-testid="chat-model-select"]');
        if (!s) return null;
        return { value: s.value, options: Array.from(s.options).map(o => o.value) };
      })()`,
    );
    check("F28 对话界面存在模型下拉框", !!sel, JSON.stringify(sel));
    check("F29 下拉框含 2 个已开启模型", sel && sel.options.length === 2, JSON.stringify(sel && sel.options));
    check(
      "F30 下拉框包含 deepseek-flash",
      sel && sel.options.includes("deepseek-flash"),
      JSON.stringify(sel && sel.options),
    );
    check(
      "F30.1 下拉框不含已删除的 vision 模型",
      sel && !sel.options.includes("deepseek-v4-flash-vision-exp"),
      JSON.stringify(sel && sel.options),
    );
    await shot(cdp, sessionId, "06-chat-model-select.png");

    // 切换到 pro
    await evalJS(
      cdp,
      sessionId,
      `(() => {
        const s = document.querySelector('[data-testid="chat-model-select"]');
        if (!s) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(s, 'deepseek-v4-pro');
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await sleep(600);
    const switched = await evalJS(
      cdp,
      sessionId,
      `(document.querySelector('[data-testid="chat-model-select"]')||{}).value || ''`,
    );
    check("F31 切换到 deepseek-v4-pro 生效", switched === "deepseek-v4-pro", switched);

    // 发一条消息，验证请求体带 model
    await evalJS(cdp, sessionId, setInput('[data-testid="chat-input"]', "你好，请只回复两个字：收到"));
    await sleep(700);
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="chat-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
    await sleep(3000);

    const bodyHit = chatBodies.find((b) => b.includes("deepseek-v4-pro"));
    check("F32 请求体携带所选模型 id", !!bodyHit, JSON.stringify(chatBodies).slice(0, 300));
    let modelInBody = "";
    try {
      modelInBody = JSON.parse(bodyHit || "{}").model || "";
    } catch {
      /* ignore */
    }
    check("F33 请求体 model 字段正确", modelInBody === "deepseek-v4-pro", modelInBody);

    // 等回答产出（避免留下 pending 会话状态）
    await waitFor(
      cdp,
      sessionId,
      `!document.body.innerText.includes('正在思考') || document.body.innerText.includes('收到')`,
      "AI 回答产出",
      90000,
    );
    await sleep(1200);
    await shot(cdp, sessionId, "07-chat-answer.png");

    const answerText = await evalJS(cdp, sessionId, `document.body.innerText`);
    check("F34 新模型成功产出回答", answerText.includes("收到") || answerText.length > 800, answerText.slice(-200));
  } finally {
    /* ---------- 清理：还原模型配置 ---------- */
    console.log("\n--- 清理 ---");
    try {
      await fetch(`${AGENT_BASE}/api/panel/models/${TMP_ID}`, { method: "DELETE" });
      console.log("  -> 已删除临时模型", TMP_ID);
    } catch (e) {
      console.log("  !! 删除临时模型失败：", e.message);
    }
    // 还原初始的开关状态
    const now = await apiModels();
    for (const m of now.models) {
      const b = beforeMap.get(m.id);
      if (b && b.enabled !== m.enabled) {
        await fetch(`${AGENT_BASE}/api/panel/models/${encodeURIComponent(m.id)}/enabled`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: b.enabled }),
        });
        console.log(`  -> 已还原 ${m.id} 开关为 ${b.enabled}`);
      }
    }
    try {
      await cdp.send("Browser.close");
    } catch {
      /* ignore */
    }
    ws.close();
    setTimeout(() => {
      try {
        chrome.kill();
      } catch {
        /* ignore */
      }
    }, 800);

    console.log("");
    console.log("=".repeat(60));
    console.log(`前端验证: ${pass}/${pass + fail.length} 通过`);
    if (fail.length) console.log("失败项:", fail.join(", "));
    console.log("截图目录:", OUT);
    console.log("=".repeat(60));
    process.exit(fail.length ? 1 : 0);
  }
})().catch((e) => {
  console.error("验证脚本异常:", e);
  process.exit(2);
});
