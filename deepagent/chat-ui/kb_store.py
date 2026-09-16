"""知识库存储层 —— SQLite + sqlite-vec（vec0）本地向量库。

负责「切块 → 向量化 → 入库 → 检索」的完整链路，是知识库的核心。
不依赖任何云服务，库文件就是 `chat-ui/kb/knowledge.db`，可以直接拷走。

表结构
------
- ``kb_documents``：文档级信息（标题 / 来源 / 标签 / 分块数 / 内容指纹）
- ``kb_chunks``：**vec0 虚拟表**，向量 + 可过滤元数据列 + 辅助列

  - ``doc_id``：元数据列，可进 KNN 的 ``WHERE``（按文档收窄检索范围）
  - ``heading``：元数据列，切块时所属的标题路径
  - ``+content``：辅助列，片段原文；不进索引但能随结果直接取回，免 JOIN

为什么 ``distance_metric=cosine``
--------------------------------
实测 Qwen3-Embedding 返回的向量已 L2 归一化（范数 1.000000），
余弦距离最贴合语义相似度（``相似度 = 1 - distance``），且不受向量模长干扰。

幂等入库
--------
``content_hash`` 为正文的 sha256。同一 ``doc_id`` 再次入库时：

- 指纹未变 → **直接跳过**（不产生任何 API 调用）
- 指纹变了 → 删旧块、重新切块向量化

这样反复跑入库脚本不会重复烧额度。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from kb_embeddings import EmbeddingClient, EmbeddingError, get_client, EmbeddingConfig
from vec_extension import connect as vec_connect
from vec_extension import serialize_f32

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "kb" / "knowledge.db"

# 切块默认参数（按中文语料调过：800 字约 480 token，远小于 32768 上限）
DEFAULT_MAX_CHARS = 800
DEFAULT_OVERLAP = 100

# vec0 的存储块大小（表级参数）。默认值是 1024，**必须显式调小**：
#
# - 存储会按 ``chunk_size × 维度 × 4`` 字节整块预留。1024 × 1024 维 = 4 MB/块，
#   哪怕库里只有 1 条向量也会占掉 4 MB；
# - 实测 10000 条 1024 维：chunk_size=1024 写入耗时 5.8s，改成 256 只要 0.7s（快 8 倍），
#   而 KNN top-5 延迟几乎不变（51~56 ms 区间内波动），存储放大倍数也一致（≈1.05x）。
#
# 所以没有理由用默认值。256 对应 1 MB/块的预留粒度，兼顾小库不浪费与大规模时块数可控。
CHUNK_SIZE = 256

# 「切片预览」一次最多查多少篇文档的片段。片段本身要全取出来在内存里排序
# （原因见 KbStore.list_chunks 的注释），所以限制的是文档数而不是行数。
MAX_CHUNK_DOC_IDS = 100

TEXT_SUFFIXES = {".md", ".markdown", ".txt", ".text", ".csv", ".log", ".yaml", ".yml", ".json", ".rst", ".ini", ".cfg"}

# 入库进度回调：``(phase, done, total)``。
# phase 取值：``chunking``（切块）/ ``embedding``（向量化）/ ``writing``（写索引）。
# 仅供「上传知识库文件」这类需要展示进度的调用方使用，不传则零开销。
ProgressCb = Callable[[str, int, int], None]


def _emit(cb: ProgressCb | None, phase: str, done: int, total: int) -> None:
    """触发进度回调。回调自身出错绝不能把入库带崩。"""
    if cb is None:
        return
    try:
        cb(phase, done, total)
    except Exception:
        pass


# ==========================================================================
# 切块
# ==========================================================================

@dataclass
class Chunk:
    index: int
    content: str
    heading: str = ""

    @property
    def embed_text(self) -> str:
        """送入 Embedding 的文本：带上标题路径，让片段更"自解释"。"""
        return f"{self.heading}\n{self.content}" if self.heading else self.content


_RE_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_RE_FENCE = re.compile(r"^\s*(```|~~~)")
# 句子边界：中文句号/问号/叹号/分号/换行
_RE_SENTENCE = re.compile(r"(?<=[。！？；!?;\n])")


def _split_oversized(block: str, max_chars: int) -> list[str]:
    """单个超长块：先按句子边界切，仍超长再按字符硬切。"""
    out: list[str] = []
    buf = ""
    for piece in _RE_SENTENCE.split(block):
        if not piece:
            continue
        if len(buf) + len(piece) <= max_chars:
            buf += piece
            continue
        if buf:
            out.append(buf)
            buf = ""
        while len(piece) > max_chars:
            out.append(piece[:max_chars])
            piece = piece[max_chars:]
        buf = piece
    if buf:
        out.append(buf)
    return out


def _parse_blocks(text: str) -> list[tuple[str, str]]:
    """把正文解析成 (heading_path, block_text) 序列。

    保留代码围栏与表格结构（不在其中切分），并按 ATX 标题维护标题路径。
    """
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[tuple[str, str]] = []
    heading_stack: list[tuple[int, str]] = []
    buf: list[str] = []
    in_fence = False
    fence_marker = ""

    def flush() -> None:
        if buf:
            joined = "\n".join(buf).strip()
            if joined:
                path = " > ".join(h for _, h in heading_stack)
                blocks.append((path, joined))
            buf.clear()

    for raw in lines:
        line = raw.rstrip()

        m_fence = _RE_FENCE.match(line)
        if m_fence:
            marker = m_fence.group(1)
            if not in_fence:
                in_fence, fence_marker = True, marker
            elif marker == fence_marker:
                in_fence = False
            buf.append(line)
            continue

        if in_fence:
            buf.append(line)
            continue

        m_head = _RE_HEADING.match(line)
        if m_head:
            flush()
            level = len(m_head.group(1))
            title = m_head.group(2)
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, title))
            continue

        if not line.strip():
            flush()
            continue

        buf.append(line)

    flush()
    return blocks


def chunk_text(
    text: str,
    *,
    max_chars: int = DEFAULT_MAX_CHARS,
    overlap: int = DEFAULT_OVERLAP,
) -> list[Chunk]:
    """结构感知切块：按标题分段 → 段落贪心打包 → 超长二次切分 → 相邻重叠。"""
    if not text or not text.strip():
        return []

    chunks: list[Chunk] = []
    cur_parts: list[str] = []
    cur_heading = ""
    cur_len = 0

    def emit() -> None:
        nonlocal cur_parts, cur_len, cur_heading
        body = "\n\n".join(p for p in cur_parts if p.strip()).strip()
        if body:
            chunks.append(Chunk(index=len(chunks), content=body, heading=cur_heading))
        cur_parts = []
        cur_len = 0

    for heading, block in _parse_blocks(text):
        for piece in (_split_oversized(block, max_chars) if len(block) > max_chars else [block]):
            piece = piece.strip()
            if not piece:
                continue
            # 标题变了且当前块已有内容：先在旧标题下收尾，避免主题串味
            if cur_parts and heading != cur_heading and cur_len + len(piece) > max_chars:
                emit()
            if not cur_parts:
                cur_heading = heading
            if cur_len + len(piece) > max_chars and cur_parts:
                emit()
                # 重叠：把上一块尾部带过来，避免答案正好被切断
                if overlap > 0 and chunks:
                    tail = chunks[-1].content[-overlap:].strip()
                    if tail:
                        cur_parts.append(tail)
                        cur_len = len(tail)
                cur_heading = heading
            cur_parts.append(piece)
            cur_len += len(piece) + 2

    emit()
    return [Chunk(index=i, content=c.content, heading=c.heading) for i, c in enumerate(chunks)]


# ==========================================================================
# 数据结构
# ==========================================================================

@dataclass
class SearchHit:
    doc_id: str
    title: str
    chunk_index: int
    heading: str
    content: str
    similarity: float
    distance: float
    tags: str = ""
    source: str = ""


@dataclass
class IngestResult:
    doc_id: str
    title: str
    chunks: int
    tokens: int
    requests: int
    skipped: bool
    elapsed_ms: float
    content_hash: str
    meta_updated: bool = False

    def as_dict(self) -> dict:
        return {
            "doc_id": self.doc_id,
            "title": self.title,
            "chunks": self.chunks,
            "tokens": self.tokens,
            "requests": self.requests,
            "skipped": self.skipped,
            "meta_updated": self.meta_updated,
            "elapsed_ms": round(self.elapsed_ms, 1),
            "content_hash": self.content_hash,
        }


@dataclass
class IngestReport:
    """一次批量入库的汇总。

    ``compact()`` 返回**精简后的结果列表**：被跳过的文档折叠成计数，
    因为「重新入库时大部分文档都没变」是常态，逐条罗列只会淹没真正的新增项。
    """
    results: list[IngestResult] = field(default_factory=list)

    @property
    def added(self) -> list[IngestResult]:
        return [r for r in self.results if not r.skipped]

    @property
    def skipped(self) -> list[IngestResult]:
        return [r for r in self.results if r.skipped]

    @property
    def meta_updated(self) -> list[IngestResult]:
        return [r for r in self.results if r.meta_updated]

    @property
    def total_chunks(self) -> int:
        return sum(r.chunks for r in self.results)

    @property
    def total_tokens(self) -> int:
        return sum(r.tokens for r in self.results)

    def compact(self) -> dict:
        return {
            "count": len(self.results),
            "added": len(self.added),
            "skipped": len(self.skipped),
            "meta_updated": len(self.meta_updated),
            "total_chunks": self.total_chunks,
            "total_tokens": self.total_tokens,
            "items": [r.as_dict() for r in self.added],
            "skipped_ids": [r.doc_id for r in self.skipped],
        }


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def make_doc_id(source: str | None, title: str) -> str:
    """派生稳定 doc_id —— 保证重复入库能命中同一条记录。

    身份优先级：**来源路径 > 标题**。

    - 有 ``source``（文件入库）→ 由路径派生。此时标题只是元信息，改标题仍是同一篇文档，
      走 ``meta_updated`` 分支原地更新，不重新向量化。
    - 无 ``source``（纯文本入库）→ 只能由标题派生。**标题就是身份，改名等于新建文档**。

    这个区别容易看漏：`ingest_text(text, title="新名字")` 拿不回「同一篇文档改了名」，
    而是新建了一篇。想让改名生效，必须让文档有稳定来源（`ingest_file`），
    或显式传入原来的 ``doc_id``。
    """
    seed = (source or title).strip()
    return "kb-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]


_RE_TITLE = re.compile(r"^[ \t]*#[ \t]+(.+?)[ \t]*#*[ \t]*$", re.M)


def guess_title(text: str, fallback: str) -> str:
    """用正文首个一级标题当文档标题，取不到则回退到文件名。

    直接用文件名会得到一堆「README」「index」这种没有区分度的标题，
    检索结果里模型也没法引用（实测 Agent 会主动抱怨这点）。
    """
    m = _RE_TITLE.search(text[:4000])
    if m:
        title = m.group(1).strip()
        if 0 < len(title) <= 80:
            return title
    return fallback


def read_text_file(path: Path) -> str:
    """读文本文件，UTF-8 失败时回退 GBK（国内文档常见）。"""
    data = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gbk", "gb18030"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = data.decode("utf-8", "replace")

    if path.suffix.lower() == ".json":
        # JSON 原样保留结构，但缩进后更利于模型理解层级
        try:
            return json.dumps(json.loads(text), ensure_ascii=False, indent=2)
        except Exception:
            return text
    return text


# ==========================================================================
# 存储
# ==========================================================================

class KbStore:
    """本地知识库。线程内复用连接（SQLite 连接不可跨线程共享）。"""

    def __init__(
        self,
        db_path: str | os.PathLike[str] | None = None,
        *,
        embedder: EmbeddingClient | None = None,
        create: bool = True,
    ):
        env_path = os.environ.get("KB_DB_PATH")
        self.db_path = Path(db_path or env_path or DEFAULT_DB_PATH)
        self._embedder = embedder
        self._local = threading.local()
        if create:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._init_schema()

    # ---------------- 基础设施 ----------------

    @property
    def dim(self) -> int:
        return self.embedder.config.dim

    @property
    def embedder(self) -> EmbeddingClient:
        if self._embedder is None:
            self._embedder = get_client()
        return self._embedder

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = vec_connect(self.db_path)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            finally:
                self._local.conn = None

    def _init_schema(self) -> None:
        db = self._conn()
        db.executescript(
            """
            create table if not exists kb_documents (
                doc_id       text primary key,
                title        text not null,
                source       text,
                doc_type     text default 'text',
                tags         text default '',
                n_chunks     integer not null default 0,
                n_chars      integer not null default 0,
                content_hash text not null,
                created_at   text not null,
                updated_at   text not null
            );
            create index if not exists idx_kb_documents_source on kb_documents(source);
            """
        )
        # 维度变了就必须重建向量表（vec0 的维度在建表时固化）
        row = db.execute(
            "select sql from sqlite_master where type='table' and name='kb_chunks'"
        ).fetchone()
        if row is not None and f"float[{self.dim}]" not in (row["sql"] or ""):
            raise RuntimeError(
                f"知识库 {self.db_path} 的分块表维度与当前配置不一致"
                f"（配置 dim={self.dim}，建表语句：{row['sql']}）。\n"
                "维度是建表时固化的，改维度需重建：删除 kb/knowledge.db 后重新入库。"
            )
        db.execute(
            f"""
            create virtual table if not exists kb_chunks using vec0(
                chunk_id    integer primary key,
                embedding   float[{self.dim}] distance_metric=cosine,
                doc_id      text,
                chunk_index integer,
                heading     text,
                +content    text,
                chunk_size={CHUNK_SIZE}
            )
            """
        )
        db.commit()

    # ---------------- 入库 ----------------

    def ingest_text(
        self,
        text: str,
        *,
        title: str,
        doc_id: str | None = None,
        source: str | None = None,
        doc_type: str = "text",
        tags: str = "",
        force: bool = False,
        max_chars: int = DEFAULT_MAX_CHARS,
        overlap: int = DEFAULT_OVERLAP,
        progress: ProgressCb | None = None,
    ) -> IngestResult:
        """把一段文本切块入库（用内置切块器）。同 doc_id 且内容未变时直接跳过。"""
        _emit(progress, "chunking", 0, 1)
        chunks = chunk_text(text, max_chars=max_chars, overlap=overlap)
        _emit(progress, "chunking", 1, 1)
        return self._ingest(
            chunks,
            fingerprint=_sha256(text),
            n_chars=len(text),
            title=title,
            doc_id=doc_id,
            source=source,
            doc_type=doc_type,
            tags=tags,
            force=force,
            progress=progress,
        )

    def ingest_chunks(
        self,
        chunks: list[Chunk],
        *,
        title: str,
        doc_id: str | None = None,
        source: str | None = None,
        doc_type: str = "text",
        tags: str = "",
        force: bool = False,
        progress: ProgressCb | None = None,
    ) -> IngestResult:
        """用**调用方自己切好的**分块入库，跳过内置切块器。

        适用于「每个单元本身就是一个完整语义块」的语料：问答对（FAQ）、
        表格行、工单记录等。内置切块器是为长文档设计的——它会把相邻的短单元
        贪心打包进同一个 chunk，导致检索命中一个片段却混着好几条无关问答，
        相似度被稀释。这类语料应当一问一答一个片段。

        幂等：指纹由全部分块的「标题 + 正文」拼接后 sha256，顺序敏感。
        """
        _emit(progress, "chunking", 0, 1)
        prepared = [
            Chunk(index=i, content=c.content, heading=c.heading)
            for i, c in enumerate(chunks)
        ]
        fingerprint = _sha256(
            "\n\n".join(f"{c.heading}\n{c.content}" for c in prepared)
        )
        _emit(progress, "chunking", 1, 1)
        return self._ingest(
            prepared,
            fingerprint=fingerprint,
            n_chars=sum(len(c.content) for c in prepared),
            title=title,
            doc_id=doc_id,
            source=source,
            doc_type=doc_type,
            tags=tags,
            force=force,
            progress=progress,
        )

    def _ingest(
        self,
        chunks: list[Chunk],
        *,
        fingerprint: str,
        n_chars: int,
        title: str,
        doc_id: str | None,
        source: str | None,
        doc_type: str,
        tags: str,
        force: bool,
        progress: ProgressCb | None = None,
    ) -> IngestResult:
        """入库内核：幂等判断 → 向量化 → 写入。切块方式由调用方决定。"""
        t0 = time.perf_counter()
        doc_id = doc_id or make_doc_id(source, title)
        digest = fingerprint
        db = self._conn()

        if not force:
            row = db.execute(
                "select content_hash, title, tags, source, n_chunks, n_chars "
                "from kb_documents where doc_id = ?",
                (doc_id,),
            ).fetchone()
            if row is not None and row["content_hash"] == digest:
                # 内容没变：不重新向量化（零额度）。但如果标题 / 标签 / 来源变了，
                # 仍然要更新文档记录 —— 否则「改个标题」会被当成无事发生。
                if (row["title"] != title
                        or (row["tags"] or "") != (tags or "")
                        or (row["source"] or "") != (source or "")):
                    with db:
                        self._upsert_document(db, doc_id, title, source, doc_type, tags,
                                              row["n_chunks"], row["n_chars"], digest)
                    return IngestResult(doc_id, title, 0, 0, 0, True,
                                        (time.perf_counter() - t0) * 1000, digest,
                                        meta_updated=True)
                return IngestResult(doc_id, title, 0, 0, 0, True,
                                    (time.perf_counter() - t0) * 1000, digest)

        if not chunks:
            # 空文档：清掉旧块但保留一条占位记录，避免 doc_id 变成幽灵
            self._delete_chunks(doc_id)
            self._upsert_document(db, doc_id, title, source, doc_type, tags,
                                  0, n_chars, digest)
            return IngestResult(doc_id, title, 0, 0, 0, False,
                                (time.perf_counter() - t0) * 1000, digest)

        _emit(progress, "embedding", 0, len(chunks))
        result = self.embedder.embed_documents(
            [c.embed_text for c in chunks],
            on_batch=lambda done, total: _emit(progress, "embedding", done, total),
        )
        vectors = result.vectors

        _emit(progress, "writing", 0, 1)
        # 先删旧块再写新块。vec0 与普通表在同一事务里，SQLite 能保证一致性。
        with db:
            self._delete_chunks(doc_id)
            db.executemany(
                "insert into kb_chunks(embedding, doc_id, chunk_index, heading, content) "
                "values (?, ?, ?, ?, ?)",
                [
                    (serialize_f32(vectors[i]), doc_id, c.index, c.heading, c.content)
                    for i, c in enumerate(chunks)
                ],
            )
            self._upsert_document(db, doc_id, title, source, doc_type, tags,
                                  len(chunks), n_chars, digest)
        _emit(progress, "writing", 1, 1)

        return IngestResult(doc_id, title, len(chunks), result.total_tokens,
                            result.requests, False,
                            (time.perf_counter() - t0) * 1000, digest)

    def ingest_file(
        self,
        path: str | os.PathLike[str],
        *,
        title: str | None = None,
        tags: str = "",
        force: bool = False,
        **kw,
    ) -> IngestResult:
        p = Path(path)
        if not p.is_file():
            raise FileNotFoundError(f"文件不存在：{p}")
        text = read_text_file(p)
        return self.ingest_text(
            text,
            title=title or guess_title(text, p.stem),
            source=str(p),
            doc_type=p.suffix.lstrip(".").lower() or "text",
            tags=tags,
            force=force,
            **kw,
        )

    def ingest_directory(
        self,
        path: str | os.PathLike[str],
        *,
        recursive: bool = True,
        suffixes: set[str] | None = None,
        tags: str = "",
        force: bool = False,
        max_files: int = 500,
        **kw,
    ) -> IngestReport:
        """把目录下的文本文件批量入库。单文件失败不中断整批。"""
        root = Path(path)
        if not root.is_dir():
            raise NotADirectoryError(f"目录不存在：{root}")
        allow = suffixes or TEXT_SUFFIXES
        pattern = "**/*" if recursive else "*"
        files = sorted(
            f for f in root.glob(pattern)
            if f.is_file() and f.suffix.lower() in allow and not f.name.startswith(".")
        )[:max_files]

        report = IngestReport()
        for f in files:
            try:
                report.results.append(self.ingest_file(f, tags=tags, force=force, **kw))
            except (OSError, EmbeddingError) as e:
                report.results.append(
                    IngestResult(
                        doc_id=make_doc_id(str(f), f.stem),
                        title=f"{f.name}（失败：{type(e).__name__}: {str(e)[:80]}）",
                        chunks=0, tokens=0, requests=0, skipped=True,
                        elapsed_ms=0.0, content_hash="",
                    )
                )
        if report.added:
            # 批量写入后 WAL 会明显膨胀，收尾时合并回主库
            self.checkpoint()
        return report

    def _upsert_document(self, db, doc_id, title, source, doc_type, tags,
                         n_chunks, n_chars, digest) -> None:
        now = _now()
        db.execute(
            """
            insert into kb_documents
                (doc_id, title, source, doc_type, tags, n_chunks, n_chars,
                 content_hash, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(doc_id) do update set
                title = excluded.title,
                source = excluded.source,
                doc_type = excluded.doc_type,
                tags = excluded.tags,
                n_chunks = excluded.n_chunks,
                n_chars = excluded.n_chars,
                content_hash = excluded.content_hash,
                updated_at = excluded.updated_at
            """,
            (doc_id, title, source, doc_type, tags, n_chunks, n_chars, digest, now, now),
        )

    def _delete_chunks(self, doc_id: str) -> int:
        db = self._conn()
        n = db.execute("select count(*) from kb_chunks where doc_id = ?",
                       (doc_id,)).fetchone()[0]
        db.execute("delete from kb_chunks where doc_id = ?", (doc_id,))
        return n

    # ---------------- 检索 ----------------

    def search(
        self,
        query: str,
        *,
        top_k: int = 5,
        doc_id: str | None = None,
        tags: str | None = None,
        min_similarity: float = 0.0,
        with_instruction: bool = True,
    ) -> list[SearchHit]:
        """向量检索。``similarity = 1 - cosine 距离``，越大越相关。"""
        if not query or not query.strip():
            raise ValueError("查询不能为空")
        if top_k < 1:
            raise ValueError("top_k 必须 ≥ 1")

        qvec = self.embedder.embed_query(query) if with_instruction else \
            self.embedder.embed_documents([query]).vectors[0]

        sql = [
            "select chunk_id, doc_id, chunk_index, heading, content, distance",
            "from kb_chunks",
            "where embedding match ?",
        ]
        params: list = [serialize_f32(qvec)]
        if doc_id:
            sql.append("and doc_id = ?")
            params.append(doc_id)
        sql.append("order by distance limit ?")
        # 过滤在 Python 侧做，所以多取一些候选再裁剪
        params.append(max(top_k * 4, top_k))

        rows = self._conn().execute(" ".join(sql), params).fetchall()

        doc_ids = {r["doc_id"] for r in rows}
        meta: dict[str, sqlite3.Row] = {}
        if doc_ids:
            placeholders = ",".join("?" * len(doc_ids))
            for r in self._conn().execute(
                f"select doc_id, title, tags, source from kb_documents "
                f"where doc_id in ({placeholders})",
                tuple(doc_ids),
            ).fetchall():
                meta[r["doc_id"]] = r

        want_tags = {t.strip() for t in (tags or "").split(",") if t.strip()}
        hits: list[SearchHit] = []
        for r in rows:
            m = meta.get(r["doc_id"])
            row_tags = (m["tags"] if m else "") or ""
            if want_tags and not (want_tags & {t.strip() for t in row_tags.split(",")}):
                continue
            dist = float(r["distance"])
            sim = 1.0 - dist
            if sim < min_similarity:
                continue
            hits.append(SearchHit(
                doc_id=r["doc_id"],
                title=(m["title"] if m else r["doc_id"]),
                chunk_index=int(r["chunk_index"] or 0),
                heading=r["heading"] or "",
                content=r["content"] or "",
                similarity=sim,
                distance=dist,
                tags=row_tags,
                source=(m["source"] if m else "") or "",
            ))
            if len(hits) >= top_k:
                break
        return hits

    # ---------------- 管理与统计 ----------------

    def list_documents(self) -> list[dict]:
        rows = self._conn().execute(
            "select doc_id, title, source, doc_type, tags, n_chunks, n_chars, "
            "created_at, updated_at from kb_documents order by updated_at desc"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_document(self, doc_id: str) -> dict | None:
        r = self._conn().execute(
            "select * from kb_documents where doc_id = ?", (doc_id,)
        ).fetchone()
        return dict(r) if r else None

    def list_chunks(
        self,
        doc_ids: list[str] | None,
        *,
        limit: int = 200,
        offset: int = 0,
    ) -> dict:
        """按 doc_id 取**切片后的正文**（知识库文件管理页的「切片预览」用）。

        返回 ``{data, total, total_chars, offset, limit, truncated, documents, missing}``。
        ``data`` 里每一项是 ``{chunk_id, doc_id, chunk_index, heading, content, chars}``。

        两个实现细节：

        - **排序在 Python 侧做**。vec0 的 `order by` 在带 `in (...)` 过滤时
          不保证复合排序稳定，而且我们要按**调用方给的 doc_id 顺序**排（保持
          文件详情里文档的展示顺序），SQL 表达不了这个。
        - 所以必须先把命中文档的片段**全取出来**再切片分页；``limit`` 只作用于
          返回窗口。安全阀是 ``doc_ids`` 的个数上限，不是行数上限——
          单篇文档的片段数本身有限（一篇 FAQ 也就几个到几十个）。
        """
        ids = [d for d in dict.fromkeys(doc_ids or []) if d]
        if not ids:
            raise ValueError("doc_ids 不能为空")
        if len(ids) > MAX_CHUNK_DOC_IDS:
            raise ValueError(f"一次最多查询 {MAX_CHUNK_DOC_IDS} 篇文档的片段")
        if limit < 1:
            raise ValueError("limit 必须 ≥ 1")
        if offset < 0:
            raise ValueError("offset 不能为负")

        order = {d: i for i, d in enumerate(ids)}
        placeholders = ",".join("?" * len(ids))
        rows = self._conn().execute(
            f"select chunk_id, doc_id, chunk_index, heading, content "
            f"from kb_chunks where doc_id in ({placeholders})",
            tuple(ids),
        ).fetchall()
        rows = sorted(
            rows,
            key=lambda r: (
                order.get(r["doc_id"], 1 << 30),
                int(r["chunk_index"] or 0),
                int(r["chunk_id"] or 0),
            ),
        )

        # 文档元信息：让这个接口自包含（前端拿到 chunk 就知道属于哪篇文档）
        meta_rows = self._conn().execute(
            f"select doc_id, title, source, doc_type, tags, n_chunks, n_chars "
            f"from kb_documents where doc_id in ({placeholders})",
            tuple(ids),
        ).fetchall()
        meta = {r["doc_id"]: dict(r) for r in meta_rows}
        documents = [
            {
                "doc_id": d,
                **{k: meta[d].get(k) for k in
                   ("title", "source", "doc_type", "tags", "n_chunks", "n_chars")},
            }
            for d in ids if d in meta
        ]

        window = rows[offset: offset + limit]
        data = [
            {
                "chunk_id": int(r["chunk_id"] or 0),
                "doc_id": r["doc_id"],
                "chunk_index": int(r["chunk_index"] or 0),
                "heading": r["heading"] or "",
                "content": r["content"] or "",
                "chars": len(r["content"] or ""),
            }
            for r in window
        ]
        return {
            "data": data,
            "total": len(rows),
            "total_chars": sum(len(r["content"] or "") for r in rows),
            "offset": offset,
            "limit": limit,
            "truncated": offset + len(window) < len(rows),
            "documents": documents,
            "missing": [d for d in ids if d not in meta],
        }

    def delete_document(self, doc_id: str) -> int:
        db = self._conn()
        with db:
            n = self._delete_chunks(doc_id)
            db.execute("delete from kb_documents where doc_id = ?", (doc_id,))
        return n

    def clear(self) -> int:
        db = self._conn()
        n = db.execute("select count(*) from kb_chunks").fetchone()[0]
        with db:
            db.execute("delete from kb_chunks")
            db.execute("delete from kb_documents")
        return n

    def checkpoint(self) -> None:
        """把 WAL 合并回主库文件。

        WAL 不会自动收缩：反复入库 / 删除会让 `-wal` 文件持续膨胀
        （实测几十次增删后能到 8 MB 以上，远超主库本身）。
        批量入库结束后调一次即可。失败不致命（可能有并发读者占用），静默跳过。
        """
        try:
            self._conn().execute("pragma wal_checkpoint(truncate)")
        except sqlite3.DatabaseError:
            pass

    def stats(self) -> dict:
        db = self._conn()
        n_docs = db.execute("select count(*) from kb_documents").fetchone()[0]
        n_chunks = db.execute("select count(*) from kb_chunks").fetchone()[0]
        n_chars = db.execute(
            "select coalesce(sum(n_chars), 0) from kb_documents").fetchone()[0]
        size = 0
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.db_path) + suffix)
            if p.is_file():
                size += p.stat().st_size
        return {
            "db_path": str(self.db_path),
            "dim": self.dim,
            "model": self.embedder.config.model,
            "documents": n_docs,
            "chunks": n_chunks,
            "total_chars": n_chars,
            "size_bytes": size,
        }


_STORE: KbStore | None = None
_STORE_LOCK = threading.Lock()


def get_store(force_new: bool = False) -> KbStore:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None or force_new:
            _STORE = KbStore()
        return _STORE


def format_hits(hits: list[SearchHit], *, max_chars_per_hit: int = 900) -> str:
    """把检索结果渲染成给模型看的文本。每条都带出处，方便模型引用。"""
    if not hits:
        return "（知识库中没有检索到相关内容）"
    parts = []
    for i, h in enumerate(hits, 1):
        where = f"《{h.title}》"
        if h.heading:
            where += f" › {h.heading}"
        where += f" · 第 {h.chunk_index + 1} 段"
        body = h.content if len(h.content) <= max_chars_per_hit else \
            h.content[:max_chars_per_hit] + "…"
        parts.append(f"[{i}] {where}（相似度 {h.similarity:.3f}）\n{body}")
    return "\n\n".join(parts)


def describe() -> dict:
    """配置快照，不含密钥。"""
    cfg = EmbeddingConfig.from_env()
    return {
        "db_path": str(Path(os.environ.get("KB_DB_PATH") or DEFAULT_DB_PATH)),
        "model": cfg.model,
        "dim": cfg.dim,
        "distance_metric": "cosine",
        "max_chars": DEFAULT_MAX_CHARS,
        "overlap": DEFAULT_OVERLAP,
    }
