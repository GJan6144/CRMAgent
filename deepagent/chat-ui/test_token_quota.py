"""
「每月 token 额度」验证 —— 角色额度解析 / 本月聚合 / 超限守卫 / 边界
=============================================================

跑在**临时 DB 副本 + 临时 CRM 数据目录**上，真实数据零风险。

覆盖：
  A. 角色额度解析（字段读取 / 缺省兜底 / 0=不限额 / 非法值兜底）
  B. 本月用量聚合（北京自然月边界 / 按 phone 优先 / 按 name 兜底 / 空身份=0）
  C. resolve_quota 合成（used/quota/percent/remaining/exceeded/unlimited）
  D. chat 端点超限守卫（回固定话术、不调模型、消息打 is_guard）
  E. 未超限时不拦截（回归：不误伤正常用户）

⚠️ 关键约束：
  - server.DB_PATH 指向临时库；跑完删掉，真实 chat.db 不动。
  - 额度来自 roles.json → 用 CRM_DATA_DIR 指向临时目录，不碰真实 roles.json。
  - 本机是 UTC，月份边界必须按北京时间算（+8h）。
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# ---------------------------------------------------------------------------
# 临时环境（必须在 import server 之前设好，避免连到真实库/真实数据目录）
# ---------------------------------------------------------------------------
TMP = Path(tempfile.mkdtemp(prefix="quota-test-"))
CRM_DATA = TMP / "crm_data"
CRM_DATA.mkdir(parents=True, exist_ok=True)

os.environ["CRM_DATA_DIR"] = str(CRM_DATA)

# 临时 roles.json：两个角色，额度分开设
(CRM_DATA / "roles.json").write_text(
    json.dumps(
        [
            {"id": "ROLE-A", "createdAt": "2026-01-01 00:00", "name": "角色A", "monthlyTokenQuota": 1000000, "permissions": []},
            {"id": "ROLE-B", "createdAt": "2026-01-01 00:00", "name": "角色B", "monthlyTokenQuota": 100, "permissions": []},
            {"id": "ROLE-Z", "createdAt": "2026-01-01 00:00", "name": "角色Z", "monthlyTokenQuota": 0, "permissions": []},
            {"id": "ROLE-N", "createdAt": "2026-01-01 00:00", "name": "角色N", "permissions": []},  # 缺字段
        ],
        ensure_ascii=False,
    ),
    encoding="utf-8",
)
(CRM_DATA / "accounts.json").write_text(
    json.dumps(
        [
            {"id": "ACCT-A", "phone": "13000000001", "name": "用户A", "roleId": "ROLE-A", "roleName": "角色A"},
            {"id": "ACCT-B", "phone": "13000000002", "name": "用户B", "roleId": "ROLE-B", "roleName": "角色B"},
            {"id": "ACCT-Z", "phone": "13000000003", "name": "用户Z", "roleId": "ROLE-Z", "roleName": "角色Z"},
            {"id": "ACCT-N", "phone": "13000000004", "name": "用户N", "roleId": "ROLE-N", "roleName": "角色N"},
        ],
        ensure_ascii=False,
    ),
    encoding="utf-8",
)

import server  # noqa: E402
import crm_permissions  # noqa: E402

TMP_DB = TMP / "chat.db"
server.DB_PATH = TMP_DB
server.init_db()


# ---------------------------------------------------------------------------
# 测试框架
# ---------------------------------------------------------------------------
PASS = 0
FAIL = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} :: {extra}")


def insert_metric(phone: str, name: str, tokens: int, ts_offset_days: int = 0, role_name: str = "") -> None:
    """往临时库插一条指标行；ts 用北京时间偏移。"""
    db = server.get_db()
    # 用 SQLite 直接算「北京时间 now + 偏移」，避免手算时间
    row = db.execute(
        "SELECT datetime('now', '+8 hours', ?) AS t", (f"{ts_offset_days} days",)
    ).fetchone()
    db.execute(
        "INSERT INTO agent_metrics (ts, session_id, model, latency_ms, ok, prompt_tokens,"
        " completion_tokens, total_tokens, llm_calls, tool_calls, tokens_estimated, tools_json,"
        " owner_phone, owner_name, owner_role_id, owner_role_name)"
        " VALUES (?, ?, ?, 0, 1, ?, 0, ?, 0, 0, 0, '[]', ?, ?, '', ?)",
        (row["t"], f"sess-{uuid.uuid4().hex[:6]}", "m", tokens, tokens, phone, name, role_name),
    )
    db.commit()
    db.close()


print("=" * 68)
print("A. 角色额度解析")
print("=" * 68)

check("角色A 额度 = 1000000", crm_permissions.role_monthly_quota(
    {"monthlyTokenQuota": 1000000}) == 1000000)
check("角色B 额度 = 100", crm_permissions.role_monthly_quota(
    {"monthlyTokenQuota": 100}) == 100)
check("额度 0 → 不限额（保留 0）", crm_permissions.role_monthly_quota(
    {"monthlyTokenQuota": 0}) == 0)
check("缺字段 → 默认 100 万", crm_permissions.role_monthly_quota(
    {"name": "x"}) == crm_permissions.DEFAULT_MONTHLY_TOKEN_QUOTA)
check("None 角色 → 默认 100 万", crm_permissions.role_monthly_quota(
    None) == crm_permissions.DEFAULT_MONTHLY_TOKEN_QUOTA)
check("非法值 'abc' → 默认 100 万", crm_permissions.role_monthly_quota(
    {"monthlyTokenQuota": "abc"}) == crm_permissions.DEFAULT_MONTHLY_TOKEN_QUOTA)
check("负数 → 默认 100 万", crm_permissions.role_monthly_quota(
    {"monthlyTokenQuota": -5}) == crm_permissions.DEFAULT_MONTHLY_TOKEN_QUOTA)
check("空字符串 → 默认 100 万", crm_permissions.role_monthly_quota(
    {"monthlyTokenQuota": ""}) == crm_permissions.DEFAULT_MONTHLY_TOKEN_QUOTA)
check("浮点 1500000.0 → 1500000", crm_permissions.role_monthly_quota(
    {"monthlyTokenQuota": 1500000.0}) == 1500000)

# 角色 → 账号 → 额度 全链路
info_a = crm_permissions.resolve_agent_scope(phone="13000000001")
check("resolve_agent_scope 带出 monthly_token_quota", info_a.get("monthly_token_quota") == 1000000,
      str(info_a.get("monthly_token_quota")))
info_n = crm_permissions.resolve_agent_scope(phone="13000000004")
check("缺字段角色经全链路 → 默认 100 万",
      info_n.get("monthly_token_quota") == crm_permissions.DEFAULT_MONTHLY_TOKEN_QUOTA)
check("describe 含 quota", "quota=" in crm_permissions.describe(info_a))

print()
print("=" * 68)
print("B. 本月用量聚合（北京自然月）")
print("=" * 68)

# 用户A：本月 300 + 200 = 500，上月 9999（不该计入）
insert_metric("13000000001", "用户A", 300, ts_offset_days=0, role_name="角色A")
insert_metric("13000000001", "用户A", 200, ts_offset_days=0, role_name="角色A")
insert_metric("13000000001", "用户A", 9999, ts_offset_days=-40, role_name="角色A")

used_a = server.monthly_used_tokens("13000000001", "用户A")
check(f"用户A 本月 = 500（上月 9999 不计入），实得 {used_a}", used_a == 500, str(used_a))

# 用户B：本月 150（超额度 100）
insert_metric("13000000002", "用户B", 150, ts_offset_days=0, role_name="角色B")
used_b = server.monthly_used_tokens("13000000002", "用户B")
check(f"用户B 本月 = 150，实得 {used_b}", used_b == 150, str(used_b))

# 姓名兜底（无 phone）
insert_metric("", "孤儿用户", 77, ts_offset_days=0)
used_orphan = server.monthly_used_tokens("", "孤儿用户")
check(f"phone 为空按 name 兜底 = 77，实得 {used_orphan}", used_orphan == 77, str(used_orphan))

check("空身份 → 0", server.monthly_used_tokens("", "") == 0)
check("不存在的用户 → 0", server.monthly_used_tokens("19999999999", "查无此人") == 0)

# 月份起点格式
ms = server._current_month_start()
check(f"月份起点格式 YYYY-MM-01（实得 {ms}）",
      len(ms) == 10 and ms.endswith("-01") and ms[4] == "-", ms)

print()
print("=" * 68)
print("C. resolve_quota 合成")
print("=" * 68)

q_a = server.resolve_quota(info_a)
check("用户A used=500", q_a["used"] == 500, str(q_a["used"]))
check("用户A quota=1000000", q_a["quota"] == 1000000, str(q_a["quota"]))
check("用户A remaining = 999500", q_a["remaining"] == 999500, str(q_a["remaining"]))
check("用户A 未超限", q_a["exceeded"] is False)
check("用户A 非不限额", q_a["unlimited"] is False)
check("用户A percent ≈ 0.05", abs(q_a["percent"] - 0.05) < 0.001, str(q_a["percent"]))

info_b = crm_permissions.resolve_agent_scope(phone="13000000002")
q_b = server.resolve_quota(info_b)
check("用户B used=150 >= quota=100 → 超限", q_b["exceeded"] is True,
      f"used={q_b['used']} quota={q_b['quota']}")
check("用户B remaining 夹到 0", q_b["remaining"] == 0, str(q_b["remaining"]))
check("用户B percent = 150", abs(q_b["percent"] - 150.0) < 0.01, str(q_b["percent"]))

info_z = crm_permissions.resolve_agent_scope(phone="13000000003")
q_z = server.resolve_quota(info_z)
check("用户Z quota=0 → 不限额", q_z["unlimited"] is True)
check("用户Z 不限额 → 永不超限", q_z["exceeded"] is False)
check("用户Z remaining = -1（无限）", q_z["remaining"] == -1, str(q_z["remaining"]))

# 边界：刚好等于额度即算超限（used >= quota）
insert_metric("13000000005", "边界用户", 100, ts_offset_days=0)
edge_info = {"monthly_token_quota": 100, "user_phone": "13000000005", "user_name": "边界用户", "role_name": "R"}
q_edge = server.resolve_quota(edge_info)
check("used == quota → 判超限（>=）", q_edge["exceeded"] is True,
      f"used={q_edge['used']} quota={q_edge['quota']}")

print()
print("=" * 68)
print("D/E. chat 端点超限守卫")
print("=" * 68)


async def _collect(agen):
    out = []
    async for chunk in agen:
        out.append(chunk)
    return out


async def _run_guard_tests():
    # 建一个会话（超限用户B）
    db = server.get_db()
    sid_b = str(uuid.uuid4())
    db.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, '额度测试', datetime('now'), datetime('now'))",
        (sid_b,),
    )
    db.commit()
    db.close()

    # D1: 直接调守卫流（不经过真实 chat 端点，避免真调模型）
    chunks = await _collect(
        server._quota_refuse_stream(sid_b, server.QUOTA_EXCEEDED_TEXT, "deepseek-flash")
    )
    joined = "".join(chunks)
    check("守卫流含固定话术", server.QUOTA_EXCEEDED_TEXT in joined, joined[:120])
    check("守卫流发 llm_token 事件", '"event": "llm_token"' in joined)
    check("守卫流发 done 事件", '"done": true' in joined)

    # D2: 话术精确匹配需求原文
    check("话术 = 「当前额度已用完，联系管理员申请额度」",
          server.QUOTA_EXCEEDED_TEXT == "当前额度已用完，联系管理员申请额度",
          server.QUOTA_EXCEEDED_TEXT)

    # D3: 落库消息带 is_guard（不进后续历史）
    db = server.get_db()
    rows = db.execute(
        "SELECT role, content, is_guard FROM messages WHERE session_id = ? ORDER BY created_at",
        (sid_b,),
    ).fetchall()
    db.close()
    check("守卫落库 2 条消息", len(rows) == 2, str(len(rows)))
    check("两条都打 is_guard=1", all(r["is_guard"] == 1 for r in rows),
          str([r["is_guard"] for r in rows]))
    check("助手消息内容 = 话术",
          any(r["role"] == "assistant" and r["content"] == server.QUOTA_EXCEEDED_TEXT for r in rows))

    # E: 未超限用户不拦截 —— resolve_quota 对用户A 返回 exceeded=False
    check("未超限用户A 不触发守卫", server.resolve_quota(info_a)["exceeded"] is False)


asyncio.run(_run_guard_tests())

# 守卫不产生 token 消耗（用真实存在的会话，避免 messages 外键报错）
db = server.get_db()
before = db.execute("SELECT COUNT(*) c FROM agent_metrics").fetchone()["c"]
db.close()
db = server.get_db()
sid_probe = str(uuid.uuid4())
db.execute(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, '消耗探针', datetime('now'), datetime('now'))",
    (sid_probe,),
)
db.commit()
db.close()
asyncio.run(_collect(server._quota_refuse_stream(sid_probe, server.QUOTA_EXCEEDED_TEXT, "m")))
db = server.get_db()
after = db.execute("SELECT COUNT(*) c FROM agent_metrics").fetchone()["c"]
db.close()
check("守卫轮不写 agent_metrics（不消耗额度）", before == after, f"{before} vs {after}")

print()
print("=" * 68)
print(f"结果：PASS={PASS}  FAIL={FAIL}")
print("=" * 68)

# 清理
try:
    import shutil
    shutil.rmtree(TMP, ignore_errors=True)
    print(f"（临时库与临时 CRM 数据已删除：{TMP}）")
except Exception:  # noqa: BLE001
    pass

sys.exit(1 if FAIL else 0)
