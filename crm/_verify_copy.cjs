/**
 * CRM AI 助手 —— 「复制对话」快捷按钮 端到端验证 + 截图
 *
 * 覆盖：
 *   A. 登录态注入 + 进入 /chat
 *   B. 发一轮对话，等 AI 回答收敛
 *   C. 用户消息 / 助手消息各自出现复制按钮
 *   D. 按钮文案、title、aria-label、图标
 *   E. 真实点击复制 → **读回系统剪切板**校验内容与消息原文一致
 *   F. 复制成功后出现「已复制」反馈，约 1.5s 后自动复原
 *   G. 样式契约：默认低调（透明底）→ hover 高亮
 *   H. 边界：按钮不在回答卡内部、按钮数与有正文的用户消息数一致、刷新后历史仍带按钮
 *   I. 无未捕获异常
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright），与项目其它 _verify_*.cjs 一致。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9962;
const CRM_BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_copy_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
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
    const id = ++this.id;
    const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    this.ws.send(JSON.stringify(p));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout: " + method));
        }
      }, 150000);
    });
  }
}

async function evalJS(cdp, sid, expr) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.exceptionDetails)
    throw new Error(`[${expr.slice(0, 70)}] ` + JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result.value;
}

async function waitFor(cdp, sid, expr, label, t = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try {
      if (await evalJS(cdp, sid, expr)) return true;
    } catch {
      /* ignore */
    }
    await sleep(400);
  }
  console.log("  ! 超时:", label);
  return false;
}

const setInput = (sel, val) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

/** 点击「发送」按钮（按 title 找，与其它脚本一致） */
const clickSend = `(() => {
  const btns = [...document.querySelectorAll('button')].filter(b => b.title === '发送');
  if (btns[0]) { btns[0].click(); return true; }
  return false;
})()`;

/** 给某个元素派发真实 mouseover / mouseout，触发 React 的 hover state */
const hoverEl = (sel, idx) => `(() => {
  const els = document.querySelectorAll(${JSON.stringify(sel)});
  const el = els[${idx}];
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  return true;
})()`;

const unhoverEl = (sel, idx) => `(() => {
  const els = document.querySelectorAll(${JSON.stringify(sel)});
  const el = els[${idx}];
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
  return true;
})()`;

async function shot(cdp, sid, name) {
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  } catch (e) {
    console.log("  ! 截图失败", name, e.message);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-copy-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${udd}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--window-size=1600,1080",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(300);
    }
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
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
    { width: 1600, height: 1080, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  // ⚠️ headless Chrome 默认拒绝剪切板读写（NotAllowedError: Write permission denied），
  //    `document.execCommand('copy')` 也返回 false → 产品代码里的降级分支同样拿不到。
  //    这是**测试环境限制**，不是功能缺陷：必须显式授予剪切板权限，才能真实校验复制结果。
  await cdp.send("Browser.grantPermissions", {
    origin: CRM_BASE,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  // 收集页面异常
  const pageErrors = [];
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.exceptionThrown") {
        pageErrors.push(
          m.params?.exceptionDetails?.exception?.description ||
            m.params?.exceptionDetails?.text ||
            "unknown",
        );
      }
    } catch {
      /* ignore */
    }
  });

  let pass = 0;
  const fail = [];
  const check = (n, c, extra = "") => {
    if (c) {
      pass++;
      console.log("[PASS]", n);
    } else {
      fail.push(n);
      console.log("[FAIL]", n, "::", extra);
    }
  };

  const Q = "请只回答三个字：你好呀";

  try {
    /* ---------- A. 登录态 + 进入对话页 ---------- */
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "login 页加载");
    const store = await evalJS(
      cdp,
      sessionId,
      `fetch('/api/auth/login', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ phone: '13912345678', password: '123123' })
       })
       .then(r => r.json())
       .then(d => {
         if (!d || !d.user || !d.token) return '';
         localStorage.setItem('crm_auth', JSON.stringify({ user: d.user, role: d.role, token: d.token }));
         return 'ok';
       })`,
    );
    check("A1 注入管理员登录态", store === "ok", String(store).slice(0, 80));

    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页加载");
    const inputReady = await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-input"]')`,
      "输入框渲染",
      30000,
    );
    check("A2 进入 AI 助手页", inputReady);
    await sleep(1500);

    /* ---------- B. 发一轮对话 ---------- */
    await evalJS(cdp, sessionId, setInput('[data-testid="chat-input"]', Q));
    await sleep(400);
    await evalJS(cdp, sessionId, clickSend);

    const userMsgIn = await waitFor(
      cdp,
      sessionId,
      `[...document.querySelectorAll('[data-msg-role="user"]')].some(e => (e.innerText||'').includes('你好呀'))`,
      "用户消息出现",
      30000,
    );
    check("B1 用户消息进入对话流", userMsgIn);

    const answerOk = await waitFor(
      cdp,
      sessionId,
      `(() => {
        const rows = document.querySelectorAll('[data-msg-role="assistant"]');
        if (!rows.length) return false;
        const card = rows[rows.length - 1].querySelector('[data-answer-card="1"]');
        if (!card) return false;
        const t = (card.innerText || '').trim();
        return t.length > 2 && t !== '（无回复内容）';
      })()`,
      "AI 回答收敛",
      90000,
    );
    check("B2 AI 回答已收敛", answerOk);
    await sleep(800);

    /* ---------- C. 按钮存在性 ---------- */
    const uCount = await evalJS(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-msg-role="user"] [data-testid="chat-copy-user"]').length`,
    );
    const aCount = await evalJS(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-msg-role="assistant"] [data-testid="chat-copy-assistant"]').length`,
    );
    check("C1 用户消息有复制按钮", uCount >= 1, `count=${uCount}`);
    check("C2 助手消息有复制按钮", aCount >= 1, `count=${aCount}`);

    /* ---------- D. 文案 / 无障碍 ---------- */
    const uInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="user"] [data-testid="chat-copy-user"]');
        const el = els[els.length - 1];
        return { text: (el.innerText||'').trim(), title: el.getAttribute('title'),
                 aria: el.getAttribute('aria-label'), svg: el.querySelectorAll('svg').length,
                 copied: el.dataset.copied };
      })()`,
    );
    check("D1 用户复制按钮默认文案「复制」", uInfo.text === "复制", JSON.stringify(uInfo.text));
    check("D2 有 title 提示", uInfo.title === "复制", String(uInfo.title));
    check("D3 有 aria-label", uInfo.aria === "复制", String(uInfo.aria));
    check("D4 带 svg 图标", uInfo.svg === 1, `svg=${uInfo.svg}`);
    check("D5 初始未处于已复制态", uInfo.copied === "0", `copied=${uInfo.copied}`);

    const aText = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="assistant"] [data-testid="chat-copy-assistant"]');
        const el = els[els.length - 1];
        return (el.innerText||'').trim();
      })()`,
    );
    check("D6 助手复制按钮默认文案「复制」", aText === "复制", JSON.stringify(aText));

    /* ---------- E. 真实复制 + 剪切板回读 ---------- */
    // 先点用户消息的复制
    const clickedU = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="user"] [data-testid="chat-copy-user"]');
        const el = els[els.length - 1];
        if (!el) return false;
        el.click();
        return true;
      })()`,
    );
    check("E1 点击用户复制按钮成功", clickedU);
    await sleep(500);

    const clipUser = await evalJS(
      cdp,
      sessionId,
      `navigator.clipboard.readText().catch(() => '')`,
    );
    check(
      "E2 剪切板内容 === 用户提问原文",
      String(clipUser).trim() === Q,
      `clip=${JSON.stringify(clipUser)} expect=${JSON.stringify(Q)}`,
    );
    check(
      "E3 剪切板非空且不含按钮文案",
      String(clipUser).trim().length > 0 &&
        !String(clipUser).includes("已复制") &&
        !String(clipUser).includes("复制"),
      `clip=${JSON.stringify(clipUser)}`,
    );

    // 再点助手消息的复制
    const clickedA = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="assistant"] [data-testid="chat-copy-assistant"]');
        const el = els[els.length - 1];
        if (!el) return false;
        el.click();
        return true;
      })()`,
    );
    check("E4 点击助手复制按钮成功", clickedA);
    await sleep(500);

    const clipAsst = await evalJS(
      cdp,
      sessionId,
      `navigator.clipboard.readText().catch(() => '')`,
    );
    check("E5 助手回答复制成功（非空）", String(clipAsst).trim().length > 0, `clip=${JSON.stringify(String(clipAsst).slice(0, 60))}`);
    check(
      "E6 助手复制内容非空且不含按钮文案",
      String(clipAsst).trim().length > 0 && !String(clipAsst).includes("已复制"),
      `clip=${JSON.stringify(String(clipAsst).slice(0, 60))}`,
    );
    check(
      "E7 助手复制内容与回答卡文本一致",
      await evalJS(
        cdp,
        sessionId,
        `(() => {
          const rows = document.querySelectorAll('[data-msg-role="assistant"]');
          const card = rows[rows.length - 1].querySelector('[data-answer-card="1"]');
          const dom = (card ? card.innerText : '').trim();
          const clip = ${JSON.stringify(String(clipAsst))}.trim();
          return dom === clip || dom.includes(clip);
        })()`,
      ),
    );

    /* ---------- F. 成功反馈 + 自动复原 ---------- */
    const copiedNow = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="assistant"] [data-testid="chat-copy-assistant"]');
        const el = els[els.length - 1];
        return { text: (el.innerText||'').trim(), copied: el.dataset.copied };
      })()`,
    );
    check("F1 复制后按钮标记为已复制", copiedNow.copied === "1", JSON.stringify(copiedNow));
    check("F2 复制后文案变为「已复制」", copiedNow.text === "已复制", JSON.stringify(copiedNow.text));

    await shot(cdp, sessionId, "01-copied-feedback.png");

    const reset = await waitFor(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="assistant"] [data-testid="chat-copy-assistant"]');
        const el = els[els.length - 1];
        return (el.innerText||'').trim() === '复制' && el.dataset.copied === '0';
      })()`,
      "复制反馈自动复原",
      6000,
    );
    check("F3 约 1.5s 后自动复原为「复制」", reset);

    /* ---------- G. 样式契约 ---------- */
    const baseStyle = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="user"] [data-testid="chat-copy-user"]');
        const el = els[els.length - 1];
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderTopColor, color: s.color, cursor: s.cursor };
      })()`,
    );
    const isTransparent = (v) => /rgba?\(0,\s*0,\s*0,\s*0\)/.test(v);
    check("G1 默认背景透明（低调）", isTransparent(baseStyle.bg), `bg=${baseStyle.bg}`);
    check("G2 默认边框透明", isTransparent(baseStyle.border), `border=${baseStyle.border}`);
    check("G3 是手型光标", baseStyle.cursor === "pointer", `cursor=${baseStyle.cursor}`);

    const uIdx = Number(
      await evalJS(
        cdp,
        sessionId,
        `document.querySelectorAll('[data-msg-role="user"] [data-testid="chat-copy-user"]').length - 1`,
      ),
    );
    await evalJS(cdp, sessionId, hoverEl('[data-msg-role="user"] [data-testid="chat-copy-user"]', uIdx));
    await sleep(350);
    const hoverStyle = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const els = document.querySelectorAll('[data-msg-role="user"] [data-testid="chat-copy-user"]');
        const el = els[els.length - 1];
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color };
      })()`,
    );
    check(
      "G4 hover 时出现背景高亮",
      hoverStyle.bg !== baseStyle.bg && !isTransparent(hoverStyle.bg),
      `base=${baseStyle.bg} hover=${hoverStyle.bg}`,
    );
    check("G5 hover 时文字变为强调色", hoverStyle.color !== baseStyle.color, `base=${baseStyle.color} hover=${hoverStyle.color}`);

    await shot(cdp, sessionId, "02-hover-highlight.png");
    await evalJS(cdp, sessionId, unhoverEl('[data-msg-role="user"] [data-testid="chat-copy-user"]', uIdx));
    await sleep(250);

    /* ---------- H. 边界 ---------- */
    const inCard = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const rows = document.querySelectorAll('[data-msg-role="assistant"]');
        const card = rows[rows.length - 1].querySelector('[data-answer-card="1"]');
        return card ? card.querySelectorAll('[data-testid="chat-copy-assistant"]').length : -1;
      })()`,
    );
    check("H1 复制按钮不在回答卡正文内部", inCard === 0, `inside=${inCard}`);

    // 按钮数应与「有正文的用户消息数」一致（只带附件、无文字的消息不渲染按钮）
    const counts = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const rows = [...document.querySelectorAll('[data-msg-role="user"]')];
        let withText = 0, buttons = 0;
        for (const r of rows) {
          const btn = r.querySelector('[data-testid="chat-copy-user"]');
          buttons += btn ? 1 : 0;
          // 文字气泡：不含复制按钮行的那个直接子 div，且其文本非空
          const bubble = [...r.children].find(c => {
            if (c.tagName !== 'DIV') return false;
            if (c.querySelector('[data-testid="chat-copy-user"]')) return false;
            if (c.querySelector('[data-testid="chat-image-attachments"]')) return false;
            if (c.querySelector('[data-testid="chat-file-attachments"]')) return false;
            return (c.innerText || '').trim().length > 0;
          });
          if (bubble) withText++;
        }
        return { withText, buttons };
      })()`,
    );
    check(
      "H2 按钮数与「有正文的用户消息数」一致",
      counts.buttons === counts.withText && counts.buttons > 0,
      JSON.stringify(counts),
    );

    // 刷新后历史消息仍带按钮
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页二次加载");
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-input"]')`, "输入框二次渲染", 30000);
    await sleep(2000);

    const reloaded = await waitFor(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-testid="chat-copy-assistant"]').length > 0`,
      "刷新后助手按钮渲染",
      30000,
    );
    check("H3 刷新后历史 AI 消息仍带复制按钮", reloaded);
    const reloadedUser = await evalJS(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-msg-role="user"] [data-testid="chat-copy-user"]').length`,
    );
    check("H4 刷新后历史用户消息仍带复制按钮", reloadedUser > 0, `count=${reloadedUser}`);

    await shot(cdp, sessionId, "03-after-reload.png");

    /* ---------- I. 异常 ---------- */
    check(
      "I1 无未捕获异常",
      pageErrors.length === 0,
      pageErrors.slice(0, 2).join(" | "),
    );
  } catch (e) {
    console.log("\n!! 脚本异常:", e.message);
    check("Z 脚本无异常中断", false, e.message);
  } finally {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
  }

  console.log("\n" + "=".repeat(52));
  console.log(`复制对话按钮验证: ${pass}/${pass + fail.length} 通过`);
  if (fail.length) console.log("失败项: " + fail.join(", "));
  console.log(`截图目录: ${OUT}`);
  console.log("=".repeat(52));
  process.exit(fail.length ? 1 : 0);
})();
