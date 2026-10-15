import { createHash } from "node:crypto";

export const NEWS_INDEX_ROUND_VERSION = 1;
export const NEWS_ROUND_SCOPES = Object.freeze({
  messages: Object.freeze({ path: "/News.aspx", n: "F29A02A9D36C47F0", sms: "19902EF36D6B551D" }),
  city: Object.freeze({ path: "/CityNews1.aspx", n: "3A379BB94CA5F12D" }),
});

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const roundIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isNewsIndexRound(state) {
  return state?.profile === "kcg-news" && state.index_round_version === NEWS_INDEX_ROUND_VERSION;
}

export function validateNewsIndexRoundState(state) {
  if (state?.index_round_version === undefined) return;
  if (!isNewsIndexRound(state) || !roundIdPattern.test(state.index_round_id || "") ||
      !Number.isSafeInteger(state.index_round_attempt) || state.index_round_attempt < 1 || state.index_round_attempt > 3 ||
      !["indexing", "verifying", "frozen", "details", "complete"].includes(state.index_round_phase) ||
      !Array.isArray(state.index_round_pages) || !Array.isArray(state.records) || !Array.isArray(state.queues) ||
      !state.captures || typeof state.captures !== "object" || !state.entries || typeof state.entries !== "object" ||
      !Array.isArray(state.finished_scopes) || !state.index_round_verifications || typeof state.index_round_verifications !== "object") {
    fail("CHECKPOINT_INVALID", "官方新聞 index_round checkpoint 欄位無效");
  }
  if (["frozen", "details", "complete"].includes(state.index_round_phase)) {
    if (!state.index_round_frozen_at || !/^[a-f0-9]{64}$/.test(state.index_round_digest || "") || state.queues.length ||
        !state.all_listing_done || !Object.keys(NEWS_ROUND_SCOPES).every((scope) => state.index_round_verifications[scope])) {
      fail("CHECKPOINT_INVALID", "已凍結的官方新聞 index_round 缺少驗證證據");
    }
  } else {
    if (state.records.length) fail("CHECKPOINT_INVALID", "官方新聞 index_round 完成凍結前不得含明細 record");
    if (state.index_round_phase === "verifying" && (state.queues.length || !state.all_listing_done)) {
      fail("CHECKPOINT_INVALID", "官方新聞 verifying checkpoint 尚有未完成索引工作");
    }
  }
}

export function createNewsIndexRoundState(state, { attempt, id, checkpointSha256, checkpointFileSha256, preparedAt }) {
  const priorPublishedCount = Number.isSafeInteger(state.prior_published_count)
    ? state.prior_published_count : state.records.length;
  return {
    ...state,
    index_round_version: NEWS_INDEX_ROUND_VERSION,
    index_round_id: id,
    index_round_attempt: attempt,
    index_round_phase: "indexing",
    index_round_source_checkpoint_sha256: checkpointSha256,
    index_round_source_checkpoint_file_sha256: checkpointFileSha256,
    index_round_prepared_at: preparedAt,
    index_round_prepared_from_error_code: "SOURCE_DRIFT",
    index_round_pages: [],
    index_round_verifications: {},
    index_round_digest: null,
    index_round_frozen_at: null,
    index_round_scope_evidence: null,
    index_round_capture_window: null,
    prior_published_count: priorPublishedCount,
    records: [],
    entries: {},
    queues: [
      { url: "https://www.kcg.gov.tw/News.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D", type: "index", scope: "messages" },
      { url: "https://www.kcg.gov.tw/CityNews1.aspx?n=3A379BB94CA5F12D", type: "index", scope: "city", page: 1 },
    ],
    listing_seen: [],
    totals: {},
    scope_counts: {},
    finished_scopes: [],
    all_listing_done: false,
    exhausted: false,
    last_error_code: null,
  };
}

function scopeForTask(task) {
  if (!Object.hasOwn(NEWS_ROUND_SCOPES, task?.scope)) fail("SOURCE_ID_MISMATCH", "官方新聞索引工作 scope 無效");
  return task.scope;
}

function singleParam(url, name, expected) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] === expected;
}

function validatedNewsRoundTaskUrl(task) {
  const scope = scopeForTask(task), spec = NEWS_ROUND_SCOPES[scope];
  let page, url;
  try { url = new URL(task.url); } catch { fail("SOURCE_ID_MISMATCH", "官方新聞索引網址無效"); }
  if (url.protocol !== "https:" || url.hostname !== "www.kcg.gov.tw" || url.pathname !== spec.path || url.username || url.password || url.port || url.hash) {
    fail("SOURCE_ID_MISMATCH", "官方新聞索引來源路徑不符合固定 scope");
  }
  if (scope === "messages") {
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !["n", "sms", "page", "PageSize"].includes(key)) ||
        !singleParam(url, "n", spec.n) || !singleParam(url, "sms", spec.sms) ||
        url.searchParams.getAll("page").length > 1 || url.searchParams.getAll("PageSize").length > 1 ||
        (url.searchParams.has("PageSize") && url.searchParams.get("PageSize") !== "20")) {
      fail("SOURCE_ID_MISMATCH", "最新消息索引 scope 或固定參數不符");
    }
    page = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : 1;
    if (!Number.isSafeInteger(page) || page < 1 || (url.searchParams.has("page") && String(page) !== url.searchParams.get("page"))) {
      fail("SOURCE_ID_MISMATCH", "最新消息頁次無效");
    }
    if (task.parent_capture_key) fail("SOURCE_ID_MISMATCH", "最新消息 GET 分頁不得混入市政新聞 POST parent");
  } else {
    if ([...url.searchParams.keys()].length !== 1 || !singleParam(url, "n", spec.n) || !Number.isSafeInteger(task.page) || task.page < 1 ||
        (task.page === 1 && task.parent_capture_key) || (task.page > 1 && !task.parent_capture_key)) {
      fail("SOURCE_ID_MISMATCH", "市政新聞索引 scope、頁次或原生 POST parent 不符");
    }
    page = task.page;
  }
  return { scope, page };
}

export function validateNewsRoundTask(state, task, requestKey) {
  const { scope, page } = validatedNewsRoundTaskUrl(task);
  if (scope === "city" && page > 1) {
    const prior = state.index_round_pages.find((item) => item.scope === "city" && item.page === page - 1);
    if (!prior || task.parent_capture_key !== prior.request_key) fail("SOURCE_ID_MISMATCH", "市政新聞 POST parent 未指向前一頁原件");
  }
  const expectedPage = state.index_round_pages.filter((item) => item.scope === scope).length + 1;
  if (page !== expectedPage || requestKey !== `NEWS-INDEX:${state.index_round_id}:${scope}:page:${page}`) {
    fail("SOURCE_ID_MISMATCH", "官方新聞索引頁次不連續或回合 request namespace 不符");
  }
  return { scope, page };
}

function validateNewsRoundCaptureScope(task, capture) {
  const expected = validatedNewsRoundTaskUrl(task);
  if (!capture || capture.request_method !== (task.parent_capture_key ? "POST" : "GET")) fail("SOURCE_ID_MISMATCH", "官方新聞索引原件請求方法不符");
  for (const address of [capture.requested_url, capture.url]) {
    const actual = validatedNewsRoundTaskUrl({ ...task, url: address });
    if (actual.scope !== expected.scope || actual.page !== expected.page) fail("SOURCE_ID_MISMATCH", "官方新聞索引 redirect 改變 scope 或頁次");
  }
}

export function validateNewsRoundEntry(entry, scope) {
  if (!entry || typeof entry.title !== "string" || !entry.title.trim()) fail("SOURCE_STRUCTURE_CHANGED", "官方新聞索引缺少標題");
  let url;
  try { url = new URL(entry.url); } catch { fail("SOURCE_ID_MISMATCH", "官方新聞明細網址無效"); }
  if (url.protocol !== "https:" || url.hostname !== "www.kcg.gov.tw" || url.username || url.password || url.port || url.hash) {
    fail("SOURCE_ID_MISMATCH", "官方新聞明細來源不符合固定主機");
  }
  if (scope === "messages") {
    const nativeId = url.searchParams.get("s");
    if (url.pathname !== "/News_Content.aspx" || !singleParam(url, "n", NEWS_ROUND_SCOPES.messages.n) ||
        !singleParam(url, "sms", NEWS_ROUND_SCOPES.messages.sms) || url.searchParams.getAll("s").length !== 1 ||
        !/^[a-f0-9]{16}$/i.test(nativeId || "") || entry.id !== `messages:${nativeId}`) {
      fail("SOURCE_ID_MISMATCH", "最新消息 entry namespace、路徑或官方參數不符");
    }
  } else if (scope === "city") {
    const nativeId = url.searchParams.get("ss");
    if (url.pathname !== "/CityNews_Detail1.aspx" || !singleParam(url, "n", NEWS_ROUND_SCOPES.city.n) ||
        url.searchParams.getAll("ss").length !== 1 || !/^[a-f0-9]{16}$/i.test(nativeId || "") || entry.id !== `city:${nativeId}`) {
      fail("SOURCE_ID_MISMATCH", "市政新聞 entry namespace、路徑或官方參數不符");
    }
  } else fail("SOURCE_ID_MISMATCH", "官方新聞索引 entry scope 無效");
}

export function newsRoundEntryDigest(entries) {
  return hash(JSON.stringify(entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    published_at: entry.published_at || "",
    agency: entry.agency || "",
    category: entry.category || "",
  }))));
}

export function recordNewsRoundPage(state, { task, requestKey, capture, parsed }) {
  const { scope, page } = validateNewsRoundTask(state, task, requestKey);
  validateNewsRoundCaptureScope(task, capture);
  if (!parsed.entries.length && parsed.source_total !== 0) fail("SOURCE_COUNT_MISMATCH", "官方新聞索引頁沒有明細");
  for (const entry of parsed.entries) validateNewsRoundEntry(entry, scope);
  if (parsed.entries.some((entry) => state.entries[entry.id])) fail("SOURCE_ID_MISMATCH", "官方新聞新索引回合出現重複 entry");
  if (scope === "city" && (parsed.current_page !== page || !Number.isSafeInteger(parsed.total_pages) || parsed.total_pages < page)) {
    fail("SOURCE_ID_MISMATCH", "市政新聞官方頁次與 POST 佇列不符");
  }
  state.index_round_pages.push({
    scope, page, request_key: requestKey, request_method: capture.request_method,
    requested_url: capture.requested_url, final_url: capture.url, sha256: capture.sha256,
    retrieved_at: capture.retrieved_at, source_total: parsed.source_total,
    entry_count: parsed.entries.length, ordered_entries_sha256: newsRoundEntryDigest(parsed.entries),
    ...(scope === "city" ? { total_pages: parsed.total_pages } : {}),
  });
}

export function validateNewsRoundListing(state) {
  if (state.queues.length || new Set(state.finished_scopes).size !== 2 ||
      !["messages", "city"].every((scope) => state.finished_scopes.includes(scope))) {
    fail("CHECKPOINT_INVALID", "官方新聞索引回合尚未窮盡兩個固定來源");
  }
  for (const scope of ["messages", "city"]) {
    const pages = state.index_round_pages.filter((item) => item.scope === scope).sort((a, b) => a.page - b.page);
    if (!pages.length || pages.some((item, index) => item.page !== index + 1) ||
        pages.some((item) => item.source_total !== state.totals[scope])) fail("SOURCE_COUNT_MISMATCH", "官方新聞索引頁次或來源總數不連續");
    if (state.scope_counts[scope] !== state.totals[scope] || pages.reduce((sum, item) => sum + item.entry_count, 0) !== state.totals[scope]) {
      fail("SOURCE_COUNT_MISMATCH", "官方新聞索引分頁列數與總數不一致");
    }
    if (scope === "city" && pages.some((item) => item.total_pages !== pages.length)) fail("SOURCE_COUNT_MISMATCH", "市政新聞原生 POST 分頁未達官方末頁");
  }
  if (Object.keys(state.entries).length !== state.totals.messages + state.totals.city ||
      new Set(Object.keys(state.entries)).size !== Object.keys(state.entries).length) fail("SOURCE_COUNT_MISMATCH", "官方新聞索引全體列數或 namespace 不符");
  for (const [key, entry] of Object.entries(state.entries)) {
    if (key !== entry.id) fail("SOURCE_ID_MISMATCH", "官方新聞 entries key 與 entry.id 不一致");
    if (entry.id.startsWith("messages:")) validateNewsRoundEntry(entry, "messages");
    else if (entry.id.startsWith("city:")) validateNewsRoundEntry(entry, "city");
    else fail("SOURCE_ID_MISMATCH", "官方新聞 index_round 出現未知 entry namespace");
  }
  return Object.fromEntries(["messages", "city"].map((scope) => [scope, state.index_round_pages.filter((item) => item.scope === scope).sort((a, b) => a.page - b.page)]));
}

export function verificationRequest(scope) {
  const spec = NEWS_ROUND_SCOPES[scope];
  if (!spec) fail("SOURCE_ID_MISMATCH", "官方新聞 verification scope 無效");
  return {
    scope,
    url: scope === "messages"
      ? "https://www.kcg.gov.tw/News.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D"
      : "https://www.kcg.gov.tw/CityNews1.aspx?n=3A379BB94CA5F12D",
    request_key: `NEWS-VERIFY:${scope}`,
  };
}

export function verificationCaptureKey(state, scope, url) {
  if (!NEWS_ROUND_SCOPES[scope]) fail("SOURCE_ID_MISMATCH", "官方新聞 verification scope 無效");
  return `NEWS-VERIFY:${state.index_round_id}:${scope}:page:1:${hash(url)}`;
}

export function verifyNewsRoundHome(state, { scope, capture, parsed }) {
  validateNewsRoundCaptureScope({ ...verificationRequest(scope), page: 1 }, capture);
  const first = state.index_round_pages.find((item) => item.scope === scope && item.page === 1);
  if (!first || parsed.source_total !== state.totals[scope]) fail("SOURCE_DRIFT", "官方首頁複核總數與本回合索引不同");
  if (scope === "city" && (parsed.current_page !== 1 || parsed.total_pages !== state.index_round_pages.filter((item) => item.scope === "city").length)) {
    fail("SOURCE_COUNT_MISMATCH", "市政新聞首頁複核頁次與 POST 索引不一致");
  }
  for (const entry of parsed.entries) validateNewsRoundEntry(entry, scope);
  if (parsed.entries.length !== first.entry_count || newsRoundEntryDigest(parsed.entries) !== first.ordered_entries_sha256) {
    fail("SOURCE_DRIFT", "官方首頁複核首頁有序 ID／標題／日期／機關資料與本回合索引不同");
  }
  return {
    request_key: capture.request_key,
    request_method: capture.request_method,
    requested_url: capture.requested_url,
    final_url: capture.url,
    sha256: capture.sha256,
    retrieved_at: capture.retrieved_at,
    source_total: parsed.source_total,
    first_page_entries_sha256: newsRoundEntryDigest(parsed.entries),
  };
}

export function freezeNewsIndexRound(state, now = new Date().toISOString()) {
  const pagesByScope = validateNewsRoundListing(state);
  if (!state.index_round_verifications.messages || !state.index_round_verifications.city) fail("CHECKPOINT_INVALID", "官方新聞兩個首頁複核尚未完成");
  const scopeEvidence = Object.fromEntries(["messages", "city"].map((scope) => {
    const pages = pagesByScope[scope];
    const project = (item) => ({
      page: item.page, request_key: item.request_key, request_method: item.request_method,
      requested_url: item.requested_url, final_url: item.final_url, sha256: item.sha256,
      retrieved_at: item.retrieved_at, entry_count: item.entry_count,
      ordered_entries_sha256: item.ordered_entries_sha256,
    });
    return [scope, { first_page: project(pages[0]), last_page: project(pages.at(-1)), pages: pages.map(project) }];
  }));
  const fullIndexDigest = hash(JSON.stringify({
    version: NEWS_INDEX_ROUND_VERSION,
    totals: state.totals,
    scopes: Object.fromEntries(["messages", "city"].map((scope) => [scope, pagesByScope[scope].map((page) => ({
      page: page.page, entry_count: page.entry_count, ordered_entries_sha256: page.ordered_entries_sha256,
    }))])),
    entry_count: Object.keys(state.entries).length,
  }));
  const times = [...state.index_round_pages.map((item) => item.retrieved_at), ...Object.values(state.index_round_verifications).map((item) => item.retrieved_at)].filter(Boolean).sort();
  state.index_round_digest = fullIndexDigest;
  state.index_round_scope_evidence = scopeEvidence;
  state.index_round_frozen_at = now;
  state.index_round_capture_window = {
    started_at: times[0] || now,
    ended_at: times.at(-1) || now,
    semantics: "分段捕獲與複核窗口；不代表官方同一交易快照",
  };
  state.index_round_phase = "frozen";
  state.all_listing_done = true;
  return { digest: fullIndexDigest, scopeEvidence, captureWindow: state.index_round_capture_window };
}
