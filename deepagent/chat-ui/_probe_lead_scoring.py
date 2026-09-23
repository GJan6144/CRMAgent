#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：《线索评分》技能端到端验证（真实调模型）

验证：
  1. 模型自己选用了 lead-scoring 技能（读 SKILL.md）；
  2. 调起 write_todos；
  3. 用 venv python 相对路径执行 score_leads.py；
  4. 最终回复给出 Markdown 评分结果（含线索名 + 总分）。

    python _probe_lead_scoring.py [自定义提问]
"""
from __future__ import annotations

import json
import sys
import uuid
from datetime import datetime

import requests

BASE = "http://127.0.0.1:8765"

# --- 会话隔离：会话接口要求声明调用方身份（见 server.py 会话隔离设计）---
# 未带身份时：列表返回空、单会话按「不存在」返回 404。测试脚本必须带上。
_IDENT = {"user_phone": '13912345678', "user_name": '系统管理员'}
_Q = "user_phone=13912345678&user_name=%E7%B3%BB%E7%BB%9F%E7%AE%A1%E7%90%86%E5%91%98"

DEFAULT_PROMPT = "帮我对所有 未成单的最后20条 线索评估打分，打分后，将总分大于等于 80 分的 未成单的线索信息 通过 飞书 发给 刘健"


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
            p = json.loads(raw)
            return p if isinstance(p, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROMPT
    title = f"E2E-评分-{datetime.now().strftime('%H%M%S')}"
    sid = requests.post(f"{BASE}/api/sessions", json={"title": title, **_IDENT}, timeout=20).json()["id"]
    print(f"会话: {sid}  「{title}」")
    print(f"提问: {prompt}\n" + "-" * 70)

    todos_snapshots = []
    tool_calls = []
    final_text = ""
    errors = []

    with requests.post(f"{BASE}/api/chat", json={"session_id": sid, "content": prompt},
                       stream=True, timeout=900) as resp:
        resp.raise_for_status()
        for ev in sse_events(resp):
            kind = ev.get("event")
            if kind == "llm_token":
                final_text += ev.get("content") or ev.get("token") or ""
            elif kind == "todo":
                todos_snapshots.append(ev.get("todos") or [])
                brief = " | ".join(f"{t.get('status')}:{t.get('content')}" for t in (ev.get("todos") or []))
                print(f"[todo] {brief}")
            elif kind == "tool_start":
                name = ev.get("name") or "?"
                args = as_dict(ev.get("args"))
                tool_calls.append((name, args))
                print(f"[tool] {name}  {json.dumps(args, ensure_ascii=False)[:180]}")
            elif kind == "tool_end":
                pass
            elif kind == "approval_request":
                print("[approval] 自动批准")
                requests.post(f"{BASE}/api/chat/{sid}/approve",
                              params=_IDENT,
                              json={"approved": True, "session_id": sid}, timeout=20)
            elif kind == "error":
                errors.append(str(ev))
                print(f"[ERROR] {json.dumps(ev, ensure_ascii=False)[:300]}")

    print("-" * 70)
    names = [n for n, _ in tool_calls]
    read_skill = any(
        n == "read_file" and "lead-scoring/SKILL.md" in str(a.get("file_path") or a.get("path") or "")
        for n, a in tool_calls
    )
    ran_script = any(n == "execute" and "score_leads.py" in str(a) for n, a in tool_calls)
    used_venv = any(n == "execute" and "score_leads.py" in str(a) and ".venv" in str(a) for n, a in tool_calls)
    searched_feishu = any(n == "feishu_search_contacts" for n, _ in tool_calls)
    sent_feishu = any(n == "feishu_send_message" for n, _ in tool_calls)

    checks = [
        ("读了 lead-scoring/SKILL.md", read_skill),
        ("调用了 write_todos", "write_todos" in names),
        ("执行了 score_leads.py", ran_script),
        ("用 venv python 相对路径（空环境可跑）", used_venv),
        ("最终回复含高分线索「钟小山」", "钟小山" in final_text),
        ("最终回复含「总分」", "总分" in final_text),
        ("无 error 事件", not errors),
    ]
    # 飞书链路：搜通讯录需授权（未授权会正常返回提示，不算 error）
    print(f"飞书相关：search={searched_feishu} send={sent_feishu}")

    print("\n工具链:", " -> ".join(names) or "(无)")
    print("todo 快照:", len(todos_snapshots), "次")
    print("\n===== 断言 =====")
    ok = True
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed
    print("\n最终回复（前 1200 字）:\n" + final_text.strip()[:1200])

    # 清理测试会话
    try:
        requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=20)
        print(f"\n已清理会话 {sid}")
    except Exception:
        pass
    print(f"\n结果: {'全部通过' if ok else '存在失败项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
