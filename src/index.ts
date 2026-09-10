import type { Env } from "./models/types";
import { handleMcp } from "./mcp/transport";
export { OAuthState } from "./auth/state";

const OAUTH_PATHS = new Set(["/oauth/authorize", "/oauth/token", "/oauth/register",
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]);

function withHeaders(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "no-referrer");
  if (origin) { headers.set("Access-Control-Allow-Origin", origin); headers.append("Vary", "Origin"); }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id");
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-Id");
  return new Response(response.body, { status: response.status, headers });
}

async function boundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), browserOrigin = request.headers.get("Origin");
    const allowed = new Set([env.PUBLIC_ORIGIN, "https://chatgpt.com", "https://chat.openai.com",
      "http://localhost:6274", "http://127.0.0.1:6274", ...(env.CORS_ALLOWED_ORIGINS || "").split(",").filter(Boolean)]);
    if (url.origin !== env.PUBLIC_ORIGIN) return new Response("Forbidden", { status: 403 });
    const corsOrigin = browserOrigin && allowed.has(browserOrigin) ? browserOrigin : null;
    // OAuth authorization is intentionally entered by a cross-site top-level
    // navigation. Do not apply the MCP fetch CORS gate to that navigation;
    // the authorization request, registered redirect, PKCE and consent POST
    // origin are independently validated by OAuthState.
    if ((request.method === "OPTIONS" || url.pathname === "/mcp") && browserOrigin && !corsOrigin) {
      return new Response("Forbidden", { status: 403 });
    }
    const respond = (response: Response) => withHeaders(response, corsOrigin);
    if (request.method === "OPTIONS") return respond(new Response(null, { status: 204 }));
    if (url.pathname === "/health" && request.method === "GET") return respond(Response.json({
      status: "ok", version: "1.1.1", authentication: "oauth2.1", oauth_configured: !!(env.OAUTH_LOGIN_KEY || env.MCP_ACCESS_KEY),
      transport: "streamable-http", data_status: "degraded",
    }));
    if (url.pathname.startsWith("/mcp/")) return respond(new Response(null, { status: 401, headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    } }));
    if (url.pathname !== "/mcp" && !OAUTH_PATHS.has(url.pathname)) return respond(new Response("Not Found", { status: 404 }));
    if (url.search.length > 8192 || (request.headers.get("Authorization") || "").length > 8192) return respond(new Response(null, { status: 413 }));
    if (request.method === "POST") {
      const body = await boundedBody(request, url.pathname === "/mcp" ? 1024 * 1024 : 16 * 1024);
      if (!body) return respond(new Response(null, { status: 413 }));
      request = new Request(request, { body });
    }
    const auth = env.OAUTH_STATE.get(env.OAUTH_STATE.idFromName("oauth-v1"));
    if (url.pathname !== "/mcp") return respond(await auth.fetch(request));
    // Send only the authentication header to the auth object, never tool inputs.
    const probe = await auth.fetch(new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
      headers: { Authorization: request.headers.get("Authorization") || "" },
    }));
    if (!probe.ok) return respond(probe);
    return respond(await handleMcp(request, env));
  },
};
