import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { COLLECTOR_TIMEOUT_MS, processOne, runCollector, validateRequest, verifyCollectorReceipt, dependencyReady, readCollectorCommit, collectionAdvanced } from './local-job-worker.mjs';
import { LocalStore } from '../src/local/store.mjs';
import { packKccV2Record } from '../src/local/kcc-payload.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'TEST-kcg-jobs-'));
const previousEnrichmentEnabled = process.env.KCG_ENRICHMENT_ENABLED;
try {
  const queue = path.join(root, 'queue');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(queue, 'requests'), { recursive: true });
  assert.equal(COLLECTOR_TIMEOUT_MS, 900000, 'collector process deadline is the fixed 900-second worker budget');
  const timeoutChild = new EventEmitter();
  timeoutChild.stdout = new EventEmitter(); timeoutChild.stderr = new EventEmitter();
  let timeoutCallback, observedTimeoutMs, killedWith, timerCleared = false;
  timeoutChild.kill = (signal) => { killedWith = signal; setImmediate(() => timeoutChild.emit('close', null, signal)); return true; };
  const timeoutScript = path.join(root, 'timeout-fixture.mjs');
  const timeoutPromise = runCollector('kcg-news', data, {
    collectorScript: timeoutScript,
    spawnImpl: (command, args) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [timeoutScript, '--profile', 'kcg-news', '--root', data, '--run']);
      return timeoutChild;
    },
    setTimeoutImpl: (callback, delay) => { timeoutCallback = callback; observedTimeoutMs = delay; return 'TEST-timer'; },
    clearTimeoutImpl: (timer) => { assert.equal(timer, 'TEST-timer'); timerCleared = true; },
  });
  assert.equal(observedTimeoutMs, COLLECTOR_TIMEOUT_MS, 'runCollector arms the fixed real budget');
  timeoutCallback();
  const timeoutOutcome = await timeoutPromise;
  assert.equal(killedWith, 'SIGKILL');
  assert.equal(timerCleared, true);
  assert.deepEqual(timeoutOutcome, { status: 'outcome_unknown', reason_code: 'COLLECTOR_RECONCILIATION_REQUIRED' }, 'timeout kill still requires reconciliation');
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
  const newsProgress = { collector: { attempted: 0, record_count: 0, prepared_count: 0, index_round: { phase: 'indexing', page_count: 0, verification_scopes: [] } } };
  assert.equal(collectionAdvanced(newsProgress, { collector: { ...newsProgress.collector, index_round: { ...newsProgress.collector.index_round, page_count: 1 } } }), true, 'news index page is forward progress');
  assert.equal(collectionAdvanced(newsProgress, { collector: { ...newsProgress.collector, index_round: { ...newsProgress.collector.index_round, phase: 'verifying' } } }), true, 'news round phase is forward progress');
  assert.equal(collectionAdvanced(newsProgress, { collector: { ...newsProgress.collector, index_round: { ...newsProgress.collector.index_round, verification_scopes: ['messages'] } } }), true, 'news home verification is forward progress');
  assert.equal(collectionAdvanced(newsProgress, structuredClone(newsProgress)), false, 'unchanged news round is stalled');
  assert.equal(collectionAdvanced(newsProgress, { collector: { ...newsProgress.collector } }), false, 'missing news progress metadata is not advancement');

  const priorNewsBytes = Buffer.from('TEST worker prior news raw object');
  const priorNewsSha = crypto.createHash('sha256').update(priorNewsBytes).digest('hex');
  const priorNewsRecords = Array.from({ length: 180 }, (_, index) => {
    const nativeId = `messages:${index.toString(16).padStart(16, '0')}`;
    return { id: nativeId, title: `TEST prior news ${index}`, text: `TEST prior news body ${index}`,
      data: { news_id: nativeId, source_kind: 'messages', content: `TEST prior news body ${index}` },
      source_url: `https://www.kcg.gov.tw/News_Content.aspx?s=${index.toString(16).padStart(16, '0')}`, retrieved_at: '2026-10-15T00:00:00.000Z', raw_sha256: priorNewsSha };
  });
  const priorNewsReceipt = await store.importSnapshot({ dataset: 'kcg-news', snapshot_id: 'TEST-worker-prior-news-v1',
    coverage: { scope: 'TEST prior partial news release', complete: false, source_total: 2336 }, records: priorNewsRecords,
    raw_objects: [{ sha256: priorNewsSha, bytes_base64: priorNewsBytes.toString('base64') }],
    parser_version: 'official-html-2026-10-15-v5', validator_version: 'official-identity-count-v1', validation_status: 'passed' });
  assert.equal(priorNewsReceipt.record_count, 180);
  const newsQueue = path.join(root, 'news-queue'), newsRequests = path.join(newsQueue, 'requests'), newsReceipts = path.join(newsQueue, 'receipts');
  fs.mkdirSync(newsRequests, { recursive: true }); fs.mkdirSync(newsReceipts, { recursive: true });
  const newsJobId = crypto.createHash('sha256').update('kcg-news:TEST-held-index-round-v1').digest('hex');
  const newsJob = { schema_version: 1, job_id: newsJobId, profile: 'kcg-news', idempotency_key: 'TEST-held-index-round-v1', requested_at: new Date().toISOString() };
  fs.writeFileSync(path.join(newsRequests, newsJobId + '.json'), JSON.stringify(newsJob));
  const roundId = crypto.randomUUID(), runId = crypto.randomUUID();
  const checkpointDirectory = path.join(data, 'staging', 'official', 'kcg-news');
  const checkpointPath = path.join(checkpointDirectory, 'checkpoint.json');
  fs.mkdirSync(checkpointDirectory, { recursive: true });
  const roundState = { version: 'official-html-2026-10-15-v5', profile: 'kcg-news', run_id: runId, download_attachments: true,
    index_round_version: 1, index_round_id: roundId, index_round_attempt: 1, index_round_phase: 'indexing',
    index_round_pages: [], index_round_verifications: {}, index_round_frozen_at: null, index_round_digest: null,
    prior_published_count: 180, records: [], queues: [{ type: 'index', scope: 'messages' }], captures: {}, entries: {}, finished_scopes: [] };
  const checkpointEnvelope = { sha256: crypto.createHash('sha256').update(JSON.stringify(roundState)).digest('hex'), state: roundState };
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpointEnvelope));
  const heldCollectorResult = { profile: 'kcg-news', dataset: 'kcg-news', status: 'paused', continuation_required: true, dry_run: false,
    basic_validation: 'passed', failed: 0, error_code: null, commit_state: 'held-for-prior-release', publication_deferred: true,
    receipt: null, run_id: runId, record_count: 0, checkpoint_path: checkpointPath,
    index_round: { version: 1, id: roundId, attempt: 1, phase: 'indexing', digest: null, page_count: 0, verification_scopes: [], prior_published_count: 180 } };
  const collectorScript = path.join(root, 'collector-fixture.mjs');
  const writeCollectorScript = (value) => fs.writeFileSync(collectorScript, `console.log(${JSON.stringify(JSON.stringify(value))});\n`);
  writeCollectorScript(heldCollectorResult);
  const held = await processOne(newsQueue, data, { collectorScript });
  assert.equal(held.status, 'running', 'held first news round segment stays in progress');
  assert.equal(held.collector.record_count, 0, 'collector record_count remains this prepared round count');
  assert.equal(held.store_readback.snapshot_id, priorNewsReceipt.snapshot_id);
  assert.equal(held.store_readback.record_count, 180);
  assert.equal(held.store_readback.coverage.complete, false, 'partial prior release still remains the active held baseline');
  assert.equal(fs.existsSync(path.join(newsReceipts, newsJobId + '.json')), false, 'held round does not create a terminal receipt');
  const heldProgress = JSON.parse(fs.readFileSync(path.join(newsQueue, 'progress', newsJobId + '.json'), 'utf8'));
  assert.equal(heldProgress.status, 'running'); assert.equal(heldProgress.collector.record_count, 0);
  assert.equal(heldProgress.store_readback.record_count, 180);

  const rejectedHeldVariants = [
    ['bad checkpoint path', { ...heldCollectorResult, checkpoint_path: path.join(checkpointDirectory, 'other-checkpoint.json') }, 'kcg-news'],
    ['round id mismatch', { ...heldCollectorResult, index_round: { ...heldCollectorResult.index_round, id: crypto.randomUUID() } }, 'kcg-news'],
    ['prior count mismatch', { ...heldCollectorResult, index_round: { ...heldCollectorResult.index_round, prior_published_count: 181 } }, 'kcg-news'],
    ['wrong profile', { ...heldCollectorResult, profile: 'kcg-laws', dataset: 'kcg-laws' }, 'kcg-laws'],
  ];
  fs.writeFileSync(path.join(checkpointDirectory, 'other-checkpoint.json'), fs.readFileSync(checkpointPath));
  for (const [label, result, profile] of rejectedHeldVariants) {
    writeCollectorScript(result);
    const rejected = await runCollector(profile, data, { collectorScript });
    assert.notEqual(rejected.status, 'running', `${label} must not be accepted as a held news round`);
  }
  const validCheckpointBytes = fs.readFileSync(checkpointPath);
  fs.writeFileSync(checkpointPath, JSON.stringify({ ...checkpointEnvelope, sha256: '0'.repeat(64) }));
  writeCollectorScript(heldCollectorResult);
  const badCheckpointHash = await runCollector('kcg-news', data, { collectorScript });
  assert.notEqual(badCheckpointHash.status, 'running', 'invalid checkpoint envelope hash must be rejected');
  fs.writeFileSync(checkpointPath, validCheckpointBytes);
  assert.equal(fs.existsSync(path.join(newsReceipts, newsJobId + '.json')), false, 'rejected held results do not add a terminal to the valid in-progress job');
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
  console.log('PASS local jobs: fixed 900-second collector deadline preserves unknown-on-kill, native complete-parent checks, held news prior readback, capacity holds, health, prior queue/store cases');
} finally {
  if (previousEnrichmentEnabled === undefined) delete process.env.KCG_ENRICHMENT_ENABLED;
  else process.env.KCG_ENRICHMENT_ENABLED = previousEnrichmentEnabled;
  fs.rmSync(root, { recursive: true, force: true });
}
