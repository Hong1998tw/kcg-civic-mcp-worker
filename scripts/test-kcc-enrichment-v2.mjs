import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KccEnrichmentStage, enrichmentBatchReady } from '../src/ingestion/kcc-enrichment-stage.mjs';
import { runKccEnrichmentV2, publishKccEnrichmentV2Stage } from '../src/ingestion/kcc-collector.mjs';
import { runDispatchedCollection, parseDispatchArgs } from '../src/ingestion/dispatch.mjs';
import { LocalStore } from '../src/local/store.mjs';
import { hydrateKccV2Record, packKccV2PdfPage, packKccV2Record } from '../src/local/kcc-payload.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const ref = (label) => ({ sha256: sha(label), byte_length: Buffer.byteLength(label) });
const descriptor = (id, suffix = '') => ({
  id, raw_sha256: sha(`raw-${id}-${suffix}`),
  envelope_ref: ref(`envelope-${id}-${suffix}`),
  payload_ref: ref(`payload-${id}-${suffix}`),
  search_ref: ref(`search-${id}-${suffix}`),
});
const mother = (recordCount = 2) => ({
  dataset: 'kcc-proposals', snapshot_id: 'source-snapshot-1', manifest_sha256: sha('source-manifest'), record_count: recordCount,
  coverage: { scope: 'all', complete: true, source_total: recordCount },
});
const digestSnapshot = (snapshot) => sha(JSON.stringify(snapshot));

function makeV2Store({ failDatasetOnce = null, beforeImport = null, oldReleases = {} } = {}) {
  const active = new Map();
  const archives = new Map();
  const importCounts = new Map();
  let failNextDataset = failDatasetOnce;
  const key = (dataset, snapshotId) => `${dataset}:${snapshotId}`;
  return {
    active, archives, importCounts,
    async queryV2(dataset) {
      const release = active.get(dataset);
      if (!release) throw Object.assign(new Error(`dataset=${dataset} 尚無 v2 snapshot`), { reasonCode: 'LOCAL_DATA_UNAVAILABLE' });
      return { release, records: [] };
    },
    async readSnapshotVersionV2(dataset, snapshotId) {
      const stored = archives.get(key(dataset, snapshotId));
      if (!stored) throw Object.assign(new Error('archive missing'), { reasonCode: 'LOCAL_DATA_UNAVAILABLE' });
      return structuredClone(stored);
    },
    async importV2(snapshot) {
      importCounts.set(snapshot.dataset, (importCounts.get(snapshot.dataset) || 0) + 1);
      await beforeImport?.(snapshot, active, archives);
      if (failNextDataset === snapshot.dataset) {
        failNextDataset = null;
        throw new Error(`injected ${snapshot.dataset} import failure`);
      }
      const manifest_sha256 = digestSnapshot(snapshot);
      const release = {
        dataset: snapshot.dataset, snapshot_id: snapshot.snapshot_id, record_count: snapshot.records.length,
        coverage: snapshot.coverage, manifest_sha256,
      };
      active.set(snapshot.dataset, release);
      archives.set(key(snapshot.dataset, snapshot.snapshot_id), { ...snapshot, ...release, records: structuredClone(snapshot.records) });
      return { status: 'imported', schema_version: 'local-snapshot-v2', ...release, idempotent: false };
    },
    async putRawObject() {},
    async hasDataset(dataset) { return dataset === 'kcc-proposals' && oldReleases['kcc-proposals'] !== false || Boolean(oldReleases[dataset]); },
    async queryRecords(dataset, options = {}) {
      const release = oldReleases[dataset];
      if (dataset === 'kcc-proposals' && options.limit !== 0) {
        return { release: mother(1), records: [{ id: '1', title: '提案一', text: '', data: { detail_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?sn=1' }, source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/List.aspx', retrieved_at: '2026-10-15T00:00:00.000Z', raw_sha256: sha('source-row') }], local_match_count: 1 };
      }
      if (release) return { release, records: [], local_match_count: release.record_count };
      throw Object.assign(new Error(`dataset=${dataset} 尚無本機 snapshot`), { reasonCode: 'LOCAL_DATA_UNAVAILABLE' });
    },
    async readRawObject() { throw new Error('unexpected raw read'); },
    derivedStore: {}, close() {},
  };
}

function v2Codec() {
  return {
    async packKccV2PdfPage(_derivedStore, input) {
      const pageRef = { version_id: input.raw_sha256, page_number: input.page_number, source: input.source, raw_sha256: input.raw_sha256, ref: ref(`page-${input.id}-${input.page_number}`) };
      return { page_ref: pageRef, search_chunks: [] };
    },
    async packKccV2Record(_derivedStore, { dataset, record }) {
      return { descriptor: descriptor(record.id, dataset) };
    },
  };
}

async function stageAt(directory, profile = 'kcc-proposal-details', source = mother(2), ids = ['1', '2']) {
  return KccEnrichmentStage.open({ directory, scope: `${profile}:scope`, profile, motherRelease: source, sourceIds: ids });
}

async function prepare(stage, cursor, id, datasets = ['kcc-proposal-details', 'kcc-proposal-attachments']) {
  await stage.prepareRecord({ id, cursor, descriptors: datasets.map((dataset) => ({ dataset, descriptor: descriptor(id, dataset) })), estimatedBytes: 256 });
}

async function testStageDurabilityAndPageGuard(root) {
  const directory = path.join(root, 'stage-durable');
  let stage = await stageAt(directory);
  await stage.saveWork('1', { id: '1', detail: { raw_sha256: sha('raw') }, versions: [{ pages: [{ page: 1, ref: ref('page') }] }] });
  const journal = JSON.parse(await readFile(path.join(directory, 'journal.json'), 'utf8'));
  assert.equal(Object.hasOwn(journal, 'source_ids'), false);
  assert.equal(Object.hasOwn(journal, 'records'), false);
  stage = await stageAt(directory);
  assert.equal((await stage.readWork('1')).id, '1');
  await assert.rejects(() => stage.saveWork('1', { versions: [{ pages: [{ page: 1, text: 'must not persist' }] }] }), /STAGING_PAGE_TEXT_RETAINED/);
  await prepare(stage, 0, '1');
  stage = await stageAt(directory);
  assert.equal(stage.journal.prepared_cursor, 1);
  assert.equal(stage.journal.committed_cursor, 0);
  assert.equal(stage.journal.batch_refs.length, 1);
  assert.deepEqual(Object.keys(await stage.readPreparedRecords()).sort(), ['kcc-proposal-attachments', 'kcc-proposal-details']);
  await assert.rejects(() => stageAt(directory, 'kcc-proposal-details', { ...mother(2), manifest_sha256: sha('different') }, ['1', '2']), /MOTHER_IDS_DRIFT|CHECKPOINT_MISMATCH/);
}

async function testBatchThresholds() {
  assert.equal(enrichmentBatchReady('kcc-proposal-details', 99, 0), false);
  assert.equal(enrichmentBatchReady('kcc-proposal-details', 100, 0), true);
  assert.equal(enrichmentBatchReady('kcc-proposal-details', 1, 8 * 1024 * 1024), true);
  assert.equal(enrichmentBatchReady('kcc-proposal-details', 1, 0, true), true);
  assert.equal(enrichmentBatchReady('kcc-meeting-records', 24, 0), false);
  assert.equal(enrichmentBatchReady('kcc-meeting-records', 25, 0), true);
  assert.equal(enrichmentBatchReady('kcc-meeting-records', 1, 8 * 1024 * 1024), true);
}

async function testFixedBatchPublicationCount(root) {
  const detailIds = Array.from({ length: 100 }, (_, index) => String(index + 1));
  const details = await stageAt(path.join(root, 'stage-batch-details'), 'kcc-proposal-details', mother(100), detailIds);
  for (let cursor = 0; cursor < detailIds.length; cursor += 1) {
    const id = detailIds[cursor];
    await details.prepareRecord({ id, cursor, descriptors: ['kcc-proposal-details', 'kcc-proposal-attachments'].map((dataset) => ({ dataset, descriptor: descriptor(id, dataset) })), estimatedBytes: 128 });
  }
  assert.equal(enrichmentBatchReady('kcc-proposal-details', details.journal.batch_refs.length, details.journal.batch_bytes), true);
  const detailsStore = makeV2Store();
  await publishKccEnrichmentV2Stage({ scope: 'details:100', config: { profile: 'kcc-proposal-details' }, store: detailsStore }, details, ['kcc-proposal-details', 'kcc-proposal-attachments'], 100, true);
  assert.equal(detailsStore.importCounts.get('kcc-proposal-details'), 1);
  assert.equal(detailsStore.importCounts.get('kcc-proposal-attachments'), 1);
  assert.equal(details.journal.committed_cursor, 100);

  const meetingIds = Array.from({ length: 25 }, (_, index) => String(index + 1));
  const meetings = await stageAt(path.join(root, 'stage-batch-meetings'), 'kcc-meeting-records', { ...mother(25), dataset: 'kcc-meetings' }, meetingIds);
  for (let cursor = 0; cursor < meetingIds.length; cursor += 1) {
    const id = meetingIds[cursor];
    await meetings.prepareRecord({ id, cursor, descriptors: [{ dataset: 'kcc-meeting-records', descriptor: descriptor(id, 'kcc-meeting-records') }], estimatedBytes: 128 });
  }
  assert.equal(enrichmentBatchReady('kcc-meeting-records', meetings.journal.batch_refs.length, meetings.journal.batch_bytes), true);
  const meetingStore = makeV2Store();
  await publishKccEnrichmentV2Stage({ scope: 'meeting:25', config: { profile: 'kcc-meeting-records' }, store: meetingStore }, meetings, ['kcc-meeting-records'], 25, true);
  assert.equal(meetingStore.importCounts.get('kcc-meeting-records'), 1);
  assert.equal(meetings.journal.committed_cursor, 25);
}

async function testPartialPublishRecovery(root) {
  const directory = path.join(root, 'stage-partial');
  const stage = await stageAt(directory);
  await prepare(stage, 0, '1');
  const store = makeV2Store({ failDatasetOnce: 'kcc-proposal-attachments' });
  const ctx = { scope: 'kcc-proposal-details:scope', config: { profile: 'kcc-proposal-details' }, store };
  assert.equal(enrichmentBatchReady('kcc-proposal-details', stage.journal.batch_refs.length, stage.journal.batch_bytes), false);
  assert.equal(enrichmentBatchReady('kcc-proposal-details', stage.journal.batch_refs.length, stage.journal.batch_bytes, true), true);
  await assert.rejects(() => publishKccEnrichmentV2Stage(ctx, stage, ['kcc-proposal-details', 'kcc-proposal-attachments'], 2, false), /injected kcc-proposal-attachments/);
  assert.equal(stage.journal.committed_cursor, 0);
  assert.equal(stage.journal.pending_ref.confirmed['kcc-proposal-details'].record_count, 1);
  assert.equal(stage.journal.pending_ref.states['kcc-proposal-attachments'], 'unknown');
  await publishKccEnrichmentV2Stage(ctx, stage, ['kcc-proposal-details', 'kcc-proposal-attachments'], 2, false);
  assert.equal(stage.journal.committed_cursor, 1);
  assert.equal(store.importCounts.get('kcc-proposal-details'), 1);
  assert.equal(store.importCounts.get('kcc-proposal-attachments'), 2);
}

async function testCommitCheckpointFailureDoesNotRepublish(root) {
  const directory = path.join(root, 'stage-commit-recovery');
  let stage = await stageAt(directory);
  await prepare(stage, 0, '1');
  const store = makeV2Store();
  const ctx = { scope: 'kcc-proposal-details:scope', config: { profile: 'kcc-proposal-details' }, store };
  const commit = stage.commitPending.bind(stage);
  stage.commitPending = async () => { throw new Error('injected journal commit failure'); };
  await assert.rejects(() => publishKccEnrichmentV2Stage(ctx, stage, ['kcc-proposal-details', 'kcc-proposal-attachments'], 2, false), /injected journal commit failure/);
  assert.equal(stage.journal.committed_cursor, 0);
  stage = await stageAt(directory);
  await publishKccEnrichmentV2Stage(ctx, stage, ['kcc-proposal-details', 'kcc-proposal-attachments'], 2, false);
  assert.equal(stage.journal.committed_cursor, 1);
  assert.equal(store.importCounts.get('kcc-proposal-details'), 1);
  assert.equal(store.importCounts.get('kcc-proposal-attachments'), 1);
  assert.equal(typeof commit, 'function');
}

async function testActiveReleaseDriftStopsRetry(root) {
  const directory = path.join(root, 'stage-drift');
  const stage = await stageAt(directory);
  await prepare(stage, 0, '1');
  const store = makeV2Store({ beforeImport(snapshot, active) {
    if (snapshot.dataset === 'kcc-proposal-details' && !active.has(snapshot.dataset)) {
      active.set(snapshot.dataset, { dataset: snapshot.dataset, snapshot_id: 'alien', manifest_sha256: sha('alien'), record_count: 1 });
      throw new Error('interrupted after active release drift');
    }
  } });
  const ctx = { scope: 'kcc-proposal-details:scope', config: { profile: 'kcc-proposal-details' }, store };
  await assert.rejects(() => publishKccEnrichmentV2Stage(ctx, stage, ['kcc-proposal-details', 'kcc-proposal-attachments'], 2, false), /interrupted after active release drift/);
  await assert.rejects(() => publishKccEnrichmentV2Stage(ctx, stage, ['kcc-proposal-details', 'kcc-proposal-attachments'], 2, false), (error) => error.code === 'RELEASE_DRIFT');
}

async function testResumedTerminalUnindexedBatch(root) {
  const profile = 'kcc-meeting-records';
  const scope = JSON.stringify({ profile, periods: null, sessions: null, keyword: '', pageSize: 100 });
  const source = { ...mother(1), dataset: 'kcc-meetings' };
  const directory = path.join(root, '.kcc-collection', profile, sha(JSON.stringify(scope)).slice(0, 24), 'enrichment-v2');
  const stage = await KccEnrichmentStage.open({ directory, scope, profile, motherRelease: source, sourceIds: ['1'] });
  await stage.prepareRecord({ id: '1', cursor: 0, descriptors: [{ dataset: profile, descriptor: descriptor('1', profile) }], estimatedBytes: 256, contentIndexed: false });
  const store = makeV2Store();
  store.hasDataset = async () => true;
  store.queryRecords = async (_dataset, options = {}) => ({ release: source, records: options.limit === 0 ? [] : [{ id: '1', data: { record_id: '1' } }], local_match_count: 1 });
  const result = await runKccEnrichmentV2({ root, profile, maxRequests: 25, maxDurationMs: 75000 }, { storeFactory: async () => store, v2Codec: v2Codec(), fetchImpl: async () => { throw new Error('resumed prepared record must not refetch'); } });
  assert.equal(result.status, 'partial'); assert.equal(result.fulltext_complete, false); assert.equal(result.archive_complete, true);
  assert.equal(result.coverage.complete, false); assert.equal(store.active.get(profile).coverage.complete, false, 'resumed publication cannot upgrade unindexed originals to complete');
  assert.equal(result.progress.committed_cursor, 1); assert.equal(result.attempted, 0);
}

async function testNativeLocalStoreAndCodec(root) {
  const store = new LocalStore(path.join(root, 'native-store'), { readOnly: false });
  try {
    const id = '1449', dataset = 'kcc-meeting-records';
    const source = `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/original.pdf`;
    const raw = Buffer.from('%PDF-native-v2-fixture');
    const rawSha = sha(raw);
    await store.putRawObject({ sha256: rawSha, bytes_base64: raw.toString('base64') });
    const pageText = '原生 codec 頁面文字';
    const pageBundle = await packKccV2PdfPage(store.derivedStore, { dataset, id, source, raw_sha256: rawSha, page_number: 1, text: pageText });
    const page = { page: 1, has_text_layer: true };
    const version = { source_url: source, download_url: source, pdf_url: source, file_type: 'pdf', raw_sha256: rawSha, retrieved_at: '2026-10-15T00:00:00.000Z', byte_length: raw.length, total_pages: 1, text_layer_status: 'present', pages: [page] };
    const record = {
      id, title: '原生 v2 議事錄', text: '', text_recipe: { kind: 'page-join', slot: 'data.pages', separator: '\n' },
      data: { record_id: id, pdf_url: source, pages: [page], total_pages: 1, pdf_versions: [version], original_versions: [version], content_index_status: 'indexed', fulltext_complete: true },
      source_url: source, retrieved_at: '2026-10-15T00:00:00.000Z', raw_sha256: rawSha,
    };
    const packed = await packKccV2Record(store.derivedStore, { dataset, record, page_refs: [pageBundle] });
    const receipt = await store.importV2({
      schema_version: 'local-snapshot-v2', dataset, snapshot_id: 'kcc-v2-native-fixture',
      coverage: { scope: 'native-codec-fixture', complete: true, source_total: 1 },
      parser_version: 'test-kcc-enrichment-v2', validator_version: 'native-codec-fixture', validation_status: 'passed',
      records: [packed.descriptor],
    });
    assert.equal(receipt.schema_version, 'local-snapshot-v2');
    const metadata = await store.queryV2(dataset, { limit: 1, metadataOnly: true, includePageRefs: true });
    assert.equal(metadata.release.snapshot_id, receipt.snapshot_id);
    assert.equal(metadata.records.length, 1);
    const hydrated = await hydrateKccV2Record(store, dataset, metadata.records[0]);
    assert.equal(hydrated.text, pageText);
    assert.equal(hydrated.data.pages[0].text, pageText);
    const archived = await store.readSnapshotVersionV2(dataset, receipt.snapshot_id);
    assert.equal(archived.records[0].payload_ref.sha256, packed.descriptor.payload_ref.sha256);
  } finally { store.close(); }
}

async function testDispatchedNativeCollectorResume(root) {
  const dataRoot = path.join(root, 'native-collector');
  const sourceStore = new LocalStore(dataRoot, { readOnly: false });
  const raw = Buffer.from('official proposal index row');
  const rawSha = sha(raw);
  await sourceStore.putRawObject({ sha256: rawSha, bytes_base64: raw.toString('base64') });
  await sourceStore.importSnapshot({
    dataset: 'kcc-proposals', snapshot_id: 'native-proposal-index',
    records: [{ id: '100', title: '提案一', text: '提案一', data: { proposal_sn: '100', detail_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=ENCRYPTED' }, source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx', retrieved_at: '2026-10-15T00:00:00.000Z', raw_sha256: rawSha }],
    coverage: { scope: 'native-proposal-index', complete: true, source_total: 1 }, raw_objects: [], parser_version: 'native-fixture', validator_version: 'native-fixture', validation_status: 'passed',
  });
  sourceStore.close();
  const legacyScope = JSON.stringify({ profile: 'kcc-proposal-details', periods: null, sessions: null, keyword: '', pageSize: 100 });
  const legacyDirectory = path.join(dataRoot, '.kcc-collection', 'kcc-proposal-details', sha(JSON.stringify(legacyScope)).slice(0, 24));
  await mkdir(legacyDirectory, { recursive: true });
  const sourceReadback = new LocalStore(dataRoot, { readOnly: true });
  const sourceRelease = (await sourceReadback.queryRecords('kcc-proposals', { limit: 0 })).release;
  sourceReadback.close();
  const legacyBytes = JSON.stringify({ version: 'kcc-all-tabs-resumable-v1', scope: legacyScope, dependency: sourceRelease, source_ids: ['100'], cursor: 0, records: {}, receipts: {}, work: { id: '100', detail: null, attachments: null, list: null, downloaded: 0 } });
  await writeFile(path.join(legacyDirectory, 'checkpoint.json'), legacyBytes);
  let httpCount = 0;
  const fetchImpl = async (requested) => {
    httpCount += 1;
    const url = String(requested);
    if (url.includes('Detail.aspx')) {
      return new Response('<input name="ctl00$ContentPlaceHolder1$uscAttachment$hidDataSN" value="100"><input name="ctl00$ContentPlaceHolder1$uscAttachment$hidDataType" value="1"><tr><td>案由</td><td>Native v2 title</td></tr>', { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }
    if (url.includes('GetAttachmentList.ashx')) return new Response('尚無任何資料!', { headers: { 'content-type': 'text/html;charset=utf-8' } });
    throw new Error(`unexpected official request ${url}`);
  };
  const dispatchArgs = parseDispatchArgs(['--profile', 'kcc-proposal-details', '--root', dataRoot, '--run', '--max-requests', '1']);
  assert.equal(Object.hasOwn(dispatchArgs, 'format'), false);
  assert.throws(() => parseDispatchArgs(['--profile', 'kcc-proposal-details', '--root', dataRoot, '--run', '--format', 'v1']), (error) => error.code === 'ARGUMENT_INVALID');
  const dependencies = { storeFactory: async (location) => new LocalStore(location, { readOnly: false }), fetchImpl };
  const first = await runDispatchedCollection(dispatchArgs, dependencies);
  assert.equal(first.status, 'paused');
  assert.equal(first.record_count, 0);
  assert.equal(first.prepared_count, 0);
  assert.equal(first.progress.current_id, '100');
  assert.equal(first.commit_state, 'not-committed');
  assert.equal(httpCount, 1);
  assert.equal(JSON.parse(await readFile(first.checkpoint_path, 'utf8')).legacy_migration.cursor, 0);
  const checkpoint = JSON.parse(await readFile(first.checkpoint_path, 'utf8'));
  assert.equal(Object.hasOwn(checkpoint, 'source_ids'), false);
  assert.equal(Object.hasOwn(checkpoint, 'records'), false);
  const second = await runDispatchedCollection(dispatchArgs, dependencies);
  assert.equal(second.status, 'complete');
  assert.equal(second.record_count, 1);
  assert.equal(second.prepared_count, 1);
  assert.equal(second.progress.committed_cursor, 1);
  assert.equal(second.commit_state, 'committed');
  assert.equal(httpCount, 2);
  assert.equal(await readFile(path.join(legacyDirectory, 'checkpoint.json'), 'utf8'), legacyBytes, 'legacy checkpoint is preserved while newer v2 work advances');
  const readback = new LocalStore(dataRoot);
  try {
    const detail = await readback.queryV2('kcc-proposal-details', { limit: 1, metadataOnly: true, includePageRefs: true });
    const attachments = await readback.queryV2('kcc-proposal-attachments', { limit: 1, metadataOnly: true, includePageRefs: true });
    assert.equal(detail.release.record_count, 1);
    assert.equal(attachments.release.record_count, 1);
    const hydrated = await hydrateKccV2Record(readback, 'kcc-proposal-details', detail.records[0]);
    assert.equal(hydrated.data.subject, 'Native v2 title');
    assert.equal(hydrated.data.proposal_sn, '100');
  } finally { readback.close(); }
}

function legacyReceipt(dataset) {
  return { status: 'imported', dataset, snapshot_id: `legacy-${dataset}`, record_count: 1, manifest_sha256: sha(`legacy-${dataset}-manifest`) };
}

async function runLegacyMigration(root, { cursor, withWork }) {
  const profile = 'kcc-proposal-details';
  const optionsScope = { profile, periods: null, sessions: null, keyword: '', pageSize: 100 };
  const scope = JSON.stringify(optionsScope);
  const digestPrefix = sha(JSON.stringify(scope)).slice(0, 24);
  const directory = path.join(root, '.kcc-collection', profile, digestPrefix);
  await mkdir(directory, { recursive: true });
  const sourceRelease = mother(1);
  const indexRecord = { id: '1', title: '提案一', text: '', data: { detail_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?sn=1' }, source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/List.aspx', retrieved_at: '2026-10-15T00:00:00.000Z', raw_sha256: sha('source-row') };
  const detailRecord = { id: '1', title: '提案一', text: '內容', data: { proposal_sn: '1' }, source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?sn=1', retrieved_at: '2026-10-15T00:00:00.000Z', raw_sha256: sha('detail') };
  const list = { source_url: 'https://cissearch.kcc.gov.tw/Common/GetAttachmentList.ashx?f=1&s=1&t=False', raw_sha256: sha('list'), retrieved_at: '2026-10-15T00:00:00.000Z' };
  const attachmentRecord = { id: '1', title: '提案一 附件清單', text: '官方來源明示無附件', data: { proposal_sn: '1', attachments: [], total_files: 0, attachment_originals_complete: true }, ...list };
  const v1Receipts = cursor ? { 'kcc-proposal-details': legacyReceipt('kcc-proposal-details'), 'kcc-proposal-attachments': legacyReceipt('kcc-proposal-attachments') } : {};
  const oldReleases = Object.fromEntries(Object.entries(v1Receipts).map(([dataset, receipt]) => [dataset, { ...receipt, coverage: { scope: 'old', complete: false, source_total: 1 }, parser_version: 'old', validator_version: 'old', source_url: 'https://cissearch.kcc.gov.tw/', retrieved_at: '2026-10-15T00:00:00.000Z' }]));
  oldReleases['kcc-proposals'] = { ...sourceRelease, parser_version: 'source', validator_version: 'source', source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx', retrieved_at: '2026-10-15T00:00:00.000Z' };
  const legacy = {
    version: 'kcc-all-tabs-resumable-v1', scope, dependency: sourceRelease, source_ids: ['1'], cursor,
    records: cursor ? { 'kcc-proposal-details': { '1': detailRecord }, 'kcc-proposal-attachments': { '1': attachmentRecord } } : {},
    receipts: v1Receipts, ...(withWork ? { work: { id: '1', detail: detailRecord, attachments: [], list, downloaded: 0 } } : {}),
  };
  const legacyBytes = `${JSON.stringify(legacy)}\n`;
  const checkpoint = path.join(directory, 'checkpoint.json');
  await writeFile(checkpoint, legacyBytes);
  const store = makeV2Store({ oldReleases });
  const oldQueryRecords = store.queryRecords.bind(store);
  store.queryRecords = async (dataset, params = {}) => {
    if (dataset === 'kcc-proposals' && params.limit !== 0) return { release: sourceRelease, records: [indexRecord], local_match_count: 1 };
    return oldQueryRecords(dataset, params);
  };
  const result = await runKccEnrichmentV2({ profile, root, maxRequests: 25, maxDurationMs: 75000 }, { storeFactory: async () => store, v2Codec: v2Codec(), fetchImpl: async () => { throw new Error('legacy migration unexpectedly refetched official source'); } });
  assert.equal(await readFile(checkpoint, 'utf8'), legacyBytes);
  assert.equal(result.attempted, 0, JSON.stringify(result));
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.record_count, 1);
  return result;
}

async function main() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kcc-enrichment-v2-')));
  try {
    await testStageDurabilityAndPageGuard(root);
    await testBatchThresholds();
    await testFixedBatchPublicationCount(root);
    await testPartialPublishRecovery(root);
    await testCommitCheckpointFailureDoesNotRepublish(root);
    await testActiveReleaseDriftStopsRetry(root);
    await testResumedTerminalUnindexedBatch(path.join(root, 'resume-unindexed'));
    await testNativeLocalStoreAndCodec(root);
    await testDispatchedNativeCollectorResume(root);
    const migrated = await runLegacyMigration(path.join(root, 'legacy-committed'), { cursor: 1, withWork: false });
    assert.equal(migrated.migration_receipts['kcc-proposal-details'].record_count, 1);
    const resumedWork = await runLegacyMigration(path.join(root, 'legacy-work'), { cursor: 0, withWork: true });
    assert.equal(resumedWork.progress.committed_cursor, 1);
    process.stdout.write('PASS KCC enrichment v2 staging, batching, recovery, drift and legacy migration\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
