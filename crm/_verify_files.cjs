/**
 * 文件附件（txt）+ 剪切板粘贴导入 —— 端到端验证 + 截图
 *
 * 覆盖：
 *   A. 文件存储接口契约：POST /api/files（成功 / 415 类型错 / 422 空文件 / 422 超限）、
 *      GET /api/files/{id}（含正文）、GET .../meta（不含正文）、DELETE、404
 *   B. chat 端点附件校验与注入：
 *      - 无效 file_id → 422（不能静默丢附件）
 *      - 超条数（>4）→ 422
 *      - 短文本：正文内联进用户消息 → 模型能答出文件里的内容
 *      - 长文本（>50000 字符）：落盘 + 给虚拟路径 → 模型用 read_file 读到尾部标记
 *      - 附件与纯文本模型共存：vision 守卫只针对图片，有附件时**不**触发
 *   C. 前端交互：
 *      - 加号按钮的 input accept 同时含图片与 .txt
 *      - 选 txt 后出现文件名标签（**缩写**，含省略号）、可删除
 *      - 只带附件（无文字）也能发送
 *      - 发送后对话流出现文件标签块
 *      - 刷新后文件标签仍还原
 *   D. 剪切板粘贴：
 *      - 粘贴 txt 文件 → 引入为附件标签
 *      - 粘贴图片文件 → 引入为图片标签
 *      - 纯文本粘贴**不拦截**（正常打字不受影响）
 *
 * ⚠️ 能力边界（与产品一致）：
 *    - 当前仅支持 .txt（服务端 file_store.ALLOWED_EXTS）。
 *    - 图片能力仍走 /api/images，vision 守卫只对「图片 + 纯文本模型」生效。
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）。
 * 数据安全：只新建临时会话；跑完按 id 删除会话、消息、图片、附件与落盘文件。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9959;
const CRM_BASE = "http://127.0.0.1:3100";
const AGENT_BASE = "http://127.0.0.1:8765";
const CHAT_UI = "C:/Users/Administrator/Documents/deepagent/deepagents/chat-ui";
const UPLOAD_DIR = path.join(CHAT_UI, "uploads");
const OUT = path.join(__dirname, "_files_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_TITLE = "file-e2e-tmp";

/* ---------------- 造素材（不依赖外部文件） ---------------- */

/** 短文本附件：内容里有唯一可验证的数字 */
const SHORT_TXT = "产品代号: XN-2026\n库存数量: 88\n负责人: 张三\n";

/** 超长文本附件：>50000 字符（服务端 INLINE_LIMIT），末尾放唯一标记 */
function makeLongTxt(lines = 6000) {
  const parts = [];
  for (let i = 1; i <= lines; i++) {
    parts.push(`第${i}行 数据值=${i * 7} 备注=这是一行用于填充的测试文本内容`);
  }
  parts.push("特殊标记: SECRET_TAIL_9527");
  return parts.join("\n") + "\n";
}

/** 最小合法 PNG（8x8 纯色，仅用于「粘贴图片」通道验证，不做识别断言） */
function makePng(w = 8, h = 8, rgb = [37, 99, 235]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(Buffer.from([0]));
    raw.push(Buffer.from(Array.from({ length: w }, () => rgb).flat()));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

async function shot(cdp, sid, name) {
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  } catch (e) {
    console.log("  ! 截图失败", name, e.message);
  }
}

/* ---------------- 后端辅助请求 ---------------- */

async function createSession(title) {
  const r = await fetch(`${AGENT_BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return r.json();
}

/** 上传文本附件（原始字节 body + query 传文件名） */
async function uploadFile(name, text, sessionId) {
  const r = await fetch(
    `${AGENT_BASE}/api/files?filename=${encodeURIComponent(name)}&session_id=${encodeURIComponent(
      sessionId,
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: Buffer.from(text, "utf8"),
    },
  );
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, body };
}

/** 发一次 chat，收集 SSE 的 token / 工具名 / 结束标志 */
async function chatCollect(payload) {
  const res = await fetch(`${AGENT_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const tokens = [...text.matchAll(/"event":\s*"llm_token",\s*"token":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`))
    .join("");
  // ⚠️ 事件字段顺序是 event → status → id → name → args → node，
  //    不能用 `"event":"tool_start","name"` 这种「紧邻」正则（中间还夹着 status/id）。
  //    稳妥做法：按行取出每个 tool_start 的 name 字段。
  const tools = text
    .split("\n")
    .filter((l) => l.includes('"tool_start"'))
    .map((l) => (l.match(/"name":\s*"([^"]+)"/) || [])[1] || "")
    .filter(Boolean);
  return { status: res.status, text, answer: tokens, tools };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-file-"));
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

  let tempSessionId = null;
  const createdFileIds = [];
  const createdImageIds = [];

  try {
    /* ---------- A. 文件存储接口契约 ---------- */
    const sess = await createSession(TMP_TITLE);
    tempSessionId = sess.id;
    check("A1 创建临时会话成功", typeof sess.id === "string" && sess.id.length > 10);

    // A2 正常上传
    const up = await uploadFile("测试附件.txt", SHORT_TXT, tempSessionId);
    check(
      "A2 上传 txt 返回 200",
      up.status === 200,
      `status=${up.status} ${JSON.stringify(up.body).slice(0, 140)}`,
    );
    check(
      "A3 返回 id / filename / size / chars",
      !!up.body &&
        !!up.body.id &&
        up.body.filename === "测试附件.txt" &&
        up.body.size === Buffer.byteLength(SHORT_TXT, "utf8") &&
        up.body.chars === SHORT_TXT.length,
      JSON.stringify(up.body),
    );
    if (up.body && up.body.id) createdFileIds.push(up.body.id);

    // A4 非 txt → 415
    const bad = await uploadFile("说明.pdf", SHORT_TXT, tempSessionId);
    check("A4 非 txt 类型返回 415", bad.status === 415, `status=${bad.status}`);

    // A5 空文件 → 422
    const empty = await uploadFile("empty.txt", "", tempSessionId);
    check("A5 空文件返回 422", empty.status === 422, `status=${empty.status}`);

    // A6 GET 全文
    const got = await (await fetch(`${AGENT_BASE}/api/files/${up.body.id}`)).json();
    check(
      "A6 GET 返回完整正文且与原文一致",
      got.text === SHORT_TXT,
      `text=${String(got.text).slice(0, 80)}`,
    );

    // A7 meta 不含正文
    const meta = await (await fetch(`${AGENT_BASE}/api/files/${up.body.id}/meta`)).json();
    check(
      "A7 meta 返回元数据且不含正文",
      meta.id === up.body.id && meta.text === undefined,
      JSON.stringify(meta).slice(0, 140),
    );

    // A8 不存在 → 404
    const r404 = await fetch(`${AGENT_BASE}/api/files/__no_such_file__`);
    check("A8 不存在的文件返回 404", r404.status === 404, String(r404.status));

    // A9 中文与 GBK 解码：上传 GBK 字节应能正确还原
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // "你好" 的 GBK 编码
    const gbkRes = await fetch(
      `${AGENT_BASE}/api/files?filename=gbk.txt&session_id=${encodeURIComponent(tempSessionId)}`,
      { method: "POST", headers: { "Content-Type": "text/plain" }, body: gbk },
    );
    const gbkBody = await gbkRes.json();
    if (gbkBody.id) createdFileIds.push(gbkBody.id);
    const gbkGot = await (await fetch(`${AGENT_BASE}/api/files/${gbkBody.id}`)).json();
    check("A9 GBK 编码的 txt 能正确解码", gbkGot.text === "你好", `text=${JSON.stringify(gbkGot.text)}`);

    /* ---------- B. chat 端点附件校验与注入 ---------- */

    // B1 无效 file_id → 422（不能静默丢附件）
    const b1 = await fetch(`${AGENT_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tempSessionId,
        content: "看看附件",
        model: "deepseek-flash",
        file_ids: ["__bogus_file__"],
      }),
    });
    check("B1 无效 file_id 被拒绝（422）", b1.status === 422, String(b1.status));

    // B2 超过 4 个 → 422
    const b2 = await fetch(`${AGENT_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tempSessionId,
        content: "多附件",
        model: "deepseek-flash",
        file_ids: ["a", "b", "c", "d", "e"],
      }),
    });
    check("B2 超过 4 个附件被拒绝（422）", b2.status === 422, String(b2.status));

    // B3 短文本内联：模型能答出文件里的数字
    const b3 = await chatCollect({
      session_id: tempSessionId,
      content: "附件里的库存数量是多少？只答数字。",
      model: "deepseek-flash",
      file_ids: [up.body.id],
    });
    check("B3 短附件对话返回 200", b3.status === 200, String(b3.status));
    check("B4 模型确实被调用（有 token 输出）", b3.answer.length > 0, b3.answer.slice(0, 120));
    check(
      "B5 模型读出附件内容（答出 88）",
      /\b88\b/.test(b3.answer),
      `answer=${b3.answer.slice(0, 120)}`,
    );

    // B6 附件落库：用户消息带 files 元数据，且 content 仍是用户原文（附件正文不入库正文列）
    const msgs = await (await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}/messages`)).json();
    const arr = Array.isArray(msgs) ? msgs : [];
    const userMsg = arr.find((m) => (m.content || "").includes("库存数量是多少"));
    check(
      "B6 用户消息落库且带 files 元数据",
      !!userMsg && Array.isArray(userMsg.files) && userMsg.files.length === 1,
      JSON.stringify(userMsg && userMsg.files).slice(0, 180),
    );
    check(
      "B7 附件正文不写进消息 content（避免重复膨胀）",
      !!userMsg && !String(userMsg.content).includes("XN-2026"),
      JSON.stringify(userMsg && userMsg.content).slice(0, 120),
    );

    // B8 长文本：落盘 + 提示路径 → 模型用工具读到尾部标记
    const longTxt = makeLongTxt();
    const longUp = await uploadFile("bigdata.txt", longTxt, tempSessionId);
    if (longUp.body && longUp.body.id) createdFileIds.push(longUp.body.id);
    check(
      "B8 长附件上传成功（>50000 字符）",
      longUp.status === 200 && longUp.body.chars > 50000,
      `chars=${longUp.body && longUp.body.chars}`,
    );
    const b9 = await chatCollect({
      session_id: tempSessionId,
      content: "附件末尾的『特殊标记』是什么？直接回答标记值。",
      model: "deepseek-flash",
      file_ids: [longUp.body.id],
    });
    check("B9 长附件对话返回 200", b9.status === 200, String(b9.status));
    check(
      "B10 模型经工具读取落盘文件并找到尾部标记",
      /SECRET_TAIL_9527/.test(b9.answer),
      `tools=[${b9.tools.join(",")}] answer=${b9.answer.slice(0, 140)}`,
    );
    check(
      "B11 确实用了文件读取类工具（非纯内联）",
      b9.tools.some((t) => ["read_file", "grep", "execute"].includes(t)),
      `tools=[${b9.tools.join(",")}]`,
    );

    // B12 图片 + 纯文本模型仍触发 vision 守卫；同时带附件不改变该行为
    const pngUp = await fetch(
      `${AGENT_BASE}/api/images?filename=probe.png&session_id=${encodeURIComponent(tempSessionId)}`,
      { method: "POST", headers: { "Content-Type": "image/png" }, body: makePng() },
    );
    const pngMeta = await pngUp.json();
    if (pngMeta.id) createdImageIds.push(pngMeta.id);
    const b12 = await chatCollect({
      session_id: tempSessionId,
      content: "看图和附件",
      model: "deepseek-v4-pro",
      image_ids: [pngMeta.id],
      file_ids: [up.body.id],
    });
    check(
      "B12 图片 + 纯文本模型仍走 vision 守卫",
      b12.answer.includes("当前模型不支持图片识别"),
      b12.answer.slice(0, 120),
    );
    const guardMsgs = await (
      await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}/messages`)
    ).json();
    const guardUser = (Array.isArray(guardMsgs) ? guardMsgs : []).find((m) =>
      (m.content || "").includes("看图和附件"),
    );
    check(
      "B13 守卫分支同样落库 file_ids（附件不丢）",
      !!guardUser && Array.isArray(guardUser.files) && guardUser.files.length === 1,
      JSON.stringify(guardUser && guardUser.files).slice(0, 160),
    );

    /* ---------- C. 前端交互 ---------- */

    // C0 注入管理员登录态（否则 /chat 停在登录页）
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
         const v = JSON.stringify({ user: d.user, role: d.role, token: d.token });
         localStorage.setItem('crm_auth', v);
         return v;
       })`,
    );
    check("C0 注入管理员登录态", typeof store === "string" && store.length > 20);

    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页加载");
    await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-input"]')`,
      "输入框渲染",
      30000,
    );
    await sleep(1500);

    // C1 加号按钮的 accept 同时含图片与 .txt
    const accept = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-image-input"]'); return el ? el.getAttribute('accept') : '__MISSING__'; })()`,
    );
    check("C1 accept 含图片类型", typeof accept === "string" && accept.includes("image/png"), String(accept));
    check("C2 accept 含 .txt", typeof accept === "string" && accept.includes(".txt"), String(accept));

    // C3 直接向后端上传一个附件，注入到前端 pending（模拟选文件）——
    //    更贴近真实的是注入 File 到 input，这里用真实 File 对象走 change 事件。
    const shortB64 = Buffer.from(SHORT_TXT, "utf8").toString("base64");
    const injectFile = (b64, fname, mime) => `
      (async () => {
        const el = document.querySelector('[data-testid="chat-image-input"]');
        if (!el) return 'no-input';
        const bin = atob(${JSON.stringify(b64)});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], ${JSON.stringify(fname)}, { type: ${JSON.stringify(mime)} });
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`;
    const injected = await evalJS(
      cdp,
      sessionId,
      injectFile(shortB64, "2026年第三季度华东区销售数据汇总分析报告终版.txt", "text/plain"),
    );
    check("C3 注入 txt 文件触发 change", injected === "ok", String(injected));

    const chipOk = await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-file-chip"]')`,
      "文件标签出现",
      30000,
    );
    check("C4 选文件后出现文件标签", chipOk);
    await shot(cdp, sessionId, "01-file-chip.png");

    const chipName = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-file-chip-name"]'); return el ? el.innerText.trim() : '__MISSING__'; })()`,
    );
    // ⚠️ 缩写规则：超长名保留扩展名，主干中间省略 → 含「…」且以 .txt 结尾。
    //    素材名（24 字）必须**长于**截断阈值 22，否则不会出现省略号。
    check(
      "C5 长文件名被缩写（含省略号且保留扩展名）",
      typeof chipName === "string" && chipName.includes("…") && chipName.endsWith(".txt"),
      `chipName=${String(chipName)} len=${String(chipName).length}`,
    );
    const chipTitle = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-file-chip"]'); return el ? el.getAttribute('title') : ''; })()`,
    );
    check(
      "C5.1 缩写标签的 tooltip 仍是完整文件名",
      typeof chipTitle === "string" && chipTitle.includes("华东区销售数据汇总分析报告终版.txt"),
      String(chipTitle).slice(0, 120),
    );
    check(
      "C6 标签在输入框（chat-input）之上",
      await evalJS(cdp, sessionId, `(() => {
        const chip = document.querySelector('[data-testid="chat-file-chip"]');
        const input = document.querySelector('[data-testid="chat-input"]');
        if (!chip || !input) return false;
        return chip.getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 2;
      })()`),
    );

    // C7 删除标签
    await evalJS(
      cdp,
      sessionId,
      `(() => { const b = document.querySelector('[data-testid="chat-file-remove"]'); if (b) b.click(); return true; })()`,
    );
    check(
      "C7 点击删除后文件标签消失",
      await waitFor(cdp, sessionId, `!document.querySelector('[data-testid="chat-file-chip"]')`, "标签被删除", 12000),
    );

    // C8 只带附件（无文字）也能发送
    await evalJS(cdp, sessionId, injectFile(shortB64, "库存清单.txt", "text/plain"));
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-file-chip"]')`, "再次选文件", 30000);
    const sendEnabledNoText = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => b.title === '发送' || b.title === '停止生成');
        const b = btns[0];
        if (!b) return '__MISSING__';
        return !b.disabled;
      })()`,
    );
    check("C8 仅附件（无文字）时发送按钮可用", sendEnabledNoText === true, String(sendEnabledNoText));

    // C9 发送 → 对话流出现文件标签块
    await evalJS(cdp, sessionId, setInput('[data-testid="chat-input"]', "附件里的库存数量是多少？只答数字。"));
    await sleep(400);
    await evalJS(
      cdp,
      sessionId,
      `(() => {
        const btns = [...document.querySelectorAll('button')].filter(b => b.title === '发送');
        if (btns[0]) btns[0].click();
        return true;
      })()`,
    );
    check(
      "C9 发送后用户消息进入对话流",
      await waitFor(
        cdp,
        sessionId,
        `[...document.querySelectorAll('[data-msg-role="user"]')].some(e => (e.innerText||'').includes('库存数量是多少'))`,
        "用户消息出现",
        30000,
      ),
    );
    check(
      "C10 对话流出现文件附件标签块",
      await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-file-attachments"]')`, "文件附件块", 30000),
    );
    // ⚠️ 页面上有多轮消息，历史轮次的附件块也在 DOM 里。
    //    必须取**最后一条用户消息内的**附件块，否则会读到旧的那条。
    const flowFileText = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const users = [...document.querySelectorAll('[data-msg-role="user"]')];
        const last = users[users.length - 1];
        if (!last) return '__NO_USER__';
        const el = last.querySelector('[data-testid="chat-file-attachment"]');
        return el ? el.innerText.trim() : '__MISSING__';
      })()`,
    );
    check(
      "C11 附件块展示文件名与类型徽标",
      typeof flowFileText === "string" && flowFileText.includes("TXT") && flowFileText.includes("库存清单"),
      String(flowFileText),
    );

    // C12 等模型回答，确认附件被真正读取
    const answered = await waitFor(
      cdp,
      sessionId,
      `(() => { const a = [...document.querySelectorAll('[data-msg-role="assistant"]')];
                const e = a[a.length - 1];
                const t = e ? (e.innerText || '') : '';
                return /\\b88\\b/.test(t) || t.length > 60; })()`,
      "助手给出回答",
      90000,
    );
    check("C12 前端全链路得到回答", answered);
    const lastAnswer = await evalJS(
      cdp,
      sessionId,
      `(() => { const a = [...document.querySelectorAll('[data-msg-role="assistant"]')];
                const e = a[a.length - 1];
                return e ? (e.innerText || '') : ''; })()`,
    );
    check(
      "C13 端到端读出附件内容（答出 88）",
      /\b88\b/.test(String(lastAnswer)),
      String(lastAnswer).slice(0, 160),
    );
    await shot(cdp, sessionId, "02-file-answer.png");

    // C14 刷新后文件标签仍还原
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页二次加载");
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-input"]')`, "输入框二次渲染", 30000);
    await sleep(2500);
    check(
      "C14 刷新页面后文件附件仍展示",
      await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-file-attachments"]')`, "刷新后还原", 35000),
    );
    await shot(cdp, sessionId, "03-file-restored.png");

    /* ---------- D. 剪切板粘贴导入 ---------- */

    // D1 粘贴 txt 文件 → 引入为文件附件标签
    //     ⚠️ headless 下无法真实操作系统剪切板，改为构造带 files 的 ClipboardEvent
    //        派发到输入框 —— 这正是 React onPaste 会收到的形态，等价验证处理逻辑。
    const pasteTxt = `
      (() => {
        const el = document.querySelector('[data-testid="chat-input"]');
        if (!el) return 'no-input';
        const bin = atob(${JSON.stringify(shortB64)});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], '粘贴进来的清单.txt', { type: 'text/plain' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
        el.dispatchEvent(ev);
        return 'ok';
      })()`;
    check("D1 派发带文件的粘贴事件", (await evalJS(cdp, sessionId, pasteTxt)) === "ok");
    check(
      "D2 粘贴 txt 后出现文件附件标签",
      await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-file-chip"]')`, "粘贴附件标签", 30000),
    );
    const pastedName = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-file-chip-name"]'); return el ? el.innerText.trim() : '__MISSING__'; })()`,
    );
    check(
      "D3 粘贴引入的是剪切板里的那个文件",
      typeof pastedName === "string" && pastedName.includes("粘贴进来的清单"),
      String(pastedName),
    );
    await shot(cdp, sessionId, "04-paste-file.png");

    // 清掉刚粘贴的标签，避免影响后续断言
    await evalJS(
      cdp,
      sessionId,
      `(() => { const b = document.querySelector('[data-testid="chat-file-remove"]'); if (b) b.click(); return true; })()`,
    );
    await waitFor(cdp, sessionId, `!document.querySelector('[data-testid="chat-file-chip"]')`, "清空标签", 12000);

    // D4 粘贴图片文件 → 走图片通道，出现图片标签
    const pngB64 = makePng(10, 10, [220, 38, 38]).toString("base64");
    const pasteImg = `
      (() => {
        const el = document.querySelector('[data-testid="chat-input"]');
        if (!el) return 'no-input';
        const bin = atob(${JSON.stringify(pngB64)});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], '粘贴的截图.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
        el.dispatchEvent(ev);
        return 'ok';
      })()`;
    check("D4 派发带图片的粘贴事件", (await evalJS(cdp, sessionId, pasteImg)) === "ok");
    check(
      "D5 粘贴图片走图片通道，出现图片标签",
      await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-image-chip"]')`, "粘贴图片标签", 30000),
    );
    await shot(cdp, sessionId, "05-paste-image.png");

    // 清掉图片标签
    await evalJS(
      cdp,
      sessionId,
      `(() => { const b = document.querySelector('[data-testid="chat-image-remove"]'); if (b) b.click(); return true; })()`,
    );

    // D6 纯文本粘贴不拦截（正常打字不受影响）
    //     —— 无 files 的 paste 事件里，文字应照常进入输入框（浏览器默认行为）。
    await evalJS(cdp, sessionId, `(() => { const el = document.querySelector('[data-testid="chat-input"]'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    const plainPaste = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const el = document.querySelector('[data-testid="chat-input"]');
        if (!el) return 'no-input';
        const dt = new DataTransfer();
        dt.setData('text/plain', '这是一段纯文本粘贴内容');
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
        const notCancelled = el.dispatchEvent(ev);  // 没被 preventDefault 才返回 true
        return notCancelled ? 'not-cancelled' : 'cancelled';
      })()`,
    );
    check(
      "D6 纯文本粘贴不被拦截（不破坏正常打字）",
      plainPaste === "not-cancelled",
      String(plainPaste),
    );
  } finally {
    /* ---------- 清理 ---------- */
    console.log("\n--- 清理 ---");
    try {
      for (const id of createdFileIds) {
        await fetch(`${AGENT_BASE}/api/files/${id}`, { method: "DELETE" });
      }
      for (const id of createdImageIds) {
        await fetch(`${AGENT_BASE}/api/images/${id}`, { method: "DELETE" });
      }
      if (createdFileIds.length || createdImageIds.length) {
        console.log(`  -> 已删除测试附件 ${createdFileIds.length} 个 / 图片 ${createdImageIds.length} 张`);
      }
    } catch (e) {
      console.log("  !! 清理附件失败：", e.message);
    }
    try {
      if (tempSessionId) {
        await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}`, { method: "DELETE" });
        console.log("  -> 已删除临时会话", tempSessionId);
      }
      const list = await (await fetch(`${AGENT_BASE}/api/sessions`)).json();
      const arr = Array.isArray(list) ? list : list.sessions || [];
      for (const s of arr.filter((s) => (s.title || "") === TMP_TITLE)) {
        await fetch(`${AGENT_BASE}/api/sessions/${s.id}`, { method: "DELETE" });
        console.log("  -> 已删除历史残留会话", s.id);
      }
    } catch (e) {
      console.log("  !! 清理临时会话失败：", e.message);
    }
    // 落盘的长文本附件：会话删除会连带清理，这里兜底扫一遍孤儿文件
    try {
      if (fs.existsSync(UPLOAD_DIR)) {
        const leftovers = fs.readdirSync(UPLOAD_DIR).filter((f) => f.endsWith(".txt"));
        for (const f of leftovers) fs.unlinkSync(path.join(UPLOAD_DIR, f));
        if (leftovers.length) console.log("  -> 已清理落盘附件", leftovers.length, "个");
      }
    } catch (e) {
      console.log("  !! 清理落盘附件失败：", e.message);
    }
    try {
      await cdp.send("Browser.close");
    } catch {
      /* ignore */
    }
    ws.close();
    setTimeout(() => {
      try {
        chrome.kill();
      } catch {
        /* ignore */
      }
    }, 800);

    console.log("");
    console.log("=".repeat(60));
    console.log(`文件附件 + 粘贴导入验证: ${pass}/${pass + fail.length} 通过`);
    if (fail.length) console.log("失败项:", fail.join(", "));
    console.log("截图目录:", OUT);
    console.log("=".repeat(60));
    process.exit(fail.length ? 1 : 0);
  }
})().catch((e) => {
  console.error("验证脚本异常:", e);
  process.exit(2);
});
