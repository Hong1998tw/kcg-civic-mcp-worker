import { createHash } from "node:crypto";
import { open, mkdir, readFile, link, unlink, rename } from "node:fs/promises";
import { lstatSync, mkdirSync as makeDirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DB_NAME = "index.sqlite";
const MAX_RECORDS = 100_000;
const MAX_RECORD_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const REVOKED_NORMALIZED_SHA256 = {
  "kcg-laws": new Set(["152d0dc2c8e25367e5b09a81bf5b35d73f6ea11a17877be6222e0cc0373d68a3"]),
  "kcg-news": new Set(["9ac6851713ad29a410e156d54e9f636c480113d3a920a363b44e4586e40281f9"]),
};

const ALLOWED_DATASETS = new Set([
  "kcg-laws",
  "kcg-news",
  "kcc-proposals",
  "kcc-proposals-pilot",
  "kcc-proposal-details",
  "kcc-proposal-attachments",
  "kcc-meetings",
  "kcc-meeting-records",
  "kcc-councilors",
  "kcc-committees",
  "kcc-temporary-proposals",
]);

export class LocalStoreError extends Error {
  constructor(reasonCode, message) {
    super(`${reasonCode}: ${message}`);
    this.name = "LocalStoreError";
    this.reasonCode = reasonCode;
  }
}

function fail(code, message) {
  throw new LocalStoreError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${entries.join(",")}}`;
}

function normalizeCoverage(value, recordCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SNAPSHOT_UNVERIFIED", "coverage 必須是物件");
  }
  const scope = typeof value.scope === "string" ? value.scope.trim() : "";
  if (!scope || scope.length > 1000 || typeof value.complete !== "boolean") {
    fail("SNAPSHOT_UNVERIFIED", "coverage 缺少有效 scope 或 complete");
  }
  const sourceTotal = value.source_total ?? null;
  if (sourceTotal !== null && (!Number.isSafeInteger(sourceTotal) || sourceTotal < 0)) {
    fail("SNAPSHOT_UNVERIFIED", "coverage.source_total 必須是非負整數或 null");
  }
  if (sourceTotal !== null && recordCount > sourceTotal) {
    fail("SNAPSHOT_UNVERIFIED", "records 數量超過來源宣告總數");
  }
  if (value.complete && sourceTotal !== null && recordCount !== sourceTotal) {
    fail("SNAPSHOT_UNVERIFIED", "完整 coverage 的 record_count 與 source_total 不一致");
  }
  return { scope, complete: value.complete, source_total: sourceTotal };
}

function officialHosts(dataset) {
  if (/^kcg-budget-\d{1,3}$/.test(dataset)) return new Set(["openapi.kcg.gov.tw", "data.kcg.gov.tw"]);
  if (dataset === "kcg-laws") return new Set(["outlaw.kcg.gov.tw"]);
  if (dataset === "kcg-news") return new Set(["www.kcg.gov.tw"]);
  if (dataset.startsWith("kcc-")) return new Set(["cissearch.kcc.gov.tw"]);
  return null;
}

function normalizeSourceUrl(value, dataset) {
  if (typeof value !== "string" || value.length > 4096) {
    fail("SNAPSHOT_UNVERIFIED", "record.source_url 必須是有效官方網址");
  }
  let url;
  try { url = new URL(value); } catch { fail("SNAPSHOT_UNVERIFIED", "record.source_url 格式無效"); }
  const hosts = officialHosts(dataset);
  if (!hosts || url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.port) {
    fail("SNAPSHOT_UNVERIFIED", `dataset=${dataset} 的 source_url 不符合官方 HTTPS 網域`);
  }
  return url.toString();
}

function normalizeRetrievedAt(value) {
  if (typeof value !== "string" || value.length > 80 || !Number.isFinite(Date.parse(value))) {
    fail("SNAPSHOT_UNVERIFIED", "record.retrieved_at 必須是有效時間");
  }
  return value;
}

function normalizeRecord(record, dataset) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("SNAPSHOT_UNVERIFIED", "record 必須是物件");
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const title = typeof record.title === "string" ? record.title : "";
  const text = typeof record.text === "string" ? record.text : "";
  if (!/^[A-Za-z0-9._:#/-]{1,512}$/.test(id)) fail("SNAPSHOT_UNVERIFIED", "record.id 必須使用安全 ASCII 識別碼");
  if (title.length > MAX_RECORD_TEXT_BYTES || text.length > MAX_RECORD_TEXT_BYTES) {
    fail("SNAPSHOT_UNVERIFIED", `record ${id} 超過單筆文字大小上限`);
  }
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
    fail("SNAPSHOT_UNVERIFIED", `record ${id} 的 data 必須是 JSON 物件`);
  }
  if (typeof record.raw_sha256 !== "string" || !SHA256_RE.test(record.raw_sha256)) {
    fail("SNAPSHOT_UNVERIFIED", `record ${id} 缺少有效 raw_sha256`);
  }
  let json;
  try { json = canonical(record.data); JSON.parse(json); } catch {
    fail("SNAPSHOT_UNVERIFIED", `record ${id} 的 data 無法正規化為 JSON`);
  }
  const data = JSON.parse(json);
  const identityField = dataset === "kcg-laws" ? "law_id"
    : dataset === "kcg-news" ? "news_id"
      : dataset.startsWith("kcc-proposals") || dataset === "kcc-proposal-details" ? "proposal_sn"
        : dataset === "kcc-meetings" ? "record_id"
          : null;
  if (identityField && data[identityField] !== undefined && String(data[identityField]) !== id) {
    fail("SOURCE_ID_MISMATCH", `record ${id} 與 data.${identityField} 不一致`);
  }
  return {
    id,
    title,
    text,
    json,
    data,
    source_url: normalizeSourceUrl(record.source_url, dataset),
    retrieved_at: normalizeRetrievedAt(record.retrieved_at),
    raw_sha256: record.raw_sha256.toLowerCase(),
  };
}

function manifestDigest({ dataset, snapshot_id, coverage, parser_version, validator_version, records }) {
  const hash = createHash("sha256");
  hash.update(canonical({
    dataset,
    snapshot_id,
    record_count: records.length,
    coverage,
    parser_version,
    validator_version,
    validation_status: "passed",
  }));
  for (const record of records) {
    hash.update("\n");
    hash.update(canonical({
      id: record.id,
      title: record.title,
      text: record.text,
      json: record.data,
      source_url: record.source_url,
      retrieved_at: record.retrieved_at,
      raw_sha256: record.raw_sha256,
    }));
  }
  return hash.digest("hex");
}

function normalizedDataDigest(dataset, records) {
  const digest = sha256(Buffer.from(canonical(records.map((record) => record.data))));
  assertNotRevoked(dataset, digest);
  return digest;
}

function assertNotRevoked(dataset, digest) {
  if (REVOKED_NORMALIZED_SHA256[dataset]?.has(digest)) fail("SNAPSHOT_REVOKED", `dataset=${dataset} normalized SHA-256 已列入撤銷清單`);
}

function toSnapshotDocument(snapshot, manifestSha) {
  return {
    schema_version: "local-snapshot-v1",
    dataset: snapshot.dataset,
    snapshot_id: snapshot.snapshot_id,
    record_count: snapshot.records.length,
    coverage: snapshot.coverage,
    parser_version: snapshot.parser_version,
    validator_version: snapshot.validator_version,
    validation_status: "passed",
    manifest_sha256: manifestSha,
    records: snapshot.records.map((record) => ({
      id: record.id,
      title: record.title,
      text: record.text,
      data: record.data,
      source_url: record.source_url,
      retrieved_at: record.retrieved_at,
      raw_sha256: record.raw_sha256,
    })),
  };
}

function validateSnapshotInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("SNAPSHOT_UNVERIFIED", "snapshot 必須是物件");
  const dataset = typeof input.dataset === "string" ? input.dataset.trim() : "";
  if (!ALLOWED_DATASETS.has(dataset) && !/^kcg-budget-\d{1,3}$/.test(dataset)) {
    fail("FEATURE_UNAVAILABLE", `未設定 dataset=${dataset} 的官方來源 allowlist`);
  }
  const snapshotId = typeof input.snapshot_id === "string" ? input.snapshot_id.trim() : "";
  if (!snapshotId || snapshotId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(snapshotId)) {
    fail("SNAPSHOT_UNVERIFIED", "snapshot_id 格式無效");
  }
  if (input.validation_status !== "passed") fail("SNAPSHOT_UNVERIFIED", "snapshot 尚未通過 validation");
  const parserVersion = typeof input.parser_version === "string" ? input.parser_version.trim() : "";
  const validatorVersion = typeof input.validator_version === "string" ? input.validator_version.trim() : "";
  if (!parserVersion || parserVersion.length > 100 || !validatorVersion || validatorVersion.length > 100) {
    fail("SNAPSHOT_UNVERIFIED", "parser_version 與 validator_version 必填");
  }
  if (!Array.isArray(input.records) || input.records.length > MAX_RECORDS) {
    fail("SNAPSHOT_UNVERIFIED", `records 必須是最多 ${MAX_RECORDS} 筆的陣列`);
  }
  const records = input.records.map((record) => normalizeRecord(record, dataset)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    fail("SOURCE_ID_MISMATCH", "同一 snapshot 含重複 record.id");
  }
  const totalBytes = records.reduce((sum, record) => sum + Buffer.byteLength(record.title) + Buffer.byteLength(record.text) + Buffer.byteLength(record.json), 0);
  if (totalBytes > MAX_SNAPSHOT_BYTES) fail("SNAPSHOT_UNVERIFIED", "snapshot 正規化內容超過 256 MiB 上限");
  const coverage = normalizeCoverage(input.coverage, records.length);
  const rawObjects = Array.isArray(input.raw_objects) ? input.raw_objects : [];
  const normalizedRaw = new Map();
  for (const object of rawObjects) {
    if (!object || typeof object !== "object" || typeof object.sha256 !== "string" || !SHA256_RE.test(object.sha256) || typeof object.bytes_base64 !== "string") {
      fail("SNAPSHOT_UNVERIFIED", "raw_objects 項目格式無效");
    }
    const bytes = Buffer.from(object.bytes_base64, "base64");
    if (!bytes.length || bytes.toString("base64") !== object.bytes_base64 || sha256(bytes) !== object.sha256.toLowerCase()) {
      fail("SNAPSHOT_UNVERIFIED", `raw object ${object.sha256} 的 base64 或 SHA-256 不一致`);
    }
    const key = object.sha256.toLowerCase();
    const previous = normalizedRaw.get(key);
    if (previous && !previous.equals(bytes)) fail("SNAPSHOT_UNVERIFIED", `raw object ${key} 重複但內容不同`);
    normalizedRaw.set(key, bytes);
  }
  return {
    dataset,
    snapshot_id: snapshotId,
    records,
    coverage,
    parser_version: parserVersion,
    validator_version: validatorVersion,
    raw_objects: normalizedRaw,
  };
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
CREATE TABLE IF NOT EXISTS collections (
  dataset TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  json TEXT NOT NULL,
  source_url TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  PRIMARY KEY (dataset, id)
);
CREATE INDEX IF NOT EXISTS collections_dataset_idx ON collections(dataset);
CREATE TABLE IF NOT EXISTS releases (
  dataset TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  coverage_json TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  validator_version TEXT NOT NULL
);
`;

export class LocalStore {
  constructor(root, options = {}) {
    if (typeof root !== "string" || !root.trim()) throw new TypeError("LocalStore root is required");
    this.root = path.resolve(root);
    this.readOnly = options.readOnly !== false;
    this.rawVerificationCache = new Map();
    this.dbPath = path.join(this.root, DB_NAME);
    if (!this.readOnly) {
      // The ingestion process is the only writer. DELETE journaling keeps the
      // query runtime independent from live WAL/SHM sidecars.
      mkdirSync(this.root);
      if (pathEntryIsSymlink(this.dbPath)) fail("SNAPSHOT_UNVERIFIED", "index.sqlite 不可為 symlink");
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA busy_timeout=3000");
      this.db.exec(SCHEMA);
    } else {
      try {
        assertPlainDirectorySync(this.root, "本機資料根目錄");
        if (!isFile(this.dbPath)) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫尚未初始化");
        this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      } catch (error) {
        if (error instanceof LocalStoreError) throw error;
        fail("LOCAL_DATA_UNAVAILABLE", "無法以唯讀模式開啟本機資料庫");
      }
      this.#assertSchema();
    }
  }

  #assertSchema() {
    try {
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      if (!tables.has("collections") || !tables.has("releases")) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫 schema 尚未初始化");
      const collectionColumns = new Set(this.db.prepare("PRAGMA table_info(collections)").all().map((row) => row.name));
      const releaseColumns = new Set(this.db.prepare("PRAGMA table_info(releases)").all().map((row) => row.name));
      for (const name of ["dataset", "id", "title", "text", "json", "source_url", "retrieved_at", "raw_sha256"]) {
        if (!collectionColumns.has(name)) fail("LOCAL_DATA_UNAVAILABLE", `collections 缺少 ${name} 欄位`);
      }
      for (const name of ["dataset", "snapshot_id", "record_count", "coverage_json", "manifest_sha256", "parser_version", "validator_version"]) {
        if (!releaseColumns.has(name)) fail("LOCAL_DATA_UNAVAILABLE", `releases 缺少 ${name} 欄位`);
      }
    } catch (error) {
      if (error instanceof LocalStoreError) throw error;
      fail("LOCAL_DATA_UNAVAILABLE", "無法讀取本機資料庫 schema");
    }
  }

  async putRawObject({ sha256: expectedHash, bytes_base64: base64 }) {
    this.#assertWritable();
    if (typeof expectedHash !== "string" || !SHA256_RE.test(expectedHash) || typeof base64 !== "string") {
      fail("SNAPSHOT_UNVERIFIED", "raw object 欄位格式無效");
    }
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.toString("base64") !== base64 || sha256(bytes) !== expectedHash.toLowerCase()) {
      fail("SNAPSHOT_UNVERIFIED", `raw object ${expectedHash} 的 SHA-256 不一致`);
    }
    return await this.#writeRawBytes(expectedHash.toLowerCase(), bytes);
  }

  async readRawObject(hash, maxBytes = 32 * 1024 * 1024) {
    if (!SHA256_RE.test(hash) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) {
      fail("SNAPSHOT_UNVERIFIED", "原始檔讀取參數無效");
    }
    await this.#verifyRawObject(hash);
    const rawPath = this.#rawPath(hash);
    if (lstatSync(rawPath).size > maxBytes) fail("PARTIAL_SCAN", "原始檔超過讀取上限");
    const bytes = await readFile(rawPath);
    if (sha256(bytes) !== hash.toLowerCase()) fail("SNAPSHOT_UNVERIFIED", "原始檔讀回雜湊不一致");
    return bytes;
  }

  async #writeRawBytes(hash, bytes) {
    const destination = this.#rawPath(hash);
    assertExistingDirectoriesSync([
      this.root,
      path.join(this.root, "raw"),
      path.join(this.root, "raw", "sha256"),
      path.dirname(destination),
    ], "content-addressed raw 路徑");
    await mkdir(path.dirname(destination), { recursive: true });
    for (const directory of [this.root, path.join(this.root, "raw"), path.join(this.root, "raw", "sha256"), path.dirname(destination)]) {
      assertPlainDirectorySync(directory, "content-addressed raw 路徑");
    }
    try {
      const info = lstatSync(destination);
      if (info.isSymbolicLink() || !info.isFile()) fail("SNAPSHOT_UNVERIFIED", `既有 raw object ${hash} 不是一般檔案`);
      const existing = await readFile(destination);
      if (sha256(existing) !== hash) fail("SNAPSHOT_UNVERIFIED", `既有 raw object ${hash} 內容遭竄改`);
      return { sha256: hash, stored: false };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, destination);
      return { sha256: hash, stored: true };
    } catch (error) {
      if (error?.code === "EEXIST") {
        await this.#verifyRawObject(hash);
        return { sha256: hash, stored: false };
      }
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error;
      if (pathEntryIsSymlink(destination)) fail("SNAPSHOT_UNVERIFIED", `raw object ${hash} 不可為 symlink`);
      try { await lstatSync(destination); await this.#verifyRawObject(hash); return { sha256: hash, stored: false }; }
      catch (existingError) { if (existingError?.code !== "ENOENT") throw existingError; }
      await rename(temporary, destination);
      return { sha256: hash, stored: true };
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  #rawPath(hash) {
    if (!SHA256_RE.test(hash)) fail("SNAPSHOT_UNVERIFIED", "raw SHA-256 格式無效");
    return path.join(this.root, "raw", "sha256", hash.slice(0, 2), hash.toLowerCase());
  }

  async #verifyRawObject(hash) {
    let bytes;
    const rawPath = this.#rawPath(hash);
    const signature = (info) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    let before;
    try {
      const info = lstatSync(rawPath, { bigint: true });
      if (info.isSymbolicLink() || !info.isFile()) fail("SNAPSHOT_UNVERIFIED", `raw object ${hash} 不是一般檔案`);
      before = signature(info);
      if (this.rawVerificationCache.get(hash) === before) return true;
      bytes = await readFile(rawPath);
    } catch (error) {
      if (error?.code === "ENOENT") fail("SNAPSHOT_UNVERIFIED", `缺少 content-addressed raw object ${hash}`);
      throw error;
    }
    if (sha256(bytes) !== hash.toLowerCase()) fail("SNAPSHOT_UNVERIFIED", `raw object ${hash} 內容遭竄改`);
    const after = lstatSync(rawPath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || signature(after) !== before) fail("SNAPSHOT_UNVERIFIED", `raw object ${hash} 在驗證期間改變`);
    this.rawVerificationCache.delete(hash);
    this.rawVerificationCache.set(hash, before);
    if (this.rawVerificationCache.size > 2048) this.rawVerificationCache.delete(this.rawVerificationCache.keys().next().value);
    return true;
  }

  async importSnapshot(input) {
    this.#assertWritable();
    const snapshot = validateSnapshotInput(input);
    const rawHashes = new Set(snapshot.records.map((record) => record.raw_sha256));
    let rawWritten = 0;
    for (const [hash, bytes] of snapshot.raw_objects) {
      const result = await this.#writeRawBytes(hash, bytes);
      if (result.stored) rawWritten += 1;
    }
    let rawVerified = 0;
    for (const hash of rawHashes) {
      if (snapshot.raw_objects.has(hash)) {
        rawVerified += 1;
        continue;
      }
      await this.#verifyRawObject(hash);
      rawVerified += 1;
    }
    const manifestSha = manifestDigest(snapshot);
    normalizedDataDigest(snapshot.dataset, snapshot.records);
    await this.#writeSnapshotArchive(snapshot, manifestSha);
    const existing = this.db.prepare("SELECT * FROM releases WHERE dataset = ?").get(snapshot.dataset);
    if (existing?.snapshot_id === snapshot.snapshot_id) {
      if (existing.manifest_sha256 !== manifestSha) fail("SOURCE_ID_MISMATCH", "同一 snapshot_id 內容不同，拒絕覆寫");
      const current = await this.queryRecords(snapshot.dataset, { limit: 1 });
      if (current.release.manifest_sha256 !== manifestSha) fail("SNAPSHOT_UNVERIFIED", "既有 snapshot 驗證失敗");
      return this.#receipt("unchanged", snapshot, manifestSha, rawVerified, rawWritten, true);
    }

    const insert = this.db.prepare(`INSERT INTO collections
      (dataset,id,title,text,json,source_url,retrieved_at,raw_sha256) VALUES (?,?,?,?,?,?,?,?)`);
    const replace = this.db.prepare(`INSERT INTO releases
      (dataset,snapshot_id,record_count,coverage_json,manifest_sha256,parser_version,validator_version)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET
      snapshot_id=excluded.snapshot_id, record_count=excluded.record_count,
      coverage_json=excluded.coverage_json, manifest_sha256=excluded.manifest_sha256,
      parser_version=excluded.parser_version, validator_version=excluded.validator_version`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM collections WHERE dataset = ?").run(snapshot.dataset);
      for (const record of snapshot.records) {
        insert.run(snapshot.dataset, record.id, record.title, record.text, record.json,
          record.source_url, record.retrieved_at, record.raw_sha256);
      }
      replace.run(snapshot.dataset, snapshot.snapshot_id, snapshot.records.length,
        canonical(snapshot.coverage), manifestSha, snapshot.parser_version, snapshot.validator_version);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.#receipt("imported", snapshot, manifestSha, rawVerified, rawWritten, false);
  }

  #receipt(status, snapshot, manifestSha, rawVerified, rawWritten, idempotent) {
    return {
      status,
      dataset: snapshot.dataset,
      snapshot_id: snapshot.snapshot_id,
      record_count: snapshot.records.length,
      coverage: snapshot.coverage,
      manifest_sha256: manifestSha,
      raw_objects_verified: rawVerified,
      raw_objects_written: rawWritten,
      idempotent,
    };
  }

  #snapshotPath(dataset, snapshotId) {
    if ((!ALLOWED_DATASETS.has(dataset) && !/^kcg-budget-\d{1,3}$/.test(dataset)) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId)) {
      fail("SNAPSHOT_UNVERIFIED", "snapshot archive path 身分無效");
    }
    return path.join(this.root, "snapshots", dataset, `${snapshotId}.json`);
  }

  async #writeSnapshotArchive(snapshot, manifestSha) {
    const destination = this.#snapshotPath(snapshot.dataset, snapshot.snapshot_id);
    const directory = path.dirname(destination);
    assertExistingDirectoriesSync([this.root, path.join(this.root, "snapshots"), directory], "snapshot archive 路徑");
    await mkdir(directory, { recursive: true });
    assertPlainDirectorySync(this.root, "本機資料根目錄");
    assertPlainDirectorySync(path.join(this.root, "snapshots"), "snapshot archive 根目錄");
    assertPlainDirectorySync(directory, "snapshot archive dataset 目錄");
    const document = toSnapshotDocument(snapshot, manifestSha);
    const bytes = Buffer.from(canonical(document));
    try {
      const info = lstatSync(destination);
      if (info.isSymbolicLink() || !info.isFile()) fail("SNAPSHOT_UNVERIFIED", "既有 snapshot archive 必須是一般檔案");
      const existing = JSON.parse(await readFile(destination, "utf8"));
      const verified = await this.#normalizeSnapshotDocument(existing, snapshot.dataset, snapshot.snapshot_id);
      if (verified.manifest_sha256 !== manifestSha) fail("SOURCE_ID_MISMATCH", "同一 snapshot_id archive 內容不同，拒絕覆寫");
      return { stored: false };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code === "EEXIST") {
        const existing = JSON.parse(await readFile(destination, "utf8"));
        const verified = await this.#normalizeSnapshotDocument(existing, snapshot.dataset, snapshot.snapshot_id);
        if (verified.manifest_sha256 !== manifestSha) fail("SOURCE_ID_MISMATCH", "同一 snapshot_id archive 內容不同，拒絕覆寫");
        return { stored: false };
      }
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error;
      if (pathEntryIsSymlink(destination)) fail("SNAPSHOT_UNVERIFIED", "snapshot archive 不可為 symlink");
      try { await lstatSync(destination); fail("SOURCE_ID_MISMATCH", "snapshot archive 已存在，拒絕覆寫"); }
      catch (existingError) { if (existingError?.code !== "ENOENT") throw existingError; }
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return { stored: true };
  }

  async #normalizeSnapshotDocument(document, expectedDataset, expectedId) {
    if (!document || document.schema_version !== "local-snapshot-v1" || document.validation_status !== "passed" ||
        document.dataset !== expectedDataset || document.snapshot_id !== expectedId || !Array.isArray(document.records) ||
        document.record_count !== document.records.length || !SHA256_RE.test(document.manifest_sha256)) {
      fail("SNAPSHOT_UNVERIFIED", "snapshot archive manifest 格式無效");
    }
    const snapshot = validateSnapshotInput({ ...document, raw_objects: [] });
    const manifestSha = manifestDigest(snapshot);
    normalizedDataDigest(snapshot.dataset, snapshot.records);
    if (manifestSha !== document.manifest_sha256.toLowerCase()) fail("SNAPSHOT_UNVERIFIED", "snapshot archive manifest SHA-256 不一致");
    return { ...snapshot, manifest_sha256: manifestSha };
  }

  async readSnapshotVersion(dataset, snapshotId) {
    if (!this.db) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    const archivePath = this.#snapshotPath(dataset, snapshotId);
    assertExistingDirectoriesSync([this.root, path.join(this.root, "snapshots"), path.dirname(archivePath)], "snapshot archive 路徑");
    let info;
    try { info = lstatSync(archivePath); } catch (error) {
      if (error?.code === "ENOENT") fail("LOCAL_DATA_UNAVAILABLE", `snapshot_id=${snapshotId} archive 不存在`);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) fail("SNAPSHOT_UNVERIFIED", "snapshot archive 必須是一般檔案");
    let document;
    try { document = JSON.parse(await readFile(archivePath, "utf8")); } catch { fail("SNAPSHOT_UNVERIFIED", "snapshot archive JSON 無效"); }
    const snapshot = await this.#normalizeSnapshotDocument(document, dataset, snapshotId);
    for (const hash of new Set(snapshot.records.map((record) => record.raw_sha256))) await this.#verifyRawObject(hash);
    return {
      dataset: snapshot.dataset,
      snapshot_id: snapshot.snapshot_id,
      record_count: snapshot.records.length,
      coverage: snapshot.coverage,
      parser_version: snapshot.parser_version,
      validator_version: snapshot.validator_version,
      validation_status: "passed",
      manifest_sha256: snapshot.manifest_sha256,
      records: snapshot.records.map(({ id, title, text, data, source_url, retrieved_at, raw_sha256 }) => ({
        id, title, text, data, source_url, retrieved_at, raw_sha256,
      })),
    };
  }

  async restoreSnapshot(dataset, snapshotId) {
    this.#assertWritable();
    const historical = await this.readSnapshotVersion(dataset, snapshotId);
    return await this.importSnapshot({ ...historical, raw_objects: [] });
  }

  async queryRecords(dataset, options = {}) {
    if (!this.db) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    const reader = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      reader.exec("PRAGMA busy_timeout=3000; BEGIN DEFERRED");
      return await this.#queryRecordsSnapshot(dataset, options, reader);
    } finally {
      try { reader.exec("ROLLBACK"); } catch {}
      reader.close();
    }
  }

  async #queryRecordsSnapshot(dataset, options, reader) {
    if (!this.db) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    if (!ALLOWED_DATASETS.has(dataset) && !/^kcg-budget-\d{1,3}$/.test(dataset)) {
      fail("FEATURE_UNAVAILABLE", `未設定 dataset=${dataset} 的本機查詢`);
    }
    const releaseRow = reader.prepare("SELECT * FROM releases WHERE dataset = ?").get(dataset);
    if (!releaseRow) fail("LOCAL_DATA_UNAVAILABLE", `dataset=${dataset} 尚無本機 snapshot`);
    let coverage;
    try { coverage = normalizeCoverage(JSON.parse(releaseRow.coverage_json), releaseRow.record_count); }
    catch (error) {
      if (error instanceof LocalStoreError) throw error;
      fail("SNAPSHOT_UNVERIFIED", `dataset=${dataset} coverage JSON 無效`);
    }
    const limit = options.limit === undefined ? 100 : Number(options.limit);
    const offset = options.offset === undefined ? 0 : Number(options.offset);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      fail("FILTER_NOT_CONFIRMED", "limit 或 offset 超出本機查詢範圍");
    }
    const predicate = typeof options.predicate === "function" ? options.predicate : () => true;
    const order = options.orderBy;
    if (order !== undefined && (!order || !["published_at", "date", "meeting_date"].includes(order.field) ||
        typeof order.descending !== "boolean" || offset + limit > 1000)) {
      fail("FILTER_NOT_CONFIRMED", "本機排序欄位或頁面範圍無效");
    }
    const compare = (left, right) => {
      const a = String(left.data[order.field] ?? "");
      const b = String(right.data[order.field] ?? "");
      const difference = a < b ? -1 : a > b ? 1 : 0;
      return (order.descending ? -difference : difference) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    };
    const keyword = typeof options.keyword === "string" ? options.keyword.trim() : "";
    if (keyword.length > 200) fail("FILTER_NOT_CONFIRMED", "keyword 不可超過 200 字元");
    const hash = createHash("sha256");
    hash.update(canonical({
      dataset,
      snapshot_id: releaseRow.snapshot_id,
      record_count: releaseRow.record_count,
      coverage,
      parser_version: releaseRow.parser_version,
      validator_version: releaseRow.validator_version,
      validation_status: "passed",
    }));
    const selected = [];
    let recordCount = 0;
    let localMatchCount = 0;
    let sourceUrl = "";
    let latestRetrievedAt = "";
    let totalBytes = 0;
    const normalizedHash = createHash("sha256");
    normalizedHash.update("[");
    const rows = reader.prepare(`SELECT id,title,text,json,source_url,retrieved_at,raw_sha256
      FROM collections WHERE dataset=? ORDER BY id COLLATE BINARY`).iterate(dataset);
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.json); } catch { fail("SNAPSHOT_UNVERIFIED", `record ${row.id} 的 json 無效`); }
      if (!data || typeof data !== "object" || Array.isArray(data) || !SHA256_RE.test(row.raw_sha256)) {
        fail("SNAPSHOT_UNVERIFIED", `record ${row.id} 結構或 raw_sha256 無效`);
      }
      const record = {
        id: row.id,
        title: row.title,
        text: row.text,
        json: canonical(data),
        data,
        source_url: normalizeSourceUrl(row.source_url, dataset),
        retrieved_at: normalizeRetrievedAt(row.retrieved_at),
        raw_sha256: row.raw_sha256.toLowerCase(),
      };
      hash.update("\n");
      hash.update(canonical({
        id: record.id,
        title: record.title,
        text: record.text,
        json: record.data,
        source_url: record.source_url,
        retrieved_at: record.retrieved_at,
        raw_sha256: record.raw_sha256,
      }));
      if (recordCount > 0) normalizedHash.update(",");
      normalizedHash.update(canonical(record.data));
      recordCount += 1;
      totalBytes += Buffer.byteLength(record.title) + Buffer.byteLength(record.text) + Buffer.byteLength(record.json);
      if (totalBytes > MAX_SNAPSHOT_BYTES) fail("SNAPSHOT_UNVERIFIED", "資料庫 snapshot 超過大小上限");
      sourceUrl ||= record.source_url;
      if (!latestRetrievedAt || Date.parse(record.retrieved_at) > Date.parse(latestRetrievedAt)) latestRetrievedAt = record.retrieved_at;
      const matchesKeyword = !keyword || record.title.includes(keyword) || record.text.includes(keyword) || record.json.includes(keyword);
      const matchesPredicate = predicate(record);
      if (!matchesKeyword || !matchesPredicate) continue;
      if (order && offset + limit > 0) {
        let low = 0;
        let high = selected.length;
        while (low < high) { const middle = (low + high) >>> 1; if (compare(selected[middle], record) <= 0) low = middle + 1; else high = middle; }
        selected.splice(low, 0, record);
        if (selected.length > offset + limit) selected.pop();
      } else if (!order && localMatchCount >= offset && selected.length < limit) selected.push(record);
      localMatchCount += 1;
    }
    normalizedHash.update("]");
    assertNotRevoked(dataset, normalizedHash.digest("hex"));
    const actualDigest = hash.digest("hex");
    if (recordCount !== releaseRow.record_count || actualDigest !== releaseRow.manifest_sha256) {
      fail("SNAPSHOT_UNVERIFIED", `dataset=${dataset} 資料列與 manifest 不一致`);
    }
    if (recordCount === 0) fail("LOCAL_DATA_UNAVAILABLE", `dataset=${dataset} snapshot 沒有可查資料`);
    const outputRecords = order ? selected.slice(offset, offset + limit) : selected;
    const verifiedRaw = new Set();
    for (const record of outputRecords) {
      if (verifiedRaw.has(record.raw_sha256)) continue;
      await this.#verifyRawObject(record.raw_sha256);
      verifiedRaw.add(record.raw_sha256);
    }
    return {
      release: {
        dataset,
        snapshot_id: releaseRow.snapshot_id,
        record_count: recordCount,
        coverage,
        manifest_sha256: releaseRow.manifest_sha256,
        parser_version: releaseRow.parser_version,
        validator_version: releaseRow.validator_version,
        source_url: sourceUrl,
        retrieved_at: latestRetrievedAt,
      },
      records: outputRecords,
      local_match_count: localMatchCount,
      order_by: order ? { field: order.field, descending: order.descending, scope: "entire_verified_snapshot" } : null,
    };
  }

  async hasDataset(dataset) {
    if (!this.db) return false;
    return !!this.db.prepare("SELECT 1 AS found FROM releases WHERE dataset = ?").get(dataset);
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }

  #assertWritable() {
    if (this.readOnly) fail("LOCAL_DATA_UNAVAILABLE", "query runtime 使用唯讀資料庫；請由獨立 ingestion process 寫入");
  }
}

function mkdirSync(root) {
  // DatabaseSync is synchronous; keep directory creation synchronous at this
  // boundary so the required constructor(root) remains straightforward.
  makeDirSync(root, { recursive: true });
  assertPlainDirectorySync(root, "本機資料根目錄");
}

function isFile(filePath) {
  try {
    const info = lstatSync(filePath);
    return !info.isSymbolicLink() && info.isFile();
  } catch { return false; }
}

function pathEntryIsSymlink(filePath) {
  try { return lstatSync(filePath).isSymbolicLink(); } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("LOCAL_DATA_UNAVAILABLE", "無法檢查資料庫路徑");
  }
}

function assertExistingDirectoriesSync(directories, label) {
  for (const directory of directories) {
    let info;
    try { info = lstatSync(directory); } catch (error) {
      if (error?.code === "ENOENT") return;
      fail("SNAPSHOT_UNVERIFIED", `${label}無法檢查`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail("SNAPSHOT_UNVERIFIED", `${label}必須由一般目錄組成，拒絕 symlink`);
    }
  }
}

function assertPlainDirectorySync(directory, label) {
  let info;
  try { info = lstatSync(directory); } catch (error) {
    if (error?.code === "ENOENT") fail("LOCAL_DATA_UNAVAILABLE", `${label}不存在`);
    fail("LOCAL_DATA_UNAVAILABLE", `${label}無法檢查`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("SNAPSHOT_UNVERIFIED", `${label}必須是一般目錄，拒絕 symlink`);
  }
}
