import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const BUDGET_RESOURCE = Object.freeze({
  year: 115,
  datasetId: 101174,
  resourceUuid: "6712fdb8-c0ff-4f0c-901f-03023c17e15d",
  version: "original",
  legalStatus: "adopted",
});

const KCC_SEARCH_URL = "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";
const USER_AGENT = "kcg-civic-local-collector/0.1 (bounded public data client)";
const VALIDATOR_VERSION = "local-basic-integrity-v1";

export const PROFILE_MANIFEST = Object.freeze({
  "budget-115": Object.freeze({
    dataset: "kcg-budget-115",
    state: "implemented-bounded",
    maxPages: 1,
    scope: "resource:101174/6712fdb8-c0ff-4f0c-901f-03023c17e15d",
  }),
  "proposals-pilot": Object.freeze({
    dataset: "kcc-proposals-pilot",
    state: "implemented-bounded",
    maxPages: 1,
    scope: "period:07/session:0704/keyword:道路/page:1",
  }),
});

export const SOURCE_MANIFEST = Object.freeze([
  Object.freeze({ dataset: "kcg-budget-115", profile: "budget-115", state: "bounded-profile", hosts: ["openapi.kcg.gov.tw", "data.kcg.gov.tw"] }),
  Object.freeze({ dataset: "kcc-proposals-pilot", profile: "proposals-pilot", state: "bounded-profile", hosts: ["cissearch.kcc.gov.tw"] }),
  Object.freeze({ dataset: "kcc-meetings", profile: null, state: "pending", reason: "尚無已驗證的 bounded query/parser；不建立空成功快照。" }),
  Object.freeze({ dataset: "kcc-meeting-records", profile: null, state: "pending", reason: "尚未把議事錄 PDF 查詢與解析接到 bounded local ingestion。" }),
  Object.freeze({ dataset: "kcg-laws", profile: null, state: "pending", reason: "尚無可重用且經 bounded 驗證的法規 collector；不讀取 legacy seed。" }),
  Object.freeze({ dataset: "kcg-news", profile: null, state: "pending", reason: "尚無可重用且經 bounded 驗證的新聞 collector；不讀取 legacy seed。" }),
]);

function isAllowedProfile(profile) {
  return typeof profile === "string" && Object.hasOwn(PROFILE_MANIFEST, profile);
}

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class CollectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CollectorError";
    this.code = code;
  }
}

function safeErrorCode(error, fallback = "COLLECTION_FAILED") {
  const candidate = error instanceof CollectorError ? error.code : error?.reasonCode;
  return typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : fallback;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function coverageFromCounts(scope, recordCount, sourceTotal) {
  const knownTotal = Number.isInteger(sourceTotal) && sourceTotal >= 0;
  return {
    scope,
    complete: knownTotal && recordCount > 0 && recordCount >= sourceTotal,
    source_total: knownTotal ? sourceTotal : null,
  };
}

export function validateOfficialUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CollectorError("URL_REJECTED", "來源網址格式無效。 ");
  }
  const hosts = allowedHosts instanceof Set ? allowedHosts : new Set(allowedHosts || []);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !hosts.has(url.hostname.toLowerCase())
  ) {
    throw new CollectorError("URL_REJECTED", "網址不在固定官方 HTTPS allowlist。 ");
  }
  return url;
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel?.().catch?.(() => {});
    throw new CollectorError("BYTE_LIMIT", `回應超過 ${maxBytes} bytes 上限。`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CollectorError("BYTE_LIMIT", `回應超過 ${maxBytes} bytes 上限。`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

function retryDelayMs(attempt, response) {
  const retryAfter = Number(response?.headers?.get?.("retry-after") || "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(5000, retryAfter * 1000);
  return Math.min(2000, 250 * 2 ** attempt);
}

function createRateLimiter(minIntervalMs, sleep, now) {
  const lastStart = new Map();
  return async (host) => {
    const current = now();
    const previous = lastStart.get(host);
    if (previous !== undefined && current - previous < minIntervalMs) {
      await sleep(minIntervalMs - (current - previous));
    }
    lastStart.set(host, now());
  };
}

export async function fetchBounded(inputUrl, options = {}, dependencies = {}) {
  const allowedHosts = options.allowedHosts || [];
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxRetries = options.maxRetries ?? 2;
  const method = String(options.method || "GET").toUpperCase();
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new CollectorError("CONFIG_INVALID", "maxBytes 必須是正整數。 ");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new CollectorError("CONFIG_INVALID", "timeoutMs 必須是正整數。 ");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new CollectorError("CONFIG_INVALID", "maxRetries 上限為 2。 ");
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) throw new CollectorError("CONFIG_INVALID", "maxRedirects 上限為 3。 ");
  const fetchImpl = dependencies.fetchImpl || fetch;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now || Date.now;
  const waitForHost = dependencies.rateLimiter || createRateLimiter(options.minIntervalMs ?? 1000, sleep, now);
  let retry = 0;

  while (true) {
    let currentUrl = validateOfficialUrl(inputUrl, allowedHosts);
    let currentMethod = method;
    let currentBody = options.body;
    let currentHeaders = new Headers(options.headers || {});
    let redirectCount = 0;
    let response;
    try {
      while (true) {
        await waitForHost(currentUrl.hostname);
        response = await fetchImpl(currentUrl.toString(), {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!REDIRECT_STATUS.has(response.status)) break;
        if (redirectCount >= maxRedirects) {
          await response.body?.cancel?.().catch?.(() => {});
          throw new CollectorError("REDIRECT_LIMIT", "來源重新導向超過上限。 ");
        }
        const location = response.headers?.get?.("location");
        if (!location) throw new CollectorError("REDIRECT_INVALID", "重新導向缺少 Location。 ");
        const nextUrl = validateOfficialUrl(new URL(location, currentUrl).toString(), allowedHosts);
        await response.body?.cancel?.().catch?.(() => {});
        if ([301, 302, 303].includes(response.status) && currentMethod !== "GET" && currentMethod !== "HEAD") {
          currentMethod = "GET";
          currentBody = undefined;
          currentHeaders.delete("content-type");
        }
        currentUrl = nextUrl;
        redirectCount++;
      }
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      if (retry < maxRetries) {
        await sleep(retryDelayMs(retry));
        retry++;
        continue;
      }
      throw new CollectorError(isTimeout ? "SOURCE_TIMEOUT" : "SOURCE_NETWORK", isTimeout ? "官方來源逾時。" : "官方來源連線失敗。");
    }

    let bytes;
    try {
      bytes = await readBoundedBody(response, maxBytes);
    } catch (error) {
      if (error instanceof CollectorError && error.code === "BYTE_LIMIT") throw error;
      throw new CollectorError("SOURCE_BODY_FAILED", "讀取官方回應失敗。 ");
    }
    if (RETRYABLE_HTTP.has(response.status) && retry < maxRetries) {
      await sleep(retryDelayMs(retry, response));
      retry++;
      continue;
    }
    if (!response.ok) {
      throw new CollectorError("HTTP_STATUS", `官方來源回應 HTTP ${response.status}。`);
    }
    return {
      bytes,
      status: response.status,
      headers: response.headers,
      url: validateOfficialUrl(response.url || currentUrl.toString(), allowedHosts).toString(),
      redirects: redirectCount,
      retries: retry,
    };
  }
}

async function assertRootDirectory(root) {
  if (typeof root !== "string" || !root.trim()) throw new CollectorError("ROOT_REQUIRED", "必須指定本機 store root。 ");
  const requested = path.resolve(root);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CollectorError("STAGING_PATH_INVALID", "store root 必須是實體目錄。 ");
  return realpath(requested);
}

async function ensureSafeDirectory(root, components) {
  const canonicalRoot = await assertRootDirectory(root);
  let current = canonicalRoot;
  for (const component of components) {
    if (!component || component === "." || component === ".." || path.basename(component) !== component) {
      throw new CollectorError("STAGING_PATH_INVALID", "採集暫存路徑元件無效。 ");
    }
    const candidate = path.join(current, component);
    try { await mkdir(candidate, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CollectorError("STAGING_PATH_INVALID", "採集暫存子目錄不得是 symlink 或非目錄。 ");
    const resolved = await realpath(candidate);
    if (resolved !== candidate || path.dirname(resolved) !== current) throw new CollectorError("STAGING_PATH_INVALID", "採集暫存目錄 realpath 超出預期。 ");
    current = resolved;
  }
  return current;
}

async function assertRegularFileNoSymlink(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CollectorError("STAGING_PATH_INVALID", "採集 sidecar 必須是一般檔案。 ");
  const resolved = await realpath(filePath);
  if (resolved !== filePath) throw new CollectorError("STAGING_PATH_INVALID", "採集檔案 realpath 超出預期。 ");
}

async function writeFileExclusive(filePath, bytes) {
  try {
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await assertRegularFileNoSymlink(filePath);
    const existing = await readFile(filePath);
    if (!existing.equals(Buffer.from(bytes))) throw new CollectorError("STAGING_COLLISION", "本機暫存 raw hash 檔案內容不一致。 ");
  }
}

async function persistCaptureMetadata(root, profile, capture) {
  await ensureSafeDirectory(root, [".local-collect-attempts", profile]);
  const rawDir = await ensureSafeDirectory(root, [".local-collect-attempts", profile, "raw"]);
  const capturesDir = await ensureSafeDirectory(root, [".local-collect-attempts", profile, "captures"]);
  const rawPath = path.join(rawDir, `${capture.sha256}.bin`);
  await writeFileExclusive(rawPath, capture.bytes);
  const capturePath = path.join(capturesDir, `${capture.capture_id}.json`);
  await writeFile(capturePath, `${JSON.stringify({
    capture_id: capture.capture_id,
    profile,
    dataset: PROFILE_MANIFEST[profile].dataset,
    source_url: capture.source_url,
    retrieved_at: capture.retrieved_at,
    sha256: capture.sha256,
    byte_length: capture.bytes.byteLength,
    http_status: capture.http_status,
    state: capture.state,
    error_code: capture.error_code || null,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return capturePath;
}

async function canonicalRetrievedAt(root, profile, sourceUrl, sha256, fallback) {
  const captures = await ensureSafeDirectory(root, [".local-collect-attempts", profile, "captures"]);
  let names = [];
  try { names = await readdir(captures); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const times = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const filePath = path.join(captures, name);
      await assertRegularFileNoSymlink(filePath);
      const item = JSON.parse(await readFile(filePath, "utf8"));
      if (item.source_url === sourceUrl && item.sha256 === sha256 && typeof item.retrieved_at === "string") times.push(item.retrieved_at);
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      /* malformed prior sidecars do not become authority */
    }
  }
  times.sort();
  return times[0] || fallback;
}

async function captureResponse({ root, profile, dataset, result, store, now, state = "captured" }) {
  const sha256 = sha256Bytes(result.bytes);
  const observedAt = new Date(now()).toISOString();
  const retrievedAt = await canonicalRetrievedAt(root, profile, result.url, sha256, observedAt);
  const capture = {
    capture_id: randomUUID(),
    bytes: Buffer.from(result.bytes),
    sha256,
    source_url: result.url,
    retrieved_at: retrievedAt,
    http_status: result.status,
    state,
    root: path.resolve(root),
    profile,
  };
  const capturePath = await persistCaptureMetadata(root, profile, capture);
  if (typeof store?.putRawObject !== "function") {
    throw new CollectorError("STORE_API_UNAVAILABLE", "LocalStore.putRawObject API 不可用；raw 已留在本機 attempt staging。 ");
  }
  await store.putRawObject({ sha256, bytes_base64: capture.bytes.toString("base64") });
  return { ...capture, dataset, capturePath };
}

async function updateCaptureState(capture, state, errorCode = null) {
  const capturesDir = await ensureSafeDirectory(capture.root, [".local-collect-attempts", capture.profile, "captures"]);
  if (path.dirname(capture.capturePath) !== capturesDir) throw new CollectorError("STAGING_PATH_INVALID", "capture sidecar 位置不符合 profile 路徑。 ");
  await assertRegularFileNoSymlink(capture.capturePath);
  const content = JSON.parse(await readFile(capture.capturePath, "utf8"));
  content.state = state;
  content.error_code = errorCode;
  const temporary = `${capture.capturePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, capture.capturePath);
}

export async function loadTypeScriptParser(relativePath, { replace = null, forceNative = false } = {}) {
  const absolute = new URL(relativePath, import.meta.url);
  let js;
  if (!forceNative) {
    try {
      const esbuild = await import("esbuild");
      const result = await esbuild.build({
        entryPoints: [fileURLToPath(absolute)],
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        target: "node24",
        logLevel: "silent",
      });
      js = result.outputFiles[0].text;
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  if (!js) {
    let source = await readFile(absolute, "utf8");
    if (replace) source = replace(source);
    js = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: absolute.href });
  }
  const url = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
  return import(url);
}

function decodeText(bytes, contentType = "") {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"']+)/i)?.[1]?.trim().toLowerCase();
  const encoding = charset === "big5" || charset === "cp950" || charset === "windows-950" ? "big5" : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

async function createJobStore(root, storeFactory) {
  if (!root) throw new CollectorError("ROOT_REQUIRED", "必須指定本機 store root。 ");
  const store = await storeFactory(root);
  if (typeof store?.importSnapshot !== "function") throw new CollectorError("STORE_API_UNAVAILABLE", "LocalStore.importSnapshot API 不可用。 ");
  return store;
}

function ensureNonEmptyRecords(records, parserName) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new CollectorError("PARSER_EMPTY", `${parserName} 沒有產生任何有效資料列。`);
  }
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !record.id || typeof record.title !== "string" || !record.title.trim() || typeof record.text !== "string" || !record.text.trim()) {
      throw new CollectorError("RECORD_INVALID", `${parserName} 產生缺少識別碼、標題或文字的資料列。`);
    }
  }
  return records;
}

function makeResult({ profile, status, attempted, succeeded, failed, coverage, recordCount = 0, receipt = null, sourceResults = [], errorCode = null, dryRun = false, commitState = "not-started", basicValidation = null }) {
  return {
    profile,
    dataset: PROFILE_MANIFEST[profile].dataset,
    status,
    dry_run: dryRun,
    commit_state: commitState,
    source_manifest: SOURCE_MANIFEST,
    attempted,
    succeeded,
    failed,
    record_count: recordCount,
    coverage,
    receipt,
    source_results: sourceResults,
    basic_validation: basicValidation || (status === "blocked" ? "not-passed" : dryRun ? "not-run" : "passed"),
    human_semantic_validation: "pending",
    error_code: errorCode,
  };
}

async function writeJobManifest(root, profile, result, now) {
  const jobsDir = await ensureSafeDirectory(root, [".local-collect-attempts", profile, "jobs"]);
  const jobId = `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const manifestPath = path.join(jobsDir, `${jobId}.json`);
  await writeFile(manifestPath, `${JSON.stringify({ job_id: jobId, created_at: new Date(now()).toISOString(), ...result, job_manifest_status: "written", manifest_path: manifestPath }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifestPath;
}

async function commitSnapshot({ store, profile, records, coverage, captures, parserVersion }) {
  const uniqueRaw = new Map(captures.map((capture) => [capture.sha256, capture]));
  const rawObjects = [...uniqueRaw.values()].map((capture) => ({ sha256: capture.sha256, bytes_base64: capture.bytes.toString("base64") }));
  const semanticKey = JSON.stringify({ profile, parserVersion, coverage, records });
  const snapshotId = `${profile}-${createHash("sha256").update(semanticKey).digest("hex").slice(0, 24)}`;
  const receipt = await store.importSnapshot({
    dataset: PROFILE_MANIFEST[profile].dataset,
    snapshot_id: snapshotId,
    records,
    coverage,
    raw_objects: rawObjects,
    parser_version: parserVersion,
    validator_version: VALIDATOR_VERSION,
    validation_status: "passed",
  });
  if (!receipt || !["imported", "unchanged"].includes(receipt.status) || receipt.record_count !== records.length || receipt.dataset !== PROFILE_MANIFEST[profile].dataset || receipt.snapshot_id !== snapshotId) {
    throw new CollectorError("RECEIPT_INVALID", "LocalStore 回傳 receipt 與本次快照不一致。 ");
  }
  return receipt;
}

async function collectBudget({ root, store, fetchImpl, sleep, now, minIntervalMs, rateLimiter }) {
  const candidates = [
    { kind: "openapi", url: `https://openapi.kcg.gov.tw/Api/Service/Get/${BUDGET_RESOURCE.resourceUuid}`, host: "openapi.kcg.gov.tw" },
    { kind: "csv-direct", url: `https://data.kcg.gov.tw/File/directDownload/${BUDGET_RESOURCE.resourceUuid}`, host: "data.kcg.gov.tw" },
  ];
  const sourceResults = [];
  const captures = [];
  let accepted = null;
  let lastError = null;

  for (const source of candidates) {
    let capture = null;
    try {
      const response = await fetchBounded(source.url, {
        allowedHosts: [source.host],
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 10000,
        maxRedirects: 2,
        maxRetries: 2,
        minIntervalMs,
        headers: { Accept: "application/json,text/csv,text/plain;q=0.9", "User-Agent": USER_AGENT },
      }, { fetchImpl, sleep, now, rateLimiter });
      capture = await captureResponse({ root, profile: "budget-115", dataset: PROFILE_MANIFEST["budget-115"].dataset, result: response, store, now });
      captures.push(capture);
      const parser = await loadTypeScriptParser("../tools/budget.parser.ts");
      const rawText = decodeText(response.bytes, response.headers?.get?.("content-type") || "");
      const summary = parser.parseBudgetSummaryRaw(rawText);
      if (!summary || !Number.isInteger(summary.agency_count) || summary.agency_count < 1 || !Number.isFinite(summary.agency_sum_budget_thousand_twd)) {
        throw new CollectorError("PARSER_INVALID", "預算 parser 未通過基本欄位驗證。 ");
      }
      await updateCaptureState(capture, "parsed");
      accepted = { source, response, capture, summary };
      sourceResults.push({ source: source.kind, state: "succeeded", source_url: response.url, sha256: capture.sha256, byte_length: capture.bytes.byteLength });
      break;
    } catch (error) {
      lastError = error instanceof CollectorError ? error : new CollectorError(safeErrorCode(error), "採集或解析流程失敗。 ");
      if (capture) {
        try { await updateCaptureState(capture, "blocked", lastError.code); } catch { /* preserve primary collection error */ }
      }
      sourceResults.push({
        source: source.kind,
        state: "failed",
        error_code: lastError.code,
        ...(capture ? { source_url: capture.source_url, sha256: capture.sha256, byte_length: capture.bytes.byteLength, retrieved_at: capture.retrieved_at } : {}),
      });
      if (["STAGING_PATH_INVALID", "STAGING_COLLISION", "STORE_API_UNAVAILABLE", "ROOT_REQUIRED"].includes(lastError.code)) break;
    }
  }

  if (!accepted) {
    return makeResult({ profile: "budget-115", status: "blocked", attempted: 1, succeeded: 0, failed: 1, coverage: { scope: PROFILE_MANIFEST["budget-115"].scope, complete: false, source_total: null }, sourceResults, errorCode: lastError?.code || "SOURCE_UNAVAILABLE", commitState: "not-committed" });
  }

  const parserVersion = "budget-summary-schema-aware-v2+local-collector-v1";
  const recordRetrievedAt = await canonicalRetrievedAt(root, "budget-115", accepted.response.url, accepted.capture.sha256, accepted.capture.retrieved_at);
  const summary = accepted.summary;
  const record = {
    id: `budget-115:${BUDGET_RESOURCE.datasetId}:${BUDGET_RESOURCE.resourceUuid}`,
    title: "高雄市政府115年度總預算官方資料摘要",
    text: `官方預算資源解析摘要：主管機關 ${summary.agency_count} 筆；主管機關預算合計 ${summary.agency_sum_budget_thousand_twd} 新臺幣千元；官方總額 ${summary.official_total_budget_thousand_twd ?? "未明載"}。`,
    data: {
      year: BUDGET_RESOURCE.year,
      dataset_id: BUDGET_RESOURCE.datasetId,
      resource_uuid: BUDGET_RESOURCE.resourceUuid,
      budget_version: BUDGET_RESOURCE.version,
      legal_status: BUDGET_RESOURCE.legalStatus,
      source_kind: accepted.source.kind,
      summary,
      raw_byte_length: accepted.capture.bytes.byteLength,
    },
    source_url: accepted.response.url,
    retrieved_at: recordRetrievedAt,
    raw_sha256: accepted.capture.sha256,
  };
  const records = ensureNonEmptyRecords([record], "budget-summary-schema-aware-v2");
  const coverage = { scope: PROFILE_MANIFEST["budget-115"].scope, complete: false, source_total: null };
  try {
    const receipt = await commitSnapshot({ store, profile: "budget-115", records, coverage, captures: [accepted.capture], parserVersion });
    return makeResult({ profile: "budget-115", status: "partial", attempted: 1, succeeded: 1, failed: 0, coverage, recordCount: records.length, receipt, sourceResults, commitState: "committed" });
  } catch (error) {
    const normalized = error instanceof CollectorError ? error : new CollectorError(safeErrorCode(error, "STORE_IMPORT_FAILED"), "LocalStore 匯入失敗；未確認快照提交。 ");
    return makeResult({ profile: "budget-115", status: "blocked", attempted: 1, succeeded: 0, failed: 1, coverage, sourceResults, errorCode: normalized.code, commitState: "unknown", basicValidation: "passed" });
  }
}

function proposalTokenHeaders(response) {
  const cookies = response.headers?.getSetCookie?.() || (response.headers?.get?.("set-cookie") ? [response.headers.get("set-cookie")] : []);
  const cookieHeader = cookies.map((value) => value.split(";")[0]).filter(Boolean).join("; ");
  return cookieHeader;
}

async function collectProposals({ root, store, fetchImpl, sleep, now, minIntervalMs, rateLimiter }) {
  const allowedHosts = ["cissearch.kcc.gov.tw"];
  const captures = [];
  const sourceResults = [];
  const scope = PROFILE_MANIFEST["proposals-pilot"].scope;
  let tokenCapture;
  let resultCapture;
  let records = [];
  let sourceTotal = null;
  let parserResponse;
  let commitStarted = false;
  try {
    const parser = await loadTypeScriptParser("../kcc/search.ts", {
      replace: (source) => source.replace(/^import\s+\{\s*fetchWebFormsTokens\s*\}\s+from\s+["']\.\/client["'];?\s*$/m, "const fetchWebFormsTokens = async () => { throw new Error('bounded collector supplies its own request'); };")
    });
    const client = await loadTypeScriptParser("../kcc/client.ts");
    const tokenResponse = await fetchBounded(KCC_SEARCH_URL, {
      allowedHosts,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 10000,
      maxRedirects: 2,
      maxRetries: 2,
      minIntervalMs,
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": USER_AGENT },
    }, { fetchImpl, sleep, now, rateLimiter });
    tokenCapture = await captureResponse({ root, profile: "proposals-pilot", dataset: PROFILE_MANIFEST["proposals-pilot"].dataset, result: tokenResponse, store, now });
    captures.push(tokenCapture);
    const tokenHtml = decodeText(tokenResponse.bytes, tokenResponse.headers?.get?.("content-type") || "");
    const tokens = client.extractTokensFromHtml(tokenHtml, proposalTokenHeaders(tokenResponse));
    if (!tokens.viewState || !tokens.eventValidation) throw new CollectorError("WEBFORMS_TOKEN_MISSING", "議案官方頁缺少必要 WebForms 欄位。 ");

    const fixedQuery = { period: "07", session: "0704", category: "", keyword: "道路" };
    const formData = new URLSearchParams();
    formData.set("__EVENTTARGET", "ctl00$ContentPlaceHolder1$LinkButton1");
    formData.set("__EVENTARGUMENT", "");
    formData.set("__LASTFOCUS", "");
    formData.set("__VIEWSTATE", tokens.viewState);
    formData.set("__VIEWSTATEGENERATOR", tokens.viewStateGenerator);
    formData.set("__VIEWSTATEENCRYPTED", "");
    formData.set("__EVENTVALIDATION", tokens.eventValidation);
    formData.set("ctl00$ContentPlaceHolder1$hidCurrentTab", "");
    formData.set("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod", fixedQuery.period);
    formData.set("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession", fixedQuery.session);
    formData.set("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlMeeting", "");
    formData.set("ctl00$ContentPlaceHolder1$ddlCouncilor", "");
    formData.set("ctl00$ContentPlaceHolder1$ddlPetitionCouncilor", "");
    formData.set("ctl00$ContentPlaceHolder1$ddlCategory", fixedQuery.category);
    formData.set("ctl00$ContentPlaceHolder1$ddlProposalKind", "0");
    formData.set("ctl00$ContentPlaceHolder1$rblState", "");
    formData.set("ctl00$ContentPlaceHolder1$ddlState", "");
    formData.set("ctl00$ContentPlaceHolder1$txtKeyword", fixedQuery.keyword);
    const queryResponse = await fetchBounded(KCC_SEARCH_URL, {
      allowedHosts,
      method: "POST",
      body: formData.toString(),
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 12000,
      maxRedirects: 2,
      maxRetries: 2,
      minIntervalMs,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: tokens.cookieHeader,
        Referer: KCC_SEARCH_URL,
        "User-Agent": USER_AGENT,
      },
    }, { fetchImpl, sleep, now, rateLimiter });
    resultCapture = await captureResponse({ root, profile: "proposals-pilot", dataset: PROFILE_MANIFEST["proposals-pilot"].dataset, result: queryResponse, store, now });
    captures.push(resultCapture);
    const html = decodeText(queryResponse.bytes, queryResponse.headers?.get?.("content-type") || "");
    parserResponse = queryResponse;
    const expectedFilters = [
      ["period", "ddlPeriod", fixedQuery.period],
      ["session", "ddlSession", fixedQuery.session],
      ["keyword", "txtKeyword", fixedQuery.keyword],
    ];
    for (const [field, suffix, expected] of expectedFilters) {
      if (parser.selectedControlValue(html, suffix) !== expected) throw new CollectorError("FILTER_NOT_CONFIRMED", `官方回應未確認固定查詢條件 ${field}。`);
    }
    records = parser.parseProposalRows(html);
    const pager = parser.parsePager(html);
    if (pager.page !== null && pager.page !== 1) throw new CollectorError("PAGE_NOT_FIRST", "官方回應頁碼不是本 profile 允許的第 1 頁。 ");
    sourceTotal = pager.total;
    if (records.length === 0) throw new CollectorError("PARSER_EMPTY", "既有議案索引 parser 沒有產生資料列。 ");
    if (sourceTotal !== null && records.length > sourceTotal) throw new CollectorError("SOURCE_TOTAL_INCONSISTENT", "官方 pager 總數小於解析資料列數。 ");
    if (records.some((row) => !row.proposal_sn || !row.subject?.trim())) throw new CollectorError("PARSER_INVALID", "議案索引 parser 產生缺少流水號或案由的資料列。 ");
    for (const capture of captures) await updateCaptureState(capture, "parsed");
    sourceResults.push({ source: "kcc-proposal-index", state: "succeeded", source_url: queryResponse.url, sha256: resultCapture.sha256, byte_length: resultCapture.bytes.byteLength, returned_count: records.length, source_total: sourceTotal, current_page: pager.page, page_count: pager.pages, tab_counts: pager.tabCounts });

    const normalized = ensureNonEmptyRecords(records.map((row) => ({
      id: row.proposal_sn,
      title: row.subject.trim(),
      text: [row.subject, row.proposer, row.status].filter(Boolean).join("\n"),
      data: {
        ...JSON.parse(JSON.stringify(row)),
        period: fixedQuery.period,
        session: fixedQuery.session,
        field_source: "confirmed_query_scope",
        query: fixedQuery,
        pager: { current_page: pager.page, page_count: pager.pages, tab_counts: pager.tabCounts },
        page_limit: 1,
      },
      source_url: queryResponse.url,
      retrieved_at: resultCapture.retrieved_at,
      raw_sha256: resultCapture.sha256,
    })), "kcc-proposal-index-parser");
    const complete = sourceTotal !== null && normalized.length >= sourceTotal;
    const coverage = coverageFromCounts(scope, normalized.length, sourceTotal);
    const parserVersion = "kcc-proposal-index-v1+bounded-webforms-v1";
    commitStarted = true;
    const receipt = await commitSnapshot({ store, profile: "proposals-pilot", records: normalized, coverage, captures, parserVersion });
    return makeResult({ profile: "proposals-pilot", status: complete ? "complete" : "partial", attempted: 1, succeeded: 1, failed: 0, coverage, recordCount: normalized.length, receipt, sourceResults, commitState: "committed" });
  } catch (error) {
    const normalized = error instanceof CollectorError ? error : new CollectorError(safeErrorCode(error), "提案 profile 採集或匯入失敗。 ");
    for (const capture of captures) {
      try { await updateCaptureState(capture, "blocked", normalized.code); } catch { /* preserve the original collector result */ }
    }
    sourceResults.push({
      source: "kcc-proposal-index",
      state: "blocked",
      source_url: parserResponse?.url || KCC_SEARCH_URL,
      error_code: normalized.code,
      raw_captures: captures.map((capture) => ({ source_url: capture.source_url, sha256: capture.sha256, byte_length: capture.bytes.byteLength, retrieved_at: capture.retrieved_at })),
    });
    return makeResult({ profile: "proposals-pilot", status: "blocked", attempted: 1, succeeded: 0, failed: 1, coverage: { scope, complete: false, source_total: sourceTotal }, sourceResults, errorCode: normalized.code, commitState: commitStarted ? "unknown" : "not-committed", basicValidation: commitStarted ? "passed" : "not-passed" });
  }
}

export function parseCollectorArgs(argv) {
  const values = { profile: null, root: null, maxPages: 1, run: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--run") {
      values.run = true;
      continue;
    }
    if (arg === "--dry-run") {
      values.run = false;
      continue;
    }
    if (!["--profile", "--root", "--max-pages"].includes(arg)) throw new CollectorError("ARGUMENT_INVALID", "包含未支援的 CLI 參數。 ");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new CollectorError("ARGUMENT_INVALID", `${arg} 缺少值。`);
    if (arg === "--profile") values.profile = value;
    if (arg === "--root") values.root = value;
    if (arg === "--max-pages") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new CollectorError("ARGUMENT_INVALID", "--max-pages 必須是正整數。 ");
      values.maxPages = parsed;
    }
  }
  if (!isAllowedProfile(values.profile)) throw new CollectorError("PROFILE_NOT_ALLOWLISTED", "profile 不在固定 allowlist。 ");
  if (!values.root) throw new CollectorError("ROOT_REQUIRED", "必須指定 --root 本機 store 路徑。 ");
  if (values.maxPages > PROFILE_MANIFEST[values.profile].maxPages) throw new CollectorError("PAGE_LIMIT", `profile ${values.profile} 的 --max-pages 上限為 ${PROFILE_MANIFEST[values.profile].maxPages}。`);
  return values;
}

export async function runCollection(options, dependencies = {}) {
  const { profile, root, maxPages = 1, run = false } = options;
  if (!isAllowedProfile(profile)) throw new CollectorError("PROFILE_NOT_ALLOWLISTED", "profile 不在固定 allowlist。 ");
  if (!root) throw new CollectorError("ROOT_REQUIRED", "必須指定本機 store root。 ");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > PROFILE_MANIFEST[profile].maxPages) throw new CollectorError("PAGE_LIMIT", "超過 profile 固定頁數上限。 ");
  if (!run) {
    return makeResult({ profile, status: "pending", attempted: 0, succeeded: 0, failed: 0, coverage: { scope: PROFILE_MANIFEST[profile].scope, complete: false, source_total: null }, dryRun: true, commitState: "not-started" });
  }
  const now = dependencies.now || Date.now;
  let result;
  let activeStore = null;
  let safeRoot = root;
  try {
    safeRoot = await assertRootDirectory(root);
    activeStore = await createJobStore(safeRoot, dependencies.storeFactory || (() => { throw new CollectorError("STORE_API_UNAVAILABLE", "LocalStore factory 未提供。 "); }));
    const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const minIntervalMs = dependencies.minIntervalMs ?? 1000;
    const rateLimiter = dependencies.rateLimiter || createRateLimiter(minIntervalMs, sleep, now);
    const shared = { root: safeRoot, store: activeStore, fetchImpl: dependencies.fetchImpl, sleep, now, minIntervalMs, rateLimiter };
    result = profile === "budget-115" ? await collectBudget(shared) : await collectProposals(shared);
  } catch (error) {
    const normalized = error instanceof CollectorError ? error : new CollectorError(safeErrorCode(error), "採集工作失敗。 ");
    result = makeResult({ profile, status: "blocked", attempted: 1, succeeded: 0, failed: 1, coverage: { scope: PROFILE_MANIFEST[profile].scope, complete: false, source_total: null }, errorCode: normalized.code, commitState: "not-committed" });
  } finally {
    try { activeStore?.close?.(); } catch { /* collection outcome is preserved; receipt remains the write evidence */ }
  }
  try {
    result.manifest_path = await writeJobManifest(safeRoot, profile, result, now);
    result.job_manifest_status = "written";
  } catch (error) {
    result.manifest_path = null;
    result.job_manifest_status = "blocked";
    result.job_manifest_error_code = safeErrorCode(error, "JOB_MANIFEST_PATH_INVALID");
  }
  return result;
}
