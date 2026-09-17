"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./Sidebar";
import Modal from "./Modal";
import { usePermission } from "@/hooks/usePermission";
import type {
  PanelConfig,
  PanelMcp,
  PanelMcpConfig,
  PanelMcpsResponse,
  PanelModelCheck,
  PanelOverview,
  PanelSkill,
  PanelSkillContent,
  PanelSkillsResponse,
  PanelTool,
  ToolPolicy,
} from "@/types/agent";

/* ============================ 设计变量 ============================ */

const PRIMARY = "#2563EB";
const BORDER = "#E2E8F0";
const TEXT = "#0F172A";
const MUTED = "#64748B";
const SUBTLE = "#94A3B8";

const CARD: React.CSSProperties = {
  background: "#fff",
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
};

/** 三档权限的展示元数据 */
const POLICY_META: Record<
  ToolPolicy,
  { label: string; color: string; bg: string; border: string; desc: string }
> = {
  allow: {
    label: "直接使用",
    color: "#059669",
    bg: "#ECFDF5",
    border: "#A7F3D0",
    desc: "调用后立即执行，无需人工确认",
  },
  approval: {
    label: "人工审批",
    color: "#B45309",
    bg: "#FFFBEB",
    border: "#FDE68A",
    desc: "调用前弹出审批卡片，人工确认后才执行",
  },
  deny: {
    label: "禁止",
    color: "#DC2626",
    bg: "#FEF2F2",
    border: "#FECACA",
    desc: "禁止调用，一旦调用立即被拦截并提示",
  },
};

/* ============================ 小组件 ============================ */

function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return <div style={{ ...CARD, ...style }}>{children}</div>;
}

/** 开关 */
function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={`tool-switch`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 999,
        border: "none",
        padding: 0,
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        background: checked ? PRIMARY : "#CBD5E1",
        opacity: disabled ? 0.55 : 1,
        transition: "background 0.15s ease",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(15,23,42,0.25)",
          transition: "left 0.15s ease",
        }}
      />
    </button>
  );
}

/** 三档权限选择器 */
function PolicySegmented({
  value,
  onChange,
  disabled,
}: {
  value: ToolPolicy;
  onChange: (v: ToolPolicy) => void;
  disabled?: boolean;
}) {
  const order: ToolPolicy[] = ["allow", "approval", "deny"];
  return (
    <div
      style={{
        display: "inline-flex",
        border: `1px solid ${BORDER}`,
        borderRadius: 9,
        overflow: "hidden",
        background: "#F8FAFC",
        flexShrink: 0,
      }}
    >
      {order.map((p) => {
        const meta = POLICY_META[p];
        const active = value === p;
        return (
          <button
            key={p}
            type="button"
            data-testid={`policy-${p}`}
            disabled={disabled}
            onClick={() => onChange(p)}
            style={{
              padding: "6px 12px",
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: "inherit",
              border: "none",
              cursor: disabled ? "not-allowed" : "pointer",
              background: active ? meta.bg : "transparent",
              color: active ? meta.color : MUTED,
              boxShadow: active ? `inset 0 0 0 1px ${meta.border}` : "none",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

/** 概览指标卡 */
function StatCard({
  label,
  value,
  unit,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  const toneColor =
    tone === "ok" ? "#059669" : tone === "warn" ? "#B45309" : tone === "bad" ? "#DC2626" : TEXT;
  return (
    <Card style={{ padding: "16px 18px" }}>
      <div style={{ fontSize: 12.5, color: MUTED, fontWeight: 500, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span
          data-testid={`stat-${label}`}
          style={{ fontSize: 24, fontWeight: 700, color: toneColor, letterSpacing: "-0.02em" }}
        >
          {value}
        </span>
        {unit ? <span style={{ fontSize: 12.5, color: SUBTLE, fontWeight: 600 }}>{unit}</span> : null}
      </div>
      {sub ? <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 6 }}>{sub}</div> : null}
    </Card>
  );
}

function Tag({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: "gray" | "blue" | "green" | "amber" | "red";
}) {
  const map = {
    gray: { bg: "#F1F5F9", color: "#475569" },
    blue: { bg: "#EFF6FF", color: "#2563EB" },
    green: { bg: "#ECFDF5", color: "#059669" },
    amber: { bg: "#FFFBEB", color: "#B45309" },
    red: { bg: "#FEF2F2", color: "#DC2626" },
  } as const;
  const c = map[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 6,
        fontSize: 11.5,
        fontWeight: 600,
        background: c.bg,
        color: c.color,
      }}
    >
      {children}
    </span>
  );
}

function tabButton(active: boolean): React.CSSProperties {
  return {
    padding: "9px 18px",
    borderRadius: 10,
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
    border: active ? "none" : `1px solid ${BORDER}`,
    background: active ? PRIMARY : "#fff",
    color: active ? "#fff" : MUTED,
    transition: "all 0.15s ease",
  };
}

function fmtNum(n: number): string {
  return (n ?? 0).toLocaleString("zh-CN");
}

/** 耗时格式化：自动在 毫秒 / 秒 之间切换（单位与数值匹配，避免「3.92 ms」这类误导） */
function fmtLatency(ms: number): { value: string; unit: string } {
  const v = ms ?? 0;
  if (v >= 1000) return { value: (v / 1000).toFixed(2), unit: "s" };
  if (v >= 10) return { value: Math.round(v).toString(), unit: "ms" };
  return { value: v.toFixed(1), unit: "ms" };
}

/** 文件大小：字节数不大时直接用 B，避免满屏 0.0 KB */
function fmtBytes(n: number): string {
  const v = n ?? 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

/** ISO 时间 → `MM-DD HH:mm`（面板里都是近期文件，年份是噪音） */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace("T", " ").slice(0, 16);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 技能来源标签的配色：内置的用琥珀色（改动会被框架升级覆盖），其余按项目内/外分色 */
const SOURCE_TONE: Record<string, "gray" | "blue" | "green" | "amber" | "red"> = {
  "Built-in": "amber",
  "Chat UI": "blue",
  "Project Deepagents": "green",
  "Project Agents": "green",
  "Project Claude": "green",
};

/* ============================ 主体 ============================ */

export default function AgentPanelDashboard() {
  const perm = usePermission("agent");

  const [tab, setTab] = useState<"overview" | "config" | "skills" | "mcp">("overview");
  const [subTab, setSubTab] = useState<"prompt" | "tools" | "policy">("prompt");

  // ---- Skill 管理 ----
  const [skillsData, setSkillsData] = useState<PanelSkillsResponse | null>(null);
  const [busySkill, setBusySkill] = useState<string | null>(null);
  /** 正在编辑的技能（null = 弹窗关闭）；只带定位信息，正文另拉 */
  const [skillEdit, setSkillEdit] = useState<PanelSkill | null>(null);
  const [skillContent, setSkillContent] = useState<PanelSkillContent | null>(null);
  const [skillDraft, setSkillDraft] = useState("");
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  /** 保存被拒时的逐条原因（服务端 422 返回的 problems） */
  const [skillProblems, setSkillProblems] = useState<string[]>([]);
  const [skillWarnings, setSkillWarnings] = useState<string[]>([]);

  // ---- MCP 管理 ----
  const [mcpsData, setMcpsData] = useState<PanelMcpsResponse | null>(null);
  const [busyMcp, setBusyMcp] = useState<string | null>(null);
  /** 正在编辑的 MCP（null = 弹窗关闭）；只带定位信息，配置原文另拉 */
  const [mcpEdit, setMcpEdit] = useState<PanelMcp | null>(null);
  const [mcpConfigSaved, setMcpConfigSaved] = useState("");
  const [mcpConfigDraft, setMcpConfigDraft] = useState("");
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpProblems, setMcpProblems] = useState<string[]>([]);
  const [resettingMcp, setResettingMcp] = useState(false);

  // ---- MCP 新增 ----
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  const [mcpAddName, setMcpAddName] = useState("");
  const [mcpAddDesc, setMcpAddDesc] = useState("");
  const [mcpAddJson, setMcpAddJson] = useState("");
  const [mcpAddProblems, setMcpAddProblems] = useState<string[]>([]);
  const [mcpAddSaving, setMcpAddSaving] = useState(false);

  // ---- MCP 删除 ----
  const [mcpDelete, setMcpDelete] = useState<PanelMcp | null>(null);
  const [mcpDeleting, setMcpDeleting] = useState(false);

  const [overview, setOverview] = useState<PanelOverview | null>(null);
  const [config, setConfig] = useState<PanelConfig | null>(null);
  const [modelCheck, setModelCheck] = useState<PanelModelCheck | null>(null);
  const [checkingModel, setCheckingModel] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const [promptDraft, setPromptDraft] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  /* ---------------- 数据加载 ---------------- */

  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/agent/panel/overview", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setOverview((await res.json()) as PanelOverview);
      setError("");
    } catch {
      setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/panel/config", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as PanelConfig;
      setConfig(data);
      setPromptDraft(data.system_prompt);
      setPromptDirty(false);
    } catch {
      setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
    }
  }, []);

  const runModelCheck = useCallback(
    async (force = false) => {
      setCheckingModel(true);
      try {
        const res = await fetch(`/api/agent/panel/model-check${force ? "?force=true" : ""}`, {
          method: "POST",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PanelModelCheck;
        setModelCheck(data);
        if (data.ok) flash(`模型连通正常，往返 ${Math.round(data.latency_ms)} ms`);
        else flash("模型连通性检测失败");
      } catch {
        flash("模型连通性检测失败");
      } finally {
        setCheckingModel(false);
      }
    },
    [flash]
  );

  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/panel/skills", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setSkillsData((await res.json()) as PanelSkillsResponse);
      setError("");
    } catch {
      setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
    }
  }, []);

  const loadMcps = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/panel/mcps", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setMcpsData((await res.json()) as PanelMcpsResponse);
      setError("");
    } catch {
      setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
    }
  }, []);

  useEffect(() => {
    loadOverview();
    loadConfig();
    loadSkills();
    loadMcps();
    // 首次进入即做一次模型连通性探测（服务端有 20s 缓存，不会重复打模型）
    runModelCheck(false);
  }, [loadOverview, loadConfig, loadSkills, loadMcps, runModelCheck]);

  /* ---------------- 配置操作 ---------------- */

  const savePrompt = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/agent/panel/system-prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: promptDraft }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || String(res.status));
      }
      const data = (await res.json()) as PanelConfig;
      setConfig(data);
      setPromptDraft(data.system_prompt);
      setPromptDirty(false);
      flash("系统提示词已保存，下一轮对话生效");
    } catch (e) {
      flash(e instanceof Error ? `保存失败：${e.message}` : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [promptDraft, flash]);

  const resetPrompt = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/agent/panel/system-prompt/reset", { method: "POST" });
      const data = (await res.json()) as PanelConfig;
      setConfig(data);
      setPromptDraft(data.system_prompt);
      setPromptDirty(false);
      flash("已恢复默认系统提示词");
    } catch {
      flash("恢复失败");
    } finally {
      setSaving(false);
    }
  }, [flash]);

  const applyTool = useCallback(
    async (name: string, patch: { enabled?: boolean; policy?: ToolPolicy }) => {
      setBusyTool(name);
      try {
        let res: Response;
        if (patch.policy !== undefined) {
          res = await fetch(`/api/agent/panel/tools/${name}/policy`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ policy: patch.policy }),
          });
        } else {
          res = await fetch(`/api/agent/panel/tools/${name}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: patch.enabled }),
          });
        }
        if (!res.ok) throw new Error(String(res.status));
        // 局部更新本地状态，避免整页刷新
        setConfig((prev) =>
          prev
            ? {
                ...prev,
                tools: prev.tools.map((t) =>
                  t.name === name
                    ? {
                        ...t,
                        enabled: patch.enabled !== undefined ? patch.enabled : t.enabled,
                        policy: patch.policy !== undefined ? patch.policy : t.policy,
                        policy_label:
                          patch.policy !== undefined ? POLICY_META[patch.policy].label : t.policy_label,
                      }
                    : t
                ),
              }
            : prev
        );
        const body = await res.json().catch(() => null);
        if (body?.summary) {
          setConfig((prev) => (prev ? { ...prev, summary: body.summary } : prev));
        }
        flash(
          patch.policy !== undefined
            ? `${name} 权限已设为「${POLICY_META[patch.policy].label}」`
            : `${name} 已${patch.enabled ? "开启" : "关闭"}`
        );
      } catch {
        flash("操作失败，请重试");
        loadConfig();
      } finally {
        setBusyTool(null);
      }
    },
    [flash, loadConfig]
  );

  const resetAll = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/agent/panel/reset", { method: "POST" });
      const data = (await res.json()) as PanelConfig;
      setConfig(data);
      setPromptDraft(data.system_prompt);
      setPromptDirty(false);
      flash("已恢复全部默认配置");
      loadOverview(true);
    } catch {
      flash("恢复失败");
    } finally {
      setSaving(false);
    }
  }, [flash, loadOverview]);

  /* ---------------- Skill 管理操作 ---------------- */

  const toggleSkill = useCallback(
    async (name: string, enabled: boolean) => {
      setBusySkill(name);
      try {
        const res = await fetch(`/api/agent/panel/skills/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json().catch(() => null);
        // 局部更新，避免整页重拉（技能清单是扫盘来的，重拉会闪一下）
        setSkillsData((prev) =>
          prev
            ? {
                ...prev,
                skills: prev.skills.map((s) => (s.name === name ? { ...s, enabled } : s)),
                summary: body?.summary ?? prev.summary,
              }
            : prev
        );
        flash(`技能「${name}」已${enabled ? "开启" : "关闭"}，下一轮对话生效`);
      } catch {
        flash("操作失败，请重试");
        loadSkills();
      } finally {
        setBusySkill(null);
      }
    },
    [flash, loadSkills]
  );

  const openSkillEditor = useCallback(
    async (skill: PanelSkill) => {
      setSkillEdit(skill);
      setSkillContent(null);
      setSkillDraft("");
      setSkillProblems([]);
      setSkillWarnings([]);
      setSkillLoading(true);
      try {
        const res = await fetch(
          `/api/agent/panel/skills/${encodeURIComponent(skill.name)}/content`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PanelSkillContent;
        setSkillContent(data);
        setSkillDraft(data.content);
        setSkillWarnings(data.warnings ?? []);
      } catch {
        flash("读取 SKILL.md 失败");
        setSkillEdit(null);
      } finally {
        setSkillLoading(false);
      }
    },
    [flash]
  );

  const saveSkillContent = useCallback(async () => {
    if (!skillEdit) return;
    setSkillSaving(true);
    setSkillProblems([]);
    try {
      const res = await fetch(
        `/api/agent/panel/skills/${encodeURIComponent(skillEdit.name)}/content`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: skillDraft }),
        }
      );
      if (res.status === 422) {
        const e = await res.json().catch(() => null);
        const detail = e?.detail;
        setSkillProblems(
          Array.isArray(detail?.problems) ? detail.problems : [detail?.message || "内容不合法"]
        );
        flash("保存被拒绝：请按提示修正 SKILL.md");
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      const body = await res.json().catch(() => null);
      setSkillWarnings(body?.warnings ?? []);
      setSkillContent((prev) => (prev ? { ...prev, content: skillDraft } : prev));
      // 列表里的简介/大小/校验状态都可能变了 —— 用服务端返回的最新条目替换
      if (body?.skill) {
        const fresh = body.skill as PanelSkill;
        setSkillsData((prev) =>
          prev
            ? {
                ...prev,
                skills: prev.skills.map((s) => (s.name === fresh.name ? fresh : s)),
                summary: body.summary ?? prev.summary,
              }
            : prev
        );
      }
      flash(`SKILL.md 已保存（旧版本已备份），下一轮对话生效`);
    } catch (e) {
      flash(e instanceof Error ? `保存失败：${e.message}` : "保存失败");
    } finally {
      setSkillSaving(false);
    }
  }, [skillEdit, skillDraft, flash]);

  /* ---------------- MCP 管理操作 ---------------- */

  const setMcpEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      setBusyMcp(name);
      try {
        const res = await fetch(`/api/agent/panel/mcps/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
        }
        const body = await res.json().catch(() => null);
        // 以服务端返回的最新条目整体替换（开启可能失败，enabled / load_error / tools 都以服务端为准）
        if (body?.mcp) {
          const fresh = body.mcp as PanelMcp;
          setMcpsData((prev) =>
            prev
              ? {
                  ...prev,
                  mcps: prev.mcps.map((m) => (m.name === name ? fresh : m)),
                  summary: body.summary ?? prev.summary,
                }
              : prev
          );
        }
        if (enabled && body?.load_error) {
          flash(`启用失败：${body.load_error}`);
        } else {
          flash(`MCP「${name}」已${enabled ? "启用" : "关闭"}，下一轮对话生效`);
        }
      } catch (e) {
        flash(e instanceof Error ? `操作失败：${e.message}` : "操作失败，请重试");
        loadMcps();
      } finally {
        setBusyMcp(null);
      }
    },
    [flash, loadMcps]
  );

  const openMcpEditor = useCallback(
    async (mcp: PanelMcp) => {
      setMcpEdit(mcp);
      setMcpConfigSaved("");
      setMcpConfigDraft("");
      setMcpProblems([]);
      setMcpLoading(true);
      try {
        const res = await fetch(
          `/api/agent/panel/mcps/${encodeURIComponent(mcp.name)}/config`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PanelMcpConfig;
        setMcpConfigSaved(data.config);
        setMcpConfigDraft(data.config);
      } catch {
        flash("读取 MCP 配置失败");
        setMcpEdit(null);
      } finally {
        setMcpLoading(false);
      }
    },
    [flash]
  );

  const saveMcpConfig = useCallback(async () => {
    if (!mcpEdit) return;
    setMcpSaving(true);
    setMcpProblems([]);
    try {
      const res = await fetch(
        `/api/agent/panel/mcps/${encodeURIComponent(mcpEdit.name)}/config`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: mcpConfigDraft }),
        }
      );
      if (res.status === 422) {
        const e = await res.json().catch(() => null);
        const detail = e?.detail;
        setMcpProblems(
          Array.isArray(detail?.problems) ? detail.problems : [detail?.message || "配置不合法"]
        );
        flash("保存被拒绝：请按提示修正配置");
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      const body = await res.json().catch(() => null);
      setMcpConfigSaved(mcpConfigDraft);
      if (body?.mcp) {
        const fresh = body.mcp as PanelMcp;
        setMcpsData((prev) =>
          prev
            ? {
                ...prev,
                mcps: prev.mcps.map((m) => (m.name === fresh.name ? fresh : m)),
                summary: body.summary ?? prev.summary,
              }
            : prev
        );
      }
      flash("MCP 已保存并自动关闭，点击「初始启用」重新检查后生效");
    } catch (e) {
      flash(e instanceof Error ? `保存失败：${e.message}` : "保存失败");
    } finally {
      setMcpSaving(false);
    }
  }, [mcpEdit, mcpConfigDraft, flash]);

  const resetMcp = useCallback(async () => {
    setResettingMcp(true);
    try {
      const res = await fetch("/api/agent/panel/mcps/reset", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      setMcpsData((await res.json()) as PanelMcpsResponse);
      flash("已恢复全部 MCP 默认配置");
    } catch {
      flash("恢复失败");
    } finally {
      setResettingMcp(false);
    }
  }, [flash]);

  const submitAddMcp = useCallback(async () => {
    setMcpAddSaving(true);
    setMcpAddProblems([]);
    try {
      const res = await fetch("/api/agent/panel/mcps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: mcpAddName, description: mcpAddDesc, config: mcpAddJson }),
      });
      if (res.status === 422 || res.status === 409) {
        const e = await res.json().catch(() => null);
        const detail = e?.detail;
        setMcpAddProblems(
          Array.isArray(detail?.problems)
            ? detail.problems
            : [typeof detail === "string" ? detail : detail?.message || "内容不合法"]
        );
        flash(res.status === 409 ? "添加失败：名称已存在" : "添加被拒绝：请按提示修正");
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      const body = await res.json().catch(() => null);
      setMcpsData((prev) =>
        prev
          ? {
              ...prev,
              mcps: body?.mcp
                ? [...prev.mcps.filter((m) => m.name !== body.mcp.name), body.mcp]
                : prev.mcps,
              summary: body?.summary ?? prev.summary,
            }
          : prev
      );
      setMcpAddOpen(false);
      setMcpAddName("");
      setMcpAddDesc("");
      setMcpAddJson("");
      flash("MCP 已添加（默认关闭），点击「初始启用」生效");
    } catch (e) {
      flash(e instanceof Error ? `添加失败：${e.message}` : "添加失败");
    } finally {
      setMcpAddSaving(false);
    }
  }, [mcpAddName, mcpAddDesc, mcpAddJson, flash]);

  const submitDeleteMcp = useCallback(async () => {
    if (!mcpDelete) return;
    setMcpDeleting(true);
    try {
      const res = await fetch(`/api/agent/panel/mcps/${encodeURIComponent(mcpDelete.name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      const body = (await res.json().catch(() => null)) as PanelMcpsResponse | null;
      if (body) setMcpsData(body);
      flash(`MCP「${mcpDelete.name}」已删除并关闭`);
      setMcpDelete(null);
    } catch (e) {
      flash(e instanceof Error ? `删除失败：${e.message}` : "删除失败");
    } finally {
      setMcpDeleting(false);
    }
  }, [mcpDelete, flash]);

  /* ---------------- 派生数据 ---------------- */

  const grouped = useMemo(() => {
    if (!config) return [] as { category: string; items: PanelTool[] }[];
    const order = config.categories || [];
    const map = new Map<string, PanelTool[]>();
    for (const t of config.tools) {
      if (!map.has(t.category)) map.set(t.category, []);
      map.get(t.category)!.push(t);
    }
    return Array.from(map.entries())
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([category, items]) => ({ category, items }));
  }, [config]);

  const policyCounts = useMemo(() => {
    const c: Record<ToolPolicy, number> = { allow: 0, approval: 0, deny: 0 };
    for (const t of config?.tools ?? []) c[t.policy] = (c[t.policy] ?? 0) + 1;
    return c;
  }, [config]);

  const disabledCount = config?.tools.filter((t) => !t.enabled).length ?? 0;

  const healthOk = overview?.health.status === "healthy";
  const modelOk = modelCheck?.ok ?? overview?.model.connected ?? null;

  /* ---------------- 无权限 ---------------- */

  if (!perm.canViewPage) {
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar activeItem="agent" />
        <main style={{ flex: 1, padding: 32 }}>
          <Card style={{ padding: 40, textAlign: "center", color: MUTED }}>
            没有访问权限，请联系管理员为当前角色开通「Agent 控制面板」。
          </Card>
        </main>
      </div>
    );
  }

  /* ---------------- 渲染 ---------------- */

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="agent" />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          padding: "28px 32px",
          overflowY: "auto",
          height: "100vh",
          background: "#F8FAFC",
        }}
      >
        {/* 页头 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20,
            gap: 16,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: "#0F172A",
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Agent 控制面板
            </h1>
            <p style={{ fontSize: 13, color: MUTED, marginTop: 4, margin: 0 }}>
              查看 Agent 运行状态与能力，并配置系统提示词、可用工具、工具权限与技能
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                loadOverview();
                loadConfig();
                loadSkills();
                runModelCheck(true);
              }}
              disabled={loading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "9px 16px",
                borderRadius: 10,
                fontWeight: 600,
                fontSize: 13,
                border: `1px solid ${BORDER}`,
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                background: "#fff",
                color: TEXT,
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="15"
                height="15"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              刷新
            </button>
            <button
              onClick={resetAll}
              disabled={saving}
              style={{
                padding: "9px 16px",
                borderRadius: 10,
                fontWeight: 600,
                fontSize: 13,
                border: `1px solid ${BORDER}`,
                cursor: saving ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                background: "#fff",
                color: MUTED,
              }}
            >
              恢复默认
            </button>
          </div>
        </div>

        {/* 提示条 */}
        {toast ? (
          <div
            data-testid="panel-toast"
            style={{
              marginBottom: 14,
              padding: "10px 14px",
              borderRadius: 10,
              background: "#EFF6FF",
              border: "1px solid #BFDBFE",
              color: "#1D4ED8",
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {toast}
          </div>
        ) : null}
        {error ? (
          <div
            style={{
              marginBottom: 14,
              padding: "10px 14px",
              borderRadius: 10,
              background: "#FEF2F2",
              border: "1px solid #FECACA",
              color: "#B91C1C",
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {error}
          </div>
        ) : null}

        {/* 顶层 Tab */}
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <button style={tabButton(tab === "overview")} onClick={() => setTab("overview")}>
            Agent 概览
          </button>
          <button style={tabButton(tab === "config")} onClick={() => setTab("config")}>
            Agent 配置
          </button>
          <button
            data-testid="tab-skills"
            style={tabButton(tab === "skills")}
            onClick={() => {
              setTab("skills");
              loadSkills();
            }}
          >
            Skill 管理
          </button>
          <button
            data-testid="tab-mcp"
            style={tabButton(tab === "mcp")}
            onClick={() => {
              setTab("mcp");
              loadMcps();
            }}
          >
            MCP 管理
          </button>
        </div>

        {/* ==================== 概览 ==================== */}
        {tab === "overview" && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))",
                gap: 14,
                marginBottom: 16,
              }}
            >
              <StatCard
                label="服务健康检查"
                value={healthOk ? "正常" : loading ? "检测中" : "异常"}
                tone={healthOk ? "ok" : "bad"}
                sub={
                  overview
                    ? `运行 ${Math.floor((overview.service.uptime_seconds || 0) / 60)} 分钟 · 端口 ${overview.service.port}`
                    : "—"
                }
              />
              <StatCard
                label="模型连通性"
                value={
                  checkingModel ? "检测中" : modelOk === null ? "未检测" : modelOk ? "已连通" : "不可用"
                }
                tone={checkingModel ? "warn" : modelOk === null ? "warn" : modelOk ? "ok" : "bad"}
                sub={
                  checkingModel
                    ? "正在请求模型…"
                    : modelCheck
                    ? `往返 ${Math.round(modelCheck.latency_ms)} ms`
                    : overview?.model.base_url || "—"
                }
              />
              <StatCard
                label="今日调用次数"
                value={fmtNum(overview?.usage.today.calls ?? 0)}
                unit="次"
                sub={`累计 ${fmtNum(overview?.usage.total.calls ?? 0)} 次`}
              />
              <StatCard
                label="平均响应耗时"
                value={fmtLatency(overview?.usage.today.avg_latency_ms ?? 0).value}
                unit={fmtLatency(overview?.usage.today.avg_latency_ms ?? 0).unit}
                sub={`累计均值 ${(() => {
                  const t = fmtLatency(overview?.usage.total.avg_latency_ms ?? 0);
                  return `${t.value} ${t.unit}`;
                })()}`}
              />
              <StatCard
                label="工具调用次数"
                value={fmtNum(overview?.usage.today.tool_calls ?? 0)}
                unit="次"
                sub={`累计 ${fmtNum(overview?.usage.total.tool_calls ?? 0)} 次`}
              />
              <StatCard
                label="Token 消耗量"
                value={fmtNum(overview?.usage.today.total_tokens ?? 0)}
                sub={`累计 ${fmtNum(overview?.usage.total.total_tokens ?? 0)} tokens`}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 16 }}>
              {/* 服务信息 */}
              <Card style={{ padding: "16px 18px" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 12 }}>
                  服务信息
                </div>
                {overview ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 18px" }}>
                    {[
                      ["服务名称", overview.service.name],
                      ["模型", overview.service.model],
                      ["后端", overview.service.backend],
                      ["运行时长", `${Math.floor(overview.service.uptime_seconds / 60)} 分钟`],
                      ["进程 PID", String(overview.service.pid)],
                      ["Python", overview.service.python],
                      [
                        "检查点 / 存储",
                        `${overview.health.checkpointer ? "✔" : "✘"} 检查点 · ${
                          overview.health.store ? "✔" : "✘"
                        } 记忆库`,
                      ],
                      [
                        "数据库",
                        `${overview.health.chat_db ? "✔" : "✘"} 会话库 · ${
                          overview.health.agent_state_db ? "✔" : "✘"
                        } 状态库`,
                      ],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                        <span style={{ color: SUBTLE, minWidth: 82 }}>{k}</span>
                        <span style={{ color: TEXT, fontWeight: 600, wordBreak: "break-all" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: SUBTLE, fontSize: 12.5 }}>加载中…</div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                  <Tag tone="blue">模型调用 {fmtNum(overview?.usage.total.llm_calls ?? 0)} 次</Tag>
                  <Tag tone="green">
                    提示 {fmtNum(overview?.usage.total.prompt_tokens ?? 0)} / 补全{" "}
                    {fmtNum(overview?.usage.total.completion_tokens ?? 0)}
                  </Tag>
                  <Tag tone={(overview?.usage.total.errors ?? 0) > 0 ? "red" : "gray"}>
                    异常 {fmtNum(overview?.usage.total.errors ?? 0)} 次
                  </Tag>
                </div>
              </Card>

              {/* 近 7 天趋势 */}
              <Card style={{ padding: "16px 18px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>近 7 天调用趋势</div>
                  <span style={{ fontSize: 11.5, color: SUBTLE }}>按 Token 用量</span>
                </div>
                {(overview?.trend.length ?? 0) === 0 ? (
                  <div style={{ color: SUBTLE, fontSize: 12.5, padding: "20px 0", textAlign: "center" }}>
                    暂无调用数据
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    {(() => {
                      const max = Math.max(...(overview?.trend ?? []).map((p) => p.tokens), 1);
                      return (overview?.trend ?? []).map((p) => (
                        <div key={p.date} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 11.5, color: SUBTLE, width: 78, flexShrink: 0 }}>
                            {p.date.slice(5)}
                          </span>
                          <div
                            style={{
                              flex: 1,
                              height: 8,
                              background: "#F1F5F9",
                              borderRadius: 999,
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.max(3, (p.tokens / max) * 100)}%`,
                                height: "100%",
                                background: PRIMARY,
                                borderRadius: 999,
                              }}
                            />
                          </div>
                          <span
                            style={{
                              fontSize: 11.5,
                              color: MUTED,
                              width: 96,
                              textAlign: "right",
                              flexShrink: 0,
                            }}
                          >
                            {p.calls} 次 · {fmtNum(p.tokens)} tk
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
                <div
                  style={{
                    marginTop: 16,
                    paddingTop: 12,
                    borderTop: `1px solid #F1F5F9`,
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <Tag tone="blue">工具 {disabledCount} 个已关闭</Tag>
                  <Tag tone="green">{policyCounts.allow} 直接使用</Tag>
                  <Tag tone="amber">{policyCounts.approval} 人工审批</Tag>
                  <Tag tone="red">{policyCounts.deny} 禁止</Tag>
                </div>
              </Card>
            </div>
          </>
        )}

        {/* ==================== 配置 ==================== */}
        {tab === "config" && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {(
                [
                  ["prompt", "系统提示词"],
                  ["tools", "可用工具"],
                  ["policy", "工具权限"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSubTab(key)}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 9,
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    border: `1px solid ${subTab === key ? "#BFDBFE" : BORDER}`,
                    background: subTab === key ? "#EFF6FF" : "#fff",
                    color: subTab === key ? PRIMARY : MUTED,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ---------- 系统提示词 ---------- */}
            {subTab === "prompt" && (
              <Card style={{ padding: "18px 20px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>Agent 系统提示词</div>
                    <div style={{ fontSize: 12, color: SUBTLE, marginTop: 3 }}>
                      决定 Agent 的角色、能力边界与回复规范；保存后对新对话生效
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {config?.is_custom ? <Tag tone="amber">已自定义</Tag> : <Tag tone="gray">默认</Tag>}
                    {promptDirty ? <Tag tone="blue">未保存</Tag> : null}
                  </div>
                </div>
                <textarea
                  data-testid="prompt-editor"
                  value={promptDraft}
                  onChange={(e) => {
                    setPromptDraft(e.target.value);
                    setPromptDirty(true);
                  }}
                  spellCheck={false}
                  style={{
                    width: "100%",
                    minHeight: 420,
                    padding: "14px 16px",
                    borderRadius: 10,
                    border: `1px solid ${BORDER}`,
                    fontSize: 12.5,
                    lineHeight: 1.75,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
                    color: "#1E293B",
                    background: "#FCFDFE",
                    outline: "none",
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: 12,
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ fontSize: 11.5, color: SUBTLE }}>
                    {promptDraft.length} 字符
                    {config ? ` · 默认提示词 ${config.default_system_prompt.length} 字符` : ""}
                    {config?.updated_at ? ` · 上次修改 ${config.updated_at.replace("T", " ")}` : ""}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={resetPrompt}
                      disabled={saving || !config?.is_custom}
                      style={{
                        padding: "9px 16px",
                        borderRadius: 10,
                        fontWeight: 600,
                        fontSize: 13,
                        border: `1px solid ${BORDER}`,
                        cursor: saving || !config?.is_custom ? "not-allowed" : "pointer",
                        fontFamily: "inherit",
                        background: "#fff",
                        color: MUTED,
                        opacity: config?.is_custom ? 1 : 0.55,
                      }}
                    >
                      恢复默认提示词
                    </button>
                    <button
                      data-testid="prompt-save"
                      onClick={savePrompt}
                      disabled={saving || !promptDirty || !promptDraft.trim()}
                      style={{
                        padding: "9px 20px",
                        borderRadius: 10,
                        fontWeight: 600,
                        fontSize: 13,
                        border: "none",
                        cursor: saving || !promptDirty ? "not-allowed" : "pointer",
                        fontFamily: "inherit",
                        background: PRIMARY,
                        color: "#fff",
                        opacity: saving || !promptDirty || !promptDraft.trim() ? 0.55 : 1,
                      }}
                    >
                      {saving ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              </Card>
            )}

            {/* ---------- 可用工具 ---------- */}
            {subTab === "tools" && (
              <>
                <div
                  style={{
                    ...CARD,
                    padding: "12px 18px",
                    marginBottom: 14,
                    display: "flex",
                    gap: 18,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ fontSize: 12.5, color: MUTED }}>
                    共 <b style={{ color: TEXT }}>{config?.tools.length ?? 0}</b> 个工具 ·
                    已开启{" "}
                    <b style={{ color: "#059669" }}>
                      {(config?.tools.length ?? 0) - disabledCount}
                    </b>{" "}
                    · 已关闭 <b style={{ color: "#DC2626" }}>{disabledCount}</b>
                  </span>
                  <span style={{ fontSize: 11.5, color: SUBTLE }}>
                    关闭后该工具不再对模型可见，即便被调用也会被运行时拦截
                  </span>
                </div>
                {grouped.map(({ category, items }) => (
                  <Card key={category} style={{ marginBottom: 14, overflow: "hidden" }}>
                    <div
                      style={{
                        padding: "12px 18px",
                        background: "#F8FAFC",
                        borderBottom: `1px solid ${BORDER}`,
                        fontSize: 13,
                        fontWeight: 700,
                        color: TEXT,
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>{category}</span>
                      <span style={{ fontSize: 11.5, color: SUBTLE, fontWeight: 500 }}>
                        {items.filter((t) => t.enabled).length}/{items.length} 已开启
                      </span>
                    </div>
                    {items.map((t, i) => (
                      <div
                        key={t.name}
                        data-testid={`tool-row-${t.name}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          padding: "12px 18px",
                          borderTop: i === 0 ? "none" : "1px solid #F1F5F9",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
                              {t.label}
                            </span>
                            <code
                              style={{
                                fontSize: 11,
                                color: MUTED,
                                background: "#F1F5F9",
                                padding: "1px 6px",
                                borderRadius: 5,
                              }}
                            >
                              {t.name}
                            </code>
                            <Tag tone={t.policy === "allow" ? "green" : t.policy === "approval" ? "amber" : "red"}>
                              {POLICY_META[t.policy].label}
                            </Tag>
                          </div>
                          <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 3 }}>{t.desc}</div>
                        </div>
                        <span style={{ fontSize: 11.5, color: t.enabled ? "#059669" : SUBTLE, width: 44, textAlign: "right" }}>
                          {t.enabled ? "开启" : "关闭"}
                        </span>
                        <Switch
                          checked={t.enabled}
                          disabled={busyTool === t.name}
                          onChange={(v) => applyTool(t.name, { enabled: v })}
                        />
                      </div>
                    ))}
                  </Card>
                ))}
              </>
            )}

            {/* ---------- 工具权限 ---------- */}
            {subTab === "policy" && (
              <>
                <div
                  style={{
                    ...CARD,
                    padding: "14px 18px",
                    marginBottom: 14,
                    display: "flex",
                    gap: 22,
                    flexWrap: "wrap",
                  }}
                >
                  {(["allow", "approval", "deny"] as ToolPolicy[]).map((p) => (
                    <div key={p} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: POLICY_META[p].color,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: TEXT }}>
                        {POLICY_META[p].label}
                      </span>
                      <span style={{ fontSize: 11.5, color: SUBTLE }}>
                        ×{policyCounts[p]} · {POLICY_META[p].desc}
                      </span>
                    </div>
                  ))}
                </div>
                {grouped.map(({ category, items }) => (
                  <Card key={category} style={{ marginBottom: 14, overflow: "hidden" }}>
                    <div
                      style={{
                        padding: "12px 18px",
                        background: "#F8FAFC",
                        borderBottom: `1px solid ${BORDER}`,
                        fontSize: 13,
                        fontWeight: 700,
                        color: TEXT,
                      }}
                    >
                      {category}
                    </div>
                    {items.map((t, i) => (
                      <div
                        key={t.name}
                        data-testid={`policy-row-${t.name}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          padding: "12px 18px",
                          borderTop: i === 0 ? "none" : "1px solid #F1F5F9",
                          opacity: t.enabled ? 1 : 0.55,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
                              {t.label}
                            </span>
                            <code
                              style={{
                                fontSize: 11,
                                color: MUTED,
                                background: "#F1F5F9",
                                padding: "1px 6px",
                                borderRadius: 5,
                              }}
                            >
                              {t.name}
                            </code>
                            {!t.enabled ? <Tag tone="gray">已关闭</Tag> : null}
                          </div>
                          <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 3 }}>{t.desc}</div>
                        </div>
                        <PolicySegmented
                          value={t.policy}
                          disabled={busyTool === t.name}
                          onChange={(v) => applyTool(t.name, { policy: v })}
                        />
                      </div>
                    ))}
                  </Card>
                ))}
              </>
            )}
          </>
        )}

        {/* ==================== Skill 管理 ==================== */}
        {tab === "skills" && (
          <>
            {/* 汇总条 */}
            <div
              style={{
                ...CARD,
                padding: "12px 18px",
                marginBottom: 14,
                display: "flex",
                gap: 18,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 12.5, color: MUTED }}>
                共 <b style={{ color: TEXT }}>{skillsData?.summary.total ?? 0}</b> 个技能 ·
                已开启{" "}
                <b style={{ color: "#059669" }}>{skillsData?.summary.enabled ?? 0}</b> · 已关闭{" "}
                <b style={{ color: "#DC2626" }}>{skillsData?.summary.disabled ?? 0}</b>
                {skillsData && skillsData.summary.invalid > 0 ? (
                  <>
                    {" "}
                    · 格式异常 <b style={{ color: "#B45309" }}>{skillsData.summary.invalid}</b>
                  </>
                ) : null}
              </span>
              <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(skillsData?.summary.sources ?? []).map((s) => (
                  <Tag key={s.label} tone={SOURCE_TONE[s.label] ?? "gray"}>
                    {s.label} {s.count}
                  </Tag>
                ))}
              </span>
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                关闭后 Agent 不再加载该技能，读取其 SKILL.md 也会被拦截；改动在下一轮对话生效
              </span>
            </div>

            {skillsData && skillsData.summary.orphan_disabled.length > 0 ? (
              <div
                style={{
                  ...CARD,
                  padding: "11px 16px",
                  marginBottom: 14,
                  background: "#FFFBEB",
                  borderColor: "#FDE68A",
                  fontSize: 12,
                  color: "#B45309",
                }}
              >
                配置里记录了已关闭、但磁盘上已不存在的技能：
                {skillsData.summary.orphan_disabled.map((n) => (
                  <code key={n} style={{ marginLeft: 6 }}>
                    {n}
                  </code>
                ))}
                （无害，点「恢复默认」可清理）
              </div>
            ) : null}

            <Card style={{ overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    {["技能", "来源", "文件", "状态", "操作"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "11px 16px",
                          fontSize: 12,
                          fontWeight: 700,
                          color: MUTED,
                          borderBottom: `1px solid ${BORDER}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(skillsData?.skills ?? []).map((s) => (
                    <tr
                      key={s.name}
                      data-testid={`skill-row-${s.name}`}
                      style={{ borderBottom: "1px solid #F1F5F9" }}
                    >
                      {/* 技能名称 + 功能简介 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", maxWidth: 460 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <code
                            style={{
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: TEXT,
                              background: "#F1F5F9",
                              padding: "2px 7px",
                              borderRadius: 5,
                            }}
                          >
                            {s.name}
                          </code>
                          {s.builtin ? <Tag tone="amber">内置</Tag> : null}
                          {!s.valid ? <Tag tone="red">格式异常</Tag> : null}
                          {!s.enabled ? <Tag tone="gray">已关闭</Tag> : null}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: s.valid ? SUBTLE : "#B45309",
                            marginTop: 5,
                            lineHeight: 1.6,
                          }}
                        >
                          {s.problems.length > 0
                            ? s.problems[0]
                            : s.description || "（frontmatter 里没有 description）"}
                        </div>
                      </td>

                      {/* 来源 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <Tag tone={SOURCE_TONE[s.source] ?? "gray"}>{s.source}</Tag>
                        <div style={{ fontSize: 11, color: SUBTLE, marginTop: 5 }}>{s.source_path}</div>
                      </td>

                      {/* 文件信息 */}
                      <td
                        style={{
                          padding: "12px 16px",
                          verticalAlign: "top",
                          fontSize: 11.5,
                          color: MUTED,
                          whiteSpace: "nowrap",
                        }}
                      >
                        <div>{fmtBytes(s.size)}</div>
                        <div style={{ color: SUBTLE, marginTop: 4 }}>{fmtTime(s.mtime)}</div>
                        <div style={{ color: SUBTLE, marginTop: 4 }}>
                          {fmtNum(s.lines)} 行
                          {s.extra_files > 0 ? ` · +${s.extra_files} 附属文件` : ""}
                        </div>
                      </td>

                      {/* 状态 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: s.enabled ? "#059669" : SUBTLE,
                          }}
                        >
                          {s.enabled ? "开启" : "关闭"}
                        </span>
                      </td>

                      {/* 操作：开关 + 编辑 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <Switch
                            checked={s.enabled}
                            disabled={busySkill === s.name}
                            onChange={(v) => toggleSkill(s.name, v)}
                          />
                          <button
                            type="button"
                            data-testid="skill-edit"
                            onClick={() => openSkillEditor(s)}
                            style={{
                              padding: "5px 11px",
                              borderRadius: 8,
                              fontSize: 12,
                              fontWeight: 600,
                              fontFamily: "inherit",
                              cursor: "pointer",
                              border: `1px solid ${BORDER}`,
                              background: "#fff",
                              color: TEXT,
                            }}
                          >
                            编辑
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {skillsData && skillsData.skills.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 32, textAlign: "center", color: SUBTLE, fontSize: 13 }}>
                        没有扫描到任何技能。技能目录里放一个含 SKILL.md 的子目录即可新增。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Card>

            <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 12, lineHeight: 1.7 }}>
              技能清单由服务端<b>实时扫盘</b>得到（左上角汇总的来源目录）—— 往目录里放一个含
              SKILL.md 的子目录就多一个技能，本页不提供新增 / 删除。
              <br />
              本页只能「开关」和「改 SKILL.md 原文」：技能名必须等于目录名，
              frontmatter 必填 name 与 description，不满足会被框架<b>静默跳过</b>
              （所以保存前会先校验并拦下来）。改之前会自动备份，历史副本在{" "}
              <code>{skillsData?.backup_dir ?? "chat-ui/_skill_backups"}</code>。
            </div>
          </>
        )}

        {/* ==================== MCP 管理 ==================== */}
        {tab === "mcp" && (
          <>
            {/* 汇总条 */}
            <div
              style={{
                ...CARD,
                padding: "12px 18px",
                marginBottom: 14,
                display: "flex",
                gap: 18,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 12.5, color: MUTED }}>
                共 <b style={{ color: TEXT }}>{mcpsData?.summary.total ?? 0}</b> 个 MCP ·
                已开启 <b style={{ color: "#059669" }}>{mcpsData?.summary.enabled ?? 0}</b> ·
                已关闭 <b style={{ color: "#DC2626" }}>{mcpsData?.summary.disabled ?? 0}</b> · 提供{" "}
                <b style={{ color: TEXT }}>{mcpsData?.summary.tool_count ?? 0}</b> 个工具
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                data-testid="mcp-add"
                onClick={() => {
                  setMcpAddName("");
                  setMcpAddDesc("");
                  setMcpAddJson("");
                  setMcpAddProblems([]);
                  setMcpAddOpen(true);
                }}
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  border: "none",
                  background: PRIMARY,
                  color: "#fff",
                }}
              >
                添加 MCP
              </button>
              <button
                type="button"
                data-testid="mcp-reset"
                onClick={resetMcp}
                disabled={resettingMcp}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: resettingMcp ? "not-allowed" : "pointer",
                  border: `1px solid ${BORDER}`,
                  background: "#fff",
                  color: MUTED,
                }}
              >
                {resettingMcp ? "恢复中…" : "恢复默认"}
              </button>
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                新增 / 编辑保存后自动关闭，需点「初始启用」重新检查后生效
              </span>
            </div>

            <Card style={{ overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    {["MCP", "传输", "工具", "状态", "操作"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "11px 16px",
                          fontSize: 12,
                          fontWeight: 700,
                          color: MUTED,
                          borderBottom: `1px solid ${BORDER}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(mcpsData?.mcps ?? []).map((m) => (
                    <tr
                      key={m.name}
                      data-testid={`mcp-row-${m.name}`}
                      style={{ borderBottom: "1px solid #F1F5F9" }}
                    >
                      {/* MCP 名称 + 介绍 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", maxWidth: 440 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <code
                            style={{
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: TEXT,
                              background: "#F1F5F9",
                              padding: "2px 7px",
                              borderRadius: 5,
                            }}
                          >
                            {m.name}
                          </code>
                          <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{m.label}</span>
                          {m.builtin ? <Tag tone="blue">内置</Tag> : <Tag tone="gray">自定义</Tag>}
                          {!m.enabled ? <Tag tone="gray">已关闭</Tag> : null}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: SUBTLE,
                            marginTop: 5,
                            lineHeight: 1.6,
                          }}
                        >
                          {m.description}
                        </div>
                        {m.load_error ? (
                          <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 5 }}>
                            加载失败：{m.load_error}
                          </div>
                        ) : null}
                      </td>

                      {/* 传输类型 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <Tag tone="blue">{m.transport}</Tag>
                      </td>

                      {/* 工具 */}
                      <td
                        style={{
                          padding: "12px 16px",
                          verticalAlign: "top",
                          fontSize: 11.5,
                          color: MUTED,
                        }}
                      >
                        {m.tools.length > 0 ? (
                          m.tools.map((t) => (
                            <code
                              key={t}
                              style={{
                                display: "inline-block",
                                margin: "0 4px 3px 0",
                                fontSize: 11,
                                color: MUTED,
                                background: "#F1F5F9",
                                padding: "1px 6px",
                                borderRadius: 5,
                              }}
                            >
                              {t}
                            </code>
                          ))
                        ) : (
                          <span style={{ color: SUBTLE }}>—</span>
                        )}
                      </td>

                      {/* 状态 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: m.enabled ? "#059669" : SUBTLE,
                          }}
                        >
                          {m.enabled ? "开启" : "关闭"}
                        </span>
                      </td>

                      {/* 操作：初始启用 / 关闭 + 编辑 + 删除 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          {m.enabled ? (
                            <button
                              type="button"
                              data-testid="mcp-disable"
                              onClick={() => setMcpEnabled(m.name, false)}
                              disabled={busyMcp === m.name}
                              style={{
                                padding: "5px 11px",
                                borderRadius: 8,
                                fontSize: 12,
                                fontWeight: 600,
                                fontFamily: "inherit",
                                cursor: busyMcp === m.name ? "not-allowed" : "pointer",
                                border: `1px solid ${BORDER}`,
                                background: "#fff",
                                color: MUTED,
                              }}
                            >
                              {busyMcp === m.name ? "处理中…" : "关闭"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              data-testid="mcp-enable"
                              onClick={() => setMcpEnabled(m.name, true)}
                              disabled={busyMcp === m.name}
                              style={{
                                padding: "5px 11px",
                                borderRadius: 8,
                                fontSize: 12,
                                fontWeight: 600,
                                fontFamily: "inherit",
                                cursor: busyMcp === m.name ? "not-allowed" : "pointer",
                                border: "1px solid #A7F3D0",
                                background: "#ECFDF5",
                                color: "#059669",
                              }}
                            >
                              {busyMcp === m.name ? "检查中…" : "初始启用"}
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid="mcp-edit"
                            onClick={() => openMcpEditor(m)}
                            style={{
                              padding: "5px 11px",
                              borderRadius: 8,
                              fontSize: 12,
                              fontWeight: 600,
                              fontFamily: "inherit",
                              cursor: "pointer",
                              border: `1px solid ${BORDER}`,
                              background: "#fff",
                              color: TEXT,
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            data-testid="mcp-delete"
                            onClick={() => setMcpDelete(m)}
                            style={{
                              padding: "5px 11px",
                              borderRadius: 8,
                              fontSize: 12,
                              fontWeight: 600,
                              fontFamily: "inherit",
                              cursor: "pointer",
                              border: "1px solid #FECACA",
                              background: "#FEF2F2",
                              color: "#DC2626",
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {mcpsData && mcpsData.mcps.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        style={{ padding: 32, textAlign: "center", color: SUBTLE, fontSize: 13 }}
                      >
                        没有配置任何 MCP 服务器。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Card>

            <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 12, lineHeight: 1.7 }}>
              MCP（Model Context Protocol）把外部工具服务器桥接给 Agent。新增 / 编辑保存后会自动关闭，
              点「初始启用」时会重新做错误检查，启动失败则保持关闭并回显错误内容。
              <br />
              「编辑」与「添加」都支持粘贴<b>完整 MCP JSON 串</b>（如{" "}
              <code>{`{"mcpServers":{"name":{"command":"...","args":[...]}}}`}</code> 或
              含 name / description / config 的完整定义），系统会自动识别并补齐 transport。
            </div>
          </>
        )}
      </main>

      {/* ==================== 编辑 SKILL.md 弹窗 ==================== */}
      <Modal
        open={!!skillEdit}
        onClose={() => {
          setSkillEdit(null);
          setSkillContent(null);
          setSkillDraft("");
          setSkillProblems([]);
          setSkillWarnings([]);
        }}
        title={skillEdit ? `编辑 SKILL.md — ${skillEdit.name}` : "编辑 SKILL.md"}
        width="860px"
      >
        {skillEdit ? (
          <div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <Tag tone={SOURCE_TONE[skillEdit.source] ?? "gray"}>{skillEdit.source}</Tag>
              {skillEdit.builtin ? <Tag tone="amber">内置技能，框架升级可能覆盖</Tag> : null}
              <code style={{ fontSize: 11, color: MUTED, background: "#F1F5F9", padding: "2px 6px", borderRadius: 5 }}>
                {skillEdit.virtual_path}
              </code>
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                {fmtBytes(skillDraft.length)} · {fmtNum(skillDraft.split("\n").length)} 行
              </span>
            </div>

            {skillProblems.length > 0 ? (
              <div
                data-testid="skill-problems"
                style={{
                  marginBottom: 12,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "#FEF2F2",
                  border: "1px solid #FECACA",
                  color: "#B91C1C",
                  fontSize: 12.5,
                  lineHeight: 1.7,
                }}
              >
                <b>保存被拒绝 —— 按下面几条改完再存（框架会静默跳过不合规的技能）：</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {skillProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {skillWarnings.length > 0 ? (
              <div
                data-testid="skill-warnings"
                style={{
                  marginBottom: 12,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "#FFFBEB",
                  border: "1px solid #FDE68A",
                  color: "#B45309",
                  fontSize: 12.5,
                  lineHeight: 1.7,
                }}
              >
                <b>提醒（不阻塞保存）：</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {skillWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {skillLoading ? (
              <div style={{ padding: 40, textAlign: "center", color: SUBTLE, fontSize: 13 }}>
                正在读取 SKILL.md…
              </div>
            ) : (
              <textarea
                data-testid="skill-editor"
                value={skillDraft}
                onChange={(e) => setSkillDraft(e.target.value)}
                spellCheck={false}
                style={{
                  width: "100%",
                  minHeight: 380,
                  padding: "14px 16px",
                  borderRadius: 10,
                  border: `1px solid ${BORDER}`,
                  fontSize: 12.5,
                  lineHeight: 1.75,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
                  color: "#1E293B",
                  background: "#FCFDFE",
                  outline: "none",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
            )}

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 14,
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                保存前会自动备份旧版本；改动对下一轮对话生效（技能每轮重新加载）
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setSkillEdit(null);
                    setSkillContent(null);
                    setSkillProblems([]);
                    setSkillWarnings([]);
                  }}
                  style={{
                    padding: "9px 16px",
                    borderRadius: 10,
                    fontWeight: 600,
                    fontSize: 13,
                    border: `1px solid ${BORDER}`,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    background: "#fff",
                    color: MUTED,
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  data-testid="skill-save"
                  onClick={saveSkillContent}
                  disabled={
                    skillSaving ||
                    skillLoading ||
                    !skillDraft.trim() ||
                    (skillContent !== null && skillDraft === skillContent.content)
                  }
                  style={{
                    padding: "9px 18px",
                    borderRadius: 10,
                    fontWeight: 600,
                    fontSize: 13,
                    border: "none",
                    fontFamily: "inherit",
                    background: PRIMARY,
                    color: "#fff",
                    cursor: skillSaving || skillLoading ? "not-allowed" : "pointer",
                    opacity:
                      skillSaving ||
                      skillLoading ||
                      !skillDraft.trim() ||
                      (skillContent !== null && skillDraft === skillContent.content)
                        ? 0.55
                        : 1,
                  }}
                >
                  {skillSaving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ==================== 编辑 MCP 配置弹窗 ==================== */}
      <Modal
        open={!!mcpEdit}
        onClose={() => {
          setMcpEdit(null);
          setMcpConfigSaved("");
          setMcpConfigDraft("");
          setMcpProblems([]);
        }}
        title={mcpEdit ? `编辑 MCP 配置 — ${mcpEdit.name}` : "编辑 MCP 配置"}
        width="760px"
      >
        {mcpEdit ? (
          <div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <Tag tone="blue">{mcpEdit.transport}</Tag>
              <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{mcpEdit.label}</span>
              <code
                style={{
                  fontSize: 11,
                  color: MUTED,
                  background: "#F1F5F9",
                  padding: "2px 6px",
                  borderRadius: 5,
                }}
              >
                {mcpEdit.name}
              </code>
              <span style={{ fontSize: 11.5, color: SUBTLE }}>{mcpConfigDraft.length} 字符</span>
            </div>

            {mcpProblems.length > 0 ? (
              <div
                data-testid="mcp-problems"
                style={{
                  marginBottom: 12,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "#FEF2F2",
                  border: "1px solid #FECACA",
                  color: "#B91C1C",
                  fontSize: 12.5,
                  lineHeight: 1.7,
                }}
              >
                <b>保存被拒绝 —— 请按下面几条改完再存：</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {mcpProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {mcpLoading ? (
              <div style={{ padding: 40, textAlign: "center", color: SUBTLE, fontSize: 13 }}>
                正在读取连接配置…
              </div>
            ) : (
              <textarea
                data-testid="mcp-editor"
                value={mcpConfigDraft}
                onChange={(e) => setMcpConfigDraft(e.target.value)}
                spellCheck={false}
                style={{
                  width: "100%",
                  minHeight: 300,
                  padding: "14px 16px",
                  borderRadius: 10,
                  border: `1px solid ${BORDER}`,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
                  color: "#1E293B",
                  background: "#FCFDFE",
                  outline: "none",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
            )}

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 14,
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                可粘贴完整 MCP JSON 串（mcpServers 包裹、或含 name / label / description / config
                的完整定义），系统自动识别并补齐 transport。名称不可改；保存后自动关闭，需点「初始启用」重新检查。
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setMcpEdit(null);
                    setMcpConfigSaved("");
                    setMcpConfigDraft("");
                    setMcpProblems([]);
                  }}
                  style={{
                    padding: "9px 16px",
                    borderRadius: 10,
                    fontWeight: 600,
                    fontSize: 13,
                    border: `1px solid ${BORDER}`,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    background: "#fff",
                    color: MUTED,
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  data-testid="mcp-save"
                  onClick={saveMcpConfig}
                  disabled={
                    mcpSaving ||
                    mcpLoading ||
                    !mcpConfigDraft.trim() ||
                    mcpConfigDraft === mcpConfigSaved
                  }
                  style={{
                    padding: "9px 18px",
                    borderRadius: 10,
                    fontWeight: 600,
                    fontSize: 13,
                    border: "none",
                    fontFamily: "inherit",
                    background: PRIMARY,
                    color: "#fff",
                    cursor: mcpSaving || mcpLoading ? "not-allowed" : "pointer",
                    opacity:
                      mcpSaving ||
                      mcpLoading ||
                      !mcpConfigDraft.trim() ||
                      mcpConfigDraft === mcpConfigSaved
                        ? 0.55
                        : 1,
                  }}
                >
                  {mcpSaving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ==================== 添加 MCP 弹窗 ==================== */}
      <Modal
        open={mcpAddOpen}
        onClose={() => {
          if (mcpAddSaving) return;
          setMcpAddOpen(false);
          setMcpAddProblems([]);
        }}
        title="添加 MCP"
        width="680px"
      >
        <div>
          {mcpAddProblems.length > 0 ? (
            <div
              data-testid="mcp-add-problems"
              style={{
                marginBottom: 12,
                padding: "10px 14px",
                borderRadius: 10,
                background: "#FEF2F2",
                border: "1px solid #FECACA",
                color: "#B91C1C",
                fontSize: 12.5,
                lineHeight: 1.7,
              }}
            >
              <b>添加被拒绝 —— 请按下面几条改完再存：</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {mcpAddProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: TEXT, marginBottom: 6 }}>
              MCP 名称 <span style={{ color: "#DC2626" }}>*</span>
            </div>
            <input
              data-testid="mcp-add-name"
              value={mcpAddName}
              onChange={(e) => setMcpAddName(e.target.value)}
              placeholder="例如 my-search（字母/数字/下划线/连字符，唯一标识）"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 9,
                border: `1px solid ${BORDER}`,
                fontSize: 13,
                fontFamily: "inherit",
                color: "#1E293B",
                background: "#fff",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: TEXT, marginBottom: 6 }}>
              简介 <span style={{ color: SUBTLE, fontWeight: 500 }}>（可选）</span>
            </div>
            <textarea
              data-testid="mcp-add-desc"
              value={mcpAddDesc}
              onChange={(e) => setMcpAddDesc(e.target.value)}
              placeholder="一句话说明这个 MCP 提供什么能力"
              rows={2}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 9,
                border: `1px solid ${BORDER}`,
                fontSize: 13,
                fontFamily: "inherit",
                color: "#1E293B",
                background: "#fff",
                outline: "none",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: TEXT, marginBottom: 6 }}>
              完整 JSON 串 <span style={{ color: "#DC2626" }}>*</span>
            </div>
            <textarea
              data-testid="mcp-add-json"
              value={mcpAddJson}
              onChange={(e) => setMcpAddJson(e.target.value)}
              spellCheck={false}
              placeholder={'{\n  "mcpServers": {\n    "my-search": {\n      "command": "npx",\n      "args": ["-y", "some-mcp"]\n    }\n  }\n}'}
              style={{
                width: "100%",
                minHeight: 200,
                padding: "12px 14px",
                borderRadius: 9,
                border: `1px solid ${BORDER}`,
                fontSize: 12.5,
                lineHeight: 1.7,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
                color: "#1E293B",
                background: "#FCFDFE",
                outline: "none",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ fontSize: 11.5, color: SUBTLE, marginBottom: 14, lineHeight: 1.7 }}>
            支持粘贴完整 MCP JSON 串（标准 mcpServers 包裹、或含 name / label / description / config
            的完整定义），系统自动识别并补齐 transport。保存后默认「关闭」，需点「初始启用」生效。
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setMcpAddOpen(false);
                setMcpAddProblems([]);
              }}
              disabled={mcpAddSaving}
              style={{
                padding: "9px 16px",
                borderRadius: 10,
                fontWeight: 600,
                fontSize: 13,
                border: `1px solid ${BORDER}`,
                cursor: mcpAddSaving ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                background: "#fff",
                color: MUTED,
              }}
            >
              取消
            </button>
            <button
              type="button"
              data-testid="mcp-add-save"
              onClick={submitAddMcp}
              disabled={mcpAddSaving || !mcpAddName.trim() || !mcpAddJson.trim()}
              style={{
                padding: "9px 18px",
                borderRadius: 10,
                fontWeight: 600,
                fontSize: 13,
                border: "none",
                fontFamily: "inherit",
                background: PRIMARY,
                color: "#fff",
                cursor: mcpAddSaving || !mcpAddName.trim() || !mcpAddJson.trim() ? "not-allowed" : "pointer",
                opacity: mcpAddSaving || !mcpAddName.trim() || !mcpAddJson.trim() ? 0.55 : 1,
              }}
            >
              {mcpAddSaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ==================== 删除 MCP 确认弹窗 ==================== */}
      <Modal
        open={!!mcpDelete}
        onClose={() => {
          if (mcpDeleting) return;
          setMcpDelete(null);
        }}
        title="删除 MCP"
        width="460px"
      >
        {mcpDelete ? (
          <div>
            <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.7 }}>
              确认删除 MCP{" "}
              <code
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  background: "#F1F5F9",
                  padding: "2px 7px",
                  borderRadius: 5,
                  color: TEXT,
                }}
              >
                {mcpDelete.name}
              </code>
              {mcpDelete.label ? `（${mcpDelete.label}）` : ""}？删除时会一并关闭该 MCP，
              其下所有工具将不再提供给 Agent。
            </div>
            <div
              style={{
                marginTop: 10,
                padding: "9px 12px",
                borderRadius: 9,
                fontSize: 12,
                lineHeight: 1.6,
                background: mcpDelete.builtin ? "#FFFBEB" : "#FEF2F2",
                border: mcpDelete.builtin ? "1px solid #FDE68A" : "1px solid #FECACA",
                color: mcpDelete.builtin ? "#B45309" : "#B91C1C",
              }}
            >
              {mcpDelete.builtin
                ? "这是内置 MCP，删除后可通过「恢复默认」找回。"
                : "这是自定义 MCP，删除后不可恢复，请谨慎操作。"}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => setMcpDelete(null)}
                disabled={mcpDeleting}
                style={{
                  padding: "9px 16px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13,
                  border: `1px solid ${BORDER}`,
                  cursor: mcpDeleting ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  background: "#fff",
                  color: MUTED,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="mcp-delete-confirm"
                onClick={submitDeleteMcp}
                disabled={mcpDeleting}
                style={{
                  padding: "9px 18px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13,
                  border: "none",
                  fontFamily: "inherit",
                  background: "#DC2626",
                  color: "#fff",
                  cursor: mcpDeleting ? "not-allowed" : "pointer",
                  opacity: mcpDeleting ? 0.55 : 1,
                }}
              >
                {mcpDeleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
