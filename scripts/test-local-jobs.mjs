import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { processOne, validateRequest, verifyCollectorReceipt, dependencyReady, readCollectorCommit, collectionAdvanced } from './local-job-worker.mjs';
import { LocalStore } from '../src/local/store.mjs';
import { packKccV2Record } from '../src/local/kcc-payload.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'TEST-kcg-jobs-'));
const previousEnrichmentEnabled = process.env.KCG_ENRICHMENT_ENABLED;
try {
  const queue = path.join(root, 'queue');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(queue, 'requests'), { recursive: true });
  const id = crypto.createHash('sha256').update('health:TEST-health-v1').digest('hex');
  const request = { schema_version: 1, job_id: id, profile: 'health', idempotency_key: 'TEST-health-v1', requested_at: new Date().toISOString() };
  assert.equal(validateRequest(request, id + '.json').job_id, id);
  assert.throws(() => validateRequest({ ...request, profile: '../../bad' }, id + '.json'));
  assert.throws(() => validateRequest({ ...request, url: 'http://localhost/' }, id + '.json'));
  fs.writeFileSync(path.join(queue, 'requests', id + '.json'), JSON.stringify(request));
  const first = await processOne(queue, data);
  assert.equal(first.status, 'succeeded');
  assert.equal(first.health.status, 'PASS');
  assert.equal(await processOne(queue, data), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(queue, 'receipts', id + '.json'))).job_id, id);
  assert.equal(verifyCollectorReceipt({ profile: 'budget-115', status: 'pending', dry_run: true }, 'budget-115', 0), false);
  const sdk = fs.readFileSync(new URL('../n8n/kcg-civic-00-health.ts', import.meta.url), 'utf8');
  const literal = sdk.match(/jsCode: ("(?:[^"\\]|\\.)*")/)[1];
  const code = JSON.parse(literal).replace("'/data/storage/kcg-civic-jobs'", JSON.stringify(queue));
  const executeCode = new (Object.getPrototypeOf(async function () {}).constructor)('require', '$execution', code);
  const pending = executeCode(createRequire(import.meta.url), { id: 'TEST-workflow' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const race = await Promise.all([processOne(queue, data), processOne(queue, data)]);
  assert.equal(race.filter(Boolean).length, 1);
  const result = await pending;
  assert.equal(result[0].json.status, 'succeeded');
  assert.equal(result[0].json.n8n_execution_id, 'TEST-workflow');
  const badId = 'a'.repeat(64);
  fs.symlinkSync('/etc/hosts', path.join(queue, 'requests', badId + '.json'));
  const bad = await processOne(queue, data);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.reason_code, 'JOB_FILE_INVALID');
  const symlinkQueue = path.join(root, 'symlink-queue');
  fs.mkdirSync(symlinkQueue);
  fs.symlinkSync(path.join(queue, 'receipts'), path.join(symlinkQueue, 'receipts'));
  await assert.rejects(() => processOne(symlinkQueue, data), /SYMLINK|INVALID/);
  const store = new LocalStore(data, { readOnly: false });
  const bytes = Buffer.from('TEST dependency raw');
  const rawHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const input = { dataset: 'kcc-proposals', snapshot_id: 'TEST-dependency-v1', coverage: { scope: 'TEST complete', complete: true, source_total: 1 }, records: [{ id: '100', title: 'TEST', text: 'TEST', data: { proposal_sn: '100', test_fixture: true }, source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx', retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: rawHash }], raw_objects: [{ sha256: rawHash, bytes_base64: bytes.toString('base64') }], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' };
  const dependencyReceipt = await store.importSnapshot(input);
  const receiptFile = path.join(queue, 'receipts', 'b'.repeat(64) + '.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ profile: 'kcc-proposals-full', status: 'succeeded', store_readback: dependencyReceipt }));
  assert.equal(await dependencyReady(queue, 'kcc-proposals-full', data), true);
  await store.importSnapshot({ ...input, snapshot_id: 'TEST-dependency-v2', coverage: { scope: 'TEST next run partial', complete: false, source_total: 2 } });
  assert.equal(await dependencyReady(queue, 'kcc-proposals-full', data), false);
  const completeProposalReceipt = await store.importSnapshot({ ...input, snapshot_id: 'TEST-dependency-v3' });
  assert.equal(await dependencyReady(queue, 'kcc-proposals-full', data), false);
  fs.writeFileSync(receiptFile, JSON.stringify({ profile: 'kcc-proposals-full', status: 'succeeded', store_readback: completeProposalReceipt }));
  assert.equal(await dependencyReady(queue, 'kcc-proposals-full', data), true);

  const meetingBytes = Buffer.from('TEST meeting dependency raw');
  const meetingHash = crypto.createHash('sha256').update(meetingBytes).digest('hex');
  const meetingInput = {
    dataset: 'kcc-meetings',
    snapshot_id: 'TEST-meetings-complete-v1',
    coverage: { scope: 'TEST complete meeting母集', complete: true, source_total: 1 },
    records: [{
      id: 'M001',
      title: 'TEST meeting',
      text: 'TEST meeting',
      data: { record_id: 'M001', test_fixture: true },
      source_url: 'https://cissearch.kcc.gov.tw/System/Meeting/Default.aspx',
      retrieved_at: '2026-10-15T00:00:00Z',
      raw_sha256: meetingHash,
    }],
    raw_objects: [{ sha256: meetingHash, bytes_base64: meetingBytes.toString('base64') }],
    parser_version: 'TEST',
    validator_version: 'TEST',
    validation_status: 'passed',
  };
  const completeMeetingReceipt = await store.importSnapshot(meetingInput);
  fs.writeFileSync(path.join(queue, 'receipts', 'c'.repeat(64) + '.json'),
    JSON.stringify({ profile: 'kcc-meetings-full', status: 'succeeded', store_readback: completeMeetingReceipt }));
  assert.equal(await dependencyReady(queue, 'kcc-meetings-full', data), true);
  assert.equal((await readCollectorCommit(data, { dataset: 'kcc-meetings', record_count: 1, receipt: completeMeetingReceipt }, 'kcc-meetings-full')).release.snapshot_id, completeMeetingReceipt.snapshot_id);
  const derivedBytes = Buffer.from('TEST original detail');
  const derivedSha = crypto.createHash('sha256').update(derivedBytes).digest('hex');
  await store.putRawObject({ sha256: derivedSha, bytes_base64: derivedBytes.toString('base64') });
  const v2Receipts = {};
  for (const dataset of ['kcc-proposal-details', 'kcc-proposal-attachments']) {
    const record = { id: '123', title: 'TEST detail', text: 'TEST body', data: { proposal_id: '123', title: 'TEST detail', content: 'TEST body', attachments: [] }, source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?id=123', retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: derivedSha };
    const packed = await packKccV2Record(store.derivedStore, { dataset, record });
    v2Receipts[dataset] = await store.importV2({ schema_version: 'local-snapshot-v2', dataset, snapshot_id: 'TEST-worker-v2-' + dataset, coverage: { scope: 'TEST', complete: true, source_total: 1 }, parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed', records: [packed.descriptor] });
  }
  const publishedResult = { dataset: 'kcc-proposal-details', record_count: 1, receipt: v2Receipts['kcc-proposal-details'], receipts: v2Receipts };
  const checked = await readCollectorCommit(data, publishedResult, 'kcc-proposal-details');
  assert.equal(checked.release.snapshot_id, publishedResult.receipt.snapshot_id);
  assert.equal(Object.keys(checked.releases).length, 2, 'both detail datasets need native readback');
  await assert.rejects(() => readCollectorCommit(data, { ...publishedResult, receipts: {} }, 'kcc-proposal-details'), /COMMIT_READBACK_MISMATCH/);
  const changedReceipts = { ...v2Receipts, 'kcc-proposal-attachments': { ...v2Receipts['kcc-proposal-attachments'], manifest_sha256: 'f'.repeat(64) } };
  await assert.rejects(() => readCollectorCommit(data, { ...publishedResult, receipts: changedReceipts }, 'kcc-proposal-details'), /COMMIT_READBACK_MISMATCH/);
  const priorSegment = { collector: { attempted: 0, record_count: 1, prepared_count: 4, progress: { prepared_cursor: 4, committed_cursor: 1 } } };
  assert.equal(collectionAdvanced(priorSegment, { collector: { ...priorSegment.collector, prepared_count: 5 } }), true, 'unpublished preparation is forward progress');
  assert.equal(collectionAdvanced(priorSegment, structuredClone(priorSegment)), false);
  assert.equal(collectionAdvanced(priorSegment, { collector: { ...priorSegment.collector, attempted: 1 } }), true);
  store.close();

  process.env.KCG_ENRICHMENT_ENABLED = 'false';
  const enqueue = (profile, idempotencyKey) => {
    const jobId = crypto.createHash('sha256').update(profile + ':' + idempotencyKey).digest('hex');
    const value = { schema_version: 1, job_id: jobId, profile, idempotency_key: idempotencyKey, requested_at: new Date().toISOString() };
    fs.writeFileSync(path.join(queue, 'requests', jobId + '.json'), JSON.stringify(value));
    return value;
  };
  const heldRequests = [
    enqueue('kcc-proposal-details', 'TEST-capacity-details-v1'),
    enqueue('kcc-meeting-records', 'TEST-capacity-meeting-records-v1'),
  ];
  const healthRequest = enqueue('health', 'TEST-health-during-capacity-hold-v1');
  let healthDuringHold;
  const allHoldsRecorded = () => heldRequests.every((held) =>
    fs.existsSync(path.join(queue, 'progress', held.job_id + '.json')));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await processOne(queue, data);
    if (result?.job_id === healthRequest.job_id) healthDuringHold = result;
    if (healthDuringHold && allHoldsRecorded()) break;
    if (result === null && allHoldsRecorded()) break;
  }
  assert.equal(healthDuringHold?.status, 'succeeded');
  assert.equal(healthDuringHold.health.status, 'PASS');
  for (const held of heldRequests) {
    const progressPath = path.join(queue, 'progress', held.job_id + '.json');
    const processingPath = path.join(queue, 'processing', held.job_id + '.json');
    const terminalPath = path.join(queue, 'receipts', held.job_id + '.json');
    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    const activeRequest = JSON.parse(fs.readFileSync(processingPath, 'utf8'));
    assert.equal(progress.status, 'held_capacity_review');
    assert.equal(progress.reason_code, 'ENRICHMENT_STORAGE_UPGRADE_REQUIRED');
    assert.equal(progress.job_id, held.job_id);
    assert.equal(progress.idempotency_key, held.idempotency_key);
    assert.deepEqual(activeRequest, held);
    assert.equal(fs.existsSync(path.join(queue, 'requests', held.job_id + '.json')), false);
    assert.equal(fs.existsSync(terminalPath), false);
  }
  console.log('PASS local jobs: native complete-parent checks, capacity hold preserves request identity without terminal receipt, health job continues, prior queue/store cases');
} finally {
  if (previousEnrichmentEnabled === undefined) delete process.env.KCG_ENRICHMENT_ENABLED;
  else process.env.KCG_ENRICHMENT_ENABLED = previousEnrichmentEnabled;
  fs.rmSync(root, { recursive: true, force: true });
}
