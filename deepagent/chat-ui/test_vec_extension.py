"""sqlite-vec 本地部署的集成测试（文件库 / WAL / 持久化 / 规模 / 召回 / 元数据）。

覆盖 `vec_extension.py` 加载器与 vec0 扩展在真实文件库上的行为。
扩展能力本身的验证见 `sqlite-vec/dist/smoke_test.py`。

运行：
    python test_vec_extension.py
"""
from __future__ import annotations

import random
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from vec_extension import (  # noqa: E402
    connect,
    extension_info,
    find_extension,
    serialize_bit,
    serialize_f32,
    serialize_i8,
)

PASS = FAIL = 0
DIM = 384
N = 10000


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


def main() -> int:
    random.seed(42)
    info = extension_info()
    print(f"扩展来源 : {info['source']}")
    print(f"vec0     : {info['vec_version']}   SQLite: {info['sqlite_version']}")

    print("\n--- 1. 加载器 ---")
    check("find_extension 返回存在路径", find_extension()[1].is_file())
    check("优先使用项目内置副本", info["source"] == "项目内置副本", info["source"])
    check("版本号形如 v0.1.x", info["vec_version"].startswith("v0.1."), info["vec_version"])
    check("serialize_f32 长度 = 4 * dim", len(serialize_f32([0.0] * DIM)) == 4 * DIM)
    check("serialize_i8 长度 = dim", len(serialize_i8([0] * DIM)) == DIM)
    check("serialize_bit 8 位 -> 1 字节", serialize_bit("10101010") == b"\xaa")
    try:
        serialize_bit("101")
        check("serialize_bit 拒绝非 8 倍数", False, "未报错")
    except ValueError:
        check("serialize_bit 拒绝非 8 倍数", True)

    tmpdir = Path(tempfile.mkdtemp(prefix="kb_test_"))
    db_path = tmpdir / "kb.db"
    try:
        print(f"\n--- 2. 建库与批量写入（{N} 条 × {DIM} 维）---")
        db = connect(db_path)
        check("journal_mode = WAL",
              db.execute("pragma journal_mode").fetchone()[0].lower() == "wal")

        db.execute(f"""
            create virtual table chunks using vec0(
                chunk_id  integer primary key,
                embedding float[{DIM}],
                doc_id    text,
                +content  text
            )
        """)

        vectors = [[random.random() for _ in range(DIM)] for _ in range(N)]
        t0 = time.perf_counter()
        db.executemany(
            "insert into chunks(chunk_id, embedding, doc_id, content) values (?, ?, ?, ?)",
            [(i + 1, serialize_f32(v), f"doc-{i % 50}", f"片段内容 {i}") for i, v in enumerate(vectors)],
        )
        db.commit()
        ins_ms = (time.perf_counter() - t0) * 1000
        check("批量写入条数正确", db.execute("select count(*) from chunks").fetchone()[0] == N,
              f"{ins_ms:.0f} ms ({N / (ins_ms / 1000):.0f} 条/秒)")

        print("\n--- 3. KNN 与召回正确性 ---")
        probe = [0.5] * DIM
        t0 = time.perf_counter()
        for _ in range(20):
            hits = db.execute(
                "select chunk_id, distance from chunks where embedding match ? order by distance limit 5",
                (serialize_f32(probe),),
            ).fetchall()
        q_ms = (time.perf_counter() - t0) * 1000 / 20
        check("KNN 返回 5 条", len(hits) == 5, f"平均 {q_ms:.2f} ms/次")
        check("distance 升序", all(hits[i][1] <= hits[i + 1][1] for i in range(len(hits) - 1)))

        brute = db.execute(
            "select chunk_id, vec_distance_l2(embedding, ?) as d from chunks order by d limit 5",
            (serialize_f32(probe),),
        ).fetchall()
        check("KNN == 全表暴力结果（recall 100%）",
              [h[0] for h in hits] == [b[0] for b in brute],
              f"knn={[h[0] for h in hits]}")

        print("\n--- 4. 元数据列与辅助列 ---")
        filtered = db.execute(
            "select chunk_id, doc_id from chunks where embedding match ? and doc_id = ? order by distance limit 3",
            (serialize_f32(probe), "doc-7"),
        ).fetchall()
        check("元数据列可用于 KNN 的 WHERE", len(filtered) == 3 and all(f[1] == "doc-7" for f in filtered))

        aux = db.execute(
            "select chunk_id, content from chunks where embedding match ? order by distance limit 1",
            (serialize_f32(probe),),
        ).fetchone()
        check("辅助列可在结果集直接取回（免 JOIN）", isinstance(aux[1], str) and aux[1].startswith("片段内容"))

        try:
            db.execute(
                "select chunk_id from chunks where embedding match ? and content = ? limit 1",
                (serialize_f32(probe), "片段内容 1"),
            ).fetchall()
            check("辅助列不能用于 KNN 的 WHERE", False, "竟然允许了")
        except sqlite3.OperationalError as e:
            check("辅助列不能用于 KNN 的 WHERE", "auxiliary" in str(e).lower(), str(e)[:70])

        print("\n--- 5. 增删改 ---")
        db.execute("delete from chunks where chunk_id = 1")
        db.commit()
        check("按主键删除", db.execute("select count(*) from chunks where chunk_id = 1").fetchone()[0] == 0)
        db.execute("update chunks set doc_id = 'doc-renamed' where chunk_id = 2")
        db.commit()
        check("更新元数据列",
              db.execute("select doc_id from chunks where chunk_id = 2").fetchone()[0] == "doc-renamed")

        print("\n--- 6. 维度校验 ---")
        try:
            db.execute("insert into chunks(chunk_id, embedding, doc_id) values (99999, ?, 'bad')",
                       (serialize_f32([0.1] * 3),))
            check("维度不符被拒绝", False, "竟然写入成功")
        except sqlite3.OperationalError as e:
            check("维度不符被拒绝", "Dimension mismatch" in str(e), str(e)[:70])
        check("被拒记录未落库",
              db.execute("select count(*) from chunks where chunk_id = 99999").fetchone()[0] == 0)

        db.close()

        print("\n--- 7. 重开连接：持久化 ---")
        db2 = connect(db_path)
        check("重开后数据仍在（已删 1 条）",
              db2.execute("select count(*) from chunks").fetchone()[0] == N - 1)
        check("重开后重命名仍生效",
              db2.execute("select doc_id from chunks where chunk_id = 2").fetchone()[0] == "doc-renamed")
        check("重开后仍能 KNN",
              len(db2.execute("select chunk_id from chunks where embedding match ? order by distance limit 1",
                              (serialize_f32(probe),)).fetchall()) == 1)
        files = {p.name for p in tmpdir.iterdir()}
        check("WAL 文件存在", any(n.endswith("-wal") for n in files), str(sorted(files)))

        print("\n--- 8. 其它向量维度 / 类型 ---")
        for dim in (768, 1024, 1536):
            db2.execute(f"create virtual table t{dim} using vec0(e float[{dim}])")
            db2.execute(f"insert into t{dim}(rowid, e) values (1, ?)", (serialize_f32([0.1] * dim),))
            r = db2.execute(f"select rowid from t{dim} where e match ? order by distance limit 1",
                            (serialize_f32([0.1] * dim),)).fetchall()
            check(f"float[{dim}] 可用", bool(r) and r[0][0] == 1)

        db2.execute("create virtual table t_i8 using vec0(e int8[8])")
        db2.execute("insert into t_i8(rowid, e) values (1, vec_int8(?))", (serialize_i8([1] * 8),))
        check("int8 列可用（需 vec_int8 包裹）",
              db2.execute("select count(*) from t_i8").fetchone()[0] == 1)

        db2.execute("create virtual table t_bit using vec0(e bit[16])")
        db2.execute("insert into t_bit(rowid, e) values (1, vec_bit(?))", (serialize_bit("1" * 16),))
        check("bit 列可用（需 vec_bit 包裹）",
              db2.execute("select count(*) from t_bit").fetchone()[0] == 1)
        db2.close()

        size = sum(p.stat().st_size for p in tmpdir.iterdir())
        print(f"\n库文件总大小: {size / 1024 / 1024:.1f} MB（{N} 条 {DIM} 维 float32）")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    print(f"\n===== 结果: {PASS} 通过 / {FAIL} 失败 =====")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
