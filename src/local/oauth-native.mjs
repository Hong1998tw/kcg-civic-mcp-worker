import express from "express";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, lstat, open } from "node:fs/promises";
import path from "node:path";
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const SCOPES = ["mcp:read", "offline_access"];
const PATHS = new Set(["/authorize", "/consent", "/token", "/register", "/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]);
const secretHash = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");
const equal = (a, b) => timingSafeEqual(Buffer.from(secretHash(a)), Buffer.from(secretHash(b)));
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function readSecret(filename, label) {
  if (!filename) throw new Error(`${label} file is required`);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (info.mode & 0o077)) throw new Error(`${label} must be a private regular file`);
  // Open without following a symlink swapped after lstat.
  const { constants } = await import("node:fs");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) throw new Error(`${label} must be a private regular file`);
    const value = (await handle.readFile("utf8")).replace(/[\r\n]+$/, "");
    if (value.length < 32 || Buffer.byteLength(value) > 4096 || /\s/.test(value)) throw new Error(`${label} must contain at least 32 non-whitespace characters`);
    return value;
  } finally { await handle.close(); }
}

function exactRedirect(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s<>"'\\]/.test(value)) return false;
  try {
    const uri = new URL(value);
    return !uri.username && !uri.password && !uri.hash && (uri.protocol === "https:" ||
      (uri.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname)));
  } catch { return false; }
}

function validateScopes(scopes, allowed = SCOPES) {
  if (!Array.isArray(scopes) || !scopes.includes("mcp:read") || new Set(scopes).size !== scopes.length || scopes.some((s) => !allowed.includes(s))) {
    throw new InvalidScopeError("Unsupported scope");
  }
  return scopes;
}

/**
 * NAS-native OAuth provider. The caller owns HTTP/TLS routing and corpus access.
 * No Cloudflare runtime module, external identity provider or outbound fetch.
 */
export async function createLocalOAuth(options) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("OAuth requires Node.js >=24");
  const issuer = new URL(options.issuerUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
  if (issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== "/" ||
    (issuer.protocol !== "https:" && !(options.allowLoopbackHttp === true && loopback && issuer.protocol === "http:"))) {
    throw new Error("OAuth issuer must be a root HTTPS URL; explicit loopback-only HTTP is for tests");
  }
  const resource = new URL("/mcp", issuer).href;
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", issuer).href;
  const ownerKey = await readSecret(options.ownerKeyFile, "owner login key");
  const bearerKey = options.bearerKeyFile ? await readSecret(options.bearerKeyFile, "compatible bearer key") : null;
  if (bearerKey && equal(ownerKey, bearerKey)) throw new Error("Owner login key must differ from compatible bearer key");
  const stateKey = createHmac("sha256", ownerKey).update("kcg-local-oauth-consent-v1").digest();
  const now = () => Math.floor((options.now ? options.now() : Date.now()) / 1000);
  const accessTtl = options.accessTokenTtl ?? 3600;
  const refreshTtl = options.refreshTokenTtl ?? 30 * 86400;
  const codeTtl = options.codeTtl ?? 120;
  const consentTtl = options.consentTtl ?? 600;
  for (const value of [accessTtl, refreshTtl, codeTtl, consentTtl]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 366 * 86400) throw new Error("Invalid OAuth TTL");
  }
  const authRoot = path.resolve(options.authRoot);
  await mkdir(authRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(authRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077)) throw new Error("authRoot must be a private directory");
  const filename = path.join(authRoot, "oauth.sqlite");
  try { const handle = await open(filename, "wx", 0o600); await handle.close(); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const dbStat = await lstat(filename);
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || (dbStat.mode & 0o077)) throw new Error("OAuth DB must be a private regular file");
  const db = new DatabaseSync(filename);
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (![0, 1].includes(version)) throw new Error("Unsupported OAuth DB schema");
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS oauth_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, client_id TEXT NOT NULL,
        params TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        resource TEXT NOT NULL, scopes TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_families (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, resource TEXT NOT NULL,
        scopes TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
        family TEXT NOT NULL REFERENCES oauth_families(id) ON DELETE CASCADE, scopes TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family);`);
    const previous = db.prepare("SELECT value FROM oauth_settings WHERE key='issuer'").get();
    if (previous && previous.value !== issuer.href) throw new Error("OAuth DB issuer mismatch; use a separately reviewed authRoot");
    db.prepare("INSERT OR IGNORE INTO oauth_settings VALUES ('issuer',?)").run(issuer.href);
    db.exec("PRAGMA user_version=1");
  } catch (error) { db.close(); throw error; }
  const transaction = (action) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const purge = () => {
    db.prepare("DELETE FROM oauth_pending WHERE expires<=?").run(now());
    db.prepare("DELETE FROM oauth_codes WHERE expires<=?").run(now());
    db.prepare("DELETE FROM oauth_families WHERE expires<=?").run(now());
    db.prepare("DELETE FROM oauth_clients WHERE expires<=?").run(now());
  };
  const bindResource = (value) => {
    if (value?.href !== resource) throw new InvalidTargetError("Exact resource is required");
  };
  const lookupCode = (client, code) => {
    if (typeof code !== "string" || !/^[a-f0-9]{64}$/.test(code)) throw new InvalidGrantError("Invalid authorization code");
    const row = db.prepare("SELECT * FROM oauth_codes WHERE hash=?").get(secretHash(code));
    if (!row || row.client_id !== client.client_id || row.expires <= now() || row.consumed) throw new InvalidGrantError("Invalid authorization code");
    return row;
  };
  const issueTokens = (family, scopes) => {
    const access = random();
    const expiry = Math.min(now() + accessTtl, family.expires);
    db.prepare("INSERT INTO oauth_tokens(hash,kind,family,scopes,expires) VALUES (?,'access',?,?,?)").run(secretHash(access), family.id, JSON.stringify(scopes), expiry);
    const tokens = { access_token: access, token_type: "Bearer", expires_in: expiry - now(), scope: scopes.join(" ") };
    if (scopes.includes("offline_access")) {
      const refresh = random();
      db.prepare("INSERT INTO oauth_tokens(hash,kind,family,scopes,expires) VALUES (?,'refresh',?,?,?)").run(secretHash(refresh), family.id, JSON.stringify(scopes), family.expires);
      tokens.refresh_token = refresh;
    }
    return tokens;
  };
  const cookieName = issuer.protocol === "https:" ? "__Host-kcg-oauth" : "kcg-oauth-loopback";
  const cookie = (sid, ttl) => `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${issuer.protocol === "https:" ? "; Secure" : ""}`;
  const signState = (id, expiry) => `${id}.${expiry}.${createHmac("sha256", stateKey).update(`${id}.${expiry}`).digest("hex")}`;
  const provider = {
    clientsStore: {
      async getClient(id) {
        if (typeof id !== "string" || id.length > 128) return undefined;
        const row = db.prepare("SELECT metadata FROM oauth_clients WHERE id=? AND expires>?").get(id, now());
        return row ? JSON.parse(row.metadata) : undefined;
      },
      async registerClient(client) {
        if (client.token_endpoint_auth_method !== "none" || client.client_secret || !Array.isArray(client.redirect_uris) ||
          client.redirect_uris.length < 1 || client.redirect_uris.length > 8 || client.redirect_uris.some((uri) => !exactRedirect(uri)) ||
          new Set(client.redirect_uris).size !== client.redirect_uris.length ||
          (client.grant_types || []).some((g) => !["authorization_code", "refresh_token"].includes(g)) ||
          (client.response_types || []).some((r) => r !== "code")) throw new InvalidClientMetadataError("Only public PKCE clients with exact safe redirects are supported");
        if (client.scope) validateScopes(client.scope.split(" "));
        purge();
        if (db.prepare("SELECT count(*) AS n FROM oauth_clients").get().n >= (options.maxClients ?? 5000)) throw new InvalidClientMetadataError("Client capacity reached");
        const safe = { client_id: client.client_id, client_id_issued_at: now(), client_name: (client.client_name || "MCP Client").slice(0, 120),
          redirect_uris: client.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: client.scope || SCOPES.join(" ") };
        db.prepare("INSERT INTO oauth_clients VALUES (?,?,?)").run(safe.client_id, JSON.stringify(safe), now() + 365 * 86400);
        return safe;
      },
    },
    async authorize(client, params, res) {
      // SDK permits loopback port relaxation; this service deliberately requires exact registration.
      if (!client.redirect_uris.includes(params.redirectUri) || !exactRedirect(params.redirectUri)) {
        res.status(400).json({ error: "invalid_request" }); return;
      }
      bindResource(params.resource);
      validateScopes(params.scopes, client.scope.split(" "));
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state && (params.state.length > 1024 || /[\x00-\x1f\x7f]/.test(params.state)))) throw new InvalidRequestError("Invalid authorization parameters");
      purge();
      if (db.prepare("SELECT count(*) AS n FROM oauth_pending").get().n >= 10000) throw new InvalidRequestError("Consent capacity reached");
      const sid = random(), id = secretHash(sid), csrf = random(), expiry = now() + consentTtl;
      db.prepare("INSERT INTO oauth_pending(id,csrf_hash,client_id,params,expires) VALUES (?,?,?,?,?)").run(id, secretHash(csrf), client.client_id,
        JSON.stringify({ ...params, resource: resource }), expiry);
      const state = signState(id, expiry);
      res.setHeader("Set-Cookie", cookie(sid, consentTtl));
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      res.type("html").send(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>連接高雄市公民資料</title><main><h1>連接高雄市公民資料</h1><p><strong>${escapeHtml(client.client_name)}</strong> 要求唯讀查詢已收錄的市政資料。</p><p>授權範圍：${escapeHtml(params.scopes.join(" "))}</p><p>授權後返回：${escapeHtml(new URL(params.redirectUri).origin)}</p><form method="post" action="/consent"><input type="hidden" name="state" value="${state}"><input type="hidden" name="csrf" value="${csrf}"><label>擁有者登入金鑰<input type="password" name="owner_key" autocomplete="current-password" maxlength="4096" required></label><button name="decision" value="allow" type="submit">同意並連接</button><button name="decision" value="deny" type="submit" formnovalidate>取消</button></form></main></html>`);
    },
    async challengeForAuthorizationCode(client, code) { return lookupCode(client, code).challenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      bindResource(requestedResource);
      return transaction(() => {
        const row = lookupCode(client, code);
        if (redirectUri !== row.redirect_uri) throw new InvalidGrantError("Exact redirect is required");
        const scopes = JSON.parse(row.scopes), id = random();
        const family = { id, expires: now() + (scopes.includes("offline_access") ? refreshTtl : accessTtl) };
        db.prepare("UPDATE oauth_codes SET consumed=1 WHERE hash=?").run(secretHash(code));
        db.prepare("INSERT INTO oauth_families(id,client_id,resource,scopes,expires) VALUES (?,?,?,?,?)").run(id, client.client_id, row.resource, row.scopes, family.expires);
        return issueTokens(family, scopes);
      });
    },
    async exchangeRefreshToken(client, refreshToken, scopes, requestedResource) {
      bindResource(requestedResource);
      if (typeof refreshToken !== "string" || !/^[a-f0-9]{64}$/.test(refreshToken)) throw new InvalidGrantError("Invalid refresh token");
      const result = transaction(() => {
        const row = db.prepare("SELECT t.*,f.client_id,f.resource,f.revoked,f.expires AS family_expires FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family WHERE t.hash=? AND t.kind='refresh'").get(secretHash(refreshToken));
        if (!row || row.client_id !== client.client_id || row.resource !== resource || row.revoked || row.family_expires <= now()) throw new InvalidGrantError("Invalid refresh token");
        if (row.consumed) {
          // Commit family revocation before reporting replay; throwing inside the transaction would roll it back.
          db.prepare("UPDATE oauth_families SET revoked=1 WHERE id=?").run(row.family);
          return null;
        }
        if (row.expires <= now()) throw new InvalidGrantError("Expired refresh token");
        const original = JSON.parse(row.scopes), selected = scopes ?? original;
        validateScopes(selected, original);
        db.prepare("UPDATE oauth_tokens SET consumed=1 WHERE hash=?").run(row.hash);
        return issueTokens({ id: row.family, expires: row.family_expires }, selected);
      });
      if (!result) throw new InvalidGrantError("Refresh token replay detected");
      return result;
    },
    async verifyAccessToken(token) {
      if (typeof token !== "string" || token.length > 4096 || /\s/.test(token)) throw new InvalidTokenError("Invalid access token");
      if (bearerKey && equal(token, bearerKey)) return { token, clientId: "explicit-bearer-compatibility", scopes: ["mcp:read"], resource: new URL(resource), extra: { method: "bearer_compatibility" } };
      if (!/^[a-f0-9]{64}$/.test(token)) throw new InvalidTokenError("Invalid access token");
      const row = db.prepare("SELECT t.expires,t.scopes,f.client_id,f.resource,f.revoked,f.expires AS family_expires FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family WHERE t.hash=? AND t.kind='access'").get(secretHash(token));
      if (!row || row.revoked || row.expires <= now() || row.family_expires <= now() || row.resource !== resource) throw new InvalidTokenError("Invalid access token");
      return { token, clientId: row.client_id, scopes: JSON.parse(row.scopes), expiresAt: row.expires, resource: new URL(row.resource) };
    },
    async revokeToken(client, request) {
      if (typeof request.token !== "string" || request.token.length > 4096) return;
      db.prepare("UPDATE oauth_families SET revoked=1 WHERE client_id=? AND id IN (SELECT family FROM oauth_tokens WHERE hash=?)").run(client.client_id, secretHash(request.token));
    },
  };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const hosts = new Set([issuer.host.toLowerCase(), ...(options.allowedHosts || []).map((h) => h.toLowerCase())]);
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || !hosts.has(String(req.headers.host || "").toLowerCase())) { res.status(403).json({ error: "forbidden" }); return; }
    const url = new URL(req.url, issuer);
    if (!PATHS.has(url.pathname)) { next(); return; }
    // Authorize is a browser navigation; owner consent is a separate CSRF-protected route.
    if (url.pathname === "/authorize" && req.method !== "GET") { res.status(405).json({ error: "method_not_allowed" }); return; }
    if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
      (url.pathname !== "/authorize" && url.search)) { res.status(400).json({ error: "invalid_request" }); return; }
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 30 }));
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    if (req.is("application/x-www-form-urlencoded") && req.body && Object.values(req.body).some((value) => Array.isArray(value))) { res.status(400).json({ error: "invalid_request" }); return; }
    if (["/token", "/revoke"].includes(req.path) && (req.body?.client_secret !== undefined || req.headers.authorization)) { res.status(400).json({ error: "invalid_client" }); return; }
    if (req.path === "/token" && req.body?.grant_type === "authorization_code" && !/^[A-Za-z0-9._~-]{43,128}$/.test(req.body?.code_verifier || "")) { res.status(400).json({ error: "invalid_grant" }); return; }
    next();
  });
  app.post("/consent", async (req, res) => {
    if (req.headers.origin !== issuer.origin || !req.is("application/x-www-form-urlencoded") ||
      Object.keys(req.body || {}).some((key) => !["state", "csrf", "owner_key", "decision"].includes(key))) { res.status(403).json({ error: "invalid_request" }); return; }
    const { state, csrf, owner_key: submittedKey, decision } = req.body || {};
    const parts = typeof state === "string" ? state.split(".") : [];
    const cookies = String(req.headers.cookie || "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${cookieName}=`));
    const sid = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : "";
    if (parts.length !== 3 || !/^[a-f0-9]{64}$/.test(parts[0]) || !/^[0-9]{1,12}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2]) ||
      !/^[a-f0-9]{64}$/.test(sid) || !equal(state, signState(parts[0], parts[1])) || !equal(parts[0], secretHash(sid)) ||
      typeof csrf !== "string" || !/^[a-f0-9]{64}$/.test(csrf)) { res.status(403).json({ error: "invalid_request" }); return; }
    const result = transaction(() => {
      const row = db.prepare("SELECT * FROM oauth_pending WHERE id=?").get(parts[0]);
      if (!row || row.expires <= now() || row.expires !== Number(parts[1]) || row.attempts >= 5 || !equal(row.csrf_hash, secretHash(csrf))) return { status: 403 };
      if (!["allow", "deny"].includes(decision)) return { status: 400 };
      if (decision === "allow" && (typeof submittedKey !== "string" || submittedKey.length > 4096 || !equal(submittedKey, ownerKey))) {
        db.prepare("UPDATE oauth_pending SET attempts=attempts+1 WHERE id=?").run(row.id);
        return { status: 403 };
      }
      const client = db.prepare("SELECT metadata FROM oauth_clients WHERE id=? AND expires>?").get(row.client_id, now());
      const params = JSON.parse(row.params);
      if (!client || !JSON.parse(client.metadata).redirect_uris.includes(params.redirectUri)) return { status: 403 };
      const redirect = new URL(params.redirectUri);
      if (decision === "deny") redirect.searchParams.set("error", "access_denied");
      else {
        const code = random();
        db.prepare("INSERT INTO oauth_codes(hash,client_id,redirect_uri,resource,scopes,challenge,expires) VALUES (?,?,?,?,?,?,?)").run(secretHash(code), row.client_id, params.redirectUri, resource, JSON.stringify(params.scopes), params.codeChallenge, now() + codeTtl);
        redirect.searchParams.set("code", code);
      }
      if (params.state !== undefined) redirect.searchParams.set("state", params.state);
      redirect.searchParams.set("iss", issuer.href);
      db.prepare("DELETE FROM oauth_pending WHERE id=?").run(row.id);
      return { redirect: redirect.href };
    });
    if (result.status) { res.status(result.status).json({ error: "invalid_request" }); return; }
    res.setHeader("Set-Cookie", cookie("", 0));
    res.redirect(303, result.redirect);
  });
  const routerOptions = { provider, issuerUrl: issuer, resourceServerUrl: new URL(resource), scopesSupported: SCOPES, resourceName: "高雄市公民資料 MCP（NAS）" };
  const metadata = { ...createOAuthMetadata(routerOptions), token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: false };
  const resourceMetadata = { resource, authorization_servers: [issuer.href], scopes_supported: ["mcp:read"], bearer_methods_supported: ["header"], resource_name: "高雄市公民資料 MCP（NAS）" };
  // Override only advertised unsupported methods; all OAuth protocol handlers are the official SDK router.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.json(metadata); });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.json(resourceMetadata); });
  app.use(mcpAuthRouter(routerOptions));
  app.use((error, _req, res, _next) => { if (!res.headersSent) res.status(error?.type === "entity.too.large" ? 413 : 400).json({ error: "invalid_request" }); else res.end(); });
  return {
    handler: app,
    handles: (pathname) => PATHS.has(pathname),
    verifyAccessToken: provider.verifyAccessToken,
    async authenticateMcp(req, res) {
      const value = req.headers.authorization;
      const match = typeof value === "string" && value.length <= 4103 ? /^Bearer ([^\s]+)$/i.exec(value) : null;
      try {
        if (!match) throw new InvalidTokenError("Invalid access token");
        return await provider.verifyAccessToken(match[1]);
      } catch {
        res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store", "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:read"` });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return null;
      }
    },
    metadata, resourceMetadata, resourceMetadataUrl,
    close() { db.close(); },
  };
}
