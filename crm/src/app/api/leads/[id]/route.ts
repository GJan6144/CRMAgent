import { NextRequest, NextResponse } from "next/server";
import { findLead, updateLead, deleteLead } from "../utils";
import { resolveCallerScope, isOwnedBy, notFoundResponse } from "../../_scope";

type Params = Promise<{ id: string }>;

/**
 * GET /api/leads/[id] - 获取单个线索详情
 *
 * ⚠️ 数据范围必须在这里也校验：列表过滤只挡住「看见」，
 * 但 id 是可枚举/可猜测的（LD-2026-0001），不过滤详情 = 列表白过滤。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;
  const lead = findLead(id);
  if (!lead) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }
  const caller = resolveCallerScope(request, "leads");
  if (!isOwnedBy(lead, caller, ["assignee"])) {
    // ⚠️ 返回 404 而非 403：id 可枚举（LD-2026-0001），403 等于告诉对方「这条记录存在」。
    //    对越权读一律用「未找到」掩盖存在性，与 Agent 侧 crm_get 的口径保持一致。
    return notFoundResponse("线索");
  }
  return NextResponse.json(lead);
}

/**
 * PUT /api/leads/[id] - 修改线索
 *
 * ⚠️ 两道校验：
 *   ① 只能改**自己的**线索（isOwnedBy）；
 *   ② **禁止把线索转给别人** —— 否则受限用户可以先建自己的、再改 assignee 甩锅，
 *      或把别人的线索「认领」到自己名下（与原数据变为可越权访问）。
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const existing = findLead(id);
    if (!existing) {
      return NextResponse.json({ error: "线索不存在" }, { status: 404 });
    }

    const caller = resolveCallerScope(request, "leads");
    if (!isOwnedBy(existing, caller, ["assignee"])) {
      return NextResponse.json({ error: "无权修改该数据" }, { status: 403 });
    }
    // 受限用户禁止改归属字段（防「甩锅」/「认领」）
    if (caller.restricted && body.assignee != null && String(body.assignee).trim() !== caller.user_name) {
      return NextResponse.json(
        { error: `当前权限仅能保持线索归属自己（跟进人须为 ${caller.user_name}）` },
        { status: 403 }
      );
    }

    const updated = updateLead(id, body);
    if (!updated) {
      return NextResponse.json({ error: "线索不存在" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}

/**
 * DELETE /api/leads/[id] - 删除线索
 *
 * ⚠️ 同样必须校验归属：否则受限用户删掉别人的线索，数据直接消失。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { id } = await params;
  const existing = findLead(id);
  if (!existing) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }
  const caller = resolveCallerScope(request, "leads");
  if (!isOwnedBy(existing, caller, ["assignee"])) {
    return NextResponse.json({ error: "无权删除该数据" }, { status: 403 });
  }
  const deleted = deleteLead(id);
  if (!deleted) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }
  return NextResponse.json({ message: "删除成功" });
}
