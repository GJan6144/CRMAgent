"""客户线索 AI 评分脚本。

按《业务规则》客户线索AI打分.xlsx 的 5 项规则对线索评分（满分 100）：

  岗位 20 分：产品类岗位（产品经理/技术/工程师/数据/设计/研发/开发/创业）20；学生 0；其余 10。
  预算 20 分：预算区间中位数 2000~5000 元 → 20；>5000 → 10；<2000 → 0。
  行为 30 分：试听 >60 分钟 → 30；10~60 分钟 → 15；<10 分钟 → 0。
  互动 10 分：沟通 ≥3 次 → 10；2 次 → 5；≤1 次 → 0。
  渠道 20 分：朋友圈 → 20；抖音/搜索引擎 → 10；线下海报/其他 → 0。

纯标准库实现，不 import 项目模块。数据目录解析逻辑与 crm_tools 一致：
`<工作区>/CRM_Agent1.0/data/leads.json`，可用环境变量 CRM_DATA_DIR 覆盖。

用法（由 SKILL.md 指挥模型调用）：
  python score_leads.py --unconverted [--limit N] [--min-total 80] [--out PATH]
  python score_leads.py --all [--limit N]
  python score_leads.py --ids LD-xxx,LD-yyy

输出：默认 stdout 打印 JSON（ensure_ascii=True，ASCII 安全）；指定 --out 时写到
文件（UTF-8），stdout 只打印 RESULT_FILE= 与 TOTAL= 两行标记，供模型 read_file 读中文。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


def resolve_data_dir() -> Path:
    env = (os.environ.get("CRM_DATA_DIR") or "").strip()
    if env:
        return Path(env)
    # 本文件：<workspace>/deepagents/chat-ui/skills/lead-scoring/scripts/score_leads.py
    scripts_dir = Path(__file__).resolve().parent          # .../scripts
    chat_ui = scripts_dir.parent.parent.parent            # .../chat-ui
    workspace = chat_ui.parent.parent                      # .../deepagent（工作区）
    return workspace / "CRM_Agent1.0" / "data"


DATA_DIR = resolve_data_dir()

# --------------------------------------------------------------------------
# 评分规则（固化，与《业务规则》客户线索AI打分.xlsx 一致）
# --------------------------------------------------------------------------

_POSITION_HIGH = ("产品经理", "技术", "工程师", "数据", "设计", "研发", "开发", "创业")
_POSITION_LOW = ("学生",)

_BUDGET_RE = re.compile(r"(\d+)\s*[-~到至]\s*(\d+)")


def score_position(position: str) -> tuple[int, str]:
    p = (position or "").strip()
    if any(k in p for k in _POSITION_LOW):
        return 0, f"{p or '未知'}（低相关·学生）"
    if any(k in p for k in _POSITION_HIGH):
        return 20, f"{p or '未知'}（高相关·产品类）"
    return 10, f"{p or '未知'}（中相关）"


def score_budget(budget: str) -> tuple[int, str]:
    b = (budget or "").strip()
    m = _BUDGET_RE.search(b)
    if not m:
        return 0, f"{b or '未知'}（无法解析，按 0 分）"
    lo, hi = int(m.group(1)), int(m.group(2))
    mid = (lo + hi) / 2
    if mid > 5000:
        return 10, f"{b}（约 {mid:.0f} 元，>5000）"
    if mid < 2000:
        return 0, f"{b}（约 {mid:.0f} 元，<2000）"
    return 20, f"{b}（约 {mid:.0f} 元，命中 2000~5000 区间）"


def score_trial(minutes) -> tuple[int, str]:
    try:
        m = int(minutes or 0)
    except (TypeError, ValueError):
        m = 0
    if m > 60:
        return 30, f"试听 {m} 分钟（>60 分钟）"
    if m >= 10:
        return 15, f"试听 {m} 分钟（10~60 分钟）"
    return 0, f"试听 {m} 分钟（<10 分钟）"


def score_comm(count) -> tuple[int, str]:
    try:
        c = int(count or 0)
    except (TypeError, ValueError):
        c = 0
    if c >= 3:
        return 10, f"沟通 {c} 次（≥3 次）"
    if c == 2:
        return 5, f"沟通 {c} 次（2 次）"
    return 0, f"沟通 {c} 次（≤1 次）"


def score_source(source: str) -> tuple[int, str]:
    s = (source or "").strip()
    if s == "朋友圈":
        return 20, "朋友圈"
    if s in ("抖音", "搜索引擎"):
        return 10, s
    return 0, s or "未知渠道"


def score_lead(lead: dict) -> dict:
    pos, pos_reason = score_position(lead.get("customerPosition"))
    bud, bud_reason = score_budget(lead.get("budgetRange"))
    tri, tri_reason = score_trial(lead.get("trialDuration"))
    com, com_reason = score_comm(lead.get("communicationCount"))
    src, src_reason = score_source(lead.get("source"))
    total = pos + bud + tri + com + src
    return {
        "id": lead.get("id", ""),
        "name": lead.get("name", ""),
        "phone": lead.get("phone", ""),
        "status": lead.get("status", ""),
        "source": lead.get("source", ""),
        "position": lead.get("customerPosition", ""),
        "budget": lead.get("budgetRange", ""),
        "trial_minutes": lead.get("trialDuration"),
        "comm_count": lead.get("communicationCount"),
        "detail": [
            {"item": "岗位", "full": 20, "score": pos, "reason": pos_reason},
            {"item": "预算", "full": 20, "score": bud, "reason": bud_reason},
            {"item": "行为", "full": 30, "score": tri, "reason": tri_reason},
            {"item": "互动", "full": 10, "score": com, "reason": com_reason},
            {"item": "渠道", "full": 20, "score": src, "reason": src_reason},
        ],
        "total": total,
    }


def load_leads() -> list[dict]:
    p = DATA_DIR / "leads.json"
    if not p.is_file():
        print(f"ERROR=数据文件不存在：{p}", file=sys.stderr)
        sys.exit(2)
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("data") or data.get("list") or []
    return [x for x in data if isinstance(x, dict)]


def main() -> int:
    ap = argparse.ArgumentParser(description="客户线索 AI 评分")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--unconverted", action="store_true", help="只评未成单（status != 成交）")
    g.add_argument("--all", action="store_true", help="评全部线索")
    g.add_argument("--ids", type=str, default="", help="按 id 逗号分隔评分")
    ap.add_argument("--limit", type=int, default=0, help="取最新 N 条（按 createdAt 倒序）")
    ap.add_argument("--min-total", type=int, default=0, help="只保留总分 >= N 的线索")
    ap.add_argument("--out", type=str, default="", help="结果写入文件（UTF-8），否则 stdout 输出 JSON")
    args = ap.parse_args()

    leads = load_leads()
    if args.ids:
        want = {x.strip() for x in args.ids.split(",") if x.strip()}
        selected = [x for x in leads if x.get("id") in want]
    elif args.all:
        selected = leads
    else:  # 默认：未成单
        selected = [x for x in leads if x.get("status") != "成交"]

    # 按 createdAt 倒序（最新在前），再取 limit 条
    selected.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
    if args.limit and args.limit > 0:
        selected = selected[: args.limit]

    scored = [score_lead(x) for x in selected]
    if args.min_total and args.min_total > 0:
        scored = [s for s in scored if s["total"] >= args.min_total]

    result = {
        "filter": "ids" if args.ids else ("all" if args.all else "unconverted"),
        "total_scored": len(scored),
        "leads": scored,
    }

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"RESULT_FILE={args.out}")
        print(f"TOTAL={len(scored)}")
    else:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
