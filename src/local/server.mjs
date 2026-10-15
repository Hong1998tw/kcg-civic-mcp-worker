import { createServer } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { handleMcp } from "../mcp/transport.ts";
import { createLocalRegistry, LOCAL_SOURCE_TOOL_SCHEMAS, LOCAL_TOOL_NAMES } from "./registry.mjs";
import { LocalStore } from "./store.mjs";

export { createLocalRegistry, LOCAL_SOURCE_TOOL_SCHEMAS, LOCAL_TOOL_NAMES };

const MAX_BODY_BYTES = 1024 * 1024;
const TOKEN_MAX_BYTES = 4096;
const SERVER_INFO = { name: "高雄市公民資料 MCP（本機快照）", version: "1.1.1-local.1" };
const API_KEY_SCHEME = [{ type: "apiKey", in: "header", name: "Authorization", description: "Bearer token" }];

function requireNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error("local MCP requires Node.js >=24");
}

function parsePort(value) {
  const port = Number(value || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return port;
}

async function loadAccessKey(env) {
  let key = env.MCP_ACCESS_KEY || "";
  if (env.MCP_ACCESS_KEY_FILE) {
    let info;
    try { info = await lstat(env.MCP_ACCESS_KEY_FILE); } catch { throw new Error("MCP_ACCESS_KEY_FILE is not readable"); }
    if (info.isSymbolicLink() || !info.isFile() || info.size > TOKEN_MAX_BYTES) throw new Error("MCP_ACCESS_KEY_FILE must be a regular file no larger than 4096 bytes");
    try { key = await readFile(env.MCP_ACCESS_KEY_FILE, "utf8"); } catch { throw new Error("MCP_ACCESS_KEY_FILE is not readable"); }
    key = key.replace(/[\r\n]+$/, "");
  }
  if (!key || Buffer.byteLength(key) > TOKEN_MAX_BYTES || /\s/.test(key)) throw new Error("MCP_ACCESS_KEY or MCP_ACCESS_KEY_FILE is required");
  return key;
}

function sameSecret(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  const paddedA = Buffer.alloc(TOKEN_MAX_BYTES);
  const paddedB = Buffer.alloc(TOKEN_MAX_BYTES);
  a.copy(paddedA);
  b.copy(paddedB);
  const bytesEqual = timingSafeEqual(paddedA, paddedB);
  return bytesEqual && a.length === b.length;
}

function bearerAuthorized(value, expected) {
  if (typeof value !== "string" || value.length > TOKEN_MAX_BYTES + 7) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return !!match && sameSecret(match[1], expected);
}

function allowedHosts(port, env) {
  const configured = (env.LOCAL_ALLOWED_HOSTS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return new Set(configured.length ? configured : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

function allowedOrigins(port, env) {
  const configured = (env.MCP_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return new Set([...configured, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
}

function isLoopback(bindHost) {
  return bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
}

function plainResponse(res, status, body, extraHeaders = {}) {
  const bytes = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(bytes);
}

async function readBoundedBody(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function toWebRequest(req, body) {
  const host = req.headers.host;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${host}${req.url || "/"}`, {
    method: req.method,
    headers,
    ...(body ? { body, duplex: "half" } : {}),
  });
}

function validateHostAndOrigin(req, hostSet, originSet) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host || !hostSet.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string" || origin === "null" || !originSet.has(origin)) return false;
  try { return new URL(origin).origin === origin; } catch { return false; }
}

export async function startLocalServer(env = process.env) {
  requireNode24();
  const port = parsePort(env.PORT);
  const bindHost = env.BIND_HOST || "127.0.0.1";
  if (!isLoopback(bindHost) && env.LOCAL_PRIVATE_BIND !== "true") {
    throw new Error("non-loopback BIND_HOST requires LOCAL_PRIVATE_BIND=true");
  }
  const accessKey = await loadAccessKey(env);
  const dataRoot = env.KCG_CIVIC_DATA_DIR || "/data/kcg-civic";
  const store = new LocalStore(dataRoot, { readOnly: true });
  const registry = createLocalRegistry(store);
  const hostSet = allowedHosts(port, env);
  const originSet = allowedOrigins(port, env);
  const mcpEnv = { PUBLIC_ORIGIN: `http://${bindHost}:${port}` };

  const server = createServer(async (req, res) => {
    try {
      if (!validateHostAndOrigin(req, hostSet, originSet)) {
        plainResponse(res, 403, JSON.stringify({ error: "forbidden" }));
        return;
      }
      const body = await readBoundedBody(req);
      if (!body) {
        plainResponse(res, 413, JSON.stringify({ error: "payload_too_large" }));
        return;
      }
      const pathname = new URL(req.url || "/", `http://${req.headers.host}`).pathname;
      if (pathname === "/health") {
        if (req.method !== "GET") {
          plainResponse(res, 405, JSON.stringify({ error: "method_not_allowed" }), { Allow: "GET" });
          return;
        }
        if (body.length > 0) {
          plainResponse(res, 400, JSON.stringify({ error: "body_not_allowed" }));
          return;
        }
        plainResponse(res, 200, JSON.stringify({ status: "ok" }));
        return;
      }
      if (pathname !== "/mcp") {
        plainResponse(res, 404, JSON.stringify({ error: "not_found" }));
        return;
      }
      if (req.method !== "POST") {
        plainResponse(res, 405, JSON.stringify({ error: "method_not_allowed" }), { Allow: "POST" });
        return;
      }
      if (!bearerAuthorized(req.headers.authorization, accessKey)) {
        plainResponse(res, 401, JSON.stringify({ error: "unauthorized" }), { "WWW-Authenticate": "Bearer" });
        return;
      }
      const request = toWebRequest(req, body);
      const response = await handleMcp(request, mcpEnv, {
        registry,
        serverInfo: SERVER_INFO,
        securitySchemes: API_KEY_SCHEME,
        iconUrl: null,
        openWorldHint: false,
      });
      const headers = Object.fromEntries(response.headers.entries());
      headers["Cache-Control"] = "no-store";
      headers["X-Content-Type-Options"] = "nosniff";
      headers["Referrer-Policy"] = "no-referrer";
      const responseBytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, { ...headers, "Content-Length": String(responseBytes.length) });
      res.end(responseBytes);
    } catch {
      if (!res.headersSent) plainResponse(res, 500, JSON.stringify({ error: "internal_error" }));
      else res.destroy();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 128;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, resolve);
  });
  process.stdout.write(`local MCP listening on ${bindHost}:${port} with ${registry.length} tools\n`);

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  };
  return { server, store, close };
}

if (import.meta.main) {
  startLocalServer().catch((error) => {
    process.stderr.write(`local MCP startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
