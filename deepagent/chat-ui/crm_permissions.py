"""
CRM 角色权限 —— Agent 侧的数据范围解析
=====================================

职责：把 CRM 的「角色与权限」配置翻译成 chat-ui 能用的**数据范围**判定，
供 `crm_tools` 过滤 CRM 业务数据的读写。

配置来源（单一事实来源，不复制一份到 chat-ui）：
    <工作区>/CRM_Agent1.0/data/roles.json   —— 角色的页面权限数组
    <工作区>/CRM_Agent1.0/data/accounts.json —— 账号（用户 id / 姓名 / 电话 / 角色）

语义映射：
    角色里 `permissions[]` 中 `pageKey == "chat"`（AI 助手）的那一项，其
    `dataScope: "全部" | "仅自己"` 即 **Agent 的数据范围** —— 与 CRM 页面权限
    的用词保持一致：Agent 可查询全部数据，或仅能操作自己的数据。

    - 命中「仅自己」→ Agent 的 CRM 工具只能读写归属当前用户的记录
    - 无该页面 / 无配置 / 解析失败 → 回落到「全部」（**不收紧**，避免误伤既有行为）

⚠️ 为什么要从 roles.json 读、而不是让前端把 scope 传上来：
    前端传什么就可被改成什么，那样权限形同虚设。前端只传**身份**（是谁），
    权限由服务端按角色配置自己算 —— 这是最小信任面。

⚠️ 身份本身仍是前端声明的（内网工具场景，无登录令牌校验）：
    如需更强保证，后续可改成 chat-ui 持令牌向 CRM 反查 `/api/accounts`。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------
# 数据目录（与 crm_tools 同一套定位逻辑，保持口径一致）
# --------------------------------------------------------------------------

AGENT_PAGE_KEY = "chat"          # 「AI 助手」页 —— Agent 数据范围的配置来源
PANEL_PAGE_KEY = "agent"         # 「Agent 控制面板」页 —— 用量统计可见范围的配置来源
SCOPE_ALL = "全部"
SCOPE_SELF = "仅自己"

# 角色每月的 token 额度（**每个用户各自**享用，不是角色总额度）。
# 角色里没有该字段 / 解析失败 → 用这个默认值兜底。
DEFAULT_MONTHLY_TOKEN_QUOTA = 1_000_000


def _resolve_crm_data_dir() -> Path:
    env = (os.environ.get("CRM_DATA_DIR") or "").strip()
    if env:
        return Path(env)
    here = Path(__file__).resolve().parent      # .../deepagents/chat-ui
    workspace = here.parent.parent              # .../deepagent
    return workspace / "CRM_Agent1.0" / "data"


def _load_json(name: str) -> list[dict[str, Any]]:
    """读一个 CRM 数据文件；任何异常都返回空列表（权限读不到 → 不收紧）。"""
    path = _resolve_crm_data_dir() / name
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


# --------------------------------------------------------------------------
# 角色 / 账号
# --------------------------------------------------------------------------


def list_roles() -> list[dict[str, Any]]:
    return _load_json("roles.json")


def find_role(role_id: str = "", role_name: str = "") -> dict[str, Any] | None:
    """按 id 优先、其次按名称找角色。"""
    rid = str(role_id or "").strip()
    rname = str(role_name or "").strip()
    roles = list_roles()
    if rid:
        hit = next((r for r in roles if str(r.get("id", "")) == rid), None)
        if hit:
            return hit
    if rname:
        return next((r for r in roles if str(r.get("name", "")) == rname), None)
    return None


def find_account(phone: str = "", user_id: str = "", name: str = "") -> dict[str, Any] | None:
    """按 phone 优先、其次 id、最后姓名找账号。"""
    accounts = _load_json("accounts.json")
    p, uid, nm = (str(phone or "").strip(), str(user_id or "").strip(), str(name or "").strip())
    for key, val in (("phone", p), ("id", uid), ("name", nm)):
        if val:
            hit = next((a for a in accounts if str(a.get(key, "")) == val), None)
            if hit:
                return hit
    return None


# --------------------------------------------------------------------------
# 数据范围解析
# --------------------------------------------------------------------------


def page_scope(role: dict[str, Any] | None, page_key: str = AGENT_PAGE_KEY) -> str:
    """取角色在某页面上的数据范围。找不到 → 「全部」。"""
    if not role:
        return SCOPE_ALL
    perms = role.get("permissions")
    if not isinstance(perms, list):
        return SCOPE_ALL
    for p in perms:
        if not isinstance(p, dict):
            continue
        if str(p.get("pageKey", "")) == page_key:
            scope = str(p.get("dataScope", "")).strip()
            if scope == SCOPE_SELF:
                return SCOPE_SELF
            return SCOPE_ALL
    return SCOPE_ALL


def page_is_configured(role: dict[str, Any] | None, page_key: str = AGENT_PAGE_KEY) -> bool:
    """该角色是否**显式配置**了这个页面（permissions 里有对应的 pageKey）。

    ⚠️ 与 ``page_scope`` 的区别（很关键）：
        ``page_scope`` 在「页面缺失 / 角色缺失」时回落「全部」—— 这是为了**不收紧**
        Agent 的既有行为；但 ``page_is_configured`` 返回 ``False``。
        需要「没配 = 没授权」的隐私敏感场景（如用量统计谁可见）必须用本函数，
        否则一个 ``permissions: []`` 的角色会意外拿到「全部」。
    """
    if not role:
        return False
    perms = role.get("permissions")
    if not isinstance(perms, list):
        return False
    return any(
        isinstance(p, dict) and str(p.get("pageKey", "")) == page_key for p in perms
    )


def resolve_agent_scope(
    phone: str = "",
    user_id: str = "",
    name: str = "",
    role_id: str = "",
    role_name: str = "",
    page_key: str = AGENT_PAGE_KEY,
) -> dict[str, Any]:
    """解析「当前用户 + 其在某个页面上的数据范围」。

    身份可只给一部分：优先用账号（phone/id/name）反查其 roleId / roleName；
    账号查不到时，退回用请求里带的 role_id / role_name。

    ``page_key`` 默认「AI 助手」（Agent 业务工具的数据范围）；查「Agent 控制面板」
    的可见范围时传 ``PANEL_PAGE_KEY``。

    返回：
        {
          "found": bool,           # 是否解析到账号或角色
          "scope": "全部" | "仅自己",
          "page_key": str,
          "page_configured": bool, # 角色里是否**显式配了**该页面（未配 ≠ 全部）
          "user_name": str,        # 用于与业务数据的归属字段比对
          "user_phone": str,
          "role_id": str, "role_name": str,
          "restricted": bool,      # scope == 仅自己 且 有可比对的用户名
          "monthly_token_quota": int,  # 该角色每月的 token 额度（每人各自）
        }
    """
    acct = find_account(phone=phone, user_id=user_id, name=name)

    eff_name = str((acct or {}).get("name", "") or name or "").strip()
    eff_phone = str((acct or {}).get("phone", "") or phone or "").strip()
    eff_role_id = str((acct or {}).get("roleId", "") or role_id or "").strip()
    eff_role_name = str((acct or {}).get("roleName", "") or role_name or "").strip()

    role = find_role(eff_role_id, eff_role_name)
    scope = page_scope(role, page_key)

    return {
        "found": bool(acct or role),
        "scope": scope,
        "page_key": page_key,
        "page_configured": page_is_configured(role, page_key),
        "user_name": eff_name,
        "user_phone": eff_phone,
        "role_id": eff_role_id,
        "role_name": eff_role_name,
        "restricted": scope == SCOPE_SELF and bool(eff_name or eff_phone),
        "monthly_token_quota": role_monthly_quota(role),
    }


def can_view_all_page_scope(info: dict[str, Any]) -> bool:
    """**严格判定**：该身份能否看到某页面的「全部」数据。

    ⚠️ 与 ``info["restricted"]`` 的区别：``restricted`` 沿用项目「范围解析不到就
       不收紧」的既有约定（供 Agent 业务工具复用）；本函数用于隐私敏感的统计类
       接口，三条**同时**满足才算「能看全部」：

        ① 身份解析到了账号或角色（``found``）
        ② 角色里**显式配置**了该页面（``page_configured``）—— 没配视为未授权
        ③ 该页面的 ``dataScope == "全部"``

    任一不满足 → ``False``（只看自己）。**拿不到身份 → 只看自己 → 空集**，
    所以裸调接口（不带身份）不会泄露他人数据。
    """
    return (
        bool(info.get("found"))
        and bool(info.get("page_configured"))
        and info.get("scope") == SCOPE_ALL
    )


def role_monthly_quota(role: dict[str, Any] | None) -> int:
    """取角色每月的 token 额度（每个用户各自享用）。

    - 角色里没有该字段 / 非法值（负数、非数字） → 回落 ``DEFAULT_MONTHLY_TOKEN_QUOTA``
    - ``0`` 视为**不限额**（管理员可显式置 0 关闭限制）
    """
    if not role:
        return DEFAULT_MONTHLY_TOKEN_QUOTA
    raw = role.get("monthlyTokenQuota")
    if raw is None or raw == "":
        return DEFAULT_MONTHLY_TOKEN_QUOTA
    try:
        val = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MONTHLY_TOKEN_QUOTA
    if val >= 0:
        return val
    return DEFAULT_MONTHLY_TOKEN_QUOTA


def describe(scope_info: dict[str, Any]) -> str:
    """给日志/调试用的一行摘要。"""
    return (
        f"user={scope_info.get('user_name') or '-'} "
        f"role={scope_info.get('role_name') or '-'} "
        f"scope={scope_info.get('scope')} "
        f"restricted={scope_info.get('restricted')} "
        f"quota={scope_info.get('monthly_token_quota')}"
    )
