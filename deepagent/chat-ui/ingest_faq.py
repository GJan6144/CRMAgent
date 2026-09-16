"""把「问答对」CSV 导入本地知识库（FAQ 专用入库器）。

为什么单独写一个脚本
--------------------
FAQ 类语料的最小语义单元是「一问一答」，而不是长度均匀的文本块。
内置切块器是为长文档设计的——它按 ``max_chars`` 贪心打包，会把相邻的好几组
问答塞进同一个片段：检索命中后模型拿到的是一锅混装问答，相似度也被稀释。
本脚本改用 ``KbStore.ingest_chunks()``，让 **一组问答 = 一个片段**，
把分类写进片段标题路径，检索结果因此既精准又能标注出处。

文档粒度
--------
同一份 CSV 按「分类」拆成多篇文档（不是 30 篇，也不是 1 篇）：
文档级元信息（来源、标签）才有意义，而片段级保持一问一答。
``doc_id`` 由「文件路径 + 分类」派生 → 重复导入同一文件命中同一条记录，
内容未变则零额度跳过。

CSV 约定
--------
需带表头，列名宽松匹配：

- 问题列：``问`` / ``问题`` / ``question``
- 答案列：``答`` / ``答案`` / ``answer``
- 分类列：``分类`` / ``类别`` / ``category``（可缺省，缺省归入「未分类」）

用法
----
    python ingest_faq.py <csv文件> [--title 课程FAQ] [--clear] [--force]
"""

from __future__ import annotations

import argparse
import csv
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from kb_store import Chunk, KbStore, make_doc_id, read_text_file  # noqa: E402

QUESTION_KEYS = ("问", "问题", "question", "q")
ANSWER_KEYS = ("答", "答案", "answer", "a")
CATEGORY_KEYS = ("分类", "类别", "category", "类别名称")

UNCATEGORIZED = "未分类"


def _pick(item: dict[str, str], keys: tuple[str, ...]) -> str:
    """按候选列名宽松取值（大小写不敏感）。"""
    for want in keys:
        for k, v in item.items():
            if k.lower() == want.lower() and v:
                return v
    return ""


def load_rows(csv_path: Path) -> list[dict[str, str]]:
    """读 CSV 成 ``[{q, a, cat}]``。表头为空行 / 缺列会明确报错。"""
    text = read_text_file(csv_path)
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError("CSV 缺少表头行")

    rows: list[dict[str, str]] = []
    for raw in reader:
        item = {
            (k or "").strip(): (v or "").strip()
            for k, v in raw.items()
            if k is not None
        }
        q = _pick(item, QUESTION_KEYS)
        a = _pick(item, ANSWER_KEYS)
        if not q and not a:
            continue  # 全空行（表格末尾常见）
        rows.append({
            "q": q,
            "a": a,
            "cat": _pick(item, CATEGORY_KEYS) or UNCATEGORIZED,
        })
    if not rows:
        raise ValueError("CSV 里没有解析出任何问答行，请检查列名是否为 问/答")
    return rows


def build_docs(rows: list[dict[str, str]]) -> list[tuple[str, list[Chunk]]]:
    """按分类分组 → 每组问答一个 Chunk。返回 ``[(分类, chunks)]``，保持出现顺序。"""
    groups: dict[str, list[dict[str, str]]] = {}
    order: list[str] = []
    for r in rows:
        cat = r["cat"]
        if cat not in groups:
            groups[cat] = []
            order.append(cat)
        groups[cat].append(r)

    out: list[tuple[str, list[Chunk]]] = []
    for cat in order:
        chunks: list[Chunk] = []
        for r in groups[cat]:
            body = f"问：{r['q']}\n答：{r['a']}" if r["a"] else f"问：{r['q']}"
            chunks.append(Chunk(index=len(chunks), content=body, heading=cat))
        out.append((cat, chunks))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把问答对 CSV 导入本地知识库")
    ap.add_argument("csv", help="CSV 文件路径")
    ap.add_argument("--title", default=None,
                    help="文档标题前缀，默认取文件名；最终标题为「前缀 · 分类」")
    ap.add_argument("--clear", action="store_true",
                    help="入库前先清空知识库（会删除全部现有文档）")
    ap.add_argument("--force", action="store_true",
                    help="忽略内容指纹，强制重新向量化")
    args = ap.parse_args(argv)

    csv_path = Path(args.csv).expanduser()
    if not csv_path.is_file():
        print(f"错误：文件不存在：{csv_path}")
        return 2
    csv_path = csv_path.resolve()
    base = args.title or csv_path.stem

    try:
        rows = load_rows(csv_path)
    except (ValueError, OSError) as e:
        print(f"错误：解析 CSV 失败：{e}")
        return 2

    docs = build_docs(rows)
    print(f"CSV：{csv_path}")
    print(f"解析到 {len(rows)} 组问答，归入 {len(docs)} 个分类：")
    for cat, chunks in docs:
        print(f"  · {cat}：{len(chunks)} 组")

    store = KbStore()
    if args.clear:
        removed = store.clear()
        print(f"\n已清空知识库（移除 {removed} 个片段）")

    print("\n开始入库：")
    added_chunks = 0
    added_docs = 0
    skipped = 0
    tokens = 0
    for cat, chunks in docs:
        title = f"{base} · {cat}"
        # 身份 = 文件路径 + 分类：同一文件重复导入命中同一条记录
        doc_id = make_doc_id(f"{csv_path}::{cat}", title)
        r = store.ingest_chunks(
            chunks,
            title=title,
            doc_id=doc_id,
            source=str(csv_path),
            doc_type="csv",
            tags=cat,
            force=args.force,
        )
        if r.skipped:
            skipped += 1
            flag = "更新元信息" if r.meta_updated else "跳过（未变化）"
            print(f"  · 《{title}》 {flag}")
            continue
        added_docs += 1
        added_chunks += r.chunks
        tokens += r.tokens
        print(f"  · 《{title}》 +{r.chunks} 片段 / {r.tokens} token / {r.elapsed_ms:.0f} ms")

    store.checkpoint()
    st = store.stats()
    print(f"\n入库完成：新增 {added_docs} 篇 / {added_chunks} 片段 / {tokens} token"
          f"，跳过 {skipped} 篇")
    print(f"知识库现状：{st['documents']} 篇文档 / {st['chunks']} 片段 / "
          f"{st['total_chars']} 字 / {st['size_bytes'] / 1024:.1f} KB")
    store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
