// Live acceptance test. Real secrets enter only stdin and stay in memory.
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const issuer = 'https://kcg-civic-mcp.kshong.com';
const resource = `${issuer}/mcp`;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
let stage = 'input';
const expect = (condition) => { if (!condition) throw new Error('ACCEPTANCE_CHECK_FAILED'); };
let dispatcher;
const publicDns = process.argv.includes('--public-dns');
if (publicDns) {
  // A new record can remain negatively cached in the LAN resolver. This
  // process-only diagnostic preserves hostname/SNI/certificate validation.
  const { Agent } = await import('undici');
  const { Resolver } = await import('node:dns/promises');
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  dispatcher = new Agent({ connect: { lookup: (hostname, options, callback) => {
    if (hostname !== 'kcg-civic-mcp.kshong.com') { callback(new Error('UNEXPECTED_VERIFICATION_HOST')); return; }
    resolver.resolve4(hostname).then((addresses) => {
      if (!addresses.length) throw new Error('NO_PUBLIC_DNS_ANSWER');
      if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
      else callback(null, addresses[0], 4);
    }).catch(() => callback(new Error('PUBLIC_DNS_LOOKUP_FAILED')));
  } } });
}
const fixedFetch = (input, options = {}) => {
  expect(new URL(input instanceof Request ? input.url : input).origin === issuer);
  return fetch(input, { ...options, redirect: 'manual', signal: options.signal || AbortSignal.timeout(15000), ...(dispatcher ? { dispatcher } : {}) });
};
const request = (url, options = {}) => fixedFetch(url, options);
const postForm = (pathname, value, extra = {}) => request(issuer + pathname, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams(value) });
async function sdk(token, business = false) {
  const client = new Client({ name: 'NAS public acceptance verifier', version: '1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { fetch: fixedFetch, requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const catalog = await client.listTools(); expect(catalog.tools.length === 21);
    expect(catalog.tools.every((tool) => tool._meta?.securitySchemes?.[0]?.type === 'oauth2'));
    const evidence = { tool_count: catalog.tools.length };
    if (business) {
      const budget = await client.callTool({ name: 'get_kcg_budget_summary', arguments: { year: 115 } });
      expect(budget.isError !== true && budget.structuredContent?.data?.year === 115);
      const news = await client.callTool({ name: 'get_kcg_latest_news', arguments: { limit: 3 } });
      expect(news.isError !== true && ['partial', 'success'].includes(news.structuredContent?.status));
      evidence.budget_status = budget.structuredContent.status;
      evidence.news_status = news.structuredContent.status;
    }
    return evidence;
  } finally { await client.close().catch(() => {}); }
}

try {
  const { value } = await lines.next();
  const secrets = JSON.parse(value);
  expect(typeof secrets.owner === 'string' && typeof secrets.bearer === 'string' && secrets.owner !== secrets.bearer);
  stage = 'TLS_discovery_and_negative_auth';
  const metadataResponse = await request(issuer + '/.well-known/oauth-authorization-server'); expect(metadataResponse.status === 200);
  const metadata = await metadataResponse.json();
  expect(metadata.issuer === issuer + '/' && metadata.authorization_endpoint === issuer + '/authorize' && metadata.token_endpoint === issuer + '/token');
  const protectedMetadata = await (await request(issuer + '/.well-known/oauth-protected-resource/mcp')).json();
  expect(protectedMetadata.resource === resource);
  const unauth = await request(resource, { method: 'POST' }); expect(unauth.status === 401 && unauth.headers.get('www-authenticate')?.includes('resource_metadata='));
  expect((await request(resource, { method: 'POST', headers: { Authorization: `Bearer ${secrets.owner}` } })).status === 401);
  expect((await request(resource, { method: 'POST', headers: { Authorization: `Bearer ${secrets.bearer}`, Origin: 'https://invalid.example' } })).status === 403);
  expect((await request(issuer + '/authorize/')).status === 404);
  stage = 'DCR_PKCE_owner_consent';
  const callback = 'http://127.0.0.1:45123/NAS-acceptance-callback';
  const registered = await request(issuer + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'NAS public acceptance verifier', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  expect(registered.status === 201);
  const { client_id: clientId } = await registered.json(); expect(typeof clientId === 'string');
  const verifier = randomBytes(48).toString('base64url');
  const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource, scope: 'mcp:read offline_access', state: 'NAS-acceptance' });
  const form = await request(`${issuer}/authorize?${params}`); expect(form.status === 200);
  const cookie = form.headers.get('set-cookie'); expect(cookie?.startsWith('__Host-kcg-oauth=') && cookie.includes('Secure') && cookie.includes('HttpOnly'));
  const html = await form.text();
  const fields = Object.fromEntries(['state', 'csrf'].map((name) => [name, html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1]]));
  expect(fields.state && fields.csrf);
  const headers = { Origin: issuer, Cookie: cookie.split(';')[0] };
  const badConsent = await postForm('/consent', { ...fields, owner_key: secrets.owner, decision: 'allow' }, { ...headers, Origin: 'https://invalid.example' }); expect(badConsent.status === 403);
  const consent = await postForm('/consent', { ...fields, owner_key: secrets.owner, decision: 'allow' }, headers); expect(consent.status === 303);
  const location = new URL(consent.headers.get('location')); expect(location.origin === 'http://127.0.0.1:45123' && location.pathname === '/NAS-acceptance-callback');
  const code = location.searchParams.get('code'); expect(code);
  const exchange = await postForm('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: callback, resource }); expect(exchange.status === 200);
  const tokens = await exchange.json(); expect(tokens.access_token && tokens.refresh_token);
  stage = 'public_SDK_business';
  const business = await sdk(tokens.access_token, true);
  await sdk(secrets.bearer);
  process.stdout.write(JSON.stringify({ phase: 'awaiting_query_restart', status: 'PASS', tls: true, dns_mode: publicDns ? 'process_only_public_resolver' : 'system_resolver', oauth: true, bearer_compatibility: true, negative_auth: true, consent_csrf: true, ...business }) + '\n');
  // Parent restarts only this task's query container, leaving ingestion running.
  stage = 'restart_signal'; const command = await lines.next(); expect(command.value === 'query_restarted');
  stage = 'persistent_access_and_refresh';
  await sdk(tokens.access_token);
  const refresh = await postForm('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }); expect(refresh.status === 200);
  const rotated = await refresh.json(); expect(rotated.refresh_token && rotated.refresh_token !== tokens.refresh_token);
  await sdk(rotated.access_token);
  const replay = await postForm('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }); expect(replay.status === 400);
  expect((await request(resource, { method: 'POST', headers: { Authorization: `Bearer ${rotated.access_token}` } })).status === 401);
  process.stdout.write(JSON.stringify({ phase: 'complete', status: 'PASS', checked_at: new Date().toISOString(), restart_persistence: true, refresh_rotation_and_replay_revocation: true, secrets_logged: false, scope: 'Public HTTPS and official SDK; actual ChatGPT client remains a separate gate' }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ status: 'FAIL', stage, secrets_logged: false }) + '\n');
  process.exitCode = 1;
} finally { process.stdin.destroy(); await dispatcher?.close(); }
