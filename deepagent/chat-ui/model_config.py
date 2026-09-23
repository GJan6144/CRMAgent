"""Agent 模型注册表 —— 数据层 + 运行时实例缓存。

模型是一等实体（当前全部走 DeepSeek 的 OpenAI 兼容接口，未来可扩展其他供应商）。
持久化「覆盖项」到 ``chat-ui/model_config.json``（gitignore，含密钥），种子定义在
``DEFAULT_MODELS``。凭证读取优先级：model_config.json > 环境变量（.env）。

与 ``channel_config.py`` 同一套范式：
  - 每条模型有独立开关（``enabled``）与配置项（name / base_url / api_key / vision / context_length）；
  - Agent 对话只允许选用 **启用状态** 的模型；
  - 对话级模型选择存 ``selected_model``，由「对话界面」底部的下拉框切换。

运行时：``get_chat_model(model_id)`` 按配置构造 ``DeepSeekChatOpenAI`` 并按 id 缓存，
配置变更时 ``invalidate(model_id)`` 让下一次 build_agent 拿到新实例。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path

CONFIG_PATH: Path = Path(__file__).resolve().parent / "model_config.json"

# 模型 id 只允许字母 / 数字 / 连字符 / 下划线，避免注入与路径问题
_ALLOWED_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")

# 默认上下文长度（1M）
DEFAULT_CONTEXT_LENGTH = 1024 * 1024

# 模型种子（首次运行时写入配置）。api_key 为空 = 跟随环境变量 OPENAI_API_KEY。
#
# ⚠️ vision 标记依据官方文档 + 实测（见 chat-ui/_probe_vision.py）：
#   - `deepseek-flash` **支持图文混排**（描述图片 / 读截图文字 / 分析图表）。
#     原 `deepseek-v4-flash-vision-exp` 已退役，多模态能力并入主线 Flash，
#     旧 id 的请求也会路由到它 —— 所以**不要再单独建 vision 模型**。
#   - `deepseek-v4-pro` 官方仅提供纯文本能力。
DEFAULT_MODELS: list[dict] = [
    {
        "id": "deepseek-flash",
        "name": "deepseek-flash",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "",
        "vision": True,
        "context_length": DEFAULT_CONTEXT_LENGTH,
        "enabled": True,
    },
    {
        "id": "deepseek-v4-pro",
        "name": "deepseek-v4-pro",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "",
        "vision": False,
        "context_length": DEFAULT_CONTEXT_LENGTH,
        "enabled": True,
    },
]

# 对话界面默认选中的模型
DEFAULT_SELECTED = "deepseek-flash"

_LOCK = threading.RLock()

# 已构造的模型实例缓存：id -> BaseChatModel
_MODEL_CACHE: dict[str, object] = {}


# ---------------------------------------------------------------- 基础读写

def _default_raw() -> dict:
    return {
        "models": [dict(m) for m in DEFAULT_MODELS],
        "selected": DEFAULT_SELECTED,
        "updated_at": None,
    }


def _seed_missing(raw: dict) -> dict:
    """把种子里缺失的模型补进去（按 id 去重），并保证 selected 合法。"""
    by_id = {m.get("id"): m for m in raw.get("models", []) if isinstance(m, dict)}
    for meta in DEFAULT_MODELS:
        if meta["id"] not in by_id:
            by_id[meta["id"]] = dict(meta)
    models = list(by_id.values())
    # 保持「种子顺序在前，用户新增在后」
    order = {m["id"]: i for i, m in enumerate(DEFAULT_MODELS)}
    models.sort(key=lambda m: (order.get(m.get("id", ""), 10_000), str(m.get("id", ""))))
    raw["models"] = models
    enabled_ids = [m["id"] for m in models if m.get("enabled", True)]
    if raw.get("selected") not in enabled_ids:
        raw["selected"] = (enabled_ids or [models[0]["id"]])[0] if models else DEFAULT_SELECTED
    return raw


def _load_raw() -> dict:
    if not CONFIG_PATH.is_file():
        return _default_raw()
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("models"), list) and data["models"]:
            data.setdefault("selected", DEFAULT_SELECTED)
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


def _validate_id(model_id: str) -> str:
    model_id = (model_id or "").strip()
    if not model_id:
        raise ValueError("模型 ID 不能为空")
    if not set(model_id) <= _ALLOWED_ID_CHARS:
        raise ValueError("模型 ID 只能包含字母、数字、连字符与下划线")
    return model_id


def _normalize_fields(
    *,
    name: str,
    base_url: str,
    api_key: str,
    vision: bool,
    context_length: int,
) -> dict:
    if not (name or "").strip():
        raise ValueError("模型名称不能为空")
    if not (base_url or "").strip():
        raise ValueError("API 地址不能为空")
    try:
        ctx = int(context_length)
    except (TypeError, ValueError):
        raise ValueError("上下文长度必须是整数") from None
    if ctx <= 0:
        raise ValueError("上下文长度必须大于 0")
    return {
        "name": name.strip(),
        "base_url": base_url.strip().rstrip("/"),
        "api_key": (api_key or "").strip(),
        "vision": bool(vision),
        "context_length": ctx,
    }


# ---------------------------------------------------------------- 对外 API

def get_models() -> list[dict]:
    """模型清单（含开关状态、key 是否已配置），供面板与 build_agent 使用。

    ``api_key`` 不回传明文，只回传 ``key_configured`` 布尔位。
    """
    with _LOCK:
        raw = _seed_missing(_load_raw())
    out = []
    env_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    for m in raw["models"]:
        stored_key = (m.get("api_key") or "").strip()
        out.append({
            "id": m["id"],
            "name": m.get("name") or m["id"],
            "base_url": m.get("base_url") or "",
            "key_configured": bool(stored_key or env_key),
            "key_from_env": bool(not stored_key and env_key),
            "vision": bool(m.get("vision", False)),
            "context_length": int(m.get("context_length") or DEFAULT_CONTEXT_LENGTH),
            "enabled": bool(m.get("enabled", True)),
        })
    return out


def get_summary() -> dict:
    models = get_models()
    return {
        "total": len(models),
        "enabled": sum(1 for m in models if m["enabled"]),
        "disabled": sum(1 for m in models if not m["enabled"]),
        "vision": sum(1 for m in models if m["vision"]),
    }


def get_model(model_id: str) -> dict | None:
    for m in get_models():
        if m["id"] == model_id:
            return m
    return None


def is_enabled(model_id: str) -> bool:
    m = get_model(model_id)
    return bool(m and m["enabled"])


def get_selected() -> str:
    """当前对话选中的模型 id；不可用时回落到第一个启用的模型。"""
    with _LOCK:
        raw = _seed_missing(_load_raw())
    selected = raw.get("selected")
    enabled = [m["id"] for m in raw["models"] if m.get("enabled", True)]
    if selected in enabled:
        return selected
    return enabled[0] if enabled else DEFAULT_SELECTED


def set_selected(model_id: str) -> str:
    model_id = _validate_id(model_id)
    if not is_enabled(model_id):
        raise ValueError(f"模型「{model_id}」已关闭，无法切换")
    with _LOCK:
        raw = _seed_missing(_load_raw())
        raw["selected"] = model_id
        _save_raw(raw)
    return model_id


def set_enabled(model_id: str, enabled: bool) -> dict:
    model_id = _validate_id(model_id)
    with _LOCK:
        raw = _seed_missing(_load_raw())
        target = next((m for m in raw["models"] if m["id"] == model_id), None)
        if target is None:
            raise ValueError(f"模型「{model_id}」不存在")
        # 至少保留一个启用的模型，否则对话无法进行
        if not enabled:
            others = [m for m in raw["models"] if m["id"] != model_id and m.get("enabled", True)]
            if not others:
                raise ValueError("至少要保留一个启用的模型")
        target["enabled"] = bool(enabled)
        if not enabled and raw.get("selected") == model_id:
            raw["selected"] = next(m["id"] for m in raw["models"] if m.get("enabled", True))
        _save_raw(raw)
    return get_model(model_id) or {}


def upsert_model(
    *,
    model_id: str,
    name: str,
    base_url: str,
    api_key: str,
    vision: bool,
    context_length: int,
    create: bool = False,
) -> dict:
    """新增（create=True）或更新模型配置。

    更新时 ``api_key`` 传空表示「保持原 key 不变」，避免前端每次提交都要回填明文。
    """
    model_id = _validate_id(model_id)
    fields = _normalize_fields(
        name=name, base_url=base_url, api_key=api_key, vision=vision, context_length=context_length
    )
    with _LOCK:
        raw = _seed_missing(_load_raw())
        target = next((m for m in raw["models"] if m["id"] == model_id), None)
        if create:
            if target is not None:
                raise ValueError(f"模型 ID「{model_id}」已存在")
            raw["models"].append({
                "id": model_id,
                **fields,
                "enabled": True,
            })
        else:
            if target is None:
                raise ValueError(f"模型「{model_id}」不存在")
            if not fields["api_key"]:
                # 空 key = 沿用已存的（或继续跟随环境变量）
                fields["api_key"] = target.get("api_key", "")
            target.update(fields)
        _save_raw(raw)
    invalidate(model_id)
    return get_model(model_id) or {}


def delete_model(model_id: str) -> None:
    model_id = _validate_id(model_id)
    with _LOCK:
        raw = _seed_missing(_load_raw())
        rest = [m for m in raw["models"] if m["id"] != model_id]
        if len(rest) == len(raw["models"]):
            raise ValueError(f"模型「{model_id}」不存在")
        enabled = [m for m in rest if m.get("enabled", True)]
        if not enabled:
            raise ValueError("至少要保留一个启用的模型")
        raw["models"] = rest
        if raw.get("selected") == model_id:
            raw["selected"] = enabled[0]["id"]
        _save_raw(raw)
    invalidate(model_id)


def get_api_key(model_id: str) -> str:
    """明文 key：优先本模型配置，其次环境变量。仅供内部构造模型实例使用。"""
    with _LOCK:
        raw = _seed_missing(_load_raw())
    target = next((m for m in raw["models"] if m["id"] == model_id), None)
    stored = (target or {}).get("api_key", "").strip()
    return stored or (os.environ.get("OPENAI_API_KEY") or "").strip()


def get_base_url(model_id: str) -> str:
    m = get_model(model_id)
    return (m or {}).get("base_url") or os.environ.get("OPENAI_BASE_URL", "https://api.deepseek.com/v1")


# ---------------------------------------------------------------- 运行时实例

def invalidate(model_id: str | None = None) -> None:
    """清缓存：配置变更后调用，下次 get_chat_model 会重建实例。"""
    with _LOCK:
        if model_id is None:
            _MODEL_CACHE.clear()
        else:
            _MODEL_CACHE.pop(model_id, None)


def get_chat_model(model_id: str):
    """按 id 构造（并缓存）``DeepSeekChatOpenAI`` 实例。

    模型类由 server.py 注入（``set_model_class``），避免本模块反向依赖 server。
    """
    model_id = _validate_id(model_id)
    with _LOCK:
        cached = _MODEL_CACHE.get(model_id)
        if cached is not None:
            return cached
        cls = _MODEL_CLASS
    if cls is None:
        raise RuntimeError("模型类未注册，请先调用 set_model_class()")
    instance = cls(
        model=(get_model(model_id) or {}).get("name") or model_id,
        base_url=get_base_url(model_id),
        api_key=get_api_key(model_id),
        temperature=0,
        streaming=True,
        use_responses_api=False,
        # 让流式响应也返回 token 用量（stream_options.include_usage），
        # 「Agent 控制面板」的 Token 消耗量据此统计。
        stream_usage=True,
    )
    with _LOCK:
        _MODEL_CACHE[model_id] = instance
    return instance


_MODEL_CLASS = None


def set_model_class(cls) -> None:
    """由 server.py 在导入后注入 ``DeepSeekChatOpenAI``。"""
    global _MODEL_CLASS
    _MODEL_CLASS = cls
