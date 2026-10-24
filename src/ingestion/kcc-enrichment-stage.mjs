import { createHash } from 'node:crypto';
import { mkdir, open, readFile, lstat, realpath, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';

const JOURNAL_VERSION = 'kcc-enrichment-stage-v2';
const SHA256 = /^[a-f0-9]{64}$/;

export class KccEnrichmentStageError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = 'KccEnrichmentStageError'; this.code = code; this.reasonCode = code; }
}

function fail(code, message) { throw new KccEnrichmentStageError(code, message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function encoded(value) { return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); }
function refFor(bytes) { return { sha256: sha256(bytes), byte_length: bytes.byteLength }; }
function refsEqual(a, b) { return !!a && !!b && a.sha256 === b.sha256 && a.byte_length === b.byte_length; }
function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:#/-]{1,512}$/.test(value)) fail('STAGING_ID_INVALID', 'staging record id 格式無效');
  return value;
}
function checkDescriptor(value) {
  const keys = ['id', 'raw_sha256', 'envelope_ref', 'payload_ref', 'search_ref'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    fail('STAGING_DESCRIPTOR_INVALID', 'staged record 必須是 descriptors-only v2 描述資料');
  }
  safeId(value.id);
  if (typeof value.raw_sha256 !== 'string' || !SHA256.test(value.raw_sha256)) fail('STAGING_DESCRIPTOR_INVALID', 'descriptor raw_sha256 格式無效');
  for (const key of ['envelope_ref', 'payload_ref', 'search_ref']) {
    const ref = value[key];
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 2 ||
        Object.keys(ref).some((field) => !['sha256', 'byte_length'].includes(field)) ||
        typeof ref.sha256 !== 'string' || !SHA256.test(ref.sha256) || !Number.isSafeInteger(ref.byte_length) || ref.byte_length < 1) {
      fail('STAGING_DESCRIPTOR_INVALID', `descriptor ${key} 格式無效`);
    }
  }
  return value;
}
function assertPagesHaveNoText(value, key = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (key === 'pages') {
      for (const page of value) if (page && typeof page === 'object' && Object.hasOwn(page, 'text')) fail('STAGING_PAGE_TEXT_RETAINED', 'PDF work 僅可保存頁碼與 derived refs，不可在 checkpoint work 重存頁面正文');
    }
    for (const item of value) assertPagesHaveNoText(item, key);
    return;
  }
  for (const [childKey, child] of Object.entries(value)) assertPagesHaveNoText(child, childKey);
}
async function assertPlainDirectory(directory) {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('STAGING_PATH_INVALID', 'staging 目錄必須是一般目錄');
    if (await realpath(directory) !== path.resolve(directory)) fail('STAGING_PATH_INVALID', 'staging 目錄不可包含 symbolic link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(directory);
  }
}
async function assertPlainFile(file) {
  try {
    const info = await lstat(file, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) fail('STAGING_PATH_INVALID', 'staging 檔案不得為 symlink、hardlink 或非一般檔案');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableReplace(file, bytes) {
  const directory = path.dirname(file);
  await assertPlainDirectory(directory);
  await assertPlainFile(file);
  const temporary = `${file}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  await syncDirectory(directory);
}
async function durableCreate(file, bytes) {
  const directory = path.dirname(file);
  await assertPlainDirectory(directory);
  await assertPlainFile(file);
  const temporary = `${file}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, file); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { await unlink(temporary).catch(() => {}); }
  await syncDirectory(directory);
  return true;
}
async function readJson(file, ref = null) {
  await assertPlainFile(file);
  const bytes = await readFile(file);
  if (ref && !refsEqual(refFor(bytes), ref)) fail('STAGING_REF_INVALID', 'staging 物件 hash 或 byte_length 不一致');
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('STAGING_JSON_INVALID', 'staging JSON 無法解析'); }
}
function stableMother(release) {
  if (!release || typeof release.dataset !== 'string' || typeof release.snapshot_id !== 'string' || !SHA256.test(release.manifest_sha256 || '') || !Number.isSafeInteger(release.record_count)) {
    fail('MOTHER_RELEASE_INVALID', '母集 release 缺少 dataset、snapshot、manifest 或筆數證明');
  }
  return { dataset: release.dataset, snapshot_id: release.snapshot_id, manifest_sha256: release.manifest_sha256.toLowerCase(), record_count: release.record_count };
}

/**
 * Compact, durable staging for one KCC enrichment scope. The journal contains
 * only immutable mother-set/work/descriptor refs, cursors and publication receipts.
 */
export class KccEnrichmentStage {
  constructor(directory, journal) {
    this.directory = path.resolve(directory);
    this.journalPath = path.join(this.directory, 'journal.json');
    this.journal = journal;
  }

  static async open({ directory, scope, profile, motherRelease, sourceIds }) {
    const root = path.resolve(directory);
    await assertPlainDirectory(root);
    for (const child of ['mother', 'work', 'staged', 'pending']) await assertPlainDirectory(path.join(root, child));
    const journalPath = path.join(root, 'journal.json');
    const release = stableMother(motherRelease);
    if (!Array.isArray(sourceIds) || sourceIds.length !== release.record_count || sourceIds.some((id) => typeof id !== 'string') || new Set(sourceIds).size !== sourceIds.length) {
      fail('MOTHER_IDS_INVALID', '母集識別碼需唯一且與固定 release 總數一致');
    }
    const idsBytes = encoded({ schema_version: 'kcc-enrichment-mother-ids-v1', release, ids: sourceIds });
    const idsRef = refFor(idsBytes);
    const idsFile = path.join(root, 'mother', `${release.dataset}-${release.snapshot_id}.json`);
    const installed = await durableCreate(idsFile, idsBytes);
    if (!installed) {
      const prior = await readJson(idsFile);
      if (!refsEqual(refFor(encoded(prior)), idsRef)) fail('MOTHER_IDS_DRIFT', '同一母集 release 的固定 source IDs 與既存 staging 不一致');
    }
    let journal;
    try { journal = await readJson(journalPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (journal) {
      if (journal.schema_version !== JOURNAL_VERSION || journal.scope !== scope || journal.profile !== profile ||
          JSON.stringify(journal.mother_release) !== JSON.stringify(release) || !refsEqual(journal.mother_ids_ref, idsRef)) {
        fail('CHECKPOINT_MISMATCH', 'compact enrichment journal 的 scope、profile 或固定母集已改變');
      }
      if (!Number.isSafeInteger(journal.committed_cursor) || !Number.isSafeInteger(journal.prepared_cursor) || journal.committed_cursor < 0 || journal.prepared_cursor < journal.committed_cursor || journal.prepared_cursor > sourceIds.length) {
        fail('CHECKPOINT_INVALID', 'compact enrichment cursor 無效');
      }
    } else {
      journal = {
        schema_version: JOURNAL_VERSION, scope, profile, mother_release: release, mother_ids_ref: idsRef,
        committed_cursor: 0, prepared_cursor: 0, batch_refs: [], batch_bytes: 0,
        work_ref: null, pending_ref: null, receipts: {}, all_content_indexed: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      await durableReplace(journalPath, encoded(journal));
    }
    const stage = new KccEnrichmentStage(root, journal);
    await stage.readMotherIds();
    return stage;
  }

  async #saveJournal(next) {
    next.updated_at = new Date().toISOString();
    await durableReplace(this.journalPath, encoded(next));
    this.journal = next;
  }

  async readMotherIds() {
    const file = path.join(this.directory, 'mother', `${this.journal.mother_release.dataset}-${this.journal.mother_release.snapshot_id}.json`);
    const mother = await readJson(file, this.journal.mother_ids_ref);
    if (mother.schema_version !== 'kcc-enrichment-mother-ids-v1' || JSON.stringify(mother.release) !== JSON.stringify(this.journal.mother_release) || !Array.isArray(mother.ids) || mother.ids.length !== this.journal.mother_release.record_count) {
      fail('MOTHER_IDS_INVALID', '固定母集 source IDs ref 內容不一致');
    }
    return mother.ids;
  }

  async markLegacyMigrated(legacySha256, cursor) {
    if (!SHA256.test(legacySha256) || !Number.isSafeInteger(cursor) || cursor < 0 ||
        this.journal.committed_cursor < cursor || this.journal.pending_ref) fail('CHECKPOINT_MIGRATION_INCOMPLETE', '舊 checkpoint 尚未完成等價發布');
    const next = structuredClone(this.journal);
    next.legacy_migration = { schema_version: 'kcc-legacy-migration-v1', sha256: legacySha256, cursor, completed_at: new Date().toISOString() };
    await this.#saveJournal(next);
  }

  async readWork(id) {
    safeId(id);
    const workRef = this.journal.work_ref;
    if (!workRef || workRef.id !== id) return null;
    const file = path.join(this.directory, 'work', `${sha256(Buffer.from(id))}-${workRef.ref.sha256}.json`);
    const document = await readJson(file, workRef.ref);
    if (document.id !== id || !document.work || typeof document.work !== 'object') fail('WORK_REF_INVALID', 'work record ref 身分不一致');
    assertPagesHaveNoText(document.work);
    return document.work;
  }

  async saveWork(id, work) {
    safeId(id);
    if (!work || typeof work !== 'object' || Array.isArray(work)) fail('WORK_INVALID', 'work record 必須是物件');
    assertPagesHaveNoText(work);
    const bytes = encoded({ schema_version: 'kcc-enrichment-work-v1', id, work });
    const ref = refFor(bytes);
    const file = path.join(this.directory, 'work', `${sha256(Buffer.from(id))}-${ref.sha256}.json`);
    const previous = this.journal.work_ref;
    const installed = await durableCreate(file, bytes);
    if (!installed && !refsEqual(refFor(await readFile(file)), ref)) fail('WORK_REF_INVALID', '同一 work ref 已存在但內容不同');
    const next = structuredClone(this.journal);
    next.work_ref = { id, ref };
    await this.#saveJournal(next);
    if (previous?.id === id && previous.ref.sha256 !== ref.sha256) {
      const previousFile = path.join(this.directory, 'work', `${sha256(Buffer.from(id))}-${previous.ref.sha256}.json`);
      await unlink(previousFile).catch(() => {});
      await syncDirectory(path.dirname(previousFile)).catch(() => {});
    }
    return ref;
  }

  async prepareRecord({ id, cursor, descriptors, estimatedBytes = 0, contentIndexed = true }) {
    safeId(id);
    if (cursor !== this.journal.prepared_cursor || !Array.isArray(descriptors) || !descriptors.length ||
        !Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) fail('PREPARED_CURSOR_INVALID', 'prepared record cursor、descriptors 或大小無效');
    for (const entry of descriptors) {
      if (!entry || typeof entry.dataset !== 'string' || !entry.descriptor || entry.descriptor.id !== id) fail('STAGING_DESCRIPTOR_INVALID', '同一 source record 的 v2 descriptors 需含 dataset 與一致 id');
      checkDescriptor(entry.descriptor);
    }
    const key = `${String(cursor).padStart(10, '0')}-${sha256(Buffer.from(id)).slice(0, 16)}`;
    const bytes = encoded({ schema_version: 'kcc-enrichment-descriptors-v1', id, cursor, descriptors, estimated_bytes: estimatedBytes });
    const file = path.join(this.directory, 'staged', `${key}.json`);
    const ref = refFor(bytes);
    const installed = await durableCreate(file, bytes);
    if (!installed && !refsEqual(refFor(await readFile(file)), ref)) fail('STAGED_RECORD_COLLISION', '同一 cursor 已有不同 staged descriptor bundle');
    const previousWork = this.journal.work_ref?.id === id ? this.journal.work_ref : null;
    const next = structuredClone(this.journal);
    next.batch_refs.push({ id, cursor, key, ref });
    next.batch_bytes += estimatedBytes;
    next.prepared_cursor += 1;
    next.all_content_indexed = next.all_content_indexed !== false && contentIndexed === true;
    next.work_ref = null;
    await this.#saveJournal(next);
    if (previousWork) {
      const workFile = path.join(this.directory, 'work', `${sha256(Buffer.from(id))}-${previousWork.ref.sha256}.json`);
      await unlink(workFile).catch(() => {});
      await syncDirectory(path.dirname(workFile)).catch(() => {});
    }
    return ref;
  }

  async readPreparedRecords() {
    const byDataset = new Map();
    for (const entry of this.journal.batch_refs) {
      const file = path.join(this.directory, 'staged', `${entry.key}.json`);
      const item = await readJson(file, entry.ref);
      if (item.id !== entry.id || item.cursor !== entry.cursor || !Array.isArray(item.descriptors)) fail('STAGED_RECORD_INVALID', 'staged descriptor bundle 身分不一致');
      for (const entry of item.descriptors) {
        if (!entry || typeof entry.dataset !== 'string') fail('STAGED_RECORD_INVALID', 'staged descriptor 缺少 dataset');
        checkDescriptor(entry.descriptor);
        const rows = byDataset.get(entry.dataset) || [];
        rows.push(entry.descriptor); byDataset.set(entry.dataset, rows);
      }
    }
    return Object.fromEntries([...byDataset].map(([dataset, records]) => [dataset, records]));
  }

  async writePending(batchId, candidates, baseReleases) {
    if (typeof batchId !== 'string' || !/^[a-f0-9]{32,64}$/.test(batchId) || !candidates || typeof candidates !== 'object' || Array.isArray(candidates)) fail('PENDING_INVALID', 'pending candidate 格式無效');
    const candidateEntries = {};
    for (const [dataset, candidate] of Object.entries(candidates)) {
      if (!candidate || typeof candidate !== 'object' || !candidate.header || !Array.isArray(candidate.records)) fail('PENDING_INVALID', 'pending candidate 只允許 header 與 descriptors');
      for (const descriptor of candidate.records) checkDescriptor(descriptor);
      candidateEntries[dataset] = { header: candidate.header, records: candidate.records };
    }
    const bytes = encoded({ schema_version: 'kcc-enrichment-pending-v1', batch_id: batchId, candidates: candidateEntries });
    const file = path.join(this.directory, 'pending', `${batchId}.json`);
    const ref = refFor(bytes);
    const installed = await durableCreate(file, bytes);
    if (!installed && !refsEqual(refFor(await readFile(file)), ref)) fail('PENDING_COLLISION', '同一 batch_id 已有不同 pending candidate');
    const next = structuredClone(this.journal);
    next.pending_ref = { batch_id: batchId, ref, base_releases: baseReleases, confirmed: {}, states: {} };
    await this.#saveJournal(next);
    return next.pending_ref;
  }

  async readPending() {
    const pendingRef = this.journal.pending_ref;
    if (!pendingRef) return null;
    const file = path.join(this.directory, 'pending', `${pendingRef.batch_id}.json`);
    return readJson(file, pendingRef.ref);
  }

  async updatePendingDataset(dataset, { state, receipt = null }) {
    if (!this.journal.pending_ref || !['publishing', 'unknown', 'confirmed'].includes(state)) fail('PENDING_STATE_INVALID', '沒有 pending batch 或狀態無效');
    const next = structuredClone(this.journal);
    next.pending_ref.states[dataset] = state;
    if (state === 'confirmed' && receipt) next.pending_ref.confirmed[dataset] = receipt;
    await this.#saveJournal(next);
  }

  async commitPending(receipts) {
    if (!this.journal.pending_ref) fail('PENDING_STATE_INVALID', '沒有可提交的 pending batch');
    const confirmed = this.journal.pending_ref.confirmed;
    for (const dataset of Object.keys(receipts)) {
      if (!confirmed[dataset]) fail('PENDING_STATE_INVALID', `${dataset} 尚未原生確認`);
    }
    const next = structuredClone(this.journal);
    next.committed_cursor = next.prepared_cursor;
    next.batch_refs = [];
    next.batch_bytes = 0;
    next.receipts = { ...next.receipts, ...receipts };
    const previousPending = next.pending_ref;
    next.pending_ref = null;
    await this.#saveJournal(next);
    const pendingFile = path.join(this.directory, 'pending', `${previousPending.batch_id}.json`);
    await unlink(pendingFile).catch(() => {});
    await syncDirectory(path.dirname(pendingFile)).catch(() => {});
  }

  async clearWork(id) {
    const next = structuredClone(this.journal);
    const previous = next.work_ref?.id === id ? next.work_ref : null;
    if (next.work_ref?.id === id) {
      next.work_ref = null;
      await this.#saveJournal(next);
    }
    if (previous) {
      const file = path.join(this.directory, 'work', `${sha256(Buffer.from(id))}-${previous.ref.sha256}.json`);
      await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await syncDirectory(path.dirname(file));
    }
  }
}

export const KCC_ENRICHMENT_BATCH_LIMITS = Object.freeze({
  'kcc-proposal-details': { records: 100, bytes: 8 * 1024 * 1024 },
  'kcc-proposal-attachments': { records: 100, bytes: 8 * 1024 * 1024 },
  'kcc-meeting-records': { records: 25, bytes: 8 * 1024 * 1024 },
});

export function enrichmentBatchReady(profile, stagedRecords, stagedBytes, terminal = false) {
  const dataset = profile === 'kcc-proposal-details' ? 'kcc-proposal-details' : profile === 'kcc-meeting-records' ? 'kcc-meeting-records' : null;
  if (!dataset) fail('PROFILE_INVALID', 'v2 staging 僅適用兩個 enrichment profile');
  const limits = KCC_ENRICHMENT_BATCH_LIMITS[dataset];
  if (profile === 'kcc-proposal-details') {
    return terminal || stagedRecords >= limits.records || stagedBytes >= limits.bytes;
  }
  return terminal || stagedRecords >= limits.records || stagedBytes >= limits.bytes;
}
