"""知识库文件上传 + 后台入库任务。

把「用户上传一个文件」变成「知识库里多出若干篇可检索文档」，并全程把进度
暴露给前端：

    接收字节 → 落盘 → 解析内容 → 文本切块 → 向量化 → 写入索引

设计要点
--------
1. **一个文件一个请求，原始字节放在 body 里**
   ``POST /api/kb/upload?filename=xxx``，body 就是文件的原始字节。
   这样不引入 multipart 解析依赖，也不会像 ``request.text()`` 那样把二进制
   （xlsx）按 UTF-8 解码弄坏。一个文件一个任务，前端天然能按文件展示进度。

2. **串行处理**
   所有上传进入同一个队列，由**一个**后台线程消费。并发入库会同时撞上
   Embedding 的分钟级限流（免费额度），还会让 vec0 的写事务互相等待；
   排队比并发更快，状态展示也可读。

3. **表格分两路**
   问答型表格（有「问题 / 答案」列）→ **一问一答 = 一个片段**，并按分类拆成
   多篇文档；普通表格 → 按「表头 + 若干行」成块，避免数据行被从中间切断、
   也避免每个片段都丢掉表头而看不懂列的含义。（粒度取舍详见 ``ingest_faq.py``）

4. **落盘到受管目录** ``kb/files/``
   ``doc_id`` 由「来源路径」派生，所以文件必须有稳定位置：同一个文件重复上传
   会命中同一条记录，内容没变则零额度跳过。
"""

from __future__ import annotations

import csv
import io
import os
import queue
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from kb_embeddings import EmbeddingError
from kb_store import (
    TEXT_SUFFIXES,
    Chunk,
    IngestResult,
    KbStore,
    get_store,
    guess_title,
    make_doc_id,
    read_text_file,
)

CHAT_UI_DIR = Path(__file__).resolve().parent

# 上传文件的受管目录。放在 kb/ 下（已被 .gitignore 忽略）。
# ``KB_UPLOAD_DIR`` 可覆盖，测试用它把上传目录隔离到临时路径。
UPLOAD_DIR = Path(os.environ.get("KB_UPLOAD_DIR") or (CHAT_UI_DIR / "kb" / "files"))

# 表格类后缀：CSV / TSV 走文本解析，xlsx 需要 openpyxl（可选依赖）
CSV_SUFFIXES = {".csv", ".tsv"}
XLSX_SUFFIXES = {".xlsx", ".xlsm"}
TABLE_SUFFIXES = CSV_SUFFIXES | XLSX_SUFFIXES

MAX_UPLOAD_BYTES = 20 * 1024 * 1024          # 单文件 20 MB
MAX_UPLOAD_MB = MAX_UPLOAD_BYTES // 1024 // 1024
MAX_NAME_CHARS = 120

# 表格成块时每个片段包含的数据行数
MAX_TABLE_ROWS_PER_CHUNK = 40

# 问答型表格的列名（宽松匹配，大小写不敏感）
QUESTION_KEYS = ("问", "问题", "question", "q")
ANSWER_KEYS = ("答", "答案", "answer", "a")
CATEGORY_KEYS = ("分类", "类别", "category", "类别名称")
UNCATEGORIZED = "未分类"

# 任务阶段：中文名 + 该阶段在总进度里的区间（占比）
STAGE_LABELS: dict[str, str] = {
    "queued": "排队中",
    "parsing": "解析内容",
    "chunking": "文本切块",
    "embedding": "向量化",
    "writing": "写入索引",
    "done": "已完成",
    "failed": "失败",
}
_STAGE_SPAN: dict[str, tuple[float, float]] = {
    "chunking": (0.08, 0.14),
    "embedding": (0.14, 0.94),
    "writing": (0.94, 0.99),
}


# 任务级进度回调：``(阶段, 总进度 0~1, 说明文字)``
TaskProgressCb = Callable[[str, float, str], None]


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ==========================================================================
# 文件名与后缀
# ==========================================================================

_RE_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def sanitize_filename(name: str) -> str:
    """把上传的文件名收敛成安全的纯文件名（不含任何目录成分）。

    这是**唯一**的入口校验：浏览器给的 ``filename`` 可以带 ``..\\..\\evil``
    这类路径成分，直接拼到受管目录上就会写到目录之外。
    """
    raw = (name or "").strip().replace("\\", "/")
    base = raw.split("/")[-1]                 # 丢掉全部目录成分（含 ..）
    base = _RE_BAD_NAME.sub("_", base).strip().strip(".").strip()
    if not base:
        raise ValueError("文件名无效")
    if len(base) > MAX_NAME_CHARS:
        stem, dot, ext = base.rpartition(".")
        if dot and len(ext) <= 10:
            base = stem[: MAX_NAME_CHARS - len(ext) - 1] + dot + ext
        else:
            base = base[:MAX_NAME_CHARS]
    return base


def _openpyxl():
    """openpyxl 是可选依赖：只有上传 xlsx 才需要它。"""
    try:
        import openpyxl  # type: ignore[import-not-found]
        return openpyxl
    except Exception:
        return None


def allowed_suffixes() -> list[str]:
    """当前环境**实际支持**的上传后缀。装了 openpyxl 才放行 xlsx。"""
    base = set(TEXT_SUFFIXES) | {".tsv"}
    if _openpyxl() is not None:
        base |= XLSX_SUFFIXES
    return sorted(base)


def is_managed_file(path: Path) -> bool:
    """判断文件是否在受管上传目录内 —— 决定删除文档时能否连带删掉源文件。"""
    try:
        return path.resolve().is_relative_to(UPLOAD_DIR.resolve())
    except (OSError, ValueError):
        return False


# ==========================================================================
# 表格解析
# ==========================================================================

@dataclass
class TableGroup:
    """一张表的解析结果。CSV 只有一组；多 sheet 的 Excel 每个 sheet 一组。"""
    label: str                 # sheet 名（CSV 为空串）
    headers: list[str]
    rows: list[dict[str, str]]


def _cell(v: Any) -> str:
    """单元格转字符串。Excel 会把整数读成 float，要还原成 ``1`` 而不是 ``1.0``。"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "是" if v else "否"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _read_csv_groups(path: Path) -> list[TableGroup]:
    text = read_text_file(path)               # 已处理 UTF-8 BOM / GBK 回退
    dialect = "excel-tab" if path.suffix.lower() == ".tsv" else "excel"
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        raise ValueError("表格缺少表头行")
    headers = [(h or "").strip() for h in reader.fieldnames]
    rows: list[dict[str, str]] = []
    for raw in reader:
        item = {(k or "").strip(): _cell(v) for k, v in raw.items() if k is not None}
        if any(v for v in item.values()):
            rows.append(item)                 # 丢掉纯空行（表格末尾常见）
    if not rows:
        raise ValueError("表格里没有任何数据行")
    return [TableGroup(label="", headers=headers, rows=rows)]


def _read_xlsx_groups(path: Path) -> list[TableGroup]:
    openpyxl = _openpyxl()
    if openpyxl is None:
        raise RuntimeError(
            "解析 .xlsx / .xlsm 需要 openpyxl，当前环境未安装。"
            "请先安装（uv pip install openpyxl），或把表格另存为 CSV 再上传。"
        )
    wb = openpyxl.load_workbook(filename=str(path), read_only=True, data_only=True)
    try:
        groups: list[TableGroup] = []
        for ws in wb.worksheets:
            it = ws.iter_rows(values_only=True)
            headers: list[str] = []
            for row in it:                    # 首个非空行当表头
                cells = [_cell(c) for c in (row or ())]
                if any(cells):
                    headers = [c or f"列{i + 1}" for i, c in enumerate(cells)]
                    break
            if not headers:
                continue                      # 空 sheet
            rows: list[dict[str, str]] = []
            for row in it:
                cells = [_cell(c) for c in (row or ())]
                if not any(cells):
                    continue
                rows.append({
                    h: (cells[i] if i < len(cells) else "")
                    for i, h in enumerate(headers)
                })
            if rows:
                groups.append(TableGroup(label=ws.title or "", headers=headers, rows=rows))
        if not groups:
            raise ValueError("工作簿里没有解析到任何数据")
        return groups
    finally:
        wb.close()


def _pick(item: dict[str, str], keys: tuple[str, ...]) -> str:
    for want in keys:
        for k, v in item.items():
            if k.lower() == want.lower() and v:
                return v
    return ""


def is_faq_table(headers: list[str]) -> bool:
    """是不是「问答型」表格：问题列与答案列同时存在。"""
    low = [h.lower() for h in headers]
    return (any(k in low for k in QUESTION_KEYS)
            and any(k in low for k in ANSWER_KEYS))


def _faq_groups(rows: list[dict[str, str]]) -> list[tuple[str, list[Chunk]]]:
    """按分类分组，**一组问答 = 一个片段**（保持出现顺序）。"""
    buckets: dict[str, list[dict[str, str]]] = {}
    order: list[str] = []
    for r in rows:
        cat = _pick(r, CATEGORY_KEYS) or UNCATEGORIZED
        if cat not in buckets:
            buckets[cat] = []
            order.append(cat)
        buckets[cat].append(r)

    out: list[tuple[str, list[Chunk]]] = []
    for cat in order:
        chunks: list[Chunk] = []
        for r in buckets[cat]:
            q, a = _pick(r, QUESTION_KEYS), _pick(r, ANSWER_KEYS)
            if not q and not a:
                continue
            body = f"问：{q}\n答：{a}" if a else f"问：{q}"
            chunks.append(Chunk(index=len(chunks), content=body, heading=cat))
        if chunks:
            out.append((cat, chunks))
    return out


def _table_chunks(group: TableGroup) -> list[Chunk]:
    """普通表格成块：**每个片段都带表头**，数据行按固定条数分批。

    为什么不用通用切块器：它会按字数贪心打包，把表格从中间切开——切成两半的
    数据行既读不懂，也没有表头解释列含义。表格的正确最小单位是「表头 + 若干完整行」。
    """
    def row_line(r: dict[str, str]) -> str:
        return " | ".join(
            (r.get(h, "") or "").replace("|", "\\|").replace("\n", " ") for h in group.headers
        )

    header_line = " | ".join(h.replace("|", "\\|") for h in group.headers)
    sep_line = " | ".join("---" for _ in group.headers)
    lines = [header_line, sep_line] + [row_line(r) for r in group.rows]

    chunks: list[Chunk] = []
    step = MAX_TABLE_ROWS_PER_CHUNK
    for start in range(0, len(group.rows), step):
        body = "\n".join(lines[:2] + lines[2 + start: 2 + start + step])
        chunks.append(Chunk(index=len(chunks), content=body, heading=group.label))
    return chunks


# ==========================================================================
# 入库规划与执行
# ==========================================================================

def plan_ingest(path: Path, *, base: str, tags: str) -> tuple[str, list[tuple]]:
    """规划「这个文件该怎么入库」，返回 ``(mode, jobs)``。

    mode ∈ ``{"text", "faq-table", "table", "mixed-table"}``。
    jobs 每项为 ``(kind, doc_id, title, doc_type, tags, payload)``，
    kind ∈ ``{"chunks", "text"}``（分别走 ``ingest_chunks`` / ``ingest_text``）。

    逐组判断（多 sheet 的工作簿允许「一张表是问答、另一张是清单」），
    分组结果决定 mode：全是问答 → ``faq-table``，全不是 → ``table``，混合 → ``mixed-table``。

    先规划再执行，是为了让进度分母（一共几篇文档）在开始前就确定下来，
    进度条才不会中途跳变。
    """
    suffix = path.suffix.lower()
    doc_type = suffix.lstrip(".") or "text"

    if suffix in TABLE_SUFFIXES:
        groups = (_read_xlsx_groups if suffix in XLSX_SUFFIXES else _read_csv_groups)(path)
        multi = len(groups) > 1
        jobs: list[tuple] = []
        faq_groups = 0

        for g in groups:
            if is_faq_table(g.headers):
                faq_groups += 1
                for cat, chunks in _faq_groups(g.rows):
                    title = " · ".join(
                        x for x in (base, g.label if multi else "", cat) if x
                    )
                    jobs.append((
                        "chunks",
                        make_doc_id(f"{path}::{g.label}::{cat}", title),
                        title, doc_type, cat, chunks,
                    ))
            else:
                title = f"{base} · {g.label}" if multi else base
                jobs.append((
                    "chunks",
                    make_doc_id(f"{path}::{g.label or 'table'}", title),
                    title, doc_type, tags, _table_chunks(g),
                ))

        if not jobs:
            raise ValueError("表格里没有解析出任何可用内容")
        if faq_groups == len(groups):
            mode = "faq-table"
        elif faq_groups == 0:
            mode = "table"
        else:
            mode = "mixed-table"
        return mode, jobs

    text = read_text_file(path)
    if not text.strip():
        raise ValueError("文件内容为空")
    # doc_id 传 None → 由 source（文件路径）派生，改标题不会变成新文档
    return "text", [("text", None, guess_title(text, base), doc_type, tags, text)]


def _describe(phase: str, done: int, total: int, index: int, count: int) -> str:
    prefix = f"[{index + 1}/{count}] " if count > 1 else ""
    if phase == "embedding":
        return f"{prefix}向量化 {done}/{total} 个片段"
    if phase == "chunking":
        return f"{prefix}文本切块"
    if phase == "writing":
        return f"{prefix}写入索引"
    return f"{prefix}{STAGE_LABELS.get(phase, phase)}"


def ingest_path(
    path: Path,
    *,
    title: str | None = None,
    tags: str = "",
    progress: TaskProgressCb | None = None,
    store: KbStore | None = None,
) -> dict:
    """把一个文件入库，返回汇总结果。

    ``progress(阶段, 总进度 0~1, 说明)`` 会把「第几篇文档、文档内哪个阶段」
    折算成一个总体百分比。
    """
    store = store or get_store()
    base = (title or "").strip() or path.stem
    mode, jobs = plan_ingest(path, base=base, tags=tags)

    def sink(stage: str, frac: float, message: str) -> None:
        if progress is None:
            return
        try:
            progress(stage, frac, message)
        except Exception:
            pass

    # 把「第 index 篇文档、文档内的 phase」折算成整体进度
    def scaled(index: int, count: int):
        def cb(phase: str, done: int, total: int) -> None:
            span = _STAGE_SPAN.get(phase, (0.0, 1.0))
            inner = (done / total) if total > 0 else 0.0
            overall = (index + span[0] + (span[1] - span[0]) * inner) / count
            sink(phase, min(overall, 1.0), _describe(phase, done, total, index, count))
        return cb

    results: list[IngestResult] = []
    for i, (kind, doc_id, doc_title, doc_type, doc_tags, payload) in enumerate(jobs):
        cb = scaled(i, len(jobs))
        if kind == "chunks":
            r = store.ingest_chunks(
                payload, title=doc_title, doc_id=doc_id, source=str(path),
                doc_type=doc_type, tags=doc_tags, progress=cb,
            )
        else:
            r = store.ingest_text(
                payload, title=doc_title, doc_id=doc_id, source=str(path),
                doc_type=doc_type, tags=doc_tags, progress=cb,
            )
        results.append(r)

    return {
        "mode": mode,
        "docs": [
            {
                "doc_id": r.doc_id,
                "title": r.title,
                "chunks": r.chunks,
                "tokens": r.tokens,
                "skipped": r.skipped,
                "meta_updated": r.meta_updated,
            }
            for r in results
        ],
        "chunks": sum(r.chunks for r in results),
        "tokens": sum(r.tokens for r in results),
        "added": sum(1 for r in results if not r.skipped),
        "skipped": sum(1 for r in results if r.skipped),
    }


# ==========================================================================
# 删除
# ==========================================================================

def delete_documents(doc_ids: list[str]) -> dict:
    """删除若干文档及其片段；顺带清掉**只属于它们**的受管上传文件。

    「只属于它们」是重点：一份 FAQ CSV 会拆成多篇文档（按分类），删掉其中一篇
    时源文件仍被其它文档引用，不能删；只有最后一个引用消失、且文件在受管目录内，
    才连带删除。用户手动放进来的外部文件（不在受管目录）永远不动。
    """
    store = get_store()
    removed: list[dict] = []
    missing: list[str] = []
    removed_chunks = 0

    for doc_id in doc_ids:
        key = (doc_id or "").strip()
        if not key:
            continue
        doc = store.get_document(key)
        if doc is None:
            missing.append(key)
            continue
        removed_chunks += store.delete_document(key)
        removed.append({
            "doc_id": key,
            "title": doc["title"],
            "source": doc.get("source") or "",
        })

    # 受管文件清理：已无任何文档引用 + 位于上传目录内
    still_used = {d.get("source") or "" for d in store.list_documents()}
    freed: list[str] = []
    for src in {d["source"] for d in removed if d["source"]}:
        if src in still_used:
            continue
        p = Path(src)
        if p.is_file() and is_managed_file(p):
            try:
                p.unlink()
                freed.append(str(p))
            except OSError:
                pass

    store.checkpoint()
    return {
        "removed": removed,
        "removed_chunks": removed_chunks,
        "missing": missing,
        "freed_files": freed,
        "stats": store.stats(),
    }


# ==========================================================================
# 上传任务（单工作线程 + 队列）
# ==========================================================================

@dataclass
class UploadTask:
    task_id: str
    filename: str
    stored_path: str
    size_bytes: int
    tags: str = ""
    status: str = "queued"          # queued | running | done | failed
    stage: str = "queued"
    progress: float = 0.0
    message: str = "排队中"
    mode: str = ""
    docs: list[dict] = field(default_factory=list)
    chunks: int = 0
    tokens: int = 0
    added: int = 0
    skipped: int = 0
    error: str = ""
    created_at: str = ""
    updated_at: str = ""
    elapsed_ms: float = 0.0

    def as_dict(self) -> dict:
        d = dict(self.__dict__)
        d["stage_label"] = STAGE_LABELS.get(self.stage, self.stage)
        d["progress"] = round(self.progress, 4)
        d["elapsed_ms"] = round(self.elapsed_ms, 1)
        return d


class TaskManager:
    """上传任务登记表 + 单工作线程。

    单线程是刻意的：Embedding 有分钟级限流，并发只会让所有任务一起变慢；
    vec0 的写事务也天然串行更省心。
    """

    def __init__(self, max_tasks: int = 200):
        self._lock = threading.Lock()
        self._tasks: dict[str, UploadTask] = {}
        self._order: list[str] = []
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._max = max_tasks
        self._worker: threading.Thread | None = None

    # ---------------- 登记表 ----------------

    def _ensure_worker(self) -> None:
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(
                target=self._loop, name="kb-upload-worker", daemon=True
            )
            self._worker.start()

    def _prune(self) -> None:
        """只保留最近 N 条，避免长跑进程无限增长。"""
        while len(self._order) > self._max:
            old = self._order.pop(0)
            self._tasks.pop(old, None)

    def get(self, task_id: str) -> dict | None:
        with self._lock:
            t = self._tasks.get(task_id)
            return t.as_dict() if t else None

    def list(self, limit: int = 50) -> list[dict]:
        with self._lock:
            ids = self._order[-limit:]
            return [self._tasks[i].as_dict() for i in ids if i in self._tasks]

    def has_active(self) -> bool:
        with self._lock:
            return any(t.status in ("queued", "running") for t in self._tasks.values())

    def _update(self, task_id: str, **kw) -> None:
        with self._lock:
            t = self._tasks.get(task_id)
            if t is None:
                return
            for k, v in kw.items():
                setattr(t, k, v)
            t.updated_at = _now()

    # ---------------- 提交 ----------------

    def submit(self, filename: str, data: bytes, *, tags: str = "") -> dict:
        """校验 → 落盘 → 入队，立即返回任务快照（前端据此开始轮询）。"""
        if not data:
            raise ValueError("上传内容为空")
        if len(data) > MAX_UPLOAD_BYTES:
            raise ValueError(
                f"文件超过大小上限（{len(data) / 1024 / 1024:.1f} MB > {MAX_UPLOAD_MB} MB）"
            )
        safe = sanitize_filename(filename)
        suffix = Path(safe).suffix.lower()
        if suffix not in allowed_suffixes():
            raise ValueError(
                f"不支持的文件类型「{suffix or '（无扩展名）'}」，"
                f"允许：{'、'.join(allowed_suffixes())}"
            )

        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        target = UPLOAD_DIR / safe
        try:
            target.write_bytes(data)          # 同名覆盖 → doc_id 稳定，内容变了才重嵌入
        except OSError as e:
            raise ValueError(f"保存文件失败：{e}") from e

        now = _now()
        task = UploadTask(
            task_id=uuid.uuid4().hex[:12],
            filename=safe,
            stored_path=str(target),
            size_bytes=len(data),
            tags=tags or "",
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._tasks[task.task_id] = task
            self._order.append(task.task_id)
            self._prune()
        self._ensure_worker()
        self._queue.put(task.task_id)
        return task.as_dict()

    # ---------------- 工作线程 ----------------

    def _loop(self) -> None:
        while True:
            task_id = self._queue.get()
            try:
                self._run(task_id)
            except Exception as e:            # 兜底：工作线程绝不能死
                self._fail(task_id, f"{type(e).__name__}: {e}")
            finally:
                self._queue.task_done()

    def _fail(self, task_id: str, error: str, elapsed_ms: float = 0.0) -> None:
        self._update(
            task_id, status="failed", stage="failed", progress=1.0,
            message=f"处理失败：{error}", error=error,
            elapsed_ms=elapsed_ms,
        )

    def _run(self, task_id: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return
            path = Path(task.stored_path)
            tags = task.tags

        t0 = time.perf_counter()
        self._update(task_id, status="running", stage="parsing", message="解析内容")
        last = {"value": 0.0}

        def on_progress(stage: str, frac: float, message: str) -> None:
            # 进度只增不减：多篇文档串行时，阶段回退会让进度条抖动
            value = max(frac, last["value"])
            last["value"] = value
            self._update(task_id, stage=stage, progress=value, message=message)

        try:
            summary = ingest_path(path, tags=tags, progress=on_progress)
        except (EmbeddingError, ValueError, RuntimeError, OSError) as e:
            self._fail(task_id, f"{type(e).__name__}: {e}",
                       (time.perf_counter() - t0) * 1000)
            return

        get_store().checkpoint()

        if summary["added"] == 0 and summary["skipped"] > 0:
            message = f"内容未变化，已跳过（{len(summary['docs'])} 篇，未消耗额度）"
        else:
            message = (f"完成：{summary['added']} 篇文档 / {summary['chunks']} 个片段"
                       f" / {summary['tokens']} token")
            if summary["skipped"]:
                message += f"，另有 {summary['skipped']} 篇未变化已跳过"

        self._update(
            task_id,
            status="done", stage="done", progress=1.0, message=message,
            mode=summary["mode"], docs=summary["docs"],
            chunks=summary["chunks"], tokens=summary["tokens"],
            added=summary["added"], skipped=summary["skipped"],
            elapsed_ms=(time.perf_counter() - t0) * 1000,
        )


_MANAGER: TaskManager | None = None
_MANAGER_LOCK = threading.Lock()


def get_manager() -> TaskManager:
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            _MANAGER = TaskManager()
        return _MANAGER


def describe() -> dict:
    """能力快照，供前端渲染上传提示。"""
    return {
        "upload_dir": str(UPLOAD_DIR),
        "allowed_suffixes": allowed_suffixes(),
        "max_upload_mb": MAX_UPLOAD_MB,
        "xlsx_supported": _openpyxl() is not None,
        "max_table_rows_per_chunk": MAX_TABLE_ROWS_PER_CHUNK,
    }
