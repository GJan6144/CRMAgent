# -*- coding: utf-8 -*-
"""
验证「线索管理 - 跟进人模糊筛选」。

覆盖三层：
  [A] API 契约：assignee 参数存在性、模糊匹配正确性、空值/空白/无命中、与其它筛选叠加
  [B] 权限叠加：销售(仅自己) 下 assignee 筛选不能绕过数据范围（越权关键字查不到别人的线索）
  [C] 幂等：全程只读，不改动任何数据

运行：python -X utf8 _verify_lead_assignee_filter.py
"""
import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3100"

PASS = 0
FAIL = 0
FAILED = []


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}")
    else:
        FAIL += 1
        FAILED.append(label)
        print(f"  [FAIL] {label}  {detail}")


def get(path, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def leads(**kw):
    kw.setdefault("pageSize", "200")
    status, body = get("/api/leads", kw)
    return status, body


print("=" * 72)
print("线索管理 - 跟进人模糊筛选 验证")
print("=" * 72)

# ---------------------------------------------------------------- 基线
print("\n[A] API 契约")
status, base = leads()
check("无筛选时接口 200", status == 200, f"status={status}")
all_leads = base["data"]
base_total = base["total"]
print(f"       基线：total={base_total}，返回 {len(all_leads)} 条")

owners = {}
for l in all_leads:
    owners[l["assignee"]] = owners.get(l["assignee"], 0) + 1
print(f"       跟进人分布：{json.dumps(owners, ensure_ascii=False)}")
check("基线存在多个跟进人（便于验证模糊匹配）", len(owners) >= 2, f"owners={list(owners)}")

if len(owners) < 2:
    print("\n数据不足，无法继续。")
    sys.exit(1)

# 取一个至少有 2 条的跟进人名字，做「完整名」精确命中
target_full = max(owners, key=lambda k: owners[k])
target_count = owners[target_full]
# 取姓氏（首字）做「模糊」命中
surname = target_full[0]

# ---------------------------------------------------- 完整名匹配
status, r1 = leads(assignee=target_full)
check(f"按完整姓名「{target_full}」筛选 → 200", status == 200, f"status={status}")
check(
    f"完整姓名命中数 == 基线该跟进人数（{target_count}）",
    r1["total"] == target_count,
    f"got={r1['total']} want={target_count}",
)
check(
    "完整姓名结果全部属于该跟进人",
    all(l["assignee"] == target_full for l in r1["data"]),
    f"got={sorted({l['assignee'] for l in r1['data']})}",
)

# ---------------------------------------------------- 模糊（姓氏）匹配
status, r2 = leads(assignee=surname)
check(f"按姓氏「{surname}」模糊筛选 → 200", status == 200, f"status={status}")
expect_contains = sum(c for n, c in owners.items() if surname in n)
check(
    f"模糊命中数 == 所有含「{surname}」的跟进人条数之和（{expect_contains}）",
    r2["total"] == expect_contains,
    f"got={r2['total']} want={expect_contains}",
)
check(
    "模糊结果中的跟进人都包含关键字",
    all(surname in l["assignee"] for l in r2["data"]),
    f"got={sorted({l['assignee'] for l in r2['data']})}",
)
check(
    "★ 模糊匹配是「包含」而非「等于」（含关键字的其它名字也被带回）",
    r2["total"] >= r1["total"],
    f"fuzzy={r2['total']} exact={r1['total']}",
)

# ---------------------------------------------------- 边界
status, r3 = leads(assignee="")
check("assignee 传空串 → 等价于不筛选（返回全量）", r3["total"] == base_total, f"got={r3['total']} want={base_total}")

status, r4 = leads(assignee="   ")
check("assignee 全空白 → trim 后不筛选（返回全量）", r4["total"] == base_total, f"got={r4['total']} want={base_total}")

status, r5 = leads(assignee="  " + target_full + "  ")
check("assignee 带首尾空格 → trim 后仍正确命中", r5["total"] == target_count, f"got={r5['total']} want={target_count}")

status, r6 = leads(assignee="__不存在的跟进人__")
check("不存在的跟进人 → 200 且 total=0（不是报错）", status == 200 and r6["total"] == 0, f"status={status} total={r6['total']}")

status, r7 = leads(assignee=target_full, priority="high")
check(
    "与其它筛选叠加（assignee + priority=high）→ 结果同时满足两个条件",
    all(l["assignee"] == target_full and l["priority"] == "high" for l in r7["data"])
    and r7["total"] <= r1["total"],
    f"total={r7['total']} vs assignee_only={r1['total']}",
)

# ---------------------------------------------------- 中文/URL 编码
# ⚠️ 这里不要手动 quote：get() 内部用 urlencode 已经做过一次编码，
#    再 quote 一次会变成「%E7%8E%8B」被当作字面文本，必然查不到（曾因此假失败）。
status, r8 = get("/api/leads", {"assignee": surname, "pageSize": "200"})
check(
    "中文关键字经 urlencode 传输正常（不双重编码）",
    status == 200 and r8["total"] == expect_contains,
    f"status={status} total={r8['total']} want={expect_contains}",
)

# ---------------------------------------------------------------- 权限叠加
print("\n[B] 权限叠加（销售「仅自己」不得被 assignee 参数绕过）")

# 找一位销售身份的线索归属人（张明 13800001001 / 销售）
SALES_PHONE = "13800001001"
SALES_NAME = "张明"

status, other = leads(assignee=target_full, user_phone=SALES_PHONE, user_name=SALES_NAME, role_id="ROLE-2026-0002")
own_count = owners.get(SALES_NAME, 0)
if target_full == SALES_NAME:
    check("★ 销售查自己的名字 → 返回自己的线索", other["total"] == own_count, f"got={other['total']} want={own_count}")
else:
    check(
        f"★ 销售查别人的名字「{target_full}」→ 一条都拿不到（数据范围优先于筛选）",
        other["total"] == 0,
        f"got={other['total']}（说明筛选绕过了数据范围！）",
    )

status, own = leads(user_phone=SALES_PHONE, user_name=SALES_NAME, role_id="ROLE-2026-0002")
check(
    f"销售不带筛选时的可见量 == 自己的线索数（{own_count}）",
    own["total"] == own_count,
    f"got={own['total']} want={own_count}",
)
check(
    "★ 销售 可见量 == 全量 > 自己的量（确认「仅自己」确实在生效，测试有意义）",
    own_count < base_total,
    f"own={own_count} base={base_total}",
)
status, self_fuzzy = leads(
    assignee=SALES_NAME[0],
    user_phone=SALES_PHONE,
    user_name=SALES_NAME,
    role_id="ROLE-2026-0002",
)
check(
    "★ 销售用姓氏模糊查 → 不会因为「别人也含这个字」而看到别人的线索",
    all(l["assignee"] == SALES_NAME for l in self_fuzzy["data"]),
    f"got={sorted({l['assignee'] for l in self_fuzzy['data']})}",
)

# ---------------------------------------------------------------- 汇总
print("\n" + "=" * 72)
print(f"结果：PASS={PASS}  FAIL={FAIL}")
if FAILED:
    print("失败项：")
    for f in FAILED:
        print(f"  - {f}")
print("=" * 72)
sys.exit(1 if FAIL else 0)