import { Agent, createServer, request as httpRequest } from 'node:http';
import { Transform } from 'node:stream';

export const DEFAULT_PUBLIC_HOST = 'kcg-civic-mcp.kshong.com';
export const PRODUCTION_UPSTREAM = 'http://query:8787';
export const INGRESS_LIMITS = Object.freeze({
  bodyBytes: 256 * 1024,
  responseBytes: 8 * 1024 * 1024,
  headerBytes: 16 * 1024,
  headerCount: 32,
  requestTimeoutMs: 60_000,
});

const NATIVE_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
const PUBLIC_RESOURCE_METADATA_ALIAS = '/.well-known/oauth-protected-resource';
const ROUTES = new Map([
  ['/mcp', { methods: new Set(['POST', 'GET', 'DELETE']), query: true }],
  ['/health', { methods: new Set(['GET']), query: false }],
  ['/.well-known/oauth-authorization-server', { methods: new Set(['GET']), query: false }],
  [NATIVE_RESOURCE_METADATA_PATH, { methods: new Set(['GET']), query: false }],
  [PUBLIC_RESOURCE_METADATA_ALIAS, { methods: new Set(['GET']), query: false, upstreamPath: NATIVE_RESOURCE_METADATA_PATH }],
  ['/authorize', { methods: new Set(['GET']), query: true }],
  ['/consent', { methods: new Set(['POST']), query: false }],
  ['/register', { methods: new Set(['POST']), query: false }],
  ['/token', { methods: new Set(['POST']), query: false }],
  ['/revoke', { methods: new Set(['POST']), query: false }],
]);

const REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'content-length',
  'content-type',
  'cookie',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'origin',
]);
const RESPONSE_HEADERS = new Set([
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'access-control-max-age',
  'allow',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-security-policy',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'location',
  'mcp-protocol-version',
  'mcp-session-id',
  'pragma',
  'referrer-policy',
  'retry-after',
  'set-cookie',
  'vary',
  'www-authenticate',
  'x-content-type-options',
  'x-frame-options',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SINGLETON_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'origin',
  'transfer-encoding',
  'upgrade',
]);

function requireNode24() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error('local ingress requires Node.js >=24');
}

function validatePublicHost(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()) {
    throw new Error('PUBLIC_HOST must be an exact lowercase hostname');
  }
  const labels = value.split('.');
  if (!labels.length || labels.some((label) => label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('PUBLIC_HOST must be an exact lowercase hostname');
  }
  return value;
}

function parsePort(value, { allowZero = false } = {}) {
  if (typeof value === 'number' && Number.isInteger(value) && (allowZero ? value >= 0 : value >= 1024) && value <= 65535) return value;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})$/.test(value)) throw new Error('LOCAL_INGRESS_PORT must be an integer from 1024 to 65535');
  const port = Number(value);
  if ((!allowZero && port < 1024) || port > 65535) throw new Error('LOCAL_INGRESS_PORT must be an integer from 1024 to 65535');
  return port;
}

function parseTestTarget(value) {
  if (typeof value !== 'string') throw new Error('testTarget must use the fixed 127.0.0.1 test address');
  let target;
  try { target = new URL(value); } catch { throw new Error('testTarget must use the fixed 127.0.0.1 test address'); }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port ||
    target.username || target.password || target.pathname !== '/' || target.search || target.hash ||
    value !== 'http://127.0.0.1:' + target.port) {
    throw new Error('testTarget must use the fixed 127.0.0.1 test address');
  }
  const port = Number(target.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('testTarget must use the fixed 127.0.0.1 test address');
  return { hostname: '127.0.0.1', port };
}

function headerValues(rawHeaders) {
  const values = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    const list = values.get(name) || [];
    list.push(rawHeaders[i + 1]);
    values.set(name, list);
  }
  return values;
}

function headerByteLength(rawHeaders) {
  let size = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    size += Buffer.byteLength(rawHeaders[i]) + Buffer.byteLength(rawHeaders[i + 1]) + 4;
  }
  return size;
}

function readHeaderLimits(req) {
  if (req.rawHeaders.length / 2 > INGRESS_LIMITS.headerCount ||
    headerByteLength(req.rawHeaders) > INGRESS_LIMITS.headerBytes) return 431;
  const values = headerValues(req.rawHeaders);
  for (const [name, list] of values) {
    if (SINGLETON_REQUEST_HEADERS.has(name) && list.length !== 1) return 400;
    if (list.some((value) => /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value))) return 400;
  }
  return 0;
}

function isValidRequestTarget(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 &&
    value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') &&
    !value.includes('#') && !/[\u0000-\u0020\u007f]/.test(value) &&
    !/%(?![0-9a-f]{2})/i.test(value);
}

function getBodyLength(req) {
  const value = req.headers['content-length'];
  if (value === undefined) return { length: null, error: null };
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return { length: null, error: 400 };
  try {
    const length = BigInt(value);
    if (length > BigInt(INGRESS_LIMITS.bodyBytes)) return { length: null, error: 413 };
    return { length: Number(length), error: null };
  } catch { return { length: null, error: 400 }; }
}

function safeResponseHeaders(upstreamResponse) {
  const rawHeaders = upstreamResponse.rawHeaders || [];
  if (rawHeaders.length / 2 > INGRESS_LIMITS.headerCount ||
    headerByteLength(rawHeaders) > INGRESS_LIMITS.headerBytes) return null;

  const connectionValues = upstreamResponse.headers.connection;
  const nominated = new Set();
  for (const value of (Array.isArray(connectionValues) ? connectionValues : [connectionValues])) {
    if (typeof value === 'string') for (const name of value.split(',')) nominated.add(name.trim().toLowerCase());
  }
  const headers = Object.create(null);
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || nominated.has(name) || !RESPONSE_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  headers['cache-control'] = 'no-store';
  headers['x-content-type-options'] = 'nosniff';
  return headers;
}

function makeErrorBody(code) {
  return Buffer.from(JSON.stringify({ error: code }));
}

function responseContentLength(headers) {
  const value = headers['content-length'];
  if (value === undefined) return { length: null, tooLarge: false, invalid: false };
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return { length: null, tooLarge: false, invalid: true };
  try {
    const length = BigInt(value);
    return {
      length: length <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(length) : null,
      tooLarge: length > BigInt(INGRESS_LIMITS.responseBytes),
      invalid: false,
    };
  } catch { return { length: null, tooLarge: false, invalid: true }; }
}

export function createLocalIngressServer(options = {}) {
  requireNode24();
  const env = options.env || process.env;
  const publicHost = validatePublicHost(options.publicHost ?? env.PUBLIC_HOST ?? DEFAULT_PUBLIC_HOST);
  const publicOrigin = 'https://' + publicHost;
  const testTarget = options.testTarget;
  let target;
  if (testTarget !== undefined) {
    target = parseTestTarget(testTarget);
  } else {
    const configuredTarget = env.LOCAL_INGRESS_UPSTREAM;
    if (configuredTarget !== undefined && configuredTarget !== PRODUCTION_UPSTREAM) {
      throw new Error('LOCAL_INGRESS_UPSTREAM only accepts http://query:8787');
    }
    target = { hostname: 'query', port: 8787 };
  }

  const listenPort = options.listenPort === undefined
    ? parsePort(env.LOCAL_INGRESS_PORT ?? '8788')
    : parsePort(options.listenPort, { allowZero: true });
  const listenAddress = options.listenAddress ?? '0.0.0.0';
  const requestTimeoutMs = options.requestTimeoutMs ?? INGRESS_LIMITS.requestTimeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000) {
    throw new Error('requestTimeoutMs must be an integer from 100 to 120000');
  }
  if (testTarget === undefined && options.requestTimeoutMs !== undefined) {
    throw new Error('requestTimeoutMs override is available only with testTarget');
  }

  // This dedicated agent never reads HTTP_PROXY/HTTPS_PROXY or other environment proxy settings.
  const agent = new Agent({ keepAlive: false, maxSockets: 64, maxTotalSockets: 64 });
  const server = createServer({ maxHeaderSize: INGRESS_LIMITS.headerBytes }, (req, res) => {
    let upstreamRequest;
    let requestStream;
    let upstreamResponse;
    let deadline;
    let terminal = false;

    const clearDeadline = () => {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
    };

    const pauseIncoming = () => {
      if (requestStream) {
        req.unpipe(requestStream);
        if (upstreamRequest) requestStream.unpipe(upstreamRequest);
      }
      req.pause();
    };

    const stopUpstream = () => {
      if (upstreamRequest && !upstreamRequest.destroyed) upstreamRequest.destroy();
      if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
    };

    const finishError = (status, code, extraHeaders = {}) => {
      if (terminal || res.destroyed) return;
      terminal = true;
      clearDeadline();
      pauseIncoming();
      stopUpstream();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = makeErrorBody(code);
      res.shouldKeepAlive = false;
      res.writeHead(status, {
        'cache-control': 'no-store',
        connection: 'close',
        'content-length': String(body.length),
        'content-type': 'application/json; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        ...extraHeaders,
      });
      res.end(body);
    };

    const abortForClient = () => {
      if (terminal) return;
      terminal = true;
      clearDeadline();
      stopUpstream();
      if (requestStream && !requestStream.destroyed) requestStream.destroy();
      if (!res.destroyed) res.destroy();
    };

    req.once('aborted', abortForClient);
    req.once('error', () => finishError(400, 'invalid_request'));
    res.once('finish', () => {
      terminal = true;
      clearDeadline();
      if (!req.complete) {
        pauseIncoming();
        stopUpstream();
      }
    });
    res.once('close', () => {
      if (!res.writableFinished) abortForClient();
    });

    const headerError = readHeaderLimits(req);
    if (headerError) {
      finishError(headerError, headerError === 431 ? 'headers_too_large' : 'invalid_headers');
      return;
    }
    const incomingHost = req.headers.host;
    if (typeof incomingHost !== 'string' || incomingHost !== publicHost) {
      finishError(403, 'forbidden');
      return;
    }
    if (req.headers.expect !== undefined) {
      finishError(417, 'expectation_failed');
      return;
    }
    if (req.headers.upgrade !== undefined) {
      finishError(400, 'invalid_request');
      return;
    }
    if (!isValidRequestTarget(req.url)) {
      finishError(400, 'invalid_request_target');
      return;
    }

    const question = req.url.indexOf('?');
    const pathname = question < 0 ? req.url : req.url.slice(0, question);
    const hasQuery = question >= 0;
    const route = ROUTES.get(pathname);
    if (!route) {
      finishError(404, 'not_found');
      return;
    }
    if (!route.methods.has(req.method)) {
      finishError(405, 'method_not_allowed', { allow: [...route.methods].join(', ') });
      return;
    }
    if (hasQuery && !route.query) {
      finishError(400, 'query_not_allowed');
      return;
    }
    if (req.headers.origin !== undefined && req.headers.origin !== publicOrigin) {
      finishError(403, 'forbidden');
      return;
    }
    const contentLength = getBodyLength(req);
    if (contentLength.error) {
      finishError(contentLength.error, contentLength.error === 413 ? 'payload_too_large' : 'invalid_content_length');
      return;
    }
    if (req.headers['transfer-encoding'] !== undefined &&
      (req.headers['content-length'] !== undefined || String(req.headers['transfer-encoding']).toLowerCase() !== 'chunked')) {
      finishError(400, 'invalid_transfer_encoding');
      return;
    }
    if (['/token', '/revoke'].includes(pathname) && req.headers.authorization !== undefined) {
      finishError(400, 'invalid_client');
      return;
    }

    const nominated = new Set();
    const connection = req.headers.connection;
    for (const value of (Array.isArray(connection) ? connection : [connection])) {
      if (typeof value === 'string') for (const name of value.split(',')) nominated.add(name.trim().toLowerCase());
    }
    const headers = { host: publicHost };
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || Array.isArray(value) || HOP_BY_HOP_HEADERS.has(name) ||
        nominated.has(name) || !REQUEST_HEADERS.has(name) || name.startsWith('x-forwarded-') ||
        name === 'forwarded' || name.startsWith('cf-')) continue;
      if (name === 'cookie' && pathname !== '/consent') continue;
      headers[name] = value;
    }

    const upstreamPath = route.upstreamPath ? route.upstreamPath + (hasQuery ? req.url.slice(question) : '') : req.url;
    deadline = setTimeout(() => finishError(504, 'upstream_timeout'), requestTimeoutMs);

    try {
      upstreamRequest = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: upstreamPath,
        method: req.method,
        headers,
        agent,
        maxHeaderSize: INGRESS_LIMITS.headerBytes,
      });
    } catch {
      finishError(502, 'upstream_unavailable');
      return;
    }

    upstreamRequest.once('error', () => finishError(502, 'upstream_unavailable'));
    upstreamRequest.once('response', (incoming) => {
      upstreamResponse = incoming;
      if (terminal) {
        incoming.destroy();
        return;
      }
      const responseHeaders = safeResponseHeaders(incoming);
      if (!responseHeaders) {
        finishError(502, 'upstream_headers_too_large');
        return;
      }
      const length = responseContentLength(incoming.headers);
      if (length.invalid) {
        finishError(502, 'invalid_upstream_response');
        return;
      }
      if (length.tooLarge) {
        finishError(502, 'upstream_response_too_large');
        return;
      }
      if (!req.complete) {
        responseHeaders.connection = 'close';
        res.shouldKeepAlive = false;
      }
      res.writeHead(incoming.statusCode || 502, responseHeaders);
      let sentBytes = 0;
      incoming.on('data', (chunk) => {
        sentBytes += chunk.length;
        if (sentBytes > INGRESS_LIMITS.responseBytes) finishError(502, 'upstream_response_too_large');
      });
      incoming.once('aborted', () => finishError(502, 'upstream_incomplete_response'));
      incoming.once('error', () => finishError(502, 'upstream_unavailable'));
      incoming.pipe(res);
    });

    requestStream = new Transform({
      transform(chunk, _encoding, callback) {
        if (terminal) {
          callback();
          return;
        }
        this.bytesSeen = (this.bytesSeen || 0) + chunk.length;
        if (this.bytesSeen > INGRESS_LIMITS.bodyBytes) {
          finishError(413, 'payload_too_large');
          callback();
          return;
        }
        callback(null, chunk);
      },
    });
    requestStream.once('error', () => finishError(400, 'invalid_request_body'));
    req.pipe(requestStream).pipe(upstreamRequest);
  });

  // Reject parser errors with a small response and no parser detail or request data.
  server.on('clientError', (error, socket) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    const body = status.startsWith('431') ? '{"error":"headers_too_large"}' : '{"error":"invalid_request"}';
    socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ' +
      Buffer.byteLength(body) + '\r\n\r\n' + body);
  });
  const rejectExpectation = (_req, res) => {
    const body = makeErrorBody('expectation_failed');
    res.shouldKeepAlive = false;
    res.writeHead(417, { connection: 'close', 'cache-control': 'no-store', 'content-length': String(body.length), 'content-type': 'application/json' });
    res.end(body);
  };
  server.on('checkContinue', rejectExpectation);
  server.on('checkExpectation', rejectExpectation);
  server.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.maxHeadersCount = INGRESS_LIMITS.headerCount + 1;
  server.maxConnections = 128;
  server.requestTimeout = Math.max(1000, requestTimeoutMs);
  server.headersTimeout = Math.min(10_000, server.requestTimeout);
  server.keepAliveTimeout = 5000;
  server.on('close', () => agent.destroy());

  return { server, listenAddress, listenPort, publicHost };
}

export async function startLocalIngress(options = {}) {
  const ingress = createLocalIngressServer(options);
  await new Promise((resolve, reject) => {
    ingress.server.once('error', reject);
    ingress.server.listen(ingress.listenPort, ingress.listenAddress, resolve);
  });
  const address = ingress.server.address();
  process.stdout.write('local ingress listening on ' + address.address + ':' + address.port + ' for ' + ingress.publicHost + '\n');
  return ingress;
}

if (import.meta.main) {
  startLocalIngress().catch((error) => {
    process.stderr.write('local ingress startup failed: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
