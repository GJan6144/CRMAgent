import React from "react";
import DataCard from "@/components/DataCard";
import type { CardMeta, CardPayload, CardSection, CardTone } from "@/types/agent";

/**
 * 轻量 Markdown 渲染组件（零依赖）
 * ------------------------------------------------------------------
 * 覆盖对话场景常见语法：标题、粗体/斜体/删除线、行内代码、代码块、
 * 有序/无序列表、表格、引用、分割线、链接与裸链接。
 *
 * 另有一个「数据卡片」兜底：若模型没有调用 render_card 工具，而是直接输出了
 * ```lead-card / ```data-card 围栏（内含 JSON），这里会把它渲染成卡片，
 * 与工具链产出的卡片使用同一个组件，保证展示一致。
 *
 * 说明：内容全部作为 React 文本节点渲染，不注入 HTML，天然免疫 XSS。
 */

/* ======================== 数据卡片兜底（围栏约定） ======================== */

/** 围栏语言 → 卡片类型 */
const CARD_FENCE_LANGS: Record<string, string> = {
  "lead-card": "lead_analysis",
  "data-card": "generic",
  card: "generic",
};

const CARD_FENCE_TONES = new Set<string>([
  "high",
  "mid",
  "low",
  "warn",
  "info",
  "neutral",
]);

function parseMeta(raw: unknown): CardMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: CardMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.label == null || obj.value == null) continue;
    const label = String(obj.label).trim();
    const value = String(obj.value).trim();
    if (!label && !value) continue;
    out.push({ label, value });
  }
  return out;
}

function parseSections(raw: unknown): CardSection[] {
  if (!Array.isArray(raw)) return [];
  const out: CardSection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.label == null || obj.value == null) continue;
    const section: CardSection = {
      label: String(obj.label).trim(),
      value: String(obj.value).trim(),
    };
    const tone = typeof obj.tone === "string" ? obj.tone.toLowerCase() : "";
    if (CARD_FENCE_TONES.has(tone)) section.tone = tone as CardTone;
    if (section.label || section.value) out.push(section);
  }
  return out;
}

/**
 * 尝试把围栏代码块解析成卡片数据。
 * 解析失败（含流式中途的半截 JSON）返回 null，此时按普通代码块渲染。
 */
function parseCardFence(lang: string, code: string, seed: string): CardPayload | null {
  const cardType = CARD_FENCE_LANGS[(lang || "").toLowerCase()];
  if (!cardType) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  const sections = parseSections(obj.sections);
  if (sections.length === 0) return null;
  const meta = parseMeta(obj.meta);

  const title =
    typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "分析结果";

  return {
    card_id: `mdcard-${seed}`,
    card_type: cardType,
    title,
    data: meta.length > 0 ? { meta, sections } : { sections },
  };
}

/* ============================ 行内解析 ============================ */

const INLINE_PATTERN =
  "(`[^`\\n]+`" +
  "|\\*\\*[^*\\n]+\\*\\*" +
  "|__[^_\\n]+__" +
  "|\\*[^*\\n]+\\*" +
  "|_[^_\\n]+_" +
  "|~~[^~\\n]+~~" +
  "|\\[[^\\]]*\\]\\([^)\\s]+\\)" +
  "|https?://[^\\s<>()\\[\\]]+)";

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = new RegExp(INLINE_PATTERN, "g");
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));

    const token = match[0];
    const key = `${keyPrefix}-${index++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="md-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      const href = link?.[2] ?? "#";
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {link?.[1] || href}
        </a>
      );
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noreferrer noopener">
          {token}
        </a>
      );
    }

    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ============================ 块级解析 ============================ */

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "quote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "para"; lines: string[] };

// 围栏语言需允许连字符（如 ```lead-card）；`\w` 不含 `-`，故显式列出字符集
const RE_FENCE = /^\s*```([A-Za-z0-9_+#.-]*)\s*$/;
const RE_FENCE_END = /^\s*```\s*$/;
const RE_HR = /^\s*(?:[-*_]\s*){3,}$/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?/;
const RE_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const RE_LIST_ORDERED = /^\s*\d+[.)]\s+/;
const RE_TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|?\s*$/;
const RE_TABLE_ROW = /^\s*\|/;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !RE_FENCE_END.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      blocks.push({ type: "code", lang, code: buffer.join("\n") });
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 分割线
    if (RE_HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // 标题
    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    // 引用
    if (RE_QUOTE.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buffer.push(lines[i].replace(RE_QUOTE, ""));
        i += 1;
      }
      blocks.push({ type: "quote", lines: buffer });
      continue;
    }

    // 表格（当前行是 | 开头，且下一行是分隔行）
    if (
      RE_TABLE_ROW.test(line) &&
      i + 1 < lines.length &&
      RE_TABLE_DIVIDER.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const head = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    // 列表
    if (RE_LIST_ITEM.test(line)) {
      const ordered = RE_LIST_ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length && RE_LIST_ITEM.test(lines[i])) {
        items.push(lines[i].replace(RE_LIST_ITEM, ""));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // 段落
    const buffer: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (!current.trim()) break;
      if (
        RE_FENCE.test(current) ||
        RE_HEADING.test(current) ||
        RE_QUOTE.test(current) ||
        RE_LIST_ITEM.test(current) ||
        RE_TABLE_ROW.test(current) ||
        RE_HR.test(current)
      ) {
        break;
      }
      buffer.push(current);
      i += 1;
    }
    if (buffer.length === 0) {
      buffer.push(line);
      i += 1;
    }
    blocks.push({ type: "para", lines: buffer });
  }

  return blocks;
}

/* ============================ 块级渲染 ============================ */

const HEADING_SIZE = [21, 18.5, 16.5, 15, 14, 13];

function renderBlock(block: Block, key: number): React.ReactNode {
  switch (block.type) {
    case "code": {
      // 卡片兜底：命中围栏约定且 JSON 合法时渲染成卡片，否则按普通代码块
      const card = parseCardFence(block.lang, block.code, String(key));
      if (card) {
        return (
          <div key={key} className="md-card">
            <DataCard card={card} />
          </div>
        );
      }
      return (
        <pre key={key} className="md-pre">
          <code>{block.code}</code>
        </pre>
      );
    }
    case "heading":
      return (
        <div
          key={key}
          className={`md-h md-h${Math.min(block.level, 3)}`}
          style={{ fontSize: HEADING_SIZE[block.level - 1] ?? 14 }}
        >
          {renderInline(block.text, `h${key}`)}
        </div>
      );

    case "hr":
      return <hr key={key} className="md-hr" />;

    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {block.lines.map((text, j) => (
            <div key={j}>{renderInline(text, `q${key}-${j}`)}</div>
          ))}
        </blockquote>
      );

    case "list":
      return block.ordered ? (
        <ol key={key} className="md-list">
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item, `ol${key}-${j}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item, `ul${key}-${j}`)}</li>
          ))}
        </ul>
      );

    case "table":
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, j) => (
                  <th key={j}>{renderInline(cell, `th${key}-${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell, k) => (
                    <td key={k}>{renderInline(cell, `td${key}-${j}-${k}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "para":
      return (
        <p key={key} className="md-p">
          {renderInline(block.lines.join("\n"), `p${key}`)}
        </p>
      );
  }
}

export default function Markdown({ content }: { content: string }) {
  const blocks = parseBlocks(content || "");
  if (blocks.length === 0) return null;
  return <div className="md-body">{blocks.map((block, i) => renderBlock(block, i))}</div>;
}
