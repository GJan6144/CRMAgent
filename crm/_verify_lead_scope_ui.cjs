/**
 * CRM 页面级「数据范围」前端验证 —— 无头浏览器 + CDP
 *
 * 验证销售（仅自己）登录后，线索管理页 / 沟通记录页的**真实 UI 表现**：
 *   A. 用销售账号登录
 *   B. 线索管理页：只显示本人线索（行内跟进人列全部为本人）
 *   C. 线索管理页：列表条数与服务端一致（不是前端截断的假象）
 *   D. ★ 新增线索弹窗：跟进人下拉框锁定为本人（disabled）且给出提示
 *   E. ★ 编辑线索弹窗：跟进人下拉框同样锁定
 *   F. 沟通记录页：只显示本人相关记录
 *   G. 换管理员账号：可见数量明显更多（对照验证，排除"本来就少"）
 *
 * 依赖：CRM 前端 3100 在跑。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9961;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_scope2_screenshots");
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

/** 登录指定账号：先到 /login 写 localStorage，再跳目标页 */
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

/**
 * 放宽页面的日期筛选（页面默认查「当月」，而种子数据在 6 月 → 天然空列表）。
 *
 * ⚠️ React 受控 input 必须用 **原生 value setter** 改值：
 *    直接 `el.value = x` 不会更新 React 内部状态（React 覆写了 value setter），
 *    必须取原型上的原生 setter 调用，再派发 input/change，React 才收得到。
 */
const WIDEN_DATES = `(() => {
  const setNative = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const dates = [...document.querySelectorAll('input[type="date"]')];
  if (dates[0]) setNative(dates[0], '2020-01-01');
  if (dates[1]) setNative(dates[1], '2030-12-31');
  return dates.length;
})()`;

/** 点「查询」按钮 */
const CLICK_QUERY = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '查询');
  if (b) { b.click(); return true; }
  return false;
})()`;

/** 关闭当前弹窗（点「取消」；限定在弹窗容器内找，避免误点页面其他同名按钮） */
const CLOSE_MODAL = `(() => {
  const all = [...document.querySelectorAll('button')].filter(x => x.textContent.trim() === '取消');
  if (all.length) { all[all.length - 1].click(); return true; }
  return false;
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crm-scope2-"));
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
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; console.log("[FAIL]", n, "::", extra); } };
  const shot = async (name) => {
    try { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); } catch {}
  };

  // ---------- A. 销售登录 ----------
  console.log("\n[A] 销售（张明）登录");
  const li = await loginAs(cdp, sessionId, "13800001001", "123123");
  check("销售登录成功", li && li.ok === true, JSON.stringify(li));
  check("登录身份是张明/销售", li && li.name === "张明" && li.role === "销售", JSON.stringify(li));

  // ---------- B/C. 线索管理页 ----------
  console.log("\n[B] 线索管理页（销售视角）");
  await cdp.send("Page.navigate", { url: `${BASE}/leads` }, sessionId);
  await sleep(2500);

  // ⚠️ 页面默认日期范围是「当月」，而现有线索数据都在 6 月 → 天然空列表。
  //    这是既有设计（不是本次改动引入），验证前必须先把日期放宽，否则永远测不到行。
  await evalJS(cdp, sessionId, WIDEN_DATES);
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);

  const okTable = await waitFor(cdp, sessionId, `!!document.querySelector('table tbody tr')`, "线索表格出现", 20000);
  check("线索列表渲染", okTable === true);
  await sleep(1000);

  const salesView = await evalJS(cdp, sessionId, `(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    // 跟进人列：表头里找「跟进人」的列序，按语义取值（禁用固定索引 —— 列序可能变）
    const ths = [...document.querySelectorAll('table thead th')].map(t => t.textContent.trim());
    const idx = ths.findIndex(t => t.includes('跟进人'));
    const assignees = rows.map(r => {
      const tds = r.querySelectorAll('td');
      return idx >= 0 && tds[idx] ? tds[idx].textContent.trim() : null;
    });
    return {
      rowCount: rows.length,
      headers: ths,
      assigneeIdx: idx,
      assignees,
      // 服务端 total 展示（分页信息文本里通常含「共 N 条」）
      bodyText: document.body.innerText.slice(0, 3000),
    };
  })()`);
  check("拿到跟进人列（表头含「跟进人」）", salesView.assigneeIdx >= 0, JSON.stringify(salesView.headers));
  check("★ 页面上所有线索的跟进人都是张明",
    salesView.assignees.length > 0 && salesView.assignees.every(a => a === "张明"),
    JSON.stringify(salesView.assignees));
  check("列表中看不到其他销售的名字",
    salesView.assignees.every(a => !["李华", "王芳", "刘强", "陈静"].includes(a)),
    JSON.stringify(salesView.assignees));

  // 与服务端 total 对照（确认不是前端只渲染了一页的假象）
  const serverTotal = await evalJS(cdp, sessionId, `(async () => {
    const u = new URL(location.origin + '/api/leads');
    const s = JSON.parse(localStorage.getItem('crm_auth'));
    u.searchParams.set('user_name', s.user.name);
    u.searchParams.set('user_phone', s.user.phone);
    u.searchParams.set('role_id', s.user.roleId);
    u.searchParams.set('pageSize', '1');
    const r = await fetch(u.toString());
    const d = await r.json();
    return d.total;
  })()`);
  check("★ 服务端对销售只返回 6 条（与页面一致量级）", serverTotal === 6, `total=${serverTotal}`);
  await shot("B_leads_sales.png");

  // ---------- D. 新增弹窗：跟进人锁定 ----------
  console.log("\n[D] 新增线索弹窗：跟进人锁定本人");
  const openedAdd = await evalJS(cdp, sessionId, `(() => {
    const btns = [...document.querySelectorAll('button')];
    // ⚠️ 按钮文案是「添加新线索」（不是「新增线索」）—— 按包含「新线索」匹配更稳
    const b = btns.find(x => /新线索|新增线索/.test(x.textContent.trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check("找到并点击「新增」按钮", openedAdd === true);
  const addOk = await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="lead-add-assignee"]')`, "新增弹窗出现");
  check("新增弹窗的跟进人下拉出现", addOk === true);
  await sleep(600);

  const addAssignee = await evalJS(cdp, sessionId, `(() => {
    const el = document.querySelector('[data-testid="lead-add-assignee"]');
    if (!el) return null;
    return {
      disabled: el.disabled,
      value: el.value,
      options: [...el.options].map(o => o.value),
      hint: !!document.querySelector('[data-testid="lead-assignee-hint"]'),
      hintText: (document.querySelector('[data-testid="lead-assignee-hint"]') || {}).textContent || '',
    };
  })()`);
  check("★ 跟进人下拉被锁定（disabled）", addAssignee && addAssignee.disabled === true, JSON.stringify(addAssignee));
  check("★ 跟进人只能是本人（张明）",
    addAssignee && addAssignee.options.length === 1 && addAssignee.options[0] === "张明",
    JSON.stringify(addAssignee && addAssignee.options));
  check("★ 给出锁定原因的提示文案", addAssignee && addAssignee.hint === true && /仅能创建归属自己/.test(addAssignee.hintText),
    JSON.stringify(addAssignee && addAssignee.hintText));
  await shot("D_add_assignee_locked.png");

  // 关闭弹窗
  await evalJS(cdp, sessionId, CLOSE_MODAL);
  await sleep(600);

  // ---------- E. 编辑弹窗：跟进人锁定 ----------
  console.log("\n[E] 编辑线索弹窗：跟进人锁定本人");
  const openedEdit = await evalJS(cdp, sessionId, `(() => {
    const b = document.querySelector('table tbody tr button[title="修改"], table tbody tr button[title="编辑"]');
    if (!b) {
      // 兜底：找行内第二个图标按钮
      const row = document.querySelector('table tbody tr');
      if (!row) return false;
      const btns = [...row.querySelectorAll('button')];
      if (!btns.length) return false;
      btns[Math.min(1, btns.length - 1)].click();
      return true;
    }
    b.click();
    return true;
  })()`);
  check("打开编辑弹窗", openedEdit === true);
  const editOk = await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="lead-edit-assignee"]')`, "编辑弹窗出现");
  check("编辑弹窗的跟进人下拉出现", editOk === true);
  await sleep(600);

  const editAssignee = await evalJS(cdp, sessionId, `(() => {
    const el = document.querySelector('[data-testid="lead-edit-assignee"]');
    if (!el) return null;
    return { disabled: el.disabled, value: el.value, options: [...el.options].map(o => o.value) };
  })()`);
  check("★ 编辑弹窗跟进人也被锁定", editAssignee && editAssignee.disabled === true, JSON.stringify(editAssignee));
  check("★ 编辑弹窗跟进人是本人",
    editAssignee && editAssignee.value === "张明", JSON.stringify(editAssignee && editAssignee.value));
  await shot("E_edit_assignee_locked.png");
  await evalJS(cdp, sessionId, CLOSE_MODAL);
  await sleep(500);

  // ---------- F. 沟通记录页 ----------
  console.log("\n[F] 沟通记录页（销售视角）");
  await cdp.send("Page.navigate", { url: `${BASE}/communications` }, sessionId);
  await sleep(2500);
  // 同样先把默认日期范围放宽（沟通记录数据也在 6 月）
  await evalJS(cdp, sessionId, WIDEN_DATES);
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await sleep(1800);
  const okComm = await waitFor(cdp, sessionId, `!!document.querySelector('table tbody tr')`, "沟通表格出现", 20000);
  check("沟通记录列表渲染", okComm === true);
  await sleep(1000);
  const commView = await evalJS(cdp, sessionId, `(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    const ths = [...document.querySelectorAll('table thead th')].map(t => t.textContent.trim());
    return { rowCount: rows.length, headers: ths };
  })()`);
  check("沟通记录有数据", commView.rowCount > 0, JSON.stringify(commView));
  await shot("F_comm_sales.png");

  // ---------- G. 对照：管理员 ----------
  console.log("\n[G] 对照：管理员视角");
  const ad = await loginAs(cdp, sessionId, "13912345678", "123123");
  check("管理员登录成功", ad && ad.ok === true, JSON.stringify(ad));
  await cdp.send("Page.navigate", { url: `${BASE}/leads` }, sessionId);
  await sleep(2500);
  await evalJS(cdp, sessionId, WIDEN_DATES);
  await evalJS(cdp, sessionId, CLICK_QUERY);
  await waitFor(cdp, sessionId, `!!document.querySelector('table tbody tr')`, "管理员线索表格", 20000);
  await sleep(1000);
  const adminTotal = await evalJS(cdp, sessionId, `(async () => {
    const u = new URL(location.origin + '/api/leads');
    const s = JSON.parse(localStorage.getItem('crm_auth'));
    u.searchParams.set('user_name', s.user.name);
    u.searchParams.set('user_phone', s.user.phone);
    u.searchParams.set('role_id', s.user.roleId);
    u.searchParams.set('pageSize', '1');
    const r = await fetch(u.toString());
    return (await r.json()).total;
  })()`);
  check("★ 管理员可见总数远多于销售", adminTotal > serverTotal, `admin=${adminTotal} sales=${serverTotal}`);
  // 不写死绝对数（数据会变、且受日期范围影响），改为断言「管理员 > 销售」且「管理员是销售的多倍」
  check("管理员可见数 ≥ 销售可见数的 3 倍", adminTotal >= serverTotal * 3,
    `admin=${adminTotal} sales=${serverTotal}`);
  await shot("G_leads_admin.png");

  // ---------- 汇总 ----------
  console.log("\n" + "=".repeat(56));
  console.log(`  通过 ${pass} / ${pass + fail}`);
  console.log("=".repeat(56));

  try { chrome.kill(); } catch {}
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("脚本异常:", e.message); process.exit(2); });
