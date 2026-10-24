import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_PRESENTATION, getToolTitle } from "./presentation";
import { TOOL_REGISTRY } from "./tools";
import type { Env } from "../models/types";

export interface McpTransportOptions {
  registry?: typeof TOOL_REGISTRY;
  serverInfo?: { name: string; version: string };
  securitySchemes?: Array<Record<string, unknown>>;
  iconUrl?: string | null;
  openWorldHint?: boolean;
}

export async function handleMcp(request: Request, env: Env, options: McpTransportOptions = {}): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
  const registry = options.registry ?? TOOL_REGISTRY;
  const securitySchemes = options.securitySchemes ?? [{ type: "oauth2", scopes: ["mcp:read"] }];
  const iconUrl = options.iconUrl === undefined ? `${env.PUBLIC_ORIGIN}/icon.svg` : options.iconUrl;
  const icons = iconUrl ? [{ src: iconUrl, mimeType: "image/svg+xml", sizes: ["any"] }] : undefined;
  const server = new Server({ name: "高雄市公民資料 MCP", version: "1.1.1", title: SERVER_PRESENTATION.title, description: SERVER_PRESENTATION.description, websiteUrl: SERVER_PRESENTATION.websiteUrl, ...(icons ? { icons } : {}), ...options.serverInfo }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.map((tool) => ({
    name: tool.name, title: getToolTitle(tool.name), description: tool.description, ...(icons ? { icons } : {}),
    inputSchema: { ...tool.inputSchema, type: "object" as const },
    outputSchema: { type: "object" as const, anyOf: [tool.outputSchema, {
      type: "object", additionalProperties: false, required: ["status", "reason_code", "message"],
      properties: { status: { const: "error" }, reason_code: { type: "string" }, message: { type: "string" } },
    }] },
    annotations: { title: getToolTitle(tool.name), readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: options.openWorldHint ?? true },
    securitySchemes,
    _meta: { securitySchemes },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = registry.find((candidate) => candidate.name === params.name);
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
