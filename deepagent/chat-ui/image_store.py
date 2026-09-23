"""图片附件存储 —— 对话中用户上传的图片。

设计取舍：
  - 图片**单独存表**（``chat_images``），不塞进 ``messages.content``：
    base64 体积大，混进消息正文会让「历史消息查询 + 前端渲染」都被拖慢；
  - 消息只记 ``image_ids``（JSON 数组文本），原图按需取（``GET /api/images/{id}``）；
  - 图片是**会话级**资源，随会话删除一并清理。

对外接口：
  - ``save_image(session_id, filename, mime, data_bytes) -> dict``  存图（返回元数据 + id）
  - ``get_image(image_id) -> dict | None``                          取图（含 base64）
  - ``get_images(image_ids) -> list[dict]``                         批量取元数据（不含 base64）
  - ``delete_images_for_session(session_id) -> int``                随会话清理
  - ``is_allowed_mime(mime)`` / ``MAX_IMAGE_BYTES``                 校验辅助
"""
from __future__ import annotations

import base64
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

DB_PATH: Path = Path(__file__).resolve().parent / "chat.db"

# 允许的图片类型（与前端 accept 保持一致）
ALLOWED_MIMES: set[str] = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
}

# 单图上限 5MB（base64 后约 6.7MB，仍在 DeepSeek 单图限制内）
MAX_IMAGE_BYTES: int = 5 * 1024 * 1024

# 单条消息最多附带的图片数
MAX_IMAGES_PER_MESSAGE: int = 4


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_table() -> None:
    """建表（幂等）。由 server.py 在 lifespan 里调用。"""
    conn = _db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_images (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            filename TEXT NOT NULL DEFAULT '',
            mime TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chat_images_session ON chat_images(session_id)"
    )
    conn.commit()
    conn.close()


def is_allowed_mime(mime: str) -> bool:
    return (mime or "").strip().lower() in ALLOWED_MIMES


def save_image(session_id: str, filename: str, mime: str, data: bytes) -> dict:
    """存一张图，返回不含 base64 的元数据。

    ``data`` 为原始字节（前端传来的 base64 在调用方解好，或这里传字节）。
    """
    mime = (mime or "").strip().lower()
    if not is_allowed_mime(mime):
        raise ValueError(f"不支持的图片类型：{mime or '未知'}")
    if not data:
        raise ValueError("图片内容为空")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"图片过大（上限 {MAX_IMAGE_BYTES // 1024 // 1024}MB）")

    image_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    conn = _db()
    conn.execute(
        "INSERT INTO chat_images (id, session_id, filename, mime, size, data, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            image_id,
            session_id,
            (filename or "image")[:200],
            mime,
            len(data),
            base64.b64encode(data).decode("ascii"),
            now,
        ),
    )
    conn.commit()
    conn.close()
    return {
        "id": image_id,
        "session_id": session_id,
        "filename": (filename or "image")[:200],
        "mime": mime,
        "size": len(data),
        "created_at": now,
    }


def _row_meta(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "filename": row["filename"],
        "mime": row["mime"],
        "size": int(row["size"] or 0),
        "created_at": row["created_at"],
    }


def get_image(image_id: str) -> dict | None:
    """取单张图（含 base64 的 ``data_b64``）。"""
    conn = _db()
    row = conn.execute("SELECT * FROM chat_images WHERE id = ?", (image_id,)).fetchone()
    conn.close()
    if not row:
        return None
    out = _row_meta(row)
    out["data_b64"] = row["data"]
    return out


def get_images(image_ids: list[str]) -> list[dict]:
    """批量取元数据（**不含** base64），保持传入顺序；缺失的跳过。"""
    ids = [i for i in (image_ids or []) if i]
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    conn = _db()
    rows = conn.execute(
        f"SELECT * FROM chat_images WHERE id IN ({placeholders})", ids
    ).fetchall()
    conn.close()
    by_id = {r["id"]: _row_meta(r) for r in rows}
    return [by_id[i] for i in ids if i in by_id]


def data_url(image_id: str) -> str | None:
    """拼成 ``data:<mime>;base64,<data>``，供构造多模态消息用。"""
    img = get_image(image_id)
    if not img:
        return None
    return f"data:{img['mime']};base64,{img['data_b64']}"


def delete_images_for_session(session_id: str) -> int:
    """删除某会话的全部图片，返回删除条数。"""
    conn = _db()
    cur = conn.execute("DELETE FROM chat_images WHERE session_id = ?", (session_id,))
    n = cur.rowcount or 0
    conn.commit()
    conn.close()
    return int(n)


def delete_images(image_ids: list[str]) -> int:
    """按 id 删除（误传 / 清理单张图用）。"""
    ids = [i for i in (image_ids or []) if i]
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    conn = _db()
    cur = conn.execute(f"DELETE FROM chat_images WHERE id IN ({placeholders})", ids)
    n = cur.rowcount or 0
    conn.commit()
    conn.close()
    return int(n)
