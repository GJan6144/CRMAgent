"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "@/lib/markdown";
import Modal from "./Modal";
import Sidebar from "./Sidebar";
import type {
  AgentEvent,
  AgentMessage,
  AgentSession,
  ApprovalRequest,
  ChatMessage,
  ConnectionState,
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

/* ============================ 子组件 ============================ */

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

/* ============================ 主组件 ============================ */

export default function ChatDashboard() {
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
        body: JSON.stringify({ title: "新对话" }),
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
  }, [markOffline]);

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
    void loadMessages(activeId);
  }, [activeId, loadMessages]);

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

  /* ---------------- 发送 ---------------- */

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sendingRef.current) return;

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
    const userMsg: ChatMessage = { id: `u-${stamp}`, role: "user", content: text };
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
    }
  }, [input, activeId, useSearch, createSession, loadSessions, markOffline]);

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
                  基于 DeepAgents · deepseek-v4-flash
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
            style={{ flex: 1, overflowY: "auto", padding: "24px 24px 8px" }}
          >
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              {messages.length === 0 && !sending ? (
                <div style={{ padding: "60px 0", textAlign: "center" }}>
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
              ) : (
                messages.map((message) =>
                  message.role === "user" ? (
                    <div
                      key={message.id}
                      data-msg-role="user"
                      style={{ display: "flex", justifyContent: "flex-end", marginBottom: 18 }}
                    >
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

                        <div
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
                          ) : (
                            <span style={{ fontSize: 13, color: SUBTLE }}>（无回复内容）</span>
                          )}
                        </div>

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
                <textarea
                  ref={textareaRef}
                  data-testid="chat-input"
                  value={input}
                  rows={1}
                  placeholder="输入消息，Enter 发送，Shift + Enter 换行"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
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
                  disabled={!sending && !input.trim()}
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
                    cursor: !sending && !input.trim() ? "not-allowed" : "pointer",
                    background: sending ? "#FEF2F2" : !input.trim() ? "#E2E8F0" : PRIMARY,
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
                }}
              >
                <span style={{ fontSize: 11.5, color: SUBTLE }}>
                  {useSearch ? "已开启智能搜索，回答可能包含联网内容" : "Enter 发送 · Shift + Enter 换行"}
                </span>
                <span style={{ fontSize: 11.5, color: SUBTLE }}>内容由 AI 生成，请自行甄别</span>
              </div>
            </div>
          </div>
        </main>
      </div>

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
