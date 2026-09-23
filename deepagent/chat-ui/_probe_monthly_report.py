#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：《销售月报》技能端到端验证（真实调模型）

跑一次真实对话，检查：
  1. 模型是否**自己选用了** sales-monthly-report 技能（读 SKILL.md）；
  2. 是否调起 todolist（todo 事件）并逐项推进状态；
  3. 是否用 venv python + 相对路径调用技能脚本（execute）；
  4. 是否真的产出了 HTML 报告文件；
  5. 最终回复是否给出报告链接。

审批请求一律自动批准（便于一次跑通），并记录批准了几次。

    python _probe_monthly_report.py [自定义提问]
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8765"

# --- 会话隔离：会话接口要求声明调用方身份（见 server.py 会话隔离设计）---
# 未带身份时：列表返回空、单会话按「不存在」返回 404。测试脚本必须带上。
_IDENT = {"user_phone": '13912345678', "user_name": '系统管理员'}
_Q = "user_phone=13912345678&user_name=%E7%B3%BB%E7%BB%9F%E7%AE%A1%E7%90%86%E5%91%98"

REPORT_DIR = Path(__file__).parent / "static" / "reports"

DEFAULT_PROMPT = "帮我生成 2026 年 6 月的销售月报"


def sse_events(resp):
    """把 SSE 流解析成 (event_dict)。"""
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
    """tool_start 事件的 args 可能是 dict，也可能是 JSON 字符串。"""
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
    title = f"E2E-月报-{datetime.now().strftime('%H%M%S')}"

    sid = requests.post(f"{BASE}/api/sessions", json={"title": title, **_IDENT}, timeout=20).json()["id"]
    print(f"会话: {sid}  「{title}」")
    print(f"提问: {prompt}\n" + "-" * 70)

    todos_snapshots: list[list[dict]] = []
    tool_calls: list[tuple[str, dict]] = []
    tool_results: list[tuple[str, str]] = []
    blocked: list[str] = []
    approved = 0
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
            elif kind == "todo":
                todos = ev.get("todos") or []
                todos_snapshots.append(todos)
                brief = " | ".join(f"{t.get('status')}:{t.get('content')}" for t in todos)
                print(f"[todo #{len(todos_snapshots)}] {brief}")
            elif kind == "tool_start":
                name = ev.get("name") or ev.get("tool") or "?"
                args = as_dict(ev.get("args"))
                tool_calls.append((name, args))
                short = json.dumps(args, ensure_ascii=False)
                print(f"[tool] {name}  {short[:180]}")
            elif kind == "tool_end":
                tool_results.append((str(ev.get("name") or ""), str(ev.get("result") or "")))
            elif kind == "tool_blocked":
                blocked.append(str(ev.get("tool") or ev.get("name") or "?"))
                print(f"[BLOCKED] {blocked[-1]}")
            elif kind == "approval_request":
                approved += 1
                print(f"[approval #{approved}] 自动批准 → {json.dumps(ev, ensure_ascii=False)[:200]}")
                requests.post(
                    f"{BASE}/api/chat/{sid}/approve",
                    params=_IDENT,
                    json={"approved": True, "session_id": sid},
                    timeout=20,
                )
            elif kind == "error":
                errors.append(str(ev))
                print(f"[ERROR] {json.dumps(ev, ensure_ascii=False)[:300]}")
            elif kind == "done":
                pass

    print("-" * 70)
    names = [n for n, _ in tool_calls]
    read_skill = any(
        n == "read_file" and "sales-monthly-report/SKILL.md" in str(a.get("file_path") or a.get("path") or "")
        for n, a in tool_calls
    )
    ran_script = any(
        n == "execute" and "monthly_report.py" in str(a)
        for n, a in tool_calls
    )
    used_rel_python = any(
        n == "execute" and "monthly_report.py" in str(a) and ".venv" in str(a)
        for n, a in tool_calls
    )
    # ⚠️ 服务端把 tool_start 的 args 截断到 200 字符（截断后不是合法 JSON，解析不出
    # 对象），因此凡是「参数里靠后的内容」都不能用来断言。改用脚本自己 print 的
    # INSIGHTS_USED / REPORT_HTML 标记，以及审批事件。
    used_insights = any("INSIGHTS_USED" in r for _, r in tool_results)
    script_runs = sum(1 for _, r in tool_results if "REPORT_HTML=" in r)
    reports = sorted(REPORT_DIR.glob("sales-monthly-*.html"))

    checks = [
        ("调用了 write_todos", "write_todos" in names),
        ("todo 事件 ≥ 2 次（有状态推进）", len(todos_snapshots) >= 2),
        ("读过 sales-monthly-report/SKILL.md", read_skill),
        ("执行了月报脚本", ran_script),
        ("用 venv python 相对路径调用（空环境可跑）", used_rel_python),
        ("5 步清单全部收尾为 completed", bool(todos_snapshots) and all(
            t.get("status") == "completed" for t in todos_snapshots[-1]
        ) and len(todos_snapshots[-1]) >= 5),
        ("写 insights 弹了审批卡（设计如此）", approved >= 1),
        ("走通了 insights 二次渲染", used_insights),
        ("脚本至少渲染 2 次（覆盖渲染）", script_runs >= 2),
        ("产出了 HTML 报告文件", bool(reports)),
        ("最终回复含报告链接", "sales-monthly-" in final_text and "/static/reports/" in final_text),
        ("无 error 事件", not errors),
    ]
    if reports:
        p = reports[-1]
        html = p.read_text(encoding="utf-8")
        checks += [
            ("报告含四节标题", all(k in html for k in ("销售业绩概述", "销售产品销售情况", "销售人员情况", "下月工作计划"))),
            ("报告含饼图 SVG", "<svg" in html and "<path" in html),
            ("报告自包含（无外部 script/link 引用）", 'src="http' not in html and 'href="http' not in html),
        ]
        print(f"最新报告: {p.name}  {p.stat().st_size} 字节")
        if todos_snapshots:
            last = todos_snapshots[-1]
            done = sum(1 for t in last if t.get("status") == "completed")
            print(f"清单收尾: {done}/{len(last)} completed")
        # 报告里的「下月工作计划」应逐条等于 insights 里的模型自撰文本
        tpl = REPORT_DIR / "_insights" / "2026-06.json"
        if used_insights and tpl.is_file():
            ins = json.loads(tpl.read_text(encoding="utf-8"))
            plan = ins.get("plan") or []
            print(f"insights.plan 条数: {len(plan)}")
            block = re.search(r'<ol class="plan">(.*?)</ol>', html, re.S)
            rendered = re.findall(r"<li>(.*?)</li>", block.group(1), re.S) if block else []
            same = rendered and all(
                re.sub(r"<[^>]+>", "", a).strip() == re.sub(r"\*\*", "", b).strip()
                for a, b in zip(rendered, plan)
            )
            checks.append(("报告里的下月计划 == 模型自撰内容（逐条一致）", bool(same)))

    print("\n工具链:", " -> ".join(names) or "(无)")
    print(f"todo 快照: {len(todos_snapshots)} 次 | 审批: {approved} 次 | 被拦: {blocked or '无'}")
    print("\n===== 断言 =====")
    ok = True
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed
    print("\n最终回复（前 600 字）:\n" + final_text.strip()[:600])
    print(f"\n结果: {'全部通过' if ok else '存在失败项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
