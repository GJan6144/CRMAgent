"""chat-ui CRM 工具 + 审批流 端到端测试（SSE）。

覆盖：
  A. 读取：模型调用 crm_* 读工具并给出统计
  B. 写入-批准：触发 approval_request -> approve -> 工具执行 -> 数据落盘
  C. 写入-拒绝：触发 approval_request -> reject -> 数据不变
测试会话在结束时删除。CRM 数据由 `crm_data_guard` 在进程退出时**逐字节还原**
（用例 B 会真的写入落盘，测试自己没法撤销）。
"""
import json
import threading
import time
import uuid

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


def leads_count():
    with open(CRM_LEADS, encoding="utf-8") as f:
        return len(json.load(f))


def make_session(title):
    r = requests.post(f"{BASE}/api/sessions", json={"title": title, **_IDENT}, timeout=15)
    r.raise_for_status()
    return r.json()["id"]


def send(session_id, content, decide=None, timeout=600):
    """发一条消息并读完 SSE。decide: None / True(批准) / False(拒绝)。"""
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
                        print(f"    -> 已发送审批决定 approved={decide} 针对 {names}")
                    except Exception as e:  # noqa: BLE001
                        print("    -> 审批发送失败", e)

                threading.Thread(target=_approve, daemon=True).start()
            if ev.get("event") in ("done", "error"):
                break
    return events


def summarize(events):
    kinds = {}
    tools = []
    for e in events:
        k = e.get("event")
        kinds[k] = kinds.get(k, 0) + 1
        if k == "tool_start":
            tools.append({"kind": "start", "name": e.get("name"), "id": e.get("id")})
        elif k == "tool_end":
            tools.append({"kind": "end", "name": e.get("name"),
                          "status": e.get("tool_status"), "id": e.get("id")})
    return kinds, tools


print("=" * 64)
print("A. 读取流程")
print("=" * 64)
sid = make_session("__自动化测试_CRM读__")
try:
    evs = send(sid, "CRM 里一共有多少条销售线索？按来源分组各有多少？只回答统计结果。")
    kinds, tools = summarize(evs)
    print("事件统计:", kinds)
    print("工具调用:", tools)
    reply = "".join(e.get("token", "") for e in evs if e.get("event") == "llm_token")
    print("回复摘要:", reply[:300].replace("\n", " "))
    starts = [t for t in tools if t["kind"] == "start"]
    ends = [t for t in tools if t["kind"] == "end"]
    called = {t["name"] for t in starts}
    check("A1 调用了 CRM 工具", any((n or "").startswith("crm_") for n in called), str(called))
    check("A2 使用了轻量读工具(list_entities/stats/query)",
          bool(called & {"crm_list_entities", "crm_stats", "crm_query"}), str(called))
    check("A6 tool_start 按 id 去重（无重复）",
          len({t["id"] for t in starts}) == len(starts), str([t["id"] for t in starts]))
    check("A7 tool_start / tool_end 一一对应",
          {t["id"] for t in starts} == {t["id"] for t in ends},
          f"start={[t['id'] for t in starts]} end={[t['id'] for t in ends]}")
    errs = [e for e in evs if e.get("event") == "error"]
    check("A3 无错误事件", not errs, str(errs[:1]))
    check("A4 有最终回复", len(reply.strip()) > 0, reply[:120])
    check("A5 未触发审批（读操作免审批）", kinds.get("approval_request", 0) == 0, str(kinds))
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

print()
print("=" * 64)
print("B. 写入流程 —— 批准")
print("=" * 64)
before = leads_count()
print("写入前 leads 条数:", before)
sid = make_session("__自动化测试_CRM写批准__")
new_name = "自动化测试客户"
try:
    evs = send(
        sid,
        f'请新增一条销售线索：姓名「{new_name}」，电话 13900009999，来源 官网，优先级 high。',
        decide=True,
    )
    kinds, tools = summarize(evs)
    print("事件统计:", kinds)
    print("工具调用:", tools)
    ar = [e for e in evs if e.get("event") == "approval_request"]
    check("B1 触发了审批请求", len(ar) >= 1, str(kinds))
    if ar:
        reqs = ar[0].get("requests", [])
        print("审批请求:", json.dumps(reqs, ensure_ascii=False)[:400])
        check("B2 审批项是 crm_create", any(r.get("name") == "crm_create" for r in reqs), str(reqs)[:200])
        check("B3 审批项带 kind=crm", any(r.get("kind") == "crm" for r in reqs), str(reqs)[:200])
    after = leads_count()
    print("写入后 leads 条数:", after)
    check("B4 批准后数据已落盘(+1)", after == before + 1, f"{before} -> {after}")

    # 校验内容
    with open(CRM_LEADS, encoding="utf-8") as f:
        rows = json.load(f)
    hit = [r for r in rows if r.get("name") == new_name]
    check("B5 新增记录字段正确", bool(hit) and hit[0].get("phone") == "13900009999", str(hit[:1]))
    new_id = hit[0]["id"] if hit else None
    print("新增记录 id:", new_id)
    errs = [e for e in evs if e.get("event") == "error"]
    check("B6 无错误事件", not errs, str(errs[:1]))
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

print()
print("=" * 64)
print("C. 写入流程 —— 拒绝（crm_update）")
print("=" * 64)
before_c = leads_count()
with open(CRM_LEADS, encoding="utf-8") as f:
    rows_c = json.load(f)
ref_id = rows_c[0]["id"]
ref_remark = rows_c[0].get("remark", "")
sid = make_session("__自动化测试_CRM写拒绝__")
try:
    evs = send(
        sid,
        f'把线索 {ref_id} 的备注(remark) 改成「自动化测试-应被拒绝」。',
        decide=False,
    )
    kinds, tools = summarize(evs)
    print("事件统计:", kinds)
    ar = [e for e in evs if e.get("event") == "approval_request"]
    check("C1 触发了审批请求", len(ar) >= 1, str(kinds))
    if ar:
        check("C2 审批项是 crm_update",
              any(r.get("name") == "crm_update" for r in ar[0].get("requests", [])),
              str(ar[0])[:200])
    after_c = leads_count()
    print("拒绝后 leads 条数:", after_c, "(前:", before_c, ")")
    check("C3 拒绝后数据未变", after_c == before_c, f"{before_c} -> {after_c}")
    with open(CRM_LEADS, encoding="utf-8") as f:
        rows = json.load(f)
    hit = [r for r in rows if r.get("id") == ref_id]
    check("C4 目标记录备注未变", bool(hit) and hit[0].get("remark", "") == ref_remark,
          str(hit[:1])[:160])
finally:
    requests.delete(f"{BASE}/api/sessions/{sid}", params=_IDENT, timeout=15)

print()
print("（删除操作的禁止策略由 test_crm_permissions.py 覆盖）")

print()
print("=" * 64)
print(f"合计: {PASS}/{PASS + FAIL} 通过")
print("=" * 64)
