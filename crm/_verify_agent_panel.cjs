/**
 * Agent 控制面板 —— 无头浏览器端到端验证 + 截图
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）：
 *   1) 启动无头 Chrome（独立 user-data-dir）
 *   2) 打开 /login，注入管理员登录态到 localStorage
 *   3) 打开 /agent，等待面板渲染，断言语义元素
 *   4) 分别对「概览 / 系统提示词 / 可用工具 / 工具权限」截图
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9933;
const BASE = "http://127.0.0.1:3100";
const OUT_DIR = process.argv[2] || path.join(__dirname, "_panel_screenshots");

const PASS = { n: 0 };
const FAIL = [];
function check(name, cond, extra = "") {
  if (cond) {
    PASS.n++;
    console.log(`[PASS] ${name}`);
  } else {
    FAIL.push(name);
    console.log(`[FAIL] ${name} :: ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const res = await fetch(url);
  return res.json();
}

/** 极简 CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 40000);
    });
  }
}

async function evalJS(cdp, sessionId, expression) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

async function waitFor(cdp, sessionId, expression, label, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(cdp, sessionId, expression)) return true;
    } catch {
      /* 页面切换中，重试 */
    }
    await sleep(400);
  }
  console.log(`  ! 等待超时: ${label}`);
  return false;
}

async function shoot(cdp, sessionId, file) {
  const r = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    sessionId
  );
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(r.data, "base64"));
  console.log(`  -> 截图 ${file}`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-panel-"));

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let version = null;
  for (let i = 0; i < 40; i++) {
    try {
      version = await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      break;
    } catch {
      await sleep(300);
    }
  }
  if (!version) throw new Error("Chrome 调试端口未就绪");

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId
  );

  try {
    /* ---------- 1. 注入登录态 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "login 页加载");

    // 直接在页面上下文里调用登录接口，写入 localStorage（不落地任何凭据文件）
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
       })`
    );
    check("F1 注入管理员登录态", typeof store === "string" && store.length > 20,
      String(store).slice(0, 80));

    /* ---------- 2. 打开 Agent 控制面板 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/agent` }, sessionId);
    const rendered = await waitFor(
      cdp,
      sessionId,
      "document.body.innerText.includes('Agent 控制面板')",
      "面板标题"
    );
    check("F2 面板页面渲染出标题", rendered);

    // 等概览数据加载（健康检查出现「正常」或「异常」）
    await waitFor(
      cdp,
      sessionId,
      "document.body.innerText.includes('服务健康检查') && /正常|异常|检测中/.test(document.body.innerText)",
      "概览指标"
    );
    await sleep(1500);

    const bodyText = await evalJS(cdp, sessionId, "document.body.innerText");
    for (const label of [
      "服务健康检查",
      "模型连通性",
      "今日调用次数",
      "平均响应耗时",
      "工具调用次数",
      "Token 消耗量",
    ]) {
      check(`F3 概览含指标卡「${label}」`, bodyText.includes(label));
    }
    check("F4 概览含服务信息区", bodyText.includes("服务信息"));
    check("F5 概览含趋势区", bodyText.includes("近 7 天调用趋势"));
    check("F6 侧边栏含 Agent 控制面板入口", bodyText.includes("Agent 控制面板"));

    await shoot(cdp, sessionId, "01-overview.png");

    /* ---------- 3. 切换「Agent 配置」 ---------- */
    const clickByText = async (text, tag = "button") => {
      const expr = `(() => {
        const els = Array.from(document.querySelectorAll('${tag}'));
        const el = els.find(e => (e.innerText || '').trim() === ${JSON.stringify(text)});
        if (!el) return false;
        el.click(); return true;
      })()`;
      return evalJS(cdp, sessionId, expr);
    };

    check("F7 可点击「Agent 配置」", await clickByText("Agent 配置"));
    await waitFor(cdp, sessionId, "document.body.innerText.includes('系统提示词')", "配置页");
    await sleep(800);

    const cfgText = await evalJS(cdp, sessionId, "document.body.innerText");
    check("F8 配置页含三个子页签",
      ["系统提示词", "可用工具", "工具权限"].every((t) => cfgText.includes(t)));

    // 系统提示词编辑器
    const promptInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const ta = document.querySelector('[data-testid="prompt-editor"]');
        return ta ? { ok: true, len: ta.value.length } : { ok: false, len: 0 };
      })()`
    );
    check("F9 系统提示词编辑器存在且非空", promptInfo.ok && promptInfo.len > 100,
      JSON.stringify(promptInfo));
    check("F10 有保存按钮", await evalJS(cdp, sessionId,
      `!!document.querySelector('[data-testid="prompt-save"]')`));
    await shoot(cdp, sessionId, "02-system-prompt.png");

    /* ---------- 4. 可用工具 ---------- */
    check("F11 可点击「可用工具」", await clickByText("可用工具"));
    await sleep(900);
    const toolsInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const rows = document.querySelectorAll('[data-testid^="tool-row-"]');
        const switches = document.querySelectorAll('[data-testid="tool-switch"]');
        return { rows: rows.length, switches: switches.length,
                 text: document.body.innerText.length };
      })()`
    );
    check("F12 工具行渲染", toolsInfo.rows >= 20, JSON.stringify(toolsInfo));
    check("F13 开关数量与工具行一致", toolsInfo.switches === toolsInfo.rows,
      JSON.stringify(toolsInfo));
    const toolText = await evalJS(cdp, sessionId, "document.body.innerText");
    check("F14 工具分组展示（CRM 业务数据）", toolText.includes("CRM 业务数据"));
    check("F15 工具分组展示（文件系统与 Shell）", toolText.includes("文件系统与 Shell"));
    await shoot(cdp, sessionId, "03-tools.png");

    /* ---------- 5. 工具权限 ---------- */
    check("F16 可点击「工具权限」", await clickByText("工具权限"));
    await sleep(900);
    const polInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const rows = document.querySelectorAll('[data-testid^="policy-row-"]');
        const allow = document.querySelectorAll('[data-testid="policy-allow"]');
        const appr = document.querySelectorAll('[data-testid="policy-approval"]');
        const deny = document.querySelectorAll('[data-testid="policy-deny"]');
        return { rows: rows.length, allow: allow.length, appr: appr.length, deny: deny.length };
      })()`
    );
    check("F17 权限行渲染", polInfo.rows >= 20, JSON.stringify(polInfo));
    check("F18 每行三档权限按钮齐全",
      polInfo.allow === polInfo.rows && polInfo.appr === polInfo.rows && polInfo.deny === polInfo.rows,
      JSON.stringify(polInfo));
    const polText = await evalJS(cdp, sessionId, "document.body.innerText");
    check("F19 权限页含档位图例", ["直接使用", "人工审批", "禁止"].every((t) => polText.includes(t)));
    await shoot(cdp, sessionId, "04-tool-policy.png");

    /* ---------- 6. 交互：切换一个工具的权限档 ---------- */
    const before = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/config',{cache:'no-store'}).then(r=>r.json()).then(d=>d.tools.find(t=>t.name==='crm_query').policy)`);
    const toggled = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="policy-row-crm_query"]');
        if (!row) return false;
        const btn = row.querySelector('[data-testid="policy-approval"]');
        if (!btn) return false;
        btn.click(); return true;
      })()`
    );
    check("F20 可点击 crm_query 的「人工审批」", toggled);
    await sleep(1500);
    const after = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/config',{cache:'no-store'}).then(r=>r.json()).then(d=>d.tools.find(t=>t.name==='crm_query').policy)`);
    check("F21 权限变更已落库", before === "allow" && after === "approval",
      `before=${before} after=${after}`);

    // 复原
    await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/tools/crm_query/policy',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({policy:'allow'})}).then(r=>r.json()).then(()=>true)`);
    await sleep(600);

    /* ---------- 7. 交互：关闭一个工具的开关 ---------- */
    check("F22 可回到「可用工具」", await clickByText("可用工具"));
    await sleep(800);
    const swToggled = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="tool-row-web_search"]');
        if (!row) return false;
        const sw = row.querySelector('[data-testid="tool-switch"]');
        if (!sw) return false;
        sw.click(); return true;
      })()`
    );
    check("F23 可点击 web_search 开关", swToggled);
    await sleep(1500);
    const wsEnabled = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/config',{cache:'no-store'}).then(r=>r.json()).then(d=>d.tools.find(t=>t.name==='web_search').enabled)`);
    check("F24 开关变更已落库（web_search 关闭）", wsEnabled === false, `enabled=${wsEnabled}`);
    await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/tools/web_search',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})}).then(r=>r.json()).then(()=>true)`);
    await sleep(600);
    await shoot(cdp, sessionId, "05-tools-after-toggle.png");

    /* ---------- 8. 服务不可达时的容错（可选校验：无 JS 报错） ---------- */
    const errs = cdp.events.filter(
      (e) => e.method === "Runtime.exceptionThrown"
    );
    check("F25 页面无未捕获异常", errs.length === 0,
      JSON.stringify(errs.slice(0, 2)).slice(0, 300));
  } finally {
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
  }

  console.log("");
  console.log("=".repeat(60));
  console.log(`前端验证: ${PASS.n}/${PASS.n + FAIL.length} 通过`);
  if (FAIL.length) console.log("失败项:", FAIL.join(", "));
  console.log("=".repeat(60));
  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => {
  console.error("验证脚本异常:", e);
  process.exit(2);
});
