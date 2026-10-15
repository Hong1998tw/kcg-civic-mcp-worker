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
  const unknownNews = structuredClone(records.at(-1));
  unknownNews.id = unknownNews.data.news_id = 'city:FFFFFFFFFFFFFFF0';
  unknownNews.data.source_link = unknownNews.source_url = 'https://www.kcg.gov.tw/CityNews_Detail1.aspx?ss=FFFFFFFFFFFFFFF0';
  unknownNews.data.agency = ''; unknownNews.data.publisher_status = 'not_provided';
  await store.importSnapshot({ dataset: 'kcg-news', snapshot_id: 'TEST-publisher-not-provided', coverage: { scope: 'TEST complete source with unknown publisher', complete: true, source_total: 1006 }, records: [...records, unknownNews], raw_objects: [], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
  const agencyNews = await registry.find((tool) => tool.name === 'get_kcg_latest_news').handler({ limit: 3, agency: 'TEST' });
  assert.equal(agencyNews.status, 'partial'); assert.equal(agencyNews.meta.publisher_not_provided_count, 1);

  const meetings = Array.from({ length: 1005 }, (_, i) => {
    const id = String(10000 + i), pdf = `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/TEST.pdf`;
    return { id, title: 'TEST 議事', text: 'TEST 全文', data: { record_id: id, term: 4, date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString(), meeting_name: 'TEST 議事', pdf_url: pdf, total_pages: 1, pages: [{ page: 1, text: i === 1004 ? 'TEST 最新關鍵字' : 'TEST 舊內容' }] }, source_url: pdf, retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: rawHash };
  });
  const doc = 'https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/99999/TEST.doc';
  const unindexed = { id: '99999', title: 'TEST Word原件', text: 'TEST Word尚未索引', data: { record_id: '99999', term: 4, date: '2031-01-01', meeting_name: 'TEST Word', pages: [], total_pages: null, pdf_url: null, original_files: [{ download_url: doc, file_type: 'doc' }], original_versions: [{ source_url: doc, raw_sha256: rawHash, byte_length: raw.length, file_type: 'doc' }], content_index_status: 'unindexed_non_pdf', fulltext_complete: false, originals_complete: true }, source_url: doc, retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: rawHash };
  await store.importSnapshot({ dataset: 'kcc-meeting-records', snapshot_id: 'TEST-global-meetings-with-doc', coverage: { scope: 'TEST all original files; Word text pending', complete: false, source_total: 1006 }, records: [...meetings, unindexed], raw_objects: [], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
  const cross = await registry.find((tool) => tool.name === 'kcc_search_meeting_record_content').handler({ keyword: '最新關鍵字', limit_records: 2 });
  assert.equal(cross.status, 'partial');
  assert.equal(cross.data.records[0].record_id, '11004');
  assert.equal(cross.data.failed_records_count, 1);
  assert.equal(cross.data.failures[0].reason_code, 'SOURCE_FULLTEXT_UNAVAILABLE');
  assert.equal(cross.meta.unindexed_records, 1);
  assert.equal(cross.meta.omitted_local_records, 1004);
  const fallback = structuredClone(meetings.at(-1));
  fallback.id = '88888'; fallback.data.record_id = '88888';
  fallback.data.pdf_url = fallback.source_url = 'https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/88888/TEST.pdf';
  delete fallback.data.date; fallback.data.meeting_date = '2032-01-01'; fallback.data.pages[0].text = 'TEST 日期備援';
  await store.importSnapshot({ dataset: 'kcc-meeting-records', snapshot_id: 'TEST-meeting-date-fallback', coverage: { scope: 'TEST date fallback', complete: false, source_total: 1007 }, records: [...meetings, unindexed, fallback], raw_objects: [], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
  const newestFallback = await registry.find((tool) => tool.name === 'kcc_search_meeting_record_content').handler({ keyword: '日期備援', limit_records: 1 });
  assert.equal(newestFallback.data.records[0].record_id, '88888');
  const meetingGet = registry.find((tool) => tool.name === 'kcc_get_meeting_record');
  await assert.rejects(meetingGet.handler({ record_id: '99999' }), (error) => error.reasonCode === 'SOURCE_FULLTEXT_UNAVAILABLE');
  const exactPdf = meetings.at(-1).data.pdf_url;
  assert.equal((await meetingGet.handler({ record_id: '11004', pdf_url: exactPdf })).data.total_pages, 1);
  await assert.rejects(meetingGet.handler({ record_id: '11004', pdf_url: exactPdf.replace('11004', '11003') }), (error) => error.reasonCode === 'SOURCE_ID_MISMATCH');
  const keywordSearch = await registry.find((tool) => tool.name === 'search_kcg_council_interpellations').handler({ keyword: '不存在的TEST詞' });
  assert.equal(keywordSearch.status, 'partial'); assert.equal(keywordSearch.meta.unindexed_records, 1);

  const lawUrl = 'https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL001565';
  const repeal = { id: 'GL001565', title: 'TEST 廢止要點', text: 'TEST 自某日起停止適用', data: { law_id: 'GL001565', law_name: 'TEST 廢止要點', category: 'TEST', published_at: '2018-12-31', official_url: lawUrl, articles: [], law_record_type: 'repeal_notice', articles_unavailable: true, fulltext_complete: false, notice_text: 'TEST 自某日起停止適用' }, source_url: lawUrl, retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: rawHash };
  await store.importSnapshot({ dataset: 'kcg-laws', snapshot_id: 'TEST-repeal-not-fulltext', coverage: { scope: 'TEST current official notice', complete: true, source_total: 1 }, records: [repeal], raw_objects: [], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
  const lawSearch = await registry.find((tool) => tool.name === 'search_kcg_laws').handler({ keyword: '廢止要點' });
  assert.equal(lawSearch.data[0].law_record_type, 'repeal_notice'); assert.equal(lawSearch.data[0].articles_unavailable, true);
  await assert.rejects(registry.find((tool) => tool.name === 'get_kcg_law_detail').handler({ law_id: 'GL001565' }), (error) => error.reasonCode === 'SOURCE_FULLTEXT_UNAVAILABLE');

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
  console.log('PASS global news/meeting top-K beyond 1000, Word original and repeal notice honesty, exact PDF URL, encrypted detail raw identity, conflicting identity rejection, cache tamper/mtime restoration');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
