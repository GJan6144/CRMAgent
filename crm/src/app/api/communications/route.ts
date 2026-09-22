import { NextRequest, NextResponse } from "next/server";
import type { Communication, CommunicationQuery } from "@/types/communication";
import { readCommunications } from "./utils";
import { resolveCallerScope, filterByOwner } from "../_scope";
import { readLeads } from "../leads/utils";

/**
 * GET /api/communications - 获取沟通记录列表（支持筛选）
 *
 * 查询参数：
 *   leadId     - 按线索 ID 筛选
 *   senderRole - 发送人角色 (销售 / 客户)
 *   channel    - 沟通渠道
 *   startDate  - 开始日期 (YYYY-MM-DD)
 *   endDate    - 结束日期 (YYYY-MM-DD)
 *   page       - 页码（默认 1）
 *   pageSize   - 每页条数（默认 10）
 *
 * 数据范围：「仅自己」时的可见口径是**叠加**的（与 Agent 侧完全一致）——
 *   `sender === 本人`  **或**  `leadId` 指向本人名下的线索。
 * 只按 sender 过滤会漏掉「客户主动发来、sender 记为客户」的记录；
 * 只按 leadId 过滤会漏掉「本人参与但线索已转出」的记录。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // ★ 数据范围收口
  const caller = resolveCallerScope(request, "communications");
  let all = filterByOwner(readCommunications(), caller, ["sender"]);

  // 叠加：本人名下线索的全部沟通记录（含 sender 为客户的那些）
  if (caller.restricted && caller.user_name) {
    const myLeadIds = new Set(
      readLeads()
        .filter((l) => l.assignee === caller.user_name)
        .map((l) => l.id)
    );
    all = readCommunications().filter(
      (c) => c.sender === caller.user_name || myLeadIds.has(c.leadId)
    );
  }

  const query: CommunicationQuery = {
    leadId: searchParams.get("leadId") ?? undefined,
    senderRole: (searchParams.get("senderRole") as CommunicationQuery["senderRole"]) ?? "",
    channel: searchParams.get("channel") ?? undefined,
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
  };

  let filtered = all;

  if (query.leadId) {
    filtered = filtered.filter((c) => c.leadId === query.leadId);
  }
  if (query.senderRole) {
    filtered = filtered.filter((c) => c.senderRole === query.senderRole);
  }
  if (query.channel) {
    const kw = query.channel.trim();
    filtered = filtered.filter((c) => c.channel === kw);
  }
  if (query.startDate) {
    filtered = filtered.filter((c) => c.sentAt.split(" ")[0] >= query.startDate!);
  }
  if (query.endDate) {
    filtered = filtered.filter((c) => c.sentAt.split(" ")[0] <= query.endDate!);
  }

  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = Math.max(1, parseInt(searchParams.get("pageSize") ?? "10", 10));
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const paged = filtered.slice(start, start + pageSize);

  return NextResponse.json({ data: paged, total, page, pageSize });
}
