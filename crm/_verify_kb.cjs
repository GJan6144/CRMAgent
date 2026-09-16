/**
 * Agent 知识库页 —— 无头浏览器端到端验证 + 截图
 *
 * 用本机 Chrome 的 CDP（不依赖 playwright）：
 *   1) 启动无头 Chrome（独立 user-data-dir）
 *   2) 打开 /login 并用真实接口取管理员登录态，注入 localStorage
 *   3) 打开 /kb，断言语义元素：侧边栏入口、统计卡、文件列表、详情抽屉
 *   4) 真实走一遍「选择文件 → 自动 Embedding → 进度展示 → 挂载生效」，
 *      再走一遍「删除 → 列表与统计回落」
 *   5) 分段截图，便于人工复核
 *
 * 会往真实知识库里写一个测试文件，但结束时连同上传副本一起删掉，
 * 并断言文档数回到基线。
 *
 * 用法：node _verify_kb.cjs [截图输出目录]
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9935;
const CRM_BASE = "http://127.0.0.1:3100";
const AGENT_BASE = "http://127.0.0.1:8765";
const OUT_DIR = process.argv[2] || path.join(__dirname, "_kb_screenshots");
const FILE = "_kb_verify_sample.csv";
const SAMPLE = path.join(__dirname, FILE);

const SAMPLE_CSV = `分类,问题,答案
验证用例,知识库页面上传验证的专属问题,这是上传验证生成的答案，用于确认自动向量化已生效
验证用例,同一分类下的第二个问题,第二个答案，用来确认一次入库会产出多篇文档
清理用例,这条会被删除环节清理掉,删除后应当无法再检索到
`;

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

/** 极简 CDP 客户端 */
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

async function evalJS(cdp, sid, expression) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sid
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

async function waitFor(cdp, sid, expression, label, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(cdp, sid, expression)) return true;
    } catch {
      /* 页面切换中，重试 */
    }
    await sleep(300);
  }
  console.log(`  ! 等待超时：${label}`);
  return false;
}

async function shot(cdp, sid, name) {
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log(`  · 截图 ${name}.png`);
  } catch (e) {
    console.log(`  ! 截图失败 ${name}: ${e.message}`);
  }
}

/** 页面语义快照 */
const PAGE_SNAPSHOT = `(() => {
  const nav = Array.from(document.querySelectorAll('aside nav a')).map(a => ({
    label: (a.innerText || '').trim(),
    href: a.getAttribute('href'),
    active: a.className.indexOf('text-blue-400') >= 0
  }));
  const rows = Array.from(document.querySelectorAll('table tbody tr')).map(tr =>
    Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim().replace(/\\s+/g, ' ')));
  // 只取**操作列**（最后一格）的按钮：片段数那一列现在也有个可点元素，
  // 混进来会让「操作列只有查看与删除」这条断言失去意义
  const rowButtons = Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
    const tds = tr.querySelectorAll('td');
    const last = tds[tds.length - 1];
    return last
      ? Array.from(last.querySelectorAll('button')).map(b => b.title || (b.innerText || '').trim())
      : [];
  });
  // 片段数列是否可点击（点开切片预览）
  const rowChunkClickable = Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
    const tds = tr.querySelectorAll('td');
    return !!(tds[4] && tds[4].querySelector('[data-chunk-count]'));
  });
  const cards = {};
  for (const d of Array.from(document.querySelectorAll('div'))) {
    if (!d.children || !d.children[0] || !d.children[1]) continue;
    const label = (d.children[0].innerText || '').trim();
    const value = (d.children[1].innerText || '').trim();
    if (['挂载文件','检索单元','语料字数','库文件大小','Embedding'].indexOf(label) >= 0) cards[label] = value;
  }
  const bars = Array.from(document.querySelectorAll('[role="progressbar"]'))
    .map(e => Number(e.getAttribute('aria-valuenow')));
  return {
    h1: (document.querySelector('h1') || {}).innerText || '',
    text: document.body.innerText || '',
    nav, rows, cards, bars, rowButtons, rowChunkClickable
  };
})()`;

/**
 * 定位到**指定文件**那张上传任务卡的状态。
 * 弹窗里会同时列出历史任务（也是「已完成」），不能靠全局文本判断当前上传的结果。
 */
const CARD_STATE = (name) => `(() => {
  const el = document.querySelector('[data-task-file="' + CSS.escape(${JSON.stringify(name)}) + '"]');
  if (!el) return null;
  const bar = el.querySelector('[role="progressbar"]');
  return {
    text: el.innerText || '',
    bar: bar ? Number(bar.getAttribute('aria-valuenow')) : -1
  };
})()`;

const clickByText = (tag, text) => `(() => {
  const el = Array.from(document.querySelectorAll('${tag}'))
    .find(x => (x.innerText || '').trim() === ${JSON.stringify(text)});
  if (!el) return false;
  el.click();
  return true;
})()`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SAMPLE, SAMPLE_CSV, "utf8");

  // ---------- 前置检查 ----------
  const baseList = await getJSON(`${AGENT_BASE}/api/kb/documents`);
  const baseline = baseList.stats;
  const srcOf = (d) => d.source || `doc:${d.doc_id}`;
  const groupBy = (docs) => {
    const m = new Map();
    for (const d of docs) {
      const k = srcOf(d);
      const g = m.get(k) || { docs: 0, chunks: 0 };
      g.docs += 1;
      g.chunks += d.n_chunks;
      m.set(k, g);
    }
    return m;
  };
  const baseGroups = groupBy(baseList.data);
  console.log(`基线：${baseline.documents} 篇文档 / ${baseline.chunks} 片段 / ${baseGroups.size} 个文件\n`);

  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "kbverify-"))}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1500,1040",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let ws;
  try {
    // ---------- 连接 Chrome ----------
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) {
      await sleep(500);
      try {
        ver = await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      } catch {
        /* 还没起来 */
      }
    }
    if (!ver) throw new Error("无头 Chrome 启动失败");

    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);
    await cdp.send("DOM.enable", {}, sid);

    // ---------- 注入登录态 ----------
    const loginRes = await fetch(`${CRM_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13912345678", password: "123123" }),
    });
    const auth = await loginRes.json();
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/login` }, sid);
    await sleep(1500);
    await evalJS(
      cdp,
      sid,
      `localStorage.setItem('crm_auth', ${JSON.stringify(JSON.stringify(auth))}); true`
    );

    // ---------- 打开知识库页 ----------
    await cdp.send("Page.navigate", { url: `${CRM_BASE}/kb` }, sid);
    const loaded = await waitFor(
      cdp,
      sid,
      `document.querySelector('h1') && document.querySelector('h1').innerText.indexOf('知识库') >= 0`,
      "知识库页渲染"
    );
    check("A0 页面加载成功且未白屏", loaded, "");
    await waitFor(
      cdp, sid,
      `document.querySelectorAll('table tbody tr').length > 0`,
      "文件列表渲染", 20000
    );
    await sleep(800);

    const a = await evalJS(cdp, sid, PAGE_SNAPSHOT);

    // ================= A. 导航与页面骨架 =================
    console.log("\n=== A. 导航与页面 ===");
    check("A1 侧边栏出现「Agent 知识库」入口",
      a.nav.some((l) => l.label === "Agent 知识库" && l.href === "/kb"),
      JSON.stringify(a.nav.map((l) => l.label)));
    check("A2 该入口为当前选中项",
      (a.nav.find((l) => l.href === "/kb") || {}).active === true, "");
    check("A3 页面标题为「Agent 知识库」", a.h1 === "Agent 知识库", a.h1);
    check("A4 五张统计卡齐全",
      Object.keys(a.cards).length === 5
      && String(a.cards["检索单元"]) === String(baseline.documents),
      JSON.stringify(a.cards));
    check("A5 右上角有「上传」按钮",
      a.text.includes("上传"), "");

    // ================= B. 文件列表 =================
    console.log("\n=== B. 文件列表 ===");
    check("B1 按来源文件聚合，行数与库内文件数一致",
      a.rows.length === Math.min(baseGroups.size, 5),
      `DOM ${a.rows.length} 行 / 库内 ${baseGroups.size} 个文件`);
    const csvName = "知识库：课程FAQ-1.0.csv";
    const csvRow = a.rows.find((r) => r[0].includes(csvName));
    check("B2 已有课程 FAQ 文件出现在列表中", !!csvRow, JSON.stringify(a.rows.map((r) => r[0])));
    const csvKey = [...baseGroups.keys()].find((k) => k.includes("课程FAQ"));
    const csv = baseGroups.get(csvKey) || {};
    const csvDocs = baseList.data.filter((d) => srcOf(d) === csvKey);
    check("B3 该行文档数与片段数与接口一致",
      !!csvRow && csvRow[3] === String(csv.docs) && csvRow[4] === String(csv.chunks),
      csvRow ? `DOM 文档${csvRow[3]}/片段${csvRow[4]} vs 接口 ${csv.docs}/${csv.chunks}` : "");
    check("B4 来源标记为「外部导入」（非本页上传）",
      !!csvRow && csvRow[2].includes("外部导入"), csvRow ? csvRow[2] : "");
    check("B5 操作列只有查看与删除，没有修改入口",
      a.rowButtons.every((bs) => bs.length === 2
        && bs.some((t) => t.includes("查看"))
        && bs.some((t) => t.includes("删除"))
        && !bs.some((t) => t.includes("修改") || t.includes("编辑"))),
      JSON.stringify(a.rowButtons));
    check("B6 未出现服务连接错误提示",
      !a.text.includes("无法连接 Agent 服务"), "");
    check("B7 【片段数】字段可点击（点开切片预览）",
      a.rowChunkClickable.length > 0 && a.rowChunkClickable.every(Boolean),
      JSON.stringify(a.rowChunkClickable));
    await shot(cdp, sid, "01_列表");

    // ================= C. 文件详情 / 切片预览抽屉 =================
    console.log("\n=== C. 详情抽屉与切片预览 ===");
    await evalJS(cdp, sid,
      `(() => { const cell = document.querySelector('table tbody tr td'); const el = cell.querySelector('div') || cell; el.click(); return true; })()`);
    const drawerOpen = await waitFor(cdp, sid, `document.body.innerText.indexOf('切片预览') >= 0`, "抽屉打开");
    check("C1 点击文件名可打开详情抽屉", drawerOpen, "");
    const c = await evalJS(cdp, sid, PAGE_SNAPSHOT);
    check("C2 抽屉里按文档分组列出该文件拆出的检索单元",
      c.text.includes("课程FAQ · 购买与售后") && c.text.includes("课程FAQ · 适合人群"), "");
    check("C3 抽屉标注「已挂载」与来源类型",
      c.text.includes("已挂载") && c.text.includes("外部导入"), "");

    // —— 切片正文（本次新增能力的核心断言）——
    const chunkInfo = await evalJS(cdp, sid, `(() => {
      const cards = Array.from(document.querySelectorAll('[data-chunk-id]'));
      return {
        count: cards.length,
        texts: Array.from(document.querySelectorAll('[data-chunk-text]'))
          .map(n => (n.innerText || '').trim()),
        marks: cards.map(n => {
          const t = (n.innerText || '').trim().replace(/\\s+/g, ' ');
          return {
            idx: (t.match(/^#(\\d+)/) || [])[1] || '',
            chars: (t.match(/([\\d,]+) 字/) || [])[1] || '',
            head: t.slice(0, 30),
          };
        }),
        chips: document.querySelectorAll('[data-doc-chip]').length,
      };
    })()`);
    check("C4 抽屉里展示切片后的正文（每个片段一块）",
      chunkInfo.count > 0 && chunkInfo.texts.length === chunkInfo.count
      && chunkInfo.texts.every((t) => t.length > 0),
      `${chunkInfo.count} 个片段 / ${chunkInfo.texts.length} 块正文`);
    check("C5 展示的片段数与接口一致（切片一个不少）",
      chunkInfo.count === csv.chunks, `DOM ${chunkInfo.count} vs 接口 ${csv.chunks}`);
    check("C6 每个片段带序号与字数",
      chunkInfo.marks.length > 0
      && chunkInfo.marks.every((m) => m.idx !== '')
      && chunkInfo.marks.every((m) => m.chars !== ''),
      JSON.stringify(chunkInfo.marks.slice(0, 2)));
    check("C7 正文就是切片内容本身（保留问答原文）",
      chunkInfo.texts.some((t) => t.includes("问：") && t.includes("答：")),
      chunkInfo.texts[0] ? chunkInfo.texts[0].slice(0, 40) : "");
    check("C8 提供按文档筛选的入口（多篇文档时）",
      chunkInfo.chips === csvDocs.length + 1,
      `${chunkInfo.chips} 个 chip / ${csvDocs.length} 篇文档`);
    await shot(cdp, sid, "02_切片预览");

    // —— 按文档筛选 ——
    const target = csvDocs[csvDocs.length - 1];
    const chipClick = (id) => `(() => {
      const b = document.querySelector('[data-doc-chip="' + CSS.escape(${JSON.stringify("__ID__")}) + '"]');
      if (!b) return false; b.click(); return true;
    })()`.replace("__ID__", id);
    await evalJS(cdp, sid, chipClick(target.doc_id));
    await sleep(600);
    const filtered = await evalJS(cdp, sid, `document.querySelectorAll('[data-chunk-id]').length`);
    check("C9 点文档 chip 只筛出该文档的片段",
      filtered === target.n_chunks,
      `筛选后 ${filtered} vs 「${target.title}」${target.n_chunks}`);
    await shot(cdp, sid, "02b_切片筛选");
    await evalJS(cdp, sid, chipClick(target.doc_id));
    await sleep(500);
    const restored = await evalJS(cdp, sid, `document.querySelectorAll('[data-chunk-id]').length`);
    check("C10 再点一次取消筛选，恢复全部片段",
      restored === csv.chunks, `${restored} vs ${csv.chunks}`);

    // —— 关闭 / 从「片段数」重开 ——
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    }, sid);
    await sleep(700);
    const closed = await evalJS(cdp, sid, `document.body.innerText.indexOf('切片预览') < 0`);
    check("C11 抽屉可关闭", closed, "");

    const countClicked = await evalJS(cdp, sid, `(() => {
      const b = document.querySelector('td [data-chunk-count]');
      if (!b) return false; b.click(); return true;
    })()`);
    const reopened = await waitFor(
      cdp, sid, `document.body.innerText.indexOf('切片预览') >= 0`, "点片段数重开抽屉", 15000
    );
    check("C12 点击【片段数】字段也能打开切片预览",
      countClicked && reopened, `clicked=${countClicked}`);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    }, sid);
    await sleep(600);

    // ================= D. 上传 → 自动 Embedding → 挂载 =================
    console.log("\n=== D. 上传与处理进度 ===");
    const clicked = await evalJS(cdp, sid, clickByText("button", "上传"));
    check("D1 点击「上传」打开上传弹窗",
      clicked && (await waitFor(cdp, sid, `document.body.innerText.indexOf('拖到这里') >= 0`, "上传弹窗")),
      "");

    // 弹窗打开时会拉取服务端的历史处理记录；先清掉，避免同名历史任务干扰
    // 后面「当前这次上传」的判定（历史任务也是「已完成」，会假阳性）。
    //
    // ⚠️ 这一步必须**先等历史加载完**再点：`openUpload()` 里的 `loadTasks()` 不 await，
    // 而「清空记录」按钮只在 `tasks.length > 0` 时才渲染 —— 抢在它返回前点，按钮
    // 压根不存在，点击静默落空，紧接着响应回来正好把记录填上，D2 就会「随机」挂。
    // （产品侧也一并加代际校验，但测试不该依赖那个来兜底。）
    const hist = await evalJS(cdp, sid,
      `fetch('/api/agent/kb/tasks?limit=20',{cache:'no-store'}).then(r=>r.json())` +
      `.then(d=>({n:(d.data||[]).length,active:!!d.active}))`);
    if (hist.n > 0) {
      await waitFor(cdp, sid,
        `!!document.querySelector('[data-testid="kb-clear-tasks"]')`,
        "历史处理记录已加载", 10000);
    }
    const clickedClear = await evalJS(cdp, sid, clickByText("button", "清空记录"));
    await sleep(400);
    const cleared = await evalJS(cdp, sid, PAGE_SNAPSHOT);
    check("D2 处理记录可清空（弹窗会加载历史记录）",
      cleared.bars.length === 0 && (hist.n === 0 || clickedClear),
      `历史 ${hist.n} 条 / 点击成功=${clickedClear} / 剩余进度条 ${cleared.bars.length}`);
    await shot(cdp, sid, "03_上传弹窗");

    const doc = await cdp.send("DOM.getDocument", { depth: -1 }, sid);
    const { nodeId } = await cdp.send(
      "DOM.querySelector",
      { nodeId: doc.root.nodeId, selector: 'input[type="file"]' },
      sid
    );
    await cdp.send("DOM.setFileInputFiles", { files: [SAMPLE], nodeId }, sid);

    const appeared = await waitFor(
      cdp, sid,
      `(() => { const s = ${CARD_STATE(FILE)}; return !!s; })()`,
      "处理记录出现", 20000
    );
    check("D3 选择文件后立即出现该文件的处理记录", appeared, "");
    const d1 = (await evalJS(cdp, sid, CARD_STATE(FILE))) || { text: "", bar: -1 };
    check("D4 记录里展示处理阶段与进度条",
      d1.bar >= 0 && /排队中|解析内容|文本切块|向量化|写入索引|已完成/.test(d1.text),
      `bar=${d1.bar} · ${d1.text.replace(/\n/g, " | ").slice(0, 80)}`);
    await shot(cdp, sid, "04_处理中");

    const finished = await waitFor(
      cdp, sid,
      `(() => { const s = ${CARD_STATE(FILE)};
        return !!s && s.bar === 100 && s.text.indexOf('已完成') >= 0; })()`,
      "该文件处理完成", 180000
    );
    check("D5 处理完成（该文件自身进度到 100、状态「已完成」）", finished, "");
    const card = (await evalJS(cdp, sid, CARD_STATE(FILE))) || { text: "", bar: -1 };
    check("D6 进度条达到 100", card.bar === 100, `bar=${card.bar}`);
    check("D7 结果里列出产出的检索单元（片段 / token / 分类标题）",
      card.text.includes("片段") && card.text.includes("token")
      && card.text.includes("验证用例") && card.text.includes("清理用例"),
      card.text.replace(/\n/g, " | ").slice(0, 120));
    check("D8 识别为问答表并按分类拆分",
      card.text.includes("问答表"), card.text.replace(/\n/g, " | ").slice(0, 120));
    await shot(cdp, sid, "05_处理完成");

    // 关闭弹窗，回到列表
    await evalJS(cdp, sid, clickByText("button", "关闭"))
      || (await evalJS(cdp, sid, clickByText("button", "后台继续处理")));
    await sleep(2500);

    let e = await evalJS(cdp, sid, PAGE_SNAPSHOT);
    const newRow = e.rows.find((r) => r[0].includes(FILE));
    check("D9 关闭弹窗后新文件出现在列表", !!newRow, JSON.stringify(e.rows.map((r) => r[0])));
    check("D10 新文件标记为「本页上传」",
      !!newRow && newRow[2].includes("本页上传"), newRow ? newRow[2] : "");
    check("D11 新文件拆成 2 篇文档（两个分类）",
      !!newRow && newRow[3] === "2", newRow ? newRow[3] : "");
    check("D12 检索单元统计已增加",
      Number(e.cards["检索单元"]) === baseline.documents + 2,
      `${e.cards["检索单元"]} vs ${baseline.documents + 2}`);
    await shot(cdp, sid, "06_新文件已挂载");

    // 接口侧确认真的进了向量索引
    const afterUpload = await getJSON(`${AGENT_BASE}/api/kb/documents`);
    const uploaded = afterUpload.data.filter((x) => (x.source || "").includes(FILE));
    check("D13 接口侧确认已入库 2 篇、共 3 个片段",
      uploaded.length === 2 && uploaded.reduce((s, x) => s + x.n_chunks, 0) === 3,
      `${uploaded.length} 篇 / ${uploaded.reduce((s, x) => s + x.n_chunks, 0)} 片段`);

    // ================= E. 删除 =================
    console.log("\n=== E. 删除 ===");
    const rowIdx = e.rows.findIndex((r) => r[0].includes(FILE));
    await evalJS(cdp, sid, `(() => {
      const tr = document.querySelectorAll('table tbody tr')[${rowIdx}];
      const btns = Array.from(tr.querySelectorAll('button'));
      const del = btns.find(b => (b.title || '').indexOf('删除') >= 0);
      if (!del) return false;
      del.click();
      return true;
    })()`);
    const modal = await waitFor(cdp, sid, `document.body.innerText.indexOf('即将从知识库移除') >= 0`, "删除确认框");
    check("E1 点击删除弹出二次确认", modal, "");
    const e1 = await evalJS(cdp, sid, PAGE_SNAPSHOT);
    check("E2 确认框说明了影响范围",
      e1.text.includes("篇文档") && e1.text.includes("检索片段")
      && e1.text.includes("同时清理上传到知识库目录的文件副本"), "");
    await shot(cdp, sid, "07_删除确认");

    await evalJS(cdp, sid, clickByText("button", "确认删除"));
    const gone = await waitFor(
      cdp, sid,
      `!Array.from(document.querySelectorAll('table tbody tr')).some(tr => tr.innerText.indexOf(${JSON.stringify(FILE)}) >= 0)`,
      "行消失", 30000
    );
    check("E3 确认后该文件从列表移除", gone, "");
    const e2 = await evalJS(cdp, sid, PAGE_SNAPSHOT);
    check("E4 页面给出删除结果提示",
      e2.text.includes("已删除") || e2.text.includes("清理了上传的文件副本"), "");
    check("E5 检索单元统计回落到基线",
      Number(e2.cards["检索单元"]) === baseline.documents,
      `${e2.cards["检索单元"]} vs ${baseline.documents}`);
    await shot(cdp, sid, "08_删除后");

    const finalList = await getJSON(`${AGENT_BASE}/api/kb/documents`);
    check("E6 接口侧确认文档数与片段数完全回到基线",
      finalList.stats.documents === baseline.documents
      && finalList.stats.chunks === baseline.chunks,
      `${finalList.stats.documents}/${finalList.stats.chunks} vs ${baseline.documents}/${baseline.chunks}`);
    check("E7 原有课程 FAQ 文档未被波及",
      finalList.data.every((x) => !(x.source || "").includes(FILE))
      && finalList.data.length === baseline.documents, "");
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    chrome.kill();
    try {
      const left = await getJSON(`${AGENT_BASE}/api/kb/documents`);
      const orphan = left.data.filter((x) => (x.source || "").includes(FILE));
      if (orphan.length) {
        await fetch(`${AGENT_BASE}/api/kb/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc_ids: orphan.map((x) => x.doc_id) }),
        });
        console.log(`  （兜底清理：删除 ${orphan.length} 篇残留测试文档）`);
      }
    } catch { /* ignore */ }
    try { fs.unlinkSync(SAMPLE); } catch { /* ignore */ }
    console.log(`\n${"=".repeat(52)}`);
    console.log(`通过 ${PASS.n} 项，失败 ${FAIL.length} 项`);
    if (FAIL.length) console.log(`失败项：\n  - ${FAIL.join("\n  - ")}`);
    console.log(`截图目录：${OUT_DIR}`);
  }
  process.exit(FAIL.length ? 1 : 0);
}

main().catch((e) => {
  console.error("验证脚本异常：", e);
  process.exit(2);
});
