"""
Deep Agents Chat UI - Backend (Full Capabilities)
FastAPI server with DeepSeek v4 Flash integration
All framework capabilities enabled: shell, memory, skills, permissions, checkpointer, tools, rubric
"""
import os
import sys
import time
import sqlite3
import json
import uuid
import asyncio
from datetime import datetime
from pathlib import Path
from contextlib import asynccontextmanager
from typing import AsyncGenerator

# --- CRM business-data tools (read + write sets) ---
# crm_tools 与本文件同级；显式加入 sys.path，兼容从任意 cwd 启动。
# 必须在 FsApprovalMiddleware 定义之前导入（它要用到 CRM 工具名集合）。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from crm_tools import (  # noqa: E402
    READ_TOOLS as CRM_READ_TOOLS,
    WRITE_TOOLS as CRM_WRITE_TOOLS,
    AGENT_WRITE_TOOLS as CRM_AGENT_WRITE_TOOLS,
    READ_TOOL_NAMES as CRM_READ_TOOL_NAMES,
    WRITE_TOOL_NAMES as CRM_WRITE_TOOL_NAMES,
    APPROVAL_TOOL_NAMES as CRM_APPROVAL_TOOL_NAMES,
    DENIED_TOOL_NAMES as CRM_DENIED_TOOL_NAMES,
    CRM_DATA_DIR as CRM_DATA_DIR,
)

# --- Agent 控制面板：可配置项（系统提示词 / 工具开关 / 工具权限）---
from agent_config import (  # noqa: E402
    effective as agent_effective,
    catalog as agent_catalog,
    get_system_prompt_override,
    set_system_prompt_override,
    reset_system_prompt,
    set_tool_enabled,
    set_tool_policy,
    reset_all as reset_agent_config,
    summary as agent_config_summary,
    POLICIES as AGENT_POLICIES,
    POLICY_LABELS as AGENT_POLICY_LABELS,
    CATEGORY_ORDER as AGENT_CATEGORY_ORDER,
    UnknownToolError,
)

# Configure DeepSeek before importing langchain
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    with open(_env_file, encoding="utf-8") as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip("\"'"))

os.environ.setdefault("OPENAI_API_KEY", "your-deepseek-api-key")
os.environ.setdefault("OPENAI_BASE_URL", "https://api.deepseek.com/v1")

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, FileResponse, Response
from pydantic import BaseModel
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, AIMessageChunk, ToolMessage
from langchain_core.callbacks import BaseCallbackHandler
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.sqlite import SqliteStore
from langgraph.types import interrupt, Command
from langchain.agents.middleware.types import AgentMiddleware


class DeepSeekChatOpenAI(ChatOpenAI):
    """ChatOpenAI subclass that preserves DeepSeek's `reasoning_content` (thinking)
    from the raw stream delta into `additional_kwargs`, so the UI can display
    the model's chain-of-thought in real time. Standard langchain-openai drops it."""

    def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info=None):
        gen = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
        if gen is None:
            return None
        if isinstance(gen.message, AIMessageChunk):
            choices = chunk.get("choices", []) or chunk.get("chunk", {}).get("choices", [])
            if choices:
                delta = choices[0].get("delta") or {}
                rc = delta.get("reasoning_content")
                if rc:
                    prev = gen.message.additional_kwargs.get("reasoning_content", "")
                    gen.message.additional_kwargs["reasoning_content"] = prev + rc
        return gen


class FsApprovalMiddleware(AgentMiddleware):
    """工具安全 / 审批中间件（在模型提出工具调用后、真正执行前生效）。

    权限与开关由「Agent 控制面板」（`agent_config`）驱动，每次 `build_agent`
    时通过 `refresh()` 注入最新配置：

      - ``policy = deny``      → 禁止执行：拦截并推送「禁止」提示，工具绝不运行；
      - ``enabled = False``    → 工具已被管理员关闭：同样拦截并提示「已关闭」；
      - ``policy = approval``  → 由本中间件发起人工审批（interrupt）：
                                 批准后才执行，拒绝则不执行；
      - ``policy = allow``     → 直接放行。

    另有一条**内置硬安全规则**（不受面板配置影响，防止误创建文件）：
    当 ``write_file`` / ``edit_file`` 的目标文件不存在（即「创建文件」）且该
    工具处于审批档时，直接禁止创建，而不是弹审批卡片。

    统一由本中间件承担审批，避免与框架 `HumanInTheLoopMiddleware` 叠加造成重复拦截。
    """

    # 文件写入类工具：改造前默认走审批；面板可覆盖为 allow / deny
    FS_WRITE_TOOLS = {"write_file", "edit_file"}

    # 「禁止」档的默认提示语（可在面板中改档，但提示语按工具固定）
    DENY_REASONS: dict[str, str] = {
        "crm_delete": (
            "禁止删除 CRM 业务数据：删除操作已被系统禁用，Agent 不得执行删除。"
            "如需删除请由管理员在系统中手动处理。"
        ),
        "delete": "禁止删除文件：当前不允许 Agent 执行删除操作。",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.refresh(agent_effective())

    def refresh(self, eff: dict) -> None:
        """按最新有效配置刷新运行时策略集合。"""
        self.settings: dict[str, dict] = eff.get("settings", {})
        self.disabled_tools: set[str] = set(eff.get("disabled_tools") or [])
        self.approval_tools: set[str] = set(eff.get("approval_tools") or [])
        self.deny_tools: set[str] = set(eff.get("deny_tools") or [])

    def _policy(self, name: str) -> str:
        spec = self.settings.get(name)
        return spec.get("policy", "allow") if spec else "allow"

    def _real_path(self, virtual: str) -> Path:
        p = virtual.replace("\\", "/")
        while p.startswith("/"):
            p = p[1:]
        return PROJECT_DIR / p

    @staticmethod
    def _blocked_kwargs(policy: str, reason: str, tc: dict) -> dict:
        """给「硬性禁止」的 ToolMessage 打标记。

        服务端读取该标记，把这次调用推送成 `tool_blocked` 事件（而不是普通的
        `tool_end`），前端据此渲染成红色的「禁止」提示。路由随后会回到模型节点，
        模型看到这条「禁止」结果后向用户解释。
        """
        try:
            args_preview = json.dumps(tc.get("args", {}) or {}, ensure_ascii=False)[:200]
        except Exception:
            args_preview = str(tc.get("args", ""))[:200]
        return {
            "blocked": True,
            "policy": policy,
            "blocked_reason": reason,
            "blocked_args": args_preview,
        }

    def after_model(self, state, runtime) -> dict | None:
        messages = state["messages"]
        if not messages:
            return None
        last_ai_msg = next(
            (m for m in reversed(messages) if isinstance(m, AIMessage)), None
        )
        if not last_ai_msg or not getattr(last_ai_msg, "tool_calls", None):
            return None

        pending: list[tuple[dict, int]] = []  # (tool_call, index)
        revised: list[dict] = []
        artificial: list[ToolMessage] = []

        for idx, tc in enumerate(last_ai_msg.tool_calls):
            name = tc.get("name", "")

            # 1) 禁止档 / 已关闭：拦截并推送「禁止」提示，工具绝不执行。
            #    保留 tool_call（错误 ToolMessage 需要合法前驱），由注入的
            #    ToolMessage 直接应答，路由会跳过真正执行。
            if name in self.deny_tools or name in self.disabled_tools:
                revised.append(tc)
                if name in self.disabled_tools and name not in self.deny_tools:
                    policy = "disabled"
                    deny_msg = f"工具「{name}」已被管理员关闭，禁止调用。"
                else:
                    policy = name
                    deny_msg = self.DENY_REASONS.get(
                        name, f"工具「{name}」被策略禁止执行。"
                    )
                artificial.append(ToolMessage(
                    content=deny_msg,
                    name=name, tool_call_id=tc.get("id", ""), status="error",
                    additional_kwargs=self._blocked_kwargs(policy, deny_msg, tc),
                ))
                continue

            # 2) 文件写入类：新建文件命中「内置硬安全规则」→ 直接禁止（不弹审批卡）
            if name in self.FS_WRITE_TOOLS and self._policy(name) == "approval":
                fpath = (tc.get("args") or {}).get("file_path", "")
                if not (fpath and self._real_path(fpath).exists()):
                    revised.append(tc)
                    deny_msg = f"禁止创建文件：{fpath} 不存在（创建操作不被允许）。"
                    artificial.append(ToolMessage(
                        content=deny_msg,
                        name=name, tool_call_id=tc.get("id", ""), status="error",
                        additional_kwargs=self._blocked_kwargs("fs_create", deny_msg, tc),
                    ))
                    continue
                pending.append((tc, idx))  # 修改已有文件 → 人工审批
                continue

            # 3) 审批档：进入人工审批
            if name in self.approval_tools:
                pending.append((tc, idx))
                continue

            # 4) 其余（allow 档）→ 直接放行
            revised.append(tc)

        if not pending:
            if not artificial:
                # 无需改动：不触碰 state，避免无谓的状态写入
                return None
            last_ai_msg.tool_calls = revised
            return {"messages": [last_ai_msg, *artificial]}

        # 人工审批：构造 interrupt 载荷（前端渲染成审批卡片）
        action_requests = []
        review_configs = []
        for tc, _ in pending:
            tname = tc["name"]
            targs = tc.get("args", {}) or {}
            if tname.startswith("crm_"):
                kind, title = "crm", "Agent 请求修改 CRM 业务数据"
            elif tname in self.FS_WRITE_TOOLS:
                kind, title = "fs", "Agent 请求修改文件"
            else:
                kind, title = "tool", f"Agent 请求执行工具 {tname}"
            action_requests.append({
                "name": tname,
                "args": targs,
                "kind": kind,
                "description": f"{title}。\n工具: {tname}\n参数: {json.dumps(targs, ensure_ascii=False)}",
            })
            review_configs.append({
                "action_name": tname,
                "allowed_decisions": ["approve", "reject"],
            })
        hitl_request = {"action_requests": action_requests, "review_configs": review_configs}
        decisions = interrupt(hitl_request)["decisions"]

        # UI 对整批只给一个决定 -> 复用到所有待审批调用；不足则其余按拒绝处理
        if decisions and len(decisions) < len(pending):
            if len(decisions) == 1:
                decisions = list(decisions) * len(pending)
            else:
                decisions = list(decisions) + [{"type": "reject"}] * (len(pending) - len(decisions))

        for (tc, _), d in zip(pending, decisions):
            revised.append(tc)
            if d.get("type") != "approve":
                # 保留 tool_call，让「已拒绝」的 ToolMessage 有合法前驱
                artificial.append(ToolMessage(
                    content="用户拒绝了该操作请求，工具未执行。",
                    name=tc["name"], tool_call_id=tc.get("id", ""), status="error",
                ))

        last_ai_msg.tool_calls = revised
        return {"messages": [last_ai_msg, *artificial]}

    async def aafter_model(self, state, runtime) -> dict | None:
        return self.after_model(state, runtime)

from deepagents import (
    create_deep_agent,
    register_provider_profile,
    ProviderProfile,
    SubAgent,
)
from deepagents.backends.local_shell import LocalShellBackend
from langchain_core.tools import tool

# --- Config ---
BASE_DIR = Path(__file__).parent
CHAT_UI_DIR = BASE_DIR
PROJECT_DIR = Path(__file__).parent.parent  # deepagents root
DB_PATH = CHAT_UI_DIR / "chat.db"
STATIC_DIR = CHAT_UI_DIR / "static"
SKILLS_DIR = CHAT_UI_DIR / "skills"

MODEL_NAME = "deepseek-v4-flash"

# DeepSeek chat model instance that preserves reasoning_content (thinking)
# so the UI can stream the chain-of-thought. Reuse one instance across agents.
_deepseek_model = DeepSeekChatOpenAI(
    model=MODEL_NAME,
    base_url=os.environ.get("OPENAI_BASE_URL", "https://api.deepseek.com/v1"),
    api_key=os.environ.get("OPENAI_API_KEY"),
    temperature=0,
    streaming=True,
    use_responses_api=False,
    # 让流式响应也返回 token 用量（OpenAI 兼容的 stream_options.include_usage），
    # 「Agent 控制面板」的 Token 消耗量据此统计。
    stream_usage=True,
)

# Register DeepSeek provider profile
register_provider_profile(
    "openai",
    ProviderProfile(init_kwargs={
        "use_responses_api": False,
        "base_url": "https://api.deepseek.com/v1",
    }),
)

# --- Metrics: 单轮对话的用量 / 耗时 / 工具调用采集 ---
def _extract_usage(response) -> tuple[int, int] | None:
    """从 LLMResult 中提取 (prompt_tokens, completion_tokens)。

    优先读 ``llm_output.token_usage``，其次读每条 generation 的 ``usage_metadata``。
    供应商未返回用量时返回 None。
    """
    try:
        lo = getattr(response, "llm_output", None) or {}
        tu = lo.get("token_usage") or lo.get("usage") or {}
        p = int(tu.get("prompt_tokens") or tu.get("input_tokens") or 0)
        c = int(tu.get("completion_tokens") or tu.get("output_tokens") or 0)
        if p or c:
            return (p, c)
    except Exception:
        pass
    try:
        for gen_list in (getattr(response, "generations", None) or []):
            for g in gen_list:
                msg = getattr(g, "message", None)
                um = getattr(msg, "usage_metadata", None) if msg is not None else None
                if isinstance(um, dict):
                    p = int(um.get("input_tokens") or 0)
                    c = int(um.get("output_tokens") or 0)
                    if p or c:
                        return (p, c)
    except Exception:
        pass
    return None


class MetricsCallback(BaseCallbackHandler):
    """采集一轮对话的模型 / 工具指标。

    - ``on_llm_end``  累计 token 用量（可取真实用量，否则按字符数估算）；
    - ``on_tool_start`` 统计工具调用次数与工具名。
    """

    def __init__(self) -> None:
        super().__init__()
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_tokens = 0
        self.llm_calls = 0
        self.tool_calls = 0
        self.tool_names: list[str] = []
        self._chars = 0
        self.estimated = False

    def on_llm_end(self, response, **kwargs) -> None:  # noqa: D102
        self.llm_calls += 1
        usage = _extract_usage(response)
        if usage:
            self.prompt_tokens += usage[0]
            self.completion_tokens += usage[1]
            self.total_tokens += usage[0] + usage[1]
        try:
            for gen_list in (getattr(response, "generations", None) or []):
                for g in gen_list:
                    msg = getattr(g, "message", None)
                    text = getattr(msg, "content", None) if msg is not None else getattr(g, "text", "")
                    if isinstance(text, str):
                        self._chars += len(text)
        except Exception:
            pass

    def on_llm_error(self, error, **kwargs) -> None:  # noqa: D102
        self.llm_calls += 1

    def on_tool_start(self, serialized, input_str, **kwargs) -> None:  # noqa: D102
        self.tool_calls += 1
        name = ""
        if isinstance(serialized, dict):
            name = str(serialized.get("name") or "")
        if name:
            self.tool_names.append(name)

    def finalize(self) -> dict:
        """产出可落库的指标字典。"""
        if self.total_tokens == 0 and self._chars:
            # 粗略估算：中英混排按 ~2 字符 / token 折算，仅用于面板展示
            self.total_tokens = max(1, int(self._chars / 2))
            self.completion_tokens = self.total_tokens
            self.estimated = True
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "llm_calls": self.llm_calls,
            "tool_calls": self.tool_calls,
            "tokens_estimated": 1 if self.estimated else 0,
            "tools_json": json.dumps(self.tool_names[:50], ensure_ascii=False),
        }


# --- Checkpointer & Store (SQLite persistent, survive restarts) ---
# chat.db is used by the chat UI itself; agent graph state goes to a separate file.
AGENT_STATE_DB = CHAT_UI_DIR / "agent_state.db"
checkpointer = None
store = None

# --- Backend: LocalShellBackend (enables execute + filesystem) ---
backend = LocalShellBackend(
    root_dir=str(PROJECT_DIR),
    virtual_mode=True,  # map /path to PROJECT_DIR/path (needed for AGENTS.md memory)
    timeout=120,
    max_output_bytes=200_000,
)

# --- File Permissions ---
# File Permissions (only for non-shell backends, skipped when using LocalShellBackend)
permissions = None

# --- Custom Tools ---
@tool
def get_project_info() -> str:
    """Get information about the deepagents project structure and key files."""
    import subprocess, json as _json
    result = subprocess.run(
        ["python", "-m", "uv", "run", "--", "python", "-c",
         "import json; print(json.dumps({'version': '0.6.12', 'name': 'deepagents'}))"],
        capture_output=True, text=True, timeout=10, cwd=str(PROJECT_DIR)
    )
    return result.stdout or "Project info unavailable."

@tool
def get_current_time(timezone: str = "Asia/Shanghai") -> str:
    """Get the current date and time. Optionally specify a timezone (e.g. 'UTC', 'Asia/Shanghai', 'America/New_York')."""
    from datetime import datetime, timezone as _tz
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(timezone)
        now = datetime.now(tz)
    except Exception:
        now = datetime.now(_tz.utc)
    return now.strftime("%Y-%m-%d %H:%M:%S %Z")

def _format_weather_summary(data: dict) -> str | None:
    """Extract a human-readable weather summary from a weather-API JSON
    payload (e.g. worldweatheronline format) instead of returning raw JSON."""
    if not isinstance(data, dict):
        return None
    has_cc = "current_condition" in data
    has_days = isinstance(data.get("weather"), list)
    if not (has_cc or has_days):
        return None
    lines = []
    cc = data.get("current_condition") or []
    if cc and isinstance(cc[0], dict):
        c = cc[0]
        desc = ""
        wd = c.get("weatherDesc") or []
        if wd:
            desc = wd[0].get("value", "") if isinstance(wd[0], dict) else str(wd[0])
        lines.append(f"当前天气: {desc or '未知'}")
        lines.append(f"温度: {c.get('temp_C', '?')}°C，体感 {c.get('FeelsLikeC', '?')}°C")
        lines.append(f"湿度: {c.get('humidity', '?')}%，风速: {c.get('windspeedKmph', '?')} km/h，风向: {c.get('winddir16Point', '?')}")
    for day in (data.get("weather") or [])[:7]:
        if not isinstance(day, dict):
            continue
        date = day.get("date", "")
        desc = ""
        for h in (day.get("hourly") or []):
            if not isinstance(h, dict):
                continue
            if str(h.get("time", "")) in ("900", "1200", "1500"):
                hd = h.get("weatherDesc") or []
                if hd:
                    desc = hd[0].get("value", "") if isinstance(hd[0], dict) else str(hd[0])
                break
        lines.append(f"{date}: {day.get('mintempC', '?')}~{day.get('maxtempC', '?')}°C，{desc or '天气未知'}")
    return "\n".join(lines)


def _summarize_json(obj, depth=0, max_depth=3, max_dict_keys=14, max_list_items=4):
    """Turn a JSON value into a compact, readable summary so the agent never
    has to handle (or paste) the raw JSON dump."""
    if depth > max_depth:
        return "..."
    if isinstance(obj, dict):
        parts = []
        for i, (k, v) in enumerate(obj.items()):
            if i >= max_dict_keys:
                parts.append(f"...(+{len(obj) - max_dict_keys} more keys)")
                break
            if isinstance(v, (dict, list)):
                parts.append(f"{k}: {_summarize_json(v, depth + 1, max_depth, max_dict_keys, max_list_items)}")
            else:
                parts.append(f"{k}: {v}")
        return "{" + ", ".join(parts) + "}"
    if isinstance(obj, list):
        if len(obj) > max_list_items:
            shown = [_summarize_json(x, depth + 1, max_depth, max_dict_keys, max_list_items) for x in obj[:max_list_items]]
            return "[" + ", ".join(shown) + f", ...(共{len(obj)}项)" + "]"
        return "[" + ", ".join(_summarize_json(x, depth + 1, max_depth, max_dict_keys, max_list_items) for x in obj) + "]"
    return str(obj)


@tool
def web_fetch(url: str, max_chars: int = 5000) -> str:
    """Fetch a web page and extract readable text. Use to read articles, docs, or URLs. Returns a summarized view of the content (truncated). JSON API responses are auto-summarized into compact key-value form. The agent must summarize this in its reply, never paste it verbatim."""
    import requests
    from bs4 import BeautifulSoup
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Charset": "utf-8",
        }
        r = requests.get(url, headers=headers, timeout=15, allow_redirects=True)
        r.raise_for_status()
        # JSON API response -> auto-summarize instead of returning raw JSON
        ctype = (r.headers.get("Content-Type", "") or "").lower()
        body = r.text or ""
        stripped = body.lstrip("\ufeff \t\r\n")
        if "json" in ctype or stripped.startswith("{") or stripped.startswith("["):
            try:
                data = json.loads(stripped)
                # Weather API payloads -> human-readable summary
                weather_summary = _format_weather_summary(data) if isinstance(data, dict) else None
                if weather_summary:
                    return f"Weather API response (extracted):\n{weather_summary}"
                summary = _summarize_json(data)
                if len(summary) > max_chars:
                    summary = summary[:max_chars] + f"\n... (summarized JSON, original {len(body)} chars)"
                return f"JSON API response (auto-summarized):\n{summary}"
            except Exception:
                pass  # not valid JSON after all; fall through to HTML parsing
        # Force UTF-8 decoding to avoid mojibake on non-UTF8 servers
        if r.encoding is None or r.encoding.lower() not in ("utf-8", "utf8"):
            r.encoding = "utf-8"
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
            tag.decompose()
        # Try to find the main content
        main = soup.find("main") or soup.find("article") or soup.find("div", id="content") or soup.find("body")
        text = main.get_text(separator="\n", strip=True) if main else soup.get_text(separator="\n", strip=True)
        text = "\n".join(line for line in text.split("\n") if line.strip())
        if len(text) > max_chars:
            text = text[:max_chars] + f"\n... (truncated, {len(text)} total chars)"
        return f"Web page content (auto-extracted):\n{text}"
    except Exception as e:
        return f"Error fetching {url}: {e}"

@tool
def web_search(query: str, max_results: int = 5) -> str:
    """Search the web for current information. Returns a list of {title, url, snippet} for the top results."""
    from duckduckgo_search import DDGS
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        if not results:
            return f"No results found for: {query}"
        out = [f"Search results for: {query}\n"]
        for i, r in enumerate(results, 1):
            out.append(f"{i}. {r.get('title','')}")
            out.append(f"   URL: {r.get('href','')}")
            out.append(f"   {r.get('body','')}\n")
        return "\n".join(out)
    except Exception as e:
        return f"Search error: {e}"

@tool
def get_weather(city: str) -> str:
    """查询指定城市的天气（天气预报）。city 传城市名（中文或拼音均可，如 '无锡'、'Wuxi'、'上海'、'Beijing'）。返回当前天气和未来几天的气温与天气状况，输出已格式化为中文摘要，直接用即可。"""
    import requests
    try:
        r = requests.get(
            f"https://wttr.in/{city}?format=j1",
            timeout=15,
            headers={"User-Agent": "curl/8.0"},
        )
        r.raise_for_status()
        data = r.json()
        summary = _format_weather_summary(data) if isinstance(data, dict) else None
        if summary:
            return f"{city} 天气：\n{summary}"
        return f"未找到 {city} 的天气数据。"
    except Exception as e:
        return f"天气查询失败: {e}"


@tool
def store_memory(key: str, value: str) -> str:
    """保存一条长期记忆，跨会话持久保留（重启服务后依然存在）。key 是记忆的标识（如 'user_name'、'user_favorite_color'），value 是记忆内容。适合记住用户偏好、个人资料、重要约定等。"""
    global store
    if store is None:
        return "记忆库未初始化（store 未就绪）"
    try:
        store.put(("memories",), key, {"value": value})
        return f"已保存记忆: {key} = {value}"
    except Exception as e:
        return f"保存记忆失败: {e}"

@tool
def recall_memory(key: str = "") -> str:
    """读取长期记忆。key 为空时返回全部记忆条目；指定 key 时返回该条记忆。记忆由 store_memory 写入，跨会话持久。"""
    global store
    if store is None:
        return "记忆库未初始化（store 未就绪）"
    try:
        if key:
            item = store.get(("memories",), key)
            if item:
                return f"{key}: {item.value.get('value', '')}"
            return f"未找到记忆: {key}"
        items = store.search(("memories",), limit=50)
        if not items:
            return "暂无已保存的记忆。"
        lines = ["已保存的长期记忆:"]
        for it in items:
            lines.append(f"- {it.key}: {it.value.get('value', '')}")
        return "\n".join(lines)
    except Exception as e:
        return f"读取记忆失败: {e}"

base_tools = [
    get_project_info, get_current_time, web_fetch, get_weather,
    store_memory, recall_memory,
    # CRM 读取工具（只读，默认直接放行）
    *CRM_READ_TOOLS,
    # CRM 写入工具：新增 / 修改 默认人工审批；crm_delete 作为「拦截桩」暴露给模型，
    # 模型可见、可调用，但 FsApprovalMiddleware 会在运行时一律拒绝并推送 tool_blocked，
    # 前端弹出「禁止」提示，物理上无法删除。
    *CRM_AGENT_WRITE_TOOLS,
]
search_tool = [web_search]

# 「本地工具」按名索引：供「Agent 控制面板」按名过滤（开关）与判定权限
LOCAL_TOOLS = base_tools + search_tool
LOCAL_TOOLS_BY_NAME: dict[str, object] = {t.name: t for t in LOCAL_TOOLS}

# --- Subagents ---
subagents = [
    SubAgent(
        name="code-reviewer",
        description="Review code changes for bugs, style issues, and improvements",
        system_prompt="You are a senior code reviewer. Analyze code carefully and provide constructive feedback.",
    ),
    SubAgent(
        name="researcher",
        description="Research technical topics by reading files and documentation",
        system_prompt="You are a research assistant. Read files thoroughly and provide comprehensive summaries.",
    ),
    SubAgent(
        name="crm-stats",
        description=(
            "CRM 数据统计 Agent：当用户需要统计 CRM 数据时使用（如统计线索/订单数量、按来源/销售/优先级分组统计、"
            "各类业务数据的汇总计数与求和）。此 Agent 负责调用 CRM 取数工具并输出统计结果。"
        ),
        system_prompt=(
            "You are the CRM data statistics specialist. Your job is to fetch CRM business data with "
            "the CRM read tools and produce clear statistics.\n"
            "Guidelines:\n"
            "1. Call crm_list_entities first to see available entities (leads / orders / products / "
            "accounts / communications / sales-targets) and their fields.\n"
            "2. Use crm_stats(entity, group_by, sum_field) for totals, grouped counts and sums; use "
            "crm_query(entity, filters, keyword, limit) when you need row-level filtering.\n"
            "3. Return the result as a Markdown table or bullet list with numbers.\n"
            "4. Always respond in Chinese. Never paste raw tool output — present summarized statistics."
        ),
        tools=[*CRM_READ_TOOLS],
    ),
    SubAgent(
        name="crm-analyst",
        description=(
            "CRM 数据分析 Agent：当用户需要分析 CRM 数据时使用（如分析线索质量、转化情况、优先级分布、"
            "销售跟进效果、数据洞察与建议）。此 Agent 负责深入分析 CRM 数据并输出分析结论。"
        ),
        system_prompt=(
            "You are the CRM data analysis specialist. Your job is to analyze CRM business data "
            "deeply and provide insights.\n"
            "Guidelines:\n"
            "1. Call crm_list_entities first, then use crm_query / crm_stats / crm_get to pull the "
            "relevant data (leads, orders, products, accounts, communications, sales-targets).\n"
            "2. Analyze: priority distribution, source effectiveness, assignee workload, conversion "
            "(leads vs orders), product performance, sales target attainment, etc.\n"
            "3. Provide structured analysis with headings and bullet points, plus actionable suggestions.\n"
            "4. Always respond in Chinese. Never paste raw tool output — present analyzed insights."
        ),
        tools=[*CRM_READ_TOOLS],
    ),
]

# --- Skills ---
skills = [str(SKILLS_DIR)]

# --- Rubric Middleware (disabled temporarily, needs grading model) ---
rubric_middleware = None

# --- 工具安全 / 审批中间件（运行时策略由「Agent 控制面板」驱动）---
# 「禁止 / 关闭 / 人工审批 / 放行」四类判定统一在 FsApprovalMiddleware 内执行，
# 每次 build_agent 时用最新配置 refresh()，保证面板改动即时生效。
fs_approval_middleware = FsApprovalMiddleware()

# --- Agent Factory ---
SYSTEM_PROMPT = """You are a helpful AI coding assistant. Respond in the same language as the user. Be concise and well-structured.

## Capabilities
- Filesystem: ls, read_file, write_file, edit_file, glob, grep
- Shell execution via `execute` tool
- Sub-agents (code-reviewer, researcher, crm-stats, crm-analyst)
- web_fetch: read any URL on demand
- get_weather: query weather forecast for any city (use this for weather questions)
- web_search: search the web (only when the user has enabled the "智能搜索" toggle)
- get_current_time: get current date/time in any timezone
- store_memory / recall_memory: persistent long-term memory (survives restarts, stored in SQLite)
- CRM business data tools (local JSON under `CRM_Agent1.0/data`):
  - read (allowed — runs immediately): `crm_list_entities`, `crm_query`, `crm_get`, `crm_stats`
  - write (a human approval card is required): `crm_create`, `crm_update`
  - delete: **FORBIDDEN** — `crm_delete` is a tripwire: calling it is always blocked and shows the
    user a 「禁止」 notice, and nothing is ever deleted
- Persistent memory at `/chat-ui/AGENTS.md` (already loaded, do not re-read it)

## CRM Data Handling (IMPORTANT)
- CRM business data lives in **local JSON files** and is accessed through the `crm_*` tools.
  Entities: `leads`(销售线索) / `orders`(订单) / `products`(产品) / `accounts`(账号) /
  `communications`(沟通记录) / `sales-targets`(销售目标).
- **ALWAYS call `crm_list_entities` first** when you are unsure which entities or field names exist.
- Reading (runs immediately, no approval):
  - `crm_query(entity, keyword, filters, limit, offset, sort_by, order)` — list/filter rows
  - `crm_get(entity, record_id)` — one full record by id
  - `crm_stats(entity, group_by, sum_field)` — totals, grouped counts, sums/averages
- Writing (a human approval card pops up; just call the tool normally — the system pauses for approval):
  - `crm_create(entity, data)` — add a record (`data` is a JSON object string)
  - `crm_update(entity, record_id, data)` — modify fields of one record
  **When the user asks you to add or modify CRM data, CALL THE TOOL DIRECTLY.** Do NOT ask
  for confirmation in chat and do NOT say you are unable to modify CRM data — the approval card IS
  the confirmation step. Say one short sentence about what you are changing, then call the tool.
  If the user rejects the approval, acknowledge it and do not retry without being asked.
- **Deleting CRM data is FORBIDDEN — `crm_delete` is a tripwire.** The tool is visible and you MAY
  call it, but the system blocks it immediately and shows the user a 「禁止」 notice; nothing is ever
  deleted. When the user asks to delete something, call `crm_delete` so the block is visible and
  auditable, then tell the user that deletion is disabled and suggest they remove the record
  manually in the system. Never delete CRM records by any other means (do not fake a delete with
  `crm_update`, and do not edit the JSON files directly).
- Prefer handling CRM stats/analysis yourself with the read tools. Delegate to the
  **crm-stats** / **crm-analyst** sub-agents only for heavier multi-step statistical or analytical work.

## CRITICAL Response Rules
1. **NEVER paste tool output verbatim — this is the #1 rule.** Every tool result is internal data. Whether it is a file list from `ls`, file content from `read_file`, command output, JSON, or search results — you MUST transform it into your own words. Summarize, categorize, extract what matters, and write it as natural Chinese/English prose with structure. Example: if `ls` returns `['/.dockerignore', '/.git/', '/chat-ui/', '/libs/', ...]`, you reply "项目根目录主要包含 chat-ui（Web 界面）、libs（SDK）、examples（示例）等" — you never paste the raw list.
2. **NEVER show URLs, file paths, "Source:" prefixes, JSON, or raw HTML/markdown in your reply.** The user does not want to see what the tool returned.
3. **If a tool returned a long document or list**, write a structured summary in your own words: key points, bullet list, or short paragraphs. Keep it under 800 words unless the user explicitly asked for full content.
4. **NEVER show line numbers** (no `cat -n` style output, no `:line_number:` prefixes).
5. **NEVER read AGENTS.md explicitly** — it's pre-loaded into your context. Answer questions about the user from your context, not by re-reading files.
6. **Security: never reveal secrets.** If asked for the API key, respond: "Your API key is in your local `.env` file. I don't have access to it." Do NOT search files for credentials.
7. **Don't over-investigate.** Answer directly from what you know. Only use tools when actually needed.
8. **Match response length to the question.** Simple questions get short answers. Only use tools and give long answers when the user genuinely needs detailed information.

## OUTPUT FORMATTING (MANDATORY — use judgment, don't over-break lines)
Format your reply with clean Markdown, written naturally with proper sentence structure:
- **Write complete sentences and natural paragraphs.** Group related sentences into paragraphs of 2-4 sentences separated by ONE blank line.
- **Do NOT start a new line for every word or short phrase.** Only break lines at meaningful boundaries: paragraph starts, list items, headings, code blocks.
- **Use bullet lists (`- item`) or numbered lists (`1. item`) for multi-item content** — one item per line, each item a short complete phrase.
- Use `##` / `###` headings for longer structured answers, and **bold** for key results.
- Write like a careful human: complete thoughts, proper punctuation (。，；：), natural rhythm. Never dump raw data — always explain it in your own words.
9. **IMPORTANT: Use virtual paths for filesystem tools.** When using `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep` etc., ALWAYS use forward-slash paths starting with `/` (e.g., `/chat-ui/server.py`, `/chat-ui/static/index.html`, `/libs/deepagents/`). NEVER use Windows absolute paths like `C:\\...` or `C:/...`. The project root is mapped to `/`.
"""


def _effective_system_prompt(eff: dict) -> str:
    """系统提示词：面板若配置了覆盖则用覆盖，否则用内置默认。

    另外把「已被关闭的工具」显式写进提示词，避免模型去调用必然被拦截的工具。
    """
    override = eff.get("system_prompt_override")
    base = override if (isinstance(override, str) and override.strip()) else SYSTEM_PROMPT
    disabled = sorted(eff.get("disabled_tools") or [])
    if disabled:
        base = base + (
            "\n\n## Disabled Tools (IMPORTANT)\n"
            "The administrator has disabled the following tools. NEVER call them; "
            "if a task requires one, tell the user it has been disabled:\n"
            + ", ".join(f"`{n}`" for n in disabled)
        )
    return base


def build_agent(use_search: bool = False):
    """按「Agent 控制面板」的最新配置构建 Agent。

    每次请求都重建，使面板改动（工具开关 / 权限档 / 系统提示词）即时生效：
      1. 工具清单：按「启用开关」过滤，被关闭的工具不再对模型可见；
      2. 权限策略：刷新中间件的 禁止 / 关闭 / 审批 / 放行 集合；
      3. 系统提示词：面板覆盖（若有）并追加「已关闭工具」说明。
    """
    eff = agent_effective()

    # 1) 工具清单：按开关过滤本地工具
    tools = [
        t for t in base_tools
        if eff["settings"].get(t.name, {}).get("enabled", True)
    ]
    if use_search and eff["settings"].get("web_search", {}).get("enabled", True):
        tools = tools + search_tool

    # 2) 刷新中间件运行时策略
    fs_approval_middleware.refresh(eff)

    return create_deep_agent(
        model=_deepseek_model,
        backend=backend,
        permissions=permissions,
        checkpointer=checkpointer,
        store=store,
        subagents=subagents,
        skills=skills,
        memory=["/chat-ui/AGENTS.md"],
        tools=tools,
        middleware=(fs_approval_middleware,),
        system_prompt=_effective_system_prompt(eff),
    )

# --- Database ---
def init_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Chat',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0
        )
    """)
    # Migration: add pinned column to existing databases
    cursor = conn.execute("PRAGMA table_info(sessions)")
    cols = [row[1] for row in cursor.fetchall()]
    if 'pinned' not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            rating TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    # 「Agent 控制面板」用：每轮对话的指标（调用次数 / 耗时 / token / 工具调用）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agent_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            session_id TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            latency_ms REAL NOT NULL DEFAULT 0,
            ok INTEGER NOT NULL DEFAULT 1,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            llm_calls INTEGER NOT NULL DEFAULT 0,
            tool_calls INTEGER NOT NULL DEFAULT 0,
            tokens_estimated INTEGER NOT NULL DEFAULT 0,
            tools_json TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_agent_metrics_ts ON agent_metrics(ts)")
    conn.commit()
    conn.close()


def record_metric(
    session_id: str,
    latency_ms: float,
    ok: bool,
    usage: dict | None = None,
    model: str = "",
) -> None:
    """写入一轮对话的指标（失败容忍：统计不应影响主流程）。"""
    usage = usage or {}
    try:
        db = get_db()
        db.execute(
            "INSERT INTO agent_metrics (ts, session_id, model, latency_ms, ok, prompt_tokens,"
            " completion_tokens, total_tokens, llm_calls, tool_calls, tokens_estimated, tools_json)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                datetime.now().isoformat(timespec="seconds"),
                session_id,
                model or MODEL_NAME,
                float(latency_ms or 0),
                1 if ok else 0,
                int(usage.get("prompt_tokens") or 0),
                int(usage.get("completion_tokens") or 0),
                int(usage.get("total_tokens") or 0),
                int(usage.get("llm_calls") or 0),
                int(usage.get("tool_calls") or 0),
                int(usage.get("tokens_estimated") or 0),
                usage.get("tools_json") or "[]",
            ),
        )
        db.commit()
        db.close()
    except Exception as e:  # noqa: BLE001
        print(f"[metrics] 写入失败: {e}")

def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

# --- Pydantic Models ---
class CreateSessionRequest(BaseModel):
    title: str = "New Chat"

class SendMessageRequest(BaseModel):
    session_id: str
    content: str
    use_search: bool = False

class ApproveRequest(BaseModel):
    approved: bool
    session_id: str = ""

class UpdateTitleRequest(BaseModel):
    title: str

class PinRequest(BaseModel):
    pinned: bool

class FeedbackRequest(BaseModel):
    message_id: str
    session_id: str
    rating: str  # "like" or "dislike"

# --- App ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    global checkpointer, store
    # Persistent store (semantic/long-term memory) backed by SQLite
    import sqlite3
    _conn = sqlite3.connect(str(AGENT_STATE_DB), check_same_thread=False, isolation_level=None)
    store = SqliteStore(_conn)
    # Persistent async checkpointer (agent graph state survives restarts)
    async with AsyncSqliteSaver.from_conn_string(str(AGENT_STATE_DB)) as ckpt:
        checkpointer = ckpt
        yield
    _conn.close()

app = FastAPI(lifespan=lifespan)

# --- Session APIs ---
@app.get("/api/sessions")
def list_sessions():
    db = get_db()
    # Pinned sessions first, then by updated_at
    sessions = db.execute(
        "SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC"
    ).fetchall()
    db.close()
    return [{"id": s["id"], "title": s["title"], "pinned": bool(s["pinned"]), "created_at": s["created_at"], "updated_at": s["updated_at"]} for s in sessions]

@app.post("/api/sessions")
def create_session(req: CreateSessionRequest):
    session_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    db = get_db()
    db.execute("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
               (session_id, req.title, now, now))
    db.commit()
    db.close()
    return {"id": session_id, "title": req.title, "created_at": now, "updated_at": now}

@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str):
    db = get_db()
    db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    db.commit()
    db.close()
    return {"ok": True}

@app.patch("/api/sessions/{session_id}")
def update_title(session_id: str, req: UpdateTitleRequest):
    now = datetime.now().isoformat()
    db = get_db()
    db.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (req.title, now, session_id))
    db.commit()
    db.close()
    return {"ok": True}

@app.post("/api/sessions/{session_id}/pin")
def pin_session(session_id: str, req: PinRequest):
    now = datetime.now().isoformat()
    db = get_db()
    db.execute("UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?", (1 if req.pinned else 0, now, session_id))
    db.commit()
    db.close()
    return {"ok": True, "pinned": req.pinned}

@app.get("/api/sessions/{session_id}/messages")
def get_messages(session_id: str):
    db = get_db()
    messages = db.execute(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC", (session_id,)
    ).fetchall()
    db.close()
    return [{"id": m["id"], "role": m["role"], "content": m["content"], "created_at": m["created_at"]} for m in messages]

# --- Feedback API ---
@app.post("/api/feedback")
def post_feedback(req: FeedbackRequest):
    if req.rating not in ("like", "dislike"):
        raise HTTPException(status_code=400, detail="Invalid rating")
    feedback_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    db = get_db()
    # Remove any existing feedback for this message
    db.execute("DELETE FROM feedback WHERE message_id = ?", (req.message_id,))
    db.execute(
        "INSERT INTO feedback (id, message_id, session_id, rating, created_at) VALUES (?, ?, ?, ?, ?)",
        (feedback_id, req.message_id, req.session_id, req.rating, now)
    )
    db.commit()
    db.close()
    return {"ok": True, "id": feedback_id, "rating": req.rating}

@app.get("/api/feedback/{session_id}")
def get_feedback(session_id: str):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM feedback WHERE session_id = ? ORDER BY created_at DESC", (session_id,)
    ).fetchall()
    db.close()
    return [{"id": r["id"], "message_id": r["message_id"], "rating": r["rating"], "created_at": r["created_at"]} for r in rows]

@app.delete("/api/feedback/{message_id}")
def delete_feedback(message_id: str):
    db = get_db()
    db.execute("DELETE FROM feedback WHERE message_id = ?", (message_id,))
    db.commit()
    db.close()
    return {"ok": True}

# --- Capabilities Info ---
@app.get("/api/capabilities")
def get_capabilities():
    return {
        "shell_execution": True,
        "memory_agents_md": True,
        "skills": True,
        "sub_agents": True,
        "permissions": True,
        "checkpointer": True,
        "rubric": True,
        "custom_tools": True,
        "file_permissions": True,
        "auto_summarization": True,
        "tool_call_repair": True,
        "todo_list": True,
        # 本地文件系统能力：LocalShellBackend 继承自 FilesystemBackend
        "filesystem_backend": True,
        "backend": "LocalShellBackend(FilesystemBackend)",
        # CRM 业务数据工具（读取 4 + 需审批的写入 2；删除被禁用）
        "crm_tools": True,
        "crm_read_tools": sorted(CRM_READ_TOOL_NAMES),
        "crm_write_tools": sorted(CRM_APPROVAL_TOOL_NAMES),
        "crm_denied_tools": sorted(CRM_DENIED_TOOL_NAMES),
        "crm_data_dir": str(CRM_DATA_DIR),
        # 「禁止」类工具：模型可见，但调用会被拦截并在前端弹出红色禁止提示
        "blocked_tools": sorted(fs_approval_middleware.deny_tools),
        "blocked_event": "tool_blocked",
        # 工具权限 / 人工审批（运行时策略由「Agent 控制面板」驱动）
        "human_in_the_loop": True,
        # approval_on：CRM 写操作（保持向后兼容的既有语义）
        "approval_on": sorted(CRM_APPROVAL_TOOL_NAMES),
        "tool_policy": {
            "read": "allow",
            "write": "approval",
            "delete": "deny",
        },
        # ---- Agent 控制面板：全部工具的运行时权限 / 开关 ----
        "ui_panel": True,
        "approval_tools": sorted(fs_approval_middleware.approval_tools),
        "disabled_tools": sorted(fs_approval_middleware.disabled_tools),
        "panel_config_endpoint": "/api/panel/config",
        "panel_overview_endpoint": "/api/panel/overview",
    }


# --------------------------------------------------------------------------
# Agent 控制面板（Agent Control Panel）
# --------------------------------------------------------------------------
PANEL_START_TS = datetime.now()
_MODEL_CHECK_CACHE: dict = {"ts": 0.0, "result": None}
_MODEL_CHECK_TTL = 20.0  # 秒：模型连通性探测结果缓存时长


class SystemPromptRequest(BaseModel):
    system_prompt: str


class ToolEnabledRequest(BaseModel):
    enabled: bool


class ToolPolicyRequest(BaseModel):
    policy: str


def _metric_summary(scope: str = "all") -> dict:
    """聚合指标：scope="today" 只统计当天；否则统计全部。"""
    where = "WHERE date(ts) = date('now','localtime')" if scope == "today" else ""
    db = get_db()
    row = db.execute(
        f"""SELECT COUNT(*) AS calls,
                   COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
                   COALESCE(MAX(latency_ms), 0) AS max_latency_ms,
                   COALESCE(SUM(tool_calls), 0) AS tool_calls,
                   COALESCE(SUM(total_tokens), 0) AS total_tokens,
                   COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                   COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                   COALESCE(SUM(llm_calls), 0) AS llm_calls,
                   COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
            FROM agent_metrics {where}"""
    ).fetchone()
    last = db.execute(
        "SELECT ts, latency_ms FROM agent_metrics ORDER BY id DESC LIMIT 1"
    ).fetchone()
    db.close()
    return {
        "calls": int(row["calls"] or 0),
        "avg_latency_ms": round(float(row["avg_latency_ms"] or 0), 1),
        "max_latency_ms": round(float(row["max_latency_ms"] or 0), 1),
        "tool_calls": int(row["tool_calls"] or 0),
        "total_tokens": int(row["total_tokens"] or 0),
        "prompt_tokens": int(row["prompt_tokens"] or 0),
        "completion_tokens": int(row["completion_tokens"] or 0),
        "llm_calls": int(row["llm_calls"] or 0),
        "errors": int(row["errors"] or 0),
        "last_ts": (last["ts"] if last else None),
    }


def _metric_trend(days: int = 7) -> list[dict]:
    db = get_db()
    rows = db.execute(
        """SELECT date(ts) AS d, COUNT(*) AS calls,
                  COALESCE(SUM(total_tokens), 0) AS tokens,
                  COALESCE(SUM(tool_calls), 0) AS tool_calls,
                  COALESCE(AVG(latency_ms), 0) AS latency_ms
           FROM agent_metrics GROUP BY d ORDER BY d DESC LIMIT ?""",
        (int(days),),
    ).fetchall()
    db.close()
    out = [
        {
            "date": r["d"],
            "calls": int(r["calls"] or 0),
            "tokens": int(r["tokens"] or 0),
            "tool_calls": int(r["tool_calls"] or 0),
            "avg_latency_ms": round(float(r["latency_ms"] or 0), 1),
        }
        for r in rows
    ]
    return list(reversed(out))


@app.get("/api/panel/overview")
def panel_overview():
    """Agent 概览：服务健康检查 + 用量指标（今日 / 累计）。"""
    checks = {
        "api": True,
        "checkpointer": checkpointer is not None,
        "store": store is not None,
        "chat_db": DB_PATH.is_file(),
        "agent_state_db": AGENT_STATE_DB.is_file(),
    }
    db_ok = True
    try:
        db = get_db()
        db.execute("SELECT 1").fetchone()
        db.close()
    except Exception:
        db_ok = False
    checks["chat_db"] = checks["chat_db"] and db_ok
    healthy = checks["api"] and checks["chat_db"] and checks["agent_state_db"]

    cached = _MODEL_CHECK_CACHE.get("result")
    return {
        "service": {
            "name": "deepagents-chat-ui",
            "status": "healthy" if healthy else "degraded",
            "model": MODEL_NAME,
            "backend": "LocalShellBackend(FilesystemBackend)",
            "port": 8765,
            "pid": os.getpid(),
            "python": sys.version.split()[0],
            "started_at": PANEL_START_TS.isoformat(timespec="seconds"),
            "uptime_seconds": round((datetime.now() - PANEL_START_TS).total_seconds(), 1),
        },
        "health": {**checks, "status": "healthy" if healthy else "degraded"},
        "model": {
            "name": MODEL_NAME,
            "base_url": os.environ.get("OPENAI_BASE_URL", ""),
            # 未探测过时为 null，由前端调用 /api/panel/model-check 填充
            "connected": (cached or {}).get("ok"),
            "checked_at": (cached or {}).get("tested_at"),
            "latency_ms": (cached or {}).get("latency_ms"),
        },
        "usage": {"today": _metric_summary("today"), "total": _metric_summary("all")},
        "trend": _metric_trend(7),
        "config": agent_config_summary(),
    }


@app.post("/api/panel/model-check")
async def panel_model_check(force: bool = False):
    """模型连通性探测：向模型发一极小请求，测量往返耗时。"""
    now = time.time()
    cached = _MODEL_CHECK_CACHE.get("result")
    if not force and cached and (now - float(_MODEL_CHECK_CACHE.get("ts") or 0)) < _MODEL_CHECK_TTL:
        return cached

    started = time.perf_counter()
    ok, reply, err = True, "", ""
    try:
        resp = await asyncio.wait_for(
            _deepseek_model.ainvoke([HumanMessage(content="ping")]), timeout=25
        )
        content = getattr(resp, "content", "")
        reply = content if isinstance(content, str) else str(content)
    except Exception as e:  # noqa: BLE001
        ok, err = False, str(e)
    result = {
        "ok": ok,
        "model": MODEL_NAME,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "tested_at": datetime.now().isoformat(timespec="seconds"),
        "reply_preview": reply[:60],
        "error": err[:300],
    }
    _MODEL_CHECK_CACHE.update({"ts": now, "result": result})
    return result


def _panel_config_payload() -> dict:
    eff = agent_effective()
    override = eff["system_prompt_override"]
    return {
        "system_prompt": override if override is not None else SYSTEM_PROMPT,
        "default_system_prompt": SYSTEM_PROMPT,
        "is_custom": override is not None,
        "updated_at": eff["updated_at"],
        "policy_options": [
            {"value": v, "label": AGENT_POLICY_LABELS.get(v, v)} for v in AGENT_POLICIES
        ],
        "categories": AGENT_CATEGORY_ORDER,
        "tools": agent_catalog(),
        "summary": agent_config_summary(),
    }


@app.get("/api/panel/config")
def panel_get_config():
    """系统提示词 + 工具清单（含开关与权限档）。"""
    return _panel_config_payload()


@app.put("/api/panel/system-prompt")
def panel_set_system_prompt(req: SystemPromptRequest):
    try:
        set_system_prompt_override(req.system_prompt)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _panel_config_payload()


@app.post("/api/panel/system-prompt/reset")
def panel_reset_system_prompt():
    reset_system_prompt()
    return _panel_config_payload()


@app.get("/api/panel/tools")
def panel_list_tools():
    return {"tools": agent_catalog(), "summary": agent_config_summary()}


@app.put("/api/panel/tools/{name}")
def panel_set_tool_enabled(name: str, req: ToolEnabledRequest):
    try:
        set_tool_enabled(name, req.enabled)
    except UnknownToolError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    fs_approval_middleware.refresh(agent_effective())
    return {
        "ok": True,
        "tool": next((t for t in agent_catalog() if t["name"] == name), None),
        "summary": agent_config_summary(),
    }


@app.put("/api/panel/tools/{name}/policy")
def panel_set_tool_policy(name: str, req: ToolPolicyRequest):
    try:
        set_tool_policy(name, req.policy)
    except UnknownToolError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    fs_approval_middleware.refresh(agent_effective())
    return {
        "ok": True,
        "tool": next((t for t in agent_catalog() if t["name"] == name), None),
        "summary": agent_config_summary(),
    }


@app.post("/api/panel/reset")
def panel_reset():
    """一键恢复默认：系统提示词 + 全部工具开关与权限。"""
    reset_agent_config()
    fs_approval_middleware.refresh(agent_effective())
    return _panel_config_payload()


@app.get("/api/context/{session_id}")
def get_context(session_id: str):
    """Return the current session context: system prompt, conversation history,
    tool definitions, and skill index. Used by the right-side Context panel."""
    db = get_db()
    # Conversation history
    rows = db.execute(
        "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC",
        (session_id,),
    ).fetchall()
    db.close()
    messages = []
    for r in rows:
        messages.append({
            "role": r[0],
            "content": r[1],
            "created_at": r[2],
        })
    # Tool definitions：按「Agent 控制面板」的有效配置过滤（被关闭的工具不在模型清单里），
    # 并附带该工具当前的权限档，供右侧 Context 面板展示。
    eff = agent_effective()

    def _tool_meta(t):
        fn = getattr(t, "func", t)
        name = getattr(t, "name", getattr(fn, "__name__", "tool"))
        desc = (fn.__doc__ or "").strip().split("\n")[0] if fn.__doc__ else ""
        spec = eff["settings"].get(name, {})
        return {
            "name": name,
            "description": desc,
            "enabled": spec.get("enabled", True),
            "policy": spec.get("policy", "allow"),
        }

    tool_defs = [
        _tool_meta(t) for t in (base_tools + search_tool)
        if eff["settings"].get(getattr(t, "name", ""), {}).get("enabled", True)
    ]
    # Built-in filesystem/shell tools provided by the backend (informational)
    backend_tools = ["ls", "ls_info", "read", "write", "edit", "delete", "glob", "glob_info", "grep", "grep_raw", "execute"]
    # Skill index: scan SKILLS_DIR subdirectories
    skill_index = []
    if SKILLS_DIR.exists():
        for child in sorted(SKILLS_DIR.iterdir()):
            if not child.is_dir():
                continue
            skill_md = child / "SKILL.md"
            summary = ""
            if skill_md.exists():
                try:
                    head = skill_md.read_text(encoding="utf-8").split("---")
                    # Try frontmatter summary
                    if len(head) >= 3:
                        for line in head[1].splitlines():
                            if line.strip().startswith("summary:"):
                                summary = line.split("summary:", 1)[1].strip().strip("\"'")
                                break
                    if not summary:
                        # First non-empty, non-heading line
                        for line in skill_md.read_text(encoding="utf-8").splitlines():
                            s = line.strip().lstrip("#").strip()
                            if s and not s.startswith("---"):
                                summary = s
                                break
                except Exception:
                    summary = ""
            skill_index.append({"name": child.name, "path": str(child), "summary": summary})
    return {
        # 反映面板的有效系统提示词（含「已关闭工具」说明）
        "system_prompt": _effective_system_prompt(eff),
        "messages": messages,
        "tools": tool_defs,
        "backend_tools": backend_tools,
        "skills": skill_index,
        "subagents": [{"name": getattr(s, "name", None) or s.get("name", ""), "description": getattr(s, "description", None) or s.get("description", "")} for s in subagents],
    }

# --- Chat API ---
# Pending human approvals: thread_id -> {"event": asyncio.Event, "decision": dict|None}
PENDING_APPROVALS: dict[str, dict] = {}


async def _wait_approval(thread_id: str, count: int = 1) -> dict:
    """Block the event stream until the user approves/rejects; return the decision."""
    entry = {"event": asyncio.Event(), "decision": None, "count": max(1, int(count or 1))}
    PENDING_APPROVALS[thread_id] = entry
    try:
        await entry["event"].wait()
        return entry["decision"]
    finally:
        PENDING_APPROVALS.pop(thread_id, None)


@app.post("/api/chat/{session_id}/approve")
async def approve_action(session_id: str, req: ApproveRequest):
    """Resume an interrupted agent run with the user's approval decision."""
    thread_id = f"thread_{session_id}"
    entry = PENDING_APPROVALS.get(thread_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="No pending approval for this session")
    # 框架 HITL 强制 decisions 数量 == 本次中断的调用数：
    # 前端对整批只给一个决定，这里展开成 N 份
    n = max(1, int(entry.get("count") or 1))
    one = {"type": "approve" if req.approved else "reject"}
    entry["decision"] = {"decisions": [dict(one) for _ in range(n)]}
    entry["event"].set()
    return {"ok": True, "approved": req.approved, "decisions": n}


@app.post("/api/chat")
async def chat(req: SendMessageRequest):
    db = get_db()
    session = db.execute("SELECT * FROM sessions WHERE id = ?", (req.session_id,)).fetchone()
    if not session:
        db.close()
        raise HTTPException(status_code=404, detail="Session not found")

    # Save user message
    msg_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
               (msg_id, req.session_id, "user", req.content, now))

    # Auto-title for first message
    msg_count = db.execute("SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?", (req.session_id,)).fetchone()["cnt"]
    if msg_count == 1:
        title = req.content[:30] + ("..." if len(req.content) > 30 else "")
        db.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (title, now, req.session_id))

    db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, req.session_id))
    db.commit()

    # Build message history
    history = db.execute(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC", (req.session_id,)
    ).fetchall()
    db.close()

    messages = []
    for h in history:
        if h["role"] == "user":
            messages.append(HumanMessage(content=h["content"]))
        else:
            messages.append(AIMessage(content=h["content"]))

    # Invoke the full-featured agent
    agent = build_agent(use_search=req.use_search)

    thread_id = f"thread_{req.session_id}"
    # 本轮对话的指标采集器（token / 工具调用次数等）
    metrics = MetricsCallback()
    turn_started = time.perf_counter()

    async def event_stream() -> AsyncGenerator[str, None]:
        full_response = ""
        full_thinking = ""
        ai_msg_id = None
        # 同一 tool_call 可能出现在多个节点输出里，按 id 去重，避免前端重复气泡
        seen_tool_starts: set[str] = set()

        def _emit(payload):
            """Wrap a payload as an SSE data line with a timestamp."""
            payload["ts"] = datetime.now().isoformat()
            return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        try:
            # Run the agent, resuming after human approvals. On `__interrupt__`
            # we emit an approval_request event and block until the user decides.
            resume: dict | None = None
            while True:
                interrupted = False
                graph_input = (
                    {"messages": messages}
                    if resume is None
                    else Command(resume=resume)
                )
                async for chunk in agent.astream(
                    graph_input,
                    config={
                        "configurable": {"thread_id": thread_id},
                        # 指标回调：采集 token 用量与工具调用次数
                        "callbacks": [metrics],
                    },
                ):
                    if "__end__" in chunk:
                        continue
                    if "__interrupt__" in chunk:
                        # 人工审批：可能来自自定义中间件（文件修改），
                        # 也可能来自框架 HumanInTheLoopMiddleware（CRM 写操作）。
                        val = chunk["__interrupt__"]
                        items = val if isinstance(val, (tuple, list)) else [val]
                        approval_reqs: list[dict] = []
                        for it in items:
                            payload = getattr(it, "value", it)
                            if not isinstance(payload, dict):
                                continue
                            for raw in (payload.get("action_requests") or []):
                                if not isinstance(raw, dict):
                                    continue
                                areq = dict(raw)
                                # 框架不带 kind 字段：按工具名补上，供前端卡片区分
                                nm = str(areq.get("name") or areq.get("tool") or "")
                                areq.setdefault("kind", "crm" if nm.startswith("crm_") else "fs")
                                approval_reqs.append(areq)
                        yield _emit({"event": "approval_request", "requests": approval_reqs})
                        resume = await _wait_approval(thread_id, len(approval_reqs))
                        interrupted = True
                        break
                    for node_name, node_output in chunk.items():
                        if not isinstance(node_output, dict):
                            continue
                        msgs = node_output.get("messages", [])
                        # Emit Agent Loop execution info for the Loop tab
                        loop_msgs = []
                        for m in msgs:
                            mtype = type(m).__name__
                            preview = str(getattr(m, "content", "") or "")[:200]
                            loop_msgs.append({"type": mtype, "preview": preview})
                        yield _emit({
                            "event": "loop",
                            "node": node_name,
                            "msg_types": [type(m).__name__ for m in msgs],
                            "msg_count": len(msgs),
                            "msgs": loop_msgs,
                        })
                        if not msgs:
                            continue
                        last = msgs[-1]
                        # 只有 AI 消息才算「助手正文」。ToolMessage 的结果属于工具输出，
                        # 只通过 tool_end 事件单独展示，绝不能混进回复正文里。
                        is_ai = isinstance(last, (AIMessage, AIMessageChunk))
                        if is_ai and getattr(last, "content", None):
                            text = str(last.content)
                            if len(text) > len(full_response):
                                new_text = text[len(full_response):]
                                full_response = text
                                yield _emit({"event": "llm_token", "token": new_text, "node": node_name})
                        # Capture reasoning_content (DeepSeek R1 thinking)
                        if is_ai and hasattr(last, "additional_kwargs"):
                            reasoning = last.additional_kwargs.get("reasoning_content", "")
                            if reasoning and len(reasoning) > len(full_thinking):
                                new_thinking = reasoning[len(full_thinking):]
                                full_thinking = reasoning
                                yield _emit({"event": "llm_thinking", "thinking": new_thinking, "node": node_name})
                        # Tool call started (AIMessage with tool_calls)
                        if hasattr(last, "tool_calls") and getattr(last, "tool_calls", None):
                            for tc in last.tool_calls:
                                tc_name = tc.get("name", "tool")
                                tc_id = str(tc.get("id") or "")
                                if tc_id and tc_id in seen_tool_starts:
                                    continue
                                if tc_id:
                                    seen_tool_starts.add(tc_id)
                                tc_args = tc.get("args", {})
                                if isinstance(tc_args, str):
                                    try:
                                        tc_args = json.loads(tc_args)
                                    except Exception:
                                        pass
                                args_preview = ""
                                if tc_args:
                                    try:
                                        args_preview = json.dumps(tc_args, ensure_ascii=False)[:200]
                                    except Exception:
                                        args_preview = str(tc_args)[:200]
                                yield _emit({"event": "tool_start", "status": "tool_start", "id": tc_id, "name": tc_name, "args": args_preview, "node": node_name})
                                # write_todos: emit a dedicated todo event with the full list
                                if tc_name == "write_todos" and isinstance(tc_args, dict):
                                    todos_list = tc_args.get("todos", [])
                                    if isinstance(todos_list, list) and todos_list:
                                        yield _emit({"event": "todo", "todos": todos_list, "node": node_name})
                        # Tool call finished (ToolMessage)
                        if isinstance(last, ToolMessage):
                            t_status = getattr(last, "status", "success") or "success"
                            t_result = str(last.content or "")[:300]
                            t_id = str(getattr(last, "tool_call_id", "") or "")
                            t_name = getattr(last, "name", "tool")
                            ak = getattr(last, "additional_kwargs", None) or {}
                            if isinstance(ak, dict) and ak.get("blocked"):
                                # 硬性禁止（策略拦截）：单独推送 tool_blocked，
                                # 前端渲染成红色「禁止」提示，而不是普通「失败」。
                                t_args = str(ak.get("blocked_args") or "")
                                if t_id and t_id not in seen_tool_starts:
                                    # 模型侧可能没单独推送过 tool_start，补一条，
                                    # 让前端有一行可更新（并带上参数）
                                    seen_tool_starts.add(t_id)
                                    yield _emit({"event": "tool_start", "status": "tool_start", "id": t_id, "name": t_name, "args": t_args, "node": node_name})
                                yield _emit({
                                    "event": "tool_blocked",
                                    "status": "tool_blocked",
                                    "id": t_id,
                                    "name": t_name,
                                    "args": t_args,
                                    "reason": str(ak.get("blocked_reason") or t_result),
                                    "policy": str(ak.get("policy") or "deny"),
                                    "tool_status": t_status,
                                    "node": node_name,
                                })
                            else:
                                yield _emit({"event": "tool_end", "status": "tool_end", "id": t_id, "name": t_name, "tool_status": t_status, "result": t_result, "node": node_name})
                if not interrupted:
                    break  # stream finished

            # Save AI response
            ai_msg_id = str(uuid.uuid4())
            now_str = datetime.now().isoformat()
            db = get_db()
            db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                       (ai_msg_id, req.session_id, "assistant", full_response, now_str))
            if full_thinking:
                # Store thinking as a separate hidden message
                think_msg_id = str(uuid.uuid4())
                db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                           (think_msg_id, req.session_id, "thinking", full_thinking, now_str))
            db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_str, req.session_id))
            db.commit()
            db.close()

            # 记录本轮指标（供「Agent 控制面板」统计）
            record_metric(
                req.session_id,
                latency_ms=(time.perf_counter() - turn_started) * 1000,
                ok=True,
                usage=metrics.finalize(),
            )

            yield _emit({"event": "done", "done": True, "message_id": ai_msg_id})

        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()
            print(f"[Agent error] {error_detail}")
            record_metric(
                req.session_id,
                latency_ms=(time.perf_counter() - turn_started) * 1000,
                ok=False,
                usage=metrics.finalize(),
            )
            yield _emit({"event": "error", "error": str(e)})

    return StreamingResponse(event_stream(), media_type="text/event-stream")

# --- Static Files ---
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Suppress harmless 404s from browser probes
@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools_probe():
    return {"ok": True}

@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)

@app.get("/")
def index():
    import os
    content = open(str(STATIC_DIR / "index.html"), encoding="utf-8").read()
    return Response(content=content, media_type="text/html",
                    headers={"Cache-Control": "no-cache, no-store, must-revalidate",
                             "Pragma": "no-cache", "Expires": "0"})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
