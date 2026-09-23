"""文件附件存储 —— 对话中用户上传的**文本类文件**（当前仅 txt）。

与 ``image_store`` 同一取舍：文件正文单独存表（``chat_files``），
消息里只记 ``file_ids``（JSON 数组文本），避免长文本把 messages 表撑大、
拖慢「历史消息查询 + 前端渲染」。

对外接口：
  - ``save_file(session_id, filename, mime, data_bytes) -> dict``  存文件（返回元数据 + id）
  - ``get_file(file_id) -> dict | None``                           取文件（含正文 text）
  - ``get_files(file_ids) -> list[dict]``                          批量取元数据（不含正文）
  - ``delete_files_for_session(session_id) -> int``                 随会话清理
  - ``delete_files(file_ids) -> int``                               按 id 删除
  - ``is_allowed_filename(name)`` / ``MAX_FILE_BYTES``              校验辅助

文本注入策略（与 server.py 约定，见 ``INLINE_LIMIT``）：
  - 正文 ≤ ``INLINE_LIMIT`` 字符 → 直接拼进该条用户消息的 content（零框架改动）；
  - 超出 → 落盘到 ``uploads/`` 并在 content 里给出虚拟路径，让 Agent 用
    ``read_file`` 分段读取，避免一次性吃光上下文。
"""
from __future__ import annotations

import base64
import re
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

DB_PATH: Path = Path(__file__).resolve().parent / "chat.db"

# 附件落盘目录（长文本用）。位于 chat-ui 下，Agent 可通过虚拟路径
# `/chat-ui/uploads/<name>` 用 read_file 读到（LocalShellBackend root_dir=PROJECT_DIR）。
UPLOAD_DIR: Path = Path(__file__).resolve().parent / "uploads"

# 允许的扩展名（当前仅 txt；后续扩格式往这里加，并同步前端 accept）
ALLOWED_EXTS: set[str] = {".txt"}

# 单文件上限 5MB（与图片口径一致）
MAX_FILE_BYTES: int = 5 * 1024 * 1024

# 单条消息最多附带的文件数（与图片共用 4 个口径）
MAX_FILES_PER_MESSAGE: int = 4

# 正文直接内联进 prompt 的字符上限。
# 超过则改为落盘 + 提示路径（约 5 万汉字，占上下文可控且足够覆盖常见文档附件）。
INLINE_LIMIT: int = 50_000

# 落盘文件名白名单：只留 ASCII 字母数字、点、下划线、连字符，避免路径穿越与中文编码问题
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_table() -> None:
    """建表（幂等）。由 server.py 在 lifespan 里调用。"""
    conn = _db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_files (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            filename TEXT NOT NULL DEFAULT '',
            mime TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chat_files_session ON chat_files(session_id)"
    )
    conn.commit()
    conn.close()


def is_allowed_filename(filename: str) -> bool:
    """按扩展名判断是否允许（当前仅 .txt）。"""
    ext = Path(filename or "").suffix.lower()
    return ext in ALLOWED_EXTS


def _decode_text(data: bytes) -> str:
    """把字节解成文本。

    ⚠️ 顺序很重要：先按 **UTF-8（带 BOM 处理）** 解，再退 GBK ——
    国内 txt 附件相当一部分是 GBK/GB18030，直接 utf-8 会抛错。
    最后兜底 ``errors="replace"``，保证任何二进制也不会让上传失败。
    """
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def save_file(session_id: str, filename: str, mime: str, data: bytes) -> dict:
    """存一个文本文件，返回不含正文的元数据。"""
    name = (filename or "file.txt")[:200]
    if not is_allowed_filename(name):
        raise ValueError(f"不支持的文件类型：{Path(name).suffix or '未知'}。仅支持 .txt")
    if not data:
        raise ValueError("文件内容为空")
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(f"文件过大（上限 {MAX_FILE_BYTES // 1024 // 1024}MB）")

    text = _decode_text(data)
    file_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    conn = _db()
    conn.execute(
        "INSERT INTO chat_files (id, session_id, filename, mime, size, text, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            file_id,
            session_id,
            name,
            (mime or "text/plain")[:100],
            len(data),
            text,
            now,
        ),
    )
    conn.commit()
    conn.close()
    return {
        "id": file_id,
        "session_id": session_id,
        "filename": name,
        "mime": (mime or "text/plain")[:100],
        "size": len(data),
        # 供前端展示「内容有多长」的小提示，不算敏感信息
        "chars": len(text),
        "created_at": now,
    }


def _row_meta(row: sqlite3.Row) -> dict:
    text = row["text"] or ""
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "filename": row["filename"],
        "mime": row["mime"],
        "size": int(row["size"] or 0),
        "chars": len(text),
        "created_at": row["created_at"],
    }


def get_file(file_id: str) -> dict | None:
    """取单个文件（含正文 ``text``）。"""
    conn = _db()
    row = conn.execute("SELECT * FROM chat_files WHERE id = ?", (file_id,)).fetchone()
    conn.close()
    if not row:
        return None
    out = _row_meta(row)
    out["text"] = row["text"] or ""
    return out


def get_files(file_ids: list[str]) -> list[dict]:
    """批量取元数据（**不含**正文），保持传入顺序；缺失的跳过。"""
    ids = [i for i in (file_ids or []) if i]
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    conn = _db()
    rows = conn.execute(
        f"SELECT * FROM chat_files WHERE id IN ({placeholders})", ids
    ).fetchall()
    conn.close()
    by_id = {r["id"]: _row_meta(r) for r in rows}
    return [by_id[i] for i in ids if i in by_id]


def _safe_disk_name(file_id: str, filename: str) -> str:
    """生成落盘文件名：id 前缀 + 净化后的原名，杜绝路径穿越与重名覆盖。"""
    stem = Path(filename or "file.txt").stem
    safe = _SAFE_NAME.sub("_", stem)[:60] or "file"
    return f"{file_id[:8]}_{safe}.txt"


def materialize(file_id: str) -> tuple[str, str] | None:
    """把长文本附件落盘，返回 ``(虚拟路径, 磁盘绝对路径)``；文件不存在返回 None。

    虚拟路径形如 ``/chat-ui/uploads/<name>``，可直接交给 Agent 的 ``read_file``。
    幂等：同名已存在则直接复用（内容按 id 唯一，不会串）。
    """
    f = get_file(file_id)
    if not f:
        return None
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    disk_name = _safe_disk_name(file_id, f["filename"])
    disk_path = UPLOAD_DIR / disk_name
    if not disk_path.exists():
        # 用 UTF-8（无 BOM、LF）落盘，保证 read_file / grep 行为一致
        disk_path.write_text(f["text"], encoding="utf-8", newline="\n")
    return f"/chat-ui/uploads/{disk_name}", str(disk_path)


def delete_files_for_session(session_id: str) -> int:
    """删除某会话的全部文件，返回删除条数（含清理已落盘的临时文件）。"""
    conn = _db()
    rows = conn.execute(
        "SELECT id, filename FROM chat_files WHERE session_id = ?", (session_id,)
    ).fetchall()
    for r in rows:
        try:
            (UPLOAD_DIR / _safe_disk_name(r["id"], r["filename"])).unlink(missing_ok=True)
        except OSError:
            pass
    cur = conn.execute("DELETE FROM chat_files WHERE session_id = ?", (session_id,))
    n = cur.rowcount or 0
    conn.commit()
    conn.close()
    return int(n)


def delete_files(file_ids: list[str]) -> int:
    """按 id 删除（用户发送前反悔时清理）。"""
    ids = [i for i in (file_ids or []) if i]
    if not ids:
        return 0
    conn = _db()
    rows = conn.execute(
        f"SELECT id, filename FROM chat_files WHERE id IN ({','.join('?' for _ in ids)})",
        ids,
    ).fetchall()
    for r in rows:
        try:
            (UPLOAD_DIR / _safe_disk_name(r["id"], r["filename"])).unlink(missing_ok=True)
        except OSError:
            pass
    cur = conn.execute(f"DELETE FROM chat_files WHERE id IN ({','.join('?' for _ in ids)})", ids)
    n = cur.rowcount or 0
    conn.commit()
    conn.close()
    return int(n)


def build_prompt_text(files: list[dict]) -> str:
    """把一批附件拼成要附加在用户消息后的文本块。

    ``files`` 为 ``get_file()`` 的返回值（含 ``text``）。短文本内联、
    长文本落盘给路径 —— 具体阈值见 ``INLINE_LIMIT``。
    """
    chunks: list[str] = []
    for f in files:
        text = f.get("text") or ""
        header = f"【附件：{f['filename']}】"
        if len(text) <= INLINE_LIMIT:
            chunks.append(f"{header}\n{text}")
        else:
            mat = materialize(f["id"])
            if mat:
                vpath, _ = mat
                chunks.append(
                    f"{header}\n"
                    f"（内容较长，共 {len(text)} 字符，已存为文件：{vpath}，"
                    f"请用 read_file 读取，必要时分段读取。）"
                )
            else:
                chunks.append(f"{header}\n（文件内容读取失败）")
    return "\n\n".join(chunks)
