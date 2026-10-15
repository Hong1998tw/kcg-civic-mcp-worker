import { TOOL_REGISTRY as SOURCE_REGISTRY } from "../mcp/tools.ts";
import { LocalStoreError } from "./store.mjs";

const LOCAL_PROVIDER = "kaohsiung_civic_mcp";
const MAX_SCAN_ROWS = 1000;
const KCC_CATEGORY_LABELS = new Map([
  ["01", "民政"], ["02", "社政"], ["03", "財經"], ["04", "教育"], ["05", "農林"],
  ["06", "交通"], ["07", "警消衛環"], ["08", "工務"], ["09", "法規"],
]);

function localError(code, message) {
  throw new LocalStoreError(code, message);
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function validateValue(value, schema, field) {
  if (schema?.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      localError("INVALID_ARGUMENT", `${field} 型別無效；預期 ${types.join(" 或 ")}`);
    }
  }
  if (schema?.enum && !schema.enum.some((item) => item === value)) {
    localError("INVALID_ARGUMENT", `${field} 不在允許值內`);
  }
  if (typeof value === "string") {
    if (value.length > 4096) localError("INVALID_ARGUMENT", `${field} 超過 4096 字元`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) localError("INVALID_ARGUMENT", `${field} 超過長度上限`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) localError("INVALID_ARGUMENT", `${field} 小於允許範圍`);
    if (schema.maximum !== undefined && value > schema.maximum) localError("INVALID_ARGUMENT", `${field} 超過允許範圍`);
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) localError("INVALID_ARGUMENT", `${field} 筆數超過上限`);
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items, `${field}[${index}]`));
  }
  if (isObject(value) && schema.properties) validateArgs(schema, value, field);
}

export function validateArgs(schema, value, toolName = "arguments") {
  if (!isObject(value)) localError("INVALID_ARGUMENT", `${toolName} 必須是 JSON 物件`);
  const properties = schema?.properties || {};
  const allowed = new Set(Object.keys(properties));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) localError("UNSUPPORTED_FILTER", `${toolName}.${key} 不在本機工具 schema 支援範圍`);
  }
  for (const key of schema?.required || []) {
    if (!Object.hasOwn(value, key)) localError("INVALID_ARGUMENT", `${toolName}.${key} 為必填`);
  }
  for (const [key, item] of Object.entries(value)) validateValue(item, properties[key], `${toolName}.${key}`);
  return value;
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(record, paths) {
  for (const path of paths) {
    let value = record.data;
    for (const part of path.split(".")) value = value && typeof value === "object" ? value[part] : undefined;
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeComparable(value) {
  return String(value ?? "").normalize("NFC").trim().toLocaleLowerCase("zh-TW");
}

function includesComparable(value, expected) {
  return normalizeComparable(value).includes(normalizeComparable(expected));
}

function recordWithEvidence(record, release) {
  return {
    ...record.data,
    local_provenance: {
      dataset: release.dataset,
      snapshot_id: release.snapshot_id,
      source_url: record.source_url,
      retrieved_at: record.retrieved_at,
      raw_sha256: record.raw_sha256,
      manifest_sha256: release.manifest_sha256,
    },
  };
}

function proposalWithEvidence(record, release) {
  const data = { ...record.data };
  const localProvenance = recordWithEvidence(record, release).local_provenance;
  if (data.field_source === "confirmed_query_scope") {
    const confirmedQueryScope = { period: data.period ?? null, session: data.session ?? null };
    const query = data.query;
    delete data.period;
    delete data.session;
    delete data.field_source;
    delete data.query;
    localProvenance.confirmed_query_scope = confirmedQueryScope;
    if (query !== undefined) localProvenance.query = query;
  }
  return { ...data, local_provenance: localProvenance };
}

function envelope(search, data, meta = {}, statusOverride) {
  const { release } = search;
  const complete = release.coverage.complete && search.local_match_count <= search.records.length + (meta.omitted_local_matches || 0);
  const status = statusOverride || (complete ? "success" : "partial");
  return {
    status,
    provider: LOCAL_PROVIDER,
    updated_at: release.retrieved_at,
    provenance: {
      source_id: release.snapshot_id,
      source_url: release.source_url,
      source_type: "cache",
      agency: release.dataset.startsWith("kcc-") ? "高雄市議會"
        : release.dataset === "kcg-laws" ? "高雄市政府法制局"
          : /^kcg-budget-/.test(release.dataset) ? "高雄市政府主計處"
            : "高雄市政府",
      retrieved_at: release.retrieved_at,
      content_hash: release.manifest_sha256,
      validation_status: "passed",
      snapshot_id: release.snapshot_id,
      coverage: { scope: release.coverage.scope, complete: release.coverage.complete },
    },
    meta: {
      dataset: release.dataset,
      snapshot_id: release.snapshot_id,
      record_count: release.record_count,
      local_match_count: search.local_match_count,
      source_official_total: release.coverage.source_total,
      coverage: release.coverage,
      ...meta,
    },
    data,
  };
}

function sourceUrl(search, fallback) {
  return search.records[0]?.source_url || search.release.source_url || fallback;
}

function boundedLimit(value, fallback = 10, max = 100) {
  if (value === undefined || value === null || value === "") return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) localError("INVALID_ARGUMENT", "limit 必須是正整數");
  return Math.min(limit, max);
}

async function search(store, dataset, { keyword = "", limit = MAX_SCAN_ROWS, offset = 0, predicate = () => true } = {}) {
  return await store.queryRecords(dataset, { keyword, limit: Math.min(limit, MAX_SCAN_ROWS), offset, predicate });
}

function addFieldFilter(filters, name, expected, paths, mode = "exact") {
  if (expected === undefined || expected === null || expected === "") return;
  let sawField = false;
  const filter = (record) => {
    const actual = recordValue(record, paths);
    if (actual === undefined) return false;
    sawField = true;
    return mode === "contains"
      ? includesComparable(actual, expected)
      : normalizeComparable(actual) === normalizeComparable(expected);
  };
  filter.assertSupported = () => {
    if (!sawField) localError("FILTER_NOT_CONFIRMED", `${name} 篩選欄位未包含於此 snapshot`);
  };
  filters.push(filter);
}

function addCouncilorFilter(filters, expected) {
  if (expected === undefined || expected === null || expected === "") return;
  let sawField = false;
  const filter = (record) => {
    let value;
    if (typeof record.data.councilor === "string" && record.data.councilor) value = record.data.councilor;
    else if (record.data.proposer_type === "councilor" && typeof record.data.proposer === "string") value = record.data.proposer;
    if (value === undefined) return false;
    sawField = true;
    return includesComparable(value, expected);
  };
  filter.assertSupported = () => {
    if (!sawField) localError("FILTER_NOT_CONFIRMED", "councilor 篩選欄位未包含可確認議員身分的本機欄位");
  };
  filters.push(filter);
}

function makePredicate(filters) {
  const predicate = (record) => {
    let matched = true;
    for (const filter of filters) {
      const filterMatched = filter(record);
      matched = filterMatched && matched;
    }
    return matched;
  };
  predicate.assertSupported = () => filters.forEach((filter) => filter.assertSupported?.());
  return predicate;
}

function assertFiltersSupported(predicate) {
  predicate.assertSupported?.();
}

function readPages(record) {
  if (Array.isArray(record.data.pages)) {
    if (record.data.pages.length === 0) localError("LOCAL_DATA_UNAVAILABLE", `議事錄 record ${record.id} 沒有頁面文字`);
    const pages = record.data.pages.map((page) => {
      if (!isObject(page) || !Number.isInteger(page.page) || page.page < 1 || typeof page.text !== "string") {
        localError("SNAPSHOT_UNVERIFIED", `議事錄 record ${record.id} 含無效頁碼或文字`);
      }
      return { page: page.page, text: page.text };
    }).sort((a, b) => a.page - b.page);
    assertPageSequence(pages, record.data.total_pages);
    return pages;
  }
  const page = Number(record.data.page);
  if (Number.isInteger(page) && page > 0) {
    if (typeof record.text !== "string") localError("SNAPSHOT_UNVERIFIED", `議事錄 record ${record.id} 缺少文字`);
    return [{ page, text: record.text }];
  }
  localError("LOCAL_DATA_UNAVAILABLE", `議事錄 record ${record.id} 未包含可驗證頁碼與文字`);
}

function assertPageSequence(pages, declaredTotal) {
  const seen = new Set();
  for (let index = 0; index < pages.length; index += 1) {
    if (seen.has(pages[index].page)) localError("SNAPSHOT_UNVERIFIED", "議事錄頁碼重複");
    seen.add(pages[index].page);
    if (pages[index].page !== index + 1) localError("PARTIAL_SCAN", "本機議事錄文字層有缺頁或頁碼不連續");
  }
  if (declaredTotal !== undefined && (!Number.isInteger(declaredTotal) || declaredTotal !== pages.length)) {
    localError("PARTIAL_SCAN", "本機議事錄文字層頁數與來源宣告不一致");
  }
  if (declaredTotal === undefined) localError("PARTIAL_SCAN", "本機議事錄文字層缺少來源宣告總頁數");
}

function recordId(record) {
  return String(record.data.record_id ?? record.data.meeting_id ?? record.id);
}

function proposalId(record) {
  return String(record.data.proposal_sn ?? record.data.id ?? record.id);
}

function storedProposalDetailUrl(record) {
  const value = record.data.detail_url;
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try { url = new URL(value, record.source_url); } catch { localError("SNAPSHOT_UNVERIFIED", `proposal ${proposalId(record)} detail_url 格式無效`); }
  if (url.protocol !== "https:" || url.hostname !== "cissearch.kcc.gov.tw" ||
      !/\/System\/Proposal\/Detail\.aspx$/i.test(url.pathname) || url.username || url.password || url.port) {
    localError("SOURCE_ID_MISMATCH", `proposal ${proposalId(record)} detail_url 不是官方議案詳情頁`);
  }
  const urlId = url.searchParams.get("s") ?? url.searchParams.get("proposal_sn");
  if (urlId && urlId !== proposalId(record)) localError("SOURCE_ID_MISMATCH", `proposal ${proposalId(record)} detail_url 識別碼不一致`);
  return url.toString();
}

function assertProposalDetailRecord(record) {
  const id = proposalId(record);
  let source;
  try { source = new URL(record.source_url); } catch { localError("SNAPSHOT_UNVERIFIED", `proposal ${id} source_url 無效`); }
  if (source.protocol !== "https:" || source.hostname !== "cissearch.kcc.gov.tw" ||
      !/\/System\/Proposal\/Detail\.aspx$/i.test(source.pathname)) {
    localError("LOCAL_DATA_UNAVAILABLE", `proposal ${id} 只有索引來源；本機沒有已驗證的 Detail.aspx 原始內容`);
  }
  const sourceId = source.searchParams.get("s") ?? source.searchParams.get("proposal_sn");
  if (sourceId && sourceId !== id) localError("SOURCE_ID_MISMATCH", `proposal ${id} Detail.aspx 識別碼不一致`);
  const declaredDetail = storedProposalDetailUrl(record);
  if (declaredDetail && declaredDetail !== source.toString()) localError("SOURCE_ID_MISMATCH", `proposal ${id} detail_url 與原始來源不一致`);
  return source.toString();
}

function validateKccAttachments(attachments, record) {
  if (!Array.isArray(attachments)) localError("SNAPSHOT_UNVERIFIED", `proposal ${proposalId(record)} 附件清單格式無效`);
  return attachments.map((attachment) => {
    if (!isObject(attachment)) localError("SNAPSHOT_UNVERIFIED", `proposal ${proposalId(record)} 附件項目格式無效`);
    for (const key of ["url", "download_url", "file_url", "href"]) {
      const value = attachment[key];
      if (typeof value !== "string" || !value.trim()) continue;
      let url;
      try { url = new URL(value, record.source_url); } catch { localError("SNAPSHOT_UNVERIFIED", `proposal ${proposalId(record)} 附件 URL 無效`); }
      if (url.protocol !== "https:" || url.hostname !== "cissearch.kcc.gov.tw" || url.username || url.password || url.port) {
        localError("SOURCE_ID_MISMATCH", `proposal ${proposalId(record)} 附件 URL 不在官方網域`);
      }
    }
    return attachment;
  });
}

function assertKccPdfUrl(record) {
  const id = recordId(record);
  const value = record.data.pdf_url ?? (record.source_url.toLowerCase().endsWith(".pdf") ? record.source_url : "");
  let url;
  try { url = new URL(value); } catch { localError("LOCAL_DATA_UNAVAILABLE", `record ${id} 缺少有效官方 PDF URL`); }
  if (url.protocol !== "https:" || url.hostname !== "cissearch.kcc.gov.tw" ||
      !new RegExp(`/MeetingRecord/${id}/`, "i").test(url.pathname)) {
    localError("SOURCE_ID_MISMATCH", `record ${id} 的 PDF URL 與來源識別碼不一致`);
  }
  return url.toString();
}

function kccCategoryLabel(value) {
  const input = asString(value);
  const match = /^(\d{2})(.*)$/.exec(input);
  if (!match) return input;
  const label = KCC_CATEGORY_LABELS.get(match[1]);
  if (!label) localError("INVALID_ARGUMENT", `category=${match[1]} 不在官方類別代碼範圍`);
  const declaredLabel = match[2].trim();
  if (declaredLabel && !label.includes(declaredLabel) && !declaredLabel.includes(label)) {
    localError("FILTER_NOT_CONFIRMED", `category=${input} 與官方類別 ${label} 不一致`);
  }
  return label;
}

function assertLawRecord(record) {
  const law = record.data;
  if (typeof law.law_id !== "string" || typeof law.law_name !== "string" || typeof law.category !== "string" ||
      typeof law.published_at !== "string" || typeof law.official_url !== "string" || !Array.isArray(law.articles)) {
    localError("SNAPSHOT_UNVERIFIED", `法規 record ${record.id} 缺少輸出 schema 必要欄位`);
  }
  let url;
  try { url = new URL(law.official_url); } catch { localError("SNAPSHOT_UNVERIFIED", `法規 record ${record.id} official_url 無效`); }
  if (url.protocol !== "https:" || url.hostname !== "outlaw.kcg.gov.tw" || url.searchParams.get("id") !== law.law_id) {
    localError("SOURCE_ID_MISMATCH", `法規 record ${record.id} official_url 身分不一致`);
  }
  if (law.articles.some((article) => !isObject(article) || typeof article.article_no !== "string" || typeof article.content !== "string")) {
    localError("SNAPSHOT_UNVERIFIED", `法規 record ${record.id} 條文格式無效`);
  }
  return law;
}

function assertNewsRecord(record) {
  const item = record.data;
  if (typeof item.news_id !== "string" || typeof item.title !== "string" || typeof item.agency !== "string" ||
      typeof item.category !== "string" || typeof item.published_at !== "string" || typeof item.content_summary !== "string") {
    localError("SNAPSHOT_UNVERIFIED", `新聞 record ${record.id} 缺少輸出 schema 必要欄位`);
  }
  const sourceLink = item.source_link ?? record.source_url;
  let url;
  try { url = new URL(sourceLink); } catch { localError("SNAPSHOT_UNVERIFIED", `新聞 record ${record.id} source_link 無效`); }
  if (url.protocol !== "https:" || url.hostname !== "www.kcg.gov.tw" || url.pathname !== "/News_Content.aspx" || !url.searchParams.get("s")) {
    localError("SOURCE_ID_MISMATCH", `新聞 record ${record.id} source_link 身分不一致`);
  }
  return item;
}

const handlers = {
  get_kcg_budget_summary: async (store, args) => {
    const year = args.year === undefined ? 115 : Number(args.year);
    if (!Number.isInteger(year) || year < 1 || year > 999) localError("INVALID_ARGUMENT", "year 必須是有效的民國年度");
    const dataset = `kcg-budget-${year}`;
    const result = await search(store, dataset, { limit: 10 });
    if (result.records.length !== 1) localError("LOCAL_DATA_UNAVAILABLE", `dataset=${dataset} 必須有唯一已整理預算摘要`);
    if (Number(result.records[0].data.year) !== year) localError("SOURCE_ID_MISMATCH", `dataset=${dataset} 的 year 與輸入不一致`);
    const record = result.records[0];
    const source = isObject(record.data.summary) ? record.data.summary : record.data;
    const officialTotal = source.official_total_budget_thousand_twd ?? null;
    if (!Number.isFinite(Number(source.agency_count)) || !Number.isFinite(Number(source.agency_sum_budget_thousand_twd)) ||
        (officialTotal !== null && !Number.isFinite(Number(officialTotal))) ||
        !isObject(source.highest) || !isObject(source.lowest)) {
      localError("SNAPSHOT_UNVERIFIED", `dataset=${dataset} 缺少標準預算摘要欄位`);
    }
    return envelope(result, {
      year,
      budget_version: record.data.budget_version ?? "original",
      legal_status: record.data.legal_status ?? "adopted",
      agency_count: Number(source.agency_count),
      agency_sum_budget_thousand_twd: Number(source.agency_sum_budget_thousand_twd),
      official_total_budget_thousand_twd: officialTotal === null ? null : Number(officialTotal),
      highest: source.highest,
      lowest: source.lowest,
      local_provenance: recordWithEvidence(record, result.release).local_provenance,
    });
  },

  search_kcg_laws: async (store, args) => {
    const keyword = asString(args.keyword);
    if (!keyword || keyword.length > 200) localError("INVALID_ARGUMENT", "keyword 不可為空且不得超過 200 字元");
    const category = asString(args.category);
    const filters = [];
    addFieldFilter(filters, "category", category, ["category"], "contains");
    const predicate = makePredicate(filters);
    const result = await search(store, "kcg-laws", { keyword, limit: MAX_SCAN_ROWS, predicate });
    assertFiltersSupported(predicate);
    const limit = boundedLimit(args.limit, 10, 100);
    const selected = result.records.slice(0, limit);
    const data = selected.map((record) => {
      const law = assertLawRecord(record);
      return {
        law_id: law.law_id,
        law_name: law.law_name,
        category: law.category,
        published_at: law.published_at,
        official_url: law.official_url,
        matched_articles: law.articles.filter((article) => article.content.includes(keyword))
          .map((article) => `${article.article_no}: ${article.content.slice(0, 80)}...`),
        local_provenance: recordWithEvidence(record, result.release).local_provenance,
      };
    });
    return envelope(result, data, {
      query_keyword: keyword,
      query_category: category || "all",
      omitted_local_matches: Math.max(0, result.local_match_count - selected.length),
      note: result.release.coverage.complete ? undefined : "搜尋範圍受不完整本機 coverage 限制。",
    }, result.release.coverage.complete ? undefined : "partial");
  },

  get_kcg_law_detail: async (store, args) => {
    const lawId = asString(args.law_id);
    const lawName = asString(args.law_name);
    if (!lawId && !lawName) localError("INVALID_ARGUMENT", "必須提供 law_id 或 law_name");
    const result = await search(store, "kcg-laws", { limit: MAX_SCAN_ROWS, predicate: (record) =>
      (!!lawId && String(record.data.law_id ?? record.id) === lawId) || (!!lawName && includesComparable(record.data.law_name ?? record.title, lawName)) });
    const record = result.records.find((item) =>
      (!!lawId && String(item.data.law_id ?? item.id) === lawId) || (!!lawName && includesComparable(item.data.law_name ?? item.title, lawName)));
    if (!record) localError("LOCAL_DATA_UNAVAILABLE", "指定法規未出現在本機 snapshot");
    const law = assertLawRecord(record);
    return envelope(result, {
      ...recordWithEvidence(record, result.release),
      articles_count: law.articles.length,
    }, {
      query_id: lawId || undefined,
      query_name: lawName || undefined,
    });
  },

  get_kcg_council_meetings: async (store, args) => {
    const term = args.term === undefined ? 4 : Number(args.term);
    if (!Number.isInteger(term) || term < 1) localError("INVALID_ARGUMENT", "term 必須是正整數");
    if (term !== 4) localError("FEATURE_UNAVAILABLE", "目前只有第 4 屆官方屆次映射");
    const sessionPeriod = args.session_period === undefined ? undefined : Number(args.session_period);
    if (sessionPeriod !== undefined && (!Number.isInteger(sessionPeriod) || sessionPeriod < 1)) localError("INVALID_ARGUMENT", "session_period 必須是正整數");
    const filters = [];
    addFieldFilter(filters, "term", term, ["term", "period"]);
    if (sessionPeriod !== undefined) addFieldFilter(filters, "session_period", sessionPeriod, ["session_period", "session_period_number"]);
    const predicate = makePredicate(filters);
    const result = await search(store, "kcc-meetings", { limit: MAX_SCAN_ROWS, predicate });
    assertFiltersSupported(predicate);
    const limit = boundedLimit(args.limit, 10, 100);
    const selected = result.records.slice(0, limit);
    const data = selected.map((record) => ({
      meeting_id: recordId(record),
      term,
      session_period: record.data.session_period ?? sessionPeriod ?? null,
      meeting_name: record.data.meeting_name ?? record.data.meeting ?? record.title,
      meeting_date: record.data.meeting_date ?? record.data.date ?? "",
      record_type: record.data.record_type,
      pdf_url: assertKccPdfUrl(record),
      local_provenance: recordWithEvidence(record, result.release).local_provenance,
    }));
    if (data.some((record) => !record.meeting_id || !record.meeting_name || !record.meeting_date || !record.pdf_url || !record.record_type)) {
      localError("LOCAL_DATA_UNAVAILABLE", "會議 snapshot 缺少 meeting_id、meeting_name、meeting_date、record_type 或 pdf_url");
    }
    return envelope(result, data, {
      term,
      kcc_period: "07",
      kcc_session: sessionPeriod === undefined ? "all" : `07${String(sessionPeriod).padStart(2, "0")}`,
      omitted_local_matches: Math.max(0, result.local_match_count - selected.length),
    }, result.release.coverage.complete ? undefined : "partial");
  },

  search_kcg_council_interpellations: async (store, args) => {
    const keyword = asString(args.keyword);
    if (!keyword || keyword.length > 200) localError("INVALID_ARGUMENT", "keyword 不可為空且不得超過 200 字元");
    if (args.legislator_name) localError("FEATURE_UNAVAILABLE", "同頁文字命中不能證明發言者歸屬；本機版不接受議員歸屬篩選");
    const result = await search(store, "kcc-meeting-records", { keyword, limit: MAX_SCAN_ROWS });
    const hits = [];
    for (const record of result.records) {
      for (const page of readPages(record)) {
        if (!page.text.includes(keyword)) continue;
        const term = Number(record.data.term);
        const date = record.data.date ?? record.data.meeting_date;
        const meetingName = record.data.meeting_name ?? record.data.meeting;
        if (!Number.isInteger(term) || typeof date !== "string" || typeof meetingName !== "string") {
          localError("LOCAL_DATA_UNAVAILABLE", `record ${record.id} 缺少屆期、日期或會議名稱欄位`);
        }
        hits.push({
          record_id: recordId(record),
          term,
          legislator_name: "未結構化標註",
          topic: keyword,
          content_summary: page.text.slice(Math.max(0, page.text.indexOf(keyword) - 80), page.text.indexOf(keyword) + keyword.length + 120).trim(),
          date,
          meeting_name: meetingName,
          page: page.page,
          local_provenance: recordWithEvidence(record, result.release).local_provenance,
        });
      }
    }
    const limit = boundedLimit(args.limit, 10, 50);
    const data = hits.slice(0, limit);
    const scanTruncated = result.local_match_count > result.records.length;
    const complete = result.release.coverage.complete && !scanTruncated && hits.length === data.length;
    return envelope({ ...result, local_match_count: hits.length }, data, {
      query_keyword: keyword,
      query_legislator: "all",
      omitted_local_matches: Math.max(0, hits.length - data.length),
      ...(scanTruncated ? { local_match_count_lower_bound: hits.length, scan_truncated: true } : {}),
      note: "結果是議事錄頁面文字命中，不代表發言者歸屬。",
    }, complete ? undefined : "partial");
  },

  get_kcg_latest_news: async (store, args) => {
    const filters = [];
    addFieldFilter(filters, "agency", asString(args.agency), ["agency"], "contains");
    addFieldFilter(filters, "category", asString(args.category), ["category"], "contains");
    const predicate = makePredicate(filters);
    const result = await search(store, "kcg-news", { limit: MAX_SCAN_ROWS, predicate });
    assertFiltersSupported(predicate);
    if (result.local_match_count > result.records.length) {
      localError("PARTIAL_SCAN", "新聞索引超過 1000 筆上限，無法確認全域最新排序");
    }
    const selected = [...result.records].sort((a, b) =>
      String(b.data.published_at ?? "").localeCompare(String(a.data.published_at ?? "")));
    const limit = boundedLimit(args.limit, 10, 100);
    const data = selected.slice(0, limit).map((record) => {
      assertNewsRecord(record);
      return { ...recordWithEvidence(record, result.release), source_link: record.data.source_link ?? record.source_url };
    });
    return envelope(result, data, {
      agency_filter: asString(args.agency) || "all",
      category_filter: asString(args.category) || "all",
      omitted_local_matches: Math.max(0, result.local_match_count - data.length),
    }, result.release.coverage.complete ? undefined : "partial");
  },

  search_kcg_news: async (store, args) => {
    const keyword = asString(args.keyword);
    if (!keyword || keyword.length > 200) localError("INVALID_ARGUMENT", "keyword 不可為空且不得超過 200 字元");
    const result = await search(store, "kcg-news", { keyword, limit: MAX_SCAN_ROWS });
    const limit = boundedLimit(args.limit, 10, 100);
    const data = result.records.slice(0, limit).map((record) => {
      assertNewsRecord(record);
      return { ...recordWithEvidence(record, result.release), source_link: record.data.source_link ?? record.source_url };
    });
    const scanTruncated = result.local_match_count > result.records.length;
    return envelope(result, data, {
      query_keyword: keyword,
      omitted_local_matches: Math.max(0, result.local_match_count - data.length),
      ...(scanTruncated ? { scan_truncated: true } : {}),
    }, result.release.coverage.complete && !scanTruncated ? undefined : "partial");
  },

  kcc_search_proposals: async (store, args) => {
    const keyword = asString(args.keyword);
    const dataset = await proposalDataset(store);
    const filters = [];
    addFieldFilter(filters, "period", args.period, ["period", "term"]);
    addFieldFilter(filters, "session", args.session, ["session", "session_code"]);
    addFieldFilter(filters, "meeting", args.meeting, ["meeting", "meeting_code"]);
    addFieldFilter(filters, "meeting_number", args.meeting_number, ["meeting_number"]);
    addCouncilorFilter(filters, args.councilor);
    addFieldFilter(filters, "category", kccCategoryLabel(args.category), ["category"], "contains");
    const predicate = makePredicate(filters);
    const result = await search(store, dataset, { keyword, limit: MAX_SCAN_ROWS, predicate });
    assertFiltersSupported(predicate);
    return proposalResult(result, result.records, { keyword, councilor: asString(args.councilor) }, args.limit);
  },

  kcc_get_proposal: async (store, args) => {
    const id = asString(args.proposal_sn);
    if (!id) localError("INVALID_ARGUMENT", "proposal_sn 不可為空");
    const result = await findProposalDetail(store, id);
    const record = result.records[0];
    const detailUrl = assertProposalDetailRecord(record);
    verifyDetailUrl(args.detail_url, detailUrl, record.source_url);
    return envelope(result, { ...proposalWithEvidence(record, result.release), detail_url: detailUrl }, { query_proposal_sn: id });
  },

  kcc_get_attachments: async (store, args) => {
    const id = asString(args.proposal_sn);
    if (!id) localError("INVALID_ARGUMENT", "proposal_sn 不可為空");
    let result;
    if (await store.hasDataset("kcc-proposal-attachments")) {
      result = await search(store, "kcc-proposal-attachments", { limit: MAX_SCAN_ROWS, predicate: (record) => String(record.data.proposal_sn ?? record.data.parent_id ?? "") === id });
      if (!result.records.length) localError("LOCAL_DATA_UNAVAILABLE", `proposal_sn=${id} 未出現在本機附件 snapshot`);
      const attachments = result.records.flatMap((record) => {
        const items = Array.isArray(record.data.attachments) ? record.data.attachments : [record.data];
        return validateKccAttachments(items, { id, data: { proposal_sn: id }, source_url: record.source_url });
      });
      return envelope({ ...result, local_match_count: attachments.length }, { proposal_sn: id, attachments: attachments.map((item, index) => ({
        ...item,
        local_provenance: recordWithEvidence(result.records[Math.min(index, result.records.length - 1)], result.release).local_provenance,
      })) }, { local_match_count: attachments.length });
    }
    const proposal = await findProposalDetail(store, id);
    const data = proposal.records[0].data;
    if (!Array.isArray(data.attachments)) localError("LOCAL_DATA_UNAVAILABLE", "本機 proposal snapshot 未包含附件清單");
    const attachments = validateKccAttachments(data.attachments, proposal.records[0]);
    return envelope(proposal, { proposal_sn: id, attachments }, { local_match_count: attachments.length });
  },

  kcc_search_meeting_records: async (store, args) => {
    const filters = [];
    const keyword = asString(args.keyword);
    addFieldFilter(filters, "period", args.period, ["period"]);
    addFieldFilter(filters, "session", args.session, ["session", "session_code"]);
    addFieldFilter(filters, "meeting", args.meeting, ["meeting", "meeting_code"]);
    const predicate = makePredicate(filters);
    const result = await search(store, "kcc-meetings", { keyword, limit: MAX_SCAN_ROWS, predicate });
    assertFiltersSupported(predicate);
    return envelope(result, result.records.map((record) => recordWithEvidence(record, result.release)), {
      query: { period: args.period ?? null, session: args.session ?? null, meeting: args.meeting ?? null, keyword: keyword || null },
      omitted_local_matches: Math.max(0, result.local_match_count - result.records.length),
    }, result.release.coverage.complete ? undefined : "partial");
  },

  kcc_get_schedule: async () => localError("FEATURE_UNAVAILABLE", "本機尚無經驗證的議會日程 dataset"),
  kcc_get_councilor: async (store, args) => {
    const name = asString(args.name);
    if (!name || name.length > 100) localError("INVALID_ARGUMENT", "請提供有效的議員姓名");
    const result = await search(store, "kcc-councilors", { keyword: name, limit: MAX_SCAN_ROWS });
    const record = result.records.find((item) => includesComparable(item.data.name ?? item.title, name));
    if (!record) localError("LOCAL_DATA_UNAVAILABLE", "指定議員未出現在本機名錄 snapshot");
    return envelope(result, recordWithEvidence(record, result.release), { query_name: name });
  },

  kcc_get_councilor_proposals: async (store, args) => {
    const name = asString(args.councilor);
    if (!name) localError("INVALID_ARGUMENT", "councilor 不可為空");
    const dataset = await proposalDataset(store);
    const filters = [];
    addCouncilorFilter(filters, name);
    addFieldFilter(filters, "period", args.period, ["period", "term"]);
    addFieldFilter(filters, "session", args.session, ["session", "session_code"]);
    addFieldFilter(filters, "meeting", args.meeting, ["meeting", "meeting_code"]);
    const predicate = makePredicate(filters);
    const result = await search(store, dataset, { limit: MAX_SCAN_ROWS, predicate });
    assertFiltersSupported(predicate);
    return proposalResult(result, result.records, { councilor: name }, undefined);
  },

  kcc_get_proposal_result: async (store, args) => {
    const id = asString(args.proposal_sn);
    if (!id) localError("INVALID_ARGUMENT", "proposal_sn 不可為空");
    const result = await findProposalDetail(store, id);
    const record = result.records[0];
    const detailUrl = assertProposalDetailRecord(record);
    verifyDetailUrl(args.detail_url, detailUrl, record.source_url);
    const data = {
      proposal_sn: id,
      number: record.data.number ?? "",
      category: record.data.category ?? "",
      subject: record.data.subject ?? record.title,
      review: record.data.review ?? null,
      official_status: record.data.official_status ?? null,
      status: record.data.official_status ?? null,
      detail_url: detailUrl,
      local_provenance: recordWithEvidence(record, result.release).local_provenance,
    };
    return envelope(result, data, { note: "只回傳來源明載欄位，不推導市府辦理或議會審議事實。" });
  },

  kcc_search_temporary_proposals: async (store, args) => {
    const filters = [];
    addCouncilorFilter(filters, args.councilor);
    addFieldFilter(filters, "period", args.period, ["period", "term"]);
    const predicate = makePredicate(filters);
    const result = await search(store, "kcc-temporary-proposals", { keyword: asString(args.keyword), limit: MAX_SCAN_ROWS, predicate });
    assertFiltersSupported(predicate);
    return envelope(result, result.records.map((record) => recordWithEvidence(record, result.release)), {
      omitted_local_matches: Math.max(0, result.local_match_count - result.records.length),
    }, result.release.coverage.complete ? undefined : "partial");
  },

  kcc_search_committees: async (store, args) => {
    const name = asString(args.committee_name);
    if (!name) localError("INVALID_ARGUMENT", "committee_name 不可為空");
    const result = await search(store, "kcc-committees", { keyword: name, limit: MAX_SCAN_ROWS });
    return envelope(result, result.records.map((record) => recordWithEvidence(record, result.release)), { query_committee: name });
  },

  kcc_search_speeches: async () => localError("FEATURE_UNAVAILABLE", "議事錄頁面文字不足以證明發言者歸屬；本機版不提供發言歸屬查詢"),
  kcc_get_proposal_relations: async () => localError("FEATURE_UNAVAILABLE", "本機尚無經驗證的議案關聯 dataset"),

  kcc_get_meeting_record: async (store, args) => {
    const id = asString(args.record_id);
    if (!/^\d{1,20}$/.test(id)) localError("INVALID_ARGUMENT", "record_id 必須是數字識別碼");
    if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1)) localError("INVALID_ARGUMENT", "page 必須是正整數");
    const keyword = asString(args.keyword);
    const result = await search(store, "kcc-meeting-records", { limit: MAX_SCAN_ROWS, predicate: (record) => recordId(record) === id || record.id === id });
    if (!result.records.length) localError("LOCAL_DATA_UNAVAILABLE", `record_id=${id} 未出現在本機 snapshot`);
    const pages = result.records.flatMap(readPages).sort((a, b) => a.page - b.page);
    const declaredTotals = new Set(result.records.map((record) => record.data.total_pages).filter((value) => value !== undefined));
    if (declaredTotals.size > 1) localError("SNAPSHOT_UNVERIFIED", `record_id=${id} 的 total_pages 宣告互相矛盾`);
    assertPageSequence(pages, declaredTotals.values().next().value);
    const pdfUrl = assertKccPdfUrl(result.records[0]);
    verifyDetailUrl(args.pdf_url, pdfUrl, result.records[0].source_url);
    const selectedPage = args.page ? pages.find((page) => page.page === args.page) : null;
    if (args.page && !selectedPage) localError("LOCAL_DATA_UNAVAILABLE", `record_id=${id} 的本機文字層沒有第 ${args.page} 頁`);
    const matches = keyword ? pages.filter((page) => page.text.includes(keyword)).map((page) => ({ page: page.page, match_count: page.text.split(keyword).length - 1, snippets: [snippet(page.text, keyword)] })) : [];
    const data = {
      record_id: id,
      pdf_url: pdfUrl,
      total_pages: pages.length,
      from_cache: true,
      keyword: keyword || undefined,
      matched_pages_count: matches.length,
      matches,
      page_content: selectedPage?.text,
      local_provenance: recordWithEvidence(result.records[0], result.release).local_provenance,
    };
    return envelope(result, data, { local_match_count: matches.length });
  },

  kcc_search_meeting_record_content: async (store, args) => {
    const keyword = asString(args.keyword);
    if (!keyword || keyword.length > 200) localError("INVALID_ARGUMENT", "keyword 不可為空且不得超過 200 字元");
    const requested = args.limit_records === undefined ? 8 : Number(args.limit_records);
    if (!Number.isInteger(requested) || requested < 1) localError("INVALID_ARGUMENT", "limit_records 必須是正整數");
    const limitRecords = Math.min(requested, 15);
    const result = await search(store, "kcc-meeting-records", { limit: MAX_SCAN_ROWS });
    if (result.local_match_count > result.records.length) {
      localError("PARTIAL_SCAN", "議事錄索引超過 1000 筆上限，無法確認最新會議順序");
    }
    const allGroups = new Map();
    for (const record of result.records) {
      const id = recordId(record);
      const group = allGroups.get(id) || { record, rows: [], pages: [], matches: [] };
      group.rows.push(record);
      group.pages.push(...readPages(record));
      allGroups.set(id, group);
    }
    for (const [id, group] of allGroups) {
      const declaredTotals = new Set(group.rows.map((record) => record.data.total_pages).filter((value) => value !== undefined));
      if (declaredTotals.size > 1) localError("SNAPSHOT_UNVERIFIED", `record_id=${id} 的 total_pages 宣告互相矛盾`);
      assertPageSequence(group.pages.sort((a, b) => a.page - b.page), declaredTotals.values().next().value);
    }
    const orderedGroups = [...allGroups.entries()].sort(([, a], [, b]) => {
      const dateA = String(a.record.data.date ?? a.record.data.meeting_date ?? a.record.retrieved_at);
      const dateB = String(b.record.data.date ?? b.record.data.meeting_date ?? b.record.retrieved_at);
      return dateB.localeCompare(dateA);
    });
    const selectedGroups = orderedGroups.slice(0, limitRecords);
    for (const [, group] of selectedGroups) {
      for (const page of group.pages) {
        if (page.text.includes(keyword)) group.matches.push({ page: page.page, match_count: page.text.split(keyword).length - 1, snippets: [snippet(page.text, keyword)] });
      }
    }
    const dataRecords = selectedGroups.filter(([, group]) => group.matches.length).map(([id, group]) => ({
      record_id: id,
      meeting: group.record.data.meeting_name ?? group.record.data.meeting ?? group.record.title,
      date: group.record.data.date ?? group.record.data.meeting_date ?? "",
      pdf_url: assertKccPdfUrl(group.record),
      from_cache: true,
      matched_pages_count: group.matches.length,
      matches: group.matches,
      local_provenance: recordWithEvidence(group.record, result.release).local_provenance,
    }));
    const truncated = orderedGroups.length > selectedGroups.length;
    const status = result.release.coverage.complete && !truncated ? undefined : "partial";
    return envelope({ ...result, local_match_count: dataRecords.length }, {
      keyword,
      scan_status: status === "partial" ? "partial" : "success",
      attempted_records_count: selectedGroups.length,
      succeeded_records_count: selectedGroups.length,
      failed_records_count: 0,
      scanned_records_count: selectedGroups.length,
      matched_records_count: dataRecords.length,
      failures: [],
      records: dataRecords,
    }, {
      limit_records: limitRecords,
      omitted_local_records: Math.max(0, orderedGroups.length - selectedGroups.length),
      note: result.release.coverage.complete ? undefined : "搜尋只涵蓋目前不完整的本機 snapshot。",
    }, status);
  },
};

async function proposalDataset(store) {
  if (await store.hasDataset("kcc-proposals")) return "kcc-proposals";
  if (await store.hasDataset("kcc-proposals-pilot")) return "kcc-proposals-pilot";
  localError("LOCAL_DATA_UNAVAILABLE", "本機沒有 kcc-proposals 或 kcc-proposals-pilot snapshot");
}

async function findProposalDetail(store, id) {
  if (!await store.hasDataset("kcc-proposal-details")) {
    localError("LOCAL_DATA_UNAVAILABLE", "本機尚無獨立擷取的議案 Detail.aspx snapshot");
  }
  const result = await search(store, "kcc-proposal-details", { limit: MAX_SCAN_ROWS, predicate: (record) => proposalId(record) === id });
  if (!result.records.length) localError("LOCAL_DATA_UNAVAILABLE", `proposal_sn=${id} 未出現在本機 snapshot`);
  return { ...result, records: result.records.slice(0, 1), local_match_count: result.local_match_count };
}

function proposalResult(result, matched, query, limitValue) {
  const limit = boundedLimit(limitValue, 20, 100);
  const selected = matched.slice(0, limit);
    const proposals = selected.map((record) => proposalWithEvidence(record, result.release));
  const localMatchCount = result.local_match_count;
  const complete = result.release.coverage.complete && localMatchCount <= matched.length && proposals.length >= localMatchCount;
  return envelope({ ...result, records: matched, local_match_count: localMatchCount }, {
    returned_count: proposals.length,
    total_count: localMatchCount,
    is_complete: complete,
    official_url: sourceUrl(result, "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx"),
    notice: complete ? null : "total_count 是本機符合筆數；來源官方總數或 coverage 尚未確認。",
    keyword: query.keyword ?? "",
    councilor: query.councilor ?? "",
    proposals,
  }, {
    omitted_local_matches: Math.max(0, localMatchCount - proposals.length),
    source_total_scope: result.release.coverage.scope,
  }, complete ? undefined : "partial");
}

function verifyDetailUrl(inputUrl, sourceUrl, baseUrl) {
  if (!inputUrl) return;
  if (typeof sourceUrl !== "string" || !sourceUrl) localError("SOURCE_ID_MISMATCH", "snapshot 未提供可比對的官方詳情 URL");
  let input;
  let source;
  try {
    const base = new URL(baseUrl || sourceUrl);
    input = new URL(String(inputUrl), base);
    source = new URL(sourceUrl, base);
  } catch {
    localError("SOURCE_ID_MISMATCH", "輸入 URL 格式無效");
  }
  if (input.protocol !== "https:" || input.hostname !== "cissearch.kcc.gov.tw" ||
      !/\/System\/Proposal\/Detail\.aspx$/i.test(input.pathname) || input.href !== source.href) {
    localError("SOURCE_ID_MISMATCH", "輸入 URL 與本機 snapshot 的官方來源不一致");
  }
}

function snippet(text, keyword, padding = 60) {
  const index = text.indexOf(keyword);
  if (index < 0) return "";
  return text.slice(Math.max(0, index - padding), Math.min(text.length, index + keyword.length + padding)).replace(/\s+/g, " ").trim();
}

export function createLocalRegistry(store) {
  const missing = SOURCE_REGISTRY.filter((tool) => !handlers[tool.name]);
  if (missing.length) throw new Error(`Local registry missing handlers: ${missing.map((tool) => tool.name).join(", ")}`);
  return SOURCE_REGISTRY.map((tool) => ({
    name: tool.name,
    description: `本機快照查詢；來源 URL、原始 SHA-256、擷取時間與 coverage 會隨結果提供。${tool.name === "kcc_search_speeches" ? "發言歸屬未驗證，工具會明確拒絕推論。" : ""}`,
    inputSchema: tool.inputSchema,
    outputSchema: localOutputSchema(tool.outputSchema),
    handler: async (args) => {
      const validated = validateArgs(tool.inputSchema, args || {}, tool.name);
      return await handlers[tool.name](store, validated);
    },
  }));
}

export const LOCAL_TOOL_NAMES = SOURCE_REGISTRY.map((tool) => tool.name);
export const LOCAL_SOURCE_TOOL_SCHEMAS = SOURCE_REGISTRY.map((tool) => ({
  name: tool.name,
  inputSchema: tool.inputSchema,
  outputSchema: tool.outputSchema,
}));

function localOutputSchema(source) {
  const schema = structuredClone(source);
  if (schema?.properties?.status && Array.isArray(schema.properties.status.enum)) {
    schema.properties.status.enum = ["success", "partial"];
  }
  return schema;
}
