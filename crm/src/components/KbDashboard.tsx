"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePermission } from "@/hooks/usePermission";
import type {
  KbChunk,
  KbChunkListResponse,
  KbDocument,
  KbDocumentListResponse,
  KbFileRow,
  KbOverview,
  KbStats,
  KbTask,
  KbTaskListResponse,
} from "@/types/kb";
import Sidebar from "./Sidebar";
import Drawer from "./Drawer";
import Modal from "./Modal";

/* ========== 通用小工具 ========== */

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  if (!iso) return "—";
  // 接口返回 2026-09-15T03:28:59（本地时间，无时区后缀）
  return iso.replace("T", " ").slice(0, 16);
}

function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 按「来源文件」把文档聚合成列表行 —— 一份问答表会拆成多篇文档 */
function groupBySource(docs: KbDocument[]): KbFileRow[] {
  const map = new Map<string, KbFileRow>();
  for (const d of docs) {
    const src = (d.source || "").trim();
    const key = src || `doc:${d.doc_id}`;
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        name: src
          ? d.source_name || src.split(/[\\/]/).pop() || src
          : d.title || d.doc_id,
        source: src,
        managed: d.managed,
        sourceExists: d.source_exists,
        docType: d.doc_type,
        docs: [],
        chunks: 0,
        chars: 0,
        size: d.source_size || 0,
        updatedAt: d.updated_at,
      };
      map.set(key, row);
    }
    row.docs.push(d);
    row.chunks += d.n_chunks;
    row.chars += d.n_chars;
    // 文档按更新时间倒序返回，首条即最新
    if (d.updated_at > row.updatedAt) row.updatedAt = d.updated_at;
  }
  return Array.from(map.values());
}

/** 把服务端返回的任务并入本地队列（保留本地顺序，只更新已存在的项） */
function mergeTasks(prev: KbTask[], incoming: KbTask[]): KbTask[] {
  const byId = new Map(incoming.map((t) => [t.task_id, t]));
  const merged = prev.map((t) => byId.get(t.task_id) ?? t);
  const known = new Set(prev.map((t) => t.task_id));
  for (const t of incoming) if (!known.has(t.task_id)) merged.push(t);
  return merged;
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  queued: { label: "排队中", bg: "#F1F5F9", fg: "#475569" },
  running: { label: "处理中", bg: "#EFF6FF", fg: "#2563EB" },
  done: { label: "已完成", bg: "#ECFDF5", fg: "#059669" },
  failed: { label: "失败", bg: "#FEF2F2", fg: "#DC2626" },
};

const MODE_LABEL: Record<string, string> = {
  text: "文本",
  "faq-table": "问答表（按分类拆分）",
  table: "表格",
  "mixed-table": "混合表（问答 + 清单）",
};

/* ========== 输入框样式 ========== */

const FILTER_INPUT: React.CSSProperties = {
  padding: "7px 10px",
  border: "1px solid #E2E8F0",
  borderRadius: 8,
  fontSize: 13,
  fontFamily: "inherit",
  color: "#1E293B",
  background: "#fff",
  outline: "none",
  minWidth: 120,
  width: 150,
};

/* ========== 切片正文 ========== */

/** 超过这个字数（或 6 行）就默认折叠，避免一篇长文档把抽屉撑成滚动地狱 */
const CHUNK_PREVIEW_CHARS = 220;

/**
 * 筛选 chip 上显示的短标题。
 *
 * 一份问答表拆出来的文档标题通常共享前缀（「课程FAQ · 课程内容」「课程FAQ · 适合人群」…），
 * 6 个 chip 每个都带一遍前缀会挤成两行还看不出区别，所以把最长公共前缀（到「·」为止）
 * 去掉。不含分隔符的公共前缀不动 —— 免得把「产品A」「产品B」削成「A」「B」。
 */
function shortTitles(titles: string[]): string[] {
  if (titles.length < 2) return titles;
  let prefix = titles[0];
  for (const t of titles.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  const cut = prefix.lastIndexOf("·");
  if (cut < 0) return titles;
  const head = prefix.slice(0, cut + 1);
  return titles.map((t) => (t.length > head.length ? t.slice(head.length).trim() : t));
}

/** 片段原文。保留原始换行 —— 切片是按语义边界切的，换行本身就是信息 */
function ChunkText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CHUNK_PREVIEW_CHARS || text.split("\n").length > 6;
  const shown = open || !long ? text : text.slice(0, CHUNK_PREVIEW_CHARS);
  return (
    <div>
      <div
        data-chunk-text
        style={{
          marginTop: 6,
          padding: "8px 10px",
          background: "#F8FAFC",
          border: "1px solid #E8EDF3",
          borderLeft: "3px solid #BFDBFE",
          borderRadius: 6,
          fontSize: 12.5,
          lineHeight: 1.75,
          color: "#334155",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: open ? undefined : 138,
          overflow: "hidden",
        }}
      >
        {shown}
        {!open && long && <span style={{ color: "#94A3B8" }}>…</span>}
      </div>
      {long && (
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            marginTop: 4,
            padding: 0,
            border: "none",
            background: "transparent",
            color: "#2563EB",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {open ? "收起" : `展开全文（${text.length} 字）`}
        </button>
      )}
    </div>
  );
}

/* ========== 主体页面 ========== */

export default function KbDashboard() {
  const perm = usePermission("kb");

  // ---- 列表数据 ----
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [stats, setStats] = useState<KbStats | null>(null);
  const [overview, setOverview] = useState<KbOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // ---- 筛选与分页 ----
  const [filters, setFilters] = useState({ q: "", docType: "", origin: "" });
  const [page, setPage] = useState(1);
  const [pageSize] = useState(5);

  // ---- 抽屉 / 弹窗 ----
  const [detailRow, setDetailRow] = useState<KbFileRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<KbFileRow | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [notice, setNotice] = useState("");

  // ---- 切片预览（抽屉里展示切片后的正文）----
  const [preview, setPreview] = useState<{
    loading: boolean;
    error: string;
    data: KbChunkListResponse | null;
    /** 按某一篇文档筛片段；空串 = 全部 */
    docFilter: string;
  }>({ loading: false, error: "", data: null, docFilter: "" });

  // ---- 上传队列 ----
  const [tasks, setTasks] = useState<KbTask[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 任务列表的「代」。点「清空记录」会 +1，用来作废**在途**的拉取。
   *
   * `openUpload()` 会先 `loadTasks()`（不 await）再渲染弹窗，用户可能在它返回前
   * 就点了清空 —— 没有这个代际校验，在途响应回来会把刚清掉的记录又填回去。
   */
  const tasksGen = useRef(0);

  /* ---------------- 数据加载 ---------------- */

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/kb/overview");
      if (!res.ok) throw new Error(String(res.status));
      setOverview((await res.json()) as KbOverview);
    } catch {
      /* overview 只用于展示参数，失败不阻断列表 */
    }
  }, []);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/kb/documents");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as KbDocumentListResponse;
      setDocs(data.data || []);
      setStats(data.stats || null);
      setLoadError("");
    } catch {
      setDocs([]);
      setStats(null);
      setLoadError("无法连接 Agent 服务，请确认 chat-ui（8765）已启动。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocs();
    fetchOverview();
  }, [fetchDocs, fetchOverview]);

  /**
   * 打开详情抽屉时才拉切片正文。
   *
   * 刻意**不**并进 /documents —— 正文是全库最大的一块数据，列表接口带上它会让
   * 每次刷新都拖几百 KB，而这些内容只有在用户真的点开某个文件时才需要。
   */
  useEffect(() => {
    if (!detailRow) return;
    const ids = detailRow.docs.map((d) => d.doc_id).filter(Boolean);
    if (!ids.length) return;
    let alive = true;
    setPreview({ loading: true, error: "", data: null, docFilter: "" });
    (async () => {
      try {
        const res = await fetch(
          `/api/agent/kb/chunks?doc_ids=${encodeURIComponent(ids.join(","))}&limit=200`
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as KbChunkListResponse;
        if (alive) setPreview({ loading: false, error: "", data, docFilter: "" });
      } catch {
        if (alive) {
          setPreview({
            loading: false,
            error: "切片正文加载失败，请确认 Agent 服务（8765）已启动。",
            data: null,
            docFilter: "",
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [detailRow]);

  /**
   * 切片内容按文档分组。
   *
   * 文档骨架取自 ``detailRow.docs``（列表接口已经带回来了），**不是**取切片接口
   * 回传的 documents —— 这样抽屉一打开就能立刻渲染出文档分组与筛选 chip，
   * 只有片段正文需要等接口。否则点开抽屉会先空一下再刷出来。
   */
  const previewGroups = useMemo(() => {
    const docsInFile = detailRow?.docs ?? [];
    const byDoc = new Map<string, KbChunk[]>();
    for (const c of preview.data?.data ?? []) {
      const arr = byDoc.get(c.doc_id);
      if (arr) arr.push(c);
      else byDoc.set(c.doc_id, [c]);
    }
    return docsInFile
      .filter((d) => !preview.docFilter || d.doc_id === preview.docFilter)
      .map((doc) => ({ doc, chunks: byDoc.get(doc.doc_id) ?? [] }));
  }, [detailRow, preview.data, preview.docFilter]);

  // 取成 const 是为了让 TS 的收窄能穿透进 JSX 里的回调（state 变量做不到）
  const chunkData = preview.data;

  /** 筛选 chip 显示用的短标题 */
  const chipTitles = useMemo(
    () => shortTitles((detailRow?.docs ?? []).map((d) => d.title)),
    [detailRow]
  );

  /** 拉取任务列表；返回时若已被「清空记录」作废则丢弃（避免在途响应把列表填回去） */
  const loadTasks = useCallback(async (limit = 20) => {
    const gen = tasksGen.current;
    try {
      const res = await fetch(`/api/agent/kb/tasks?limit=${limit}`);
      if (!res.ok) return;
      const data = (await res.json()) as KbTaskListResponse;
      if (gen !== tasksGen.current) return;
      setTasks((prev) => mergeTasks(prev, data.data || []));
    } catch {
      /* 忽略 */
    }
  }, []);

  /** 清空处理记录：先作废在途请求，再清本地列表 */
  const clearTasks = useCallback(() => {
    tasksGen.current += 1;
    setTasks([]);
  }, []);

  /* ---------------- 进度轮询 ---------------- */

  const rows = useMemo(() => groupBySource(docs), [docs]);

  const activeCount = tasks.filter(
    (t) => t.status === "queued" || t.status === "running"
  ).length;

  useEffect(() => {
    if (activeCount === 0) return;
    // 走同一个 loadTasks：代际校验对轮询同样生效（清空后落地的 tick 会被丢弃）
    const timer = setInterval(() => loadTasks(50), 900);
    loadTasks(50);
    return () => clearInterval(timer);
  }, [activeCount, loadTasks]);

  // 处理从「有任务在跑」变为「全部结束」时，刷新列表与统计
  const prevActive = useRef(0);
  useEffect(() => {
    if (prevActive.current > 0 && activeCount === 0) {
      fetchDocs();
      fetchOverview();
    }
    prevActive.current = activeCount;
  }, [activeCount, fetchDocs, fetchOverview]);

  /* ---------------- 筛选 ---------------- */

  const docTypes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.docType).filter(Boolean))).sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.name} ${r.docs.map((d) => d.title).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.docType && r.docType !== filters.docType) return false;
      if (filters.origin === "managed" && !r.managed) return false;
      if (filters.origin === "external" && r.managed) return false;
      return true;
    });
  }, [rows, filters]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  /* ---------------- 上传 ---------------- */

  const doUpload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setNotice("");
    for (const file of files) {
      try {
        const res = await fetch(
          `/api/agent/kb/upload?filename=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            // body 直接是文件对象：后端按原始字节接收（二进制安全）
            body: file,
            headers: { "Content-Type": file.type || "application/octet-stream" },
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
        setTasks((prev) => mergeTasks(prev, [data as KbTask]));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const now = new Date().toISOString().slice(0, 19);
        setTasks((prev) => [
          ...prev,
          {
            task_id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            filename: file.name,
            stored_path: "",
            size_bytes: file.size,
            tags: "",
            status: "failed",
            stage: "failed",
            stage_label: "上传被拒",
            progress: 1,
            message: msg,
            mode: "",
            docs: [],
            chunks: 0,
            tokens: 0,
            added: 0,
            skipped: 0,
            error: msg,
            created_at: now,
            updated_at: now,
            elapsed_ms: 0,
          },
        ]);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    if (list.length) doUpload(list);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const list = Array.from(e.dataTransfer?.files || []);
    if (list.length) doUpload(list);
  };

  const openUpload = () => {
    setShowUpload(true);
    loadTasks();
  };

  const acceptAttr = (overview?.upload.allowed_suffixes || []).join(",");

  /* ---------------- 删除 ---------------- */

  const handleDeleteConfirm = async () => {
    if (!deleteRow) return;
    const ids = deleteRow.docs.map((d) => d.doc_id);
    try {
      const res = await fetch("/api/agent/kb/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_ids: ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
      const freed: string[] = data.freed_files || [];
      setNotice(
        `已删除「${deleteRow.name}」的 ${ids.length} 篇文档 / ${data.removed_chunks} 个片段` +
          (freed.length ? "，并清理了上传的文件副本" : "")
      );
      if (data.list) {
        setDocs(data.list.data || []);
        setStats(data.list.stats || null);
      } else {
        fetchDocs();
      }
      fetchOverview();
    } catch (e) {
      setNotice(
        `删除失败：${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setDeleteRow(null);
    }
  };

  /* ================= 渲染 ================= */

  const cardStyle: React.CSSProperties = {
    background: "#fff",
    border: "1px solid #E2E8F0",
    borderRadius: 12,
  };

  const thStyle: React.CSSProperties = {
    padding: "10px 16px",
    textAlign: "left",
    fontSize: "11.5px",
    fontWeight: 600,
    color: "#64748B",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    userSelect: "none",
  };

  const statCards: { label: string; value: string; hint: string }[] = [
    {
      label: "挂载文件",
      value: fmtNum(rows.length),
      hint: `${fmtNum(rows.filter((r) => r.managed).length)} 个来自本页上传`,
    },
    {
      label: "检索单元",
      value: fmtNum(stats?.documents ?? 0),
      hint: `${fmtNum(stats?.chunks ?? 0)} 个片段`,
    },
    {
      label: "语料字数",
      value: fmtNum(stats?.total_chars ?? 0),
      hint: "入库正文合计",
    },
    {
      label: "库文件大小",
      value: fmtBytes(stats?.size_bytes ?? 0),
      hint: "knowledge.db",
    },
    {
      label: "Embedding",
      value: overview?.embedding.model.split("/").pop() || "—",
      hint: `${stats?.dim ?? "—"} 维 · 余弦`,
    },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="kb" />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          padding: "28px 32px",
          overflowY: "auto",
          height: "100vh",
        }}
      >
        {/* ====== 页面标题 ====== */}
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
              Agent 知识库
            </h1>
            <p style={{ fontSize: 13, color: "#64748B", margin: "4px 0 0" }}>
              管理已挂载到 Agent 检索能力的知识库文件。上传后会自动切块并做
              Embedding，随即生效；文件一旦挂载只能删除，不能修改。
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {activeCount > 0 && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: "#EFF6FF",
                  color: "#2563EB",
                  fontSize: 12.5,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "#2563EB",
                  }}
                />
                正在处理 {activeCount} 个文件
              </span>
            )}
            {perm.canAdd && (
              <button
                onClick={openUpload}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 20px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: "13.5px",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  lineHeight: 1,
                  background: "#2563EB",
                  color: "#fff",
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  width="16"
                  height="16"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                上传
              </button>
            )}
          </div>
        </div>

        {/* ====== 统计卡片 ====== */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          {statCards.map((c) => (
            <div key={c.label} style={{ ...cardStyle, padding: "14px 16px" }}>
              <div style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>
                {c.label}
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: "#0F172A",
                  margin: "6px 0 2px",
                  letterSpacing: "-0.02em",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {c.value}
              </div>
              <div style={{ fontSize: 11.5, color: "#94A3B8" }}>{c.hint}</div>
            </div>
          ))}
        </div>

        {notice && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 12,
              padding: "10px 14px",
              borderRadius: 10,
              background: "#F0F9FF",
              border: "1px solid #BAE6FD",
              color: "#075985",
              fontSize: 12.5,
            }}
          >
            <span>{notice}</span>
            <button
              onClick={() => setNotice("")}
              style={{
                border: "none",
                background: "transparent",
                color: "#075985",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                fontFamily: "inherit",
              }}
            >
              ✕
            </button>
          </div>
        )}

        {loadError && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 14px",
              borderRadius: 10,
              background: "#FEF2F2",
              border: "1px solid #FECACA",
              color: "#B91C1C",
              fontSize: 12.5,
            }}
          >
            {loadError}
          </div>
        )}

        {/* ====== 筛选栏 ====== */}
        <div
          style={{
            ...cardStyle,
            padding: "14px 20px",
            marginBottom: 16,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: "12.5px",
                fontWeight: 500,
                color: "#64748B",
                whiteSpace: "nowrap",
              }}
            >
              文件名
            </span>
            <input
              type="text"
              value={filters.q}
              onChange={(e) => handleFilterChange("q", e.target.value)}
              placeholder="文件名或文档标题"
              style={FILTER_INPUT}
            />
          </div>
          <div style={{ width: 1, height: 24, background: "#E2E8F0" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: "12.5px",
                fontWeight: 500,
                color: "#64748B",
                whiteSpace: "nowrap",
              }}
            >
              类型
            </span>
            <select
              value={filters.docType}
              onChange={(e) => handleFilterChange("docType", e.target.value)}
              style={{ ...FILTER_INPUT, width: 120 }}
            >
              <option value="">全部</option>
              {docTypes.map((t) => (
                <option key={t} value={t}>
                  {t.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: "12.5px",
                fontWeight: 500,
                color: "#64748B",
                whiteSpace: "nowrap",
              }}
            >
              来源
            </span>
            <select
              value={filters.origin}
              onChange={(e) => handleFilterChange("origin", e.target.value)}
              style={{ ...FILTER_INPUT, width: 130 }}
            >
              <option value="">全部</option>
              <option value="managed">本页上传</option>
              <option value="external">外部导入</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={fetchDocs}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 14px",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: "12.5px",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                lineHeight: 1,
                background: "#2563EB",
                color: "#fff",
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="16"
                height="16"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              查询
            </button>
            <button
              onClick={() => {
                setFilters({ q: "", docType: "", origin: "" });
                setPage(1);
              }}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: "12.5px",
                border: "1px solid #E2E8F0",
                cursor: "pointer",
                fontFamily: "inherit",
                lineHeight: 1,
                background: "#fff",
                color: "#64748B",
              }}
            >
              重置
            </button>
          </div>
        </div>

        {/* ====== 表格 ====== */}
        <div style={{ ...cardStyle, overflow: "hidden" }}>
          {loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "80px 0",
                color: "#94A3B8",
              }}
            >
              加载中...
            </div>
          ) : pageRows.length === 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "72px 0",
                color: "#94A3B8",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13 }}>
                {rows.length === 0
                  ? "知识库还是空的，点右上角「上传」加入第一个文件"
                  : "暂无符合条件的知识库文件"}
              </span>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr
                    style={{
                      background: "#F8FAFC",
                      borderBottom: "1px solid #E2E8F0",
                    }}
                  >
                    <th style={thStyle}>文件 / 文档</th>
                    <th style={thStyle}>类型</th>
                    <th style={thStyle}>来源</th>
                    <th style={thStyle}>文档数</th>
                    <th style={thStyle}>片段数</th>
                    <th style={thStyle}>大小</th>
                    <th style={thStyle}>更新时间</th>
                    <th style={{ ...thStyle, textAlign: "right", paddingRight: 20 }}>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr
                      key={row.key}
                      style={{ borderBottom: "1px solid #F1F5F9" }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "#FAFBFC";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "";
                      }}
                    >
                      <td style={{ padding: "12px 16px", maxWidth: 300 }}>
                        <div
                          onClick={() => setDetailRow(row)}
                          title="查看该文件拆出的文档"
                          style={{
                            fontWeight: 600,
                            color: "#2563EB",
                            fontSize: 13,
                            cursor: "pointer",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.name}
                        </div>
                        {row.docs.length === 1 && row.docs[0].title !== row.name && (
                          <div
                            style={{
                              fontSize: 11.5,
                              color: "#94A3B8",
                              marginTop: 2,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {row.docs[0].title}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 6,
                            background: "#F1F5F9",
                            color: "#475569",
                            fontSize: 11.5,
                            fontWeight: 600,
                            textTransform: "uppercase",
                          }}
                        >
                          {row.docType || "text"}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        {row.managed ? (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              fontSize: 12.5,
                              color: "#7C3AED",
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: 999,
                                background: "#7C3AED",
                              }}
                            />
                            本页上传
                          </span>
                        ) : (
                          <span style={{ fontSize: 12.5, color: "#64748B" }}>
                            外部导入
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 13, color: "#334155" }}>
                        {row.docs.length}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <button
                          type="button"
                          data-chunk-count={row.key}
                          onClick={() => setDetailRow(row)}
                          title="查看切片后的文本"
                          style={{
                            padding: "2px 8px",
                            border: "1px solid transparent",
                            borderRadius: 6,
                            background: "transparent",
                            color: "#2563EB",
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: "pointer",
                            textDecoration: "underline",
                            textDecorationStyle: "dotted",
                            textUnderlineOffset: 3,
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.background = "#EFF6FF";
                            (e.currentTarget as HTMLElement).style.borderColor = "#BFDBFE";
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.background = "transparent";
                            (e.currentTarget as HTMLElement).style.borderColor = "transparent";
                          }}
                        >
                          {fmtNum(row.chunks)}
                        </button>
                      </td>
                      <td style={{ padding: "12px 16px", fontSize: 13, color: "#64748B" }}>
                        {row.managed && row.size ? fmtBytes(row.size) : "—"}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          fontSize: 12.5,
                          color: "#64748B",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {fmtTime(row.updatedAt)}
                      </td>
                      <td
                        style={{
                          padding: "12px 16px",
                          textAlign: "right",
                          paddingRight: 20,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: 6,
                          }}
                        >
                          <button
                            title="查看详情"
                            onClick={() => setDetailRow(row)}
                            style={{
                              width: 30,
                              height: 30,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              border: "none",
                              background: "transparent",
                              borderRadius: 6,
                              cursor: "pointer",
                              color: "#94A3B8",
                            }}
                            onMouseEnter={(e) => {
                              (e.currentTarget as HTMLElement).style.background = "#EFF6FF";
                              (e.currentTarget as HTMLElement).style.color = "#2563EB";
                            }}
                            onMouseLeave={(e) => {
                              (e.currentTarget as HTMLElement).style.background = "";
                              (e.currentTarget as HTMLElement).style.color = "#94A3B8";
                            }}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              width="16"
                              height="16"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <circle cx="12" cy="12" r="3" />
                              <path d="M22 12c0 3.5-4.5 8-10 8s-10-4.5-10-8 4.5-8 10-8 10 4.5 10 8z" />
                            </svg>
                          </button>
                          {perm.canDelete && (
                            <button
                              title="删除（含全部片段）"
                              onClick={() => setDeleteRow(row)}
                              style={{
                                width: 30,
                                height: 30,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                border: "none",
                                background: "transparent",
                                borderRadius: 6,
                                cursor: "pointer",
                                color: "#94A3B8",
                              }}
                              onMouseEnter={(e) => {
                                (e.currentTarget as HTMLElement).style.background = "#FEF2F2";
                                (e.currentTarget as HTMLElement).style.color = "#DC2626";
                              }}
                              onMouseLeave={(e) => {
                                (e.currentTarget as HTMLElement).style.background = "";
                                (e.currentTarget as HTMLElement).style.color = "#94A3B8";
                              }}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                width="16"
                                height="16"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
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
          {!loading && filtered.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 20px",
                borderTop: "1px solid #E2E8F0",
              }}
            >
              <span style={{ fontSize: "12.5px", color: "#64748B" }}>
                显示 {(currentPage - 1) * pageSize + 1}-
                {Math.min(currentPage * pageSize, filtered.length)} 条，共{" "}
                {filtered.length} 条
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  onClick={() => setPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  style={{
                    width: 32,
                    height: 32,
                    border: "1px solid #E2E8F0",
                    borderRadius: 8,
                    background: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: currentPage <= 1 ? "not-allowed" : "pointer",
                    color: currentPage <= 1 ? "#CBD5E1" : "#64748B",
                    fontFamily: "inherit",
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    width="16"
                    height="16"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(
                    (p) =>
                      totalPages <= 5 ||
                      p === 1 ||
                      p === totalPages ||
                      Math.abs(p - currentPage) <= 1
                  )
                  .map((p, idx, arr) => (
                    <span key={p} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {idx > 0 && arr[idx - 1] !== p - 1 && (
                        <span
                          style={{
                            width: 20,
                            textAlign: "center",
                            fontSize: 13,
                            color: "#64748B",
                          }}
                        >
                          ...
                        </span>
                      )}
                      <button
                        onClick={() => setPage(p)}
                        style={{
                          width: 32,
                          height: 32,
                          border:
                            p === currentPage
                              ? "1px solid #2563EB"
                              : "1px solid #E2E8F0",
                          borderRadius: 8,
                          background: p === currentPage ? "#2563EB" : "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          fontSize: 13,
                          fontWeight: 500,
                          color: p === currentPage ? "#fff" : "#64748B",
                          fontFamily: "inherit",
                        }}
                      >
                        {p}
                      </button>
                    </span>
                  ))}
                <button
                  onClick={() => setPage(currentPage + 1)}
                  disabled={currentPage >= totalPages}
                  style={{
                    width: 32,
                    height: 32,
                    border: "1px solid #E2E8F0",
                    borderRadius: 8,
                    background: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: currentPage >= totalPages ? "not-allowed" : "pointer",
                    color: currentPage >= totalPages ? "#CBD5E1" : "#64748B",
                    fontFamily: "inherit",
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    width="16"
                    height="16"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>

        <p style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 12, lineHeight: 1.7 }}>
          一份问答型表格会按分类拆成多篇文档（每个问答对是一个独立片段），所以
          「挂载文件」数通常小于「检索单元」数。外部导入的文件（不是从本页上传的）
          删除时只移除索引，不动磁盘上的源文件。
        </p>
      </main>

      {/* ====== 文件详情 / 切片预览抽屉 ====== */}
      <Drawer
        open={!!detailRow}
        onClose={() => setDetailRow(null)}
        title="文件详情"
        width="780px"
      >
        {detailRow && (
          <div>
            <div
              style={{
                padding: "14px 16px",
                borderRadius: 10,
                background: "#F8FAFC",
                border: "1px solid #E2E8F0",
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "#0F172A" }}>
                {detailRow.name}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "#64748B",
                  marginTop: 6,
                  wordBreak: "break-all",
                }}
              >
                {detailRow.source || "（无来源文件：直接以文本入库）"}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 10,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: "#F1F5F9",
                    color: "#475569",
                    fontSize: 11.5,
                    fontWeight: 600,
                  }}
                >
                  {detailRow.docType || "text"}
                </span>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: detailRow.managed ? "#F5F3FF" : "#F1F5F9",
                    color: detailRow.managed ? "#7C3AED" : "#475569",
                    fontSize: 11.5,
                    fontWeight: 600,
                  }}
                >
                  {detailRow.managed ? "本页上传" : "外部导入"}
                </span>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: "#ECFDF5",
                    color: "#059669",
                    fontSize: 11.5,
                    fontWeight: 600,
                  }}
                >
                  已挂载
                </span>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 6,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B" }}>
                切片预览（{detailRow.docs.length} 篇文档 / {fmtNum(detailRow.chunks)} 个片段）
              </div>
              {chunkData && (
                <div style={{ fontSize: 11.5, color: "#94A3B8" }}>
                  {fmtNum(chunkData.data.length)} / {fmtNum(chunkData.total)} 个片段
                  · {fmtNum(chunkData.total_chars)} 字
                </div>
              )}
            </div>
            <p
              style={{
                fontSize: 11.5,
                color: "#94A3B8",
                margin: "0 0 10px",
                lineHeight: 1.7,
              }}
            >
              下面是切片后真正写进向量库、将来被检索出来的文本。切片按语义边界（标题、段落、
              一问一答）切开，不是按字数硬截。
            </p>

            {/* 文档筛选：一份问答表会拆成多篇文档，逐篇看比一口气刷 30 个片段清楚 */}
            {detailRow.docs.length > 1 && (
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: 12,
                }}
              >
                <button
                  data-doc-chip="all"
                  onClick={() => setPreview((p) => ({ ...p, docFilter: "" }))}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: `1px solid ${preview.docFilter === "" ? "#BFDBFE" : "#E2E8F0"}`,
                    background: preview.docFilter === "" ? "#EFF6FF" : "#fff",
                    color: preview.docFilter === "" ? "#2563EB" : "#64748B",
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  全部 {fmtNum(detailRow.chunks)}
                </button>
                {detailRow.docs.map((d, i) => (
                  <button
                    key={d.doc_id}
                    data-doc-chip={d.doc_id}
                    title={d.title}
                    onClick={() =>
                      setPreview((p) => ({
                        ...p,
                        docFilter: p.docFilter === d.doc_id ? "" : d.doc_id,
                      }))
                    }
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: `1px solid ${preview.docFilter === d.doc_id ? "#BFDBFE" : "#E2E8F0"}`,
                      background: preview.docFilter === d.doc_id ? "#EFF6FF" : "#fff",
                      color: preview.docFilter === d.doc_id ? "#2563EB" : "#64748B",
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {chipTitles[i]} {d.n_chunks}
                  </button>
                ))}
              </div>
            )}

            {preview.loading && (
              <div style={{ fontSize: 12.5, color: "#94A3B8", padding: "16px 0" }}>
                正在读取切片正文…
              </div>
            )}

            {preview.error && (
              <div
                style={{
                  fontSize: 12.5,
                  color: "#B91C1C",
                  background: "#FEF2F2",
                  border: "1px solid #FECACA",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                {preview.error}
              </div>
            )}

            {chunkData && chunkData.total === 0 && (
              <div style={{ fontSize: 12.5, color: "#94A3B8", padding: "16px 0" }}>
                这个文件在库里没有任何片段。
              </div>
            )}

            {chunkData && chunkData.missing.length > 0 && (
              <div style={{ fontSize: 11.5, color: "#B45309", marginBottom: 10 }}>
                有 {chunkData.missing.length} 篇文档已不在库中（列表可能过期，刷新即可）。
              </div>
            )}

            {previewGroups.map(({ doc, chunks }) => (
              <div key={doc.doc_id} style={{ marginBottom: 14 }}>
                {!preview.docFilter && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      flexWrap: "wrap",
                      paddingBottom: 6,
                      borderBottom: "1px solid #F1F5F9",
                      marginBottom: 8,
                    }}
                  >
                    <span
                      style={{ fontSize: 12.5, fontWeight: 700, color: "#1E293B" }}
                    >
                      {doc.title}
                    </span>
                    <span style={{ fontSize: 11.5, color: "#94A3B8" }}>
                      {chunks.length === doc.n_chunks
                        ? `${doc.n_chunks} 个片段`
                        : `${chunks.length}/${doc.n_chunks} 个片段`}
                      {" · "}
                      {fmtNum(doc.n_chars)} 字
                    </span>
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {chunks.map((c) => (
                    <div
                      key={c.chunk_id}
                      data-chunk-id={c.chunk_id}
                      style={{
                        border: "1px solid #E2E8F0",
                        borderRadius: 10,
                        padding: "9px 11px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            padding: "0 6px",
                            height: 20,
                            borderRadius: 5,
                            background: "#EFF6FF",
                            color: "#2563EB",
                            fontSize: 11.5,
                            fontWeight: 700,
                            display: "inline-flex",
                            alignItems: "center",
                          }}
                        >
                          #{c.chunk_index + 1}
                        </span>
                        {c.heading && (
                          <span
                            style={{
                              padding: "2px 7px",
                              borderRadius: 5,
                              background: "#F5F3FF",
                              color: "#7C3AED",
                              fontSize: 11.5,
                              fontWeight: 600,
                            }}
                          >
                            {c.heading}
                          </span>
                        )}
                        <span
                          style={{
                            marginLeft: "auto",
                            fontSize: 11.5,
                            color: "#94A3B8",
                          }}
                        >
                          {fmtNum(c.chars)} 字
                        </span>
                      </div>
                      <ChunkText text={c.content} />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {chunkData?.truncated && (
              <p
                style={{
                  fontSize: 11.5,
                  color: "#B45309",
                  marginTop: 4,
                  lineHeight: 1.7,
                }}
              >
                一次最多展示 200 个片段，还有{" "}
                {fmtNum(chunkData.total - chunkData.data.length)} 个未展示。
              </p>
            )}

            <p
              style={{
                fontSize: 11.5,
                color: "#94A3B8",
                marginTop: 14,
                lineHeight: 1.7,
              }}
            >
              知识库文件一旦入库，正文不提供在线修改——需要更新内容时，改好原文件后
              重新上传同名文件即可（只有内容变化的部分会重新向量化）。
            </p>
          </div>
        )}
      </Drawer>

      {/* ====== 上传弹窗 ====== */}
      <Modal open={showUpload} onClose={() => setShowUpload(false)} title="上传知识库文件" width="600px">
        <div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `1.5px dashed ${dragging ? "#2563EB" : "#CBD5E1"}`,
              background: dragging ? "#EFF6FF" : "#F8FAFC",
              borderRadius: 12,
              padding: "28px 20px",
              textAlign: "center",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke={dragging ? "#2563EB" : "#94A3B8"}
              strokeWidth="1.8"
              width="34"
              height="34"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: "#1E293B",
                marginTop: 10,
              }}
            >
              点击选择文件，或把文件拖到这里
            </div>
            <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 6 }}>
              文本（.md/.txt/.json/.yaml…）与表格（.csv/.tsv/.xlsx），单个不超过{" "}
              {overview?.upload.max_upload_mb ?? 20} MB，可多选
            </div>
            <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 2 }}>
              问答型表格（含「问题 / 答案」列）会按分类拆文档、一问一答一个片段
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={acceptAttr}
              onChange={onPickFiles}
              style={{ display: "none" }}
            />
          </div>

          {/* 处理进度 */}
          <div style={{ marginTop: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: "#64748B" }}>
                处理记录{uploading ? "（上传中…）" : ""}
              </span>
              {tasks.length > 0 && activeCount === 0 && (
                <button
                  data-testid="kb-clear-tasks"
                  onClick={clearTasks}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#94A3B8",
                    fontSize: 12,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  清空记录
                </button>
              )}
            </div>

            {tasks.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: "#94A3B8",
                  padding: "12px 0",
                  textAlign: "center",
                }}
              >
                还没有上传记录
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                {tasks
                  .slice()
                  .reverse()
                  .map((t) => {
                    const meta = STATUS_META[t.status] || STATUS_META.queued;
                    const done = t.status === "done";
                    const failed = t.status === "failed";
                    const pct = Math.round((t.progress || 0) * 100);
                    return (
                      <div
                        key={t.task_id}
                        // 供端到端验证按文件名定位到具体任务的进度卡
                        data-task-file={t.filename}
                        style={{
                          border: "1px solid #E2E8F0",
                          borderRadius: 10,
                          padding: "10px 12px",
                          background: failed ? "#FFFBFB" : "#fff",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "#1E293B",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={t.filename}
                          >
                            {t.filename}
                          </span>
                          <span
                            style={{
                              flexShrink: 0,
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: meta.bg,
                              color: meta.fg,
                              fontSize: 11,
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {failed ? "失败" : t.stage_label || meta.label}
                          </span>
                        </div>

                        <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 4 }}>
                          {fmtBytes(t.size_bytes)} · {t.stage_label}
                          {t.elapsed_ms > 0 ? ` · ${(t.elapsed_ms / 1000).toFixed(1)}s` : ""}
                        </div>

                        {/* 进度条 */}
                        <div
                          role="progressbar"
                          aria-label={`${t.filename} 处理进度`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={failed ? 100 : pct}
                          style={{
                            height: 6,
                            borderRadius: 999,
                            background: "#F1F5F9",
                            marginTop: 8,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${failed ? 100 : pct}%`,
                              height: "100%",
                              borderRadius: 999,
                              background: failed
                                ? "#FCA5A5"
                                : done
                                ? "#34D399"
                                : "#2563EB",
                              transition: "width 0.35s ease",
                            }}
                          />
                        </div>

                        <div
                          style={{
                            fontSize: 11.5,
                            color: failed ? "#DC2626" : "#64748B",
                            marginTop: 6,
                            lineHeight: 1.6,
                            wordBreak: "break-word",
                          }}
                        >
                          {failed ? t.error || t.message : t.message}
                          {done && t.mode && (
                            <span style={{ color: "#94A3B8" }}>
                              {" "}
                              · 识别为{MODE_LABEL[t.mode] || t.mode}
                            </span>
                          )}
                        </div>

                        {done && t.docs.length > 0 && (
                          <div
                            style={{
                              marginTop: 8,
                              paddingTop: 8,
                              borderTop: "1px dashed #E2E8F0",
                              display: "flex",
                              flexDirection: "column",
                              gap: 3,
                            }}
                          >
                            {t.docs.map((d) => (
                              <div
                                key={d.doc_id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 8,
                                  fontSize: 11.5,
                                }}
                              >
                                <span
                                  style={{
                                    color: d.skipped ? "#94A3B8" : "#334155",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {d.skipped ? "（未变化）" : "✓"} {d.title}
                                </span>
                                <span style={{ color: "#94A3B8", flexShrink: 0 }}>
                                  {d.skipped ? "已跳过" : `${d.chunks} 片段 · ${d.tokens} token`}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              marginTop: 20,
            }}
          >
            <button
              onClick={() => setShowUpload(false)}
              style={{
                padding: "9px 18px",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 13,
                border: "1px solid #E2E8F0",
                background: "#fff",
                color: "#64748B",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {activeCount > 0 ? "后台继续处理" : "关闭"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ====== 删除确认 ====== */}
      <Modal
        open={!!deleteRow}
        onClose={() => setDeleteRow(null)}
        title="删除知识库文件"
        width="440px"
      >
        {deleteRow && (
          <div>
            <p style={{ fontSize: 13, color: "#334155", marginTop: 0, lineHeight: 1.8 }}>
              即将从知识库移除「
              <strong style={{ color: "#0F172A" }}>{deleteRow.name}</strong>
              」：
            </p>
            <ul
              style={{
                fontSize: 12.5,
                color: "#64748B",
                paddingLeft: 18,
                lineHeight: 1.9,
                margin: "4px 0 12px",
              }}
            >
              <li>{deleteRow.docs.length} 篇文档、{fmtNum(deleteRow.chunks)} 个检索片段</li>
              <li>删除后 Agent 立刻无法再检索到这些内容</li>
              {deleteRow.managed && (
                <li>同时清理上传到知识库目录的文件副本（不影响你本地的原文件）</li>
              )}
            </ul>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: "#FFFBEB",
                border: "1px solid #FDE68A",
                color: "#92400E",
                fontSize: 12,
                lineHeight: 1.7,
              }}
            >
              该操作不可撤销。需要恢复内容时，请重新上传同名文件（会重新做
              Embedding）。
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
                marginTop: 20,
              }}
            >
              <button
                onClick={() => setDeleteRow(null)}
                style={{
                  padding: "9px 18px",
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 13,
                  border: "1px solid #E2E8F0",
                  background: "#fff",
                  color: "#64748B",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                取消
              </button>
              <button
                onClick={handleDeleteConfirm}
                style={{
                  padding: "9px 18px",
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 13,
                  border: "none",
                  background: "#DC2626",
                  color: "#fff",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
