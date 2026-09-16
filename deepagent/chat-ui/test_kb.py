"""知识库测试：切块 / 入库幂等 / 检索排序 / 过滤 / 删除 / 统计。

会真实调用硅基流动 Embedding API（约 20 次请求），请先确认 .env 已配置。

运行：
    python test_kb.py
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from kb_embeddings import EmbeddingClient, EmbeddingConfig, EmbeddingError  # noqa: E402
from kb_store import (  # noqa: E402
    DEFAULT_DB_PATH,
    Chunk,
    KbStore,
    chunk_text,
    format_hits,
    guess_title,
    make_doc_id,
    read_text_file,
)

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


DOCS = {
    "价格政策": """# 价格政策

## 标准版

标准版定价 12800 元每年，包含 5 个并发用户席位。
超出部分按每个席位 1800 元每年加收。新客户首年可享 9 折优惠。

## 企业版

企业版定价 48000 元每年，不限制并发用户数量。
企业版包含专属技术支持与季度上门巡检服务。

## 折扣规则

连续签约两年可享 9 折；签约三年及以上可享 85 折。
政府与教育行业额外下浮 10 个百分点。
""",
    "部署指南": """# 部署指南

## 环境要求

私有化部署至少需要 8 核 16G 内存的服务器，磁盘预留 200G。
数据库推荐 PostgreSQL 14 及以上版本，也可使用 MySQL 8。

## 容器化部署

```bash
docker run -d -p 8080:8080 -v /data/crm:/data crm-agent:latest
```

启动后访问 http://localhost:8080 进行初始化配置。

## 常见问题

端口被占用时可通过 -p 参数更换映射端口。
首次启动初始化数据库约需 3 分钟，请耐心等待。
""",
    "售后条款": """# 售后服务条款

标准版提供工作日 5x8 小时在线支持，响应时间不超过 4 小时。
企业版提供 7x24 小时支持，紧急故障响应时间不超过 30 分钟。

软件质保期为交付验收后 12 个月，质保期内免费修复缺陷。
质保期外的故障处理按 2000 元每人天计费。
""",
    "竞品对比": """# 竞品对比

与销售易相比，本产品的私有化部署能力更强，且不限制并发用户。
与纷享销客相比，本产品的价格低约 30%，但移动端体验略逊。

选型建议：重视数据自主可控的客户优先考虑本产品；
以移动办公为主的团队建议先试用再做决策。
""",
}


def main() -> int:
    cfg = EmbeddingConfig.from_env()
    print(f"模型 : {cfg.model}  dim={cfg.dim}  batch={cfg.batch_size}")
    print(f"密钥 : {'已配置' if cfg.api_key else '缺失'}")
    if not cfg.api_key:
        print("\n缺少 SILICONFLOW_API_KEY，无法运行需要联网的用例。")
        return 1

    print("\n=== A. 切块（不消耗 API）===")
    cs = chunk_text(DOCS["价格政策"], max_chars=100, overlap=30)
    check("切出多块", len(cs) > 1, f"{len(cs)} 块")
    check("标题路径被记录", all(c.heading for c in cs), cs[0].heading)
    check("块长不超上限", all(len(c.content) <= 100 for c in cs),
          f"max={max(len(c.content) for c in cs)}")
    check("块序号连续", [c.index for c in cs] == list(range(len(cs))))
    check("空文本切出 0 块", chunk_text("") == [] and chunk_text("\n \n") == [])

    print("\n=== A2. 标题推断 ===")
    check("取正文首个 H1", guess_title("# 部署指南\n\n正文", "readme") == "部署指南")
    check("跳过前导空行与注释", guess_title("\n\n# 竞价策略\n正文", "x") == "竞价策略")
    check("无标题时回退到文件名", guess_title("没有标题的正文", "readme") == "readme")
    check("只认 H1 不认 H2", guess_title("## 二级标题\n正文", "fallback") == "fallback")
    check("超长标题被拒绝", guess_title("# " + "很" * 200, "fallback") == "fallback")

    tmpdir = Path(tempfile.mkdtemp(prefix="kbtest_"))
    db_path = tmpdir / "knowledge.db"
    store = KbStore(db_path)
    try:
        print(f"\n=== B. 入库（库文件 {db_path.name}）===")
        t0 = time.perf_counter()
        results = {}
        for title, text in DOCS.items():
            r = store.ingest_text(text, title=title, tags="测试", doc_type="md")
            results[title] = r
            print(f"  · {title}: {r.chunks} 块 / {r.tokens} tokens / {r.elapsed_ms:.0f} ms")
        elapsed = (time.perf_counter() - t0) * 1000
        check("四篇文档全部入库", all(not r.skipped for r in results.values()))
        check("每篇都切出至少 1 块", all(r.chunks >= 1 for r in results.values()))
        check("token 用量已统计", sum(r.tokens for r in results.values()) > 0,
              f"合计 {sum(r.tokens for r in results.values())} tokens / {elapsed:.0f} ms")

        st = store.stats()
        check("统计：文档数", st["documents"] == 4, str(st["documents"]))
        check("统计：分块数 = 各文档之和",
              st["chunks"] == sum(r.chunks for r in results.values()), str(st["chunks"]))
        check("统计：维度与配置一致", st["dim"] == cfg.dim, str(st["dim"]))
        # vec0 按 chunk_size 整块预留存储；默认 1024 会让小库凭空占 4 MB
        check("存储未因预留块而放大", st["size_bytes"] < 2 * 1024 * 1024,
              f"{st['size_bytes'] / 1024:.0f} KB（{st['chunks']} 块 × {cfg.dim} 维）")

        print("\n=== C. 幂等：重复入库不产生 API 调用 ===")
        r2 = store.ingest_text(DOCS["价格政策"], title="价格政策", tags="测试", doc_type="md")
        check("内容未变 -> 跳过", r2.skipped is True)
        check("跳过时零 token", r2.tokens == 0, str(r2.tokens))
        check("跳过时块数不变", store.stats()["chunks"] == st["chunks"])

        print("\n=== C2. 元信息变更（正文不变，不重新向量化）===")
        # 「改标题」能成为元信息更新的前提是**身份稳定**。
        # 文件入库时 doc_id 由来源路径派生，标题只是元信息 —— 所以走这条路。
        pdoc = tmpdir / "price_src.md"
        pdoc.write_text(DOCS["价格政策"], encoding="utf-8")
        f1 = store.ingest_file(pdoc, title="价格政策·文件版", tags="测试")
        check("文件首次入库", not f1.skipped and f1.chunks >= 1, f"{f1.chunks} 块")
        chunks_after_f1 = store.stats()["chunks"]

        f2 = store.ingest_file(pdoc, title="价格政策·已更名", tags="测试")
        check("改标题 -> 识别为元信息更新", f2.skipped and f2.meta_updated)
        check("元信息更新零 token", f2.tokens == 0, str(f2.tokens))
        check("doc_id 未变（身份由来源路径决定）", f2.doc_id == f1.doc_id, f2.doc_id)
        check("新标题已落库",
              store.get_document(f2.doc_id)["title"] == "价格政策·已更名")
        check("分块数不受影响", store.stats()["chunks"] == chunks_after_f1)

        f3 = store.ingest_file(pdoc, title="价格政策·已更名", tags="另一批标签")
        check("仅标签变更也算元信息更新", f3.meta_updated and f3.tokens == 0)
        check("标签已落库", store.get_document(f3.doc_id)["tags"] == "另一批标签")

        # 这篇文件版正文与《价格政策》逐字相同，留着会让 E 段的语义排序出现同分并列
        # （排到谁前面取决于插入顺序），那测的就不是排序本身了。用完即清。
        n_docs_before = store.stats()["documents"]
        store.delete_document(f3.doc_id)
        check("清理元信息测试文档", store.stats()["documents"] == n_docs_before - 1)

        # 反向钉住语义：纯文本入库没有来源，标题**就是**身份，改名等于新建文档。
        # 这解释了为什么「改标题」这条路必须走文件入库才成立。
        n_docs_before = store.stats()["documents"]
        rt = store.ingest_text(DOCS["价格政策"], title="价格政策·纯文本改名", doc_type="md")
        check("纯文本改名 -> 视为新文档（身份即标题）",
              not rt.skipped and rt.doc_id != results["价格政策"].doc_id,
              f"新增文档 {n_docs_before} -> {store.stats()['documents']}")
        store.delete_document(rt.doc_id)
        check("清理后语料复原", store.stats()["documents"] == n_docs_before)

        print("\n=== D. 内容变更 -> 重新入库 ===")
        changed = DOCS["价格政策"].replace("12800 元每年", "13800 元每年")
        # C2 新增过文档，块总数已变，这里必须重新取快照
        chunks_before = store.stats()["chunks"]
        r3 = store.ingest_text(changed, title="价格政策", tags="测试", doc_type="md")
        check("内容变更 -> 重新向量化", r3.skipped is False and r3.tokens > 0)
        check("doc_id 保持不变（原地更新）",
              r3.doc_id == results["价格政策"].doc_id, r3.doc_id)
        check("旧块被替换而非追加",
              store.stats()["chunks"]
              == chunks_before - results["价格政策"].chunks + r3.chunks,
              f"{chunks_before} -> {store.stats()['chunks']}")

        print("\n=== E. 检索：相关度排序 ===")
        cases = [
            ("标准版一年多少钱？", "价格政策"),
            ("服务器最低配置要求是什么？", "部署指南"),
            ("紧急故障多久响应？", "售后条款"),
            ("和销售易比有什么优势？", "竞品对比"),
        ]
        for q, expect in cases:
            hits = store.search(q, top_k=3)
            top = hits[0].title if hits else "（无）"
            check(f"「{q}」-> 《{expect}》", top == expect,
                  f"实际 top1=《{top}》 相似度={hits[0].similarity:.3f}" if hits else "无结果")
        check("检索结果按相似度降序",
              all(hits[i].similarity >= hits[i + 1].similarity for i in range(len(hits) - 1)))

        print("\n=== F. 检索：过滤与阈值 ===")
        all_hits = store.search("价格", top_k=5)
        check("默认覆盖全部文档", len({h.doc_id for h in all_hits}) >= 1)
        one = store.search("价格", top_k=5, doc_id=results["价格政策"].doc_id)
        check("按 doc_id 收窄", one and all(h.doc_id == results["价格政策"].doc_id for h in one),
              f"{len(one)} 条")
        tagged = store.search("价格", top_k=5, tags="测试")
        check("按 tags 过滤（命中）", len(tagged) >= 1, f"{len(tagged)} 条")
        none_tag = store.search("价格", top_k=5, tags="不存在的标签")
        check("按 tags 过滤（排除）", none_tag == [])
        high = store.search("价格", top_k=5, min_similarity=0.99)
        check("相似度阈值生效", len(high) <= len(all_hits),
              f"阈值 0.99 -> {len(high)} 条 / 不限 {len(all_hits)} 条")

        print("\n=== G. 检索：内容与出处 ===")
        hit = store.search("标准版包含几个并发用户？", top_k=1)[0]
        check("返回片段原文", "12800" in hit.content or "13800" in hit.content or "并发" in hit.content,
              hit.content[:40])
        check("带标题与段落号", hit.title == "价格政策" and hit.heading, hit.heading)
        check("相似度为 1 - 余弦距离", abs(hit.similarity - (1 - hit.distance)) < 1e-9,
              f"sim={hit.similarity:.6f} dist={hit.distance:.6f}")
        rendered = format_hits([hit])
        check("渲染文本含出处与相似度", "相似度" in rendered and hit.title in rendered)

        print("\n=== H. 异常输入 ===")
        try:
            store.search("")
            check("空查询被拒绝", False, "未报错")
        except ValueError:
            check("空查询被拒绝", True)
        try:
            store.search("价格", top_k=0)
            check("top_k=0 被拒绝", False, "未报错")
        except ValueError:
            check("top_k=0 被拒绝", True)

        empty = store.ingest_text("", title="空文档")
        check("空文档不产生分块", empty.chunks == 0 and not empty.skipped)
        check("空文档记录了占位", store.get_document(empty.doc_id) is not None)

        print("\n=== I. 删除 ===")
        before = store.stats()["chunks"]
        n = store.delete_document(results["售后条款"].doc_id)
        check("删除返回被删块数", n == results["售后条款"].chunks, str(n))
        check("分块总量下降", store.stats()["chunks"] == before - n)
        check("文档记录已移除", store.get_document(results["售后条款"].doc_id) is None)
        gone = store.search("紧急故障多久响应？", top_k=3)
        check("已删文档不再被检索到",
              all(h.doc_id != results["售后条款"].doc_id for h in gone),
              f"top1=《{gone[0].title}》" if gone else "无结果")

        print("\n=== J. 目录入库与文件读取 ===")
        src = tmpdir / "files"
        src.mkdir()
        (src / "a.md").write_text("# 甲文档\n\n这是甲文档的正文内容，讲的是客户分级管理。\n", encoding="utf-8")
        (src / "b.txt").write_text("乙文档正文：代理商返点比例是 15%。\n", encoding="utf-8")
        (src / "c.log").write_text("这条日志不该被入库\n", encoding="utf-8")
        (src / "note.rst").write_text("跳过我\n", encoding="utf-8")
        report = store.ingest_directory(src, suffixes={".md", ".txt"}, recursive=False)
        check("只入库指定后缀", report.compact()["count"] == 2,
              f"入库 {report.compact()['count']} 个（.md + .txt）")
        check("目录汇总统计", report.compact()["added"] == 2 and report.total_chunks >= 2,
              str(report.compact()["added"]))
        titles = {d["title"] for d in store.list_documents()}
        check("默认标题取正文 H1 而非文件名", "甲文档" in titles and "a" not in titles,
              str(sorted(t for t in titles if "文档" in t or t in ("a", "b"))))
        check("无 H1 的文件回退到文件名", "b" in titles)

        extra = tmpdir / "extra"
        extra.mkdir()
        gbk = extra / "gbk.txt"
        gbk.write_bytes("GBK 编码内容：客户编号 889900。".encode("gbk"))
        check("GBK 文件可读取", "889900" in read_text_file(gbk))

        js = extra / "d.json"
        js.write_text('{"客户":"华宇科技","金额":128000}', encoding="utf-8")
        check("JSON 被格式化后入库", "\n" in read_text_file(js) and "华宇科技" in read_text_file(js))

        print("\n=== K. 幂等复跑（模拟第二次入库）===")
        report2 = store.ingest_directory(src, suffixes={".md", ".txt"}, recursive=False)
        check("复跑全部跳过", report2.compact()["added"] == 0,
              f"added={report2.compact()['added']} skipped={report2.compact()['skipped']}")
        check("复跑零 token 消耗", report2.total_tokens == 0, str(report2.total_tokens))

        print("\n=== L. WAL 收敛 ===")
        store.checkpoint()
        wal = Path(str(db_path) + "-wal")
        wal_size = wal.stat().st_size if wal.is_file() else 0
        main_size = db_path.stat().st_size
        check("checkpoint 后 WAL 已收缩", wal_size < max(main_size, 64 * 1024),
              f"wal={wal_size / 1024:.0f} KB, main={main_size / 1024:.0f} KB")

        print("\n=== M. 自定义分块入库（FAQ 问答对）===")
        # 一组问答一个片段。通用切块器按 max_chars 贪心打包，会把不相干的问答
        # 并进同一个 chunk，检索命中后模型拿到的是混装问答 —— 这里验证它没被合并。
        qa = [
            Chunk(index=0, heading="购买与售后",
                  content="问：课程支持退款吗？\n答：虚拟商品一经开通概不退款。"),
            Chunk(index=1, heading="购买与售后",
                  content="问：课程有效期多久？\n答：自开通之日起 365 天。"),
            Chunk(index=2, heading="购买与售后",
                  content="问：课程价格是多少？\n答：998 元每年。"),
        ]
        r = store.ingest_chunks(qa, title="FAQ 测试", doc_id="kb-faq-test", tags="faq")
        check("ingest_chunks 写入的分块数 == 传入分块数", r.chunks == 3, str(r.chunks))
        n_rows = store._conn().execute(
            "select count(*) from kb_chunks where doc_id = 'kb-faq-test'"
        ).fetchone()[0]
        check("库中片段数 == 3（未被内置切块器合并）", n_rows == 3, str(n_rows))

        hits = store.search("退款政策是怎么规定的", top_k=1, doc_id="kb-faq-test")
        check("检索精准命中退款那一条",
              bool(hits) and "退款" in hits[0].content,
              hits[0].content.replace("\n", "　")[:40] if hits else "（无结果）")
        check("命中片段的标题路径是分类",
              bool(hits) and hits[0].heading == "购买与售后",
              hits[0].heading if hits else "")

        r2 = store.ingest_chunks(qa, title="FAQ 测试", doc_id="kb-faq-test", tags="faq")
        check("ingest_chunks 幂等（内容未变则跳过且不耗额度）",
              r2.skipped and not r2.meta_updated, str(r2.as_dict()))

        qa_changed = list(qa)
        qa_changed[2] = Chunk(index=2, heading="购买与售后",
                              content="问：课程价格是多少？\n答：1298 元每年。")
        r3 = store.ingest_chunks(qa_changed, title="FAQ 测试",
                                 doc_id="kb-faq-test", tags="faq")
        check("内容变化后重新向量化",
              (not r3.skipped) and r3.chunks == 3, str(r3.as_dict()))
        store.delete_document("kb-faq-test")
        store.checkpoint()

        final = store.stats()
        print(f"\n最终统计: {final['documents']} 篇 / {final['chunks']} 块 / "
              f"{final['total_chars']} 字 / {final['size_bytes'] / 1024:.0f} KB")
    finally:
        store.close()
        shutil.rmtree(tmpdir, ignore_errors=True)

    print(f"\n===== 结果: {PASS} 通过 / {FAIL} 失败 =====")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
