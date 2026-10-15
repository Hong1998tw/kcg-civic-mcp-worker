import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLocalOAuth } from "../src/local/oauth-native.mjs";

assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node24 required");
const temp = await mkdtemp(path.join(tmpdir(), "kcg-oauth-test-"));
const owner = `TEST-owner-${randomBytes(32).toString("hex")}`;
const bearer = `TEST-bearer-${randomBytes(32).toString("hex")}`;
const ownerFile = path.join(temp, "owner-key"), bearerFile = path.join(temp, "bearer-key");
await writeFile(ownerFile, owner, { mode: 0o600 });
await writeFile(bearerFile, bearer, { mode: 0o600 });
const authRoot = path.join(temp, "auth");
const plaintext = new Set([owner, bearer]);
let oauth, clock = Date.now();
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (oauth.handles(pathname)) { oauth.handler(req, res); return; }
    if (pathname !== "/mcp") { res.writeHead(404); res.end(); return; }
    const authenticated = await oauth.authenticateMcp(req, res);
    if (!authenticated) return;
    const mcp = new Server({ name: "TEST NAS OAuth", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "test_read", description: "TEST fixture only", inputSchema: { type: "object" } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "TEST NAS data" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    res.on("close", () => { void mcp.close(); });
    await transport.handleRequest(req, res);
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const issuer = `http://127.0.0.1:${server.address().port}`;
const resource = `${issuer}/mcp`;
const config = { issuerUrl: issuer, authRoot, ownerKeyFile: ownerFile, bearerKeyFile: bearerFile, allowLoopbackHttp: true, now: () => clock };
const callback = "http://127.0.0.1:45123/callback";
const verdicts = [];
const pass = (label) => verdicts.push(label);
const post = (endpoint, fields, headers = {}) => fetch(`${issuer}${endpoint}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: fields instanceof URLSearchParams ? fields : new URLSearchParams(fields) });
const register = (patch = {}) => fetch(`${issuer}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "TEST SDK client", redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...patch }) });
const challenge = (value) => createHash("sha256").update(value).digest("base64url");
const fieldsFrom = (html) => Object.fromEntries(["state", "csrf"].map((name) => [name, html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1]]));
const formFor = async (url) => {
  const response = await fetch(url, { redirect: "manual" });
  const html = await response.text();
  return { response, fields: fieldsFrom(html), cookie: response.headers.get("set-cookie")?.split(";")[0], html };
};
const authorizeUrl = (clientId, verifier, patch = {}) => `${issuer}/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", code_challenge: challenge(verifier), code_challenge_method: "S256", scope: "mcp:read offline_access", resource, state: "TEST-client-state", ...patch })}`;
const consent = (form, patch = {}, headers = {}) => post("/consent", { ...form.fields, owner_key: owner, decision: "allow", ...patch }, { Cookie: form.cookie || "", Origin: issuer, ...headers });
const getCode = async (clientId, verifier) => {
  const form = await formFor(authorizeUrl(clientId, verifier));
  assert.equal(form.response.status, 200);
  const result = await consent(form);
  assert.equal(result.status, 303);
  const location = new URL(result.headers.get("location"));
  assert.equal(location.searchParams.get("state"), "TEST-client-state");
  assert.equal(location.searchParams.get("iss"), `${issuer}/`);
  const code = location.searchParams.get("code");
  assert.ok(code); plaintext.add(code); return code;
};
const exchange = (clientId, code, verifier, patch = {}) => post("/token", { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: callback, resource, ...patch });
const refresh = (clientId, token, patch = {}) => post("/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: token, resource, ...patch });
const rememberTokens = (tokens) => { plaintext.add(tokens.access_token); if (tokens.refresh_token) plaintext.add(tokens.refresh_token); return tokens; };

try {
  oauth = await createLocalOAuth(config);
  const metadata = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, `${issuer}/`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(metadata.client_id_metadata_document_supported, false);
  let response = await fetch(resource, { method: "POST" });
  assert.equal(response.status, 401);
  assert.ok(response.headers.get("www-authenticate").includes(oauth.resourceMetadataUrl));
  pass("SDK metadata and protected-resource 401 discovery");

  for (const patch of [{ token_endpoint_auth_method: "client_secret_post" }, { redirect_uris: ["https://user:password@example.com/cb"] }, { redirect_uris: ["javascript:alert(1)"] }, { redirect_uris: ["https://example.com/cb#fragment"] }, { grant_types: ["client_credentials"] }]) {
    assert.equal((await register(patch)).status, 400);
  }
  const registered = await (await register()).json();
  const clientId = registered.client_id;
  const client2 = (await (await register({ client_name: "TEST second client" })).json()).client_id;
  assert.ok(clientId && client2);
  assert.equal(registered.client_secret, undefined);
  pass("DCR public-only, safe redirects and unsupported grants rejected");

  const verifier = "a".repeat(64);
  let form = await formFor(authorizeUrl(clientId, verifier));
  assert.ok(form.html.includes("同意並連接"));
  assert.equal(form.response.headers.get("referrer-policy"), "same-origin");
  assert.ok(form.response.headers.get("set-cookie").includes("HttpOnly; SameSite=Lax"));
  assert.equal((await consent(form, {}, { Origin: "null" })).status, 403);
  assert.equal((await consent(form, {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await consent(form, {}, { Cookie: "" })).status, 403);
  assert.equal((await consent(form, { csrf: "f".repeat(64) })).status, 403);
  assert.equal((await consent(form, { state: `${form.fields.state.slice(0, -1)}x` })).status, 403);
  assert.equal((await consent(form, { owner_key: bearer })).status, 403);
  assert.equal((await consent(form, { owner_key: owner, decision: "" })).status, 400);
  response = await consent(form, { decision: "deny", owner_key: "" });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("error"), "access_denied");
  assert.equal((await consent(form)).status, 403);
  const duplicate = new URLSearchParams({ ...form.fields, owner_key: owner, decision: "allow" });
  duplicate.append("decision", "deny");
  assert.equal((await post("/consent", duplicate, { Cookie: form.cookie, Origin: issuer })).status, 400);
  pass("Explicit owner consent, signed state, CSRF, cookie, null origin, API-key separation and denial");

  response = await fetch(authorizeUrl(clientId, verifier, { redirect_uri: "http://127.0.0.1:45124/callback" }), { redirect: "manual" });
  assert.equal(response.status, 400);
  response = await fetch(authorizeUrl(clientId, verifier, { redirect_uri: "https://evil.example/callback" }), { redirect: "manual" });
  assert.equal(response.status, 400);
  for (const patch of [{ code_challenge_method: "plain" }, { resource: "https://evil.example/mcp" }, { scope: "mcp:write" }, { code_challenge: "short" }]) {
    response = await fetch(authorizeUrl(clientId, verifier, patch), { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.ok(new URL(response.headers.get("location")).searchParams.has("error"));
  }
  pass("Exact registered redirect including loopback port, S256, resource and scope binding");

  const code = await getCode(clientId, verifier);
  assert.equal((await exchange(clientId, code, "b".repeat(64))).status, 400);
  assert.equal((await exchange(clientId, code, verifier, { redirect_uri: "https://evil.example/callback" })).status, 400);
  assert.equal((await exchange(clientId, code, verifier, { resource: "https://evil.example/mcp" })).status, 400);
  assert.equal((await exchange(clientId, code, verifier, { resource: "" })).status, 400);
  assert.equal((await exchange(clientId, code, verifier, { redirect_uri: "" })).status, 400);
  assert.equal((await exchange(client2, code, verifier)).status, 400);
  response = await exchange(clientId, code, verifier);
  assert.equal(response.status, 200);
  let tokens = rememberTokens(await response.json());
  assert.equal((await exchange(clientId, code, verifier)).status, 400);
  assert.equal((await oauth.verifyAccessToken(tokens.access_token)).clientId, clientId);
  assert.equal((await oauth.verifyAccessToken(bearer)).extra.method, "bearer_compatibility");
  await assert.rejects(oauth.verifyAccessToken(owner));
  pass("Single-use authorization code, wrong PKCE/client/redirect/resource and separate bearer compatibility");

  assert.equal((await refresh(client2, tokens.refresh_token)).status, 400);
  assert.equal((await refresh(clientId, tokens.refresh_token, { resource: "https://evil.example/mcp" })).status, 400);
  assert.equal((await refresh(clientId, tokens.refresh_token, { scope: "mcp:write" })).status, 400);
  const rotatedResponse = await refresh(clientId, tokens.refresh_token);
  assert.equal(rotatedResponse.status, 200);
  const rotated = rememberTokens(await rotatedResponse.json());
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal((await refresh(clientId, tokens.refresh_token)).status, 400);
  await assert.rejects(oauth.verifyAccessToken(rotated.access_token));
  assert.equal((await refresh(clientId, rotated.refresh_token)).status, 400);
  pass("Refresh rotation, replay revokes whole family, client/resource/scope isolation");

  const narrowCode = await getCode(clientId, verifier);
  const wide = rememberTokens(await (await exchange(clientId, narrowCode, verifier)).json());
  const narrow = rememberTokens(await (await refresh(clientId, wide.refresh_token, { scope: "mcp:read" })).json());
  assert.equal(narrow.refresh_token, undefined);
  assert.deepEqual((await oauth.verifyAccessToken(narrow.access_token)).scopes, ["mcp:read"]);
  pass("Refresh scope narrowing persists on the access token and drops offline refresh");

  const refreshRaceCode = await getCode(clientId, verifier);
  const refreshRaceTokens = rememberTokens(await (await exchange(clientId, refreshRaceCode, verifier)).json());
  const refreshRace = await Promise.all([refresh(clientId, refreshRaceTokens.refresh_token), refresh(clientId, refreshRaceTokens.refresh_token)]);
  assert.deepEqual(refreshRace.map((r) => r.status).sort(), [200, 400]);
  const refreshRaceWinner = rememberTokens(await refreshRace.find((r) => r.status === 200).json());
  await assert.rejects(oauth.verifyAccessToken(refreshRaceWinner.access_token));
  pass("Concurrent refresh has one winner and replay revocation persists");

  form = await formFor(authorizeUrl(clientId, verifier));
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await consent(form, { owner_key: "TEST-invalid-owner" })).status, 403);
  assert.equal((await consent(form)).status, 403);
  pass("Five failed owner attempts invalidate that pending consent");

  const concurrentCode = await getCode(clientId, verifier);
  const concurrent = await Promise.all([exchange(clientId, concurrentCode, verifier), exchange(clientId, concurrentCode, verifier)]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 400]);
  const concurrentTokens = rememberTokens(await concurrent.find((r) => r.status === 200).json());
  assert.equal((await post("/revoke", { client_id: client2, token: concurrentTokens.access_token })).status, 200);
  await oauth.verifyAccessToken(concurrentTokens.access_token);
  assert.equal((await post("/revoke", { client_id: clientId, token: concurrentTokens.refresh_token })).status, 200);
  await assert.rejects(oauth.verifyAccessToken(concurrentTokens.access_token));
  pass("Concurrent code redemption has one winner and revocation respects client binding");

  // Official SDK client performs discovery, DCR, S256 authorization and token exchange.
  let sdkInfo, sdkTokens, sdkVerifier, sdkAuthorize;
  const sdkProvider = {
    redirectUrl: callback,
    clientMetadata: { client_name: "TEST official SDK", redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
    clientInformation: () => sdkInfo, saveClientInformation: (v) => { sdkInfo = v; },
    tokens: () => sdkTokens, saveTokens: (v) => { sdkTokens = rememberTokens(v); },
    codeVerifier: () => sdkVerifier, saveCodeVerifier: (v) => { sdkVerifier = v; },
    redirectToAuthorization: (v) => { sdkAuthorize = v; }, state: () => "TEST-SDK-state",
  };
  assert.equal(await auth(sdkProvider, { serverUrl: resource, scope: "mcp:read offline_access" }), "REDIRECT");
  form = await formFor(sdkAuthorize);
  response = await consent(form);
  assert.equal(response.status, 303);
  const sdkCode = new URL(response.headers.get("location")).searchParams.get("code"); plaintext.add(sdkCode);
  assert.equal(await auth(sdkProvider, { serverUrl: resource, authorizationCode: sdkCode }), "AUTHORIZED");
  const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${sdkTokens.access_token}` } } });
  const client = new Client({ name: "TEST SDK native OAuth", version: "1" });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools[0].name, "test_read");
  assert.equal((await client.callTool({ name: "test_read", arguments: {} })).content[0].text, "TEST NAS data");
  await client.close();
  pass("Official SDK OAuth client plus actual MCP initialize/list/call over Node transport");

  // Persistence is a recreated provider over the same local DB, not a NAS reboot claim.
  oauth.close(); oauth = await createLocalOAuth(config);
  assert.equal((await oauth.verifyAccessToken(sdkTokens.access_token)).clientId, sdkInfo.client_id);
  const refreshResponse = await refresh(sdkInfo.client_id, sdkTokens.refresh_token);
  assert.equal(refreshResponse.status, 200);
  tokens = rememberTokens(await refreshResponse.json());
  clock += 3601 * 1000;
  await assert.rejects(oauth.verifyAccessToken(tokens.access_token));
  const resumedRefresh = await refresh(sdkInfo.client_id, tokens.refresh_token);
  assert.equal(resumedRefresh.status, 200); rememberTokens(await resumedRefresh.json());
  const expiredCode = await getCode(clientId, verifier);
  clock += 121 * 1000;
  assert.equal((await exchange(clientId, expiredCode, verifier)).status, 400);
  form = await formFor(authorizeUrl(clientId, verifier));
  clock += 601 * 1000;
  assert.equal((await consent(form)).status, 403);
  pass("SQLite restart/read-back, access/code/consent expiry and persistent refresh");

  for (const filename of await readdir(authRoot)) {
    const bytes = await readFile(path.join(authRoot, filename));
    for (const value of plaintext) if (value) assert.equal(bytes.includes(Buffer.from(value)), false, "Auth storage must not contain plaintext credentials");
  }
  pass("SQLite/WAL/SHM contain no plaintext owner/bearer/code/access/refresh values");

  await assert.rejects(createLocalOAuth({ ...config, bearerKeyFile: ownerFile }));
  await assert.rejects(createLocalOAuth({ ...config, issuerUrl: "http://example.com", allowLoopbackHttp: true }));
  await assert.rejects(createLocalOAuth({ ...config, issuerUrl: "https://example.com/other" }));
  const symlinkFile = path.join(temp, "owner-symlink"); await symlink(ownerFile, symlinkFile);
  await assert.rejects(createLocalOAuth({ ...config, ownerKeyFile: symlinkFile }));
  const publicFile = path.join(temp, "public-key"); await writeFile(publicFile, owner, { mode: 0o644 });
  await assert.rejects(createLocalOAuth({ ...config, ownerKeyFile: publicFile }));
  pass("Unsafe issuer, owner/bearer reuse, symlink and world-readable secrets fail closed");

  const httpsRoot = path.join(temp, "https-auth");
  const httpsService = await createLocalOAuth({ ...config, authRoot: httpsRoot, issuerUrl: "https://civic.example", allowLoopbackHttp: false });
  assert.equal(httpsService.metadata.issuer, "https://civic.example/");
  const httpsHarness = createServer((req, res) => httpsService.handler(req, res));
  await new Promise((resolve) => httpsHarness.listen(0, "127.0.0.1", resolve));
  try {
    const harnessBase = `http://127.0.0.1:${httpsHarness.address().port}`;
    const proxyFetch = (url, options = {}) => new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: options.method || "GET", headers: options.headers }, (res) => {
        const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])) })));
      });
      req.on("error", reject); if (options.body) req.write(options.body); req.end();
    });
    const registration = await proxyFetch(`${harnessBase}/register`, { method: "POST", headers: { Host: "civic.example", "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: "none" }) });
    assert.equal(registration.status, 201);
    const secureClient = await registration.json();
    response = await proxyFetch(`${harnessBase}/authorize?${new URLSearchParams({ client_id: secureClient.client_id, redirect_uri: callback, response_type: "code", code_challenge: challenge(verifier), code_challenge_method: "S256", scope: "mcp:read", resource: "https://civic.example/mcp" })}`, { headers: { Host: "civic.example" } });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("set-cookie").startsWith("__Host-kcg-oauth="));
    assert.ok(response.headers.get("set-cookie").includes("; Secure"));
    assert.equal((await proxyFetch(`${harnessBase}/.well-known/oauth-authorization-server`, { headers: { Host: "evil.example" } })).status, 403);
  } finally { httpsHarness.closeAllConnections(); await new Promise((resolve) => httpsHarness.close(resolve)); httpsService.close(); }
  pass("Production issuer, Secure Host cookie and Host guard via local proxy harness; TLS itself not tested");
  process.stdout.write(`${JSON.stringify({ status: "PASS", cases: verdicts.length, checks: verdicts, clientEvidence: "Official SDK only; not ChatGPT E2E", secrets: "Synthetic test credentials only; no values logged" }, null, 2)}\n`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  oauth?.close();
  await rm(temp, { recursive: true, force: true });
}
