/**
 * 「用量统计」Tab 布局回归 —— 无头浏览器 + CDP
 *
 * 背景（已发生的 bug）：用量统计的 JSX 块被写在 `</main>` **之后**，
 * 于是它成了页面 `display:flex` 行的第三个 flex item →
 * Tab 栏被挤成 113px 宽、用量汇总整块**渲染到右侧**成独立一列
 * （实测 main 宽仅 177px、totals.x = 417 = main.right）。
 *
 * 本脚本断言「与其他 Tab 一样的下方展示」这一布局契约：
 *   A. ★ 用量汇总块必须是 <main> 的**后代**（不是兄弟节点）
 *   B. ★ 用量汇总在 Tab 栏**下方**（top > 栏底）
 *   C. ★ 用量汇总**左对齐到主内容区**（x ≈ main.x + padding）
 *   D. ★ 用量汇总**铺满主内容宽度**（不与右边界留出第三列）
 *   E. Tab 栏单行、8 个 Tab 均不折行（宽度 ≥ 40）
 *   F. main 宽度 ≈ 视口 − 侧边栏（没有被右侧内容挤窄）
 *   G. 明细表同样位于 main 内且铺满
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9967;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_usage_layout_screenshots");
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
  if (r.exceptionDetails) throw new Error(`[${expr.slice(0, 60)}] ` + JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value; }
async function waitFor(cdp, sid, expr, label, t = 30000) { const t0 = Date.now(); while (Date.now() - t0 < t) {
  try { if (await evalJS(cdp, sid, expr)) return true; } catch {} await sleep(400); } console.log("  ! 超时:", label); return false; }

const GEO = `(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const main = document.querySelector('main');
  const tabs = document.querySelector('[data-testid="tab-usage"]');
  const bar  = tabs ? tabs.parentElement : null;
  const totals = document.querySelector('[data-testid="usage-totals"]');
  const usersHead = document.querySelector('[data-testid="usage-users-head"]');
  const tableWrap = usersHead ? usersHead.parentElement.parentElement : null;
  const wrap = totals ? totals.parentElement : null;   // {tab === "usage"} 外壳
  return {
    viewportW: innerWidth,
    main: R(main),
    bar: R(bar),
    barCount: bar ? bar.children.length : 0,
    tabWidths: bar ? Array.from(bar.children).map((b) => Math.round(b.getBoundingClientRect().width)) : [],
    tabLabels: bar ? Array.from(bar.children).map((b) => (b.innerText || '').trim()) : [],
    wrap: R(wrap),
    totals: R(totals),
    tableWrap: R(tableWrap),
    wrapInMain: !!(main && wrap && main.contains(wrap)),
    totalsInMain: !!(main && totals && main.contains(totals)),
    tableInMain: !!(main && tableWrap && main.contains(tableWrap)),
    wrapParentIsMain: !!(main && wrap && wrap.parentElement === main),
    usageContentAfterBar: !!(bar && totals && totals.getBoundingClientRect().top >= bar.getBoundingClientRect().bottom - 1),
    mainPadLeft: main ? parseFloat(getComputedStyle(main).paddingLeft) : null,
    bodyOverflowX: document.documentElement.scrollWidth - innerWidth,
  };
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crm-usagelayout-"));
  spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1500,1300", "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(300); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  const VW = 1500, VH = 1300;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false }, sessionId);

  let pass = 0, fail = 0;
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; console.log("[FAIL]", n, "::", extra); } };

  await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "登录页");
  await sleep(1200);
  const lg = await evalJS(cdp, sessionId, `(async () => {
    const res = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone:'13912345678', password:'123123' }) });
    const d = await res.json(); localStorage.setItem('crm_auth', JSON.stringify(d)); return res.ok;
  })()`);
  check("登录 系统管理员", lg === true);

  await cdp.send("Page.navigate", { url: `${BASE}/agent` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "面板页");
  await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"tab-usage\"]')", "Tab 栏");
  await sleep(1500);
  await evalJS(cdp, sessionId, `(() => { document.querySelector('[data-testid="tab-usage"]').click(); return true; })()`);
  await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"usage-totals\"]')", "用量汇总");
  await sleep(1200);

  const g = await evalJS(cdp, sessionId, GEO);
  console.log("\n--- 几何 ---");
  console.log("main   ", JSON.stringify(g.main));
  console.log("bar    ", JSON.stringify(g.bar), "tabs:", JSON.stringify(g.tabLabels));
  console.log("wrap   ", JSON.stringify(g.wrap));
  console.log("totals ", JSON.stringify(g.totals));
  console.log("table  ", JSON.stringify(g.tableWrap));
  console.log("主内容左内边距:", g.mainPadLeft, "| 文档横向溢出:", g.bodyOverflowX, "px");

  console.log("\n--- 断言 ---");
  check("A. ★ 用量统计块是 <main> 的后代（不是 flex 兄弟节点）", g.wrapInMain === true, `wrapInMain=${g.wrapInMain}`);
  check("A2. 用量统计块是 <main> 的直接子节点（与其它 Tab 同级）", g.wrapParentIsMain === true);
  check("B. ★ 用量汇总在 Tab 栏下方（top ≥ 栏底）", g.usageContentAfterBar === true,
    `totals.top=${g.totals && g.totals.y} bar.bottom=${g.bar && g.bar.bottom}`);
  check("C. ★ 用量汇总左对齐主内容区（x ≈ main.x + padding）",
    g.totals && g.main && Math.abs(g.totals.x - (g.main.x + g.mainPadLeft)) <= 2,
    `totals.x=${g.totals && g.totals.x} expect=${g.main.x + g.mainPadLeft}`);
  check("D. ★ 用量汇总铺满主内容（右侧不空出一列）",
    g.totals && g.main && Math.abs(g.totals.right - (g.main.right - g.mainPadLeft)) <= 2,
    `totals.right=${g.totals && g.totals.right} expect=${g.main.right - g.mainPadLeft}`);
  check("E. Tab 栏单行（高度 ≤ 56）", g.bar && g.bar.h <= 56, `bar.h=${g.bar && g.bar.h}`);
  check("E2. 8 个 Tab 均在（顺序：概览/配置/Skill/MCP/渠道/记忆/模型/用量）",
    g.barCount === 8 && g.tabLabels[0] === "Agent 概览" && g.tabLabels[7] === "用量统计",
    JSON.stringify(g.tabLabels));
  check("E3. 无 Tab 被挤到折行/过窄（每个宽度 ≥ 40）",
    g.tabWidths.length === 8 && g.tabWidths.every((w) => w >= 40), JSON.stringify(g.tabWidths));
  check("F. main 未被右侧内容挤窄（width ≈ 视口 − 侧边栏 240）",
    g.main && Math.abs(g.main.w - (VW - 240)) <= 4, `main.w=${g.main && g.main.w} expect=${VW - 240}`);
  check("G. 明细表位于 <main> 内且铺满",
    g.tableInMain === true && Math.abs(g.tableWrap.right - g.totals.right) <= 2,
    JSON.stringify(g.tableWrap));
  check("H. 页面无横向溢出", g.bodyOverflowX <= 0, `${g.bodyOverflowX}px`);

  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(OUT, "usage_layout_fixed.png"), Buffer.from(r.data, "base64"));

  console.log(`\n结果：PASS=${pass}  FAIL=${fail}  截图: ${OUT}`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
})();
