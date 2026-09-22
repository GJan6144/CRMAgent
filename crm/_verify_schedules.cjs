/**
 * Agent 定时任务 —— 无头浏览器端到端验证 + 截图
 *
 * 覆盖两类触发规则（定时执行 / 周期执行）+ 仅工作日勾选：
 *   1) 登录管理员，清空任务
 *   2) 打开 /schedules，断言标题与空状态
 *   3) 创建 3 个任务（daily+repeat / daily+once 停止 / interval+仅工作日），断言列表
 *   4) 打开创建弹窗，断言触发规则选择、时间下拉、仅工作日勾选、测试/保存按钮
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9934;
const BASE = "http://127.0.0.1:3100";
const OUT_DIR = path.join(__dirname, "_schedules_screenshots");

const PASS = { n: 0 };
const FAIL = [];
function check(name, cond, extra = "") {
  if (cond) {
    PASS.n++;
    console.log(`[PASS] ${name}`);
  } else {
    FAIL.push(name);
    console.log(`[FAIL] ${name} :: ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 40000);
    });
  }
}

async function evalJS(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function waitFor(cdp, sessionId, expression, label, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(cdp, sessionId, expression)) return true;
    } catch {}
    await sleep(400);
  }
  console.log(`  ! 等待超时: ${label}`);
  return false;
}
async function shoot(cdp, sessionId, file) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(r.data, "base64"));
  console.log(`  -> 截图 ${file}`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-sched-"));

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--window-size=1600,1000",
    "about:blank",
  ], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(300);
    }
  }
  if (!version) throw new Error("Chrome 调试端口未就绪");

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

  try {
    /* ---------- 1. 登录 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "login 页加载");
    const store = await evalJS(cdp, sessionId,
      `fetch('/api/auth/login', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ phone: '13912345678', password: '123123' })
       }).then(r => r.json()).then(d => {
         if (!d || !d.user || !d.token) return '';
         const v = JSON.stringify({ user: d.user, role: d.role, token: d.token });
         localStorage.setItem('crm_auth', v); return v;
       })`);
    check("S1 注入管理员登录态", typeof store === "string" && store.length > 20);

    /* ---------- 2. 清空已有任务 ---------- */
    await evalJS(cdp, sessionId,
      `fetch('/api/agent/schedules').then(r => r.json()).then(async d => {
         for (const t of (d.data || [])) await fetch('/api/agent/schedules/' + t.id, { method: 'DELETE' });
         return 'cleared';
       })`);

    /* ---------- 3. 打开 /schedules ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/schedules` }, sessionId);
    const rendered = await waitFor(cdp, sessionId,
      "document.body.innerText.includes('Agent 定时任务')", "定时任务页标题");
    check("S2 页面渲染出标题", rendered);
    await waitFor(cdp, sessionId, "document.body.innerText.includes('暂无定时任务')", "空状态");
    check("S3 空状态提示", true);

    /* ---------- 4. 创建 3 个任务覆盖两类规则 ---------- */
    const created = await evalJS(cdp, sessionId,
      `(async () => {
         const mk = (b) => fetch('/api/agent/schedules', {
           method: 'POST', headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify(b)
         }).then(r => r.json());
         const a = await mk({ name: '每日销售汇总', prompt: '帮我统计今天的订单数量与销售额。', trigger_type: 'daily', hour: 9, minute: 0, frequency: 'repeat' });
         const b = await mk({ name: '一次性客户回访', prompt: '列出本周需要跟进的线索。', trigger_type: 'daily', hour: 18, minute: 30, frequency: 'once' });
         const c = await mk({ name: '周期数据巡检', prompt: '检查 CRM 数据完整性。', trigger_type: 'interval', hour: 1, minute: 30, weekdays_only: true });
         await fetch('/api/agent/schedules/' + b.task.id + '/enabled', {
           method: 'PUT', headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ enabled: false })
         });
         return { a: a.task, b: b.task, c: c.task };
       })()`);
    check("S4 通过代理创建 3 个任务", created && created.a && created.b && created.c);

    /* ---------- 5. 刷新页面断言列表 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/schedules` }, sessionId);
    await waitFor(cdp, sessionId,
      "document.querySelectorAll('table tbody tr').length >= 3", "列表行渲染");
    const listInfo = await evalJS(cdp, sessionId,
      `(() => {
         const rows = Array.from(document.querySelectorAll('table tbody tr'));
         const text = document.body.innerText;
         return {
           rows: rows.length,
           hasNames: text.includes('每日销售汇总') && text.includes('一次性客户回访') && text.includes('周期数据巡检'),
           hasDaily: text.includes('定时执行'),
           hasInterval: text.includes('周期执行'),
           hasRepeat: text.includes('重复'),
           hasOnce: text.includes('一次'),
           hasWeekday: text.includes('仅工作日'),
           hasRunning: text.includes('运行中'),
           hasStopped: text.includes('已停止'),
           hasCreate: text.includes('创建定时任务'),
         };
       })()`);
    check("S5 列表渲染 3 行", listInfo.rows === 3, JSON.stringify({ rows: listInfo.rows }));
    check("S6 展示任务名", listInfo.hasNames);
    check("S7 展示触发规则（定时执行/周期执行）", listInfo.hasDaily && listInfo.hasInterval);
    check("S8 展示频率（重复/一次）", listInfo.hasRepeat && listInfo.hasOnce);
    check("S9 展示「仅工作日」标签", listInfo.hasWeekday);
    check("S10 展示状态（运行中/已停止）", listInfo.hasRunning && listInfo.hasStopped);
    check("S11 右上角创建按钮", listInfo.hasCreate);
    await shoot(cdp, sessionId, "1-schedules-list.png");

    /* ---------- 6. 打开创建弹窗 ---------- */
    const opened = await evalJS(cdp, sessionId,
      `(() => {
         const btns = Array.from(document.querySelectorAll('button'));
         const b = btns.find((x) => x.innerText.trim() === '创建定时任务');
         if (!b) return false;
         b.click(); return true;
       })()`);
    check("S12 可打开创建弹窗", opened);
    await waitFor(cdp, sessionId,
      "document.body.innerText.includes('任务执行提示词') && document.body.innerText.includes('触发规则')",
      "创建弹窗字段");
    const modalInfo = await evalJS(cdp, sessionId,
      `(() => {
         const t = document.body.innerText;
         return {
           hasName: t.includes('定时任务名'),
           hasPrompt: t.includes('任务执行提示词'),
           hasRule: t.includes('触发规则'),
           hasDaily: t.includes('定时执行'),
           hasInterval: t.includes('周期执行'),
           hasWeekday: t.includes('仅工作日执行'),
           hasTest: t.includes('测试'),
           hasSave: t.includes('保存'),
           selects: document.querySelectorAll('select').length,
         };
       })()`);
    check("S13 弹窗含任务名/提示词/触发规则字段", modalInfo.hasName && modalInfo.hasPrompt && modalInfo.hasRule);
    check("S14 触发规则可选（定时执行/周期执行）", modalInfo.hasDaily && modalInfo.hasInterval);
    check("S15 含「仅工作日执行」勾选", modalInfo.hasWeekday);
    check("S16 含测试/保存按钮", modalInfo.hasTest && modalInfo.hasSave);
    check("S17 时间下拉（时/分两个 select）", modalInfo.selects === 2, String(modalInfo.selects));

    /* ---------- 7. 切换到「周期执行」验证动态时间范围 ---------- */
    const switched = await evalJS(cdp, sessionId,
      `(() => {
         const btns = Array.from(document.querySelectorAll('button'));
         const b = btns.find((x) => x.innerText.trim() === '周期执行');
         if (!b) return false;
         b.click(); return true;
       })()`);
    check("S18 可切换到周期执行", switched);
    await sleep(500);
    const intervalInfo = await evalJS(cdp, sessionId,
      `(() => {
         const t = document.body.innerText;
         return {
           hasIntervalLabel: t.includes('间隔时长'),
           noFreq: !t.includes('执行频率'),
         };
       })()`);
    check("S19 周期模式显示「间隔时长」且隐藏频率", intervalInfo.hasIntervalLabel && intervalInfo.noFreq);
    await shoot(cdp, sessionId, "2-schedules-create-modal.png");

    /* ---------- 8. 清理 ---------- */
    await evalJS(cdp, sessionId,
      `fetch('/api/agent/schedules').then(r => r.json()).then(async d => {
         for (const t of (d.data || [])) await fetch('/api/agent/schedules/' + t.id, { method: 'DELETE' });
         return 'cleared';
       })`);
    console.log("  已清理测试任务");
  } catch (e) {
    console.error("SCRIPT ERROR:", e);
    FAIL.push("script-error: " + e.message);
  } finally {
    console.log(`\n===== 结果: ${PASS.n} 通过, ${FAIL.length} 失败 =====`);
    if (FAIL.length) console.log("失败项:", FAIL.join(" | "));
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    process.exit(FAIL.length ? 1 : 0);
  }
})();
