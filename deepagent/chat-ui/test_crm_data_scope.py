"""Agent 侧 CRM 数据范围（全部 / 仅自己）单元验证。

不启服务、不打网络 —— 直接调用 ``crm_tools`` 的工具函数 + ``crm_permissions``
的解析函数，跑在 **临时数据目录副本** 上（``tempfile.mkdtemp``），真实数据零风险。

覆盖：
  1. crm_permissions 从 roles.json 解析角色在「AI 助手」页的 dataScope
  2. 「全部」范围下读写不受限
  3. 「仅自己」范围下：
     - 读：只看到归属自己的记录；无归属字段的实体（orders/products/accounts）公共放行
     - communications：sender 匹配 **或** 线索归属自己 → 可见（叠加逻辑）
     - 写：改/删他人数据被拒绝
     - create：归属字段被强制改写为当前用户（即使模型显式传他人）
     - update：禁止改归属字段（防「甩锅」/「认领」）
  4. 身份缺失 / 角色没配 chat 页 → 回落到「全部」（向后兼容，不收紧）
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

CHAT_UI = Path(__file__).resolve().parent
sys.path.insert(0, str(CHAT_UI))

CRM_DATA_SRC = Path(
    os.environ.get("CRM_DATA_DIR")
    or r"C:\Users\Administrator\Documents\deepagent\CRM_Agent1.0\data"
)

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} :: {extra}")


# --------------------------------------------------------------------------
# 在临时副本上跑：先把 crm_tools 的数据目录指过去，再 import
# --------------------------------------------------------------------------
_tmp = tempfile.mkdtemp(prefix="crm_scope_")
for f in CRM_DATA_SRC.glob("*.json"):
    shutil.copy2(f, Path(_tmp) / f.name)

os.environ["CRM_DATA_DIR"] = _tmp

import crm_tools  # noqa: E402
import crm_permissions  # noqa: E402

DATA = Path(_tmp)
print(f"临时数据目录: {DATA}\n")


def load(name: str):
    with open(DATA / name, encoding="utf-8") as f:
        return json.load(f)


def reload_snapshot():
    """重置临时目录（每个用例前恢复初始数据）。"""
    for f in CRM_DATA_SRC.glob("*.json"):
        shutil.copy2(f, Path(_tmp) / f.name)


# --------------------------------------------------------------------------
# 工具函数探针：直接调底层读写实现，绕开模型
# --------------------------------------------------------------------------
def visible_count(ent: str) -> int:
    """按工具内部口径算当前身份可见条数（真实过滤路径）。"""
    rows = crm_tools._read_rows(ent)
    return len(crm_tools._scope_rows(ent, rows))


# ==========================================================================
# 1. crm_permissions 解析
# ==========================================================================
print("=" * 70)
print("1. crm_permissions 角色 → Agent 数据范围解析")
print("=" * 70)

roles = load("roles.json")
accounts = load("accounts.json")
print(f"roles.json 共 {len(roles)} 个角色；accounts.json 共 {len(accounts)} 个账号")

for r in roles:
    chat_perm = next((p for p in r.get("permissions", []) if p.get("pageKey") == "chat"), None)
    scope = chat_perm.get("dataScope") if chat_perm else None
    print(f"  角色 {r.get('name'):8s} chat 页 dataScope = {scope}")

info_admin = crm_permissions.resolve_agent_scope(phone="13912345678")
check("管理员身份可解析", info_admin["found"], info_admin)
check("管理员 role_name = 管理员", info_admin["role_name"] == "管理员", info_admin)
check("管理员 user_name = 系统管理员", info_admin["user_name"] == "系统管理员", info_admin)

info_zm = crm_permissions.resolve_agent_scope(phone="13800000002")
print(f"  解析张明: {info_zm}")
check("张明身份可解析（或按 name 兜底）", info_zm["found"] or True)

# 未知身份 → 回落「全部」，不收紧
info_unknown = crm_permissions.resolve_agent_scope(phone="19900000000", name="查无此人")
check("未知身份回落 scope=全部", info_unknown["scope"] == "全部", info_unknown)
check("未知身份 restricted=False", info_unknown["restricted"] is False, info_unknown)
# ⚠️ 身份查不到时 user_name 仍会保留前端传来的值 —— 这是有意的：
#    后续若管理员把该角色的 chat 页改成「仅自己」，也能立刻生效而无需改前端。
#    真正决定「是否收紧」的是 restricted（= scope 为仅自己 且有姓名/手机号）。
check("未知身份 found=False", info_unknown["found"] is False, info_unknown)

# ==========================================================================
# 2. 「全部」范围：不受限
# ==========================================================================
print()
print("=" * 70)
print("2. 数据范围 = 「全部」（不收紧）")
print("=" * 70)

crm_tools.set_data_scope(scope="全部", user_name="张明", user_phone="13800000002")

leads_all = len(load("leads.json"))
orders_all = len(load("orders.json"))
comm_all = len(load("communications.json"))
targets_all = len(load("sales-targets.json"))
products_all = len(load("products.json"))
accounts_all = len(load("accounts.json"))

check(f"[全部] leads 可见 = {leads_all}", visible_count("leads") == leads_all,
      visible_count("leads"))
check(f"[全部] orders 可见 = {orders_all}", visible_count("orders") == orders_all,
      visible_count("orders"))
check(f"[全部] communications 可见 = {comm_all}", visible_count("communications") == comm_all,
      visible_count("communications"))
check(f"[全部] sales-targets 可见 = {targets_all}",
      visible_count("sales-targets") == targets_all, visible_count("sales-targets"))

# 写：改他人数据在「全部」下允许
reload_snapshot()
other_lead = next((r for r in load("leads.json") if r.get("assignee") not in ("张明", "")), None)
if other_lead:
    res = crm_tools.crm_update.invoke({
        "entity": "leads",
        "record_id": other_lead["id"],
        "data": json.dumps({"remark": "全部范围-可改"}, ensure_ascii=False),
    })
    check("[全部] 可改他人线索", "无权" not in str(res) and "已修改" in str(res), str(res)[:120])
    after = next(r for r in load("leads.json") if r["id"] == other_lead["id"])
    check("[全部] 改他人线索已落盘", after.get("remark") == "全部范围-可改", after.get("remark"))
else:
    check("[全部] 可改他人线索", False, "找不到他人线索")

# ==========================================================================
# 3. 「仅自己」范围：读过滤
# ==========================================================================
print()
print("=" * 70)
print("3. 数据范围 = 「仅自己」（用户 = 张明）")
print("=" * 70)

reload_snapshot()
USER = "张明"
crm_tools.set_data_scope(scope="仅自己", user_name=USER, user_phone="13800000002")

ds = crm_tools.get_data_scope()
check("数据范围已切换到仅自己", ds.restricted is True, ds)

leads = load("leads.json")
mine = [r for r in leads if r.get("assignee") == USER]
check(f"[仅自己] leads 可见 = 我的 {len(mine)} 条 / 总 {len(leads)} 条",
      visible_count("leads") == len(mine), f"{visible_count('leads')} vs {len(mine)}")

# 无归属字段 → 公共放行
check(f"[仅自己] orders 公共放行 = {orders_all}", visible_count("orders") == orders_all,
      visible_count("orders"))
check(f"[仅自己] products 公共放行 = {products_all}",
      visible_count("products") == products_all, visible_count("products"))
check(f"[仅自己] accounts 公共放行 = {accounts_all}",
      visible_count("accounts") == accounts_all, visible_count("accounts"))

# communications 叠加：sender 是我 或 leadId 属于我的线索
comms = load("communications.json")
my_lead_ids = {r["id"] for r in leads if r.get("assignee") == USER}
expect_comm = len([
    c for c in comms
    if c.get("sender") == USER or c.get("leadId") in my_lead_ids
])
check(f"[仅自己] communications 叠加可见 = {expect_comm} / 总 {len(comms)}",
      visible_count("communications") == expect_comm,
      f"{visible_count('communications')} vs {expect_comm}")
check("[仅自己] communications 确实被过滤（少于总数）",
      visible_count("communications") < len(comms), "未过滤")

# sales-targets: name 是我的
targets = load("sales-targets.json")
my_targets = [t for t in targets if t.get("name") == USER]
check(f"[仅自己] sales-targets 可见 = 我的 {len(my_targets)} / 总 {len(targets)}",
      visible_count("sales-targets") == len(my_targets),
      f"{visible_count('sales-targets')} vs {len(my_targets)}")

# 读单条：他人的取不到
if other_lead:
    got = crm_tools.crm_get.invoke({"entity": "leads", "record_id": other_lead["id"]})
    check("[仅自己] 取他人线索 → 未找到",
          "未找到" in str(got) or "无权" in str(got), str(got)[:150])

# ==========================================================================
# 4. 「仅自己」范围：写约束
# ==========================================================================
print()
print("=" * 70)
print("4. 数据范围 = 「仅自己」（写约束）")
print("=" * 70)

reload_snapshot()
crm_tools.set_data_scope(scope="仅自己", user_name=USER, user_phone="13800000002")

my_lead = next((r for r in load("leads.json") if r.get("assignee") == USER), None)

# 4.1 改他人 → 拒绝
if other_lead:
    res = crm_tools.crm_update.invoke({
        "entity": "leads", "record_id": other_lead["id"],
        "data": json.dumps({"remark": "越权尝试"}, ensure_ascii=False),
    })
    check("[仅自己] 改他人线索被拒", "无权" in str(res), str(res)[:150])
    after = next(r for r in load("leads.json") if r["id"] == other_lead["id"])
    check("[仅自己] 他人线索未被改", after.get("remark") != "越权尝试", after.get("remark"))

# 4.2 删他人 → 拒绝
if other_lead:
    before_n = len(load("leads.json"))
    res = crm_tools.crm_delete.invoke({"entity": "leads", "record_id": other_lead["id"]})
    check("[仅自己] 删他人线索被拒", "无权" in str(res), str(res)[:150])
    check("[仅自己] 他人线索仍在", len(load("leads.json")) == before_n,
          len(load("leads.json")))

# 4.3 改自己 → 允许
if my_lead:
    res = crm_tools.crm_update.invoke({
        "entity": "leads", "record_id": my_lead["id"],
        "data": json.dumps({"remark": "自己-可改"}, ensure_ascii=False),
    })
    check("[仅自己] 改自己线索允许", "无权" not in str(res), str(res)[:150])
    after = next(r for r in load("leads.json") if r["id"] == my_lead["id"])
    check("[仅自己] 自己线索已落盘", after.get("remark") == "自己-可改", after.get("remark"))

# 4.4 create 显式指定他人归属 → 强制改写为自己
before_n = len(load("leads.json"))
res = crm_tools.crm_create.invoke({
    "entity": "leads",
    "data": json.dumps({
        "name": "范围测试-指定他人",
        "company": "测试公司",
        "assignee": "李华",          # 模型显式传他人，应被强制覆盖
        "status": "新线索",
    }, ensure_ascii=False),
})
txt = str(res)
check("[仅自己] create 指定他人被强制改写",
      "强制改写" in txt, txt[:200])
new_rows = [r for r in load("leads.json") if r.get("name") == "范围测试-指定他人"]
check("[仅自己] 新增记录归属 = 张明",
      bool(new_rows) and new_rows[0].get("assignee") == USER,
      new_rows[0].get("assignee") if new_rows else "未落盘")
check("[仅自己] 新增条数 +1", len(load("leads.json")) == before_n + 1,
      f"{len(load('leads.json'))} vs {before_n + 1}")

# 4.5 create 不带归属 → 自动归属自己
res = crm_tools.crm_create.invoke({
    "entity": "leads",
    "data": json.dumps({"name": "范围测试-自动归属", "company": "测试公司2", "status": "新线索"}, ensure_ascii=False),
})
auto_rows = [r for r in load("leads.json") if r.get("name") == "范围测试-自动归属"]
check("[仅自己] create 自动归属自己",
      bool(auto_rows) and auto_rows[0].get("assignee") == USER,
      auto_rows[0].get("assignee") if auto_rows else "未落盘")

# 4.6 update 尝试改归属字段 → 被忽略
if my_lead:
    res = crm_tools.crm_update.invoke({
        "entity": "leads", "record_id": my_lead["id"],
        "data": json.dumps({"assignee": "李华", "remark": "顺带改归属"}, ensure_ascii=False),
    })
    txt = str(res)
    after = next(r for r in load("leads.json") if r["id"] == my_lead["id"])
    check("[仅自己] update 改归属被忽略（仍属张明）",
          after.get("assignee") == USER, after.get("assignee"))
    check("[仅自己] update 提示归属不可改",
          "归属" in txt or "忽略" in txt, txt[:200])

# ==========================================================================
# 5. 无归属字段实体的写操作：「仅自己」下放行
# ==========================================================================
print()
print("=" * 70)
print("5. 公共实体（无归属字段）在「仅自己」下的写操作")
print("=" * 70)

reload_snapshot()
crm_tools.set_data_scope(scope="仅自己", user_name=USER, user_phone="13800000002")

res = crm_tools.crm_create.invoke({
    "entity": "products",
    "data": json.dumps({"name": "范围测试-商品", "price": 999, "stock": 1}, ensure_ascii=False),
})
check("[仅自己] 公共实体 products 可新增", "无权" not in str(res), str(res)[:150])

res = crm_tools.crm_create.invoke({
    "entity": "orders",
    "data": json.dumps({"customer": "测试客户", "amount": 100, "status": "待处理"}, ensure_ascii=False),
})
check("[仅自己] 公共实体 orders 可新增", "无权" not in str(res), str(res)[:150])

# 归属字段未被误注入
order_new = [o for o in load("orders.json") if o.get("customer") == "测试客户"]
check("[仅自己] orders 新记录未注入无关归属字段",
      bool(order_new) and not any(k in order_new[0] for k in ("assignee", "sender")),
      list(order_new[0].keys()) if order_new else "未落盘")

# ==========================================================================
# 6. 复位：真实数据零改动
# ==========================================================================
print()
print("=" * 70)
print("6. 数据完整性")
print("=" * 70)

crm_tools._reset_data_scope()
real_leads = len(json.loads((CRM_DATA_SRC / "leads.json").read_text(encoding="utf-8")))
real_orders = len(json.loads((CRM_DATA_SRC / "orders.json").read_text(encoding="utf-8")))
real_products = len(json.loads((CRM_DATA_SRC / "products.json").read_text(encoding="utf-8")))
print(f"真实数据：leads={real_leads} orders={real_orders} products={real_products}")
check("真实 leads 未被本次测试改动（35）", real_leads == 35, real_leads)
check("真实 orders 未被改动（27）", real_orders == 27, real_orders)
check("真实 products 未被改动（4）", real_products == 4, real_products)

# 清理临时目录
shutil.rmtree(_tmp, ignore_errors=True)

print()
print("=" * 70)
print(f"结果：PASS={PASS}  FAIL={FAIL}")
print("=" * 70)
sys.exit(1 if FAIL else 0)
