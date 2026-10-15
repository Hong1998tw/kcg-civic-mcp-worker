import { createHash } from "node:crypto";
import { open, mkdir, readFile, link, unlink, rename } from "node:fs/promises";
import { constants as fsConstants, lstatSync, mkdirSync as makeDirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { DerivedStore, MAX_DERIVED_OBJECT_BYTES } from "./derived-store.mjs";

const DB_NAME = "index.sqlite";
const MAX_RECORDS = 100_000;
const MAX_RECORD_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_V2_RECORDS = 100_000;
const MAX_V2_SEARCH_BLOCK_BYTES = 64 * 1024;
const MAX_V2_SEARCH_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_V2_SEARCH_CHANNEL_BYTES = 64 * 1024 * 1024;
const MAX_V2_PAGE_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_V2_SELECTED_METADATA_BYTES = 32 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const V2_DATASETS = new Set([
  "kcc-proposal-details",
  "kcc-proposal-attachments",
  "kcc-meeting-records",
]);
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

function fileSignature(info) {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":");
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

function normalizeV2Ref(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 || Object.keys(value).some((key) => !["sha256", "byte_length"].includes(key)) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.byte_length) || value.byte_length < 1 || value.byte_length > MAX_DERIVED_OBJECT_BYTES) {
    fail("SNAPSHOT_UNVERIFIED", `${field} 僅允許有效 sha256 與 byte_length`);
  }
  return { sha256: value.sha256, byte_length: value.byte_length };
}

function normalizeV2Descriptor(value) {
  const allowed = ["id", "raw_sha256", "envelope_ref", "payload_ref", "search_ref"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) {
    fail("SNAPSHOT_UNVERIFIED", "v2 descriptor 欄位必須固定為 id/raw_sha256/envelope_ref/payload_ref/search_ref");
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const rawSha = typeof value.raw_sha256 === "string" ? value.raw_sha256.toLowerCase() : "";
  if (!/^[A-Za-z0-9._:#/-]{1,512}$/.test(id) || !SHA256_RE.test(rawSha)) {
    fail("SNAPSHOT_UNVERIFIED", "v2 descriptor id 或 raw_sha256 無效");
  }
  const descriptor = {
    id,
    raw_sha256: rawSha,
    envelope_ref: normalizeV2Ref(value.envelope_ref, `record ${id}.envelope_ref`),
    payload_ref: normalizeV2Ref(value.payload_ref, `record ${id}.payload_ref`),
    search_ref: normalizeV2Ref(value.search_ref, `record ${id}.search_ref`),
  };
  if (Buffer.byteLength(canonical(descriptor)) > 1024) fail("SNAPSHOT_UNVERIFIED", `record ${id} v2 descriptor 超過 1 KiB`);
  return descriptor;
}

function validateV2SnapshotInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== "local-snapshot-v2") {
    fail("SNAPSHOT_UNVERIFIED", "snapshot schema_version 必須是 local-snapshot-v2");
  }
  const dataset = typeof input.dataset === "string" ? input.dataset.trim() : "";
  if (!V2_DATASETS.has(dataset)) fail("FEATURE_UNAVAILABLE", `dataset=${dataset} 未啟用 local-snapshot-v2`);
  const snapshotId = typeof input.snapshot_id === "string" ? input.snapshot_id.trim() : "";
  if (!snapshotId || snapshotId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(snapshotId)) {
    fail("SNAPSHOT_UNVERIFIED", "v2 snapshot_id 格式無效");
  }
  if (input.validation_status !== "passed") fail("SNAPSHOT_UNVERIFIED", "v2 snapshot 尚未通過 validation");
  const parserVersion = typeof input.parser_version === "string" ? input.parser_version.trim() : "";
  const validatorVersion = typeof input.validator_version === "string" ? input.validator_version.trim() : "";
  if (!parserVersion || parserVersion.length > 100 || !validatorVersion || validatorVersion.length > 100) {
    fail("SNAPSHOT_UNVERIFIED", "v2 parser_version 與 validator_version 必填");
  }
  if (!Array.isArray(input.records) || input.records.length > MAX_V2_RECORDS ||
      Object.hasOwn(input, "envelopes") || Object.hasOwn(input, "search_blocks")) {
    fail("SNAPSHOT_UNVERIFIED", `v2 records 必須是最多 ${MAX_V2_RECORDS} 筆 descriptor；envelopes/search_blocks 不可整批傳入`);
  }
  const records = input.records.map(normalizeV2Descriptor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(records.map((record) => record.id)).size !== records.length) fail("SOURCE_ID_MISMATCH", "v2 snapshot 含重複 record.id");
  const coverage = normalizeCoverage(input.coverage, records.length);
  return {
    schema_version: "local-snapshot-v2",
    dataset,
    snapshot_id: snapshotId,
    records,
    coverage,
    parser_version: parserVersion,
    validator_version: validatorVersion,
    validation_status: "passed",
  };
}

function manifestDigestV2(snapshot) {
  const hash = createHash("sha256");
  hash.update(canonical({
    schema_version: "local-snapshot-v2",
    dataset: snapshot.dataset,
    snapshot_id: snapshot.snapshot_id,
    record_count: snapshot.records.length,
    coverage: snapshot.coverage,
    parser_version: snapshot.parser_version,
    validator_version: snapshot.validator_version,
    validation_status: "passed",
  }));
  for (const record of snapshot.records) {
    hash.update("\n");
    hash.update(canonical(record));
  }
  return hash.digest("hex");
}

function parseCanonicalJsonBuffer(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("SNAPSHOT_UNVERIFIED", `${label} JSON 無效`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || canonical(value) !== bytes.toString("utf8")) {
    fail("SNAPSHOT_UNVERIFIED", `${label} 必須是 canonical JSON 物件`);
  }
  return value;
}

function normalizeV2PageReference(value, index, dataset) {
  const allowed = ["version_id", "page_number", "source", "raw_sha256", "ref"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) {
    fail("SNAPSHOT_UNVERIFIED", `envelope.pages[${index}] 結構無效`);
  }
  const versionId = typeof value.version_id === "string" ? value.version_id.trim() : "";
  const pageNumber = value.page_number;
  const source = normalizeSourceUrl(value.source, dataset);
  const rawSha = typeof value.raw_sha256 === "string" ? value.raw_sha256.toLowerCase() : "";
  if (!SHA256_RE.test(versionId) || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || !SHA256_RE.test(rawSha) || versionId !== rawSha) {
    fail("SNAPSHOT_UNVERIFIED", `envelope.pages[${index}] 身分、頁碼或 raw SHA 無效`);
  }
  return {
    version_id: versionId,
    page_number: pageNumber,
    source,
    raw_sha256: rawSha,
    ref: normalizeV2Ref(value.ref, `envelope.pages[${index}].ref`),
  };
}

function normalizeV2Envelope(value, descriptor, dataset) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope 必須是物件`);
  if (value.id !== descriptor.id || String(value.raw_sha256 || "").toLowerCase() !== descriptor.raw_sha256) {
    fail("SOURCE_ID_MISMATCH", `record ${descriptor.id} envelope 身分或 raw_sha256 不一致`);
  }
  const title = typeof value.title === "string" ? value.title : "";
  if (Buffer.byteLength(title) > MAX_RECORD_TEXT_BYTES) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} title 超過大小上限`);
  const sourceUrl = normalizeSourceUrl(value.source_url, dataset);
  const retrievedAt = normalizeRetrievedAt(value.retrieved_at);
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data) ||
      Buffer.byteLength(canonical(value.data)) > MAX_RECORD_TEXT_BYTES) {
    fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope.data 必須是有界 JSON 物件`);
  }
  if (value.pages !== undefined && (!Array.isArray(value.pages) || value.pages.length > 20_000)) {
    fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope.pages 格式或筆數無效`);
  }
  const pages = (value.pages || []).map((page, index) => normalizeV2PageReference(page, index, dataset));
  const pageKeys = pages.map((page) => `${page.version_id}\n${page.page_number}`);
  if (new Set(pageKeys).size !== pageKeys.length) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope.pages 有重複 version/page`);
  let pageSets = value.page_sets;
  if (pageSets !== undefined) {
    if (!pageSets || typeof pageSets !== "object" || Array.isArray(pageSets)) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope.page_sets 必須是物件`);
    pageSets = JSON.parse(canonical(pageSets));
    for (const [slot, versionId] of Object.entries(pageSets)) {
      if (!slot || slot.length > 128 || typeof versionId !== "string" || !SHA256_RE.test(versionId) ||
          !pages.some((page) => page.version_id === versionId)) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope.page_sets slot/version 無效`);
      }
    }
  }
  let pageTotals = value.page_totals;
  if (pageTotals !== undefined) {
    if (!pageTotals || typeof pageTotals !== "object" || Array.isArray(pageTotals)) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope.page_totals 必須是物件`);
    pageTotals = JSON.parse(canonical(pageTotals));
    if (!pageSets || Object.keys(pageTotals).length !== Object.keys(pageSets).length ||
        Object.keys(pageTotals).some((slot) => !Object.hasOwn(pageSets, slot))) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope.page_sets/page_totals keys 必須一致`);
    }
    const versionTotals = new Map();
    for (const [slot, total] of Object.entries(pageTotals)) {
      const versionId = pageSets[slot];
      if (!Number.isSafeInteger(total) || total < 1) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} page_totals.${slot} 必須是正整數`);
      if (versionTotals.has(versionId) && versionTotals.get(versionId) !== total) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} 同一 PDF version page_totals 不一致`);
      }
      versionTotals.set(versionId, total);
    }
    for (const [versionId, total] of versionTotals) {
      const versionPages = pages.filter((page) => page.version_id === versionId).map((page) => page.page_number).sort((a, b) => a - b);
      if (versionPages.length !== total || versionPages.some((pageNumber, index) => pageNumber !== index + 1)) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} PDF version page sequence 不完整`);
      }
    }
  } else if (pageSets !== undefined || pages.length > 0) {
    fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} page_totals 必填且須與 page_sets/page refs 對齊`);
  }
  const data = JSON.parse(canonical(value.data));
  return {
    body: {
      ...value,
      id: descriptor.id,
      raw_sha256: descriptor.raw_sha256,
      title,
      source_url: sourceUrl,
      retrieved_at: retrievedAt,
      data,
      ...(value.pages === undefined ? {} : { pages }),
      ...(pageSets === undefined ? {} : { page_sets: pageSets }),
      ...(pageTotals === undefined ? {} : { page_totals: pageTotals }),
    },
    record: {
      id: descriptor.id,
      title,
      source_url: sourceUrl,
      retrieved_at: retrievedAt,
      raw_sha256: descriptor.raw_sha256,
      data,
    },
  };
}

function normalizeV2SearchManifest(value, descriptor, envelope, dataset) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema_version !== "kcc-search-manifest-v2" || !Array.isArray(value.chunks) || value.chunks.length > 50_000) {
    fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest 格式或筆數無效`);
  }
  const allowed = ["block_index", "channel", "version_id", "page_number", "chunk_index", "source", "raw_sha256", "schema_version", "sha256", "byte_length", "ref"];
  const sourceRank = { title: 0, text: 1, data: 2, page: 3 };
  let previousRank = -1;
  const groupIndex = new Map();
  const groupBytes = new Map();
  const closedGroups = new Set();
  let activeGroup = "";
  const pageMap = new Map((envelope.pages || []).map((page) => [`${page.version_id}\n${page.page_number}`, page]));
  const chunks = value.chunks.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).length !== allowed.length || Object.keys(item).some((key) => !allowed.includes(key))) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest chunk ${index} 欄位無效`);
    }
    if (item.block_index !== index || !Object.hasOwn(sourceRank, item.channel) || sourceRank[item.channel] < previousRank ||
        typeof item.schema_version !== "string" || item.schema_version !== "kcc-search-chunk-v2" ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.byte_length) || item.byte_length < 1 || item.byte_length > MAX_V2_SEARCH_BLOCK_BYTES ||
        !Number.isSafeInteger(item.chunk_index) || item.chunk_index < 0) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest chunk ${index} 順序或值無效`);
    }
    previousRank = sourceRank[item.channel];
    const rawSha = typeof item.raw_sha256 === "string" ? item.raw_sha256.toLowerCase() : "";
    if (!SHA256_RE.test(rawSha)) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest chunk ${index} raw SHA 無效`);
    const source = normalizeSourceUrl(item.source, dataset);
    const ref = normalizeV2Ref(item.ref, `record ${descriptor.id} search chunk ${index}.ref`);
    if (item.channel === "page") {
      if (typeof item.version_id !== "string" || !item.version_id || item.version_id.length > 128 ||
          !Number.isSafeInteger(item.page_number) || item.page_number < 1) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} page search chunk ${index} 缺少頁面身分`);
      }
      const page = pageMap.get(`${item.version_id}\n${item.page_number}`);
      if (!page || page.source !== source || page.raw_sha256 !== rawSha) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} page search chunk ${index} 與 envelope page binding 不一致`);
      }
    } else if (item.version_id !== null || item.page_number !== null ||
        source !== envelope.source_url || rawSha !== descriptor.raw_sha256) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search chunk ${index} 跨 channel 綁定無效`);
    }
    const group = `${item.channel}\n${item.version_id ?? ""}\n${item.page_number ?? ""}`;
    if (activeGroup !== group) {
      if (closedGroups.has(group)) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest chunk group 順序不連續`);
      if (activeGroup) closedGroups.add(activeGroup);
      activeGroup = group;
    }
    const expectedIndex = groupIndex.get(group) || 0;
    if (item.chunk_index !== expectedIndex) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search chunk ${index} 順序不連續`);
    groupIndex.set(group, expectedIndex + 1);
    const groupTotalBytes = (groupBytes.get(group) || 0) + item.byte_length;
    const groupMax = item.channel === "page" ? MAX_V2_PAGE_SEARCH_BYTES : MAX_V2_SEARCH_CHANNEL_BYTES;
    if (groupTotalBytes > groupMax) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search channel 超過大小上限`);
    groupBytes.set(group, groupTotalBytes);
    return {
      block_index: index,
      channel: item.channel,
      version_id: item.version_id,
      page_number: item.page_number,
      chunk_index: item.chunk_index,
      source,
      raw_sha256: rawSha,
      schema_version: item.schema_version,
      sha256: item.sha256,
      byte_length: item.byte_length,
      ref,
    };
  });
  if (!chunks.some((chunk) => chunk.channel === "data")) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} 缺少 canonical data search channel`);
  return { schema_version: "kcc-search-manifest-v2", chunks };
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
CREATE TABLE IF NOT EXISTS v2_releases (
  dataset TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  coverage_json TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  validator_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_records (
  dataset TEXT NOT NULL,
  id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  PRIMARY KEY (dataset, id)
);
CREATE INDEX IF NOT EXISTS v2_records_dataset_idx ON v2_records(dataset);
CREATE TABLE IF NOT EXISTS v2_envelopes (
  dataset TEXT NOT NULL,
  id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (dataset, id)
);
CREATE TABLE IF NOT EXISTS v2_search_manifests (
  dataset TEXT NOT NULL,
  id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  PRIMARY KEY (dataset, id)
);
CREATE TABLE IF NOT EXISTS v2_search_blocks (
  dataset TEXT NOT NULL,
  id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  channel TEXT NOT NULL,
  version_id TEXT,
  page_number INTEGER,
  chunk_index INTEGER NOT NULL,
  source TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  ref_sha256 TEXT NOT NULL,
  ref_byte_length INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (dataset, id, block_index)
);
CREATE INDEX IF NOT EXISTS v2_search_blocks_dataset_idx ON v2_search_blocks(dataset, id, block_index);
`;

export class LocalStore {
  constructor(root, options = {}) {
    if (typeof root !== "string" || !root.trim()) throw new TypeError("LocalStore root is required");
    this.root = path.resolve(root);
    this.readOnly = options.readOnly !== false;
    this.rawVerificationCache = new Map();
    this.v2RawVerificationCache = new Map();
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
    this.derivedStore = new DerivedStore(this.root, { readOnly: this.readOnly });
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

  #assertV2Schema(reader = this.db) {
    if (!reader) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    try {
      const tables = new Set(reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      for (const table of ["v2_releases", "v2_records", "v2_envelopes", "v2_search_manifests", "v2_search_blocks"]) {
        if (!tables.has(table)) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫尚未初始化 v2 schema");
      }
    } catch (error) {
      if (error instanceof LocalStoreError) throw error;
      fail("LOCAL_DATA_UNAVAILABLE", "無法讀取本機 v2 schema");
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

  async #verifyRawObjectStreaming(hash) {
    if (!SHA256_RE.test(hash)) fail("SNAPSHOT_UNVERIFIED", "raw SHA-256 格式無效");
    const normalizedHash = hash.toLowerCase();
    const rawPath = this.#rawPath(normalizedHash);
    let pathInfo;
    try { pathInfo = lstatSync(rawPath, { bigint: true }); } catch (error) {
      if (error?.code === "ENOENT") fail("SNAPSHOT_UNVERIFIED", `缺少 content-addressed raw object ${normalizedHash}`);
      throw error;
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1n || pathInfo.size < 1n) {
      fail("SNAPSHOT_UNVERIFIED", `raw object ${normalizedHash} 路徑或 hardlink 無效`);
    }
    const before = fileSignature(pathInfo);
    if (this.v2RawVerificationCache.get(normalizedHash) === before) return true;
    let file;
    try { file = await open(rawPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ELOOP") fail("SNAPSHOT_UNVERIFIED", `raw object ${normalizedHash} 無法安全開啟`);
      throw error;
    }
    try {
      const fdInfo = await file.stat({ bigint: true });
      if (!fdInfo.isFile() || fdInfo.nlink !== 1n || fileSignature(fdInfo) !== before) fail("SNAPSHOT_UNVERIFIED", `raw object ${normalizedHash} 開啟時路徑改變`);
      const digest = createHash("sha256");
      let position = 0n;
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      while (position < fdInfo.size) {
        const length = Number(fdInfo.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : fdInfo.size - position);
        const read = await file.read(buffer, 0, length, Number(position));
        if (!read.bytesRead) fail("SNAPSHOT_UNVERIFIED", `raw object ${normalizedHash} 讀取中斷`);
        digest.update(buffer.subarray(0, read.bytesRead));
        position += BigInt(read.bytesRead);
      }
      if (digest.digest("hex") !== normalizedHash) fail("SNAPSHOT_UNVERIFIED", `raw object ${normalizedHash} 內容遭竄改`);
      const after = await file.stat({ bigint: true });
      const currentPath = lstatSync(rawPath, { bigint: true });
      if (!after.isFile() || after.nlink !== 1n || fileSignature(after) !== before ||
          currentPath.isSymbolicLink() || !currentPath.isFile() || currentPath.nlink !== 1n || fileSignature(currentPath) !== before) {
        fail("SNAPSHOT_UNVERIFIED", `raw object ${normalizedHash} 在驗證期間改變`);
      }
      this.v2RawVerificationCache.delete(normalizedHash);
      this.v2RawVerificationCache.set(normalizedHash, before);
      if (this.v2RawVerificationCache.size > 200_000) this.v2RawVerificationCache.delete(this.v2RawVerificationCache.keys().next().value);
      return true;
    } finally {
      await file.close();
    }
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

  /**
   * Import one complete, refs-only v2 release. Input is flat (there is no
   * `header` wrapper) and contains only release metadata plus descriptors:
   * `{schema_version:'local-snapshot-v2',dataset,snapshot_id,coverage,
   * parser_version,validator_version,validation_status:'passed',records:[
   * {id,raw_sha256,envelope_ref:{sha256,byte_length},
   * payload_ref:{sha256,byte_length},search_ref:{sha256,byte_length}}]}`.
   * All referenced CAS objects must already exist. Mirrors are rebuilt one
   * record/chunk at a time; no record body or corpus-wide mirror arrays enter
   * this API. A failed dataset import rolls back its SQLite release atomically.
   */
  async importV2(input) {
    this.#assertWritable();
    this.#assertV2Schema();
    const snapshot = validateV2SnapshotInput(input);
    const manifestSha = manifestDigestV2(snapshot);
    const existing = this.db.prepare("SELECT * FROM v2_releases WHERE dataset = ?").get(snapshot.dataset);
    if (existing?.snapshot_id === snapshot.snapshot_id && existing.manifest_sha256 !== manifestSha) {
      fail("SOURCE_ID_MISMATCH", "同一 v2 snapshot_id 內容不同，拒絕覆寫");
    }
    await this.#writeV2SnapshotArchive(snapshot, manifestSha);

    const rawSeen = new Set();
    const counts = { envelope: 0, payload: 0, page: 0, search_manifest: 0, search_chunk: 0 };
    if (existing?.snapshot_id === snapshot.snapshot_id) {
      for (const descriptor of snapshot.records) {
        const artifacts = await this.#loadV2RecordArtifacts(snapshot, descriptor, null, rawSeen);
        counts.envelope += 1;
        counts.payload += 1;
        counts.page += artifacts.page_count;
        counts.search_manifest += 1;
        counts.search_chunk += artifacts.search_chunk_count;
      }
      const verified = await this.queryV2(snapshot.dataset, { limit: 0, metadataOnly: true });
      if (verified.release.manifest_sha256 !== manifestSha) fail("SNAPSHOT_UNVERIFIED", "既有 v2 snapshot 驗證失敗");
      return this.#v2Receipt("unchanged", snapshot, manifestSha, true, { ...counts, raw: rawSeen.size });
    }

    const insertRecord = this.db.prepare("INSERT INTO v2_records(dataset,id,descriptor_json) VALUES (?,?,?)");
    const insertEnvelope = this.db.prepare("INSERT INTO v2_envelopes(dataset,id,envelope_json) VALUES (?,?,?)");
    const insertManifest = this.db.prepare("INSERT INTO v2_search_manifests(dataset,id,manifest_json) VALUES (?,?,?)");
    const insertChunk = this.db.prepare(`INSERT INTO v2_search_blocks
      (dataset,id,block_index,channel,version_id,page_number,chunk_index,source,raw_sha256,schema_version,sha256,byte_length,ref_sha256,ref_byte_length,text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upsertRelease = this.db.prepare(`INSERT INTO v2_releases
      (dataset,snapshot_id,record_count,coverage_json,manifest_sha256,parser_version,validator_version)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(dataset) DO UPDATE SET
      snapshot_id=excluded.snapshot_id,record_count=excluded.record_count,coverage_json=excluded.coverage_json,
      manifest_sha256=excluded.manifest_sha256,parser_version=excluded.parser_version,validator_version=excluded.validator_version`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM v2_records WHERE dataset = ?").run(snapshot.dataset);
      this.db.prepare("DELETE FROM v2_envelopes WHERE dataset = ?").run(snapshot.dataset);
      this.db.prepare("DELETE FROM v2_search_manifests WHERE dataset = ?").run(snapshot.dataset);
      this.db.prepare("DELETE FROM v2_search_blocks WHERE dataset = ?").run(snapshot.dataset);
      for (const descriptor of snapshot.records) {
        const artifacts = await this.#loadV2RecordArtifacts(snapshot, descriptor, (chunk, text) => {
          insertChunk.run(snapshot.dataset, descriptor.id, chunk.block_index, chunk.channel,
            chunk.version_id, chunk.page_number, chunk.chunk_index, chunk.source, chunk.raw_sha256,
            chunk.schema_version, chunk.sha256, chunk.byte_length, chunk.ref.sha256, chunk.ref.byte_length, text);
        }, rawSeen);
        counts.envelope += 1;
        counts.payload += 1;
        counts.page += artifacts.page_count;
        counts.search_manifest += 1;
        counts.search_chunk += artifacts.search_chunk_count;
        insertRecord.run(snapshot.dataset, descriptor.id, canonical(descriptor));
        insertEnvelope.run(snapshot.dataset, descriptor.id, artifacts.envelope_json);
        insertManifest.run(snapshot.dataset, descriptor.id, artifacts.manifest_json);
      }
      upsertRelease.run(snapshot.dataset, snapshot.snapshot_id, snapshot.records.length, canonical(snapshot.coverage),
        manifestSha, snapshot.parser_version, snapshot.validator_version);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return this.#v2Receipt("imported", snapshot, manifestSha, false, { ...counts, raw: rawSeen.size });
  }

  async #loadV2RecordArtifacts(snapshot, descriptor, onChunk, rawSeen) {
    if (!rawSeen.has(descriptor.raw_sha256)) {
      await this.#verifyRawObjectStreaming(descriptor.raw_sha256);
      rawSeen.add(descriptor.raw_sha256);
    }
    const envelopeBound = await this.derivedStore.readBoundObject(descriptor.envelope_ref, {
      kind: "envelope", dataset: snapshot.dataset, id: descriptor.id,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-envelope-v2",
    }, { maxBytes: 16 * 1024 * 1024 });
    const source = normalizeSourceUrl(envelopeBound.binding.source, snapshot.dataset);
    const envelopeJson = envelopeBound.body.toString("utf8");
    const envelopeInput = parseCanonicalJsonBuffer(envelopeBound.body, `record ${descriptor.id} envelope`);
    const normalizedEnvelope = normalizeV2Envelope(envelopeInput, descriptor, snapshot.dataset);
    if (source !== normalizedEnvelope.record.source_url || canonical(normalizedEnvelope.body) !== envelopeJson) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope source/body canonical binding 不一致`);
    }
    const envelopeRef = DerivedStore.calculateRef({
      kind: "envelope", dataset: snapshot.dataset, id: descriptor.id, source,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-envelope-v2", body: envelopeBound.body,
    });
    if (envelopeRef.sha256 !== descriptor.envelope_ref.sha256 || envelopeRef.byte_length !== descriptor.envelope_ref.byte_length) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope ref 不一致`);
    }

    const payloadExpected = {
      kind: "payload", dataset: snapshot.dataset, id: descriptor.id, source,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-payload-v2",
    };
    await this.derivedStore.verifyObject(descriptor.payload_ref, payloadExpected);
    for (const page of normalizedEnvelope.body.pages || []) {
      if (!rawSeen.has(page.raw_sha256)) {
        await this.#verifyRawObjectStreaming(page.raw_sha256);
        rawSeen.add(page.raw_sha256);
      }
    }

    const manifestBytes = await this.derivedStore.readObject(descriptor.search_ref, {
      kind: "search-manifest", dataset: snapshot.dataset, id: descriptor.id, source,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-search-manifest-v2",
    }, { maxBytes: 16 * 1024 * 1024 });
    const manifestInput = parseCanonicalJsonBuffer(manifestBytes, `record ${descriptor.id} search manifest`);
    const manifest = normalizeV2SearchManifest(manifestInput, descriptor, normalizedEnvelope.body, snapshot.dataset);
    const manifestJson = canonical(manifest);
    if (manifestJson !== manifestBytes.toString("utf8")) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest canonical form 不一致`);
    const manifestRef = DerivedStore.calculateRef({
      kind: "search-manifest", dataset: snapshot.dataset, id: descriptor.id, source,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-search-manifest-v2", body: manifestBytes,
    });
    if (manifestRef.sha256 !== descriptor.search_ref.sha256 || manifestRef.byte_length !== descriptor.search_ref.byte_length) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest ref 不一致`);
    }

    const pageSearchDigests = new Map();
    for (const chunk of manifest.chunks) {
      const bytes = await this.derivedStore.readObject(chunk.ref, {
        kind: "search-chunk", dataset: snapshot.dataset, id: descriptor.id,
        source: chunk.source, raw_sha256: chunk.raw_sha256, schema_version: chunk.schema_version,
      }, { maxBytes: MAX_V2_SEARCH_BLOCK_BYTES });
      const text = bytes.toString("utf8");
      if (!text || !Buffer.from(text, "utf8").equals(bytes) || bytes.length !== chunk.byte_length || sha256(bytes) !== chunk.sha256) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search chunk ${chunk.block_index} text hash/length 無效`);
      }
      if (chunk.channel === "page") {
        const pageKey = `${chunk.version_id}\n${chunk.page_number}`;
        let pageDigest = pageSearchDigests.get(pageKey);
        if (!pageDigest) {
          pageDigest = { hash: createHash("sha256"), byte_length: 0 };
          pageSearchDigests.set(pageKey, pageDigest);
        }
        pageDigest.hash.update(bytes);
        pageDigest.byte_length += bytes.length;
      }
      if (onChunk) await onChunk(chunk, text);
    }
    for (const page of normalizedEnvelope.body.pages || []) {
      const pageKey = `${page.version_id}\n${page.page_number}`;
      const searchDigest = pageSearchDigests.get(pageKey);
      const searchHash = searchDigest?.hash.digest("hex") || sha256(Buffer.alloc(0));
      const searchLength = searchDigest?.byte_length || 0;
      const pageHash = createHash("sha256");
      let pageLength = 0;
      for await (const bytes of this.derivedStore.readObjectStream(page.ref, {
        kind: "pdf-page", dataset: snapshot.dataset, id: descriptor.id,
        source: page.source, raw_sha256: page.raw_sha256, schema_version: "kcc-pdf-page-v2",
      }, { maxBytes: MAX_V2_PAGE_SEARCH_BYTES })) {
        pageHash.update(bytes);
        pageLength += bytes.length;
      }
      if (pageLength !== searchLength || pageHash.digest("hex") !== searchHash) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} PDF page ${page.version_id}/${page.page_number} 與 search projection 不一致`);
      }
    }
    return {
      envelope_json: envelopeJson,
      manifest_json: manifestJson,
      envelope: normalizedEnvelope.body,
      page_count: (normalizedEnvelope.body.pages || []).length,
      search_chunk_count: manifest.chunks.length,
    };
  }

  #v2Receipt(status, snapshot, manifestSha, idempotent, counts) {
    return {
      status,
      schema_version: "local-snapshot-v2",
      dataset: snapshot.dataset,
      snapshot_id: snapshot.snapshot_id,
      record_count: snapshot.records.length,
      coverage: snapshot.coverage,
      manifest_sha256: manifestSha,
      raw_objects_verified: counts.raw,
      derived_objects_verified: {
        envelope: counts.envelope,
        payload: counts.payload,
        page: counts.page,
        search_manifest: counts.search_manifest,
        search_chunk: counts.search_chunk,
      },
      idempotent,
    };
  }

  #v2SnapshotPath(dataset, snapshotId) {
    if (!V2_DATASETS.has(dataset) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId)) {
      fail("SNAPSHOT_UNVERIFIED", "v2 snapshot archive 身分無效");
    }
    return path.join(this.root, "snapshots-v2", dataset, `${snapshotId}.json`);
  }

  async #readV2ArchiveDocument(dataset, snapshotId) {
    const archivePath = this.#v2SnapshotPath(dataset, snapshotId);
    assertExistingDirectoriesSync([this.root, path.join(this.root, "snapshots-v2"), path.dirname(archivePath)], "v2 snapshot archive 路徑");
    let info;
    try { info = lstatSync(archivePath); } catch (error) {
      if (error?.code === "ENOENT") fail("LOCAL_DATA_UNAVAILABLE", `v2 snapshot_id=${snapshotId} archive 不存在`);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size > 128 * 1024 * 1024) {
      fail("SNAPSHOT_UNVERIFIED", "v2 snapshot archive 路徑或大小無效");
    }
    let bytes;
    try { bytes = await readFile(archivePath); } catch { fail("SNAPSHOT_UNVERIFIED", "v2 snapshot archive 無法讀取"); }
    let document;
    try { document = JSON.parse(bytes.toString("utf8")); } catch { fail("SNAPSHOT_UNVERIFIED", "v2 snapshot archive JSON 無效"); }
    if (!document || document.schema_version !== "local-snapshot-v2" || document.validation_status !== "passed" ||
        document.dataset !== dataset || document.snapshot_id !== snapshotId ||
        document.record_count !== document.records?.length || !SHA256_RE.test(document.manifest_sha256) ||
        canonical(document) !== bytes.toString("utf8")) {
      fail("SNAPSHOT_UNVERIFIED", "v2 snapshot archive manifest 格式無效");
    }
    const snapshot = validateV2SnapshotInput(document);
    const manifestSha = manifestDigestV2(snapshot);
    if (manifestSha !== document.manifest_sha256.toLowerCase()) fail("SNAPSHOT_UNVERIFIED", "v2 snapshot archive manifest SHA-256 不一致");
    return { snapshot, manifest_sha256: manifestSha };
  }

  async #writeV2SnapshotArchive(snapshot, manifestSha) {
    const destination = this.#v2SnapshotPath(snapshot.dataset, snapshot.snapshot_id);
    const directory = path.dirname(destination);
    assertExistingDirectoriesSync([this.root, path.join(this.root, "snapshots-v2"), directory], "v2 snapshot archive 路徑");
    await mkdir(directory, { recursive: true });
    assertPlainDirectorySync(this.root, "本機資料根目錄");
    assertPlainDirectorySync(path.join(this.root, "snapshots-v2"), "v2 snapshot archive 根目錄");
    assertPlainDirectorySync(directory, "v2 snapshot archive dataset 目錄");
    const document = {
      schema_version: "local-snapshot-v2",
      dataset: snapshot.dataset,
      snapshot_id: snapshot.snapshot_id,
      record_count: snapshot.records.length,
      coverage: snapshot.coverage,
      parser_version: snapshot.parser_version,
      validator_version: snapshot.validator_version,
      validation_status: "passed",
      manifest_sha256: manifestSha,
      records: snapshot.records,
    };
    const bytes = Buffer.from(canonical(document));
    try {
      const info = lstatSync(destination);
      if (info.isSymbolicLink() || !info.isFile()) fail("SNAPSHOT_UNVERIFIED", "既有 v2 snapshot archive 必須是一般檔案");
      const existing = await this.#readV2ArchiveDocument(snapshot.dataset, snapshot.snapshot_id);
      if (existing.manifest_sha256 !== manifestSha) fail("SOURCE_ID_MISMATCH", "同一 v2 snapshot_id archive 內容不同，拒絕覆寫");
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
        const existing = await this.#readV2ArchiveDocument(snapshot.dataset, snapshot.snapshot_id);
        if (existing.manifest_sha256 !== manifestSha) fail("SOURCE_ID_MISMATCH", "同一 v2 snapshot_id archive 內容不同，拒絕覆寫");
        return { stored: false };
      }
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
        fail("LOCAL_DATA_UNAVAILABLE", "檔案系統不支援安全的 v2 archive 原子安裝");
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return { stored: true };
  }

  /** Return a verified v2 history header and descriptors without payload bodies. */
  async readSnapshotVersionV2(dataset, snapshotId) {
    if (!this.db) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    const { snapshot, manifest_sha256: manifestSha } = await this.#readV2ArchiveDocument(dataset, snapshotId);
    const rawSeen = new Set();
    for (const descriptor of snapshot.records) await this.#loadV2RecordArtifacts(snapshot, descriptor, null, rawSeen);
    return {
      schema_version: "local-snapshot-v2",
      dataset: snapshot.dataset,
      snapshot_id: snapshot.snapshot_id,
      record_count: snapshot.records.length,
      coverage: snapshot.coverage,
      parser_version: snapshot.parser_version,
      validator_version: snapshot.validator_version,
      validation_status: "passed",
      manifest_sha256: manifestSha,
      records: snapshot.records,
    };
  }

  async restoreSnapshotV2(dataset, snapshotId) {
    this.#assertWritable();
    const { snapshot } = await this.#readV2ArchiveDocument(dataset, snapshotId);
    return await this.importV2(snapshot);
  }

  /**
   * Verify the complete v2 release and every envelope/search mirror in one
   * SQLite read transaction, then apply filters and bounded top-K selection.
   * Optional `pageSearch` scans selected page mirrors only; page bodies remain
   * available through readDerivedObject/Stream after the caller selects a ref.
   */
  async queryV2(dataset, options = {}) {
    if (!this.db) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    if (!V2_DATASETS.has(dataset)) fail("FEATURE_UNAVAILABLE", `dataset=${dataset} 未啟用 local-snapshot-v2`);
    const reader = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      reader.exec("PRAGMA busy_timeout=3000; BEGIN DEFERRED");
      this.#assertV2Schema(reader);
      return await this.#queryV2Snapshot(dataset, options, reader);
    } finally {
      try { reader.exec("ROLLBACK"); } catch {}
      reader.close();
    }
  }

  async #queryV2Snapshot(dataset, options, reader) {
    const releaseRow = reader.prepare("SELECT * FROM v2_releases WHERE dataset = ?").get(dataset);
    if (!releaseRow) fail("LOCAL_DATA_UNAVAILABLE", `dataset=${dataset} 尚無本機 v2 snapshot`);
    let coverage;
    try { coverage = normalizeCoverage(JSON.parse(releaseRow.coverage_json), releaseRow.record_count); }
    catch (error) {
      if (error instanceof LocalStoreError) throw error;
      fail("SNAPSHOT_UNVERIFIED", `dataset=${dataset} v2 coverage JSON 無效`);
    }
    const limit = options.limit === undefined ? 100 : Number(options.limit);
    const offset = options.offset === undefined ? 0 : Number(options.offset);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      fail("FILTER_NOT_CONFIRMED", "v2 limit 或 offset 超出本機查詢範圍");
    }
    const predicate = typeof options.predicate === "function" ? options.predicate : () => true;
    const order = options.orderBy;
    if (order !== undefined && (!order || !["published_at", "date", "meeting_date"].includes(order.field) ||
        typeof order.descending !== "boolean" || offset + limit > 1000)) {
      fail("FILTER_NOT_CONFIRMED", "v2 本機排序欄位或頁面範圍無效");
    }
    const keyword = typeof options.keyword === "string" ? options.keyword.trim() : "";
    if (keyword.length > 200) fail("FILTER_NOT_CONFIRMED", "keyword 不可超過 200 字元");
    const pageSearch = this.#normalizePageSearchOptions(options.pageSearch);
    if (pageSearch?.allMatchingRecords && order) fail("FILTER_NOT_CONFIRMED", "全量頁面搜尋不接受 metadata top-K 排序");
    const releaseHeader = {
      schema_version: "local-snapshot-v2",
      dataset,
      snapshot_id: releaseRow.snapshot_id,
      record_count: releaseRow.record_count,
      coverage,
      parser_version: releaseRow.parser_version,
      validator_version: releaseRow.validator_version,
      validation_status: "passed",
    };
    const manifestHash = createHash("sha256");
    manifestHash.update(canonical(releaseHeader));
    let verifiedRecordCount = 0;
    let verifiedBlockCount = 0;
    let sourceUrl = "";
    let latestRetrievedAt = "";
    let previousId = "";
    const descriptors = reader.prepare("SELECT id,descriptor_json FROM v2_records WHERE dataset=? ORDER BY id COLLATE BINARY").iterate(dataset);
    for (const row of descriptors) {
      let descriptor;
      try { descriptor = normalizeV2Descriptor(JSON.parse(row.descriptor_json)); } catch (error) {
        if (error instanceof LocalStoreError) throw error;
        fail("SNAPSHOT_UNVERIFIED", `record ${row.id} descriptor JSON 無效`);
      }
      if (canonical(descriptor) !== row.descriptor_json || descriptor.id !== row.id || (previousId && descriptor.id <= previousId)) {
        fail("SNAPSHOT_UNVERIFIED", `dataset=${dataset} v2 descriptor 排序或主鍵不一致`);
      }
      previousId = descriptor.id;
      manifestHash.update("\n").update(canonical(descriptor));
      const mirror = await this.#verifyV2RecordMirror(reader, dataset, descriptor);
      verifiedBlockCount += mirror.manifest.chunks.length;
      verifiedRecordCount += 1;
      sourceUrl ||= mirror.record.source_url;
      if (!latestRetrievedAt || Date.parse(mirror.record.retrieved_at) > Date.parse(latestRetrievedAt)) latestRetrievedAt = mirror.record.retrieved_at;
    }
    const countRows = (table) => reader.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE dataset=?`).get(dataset).count;
    const actualBlockCount = countRows("v2_search_blocks");
    if (verifiedRecordCount !== releaseRow.record_count ||
        countRows("v2_envelopes") !== releaseRow.record_count ||
        countRows("v2_search_manifests") !== releaseRow.record_count ||
        actualBlockCount !== verifiedBlockCount ||
        manifestHash.digest("hex") !== releaseRow.manifest_sha256) {
      fail("SNAPSHOT_UNVERIFIED", `dataset=${dataset} v2 資料列或 manifest 不一致`);
    }

    // Filtering starts only after the complete descriptor manifest, every envelope,
    // each search manifest, and every SQLite mirror chunk passed validation above.
    const compare = (left, right) => {
      const value = (record) => order.field === "date"
        ? record.data.date ?? record.data.meeting_date ?? record.retrieved_at
        : record.data[order.field] ?? "";
      const a = String(value(left));
      const b = String(value(right));
      const difference = a < b ? -1 : a > b ? 1 : 0;
      return (order.descending ? -difference : difference) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    };
    const selected = [];
    let localMatchCount = 0;
    let selectedBytes = 0;
    const allPageResults = pageSearch?.allMatchingRecords ? {
      page_matches: [], matched_pages_count: 0, total_page_matches: 0, omitted_page_matches: 0,
      omitted_occurrences: 0, empty_text_page_count: 0, page_search_complete: true,
      page_scan_scope: "entire_verified_snapshot",
    } : null;
    let allSnippetCount = 0;
    const rows = reader.prepare("SELECT id,descriptor_json FROM v2_records WHERE dataset=? ORDER BY id COLLATE BINARY").iterate(dataset);
    for (const row of rows) {
      const descriptor = normalizeV2Descriptor(JSON.parse(row.descriptor_json));
      const envelopeRow = reader.prepare("SELECT envelope_json FROM v2_envelopes WHERE dataset=? AND id=?").get(dataset, row.id);
      const envelopeInput = parseCanonicalJsonBuffer(Buffer.from(envelopeRow.envelope_json, "utf8"), `record ${row.id} envelope`);
      const normalizedEnvelope = normalizeV2Envelope(envelopeInput, descriptor, dataset);
      const record = normalizedEnvelope.record;
      const matchesPredicate = predicate(record);
      const matchesKeyword = !keyword || this.#recordMatchesV2Keyword(reader, dataset, row.id, keyword);
      if (!matchesKeyword || !matchesPredicate) continue;
      if (allPageResults) {
        const item = { descriptor, record, envelope: options.includePageRefs === true ? normalizedEnvelope.body : this.#withoutPageRefs(normalizedEnvelope.body) };
        const pages = this.#searchV2PageMirrors(reader, dataset, [item], { ...pageSearch,
          maxMatches: Math.max(0, pageSearch.maxMatches - allPageResults.page_matches.length),
          maxSnippets: Math.max(0, pageSearch.maxSnippets - allSnippetCount),
        });
        for (const key of ['matched_pages_count', 'total_page_matches', 'omitted_page_matches', 'omitted_occurrences', 'empty_text_page_count']) allPageResults[key] += pages[key];
        allPageResults.page_matches.push(...pages.page_matches);
        allSnippetCount += pages.page_matches.reduce((sum, match) => sum + match.snippets.length, 0);
        if (pages.page_matches.length) {
          selected.push(item);
          selectedBytes += Buffer.byteLength(canonical(record)) + Buffer.byteLength(canonical(item.envelope));
          if (selectedBytes > MAX_V2_SELECTED_METADATA_BYTES) fail("PARTIAL_SCAN", "v2 selected metadata 超過輸出記憶體上限");
        }
        localMatchCount += 1;
        continue;
      }
      if (predicate.assertSupported && typeof predicate.assertSupported === "function") { /* checked after full scan */ }
      if (order && offset + limit > 0) {
        let low = 0;
        let high = selected.length;
        while (low < high) { const middle = (low + high) >>> 1; if (compare(selected[middle].record, record) <= 0) low = middle + 1; else high = middle; }
        selected.splice(low, 0, { descriptor, record, envelope: options.includePageRefs === true ? normalizedEnvelope.body : this.#withoutPageRefs(normalizedEnvelope.body) });
        if (selected.length > offset + limit) selected.pop();
        selectedBytes = selected.reduce((sum, item) => sum + Buffer.byteLength(canonical(item.record)) + Buffer.byteLength(canonical(item.envelope)), 0);
        if (selectedBytes > MAX_V2_SELECTED_METADATA_BYTES) fail("PARTIAL_SCAN", "v2 selected metadata 超過輸出記憶體上限");
      } else if (!order && localMatchCount >= offset && selected.length < limit) {
        const item = { descriptor, record, envelope: options.includePageRefs === true ? normalizedEnvelope.body : this.#withoutPageRefs(normalizedEnvelope.body) };
        selected.push(item);
        selectedBytes += Buffer.byteLength(canonical(record)) + Buffer.byteLength(canonical(item.envelope));
        if (selectedBytes > MAX_V2_SELECTED_METADATA_BYTES) fail("PARTIAL_SCAN", "v2 selected metadata 超過輸出記憶體上限");
      }
      localMatchCount += 1;
    }
    predicate.assertSupported?.();
    const outputItems = order ? selected.slice(offset, offset + limit) : selected;
    const records = outputItems.map(({ descriptor, record, envelope }) => {
      return {
        ...record,
        descriptor,
        envelope,
        snapshot_id: releaseRow.snapshot_id,
        manifest_sha256: releaseRow.manifest_sha256,
      };
    });
    const result = {
      release: {
        schema_version: "local-snapshot-v2",
        dataset,
        snapshot_id: releaseRow.snapshot_id,
        record_count: verifiedRecordCount,
        coverage,
        manifest_sha256: releaseRow.manifest_sha256,
        parser_version: releaseRow.parser_version,
        validator_version: releaseRow.validator_version,
        source_url: sourceUrl,
        retrieved_at: latestRetrievedAt,
      },
      records,
      local_match_count: localMatchCount,
      order_by: order ? { field: order.field, descending: order.descending, scope: "entire_verified_snapshot" } : null,
      metadata_only: true,
    };
    if (allPageResults) {
      allPageResults.page_search_complete = allPageResults.omitted_page_matches === 0;
      Object.assign(result, allPageResults);
    } else if (pageSearch) {
      const pageResults = this.#searchV2PageMirrors(reader, dataset, outputItems, pageSearch);
      Object.assign(result, pageResults);
      result.records = records;
    }
    return result;
  }

  async #verifyV2RecordMirror(reader, dataset, descriptor) {
    const envelopeRow = reader.prepare("SELECT envelope_json FROM v2_envelopes WHERE dataset=? AND id=?").get(dataset, descriptor.id);
    const manifestRow = reader.prepare("SELECT manifest_json FROM v2_search_manifests WHERE dataset=? AND id=?").get(dataset, descriptor.id);
    if (!envelopeRow || !manifestRow) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} 缺少 envelope/search manifest mirror`);
    const envelopeBytes = Buffer.from(envelopeRow.envelope_json, "utf8");
    const envelopeInput = parseCanonicalJsonBuffer(envelopeBytes, `record ${descriptor.id} envelope mirror`);
    const envelope = normalizeV2Envelope(envelopeInput, descriptor, dataset);
    const source = envelope.record.source_url;
    await this.#verifyRawObjectStreaming(descriptor.raw_sha256);
    const pageRawHashes = new Set((envelope.body.pages || []).map((page) => page.raw_sha256));
    for (const rawHash of pageRawHashes) await this.#verifyRawObjectStreaming(rawHash);
    const envelopeRef = DerivedStore.calculateRef({
      kind: "envelope", dataset, id: descriptor.id, source,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-envelope-v2", body: envelopeBytes,
    });
    if (envelopeRef.sha256 !== descriptor.envelope_ref.sha256 || envelopeRef.byte_length !== descriptor.envelope_ref.byte_length) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope mirror ref 不一致`);
    }

    const manifestBytes = Buffer.from(manifestRow.manifest_json, "utf8");
    const manifestInput = parseCanonicalJsonBuffer(manifestBytes, `record ${descriptor.id} search manifest mirror`);
    const manifest = normalizeV2SearchManifest(manifestInput, descriptor, envelope.body, dataset);
    if (canonical(manifest) !== manifestRow.manifest_json) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest mirror canonical form 不一致`);
    const manifestRef = DerivedStore.calculateRef({
      kind: "search-manifest", dataset, id: descriptor.id, source,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-search-manifest-v2", body: manifestBytes,
    });
    if (manifestRef.sha256 !== descriptor.search_ref.sha256 || manifestRef.byte_length !== descriptor.search_ref.byte_length) {
      fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search manifest mirror ref 不一致`);
    }

    const rows = reader.prepare(`SELECT block_index,channel,version_id,page_number,chunk_index,source,raw_sha256,schema_version,
      sha256,byte_length,ref_sha256,ref_byte_length,text FROM v2_search_blocks
      WHERE dataset=? AND id=? ORDER BY block_index`).iterate(dataset, descriptor.id);
    const iterator = rows[Symbol.iterator]();
    for (const chunk of manifest.chunks) {
      const next = iterator.next();
      if (next.done) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search mirror chunk 遺漏`);
      const row = next.value;
      if (row.block_index !== chunk.block_index || row.channel !== chunk.channel ||
          (row.version_id ?? null) !== chunk.version_id || (row.page_number ?? null) !== chunk.page_number ||
          row.chunk_index !== chunk.chunk_index || row.source !== chunk.source || row.raw_sha256 !== chunk.raw_sha256 ||
          row.schema_version !== chunk.schema_version || row.sha256 !== chunk.sha256 || row.byte_length !== chunk.byte_length ||
          row.ref_sha256 !== chunk.ref.sha256 || row.ref_byte_length !== chunk.ref.byte_length || typeof row.text !== "string") {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search mirror chunk ${chunk.block_index} 與 manifest 不一致`);
      }
      const bytes = Buffer.from(row.text, "utf8");
      if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes) || bytes.length !== chunk.byte_length || sha256(bytes) !== chunk.sha256) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search mirror chunk ${chunk.block_index} hash/length 無效`);
      }
      const chunkRef = DerivedStore.calculateRef({
        kind: "search-chunk", dataset, id: descriptor.id, source: chunk.source,
        raw_sha256: chunk.raw_sha256, schema_version: chunk.schema_version, body: bytes,
      });
      if (chunkRef.sha256 !== chunk.ref.sha256 || chunkRef.byte_length !== chunk.ref.byte_length) {
        fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search mirror chunk ${chunk.block_index} derived ref 不一致`);
      }
    }
    if (!iterator.next().done) fail("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} search mirror 有未索引區塊`);
    return { record: envelope.record, envelope: envelope.body, manifest };
  }

  #recordMatchesV2Keyword(reader, dataset, id, keyword) {
    let previousChannel = "";
    let tail = "";
    const rows = reader.prepare(`SELECT channel,text FROM v2_search_blocks WHERE dataset=? AND id=?
      AND channel IN ('title','text','data') ORDER BY block_index`).iterate(dataset, id);
    for (const row of rows) {
      if (row.channel !== previousChannel) tail = "";
      const combined = tail + row.text;
      if (combined.includes(keyword)) return true;
      tail = keyword.length > 1 ? combined.slice(-(keyword.length - 1)) : "";
      previousChannel = row.channel;
    }
    return false;
  }

  #normalizePageSearchOptions(value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("FILTER_NOT_CONFIRMED", "pageSearch 必須是物件");
    if (value.keyword !== undefined && typeof value.keyword !== "string") fail("FILTER_NOT_CONFIRMED", "pageSearch.keyword 必須是字串");
    const keyword = typeof value.keyword === "string" ? value.keyword.trim() : "";
    if (keyword.length > 200) fail("FILTER_NOT_CONFIRMED", "pageSearch.keyword 不可超過 200 字元");
    const versionIds = value.version_ids === undefined ? null : value.version_ids;
    if (versionIds !== null && (!Array.isArray(versionIds) || versionIds.length > 1000 ||
        versionIds.some((item) => typeof item !== "string" || !SHA256_RE.test(item)))) {
      fail("FILTER_NOT_CONFIRMED", "pageSearch.version_ids 格式無效");
    }
    const slots = value.slots === undefined ? null : value.slots;
    if (slots !== null && (!Array.isArray(slots) || slots.length > 100 ||
        slots.some((item) => typeof item !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(item)))) {
      fail("FILTER_NOT_CONFIRMED", "pageSearch.slots 格式無效");
    }
    const recordIds = value.record_ids === undefined ? null : value.record_ids;
    if (recordIds !== null && (!Array.isArray(recordIds) || recordIds.length > 1000 ||
        recordIds.some((item) => typeof item !== "string" || !/^[A-Za-z0-9._:#/-]{1,512}$/.test(item)))) {
      fail("FILTER_NOT_CONFIRMED", "pageSearch.record_ids 格式無效");
    }
    const bounded = (input, fallback, max, field) => {
      const number = input === undefined ? fallback : Number(input);
      if (!Number.isInteger(number) || number < 0 || number > max) fail("FILTER_NOT_CONFIRMED", `pageSearch.${field} 超出範圍`);
      return number;
    };
    if (value.normalizeWhitespace !== undefined && typeof value.normalizeWhitespace !== "boolean") {
      fail("FILTER_NOT_CONFIRMED", "pageSearch.normalizeWhitespace 必須是 boolean");
    }
    if (value.allMatchingRecords !== undefined && typeof value.allMatchingRecords !== "boolean") fail("FILTER_NOT_CONFIRMED", "pageSearch.allMatchingRecords 必須是 boolean");
    return {
      keyword,
      allMatchingRecords: value.allMatchingRecords === true,
      version_ids: versionIds ? new Set(versionIds) : null,
      slots: slots ? new Set(slots) : null,
      record_ids: recordIds ? new Set(recordIds) : null,
      maxMatches: bounded(value.maxMatches, 100, 1000, "maxMatches"),
      perRecordMax: bounded(value.perRecordMax, 20, 100, "perRecordMax"),
      snippetsPerPage: bounded(value.snippetsPerPage, 1, 20, "snippetsPerPage"),
      maxSnippets: bounded(value.maxSnippets, 1000, 10_000, "maxSnippets"),
      snippetBefore: bounded(value.snippetBefore, 60, 2000, "snippetBefore"),
      snippetAfter: bounded(value.snippetAfter, 60, 2000, "snippetAfter"),
      normalizeWhitespace: value.normalizeWhitespace === true,
    };
  }

  #searchV2PageMirrors(reader, dataset, selected, options) {
    const pageMatches = [];
    let totalPageMatches = 0;
    let matchedPagesCount = 0;
    let omittedPageMatches = 0;
    let omittedOccurrences = 0;
    let snippetCount = 0;
    let emptyTextPageCount = 0;
    const recordIds = options.record_ids;
    const queryPages = reader.prepare(`SELECT version_id,page_number,chunk_index,text FROM v2_search_blocks
      WHERE dataset=? AND id=? AND channel='page' ORDER BY version_id COLLATE BINARY,page_number,chunk_index`);
    for (const item of selected) {
      if (recordIds && !recordIds.has(item.record.id)) continue;
      const envelopeRow = reader.prepare("SELECT envelope_json FROM v2_envelopes WHERE dataset=? AND id=?").get(dataset, item.record.id);
      const envelopeInput = parseCanonicalJsonBuffer(Buffer.from(envelopeRow.envelope_json, "utf8"), `record ${item.record.id} envelope`);
      const normalized = normalizeV2Envelope(envelopeInput, item.descriptor, dataset);
      const pageMap = new Map((normalized.body.pages || []).map((page) => [`${page.version_id}\n${page.page_number}`, page]));
      const slotVersions = new Set();
      if (options.slots) {
        for (const slot of options.slots) {
          const versionId = normalized.body.page_sets?.[slot];
          if (typeof versionId === "string") slotVersions.add(versionId);
        }
      }
      const selectedVersions = options.slots
        ? new Set([...slotVersions].filter((versionId) => !options.version_ids || options.version_ids.has(versionId)))
        : options.version_ids;
      const selectedPageKeys = new Set([...pageMap.keys()].filter((key) => {
        const versionId = key.split("\n", 1)[0];
        return !selectedVersions || selectedVersions.has(versionId);
      }));
      const processedPageKeys = new Set();
      const iterator = queryPages.iterate(dataset, item.record.id)[Symbol.iterator]();
      let currentKey = "";
      let currentVersion = "";
      let currentChunks = [];
      let currentByteLength = 0;
      let perRecordSnippets = 0;
      const flush = () => {
        if (!currentKey) return;
        const page = pageMap.get(currentKey);
        if (!page) fail("SNAPSHOT_UNVERIFIED", `record ${item.record.id} 搜尋頁缺少 envelope page ref`);
        processedPageKeys.add(currentKey);
        if (selectedVersions && !selectedVersions.has(currentVersion)) {
          currentKey = ""; currentChunks = []; currentByteLength = 0; return;
        }
        let pageText = currentChunks.join("");
        if (options.normalizeWhitespace) pageText = pageText.replace(/\s+/gu, " ").trim();
        if (!pageText.trim()) emptyTextPageCount += 1;
        const searchTerm = options.normalizeWhitespace ? options.keyword.replace(/\s+/gu, " ").trim() : options.keyword;
        if (!searchTerm) { currentKey = ""; currentChunks = []; currentByteLength = 0; return; }
        const snippets = [];
        let cursor = 0;
        let matchCount = 0;
        while (cursor <= pageText.length - searchTerm.length) {
          const found = pageText.indexOf(searchTerm, cursor);
          if (found < 0) break;
          matchCount += 1;
          if (snippets.length < options.snippetsPerPage &&
              perRecordSnippets < options.perRecordMax && snippetCount < options.maxSnippets) {
            const start = Math.max(0, found - options.snippetBefore);
            const end = Math.min(pageText.length, found + searchTerm.length + options.snippetAfter);
            snippets.push(pageText.slice(start, end));
            perRecordSnippets += 1;
            snippetCount += 1;
          }
          cursor = found + searchTerm.length;
        }
        if (matchCount) {
          matchedPagesCount += 1;
          totalPageMatches += matchCount;
          const shown = pageMatches.length < options.maxMatches;
          if (shown) {
            pageMatches.push({
              id: item.record.id,
              version_id: page.version_id,
              page_number: page.page_number,
              source: page.source,
              raw_sha256: page.raw_sha256,
              page_ref: page.ref,
              match_count: matchCount,
              snippets,
            });
          } else omittedPageMatches += 1;
          omittedOccurrences += Math.max(0, matchCount - snippets.length);
        }
        currentKey = ""; currentChunks = []; currentByteLength = 0;
      };
      for (const row of iterator) {
        const key = `${row.version_id}\n${row.page_number}`;
        if (currentKey && key !== currentKey) flush();
        if (!currentKey) {
          currentKey = key;
          currentVersion = row.version_id;
        }
        if (row.chunk_index !== currentChunks.length) fail("SNAPSHOT_UNVERIFIED", `record ${item.record.id} page search chunk 順序不連續`);
        const bytes = Buffer.from(row.text, "utf8");
        currentByteLength += bytes.length;
        if (currentByteLength > MAX_V2_PAGE_SEARCH_BYTES) fail("SNAPSHOT_UNVERIFIED", `record ${item.record.id} page search 超過大小上限`);
        currentChunks.push(row.text);
      }
      flush();
      for (const key of selectedPageKeys) if (!processedPageKeys.has(key)) emptyTextPageCount += 1;
    }
    return {
      page_matches: pageMatches,
      matched_pages_count: matchedPagesCount,
      total_page_matches: totalPageMatches,
      omitted_page_matches: omittedPageMatches,
      omitted_occurrences: omittedOccurrences,
      empty_text_page_count: emptyTextPageCount,
      page_search_complete: omittedPageMatches === 0,
    };
  }

  #withoutPageRefs(envelope) {
    const result = { ...envelope };
    delete result.pages;
    return result;
  }

  /** Hydrate one selected payload body after rechecking its release membership. */
  async hydrateV2(dataset, selectedRecord, options = {}) {
    if (!this.db) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    if (!V2_DATASETS.has(dataset) || !selectedRecord || typeof selectedRecord !== "object") {
      fail("FILTER_NOT_CONFIRMED", "hydrateV2 需要 dataset 與 queryV2 selected record");
    }
    const descriptor = normalizeV2Descriptor(selectedRecord.descriptor);
    const reader = new DatabaseSync(this.dbPath, { readOnly: true });
    let source;
    try {
      reader.exec("PRAGMA busy_timeout=3000; BEGIN DEFERRED");
      this.#assertV2Schema(reader);
      const release = reader.prepare("SELECT snapshot_id,manifest_sha256 FROM v2_releases WHERE dataset=?").get(dataset);
      if (!release || release.snapshot_id !== selectedRecord.snapshot_id || release.manifest_sha256 !== selectedRecord.manifest_sha256) {
        fail("SNAPSHOT_UNVERIFIED", "hydrateV2 selected record 已不屬於目前 v2 snapshot");
      }
      const current = reader.prepare("SELECT descriptor_json FROM v2_records WHERE dataset=? AND id=?").get(dataset, descriptor.id);
      if (!current || current.descriptor_json !== canonical(descriptor)) fail("SNAPSHOT_UNVERIFIED", "hydrateV2 descriptor 不屬於目前 release");
      const envelopeRow = reader.prepare("SELECT envelope_json FROM v2_envelopes WHERE dataset=? AND id=?").get(dataset, descriptor.id);
      if (!envelopeRow) fail("SNAPSHOT_UNVERIFIED", "hydrateV2 缺少 envelope mirror");
      const envelopeInput = parseCanonicalJsonBuffer(Buffer.from(envelopeRow.envelope_json, "utf8"), `record ${descriptor.id} envelope`);
      const envelope = normalizeV2Envelope(envelopeInput, descriptor, dataset);
      source = envelope.record.source_url;
      const ref = DerivedStore.calculateRef({
        kind: "envelope", dataset, id: descriptor.id, source,
        raw_sha256: descriptor.raw_sha256, schema_version: "kcc-envelope-v2", body: Buffer.from(envelopeRow.envelope_json, "utf8"),
      });
      if (ref.sha256 !== descriptor.envelope_ref.sha256 || ref.byte_length !== descriptor.envelope_ref.byte_length) {
        fail("SNAPSHOT_UNVERIFIED", "hydrateV2 envelope ref 不一致");
      }
    } finally {
      try { reader.exec("ROLLBACK"); } catch {}
      reader.close();
    }
    const maxBytes = options.maxBytes === undefined ? MAX_DERIVED_OBJECT_BYTES : Number(options.maxBytes);
    return await this.derivedStore.readObject(descriptor.payload_ref, {
      kind: "payload", dataset, id: descriptor.id, source,
      raw_sha256: descriptor.raw_sha256, schema_version: "kcc-payload-v2",
    }, { maxBytes });
  }

  async readDerivedObject(ref, expected, options = {}) {
    return await this.derivedStore.readObject(ref, expected, options);
  }

  readDerivedObjectStream(ref, expected, options = {}) {
    return this.derivedStore.readObjectStream(ref, expected, options);
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
      // Match the meeting registry's date fallback before top-K truncation.
      const value = (record) => order.field === "date"
        ? record.data.date ?? record.data.meeting_date ?? record.retrieved_at
        : record.data[order.field] ?? "";
      const a = String(value(left));
      const b = String(value(right));
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

  async getDatasetVersion(dataset) {
    if (!this.db) fail("LOCAL_DATA_UNAVAILABLE", "本機資料庫未開啟");
    if (!ALLOWED_DATASETS.has(dataset) && !/^kcg-budget-\d{1,3}$/.test(dataset)) {
      fail("FEATURE_UNAVAILABLE", `未設定 dataset=${dataset} 的本機查詢`);
    }
    const reader = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      reader.exec("PRAGMA busy_timeout=3000; BEGIN DEFERRED");
      const tables = new Set(reader.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      if (V2_DATASETS.has(dataset) && tables.has("v2_releases") &&
          reader.prepare("SELECT 1 FROM v2_releases WHERE dataset=?").get(dataset)) return "v2";
      if (tables.has("releases") && reader.prepare("SELECT 1 FROM releases WHERE dataset=?").get(dataset)) return "v1";
      return null;
    } finally {
      try { reader.exec("ROLLBACK"); } catch {}
      reader.close();
    }
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
