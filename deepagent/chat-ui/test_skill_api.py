"""Skill 管理 **HTTP 接口** 测试（前端「Skill 管理」Tab 依赖的四个接口）。

覆盖：
  GET  /api/panel/skills                技能清单 + 汇总（扫盘 × 开关）
  PUT  /api/panel/skills/{name}          开 / 关
  GET  /api/panel/skills/{name}/content  读 SKILL.md
  PUT  /api/panel/skills/{name}/content  改 SKILL.md（校验 / 备份 / 原子写）

以及：开关是否真的影响系统提示词与 /api/capabilities、422 校验边界、404、路径逃逸。

⚠️ 需要 chat-ui 在 8765 运行：
        python server.py
⚠️ 测试会在 `chat-ui/skills/` 下**临时创建一个技能目录**（`e2e-api-probe`）来做
   写操作，结束时删掉该目录并清掉开关记录；真实技能只读取、不改动。
   收尾时会断言技能数回到基线。

运行：
    python test_skill_api.py
"""
from __future__ import annotations

import json
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

BASE = "http://127.0.0.1:8765"
TIMEOUT = 20

# 临时技能：放在真实技能来源目录（chat-ui/skills）里，才能被扫盘发现
SKILLS_DIR = HERE / "skills"
PROBE = "e2e-api-probe"
PROBE_DIR = SKILLS_DIR / PROBE
# 备份根目录（server.py 的 SKILL_BACKUP_DIR）。必须一起清理：
# 上一轮跑剩下的备份会让「备份内容 == 修改前原文」这条断言读到别的批次的内容。
BACKUP_DIR = HERE / "_skill_backups" / PROBE

PROBE_MD = (
    "---\n"
    f"name: {PROBE}\n"
    "description: Temporary skill created by test_skill_api.py — safe to delete.\n"
    "allowed-tools:\n"
    "  - read_file\n"
    "---\n"
    "\n"
    "# API Probe Skill\n"
    "\n"
    "This skill exists only so the Skill management HTTP endpoints can be tested.\n"
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


# ==========================================================================
# HTTP 小工具
# ==========================================================================

def call(method: str, path: str, *, json_body: dict | None = None) -> tuple[int, object]:
    url = f"{BASE}{path}"
    data = None
    headers: dict[str, str] = {}
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw, code = resp.read(), resp.status
    except urllib.error.HTTPError as e:
        raw, code = e.read(), e.code
    text = raw.decode("utf-8", "replace")
    try:
        return code, json.loads(text)
    except json.JSONDecodeError:
        return code, text


def list_skills() -> dict:
    code, body = call("GET", "/api/panel/skills")
    assert code == 200, f"GET /api/panel/skills -> {code}: {body}"
    return body  # type: ignore[return-value]


def baseline() -> int:
    return int(list_skills()["summary"]["total"])


def set_enabled(name: str, enabled: bool) -> tuple[int, object]:
    return call("PUT", f"/api/panel/skills/{urllib.parse.quote(name)}",
                json_body={"enabled": enabled})


# ==========================================================================
# A. 清单接口
# ==========================================================================

def sec_list(base_total: int) -> None:
    print("\n=== A. GET /api/panel/skills ===")
    d = list_skills()

    check("A1 顶层字段齐全",
          {"skills", "summary", "backup_dir", "limit_bytes"} <= set(d), str(sorted(d)))
    check("A2 扫描到技能（含刚才创建的探针技能）",
          d["summary"]["total"] == base_total + 1, str(d["summary"]["total"]))
    check("A3 skills 是列表且长度与 total 一致",
          isinstance(d["skills"], list) and len(d["skills"]) == d["summary"]["total"])

    s = d["skills"][0]
    need = {"name", "description", "source", "source_path", "path", "virtual_path",
            "enabled", "valid", "problems", "warnings", "size", "mtime", "lines",
            "chars", "allowed_tools", "compatibility", "license", "extra_files", "builtin"}
    check("A4 技能条目字段齐全", need <= set(s), str(sorted(need - set(s))))

    probe = next((x for x in d["skills"] if x["name"] == PROBE), None)
    check("A5 探针技能出现在清单里", probe is not None)
    if probe:
        check("A6 简介来自 frontmatter 的 description",
              "Temporary skill" in probe["description"], probe["description"][:50])
        check("A7 来源为 Chat UI", probe["source"] == "Chat UI", probe["source"])
        check("A8 虚拟路径正确",
              probe["virtual_path"] == f"/chat-ui/skills/{PROBE}/SKILL.md",
              probe["virtual_path"])
        check("A9 默认开启", probe["enabled"] is True)
        check("A10 格式合法", probe["valid"] is True, str(probe["problems"]))
        check("A11 解析出 allowed-tools（连字符）",
              probe["allowed_tools"] == ["read_file"], str(probe["allowed_tools"]))
        check("A12 非内置技能", probe["builtin"] is False)

    sm = d["summary"]
    check("A13 summary 含 sources 汇总",
          isinstance(sm["sources"], list) and all(
              {"label", "path", "count"} <= set(x) for x in sm["sources"]))
    check("A14 enabled + disabled == total",
          sm["enabled"] + sm["disabled"] == sm["total"], str(sm))
    check("A15 有 backup_dir", isinstance(d["backup_dir"], str) and "skill_backups" in d["backup_dir"])
    check("A16 有 limit_bytes", isinstance(d["limit_bytes"], int) and d["limit_bytes"] > 0)


# ==========================================================================
# B. 读正文
# ==========================================================================

def sec_read() -> None:
    print("\n=== B. GET /api/panel/skills/{name}/content ===")
    code, d = call("GET", f"/api/panel/skills/{PROBE}/content")
    check("B1 200", code == 200, str(code))
    assert isinstance(d, dict)
    check("B2 返回原文且与磁盘一致", d["content"] == PROBE_MD,
          repr(d["content"][:40]))
    check("B3 带元数据", d["name"] == PROBE and d["source"] == "Chat UI")
    check("B4 带 path / virtual_path",
          d["path"].endswith("SKILL.md") and d["virtual_path"].startswith("/chat-ui/"))
    check("B5 problems 为空", d["problems"] == [], str(d["problems"]))
    check("B6 chars / lines 与内容匹配",
          d["chars"] == len(PROBE_MD) and d["lines"] == PROBE_MD.count("\n") + 1,
          f"chars={d['chars']} lines={d['lines']}")

    code, d = call("GET", "/api/panel/skills/definitely-no-such-skill/content")
    check("B7 不存在的技能 → 404", code == 404, str(code))


# ==========================================================================
# C. 开关
# ==========================================================================

def sec_toggle(base_total: int) -> None:
    print("\n=== C. PUT /api/panel/skills/{name} ===")
    code, d = set_enabled(PROBE, False)
    check("C1 关闭返回 200", code == 200, str(code))
    assert isinstance(d, dict)
    check("C2 返回里该技能 enabled=false", d["skill"]["enabled"] is False)
    check("C3 summary.disabled 自增", d["summary"]["disabled"] >= 1)
    check("C4 列表接口里也为 false",
          next(x for x in list_skills()["skills"] if x["name"] == PROBE)["enabled"] is False)

    # 关键：关闭要真的落到系统提示词与 capabilities 上
    code, ctx = call("GET", "/api/panel/skills")
    code2, caps = call("GET", "/api/capabilities")
    check("C5 capabilities 里列出已关闭技能",
          PROBE in caps["disabled_skills"], str(caps["disabled_skills"]))
    check("C6 capabilities 声明了技能管理能力",
          caps["skill_management"] is True and caps["skill_toggle"] is True)

    code, ctx = call("GET", "/api/context/api-test-session")
    check("C7 系统提示词出现「已关闭技能」段",
          "## Disabled Skills" in ctx["system_prompt"], "")
    check("C8 系统提示词点名该技能",
          PROBE in ctx["system_prompt"].split("## Disabled Skills")[-1][:400], "")
    entry = next(x for x in ctx["skills"] if x["name"] == PROBE)
    check("C9 /api/context 的技能索引标出 enabled=false", entry["enabled"] is False)

    # 幂等
    code, d2 = set_enabled(PROBE, False)
    check("C10 重复关闭幂等", code == 200 and d2["summary"]["disabled"] == d["summary"]["disabled"],
          str(d2["summary"]["disabled"]))

    # 开回来
    code, d3 = set_enabled(PROBE, True)
    check("C11 重新开启返回 200", code == 200)
    check("C12 enabled 回到 true", d3["skill"]["enabled"] is True)
    check("C13 已关闭数回落", d3["summary"]["disabled"] == 0, str(d3["summary"]["disabled"]))
    code, caps = call("GET", "/api/capabilities")
    check("C14 capabilities 里已无该技能", PROBE not in caps["disabled_skills"],
          str(caps["disabled_skills"]))
    code, ctx = call("GET", "/api/context/api-test-session")
    check("C15 系统提示词不再有「已关闭技能」段",
          "## Disabled Skills" not in ctx["system_prompt"])

    # 不存在的技能
    code, d4 = set_enabled("definitely-no-such-skill", False)
    check("C16 开关不存在的技能 → 404", code == 404, str(code))

    # 路径逃逸（URL 编码的 ../）
    for evil in ("..%2F..%2Fetc%2Fpasswd", "..%5C..%5Cwindows"):
        code, _ = set_enabled(evil, False)
        check(f"C17 逃逸名「{evil[:14]}」被拒", code in (400, 404), str(code))
        code, _ = call("GET", f"/api/panel/skills/{evil}/content")
        check(f"C18 逃逸名读正文被拒", code in (400, 404), str(code))

    # enabled 取值边界。
    # 注意：pydantic 默认宽松模式会把 "yes"/"on"/"1" 这类字符串强制转成 bool
    # （与既有的 /api/panel/tools/{name} 行为一致），所以这里断言的是**既有约定**，
    # 而不是「非布尔一律拒绝」——真正无法解析的值才 422。
    code, d5 = call("PUT", f"/api/panel/skills/{PROBE}", json_body={"enabled": "yes"})
    check("C19 enabled 字符串被 pydantic 宽松转 bool",
          code == 200 and d5["skill"]["enabled"] is True, f"{code} {d5}")
    code, _ = call("PUT", f"/api/panel/skills/{PROBE}", json_body={"enabled": "maybe"})
    check("C20 enabled 无法解析 → 422", code == 422, str(code))
    code, _ = call("PUT", f"/api/panel/skills/{PROBE}", json_body={})
    check("C21 缺 enabled 字段 → 422", code == 422, str(code))
    set_enabled(PROBE, True)  # 复原


# ==========================================================================
# D. 写正文
# ==========================================================================

def sec_write() -> None:
    print("\n=== D. PUT /api/panel/skills/{name}/content ===")
    path = PROBE_DIR / "SKILL.md"

    edited = (
        "---\n"
        f"name: {PROBE}\n"
        "description: Edited by test_skill_api.py.\n"
        "---\n"
        "\n"
        "# Edited\n"
        "\n"
        "New body from the API test.\n"
    )
    code, d = call("PUT", f"/api/panel/skills/{PROBE}/content", json_body={"content": edited})
    check("D1 保存返回 200", code == 200, str(code))
    assert isinstance(d, dict)
    check("D2 回读内容 = 提交内容",
          call("GET", f"/api/panel/skills/{PROBE}/content")[1]["content"] == edited)
    check("D3 磁盘文件已更新", path.read_text(encoding="utf-8") == edited)
    check("D4 列表里的简介已跟着更新",
          "Edited by test_skill_api" in d["skill"]["description"], d["skill"]["description"])
    check("D5 返回最新 summary", "summary" in d)
    check("D6 返回 backup_dir", isinstance(d.get("backup_dir"), str))

    # 备份
    bdir = Path(d["backup_dir"]) / PROBE
    baks = sorted(bdir.glob("*.bak"))
    check("D7 旧版本已备份", len(baks) >= 1, str([b.name for b in baks]))
    if baks:
        check("D8 备份内容 = 修改前的原文", baks[0].read_text(encoding="utf-8") == PROBE_MD)

    # 写接口与读接口的 backup_dir 必须是**同一个语义（根目录）**，
    # 否则调用方会各自多拼一级子目录
    read_backup = call("GET", f"/api/panel/skills/{PROBE}/content")[1]["backup_dir"]
    check("D8b 读/写接口的 backup_dir 语义一致",
          Path(read_backup) == Path(d["backup_dir"]),
          f"read={read_backup} write={d['backup_dir']}")

    # 校验：422
    cases = [
        ("D9  name 与目录名不一致", f"---\nname: other\ndescription: x\n---\n\nbody\n"),
        ("D10 无 frontmatter", "no frontmatter"),
        ("D11 缺 description", f"---\nname: {PROBE}\n---\n\nbody\n"),
        ("D12 缺 name", "---\ndescription: x\n---\n\nbody\n"),
        ("D13 中文 name（框架会静默跳过）", "---\nname: 技能\ndescription: x\n---\n\nbody\n"),
        ("D14 frontmatter 非法 YAML", f"---\nname: {PROBE}\ndescription: [unclosed\n---\n\nbody\n"),
    ]
    for label, bad in cases:
        code, body = call("PUT", f"/api/panel/skills/{PROBE}/content", json_body={"content": bad})
        check(f"{label} → 422", code == 422, str(code))
        if code == 422:
            problems = body["detail"]["problems"]  # type: ignore[index]
            check(f"{label} 带回 problems", isinstance(problems, list) and len(problems) > 0,
                  str(problems)[:70])

    check("D15 校验失败后磁盘内容未被改动", path.read_text(encoding="utf-8") == edited)

    # 下划线 allowed_tools：应通过，但带 warning
    code, d = call("PUT", f"/api/panel/skills/{PROBE}/content", json_body={
        "content": f"---\nname: {PROBE}\ndescription: ok\nallowed_tools: [read_file]\n---\n\nbody\n"
    })
    check("D16 下划线 allowed_tools 可保存", code == 200, str(code))
    check("D17 但会提示框架只认连字符",
          any("allowed-tools" in w for w in (d.get("warnings") or [])), str(d.get("warnings")))

    # 未知字段：warning 不阻塞
    code, d = call("PUT", f"/api/panel/skills/{PROBE}/content", json_body={
        "content": f"---\nname: {PROBE}\ndescription: ok\nwhatever: 1\n---\n\nbody\n"
    })
    check("D18 未知 frontmatter 字段可保存", code == 200, str(code))
    check("D19 未知字段给出 warning",
          any("whatever" in w for w in (d.get("warnings") or [])), str(d.get("warnings")))

    # 写不存在的技能
    code, _ = call("PUT", "/api/panel/skills/no-such-skill/content",
                   json_body={"content": "x"})
    check("D20 写不存在的技能 → 404", code == 404, str(code))

    # 缺 content 字段
    code, _ = call("PUT", f"/api/panel/skills/{PROBE}/content", json_body={})
    check("D21 缺 content 字段 → 422", code == 422, str(code))

    # 超大内容：用 Content-Length 撑爆面板编辑上限
    big = "---\nname: %s\ndescription: ok\n---\n\n%s" % (PROBE, "x" * (600 * 1024))
    code, _ = call("PUT", f"/api/panel/skills/{PROBE}/content", json_body={"content": big})
    check("D22 超过面板编辑上限 → 422", code == 422, str(code))


# ==========================================================================
# E. 收尾：确认回到基线
# ==========================================================================

def sec_cleanup(base_total: int) -> None:
    print("\n=== E. 收尾与基线 ===")
    if PROBE_DIR.exists():
        shutil.rmtree(PROBE_DIR)
    check("E1 探针技能目录已删除", not PROBE_DIR.exists())

    if BACKUP_DIR.exists():
        shutil.rmtree(BACKUP_DIR)
    check("E1b 探针技能的备份目录已删除", not BACKUP_DIR.exists())

    d = list_skills()
    check("E2 技能数回到基线", d["summary"]["total"] == base_total,
          f"{d['summary']['total']} vs {base_total}")
    check("E3 清单里已无探针技能",
          all(x["name"] != PROBE for x in d["skills"]))
    check("E4 无已关闭技能残留", d["summary"]["disabled"] == 0,
          str(d["summary"]["disabled"]))
    check("E5 无孤儿开关记录", d["summary"]["orphan_disabled"] == [],
          str(d["summary"]["orphan_disabled"]))

    code, caps = call("GET", "/api/capabilities")
    check("E6 capabilities 无残留", caps["disabled_skills"] == [], str(caps["disabled_skills"]))

    code, _ = call("GET", f"/api/panel/skills/{PROBE}/content")
    check("E7 读已删除技能 → 404", code == 404, str(code))


def main() -> int:
    # 前置检查
    try:
        base_total = baseline()
    except Exception as e:  # noqa: BLE001
        print(f"无法连接 chat-ui（{BASE}）：{e}")
        print("请先在 chat-ui 目录运行：python server.py")
        return 2

    # 保证幂等：清掉上一轮可能残留的探针技能与备份（否则备份断言的"第一份"
    # 会是上一批的产物，测试就失去意义了）
    if PROBE_DIR.exists():
        print(f"清理上一轮残留：{PROBE_DIR}")
        shutil.rmtree(PROBE_DIR)
    if BACKUP_DIR.exists():
        print(f"清理上一轮残留：{BACKUP_DIR}")
        shutil.rmtree(BACKUP_DIR)
    PROBE_DIR.mkdir(parents=True, exist_ok=True)
    (PROBE_DIR / "SKILL.md").write_text(PROBE_MD, encoding="utf-8", newline="")
    print(f"基线技能数 {base_total}；已创建临时技能 {PROBE}")

    try:
        sec_list(base_total)
        sec_read()
        sec_toggle(base_total)
        sec_write()
    finally:
        sec_cleanup(base_total)

    print("\n" + "=" * 60)
    print(f"Skill 管理接口测试: {PASS}/{PASS + FAIL} 通过")
    if FAIL:
        print(f"失败 {FAIL} 项")
    print("=" * 60)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
