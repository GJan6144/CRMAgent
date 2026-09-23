/**
 * 「角色权限设置」弹窗底部操作区（保存权限 / 取消）布局验证 —— 无头浏览器 + CDP
 *
 * 背景：Modal body 自带 24px 内边距，sticky 底部按钮行默认只有「内容区」宽度，
 *       滚动时下层内容会从按钮**两侧** + 底部留白处透出来（看起来像盖不住）。
 *
 * 验证（视口刻意用偏矮的 1366×768，权限弹窗内容足够高，才会进入滚动状态）：
 *   A. 白底铺满：按钮行左右边界覆盖到 body 的 padding 边（排除滚动条宽度）
 *   B. 贴底：滚动到底后按钮行下边缘与 body 下边缘对齐（不再有底部留白漏内容）
 *   C. 不透明：按钮行 computed background-color 为不透明白
 *   D. 层级：按钮行内部四角采样点 elementFromPoint 均落在按钮行子树内
 *   E. 两按钮等宽（flex:1 生效，未被下层内容挤压）
 *   F. 滚动到底内容不丢（sticky 参与正常流，最后一行仍可完整滚出）
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9961;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_permfooter_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    try { if (await evalJS(cdp, sid, expr)) return true; } catch {}
    await sleep(400);
  }
  console.log("  ! 超时:", label); return false;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crm-permfooter-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  // ⚠️ 刻意用偏矮视口：权限弹窗内容高，矮视口下才会进入内部滚动
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }, sessionId);

  let pass = 0, fail = 0;
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; console.log("[FAIL]", n, "::", extra); } };
  const shot = async (name, clip) => {
    try {
      const r = await cdp.send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" }, sessionId);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
    } catch (e) { console.log("  ! 截图失败", name, e.message); }
  };

  // ---------- 登录 ----------
  await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "登录页");
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

  // ---------- 打开「权限设置 - 销售」弹窗 ----------
  await cdp.send("Page.navigate", { url: `${BASE}/roles` }, sessionId);
  await waitFor(cdp, sessionId, "document.readyState === 'complete'", "角色页");
  await sleep(2200);
  await waitFor(cdp, sessionId, `!!document.querySelector('tr')`, "角色行");
  // ⚠️ 用语义锚点（含「销售」的行）而非行序索引
  const clickRes = await evalJS(cdp, sessionId, `(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const row = rows.find(r => r.innerText.includes('销售'));
    if (!row) return 'no-row';
    const btn = row.querySelector('button[title="修改权限"]');
    if (!btn) return 'no-btn';
    btn.click(); return 'ok';
  })()`);
  check("打开销售权限弹窗", clickRes === "ok", clickRes);
  await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="role-perm-save"]')`, "权限弹窗");
  await sleep(700);

  // ---------- 滚到内容底部，让 sticky 按钮行吸底 ----------
  const scrolled = await evalJS(cdp, sessionId, `(() => {
    const b = document.querySelector('[data-testid="modal-body"]');
    if (!b) return null;
    b.scrollTop = b.scrollHeight;
    return { scrollTop: b.scrollTop, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight };
  })()`);
  await sleep(600);
  console.log("  modal-body:", JSON.stringify(scrolled));

  // ---------- 几何测量 ----------
  const geo = await evalJS(cdp, sessionId, `(() => {
    const body = document.querySelector('[data-testid="modal-body"]');
    const save = document.querySelector('[data-testid="role-perm-save"]');
    if (!body || !save) return null;
    const bar = save.parentElement;
    const b = body.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const s = save.getBoundingClientRect();
    const cancel = save.nextElementSibling;
    const c = cancel ? cancel.getBoundingClientRect() : null;
    const cs = getComputedStyle(bar);
    const sbw = body.offsetWidth - body.clientWidth;   // 滚动条宽度（左右各 0）
    // 四角内缩采样，检查层级是否被下层内容压住
    const pts = [[r.left+6, r.top+6], [r.right-6, r.top+6], [r.left+6, r.bottom-6], [r.right-6, r.bottom-6]];
    const hits = pts.map(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? (bar.contains(el) ? 'bar' : (el.tagName + '.' + (el.className || '')).slice(0, 40)) : 'null';
    });
    return {
      body: { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height },
      bar:  { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height },
      save: { w: s.width },
      cancel: c ? { w: c.width } : null,
      bg: cs.backgroundColor, zIndex: cs.zIndex, position: cs.position,
      scrollbarW: sbw, hits,
      scrollLeft: body.scrollHeight - body.scrollTop - body.clientHeight,
    };
  })()`);
  console.log("  几何:", JSON.stringify(geo, null, 1));
  check("取到几何数据", !!geo);
  if (!geo) { console.log(`\n通过 ${pass} / ${pass + fail}`); chrome.kill(); process.exit(1); }

  const { body, bar } = geo;
  // A. 白底铺满（左贴紧、右允许滚动条宽度）
  check("A. 按钮行左边界铺到 body 左缘", bar.left <= body.left + 1.5, `bar.left=${bar.left} body.left=${body.left}`);
  check("A. 按钮行右边界铺满（仅容滚动条）", bar.right >= body.right - geo.scrollbarW - 1.5,
    `bar.right=${bar.right} body.right=${body.right} scrollbarW=${geo.scrollbarW}`);
  // bar 宽度应 = body 宽度 - 滚动条宽度（body 的 padding box 全宽）
  check("A. 按钮行横向覆盖 body 的 padding 边（仅差滚动条）", bar.w >= body.w - geo.scrollbarW - 1.5,
    `bar.w=${bar.w} body.w=${body.w} scrollbarW=${geo.scrollbarW}`);
  // B. 贴底，无底部留白
  check("B. 滚动到底后按钮行贴住 body 下缘", bar.bottom >= body.bottom - 1.5, `bar.bottom=${bar.bottom} body.bottom=${body.bottom}`);
  // C. 不透明白底
  check("C. 按钮行白底不透明", /^rgb\(255,\s*255,\s*255\)$/.test(geo.bg), geo.bg);
  check("C. 按钮行为 sticky 且已抬层级", geo.position === "sticky" && Number(geo.zIndex) >= 1,
    `position=${geo.position} zIndex=${geo.zIndex}`);
  // D. 层级：四角采样均落在按钮行内
  check("D. 四角采样点均命中按钮行（无下层内容压上）", geo.hits.every((h) => h === "bar"), JSON.stringify(geo.hits));
  // E. 两按钮等宽
  check("E. 保存/取消严格等宽（flex:1 未被挤压）", !!geo.cancel && Math.abs(geo.save.w - geo.cancel.w) <= 0.5,
    `save=${geo.save.w} cancel=${geo.cancel && geo.cancel.w}`);
  // F. 内容不丢
  check("F. 滚动到底剩余量≈0（内容未被永久遮挡）", Math.abs(geo.scrollLeft) <= 2, `remain=${geo.scrollLeft}`);

  // ---------- 截图 ----------
  await shot("01_perm_modal_full.png");
  await shot("02_perm_footer_zoom.png", {
    x: Math.max(0, bar.left - 40), y: Math.max(0, bar.top - 120),
    width: Math.min(1366, bar.w + 80), height: Math.min(768, (bar.bottom - bar.top) + 150),
    scale: 2,
  });

  console.log(`\n通过 ${pass} / ${pass + fail}`);
  console.log("截图目录:", OUT);
  chrome.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("脚本异常:", e); process.exit(2); });
