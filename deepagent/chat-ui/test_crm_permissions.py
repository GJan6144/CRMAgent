"""CRM 工具权限策略 端到端测试（SSE）。

验证三档权限：
  查询 → 直接执行（无审批卡片）
  新增/修改 → 弹卡片人工审批（批准=落盘 / 拒绝=不变）
  删除 → 禁止（crm_delete 作为「拦截桩」暴露给模型：调用必被拦截，推送 tool_blocked
         事件让前端弹出「禁止」提示，数据保持不变）

测试会话在结束时删除。CRM 数据由 `crm_data_guard` 在进程退出时**逐字节还原** ——
这些用例走的是活的 Agent，写入是真写的、删除又被策略禁止，测试自己清不干净。
"""
import json
import threading
import time

import requests

from crm_data_guard import install_guard

install_guard()

BASE = "http://127.0.0.1:8765"

# --- 会话隔离：会话接口要求声明调用方身份（见 server.py 会话隔离设计）---
# 未带身份时：列表返回空、单会话按「不存在」返回 404。测试脚本必须带上。
_IDENT = {"user_phone": '13912345678', "user_name": '系统管理员'}
_Q = "user_phone=13912345678&user_name=%E7%B3%BB%E7%BB%9F%E7%AE%A1%E7%90%86%E5%91%98"

CRM_LEADS = r"C:\Users\Administrator\Documents\deepagent\CRM_Agent1.0\data\leads.json"

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} :: {extra}")


def leads_rows():
    with open(CRM_LEADS, encoding="utf-8") as f:
        return json.load(f)


def make_session(title):
    r = requests.post(f"{BASE}/api/sessions", json={"title": title, **_IDENT}, timeout=15)
    r.raise_for_status()
    return r.json()["id"]


def send(session_id, content, decide=None, timeout=600):
    """发一条消息并读完 SSE。decide: None(不审批) / True(批准) / False(拒绝)。"""
    events = []
    with requests.post(
        f"{BASE}/api/chat",
        json={"session_id": session_id, "content": content, "use_search": False, **_IDENT},
        stream=True,
        timeout=timeout,
    ) as r:
        r.raise_for_status()
        for raw in r.iter_lines(decode_unicode=True):
            if not raw:
                continue
            line = raw.strip()
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except Exception:
                continue
            events.append(ev)
            if ev.get("event") == "approval_request" and decide is not None:
                names = [a.get("name") for a in ev.get("requests", [])]

                def _approve():
                    time.sleep(0.8)
                    try:
                        requests.post(
                            f"{BASE}/api/chat/{session_id}/approve",
                            params=_IDENT,
                            json={"approved": decide, "session_id": session_id},
                            timeout=15,
                        )
                        print(f"    -> 审批决定 approved={decide} 针对 {names}")
                    except Exception as e:  # noqa: BLE001
                        print("    -> 审批发送失败", e)

                threading.Thread(target=_approve, daemon=True).start()
            if ev.get("event") in ("done", "error"):
                break
    return events


def kinds_of(events):
    k = {}
    for e in events:
        k[e.get("event")] = k.get(e.get("event"), 0) + 1
    return k


def tool_names(events, kind="tool_start"):
    return [e.get("name") for e in events if e.get("event") == kind]


def reply_text(events):
    return "".join(e.get("token", "") for e in events if e.get("event") == "llm_token")


def approval_requests(events):
    out = []
    for e in events:
        if e.get("event") == "approval_request":
            out.append(e.get("requests", []))
    return out


# ---------------------------------------------------------------- 0. 工具清单
print("=" * 64)
print("0. Agent 工具清单（crm_delete 作为拦截桩可见）")
print("=" * 64)
sid = make_session("__权限测试_工具清单__")
try:
    ctx = requests.get(f"{BASE}/api/context/{sid}", params=_IDENT, timeout=20).json()
    tool_names_ctx = [t.get("name") for t in (ctx.get("tools") or [])]
    print("工具清单:", tool_names_ctx)
    check("0.1 crm_delete 作为拦截桩对模型可见", "crm_delete" in tool_names_ctx)
    check("0.2 crm_create 在工具清单", "crm_create" in tool_names_ctx)
    check("0.3 crm_update 在工具清单", "crm_update" in tool_names_ctx)
    check("0.4 读工具在清单", all(t in tool_names_ctx for t in
                                 ("crm_list_entities", "crm_query", "crm_get", "crm_stats")))
    caps = requests.get(f"{BASE}/api/capabilities", timeout=15).json()
    check("0.5 capabilities.tool_policy", caps.get("tool_policy") ==
          {"read": "allow", "write": "approval", "delete": "deny"}, str(caps.get("tool_policy")))
    check("0.6 capabilities.approval_on", set(caps.get("approval_on") or []) ==
          {"crm_create", "crm_update"}, str(caps.get("approval_on")))
    check("0.7 capabilities.crm_denied_tools", set(caps.get("crm_denied_tools") or []) ==
          {"crm_delete"}, str(caps.get("crm_denied_tools")))
    check("0.8 capabilities.blocked_tools 含 crm_delete",
          "crm_delete" in (caps.get("blocked_tools") or []), str(caps.get("blocked_tools")))
    check("0.9 capabilities.blocked_event", caps.get("blocked_event") == "tool_blocked",
          str(caps.get("blocked_event")))
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

# ---------------------------------------------------------------- A. 查询直接执行
print()
print("=" * 64)
print("A. 查询 → 直接执行（无审批）")
print("=" * 64)
sid = make_session("__权限测试_查询__")
try:
    evs = send(sid, "统计一下 CRM 销售线索总数，按来源分组，只回答统计结果。")
    k = kinds_of(evs)
    print("事件统计:", k)
    called = set(tool_names(evs, "tool_start"))
    print("调用工具:", called)
    check("A1 调用了读工具", bool(called & {"crm_list_entities", "crm_stats", "crm_query"}), str(called))
    check("A2 未弹出审批卡片", k.get("approval_request", 0) == 0, str(k))
    check("A3 无错误事件", k.get("error", 0) == 0, str(k))
    check("A4 有最终回复", len(reply_text(evs).strip()) > 0, reply_text(evs)[:80])
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

# ---------------------------------------------------------------- B. 修改 → 批准
print()
print("=" * 64)
print("B. 修改(crm_update) → 批准")
print("=" * 64)
rows = leads_rows()
target = rows[0]["id"]
old_remark = rows[0].get("remark", "")
print(f"目标记录 {target}，remark 原值: {old_remark!r}")
sid = make_session("__权限测试_修改批准__")
try:
    evs = send(sid, f"把线索 {target} 的备注(remark) 改成「权限测试-已批准」。", decide=True)
    k = kinds_of(evs)
    print("事件统计:", k)
    ars = approval_requests(evs)
    check("B1 弹出审批卡片", len(ars) >= 1, str(k))
    if ars:
        reqs = ars[0]
        print("审批项:", json.dumps(reqs, ensure_ascii=False)[:400])
        check("B2 审批项为 crm_update", any(r.get("name") == "crm_update" for r in reqs), str(reqs)[:200])
        check("B3 审批项带 kind=crm", any(r.get("kind") == "crm" for r in reqs), str(reqs)[:250])
    rows2 = leads_rows()
    hit = [r for r in rows2 if r.get("id") == target]
    check("B4 批准后字段已变更",
          bool(hit) and hit[0].get("remark") == "权限测试-已批准",
          str(hit[:1])[:200])
    check("B5 记录数不变", len(rows2) == len(rows), f"{len(rows)} -> {len(rows2)}")
    check("B6 无错误事件", k.get("error", 0) == 0, str(k))
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

# ---------------------------------------------------------------- C. 修改 → 拒绝
print()
print("=" * 64)
print("C. 修改(crm_update) → 拒绝")
print("=" * 64)
rows = leads_rows()
target = rows[1]["id"]
before_val = rows[1].get("remark", "")
print(f"目标记录 {target}，remark 原值: {before_val!r}")
sid = make_session("__权限测试_修改拒绝__")
try:
    evs = send(sid, f"把线索 {target} 的备注(remark) 改成「权限测试-应被拒绝」。", decide=False)
    k = kinds_of(evs)
    print("事件统计:", k)
    check("C1 弹出审批卡片", k.get("approval_request", 0) >= 1, str(k))
    rows2 = leads_rows()
    hit = [r for r in rows2 if r.get("id") == target]
    check("C2 拒绝后字段未变",
          bool(hit) and hit[0].get("remark", "") == before_val,
          f"now={hit[0].get('remark','')!r}" if hit else "missing")
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

# ---------------------------------------------------------------- D. 新增 → 批准
print()
print("=" * 64)
print("D. 新增(crm_create) → 批准")
print("=" * 64)
before_n = len(leads_rows())
print("新增前 leads 条数:", before_n)
sid = make_session("__权限测试_新增批准__")
try:
    evs = send(sid, "新增一条销售线索：姓名「权限测试客户」，电话 13700001111，来源 官网，优先级 medium。", decide=True)
    k = kinds_of(evs)
    print("事件统计:", k)
    ars = approval_requests(evs)
    check("D1 弹出审批卡片", len(ars) >= 1, str(k))
    if ars:
        check("D2 审批项为 crm_create",
              any(r.get("name") == "crm_create" for r in ars[0]), str(ars[0])[:200])
    after_n = len(leads_rows())
    print("新增后 leads 条数:", after_n)
    check("D3 批准后 +1", after_n == before_n + 1, f"{before_n} -> {after_n}")
    hit = [r for r in leads_rows() if r.get("name") == "权限测试客户"]
    check("D4 新增记录内容正确", bool(hit) and hit[0].get("phone") == "13700001111", str(hit[:1])[:200])
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

# ---------------------------------------------------------------- E. 删除 → 禁止
print()
print("=" * 64)
print("E. 删除(crm_delete) → 禁止")
print("=" * 64)
rows = leads_rows()
target = rows[0]["id"]
before_n = len(rows)
print(f"要求删除 {target}，删除前条数: {before_n}")
sid = make_session("__权限测试_删除禁止__")
try:
    evs = send(sid, f"帮我删除线索 {target}，直接删掉。", decide=True)  # 即便给了批准也应无效
    k = kinds_of(evs)
    print("事件统计:", k)
    starts = tool_names(evs, "tool_start")
    print("调用工具:", starts)
    blocked = [e for e in evs if e.get("event") == "tool_blocked"]
    print("禁止事件:", [(b.get("name"), b.get("policy")) for b in blocked])
    e2 = next((b for b in blocked if b.get("name") == "crm_delete"), {})
    # 拦截桩：模型应当调用 crm_delete，并被推送「禁止」事件（而不是普通失败）
    check("E1 模型调用了 crm_delete（拦截桩）", "crm_delete" in starts, str(starts))
    check("E2 推送了 tool_blocked 事件", bool(e2), str([b.get("name") for b in blocked]))
    check("E3 禁止事件带原因与策略",
          bool(str(e2.get("reason") or "")) and e2.get("policy") == "crm_delete",
          str(e2)[:200])
    check("E4 禁止事件带参数（供前端展示）", bool(str(e2.get("args") or "").strip()),
          str(e2.get("args"))[:120])
    # 不得出现任何成功的 crm_delete 执行
    bad = [e for e in evs
           if e.get("event") == "tool_end" and e.get("name") == "crm_delete"
           and e.get("tool_status") == "success"]
    check("E5 无成功的 crm_delete 执行", not bad, str(bad[:1])[:200])
    check("E6 未弹出审批卡片", k.get("approval_request", 0) == 0, str(k))
    rows2 = leads_rows()
    check("E7 数据未被删除", len(rows2) == before_n and any(r.get("id") == target for r in rows2),
          f"{before_n} -> {len(rows2)}")
    check("E8 无错误事件", k.get("error", 0) == 0, str(k))
    check("E9 有回复（说明删除被禁用）", len(reply_text(evs).strip()) > 0, reply_text(evs)[:120])
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

print()
print("=" * 64)
print(f"合计: {PASS}/{PASS + FAIL} 通过")
print("=" * 64)
