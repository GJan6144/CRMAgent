/** DeepAgents 服务：会话 */
export interface AgentSession {
  id: string;
  title: string;
  pinned?: boolean;
  created_at: string;
  updated_at: string;
}

/** DeepAgents 服务：历史消息 */
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "thinking" | string;
  content: string;
  created_at: string;
  /** 该条消息携带的数据卡片（render_card 工具产出），刷新后用于还原 */
  cards?: CardPayload[];
}

/* ============================ 对话流数据卡片 ============================ */

/** 卡片顶部信息条的一项 */
export interface CardMeta {
  label: string;
  value: string;
}

/** 卡片主体项的状态色；缺省为 neutral */
export type CardTone = "high" | "mid" | "low" | "warn" | "info" | "neutral";

/** 卡片主体的一项 */
export interface CardSection {
  label: string;
  value: string;
  tone?: CardTone;
}

/** render_card 工具产出的数据卡片（结构化展示分析结果） */
export interface CardPayload {
  /** 卡片唯一标识，用于 React key 与去重 */
  card_id: string;
  /** 卡片类型，前端据此选择版式（未知类型走通用版式） */
  card_type: string;
  title: string;
  data: {
    meta?: CardMeta[];
    sections: CardSection[];
  };
}

/** Agent 执行过程中的工具调用 */
export interface ToolActivity {
  id: string;
  name: string;
  args?: string;
  result?: string;
  /** running=执行中 · pending=等待审批 · success=成功 · error=失败/被拒绝 · blocked=被策略禁止 */
  status: "running" | "pending" | "success" | "error" | "blocked";
}

/** 界面渲染用的消息（含流式临时态） */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolActivity[];
  /** 本轮产出的数据卡片，随 card 事件即时追加 */
  cards?: CardPayload[];
  pending?: boolean;
  error?: string;
  created_at?: string;
}

/** 文件修改 / CRM 写操作 审批请求 */
export interface ApprovalRequest {
  tool?: string;
  name?: string;
  args?: string | Record<string, unknown>;
  description?: string;
  /** "fs" = 文件修改 · "crm" = CRM 业务数据写操作 */
  kind?: string;
  [key: string]: unknown;
}

/** DeepAgents 服务推送的 SSE 事件 */
export type AgentEvent =
  | { event: "llm_token"; token: string; node?: string; ts?: string }
  | { event: "llm_thinking"; thinking: string; node?: string; ts?: string }
  | { event: "tool_start"; id?: string; name?: string; args?: string; node?: string; ts?: string }
  | {
      event: "tool_end";
      id?: string;
      name?: string;
      result?: string;
      tool_status?: string;
      node?: string;
      ts?: string;
    }
  | {
      event: "tool_blocked";
      id?: string;
      name?: string;
      args?: string;
      /** 被禁原因（用于展示在「禁止」提示里） */
      reason?: string;
      /** 策略标识："crm_delete" / "fs_delete" / "fs_create" */
      policy?: string;
      node?: string;
      ts?: string;
    }
  | { event: "todo"; todos?: unknown[]; node?: string; ts?: string }
  | {
      event: "card";
      id?: string;
      name?: string;
      /** render_card 工具产出的数据卡片 */
      card?: CardPayload;
      node?: string;
      ts?: string;
    }
  | { event: "loop"; node?: string; msg_count?: number; ts?: string }
  | { event: "approval_request"; requests?: ApprovalRequest[]; ts?: string }
  | { event: "done"; message_id?: string; ts?: string }
  | { event: "error"; error?: string; ts?: string }
  | { event: string; [key: string]: unknown };

/** 服务连通状态 */
export type ConnectionState = "checking" | "online" | "offline";

/* ============================ Agent 控制面板 ============================ */

/** 工具权限档：直接使用 / 人工审批 / 禁止 */
export type ToolPolicy = "allow" | "approval" | "deny";

/** 面板工具项 */
export interface PanelTool {
  name: string;
  label: string;
  category: string;
  desc: string;
  enabled: boolean;
  policy: ToolPolicy;
  policy_label: string;
}

/** 配置摘要 */
export interface PanelSummary {
  system_prompt_custom: boolean;
  updated_at: string | null;
  enabled_tools: string[];
  disabled_tools: string[];
  approval_tools: string[];
  deny_tools: string[];
  policy_counts: Record<ToolPolicy, number>;
}

/** 面板配置（系统提示词 + 工具清单） */
export interface PanelConfig {
  system_prompt: string;
  default_system_prompt: string;
  is_custom: boolean;
  updated_at: string | null;
  policy_options: { value: ToolPolicy; label: string }[];
  categories: string[];
  tools: PanelTool[];
  summary: PanelSummary;
}

/** 用量指标 */
export interface PanelUsage {
  calls: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  tool_calls: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  llm_calls: number;
  errors: number;
  last_ts: string | null;
}

/** 服务信息 */
export interface PanelService {
  name: string;
  status: string;
  model: string;
  backend: string;
  port: number;
  pid: number;
  python: string;
  started_at: string;
  uptime_seconds: number;
}

/** 健康检查项 */
export interface PanelHealth {
  api: boolean;
  checkpointer: boolean;
  store: boolean;
  chat_db: boolean;
  agent_state_db: boolean;
  status: string;
}

/** 趋势点 */
export interface PanelTrendPoint {
  date: string;
  calls: number;
  tokens: number;
  tool_calls: number;
  avg_latency_ms: number;
}

/** Agent 概览 */
export interface PanelOverview {
  service: PanelService;
  health: PanelHealth;
  model: {
    name: string;
    base_url: string;
    connected: boolean | null;
    checked_at: string | null;
    latency_ms: number | null;
  };
  usage: { today: PanelUsage; total: PanelUsage };
  trend: PanelTrendPoint[];
  config: PanelSummary;
}

/* ============================ Skill 管理 ============================ */

/** 面板技能项（服务端每次实时扫盘技能目录得到） */
export interface PanelSkill {
  /** 技能名 = 技能目录名 = frontmatter 的 name（三者必须一致，否则框架会静默跳过） */
  name: string;
  /** 功能简介，取自 frontmatter 的 description —— 也是模型判断「何时用这个技能」的唯一依据 */
  description: string;
  /** 来源标签：Built-in / Project Deepagents / Project Agents / Project Claude / Chat UI */
  source: string;
  /** 来源目录的虚拟路径 */
  source_path: string;
  /** SKILL.md 的真实磁盘路径 */
  path: string;
  /** SKILL.md 在 agent 文件系统里的虚拟路径（模型 read_file 用的就是它） */
  virtual_path: string;
  /** 开关：关闭后不进系统提示词，读取其 SKILL.md 也会被拦截 */
  enabled: boolean;
  /** 框架能否正常加载（false = 会被静默跳过，problems 里有原因） */
  valid: boolean;
  /** 导致框架跳过该技能的问题；空数组 = 正常 */
  problems: string[];
  /** 不阻塞加载、但值得提醒的问题（如 allowed_tools 写成下划线） */
  warnings: string[];
  size: number;
  mtime: string | null;
  lines: number;
  chars: number;
  allowed_tools: string[];
  compatibility: string | null;
  license: string | null;
  /** 技能目录里 SKILL.md 之外的附属文件数（scripts/、references/ 等） */
  extra_files: number;
  /** 内置技能来自框架源码目录，改了会在框架升级/重装时被覆盖 */
  builtin: boolean;
}

/** 技能清单汇总 */
export interface PanelSkillSummary {
  total: number;
  enabled: number;
  disabled: number;
  /** 框架加载不了的（会被静默跳过） */
  invalid: number;
  builtin: number;
  sources: { label: string; path: string; count: number }[];
  /** 配置里关掉、但磁盘上已无同名技能的孤儿记录 */
  orphan_disabled: string[];
  updated_at: string | null;
}

/** 技能清单响应 */
export interface PanelSkillsResponse {
  skills: PanelSkill[];
  summary: PanelSkillSummary;
  backup_dir: string;
  limit_bytes: number;
}

/** 技能正文（编辑弹窗用） */
export interface PanelSkillContent {
  name: string;
  content: string;
  path: string;
  virtual_path: string;
  source: string;
  builtin: boolean;
  size: number;
  chars: number;
  lines: number;
  mtime: string | null;
  problems: string[];
  warnings: string[];
  backup_dir: string;
  limit_bytes: number;
}

/** 模型连通性探测结果 */
export interface PanelModelCheck {
  ok: boolean;
  model: string;
  latency_ms: number;
  tested_at: string;
  reply_preview: string;
  error: string;
}
