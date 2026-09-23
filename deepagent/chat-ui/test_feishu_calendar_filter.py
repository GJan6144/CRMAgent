"""飞书日程查询 —— 「已取消」过滤（离线单测，全程不联网、不读用户 token）。

背景：飞书日历的「取消 / 删除」是**软删除** —— 记录不会从列表消失，
只是 `status` 变成 `cancelled` 且 `summary` 被清空。不过滤时工具输出会被一串
「(无标题) | status=cancelled」淹没，把真正有效的日程挤没（实测主日历里积了 7 条）。

覆盖：
  1. 混合（confirmed / tentative / cancelled）→ 只列有效的，「共 N 条」只算有效，
     末尾给出被过滤条数
  2. 全部 cancelled → 「没有日程（已过滤 N 条已取消的日程）」
  3. status 缺失 → 视为**有效**（不能因为字段缺失吞掉真日程）
  4. status 大小写不敏感（CANCELLED）
  5. items 为空 → 「没有日程」，且**不带**「已过滤」尾巴
  6. 接口失败分支未被破坏（仍给 code/msg + 权限提示）
  7. 时间参数非法分支未被破坏
  8. 有效日程的字段渲染不变（标题 / 时间 / 时区 / status）
  9. 工具描述里说明了过滤行为（模型据此不会误以为查询结果为空）

⚠️ 全部靠 monkeypatch `_calendar_request` / `configured` / `_resolve_calendar_id`，
   因此**不需要飞书授权、不需要网络**。
"""
from __future__ import annotations

import sys
from pathlib import Path

CHAT_UI = Path(__file__).resolve().parent
sys.path.insert(0, str(CHAT_UI))

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} :: {extra}")


import feishu_tools as ft  # noqa: E402

# ---------------------------------------------------------------- 打桩
STATE = {"res": {"ok": True, "code": 0, "msg": "", "data": {}}}

ft.configured = lambda: True                      # 跳过凭证检查
ft._resolve_calendar_id = lambda cid: "primary"   # 跳过日历 id 解析（也不用发请求）
ft._calendar_request = lambda *a, **k: STATE["res"]

START, END = "2026-09-24 00:00", "2026-09-25 00:00"


def ev(summary, status, ts=1760000000):
    """构造一条飞书事件（结构照抄真实返回：时间在 start_time.timestamp / timezone）"""
    item = {
        "summary": summary,
        "start_time": {"timestamp": str(ts), "timezone": "Asia/Shanghai"},
        "end_time": {"timestamp": str(ts + 3600), "timezone": "Asia/Shanghai"},
    }
    if status is not None:
        item["status"] = status
    return item


def run(items):
    STATE["res"] = {"ok": True, "code": 0, "msg": "", "data": {"items": items}}
    return ft.feishu_list_calendar_events.invoke({"start_time": START, "end_time": END})


print("=" * 70)
print("1. 混合：confirmed / tentative / cancelled")
print("=" * 70)
out = run([ev("任务A", "confirmed"), ev(None, "cancelled"), ev("任务B", "tentative")])
print(out)
check("★ 已取消记录不出现（不含 status=cancelled）", "status=cancelled" not in out, out)
check("★ 「共 N 条」只算有效日程（共 2 条）", "共 2 条日程" in out, out)
check("有效日程都在（任务A / 任务B）", "任务A" in out and "任务B" in out, out)
check("末尾提示被过滤条数", "另有 1 条已取消的日程未列出" in out, out)
check("每列一条，无空行噪音", len([l for l in out.splitlines() if l.startswith("- ")]) == 2, out)

print()
print("=" * 70)
print("2. 全部 cancelled")
print("=" * 70)
out = run([ev(None, "cancelled"), ev(None, "cancelled")])
print(out)
check("★ 退化为「没有日程」", "没有日程" in out, out)
check("★ 并说明过滤了多少条", "已过滤 2 条已取消的日程" in out, out)
check("不出现「共 N 条日程」", "共 " not in out, out)

print()
print("=" * 70)
print("3. status 缺失 → 视为有效（不能吞掉真日程）")
print("=" * 70)
out = run([ev("只有标题没有status", None)])
print(out)
check("★ status 缺失仍被列出", "只有标题没有status" in out, out)
check("共 1 条", "共 1 条日程" in out, out)
check("无「已过滤」尾巴", "已过滤" not in out and "未列出" not in out, out)

print()
print("=" * 70)
print("4. status 大小写不敏感")
print("=" * 70)
out = run([ev("任务C", "CANCELLED"), ev("任务D", "Confirmed")])
print(out)
check("★ 大写 CANCELLED 同样被过滤", "任务C" not in out, out)
check("小写/大写混合仍保留有效项", "任务D" in out and "共 1 条日程" in out, out)

print()
print("=" * 70)
print("5. items 为空")
print("=" * 70)
out = run([])
print(out)
check("空列表 → 「没有日程」", "没有日程" in out, out)
check("空列表 → 不带「已过滤」尾巴", "已过滤" not in out, out)

print()
print("=" * 70)
print("6. 接口失败分支（未被本次改动破坏）")
print("=" * 70)
STATE["res"] = {"ok": False, "code": 99991672, "msg": "no permission", "data": {}}
out = ft.feishu_list_calendar_events.invoke({"start_time": START, "end_time": END})
print(out)
check("失败仍报 code/msg", "日程查询失败" in out and "99991672" in out, out)
check("失败仍带权限提示", "权限" in out, out)

print()
print("=" * 70)
print("7. 参数非法分支")
print("=" * 70)
STATE["res"] = {"ok": True, "code": 0, "msg": "", "data": {"items": []}}
out = ft.feishu_list_calendar_events.invoke({"start_time": "不是时间", "end_time": END})
print(out)
check("非法时间 → 参数错误", out.startswith("参数错误"), out)

print()
print("=" * 70)
print("8. 有效日程字段渲染不变")
print("=" * 70)
out = run([ev("季度复盘", "confirmed")])
print(out)
check("含标题", "季度复盘" in out, out)
check("含 timezone", "Asia/Shanghai" in out, out)
check("含 status=confirmed", "status=confirmed" in out, out)

print()
print("=" * 70)
print("9. 工具描述告知过滤行为")
print("=" * 70)
desc = ft.feishu_list_calendar_events.description
check("描述里写明「过滤」与「取消」", "过滤" in desc and "取消" in desc, desc[:120])

print()
print("=" * 70)
print(f"结果：PASS={PASS}  FAIL={FAIL}")
print("（未联网、未读写 feishu_user_token.json）")
print("=" * 70)
sys.exit(1 if FAIL else 0)
