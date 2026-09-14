import { NextRequest } from "next/server";

/**
 * DeepAgents 服务代理
 * ------------------------------------------------------------------
 * 前端统一走 /api/agent/*，由本路由在服务端转发到 DeepAgents 服务，
 * 从而避免浏览器直连造成的跨域问题，也便于集中管理服务地址。
 *
 *   /api/agent/sessions        ->  {DEEPAGENTS_BASE_URL}/api/sessions
 *   /api/agent/chat            ->  {DEEPAGENTS_BASE_URL}/api/chat      (SSE 流式)
 *
 * 服务地址通过环境变量 DEEPAGENTS_BASE_URL 配置，默认 http://127.0.0.1:8765
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BASE = "http://127.0.0.1:8765";

function upstreamBase(): string {
  return (process.env.DEEPAGENTS_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

type Params = Promise<{ path: string[] }>;

async function proxy(request: NextRequest, { params }: { params: Params }) {
  const { path } = await params;
  const target = `${upstreamBase()}/api/${path.join("/")}${request.nextUrl.search}`;

  const init: RequestInit = {
    method: request.method,
    headers: {
      "Content-Type": request.headers.get("content-type") || "application/json",
    },
    cache: "no-store",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    const body = await request.text();
    if (body) init.body = body;
  }

  try {
    const upstream = await fetch(target, init);
    // 原样透传响应体（含 SSE 流），并关闭各级缓冲以保证实时性
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return Response.json(
      {
        error: "无法连接 DeepAgents 服务",
        detail: `目标地址：${upstreamBase()}，请确认服务已启动。`,
      },
      { status: 502 }
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
