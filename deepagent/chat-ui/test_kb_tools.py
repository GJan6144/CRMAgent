"""知识库工具层测试：路径解析 / 入库 / 检索 / 查看 / 删除 / 异常包装。

跑在临时库上（通过 KB_DB_PATH 隔离），不会动真实知识库。
会真实调用 Embedding API（约 6 次请求）。

运行：
    python test_kb_tools.py
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

TMP = Path(tempfile.mkdtemp(prefix="kbtools_"))
os.environ["KB_DB_PATH"] = str(TMP / "knowledge.db")

# KB_DB_PATH 必须在导入 kb_tools 之前设好（get_store 是进程内单例）
import kb_tools  # noqa: E402
from kb_tools import (  # noqa: E402
    KB_TOOLS,
    MAX_DIR_FILES,
    PROJECT_ROOT,
    _resolve,
    kb_delete_document,
    kb_ingest,
    kb_list_documents,
    kb_search,
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


def main() -> int:
    print(f"临时库 : {os.environ['KB_DB_PATH']}")
    print(f"项目根 : {PROJECT_ROOT}")

    print("\n=== A. 工具定义 ===")
    check("暴露 4 个工具", len(KB_TOOLS) == 4, str([t.name for t in KB_TOOLS]))
    check("工具名符合目录约定",
          [t.name for t in KB_TOOLS] ==
          ["kb_search", "kb_ingest", "kb_list_documents", "kb_delete_document"])
    for t in KB_TOOLS:
        check(f"{t.name} 有描述", bool((t.description or "").strip()),
              (t.description or "").strip().splitlines()[0][:40])
    check("kb_search 有参数说明", "query" in kb_search.args, str(list(kb_search.args.keys())))
    check("top_k 声明为整数（类型错误由框架 schema 拦截）",
          kb_search.args["top_k"]["type"] == "integer", str(kb_search.args["top_k"]))

    print("\n=== B. 路径解析 ===")
    check("相对路径按项目根解析", _resolve("README.md") == (PROJECT_ROOT / "README.md"))
    check("绝对路径原样保留", _resolve("C:/tmp/x.md") == Path("C:/tmp/x.md"))
    check("引号被剥离", _resolve('"README.md"') == (PROJECT_ROOT / "README.md"))
    check("空路径报错", _err(lambda: _resolve("")))
    # 系统提示词要求模型用虚拟路径（/ 开头）；Windows 下 pathlib 不认为它是绝对路径，
    # 若不特殊处理会被拼成 C:\chat-ui\x，指向错误位置
    check("虚拟路径按项目根解析",
          _resolve("/chat-ui/AGENTS.md") == (PROJECT_ROOT / "chat-ui" / "AGENTS.md"),
          str(_resolve("/chat-ui/AGENTS.md")))
    check("虚拟路径不会落到盘根",
          _resolve("/chat-ui/AGENTS.md").drive == PROJECT_ROOT.drive
          and str(_resolve("/chat-ui/AGENTS.md")).startswith(str(PROJECT_ROOT)))

    print("\n=== C. 空库 ===")
    out = kb_list_documents.invoke({})
    check("空库给出提示", "空的" in out, out.splitlines()[0][:50])
    check("空库含概览", "0 篇文档" in out, out.splitlines()[0][:50])

    print("\n=== D. 入库（真实文件）===")
    docs = TMP / "docs"
    docs.mkdir()
    (docs / "手册.md").write_text(
        "# 产品手册\n\n## 计费方式\n\n按年订阅，标准版 12800 元每年，含 5 个并发席位。\n\n"
        "## 服务级别\n\n企业版提供 7x24 支持，故障响应不超过 30 分钟。\n",
        encoding="utf-8",
    )
    (docs / "规范.txt").write_text(
        "数据备份规范：每日凌晨 2 点全量备份，保留 30 天。\n"
        "备份文件需异地存放，且每季度做一次恢复演练。\n",
        encoding="utf-8",
    )

    out = kb_ingest.invoke({"path": str(docs / "手册.md"), "tags": "产品,手册"})
    check("单文件入库成功", "入库完成" in out, out.replace("\n", " | ")[:90])
    check("返回分块数", "分块：" in out)
    check("返回 token 消耗", "token：" in out)

    out2 = kb_ingest.invoke({"path": str(docs / "手册.md"), "tags": "产品,手册"})
    check("重复入库被跳过", "已跳过" in out2, out2.replace("\n", " | ")[:70])
    check("跳过说明原因", "内容未变化" in out2)

    out3 = kb_ingest.invoke({"path": str(docs), "tags": "内规"})
    check("目录入库成功", "目录入库完成" in out3, out3.splitlines()[0])
    check("目录入库区分新增/跳过", "新增/更新：1" in out3 and "跳过（内容未变）：1" in out3,
          [l.strip() for l in out3.splitlines() if "跳过" in l][:1])

    print("\n=== D2. 虚拟路径入库（模型实际会用这种写法）===")
    out = kb_ingest.invoke({"path": "/chat-ui/AGENTS.md", "title": "虚拟路径测试", "tags": "规约"})
    check("虚拟路径能入库真实文件", "入库完成" in out, out.replace("\n", " | ")[:80])
    m = re.search(r"doc_id：(kb-[0-9a-f]+)", out)
    check("返回了 doc_id", m is not None, m.group(1) if m else out[:60])
    if m:
        hit = kb_search.invoke({"query": "chat-ui 的项目规约", "doc_id": m.group(1)})
        check("虚拟路径入库的内容可检索到", "《虚拟路径测试》" in hit,
              hit.splitlines()[0][:60])
        out2 = kb_ingest.invoke({"path": "/chat-ui/AGENTS.md", "title": "虚拟路径测试",
                                 "tags": "规约"})
        check("虚拟路径重复入库被跳过", "已跳过" in out2, out2.splitlines()[0][:50])
        # 注意：参数必须**完全一致**才算「重复」。只改标题会走元信息更新分支，
        # 提示语不同（但同样零 token、不重新向量化）。
        out3 = kb_ingest.invoke({"path": "/chat-ui/AGENTS.md", "title": "虚拟路径测试·改名",
                                 "tags": "规约"})
        check("仅改元信息 -> 报告更新而非重新入库",
              "已更新文档信息" in out3 and "未消耗额度" in out3, out3.splitlines()[0][:50])

    print("\n=== E. 检索 ===")
    out = kb_search.invoke({"query": "标准版一年多少钱？"})
    # 标题取正文 H1（"# 产品手册"）而不是文件名 stem（"手册"），
    # 这样检索结果里模型才有一句话能引用的出处
    check("检索到内容", "《产品手册》" in out, out.splitlines()[0][:60])
    check("结果带相似度", "相似度" in out)
    check("结果带段落出处", "第" in out and "段" in out)

    out = kb_search.invoke({"query": "备份要保留多久？", "top_k": 1})
    check("top_k 生效（只回 1 条）", out.count("[1]") == 1 and "[2]" not in out)

    docs_list = kb_list_documents.invoke({})
    check("列表含两篇文档", "手册" in docs_list and "规范" in docs_list)

    out = kb_search.invoke({"query": "备份规范", "tags": "内规"})
    check("按标签检索", "《规范》" in out or "规范" in out, out.splitlines()[0][:60])
    out = kb_search.invoke({"query": "备份规范", "tags": "不存在的标签"})
    check("标签不匹配时明确提示", "没有检索到" in out, out.splitlines()[0][:60])

    print("\n=== F. 异常包装（不抛异常给模型）===")
    out = kb_ingest.invoke({"path": "不存在的目录/xyz.md"})
    check("路径不存在 -> 返回错误文本", out.startswith("错误："), out[:60])
    out = kb_ingest.invoke({"path": ""})
    check("空路径 -> 返回错误文本", out.startswith("错误："), out[:40])
    out = kb_search.invoke({"query": ""})
    check("空查询 -> 返回错误文本", out.startswith("错误："), out[:40])
    out = kb_search.invoke({"query": "任意", "top_k": -5})
    check("负 top_k 被夹到 1 而非报错", not out.startswith("错误："), out.splitlines()[0][:50])
    out = kb_search.invoke({"query": "备份", "top_k": 999})
    check("超大 top_k 被夹到上限而非报错", not out.startswith("错误："), out.splitlines()[0][:50])
    out = kb_delete_document.invoke({"doc_id": "kb-does-not-exist"})
    check("删除不存在的 doc_id -> 返回错误文本", out.startswith("错误："), out[:60])
    out = kb_delete_document.invoke({"doc_id": ""})
    check("空 doc_id -> 返回错误文本", out.startswith("错误："), out[:40])

    print("\n=== G. 删除 ===")
    listed = kb_list_documents.invoke({})
    ids = re.findall(r"doc_id：(kb-[0-9a-f]+)", listed)
    check("能从列表解析出 doc_id", len(ids) >= 2, str(ids))
    if ids:
        out = kb_delete_document.invoke({"doc_id": ids[0]})
        check("删除成功并报告片段数", out.startswith("已删除：") and "片段" in out, out[:70])
        after = kb_list_documents.invoke({})
        check("列表已少一篇", after.count("doc_id：") == listed.count("doc_id：") - 1,
              f"{listed.count('doc_id：')} -> {after.count('doc_id：')}")
        out = kb_delete_document.invoke({"doc_id": ids[0]})
        check("重复删除给出明确错误", out.startswith("错误："), out[:50])

    print("\n=== H. 上限保护 ===")
    check("目录入库有文件数上限", MAX_DIR_FILES > 0, f"MAX_DIR_FILES={MAX_DIR_FILES}")

    shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n===== 结果: {PASS} 通过 / {FAIL} 失败 =====")
    return 1 if FAIL else 0


def _err(fn) -> bool:
    try:
        fn()
        return False
    except ValueError:
        return True


if __name__ == "__main__":
    sys.exit(main())
