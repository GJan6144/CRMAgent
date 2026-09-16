"""
对话流数据卡片工具
==================

让 Agent 把分析结果以**结构化数据卡片**的形式展示在对话流里，
而不是只输出一大段 Markdown 文本。

实现要点：工具用 ``response_format="content_and_artifact"`` 声明，
返回值是 ``(content, artifact)`` 二元组：

    - ``content``   → 给**模型**看的简短确认文本（会进入下一轮上下文）
    - ``artifact``  → 给**界面**看的结构化数据（不占模型上下文）

``chat-ui/server.py`` 在收到该工具的 ``ToolMessage`` 时读取 ``artifact``，
额外推送一条 ``card`` 事件；前端据此即时渲染卡片。同时 ``artifact`` 会被
随助手消息一起落库，刷新页面后仍能还原。

卡片数据结构（``data`` 为 JSON **对象**字符串）
------------------------------------------------
::

    {
      "meta": [ {"label": "客户", "value": "李小红"} ],          # 可选：顶部信息条
      "sections": [                                             # 必填：卡片主体
        {"label": "购买意向", "value": "高 · 已询价两次", "tone": "high"}
      ]
    }

``tone`` 可选，取值 ``high`` / ``mid`` / ``low`` / ``warn`` / ``info``，
用于给该条内容上个状态色；缺省或非法值一律按 ``neutral`` 处理。
"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import tool

# 已知卡片类型 → 中文名（前端按 card_type 选择版式；未知类型走通用版式）
CARD_TYPE_LABELS: dict[str, str] = {
    "lead_analysis": "客户线索分析",
}

ALLOWED_TONES: frozenset[str] = frozenset({"high", "mid", "low", "warn", "info", "neutral"})

MAX_SECTIONS = 20
MAX_META = 10
VALUE_LIMIT = 2000


def _clean_pairs(raw: Any, limit: int) -> list[dict]:
    """把 ``[{"label": ..., "value": ...}]`` 规整成干净的列表。"""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        label = item.get("label")
        value = item.get("value")
        if label is None or value is None:
            continue
        label = str(label).strip()
        value = str(value).strip()
        if not label and not value:
            continue
        entry: dict[str, Any] = {"label": label, "value": value[:VALUE_LIMIT]}
        tone = item.get("tone")
        if isinstance(tone, str) and tone.strip().lower() in ALLOWED_TONES:
            entry["tone"] = tone.strip().lower()
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def _normalize(data: Any) -> dict | None:
    """校验并规整卡片数据；无法用时返回 None（调用方据此提示模型重试）。"""
    if not isinstance(data, dict):
        return None
    sections = _clean_pairs(data.get("sections"), MAX_SECTIONS)
    if not sections:
        return None
    normalized: dict[str, Any] = {"sections": sections}
    meta = _clean_pairs(data.get("meta"), MAX_META)
    if meta:
        normalized["meta"] = meta
    return normalized


@tool(response_format="content_and_artifact")
def render_card(card_type: str, title: str, data: str) -> tuple[str, dict | None]:
    """把分析结果以数据卡片的形式展示在对话流中（优于输出大段文字）。

    适用场景：任何「结构化结论」的呈现，例如客户线索分析、统计汇总、对比结论。
    卡片会即时出现在对话里，并随消息保存，刷新后仍在。

    Args:
        card_type: 卡片类型。常用取值：
            - ``"lead_analysis"`` —— 客户线索分析（意向 / 感兴趣产品 / 未成交原因 /
              竞品 / 跟进建议）
            都不匹配时可用任意短标识，前端会走通用版式。
        title: 卡片标题，例如「客户线索分析报告 · 李小红」。
        data: 卡片数据，**JSON 对象字符串**。形如::

                {
                  "meta": [{"label": "客户", "value": "李小红"}],
                  "sections": [
                    {"label": "购买意向", "value": "高 · 已询价两次", "tone": "high"},
                    {"label": "跟进建议", "value": "3 天内回访", "tone": "info"}
                  ]
                }

            ``sections`` 必填且不能为空，每项含 ``label`` 与 ``value``；
            ``tone`` 可选（``high``/``mid``/``low``/``warn``/``info``）用于标状态色。
            务必输出合法 JSON，不要包含注释或多余文字。
    """
    raw = (data or "").strip()
    if not raw:
        return ("render_card 调用失败：data 为空。请补充卡片数据后重试。", None)

    # 容忍模型把 JSON 包在 ```json 围栏里
    if raw.startswith("```"):
        lines = [ln for ln in raw.splitlines() if not ln.strip().startswith("```")]
        raw = "\n".join(lines).strip()

    try:
        parsed = json.loads(raw)
    except Exception as exc:
        return (
            f"render_card 调用失败：data 不是合法 JSON（{exc}）。"
            "请修正后重新调用，注意转义引号、不要写注释。",
            None,
        )

    normalized = _normalize(parsed)
    if normalized is None:
        return (
            "render_card 调用失败：data 缺少非空的 sections 列表。"
            "正确结构为 {\"sections\": [{\"label\": \"...\", \"value\": \"...\"}]}。",
            None,
        )

    clean_type = (card_type or "").strip() or "generic"
    clean_title = (title or "").strip() or CARD_TYPE_LABELS.get(
        clean_type, "分析结果"
    )

    artifact = {
        "card_type": clean_type,
        "title": clean_title,
        "data": normalized,
    }

    count = len(normalized["sections"])
    content = (
        f"已生成数据卡片「{clean_title}」（{count} 项），"
        "已在对话流中展示给用户。请勿再把同样的内容重复写成大段文字。"
    )
    return (content, artifact)


CARD_TOOLS = [render_card]
CARD_TOOL_NAMES = {t.name for t in CARD_TOOLS}
