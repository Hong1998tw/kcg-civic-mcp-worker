import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { COLLECTION_DATASETS } from '../src/ingestion/dispatch.mjs';

const ID = /^[a-f0-9]{64}$/;
const PROFILES = new Set(['health', ...Object.keys(COLLECTION_DATASETS)]);
const CAPACITY_HELD_PROFILES = new Set(['kcc-proposal-details', 'kcc-meeting-records']);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));

function regular(file, maxBytes = 8192) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('JOB_FILE_INVALID');
  return fs.readFileSync(file);
}

function atomicJson(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function assertDirectory(directory) {
  if (path.resolve(directory) !== fs.realpathSync(directory)) throw new Error('JOB_DIRECTORY_SYMLINK');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('JOB_QUEUE_PATH_INVALID');
}

export async function dependencyReady(queueRoot, dependency, dataRoot) {
  const { LocalStore } = await import('../src/local/store.mjs');
  let store;
  try {
    store = new LocalStore(dataRoot, { readOnly: true });
    const active = (await store.queryRecords(COLLECTION_DATASETS[dependency], { limit: 0 })).release;
    if (active.coverage.complete !== true) return false;
    return fs.readdirSync(path.join(queueRoot, 'receipts')).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).some((file) => {
      const prior = JSON.parse(regular(path.join(queueRoot, 'receipts', file), 131072));
      const receipt = prior.store_readback || prior.collector?.receipt;
      return prior.profile === dependency && prior.status === 'succeeded' && receipt?.coverage?.complete === true &&
        receipt.snapshot_id === active.snapshot_id && receipt.manifest_sha256 === active.manifest_sha256 && receipt.record_count === active.record_count;
    });
  } catch (error) {
    if (error.reasonCode === 'LOCAL_DATA_UNAVAILABLE') return false;
    throw error;
  } finally { store?.close(); }
}

export function validateRequest(value, filename) {
  if (!value || Object.keys(value).some((k) => !['schema_version', 'job_id', 'profile', 'idempotency_key', 'requested_at'].includes(k)) ||
      value.schema_version !== 1 || !PROFILES.has(value.profile) || !ID.test(value.job_id) ||
      value.job_id + '.json' !== filename || typeof value.idempotency_key !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,120}$/.test(value.idempotency_key) || !Number.isFinite(Date.parse(value.requested_at)) ||
      value.job_id !== sha(Buffer.from(`${value.profile}:${value.idempotency_key}`))) throw new Error('JOB_REQUEST_INVALID');
  return value;
}

export function verifyCollectorReceipt(result, profile, exitCode) {
  if (exitCode !== 0 || !result || result.profile !== profile || !['complete', 'partial', 'paused'].includes(result.status) ||
      result.dry_run !== false || result.commit_state !== 'committed' || result.basic_validation !== 'passed' ||
      !result.receipt || !['imported', 'unchanged'].includes(result.receipt.status) || typeof result.receipt.snapshot_id !== 'string' ||
      !Number.isSafeInteger(result.record_count) || result.record_count < 1 ||
      result.receipt.record_count !== result.record_count || result.receipt.dataset !== result.dataset ||
      !ID.test(result.receipt.manifest_sha256 || '') || result.receipt.raw_objects_verified < 1 ||
      result.dataset !== COLLECTION_DATASETS[profile] ||
      result.failed !== 0) return false;
  return true;
}

export function runCollector(profile, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'local-collect.mjs'), '--profile', profile, '--root', root, '--run'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'Asia/Taipei' },
    });
    let stdout = ''; let stderr = ''; let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 180000);
    child.stdout.on('data', (b) => { stdout += b; if (stdout.length > 131072) { exceeded = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', (b) => { if (stderr.length < 4096) stderr += b; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (exceeded || code === null) return resolve({ status: 'outcome_unknown', reason_code: 'COLLECTOR_RECONCILIATION_REQUIRED' });
      const lines = stdout.trim().split('\n');
      try {
        const result = JSON.parse(lines.at(-1));
        const continuing = code === 0 && result.profile === profile && result.status === 'paused' && result.dry_run === false && result.continuation_required === true && !result.error_code;
        if (continuing) {
          const checkpoint = path.resolve(result.checkpoint_path || '');
          if (!checkpoint.startsWith(path.resolve(root) + path.sep)) throw new Error('CHECKPOINT_PATH_INVALID');
          regular(checkpoint, 256 * 1024 * 1024);
          if (!result.receipt && result.commit_state === 'not-committed') return resolve({ status: 'running', collector: result });
        }
        if (!verifyCollectorReceipt(result, profile, code)) {
          const uncertain = ['unknown', 'partial', 'committed'].includes(result.commit_state) || result.needs_reconciliation === true;
          return resolve({ status: uncertain ? 'outcome_unknown' : 'failed', reason_code: uncertain ? 'COLLECTOR_RECONCILIATION_REQUIRED' : result.error_code || 'COLLECTOR_RECEIPT_INVALID', collector: result });
        }
        const { LocalStore } = await import('../src/local/store.mjs');
        const readback = new LocalStore(root, { readOnly: true });
        try {
          const stored = await readback.queryRecords(result.dataset, { limit: 1 });
          if (stored.release.snapshot_id !== result.receipt.snapshot_id || stored.release.record_count !== result.record_count ||
              stored.release.manifest_sha256 !== result.receipt.manifest_sha256) throw new Error('COMMIT_READBACK_MISMATCH');
          resolve({ status: continuing ? 'running' : 'succeeded', collector: result, store_readback: stored.release });
        } finally { readback.close(); }
      } catch { resolve({ status: 'outcome_unknown', reason_code: 'COLLECTOR_RECONCILIATION_REQUIRED' }); }
    });
  });
}

async function processClaimed(queueRoot, dataRoot) {
  for (const name of ['', 'requests', 'processing', 'receipts', 'progress']) {
    const directory = path.join(queueRoot, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o770 });
    assertDirectory(directory);
  }
  const lastWork = (name) => { try { return fs.statSync(path.join(queueRoot, 'progress', name)).mtimeMs; } catch { return 0; } };
  const names = [...new Set([...fs.readdirSync(path.join(queueRoot, 'processing')), ...fs.readdirSync(path.join(queueRoot, 'requests'))])].sort((a, b) => lastWork(a) - lastWork(b) || a.localeCompare(b));
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const requestFile = path.join(queueRoot, 'requests', name);
    const activeFile = path.join(queueRoot, 'processing', name);
    const receiptFile = path.join(queueRoot, 'receipts', name);
    const progressFile = path.join(queueRoot, 'progress', name);
    if (fs.existsSync(receiptFile)) continue;
    if (!fs.existsSync(activeFile)) {
      try { fs.renameSync(requestFile, activeFile); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    }
    const started = new Date().toISOString();
    let request;
    try {
      request = validateRequest(JSON.parse(regular(activeFile)), name);
      if (CAPACITY_HELD_PROFILES.has(request.profile) && process.env.KCG_ENRICHMENT_ENABLED === 'false') {
        atomicJson(progressFile, {
          schema_version: 1,
          job_id: request.job_id,
          profile: request.profile,
          idempotency_key: request.idempotency_key,
          status: 'held_capacity_review',
          reason_code: 'ENRICHMENT_STORAGE_UPGRADE_REQUIRED',
          updated_at: new Date().toISOString(),
        });
        continue;
      }
      const prerequisite = ({ 'kcc-proposal-details': 'kcc-proposals-full', 'kcc-meeting-records': 'kcc-meetings-full' })[request.profile];
      if (prerequisite) {
        const complete = await dependencyReady(queueRoot, prerequisite, dataRoot);
        if (!complete) { atomicJson(progressFile, { schema_version: 1, job_id: request.job_id, profile: request.profile, status: 'waiting_dependency', dependency: prerequisite }); continue; }
      }
      let result;
      if (request.profile === 'health') {
        const bytes = Buffer.from('kcg-civic-local-storage-v1\n');
        const healthDir = path.join(dataRoot, '_health');
        fs.mkdirSync(healthDir, { recursive: true, mode: 0o700 });
        assertDirectory(healthDir);
        const file = path.join(healthDir, 'persistence-proof.txt');
        if (!fs.existsSync(file)) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        if (!regular(file).equals(bytes)) throw new Error('STORAGE_READBACK_MISMATCH');
        result = { status: 'succeeded', health: { status: 'PASS', bytes: bytes.length, sha256: sha(bytes), root: dataRoot } };
      } else result = await runCollector(request.profile, dataRoot);
      const receipt = { schema_version: 1, job_id: request.job_id, profile: request.profile, started_at: started, finished_at: new Date().toISOString(), ...result };
      if (result.status === 'running') {
        let previous = null;
        try { previous = JSON.parse(regular(progressFile, 131072)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const stalled = (result.collector?.attempted ?? 0) === 0 && previous?.collector?.record_count === result.collector?.record_count;
        const stallCount = stalled ? (previous.stall_count || 0) + 1 : 0;
        if (stallCount >= 3) {
          receipt.status = 'outcome_unknown'; receipt.reason_code = 'COLLECTION_STALLED_RECONCILE_CHECKPOINT';
          atomicJson(receiptFile, receipt);
        } else atomicJson(progressFile, { ...receipt, stall_count: stallCount });
        return receipt;
      }
      atomicJson(receiptFile, receipt);
      return receipt;
    } catch (error) {
      const receipt = { schema_version: 1, job_id: name.slice(0, -5), profile: request?.profile || null, status: 'failed', reason_code: /^\w+$/.test(error.message) ? error.message : 'JOB_FAILED', started_at: started, finished_at: new Date().toISOString() };
      atomicJson(receiptFile, receipt);
      return receipt;
    }
  }
  return null;
}

export async function processOne(queueRoot, dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  assertDirectory(dataRoot);
  const coordinatorPath = path.join(dataRoot, 'job-coordinator.sqlite');
  if (fs.existsSync(coordinatorPath)) regular(coordinatorPath, 1048576);
  const coordinator = new DatabaseSync(coordinatorPath);
  try {
    coordinator.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch (error) {
    coordinator.close();
    if (String(error.message).includes('locked')) return null;
    throw error;
  }
  try {
    const receipt = await processClaimed(queueRoot, dataRoot);
    coordinator.exec('COMMIT');
    return receipt;
  } catch (error) {
    coordinator.exec('ROLLBACK');
    throw error;
  } finally { coordinator.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const queueRoot = process.env.KCG_JOB_ROOT;
  const dataRoot = process.env.KCG_DATA_ROOT;
  if (!queueRoot || !dataRoot) throw new Error('KCG_JOB_ROOT_AND_DATA_ROOT_REQUIRED');
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping) {
    const receipt = await processOne(queueRoot, dataRoot);
    if (receipt) console.log(JSON.stringify({ job_id: receipt.job_id, profile: receipt.profile, status: receipt.status, reason_code: receipt.reason_code }));
    if (process.argv.includes('--once')) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
