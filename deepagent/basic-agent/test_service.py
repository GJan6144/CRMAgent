"""
基础 Agent 服务 —— 简单测试脚本
===============================

覆盖以下检查项：

  1. 配置加载（.env / 环境变量）
  2. 模型直连（deepseek-v4-flash 原生调用）
  3. Agent 构建
  4. 普通问答（不触发工具）
  5. 工具调用（时间 / 计算）
  6. 多轮会话记忆（同一 thread_id）
  7. 会话持久化（落盘 SQLite、模拟重启后仍可续聊、新进程可列出）
  8. HTTP 接口（/health、/sessions、/chat），需服务已启动，可跳过

用法
----
    # 只跑本地检查（不依赖 HTTP 服务）
    python test_service.py

    # 连同 HTTP 接口一起测（需先启动服务）
    python test_service.py --base-url http://127.0.0.1:8770
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

import agent_service as svc

PASS = "[PASS]"
FAIL = "[FAIL]"
SKIP = "[SKIP]"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{PASS if ok else FAIL} {name}" + (f"  -> {detail}" if detail else ""))


def check_config() -> bool:
    print(f"\n--- 1. 配置 ---")
    print(f"  模型        : {svc.MODEL_NAME}")
    print(f"  BASE_URL    : {svc.BASE_URL}")
    print(f"  API Key     : {'已配置 (' + svc.API_KEY[:8] + '...)' if svc.API_KEY else '未配置'}")
    print(f"  .env 来源   : {svc.LOADED_ENV_FILES or '无'}")
    ok = bool(svc.API_KEY)
    record("配置加载 / API Key 可用", ok, "" if ok else "缺少 OPENAI_API_KEY")
    return ok


def check_model_direct() -> bool:
    print(f"\n--- 2. 模型直连 ---")
    try:
        from langchain_deepseek import ChatDeepSeek

        model = ChatDeepSeek(
            model=svc.MODEL_NAME, api_key=svc.API_KEY, base_url=svc.BASE_URL, temperature=0
        )
        started = time.perf_counter()
        resp = model.invoke("只回复两个字：你好")
        elapsed = int((time.perf_counter() - started) * 1000)
        text = resp.content if isinstance(resp.content, str) else str(resp.content)
        ok = bool(text.strip())
        record("模型直连返回内容", ok, f"{text.strip()!r} ({elapsed}ms)")
        return ok
    except Exception as exc:  # noqa: BLE001
        record("模型直连返回内容", False, f"{type(exc).__name__}: {exc}")
        return False


def check_agent_build() -> bool:
    print(f"\n--- 3. Agent 构建 ---")
    try:
        agent = svc.get_agent()
        record("Agent 构建成功", agent is not None, type(agent).__name__)
        return True
    except Exception as exc:  # noqa: BLE001
        record("Agent 构建成功", False, f"{type(exc).__name__}: {exc}")
        return False


def check_plain_chat() -> bool:
    print(f"\n--- 4. 普通问答 ---")
    try:
        info = svc.run_once("用一句话说明什么是 CRM。")
        ok = bool(info["reply"])
        record("普通问答有回复", ok, f"{info['elapsed_ms']}ms, {info['reply'][:60]}...")
        return ok
    except Exception as exc:  # noqa: BLE001
        record("普通问答有回复", False, f"{type(exc).__name__}: {exc}")
        return False


def check_tool_call() -> bool:
    print(f"\n--- 5. 工具调用 ---")
    try:
        info = svc.run_once("请调用工具算一下 (12 + 8) * 3 等于多少，只给出结果。")
        ok = info["tool_calls"] >= 1 and bool(info["reply"])
        record(
            "工具被调用并返回结果",
            ok,
            f"tool_calls={info['tool_calls']}, reply={info['reply'][:60]!r}",
        )
        return ok
    except Exception as exc:  # noqa: BLE001
        record("工具被调用并返回结果", False, f"{type(exc).__name__}: {exc}")
        return False


def check_time_tool() -> bool:
    print(f"\n--- 5b. 时间工具（时区） ---")
    try:
        import re

        # 先确认时区库可用（Windows 需 tzdata）
        try:
            from datetime import datetime
            from zoneinfo import ZoneInfo

            tz_ok = datetime.now(ZoneInfo("Asia/Shanghai")).tzinfo is not None
        except Exception as exc:  # noqa: BLE001
            record("tzdata 时区数据可用", False, f"{type(exc).__name__}: {exc}")
            tz_ok = False
        else:
            record("tzdata 时区数据可用", tz_ok)

        info = svc.run_once("现在几点了？请调用工具查询，只回复时间。")
        ok = bool(re.search(r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}", info["reply"]))
        record("时间工具返回日期", ok, f"reply={info['reply'][:70]!r}")
        return ok and tz_ok
    except Exception as exc:  # noqa: BLE001
        record("时间工具返回日期", False, f"{type(exc).__name__}: {exc}")
        return False


def check_multi_turn() -> bool:
    print(f"\n--- 6. 多轮会话记忆 ---")
    tid = f"test-{uuid.uuid4().hex[:8]}"
    try:
        svc.run_once("请记住这个数字：42。回复『好的』即可。", tid)
        info = svc.run_once("我刚才让你记住的数字是多少？只回复数字。", tid)
        ok = "42" in info["reply"]
        record("同一 thread_id 保留上下文", ok, f"reply={info['reply'][:60]!r}")
        return ok
    except Exception as exc:  # noqa: BLE001
        record("同一 thread_id 保留上下文", False, f"{type(exc).__name__}: {exc}")
        return False


def _db_rows(path: Path, table: str) -> int:
    """统计 SQLite 表行数（-1 表示读取失败）。"""
    if not path.is_file():
        return 0
    try:
        con = sqlite3.connect(str(path))
        try:
            return int(con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        finally:
            con.close()
    except Exception:  # noqa: BLE001
        return -1


def check_persistence() -> bool:
    print(f"\n--- 6b. 会话持久化（SQLite） ---")
    tid = f"test-persist-{uuid.uuid4().hex[:8]}"
    token = f"TK{uuid.uuid4().hex[:6].upper()}"
    ok_all = True

    try:
        # 1) 写入仅本次会话知道的信息
        svc.run_once(f"请记住这个口令：{token}。只回复『收到』。", tid)

        # 2) 每次调用都是「即开即关」：运行结束后内存中不留 Agent / 连接
        cleared = svc._AGENT is None and svc._CHECKPOINTER is None
        record("调用结束后内存无残留（Agent/连接已释放）", cleared, "agent 与 checkpointer 均为 None")
        ok_all &= cleared

        # 3) 重新读取上下文 —— 只能来自磁盘
        info = svc.run_once("我刚才让你记住的口令是什么？只回复口令。", tid)
        ok = token in info["reply"].upper()
        record("重启后仍能读回上下文", ok, f"reply={info['reply'][:60]!r}")
        ok_all &= ok

        # 4) 确实落盘了
        n_ckpt = _db_rows(svc.AGENT_DB, "checkpoints")
        ok = n_ckpt > 0
        record("会话已写入磁盘", ok, f"{svc.AGENT_DB.name}: checkpoints={n_ckpt}")
        ok_all &= ok

        # 5) 历史消息可还原
        history = svc._sync_once(svc.aget_history(tid))
        ok = any(token in m["content"].upper() for m in history)
        record("历史消息可还原", ok, f"{len(history)} 条消息")
        ok_all &= ok

        # 6) 跨进程：全新进程应能列出该会话
        script = Path(svc.__file__).parent / "agent_service.py"
        proc = subprocess.run(
            [sys.executable, str(script), "--list-sessions"],
            capture_output=True, text=True, encoding="utf-8", timeout=120,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        ok = proc.returncode == 0 and tid in out
        record("新进程可列出该会话", ok, f"exit={proc.returncode}")
        ok_all &= ok
    except Exception as exc:  # noqa: BLE001
        record("会话持久化", False, f"{type(exc).__name__}: {exc}")
        return False

    return ok_all


def check_http(base_url: str) -> bool:
    print(f"\n--- 7. HTTP 接口 ({base_url}) ---")
    try:
        import urllib.error
        import urllib.request
    except Exception as exc:  # noqa: BLE001
        record("HTTP 接口测试", False, f"{exc}")
        return False

    def request(path: str, payload: dict | None = None, timeout: int = 180) -> tuple[int, dict]:
        url = base_url.rstrip("/") + path
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
            method="POST" if data else "GET",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    ok_all = True
    try:
        status, body = request("/health")
        ok = status == 200 and body.get("status") == "ok"
        record(
            "GET /health",
            ok,
            f"status={body.get('status')}, model={body.get('model')}, persistent={body.get('persistent')}",
        )
        ok_all &= ok
    except Exception as exc:  # noqa: BLE001
        record("GET /health", False, f"{type(exc).__name__}: {exc}")
        return False

    try:
        status, body = request("/sessions")
        ok = status == 200 and isinstance(body.get("sessions"), list)
        record("GET /sessions", ok, f"已持久化会话 {body.get('count')} 个")
        ok_all &= ok
    except Exception as exc:  # noqa: BLE001
        record("GET /sessions", False, f"{type(exc).__name__}: {exc}")
        ok_all = False

    try:
        status, body = request("/chat", {"message": "你好，请用一句话自我介绍。"})
        ok = status == 200 and bool(body.get("reply"))
        record("POST /chat", ok, f"reply={str(body.get('reply'))[:50]!r}")
        ok_all &= ok
    except Exception as exc:  # noqa: BLE001
        record("POST /chat", False, f"{type(exc).__name__}: {exc}")
        ok_all = False

    # HTTP 侧的多轮上下文 + 历史查询
    try:
        tid = f"http-persist-{uuid.uuid4().hex[:8]}"
        tok = f"HP{uuid.uuid4().hex[:6].upper()}"
        request("/chat", {"message": f"请记住口令 {tok}，只回复『收到』。", "thread_id": tid})
        status, body = request("/chat", {"message": "刚才的口令是什么？只回复口令。", "thread_id": tid})
        ok = status == 200 and tok in str(body.get("reply", "")).upper()
        record("HTTP 同 thread_id 保留上下文", ok, f"reply={str(body.get('reply'))[:40]!r}")
        ok_all &= ok

        status, body = request(f"/sessions/{tid}/history")
        ok = status == 200 and int(body.get("count", 0)) >= 4
        record("GET /sessions/{id}/history", ok, f"count={body.get('count')}")
        ok_all &= ok
    except Exception as exc:  # noqa: BLE001
        record("HTTP 持久化接口", False, f"{type(exc).__name__}: {exc}")
        ok_all = False

    return ok_all


def main() -> int:
    parser = argparse.ArgumentParser(description="基础 Agent 服务测试")
    parser.add_argument("--base-url", default=None, help="已启动服务的地址，提供则额外测试 HTTP 接口")
    args = parser.parse_args()

    print("=" * 60)
    print("  基础 Agent 服务 · 测试")
    print("=" * 60)

    if not check_config():
        print("\n配置不完整，后续测试跳过。")
        return 1

    check_model_direct()
    if not check_agent_build():
        return 1
    check_plain_chat()
    check_tool_call()
    check_time_tool()
    check_multi_turn()
    check_persistence()

    if args.base_url:
        check_http(args.base_url)
    else:
        print(f"\n{SKIP} HTTP 接口测试（未提供 --base-url）")

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    for name, ok, detail in results:
        print(f"  {PASS if ok else FAIL}  {name}")
    print("-" * 60)
    print(f"  合计: {passed}/{total} 通过")
    print("=" * 60)
    return 0 if passed == total else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass
    raise SystemExit(main())
