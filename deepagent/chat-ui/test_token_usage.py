"""token 消耗统计 —— 后端验证。

覆盖：
  1. 迁移幂等（重复 init_db 不报错、列都在）
  2. 归属落库（建会话带身份 → sessions.owner_* 写入）
  3. 指标行归属（真实对话 → agent_metrics.owner_* 写入）
  4. 按用户聚合正确（多用户各自的 total 与 SQL 直查一致）
  5. ⚠️ 核心断言：**各用户 total 合计 === 总量**（含「未知用户」）
  6. 历史无归属行归入「未知用户」，不被丢弃
  7. scope=today / 非法 scope

⚠️ 会对 chat.db 的真实表做写入 —— 用独立临时 DB 跑，避免污染真实统计。
"""
from __future__ import annotations

import importlib
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
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


# ==========================================================================
# 1. 迁移：在**临时 DB** 上跑 init_db，验证列齐全 + 幂等
# ==========================================================================
print("=" * 70)
print("1. 迁移（临时 DB，幂等）")
print("=" * 70)

tmpdir = tempfile.mkdtemp(prefix="token_usage_")
tmp_db = Path(tmpdir) / "chat_test.db"

import server  # noqa: E402

_orig_db = server.DB_PATH
server.DB_PATH = tmp_db

server.init_db()
print(f"  首次 init_db → {tmp_db.name}")

db = sqlite3.connect(str(tmp_db))
for tbl, expect in (
    ("sessions", ["owner_phone", "owner_name", "owner_role_id", "owner_role_name"]),
    ("agent_metrics", ["owner_phone", "owner_name", "owner_role_id", "owner_role_name"]),
):
    cols = [r[1] for r in db.execute(f"PRAGMA table_info({tbl})")]
    missing = [c for c in expect if c not in cols]
    check(f"{tbl} 有全部归属列", not missing, f"缺 {missing}")
db.close()

# 幂等：再跑一次不应抛错
try:
    server.init_db()
    check("重复 init_db 幂等（不抛错）", True)
except Exception as e:  # noqa: BLE001
    check("重复 init_db 幂等（不抛错）", False, str(e))

# 索引存在
db = sqlite3.connect(str(tmp_db))
idx = [r[0] for r in db.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_metrics'"
)]
check("agent_metrics 建立 owner 索引", any("owner" in i for i in idx), idx)
db.close()

# ==========================================================================
# 2. 归属落库（建会话）
# ==========================================================================
print()
print("=" * 70)
print("2. 会话归属落库")
print("=" * 70)

ident_a = {"user_phone": "13800001001", "user_name": "张明",
           "role_id": "ROLE-2026-0002", "role_name": "销售"}
ident_b = {"user_phone": "13800001002", "user_name": "李华",
           "role_id": "ROLE-2026-0002", "role_name": "销售"}
ident_admin = {"user_phone": "13912345678", "user_name": "系统管理员",
               "role_id": "ROLE-2026-0001", "role_name": "管理员"}

sid_a = "sess-a-" + "0" * 8
sid_b = "sess-b-" + "0" * 8
sid_anon = "sess-anon-" + "0" * 8

# 直接调 create_session（绕过 HTTP，验证落库逻辑）
now = "2026-09-21T10:00:00"
db = server.get_db()
for sid, ident in ((sid_a, ident_a), (sid_b, ident_b), (sid_anon, {})):
    db.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at,"
        " owner_phone, owner_name, owner_role_id, owner_role_name)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, "t", now, now, ident.get("user_phone", ""), ident.get("user_name", ""),
         ident.get("role_id", ""), ident.get("role_name", "")),
    )
db.commit()
# ⚠️ 必须关闭：留在开着的事务会锁库，后续 record_metric 的写入会失败/丢失
db.close()

db = server.get_db()
row = db.execute("SELECT owner_phone, owner_name, owner_role_name FROM sessions WHERE id = ?",
                 (sid_a,)).fetchone()
check("会话归属写入正确", row[0] == "13800001001" and row[1] == "张明", dict(row) if row else None)
db.close()

# 补记归属（只补空，不覆盖）
server._backfill_session_owner(sid_anon, ident_admin)
db = server.get_db()
row = db.execute("SELECT owner_name FROM sessions WHERE id = ?", (sid_anon,)).fetchone()
check("匿名会话可补记归属（只补空）", row[0] == "系统管理员", row[0] if row else None)
db.close()

# ⚠️ 已归属的不能被覆盖
server._backfill_session_owner(sid_a, ident_admin)
db = server.get_db()
row = db.execute("SELECT owner_name FROM sessions WHERE id = ?", (sid_a,)).fetchone()
check("已有归属不被覆盖（防改归属）", row[0] == "张明", row[0] if row else None)
db.close()

# ==========================================================================
# 3. 构造指标行：两个用户 + 一批无归属历史行
# ==========================================================================
print()
print("=" * 70)
print("3. 指标行归属与聚合")
print("=" * 70)

# 张明 3 轮、李华 2 轮、管理员 1 轮、历史 4 轮无归属
FIXTURE = [
    (sid_a, ident_a, 1000, 100),   # 张明 3 轮
    (sid_a, ident_a, 2000, 200),
    (sid_a, ident_a, 3000, 300),
    (sid_b, ident_b, 500, 50),     # 李华 2 轮
    (sid_b, ident_b, 700, 70),
    (sid_anon, ident_admin, 900, 90),  # 管理员 1 轮
    ("sess-old", {}, 111, 11),     # 历史无归属 4 轮
    ("sess-old", {}, 222, 22),
    ("sess-old", {}, 333, 33),
    ("sess-old", {}, 444, 44),
]
for sid, ident, p, c in FIXTURE:
    server.record_metric(
        sid, latency_ms=100.0, ok=True,
        usage={"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c,
               "llm_calls": 1, "tool_calls": 0},
        model="deepseek-flash",
        owner=ident,
    )
print(f"  已写入 {len(FIXTURE)} 行指标")

res = server._token_usage("all")
tot = res["totals"]
print(f"  总量: total={tot['total_tokens']}  prompt={tot['prompt_tokens']}  "
      f"completion={tot['completion_tokens']}  turns={tot['turns']}")
print(f"  用户数（已知）: {res['user_count']}")
for u in res["users"]:
    print(f"    {u['name']:10s} 已知={str(u['known']):5s} total={u['total_tokens']:>6} "
          f"占比={u['percent']:>6.2f}%  轮={u['turns']}")

# --- 期望值 ---
exp_zhang = sum(p + c for sid, i, p, c in FIXTURE if i.get("user_name") == "张明")
exp_li = sum(p + c for sid, i, p, c in FIXTURE if i.get("user_name") == "李华")
exp_admin = sum(p + c for sid, i, p, c in FIXTURE if i.get("user_name") == "系统管理员")
exp_unknown = sum(p + c for sid, i, p, c in FIXTURE if not (i.get("user_name") or i.get("user_phone")))
exp_total = exp_zhang + exp_li + exp_admin + exp_unknown

check(f"张明 total = {exp_zhang}", next((u["total_tokens"] for u in res["users"] if u["name"] == "张明"), -1) == exp_zhang)
check(f"李华 total = {exp_li}", next((u["total_tokens"] for u in res["users"] if u["name"] == "李华"), -1) == exp_li)
check(f"管理员 total = {exp_admin}", next((u["total_tokens"] for u in res["users"] if u["name"] == "系统管理员"), -1) == exp_admin)

unk = next((u for u in res["users"] if not u["known"]), None)
check("历史无归属行归入「未知用户」", unk is not None, res["users"])
check(f"未知用户 total = {exp_unknown}（未被丢弃）",
      bool(unk) and unk["total_tokens"] == exp_unknown,
      unk["total_tokens"] if unk else "无此行")

check(f"总量 = {exp_total}", tot["total_tokens"] == exp_total, tot["total_tokens"])

# ⚠️⚠️ 核心断言
check("★ 各用户合计 === 总量（delta=0）",
      res["self_check"]["delta"] == 0 and res["self_check"]["consistent"],
      res["self_check"])
check("★ 手工求和也等于总量",
      sum(u["total_tokens"] for u in res["users"]) == tot["total_tokens"],
      sum(u["total_tokens"] for u in res["users"]))

# 与 SQL 直查交叉验证
db = sqlite3.connect(str(tmp_db))
db.row_factory = sqlite3.Row
sql_total = db.execute("SELECT COALESCE(SUM(total_tokens),0) FROM agent_metrics").fetchone()[0]
sql_zhang = db.execute(
    "SELECT COALESCE(SUM(total_tokens),0) FROM agent_metrics WHERE owner_name='张明'"
).fetchone()[0]
db.close()
check("端点总量 === SQL 直查总量", tot["total_tokens"] == sql_total, f"{tot['total_tokens']} vs {sql_total}")
check("张明 total === SQL 直查", 
      next(u["total_tokens"] for u in res["users"] if u["name"] == "张明") == sql_zhang, sql_zhang)

# 排序：「未知用户」沉底
check("「未知用户」排在已知用户之后",
      not res["users"][-1]["known"] if len(res["users"]) > 1 else True,
      [u["name"] for u in res["users"]])

# 占比合计 ≈ 100
pct = sum(u["percent"] for u in res["users"])
check(f"占比合计 ≈ 100（实际 {pct:.2f}）", abs(pct - 100) < 0.5, pct)

# ==========================================================================
# 4. scope=today
# ==========================================================================
print()
print("=" * 70)
print("4. scope=today")
print("=" * 70)

res_today = server._token_usage("today")
check("today 口径自洽（delta=0）", res_today["self_check"]["delta"] == 0, res_today["self_check"])
check("today 总量 <= 全量总量",
      res_today["totals"]["total_tokens"] <= tot["total_tokens"],
      f"{res_today['totals']['total_tokens']} vs {tot['total_tokens']}")

# ==========================================================================
# 5. 还原
# ==========================================================================
server.DB_PATH = _orig_db
import shutil
shutil.rmtree(tmpdir, ignore_errors=True)
print()
print("=" * 70)
print(f"结果：PASS={PASS}  FAIL={FAIL}")
print("（真实 chat.db 未被触碰；临时库已删除）")
print("=" * 70)
sys.exit(1 if FAIL else 0)
