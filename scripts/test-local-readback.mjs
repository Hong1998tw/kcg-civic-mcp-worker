import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { LocalStore } from '../src/local/store.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'TEST-local-readback-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  const built = await build({ entryPoints: [new URL('../src/local/registry.mjs', import.meta.url).pathname], bundle: true, platform: 'node', target: 'node24', format: 'cjs', write: false, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const store = new LocalStore(root, { readOnly: false });
  const raw = Buffer.from('TEST synthetic source only');
  const rawHash = sha(raw);
  const records = Array.from({ length: 1005 }, (_, i) => {
    const native = (i + 1).toString(16).padStart(16, '0');
    const id = `messages:${native}`;
    return { id, title: `TEST 消息${i}`, text: 'TEST 合成全文', data: { test_fixture: true, news_id: id, title: `TEST 消息${i}`, agency: 'TEST', category: 'TEST', published_at: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString(), content_summary: 'TEST', source_link: `https://www.kcg.gov.tw/News_Content.aspx?s=${native}` }, source_url: `https://www.kcg.gov.tw/News_Content.aspx?s=${native}`, retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: rawHash };
  });
  await store.importSnapshot({ dataset: 'kcg-news', snapshot_id: 'TEST-global-sort-v1', coverage: { scope: 'TEST complete fixture', complete: true, source_total: records.length }, records, raw_objects: [{ sha256: rawHash, bytes_base64: raw.toString('base64') }], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
  const ordered = await store.queryRecords('kcg-news', { limit: 3, orderBy: { field: 'published_at', descending: true } });
  assert.equal(ordered.records[0].id, records.at(-1).id);
  assert.equal(ordered.local_match_count, 1005);
  assert.equal(ordered.order_by.scope, 'entire_verified_snapshot');
  const registry = module.exports.createLocalRegistry(store);
  const latest = await registry.find((tool) => tool.name === 'get_kcg_latest_news').handler({ limit: 3 });
  assert.equal(latest.data[0].news_id, records.at(-1).id);

  const detailUrl = 'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=DEADBEEF1234ABCD&ct=TEST';
  const detailHtml = Buffer.from('<input name="ctl00$ContentPlaceHolder1$uscAttachment$hidDataSN" id="ContentPlaceHolder1_uscAttachment_hidDataSN" value="100"><input name="ctl00$ContentPlaceHolder1$uscAttachment$hidDataType" id="ContentPlaceHolder1_uscAttachment_hidDataType" value="1">');
  const detailHash = sha(detailHtml);
  const detail = { id: '100', title: 'TEST 提案', text: 'TEST 內容', data: { test_fixture: true, proposal_sn: '100', subject: 'TEST 提案', detail_url: detailUrl }, source_url: detailUrl, retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: detailHash };
  await store.importSnapshot({ dataset: 'kcc-proposal-details', snapshot_id: 'TEST-encrypted-detail', coverage: { scope: 'TEST', complete: true, source_total: 1 }, records: [detail], raw_objects: [{ sha256: detailHash, bytes_base64: detailHtml.toString('base64') }], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
  const get = registry.find((tool) => tool.name === 'kcc_get_proposal');
  const valid = await get.handler({ proposal_sn: '100' });
  assert.equal(valid.data.proposal_sn, '100');
  const rawPath = path.join(root, 'raw', 'sha256', detailHash.slice(0, 2), detailHash);
  const originalTime = fs.statSync(rawPath).mtime;
  fs.writeFileSync(rawPath, detailHtml.toString().replace('value="100"', 'value="999"'));
  fs.utimesSync(rawPath, originalTime, originalTime);
  await assert.rejects(get.handler({ proposal_sn: '100' }), (error) => error.reasonCode === 'SNAPSHOT_UNVERIFIED');
  fs.writeFileSync(rawPath, detailHtml);
  assert.deepEqual(await store.readRawObject(detailHash), detailHtml);

  const conflict = Buffer.from(detailHtml + '<input name="ctl00$ContentPlaceHolder1$hidProposalSN" id="ContentPlaceHolder1_hidProposalSN" value="999">');
  const conflictHash = sha(conflict);
  await store.importSnapshot({ dataset: 'kcc-proposal-details', snapshot_id: 'TEST-conflicting-detail', coverage: { scope: 'TEST', complete: true, source_total: 1 }, records: [{ ...detail, raw_sha256: conflictHash }], raw_objects: [{ sha256: conflictHash, bytes_base64: conflict.toString('base64') }], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
  await assert.rejects(get.handler({ proposal_sn: '100' }), (error) => error.reasonCode === 'SOURCE_ID_MISMATCH');
  store.close();
  console.log('PASS full-snapshot top-K beyond 1000, encrypted detail raw identity, conflicting identity rejection, cache tamper/mtime restoration');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
