"""产品FAQ问题解答（product-faq 技能）端到端测试。

验证三件事：

1. 技能被框架加载、出现在技能索引里，且 SKILL.md 合规范（name == 目录名）；
2. 用户问课程 / 产品问题时，Agent 会**检索本地知识库**（`kb_search`）、
   照库里的原文作答并标注出处，且不会跑去用 `crm_*` 查课程信息；
3. 库外问题不编造。

需要 chat-ui 在 8765 运行，会真实调用大模型（约 2-3 轮）与知识库检索。
测试会话用完即删（`atexit` 兜底）。

运行：
    python test_skill_product_faq.py
"""
from __future__ import annotations

import atexit
import json
import re
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8765"

# --- 会话隔离：会话接口要求声明调用方身份（见 server.py 会话隔离设计）---
# 未带身份时：列表返回空、单会话按「不存在」返回 404。测试脚本必须带上。
_IDENT = {"user_phone": '13912345678', "user_name": '系统管理员'}
_Q = "user_phone=13912345678&user_name=%E7%B3%BB%E7%BB%9F%E7%AE%A1%E7%90%86%E5%91%98"

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

SKILL_DIR = HERE / "skills" / "product-faq"
SKILL_MD = SKILL_DIR / "SKILL.md"

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())


def post(path: str, payload: dict, timeout: int = 600):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def delete_session(sid: str) -> None:
    req = urllib.request.Request(f"{BASE}/api/sessions/{sid}?{_Q}", method="DELETE")
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except (urllib.error.URLError, OSError):
        pass


_SESSIONS: list[str] = []
atexit.register(lambda: [delete_session(s) for s in _SESSIONS])


def new_session(title: str) -> str:
    sid = json.loads(post("/api/sessions", {"title": title, **_IDENT}).read())["id"]
    _SESSIONS.append(sid)
    return sid


class Turn:
    """跑一轮对话并收集事件。"""

    def __init__(self, question: str, *, timeout: int = 300):
        self.question = question
        self.events: dict[str, int] = {}
        self.content = ""
        self.tools_started: list[str] = []
        self.tool_args: dict[str, list[str]] = {}
        self.tool_results: dict[str, list[str]] = {}
        self.blocked: list[str] = []
        self.approval_names: list[str] = []
        self.sid = new_session("FAQ 技能 E2E")
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
            name = e.get("name", "?")
            self.tools_started.append(name)
            self.tool_args.setdefault(name, []).append(str(e.get("args", "")))
        elif ev == "tool_end":
            name = e.get("name", "?")
            self.tool_results.setdefault(name, []).append(str(e.get("result", "")))
        elif ev == "tool_blocked":
            self.blocked.append(e.get("name", "?"))
        elif ev == "approval_request":
            for r in (e.get("requests") or []):
                self.approval_names.append(
                    str(r.get("action") or r.get("tool") or r.get("name") or "")
                )
            try:
                post(f"/api/chat/{self.sid}/approve", {"approved": False})
            except (urllib.error.URLError, OSError):
                pass


def affirmative_claim(text: str, keywords: tuple[str, ...]) -> str | None:
    """找出「把 keywords 说成既定事实」的那句话；没有则返回 None。

    不能简单地 `any(k in text for k in keywords)`：一个**正确**的回答同样会复述
    这些词（「知识库里没有关于分期付款的说明」「是否支持分期，建议联系客服」），
    朴素的字符串匹配会把正确答案判成失败。所以这里下沉到**句子**粒度，
    只要该句带有否定 / 疑问 / 转交客服的标记，就认为它没有编造。
    """
    hedges = ("没有", "不", "未", "无法", "是否", "？", "?", "建议", "确认", "如需", "若", "暂无")
    for sent in re.split(r"[。！？\n]", text):
        if not sent.strip():
            continue
        if not any(k in sent for k in keywords):
            continue
        if any(h in sent for h in hedges):
            continue
        return sent.strip()
    return None


def parse_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not m:
        return {}
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def main() -> int:
    print(f"服务: {BASE}")
    try:
        with urllib.request.urlopen(BASE + "/api/sessions?" + _Q, timeout=10):
            pass
    except (urllib.error.URLError, OSError) as e:
        print(f"\n服务未就绪：{e}\n请先启动 chat-ui（chat-ui/start.bat）。")
        return 1

    # ---------------- S. 技能本身（离线可查） ----------------
    print("=== S. 技能注册与规范 ===")
    fm = parse_frontmatter(SKILL_MD)
    check("SKILL.md 存在且 frontmatter 可解析", bool(fm), str(SKILL_MD.name))
    check("name 与目录名一致且为 ASCII 小写连字符",
          fm.get("name") == SKILL_DIR.name == "product-faq", fm.get("name", ""))
    desc = fm.get("description", "")
    check("description 非空且未超 1024 字符", bool(desc) and len(desc) <= 1024,
          f"{len(desc)} 字符")
    check("description 写明了触发场景", "使用本技能" in desc, "")

    sid_probe = new_session("技能索引探测")
    ctx = get(f"/api/context/{sid_probe}")
    entry = next((s for s in ctx.get("skills", []) if s["name"] == "product-faq"), None)
    check("技能出现在技能索引中", entry is not None,
          str([s["name"] for s in ctx.get("skills", [])]))
    if entry:
        check("技能来源为 Chat UI（chat-ui/skills）", entry["source"] == "Chat UI",
              entry["source"])
        check("面板简介取自 description 且含中文名",
              "产品FAQ" in entry["summary"], entry["summary"][:40])
    caps = get("/api/capabilities")
    srcs = [s["path"] for s in caps.get("skill_sources", [])]
    check("技能目录在 Agent 文件系统根内（模型可读取）",
          "/chat-ui/skills" in srcs, str(srcs))

    # ---------------- A. 库内问题：应检索并据实作答 ----------------
    print("\n=== A. 课程价格咨询（库内问题）===")
    a = Turn("这门课多少钱？在哪儿买？").run()
    check("A1 调用了知识库检索 kb_search",
          "kb_search" in a.tools_started, str(list(dict.fromkeys(a.tools_started))))
    check("A2 没有跑去用 crm_* 查课程信息",
          not any(n.startswith("crm_") for n in a.tools_started),
          str([n for n in a.tools_started if n.startswith("crm_")]))
    check("A3 未触发审批、未被拦截",
          not a.approval_names and not a.blocked,
          f"approval={a.approval_names} blocked={a.blocked}")
    check("A4 答出库里的事实（998 元 / 视频号店铺）",
          "998" in a.content and "视频号" in a.content,
          a.content.strip().splitlines()[0][:60] if a.content.strip() else "（空）")
    check("A5 标注了出处文档", "《" in a.content and "课程FAQ" in a.content, "")
    # 渐进式披露：系统提示词只给 name+description，模型真要用技能就得 read_file 读全文。
    # 这一步发生才说明走的是 Skill 机制，而不是仅靠系统提示词里的知识库段落。
    read_skill = [v for v in a.tool_args.get("read_file", []) if "product-faq" in v]
    check("A6 读取了技能全文（read_file → product-faq/SKILL.md）",
          bool(read_skill), read_skill[0][:70] if read_skill else "未读取")
    print(f"  · 工具链：{list(dict.fromkeys(a.tools_started))}")
    print(f"  · 回答：{a.content.strip()[:150]}")

    # ---------------- B. 库外问题：不得编造 ----------------
    print("\n=== B. 库外问题（分期付款，库里没有）===")
    b = Turn("你们支持分期付款吗？能分 12 期免息吗？").run()
    check("B1 仍然走了知识库检索",
          "kb_search" in b.tools_started, str(list(dict.fromkeys(b.tools_started))))
    claim = affirmative_claim(b.content, ("分期", "免息"))
    check("B2 没有把分期 / 免息说成既定事实", claim is None, claim or "")
    check("B3 明确表示库里没有 / 建议向客服核实",
          any(k in b.content for k in ("没有", "未收录", "不包含", "不涉及", "不确定", "联系")),
          b.content.strip()[:80])
    print(f"  · 回答全文：\n{b.content.strip()}")
    print(f"  · 回答：{b.content.strip()[:150]}")

    print(f"\n===== 结果: {PASS} 通过 / {FAIL} 失败 =====")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
