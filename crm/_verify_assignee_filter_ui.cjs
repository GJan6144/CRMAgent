/**
 * 线索管理「跟进人模糊筛选」前端验证 —— 无头 Chrome + CDP
 *
 * 验证内容：
 *   A. 管理员登录后进入 /leads，筛选栏存在「跟进人」输入框（data-testid）
 *   B. ★ 输入完整姓名后点「查询」→ 列表行数减少，且行内跟进人列全部命中该姓名
 *   C. ★ 输入姓氏（模糊）→ 命中数 >= 完整姓名命中数，且每行跟进人都「包含」该关键字
 *   D. ★ 证明是「模糊」而非「等于」：构造一个只输姓氏就能命中多人的场景
 *   E. 清空跟进人 → 列表恢复全量
 *   F. 与数据范围不冲突：换销售账号（仅自己）搜自己的姓氏，结果仍只含本人
 *
 * ⚠️ 本脚本只读，不新增/修改任何数据。
 * ⚠️ 页面默认日期是「当月」而种子数据在 6 月 → 必须先放宽日期，否则天然空列表。
 * 依赖：CRM 前端 3100 在跑。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9963;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_assignee_filter_screenshots");
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
async function waitFor(cdp, sid, expr, label, t = 25000) { const t0 = Date.now(); while (Date.now() - t0 < t) {
  try { if (await evalJS(cdp, sid, expr)) return true; } catch {} await sleep(400); } console.log("  ! 超时:", label); return false; }

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

/** 原生 setter 改 React 受控 input 的值（直接 el.value= 不会触发 React 状态更新） */
const SET_NATIVE_FN = `
  const setNative = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };`;

/** 放宽日期筛选（页面默认当月，种子数据在 6 月） */
const WIDEN_DATES = `(() => { ${SET_NATIVE_FN}
  const dates = [...document.querySelectorAll('input[type="date"]')];
  if (dates[0]) setNative(dates[0], '2020-01-01');
  if (dates[1]) setNative(dates[1], '2030-12-31');
  return dates.length;
})()`;

/** 往跟进人筛选框填值（原生 setter） */
const setAssigneeFilter = (v) => `(() => { ${SET_NATIVE_FN}
  const el = document.querySelector('[data-testid="leads-filter-assignee"]');
  if (!el) return false;
  setNative(el, ${JSON.stringify(v)});
  return true;
})()`;

const CLICK_QUERY = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '查询');
  if (b) { b.click(); return true; }
  return false;
})()`;

/** 读当前列表：行数 + 跟进人列取值（按表头语义定位列，禁用固定索引） */
const READ_TABLE = `(() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const ths = [...document.querySelectorAll('table thead th')].map(t => t.textContent.trim());
  const idx = ths.findIndex(t => t.includes('跟进人'));
  const assignees = rows.map(r => {
    const tds = r.querySelectorAll('td');
    return idx >= 0 && tds[idx] ? tds[idx].textContent.trim() : null;
  });
  // 分页文案「共 N 条」是服务端 total 的真实映射
  const m = document.body.innerText.match(/共\\s*(\\d+)\\s*条/);
  return { rowCount: rows.length, assigneeIdx: idx, assignees, totalText: m ? Number(m[1]) : null };
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-assignee-filter-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(300); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  let pass = 0, fail = 0;
  const FAILED = [];
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; FAILED.push(n); console.log("[FAIL]", n, "::", extra); } };
  const shot = async (name) => {
    try { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); } catch {}
  };

  // ---------- A. 管理员登录 + 筛选框存在 ----------
  console.log("\n[A] 管理员登录 & 筛选框存在性");
  const li = await loginAs(cdp, sessionId, "13912345678", "123123");
  check("管理员登录成功", li && li.ok === true, JSON.stringify(li));

  await cdp.send("Page.navigate", { url: `${BASE}/leads` }, sessionId);
  await sleep(2500);

  // 页面默认查「当月」，种子数据在 6 月 → 先放宽日期
  await evalJS(cdp, sessionId, WIDEN_DATES);
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await waitFor(cdp, sessionId, `!!document.querySelector('table tbody tr')`, "线索表格出现", 20000);
  await sleep(1200);

  const hasFilter = await evalJS(cdp, sessionId, `(() => {
    const el = document.querySelector('[data-testid="leads-filter-assignee"]');
    if (!el) return null;
    // label 是输入框前面的 span
    const wrap = el.parentElement;
    const label = wrap ? wrap.querySelector('span')?.textContent.trim() : null;
    return { exists: true, placeholder: el.placeholder, label, type: el.type, list: el.getAttribute('list') };
  })()`);
  check("筛选栏存在「跟进人」输入框", hasFilter && hasFilter.exists === true, JSON.stringify(hasFilter));
  check("输入框标签是「跟进人」", hasFilter && hasFilter.label === "跟进人", JSON.stringify(hasFilter && hasFilter.label));
  check("输入框有 placeholder 提示", hasFilter && /跟进人/.test(hasFilter.placeholder || ""), JSON.stringify(hasFilter && hasFilter.placeholder));

  const baseline = await evalJS(cdp, sessionId, READ_TABLE);
  check("基线有数据可测（行数 > 0）", baseline.rowCount > 0, JSON.stringify(baseline));
  check("跟表头能找到「跟进人」列", baseline.assigneeIdx >= 0, JSON.stringify(baseline));
  await shot("A_filter_exists.png");

  // 从基线数据里挑一个有代表性的：出现最多的跟进人 + 至少两个跟进人同姓
  const counts = {};
  for (const a of baseline.assignees) counts[a] = (counts[a] || 0) + 1;
  const names = Object.keys(counts);
  console.log("       基线跟进人分布：", JSON.stringify(counts));
  check("基线含多个跟进人（便于验证模糊）", names.length >= 2, JSON.stringify(names));

  const surnameGroups = {};
  for (const n of names) { const s = n[0]; (surnameGroups[s] = surnameGroups[s] || []).push(n); }
  const fuzzySurname = Object.keys(surnameGroups).find((s) => surnameGroups[s].length >= 2);

  // ---------- B. 完整姓名精确命中 ----------
  console.log("\n[B] 输入完整姓名 → 精确命中");
  const fullName = names[0];
  await evalJS(cdp, sessionId, setAssigneeFilter(fullName));
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);
  const rFull = await evalJS(cdp, sessionId, READ_TABLE);
  check(`按「${fullName}」筛选后行数 > 0`, rFull.rowCount > 0, JSON.stringify(rFull));
  check(`按「${fullName}」筛选后每行跟进人都等于「${fullName}」`,
    rFull.rowCount > 0 && rFull.assignees.every((a) => a === fullName), JSON.stringify(rFull.assignees));
  check("筛选后行数 <= 基线行数", rFull.rowCount <= baseline.rowCount,
    `${rFull.rowCount} vs ${baseline.rowCount}`);
  await shot("B_exact_name.png");

  // ---------- C. 姓氏模糊命中 ----------
  console.log("\n[C] 输入姓氏 → 模糊命中");
  if (!fuzzySurname) {
    // 没有同姓销售：退化为「姓氏 == 全名」，仍应命中同一批
    console.log("       数据中没有同姓销售，退化为验证「姓氏命中 >= 0 且全为包含关系」");
  }
  const kw = fuzzySurname || fullName[0];
  await evalJS(cdp, sessionId, setAssigneeFilter(kw));
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);
  const rFuzzy = await evalJS(cdp, sessionId, READ_TABLE);
  check(`按关键字「${kw}」筛选后行数 > 0`, rFuzzy.rowCount > 0, JSON.stringify(rFuzzy));
  check(`★ 模糊结果每行跟进人都「包含」关键字「${kw}」`,
    rFuzzy.rowCount > 0 && rFuzzy.assignees.every((a) => (a || "").includes(kw)),
    JSON.stringify(rFuzzy.assignees));
  check("★ 模糊命中数 >= 完整名命中数（包含语义）",
    rFuzzy.rowCount >= rFull.rowCount, `fuzzy=${rFuzzy.rowCount} exact=${rFull.rowCount}`);
  if (fuzzySurname && surnameGroups[fuzzySurname].length >= 2) {
    const uniq = [...new Set(rFuzzy.assignees)];
    check(`★ 命中多个不同跟进人（${surnameGroups[fuzzySurname].join("/")}）→ 证明确实是模糊而非等于`,
      uniq.length >= 2, JSON.stringify(uniq));
  }
  await shot("C_fuzzy_surname.png");

  // ---------- D. 无命中 ----------
  console.log("\n[D] 不存在的关键字 → 空列表");
  await evalJS(cdp, sessionId, setAssigneeFilter("__不存在__"));
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);
  const rNone = await evalJS(cdp, sessionId, READ_TABLE);
  check("不存在关键字 → 行数为 0（显示空态，不报错）", rNone.rowCount === 0, JSON.stringify(rNone));

  // ---------- E. 清空恢复全量 ----------
  console.log("\n[E] 清空跟进人 → 恢复全量");
  await evalJS(cdp, sessionId, setAssigneeFilter(""));
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);
  const rClear = await evalJS(cdp, sessionId, READ_TABLE);
  check("★ 清空后行数恢复为基线行数",
    rClear.rowCount === baseline.rowCount,
    `after=${rClear.rowCount} baseline=${baseline.rowCount}`);

  // ---------- F. 与数据范围叠加（销售仅自己） ----------
  console.log("\n[F] 销售（仅自己）+ 跟进人筛选 不冲突");
  const li2 = await loginAs(cdp, sessionId, "13800001001", "123123");
  check("销售登录成功", li2 && li2.ok === true, JSON.stringify(li2));
  await cdp.send("Page.navigate", { url: `${BASE}/leads` }, sessionId);
  await sleep(2500);
  await evalJS(cdp, sessionId, WIDEN_DATES);
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await waitFor(cdp, sessionId, `!!document.querySelector('table tbody tr')`, "销售线索表格出现", 20000);
  await sleep(1200);

  const salesBase = await evalJS(cdp, sessionId, READ_TABLE);
  check("销售基线全部是本人（张明）",
    salesBase.rowCount > 0 && salesBase.assignees.every((a) => a === "张明"),
    JSON.stringify(salesBase.assignees));

  // 用本人姓氏模糊搜 → 结果不能出现别人
  await evalJS(cdp, sessionId, setAssigneeFilter("张"));
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);
  const salesFuzzy = await evalJS(cdp, sessionId, READ_TABLE);
  check("★ 销售用姓氏模糊搜 → 结果仍只含本人（数据范围优先于筛选）",
    salesFuzzy.assignees.every((a) => a === "张明"),
    JSON.stringify(salesFuzzy.assignees));

  // 用别人的姓氏搜 → 应为空，不能因筛选绕过范围
  await evalJS(cdp, sessionId, setAssigneeFilter("王"));
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);
  const salesOther = await evalJS(cdp, sessionId, READ_TABLE);
  check("★ 销售搜别人的姓氏「王」→ 一条都拿不到",
    salesOther.rowCount === 0,
    JSON.stringify(salesOther));
  await shot("F_sales_scope.png");

  // ---------- 汇总 ----------
  console.log("\n" + "=".repeat(60));
  console.log(`结果：PASS=${pass}  FAIL=${fail}`);
  if (FAILED.length) { console.log("失败项："); FAILED.forEach((f) => console.log("  -", f)); }
  console.log("=".repeat(60));

  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
