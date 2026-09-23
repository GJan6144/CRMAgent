"""Agent 数据范围 —— 走真实服务 + 真实 Agent 的端到端验证。

流程：
  1. 备份 roles.json / leads.json
  2. 把「销售」角色 chat 页的 dataScope 临时改成「仅自己」（只改 roles.json）
  3. 以销售身份（张明）发一条 chat，让 Agent 查线索总数 → 应只看到自己的
  4. 再以管理员身份发一条 → 应看到全部
  5. 还原 roles.json（**只还原 roles.json**，leads.json 若被误改也一并还原）
"""
from __future__ import annotations

import json
import shutil
import sys
import threading
import time
from pathlib import Path

import requests

CHAT_UI = Path(__file__).resolve().parent
sys.path.insert(0, str(CHAT_UI))
from crm_data_guard import install_guard  # noqa: E402

install_guard()  # 进程退出时按字节还原 CRM 数据

BASE = "http://127.0.0.1:8765"
CRM_DATA = Path(
    r"C:\Users\Administrator\Documents\deepagent\CRM_Agent1.0\data"
)
ROLES = CRM_DATA / "roles.json"

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} :: {extra}")


def set_sales_scope(scope: str):
    """把「销售」角色 chat 页的 dataScope 改成 scope（保 CRLF / indent=2 / 无 BOM）。"""
    raw = ROLES.read_bytes()
    crlf = raw.count(b"\r\n")
    data = json.loads(raw.decode("utf-8"))
    for r in data:
        if r.get("name") == "销售":
            for p in r.get("permissions", []):
                if p.get("pageKey") == "chat":
                    p["dataScope"] = scope
    text = json.dumps(data, ensure_ascii=False, indent=2)
    out = text.replace("\n", "\r\n").encode("utf-8")
    ROLES.write_bytes(out)
    print(f"  → 已把「销售」角色 chat 页 dataScope 改为 {scope}"
          f"（CRLF {crlf}→{out.count(b'\r\n')}）")


def send_chat(content: str, ident: dict, decide=None, timeout=300) -> str:
    """发一条消息，收集全部 assistant 文本；decide 非 None 时自动应答审批卡。

    ⚠️ 事件格式（与 test_crm_permissions.py 一致）：
      - 名字在 ``event`` 键（不是 ``type``）
      - 正文 token 走 ``llm_token`` 事件，取 ``token`` 字段
      - write 类工具会 interrupt 阻塞等人工审批，必须有人回 /approve，否则挂死
    """
    s = requests.post(f"{BASE}/api/sessions", json={"title": "范围验证"}, timeout=30)
    sid = s.json()["id"]
    text = ""
    try:
        with requests.post(
            f"{BASE}/api/chat",
            json={"session_id": sid, "content": content, "model": "deepseek-flash", **ident},
            stream=True,
            timeout=timeout,
        ) as r:
            if r.status_code != 200:
                return f"HTTP {r.status_code}: {r.text[:200]}"
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

                if ev.get("event") == "llm_token":
                    text += ev.get("token", "") or ""
                elif ev.get("event") == "approval_request" and decide is not None:
                    names = [a.get("name") for a in ev.get("requests", [])]

                    def _approve():
                        time.sleep(0.8)
                        try:
                            requests.post(
                                f"{BASE}/api/chat/{sid}/approve",
                                json={"approved": decide, "session_id": sid},
                                timeout=15,
                            )
                            print(f"    -> 审批应答 approved={decide} 工具={names}")
                        except Exception as e:  # noqa: BLE001
                            print("    -> 审批应答失败", e)

                    threading.Thread(target=_approve, daemon=True).start()
                elif ev.get("event") in ("done", "error"):
                    break
        return text
    finally:
        try:
            requests.delete(f"{BASE}/api/sessions/{sid}", timeout=10)
        except Exception:
            pass


print("=" * 70)
print("准备：把「销售」角色 chat 页改为「仅自己」")
print("=" * 70)
set_sales_scope("仅自己")

# 服务端每次都重新读 roles.json，无需重启
info = requests.get(f"{BASE}/api/agent-scope", params={"phone": "13800001001"}, timeout=15).json()
print(f"  销售（张明）解析: scope={info['scope']} restricted={info['restricted']}")
check("销售角色已收紧为「仅自己」", info["restricted"] is True, info)

print()
print("=" * 70)
print("A. 销售身份问「有多少条销售线索」→ 应只算自己的 6 条")
print("=" * 70)
sales_ident = {"user_phone": "13800001001", "user_name": "张明",
               "role_id": "ROLE-2026-0002", "role_name": "销售"}
ans_sales = send_chat(
    "请调用 crm_stats 统计 leads 的总条数，只告诉我一个数字，不要解释。",
    sales_ident,
)
print(f"  Agent 回答：{ans_sales[:200]!r}")
check("销售看到的线索数是 6（而非 35）", "6" in ans_sales and "35" not in ans_sales,
      ans_sales[:200])

print()
print("=" * 70)
print("B. 管理员身份问同样问题 → 应看到全部 35 条")
print("=" * 70)
admin_ident = {"user_phone": "13912345678", "user_name": "系统管理员",
               "role_id": "ROLE-2026-0001", "role_name": "管理员"}
ans_admin = send_chat(
    "请调用 crm_stats 统计 leads 的总条数，只告诉我一个数字，不要解释。",
    admin_ident,
)
print(f"  Agent 回答：{ans_admin[:200]!r}")
check("管理员看到的线索数是 35", "35" in ans_admin, ans_admin[:200])

print()
print("=" * 70)
print("C. 销售身份尝试改他人线索 → 应被拒绝")
print("=" * 70)
ans_deny = send_chat(
    "请调用 crm_update 把线索 LD-2026-0002 的 remark 改成 'hack'，"
    "如果失败请原样告诉我错误原因。",
    sales_ident,
    decide=True,  # 审批通过放行到工具层，真正被拒的原因应是「数据范围」
)
print(f"  Agent 回答：{ans_deny[:400]!r}")
check("越权改他人线索被拒（含「无权」或「归属」）",
      "无权" in ans_deny or "归属" in ans_deny, ans_deny[:300])

print()
print("=" * 70)
print("D. 还原销售角色为「全部」")
print("=" * 70)
set_sales_scope("全部")
info2 = requests.get(f"{BASE}/api/agent-scope", params={"phone": "13800001001"}, timeout=15).json()
check("销售角色已还原为「全部」", info2["scope"] == "全部", info2)

print()
print("=" * 70)
print(f"结果：PASS={PASS}  FAIL={FAIL}")
print("（roles.json 由 crm_data_guard 在退出时按字节还原）")
print("=" * 70)
sys.exit(1 if FAIL else 0)
