"""知识库**文件上传**模块测试。

覆盖：文件名清洗 / 表格解析（CSV·TSV·XLSX）/ 入库分路（问答表·普通表·纯文本）/
删除语义（受管文件连带清理）/ 上传任务队列与状态流转。

跑在**临时库 + 临时上传目录**上，不会动真实知识库（用 KB_DB_PATH / KB_UPLOAD_DIR 隔离）。
S / T / P 段不联网；I / D / Q 段真实调用 Embedding API（约 5 次请求）。

运行：
    python test_kb_upload.py
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

TMP = Path(tempfile.mkdtemp(prefix="kbupload_"))
# 必须在导入 kb_store / kb_upload 之前设好（两者都是进程内单例）
os.environ["KB_DB_PATH"] = str(TMP / "knowledge.db")
os.environ["KB_UPLOAD_DIR"] = str(TMP / "files")

import kb_upload as U  # noqa: E402
from kb_store import KbStore, MAX_CHUNK_DOC_IDS  # noqa: E402

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


def write(path: Path, text: str, *, encoding: str = "utf-8") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding=encoding)
    return path


def wait_task(manager, task_id: str, timeout: float = 180.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = manager.get(task_id)
        if t and t["status"] in ("done", "failed"):
            return t
        time.sleep(0.5)
    raise TimeoutError(f"任务 {task_id} 超时未结束")


# ==========================================================================
# 素材
# ==========================================================================

FAQ_CSV = """分类,问题,答案
购买与售后,课程多少钱,课程价格为 998 元每年
购买与售后,怎么开发票,在视频号店铺联系客服开具电子发票
课程内容,课程包含哪些模块,包含大模型基础、提示词工程、智能体开发三个模块
课程内容,智能体部分讲什么,以三个实战项目为主线讲解智能体编排
教学安排,每周需要投入多少时间,建议每周投入 4 小时左右
教学安排,直播可以回看吗,所有直播都提供回放，有效期一年
"""

PLAIN_CSV = """产品编号,产品名称,价格
PROD-001,标准版,12800
PROD-002,企业版,48000
PROD-003,教育版,6800
"""

MD_DOC = """# 售后政策

## 退款规则

付款后 7 天内未开通服务的可以全额退款。
已开通服务的按剩余服务期折算退款。

## 联系渠道

工作日 9:00-18:00 可通过视频号店铺客服咨询。
"""


def make_xlsx(path: Path) -> Path:
    import openpyxl

    wb = openpyxl.Workbook()
    ws1 = wb.active
    ws1.title = "问答"
    ws1.append(["问题", "答案", "分类"])
    ws1.append(["支持分期吗", "暂不支持分期", "支付"])
    ws1.append([1, "数字标题应还原成整数", "边界"])

    ws2 = wb.create_sheet("价格")
    ws2.append(["产品", "单价"])
    ws2.append(["标准版", 12800])

    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(path))
    wb.close()
    return path


# ==========================================================================
# 各段
# ==========================================================================

def sec_sanitize() -> None:
    print("\n=== S. 文件名清洗与后缀白名单 ===")
    check("S1 丢弃目录成分", U.sanitize_filename("../../evil.csv") == "evil.csv",
          U.sanitize_filename("../../evil.csv"))
    check("S2 丢弃 Windows 盘符路径",
          U.sanitize_filename(r"C:\Users\x\y.csv") == "y.csv",
          U.sanitize_filename(r"C:\Users\x\y.csv"))
    check("S3 非法字符替换为下划线",
          U.sanitize_filename("a?b*c.csv") == "a_b_c.csv",
          U.sanitize_filename("a?b*c.csv"))
    check("S4 去掉首尾空白与点",
          U.sanitize_filename("  .x.txt.  ") == "x.txt",
          U.sanitize_filename("  .x.txt.  "))
    for bad in ("....", "", "   ", "/", "a/b/"):
        try:
            U.sanitize_filename(bad)
            check(f"S5 拒绝无效名 {bad!r}", False, "未抛错")
        except ValueError:
            check(f"S5 拒绝无效名 {bad!r}", True)

    long_name = "长" * 200 + ".csv"
    got = U.sanitize_filename(long_name)
    check("S6 超长名截断且保留扩展名",
          len(got) <= U.MAX_NAME_CHARS and got.endswith(".csv"), f"{len(got)} 字符")

    suf = U.allowed_suffixes()
    check("S7 白名单含文本与表格类型",
          all(s in suf for s in (".md", ".txt", ".csv", ".tsv", ".json")), str(suf))
    check("S8 白名单不含可执行/二进制类型",
          not any(s in suf for s in (".exe", ".zip", ".png", ".pdf")), "")

    inside = U.UPLOAD_DIR / "a.csv"
    outside = HERE / "server.py"
    check("S9 受管目录判定", U.is_managed_file(inside) and not U.is_managed_file(outside),
          f"{inside.name}=True, {outside.name}=False")


def sec_parse() -> None:
    print("\n=== T. 表格解析 ===")
    csv_path = write(TMP / "src" / "plain.csv", PLAIN_CSV)
    groups = U._read_csv_groups(csv_path)
    check("T1 CSV 解析出表头与数据行",
          len(groups) == 1 and groups[0].headers == ["产品编号", "产品名称", "价格"]
          and len(groups[0].rows) == 3,
          f"{groups[0].headers} / {len(groups[0].rows)} 行")

    csv_path2 = write(TMP / "src" / "blank.csv",
                      "a,b\n1,2\n,\n3,4\n")
    g2 = U._read_csv_groups(csv_path2)
    check("T2 纯空行被丢弃", len(g2[0].rows) == 2, f"{len(g2[0].rows)} 行")

    tsv_path = write(TMP / "src" / "x.tsv", "问题\t答案\nA\tB\n")
    g3 = U._read_csv_groups(tsv_path)
    check("T3 TSV 按制表符解析",
          g3[0].headers == ["问题", "答案"] and g3[0].rows[0]["答案"] == "B", "")

    xlsx_path = make_xlsx(TMP / "src" / "book.xlsx")
    gx = U._read_xlsx_groups(xlsx_path)
    check("T4 多 sheet 每个 sheet 一组",
          len(gx) == 2 and [g.label for g in gx] == ["问答", "价格"],
          str([g.label for g in gx]))
    check("T5 Excel 整数还原为 '1' 而非 '1.0'",
          gx[0].rows[1]["问题"] == "1", repr(gx[0].rows[1]["问题"]))
    check("T6 Excel 数值单元格正确读出",
          gx[1].rows[0]["单价"] == "12800", gx[1].rows[0]["单价"])

    empty_head = write(TMP / "src" / "nohead.csv", "")
    try:
        U._read_csv_groups(empty_head)
        check("T7 空表格报错", False, "未抛错")
    except ValueError as e:
        check("T7 空表格报错", True, str(e))

    only_blank = write(TMP / "src" / "onlyblank.csv", "a,b\n,\n")
    try:
        U._read_csv_groups(only_blank)
        check("T8 只有空行的表格报错", False, "未抛错")
    except ValueError as e:
        check("T8 只有空行的表格报错", True, str(e))


def sec_plan() -> None:
    print("\n=== P. 入库分路规划 ===")
    faq_path = write(TMP / "src" / "faq.csv", FAQ_CSV)
    mode, jobs = U.plan_ingest(faq_path, base="课程FAQ", tags="")
    check("P1 问答表识别为 faq-table", mode == "faq-table", mode)
    check("P2 按分类拆成多篇文档", len(jobs) == 3,
          str([j[2] for j in jobs]))
    check("P3 文档标题带分类",
          jobs[0][2] == "课程FAQ · 购买与售后", jobs[0][2])
    total_chunks = sum(len(j[5]) for j in jobs)
    check("P4 一问一答一个片段（片段数 = 数据行数）", total_chunks == 6, f"{total_chunks} 片段")
    body = jobs[0][5][0].content
    check("P5 片段正文是「问：…/答：…」",
          body.startswith("问：") and "\n答：" in body, body.replace("\n", "⏎"))
    check("P6 标签写入分类", jobs[0][4] == "购买与售后", jobs[0][4])

    plain_path = write(TMP / "src" / "plain.csv", PLAIN_CSV)
    mode2, jobs2 = U.plan_ingest(plain_path, base="产品清单", tags="")
    check("P7 普通表识别为 table", mode2 == "table", mode2)
    check("P8 普通表整表一篇文档", len(jobs2) == 1, f"{len(jobs2)} 篇")
    head = jobs2[0][5][0].content.splitlines()[0]
    check("P9 片段带表头（列含义不丢）", "产品编号" in head, head)

    xlsx_path = TMP / "src" / "book.xlsx"
    mode3, jobs3 = U.plan_ingest(xlsx_path, base="手册", tags="")
    # 「问答」sheet 是问答表 → 按分类拆 2 篇；「价格」sheet 是清单 → 整表 1 篇
    check("P10 混合工作簿逐组判定，标题带 sheet 名",
          mode3 == "mixed-table" and len(jobs3) == 3
          and jobs3[1][2] == "手册 · 问答 · 边界" and jobs3[2][2] == "手册 · 价格",
          f"{mode3} / {[j[2] for j in jobs3]}")

    md_path = write(TMP / "src" / "doc.md", MD_DOC)
    mode4, jobs4 = U.plan_ingest(md_path, base="doc", tags="")
    check("P11 纯文本走 text 分支", mode4 == "text", mode4)
    check("P12 标题取 H1 而非文件名", jobs4[0][2] == "售后政策", jobs4[0][2])
    check("P13 纯文本 doc_id 交由存储层按来源派生", jobs4[0][1] is None, "")

    blank = write(TMP / "src" / "blank.md", "   \n\n")
    try:
        U.plan_ingest(blank, base="blank", tags="")
        check("P14 空文本报错", False, "未抛错")
    except ValueError as e:
        check("P14 空文本报错", True, str(e))


def sec_ingest(store: KbStore) -> dict:
    print("\n=== I. 真实入库（临时库 + 真实 Embedding）===")
    faq_path = TMP / "src" / "faq.csv"
    seen: list[tuple[str, float]] = []

    def cb(stage: str, frac: float, message: str) -> None:
        seen.append((stage, frac))

    r = U.ingest_path(faq_path, title="课程FAQ", progress=cb, store=store)
    check("I1 问答表入库：2 类 → 3 篇（购买2/内容2/安排2）",
          r["added"] == 3 and r["chunks"] == 6,
          f"added={r['added']} chunks={r['chunks']} tokens={r['tokens']}")
    check("I2 消耗了 token", r["tokens"] > 0, str(r["tokens"]))
    check("I3 进度回调被触发", len(seen) > 0, f"{len(seen)} 次")
    check("I4 进度单调不减且落在 [0,1]",
          all(0.0 <= f <= 1.0 for _, f in seen)
          and all(b >= a for (_, a), (_, b) in zip(seen, seen[1:])),
          f"{seen[0][1]:.2f} → {seen[-1][1]:.2f}")
    check("I5 阶段覆盖切块/向量化/写入",
          {"chunking", "embedding", "writing"} <= {s for s, _ in seen},
          str(sorted({s for s, _ in seen})))

    hits = store.search("这个课要多少钱", top_k=2)
    check("I6 改写问法能召回对应问答",
          bool(hits) and "998" in hits[0].content, hits[0].content.replace("\n", "⏎")[:60])
    check("I7 召回结果能标出分类", "购买与售后" in (hits[0].heading or ""), hits[0].heading)

    again = U.ingest_path(faq_path, title="课程FAQ", store=store)
    check("I8 重复上传：全部跳过、零 token",
          again["added"] == 0 and again["skipped"] == 3 and again["tokens"] == 0,
          f"added={again['added']} skipped={again['skipped']}")

    plain = U.ingest_path(TMP / "src" / "plain.csv", title="产品清单", store=store)
    check("I9 普通表入库为单篇文档",
          plain["added"] == 1 and plain["mode"] == "table",
          f"mode={plain['mode']} chunks={plain['chunks']}")
    hits2 = store.search("企业版多少钱", top_k=1)
    check("I10 普通表内容可被检索到",
          bool(hits2) and "48000" in hits2[0].content,
          hits2[0].content.replace("\n", " ")[:60] if hits2 else "（无结果）")
    return r


def sec_chunks(store: KbStore, ingest_result: dict) -> None:
    """切片正文（前端「切片预览」抽屉背后的 list_chunks）。

    用的是 sec_ingest 刚入库的那份问答表：3 篇文档 / 6 个片段，
    每篇 2 个片段 —— 数量小、可枚举，正好逐条断言。
    """
    print("\n=== K. 切片正文（list_chunks）===")
    docs = ingest_result["docs"]
    ids = [d["doc_id"] for d in docs]

    r = store.list_chunks(ids, limit=100)
    check("K1 取回该文件拆出的全部片段",
          r["total"] == 6 and len(r["data"]) == 6,
          f"total={r['total']} data={len(r['data'])}")
    check("K2 每篇文档各 2 个片段（与入库结果一致）",
          all(sum(1 for c in r["data"] if c["doc_id"] == i) == 2 for i in ids),
          str({i: sum(1 for c in r["data"] if c["doc_id"] == i) for i in ids}))
    check("K3 正文非空，chars 与正文长度一致",
          all(c["content"] and c["chars"] == len(c["content"]) for c in r["data"]), "")
    check("K4 片段就是问答原文，heading 是分类",
          all("问：" in c["content"] and "答：" in c["content"] for c in r["data"])
          and {c["heading"] for c in r["data"]}
          == {"购买与售后", "课程内容", "教学安排"},
          str(sorted({c["heading"] for c in r["data"]})))
    check("K5 total_chars = 各片段字数之和",
          r["total_chars"] == sum(c["chars"] for c in r["data"]),
          str(r["total_chars"]))

    # 顺序：先按**传入的 doc_id 顺序**（＝文件详情里的文档顺序），再按片段序号递增
    order = {i: n for n, i in enumerate(ids)}
    seq = [(order[c["doc_id"]], c["chunk_index"]) for c in r["data"]]
    check("K6 顺序 = 文档顺序 + 片段序号递增", seq == sorted(seq), str(seq))
    check("K7 文档元信息随片段返回（前端据此分组 / 出筛选 chip）",
          [d["doc_id"] for d in r["documents"]] == ids
          and all(d["title"] and d["n_chunks"] for d in r["documents"]),
          str([d["title"] for d in r["documents"]]))

    p1 = store.list_chunks(ids, limit=2)
    p2 = store.list_chunks(ids, limit=2, offset=2)
    check("K8 limit / offset 正确切窗口，truncated 标记还有余量",
          len(p1["data"]) == 2 and len(p2["data"]) == 2 and p1["truncated"]
          and p1["data"][0]["chunk_id"] != p2["data"][0]["chunk_id"],
          f"p1={[c['chunk_index'] for c in p1['data']]} p2={[c['chunk_index'] for c in p2['data']]}")
    tail = store.list_chunks(ids, limit=2, offset=5)
    check("K9 最后一页 truncated 为假",
          len(tail["data"]) == 1 and not tail["truncated"], str(len(tail["data"])))

    one = store.list_chunks([ids[0]], limit=100)
    check("K10 只传一篇时只返回该篇的片段",
          one["total"] == 2 and {c["doc_id"] for c in one["data"]} == {ids[0]}, "")

    check("K11 不存在的 doc_id 进 missing、不抛错",
          store.list_chunks(["kb-nope"])["missing"] == ["kb-nope"], "")
    check("K12 重复 doc_id 自动去重",
          store.list_chunks([ids[0], ids[0]], limit=100)["total"] == 2, "")

    for label, args, kwargs, expect in (
        ("K13 空 doc_ids 报错", [], {"limit": 10}, "不能为空"),
        ("K14 limit < 1 报错", ids, {"limit": 0}, "limit"),
        ("K15 offset 为负报错", ids, {"offset": -1}, "offset"),
    ):
        try:
            store.list_chunks(args, **kwargs)
            check(label, False, "未抛错")
        except ValueError as e:
            check(label, expect in str(e), str(e)[:50])

    try:
        store.list_chunks([f"kb-{n}" for n in range(MAX_CHUNK_DOC_IDS + 1)])
        check("K16 一次查询文档数超上限报错", False, "未抛错")
    except ValueError as e:
        check("K16 一次查询文档数超上限报错", "最多" in str(e), str(e)[:60])


def sec_delete(store: KbStore, ingest_result: dict) -> None:
    print("\n=== D. 删除语义 ===")
    docs = ingest_result["docs"]
    stored = U.UPLOAD_DIR / "faq.csv"

    # 模拟「上传后的受管文件」：把源文件复制到受管目录，再用它入库
    U.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TMP / "src" / "faq.csv", stored)
    up = U.ingest_path(stored, title="上传FAQ", store=store)
    check("D0 受管文件入库成功", up["added"] == 3, f"added={up['added']}")

    up_docs = up["docs"]
    check("D1 同一文件拆出的多篇文档共用来源",
          len({d["doc_id"] for d in up_docs}) == 3, str(len(up_docs)))

    r1 = U.delete_documents([up_docs[0]["doc_id"]])
    check("D2 删一篇后源文件仍保留（还有别的文档在用）",
          r1["removed_chunks"] > 0 and stored.is_file()
          and not r1["freed_files"], f"freed={r1['freed_files']}")

    r2 = U.delete_documents([d["doc_id"] for d in up_docs[1:]])
    check("D3 删掉最后一篇引用后，受管源文件被清掉",
          not stored.is_file() and any("faq.csv" in f for f in r2["freed_files"]),
          str(r2["freed_files"]))
    check("D4 库里不再有这些文档",
          all(store.get_document(d["doc_id"]) is None for d in up_docs), "")

    r3 = U.delete_documents(["kb-不存在的id"])
    check("D5 删除不存在的 doc_id 不报错、只回报 missing",
          r3["missing"] == ["kb-不存在的id"] and not r3["removed"], str(r3["missing"]))

    # 外部（非受管）文件：删除文档时绝不能动源文件
    external = write(TMP / "outside" / "ext.md", MD_DOC)
    ext_res = store.ingest_file(external)
    r4 = U.delete_documents([ext_res.doc_id])
    check("D6 外部文件的源文件不受影响",
          external.is_file() and r4["removed_chunks"] > 0 and not r4["freed_files"],
          f"freed={r4['freed_files']}")

    print(f"  · 删除后库现状：{r4['stats']['documents']} 篇 / {r4['stats']['chunks']} 片段")
    check("D7 剩余文档数 = 3（课程FAQ）+ 1（产品清单）",
          r4["stats"]["documents"] == 4, str(r4["stats"]["documents"]))


def sec_tasks() -> None:
    print("\n=== Q. 上传任务队列 ===")
    mgr = U.get_manager()

    for label, kw, expect in (
        ("Q1 不支持的扩展名被拒", {"filename": "evil.exe", "data": b"MZ"}, "类型"),
        ("Q2 空内容被拒", {"filename": "a.md", "data": b""}, "空"),
        ("Q3 无扩展名被拒", {"filename": "noext", "data": b"x"}, "类型"),
    ):
        try:
            mgr.submit(**kw)
            check(label, False, "未抛错")
        except ValueError as e:
            check(label, expect in str(e), str(e)[:60])

    try:
        mgr.submit(filename="big.txt", data=b"x" * (U.MAX_UPLOAD_BYTES + 1))
        check("Q4 超过大小上限被拒", False, "未抛错")
    except ValueError as e:
        check("Q4 超过大小上限被拒", "上限" in str(e), str(e)[:60])

    md = (TMP / "src" / "doc.md").read_bytes()
    task = mgr.submit(filename="doc.md", data=md, tags="政策")
    check("Q5 提交后立即返回排队态",
          task["status"] == "queued" and task["stage"] == "queued"
          and task["progress"] == 0.0,
          f"{task['status']}/{task['stage_label']}")
    check("Q6 落盘到受管上传目录",
          Path(task["stored_path"]).is_file()
          and Path(task["stored_path"]).parent == U.UPLOAD_DIR,
          task["stored_path"])

    done = wait_task(mgr, task["task_id"])
    check("Q7 任务最终成功", done["status"] == "done", f"{done['status']} {done['error']}")
    check("Q8 结果里有文档产出", len(done["docs"]) == 1 and done["chunks"] >= 1,
          f"{len(done['docs'])} 篇 / {done['chunks']} 片段")
    check("Q9 进度到 100% 且阶段为 done",
          done["progress"] == 1.0 and done["stage"] == "done", done["stage_label"])
    check("Q10 状态字段齐全（前端据此渲染进度条）",
          all(k in done for k in ("stage_label", "progress", "message", "elapsed_ms")),
          done["message"][:40])

    listed = mgr.list()
    check("Q11 任务可列出且顺序稳定",
          [t["task_id"] for t in listed][-1] == task["task_id"] or any(
              t["task_id"] == task["task_id"] for t in listed),
          f"{len(listed)} 条")

    # 同名重复上传：内容一致 → 跳过，不消耗额度
    task2 = mgr.submit(filename="doc.md", data=md)
    done2 = wait_task(mgr, task2["task_id"])
    check("Q12 重复上传同名同内容 → 跳过",
          done2["status"] == "done" and done2["skipped"] == 1 and done2["tokens"] == 0,
          done2["message"])

    check("Q13 全部任务结束后 has_active 为假", not mgr.has_active(), "")


def main() -> int:
    print(f"临时库   : {os.environ['KB_DB_PATH']}")
    print(f"上传目录 : {os.environ['KB_UPLOAD_DIR']}")

    store = KbStore()
    try:
        sec_sanitize()
        sec_parse()
        sec_plan()
        r = sec_ingest(store)
        sec_chunks(store, r)
        sec_delete(store, r)
        sec_tasks()
    finally:
        print(f"\n{'=' * 52}")
        print(f"通过 {PASS} 项，失败 {FAIL} 项")
        store.close()
        if FAIL == 0:
            shutil.rmtree(TMP, ignore_errors=True)
        else:
            print(f"（有失败，保留临时目录便于排查：{TMP}）")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
