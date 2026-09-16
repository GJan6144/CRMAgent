"""知识库 Agent 工具集。

把本地知识库（`kb_store.KbStore`）暴露给 Agent：
检索片段、把文件/目录入库、查看与删除文档。

分层
----
- 读取类（``kb_search`` / ``kb_list_documents``）→ 默认 **直接使用**
- 写入类（``kb_ingest`` / ``kb_delete_document``）→ 默认 **人工审批**，
  因为入库会调用远程 Embedding（消耗额度）并修改本地库文件

路径解析
--------
Agent 的文件系统后端以 deepagents 项目根为界（``virtual_mode=True``），
所以相对路径按项目根解析；也接受绝对路径。目录入库有文件数上限，
避免模型一句「把整个盘入库」就触发上万次 API 调用。
"""

from __future__ import annotations

import os
from pathlib import Path

from langchain_core.tools import tool

from kb_embeddings import EmbeddingError
from kb_store import (
    KbStore,
    format_hits,
    get_store,
)

# deepagents 项目根（chat-ui 的上一级）
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent

# 目录入库的文件数上限（防止一次误操作烧掉大量额度）
MAX_DIR_FILES = 200
# 单次检索返回的片段数上限
MAX_TOP_K = 20


def _store() -> KbStore:
    return get_store()


def _resolve(path: str) -> Path:
    """把模型给的路径解析成真实路径。

    三种写法都要认：

    1. 真正的绝对路径（``C:/a/b.md``）→ 原样使用；
    2. **虚拟路径**（``/chat-ui/AGENTS.md``）→ 相对 deepagents 项目根解析。
       系统提示词要求模型对文件系统工具统一使用这种以 ``/`` 开头的写法；
       而 Windows 下 pathlib 认为 ``/chat-ui/x`` **不是**绝对路径（无盘符），
       直接拼接会得到 ``C:\\chat-ui\\x``，指向错误的盘根位置；
    3. 普通相对路径（``chat-ui/AGENTS.md``）→ 按项目根解析。
    """
    raw = (path or "").strip().strip('"').strip("'")
    if not raw:
        raise ValueError("路径不能为空")
    p = Path(raw)
    if p.is_absolute():
        return p
    if p.anchor:
        # 带锚点但无盘符 —— 虚拟路径，剥掉前导斜杠后挂到项目根
        return (PROJECT_ROOT / str(p).lstrip("/\\")).resolve()
    return (PROJECT_ROOT / p).resolve()


def _fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


# ==========================================================================
# 检索
# ==========================================================================

@tool
def kb_search(query: str, top_k: int = 5, doc_id: str = "", tags: str = "") -> str:
    """在本地知识库中做语义检索，返回最相关的文档片段。

    当用户的问题涉及「知识库 / 文档 / 手册 / 制度 / 条款 / 资料库里写的内容」时使用。
    与 crm_query 的区别：crm_query 查结构化业务数据（线索、订单），
    kb_search 查非结构化的文档正文（手册、规范、方案、笔记）。

    Args:
        query: 检索问题，用自然语言描述即可（不需要关键词堆砌）。
        top_k: 返回片段数，1-20，默认 5。
        doc_id: 只在该文档内检索，留空表示全库检索。
        tags: 只检索带该标签的文档，多个标签用英文逗号分隔。

    Returns:
        若干带出处的片段文本；无结果时返回明确提示。
    """
    try:
        k = int(top_k)
    except (TypeError, ValueError):
        return f"错误：top_k 必须是整数，收到 {top_k!r}"
    k = max(1, min(k, MAX_TOP_K))

    try:
        hits = _store().search(query, top_k=k, doc_id=doc_id or None, tags=tags or None)
    except ValueError as e:
        return f"错误：{e}"
    except EmbeddingError as e:
        return f"知识库检索失败（Embedding 服务异常）：{e}"
    except Exception as e:
        return f"知识库检索失败：{type(e).__name__}: {e}"

    if not hits:
        return (f"知识库中没有检索到与「{query}」相关的内容。\n"
                "可以换个说法再试，或先用 kb_list_documents 看看库里有哪些文档。")

    head = f"知识库检索到 {len(hits)} 个相关片段（按相似度降序）：\n"
    return head + format_hits(hits)


# ==========================================================================
# 入库
# ==========================================================================

@tool
def kb_ingest(path: str, title: str = "", tags: str = "") -> str:
    """把一个文件或整个目录导入本地知识库（会切块并向量化，需人工审批）。

    适用于用户说「把这个文档加进知识库 / 把这份资料入库 / 学习一下这个目录」。
    支持 .md / .txt / .json / .csv / .yaml / .log / .rst 等文本文件。
    重复导入同一文件不会重复消耗额度：内容没变会自动跳过。

    Args:
        path: 文件或目录路径。与其它文件系统工具一致，用 `/` 开头的虚拟路径
              （如 `/chat-ui/AGENTS.md`，项目根映射为 `/`）；也接受绝对路径。
        title: 仅单文件入库时生效，用于覆盖默认标题（默认取文件名）。
        tags: 标签，多个用英文逗号分隔，便于后续检索时过滤。

    Returns:
        入库结果摘要：新增 / 跳过数量、分块数、token 消耗。
    """
    try:
        target = _resolve(path)
    except ValueError as e:
        return f"错误：{e}"

    if not target.exists():
        return f"错误：路径不存在：{target}"

    store = _store()
    try:
        if target.is_file():
            r = store.ingest_file(target, title=title or None, tags=tags)
            if r.skipped:
                if r.meta_updated:
                    return (f"已更新文档信息（正文未变化，未重新向量化、未消耗额度）：\n"
                            f"  文档：{r.title}\n  doc_id：{r.doc_id}")
                return (f"已跳过（内容未变化，无需重新向量化）：\n"
                        f"  文档：{r.title}\n  doc_id：{r.doc_id}")
            return (f"入库完成：\n"
                    f"  文档：{r.title}\n"
                    f"  doc_id：{r.doc_id}\n"
                    f"  分块：{r.chunks}\n"
                    f"  token：{r.tokens}\n"
                    f"  耗时：{r.elapsed_ms:.0f} ms")

        if target.is_dir():
            report = store.ingest_directory(
                target, tags=tags, max_files=MAX_DIR_FILES
            )
            c = report.compact()
            lines = [
                f"目录入库完成：{target}",
                f"  扫描文档：{c['count']} 篇",
                f"  新增/更新：{c['added']} 篇",
                f"  跳过（内容未变）：{c['skipped']} 篇",
                f"  合计分块：{c['total_chunks']}",
                f"  合计 token：{c['total_tokens']}",
            ]
            if c["items"]:
                lines.append("  明细：")
                for it in c["items"]:
                    lines.append(f"    · 《{it['title']}》{it['chunks']} 块 / {it['tokens']} token")
            if c["skipped"] and not c["added"]:
                lines.append("  （全部已是最新，未产生任何 Embedding 调用）")
            if c["count"] >= MAX_DIR_FILES:
                lines.append(f"  注意：已达单次上限 {MAX_DIR_FILES} 篇，"
                             "剩余文件请再次调用本工具。")
            return "\n".join(lines)

        return f"错误：不支持的路径类型：{target}"
    except EmbeddingError as e:
        return f"入库失败（Embedding 服务异常）：{e}"
    except (OSError, RuntimeError) as e:
        return f"入库失败：{type(e).__name__}: {e}"


# ==========================================================================
# 查看与删除
# ==========================================================================

@tool
def kb_list_documents() -> str:
    """列出知识库中的全部文档（标题、来源、分块数、标签）。

    在检索不到内容、或需要先了解知识库里有什么时使用。
    """
    try:
        store = _store()
        st = store.stats()
        docs = store.list_documents()
    except Exception as e:
        return f"读取知识库失败：{type(e).__name__}: {e}"

    header = (f"知识库概览：{st['documents']} 篇文档 / {st['chunks']} 个片段 / "
              f"{st['total_chars']} 字 / {_fmt_bytes(st['size_bytes'])}\n"
              f"模型：{st['model']}（{st['dim']} 维）")
    if not docs:
        return header + "\n\n（知识库还是空的，可以用 kb_ingest 导入文档）"

    lines = [header, "", "文档列表（按更新时间倒序）："]
    for d in docs:
        tags = f"　标签：{d['tags']}" if d.get("tags") else ""
        src = f"　来源：{d['source']}" if d.get("source") else ""
        lines.append(
            f"  · 《{d['title']}》{d['n_chunks']} 块 / {d['n_chars']} 字"
            f"　doc_id：{d['doc_id']}{tags}{src}"
        )
    return "\n".join(lines)


@tool
def kb_delete_document(doc_id: str) -> str:
    """从知识库中删除一篇文档及其全部片段（需人工审批）。

    删除前建议先用 kb_list_documents 确认 doc_id。

    Args:
        doc_id: 文档 id，形如 kb-xxxxxxxxxxxx。
    """
    key = (doc_id or "").strip()
    if not key:
        return "错误：doc_id 不能为空"
    try:
        store = _store()
        doc = store.get_document(key)
        if doc is None:
            return f"错误：知识库中不存在 doc_id={key} 的文档。可用 kb_list_documents 查看。"
        n = store.delete_document(key)
        return f"已删除：《{doc['title']}》（doc_id={key}），同时移除 {n} 个片段。"
    except Exception as e:
        return f"删除失败：{type(e).__name__}: {e}"


KB_TOOLS = [kb_search, kb_ingest, kb_list_documents, kb_delete_document]
KB_TOOL_NAMES = [t.name for t in KB_TOOLS]
