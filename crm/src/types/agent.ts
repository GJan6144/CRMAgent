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
  /** 该条消息携带的任务清单（write_todos 快照），刷新后用于还原 */
  todos?: AgentTodo[];
  /** 该条消息携带的图片附件元数据（不含 base64），刷新后用于还原 */
  images?: ChatImage[];
  /** 该条消息携带的文件附件元数据（不含正文），刷新后用于还原 */
  files?: ChatFile[];
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
  /**
   * 本轮的任务清单（write_todos）；`write_todos` 每次回传完整清单，因此整体替换。
   * 挂在消息上（而非全局），这样每轮回答各自保留自己的清单。
   */
  todos?: AgentTodo[];
  /** 该消息附带的图片附件（仅元数据；原图按需经 `/api/agent/images/{id}` 取 data_url） */
  images?: ChatImage[];
  /** 该消息附带的文件附件（仅元数据；对话流以标签文字形式展示） */
  files?: ChatFile[];
  pending?: boolean;
  error?: string;
  created_at?: string;
}

/* ============================ 图片附件 ============================ */

/** 已上传的图片附件元数据（不含 base64，避免拖慢历史消息接口） */
export interface ChatImage {
  id: string;
  session_id?: string;
  filename: string;
  mime: string;
  size: number;
  created_at?: string;
}

/** `GET /api/images/{id}` 的响应：带可直接塞进 <img src> 的 data_url */
export interface ChatImageDetail extends ChatImage {
  data_url: string;
}

/* ============================ 文件附件 ============================ */

/** 已上传的文件附件元数据（不含正文，避免拖慢历史消息接口） */
export interface ChatFile {
  id: string;
  session_id?: string;
  filename: string;
  mime: string;
  size: number;
  /** 正文字符数（供标签 tooltip 展示「内容多长」） */
  chars?: number;
  created_at?: string;
}

/** `GET /api/files/{id}` 的响应：带正文 */
export interface ChatFileDetail extends ChatFile {
  text: string;
}

/* ============================ 任务清单（write_todos） ============================ */

/** 待办项状态：未开始 / 进行中 / 已完成 */
export type AgentTodoStatus = "pending" | "in_progress" | "completed";

/** `write_todos` 工具维护的一条待办（每次调用回传完整清单） */
export interface AgentTodo {
  content: string;
  status: AgentTodoStatus;
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
  | { event: "todo"; todos?: AgentTodo[]; node?: string; ts?: string }
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
  | { event: "done"; message_id?: string; context?: ContextUsage; ts?: string }
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

/* ==================== token 消耗统计（按用户） ==================== */

/** 单个用户的 token 消耗 */
export interface TokenUsageUser {
  phone: string;
  name: string;
  role_name: string;
  /** false = 无归属的历史数据（「未知用户」） */
  known: boolean;
  turns: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  llm_calls: number;
  tool_calls: number;
  last_ts: string | null;
  /** 占总量百分比（0-100，两位小数） */
  percent: number;
  /* ---- 月度额度（每个用户各自）---- */
  /** 本月已用 token */
  month_used: number;
  /** 该角色的月额度（0 = 不限额） */
  quota: number;
  /** month_used / quota（0-1+） */
  quota_ratio: number;
  /** 百分比（0-100+） */
  quota_percent: number;
  quota_unlimited: boolean;
  quota_exceeded: boolean;
}

/** token 消耗统计响应（总量 + 按用户拆分） */
export interface TokenUsageResponse {
  scope: "all" | "today";
  totals: {
    turns: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    llm_calls: number;
    tool_calls: number;
    /** 按字符数估算（供应商未回真实用量）的轮数 */
    estimated_turns: number;
    errors: number;
  };
  users: TokenUsageUser[];
  /** 有归属的用户数（不含「未知用户」） */
  user_count: number;
  /** 自检：各用户合计应等于总量 */
  self_check: {
    users_sum: number;
    grand_total: number;
    delta: number;
    consistent: boolean;
  };
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

/* ============================ MCP 管理 ============================ */

/** 面板 MCP 项（服务端由「默认定义 × 覆盖项」合并得到） */
export interface PanelMcp {
  /** MCP 标识（唯一，等同配置里的 server 名） */
  name: string;
  /** 中文名 */
  label: string;
  /** MCP 介绍 */
  description: string;
  /** 连接传输类型：stdio / sse / streamable_http / websocket */
  transport: string;
  /** 是否内置（内置可被删除，但「恢复默认」会再回来；自定义删除即消失） */
  builtin: boolean;
  /** 开关：关闭后 Agent 不可用该 MCP 的所有工具 */
  enabled: boolean;
  /** 连接配置（transport / command / args / url 等） */
  config: Record<string, unknown>;
  /** 该 MCP 暴露的工具名列表 */
  tools: string[];
  /** 已发现的工具数 */
  tool_count: number;
  /** 加载 / 发现失败时的错误信息（null = 正常） */
  load_error: string | null;
}

/** MCP 清单汇总 */
export interface PanelMcpSummary {
  total: number;
  enabled: number;
  disabled: number;
  tool_count: number;
}

/** MCP 清单响应 */
export interface PanelMcpsResponse {
  mcps: PanelMcp[];
  summary: PanelMcpSummary;
}

/** MCP 完整定义原文（编辑弹窗用） */
export interface PanelMcpConfig {
  name: string;
  /** 完整定义 JSON 原文（name / label / description / config） */
  config: string;
  enabled: boolean;
}

/** 通信渠道（「渠道管理」Tab） */
export interface PanelChannel {
  name: string;
  label: string;
  description: string;
  /** 开关：开启后 Agent 可用该渠道（工具 + 接收消息） */
  enabled: boolean;
  /** 是否已配置凭证（App ID / App Secret） */
  configured: boolean;
}

export interface PanelChannelSummary {
  total: number;
  enabled: number;
  disabled: number;
}

export interface PanelChannelsResponse {
  channels: PanelChannel[];
  summary: PanelChannelSummary;
}

/** 长期记忆条目（store 的 memories 命名空间） */
export interface PanelMemoryEntry {
  key: string;
  value: string;
}

/** 记忆汇总（「记忆」Tab） */
export interface PanelMemorySummary {
  memories_count: number;
}

/** 记忆数据（「记忆」Tab） */
export interface PanelMemoryResponse {
  memories: PanelMemoryEntry[];
  agents_md: string;
  summary: PanelMemorySummary;
  store_ready: boolean;
}

/** Agent 模型（「模型管理」Tab + 对话界面模型下拉框） */
export interface PanelModel {
  /** 模型 ID（唯一标识，创建后不可改） */
  id: string;
  /** 模型名称（传给供应商的实际 model 名） */
  name: string;
  /** API 地址（OpenAI 兼容 base_url） */
  base_url: string;
  /** 是否已配置 key（不回传明文） */
  key_configured: boolean;
  /** key 是否来自环境变量（未单独配置） */
  key_from_env: boolean;
  /** 是否支持图片识别（多模态） */
  vision: boolean;
  /** 上下文长度（token） */
  context_length: number;
  /** 开关：关闭后不可被对话选用 */
  enabled: boolean;
}

export interface PanelModelSummary {
  total: number;
  enabled: number;
  disabled: number;
  /** 支持图片识别的模型数 */
  vision: number;
}

export interface PanelModelsResponse {
  models: PanelModel[];
  summary: PanelModelSummary;
  /** 当前选中（对话默认使用）的模型 id */
  selected: string;
}

/** 对话界面下拉框数据源（仅启用中的模型） */
export interface ActiveModelsResponse {
  models: PanelModel[];
  selected: string;
}

/** 上下文用量（对话页底部环形图标 + 弹窗） */
export interface ContextUsage {
  session_id: string;
  /** 计算所用模型 id */
  model: string;
  /** 已用上下文（token） */
  used_tokens: number;
  /** 模型最大上下文（token） */
  max_tokens: number;
  /** 占比 0~1 */
  ratio: number;
  /** 占比百分数 0~100（已保留两位小数） */
  percent: number;
  /** 是否由字符数粗估而来（供应商未回传真实用量） */
  estimated: boolean;
}
