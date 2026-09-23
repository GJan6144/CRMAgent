"""真实调用飞书日历接口，交叉验证「已取消」过滤（需要已授权 + 网络）。

做法：**同一时间段查两次** ——
  A. 直接打接口（`_calendar_request`）拿原始 items，数出真正的 cancelled 条数；
  B. 走工具 `feishu_list_calendar_events` 拿用户看到的文本；
再断言：B 里既不出现 cancelled 行，且声明的「已过滤 N 条」与 A 数出来的一致。

⚠️ 用独立进程跑（`feishu_user_token.json` 与运行中的服务共享同一份 token 文件，只读不写除非刷新）。
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

CHAT_UI = Path(__file__).resolve().parent
sys.path.insert(0, str(CHAT_UI))

# 复刻 server.py 的 .env 加载（它没有用 dotenv，是手写解析）
_env = CHAT_UI / ".env"
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip("\"'"))
    print(f"[env] 已加载 {_env.name}（{sum(1 for l in _env.read_text(encoding='utf-8').splitlines() if '=' in l and not l.strip().startswith('#'))} 项）")
else:
    print("[env] 未找到 .env")

import feishu_tools as ft  # noqa: E402

START, END = "2026-01-01 00:00", "2026-12-31 23:59"

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} :: {extra}")


print("=" * 70)
print("0. 前置：凭证 / 授权")
print("=" * 70)
print("configured() =", ft.configured())
tok = ft._get_valid_user_token()
print("用户 token    =", ("已获取（长度 %d）" % len(tok)) if tok else "**缺失**（需先授权）")
check("已配置飞书应用凭证", ft.configured() is True)
check("已有可用的用户 token", bool(tok))
if not (ft.configured() and tok):
    print("\n前置不满足，无法做真实调用，结束。")
    sys.exit(1)

print()
print("=" * 70)
print("A. 原始接口：统计真实 cancelled 条数")
print("=" * 70)
cid = ft._resolve_calendar_id("primary")
res = ft._calendar_request("GET", f"/calendar/v4/calendars/{cid}/events",
                           params={"start_time": ft._to_timestamp(START),
                                   "end_time": ft._to_timestamp(END), "page_size": 50})
print("ok =", res["ok"], "code =", res["code"], "msg =", res["msg"])
check("原始接口调用成功", res["ok"] is True, f"{res['code']} {res['msg']}")
items = (res["data"] or {}).get("items") or []
raw_cancelled = [it for it in items if str(it.get("status") or "").lower() == "cancelled"]
print(f"原始返回 {len(items)} 条，其中 cancelled {len(raw_cancelled)} 条")
for it in items:
    print("   - %-22s | %-12s | summary=%r" % (
        it.get("event_id", "")[:20], it.get("status", ""), (it.get("summary") or "")[:24]))

print()
print("=" * 70)
print("B. 工具输出（用户实际看到的）")
print("=" * 70)
out = ft.feishu_list_calendar_events.invoke({"start_time": START, "end_time": END})
print(out)

print()
print("=" * 70)
print("断言")
print("=" * 70)
check("★ 工具输出里没有任何 cancelled 行", "status=cancelled" not in out, out)
check("★ 输出不含「(无标题)」噪音（cancelled 的标题是空的）",
      "(无标题)" not in out or len(raw_cancelled) == 0, out)
m = re.search(r"未列出）", out)
if raw_cancelled:
    check("★ 声明了被过滤的条数，且与原始接口数一致",
          (f"另有 {len(raw_cancelled)} 条已取消的日程未列出" in out)
          or (f"已过滤 {len(raw_cancelled)} 条已取消的日程" in out),
          f"期望 {len(raw_cancelled)} 条；输出={out!r}")
else:
    check("本时间段没有 cancelled 记录（无需过滤）", "已过滤" not in out and "未列出" not in out, out)

kept_raw = [it for it in items if str(it.get("status") or "confirmed").lower() != "cancelled"]
if kept_raw:
    m2 = re.search(r"共 (\d+) 条日程", out)
    check("★ 「共 N 条」== 原始里非 cancelled 的条数",
          bool(m2) and int(m2.group(1)) == len(kept_raw),
          f"期望 {len(kept_raw)}；输出={out!r}")
    shown = [l for l in out.splitlines() if l.startswith("- ")]
    check("列出的行数 == 非 cancelled 条数", len(shown) == len(kept_raw),
          f"{len(shown)} vs {len(kept_raw)}")
else:
    check("该时间段全部为 cancelled → 退化为「没有日程」", "没有日程" in out, out)

print()
print("=" * 70)
print(f"结果：PASS={PASS}  FAIL={FAIL}")
print("=" * 70)
sys.exit(1 if FAIL else 0)
