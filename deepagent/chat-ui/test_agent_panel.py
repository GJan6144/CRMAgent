"""Agent 控制面板 端到端测试。

覆盖：
  PART A —— 无需模型（快）：接口契约、配置持久化、开关/权限即时生效、非法入参、恢复默认
  PART B —— 需要模型（慢）：deny 档拦截、approval 档弹卡审批、关闭档不可调用、指标统计

所有改动在结束时通过 /api/panel/reset 恢复默认，不污染 CRM 数据。
"""
import json
import threading
import time

import requests

BASE = "http://127.0.0.1:8765"

# --- 会话隔离：会话接口要求声明调用方身份（见 server.py 会话隔离设计）---
# 未带身份时：列表返回空、单会话按「不存在」返回 404。测试脚本必须带上。
_IDENT = {"user_phone": '13912345678', "user_name": '系统管理员'}
_Q = "user_phone=13912345678&user_name=%E7%B3%BB%E7%BB%9F%E7%AE%A1%E7%90%86%E5%91%98"

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} :: {extra}")


def api(method, path, **kw):
    return requests.request(method, f"{BASE}{path}", timeout=kw.pop("timeout", 30), **kw)


def make_session(title):
    r = api("POST", "/api/sessions", json={"title": title, **_IDENT})
    r.raise_for_status()
    return r.json()["id"]


def send(session_id, content, decide=None, timeout=600):
    """发一条消息并读完 SSE。decide: None / True / False。"""
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


def ev_names(events, kind):
    return [e.get("name") for e in events if e.get("event") == kind]


def kinds_of(events):
    k = {}
    for e in events:
        k[e.get("event")] = k.get(e.get("event"), 0) + 1
    return k


def set_tool(name, **payload):
    r = api("PUT", f"/api/panel/tools/{name}", json=payload)
    return r


def set_policy(name, policy):
    return api("PUT", f"/api/panel/tools/{name}/policy", json={"policy": policy})


def reset_panel():
    return api("POST", "/api/panel/reset")


# ==========================================================================
# PART A —— 无需模型
# ==========================================================================
print("=" * 66)
print("A. 面板接口契约 / 配置持久化（无需模型）")
print("=" * 66)

reset_panel()

# ---- A0 overview ----
ov = api("GET", "/api/panel/overview").json()
svc = ov.get("service", {})
check("A0.1 overview.service.status=healthy", svc.get("status") == "healthy", str(svc)[:200])
check("A0.2 健康检查含 chat_db/agent_state_db",
      bool(ov.get("health", {}).get("chat_db")) and bool(ov.get("health", {}).get("agent_state_db")),
      str(ov.get("health")))
check("A0.3 overview 含今日/累计用量",
      "today" in ov.get("usage", {}) and "total" in ov.get("usage", {}), str(list(ov.get("usage", {}))))
for key in ("calls", "avg_latency_ms", "tool_calls", "total_tokens"):
    check(f"A0.4 usage.today 含 {key}", key in ov["usage"]["today"], str(ov["usage"]["today"]))
# 当前生效模型由「模型管理」注册表决定（默认 deepseek-flash），不再硬编码单个名字
_active_model = ov.get("model", {})
_active_models = api("GET", "/api/models").json()
_enabled_ids = [m.get("id") for m in _active_models.get("models", [])]
check("A0.5 overview 含模型信息",
      bool(_active_model.get("name")) and bool(_active_model.get("base_url")),
      str(_active_model))
check("A0.5.1 生效模型在已开启模型列表内",
      _active_model.get("name") in _enabled_ids,
      f"active={_active_model.get('name')} enabled={_enabled_ids}")
check("A0.5.2 overview.model 含注册表汇总",
      isinstance(_active_model.get("summary", {}).get("total"), int),
      str(_active_model.get("summary")))

# ---- A1 模型连通性 ----
mc = api("POST", "/api/panel/model-check", timeout=60).json()
check("A1.1 模型连通性探测成功", mc.get("ok") is True, str(mc)[:200])
check("A1.2 返回往返耗时", float(mc.get("latency_ms") or 0) > 0, str(mc)[:200])

# ---- A2 config 契约 ----
cfg = api("GET", "/api/panel/config").json()
check("A2.1 返回系统提示词与默认提示词",
      bool(cfg.get("system_prompt")) and bool(cfg.get("default_system_prompt")), "")
check("A2.2 默认 is_custom=False", cfg.get("is_custom") is False, str(cfg.get("is_custom")))
check("A2.3 三种权限档选项", [p["value"] for p in cfg.get("policy_options", [])] == ["allow", "approval", "deny"],
      str(cfg.get("policy_options")))
check("A2.4 工具目录含分组", len(cfg.get("categories", [])) >= 3, str(cfg.get("categories")))
tools = cfg.get("tools", [])
check("A2.5 工具目录非空", len(tools) >= 20, f"n={len(tools)}")
by_name = {t["name"]: t for t in tools}
check("A2.6 crm_create 默认 approval",
      by_name.get("crm_create", {}).get("policy") == "approval", str(by_name.get("crm_create")))
check("A2.7 crm_delete 默认 deny",
      by_name.get("crm_delete", {}).get("policy") == "deny", str(by_name.get("crm_delete")))
check("A2.8 crm_query 默认 allow 且启用",
      by_name.get("crm_query", {}).get("policy") == "allow" and by_name.get("crm_query", {}).get("enabled") is True,
      str(by_name.get("crm_query")))
check("A2.9 每个工具带中文标签",
      all(t.get("label") for t in tools), "")

# ---- A3 关闭工具 ----
r = set_tool("crm_query", enabled=False)
check("A3.1 关闭 crm_query 返回 ok", r.status_code == 200 and r.json().get("ok") is True, str(r.text)[:200])
check("A3.2 summary.disabled_tools 含 crm_query",
      "crm_query" in r.json()["summary"]["disabled_tools"], str(r.json()["summary"]["disabled_tools"]))
sid = make_session("__面板测试_context__")
try:
    ctx = api("GET", f"/api/context/{sid}", params=_IDENT).json()
    ctx_names = [t["name"] for t in ctx.get("tools", [])]
    check("A3.3 context 工具清单不含已关闭工具", "crm_query" not in ctx_names, str(ctx_names))
    check("A3.4 context 工具带 enabled/policy 字段",
          all("policy" in t and "enabled" in t for t in ctx.get("tools", [])), "")
    check("A3.5 context.system_prompt 非空", len(ctx.get("system_prompt") or "") > 100, "")
finally:
    api("DELETE", f"/api/sessions/{sid}", params=_IDENT)

# ---- A4 权限档变更 ----
# 先恢复启用（A3 已把它关闭），再验证权限档切换
set_tool("crm_query", enabled=True)
r = set_policy("crm_query", "deny")
check("A4.1 改权限档返回 ok", r.status_code == 200, str(r.text)[:200])
check("A4.2 deny_tools 含 crm_query", "crm_query" in r.json()["summary"]["deny_tools"],
      str(r.json()["summary"]["deny_tools"]))
r = set_policy("crm_query", "approval")
check("A4.3 approval_tools 含 crm_query", "crm_query" in r.json()["summary"]["approval_tools"],
      str(r.json()["summary"]["approval_tools"]))
caps = api("GET", "/api/capabilities").json()
check("A4.4 capabilities.approval_tools 同步", "crm_query" in caps.get("approval_tools", []),
      str(caps.get("approval_tools")))
check("A4.5 capabilities.approval_on 仍为 CRM 写操作（向后兼容）",
      set(caps.get("approval_on") or []) == {"crm_create", "crm_update"}, str(caps.get("approval_on")))

# ---- A5 系统提示词 ----
test_prompt = "你是面板测试助手，只回答 OK。"
r = api("PUT", "/api/panel/system-prompt", json={"system_prompt": test_prompt})
check("A5.1 保存系统提示词成功", r.status_code == 200 and r.json().get("is_custom") is True, str(r.text)[:200])
sid = make_session("__面板测试_prompt__")
try:
    ctx = api("GET", f"/api/context/{sid}", params=_IDENT).json()
    check("A5.2 context.system_prompt 反映了自定义", test_prompt in (ctx.get("system_prompt") or ""),
          (ctx.get("system_prompt") or "")[:80])
finally:
    api("DELETE", f"/api/sessions/{sid}", params=_IDENT)
r = api("POST", "/api/panel/system-prompt/reset")
check("A5.3 重置后 is_custom=False", r.json().get("is_custom") is False, str(r.text)[:150])

# ---- A6 非法入参 ----
check("A6.1 未知工具 → 404", set_tool("no_such_tool", enabled=False).status_code == 404, "")
check("A6.2 非法权限档 → 400", set_policy("web_fetch", "maybe").status_code == 400, "")
check("A6.3 空提示词 → 400",
      api("PUT", "/api/panel/system-prompt", json={"system_prompt": "   "}).status_code == 400, "")

# ---- A7 一键恢复默认 ----
r = reset_panel().json()
s = r.get("summary", {})
check("A7.1 恢复默认后无禁用工具", s.get("disabled_tools") == [], str(s.get("disabled_tools")))
check("A7.2 恢复默认后 deny 为 crm_delete/delete/写文件/执行命令",
      set(s.get("deny_tools") or []) == {"crm_delete", "delete", "write_file", "edit_file", "execute"},
      str(s.get("deny_tools")))
check("A7.3 恢复默认后 approval 含 CRM 写入 / 知识库写入 / Word 模板",
      set(s.get("approval_tools") or []) == {
          "crm_create", "crm_update",
          "kb_ingest", "kb_delete_document", "docx_fill_template",
      },
      str(s.get("approval_tools")))

# ==========================================================================
# PART B —— 需要模型
# ==========================================================================
print()
print("=" * 66)
print("B. 权限档 / 开关 / 指标 实际生效（需要模型）")
print("=" * 66)

# 只保留 crm_query 一个 CRM 读工具，迫使模型调用它
set_tool("crm_list_entities", enabled=False)
set_tool("crm_stats", enabled=False)
set_tool("crm_get", enabled=False)

try:
    # ---- B1 deny 档：调用必被拦截 ----
    set_policy("crm_query", "deny")
    sid = make_session("__面板测试_deny__")
    try:
        evs = send(sid, "请调用 crm_query 工具查询 leads 实体的前 3 条记录，直接调用工具。")
        k = kinds_of(evs)
        print("  B1 事件:", k)
        blocked = [e for e in evs if e.get("event") == "tool_blocked"]
        ok_calls = [e for e in evs
                    if e.get("event") == "tool_end" and e.get("name") == "crm_query"
                    and e.get("tool_status") == "success"]
        check("B1.1 推送 tool_blocked", bool(blocked), str([b.get("name") for b in blocked]))
        check("B1.2 无成功的 crm_query 执行", not ok_calls, str(ok_calls[:1])[:200])
        check("B1.3 无错误事件", k.get("error", 0) == 0, str(k))
    finally:
        api("DELETE", f"/api/sessions/{sid}", params=_IDENT)

    # ---- B2 approval 档：弹审批卡并批准后执行 ----
    set_policy("crm_query", "approval")
    sid = make_session("__面板测试_approval__")
    try:
        evs = send(sid, "请调用 crm_query 工具查询 leads 实体的前 3 条记录，直接调用工具。", decide=True)
        k = kinds_of(evs)
        print("  B2 事件:", k)
        ars = [e.get("requests", []) for e in evs if e.get("event") == "approval_request"]
        check("B2.1 弹出审批卡片", len(ars) >= 1, str(k))
        check("B2.2 审批项为 crm_query",
              bool(ars) and any(r.get("name") == "crm_query" for r in ars[0]), str(ars[:1])[:250])
        check("B2.3 批准后执行成功",
              any(e.get("event") == "tool_end" and e.get("name") == "crm_query"
                  and e.get("tool_status") == "success" for e in evs), str(k))
        check("B2.4 无错误事件", k.get("error", 0) == 0, str(k))
    finally:
        api("DELETE", f"/api/sessions/{sid}", params=_IDENT)

    # ---- B3 关闭档：模型不应成功调用 ----
    set_policy("crm_query", "allow")
    set_tool("crm_query", enabled=False)
    sid = make_session("__面板测试_disabled__")
    try:
        before = api("GET", "/api/panel/overview").json()
        evs = send(sid, "请调用 crm_query 工具查询 leads 实体记录，直接调用工具。")
        k = kinds_of(evs)
        print("  B3 事件:", k)
        ok_calls = [e for e in evs
                    if e.get("event") == "tool_end" and e.get("name") == "crm_query"
                    and e.get("tool_status") == "success"]
        check("B3.1 关闭的工具无成功执行", not ok_calls, str(ok_calls[:1])[:200])
        check("B3.2 无错误事件", k.get("error", 0) == 0, str(k))
        # ---- B4 指标增长 ----
        after = api("GET", "/api/panel/overview").json()
        c0, c1 = before["usage"]["total"]["calls"], after["usage"]["total"]["calls"]
        check("B4.1 调用次数增长", c1 > c0, f"{c0} -> {c1}")
        check("B4.2 累计 token > 0", after["usage"]["total"]["total_tokens"] > 0,
              str(after["usage"]["total"]))
        check("B4.3 今日调用次数 >= 1", after["usage"]["today"]["calls"] >= 1,
              str(after["usage"]["today"]))
        check("B4.4 平均响应耗时 > 0", after["usage"]["total"]["avg_latency_ms"] > 0,
              str(after["usage"]["total"]))
        check("B4.5 趋势序列非空", len(after.get("trend") or []) >= 1, str(after.get("trend")))
        check("B4.6 出现过工具调用（tool_calls>0）", after["usage"]["total"]["tool_calls"] > 0,
              str(after["usage"]["total"]))
    finally:
        api("DELETE", f"/api/sessions/{sid}", params=_IDENT)

finally:
    # 无论成败都恢复默认，避免污染后续使用
    reset_panel()
    print("\n(已恢复默认配置)")

print()
print("=" * 66)
print(f"合计: {PASS}/{PASS + FAIL} 通过")
print("=" * 66)
