#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：《合同生成》技能「订单驱动」端到端验证（真实调模型）

验证场景：用户只说「生成王小明订单的合同」，模型要自己：
  1. 触发 contract-generator 技能（读 SKILL.md）；
  2. crm_query 查 orders 定位订单 → 拿客户名/手机号/产品/期限/金额；
  3. 反查 leads 拿身份证 idCard（订单里没有这个字段，是本次的关键口径）；
  4. read_file 读默认甲方 defaults.json；
  5. docx_fill_template 填充生成（文件名含 {timestamp}，弹审批卡后自动批准）；
  6. 生成 .docx 无 {{}} 残留、身份证正确填入。

    python _probe_contract_order.py [订单客户名/订单号]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8765"
CONTRACT_DIR = Path(__file__).parent / "static" / "contracts"

# 王小明：订单 ORD-20240105001（AI课 / 12 月 / 7960 元）；lead idCard=440300200001057936
DEFAULT_PROMPT = "生成王小明订单的合同"
EXPECT_ID_CARD = "440300200001057936"
EXPECT_NAME = "王小明"


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

    CONTRACT_DIR.mkdir(parents=True, exist_ok=True)
    for f in CONTRACT_DIR.glob("*.docx"):
        f.unlink(missing_ok=True)

    sid = requests.post(f"{BASE}/api/sessions", json={"title": "E2E-订单合同"}, timeout=20).json()["id"]
    print(f"会话: {sid}")
    print(f"提问: {prompt}\n" + "-" * 70)

    todos_snapshots: list[list[dict]] = []
    tool_calls: list[tuple[str, dict]] = []
    tool_results: list[tuple[str, str]] = []
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
                todos_snapshots.append(ev.get("todos") or [])
                brief = " | ".join(f"{t.get('status')}:{t.get('content')}" for t in todos_snapshots[-1])
                print(f"[todo #{len(todos_snapshots)}] {brief}")
            elif kind == "tool_start":
                name = ev.get("name") or ev.get("tool") or "?"
                args = as_dict(ev.get("args"))
                tool_calls.append((name, args))
                print(f"[tool] {name}  {json.dumps(args, ensure_ascii=False)[:120]}")
            elif kind == "tool_end":
                tool_results.append((str(ev.get("name") or ""), str(ev.get("result") or "")))
            elif kind == "approval_request":
                approved += 1
                print(f"[approval #{approved}] 自动批准")
                requests.post(
                    f"{BASE}/api/chat/{sid}/approve",
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
        n == "read_file" and "contract-generator/SKILL.md" in str(a.get("file_path") or a.get("path") or "")
        for n, a in tool_calls
    )
    read_defaults = any(
        n == "read_file" and "defaults.json" in str(a.get("file_path") or a.get("path") or "")
        for n, a in tool_calls
    )
    crm_query_calls = [a for n, a in tool_calls if n == "crm_query"]
    queried_orders = any(
        "orders" in str(a.get("entity") or "") for a in crm_query_calls
    )
    queried_leads = any(
        "leads" in str(a.get("entity") or "") for a in crm_query_calls
    )

    # 找生成的 .docx 并回读验证
    outputs = sorted(CONTRACT_DIR.glob("*.docx"), key=lambda p: p.stat().st_mtime)
    out_ok = False
    id_card_ok = False
    ts_name_ok = False
    if outputs:
        out = outputs[-1]
        ts_name_ok = bool(re.match(r"课程服务合同_\d{8}_\d{6}\.docx", out.name))
        try:
            from docx import Document
            txt = "\n".join(p.text for p in Document(str(out)).paragraphs)
            residual = re.findall(r"\{\{[^}]+\}\}", txt)
            out_ok = not residual
            id_card_ok = EXPECT_ID_CARD in txt
            print(f"输出文件: {out.name}  ({out.stat().st_size} 字节)")
            print(f"  残留占位符: {len(residual)} | 含身份证: {id_card_ok} | 含客户名: {EXPECT_NAME in txt}")
        except Exception as e:
            print(f"回读输出文件失败: {e}")

    checks = [
        ("读了 contract-generator/SKILL.md（技能触发）", read_skill),
        ("调用了 write_todos", "write_todos" in names),
        ("todo 事件 ≥ 1 次", len(todos_snapshots) >= 1),
        ("crm_query 查了 orders（定位订单）", queried_orders),
        ("crm_query 查了 leads（反查身份证）", queried_leads),
        ("读了默认甲方 defaults.json", read_defaults),
        ("调用了 docx_fill_template（写）", "docx_fill_template" in names),
        ("生成文件弹了审批卡（设计如此）", approved >= 1),
        ("生成了 .docx 文件", bool(outputs)),
        ("文件名含时间戳（课程服务合同_YYYYMMDD_HHMMSS.docx）", ts_name_ok),
        ("生成文件无 {{}} 残留", out_ok),
        ("身份证正确填入（440300200001057936）", id_card_ok),
        ("最终回复含结果", bool(final_text.strip())),
        ("无 error 事件", not errors),
    ]

    print("\n工具链:", " -> ".join(names) or "(无)")
    print(f"todo 快照: {len(todos_snapshots)} 次 | 审批: {approved} 次")
    print("\n===== 断言 =====")
    ok = True
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed
    print("\n最终回复（前 500 字）:\n" + final_text.strip()[:500])
    print(f"\n结果: {'全部通过' if ok else '存在失败项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
