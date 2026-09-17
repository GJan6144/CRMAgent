#!/usr/bin/env node
/**
 * 月报 HTML 分屏截图（无头 Chrome + CDP）
 *
 * 用途：把一份长报告页按视口高度分段截图，便于人工复核版式与文案。
 * 纯开发期工具，不参与运行时；用完可删。
 *
 *   node _shoot_report.cjs <URL> <输出目录> [视口宽] [视口高]
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const URL_ = process.argv[2];
const OUT_DIR = process.argv[3] || path.join(__dirname, "_report_screenshots");
const VW = Number(process.argv[4] || 1120);
const VH = Number(process.argv[5] || 880);
if (!URL_) {
  console.error("用法: node _shoot_report.cjs <URL> <输出目录> [宽] [高]");
  process.exit(2);
}

const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitPort(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error("Chrome 调试端口未就绪");
}

function makeCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    },
    on(fn) { listeners.push(fn); },
    close() { ws.close(); },
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-report-"));
  const DEBUG_PORT = 9333 + (process.pid % 200);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDir}`,
      `--window-size=${VW},${VH}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: false }
  );

  const cdp = await (async () => {
    await waitPort(DEBUG_PORT);
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const info = await res.json();
    return makeCdp(info.webSocketDebuggerUrl);
  })();
  await cdp.ready;

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: VW, height: VH, deviceScaleFactor: 1, mobile: false },
    sessionId
  );

  const evalJS = async (expr) => {
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    return r.result ? r.result.value : undefined;
  };

  await cdp.send("Page.navigate", { url: URL_ }, sessionId);
  await sleep(1600);
  const title = await evalJS("document.title");
  const height = await evalJS("document.documentElement.scrollHeight");
  console.log(`标题: ${title}`);
  console.log(`页面高度: ${height}px  视口: ${VW}x${VH}`);

  const pages = Math.max(1, Math.ceil(height / VH));
  for (let i = 0; i < pages; i++) {
    await evalJS(`window.scrollTo(0, ${i * VH})`);
    await sleep(450);
    const shot = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      sessionId
    );
    const file = path.join(OUT_DIR, `report-${String(i + 1).padStart(2, "0")}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`  -> ${path.basename(file)}`);
  }

  cdp.close();
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
