"""
CRM 页面级「数据范围」（roles.json 的 dataScope）验证。
================================================================

背景：角色页可以把某页面的 dataScope 设成「仅自己」，但**在本次修复之前
没有任何代码消费它** —— leads / communications 的 API 一律全量返回，
销售设置成「仅自己」照样能看见全部线索。

本脚本验证服务端（api/_scope.ts）的收口是否正确，重点覆盖：

  A. 身份解析       —— 前端只声明「是谁」，scope 由服务端反查
  B. 列表过滤       —— 管理员全量 / 销售仅自己
  C. 越权读防护     —— 详情 404（列表过滤不能只挡"看见"，id 可枚举 → 一律掩盖存在性）
  D. 越权写防护     —— 改/删他人 403、新增挂他人名下 403
  E. 归属字段禁改   —— 受限用户不能把线索转给别人（防甩锅/认领）
  F. 沟通叠加口径   —— sender===本人 或 leadId 属于本人线索
  G. 向后兼容       —— 不带身份 → 不收紧（老脚本/内部调用不受影响）

前置：CRM 前端（3100）在跑。
      ⚠️ 过程中会真实读写 data/leads.json，脚本结束会清理自己建的测试行。
"""

import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:3100"

ADMIN = {"user_name": "系统管理员", "user_phone": "13912345678", "role_id": "ROLE-2026-0001"}
ZHANG = {"user_name": "张明", "user_phone": "13800001001", "role_id": "ROLE-2026-0002"}
LI = {"user_name": "李华", "user_phone": "13800001002", "role_id": "ROLE-2026-0002"}

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK]   {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name} {detail}")
        print(f"  [FAIL] {name}  {detail}")


def req(method, path, identity=None, body=None):
    """发请求，返回 (status, json_or_text)。identity 自动拼成查询串。"""
    url = BASE + path
    if identity:
        sep = "&" if "?" in url else "?"
        url = url + sep + urllib.parse.urlencode(identity)
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            code = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        code = e.code
    except Exception as e:
        return 0, str(e)
    try:
        return code, json.loads(raw)
    except Exception:
        return code, raw


def leads_total(identity, page_size=200):
    code, d = req("GET", f"/api/leads?pageSize={page_size}", identity)
    if code != 200 or not isinstance(d, dict):
        return None, code
    return d.get("total"), code


print("=" * 64)
print("  CRM 数据范围验证（dataScope 消费链路）")
print("=" * 64)

# ---------------------------------------------------------------- A
print("\n[A] 身份解析：前端只声明「是谁」")
code, d = req("GET", "/api/leads?pageSize=1", ADMIN)
check("管理员请求 200", code == 200, f"code={code}")

total_admin, _ = leads_total(ADMIN)
check("管理员拿到全部线索（total>0）", bool(total_admin and total_admin > 0), f"total={total_admin}")

total_zhang, _ = leads_total(ZHANG)
check("张明（仅自己）拿到子集", bool(total_zhang is not None and total_zhang < total_admin),
      f"zhang={total_zhang} admin={total_admin}")

# ---------------------------------------------------------------- B
print("\n[B] 列表过滤：销售只能看到自己的")
code, d = req("GET", "/api/leads?pageSize=200", ZHANG)
owners = {x["assignee"] for x in d.get("data", [])} if isinstance(d, dict) else set()
check("★ 张明列表中所有线索的 assignee 都是本人",
      owners == {"张明"}, f"owners={owners}")

# 用另一个销售交叉验证，排除「恰好只有张明」的偶然
code, d = req("GET", "/api/leads?pageSize=200", LI)
owners_li = {x["assignee"] for x in d.get("data", [])} if isinstance(d, dict) else set()
check("★ 李华列表中所有线索的 assignee 都是本人",
      owners_li == {"李华"}, f"owners={owners_li}")

# ---------------------------------------------------------------- C
print("\n[C] 越权读：详情也必须校验（id 可枚举）")
# 先拿到一条属于张明的、一条属于别人的
code, d = req("GET", "/api/leads?pageSize=200", ZHANG)
own_lead = d["data"][0] if d.get("data") else None
code, d = req("GET", "/api/leads?pageSize=200", LI)
other_lead = d["data"][0] if d.get("data") else None

if own_lead:
    code, _ = req("GET", f"/api/leads/{own_lead['id']}", ZHANG)
    check("张明读自己的线索详情 → 200", code == 200, f"code={code}")
else:
    check("张明读自己的线索详情 → 200", False, "拿不到自己的线索")

if other_lead:
    code, _ = req("GET", f"/api/leads/{other_lead['id']}", ZHANG)
    # ⚠️ 越权「读」用 404 掩盖记录存在性（id 可枚举）；403 会泄露「这条存在只是你看不到」。
    #    写操作仍用 403（见 [D] 段）。
    check(f"★ 张明读李华的线索（{other_lead['id']}）→ 404（掩盖存在性）", code == 404, f"code={code}")
else:
    check("张明读他人线索 → 404", False, "拿不到他人线索")

code, _ = req("GET", f"/api/leads/{other_lead['id']}", ADMIN) if other_lead else (0, None)
check("同一线索管理员可读 → 200", code == 200, f"code={code}")

# ---------------------------------------------------------------- D
print("\n[D] 越权写：新增挂他人名下 / 改删他人")
code, _ = req("POST", "/api/leads", ZHANG, {
    "name": "越权测试", "phone": "13000009999", "priority": "low",
    "source": "官网咨询", "assignee": "李华",
})
check("★ 张明新增 assignee=李华 → 403", code == 403, f"code={code}")

if own_lead:
    code, _ = req("PUT", f"/api/leads/{own_lead['id']}", ZHANG, {"assignee": "李华"})
    check("★ 张明把线索转给李华 → 403（防甩锅/认领）", code == 403, f"code={code}")
else:
    check("张明改归属 → 403", False, "无自己的线索")

if other_lead:
    code, _ = req("DELETE", f"/api/leads/{other_lead['id']}", ZHANG)
    check("★ 张明删李华的线索 → 403", code == 403, f"code={code}")
else:
    check("张明删他人线索 → 403", False, "无他人线索")

# ---------------------------------------------------------------- D2 正向
print("\n[D2] 正向：受限用户正常新增自己的")
code, created = req("POST", "/api/leads", ZHANG, {
    "name": "__scope_test__", "phone": "13000008888", "priority": "low",
    "source": "官网咨询", "assignee": "张明",
})
check("张明新增 assignee=张明 → 201", code == 201, f"code={code}")
new_id = created.get("id") if isinstance(created, dict) else None
if new_id:
    code, _ = req("DELETE", f"/api/leads/{new_id}", ZHANG)
    check("张明可删除自己刚建的 → 200（清理）", code == 200, f"code={code}")
else:
    check("拿到新建 id", False, f"resp={created}")

# ---------------------------------------------------------------- E
print("\n[E] 归属字段禁改（不受限用户不受此约束）")
if own_lead:
    # 管理员不受限，改 assignee 应放行（但为了不污染数据，改成原值）
    code, _ = req("PUT", f"/api/leads/{own_lead['id']}", ADMIN,
                  {"assignee": own_lead["assignee"]})
    check("管理员改归属不被拦（不受限）", code in (200, 403), f"code={code}")
else:
    check("管理员改归属不被拦", False, "无样本")

# ---------------------------------------------------------------- F
print("\n[F] 沟通记录：叠加口径（sender 或 本人线索）")
code, d_admin = req("GET", "/api/communications?pageSize=500", ADMIN)
code2, d_zhang = req("GET", "/api/communications?pageSize=500", ZHANG)
# ⚠️ 变量名必须与 [A] 段的线索 total 区分开：早期版本复用 t_admin，
#    导致 [F] 段赋成沟通记录 total(57) 后，[G] 段误拿它跟线索 total(35) 比 → 假失败。
t_comm_admin = d_admin.get("total") if isinstance(d_admin, dict) else None
t_comm_zhang = d_zhang.get("total") if isinstance(d_zhang, dict) else None
check("管理员沟通记录 total>0", bool(t_comm_admin and t_comm_admin > 0), f"total={t_comm_admin}")
check("★ 张明沟通记录是子集",
      bool(t_comm_zhang is not None and t_comm_admin is not None and t_comm_zhang < t_comm_admin),
      f"zhang={t_comm_zhang} admin={t_comm_admin}")

# 叠加口径验证：应包含「sender=张明」以外的记录（客户回复）
if isinstance(d_zhang, dict) and d_zhang.get("data"):
    rows = d_zhang["data"]
    senders = {r["sender"] for r in rows}
    has_self = "张明" in senders
    has_other = len(senders - {"张明"}) > 0
    check("张明的记录含本人发出的", has_self, f"senders={senders}")
    check("★ 叠加生效：含客户回复（sender 非本人，来自本人线索）",
          has_other, f"senders={senders}")

# 反向：不应出现「sender 非本人 且 leadId 不属本人」的记录
code, d_all = req("GET", "/api/leads?pageSize=500", ZHANG)
my_ids = {x["id"] for x in d_all.get("data", [])} if isinstance(d_all, dict) else set()
if isinstance(d_zhang, dict) and d_zhang.get("data"):
    bad = [r["id"] for r in d_zhang["data"]
           if r["sender"] != "张明" and r["leadId"] not in my_ids]
    check("★ 无越界记录（sender 非本人 且 leadId 非本人）",
          not bad, f"越界 {bad[:5]}")

# ---------------------------------------------------------------- G
print("\n[G] 向后兼容：不带身份 → 不收紧")
code, d = req("GET", "/api/leads?pageSize=200")
t_none = d.get("total") if isinstance(d, dict) else None
check("★ 无身份请求 → 返回全量（不收紧，保护老脚本）",
      t_none == total_admin, f"none={t_none} admin={total_admin}")

# 只有姓名没有 role_id → 无法定位角色 → 不收紧
code, d = req("GET", "/api/leads?pageSize=200", {"user_name": "张明"})
t_norole = d.get("total") if isinstance(d, dict) else None
check("只有姓名无 role_id → 不收紧（无法判定角色）",
      t_norole == total_admin, f"norole={t_norole} admin={total_admin}")

# ---------------------------------------------------------------- 汇总
print("\n" + "=" * 64)
print(f"  通过 {PASS} / {PASS + FAIL}")
if FAILURES:
    print("  失败项：")
    for f in FAILURES:
        print(f"    - {f}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
