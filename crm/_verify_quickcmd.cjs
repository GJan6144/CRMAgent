/** CRM AI 助手页（/chat）快捷指令 —— 无头浏览器验证 + 截图 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9946;
const BASE = "http://127.0.0.1:3100";
const OUT = path.join(__dirname, "_quickcmd_screenshots");
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
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-crmqcmd-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(300); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

  let pass = 0, fail = 0;
  const check = (n, c, extra = "") => { if (c) { pass++; console.log("[PASS]", n); } else { fail++; console.log("[FAIL]", n, "::", extra); } };
  const clearQuick = () => evalJS(cdp, sessionId, `localStorage.removeItem('crm-chat-quick-commands'); true`);
    const home = async () => {
      await cdp.send("Page.navigate", { url: `${BASE}/chat` }, sessionId);
      await waitFor(cdp, sessionId, "document.readyState === 'complete'", "对话页加载", 25000);
      await sleep(1200);
      // 刷新后可能停在「有历史消息」的会话 → 点新建对话回到空会话，快捷指令才会出现
      for (let i = 0; i < 3; i++) {
        const has = await evalJS(cdp, sessionId, `!!document.querySelector('button[data-cmd]')`);
        if (has) break;
        await evalJS(cdp, sessionId, `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === '新建对话'); if (b) b.click(); return !!b; })()`);
        await sleep(1400);
      }
      await waitFor(cdp, sessionId, "!!document.querySelector('button[data-cmd]')", "快捷指令渲染", 20000);
      await sleep(500);
    };

  try {
    // 登录
    await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "登录页");
    await evalJS(cdp, sessionId, `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:'13912345678',password:'123123'})}).then(r=>r.json()).then(d=>{localStorage.setItem('crm_auth',JSON.stringify({user:d.user,role:d.role,token:d.token}));return 'ok';})`);
    await clearQuick();
    await home();

    // A1 渲染默认指令
    const init = await evalJS(cdp, sessionId, `(() => {
      const host = document.querySelector('[data-testid="quick-cmds"]');
      const list = document.querySelector('[data-testid="quick-cmds-list"]');
      const chips = Array.from(list.querySelectorAll('button[data-cmd]'));
      const settings = document.querySelector('[data-testid="quick-cmd-settings"]');
      const scroll = document.querySelector('[data-testid="chat-scroll"]');
      const hr = host.getBoundingClientRect(), sr = scroll.getBoundingClientRect();
      const cr = chips.length ? chips[0].getBoundingClientRect() : null;
      const gr = settings.getBoundingClientRect();
      if (!host || !list) return { count: chips.length, texts: chips.map(c=>c.textContent), missing: {host:!host, list:!list, settings:!settings, scroll:!scroll} };
      return {
        count: chips.length,
        texts: chips.map(c => c.textContent),
        hasSettings: !!settings,
        centeredX: Math.abs((hr.left + hr.right) / 2 - (sr.left + sr.right) / 2) < 4,
        centeredY: Math.abs((hr.top + hr.bottom) / 2 - (sr.top + sr.bottom) / 2) < sr.height * 0.3,
        settingsRight: cr ? gr.left > cr.left : false,
        singleLine: chips.every(c => c.offsetHeight <= 36),
        hostHeight: hr.height,
      };
    })()`);
    check("A1 渲染 4 条默认快捷指令", init.count === 4, JSON.stringify(init.texts));
    check("A2 快捷指令整体水平居中", init.centeredX, JSON.stringify(init));
    check("A3 快捷指令整体垂直居中", init.centeredY, JSON.stringify({ host: init.hostHeight }));
    check("A4 最右侧有设置图标", init.hasSettings && init.settingsRight, JSON.stringify(init));
    check("A5 单条指令单行显示", init.singleLine, JSON.stringify(init));
    await (async () => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); fs.writeFileSync(path.join(OUT, "crm-1-welcome.png"), Buffer.from(r.data, "base64")); console.log("  -> 截图 crm-1-welcome.png"); })();

    // A6 超长截断
    await evalJS(cdp, sessionId, `localStorage.setItem('crm-chat-quick-commands', JSON.stringify(['这是一个非常长的快捷指令文字超过十个汉字需要截断显示'])); true`);
    await home();
    const trunc = await evalJS(cdp, sessionId, `(() => { const c = document.querySelector('button[data-cmd]'); return { shown: c.textContent, title: c.title || '', full: c.dataset.cmd }; })()`);
    const warn = trunc.shown.replace(/…$/, "");
    check("A6 超 10 汉字截断为 …", warn.length === 10 && trunc.shown.endsWith("…"), JSON.stringify(trunc));
    check("A7 完整文字保留在 title/data-cmd", trunc.title === trunc.full && trunc.full.length > 10, JSON.stringify(trunc));

    // A8 两行限高
    await evalJS(cdp, sessionId, `localStorage.setItem('crm-chat-quick-commands', JSON.stringify(['指令一','指令二','指令三','指令四','指令五','指令六','指令七','指令八','指令九','指令十'])); true`);
    await home();
    const rows = await evalJS(cdp, sessionId, `(() => { const l = document.querySelector('[data-testid="quick-cmds-list"]'); return { clientH: l.clientHeight, scrollH: l.scrollHeight, scrollable: l.scrollHeight > l.clientHeight + 1 }; })()`);
    check("A8 可见高度不超过两行", rows.clientH <= 90, JSON.stringify(rows));

    // 恢复默认
    await clearQuick();
    await home();

    // A9 点击只填输入框不发送（点击后等一帧，让 React 完成重渲染）
    await evalJS(cdp, sessionId, `(() => { document.querySelector('button[data-cmd]').click(); return true; })()`);
    await sleep(500);
    const clickRes = await evalJS(cdp, sessionId, `(() => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      const c = document.querySelector('button[data-cmd]');
      return { input: ta.value, cmd: c.dataset.cmd, msgs: document.querySelectorAll('[data-msg-role]').length, focused: document.activeElement === ta };
    })()`);
    check("A9 点击后填入输入框", clickRes.input === clickRes.cmd && clickRes.input.length > 0, JSON.stringify(clickRes));
    check("A10 点击后不直接发送", clickRes.msgs === 0, JSON.stringify(clickRes));
    check("A11 输入框获得焦点", clickRes.focused === true, JSON.stringify(clickRes));
    await (async () => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); fs.writeFileSync(path.join(OUT, "crm-2-click-fill.png"), Buffer.from(r.data, "base64")); console.log("  -> 截图 crm-2-click-fill.png"); })();

    // A12 打开设置弹窗
    await evalJS(cdp, sessionId, `(() => { document.querySelector('[data-testid="quick-cmd-settings"]').click(); return true; })()`);
    await sleep(600);
    const opened = await evalJS(cdp, sessionId, `!!document.querySelector('[data-testid="quick-cmd-list"]')`);
    check("A12 设置图标可打开弹窗", opened === true);
    await sleep(500);
    const modal = await evalJS(cdp, sessionId, `(() => ({
      title: document.body.innerText.includes('设置快捷指令'),
      rows: document.querySelectorAll('[data-testid="quick-cmd-list"] input').length,
      hasAdd: !!document.querySelector('[data-testid="quick-cmd-add"]'),
      hasSave: !!document.querySelector('[data-testid="quick-cmd-save"]'),
      values: Array.from(document.querySelectorAll('[data-testid="quick-cmd-list"] input')).map(i => i.value),
    }))()`);
    check("A13 弹窗列出全部 4 条", modal.title && modal.rows === 4, JSON.stringify(modal));
    check("A14 弹窗有新增/保存按钮", modal.hasAdd && modal.hasSave);
    await (async () => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); fs.writeFileSync(path.join(OUT, "crm-3-editor.png"), Buffer.from(r.data, "base64")); console.log("  -> 截图 crm-3-editor.png"); })();

    // A15 新增 + A16 编辑
    const setInput = (idx, val) => `(() => { const i = document.querySelector('[data-testid="quick-cmd-input-${idx}"]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i, ${JSON.stringify(val)}); i.dispatchEvent(new Event('input',{bubbles:true})); return i.value; })()`;
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="quick-cmd-add"]').click()`);
    await sleep(400);
    check("A15 可新增一行", (await evalJS(cdp, sessionId, `document.querySelectorAll('[data-testid="quick-cmd-list"] input').length`)) === 5);
    await evalJS(cdp, sessionId, setInput(0, "改过的第一条指令"));
    await evalJS(cdp, sessionId, setInput(4, "新增的第五条"));
    await sleep(300);
    // A17 保存
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="quick-cmd-save"]').click()`);
    await sleep(900);
    const saved = await evalJS(cdp, sessionId, `(() => ({
      modalClosed: !document.querySelector('[data-testid="quick-cmd-list"]'),
      chips: Array.from(document.querySelectorAll('button[data-cmd]')).map(c => c.textContent),
      ls: JSON.parse(localStorage.getItem('crm-chat-quick-commands') || '[]'),
    }))()`);
    check("A16 保存后弹窗关闭", saved.modalClosed === true);
    check("A17 编辑 + 新增生效", saved.chips.includes("改过的第一条指令") && saved.chips.includes("新增的第五条") && saved.chips.length === 5, JSON.stringify(saved.chips));
    check("A18 配置写入 localStorage", saved.ls.length === 5 && saved.ls[0] === "改过的第一条指令", JSON.stringify(saved.ls));

    // A19 刷新后保持（注意：CRM 对话页刷新后停在已选会话；没有会话时才会新建）
    await cdp.send("Page.navigate", { url: `${BASE}/chat` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "刷新完成", 25000);
    await sleep(1800);
    let persisted = await evalJS(cdp, sessionId, `Array.from(document.querySelectorAll('button[data-cmd]')).map(c => c.dataset.cmd)`);
    if (!persisted || persisted.length === 0) {
      // 当前会话有历史消息 → 快捷指令本就该隐藏；点「新建对话」回到空会话再验
      await evalJS(cdp, sessionId, `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').includes('新建对话')); if (b) b.click(); return !!b; })()`);
      await waitFor(cdp, sessionId, "!!document.querySelector('button[data-cmd]')", "新建对话后快捷指令", 15000);
      await sleep(700);
      persisted = await evalJS(cdp, sessionId, `Array.from(document.querySelectorAll('button[data-cmd]')).map(c => c.dataset.cmd)`);
    }
    check("A19 刷新后配置保持", Array.isArray(persisted) && persisted.length === 5 && persisted[0] === "改过的第一条指令", JSON.stringify(persisted));

    // A20 删除（点击后等一帧再数行数）
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="quick-cmd-settings"]').click()`);
    await sleep(600);
    const beforeDel = await evalJS(cdp, sessionId, `document.querySelectorAll('[data-testid="quick-cmd-list"] input').length`);
    await evalJS(cdp, sessionId, `(() => { document.querySelector('[data-testid="quick-cmd-delete-0"]').click(); return true; })()`);
    await sleep(500);
    const afterDelRow = await evalJS(cdp, sessionId, `document.querySelectorAll('[data-testid="quick-cmd-list"] input').length`);
    check("A20 可删除一行", afterDelRow === beforeDel - 1, JSON.stringify({ beforeDel, afterDelRow }));
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="quick-cmd-save"]').click()`);
    await sleep(700);
    const afterDel = await evalJS(cdp, sessionId, `Array.from(document.querySelectorAll('button[data-cmd]')).map(c => c.textContent)`);
    check("A21 删除生效", afterDel.length === 4 && !afterDel.includes("改过的第一条指令"), JSON.stringify(afterDel));

    // A22 恢复默认
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="quick-cmd-settings"]').click()`);
    await sleep(600);
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="quick-cmd-reset"]').click()`);
    await sleep(500);
    const resetRows = await evalJS(cdp, sessionId, `Array.from(document.querySelectorAll('[data-testid="quick-cmd-list"] input')).map(i => i.value)`);
    check("A22 恢复默认可用", resetRows.length === 4 && resetRows[0] === "帮我查看本月线索情况", JSON.stringify(resetRows));
    await evalJS(cdp, sessionId, `document.querySelector('[data-testid="quick-cmd-cancel"]').click()`);
    await sleep(600);

    // A23 发送一条消息后快捷指令消失
    await evalJS(cdp, sessionId, `(() => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      s.call(ta, '测试快捷指令隐藏');
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await sleep(600);
    const sendRes = await evalJS(cdp, sessionId, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.title||'') === '发送');
      if (b) b.click();
      return { clicked: !!b };
    })()`);
    await sleep(2000);
    const afterSend = await evalJS(cdp, sessionId, `({ hasQuick: !!document.querySelector('[data-testid="quick-cmds"]'), msgs: document.querySelectorAll('[data-msg-role="user"]').length, clicked: ${JSON.stringify(sendRes)} })`);
    check("A23 发送后快捷指令消失", afterSend.hasQuick === false && afterSend.msgs >= 1, JSON.stringify(afterSend));
    await (async () => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); fs.writeFileSync(path.join(OUT, "crm-4-after-send.png"), Buffer.from(r.data, "base64")); console.log("  -> 截图 crm-4-after-send.png"); })();
  } catch (e) { console.error("ERR:", e.message); fail++; }
  finally {
    console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
    try { ws.close(); } catch {} try { chrome.kill(); } catch {}
    process.exit(fail ? 1 : 0);
  }
})();
