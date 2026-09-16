/**
 * Agent 知识库（知识库文件管理页）相关类型。
 *
 * 数据来自 chat-ui 的 /api/kb/* 接口（前端通过 /api/agent/kb/* 代理转发）。
 *
 * 一个「文件」与一个「文档」不是一对一：一份问答型 CSV 会按分类拆成多篇文档，
 * 每篇文档是一个独立的检索/引用单元。所以列表页按**来源文件**聚合展示，
 * 文件详情里再列出它拆出的文档。
 */

/** 知识库文档（= 一个检索单元） */
export interface KbDocument {
  doc_id: string;
  title: string;
  source: string | null;
  doc_type: string;
  tags: string;
  n_chunks: number;
  n_chars: number;
  created_at: string;
  updated_at: string;
  /** 来源文件名（不含目录） */
  source_name: string;
  /** 来源文件是否还在磁盘上 */
  source_exists: boolean;
  source_size: number;
  /** 来源文件是否在上传受管目录内（删除文档时会连带清理） */
  managed: boolean;
}

/** 库级统计 */
export interface KbStats {
  db_path: string;
  dim: number;
  model: string;
  documents: number;
  chunks: number;
  total_chars: number;
  size_bytes: number;
}

/** 上传能力（允许的类型、大小上限） */
export interface KbUploadCapability {
  upload_dir: string;
  allowed_suffixes: string[];
  max_upload_mb: number;
  xlsx_supported: boolean;
  max_table_rows_per_chunk: number;
}

export interface KbOverview {
  stats: KbStats;
  upload: KbUploadCapability;
  embedding: {
    model: string;
    base_url: string;
    dim: number;
    batch_size: number;
    api_key_configured: boolean;
    api_key_hint: string;
  };
}

export interface KbDocumentListResponse {
  data: KbDocument[];
  total: number;
  stats: KbStats;
}

/**
 * 切片后的单个片段 —— 「切片预览」抽屉展示的最小单位。
 *
 * 它就是真正写进向量库、将来被检索出来的那段文本：`content` 是原文，
 * `heading` 是它归属的小节（问答表里就是「分类」列）。
 */
export interface KbChunk {
  chunk_id: number;
  doc_id: string;
  /** 文档内的片段序号，从 0 开始 */
  chunk_index: number;
  heading: string;
  /** 切片后的正文（保留原始换行） */
  content: string;
  chars: number;
}

/** 切片预览响应（GET /api/kb/chunks） */
export interface KbChunkListResponse {
  data: KbChunk[];
  /** 命中的片段总数；可能大于 data.length（受 limit / offset 影响） */
  total: number;
  total_chars: number;
  offset: number;
  limit: number;
  /** 是否还有未返回的片段 */
  truncated: boolean;
  /** 命中文档的元信息，按请求传入的 doc_id 顺序排列 */
  documents: {
    doc_id: string;
    title: string;
    source: string | null;
    doc_type: string;
    tags: string;
    n_chunks: number;
    n_chars: number;
  }[];
  /** 已不存在于库中的 doc_id（列表可能过期） */
  missing: string[];
}

/** 一个入库任务产出的单篇文档 */
export interface KbTaskDoc {
  doc_id: string;
  title: string;
  chunks: number;
  tokens: number;
  skipped: boolean;
  meta_updated: boolean;
}

export type KbTaskStatus = "queued" | "running" | "done" | "failed";

/** 上传任务（前端据此渲染处理进度） */
export interface KbTask {
  task_id: string;
  filename: string;
  stored_path: string;
  size_bytes: number;
  tags: string;
  status: KbTaskStatus;
  /** queued | parsing | chunking | embedding | writing | done | failed */
  stage: string;
  stage_label: string;
  /** 0 ~ 1 */
  progress: number;
  message: string;
  /** text | faq-table | table | mixed-table */
  mode: string;
  docs: KbTaskDoc[];
  chunks: number;
  tokens: number;
  added: number;
  skipped: number;
  error: string;
  created_at: string;
  updated_at: string;
  elapsed_ms: number;
}

export interface KbTaskListResponse {
  data: KbTask[];
  active: boolean;
}

export interface KbDeleteResponse {
  removed: { doc_id: string; title: string; source: string }[];
  removed_chunks: number;
  missing: string[];
  freed_files: string[];
  stats: KbStats;
  list: KbDocumentListResponse;
}

/** 前端按来源文件聚合出来的一行 */
export interface KbFileRow {
  /** 聚合键：来源路径，或（无来源时）doc_id */
  key: string;
  /** 展示用的文件名 */
  name: string;
  source: string;
  managed: boolean;
  sourceExists: boolean;
  docType: string;
  docs: KbDocument[];
  chunks: number;
  chars: number;
  size: number;
  updatedAt: string;
}
