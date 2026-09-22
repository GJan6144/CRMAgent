import { NextRequest } from "next/server";
import type { Role } from "@/types/role";
import { readRoles } from "@/app/api/roles/utils";

/**
 * CRM 页面侧的「数据范围」解析。
 *
 * ============================================================
 *  为什么必须有这个文件
 * ============================================================
 * 角色页可以把某个页面的 `dataScope` 设成「仅自己」，但**这只写进了 roles.json**。
 * 在本次修复之前，`leads` 等页面的 API 一律 `readLeads()` 全量返回 + 筛选 + 分页，
 * 从不看调用者是谁 —— 于是「设置生效了但没人消费」，销售依然能看见全部线索。
 *
 * 本模块是**唯一的身份收口点**：所有页面级 API 都从这里取过滤条件。
 *
 * ============================================================
 *  三条硬约定
 * ============================================================
 * 1. ⚠️ **前端只声明「是谁」，不声明「能看什么」**。
 *    请求体/查询串里的 `user_name` / `user_phone` / `role_id` 仅用于**定位角色**，
 *    真正的 `dataScope` 一律由服务端 `readRoles()` 反查得到。
 *    绝不能让前端传 `scope=全部` 就真的放行（那是可篡改的提权漏洞）。
 *
 * 2. ⚠️ **查不到身份 → 回落「全部」**（向后兼容）。
 *    老脚本、直连 curl、内部调用都不带身份。如果缺身份就收紧成「仅自己」，
 *    会让所有既有测试与手工调用集体拿到空列表，属于破坏性变更。
 *
 * 3. ⚠️ **收紧只在「仅自己」且拿到有效姓名时生效**（`restricted`）。
 *    拿不到姓名就没法做归属匹配 → 此时不收紧（宁可放宽，也不能把用户自己的数据挡掉）。
 */

/** 身份解析结果 */
export interface CallerScope {
  /** 是否在 roles.json 中匹配到了角色 */
  found: boolean;
  /** 该页面的数据范围 */
  scope: "全部" | "仅自己";
  /** 当前用户姓名（用于归属字段匹配，如 leads.assignee） */
  user_name: string;
  /** 当前用户手机号 */
  user_phone: string;
  /** 角色 ID */
  role_id: string;
  /** 角色名 */
  role_name: string;
  /** **真正生效的收紧标志**：scope==='仅自己' 且 有姓名 */
  restricted: boolean;
}

/** 未受限的默认结果（查不到角色 / 全部范围 / 无姓名时使用） */
function unrestricted(pageKey: string): CallerScope {
  void pageKey;
  return {
    found: false,
    scope: "全部",
    user_name: "",
    user_phone: "",
    role_id: "",
    role_name: "",
    restricted: false,
  };
}

/**
 * 从请求中解析当前调用者在该页面的数据范围。
 *
 * 身份来源（按优先级）：
 *   1. 查询串 `user_phone` / `user_name` / `role_id`
 *   2. 请求头 `x-user-phone` / `x-user-name` / `x-role-id`
 *
 * ⚠️ 只取「是谁」，`scope` 永远由服务端从 roles.json 反查。
 */
export function resolveCallerScope(request: NextRequest, pageKey: string): CallerScope {
  let { searchParams } = new URL(request.url);
  const headers = request.headers;

  // 兼容两种命名：查询串（HTTP 风格）与请求头（内部调用风格）
  const pick = (...names: string[]): string => {
    for (const n of names) {
      const v = searchParams.get(n) ?? headers.get(n);
      if (v && v.trim()) return v.trim();
    }
    return "";
  };

  const user_phone = pick("user_phone", "x-user-phone");
  const user_name = pick("user_name", "x-user-name");
  const role_id = pick("role_id", "role-id", "x-role-id");

  return resolveScopeByIdentity(pageKey, { user_phone, user_name, role_id });
}

/**
 * 按身份解析数据范围（与请求解耦，便于单测与内部复用）。
 */
export function resolveScopeByIdentity(
  pageKey: string,
  identity: { user_phone?: string; user_name?: string; role_id?: string }
): CallerScope {
  const user_phone = (identity.user_phone ?? "").trim();
  const user_name = (identity.user_name ?? "").trim();
  const role_id = (identity.role_id ?? "").trim();

  // 没有任何身份 → 不收紧（约定 2）
  if (!role_id && !user_phone && !user_name) {
    return unrestricted(pageKey);
  }

  const roles = readRoles();

  // 定位角色：优先 role_id，其次按姓名/手机号在角色里反查是不可靠的
  // （角色不记成员），所以只认 role_id；没有 role_id 时无法判定 → 不收紧。
  const role: Role | undefined = role_id ? roles.find((r) => r.id === role_id) : undefined;

  if (!role) {
    return unrestricted(pageKey);
  }

  const perm = role.permissions.find((p) => p.pageKey === pageKey);
  if (!perm) {
    // 该角色没配这个页面 → 页面本身不该可见（由 usePermission 拦），此处不收紧
    return {
      found: true,
      scope: "全部",
      user_name,
      user_phone,
      role_id: role.id,
      role_name: role.name,
      restricted: false,
    };
  }

  const scope: "全部" | "仅自己" = perm.dataScope === "仅自己" ? "仅自己" : "全部";
  // 约定 3：仅自己 + 有姓名 才真正收紧
  const restricted = scope === "仅自己" && !!user_name;

  return {
    found: true,
    scope,
    user_name,
    user_phone,
    role_id: role.id,
    role_name: role.name,
    restricted,
  };
}

/**
 * 通用行过滤：按「归属字段 === 当前用户名」保留。
 *
 * ⚠️ `restricted` 为 false 时**原样返回**，不做任何过滤。
 *
 * ⚠️ 泛型用 `T extends object` + 内部按索引签名读取，而不是 `T extends Record<string, unknown>`：
 *    后者会把 `Lead` / `Communication` 这类**具名 interface** 排除掉
 *    （interface 不满足 `Record` 的隐式索引签名），调用处会报 TS2345。
 *
 * @param rows        原始行
 * @param caller      解析出的调用者范围
 * @param ownerFields 归属字段名（可多个，任一命中即保留）
 */
export function filterByOwner<T extends object>(
  rows: T[],
  caller: CallerScope,
  ownerFields: string[]
): T[] {
  if (!caller.restricted || !caller.user_name) return rows;
  return rows.filter((row) =>
    ownerFields.some(
      (f) => String((row as Record<string, unknown>)[f] ?? "") === caller.user_name
    )
  );
}

/**
 * 判断某一行是否属于当前调用者（用于详情/改/删的越权校验）。
 */
export function isOwnedBy<T extends object>(
  row: T,
  caller: CallerScope,
  ownerFields: string[]
): boolean {
  if (!caller.restricted || !caller.user_name) return true;
  return ownerFields.some(
    (f) => String((row as Record<string, unknown>)[f] ?? "") === caller.user_name
  );
}

/** 越权访问的统一响应（默认 403，用于**写**操作：明确告诉调用方"你无权改"） */
export function deniedResponse(): Response {
  return Response.json({ error: "无权访问该数据" }, { status: 403 });
}

/**
 * ⚠️ 越权**读**的统一响应：一律 **404「不存在」**，不要回 403。
 *
 * 原因：主键 id 是**可枚举**的（LD-2026-0001、LD-2026-0002…），回 403 等于确认
 * 「这条记录存在，只是你看不到」→ 泄露记录存在性，可被用来探测数据规模。
 * 与 Agent 侧 `crm_get` 口径一致（命中他人记录返回「未找到记录」）。
 *
 * @param label 实体中文名（如「线索」），用于拼 "线索不存在"
 */
export function notFoundResponse(label: string): Response {
  return Response.json({ error: `${label}不存在` }, { status: 404 });
}
