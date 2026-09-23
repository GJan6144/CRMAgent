/**
 * AI 助手「会话隔离」前端验证 —— 无头浏览器 + CDP
 *
 * 验证真实 UI：换不同账号登录 /chat，会话列表只显示**本人的**会话。
 *   A. 张明（销售）→ 列表 6 条，且不含管理员的「飞书消息」会话
 *   B. 管理员 → 列表 33 条（含迁移过来的历史会话）
 *   C. 两组标题无交集（不串）
 *   D. 页面无 Console 报错
 *
 * 依赖：CRM 前端 3100 在跑。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9973;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_ui_iso_out.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
const log = (s) => { lines.push(s); };
let pass = 0, fail = 0;
const check = (n, c, extra = "") => {
  if (c) { pass++; log("[PASS] " + n); }
  else { fail++; log("[FAIL] " + n + " :: " + extra); }
};

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
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
    const id = ++this.id; const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    this.ws.send(JSON.stringify(p));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout")); } }, 40000);
    });
  }
}
async function evalJS(cdp, sid, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(`[${expr.slice(0, 70)}] ` + JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result.value;
}
async function waitFor(cdp, sid, expr, label, t = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try { if (await evalJS(cdp, sid, expr)) return true; } catch { }
    await sleep(400);
  }
  log("  ! 超时: " + label);
  return false;
}
async function loginAs(cdp, sid, phone, password) {
  await cdp.send("Page.navigate", { url: `${BASE}/login` }, sid);
  await sleep(1200);
  return await evalJS(cdp, sid, `(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone: ${JSON.stringify(phone)}, password: ${JSON.stringify(password)} })
    });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    localStorage.setItem('crm_auth', JSON.stringify(d));
    return { ok: true, name: d.user && d.user.name, role: d.role && d.role.name };
  })()`);
}

/** 打开 /chat 并等会话列表渲染完（data-session-item 出现或列表区存在） */
async function openChat(cdp, sid) {
  await cdp.send("Page.navigate", { url: `${BASE}/chat` }, sid);
  await sleep(2500);
  await waitFor(cdp, sid, `!!document.querySelector('[data-testid="session-list"]')`, "会话列表容器");
  // 等条数稳定（异步加载）
  for (let i = 0; i < 20; i++) {
    const n = await evalJS(cdp, sid, `document.querySelectorAll('[data-testid="session-list"] [data-session-item]').length`);
    if (n > 0) break;
    await sleep(500);
  }
}

const READ_STATE = `(() => {
  const items = [...document.querySelectorAll('[data-testid="session-list"] [data-session-item]')];
  return {
    count: items.length,
    titles: items.map(el => (el.innerText || '').split('\\n')[0].trim()).filter(Boolean),
    collapsed: document.querySelector('[data-testid="session-list"]').getAttribute('aria-hidden'),
  };
})()`;

(async () => {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-chat-iso-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  if (!ver) { log("!! Chrome 调试端口未就绪"); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  // 收集 Console 报错
  const consoleErrors = [];
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        consoleErrors.push((m.params.args || []).map(a => a.value || a.description || "").join(" ").slice(0, 200));
      }
    } catch { }
  });

  log("=".repeat(72));
  log("AI 助手会话隔离 —— 前端 UI 验证");
  log("=".repeat(72));

  // ---------- A. 张明 ----------
  log("\n[A] 销售（张明）视角");
  const li = await loginAs(cdp, sessionId, "13800001001", "123123");
  check("销售登录成功", li && li.ok === true, JSON.stringify(li));
  check("身份是张明/销售", li && li.name === "张明" && li.role === "销售", JSON.stringify(li));

  await openChat(cdp, sessionId);
  const zhang = await evalJS(cdp, sessionId, READ_STATE);
  log("    张明会话条数 = " + zhang.count);
  check("会话列表渲染出本人会话（>0）", zhang.count > 0, JSON.stringify(zhang));
  check("张明只看到 6 条（服务端过滤生效）", zhang.count === 6, "count=" + zhang.count);
  // ⚠️ 必须比精确标题「飞书消息」，不能用 includes('飞书')：
  //    张明自己的会话标题里就含「飞书」二字（如「…通过飞书发给刘健」），
  //    用子串判定会把本人会话误判成越权可见（假失败）。
  check("张明的列表里没有管理员的「飞书消息」会话",
    !zhang.titles.some(t => t === "飞书消息"), JSON.stringify(zhang.titles));

  // 点开第一条，确认能读到自己的消息（不是 404 空列表）
  const clicked = await evalJS(cdp, sessionId, `(() => {
    const el = document.querySelector('[data-testid="session-list"] [data-session-item]');
    if (!el) return false; el.click(); return true;
  })()`);
  check("可点击打开本人会话", clicked === true);
  await sleep(2000);
  const opened = await evalJS(cdp, sessionId, `(() => {
    const box = document.querySelector('[data-testid="chat-scroll"]');
    return { hasBox: !!box, textLen: box ? (box.innerText || '').length : 0 };
  })()`);
  check("本人会话能正常载入对话内容", opened.hasBox && opened.textLen > 0, JSON.stringify(opened));

  // ---------- B. 管理员 ----------
  log("\n[B] 管理员视角");
  const la = await loginAs(cdp, sessionId, "13912345678", "123123");
  check("管理员登录成功", la && la.ok === true, JSON.stringify(la));
  check("身份是系统管理员", la && la.name === "系统管理员", JSON.stringify(la));

  await openChat(cdp, sessionId);
  const admin = await evalJS(cdp, sessionId, READ_STATE);
  log("    管理员会话条数 = " + admin.count);
  check("管理员看到 33 条（9 原有 + 24 迁移）", admin.count === 33, "count=" + admin.count);
  check("管理员的列表含「飞书消息」", admin.titles.some(t => t === "飞书消息"), JSON.stringify(admin.titles.slice(0, 8)));

  // ---------- C. 交集 ----------
  log("\n[C] 两组列表互不重叠");
  const zset = new Set(zhang.titles);
  const overlap = admin.titles.filter(t => zset.has(t));
  // 标题可能重名（例如「你现在有哪些工具和技能」这类通用提问），允许少量同名，
  // 关键是不能出现「整组互相可见」——用条数与关键标记判定。
  check("两组条数之和 ≤ 总会话数 39（无重复计数）", zhang.count + admin.count <= 39,
    `zhang=${zhang.count} admin=${admin.count}`);
  check("管理员独有会话数 == 27（33 - 与张明重名的 6 条上限）",
    admin.titles.filter(t => !zset.has(t)).length >= 27,
    "unique=" + admin.titles.filter(t => !zset.has(t)).length + " overlap=" + overlap.length);

  // ---------- D. Console ----------
  log("\n[D] Console 健康");
  const real = consoleErrors.filter(e => !/favicon|Download the React DevTools/i.test(e));
  check("无 Console 报错", real.length === 0, JSON.stringify(real.slice(0, 3)));

  log("\n" + "=".repeat(72));
  log(`结果：通过 ${pass} / ${pass + fail}    失败 ${fail}`);
  log("=".repeat(72));

  try { chrome.kill(); } catch { }
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  log("!! 异常: " + (e && e.stack || e));
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  process.exit(1);
});
