"""Agent 通信渠道 —— 数据层。

渠道是一等实体（当前只有「飞书」，未来可扩展企业微信 / 钉钉等）。持久化
「覆盖项」到 ``chat-ui/channel_config.json``（gitignore，含密钥），种子定义在
``DEFAULT_CHANNELS``。凭证读取优先级：channel_config.json > 环境变量（.env）。

与「Agent 控制面板」的工具开关是 **AND 关系**：
  - 渠道级开关（本模块）：关闭后该渠道的工具与接收消息全部不可用；
  - 工具级开关（TOOL_CATALOG）：模型是否还能看到具体某个工具。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path

CONFIG_PATH: Path = Path(__file__).resolve().parent / "channel_config.json"

# 渠道种子（不在表里才补入）。env_app_id / env_app_secret 是「首次未编辑时」
# 从环境变量读取凭证的键名。
DEFAULT_CHANNELS: list[dict] = [
    {
        "name": "feishu",
        "label": "飞书",
        "description": "飞书渠道通信：发送消息 / 回复消息 / 搜通讯录 / 接收消息（WebSocket 长连接）",
        "env_app_id": "FEISHU_APP_ID",
        "env_app_secret": "FEISHU_APP_SECRET",
    },
]

_LOCK = threading.RLock()


def _find(name: str) -> dict:
    for c in DEFAULT_CHANNELS:
        if c["name"] == name:
            return c
    raise ValueError(f"未知渠道「{name}」")


def _default_raw() -> dict:
    return {"channels": {}, "updated_at": None}


def _load_raw() -> dict:
    if not CONFIG_PATH.is_file():
        return _default_raw()
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("channels"), dict):
            return data
    except Exception:
        pass
    return _default_raw()


def _save_raw(data: dict) -> None:
    data = dict(data)
    data["updated_at"] = datetime.now().isoformat(timespec="seconds")
    tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)


def get_channels() -> list[dict]:
    """渠道清单（含开关状态、是否已配凭证），供面板与 build_agent 使用。"""
    with _LOCK:
        raw = _load_raw()
    out = []
    for meta in DEFAULT_CHANNELS:
        ch = raw["channels"].get(meta["name"], {})
        app_id, app_secret = get_credentials(meta["name"])
        out.append({
            "name": meta["name"],
            "label": meta["label"],
            "description": meta["description"],
            "enabled": bool(ch.get("enabled", True)),
            "configured": bool(app_id and app_secret),
        })
    return out


def get_credentials(name: str) -> tuple[str, str]:
    """返回 (app_id, app_secret)。优先 channel_config.json，回退环境变量。"""
    meta = _find(name)
    with _LOCK:
        ch = _load_raw().get("channels", {}).get(name, {})
    app_id = (ch.get("app_id") or os.environ.get(meta["env_app_id"], "")).strip()
    app_secret = (ch.get("app_secret") or os.environ.get(meta["env_app_secret"], "")).strip()
    return app_id, app_secret


def is_enabled(name: str) -> bool:
    with _LOCK:
        ch = _load_raw().get("channels", {}).get(name, {})
    return bool(ch.get("enabled", True))


def set_enabled(name: str, enabled: bool) -> dict:
    _find(name)
    with _LOCK:
        raw = _load_raw()
        raw["channels"].setdefault(name, {})["enabled"] = bool(enabled)
        _save_raw(raw)
    return next(c for c in get_channels() if c["name"] == name)


def set_credentials(name: str, app_id: str, app_secret: str) -> dict:
    _find(name)
    if not app_id or not app_id.strip():
        raise ValueError("App ID 不能为空")
    if not app_secret or not app_secret.strip():
        raise ValueError("App Secret 不能为空")
    with _LOCK:
        raw = _load_raw()
        raw["channels"].setdefault(name, {})["app_id"] = app_id.strip()
        raw["channels"].setdefault(name, {})["app_secret"] = app_secret.strip()
        _save_raw(raw)
    return next(c for c in get_channels() if c["name"] == name)
