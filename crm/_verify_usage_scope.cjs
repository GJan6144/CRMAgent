/**
 * 「用量统计」数据范围验证 —— 无头浏览器 + CDP
 *
 * 需求：Agent 控制面板里的用量统计，**普通用户只能看到自己的用量，管理员才能看到所有人的**。
 *
 * 验证：
 *   A. 管理员登录 → 「范围：全部用户」徽标 + 明细表 ≥2 行 + 合计自洽
 *   B. 销售（张明）登录 →「范围：仅本人」徽标 + 明细表**恰好 1 行且是本人** + 合计自洽
 *   C. ★ 张明看到的总量严格小于管理员看到的总量（不是同一份数据）
 *   D. ★ 明细表里不出现他人（李华 / 系统管理员 / 未知用户）
 *   E. ★ 裸调接口（不带身份）→ 空集（不会退化成「不过滤」把所有人吐出来）
 *   F. 接口带张明身份 → 只回张明一行
 *
 * ⚠️ 口径：所有断言都是「服务端返回什么」而不是「前端显示了什么」的交叉验证 ——
 *    前端只声明身份，范围判定全在服务端。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9958;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_usage_scope_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADMIN = { phone: "13912345678", name: "系统管理员" };
const SALES = { phone: "13800001001", name: "张明" };

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

/** 读取当前「用量统计」Tab 的关键信息（全部走 data-testid 锚点，不按行序取） */
const READ_USAGE = `(() => {
  const num = (t) => { const n = parseInt(String(t == null ? "" : t).replace(/[^0-9]/g, ""), 10); return isNaN(n) ? 0 : n; };
  const hint = document.querySelector('[data-testid="usage-scope-hint"]');
  const title = document.querySelector('[data-testid="usage-hint-title"]');
  const headText = (document.querySelector('[data-testid="usage-users-head"]') || {}).innerText || "";
  const rows = Array.from(document.querySelectorAll('[data-testid^="usage-row-"]')).map((tr) => {
    const c = tr.cells;
    return { name: (c[0] || {}).innerText || "", total: num((c[2] || {}).innerText) };
  });
  const ft = document.querySelector('[data-testid="usage-footer"]');
  let footerTotal = null;
  if (ft) { const off = ft.cells.length === 10 ? 2 : 1; footerTotal = num((ft.cells[off] || {}).innerText); }
  const card = document.querySelector('[data-testid="usage-total-总 token"]');
  const sc = document.querySelector('[data-testid="usage-selfcheck"]');
  return {
    scopeHint: hint ? hint.innerText.trim() : null,
    titleText: ((title || {}).innerText || headText || "").trim(),
    rows,
    rowCount: rows.length,
    footerTotal,
    cardTotal: card ? num(card.innerText) : null,
    selfcheckText: sc ? sc.innerText.trim() : null,
    selfcheckPass: sc ? /合计一致/.test(sc.innerText) : false,
    bodyText: document.body.innerText,
  };
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crm-usagescope-"));
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1700, height: 1300, deviceScaleFactor: 1, mobile: false }, sessionId);

  let pass = 0, fail = 0;
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; console.log("[FAIL]", n, "::", extra); } };
  const shot = async (name) => {
    try { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); } catch {}
  };

  /** 以指定账号登录（走真实登录接口 + localStorage 恢复），再打开用量 Tab */
  async function loginAndOpenUsage(who) {
    await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "登录页", 30000);
    await sleep(1200);
    const r = await evalJS(cdp, sessionId, `(async () => {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '${who.phone}', password: '123123' }),
      });
      const d = await res.json();
      if (!res.ok) return { ok: false, err: d.error || res.status };
      localStorage.setItem('crm_auth', JSON.stringify(d));
      return { ok: true, name: (d.user || {}).name, role: (d.role || {}).name };
    })()`);
    check(`登录 ${who.name}`, r && r.ok === true, JSON.stringify(r));

    await cdp.send("Page.navigate", { url: `${BASE}/agent` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "面板页", 30000);
    await sleep(2000);
    await evalJS(cdp, sessionId, `(() => { const b = document.querySelector('[data-testid="tab-usage"]'); if (b) b.click(); return true; })()`);
    await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"usage-totals\"]')", "总量卡", 25000);
    await sleep(1000);
    return evalJS(cdp, sessionId, READ_USAGE);
  }

  // ============ A / D. 管理员：看全部 ============
  console.log("\n=== A. 管理员视角（应看到所有用户）===");
  const admin = await loginAndOpenUsage(ADMIN);
  await shot("usage-scope-admin.png");
  console.log("  范围徽标:", JSON.stringify(admin.scopeHint));
  console.log("  表格标题:", JSON.stringify(admin.titleText));
  console.log("  明细行  :", JSON.stringify(admin.rows));
  console.log("  自检    :", JSON.stringify(admin.selfcheckText));

  check("管理员：范围徽标 = 「范围：全部用户」", admin.scopeHint === "范围：全部用户", admin.scopeHint);
  check("管理员：明细表 ≥ 2 行", admin.rowCount >= 2, admin.rowCount);
  check("管理员：合计自检为「一致」", admin.selfcheckPass === true, admin.selfcheckText);
  check("管理员：总量卡 === 合计行",
    admin.cardTotal !== null && admin.cardTotal === admin.footerTotal, `${admin.cardTotal} vs ${admin.footerTotal}`);
  check("管理员：各行求和 === 合计行",
    admin.rows.reduce((s, r) => s + r.total, 0) === admin.footerTotal,
    `${admin.rows.reduce((s, r) => s + r.total, 0)} vs ${admin.footerTotal}`);

  // ============ B / C / D. 销售：只看自己 ============
  console.log("\n=== B. 销售（张明）视角（应只看到本人）===");
  const sales = await loginAndOpenUsage(SALES);
  await shot("usage-scope-sales.png");
  console.log("  范围徽标:", JSON.stringify(sales.scopeHint));
  console.log("  表格标题:", JSON.stringify(sales.titleText));
  console.log("  明细行  :", JSON.stringify(sales.rows));
  console.log("  自检    :", JSON.stringify(sales.selfcheckText));

  check("销售：范围徽标 = 「范围：仅本人」", sales.scopeHint === "范围：仅本人", sales.scopeHint);
  check("销售：标题为「我的用量」", sales.titleText.indexOf("我的用量") >= 0, sales.titleText);
  check("★ 销售：明细表恰好 1 行", sales.rowCount === 1, sales.rowCount);
  check("★ 销售：那一行就是本人（张明）",
    sales.rowCount === 1 && sales.rows[0].name.indexOf(SALES.name) >= 0,
    JSON.stringify(sales.rows));
  check("★ 销售：明细里不出现他人（李华 / 系统管理员 / 未知用户）",
    sales.rows.every((r) => r.name.indexOf(SALES.name) >= 0), JSON.stringify(sales.rows));
  check("销售：页面正文不含「系统管理员」/「李华」",
    sales.bodyText.indexOf("李华") < 0 && sales.bodyText.indexOf("系统管理员") < 0);
  check("销售：合计自检为「一致」（总量=本人合计）", sales.selfcheckPass === true, sales.selfcheckText);
  check("销售：总量卡 === 合计行 === 该行 total",
    sales.cardTotal === sales.footerTotal && sales.footerTotal === sales.rows[0].total,
    `${sales.cardTotal} / ${sales.footerTotal} / ${sales.rows[0].total}`);
  check("★ 销售看到的总量严格小于管理员看到的总量",
    sales.cardTotal > 0 && sales.cardTotal < admin.cardTotal,
    `${sales.cardTotal} vs ${admin.cardTotal}`);
  check("销售：口径文案不再是「全表求和」",
    sales.bodyText.indexOf("全表求和") < 0, "仍出现「全表求和」");

  // ============ E / F. 接口层（不带 / 带身份） ============
  console.log("\n=== E. 接口层：裸调 vs 带身份 ===");
  const api = await evalJS(cdp, sessionId, `(async () => {
    const bare = await (await fetch('/api/agent/panel/token-usage?scope=all', { cache: 'no-store' })).json();
    const scoped = await (await fetch('/api/agent/panel/token-usage?scope=all' +
      '&user_phone=${SALES.phone}&user_name=' + encodeURIComponent('${SALES.name}') +
      '&role_id=ROLE-2026-0002&role_name=' + encodeURIComponent('销售'), { cache: 'no-store' })).json();
    const adminq = await (await fetch('/api/agent/panel/token-usage?scope=all' +
      '&user_phone=${ADMIN.phone}&user_name=' + encodeURIComponent('${ADMIN.name}') +
      '&role_id=ROLE-2026-0001&role_name=' + encodeURIComponent('管理员'), { cache: 'no-store' })).json();
    return {
      bare: { users: bare.users.length, total: bare.totals.total_tokens, restricted: bare.viewer.restricted, label: bare.viewer.label },
      scoped: { users: scoped.users.length, names: scoped.users.map(u => u.name), restricted: scoped.viewer.restricted, label: scoped.viewer.label },
      adminq: { users: adminq.users.length, restricted: adminq.viewer.restricted, label: adminq.viewer.label },
    };
  })()`);
  console.log("  裸调（无身份）:", JSON.stringify(api.bare));
  console.log("  带张明身份    :", JSON.stringify(api.scoped));
  console.log("  带管理员身份  :", JSON.stringify(api.adminq));

  check("★ 裸调接口（无身份）→ 空集，不泄露他人", api.bare.users === 0 && api.bare.total === 0, JSON.stringify(api.bare));
  check("裸调接口 → 也标记为受限（仅本人）", api.bare.restricted === true && api.bare.label === "仅本人", JSON.stringify(api.bare));
  check("带张明身份 → 只回本人一行", api.scoped.users === 1 && api.scoped.names[0].indexOf("张明") >= 0, JSON.stringify(api.scoped));
  check("带张明身份 → 受限", api.scoped.restricted === true, JSON.stringify(api.scoped));
  check("带管理员身份 → 看全部（不受限）", api.adminq.restricted === false && api.adminq.users >= 2, JSON.stringify(api.adminq));

  console.log("\n" + "=".repeat(62));
  console.log(`结果：PASS=${pass}  FAIL=${fail}`);
  console.log(`截图目录：${OUT}`);
  console.log("=".repeat(62));
  try { chrome.kill(); } catch {}
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch((e) => { console.error("脚本异常:", e); process.exit(1); });
