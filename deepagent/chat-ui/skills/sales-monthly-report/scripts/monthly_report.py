#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""销售月报生成器（Sales Monthly Report）

读取 CRM 本地 JSON（orders / products / leads / sales-targets），按「销售月报」
口径汇总三项统计，并渲染成一份自包含的 HTML 报告（内联样式 + 内联 SVG 饼图，
不依赖任何外部资源与网络）。

用法
----
    # 1) 看有哪些月份有数据、以及该月统计口径下的全部数字（JSON，便于校对）
    python monthly_report.py months
    python monthly_report.py stats --month 2026-06

    # 2) 渲染 HTML 报告（自动生成各节小结）
    python monthly_report.py render --month 2026-06

    # 3) 想让模型自己写「小结 / 下月工作计划」：先渲染一次拿到 insights 模板，
    #    填好后再渲染一次（--insights-file）
    python monthly_report.py render --month 2026-06
    #   → 生成 <报告>.insights.json，填写其中的 overview/product/sales/plan
    python monthly_report.py render --month 2026-06 --insights-file <该文件>

统计口径
--------
统计1 · 本月总业绩 / 总订单量 / 平均客单价（另出：当月目标、达成率）
统计2 · 各产品：业绩金额、订单量、业绩占比、单量占比、平均客单价
统计3 · 各销售：本月业绩、目标、达成率

销售归属
--------
`orders` 里**没有销售字段**，因此按 `orders.customerName == leads.name` 反查
`leads.assignee`（跟进销售）得到归属。若同一姓名对应多个不同跟进销售，取排序后
第一个并在报告中标注「归属歧义」；无法匹配的订单计入「未归属」，并单独披露金额，
以免「各销售业绩之和 ≠ 总业绩」时看不出原因。

⚠️ 输出约定
-----------
- 写文件一律显式 `encoding="utf-8"`；
- **stdout 只输出 ASCII**（键值行），因为 chat-ui 的 `execute` 工具以**空环境**
  运行 shell（无 PATH / 无 PYTHONIOENCODING），中文直出会触发 cp936 编码错误。
  需要看中文内容请读 `stats --json` 的 JSON 文件或 HTML 本身。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent            # .../chat-ui/skills/sales-monthly-report/scripts
SKILL_DIR = HERE.parent                           # .../chat-ui/skills/sales-monthly-report
CHAT_UI_DIR = SKILL_DIR.parent.parent             # .../chat-ui
DEEPAGENTS_ROOT = CHAT_UI_DIR.parent              # .../deepagents
WORKSPACE = DEEPAGENTS_ROOT.parent                # .../deepagent（CRM 与 deepagents 同级）

DEFAULT_OUT_DIR = CHAT_UI_DIR / "static" / "reports"
PUBLIC_BASE = "http://127.0.0.1:8765/static/reports"

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MONEY_UNIT = "元"

# 饼图配色（清爽商务风；同一序位颜色稳定，便于跨月对比）
PALETTE = ["#3B6FF0", "#22A9A0", "#F0A02C", "#E2574C", "#8A6BE0", "#5B8FF9", "#3BA272", "#B37FEB"]


# --------------------------------------------------------------------------
# 数据读取
# --------------------------------------------------------------------------

def resolve_data_dir(explicit: str | None) -> Path:
    """定位 CRM 数据目录：显式参数 > CRM_DATA_DIR > 工作区两个候选布局。"""
    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_dir():
            raise SystemExit(f"CRM_DATA_DIR 不存在: {p}")
        return p

    env = (os.environ.get("CRM_DATA_DIR") or "").strip()
    if env:
        p = Path(env)
        if p.is_dir():
            return p

    for cand in (WORKSPACE / "CRM_Agent1.0" / "data", WORKSPACE / "crm" / "data"):
        if (cand / "orders.json").is_file():
            return cand

    raise SystemExit(
        "找不到 CRM 数据目录。用 --data-dir 指定，或设置环境变量 CRM_DATA_DIR。"
        f"已尝试: {WORKSPACE / 'CRM_Agent1.0' / 'data'}, {WORKSPACE / 'crm' / 'data'}"
    )


def load_json_list(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"读取失败 {path}: {e}") from e
    if isinstance(data, dict):
        return [data]
    return [r for r in data if isinstance(r, dict)] if isinstance(data, list) else []


def to_float(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# --------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------

def month_of(rec: dict) -> str:
    """记录所属月份（YYYY-MM）。createdAt 形如 `2026-06-01 08:13`。"""
    raw = str(rec.get("createdAt") or rec.get("month") or "").strip()
    return raw[:7] if MONTH_RE.match(raw[:7]) else ""


def compute(data_dir: Path, month: str) -> dict:
    """产出一份完整的月报数据（纯数据，不含 HTML）。"""
    orders = load_json_list(data_dir / "orders.json")
    products = load_json_list(data_dir / "products.json")
    leads = load_json_list(data_dir / "leads.json")
    targets = load_json_list(data_dir / "sales-targets.json")

    all_months = sorted({m for m in (month_of(r) for r in orders) if m})

    sel = [r for r in orders if month_of(r) == month]

    # ---- 订单 → 销售 归属（orders 无销售字段，经 leads 反查）----
    name_to_assignees: dict[str, list[str]] = defaultdict(list)
    for ld in leads:
        nm = str(ld.get("name") or "").strip()
        asg = str(ld.get("assignee") or "").strip()
        if nm and asg and asg not in name_to_assignees[nm]:
            name_to_assignees[nm].append(asg)

    # ---- 统计1 · 总量 ----
    total_amount = sum(to_float(r.get("amount")) for r in sel)
    total_orders = len(sel)
    avg_price = (total_amount / total_orders) if total_orders else 0.0

    # ---- 统计2 · 产品维度 ----
    prod_agg: dict[str, dict] = {}
    for r in sel:
        key = str(r.get("productName") or "(未命名产品)").strip()
        slot = prod_agg.setdefault(key, {"name": key, "amount": 0.0, "orders": 0})
        slot["amount"] += to_float(r.get("amount"))
        slot["orders"] += 1
    for slot in prod_agg.values():
        slot["avg_price"] = slot["amount"] / slot["orders"] if slot["orders"] else 0.0
    prod_rows = sorted(prod_agg.values(), key=lambda s: (-s["amount"], s["name"]))
    for slot in prod_rows:
        slot["amount_share"] = (slot["amount"] / total_amount * 100) if total_amount else 0.0
        slot["order_share"] = (slot["orders"] / total_orders * 100) if total_orders else 0.0

    catalog = [str(p.get("name") or "").strip() for p in products]
    unsold = [n for n in catalog if n and n not in prod_agg]

    # ---- 统计3 · 销售维度 ----
    month_targets = {str(t.get("name") or "").strip(): t for t in targets if month_of(t) == month}
    per_sales_amount: dict[str, float] = defaultdict(float)
    per_sales_orders: dict[str, int] = defaultdict(int)
    unmatched_amount = 0.0
    unmatched_orders = 0
    ambiguous: dict[str, int] = defaultdict(int)

    for r in sel:
        nm = str(r.get("customerName") or "").strip()
        cands = name_to_assignees.get(nm) or []
        if not cands:
            unmatched_amount += to_float(r.get("amount"))
            unmatched_orders += 1
            continue
        if len(cands) > 1:
            ambiguous[nm] = len(cands)
        owner = sorted(cands)[0]
        per_sales_amount[owner] += to_float(r.get("amount"))
        per_sales_orders[owner] += 1

    sales_rows = []
    for name in sorted(set(month_targets) | set(per_sales_amount)):
        target = to_float((month_targets.get(name) or {}).get("target"))
        amount = per_sales_amount.get(name, 0.0)
        sales_rows.append({
            "name": name,
            "amount": amount,
            "orders": per_sales_orders.get(name, 0),
            "target": target,
            "has_target": name in month_targets,
            "rate": (amount / target * 100) if target else None,
            "region": str((month_targets.get(name) or {}).get("region") or ""),
        })
    sales_rows.sort(key=lambda s: (-s["amount"], s["name"]))

    total_target = sum(s["target"] for s in sales_rows)
    overall_rate = (total_amount / total_target * 100) if total_target else None
    reached = [s for s in sales_rows if s["rate"] is not None and s["rate"] >= 100]

    return {
        "month": month,
        "month_label": f"{month[:4]} 年 {int(month[5:7])} 月",
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "data_dir": str(data_dir),
        "available_months": all_months,
        "totals": {
            "amount": total_amount,
            "orders": total_orders,
            "avg_price": avg_price,
            "target": total_target,
            "rate": overall_rate,
            "reached_count": len(reached),
            "sales_count": len(sales_rows),
        },
        "products": prod_rows,
        "unsold_products": unsold,
        "sales": sales_rows,
        "unmatched": {"amount": unmatched_amount, "orders": unmatched_orders},
        "ambiguous": dict(ambiguous),
    }


# --------------------------------------------------------------------------
# 自动小结（数据驱动；可被 insights 覆盖）
# --------------------------------------------------------------------------

def money(v: float) -> str:
    return f"¥{v:,.2f}"


def pct(v: float | None) -> str:
    return "—" if v is None else f"{v:.1f}%"


def auto_overview(d: dict) -> str:
    t = d["totals"]
    if not t["orders"]:
        return f"{d['month_label']}没有成交订单，无法计算业绩指标。请确认该月是否有数据，或核对订单的创建时间。"

    parts = [
        f"{d['month_label']}共成交 {t['orders']} 单，实现业绩 {money(t['amount'])}，"
        f"平均客单价 {money(t['avg_price'])}。"
    ]
    if t["target"]:
        if t["rate"] is not None and t["rate"] >= 100:
            parts.append(
                f"当月业绩目标 {money(t['target'])}，达成率 {pct(t['rate'])}，"
                f"**超额完成**计划 {money(t['amount'] - t['target'])}。"
            )
        else:
            gap = t["target"] - t["amount"]
            tone = "接近达标" if (t["rate"] or 0) >= 90 else "尚未达标"
            parts.append(
                f"当月业绩目标 {money(t['target'])}，达成率 {pct(t['rate'])}，"
                f"距目标尚差 {money(gap)}，整体**{tone}**。"
            )
    else:
        parts.append("该月未设置销售目标，达成率无法计算，建议补齐目标数据后再做达成评估。")

    if t["reached_count"]:
        parts.append(f"{t['sales_count']} 名销售中 {t['reached_count']} 人达成目标。")
    else:
        parts.append(f"{t['sales_count']} 名销售当月均未达成目标，需重点关注整体节奏。")

    if d["unmatched"]["orders"]:
        parts.append(
            f"另有 {d['unmatched']['orders']} 笔订单（{money(d['unmatched']['amount'])}）"
            "无法归属到销售（客户姓名在销售线索中无对应跟进人），已单列不计入个人业绩。"
        )

    top = d["products"][0] if d["products"] else None
    if top:
        parts.append(
            f"产品结构上，{top['name']}贡献最高（{money(top['amount'])}，占业绩 {pct(top['amount_share'])}）。"
        )
    return "".join(parts)


def auto_product(d: dict) -> str:
    if not d["products"]:
        return "本月没有产品销售记录。"
    rows = d["products"]
    top = rows[0]
    bottom = rows[-1]
    parts = [
        f"共 {len(rows)} 个产品产生成交，"
        f"{top['name']}以 {money(top['amount'])}、{pct(top['amount_share'])} 的业绩占比位居第一；"
        f"{bottom['name']}占比最低（{pct(bottom['amount_share'])}）。"
    ]
    top3 = sum(r["amount_share"] for r in rows[:3])
    if len(rows) > 3:
        concentration = "较高" if top3 >= 70 else "相对分散"
        parts.append(f"前三大产品合计占业绩 {pct(top3)}，产品集中度{concentration}。")
    if len(rows) > 1:
        richest = max(rows, key=lambda r: r["avg_price"])
        cheapest = min(rows, key=lambda r: r["avg_price"])
        parts.append(
            f"平均客单价最高的是{richest['name']}（{money(richest['avg_price'])}），"
            f"最低的是{cheapest['name']}（{money(cheapest['avg_price'])}）。"
        )
    if d["unsold_products"]:
        parts.append("产品库中「" + "、".join(d["unsold_products"]) + "」本月未产生成交。")
    return "".join(parts)

def auto_sales(d: dict) -> str:
    rows = d["sales"]
    if not rows:
        return "本月没有可归属到销售的成交记录。"
    parts = []
    no_target = [s for s in rows if not s["has_target"]]
    if no_target:
        parts.append(
            "以下销售本月未设置目标，达成率无法计算：" + "、".join(s["name"] for s in no_target) + "。"
        )
    rated = [s for s in rows if s["rate"] is not None]
    if rated:
        best = max(rated, key=lambda s: s["rate"])
        worst = min(rated, key=lambda s: s["rate"])
        parts.append(
            f"达成率最高的是{best['name']}（{pct(best['rate'])}），"
            f"最低的是{worst['name']}（{pct(worst['rate'])}）。"
        )
    top = rows[0]
    parts.append(
        f"业绩贡献最大的是{top['name']}（{money(top['amount'])}，{top['orders']} 单）"
    )
    zero = [s for s in rows if s["orders"] == 0]
    if zero:
        parts.append("，其中" + "、".join(s["name"] for s in zero) + "本月无成交")
    parts.append("。")
    return "".join(parts)


def auto_plan(d: dict) -> list[str]:
    """由本月数据推导下月工作计划（4-5 条，全部有数据依据）。"""
    plan: list[str] = []
    t = d["totals"]
    rows = d["sales"]

    lagging = [s for s in rows if s["rate"] is not None and s["rate"] < 80]
    if lagging:
        if len(lagging) == len(rows) and len(rows) > 1:
            worst = min(lagging, key=lambda s: s["rate"])
            best = max(lagging, key=lambda s: s["rate"])
            plan.append(
                f"全员达成率均不足 80%（最高{best['name']} {pct(best['rate'])}，"
                f"最低{worst['name']} {pct(worst['rate'])}），下月需整体重排节奏："
                "先做全员复盘对齐打法，再对尾部人员一对一辅导并倾斜客户资源。"
            )
        else:
            shown = sorted(lagging, key=lambda s: s["rate"])[:3]
            names = "、".join(f"{s['name']}（{pct(s['rate'])}）" for s in shown)
            tail = "等" if len(lagging) > len(shown) else ""
            plan.append(
                f"重点辅导未达标人员：{names}{tail} 达成率偏低，下月安排一对一复盘、"
                "拆解跟进节奏并倾斜客户资源。"
            )

    if t["target"] and (t["rate"] or 0) < 100:
        plan.append(
            f"补齐业绩缺口：本月整体达成率 {pct(t['rate'])}，"
            f"距目标差 {money(t['target'] - t['amount'])}，下月需把缺口拆分到人到周、按周跟踪。"
        )

    if d["products"] and len(d["products"]) > 1:
        low = d["products"][-1]
        plan.append(
            f"拉动低占比产品：{low['name']}本月业绩占比仅 {pct(low['amount_share'])}，"
            "下月补充产品培训与组合套餐，避免产品结构过度依赖头部产品。"
        )

    if d["products"]:
        rich = max(d["products"], key=lambda r: r["avg_price"])
        plan.append(
            f"提升客单价：本月平均客单价 {money(t['avg_price'])}，"
            f"下月围绕{rich['name']}（客单价 {money(rich['avg_price'])}）设计升级与搭配销售，拉高整体单价。"
        )

    if d["unmatched"]["orders"]:
        plan.append(
            f"补齐数据关联：本月 {d['unmatched']['orders']} 笔订单无法归属到销售，"
            "下月要求订单与跟进销售一一对应，保证个人业绩口径准确。"
        )
    elif d["ambiguous"]:
        plan.append(
            "规范客户归属：" + "、".join(d["ambiguous"]) + " 等客户在销售线索中存在多人跟进，"
            "下月需明确唯一责任人，避免业绩重复计算。"
        )

    if d["unsold_products"]:
        plan.append("激活沉默产品：「" + "、".join(d["unsold_products"]) + "」本月零成交，下月评估定价与推广方式。")

    if not plan:
        plan.append("总结本月经验并保持当前节奏，下月继续按现有目标推进。")

    return plan[:6]


def data_fingerprint(d: dict) -> str:
    """当月数据的指纹：订单量 + 总业绩 + 产品数 + 销售数。

    用来判断已写好的 insights 是否还配得上当前数据 —— 数据变了（补录订单、改目标）
    就必须重新生成模板，否则旧小结会和报告里的数字对不上。
    """
    t = d["totals"]
    return f"{t['orders']}|{t['amount']:.2f}|{len(d['products'])}|{t['sales_count']}|{t['target']:.2f}"


def build_insights(d: dict) -> dict:
    """生成 insights 模板（自动小结作为默认值，供模型修改后二次渲染）。"""
    return {
        "_hint": (
            "把下面 4 个字段改成你想要的文字后，用 --insights-file 指向本文件重新渲染。"
            "plan 是字符串数组，每条一句话。留空 / 删除某字段则该项沿用自动小结。"
        ),
        "_fingerprint": data_fingerprint(d),
        "_generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "overview": auto_overview(d),
        "product": auto_product(d),
        "sales": auto_sales(d),
        "plan": auto_plan(d),
    }


# --------------------------------------------------------------------------
# HTML 渲染
# --------------------------------------------------------------------------

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Source Han Sans SC","Segoe UI",sans-serif;
  background:#F4F6FA;color:#1F2532;line-height:1.7;-webkit-font-smoothing:antialiased}
.page{max-width:1080px;margin:0 auto;padding:32px 24px 56px}
.head{background:linear-gradient(135deg,#2B4E9B 0%,#3B6FF0 100%);color:#fff;border-radius:14px;
  padding:28px 32px;box-shadow:0 8px 24px rgba(43,78,155,.18)}
.head h1{font-size:26px;font-weight:700;letter-spacing:.5px}
.head .sub{margin-top:8px;font-size:13px;opacity:.85}
.head .meta{margin-top:14px;font-size:12px;opacity:.75;border-top:1px solid rgba(255,255,255,.25);padding-top:10px}
.card{background:#fff;border:1px solid #E4E8F0;border-radius:12px;padding:24px 26px;margin-top:20px;
  box-shadow:0 1px 3px rgba(31,37,50,.04)}
h2{font-size:17px;font-weight:700;color:#1F2532;padding-left:12px;border-left:4px solid #3B6FF0;
  margin-bottom:16px;line-height:1.2}
h2 .idx{color:#3B6FF0;margin-right:6px}
.kpis{display:flex;flex-wrap:wrap;gap:14px}
.kpi{flex:1 1 178px;background:#F7F9FD;border:1px solid #E4E8F0;border-radius:10px;padding:16px 18px}
.kpi .k{font-size:12px;color:#6B7686;letter-spacing:.3px}
.kpi .v{font-size:23px;font-weight:700;margin-top:6px;color:#1F2532;word-break:break-all}
.kpi .v.blue{color:#3B6FF0}.kpi .v.green{color:#1E9E6A}.kpi .v.orange{color:#D9822B}.kpi .v.red{color:#D64545}
.summary{margin-top:18px;background:#F7F9FD;border-left:3px solid #3B6FF0;border-radius:0 8px 8px 0;
  padding:14px 18px;font-size:14px;color:#39424F}
.summary b,.summary strong{color:#2B4E9B}
.chart-wrap{display:flex;flex-wrap:wrap;gap:28px;align-items:center;justify-content:center;padding:6px 0 4px}
.legend{min-width:280px;flex:1 1 280px}
.legend .row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed #EDF0F6;font-size:13px}
.legend .row:last-child{border-bottom:none}
.sw{width:11px;height:11px;border-radius:3px;flex:none}
.legend .nm{flex:1 1 auto;color:#39424F}
.legend .amt{color:#6B7686;font-variant-numeric:tabular-nums}
.legend .sh{width:58px;text-align:right;font-weight:600;color:#1F2532;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13.5px}
th,td{padding:11px 12px;text-align:right;border-bottom:1px solid #EDF0F6;font-variant-numeric:tabular-nums}
th{background:#F7F9FD;color:#4A5566;font-weight:600;font-size:12.5px;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
tbody tr:hover{background:#FAFBFE}
tbody tr.total td{font-weight:700;background:#F7F9FD;border-top:2px solid #E4E8F0}
.tag{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11.5px;font-weight:600;line-height:1.7}
.tag.ok{background:#E6F7EF;color:#1E9E6A}.tag.warn{background:#FDF1E2;color:#B36B15}
.tag.bad{background:#FDECEC;color:#C33B3B}.tag.na{background:#EFF1F5;color:#6B7686}
.bar{position:relative;height:6px;border-radius:6px;background:#EDF0F6;margin-top:6px;overflow:hidden}
.bar i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:#3B6FF0}
.bar i.ok{background:#1E9E6A}.bar i.warn{background:#E9A23B}.bar i.bad{background:#D64545}
ol.plan{margin:4px 0 0 2px;padding-left:20px;font-size:14px;color:#39424F}
ol.plan li{margin-bottom:9px}
.foot{margin-top:22px;text-align:center;font-size:12px;color:#93A0B2;line-height:1.9}
.empty{padding:26px;text-align:center;color:#6B7686;font-size:14px}
"""


def esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def render_markdown_inline(text: str) -> str:
    """把自动小结里的 **粗体** 渲染成 <strong>（其余按纯文本转义）。"""
    out = esc(text)
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)


def build_pie(rows: list[dict]) -> str:
    """内联 SVG 饼图（产品销售金额占比）。"""
    items = [(r["name"], r["amount"]) for r in rows if r["amount"] > 0]
    if not items:
        return '<div class="empty">本月无产品销售数据，无法生成饼图。</div>'
    total = sum(v for _, v in items)
    cx, cy, r = 150.0, 150.0, 128.0
    slices = []
    angle = -90.0
    for i, (label, value) in enumerate(items):
        sweep = 360.0 * value / total
        color = PALETTE[i % len(PALETTE)]
        if sweep >= 359.999:
            d = (f"M {cx:.1f} {cy - r:.1f} A {r:.1f} {r:.1f} 0 1 1 {cx:.1f} {cy + r:.1f} "
                 f"A {r:.1f} {r:.1f} 0 1 1 {cx:.1f} {cy - r:.1f} Z")
        else:
            a1 = math.radians(angle)
            a2 = math.radians(angle + sweep)
            x1, y1 = cx + r * math.cos(a1), cy + r * math.sin(a1)
            x2, y2 = cx + r * math.cos(a2), cy + r * math.sin(a2)
            large = 1 if sweep > 180 else 0
            d = (f"M {cx:.1f} {cy:.1f} L {x1:.2f} {y1:.2f} "
                 f"A {r:.1f} {r:.1f} 0 {large} 1 {x2:.2f} {y2:.2f} Z")
        slices.append(f'<path d="{d}" fill="{color}" stroke="#fff" stroke-width="2"/>')
        angle += sweep

    legend = []
    for i, (label, value) in enumerate(items):
        color = PALETTE[i % len(PALETTE)]
        share = value / total * 100
        legend.append(
            f'<div class="row"><span class="sw" style="background:{color}"></span>'
            f'<span class="nm">{esc(label)}</span>'
            f'<span class="amt">{money(value)}</span>'
            f'<span class="sh">{share:.1f}%</span></div>'
        )

    return (
        '<div class="chart-wrap">'
        f'<svg width="300" height="300" viewBox="0 0 300 300" role="img" aria-label="产品销售金额占比饼图">'
        f'{"".join(slices)}'
        f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="58" fill="#fff"/>'
        f'<text x="{cx:.0f}" y="{cy - 4:.0f}" text-anchor="middle" font-size="12" fill="#6B7686">总业绩</text>'
        f'<text x="{cx:.0f}" y="{cy + 18:.0f}" text-anchor="middle" font-size="15" font-weight="700" '
        f'fill="#1F2532">{money(total)}</text>'
        "</svg>"
        f'<div class="legend">{"".join(legend)}</div>'
        "</div>"
    )


def rate_tag(rate: float | None) -> str:
    if rate is None:
        return '<span class="tag na">无目标</span>'
    if rate >= 100:
        return f'<span class="tag ok">达成 {rate:.1f}%</span>'
    if rate >= 80:
        return f'<span class="tag warn">达成 {rate:.1f}%</span>'
    return f'<span class="tag bad">达成 {rate:.1f}%</span>'


def rate_bar(rate: float | None) -> str:
    if rate is None:
        return ""
    cls = "ok" if rate >= 100 else ("warn" if rate >= 80 else "bad")
    width = min(rate, 100.0)
    return f'<div class="bar"><i class="{cls}" style="width:{width:.1f}%"></i></div>'


def kpi(label: str, value: str, tone: str = "") -> str:
    return (f'<div class="kpi"><div class="k">{esc(label)}</div>'
            f'<div class="v {tone}">{esc(value)}</div></div>')


def render_html(d: dict, insights: dict, auto: dict) -> str:
    t = d["totals"]
    ov = insights.get("overview") or auto["overview"]
    pr = insights.get("product") or auto["product"]
    sl = insights.get("sales") or auto["sales"]
    plan = insights.get("plan") or auto["plan"]
    if isinstance(plan, str):
        plan = [p for p in re.split(r"\n+", plan) if p.strip()]
    plan_items = "".join(f"<li>{render_markdown_inline(str(p))}</li>" for p in plan)

    rate_tone = lambda v: "green" if (v or 0) >= 100 else ("orange" if (v or 0) >= 80 else "red")
    kpis = "".join([
        kpi("本月总业绩", money(t["amount"]), "blue"),
        kpi("总订单量", f"{t['orders']} 单"),
        kpi("平均客单价", money(t["avg_price"])),
        kpi("当月目标", money(t["target"]) if t["target"] else "未设置"),
        kpi("目标达成率", pct(t["rate"]), rate_tone(t["rate"]) if t["rate"] is not None else ""),
    ])

    # 产品表
    prod_rows = "".join(
        "<tr>"
        f"<td>{esc(p['name'])}</td>"
        f"<td>{money(p['amount'])}</td>"
        f"<td>{p['orders']}</td>"
        f"<td>{p['amount_share']:.1f}%</td>"
        f"<td>{p['order_share']:.1f}%</td>"
        f"<td>{money(p['avg_price'])}</td>"
        "</tr>"
        for p in d["products"]
    )
    if d["products"]:
        prod_rows += (
            '<tr class="total"><td>合计</td>'
            f"<td>{money(t['amount'])}</td><td>{t['orders']}</td>"
            "<td>100.0%</td><td>100.0%</td>"
            f"<td>{money(t['avg_price'])}</td></tr>"
        )
    else:
        prod_rows = '<tr><td colspan="6" class="empty">本月无产品销售数据</td></tr>'

    # 销售表
    sales_rows = "".join(
        "<tr>"
        f"<td>{esc(s['name'])}</td>"
        f"<td>{money(s['amount'])}</td>"
        f"<td>{s['orders']}</td>"
        f"<td>{money(s['target']) if s['has_target'] else '未设置'}</td>"
        f"<td>{rate_tag(s['rate'])}{rate_bar(s['rate'])}</td>"
        "</tr>"
        for s in d["sales"]
    )
    if d["sales"]:
        sales_rows += (
            '<tr class="total"><td>合计</td>'
            f"<td>{money(t['amount'])}</td><td>{t['orders']}</td>"
            f"<td>{money(t['target']) if t['target'] else '—'}</td>"
            f"<td>{rate_tag(t['rate'])}</td></tr>"
        )
    else:
        sales_rows = '<tr><td colspan="5" class="empty">本月无可归属到销售的成交记录</td></tr>'

    note_bits = []
    if d["unmatched"]["orders"]:
        note_bits.append(
            f"未归属订单 {d['unmatched']['orders']} 笔（{money(d['unmatched']['amount'])}）"
            "未计入个人业绩，故各销售业绩之和小于总业绩。"
        )
    if d["ambiguous"]:
        note_bits.append("归属歧义客户（多人跟进，取首人）：" + "、".join(d["ambiguous"]) + "。")
    if d["unsold_products"]:
        note_bits.append("本月零成交产品：" + "、".join(d["unsold_products"]) + "。")
    if not t["target"]:
        note_bits.append("该月未配置销售目标，达成率不可用。")
    note = ("<p style=\"margin-top:12px;font-size:12.5px;color:#93A0B2\">口径说明："
            + " ".join(note_bits) + "</p>") if note_bits else ""

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(d['month_label'])} 销售月报</title>
<style>{CSS}</style>
</head>
<body>
<div class="page">
  <div class="head">
    <h1>{esc(d['month_label'])} 销售月报</h1>
    <div class="sub">CRM 业绩 · 产品结构 · 销售人员达成情况</div>
    <div class="meta">报告生成时间：{esc(d['generated_at'])}　|　数据来源：CRM 本地业务数据（orders / products / leads / sales-targets）</div>
  </div>

  <div class="card">
    <h2><span class="idx">一、</span>销售业绩概述</h2>
    <div class="kpis">{kpis}</div>
    <div class="summary">{render_markdown_inline(ov)}</div>
  </div>

  <div class="card">
    <h2><span class="idx">二、</span>销售产品销售情况</h2>
    {build_pie(d['products'])}
    <table>
      <thead><tr>
        <th>产品名称</th><th>业绩金额</th><th>订单量</th>
        <th>业绩占比</th><th>单量占比</th><th>平均客单价</th>
      </tr></thead>
      <tbody>{prod_rows}</tbody>
    </table>
    <div class="summary">{render_markdown_inline(pr)}</div>
  </div>

  <div class="card">
    <h2><span class="idx">三、</span>销售人员情况</h2>
    <table>
      <thead><tr>
        <th>销售姓名</th><th>本月业绩</th><th>订单量</th><th>目标</th><th>达成率</th>
      </tr></thead>
      <tbody>{sales_rows}</tbody>
    </table>
    <div class="summary">{render_markdown_inline(sl)}</div>
    {note}
  </div>

  <div class="card">
    <h2><span class="idx">四、</span>下月工作计划</h2>
    <ol class="plan">{plan_items}</ol>
  </div>

  <div class="foot">
    {esc(d['month_label'])} 销售月报 · 由 CRM Agent 自动生成<br>
    数据目录：{esc(d['data_dir'])}
  </div>
</div>
</body>
</html>
"""


# --------------------------------------------------------------------------
# 命令行
# --------------------------------------------------------------------------

def cmd_months(args) -> int:
    ddir = resolve_data_dir(args.data_dir)
    orders = load_json_list(ddir / "orders.json")
    months = sorted({m for m in (month_of(r) for r in orders) if m})
    payload = {"data_dir": str(ddir), "available_months": months,
               "order_count": len(orders)}
    print(json.dumps(payload, ensure_ascii=True))
    return 0


def cmd_stats(args) -> int:
    ddir = resolve_data_dir(args.data_dir)
    data = compute(ddir, args.month)
    auto = {
        "overview": auto_overview(data),
        "product": auto_product(data),
        "sales": auto_sales(data),
        "plan": auto_plan(data),
    }
    payload = {**data, "auto_summary": auto}
    if args.out:
        p = Path(args.out)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"STATS_JSON={p}")
    else:
        # stdout 保持 ASCII：ensure_ascii=True 会把中文转义成 \uXXXX
        print(json.dumps(payload, ensure_ascii=True, indent=2))
    if not data["totals"]["orders"]:
        print(f"WARN: no orders in {args.month}; available={','.join(data['available_months']) or 'none'}")
    return 0


def cmd_render(args) -> int:
    ddir = resolve_data_dir(args.data_dir)
    data = compute(ddir, args.month)
    auto = {
        "overview": auto_overview(data),
        "product": auto_product(data),
        "sales": auto_sales(data),
        "plan": auto_plan(data),
    }

    out = Path(args.out) if args.out else DEFAULT_OUT_DIR / f"sales-monthly-{args.month}.html"
    out = out if out.is_absolute() else (DEEPAGENTS_ROOT / out)
    out.parent.mkdir(parents=True, exist_ok=True)

    insights: dict = {}
    if args.insights_file:
        ip = Path(args.insights_file)
        ip = ip if ip.is_absolute() else (DEEPAGENTS_ROOT / ip)
        if not ip.is_file():
            print(f"ERROR: insights file not found: {ip}")
            return 2
        try:
            insights = json.loads(ip.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"ERROR: bad insights json: {e}")
            return 2
        if not isinstance(insights, dict):
            print("ERROR: insights must be a JSON object")
            return 2
        print(f"INSIGHTS_USED={ip}")

    html = render_html(data, insights, auto)
    out.write_text(html, encoding="utf-8")

    # insights 模板（已填自动小结）——模型可改后二次渲染。
    # ⚠️ 不能无条件重写：模型填过 / 用户编辑过的内容会被下一次 `render` 冲掉，
    # 二次渲染就把自撰小结打回了自动版。规则：
    #   模板不存在            → 创建；
    #   模板存在且数据指纹一致 → 保留（已有的自撰内容仍然适用）；
    #   模板存在但数据已变     → 重写（旧小结会和报告里的数字对不上）。
    tpl = out.parent / "_insights" / f"{args.month}.json"
    tpl.parent.mkdir(parents=True, exist_ok=True)
    tpl_state = "created"
    if tpl.is_file():
        try:
            old = json.loads(tpl.read_text(encoding="utf-8"))
            stale = (old or {}).get("_fingerprint") != data_fingerprint(data)
        except (OSError, json.JSONDecodeError):
            stale = True
        if stale:
            tpl.write_text(json.dumps(build_insights(data), ensure_ascii=False, indent=2), encoding="utf-8")
            tpl_state = "refreshed"
        else:
            tpl_state = "kept"
    else:
        tpl.write_text(json.dumps(build_insights(data), ensure_ascii=False, indent=2), encoding="utf-8")

    rows = data["products"]
    t = data["totals"]
    print(f"REPORT_HTML={out}")
    print(f"REPORT_URL={PUBLIC_BASE}/{out.name}")
    print(f"INSIGHTS_TEMPLATE={tpl}")
    print(f"INSIGHTS_TEMPLATE_STATE={tpl_state}")
    print(f"MONTH={data['month']}")
    print(f"ORDERS={t['orders']}")
    print(f"AMOUNT={t['amount']:.2f}")
    print(f"AVG_PRICE={t['avg_price']:.2f}")
    print(f"TARGET={t['target']:.2f}")
    print(f"RATE={'' if t['rate'] is None else format(t['rate'], '.1f')}")
    print(f"SALES_COUNT={t['sales_count']}")
    print(f"PRODUCT_COUNT={len(rows)}")
    print(f"HTML_BYTES={len(html.encode('utf-8'))}")
    if not t["orders"]:
        print(f"WARN: no orders in {data['month']}; available={','.join(data['available_months']) or 'none'}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="monthly_report.py", description="销售月报：统计 + HTML 渲染")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--data-dir", help="CRM 数据目录（默认自动探测）")

    m = sub.add_parser("months", help="列出有订单数据的月份")
    common(m)
    m.set_defaults(func=cmd_months)

    s = sub.add_parser("stats", help="输出该月完整统计数据（JSON）")
    common(s)
    s.add_argument("--month", required=True, help="月份，格式 YYYY-MM")
    s.add_argument("--out", help="把 JSON 写到该文件（建议用，便于看中文）")
    s.set_defaults(func=cmd_stats)

    r = sub.add_parser("render", help="渲染 HTML 月报")
    common(r)
    r.add_argument("--month", required=True, help="月份，格式 YYYY-MM")
    r.add_argument("--out", help="HTML 输出路径（默认 chat-ui/static/reports/sales-monthly-<月份>.html）")
    r.add_argument("--insights-file", help="自定义小结 / 下月计划的 JSON 文件（可选）")
    r.set_defaults(func=cmd_render)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd in ("stats", "render") and not MONTH_RE.match(args.month or ""):
        print(f"ERROR: --month 必须是 YYYY-MM（收到 {args.month!r}）")
        return 2
    try:
        return args.func(args)
    except SystemExit as e:
        print(f"ERROR: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
