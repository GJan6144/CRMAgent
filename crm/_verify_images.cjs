/**
 * 图片附件输入 —— 端到端验证 + 截图
 *
 * 覆盖：
 *   A. 图片存储接口契约：POST /api/images（成功 / 415 类型错 / 422 超限）、
 *      GET /api/images/{id}（data_url）、meta、DELETE、404
 *   B. chat 端点图片校验：无效 image_id 拒绝（422）、超条数拒绝、
 *      vision 守卫（用 deepseek-v4-pro，纯文本）固定话术不调模型、
 *      **真实识别**（用 deepseek-flash，支持图文混排）能调模型并正确识图
 *   C. 前端：左下角加号按钮、选图后文件名标签、标签可删除、发送后图片单独成条（不塞文字气泡）
 *
 * ⚠️ 能力标记事实（官方文档 + 实测，见 chat-ui/_probe_vision.py）：
 *    - `deepseek-flash` **支持图片输入**（多模态已并入主线 Flash，原 vision-exp 已退役）
 *    - `deepseek-v4-pro` 仅纯文本 → 用它来验证守卫
 *
 * ⚠️ 识别断言必须用**三色块图**（makeColorBarsPng，480x160），不能用纯色小图：
 *    DeepSeek 服务端会把图重采样（小图 → 约 384x384），纯色图放大后仍是纯色，
 *    模型只能答"单一颜色" → 断言必然假失败。实测对比见 chat-ui/_probe_vision_tiny.py。
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）。
 * 数据安全：只新建临时会话；跑完按 id 删除会话、消息、图片。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9958;
const CRM_BASE = "http://127.0.0.1:3100";
const AGENT_BASE = "http://127.0.0.1:8765";
const OUT = path.join(__dirname, "_images_screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_TITLE = "img-e2e-tmp";

/* ---------------- 造一张常见 PNG（不依赖外部素材） ----------------
 * 两种形态：
 *   1) makePng(w,h,rgb)           —— 纯色块，给接口契约测试用（只关心字节/尺寸）
 *   2) makeColorBarsPng()         —— 480x160 深蓝底 + 红/绿/黄三色块，给**真实识别**测试用
 *
 * ⚠️ 为什么必须用三色块图测识别：DeepSeek 服务端会把图片重采样
 *    （小于阈值 → 放大到约 384x384，保持宽高比）。**8x8 纯色小图放大后仍是纯色**，
 *    模型只能答"单一颜色"，会让「识别是否正确」的断言必然失败 —— 那是素材问题，不是产品缺陷。
 *    实测见 chat-ui/_probe_vision_tiny.py。
 */
function pngFromRows(w, h, rowFn) {
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(Buffer.from([0])); // filter type 0
    raw.push(rowFn(y));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makePng(w = 8, h = 8, rgb = [37, 99, 235]) {
  return pngFromRows(w, h, () => Buffer.from(Array.from({ length: w }, () => rgb).flat()));
}

// 三色块素材：与 chat-ui/_probe_vision.py 的 make_png_with_text 同构（480x160，深蓝底）
const BARS_SPEC = [
  { rgb: [220, 38, 38], name: "红" },
  { rgb: [22, 163, 74], name: "绿" },
  { rgb: [250, 204, 21], name: "黄" },
];

function makeColorBarsPng(w = 480, h = 160) {
  const BG = [30, 58, 138]; // 深蓝底：与三个色块对比度足够
  const barW = Math.floor(w / BARS_SPEC.length);
  return pngFromRows(w, h, () => {
    const row = Buffer.alloc(w * 3);
    for (let x = 0; x < w; x++) {
      const rgb = BARS_SPEC[Math.floor(x / barW)] ? BARS_SPEC[Math.floor(x / barW)].rgb : BG;
      row[x * 3] = rgb[0];
      row[x * 3 + 1] = rgb[1];
      row[x * 3 + 2] = rgb[2];
    }
    return row;
  });
}

const BARS_EXPECTED = BARS_SPEC.map((b) => b.name);

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

async function createSession(title) {
  const r = await fetch(`${AGENT_BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return r.json();
}

async function uploadImage(bytes, filename, mime, sessionId) {
  const r = await fetch(
    `${AGENT_BASE}/api/images?filename=${encodeURIComponent(filename)}&session_id=${encodeURIComponent(sessionId)}`,
    { method: "POST", headers: { "Content-Type": mime }, body: bytes },
  );
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* ignore */
  }
  return { status: r.status, body };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-img-"));
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
  const createdImageIds = [];

  try {
    /* ---------- A. 图片存储接口契约 ---------- */
    const sess = await createSession(TMP_TITLE);
    tempSessionId = sess.id;
    check("A1 创建临时会话成功", typeof sess.id === "string" && sess.id.length > 10, JSON.stringify(sess).slice(0, 120));

    const png = makePng(8, 8);

    // A2 正常上传
    const up = await uploadImage(png, "照片A.png", "image/png", tempSessionId);
    check("A2 上传 PNG 返回 200", up.status === 200, `status=${up.status} ${JSON.stringify(up.body).slice(0, 120)}`);
    check("A3 返回 id / filename / mime / size", !!up.body && !!up.body.id && up.body.filename === "照片A.png" && up.body.mime === "image/png" && up.body.size === png.length, JSON.stringify(up.body));
    if (up.body && up.body.id) createdImageIds.push(up.body.id);

    // A4 非法类型 → 415
    const bad = await uploadImage(Buffer.from("not an image"), "a.txt", "text/plain", tempSessionId);
    check("A4 非图片类型返回 415", bad.status === 415, `status=${bad.status}`);

    // A5 超大 → 422
    const big = Buffer.concat([makePng(8, 8), Buffer.alloc(5 * 1024 * 1024)]);
    const over = await uploadImage(big, "big.png", "image/png", tempSessionId);
    check("A5 超过 5MB 返回 422", over.status === 422, `status=${over.status} ${JSON.stringify(over.body).slice(0, 100)}`);

    // A6 GET 取 data_url
    const got = await (await fetch(`${AGENT_BASE}/api/images/${up.body.id}`)).json();
    check("A6 GET 返回 data_url", typeof got.data_url === "string" && got.data_url.startsWith("data:image/png;base64,"), String(got.data_url).slice(0, 60));

    // A7 meta 不含 base64
    const meta = await (await fetch(`${AGENT_BASE}/api/images/${up.body.id}/meta`)).json();
    check("A7 meta 返回元数据且不含 base64", meta.id === up.body.id && meta.data_b64 === undefined && meta.data === undefined, JSON.stringify(meta).slice(0, 120));

    // A8 不存在 → 404
    const r404 = await fetch(`${AGENT_BASE}/api/images/__no_such_image__`);
    check("A8 不存在的图片返回 404", r404.status === 404, String(r404.status));

    // A9 多条上传后按 id 取回
    const up2 = await uploadImage(makePng(6, 6, [220, 38, 38]), "照片B.png", "image/png", tempSessionId);
    if (up2.body && up2.body.id) createdImageIds.push(up2.body.id);
    check("A9 第二张图片上传成功", up2.status === 200 && !!up2.body.id, `status=${up2.status}`);

    /* ---------- B. chat 端点的图片校验与 vision 守卫 ---------- */

    // B1 无效 image_id → 422（不能静默丢图后把消息发给模型）
    const b1 = await fetch(`${AGENT_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tempSessionId,
        content: "看看这张图",
        model: "deepseek-flash",
        image_ids: ["__bogus__"],
      }),
    });
    check("B1 无效 image_id 被拒绝（422）", b1.status === 422, String(b1.status));

    // B2 超过 4 张 → 422
    const b2 = await fetch(`${AGENT_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tempSessionId,
        content: "多图",
        model: "deepseek-flash",
        image_ids: ["a", "b", "c", "d", "e"],
      }),
    });
    check("B2 超过 4 张图片被拒绝（422）", b2.status === 422, String(b2.status));

    // B3 vision 守卫：deepseek-v4-pro 官方仅纯文本 → 固定话术，不调模型
    // ⚠️ 守卫要挑一个**真的不支持图片**的模型测；deepseek-flash 是支持图片的（见 B10+）。
    const b3res = await fetch(`${AGENT_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tempSessionId,
        content: "这张图里有什么？",
        model: "deepseek-v4-pro",
        image_ids: [up.body.id],
      }),
    });
    const b3text = await b3res.text();
    check("B3 vision 守卫返回 200", b3res.status === 200, String(b3res.status));
    check("B4 固定回复「当前模型不支持图片识别」", b3text.includes("当前模型不支持图片识别"), b3text.slice(0, 200));
    check("B5 守卫路径不产生 llm_thinking（未调模型）", !b3text.includes('"event": "llm_thinking"'), b3text.slice(0, 300));
    check(
      "B5.1 守卫路径不产生 llm_token 之外的输出",
      !b3text.includes('"node": "model"'),
      b3text.slice(0, 300),
    );
    check("B6 守卫路径 context.used_tokens 为 0", /"used_tokens": 0/.test(b3text) || /"used_tokens":0/.test(b3text), b3text.slice(-260));

    // B7 消息落库：用户消息带图片元数据，助手消息为固定话术
    const msgs = await (await fetch(`${AGENT_BASE}/api/sessions/${tempSessionId}/messages`)).json();
    const arr = Array.isArray(msgs) ? msgs : [];
    const userMsg = arr.find((m) => m.role === "user" && (m.content || "").includes("这张图里有什么"));
    const aiMsg = arr.find((m) => m.role === "assistant" && (m.content || "").includes("当前模型不支持图片识别"));
    check("B7 用户消息落库且带 images 元数据", !!userMsg && Array.isArray(userMsg.images) && userMsg.images.length === 1, JSON.stringify(userMsg && userMsg.images).slice(0, 160));
    check("B8 助手消息落库为固定话术", !!aiMsg, JSON.stringify(aiMsg || {}).slice(0, 160));
    check("B9 图片元数据不含 base64", !!userMsg && userMsg.images.every((i) => i.data_url === undefined && i.data_b64 === undefined), JSON.stringify(userMsg && userMsg.images).slice(0, 200));

    // B10 能力标记：deepseek-flash 必须被标为支持图片（vision:true）
    // 这是本次修复的核心 —— 官方文档明确 flash 支持图文混排，多模态已并入主线。
    const modelList = await (await fetch(`${AGENT_BASE}/api/panel/models`)).json();
    const flash = (modelList.models || []).find((m) => m.id === "deepseek-flash");
    check("B10 deepseek-flash 标记为支持图片", !!flash && flash.vision === true, JSON.stringify(flash || {}).slice(0, 160));
    check(
      "B11 vision 模型数为 1（只有 flash）",
      modelList.vision === 1 || (modelList.summary && modelList.summary.vision === 1),
      JSON.stringify({ vision: modelList.vision, summary: modelList.summary }).slice(0, 160),
    );

    // B12 真实识别：deepseek-flash 拿到图片后必须**调用模型**并正确识别内容
    // ⚠️ 用三色块图（makeColorBarsPng），不要用纯色小图 —— 纯色图被重采样后仍是纯色，
    //    模型只能答"单一颜色"，会让识别断言必然失败（详见 makeColorBarsPng 注释）。
    const barsPng = makeColorBarsPng();
    const visionImg = await uploadImage(barsPng, "视觉验证.png", "image/png", tempSessionId);
    if (visionImg.body && visionImg.body.id) createdImageIds.push(visionImg.body.id);
    check(
      "B12.0 三色块素材上传成功",
      visionImg.status === 200 && visionImg.body.size === barsPng.length,
      `status=${visionImg.status} size=${visionImg.body && visionImg.body.size}`,
    );
    const b12res = await fetch(`${AGENT_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: tempSessionId,
        content: "这张图里有几个方块？按从左到右只答颜色，用顿号分隔。",
        model: "deepseek-flash",
        image_ids: [visionImg.body.id],
      }),
    });
    const b12text = await b12res.text();
    check("B12 flash + 图片返回 200（未走守卫）", b12res.status === 200, String(b12res.status));
    check("B13 flash 未回固定拒绝话术", !b12text.includes("当前模型不支持图片识别"), b12text.slice(0, 220));
    check("B14 flash 确实调用了模型（有 llm_thinking/node）", b12text.includes('"event": "llm_thinking"') || b12text.includes('"node": "model"'), b12text.slice(0, 320));
    const tokens = b12text.match(/"llm_token",\s*"token":\s*"([^"]*)"/g) || [];
    const answer = tokens.map((t) => (t.match(/"token":\s*"([^"]*)"/) || [])[1] || "").join("");
    check(
      "B15 flash 正确识别三个色块（红/绿/黄）",
      BARS_EXPECTED.every((c) => answer.includes(c)),
      `answer=${answer.slice(0, 120)}`,
    );
    check(
      "B16 真实识别路径消耗了 token（context.used_tokens > 0）",
      /"used_tokens":\s*[1-9]/.test(b12text),
      b12text.slice(-260),
    );

    // B17 守卫轮不得污染后续历史（跨模型切换场景）
    //
    // ⚠️⚠️ 这是实测踩到的真缺陷：同一会话里先用纯文本模型(pro)发图 → 落库一句
    //    「当前模型不支持图片识别」（我们自己写的，不是模型输出）→ 再切到 flash 发图，
    //    历史里那句"我看不到图"会让 flash **顺着它继续拒答**
    //    （模型思考过程原文："prior turn I said 当前模型不支持图片识别, I should be consistent"）。
    //    修法：守卫轮的「用户 + 助手」两条都打 is_guard=1，重建历史时整轮跳过。
    //    这里用一个全新会话复现同样序列，断言 flash 那轮不出现拒绝话术。
    const isoSess = await createSession("img-guard-isolation-tmp");
    try {
      const isoImg = await uploadImage(barsPng, "隔离验证.png", "image/png", isoSess.id);
      if (isoImg.body && isoImg.body.id) createdImageIds.push(isoImg.body.id);

      // 1) 纯文本模型 → 守卫话术
      const g1res = await fetch(`${AGENT_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: isoSess.id,
          content: "这张图里有什么？",
          model: "deepseek-v4-pro",
          image_ids: [isoImg.body.id],
        }),
      });
      const g1text = await g1res.text();
      check("B17 隔离会话：守卫轮照常回固定话术", g1text.includes("当前模型不支持图片识别"), g1text.slice(0, 160));

      // 2) 切到支持图片的 flash → 必须能正常识别（不被上一轮带偏）
      const g2res = await fetch(`${AGENT_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: isoSess.id,
          content: "这张图里有几个方块？按从左到右只答颜色，用顿号分隔。",
          model: "deepseek-flash",
          image_ids: [isoImg.body.id],
        }),
      });
      const g2text = await g2res.text();
      const g2tokens = g2text.match(/"llm_token",\s*"token":\s*"([^"]*)"/g) || [];
      const g2answer = g2tokens.map((t) => (t.match(/"token":\s*"([^"]*)"/) || [])[1] || "").join("");
      check(
        "B18 守卫轮不进历史：切到 flash 后不再拒答",
        !g2text.includes("当前模型不支持图片识别"),
        g2text.slice(0, 220),
      );
      check(
        "B19 隔离会话：flash 仍正确识别三色块",
        BARS_EXPECTED.every((c) => g2answer.includes(c)),
        `answer=${g2answer.slice(0, 120)}`,
      );
    } finally {
      try {
        await fetch(`${AGENT_BASE}/api/sessions/${isoSess.id}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
    }

    /* ---------- C. 前端交互 ---------- */

    // 先注入管理员登录态（否则 /chat 会停在登录页）
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
    check("C0 注入管理员登录态", typeof store === "string" && store.length > 20, String(store).slice(0, 80));

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

    // C1 加号按钮存在
    check(
      "C1 输入框左下角存在加号按钮",
      await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-image-add"]')`, "加号按钮", 30000),
    );

    // C2 隐藏的 file input 存在且 accept 只含图片
    const accept = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-image-input"]'); return el ? el.getAttribute('accept') : '__MISSING__'; })()`,
    );
    check("C2 图片 input 存在", accept !== "__MISSING__", String(accept));
    check("C3 accept 仅含图片类型", typeof accept === "string" && accept.includes("image/png") && accept.includes("image/jpeg") && !accept.includes("*"), String(accept));
    check(
      "C4 file input 支持多选",
      (await evalJS(cdp, sessionId, `(() => { const el = document.querySelector('[data-testid="chat-image-input"]'); return el ? el.multiple : false; })()`)) === true,
    );

    // C5 直接调 React 的 onChange 无法触发，改为注入文件到 input 并派发 change
    // ⚠️ 注入三色块图（不是纯色小图）：C 组末尾要断言"flash 真实识别出颜色"，
    //    纯色图被重采样后仍是纯色，模型答不出三种颜色。
    const b64 = barsPng.toString("base64");
    const addFile = `
      (async () => {
        const el = document.querySelector('[data-testid="chat-image-input"]');
        if (!el) return 'no-input';
        const bin = atob(${JSON.stringify(b64)});
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], '标签测试图.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()
    `;
    const added = await evalJS(cdp, sessionId, addFile);
    check("C5 注入图片文件触发 change", added === "ok", String(added));

    const chipOk = await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-image-chip"]')`,
      "图片标签出现",
      30000,
    );
    check("C6 选图后出现文件名标签", chipOk);
    await shot(cdp, sessionId, "01-chip-visible.png");

    const chipText = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-image-chip"]'); return el ? el.innerText.trim() : '__MISSING__'; })()`,
    );
    check("C7 标签展示文件名", typeof chipText === "string" && chipText.includes("标签测试图"), String(chipText));
    check(
      "C8 标签带删除按钮",
      (await evalJS(cdp, sessionId, `!!document.querySelector('[data-testid="chat-image-remove"]')`)) === true,
    );
    check("C9 标签在输入框（chat-input）之上", await evalJS(cdp, sessionId, `(() => {
      const chip = document.querySelector('[data-testid="chat-image-chip"]');
      const input = document.querySelector('[data-testid="chat-input"]');
      if (!chip || !input) return false;
      return chip.getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 2;
    })()`));

    // C10 删除标签
    await evalJS(cdp, sessionId, `(() => { const b = document.querySelector('[data-testid="chat-image-remove"]'); if (b) b.click(); return true; })()`);
    const chipGone = await waitFor(
      cdp,
      sessionId,
      `!document.querySelector('[data-testid="chat-image-chip"]')`,
      "标签被删除",
      12000,
    );
    check("C10 点击删除后标签消失", chipGone);

    // C11 只带图片（无文字）也能发送
    await evalJS(cdp, sessionId, addFile);
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-image-chip"]')`, "再次选图", 30000);
    const sendEnabledNoText = await evalJS(cdp, sessionId, `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => b.title === '发送' || b.title === '停止生成');
      const b = btns[0];
      if (!b) return '__MISSING__';
      return !b.disabled;
    })()`);
    check("C11 仅图片（无文字）时发送按钮可用", sendEnabledNoText === true, String(sendEnabledNoText));

    // C12 发送（图片单独成条；文字与图片分开展示）
    // ⚠️ 当前默认模型 deepseek-flash 支持图片 → 这一轮应当拿到**真实识别结果**
    await evalJS(cdp, sessionId, setInput('[data-testid="chat-input"]', "这张图里有几个方块？按从左到右只答颜色，用顿号分隔。"));
    await sleep(400);
    await evalJS(cdp, sessionId, `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => b.title === '发送');
      if (btns[0]) btns[0].click();
      return true;
    })()`);

    const userNameMsg = await waitFor(
      cdp,
      sessionId,
      `[...document.querySelectorAll('[data-msg-role="user"]')].some(e => (e.innerText||'').includes('按从左到右只答颜色'))`,
      "用户消息出现",
      30000,
    );
    check("C12 发送后用户消息进入对话流", userNameMsg);
    await shot(cdp, sessionId, "02-after-send.png");

    // 图片单独一块，且不在文字气泡内部
    check(
      "C13 对话流出现图片附件块",
      await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-image-attachments"]')`, "图片附件块", 30000),
    );
    check(
      "C14 图片块位于用户消息内、但不嵌在文字气泡内",
      await evalJS(cdp, sessionId, `(() => {
        const user = document.querySelector('[data-msg-role="user"]');
        const att = document.querySelector('[data-testid="chat-image-attachments"]');
        if (!user || !att) return false;
        if (!user.contains(att)) return false;
        // 文字气泡（含背景色）不应包含图片块
        const bubbles = [...user.querySelectorAll('div')].filter(d => {
          const bg = getComputedStyle(d).backgroundColor;
          return bg === 'rgb(37, 99, 235)';
        });
        return bubbles.every(b => !b.contains(att));
      })()`),
    );

    // C15 图片实际渲染出 <img>（data_url 已拉回）
    const imgLoaded = await waitFor(
      cdp,
      sessionId,
      `(() => { const i = document.querySelector('[data-testid="chat-image-attachment"] img'); return !!i && (i.src||'').startsWith('data:image/'); })()`,
      "图片 data_url 渲染",
      30000,
    );
    check("C15 图片附件渲染出真实 data_url", imgLoaded);

    // C16 默认模型是 deepseek-flash（支持图片）→ 应当拿到真实回答，而不是拒绝话术
    const modelVal = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-model-select"]'); return el ? el.value : '__MISSING__'; })()`,
    );
    check("C16 对话页默认选中 deepseek-flash", modelVal === "deepseek-flash", String(modelVal));

    const answered = await waitFor(
      cdp,
      sessionId,
      `[...document.querySelectorAll('[data-msg-role="assistant"]')].some(e => (e.innerText||'').trim().length > 6)`,
      "助手给出回答",
      60000,
    );
    check("C17 flash 模型下得到真实回答", answered);
    // ⚠️ 流式输出是逐字追加的：上面 C17 只等到"有内容"（可能只有角色标签「AI」）。
    //    断言识别结果前必须等**最后一条**助手消息长到足够长，否则会读到半截文本。
    const lastAssistant = await waitFor(
      cdp,
      sessionId,
      `(() => { const want = ${JSON.stringify(BARS_EXPECTED)};
                const a = [...document.querySelectorAll('[data-msg-role="assistant"]')];
                const e = a[a.length - 1];
                const t = e ? (e.innerText || '') : '';
                return want.every(c => t.includes(c)) || t.length > 40; })()`,
      "回答收敛",
      60000,
    );
    const finalAnswer = await evalJS(
      cdp,
      sessionId,
      `(() => { const a = [...document.querySelectorAll('[data-msg-role="assistant"]')];
                const e = a[a.length - 1];
                return e ? (e.innerText || '') : ''; })()`,
    );
    check(
      "C18 本轮回答不是固定拒绝话术",
      !String(finalAnswer).includes("当前模型不支持图片识别"),
      String(finalAnswer).slice(0, 200),
    );
    // C18.1 端到端正向验证（用户报的 bug 就是这一条）
    // 从「上传图片 → 前端 → 代理 → chat 端点 → 模型」全链路，答复里要能读出三种颜色
    check(
      "C18.1 全链路端到端识别出红/绿/黄",
      BARS_EXPECTED.every((c) => String(finalAnswer).includes(c)),
      `last=${String(finalAnswer).slice(0, 200)}`,
    );
    await shot(cdp, sessionId, "03-flash-answer.png");

    // C19 切到纯文本模型 deepseek-v4-pro，再发一张图 → 应得到固定拒绝话术
    await evalJS(
      cdp,
      sessionId,
      `(() => {
        const el = document.querySelector('[data-testid="chat-model-select"]');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(el, 'deepseek-v4-pro');
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await sleep(800);
    const switched = await evalJS(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="chat-model-select"]'); return el ? el.value : '__MISSING__'; })()`,
    );
    check("C19 可切换到 deepseek-v4-pro", switched === "deepseek-v4-pro", String(switched));

    await evalJS(cdp, sessionId, addFile);
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-image-chip"]')`, "选图（pro）", 30000);
    await evalJS(cdp, sessionId, setInput('[data-testid="chat-input"]', "这张图里有什么？"));
    await sleep(400);
    await evalJS(cdp, sessionId, `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => b.title === '发送');
      if (btns[0]) btns[0].click();
      return true;
    })()`);
    const refused = await waitFor(
      cdp,
      sessionId,
      `[...document.querySelectorAll('[data-msg-role="assistant"]')].some(e => (e.innerText||'').includes('当前模型不支持图片识别'))`,
      "助手固定话术回复",
      40000,
    );
    check("C20 纯文本模型下回复「当前模型不支持图片识别」", refused);
    await shot(cdp, sessionId, "04-refusal.png");

    // C21 刷新后图片仍能还原
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页二次加载");
    await waitFor(cdp, sessionId, `!!document.querySelector('[data-testid="chat-input"]')`, "输入框二次渲染", 30000);
    await sleep(2500);
    const restored = await waitFor(
      cdp,
      sessionId,
      `!!document.querySelector('[data-testid="chat-image-attachments"]')`,
      "刷新后图片还原",
      35000,
    );
    check("C21 刷新页面后图片附件仍展示", restored);
    await shot(cdp, sessionId, "05-restored.png");
  } finally {
    /* ---------- 清理 ---------- */
    console.log("\n--- 清理 ---");
    try {
      for (const id of createdImageIds) {
        await fetch(`${AGENT_BASE}/api/images/${id}`, { method: "DELETE" });
      }
      if (createdImageIds.length) console.log("  -> 已删除测试图片", createdImageIds.length, "张");
    } catch (e) {
      console.log("  !! 清理图片失败：", e.message);
    }
    try {
      if (tempSessionId) {
        // 删除会话会连带清理该会话的图片
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
    console.log(`图片附件验证: ${pass}/${pass + fail.length} 通过`);
    if (fail.length) console.log("失败项:", fail.join(", "));
    console.log("截图目录:", OUT);
    console.log("=".repeat(60));
    process.exit(fail.length ? 1 : 0);
  }
})().catch((e) => {
  console.error("验证脚本异常:", e);
  process.exit(2);
});
