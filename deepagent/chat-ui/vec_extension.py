"""sqlite-vec（vec0）扩展的定位与加载。

本地部署的向量检索底座：`sqlite-vec` 是一个 SQLite 可加载扩展，提供 `vec0`
虚拟表（float32 / int8 / bit 向量）与 KNN 查询能力。本模块只负责把扩展装进
一个 `sqlite3.Connection`，不含任何知识库业务逻辑。

扩展文件解析优先级：
    1. 环境变量 `SQLITE_VEC_EXTENSION`（显式指定，最高优先级）
    2. 项目内置副本 `chat-ui/vendor/sqlite-vec/vec0.dll`
    3. pip 包 `sqlite_vec` 自带的扩展（langgraph-checkpoint-sqlite 的间接依赖）
    4. 本地源码仓库 `deepagent/sqlite-vec/dist/vec0.dll`

用法::

    from vec_extension import connect, serialize_f32

    with connect("kb/vectors.db") as db:
        db.execute("create virtual table if not exists chunks using vec0(embedding float[1024])")
        db.execute("insert into chunks(rowid, embedding) values (?, ?)", (1, serialize_f32(vec)))

自检::

    python vec_extension.py
"""

from __future__ import annotations

import os
import sqlite3
import struct
import sys
from pathlib import Path

__all__ = [
    "VENDOR_DIR",
    "extension_candidates",
    "find_extension",
    "load_vec",
    "connect",
    "serialize_f32",
    "serialize_i8",
    "serialize_bit",
    "extension_info",
]

HERE = Path(__file__).resolve().parent
VENDOR_DIR = HERE / "vendor" / "sqlite-vec"

# Windows 下可加载扩展的后缀；SQLite 会按平台自动补全，显式带上更稳妥
SUFFIXES = ("", ".dll", ".so", ".dylib")


def _pip_extension_dir() -> Path | None:
    """pip 包 `sqlite_vec` 携带的扩展所在目录。"""
    try:
        import sqlite_vec  # type: ignore
    except ImportError:
        return None
    return Path(sqlite_vec.__file__).resolve().parent


def extension_candidates() -> list[tuple[str, Path]]:
    """按优先级返回候选扩展文件：(来源说明, 路径)。"""
    out: list[tuple[str, Path]] = []

    env = os.environ.get("SQLITE_VEC_EXTENSION")
    if env:
        out.append(("环境变量 SQLITE_VEC_EXTENSION", Path(env)))

    for suffix in SUFFIXES:
        out.append(("项目内置副本", VENDOR_DIR / f"vec0{suffix}"))

    pip_dir = _pip_extension_dir()
    if pip_dir is not None:
        for suffix in SUFFIXES:
            out.append((f"pip 包 sqlite_vec ({pip_dir.name})", pip_dir / f"vec0{suffix}"))

    # 源码仓库（git clone 的 asg017/sqlite-vec）构建产物
    for rel in ("../../../../sqlite-vec/dist", "../../../sqlite-vec/dist"):
        for suffix in SUFFIXES:
            out.append(("源码仓库 dist/", (HERE / rel / f"vec0{suffix}").resolve()))

    return out


def find_extension() -> tuple[str, Path]:
    """返回第一个真实存在的扩展文件。找不到时抛 FileNotFoundError。"""
    tried: list[str] = []
    for source, path in extension_candidates():
        if path.is_file():
            return source, path
        tried.append(f"  - [{source}] {path}")
    raise FileNotFoundError(
        "未找到 vec0 扩展文件，已尝试：\n"
        + "\n".join(tried)
        + "\n\n修复方式：设置环境变量 SQLITE_VEC_EXTENSION 指向 vec0.dll，"
        "或把 vec0.dll 放到 chat-ui/vendor/sqlite-vec/ 下。"
    )


def load_vec(conn: sqlite3.Connection, path: str | os.PathLike[str] | None = None) -> str:
    """把 vec0 扩展加载进连接，返回实际使用的扩展路径。

    加载完成后立刻关闭 `enable_load_extension`，避免连接后续被注入其它扩展。
    """
    if path is None:
        _, path = find_extension()
    conn.enable_load_extension(True)
    try:
        conn.load_extension(str(path))
    finally:
        conn.enable_load_extension(False)
    return str(path)


def connect(
    db_path: str | os.PathLike[str] = ":memory:",
    *,
    extension: str | os.PathLike[str] | None = None,
    timeout: float = 30.0,
    wal: bool = True,
) -> sqlite3.Connection:
    """打开一个已加载 vec0 扩展的连接。

    SQLite 是单写入者模型，知识库场景下开启 WAL 可显著改善并发读写体验。
    """
    conn = sqlite3.connect(str(db_path), timeout=timeout)
    if wal and str(db_path) != ":memory:":
        try:
            conn.execute("pragma journal_mode = wal")
        except sqlite3.DatabaseError:
            pass
    conn.execute("pragma foreign_keys = on")
    load_vec(conn, extension)
    return conn


def serialize_f32(vector) -> bytes:
    """float32 向量 -> 二进制（SQLite BLOB）。

    接受 list/tuple 或任何实现 Buffer 协议的对象（如 `np.float32` 数组）。
    """
    if not isinstance(vector, (list, tuple)):
        return bytes(memoryview(vector))
    return struct.pack(f"{len(vector)}f", *vector)


def serialize_i8(vector) -> bytes:
    """int8 向量 -> 二进制。注意：写入 int8 列时须用 `vec_int8(?)` 包一层。"""
    if not isinstance(vector, (list, tuple)):
        return bytes(memoryview(vector))
    return struct.pack(f"{len(vector)}b", *vector)


def serialize_bit(bits: str) -> bytes:
    """位串（如 `"10101010"`）-> 二进制。写入 bit 列时须用 `vec_bit(?)`。"""
    if len(bits) % 8 != 0:
        raise ValueError(f"位串长度必须是 8 的倍数，当前 {len(bits)}")
    return bytes(int(bits[i : i + 8], 2) for i in range(0, len(bits), 8))


def extension_info() -> dict:
    """返回扩展来源与版本，便于启动时打印/接口暴露。"""
    source, path = find_extension()
    conn = connect(":memory:")
    try:
        version = conn.execute("select vec_version()").fetchone()[0]
    finally:
        conn.close()
    return {
        "source": source,
        "path": str(path),
        "size": path.stat().st_size,
        "vec_version": version,
        "sqlite_version": sqlite3.sqlite_version,
    }


def _self_check() -> int:
    ok = fail = 0

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal ok, fail
        if cond:
            ok += 1
            print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
        else:
            fail += 1
            print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))

    info = extension_info()
    print(f"扩展来源 : {info['source']}")
    print(f"扩展路径 : {info['path']}")
    print(f"文件大小 : {info['size']} bytes")
    print(f"vec0 版本: {info['vec_version']}   SQLite: {info['sqlite_version']}")
    check("加载扩展并取到版本号", info["vec_version"].startswith("v"))

    db = connect(":memory:")
    try:
        check("vec_version() 可查询", bool(db.execute("select vec_version()").fetchone()[0]))
        db.execute("create virtual table t using vec0(embedding float[4])")
        db.executemany(
            "insert into t(rowid, embedding) values (?, ?)",
            [(1, serialize_f32([1.0, 0.0, 0.0, 0.0])), (2, serialize_f32([0.0, 1.0, 0.0, 0.0]))],
        )
        hits = db.execute(
            "select rowid from t where embedding match ? order by distance limit 1",
            (serialize_f32([0.9, 0.1, 0.0, 0.0]),),
        ).fetchall()
        check("float32 KNN 命中 rowid 1", hits and hits[0][0] == 1, f"hits={hits}")

        db.execute("create virtual table ti using vec0(e int8[4])")
        db.execute("insert into ti(rowid, e) values (1, vec_int8(?))", (serialize_i8([1, 2, 3, 4]),))
        check("int8 向量可写入", db.execute("select count(*) from ti").fetchone()[0] == 1)

        db.execute("create virtual table tb using vec0(e bit[8])")
        db.execute("insert into tb(rowid, e) values (1, vec_bit(?))", (serialize_bit("10101010"),))
        check("bit 向量可写入", db.execute("select count(*) from tb").fetchone()[0] == 1)
    finally:
        db.close()

    # 关键回归：确认扩展加载后 load_extension 已被关闭
    db2 = connect(":memory:")
    try:
        try:
            db2.load_extension(info["path"])
            check("加载后 load_extension 保持关闭", False, "仍可加载其它扩展")
        except sqlite3.OperationalError:
            check("加载后 load_extension 保持关闭", True)
    finally:
        db2.close()

    print(f"\n===== 自检结果: {ok} 通过 / {fail} 失败 =====")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(_self_check())
