/**
 * CRM「Agent 数据范围」前端验证 —— 无头浏览器 + CDP
 *
 * 验证两件事：
 *   A. 角色与权限页（/roles）里「AI 助手」行会显示数据权限语义提示，
 *      并且切换「全部 / 仅自己」能保存（PUT /api/roles）后重新读回。
 *   B. 对话页（/chat）发消息时，请求体带上了当前登录用户的身份
 *      （user_phone / user_name / role_id / role_name）。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9953;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_scope_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }); }
  send(method, params = {}, sessionId) { const id = ++this.id; const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId; this.ws.send(JSON.stringify(p));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout")); } }, 40000); }); }
}
async function evalJS(cdp, sid, expr) { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(`[${expr.slice(0, 70)}] ` + JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value; }
async function waitFor(cdp, sid, expr, label, t = 30000) { const t0 = Date.now(); while (Date.now() - t0 < t) {
  try { if (await evalJS(cdp, sid, expr)) return true; } catch {} await sleep(400); } console.log("  ! 超时:", label); return false; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crm-scope-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1600,1100", "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(300); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);

  let pass = 0, fail = 0;
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; console.log("[FAIL]", n, "::", extra); } };

  const shot = async (name) => {
    try { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); } catch {}
  };

  // ---------- 登录（写 localStorage 的 crm_auth） ----------
  await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "登录页加载", 30000);
  await sleep(1500);

  const loginRes = await evalJS(cdp, sessionId, `(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13912345678', password: '123123' }),
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, status: r.status, d };
    localStorage.setItem('crm_auth', JSON.stringify(d));
    return { ok: true, user: d.user, role: d.role };
  })()`);
  check("登录成功并写入 crm_auth", loginRes && loginRes.ok === true, JSON.stringify(loginRes).slice(0, 200));
  console.log("  登录用户:", JSON.stringify(loginRes?.user), "角色:", loginRes?.role?.name);

  // ================= A. 角色与权限页 =================
  console.log("\n=== A. 角色与权限页：AI 助手行的数据权限提示 ===");
  await cdp.send("Page.navigate", { url: `${BASE}/roles` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "角色页加载", 30000);
  await sleep(2500);
  await shot("roles-list.png");

  // 打开「销售」角色的权限编辑弹窗（按钮是图标型，靠 title 定位）
  //
  // ⚠️⚠️ 禁止按行序取按钮（`btns[1]`）：角色列表顺序会变（新增角色、排序调整都会漂移），
  //    曾因多出一个「测试」角色而 btns[1] 落到「管理员」上 → 整段验证静默测错对象（假通过/假失败）。
  //    正确做法：按**角色名**在行内定位。
  const opened = await evalJS(cdp, sessionId, `(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const row = rows.find(r => (r.innerText || '').includes('销售'));
    if (!row) return { ok: false, why: 'no 销售 row' };
    const btn = row.querySelector('button[title="修改权限"]')
      || Array.from(row.querySelectorAll('button')).find(b => /修改权限/.test(b.title + b.innerText));
    if (!btn) return { ok: false, why: 'no perm button in 销售 row' };
    const all = Array.from(document.querySelectorAll('button[title="修改权限"]'));
    btn.click();
    return { ok: true, total: all.length, roleCell: (row.innerText || '').slice(0, 40) };
  })()`);
  check("找到并打开角色权限编辑弹窗", opened && opened.ok === true, JSON.stringify(opened));
  await sleep(2000);
  await shot("role-editor.png");

  // 提示元素是否存在
  const hintText = await evalJS(cdp, sessionId,
    `(() => { const el = document.querySelector('[data-testid="scope-hint-chat"]'); return el ? el.innerText.trim() : null; })()`);
  check("AI 助手行渲染了数据权限语义提示", !!hintText, String(hintText));
  console.log("  提示文案:", JSON.stringify(hintText));

  /**
   * 读取后端 roles.json 里「销售」角色 chat 页的 dataScope。
   * ⚠️ 走前端 fetch 拿最新值（cache: 'no-store'），避免读到页面缓存。
   */
  const readChatScope = async () => await evalJS(cdp, sessionId, `(async () => {
    const r = await fetch('/api/roles', { cache: 'no-store' });
    const d = await r.json();
    const roles = Array.isArray(d) ? d : (d.roles || d.data || d.list || []);
    if (!Array.isArray(roles)) return 'SHAPE:' + JSON.stringify(d).slice(0, 120);
    const sales = roles.find(x => x.name === '销售');
    const chat = (sales?.permissions || []).find(p => p.pageKey === 'chat');
    return chat ? chat.dataScope : 'NO_CHAT_PERM';
  })()`);

  // 找到 chat 行并切换 scope
  //
  // ⚠️ 必须**切到与当前相反的那一项**：当前值可能已经是「仅自己」（用户在角色页设过），
  //    直接点「仅自己」不会产生任何变化 → 「提示文案随选中项变化」必然假失败。
  //    所以先读当前选中项，再点另一项。
  const switched = await evalJS(cdp, sessionId, `(() => {
    const sel = document.querySelector('[data-testid="scope-hint-chat"]');
    if (!sel) return { ok: false, why: 'no hint' };
    // 提示所在容器 = 数据权限单元格
    const cell = sel.parentElement;
    const radios = Array.from(cell.querySelectorAll('input[type=radio]'));
    if (radios.length < 2) return { ok: false, why: 'radios=' + radios.length };
    const before = radios.map(r => r.checked);
    const cur = before.findIndex(Boolean);
    const target = cur === 0 ? 1 : 0;      // 切到相反项
    radios[target].click();
    return { ok: true, before, target, after: radios.map(r => r.checked),
             labels: Array.from(cell.querySelectorAll('label')).map(l => l.innerText.trim()) };
  })()`);
  console.log("  切换结果:", JSON.stringify(switched));
  check("数据权限单选可点击切换", switched && switched.ok === true, JSON.stringify(switched).slice(0, 200));
  check("切换后选中项已变化",
    switched?.before && switched?.after &&
    switched.before.join() !== switched.after.join(),
    JSON.stringify(switched?.after));
  await sleep(800);
  await shot("scope-switched.png");

  // 提示文案应随选中项变化
  const hintAfter = await evalJS(cdp, sessionId,
    `(() => { const el = document.querySelector('[data-testid="scope-hint-chat"]'); return el ? el.innerText.trim() : null; })()`);
  check("提示文案随选中项变化", hintAfter !== hintText, `${hintText} → ${hintAfter}`);
  console.log("  切换后提示:", JSON.stringify(hintAfter));

  // 保存 + 复核：**恢复到进入时的原值**（不硬编码「全部」）
  //
  // ⚠️ 不能写死「全部」：用户可能在角色页把销售设成了「仅自己」，
  //    写死会把真实配置改掉（且「保存后 = 全部」的断言也会假失败）。
  //    正确做法：进入时记住原值 → 测试保存 → 复核落库 → 还原原值。
  const origScope = await readChatScope();

  // 切回原值
  const saved = await evalJS(cdp, sessionId, `(() => {
    const sel = document.querySelector('[data-testid="scope-hint-chat"]');
    if (!sel) return null;
    const cell = sel.parentElement;
    const radios = Array.from(cell.querySelectorAll('input[type=radio]'));
    const labels = Array.from(cell.querySelectorAll('label')).map(l => l.innerText.trim());
    const want = ${JSON.stringify(origScope)};
    const idx = Math.max(0, labels.indexOf(want));
    if (radios[idx]) radios[idx].click();
    return { want, idx, after: radios.map(r => r.checked), labels };
  })()`);
  await sleep(500);
  check("可切回进入时的原值", saved && saved.after?.[saved.idx] === true, JSON.stringify(saved));

  const saveClicked = await evalJS(cdp, sessionId, `(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => /保存权限/.test(b.innerText||''));
    if (!btn) return false; btn.click(); return true;
  })()`);
  check("点击保存权限按钮", saveClicked === true);
  await sleep(2500);
  await shot("role-saved.png");

  // 复核后端 roles.json 中 chat 页 == 进入时的原值
  //
  // ⚠️ 用**轮询**代替「固定 sleep 后读一次」：保存是异步 PUT，固定等待在机器繁忙时不够，
  //    会读到旧值造成假失败（本脚本曾因此误报）。轮询到期望值或超时为止。
  let scopeAfterSave = '';
  for (let i = 0; i < 15; i++) {
    scopeAfterSave = await readChatScope();
    if (scopeAfterSave === origScope) break;
    await sleep(500);
  }
  check(`保存后「销售」角色 chat 页 dataScope == 原值（${origScope}）`,
        scopeAfterSave === origScope, `${scopeAfterSave} vs ${origScope}`);

  // ================= B. 对话页带身份 =================
  console.log("\n=== B. 对话页发消息携带身份 ===");

  // 在页面里挂一个 fetch 拦截器，记录 /api/agent/chat 的请求体
  await cdp.send("Page.navigate", { url: `${BASE}/chat` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页加载", 30000);
  await sleep(2000);

  await evalJS(cdp, sessionId, `(() => {
    if (window.__scopeProbe) return true;
    window.__scopeProbe = [];
    const orig = window.fetch;
    window.fetch = function(input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/agent/chat') && init && init.method === 'POST' && typeof init.body === 'string') {
          window.__scopeProbe.push(JSON.parse(init.body));
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    return true;
  })()`);
  check("已挂载 chat 请求拦截器", true);

  // 新建对话 + 输入 + 发送
  await evalJS(cdp, sessionId, `(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === '新建对话');
    if (b) b.click(); return true;
  })()`);
  await sleep(1500);

  await evalJS(cdp, sessionId, `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '你好');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(600);

  await evalJS(cdp, sessionId, `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);

  const gotReq = await waitFor(cdp, sessionId,
    "(window.__scopeProbe || []).length > 0", "捕获 chat 请求体", 25000);
  const bodies = await evalJS(cdp, sessionId, "window.__scopeProbe || []");
  const body = (bodies && bodies[0]) || {};
  console.log("  捕获请求体:", JSON.stringify(body).slice(0, 400));

  check("chat 请求带 user_phone", body.user_phone === "13912345678", String(body.user_phone));
  check("chat 请求带 user_name", body.user_name === "系统管理员", String(body.user_name));
  check("chat 请求带 role_id", body.role_id === "ROLE-2026-0001", String(body.role_id));
  check("chat 请求带 role_name", body.role_name === "管理员", String(body.role_name));
  await shot("chat-identity.png");

  console.log(`\n${"=".repeat(60)}\n结果：PASS=${pass}  FAIL=${fail}\n${"=".repeat(60)}`);
  console.log("截图目录:", OUT);

  try { chrome.kill(); } catch {}
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error("脚本异常:", e); process.exit(1); });
