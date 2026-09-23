"""Agent 控制面板 —— 配置存储与工具目录。

本模块是「Agent 控制面板」的服务端数据层：

1. 维护**工具目录**（名称 / 中文名 / 分组 / 说明 / 默认策略），是面板展示与
   权限校验的唯一事实来源；
2. 把管理员的**可配置项**持久化到 `<chat-ui>/agent_config.json`；
3. 通过 `effective()` 计算「有效配置」，供 `server.py` 的 `build_agent()` 与
   `FsApprovalMiddleware` 使用。

可配置项
--------
1) ``system_prompt`` —— 覆盖系统提示词；``None`` 表示使用内置默认提示词。
2) ``tools`` —— 每个工具的 ``{enabled, policy}``：

   - ``enabled=False`` → 关闭该工具：从模型的工具清单中移除，并做运行时兜底拒绝；
   - ``policy="allow"``    → 直接使用；
   - ``policy="approval"`` → 人工审批通过后才执行；
   - ``policy="deny"``     → 禁止执行（调用即被拦截，前端弹出「禁止」提示）。
3) ``skills`` —— 每个技能的 ``{enabled}``。技能**目录不在这里登记**（技能是扫盘
   发现的，见 ``skills_admin.py``），本键只存「被显式关掉/打开过」的那些名字：
   ``enabled=False`` → 该技能不进入系统提示词，且读取其 SKILL.md 会被拦截。

默认策略与改造前的硬编码行为完全一致：
  查询类 → allow；CRM / 文件写入类 → approval；删除类 → deny。
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime
from pathlib import Path

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

CONFIG_PATH: Path = Path(__file__).resolve().parent / "agent_config.json"

POLICY_ALLOW = "allow"
POLICY_APPROVAL = "approval"
POLICY_DENY = "deny"
POLICIES: tuple[str, ...] = (POLICY_ALLOW, POLICY_APPROVAL, POLICY_DENY)
POLICY_LABELS: dict[str, str] = {
    POLICY_ALLOW: "直接使用",
    POLICY_APPROVAL: "人工审批",
    POLICY_DENY: "禁止",
}

# 面板中工具分组展示顺序
CATEGORY_ORDER: list[str] = [
    "CRM 业务数据", "知识库", "通用能力", "MCP 工具", "飞书渠道", "结果展示", "文档处理", "文件系统与 Shell", "智能体协作"
]


def _t(name: str, label: str, category: str, desc: str, policy: str = POLICY_ALLOW) -> dict:
    return {
        "name": name,
        "label": label,
        "category": category,
        "desc": desc,
        "policy": policy,
        "enabled": True,
    }


# --------------------------------------------------------------------------
# 工具目录（默认值）
# --------------------------------------------------------------------------
# 说明：``policy`` 为该工具的默认权限档；管理员可在面板中覆盖。
# 「文件系统与 Shell」「智能体协作」两类由 deepagents 框架/后端注入，
# 无法从 ``tools=`` 参数里移除，因此「关闭」统一通过运行时拦截实现。
TOOL_CATALOG: list[dict] = [
    # ---------------- CRM 业务数据 ----------------
    _t("crm_list_entities", "查看 CRM 数据结构", "CRM 业务数据",
       "列出 CRM 实体、字段说明与当前记录数"),
    _t("crm_query", "查询 CRM 数据", "CRM 业务数据",
       "按关键词 / 条件筛选业务数据，返回表格"),
    _t("crm_get", "读取 CRM 记录", "CRM 业务数据",
       "按 id 读取单条业务数据的完整字段"),
    _t("crm_stats", "统计 CRM 数据", "CRM 业务数据",
       "总数 / 分组计数 / 数值字段求和与均值"),
    _t("crm_create", "新增 CRM 数据", "CRM 业务数据",
       "新增一条业务记录（写入）", POLICY_APPROVAL),
    _t("crm_update", "修改 CRM 数据", "CRM 业务数据",
       "按 id 修改业务记录字段（写入）", POLICY_APPROVAL),
    _t("crm_delete", "删除 CRM 数据", "CRM 业务数据",
       "删除业务记录（拦截桩，调用必被拒绝）", POLICY_DENY),

    # ---------------- 知识库 ----------------
    _t("kb_search", "检索知识库", "知识库",
       "按语义检索本地知识库中的文档片段（向量检索）"),
    _t("kb_list_documents", "查看知识库文档", "知识库",
       "列出知识库全部文档、分块数与标签"),
    _t("kb_ingest", "导入知识库", "知识库",
       "把文件或目录切块向量化后存入知识库（消耗 Embedding 额度）", POLICY_APPROVAL),
    _t("kb_delete_document", "删除知识库文档", "知识库",
       "从知识库中移除一篇文档及其全部片段", POLICY_APPROVAL),

    # ---------------- 通用能力 ----------------
    _t("get_project_info", "读取项目信息", "通用能力", "获取项目结构与版本信息"),
    _t("get_current_time", "查询时间", "通用能力", "获取当前日期时间（支持时区）"),
    _t("web_fetch", "抓取网页", "通用能力", "读取指定 URL 的正文内容"),
    _t("web_search", "联网搜索", "通用能力", "联网检索最新信息（受「智能搜索」开关控制）"),
    _t("get_weather", "查询天气", "通用能力", "查询指定城市的天气预报"),
    _t("store_memory", "写入记忆", "通用能力", "保存一条跨会话长期记忆"),
    _t("recall_memory", "读取记忆", "通用能力", "读取已保存的长期记忆"),

    # ---------------- MCP 工具（外部工具服务器，经 mcp_tools 桥接） ----------------
    _t("bing_search", "必应搜索（MCP）", "MCP 工具",
       "通过必应中文搜索引擎检索信息（MCP: bing-cn-mcp）"),
    _t("crawl_webpage", "抓取网页（MCP）", "MCP 工具",
       "根据搜索结果 UUID 抓取网页正文（MCP: bing-cn-mcp）"),

    # ---------------- 飞书渠道（渠道通信：发送 / 回复 / 搜通讯录） ----------------
    _t("feishu_send_message", "飞书发消息", "飞书渠道",
       "向飞书群聊或私聊发送文本消息（应用身份）"),
    _t("feishu_reply_message", "飞书回复消息", "飞书渠道",
       "回复飞书中的某条消息（应用身份）"),
    _t("feishu_search_contacts", "飞书搜通讯录", "飞书渠道",
       "按姓名关键词搜索飞书通讯录用户（需用户授权）"),

    # ---------------- 结果展示 ----------------
    _t("render_card", "展示数据卡片", "结果展示",
       "把分析结果以结构化数据卡片展示在对话流中（可随消息保存）"),

    # ---------------- 文档处理 ----------------
    _t("docx_read_text", "读取 Word 文档", "文档处理",
       "读取 .docx 文件的全文纯文本（含表格）"),
    _t("docx_list_placeholders", "列出 Word 占位符", "文档处理",
       "列出 .docx 模板里的 {{占位符}} 及出现次数"),
    _t("docx_fill_template", "填充 Word 模板", "文档处理",
       "按占位符映射填充模板，生成新 .docx（写入）", POLICY_APPROVAL),

    # ---------------- 文件系统与 Shell ----------------
    _t("ls", "浏览目录", "文件系统与 Shell", "列出目录内容"),
    _t("read_file", "读取文件", "文件系统与 Shell", "读取文件内容"),
    _t("glob", "查找文件", "文件系统与 Shell", "按通配符匹配文件路径"),
    _t("grep", "搜索内容", "文件系统与 Shell", "在文件内容中检索关键词"),
    _t("write_file", "写入文件", "文件系统与 Shell",
       "写入 / 修改文件（新建文件被内置安全规则禁止）", POLICY_APPROVAL),
    _t("edit_file", "修改文件", "文件系统与 Shell",
       "按片段修改已有文件（新建文件被内置安全规则禁止）", POLICY_APPROVAL),
    _t("delete", "删除文件", "文件系统与 Shell", "删除文件（默认禁止）", POLICY_DENY),
    _t("execute", "执行命令", "文件系统与 Shell", "执行本地 Shell 命令"),

    # ---------------- 智能体协作 ----------------
    _t("write_todos", "规划任务", "智能体协作", "维护本次任务的待办清单"),
    _t("task", "调用子代理", "智能体协作", "把子任务派发给子代理执行"),
]

CATALOG_BY_NAME: dict[str, dict] = {t["name"]: t for t in TOOL_CATALOG}


class UnknownToolError(ValueError):
    """配置了一个不在工具目录中的工具名。"""


# --------------------------------------------------------------------------
# 技能（Skill）开关
# --------------------------------------------------------------------------
# 技能与工具的关键差别：工具目录是**静态清单**（TOOL_CATALOG），技能是**扫盘
# 发现**的（谁在 skills 目录里放了 SKILL.md 谁就是技能）。所以这里不做目录校验，
# 只存「显式改过开关」的名字，其余一律按默认「开启」处理；技能被删掉后遗留的
# 开关记录无害，而且如果同名技能再被加回来，开关会自动重新生效。
#
# 名字仍需做**形状**校验：它来自 URL 路径参数，虽然从不参与拼路径（查找永远走
# 扫盘结果），但挡掉空串 / 路径分隔符 / 控制字符能避免脏数据写进配置文件。
SKILL_NAME_MAX_LENGTH = 64
_SKILL_NAME_RE = re.compile(r"^[^\s/\\:*?\"<>|]{1,%d}$" % SKILL_NAME_MAX_LENGTH)


class UnknownSkillError(ValueError):
    """引用了一个名字非法的技能。"""


# --------------------------------------------------------------------------
# 存储
# --------------------------------------------------------------------------

_LOCK = threading.RLock()


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    import os
    os.replace(tmp, path)


def _default_raw() -> dict:
    return {"system_prompt": None, "tools": {}, "skills": {}, "updated_at": None}


def _load_raw() -> dict:
    """读取原始配置；文件缺失 / 损坏时回退到空配置（不抛错，保证服务可用）。"""
    if not CONFIG_PATH.is_file():
        return _default_raw()
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _default_raw()
    except Exception:
        return _default_raw()
    out = _default_raw()
    sp = data.get("system_prompt")
    out["system_prompt"] = sp if isinstance(sp, str) and sp.strip() else None
    tools = data.get("tools")
    if isinstance(tools, dict):
        clean: dict[str, dict] = {}
        for name, spec in tools.items():
            if name not in CATALOG_BY_NAME or not isinstance(spec, dict):
                continue  # 忽略目录外的脏数据
            entry: dict = {}
            if isinstance(spec.get("enabled"), bool):
                entry["enabled"] = spec["enabled"]
            pol = spec.get("policy")
            if isinstance(pol, str) and pol in POLICIES:
                entry["policy"] = pol
            if entry:
                clean[name] = entry
        out["tools"] = clean
    skills = data.get("skills")
    if isinstance(skills, dict):
        clean_skills: dict[str, dict] = {}
        for name, spec in skills.items():
            if not isinstance(name, str) or not _SKILL_NAME_RE.match(name):
                continue  # 忽略目录外的脏数据
            if not isinstance(spec, dict) or not isinstance(spec.get("enabled"), bool):
                continue
            clean_skills[name] = {"enabled": spec["enabled"]}
        out["skills"] = clean_skills
    out["updated_at"] = data.get("updated_at") if isinstance(data.get("updated_at"), str) else None
    return out


def _save_raw(data: dict) -> None:
    data = dict(data)
    data["updated_at"] = datetime.now().isoformat(timespec="seconds")
    _atomic_write(CONFIG_PATH, json.dumps(data, ensure_ascii=False, indent=2))


def _require(name: str) -> dict:
    meta = CATALOG_BY_NAME.get(name)
    if meta is None:
        raise UnknownToolError(f"未知工具「{name}」")
    return meta


# --------------------------------------------------------------------------
# 工具设置读写
# --------------------------------------------------------------------------

def get_tool_settings() -> dict[str, dict]:
    """返回每个工具的**有效**设置（目录默认值 + 管理员覆盖）。"""
    with _LOCK:
        raw = _load_raw()
    overrides = raw["tools"]
    out: dict[str, dict] = {}
    for name, meta in CATALOG_BY_NAME.items():
        ov = overrides.get(name, {})
        out[name] = {
            "enabled": bool(ov.get("enabled", meta["enabled"])),
            "policy": ov.get("policy", meta["policy"]),
        }
    return out


def set_tool_enabled(name: str, enabled: bool) -> dict:
    _require(name)
    if not isinstance(enabled, bool):
        raise ValueError("enabled 必须是布尔值")
    with _LOCK:
        raw = _load_raw()
        raw["tools"].setdefault(name, {})["enabled"] = enabled
        _save_raw(raw)
    return get_tool_settings()[name]


def set_tool_policy(name: str, policy: str) -> dict:
    _require(name)
    if policy not in POLICIES:
        raise ValueError(f"policy 必须是 {', '.join(POLICIES)} 之一")
    with _LOCK:
        raw = _load_raw()
        raw["tools"].setdefault(name, {})["policy"] = policy
        _save_raw(raw)
    return get_tool_settings()[name]


# --------------------------------------------------------------------------
# 技能设置读写
# --------------------------------------------------------------------------

def get_skill_enabled(name: str, default: bool = True) -> bool:
    """单个技能的有效开关（未设置过 → ``default``）。"""
    with _LOCK:
        raw = _load_raw()
    spec = raw["skills"].get(name) or {}
    return bool(spec.get("enabled", default))


def get_skill_overrides() -> dict[str, bool]:
    """**只**返回被显式设置过的技能开关（未出现 = 默认开启）。"""
    with _LOCK:
        raw = _load_raw()
    return {n: bool(s.get("enabled", True)) for n, s in raw["skills"].items()}


def set_skill_enabled(name: str, enabled: bool) -> None:
    if not isinstance(name, str) or not _SKILL_NAME_RE.match(name):
        raise UnknownSkillError(f"非法技能名「{name}」")
    if not isinstance(enabled, bool):
        raise ValueError("enabled 必须是布尔值")
    with _LOCK:
        raw = _load_raw()
        if enabled:
            # 默认就是开启，写 True 是冗余状态：直接删掉这条记录，
            # 配置文件只保留「异常状态」，肉眼可读、reset 语义也更干净。
            raw["skills"].pop(name, None)
        else:
            raw["skills"][name] = {"enabled": False}
        _save_raw(raw)


# --------------------------------------------------------------------------
# 系统提示词读写
# --------------------------------------------------------------------------

def get_system_prompt_override() -> str | None:
    with _LOCK:
        return _load_raw()["system_prompt"]


def set_system_prompt_override(text: str) -> None:
    if not isinstance(text, str) or not text.strip():
        raise ValueError("系统提示词不能为空")
    with _LOCK:
        raw = _load_raw()
        raw["system_prompt"] = text
        _save_raw(raw)


def reset_system_prompt() -> None:
    with _LOCK:
        raw = _load_raw()
        raw["system_prompt"] = None
        _save_raw(raw)


# --------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------

def catalog() -> list[dict]:
    """面板用：带有效状态的工具清单（按分组排序）。"""
    settings = get_tool_settings()
    items = []
    for meta in TOOL_CATALOG:
        eff = settings[meta["name"]]
        items.append({
            **meta,
            "enabled": eff["enabled"],
            "policy": eff["policy"],
            "policy_label": POLICY_LABELS.get(eff["policy"], eff["policy"]),
        })
    order = {c: i for i, c in enumerate(CATEGORY_ORDER)}
    items.sort(key=lambda x: (order.get(x["category"], 99), x["name"]))
    return items


def effective() -> dict:
    """给 `build_agent` / 中间件用的有效配置快照。"""
    settings = get_tool_settings()
    enabled = [n for n, s in settings.items() if s["enabled"]]
    disabled = [n for n, s in settings.items() if not s["enabled"]]
    approval = [n for n, s in settings.items() if s["enabled"] and s["policy"] == POLICY_APPROVAL]
    deny = [n for n, s in settings.items() if s["policy"] == POLICY_DENY]
    with _LOCK:
        raw = _load_raw()
    skill_overrides = {n: bool(s.get("enabled", True)) for n, s in raw["skills"].items()}
    return {
        "system_prompt_override": raw["system_prompt"],
        "updated_at": raw["updated_at"],
        "settings": settings,
        "enabled_tools": enabled,
        "disabled_tools": disabled,
        "approval_tools": approval,
        "deny_tools": deny,
        # 技能：被显式关闭的名字集合（技能清单是扫盘发现的，不在这里）
        "skill_overrides": skill_overrides,
        "disabled_skills": sorted(n for n, on in skill_overrides.items() if not on),
    }


def reset_all() -> None:
    """清空所有覆盖，恢复默认（提示词 + 工具开关与权限 + 技能开关）。"""
    with _LOCK:
        try:
            if CONFIG_PATH.is_file():
                CONFIG_PATH.unlink()
        except Exception:
            _save_raw(_default_raw())


def summary() -> dict:
    eff = effective()
    return {
        "system_prompt_custom": eff["system_prompt_override"] is not None,
        "updated_at": eff["updated_at"],
        "enabled_tools": sorted(eff["enabled_tools"]),
        "disabled_tools": sorted(eff["disabled_tools"]),
        "approval_tools": sorted(eff["approval_tools"]),
        "deny_tools": sorted(eff["deny_tools"]),
        "policy_counts": {
            p: sum(1 for s in eff["settings"].values() if s["policy"] == p) for p in POLICIES
        },
        # 技能：配置里被关闭的名字（技能总数由 skills_admin 扫盘得出）
        "disabled_skills": sorted(eff["disabled_skills"]),
        "skill_override_count": len(eff["skill_overrides"]),
    }
