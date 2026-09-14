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

/** 模型连通性探测结果 */
export interface PanelModelCheck {
  ok: boolean;
  model: string;
  latency_ms: number;
  tested_at: string;
  reply_preview: string;
  error: string;
}
