"""CRM 业务数据保护 —— 给端到端测试兜底还原。

为什么需要
----------
``test_crm_e2e.py`` / ``test_crm_permissions.py`` 必须借**活的 Agent** 跑，
而「批准写操作」那条路会真的写 ``CRM_Agent1.0/data/*.json``。偏偏删除又是
被策略禁止的（这正是要测的东西），测试自己没法清理 —— 于是每次跑完都会把
测试线索留在真实业务数据里（实测留下过 ``LD-2026-0036`` / ``LD-2026-0037``，
以及一条被改写成「权限测试-已批准」的备注）。

这两个文件的 docstring 里都写着「CRM 数据由外层备份/恢复兜底」，但那个
"外层" 从来没人真的执行。这个模块把它补上。

用法
----
脚本式测试（顶层代码，无法整体包 try）用 ``install_guard()``：

    from crm_data_guard import install_guard
    install_guard()          # 立刻快照，并在进程退出时还原

需要精确控制范围时用上下文管理器：

    with guard_crm_data():
        ...

还原是**按字节**的，不受 JSON 重新序列化影响（缩进 / 换行 / 末尾换行都不变）。
"""
from __future__ import annotations

import atexit
import os
from contextlib import contextmanager
from pathlib import Path

# 允许用环境变量覆盖（换机器 / CI 时不必改代码）
CRM_DATA_DIR = Path(
    os.environ.get("CRM_DATA_DIR")
    or r"C:\Users\Administrator\Documents\deepagent\CRM_Agent1.0\data"
)


def _snapshot(root: Path) -> dict[str, bytes]:
    if not root.is_dir():
        raise FileNotFoundError(f"CRM 数据目录不存在：{root}")
    return {p.name: p.read_bytes() for p in sorted(root.glob("*.json"))}


def _restore(root: Path, snapshot: dict[str, bytes]) -> list[str]:
    """按字节还原。返回被还原的文件名（用于报告）。"""
    changed: list[str] = []
    for name, blob in snapshot.items():
        p = root / name
        try:
            # 先判存在：文件被删掉时 read_bytes() 会抛 FileNotFoundError，
            # 那种情况恰恰最需要还原，不能当成"读失败"跳过。
            if not p.exists() or p.read_bytes() != blob:
                p.write_bytes(blob)
                changed.append(name)
        except OSError as e:
            print(f"  [guard] 还原 {name} 失败：{e}")
    # 测试期间凭空多出来的 json 只报告、不删除 —— 宁可留个提醒，
    # 也不要因为猜错而删掉用户的数据。
    extra = sorted(p.name for p in root.glob("*.json") if p.name not in snapshot)
    if extra:
        print(f"  [guard] 注意：数据目录出现新文件，未自动删除，请人工确认：{extra}")
    return changed


def restore_crm_data(snapshot=None, root=None) -> list[str]:
    """还原到给定快照（默认取进入时的快照）。"""
    root = Path(root or CRM_DATA_DIR)
    snap = snapshot if snapshot is not None else _SNAPSHOT
    if not snap:
        return []
    return _restore(root, snap)


_SNAPSHOT: dict[str, bytes] | None = None
_INSTALLED = False


def install_guard(root: Path | str | None = None) -> dict[str, bytes]:
    """快照 CRM 数据并注册退出还原（幂等）。返回快照本身。"""
    global _SNAPSHOT, _INSTALLED
    target = Path(root or CRM_DATA_DIR)
    if _SNAPSHOT is None:
        _SNAPSHOT = _snapshot(target)
        print(f"  [guard] 已快照 {len(_SNAPSHOT)} 个 CRM 数据文件：{target}")
    if not _INSTALLED:
        atexit.register(_on_exit)
        _INSTALLED = True
    return _SNAPSHOT


def _on_exit() -> None:
    changed = restore_crm_data()
    if changed:
        print(f"  [guard] 退出还原：{', '.join(changed)}")
    else:
        print("  [guard] 退出还原：CRM 数据无改动")


@contextmanager
def guard_crm_data(root: Path | str | None = None):
    """进入时快照、退出时还原（含异常路径）。"""
    target = Path(root or CRM_DATA_DIR)
    snap = _snapshot(target)
    print(f"  [guard] 已快照 {len(snap)} 个 CRM 数据文件：{target}")
    try:
        yield snap
    finally:
        changed = _restore(target, snap)
        print(f"  [guard] 已还原：{', '.join(changed) if changed else '无改动'}")


if __name__ == "__main__":
    # 自检：不碰真实数据，在临时目录上验证字节级还原
    import shutil
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="crmguard_"))
    try:
        (tmp / "a.json").write_bytes(b'[\r\n  {"id": 1}\r\n]')  # CRLF、无末尾换行
        (tmp / "b.json").write_bytes(b"[1, 2, 3]")
        original = {p.name: p.read_bytes() for p in tmp.glob("*.json")}

        with guard_crm_data(tmp) as snap:
            assert len(snap) == 2, snap
            (tmp / "a.json").write_bytes(b'[{"id": 1}, {"id": 2}]')  # 篡改
            (tmp / "b.json").unlink()                                # 误删

        ok = 0
        print("\n自检：")
        for name, blob in original.items():
            same = (tmp / name).read_bytes() == blob
            ok += same
            print(f"  [{'PASS' if same else 'FAIL'}] {name} 字节级还原")
        print(f"\n结果: {ok}/{len(original)} 通过")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
