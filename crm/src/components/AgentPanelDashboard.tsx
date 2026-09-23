"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./Sidebar";
import Modal from "./Modal";
import { usePermission } from "@/hooks/usePermission";
import type {
  PanelChannel,
  PanelChannelsResponse,
  PanelConfig,
  PanelMcp,
  PanelMcpConfig,
  PanelMcpsResponse,
  PanelMemoryEntry,
  PanelMemoryResponse,
  PanelModel,
  PanelModelCheck,
  PanelModelsResponse,
  PanelOverview,
  PanelSkill,
  PanelSkillContent,
  PanelSkillsResponse,
  PanelTool,
  TokenUsageResponse,
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

/** 表格行内小按钮（编辑 / 开启关闭 / 删除） */
function miniBtn(danger: boolean, busy = false): React.CSSProperties {
  return {
    padding: "5px 11px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: busy ? "wait" : "pointer",
    border: `1px solid ${danger ? "#FECACA" : BORDER}`,
    background: "#fff",
    color: danger ? "#DC2626" : TEXT,
    opacity: busy ? 0.6 : 1,
    whiteSpace: "nowrap",
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

  const [tab, setTab] = useState<
    "overview" | "config" | "skills" | "mcp" | "channel" | "memory" | "model" | "usage"
  >("overview");
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

  // ---- 渠道管理 ----
  const [channelsData, setChannelsData] = useState<PanelChannelsResponse | null>(null);
  const [busyChannel, setBusyChannel] = useState<string | null>(null);
  /** 正在编辑凭证的渠道（null = 弹窗关闭） */
  const [channelEdit, setChannelEdit] = useState<PanelChannel | null>(null);
  const [channelAppId, setChannelAppId] = useState("");
  const [channelAppSecret, setChannelAppSecret] = useState("");
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelError, setChannelError] = useState("");

  // ---- 记忆 ----
  const [memoryData, setMemoryData] = useState<PanelMemoryResponse | null>(null);
  const [busyMemory, setBusyMemory] = useState<string | null>(null);
  /** 正在编辑的记忆条目（null = 弹窗关闭）；新增时为 key="" 的空条目 */
  const [memoryEdit, setMemoryEdit] = useState<PanelMemoryEntry | null>(null);
  const [memoryEditKey, setMemoryEditKey] = useState("");
  const [memoryEditValue, setMemoryEditValue] = useState("");
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  /** 待删除确认的记忆条目 */
  const [memoryDelete, setMemoryDelete] = useState<PanelMemoryEntry | null>(null);
  const [memoryDeleting, setMemoryDeleting] = useState(false);
  /** AGENTS.md 编辑草稿 */
  const [agentsMdDraft, setAgentsMdDraft] = useState("");
  const [agentsMdDirty, setAgentsMdDirty] = useState(false);
  const [agentsMdSaving, setAgentsMdSaving] = useState(false);

  // ---- 模型管理 ----
  const [modelsData, setModelsData] = useState<PanelModelsResponse | null>(null);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  /** 正在编辑的模型（null = 弹窗关闭） */
  const [modelEdit, setModelEdit] = useState<PanelModel | null>(null);
  const [modelDraft, setModelDraft] = useState<{
    id: string;
    name: string;
    base_url: string;
    api_key: string;
    vision: boolean;
    context_length: string;
  } | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState("");
  /** 待删除确认的模型 */
  const [modelDelete, setModelDelete] = useState<PanelModel | null>(null);
  const [modelDeleting, setModelDeleting] = useState(false);

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

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/panel/channels", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setChannelsData((await res.json()) as PanelChannelsResponse);
      setError("");
    } catch {
      setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
    }
  }, []);

  const loadMemory = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/panel/memory", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as PanelMemoryResponse;
      setMemoryData(data);
      setAgentsMdDraft(data.agents_md);
      setAgentsMdDirty(false);
      setError("");
    } catch {
      setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
    }
  }, []);

  // ---- token 消耗统计（总量 + 按用户） ----
  // ⚠️ 可见范围由**服务端**自算（读角色的「Agent 控制面板」页 dataScope）：
  //    全部 → 所有用户；仅自己 / 身份解析不到 → 只返回本人（拿不到身份则空集）。
  //    前端只声明「我是谁」，绝不传范围。
  const [usageData, setUsageData] = useState<TokenUsageResponse | null>(null);
  const [usageScope, setUsageScope] = useState<"all" | "today">("all");
  const [usageLoading, setUsageLoading] = useState(false);

  const panelScopeParams = perm.scopeParams;

  const loadTokenUsage = useCallback(
    async (scope: "all" | "today" = "all") => {
      setUsageLoading(true);
      try {
        const q = panelScopeParams();
        q.set("scope", scope);
        const res = await fetch(`/api/agent/panel/token-usage?${q.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        setUsageData((await res.json()) as TokenUsageResponse);
        setError("");
      } catch {
        setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
      } finally {
        setUsageLoading(false);
      }
    },
    [panelScopeParams]
  );

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

  /* ---------------- 渠道管理操作 ---------------- */

  const setChannelEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      setBusyChannel(name);
      try {
        const res = await fetch(`/api/agent/panel/channels/${encodeURIComponent(name)}/enabled`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
        }
        const body = await res.json().catch(() => null);
        if (body?.channel) {
          const fresh = body.channel as PanelChannel;
          setChannelsData((prev) =>
            prev
              ? {
                  ...prev,
                  channels: prev.channels.map((c) => (c.name === name ? fresh : c)),
                  summary: body.summary ?? prev.summary,
                }
              : prev
          );
        }
        flash(`渠道「${name}」已${enabled ? "开启" : "关闭"}，下一轮对话生效`);
      } catch (e) {
        flash(e instanceof Error ? `操作失败：${e.message}` : "操作失败，请重试");
        loadChannels();
      } finally {
        setBusyChannel(null);
      }
    },
    [flash, loadChannels]
  );

  const openChannelEditor = useCallback((ch: PanelChannel) => {
    setChannelEdit(ch);
    setChannelAppId("");
    setChannelAppSecret("");
    setChannelError("");
  }, []);

  const saveChannelCredentials = useCallback(async () => {
    if (!channelEdit) return;
    if (!channelAppId.trim() || !channelAppSecret.trim()) {
      setChannelError("App ID 与 App Secret 均不能为空");
      return;
    }
    setChannelSaving(true);
    setChannelError("");
    try {
      const res = await fetch(
        `/api/agent/panel/channels/${encodeURIComponent(channelEdit.name)}/credentials`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: channelAppId.trim(), app_secret: channelAppSecret.trim() }),
        }
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      const body = await res.json().catch(() => null);
      if (body?.channel) {
        const fresh = body.channel as PanelChannel;
        setChannelsData((prev) =>
          prev
            ? { ...prev, channels: prev.channels.map((c) => (c.name === fresh.name ? fresh : c)) }
            : prev
        );
      }
      flash(`渠道「${channelEdit.name}」凭证已更新`);
      setChannelEdit(null);
    } catch (e) {
      setChannelError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setChannelSaving(false);
    }
  }, [channelEdit, channelAppId, channelAppSecret, flash]);

  const reauthorizeChannel = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/feishu/authorize-url", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json().catch(() => null);
      if (data?.url) {
        window.open(data.url, "_blank", "noopener");
      } else {
        flash("获取授权地址失败");
      }
    } catch {
      flash("获取授权地址失败，请重试");
    }
  }, [flash]);

  /* ---------------- 记忆操作 ---------------- */

  const openMemoryEditor = useCallback((entry: PanelMemoryEntry | null) => {
    setMemoryEdit(entry ?? { key: "", value: "" });
    setMemoryEditKey(entry?.key ?? "");
    setMemoryEditValue(entry?.value ?? "");
    setMemoryError("");
  }, []);

  const saveMemory = useCallback(async () => {
    const key = memoryEditKey.trim();
    const value = memoryEditValue.trim();
    if (!key) {
      setMemoryError("记忆的 key 不能为空");
      return;
    }
    if (!value) {
      setMemoryError("记忆内容不能为空");
      return;
    }
    setMemorySaving(true);
    setMemoryError("");
    try {
      const res = await fetch("/api/agent/panel/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      flash(`记忆「${key}」已保存`);
      setMemoryEdit(null);
      loadMemory();
    } catch (e) {
      setMemoryError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setMemorySaving(false);
    }
  }, [memoryEditKey, memoryEditValue, flash, loadMemory]);

  const confirmDeleteMemory = useCallback(async () => {
    if (!memoryDelete) return;
    setMemoryDeleting(true);
    try {
      const res = await fetch(`/api/agent/panel/memory/${encodeURIComponent(memoryDelete.key)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      flash(`记忆「${memoryDelete.key}」已删除`);
      setMemoryDelete(null);
      loadMemory();
    } catch (e) {
      flash(e instanceof Error ? `删除失败：${e.message}` : "删除失败");
    } finally {
      setMemoryDeleting(false);
    }
  }, [memoryDelete, flash, loadMemory]);

  /* ---------------- 模型管理操作 ---------------- */

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/panel/models", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setModelsData((await res.json()) as PanelModelsResponse);
      setError("");
    } catch {
      setError("无法连接 Agent 服务，请确认 DeepAgents 服务（8765）已启动。");
    }
  }, []);

  const EMPTY_MODEL_DRAFT = {
    id: "",
    name: "",
    base_url: "",
    api_key: "",
    vision: false,
    context_length: "1048576",
  };

  /** 打开编辑弹窗（传 null 表示新增） */
  const openModelEditor = useCallback((m: PanelModel | null) => {
    setModelError("");
    setModelEdit(m);
    setModelDraft(
      m
        ? {
            id: m.id,
            name: m.name,
            base_url: m.base_url,
            api_key: "",
            vision: m.vision,
            context_length: String(m.context_length),
          }
        : { ...EMPTY_MODEL_DRAFT },
    );
  }, []);

  const saveModel = useCallback(async () => {
    if (!modelDraft) return;
    const isCreate = !modelEdit;
    const id = modelDraft.id.trim();
    const name = modelDraft.name.trim();
    const baseUrl = modelDraft.base_url.trim();
    if (!id) {
      setModelError("模型 ID 不能为空");
      return;
    }
    if (!name) {
      setModelError("模型名称不能为空");
      return;
    }
    if (!baseUrl) {
      setModelError("API 地址不能为空");
      return;
    }
    const ctx = Number(modelDraft.context_length);
    if (!Number.isFinite(ctx) || ctx <= 0) {
      setModelError("上下文长度必须是正整数");
      return;
    }
    setModelSaving(true);
    setModelError("");
    const payload = {
      id,
      name,
      base_url: baseUrl,
      api_key: modelDraft.api_key,
      vision: modelDraft.vision,
      context_length: Math.floor(ctx),
    };
    try {
      const res = await fetch(
        isCreate ? "/api/agent/panel/models" : `/api/agent/panel/models/${encodeURIComponent(modelEdit!.id)}`,
        {
          method: isCreate ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      flash(isCreate ? `模型「${name}」已添加` : `模型「${name}」已保存`);
      setModelEdit(null);
      setModelDraft(null);
      loadModels();
      loadOverview(true);
    } catch (e) {
      setModelError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setModelSaving(false);
    }
  }, [modelDraft, modelEdit, flash, loadModels, loadOverview]);

  const setModelEnabled = useCallback(
    async (m: PanelModel, enabled: boolean) => {
      setBusyModel(m.id);
      try {
        const res = await fetch(`/api/agent/panel/models/${encodeURIComponent(m.id)}/enabled`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
        }
        flash(`模型「${m.name}」已${enabled ? "开启" : "关闭"}`);
        loadModels();
        loadOverview(true);
      } catch (e) {
        flash(e instanceof Error ? `操作失败：${e.message}` : "操作失败");
      } finally {
        setBusyModel(null);
      }
    },
    [flash, loadModels, loadOverview],
  );

  const confirmDeleteModel = useCallback(async () => {
    if (!modelDelete) return;
    setModelDeleting(true);
    try {
      const res = await fetch(`/api/agent/panel/models/${encodeURIComponent(modelDelete.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      flash(`模型「${modelDelete.name}」已删除`);
      setModelDelete(null);
      loadModels();
      loadOverview(true);
    } catch (e) {
      flash(e instanceof Error ? `删除失败：${e.message}` : "删除失败");
    } finally {
      setModelDeleting(false);
    }
  }, [modelDelete, flash, loadModels, loadOverview]);

  const saveAgentsMd = useCallback(async () => {
    setAgentsMdSaving(true);
    try {
      const res = await fetch("/api/agent/panel/memory/agents-md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: agentsMdDraft }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(typeof e.detail === "string" ? e.detail : String(res.status));
      }
      setAgentsMdDirty(false);
      flash("项目记忆文件 AGENTS.md 已保存，下一轮对话生效");
    } catch (e) {
      flash(e instanceof Error ? `保存失败：${e.message}` : "保存失败");
    } finally {
      setAgentsMdSaving(false);
    }
  }, [agentsMdDraft, flash]);

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
          <button
            data-testid="tab-channel"
            style={tabButton(tab === "channel")}
            onClick={() => {
              setTab("channel");
              loadChannels();
            }}
          >
            渠道管理
          </button>
          <button
            data-testid="tab-memory"
            style={tabButton(tab === "memory")}
            onClick={() => {
              setTab("memory");
              loadMemory();
            }}
          >
            记忆
          </button>
          <button
            data-testid="tab-model"
            style={tabButton(tab === "model")}
            onClick={() => {
              setTab("model");
              loadModels();
            }}
          >
            模型管理
          </button>
          <button
            data-testid="tab-usage"
            style={tabButton(tab === "usage")}
            onClick={() => {
              setTab("usage");
              loadTokenUsage(usageScope);
            }}
          >
            用量统计
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

        {/* ==================== 渠道管理 ==================== */}
        {tab === "channel" && (
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
                共 <b style={{ color: TEXT }}>{channelsData?.summary.total ?? 0}</b> 个渠道 · 已开启{" "}
                <b style={{ color: "#059669" }}>{channelsData?.summary.enabled ?? 0}</b> · 已关闭{" "}
                <b style={{ color: "#DC2626" }}>{channelsData?.summary.disabled ?? 0}</b>
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                渠道关闭后，该渠道的工具与接收消息对 Agent 全部不可用；改动在下一轮对话生效
              </span>
            </div>

            <Card style={{ overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    {["渠道", "状态", "操作"].map((h) => (
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
                  {(channelsData?.channels ?? []).map((c) => (
                    <tr
                      key={c.name}
                      data-testid={`channel-row-${c.name}`}
                      style={{ borderBottom: "1px solid #F1F5F9" }}
                    >
                      {/* 渠道名 + 介绍 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", maxWidth: 480 }}>
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
                            {c.name}
                          </code>
                          <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{c.label}</span>
                          {c.configured ? <Tag tone="green">已配置凭证</Tag> : <Tag tone="amber">未配置凭证</Tag>}
                          {!c.enabled ? <Tag tone="gray">已关闭</Tag> : null}
                        </div>
                        <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 5, lineHeight: 1.6 }}>
                          {c.description}
                        </div>
                      </td>

                      {/* 状态 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: c.enabled ? "#059669" : SUBTLE,
                          }}
                        >
                          {c.enabled ? "开启" : "关闭"}
                        </span>
                      </td>

                      {/* 操作：开关 + 编辑 */}
                      <td style={{ padding: "12px 16px", verticalAlign: "top" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {c.enabled ? (
                            <button
                              type="button"
                              data-testid="channel-disable"
                              onClick={() => setChannelEnabled(c.name, false)}
                              disabled={busyChannel === c.name}
                              style={{
                                padding: "5px 11px",
                                borderRadius: 8,
                                fontSize: 12,
                                fontWeight: 600,
                                fontFamily: "inherit",
                                cursor: busyChannel === c.name ? "not-allowed" : "pointer",
                                border: `1px solid ${BORDER}`,
                                background: "#fff",
                                color: MUTED,
                              }}
                            >
                              {busyChannel === c.name ? "处理中…" : "关闭"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              data-testid="channel-enable"
                              onClick={() => setChannelEnabled(c.name, true)}
                              disabled={busyChannel === c.name}
                              style={{
                                padding: "5px 11px",
                                borderRadius: 8,
                                fontSize: 12,
                                fontWeight: 600,
                                fontFamily: "inherit",
                                cursor: busyChannel === c.name ? "not-allowed" : "pointer",
                                border: "1px solid #A7F3D0",
                                background: "#ECFDF5",
                                color: "#059669",
                              }}
                            >
                              {busyChannel === c.name ? "处理中…" : "开启"}
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid="channel-edit"
                            onClick={() => openChannelEditor(c)}
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
                  {channelsData && channelsData.channels.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ padding: 32, textAlign: "center", color: SUBTLE, fontSize: 13 }}>
                        没有配置任何通信渠道。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Card>

            <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 12, lineHeight: 1.7 }}>
              通信渠道让 Agent 通过外部 IM（当前为飞书）收发消息。开启后 Agent 可获得该渠道的
              发送 / 回复 / 搜通讯录工具，并接收渠道发来的消息；关闭后全部不可用。
            </div>
          </>
        )}

        {/* ==================== 记忆 ==================== */}
        {tab === "memory" && (
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
                长期记忆 <b style={{ color: TEXT }}>{memoryData?.summary.memories_count ?? 0}</b> 条
                {memoryData && !memoryData.store_ready ? <Tag tone="amber">记忆库未就绪</Tag> : null}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                长期记忆由 store_memory / recall_memory 工具读写，跨会话持久；AGENTS.md 每轮对话加载进系统提示词
              </span>
            </div>

            {/* 长期记忆条目 */}
            <Card style={{ overflow: "hidden", marginBottom: 18 }}>
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: `1px solid ${BORDER}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 700, color: TEXT }}>长期记忆条目</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  data-testid="memory-add"
                  onClick={() => openMemoryEditor(null)}
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
                  新增记忆
                </button>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    {["Key", "内容", "操作"].map((h) => (
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
                  {(memoryData?.memories ?? []).map((m) => (
                    <tr
                      key={m.key}
                      data-testid={`memory-row-${m.key}`}
                      style={{ borderBottom: "1px solid #F1F5F9" }}
                    >
                      <td style={{ padding: "12px 16px", verticalAlign: "top", whiteSpace: "nowrap" }}>
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
                          {m.key}
                        </code>
                      </td>
                      <td style={{ padding: "12px 16px", verticalAlign: "top", maxWidth: 460 }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            color: TEXT,
                            lineHeight: 1.6,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {m.value}
                        </div>
                      </td>
                      <td style={{ padding: "12px 16px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <button
                            type="button"
                            data-testid="memory-edit"
                            onClick={() => openMemoryEditor(m)}
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
                            data-testid="memory-delete"
                            onClick={() => setMemoryDelete(m)}
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
                  {memoryData && memoryData.memories.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ padding: 32, textAlign: "center", color: SUBTLE, fontSize: 13 }}>
                        暂无长期记忆，点右上角「新增记忆」添加一条。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Card>

            {/* 项目记忆文件 AGENTS.md */}
            <Card style={{ overflow: "hidden" }}>
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: `1px solid ${BORDER}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 700, color: TEXT }}>项目记忆文件 AGENTS.md</span>
                {agentsMdDirty ? <Tag tone="amber">未保存</Tag> : null}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  data-testid="agents-md-save"
                  onClick={saveAgentsMd}
                  disabled={agentsMdSaving || !agentsMdDirty}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: agentsMdSaving || !agentsMdDirty ? "not-allowed" : "pointer",
                    border: "none",
                    background: PRIMARY,
                    color: "#fff",
                    opacity: agentsMdSaving || !agentsMdDirty ? 0.5 : 1,
                  }}
                >
                  {agentsMdSaving ? "保存中…" : "保存"}
                </button>
              </div>
              <div style={{ padding: 14 }}>
                <textarea
                  data-testid="agents-md-editor"
                  value={agentsMdDraft}
                  onChange={(e) => {
                    setAgentsMdDraft(e.target.value);
                    setAgentsMdDirty(true);
                  }}
                  rows={16}
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 8,
                    border: "1px solid #E2E8F0",
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    color: "#0F172A",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    boxSizing: "border-box",
                    outline: "none",
                    resize: "vertical",
                  }}
                />
              </div>
            </Card>

            <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 12, lineHeight: 1.7 }}>
              两套记忆：<b>长期记忆条目</b>（键值，由 store_memory / recall_memory 工具读写，存于 SQLite，跨会话持久）
              与 <b>AGENTS.md</b>（项目记忆文件，每轮对话由框架 MemoryMiddleware 加载进系统提示词）。
              长期记忆适合存用户偏好、约定、个人资料等结构化条目；AGENTS.md 适合存项目级上下文与操作规范。
            </div>
          </>
        )}

        {/* ==================== 模型管理 ==================== */}
        {tab === "model" && (
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
                共 <b style={{ color: TEXT }}>{modelsData?.summary.total ?? 0}</b> 个模型
              </span>
              <span style={{ fontSize: 12.5, color: MUTED }}>
                已开启 <b style={{ color: "#059669" }}>{modelsData?.summary.enabled ?? 0}</b>
              </span>
              <span style={{ fontSize: 12.5, color: MUTED }}>
                支持图片识别 <b style={{ color: PRIMARY }}>{modelsData?.summary.vision ?? 0}</b>
              </span>
              {modelsData?.selected ? (
                <span style={{ fontSize: 12.5, color: MUTED }}>
                  默认模型{" "}
                  <b style={{ color: TEXT }}>{modelsData.selected}</b>
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: SUBTLE }}>
                仅「开启」的模型可在对话界面的模型下拉框中切换使用
              </span>
            </div>

            <Card style={{ overflow: "hidden", marginBottom: 18 }}>
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: `1px solid ${BORDER}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 700, color: TEXT }}>模型列表</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  data-testid="model-add"
                  onClick={() => openModelEditor(null)}
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
                  添加模型
                </button>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    {["模型名称", "模型 ID", "API 地址", "能力", "上下文", "状态", "操作"].map((h) => (
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
                  {(modelsData?.models ?? []).map((m) => {
                    const isDefault = modelsData?.selected === m.id;
                    return (
                      <tr
                        key={m.id}
                        data-testid={`model-row-${m.id}`}
                        style={{ borderBottom: "1px solid #F1F5F9" }}
                      >
                        <td style={{ padding: "12px 16px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>{m.name}</span>
                            {isDefault ? <Tag tone="blue">默认</Tag> : null}
                            {m.vision ? <Tag tone="green">图片</Tag> : null}
                          </div>
                        </td>
                        <td style={{ padding: "12px 16px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                          <code
                            style={{
                              fontSize: 12,
                              color: TEXT,
                              background: "#F1F5F9",
                              padding: "2px 7px",
                              borderRadius: 5,
                            }}
                          >
                            {m.id}
                          </code>
                        </td>
                        <td
                          style={{
                            padding: "12px 16px",
                            verticalAlign: "middle",
                            fontSize: 12,
                            color: MUTED,
                            maxWidth: 240,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={m.base_url}
                        >
                          {m.base_url}
                        </td>
                        <td style={{ padding: "12px 16px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 12, color: MUTED }}>
                              {m.vision ? "多模态" : "纯文本"}
                            </span>
                          </div>
                        </td>
                        <td
                          style={{
                            padding: "12px 16px",
                            verticalAlign: "middle",
                            fontSize: 12,
                            color: MUTED,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.context_length >= 1024 * 1024 && m.context_length % (1024 * 1024) === 0
                            ? `${m.context_length / (1024 * 1024)}M`
                            : m.context_length >= 1024
                              ? `${Math.round(m.context_length / 1024)}K`
                              : String(m.context_length)}
                        </td>
                        <td style={{ padding: "12px 16px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Tag tone={m.enabled ? "green" : "gray"}>{m.enabled ? "已开启" : "已关闭"}</Tag>
                          </div>
                        </td>
                        <td style={{ padding: "12px 16px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <button
                              type="button"
                              data-testid={`model-edit-${m.id}`}
                              onClick={() => openModelEditor(m)}
                              style={miniBtn(false)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              data-testid={`model-toggle-${m.id}`}
                              disabled={busyModel === m.id}
                              onClick={() => setModelEnabled(m, !m.enabled)}
                              style={miniBtn(false, busyModel === m.id)}
                            >
                              {m.enabled ? "关闭" : "开启"}
                            </button>
                            <button
                              type="button"
                              data-testid={`model-delete-${m.id}`}
                              onClick={() => setModelDelete(m)}
                              style={miniBtn(true)}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {modelsData && modelsData.models.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: "28px 16px", textAlign: "center", color: SUBTLE, fontSize: 13 }}>
                        暂无模型，点击右上角「添加模型」开始配置
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Card>

            <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 12, lineHeight: 1.7 }}>
              模型配置与系统提示词、工具开关一样**按请求生效**：在对话界面的模型下拉框切换后，
              下一条消息即由新模型处理。关闭某个模型只会让它从下拉框消失，不影响已有历史消息。
              API Key 留空表示沿用现有配置（首次配置留空则回落到服务端环境变量）。
            </div>
          </>
        )}
        {/* ==================== 用量统计（token 消耗） ==================== */}
        {tab === "usage" && (
          <div style={{ marginTop: 4 }}>
            {/* 口径切换 + 说明 */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <div style={{ display: "inline-flex", border: `1px solid ${BORDER}`, borderRadius: 9, overflow: "hidden" }}>
                {(["all", "today"] as const).map((sc) => (
                  <button
                    key={sc}
                    data-testid={`usage-scope-${sc}`}
                    onClick={() => {
                      setUsageScope(sc);
                      loadTokenUsage(sc);
                    }}
                    style={{
                      padding: "7px 16px",
                      fontSize: 12.5,
                      fontWeight: usageScope === sc ? 600 : 400,
                      fontFamily: "inherit",
                      border: "none",
                      cursor: "pointer",
                      background: usageScope === sc ? PRIMARY : "#fff",
                      color: usageScope === sc ? "#fff" : MUTED,
                    }}
                  >
                    {sc === "all" ? "累计" : "今日"}
                  </button>
                ))}
              </div>
              <button
                data-testid="usage-refresh"
                onClick={() => loadTokenUsage(usageScope)}
                disabled={usageLoading}
                style={{
                  padding: "7px 14px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  border: `1px solid ${BORDER}`,
                  background: "#fff",
                  color: TEXT,
                  cursor: usageLoading ? "not-allowed" : "pointer",
                  opacity: usageLoading ? 0.6 : 1,
                }}
              >
                {usageLoading ? "刷新中…" : "刷新"}
              </button>
              <span style={{ fontSize: 11.5, color: SUBTLE, lineHeight: 1.6 }}>
                {usageData?.viewer.restricted
                  ? "口径：只统计归属本人的记录（真实用量优先，供应商未回时按字符数估算）。"
                  : "口径：agent_metrics 全表求和（真实用量优先，供应商未回时按字符数估算）。"}
              </span>
            </div>

            {!usageData ? (
              <div style={{ ...CARD, padding: 40, textAlign: "center", color: MUTED, fontSize: 13 }}>
                {usageLoading ? "加载中…" : "暂无数据"}
              </div>
            ) : (
              <>
                {/* 总量卡 */}
                <div
                  data-testid="usage-totals"
                  style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}
                >
                  {[
                    { k: "总 token", v: usageData.totals.total_tokens, c: PRIMARY },
                    { k: "输入 token", v: usageData.totals.prompt_tokens, c: "#0F6E56" },
                    { k: "输出 token", v: usageData.totals.completion_tokens, c: "#BA7517" },
                    { k: "对话轮数", v: usageData.totals.turns, c: "#534AB7" },
                  ].map((it) => (
                    <div key={it.k} style={{ ...CARD, padding: "16px 18px" }}>
                      <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 6 }}>{it.k}</div>
                      <div
                        data-testid={`usage-total-${it.k}`}
                        style={{ fontSize: 22, fontWeight: 600, color: it.c, fontVariantNumeric: "tabular-nums" }}
                      >
                        {it.v.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>

                {/* 按用户明细 */}
                <div style={{ ...CARD, padding: 0, overflow: "hidden" }}>
                  <div
                    style={{
                      padding: "13px 18px",
                      borderBottom: `1px solid ${BORDER}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div data-testid="usage-users-head" style={{ fontSize: 13.5, fontWeight: 600, color: TEXT }}>
                      {usageData.viewer.restricted ? "我的用量" : "按用户统计"}
                      <span style={{ fontSize: 11.5, fontWeight: 400, color: MUTED, marginLeft: 8 }}>
                        {usageData.viewer.restricted
                          ? "仅显示本人（管理员可查看全部用户）"
                          : `共 ${usageData.user_count} 个用户`}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div
                        data-testid="usage-scope-hint"
                        style={{
                          fontSize: 11.5,
                          padding: "4px 10px",
                          borderRadius: 6,
                          fontWeight: 600,
                          background: usageData.viewer.restricted ? "#EFF6FF" : "#F1F5F9",
                          color: usageData.viewer.restricted ? "#1D4ED8" : MUTED,
                        }}
                      >
                        {usageData.viewer.restricted ? "范围：仅本人" : "范围：全部用户"}
                      </div>
                      <div
                        data-testid="usage-selfcheck"
                        style={{
                          fontSize: 11.5,
                          padding: "4px 10px",
                          borderRadius: 6,
                          fontWeight: 600,
                          background: usageData.self_check.consistent ? "#EAF3DE" : "#FCEBEB",
                          color: usageData.self_check.consistent ? "#3B6D11" : "#A32D2D",
                        }}
                      >
                        {usageData.self_check.consistent
                          ? `合计一致 · ${usageData.self_check.users_sum.toLocaleString()} = 总量`
                          : `⚠️ 合计 ${usageData.self_check.users_sum.toLocaleString()} ≠ 总量 ${usageData.self_check.grand_total.toLocaleString()}`}
                      </div>
                    </div>
                  </div>

                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                      <thead>
                        <tr style={{ background: "#F8FAFC", color: MUTED }}>
                          {["用户", "角色", "总 token", "占比", "本月额度", "输入", "输出", "轮数", "工具调用", "最近使用"].map((h) => (
                            <th
                              key={h}
                              style={{
                                textAlign: h === "用户" || h === "角色" || h === "最近使用" ? "left" : "right",
                                padding: "9px 14px",
                                fontWeight: 600,
                                fontSize: 11.5,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {usageData.users.length === 0 ? (
                          <tr>
                            <td colSpan={10} style={{ padding: 28, textAlign: "center", color: SUBTLE }}>
                              暂无消耗记录
                            </td>
                          </tr>
                        ) : (
                          usageData.users.map((u, i) => (
                            <tr
                              key={`${u.phone}-${u.name}-${i}`}
                              data-testid={`usage-row-${i}`}
                              style={{ borderTop: `1px solid ${BORDER}` }}
                            >
                              <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                                <span style={{ fontWeight: 500, color: u.known ? TEXT : SUBTLE }}>{u.name}</span>
                                {u.phone ? (
                                  <span style={{ color: SUBTLE, marginLeft: 6, fontSize: 11 }}>{u.phone}</span>
                                ) : null}
                              </td>
                              <td style={{ padding: "10px 14px", color: MUTED, whiteSpace: "nowrap" }}>
                                {u.role_name || "—"}
                              </td>
                              <td
                                style={{
                                  padding: "10px 14px",
                                  textAlign: "right",
                                  fontWeight: 600,
                                  color: TEXT,
                                  fontVariantNumeric: "tabular-nums",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {u.total_tokens.toLocaleString()}
                              </td>
                              <td style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                                  <div style={{ width: 56, height: 6, borderRadius: 3, background: "#F1EFE8", overflow: "hidden" }}>
                                    <div
                                      style={{
                                        width: `${Math.min(100, u.percent)}%`,
                                        height: "100%",
                                        background: u.known ? PRIMARY : SUBTLE,
                                      }}
                                    />
                                  </div>
                                  <span style={{ color: MUTED, fontVariantNumeric: "tabular-nums", fontSize: 11.5 }}>
                                    {u.percent.toFixed(2)}%
                                  </span>
                                </div>
                              </td>
                              {/* 本月额度（每人各自）：进度条 + 已用/额度 */}
                              <td
                                data-testid={`usage-quota-${i}`}
                                style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}
                              >
                                {!u.known ? (
                                  <span style={{ color: SUBTLE, fontSize: 11.5 }}>—</span>
                                ) : u.quota_unlimited ? (
                                  <span style={{ color: MUTED, fontSize: 11.5 }}>不限额</span>
                                ) : (
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                                    <div style={{ width: 56, height: 6, borderRadius: 3, background: "#F1EFE8", overflow: "hidden" }}>
                                      <div
                                        style={{
                                          width: `${Math.min(100, u.quota_percent)}%`,
                                          height: "100%",
                                          background: u.quota_exceeded ? "#DC2626" : u.quota_percent >= 80 ? "#D97706" : "#0F6E56",
                                        }}
                                      />
                                    </div>
                                    <span
                                      style={{
                                        color: u.quota_exceeded ? "#DC2626" : MUTED,
                                        fontSize: 11.5,
                                        fontVariantNumeric: "tabular-nums",
                                        fontWeight: u.quota_exceeded ? 600 : 400,
                                      }}
                                    >
                                      {u.month_used.toLocaleString()} / {(u.quota / 10000).toLocaleString()}万
                                      {u.quota_exceeded ? " · 已用完" : ""}
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                                {u.prompt_tokens.toLocaleString()}
                              </td>
                              <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                                {u.completion_tokens.toLocaleString()}
                              </td>
                              <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                                {u.turns}
                              </td>
                              <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                                {u.tool_calls}
                              </td>
                              <td style={{ padding: "10px 14px", color: SUBTLE, whiteSpace: "nowrap", fontSize: 11.5 }}>
                                {u.last_ts ? u.last_ts.replace("T", " ").slice(0, 16) : "—"}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                      <tfoot>
                        <tr
                          data-testid="usage-footer"
                          style={{ borderTop: `2px solid ${BORDER}`, background: "#F8FAFC", fontWeight: 600 }}
                        >
                          <td style={{ padding: "10px 14px", color: TEXT }} colSpan={2}>
                            合计
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", color: PRIMARY, fontVariantNumeric: "tabular-nums" }}>
                            {usageData.self_check.users_sum.toLocaleString()}
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED }}>100%</td>
                          {/* 本月额度列：合计无意义（每人是各自的额度），给一行说明 */}
                          <td
                            data-testid="usage-footer-quota"
                            style={{ padding: "10px 14px", textAlign: "right", color: SUBTLE, fontSize: 11.5, fontWeight: 400 }}
                          >
                            每人各自
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                            {usageData.users.reduce((s, u) => s + u.prompt_tokens, 0).toLocaleString()}
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                            {usageData.users.reduce((s, u) => s + u.completion_tokens, 0).toLocaleString()}
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                            {usageData.users.reduce((s, u) => s + u.turns, 0)}
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
                            {usageData.users.reduce((s, u) => s + u.tool_calls, 0)}
                          </td>
                          <td style={{ padding: "10px 14px" }} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {usageData.users.some((u) => !u.known) ? (
                    <div
                      data-testid="usage-unknown-hint"
                      style={{
                        padding: "11px 18px",
                        borderTop: `1px solid ${BORDER}`,
                        fontSize: 11.5,
                        lineHeight: 1.7,
                        color: "#B45309",
                        background: "#FFFBEB",
                      }}
                    >
                      「未知用户」是启用归属记录之前的历史消耗（无法追溯是谁用的）。它计入总量，
                      因此在人均表里也保留一行 —— 否则各行相加会小于总量。
                    </div>
                  ) : null}
                </div>

                {usageData.totals.estimated_turns > 0 ? (
                  <div style={{ marginTop: 12, fontSize: 11.5, color: "#B45309", lineHeight: 1.7 }}>
                    其中 {usageData.totals.estimated_turns} 轮的用量是<span style={{ fontWeight: 600 }}>按字符数估算</span>的
                    （供应商未返回真实用量），与真实值有偏差。
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}

      </main>

      {/* ==================== 编辑渠道凭证弹窗 ==================== */}
      <Modal
        open={!!channelEdit}
        onClose={() => setChannelEdit(null)}
        title={`编辑渠道凭证 · ${channelEdit?.label ?? ""}`}
        width="480px"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
              飞书 App ID
            </label>
            <input
              value={channelAppId}
              onChange={(e) => setChannelAppId(e.target.value)}
              placeholder="cli_xxxxxxxxxxxxxxxx"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #E2E8F0",
                fontSize: 13.5,
                color: "#0F172A",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
              飞书 App Secret
            </label>
            <input
              type="password"
              value={channelAppSecret}
              onChange={(e) => setChannelAppSecret(e.target.value)}
              placeholder="输入新的 App Secret"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #E2E8F0",
                fontSize: 13.5,
                color: "#0F172A",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 12px",
              borderRadius: 8,
              background: "#F8FAFC",
            }}
          >
            <span style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
              搜通讯录需用户授权，token 失效或需换账号时可重新授权
            </span>
            <button
              type="button"
              data-testid="channel-reauth"
              onClick={reauthorizeChannel}
              style={{
                padding: "6px 14px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                border: "1px solid #C7D2FE",
                background: "#EEF2FF",
                color: "#4338CA",
                whiteSpace: "nowrap",
              }}
            >
              重新授权
            </button>
          </div>
          {channelError && (
            <div style={{ padding: "10px 12px", borderRadius: 8, background: "#FEF2F2", color: "#DC2626", fontSize: 13 }}>
              {channelError}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setChannelEdit(null)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                border: `1px solid ${BORDER}`,
                background: "#fff",
                color: MUTED,
              }}
            >
              取消
            </button>
            <button
              type="button"
              data-testid="channel-save"
              onClick={saveChannelCredentials}
              disabled={channelSaving}
              style={{
                padding: "8px 18px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: channelSaving ? "wait" : "pointer",
                border: "none",
                background: PRIMARY,
                color: "#fff",
                opacity: channelSaving ? 0.6 : 1,
              }}
            >
              {channelSaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ==================== 编辑/新增记忆弹窗 ==================== */}
      <Modal
        open={!!memoryEdit}
        onClose={() => setMemoryEdit(null)}
        title={memoryEdit?.key ? `编辑记忆 · ${memoryEdit.key}` : "新增记忆"}
        width="560px"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
              记忆的 Key
            </label>
            <input
              value={memoryEditKey}
              onChange={(e) => setMemoryEditKey(e.target.value)}
              placeholder="如 user_name、user_favorite_color"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #E2E8F0",
                fontSize: 13.5,
                color: "#0F172A",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
              记忆内容
            </label>
            <textarea
              value={memoryEditValue}
              onChange={(e) => setMemoryEditValue(e.target.value)}
              rows={5}
              placeholder="记忆的内容，跨会话持久保存"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #E2E8F0",
                fontSize: 13.5,
                lineHeight: 1.6,
                color: "#0F172A",
                boxSizing: "border-box",
                outline: "none",
                resize: "vertical",
              }}
            />
          </div>
          {memoryError && (
            <div style={{ padding: "10px 12px", borderRadius: 8, background: "#FEF2F2", color: "#DC2626", fontSize: 13 }}>
              {memoryError}
            </div>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setMemoryEdit(null)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                border: `1px solid ${BORDER}`,
                background: "#fff",
                color: MUTED,
              }}
            >
              取消
            </button>
            <button
              type="button"
              data-testid="memory-save"
              onClick={saveMemory}
              disabled={memorySaving}
              style={{
                padding: "8px 18px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: memorySaving ? "wait" : "pointer",
                border: "none",
                background: PRIMARY,
                color: "#fff",
                opacity: memorySaving ? 0.6 : 1,
              }}
            >
              {memorySaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ==================== 删除记忆确认弹窗 ==================== */}
      <Modal
        open={!!memoryDelete}
        onClose={() => setMemoryDelete(null)}
        title="删除记忆"
        width="440px"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ fontSize: 13.5, color: "#334155", lineHeight: 1.7, margin: 0 }}>
            确定要删除记忆 <code style={{ background: "#F1F5F9", padding: "1px 6px", borderRadius: 4 }}>{memoryDelete?.key}</code> 吗？
            删除后无法恢复。
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setMemoryDelete(null)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                border: `1px solid ${BORDER}`,
                background: "#fff",
                color: MUTED,
              }}
            >
              取消
            </button>
            <button
              type="button"
              data-testid="memory-delete-confirm"
              onClick={confirmDeleteMemory}
              disabled={memoryDeleting}
              style={{
                padding: "8px 18px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: memoryDeleting ? "wait" : "pointer",
                border: "none",
                background: "#DC2626",
                color: "#fff",
                opacity: memoryDeleting ? 0.6 : 1,
              }}
            >
              {memoryDeleting ? "删除中…" : "删除"}
            </button>
          </div>
        </div>
      </Modal>

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

      {/* ==================== 编辑/新增模型弹窗 ==================== */}
      <Modal
        open={!!modelDraft}
        onClose={() => {
          if (modelSaving) return;
          setModelDraft(null);
        }}
        title={modelEdit ? `编辑模型 · ${modelEdit.name}` : "添加模型"}
        width="560px"
      >
        {modelDraft ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                模型 ID <span style={{ color: "#DC2626" }}>*</span>
              </label>
              <input
                data-testid="model-field-id"
                value={modelDraft.id}
                disabled={!!modelEdit}
                onChange={(e) => setModelDraft({ ...modelDraft, id: e.target.value })}
                placeholder="如 deepseek-flash"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #E2E8F0",
                  fontSize: 13.5,
                  color: "#0F172A",
                  boxSizing: "border-box",
                  outline: "none",
                  background: modelEdit ? "#F8FAFC" : "#fff",
                }}
              />
              <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 5 }}>
                仅支持字母、数字、连字符、下划线；创建后不可修改
              </div>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                模型名称（传给供应商的 model 名） <span style={{ color: "#DC2626" }}>*</span>
              </label>
              <input
                data-testid="model-field-name"
                value={modelDraft.name}
                onChange={(e) => setModelDraft({ ...modelDraft, name: e.target.value })}
                placeholder="如 deepseek-flash"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #E2E8F0",
                  fontSize: 13.5,
                  color: "#0F172A",
                  boxSizing: "border-box",
                  outline: "none",
                }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                API 地址（base_url） <span style={{ color: "#DC2626" }}>*</span>
              </label>
              <input
                data-testid="model-field-base-url"
                value={modelDraft.base_url}
                onChange={(e) => setModelDraft({ ...modelDraft, base_url: e.target.value })}
                placeholder="https://api.deepseek.com/v1"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #E2E8F0",
                  fontSize: 13.5,
                  color: "#0F172A",
                  boxSizing: "border-box",
                  outline: "none",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                模型 Key
              </label>
              <input
                data-testid="model-field-api-key"
                type="password"
                value={modelDraft.api_key}
                onChange={(e) => setModelDraft({ ...modelDraft, api_key: e.target.value })}
                placeholder={
                  modelEdit?.key_configured
                    ? "••••••••（留空表示不修改）"
                    : "留空则使用服务端环境变量 OPENAI_API_KEY"
                }
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #E2E8F0",
                  fontSize: 13.5,
                  color: "#0F172A",
                  boxSizing: "border-box",
                  outline: "none",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                }}
              />
              <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 5 }}>
                {modelEdit
                  ? modelEdit.key_from_env
                    ? "当前 Key 来自服务端环境变量；填写后将改为独立配置"
                    : "当前已配置独立 Key；留空表示保持原值"
                  : "留空表示不单独配置，沿用服务端环境变量"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "0 0 auto" }}>
                <label
                  style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 8 }}
                >
                  是否支持图片识别
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <Switch
                    checked={modelDraft.vision}
                    onChange={(v) => setModelDraft({ ...modelDraft, vision: v })}
                  />
                  <span style={{ fontSize: 12.5, color: MUTED }}>
                    {modelDraft.vision ? "多模态（可传图片）" : "纯文本"}
                  </span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label
                  style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}
                >
                  上下文长度（token）
                </label>
                <input
                  data-testid="model-field-context"
                  type="number"
                  min={1}
                  value={modelDraft.context_length}
                  onChange={(e) => setModelDraft({ ...modelDraft, context_length: e.target.value })}
                  placeholder="1048576"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #E2E8F0",
                    fontSize: 13.5,
                    color: "#0F172A",
                    boxSizing: "border-box",
                    outline: "none",
                  }}
                />
                <div style={{ fontSize: 11.5, color: SUBTLE, marginTop: 5 }}>默认 1048576 = 1M</div>
              </div>
            </div>
            {modelError && (
              <div
                data-testid="model-error"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "#FEF2F2",
                  color: "#DC2626",
                  fontSize: 13,
                }}
              >
                {modelError}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setModelDraft(null)}
                disabled={modelSaving}
                style={{
                  padding: "9px 16px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13,
                  border: `1px solid ${BORDER}`,
                  cursor: modelSaving ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  background: "#fff",
                  color: MUTED,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="model-save"
                onClick={saveModel}
                disabled={modelSaving}
                style={{
                  padding: "9px 18px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13,
                  border: "none",
                  fontFamily: "inherit",
                  background: PRIMARY,
                  color: "#fff",
                  cursor: modelSaving ? "not-allowed" : "pointer",
                  opacity: modelSaving ? 0.6 : 1,
                }}
              >
                {modelSaving ? "保存中…" : modelEdit ? "保存" : "添加"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ==================== 删除模型确认弹窗 ==================== */}
      <Modal
        open={!!modelDelete}
        onClose={() => {
          if (modelDeleting) return;
          setModelDelete(null);
        }}
        title="删除模型"
        width="460px"
      >
        {modelDelete ? (
          <div>
            <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.7 }}>
              确认删除模型{" "}
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
                {modelDelete.name}
              </code>
              （{modelDelete.id}）？删除后该模型不再出现在对话界面的模型下拉框中。
            </div>
            {modelsData?.selected === modelDelete.id ? (
              <div
                style={{
                  marginTop: 10,
                  padding: "9px 12px",
                  borderRadius: 9,
                  fontSize: 12,
                  lineHeight: 1.6,
                  background: "#FFFBEB",
                  border: "1px solid #FDE68A",
                  color: "#B45309",
                }}
              >
                这是当前默认模型，删除后会自动切换到其它已开启的模型。
              </div>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => setModelDelete(null)}
                disabled={modelDeleting}
                style={{
                  padding: "9px 16px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13,
                  border: `1px solid ${BORDER}`,
                  cursor: modelDeleting ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  background: "#fff",
                  color: MUTED,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="model-delete-confirm"
                onClick={confirmDeleteModel}
                disabled={modelDeleting}
                style={{
                  padding: "9px 18px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13,
                  border: "none",
                  fontFamily: "inherit",
                  background: "#DC2626",
                  color: "#fff",
                  cursor: modelDeleting ? "not-allowed" : "pointer",
                  opacity: modelDeleting ? 0.55 : 1,
                }}
              >
                {modelDeleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
