import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/local/store.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

async function seed(root) {
  const store = new LocalStore(root, { readOnly: false });
  const raw = Buffer.from('TEST concurrency proposal index');
  const rawSha = sha(raw);
  await store.putRawObject({ sha256: rawSha, bytes_base64: raw.toString('base64') });
  await store.importSnapshot({
    dataset: 'kcc-proposals', snapshot_id: 'TEST-concurrency-v1',
    records: ['1', '2', '3'].map((id) => ({ id, title: `提案${id}`, text: `提案${id}`, data: { proposal_sn: id }, source_url: 'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx', retrieved_at: '2026-10-24T00:00:00.000Z', raw_sha256: rawSha })),
    coverage: { scope: 'TEST', complete: true, source_total: 3 }, raw_objects: [], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed',
  });
  return store;
}

// Writes far more than the default page cache inside one open transaction, the way a release
// rewrite does, so a writer that is allowed to spill would hold the EXCLUSIVE lock.
function fillOpenTransaction(db) {
  db.exec('BEGIN IMMEDIATE');
  const insert = db.prepare('INSERT INTO collections (dataset,id,title,text,json,source_url,retrieved_at,raw_sha256) VALUES (?,?,?,?,?,?,?,?)');
  const text = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 400; i += 1) insert.run('kcg-news', `bulk-${i}`, 'bulk', text, '{}', 'https://www.kcg.gov.tw/', '2026-10-24T00:00:00.000Z', '0'.repeat(64));
}

function lockedForImmediateReader(dbPath) {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    reader.exec('PRAGMA busy_timeout=0');
    reader.prepare('SELECT count(*) AS n FROM collections').get();
    return false;
  } catch (error) {
    if (/locked|busy/i.test(String(error.message))) return true;
    throw error;
  } finally { reader.close(); }
}

async function main() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kcg-concurrency-')));
  try {
    const writer = await seed(root);
    const dbPath = path.join(root, 'index.sqlite');

    // Control: with spilling allowed the open transaction really does lock readers out, so the
    // assertion below exercises the failure the query runtime saw in production.
    writer.db.exec('PRAGMA cache_spill=ON');
    fillOpenTransaction(writer.db);
    assert.equal(lockedForImmediateReader(dbPath), true, 'control: a spilling writer must lock out readers');
    writer.db.exec('ROLLBACK');

    writer.db.exec('PRAGMA cache_spill=OFF');
    fillOpenTransaction(writer.db);
    assert.equal(lockedForImmediateReader(dbPath), false, 'the store writer must not lock readers out while its transaction is open');
    const reader = new LocalStore(root, { readOnly: true });
    try {
      const result = await reader.queryRecords('kcc-proposals', { limit: 10 });
      assert.equal(result.local_match_count, 3, 'readers see the last committed release during a rewrite');
      assert.equal(result.release.snapshot_id, 'TEST-concurrency-v1');
    } finally { reader.close(); }
    writer.db.exec('ROLLBACK');

    // A fresh writer gets the same settings from the constructor, not from this test.
    writer.close();
    const configured = new LocalStore(root, { readOnly: false });
    try {
      assert.equal(configured.db.prepare('PRAGMA cache_spill').get().cache_spill, 0);
      assert.equal(configured.db.prepare('PRAGMA busy_timeout').get().timeout, 30000);
    } finally { configured.close(); }
    const readOnly = new LocalStore(root, { readOnly: true });
    try { assert.equal(readOnly.db.prepare('PRAGMA busy_timeout').get().timeout, 30000); } finally { readOnly.close(); }
    process.stdout.write('PASS local store readers keep reading committed releases while the writer rewrites a release\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
