"""MCP（Model Context Protocol）工具加载器 + 管理数据层。

把外部 MCP server（bing-cn-mcp 必应中文搜索等）桥接成 LangChain 工具，
供 `create_deep_agent` 使用。依赖 `langchain-mcp-adapters`。

本模块同时是「Agent 控制面板 → MCP 管理 Tab」的服务端数据层：

1. ``DEFAULT_MCP_SERVERS`` —— 内置 MCP 的**默认定义**（标识 / 中文名 / 介绍 / 连接配置），
   作为首次启动的种子数据；
2. ``mcp_config.json`` —— 持久化的 MCP **注册表**（registry），是面板展示、校验、
   增删改的唯一事实来源。结构：

       {
         "servers": {
           "<name>": {
             "name": "...", "label": "...", "description": "...",
             "config": {...}, "enabled": true/false, "builtin": true/false
           }
         },
         "deleted_builtin": ["<已删除的内置名>", ...]
       }

   内置 MCP 在代码更新后仍会「合并进来」（不在注册表、也未删过的才补入）；
3. ``get_mcp_tools()`` —— 只返回**已开启** MCP 的工具（给 `build_agent` 用），
   因此「开关」改动下一轮对话即生效，无需重新加载；
4. 增 / 删 / 改 / 启用：
   - ``add_mcp`` —— 新增（保存后**自动关闭**，需「初始启用」）；
   - ``delete_mcp`` —— 删除（同时清掉其工具缓存）；
   - ``set_mcp_config`` —— 编辑（解析「完整 MCP JSON 串」，保存后**自动关闭**）；
   - ``enable_mcp`` —— 初始启用（**重新做错误检查**，启动失败保持关闭并回传错误）。

关键约束（Windows，实测得出）：
  - MCP server 用 stdio 传输时，`npx` 是 `.cmd` 脚本，在 asyncio 里直接 spawn 会失败，
    而且 `npx -y` 冷启动去 npm-cache 找包不可靠（实测 ExceptionGroup / MODULE_NOT_FOUND）。
  - 因此默认配置把 bing-cn-mcp **本地安装**到 `chat-ui/mcp_servers/node_modules`，
    用 node.exe 绝对路径直接运行其 `build/index.js`，绕过 npx / .cmd / PATH。
  - ``langchain-mcp-adapters`` 的 stdio 工具是「每次调用都新建 session / 子进程」，
    所以「发现工具」只会做一次握手后即关闭，没有常驻子进程需要维护；
    编辑配置后重跑一次 `get_tools(server_name=...)` 即可拿到新连接的工具。
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import threading
from pathlib import Path

_CHAT_UI_DIR = Path(__file__).resolve().parent
_MCP_CONFIG_PATH = _CHAT_UI_DIR / "mcp_config.json"

# 单个 MCP server 的工具发现（握手）超时秒数。超时即降级，绝不阻塞服务启动。
_DISCOVER_TIMEOUT = 20.0

# node.exe 候选路径（优先 WorkBuddy managed，其次系统 Node）
_NODE_CANDIDATES = [
    r"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
    r"C:\Program Files\nodejs\node.exe",
]

# bing-cn-mcp 本地安装后的入口（chat-ui/mcp_servers 下 `npm install bing-cn-mcp`）
_BING_ENTRY = _CHAT_UI_DIR / "mcp_servers" / "node_modules" / "bing-cn-mcp" / "build" / "index.js"

# 支持的传输类型（与 langchain-mcp-adapters 的 Connection 类型对齐）
TRANSPORTS: tuple[str, ...] = ("stdio", "sse", "streamable_http", "websocket")

# MCP 名称约束：字母/数字开头，后接字母/数字/下划线/连字符，最长 64
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _resolve_node() -> str:
    for p in _NODE_CANDIDATES:
        if Path(p).is_file():
            return p
    return shutil.which("node") or "node"


def _default_bing_config() -> dict:
    """bing-search 的默认连接配置：node 绝对路径直跑本地入口（Windows 适配）。"""
    return {
        "transport": "stdio",
        "command": _resolve_node(),
        "args": [str(_BING_ENTRY)],
    }


# 内置 MCP 服务器默认定义。键名 "bing-search" 沿用用户给的标准 MCP 配置里的命名。
DEFAULT_MCP_SERVERS: list[dict] = [
    {
        "name": "bing-search",
        "label": "必应中文搜索",
        "description": (
            "通过必应中文搜索引擎检索网络信息（bing-cn-mcp），"
            "提供 bing_search 搜索与 crawl_webpage 网页抓取两个工具。"
        ),
        "config": _default_bing_config(),
    },
]
_DEFAULT_BY_NAME: dict[str, dict] = {s["name"]: s for s in DEFAULT_MCP_SERVERS}


class UnknownMcpError(ValueError):
    """引用了一个不存在的 MCP 标识。"""


class McpNameError(ValueError):
    """MCP 名称不合法或已存在。"""


class McpConfigError(ValueError):
    """MCP 连接配置不合法。"""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


# --------------------------------------------------------------------------
# 运行时缓存
# --------------------------------------------------------------------------
# 工具发现结果按 server 分开存，便于「编辑单个 server 后只重发现它」；
# 加载失败也按 server 记录，面板能逐个显示错误而不是整体报错。
_mcp_tools_by_server: dict[str, list] = {}
_load_errors: dict[str, str | None] = {}
_loaded = False
_LOCK = threading.RLock()


# --------------------------------------------------------------------------
# 注册表（mcp_config.json）
# --------------------------------------------------------------------------

def _seed_registry() -> dict:
    """用内置默认定义生成初始注册表（servers + deleted_builtin）。"""
    servers: dict = {}
    for s in DEFAULT_MCP_SERVERS:
        servers[s["name"]] = {
            "name": s["name"],
            "label": s["label"],
            "description": s["description"],
            "config": dict(s["config"]),
            "enabled": True,
            "builtin": True,
        }
    return {"servers": servers, "deleted_builtin": []}


def _load_registry() -> dict:
    """读取 MCP 注册表；文件缺失 / 损坏时回退到内置种子。

    兼容旧格式（{enabled, config} 覆盖式）：自动迁移为注册表格式。
    内置 MCP 若被用户删除（记录在 deleted_builtin）则不再补入；否则补入代码里新增的内置。
    """
    if not _MCP_CONFIG_PATH.is_file():
        return _seed_registry()
    try:
        with open(_MCP_CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return _seed_registry()
    if not isinstance(data, dict):
        return _seed_registry()

    # 旧格式迁移：{enabled: {name: bool}, config: {name: dict}}
    if "servers" not in data:
        migrated = _seed_registry()
        enabled = data.get("enabled")
        if isinstance(enabled, dict):
            for n, v in enabled.items():
                if n in migrated["servers"] and isinstance(v, bool):
                    migrated["servers"][n]["enabled"] = v
        cfg = data.get("config")
        if isinstance(cfg, dict):
            for n, c in cfg.items():
                if n in migrated["servers"] and isinstance(c, dict):
                    migrated["servers"][n]["config"] = c
        return migrated

    servers = data.get("servers")
    if not isinstance(servers, dict):
        servers = {}
    deleted = data.get("deleted_builtin")
    if not isinstance(deleted, list):
        deleted = []

    # 合并新增内置（代码里新加的默认 MCP，且未被用户删除）
    for s in DEFAULT_MCP_SERVERS:
        if s["name"] not in servers and s["name"] not in deleted:
            servers[s["name"]] = {
                "name": s["name"],
                "label": s["label"],
                "description": s["description"],
                "config": dict(s["config"]),
                "enabled": True,
                "builtin": True,
            }

    # 归一化每条记录，防止手改坏字段
    normalized: dict = {}
    for name, entry in servers.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            continue
        normalized[name] = {
            "name": name,
            "label": entry.get("label") if isinstance(entry.get("label"), str) else name,
            "description": entry.get("description") if isinstance(entry.get("description"), str) else "",
            "config": entry.get("config") if isinstance(entry.get("config"), dict) else {},
            "enabled": bool(entry.get("enabled", True)),
            "builtin": bool(entry.get("builtin", False)),
        }
    return {"servers": normalized, "deleted_builtin": deleted}


def _save_registry(reg: dict) -> None:
    _atomic_write(_MCP_CONFIG_PATH, json.dumps(reg, ensure_ascii=False, indent=2))


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    import os
    os.replace(tmp, path)


def _require(name: str) -> dict:
    reg = _load_registry()
    meta = reg["servers"].get(name)
    if meta is None:
        raise UnknownMcpError(f"未知 MCP「{name}」")
    return meta


# --------------------------------------------------------------------------
# 校验 / 完整 JSON 串识别
# --------------------------------------------------------------------------

def validate_mcp_config(cfg: object) -> list[str]:
    """校验一份 MCP 连接配置，返回问题列表（空 = 合法）。"""
    problems: list[str] = []
    if not isinstance(cfg, dict):
        return ["配置必须是 JSON 对象（{ ... }）"]
    transport = cfg.get("transport")
    if transport not in TRANSPORTS:
        problems.append(f"transport 必须是 {', '.join(TRANSPORTS)} 之一")
    if transport == "stdio":
        cmd = cfg.get("command")
        if not isinstance(cmd, str) or not cmd.strip():
            problems.append("stdio 传输需要 command（字符串，可执行文件路径）")
        args = cfg.get("args")
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            problems.append("stdio 传输需要 args（字符串列表，命令行参数）")
    else:
        url = cfg.get("url")
        if not isinstance(url, str) or not url.strip():
            problems.append(f"{transport} 传输需要 url（字符串，服务端地址）")
    return problems


def _infer_transport(cfg: dict) -> dict:
    """识别并补齐缺省的 transport：有 command 视为 stdio，有 url 视为 streamable_http。

    这样用户可以直接粘贴官方 MCP 配置（例如
    `{"command":"npx","args":["-y","bing-cn-mcp"]}`，无 transport 字段）也能识别。
    """
    if cfg.get("transport") in TRANSPORTS:
        return cfg
    out = dict(cfg)
    if isinstance(out.get("command"), str) and out["command"].strip():
        out["transport"] = "stdio"
    elif isinstance(out.get("url"), str) and out["url"].strip():
        out["transport"] = "streamable_http"
    return out


def parse_mcp_definition(text: str) -> dict:
    """解析「完整 MCP JSON 串」，识别三种形态，返回 {name?, label?, description?, config}。

    支持：
      1. 标准 mcpServers 包裹：`{"mcpServers": {"<name>": {<连接配置>}}}`
      2. 完整定义对象：`{"name": "...", "label": "...", "description": "...", "config": {...}}`
      3. 裸连接配置（可内嵌 name/label/description）：`{"command":"...","args":[...]}`

    transport 缺失时自动识别补齐（command→stdio / url→streamable_http）。
    """
    if not isinstance(text, str) or not text.strip():
        raise McpConfigError(["配置不能为空"])
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise McpConfigError([f"不是合法 JSON：{e}"])
    if not isinstance(obj, dict):
        raise McpConfigError(["配置必须是 JSON 对象（{ ... }）"])

    # 1. mcpServers 包裹
    if "mcpServers" in obj:
        ms = obj["mcpServers"]
        if not isinstance(ms, dict) or not ms:
            raise McpConfigError(["mcpServers 必须是至少含一个 MCP 的对象"])
        if len(ms) > 1:
            names = ", ".join(str(k) for k in ms.keys())
            raise McpConfigError([f"mcpServers 里检测到 {len(ms)} 个 MCP，请一次只输入一个（{names}）"])
        name, cfg = next(iter(ms.items()))
        if not isinstance(cfg, dict):
            raise McpConfigError(["MCP 连接配置必须是 JSON 对象（{ ... }）"])
        return {"name": str(name), "config": _infer_transport(dict(cfg))}

    # 2. 完整定义对象（含 config 键）
    if isinstance(obj.get("config"), dict):
        out: dict = {"config": _infer_transport(dict(obj["config"]))}
        if isinstance(obj.get("name"), str) and obj["name"].strip():
            out["name"] = obj["name"].strip()
        if isinstance(obj.get("label"), str) and obj["label"].strip():
            out["label"] = obj["label"].strip()
        if isinstance(obj.get("description"), str) and obj["description"].strip():
            out["description"] = obj["description"].strip()
        return out

    # 3. 裸连接配置（可内嵌 name/label/description）
    meta_keys = {"name", "label", "description"}
    out = {"config": _infer_transport({k: v for k, v in obj.items() if k not in meta_keys})}
    for k in meta_keys:
        if isinstance(obj.get(k), str) and obj[k].strip():
            out[k] = obj[k].strip()
    return out


def _validate_name(name: str) -> list[str]:
    problems: list[str] = []
    if not isinstance(name, str) or not name.strip():
        return ["MCP 名称不能为空"]
    name = name.strip()
    if not _NAME_RE.match(name):
        problems.append("MCP 名称只能包含字母、数字、下划线、连字符，且以字母或数字开头")
    if len(name) > 64:
        problems.append("MCP 名称最长 64 个字符")
    return problems


# --------------------------------------------------------------------------
# 读取合并元数据（面板用）
# --------------------------------------------------------------------------

def _merged_config(name: str) -> dict:
    reg = _load_registry()
    cfg = reg["servers"].get(name, {}).get("config") or {}
    return dict(cfg)


def get_mcp_enabled(name: str) -> bool:
    reg = _load_registry()
    s = reg["servers"].get(name)
    return bool(s.get("enabled", True)) if s else False


def get_mcp_servers() -> list[dict]:
    """面板用：全部 MCP 的元数据（注册表 × 工具发现结果）。

    排序：内置在前（按默认定义顺序），自定义在后（按名称字典序）。
    """
    reg = _load_registry()
    builtin_order = {s["name"]: i for i, s in enumerate(DEFAULT_MCP_SERVERS)}

    def _entry(name: str, s: dict) -> dict:
        cfg = s.get("config") or {}
        tools = [t.name for t in _mcp_tools_by_server.get(name, [])]
        return {
            "name": name,
            "label": s.get("label") or name,
            "description": s.get("description") or "",
            "transport": cfg.get("transport"),
            "enabled": bool(s.get("enabled", True)),
            "builtin": bool(s.get("builtin", False)),
            "config": dict(cfg),
            "tools": tools,
            "tool_count": len(tools),
            "load_error": _load_errors.get(name),
        }

    builtin: list[dict] = []
    custom: list[dict] = []
    for name, s in reg["servers"].items():
        if s.get("builtin"):
            builtin.append(_entry(name, s))
        else:
            custom.append(_entry(name, s))
    builtin.sort(key=lambda e: builtin_order.get(e["name"], 10**6))
    custom.sort(key=lambda e: e["name"])
    return builtin + custom


def get_mcp_config_text(name: str) -> str:
    """编辑弹窗用：返回该 MCP 的「完整定义 JSON」原文（name / label / description / config）。"""
    reg = _load_registry()
    s = reg["servers"].get(name)
    if s is None:
        raise UnknownMcpError(f"未知 MCP「{name}」")
    return json.dumps(
        {
            "name": name,
            "label": s.get("label"),
            "description": s.get("description"),
            "config": s.get("config"),
        },
        ensure_ascii=False,
        indent=2,
    )


# --------------------------------------------------------------------------
# 开关 / 配置编辑 / 增删 / 重置
# --------------------------------------------------------------------------

def set_mcp_enabled(name: str, enabled: bool) -> None:
    """同步持久化开关（不触发工具发现；发现由 ``enable_mcp`` 负责）。"""
    _require(name)
    if not isinstance(enabled, bool):
        raise ValueError("enabled 必须是布尔值")
    with _LOCK:
        reg = _load_registry()
        reg["servers"][name]["enabled"] = enabled
        _save_registry(reg)


async def enable_mcp(name: str) -> dict:
    """「初始启用」：重新做错误检查，成功才真正开启。

    流程：校验连接配置 → 发现工具（spawn 子进程握手）→ 无错才落 enabled=True。
    启动失败则保持关闭，并回传 load_error 供前端提示。
    返回 {"ok": bool, "load_error": str | None}。
    """
    _require(name)
    cfg = _merged_config(name)
    problems = validate_mcp_config(cfg)
    if problems:
        raise McpConfigError(problems)
    await _discover(name, cfg)
    err = _load_errors.get(name)
    if err:
        set_mcp_enabled(name, False)
        return {"ok": False, "load_error": err}
    set_mcp_enabled(name, True)
    return {"ok": True, "load_error": None}


def add_mcp(name: str, description: str, config_text: str) -> dict:
    """新增一个自定义 MCP（保存后自动关闭，需「初始启用」）。

    ``config_text`` 支持「完整 MCP JSON 串」（见 ``parse_mcp_definition``）。
    返回新 MCP 的注册表条目 dict。
    """
    name = (name or "").strip()
    problems = _validate_name(name)
    if problems:
        raise McpNameError(problems[0])
    with _LOCK:
        reg = _load_registry()
        if name in reg["servers"]:
            raise McpNameError(f"MCP「{name}」已存在")

        parsed = parse_mcp_definition(config_text)
        cfg = parsed.get("config") or {}
        vp = validate_mcp_config(cfg)
        if vp:
            raise McpConfigError(vp)

        # JSON 串里若带了 label / description 且表单未填，则采纳 JSON 里的
        label = name
        desc = (description or "").strip()
        if isinstance(parsed.get("label"), str) and parsed["label"].strip():
            label = parsed["label"].strip()
        if not desc and isinstance(parsed.get("description"), str):
            desc = parsed["description"].strip()

        reg["servers"][name] = {
            "name": name,
            "label": label,
            "description": desc,
            "config": cfg,
            "enabled": False,   # 新增即关闭，待「初始启用」
            "builtin": False,
        }
        _save_registry(reg)
    return dict(reg["servers"][name])


def delete_mcp(name: str) -> None:
    """删除一个 MCP（关闭并清掉其工具缓存）。

    内置 MCP 被删后记入 deleted_builtin，避免下次加载又被补回。
    """
    with _LOCK:
        reg = _load_registry()
        s = reg["servers"].get(name)
        if s is None:
            raise UnknownMcpError(f"未知 MCP「{name}」")
        was_builtin = bool(s.get("builtin", False))
        reg["servers"].pop(name, None)
        if was_builtin and name not in reg["deleted_builtin"]:
            reg["deleted_builtin"].append(name)
        _save_registry(reg)
    _mcp_tools_by_server.pop(name, None)
    _load_errors.pop(name, None)


def set_mcp_config(name: str, config_text: str) -> dict:
    """解析「完整 MCP JSON 串」并保存（label / description / config）。

    保存后**自动关闭**该 MCP（需「初始启用」重新检查），并清掉旧工具缓存。
    ``name`` 是唯一标识，不可通过 JSON 改名。
    返回保存后的注册表条目 dict。
    """
    with _LOCK:
        reg = _load_registry()
        s = reg["servers"].get(name)
        if s is None:
            raise UnknownMcpError(f"未知 MCP「{name}」")

        parsed = parse_mcp_definition(config_text)
        if parsed.get("name") and parsed["name"] != name:
            raise McpConfigError([f"MCP 名称不可修改（「{name}」是唯一标识）"])
        cfg = parsed.get("config") or {}
        vp = validate_mcp_config(cfg)
        if vp:
            raise McpConfigError(vp)

        if isinstance(parsed.get("label"), str) and parsed["label"].strip():
            s["label"] = parsed["label"].strip()
        if isinstance(parsed.get("description"), str) and parsed["description"].strip():
            s["description"] = parsed["description"].strip()
        s["config"] = cfg
        s["enabled"] = False   # 编辑保存后自动关闭
        _save_registry(reg)
    # 配置变了，旧的工具发现结果作废，等「初始启用」重新握手
    _mcp_tools_by_server.pop(name, None)
    _load_errors.pop(name, None)
    return dict(reg["servers"][name])


def reset_mcp() -> None:
    """恢复默认：清掉所有自定义 MCP 与覆盖，回到内置默认（开关 + 连接配置）。"""
    with _LOCK:
        _save_registry(_seed_registry())


# --------------------------------------------------------------------------
# 工具发现 / 加载
# --------------------------------------------------------------------------

async def _discover(name: str, cfg: dict) -> None:
    """发现某个 MCP server 的工具（一次握手后即关闭，无常驻子进程）。

    ⚠️ 必须带超时：MCP 子进程若因残留占用 / 启动异常而握手无响应，
    `client.get_tools()` 会**永久挂住**，进而卡死 lifespan 启动（服务永不监听）。
    """
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient

        client = MultiServerMCPClient({name: cfg})
        tools = await asyncio.wait_for(
            client.get_tools(server_name=name), timeout=_DISCOVER_TIMEOUT
        )
        _mcp_tools_by_server[name] = tools
        _load_errors[name] = None
        print(f"[mcp] 已发现 {name}：{len(tools)} 个工具 {[t.name for t in tools]}")
    except asyncio.TimeoutError:
        _mcp_tools_by_server[name] = []
        _load_errors[name] = f"TimeoutError: 握手超时（>{_DISCOVER_TIMEOUT}s）"
        print(f"[mcp] 发现 {name} 失败（已降级）: {_load_errors[name]}")
    except Exception as e:  # noqa: BLE001 —— 单个 server 失败不能拖垮其它 server
        _mcp_tools_by_server[name] = []
        _load_errors[name] = f"{type(e).__name__}: {e}"
        print(f"[mcp] 发现 {name} 失败（已降级）: {_load_errors[name]}")


async def load_mcp_tools() -> list:
    """启动时发现所有 MCP server 的工具并缓存（幂等）。返回已开启 server 的工具。

    无论某个 server 是否「开启」，都会在启动时发现它的工具（只有一次握手开销），
    这样之后在面板里开 / 关都无需重新加载，下一轮对话即时生效。
    """
    global _loaded
    if _loaded:
        return get_mcp_tools()
    _loaded = True
    reg = _load_registry()
    for name in reg["servers"]:
        await _discover(name, _merged_config(name))
    return get_mcp_tools()


async def reload_mcp_server(name: str) -> dict:
    """编辑配置 / 重置后，重新发现单个 server 的工具。返回该 server 最新元数据。"""
    _require(name)
    await _discover(name, _merged_config(name))
    return next((s for s in get_mcp_servers() if s["name"] == name), {})


async def reload_all_mcp() -> None:
    reg = _load_registry()
    for name in reg["servers"]:
        await _discover(name, _merged_config(name))


def get_mcp_tools() -> list:
    """返回**已开启** MCP server 的全部工具（供 `build_agent` 同步取用）。

    开关在这里实时过滤（不依赖重加载），因此面板关掉某个 MCP 后，
    下一轮对话其工具就不再提供给 Agent。未加载则返回空列表。
    """
    out: list = []
    reg = _load_registry()
    for name, s in reg["servers"].items():
        if s.get("enabled", True):
            out.extend(_mcp_tools_by_server.get(name, []))
    return list(out)


def status() -> dict:
    """供诊断 / 调试用。"""
    return {
        "loaded": _loaded,
        "servers": get_mcp_servers(),
        "enabled_tools": [t.name for t in get_mcp_tools()],
    }
