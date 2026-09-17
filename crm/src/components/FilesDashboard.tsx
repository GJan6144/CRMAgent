"use client";

import { useCallback, useEffect, useState } from "react";
import { usePermission } from "@/hooks/usePermission";
import Sidebar from "./Sidebar";

/* ========== 类型 ========== */

interface GeneratedFile {
  name: string;
  path: string;
  category: string;
  category_label: string;
  size: number;
  mtime: number;
  url: string;
}

interface FileListResponse {
  data: GeneratedFile[];
  total: number;
}

/* ========== 小工具 ========== */

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(sec: number): string {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

const CATEGORY_COLOR: Record<string, { bg: string; fg: string }> = {
  合同: { bg: "#F0FDF4", fg: "#16A34A" },
  报告: { bg: "#EFF6FF", fg: "#2563EB" },
};

export default function FilesDashboard() {
  const perm = usePermission("files");
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/agent/files", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: FileListResponse = await res.json();
      setFiles(body.data || []);
    } catch {
      setError("无法连接 Agent 服务，请确认 chat-ui（8765）已启动。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleDownload = (f: GeneratedFile) => {
    window.open(
      `/api/agent/files/download?path=${encodeURIComponent(f.path)}`,
      "_blank"
    );
  };

  const handleDelete = async (f: GeneratedFile) => {
    if (!window.confirm(`确定删除「${f.name}」吗？此操作不可恢复。`)) return;
    setDeleting(f.path);
    try {
      const res = await fetch(
        `/api/agent/files?path=${encodeURIComponent(f.path)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { detail?: string }).detail || `HTTP ${res.status}`);
      }
      await fetchFiles();
    } catch (err) {
      window.alert(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setDeleting(null);
    }
  };

  if (!perm.canViewPage) {
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar activeItem="files" />
        <main style={{ flex: 1, minWidth: 0, padding: "28px 32px" }}>
          <p style={{ fontSize: 14, color: "#64748B" }}>
            当前角色没有访问「文件管理」页面的权限。
          </p>
        </main>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="files" />
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
              AI 生成文件管理
            </h1>
            <p style={{ fontSize: 13, color: "#64748B", margin: "4px 0 0" }}>
              Agent 生成的合同、报告等文件统一归档于此，可在线查看、下载或删除。
            </p>
          </div>
          <button
            onClick={fetchFiles}
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
        ) : files.length === 0 ? (
          <div
            style={{
              padding: "48px 0",
              textAlign: "center",
              color: "#94A3B8",
              fontSize: 14,
            }}
          >
            暂无生成的文件。去「AI 助手」里生成一份合同或报告后，这里就会出现。
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
                  {["文件名", "分类", "大小", "生成时间", "操作"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "12px 16px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#64748B",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const cat = CATEGORY_COLOR[f.category_label] || {
                    bg: "#F1F5F9",
                    fg: "#475569",
                  };
                  return (
                    <tr
                      key={f.path}
                      style={{ borderBottom: "1px solid #F1F5F9" }}
                    >
                      <td
                        style={{
                          padding: "12px 16px",
                          fontSize: 13.5,
                          color: "#0F172A",
                          fontWeight: 500,
                          wordBreak: "break-all",
                        }}
                      >
                        {f.name}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "3px 10px",
                            borderRadius: 999,
                            background: cat.bg,
                            color: cat.fg,
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {f.category_label}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          fontSize: 13,
                          color: "#475569",
                        }}
                      >
                        {fmtBytes(f.size)}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          fontSize: 13,
                          color: "#475569",
                        }}
                      >
                        {fmtTime(f.mtime)}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            onClick={() => handleDownload(f)}
                            style={{
                              padding: "5px 12px",
                              borderRadius: 6,
                              background: "#EFF6FF",
                              color: "#2563EB",
                              fontSize: 12.5,
                              fontWeight: 600,
                              border: "none",
                              cursor: "pointer",
                            }}
                          >
                            下载
                          </button>
                          {perm.canDelete && (
                            <button
                              onClick={() => handleDelete(f)}
                              disabled={deleting === f.path}
                              style={{
                                padding: "5px 12px",
                                borderRadius: 6,
                                background: "#FEF2F2",
                                color: "#DC2626",
                                fontSize: 12.5,
                                fontWeight: 600,
                                border: "none",
                                cursor: deleting === f.path ? "wait" : "pointer",
                                opacity: deleting === f.path ? 0.5 : 1,
                              }}
                            >
                              {deleting === f.path ? "删除中…" : "删除"}
                            </button>
                          )}
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
    </div>
  );
}
