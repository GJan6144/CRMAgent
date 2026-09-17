"use client";

import type { AgentTodo, AgentTodoStatus } from "@/types/agent";

/**
 * 任务清单面板（Agent 的 `write_todos`）
 * ---------------------------------------------------------------
 * **嵌在 AI 回答气泡（白卡）内部的最下方**，接在回答正文之后，
 * 因此它属于该轮回答的一部分：随消息一起滚动，并随消息一起落库 / 还原
 * （每轮回答各自保留自己的清单）。
 *
 * 交互规则：
 *   - 收到第一条 `todo` 事件 → **自动展开**，逐项显示 待开始 / 进行中 / 已完成；
 *   - 本轮执行结束 → **自动收起成一行**（「任务清单 · 已完成 5/5」）；
 *   - 任何时候点击标题栏都能手动展开 / 收起；
 *   - 历史消息（刷新后还原、或非最后一轮）默认收起。
 *
 * 数据来自 SSE `todo` 事件 —— `write_todos` 每次回传**完整清单**，所以直接整体替换。
 */

const HAIRLINE = "#F1F5F9";
const TEXT = "#0F172A";
const MUTED = "#64748B";
const SUBTLE = "#94A3B8";
const PRIMARY = "#2563EB";
const GREEN = "#16A34A";

/** 展开后清单区的最大高度，超出滚动 */
const LIST_MAX_HEIGHT = 208;

function StatusIcon({ status }: { status: AgentTodoStatus }) {
  const base: React.CSSProperties = {
    flexShrink: 0,
    width: 16,
    height: 16,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  };

  if (status === "completed") {
    return (
      <span style={{ ...base, background: "#F0FDF4", border: `1px solid #BBF7D0` }}>
        <svg viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="3.4" width="9" height="9" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }

  if (status === "in_progress") {
    return (
      <span style={{ ...base, border: `2px solid ${PRIMARY}` }}>
        {/* chat-dot 复用 globals.css 里的 chatPulse 呼吸动画 */}
        <span className="chat-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: PRIMARY }} />
      </span>
    );
  }

  return <span style={{ ...base, border: `2px solid ${SUBTLE}` }} />;
}

export default function TodoPanel({
  todos,
  collapsed,
  running,
  onToggle,
}: {
  todos: AgentTodo[];
  /** true = 收起为一行 */
  collapsed: boolean;
  /** 本轮是否仍在执行（决定文案与呼吸提示） */
  running: boolean;
  onToggle: () => void;
}) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  const allDone = total > 0 && done === total;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  if (total === 0) return null;

  /* 收起时那行右侧的说明文字：优先显示当前进行中的步骤 */
  const summaryText = allDone
    ? "全部完成"
    : active
      ? active.content
      : running
        ? "准备中…"
        : `${total - done} 项未完成`;

  return (
    <div
      data-testid="todo-panel"
      data-todo-count={total}
      data-todo-done={done}
      data-collapsed={collapsed ? "1" : "0"}
      style={{
        // 负外边距让分隔线通到白卡两侧，视觉上是一条“卡片内分隔条”
        margin: "10px -15px 0",
        padding: "10px 15px 0",
        borderTop: `1px solid ${HAIRLINE}`,
      }}
    >
      {/* ---------- 标题栏（收起时就是「一行」） ---------- */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 9,
          height: collapsed ? 26 : 22,
          padding: 0,
          border: "none",
          background: "transparent",
          fontFamily: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke={allDone ? GREEN : PRIMARY} strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="9 11 12 14 22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>

        <span style={{ fontSize: 12.5, fontWeight: 700, color: TEXT, flexShrink: 0 }}>任务清单</span>

        {/* 进度 chip */}
        <span
          style={{
            flexShrink: 0,
            padding: "1px 7px",
            borderRadius: 20,
            fontSize: 11,
            fontWeight: 700,
            background: allDone ? "#F0FDF4" : "#EFF6FF",
            color: allDone ? GREEN : PRIMARY,
          }}
        >
          {done}/{total}
        </span>

        {/* 细进度条 */}
        <span style={{ flexShrink: 0, width: 56, height: 4, borderRadius: 2, background: "#E2E8F0", overflow: "hidden" }}>
          <span
            style={{
              display: "block",
              width: `${percent}%`,
              height: "100%",
              borderRadius: 2,
              background: allDone ? GREEN : PRIMARY,
              transition: "width .3s ease",
            }}
          />
        </span>

        {/* 收起时的当前步骤 / 完成提示 */}
        {collapsed && (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: allDone ? GREEN : MUTED,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summaryText}
          </span>
        )}
        {!collapsed && <span style={{ flex: 1 }} />}

        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke={SUBTLE}
          strokeWidth="2.2"
          width="13"
          height="13"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform .22s ease",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* ---------- 清单正文 ---------- */}
      <div
        style={{
          maxHeight: collapsed ? 0 : LIST_MAX_HEIGHT,
          opacity: collapsed ? 0 : 1,
          overflowY: collapsed ? "hidden" : "auto",
          transition: "max-height .24s ease, opacity .18s ease",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 7, paddingTop: 9 }}>
          {todos.map((todo, i) => (
            <div
              key={`${i}-${todo.content}`}
              data-todo-status={todo.status}
              style={{ display: "flex", alignItems: "flex-start", gap: 9 }}
            >
              <StatusIcon status={todo.status} />
              <span
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: todo.status === "completed" ? SUBTLE : todo.status === "in_progress" ? TEXT : MUTED,
                  fontWeight: todo.status === "in_progress" ? 600 : 400,
                  textDecoration: todo.status === "completed" ? "line-through" : "none",
                }}
              >
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
