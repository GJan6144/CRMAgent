/**
 * 上下文使用量 —— 端到端验证 + 截图
 *
 * 覆盖：
 *   A. 后端接口：GET /api/sessions/{id}/context 契约、模型上下文长度、无效会话兜底
 *   B. SSE：done 事件带 context 字段，且 used_tokens 为真实用量
 *   C. 前端：对话页底部环形图标渲染、百分比文案、点击弹窗、进度条、已用/最大上下文
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）。
 * 数据安全：只新建临时会话并落库 metric；跑完删除该会话的 messages / metrics / session。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9957;
const CRM_BASE = "http://127.0.0.1:3100";
const AGENT_BASE = "http://127.0.0.1:8765";
const OUT = path.join(__dirname, "_context_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_TITLE = "ctx-e2e-tmp";

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
      }, 150000);
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

async function createSession(title) {
  const r = await fetch(`${AGENT_BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return r.json();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-ctx-"));
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

  let tempSessionId = null;

  try {
    /* ---------- A. 后端接口契约 ---------- */
    const sess = await createSession(TMP_TITLE);
    tempSessionId = sess.id;
    check("A1 创建临时会话成功", typeof sess.id === "string" && sess.id.length > 10, JSON.stringify(sess).slice(0, 120));

    const r0 = await (await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}/context`)).json();
    check("A2 context 端点返回 session_id", r0.session_id === tempSessionId, JSON.stringify(r0));
    check("A3 新会话已用为 0", r0.used_tokens === 0, String(r0.used_tokens));
    check("A4 返回模型最大上下文 1048576", r0.max_tokens === 1048576, String(r0.max_tokens));
    check("A5 ratio/percent 一致", Math.abs(r0.ratio * 100 - r0.percent) < 0.02, JSON.stringify(r0));
    check("A6 默认模型为已启用模型", typeof r0.model === "string" && r0.model.length > 0, r0.model);

    // model 参数
    const rPro = await (
      await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}/context?model=deepseek-v4-pro`)
    ).json();
    check("A7 可指定 model 计算占比", rPro.model === "deepseek-v4-pro", rPro.model);
    check("A8 指定模型后仍返回同样的上限", rPro.max_tokens === 1048576, String(rPro.max_tokens));

    // 无效 model 回落
    const rBad = await (
      await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}/context?model=no-such-model`)
    ).json();
    check("A9 无效模型回落到已启用模型", rBad.model !== "no-such-model" && rBad.max_tokens > 0, JSON.stringify(rBad));

    // 不存在的会话 → 兜底不报错
    const rNone = await (await fetch(`${AGENT_BASE}/api/sessions/no-such-session-xyz/context`)).json();
    check("A10 不存在的会话不报错且 used=0", rNone.used_tokens === 0 && rNone.max_tokens > 0, JSON.stringify(rNone));

    /* ---------- B. SSE done 事件带 context ---------- */
    const chatResp = await fetch(`${AGENT_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tempSessionId,
        content: "请只回复两个字：收到",
        use_search: false,
      }),
    });
    const raw = await chatResp.text();
    const doneLine = raw
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.event === "done");

    check("B1 收到 done 事件", doneLine.length > 0, String(doneLine.length));
    const doneEvt = doneLine[doneLine.length - 1] || {};
    check("B2 done 事件带 context 字段", !!doneEvt.context, JSON.stringify(doneEvt).slice(0, 200));
    const ctx = doneEvt.context || {};
    check("B3 context.used_tokens 为真实用量（>0）", Number(ctx.used_tokens) > 0, String(ctx.used_tokens));
    check("B4 context.max_tokens 正确", Number(ctx.max_tokens) === 1048576, String(ctx.max_tokens));
    check(
      "B5 percent 在 0~100 之间",
      Number(ctx.percent) > 0 && Number(ctx.percent) <= 100,
      String(ctx.percent),
    );
    check("B6 未走估算路径（供应商回传真实用量）", ctx.estimated === false, String(ctx.estimated));

    /* ---------- C. 前端环形图标 + 弹窗 ---------- */
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
    check("C1 注入管理员登录态", typeof store === "string" && store.length > 20, String(store).slice(0, 80));

    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页加载");
    await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"chat-input\"]')", "输入框渲染");
    await sleep(2500);

    // 存在历史会话则先点开含内容的那个；本用例直接新建空会话并问一轮
    const ringBefore = await evalJS(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-context-ring"]')`,
    );
    console.log("  · 空会话下是否已有环形图标:", ringBefore);

    // 发一条消息，触发 done → 图标出现
    await evalJS(cdp, sessionId, setInput('[data-testid="chat-input"]', "请只回复两个字：收到"));
    await sleep(800);
    await evalJS(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="chat-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`,
    );
    await sleep(2500);

    const appeared = await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-context-ring"]')`,
      "上下文环形图标出现",
      120000,
    );
    check("C2 对话后底部出现上下文环形图标", appeared);
    await sleep(1200);
    await shot(cdp, sessionId, "01-context-ring.png");

    // 环形图标内含 SVG 圆环
    const ringInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const b = document.querySelector('[data-testid="chat-context-ring"]');
        if (!b) return null;
        const circles = b.querySelectorAll('svg circle');
        const arc = circles[1];
        return {
          text: (b.innerText || '').trim(),
          circles: circles.length,
          dash: arc ? arc.getAttribute('stroke-dasharray') : '',
          stroke: arc ? arc.getAttribute('stroke') : ''
        };
      })()`,
    );
    check("C3 图标内含环形 SVG（两层圆）", ringInfo && ringInfo.circles === 2, JSON.stringify(ringInfo));
    check("C4 环形有进度弧（strokeDasharray 非空）", ringInfo && /\d/.test(ringInfo.dash || ""), JSON.stringify(ringInfo));
    check("C5 图标旁展示百分比文案", ringInfo && /%/.test(ringInfo.text || ""), JSON.stringify(ringInfo));

    // 点击 → 弹窗
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="chat-context-ring"]').click(); true`);
    await waitFor(cdp, sessionId, "document.body.innerText.includes('上下文使用量')", "上下文弹窗");
    await sleep(800);
    await shot(cdp, sessionId, "02-context-modal.png");

    const modal = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const used = document.querySelector('[data-testid="context-used"]');
        const max = document.querySelector('[data-testid="context-max"]');
        const pct = document.querySelector('[data-testid="context-percent"]');
        const bar = document.querySelector('[data-testid="context-bar"]');
        const inner = bar ? bar.firstElementChild : null;
        return {
          used: used ? used.innerText : '',
          max: max ? max.innerText : '',
          pct: pct ? pct.innerText : '',
          hasBar: !!bar,
          barWidth: inner ? inner.style.width : '',
          text: document.body.innerText
        };
      })()`,
    );
    check("C6 弹窗展示「已用上下文」", /[0-9]/.test(modal.used || ""), JSON.stringify(modal).slice(0, 200));
    check("C7 弹窗展示「模型最大上下文」", /[0-9]/.test(modal.max || ""), JSON.stringify(modal).slice(0, 200));
    check("C8 弹窗有进度条", modal.hasBar, JSON.stringify(modal).slice(0, 200));
    check("C9 进度条宽度与占比一致（非空）", /%/.test(modal.barWidth || ""), modal.barWidth);
    check("C10 弹窗显示百分比", /%/.test(modal.pct || ""), modal.pct);
    check("C11 弹窗含「已用上下文」标签", modal.text.includes("已用上下文"));
    check("C12 弹窗含「模型最大上下文」标签", modal.text.includes("模型最大上下文"));
    check("C13 弹窗含当前模型名", modal.text.includes("当前模型"));

    // 数值一致性：弹窗 percent 与 done 事件 percent 同源（都来自服务端 ratio）
    const pctNum = parseFloat((modal.pct || "").replace(/[^0-9.]/g, ""));
    check(
      "C14 弹窗百分比与服务端计算同量级",
      Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100,
      `${modal.pct} vs server ${ctx.percent}`,
    );

    // 关闭弹窗
    await evalJS(
      cdp,
      sessionId,
      `(() => { const b = Array.from(document.querySelectorAll('button')).reverse().find(x => ['关闭','取消','确定'].includes((x.innerText||'').trim())); if (b) b.click(); return !!b; })()`,
    );
    await sleep(600);

    // 刷新后仍能恢复图标（走 /context 端点）
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页二次加载");
    await sleep(3000);
    const restored = await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-context-ring"]')`,
      "刷新后恢复环形图标",
      30000,
    );
    check("C15 刷新页面后能恢复上下文图标", restored);
    await shot(cdp, sessionId, "03-context-restored.png");
  } finally {
    /* ---------- 清理：删除临时会话及其 metrics ---------- */
    console.log("\n--- 清理 ---");
    // 按 id 精确删除本轮创建的会话（标题会被首条消息自动改写，不能用标题匹配）
    try {
      if (tempSessionId) {
        await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}`, { method: "DELETE" });
        console.log("  -> 已删除临时会话", tempSessionId);
      }
      // 顺手清理历史残留（标题恰为 TMP_TITLE 的）
      const list = await (await fetch(`${AGENT_BASE}/api/sessions`)).json();
      const arr = Array.isArray(list) ? list : list.sessions || [];
      const stale = arr.filter((s) => (s.title || "") === TMP_TITLE);
      for (const s of stale) {
        await fetch(`${AGENT_BASE}/api/sessions/${s.id}`, { method: "DELETE" });
        console.log("  -> 已删除历史残留会话", s.id);
      }
    } catch (e) {
      console.log("  !! 清理临时会话失败：", e.message);
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
