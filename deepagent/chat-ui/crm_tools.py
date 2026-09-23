"""
CRM 业务数据工具集（读取 + 写入，两套）
======================================

让 chat-ui 的 Agent 直接读写本工作区 CRM 项目的 JSON 业务数据。
数据目录默认 `<工作区>/CRM_Agent1.0/data`，可用环境变量 `CRM_DATA_DIR` 覆盖。

套一 · 读取（无副作用，直接放行）
    - crm_list_entities   列出实体、字段与记录数（建议先调它了解数据结构）
    - crm_query           按条件 / 关键词查询，返回 Markdown 表格
    - crm_get             按 id 取单条完整记录
    - crm_stats           统计：总数 / 按字段分组计数 / 数值字段求和均值

套二 · 写入（新增 / 修改受人工审批保护，见 chat-ui/server.py）
    - crm_create          新增一条                    → 人工审批
    - crm_update          按 id 修改若干字段           → 人工审批
    - crm_delete          按 id 删除一条               → 禁止执行（仅作为「拦截桩」暴露给模型，
                                                        调用必被运行时拒绝，前端弹出「禁止」提示）

写入安全：进程内互斥锁 + 临时文件原子替换，避免并发把 JSON 写坏。
落盘格式与原文件保持一致（UTF-8、indent=2、CRLF、无 BOM、末尾无换行）。
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

# --------------------------------------------------------------------------
# 数据目录
# --------------------------------------------------------------------------


def _resolve_data_dir() -> Path:
    env = (os.environ.get("CRM_DATA_DIR") or "").strip()
    if env:
        return Path(env)
    # 本文件位于 <工作区>/deepagents/chat-ui/ 下，CRM 与 deepagents 同级
    here = Path(__file__).resolve().parent      # .../deepagents/chat-ui
    workspace = here.parent.parent              # .../deepagent
    return workspace / "CRM_Agent1.0" / "data"


CRM_DATA_DIR: Path = _resolve_data_dir()


# --------------------------------------------------------------------------
# 实体注册表
# --------------------------------------------------------------------------

ENTITIES: dict[str, dict[str, Any]] = {
    "leads": {
        "file": "leads.json",
        "label": "销售线索",
        "id_prefix": "LD-2026-",
        "created_field": "createdAt",
        "fields": {
            "id": "线索编号（系统生成，如 LD-2026-0001）",
            "createdAt": "创建时间（YYYY-MM-DD HH:MM）",
            "name": "客户姓名",
            "phone": "客户电话",
            "priority": "优先级：high / medium / low",
            "source": "来源渠道（如 抖音 / 微信 / 官网）",
            "assignee": "跟进销售",
            "email": "客户邮箱",
            "status": "状态（如 成交 / 跟进中 / 已流失）",
            "lastFollowUpAt": "最近跟进时间",
            "intentProduct": "意向产品",
            "budgetRange": "预算区间（如 3000-5000元）",
            "remark": "备注",
            "customerPosition": "客户职位",
            "trialDuration": "试用时长（天）",
            "communicationCount": "沟通次数",
            "idCard": "客户身份证号",
        },
        "numeric": ["trialDuration", "communicationCount"],
        "search": ["name", "phone", "email", "assignee", "source", "remark",
                   "intentProduct", "customerPosition", "status"],
        "list_fields": ["id", "name", "phone", "priority", "source", "assignee",
                        "status", "intentProduct", "createdAt"],
        # 「仅自己」数据范围时的归属字段：记录里存的是**销售姓名**
        "owner_field": "assignee",
    },
    "orders": {
        "file": "orders.json",
        "label": "订单",
        "id_prefix": "OD-2026-",
        "created_field": "createdAt",
        "fields": {
            "id": "订单记录编号（系统生成，如 OD-2026-0001）",
            "createdAt": "创建时间",
            "orderNo": "订单号（业务单号，如 ORD-20240105001）",
            "customerName": "客户姓名",
            "customerPhone": "客户电话",
            "productId": "产品记录编号",
            "productNo": "产品编号（如 PROD-001）",
            "productName": "产品名称",
            "amount": "订单金额（元）",
            "serviceTermMonths": "服务期限（月）",
        },
        "numeric": ["amount", "serviceTermMonths"],
        "search": ["orderNo", "customerName", "customerPhone", "productName", "productNo"],
        "list_fields": ["id", "orderNo", "customerName", "productName", "amount",
                        "serviceTermMonths", "createdAt"],
        # ⚠️ 订单表**没有**归属字段（无 assignee / 销售 字段），也不宜按客户姓名间接关联
        #    （同名客户会误判）→ 视为公共业务数据，「仅自己」范围下不做行过滤。
        "owner_field": None,
    },
    "products": {
        "file": "products.json",
        "label": "产品",
        "id_prefix": "PD-2026-",
        "created_field": "createdAt",
        "fields": {
            "id": "产品记录编号（系统生成，如 PD-2026-0001）",
            "createdAt": "创建时间",
            "productNo": "产品编号（如 PROD-001）",
            "name": "产品名称",
            "price": "单价（元）",
        },
        "numeric": ["price"],
        "search": ["name", "productNo"],
        "list_fields": ["id", "productNo", "name", "price", "createdAt"],
        # 产品是公共基础数据，无归属概念
        "owner_field": None,
    },
    "accounts": {
        "file": "accounts.json",
        "label": "账号",
        "id_prefix": "ACCT-2026-",
        "created_field": "createdAt",
        "fields": {
            "id": "账号记录编号（系统生成，如 ACCT-2026-0001）",
            "createdAt": "创建时间",
            "phone": "登录手机号",
            "name": "账号姓名",
            "roleId": "角色编号",
            "roleName": "角色名称（如 管理员 / 销售）",
            "password": "登录密码（读取时会被脱敏为 ******）",
        },
        "numeric": [],
        "search": ["name", "phone", "roleName", "roleId"],
        "list_fields": ["id", "name", "phone", "roleName", "createdAt"],
        # ⚠️ 账号表虽有自己的 `name`，但「仅自己」时**不能**用它过滤 —— 那会让销售
        #    只能看到自己这一条账号记录，却看不到任何业务数据。账号属公共/管理数据。
        "owner_field": None,
    },
    "communications": {
        "file": "communications.json",
        "label": "沟通记录",
        "id_prefix": "COMM-2026-",
        "created_field": "sentAt",
        "fields": {
            "id": "沟通记录编号（系统生成，如 COMM-2026-0001）",
            "leadId": "所属线索编号（如 LD-2026-0011）",
            "sentAt": "发送时间",
            "sender": "发送人",
            "senderRole": "发送人角色（如 销售 / 客户）",
            "content": "沟通内容",
            "type": "类型（如 主动联系 / 客户回复）",
            "channel": "渠道（如 微信 / 电话）",
        },
        "numeric": [],
        "search": ["content", "sender", "type", "channel", "leadId", "senderRole"],
        "list_fields": ["id", "leadId", "sentAt", "sender", "type", "channel", "content"],
        # 沟通记录按**发送人**归属；「仅自己」时另叠加 leadId 归属线索的过滤（见 _scope_rows）
        "owner_field": "sender",
    },
    "sales-targets": {
        "file": "sales-targets.json",
        "label": "销售目标",
        "id_prefix": "ST-2026-",
        "created_field": None,
        "fields": {
            "id": "记录编号（系统生成，如 ST-2026-0001）",
            "salesId": "销售工号（如 S001）",
            "name": "销售姓名",
            "department": "部门",
            "position": "职位",
            "hireDate": "入职日期",
            "phone": "联系电话",
            "email": "邮箱",
            "region": "区域（如 华北区）",
            "month": "月份（如 2026-06）",
            "target": "月度目标额（元）",
            "status": "在职状态",
        },
        "numeric": ["target"],
        "search": ["name", "salesId", "department", "region", "month", "position"],
        "list_fields": ["id", "salesId", "name", "department", "region", "month",
                        "target", "status"],
        # 销售目标按**销售姓名**归属
        "owner_field": "name",
    },
}

# 中文/单复数别名 -> 规范实体名
_ALIASES = {
    "lead": "leads", "线索": "leads", "销售线索": "leads",
    "order": "orders", "订单": "orders",
    "product": "products", "产品": "products",
    "account": "accounts", "账号": "accounts", "账户": "accounts",
    "communication": "communications", "comm": "communications", "comms": "communications",
    "沟通": "communications", "沟通记录": "communications",
    "sales_target": "sales-targets", "sales_targets": "sales-targets",
    "sales-target": "sales-targets", "target": "sales-targets", "targets": "sales-targets",
    "销售目标": "sales-targets",
}

# 敏感字段：读取时脱敏
_SECRET_FIELDS = {"accounts": ("password",)}

_LOCK = threading.RLock()


# --------------------------------------------------------------------------
# 数据范围（角色权限）：当前用户 + 「全部 / 仅自己」
# --------------------------------------------------------------------------
#
# 背景：CRM 的角色权限里每个页面都带 `dataScope`（全部 / 仅自己）。本模块让 **Agent 侧**
# 的 CRM 读写工具也遵守它，而不是让 Agent 无条件读写全部数据。
#
# ⚠️ 为什么用「上下文变量」而不是工具参数：
#    - 工具签名是**给模型看的**，多一个 user/scope 参数字段既污染工具描述、又可被模型篡改；
#    - 工具是模块级单例，`build_agent()` 每请求重建 agent 但复用同一批工具对象，
#      所以身份必须走**每次请求重设的上下文**，而不是构造参数。
#    用 `ContextVar`：天然随 async 任务隔离，不会在并发请求间串味。
#
# 语义：
#    scope="全部"   → 不做任何行过滤（默认，保持既有行为）
#    scope="仅自己" → 只允许访问 owner_field == 当前用户 的记录；公共实体（owner_field 为 None）放行
#
# idCard 等敏感字段、以及 password 的脱敏与范围无关，保持原样。

from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class DataScope:
    """本轮请求的数据范围上下文。"""

    scope: str = "全部"          # "全部" | "仅自己"
    user_name: str = ""          # 当前登录用户姓名（与 owner_field 的值域一致）
    user_phone: str = ""         # 备用匹配键（部分实体可能存电话）

    @property
    def restricted(self) -> bool:
        return self.scope == "仅自己" and bool(self.user_name or self.user_phone)


# 默认「全部」：未显式设置（定时任务 / 飞书 / 测试）时保持原有全量行为，避免误伤
_SCOPE: ContextVar[DataScope] = ContextVar("crm_data_scope", default=DataScope())


def set_data_scope(scope: str = "全部", user_name: str = "", user_phone: str = "") -> DataScope:
    """设置本轮请求的数据范围（由 server.py 在每次 chat 请求开始时调用）。返回生效值。"""
    eff = DataScope(
        scope="仅自己" if str(scope).strip() == "仅自己" else "全部",
        user_name=str(user_name or "").strip(),
        user_phone=str(user_phone or "").strip(),
    )
    _SCOPE.set(eff)
    return eff


def get_data_scope() -> DataScope:
    return _SCOPE.get()


def _reset_data_scope() -> None:
    """恢复默认（全部）。测试 / 收尾用。"""
    _SCOPE.set(DataScope())


def _owner_keys(ent: str, rec: dict) -> list[str]:
    """取一条记录的「归属标识」候选值（用于与当前用户比对）。"""
    meta = ENTITIES.get(ent) or {}
    field = meta.get("owner_field")
    if not field:
        return []
    val = str(rec.get(field, "") or "").strip()
    return [val] if val else []


def _owned_by_current(ent: str, rec: dict, ds: DataScope) -> bool:
    """记录是否归属于当前用户。"""
    keys = _owner_keys(ent, rec)
    if not keys:
        # 归属字段存在但该条记录值为空 → 视为无归属（公共），放行
        return True
    mine = {k for k in (ds.user_name, ds.user_phone) if k}
    return any(k in mine for k in keys)


def _scope_rows(ent: str, rows: list[dict]) -> list[dict]:
    """按当前数据范围过滤记录集合。「全部」或无归属字段时原样返回。

    communications 额外叠加一条：`leadId` 指向的线索若归属自己，则这些沟通记录也可见
    （销售跟进自己的线索时产生的记录，理应看得到）。
    """
    ds = get_data_scope()
    if not ds.restricted:
        return rows

    meta = ENTITIES.get(ent) or {}
    if not meta.get("owner_field"):
        return rows  # 公共实体（products / accounts / orders）不做行过滤

    kept = [r for r in rows if _owned_by_current(ent, r, ds)]

    if ent == "communications":
        # 叠加：归属线索下的沟通记录也可见
        try:
            lead_rows = _read_rows("leads")
        except Exception:  # noqa: BLE001
            lead_rows = []
        my_lead_ids = {
            str(r.get("id", "")) for r in lead_rows if _owned_by_current("leads", r, ds)
        }
        seen = {str(r.get("id", "")) for r in kept}
        for r in rows:
            rid = str(r.get("id", ""))
            if rid in seen:
                continue
            if str(r.get("leadId", "")) in my_lead_ids:
                kept.append(r)
                seen.add(rid)

    return kept


def _scope_denied(ent: str, rec: dict) -> str | None:
    """记录不可写时返回拒绝原因（含中文说明），可写则返回 None。"""
    ds = get_data_scope()
    if not ds.restricted:
        return None
    meta = ENTITIES.get(ent) or {}
    if not meta.get("owner_field"):
        return None  # 公共实体不限制
    if _owned_by_current(ent, rec, ds):
        return None
    owner = "、".join(_owner_keys(ent, rec)) or "(空)"
    return (
        f"无权操作：该{meta['label']}记录归属 {owner}，而当前账号为「仅自己」数据范围"
        f"（{ds.user_name or ds.user_phone}），不能读改他人数据。"
    )


def apply_owner_on_create(ent: str, obj: dict) -> tuple[dict, str | None]:
    """「仅自己」时，把新增记录的归属字段**强制**改写成当前用户。

    ⚠️ 是覆盖而非「仅补空」：否则模型（或被诱导的模型）仍可显式传 `assignee=李华`
    把数据挂到别人名下 —— 那就绕过了数据范围。范围权限必须是**服务端说了算**。

    返回 ``(改写后的数据, 被覆盖的原值或 None)``。
    """
    ds = get_data_scope()
    meta = ENTITIES.get(ent) or {}
    field = meta.get("owner_field")
    if not ds.restricted or not field or not ds.user_name:
        return obj, None
    cur = str(obj.get(field, "") or "").strip()
    if cur == ds.user_name:
        return obj, None
    out = dict(obj)
    out[field] = ds.user_name
    return out, (cur or None)


# --------------------------------------------------------------------------
# 基础读写
# --------------------------------------------------------------------------


def _canon(entity: str) -> str:
    key = str(entity or "").strip()
    low = key.lower()
    if low in ENTITIES:
        return low
    if low in _ALIASES:
        return _ALIASES[low]
    if key in _ALIASES:
        return _ALIASES[key]
    raise ValueError(
        f"未知实体「{entity}」。可用实体：{', '.join(ENTITIES)}"
    )


def _path(entity: str) -> Path:
    return CRM_DATA_DIR / ENTITIES[entity]["file"]


def _read_rows(entity: str) -> list[dict]:
    p = _path(entity)
    if not p.is_file():
        return []
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else []


def _write_rows(entity: str, rows: list[dict]) -> None:
    p = _path(entity)
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(rows, ensure_ascii=False, indent=2).replace("\n", "\r\n")
    tmp = p.with_name(p.name + ".tmp")
    # newline="" 阻止 Python 再把 \n 翻译成 \r\n，保持与原始文件一致
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, p)


def _next_id(entity: str, rows: list[dict]) -> str:
    meta = ENTITIES[entity]
    prefix = meta["id_prefix"]
    pat = re.compile(rf"^{re.escape(prefix)}(\d+)$")
    top = 0
    for r in rows:
        m = pat.match(str(r.get("id", "")))
        if m:
            top = max(top, int(m.group(1)))
    return f"{prefix}{top + 1:04d}"


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _coerce(meta: dict, key: str, value: Any) -> Any:
    """按实体定义把数值字段转成数字（LLM 常把数字给成字符串）。"""
    if key in (meta.get("numeric") or []) and isinstance(value, str):
        s = value.strip().replace(",", "").replace("，", "")
        try:
            return int(s) if re.fullmatch(r"-?\d+", s) else float(s)
        except Exception:
            return value
    return value


def _redact(entity: str, rec: dict) -> dict:
    secrets = _SECRET_FIELDS.get(entity)
    if not secrets:
        return rec
    out = dict(rec)
    for s in secrets:
        if s in out and out[s]:
            out[s] = "******"
    return out


def _parse_obj(raw: Any, what: str) -> dict:
    if isinstance(raw, dict):
        return raw
    s = str(raw or "").strip()
    if not s:
        return {}
    try:
        obj = json.loads(s)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"{what} 不是合法 JSON 对象：{exc}") from exc
    if not isinstance(obj, dict):
        raise ValueError(f"{what} 必须是 JSON 对象（键值对）")
    return obj


def _parse_filters(raw: Any) -> dict:
    """支持 JSON 对象字符串，或 `k=v, k2=v2` 形式。"""
    if isinstance(raw, dict):
        return {str(k): v for k, v in raw.items()}
    s = str(raw or "").strip()
    if not s:
        return {}
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return {str(k): v for k, v in obj.items()}
    except Exception:
        pass
    out: dict[str, Any] = {}
    for part in re.split(r"[,;，；]\s*", s):
        part = part.strip()
        if not part:
            continue
        for sep in ("=", ":", "："):
            if sep in part:
                k, v = part.split(sep, 1)
                out[k.strip()] = v.strip()
                break
    return out


def _match(rec: dict, filters: dict) -> bool:
    for k, v in filters.items():
        if k not in rec:
            return False
        rv = rec.get(k)
        if str(rv).strip().lower() == str(v).strip().lower():
            continue
        try:
            if float(rv) == float(str(v).replace(",", "")):
                continue
        except Exception:
            pass
        return False
    return True


def _md_table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for r in rows:
        out.append("| " + " | ".join(str(c).replace("|", "\\|").replace("\n", " ") for c in r) + " |")
    return "\n".join(out)


def _cell(entity: str, field: str, value: Any, width: int = 46) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\n", " ").strip()
    if len(text) > width:
        text = text[: width - 1] + "…"
    return text


def _fmt_record(entity: str, rec: dict) -> str:
    meta = ENTITIES[entity]
    red = _redact(entity, rec)
    lines = []
    for k in meta["fields"]:
        if k in red:
            lines.append(f"- **{k}**: {red[k]}")
    for k, v in red.items():
        if k not in meta["fields"]:
            lines.append(f"- **{k}**: {v}")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 套一 · 读取工具
# --------------------------------------------------------------------------


@tool
def crm_list_entities() -> str:
    """列出 CRM 中所有可用的业务数据实体（表）、字段说明与当前记录数。

    这是了解 CRM 数据结构的第一步：不确定有哪些数据、某个字段叫什么名字时先调用它。
    返回值中每个实体名（如 leads、orders）可直接作为 crm_query / crm_get / crm_stats
    以及写入工具的 entity 参数。
    """
    lines = [f"CRM 数据目录：{CRM_DATA_DIR}", ""]
    ds = get_data_scope()
    if ds.restricted:
        lines.append(
            f"⚠️ 当前数据范围：**仅自己**（{ds.user_name or ds.user_phone}）——"
            f"下列记录数为**你可见的**条数；无归属字段的实体为公共数据。"
        )
        lines.append("")
    for name, meta in ENTITIES.items():
        try:
            rows = _scope_rows(name, _read_rows(name))
            count = len(rows)
            total = len(_read_rows(name))
        except Exception:  # noqa: BLE001
            count = -1
            total = -1
        suffix = f"当前 {count} 条"
        if ds.restricted and meta.get("owner_field") and total >= 0 and count != total:
            suffix = f"当前 {count} 条（全部 {total} 条，已按「仅自己」过滤）"
        lines.append(f"## {name}（{meta['label']}）—— {suffix}")
        fields = "、".join(f"{k}" for k in meta["fields"])
        lines.append(f"字段：{fields}")
        lines.append(f"列表展示字段：{'、'.join(meta['list_fields'])}")
        lines.append("")
    return "\n".join(lines).strip()


@tool
def crm_query(
    entity: str,
    keyword: str = "",
    filters: str = "",
    limit: int = 20,
    offset: int = 0,
    sort_by: str = "",
    order: str = "desc",
) -> str:
    """查询 CRM 业务数据（只读）。返回 Markdown 表格。

    结果会自动按当前账号的数据范围过滤：若账号是「仅自己」，则只返回归属你的记录
    （线索按跟进销售、沟通记录按发送人、销售目标按姓名）；产品 / 账号 / 订单为公共数据不过滤。

    Args:
        entity: 实体名，如 leads / orders / products / accounts / communications / sales-targets。
        keyword: 关键词，在实体的文本字段里模糊匹配（如客户姓名、电话、订单号）。
        filters: 精确筛选，JSON 对象字符串或 `k=v,k2=v2`，例如 '{"source":"抖音"}' 或 'priority=high'。
        limit: 返回条数上限，默认 20。
        offset: 偏移量，用于分页，默认 0。
        sort_by: 排序字段，如 createdAt / amount。
        order: 排序方向，asc 或 desc（默认 desc）。
    """
    ent = _canon(entity)
    meta = ENTITIES[ent]
    with _LOCK:
        rows = _read_rows(ent)
    rows = _scope_rows(ent, rows)

    flt = _parse_filters(filters)
    if flt:
        rows = [r for r in rows if _match(r, flt)]
    if keyword:
        kw = keyword.strip().lower()
        keys = meta.get("search") or list(meta["fields"])
        rows = [r for r in rows if any(kw in str(r.get(k, "")).lower() for k in keys)]

    total = len(rows)

    if sort_by and sort_by in meta["fields"] and rows:
        numeric = sort_by in (meta.get("numeric") or [])
        def _key(r: dict):
            v = r.get(sort_by)
            if numeric:
                try:
                    return float(v)
                except Exception:
                    return float("-inf")
            return str(v)
        try:
            rows = sorted(rows, key=_key, reverse=(str(order).lower() != "asc"))
        except Exception:
            pass

    limit = max(1, min(int(limit or 20), 200))
    offset = max(0, int(offset or 0))
    page = rows[offset: offset + limit]

    if not page:
        return f"{meta['label']}（{ent}）：没有符合条件的记录（共 {total} 条）。"

    headers = meta["list_fields"]
    body = [[_cell(ent, h, _redact(ent, r).get(h)) for h in headers] for r in page]
    head = f"{meta['label']}（{ent}）：共 {total} 条，显示第 {offset + 1}-{offset + len(page)} 条"
    return head + "\n\n" + _md_table(headers, body)


@tool
def crm_get(entity: str, record_id: str) -> str:
    """按 id 读取一条 CRM 业务数据的完整字段（只读）。

    Args:
        entity: 实体名，如 leads / orders。
        record_id: 记录编号，如 LD-2026-0001。
    """
    ent = _canon(entity)
    with _LOCK:
        rows = _read_rows(ent)
    rows = _scope_rows(ent, rows)
    rid = str(record_id or "").strip()
    for r in rows:
        if str(r.get("id", "")).lower() == rid.lower():
            return f"{ENTITIES[ent]['label']} {rid}：\n" + _fmt_record(ent, r)
    return f"未找到记录：{ent} / {record_id}"


@tool
def crm_stats(entity: str, group_by: str = "", sum_field: str = "") -> str:
    """统计 CRM 业务数据（只读）。

    Args:
        entity: 实体名，如 leads。
        group_by: 按某个字段分组计数，如 source / priority / assignee / status。留空则只统计总数。
        sum_field: 可选，对某个数值字段求和/求均值，如 amount / price / target。
    """
    ent = _canon(entity)
    meta = ENTITIES[ent]
    with _LOCK:
        rows = _read_rows(ent)
    rows = _scope_rows(ent, rows)

    if not rows:
        return f"{meta['label']}（{ent}）：暂无数据。"

    lines = [f"{meta['label']}（{ent}）统计："]
    lines.append(f"- 总记录数：{len(rows)}")

    if sum_field and sum_field in meta["fields"]:
        vals = []
        for r in rows:
            try:
                vals.append(float(r.get(sum_field)))
            except Exception:
                pass
        if vals:
            lines.append(
                f"- {sum_field} 合计：{sum(vals):.2f}，均值：{sum(vals) / len(vals):.2f}"
                f"，最大：{max(vals):.2f}，最小：{min(vals):.2f}"
            )
        else:
            lines.append(f"- {sum_field} 无数值可统计")

    if group_by:
        field = group_by.strip()
        if field not in meta["fields"]:
            return "\n".join(lines) + f"\n\n（提示：字段 {field} 不存在，可用字段见 crm_list_entities）"
        counts: dict[str, int] = {}
        for r in rows:
            key = str(r.get(field, "") or "(空)")
            counts[key] = counts.get(key, 0) + 1
        lines.append("")
        lines.append(f"按 {field} 分组：")
        lines.append(_md_table([field, "数量"], [[k, v] for k, v in sorted(counts.items(), key=lambda x: -x[1])]))

    return "\n".join(lines)


# --------------------------------------------------------------------------
# 套二 · 写入工具（在 chat-ui 中受人工审批保护）
# --------------------------------------------------------------------------


@tool
def crm_create(entity: str, data: str) -> str:
    """新增一条 CRM 业务数据（写入，需要人工审批）。

    若当前账号是「仅自己」数据范围，归属字段（线索的 assignee、沟通记录的 sender、
    销售目标的 name）会**自动填成当前登录用户**，无需也不应手动指定他人。

    Args:
        entity: 实体名，如 leads / orders / products / accounts / communications / sales-targets。
        data: JSON 对象字符串，只填业务字段，例如
              '{"name":"张三","phone":"13800000000","source":"抖音","priority":"high"}'。
              系统会自动生成 id 与创建时间，无需提供。
    """
    ent = _canon(entity)
    meta = ENTITIES[ent]
    obj = _parse_obj(data, "data")
    if not obj:
        return "新增失败：data 为空，请给出要写入的字段。"

    # 「仅自己」范围：归属字段强制改写为当前用户（不能用模型传的值）
    obj, overridden = apply_owner_on_create(ent, obj)
    owner_field = (ENTITIES[ent] or {}).get("owner_field")

    unknown = [k for k in obj if k not in meta["fields"]]
    with _LOCK:
        rows = _read_rows(ent)
        rec: dict[str, Any] = {}
        rec["id"] = _next_id(ent, rows)
        cf = meta.get("created_field")
        if cf:
            rec[cf] = obj.get(cf) or _now()
        for k, v in obj.items():
            if k == "id" or k == cf:
                continue
            rec[k] = _coerce(meta, k, v)
        rows.append(rec)
        _write_rows(ent, rows)

    msg = f"已新增 {meta['label']}：{rec['id']}"
    if overridden and owner_field:
        msg += (
            f"（⚠️ 当前为「仅自己」数据范围，{owner_field} 已由 `{overridden}` "
            f"强制改写为当前用户）"
        )
    if unknown:
        msg += f"（注意：字段 {', '.join(unknown)} 不在标准模型中，已按原样写入）"
    return msg + "\n" + _fmt_record(ent, rec)


@tool
def crm_update(entity: str, record_id: str, data: str) -> str:
    """按 id 修改一条 CRM 业务数据（写入，需要人工审批）。

    「仅自己」数据范围下只能修改归属自己的记录，改他人数据会被拒绝并返回原因。

    Args:
        entity: 实体名，如 leads / orders。
        record_id: 要修改的记录编号，如 LD-2026-0001。
        data: JSON 对象字符串，只放需要修改的字段，例如 '{"priority":"low","status":"已流失"}'。
    """
    ent = _canon(entity)
    meta = ENTITIES[ent]
    obj = _parse_obj(data, "data")
    if not obj:
        return "修改失败：data 为空，请给出要修改的字段。"
    if "id" in obj:
        obj.pop("id")

    rid = str(record_id or "").strip()
    owner_field = meta.get("owner_field")
    ds_restricted = get_data_scope().restricted
    with _LOCK:
        rows = _read_rows(ent)
        hit = None
        for r in rows:
            if str(r.get("id", "")).lower() == rid.lower():
                hit = r
                break
        if hit is None:
            return f"未找到记录：{ent} / {record_id}"
        denied = _scope_denied(ent, hit)
        if denied:
            return denied
        changed = []
        skipped_owner = None
        for k, v in obj.items():
            if k not in meta["fields"]:
                continue
            # 「仅自己」时禁止改归属字段（防「甩锅」给他人 / 把他人数据认领到自己名下）
            if owner_field and k == owner_field and ds_restricted:
                skipped_owner = str(v)
                continue
            old = hit.get(k)
            new = _coerce(meta, k, v)
            if str(old) != str(new):
                hit[k] = new
                changed.append(f"{k}: {old} → {new}")
        _write_rows(ent, rows)

    if not changed:
        extra = ""
        if skipped_owner is not None:
            extra = f"（⚠️ 归属字段 {owner_field} 在「仅自己」范围下不可修改，已忽略）"
        return f"{meta['label']} {rid} 没有字段发生变化。{extra}"
    msg = f"已修改 {meta['label']} {rid}：\n- " + "\n- ".join(changed)
    if skipped_owner is not None:
        msg += f"\n（⚠️ 归属字段 {owner_field} 在「仅自己」范围下不可修改，已忽略你传入的「{skipped_owner}」）"
    return msg


@tool
def crm_delete(entity: str, record_id: str) -> str:
    """按 id 删除一条 CRM 业务数据（写入，需要人工审批）。

    Args:
        entity: 实体名，如 leads / orders。
        record_id: 要删除的记录编号，如 LD-2026-0001。删除后不可恢复，请谨慎。
    """
    ent = _canon(entity)
    meta = ENTITIES[ent]
    rid = str(record_id or "").strip()
    with _LOCK:
        rows = _read_rows(ent)
        target = next(
            (r for r in rows if str(r.get("id", "")).lower() == rid.lower()), None
        )
        if target is None:
            return f"未找到记录：{ent} / {record_id}"
        denied = _scope_denied(ent, target)
        if denied:
            return denied
        keep = [r for r in rows if str(r.get("id", "")).lower() != rid.lower()]
        _write_rows(ent, keep)
    return f"已删除 {meta['label']} {rid}（剩余 {len(keep)} 条）。"


# 工具集合导出
READ_TOOLS = [crm_list_entities, crm_query, crm_get, crm_stats]
WRITE_TOOLS = [crm_create, crm_update, crm_delete]
ALL_TOOLS = READ_TOOLS + WRITE_TOOLS

# 工具名集合（供权限策略判断）
READ_TOOL_NAMES = {t.name for t in READ_TOOLS}
WRITE_TOOL_NAMES = {t.name for t in WRITE_TOOLS}

# --------------------------------------------------------------------------
# 权限策略（由 chat-ui/server.py 消费）
# --------------------------------------------------------------------------
#   读取   → 直接放行（不登记审批，也不需要拦截）
#   新增/修改 → 需人工审批（登记进框架 HumanInTheLoopMiddleware 的 interrupt_on）
#   删除   → 禁止执行：工具仍暴露给模型（作为「拦截桩」），但运行时一律拒绝，
#            并向前端推送「禁止」提示；物理上无法删除任何数据
APPROVAL_TOOL_NAMES: set[str] = {"crm_create", "crm_update"}
DENIED_TOOL_NAMES: set[str] = {"crm_delete"}
ALLOWED_TOOL_NAMES: set[str] = READ_TOOL_NAMES | APPROVAL_TOOL_NAMES

# 暴露给 Agent 的写入工具：三个都暴露。crm_delete 是「拦截桩」—— 模型可见、可调用，
# 但 server.py 的 FsApprovalMiddleware 会一律拒绝并推送 tool_blocked 事件。
AGENT_WRITE_TOOLS = list(WRITE_TOOLS)

# 数据范围（角色权限）：server.py 在每次 chat 请求开始时调用 `set_data_scope(scope, user_name, user_phone)`，
# 之后本轮内所有 crm_* 工具调用都会自动按该范围过滤（读取过滤行、写入校验归属）。
# 相关 API：set_data_scope / get_data_scope / _reset_data_scope / DataScope
