import { NextRequest, NextResponse } from "next/server";
import { findRole, updateRole, deleteRole } from "../utils";

type Params = Promise<{ id: string }>;

/**
 * GET /api/roles/[id] - 获取单个角色详情
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;
  const role = findRole(id);
  if (!role) {
    return NextResponse.json({ error: "角色不存在" }, { status: 404 });
  }
  return NextResponse.json(role);
}

/**
 * PUT /api/roles/[id] - 修改角色（名称 / 权限）
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;
  try {
    const body = await request.json();

    // 额度校验：只接受 ≥ 0 的整数（0 = 不限额）。非法值直接拒绝，
    // 免得写进 roles.json 让 Agent 侧解析到脏数据。
    if (body && body.monthlyTokenQuota !== undefined && body.monthlyTokenQuota !== null) {
      const q = Number(body.monthlyTokenQuota);
      if (!Number.isInteger(q) || q < 0) {
        return NextResponse.json(
          { error: "每月额度必须是 ≥ 0 的整数（0 表示不限额）" },
          { status: 400 }
        );
      }
      body.monthlyTokenQuota = q;
    }

    const updated = updateRole(id, body);
    if (!updated) {
      return NextResponse.json({ error: "角色不存在" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}

/**
 * DELETE /api/roles/[id] - 删除角色
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;
  const deleted = deleteRole(id);
  if (!deleted) {
    return NextResponse.json({ error: "角色不存在" }, { status: 404 });
  }
  return NextResponse.json({ message: "删除成功" });
}
