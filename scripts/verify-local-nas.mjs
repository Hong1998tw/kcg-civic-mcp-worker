import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('http://127.0.0.1:8787/mcp');
const secretPath = process.env.MCP_ACCESS_KEY_FILE;
if (!secretPath) throw new Error('MOUNTED_SECRET_REQUIRED');
const key = fs.readFileSync(secretPath, 'utf8').trim();
const health = await fetch(new URL('/health', url));
assert.equal(health.status, 200);
const unauthenticated = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(unauthenticated.status, 401);
const rejected = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer TEST_invalid_token' }, body: '{}' });
assert.equal(rejected.status, 401);
const client = new Client({ name: 'nas-local-native-verifier', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 21);
  const budget = await client.callTool({ name: 'get_kcg_budget_summary', arguments: { year: 115 } });
  assert.notEqual(budget.isError, true);
  assert.ok(['partial', 'success'].includes(budget.structuredContent?.status));
  assert.equal(budget.structuredContent.data.year, 115);
  assert.ok(Number.isFinite(budget.structuredContent.data.agency_count));
  let proposals = null;
  if (process.env.VERIFY_PROPOSALS === 'true') {
    const result = await client.callTool({ name: 'kcc_search_proposals', arguments: { period: '07', session: '0704', keyword: '道路' } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'partial');
    assert.ok(result.structuredContent.data.returned_count > 0);
    assert.notEqual(result.structuredContent.data.is_complete, true);
    proposals = result.structuredContent;
  }
  const missing = await client.callTool({ name: 'search_kcg_laws', arguments: { keyword: 'TEST_尚未收錄' } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.status, 'error');
  console.log(JSON.stringify({
    status: 'PASS', checked_at: new Date().toISOString(), node_version: process.version,
    auth_positive: 'PASS', auth_negative: 'PASS', tool_count: catalog.tools.length,
    budget: budget.structuredContent, proposals, unavailable_dataset_reason: missing.structuredContent.reason_code,
    verification_scope: 'NAS private runtime only; full corpus and public client cutover are separate gates',
  }));
} finally { await client.close(); }
