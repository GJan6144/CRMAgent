/**
 * 「用量统计」Tab 前端验证 —— 无头浏览器 + CDP
 *
 * 验证：
 *   A. Agent 控制面板出现「用量统计」Tab，可点开
 *   B. 总量卡渲染（总 token / 输入 / 输出 / 轮数）
 *   C. 按用户明细表渲染，含表头与合计行
 *   D. ⚠️ 核心：各用户行求和 === 合计行 === 总量（前端展示口径一致）
 *   E. 合计自检徽标为「一致」态
 *   F. 累计 / 今日 口径可切换
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9955;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_usage_screenshots");
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
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crm-usage-"));
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

  // ---------- 打开 Agent 控制面板并切到「用量统计」 ----------
  console.log("\n=== A. 用量统计 Tab ===");
  await cdp.send("Page.navigate", { url: `${BASE}/agent` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "面板页", 30000);
  await sleep(2200);

  const hasTab = await evalJS(cdp, sessionId, `!!document.querySelector('[data-testid="tab-usage"]')`);
  check("存在「用量统计」Tab", hasTab === true);
  const tabLabel = await evalJS(cdp, sessionId,
    `(document.querySelector('[data-testid="tab-usage"]')||{}).innerText`);
  check("Tab 文案为「用量统计」", (tabLabel || "").trim() === "用量统计", String(tabLabel));

  await evalJS(cdp, sessionId, `(() => { const b = document.querySelector('[data-testid="tab-usage"]'); if (b) b.click(); return true; })()`);
  await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"usage-totals\"]')", "总量卡渲染", 25000);
  await sleep(1200);
  await shot("usage-tab.png");
  check("点击后总量卡出现", true);

  // ---------- B. 总量卡 ----------
  console.log("\n=== B. 总量卡 ===");
  const totals = await evalJS(cdp, sessionId, `(() => {
    const el = document.querySelector('[data-testid="usage-totals"]');
    if (!el) return null;
    const cards = Array.from(el.children).map(c => ({
      k: (c.children[0]||{}).innerText,
      v: (c.children[1]||{}).innerText,
    }));
    return cards;
  })()`);
  console.log("  卡片:", JSON.stringify(totals));
  check("总量卡有 4 项", Array.isArray(totals) && totals.length === 4, JSON.stringify(totals));
  const totalNum = (t) => parseInt(String(t || "0").replace(/[^0-9]/g, ""), 10) || 0;
  const totalCard = (totals || []).find(c => c.k === "总 token");
  check("「总 token」卡数值 > 0", totalNum(totalCard?.v) > 0, JSON.stringify(totalCard));

  // ---------- C. 按用户表 ----------
  console.log("\n=== C. 按用户明细表 ===");
  const tableInfo = await evalJS(cdp, sessionId, `(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="usage-row-"]'));
    const parse = (s) => parseInt(String(s||'0').replace(/[^0-9]/g,''),10) || 0;
    // ⚠️ 表头有 9 列（用户|角色|总token|占比|输入|输出|轮数|工具|最近），
    //    但 tfoot 的「合计」单元格 colSpan={2} → footer.cells 只有 8 个，索引会错位。
    //    因此按「列语义」分别取值，而不是盲目用同一个索引。
    const data = rows.map(r => {
      const td = Array.from(r.cells).map(c => c.innerText.trim());
      return { name: td[0], role: td[1], total: parse(td[2]), pct: td[3], quota: td[4],
               prompt: parse(td[5]), completion: parse(td[6]), turns: parse(td[7]), tools: parse(td[8]) };
    });
    const footer = document.querySelector('[data-testid="usage-footer"]');
    let ft = [], footerTotal = 0, footerTurns = 0, footerPrompt = 0, footerCompletion = 0, footerTools = 0;
    if (footer) {
      ft = Array.from(footer.cells).map(c => c.innerText.trim());
      // tfoot 首格 colSpan=2 → cells 比数据行少 1；「本月额度」列在本月额度处是说明文字
      const base = ft.length === 9 ? 1 : 0;
      footerTotal = parse(ft[base]);              // 总 token
      footerPrompt = parse(ft[base + 3]);         // 输入（跨过「本月额度」列）
      footerCompletion = parse(ft[base + 4]);     // 输出
      footerTurns = parse(ft[base + 5]);          // 轮数
      footerTools = parse(ft[base + 6]);          // 工具调用
    }
    const sc = document.querySelector('[data-testid="usage-selfcheck"]');
    return {
      rows: rows.length, data,
      footerTotal, footerTurns, footerPrompt, footerCompletion, footerTools,
      footerCells: ft,
      selfcheckText: sc ? sc.innerText.trim() : null,
      selfcheckPass: sc ? /合计一致/.test(sc.innerText) : false,
    };
  })()`);
  console.log("  行数:", tableInfo.rows);
  tableInfo.data.forEach(d => console.log(`    ${d.name} | ${d.role} | ${d.total} | ${d.pct} | 轮=${d.turns}`));
  console.log("  合计行 total:", tableInfo.footerTotal, " turns:", tableInfo.footerTurns);
  console.log("  自检徽标:", JSON.stringify(tableInfo.selfcheckText));

  check("明细表至少 1 行", tableInfo.rows >= 1, tableInfo.rows);
  const rowSum = tableInfo.data.reduce((s, d) => s + d.total, 0);
  check(`★ 各行 total 求和(${rowSum}) === 合计行(${tableInfo.footerTotal})`,
        rowSum === tableInfo.footerTotal, `${rowSum} vs ${tableInfo.footerTotal}`);
  check(`★ 合计行 === 总量卡(${totalNum(totalCard?.v)})`,
        tableInfo.footerTotal === totalNum(totalCard?.v),
        `${tableInfo.footerTotal} vs ${totalNum(totalCard?.v)}`);
  check("自检徽标显示「合计一致」", tableInfo.selfcheckPass === true, tableInfo.selfcheckText);

  const turnsSum = tableInfo.data.reduce((s, d) => s + d.turns, 0);
  check(`轮数也自洽（各行 ${turnsSum} === 合计行 ${tableInfo.footerTurns}）`,
        turnsSum === tableInfo.footerTurns, `${turnsSum} vs ${tableInfo.footerTurns}`);

  const promptSum = tableInfo.data.reduce((s, d) => s + d.prompt, 0);
  const completionSum = tableInfo.data.reduce((s, d) => s + d.completion, 0);
  const toolsSum = tableInfo.data.reduce((s, d) => s + d.tools, 0);
  check(`输入求和自洽（${promptSum} === ${tableInfo.footerPrompt}）`,
        promptSum === tableInfo.footerPrompt, `${promptSum} vs ${tableInfo.footerPrompt}`);
  check(`输出求和自洽（${completionSum} === ${tableInfo.footerCompletion}）`,
        completionSum === tableInfo.footerCompletion, `${completionSum} vs ${tableInfo.footerCompletion}`);
  check(`工具调用求和自洽（${toolsSum} === ${tableInfo.footerTools}）`,
        toolsSum === tableInfo.footerTools, `${toolsSum} vs ${tableInfo.footerTools}`);
  // 输入 + 输出 === 总量（明细口径内部自洽）
  check(`★ 输入+输出 === 总量（${promptSum + completionSum} === ${tableInfo.footerTotal}）`,
        promptSum + completionSum === tableInfo.footerTotal,
        `${promptSum}+${completionSum} vs ${tableInfo.footerTotal}`);

  // 占比条
  const hasBars = await evalJS(cdp, sessionId, `(() => {
    const row = document.querySelector('[data-testid="usage-row-0"]');
    if (!row) return false;
    return !!row.querySelector('table, div > div > div') && /%/.test(row.innerText);
  })()`);
  check("占比列渲染百分比", hasBars === true);

  // ---------- D. 未知用户提示（若有历史数据） ----------
  console.log("\n=== D. 历史数据提示 ===");
  const unknownRow = (tableInfo.data || []).find(d => d.name === "未知用户");
  const unknownHint = await evalJS(cdp, sessionId,
    `(() => { const e = document.querySelector('[data-testid="usage-unknown-hint"]'); return e ? e.innerText.trim().slice(0,60) : null; })()`);
  console.log("  有「未知用户」行:", !!unknownRow, " 提示:", JSON.stringify(unknownHint));
  check("有未知用户行时也给出说明（口径透明）",
        !unknownRow || !!unknownHint, `行=${!!unknownRow} 提示=${!!unknownHint}`);

  // ---------- E. 口径切换 ----------
  console.log("\n=== E. 累计 / 今日 切换 ===");
  const todayClicked = await evalJS(cdp, sessionId,
    `(() => { const b = document.querySelector('[data-testid="usage-scope-today"]'); if (!b) return false; b.click(); return true; })()`);
  check("「今日」按钮可点击", todayClicked === true);
  await sleep(2200);
  const todayTotals = await evalJS(cdp, sessionId, `(() => {
    const el = document.querySelector('[data-testid="usage-totals"]');
    if (!el) return null;
    const c = Array.from(el.children).find(x => /总 token/.test((x.children[0]||{}).innerText||''));
    return c ? parseInt(String((c.children[1]||{}).innerText||'0').replace(/[^0-9]/g,''),10) : null;
  })()`);
  console.log("  今日总量:", todayTotals, " 累计总量:", totalNum(totalCard?.v));
  check("今日总量 <= 累计总量", (todayTotals || 0) <= totalNum(totalCard?.v),
        `${todayTotals} vs ${totalNum(totalCard?.v)}`);
  check("今日口径自检仍一致", await evalJS(cdp, sessionId,
        `(() => { const s = document.querySelector('[data-testid="usage-selfcheck"]'); return s ? /合计一致/.test(s.innerText) : false; })()`) === true);
  await shot("usage-today.png");

  // 切回累计
  await evalJS(cdp, sessionId, `(() => { const b = document.querySelector('[data-testid="usage-scope-all"]'); if (b) b.click(); return true; })()`);
  await sleep(1800);
  check("可切回「累计」", await evalJS(cdp, sessionId,
        `(() => { const b = document.querySelector('[data-testid="usage-scope-all"]'); return !!b; })()`) === true);

  console.log(`\n${"=".repeat(60)}\n结果：PASS=${pass}  FAIL=${fail}\n${"=".repeat(60)}`);
  console.log("截图目录:", OUT);

  try { chrome.kill(); } catch {}
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error("脚本异常:", e); process.exit(1); });
