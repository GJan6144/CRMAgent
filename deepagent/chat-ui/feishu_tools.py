"""飞书渠道通信 —— 工具集 + 接收消息长连接。

基于飞书官方 Python SDK（lark-oapi）实现，提供三类能力：

1. ``feishu_send_message``      —— 发送文本消息到群聊 / 私聊（应用身份，无需用户授权）；
2. ``feishu_reply_message``     —— 回复某条消息（应用身份）；
3. ``feishu_search_contacts``   —— 搜索通讯录用户（**用户身份**，需先完成 OAuth 授权）；
4. ``feishu_create_calendar_event`` —— 在日历上新建日程（**用户身份**）；
5. ``feishu_list_calendar_events``  —— 查询指定时间段的日程（**用户身份**）。

⚠️ 日历相关工具（4、5）要求应用在开发者后台开通「日历」权限，
且用户 OAuth 授权时申请的 scope 里含日历 scope（见 ``CALENDAR_SCOPE``）；
否则接口会返回无权限错误。

接收消息走 WebSocket 长连接（``lark.ws.Client``），订阅 ``im.message.receive_v1``，
收到消息后回调把结构化信息投进 ``message_queue``，由 ``server.py`` 的异步 worker 消费、
落库并调用 Agent 处理。

凭证从环境变量读取（``.env``）：``FEISHU_APP_ID`` / ``FEISHU_APP_SECRET``。
"""
from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from langchain_core.tools import tool

# 渠道数据层：凭证与开关统一从 channel_config 读（优先面板配置，回退 .env）
import channel_config  # noqa: E402


def _app_id() -> str:
    # 动态读：server.py 在 import 本模块**之后**才加载 .env，模块级常量会读到空；
    # 且凭证可能被面板「渠道管理」覆盖，所以一律在调用时从 channel_config 读取。
    return channel_config.get_credentials("feishu")[0]


def _app_secret() -> str:
    return channel_config.get_credentials("feishu")[1]

# OAuth 回调地址（需在飞书后台「安全设置 → 重定向 URL」配置）
REDIRECT_URI = os.environ.get("FEISHU_REDIRECT_URI", "").strip() or \
    "http://127.0.0.1:8765/api/feishu/oauth/callback"

# 搜通讯录所需的 OAuth scope：搜索用户（contact:user:search，飞书权限列表「搜索用户」的标识）
# + 读取用户基本信息 + 长期刷新
SEARCH_SCOPE = "contact:user:search contact:user.base:readonly offline_access"

# 日历所需的 OAuth scope：calendar:calendar（「更新日历及日程信息」，
# 已包含 readonly 的全部授权：创建/更新日程 + 获取日历、日程、忙闲）
CALENDAR_SCOPE = "calendar:calendar"

# 用户 OAuth 授权时申请的完整 scope（搜通讯录 + 日历，空格分隔）。
# ⚠️ 这里每一项都必须先在飞书开发者后台「权限管理」开通并发布版本，
#    否则授权页会报「当前应用未申请该权限」导致用户无法完成授权。
AUTH_SCOPE = f"{SEARCH_SCOPE} {CALENDAR_SCOPE}"

# 飞书开放平台 API 根地址（日历接口拼路径用）
FEISHU_API_BASE = "https://open.feishu.cn/open-apis"

# 日历时间解析用的固定 UTC 偏移（形如 "+08:00"）；可用环境变量覆盖
CALENDAR_TZ_OFFSET = os.environ.get("FEISHU_CALENDAR_TZ_OFFSET", "").strip() or "+08:00"

# user_access_token 持久化文件（gitignore；含密钥）
USER_TOKEN_FILE = Path(__file__).resolve().parent / "feishu_user_token.json"

# 接收消息：WS 线程 -> 队列 -> server.py 异步 worker
message_queue: "queue.Queue[dict]" = queue.Queue()

_RECEIVER_STARTED = False


def configured() -> bool:
    # 渠道开启 且 凭证齐全，才认为可用
    return channel_config.is_enabled("feishu") and bool(_app_id() and _app_secret())


def _get_client():
    import lark_oapi as lark
    return lark.Client.builder().app_id(_app_id()).app_secret(_app_secret()).build()


def _no_config() -> str:
    return "飞书未配置：请在 .env 设置 FEISHU_APP_ID / FEISHU_APP_SECRET"


# --------------------------------------------------------------------------
# 发送 / 回复（应用身份）
# --------------------------------------------------------------------------

@tool
def feishu_send_message(receive_id: str, text: str, receive_id_type: str = "chat_id") -> str:
    """向飞书发送一条文本消息。

    Args:
        receive_id: 接收方 ID。群聊为 chat_id（oc_ 开头）；私聊为用户的 open_id（ou_ 开头）。
        text: 要发送的消息文本内容。
        receive_id_type: 接收方类型，默认 "chat_id"（群聊）；私聊请传 "open_id"。
    """
    if not configured():
        return _no_config()
    try:
        from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
        req = (CreateMessageRequest.builder()
               .receive_id_type(receive_id_type)
               .request_body(CreateMessageRequestBody.builder()
                   .receive_id(receive_id)
                   .msg_type("text")
                   .content(json.dumps({"text": text}, ensure_ascii=False))
                   .build())
               .build())
        resp = _get_client().im.v1.message.create(req)
        if resp.success():
            mid = getattr(getattr(resp, "data", None), "message_id", "") or ""
            return f"发送成功：message_id={mid}"
        return f"发送失败：code={resp.code} msg={resp.msg}"
    except Exception as e:  # noqa: BLE001
        return f"发送异常：{e}"


@tool
def feishu_reply_message(message_id: str, text: str) -> str:
    """回复飞书中的某条消息。

    Args:
        message_id: 要回复的消息 ID（om_ 开头）。
        text: 回复的文本内容。
    """
    if not configured():
        return _no_config()
    try:
        from lark_oapi.api.im.v1 import ReplyMessageRequest, ReplyMessageRequestBody
        req = (ReplyMessageRequest.builder()
               .message_id(message_id)
               .request_body(ReplyMessageRequestBody.builder()
                   .msg_type("text")
                   .content(json.dumps({"text": text}, ensure_ascii=False))
                   .build())
               .build())
        resp = _get_client().im.v1.message.reply(req)
        if resp.success():
            return "回复成功"
        return f"回复失败：code={resp.code} msg={resp.msg}"
    except Exception as e:  # noqa: BLE001
        return f"回复异常：{e}"


# --------------------------------------------------------------------------
# 搜通讯录（用户身份，需 OAuth 授权）
# --------------------------------------------------------------------------

def _load_user_token() -> dict:
    if USER_TOKEN_FILE.is_file():
        try:
            data = json.loads(USER_TOKEN_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def _save_user_token(data: dict) -> None:
    USER_TOKEN_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _refresh_user_token(data: dict) -> str:
    """用 refresh_token 换新 token；返回新的 access_token（失败返回空串）。"""
    refresh_token = data.get("refresh_token", "")
    if not refresh_token:
        return ""
    body = json.dumps({
        "grant_type": "refresh_token",
        "client_id": _app_id(),
        "client_secret": _app_secret(),
        "refresh_token": refresh_token,
    }).encode()
    req = urllib.request.Request(
        "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode())
        if d.get("code") == 0:
            data["access_token"] = d.get("access_token", "")
            data["refresh_token"] = d.get("refresh_token", refresh_token)
            data["expires_at"] = int(datetime.now(timezone.utc).timestamp()) + int(d.get("expires_in", 7200))
            _save_user_token(data)
            return data["access_token"]
    except Exception:
        pass
    return ""


def _get_valid_user_token() -> str:
    """返回有效的 user_access_token；过期则尝试刷新；无/失败返回空串。"""
    data = _load_user_token()
    token = data.get("access_token", "")
    if not token:
        return ""
    expires_at = data.get("expires_at", 0)
    if expires_at and int(datetime.now(timezone.utc).timestamp()) > int(expires_at) - 60:
        token = _refresh_user_token(data)
    return token


def get_authorize_url(state: str | None = None) -> str:
    """生成飞书 OAuth 授权地址（获取 user_access_token，供搜通讯录 / 日历使用）。"""
    state = state or uuid.uuid4().hex[:16]
    q = urllib.parse.urlencode({
        "app_id": _app_id(),
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": AUTH_SCOPE,
        "state": state,
    })
    return f"https://open.feishu.cn/open-apis/authen/v1/authorize?{q}"


def exchange_code(code: str) -> dict:
    """用授权码换 user_access_token；成功写入本地并返回 {ok, msg}。"""
    body = json.dumps({
        "grant_type": "authorization_code",
        "client_id": _app_id(),
        "client_secret": _app_secret(),
        "code": code,
        "redirect_uri": REDIRECT_URI,
    }).encode()
    req = urllib.request.Request(
        "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "msg": f"换取 token 异常：{e}"}
    if d.get("code") != 0:
        return {"ok": False, "msg": f"换取 token 失败：{d.get('msg') or d.get('code')}"}
    data = {
        "access_token": d.get("access_token", ""),
        "refresh_token": d.get("refresh_token", ""),
        "expires_at": int(datetime.now(timezone.utc).timestamp()) + int(d.get("expires_in", 7200)),
        "scope": d.get("scope", ""),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_user_token(data)
    return {"ok": True, "msg": "授权成功，已保存 user_access_token"}


@tool
def feishu_search_contacts(query: str, page_size: int = 20) -> str:
    """搜索飞书通讯录用户（按姓名关键词）。需要先完成飞书用户授权。

    Args:
        query: 搜索关键词（匹配用户名）。
        page_size: 返回条数，默认 20，最大 200。
    """
    token = _get_valid_user_token()
    if not token:
        return ("尚未完成用户授权：请先访问授权地址完成授权（授权地址由 /api/feishu/authorize-url 生成），"
                "或联系管理员补充授权。")
    url = ("https://open.feishu.cn/open-apis/search/v1/user?"
           f"query={urllib.parse.quote(query)}&page_size={min(max(page_size, 1), 200)}")
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        return f"搜索异常：{e}"
    if d.get("code") != 0:
        return f"搜索失败：code={d.get('code')} msg={d.get('msg')}"
    users = (d.get("data") or {}).get("users", [])
    if not users:
        return f"未找到匹配「{query}」的用户"
    lines = [f"共 {len(users)} 个匹配用户："]
    for u in users:
        name = u.get("name", "")
        uid = u.get("user_id", "")
        oid = u.get("open_id", "")
        depts = ",".join(u.get("department_ids") or [])
        lines.append(f"- {name}（user_id={uid}，open_id={oid}，部门={depts or '-'}）")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 日历 / 日程（用户身份，需 OAuth 授权 + 后台开通「日历」权限）
# --------------------------------------------------------------------------

def _tzinfo():
    """按 CALENDAR_TZ_OFFSET（形如 +08:00）返回固定偏移时区。"""
    s = CALENDAR_TZ_OFFSET.strip() or "+08:00"
    sign = -1 if s.startswith("-") else 1
    parts = (s.lstrip("+-").split(":") + ["0"])[:2]
    hours = int(parts[0] or 0)
    minutes = int(parts[1] or 0)
    return timezone(sign * timedelta(hours=hours, minutes=minutes))


def _to_timestamp(value: str) -> str:
    """把 '2026-09-24 18:00' / '2026-09-24T18:00:00' / 秒级时间戳 统一成字符串时间戳。"""
    v = (value or "").strip()
    if v.isdigit():
        return v
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return str(int(datetime.strptime(v, fmt).replace(tzinfo=_tzinfo()).timestamp()))
        except ValueError:
            continue
    raise ValueError(f"时间格式无法识别：{value}（示例：2026-09-24 18:00）")


def _fmt_ts(ts) -> str:
    """时间戳 -> 'YYYY-MM-DD HH:MM'（本地偏移）。"""
    try:
        return datetime.fromtimestamp(int(ts), tz=_tzinfo()).strftime("%Y-%m-%d %H:%M")
    except Exception:  # noqa: BLE001
        return str(ts)


def _calendar_request(method: str, path: str, body: dict | None = None,
                      params: dict | None = None) -> dict:
    """带用户身份的飞书开放平台请求，返回 {ok, code, msg, data}。"""
    token = _get_valid_user_token()
    if not token:
        return {"ok": False, "code": -1,
                "msg": "尚未完成用户授权：请先访问 /api/feishu/authorize-url 获取授权地址并完成授权", "data": {}}
    url = f"{FEISHU_API_BASE}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # ⚠️ 飞书在 4xx/5xx 时仍返回 JSON 体（含 code/msg），而 urlopen 遇 4xx 会直接抛异常、
        #    把 body 丢掉 —— 那样就拿不到「权限不足(99991679)」这类准确原因，
        #    下面 _permission_hint 的引导提示也就永远触发不了。此处必须把 body 读出来。
        try:
            d = json.loads(e.read().decode())
        except Exception:  # noqa: BLE001
            return {"ok": False, "code": -2,
                    "msg": f"请求异常：HTTP {e.code} {e.reason}", "data": {}}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "code": -2, "msg": f"请求异常：{e}", "data": {}}
    return {"ok": d.get("code") == 0, "code": d.get("code", -3),
            "msg": d.get("msg", ""), "data": d.get("data") or {}}


# 无权限类错误码（缺后台权限 / token 缺 scope），用于给出可操作提示
_PERMISSION_CODES = {99991672, 99991679, 99991663, 99991664, 20005, 20006}


def _permission_hint(code: int, msg: str) -> str:
    if code in _PERMISSION_CODES or "permission" in (msg or "").lower():
        return ("\n提示：大概率是权限不足 —— 需在飞书开发者后台「权限管理」开通日历权限并发布版本，"
                "然后重新完成用户授权（授权 URL 见 /api/feishu/authorize-url）。")
    return ""


def _resolve_calendar_id(calendar_id: str) -> str:
    """calendar_id 为空或 'primary' 时，解析为用户主日历 id。"""
    cid = (calendar_id or "").strip()
    if cid and cid.lower() not in ("primary", "主日历"):
        return cid
    res = _calendar_request("GET", "/calendar/v4/calendars/primary")
    if res["ok"]:
        cals = res["data"].get("calendars") or []
        if cals:
            got = (cals[0].get("calendar") or {}).get("calendar_id", "")
            if got:
                return got
    return "primary"


def _lookup_open_id(name: str) -> str:
    """按姓名在通讯录里找 open_id（优先精确匹配）。"""
    res = _calendar_request("GET", "/search/v1/user", params={"query": name, "page_size": 20})
    if not res["ok"]:
        return ""
    users = res["data"].get("users") or []
    for u in users:
        if u.get("name") == name and u.get("open_id"):
            return u["open_id"]
    return (users[0].get("open_id", "") if users else "")


@tool
def feishu_create_calendar_event(summary: str, start_time: str, end_time: str,
                                 description: str = "", attendees: str = "",
                                 calendar_id: str = "primary", notify: bool = True,
                                 timezone_name: str = "Asia/Shanghai") -> str:
    """在飞书日历上新建一个日程（用户身份，需已完成授权且开通日历权限）。

    Args:
        summary: 日程标题，如「中秋节假日」。
        start_time: 开始时间，支持 `2026-09-24 18:00` 或秒级时间戳。
        end_time: 结束时间，格式同上。
        description: 日程描述（可空）。
        attendees: 参与人，多个用英文逗号分隔；可填 open_id（ou_ 开头）或姓名。
        calendar_id: 日历 id，默认用户主日历（primary）。
        notify: 是否给参与人发送日程通知。
        timezone_name: 时区名，默认 Asia/Shanghai。
    """
    if not configured():
        return _no_config()
    try:
        start_ts = _to_timestamp(start_time)
        end_ts = _to_timestamp(end_time)
    except ValueError as e:  # noqa: BLE001
        return f"参数错误：{e}"
    if int(end_ts) <= int(start_ts):
        return "参数错误：结束时间必须晚于开始时间"

    cid = _resolve_calendar_id(calendar_id)

    att_ids, att_failed = [], []
    for raw in (attendees or "").replace("，", ",").split(","):
        item = raw.strip()
        if not item:
            continue
        oid = item if item.startswith(("ou_", "on_")) else _lookup_open_id(item)
        if oid:
            att_ids.append({"type": "user", "user_id": oid})
        else:
            att_failed.append(item)

    body = {
        "summary": summary,
        "description": description or "",
        "start_time": {"timestamp": start_ts, "timezone": timezone_name},
        "end_time": {"timestamp": end_ts, "timezone": timezone_name},
        "free_busy_status": "busy",
        "visibility": "default",
    }
    if att_ids:
        body["attendees"] = att_ids
        body["attendee_ability"] = "can_see_others"

    res = _calendar_request("POST", f"/calendar/v4/calendars/{cid}/events", body=body,
                            params={"need_notification": "true" if notify else "false"})
    if not res["ok"]:
        return (f"日程创建失败：code={res['code']} msg={res['msg']}"
                f"{_permission_hint(res['code'], res['msg'])}")

    ev = res["data"].get("event") or {}
    out = [
        f"日程创建成功：{ev.get('summary') or summary}",
        f"时间：{_fmt_ts(start_ts)} ~ {_fmt_ts(end_ts)}",
        f"日程 id：{ev.get('event_id', '')}",
    ]
    if att_ids:
        out.append(f"参与人：{len(att_ids)} 人（已发通知）" if notify else f"参与人：{len(att_ids)} 人")
    if att_failed:
        out.append(f"未匹配到的参与人：{'、'.join(att_failed)}")
    return "\n".join(out)


@tool
def feishu_list_calendar_events(start_time: str, end_time: str, calendar_id: str = "primary") -> str:
    """查询某个时间段内的飞书日程（用户身份，需已完成授权且开通日历权限）。

    Args:
        start_time: 查询起始时间，支持 `2026-09-24 00:00` 或秒级时间戳。
        end_time: 查询结束时间，格式同上。
        calendar_id: 日历 id，默认用户主日历（primary）。
    """
    if not configured():
        return _no_config()
    try:
        start_ts = _to_timestamp(start_time)
        end_ts = _to_timestamp(end_time)
    except ValueError as e:  # noqa: BLE001
        return f"参数错误：{e}"

    cid = _resolve_calendar_id(calendar_id)
    res = _calendar_request("GET", f"/calendar/v4/calendars/{cid}/events",
                            params={"start_time": start_ts, "end_time": end_ts, "page_size": 50})
    if not res["ok"]:
        return (f"日程查询失败：code={res['code']} msg={res['msg']}"
                f"{_permission_hint(res['code'], res['msg'])}")

    items = res["data"].get("items") or []
    if not items:
        return f"{_fmt_ts(start_ts)} ~ {_fmt_ts(end_ts)} 之间没有日程"
    lines = [f"共 {len(items)} 条日程（{_fmt_ts(start_ts)} ~ {_fmt_ts(end_ts)}）："]
    for it in items:
        s = (it.get("start_time") or {}).get("timestamp", "")
        e = (it.get("end_time") or {}).get("timestamp", "")
        tz = (it.get("start_time") or {}).get("timezone", "")
        span = f"{_fmt_ts(s)} ~ {_fmt_ts(e)}" if s and e else (it.get("start_time") or {}).get("date", "")
        lines.append(f"- {it.get('summary', '(无标题)')} | {span} {tz} | status={it.get('status', '')}")
    return "\n".join(lines)


FEISHU_TOOLS = [feishu_send_message, feishu_reply_message, feishu_search_contacts,
                feishu_create_calendar_event, feishu_list_calendar_events]
FEISHU_TOOL_NAMES = [t.name for t in FEISHU_TOOLS]


# --------------------------------------------------------------------------
# 接收消息（WebSocket 长连接）
# --------------------------------------------------------------------------

def extract_message(data) -> dict | None:
    """从 im.message.receive_v1 事件对象里提取结构化信息。"""
    try:
        ev = data.event
        msg = ev.message
        message_type = getattr(msg, "message_type", "") or ""
        content = getattr(msg, "content", "") or ""
        text = ""
        if message_type == "text":
            try:
                text = (json.loads(content) if content else {}).get("text", "")
            except Exception:
                text = str(content)
        else:
            text = f"[{message_type} 消息]"

        sender_id = ""
        sender_type = ""
        sender = getattr(ev, "sender", None)
        if sender is not None:
            sender_type = getattr(sender, "sender_type", "") or ""
            sid = getattr(sender, "sender_id", None)
            if sid is not None:
                sender_id = (getattr(sid, "open_id", "") or getattr(sid, "user_id", "") or "")

        return {
            "chat_id": getattr(msg, "chat_id", "") or "",
            "chat_type": getattr(msg, "chat_type", "") or "",
            "message_id": getattr(msg, "message_id", "") or "",
            "message_type": message_type,
            "text": text,
            "sender_id": sender_id,
            "sender_type": sender_type,
            "root_id": getattr(msg, "root_id", "") or "",
        }
    except Exception as e:  # noqa: BLE001
        print(f"[feishu] 提取消息异常: {e}")
        return None


def start_receiver() -> bool:
    """启动飞书消息接收（后台 WS 线程）。收到消息投递到 message_queue。

    幂等：重复调用只启动一次。未配置凭证时返回 False 不启动。
    """
    global _RECEIVER_STARTED
    if _RECEIVER_STARTED:
        return True
    if not configured():
        return False

    import lark_oapi as lark
    from lark_oapi.ws import Client as WsClient

    def _handler(data):
        info = extract_message(data)
        if info and info.get("text"):
            message_queue.put(info)

    def _run():
        try:
            # 飞书 SDK 的 ws.Client 用模块级 loop 且 run_until_complete 阻塞，
            # 不能与 FastAPI 主事件循环共用 → 在独立线程里新建 loop 并替换 SDK 的模块级 loop。
            import lark_oapi.ws.client as ws_client_module
            new_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(new_loop)
            ws_client_module.loop = new_loop

            event_handler = (lark.EventDispatcherHandler.builder("", "")
                             .register_p2_im_message_receive_v1(_handler)
                             .build())
            ws = WsClient(_app_id(), _app_secret(), event_handler=event_handler,
                          log_level=lark.LogLevel.ERROR)
            ws.start()  # 阻塞，自动重连
        except Exception as e:  # noqa: BLE001
            print(f"[feishu] 长连接异常: {e}")

    t = threading.Thread(target=_run, daemon=True, name="feishu-ws")
    t.start()
    _RECEIVER_STARTED = True
    print("[feishu] 接收消息长连接已启动")
    return True
