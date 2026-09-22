"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Markdown from "@/lib/markdown";
import DataCard from "./DataCard";
import Modal from "./Modal";
import Sidebar from "./Sidebar";
import TodoPanel from "./TodoPanel";
import type {
  AgentEvent,
  AgentMessage,
  AgentSession,
  AgentTodo,
  ApprovalRequest,
  CardPayload,
  ChatFile,
  ChatImage,
  ChatMessage,
  ConnectionState,
  ContextUsage,
  PanelModel,
  ToolActivity,
} from "@/types/agent";

/* ============================ 设计变量 ============================ */

const PRIMARY = "#2563EB";
const BORDER = "#E2E8F0";
const TEXT = "#0F172A";
const MUTED = "#64748B";
const SUBTLE = "#94A3B8";

/* ============================ 常量 ============================ */

/** 会话列表收起状态在 localStorage 里的键名 */
const LIST_COLLAPSED_KEY = "crm-chat-list-collapsed";

/** 快捷指令在 localStorage 里的键名（用户可配置，仅本机保存） */
const QUICK_CMD_KEY = "crm-chat-quick-commands";

/** 当前选用模型在 localStorage 里的键名 */
const CHAT_MODEL_KEY = "crm-chat-model";

/** 单条快捷指令最多显示的汉字数，超出截断并显示 … */
const QUICK_CMD_MAX_CHARS = 10;

/** 快捷指令默认值 */
const DEFAULT_QUICK_CMDS = [
  "帮我查看本月线索情况",
  "统计各销售的成单金额",
  "看看有哪些待跟进客户",
  "生成上月销售月报",
];

/** 会话列表展开时的宽度 */
const LIST_WIDTH = 228;

/** 工具名 → 中文展示名 */
const TOOL_LABELS: Record<string, string> = {
  get_current_time: "查询时间",
  web_search: "联网搜索",
  web_fetch: "抓取网页",
  get_weather: "查询天气",
  write_todos: "规划任务",
  store_memory: "写入记忆",
  recall_memory: "读取记忆",
  get_project_info: "读取项目信息",
  task: "调用子代理",
  execute: "执行命令",
  ls: "浏览目录",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "修改文件",
  glob: "查找文件",
  grep: "搜索内容",
  // CRM 读取
  crm_list_entities: "查看 CRM 数据结构",
  crm_query: "查询 CRM 数据",
  crm_get: "读取 CRM 记录",
  crm_stats: "统计 CRM 数据",
  // CRM 写入（需审批）
  crm_create: "新增 CRM 数据",
  crm_update: "修改 CRM 数据",
  crm_delete: "删除 CRM 数据",
};

/** 工具调用状态 → 展示样式 */
const TOOL_STATUS: Record<
  ToolActivity["status"],
  { label: string; color: string; bg: string; border: string }
> = {
  running: { label: "进行中", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  pending: { label: "等待审批", color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" },
  success: { label: "成功", color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0" },
  error: { label: "失败", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  blocked: { label: "禁止", color: "#B91C1C", bg: "#FEE2E2", border: "#FCA5A5" },
};

const OFFLINE_HINT =
  "无法连接 DeepAgents 服务。请先启动 deepagents 项目的 chat-ui 服务（默认 http://127.0.0.1:8765）。";

/* ============================ 工具函数 ============================ */

/** 解析 SSE 响应流，逐事件回调 */
async function readSSE(response: Response, onEvent: (event: AgentEvent) => void) {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      for (const rawLine of block.split("\n")) {
        const line = rawLine.trimStart();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as AgentEvent);
        } catch {
          // 半截 JSON，跳过
        }
      }
    }
  }
}

function eventField<T>(event: AgentEvent, key: string, fallback: T): T {
  const value = (event as Record<string, unknown>)[key];
  return (value === undefined || value === null ? fallback : value) as T;
}

/**
 * 任务清单归一化：SSE 事件（字段可能缺省）与接口还原（历史数据）共用同一套兜底。
 * 顺序即执行顺序，保持原样；状态不在白名单内一律按「未开始」处理。
 */
function normalizeTodos(raw: unknown): AgentTodo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      content: typeof t.content === "string" ? t.content : "",
      status:
        t.status === "completed" || t.status === "in_progress"
          ? (t.status as AgentTodo["status"])
          : ("pending" as AgentTodo["status"]),
    }))
    .filter((t) => t.content !== "");
}

/* ============================ 子组件 ============================ */

/**
 * 快捷指令截断：汉字（含全角标点）按 1 个字计算，半角字符按 0.5 计算，
 * 累计超过 QUICK_CMD_MAX_CHARS 立即截断并补 …，完整文字由 title 提供。
 */
function truncateQuickCmd(text: string): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.5;
    if (width > QUICK_CMD_MAX_CHARS) return `${out}…`;
    out += ch;
  }
  return out;
}

/** 读取本地保存的快捷指令；无有效配置时回落到默认值 */
function readQuickCmds(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_CMD_KEY);
    if (!raw) return [...DEFAULT_QUICK_CMDS];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const list = parsed
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length > 0) return list;
    }
  } catch {
    /* 隐私模式或数据损坏，回落到默认值 */
  }
  return [...DEFAULT_QUICK_CMDS];
}

/** 弹窗底部按钮样式 */
function modalBtn(bg: string, color: string, border: string): React.CSSProperties {
  return {
    padding: "8px 16px",
    borderRadius: 9,
    border: `1px solid ${border}`,
    background: bg,
    color,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

/** token 数格式化：1.2M / 34.5K / 980 */
function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(n || 0));
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (v >= 1000) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}K`;
  }
  return String(v);
}

/** 占用比例对应的主题色（绿 → 琥珀 → 红，与面板口径一致） */
function contextTone(ratio: number): { stroke: string; bg: string; text: string; label: string } {
  if (ratio >= 0.9) return { stroke: "#DC2626", bg: "#FEF2F2", text: "#B91C1C", label: "接近上限" };
  if (ratio >= 0.7) return { stroke: "#B45309", bg: "#FFFBEB", text: "#B45309", label: "偏高" };
  return { stroke: "#2563EB", bg: "#EFF6FF", text: "#2563EB", label: "充足" };
}

/** 文件体积格式化：2.4 MB / 512 KB / 87 B */
function fmtBytes(n: number): string {
  const v = Math.max(0, n || 0);
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${Math.round(v)} B`;
}

/**
 * 上下文环形饼图图标。
 *
 * 用 SVG 双层圆环实现：底层轨道 + 上层用 `strokeDasharray` 画进度弧。
 * `ratio` 按 0~1 钳制，超过 1（上下文溢出）也画满圈并转红色。
 */
function ContextRing({
  ratio,
  size = 18,
  stroke = 2.6,
  color,
  track = "#E2E8F0",
}: {
  ratio: number;
  size?: number;
  stroke?: number;
  color: string;
  track?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, Math.max(0, ratio || 0));
  const dash = c * pct;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block", flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray .35s ease" }}
      />
    </svg>
  );
}

/**
 * 对话流里的图片附件。
 *
 * 历史 / 实时消息只带元数据（id + 文件名），这里按需拉 `GET /api/images/{id}`
 * 拿 data_url 再渲染，避免一次加载整段会话就搬运大量 base64。
 */
function ImageAttachments({ images }: { images: ChatImage[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const missing = images.filter((i) => i.id && !urls[i.id]);
    if (!missing.length) return () => { cancelled = true; };
    void (async () => {
      const next: Record<string, string> = {};
      for (const img of missing) {
        try {
          const res = await fetch(`/api/agent/images/${img.id}`, { cache: "force-cache" });
          if (!res.ok) continue;
          const data = (await res.json()) as { data_url?: string };
          if (data?.data_url) next[img.id] = data.data_url;
        } catch {
          // 单张失败不影响其它图片
        }
      }
      if (!cancelled && Object.keys(next).length) setUrls((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [images, urls]);

  return (
    <div
      data-testid="chat-image-attachments"
      style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: images.length ? 8 : 0 }}
    >
      {images.map((img) => (
        <a
          key={img.id}
          data-testid="chat-image-attachment"
          href={urls[img.id] || undefined}
          target="_blank"
          rel="noreferrer"
          title={`${img.filename}（${fmtBytes(img.size)}）`}
          style={{
            display: "block",
            borderRadius: 10,
            overflow: "hidden",
            border: `1px solid ${BORDER}`,
            background: "#F8FAFC",
            textDecoration: "none",
          }}
        >
          {urls[img.id] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={urls[img.id]}
              alt={img.filename}
              style={{ display: "block", maxWidth: 220, maxHeight: 160, objectFit: "cover" }}
            />
          ) : (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 120,
                height: 80,
                fontSize: 11,
                color: SUBTLE,
              }}
            >
              {img.filename}
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

/**
 * 文件名标签缩写：保留扩展名，主干过长时中间省略。
 *
 * 例：`2026年第三季度销售数据分析报告.txt` → `2026年第三…分析报告.txt`
 * 无扩展名时退化为单纯截断。上限按**字符数**算（CJK 与半角同权），保证中文名不被切碎。
 */
function truncateFileName(name: string, max = 22): string {
  const full = (name || "").trim();
  if (full.length <= max) return full;
  const dot = full.lastIndexOf(".");
  // 扩展名过长（或没扩展名）时不保留后缀，避免「.tar.gz」之类把预算吃光
  const ext = dot > 0 && full.length - dot <= 8 ? full.slice(dot) : "";
  const stem = ext ? full.slice(0, dot) : full;
  const keep = Math.max(4, max - ext.length - 1); // 1 个字符留给省略号
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(stem.length - tail) : ""}${ext}`;
}

/** 文件类型 → 小徽标文案（当前仅 txt；后续扩格式时在此分支） */
function fileKindLabel(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "txt") return "TXT";
  return ext ? ext.toUpperCase().slice(0, 4) : "FILE";
}

/**
 * 对话流里的**文件附件**：以标签文字形式展示（不下载、不预览正文）。
 *
 * 服务端历史接口只回元数据，这里纯静态渲染，不发请求。
 */
function FileAttachments({ files }: { files: ChatFile[] }) {
  if (!files.length) return null;
  return (
    <div
      data-testid="chat-file-attachments"
      style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}
    >
      {files.map((f) => (
        <span
          key={f.id}
          data-testid="chat-file-attachment"
          title={`${f.filename}（${fmtBytes(f.size)}${
            typeof f.chars === "number" ? ` · ${f.chars} 字` : ""
          }）`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 260,
            padding: "4px 9px",
            borderRadius: 8,
            border: `1px solid ${BORDER}`,
            background: "#F8FAFC",
            fontSize: 12,
            color: TEXT,
          }}
        >
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              padding: "0 4px",
              borderRadius: 4,
              background: "#E0E7FF",
              color: PRIMARY,
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 0.3,
            }}
          >
            {fileKindLabel(f.filename)}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.filename}
          </span>
        </span>
      ))}
    </div>
  );
}

/** 快捷指令编辑弹窗：增 / 删 / 改，保存后由父组件落盘 */
function QuickCmdEditor({
  open,
  items,
  onChange,
  onClose,
  onSave,
  onReset,
}: {
  open: boolean;
  items: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [focusIdx, setFocusIdx] = useState(-1);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (open) setFocusIdx(-1);
  }, [open]);

  useEffect(() => {
    if (focusIdx >= 0) inputRefs.current[focusIdx]?.focus();
  }, [focusIdx, items.length]);

  return (
    <Modal open={open} onClose={onClose} title="设置快捷指令" width="520px">
      <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.7, marginBottom: 14 }}>
        编辑、新增或删除快捷指令。点击指令只会把文字填入输入框，不会直接发送。
      </div>

      <div
        data-testid="quick-cmd-list"
        style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}
      >
        {items.length === 0 ? (
          <div style={{ fontSize: 13, color: SUBTLE, textAlign: "center", padding: "16px 0" }}>
            暂无快捷指令，点击下方「新增一条」添加
          </div>
        ) : (
          items.map((value, idx) => (
            <div key={idx} data-testid={`quick-cmd-row-${idx}`} style={{ display: "flex", gap: 8 }}>
              <input
                ref={(el) => {
                  inputRefs.current[idx] = el;
                }}
                data-testid={`quick-cmd-input-${idx}`}
                type="text"
                value={value}
                placeholder="请输入指令文字"
                onChange={(e) => onChange(items.map((v, i) => (i === idx ? e.target.value : v)))}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: `1px solid ${BORDER}`,
                  fontSize: 13.5,
                  fontFamily: "inherit",
                  color: TEXT,
                  outline: "none",
                  background: "#fff",
                }}
              />
              <button
                data-testid={`quick-cmd-delete-${idx}`}
                title="删除该指令"
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
                style={{
                  flexShrink: 0,
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  border: `1px solid ${BORDER}`,
                  background: "#fff",
                  color: MUTED,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      <button
        data-testid="quick-cmd-add"
        onClick={() => {
          onChange([...items, ""]);
          setFocusIdx(items.length);
        }}
        style={{
          marginTop: 10,
          padding: "8px 14px",
          borderRadius: 9,
          border: `1px dashed ${BORDER}`,
          background: "#fff",
          color: MUTED,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        ＋ 新增一条
      </button>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
        <button
          data-testid="quick-cmd-reset"
          onClick={onReset}
          style={modalBtn("#fff", MUTED, BORDER)}
        >
          恢复默认
        </button>
        <button
          data-testid="quick-cmd-cancel"
          onClick={onClose}
          style={modalBtn("#fff", "#475569", BORDER)}
        >
          取消
        </button>
        <button
          data-testid="quick-cmd-save"
          onClick={onSave}
          style={modalBtn(PRIMARY, "#fff", PRIMARY)}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

/** 消息流中的 Agent 头像 */
function AgentAvatar() {
  return (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        flexShrink: 0,
        marginTop: 2,
        background: "linear-gradient(135deg, #2563EB, #60A5FA)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "-0.02em",
      }}
    >
      AI
    </div>
  );
}

/** 思考过程折叠块 */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px",
          borderRadius: 20,
          border: `1px solid ${BORDER}`,
          background: "#F8FAFC",
          color: MUTED,
          fontSize: 11.5,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        思考过程
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            padding: "10px 12px",
            background: "#F8FAFC",
            border: `1px solid ${BORDER}`,
            borderRadius: 9,
            fontSize: 12.5,
            lineHeight: 1.7,
            color: MUTED,
            whiteSpace: "pre-wrap",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** 单条工具调用的展开详情（参数 / 结果） */
function ToolRowDetail({ tool }: { tool: ToolActivity }) {
  return (
    <div
      style={{
        padding: "0 11px 8px 30px",
        fontSize: 11.5,
        lineHeight: 1.65,
        color: MUTED,
      }}
    >
      {tool.args ? (
        <div style={{ marginBottom: tool.result ? 4 : 0, wordBreak: "break-all" }}>
          <span style={{ color: SUBTLE }}>参数：</span>
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
            {tool.args}
          </span>
        </div>
      ) : null}
      {tool.result ? (
        <div style={{ marginBottom: 0 }}>
          <span style={{ color: SUBTLE }}>结果：</span>
          <span
            style={{
              display: "inline-block",
              maxHeight: 190,
              overflowY: "auto",
              verticalAlign: "top",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {tool.result}
          </span>
        </div>
      ) : null}
      {!tool.args && !tool.result ? (
        <div style={{ color: SUBTLE }}>（暂无更多信息）</div>
      ) : null}
    </div>
  );
}

/**
 * 工具调用列表。
 * 默认收起：折叠头显示「工具调用 · N 个」与状态汇总；
 * 展开后每个工具调用占一行，展示 工具名 + 中文名 + 参数摘要 + 状态；
 * 点击某一行可再看该工具的完整参数与结果。
 */
function ToolList({ tools }: { tools: ToolActivity[] }) {
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const counts = {
    running: tools.filter((t) => t.status === "running").length,
    pending: tools.filter((t) => t.status === "pending").length,
    success: tools.filter((t) => t.status === "success").length,
    error: tools.filter((t) => t.status === "error").length,
    blocked: tools.filter((t) => t.status === "blocked").length,
  };
  const hasError = counts.error > 0;
  const hasBlocked = counts.blocked > 0;

  const parts: string[] = [];
  if (counts.success) parts.push(`${counts.success} 成功`);
  if (counts.error) parts.push(`${counts.error} 失败`);
  if (counts.blocked) parts.push(`${counts.blocked} 禁止`);
  if (counts.pending) parts.push(`${counts.pending} 等待审批`);
  if (counts.running) parts.push(`${counts.running} 进行中`);

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="tool-list-toggle"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          padding: "4px 11px",
          borderRadius: 20,
          border: `1px solid ${hasError || hasBlocked ? "#FECACA" : BORDER}`,
          background: hasError || hasBlocked ? "#FEF2F2" : "#F8FAFC",
          color: hasError || hasBlocked ? "#B91C1C" : MUTED,
          fontSize: 11.5,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        <span>工具调用 · {tools.length} 个</span>
        {parts.length > 0 ? (
          <span style={{ color: hasError ? "#DC2626" : hasBlocked ? "#B91C1C" : SUBTLE, fontWeight: 500 }}>
            {parts.join(" / ")}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          data-testid="tool-list-body"
          style={{
            marginTop: 6,
            border: `1px solid ${BORDER}`,
            borderRadius: 9,
            background: "#FCFDFF",
            overflow: "hidden",
          }}
        >
          {tools.map((tool, i) => {
            const meta = TOOL_STATUS[tool.status] ?? TOOL_STATUS.success;
            const hasDetail = Boolean(tool.args || tool.result);
            const expanded = detailId === tool.id;
            const label = TOOL_LABELS[tool.name];
            return (
              <div
                key={tool.id}
                style={{ borderTop: i === 0 ? "none" : "1px solid #F1F5F9" }}
              >
                <div
                  onClick={hasDetail ? () => setDetailId(expanded ? null : tool.id) : undefined}
                  data-testid="tool-row"
                  data-tool-name={tool.name}
                  data-tool-status={tool.status}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 11px",
                    fontSize: 12,
                    cursor: hasDetail ? "pointer" : "default",
                    background: tool.status === "blocked" ? "#FFF5F5" : undefined,
                  }}
                >
                  <span
                    className={tool.status === "running" ? "chat-dot" : undefined}
                    style={{
                      color: meta.color,
                      fontSize: tool.status === "blocked" ? 11 : 9,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    {tool.status === "blocked" ? "⛔" : "●"}
                  </span>
                  <span
                    style={{
                      fontWeight: 600,
                      color: TEXT,
                      whiteSpace: "nowrap",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    }}
                  >
                    {tool.name}
                  </span>
                  {label && label !== tool.name ? (
                    <span style={{ color: MUTED, fontSize: 11, whiteSpace: "nowrap" }}>
                      {label}
                    </span>
                  ) : null}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: SUBTLE,
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    }}
                  >
                    {tool.args ?? ""}
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      padding: "1px 7px",
                      borderRadius: 20,
                      background: meta.bg,
                      color: meta.color,
                      border: `1px solid ${meta.border}`,
                      fontSize: 10.5,
                      fontWeight: 600,
                    }}
                  >
                    {meta.label}
                  </span>
                  {hasDetail ? (
                    <span style={{ color: SUBTLE, fontSize: 10, flexShrink: 0 }}>
                      {expanded ? "▾" : "▸"}
                    </span>
                  ) : null}
                </div>
                {expanded && hasDetail ? <ToolRowDetail tool={tool} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 等待中的呼吸点 */
function TypingDots() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, height: 20 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="chat-dot"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: SUBTLE,
            animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
    </div>
  );
}

/** 会话列表项 */
function SessionItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: AgentSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onSelect}
      data-session-item="true"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 10px",
        borderRadius: 9,
        cursor: "pointer",
        marginBottom: 2,
        background: active ? "#EFF6FF" : hover ? "#F8FAFC" : "transparent",
        transition: "background .12s",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke={active ? PRIMARY : SUBTLE}
        strokeWidth="2"
        width="14"
        height="14"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
          color: active ? PRIMARY : "#334155",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {session.title || "新对话"}
      </span>
      {(hover || active) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="删除对话"
          style={{
            flexShrink: 0,
            width: 18,
            height: 18,
            border: "none",
            background: "transparent",
            borderRadius: 5,
            cursor: "pointer",
            color: SUBTLE,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#DC2626";
            e.currentTarget.style.background = "#FEF2F2";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = SUBTLE;
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" width="11" height="11" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** 写操作审批卡片（文件修改 / CRM 业务数据写入） */
function ApprovalCard({
  requests,
  onDecide,
}: {
  requests: ApprovalRequest[];
  onDecide: (approved: boolean) => void;
}) {
  const kinds = new Set(requests.map((r) => String(r.kind ?? "fs")));
  const title =
    kinds.size === 1 && kinds.has("crm")
      ? "Agent 请求修改 CRM 业务数据，需要你确认"
      : kinds.size === 1 && kinds.has("fs")
      ? "Agent 请求修改文件，需要你确认"
      : "Agent 请求执行以下操作，需要你确认";

  return (
    <div
      data-testid="approval-card"
      style={{
        marginTop: 8,
        padding: "12px 14px",
        background: "#FFFBEB",
        border: "1px solid #FDE68A",
        borderRadius: 10,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309", marginBottom: 6 }}>
        {title}
      </div>
      {requests.length > 0 && (
        <div style={{ fontSize: 12, color: "#92400E", marginBottom: 10, lineHeight: 1.7 }}>
          {requests.map((req, i) => {
            const name = String(req.name ?? req.tool ?? "工具调用");
            const label = TOOL_LABELS[name];
            const args =
              typeof req.args === "string" ? req.args : req.args ? JSON.stringify(req.args) : "";
            return (
              <div key={i} data-testid="approval-item">
                <span style={{ fontWeight: 600 }}>{name}</span>
                {label ? <span style={{ color: "#B45309" }}>（{label}）</span> : null}
                {args ? (
                  <div style={{ marginLeft: 12, color: "#A16207", wordBreak: "break-all" }}>
                    {args}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => onDecide(true)}
          style={smallButton(PRIMARY, "#fff")}
          data-testid="approval-approve"
        >
          确认执行
        </button>
        <button
          onClick={() => onDecide(false)}
          style={smallButton("#fff", "#475569")}
          data-testid="approval-reject"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

function smallButton(bg: string, color: string): React.CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 8,
    border: `1px solid ${color === "#fff" ? "transparent" : BORDER}`,
    background: bg,
    color,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    lineHeight: 1.2,
  };
}

/* ---------------------------- 面板收/展按钮 ---------------------------- */

/**
 * 会话列表的「收起 / 展开」按钮。
 * 收起按钮位于会话列表顶栏，展开按钮位于会话详情页顶栏最左侧，两者共用此组件。
 */
function PanelToggle({
  direction,
  onClick,
  testId,
}: {
  direction: "collapse" | "expand";
  onClick: () => void;
  testId: string;
}) {
  const [hover, setHover] = useState(false);
  const collapsing = direction === "collapse";
  const label = collapsing ? "收起" : "展开";
  const hint = collapsing ? "收起会话列表" : "展开会话列表";

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      title={hint}
      aria-label={hint}
      aria-expanded={!collapsing}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "5px 9px",
        borderRadius: 7,
        border: `1px solid ${hover ? "#BFDBFE" : BORDER}`,
        background: hover ? "#EFF6FF" : "#fff",
        color: hover ? PRIMARY : MUTED,
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "inherit",
        lineHeight: 1,
        whiteSpace: "nowrap",
        cursor: "pointer",
        transition: "background 140ms ease, border-color 140ms ease, color 140ms ease",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        width="13"
        height="13"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {collapsing ? (
          <polyline points="15 18 9 12 15 6" />
        ) : (
          <polyline points="9 18 15 12 9 6" />
        )}
      </svg>
      {label}
    </button>
  );
}

/** 复制成功后停留的毫秒数 */
const COPY_FEEDBACK_MS = 1500;

/**
 * 把文本写入系统剪切板。
 * 优先用异步 Clipboard API（HTTPS / localhost 可用），失败则回落到
 * 隐藏 textarea + execCommand("copy")（非安全上下文的老办法）。
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级到 execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 消息级「复制」快捷按钮。
 * 只负责取文本 + 落剪切板 + 短暂的成功反馈（图标变对勾），不改动消息本身。
 */
function CopyButton({
  getText,
  testId,
}: {
  getText: () => string;
  testId: string;
}) {
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const handleCopy = useCallback(async () => {
    const text = getText();
    if (!text) return;
    const ok = await writeClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }, [getText]);

  const hint = copied ? "已复制" : "复制";

  return (
    <button
      type="button"
      onClick={handleCopy}
      data-testid={testId}
      data-copied={copied ? "1" : "0"}
      title={hint}
      aria-label={hint}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 7px",
        borderRadius: 7,
        border: `1px solid ${copied ? "#A7F3D0" : hover ? "#BFDBFE" : "transparent"}`,
        background: copied ? "#ECFDF5" : hover ? "#EFF6FF" : "transparent",
        color: copied ? "#059669" : hover ? PRIMARY : SUBTLE,
        fontSize: 11.5,
        fontWeight: 600,
        fontFamily: "inherit",
        lineHeight: 1,
        whiteSpace: "nowrap",
        cursor: "pointer",
        transition: "background 140ms ease, border-color 140ms ease, color 140ms ease",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        width="13"
        height="13"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {copied ? (
          <polyline points="20 6 9 17 4 12" />
        ) : (
          <>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </>
        )}
      </svg>
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/* ============================ 主组件 ============================ */

export default function ChatDashboard() {
  /**
   * 当前登录用户 / 角色 —— 随每条消息发给 Agent 服务端。
   * 服务端据此读 roles.json 算出「AI 助手」页的数据范围（全部 / 仅自己），
   * 由此决定 Agent 里 CRM 工具的读写范围。前端只声明身份，不声明权限。
   */
  const { user, role } = useAuth();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [useSearch, setUseSearch] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [pendingDelete, setPendingDelete] = useState<AgentSession | null>(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  /**
   * 任务清单的展开状态，**按消息 id 记录**（清单挂在消息上，每轮回答各自一份）。
   * 键不存在 = 收起：历史消息打开就是一行，当前这轮在收到第一份清单时才自动展开。
   */
  const [todoCollapsed, setTodoCollapsed] = useState<Record<string, boolean>>({});
  /** 快捷指令（用户可在弹窗里增删改，保存到 localStorage） */
  const [quickCmds, setQuickCmds] = useState<string[]>(DEFAULT_QUICK_CMDS);
  const [quickEditorOpen, setQuickEditorOpen] = useState(false);
  /** 弹窗内的草稿，点「保存」才写回 quickCmds */
  const [quickDraft, setQuickDraft] = useState<string[]>([]);
  /** 可切换的模型列表（来自「Agent 管理面板 → 模型管理」中已开启的模型） */
  const [models, setModels] = useState<PanelModel[]>([]);
  /** 当前选中的模型 id；空串表示跟随服务端默认 */
  const [modelId, setModelId] = useState<string>("");
  /** 待发送的图片附件（已上传，只持有 id/文件名等元数据） */
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
  /** 图片上传中（禁止重复点击 / 发送） */
  const [uploadingImage, setUploadingImage] = useState(false);
  /** 图片相关提示（类型不支持 / 超限等） */
  const [imageError, setImageError] = useState("");
  /** 待发送的**文件附件**（已上传，只持有 id/文件名等元数据） */
  const [pendingFiles, setPendingFiles] = useState<ChatFile[]>([]);
  /** 文件附件上传中 */
  const [uploadingFile, setUploadingFile] = useState(false);
  /** 文件附件相关提示（类型不支持 / 超限等） */
  const [fileError, setFileError] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stickToBottom = useRef(true);
  const sendingRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /* 会话列表收起状态：挂载时读取本地偏好（避免 SSR 阶段访问 localStorage） */
  useEffect(() => {
    try {
      if (localStorage.getItem(LIST_COLLAPSED_KEY) === "1") setListCollapsed(true);
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略即可 */
    }
  }, []);

  /* 快捷指令：同样在挂载后读取，避免 SSR 阶段访问 localStorage */
  useEffect(() => {
    setQuickCmds(readQuickCmds());
  }, []);

  /* 可切换模型：拉取「模型管理」中已开启的模型；选中项缓存在 localStorage */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/agent/models", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { models: PanelModel[]; selected: string };
        if (!alive) return;
        setModels(data.models ?? []);
        let saved = "";
        try {
          saved = localStorage.getItem(CHAT_MODEL_KEY) || "";
        } catch {
          /* 忽略 */
        }
        const list = data.models ?? [];
        const valid = list.some((m) => m.id === saved);
        setModelId(valid ? saved : data.selected || (list[0]?.id ?? ""));
      } catch {
        /* 服务不可用时静默降级：不显示模型下拉框 */
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  /** 切换模型：立即生效（下一轮请求带上），并落盘记住 */
  const changeModel = useCallback((id: string) => {
    setModelId(id);
    try {
      localStorage.setItem(CHAT_MODEL_KEY, id);
    } catch {
      /* 忽略写入失败 */
    }
  }, []);

  /** 上下文用量（底部环形图标 + 弹窗）；null = 尚无数据，不渲染图标 */
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [contextOpen, setContextOpen] = useState(false);

  /** 拉取指定会话的上下文用量（刷新 / 切换会话 / 切换模型时恢复） */
  const refreshContext = useCallback(
    async (sessionId: string | null, model?: string) => {
      if (!sessionId) {
        setContextUsage(null);
        return;
      }
      try {
        const qs = model ? `?model=${encodeURIComponent(model)}` : "";
        const res = await fetch(`/api/agent/sessions/${sessionId}/context${qs}`, { cache: "no-store" });
        if (!res.ok) return;
        setContextUsage((await res.json()) as ContextUsage);
      } catch {
        /* 静默降级：拿不到就不显示图标 */
      }
    },
    [],
  );

  /** 打开快捷指令设置（把当前配置拷成草稿） */
  const openQuickEditor = useCallback(() => {
    setQuickDraft([...quickCmds]);
    setQuickEditorOpen(true);
  }, [quickCmds]);

  /** 保存快捷指令：去空行 → 立即回落到默认，否则写入本地 */
  const saveQuickCmds = useCallback(() => {
    const cleaned = quickDraft.map((s) => s.trim()).filter(Boolean);
    const next = cleaned.length > 0 ? cleaned : [...DEFAULT_QUICK_CMDS];
    setQuickCmds(next);
    try {
      localStorage.setItem(QUICK_CMD_KEY, JSON.stringify(next));
    } catch {
      /* 忽略写入失败 */
    }
    setQuickEditorOpen(false);
  }, [quickDraft]);

  /** 恢复默认（只改草稿，仍需点保存才生效） */
  const resetQuickCmds = useCallback(() => {
    setQuickDraft([...DEFAULT_QUICK_CMDS]);
  }, []);

  /** 点击快捷指令：只填入输入框并聚焦，不直接发送 */
  const applyQuickCmd = useCallback((text: string) => {
    setInput(text);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => {
        el.selectionStart = el.value.length;
        el.selectionEnd = el.value.length;
      });
    }
  }, []);

  /** 切换会话列表收起状态并落盘 */
  const toggleList = useCallback((collapsed: boolean) => {
    setListCollapsed(collapsed);
    try {
      localStorage.setItem(LIST_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* 忽略写入失败 */
    }
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId]
  );

  /* ---------------- 数据请求 ---------------- */

  const markOffline = useCallback(() => {
    setConnection("offline");
  }, []);

  const loadSessions = useCallback(async (): Promise<AgentSession[]> => {
    try {
      const res = await fetch("/api/agent/sessions", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as AgentSession[];
      const list = Array.isArray(data) ? data : [];
      setSessions(list);
      setConnection("online");
      return list;
    } catch {
      markOffline();
      return [];
    }
  }, [markOffline]);

  const loadMessages = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`/api/agent/sessions/${sessionId}/messages`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as AgentMessage[];

        // 会话已被切换、或正在发送中 → 丢弃本次结果，避免覆盖新内容
        if (sessionId !== activeIdRef.current || sendingRef.current) return;

        const list: ChatMessage[] = [];
        let lastAssistant: ChatMessage | null = null;

        for (const item of Array.isArray(data) ? data : []) {
          if (item.role === "thinking") {
            if (lastAssistant) {
              lastAssistant.thinking = lastAssistant.thinking
                ? `${lastAssistant.thinking}\n${item.content}`
                : item.content;
            }
            continue;
          }
          const message: ChatMessage = {
            id: item.id,
            role: item.role === "user" ? "user" : "assistant",
            content: item.content,
            created_at: item.created_at,
          };
          // 还原落库的数据卡片（刷新页面后仍展示）
          if (message.role === "assistant" && Array.isArray(item.cards) && item.cards.length > 0) {
            message.cards = item.cards;
          }
          // 还原落库的任务清单（刷新页面后仍展示；缺省收起，点标题栏可展开）
          if (message.role === "assistant") {
            const restored = normalizeTodos(item.todos);
            if (restored.length > 0) message.todos = restored;
          }
          // 还原落库的图片附件元数据（原图按需经 /api/agent/images/{id} 取）
          if (Array.isArray(item.images) && item.images.length > 0) {
            message.images = item.images;
          }
          // 还原落库的文件附件元数据（对话流以标签文字展示，无需再取正文）
          if (Array.isArray(item.files) && item.files.length > 0) {
            message.files = item.files;
          }
          list.push(message);
          if (message.role === "assistant") lastAssistant = message;
        }

        setMessages(list);
        stickToBottom.current = true;
      } catch {
        if (sessionId === activeIdRef.current && !sendingRef.current) {
          setMessages([]);
        }
      }
    },
    []
  );

  const createSession = useCallback(async (): Promise<AgentSession | null> => {
    try {
      const res = await fetch("/api/agent/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "新对话",
          // 会话归属：用于「按用户统计 token 消耗」。服务端只声明身份、自行判定权限。
          user_phone: user?.phone || "",
          user_name: user?.name || "",
          role_id: user?.roleId || role?.id || "",
          role_name: user?.roleName || role?.name || "",
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const session = (await res.json()) as AgentSession;
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      activeIdRef.current = session.id;
      setMessages([]);
      setConnection("online");
      return session;
    } catch {
      markOffline();
      return null;
    }
  }, [markOffline, user, role]);

  /* ---------------- 生命周期 ---------------- */

  useEffect(() => {
    (async () => {
      const list = await loadSessions();
      if (list.length > 0) setActiveId(list[0].id);
    })();
  }, [loadSessions]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    if (sendingRef.current) return;
    stickToBottom.current = true;
    // 清单随消息走，切会话时把上一会话的展开状态清掉即可（新会话默认全部收起）
    setTodoCollapsed({});
    void loadMessages(activeId);
  }, [activeId, loadMessages]);

  /* 切换会话 / 模型后恢复上下文环形图标（新会话无历史则回落为 0） */
  useEffect(() => {
    if (!activeId) {
      setContextUsage(null);
      return;
    }
    void refreshContext(activeId, modelId || undefined);
  }, [activeId, modelId, refreshContext]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ---------------- 输入框 ---------------- */

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  /* ---------------- 图片附件 ---------------- */

  /** 单条消息最多附带的图片数（与服务端 MAX_IMAGES_PER_MESSAGE 保持一致） */
  const MAX_IMAGES = 4;
  const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
  const MAX_IMAGE_MB = 5;

  /* ---------------- 文件附件（当前仅 txt） ---------------- */

  /** 单条消息最多附带的文件数（与服务端 MAX_FILES_PER_MESSAGE 保持一致） */
  const MAX_FILES = 4;
  /** 允许的附件扩展名（与服务端 file_store.ALLOWED_EXTS 保持一致） */
  const FILE_EXTS = [".txt"];
  const MAX_FILE_MB = 5;
  /** 加号按钮的选择器 accept：图片 + 文本附件合并（按要求沿用同一个入口） */
  const ATTACH_ACCEPT = `${IMAGE_ACCEPT},${FILE_EXTS.join(",")},text/plain`;

  /** 判断是否为文本附件（按扩展名，别信浏览器给的 MIME） */
  const isAttachFile = (f: File) =>
    FILE_EXTS.includes(`.${(f.name.split(".").pop() || "").toLowerCase()}`);

  const imageInputRef = useRef<HTMLInputElement>(null);

  /** 立即上传选中文件，返回已入库的图片元数据 */
  const uploadImageFile = useCallback(async (file: File): Promise<ChatImage> => {
    const res = await fetch(
      `/api/agent/images?filename=${encodeURIComponent(file.name)}&session_id=${encodeURIComponent(
        activeIdRef.current ?? "",
      )}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    );
    if (!res.ok) {
      let detail = `上传失败（HTTP ${res.status}）`;
      try {
        const data = await res.json();
        if (data?.detail) detail = String(data.detail);
      } catch {
        // 忽略解析失败
      }
      throw new Error(detail);
    }
    return (await res.json()) as ChatImage;
  }, []);

  /** 立即上传文本附件，返回已入库的文件元数据 */
  const uploadAttachFile = useCallback(async (file: File): Promise<ChatFile> => {
    const res = await fetch(
      `/api/agent/files?filename=${encodeURIComponent(file.name)}&session_id=${encodeURIComponent(
        activeIdRef.current ?? "",
      )}`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: file,
      },
    );
    if (!res.ok) {
      let detail = `上传失败（HTTP ${res.status}）`;
      try {
        const data = await res.json();
        if (data?.detail) detail = String(data.detail);
      } catch {
        // 忽略解析失败
      }
      throw new Error(detail);
    }
    return (await res.json()) as ChatFile;
  }, []);

  /**
   * 统一处理「加号选文件」与「剪切板粘贴」的附件引入。
   *
   * 按文件类型自动分流：图片走 `/api/images`，`.txt` 走 `/api/files`。
   * 两侧都受各自的上限约束（数量 / 体积），超额给出中文提示。
   */
  const ingestAttachments = useCallback(
    async (files: File[] | FileList | null) => {
      const list = files ? Array.from(files) : [];
      if (!list.length) return;
      setImageError("");
      setFileError("");

      const images = list.filter((f) => f.type.startsWith("image/"));
      const texts = list.filter((f) => isAttachFile(f));
      const rejected = list.filter((f) => !f.type.startsWith("image/") && !isAttachFile(f));

      if (rejected.length) {
        setFileError(
          `「${rejected[0].name}」不是支持的附件类型（当前支持图片与 ${FILE_EXTS.join(" / ")}）`,
        );
      }

      // ---- 图片通道 ----
      if (images.length) {
        const room = MAX_IMAGES - pendingImages.length;
        if (room <= 0) {
          setImageError(`最多只能附带 ${MAX_IMAGES} 张图片`);
        } else {
          if (images.length > room) setImageError(`最多只能附带 ${MAX_IMAGES} 张图片`);
          setUploadingImage(true);
          try {
            const uploaded: ChatImage[] = [];
            for (const f of images.slice(0, room)) {
              if (f.size > MAX_IMAGE_MB * 1024 * 1024) {
                setImageError(`「${f.name}」超过 ${MAX_IMAGE_MB}MB 上限`);
                continue;
              }
              try {
                uploaded.push(await uploadImageFile(f));
              } catch (e) {
                setImageError(e instanceof Error ? e.message : "图片上传失败");
              }
            }
            if (uploaded.length) {
              setPendingImages((prev) => [...prev, ...uploaded].slice(0, MAX_IMAGES));
            }
          } finally {
            setUploadingImage(false);
          }
        }
      }

      // ---- 文本附件通道 ----
      if (texts.length) {
        const room = MAX_FILES - pendingFiles.length;
        if (room <= 0) {
          setFileError(`最多只能附带 ${MAX_FILES} 个文件`);
        } else {
          if (texts.length > room) setFileError(`最多只能附带 ${MAX_FILES} 个文件`);
          setUploadingFile(true);
          try {
            const uploaded: ChatFile[] = [];
            for (const f of texts.slice(0, room)) {
              if (f.size > MAX_FILE_MB * 1024 * 1024) {
                setFileError(`「${f.name}」超过 ${MAX_FILE_MB}MB 上限`);
                continue;
              }
              try {
                uploaded.push(await uploadAttachFile(f));
              } catch (e) {
                setFileError(e instanceof Error ? e.message : "文件上传失败");
              }
            }
            if (uploaded.length) {
              setPendingFiles((prev) => [...prev, ...uploaded].slice(0, MAX_FILES));
            }
          } finally {
            setUploadingFile(false);
          }
        }
      }

      // 清空 input.value，否则连续选同一个文件不触发 change
      if (imageInputRef.current) imageInputRef.current.value = "";
    },
    [pendingFiles.length, pendingImages.length, uploadAttachFile, uploadImageFile],
  );

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((i) => i.id !== id));
    setImageError("");
  }, []);

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((i) => i.id !== id));
    setFileError("");
  }, []);

  /** 附件（图片 + 文件）是否已达各自上限 —— 加号按钮统一按此禁用 */
  const attachLimitReached =
    pendingImages.length >= MAX_IMAGES && pendingFiles.length >= MAX_FILES;
  const attachDisabled = sending || uploadingImage || uploadingFile || attachLimitReached;

  /** 有文本或任一附件即可发送 */
  const canSend =
    !!input.trim() || pendingImages.length > 0 || pendingFiles.length > 0;

  /* ---------------- 剪切板粘贴导入 ---------------- */

  /**
   * 输入框粘贴：从系统剪切板取**文件**并作为附件引入。
   *
   * 复制「文件本身」（资源管理器 Ctrl+C）与截图工具复制的图片都能命中
   * `clipboardData.files`。⚠️ 纯文本粘贴不拦截 —— 没有文件时直接 return，
   * 让浏览器走默认的文本粘贴行为，否则会破坏正常打字。
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const files = Array.from(dt.files || []);
      if (!files.length) return; // 纯文本 → 交给默认行为
      e.preventDefault();
      void ingestAttachments(files);
    },
    [ingestAttachments],
  );

  /* ---------------- 发送 ---------------- */

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const imageIds = pendingImages.map((i) => i.id);
    const fileIds = pendingFiles.map((f) => f.id);
    // 允许「只发附件」：有文本或任一附件即可发送
    if ((!text && !imageIds.length && !fileIds.length) || sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setApprovals([]);

    let sessionId = activeId;
    if (!sessionId) {
      const created = await createSession();
      if (!created) {
        sendingRef.current = false;
        setSending(false);
        return;
      }
      sessionId = created.id;
    }

    const stamp = Date.now();
    const aiMsgId = `a-${stamp}`;
    const userMsg: ChatMessage = {
      id: `u-${stamp}`,
      role: "user",
      content: text,
      // 图片以附件形式单独成条渲染；文件附件以标签文字展示（见下方用户消息分块）
      images: pendingImages.length ? pendingImages : undefined,
      files: pendingFiles.length ? pendingFiles : undefined,
    };
    const aiMsg: ChatMessage = {
      id: aiMsgId,
      role: "assistant",
      content: "",
      thinking: "",
      tools: [],
      pending: true,
    };

    setMessages((prev) => [...prev, userMsg, aiMsg]);
    setInput("");
    setPendingImages([]);
    setImageError("");
    setPendingFiles([]);
    setFileError("");
    stickToBottom.current = true;

    const patch = (updater: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === aiMsgId ? updater(m) : m)));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          content: text,
          use_search: useSearch,
          model: modelId || undefined,
          image_ids: imageIds,
          file_ids: fileIds,
          // 身份随行：服务端据此判定 Agent 的 CRM 数据读写范围（全部 / 仅自己）
          user_phone: user?.phone || "",
          user_name: user?.name || "",
          role_id: user?.roleId || role?.id || "",
          role_name: user?.roleName || role?.name || "",
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let detail = `请求失败（HTTP ${res.status}）`;
        try {
          const data = await res.json();
          if (data?.error) {
            detail = data.detail ? `${data.error}（${data.detail}）` : data.error;
          }
        } catch {
          // 忽略
        }
        throw new Error(detail);
      }

      setConnection("online");

      await readSSE(res, (event) => {
        switch (event.event) {
          case "llm_token": {
            const token = String(eventField(event, "token", ""));
            if (token) patch((m) => ({ ...m, content: m.content + token }));
            break;
          }
          case "llm_thinking": {
            const chunk = String(eventField(event, "thinking", ""));
            if (chunk) patch((m) => ({ ...m, thinking: `${m.thinking ?? ""}${chunk}` }));
            break;
          }
          case "tool_start": {
            const name = String(eventField(event, "name", "tool"));
            const args = String(eventField(event, "args", ""));
            const rawId = String(eventField(event, "id", ""));
            const toolId = rawId || `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            patch((m) => {
              const list = m.tools ?? [];
              // 同一 tool_call 可能被服务端重复推送，按 id 去重
              if (rawId && list.some((t) => t.id === rawId)) return m;
              return {
                ...m,
                tools: [...list, { id: toolId, name, args, status: "running" as const }],
              };
            });
            break;
          }
          case "tool_end": {
            const name = String(eventField(event, "name", "tool"));
            const result = String(eventField(event, "result", ""));
            const status = String(eventField(event, "tool_status", "success"));
            const id = String(eventField(event, "id", ""));
            patch((m) => {
              const tools = [...(m.tools ?? [])];
              const next = status === "success" ? ("success" as const) : ("error" as const);
              let idx = id ? tools.findIndex((t) => t.id === id) : -1;
              if (idx < 0) {
                // 回退：按名称匹配最近一个尚未结束的调用
                for (let i = tools.length - 1; i >= 0; i -= 1) {
                  const st = tools[i].status;
                  if (tools[i].name === name && (st === "running" || st === "pending")) {
                    idx = i;
                    break;
                  }
                }
              }
              if (idx >= 0) {
                tools[idx] = { ...tools[idx], result: result || tools[idx].result, status: next };
              }
              return { ...m, tools };
            });
            break;
          }
          case "tool_blocked": {
            const name = String(eventField(event, "name", "tool"));
            const reason = String(eventField(event, "reason", ""));
            const args = String(eventField(event, "args", ""));
            const id = String(eventField(event, "id", ""));
            patch((m) => {
              const tools = [...(m.tools ?? [])];
              let idx = id ? tools.findIndex((t) => t.id === id) : -1;
              if (idx < 0) {
                for (let i = tools.length - 1; i >= 0; i -= 1) {
                  const st = tools[i].status;
                  if (tools[i].name === name && (st === "running" || st === "pending")) {
                    idx = i;
                    break;
                  }
                }
              }
              if (idx >= 0) {
                tools[idx] = {
                  ...tools[idx],
                  args: tools[idx].args || args,
                  result: reason || tools[idx].result,
                  status: "blocked" as const,
                };
              } else {
                tools.push({
                  id: id || `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                  name,
                  args,
                  result: reason,
                  status: "blocked" as const,
                });
              }
              return { ...m, tools };
            });
            break;
          }
          case "todo": {
            const list = normalizeTodos(eventField<unknown>(event, "todos", []));
            if (list.length === 0) break;
            // write_todos 每次回传**完整清单** → 整体替换挂在这条回答上的清单
            patch((m) => ({ ...m, todos: list }));
            // 本轮第一份清单到达 → 自动展开；之后不再干扰用户的手动收起
            setTodoCollapsed((prev) =>
              aiMsgId in prev ? prev : { ...prev, [aiMsgId]: false }
            );
            break;
          }
          case "card": {
            const card = eventField<CardPayload | null>(event, "card", null);
            if (!card || !card.card_id || !Array.isArray(card.data?.sections)) break;
            patch((m) => {
              const list = m.cards ?? [];
              // 按 card_id 去重：同一张卡片可能被多个节点重复推送
              if (list.some((c) => c.card_id === card.card_id)) return m;
              return { ...m, cards: [...list, card] };
            });
            break;
          }
          case "approval_request": {
            const requests = eventField<ApprovalRequest[]>(event, "requests", []);
            const list = Array.isArray(requests) ? requests : [];
            setApprovals(list);
            // 把等待审批的写操作在工具列表里标记为「等待审批」
            const names = new Set(list.map((r) => String(r.name ?? r.tool ?? "")));
            if (names.size > 0) {
              patch((m) => ({
                ...m,
                tools: (m.tools ?? []).map((t) =>
                  t.status === "running" && names.has(t.name)
                    ? { ...t, status: "pending" as const }
                    : t
                ),
              }));
            }
            break;
          }
          case "done": {
            patch((m) => ({ ...m, pending: false }));
            // 本轮结束 → 刷新上下文环形图标（服务端已算好 used/max/ratio）
            const ctx = eventField<ContextUsage | undefined>(event, "context", undefined);
            if (ctx && typeof ctx.used_tokens === "number") setContextUsage(ctx);
            break;
          }
          case "error": {
            const message = String(eventField(event, "error", "Agent 执行出错"));
            patch((m) => ({ ...m, pending: false, error: message }));
            break;
          }
          default:
            break;
        }
      });

      patch((m) => ({ ...m, pending: false }));
      void loadSessions();
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        patch((m) => ({
          ...m,
          pending: false,
          content: m.content || "（已停止生成）",
        }));
      } else {
        const message = err instanceof Error ? err.message : "请求失败，请稍后重试";
        patch((m) => ({ ...m, pending: false, error: message }));
        if (message.includes("无法连接")) markOffline();
      }
    } finally {
      sendingRef.current = false;
      abortRef.current = null;
      setSending(false);
      // 本轮结束（正常 / 出错 / 用户中断）→ 该条回答的清单自动收起成一行
      setTodoCollapsed((prev) => ({ ...prev, [aiMsgId]: true }));
    }
  }, [input, pendingImages, pendingFiles, activeId, useSearch, modelId, createSession, loadSessions, markOffline]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleApproval = useCallback(
    async (approved: boolean) => {
      if (!activeId) return;
      setApprovals([]);
      // 立刻把「等待审批」的工具行更新为结果态
      setMessages((prev) =>
        prev.map((m) => ({
          ...m,
          tools: (m.tools ?? []).map((t) =>
            t.status === "pending"
              ? {
                  ...t,
                  status: approved ? ("running" as const) : ("error" as const),
                  result: approved ? t.result : "用户拒绝了该操作",
                }
              : t
          ),
        }))
      );
      try {
        await fetch(`/api/agent/chat/${activeId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved, session_id: activeId }),
        });
      } catch {
        // 忽略
      }
    },
    [activeId]
  );

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await fetch(`/api/agent/sessions/${target.id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== target.id));
      if (activeIdRef.current === target.id) {
        setActiveId(null);
        activeIdRef.current = null;
        setMessages([]);
      }
    } catch {
      // 忽略
    }
  }, [pendingDelete]);

  const handleNewChat = useCallback(async () => {
    if (sendingRef.current) return;
    await createSession();
    textareaRef.current?.focus();
  }, [createSession]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      // 中文输入法（IME）组合输入中，回车用于确认候选词，不触发发送
      const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
      if (composing || native.isComposing || native.keyCode === 229) return;
      e.preventDefault();
      void handleSend();
    },
    [composing, handleSend]
  );

  /* ---------------- 渲染 ---------------- */

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="chat" />

      <div style={{ flex: 1, minWidth: 0, display: "flex", height: "100vh" }}>
        {/* ====== 会话列表 ====== */}
        <aside
          data-testid="session-list"
          aria-hidden={listCollapsed}
          style={{
            width: listCollapsed ? 0 : LIST_WIDTH,
            flexShrink: 0,
            // box-sizing: border-box 下 width:0 仍会渲染 1px 边框，收起时需把边框宽度也归零
            borderRightWidth: listCollapsed ? 0 : 1,
            borderRightStyle: "solid",
            borderRightColor: BORDER,
            background: "#fff",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            transition:
              "width 260ms cubic-bezier(0.4, 0, 0.2, 1), border-right-width 260ms ease",
          }}
        >
          {/* 固定宽度内层：宽度动画期间内容不回流 */}
          <div
            style={{
              width: LIST_WIDTH,
              flexShrink: 0,
              height: "100%",
              display: "flex",
              flexDirection: "column",
            }}
          >
          <div style={{ padding: "13px 12px 11px", borderBottom: `1px solid #F1F5F9` }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 10,
                paddingLeft: 2,
              }}
            >
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: TEXT,
                  letterSpacing: "0.01em",
                }}
              >
                对话记录
              </span>
              <PanelToggle
                direction="collapse"
                testId="collapse-list"
                onClick={() => toggleList(true)}
              />
            </div>
            <button
              onClick={handleNewChat}
              disabled={sending}
              style={{
                width: "100%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                padding: "9px 12px",
                borderRadius: 9,
                border: "none",
                background: PRIMARY,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: sending ? "not-allowed" : "pointer",
                opacity: sending ? 0.6 : 1,
                lineHeight: 1.2,
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="14" height="14" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              新建对话
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px 14px" }}>
            {sessions.length === 0 ? (
              <div
                style={{
                  padding: "26px 12px",
                  textAlign: "center",
                  fontSize: 12.5,
                  color: SUBTLE,
                  lineHeight: 1.7,
                }}
              >
                暂无对话
                <br />
                点击上方新建
              </div>
            ) : (
              sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onSelect={() => {
                    if (sendingRef.current) return;
                    setActiveId(session.id);
                  }}
                  onDelete={() => setPendingDelete(session)}
                />
              ))
            )}
          </div>
          </div>
        </aside>

        {/* ====== 对话区 ====== */}
        <main
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            background: "#F8FAFC",
          }}
        >
          {/* 头部 */}
          <header
            style={{
              height: 62,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "0 24px",
              background: "#fff",
              borderBottom: `1px solid ${BORDER}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              {/* 会话列表收起后，展开按钮出现在顶栏最左侧 */}
              {listCollapsed && (
                <PanelToggle
                  direction="expand"
                  testId="expand-list"
                  onClick={() => toggleList(false)}
                />
              )}
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: TEXT,
                    letterSpacing: "-0.01em",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {activeSession?.title || "AI 助手"}
                </div>
                <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 2 }}>
                  基于 DeepAgents · {models.find((m) => m.id === modelId)?.name || "AI 模型"}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => setUseSearch((v) => !v)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 20,
                  border: `1px solid ${useSearch ? PRIMARY : BORDER}`,
                  background: useSearch ? "#EFF6FF" : "#fff",
                  color: useSearch ? PRIMARY : MUTED,
                  fontSize: 12.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                智能搜索
              </button>

              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 20,
                  background: connection === "online" ? "#F0FDF4" : connection === "offline" ? "#FEF2F2" : "#F8FAFC",
                  color: connection === "online" ? "#16A34A" : connection === "offline" ? "#DC2626" : SUBTLE,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <span
                  className={connection === "checking" ? "chat-dot" : undefined}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "currentColor",
                  }}
                />
                {connection === "online" ? "已连接" : connection === "offline" ? "未连接" : "检测中"}
              </span>
            </div>
          </header>

          {/* 离线提示 */}
          {connection === "offline" && (
            <div
              style={{
                margin: "12px 24px 0",
                padding: "10px 14px",
                borderRadius: 10,
                background: "#FEF2F2",
                border: "1px solid #FECACA",
                color: "#B91C1C",
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              {OFFLINE_HINT}
            </div>
          )}

          {/* 消息流 */}
          <div
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current;
              if (!el) return;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            }}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "24px 24px 8px",
              /* 新会话：整块内容（欢迎语 + 快捷指令）在剩余高度里垂直居中 */
              display: "flex",
              flexDirection: "column",
            }}
            data-testid="chat-scroll"
          >
            <div style={{ maxWidth: 820, margin: "0 auto", width: "100%", flex: messages.length === 0 && !sending ? 1 : "0 0 auto", display: "flex", flexDirection: "column" }}>
              {/* 快捷指令：只在没有对话内容时显示 */}
              {messages.length === 0 && !sending ? (
                <div
                  data-testid="quick-cmds"
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "20px 0 100px",
                  }}
                >
                  <div style={{ width: "100%" }}>
                    <div style={{ textAlign: "center", marginBottom: 22 }}>
                      <div
                        style={{
                          width: 54,
                          height: 54,
                          borderRadius: 16,
                          margin: "0 auto 16px",
                          background: "linear-gradient(135deg, #2563EB, #60A5FA)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: 18,
                          fontWeight: 800,
                        }}
                      >
                        AI
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 700, color: TEXT, marginBottom: 6 }}>
                        有什么可以帮你？
                      </div>
                      <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.7 }}>
                        可以让我查询、统计 CRM 业务数据，也能新增 / 修改 / 删除数据（写操作需你确认）
                      </div>
                    </div>

                    {/* 快捷指令：最多两行，超出滚动；最右侧齿轮可配置 */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        data-testid="quick-cmds-list"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 8,
                          maxHeight: 82,
                          overflowY: "auto",
                          justifyContent: "center",
                        }}
                      >
                        {quickCmds.map((cmd, idx) => (
                          <button
                            key={`${cmd}-${idx}`}
                            data-testid={`quick-cmd-${idx}`}
                            data-cmd={cmd}
                            title={truncateQuickCmd(cmd) === cmd ? undefined : cmd}
                            onClick={() => applyQuickCmd(cmd)}
                            style={{
                              maxWidth: "100%",
                              padding: "7px 14px",
                              borderRadius: 18,
                              border: `1px solid ${BORDER}`,
                              background: "#fff",
                              color: "#334155",
                              fontSize: 12.5,
                              fontFamily: "inherit",
                              lineHeight: 1.5,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              cursor: "pointer",
                              transition: "border-color .15s, color .15s, background .15s",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.borderColor = PRIMARY;
                              e.currentTarget.style.color = PRIMARY;
                              e.currentTarget.style.background = "#F8FAFF";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.borderColor = BORDER;
                              e.currentTarget.style.color = "#334155";
                              e.currentTarget.style.background = "#fff";
                            }}
                          >
                            {truncateQuickCmd(cmd)}
                          </button>
                        ))}
                      </div>

                      <button
                        data-testid="quick-cmd-settings"
                        title="设置快捷指令"
                        onClick={openQuickEditor}
                        style={{
                          flexShrink: 0,
                          width: 32,
                          height: 32,
                          borderRadius: "50%",
                          border: `1px solid ${BORDER}`,
                          background: "#fff",
                          color: MUTED,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition: "border-color .15s, color .15s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = PRIMARY;
                          e.currentTarget.style.color = PRIMARY;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = BORDER;
                          e.currentTarget.style.color = MUTED;
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                messages.map((message) =>
                  message.role === "user" ? (
                    <div
                      key={message.id}
                      data-msg-role="user"
                      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 18 }}
                    >
                      {message.content ? (
                        <div
                          style={{
                            maxWidth: "78%",
                            padding: "10px 14px",
                            borderRadius: "12px 12px 4px 12px",
                            background: PRIMARY,
                            color: "#fff",
                            fontSize: 13.5,
                            lineHeight: 1.7,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            boxShadow: "0 1px 3px rgba(37,99,235,0.28)",
                          }}
                        >
                          {message.content}
                        </div>
                      ) : null}
                      {/* 图片与文字分开展示：图片单独一块（不塞进气泡内） */}
                      {message.images && message.images.length > 0 ? (
                        <ImageAttachments images={message.images} />
                      ) : null}
                      {/* 文件附件：以标签文字形式展示 */}
                      {message.files && message.files.length > 0 ? (
                        <FileAttachments files={message.files} />
                      ) : null}
                      {/* 复制本条第用户提问 */}
                      {message.content ? (
                        <div
                          className="chat-copy-row right"
                          style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}
                        >
                          <CopyButton
                            testId="chat-copy-user"
                            getText={() => message.content}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      key={message.id}
                      data-msg-role="assistant"
                      style={{ display: "flex", gap: 10, marginBottom: 18, alignItems: "flex-start" }}
                    >
                      <AgentAvatar />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {message.thinking ? <ThinkingBlock text={message.thinking} /> : null}
                        {message.tools && message.tools.length > 0 ? (
                          <ToolList tools={message.tools} />
                        ) : null}

                        {message.content ||
                        message.pending ||
                        (message.todos?.length ?? 0) > 0 ||
                        !message.cards?.length ? (
                          <div
                            data-answer-card="1"
                            style={{
                              background: "#fff",
                              border: `1px solid ${BORDER}`,
                              borderRadius: "4px 12px 12px 12px",
                              padding: "12px 15px",
                              boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
                            }}
                          >
                            {message.content ? (
                              <Markdown content={message.content} />
                            ) : message.pending ? (
                              <TypingDots />
                            ) : (message.todos?.length ?? 0) > 0 ? null : (
                              <span style={{ fontSize: 13, color: SUBTLE }}>（无回复内容）</span>
                            )}

                            {/* 任务清单：嵌在回答框内部的最下方，属于这条回答 */}
                            {(message.todos?.length ?? 0) > 0 ? (
                              <TodoPanel
                                todos={message.todos ?? []}
                                collapsed={todoCollapsed[message.id] ?? true}
                                running={!!message.pending}
                                onToggle={() =>
                                  setTodoCollapsed((prev) => ({
                                    ...prev,
                                    [message.id]: !(prev[message.id] ?? true),
                                  }))
                                }
                              />
                            ) : null}
                          </div>
                        ) : null}

                        {message.cards && message.cards.length > 0 ? (
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 10,
                              marginTop: message.content ? 8 : 0,
                            }}
                          >
                            {message.cards.map((card) => (
                              <DataCard key={card.card_id} card={card} />
                            ))}
                          </div>
                        ) : null}

                        {message.error ? (
                          <div
                            style={{
                              marginTop: 8,
                              padding: "9px 12px",
                              borderRadius: 9,
                              background: "#FEF2F2",
                              border: "1px solid #FECACA",
                              color: "#B91C1C",
                              fontSize: 12.5,
                              lineHeight: 1.6,
                            }}
                          >
                            {message.error}
                          </div>
                        ) : null}

                        {/* 复制本条 AI 回答（纯文本，取原始 Markdown 内容） */}
                        {message.content && !message.pending ? (
                          <div className="chat-copy-row" style={{ display: "flex", marginTop: 4 }}>
                            <CopyButton
                              testId="chat-copy-assistant"
                              getText={() => message.content}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                )
              )}

              {approvals.length > 0 && (
                <div style={{ maxWidth: 820, margin: "0 auto" }}>
                  <ApprovalCard requests={approvals} onDecide={handleApproval} />
                </div>
              )}
            </div>
          </div>

          {/* 输入区 */}
          <div
            style={{
              flexShrink: 0,
              background: "#fff",
              borderTop: `1px solid ${BORDER}`,
              padding: "14px 24px 16px",
            }}
          >
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              {/* 已选图片：以文件名标签形式展示在输入框上方，可单独删除 */}
              {pendingImages.length > 0 ? (
                <div
                  data-testid="chat-image-chips"
                  style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}
                >
                  {pendingImages.map((img) => (
                    <span
                      key={img.id}
                      data-testid="chat-image-chip"
                      title={`${img.filename}（${fmtBytes(img.size)}）`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        maxWidth: 220,
                        padding: "3px 5px 3px 9px",
                        borderRadius: 8,
                        border: `1px solid ${BORDER}`,
                        background: "#F8FAFC",
                        fontSize: 11.5,
                        color: TEXT,
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 150,
                        }}
                      >
                        {img.filename}
                      </span>
                      <button
                        type="button"
                        data-testid="chat-image-remove"
                        onClick={() => removePendingImage(img.id)}
                        title="移除图片"
                        style={{
                          flexShrink: 0,
                          width: 16,
                          height: 16,
                          padding: 0,
                          border: "none",
                          borderRadius: 4,
                          background: "transparent",
                          color: SUBTLE,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="11" height="11" strokeLinecap="round">
                          <line x1="6" y1="6" x2="18" y2="18" />
                          <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              {/* 已选文件附件：与图片标签同一视觉样式，可单独删除 */}
              {/* 需求要求「文件名标签缩写」→ 标签上展示 truncateFileName() 后的短名 */}
              {pendingFiles.length > 0 ? (
                <div
                  data-testid="chat-file-chips"
                  style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}
                >
                  {pendingFiles.map((f) => (
                    <span
                      key={f.id}
                      data-testid="chat-file-chip"
                      title={`${f.filename}（${fmtBytes(f.size)}${
                        typeof f.chars === "number" ? ` · ${f.chars} 字` : ""
                      }）`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        maxWidth: 220,
                        padding: "3px 5px 3px 9px",
                        borderRadius: 8,
                        border: `1px solid ${BORDER}`,
                        background: "#F8FAFC",
                        fontSize: 11.5,
                        color: TEXT,
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="8" y1="13" x2="16" y2="13" />
                        <line x1="8" y1="17" x2="13" y2="17" />
                      </svg>
                      <span
                        data-testid="chat-file-chip-name"
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 150,
                        }}
                      >
                        {truncateFileName(f.filename)}
                      </span>
                      <button
                        type="button"
                        data-testid="chat-file-remove"
                        onClick={() => removePendingFile(f.id)}
                        title="移除文件"
                        style={{
                          flexShrink: 0,
                          width: 16,
                          height: 16,
                          padding: 0,
                          border: "none",
                          borderRadius: 4,
                          background: "transparent",
                          color: SUBTLE,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="11" height="11" strokeLinecap="round">
                          <line x1="6" y1="6" x2="18" y2="18" />
                          <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              {/* 附件提示（类型 / 大小 / 条数超限）——图片与文件共用一条提示位 */}
              {imageError || fileError ? (
                <div
                  data-testid="chat-image-error"
                  style={{ fontSize: 11.5, color: "#DC2626", marginBottom: 6 }}
                >
                  {imageError || fileError}
                </div>
              ) : null}

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 10,
                  padding: "9px 10px 9px 14px",
                  borderRadius: 14,
                  border: `1px solid ${inputFocused ? "#BFDBFE" : BORDER}`,
                  background: "#fff",
                  boxShadow: inputFocused ? "0 0 0 3px rgba(37,99,235,0.10)" : "none",
                  transition: "border-color .15s, box-shadow .15s",
                }}
              >
                {/* 左下角加号：统一的附件入口（图片 + 文本文件），按类型自动分流 */}
                <input
                  ref={imageInputRef}
                  data-testid="chat-image-input"
                  type="file"
                  accept={ATTACH_ACCEPT}
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => void ingestAttachments(e.target.files)}
                />
                <button
                  type="button"
                  data-testid="chat-image-add"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={attachDisabled}
                  title={
                    attachLimitReached
                      ? `附件已达上限（图片 ${MAX_IMAGES} / 文件 ${MAX_FILES}）`
                      : "添加图片或文件（也可直接粘贴）"
                  }
                  style={{
                    flexShrink: 0,
                    width: 26,
                    height: 26,
                    marginBottom: 3,
                    padding: 0,
                    borderRadius: 8,
                    border: `1px solid ${BORDER}`,
                    background: attachDisabled ? "#F8FAFC" : "#fff",
                    color: attachDisabled ? SUBTLE : MUTED,
                    cursor: attachDisabled ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {uploadingImage || uploadingFile ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="13" height="13" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
                      <path d="M21 12a9 9 0 0 0-9-9" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="13" height="13" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  )}
                </button>

                <textarea
                  ref={textareaRef}
                  data-testid="chat-input"
                  value={input}
                  rows={1}
                  placeholder="输入消息，Enter 发送，Shift + Enter 换行（可直接粘贴文件）"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={() => setComposing(false)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 24,
                    maxHeight: 200,
                    border: "none",
                    outline: "none",
                    resize: "none",
                    background: "transparent",
                    fontFamily: "inherit",
                    fontSize: 13.5,
                    lineHeight: 1.65,
                    color: "#1E293B",
                    padding: 0,
                  }}
                />

                <button
                  onClick={sending ? handleStop : () => void handleSend()}
                  disabled={!sending && !canSend}
                  title={sending ? "停止生成" : "发送"}
                  style={{
                    flexShrink: 0,
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    border: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: !sending && !canSend ? "not-allowed" : "pointer",
                    background: sending ? "#FEF2F2" : !canSend ? "#E2E8F0" : PRIMARY,
                    color: sending ? "#DC2626" : "#fff",
                    transition: "background .15s",
                  }}
                >
                  {sending ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  )}
                </button>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 8,
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  {models.length > 0 ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ fontSize: 11.5, color: SUBTLE }}>模型</span>
                      <select
                        data-testid="chat-model-select"
                        value={modelId}
                        disabled={sending}
                        onChange={(e) => changeModel(e.target.value)}
                        title="切换后由新模型处理后续消息"
                        style={{
                          appearance: "none",
                          padding: "3px 24px 3px 9px",
                          borderRadius: 8,
                          border: `1px solid ${BORDER}`,
                          // ⚠️ 必须全用长写属性：`background` 简写会重置 `backgroundImage`
                          //    （箭头图标），React 渲染期检测到混用会报
                          //    "Updating a style property during render when a conflicting
                          //     property is set" 警告。故 background 拆成 backgroundColor。
                          backgroundColor: sending ? "#F8FAFC" : "#fff",
                          color: sending ? SUBTLE : TEXT,
                          fontFamily: "inherit",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: sending ? "not-allowed" : "pointer",
                          outline: "none",
                          backgroundImage:
                            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2364748B' stroke-width='3' stroke-linecap='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
                          backgroundRepeat: "no-repeat",
                          backgroundPosition: "right 7px center",
                          maxWidth: 200,
                          textOverflow: "ellipsis",
                        }}
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {contextUsage ? (
                    <button
                      type="button"
                      data-testid="chat-context-ring"
                      onClick={() => setContextOpen(true)}
                      title={`上下文已用 ${fmtTokens(contextUsage.used_tokens)} / ${fmtTokens(
                        contextUsage.max_tokens,
                      )}（${contextUsage.percent}%）· 点击查看详情`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        flexShrink: 0,
                        padding: "3px 9px",
                        borderRadius: 8,
                        border: `1px solid ${BORDER}`,
                        background: "#fff",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        outline: "none",
                      }}
                    >
                      <ContextRing
                        ratio={contextUsage.ratio}
                        color={contextTone(contextUsage.ratio).stroke}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: contextTone(contextUsage.ratio).text,
                        }}
                      >
                        {contextUsage.percent < 0.1 && contextUsage.used_tokens > 0
                          ? "<0.1"
                          : contextUsage.percent.toFixed(contextUsage.percent < 10 ? 1 : 0)}
                        %
                      </span>
                    </button>
                  ) : null}
                  <span style={{ fontSize: 11.5, color: SUBTLE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {useSearch ? "已开启智能搜索，回答可能包含联网内容" : "Enter 发送 · Shift + Enter 换行"}
                  </span>
                </div>
                <span style={{ fontSize: 11.5, color: SUBTLE, flexShrink: 0 }}>内容由 AI 生成，请自行甄别</span>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* ====== 快捷指令设置 ====== */}
      <QuickCmdEditor
        open={quickEditorOpen}
        items={quickDraft}
        onChange={setQuickDraft}
        onClose={() => setQuickEditorOpen(false)}
        onSave={saveQuickCmds}
        onReset={resetQuickCmds}
      />

      {/* ====== 上下文用量详情 ====== */}
      <Modal
        open={contextOpen && !!contextUsage}
        onClose={() => setContextOpen(false)}
        title="上下文使用量"
        width="520px"
      >
        {contextUsage ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <ContextRing
                  ratio={contextUsage.ratio}
                  size={92}
                  stroke={9}
                  color={contextTone(contextUsage.ratio).stroke}
                />
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    pointerEvents: "none",
                  }}
                >
                  <span
                    data-testid="context-percent"
                    style={{
                      fontSize: 19,
                      fontWeight: 700,
                      color: contextTone(contextUsage.ratio).text,
                      letterSpacing: "-0.02em",
                    }}
                  >
                    {contextUsage.percent < 0.1 && contextUsage.used_tokens > 0
                      ? "<0.1"
                      : contextUsage.percent.toFixed(contextUsage.percent < 10 ? 1 : 0)}
                    %
                  </span>
                  <span style={{ fontSize: 10.5, color: SUBTLE }}>已使用</span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      borderRadius: 6,
                      fontSize: 11.5,
                      fontWeight: 600,
                      background: contextTone(contextUsage.ratio).bg,
                      color: contextTone(contextUsage.ratio).text,
                    }}
                  >
                    {contextTone(contextUsage.ratio).label}
                  </span>
                  {contextUsage.estimated ? (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 6,
                        fontSize: 11.5,
                        fontWeight: 600,
                        background: "#F1F5F9",
                        color: MUTED,
                      }}
                    >
                      估算值
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.9 }}>
                  <div>
                    已用上下文{" "}
                    <b data-testid="context-used" style={{ color: TEXT }}>
                      {fmtTokens(contextUsage.used_tokens)}
                    </b>{" "}
                    <span style={{ color: SUBTLE }}>({contextUsage.used_tokens.toLocaleString("zh-CN")} tokens)</span>
                  </div>
                  <div>
                    模型最大上下文{" "}
                    <b data-testid="context-max" style={{ color: TEXT }}>
                      {fmtTokens(contextUsage.max_tokens)}
                    </b>{" "}
                    <span style={{ color: SUBTLE }}>
                      ({contextUsage.max_tokens.toLocaleString("zh-CN")} tokens)
                    </span>
                  </div>
                  <div>
                    当前模型{" "}
                    <b style={{ color: TEXT }}>
                      {models.find((m) => m.id === contextUsage.model)?.name || contextUsage.model}
                    </b>
                  </div>
                </div>
              </div>
            </div>

            {/* 进度条 */}
            <div>
              <div
                data-testid="context-bar"
                style={{
                  height: 12,
                  borderRadius: 999,
                  background: "#F1F5F9",
                  overflow: "hidden",
                  border: `1px solid ${BORDER}`,
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, Math.max(0, contextUsage.percent))}%`,
                    height: "100%",
                    borderRadius: 999,
                    background: contextTone(contextUsage.ratio).stroke,
                    transition: "width .35s ease",
                  }}
                />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: 7,
                  fontSize: 11.5,
                  color: SUBTLE,
                }}
              >
                <span>0</span>
                <span>剩余 {fmtTokens(Math.max(0, contextUsage.max_tokens - contextUsage.used_tokens))}</span>
                <span>{fmtTokens(contextUsage.max_tokens)}</span>
              </div>
            </div>

            <div style={{ fontSize: 11.5, color: SUBTLE, lineHeight: 1.7 }}>
              上下文用量取每轮请求送入模型的输入 token 数（含系统提示词、历史消息、工具定义与工具返回）。
              占比达到上限后框架会自动压缩早期消息，长期对话建议适时新建会话。
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ====== 删除确认 ====== */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="删除对话"
        width="400px"
      >
        <div style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.7 }}>
          删除后该对话不可恢复，确认删除
          {pendingDelete?.title ? `「${pendingDelete.title}」` : "此对话"}吗？
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
          <button
            onClick={() => setPendingDelete(null)}
            style={{
              padding: "9px 18px",
              borderRadius: 9,
              border: `1px solid ${BORDER}`,
              background: "#fff",
              color: "#475569",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            取消
          </button>
          <button
            onClick={() => void handleDelete()}
            style={{
              padding: "9px 18px",
              borderRadius: 9,
              border: "none",
              background: "#DC2626",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            删除该对话
          </button>
        </div>
      </Modal>
    </div>
  );
}
