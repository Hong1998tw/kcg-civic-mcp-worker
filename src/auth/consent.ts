import { AuthorizationError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../models/types";
import { OAuthStorage } from "./storage";

export const READ_SCOPE = "mcp:read";
export const SUPPORTED_SCOPES = [READ_SCOPE, "offline_access"];
export interface AuthEnv extends Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  AUTH_STORAGE: OAuthStorage;
}

export const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
});
export const authError = (error: string, status = 400) => json({ error }, status);

export function safeRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2048 || /[\s<>"';\\]/.test(uri)) return false;
  try {
    const url = new URL(uri);
    return !url.username && !url.password && !url.hash && (url.protocol === "https:"
      || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)));
  } catch { return false; }
}

export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let difference = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) difference |= (aa[i] || 0) ^ (bb[i] || 0);
  return difference === 0;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function cookieName(origin: string): string {
  return origin.startsWith("https:") ? "__Host-kcg-consent" : "kcg-consent-local";
}

function cookie(origin: string, value: string, maxAge = 600): string {
  return `${cookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
}

function securityHeaders(redirect: string): Record<string, string> {
  const callback = new URL(redirect);
  // Exact validated callback path; no wildcard host and no credential query.
  return {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callback.origin}${callback.pathname}; frame-ancestors 'none'; base-uri 'none'`,
  };
}

function form(origin: string, nonce: string, clientName: string, redirect: string, message = "", status = 200): Response {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>連接高雄市公民資料</title><style>
body{font-family:system-ui,sans-serif;background:#f4f7fa;color:#172e3d;margin:0;padding:3rem 1.2rem}main{max-width:30rem;margin:auto;background:white;padding:2rem;border-radius:1rem}h1{font-size:1.5rem}p{line-height:1.65}input{box-sizing:border-box;width:100%;padding:.8rem;margin:.5rem 0 1.2rem;border:1px solid #7f939f;border-radius:.4rem}button{padding:.8rem 1.1rem;border:0;border-radius:.4rem;cursor:pointer;background:#176a6c;color:white;font-size:1rem}button.secondary{background:#e8eef1;color:#172e3d;margin-left:.5rem}.error{color:#a21d29}.muted{font-size:.85rem;color:#526673;overflow-wrap:anywhere}</style></head><body><main>
<h1>連接高雄市公民資料</h1><p><strong>${escape(clientName)}</strong> 要求唯讀使用高雄市預算、議會與公民資料工具。</p>
<p>授權不包含修改市政資料或管理 Cloudflare。部分資料仍待驗證；連線成功後，工具會如實顯示可用範圍。</p><p class="muted">授權後返回：${escape(new URL(redirect).origin)}</p>
${message ? `<p role="alert" class="error">${escape(message)}</p>` : ""}
<form method="post" action="/oauth/authorize"><input type="hidden" name="csrf" value="${escape(nonce)}">
<label for="owner-key">服務存取金鑰</label><input id="owner-key" type="password" name="access_key" autocomplete="current-password" required maxlength="4096">
<button name="decision" value="allow" type="submit">同意並連接</button><button name="decision" value="deny" type="submit" class="secondary" formnovalidate>取消</button></form>
<p class="muted">使用本服務既有的存取金鑰；金鑰只在本服務驗證，ChatGPT 取得的是獨立且可撤銷的授權 token。</p></main></body></html>`, {
    // no-referrer makes navigation-mode form POSTs send Origin: null. Preserve
    // the same-origin proof required below without sending referrers off-site.
    status, headers: { ...securityHeaders(redirect), "Referrer-Policy": "same-origin", "Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookie(origin, nonce) },
  });
}

interface ConsentState { query: string }

export async function handleConsent(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url), origin = env.PUBLIC_ORIGIN;
  if (url.pathname !== "/oauth/authorize") return authError("not_found", 404);
  if (!["GET", "POST"].includes(request.method)) return authError("method_not_allowed", 405);
  if (!(env.OAUTH_LOGIN_KEY || env.MCP_ACCESS_KEY)) return authError("temporarily_unavailable", 503);

  let nonce = "", consentKey = "", query = url.searchParams.toString(), values: URLSearchParams | undefined;
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== origin) return json({ error: "invalid_request", diagnostic: "CONSENT_ORIGIN_REJECTED" }, 403);
    values = new URLSearchParams(await request.text());
    if ([...values.keys()].some((key) => values!.getAll(key).length !== 1)) return authError("invalid_request");
    nonce = values.get("csrf") || "";
    const browserNonce = (request.headers.get("Cookie") || "").split(";").map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName(origin)}=`))?.slice(cookieName(origin).length + 1) || "";
    if (!/^[a-f0-9]{64}$/.test(nonce) || !constantTimeEqual(nonce, browserNonce)) return json({ error: "invalid_request", diagnostic: "CONSENT_COOKIE_MISMATCH" }, 403);
    consentKey = `consent:${await digest(nonce)}`;
    const saved = await env.AUTH_STORAGE.get<ConsentState>(consentKey, "json");
    if (!saved) return json({ error: "invalid_request", diagnostic: "CONSENT_EXPIRED_OR_USED" }, 403);
    query = saved.query;
  }

  const params = new URLSearchParams(query);
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return authError("invalid_request");
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") || "")) return authError("invalid_request");
  const scopes = (params.get("scope") || READ_SCOPE).split(/\s+/).filter(Boolean);
  if (!scopes.includes(READ_SCOPE) || scopes.some((s) => !SUPPORTED_SCOPES.includes(s))) return authError("invalid_scope");
  params.set("scope", scopes.join(" "));
  // Omitted resource is canonicalized for older ChatGPT clients, never widened.
  if (params.has("resource") && params.get("resource") !== `${origin}/mcp`) return authError("invalid_target");
  params.set("resource", `${origin}/mcp`);

  try {
    const auth = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(`${origin}/oauth/authorize?${params}`));
    if (!safeRedirect(auth.redirectUri)) return authError("invalid_request");
    const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
    if (!client) return authError("invalid_client");
    const clientName = (client.clientName || "MCP Client").slice(0, 120);
    if (request.method === "GET") {
      nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      await env.AUTH_STORAGE.put(`consent:${await digest(nonce)}`, JSON.stringify({ query: params.toString() }), { expirationTtl: 600 });
      return form(origin, nonce, clientName, auth.redirectUri);
    }
    if (values?.get("decision") === "deny") {
      await env.AUTH_STORAGE.delete(consentKey);
      const redirect = new URL(auth.redirectUri);
      redirect.searchParams.set("error", "access_denied");
      if (auth.state) redirect.searchParams.set("state", auth.state);
      redirect.searchParams.set("iss", origin);
      return new Response(null, { status: 303, headers: { ...securityHeaders(auth.redirectUri), Location: redirect.href, "Set-Cookie": cookie(origin, "", 0) } });
    }
    if (values?.get("decision") !== "allow") return authError("invalid_request");
    if (!constantTimeEqual(values.get("access_key") || "", env.OAUTH_LOGIN_KEY || env.MCP_ACCESS_KEY || "")) {
      return form(origin, nonce, clientName, auth.redirectUri, "存取金鑰不正確，請重試。", 401);
    }
    await env.AUTH_STORAGE.delete(consentKey);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: auth, userId: "owner", scope: scopes,
      metadata: { clientName }, props: { userId: "owner", scopes, method: "oauth" },
      revokeExistingGrants: false,
    });
    return new Response(null, { status: 303, headers: { ...securityHeaders(auth.redirectUri), Location: redirectTo, "Set-Cookie": cookie(origin, "", 0) } });
  } catch (error) {
    // Never redirect using unvalidated reconstructed input or log OAuth values.
    if (error instanceof AuthorizationError) return authError(error.code);
    return authError("temporarily_unavailable", 503);
  }
}
