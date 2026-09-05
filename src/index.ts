import { Env, RpcError } from "./models/types";
import { TOOL_REGISTRY } from "./mcp/tools";
import { isTruthy } from "./utils/envelope";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
};

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const length = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < length; i++) {
    diff |= (aa[i % Math.max(aa.length, 1)] || 0) ^ (bb[i % Math.max(bb.length, 1)] || 0);
  }
  return diff === 0;
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function checkAuthorized(request: Request, env: Env): boolean {
  const validSecrets = [env.MCP_ACCESS_KEY, env.AUTH_TOKEN].filter(Boolean);
  if (validSecrets.length === 0) {
    const host = new URL(request.url).hostname;
    return isLocalHost(host) && isTruthy(env.MCP_ALLOW_ANONYMOUS);
  }

  const url = new URL(request.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const pathSecret = pathParts.length === 2 && pathParts[0] === "mcp" ? pathParts[1] : null;
  const querySecret = url.searchParams.get("key") || url.searchParams.get("token");
  const authHeader = request.headers.get("Authorization") || "";
  const headerSecret = /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, "").trim() : null;

  return validSecrets.some((s) => [pathSecret, querySecret, headerSecret]
    .some((candidate) => !!candidate && constantTimeEqual(s as string, candidate)));
}

function rpcError(id: unknown, code: number, message: string, data?: Record<string, unknown>) {
  const error: RpcError = { code, message, ...(data ? { data } : {}) };
  return { jsonrpc: "2.0", id, error };
}

async function processRpc(body: any, env: Env) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id ?? null, -32600, "無效的 JSON-RPC 2.0 請求");
  }
  const { id, method, params } = body;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "高雄市公民資料 MCP", version: "1.0.0" },
      },
    };
  }

  if (method === "notifications/initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOL_REGISTRY.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    if (!params || typeof params !== "object" || typeof params.name !== "string") {
      return rpcError(id, -32602, "tools/call 缺少有效的 name");
    }
    const tool = TOOL_REGISTRY.find((t) => t.name === params?.name);
    if (!tool) {
      return rpcError(id, -32601, `未知的工具: ${params?.name || ""}`);
    }
    try {
      const output = await tool.handler(params.arguments || {}, env);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(output) }] },
      };
    } catch (err: any) {
      return rpcError(id, -32603, err.message || "工具執行失敗");
    }
  }

  return rpcError(id, -32601, `不支援的方法: ${method}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (!checkAuthorized(request, env)) {
      return new Response(
        JSON.stringify(rpcError(null, -32000, "未經授權的連線請求")),
        { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }
      );
    }

    const url = new URL(request.url);

    // 1. Web Standards SSE Transport
    if (request.method === "GET") {
      if (isMcpPath(url.pathname) || url.pathname === "/sse" || url.pathname === "/") {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        // Never put an access token in an SSE event or URL. The client should
        // authenticate its subsequent POST with Authorization: Bearer.
        const endpointEvent = `event: endpoint\ndata: ${url.origin}/mcp\n\n`;
        writer.write(encoder.encode(endpointEvent));

        return new Response(readable, {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      }
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }

    // 2. HTTP POST JSON-RPC 2.0
    if (request.method === "POST") {
      if (!isMcpPath(url.pathname)) return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      try {
        const contentLength = Number(request.headers.get("content-length") || "0");
        if (contentLength > 1024 * 1024) {
          return new Response(JSON.stringify(rpcError(null, -32600, "請求大小不可超過 1 MB")), {
            status: 413,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const body = await request.json();
        if (Array.isArray(body) && body.length === 0) {
          return new Response(JSON.stringify([]), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        if (Array.isArray(body)) {
          const results = [];
          for (const item of body) {
            const res = await processRpc(item, env);
            if (res) results.push(res);
          }
          return new Response(JSON.stringify(results), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        const res = await processRpc(body, env);
        if (!res) return new Response("", { status: 204, headers: CORS_HEADERS });
        return new Response(JSON.stringify(res), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify(rpcError(null, -32700, "無法解析 JSON-RPC 請求")),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  },
};
