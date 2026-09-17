/**
 * 任务清单（write_todos）面板 —— 无头浏览器端到端验证 + 截图
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）：
 *   1) 启动无头 Chrome（独立 user-data-dir）
 *   2) 打开 /login，调 /api/auth/login 注入管理员登录态到 localStorage
 *   3) 新建一个专用会话并切过去（避免历史数据干扰断言）
 *   4) 发一个「三步」复杂任务，断言面板：
 *      出现在**最后一条 AI 回答气泡内部**、接在回答正文下方、不脱离消息滚动区
 *      → 执行中自动展开 → 结束后自动收起为一行 → 可手动再次展开 → 全部项 done
 *   5) 断言清单已随消息落库，刷新页面后仍能还原（默认收起）
 *   6) 截图供人工复核
 *
 * 跑完自动清理：删除本次测试新建的会话。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9934;
const BASE = "http://127.0.0.1:3100";
const OUT_DIR = process.argv[2] || path.join(__dirname, "_todo_screenshots");

/** 管理员账号（见项目 MEMORY） */
const ADMIN = { phone: "13912345678", password: "123123" };

/** 本次测试专用会话标题：用来在会话列表里认领自己的会话 */
const TITLE = `E2E-todo-${Date.now()}`;

/** 触发 write_todos 的多步任务：只读、不写文件，保证能顺利跑完 */
const PROMPT =
  "帮我做一次销售数据体检，请分三步执行：第一步统计销售线索的总数和各状态的数量分布；" +
  "第二步统计订单的总金额，并找出金额最高的 3 个订单；第三步结合前两步的结果给出 2 条改进建议。";

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

/** 极简 CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        this.events.push(msg);
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

async function waitFor(cdp, sessionId, expression, label, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(cdp, sessionId, expression)) return true;
    } catch {
      /* 页面切换中，重试 */
    }
    await sleep(400);
  }
  console.log(`  ! 等待超时: ${label}`);
  return false;
}

async function shoot(cdp, sessionId, file) {
  const r = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    sessionId
  );
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(r.data, "base64"));
  console.log(`  -> 截图 ${file}`);
}

/* ---------------- 页面内使用的断言片段 ---------------- */

/** 助手气泡里的清单面板集合（取最后一个 = 本轮刚产生的那条回答） */
const PANELS = `document.querySelectorAll('[data-msg-role="assistant"] [data-testid="todo-panel"]')`;
const Q = `${PANELS}[${PANELS}.length - 1]`;

const SNAP = `(() => {
  const p = ${Q};
  const card = p ? p.closest('[data-answer-card="1"]') : null;
  const msg = p ? p.closest('[data-msg-role="assistant"]') : null;
  const ta = document.querySelector('[data-testid="chat-input"]');
  const btn = document.querySelector('button[title="发送"], button[title="停止生成"]');
  const r = p ? p.getBoundingClientRect() : null;
  const cr = card ? card.getBoundingClientRect() : null;
  const composer = ta ? ta.getBoundingClientRect() : null;
  // 卡片里的正文元素（面板之外的另一个子节点；面板若被放错到正文之前，这里就能抓到）
  const body = card ? Array.from(card.children).find(c => c !== p) : null;
  const bodyBottom = body ? Math.round(body.getBoundingClientRect().bottom) : -1;
  const assistantMsgs = document.querySelectorAll('[data-msg-role="assistant"]');
  const lastMsg = assistantMsgs.length ? assistantMsgs[assistantMsgs.length - 1] : null;
  // 面板是否处于可滚动祖先（消息区）内部 —— 证明它随消息滚动，而不是 fixed
  let insideScroller = false;
  for (let el = p ? p.parentElement : null; el; el = el.parentElement) {
    const st = getComputedStyle(el);
    if (st.overflowY === 'auto' || st.overflowY === 'scroll') { insideScroller = true; break; }
  }
  return {
    panelCount: document.querySelectorAll('[data-testid="todo-panel"]').length,
    exists: !!p,
    inAssistantMsg: !!msg,
    inLastAssistantMsg: !!(lastMsg && p && lastMsg.contains(p)),
    inCard: !!card,
    position: p ? getComputedStyle(p).position : null,
    insideScroller,
    collapsed: p ? p.getAttribute('data-collapsed') : null,
    count: p ? Number(p.getAttribute('data-todo-count')) : 0,
    done: p ? Number(p.getAttribute('data-todo-done')) : 0,
    statuses: p ? Array.from(p.querySelectorAll('[data-todo-status]')).map(e => e.getAttribute('data-todo-status')) : [],
    texts: p ? Array.from(p.querySelectorAll('[data-todo-status]')).map(e => e.textContent.trim()) : [],
    height: r ? Math.round(r.height) : 0,
    top: r ? Math.round(r.top) : 0,
    bottom: r ? Math.round(r.bottom) : 0,
    cardTop: cr ? Math.round(cr.top) : -1,
    cardBottom: cr ? Math.round(cr.bottom) : -1,
    bodyBottom,
    insideCardBottom: r && cr ? Math.round(cr.bottom - r.bottom) >= -1 : false,
    composerTop: composer ? Math.round(composer.top) : -1,
    viewportH: window.innerHeight,
    sendTitle: btn ? btn.getAttribute('title') : null,
  };
})()`;

/**
 * 激活指定标题的会话（首次可能未渲染完，反复尝试点击）。
 * 注意：首条消息发出后服务端会把会话标题自动改成提问前 30 字，
 * 所以刷新后的标题要用接口重新取一次，不能沿用创建时的 TITLE。
 */
const activateExpr = (title) => `(() => {
  const header = document.querySelector('header');
  if (header && header.textContent.includes(${JSON.stringify(title)})) return true;
  const item = Array.from(document.querySelectorAll('[data-session-item="true"]'))
    .find(i => i.textContent.includes(${JSON.stringify(title)}));
  if (item) item.click();
  return false;
})()`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-todo-"));

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
      "--window-size=1600,1000",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  // 等 DevTools 端点就绪
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const j = await res.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  if (!wsUrl) {
    console.log("[FATAL] Chrome DevTools 未就绪");
    chrome.kill();
    process.exit(1);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  const cleanupSessions = [];
  let snapA = null;

  try {
    /* ---------- 1. 登录 ---------- */
    console.log("\n=== 1. 登录 ===");
    await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "!!document.querySelector('input[placeholder=\"请输入手机号\"]')", "登录页渲染");

    const before = await evalJS(
      cdp,
      sessionId,
      `fetch('/api/agent/sessions', { cache: 'no-store' }).then(r => r.json()).then(d => (d || []).map(s => s.id))`
    );

    const loginRes = await evalJS(
      cdp,
      sessionId,
      `(async () => {
        const r = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: ${JSON.stringify(ADMIN.phone)}, password: ${JSON.stringify(ADMIN.password)} }),
        });
        const d = await r.json();
        if (!r.ok) return { ok: false, error: d.error || String(r.status) };
        localStorage.setItem('crm_auth', JSON.stringify({ user: d.user, role: d.role, token: d.token }));
        return { ok: true, role: d.role && d.role.name };
      })()`
    );
    check("管理员登录成功并写入登录态", loginRes && loginRes.ok === true, JSON.stringify(loginRes));
    if (!loginRes || !loginRes.ok) throw new Error("登录失败，后续步骤无法进行");

    /* ---------- 2. 新建专用会话并进入对话页 ---------- */
    console.log("\n=== 2. 新建专用会话并进入对话页 ===");
    const created = await evalJS(
      cdp,
      sessionId,
      `(async () => {
        const r = await fetch('/api/agent/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: ${JSON.stringify(TITLE)} }),
        });
        const d = await r.json();
        return r.ok ? { ok: true, id: d.id } : { ok: false, error: String(r.status) };
      })()`
    );
    check("已创建专用测试会话", created && created.ok === true, JSON.stringify(created));
    if (!created || !created.ok) throw new Error("创建会话失败，后续步骤无法进行");
    const sessionUnderTest = created.id;

    await cdp.send("Page.navigate", { url: `${BASE}/chat` }, sessionId);
    const composerReady = await waitFor(
      cdp,
      sessionId,
      "!!document.querySelector('[data-testid=\"chat-input\"]')",
      "输入框渲染",
      30000
    );
    check("对话页加载出输入框", composerReady);

    const activated = await waitFor(cdp, sessionId, activateExpr(TITLE), "切到专用测试会话", 30000);
    check("已切到专用测试会话（顶栏标题匹配）", activated);

    const snap0 = await evalJS(cdp, sessionId, SNAP);
    check("全新会话里还没有任何任务清单面板", snap0.panelCount === 0, JSON.stringify(snap0));

    /* ---------- 3. 发送多步任务 ---------- */
    console.log("\n=== 3. 发送多步任务 ===");
    const setAndSend = `(() => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(PROMPT)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('button[title="发送"]');
      if (!btn) return 'no-send-button';
      btn.click();
      return 'sent';
    })()`;
    const sendResult = await evalJS(cdp, sessionId, setAndSend);
    check("任务已发送", sendResult === "sent", String(sendResult));

    /* ---------- 4. 面板出现（且在回答气泡里） ---------- */
    console.log("\n=== 4. 等待任务清单面板出现 ===");
    const appeared = await waitFor(
      cdp,
      sessionId,
      `!!${Q} && ${Q}.getAttribute('data-todo-count') !== '0'`,
      "todo-panel 出现",
      300000
    );
    check("任务清单面板已显示", appeared);

    if (appeared) {
      snapA = await evalJS(cdp, sessionId, SNAP);
      console.log(`  面板快照: ${JSON.stringify({ count: snapA.count, statuses: snapA.statuses, collapsed: snapA.collapsed, height: snapA.height })}`);

      /* --- 位置：嵌在最后一条 AI 回答气泡内部 --- */
      check("面板挂在最后一条 AI 回答消息里", snapA.inLastAssistantMsg === true, JSON.stringify({ inAssistantMsg: snapA.inAssistantMsg, inLast: snapA.inLastAssistantMsg }));
      check("面板嵌在回答白卡内部", snapA.inCard === true);
      check(
        "面板位于回答白卡之内（不超出卡片底部）",
        snapA.insideCardBottom === true,
        `cardBottom=${snapA.cardBottom} panelBottom=${snapA.bottom}`
      );
      check(
        "面板接在回答正文下方",
        snapA.bodyBottom >= 0 && snapA.bodyBottom <= snapA.top + 2,
        `bodyBottom=${snapA.bodyBottom} panelTop=${snapA.top}`
      );
      check(
        "面板在消息滚动区内部、且不是 fixed 定位（随消息滚动）",
        snapA.insideScroller === true && snapA.position !== "fixed",
        `insideScroller=${snapA.insideScroller} position=${snapA.position}`
      );

      /* --- 交互：自动展开 --- */
      check("面板展示了待办项", snapA.count > 0, `count=${snapA.count}`);
      check("执行过程中面板自动展开（collapsed=0）", snapA.collapsed === "0", `collapsed=${snapA.collapsed}`);
      check("展开态有实际高度（>70px）", snapA.height > 70, `height=${snapA.height}`);
      check(
        "执行中出现 in_progress 项",
        snapA.statuses.includes("in_progress"),
        JSON.stringify(snapA.statuses)
      );

      await shoot(cdp, sessionId, "01-todo-expanded.png");

      /* ---------- 5. 等执行结束：自动收起 ---------- */
      console.log("\n=== 5. 等待执行结束 ===");
      const finished = await waitFor(
        cdp,
        sessionId,
        `(() => { const p = ${Q}; return !!p && p.getAttribute('data-collapsed') === '1'; })()`,
        "面板自动收起",
        300000
      );
      check("执行结束后面板自动收起为一行（collapsed=1）", finished);

      // 等发送按钮回到「发送」态，确保整轮真的结束
      const idle = await waitFor(
        cdp,
        sessionId,
        "!!document.querySelector('button[title=\"发送\"]')",
        "本轮执行结束",
        120000
      );
      check("本轮执行已结束", idle);

      // 收起 / 展开都带过渡动画，等动画结束再量高度，否则量到中间态
      await sleep(800);

      const snapB = await evalJS(cdp, sessionId, SNAP);
      console.log(`  收起后快照: ${JSON.stringify({ count: snapB.count, done: snapB.done, collapsed: snapB.collapsed, height: snapB.height })}`);
      check("收起后面板仍然显示（未消失）", snapB.exists === true);
      check("收起后高度降到一行（< 50px）", snapB.height > 0 && snapB.height < 50, `height=${snapB.height}`);
      check("收起后高度明显小于展开态", snapB.height < snapA.height, `${snapB.height} < ${snapA.height}`);
      check("清单项全部完成", snapB.done === snapB.count && snapB.count > 0, `done=${snapB.done} count=${snapB.count}`);
      check("收起后仍留在回答白卡内部", snapB.inCard === true && snapB.insideCardBottom === true);

      await shoot(cdp, sessionId, "02-todo-collapsed.png");

      /* ---------- 6. 手动展开 ---------- */
      const clickToggle = `(() => {
        const p = ${Q};
        if (!p) return 'no-panel';
        const btn = p.querySelector('button');
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked';
      })()`;
      const clickRes = await evalJS(cdp, sessionId, clickToggle);
      check("面板标题栏可点击", clickRes === "clicked", String(clickRes));
      const reopened = await waitFor(
        cdp,
        sessionId,
        `(() => { const p = ${Q}; return !!p && p.getAttribute('data-collapsed') === '0'; })()`,
        "手动展开",
        8000
      );
      check("手动点击后重新展开（collapsed=0）", reopened);
      await sleep(800);
      const snapC = await evalJS(cdp, sessionId, SNAP);
      check("手动展开后高度恢复", snapC.height > 70, `height=${snapC.height}`);
      await shoot(cdp, sessionId, "03-todo-manual-expand.png");

      // 折叠回去，保持界面整洁
      await evalJS(cdp, sessionId, clickToggle);
      await sleep(500);

      /* ---------- 7. 落库 & 刷新还原 ---------- */
      console.log("\n=== 7. 校验落库与刷新还原 ===");
      const stored = await evalJS(
        cdp,
        sessionId,
        `fetch('/api/agent/sessions/${sessionUnderTest}/messages', { cache: 'no-store' })
           .then(r => r.json())
           .then(d => (d || []).filter(m => m.role === 'assistant' && (m.todos || []).length > 0)
             .map(m => ({ n: m.todos.length, done: m.todos.filter(t => t.status === 'completed').length, first: m.todos[0].content })))`
      );
      check(
        "清单已随助手消息落库（接口能读到）",
        Array.isArray(stored) && stored.length === 1 && stored[0].n === snapA.count && stored[0].done === stored[0].n,
        JSON.stringify(stored)
      );

      await cdp.send("Page.navigate", { url: `${BASE}/chat` }, sessionId);
      await waitFor(cdp, sessionId, "!!document.querySelector('[data-testid=\"chat-input\"]')", "刷新后输入框", 30000);
      // 首条消息后标题被服务端改写，重新取一次真实标题来定位会话
      const finalTitle = await evalJS(
        cdp,
        sessionId,
        `fetch('/api/agent/sessions', { cache: 'no-store' })
           .then(r => r.json())
           .then(d => { const s = (d || []).find(x => x.id === ${JSON.stringify(sessionUnderTest)}); return s ? s.title : null; })`
      );
      check("会话标题已被首条提问自动改写", !!finalTitle && finalTitle !== TITLE, `title=${finalTitle}`);
      const reActivated = await waitFor(cdp, sessionId, activateExpr(finalTitle || TITLE), "刷新后切回测试会话", 30000);
      check("刷新后仍停在测试会话", reActivated);
      const restored = await waitFor(cdp, sessionId, `!!${Q}`, "刷新后清单还原", 30000);
      check("刷新页面后清单从库里还原（仍在回答气泡内）", restored);

      if (restored) {
        await sleep(400);
        const snapD = await evalJS(cdp, sessionId, SNAP);
        check("还原的清单项数与落库一致", snapD.count === snapA.count, `restored=${snapD.count} original=${snapA.count}`);
        check("还原后默认收起为一行", snapD.collapsed === "1", `collapsed=${snapD.collapsed}`);
        check("还原后仍嵌在回答白卡内部", snapD.inCard === true && snapD.inLastAssistantMsg === true);
        await shoot(cdp, sessionId, "04-todo-restored-after-reload.png");
      }
    }

    /* ---------- 8. 清理 ---------- */
    const after = await evalJS(
      cdp,
      sessionId,
      `fetch('/api/agent/sessions', { cache: 'no-store' }).then(r => r.json()).then(d => (d || []).map(s => s.id))`
    );
    const leaked = (after || []).filter((id) => !(before || []).includes(id));
    cleanupSessions.push(...leaked);
  } catch (e) {
    console.log(`\n[ERROR] ${e && e.message ? e.message : e}`);
    FAIL.push(`运行异常: ${e && e.message ? e.message : e}`);
  } finally {
    // 删除本次新建的会话
    for (const id of cleanupSessions) {
      try {
        await evalJS(
          cdp,
          sessionId,
          `fetch('/api/agent/sessions/${id}', { method: 'DELETE' }).then(r => r.status)`
        );
        console.log(`  (已清理测试会话 ${id})`);
      } catch {
        console.log(`  ! 清理会话失败 ${id}`);
      }
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
  }

  console.log(`\n================ 结果 ================`);
  console.log(`PASS: ${PASS.n}    FAIL: ${FAIL.length}`);
  if (FAIL.length) {
    console.log("失败项：");
    FAIL.forEach((f) => console.log(`  - ${f}`));
  }
  console.log(`截图目录: ${OUT_DIR}`);
  process.exit(FAIL.length ? 1 : 0);
})();
