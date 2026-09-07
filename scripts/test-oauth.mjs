import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const live = process.argv.includes("--production");
const origin = live ? "https://kcg-civic-mcp-worker.lihong.workers.dev" : "https://kcg-oauth.test";
const secret = live ? execFileSync("security", ["find-generic-password", "-a", process.env.USER,
  "-s", "kcg-civic-mcp-worker.MCP_ACCESS_KEY", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() : randomBytes(32).toString("hex");
let mf, current = "bootstrap";
const check = (value, message) => assert.ok(Boolean(value), `${current}: ${message}`);
const pass = (name) => console.log(`PASS ${name}`);
const invoke = async (path, init = {}) => {
  const url = typeof path === "string" && path.startsWith("/") ? origin + path : path;
  return live ? fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(60_000) }) : mf.dispatchFetch(url, { ...init, redirect: "manual" });
};
const formPost = (path, body, headers = {}) => invoke(path, { method: "POST", headers: {
  "Content-Type": "application/x-www-form-urlencoded", ...headers,
}, body: new URLSearchParams(body) });
const rpc = (token, method = "tools/list", params = {}) => invoke("/mcp", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

try {
  if (!live) {
    const bundle = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, format: "esm", platform: "neutral",
      conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["cloudflare:*", "node:*"], target: "es2022", logLevel: "silent" });
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      bindings: { PUBLIC_ORIGIN: origin, MCP_ACCESS_KEY: secret },
      durableObjects: { OAUTH_STATE: { className: "OAuthState", useSQLite: true } }, r2Buckets: ["kcg_civic_data"],
      log: new Log(LogLevel.ERROR) }));
  }
  current = "discovery";
  const unauthorized = await invoke("/mcp");
  check(unauthorized.status === 401, "unauthenticated request must be 401");
  check(unauthorized.headers.get("www-authenticate")?.includes("resource_metadata="), "discovery challenge missing");
  check((await invoke("/mcp?key=not-a-real-key")).status === 401, "query credential must fail");
  check((await invoke("/mcp/not-a-real-key")).status === 401, "path credential must fail");
  const metadata = await (await invoke("/.well-known/oauth-authorization-server")).json();
  check(metadata.issuer === origin, "issuer mismatch");
  check(metadata.code_challenge_methods_supported?.join() === "S256", "only S256 allowed");
  check(metadata.client_id_metadata_document_supported === true, "CIMD missing");
  check(metadata.grant_types_supported.includes("refresh_token"), "refresh missing");
  const protectedMeta = await (await invoke("/.well-known/oauth-protected-resource/mcp")).json();
  check(protectedMeta.resource === origin + "/mcp", "resource mismatch");
  pass(current);

  current = "registration";
  const redirect = "https://chatgpt.com/connector_platform/oauth_redirect";
  const secondRedirect = "https://chatgpt.com/connector_platform/oauth_redirect/other";
  const register = (redirects) => invoke("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    client_name: "KCG OAuth integration canary", redirect_uris: redirects,
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }) });
  check((await register(["https://example.com/callback#fragment"])).status === 400, "fragment redirect accepted");
  const registered = await register([redirect, secondRedirect]);
  check(registered.status === 201, "registration failed");
  const client = await registered.json();
  check(client.client_id && client.token_endpoint_auth_method === "none", "public client metadata invalid");
  pass(current);

  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authParams = { client_id: client.client_id, redirect_uri: redirect, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", resource: origin + "/mcp", scope: "mcp:read offline_access", state: randomBytes(16).toString("hex") };
  const authorize = (overrides = {}) => invoke("/oauth/authorize?" + new URLSearchParams({ ...authParams, ...overrides }));
  const consent = async () => {
    const response = await authorize();
    check(response.status === 200, "consent GET failed");
    const html = await response.text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    check(csrf && cookie, "CSRF binding missing");
    check(!html.includes(secret), "owner credential exposed");
    check(response.headers.get("content-security-policy")?.includes(redirect), "callback CSP missing");
    check(!response.headers.get("content-security-policy")?.includes("*"), "wildcard CSP");
    return { csrf, cookie };
  };
  const approve = (state, key = secret, overrides = {}) => formPost("/oauth/authorize", { csrf: state.csrf, access_key: key, decision: "allow", ...overrides },
    { Origin: origin, Cookie: state.cookie });
  const newCode = async () => {
    const response = await approve(await consent());
    check(response.status === 303, "consent POST must redirect with 303");
    const location = new URL(response.headers.get("location"));
    check(location.origin + location.pathname === redirect, "redirect mismatch");
    check(location.searchParams.get("state") === authParams.state, "state mismatch");
    check(location.searchParams.get("iss") === origin, "issuer response missing");
    return location.searchParams.get("code");
  };
  const exchange = (code, changes = {}) => formPost("/oauth/token", { grant_type: "authorization_code", code,
    code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect, resource: origin + "/mcp", ...changes });
  const refresh = (token, changes = {}) => formPost("/oauth/token", { grant_type: "refresh_token", refresh_token: token,
    client_id: client.client_id, resource: origin + "/mcp", ...changes });
  const revoke = (token) => formPost("/oauth/token", { token, token_type_hint: "refresh_token", client_id: client.client_id });

  current = "consent protections";
  const crossSiteConsent = await invoke("/oauth/authorize?" + new URLSearchParams(authParams), { headers: { Origin: "null" } });
  check(crossSiteConsent.status === 200, "cross-site authorization navigation blocked");
  check(!crossSiteConsent.headers.has("access-control-allow-origin"), "untrusted authorization origin received CORS access");
  check((await authorize({ redirect_uri: "https://example.com/unregistered" })).status === 400, "unregistered redirect accepted");
  check((await authorize({ code_challenge_method: "plain" })).status === 400, "plain PKCE accepted");
  check((await authorize({ resource: "https://example.com/mcp" })).status === 400, "foreign resource accepted");
  check((await authorize({ scope: "mcp:write" })).status === 400, "unknown scope accepted");
  const state = await consent();
  check((await formPost("/oauth/authorize", { csrf: state.csrf, access_key: secret, decision: "allow" }, { Origin: origin })).status === 403, "missing cookie accepted");
  check((await approve(state, "invalid-test-key")).status === 401, "wrong owner key accepted");
  const denied = await approve(state, "", { decision: "deny" });
  check(denied.status === 303, "deny must redirect");
  check(new URL(denied.headers.get("location")).searchParams.get("error") === "access_denied", "deny error missing");
  check((await approve(state)).status === 403, "consumed consent replay accepted");
  pass(current);

  current = "code binding and replay";
  const code = await newCode();
  check((await exchange(code, { code_verifier: randomBytes(48).toString("base64url") })).status === 400, "wrong PKCE accepted");
  check((await exchange(code, { redirect_uri: secondRedirect })).status === 400, "different registered redirect accepted");
  check((await exchange(code, { client_id: "unknown-client" })).status === 401, "wrong client accepted");
  check((await exchange(code, { resource: "https://example.com/mcp" })).status === 400, "resource widening accepted");
  const issued = await exchange(code);
  check(issued.status === 200, "code exchange failed");
  const tokens = await issued.json();
  check(tokens.access_token && tokens.refresh_token && tokens.access_token !== tokens.refresh_token, "independent tokens missing");
  check((await rpc(tokens.access_token)).status === 200, "access token not accepted");
  check((await exchange(code)).status === 400, "code replay accepted");
  check((await rpc(tokens.access_token)).status === 401, "replayed-code grant not revoked");
  pass(current);

  current = "concurrent code exchange";
  const parallelCode = await newCode();
  const racers = await Promise.all([exchange(parallelCode), exchange(parallelCode)]);
  check(racers.filter((r) => r.status === 200).length === 1 && racers.filter((r) => r.status === 400).length === 1, "single-use code is not atomic");
  pass(current);

  current = "refresh rotation and revocation";
  const refreshTokens = await (await exchange(await newCode())).json();
  check((await refresh(refreshTokens.refresh_token, { scope: "mcp:write" })).status === 400, "scope widening accepted");
  check((await refresh(refreshTokens.refresh_token, { resource: "https://example.com/mcp" })).status === 400, "refresh audience widening accepted");
  const nextResponse = await refresh(refreshTokens.refresh_token);
  check(nextResponse.status === 200, "refresh failed");
  const next = await nextResponse.json();
  check(next.refresh_token !== refreshTokens.refresh_token, "refresh did not rotate");
  const third = await (await refresh(next.refresh_token)).json();
  check(Boolean(third.refresh_token), "second refresh failed");
  check((await refresh(refreshTokens.refresh_token)).status === 400, "old refresh accepted after replacement used");
  const downscopedResponse = await refresh(third.refresh_token, { scope: "offline_access" });
  check(downscopedResponse.status === 200, "downscope failed");
  const downscoped = await downscopedResponse.json();
  check((await rpc(downscoped.access_token)).status === 403, "effective scope not enforced");
  check((await revoke(downscoped.refresh_token)).status === 200, "revocation failed");
  check((await rpc(third.access_token)).status === 401, "revoked access token accepted");
  check((await refresh(downscoped.refresh_token)).status === 400, "revoked refresh accepted");
  pass(current);

  current = "official SDK initialize catalog and tool call";
  const sdkTokens = await (await exchange(await newCode())).json();
  const sdk = new Client({ name: "kcg-oauth-canary", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${sdkTokens.access_token}` } },
    fetch: async (input, init) => {
      if (input instanceof Request) return invoke(input.url, { method: input.method, headers: input.headers, body: input.body, ...init });
      return invoke(String(input), init);
    },
  });
  await sdk.connect(transport);
  const catalog = await sdk.listTools();
  check(catalog.tools.length === 21, "wrong catalog size");
  check(catalog.tools.every((t) => t._meta?.securitySchemes?.[0]?.type === "oauth2"), "OAuth tool metadata missing");
  const failure = await sdk.callTool({ name: "search_kcg_laws", arguments: { keyword: "交通" } });
  check(failure.isError === true && failure.structuredContent?.reason_code === "SNAPSHOT_UNVERIFIED", "fail-closed regression");
  await sdk.close();
  const legacy = await rpc(secret);
  check(legacy.status === 200 && (await legacy.json()).result.tools.length === 21, "legacy Bearer regression");
  check((await invoke("/mcp", { headers: { Authorization: `Bearer ${sdkTokens.access_token}` } })).status === 405, "GET should not advertise a fake legacy SSE stream");
  check((await revoke(sdkTokens.refresh_token)).status === 200, "SDK canary cleanup failed");
  pass(current);
  console.log(`OAuth integration suite PASS (${live ? "Production" : "local workerd / SQLite DO"})`);
} catch (error) {
  // Do not serialize HTTP bodies, tokens, cookies, or authorization URLs on failure.
  console.error(`FAIL ${current}: ${error instanceof assert.AssertionError ? error.message : error?.name || "Error"}`);
  if (current === "bootstrap") console.error(String(error?.message || "").replaceAll(secret, "[redacted]").slice(0, 2000));
  if (error?.name === "McpError") console.error("SDK", error.code, String(error.message).replaceAll(secret, "[redacted]").replace(/owner:[^\s"']+/g, "[redacted]").slice(0, 1200));
  process.exitCode = 1;
} finally {
  if (mf) await mf.dispose();
}
