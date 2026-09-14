"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./Sidebar";
import { usePermission } from "@/hooks/usePermission";
import type {
  PanelConfig,
  PanelModelCheck,
  PanelOverview,
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

/* ============================ 主体 ============================ */

export default function AgentPanelDashboard() {
  const perm = usePermission("agent");

  const [tab, setTab] = useState<"overview" | "config">("overview");
  const [subTab, setSubTab] = useState<"prompt" | "tools" | "policy">("prompt");

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

  useEffect(() => {
    loadOverview();
    loadConfig();
    // 首次进入即做一次模型连通性探测（服务端有 20s 缓存，不会重复打模型）
    runModelCheck(false);
  }, [loadOverview, loadConfig, runModelCheck]);

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
              查看 Agent 运行状态与能力，并配置系统提示词、可用工具与工具权限
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                loadOverview();
                loadConfig();
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
      </main>
    </div>
  );
}
