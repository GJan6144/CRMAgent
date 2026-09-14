"""
基础 Agent 服务 (Basic Agent Service)
=====================================

一个最小可用的 Agent 服务：DeepSeek 模型 + Deep Agents 框架。

- 模型：deepseek-v4-flash（OpenAI 兼容接口，通过 langchain-deepseek 接入）
- 框架：deepagents（基于 LangGraph）
- 能力：简单工具调用（当前时间 / 四则运算）+ 可选多轮会话（按 thread_id）
- 接口：FastAPI —— GET /health、POST /chat、POST /chat/stream
- 同时支持命令行模式（单次提问 / 交互式）

用法
----
    # 1) 启动 HTTP 服务
    python agent_service.py --serve

    # 2) 单次提问
    python agent_service.py "现在几点了？"

    # 3) 交互模式（同一会话内多轮）
    python agent_service.py

配置
----
优先读环境变量；若未设置，则依次尝试加载以下 .env 文件：
    basic-agent/.env  ->  chat-ui/.env  ->  <项目根>/.env

    OPENAI_API_KEY   DeepSeek API Key（必填）
    OPENAI_BASE_URL  DeepSeek API 地址（默认 https://api.deepseek.com/v1）
    DEEPSEEK_MODEL   模型名（默认 deepseek-v4-flash）
    AGENT_PORT       服务端口（默认 8770）
    AGENT_DB         会话持久化文件（默认 basic-agent/agent_state.db）
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import json
import operator
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

# --------------------------------------------------------------------------
# 路径与配置加载
# --------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent

ENV_FILES = (
    BASE_DIR / ".env",
    PROJECT_ROOT / "chat-ui" / ".env",
    PROJECT_ROOT / ".env",
)


def load_env() -> list[str]:
    """按顺序加载 .env。已存在的环境变量优先级更高，不会被覆盖。"""
    loaded: list[str] = []
    try:
        from dotenv import load_dotenv
    except ImportError:
        return loaded
    for path in ENV_FILES:
        if path.is_file():
            load_dotenv(path, override=False)
            loaded.append(str(path))
    return loaded


LOADED_ENV_FILES = load_env()

MODEL_NAME: str = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash").strip()
BASE_URL: str = os.environ.get("OPENAI_BASE_URL", "https://api.deepseek.com/v1").strip()
API_KEY: str = os.environ.get("OPENAI_API_KEY", "").strip()
SYSTEM_PROMPT: str = os.environ.get(
    "AGENT_SYSTEM_PROMPT",
    "你是一个简洁、准确的智能助手，请始终使用中文回答。",
)
DEFAULT_PORT: int = int(os.environ.get("AGENT_PORT", "8770"))

# 会话持久化文件：默认放在 basic-agent/ 下，可用 AGENT_DB 覆盖
AGENT_DB: Path = Path(os.environ.get("AGENT_DB") or (BASE_DIR / "agent_state.db"))


# --------------------------------------------------------------------------
# 工具定义
# --------------------------------------------------------------------------

_SAFE_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _now_in(timezone_name: str) -> datetime:
    """按 IANA 时区取当前时间。

    Windows 上若未安装 `tzdata`，`ZoneInfo` 会抛 ZoneInfoNotFoundError，
    此时退化为本机时间，保证工具始终可用。
    """
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(timezone_name))
    except Exception:  # noqa: BLE001
        return datetime.now()


def _safe_eval(node: ast.AST) -> float:
    """在受限 AST 上求值，避免使用 eval 带来的风险。"""
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _SAFE_OPS:
        return _SAFE_OPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _SAFE_OPS:
        return _SAFE_OPS[type(node.op)](_safe_eval(node.operand))
    raise ValueError("表达式中包含不支持的语法")


def _register_tools() -> list[Any]:
    """延迟导入并构造工具列表（避免在无依赖环境下 import 失败）。"""
    from langchain_core.tools import tool

    @tool
    def get_current_time(timezone_name: str = "Asia/Shanghai") -> str:
        """获取当前日期和时间。

        Args:
            timezone_name: IANA 时区名，例如 Asia/Shanghai、UTC、America/New_York。
        """
        now = _now_in(timezone_name)
        tz_label = timezone_name if now.tzinfo is not None else "本机时间"
        return now.strftime("%Y-%m-%d %H:%M:%S") + f" ({tz_label})"

    @tool
    def calculate(expression: str) -> str:
        """计算一个数学表达式，支持 + - * / // % ** 与括号。

        Args:
            expression: 例如 "(12 + 8) * 3"。
        """
        try:
            tree = ast.parse(expression, mode="eval")
            value = _safe_eval(tree)
        except Exception as exc:
            return f"计算失败：{exc}"
        return f"{expression} = {value}"

    return [get_current_time, calculate]


# --------------------------------------------------------------------------
# Agent 构建（懒加载，进程内复用；会话状态持久化到 SQLite）
# --------------------------------------------------------------------------

_AGENT: Any = None
_CHECKPOINTER: Any = None
_CHECKPOINTER_CM: Any = None


async def _ensure_checkpointer() -> Any:
    """初始化（并复用）持久化 Checkpointer —— 数据落盘，重启不丢。"""
    global _CHECKPOINTER, _CHECKPOINTER_CM
    if _CHECKPOINTER is not None:
        return _CHECKPOINTER

    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    AGENT_DB.parent.mkdir(parents=True, exist_ok=True)
    _CHECKPOINTER_CM = AsyncSqliteSaver.from_conn_string(str(AGENT_DB))
    _CHECKPOINTER = await _CHECKPOINTER_CM.__aenter__()
    return _CHECKPOINTER


async def aget_agent() -> Any:
    """构建并缓存 Agent（异步）。

    首次调用时初始化模型、执行图与 **持久化 Checkpointer**：
    会话状态写入 `AGENT_DB`（默认 `basic-agent/agent_state.db`），
    因此同一 thread_id 的上下文在进程/服务重启后依然可以读回并续聊。
    """
    global _AGENT
    if _AGENT is not None:
        return _AGENT

    if not API_KEY:
        raise RuntimeError(
            "未配置 OPENAI_API_KEY。请在 basic-agent/.env 或 chat-ui/.env 中设置，"
            "或导出同名环境变量。"
        )

    from deepagents import create_deep_agent
    from langchain_deepseek import ChatDeepSeek

    model = ChatDeepSeek(
        model=MODEL_NAME,
        api_key=API_KEY,
        base_url=BASE_URL,
        temperature=0,
    )

    checkpointer = await _ensure_checkpointer()

    _AGENT = create_deep_agent(
        model=model,
        tools=_register_tools(),
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer,
    )
    return _AGENT


def _hard_stop(ckpt: Any) -> None:
    """兜底：同步通知 aiosqlite 后台线程退出（不依赖事件循环）。

    若连接没被正常关闭，CPython 会卡在 `threading._shutdown` 阶段等待
    （且此时 `atexit` 还没轮到执行，救不了场）。`Connection.stop()`
    是同步方法，只向内部队列投递停止指令，用作 `await conn.close()`
    失败时的最后一道保险。
    """
    conn = getattr(ckpt, "conn", None)
    if conn is None:
        return
    try:
        conn.stop()
    except Exception:  # noqa: BLE001
        pass


async def aclose_agent() -> None:
    """关闭持久化连接并清空缓存（事件循环结束前收尾，避免连接泄漏）。"""
    global _AGENT, _CHECKPOINTER, _CHECKPOINTER_CM
    _AGENT = None
    ckpt, _CHECKPOINTER = _CHECKPOINTER, None
    cm, _CHECKPOINTER_CM = _CHECKPOINTER_CM, None
    if cm is not None:
        try:
            await cm.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001
            pass
    _hard_stop(ckpt)  # 正常关闭失败时的兜底


def get_agent() -> Any:
    """同步构建 Agent 实例（用于连通性校验）。

    构建后立即关闭持久化连接 —— 需要真正对话请用 `run_once()`。
    """
    return _sync_once(aget_agent())


def reset_agent() -> None:
    """（保留）清空进程内缓存的 Agent 引用；异步场景请用 aclose_agent()。"""
    global _AGENT, _CHECKPOINTER
    _AGENT = None
    _CHECKPOINTER = None


# --------------------------------------------------------------------------
# 结果解析
# --------------------------------------------------------------------------

def _to_text(content: Any) -> str:
    """把消息 content 统一转成纯文本（兼容 str / 内容块列表）。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in ("text", "output_text"):
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return str(content)


def summarize_result(result: dict) -> dict:
    """从图执行结果中提取最终回复、推理内容与统计信息。"""
    messages = list(result.get("messages") or [])
    reply = ""
    reasoning = ""

    for msg in reversed(messages):
        if getattr(msg, "type", None) != "ai":
            continue
        text = _to_text(getattr(msg, "content", ""))
        if not text:
            continue
        reply = text
        kwargs = getattr(msg, "additional_kwargs", None) or {}
        reasoning = _to_text(kwargs.get("reasoning_content", ""))
        break

    tool_calls = sum(
        1
        for msg in messages
        if getattr(msg, "type", None) == "ai" and (getattr(msg, "tool_calls", None) or [])
    )

    return {
        "reply": reply.strip(),
        "reasoning": reasoning.strip(),
        "messages": len(messages),
        "tool_calls": tool_calls,
    }


async def arun_once(message: str, thread_id: Optional[str] = None) -> dict:
    """异步执行一次对话（同一 thread_id 共享持久化上下文）。"""
    agent = await aget_agent()
    tid = thread_id or f"cli-{uuid.uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": tid}}

    started = time.perf_counter()
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": message}]},
        config,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    info = summarize_result(result)
    info.update({"thread_id": tid, "model": MODEL_NAME, "elapsed_ms": elapsed_ms})
    return info


def _sync_once(coro: Any) -> Any:
    """在独立事件循环中执行协程，**结束后必定关闭持久化连接**。

    为什么要「即开即关」：aiosqlite 的连接由**非守护线程**支撑，
    而 CPython 退出时先执行 `threading._shutdown()`（等待所有非守护线程），
    之后才轮到 `atexit` 处理器 —— 也就是说 atexit 根本来不及救场，
    只要连接还开着，进程就会永久卡在退出阶段。因此同步入口一律用完即关。
    """
    async def _scoped() -> Any:
        try:
            return await coro
        finally:
            await aclose_agent()

    return asyncio.run(_scoped())


def run_once(message: str, thread_id: Optional[str] = None) -> dict:
    """同步执行一次对话（CLI 单次提问 / 测试脚本入口）。

    会话状态已落盘，因此即便换成新进程，同一 thread_id 的
    历史上下文依旧可以读回并继续对话。
    """
    return _sync_once(arun_once(message, thread_id))


# --------------------------------------------------------------------------
# 会话持久化读取（列表 / 历史）
# --------------------------------------------------------------------------

async def alist_sessions() -> list[dict]:
    """列出已持久化到磁盘的所有会话（按最近活动时间倒序）。

    只需读取会话库，不依赖模型，因此未配置 API Key 也可用。
    """
    ckpt = await _ensure_checkpointer()

    sessions: dict[str, dict] = {}
    async for tup in ckpt.alist(None):
        cfg = tup.config.get("configurable") or {}
        tid = cfg.get("thread_id")
        if not tid or cfg.get("checkpoint_ns"):
            continue
        ts = tup.checkpoint.get("ts") or ""
        item = sessions.setdefault(
            tid, {"thread_id": tid, "updated_at": "", "checkpoints": 0}
        )
        item["checkpoints"] += 1
        if ts > item["updated_at"]:
            item["updated_at"] = ts
    return sorted(sessions.values(), key=lambda s: s["updated_at"], reverse=True)


async def aget_history(thread_id: str) -> list[dict]:
    """从持久化状态还原某个会话的消息历史。"""
    agent = await aget_agent()
    state = await agent.aget_state({"configurable": {"thread_id": thread_id}})
    values = getattr(state, "values", None) or {}

    out: list[dict] = []
    for msg in values.get("messages") or []:
        raw_role = getattr(msg, "type", "")
        role = "user" if raw_role in ("human", "user") else (
            "assistant" if raw_role == "ai" else raw_role
        )
        kwargs = getattr(msg, "additional_kwargs", None) or {}
        out.append(
            {
                "role": role,
                "content": _to_text(getattr(msg, "content", "")),
                "reasoning": _to_text(kwargs.get("reasoning_content", "")),
            }
        )
    return out


# --------------------------------------------------------------------------
# HTTP 服务 (FastAPI)
# --------------------------------------------------------------------------

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="用户输入内容")
    thread_id: Optional[str] = Field(
        None, description="会话 ID；相同 ID 表示同一多轮会话，不传则自动生成"
    )


class ChatResponse(BaseModel):
    thread_id: str
    reply: str
    reasoning: str = ""
    model: str
    elapsed_ms: int
    messages: int
    tool_calls: int


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """服务生命周期：退出时关闭持久化连接，确保数据落盘。"""
    yield
    await aclose_agent()


app = FastAPI(
    title="Basic Agent Service",
    version="1.1.0",
    description="基于 Deep Agents + DeepSeek 的基础 Agent 服务（会话持久化）",
    lifespan=lifespan,
)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/")
def index() -> dict:
    return {
        "service": "basic-agent",
        "model": MODEL_NAME,
        "base_url": BASE_URL,
        "persistent": True,
        "agent_db": str(AGENT_DB),
        "endpoints": [
            "GET /health",
            "GET /sessions",
            "GET /sessions/{thread_id}/history",
            "POST /chat",
            "POST /chat/stream",
        ],
    }


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if API_KEY else "unconfigured",
        "model": MODEL_NAME,
        "base_url": BASE_URL,
        "api_key_configured": bool(API_KEY),
        "env_files": LOADED_ENV_FILES,
        "agent_ready": _AGENT is not None,
        # 会话持久化信息
        "persistent": True,
        "agent_db": str(AGENT_DB),
        "agent_db_exists": AGENT_DB.is_file(),
    }


@app.get("/sessions")
async def list_sessions() -> dict:
    """列出所有已持久化的会话（按最近活动时间倒序）。"""
    try:
        sessions = await alist_sessions()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"agent_db": str(AGENT_DB), "count": len(sessions), "sessions": sessions}


@app.get("/sessions/{thread_id}/history")
async def session_history(thread_id: str) -> dict:
    """读取某个会话的消息历史（从磁盘持久化状态还原）。"""
    try:
        messages = await aget_history(thread_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not messages:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"thread_id": thread_id, "count": len(messages), "messages": messages}


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    tid = req.thread_id or f"http-{uuid.uuid4().hex[:8]}"
    try:
        info = await arun_once(req.message, tid)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"{type(exc).__name__}: {exc}"
        ) from exc

    return ChatResponse(
        thread_id=tid,
        reply=info["reply"],
        reasoning=info["reasoning"],
        model=MODEL_NAME,
        elapsed_ms=info["elapsed_ms"],
        messages=info["messages"],
        tool_calls=info["tool_calls"],
    )


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    try:
        agent = await aget_agent()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    tid = req.thread_id or f"http-{uuid.uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": tid}}

    async def event_gen() -> AsyncGenerator[str, None]:
        yield _sse("start", {"thread_id": tid, "model": MODEL_NAME})
        try:
            async for chunk, _meta in agent.astream(
                {"messages": [{"role": "user", "content": req.message}]},
                config,
                stream_mode="messages",
            ):
                kwargs = getattr(chunk, "additional_kwargs", None) or {}
                reasoning = _to_text(kwargs.get("reasoning_content", ""))
                if reasoning:
                    yield _sse("reasoning", {"delta": reasoning})
                text = _to_text(getattr(chunk, "content", ""))
                if text:
                    yield _sse("token", {"delta": text})
            yield _sse("done", {"thread_id": tid})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------
# 命令行入口
# --------------------------------------------------------------------------

def cli_main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="agent_service",
        description="基础 Agent 服务 (DeepSeek + Deep Agents)",
    )
    parser.add_argument("prompt", nargs="*", help="单次提问内容；不传则进入交互模式")
    parser.add_argument("--serve", action="store_true", help="启动 HTTP 服务")
    parser.add_argument("--host", default="127.0.0.1", help="服务监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"服务端口（默认 {DEFAULT_PORT}）")
    parser.add_argument("--thread-id", default=None, help="会话 ID，用于多轮对话")
    parser.add_argument("--show-reasoning", action="store_true", help="打印模型推理过程")
    parser.add_argument("--list-sessions", action="store_true", help="列出所有已持久化的会话后退出")
    parser.add_argument("--history", default=None, metavar="THREAD_ID", help="打印指定会话的历史消息后退出")
    args = parser.parse_args(argv)

    # --- 会话库查询（只读，不依赖模型） ---
    if args.list_sessions:
        try:
            sessions = _sync_once(alist_sessions())
        except Exception as exc:  # noqa: BLE001
            print(f"[错误] {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        print(f"会话库: {AGENT_DB}")
        if not sessions:
            print("  (暂无持久化会话)")
        for s in sessions:
            print(
                f"  {s['thread_id']}   最近活动 {s['updated_at']}"
                f"   checkpoints={s['checkpoints']}"
            )
        return 0

    if args.history:
        try:
            msgs = _sync_once(aget_history(args.history))
        except Exception as exc:  # noqa: BLE001
            print(f"[错误] {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        if not msgs:
            print(f"未找到会话: {args.history}", file=sys.stderr)
            return 1
        print(f"会话 {args.history}（共 {len(msgs)} 条消息，来自 {AGENT_DB}）:")
        for m in msgs:
            print(f"  [{m['role']:9s}] {m['content'][:200]}")
        return 0

    if args.serve:
        import uvicorn

        print("=" * 56)
        print("  基础 Agent 服务 (Basic Agent Service)")
        print(f"  模型: {MODEL_NAME}")
        print(f"  地址: http://{args.host}:{args.port}")
        print(f"  会话库: {AGENT_DB}  (持久化，重启不丢)")
        print("  接口: GET /health | GET /sessions | POST /chat | POST /chat/stream")
        print("=" * 56)
        uvicorn.run(app, host=args.host, port=args.port, log_level="info")
        return 0

    if args.prompt:
        prompt = " ".join(args.prompt)
        try:
            info = run_once(prompt, args.thread_id)
        except Exception as exc:  # noqa: BLE001
            print(f"[错误] {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        if args.show_reasoning and info["reasoning"]:
            print(f"[思考] {info['reasoning']}")
        print(info["reply"] or "(无回复)")
        return 0

    # 交互模式：同一 thread_id 内保留上下文
    print("=" * 56)
    print("  基础 Agent 服务 · 交互模式")
    print(f"  模型: {MODEL_NAME}")
    print("  输入 exit / quit 退出")
    print("=" * 56)

    tid = args.thread_id or f"cli-{uuid.uuid4().hex[:8]}"
    while True:
        try:
            text = input("\n>>> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            return 0
        if text.lower() in {"exit", "quit"}:
            print("再见！")
            return 0
        if not text:
            continue
        try:
            info = run_once(text, tid)
        except Exception as exc:  # noqa: BLE001
            print(f"[错误] {type(exc).__name__}: {exc}")
            continue
        if args.show_reasoning and info["reasoning"]:
            print(f"[思考] {info['reasoning'][:600]}")
        print(f"[助手] {info['reply'] or '(无回复)'}")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass
    raise SystemExit(cli_main())
