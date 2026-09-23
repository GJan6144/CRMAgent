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
import crm_tools  # noqa: E402  （模块级引用：chat 端点要调 set_data_scope）
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

# --- Agent 侧数据范围（从 CRM 的 roles.json 解析角色在「AI 助手」页的数据权限）---
import crm_permissions  # noqa: E402

# --- 对话流数据卡片工具（render_card：content 给模型 / artifact 给界面）---
from card_tools import (  # noqa: E402
    CARD_TOOLS,
    CARD_TOOL_NAMES,
)

# --- 本地知识库工具（KB_TOOLS：检索 / 导入 / 查看 / 删除）---
from kb_tools import (  # noqa: E402
    KB_TOOLS,
    KB_TOOL_NAMES,
)

# --- Word 文档（.docx）读写工具：读全文 / 列占位符 / 填充模板生成新文档 ---
from docx_tools import (  # noqa: E402
    DOCX_TOOLS,
    DOCX_TOOL_NAMES,
)

# --- 飞书渠道通信：发送 / 回复 / 搜通讯录 + 接收消息长连接 ---
import feishu_tools  # noqa: E402

# --- 通信渠道数据层（「渠道管理」Tab：开关 / 凭证）---
import channel_config  # noqa: E402

# --- MCP（外部工具服务器）桥接：加载 bing-cn-mcp 等外部工具 ---
import mcp_tools as mcp_tools  # noqa: E402

# --- Agent 定时任务（数据层；调度循环与执行在 server.py）---
import scheduler  # noqa: E402

# --- 模型注册表（「模型管理」Tab + 对话界面模型下拉框）---
import model_config  # noqa: E402
import image_store  # noqa: E402
import file_store  # noqa: E402

# --- 知识库文件上传（前端「Agent 知识库」页：列表 / 上传 / 删除 / 进度）---
from kb_embeddings import describe as kb_embedding_describe  # noqa: E402
from kb_store import get_store as kb_get_store  # noqa: E402
from kb_upload import (  # noqa: E402
    delete_documents as kb_delete_documents,
    describe as kb_upload_describe,
    get_manager as kb_get_manager,
    is_managed_file as kb_is_managed_file,
)

# --- Agent 控制面板：可配置项（系统提示词 / 工具开关 / 工具权限 / 技能开关）---
from agent_config import (  # noqa: E402
    effective as agent_effective,
    catalog as agent_catalog,
    get_system_prompt_override,
    set_system_prompt_override,
    reset_system_prompt,
    set_tool_enabled,
    set_tool_policy,
    get_skill_overrides,
    set_skill_enabled,
    reset_all as reset_agent_config,
    summary as agent_config_summary,
    POLICIES as AGENT_POLICIES,
    POLICY_LABELS as AGENT_POLICY_LABELS,
    CATEGORY_ORDER as AGENT_CATEGORY_ORDER,
    UnknownToolError,
    UnknownSkillError,
)

# --- Agent 控制面板：Skill 管理（扫盘 / 校验 / 读写 SKILL.md）---
from skills_admin import (  # noqa: E402
    MAX_EDITABLE_BYTES,
    SkillSource,
    SkillError,
    SkillNotFound,
    SkillValidationError,
    catalog as skill_catalog,
    find as skill_find,
    read_content as skill_read_content,
    write_content as skill_write_content,
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

from fastapi import FastAPI, HTTPException, Request
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

    # 能读到文件内容的工具：被关闭技能的 SKILL.md 要挡住（见 _disabled_skill_in_path）
    SKILL_READ_TOOLS = {"read_file", "grep"}

    # 「禁止」档的默认提示语（可在面板中改档，但提示语按工具固定）
    DENY_REASONS: dict[str, str] = {
        "crm_delete": (
            "禁止删除 CRM 业务数据：删除操作已被系统禁用，Agent 不得执行删除。"
            "如需删除请由管理员在系统中手动处理。"
        ),
        "delete": "禁止删除文件：当前不允许 Agent 执行删除操作。",
    }

    def __init__(self, *args, auto_approve: bool = False, **kwargs):
        super().__init__(*args, **kwargs)
        # 无人值守场景（Agent 定时任务 / 测试执行）下自动批准审批档工具，
        # 避免 interrupt 永久阻塞等待一个不存在的人工决策。
        self.auto_approve = auto_approve
        self.refresh(agent_effective())

    def refresh(self, eff: dict) -> None:
        """按最新有效配置刷新运行时策略集合。"""
        self.settings: dict[str, dict] = eff.get("settings", {})
        self.disabled_tools: set[str] = set(eff.get("disabled_tools") or [])
        self.approval_tools: set[str] = set(eff.get("approval_tools") or [])
        self.deny_tools: set[str] = set(eff.get("deny_tools") or [])
        # 被「Skill 管理」关闭的技能：其 SKILL.md 及目录内其它文件不可读
        self.disabled_skills: set[str] = set(eff.get("disabled_skills") or [])

    def _policy(self, name: str) -> str:
        spec = self.settings.get(name)
        return spec.get("policy", "allow") if spec else "allow"

    def _real_path(self, virtual: str) -> Path:
        p = virtual.replace("\\", "/")
        while p.startswith("/"):
            p = p[1:]
        return PROJECT_DIR / p

    def _disabled_skill_in_path(self, file_path: str) -> str | None:
        """路径是否落在某个「已关闭技能」目录里；是则返回技能名。

        技能目录 = 技能来源目录的**直接子目录**（`<source>/<skill-name>/...`）。
        这里要求技能名的上一段包含 "skill"（`skills` / `built_in_skills` 都命中），
        以免把同名的普通目录误判成技能。
        """
        if not file_path or not self.disabled_skills:
            return None
        segments = [s for s in file_path.replace("\\", "/").split("/") if s]
        for i in range(1, len(segments)):
            seg = segments[i]
            if seg in self.disabled_skills and "skill" in segments[i - 1].lower():
                return seg
        return None

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

            # 0) 读取「已关闭技能」目录内的文件 → 禁止。
            #    技能关闭后只从提示词里摘掉是不够的：模型可能从历史上下文里
            #    记住了 SKILL.md 的路径，照样能 read_file 把正文读回来。
            if name in self.SKILL_READ_TOOLS and self.disabled_skills:
                args = tc.get("args") or {}
                targets = [
                    v for k, v in args.items()
                    if k in ("file_path", "path", "file", "filename") and isinstance(v, str)
                ]
                hit = next(
                    (s for s in (self._disabled_skill_in_path(t) for t in targets) if s),
                    None,
                )
                if hit:
                    revised.append(tc)
                    deny_msg = (
                        f"禁止读取技能「{hit}」的文件：该技能已被管理员关闭，"
                        "其 SKILL.md 与附属文件均不可用。"
                    )
                    artificial.append(ToolMessage(
                        content=deny_msg,
                        name=name, tool_call_id=tc.get("id", ""), status="error",
                        additional_kwargs=self._blocked_kwargs("skill_disabled", deny_msg, tc),
                    ))
                    continue

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

        if self.auto_approve:
            # 无人值守（Agent 定时任务 / 测试执行）：自动批准，直接放行所有待审批工具
            for tc, _ in pending:
                revised.append(tc)
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
from deepagents.middleware.skills import SkillsMiddleware, SKILLS_SYSTEM_PROMPT
from langchain_core.tools import tool

# --- Config ---
BASE_DIR = Path(__file__).parent
CHAT_UI_DIR = BASE_DIR
PROJECT_DIR = Path(__file__).parent.parent  # deepagents root
DB_PATH = CHAT_UI_DIR / "chat.db"
STATIC_DIR = CHAT_UI_DIR / "static"
SKILLS_DIR = CHAT_UI_DIR / "skills"


def _resolve_builtin_skills_dir() -> Path | None:
    """定位框架内置技能目录（remember / skill-creator 等随框架发布）。

    优先取已安装的 ``deepagents_code`` 包内路径，回退到仓库源码路径；
    两者都不存在时返回 ``None``（此时仅不启用内置技能，不影响其他来源）。
    """
    candidates: list[Path] = []
    try:
        import deepagents_code  # type: ignore[import-not-found]

        candidates.append(Path(deepagents_code.__file__).parent / "built_in_skills")
    except Exception:
        pass
    candidates.append(PROJECT_DIR / "libs" / "code" / "deepagents_code" / "built_in_skills")
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


MODEL_NAME = "deepseek-flash"  # 兜底默认值（真实默认见 model_config.DEFAULT_SELECTED）

# --- 模型注册表：把 DeepSeek 模型类注入 model_config，由它按 id 构造并缓存实例 ---
model_config.set_model_class(DeepSeekChatOpenAI)


def _resolve_model(model_id: str | None = None):
    """取本轮对话要用的模型实例（``model_id`` 为空则用当前选中模型）。"""
    try:
        mid = model_id or model_config.get_selected()
        return mid, model_config.get_chat_model(mid)
    except Exception as e:  # noqa: BLE001
        # 注册表异常时回落到种子默认模型，保证对话不中断
        print(f"[model] 解析模型失败，回落 {MODEL_NAME}: {e}")
        return MODEL_NAME, model_config.get_chat_model(MODEL_NAME)


def _active_model_id() -> str:
    """当前对话实际使用的模型 id（供概览 / 健康检查展示）。"""
    try:
        return model_config.get_selected()
    except Exception:  # noqa: BLE001
        return MODEL_NAME


# 默认模型实例（保持向后兼容，供少量直接引用处使用）
_deepseek_model = model_config.get_chat_model(model_config.get_selected())

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
    # 对话流数据卡片（无副作用，只影响展示，默认直接放行）
    *CARD_TOOLS,
    # 本地知识库：检索 / 查看 默认放行；导入 / 删除 默认人工审批
    # （导入会调用远程 Embedding 消耗额度，删除会改库文件）
    *KB_TOOLS,
    # Word 文档读写：读全文 / 列占位符 默认放行；填充模板生成新文件 默认人工审批
    *DOCX_TOOLS,
]
search_tool = [web_search]


def feishu_active_tools() -> list:
    """飞书渠道工具：渠道开启才返回（关闭则飞书工具对模型不可见）。

    与「渠道管理」Tab 的开关联动；工具级开关仍由 TOOL_CATALOG 单独控制。
    """
    return feishu_tools.FEISHU_TOOLS if channel_config.is_enabled("feishu") else []

# 「本地工具」按名索引：供「Agent 控制面板」按名过滤（开关）与判定权限
LOCAL_TOOLS = base_tools + search_tool
LOCAL_TOOLS_BY_NAME: dict[str, object] = {t.name: t for t in LOCAL_TOOLS}


def _extract_card(msg, tool_name: str, tool_call_id: str) -> dict | None:
    """从 ``render_card`` 工具产生的 ToolMessage 中取出数据卡片。

    卡片数据走 ``ToolMessage.artifact``（与给模型看的 ``content`` 分离），
    这里做一次结构与内容校验；任何一步不满足都返回 ``None``（不产生卡片，
    只在工具列表里留一条普通调用记录）。
    """
    if tool_name not in CARD_TOOL_NAMES:
        return None
    artifact = getattr(msg, "artifact", None)
    if not isinstance(artifact, dict):
        return None
    data = artifact.get("data")
    if not isinstance(data, dict) or not data.get("sections"):
        return None
    return {
        "card_id": f"card-{tool_call_id or uuid.uuid4().hex}",
        "card_type": str(artifact.get("card_type") or "generic"),
        "title": str(artifact.get("title") or "分析结果"),
        "data": data,
    }

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

# --- Skills（框架标准分层来源）---
# 来源按「低 → 高」优先级排列，同名技能由高优先级覆盖（与 deepagents-code 的约定一致）：
#   内置 → 项目 .deepagents → 项目 .agents → 项目 .claude → 本服务 chat-ui/skills（最高）
#
# 约束：agent 的文件系统 backend 是 virtual_mode=True、根目录 = 框架根（PROJECT_DIR），
# 因此技能目录**必须位于该根内**。否则模型虽然能在系统提示词里「看到」技能，
# 却无法用 read_file 读取其 SKILL.md（会被判为 outside root directory）。
# 故这里统一使用「根内虚拟路径」；用户级目录（~/.deepagents、~/.agents、~/.claude）
# 不在根内，不纳入（需要时可把目录放进项目根，或用符号链接挂进来）。
def _skill_real_path(virtual_path: str) -> Path:
    """把技能的虚拟路径映射回真实文件系统路径。"""
    return PROJECT_DIR / virtual_path.lstrip("/")


def _collect_skill_sources() -> list[tuple[str, str]]:
    """收集可用的技能来源（仅真实存在且位于 agent 根目录内的目录）。

    Returns:
        `(虚拟路径, 显示标签)` 列表，顺序即优先级（越靠后越高）。
    """
    root = PROJECT_DIR.resolve()
    candidates: list[tuple[Path | None, str]] = [
        (_resolve_builtin_skills_dir(), "Built-in"),
        (PROJECT_DIR / ".deepagents" / "skills", "Project Deepagents"),
        (PROJECT_DIR / ".agents" / "skills", "Project Agents"),
        (PROJECT_DIR / ".claude" / "skills", "Project Claude"),
        (SKILLS_DIR, "Chat UI"),
    ]
    sources: list[tuple[str, str]] = []
    for path, label in candidates:
        if path is None:
            continue
        try:
            real = path.resolve()
            if not real.is_dir():
                continue
            relative = real.relative_to(root)
        except (OSError, ValueError):
            continue
        sources.append(("/" + relative.as_posix(), label))
    return sources


SKILL_SOURCES = _collect_skill_sources()
skills = [virtual_path for virtual_path, _label in SKILL_SOURCES]


def _admin_skill_sources() -> list[SkillSource]:
    """把 `SKILL_SOURCES` 转成面板用的来源对象（带真实目录）。"""
    return [
        SkillSource(label=label, virtual_path=vpath, real_dir=_skill_real_path(vpath))
        for vpath, label in SKILL_SOURCES
    ]


# SKILL.md 被改动前的历史副本落在这里（集中存放，避免污染技能目录本身）
SKILL_BACKUP_DIR = CHAT_UI_DIR / "_skill_backups"


class SkillsControlMiddleware(SkillsMiddleware):
    """框架 `SkillsMiddleware` + 「启用 / 关闭」。

    框架的技能机制里**没有开关**：加载时扫盘、`modify_request` 全量渲染进系统
    提示词，中间没有任何过滤点。这里在框架基础上只加两件事：

    1. **过滤**：被关闭的技能不进 `skills_metadata`，也就不进系统提示词 ——
       模型根本不知道它存在，自然不会去用（这是「关闭」的主要手段）；
    2. **强制重载**：框架把 `skills_metadata` 按**会话**缓存在 state 里
       （`if "skills_metadata" in state: return None`），只有新会话才重新扫盘。
       这里每次都重新加载，让面板开关在**下一轮对话**就生效，
       不必等用户开新会话（与工具开关的行为保持一致）。

    ⚠️ **同步 / 异步是两套独立实现**：框架把加载逻辑在 `before_agent`（同步）与
    `abefore_agent`（异步，`async def`，自己重新实现了一遍而不是 `return
    self.before_agent(...)`）里各写了一份。chat-ui 的 `/api/chat` 是异步的，
    实际走的是 **`abefore_agent`** —— 只覆写同步版会**完全不生效**（而且不报错：
    技能照旧全量注入，表面上一切正常）。两个入口必须都覆写。
    `modify_request` / `wrap_model_call` 侧没有这个问题，渲染读的是 state。

    兜底拦截（读被关闭技能的 SKILL.md）在 `FsApprovalMiddleware` 里，
    那才是「不可用」的硬保证 —— 提示词过滤只解决「模型不知道」，
    挡不住模型从历史上下文里记住了旧路径。

    实现上刻意**不碰框架私有函数**：先 `state` 里摘掉缓存字段，再调 `super()`
    走框架原生的加载逻辑（连同它的错误信息格式一起复用），最后过滤结果。
    """

    def __init__(
        self,
        *,
        backend,
        sources,
        disabled: set[str] | None = None,
        system_prompt: str | None = SKILLS_SYSTEM_PROMPT,
    ) -> None:
        super().__init__(backend=backend, sources=sources, system_prompt=system_prompt)
        self.disabled_skills: set[str] = set(disabled or ())

    def refresh(self, disabled) -> None:
        """按最新配置刷新「已关闭技能」集合。"""
        self.disabled_skills = set(disabled or ())

    @staticmethod
    def _without_cache(state):
        """摘掉框架的「每会话只加载一次」缓存字段，逼它重新扫盘。"""
        clean = dict(state)
        clean.pop("skills_metadata", None)
        clean.pop("skills_load_errors", None)
        return clean

    def _apply(self, update):
        """把框架加载结果里被关闭的技能剔掉（同步 / 异步共用）。"""
        if not update:
            return update
        loaded = update.get("skills_metadata")
        if loaded is not None and self.disabled_skills:
            update["skills_metadata"] = [
                s for s in loaded if s.get("name") not in self.disabled_skills
            ]
        return update

    def before_agent(self, state, runtime, config):  # ty: ignore[invalid-method-override]
        """同步入口（`invoke` / `stream`）。"""
        return self._apply(
            super().before_agent(self._without_cache(state), runtime, config)
        )

    async def abefore_agent(self, state, runtime, config):  # ty: ignore[invalid-method-override]
        """异步入口（`ainvoke` / `astream`）—— chat-ui 的 `/api/chat` 走这条。

        框架在这里**没有**复用同步实现，是独立的一份 async 加载逻辑，
        所以必须单独覆写，否则过滤形同虚设。
        """
        return self._apply(
            await super().abefore_agent(self._without_cache(state), runtime, config)
        )


# `_read_skill_summary` 已删除：技能简介统一由 `skills_admin` 解析 frontmatter
# 得到（面板 / 右侧 Context 面板共用同一处，避免两边对「简介是什么」判断不一致）。

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
- Local **knowledge base** tools (semantic search over unstructured documents):
  - read (allowed): `kb_search`, `kb_list_documents`
  - write (approval required): `kb_ingest`, `kb_delete_document`
- Persistent memory at `/chat-ui/AGENTS.md` (already loaded, do not re-read it)
- `write_todos`: plan and track a multi-step task (the user watches the list live in a panel)

## Task Planning with `write_todos` (IMPORTANT)
- **A complex, multi-step task MUST be planned with `write_todos` before you start working.**
  Treat a task as complex when it needs **3 or more distinct steps** — for example: statistics
  across several entities, an analysis that combines multiple queries, a batch of writes, research
  from several sources, or "analyze this and then write a report file".
- Call `write_todos` **once at the very start** to lay out the steps, then call it again every time
  the status changes: mark the step you are working on `in_progress`, and mark a step `completed`
  **the moment it is actually finished** — never batch several finished steps and mark them all at
  the end.
- **The user watches this list live in a panel at the bottom of the chat.** Keep it truthful:
  never mark a step `completed` before it is really done, never finish a complex task with steps
  left `pending`, and never leave a finished step stuck at `in_progress`.
- For a simple question or a single-step lookup, **do NOT use `write_todos`** — just answer directly.

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

## Local Knowledge Base (IMPORTANT)
- There is a **local knowledge base** (SQLite + vector search, Embedding by Qwen3-Embedding-0.6B)
  holding unstructured documents: manuals, specs, policies, long-form notes. It is **not** for
  structured business data — leads/orders/products always go through the `crm_*` tools.
- Read (allowed — runs immediately):
  - `kb_search(query, top_k, doc_id, tags)` — **semantic** search, returns the most relevant
    passages together with their source document and similarity score. Ask in plain natural
    language (「标准版一年多少钱」), never keyword soup.
  - `kb_list_documents()` — list every document with chunk counts and tags. Use it when
    `kb_search` finds nothing, to see what the base actually contains.
- Write (a human approval card pops up; just call the tool normally, the system pauses for approval):
  - `kb_ingest(path, title, tags)` — chunk + vectorize a file or directory into the base.
    Re-importing an unchanged file is skipped automatically (zero cost), so it is safe to re-run.
  - `kb_delete_document(doc_id)` — remove a document and all of its chunks.
- **Use `kb_search` whenever the user asks about documents, manuals, specifications, policies, or
  says "知识库".** Prefer it over `read_file` / `grep` for finding *meaning* in documents —
  vector search matches paraphrases, exact keyword matching does not.
- **Ground every knowledge-base answer in the retrieved passages and name the source document**
  (e.g. 「根据《部署指南》…」). Name the document **title**, never its file path.
- If nothing relevant was retrieved, say so plainly and suggest `kb_list_documents`, instead of
  answering from general knowledge as if it had come from the base.
- Pass `path` using the same `/`-prefixed virtual paths as the other filesystem tools.

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
    # 被关闭的技能已从技能清单里过滤掉（模型看不到），这里再显式说一句，
    # 防止模型凭历史上下文里的旧印象去找它的 SKILL.md（那条路会被硬拦截）。
    disabled_skills = sorted(eff.get("disabled_skills") or [])
    if disabled_skills:
        base = base + (
            "\n\n## Disabled Skills (IMPORTANT)\n"
            "The administrator has disabled the following skills. They are NOT available: "
            "do not follow their instructions and do not try to read their SKILL.md files:\n"
            + ", ".join(f"`{n}`" for n in disabled_skills)
        )
    return base


def build_agent(use_search: bool = False, auto_approve: bool = False, model_id: str | None = None):
    """按「Agent 控制面板」的最新配置构建 Agent。

    每次请求都重建，使面板改动（工具开关 / 权限档 / 系统提示词 / 技能开关 / 模型）即时生效：
      1. 模型：按 ``model_id``（对话界面下拉框选择）取实例，为空则用当前选中模型；
      2. 工具清单：按「启用开关」过滤，被关闭的工具不再对模型可见；
      3. 权限策略：刷新中间件的 禁止 / 关闭 / 审批 / 放行 集合；
      4. 系统提示词：面板覆盖（若有）并追加「已关闭工具 / 已关闭技能」说明；
      5. 技能：用 `SkillsControlMiddleware` 按开关过滤技能清单。

    ``auto_approve=True``（Agent 定时任务 / 测试执行）时用独立的审批中间件实例，
    自动批准审批档工具，避免无人值守下 interrupt 阻塞。
    """
    eff = agent_effective()

    # 0) 模型：解析本轮使用的实例（未知 / 已关闭的 id 会回落到当前选中模型）
    resolved_model_id, chat_model = _resolve_model(model_id)

    # 1) 工具清单：按开关过滤本地工具
    tools = [
        t for t in base_tools
        if eff["settings"].get(t.name, {}).get("enabled", True)
    ]
    if use_search and eff["settings"].get("web_search", {}).get("enabled", True):
        tools = tools + search_tool

    # 外部 MCP 工具（必应搜索等）：已加载且面板开启的才加入
    mcp_extra = [
        t for t in mcp_tools.get_mcp_tools()
        if eff["settings"].get(t.name, {}).get("enabled", True)
    ]
    if mcp_extra:
        tools = tools + mcp_extra

    # 飞书渠道工具：渠道开启 + 面板工具开启 才加入（渠道关闭则飞书工具对模型不可见）
    feishu_extra = [
        t for t in feishu_active_tools()
        if eff["settings"].get(t.name, {}).get("enabled", True)
    ]
    if feishu_extra:
        tools = tools + feishu_extra

    # 2) 刷新中间件运行时策略（定时任务用独立实例，自动批准审批档工具）
    if auto_approve:
        approval_mw = FsApprovalMiddleware(auto_approve=True)
        approval_mw.refresh(eff)
    else:
        approval_mw = fs_approval_middleware
        approval_mw.refresh(eff)

    # 3) 技能：**不**走 `skills=` 参数（那会用框架原生的、无开关的 SkillsMiddleware），
    #    改成自己塞一个带开关的版本进中间件栈。标签按 `SKILL_SOURCES` 显式给出，
    #    系统提示词的「Sources」一节就能显示 Built-in / Chat UI 这些可读名字。
    skills_middleware = SkillsControlMiddleware(
        backend=backend,
        sources=list(SKILL_SOURCES),
        disabled=set(eff.get("disabled_skills") or []),
    )

    return create_deep_agent(
        model=chat_model,
        backend=backend,
        permissions=permissions,
        checkpointer=checkpointer,
        store=store,
        subagents=subagents,
        skills=None,
        memory=["/chat-ui/AGENTS.md"],
        tools=tools,
        middleware=(approval_mw, skills_middleware),
        system_prompt=_effective_system_prompt(eff),
    )

# --- Agent 定时任务：执行 + 调度循环 ---
def _extract_final_text(result: dict) -> str:
    """从 ainvoke 结果里取最后一条 AI 消息正文。"""
    msgs = result.get("messages", []) if isinstance(result, dict) else []
    for m in reversed(msgs):
        if isinstance(m, AIMessage) and getattr(m, "content", ""):
            return str(m.content)
    return "(无文本输出)"


async def _invoke_prompt(prompt: str, thread_id: str | None = None) -> dict:
    """用指定提示词开新会话执行一次 Agent，返回 {ok, text|error}。

    默认每次调用使用全新 thread_id（新会话）；传入 ``thread_id`` 可复用会话
    （如飞书渠道按 chat_id 映射，保持同一飞书会话的连续上下文）。
    自动批准审批档工具，避免无人值守下 interrupt 卡死。
    """
    agent = build_agent(auto_approve=True)
    if not thread_id:
        thread_id = f"thread_adhoc_{uuid.uuid4().hex[:8]}"
    try:
        result = await agent.ainvoke(
            {"messages": [HumanMessage(content=prompt)]},
            config={"configurable": {"thread_id": thread_id}},
        )
        return {"ok": True, "text": _extract_final_text(result)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _is_once(task: dict) -> bool:
    """once（一次后停用）仅对「定时执行」有意义；周期执行天然重复。"""
    return task.get("trigger_type") == "daily" and task.get("frequency") == "once"


def _task_next_run(task: dict) -> str:
    return scheduler.compute_next_run(task["trigger_type"], task["hour"], task["minute"],
                                      task["weekdays_only"])


async def _execute_task(task_id: str) -> None:
    """执行一次定时任务并回写结果（success / error + 推进 next_run）。"""
    task = scheduler.get_task(task_id)
    if not task:
        return
    is_once = _is_once(task)
    res = await _invoke_prompt(task["prompt"])
    nxt = None if is_once else _task_next_run(task)
    scheduler.mark_run(task_id, "success" if res["ok"] else "error",
                       res.get("text") or res.get("error", ""), nxt, disable=is_once)


async def _scheduler_loop() -> None:
    """后台调度循环：每 20 秒扫一次到期任务并异步执行。"""
    while True:
        try:
            for task in scheduler.get_due_tasks():
                is_once = _is_once(task)
                # 占位：立即推进 next_run（once 任务则直接停用），防止执行期间被重复拾取
                nxt = None if is_once else _task_next_run(task)
                scheduler.mark_run(task["id"], "running", "", nxt, disable=is_once)
                asyncio.create_task(_execute_task(task["id"]))
        except Exception as e:  # noqa: BLE001
            print(f"[scheduler] 调度循环异常: {e}")
        await asyncio.sleep(20)


# --- 飞书渠道：接收消息闭环（落库 → Agent 处理 → 回复发回飞书） ---
FEISHU_INBOX_ID = "feishu_inbox"


def _ensure_feishu_inbox() -> None:
    """确保「飞书消息」聚合会话存在（前端会话列表可见）。"""
    db = get_db()
    row = db.execute("SELECT id FROM sessions WHERE id = ?", (FEISHU_INBOX_ID,)).fetchone()
    if not row:
        now = datetime.now().isoformat()
        db.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, pinned) VALUES (?, ?, ?, ?, 0)",
            (FEISHU_INBOX_ID, "飞书消息", now, now),
        )
        db.commit()
    db.close()


def _append_feishu_message(role: str, content: str) -> None:
    """往「飞书消息」聚合会话追加一条消息。"""
    db = get_db()
    now = datetime.now().isoformat()
    db.execute(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), FEISHU_INBOX_ID, role, content, now),
    )
    db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, FEISHU_INBOX_ID))
    db.commit()
    db.close()


async def _handle_feishu_message(info: dict) -> None:
    """处理一条飞书消息：落库 → Agent 处理 → 落库回复 → 发回飞书。"""
    chat_id = info.get("chat_id", "")
    text = (info.get("text") or "").strip()
    if not text:
        return
    sender = info.get("sender_id") or info.get("sender_type") or "飞书"
    _ensure_feishu_inbox()
    _append_feishu_message("user", f"[飞书·{sender}] {text}")

    # Agent 处理：同一飞书会话用稳定 thread_id 保持连续上下文
    res = await _invoke_prompt(text, thread_id=f"feishu_{chat_id}" if chat_id else None)
    reply = (res.get("text") or res.get("error") or "").strip()
    if reply:
        _append_feishu_message("assistant", reply)
    if chat_id and reply:
        try:
            out = feishu_tools.feishu_send_message.func(chat_id, reply, "chat_id")
            print(f"[feishu] 回复结果: {out}")
        except Exception as e:  # noqa: BLE001
            print(f"[feishu] 回复异常: {e}")


async def _feishu_worker() -> None:
    """消费飞书消息队列，异步交给 Agent 处理。"""
    loop = asyncio.get_running_loop()
    while True:
        try:
            info = await loop.run_in_executor(None, feishu_tools.message_queue.get)
        except Exception:  # noqa: BLE001
            await asyncio.sleep(1)
            continue
        try:
            await _handle_feishu_message(info)
        except Exception as e:  # noqa: BLE001
            print(f"[feishu] 消息处理异常: {e}")


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
    # Migration: 会话归属（谁创建的会话）。用于「按用户统计 token 消耗」。
    # ⚠️ 与 agent 数据范围共用同一套身份字段（前端 useAuth 传过来的）。
    # 历史会话没有归属 → 落到「未知用户」，不追溯。
    for _col, _ddl in (
        ("owner_phone", "TEXT NOT NULL DEFAULT ''"),
        ("owner_name", "TEXT NOT NULL DEFAULT ''"),
        ("owner_role_id", "TEXT NOT NULL DEFAULT ''"),
        ("owner_role_name", "TEXT NOT NULL DEFAULT ''"),
    ):
        if _col not in cols:
            conn.execute(f"ALTER TABLE sessions ADD COLUMN {_col} {_ddl}")
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
    # Migration: 助手消息携带的数据卡片（render_card 的 artifact），JSON 数组文本。
    # 为空表示该消息没有卡片；历史库自动补列，无需重建。
    cursor = conn.execute("PRAGMA table_info(messages)")
    msg_cols = [row[1] for row in cursor.fetchall()]
    if 'cards' not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN cards TEXT NOT NULL DEFAULT ''")
    # Migration: 助手消息携带的任务清单（write_todos 的最终快照），JSON 数组文本。
    # 为空表示该轮没有清单；历史库自动补列，无需重建。
    if 'todos' not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN todos TEXT NOT NULL DEFAULT ''")
    # Migration: 用户消息携带的图片 id 列表（JSON 数组文本）。
    # 图片实体存 chat_images 表，这里只存引用；为空表示该消息没有图片。
    if 'image_ids' not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN image_ids TEXT NOT NULL DEFAULT ''")
    # Migration: 用户消息携带的**文件附件** id 列表（JSON 数组文本）。
    # 文件实体存 chat_files 表，这里只存引用；为空表示该消息没有附件。
    if 'file_ids' not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN file_ids TEXT NOT NULL DEFAULT ''")
    # Migration: 该条助手消息是否由 **vision 守卫** 生成（未真正调用模型）。
    # ⚠️ 必须标记：守卫话术「当前模型不支持图片识别」若作为正常历史回复进入下一轮，
    #    会让模型被自己带偏 —— 用户切到支持图片的模型再发图时，模型会顺着
    #    历史里那句"我看不到图"继续拒答（详见 /api/chat 历史重建处的注释）。
    if 'is_guard' not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN is_guard INTEGER NOT NULL DEFAULT 0")
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
    # Migration: 指标行的**归属冗余**。刻意不从 sessions JOIN 取（那样会话删掉归属就丢了），
    # 且按用户聚合不用 JOIN，SQL 更简单。⚠️ 与 sessions 的 owner_* 写入时同步。
    cursor = conn.execute("PRAGMA table_info(agent_metrics)")
    m_cols = [row[1] for row in cursor.fetchall()]
    for _col, _ddl in (
        ("owner_phone", "TEXT NOT NULL DEFAULT ''"),
        ("owner_name", "TEXT NOT NULL DEFAULT ''"),
        ("owner_role_id", "TEXT NOT NULL DEFAULT ''"),
        ("owner_role_name", "TEXT NOT NULL DEFAULT ''"),
    ):
        if _col not in m_cols:
            conn.execute(f"ALTER TABLE agent_metrics ADD COLUMN {_col} {_ddl}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_metrics_owner ON agent_metrics(owner_phone)"
    )
    conn.commit()
    conn.close()


def _owner_field(owner: dict, *names: str) -> str:
    """从一个归属 dict 里取字段，兼容 ``phone``/``user_phone`` 两种命名。

    ⚠️ 项目里有两套命名：HTTP 请求体用 ``user_phone``（前端字段名），
    内部 dict 用 ``phone``。曾因只认一种而**静默丢掉归属**（写入空串，统计全落
    「未知用户」，且不报错）—— 所以这里两种都认，避免调用方踩坑。
    """
    for n in names:
        v = owner.get(n)
        if v:
            return str(v)
    return ""


def _normalize_owner(owner: dict | None) -> dict:
    """把任意来源的归属 dict 归一成 ``{phone, name, role_id, role_name}``。"""
    owner = owner or {}
    return {
        "phone": _owner_field(owner, "phone", "user_phone"),
        "name": _owner_field(owner, "name", "user_name"),
        "role_id": _owner_field(owner, "role_id"),
        "role_name": _owner_field(owner, "role_name"),
    }


def record_metric(
    session_id: str,
    latency_ms: float,
    ok: bool,
    usage: dict | None = None,
    model: str = "",
    owner: dict | None = None,
) -> None:
    """写入一轮对话的指标（失败容忍：统计不应影响主流程）。

    ``owner`` = ``{phone, name, role_id, role_name}``（也接受 ``user_phone``/``user_name``），
    用于「按用户统计 token 消耗」。缺省/为空 → 归属列为空串，统计时归入「未知用户」。
    """
    usage = usage or {}
    own = _normalize_owner(owner)
    try:
        db = get_db()
        db.execute(
            "INSERT INTO agent_metrics (ts, session_id, model, latency_ms, ok, prompt_tokens,"
            " completion_tokens, total_tokens, llm_calls, tool_calls, tokens_estimated, tools_json,"
            " owner_phone, owner_name, owner_role_id, owner_role_name)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                own["phone"],
                own["name"],
                own["role_id"],
                own["role_name"],
            ),
        )
        db.commit()
        db.close()
    except Exception as e:  # noqa: BLE001
        print(f"[metrics] 写入失败: {e}")


def _backfill_session_owner(session_id: str, owner: dict) -> None:
    """给「还没有归属」的会话补记归属（历史会话 / 匿名创建的会话）。

    ⚠️ 只补空，**不覆盖**已有归属 —— 否则一个会话被别的账号打开就会改写历史消耗的归属。
    失败容忍：统计不应影响主流程。
    """
    own = _normalize_owner(owner)
    if not (own["phone"] or own["name"]):
        return
    try:
        db = get_db()
        db.execute(
            "UPDATE sessions SET owner_phone = ?, owner_name = ?,"
            " owner_role_id = ?, owner_role_name = ?"
            " WHERE id = ? AND (owner_phone = '' OR owner_phone IS NULL)"
            " AND (owner_name = '' OR owner_name IS NULL)",
            (
                own["phone"],
                own["name"],
                own["role_id"],
                own["role_name"],
                session_id,
            ),
        )
        db.commit()
        db.close()
    except Exception as e:  # noqa: BLE001
        print(f"[metrics] 补记会话归属失败: {e}")

def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# --- 上下文用量（对话页底部的环形图标 + 弹窗） ---
def _context_usage(session_id: str, model_id: str, usage: dict | None = None) -> dict:
    """算出「当前会话已用上下文 / 模型最大上下文」。

    取值优先级：
      1. 本轮真实 ``prompt_tokens``（= 这轮请求送进模型的输入量，就是当前上下文占用）；
      2. 回落到该会话在 ``agent_metrics`` 里最后一条非零 ``prompt_tokens``（刷新页面 / 切会话时用）；
      3. 都没有则返回 ``used=0``。

    供应商未回传用量时 ``prompt_tokens`` 会是 0，此时按字符数粗估（与面板口径一致）。
    """
    used = 0
    estimated = False
    usage = usage or {}
    used = int(usage.get("prompt_tokens") or 0)
    if used <= 0:
        # 估算口径：本轮 total_tokens 里减去输出，剩余近似为输入
        total = int(usage.get("total_tokens") or 0)
        completion = int(usage.get("completion_tokens") or 0)
        if total > completion:
            used = total - completion
            estimated = True
    if used <= 0:
        try:
            db = get_db()
            row = db.execute(
                "SELECT prompt_tokens, tokens_estimated FROM agent_metrics"
                " WHERE session_id = ? AND prompt_tokens > 0"
                " ORDER BY id DESC LIMIT 1",
                (session_id,),
            ).fetchone()
            db.close()
            if row:
                used = int(row["prompt_tokens"] or 0)
                estimated = bool(row["tokens_estimated"])
        except Exception as e:  # noqa: BLE001
            print(f"[context] 读取历史用量失败: {e}")

    meta = model_config.get_model(model_id) or {}
    limit = int(meta.get("context_length") or 0)
    # 兜底：模型未配置上下文长度时按 1M 处理，避免前端除零
    if limit <= 0:
        limit = 1024 * 1024
    used = max(0, used)
    ratio = min(1.0, used / limit) if limit else 0.0
    return {
        "session_id": session_id,
        "model": model_id,
        "used_tokens": used,
        "max_tokens": limit,
        "ratio": round(ratio, 6),
        "percent": round(ratio * 100, 2),
        "estimated": bool(estimated),
    }

# --- Pydantic Models ---
class CreateSessionRequest(BaseModel):
    title: str = "New Chat"
    # 会话归属（谁建的）。用于「按用户统计 token 消耗」；缺省 → 未知用户。
    user_phone: str = ""
    user_name: str = ""
    role_id: str = ""
    role_name: str = ""

class SendMessageRequest(BaseModel):
    session_id: str
    content: str
    use_search: bool = False
    # 对话界面底部下拉框选中的模型；为空则用注册表当前选中模型
    model: str = ""
    # 本消息附带的图片 id 列表（先经 POST /api/images 上传得到）
    image_ids: list[str] = []
    # 本消息附带的**文件附件** id 列表（先经 POST /api/files 上传得到）
    file_ids: list[str] = []
    # --- 调用方身份（由 CRM 前端带上，用于计算 Agent 的数据读写范围）---
    # 前端只负责声明「我是谁」，具体权限一律由服务端读 roles.json 自行判定，
    # 避免前端直接传 scope 被篡改。缺省时按「全部」处理（等价于老行为，向后兼容）。
    user_phone: str = ""
    user_name: str = ""
    role_id: str = ""
    role_name: str = ""

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

class KbDeleteRequest(BaseModel):
    doc_ids: list[str] = []

class ScheduleCreateRequest(BaseModel):
    name: str
    prompt: str
    trigger_type: str = "daily"  # daily（定时执行）/ interval（周期执行）
    hour: int
    minute: int
    frequency: str = "repeat"  # 仅 daily 用：repeat（重复）/ once（一次）
    weekdays_only: bool = False

class ScheduleUpdateRequest(BaseModel):
    name: str
    prompt: str
    trigger_type: str = "daily"
    hour: int
    minute: int
    frequency: str = "repeat"
    weekdays_only: bool = False

class ScheduleEnabledRequest(BaseModel):
    enabled: bool

class RunPromptRequest(BaseModel):
    prompt: str

# --- App ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    image_store.init_table()
    file_store.init_table()
    scheduler.init_table()
    # 启动时预加载外部 MCP 工具（bing-cn-mcp 等）；失败自动降级，不阻塞服务
    await mcp_tools.load_mcp_tools()
    global checkpointer, store
    # Persistent store (semantic/long-term memory) backed by SQLite
    import sqlite3
    _conn = sqlite3.connect(str(AGENT_STATE_DB), check_same_thread=False, isolation_level=None)
    store = SqliteStore(_conn)
    # Persistent async checkpointer (agent graph state survives restarts)
    async with AsyncSqliteSaver.from_conn_string(str(AGENT_STATE_DB)) as ckpt:
        checkpointer = ckpt
        # 启动 Agent 定时任务调度循环（后台协程，随服务生命周期运行）
        _sched_task = asyncio.create_task(_scheduler_loop())
        # 启动飞书接收消息长连接（未配置凭证则跳过）+ 消息消费 worker
        _feishu_task = None
        if feishu_tools.start_receiver():
            _feishu_task = asyncio.create_task(_feishu_worker())
        yield
        _sched_task.cancel()
        if _feishu_task:
            _feishu_task.cancel()
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
    own = _normalize_owner({
        "user_phone": req.user_phone, "user_name": req.user_name,
        "role_id": req.role_id, "role_name": req.role_name,
    })
    db = get_db()
    db.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at,"
        " owner_phone, owner_name, owner_role_id, owner_role_name)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session_id,
            req.title,
            now,
            now,
            own["phone"],
            own["name"],
            own["role_id"],
            own["role_name"],
        ),
    )
    db.commit()
    db.close()
    return {
        "id": session_id,
        "title": req.title,
        "created_at": now,
        "updated_at": now,
        "owner_phone": own["phone"],
        "owner_name": own["name"],
        "owner_role_id": own["role_id"],
        "owner_role_name": own["role_name"],
    }

@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str):
    db = get_db()
    db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    db.commit()
    db.close()
    # 图片是会话级资源，随会话一并清理（否则 base64 会一直占库）
    try:
        image_store.delete_images_for_session(session_id)
    except Exception as e:  # noqa: BLE001
        print(f"[images] 清理会话图片失败: {e}")
    # 文件附件同理（还会顺带删掉落盘的临时 txt）
    try:
        file_store.delete_files_for_session(session_id)
    except Exception as e:  # noqa: BLE001
        print(f"[files] 清理会话附件失败: {e}")
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

    def _json_list(row, column: str) -> list:
        """解析落库的 JSON 数组列（cards / todos）；老数据 / 脏数据一律当作空。"""
        try:
            raw = row[column]
        except (IndexError, KeyError):
            return []
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except Exception:
            return []
        return parsed if isinstance(parsed, list) else []

    return [
        {
            "id": m["id"],
            "role": m["role"],
            "content": m["content"],
            "created_at": m["created_at"],
            "cards": _json_list(m, "cards"),
            "todos": _json_list(m, "todos"),
            # 图片只回元数据（不含 base64）；前端按需用 /api/images/{id} 取原图
            "images": image_store.get_images(_json_list(m, "image_ids")),
            # 文件附件只回元数据（不含正文）；对话流按标签展示即可
            "files": file_store.get_files(_json_list(m, "file_ids")),
        }
        for m in messages
    ]


@app.get("/api/sessions/{session_id}/context")
def get_session_context(session_id: str, model: str = ""):
    """当前会话的上下文用量（刷新页面 / 切换会话时恢复环形图标）。

    可选 query ``model`` 指定所用模型；不传则取注册表的当前默认模型。
    """
    model_id = model or _active_model_id()
    try:
        if not model_config.is_enabled(model_id):
            model_id = _active_model_id()
    except Exception:  # noqa: BLE001
        model_id = _active_model_id()
    return _context_usage(session_id, model_id)


# --- 图片附件 API ---
#   POST /api/images             上传一张图（body = 原始字节，文件名 / 类型走 query）
#   GET  /api/images/{id}        取图（返回 data URL，供「对话流单独一条图片消息」渲染）
#   GET  /api/images/{id}/meta   只取元数据（不含 base64）
#   DELETE /api/images/{id}      删除一张图（用户发送前反悔时清理）
#
# 与知识库上传同一取舍：走原始字节而非 multipart，省掉 python-multipart 依赖，
# 也避免二进制在解析途中被按 UTF-8 解码弄坏。

@app.post("/api/images")
async def upload_image(request: Request, filename: str = "", session_id: str = ""):
    """上传一张图片，返回 ``{id, filename, mime, size, data_url_only_hint}``。

    图片本身不直接回传，前端只需 ``id`` 即可在发送时引用。
    """
    raw = await request.body()
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not image_store.is_allowed_mime(mime):
        raise HTTPException(
            status_code=415,
            detail=f"不支持的图片类型：{mime or '未知'}。仅支持 PNG / JPEG / WebP / GIF。",
        )
    try:
        meta = image_store.save_image(session_id or "", filename, mime, raw)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    return meta


@app.get("/api/images/{image_id}")
def get_image(image_id: str):
    """取图，返回 ``data:<mime>;base64,...``（前端直接塞进 <img src>）。"""
    img = image_store.get_image(image_id)
    if not img:
        raise HTTPException(status_code=404, detail="图片不存在")
    return {
        "id": img["id"],
        "filename": img["filename"],
        "mime": img["mime"],
        "size": img["size"],
        "data_url": f"data:{img['mime']};base64,{img['data_b64']}",
    }


@app.get("/api/images/{image_id}/meta")
def get_image_meta(image_id: str):
    img = image_store.get_image(image_id)
    if not img:
        raise HTTPException(status_code=404, detail="图片不存在")
    img.pop("data_b64", None)
    return img


@app.delete("/api/images/{image_id}")
def delete_image(image_id: str):
    n = image_store.delete_images([image_id])
    if not n:
        raise HTTPException(status_code=404, detail="图片不存在")
    return {"ok": True, "deleted": n}


# --- 文件附件 API（当前仅 txt）---
#   POST   /api/files            上传一个文本文件（body = 原始字节，文件名 / 类型走 query）
#   GET    /api/files/{id}       取元数据 + 正文（供前端预览 / 排查）
#   GET    /api/files/{id}/meta  只取元数据（不含正文，供对话流渲染标签）
#   DELETE /api/files/{id}       删除（用户发送前反悔时清理）
#
# 与图片同样的取舍：走原始字节而非 multipart，省掉 python-multipart 依赖。

@app.post("/api/files")
async def upload_file(request: Request, filename: str = "", session_id: str = ""):
    """上传一个文本文件，返回 ``{id, filename, mime, size, chars}``。

    ⚠️ 校验**按扩展名**而非 MIME：浏览器给 .txt 的 MIME 可能是
    ``text/plain`` / ``application/octet-stream`` 甚至空串，不可靠。
    """
    raw = await request.body()
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not file_store.is_allowed_filename(filename):
        raise HTTPException(
            status_code=415,
            detail=f"不支持的文件类型：{Path(filename or '').suffix or '未知'}。仅支持 .txt。",
        )
    try:
        meta = file_store.save_file(session_id or "", filename, mime, raw)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    return meta


@app.get("/api/files/{file_id}")
def get_file(file_id: str):
    """取文件（含正文）。"""
    f = file_store.get_file(file_id)
    if not f:
        raise HTTPException(status_code=404, detail="文件不存在")
    return f


@app.get("/api/files/{file_id}/meta")
def get_file_meta(file_id: str):
    """只取元数据（不含正文，避免长文本在列表接口里反复传输）。"""
    f = file_store.get_file(file_id)
    if not f:
        raise HTTPException(status_code=404, detail="文件不存在")
    f.pop("text", None)
    return f


@app.delete("/api/files/{file_id}")
def delete_file(file_id: str):
    n = file_store.delete_files([file_id])
    if not n:
        raise HTTPException(status_code=404, detail="文件不存在")
    return {"ok": True, "deleted": n}

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
        # 技能：框架标准分层来源（数组顺序 = 优先级由低到高，同名由高优先级覆盖）
        "skill_sources": [
            {"label": label, "path": vpath, "real_path": str(_skill_real_path(vpath))}
            for vpath, label in SKILL_SOURCES
        ],
        "skill_source_count": len(SKILL_SOURCES),
        # 技能目录须位于 agent 文件系统根内，模型才能 read_file 读取（见 _collect_skill_sources）
        "skill_backend": "LocalShellBackend(virtual_mode=True)（与主 backend 一致）",
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
        # ---- Skill 管理（面板「Skill 管理」Tab）----
        "skill_management": True,
        "skill_panel_endpoint": "/api/panel/skills",
        "skill_content_endpoint": "/api/panel/skills/{name}/content",
        "skill_toggle": True,
        "skill_edit": True,
        # 关闭的技能不进系统提示词，且读取其 SKILL.md 会被拦截（skill_disabled 策略）
        "skill_disabled_policy": "skill_disabled",
        "disabled_skills": sorted(fs_approval_middleware.disabled_skills),
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


class SkillEnabledRequest(BaseModel):
    enabled: bool


class SkillContentRequest(BaseModel):
    content: str


class McpEnabledRequest(BaseModel):
    enabled: bool


class McpConfigRequest(BaseModel):
    config: str


class McpAddRequest(BaseModel):
    name: str
    description: str = ""
    config: str


class ChannelEnabledRequest(BaseModel):
    enabled: bool


class ChannelCredentialsRequest(BaseModel):
    app_id: str
    app_secret: str


# --- 「模型管理」Tab + 对话界面模型下拉框 ---

class ModelEnabledRequest(BaseModel):
    enabled: bool


class ModelSelectRequest(BaseModel):
    model: str


class ModelUpsertRequest(BaseModel):
    """新增 / 更新一条模型配置。

    ``id`` 只在新增时必填；更新用路径里的 id。``api_key`` 传空串表示保持原 key。
    """
    id: str = ""
    name: str
    base_url: str
    api_key: str = ""
    vision: bool = False
    context_length: int = 1024 * 1024


class MemoryUpsertRequest(BaseModel):
    """新增 / 更新一条长期记忆（key 已存在则覆盖 value）。"""
    key: str
    value: str


class AgentsMdRequest(BaseModel):
    """保存项目记忆文件 AGENTS.md 的完整内容。"""
    content: str


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
            "model": _active_model_id(),
            "backend": "LocalShellBackend(FilesystemBackend)",
            "port": 8765,
            "pid": os.getpid(),
            "python": sys.version.split()[0],
            "started_at": PANEL_START_TS.isoformat(timespec="seconds"),
            "uptime_seconds": round((datetime.now() - PANEL_START_TS).total_seconds(), 1),
        },
        "health": {**checks, "status": "healthy" if healthy else "degraded"},
        "model": {
            "name": _active_model_id(),
            "base_url": model_config.get_base_url(_active_model_id()),
            # 未探测过时为 null，由前端调用 /api/panel/model-check 填充
            "connected": (cached or {}).get("ok"),
            "checked_at": (cached or {}).get("tested_at"),
            "latency_ms": (cached or {}).get("latency_ms"),
            "summary": model_config.get_summary(),
        },
        "usage": {"today": _metric_summary("today"), "total": _metric_summary("all")},
        "trend": _metric_trend(7),
        "config": agent_config_summary(),
    }


# ============================ token 消耗统计 ============================
# 口径说明（务必与前端展示一致）
#   - 「总量」= agent_metrics 全表 SUM，含无归属的历史行。
#   - 「按用户」= 按 (owner_phone, owner_name) 分组；无归属的历史行归入「未知用户」。
#   - ⚠️ 两者必须相等：用户明细的 total 合计 === 总量。响应里带 self_check 供前端/测试断言，
#     一旦不等说明聚合口径分叉了，要立刻查（不要静默容忍）。
UNKNOWN_OWNER_LABEL = "未知用户"


def _token_usage(scope: str = "all") -> dict:
    """统计 token 消耗：总量 + 按用户拆分。

    ``scope``: ``"today"`` 只算当天（本地时区），``"all"`` 全部。
    """
    where = "WHERE date(ts) = date('now','localtime')" if scope == "today" else ""

    db = get_db()
    # 总量
    total = db.execute(
        f"""SELECT COUNT(*) AS turns,
                   COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                   COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                   COALESCE(SUM(total_tokens), 0) AS total_tokens,
                   COALESCE(SUM(llm_calls), 0) AS llm_calls,
                   COALESCE(SUM(tool_calls), 0) AS tool_calls,
                   COALESCE(SUM(tokens_estimated), 0) AS estimated_turns,
                   COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
            FROM agent_metrics {where}"""
    ).fetchone()

    # 按用户聚合。⚠️ 归属为空的归入「未知用户」，**不能过滤掉** —— 否则合计会小于总量。
    rows = db.execute(
        f"""SELECT owner_phone, owner_name, owner_role_name,
                   COUNT(*) AS turns,
                   COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                   COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                   COALESCE(SUM(total_tokens), 0) AS total_tokens,
                   COALESCE(SUM(llm_calls), 0) AS llm_calls,
                   COALESCE(SUM(tool_calls), 0) AS tool_calls,
                   MAX(ts) AS last_ts
            FROM agent_metrics {where}
            GROUP BY owner_phone, owner_name
            ORDER BY total_tokens DESC"""
    ).fetchall()
    db.close()

    grand_total = int(total["total_tokens"] or 0)
    users: list[dict] = []
    # 角色额度表（按 role_name 索引），用于给每个用户标注「本月额度 / 已用」。
    # ⚠️ 「累计」口径下展示的是**本月**额度进度（额度本身就是月度的），
    #    因此这里按「本月已用」单独取数，不与 scope 的累计值混用。
    quota_by_role: dict[str, int] = {}
    for _r in crm_permissions.list_roles():
        quota_by_role[str(_r.get("name", ""))] = crm_permissions.role_monthly_quota(_r)

    for r in rows:
        phone = str(r["owner_phone"] or "")
        name = str(r["owner_name"] or "")
        role_name = str(r["owner_role_name"] or "")
        known = bool(phone or name)
        tok = int(r["total_tokens"] or 0)
        # 本月用量（额度判定口径），仅对已知用户有意义
        month_used = monthly_used_tokens(phone, name) if known else 0
        role_quota = quota_by_role.get(role_name, crm_permissions.DEFAULT_MONTHLY_TOKEN_QUOTA)
        unlimited = role_quota <= 0
        q_ratio = (month_used / role_quota) if role_quota > 0 else 0.0
        users.append({
            "phone": phone,
            "name": name if known else UNKNOWN_OWNER_LABEL,
            "role_name": role_name,
            "known": known,
            "turns": int(r["turns"] or 0),
            "prompt_tokens": int(r["prompt_tokens"] or 0),
            "completion_tokens": int(r["completion_tokens"] or 0),
            "total_tokens": tok,
            "llm_calls": int(r["llm_calls"] or 0),
            "tool_calls": int(r["tool_calls"] or 0),
            "last_ts": r["last_ts"],
            # 占比按总量算，前端直接用来画占比条
            "percent": round(tok / grand_total * 100, 2) if grand_total else 0.0,
            # ---- 月度额度（每人各自）----
            "month_used": month_used,
            "quota": role_quota,
            "quota_ratio": round(q_ratio, 4),
            "quota_percent": round(q_ratio * 100, 2),
            "quota_unlimited": unlimited,
            "quota_exceeded": (not unlimited) and month_used >= role_quota,
        })

    # 排序：已知用户按消耗降序在前，「未知用户」固定沉底（它是历史残留，不该抢视线）
    users.sort(key=lambda u: (not u["known"], -u["total_tokens"]))

    users_sum = sum(u["total_tokens"] for u in users)
    return {
        "scope": scope,
        "totals": {
            "turns": int(total["turns"] or 0),
            "prompt_tokens": int(total["prompt_tokens"] or 0),
            "completion_tokens": int(total["completion_tokens"] or 0),
            "total_tokens": grand_total,
            "llm_calls": int(total["llm_calls"] or 0),
            "tool_calls": int(total["tool_calls"] or 0),
            "estimated_turns": int(total["estimated_turns"] or 0),
            "errors": int(total["errors"] or 0),
        },
        "users": users,
        "user_count": len([u for u in users if u["known"]]),
        # 自检：用户合计 vs 总量。正常必须 delta=0
        "self_check": {
            "users_sum": users_sum,
            "grand_total": grand_total,
            "delta": users_sum - grand_total,
            "consistent": users_sum == grand_total,
        },
    }


# --------------------------------------------------------------------------
# 月度额度（按用户角色限制每月 token 使用量）
# --------------------------------------------------------------------------
#   语义：角色上的 monthlyTokenQuota 是**该角色下每个用户各自**的月额度。
#   用量口径：agent_metrics 里 owner_phone 命中且落在**本自然月**（北京时间）的 total_tokens 之和。
#   ⚠️ 月份边界必须用北京时间：本机是 UTC，直接用 date('now') 会跨月差 8 小时。
MONTH_TZ_OFFSET = "+8 hours"


def _current_month_start() -> str:
    """本自然月的起点（北京时间，`YYYY-MM-01`）。"""
    # 以 SQLite 的 localtime 为基准不可靠（本机 UTC），显式加 8 小时换算北京时间。
    db = get_db()
    row = db.execute(
        "SELECT strftime('%Y-%m-01', datetime('now', ?)) AS m", (MONTH_TZ_OFFSET,)
    ).fetchone()
    db.close()
    return str(row["m"])


def monthly_used_tokens(phone: str, name: str = "") -> int:
    """某用户**本月**消耗的 token 合计（北京自然月）。

    归属匹配：``owner_phone`` 优先；电话为空时用 ``owner_name`` 兜底
    （历史行/未带电话的场景）。
    """
    p = str(phone or "").strip()
    n = str(name or "").strip()
    if not p and not n:
        return 0
    month_start = _current_month_start()
    db = get_db()
    if p:
        row = db.execute(
            "SELECT COALESCE(SUM(total_tokens), 0) AS t FROM agent_metrics"
            " WHERE owner_phone = ? AND substr(datetime(ts, ?), 1, 10) >= ?",
            (p, MONTH_TZ_OFFSET, month_start),
        ).fetchone()
    else:
        row = db.execute(
            "SELECT COALESCE(SUM(total_tokens), 0) AS t FROM agent_metrics"
            " WHERE owner_phone = '' AND owner_name = ? AND substr(datetime(ts, ?), 1, 10) >= ?",
            (n, MONTH_TZ_OFFSET, month_start),
        ).fetchone()
    db.close()
    return int(row["t"] or 0)


def resolve_quota(scope_info: dict) -> dict:
    """把「角色额度」与「本月已用」合成一个可判定/可展示的结构。

    返回：
        {
          "quota": int,        # 月额度（0 = 不限额）
          "used": int,         # 本月已用
          "remaining": int,    # 剩余（不限额时为 -1，语义为「无限」）
          "ratio": float,      # used / quota（0-1+），不限额时 0
          "percent": float,    # 百分比
          "unlimited": bool,
          "exceeded": bool,    # 是否已超限（不限额永远 False）
          "role_name": str,
        }
    """
    quota = int(scope_info.get("monthly_token_quota") or 0)
    phone = scope_info.get("user_phone") or ""
    name = scope_info.get("user_name") or ""
    used = monthly_used_tokens(phone, name)
    unlimited = quota <= 0
    ratio = (used / quota) if quota > 0 else 0.0
    return {
        "quota": quota,
        "used": used,
        "remaining": -1 if unlimited else max(0, quota - used),
        "ratio": round(ratio, 4),
        "percent": round(ratio * 100, 2),
        "unlimited": unlimited,
        "exceeded": (not unlimited) and used >= quota,
        "role_name": scope_info.get("role_name") or "",
    }


QUOTA_EXCEEDED_TEXT = "当前额度已用完，联系管理员申请额度"


async def _quota_refuse_stream(session_id: str, text: str, model_id: str) -> AsyncGenerator[str, None]:
    """额度守卫：落库两轮消息（用户 + 助手话术），本轮流式返回固定文案，**不调模型**。

    ⚠️ 与 vision 守卫同范式：整轮打 ``is_guard=1``，避免这条「被拒绝」的话术
       进后续历史把模型带偏（详见 is_guard 注释）。
    """
    now_str = datetime.now().isoformat()
    db = get_db()
    try:
        user_msg_id = str(uuid.uuid4())
        ai_msg_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO messages"
            " (id, session_id, role, content, created_at, is_guard)"
            " VALUES (?, ?, ?, ?, ?, 1)",
            (user_msg_id, session_id, "user", "", now_str),
        )
        db.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at, is_guard)"
            " VALUES (?, ?, ?, ?, ?, 1)",
            (ai_msg_id, session_id, "assistant", text, now_str),
        )
        db.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?", (now_str, session_id)
        )
        db.commit()
    finally:
        db.close()

    def _emit(payload: dict) -> str:
        payload["ts"] = datetime.now().isoformat()
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    yield _emit({"event": "llm_token", "token": text})
    yield _emit(
        {
            "event": "done",
            "done": True,
            "message_id": ai_msg_id,
            "context": _context_usage(session_id, model_id),
        }
    )


@app.get("/api/panel/token-usage")
def panel_token_usage(scope: str = "all"):
    """token 消耗统计：总量 + 按用户拆分。

    ``scope``: ``all``（默认，累计） / ``today``（今日）。
    """
    if scope not in ("all", "today"):
        raise HTTPException(status_code=422, detail="scope 只能是 all 或 today")
    return _token_usage(scope)


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
            _resolve_model(None)[1].ainvoke([HumanMessage(content="ping")]), timeout=25
        )
        content = getattr(resp, "content", "")
        reply = content if isinstance(content, str) else str(content)
    except Exception as e:  # noqa: BLE001
        ok, err = False, str(e)
    result = {
        "ok": ok,
        "model": _active_model_id(),
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
    """一键恢复默认：系统提示词 + 全部工具开关与权限 + 全部技能开关。"""
    reset_agent_config()
    fs_approval_middleware.refresh(agent_effective())
    return _panel_config_payload()


# --------------------------------------------------------------------------
# Skill 管理（面板「Skill 管理」Tab）
# --------------------------------------------------------------------------
#   GET /api/panel/skills                技能清单（含开关、来源、校验结果）
#   PUT /api/panel/skills/{name}         开 / 关一个技能
#   GET /api/panel/skills/{name}/content 读 SKILL.md 原文
#   PUT /api/panel/skills/{name}/content 改 SKILL.md 原文（校验 → 备份 → 原子写）
#
# 技能的**目录**不可增删（面板只做「开关 + 改内容」）；清单每次请求实时扫盘，
# 因为技能是往目录里放文件就能生效的，没有注册表可查。

def _panel_skills_payload() -> dict:
    """技能清单 + 汇总（扫盘结果 × 配置里的开关）。"""
    cat = skill_catalog(_admin_skill_sources(), get_skill_overrides())
    summary = cat["summary"]
    summary["updated_at"] = agent_effective()["updated_at"]
    return {
        "skills": cat["skills"],
        "summary": summary,
        "backup_dir": str(SKILL_BACKUP_DIR),
        "limit_bytes": MAX_EDITABLE_BYTES,
    }


@app.get("/api/panel/skills")
def panel_list_skills():
    return _panel_skills_payload()


@app.put("/api/panel/skills/{name}")
def panel_set_skill_enabled(name: str, req: SkillEnabledRequest):
    try:
        # 先确认技能真的存在（在配置里存一个不存在的名字没有任何意义）
        skill_find(name, _admin_skill_sources())
        set_skill_enabled(name, req.enabled)
    except UnknownSkillError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SkillNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    # 拦截「读被关闭技能的 SKILL.md」的中间件是常驻单例，改完开关立刻刷新，
    # 不必等下一轮 build_agent
    fs_approval_middleware.refresh(agent_effective())
    payload = _panel_skills_payload()
    return {
        "ok": True,
        "skill": next((s for s in payload["skills"] if s["name"] == name), None),
        "summary": payload["summary"],
    }


@app.get("/api/panel/skills/{name}/content")
def panel_get_skill_content(name: str):
    try:
        entry = skill_read_content(name, _admin_skill_sources())
    except SkillNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except SkillValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "name": entry["name"],
        "content": entry["content"],
        "path": entry["path"],
        "virtual_path": entry["virtual_path"],
        "source": entry["source"],
        "builtin": entry["builtin"],
        "size": entry["size"],
        "chars": entry["chars"],
        "lines": entry["lines"],
        "mtime": entry["mtime"],
        "problems": entry["problems"],
        "warnings": entry["warnings"],
        "backup_dir": str(SKILL_BACKUP_DIR),
        "limit_bytes": MAX_EDITABLE_BYTES,
    }


@app.put("/api/panel/skills/{name}/content")
def panel_put_skill_content(name: str, req: SkillContentRequest):
    try:
        saved = skill_write_content(
            name, req.content, _admin_skill_sources(), SKILL_BACKUP_DIR
        )
    except SkillNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except SkillValidationError as e:
        # 422 而非 400：语义是「内容本身不合法，请按 problems 改」
        raise HTTPException(status_code=422, detail={"message": str(e), "problems": e.problems})
    except SkillError as e:
        raise HTTPException(status_code=400, detail=str(e))
    payload = _panel_skills_payload()
    return {
        "ok": True,
        "skill": next((s for s in payload["skills"] if s["name"] == name), None),
        "summary": payload["summary"],
        "warnings": saved.get("warnings", []),
        "backup_dir": saved.get("backup_dir"),
    }


# --------------------------------------------------------------------------
# MCP 管理（面板「MCP 管理」Tab）
# --------------------------------------------------------------------------
#   GET    /api/panel/mcps                  MCP 清单（名称 / 介绍 / 传输 / 开关 / 工具 / 加载错误）
#   POST   /api/panel/mcps                  新增一个 MCP（名称 + 简介 + 完整 JSON 串，保存后关闭）
#   PUT    /api/panel/mcps/{name}           开 / 关一个 MCP（开启会做错误检查，失败保持关闭）
#   DELETE /api/panel/mcps/{name}           删除一个 MCP（删除时关闭）
#   GET    /api/panel/mcps/{name}/config    读完整定义 JSON 原文（编辑弹窗用）
#   PUT    /api/panel/mcps/{name}/config    存完整定义 JSON（校验 → 保存 → 自动关闭）
#   POST   /api/panel/mcps/reset            恢复全部 MCP 默认（开关 + 连接配置，清掉自定义）
#
# MCP 清单来自持久化注册表（见 mcp_tools.py）：内置种子 + 用户增删改，全部落 mcp_config.json。

def _panel_mcps_payload() -> dict:
    servers = mcp_tools.get_mcp_servers()
    total = len(servers)
    enabled = sum(1 for s in servers if s["enabled"])
    return {
        "mcps": servers,
        "summary": {
            "total": total,
            "enabled": enabled,
            "disabled": total - enabled,
            "tool_count": sum(s["tool_count"] for s in servers),
        },
    }


@app.get("/api/panel/mcps")
def panel_list_mcps():
    return _panel_mcps_payload()


@app.post("/api/panel/mcps")
def panel_add_mcp(req: McpAddRequest):
    try:
        mcp_tools.add_mcp(req.name, req.description, req.config)
    except mcp_tools.McpNameError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except mcp_tools.McpConfigError as e:
        raise HTTPException(status_code=422, detail={"message": str(e), "problems": e.problems})
    payload = _panel_mcps_payload()
    return {
        "ok": True,
        "mcp": next((s for s in payload["mcps"] if s["name"] == req.name.strip()), None),
        "summary": payload["summary"],
    }


@app.put("/api/panel/mcps/{name}")
async def panel_set_mcp_enabled(name: str, req: McpEnabledRequest):
    if not req.enabled:
        try:
            mcp_tools.set_mcp_enabled(name, False)
        except mcp_tools.UnknownMcpError as e:
            raise HTTPException(status_code=404, detail=str(e))
        result = {"ok": True, "load_error": None}
    else:
        try:
            result = await mcp_tools.enable_mcp(name)
        except mcp_tools.UnknownMcpError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except mcp_tools.McpConfigError as e:
            raise HTTPException(status_code=422, detail={"message": str(e), "problems": e.problems})
    payload = _panel_mcps_payload()
    return {
        "ok": True,
        "mcp": next((s for s in payload["mcps"] if s["name"] == name), None),
        "summary": payload["summary"],
        "load_error": result.get("load_error"),
    }


@app.delete("/api/panel/mcps/{name}")
def panel_delete_mcp(name: str):
    try:
        mcp_tools.delete_mcp(name)
    except mcp_tools.UnknownMcpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _panel_mcps_payload()


@app.get("/api/panel/mcps/{name}/config")
def panel_get_mcp_config(name: str):
    try:
        text = mcp_tools.get_mcp_config_text(name)
    except mcp_tools.UnknownMcpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    meta = next((s for s in mcp_tools.get_mcp_servers() if s["name"] == name), {})
    return {"name": name, "config": text, "enabled": meta.get("enabled", True)}


@app.put("/api/panel/mcps/{name}/config")
def panel_put_mcp_config(name: str, req: McpConfigRequest):
    try:
        mcp_tools.set_mcp_config(name, req.config)
    except mcp_tools.UnknownMcpError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except mcp_tools.McpConfigError as e:
        # 422 而非 400：语义是「内容本身不合法，请按 problems 改」
        raise HTTPException(status_code=422, detail={"message": str(e), "problems": e.problems})
    payload = _panel_mcps_payload()
    return {
        "ok": True,
        "mcp": next((s for s in payload["mcps"] if s["name"] == name), None),
        "summary": payload["summary"],
    }


@app.post("/api/panel/mcps/reset")
async def panel_reset_mcps():
    mcp_tools.reset_mcp()
    await mcp_tools.reload_all_mcp()
    return _panel_mcps_payload()


# --------------------------------------------------------------------------
# 渠道管理（面板「渠道管理」Tab）
# --------------------------------------------------------------------------
def _panel_channels_payload() -> dict:
    channels = channel_config.get_channels()
    total = len(channels)
    enabled = sum(1 for c in channels if c["enabled"])
    return {
        "channels": channels,
        "summary": {"total": total, "enabled": enabled, "disabled": total - enabled},
    }


@app.get("/api/panel/channels")
def panel_list_channels():
    return _panel_channels_payload()


@app.put("/api/panel/channels/{name}/enabled")
def panel_set_channel_enabled(name: str, req: ChannelEnabledRequest):
    try:
        channel = channel_config.set_enabled(name, req.enabled)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True, "channel": channel, "summary": _panel_channels_payload()["summary"]}


@app.put("/api/panel/channels/{name}/credentials")
def panel_set_channel_credentials(name: str, req: ChannelCredentialsRequest):
    try:
        channel = channel_config.set_credentials(name, req.app_id, req.app_secret)
    except ValueError as e:
        status = 404 if "未知渠道" in str(e) else 422
        raise HTTPException(status_code=status, detail=str(e))
    return {"ok": True, "channel": channel}


# --------------------------------------------------------------------------
# 模型管理（面板「模型管理」Tab + 对话界面模型下拉框）
# --------------------------------------------------------------------------
#   注册表 = model_config.py（持久化 model_config.json，种子 3 个 DeepSeek 模型）。
#   GET    /api/panel/models              列出全部可用模型 + 汇总 + 当前选中
#   POST   /api/panel/models              新增模型（body 含 id）
#   PUT    /api/panel/models/{id}         更新模型配置（api_key 空串=保持原值）
#   PUT    /api/panel/models/{id}/enabled 开启 / 关闭
#   DELETE /api/panel/models/{id}         删除
#   PUT    /api/panel/models/selected     切换当前对话使用的模型
#   GET    /api/models                    对话界面下拉框数据源（仅启用中的模型）
# --------------------------------------------------------------------------
def _panel_models_payload() -> dict:
    return {
        "models": model_config.get_models(),
        "summary": model_config.get_summary(),
        "selected": model_config.get_selected(),
    }


@app.get("/api/panel/models")
def panel_list_models():
    return _panel_models_payload()


@app.get("/api/models")
def list_active_models():
    """对话界面底部下拉框：只返回启用中的模型，避免选中被关闭的模型。"""
    models = [m for m in model_config.get_models() if m["enabled"]]
    return {"models": models, "selected": model_config.get_selected()}


@app.get("/api/agent-scope")
def get_agent_scope(
    phone: str = "",
    name: str = "",
    role_id: str = "",
    role_name: str = "",
):
    """查询某身份在 Agent（AI 助手）侧的 CRM 数据范围。

    只为展示 / 自检用 —— 真正的范围判定始终发生在 /api/chat 里（服务端自行读
    roles.json），本端点不接受调用方直接指定 scope，所以不构成越权入口。
    """
    info = crm_permissions.resolve_agent_scope(
        phone=phone, name=name, role_id=role_id, role_name=role_name
    )
    return {
        **info,
        "description": crm_permissions.describe(info),
        # 前端可直接展示「Agent 可读哪些实体、哪些被过滤」
        "owner_scoped_entities": [
            k for k, v in crm_tools.ENTITIES.items() if v.get("owner_field")
        ],
        "public_entities": [
            k for k, v in crm_tools.ENTITIES.items() if not v.get("owner_field")
        ],
    }


@app.get("/api/agent-quota")
def get_agent_quota(
    phone: str = "",
    name: str = "",
    role_id: str = "",
    role_name: str = "",
):
    """查询某身份的**本月 token 额度**使用情况（每人各自的口径）。

    与 `/api/agent-scope` 同性质：只读展示，真正的拦截发生在 /api/chat 内部
    （服务端自行读 roles.json 与 agent_metrics），本端点不接受调用方指定额度。
    """
    info = crm_permissions.resolve_agent_scope(
        phone=phone, name=name, role_id=role_id, role_name=role_name
    )
    quota = resolve_quota(info)
    return {
        "month": _current_month_start()[:7],   # YYYY-MM
        "user_name": info.get("user_name") or "",
        "user_phone": info.get("user_phone") or "",
        "role_id": info.get("role_id") or "",
        "role_name": info.get("role_name") or "",
        **quota,
        "exceeded_text": QUOTA_EXCEEDED_TEXT,
    }



@app.post("/api/panel/models")
def panel_add_model(req: ModelUpsertRequest):
    try:
        model = model_config.upsert_model(
            model_id=req.id,
            name=req.name,
            base_url=req.base_url,
            api_key=req.api_key,
            vision=req.vision,
            context_length=req.context_length,
            create=True,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"ok": True, "model": model, "summary": model_config.get_summary()}


@app.put("/api/panel/models/selected")
def panel_select_model(req: ModelSelectRequest):
    try:
        selected = model_config.set_selected(req.model)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"ok": True, "selected": selected}


@app.put("/api/panel/models/{model_id}")
def panel_update_model(model_id: str, req: ModelUpsertRequest):
    try:
        model = model_config.upsert_model(
            model_id=model_id,
            name=req.name,
            base_url=req.base_url,
            api_key=req.api_key,
            vision=req.vision,
            context_length=req.context_length,
            create=False,
        )
    except ValueError as e:
        status = 404 if "不存在" in str(e) else 422
        raise HTTPException(status_code=status, detail=str(e))
    return {"ok": True, "model": model, "summary": model_config.get_summary()}


@app.put("/api/panel/models/{model_id}/enabled")
def panel_set_model_enabled(model_id: str, req: ModelEnabledRequest):
    try:
        model = model_config.set_enabled(model_id, req.enabled)
    except ValueError as e:
        status = 404 if "不存在" in str(e) else 422
        raise HTTPException(status_code=status, detail=str(e))
    return {
        "ok": True,
        "model": model,
        "summary": model_config.get_summary(),
        "selected": model_config.get_selected(),
    }


@app.delete("/api/panel/models/{model_id}")
def panel_delete_model(model_id: str):
    try:
        model_config.delete_model(model_id)
    except ValueError as e:
        status = 404 if "不存在" in str(e) else 422
        raise HTTPException(status_code=status, detail=str(e))
    return {"ok": True, "summary": model_config.get_summary(), "selected": model_config.get_selected()}


# --------------------------------------------------------------------------
# 记忆（面板「记忆」Tab）
# --------------------------------------------------------------------------
#   长期记忆 = store 的 ("memories",) 命名空间（store_memory / recall_memory 工具读写）；
#   项目记忆文件 = /chat-ui/AGENTS.md（MemoryMiddleware 加载注入系统提示词）。
#   GET  /api/panel/memory             列出长期记忆条目 + AGENTS.md 内容
#   POST /api/panel/memory             新增/更新一条长期记忆（{key, value}）
#   DELETE /api/panel/memory/{key}     删除一条长期记忆
#   PUT  /api/panel/memory/agents-md   保存 AGENTS.md 内容
# --------------------------------------------------------------------------

AGENTS_MD_PATH = CHAT_UI_DIR / "AGENTS.md"


def _read_agents_md() -> str:
    if AGENTS_MD_PATH.exists():
        try:
            return AGENTS_MD_PATH.read_text(encoding="utf-8")
        except OSError:
            return ""
    return ""


def _panel_memory_payload() -> dict:
    global store
    if store is None:
        return {"memories": [], "agents_md": _read_agents_md(),
                "summary": {"memories_count": 0}, "store_ready": False}
    items = store.search(("memories",), limit=500)
    memories = [{"key": it.key, "value": (it.value or {}).get("value", "")} for it in items]
    return {
        "memories": memories,
        "agents_md": _read_agents_md(),
        "summary": {"memories_count": len(memories)},
        "store_ready": True,
    }


@app.get("/api/panel/memory")
def panel_get_memory():
    return _panel_memory_payload()


@app.post("/api/panel/memory")
def panel_upsert_memory(req: MemoryUpsertRequest):
    global store
    if store is None:
        raise HTTPException(status_code=503, detail="记忆库未初始化（store 未就绪）")
    key = req.key.strip()
    value = req.value.strip()
    if not key:
        raise HTTPException(status_code=422, detail="记忆的 key 不能为空")
    if not value:
        raise HTTPException(status_code=422, detail="记忆内容不能为空")
    try:
        store.put(("memories",), key, {"value": value})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"保存记忆失败: {e}")
    return {"ok": True, "memory": {"key": key, "value": value},
            "summary": _panel_memory_payload()["summary"]}


@app.delete("/api/panel/memory/{key}")
def panel_delete_memory(key: str):
    global store
    if store is None:
        raise HTTPException(status_code=503, detail="记忆库未初始化（store 未就绪）")
    try:
        store.delete(("memories",), key)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"删除记忆失败: {e}")
    return {"ok": True, "summary": _panel_memory_payload()["summary"]}


@app.put("/api/panel/memory/agents-md")
def panel_put_agents_md(req: AgentsMdRequest):
    try:
        AGENTS_MD_PATH.write_text(req.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"保存 AGENTS.md 失败: {e}")
    return {"ok": True, "agents_md": req.content}


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
        desc = getattr(t, "description", None) or (fn.__doc__ or "")
        desc = (desc or "").strip().split("\n")[0]
        spec = eff["settings"].get(name, {})
        return {
            "name": name,
            "description": desc,
            "enabled": spec.get("enabled", True),
            "policy": spec.get("policy", "allow"),
        }

    tool_defs = [
        _tool_meta(t) for t in (base_tools + search_tool + mcp_tools.get_mcp_tools() + feishu_active_tools())
        if eff["settings"].get(getattr(t, "name", ""), {}).get("enabled", True)
    ]
    # Built-in filesystem/shell tools provided by the backend (informational)
    backend_tools = ["ls", "ls_info", "read", "write", "edit", "delete", "glob", "glob_info", "grep", "grep_raw", "execute"]
    # Skill index：扫盘结果 × 面板开关（与「Skill 管理」Tab 同一个数据源，
    # 保证右侧 Context 面板和面板里看到的清单不会对不上）
    skill_index = [
        {
            "name": s["name"],
            "path": s["path"],
            "summary": s["description"],
            "source": s["source"],
            "source_path": s["source_path"],
            "enabled": s["enabled"],
            "valid": s["valid"],
        }
        for s in skill_catalog(_admin_skill_sources(), get_skill_overrides())["skills"]
    ]
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

    # 本轮所选模型（图片能力判断与后续 build_agent 共用）
    resolved_model_id, _ = _resolve_model(req.model or None)

    # 图片附件：去重 + 条数上限，并校验确实存在
    image_ids: list[str] = []
    seen_ids: set[str] = set()
    for iid in (req.image_ids or []):
        if not isinstance(iid, str) or not iid or iid in seen_ids:
            continue
        seen_ids.add(iid)
        image_ids.append(iid)
    if image_ids:
        found = image_store.get_images(image_ids)
        # ⚠️ 不能静默丢弃无效 id：否则「图片丢失」会退化成普通文本消息偷偷发给模型
        missing = [i for i in image_ids if i not in {m["id"] for m in found}]
        if missing:
            db.close()
            raise HTTPException(
                status_code=422,
                detail=f"图片不存在或已过期：{', '.join(missing[:3])}",
            )
        image_ids = [m["id"] for m in found]
    if len(image_ids) > image_store.MAX_IMAGES_PER_MESSAGE:
        db.close()
        raise HTTPException(
            status_code=422,
            detail=f"单条消息最多附带 {image_store.MAX_IMAGES_PER_MESSAGE} 张图片",
        )

    # 文件附件：去重 + 条数上限，并校验确实存在（与图片同一套口径）
    file_ids: list[str] = []
    seen_file_ids: set[str] = set()
    for fid in (req.file_ids or []):
        if not isinstance(fid, str) or not fid or fid in seen_file_ids:
            continue
        seen_file_ids.add(fid)
        file_ids.append(fid)
    if file_ids:
        found_files = file_store.get_files(file_ids)
        # ⚠️ 同图片：不能静默丢弃无效 id，否则「附件丢失」会退化成普通文本消息偷发给模型
        missing_files = [i for i in file_ids if i not in {m["id"] for m in found_files}]
        if missing_files:
            db.close()
            raise HTTPException(
                status_code=422,
                detail=f"附件不存在或已过期：{', '.join(missing_files[:3])}",
            )
        file_ids = [m["id"] for m in found_files]
    if len(file_ids) > file_store.MAX_FILES_PER_MESSAGE:
        db.close()
        raise HTTPException(
            status_code=422,
            detail=f"单条消息最多附带 {file_store.MAX_FILES_PER_MESSAGE} 个文件",
        )

    # 模型不支持图片识别 → 落库消息 + 直接回固定话术，**不调用模型**
    vision_ok = bool((model_config.get_model(resolved_model_id) or {}).get("vision"))
    if image_ids and not vision_ok:
        now_str = datetime.now().isoformat()
        user_msg_id = str(uuid.uuid4())
        ai_msg_id = str(uuid.uuid4())
        warn_text = "当前模型不支持图片识别"
        # ⚠️ 用户消息与助手话术**都**打 is_guard：这一整轮都不该进后续历史。
        #    只跳助手那句会留下「带图用户消息 + 无回复」的孤儿轮，模型依然困惑。
        db.execute(
            "INSERT INTO messages"
            " (id, session_id, role, content, created_at, image_ids, file_ids, is_guard)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
            (
                user_msg_id,
                req.session_id,
                "user",
                req.content,
                now_str,
                json.dumps(image_ids, ensure_ascii=False),
                json.dumps(file_ids, ensure_ascii=False) if file_ids else "",
            ),
        )
        db.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at, is_guard)"
            " VALUES (?, ?, ?, ?, ?, 1)",
            (ai_msg_id, req.session_id, "assistant", warn_text, now_str),
        )
        msg_count = db.execute(
            "SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?", (req.session_id,)
        ).fetchone()["cnt"]
        if msg_count <= 2:
            title = (req.content or "[图片]")[:30]
            db.execute(
                "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
                (title, now_str, req.session_id),
            )
        db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_str, req.session_id))
        db.commit()
        db.close()

        async def _refuse_stream() -> AsyncGenerator[str, None]:
            def _emit_local(payload):
                payload["ts"] = datetime.now().isoformat()
                return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

            yield _emit_local({"event": "llm_token", "token": warn_text})
            yield _emit_local(
                {
                    "event": "done",
                    "done": True,
                    "message_id": ai_msg_id,
                    "context": _context_usage(req.session_id, resolved_model_id),
                }
            )

        return StreamingResponse(_refuse_stream(), media_type="text/event-stream")

    # Save user message
    # ⚠️ ``content`` 只存**用户原始输入**（附件正文不入库正文列）：
    #    ① 前端展示保持干净，只显示用户打的字 + 附件标签；
    #    ② 附件正文在下方「重建历史」时按 file_ids 重新拼，规则单一、不会两处漂移。
    msg_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    db.execute(
        "INSERT INTO messages (id, session_id, role, content, created_at, image_ids, file_ids)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            msg_id,
            req.session_id,
            "user",
            req.content,
            now,
            json.dumps(image_ids, ensure_ascii=False) if image_ids else "",
            json.dumps(file_ids, ensure_ascii=False) if file_ids else "",
        ),
    )

    # Auto-title for first message
    msg_count = db.execute("SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?", (req.session_id,)).fetchone()["cnt"]
    if msg_count == 1:
        title_seed = req.content.strip() or "文件附件"
        title = title_seed[:30] + ("..." if len(title_seed) > 30 else "")
        db.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (title, now, req.session_id))

    db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, req.session_id))
    db.commit()

    # Build message history（含图片：用户消息按多模态 content blocks 还原；
    #                        含文件附件：短文本内联、长文本落盘给路径）
    #
    # ⚠️⚠️ **vision 守卫轮不重建**（``is_guard=1`` 的助手消息直接跳过）：
    #     守卫话术「当前模型不支持图片识别」是**我们替模型写的**，不是模型自己的输出。
    #     若把它当正常历史喂回去，模型会被自己"带偏" —— 典型场景：
    #       用户先用纯文本模型(pro)发图 → 拿到守卫话术(落库) → 切到支持图片的 flash 再发图
    #       → 历史里那句"我看不到图"让 flash 也坚持拒答（实测思考过程里明确写
    #         "prior turn I said 当前模型不支持图片识别... I should be consistent"）。
    #     跳过它之后，flash 只看得到用户的图片消息，行为才正确。
    history = db.execute(
        "SELECT role, content, image_ids, file_ids, is_guard FROM messages"
        " WHERE session_id = ? ORDER BY created_at ASC",
        (req.session_id,),
    ).fetchall()
    db.close()

    messages = []
    for h in history:
        # 守卫轮（用户 + 助手两条都带 is_guard）：整轮不进历史，见上方说明
        if h["is_guard"]:
            continue
        if h["role"] == "user":
            try:
                ids = json.loads(h["image_ids"] or "[]")
            except Exception:  # noqa: BLE001
                ids = []
            try:
                fids = json.loads(h["file_ids"] or "[]")
            except Exception:  # noqa: BLE001
                fids = []

            # 附件正文：按 id 现取现拼（短内联 / 长落盘），每轮重建保证与当前阈值一致
            text_content = h["content"] or ""
            if isinstance(fids, list) and fids:
                hist_files = [file_store.get_file(i) for i in fids]
                hist_files = [f for f in hist_files if f]
                if hist_files:
                    block = file_store.build_prompt_text(hist_files)
                    text_content = (
                        f"{text_content}\n\n{block}" if text_content.strip() else block
                    )

            if isinstance(ids, list) and ids:
                blocks: list[dict] = []
                if text_content.strip():
                    blocks.append({"type": "text", "text": text_content})
                else:
                    # 纯图片消息：补一句占位文本，避免部分供应商拒绝无文本的多模态输入
                    blocks.append({"type": "text", "text": "请描述这张图片。"})
                for iid in ids:
                    url = image_store.data_url(iid)
                    if url:
                        blocks.append({"type": "image_url", "image_url": {"url": url}})
                messages.append(HumanMessage(content=blocks))
            else:
                messages.append(HumanMessage(content=text_content))
        else:
            messages.append(AIMessage(content=h["content"]))

    # Invoke the full-featured agent
    # 每次请求重算数据范围：角色在「AI 助手」页的 dataScope 决定 CRM 工具能读写的范围。
    # ⚠️ 必须用 ContextVar 逐请求设置（工具是模块级单例，同一批对象被所有请求复用）。
    scope_info = crm_permissions.resolve_agent_scope(
        phone=req.user_phone,
        name=req.user_name,
        role_id=req.role_id,
        role_name=req.role_name,
    )
    crm_tools.set_data_scope(
        scope=scope_info["scope"],
        user_name=scope_info["user_name"],
        user_phone=scope_info["user_phone"],
    )
    # token 消耗的归属（用于「按用户统计」）。⚠️ 用**已解析**的身份：
    # 角色查得到就用角色里的规范姓名，查不到也保留前端传来的原值（不丢归属）。
    owner = _normalize_owner({
        "phone": scope_info["user_phone"] or req.user_phone,
        "name": scope_info["user_name"] or req.user_name,
        "role_id": scope_info["role_id"] or req.role_id,
        "role_name": scope_info["role_name"] or req.role_name,
    })
    # 会话若当初没记归属（历史会话 / 匿名创建），本轮补记一次，让统计更完整
    _backfill_session_owner(req.session_id, owner)

    # ---- 月度额度守卫 ----
    # 角色的 monthlyTokenQuota = **该角色下每个用户各自**的月额度（0 = 不限额）。
    # 超限 → 落两条 is_guard 消息 + 回固定话术，**不调模型、不产生 token 消耗**。
    quota = resolve_quota(scope_info)
    if quota["exceeded"]:
        return StreamingResponse(
            _quota_refuse_stream(req.session_id, QUOTA_EXCEEDED_TEXT, resolved_model_id),
            media_type="text/event-stream",
        )

    agent = build_agent(use_search=req.use_search, model_id=req.model or None)

    thread_id = f"thread_{req.session_id}"
    # 本轮对话的指标采集器（token / 工具调用次数等）
    metrics = MetricsCallback()
    turn_started = time.perf_counter()

    async def event_stream() -> AsyncGenerator[str, None]:
        full_response = ""
        full_thinking = ""
        ai_msg_id = None
        # 本轮产出的数据卡片（render_card 工具的 artifact），随助手消息一起落库
        turn_cards: list[dict] = []
        # 本轮最后的任务清单快照（write_todos 每次回传完整清单，直接整体替换）
        turn_todos: list[dict] = []
        # 同一 tool_call 可能出现在多个节点输出里，按 id 去重，避免前端重复气泡
        seen_tool_starts: set[str] = set()
        # 卡片同样按 card_id 去重
        seen_card_ids: set[str] = set()

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
                                        # 落库快照：每次整体替换，存最后一个版本
                                        turn_todos.clear()
                                        turn_todos.extend(
                                            [t for t in todos_list if isinstance(t, dict)]
                                        )
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
                                # 数据卡片：render_card 工具通过 artifact 回传结构化数据，
                                # 单独推送一条 card 事件，让卡片随工具返回即时出现在对话流中。
                                card = _extract_card(last, t_name, t_id)
                                if card is not None and card["card_id"] not in seen_card_ids:
                                    seen_card_ids.add(card["card_id"])
                                    turn_cards.append(card)
                                    yield _emit({
                                        "event": "card",
                                        "status": "card",
                                        "id": t_id,
                                        "name": t_name,
                                        "card": card,
                                        "node": node_name,
                                    })
                if not interrupted:
                    break  # stream finished

            # Save AI response
            ai_msg_id = str(uuid.uuid4())
            now_str = datetime.now().isoformat()
            db = get_db()
            # 本轮产出的数据卡片随助手消息一起落库（空则存空串）
            cards_json = json.dumps(turn_cards, ensure_ascii=False) if turn_cards else ""
            # 任务清单同理：存最后一次快照，刷新 / 切会话后前端可还原
            todos_json = json.dumps(turn_todos, ensure_ascii=False) if turn_todos else ""
            db.execute("INSERT INTO messages (id, session_id, role, content, created_at, cards, todos) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (ai_msg_id, req.session_id, "assistant", full_response, now_str, cards_json, todos_json))
            if full_thinking:
                # Store thinking as a separate hidden message
                think_msg_id = str(uuid.uuid4())
                db.execute("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                           (think_msg_id, req.session_id, "thinking", full_thinking, now_str))
            db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_str, req.session_id))
            db.commit()
            db.close()

            # 记录本轮指标（供「Agent 控制面板」统计）
            turn_usage = metrics.finalize()
            record_metric(
                req.session_id,
                latency_ms=(time.perf_counter() - turn_started) * 1000,
                ok=True,
                usage=turn_usage,
                model=resolved_model_id,
                owner=owner,
            )

            # 把「上下文用量」一并推给前端（对话页底部环形图标 + 弹窗）
            yield _emit({
                "event": "done",
                "done": True,
                "message_id": ai_msg_id,
                "context": _context_usage(req.session_id, resolved_model_id, turn_usage),
            })

        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()
            print(f"[Agent error] {error_detail}")
            record_metric(
                req.session_id,
                latency_ms=(time.perf_counter() - turn_started) * 1000,
                ok=False,
                usage=metrics.finalize(),
                model=resolved_model_id,
                owner=owner,
            )
            yield _emit({"event": "error", "error": str(e)})

    return StreamingResponse(event_stream(), media_type="text/event-stream")

# --- Knowledge Base File Management（前端「Agent 知识库」页） ---
# 七个接口：
#   GET  /api/kb/overview      库概览 + 上传能力（允许的类型 / 大小上限）
#   GET  /api/kb/documents     已挂载文档列表（含来源文件状态）
#   GET  /api/kb/chunks        切片后的正文（点文件名 / 片段数时弹的「切片预览」）
#   POST /api/kb/upload        上传一个文件（**body = 原始字节**），返回任务
#   GET  /api/kb/tasks         任务列表（页面刷新后据此恢复进度）
#   GET  /api/kb/tasks/{id}    单任务进度（前端轮询）
#   POST /api/kb/delete        按 doc_id 批量删除
#
# 上传刻意不用 multipart：省掉 python-multipart 依赖，也避免二进制文件
# （xlsx）在解析/转发途中被按 UTF-8 解码弄坏。文件名走 query 参数。

def _kb_doc_payload() -> dict:
    """文档列表 + 每篇的来源文件状态。

    ``managed`` 表示来源文件位于受管上传目录内 —— 删除文档时会连带清理；
    外部导入的文档（手工放进项目的那种）永远不动。
    """
    store = kb_get_store()
    docs = store.list_documents()
    for d in docs:
        src = (d.get("source") or "").strip()
        p = Path(src) if src else None
        exists = bool(p and p.is_file())
        d["source_name"] = p.name if p else ""
        d["source_exists"] = exists
        d["source_size"] = p.stat().st_size if (p and exists) else 0
        d["managed"] = bool(p and kb_is_managed_file(p))
    return {"data": docs, "total": len(docs), "stats": store.stats()}


@app.get("/api/kb/overview")
def kb_overview():
    return {
        "stats": kb_get_store().stats(),
        "upload": kb_upload_describe(),
        "embedding": kb_embedding_describe(),
    }


@app.get("/api/kb/documents")
def kb_document_list():
    return _kb_doc_payload()


# 「切片预览」一次最多返回多少个片段。片段正文不大（中文语料默认 800 字/块），
# 200 条也就几十 KB；超出的靠 offset 翻页继续取。
MAX_CHUNK_WINDOW = 200


@app.get("/api/kb/chunks")
def kb_chunk_list(doc_ids: str = "", limit: int = MAX_CHUNK_WINDOW, offset: int = 0):
    """取**切片后的正文**（前端点文件名 / 片段数时弹的「切片预览」抽屉）。

    ``doc_ids`` 逗号分隔 —— 一个知识库文件会拆成多篇文档（问答表按分类拆），
    文件详情要一口气拿到全部，逐个请求会有 N 次往返。doc_id 形如 ``kb-<hex12>``，
    不含逗号，是安全分隔符。
    """
    ids = [d.strip() for d in (doc_ids or "").split(",") if d.strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="doc_ids 不能为空")
    try:
        return kb_get_store().list_chunks(
            ids,
            limit=max(1, min(limit, MAX_CHUNK_WINDOW)),
            offset=max(0, offset),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/kb/upload")
async def kb_upload_file(request: Request, filename: str = "", tags: str = ""):
    """上传一个知识库文件：body 就是文件原始字节，文件名通过 query 传入。"""
    data = await request.body()
    try:
        return kb_get_manager().submit(filename, data, tags=tags)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/kb/tasks")
def kb_task_list(limit: int = 50):
    mgr = kb_get_manager()
    return {"data": mgr.list(limit=max(1, min(limit, 200))), "active": mgr.has_active()}


@app.get("/api/kb/tasks/{task_id}")
def kb_task_detail(task_id: str):
    task = kb_get_manager().get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"任务不存在：{task_id}")
    return task


@app.post("/api/kb/delete")
def kb_delete_docs(req: KbDeleteRequest):
    """按 doc_id 批量删除（连带清掉只属于它们的受管上传文件）。

    用 POST + JSON 而不是 ``DELETE /api/kb/documents/{doc_id}``：一次要删的往往是
    同一个文件拆出来的多篇文档，而按来源路径删又得把 Windows 绝对路径（含冒号、
    反斜杠）塞进 URL，编码极易出错。
    """
    ids = [d.strip() for d in (req.doc_ids or []) if d and d.strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="doc_ids 不能为空")
    result = kb_delete_documents(ids)
    if not result["removed"]:
        raise HTTPException(
            status_code=404,
            detail=f"文档不存在：{'、'.join(result['missing']) or '（空）'}",
        )
    result["list"] = _kb_doc_payload()     # 顺手带回最新列表，省一次往返
    return result


# --- 生成文件管理（AI 生成的合同 / 报告等产物） ---

GENERATED_SUBDIRS = ("contracts", "reports")
GENERATED_CATEGORY_LABEL = {"contracts": "合同", "reports": "报告"}


def _resolve_generated(path: str):
    """把相对 static 目录的路径安全解析为真实路径，禁止越出 static 目录。

    返回 Path，或非法 / 越界时返回 None。
    """
    raw = (path or "").strip().strip("/").replace("\\", "/")
    if not raw:
        return None
    base = STATIC_DIR.resolve()
    p = (base / raw).resolve()
    try:
        p.relative_to(base)
    except ValueError:
        return None
    return p


def _list_generated_files():
    """扫描产物目录，返回用户可见的生成文件（排除 _ 开头的内部辅助文件）。"""
    files = []
    for sub in GENERATED_SUBDIRS:
        root = STATIC_DIR / sub
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            if any(part.startswith("_") for part in rel.parts):
                continue
            st = p.stat()
            rel_str = str(rel).replace("\\", "/")
            files.append({
                "name": p.name,
                "path": f"{sub}/{rel_str}",
                "category": sub,
                "category_label": GENERATED_CATEGORY_LABEL.get(sub, sub),
                "size": st.st_size,
                "mtime": int(st.st_mtime),
                "url": f"/static/{sub}/{rel_str}",
            })
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files


@app.get("/api/files")
def list_generated_files():
    data = _list_generated_files()
    return {"data": data, "total": len(data)}


@app.get("/api/files/download")
def download_generated_file(path: str = ""):
    fp = _resolve_generated(path)
    if not fp or not fp.is_file():
        raise HTTPException(status_code=404, detail=f"文件不存在：{path}")
    return FileResponse(str(fp), filename=fp.name)


@app.delete("/api/files")
def delete_generated_file(path: str = ""):
    fp = _resolve_generated(path)
    if not fp or not fp.is_file():
        raise HTTPException(status_code=404, detail=f"文件不存在：{path}")
    name = fp.name
    fp.unlink()
    return {"ok": True, "removed": name}


# --------------------------------------------------------------------------
# Agent 定时任务（创建 / 编辑 / 启停 / 测试 / 删除）
# --------------------------------------------------------------------------
def _validate_schedule(name, prompt, trigger_type, hour, minute, frequency, weekdays_only) -> None:
    if not name or not str(name).strip():
        raise HTTPException(status_code=422, detail="任务名不能为空")
    if not prompt or not str(prompt).strip():
        raise HTTPException(status_code=422, detail="任务执行提示词不能为空")
    if trigger_type not in scheduler.TRIGGER_TYPES:
        raise HTTPException(status_code=422, detail="触发规则不合法：仅支持 daily（定时执行）/ interval（周期执行）")
    if trigger_type == "daily":
        if not isinstance(hour, int) or not isinstance(minute, int) \
                or not (0 <= hour <= 23) or not (0 <= minute <= 59):
            raise HTTPException(status_code=422, detail="触发时间不合法：小时 0-23，分钟 0-59")
        if frequency not in scheduler.FREQUENCIES:
            raise HTTPException(status_code=422, detail="执行频率不合法：仅支持 repeat（重复）/ once（一次）")
    else:  # interval
        if not isinstance(hour, int) or not isinstance(minute, int) \
                or not (0 <= hour <= 24) or not (1 <= minute <= 59):
            raise HTTPException(status_code=422, detail="间隔时间不合法：小时 0-24，分钟 1-59")


@app.get("/api/schedules")
def list_schedules():
    data = scheduler.list_tasks()
    return {"data": data, "total": len(data)}


@app.post("/api/schedules")
def create_schedule(req: ScheduleCreateRequest):
    _validate_schedule(req.name, req.prompt, req.trigger_type, req.hour, req.minute,
                       req.frequency, req.weekdays_only)
    task = scheduler.create_task(req.name.strip(), req.prompt.strip(), req.trigger_type,
                                 req.hour, req.minute, req.frequency, req.weekdays_only)
    return {"ok": True, "task": task}


@app.put("/api/schedules/{task_id}")
def update_schedule(task_id: str, req: ScheduleUpdateRequest):
    _validate_schedule(req.name, req.prompt, req.trigger_type, req.hour, req.minute,
                       req.frequency, req.weekdays_only)
    task = scheduler.update_task(task_id, req.name.strip(), req.prompt.strip(), req.trigger_type,
                                 req.hour, req.minute, req.frequency, req.weekdays_only)
    if not task:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    return {"ok": True, "task": task}


@app.delete("/api/schedules/{task_id}")
def delete_schedule(task_id: str):
    if not scheduler.delete_task(task_id):
        raise HTTPException(status_code=404, detail="定时任务不存在")
    return {"ok": True}


@app.put("/api/schedules/{task_id}/enabled")
def set_schedule_enabled(task_id: str, req: ScheduleEnabledRequest):
    task = scheduler.set_enabled(task_id, req.enabled)
    if not task:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    return {"ok": True, "task": task}


@app.post("/api/schedules/{task_id}/test")
async def test_schedule(task_id: str):
    """立即执行一次已保存任务（开新会话），并回写上次执行结果。"""
    task = scheduler.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    res = await _invoke_prompt(task["prompt"])
    scheduler.mark_run(task_id, "success" if res["ok"] else "error",
                       res.get("text") or res.get("error", ""),
                       task.get("next_run_at"), disable=False)
    return res


@app.post("/api/schedules/run")
async def run_prompt_once(req: RunPromptRequest):
    """用任意提示词立即执行一次 Agent（创建弹窗测试用），不落库。"""
    if not req.prompt or not req.prompt.strip():
        raise HTTPException(status_code=422, detail="提示词不能为空")
    return await _invoke_prompt(req.prompt.strip())


# --------------------------------------------------------------------------
# 飞书渠道：OAuth 授权（搜通讯录需用户身份 token）
# --------------------------------------------------------------------------
@app.get("/api/feishu/authorize-url")
def feishu_authorize_url():
    """生成飞书 OAuth 授权地址（获取 user_access_token，用于搜通讯录）。"""
    if not feishu_tools.configured():
        raise HTTPException(status_code=400, detail="飞书未配置：请在 .env 设置 FEISHU_APP_ID / FEISHU_APP_SECRET")
    return {"ok": True, "url": feishu_tools.get_authorize_url()}


@app.get("/api/feishu/oauth/callback")
def feishu_oauth_callback(code: str = "", state: str = ""):
    """飞书 OAuth 授权回调：用 code 换 user_access_token 并落盘。"""
    if not code:
        return Response(content="<h3>授权失败：缺少 code</h3>", media_type="text/html")
    result = feishu_tools.exchange_code(code)
    status = "成功" if result["ok"] else "失败"
    return Response(
        content=f"<html><body style='font-family:sans-serif;padding:40px'>"
                f"<h3>飞书授权{status}</h3><p>{result['msg']}</p></body></html>",
        media_type="text/html",
    )


@app.get("/api/feishu/status")
def feishu_status():
    """飞书渠道状态：是否配置、是否已授权、授权地址。"""
    configured = feishu_tools.configured()
    authorized = bool(feishu_tools._get_valid_user_token())
    return {
        "configured": configured,
        "authorized": authorized,
        "authorize_url": feishu_tools.get_authorize_url() if configured else "",
    }


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
