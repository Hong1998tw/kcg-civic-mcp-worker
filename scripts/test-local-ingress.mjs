import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import {
  DEFAULT_PUBLIC_HOST,
  INGRESS_LIMITS,
  PRODUCTION_UPSTREAM,
  createLocalIngressServer,
} from './local-ingress.mjs';

const PUBLIC_HOST = DEFAULT_PUBLIC_HOST;
const PUBLIC_ORIGIN = 'https://' + PUBLIC_HOST;
const records = [];
let hangingResponseClosed;
let resolveHangingResponseClosed;
hangingResponseClosed = new Promise((resolve) => { resolveHangingResponseClosed = resolve; });

function collect(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () => resolve({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks),
    }));
  });
}

const upstream = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.once('end', () => {
    const record = {
      method: req.method,
      path: req.url,
      host: req.headers.host,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    records.push(record);

    if (req.url === '/mcp?mode=hang') {
      res.once('close', resolveHangingResponseClosed);
      return;
    }
    if (req.url === '/mcp?mode=large') {
      res.writeHead(200, {
        'content-length': String(INGRESS_LIMITS.responseBytes + 1),
        'content-type': 'application/json',
      });
      res.end();
      return;
    }
    if (req.url === '/mcp' && String(req.headers.accept || '').includes('text/event-stream')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'mcp-session-id': 'TEST-session-id',
      });
      res.write('event: message\ndata: TEST-first-event\n\n');
      setTimeout(() => res.end('event: message\ndata: TEST-second-event\n\n'), 220);
      return;
    }
    if (req.url === '/mcp') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          ok: true,
          host: req.headers.host,
          authorization: req.headers.authorization,
          origin: req.headers.origin,
          body: record.body.toString('utf8'),
        },
      }));
      return;
    }
    if (req.url.startsWith('/authorize')) {
      res.writeHead(302, {
        location: 'https://client.example/callback?code=TEST-code',
        'set-cookie': 'TEST-oauth=state; Path=/; HttpOnly; Secure',
      });
      res.end();
      return;
    }
    if (req.url === '/consent') {
      res.writeHead(303, {
        location: 'https://client.example/callback?state=TEST-state',
        'set-cookie': 'TEST-consent=cleared; Path=/; HttpOnly; Secure',
      });
      res.end();
      return;
    }
    if (req.url.startsWith('/.well-known/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, issuer: PUBLIC_ORIGIN + '/' }));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
});

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, {
  method = 'GET',
  path = '/health',
  headers = {},
  body,
  host = PUBLIC_HOST,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      agent: false,
      headers: { host, ...headers },
    }, (res) => collect(res).then(resolve, reject));
    req.once('error', reject);
    if (body === undefined) req.end();
    else req.end(body);
  });
}

function streamedRequest(port, options) {
  let resolveFirst;
  let resolveComplete;
  let rejectComplete;
  const firstChunk = new Promise((resolve) => { resolveFirst = resolve; });
  const complete = new Promise((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  const chunks = [];
  let first = true;
  const req = httpRequest({
    hostname: '127.0.0.1',
    port,
    method: options.method || 'POST',
    path: options.path || '/mcp',
    agent: false,
    headers: { host: PUBLIC_HOST, ...options.headers },
  }, (res) => {
    res.on('data', (chunk) => {
      chunks.push(chunk);
      if (first) {
        first = false;
        resolveFirst({ status: res.statusCode, headers: res.headers, at: Date.now() });
      }
    });
    res.once('error', rejectComplete);
    res.once('end', () => resolveComplete({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks),
    }));
  });
  req.once('error', rejectComplete);
  req.end(options.body);
  return { firstChunk, complete };
}

function rawRequest(port, message) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.once('connect', () => socket.write(message));
  });
}

async function reserveClosedPort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

let proxy;
let failureProxy;
try {
  const upstreamPort = await listen(upstream);
  proxy = createLocalIngressServer({
    env: {
      PUBLIC_HOST,
      LOCAL_INGRESS_UPSTREAM: PRODUCTION_UPSTREAM,
      TEST_INGRESS_SECRET: 'TEST-must-not-leave-process',
    },
    testTarget: 'http://127.0.0.1:' + upstreamPort,
    listenAddress: '127.0.0.1',
    listenPort: 0,
    requestTimeoutMs: 1000,
  });
  await new Promise((resolve, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(proxy.listenPort, proxy.listenAddress, resolve);
  });
  const proxyPort = proxy.server.address().port;

  const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const mcp = await request(proxyPort, {
    method: 'POST',
    path: '/mcp',
    headers: {
      authorization: 'Bearer TEST-client-token',
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.77',
      'x-private-test': 'TEST-private-header',
      connection: 'x-forwarded-for, x-private-test',
      cookie: 'TEST-should-not-reach-mcp=1',
    },
    body: mcpBody,
  });
  assert.equal(mcp.status, 200);
  assert.match(mcp.headers['content-type'], /application\/json/);
  assert.equal(JSON.parse(mcp.body).result.host, PUBLIC_HOST);
  assert.equal(JSON.parse(mcp.body).result.authorization, 'Bearer TEST-client-token');
  assert.equal(JSON.parse(mcp.body).result.origin, PUBLIC_ORIGIN);
  assert.equal(JSON.parse(mcp.body).result.body, mcpBody);
  const mcpRecord = records.at(-1);
  assert.equal(mcpRecord.host, PUBLIC_HOST);
  assert.equal(mcpRecord.headers['x-forwarded-for'], undefined);
  assert.equal(mcpRecord.headers['x-private-test'], undefined);
  assert.equal(mcpRecord.headers.cookie, undefined);
  assert.equal(mcpRecord.headers['test-ingress-secret'], undefined);

  const health = await request(proxyPort, { path: '/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.equal(records.at(-1).host, PUBLIC_HOST);

  const streamStart = Date.now();
  const stream = streamedRequest(proxyPort, {
    path: '/mcp',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer TEST-sse-token',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });
  const firstChunk = await Promise.race([
    stream.firstChunk,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE response was not streamed promptly')), 150)),
  ]);
  assert.equal(firstChunk.status, 200);
  assert.equal(firstChunk.headers['content-type'], 'text/event-stream');
  assert.equal(firstChunk.headers['mcp-session-id'], 'TEST-session-id');
  assert.ok(firstChunk.at - streamStart < 150, 'first SSE event must arrive before the upstream stream ends');
  const streamResult = await stream.complete;
  assert.match(streamResult.body.toString('utf8'), /TEST-first-event/);
  assert.match(streamResult.body.toString('utf8'), /TEST-second-event/);
  assert.equal(records.at(-1).headers['mcp-protocol-version'], '2025-03-26');

  const redirect = await request(proxyPort, {
    path: '/authorize?client_id=TEST-client',
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, 'https://client.example/callback?code=TEST-code');
  assert.match(redirect.headers['set-cookie'][0], /TEST-oauth=state/);

  const consentBody = 'state=TEST-state&csrf=TEST-csrf&owner_key=TEST-owner&decision=allow';
  const consent = await request(proxyPort, {
    method: 'POST',
    path: '/consent',
    headers: {
      origin: PUBLIC_ORIGIN,
      cookie: 'TEST-oauth=state',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: consentBody,
  });
  assert.equal(consent.status, 303);
  assert.equal(consent.headers.location, 'https://client.example/callback?state=TEST-state');
  assert.equal(records.at(-1).headers.origin, PUBLIC_ORIGIN);
  assert.equal(records.at(-1).headers.cookie, 'TEST-oauth=state');
  assert.equal(records.at(-1).body.toString('utf8'), consentBody);

  const metadataAlias = await request(proxyPort, { path: '/.well-known/oauth-protected-resource' });
  assert.equal(metadataAlias.status, 200);
  assert.equal(records.at(-1).path, '/.well-known/oauth-protected-resource/mcp');
  assert.equal(JSON.parse(metadataAlias.body).path, '/.well-known/oauth-protected-resource/mcp');
  assert.equal((await request(proxyPort, { path: '/.well-known/oauth-protected-resource/mcp' })).status, 200);
  assert.equal((await request(proxyPort, { path: '/.well-known/oauth-authorization-server' })).status, 200);

  assert.equal((await request(proxyPort, { path: '/health', host: 'kcg-civic-mcp.kshong.com.evil.example' })).status, 403);
  assert.equal((await request(proxyPort, { path: '/mcp/' })).status, 404);
  assert.equal((await request(proxyPort, { path: '/m%63p' })).status, 404);
  assert.equal((await request(proxyPort, { path: '/health?probe=1' })).status, 400);
  assert.equal((await request(proxyPort, { method: 'GET', path: '/token' })).status, 405);
  assert.equal((await request(proxyPort, { path: 'http://evil.example/mcp' })).status, 400);
  assert.equal((await request(proxyPort, { path: '/mcp', headers: { origin: 'https://evil.example' } })).status, 403);

  const duplicateHost = await rawRequest(proxyPort,
    'GET /health HTTP/1.1\r\nHost: ' + PUBLIC_HOST + '\r\nHost: ' + PUBLIC_HOST + '\r\nConnection: close\r\n\r\n');
  assert.match(duplicateHost, /^HTTP\/1\.1 400 /);
  const largeHeader = await rawRequest(proxyPort,
    'GET /health HTTP/1.1\r\nHost: ' + PUBLIC_HOST + '\r\nX-Oversize: ' +
    'x'.repeat(INGRESS_LIMITS.headerBytes) + '\r\nConnection: close\r\n\r\n');
  assert.match(largeHeader, /^HTTP\/1\.1 431 /);

  const beforeOversize = records.length;
  const declaredOversize = await request(proxyPort, {
    method: 'POST',
    path: '/mcp',
    headers: {
      'content-length': String(INGRESS_LIMITS.bodyBytes + 1),
      'content-type': 'application/json',
    },
  });
  assert.equal(declaredOversize.status, 413);
  assert.equal(records.length, beforeOversize);

  const chunkedOversize = await request(proxyPort, {
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(INGRESS_LIMITS.bodyBytes + 1, 0x61),
  });
  assert.equal(chunkedOversize.status, 413);
  assert.equal(records.length, beforeOversize);

  const largeResponse = await request(proxyPort, { method: 'GET', path: '/mcp?mode=large' });
  assert.equal(largeResponse.status, 502);
  assert.equal(JSON.parse(largeResponse.body).error, 'upstream_response_too_large');

  const hang = request(proxyPort, {
    method: 'POST',
    path: '/mcp?mode=hang',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","id":3}',
  });
  const timedOut = await hang;
  assert.equal(timedOut.status, 504);
  assert.equal(JSON.parse(timedOut.body).error, 'upstream_timeout');
  await Promise.race([
    hangingResponseClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out upstream socket stayed open')), 500)),
  ]);

  const refusedPort = await reserveClosedPort();
  failureProxy = createLocalIngressServer({
    env: { PUBLIC_HOST },
    testTarget: 'http://127.0.0.1:' + refusedPort,
    listenAddress: '127.0.0.1',
    listenPort: 0,
    requestTimeoutMs: 1000,
  });
  await new Promise((resolve, reject) => {
    failureProxy.server.once('error', reject);
    failureProxy.server.listen(failureProxy.listenPort, failureProxy.listenAddress, resolve);
  });
  const upstreamFailure = await request(failureProxy.server.address().port);
  assert.equal(upstreamFailure.status, 502);
  assert.equal(JSON.parse(upstreamFailure.body).error, 'upstream_unavailable');

  assert.throws(() => createLocalIngressServer({ env: {}, testTarget: 'http://example.com:8787' }), /fixed 127\.0\.0\.1/);
  assert.throws(() => createLocalIngressServer({ env: { LOCAL_INGRESS_UPSTREAM: 'http://127.0.0.1:8787' } }), /only accepts http:\/\/query:8787/);

  process.stdout.write('PASS real HTTP ingress host/path/method checks, bounded streaming, MCP JSON/SSE, OAuth redirects/forms, upstream failure and timeout\n');
} finally {
  if (failureProxy) await close(failureProxy.server);
  if (proxy) await close(proxy.server);
  await close(upstream);
}
