"""Skill 开关 / 编辑的**运行时**验证。

前两个测试文件覆盖的是「数据层」和「HTTP 接口」，都还没证明**Agent 真的变了**。
这个文件补上最后一段，也是唯一能证伪的那段：

  1. 真跑一轮对话 —— 回归：用自定义 `SkillsControlMiddleware` 替掉框架原生
     `SkillsMiddleware`（`skills=None` + 中间件注入）之后，对话仍然能跑通；
  2. 从 **checkpoint（agent_state.db 的 writes 表）** 里把这一轮真实写进 state 的
     `skills_metadata` 解出来 —— 这是「Agent 到底看到了哪些技能」的唯一可信来源
     （`/api/context` 返回的是基础提示词，不含中间件渲染的技能清单，看不到真相）；
  3. 关闭一个技能后再跑一轮，断言它从 `skills_metadata` 和渲染出的技能清单里消失；
  4. 钉住中间件的**同步 / 异步双入口** —— 框架的 `SkillsMiddleware` 把「加载技能」
     在 `before_agent`（同步）和 `abefore_agent`（异步）里**各写了一份**，
     而 `/api/chat` 是异步的。只覆写同步版时，第 3 步会失败但**没有任何报错**：
     技能照旧全量注入，从接口和提示词都看不出来，只有解 checkpoint 才能发现。
  5. 纯单元验证 `FsApprovalMiddleware` 对「已关闭技能的 SKILL.md」的读取拦截。

⚠️ 需要 chat-ui 在 8765 运行；会真实调用模型 **2 次**。
⚠️ 临时技能用 `e2e-runtime-skill`，结束时删除目录并清掉开关记录。

运行：
    python test_skill_runtime.py
"""
from __future__ import annotations

import atexit
import json
import shutil
import sqlite3
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer  # noqa: E402

import server as S  # noqa: E402

# checkpoint 里的值是用框架自己的序列化器存的（msgpack + ext 类型），
# 别自己 `msgpack.unpackb` —— SkillMetadata 是 TypedDict，走的是 ext 编码，
# 裸 msgpack 解不出来。用同一个序列化器解才安全。
_SERDE = JsonPlusSerializer()

BASE = "http://127.0.0.1:8765"

# --- 会话隔离：会话接口要求声明调用方身份（见 server.py 会话隔离设计）---
# 未带身份时：列表返回空、单会话按「不存在」返回 404。测试脚本必须带上。
_IDENT = {"user_phone": '13912345678', "user_name": '系统管理员'}
_Q = "user_phone=13912345678&user_name=%E7%B3%BB%E7%BB%9F%E7%AE%A1%E7%90%86%E5%91%98"

AGENT_STATE_DB = HERE / "agent_state.db"
AGENT_CONFIG = HERE / "agent_config.json"

SKILLS_DIR = HERE / "skills"
PROBE = "e2e-runtime-skill"
PROBE_DIR = SKILLS_DIR / PROBE
PROBE_MD = (
    "---\n"
    f"name: {PROBE}\n"
    "description: 运行时验证用临时技能（脚本跑完即删）。\n"
    "---\n"
    "\n"
    "# Runtime Probe Skill\n"
    "\n"
    "只用于验证「关闭技能后 Agent 是否真的看不到它」。\n"
)

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


# ==========================================================================
# HTTP
# ==========================================================================

def post(path: str, payload: dict, *, timeout: int = 300):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def put(path: str, payload: dict) -> tuple[int, object]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def get(path: str):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


_SESSIONS: list[str] = []


def _drop_sessions() -> None:
    for sid in _SESSIONS:
        try:
            req = urllib.request.Request(f"{BASE}/api/sessions/{sid}?{_Q}", method="DELETE")
            urllib.request.urlopen(req, timeout=15).read()
        except Exception:  # noqa: BLE001
            pass


atexit.register(_drop_sessions)


class Turn:
    """跑一轮对话，收集事件。"""

    def __init__(self, question: str, *, timeout: int = 300):
        self.question = question
        self.events: dict[str, int] = {}
        self.content = ""
        self.tool_calls: list[str] = []
        self.read_paths: list[str] = []
        self._timeout = timeout
        self.sid = json.loads(post("/api/sessions", {"title": "skill 运行时验证", **_IDENT}).read())["id"]
        _SESSIONS.append(self.sid)

    def run(self) -> "Turn":
        th = threading.Thread(target=self._read, daemon=True)
        th.start()
        th.join(timeout=self._timeout)
        return self

    def _read(self) -> None:
        try:
            resp = post("/api/chat", {
                "session_id": self.sid, "content": self.question, "use_search": False,
            })
            buf = ""
            for raw in resp:
                buf += raw.decode("utf-8", "replace")
                while "\n\n" in buf:
                    block, buf = buf.split("\n\n", 1)
                    for line in block.split("\n"):
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            self._handle(json.loads(line[5:].strip()))
                        except (json.JSONDecodeError, AttributeError, TypeError):
                            continue
        except Exception as e:  # noqa: BLE001
            self.events["__stream_error__"] = self.events.get("__stream_error__", 0) + 1
            self.content += f"[stream error] {e}"

    def _handle(self, e: dict) -> None:
        ev = e.get("event", "?")
        self.events[ev] = self.events.get(ev, 0) + 1
        if ev == "llm_token":
            self.content += e.get("token", "")
        elif ev == "tool_start":
            self.tool_calls.append(str(e.get("name", "?")))
            args = str(e.get("args", ""))
            if "SKILL.md" in args:
                # 只记路径片段，断言时只关心有没有碰目标技能的 SKILL.md
                for token in args.replace("\\", "/").split('"'):
                    if token.endswith("SKILL.md"):
                        self.read_paths.append(token)
        elif ev == "approval_request":
            try:
                post(f"/api/chat/{self.sid}/approve", {"approved": False})
            except Exception:  # noqa: BLE001
                pass


# ==========================================================================
# 从 checkpoint 读真实 state
# ==========================================================================

def state_skills(sid: str) -> list[str] | None:
    """从 agent_state.db 解出该会话最后一次写入的 skills_metadata 技能名。

    这是唯一能看到「Agent 实际拿到了什么」的地方 —— `/api/context` 给的是基础
    系统提示词，技能清单是中间件在 `modify_request` 里临时拼上去的，看不到。
    """
    if not AGENT_STATE_DB.is_file():
        return None
    con = sqlite3.connect(f"file:{AGENT_STATE_DB}?mode=ro", uri=True)
    try:
        row = con.execute(
            "select value, type from writes where thread_id = ? and channel = 'skills_metadata' "
            "order by rowid desc limit 1",
            (f"thread_{sid}",),
        ).fetchone()
    finally:
        con.close()
    if not row:
        return None
    raw, kind = row
    data = _SERDE.loads_typed((kind, raw))
    return [s["name"] for s in data]


def rendered_skills(exclude: set[str]) -> list[str]:
    """用中间件的渲染逻辑算一遍「会给模型看的技能清单」。"""
    mw = S.SkillsControlMiddleware(
        backend=S.backend, sources=list(S.SKILL_SOURCES), disabled=set(exclude)
    )
    meta = mw.before_agent({}, None, None)["skills_metadata"]
    text = mw._format_skills_list(meta)
    return [line.split("**")[1] for line in text.splitlines() if line.startswith("- **")]


# ==========================================================================
# A. 真实对话（回归）
# ==========================================================================

def sec_chat() -> str:
    print("\n=== A. 真跑一轮对话（回归：自定义技能中间件没破坏对话） ===")
    t = Turn("请用一句话回答：1+1 等于几？").run()
    check("A1 流正常结束（收到 done）", t.events.get("done", 0) >= 1, str(t.events))
    check("A2 没有流错误", "__stream_error__" not in t.events)
    check("A3 模型有输出内容", len(t.content.strip()) > 0, t.content[:60].replace("\n", " "))
    check("A4 没有 error 事件", t.events.get("error", 0) == 0)
    return t.sid


# ==========================================================================
# B. Agent state 里到底有哪些技能
# ==========================================================================

def sec_state(sid: str) -> None:
    print("\n=== B. checkpoint 里 skills_metadata 的真实内容 ===")
    names = state_skills(sid)
    check("B1 能从 checkpoint 解出 skills_metadata", names is not None, str(names))
    if names is None:
        return
    check("B2 技能已写入 agent state（非空）", len(names) > 0, str(names))
    check("B3 临时技能在内（默认开启）", PROBE in names, str(names))
    check("B4 与扫盘结果一致",
          set(names) == {s["name"] for s in S.skill_catalog(
              S._admin_skill_sources(), {})["skills"]},
          str(sorted(names)))
    # 每个条目都要是框架认得的 SkillMetadata 结构，否则 modify_request 会炸
    check("B5 中间件渲染出的清单包含全部技能",
          set(rendered_skills(set())) == set(names), str(sorted(rendered_skills(set()))))


# ==========================================================================
# C. 关闭后 Agent 是否真的看不到
# ==========================================================================

def sec_disabled(sid_open: str) -> None:
    print("\n=== C. 关闭技能后 Agent 是否真的看不到 ===")
    code, body = put(f"/api/panel/skills/{PROBE}", {"enabled": False})
    check("C1 关闭接口返回 200", code == 200, str(code))

    # 静态面：提示词渲染
    rendered = rendered_skills({PROBE})
    check("C2 渲染出的技能清单里已无该技能", PROBE not in rendered, str(sorted(rendered)))
    prompt = S._effective_system_prompt(S.agent_effective())
    check("C3 系统提示词出现「已关闭技能」段", "## Disabled Skills" in prompt)
    check("C4 该段点名了这个技能",
          PROBE in prompt.split("## Disabled Skills")[1][:400], "")
    # ⚠️ 不能查本进程的 `S.fs_approval_middleware` —— 那是**测试进程**里的单例，
    # 开关是经 HTTP 打到服务进程的，本进程这边永远不会被 refresh，查它必然为空。
    # 该查服务端当前的真实状态：
    caps = get("/api/capabilities")
    check("C5 拦截已就位（服务端已加载关闭集合）",
          PROBE in (caps.get("disabled_skills") or []),
          str(caps.get("disabled_skills")))
    check("C5b 配置层 disabled_skills 也正确",
          PROBE in (S.agent_effective().get("disabled_skills") or []),
          str(S.agent_effective().get("disabled_skills")))

    # 运行时面：再跑一轮，看真实 state
    t = Turn("你好，请用一句话打个招呼。").run()
    check("C6 关闭后再跑一轮仍然正常", t.events.get("done", 0) >= 1, str(t.events))
    names = state_skills(t.sid)
    check("C7 新一轮的 skills_metadata 里已无该技能",
          names is not None and PROBE not in names, str(names))
    check("C8 其余技能不受影响",
          names is not None and "product-faq" in names, str(names))

    # 复原
    put(f"/api/panel/skills/{PROBE}", {"enabled": True})
    check("C9 复原为开启", PROBE in rendered_skills(set()))


# ==========================================================================
# D. 技能中间件的同步 / 异步双入口
# ==========================================================================

def sec_entrypoints() -> None:
    """框架把技能加载在同步 / 异步里**各写了一份**，两个入口都得过滤。

    这是真实踩过的坑：只覆写同步 `before_agent` 时，`/api/chat`（异步）走的是
    `abefore_agent`，过滤完全不生效 —— 而且不报错、不告警，技能照旧全量注入，
    只有从 checkpoint 里解 state 才能发现。所以这条断言必须单独钉住。
    """
    print("\n=== D. 技能中间件的同步 / 异步双入口 ===")
    import asyncio

    mw = S.SkillsControlMiddleware(
        backend=S.backend, sources=list(S.SKILL_SOURCES), disabled={PROBE}
    )

    sync_names = [s["name"] for s in mw.before_agent({}, None, None)["skills_metadata"]]
    check("D1 同步 before_agent 过滤生效", PROBE not in sync_names, str(sorted(sync_names)))

    async_names = [
        s["name"] for s in asyncio.run(mw.abefore_agent({}, None, None))["skills_metadata"]
    ]
    check("D2 异步 abefore_agent 过滤生效（chat-ui 走的就是这条）",
          PROBE not in async_names, str(sorted(async_names)))
    check("D3 两个入口结果一致", sorted(sync_names) == sorted(async_names),
          f"sync={sorted(sync_names)} async={sorted(async_names)}")
    check("D4 其余技能不受影响",
          {"product-faq", "skill-creator"} <= set(async_names), str(sorted(async_names)))

    # 会话缓存绕过：state 里已经有旧清单时，两个入口都要重新扫盘
    stale = {"skills_metadata": [{
        "name": PROBE, "description": "stale", "path": "/x", "metadata": {},
        "license": None, "compatibility": None, "allowed_tools": [],
    }]}
    re_sync = mw.before_agent(dict(stale), None, None)
    check("D5 同步入口绕过「每会话只加载一次」缓存",
          re_sync is not None and PROBE not in [s["name"] for s in re_sync["skills_metadata"]])
    re_async = asyncio.run(mw.abefore_agent(dict(stale), None, None))
    check("D6 异步入口绕过「每会话只加载一次」缓存",
          re_async is not None and PROBE not in [s["name"] for s in re_async["skills_metadata"]])

    # 没有关闭项时不该动任何东西
    plain = S.SkillsControlMiddleware(backend=S.backend, sources=list(S.SKILL_SOURCES))
    plain_names = [
        s["name"] for s in asyncio.run(plain.abefore_agent({}, None, None))["skills_metadata"]
    ]
    check("D7 无关闭项时同步入口不过滤",
          PROBE in [s["name"] for s in plain.before_agent({}, None, None)["skills_metadata"]])
    check("D8 无关闭项时异步入口不过滤", PROBE in plain_names, str(sorted(plain_names)))

    # refresh 后两个入口都跟着变（面板改开关走的是这条）
    mw.refresh(set())
    check("D9 refresh 后异步入口恢复全量",
          PROBE in [s["name"] for s in asyncio.run(
              mw.abefore_agent({}, None, None))["skills_metadata"]])
    mw.refresh({PROBE})
    check("D10 refresh 后异步入口重新过滤",
          PROBE not in [s["name"] for s in asyncio.run(
              mw.abefore_agent({}, None, None))["skills_metadata"]])


# ==========================================================================
# E. 读取拦截（单元，不联网）
# ==========================================================================

def sec_block() -> None:
    print("\n=== E. FsApprovalMiddleware 对已关闭技能文件的读取拦截 ===")
    from langchain_core.messages import AIMessage, ToolMessage

    mw = S.FsApprovalMiddleware()
    mw.refresh({"settings": {}, "disabled_skills": {PROBE}, "approval_tools": set(),
                "deny_tools": set(), "disabled_tools": set()})

    def after(read_path: str, tool: str = "read_file"):
        ai = AIMessage(content="", tool_calls=[{
            "name": tool, "args": {"file_path": read_path}, "id": "call_1",
        }])
        out = mw.after_model({"messages": [ai]}, None)
        if not out:
            return None
        for m in out["messages"]:
            if isinstance(m, ToolMessage) and m.status == "error":
                return m
        return None

    blocked = after(f"/chat-ui/skills/{PROBE}/SKILL.md")
    check("E1 读已关闭技能的 SKILL.md 被拦截", blocked is not None)
    if blocked:
        check("E2 拦截标记 policy=skill_disabled",
              blocked.additional_kwargs.get("policy") == "skill_disabled",
              str(blocked.additional_kwargs)[:80])
        check("E3 拦截提示里点名了技能",
              PROBE in str(blocked.content), str(blocked.content)[:80])
        check("E4 标记了 blocked=True（前端渲染红色禁止卡）",
              blocked.additional_kwargs.get("blocked") is True)

    check("E5 grep 同样被拦截",
          after(f"/chat-ui/skills/{PROBE}/SKILL.md", tool="grep") is not None)
    check("E6 附属文件也拦（不只 SKILL.md）",
          after(f"/chat-ui/skills/{PROBE}/scripts/x.py") is not None)

    # 不该误伤的情况
    check("E7 读未关闭技能的 SKILL.md 不拦",
          after("/chat-ui/skills/product-faq/SKILL.md") is None)
    check("E8 读普通文件不拦", after("/chat-ui/server.py") is None)
    check("E9 路径里只是「碰巧同名」的普通目录不拦",
          after("/some/other/skills/e2e-runtime-skill-not-really/x.md") is None)

    clean = S.FsApprovalMiddleware()  # 默认无已关闭技能
    clean_ai = AIMessage(content="", tool_calls=[{
        "name": "read_file",
        "args": {"file_path": f"/chat-ui/skills/{PROBE}/SKILL.md"},
        "id": "c",
    }])
    check("E10 未开启拦截时（disabled_skills 为空）一律放行",
          clean.after_model({"messages": [clean_ai]}, None) is None)


# ==========================================================================
# E. 收尾
# ==========================================================================

def sec_cleanup() -> None:
    print("\n=== F. 收尾 ===")
    try:
        put(f"/api/panel/skills/{PROBE}", {"enabled": True})
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(PROBE_DIR, ignore_errors=True)
    shutil.rmtree(HERE / "_skill_backups" / PROBE, ignore_errors=True)
    check("F1 临时技能目录已删除", not PROBE_DIR.exists())
    d = get("/api/panel/skills")
    check("F2 清单里已无该技能", all(s["name"] != PROBE for s in d["skills"]))
    check("F3 无已关闭技能残留", d["summary"]["disabled"] == 0, str(d["summary"]["disabled"]))
    check("F4 无孤儿开关记录", d["summary"]["orphan_disabled"] == [],
          str(d["summary"]["orphan_disabled"]))


def main() -> int:
    try:
        get("/api/panel/skills")
    except Exception as e:  # noqa: BLE001
        print(f"无法连接 chat-ui（{BASE}）：{e}")
        print("请先在 chat-ui 目录运行：python server.py")
        return 2

    # 幂等前置：清残留 + 建临时技能
    shutil.rmtree(PROBE_DIR, ignore_errors=True)
    PROBE_DIR.mkdir(parents=True, exist_ok=True)
    (PROBE_DIR / "SKILL.md").write_text(PROBE_MD, encoding="utf-8", newline="")
    put(f"/api/panel/skills/{PROBE}", {"enabled": True})
    print(f"已创建临时技能 {PROBE}（{PROBE_DIR}）")

    try:
        sid = sec_chat()
        sec_state(sid)
        sec_disabled(sid)
        sec_entrypoints()
        sec_block()
    finally:
        sec_cleanup()

    print("\n" + "=" * 60)
    print(f"Skill 运行时验证: {PASS}/{PASS + FAIL} 通过")
    if FAIL:
        print(f"失败 {FAIL} 项")
    print("=" * 60)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
