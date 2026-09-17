#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：MCP 工具（bing-cn-mcp 必应搜索）端到端验证（真实调模型）

验证 Agent 是否真的能通过 MCP 桥接调用 `bing_search` 工具并拿到真实搜索结果。

    python _probe_mcp_e2e.py [自定义提问]
"""

from __future__ import annotations

import json
import sys

import requests

BASE = "http://127.0.0.1:8765"

DEFAULT_PROMPT = (
    "请用 bing_search 工具搜索「无锡天气」，然后告诉我前 3 条结果的标题即可。"
    "不要用其它搜索工具，就用 bing_search。"
)


def sse_events(resp):
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        if not line.startswith("data: "):
            continue
        try:
            yield json.loads(line[6:])
        except json.JSONDecodeError:
            continue


def as_dict(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROMPT

    sid = requests.post(f"{BASE}/api/sessions", json={"title": "E2E-MCP"}, timeout=20).json()["id"]
    print(f"会话: {sid}")
    print(f"提问: {prompt}\n" + "-" * 70)

    tool_calls: list[tuple[str, dict]] = []
    tool_results: list[tuple[str, str]] = []
    final_text = ""
    errors: list[str] = []

    with requests.post(
        f"{BASE}/api/chat",
        json={"session_id": sid, "content": prompt},
        stream=True,
        timeout=900,
    ) as resp:
        resp.raise_for_status()
        for ev in sse_events(resp):
            kind = ev.get("event")
            if kind == "llm_token":
                final_text += ev.get("content") or ev.get("token") or ""
            elif kind == "tool_start":
                name = ev.get("name") or ev.get("tool") or "?"
                args = as_dict(ev.get("args"))
                tool_calls.append((name, args))
                print(f"[tool] {name}  {json.dumps(args, ensure_ascii=False)[:160]}")
            elif kind == "tool_end":
                tool_results.append((str(ev.get("name") or ""), str(ev.get("result") or "")))
            elif kind == "error":
                errors.append(str(ev))
                print(f"[ERROR] {json.dumps(ev, ensure_ascii=False)[:300]}")
            elif kind == "done":
                pass

    print("-" * 70)
    names = [n for n, _ in tool_calls]
    called = "bing_search" in names

    # 找 bing_search 的结果
    bing_result = next((r for n, r in tool_results if n == "bing_search"), "")
    has_result = bool(bing_result) and "results" in bing_result.lower() or ("无锡" in bing_result)

    checks = [
        ("调用了 bing_search 工具", called),
        ("bing_search 返回了搜索结果", has_result),
        ("最终回复非空", bool(final_text.strip())),
        ("无 error 事件", not errors),
    ]

    print("工具链:", " -> ".join(names) or "(无)")
    print("\n===== 断言 =====")
    ok = True
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed

    print("\nbing_search 结果片段（前 300 字）:\n" + bing_result[:300])
    print("\n最终回复（前 500 字）:\n" + final_text.strip()[:500])
    print(f"\n结果: {'全部通过' if ok else '存在失败项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
