import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalStore } from '../src/local/store.mjs';
import { buildLocal } from './build-local.mjs';

const temp = await mkdtemp(path.join(tmpdir(), 'TEST-native-oauth-integration-'));
let app;
try {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const issuer = `http://127.0.0.1:${port}`;
  const dataRoot = path.join(temp, 'data');
  const store = new LocalStore(dataRoot, { readOnly: false });
  store.close();
  const owner = 'TEST-owner-' + 'a'.repeat(64);
  const bearer = 'TEST-bearer-' + 'b'.repeat(64);
  await writeFile(path.join(temp, 'owner'), owner, { mode: 0o600 });
  await writeFile(path.join(temp, 'bearer'), bearer, { mode: 0o600 });
  const buildDir = path.join(temp, 'build');
  const { outfile } = await buildLocal({ outdir: buildDir });
  await symlink(new URL('../node_modules', import.meta.url).pathname, path.join(buildDir, 'node_modules'), 'dir');
  const { startLocalServer } = await import(pathToFileURL(outfile).href);
  app = await startLocalServer({ PORT: String(port), BIND_HOST: '127.0.0.1', KCG_CIVIC_DATA_DIR: dataRoot,
    OAUTH_ISSUER_URL: issuer, OAUTH_DATA_ROOT: path.join(temp, 'auth'), OAUTH_OWNER_LOGIN_KEY_FILE: path.join(temp, 'owner'),
    MCP_ACCESS_KEY_FILE: path.join(temp, 'bearer'), MCP_ACCESS_KEY: owner, LOCAL_OAUTH_ALLOW_LOOPBACK_HTTP: 'true' });
  const resource = `${issuer}/mcp`;
  const metadata = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, issuer + '/');
  assert.equal((await fetch(`${issuer}/AUTHORIZE`)).status, 404);
  assert.equal((await fetch(`${issuer}/authorize/`)).status, 404);
  const unauth = await fetch(resource, { method: 'POST' });
  assert.equal(unauth.status, 401);
  assert.ok(unauth.headers.get('www-authenticate').includes('resource_metadata='));
  assert.equal((await fetch(resource, { method: 'POST', headers: { Authorization: `Bearer ${owner}` } })).status, 401);
  assert.equal((await fetch(resource, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Origin: 'https://evil.example' } })).status, 403);
  const callback = 'http://127.0.0.1:45123/TEST-callback';
  const registration = await fetch(`${issuer}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'TEST actual local server', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();
  const verifier = 'v'.repeat(64);
  const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource, scope: 'mcp:read offline_access', state: 'TEST-state' });
  const form = await fetch(`${issuer}/authorize?${params}`, { redirect: 'manual' });
  assert.equal(form.status, 200);
  const html = await form.text();
  const fields = Object.fromEntries(['state', 'csrf'].map((name) => [name, html.match(new RegExp(`name="${name}" value="([^"]+)"`))[1]]));
  const consent = await fetch(`${issuer}/consent`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: issuer, Cookie: form.headers.get('set-cookie').split(';')[0] }, body: new URLSearchParams({ ...fields, owner_key: owner, decision: 'allow' }) });
  assert.equal(consent.status, 303);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const exchange = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: callback, resource }) });
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  const client = new Client({ name: 'TEST integrated SDK', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 21);
    assert.equal(catalog.tools[0]._meta.securitySchemes[0].type, 'oauth2');
    const unavailable = await client.callTool({ name: 'get_kcg_budget_summary', arguments: { year: 115 } });
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.structuredContent.reason_code, 'LOCAL_DATA_UNAVAILABLE');
  } finally { await client.close(); }
  console.log('PASS integrated NAS server OAuth body routing, exact endpoints, Host/Origin, no env Bearer bypass, S256, actual SDK catalog/call');
} finally { if (app) await app.close(); await rm(temp, { recursive: true, force: true }); }
