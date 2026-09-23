"""Agent 定时任务 —— 数据层。

持久化到 ``chat.db`` 的 ``scheduled_tasks`` 表；调度循环与执行逻辑在
``server.py``（依赖 ``build_agent``）。这里只负责建表、增删改查、启停、
执行记录，以及「下次执行时间」的计算与到期任务查询。

触发规则两类：
  - ``daily``（定时执行）：每天 ``hour:minute`` 触发一次；``frequency`` 控制
    ``repeat``（每天）或 ``once``（一次后自动停用）。
  - ``interval``（周期执行）：每隔 ``hour`` 小时 + ``minute`` 分钟执行一次
    （hour 0~24、minute 1~59），天然重复，无 once。

``weekdays_only``（仅工作日）：两类都支持，落在周六/周日则顺延到工作日。

时间一律使用**北京时间**（Asia/Shanghai = UTC+8，见 `_now()`）。
"""
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "chat.db"

TRIGGER_TYPES = ("daily", "interval")
FREQUENCIES = ("repeat", "once")

# 定时任务按北京时间（Asia/Shanghai = UTC+8，无夏令时）解释「每天 HH:MM」，
# 与机器本地时区无关（本机时区是 UTC，直接用 datetime.now() 会偏 8 小时）。
def _now() -> datetime:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)
    except Exception:
        return (datetime.now(timezone.utc) + timedelta(hours=8)).replace(tzinfo=None)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_table() -> None:
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            trigger_type TEXT NOT NULL DEFAULT 'daily',
            hour INTEGER NOT NULL,
            minute INTEGER NOT NULL,
            frequency TEXT NOT NULL DEFAULT 'repeat',
            weekdays_only INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_run_at TEXT,
            last_status TEXT,
            last_result TEXT,
            next_run_at TEXT
        )
    """)
    # 迁移：老表补 trigger_type / weekdays_only 列
    cursor = conn.execute("PRAGMA table_info(scheduled_tasks)")
    cols = [row[1] for row in cursor.fetchall()]
    if "trigger_type" not in cols:
        conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'daily'")
    if "weekdays_only" not in cols:
        conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN weekdays_only INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


def _row_to_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["enabled"] = bool(d.get("enabled"))
    d["weekdays_only"] = bool(d.get("weekdays_only"))
    d["trigger_type"] = d.get("trigger_type") or "daily"
    return d


def _is_weekend(dt: datetime) -> bool:
    return dt.weekday() >= 5  # 5=周六 6=周日


def compute_next_run(trigger_type: str, hour: int, minute: int, weekdays_only: bool,
                     now: datetime | None = None) -> str:
    """计算下一次执行时间。

    - daily：今天目标时刻未过则今天，否则明天；
    - interval：从 ``now`` 起往后推 ``hour`` 小时 + ``minute`` 分钟；
    - weekdays_only：结果落在周六/周日则顺延（保持时刻）到工作日。
    """
    now = now or _now()
    if trigger_type == "interval":
        next_run = now + timedelta(hours=hour, minutes=minute)
    else:  # daily
        next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)

    if weekdays_only:
        while _is_weekend(next_run):
            next_run += timedelta(days=1)

    return next_run.isoformat(timespec="seconds")


def list_tasks() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM scheduled_tasks ORDER BY created_at DESC").fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]


def get_task(task_id: str) -> dict | None:
    conn = get_conn()
    r = conn.execute("SELECT * FROM scheduled_tasks WHERE id = ?", (task_id,)).fetchone()
    conn.close()
    return _row_to_dict(r) if r else None


def create_task(name: str, prompt: str, trigger_type: str, hour: int, minute: int,
                frequency: str, weekdays_only: bool) -> dict:
    tid = uuid.uuid4().hex[:16]
    now = _now()
    next_run = compute_next_run(trigger_type, hour, minute, weekdays_only, now)
    conn = get_conn()
    conn.execute(
        "INSERT INTO scheduled_tasks"
        " (id, name, prompt, trigger_type, hour, minute, frequency, weekdays_only,"
        " enabled, created_at, updated_at, next_run_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
        (tid, name, prompt, trigger_type, hour, minute, frequency,
         1 if weekdays_only else 0,
         now.isoformat(timespec="seconds"), now.isoformat(timespec="seconds"), next_run),
    )
    conn.commit()
    conn.close()
    return get_task(tid)


def update_task(task_id: str, name: str, prompt: str, trigger_type: str, hour: int,
                minute: int, frequency: str, weekdays_only: bool) -> dict | None:
    now = _now()
    next_run = compute_next_run(trigger_type, hour, minute, weekdays_only, now)
    conn = get_conn()
    cur = conn.execute(
        "UPDATE scheduled_tasks SET name=?, prompt=?, trigger_type=?, hour=?, minute=?,"
        " frequency=?, weekdays_only=?, updated_at=?, next_run_at=? WHERE id=?",
        (name, prompt, trigger_type, hour, minute, frequency,
         1 if weekdays_only else 0,
         now.isoformat(timespec="seconds"), next_run, task_id),
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        return None
    return get_task(task_id)


def set_enabled(task_id: str, enabled: bool) -> dict | None:
    now = _now()
    conn = get_conn()
    task = conn.execute("SELECT * FROM scheduled_tasks WHERE id = ?", (task_id,)).fetchone()
    if not task:
        conn.close()
        return None
    # 开启时重算 next_run，避免长时间关闭后 next_run 停留在过去导致立即触发
    if enabled:
        next_run = compute_next_run(task["trigger_type"], task["hour"], task["minute"],
                                    bool(task["weekdays_only"]), now)
    else:
        next_run = task["next_run_at"]
    conn.execute(
        "UPDATE scheduled_tasks SET enabled=?, updated_at=?, next_run_at=? WHERE id=?",
        (1 if enabled else 0, now.isoformat(timespec="seconds"), next_run, task_id),
    )
    conn.commit()
    conn.close()
    return get_task(task_id)


def delete_task(task_id: str) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM scheduled_tasks WHERE id = ?", (task_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def mark_run(task_id: str, status: str, result: str, next_run: str | None, disable: bool = False) -> None:
    """记录一次执行结果。``disable=True`` 时同时停用（once 任务执行后即停）。"""
    now = _now()
    text = (result or "")[:2000]
    conn = get_conn()
    if disable:
        conn.execute(
            "UPDATE scheduled_tasks SET last_run_at=?, last_status=?, last_result=?, next_run_at=?, enabled=0"
            " WHERE id=?",
            (now.isoformat(timespec="seconds"), status, text, next_run, task_id),
        )
    else:
        conn.execute(
            "UPDATE scheduled_tasks SET last_run_at=?, last_status=?, last_result=?, next_run_at=? WHERE id=?",
            (now.isoformat(timespec="seconds"), status, text, next_run, task_id),
        )
    conn.commit()
    conn.close()


def get_due_tasks(now: datetime | None = None) -> list[dict]:
    """返回「已到 next_run_at 且启用」的任务（按 next_run 升序）。"""
    now = now or _now()
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?"
        " ORDER BY next_run_at ASC",
        (now.isoformat(timespec="seconds"),),
    ).fetchall()
    conn.close()
    return [_row_to_dict(r) for r in rows]
