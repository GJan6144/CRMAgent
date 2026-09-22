/**
 * 「用户角色每月 token 额度」前端验证 —— 无头浏览器 + CDP
 *
 * 验证：
 *   A. 角色列表每行展示额度标签（role-quota-tag-*）
 *   B. 「修改权限」弹窗含额度设置区（输入框 / 预设档 / 不限额按钮）
 *   C. 额度输入校验：非法值给错误提示且保存禁用
 *   D. ★ 改额度 → 保存 → 重新打开弹窗回读一致（真实持久化，验证后还原）
 *   E. 用量统计 Tab 出现「本月额度」列（usage-quota-*）与用量/额度文本
 *   F. Tab 合计行额度列为「每人各自」说明
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9957;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_quota_screenshots");
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
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crm-quota-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1700,1300", "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(300); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  // ⚠️ 刻意用**偏矮**的视口（1366×768 常见笔记本）：权限弹窗内容较高，
  //    高视口下不会溢出，就测不出「顶部/按钮被挤出屏幕」这个回归。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }, sessionId);

  let pass = 0, fail = 0;
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; console.log("[FAIL]", n, "::", extra); } };
  const shot = async (name) => {
    try { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); } catch {}
  };

  // ---------- 登录 ----------
  await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "登录页", 30000);
  await sleep(1500);
  const loginRes = await evalJS(cdp, sessionId, `(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13912345678', password: '123123' }),
    });
    const d = await r.json();
    if (!r.ok) return { ok: false };
    localStorage.setItem('crm_auth', JSON.stringify(d));
    return { ok: true };
  })()`);
  check("登录成功", loginRes && loginRes.ok === true);

  // ---------- A. 角色列表额度标签 ----------
  console.log("\n=== A. 角色列表额度标签 ===");
  await cdp.send("Page.navigate", { url: `${BASE}/roles` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "角色页", 30000);
  await sleep(2200);

  const tags = await evalJS(cdp, sessionId, `(() => {
    const els = Array.from(document.querySelectorAll('[data-testid^="role-quota-tag-"]'));
    return els.map(e => ({ id: e.getAttribute('data-testid'), text: e.innerText.trim() }));
  })()`);
  console.log("  额度标签:", JSON.stringify(tags));
  check("角色行有额度标签", Array.isArray(tags) && tags.length >= 1, JSON.stringify(tags));
  check("额度标签含「额度:」字样", (tags || []).every(t => /额度[:：]/.test(t.text)) , JSON.stringify(tags));
  check("额度标签含「万」或「不限额」", (tags || []).every(t => /万|不限额/.test(t.text)), JSON.stringify(tags));
  await shot("roles-quota-tag.png");

  // 记录原始额度（用于还原）。⚠️ 用「销售」而不是「第一行」—— 行序会变。
  const origQuota = await evalJS(cdp, sessionId, `(async () => {
    const r = await fetch('/api/roles?page=1&pageSize=50');
    const d = await r.json();
    const sales = (d.data || []).find(x => x.name === '销售');
    return sales ? { id: sales.id, quota: sales.monthlyTokenQuota, name: sales.name } : null;
  })()`);
  console.log("  目标角色额度原值:", JSON.stringify(origQuota));
  check("读到目标角色（销售）额度原值", !!(origQuota && origQuota.id));

  // ---------- B. 修改权限弹窗额度设置区 ----------
  console.log("\n=== B. 弹窗额度设置区 ===");
  // ⚠️ 必须点「销售」那一行的按钮：列表顺序会变，不能盲目取 btns[0]
  const opened = await evalJS(cdp, sessionId, `(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const target = rows.find(r => /销售/.test(r.innerText));
    if (!target) return false;
    const b = target.querySelector('button[title="修改权限"]');
    if (!b) return false;
    b.click(); return true;
  })()`);
  check("打开「销售」的修改权限弹窗", opened === true);
  await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="role-quota-block"]')`, "额度设置区", 15000);
  await sleep(800);
  await shot("roles-quota-modal.png");

  // ---------- B2. 弹窗必须在视口内完整可见（回归：曾经顶部+按钮都被挤出屏幕） ----------
  console.log("\n=== B2. 弹窗适配视口 ===");
  const fit = await evalJS(cdp, sessionId, `(() => {
    const overlay = document.querySelector('div[style*="position: fixed"]');
    const dlg = overlay ? overlay.querySelector('div[style*="position: relative"]') : null;
    if (!dlg) return null;
    const r = dlg.getBoundingClientRect();
    const save = document.querySelector('[data-testid="role-perm-save"]');
    const sr = save ? save.getBoundingClientRect() : null;
    const h2 = dlg.querySelector('h2');
    const hr = h2 ? h2.getBoundingClientRect() : null;
    const body = document.querySelector('[data-testid="modal-body"]');
    return {
      vh: window.innerHeight,
      top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
      maxH: dlg.style.maxHeight || getComputedStyle(dlg).maxHeight,
      saveTop: sr ? Math.round(sr.top) : null, saveBottom: sr ? Math.round(sr.bottom) : null,
      saveVisible: sr ? sr.top >= 0 && sr.bottom <= window.innerHeight : null,
      titleVisible: hr ? hr.top >= 0 && hr.bottom <= window.innerHeight : null,
      bodyScrollable: body ? body.scrollHeight > body.clientHeight : null,
    };
  })()`);
  console.log("  弹窗适配:", JSON.stringify(fit));
  check("弹窗高度受限（≤ 视口）", !!fit && fit.h <= fit.vh, JSON.stringify(fit));
  check("★ 弹窗顶部未被裁掉（标题可见）", !!fit && fit.titleVisible === true, JSON.stringify(fit));
  check("★ 保存按钮在视口内可见", !!fit && fit.saveVisible === true, JSON.stringify(fit));
  check("内容区具备滚动能力或本就不溢出", !!fit && (fit.bodyScrollable === true || fit.h < fit.vh), JSON.stringify(fit));

  const blockInfo = await evalJS(cdp, sessionId, `(() => {
    const blk = document.querySelector('[data-testid="role-quota-block"]');
    const inp = document.querySelector('[data-testid="role-quota-input"]');
    const presets = Array.from(document.querySelectorAll('[data-testid^="role-quota-preset-"]')).map(e => e.getAttribute('data-testid'));
    const unlimited = document.querySelector('[data-testid="role-quota-unlimited-btn"]');
    return {
      hasBlock: !!blk, blockText: blk ? blk.innerText.slice(0, 120) : null,
      inputVal: inp ? inp.value : null,
      presets, hasUnlimited: !!unlimited,
    };
  })()`);
  console.log("  弹窗额度区:", JSON.stringify(blockInfo));
  check("弹窗含额度设置块", blockInfo.hasBlock === true);
  check("含额度输入框", blockInfo.inputVal !== null, String(blockInfo.inputVal));
  check("输入框默认 1000000", String(blockInfo.inputVal) === "1000000", String(blockInfo.inputVal));
  check("含 ≥4 个预设档", (blockInfo.presets || []).length >= 4, JSON.stringify(blockInfo.presets));
  check("含「不限额」按钮", blockInfo.hasUnlimited === true);
  check("块内含说明文案", /每个用户/.test(blockInfo.blockText || ""), String(blockInfo.blockText));

  // ---------- C. 额度校验 ----------
  console.log("\n=== C. 额度输入校验 ===");
  const setInput = async (val) => evalJS(cdp, sessionId, `(() => {
    const inp = document.querySelector('[data-testid="role-quota-input"]');
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(val)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  await setInput("-100");
  await sleep(600);
  const negState = await evalJS(cdp, sessionId, `(() => {
    const err = document.querySelector('[data-testid="role-quota-error"]');
    const save = document.querySelector('[data-testid="role-perm-save"]');
    return { hasErr: !!err, disabled: save ? save.disabled : null };
  })()`);
  check("负数 → 显示错误提示", negState.hasErr === true);
  check("负数 → 保存按钮禁用", negState.disabled === true, String(negState.disabled));

  await setInput("1000000");
  await sleep(500);
  const okState = await evalJS(cdp, sessionId, `(() => {
    const err = document.querySelector('[data-testid="role-quota-error"]');
    const save = document.querySelector('[data-testid="role-perm-save"]');
    return { hasErr: !!err, disabled: save ? save.disabled : null };
  })()`);
  check("合法值 → 无错误提示", okState.hasErr === false);
  check("合法值 → 保存可用", okState.disabled === false, String(okState.disabled));

  // ---------- D. 改额度 → 保存 → 回读 ----------
  console.log("\n=== D. 改额度保存并回读 ===");
  const NEW_Q = 2000000;
  await setInput(String(NEW_Q));
  await sleep(500);
  const saved = await evalJS(cdp, sessionId, `(() => {
    const b = document.querySelector('[data-testid="role-perm-save"]');
    if (!b) return false; b.click(); return true;
  })()`);
  check("点击保存权限", saved === true);
  await sleep(2500);

  const readBack = await evalJS(cdp, sessionId, `(async () => {
    const r = await fetch('/api/roles/${origQuota && origQuota.id}?t=' + Date.now());
    const d = await r.json();
    return d.monthlyTokenQuota;
  })()`);
  console.log("  回读额度:", readBack, " 期望:", NEW_Q);
  check("★ 保存后额度持久化（回读一致）", Number(readBack) === NEW_Q, `${readBack} vs ${NEW_Q}`);

  // 列表标签也应更新
  await cdp.send("Page.navigate", { url: `${BASE}/roles` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "角色页重载", 30000);
  await sleep(2200);
  const tagAfter = await evalJS(cdp, sessionId,
    `(() => { const e = document.querySelector('[data-testid="role-quota-tag-${origQuota && origQuota.id}"]'); return e ? e.innerText.trim() : null; })()`);
  console.log("  列表标签:", tagAfter);
  check("列表标签反映新额度（200 万）", /200\s*万/.test(tagAfter || ""), String(tagAfter));

  // ---------- E. 用量 Tab 额度列 ----------
  console.log("\n=== E. 用量统计 Tab 额度列 ===");
  await cdp.send("Page.navigate", { url: `${BASE}/agent` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "面板页", 30000);
  await sleep(2200);
  await evalJS(cdp, sessionId, `(() => { const b = document.querySelector('[data-testid="tab-usage"]'); if (b) b.click(); return true; })()`);
  await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="usage-quota-0"]')`, "额度列", 25000);
  await sleep(1200);
  await shot("usage-quota-column.png");

  const quotaCells = await evalJS(cdp, sessionId, `(() => {
    const cells = Array.from(document.querySelectorAll('[data-testid^="usage-quota-"]'));
    return cells.map(c => c.innerText.trim());
  })()`);
  console.log("  额度单元格:", JSON.stringify(quotaCells));
  check("用量表有额度列", (quotaCells || []).length >= 1, JSON.stringify(quotaCells));

  const headerHasQuota = await evalJS(cdp, sessionId,
    `(() => { const ths = Array.from(document.querySelectorAll('th')).map(t => t.innerText.trim()); return ths.includes('本月额度'); })()`);
  check("表头含「本月额度」", headerHasQuota === true);
  check("额度列含「/」用量格式或说明", (quotaCells || []).some(t => t.indexOf("/") >= 0 || /不限额|—/.test(t)), JSON.stringify(quotaCells));

  const footerQuota = await evalJS(cdp, sessionId,
    `(() => { const e = document.querySelector('[data-testid="usage-footer-quota"]'); return e ? e.innerText.trim() : null; })()`);
  console.log("  合计行额度列:", JSON.stringify(footerQuota));
  check("合计行额度列标「每人各自」", footerQuota === "每人各自", String(footerQuota));

  // 已归属用户应有「用量 / 额度」文本
  const knownCell = await evalJS(cdp, sessionId, `(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="usage-row-"]'));
    for (const r of rows) {
      const nm = (r.cells[0] || {}).innerText || '';
      if (!/未知用户/.test(nm)) {
        const q = r.querySelector('[data-testid^="usage-quota-"]');
        return { name: nm.trim(), quotaText: q ? q.innerText.trim() : null };
      }
    }
    return null;
  })()`);
  console.log("  已归属用户额度单元格:", JSON.stringify(knownCell));
  check("已归属用户额度列显示「已用 / 额度」",
        !knownCell || /\d/.test(knownCell.quotaText || ""), JSON.stringify(knownCell));
  // ★ 销售额度改成 200 万后，用量表里销售那一行应显示 200万（端到端串联）
  const salesCell = await evalJS(cdp, sessionId, `(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="usage-row-"]'));
    const r = rows.find(x => /销售/.test((x.cells[1] || {}).innerText || ''));
    if (!r) return null;
    const q = r.querySelector('[data-testid^="usage-quota-"]');
    return q ? q.innerText.trim() : null;
  })()`);
  console.log("  销售行额度单元格:", JSON.stringify(salesCell));
  check("★ 用量表销售额度反映 200 万（角色配置→用量口径串联）",
        /200万/.test(salesCell || ""), String(salesCell));

  // ---------- 还原额度 ----------
  console.log("\n=== 还原额度 ===");
  const restored = await evalJS(cdp, sessionId, `(async () => {
    const r = await fetch('/api/roles/${origQuota && origQuota.id}', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyTokenQuota: ${(origQuota && origQuota.quota) ?? 1000000} }),
    });
    const d = await r.json();
    return d.monthlyTokenQuota;
  })()`);
  console.log("  还原后:", restored);
  check("额度已还原为原值", Number(restored) === Number((origQuota && origQuota.quota) ?? 1000000),
        `${restored} vs ${origQuota && origQuota.quota}`);

  // 非法额度 PUT 应被拒
  const badPut = await evalJS(cdp, sessionId, `(async () => {
    const r = await fetch('/api/roles/${origQuota && origQuota.id}', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyTokenQuota: -1 }),
    });
    return r.status;
  })()`);
  check("非法额度 PUT → 400", badPut === 400, String(badPut));

  console.log(`\n${"=".repeat(60)}\n结果：PASS=${pass}  FAIL=${fail}\n${"=".repeat(60)}`);
  console.log("截图目录:", OUT);

  try { chrome.kill(); } catch {}
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error("脚本异常:", e); process.exit(1); });
