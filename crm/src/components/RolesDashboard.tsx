"use client";

import { useState, useEffect, useCallback } from "react";
import type { Role, RoleListResponse, PermissionItem, CreateRoleRequest } from "@/types/role";
import { AVAILABLE_PAGES, AVAILABLE_FUNCTIONS, DATA_SCOPES, DEFAULT_MONTHLY_TOKEN_QUOTA, QUOTA_PRESETS, QUOTA_EXCEEDED_TEXT } from "@/types/role";
import Sidebar from "./Sidebar";
import Modal from "./Modal";
import { usePermission } from "@/hooks/usePermission";

/**
 * 「数据权限」的语义补充说明（按页面给）。
 * 目前只有「AI 助手」页需要 —— 它的数据权限不止影响页面展示，还会**约束 Agent
 * 里所有 CRM 读写工具**的有效范围（服务端读同一份 roles.json 判定）。
 */
const PAGE_SCOPE_HINTS: Record<string, { 全部: string; 仅自己: string }> = {
  chat: {
    全部: "Agent 可读写全部 CRM 数据。",
    仅自己: "Agent 仅能读写归属自己的 CRM 数据（新增自动归属自己，改/删他人数据会被拒绝）。",
  },
};

/* ========== 输入框样式 ========== */
const INPUT_STYLE: React.CSSProperties = {
  padding: "7px 10px",
  border: "1px solid #E2E8F0",
  borderRadius: 8,
  fontSize: 13,
  fontFamily: "inherit",
  color: "#1E293B",
  background: "#fff",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

/* ========== 权限标签 ========== */
function PermissionTag({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: `${color}15`, color }}>
      {label}
    </span>
  );
}

/* ========== 权限设置弹窗 ========== */
function PermissionSettingsModal({
  open,
  onClose,
  permissions,
  onSave,
  roleName,
  quota,
}: {
  open: boolean;
  onClose: () => void;
  permissions: PermissionItem[];
  onSave: (perms: PermissionItem[], quota: number) => void;
  roleName: string;
  quota: number;
}) {
  const [localPerms, setLocalPerms] = useState<PermissionItem[]>([]);
  const [quotaInput, setQuotaInput] = useState<string>(String(DEFAULT_MONTHLY_TOKEN_QUOTA));

  useEffect(() => {
    if (open) {
      setLocalPerms(JSON.parse(JSON.stringify(permissions)));
      setQuotaInput(String(quota ?? DEFAULT_MONTHLY_TOKEN_QUOTA));
    }
  }, [open, permissions, quota]);

  // 额度校验：空 → 默认值；非法/负数 → 报错；0 = 不限额
  const quotaNum = Number(quotaInput);
  const quotaValid =
    quotaInput.trim() !== "" && Number.isFinite(quotaNum) && quotaNum >= 0 && Number.isInteger(quotaNum);

  const handleSave = () => {
    if (!quotaValid) return;
    onSave(localPerms, quotaNum);
  };

  const isPageSelected = (pageKey: string) => localPerms.some((p) => p.pageKey === pageKey);

  const togglePage = (pageKey: string) => {
    const page = AVAILABLE_PAGES.find((p) => p.key === pageKey);
    if (!page) return;

    if (isPageSelected(pageKey)) {
      setLocalPerms((prev) => prev.filter((p) => p.pageKey !== pageKey));
    } else {
      setLocalPerms((prev) => [
        ...prev,
        { pageKey: page.key, pageLabel: page.label, functions: [], dataScope: "仅自己" },
      ]);
    }
  };

  const toggleFunction = (pageKey: string, fn: string) => {
    setLocalPerms((prev) =>
      prev.map((p) => {
        if (p.pageKey !== pageKey) return p;
        const has = p.functions.includes(fn);
        return {
          ...p,
          functions: has ? p.functions.filter((f) => f !== fn) : [...p.functions, fn],
        };
      })
    );
  };

  const setDataScope = (pageKey: string, scope: "全部" | "仅自己") => {
    setLocalPerms((prev) =>
      prev.map((p) => (p.pageKey === pageKey ? { ...p, dataScope: scope } : p))
    );
  };

  // ⚠️ bodyPadding 底部置 0：底部内边距交给吸底操作区自己的 padding 承担，
  // 否则 sticky 按钮行永远盖不住 body 的 padding-bottom，那里会漏出下层内容。
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`权限设置 - ${roleName}`}
      width="720px"
      bodyPadding="24px 24px 0"
    >
      <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12, lineHeight: 1.5 }}>
        勾选页面以启用权限，并在对应行设置功能权限和数据权限。
      </div>

      {/* 表头 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "160px 1fr 180px",
          gap: 12,
          padding: "8px 12px",
          background: "#F8FAFC",
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 600,
          color: "#64748B",
          marginBottom: 8,
        }}
      >
        <div>页面</div>
        <div>功能权限（可多选）</div>
        <div>数据权限（二选一）</div>
      </div>

      {/* 列表 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {AVAILABLE_PAGES.map((page) => {
          const selected = isPageSelected(page.key);
          const perm = localPerms.find((p) => p.pageKey === page.key);

          return (
            <div
              key={page.key}
              style={{
                display: "grid",
                gridTemplateColumns: "160px 1fr 180px",
                gap: 12,
                alignItems: "center",
                padding: "10px 12px",
                borderRadius: 8,
                background: selected ? "#EFF6FF" : "#F8FAFC",
                border: `1px solid ${selected ? "#BFDBFE" : "#E2E8F0"}`,
                transition: "all 0.15s",
              }}
            >
              {/* 页面勾选 */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => togglePage(page.key)}
                  style={{ width: 16, height: 16, accentColor: "#2563EB", cursor: "pointer", flexShrink: 0 }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{page.label}</span>
              </label>

              {/* 功能权限 */}
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", opacity: selected ? 1 : 0.4, pointerEvents: selected ? "auto" : "none" }}>
                {AVAILABLE_FUNCTIONS.map((fn) => (
                  <label
                    key={fn}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      cursor: "pointer",
                      fontSize: 12,
                      color: selected && perm?.functions.includes(fn) ? "#2563EB" : "#64748B",
                      fontWeight: selected && perm?.functions.includes(fn) ? 600 : 400,
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={perm?.functions.includes(fn) ?? false}
                      onChange={() => toggleFunction(page.key, fn)}
                      disabled={!selected}
                      style={{ width: 14, height: 14, accentColor: "#2563EB", cursor: selected ? "pointer" : "not-allowed" }}
                    />
                    {fn}
                  </label>
                ))}
              </div>

              {/* 数据权限 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, opacity: selected ? 1 : 0.4, pointerEvents: selected ? "auto" : "none" }}>
                <div style={{ display: "flex", gap: 16 }}>
                  {DATA_SCOPES.map((scope) => (
                    <label
                      key={scope}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        cursor: "pointer",
                        fontSize: 12,
                        color: selected && perm?.dataScope === scope ? "#2563EB" : "#64748B",
                        fontWeight: selected && perm?.dataScope === scope ? 600 : 400,
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="radio"
                        name={`scope-${page.key}`}
                        checked={perm?.dataScope === scope}
                        onChange={() => setDataScope(page.key, scope)}
                        disabled={!selected}
                        style={{ width: 14, height: 14, accentColor: "#2563EB", cursor: selected ? "pointer" : "not-allowed" }}
                      />
                      {scope}
                    </label>
                  ))}
                </div>
                {/* 「AI 助手」的数据权限会同时约束 Agent 读写 CRM 数据的范围 */}
                {PAGE_SCOPE_HINTS[page.key] && (
                  <div data-testid={`scope-hint-${page.key}`} style={{ fontSize: 10.5, color: "#94A3B8", lineHeight: 1.5 }}>
                    {PAGE_SCOPE_HINTS[page.key][perm?.dataScope === "全部" ? "全部" : "仅自己"]}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 每月 token 额度（AI 助手） */}
      <div
        data-testid="role-quota-block"
        style={{
          marginTop: 16,
          padding: "14px 16px",
          borderRadius: 10,
          background: "#F8FAFC",
          border: "1px solid #E2E8F0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#1E293B" }}>每月 token 额度</span>
          <span style={{ fontSize: 11, color: "#94A3B8" }}>（每个用户各自，单位：token）</span>
        </div>
        <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.7, marginBottom: 10 }}>
          该角色下<strong>每个用户</strong>每月可用于 AI 助手对话的 token 上限。超出后对话会被拦截并提示
          「{QUOTA_EXCEEDED_TEXT}」。填 <strong>0</strong> 表示不限额。
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <input
            data-testid="role-quota-input"
            type="number"
            min={0}
            step={100000}
            value={quotaInput}
            onChange={(e) => setQuotaInput(e.target.value)}
            style={{
              width: 180,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${quotaValid ? "#E2E8F0" : "#FCA5A5"}`,
              fontSize: 13,
              fontFamily: "inherit",
              color: "#1E293B",
              outline: "none",
              background: "#fff",
            }}
          />
          <span style={{ fontSize: 12, color: "#64748B" }}>
            {quotaInput.trim() === ""
              ? "请输入额度"
              : Number(quotaInput) === 0
              ? "不限额"
              : `≈ ${(Number(quotaInput) / 10000).toLocaleString()} 万 token / 月 / 人`}
          </span>

          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            {QUOTA_PRESETS.map((p) => (
              <button
                key={p.value}
                data-testid={`role-quota-preset-${p.value}`}
                onClick={() => setQuotaInput(String(p.value))}
                style={{
                  padding: "5px 10px",
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: Number(quotaInput) === p.value ? 600 : 400,
                  border: `1px solid ${Number(quotaInput) === p.value ? "#2563EB" : "#E2E8F0"}`,
                  background: Number(quotaInput) === p.value ? "#EFF6FF" : "#fff",
                  color: Number(quotaInput) === p.value ? "#2563EB" : "#64748B",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {p.label}
              </button>
            ))}
            <button
              data-testid="role-quota-unlimited-btn"
              onClick={() => setQuotaInput("0")}
              style={{
                padding: "5px 10px",
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: Number(quotaInput) === 0 ? 600 : 400,
                border: `1px solid ${Number(quotaInput) === 0 ? "#2563EB" : "#E2E8F0"}`,
                background: Number(quotaInput) === 0 ? "#EFF6FF" : "#fff",
                color: Number(quotaInput) === 0 ? "#2563EB" : "#64748B",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              不限额
            </button>
          </div>
        </div>

        {!quotaValid && (
          <div data-testid="role-quota-error" style={{ fontSize: 11.5, color: "#DC2626", marginTop: 8 }}>
            请输入 ≥ 0 的整数（0 表示不限额）
          </div>
        )}
      </div>

      {/* ⚠️ 吸底操作区三件事缺一即「盖不住」：
          ① 左右负 margin 抵消 Modal body 的 24px 内边距 → 白底横向铺满整宽
             （sticky 元素默认只有内容区宽度，两侧 24px 会漏出下层内容）；
          ② 底部内边距由 `bodyPadding="24px 24px 0"` 归零 → body 的 content box
             下缘与弹窗底部重合，按钮行才能一直贴到底（sticky 被限制在父级 content box 内，
             盖不住父级 padding-bottom）；
          ③ zIndex 抬层级 + 圆角贴合弹窗底部。 */}
      <div
        style={{
          display: "flex",
          gap: 10,
          position: "sticky",
          bottom: 0,
          zIndex: 2,
          margin: "20px -24px 0",
          padding: "16px 24px 20px",
          borderTop: "1px solid #E2E8F0",
          background: "#fff",
          borderBottomLeftRadius: 16,
          borderBottomRightRadius: 16,
        }}
      >
        <button
          data-testid="role-perm-save"
          onClick={handleSave}
          disabled={!quotaValid}
          style={{
            flex: 1,
            padding: "10px 20px",
            borderRadius: 10,
            fontWeight: 600,
            fontSize: "13.5px",
            // 与「取消」的 1px 边框对齐，两个 flex:1 按钮严格等宽
            border: "1px solid transparent",
            background: quotaValid ? "#2563EB" : "#94A3B8",
            color: "#fff",
            cursor: quotaValid ? "pointer" : "not-allowed",
            fontFamily: "inherit",
          }}
        >
          保存权限
        </button>
        <button onClick={onClose} style={{ flex: 1, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "1px solid #E2E8F0", background: "#fff", color: "#1E293B", cursor: "pointer", fontFamily: "inherit" }}>取消</button>
      </div>
    </Modal>
  );
}

/* ========== 主体页面 ========== */
export default function RolesDashboard() {
  const perm = usePermission("roles");
  // ---- 列表数据 ----
  const [roles, setRoles] = useState<Role[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [loading, setLoading] = useState(false);

  // ---- 筛选 ----
  const [filterName, setFilterName] = useState("");

  // ---- 弹窗状态 ----
  const [renameRole, setRenameRole] = useState<Role | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [permRole, setPermRole] = useState<Role | null>(null);
  const [deleteRole, setDeleteRole] = useState<Role | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addName, setAddName] = useState("");

  // ---- 数据加载 ----
  const fetchRoles = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterName) params.set("name", filterName);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));

      const res = await fetch(`/api/roles?${params.toString()}`);
      const data: RoleListResponse = await res.json();
      setRoles(data.data);
      setTotal(data.total);
    } catch {
      setRoles([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filterName, page, pageSize]);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  // ---- 修改角色名 ----
  const openRename = (role: Role) => {
    setRenameRole(role);
    setRenameInput(role.name);
  };

  const handleRenameSubmit = async () => {
    if (!renameRole || !renameInput.trim()) return;
    await fetch(`/api/roles/${renameRole.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameInput.trim() }),
    });
    setRenameRole(null);
    fetchRoles();
  };

  // ---- 修改权限 ----
  const handlePermSave = async (perms: PermissionItem[], quota: number) => {
    if (!permRole) return;
    await fetch(`/api/roles/${permRole.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: perms, monthlyTokenQuota: quota }),
    });
    setPermRole(null);
    fetchRoles();
  };

  // ---- 删除 ----
  const handleDeleteConfirm = async () => {
    if (!deleteRole) return;
    await fetch(`/api/roles/${deleteRole.id}`, { method: "DELETE" });
    setDeleteRole(null);
    setPage(1);
    fetchRoles();
  };

  // ---- 新增 ----
  const handleAddSubmit = async () => {
    if (!addName.trim()) {
      alert("请输入角色名称");
      return;
    }
    await fetch("/api/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: addName.trim() } as CreateRoleRequest),
    });
    setShowAddModal(false);
    setAddName("");
    setPage(1);
    fetchRoles();
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="roles" />
      <main style={{ flex: 1, minWidth: 0, padding: "28px 32px", overflowY: "auto", height: "100vh" }}>
        {/* ====== 页面标题 ====== */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", letterSpacing: "-0.02em", margin: 0 }}>角色与权限管理</h1>
            <p style={{ fontSize: 13, color: "#64748B", marginTop: 4, margin: 0 }}>管理系统角色及页面/功能/数据权限分配</p>
          </div>
          {perm.canAdd && (
          <button
            onClick={() => { setShowAddModal(true); setAddName(""); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "none", cursor: "pointer", fontFamily: "inherit", lineHeight: 1, background: "#2563EB", color: "#fff" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新增角色
          </button>
          )}
        </div>

        {/* ====== 筛选栏 ====== */}
        <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, padding: "14px 20px", marginBottom: 16, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: "12.5px", fontWeight: 500, color: "#64748B", whiteSpace: "nowrap" }}>角色名称</span>
            <input type="text" value={filterName} onChange={(e) => setFilterName(e.target.value)} placeholder="请输入角色名称" style={{ padding: "7px 10px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: "#1E293B", background: "#fff", outline: "none", minWidth: 200, width: 220 }} />
          </div>
          <button onClick={() => { setPage(1); fetchRoles(); }} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 14px", borderRadius: 8, fontWeight: 600, fontSize: "12.5px", border: "none", cursor: "pointer", fontFamily: "inherit", lineHeight: 1, background: "#2563EB", color: "#fff" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            查询
          </button>
        </div>

        {/* ====== 表格 ====== */}
        <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, overflow: "hidden" }}>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 0", color: "#94A3B8" }}>加载中...</div>
          ) : roles.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 0", color: "#94A3B8" }}>暂无符合条件的角色</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                    <th style={{ width: 40, padding: "10px 16px", paddingLeft: 20 }}>
                      <input type="checkbox" id="selectAllHeader" style={{ display: "none" }} />
                      <label htmlFor="selectAllHeader" style={{ width: 16, height: 16, border: "2px solid #CBD5E1", borderRadius: 4, display: "inline-block", cursor: "pointer", position: "relative", margin: 0 }} />
                    </th>
                    <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "11.5px", fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", userSelect: "none" }}>创建时间</th>
                    <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "11.5px", fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", userSelect: "none", minWidth: 120 }}>角色名</th>
                    <th style={{ padding: "10px 16px", textAlign: "left", fontSize: "11.5px", fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", userSelect: "none" }}>角色权限</th>
                    <th style={{ padding: "10px 16px", textAlign: "right", paddingRight: 20, fontSize: "11.5px", fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", userSelect: "none" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((role) => (
                    <tr key={role.id} style={{ borderBottom: "1px solid #F1F5F9", transition: "all 0.15s ease" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#FAFBFC"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}>
                      <td style={{ padding: "12px 16px", paddingLeft: 20 }}>
                        <input type="checkbox" id={`row-${role.id}`} style={{ display: "none" }} />
                        <label htmlFor={`row-${role.id}`} style={{ width: 16, height: 16, border: "2px solid #CBD5E1", borderRadius: 4, display: "inline-block", cursor: "pointer", position: "relative", margin: 0 }} />
                      </td>
                      <td style={{ padding: "12px 16px", color: "#64748B", fontSize: 13, whiteSpace: "nowrap" }}>{role.createdAt}</td>
                      <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{role.name}</span>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {role.permissions.length === 0 ? (
                            <span style={{ fontSize: 12, color: "#94A3B8" }}>无权限配置</span>
                          ) : (
                            role.permissions.map((p) => (
                              <PermissionTag key={p.pageKey} label={p.pageLabel} color="#2563EB" />
                            ))
                          )}
                          {role.permissions.length > 0 && (
                            <PermissionTag label={`功能(${role.permissions.reduce((s, p) => s + p.functions.length, 0)})`} color="#059669" />
                          )}
                          {role.permissions.length > 0 && (
                            <PermissionTag
                              label={role.permissions.some((p) => p.dataScope === "全部") ? "数据:可查看全部" : "数据:仅自己"}
                              color="#D97706"
                            />
                          )}
                          {/* 每月 token 额度（每人各自） */}
                          <span data-testid={`role-quota-tag-${role.id}`}>
                            <PermissionTag
                              label={
                                (role.monthlyTokenQuota ?? DEFAULT_MONTHLY_TOKEN_QUOTA) === 0
                                  ? "额度:不限额"
                                  : `额度:${(((role.monthlyTokenQuota ?? DEFAULT_MONTHLY_TOKEN_QUOTA) / 10000).toLocaleString())}万/月`
                              }
                              color="#7C3AED"
                            />
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "right", paddingRight: 20 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                          {/* 修改角色名 */}
                          {perm.canEdit && (
                          <button title="修改角色名" onClick={() => openRename(role)} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 10px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "#1E293B", fontFamily: "inherit" }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#F8FAFC"; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#fff"; }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                            修改角色名
                          </button>
                          )}
                          {/* 修改权限 */}
                          {perm.canEdit && (
                          <button title="修改权限" onClick={() => setPermRole(role)} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 10px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "#1E293B", fontFamily: "inherit" }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#EFF6FF"; (e.currentTarget as HTMLElement).style.borderColor = "#2563EB"; (e.currentTarget as HTMLElement).style.color = "#2563EB"; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#fff"; (e.currentTarget as HTMLElement).style.borderColor = "#E2E8F0"; (e.currentTarget as HTMLElement).style.color = "#1E293B"; }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                            修改权限
                          </button>
                          )}
                          {/* 删除 */}
                          {perm.canDelete && (
                          <button title="删除角色" onClick={() => setDeleteRole(role)} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 10px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "#1E293B", fontFamily: "inherit" }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#FEF2F2"; (e.currentTarget as HTMLElement).style.borderColor = "#DC2626"; (e.currentTarget as HTMLElement).style.color = "#DC2626"; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#fff"; (e.currentTarget as HTMLElement).style.borderColor = "#E2E8F0"; (e.currentTarget as HTMLElement).style.color = "#1E293B"; }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                            删除
                          </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 分页 */}
          {total > 0 && (() => {
            const totalPages = Math.ceil(total / pageSize);
            const from = (page - 1) * pageSize + 1;
            const to = Math.min(page * pageSize, total);
            const getPages = () => {
              if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1);
              if (page <= 3) return [1, 2, 3, -1, totalPages];
              if (page >= totalPages - 2) return [1, -1, totalPages - 2, totalPages - 1, totalPages];
              return [1, -1, page - 1, page, page + 1, -1, totalPages];
            };
            const pages = getPages();
            return (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderTop: "1px solid #E2E8F0" }}>
                <span style={{ fontSize: "12.5px", color: "#64748B" }}>显示 {from}-{to} 条，共 {total} 条</span>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => setPage(page - 1)} disabled={page <= 1}
                    style={{ width: 32, height: 32, border: "1px solid #E2E8F0", borderRadius: 8, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: page <= 1 ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500, color: page <= 1 ? "#CBD5E1" : "#64748B", fontFamily: "inherit", opacity: page <= 1 ? 0.4 : 1 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                  </button>
                  {pages.map((p, i) => p === -1 ? (
                    <span key={`e-${i}`} style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#64748B" }}>...</span>
                  ) : (
                    <button key={p} onClick={() => setPage(p)}
                      style={{ width: 32, height: 32, border: p === page ? "1px solid #2563EB" : "1px solid #E2E8F0", borderRadius: 8, background: p === page ? "#2563EB" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 13, fontWeight: 500, color: p === page ? "#fff" : "#64748B", fontFamily: "inherit" }}>{p}</button>
                  ))}
                  <button onClick={() => setPage(page + 1)} disabled={page >= totalPages}
                    style={{ width: 32, height: 32, border: "1px solid #E2E8F0", borderRadius: 8, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: page >= totalPages ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500, color: page >= totalPages ? "#CBD5E1" : "#64748B", fontFamily: "inherit", opacity: page >= totalPages ? 0.4 : 1 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      </main>

      {/* ====== 修改角色名弹窗 ====== */}
      <Modal open={!!renameRole} onClose={() => setRenameRole(null)} title="修改角色名">
        {renameRole && (
          <div>
            <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 16 }}>
              当前角色：{renameRole.name}
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1E293B", marginBottom: 6 }}>角色名称</div>
              <input type="text" value={renameInput} onChange={(e) => setRenameInput(e.target.value)} style={INPUT_STYLE} placeholder="请输入新名称" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
              <button onClick={handleRenameSubmit} style={{ flex: 1, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "none", background: "#2563EB", color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>确认修改</button>
              <button onClick={() => setRenameRole(null)} style={{ flex: 1, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "1px solid #E2E8F0", background: "#fff", color: "#1E293B", cursor: "pointer", fontFamily: "inherit" }}>取消</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ====== 权限设置弹窗 ====== */}
      <PermissionSettingsModal
        open={!!permRole}
        onClose={() => setPermRole(null)}
        permissions={permRole?.permissions ?? []}
        onSave={handlePermSave}
        roleName={permRole?.name ?? ""}
        quota={permRole?.monthlyTokenQuota ?? DEFAULT_MONTHLY_TOKEN_QUOTA}
      />

      {/* ====== 删除确认弹窗 ====== */}
      <Modal open={!!deleteRole} onClose={() => setDeleteRole(null)} title="删除确认">
        {deleteRole && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, padding: 16, background: "#FEF2F2", borderRadius: 10, border: "1px solid #FECACA" }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "#FEF2F2", display: "flex", alignItems: "center", justifyContent: "center", color: "#DC2626" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#991B1B" }}>确认删除角色「{deleteRole.name}」？</div>
                <div style={{ fontSize: 13, color: "#B91C1C", marginTop: 2 }}>删除后数据将无法恢复。</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleDeleteConfirm} style={{ flex: 1, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "none", background: "#DC2626", color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>确认删除</button>
              <button onClick={() => setDeleteRole(null)} style={{ flex: 1, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "1px solid #E2E8F0", background: "#fff", color: "#1E293B", cursor: "pointer", fontFamily: "inherit" }}>取消</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ====== 新增角色弹窗 ====== */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="新增角色">
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1E293B", marginBottom: 6 }}>角色名称</div>
            <input type="text" value={addName} onChange={(e) => setAddName(e.target.value)} style={INPUT_STYLE} placeholder="请输入角色名称" />
          </div>
          <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 16 }}>
            新增后可在权限设置中分配页面权限和功能权限
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
            <button onClick={handleAddSubmit} style={{ flex: 1, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "none", background: "#2563EB", color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>添加</button>
            <button onClick={() => setShowAddModal(false)} style={{ flex: 1, padding: "10px 20px", borderRadius: 10, fontWeight: 600, fontSize: "13.5px", border: "1px solid #E2E8F0", background: "#fff", color: "#1E293B", cursor: "pointer", fontFamily: "inherit" }}>取消</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
