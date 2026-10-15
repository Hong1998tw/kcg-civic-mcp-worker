import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/local/store.mjs';
import { runKccEnrichmentV2 } from '../src/ingestion/kcc-collector.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

async function seedMother(root, recordCount = 1007) {
  const store = new LocalStore(root, { readOnly: false });
  const raw = Buffer.from('verified KCC mother index fixture');
  const rawSha = sha(raw);
  await store.putRawObject({ sha256: rawSha, bytes_base64: raw.toString('base64') });
  const records = Array.from({ length: recordCount }, (_, index) => {
    const id = String(index + 1);
    return {
      id, title: `提案 ${id}`, text: '',
      data: { proposal_sn: id, detail_url: `https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=encrypted-${id}` },
      source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx',
      retrieved_at: '2026-10-15T00:00:00.000Z', raw_sha256: rawSha,
    };
  });
  const receipt = await store.importSnapshot({
    dataset: 'kcc-proposals', snapshot_id: 'fastpath-mother-1007', records,
    coverage: { scope: 'fastpath-test-mother', complete: true, source_total: recordCount },
    raw_objects: [], parser_version: 'fastpath-test', validator_version: 'fastpath-test', validation_status: 'passed',
  });
  store.close();
  return receipt;
}

function openInstrumented(root, { driftOnSecond = false, archiveTransform = null, archiveError = null, missingArchiveApi = false } = {}) {
  const store = new LocalStore(root, { readOnly: false });
  const counts = { limit0: 0, paged: 0, archive: 0, http: 0 };
  const queryRecords = store.queryRecords.bind(store);
  const readSnapshotVersion = store.readSnapshotVersion.bind(store);
  store.queryRecords = async (dataset, options = {}) => {
    if (options.limit === 0) counts.limit0 += 1;
    else counts.paged += 1;
    const result = await queryRecords(dataset, options);
    if (options.limit === 0 && driftOnSecond && counts.limit0 === 2) {
      return { ...result, release: { ...result.release, manifest_sha256: 'f'.repeat(64) } };
    }
    return result;
  };
  if (missingArchiveApi) store.readSnapshotVersion = undefined;
  else store.readSnapshotVersion = async (dataset, snapshotId) => {
    counts.archive += 1;
    if (archiveError) throw Object.assign(new Error(archiveError.message), { code: archiveError.code });
    const document = await readSnapshotVersion(dataset, snapshotId);
    return archiveTransform ? archiveTransform(document) : document;
  };
  return { store, counts };
}

const fetchFixture = (counts) => async (request) => {
  counts.http += 1;
  if (String(request).includes('GetAttachmentList.ashx')) return new Response('尚無任何資料!', { headers: { 'content-type': 'text/html;charset=utf-8' } });
  return new Response('<input name="ctl00$ContentPlaceHolder1$uscAttachment$hidDataSN" value="1"><input name="ctl00$ContentPlaceHolder1$uscAttachment$hidDataType" value="1"><tr><td>案由</td><td>提案案由</td></tr>', { headers: { 'content-type': 'text/html;charset=utf-8' } });
};

async function run(root, instrumentOptions = {}) {
  let observed;
  const result = await runKccEnrichmentV2({ profile: 'kcc-proposal-details', root, maxRequests: 1, maxDurationMs: 75000 }, {
    storeFactory: async (location) => {
      observed = openInstrumented(location, instrumentOptions);
      return observed.store;
    },
    fetchImpl: async (...args) => fetchFixture(observed.counts)(...args),
  });
  return { result, counts: observed.counts };
}

async function expectBlockedWithoutPaging(root, options, code) {
  const { result, counts } = await run(root, options);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error_code, code);
  assert.equal(counts.paged, 0, 'native readSnapshotVersion API failure must not fall back to 1000-row paging');
  assert.equal(counts.http, 0);
  return counts;
}

async function main() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kcc-readall-fastpath-')));
  try {
    await seedMother(root);

    const healthy = await run(root);
    assert.equal(healthy.result.status, 'paused');
    assert.equal(healthy.result.error_code, null);
    assert.equal(healthy.result.coverage.source_total, 1007);
    assert.equal(healthy.counts.limit0, 2, 'production fast path must verify active SQLite release before and after archive read');
    assert.equal(healthy.counts.archive, 1, 'production fast path must read exactly one immutable archive');
    assert.equal(healthy.counts.paged, 0, 'production fast path must avoid 1000-row pages');
    assert.equal(healthy.counts.http, 1, 'collection should continue after the verified mother set is ready');

    const fixtureFallback = await run(root, { missingArchiveApi: true });
    assert.equal(fixtureFallback.result.status, 'paused', JSON.stringify(fixtureFallback.result));
    assert.equal(fixtureFallback.counts.limit0, 0);
    assert.equal(fixtureFallback.counts.archive, 0);
    assert.equal(fixtureFallback.counts.paged, 2, 'fixture without native archive API retains the bounded legacy page reader');
    assert.equal(fixtureFallback.counts.http, 1);

    const drift = await expectBlockedWithoutPaging(root, { driftOnSecond: true }, 'DEPENDENCY_DRIFT');
    assert.equal(drift.limit0, 2);
    assert.equal(drift.archive, 1);

    const manifestMismatch = await expectBlockedWithoutPaging(root, {
      archiveTransform: (archive) => ({ ...archive, manifest_sha256: '0'.repeat(64) }),
    }, 'DEPENDENCY_DRIFT');
    assert.equal(manifestMismatch.limit0, 1);
    assert.equal(manifestMismatch.archive, 1);

    const countMismatch = await expectBlockedWithoutPaging(root, {
      archiveTransform: (archive) => ({ ...archive, record_count: archive.record_count + 1 }),
    }, 'DEPENDENCY_DRIFT');
    assert.equal(countMismatch.limit0, 1);
    assert.equal(countMismatch.archive, 1);

    const duplicate = await expectBlockedWithoutPaging(root, {
      archiveTransform: (archive) => ({ ...archive, records: [archive.records[0], ...archive.records.slice(0, -1)] }),
    }, 'DEPENDENCY_DRIFT');
    assert.equal(duplicate.limit0, 1);
    assert.equal(duplicate.archive, 1);

    const tampered = await expectBlockedWithoutPaging(root, {
      archiveError: { code: 'SNAPSHOT_UNVERIFIED', message: 'injected archive/raw verification failure' },
    }, 'SNAPSHOT_UNVERIFIED');
    assert.equal(tampered.limit0, 1);
    assert.equal(tampered.archive, 1);

    process.stdout.write('PASS KCC mother readAll fast path: 1007 rows, fixed archive, double active check, no paging fallback\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
