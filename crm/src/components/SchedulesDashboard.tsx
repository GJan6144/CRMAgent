"use client";

import { useCallback, useEffect, useState } from "react";
import { usePermission } from "@/hooks/usePermission";
import Sidebar from "./Sidebar";
import Modal from "./Modal";
import type { ScheduledTask, SchedulePayload, ScheduleFrequency, TriggerType } from "@/types/schedule";

/* ========== 小工具 ========== */

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(hour: number, minute: number): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(hour)}:${p(minute)}`;
}

function describeTrigger(t: { trigger_type: TriggerType; hour: number; minute: number }): string {
  if (t.trigger_type === "interval") {
    const parts: string[] = [];
    if (t.hour > 0) parts.push(`${t.hour}小时`);
    if (t.minute > 0) parts.push(`${t.minute}分`);
    return `每隔 ${parts.join("") || "1分"}`;
  }
  return `每天 ${fmtClock(t.hour, t.minute)}`;
}

const FREQ_LABEL: Record<ScheduleFrequency, string> = {
  repeat: "重复",
  once: "一次",
};

const TRIGGER_LABEL: Record<TriggerType, string> = {
  daily: "定时执行",
  interval: "周期执行",
};

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  success: { label: "成功", bg: "#F0FDF4", fg: "#16A34A" },
  error: { label: "失败", bg: "#FEF2F2", fg: "#DC2626" },
  running: { label: "执行中", bg: "#EFF6FF", fg: "#2563EB" },
};

/* ========== 组件 ========== */

interface FormState {
  name: string;
  prompt: string;
  trigger_type: TriggerType;
  hour: number;
  minute: number;
  frequency: ScheduleFrequency;
  weekdays_only: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  prompt: "",
  trigger_type: "daily",
  hour: 9,
  minute: 0,
  frequency: "repeat",
  weekdays_only: false,
};

export default function SchedulesDashboard() {
  const perm = usePermission("schedules");
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // 创建/编辑弹窗
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // 测试结果弹窗
  const [testOpen, setTestOpen] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/agent/schedules", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setTasks(body.data || []);
    } catch {
      setError("无法连接 Agent 服务，请确认 chat-ui（8765）已启动。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  /* ---------- 创建 / 编辑 ---------- */

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setEditorOpen(true);
  };

  const openEdit = (t: ScheduledTask) => {
    setEditingId(t.id);
    setForm({
      name: t.name,
      prompt: t.prompt,
      trigger_type: t.trigger_type,
      hour: t.hour,
      minute: t.minute,
      frequency: t.frequency,
      weekdays_only: t.weekdays_only,
    });
    setFormError("");
    setEditorOpen(true);
  };

  // 切换触发规则时，把 hour/minute 收拢到合法区间
  const setTriggerType = (tt: TriggerType) => {
    setForm((f) => {
      let hour = f.hour;
      let minute = f.minute;
      if (tt === "interval") {
        hour = Math.min(hour, 24);
        minute = Math.max(minute, 1);
      } else {
        hour = Math.min(hour, 23);
      }
      return { ...f, trigger_type: tt, hour, minute };
    });
  };

  const saveForm = async () => {
    if (!form.name.trim() || !form.prompt.trim()) {
      setFormError("任务名与提示词不能为空");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const payload: SchedulePayload = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        trigger_type: form.trigger_type,
        hour: form.hour,
        minute: form.minute,
        frequency: form.frequency,
        weekdays_only: form.weekdays_only,
      };
      const url = editingId
        ? `/api/agent/schedules/${encodeURIComponent(editingId)}`
        : "/api/agent/schedules";
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { detail?: string }).detail || `HTTP ${res.status}`);
      }
      setEditorOpen(false);
      await fetchTasks();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /* ---------- 启停 / 删除 ---------- */

  const toggleEnabled = async (t: ScheduledTask) => {
    setBusyId(t.id);
    try {
      const res = await fetch(
        `/api/agent/schedules/${encodeURIComponent(t.id)}/enabled`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !t.enabled }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchTasks();
    } catch {
      window.alert("操作失败，请重试");
    } finally {
      setBusyId(null);
    }
  };

  const removeTask = async (t: ScheduledTask) => {
    if (!window.confirm(`确定删除定时任务「${t.name}」吗？此操作不可恢复。`)) return;
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/agent/schedules/${encodeURIComponent(t.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchTasks();
    } catch {
      window.alert("删除失败，请重试");
    } finally {
      setBusyId(null);
    }
  };

  /* ---------- 测试执行 ---------- */

  const runTest = async (prompt: string) => {
    setTestOpen(true);
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/agent/schedules/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const body = await res.json();
      if (body.ok) {
        setTestResult({ ok: true, text: body.text || "(无输出)" });
      } else {
        setTestResult({ ok: false, text: body.error || "执行失败" });
      }
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTestLoading(false);
    }
  };

  const testSavedTask = async (t: ScheduledTask) => {
    setBusyId(t.id);
    setTestOpen(true);
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/agent/schedules/${encodeURIComponent(t.id)}/test`, {
        method: "POST",
      });
      const body = await res.json();
      if (body.ok) {
        setTestResult({ ok: true, text: body.text || "(无输出)" });
      } else {
        setTestResult({ ok: false, text: body.error || "执行失败" });
      }
      await fetchTasks();
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTestLoading(false);
      setBusyId(null);
    }
  };

  /* ---------- 渲染 ---------- */

  if (!perm.canViewPage) {
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar activeItem="schedules" />
        <main style={{ flex: 1, minWidth: 0, padding: "28px 32px" }}>
          <p style={{ fontSize: 14, color: "#64748B" }}>
            当前角色没有访问「定时任务」页面的权限。
          </p>
        </main>
      </div>
    );
  }

  const actionBtn = (label: string, onClick: () => void, opts?: { danger?: boolean; disabled?: boolean }) => (
    <button
      onClick={onClick}
      disabled={opts?.disabled}
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        background: opts?.danger ? "#FEF2F2" : "#EFF6FF",
        color: opts?.danger ? "#DC2626" : "#2563EB",
        fontSize: 12.5,
        fontWeight: 600,
        border: "none",
        cursor: opts?.disabled ? "wait" : "pointer",
        opacity: opts?.disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );

  const hourOptions = Array.from({ length: form.trigger_type === "interval" ? 25 : 24 }, (_, i) => i);
  const minuteOptions = Array.from(
    { length: form.trigger_type === "interval" ? 59 : 60 },
    (_, i) => (form.trigger_type === "interval" ? i + 1 : i)
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="schedules" />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          padding: "28px 32px",
          overflowY: "auto",
          height: "100vh",
        }}
      >
        {/* 页面标题 */}
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
              Agent 定时任务
            </h1>
            <p style={{ fontSize: 13, color: "#64748B", margin: "4px 0 0" }}>
              设定时间后，Agent 自动开新会话执行设定好的提示词，无需人工值守。
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={fetchTasks}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 8,
                background: "#EFF6FF",
                color: "#2563EB",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
              }}
            >
              刷新
            </button>
            {perm.canAdd && (
              <button
                onClick={openCreate}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 16px",
                  borderRadius: 8,
                  background: "#2563EB",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                创建定时任务
              </button>
            )}
          </div>
        </div>

        {/* 内容 */}
        {error && (
          <div
            style={{
              padding: "14px 16px",
              borderRadius: 10,
              background: "#FEF2F2",
              color: "#DC2626",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <p style={{ fontSize: 14, color: "#64748B" }}>加载中…</p>
        ) : tasks.length === 0 ? (
          <div
            style={{
              padding: "48px 0",
              textAlign: "center",
              color: "#94A3B8",
              fontSize: 14,
            }}
          >
            暂无定时任务。点击右上角「创建定时任务」开始设定。
          </div>
        ) : (
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: 12,
              border: "1px solid #E2E8F0",
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                  {["任务名", "提示词", "触发规则", "触发时间", "频率", "状态", "下次执行", "上次执行", "操作"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "12px 16px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#64748B",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const lastMeta = STATUS_META[t.last_status || ""];
                  return (
                    <tr key={t.id} style={{ borderBottom: "1px solid #F1F5F9" }}>
                      <td
                        style={{
                          padding: "12px 16px",
                          fontSize: 13.5,
                          color: "#0F172A",
                          fontWeight: 500,
                          maxWidth: 160,
                        }}
                      >
                        {t.name}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          fontSize: 13,
                          color: "#475569",
                          maxWidth: 220,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={t.prompt}
                      >
                        {t.prompt}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "3px 10px",
                            borderRadius: 999,
                            background: t.trigger_type === "interval" ? "#FFF7ED" : "#EFF6FF",
                            color: t.trigger_type === "interval" ? "#EA580C" : "#2563EB",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {TRIGGER_LABEL[t.trigger_type]}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 13, color: "#0F172A", fontWeight: 500, whiteSpace: "nowrap" }}>
                        {describeTrigger(t)}
                        {t.weekdays_only && (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "#F0FDF4",
                              color: "#16A34A",
                              fontSize: 11,
                              fontWeight: 600,
                              marginLeft: 6,
                            }}
                          >
                            仅工作日
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        {t.trigger_type === "daily" ? (
                          <span
                            style={{
                              display: "inline-block",
                              padding: "3px 10px",
                              borderRadius: 999,
                              background: t.frequency === "repeat" ? "#EFF6FF" : "#F5F3FF",
                              color: t.frequency === "repeat" ? "#2563EB" : "#7C3AED",
                              fontSize: 12,
                              fontWeight: 600,
                            }}
                          >
                            {FREQ_LABEL[t.frequency]}
                          </span>
                        ) : (
                          <span style={{ fontSize: 12.5, color: "#94A3B8" }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "3px 10px",
                            borderRadius: 999,
                            background: t.enabled ? "#F0FDF4" : "#F1F5F9",
                            color: t.enabled ? "#16A34A" : "#64748B",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {t.enabled ? "运行中" : "已停止"}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 12.5, color: "#475569", whiteSpace: "nowrap" }}>
                        {fmtDateTime(t.next_run_at)}
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 12.5, color: "#475569", whiteSpace: "nowrap" }}>
                        {t.last_run_at ? (
                          <span title={t.last_result || ""}>
                            {lastMeta ? (
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: 999,
                                  background: lastMeta.bg,
                                  color: lastMeta.fg,
                                  fontSize: 11.5,
                                  fontWeight: 600,
                                  marginRight: 6,
                                }}
                              >
                                {lastMeta.label}
                              </span>
                            ) : null}
                            {fmtDateTime(t.last_run_at)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {perm.canEdit && actionBtn("编辑", () => openEdit(t))}
                          {perm.canEdit &&
                            actionBtn(
                              t.enabled ? "停止" : "开启",
                              () => toggleEnabled(t),
                              { disabled: busyId === t.id }
                            )}
                          {actionBtn("测试", () => testSavedTask(t), { disabled: busyId === t.id })}
                          {perm.canDelete && actionBtn("删除", () => removeTask(t), { danger: true, disabled: busyId === t.id })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* 创建 / 编辑弹窗 */}
      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingId ? "编辑定时任务" : "创建定时任务"}
        width="560px"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
              定时任务名
            </label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="例如：每日销售数据汇总"
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
              任务执行提示词
            </label>
            <textarea
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
              placeholder="Agent 每次执行时的提示词，例如：帮我统计昨天的订单数量和销售额，并生成一份简报。"
              rows={4}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #E2E8F0",
                fontSize: 13.5,
                color: "#0F172A",
                boxSizing: "border-box",
                outline: "none",
                resize: "vertical",
                fontFamily: "inherit",
                lineHeight: 1.6,
              }}
            />
          </div>

          {/* 触发规则 */}
          <div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
              触发规则
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              {(["daily", "interval"] as TriggerType[]).map((tt) => (
                <button
                  key={tt}
                  onClick={() => setTriggerType(tt)}
                  style={{
                    padding: "9px 16px",
                    borderRadius: 8,
                    border: form.trigger_type === tt ? "1px solid #2563EB" : "1px solid #E2E8F0",
                    background: form.trigger_type === tt ? "#EFF6FF" : "#fff",
                    color: form.trigger_type === tt ? "#2563EB" : "#475569",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {TRIGGER_LABEL[tt]}
                </button>
              ))}
            </div>
          </div>

          {/* 时间 */}
          <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
            <div>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                {form.trigger_type === "daily" ? "触发时间点" : "间隔时长"}
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <select
                  value={form.hour}
                  onChange={(e) => setForm((f) => ({ ...f, hour: Number(e.target.value) }))}
                  style={{
                    padding: "9px 10px",
                    borderRadius: 8,
                    border: "1px solid #E2E8F0",
                    fontSize: 13.5,
                    color: "#0F172A",
                    outline: "none",
                  }}
                >
                  {hourOptions.map((i) => (
                    <option key={i} value={i}>
                      {String(i).padStart(2, "0")}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: 13, color: "#64748B" }}>{form.trigger_type === "daily" ? "时" : "小时"}</span>
                <select
                  value={form.minute}
                  onChange={(e) => setForm((f) => ({ ...f, minute: Number(e.target.value) }))}
                  style={{
                    padding: "9px 10px",
                    borderRadius: 8,
                    border: "1px solid #E2E8F0",
                    fontSize: 13.5,
                    color: "#0F172A",
                    outline: "none",
                  }}
                >
                  {minuteOptions.map((i) => (
                    <option key={i} value={i}>
                      {String(i).padStart(2, "0")}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: 13, color: "#64748B" }}>{form.trigger_type === "daily" ? "分" : "分钟"}</span>
              </div>
            </div>

            {/* 频率：仅定时执行有「一次」概念 */}
            {form.trigger_type === "daily" && (
              <div>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                  执行频率
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  {(["repeat", "once"] as ScheduleFrequency[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setForm((s) => ({ ...s, frequency: f }))}
                      style={{
                        padding: "9px 16px",
                        borderRadius: 8,
                        border: form.frequency === f ? "1px solid #2563EB" : "1px solid #E2E8F0",
                        background: form.frequency === f ? "#EFF6FF" : "#fff",
                        color: form.frequency === f ? "#2563EB" : "#475569",
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {FREQ_LABEL[f]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 仅工作日 */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: "#334155",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={form.weekdays_only}
              onChange={(e) => setForm((f) => ({ ...f, weekdays_only: e.target.checked }))}
              style={{ width: 16, height: 16, accentColor: "#2563EB" }}
            />
            仅工作日执行（周一至周五，跳过周六、周日）
          </label>

          {formError && (
            <div style={{ padding: "10px 12px", borderRadius: 8, background: "#FEF2F2", color: "#DC2626", fontSize: 13 }}>
              {formError}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              onClick={() => runTest(form.prompt.trim())}
              disabled={!form.prompt.trim() || saving}
              style={{
                padding: "9px 16px",
                borderRadius: 8,
                background: "#F5F3FF",
                color: "#7C3AED",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                cursor: form.prompt.trim() && !saving ? "pointer" : "not-allowed",
                opacity: form.prompt.trim() && !saving ? 1 : 0.5,
              }}
            >
              测试
            </button>
            <button
              onClick={() => setEditorOpen(false)}
              style={{
                padding: "9px 16px",
                borderRadius: 8,
                background: "#F1F5F9",
                color: "#475569",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
              }}
            >
              取消
            </button>
            <button
              onClick={saveForm}
              disabled={saving}
              style={{
                padding: "9px 18px",
                borderRadius: 8,
                background: "#2563EB",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                border: "none",
                cursor: saving ? "wait" : "pointer",
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </Modal>

      {/* 测试结果弹窗 */}
      <Modal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        title="测试执行结果"
        width="640px"
      >
        {testLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: "#64748B", fontSize: 14 }}>
            Agent 正在执行，请稍候…
          </div>
        ) : testResult ? (
          <div>
            <div
              style={{
                display: "inline-block",
                padding: "3px 10px",
                borderRadius: 999,
                background: testResult.ok ? "#F0FDF4" : "#FEF2F2",
                color: testResult.ok ? "#16A34A" : "#DC2626",
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 12,
              }}
            >
              {testResult.ok ? "执行成功" : "执行失败"}
            </div>
            <div
              style={{
                maxHeight: 360,
                overflowY: "auto",
                padding: "12px 14px",
                borderRadius: 8,
                background: "#F8FAFC",
                fontSize: 13,
                color: "#0F172A",
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {testResult.text}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
