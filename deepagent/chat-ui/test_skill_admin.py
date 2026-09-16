"""Skill（技能）管理数据层测试。

覆盖：frontmatter 解析 / 按框架规则校验 SKILL.md / 扫盘发现（含同名覆盖、
优先级顺序）/ 开关读写 / 正文读写（备份 + 原子写）/ 路径逃逸防护。

全部跑在**临时技能目录 + 临时配置目录**上，不会碰真实技能，也不联网。

运行：
    python test_skill_admin.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

TMP = Path(tempfile.mkdtemp(prefix="skilladmin_"))

# agent_config 的 CONFIG_PATH 指向 chat-ui/agent_config.json，测试要隔离它，
# 否则会污染（甚至删掉）真实配置。在导入前改掉模块常量。
import agent_config as cfg  # noqa: E402

cfg.CONFIG_PATH = TMP / "agent_config.json"

import skills_admin as S  # noqa: E402

PASS = FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}" + (f"  ({detail})" if detail else ""))


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")
    return path


def make_skill(root: Path, name: str, body: str = "# Body\n\nDo the thing.\n",
               description: str = "A test skill.") -> Path:
    md = f"---\nname: {name}\ndescription: {description}\n---\n\n{body}"
    return write(root / name / "SKILL.md", md)


def sources(low: Path, high: Path) -> list[S.SkillSource]:
    return [
        S.SkillSource("Low", "/low/skills", low),
        S.SkillSource("High", "/high/skills", high),
    ]


# --------------------------------------------------------------------------
# A. frontmatter 解析
# --------------------------------------------------------------------------

def sec_parse() -> None:
    print("\n=== A. frontmatter 解析 ===")
    ok = S.parse_frontmatter("---\nname: a\ndescription: b\n---\n\nbody\n")
    check("A1 正常 frontmatter 解析出 dict", isinstance(ok, dict) and ok["name"] == "a", str(ok))

    check("A2 无 frontmatter → None",
          S.parse_frontmatter("no frontmatter here") is None)
    check("A3 frontmatter 未闭合 → None",
          S.parse_frontmatter("---\nname: a\n\nbody\n") is None)
    check("A4 空 frontmatter → None",
          S.parse_frontmatter("---\n\n---\n\nx\n") is None or
          S.parse_frontmatter("---\n---\n") is None)
    check("A5 非法 YAML → None",
          S.parse_frontmatter("---\nname: [unclosed\n---\n\nx\n") is None)
    check("A6 非映射（列表）→ None",
          S.parse_frontmatter("---\n- a\n- b\n---\n\nx\n") is None)

    # 前导内容不算 frontmatter（框架用 ^ 锚定首行）
    check("A7 frontmatter 必须在文件首行",
          S.parse_frontmatter("\n---\nname: a\ndescription: b\n---\n\nx\n") is None)

    # 值与冒号共存（description 里带英文冒号）
    d = S.parse_frontmatter("---\nname: a\ndescription: 'cost: low'\n---\n\nx\n")
    check("A8 description 含冒号可解析", d is not None and d["description"] == "cost: low")


# --------------------------------------------------------------------------
# B. 校验（必须与框架同一套判定）
# --------------------------------------------------------------------------

def sec_validate() -> None:
    print("\n=== B. SKILL.md 校验 ===")

    def v(text: str, name: str = "demo") -> tuple[list[str], list[str]]:
        return S.validate_skill_md(text, name)

    probs, warns = v("---\nname: demo\ndescription: ok\n---\n\nbody\n")
    check("B1 合法内容零问题", probs == [], str(probs))

    probs, _ = v("no frontmatter")
    check("B2 缺 frontmatter 被拒", any("frontmatter" in p for p in probs), str(probs))

    probs, _ = v("---\ndescription: ok\n---\n\nbody\n")
    check("B3 缺 name 被拒", any("name" in p for p in probs), str(probs))

    probs, _ = v("---\nname: demo\n---\n\nbody\n")
    check("B4 缺 description 被拒", any("description" in p for p in probs), str(probs))

    probs, _ = v("---\nname: other\ndescription: ok\n---\n\nbody\n")
    check("B5 name 与目录名不一致被拒", any("目录名" in p for p in probs), str(probs))

    # 形状非法：中文名会让框架静默跳过 —— 这条是历史踩过的坑
    probs, _ = v("---\nname: 项目分析\ndescription: ok\n---\n\nbody\n", "项目分析")
    check("B6 中文 name 被拒（框架会静默跳过）",
          any("不合法" in p for p in probs), str(probs))

    for bad in ("-lead", "lead-", "a--b", "Lead", "a_b", "a b", "a.b"):
        probs, _ = v(f"---\nname: {bad}\ndescription: ok\n---\n\nbody\n", bad)
        check(f"B7 name 「{bad}」被拒", len(probs) > 0, str(probs)[:60])

    probs, _ = v("---\nname: " + "a" * 65 + "\ndescription: ok\n---\n\nbody\n", "a" * 65)
    check("B8 name 超 64 字符被拒", len(probs) > 0, str(probs)[:60])

    # 合法边界：单个连字符、纯数字、大小写混合里的全小写形态
    for good in ("lead-analyzer", "x", "a1", "1a", "read-only-2"):
        probs, _ = v(f"---\nname: {good}\ndescription: ok\n---\n\nbody\n", good)
        check(f"B9 name 「{good}」合法", probs == [], str(probs))

    probs, _ = v("---\nname: demo\ndescription: " + "x" * 1025 + "\n---\n\nbody\n")
    check("B10 description 超 1024 被拒",
          any("1024" in p for p in probs), str(probs)[:60])

    probs, _ = v("---\nname: demo\ndescription: ok\n---\n\nbody\n")
    _, warns = v("---\nname: demo\ndescription: ok\nallowed_tools: [a]\n---\n\nbody\n")
    check("B11 allowed_tools（下划线）给出 warning 但不阻塞",
          any("allowed-tools" in w for w in warns) and probs == [], str(warns))

    probs, warns = v("---\nname: demo\ndescription: ok\n---\n")
    check("B12 无正文只 warning 不阻塞", probs == [] and any("正文" in w for w in warns), str(warns))

    probs, warns = v("---\nname: demo\ndescription: ok\nunknown_key: 1\n---\n\nbody\n")
    check("B13 未知 frontmatter 字段只 warning",
          probs == [] and any("unknown_key" in w for w in warns), str(warns))

    probs, warns = v("---\nname: demo\ndescription: ok\ncompatibility: [a]\n---\n\nbody\n")
    check("B14 compatibility 写成列表给 warning",
          probs == [] and any("纯文本" in w for w in warns), str(warns))

    # 超大文件：面板编辑上限
    probs, _ = v("---\nname: demo\ndescription: ok\n---\n\n" + "x" * (S.MAX_EDITABLE_BYTES + 10))
    check("B15 超过面板编辑上限被拒",
          any("面板编辑上限" in p for p in probs), str(probs)[:80])

    # YAML 里的 name 是数字 → str() 后比对，与框架一致
    probs, _ = v("---\nname: 123\ndescription: ok\n---\n\nbody\n", "123")
    check("B16 纯数字 name 可接受", probs == [], str(probs))


# --------------------------------------------------------------------------
# C. 扫盘发现
# --------------------------------------------------------------------------

def sec_discover() -> None:
    print("\n=== C. 扫盘发现 ===")
    low = TMP / "low"
    high = TMP / "high"

    make_skill(low, "alpha", description="from low")
    make_skill(low, "beta", description="only in low")
    make_skill(high, "alpha", description="from high (wins)")
    make_skill(high, "gamma")

    srcs = sources(low, high)
    items = S.discover(srcs)
    by = {i["name"]: i for i in items}

    check("C1 发现全部技能（去重后 3 个）", len(items) == 3, str([i["name"] for i in items]))
    check("C2 同名由高优先级来源覆盖",
          by["alpha"]["source"] == "High" and by["alpha"]["description"] == "from high (wins)",
          str(by["alpha"]["description"]))
    check("C3 覆盖后仍保留首次出现的位置（顺序稳定）",
          [i["name"] for i in items] == ["alpha", "beta", "gamma"], str([i["name"] for i in items]))
    check("C4 低优先级独有技能保留", by["beta"]["source"] == "Low")
    check("C5 虚拟路径可拼出（模型 read_file 用）",
          by["gamma"]["virtual_path"] == "/high/skills/gamma/SKILL.md",
          by["gamma"]["virtual_path"])

    # 非技能目录 / 缺 SKILL.md 的目录必须忽略
    (low / "not-a-skill").mkdir(parents=True, exist_ok=True)
    write(low / "stray-file.md", "hello")
    items2 = S.discover(srcs)
    check("C6 无 SKILL.md 的目录 / 散落文件被忽略",
          len(items2) == 3, str([i["name"] for i in items2]))

    # 不合法的 SKILL.md：仍要列出来（否则用户在面板里根本看不到问题技能）
    bad = TMP / "bad"
    write(bad / "broken" / "SKILL.md", "no frontmatter at all")
    items3 = S.discover(sources(low, bad))
    broken = next(i for i in items3 if i["name"] == "broken")
    check("C7 格式非法的技能仍会列出（但标记 invalid）", broken["valid"] is False)
    check("C8 invalid 技能带出原因", len(broken["problems"]) > 0, str(broken["problems"][:1]))

    # 名字不匹配也要能看出来
    write(bad / "mismatch" / "SKILL.md",
          "---\nname: something-else\ndescription: ok\n---\n\nbody\n")
    items4 = S.discover(sources(low, bad))
    mm = next(i for i in items4 if i["name"] == "mismatch")
    check("C9 name 与目录名不一致会被标出来", mm["valid"] is False, str(mm["problems"]))

    # builtin 标记
    srcs3 = [
        S.SkillSource("Built-in", "/x/built_in_skills", low),
        S.SkillSource("Chat UI", "/chat-ui/skills", high),
    ]
    items5 = S.discover(srcs3)
    check("C10 Built-in 来源标记 builtin=True",
          all(i["builtin"] for i in items5 if i["source"] == "Built-in"))
    check("C11 非 Built-in 来源 builtin=False",
          all(not i["builtin"] for i in items5 if i["source"] != "Built-in"))

    # 附属文件计数
    write(high / "gamma" / "scripts" / "run.py", "print(1)")
    items6 = S.discover(srcs)
    g = next(i for i in items6 if i["name"] == "gamma")
    check("C12 统计 SKILL.md 之外的附属文件", g["extra_files"] == 1, str(g["extra_files"]))

    # 不存在的来源目录 → 跳过不报错
    items7 = S.discover([S.SkillSource("Nope", "/nope", TMP / "does-not-exist")])
    check("C13 来源目录不存在时安全跳过", items7 == [], str(items7))


# --------------------------------------------------------------------------
# D. 开关（agent_config 集成）
# --------------------------------------------------------------------------

def sec_toggle() -> None:
    print("\n=== D. 技能开关 ===")
    if cfg.CONFIG_PATH.exists():
        cfg.CONFIG_PATH.unlink()

    check("D1 默认无覆盖", cfg.get_skill_overrides() == {}, str(cfg.get_skill_overrides()))
    check("D2 默认开启", cfg.get_skill_enabled("alpha") is True)

    cfg.set_skill_enabled("alpha", False)
    check("D3 关闭后落库", cfg.get_skill_overrides() == {"alpha": False},
          str(cfg.get_skill_overrides()))
    check("D4 关闭后 effective().disabled_skills 含之",
          "alpha" in cfg.effective()["disabled_skills"], str(cfg.effective()["disabled_skills"]))
    check("D5 未设置的技能仍默认开启", cfg.get_skill_enabled("beta") is True)

    # 反复关闭 → 幂等
    cfg.set_skill_enabled("alpha", False)
    check("D6 重复关闭幂等", cfg.get_skill_overrides() == {"alpha": False})

    # 开回来 → 记录被删掉（默认态不写冗余数据）
    cfg.set_skill_enabled("alpha", True)
    check("D7 重新开启后覆盖记录被清除", cfg.get_skill_overrides() == {},
          str(cfg.get_skill_overrides()))
    raw = json.loads(cfg.CONFIG_PATH.read_text(encoding="utf-8"))
    check("D8 配置文件里 skills 为空对象", raw.get("skills") == {}, str(raw.get("skills")))

    # 非法名字
    try:
        cfg.set_skill_enabled("", False)
        check("D9 空技能名被拒", False, "未抛错")
    except cfg.UnknownSkillError:
        check("D9 空技能名被拒", True)
    for bad in ("../evil", "a/b", "a\\b", "x" * 65):
        try:
            cfg.set_skill_enabled(bad, False)
            check(f"D10 非法技能名「{bad[:12]}」被拒", False, "未抛错")
        except cfg.UnknownSkillError:
            check(f"D10 非法技能名「{bad[:12]}」被拒", True)

    try:
        cfg.set_skill_enabled("alpha", "yes")  # type: ignore[arg-type]
        check("D11 enabled 非布尔被拒", False, "未抛错")
    except ValueError:
        check("D11 enabled 非布尔被拒", True)

    # 脏配置文件（skills 是列表 / 值是字符串）→ 回退默认，不炸
    cfg.CONFIG_PATH.write_text(
        json.dumps({"system_prompt": None, "tools": {}, "skills": {"a": "yes", "b": {"enabled": 1}}},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    check("D12 脏 skills 配置被过滤", cfg.get_skill_overrides() == {},
          str(cfg.get_skill_overrides()))

    # 多个技能同时关闭，顺序稳定
    cfg.set_skill_enabled("zeta", False)
    cfg.set_skill_enabled("alpha", False)
    check("D13 多个关闭项按名排序输出",
          cfg.effective()["disabled_skills"] == ["alpha", "zeta"],
          str(cfg.effective()["disabled_skills"]))

    # reset_all 清掉技能开关
    cfg.reset_all()
    check("D14 reset_all 清空技能开关", cfg.get_skill_overrides() == {})


# --------------------------------------------------------------------------
# E. catalog（扫盘 × 开关）
# --------------------------------------------------------------------------

def sec_catalog() -> None:
    print("\n=== E. catalog ===")
    low = TMP / "low"
    high = TMP / "high"
    srcs = sources(low, high)

    cat = S.catalog(srcs, {"beta": False})
    sm = cat["summary"]
    check("E1 summary.total 正确", sm["total"] == 3, str(sm))
    check("E2 summary.enabled/disabled 正确",
          sm["enabled"] == 2 and sm["disabled"] == 1, str(sm))
    check("E3 每个技能带 enabled 字段",
          {i["name"]: i["enabled"] for i in cat["skills"]} ==
          {"alpha": True, "beta": False, "gamma": True},
          str({i["name"]: i["enabled"] for i in cat["skills"]}))
    check("E4 sources 汇总计数",
          {s["label"]: s["count"] for s in sm["sources"]} == {"Low": 1, "High": 2},
          str(sm["sources"]))

    # 孤儿记录：配置里关了，磁盘上没这个技能
    cat2 = S.catalog(srcs, {"ghost": False})
    check("E5 孤儿关闭记录被标出", cat2["summary"]["orphan_disabled"] == ["ghost"],
          str(cat2["summary"]["orphan_disabled"]))
    check("E6 孤儿记录不影响计数", cat2["summary"]["disabled"] == 0,
          str(cat2["summary"]))

    cat3 = S.catalog([S.SkillSource("Bad", "/bad", TMP / "bad")], {})
    check("E7 invalid 计数", cat3["summary"]["invalid"] >= 2, str(cat3["summary"]))


# --------------------------------------------------------------------------
# F. 正文读写
# --------------------------------------------------------------------------

def sec_content() -> None:
    print("\n=== F. 正文读写 ===")
    low = TMP / "low"
    srcs = sources(low, TMP / "high")
    backup = TMP / "backups"

    got = S.read_content("alpha", srcs)
    check("F1 读取正文",
          got["content"].startswith("---") and "name: alpha" in got["content"],
          repr(got["content"][:30]))
    check("F2 读取时带上元数据", got["source"] == "High" and got["virtual_path"].endswith("SKILL.md"))

    original = got["content"]
    new = "---\nname: alpha\ndescription: edited by test\n---\n\n# Edited\n\nNew body.\n"
    saved = S.write_content("alpha", new, srcs, backup)
    check("F3 保存成功并回读一致", saved["content"] == new, repr(saved["content"][:40]))
    check("F4 描述已更新", saved["description"] == "edited by test", saved["description"])

    # 备份
    bdir = backup / "alpha"
    baks = sorted(bdir.glob("*.bak"))
    check("F5 旧版本已备份", len(baks) == 1, str([b.name for b in baks]))
    check("F6 备份内容 = 修改前原文", baks[0].read_text(encoding="utf-8") == original)

    # CRLF 归一化
    crlf = "---\r\nname: alpha\r\ndescription: crlf\r\n---\r\n\r\nbody\r\n"
    saved = S.write_content("alpha", crlf, srcs, backup)
    check("F7 CRLF 归一化为 LF", "\r" not in saved["content"], repr(saved["content"][:30]))

    # 非法内容 → 拒绝且原文件不变
    before = (low / "alpha" / "SKILL.md").read_text(encoding="utf-8")
    try:
        S.write_content("alpha", "---\nname: nope\ndescription: x\n---\n\nbody\n", srcs, backup)
        check("F8 非法内容被拒", False, "未抛错")
    except S.SkillValidationError as e:
        check("F8 非法内容被拒", len(e.problems) > 0, str(e.problems)[:1])
    after = (low / "alpha" / "SKILL.md").read_text(encoding="utf-8")
    check("F9 拒绝时原文件未被改动", before == after)

    # 不存在的技能
    try:
        S.read_content("no-such", srcs)
        check("F10 读不存在的技能抛 SkillNotFound", False, "未抛错")
    except S.SkillNotFound:
        check("F10 读不存在的技能抛 SkillNotFound", True)
    try:
        S.write_content("no-such", "x", srcs, backup)
        check("F11 写不存在的技能抛 SkillNotFound", False, "未抛错")
    except S.SkillNotFound:
        check("F11 写不存在的技能抛 SkillNotFound", True)

    # 路径逃逸：name 只用于「在扫盘结果里查」，从不拼路径
    for evil in ("../alpha", "..\\alpha", "/etc/passwd", "alpha/../../secret"):
        try:
            S.read_content(evil, srcs)
            check(f"F12 逃逸路径「{evil}」被拒", False, "未抛错")
        except S.SkillNotFound:
            check(f"F12 逃逸路径「{evil}」被拒", True)

    # 备份数量上限
    for i in range(S.MAX_BACKUPS_PER_SKILL + 6):
        S.write_content("alpha", f"---\nname: alpha\ndescription: v{i}\n---\n\nbody {i}\n",
                        srcs, backup)
    baks2 = sorted(bdir.glob("*.bak"))
    check(f"F13 备份数量被限制在 {S.MAX_BACKUPS_PER_SKILL}",
          len(baks2) == S.MAX_BACKUPS_PER_SKILL, str(len(baks2)))
    # 备份名按时间递增，最新的一份应当是刚才最后一次写入前的正文
    check("F13b 保留的是最近的备份（按文件名即按时间序）",
          "v" + str(S.MAX_BACKUPS_PER_SKILL + 4) in
          baks2[-1].read_text(encoding="utf-8"),
          baks2[-1].name)

    # 备份目录不可写时不应阻塞保存（备份是便利功能，不是安全边界）
    blocked = TMP / "blocked_backup"
    S.write_content("alpha", "---\nname: alpha\ndescription: ok\n---\n\nbody\n", srcs, blocked)
    check("F14 备份目录可用时无额外 warning", True)

    # 非字符串内容
    try:
        S.write_content("alpha", None, srcs, backup)  # type: ignore[arg-type]
        check("F15 非字符串内容被拒", False, "未抛错")
    except S.SkillValidationError:
        check("F15 非字符串内容被拒", True)

    # find 的返回与 discover 一致
    f = S.find("gamma", srcs)
    check("F16 find 命中", f["name"] == "gamma", f["source"])


def main() -> int:
    for sec in (sec_parse, sec_validate, sec_discover, sec_toggle, sec_catalog, sec_content):
        sec()
    print("\n" + "=" * 60)
    print(f"Skill 管理数据层测试: {PASS}/{PASS + FAIL} 通过")
    if FAIL:
        print(f"失败 {FAIL} 项")
    print("=" * 60)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
