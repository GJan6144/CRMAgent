"""crm_tools 单元测试（临时数据目录，不碰真实 CRM 数据）。"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# 真实数据目录
REAL = Path(r"C:\Users\Administrator\Documents\deepagent\CRM_Agent1.0\data")
TMP = Path(tempfile.mkdtemp(prefix="crmtest_"))
for f in REAL.glob("*.json"):
    shutil.copy2(f, TMP / f.name)

os.environ["CRM_DATA_DIR"] = str(TMP)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import crm_tools as C  # noqa: E402

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {extra}")


def call(t, **kw):
    """调用 @tool 包装的函数本体。"""
    fn = getattr(t, "func", t)
    return fn(**kw)


print("数据目录:", C.CRM_DATA_DIR)
print("=" * 60)

# --- 套一：读取 ---
r = call(C.crm_list_entities)
check("crm_list_entities 返回 6 个实体", all(e in r for e in ["leads", "orders", "products", "accounts", "communications", "sales-targets"]), r[:200])

r = call(C.crm_query, entity="leads", limit=3)
check("crm_query leads 返回表格", "| id |" in r and "LD-2026-" in r, r[:200])

r = call(C.crm_query, entity="线索", limit=2)
check("crm_query 中文别名『线索』可用", "LD-2026-" in r, r[:200])

r = call(C.crm_query, entity="leads", filters='{"source":"抖音"}', limit=50)
check("crm_query 按 source 过滤", "抖音" in r, r[:200])

r = call(C.crm_query, entity="leads", filters="priority=high", limit=50)
check("crm_query filters 支持 k=v", "| high |" in r or "high" in r, r[:300])

r = call(C.crm_query, entity="leads", keyword="王小明")
check("crm_query 关键词搜索", "王小明" in r, r[:200])

r = call(C.crm_query, entity="orders", sort_by="amount", order="desc", limit=3)
check("crm_query 按 amount 排序", "amount" in r, r[:200])

r = call(C.crm_get, entity="leads", record_id="LD-2026-0001")
check("crm_get 单条", "王小明" in r and "**" in r, r[:200])

r = call(C.crm_get, entity="leads", record_id="NOPE-999")
check("crm_get 不存在返回提示", "未找到记录" in r, r[:200])

r = call(C.crm_stats, entity="leads", group_by="source")
check("crm_stats 分组计数", "按 source 分组" in r and "数量" in r, r[:200])

r = call(C.crm_stats, entity="orders", sum_field="amount")
check("crm_stats 数值求和", "合计" in r, r[:200])

# 敏感字段脱敏
r = call(C.crm_query, entity="accounts", limit=5)
check("accounts 列表不含明文密码", "123123" not in r, r[:300])
r = call(C.crm_get, entity="accounts", record_id="ACCT-2026-0001")
check("accounts 单条读取 password 脱敏", "******" in r and "123123" not in r, r[:300])

# --- 套二：写入 ---
r = call(C.crm_create, entity="leads", data=json.dumps({"name": "测试小明", "phone": "13900001111", "source": "抖音", "priority": "high"}, ensure_ascii=False))
check("crm_create 新增成功", "已新增" in r and "测试小明" in r, r[:200])
new_id = r.split("：")[1].split("（")[0].split()[0].strip()
check("新 id 前缀正确", new_id.startswith("LD-2026-"), new_id)

rows = json.loads((TMP / "leads.json").read_text(encoding="utf-8"))
created = [x for x in rows if x.get("name") == "测试小明"]
check("新记录已落盘", len(created) == 1, str(created))
check("createdAt 自动生成", bool(created and created[0].get("createdAt")), str(created[:1]))

r = call(C.crm_update, entity="leads", record_id=new_id, data=json.dumps({"priority": "low", "status": "跟进中"}, ensure_ascii=False))
check("crm_update 修改成功", "已修改" in r and "priority" in r, r[:250])

rows = json.loads((TMP / "leads.json").read_text(encoding="utf-8"))
upd = [x for x in rows if x.get("id") == new_id][0]
check("修改已落盘", upd.get("priority") == "low" and upd.get("status") == "跟进中", str(upd))

r = call(C.crm_update, entity="leads", record_id="NOPE-999", data='{"status":"x"}')
check("crm_update 不存在返回提示", "未找到记录" in r, r[:200])

r = call(C.crm_delete, entity="leads", record_id=new_id)
check("crm_delete 删除成功", "已删除" in r, r[:200])
rows = json.loads((TMP / "leads.json").read_text(encoding="utf-8"))
check("删除已落盘", all(x.get("id") != new_id for x in rows), "")

r = call(C.crm_delete, entity="leads", record_id="NOPE-999")
check("crm_delete 不存在返回提示", "未找到记录" in r, r[:200])

# 数值字段类型矫正
r = call(C.crm_create, entity="products", data=json.dumps({"productNo": "PROD-999", "name": "测试课", "price": "1234"}, ensure_ascii=False))
rows = json.loads((TMP / "products.json").read_text(encoding="utf-8"))
p = [x for x in rows if x.get("productNo") == "PROD-999"][0]
check("数值字段 price 被转成 number", isinstance(p.get("price"), int), repr(p.get("price")))

# 未知实体报错
try:
    call(C.crm_query, entity="nope")
    check("未知实体抛错", False)
except ValueError:
    check("未知实体抛错", True)

# 落盘格式：CRLF / 无 BOM / indent 2
raw = (TMP / "leads.json").read_bytes()
check("落盘为 CRLF", b"\r\n" in raw and b"\r\r" not in raw, "")
check("落盘无 BOM", not raw.startswith(b"\xef\xbb\xbf"), "")
check("落盘末尾无换行", not raw.endswith(b"\n"), raw[-4:])

# 行数不变（净增 0）
final_leads = json.loads((TMP / "leads.json").read_text(encoding="utf-8"))
real_leads = json.loads((REAL / "leads.json").read_text(encoding="utf-8"))
check("leads 记录数恢复原值", len(final_leads) == len(real_leads), f"{len(final_leads)} vs {len(real_leads)}")

print("=" * 60)
print(f"合计: {PASS}/{PASS + FAIL} 通过")

shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if FAIL else 0)
