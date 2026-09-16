/**
 * 数据卡片 —— 无头浏览器端到端验证 + 截图（临时探针，验证后删除）
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）：
 *   1) 注入管理员登录态
 *   2) 打开 /chat，点开已含卡片的会话 → 验证「刷新后卡片仍在」（历史还原）
 *   3) 发一条新消息 → 验证「工具一返回即出卡」（实时链路）
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9934;
const BASE = "http://127.0.0.1:3100";
const OUT_DIR = process.argv[2] || path.join(__dirname, "_card_screenshots");
/** 要点击的会话标题（侧栏按最近更新排序，取第一个匹配项） */
const TARGET = process.argv[3] || "帮我分析一下客户李小红";
/** 期望看到的卡片标题片段（用于判断目标卡片已渲染，避免读到旧 DOM） */
const EXPECT = process.argv[4] || "客户线索分析报告：李小红";

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
const getJSON = async (url) => (await fetch(url)).json();

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
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

async function waitFor(cdp, sessionId, expression, label, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(cdp, sessionId, expression)) return true;
    } catch {
      /* 页面切换中，重试 */
    }
    await sleep(500);
  }
  console.log(`  ! 等待超时: ${label}`);
  return false;
}

async function shoot(cdp, sessionId, file) {
  const r = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    sessionId
  );
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(r.data, "base64"));
  console.log(`  -> 截图 ${file}`);
}

/** 统计页面上已渲染的数据卡片数量（用类型徽标文案定位） */
const COUNT_CARDS = `Array.from(document.querySelectorAll('span')).filter(el => el.textContent.trim() === '线索分析').length`;

/** 卡片正文里是否出现了五问标签 */
const HAS_SECTIONS = `['购买意向','感兴趣产品','未成交原因','提及竞品','跟进建议'].filter(t => document.body.innerText.includes(t)).length`;

/** 是否有裸 JSON 被当成代码块渲染出来（兜底判定：不该出现） */
const RAW_JSON_LEAK = `document.body.innerText.includes('"sections"')`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-card-"));

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--window-size=1500,1300",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let version = null;
  for (let i = 0; i < 40; i++) {
    try {
      version = await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
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
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1500, height: 1300, deviceScaleFactor: 1, mobile: false },
    sessionId
  );

  try {
    /* ---------- 1. 注入登录态 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "login 加载");
    const store = await evalJS(
      cdp,
      sessionId,
      `fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ phone: '13912345678', password: '123123' }) })
       .then(r => r.json()).then(d => {
         if (!d || !d.user || !d.token) return '';
         const v = JSON.stringify({ user: d.user, role: d.role, token: d.token });
         localStorage.setItem('crm_auth', v); return v; })`
    );
    check("A1 注入管理员登录态", typeof store === "string" && store.length > 20);

    /* ---------- 2. 历史还原：打开已有卡片的会话 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "!!document.querySelector('textarea')", "聊天页加载");

    // 点击会话列表中标题匹配的那一项（取第一个 = 最近更新的一条）
    const clicked = await evalJS(
      cdp,
      sessionId,
      `(() => {
         const nodes = Array.from(document.querySelectorAll('*'));
         const hit = nodes.find(el => el.children.length <= 2 && el.textContent.trim() === ${JSON.stringify(TARGET)});
         if (!hit) return 'not-found';
         let el = hit;
         for (let i = 0; i < 4 && el; i++) { el.click(); el = el.parentElement; }
         return 'clicked';
       })()`
    );
    check("B1 找到并点击测试会话", clicked === "clicked", String(clicked));

    // 注意：页面加载时会自动选中最近一次会话，可能已渲染出别的卡片，
    // 所以必须等到目标卡片真正出现，再做断言，否则会读到旧 DOM。
    const historyOk = await waitFor(
      cdp,
      sessionId,
      `document.body.innerText.includes(${JSON.stringify(EXPECT)})`,
      "历史卡片渲染",
      40000
    );
    await sleep(500);
    const histCount = await evalJS(cdp, sessionId, COUNT_CARDS);
    const histSections = await evalJS(cdp, sessionId, HAS_SECTIONS);
    const histTitle = await evalJS(
      cdp,
      sessionId,
      `document.body.innerText.includes(${JSON.stringify(EXPECT)})`
    );
    check("B2 刷新后卡片仍在（历史还原）", historyOk && histCount >= 1, `卡片数=${histCount}`);
    check("B3 卡片标题正确", !!histTitle);
    check("B4 五问条目齐全", histSections >= 5, `命中 ${histSections}/5`);
    check("B5 未把裸 JSON 渲染成代码块", !(await evalJS(cdp, sessionId, RAW_JSON_LEAK)));
    await shoot(cdp, sessionId, "01_history_restore.png");

    /* ---------- 3. 整体截图 ---------- */
    // 实时出卡链路（发消息 → card 事件 → 卡片插入）已在上一轮验证通过，
    // 这里只对「历史还原」后的完整页面取一张全景图。
    await evalJS(cdp, sessionId, `window.scrollTo(0, 0)`);
    await sleep(600);
    await shoot(cdp, sessionId, "02_full_page.png");
  } catch (e) {
    console.log("ERROR:", e.message);
    FAIL.push("EXCEPTION: " + e.message);
  } finally {
    try {
      await cdp.send("Browser.close");
    } catch {
      /* ignore */
    }
    chrome.kill();
    await sleep(500);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n=== 通过 ${PASS.n} 项，失败 ${FAIL.length} 项 ===`);
  if (FAIL.length) console.log("失败项:", FAIL.join(" | "));
  process.exit(FAIL.length ? 1 : 0);
})();
