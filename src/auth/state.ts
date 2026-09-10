import { DurableObject } from "cloudflare:workers";
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../models/types";
import { OAuthStorage } from "./storage";
import { type AuthEnv, READ_SCOPE, SUPPORTED_SCOPES, authError, constantTimeEqual, digest, handleConsent, json, safeRedirect } from "./consent";

interface AuthProps { userId: string; scopes: string[]; method: string }

/** Only authentication runs in this object. Source fetching stays in the Worker. */
export class OAuthState extends DurableObject<Env> {
  private readonly storage: OAuthStorage;
  private readonly authEnv: AuthEnv;
  private readonly provider: OAuthProvider<AuthEnv>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new OAuthStorage(ctx.storage.sql);
    this.authEnv = { ...env, AUTH_STORAGE: this.storage,
      OAUTH_KV: this.storage as unknown as KVNamespace, OAUTH_PROVIDER: undefined as unknown as OAuthHelpers };
    const resource = `${env.PUBLIC_ORIGIN}/mcp`;
    this.provider = new OAuthProvider<AuthEnv>({
      apiRoute: "/mcp",
      apiHandler: { async fetch(_request, _env, context) {
        const props = context.props as unknown as AuthProps;
        if (!props?.scopes?.includes(READ_SCOPE)) return json({ error: "insufficient_scope" }, 403, {
          "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${READ_SCOPE}", resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        });
        return json({ authenticated: true });
      } },
      defaultHandler: { fetch: handleConsent },
      authorizeEndpoint: "/oauth/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
      allowPlainPKCE: false, allowImplicitFlow: false, allowTokenExchangeGrant: false,
      accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400, clientRegistrationTTL: 365 * 86400,
      scopesSupported: SUPPORTED_SCOPES,
      resourceMetadata: { resource, authorization_servers: [env.PUBLIC_ORIGIN], scopes_supported: [READ_SCOPE],
        bearer_methods_supported: ["header"], resource_name: "高雄市公民資料 MCP" },
      clientIdMetadataDocumentEnabled: true,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const uris = clientMetadata.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(safeRedirect)) {
          return { description: "Use exact HTTPS or loopback redirect URIs" };
        }
      },
      tokenExchangeCallback: ({ props, requestedScope }) => ({ accessTokenProps: { ...props, scopes: requestedScope } }),
      resolveExternalToken: async ({ token, env: runtime }) => {
        if (token.length > 4096) return null;
        const accepted = [runtime.MCP_ACCESS_KEY, runtime.AUTH_TOKEN].filter((v): v is string => !!v);
        return accepted.some((key) => constantTimeEqual(token, key))
          ? { audience: resource, props: { userId: "owner", scopes: [READ_SCOPE], method: "api_key" } } : null;
      },
      // Suppress provider default logs, which may include untrusted request values.
      onError: () => undefined,
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const url = new URL(request.url);
        if (url.origin !== this.env.PUBLIC_ORIGIN) return authError("invalid_request", 400);
        const route = url.pathname;
        if (route.startsWith("/oauth/")) {
          const ip = request.headers.get("CF-Connecting-IP") || "local";
          const lane = route === "/oauth/authorize" && request.method === "POST" ? "login" : route;
          const windowSeconds = lane === "login" ? 600 : 60;
          const limit = lane === "login" ? 20 : route === "/oauth/register" ? 30 : 120;
          const countKey = `limit:${await digest(ip)}:${lane}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
          const count = Number(await this.storage.get(countKey) || 0);
          if (count >= limit) return json({ error: "temporarily_unavailable" }, 429, { "Retry-After": String(windowSeconds) });
          await this.storage.put(countKey, String(count + 1), { expirationTtl: windowSeconds * 2 });
        }
        if (request.method === "POST" && route === "/oauth/token") {
          const body = new URLSearchParams(await request.clone().text());
          if ([...body.keys()].some((key) => body.getAll(key).length !== 1)) return authError("invalid_request");
          if (body.has("scope") && (body.get("scope") || "").split(/\s+/).filter(Boolean).some((scope) => !SUPPORTED_SCOPES.includes(scope))) return authError("invalid_scope");
          if (body.has("resource") && body.get("resource") !== `${this.env.PUBLIC_ORIGIN}/mcp`) return authError("invalid_target");
          if (body.get("grant_type") === "authorization_code") {
            if (!/^[A-Za-z0-9._~-]{43,128}$/.test(body.get("code_verifier") || "")) return authError("invalid_grant");
            const parts = (body.get("code") || "").split(":");
            if (parts.length === 3) {
              const grant = await this.storage.get<{ redirectUri?: string }>(`grant:${parts[0]}:${parts[1]}`, "json");
              // Stronger than provider's registered-set check: bind this exact grant.
              if (body.has("redirect_uri") && grant?.redirectUri !== body.get("redirect_uri")) return authError("invalid_grant");
            }
          }
        }
        const context = { waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
          passThroughOnException() {}, props: {} } as ExecutionContext;
        const response = await this.provider.fetch(request, this.authEnv, context);
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
        return response;
      } catch {
        return authError("temporarily_unavailable", 503);
      }
    });
  }

  async alarm(): Promise<void> {
    this.storage.purgeExpired();
    const page = await this.storage.list({ limit: 1 });
    if (page.keys.length) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
}
