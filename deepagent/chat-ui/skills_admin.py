"""Agent 控制面板 —— Skill（技能）管理数据层。

框架的技能机制（读源码得出，见 `libs/deepagents/deepagents/middleware/skills.py`）
--------------------------------------------------------------------------
1. `create_deep_agent(skills=[...])` 会在中间件栈里挂一个 `SkillsMiddleware`；
2. `before_agent` 扫描每个来源目录，找出**含 SKILL.md 的子目录**，解析 YAML
   frontmatter，按名字合并（后出现的来源覆盖前面的，即 last-one-wins），
   结果写进 `state["skills_metadata"]`；
3. `modify_request` 把 `skills_metadata` 渲染进系统提示词 —— **只给 name +
   description + 文件路径**（渐进式披露，正文由模型按需 `read_file` 读取）；
4. 框架**没有**「启用 / 关闭」概念：既没有开关字段，也没有过滤钩子，
   只能由调用方在中间件层过滤（见 server.py 的 `SkillsControlMiddleware`）。

本模块的职责边界
----------------
只负责**磁盘侧**：扫描来源目录、解析元数据、按框架规则校验 SKILL.md、读写正文。
开关状态存在 `agent_config.json` 的 `skills` 键里（见 `agent_config.py`），
两者在 `catalog()` 汇合。

⚠️ 校验规则必须与框架**保持同一套判定**。框架对不合规的 SKILL.md 是
「打条 warning 然后**静默跳过**」——如果在面板里保存了一个框架不认的文件，
表现是「保存成功但技能不见了」，极难排查。所以这里把框架的
`_validate_skill_name` / `_parse_skill_metadata` 的规则复刻成前置校验，
并在列表里把**加载不合法**的技能显式标出来（`valid=False`）。
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Sequence

import yaml

# --------------------------------------------------------------------------
# 常量（与框架 middleware/skills.py 对齐）
# --------------------------------------------------------------------------

SKILL_FILENAME = "SKILL.md"

MAX_SKILL_NAME_LENGTH = 64
MAX_SKILL_DESCRIPTION_LENGTH = 1024
MAX_SKILL_COMPATIBILITY_LENGTH = 500
MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024  # 10MB，框架的 DoS 上限

# 面板编辑的额外上限：比框架宽松（框架只警告超大文件），但别让一个
# 几百 KB 的 SKILL.md 通过 HTTP 塞进 textarea。超过就存不了。
MAX_EDITABLE_BYTES = 512 * 1024

# 备份保留数量（每个技能最多留这么多份历史 SKILL.md）
MAX_BACKUPS_PER_SKILL = 20

# 与框架 `^\---\s*\n(.*?)\n---\s*\n` 一致
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

# 框架认的 frontmatter 字段（其余字段被忽略，不报错）
KNOWN_FRONTMATTER_KEYS = {
    "name",
    "description",
    "allowed-tools",
    "metadata",
    "license",
    "compatibility",
}


class SkillError(Exception):
    """技能操作的基类错误。"""


class SkillNotFound(SkillError):
    """技能不存在（名字拼错，或目录已从磁盘移除）。"""


class SkillValidationError(SkillError):
    """SKILL.md 内容不合法，拒绝保存。

    `.problems` 是逐条的原因，供前端直接展示。
    """

    def __init__(self, problems: Sequence[str]):
        self.problems = list(problems)
        super().__init__("；".join(self.problems))


@dataclass(frozen=True)
class SkillSource:
    """一个技能来源目录。

    Attributes:
        label: 面板 / 系统提示词里展示的名字（如 `Built-in`、`Chat UI`）。
        virtual_path: 该目录在 agent 文件系统里的虚拟路径（如
            `/chat-ui/skills`）。模型用 `read_file` 读 SKILL.md 时走的就是它。
        real_dir: 对应的真实磁盘目录。
    """

    label: str
    virtual_path: str
    real_dir: Path


# --------------------------------------------------------------------------
# frontmatter 解析 / 校验
# --------------------------------------------------------------------------

def parse_frontmatter(text: str) -> dict | None:
    """按框架的方式解析 frontmatter；失败返回 ``None``。

    与框架 `_parse_skill_metadata` 用同一个 `yaml.safe_load`，避免两边对
    「什么算合法」的判断不一致。
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return None
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return None
    return data if isinstance(data, dict) else None


def _name_shape_error(name: str) -> str | None:
    """复刻框架 `_validate_skill_name` 的**形状**规则（不含目录名比对）。"""
    if not name:
        return "name 不能为空"
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return f"name 超过 {MAX_SKILL_NAME_LENGTH} 字符"
    if name.startswith("-") or name.endswith("-") or "--" in name:
        return "name 只能是小写字母 / 数字 + 单个连字符，且不能以连字符开头或结尾"
    for c in name:
        if c == "-":
            continue
        # 框架用的就是 isalpha() and islower()，所以带重音的拉丁字母也算合法
        if (c.isalpha() and c.islower()) or c.isdigit():
            continue
        return "name 只能是小写字母 / 数字 + 单个连字符（中文名会被框架静默跳过）"
    return None


def _parse_allowed_tools(raw: object) -> list[str]:
    """复刻框架 `_parse_allowed_tools`：接受空格 / 逗号分隔的字符串或 YAML 列表。"""
    if isinstance(raw, str):
        return [t for t in re.split(r"[\s,]+", raw) if t]
    if isinstance(raw, list):
        return [t.strip() for t in raw if isinstance(t, str) and t.strip()]
    return []


def validate_skill_md(text: str, expected_name: str) -> tuple[list[str], list[str]]:
    """校验即将保存的 SKILL.md 内容。

    Returns:
        `(problems, warnings)` —— ``problems`` 非空时**拒绝保存**（框架会跳过
        这个技能）；``warnings`` 只是提醒，不阻塞保存。

    Raises:
        无。所有问题都以返回值表达。
    """
    problems: list[str] = []
    warnings: list[str] = []

    blob = text.encode("utf-8")
    if len(blob) > MAX_SKILL_FILE_SIZE:
        return [f"文件超过框架上限 {MAX_SKILL_FILE_SIZE // (1024 * 1024)}MB"], warnings
    if len(blob) > MAX_EDITABLE_BYTES:
        return [
            f"文件超过面板编辑上限 {MAX_EDITABLE_BYTES // 1024}KB"
            "（框架仍能加载，但请用编辑器直接改磁盘文件）"
        ], warnings

    match = _FRONTMATTER_RE.match(text)
    if not match:
        return [
            "SKILL.md 必须以 YAML frontmatter 开头："
            "第一行是 `---`，字段写在 `---` 之间，再用一行 `---` 结束"
        ], warnings

    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        return [f"frontmatter 不是合法的 YAML：{e}"], warnings
    if not isinstance(data, dict):
        return ["frontmatter 必须是「字段: 值」的映射"], warnings

    name = str(data.get("name", "") or "").strip()
    description = str(data.get("description", "") or "").strip()

    if not name:
        problems.append("frontmatter 缺少必填字段 `name`")
    if not description:
        problems.append("frontmatter 缺少必填字段 `description`")
    if name:
        shape = _name_shape_error(name)
        if shape:
            problems.append(f"`name` 不合法：{shape}")
        elif name != expected_name:
            problems.append(
                f"`name` 必须等于技能目录名「{expected_name}」（当前是「{name}」）—— "
                "不一致会导致框架静默跳过该技能"
            )
    if len(description) > MAX_SKILL_DESCRIPTION_LENGTH:
        problems.append(
            f"`description` 超过 {MAX_SKILL_DESCRIPTION_LENGTH} 字符"
            f"（当前 {len(description)}）—— 超长部分会被框架截断，"
            "而 description 是技能唯一的触发依据，请精简"
        )

    # 高频踩坑：框架用 `frontmatter.get("allowed-tools")` 解析，写成下划线
    # 会被**静默忽略**（工具声明不生效、也不报错），所以这里主动提醒。
    if "allowed_tools" in data:
        warnings.append(
            "检测到 `allowed_tools`（下划线）：框架只认连字符写法 `allowed-tools`，"
            "下划线会被静默忽略"
        )

    compat = data.get("compatibility")
    if compat is not None and len(str(compat)) > MAX_SKILL_COMPATIBILITY_LENGTH:
        warnings.append(
            f"`compatibility` 超过 {MAX_SKILL_COMPATIBILITY_LENGTH} 字符，超长部分会被截断"
        )
    if isinstance(compat, (list, dict)):
        warnings.append("`compatibility` 是纯文本字段，写成列表 / 映射会原样显示成 \"[]\" / \"{}\"")

    unknown = sorted(set(data) - KNOWN_FRONTMATTER_KEYS)
    if unknown:
        warnings.append(
            f"以下 frontmatter 字段框架不识别，会被忽略：{', '.join(f'`{k}`' for k in unknown)}"
        )

    body = text[match.end():]
    if not body.strip():
        warnings.append("frontmatter 之后没有正文：技能被触发后模型读不到任何指令")

    return problems, warnings


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------

def _entry_from_dir(
    real_dir: Path,
    skill_md: Path,
    source: SkillSource,
) -> dict:
    """把一个技能目录读成一个条目（不抛错；读不出来就标记 invalid）。"""
    name = real_dir.name
    warnings: list[str] = []
    problems: list[str] = []

    try:
        text = skill_md.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        text = ""
        problems.append(f"SKILL.md 不是合法的 UTF-8：{e}")
    except OSError as e:
        text = ""
        problems.append(f"SKILL.md 无法读取：{e}")

    data = parse_frontmatter(text) if text else None
    if text and data is None:
        problems.append("frontmatter 缺失或不是合法 YAML —— 框架会**静默跳过**这个技能")

    description = ""
    allowed_tools: list[str] = []
    compatibility: str | None = None
    license_: str | None = None

    if data is not None:
        description = str(data.get("description", "") or "").strip()
        fm_name = str(data.get("name", "") or "").strip()
        if not fm_name:
            problems.append("frontmatter 缺少必填字段 `name`")
        elif fm_name != name:
            problems.append(
                f"`name`（{fm_name}）与目录名（{name}）不一致 —— 框架会静默跳过"
            )
        else:
            shape = _name_shape_error(fm_name)
            if shape:
                problems.append(f"`name` 不合法：{shape}")
        if not description:
            problems.append("frontmatter 缺少必填字段 `description` —— 框架会静默跳过")
        if len(description) > MAX_SKILL_DESCRIPTION_LENGTH:
            warnings.append(
                f"`description` 超过 {MAX_SKILL_DESCRIPTION_LENGTH} 字符，超出部分被截断"
            )
        if "allowed_tools" in data:
            warnings.append("存在 `allowed_tools`（下划线）：框架只认 `allowed-tools`，此项被忽略")
        allowed_tools = _parse_allowed_tools(data.get("allowed-tools"))
        raw_compat = data.get("compatibility")
        if raw_compat is not None:
            compatibility = str(raw_compat).strip() or None
        raw_license = data.get("license")
        if raw_license is not None:
            license_ = str(raw_license).strip() or None

    try:
        stat = skill_md.stat()
    except OSError:
        stat = None

    # 虚拟路径：模型 `read_file` 用的就是这个路径，面板展示它便于对账
    virtual_dir = source.virtual_path.rstrip("/")
    rel = skill_md.relative_to(real_dir)
    virtual_path = f"{virtual_dir}/{name}/{rel.as_posix()}".replace("//", "/")

    # 技能目录里的附属文件（scripts/、references/ 等），只做数量提示
    extras = 0
    try:
        for child in real_dir.rglob("*"):
            if child.is_file() and child.name != SKILL_FILENAME:
                extras += 1
    except OSError:
        pass

    return {
        "name": name,
        "description": description,
        "source": source.label,
        "source_path": source.virtual_path,
        "path": str(skill_md),
        "virtual_path": virtual_path,
        "real_dir": str(real_dir),
        "valid": not problems,
        "problems": problems,
        "warnings": warnings,
        "size": stat.st_size if stat else 0,
        "mtime": (
            datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
            if stat
            else None
        ),
        "lines": text.count("\n") + 1 if text else 0,
        "chars": len(text),
        "allowed_tools": allowed_tools,
        "compatibility": compatibility,
        "license": license_,
        "extra_files": extras,
        # 内置技能来自框架源码目录，改了会在框架升级 / 重新安装时被覆盖
        "builtin": source.label.strip().lower() == "built-in",
    }


def discover(sources: Sequence[SkillSource]) -> list[dict]:
    """扫描全部技能来源，返回技能条目。

    同名技能由**靠后的来源覆盖**（与框架 last-one-wins 一致），且保留首次
    出现的位置，这样面板里的排序是稳定的。
    """
    order: dict[str, int] = {}
    items: list[dict] = []

    for source in sources:
        real_dir = source.real_dir
        try:
            if not real_dir.is_dir():
                continue
            children = sorted(real_dir.iterdir())
        except OSError:
            continue
        for child in children:
            try:
                if not child.is_dir():
                    continue
            except OSError:
                continue
            skill_md = child / SKILL_FILENAME
            try:
                if not skill_md.is_file():
                    continue
            except OSError:
                continue
            entry = _entry_from_dir(child, skill_md, source)
            if child.name in order:
                items[order[child.name]] = entry
            else:
                order[child.name] = len(items)
                items.append(entry)

    return items


def catalog(sources: Sequence[SkillSource], enabled_map: dict[str, bool] | None = None) -> dict:
    """面板用视图：技能清单 + 汇总（合并开关状态）。

    Args:
        sources: 技能来源目录。
        enabled_map: `{name: enabled}`，只包含被显式设置过的技能；缺省按开启。
    """
    enabled_map = enabled_map or {}
    items = discover(sources)
    for it in items:
        it["enabled"] = bool(enabled_map.get(it["name"], True))

    by_source: dict[str, dict] = {}
    for it in items:
        slot = by_source.setdefault(
            it["source"], {"label": it["source"], "path": it["source_path"], "count": 0}
        )
        slot["count"] += 1

    return {
        "skills": items,
        "summary": {
            "total": len(items),
            "enabled": sum(1 for it in items if it["enabled"]),
            "disabled": sum(1 for it in items if not it["enabled"]),
            "invalid": sum(1 for it in items if not it["valid"]),
            "builtin": sum(1 for it in items if it["builtin"]),
            "sources": list(by_source.values()),
            # 配置里关掉、但磁盘上已经没有同名技能 → 孤儿记录，提示用户可清理
            "orphan_disabled": sorted(set(enabled_map) - {it["name"] for it in items}),
        },
    }


def find(name: str, sources: Sequence[SkillSource]) -> dict:
    """按名字取一个技能；不存在则抛 `SkillNotFound`。

    ⚠️ 查找只走扫盘结果，**从不把 name 拼进路径**，所以 URL 里带
    `../` 之类的名字不可能读到目录外的文件。
    """
    for it in discover(sources):
        if it["name"] == name:
            return it
    raise SkillNotFound(f"技能「{name}」不存在")


# --------------------------------------------------------------------------
# 正文读写
# --------------------------------------------------------------------------

def _backup_dir(base: Path, name: str) -> Path:
    return base / name


def read_content(name: str, sources: Sequence[SkillSource]) -> dict:
    """读取技能的 SKILL.md 原文。"""
    entry = find(name, sources)
    path = Path(entry["path"])
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        raise SkillValidationError([f"SKILL.md 不是合法的 UTF-8：{e}"]) from e
    except OSError as e:
        raise SkillValidationError([f"SKILL.md 无法读取：{e}"]) from e
    return {**entry, "content": text}


def _prune_backups(backup_root: Path, name: str) -> None:
    """每个技能只保留最近 N 份备份。"""
    folder = _backup_dir(backup_root, name)
    try:
        files = sorted(folder.glob("*.bak"), key=lambda p: p.name)
    except OSError:
        return
    for old in files[:-MAX_BACKUPS_PER_SKILL]:
        try:
            old.unlink()
        except OSError:
            pass


def write_content(
    name: str,
    text: str,
    sources: Sequence[SkillSource],
    backup_root: Path,
) -> dict:
    """保存技能正文（先校验 → 备份 → 原子写）。

    Raises:
        SkillNotFound: 技能不存在。
        SkillValidationError: 内容不合法（框架会跳过），或写入失败。
    """
    entry = find(name, sources)
    path = Path(entry["path"])

    if not isinstance(text, str):
        raise SkillValidationError(["content 必须是字符串"])
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    problems, warnings = validate_skill_md(text, entry["name"])
    if problems:
        raise SkillValidationError(problems)

    # 备份旧文件：同目录写 `.tmp` 再 os.replace，避免写一半崩溃留下半个文件
    try:
        if path.is_file():
            folder = _backup_dir(backup_root, name)
            folder.mkdir(parents=True, exist_ok=True)
            # 带微秒：同一秒内连续保存（脚本化改技能）不会互相覆盖，
            # 否则「保留最近 N 份」会退化成「只留最后 1 份」
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            shutil.copy2(path, folder / f"SKILL.md.{stamp}.bak")
            _prune_backups(backup_root, name)
    except OSError:
        # 备份失败不阻塞保存（备份是便利功能，不是安全边界）
        warnings = warnings + ["旧文件备份失败，本次未生成历史副本"]

    tmp = path.with_name(path.name + ".tmp")
    try:
        # newline="" 保持原样写，不额外做换行转换
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.replace(tmp, path)
    except OSError as e:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise SkillValidationError([f"写入失败：{e}"]) from e

    saved = read_content(name, sources)
    saved["warnings"] = warnings
    # 返回**根**目录（不是每个技能的子目录）——与读接口的 backup_dir 保持同一个语义，
    # 否则调用方拿到两个不同的路径会各自拼错一级
    saved["backup_dir"] = str(backup_root)
    return saved
