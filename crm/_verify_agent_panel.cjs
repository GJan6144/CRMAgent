/**
 * Agent 控制面板 —— 无头浏览器端到端验证 + 截图
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）：
 *   1) 启动无头 Chrome（独立 user-data-dir）
 *   2) 打开 /login，注入管理员登录态到 localStorage
 *   3) 打开 /agent，等待面板渲染，断言语义元素
 *   4) 分别对「概览 / 系统提示词 / 可用工具 / 工具权限」截图
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9933;
const BASE = "http://127.0.0.1:3100";
const OUT_DIR = process.argv[2] || path.join(__dirname, "_panel_screenshots");

// Skill 管理段的临时技能：放在真实技能来源目录里才能被扫盘发现。
// 用独立目录（而不是改真实技能），跑完即删，绝不污染已有技能。
const CHAT_UI_SKILLS_DIR =
  process.env.CHAT_UI_SKILLS_DIR ||
  path.join(__dirname, "..", "deepagents", "chat-ui", "skills");
const TMP_SKILL = "e2e-tmp-skill";
const TMP_SKILL_DIR = path.join(CHAT_UI_SKILLS_DIR, TMP_SKILL);
const TMP_SKILL_MD = [
  "---",
  `name: ${TMP_SKILL}`,
  "description: Temporary skill created by _verify_agent_panel.cjs — safe to delete.",
  "allowed-tools:",
  "  - read_file",
  "---",
  "",
  "# E2E Temp Skill",
  "",
  "只用于面板端到端验证，脚本跑完会删除。",
  "",
].join("\n");

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

async function getJSON(url) {
  const res = await fetch(url);
  return res.json();
}

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
    { format: "png", captureBeyondViewport: true },
    sessionId
  );
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(r.data, "base64"));
  console.log(`  -> 截图 ${file}`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-panel-"));

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
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId
  );

  // 前置：创建临时技能（幂等，先清掉上一轮残留）
  fs.rmSync(TMP_SKILL_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_SKILL_DIR, { recursive: true });
  fs.writeFileSync(path.join(TMP_SKILL_DIR, "SKILL.md"), TMP_SKILL_MD, "utf8");

  try {
    /* ---------- 1. 注入登录态 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/login` }, sessionId);
    await waitFor(cdp, sessionId, "document.readyState === 'complete'", "login 页加载");

    // 直接在页面上下文里调用登录接口，写入 localStorage（不落地任何凭据文件）
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
       })`
    );
    check("F1 注入管理员登录态", typeof store === "string" && store.length > 20,
      String(store).slice(0, 80));

    /* ---------- 2. 打开 Agent 控制面板 ---------- */
    await cdp.send("Page.navigate", { url: `${BASE}/agent` }, sessionId);
    const rendered = await waitFor(
      cdp,
      sessionId,
      "document.body.innerText.includes('Agent 控制面板')",
      "面板标题"
    );
    check("F2 面板页面渲染出标题", rendered);

    // 等概览数据加载（健康检查出现「正常」或「异常」）
    await waitFor(
      cdp,
      sessionId,
      "document.body.innerText.includes('服务健康检查') && /正常|异常|检测中/.test(document.body.innerText)",
      "概览指标"
    );
    await sleep(1500);

    const bodyText = await evalJS(cdp, sessionId, "document.body.innerText");
    for (const label of [
      "服务健康检查",
      "模型连通性",
      "今日调用次数",
      "平均响应耗时",
      "工具调用次数",
      "Token 消耗量",
    ]) {
      check(`F3 概览含指标卡「${label}」`, bodyText.includes(label));
    }
    check("F4 概览含服务信息区", bodyText.includes("服务信息"));
    check("F5 概览含趋势区", bodyText.includes("近 7 天调用趋势"));
    check("F6 侧边栏含 Agent 控制面板入口", bodyText.includes("Agent 控制面板"));

    await shoot(cdp, sessionId, "01-overview.png");

    /* ---------- 3. 切换「Agent 配置」 ---------- */
    const clickByText = async (text, tag = "button") => {
      const expr = `(() => {
        const els = Array.from(document.querySelectorAll('${tag}'));
        const el = els.find(e => (e.innerText || '').trim() === ${JSON.stringify(text)});
        if (!el) return false;
        el.click(); return true;
      })()`;
      return evalJS(cdp, sessionId, expr);
    };

    check("F7 可点击「Agent 配置」", await clickByText("Agent 配置"));
    await waitFor(cdp, sessionId, "document.body.innerText.includes('系统提示词')", "配置页");
    await sleep(800);

    const cfgText = await evalJS(cdp, sessionId, "document.body.innerText");
    check("F8 配置页含三个子页签",
      ["系统提示词", "可用工具", "工具权限"].every((t) => cfgText.includes(t)));

    // 系统提示词编辑器
    const promptInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const ta = document.querySelector('[data-testid="prompt-editor"]');
        return ta ? { ok: true, len: ta.value.length } : { ok: false, len: 0 };
      })()`
    );
    check("F9 系统提示词编辑器存在且非空", promptInfo.ok && promptInfo.len > 100,
      JSON.stringify(promptInfo));
    check("F10 有保存按钮", await evalJS(cdp, sessionId,
      `!!document.querySelector('[data-testid="prompt-save"]')`));
    await shoot(cdp, sessionId, "02-system-prompt.png");

    /* ---------- 4. 可用工具 ---------- */
    check("F11 可点击「可用工具」", await clickByText("可用工具"));
    await sleep(900);
    const toolsInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const rows = document.querySelectorAll('[data-testid^="tool-row-"]');
        const switches = document.querySelectorAll('[data-testid="tool-switch"]');
        return { rows: rows.length, switches: switches.length,
                 text: document.body.innerText.length };
      })()`
    );
    check("F12 工具行渲染", toolsInfo.rows >= 20, JSON.stringify(toolsInfo));
    check("F13 开关数量与工具行一致", toolsInfo.switches === toolsInfo.rows,
      JSON.stringify(toolsInfo));
    const toolText = await evalJS(cdp, sessionId, "document.body.innerText");
    check("F14 工具分组展示（CRM 业务数据）", toolText.includes("CRM 业务数据"));
    check("F15 工具分组展示（文件系统与 Shell）", toolText.includes("文件系统与 Shell"));
    await shoot(cdp, sessionId, "03-tools.png");

    /* ---------- 5. 工具权限 ---------- */
    check("F16 可点击「工具权限」", await clickByText("工具权限"));
    await sleep(900);
    const polInfo = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const rows = document.querySelectorAll('[data-testid^="policy-row-"]');
        const allow = document.querySelectorAll('[data-testid="policy-allow"]');
        const appr = document.querySelectorAll('[data-testid="policy-approval"]');
        const deny = document.querySelectorAll('[data-testid="policy-deny"]');
        return { rows: rows.length, allow: allow.length, appr: appr.length, deny: deny.length };
      })()`
    );
    check("F17 权限行渲染", polInfo.rows >= 20, JSON.stringify(polInfo));
    check("F18 每行三档权限按钮齐全",
      polInfo.allow === polInfo.rows && polInfo.appr === polInfo.rows && polInfo.deny === polInfo.rows,
      JSON.stringify(polInfo));
    const polText = await evalJS(cdp, sessionId, "document.body.innerText");
    check("F19 权限页含档位图例", ["直接使用", "人工审批", "禁止"].every((t) => polText.includes(t)));
    await shoot(cdp, sessionId, "04-tool-policy.png");

    /* ---------- 6. 交互：切换一个工具的权限档 ---------- */
    const before = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/config',{cache:'no-store'}).then(r=>r.json()).then(d=>d.tools.find(t=>t.name==='crm_query').policy)`);
    const toggled = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="policy-row-crm_query"]');
        if (!row) return false;
        const btn = row.querySelector('[data-testid="policy-approval"]');
        if (!btn) return false;
        btn.click(); return true;
      })()`
    );
    check("F20 可点击 crm_query 的「人工审批」", toggled);
    await sleep(1500);
    const after = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/config',{cache:'no-store'}).then(r=>r.json()).then(d=>d.tools.find(t=>t.name==='crm_query').policy)`);
    check("F21 权限变更已落库", before === "allow" && after === "approval",
      `before=${before} after=${after}`);

    // 复原
    await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/tools/crm_query/policy',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({policy:'allow'})}).then(r=>r.json()).then(()=>true)`);
    await sleep(600);

    /* ---------- 7. 交互：关闭一个工具的开关 ---------- */
    check("F22 可回到「可用工具」", await clickByText("可用工具"));
    await sleep(800);
    const swToggled = await evalJS(
      cdp,
      sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="tool-row-web_search"]');
        if (!row) return false;
        const sw = row.querySelector('[data-testid="tool-switch"]');
        if (!sw) return false;
        sw.click(); return true;
      })()`
    );
    check("F23 可点击 web_search 开关", swToggled);
    await sleep(1500);
    const wsEnabled = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/config',{cache:'no-store'}).then(r=>r.json()).then(d=>d.tools.find(t=>t.name==='web_search').enabled)`);
    check("F24 开关变更已落库（web_search 关闭）", wsEnabled === false, `enabled=${wsEnabled}`);
    await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/tools/web_search',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})}).then(r=>r.json()).then(()=>true)`);
    await sleep(600);
    await shoot(cdp, sessionId, "05-tools-after-toggle.png");

    /* ---------- 8. Skill 管理 ---------- */
    const apiSkills = () =>
      evalJS(cdp, sessionId,
        `fetch('/api/agent/panel/skills',{cache:'no-store'}).then(r=>r.json())`);

    // 归一化：把临时技能的开关强制拨回「开启」。
    // 上一轮如果中途崩了，配置里可能留着 {name: false} 的孤儿记录，
    // 那样本轮第一次点开关反而是在「开启」，断言会整体反过来（踩过一次）。
    await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/skills/${TMP_SKILL}',{method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({enabled:true})}).then(r=>r.json())`);
    await sleep(400);

    const baselineSkills = (await apiSkills()).summary.total;
    const baseState = await apiSkills();
    console.log(
      `  （基线技能数 ${baselineSkills}，含临时技能 ${TMP_SKILL}` +
      `，初始开关=${baseState.skills.find((s) => s.name === TMP_SKILL)?.enabled}）`
    );
    check("G0 临时技能起点为「开启」（前置归一化生效）",
      baseState.skills.find((s) => s.name === TMP_SKILL)?.enabled === true, "");

    check("G1 可点击「Skill 管理」Tab", await clickByText("Skill 管理"));
    await waitFor(cdp, sessionId,
      `document.body.innerText.includes('共') && document.querySelectorAll('[data-testid^="skill-row-"]').length > 0`,
      "Skill 管理页", 20000);
    await sleep(900);

    const skillInfo = await evalJS(cdp, sessionId,
      `(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid^="skill-row-"]'));
        return {
          rows: rows.length,
          names: rows.map(r => (r.getAttribute('data-testid') || '').replace('skill-row-','')),
          switches: document.querySelectorAll('[data-testid="tool-switch"]').length,
          edits: document.querySelectorAll('[data-testid="skill-edit"]').length,
          text: document.body.innerText,
        };
      })()`);

    // 注意 baselineSkills 是「临时技能已创建之后」取的，所以它本来就含 TMP_SKILL
    check("G2 技能行数与接口一致",
      skillInfo.rows === baselineSkills, JSON.stringify({ rows: skillInfo.rows, baselineSkills }));
    check("G3 临时技能出现在列表里",
      skillInfo.names.includes(TMP_SKILL), JSON.stringify(skillInfo.names));
    check("G4 每行一个开关", skillInfo.switches === skillInfo.rows, JSON.stringify(skillInfo));
    check("G5 每行一个编辑按钮", skillInfo.edits === skillInfo.rows, JSON.stringify(skillInfo));
    check("G6 展示功能简介（description）",
      skillInfo.text.includes("Temporary skill created by _verify_agent_panel.cjs"),
      "");
    check("G7 展示来源标签", skillInfo.text.includes("Chat UI") && skillInfo.text.includes("Built-in"), "");
    check("G8 汇总条给出来源计数",
      /共\s*\d+\s*个技能/.test(skillInfo.text) && skillInfo.text.includes("已开启"), "");

    await shoot(cdp, sessionId, "06-skill-management.png");

    /* ---------- 8a. 开关 ---------- */
    const swOff = await evalJS(cdp, sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="skill-row-${TMP_SKILL}"]');
        if (!row) return false;
        const sw = row.querySelector('[data-testid="tool-switch"]');
        if (!sw) return false;
        sw.click(); return true;
      })()`);
    check("G9 可点击临时技能的开关", swOff);
    await sleep(1600);

    const afterOff = await apiSkills();
    const offEntry = afterOff.skills.find((s) => s.name === TMP_SKILL);
    check("G10 关闭已落库", offEntry && offEntry.enabled === false,
      JSON.stringify({ enabled: offEntry && offEntry.enabled }));
    check("G11 汇总的已关闭数 +1", afterOff.summary.disabled >= 1,
      String(afterOff.summary.disabled));

    // 关闭必须真的影响模型能看到的东西，而不只是面板上的一个格子
    // 注意路径前缀：浏览器里只有 /api/agent/* 被 Next 代理到 chat-ui(8765)，
    // 直接打 /api/capabilities 会落到 Next 自己身上，拿到 HTML
    const capsOff = await evalJS(cdp, sessionId,
      `fetch('/api/agent/capabilities',{cache:'no-store'}).then(r=>r.json())`);
    check("G12 关闭后进入 capabilities.disabled_skills",
      (capsOff.disabled_skills || []).includes(TMP_SKILL),
      JSON.stringify(capsOff.disabled_skills));
    const ctxOff = await evalJS(cdp, sessionId,
      `fetch('/api/agent/context/e2e-skill-tab',{cache:'no-store'}).then(r=>r.json())`);
    check("G13 系统提示词出现「已关闭技能」段并点名",
      ctxOff.system_prompt.includes("## Disabled Skills") &&
      ctxOff.system_prompt.split("## Disabled Skills")[1].includes(TMP_SKILL), "");

    await shoot(cdp, sessionId, "07-skill-disabled.png");

    /* ---------- 8b. 编辑弹窗 ---------- */
    const opened = await evalJS(cdp, sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="skill-row-${TMP_SKILL}"]');
        if (!row) return false;
        const btn = row.querySelector('[data-testid="skill-edit"]');
        if (!btn) return false;
        btn.click(); return true;
      })()`);
    check("G14 可打开编辑弹窗", opened);
    await waitFor(cdp, sessionId,
      `(() => { const ta = document.querySelector('[data-testid="skill-editor"]');
                return !!ta && ta.value.length > 0; })()`,
      "SKILL.md 正文加载", 15000);
    await sleep(700);

    const editState = await evalJS(cdp, sessionId,
      `(() => {
        const ta = document.querySelector('[data-testid="skill-editor"]');
        return {
          title: document.body.innerText.split('\\n').find(l => l.includes('编辑 SKILL.md')) || '',
          value: ta ? ta.value : '',
          saveDisabled: (document.querySelector('[data-testid="skill-save"]') || {}).disabled,
        };
      })()`);
    check("G15 弹窗标题含技能名",
      editState.title.includes(TMP_SKILL), JSON.stringify(editState.title));
    check("G16 编辑器载入 SKILL.md 原文",
      editState.value.includes("---") && editState.value.includes(`name: ${TMP_SKILL}`) &&
      editState.value.includes("# E2E Temp Skill"), "");
    check("G17 未修改时保存按钮禁用", editState.saveDisabled === true,
      String(editState.saveDisabled));

    await shoot(cdp, sessionId, "08-skill-editor.png");

    /* ---------- 8c. 校验失败路径（框架会静默跳过的内容必须被拦下） ---------- */
    const setDraft = async (value) => evalJS(cdp, sessionId,
      `(() => {
        const ta = document.querySelector('[data-testid="skill-editor"]');
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(value)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);

    await setDraft(`---\nname: wrong-name\ndescription: x\n---\n\nbody\n`);
    await sleep(500);
    check("G18 修改后保存按钮可用", await evalJS(cdp, sessionId,
      `(document.querySelector('[data-testid="skill-save"]') || {}).disabled === false`));
    await evalJS(cdp, sessionId,
      `(() => { document.querySelector('[data-testid="skill-save"]').click(); return true; })()`);
    await waitFor(cdp, sessionId,
      `!!document.querySelector('[data-testid="skill-problems"]')`,
      "校验问题提示", 15000);
    const probText = await evalJS(cdp, sessionId,
      `(document.querySelector('[data-testid="skill-problems"]') || {}).innerText || ''`);
    check("G19 name 不一致时弹出校验问题", probText.includes("目录名"), probText.slice(0, 90));
    check("G20 弹窗保持打开（没被误关）",
      await evalJS(cdp, sessionId, `!!document.querySelector('[data-testid="skill-editor"]')`));
    const stillOld = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/skills/${TMP_SKILL}/content',{cache:'no-store'}).then(r=>r.json()).then(d=>d.content)`);
    check("G21 校验失败时磁盘文件未被改动",
      String(stillOld).includes(`name: ${TMP_SKILL}`), String(stillOld).slice(0, 40));
    await shoot(cdp, sessionId, "09-skill-validation.png");

    /* ---------- 8d. 正常保存 ---------- */
    // 同时改 description 与正文：列表行展示的是 description（正文不在列表里），
    // 只改正文的话「列表简介同步更新」这条断言永远不可能通过
    const EDITED = TMP_SKILL_MD
      .replace(
        "description: Temporary skill created by _verify_agent_panel.cjs — safe to delete.",
        "description: EDITED_BY_PANEL_E2E — 面板改过 description。"
      )
      .replace("只用于面板端到端验证，脚本跑完会删除。", "已由面板编辑保存（e2e）。");
    await setDraft(EDITED);
    await sleep(500);
    await evalJS(cdp, sessionId,
      `(() => { document.querySelector('[data-testid="skill-save"]').click(); return true; })()`);
    await waitFor(cdp, sessionId,
      `!document.querySelector('[data-testid="skill-problems"]') &&
       document.body.innerText.includes('SKILL.md 已保存')`,
      "保存成功提示", 15000);
    await sleep(800);

    const savedApi = await evalJS(cdp, sessionId,
      `fetch('/api/agent/panel/skills/${TMP_SKILL}/content',{cache:'no-store'}).then(r=>r.json())`);
    check("G22 保存已落库（回读一致）", savedApi.content === EDITED,
      JSON.stringify(savedApi.content.slice(-40)));
    const disk = fs.readFileSync(path.join(TMP_SKILL_DIR, "SKILL.md"), "utf8");
    check("G23 磁盘文件确实被改写", disk === EDITED, JSON.stringify(disk.slice(-30)));
    check("G24 编辑后列表里的简介同步更新",
      await evalJS(cdp, sessionId,
        `document.querySelector('[data-testid="skill-row-${TMP_SKILL}"]').innerText.includes('EDITED_BY_PANEL_E2E')`));

    // 备份落盘
    const backups = fs.existsSync(path.join(__dirname, "..", "deepagents", "chat-ui", "_skill_backups", TMP_SKILL))
      ? fs.readdirSync(path.join(__dirname, "..", "deepagents", "chat-ui", "_skill_backups", TMP_SKILL))
      : [];
    check("G25 旧版本已自动备份", backups.length >= 1, JSON.stringify(backups.slice(0, 2)));

    /* ---------- 8e. 关闭弹窗 + 开关复原 ---------- */
    check("G26 可关闭弹窗（取消）", await clickByText("取消"));
    await sleep(600);
    check("G27 弹窗已关闭",
      await evalJS(cdp, sessionId, `!document.querySelector('[data-testid="skill-editor"]')`));

    const swOn = await evalJS(cdp, sessionId,
      `(() => {
        const row = document.querySelector('[data-testid="skill-row-${TMP_SKILL}"]');
        if (!row) return false;
        row.querySelector('[data-testid="tool-switch"]').click(); return true;
      })()`);
    check("G28 可重新开启", swOn);
    await sleep(1600);
    const afterOn = await apiSkills();
    check("G29 重新开启已落库",
      afterOn.skills.find((s) => s.name === TMP_SKILL).enabled === true, "");
    check("G30 技能总数回到基线", afterOn.summary.total === baselineSkills,
      String(afterOn.summary.total));

    /* ---------- 9. 服务不可达时的容错（可选校验：无 JS 报错） ---------- */
    const errs = cdp.events.filter(
      (e) => e.method === "Runtime.exceptionThrown"
    );
    check("F25 页面无未捕获异常", errs.length === 0,
      JSON.stringify(errs.slice(0, 2)).slice(0, 300));
  } finally {
    // 无论成败都清掉临时技能（面板没有删除技能的能力，只能从磁盘删）。
    // ⚠️ 顺序很重要：开关记录必须**在目录还在时**清掉 —— 接口对不存在的技能
    // 会 404，先删目录就再也无法通过接口复原开关状态了。
    try {
      const put = await fetch(`http://127.0.0.1:8765/api/panel/skills/${TMP_SKILL}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }).catch(() => null);
      console.log(`  -> 复位 ${TMP_SKILL} 开关：HTTP ${put ? put.status : "n/a"}`);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(TMP_SKILL_DIR, { recursive: true, force: true });
      const bakDir = path.join(__dirname, "..", "deepagents", "chat-ui", "_skill_backups", TMP_SKILL);
      fs.rmSync(bakDir, { recursive: true, force: true });
      console.log(`  -> 已清理临时技能 ${TMP_SKILL}`);
    } catch (e) {
      console.log(`  !! 清理临时技能失败：${e.message}`);
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
  }

  console.log("");
  console.log("=".repeat(60));
  console.log(`前端验证: ${PASS.n}/${PASS.n + FAIL.length} 通过`);
  if (FAIL.length) console.log("失败项:", FAIL.join(", "));
  console.log("=".repeat(60));
  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => {
  console.error("验证脚本异常:", e);
  process.exit(2);
});
