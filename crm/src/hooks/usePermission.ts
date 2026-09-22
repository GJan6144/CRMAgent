"use client";

import { useCallback, useMemo } from "react";
import { useAuth } from "@/context/AuthContext";

/**
 * 权限工具 Hook
 * 根据当前用户的角色权限，判断页面/功能/数据权限
 *
 * ⚠️⚠️ 返回值必须**引用稳定**（`useMemo` 包裹）。
 *    早期版本直接返回对象字面量 → 每次渲染都是新对象 → 调用方把它放进
 *    useCallback/useEffect 依赖时会**无限循环**（页面永远「加载中...」，
 *    请求疯狂重复，React 报 "Maximum update depth exceeded"）。
 *    → 这里统一 memo，并在返回值里额外暴露稳定的原始字段（scopeName 等），
 *      调用方的依赖数组优先用这些字符串，而不是整个对象。
 */
export function usePermission(pageKey: string) {
  const { role, user } = useAuth();

  const scopeName = user?.name ?? "";
  const scopePhone = user?.phone ?? "";
  const scopeRoleId = user?.roleId ?? "";

  /**
   * ★ 构造「我是谁」的查询参数，用于页面级 API 的数据范围过滤。
   *
   * ⚠️ 只传**身份**，不传 scope —— 服务端会自己读 roles.json 反查该页面的
   *    dataScope。前端传 scope 是可篡改的提权漏洞，`_scope.ts` 明确不接受。
   *
   * 用法：`fetch(`/api/leads?${scopeParams().toString()}`)`
   */
  const scopeParams = useCallback((): URLSearchParams => {
    const p = new URLSearchParams();
    if (scopeName) {
      p.set("user_name", scopeName);
      p.set("user_phone", scopePhone);
      p.set("role_id", scopeRoleId);
    }
    return p;
  }, [scopeName, scopePhone, scopeRoleId]);

  const perm = role?.permissions.find((p) => p.pageKey === pageKey);

  return useMemo(() => {
    // 未登录 / 无角色 / 该角色没配这个页面 → 无任何权限
    if (!role || !user || !perm) {
      return {
        canViewPage: false,
        canView: false,
        canAdd: false,
        canEdit: false,
        canDelete: false,
        dataScope: "仅自己" as const,
        restricted: true,
        scopeParams,
        currentUserName: scopeName,
        scopePhone,
        scopeRoleId,
      };
    }

    const dataScope = perm.dataScope === "仅自己" ? ("仅自己" as const) : ("全部" as const);

    return {
      canViewPage: true, // 有该页面的权限配置即可访问
      canView: perm.functions.includes("查看"),
      canAdd: perm.functions.includes("增加"),
      canEdit: perm.functions.includes("修改"),
      canDelete: perm.functions.includes("删除"),
      dataScope,
      /** 是否受「仅自己」约束（前端用它决定 UI 限制，服务端仍会独立校验） */
      restricted: dataScope === "仅自己" && !!scopeName,
      scopeParams,
      currentUserName: scopeName,
      scopePhone,
      scopeRoleId,
    };
  }, [role, user, perm, scopeParams, scopeName, scopePhone, scopeRoleId]);
}

/**
 * 检查当前角色是否有某个页面的访问权限
 */
export function canAccessPage(role: { permissions: { pageKey: string }[] } | null, pageKey: string): boolean {
  if (!role) return false;
  return role.permissions.some((p) => p.pageKey === pageKey);
}
