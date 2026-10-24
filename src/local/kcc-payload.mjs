import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const KCC_V2_DATASETS = new Set([
  "kcc-proposal-details",
  "kcc-proposal-attachments",
  "kcc-meeting-records",
]);

export const KCC_V2_SCHEMA = Object.freeze({
  payload: "kcc-payload-v2",
  envelope: "kcc-envelope-v2",
  search: "kcc-search-manifest-v2",
  searchChunk: "kcc-search-chunk-v2",
  page: "kcc-pdf-page-v2",
});

export const KCC_SEARCH_CHUNK_BYTES = 64 * 1024;
export const KCC_MAX_DESCRIPTOR_BYTES = 1024;
export const KCC_MAX_SEARCH_OBJECT_BYTES = 16 * 1024 * 1024 - 16 * 1024;
export const KCC_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024 - 16 * 1024;
export const KCC_MAX_PAGE_BYTES = 16 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const REF_KEYS = ["byte_length", "sha256"];
const PAGE_REF_MARKER = "__kcc_v2_page_ref";

function codecError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.name = "KccPayloadError";
  error.reasonCode = code;
  throw error;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function canonicalKccJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalKccJson).join(",")}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalKccJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertDataset(dataset) {
  if (!KCC_V2_DATASETS.has(dataset)) codecError("FEATURE_UNAVAILABLE", `dataset=${dataset} 不使用 KCC local-snapshot-v2`);
}

function assertId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9._:#/-]{1,512}$/.test(id)) {
    codecError("SNAPSHOT_UNVERIFIED", "record.id 格式無效");
  }
}

function assertSha(value, field) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) codecError("SNAPSHOT_UNVERIFIED", `${field} 缺少有效 SHA-256`);
}

function officialUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { codecError("SNAPSHOT_UNVERIFIED", `${field} URL 無效`); }
  if (url.protocol !== "https:" || url.hostname !== "cissearch.kcc.gov.tw" || url.username || url.password || url.port) {
    codecError("SOURCE_ID_MISMATCH", `${field} 必須是高雄市議會 HTTPS 官方網址`);
  }
  return url.toString();
}

function validateRef(ref, field = "ref") {
  if (!isObject(ref) || Object.keys(ref).some((key) => !REF_KEYS.includes(key)) ||
      Object.keys(ref).length !== 2 || !SHA256_RE.test(ref.sha256 || "") ||
      !Number.isSafeInteger(ref.byte_length) || ref.byte_length < 1) {
    codecError("SNAPSHOT_UNVERIFIED", `${field} 格式無效`);
  }
  return { sha256: ref.sha256.toLowerCase(), byte_length: ref.byte_length };
}

function assertStore(store) {
  if (!store || typeof store.putObject !== "function") codecError("LOCAL_DATA_UNAVAILABLE", "DerivedStore.putObject 未提供給 KCC payload codec");
}

function encodeBody(value, maxBytes, field) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(canonicalKccJson(value), "utf8");
  if (bytes.byteLength > maxBytes) codecError("SNAPSHOT_UNVERIFIED", `${field} 物件超過 ${maxBytes} bytes 上限`);
  return bytes;
}

async function putObject(store, expected, body, maxBytes, label) {
  const bytes = encodeBody(body, maxBytes, label);
  const returned = await store.putObject({ ...expected, body: bytes });
  if (!isObject(returned) || Object.keys(returned).some((key) => !["sha256", "byte_length", "stored"].includes(key)) ||
      (Object.hasOwn(returned, "stored") && typeof returned.stored !== "boolean")) {
    codecError("SNAPSHOT_UNVERIFIED", `${label} ref 格式無效`);
  }
  const ref = validateRef({ sha256: returned.sha256, byte_length: returned.byte_length }, `${label} ref`);
  if (ref.byte_length < bytes.byteLength) codecError("SNAPSHOT_UNVERIFIED", `${label} ref 長度小於 body`);
  return ref;
}

function safeQueryProjection(data) {
  const result = {};
  const blocked = new Set(["pages", "pdf_versions", "original_versions", "attachments", "original_files", "pdf_urls"]);
  for (const [key, value] of Object.entries(data)) {
    if (blocked.has(key) || key.startsWith("__kcc_v2_")) continue;
    if (typeof value === "string") {
      if (byteLength(value) <= 4096) result[key] = value;
    } else if (value === null || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (Array.isArray(value) && value.length <= 100 && value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      const encoded = canonicalKccJson(value);
      if (byteLength(encoded) <= 16 * 1024) result[key] = value;
    }
  }
  return result;
}

function filterProjection(data) {
  const names = [
    "period", "term", "session", "session_code", "meeting", "meeting_code", "meeting_number",
    "councilor", "proposer", "proposer_type", "category", "proposal_sn", "parent_id", "record_id",
    "meeting_id", "session_period", "session_period_number", "date", "meeting_date", "meeting_name",
    "total_pages", "pdf_url", "record_type", "content_index_status", "fulltext_complete",
    "originals_complete", "pdf_originals_complete", "original_availability", "text_layer_status",
  ];
  const result = {};
  for (const name of names) if (Object.hasOwn(data, name)) result[name] = data[name];
  return result;
}

function flagProjection(data) {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (/flag|complete|available|status|pending|unindexed|speaker|repeal|news/i.test(key) &&
        (value === null || ["string", "number", "boolean"].includes(typeof value))) result[key] = value;
  }
  return result;
}

function identityProjection(record, data) {
  return {
    id: record.id,
    ...(data.record_id !== undefined ? { record_id: data.record_id } : {}),
    ...(data.meeting_id !== undefined ? { meeting_id: data.meeting_id } : {}),
    ...(data.proposal_sn !== undefined ? { proposal_sn: data.proposal_sn } : {}),
    ...(data.parent_id !== undefined ? { parent_id: data.parent_id } : {}),
  };
}

function pageSlot(pathParts) {
  return pathParts.reduce((slot, part) => typeof part === "number" ? `${slot}[${part}]` : `${slot}.${part}`, "data");
}

function addPageSet(pageSets, data, pathParts, list, version, record) {
  if (!Array.isArray(list) || list.length === 0) return;
  const slot = pageSlot(pathParts);
  const selectedVersion = version || {};
  const pageUrl = selectedVersion.source_url || selectedVersion.download_url || selectedVersion.pdf_url ||
    (pathParts.length === 1 && data.pdf_url ? data.pdf_url : record.source_url);
  const source = officialUrl(pageUrl, `${record.id} ${slot} source`);
  const rawSha = selectedVersion.raw_sha256 || (pathParts.length === 1 ? record.raw_sha256 : null);
  assertSha(rawSha, `${record.id} ${slot} raw_sha256`);
  const seen = new Set();
  const pages = list.map((page) => {
    if (!isObject(page) || !Number.isInteger(page.page) || page.page < 1 ||
        (page.text !== undefined && typeof page.text !== "string")) {
      codecError("SNAPSHOT_UNVERIFIED", `${record.id} ${slot} 含無效頁碼或文字`);
    }
    if (seen.has(page.page)) codecError("SNAPSHOT_UNVERIFIED", `${record.id} ${slot} 頁碼重複`);
    seen.add(page.page);
    return page;
  }).sort((left, right) => left.page - right.page);
  for (let index = 0; index < pages.length; index += 1) {
    if (pages[index].page !== index + 1) codecError("PARTIAL_SCAN", `${record.id} ${slot} 頁碼不連續`);
  }
  const declared = selectedVersion.total_pages ?? (pathParts.length === 1 ? data.total_pages : undefined);
  if (declared !== undefined && declared !== null && (!Number.isInteger(declared) || declared !== pages.length)) {
    codecError("PARTIAL_SCAN", `${record.id} ${slot} 頁數與來源宣告不一致`);
  }
  pageSets.push({ slot, path: pathParts, version_id: rawSha.toLowerCase(), source, raw_sha256: rawSha.toLowerCase(), pages, total_pages: declared ?? pages.length });
}

function collectPageSets(record, data) {
  const pageSets = [];
  if (Array.isArray(data.pages)) addPageSet(pageSets, data, ["pages"], data.pages, findSelectedPdfVersion(data, record), record);
  for (const [index, version] of (Array.isArray(data.pdf_versions) ? data.pdf_versions : []).entries()) {
    if (Array.isArray(version?.pages)) addPageSet(pageSets, data, ["pdf_versions", index, "pages"], version.pages, version, record);
  }
  for (const [index, version] of (Array.isArray(data.original_versions) ? data.original_versions : []).entries()) {
    if (Array.isArray(version?.pages)) addPageSet(pageSets, data, ["original_versions", index, "pages"], version.pages, version, record);
  }
  return pageSets;
}

function findSelectedPdfVersion(data, record) {
  const versions = Array.isArray(data.pdf_versions) ? data.pdf_versions : [];
  const wanted = data.pdf_url;
  const matching = wanted ? [...versions].reverse().find((item) => item?.pdf_url === wanted || item?.source_url === wanted || item?.download_url === wanted) : null;
  return matching || versions.at(-1) || { source_url: data.pdf_url || record.source_url, raw_sha256: record.raw_sha256, total_pages: data.total_pages };
}

function setAtPath(root, parts, value) {
  let parent = root;
  for (const part of parts.slice(0, -1)) parent = parent[part];
  parent[parts.at(-1)] = value;
}

function getAtPath(root, parts) {
  let value = root;
  for (const part of parts) value = value?.[part];
  return value;
}

function chunkUtf8(value, maxBytes = KCC_SEARCH_CHUNK_BYTES, overlapUnits = 0) {
  if (typeof value !== "string" || value.length === 0) return [];
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let end = start;
    let bytes = 0;
    while (end < value.length) {
      const point = value.codePointAt(end);
      const width = point > 0xffff ? 2 : 1;
      const pieceBytes = Buffer.byteLength(String.fromCodePoint(point), "utf8");
      if (bytes + pieceBytes > maxBytes) break;
      bytes += pieceBytes;
      end += width;
    }
    if (end === start) codecError("SNAPSHOT_UNVERIFIED", "搜尋字元無法放入單一 64 KiB chunk");
    const text = value.slice(start, end);
    chunks.push(text);
    if (end >= value.length) break;
    let next = Math.max(start + 1, end - overlapUnits);
    if (next < end && value.charCodeAt(next - 1) >= 0xd800 && value.charCodeAt(next - 1) <= 0xdbff &&
        value.charCodeAt(next) >= 0xdc00 && value.charCodeAt(next) <= 0xdfff) next -= 1;
    start = next;
  }
  return chunks;
}

export function buildKccV2SearchChunks(record, canonicalData = canonicalKccJson(record.data)) {
  const channels = [
    ["title", typeof record.title === "string" ? record.title : ""],
    ["text", typeof record.text === "string" ? record.text : ""],
    ["data", canonicalData],
  ];
  const chunks = [];
  for (const [source, value] of channels) {
    for (const [block_index, text] of chunkUtf8(value).entries()) {
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength > KCC_SEARCH_CHUNK_BYTES) codecError("SNAPSHOT_UNVERIFIED", `search.${source}[${block_index}] 超過 64 KiB`);
      chunks.push({ block_index, source, sha256: sha256(bytes), byte_length: bytes.byteLength, text });
    }
  }
  return chunks;
}

export function verifyKccV2SearchChunks(chunks, { id = "record" } = {}) {
  if (!Array.isArray(chunks)) codecError("SNAPSHOT_UNVERIFIED", `${id} search.chunks 必須是陣列`);
  const sequences = new Map([["title", 0], ["text", 0], ["data", 0]]);
  for (const [index, chunk] of chunks.entries()) {
    if (!isObject(chunk) || !sequences.has(chunk.source) || !Number.isInteger(chunk.block_index) ||
        chunk.block_index !== sequences.get(chunk.source) || typeof chunk.text !== "string") {
      codecError("SNAPSHOT_UNVERIFIED", `${id} search block ${index} 順序或結構無效`);
    }
    const bytes = Buffer.from(chunk.text, "utf8");
    if (bytes.byteLength > KCC_SEARCH_CHUNK_BYTES || chunk.byte_length !== bytes.byteLength || chunk.sha256 !== sha256(bytes)) {
      codecError("SNAPSHOT_UNVERIFIED", `${id} search block ${index} hash/長度無效`);
    }
    sequences.set(chunk.source, sequences.get(chunk.source) + 1);
  }
  return true;
}

export function verifyKccV2Descriptor(descriptor) {
  const expectedKeys = ["envelope_ref", "id", "payload_ref", "raw_sha256", "search_ref"];
  if (!isObject(descriptor) || Object.keys(descriptor).length !== expectedKeys.length ||
      Object.keys(descriptor).some((key) => !expectedKeys.includes(key))) {
    codecError("SNAPSHOT_UNVERIFIED", "v2 record descriptor 欄位無效");
  }
  assertId(descriptor.id);
  assertSha(descriptor.raw_sha256, `record ${descriptor.id} raw_sha256`);
  const result = {
    id: descriptor.id,
    raw_sha256: descriptor.raw_sha256.toLowerCase(),
    envelope_ref: validateRef(descriptor.envelope_ref, `${descriptor.id} envelope_ref`),
    payload_ref: validateRef(descriptor.payload_ref, `${descriptor.id} payload_ref`),
    search_ref: validateRef(descriptor.search_ref, `${descriptor.id} search_ref`),
  };
  if (byteLength(canonicalKccJson(result)) > KCC_MAX_DESCRIPTOR_BYTES) codecError("SNAPSHOT_UNVERIFIED", `${descriptor.id} v2 descriptor 超過 1 KiB`);
  return result;
}

function pageBodyMarker(page, pageRef, slot) {
  if (Object.hasOwn(page, PAGE_REF_MARKER)) codecError("SNAPSHOT_UNVERIFIED", `來源頁面使用保留欄位 ${PAGE_REF_MARKER}`);
  const output = { ...page };
  delete output.text;
  output[PAGE_REF_MARKER] = {
    ref: { ...pageRef.ref },
    version_id: pageRef.version_id,
    slot,
    page_number: page.page,
  };
  return output;
}

function transformPageSets(data, pageSets) {
  const transformed = structuredClone(data);
  for (const pageSet of pageSets) {
    const list = getAtPath(transformed, pageSet.path);
    if (!Array.isArray(list)) codecError("SNAPSHOT_UNVERIFIED", `來源 ${pageSet.slot} 頁面陣列無效`);
    const byPage = new Map(pageSet.refs.map((entry) => [entry.page_number, entry]));
    const replaced = list.map((page) => {
      const entry = byPage.get(page.page);
      if (!entry) codecError("SNAPSHOT_UNVERIFIED", `來源 ${pageSet.slot} 缺少第 ${page.page} 頁 ref`);
      return pageBodyMarker(page, entry, pageSet.slot);
    });
    setAtPath(transformed, pageSet.path, replaced);
  }
  return transformed;
}

function textRecipe(record, data, pageSets) {
  const primary = pageSets.find((item) => item.slot === "data.pages");
  const requested = record.text_recipe;
  if (requested !== undefined) {
    if (!isObject(requested) || requested.kind !== "page-join" || requested.slot !== "data.pages" || requested.separator !== "\n" ||
        !primary || !Array.isArray(data.pages)) codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} text_recipe 無效或無法綁定 selected pages`);
    return { kind: "page-join", slot: primary.slot, separator: "\n" };
  }
  if (primary && typeof record.text === "string" && Array.isArray(data.pages) && record.text === data.pages.map((page) => page.text).join("\n")) {
    return { kind: "page-join", slot: primary.slot, separator: "\n" };
  }
  return { kind: "inline", value: typeof record.text === "string" ? record.text : "" };
}

function assertRecordInput(dataset, record) {
  assertDataset(dataset);
  if (!isObject(record) || !isObject(record.data)) codecError("SNAPSHOT_UNVERIFIED", "record/data 必須是物件");
  assertId(record.id);
  assertSha(record.raw_sha256, `record ${record.id} raw_sha256`);
  const source = officialUrl(record.source_url, `record ${record.id} source_url`);
  if (typeof record.retrieved_at !== "string" || !Number.isFinite(Date.parse(record.retrieved_at))) {
    codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} retrieved_at 無效`);
  }
  try { JSON.parse(canonicalKccJson(record.data)); } catch { codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} data 不是有效 JSON`); }
  return { source, raw_sha256: record.raw_sha256.toLowerCase() };
}

function pageRefKey(versionId, pageNumber) {
  return `${versionId}\0${pageNumber}`;
}

function validateSearchChunkEntry(chunk, expected = {}) {
  if (!isObject(chunk) || chunk.channel !== expected.channel || chunk.version_id !== expected.version_id ||
      chunk.page_number !== expected.page_number || chunk.schema_version !== KCC_V2_SCHEMA.searchChunk ||
      !Number.isInteger(chunk.block_index) || chunk.block_index < 0 || chunk.chunk_index !== chunk.block_index ||
      typeof chunk.source !== "string" || !SHA256_RE.test(chunk.raw_sha256 || "") || !SHA256_RE.test(chunk.sha256 || "") ||
      !Number.isSafeInteger(chunk.byte_length) || chunk.byte_length < 1 || chunk.byte_length > KCC_SEARCH_CHUNK_BYTES) {
    codecError("SNAPSHOT_UNVERIFIED", "search chunk manifest entry 格式無效");
  }
  officialUrl(chunk.source, "search chunk source");
  return { ...chunk, ref: validateRef(chunk.ref, "search chunk ref") };
}

/** Store one extracted PDF page and its independently searchable 64 KiB chunks. */
export async function packKccV2PdfPage(derivedStore, { dataset, id, source, raw_sha256, page_number, text }) {
  assertStore(derivedStore);
  assertDataset(dataset);
  assertId(id);
  assertSha(raw_sha256, `record ${id} PDF raw_sha256`);
  if (!Number.isInteger(page_number) || page_number < 1 || typeof text !== "string") {
    codecError("SNAPSHOT_UNVERIFIED", `record ${id} PDF page metadata 無效`);
  }
  const pageSource = officialUrl(source, `record ${id} PDF source`);
  const rawSha = raw_sha256.toLowerCase();
  const version_id = rawSha;
  const base = { kind: "pdf-page", dataset, id, source: pageSource, raw_sha256: rawSha, schema_version: KCC_V2_SCHEMA.page };
  const pageBytes = Buffer.from(text, "utf8");
  if (pageBytes.byteLength > KCC_MAX_PAGE_BYTES) codecError("SNAPSHOT_UNVERIFIED", `record ${id} page ${page_number} 超過單頁上限`);
  const ref = await putObject(derivedStore, base, pageBytes, KCC_MAX_PAGE_BYTES + 4096, `${id} PDF page ${page_number}`);
  const page_ref = { version_id, page_number, source: pageSource, raw_sha256: rawSha, ref };
  const search_chunks = [];
  for (const [block_index, part] of chunkUtf8(text, KCC_SEARCH_CHUNK_BYTES, 0).entries()) {
    const bytes = Buffer.from(part, "utf8");
    const chunkRef = await putObject(derivedStore, {
      kind: "search-chunk", dataset, id, source: pageSource, raw_sha256: rawSha, schema_version: KCC_V2_SCHEMA.searchChunk,
    }, bytes, KCC_SEARCH_CHUNK_BYTES + 4096, `${id} page ${page_number} search chunk ${block_index}`);
    search_chunks.push({
      block_index,
      channel: "page",
      version_id,
      page_number,
      chunk_index: block_index,
      source: pageSource,
      raw_sha256: rawSha,
      schema_version: KCC_V2_SCHEMA.searchChunk,
      sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      ref: chunkRef,
    });
  }
  return { page_ref, search_chunks };
}

async function readPageTextFromDerivedStore(derivedStore, dataset, id, pageRef) {
  if (typeof derivedStore.readObject !== "function") codecError("LOCAL_DATA_UNAVAILABLE", "DerivedStore.readObject 必須可讀回預先寫入的 page ref");
  const bytes = await derivedStore.readObject(pageRef.ref, {
    kind: "pdf-page",
    dataset,
    id,
    source: pageRef.source,
    raw_sha256: pageRef.raw_sha256,
    schema_version: KCC_V2_SCHEMA.page,
  }, { maxBytes: KCC_MAX_PAGE_BYTES + 4096 });
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { codecError("SNAPSHOT_UNVERIFIED", `record ${id} page ${pageRef.page_number} UTF-8 無效`); }
}

function normalizePrepackedPageBundles(pageRefs, dataset, id) {
  const bundles = new Map();
  for (const bundle of pageRefs || []) {
    const page = bundle?.page_ref;
    if (!isObject(page) || typeof page.version_id !== "string" || !Number.isInteger(page.page_number) || page.page_number < 1) {
      codecError("SNAPSHOT_UNVERIFIED", `record ${id} page_refs 項目無效`);
    }
    assertSha(page.version_id, `record ${id} page_ref.version_id`);
    assertSha(page.raw_sha256, `record ${id} page_ref.raw_sha256`);
    const source = officialUrl(page.source, `record ${id} page_ref.source`);
    if (page.version_id.toLowerCase() !== page.raw_sha256.toLowerCase()) codecError("SOURCE_ID_MISMATCH", `record ${id} page version_id 與 PDF raw SHA 不一致`);
    const page_ref = { ...page, version_id: page.version_id.toLowerCase(), raw_sha256: page.raw_sha256.toLowerCase(), source, ref: validateRef(page.ref, "page ref") };
    const chunks = Array.isArray(bundle.search_chunks) ? bundle.search_chunks : [];
    chunks.forEach((chunk, index) => {
      const normalized = validateSearchChunkEntry(chunk, {
        channel: "page", version_id: page_ref.version_id, page_number: page_ref.page_number,
      });
      if (normalized.block_index !== index || normalized.source !== source || normalized.raw_sha256.toLowerCase() !== page_ref.raw_sha256) {
        codecError("SNAPSHOT_UNVERIFIED", `record ${id} page ${page_ref.page_number} search chunk binding/sequence 無效`);
      }
    });
    const key = pageRefKey(page_ref.version_id, page_ref.page_number);
    const prior = bundles.get(key);
    if (prior && (prior.page_ref.ref.sha256 !== page_ref.ref.sha256 || prior.page_ref.ref.byte_length !== page_ref.ref.byte_length ||
        prior.page_ref.source !== page_ref.source || prior.page_ref.raw_sha256 !== page_ref.raw_sha256)) {
      codecError("SOURCE_ID_MISMATCH", `record ${id} 同一PDF版本頁面 refs 衝突`);
    }
    if (prior && canonicalKccJson(prior.search_chunks) !== canonicalKccJson(chunks)) codecError("SNAPSHOT_UNVERIFIED", `record ${id} 重複頁面的 search refs 不一致`);
    bundles.set(key, { page_ref, search_chunks: chunks });
  }
  return bundles;
}

/**
 * Packs one full KCC source record into a descriptor plus separate, content-addressed
 * envelope, payload, search, and PDF-page objects. Call once per record so callers
 * can feed importV2 without retaining a corpus of bodies in memory.
 */
export async function packKccV2Record(derivedStore, { dataset, record, page_refs = [] }) {
  assertStore(derivedStore);
  const { source, raw_sha256 } = assertRecordInput(dataset, record);
  const base = { dataset, id: record.id, source, raw_sha256 };
  const originalData = JSON.parse(canonicalKccJson(record.data));
  const pageSets = collectPageSets(record, originalData);
  const pageBundles = normalizePrepackedPageBundles(page_refs, dataset, record.id);

  for (const pageSet of pageSets) {
    pageSet.refs = [];
    for (const page of pageSet.pages) {
      const version_id = pageSet.version_id;
      const key = pageRefKey(version_id, page.page);
      let bundle = pageBundles.get(key);
      if (!bundle && typeof page.text === "string") {
        bundle = await packKccV2PdfPage(derivedStore, {
          dataset, id: record.id, source: pageSet.source, raw_sha256: pageSet.raw_sha256, page_number: page.page, text: page.text,
        });
        pageBundles.set(key, bundle);
      }
      if (!bundle) codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} ${pageSet.slot}[${page.page}] 缺少預存 page ref`);
      const pageRef = bundle.page_ref;
      if (pageRef.source !== pageSet.source || pageRef.raw_sha256 !== pageSet.raw_sha256 || pageRef.version_id !== version_id) {
        codecError("SOURCE_ID_MISMATCH", `record ${record.id} ${pageSet.slot}[${page.page}] page ref 來源/版本不一致`);
      }
      if (typeof page.text === "string" && await readPageTextFromDerivedStore(derivedStore, dataset, record.id, pageRef) !== page.text) {
        codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} ${pageSet.slot}[${page.page}] 預存 page ref 文字不一致`);
      }
      pageSet.refs.push(pageRef);
    }
  }

  const usedPageKeys = new Set(pageSets.flatMap((pageSet) => pageSet.refs.map((page) => pageRefKey(page.version_id, page.page_number))));
  for (const key of pageBundles.keys()) if (!usedPageKeys.has(key)) codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} page_refs 含未被 payload 使用的 ref`);
  const envelopePagesByKey = new Map();
  for (const pageSet of pageSets) for (const page of pageSet.refs) {
    const key = pageRefKey(page.version_id, page.page_number);
    const previous = envelopePagesByKey.get(key);
    if (previous && (previous.ref.sha256 !== page.ref.sha256 || previous.source !== page.source || previous.raw_sha256 !== page.raw_sha256)) {
      codecError("SOURCE_ID_MISMATCH", `record ${record.id} page ref 跨 legacy shape 不一致`);
    }
    envelopePagesByKey.set(key, page);
  }
  const envelopePages = [...envelopePagesByKey.values()].sort((left, right) =>
    left.version_id.localeCompare(right.version_id) || left.page_number - right.page_number);

  const transformedData = transformPageSets(originalData, pageSets);
  const searchData = structuredClone(originalData);
  const materializedPageText = new Map();
  for (const pageSet of pageSets) {
    const pages = getAtPath(searchData, pageSet.path);
    for (const page of pages) {
      const key = pageRefKey(pageSet.version_id, page.page);
      let text = materializedPageText.get(key);
      if (text === undefined) {
        const pageRef = pageSet.refs.find((entry) => entry.page_number === page.page);
        text = typeof page.text === "string" ? page.text : await readPageTextFromDerivedStore(derivedStore, dataset, record.id, pageRef);
        materializedPageText.set(key, text);
      }
      page.text = text;
    }
  }
  const recipe = textRecipe(record, searchData, pageSets);
  const primaryPages = getAtPath(searchData, ["pages"]);
  const pageJoinedText = Array.isArray(primaryPages) ? primaryPages.map((page) => page.text).join(recipe.separator || "\n") : "";
  if (recipe.kind === "page-join" && typeof record.text === "string" && record.text && record.text !== pageJoinedText) {
    codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} record.text 與 page-join 不一致`);
  }
  const searchText = recipe.kind === "page-join" ? pageJoinedText : (typeof record.text === "string" ? record.text : "");
  const searchRecord = { ...record, text: searchText, data: searchData };
  const payloadBody = {
    schema_version: KCC_V2_SCHEMA.payload,
    dataset,
    id: record.id,
    raw_sha256,
    source_url: source,
    retrieved_at: record.retrieved_at,
    title: typeof record.title === "string" ? record.title : "",
    text: recipe,
    data: transformedData,
  };
  const payload_ref = await putObject(derivedStore, {
    ...base, kind: "payload", schema_version: KCC_V2_SCHEMA.payload,
  }, payloadBody, KCC_MAX_PAYLOAD_BYTES, `${record.id} payload`);

  const envelopeBody = {
    schema_version: KCC_V2_SCHEMA.envelope,
    dataset,
    id: record.id,
    raw_sha256,
    title: typeof record.title === "string" ? record.title : "",
    source_url: source,
    retrieved_at: record.retrieved_at,
    identity: identityProjection(record, originalData),
    filters: filterProjection(originalData),
    date: originalData.date ?? originalData.meeting_date ?? record.retrieved_at,
    flags: flagProjection(originalData),
    data: safeQueryProjection(originalData),
    page_sets: Object.fromEntries(pageSets.map(({ slot, version_id }) => [slot, version_id])),
    page_totals: Object.fromEntries(pageSets.map(({ slot, total_pages }) => [slot, total_pages])),
    pages: envelopePages,
  };
  const envelope_ref = await putObject(derivedStore, {
    ...base, kind: "envelope", schema_version: KCC_V2_SCHEMA.envelope,
  }, envelopeBody, KCC_MAX_SEARCH_OBJECT_BYTES, `${record.id} envelope`);

  const canonicalData = canonicalKccJson(searchData);
  const recordChunks = buildKccV2SearchChunks(searchRecord, canonicalData);
  verifyKccV2SearchChunks(recordChunks, { id: record.id });
  const searchChunks = [];
  for (const chunk of recordChunks) {
    const bytes = Buffer.from(chunk.text, "utf8");
    const ref = await putObject(derivedStore, {
      ...base,
      kind: "search-chunk",
      schema_version: KCC_V2_SCHEMA.searchChunk,
    }, bytes, KCC_SEARCH_CHUNK_BYTES + 4096, `${record.id} search.${chunk.source}[${chunk.block_index}]`);
    searchChunks.push({
      block_index: chunk.block_index,
      channel: chunk.source,
      version_id: null,
      page_number: null,
      chunk_index: chunk.block_index,
      source,
      raw_sha256,
      schema_version: KCC_V2_SCHEMA.searchChunk,
      sha256: chunk.sha256,
      byte_length: chunk.byte_length,
      ref,
    });
  }
  for (const bundle of pageBundles.values()) searchChunks.push(...bundle.search_chunks);
  const channelRank = { title: 0, text: 1, data: 2, page: 3 };
  searchChunks.sort((left, right) => channelRank[left.channel] - channelRank[right.channel] ||
    String(left.version_id || "").localeCompare(String(right.version_id || "")) ||
    (left.page_number ?? 0) - (right.page_number ?? 0) || left.chunk_index - right.chunk_index);
  searchChunks.forEach((chunk, index) => { chunk.block_index = index; });
  const searchBody = { schema_version: KCC_V2_SCHEMA.search, chunks: searchChunks };
  const search_ref = await putObject(derivedStore, {
    ...base, kind: "search-manifest", schema_version: KCC_V2_SCHEMA.search,
  }, searchBody, KCC_MAX_SEARCH_OBJECT_BYTES, `${record.id} search`);

  const descriptor = verifyKccV2Descriptor({ id: record.id, raw_sha256, envelope_ref, payload_ref, search_ref });
  return {
    descriptor,
    derived_objects_written: {
      payload_ref,
      envelope_ref,
      search_ref,
      page_count: envelopePages.length,
      search_chunk_count: searchChunks.length,
    },
  };
}

export function verifyKccV2Envelope(record, dataset = record?.dataset) {
  if (!isObject(record) || !isObject(record.descriptor) || !isObject(record.envelope)) codecError("SNAPSHOT_UNVERIFIED", "v2 metadata record 缺少 descriptor/envelope");
  const descriptor = verifyKccV2Descriptor(record.descriptor);
  const envelope = record.envelope;
  if (envelope.schema_version !== KCC_V2_SCHEMA.envelope || envelope.dataset !== dataset || envelope.id !== descriptor.id ||
      envelope.raw_sha256 !== descriptor.raw_sha256 || typeof envelope.source_url !== "string" ||
      !isObject(envelope.data) || !Array.isArray(envelope.pages) || !isObject(envelope.page_sets) || !isObject(envelope.page_totals)) {
    codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope 身分或版本不一致`);
  }
  const source = officialUrl(envelope.source_url, `record ${descriptor.id} envelope.source_url`);
  if (typeof record.id === "string" && record.id !== descriptor.id) codecError("SOURCE_ID_MISMATCH", "record.id 與 descriptor 不一致");
  if (typeof record.raw_sha256 === "string" && record.raw_sha256.toLowerCase() !== descriptor.raw_sha256) codecError("SOURCE_ID_MISMATCH", "record.raw_sha256 與 descriptor 不一致");
  const sequenceByVersion = new Map();
  const envelopePageKeys = new Set();
  let previousPage = null;
  for (const [index, page] of envelope.pages.entries()) {
    if (!isObject(page) || typeof page.version_id !== "string" || !Number.isInteger(page.page_number) || page.page_number < 1 ||
        officialUrl(page.source, `record ${descriptor.id} envelope.pages[${index}].source`) !== page.source ||
        !SHA256_RE.test(page.raw_sha256 || "")) codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope page ${index} metadata 無效`);
    validateRef(page.ref, `record ${descriptor.id} envelope.pages[${index}].ref`);
    assertSha(page.version_id, `record ${descriptor.id} page version_id`);
    if (page.version_id.toLowerCase() !== page.raw_sha256.toLowerCase()) codecError("SOURCE_ID_MISMATCH", `record ${descriptor.id} page version_id/raw SHA 不一致`);
    const key = pageRefKey(page.version_id, page.page_number);
    if (envelopePageKeys.has(key)) codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} page sequence 重複`);
    envelopePageKeys.add(key);
    if (previousPage && (previousPage.version_id > page.version_id ||
        (previousPage.version_id === page.version_id && previousPage.page_number >= page.page_number))) {
      codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} envelope page refs 順序無效`);
    }
    previousPage = page;
    const sequence = sequenceByVersion.get(page.version_id) || [];
    sequence.push(page.page_number);
    sequenceByVersion.set(page.version_id, sequence);
  }
  const uniquePageSets = new Map();
  const pageSetSlots = Object.keys(envelope.page_sets);
  if (pageSetSlots.length !== Object.keys(envelope.page_totals).length ||
      pageSetSlots.some((slot) => !Object.hasOwn(envelope.page_totals, slot))) {
    codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} page_sets/page_totals 欄位不一致`);
  }
  for (const [slot, rawVersionId] of Object.entries(envelope.page_sets)) {
    const versionId = typeof rawVersionId === "string" ? rawVersionId.toLowerCase() : "";
    const totalPages = envelope.page_totals[slot];
    if (!slot.startsWith("data.") || slot.length > 128 || !SHA256_RE.test(versionId) ||
        !Number.isInteger(totalPages) || totalPages < 1) {
      codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} page_set metadata 無效`);
    }
    const prior = uniquePageSets.get(versionId);
    if (prior && prior.total_pages !== totalPages) codecError("SOURCE_ID_MISMATCH", `record ${descriptor.id} 同PDF版本的 page totals 不一致`);
    uniquePageSets.set(versionId, { version_id: versionId, total_pages: totalPages, slot });
  }
  for (const [versionId, pageSet] of uniquePageSets) {
    const sequence = sequenceByVersion.get(versionId) || [];
    if (sequence.length !== pageSet.total_pages || sequence.some((page, index) => page !== index + 1)) {
      codecError("PARTIAL_SCAN", `record ${descriptor.id} ${pageSet.slot} 頁碼序列不完整`);
    }
    sequenceByVersion.delete(versionId);
  }
  for (const page of envelope.pages) {
    const pageSet = uniquePageSets.get(page.version_id);
    if (!pageSet || page.raw_sha256 !== page.version_id) {
      codecError("SOURCE_ID_MISMATCH", `record ${descriptor.id} page ref 與 page_set 版本不一致`);
    }
  }
  if (sequenceByVersion.size) codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} 有未宣告的 page version`);
  return { descriptor, envelope, source };
}

export async function readKccV2Payload(store, dataset, selectedRecord, { maxBytes = KCC_MAX_PAYLOAD_BYTES } = {}) {
  if (!store || typeof store.hydrateV2 !== "function") codecError("LOCAL_DATA_UNAVAILABLE", "LocalStore.hydrateV2 未提供給 KCC payload codec");
  const { descriptor, envelope, source } = verifyKccV2Envelope(selectedRecord, dataset);
  const bytes = await store.hydrateV2(dataset, selectedRecord, { maxBytes });
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) codecError("SNAPSHOT_UNVERIFIED", "hydrateV2 未回傳 verified payload Buffer");
  if (bytes.byteLength > maxBytes) codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} payload 超過讀取上限`);
  let payload;
  try { payload = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} payload JSON 無效`); }
  if (!isObject(payload) || payload.schema_version !== KCC_V2_SCHEMA.payload || payload.dataset !== dataset ||
      payload.id !== descriptor.id ||
      payload.raw_sha256 !== descriptor.raw_sha256 || payload.source_url !== source || !isObject(payload.data) ||
      !isObject(payload.text) || !["inline", "page-join"].includes(payload.text.kind)) {
    codecError("SOURCE_ID_MISMATCH", `record ${descriptor.id} payload binding/schema 不一致`);
  }
  validatePayloadPageRefs(payload, envelope);
  return payload;
}

function validatePayloadPageRefs(payload, envelope) {
  const payloadPages = [];
  const visit = (value, pathParts = ["data"]) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, pathParts);
      return;
    }
    if (!isObject(value)) return;
    if (Object.hasOwn(value, PAGE_REF_MARKER)) {
      const marker = value[PAGE_REF_MARKER];
      if (!Number.isInteger(marker.page_number) || marker.page_number !== value.page || typeof marker.slot !== "string") {
        codecError("SNAPSHOT_UNVERIFIED", "payload 頁面 ref 與頁碼不一致");
      }
      assertSha(marker.version_id, "payload page version_id");
      const ref = validateRef(marker.ref, "payload page ref");
      payloadPages.push({ slot: marker.slot, version_id: marker.version_id.toLowerCase(), page: marker.page_number, ref });
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...pathParts, key]);
  };
  visit(payload.data);
  const envelopePages = envelope.pages.map((page) => ({ version_id: page.version_id, page: page.page_number, ref: validateRef(page.ref) }));
  const payloadKey = (item) => `${item.slot}\0${item.version_id}\0${item.page}`;
  const envelopeKey = (item) => pageRefKey(item.version_id, item.page);
  const payloadMap = new Map(payloadPages.map((item) => [payloadKey(item), item]));
  const envelopeMap = new Map(envelopePages.map((item) => [envelopeKey(item), item]));
  const payloadVersionKeys = new Set(payloadPages.map(envelopeKey));
  if (payloadMap.size !== payloadPages.length || envelopeMap.size !== envelopePages.length || payloadVersionKeys.size !== envelopeMap.size) {
    codecError("SNAPSHOT_UNVERIFIED", "payload/envelope page sequence 數量不一致");
  }
  for (const [pageKey, item] of payloadMap) {
    const counterpart = envelopeMap.get(envelopeKey(item));
    if (!counterpart || counterpart.ref.sha256 !== item.ref.sha256 || counterpart.ref.byte_length !== item.ref.byte_length) {
      codecError("SNAPSHOT_UNVERIFIED", `payload/envelope page ref 不一致：${pageKey.replaceAll("\0", "/")}`);
    }
    if (envelope.page_sets[item.slot] !== item.version_id) {
      codecError("SNAPSHOT_UNVERIFIED", `payload page slot/version 未列入 envelope：${item.slot}`);
    }
  }
  if (payload.text.kind === "page-join" && !Object.hasOwn(envelope.page_sets, payload.text.slot)) {
    codecError("SNAPSHOT_UNVERIFIED", "payload text recipe 指向不存在的頁面組");
  }
}

export function pageTextExpected(dataset, record, pageEntry) {
  const { descriptor, envelope, source } = verifyKccV2Envelope(record, dataset);
  const page = envelope.pages.find((item) => item.version_id === pageEntry.version_id && item.page_number === pageEntry.page_number);
  if (!page || page.ref.sha256 !== pageEntry.ref.sha256 || page.ref.byte_length !== pageEntry.ref.byte_length ||
      page.source !== pageEntry.source || page.raw_sha256 !== pageEntry.raw_sha256) {
    codecError("SNAPSHOT_UNVERIFIED", `record ${descriptor.id} 第 ${pageEntry.page_number} 頁 ref 未綁定 envelope`);
  }
  return {
    kind: "pdf-page",
    dataset,
    id: descriptor.id,
    source: page.source,
    raw_sha256: page.raw_sha256,
    schema_version: KCC_V2_SCHEMA.page,
    record_source_url: source,
  };
}

export async function readKccV2PageText(store, dataset, record, pageEntry, { maxBytes = KCC_MAX_PAGE_BYTES + 4096 } = {}) {
  if (!store || typeof store.readDerivedObject !== "function") codecError("LOCAL_DATA_UNAVAILABLE", "LocalStore.readDerivedObject 未提供頁面讀取");
  const expected = pageTextExpected(dataset, record, pageEntry);
  const bytes = await store.readDerivedObject(pageEntry.ref, {
    kind: expected.kind,
    dataset: expected.dataset,
    id: expected.id,
    source: pageEntry.source,
    raw_sha256: pageEntry.raw_sha256,
    schema_version: expected.schema_version,
  }, { maxBytes });
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) codecError("SNAPSHOT_UNVERIFIED", "readDerivedObject 未回傳 verified page Buffer");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { codecError("SNAPSHOT_UNVERIFIED", `record ${expected.id} page UTF-8 無效`); }
}

/** Stream one verified raw UTF-8 page text body without loading the page at once. */
export async function* streamKccV2PageText(store, dataset, record, pageEntry, { chunkBytes = 64 * 1024 } = {}) {
  if (!store || typeof store.readDerivedObjectStream !== "function") codecError("LOCAL_DATA_UNAVAILABLE", "LocalStore.readDerivedObjectStream 未提供頁面串流");
  const expected = pageTextExpected(dataset, record, pageEntry);
  const stream = await store.readDerivedObjectStream(pageEntry.ref, {
    kind: expected.kind,
    dataset: expected.dataset,
    id: expected.id,
    source: pageEntry.source,
    raw_sha256: pageEntry.raw_sha256,
    schema_version: expected.schema_version,
  }, { chunkBytes });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const bytes of stream) {
      const text = decoder.decode(bytes, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } catch {
    codecError("SNAPSHOT_UNVERIFIED", `record ${record.id} page UTF-8 串流無效`);
  }
}

export async function hydrateKccV2Record(store, dataset, selectedRecord, { maxBytes = KCC_MAX_PAYLOAD_BYTES } = {}) {
  const payload = await readKccV2Payload(store, dataset, selectedRecord, { maxBytes });
  const data = structuredClone(payload.data);
  const pageSets = pageSetsFromPayload(payload.data);
  for (const pageSet of pageSets) {
    const list = getAtPath(data, pageSet.path);
    if (!Array.isArray(list)) codecError("SNAPSHOT_UNVERIFIED", `record ${payload.id} payload ${pageSet.slot} 頁面陣列無效`);
    for (const page of list) {
      const marker = page[PAGE_REF_MARKER];
      const entry = selectedRecord.envelope.pages.find((item) => item.version_id === marker.version_id && item.page_number === marker.page_number);
      if (!entry) codecError("SNAPSHOT_UNVERIFIED", `record ${payload.id} 缺少 page ref`);
      page.text = await readKccV2PageText(store, dataset, selectedRecord, entry);
      delete page[PAGE_REF_MARKER];
    }
  }
  const textPageSet = pageSets.find((set) => set.slot === payload.text.slot);
  const text = payload.text.kind === "inline"
    ? payload.text.value
    : textPageSet && getAtPath(data, textPageSet.path)
      ?.map((page) => page.text).join(payload.text.separator);
  if (typeof text !== "string") codecError("SNAPSHOT_UNVERIFIED", `record ${payload.id} text recipe 無法還原`);
  return {
    id: payload.id,
    title: payload.title,
    text,
    data,
    source_url: payload.source_url,
    retrieved_at: payload.retrieved_at,
    raw_sha256: payload.raw_sha256,
  };
}

function pageSetsFromPayload(data) {
  const result = [];
  const visit = (value, pathParts = ["data"]) => {
    if (!Array.isArray(value)) {
      if (isObject(value)) for (const [key, child] of Object.entries(value)) visit(child, [...pathParts, key]);
      return;
    }
    if (value.length && isObject(value[0]) && Object.hasOwn(value[0], PAGE_REF_MARKER)) {
      const marker = value[0][PAGE_REF_MARKER];
      const path = marker.slot.startsWith("data.") ? parsePageSlot(marker.slot) : null;
      if (!path) codecError("SNAPSHOT_UNVERIFIED", "payload page slot 無效");
      result.push({ slot: marker.slot, path: path.slice(1) });
      return;
    }
    for (const item of value) visit(item, pathParts);
  };
  visit(data);
  return result;
}

function parsePageSlot(slot) {
  if (typeof slot !== "string" || !slot.startsWith("data.")) return null;
  const parts = [];
  const rest = slot.slice(5);
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  for (const match of rest.matchAll(re)) parts.push(match[2] === undefined ? match[1] : Number(match[2]));
  return ["data", ...parts];
}
