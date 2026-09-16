"""知识库端到端测试：Agent 是否真的会调用知识库工具，写操作是否被审批拦住。

与 test_kb.py / test_kb_tools.py 的分工：
- 那两个测的是**库与工具本身**（离线可控，临时库）；
- 这个测的是**整条链路**：系统提示词能否让模型主动用工具、审批门禁是否生效。
  所以它必须有 chat-ui 在 8765 上运行，且会真实调用大模型（约 2-3 轮）。

写操作一律**拒绝**审批，因此不会改动真实知识库（断言里会核对文档数不变）。

运行：
    python test_kb_e2e.py
"""
from __future__ import annotations

import atexit
import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8765"
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


def post(path: str, payload: dict):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=600)


def delete_session(sid: str) -> None:
    req = urllib.request.Request(f"{BASE}/api/sessions/{sid}", method="DELETE")
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except (urllib.error.URLError, OSError):
        pass


# 测试会话用完即删，别在 chat.db 里攒垃圾；用 atexit 是为了失败/中断时也能清掉
_SESSIONS: list[str] = []
atexit.register(lambda: [delete_session(s) for s in _SESSIONS])


def new_session(title: str) -> str:
    sid = json.loads(post("/api/sessions", {"title": title}).read())["id"]
    _SESSIONS.append(sid)
    return sid


class Turn:
    """跑一轮对话并收集事件。审批类请求到达后由回调决定放行或拒绝。"""

    def __init__(self, question: str, *, on_approval=None, timeout: int = 300):
        self.question = question
        self.on_approval = on_approval
        self.events: dict[str, int] = {}
        self.content = ""
        self.tools_started: list[str] = []
        self.tool_ends: list[str] = []
        self.tool_results: dict[str, list[str]] = {}
        self.blocked: list[str] = []
        self.approval_names: list[str] = []
        self.sid = new_session("知识库 E2E")
        self._timeout = timeout

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
                            e = json.loads(line[5:].strip())
                        except Exception:
                            continue
                        self._handle(e)
        except (urllib.error.URLError, OSError) as e:
            self.events["__stream_error__"] = 1
            self.content += f"[stream error] {e}"

    def _handle(self, e: dict) -> None:
        ev = e.get("event", "?")
        self.events[ev] = self.events.get(ev, 0) + 1
        if ev == "llm_token":
            self.content += e.get("token", "")
        elif ev == "tool_start":
            self.tools_started.append(e.get("name", "?"))
        elif ev == "tool_end":
            name = e.get("name", "?")
            self.tool_ends.append(name)
            self.tool_results.setdefault(name, []).append(str(e.get("result", "")))
        elif ev == "tool_blocked":
            self.blocked.append(e.get("name", "?"))
        elif ev == "approval_request":
            reqs = e.get("requests") or []
            names = [str(r.get("action") or r.get("tool") or r.get("name") or "")
                     for r in reqs]
            self.approval_names.extend(names)
            approved = bool(self.on_approval(self)) if self.on_approval else False
            try:
                post(f"/api/chat/{self.sid}/approve", {"approved": approved})
            except (urllib.error.URLError, OSError):
                pass


def kb_doc_titles() -> list[str]:
    """直接读库文件，绕开 Agent，确认知识库的真实状态。"""
    from kb_store import get_store
    return [d["title"] for d in get_store().list_documents()]


def main() -> int:
    print(f"服务: {BASE}")
    try:
        with urllib.request.urlopen(BASE + "/api/sessions", timeout=10):
            pass
    except (urllib.error.URLError, OSError) as e:
        print(f"\n服务未就绪：{e}\n请先启动 chat-ui（chat-ui/start.bat）。")
        return 1

    titles_before = kb_doc_titles()
    print(f"知识库当前 {len(titles_before)} 篇文档\n")

    # ---------------- A. 只读检索：模型应主动调工具并引用出处 ----------------
    # 问的是课程 FAQ 库里的内容：断言里的「998 元 / 视频号店铺」是该库独有的
    # 业务细节，检索链路一旦断开模型就答不出来，因此能真实反映召回是否生效。
    print("=== A. 检索问答（只读，无审批）===")
    a = Turn("课程的价格是多少？要去哪里购买？").run()
    check("A1 自主调用了 kb_search", any("kb_search" in n for n in a.tools_started),
          str(dict.fromkeys(a.tools_started)))
    check("A2 未触发审批（只读工具应直接放行）", not a.approval_names,
          str(a.approval_names))
    check("A3 未出现工具被拦截", not a.blocked, str(a.blocked))
    check("A4 给出了回答", len(a.content.strip()) > 40, f"{len(a.content.strip())} 字")
    check("A5 回答引用了知识库文档标题",
          "《" in a.content and ("课程FAQ" in a.content or "购买与售后" in a.content),
          a.content.strip().splitlines()[0][:60] if a.content.strip() else "（空）")
    check("A6 回答带上了文档里的具体细节（998 元 / 视频号店铺）",
          any(k in a.content for k in ("998", "视频号")), "")
    print(f"  · 工具链：{list(dict.fromkeys(a.tools_started))}")
    print(f"  · 回答摘要：{a.content.strip().splitlines()[0][:80] if a.content.strip() else '（空）'}")

    # ---------------- B. 写操作：必须停在审批上，拒绝后不得落库 ----------------
    print("\n=== B. 写操作审批门禁（拒绝）===")
    target = "/chat-ui/skills/lead-analyzer/SKILL.md"
    b = Turn(f"把 {target} 这个文件加进知识库", on_approval=lambda _t: False).run()
    check("B1 触发了 approval_request", "approval_request" in b.events, str(b.events))
    check("B2 拦截到的工具是 kb_ingest",
          any("kb_ingest" in n for n in b.approval_names), str(b.approval_names))
    # 被拒绝的调用同样会走 tool_end —— 框架用一条「已拒绝」的 ToolMessage 收尾，
    # 否则对话历史里会留下没有结果的工具调用。所以判据是**结果内容**而非事件有无。
    ingest_results = " ".join(b.tool_results.get("kb_ingest", []))
    check("B3 拒绝后 kb_ingest 未真正执行（结果为拒绝说明）",
          "拒绝" in ingest_results and "入库完成" not in ingest_results,
          ingest_results.replace("\n", " ")[:70])
    titles_after_reject = kb_doc_titles()
    check("B4 拒绝后知识库文档数不变",
          len(titles_after_reject) == len(titles_before),
          f"{len(titles_before)} -> {len(titles_after_reject)}")
    check("B5 未留下 lead-analyzer 文档",
          not any("lead-analyzer" in t or "lead_analyzer" in t for t in titles_after_reject),
          str([t for t in titles_after_reject if "lead" in t.lower()]))

    # ---------------- C. 只读的库信息查询也不该触发审批 ----------------
    print("\n=== C. 只读的库信息查询 ===")
    c = Turn("知识库里现在都有哪些文档？列一下。").run()
    check("C1 调用了 kb_list_documents 或 kb_search",
          any("kb_list_documents" in n or "kb_search" in n for n in c.tools_started),
          str(dict.fromkeys(c.tools_started)))
    check("C2 未触发审批", not c.approval_names, str(c.approval_names))
    check("C3 列出了库里的文档", len(c.content.strip()) > 40, f"{len(c.content.strip())} 字")

    print("\n最终知识库：")
    for t in kb_doc_titles():
        print(f"  · 《{t}》")

    print(f"\n===== 结果: {PASS} 通过 / {FAIL} 失败 =====")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
