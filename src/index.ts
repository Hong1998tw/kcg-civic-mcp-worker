import { Env } from "./models/types";
import { BUDGET_TOOLS } from "./tools/budget.tools";
import { LAW_TOOLS } from "./tools/laws.tools";
import { COUNCIL_TOOLS } from "./tools/council.tools";

const ALL_TOOLS = [...BUDGET_TOOLS, ...LAW_TOOLS, ...COUNCIL_TOOLS];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
};

function checkAuthorized(request: Request, env: Env): boolean {
  if (!env.AUTH_TOKEN) return true;
  const url = new URL(request.url);
  if (url.searchParams.get("token") === env.AUTH_TOKEN) return true;
  const authHeader = request.headers.get("Authorization") || "";
  const [scheme, token] = authHeader.split(" ");
  return scheme === "Bearer" && token === env.AUTH_TOKEN;
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
        serverInfo: { name: "kcg-civic-mcp-worker", version: "0.4.0" },
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
        tools: ALL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const tool = ALL_TOOLS.find((t) => t.name === params.name);
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
      if (url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname === "/") {
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
