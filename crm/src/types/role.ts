/** 权限项：一个页面的权限配置 */
export interface PermissionItem {
  pageKey: string;
  pageLabel: string;
  functions: string[];
  dataScope: "全部" | "仅自己";
}

/** 角色数据 */
export interface Role {
  id: string;
  createdAt: string;
  name: string;
  /** 每月 token 额度（**该角色下每个用户各自**享用）。0 = 不限额。缺省按 DEFAULT_MONTHLY_TOKEN_QUOTA */
  monthlyTokenQuota?: number;
  permissions: PermissionItem[];
}

/** 新增角色请求体 */
export interface CreateRoleRequest {
  name: string;
}

/** 角色列表查询参数 */
export interface RoleQuery {
  name?: string;
}

/** 角色列表 API 响应 */
export interface RoleListResponse {
  data: Role[];
  total: number;
  page: number;
  pageSize: number;
}

/** 可用页面列表 */
export const AVAILABLE_PAGES = [
  { key: "dashboard", label: "数据仪表盘" },
  { key: "leads", label: "线索管理" },
  { key: "products", label: "商品管理" },
  { key: "orders", label: "订单管理" },
  { key: "roles", label: "角色与权限" },
  { key: "accounts", label: "账号管理" },
  { key: "communications", label: "沟通记录" },
  { key: "chat", label: "AI 助手" },
  { key: "agent", label: "Agent 控制面板" },
  { key: "kb", label: "Agent 知识库" },
  { key: "files", label: "AI 生成文件管理" },
  { key: "schedules", label: "Agent 定时任务" },
] as const;

/** 可用功能权限 */
export const AVAILABLE_FUNCTIONS = ["查看", "修改", "增加", "删除"] as const;

/** 可用数据范围 */
export const DATA_SCOPES = ["全部", "仅自己"] as const;

/** 新建角色的每月 token 额度默认值（每个用户各自享用） */
export const DEFAULT_MONTHLY_TOKEN_QUOTA = 1_000_000;

/** 额度耗尽时的提示文案（与 chat-ui 服务端保持一致） */
export const QUOTA_EXCEEDED_TEXT = "当前额度已用完，联系管理员申请额度";

/** 额度预设档位（供角色页快捷选择） */
export const QUOTA_PRESETS = [
  { label: "50 万", value: 500_000 },
  { label: "100 万", value: 1_000_000 },
  { label: "200 万", value: 2_000_000 },
  { label: "500 万", value: 5_000_000 },
] as const;
