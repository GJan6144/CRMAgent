"""知识库文件管理 **HTTP 接口** 测试（前端「Agent 知识库」页依赖的六个接口）。

覆盖：概览 / 文档列表 / 上传（原始字节 body）/ 任务进度 / 批量删除，
以及几条安全边界（文件名逃逸、类型白名单、空 body、超限）。

⚠️ 需要 chat-ui 在 8765 运行：
        python server.py
⚠️ 会往**真实知识库**里写测试数据（真实调用 Embedding，约 6 次请求），
   但结束时会把本次创建的文档全部删掉，并断言文档数回到基线。

运行：
    python test_kb_api.py
"""
from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

BASE = "http://127.0.0.1:8765/api/kb"
TIMEOUT = 30

PASS = FAIL = 0
CREATED: list[str] = []          # 本次测试创建出来的 doc_id，收尾时删掉


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


# ==========================================================================
# HTTP 小工具
# ==========================================================================

def call(method: str, path: str, *, body: bytes | None = None,
         json_body: dict | None = None, headers: dict | None = None
         ) -> tuple[int, object]:
    """返回 (状态码, 解析后的 JSON 或原始文本)。"""
    url = f"{BASE}{path}"
    data = body
    hdrs = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
            code = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        code = e.code
    text = raw.decode("utf-8", "replace")
    try:
        return code, json.loads(text)
    except json.JSONDecodeError:
        return code, text


def upload(filename: str, data: bytes, **extra) -> tuple[int, dict]:
    q = {"filename": filename, **extra}
    return call("POST", f"/upload?{urllib.parse.urlencode(q)}",
                body=data, headers={"Content-Type": "application/octet-stream"})


def wait_task(task_id: str, timeout: float = 240.0) -> tuple[dict, list[float]]:
    """轮询任务直到结束，返回 (终态, 观察到的进度序列)。"""
    seen: list[float] = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, t = call("GET", f"/tasks/{task_id}")
        if code != 200 or not isinstance(t, dict):
            raise RuntimeError(f"轮询任务失败：HTTP {code} {t}")
        seen.append(t["progress"])
        if t["status"] in ("done", "failed"):
            return t, seen
        time.sleep(0.4)
    raise TimeoutError(f"任务 {task_id} 超时未结束")


def doc_ids_of(task: dict) -> list[str]:
    return [d["doc_id"] for d in task.get("docs", [])]


def baseline() -> tuple[int, int]:
    _, d = call("GET", "/documents")
    return d["stats"]["documents"], d["stats"]["chunks"]


# ==========================================================================
# 素材
# ==========================================================================

FAQ_CSV = """分类,问题,答案
售后服务,退货怎么处理,签收后 7 天内可申请退货
售后服务,运费谁承担,质量问题由我们承担运费
配送说明,多久能发货,付款后 48 小时内发出
""".encode("utf-8")

PLAIN_CSV = """产品编号,产品名称,单价
PROD-900,测试标准版,12800
PROD-901,测试企业版,48000
""".encode("utf-8")

MD_DOC = """# 测试文档 · 退换货政策

## 七天无理由

自签收起 7 天内，商品未拆封可申请无理由退货。

## 运费说明

非质量问题导致的退货运费由买家承担。
""".encode("utf-8")


def make_xlsx() -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "价格表"
    ws.append(["产品", "单价", "周期"])
    ws.append(["测试标准版", 12800, "年"])
    ws.append(["测试企业版", 48000, "年"])
    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    return buf.getvalue()


# ==========================================================================
# 各段
# ==========================================================================

def sec_overview(base: tuple[int, int]) -> None:
    print("\n=== H. 概览与文档列表 ===")
    code, d = call("GET", "/overview")
    check("H1 /overview 返回 200", code == 200, f"HTTP {code}")
    check("H2 含库统计 / 上传能力 / Embedding 信息",
          {"stats", "upload", "embedding"} <= set(d), str(list(d)))
    check("H3 统计与 /documents 一致",
          (d["stats"]["documents"], d["stats"]["chunks"]) == base,
          f"{d['stats']['documents']} 篇 / {d['stats']['chunks']} 片段")
    check("H4 上传能力含允许类型与大小上限",
          ".csv" in d["upload"]["allowed_suffixes"]
          and d["upload"]["max_upload_mb"] > 0,
          f"{len(d['upload']['allowed_suffixes'])} 种类型 / {d['upload']['max_upload_mb']} MB")
    check("H5 库暴露模型与维度",
          bool(d["embedding"]["model"]) and d["embedding"]["dim"] > 0,
          f"{d['embedding']['model']} / {d['embedding']['dim']}")

    code, lst = call("GET", "/documents")
    check("H6 /documents 返回列表", code == 200 and isinstance(lst["data"], list),
          f"{lst['total']} 篇")
    check("H7 每篇带来源文件状态字段",
          all({"source_name", "source_exists", "managed", "source_size"} <= set(x)
              for x in lst["data"]), "")
    managed = [x for x in lst["data"] if x["managed"]]
    check("H8 现状：库里没有受管上传文件（均为外部导入）",
          managed == [], f"{len(managed)} 篇受管")


def sec_chunks(base: tuple[int, int]) -> None:
    """切片正文接口 —— 前端点文件名 / 片段数时弹的「切片预览」抽屉的数据源。"""
    print("\n=== Y. 切片正文接口 ===")
    _, lst = call("GET", "/documents")
    docs = lst["data"]
    ids = [d["doc_id"] for d in docs]
    q = ",".join(ids)
    sum_chunks = sum(x["n_chunks"] for x in docs)

    code, d = call("GET", f"/chunks?doc_ids={q}")
    check("Y1 返回 200 且结构完整",
          code == 200
          and {"data", "total", "total_chars", "offset", "limit", "truncated",
               "documents", "missing"} <= set(d),
          f"HTTP {code}")
    check("Y2 片段总数与文档列表的 n_chunks 之和一致",
          d["total"] == sum_chunks, f"{d['total']} vs {sum_chunks}")
    check("Y3 每段正文非空，chars 与正文长度一致",
          bool(d["data"])
          and all(c["content"] and c["chars"] == len(c["content"]) for c in d["data"]),
          f"{len(d['data'])} 段")
    check("Y4 顺序 = 传入 doc_id 顺序 + 片段序号递增",
          [(ids.index(c["doc_id"]), c["chunk_index"]) for c in d["data"]]
          == sorted((ids.index(c["doc_id"]), c["chunk_index"]) for c in d["data"]), "")
    check("Y5 文档元信息按请求顺序返回",
          [x["doc_id"] for x in d["documents"]] == ids
          and all(x["title"] and x["n_chunks"] for x in d["documents"]),
          str(len(d["documents"])))
    check("Y6 问答型语料的片段保留问答原文",
          any("问：" in c["content"] and "答：" in c["content"] for c in d["data"]), "")
    check("Y7 total_chars 等于各片段字数之和",
          d["total_chars"] == sum(c["chars"] for c in d["data"]),
          str(d["total_chars"]))

    _, p1 = call("GET", f"/chunks?doc_ids={q}&limit=1")
    check("Y8 limit=1 只返回 1 条并标记 truncated",
          len(p1["data"]) == 1 and p1["truncated"] and p1["limit"] == 1, "")
    _, p2 = call("GET", f"/chunks?doc_ids={q}&limit=1&offset=1")
    check("Y9 offset 生效（与第一条不是同一段）",
          len(p2["data"]) == 1
          and p2["data"][0]["chunk_id"] != p1["data"][0]["chunk_id"], "")

    _, one = call("GET", f"/chunks?doc_ids={ids[0]}")
    check("Y10 只查一篇文档时只返回该篇片段",
          one["total"] == docs[0]["n_chunks"]
          and {c["doc_id"] for c in one["data"]} == {ids[0]},
          f"{one['total']} vs {docs[0]['n_chunks']}")

    code, miss = call("GET", "/chunks?doc_ids=kb-not-exist")
    check("Y11 不存在的 doc_id 进 missing、不报错",
          code == 200 and miss["missing"] == ["kb-not-exist"] and miss["data"] == [],
          f"HTTP {code}")

    code, _ = call("GET", "/chunks")
    check("Y12 缺 doc_ids 返回 400", code == 400, f"HTTP {code}")
    code, _ = call("GET", "/chunks?doc_ids=")
    check("Y13 doc_ids 为空串返回 400", code == 400, f"HTTP {code}")

    many = ",".join(f"kb-{n}" for n in range(120))
    code, e = call("GET", f"/chunks?doc_ids={many}")
    check("Y14 一次查询文档数超上限返回 400",
          code == 400 and "最多" in str(e), f"HTTP {code} {str(e)[:40]}")

    _, cap = call("GET", f"/chunks?doc_ids={q}&limit=9999")
    check("Y15 limit 超上限被夹到 200", cap["limit"] == 200, str(cap["limit"]))


def sec_upload(base: tuple[int, int]) -> None:
    print("\n=== U. 上传（原始字节 body）===")
    code, task = upload("ui_test_doc.md", MD_DOC)
    check("U1 上传返回任务快照", code == 200 and task["status"] == "queued",
          f"HTTP {code} / {task.get('stage_label')}")
    check("U2 文件名与落盘路径正确",
          task["filename"] == "ui_test_doc.md" and "kb" in task["stored_path"], "")
    check("U3 提交时进度为 0、阶段为排队",
          task["progress"] == 0.0 and task["stage"] == "queued",
          f"{task['stage']} / {task['message']}")

    done, seen = wait_task(task["task_id"])
    CREATED.extend(doc_ids_of(done))
    check("U4 任务完成", done["status"] == "done", f"{done['status']} {done['error']}")
    check("U5 进度单调不减且单调递增到 1.0",
          all(b >= a for a, b in zip(seen, seen[1:])) and done["progress"] == 1.0,
          f"{seen[0]:.2f} → {seen[-1]:.2f}（{len(seen)} 次采样）")
    check("U6 产出文档信息完整",
          len(done["docs"]) == 1 and done["chunks"] >= 1 and done["tokens"] > 0,
          f"{len(done['docs'])} 篇 / {done['chunks']} 片段 / {done['tokens']} token")

    b2 = baseline()
    check("U7 文档数 +1", b2[0] == base[0] + 1, f"{base[0]} → {b2[0]}")

    # 真正验证「已挂载到检索能力」：直接查向量索引
    from kb_store import KbStore
    store = KbStore()
    try:
        hits = store.search("非质量问题的退货谁出运费", top_k=1)
        check("U8 新上传内容已进入向量索引、可被检索",
              bool(hits) and "运费" in hits[0].content,
              hits[0].content.replace("\n", " ")[:50] if hits else "（无结果）")
    finally:
        store.close()

    code, task2 = upload("ui_test_doc.md", MD_DOC)
    done2, _ = wait_task(task2["task_id"])
    check("U9 重复上传同内容 → 跳过且零 token",
          done2["status"] == "done" and done2["skipped"] == 1 and done2["tokens"] == 0,
          done2["message"])
    check("U10 跳过不产生新文档", baseline()[0] == base[0] + 1, "")

    code, task3 = upload("ui_test_faq.csv", FAQ_CSV)
    done3, _ = wait_task(task3["task_id"])
    CREATED.extend(doc_ids_of(done3))
    check("U11 问答表按分类拆成多篇文档",
          done3["status"] == "done" and done3["mode"] == "faq-table"
          and len(done3["docs"]) == 2,
          f"{done3['mode']} / {[d['title'] for d in done3['docs']]}")

    code, task4 = upload("ui_test_sheet.xlsx", make_xlsx())
    done4, _ = wait_task(task4["task_id"])
    CREATED.extend(doc_ids_of(done4))
    check("U12 xlsx 表格可上传并解析",
          done4["status"] == "done" and done4["chunks"] >= 1,
          f"{done4['mode']} / {done4['chunks']} 片段")

    code, task5 = upload("ui_test_plain.csv", PLAIN_CSV)
    done5, _ = wait_task(task5["task_id"])
    CREATED.extend(doc_ids_of(done5))
    check("U13 普通表格（非问答）按整表成块",
          done5["status"] == "done" and done5["mode"] == "table"
          and len(done5["docs"]) == 1, f"{done5['mode']}")

    print(f"  · 本段共创建 {len(CREATED)} 篇文档")
    code, lst = call("GET", "/documents")
    check("U14 新文档在列表中标记为受管上传",
          sum(1 for x in lst["data"] if x["managed"]) == len(CREATED),
          f"{sum(1 for x in lst['data'] if x['managed'])} 篇受管")


def sec_guard() -> None:
    print("\n=== G. 安全边界 ===")
    b0 = baseline()
    code, d = upload("evil.exe", b"MZ\x90\x00")
    check("G1 不支持的扩展名被拒", code == 400 and "类型" in str(d),
          f"HTTP {code} {str(d)[:60]}")

    code, d = upload("empty.md", b"")
    check("G2 空内容被拒", code == 400 and "空" in str(d), f"HTTP {code}")

    code, d = call("POST", "/upload", body=b"x" * (21 * 1024 * 1024))
    check("G3 超过大小上限被拒", code == 400 and "上限" in str(d), f"HTTP {code}")

    # 文件名逃逸：带路径成分的文件名必须被收敛成纯文件名
    code, task = upload("../../../../escape_attempt.md", MD_DOC)
    check("G4 带路径的文件名被接受但收敛", code == 200, f"HTTP {code}")
    if code == 200:
        done, _ = wait_task(task["task_id"])
        CREATED.extend(doc_ids_of(done))
        stored = Path(task["stored_path"]).resolve()
        from kb_upload import UPLOAD_DIR
        check("G5 落盘位置没有逃出受管目录",
              stored.parent == UPLOAD_DIR.resolve() and stored.name == "escape_attempt.md",
              str(stored))
        check("G6 逃逸尝试未在项目根生成文件",
              not (HERE.parent / "escape_attempt.md").exists()
              and not Path("C:/escape_attempt.md").exists(), "")

    code, d = call("GET", "/tasks/not-a-real-task")
    check("G7 不存在的任务返回 404", code == 404, f"HTTP {code}")

    code, d = call("POST", "/delete", json_body={"doc_ids": []})
    check("G8 空 doc_ids 返回 400", code == 400, f"HTTP {code}")

    code, d = call("POST", "/delete", json_body={"doc_ids": ["kb-不存在"]})
    check("G9 删除不存在的文档返回 404", code == 404, f"HTTP {code}")

    # 被拒的请求必须一个字节都没写进库：只有 G4 那次成功上传应当让文档数 +1
    now = baseline()
    check("G10 被拒请求未改动库（仅成功那次 +1）",
          now[0] == b0[0] + 1, f"{b0[0]} → {now[0]}")


def sec_tasks() -> None:
    print("\n=== T. 任务接口 ===")
    code, d = call("GET", "/tasks")
    check("T1 /tasks 返回列表与 active 标记",
          code == 200 and isinstance(d["data"], list) and isinstance(d["active"], bool),
          f"{len(d['data'])} 条 / active={d['active']}")
    check("T2 任务字段齐全（前端据此渲染进度）",
          all({"task_id", "filename", "status", "stage", "stage_label",
               "progress", "message"} <= set(t) for t in d["data"]), "")
    check("T3 阶段值都在已知集合内",
          all(t["stage"] in {"queued", "parsing", "chunking", "embedding",
                             "writing", "done", "failed"} for t in d["data"]), "")
    check("T4 无运行中任务时 active 为假", not d["active"], str(d["active"]))


def sec_delete(base: tuple[int, int]) -> None:
    print("\n=== D. 删除与收尾 ===")
    code, lst = call("GET", "/documents")
    managed_ids = [x["doc_id"] for x in lst["data"] if x["managed"]]
    check("D1 待删的受管文档数 = 上传段创建的文档数",
          len(managed_ids) == len(CREATED), f"{len(managed_ids)} / {len(CREATED)}")

    from kb_upload import UPLOAD_DIR
    before = sorted(p.name for p in UPLOAD_DIR.glob("*")) if UPLOAD_DIR.is_dir() else []
    check("D2 上传目录里有落盘文件", len(before) > 0, str(before))

    code, d = call("POST", "/delete", json_body={"doc_ids": managed_ids})
    check("D3 批量删除成功", code == 200 and len(d["removed"]) == len(managed_ids),
          f"HTTP {code} / 删除 {len(d.get('removed', []))} 篇")
    check("D4 连带清掉受管源文件",
          len(d["freed_files"]) == len(before),
          f"{len(d['freed_files'])} 个：{[Path(f).name for f in d['freed_files']]}")
    after = sorted(p.name for p in UPLOAD_DIR.glob("*")) if UPLOAD_DIR.is_dir() else []
    check("D5 上传目录已清空", after == [], str(after))
    check("D6 响应里带回最新列表",
          d["list"]["total"] == base[0] and "stats" in d["list"],
          f"{d['list']['total']} 篇")

    final = baseline()
    check("D7 文档数回到基线", final == base,
          f"基线 {base} → 现在 {final}")

    # 原有文档必须完好
    code, lst = call("GET", "/documents")
    titles = {x["title"] for x in lst["data"]}
    check("D8 原有 6 篇课程 FAQ 文档未受影响",
          len(titles) == base[0] and all("课程FAQ" in t for t in titles),
          str(sorted(titles))[:80])


def main() -> int:
    print(f"接口地址 : {BASE}")
    try:
        base = baseline()
    except Exception as e:
        print(f"\n无法连接 chat-ui（{BASE}）：{e}")
        print("请先启动：python server.py")
        return 2
    print(f"基线     : {base[0]} 篇文档 / {base[1]} 个片段")

    try:
        sec_overview(base)
        sec_chunks(base)
        sec_upload(base)
        sec_guard()
        sec_tasks()
        sec_delete(base)
    finally:
        # 兜底清理：即使中途失败也别把测试数据留在真实库里
        if CREATED:
            code, d = call("POST", "/delete", json_body={"doc_ids": CREATED})
            if code == 200:
                print(f"  （兜底清理：删除 {len(d.get('removed', []))} 篇残留测试文档）")
        print(f"\n{'=' * 52}")
        print(f"通过 {PASS} 项，失败 {FAIL} 项")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
