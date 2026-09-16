"use client";

import type { CardPayload, CardSection, CardTone } from "@/types/agent";

/**
 * 对话流数据卡片
 * ------------------------------------------------------------------
 * 渲染 Agent 通过 `render_card` 工具产出的结构化分析结果。
 *
 * 数据来源有两个，共用本组件：
 *   1. SSE `card` 事件（工具一返回就即时出现）；
 *   2. 历史消息里的 `cards` 字段（刷新页面后还原）。
 *
 * 版式按 `card_type` 选择；目前 `lead_analysis`（客户线索分析）有专属头部文案，
 * 其余类型走同一套通用版式，只是标题不同。
 */

const BORDER = "#E2E8F0";
const TEXT = "#0F172A";
const MUTED = "#64748B";
const PRIMARY = "#2563EB";

/** 状态色：high=意向强 · mid=中性 · low=弱/负向 · warn=需注意 · info=提示 · neutral=无 */
const TONES: Record<CardTone, { color: string; bg: string }> = {
  high: { color: "#16A34A", bg: "#F0FDF4" },
  mid: { color: "#B45309", bg: "#FFFBEB" },
  low: { color: "#DC2626", bg: "#FEF2F2" },
  warn: { color: "#B45309", bg: "#FFFBEB" },
  info: { color: "#2563EB", bg: "#EFF6FF" },
  neutral: { color: "#94A3B8", bg: "#F8FAFC" },
};

/** 卡片类型 → 展示文案 */
const TYPE_LABELS: Record<string, string> = {
  lead_analysis: "线索分析",
  generic: "分析结果",
};

function toneOf(section: CardSection) {
  return TONES[(section.tone as CardTone) ?? "neutral"] ?? TONES.neutral;
}

export default function DataCard({ card }: { card: CardPayload }) {
  const meta = card.data?.meta ?? [];
  const sections = card.data?.sections ?? [];
  const typeLabel = TYPE_LABELS[card.card_type] ?? card.card_type;

  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        overflow: "hidden",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
      }}
    >
      {/* 头部：强调条 + 标题 + 类型徽标 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "11px 16px",
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            style={{
              width: 3,
              height: 14,
              borderRadius: 2,
              background: PRIMARY,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: TEXT,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {card.title || "分析结果"}
          </span>
        </div>
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 500,
            color: "#1D4ED8",
            background: "#EFF6FF",
            border: "1px solid #BFDBFE",
            borderRadius: 20,
            padding: "2px 9px",
          }}
        >
          {typeLabel}
        </span>
      </div>

      {/* 顶部信息条（可选） */}
      {meta.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 20px",
            padding: "9px 16px",
            background: "#F8FAFC",
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          {meta.map((item, i) => (
            <div key={`${item.label}-${i}`} style={{ fontSize: 12, lineHeight: 1.6 }}>
              <span style={{ color: MUTED }}>{item.label}</span>
              <span style={{ color: TEXT, fontWeight: 500, marginLeft: 6 }}>
                {item.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 主体：逐项展示分析结论 */}
      <div>
        {sections.map((section, i) => {
          const tone = toneOf(section);
          return (
            <div
              key={`${section.label}-${i}`}
              style={{
                display: "grid",
                gridTemplateColumns: "104px 1fr",
                gap: "0 14px",
                padding: "11px 16px",
                borderTop: i > 0 ? `1px solid ${BORDER}` : undefined,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 500,
                  color: MUTED,
                  lineHeight: 1.6,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 2,
                    background: tone.color,
                    flexShrink: 0,
                    marginTop: 6,
                  }}
                />
                <span>{section.label}</span>
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: TEXT,
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {section.value}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
