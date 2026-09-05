import { Env } from "./models/types";
import { TOOL_REGISTRY } from "./mcp/tools";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
};

function checkAuthorized(request: Request, env: any): boolean {
  const validSecrets = [env.MCP_ACCESS_KEY, env.AUTH_TOKEN].filter(Boolean);
  if (validSecrets.length === 0) return true;

  const url = new URL(request.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const pathSecret = pathParts.length > 1 && pathParts[0] === "mcp" ? pathParts[1] : null;
  const querySecret = url.searchParams.get("key") || url.searchParams.get("token");
  const authHeader = request.headers.get("Authorization") || "";
  const headerSecret = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  return validSecrets.some(
    (s) => s === pathSecret || s === querySecret || s === headerSecret
  );
}

async function processRpc(body: any, env: Env) {
  const { id, method, params } = body;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "kcg-civic-mcp-worker", version: "0.5.0" },
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
    const tool = TOOL_REGISTRY.find((t) => t.name === params.name);
    if (!tool) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `未知的工具: ${params.name}` } };
    }
    try {
      const output = await tool.handler(params.arguments || {}, env);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(output) }] },
      };
    } catch (err: any) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: err.message || "工具執行失敗" } };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `不支援的方法: ${method}` } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (!checkAuthorized(request, env)) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "未經授權的連線請求" } }),
        { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const url = new URL(request.url);

    // 1. Web Standards SSE Transport
    if (request.method === "GET") {
      if (url.pathname.startsWith("/mcp") || url.pathname === "/sse" || url.pathname === "/") {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const tokenQuery = env.AUTH_TOKEN ? `?token=${encodeURIComponent(env.AUTH_TOKEN)}` : "";
        const endpointEvent = `event: endpoint\ndata: ${url.origin}/mcp${tokenQuery}\n\n`;
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
      try {
        const body = await request.json();
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
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: err.message } }),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  },
};
