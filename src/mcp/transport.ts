import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_REGISTRY } from "./tools";
import type { Env } from "../models/types";

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
  const server = new Server({ name: "高雄市公民資料 MCP", version: "1.1.0" }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_REGISTRY.map((tool) => ({
    name: tool.name, description: tool.description,
    inputSchema: { ...tool.inputSchema, type: "object" as const },
    outputSchema: { type: "object" as const, anyOf: [tool.outputSchema, {
      type: "object", additionalProperties: false, required: ["status", "reason_code", "message"],
      properties: { status: { const: "error" }, reason_code: { type: "string" }, message: { type: "string" } },
    }] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }] },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === params.name);
    try {
      if (!tool) throw new Error("UNKNOWN_TOOL: 未知工具");
      const output = await tool.handler(params.arguments || {}, env);
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error: unknown) {
      const failure = error as { reasonCode?: string; message?: string };
      const message = failure?.message || "工具執行失敗";
      const reasonCode = failure?.reasonCode || /^([A-Z_]+):/.exec(message)?.[1] || "TOOL_EXECUTION_FAILED";
      const output = { status: "error", reason_code: reasonCode, message };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const headers = new Headers(request.headers);
    if (!headers.has("Accept") || headers.get("Accept") === "*/*") headers.set("Accept", "application/json, text/event-stream");
    return await transport.handleRequest(new Request(request, { headers }));
  } finally {
    await server.close();
  }
}
