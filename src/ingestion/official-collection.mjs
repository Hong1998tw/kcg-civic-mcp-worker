import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, lstat, realpath, open, rename } from "node:fs/promises";
import path from "node:path";
import { LocalStore } from "../local/store.mjs";
import { fetchBounded, validateOfficialUrl, CollectorError } from "./collector.mjs";
import { htmlTree, allNodes, byId, byClass, cleanText } from "./official-html.mjs";

const LAW_ROOT = "https://outlaw.kcg.gov.tw/LawCategoryMain.aspx?type=M";
const NEWS_ROOT = "https://www.kcg.gov.tw/News.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D";
const CITY_ROOT = "https://www.kcg.gov.tw/CityNews1.aspx?n=3A379BB94CA5F12D";
const VERSION = "official-html-2026-10-15-v5";
export const OFFICIAL_PROFILES = Object.freeze({
  "kcg-laws": Object.freeze({ dataset: "kcg-laws", entrypoint: LAW_ROOT, scope: "法規體系全部機關分類（不以近六個月最新訊息代替）", hosts: ["outlaw.kcg.gov.tw"] }),
  "kcg-news": Object.freeze({ dataset: "kcg-news", entrypoint: NEWS_ROOT, entrypoints: [NEWS_ROOT, CITY_ROOT], scope: "高雄市政府最新消息與市政新聞全部分頁（非媒體新聞RSS）", hosts: ["www.kcg.gov.tw"] }),
});
const fail = (code, message) => { throw new CollectorError(code, message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalized = (value) => String(value).normalize("NFC").replace(/\s+/g, "").trim();
const asHtml = (capture) => htmlTree(new TextDecoder("utf-8", { fatal: true }).decode(capture.bytes));
const cells = (row) => row.children.filter((child) => typeof child !== "string" && /^(td|th)$/.test(child.tag));
function safeUrl(value, profile, base) {
  const url = new URL(value, base || OFFICIAL_PROFILES[profile].entrypoint);
  url.hash = "";
  return validateOfficialUrl(url.toString(), OFFICIAL_PROFILES[profile].hosts).toString();
}
function detailIdentity(url, profile) {
  const parsed = new URL(safeUrl(url, profile));
  const city = parsed.pathname === "/CityNews_Detail1.aspx";
  const id = parsed.searchParams.get(profile === "kcg-laws" ? "id" : city ? "ss" : "s");
  if (!(profile === "kcg-laws" ? /^GL\d+$/ : /^[A-Fa-f0-9]{16}$/).test(id || "") ||
      !(profile === "kcg-laws" ? ["/LawContent.aspx"] : ["/News_Content.aspx", "/CityNews_Detail1.aspx"]).includes(parsed.pathname)) fail("SOURCE_ID_MISMATCH", "官方明細 URL 身分無效");
  return id;
}
const newsKind = (url) => new URL(url).pathname === "/CityNews_Detail1.aspx" ? "city" : "messages";
const namespacedId = (url, profile) => profile === "kcg-laws" ? detailIdentity(url, profile) : `${newsKind(url)}:${detailIdentity(url, profile)}`;
function labeledCell(tree, name) {
  for (const row of allNodes(tree, (node) => node.tag === "tr")) {
    const items = cells(row);
    if (items.length >= 2 && normalized(cleanText(items[0])).replace(/[：:]$/, "") === name) return items[1];
  }
  return null;
}
function labeledRow(tree, name) { return cleanText(labeledCell(tree, name)); }
function lawNameHeader(tree) {
  const cell = labeledCell(tree, "法規名稱"), badge = byId(cell, "ctl00_cp_content_lawheader1_spanCauseCode");
  const omitBadge = (node) => typeof node === "string" ? node : { ...node, children: node.children.filter((child) => child !== badge).map(omitBadge) };
  return { name: cell ? cleanText(omitBadge(cell)) : "", display_name: cleanText(cell), status_label: cleanText(badge) };
}
function dateIso(text) {
  const match = /(?:民國\s*)?(\d{2,4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(text);
  if (!match) fail("SOURCE_DATE_INVALID", "官方原件未提供可解析日期");
  const year = Number(match[1]) + (match[1].length < 4 ? 1911 : 0);
  const iso = `${year}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) fail("SOURCE_DATE_INVALID", "官方日期超出有效範圍");
  return iso;
}
function documentIdentity(tree, expected, profile, kind = "messages") {
  const forms = allNodes(tree, (node) => node.tag === "form" && node.attrs.action);
  const identified = forms.some((node) => {
    try { const url = new URL(node.attrs.action, OFFICIAL_PROFILES[profile].entrypoint); return url.searchParams.get(profile === "kcg-laws" ? "id" : kind === "city" ? "ss" : "s") === expected; } catch { return false; }
  });
  if (!identified) fail("SOURCE_ID_MISMATCH", "原始 HTML form 身分與明細 URL 不一致");
}
export function parseOfficialLaw(detail, history, expected) {
  const tree = asHtml(detail), historyTree = asHtml(history);
  const id = detailIdentity(detail.url, "kcg-laws");
  documentIdentity(tree, id, "kcg-laws"); documentIdentity(historyTree, id, "kcg-laws");
  if (new URL(history.url).pathname !== "/LawContentSource.aspx" || new URL(history.url).searchParams.get("id") !== id) fail("SOURCE_ID_MISMATCH", "法規沿革身分不一致");
  const nameHeader = lawNameHeader(tree), historyNameHeader = lawNameHeader(historyTree), name = nameHeader.name;
  if (!name || normalized(name) !== normalized(expected.title) || normalized(historyNameHeader.name) !== normalized(name) || nameHeader.status_label !== historyNameHeader.status_label) fail("SOURCE_ID_MISMATCH", "法規名稱與官方索引或沿革不一致");
  const category = labeledRow(tree, "法規體系"), publishedRaw = labeledRow(tree, "公發布日");
  const amendedRaw = labeledRow(tree, "修正日期") || labeledRow(tree, "廢止日期");
  const ceasedRaw = labeledRow(tree, "廢止/停止適用日期");
  const contentNode = byId(tree, "ctl00_cp_content_divContent");
  const fullText = cleanText(contentNode), historyText = cleanText(byId(historyTree, "ctl00_cp_content_divLawContentSource"));
  if (!category || !fullText || !historyText) fail("SOURCE_STRUCTURE_CHANGED", "法規完整正文、分類或沿革缺漏");
  const numerals = "一二三四五六七八九十百千零〇○壹貳參肆伍陸柒捌玖拾佰仟0-9０-９";
  const markers = [...fullText.matchAll(new RegExp(`(?:^|\\n|(?<=。))\\s*(第\\s*(?:[${numerals}]\\s*)+條(?:之(?:[${numerals}]\\s*)+)?)(?=[\\s　])`, "g"))];
  let articles;
  if (markers.length) {
    articles = markers.map((match, index) => ({ article_no: match[1].replace(/\s+/g, ""), content: fullText.slice(match.index + match[0].length, markers[index + 1]?.index ?? fullText.length).trim() }));
    if (new Set(articles.map((item) => item.article_no)).size !== articles.length || articles.some((item) => !item.content)) fail("SOURCE_STRUCTURE_CHANGED", "條文編號重複或正文空白");
  } else articles = [{ article_no: "全文", content: fullText }];
  const cessationNotice = !!ceasedRaw && markers.length === 0 && fullText.length <= 1000 &&
    normalized(fullText).startsWith(`「${normalized(name)}」`) && /(?:停止適用|廢止|整編至)/.test(fullText);
  if (cessationNotice) articles = [];
  const attachmentAreas = allNodes(tree, (node) => /_(?:ul|tr)AnnFiles\d+$/.test(node.attrs.id || "") || (node.tag === "tr" && /附件[：:]?$/.test(normalized(cleanText(cells(node)[0])))));
  const attachmentLinks = new Set(attachmentAreas.flatMap((area) => allNodes(area, (node) => node.tag === "a")));
  for (const node of allNodes(tree, (node) => node.tag === "a" && node.attrs.href)) {
    let candidate;
    try { candidate = new URL(node.attrs.href, detail.url); } catch { continue; }
    if (candidate.pathname === "/Download.ashx") attachmentLinks.add(node);
  }
  const attachments = [...attachmentLinks].map((node) => {
    if (!node.attrs.href) fail("SOURCE_STRUCTURE_CHANGED", "法規附件缺少可辨識原件連結");
    const url = new URL(safeUrl(node.attrs.href, "kcg-laws", detail.url));
    if (url.pathname !== "/Download.ashx" || url.searchParams.size !== 3 || !/^\d+$/.test(url.searchParams.get("FileID") || "") || url.searchParams.get("id") !== id || url.searchParams.get("type") !== "LAW") fail("SOURCE_STRUCTURE_CHANGED", "法規附件連結格式或身分不符");
    return { title: cleanText(node), url: url.toString() };
  });
  return { law_id: id, law_name: name, category, published_at: dateIso(publishedRaw), published_at_source: publishedRaw,
    law_record_type: cessationNotice ? "repeal_notice" : "law_text", articles_unavailable: cessationNotice, fulltext_complete: !cessationNotice,
    ...(cessationNotice ? { notice_text: fullText } : {}),
    ...(nameHeader.status_label ? { status_label: nameHeader.status_label, law_name_display_source: nameHeader.display_name } : {}),
    ...(ceasedRaw ? { repealed_or_suspended_at: dateIso(ceasedRaw), repealed_or_suspended_at_source: ceasedRaw } : {}),
    ...(amendedRaw ? { amended_at: dateIso(amendedRaw), amended_at_source: amendedRaw } : {}), official_url: detail.url,
    history: historyText, history_source_url: history.url, history_raw_sha256: history.sha256, articles,
    full_text: fullText, article_segmentation: cessationNotice ? "not-applicable-repeal-notice" : markers.length ? "official-numbered-articles" : "unsegmented-full-text",
    attachments, attachments_downloaded: false, legal_effect_verified: false };
}
export function parseOfficialNews(detail, expected) {
  const tree = asHtml(detail), nativeId = detailIdentity(detail.url, "kcg-news"), kind = newsKind(detail.url), id = `${kind}:${nativeId}`;
  documentIdentity(tree, nativeId, "kcg-news", kind);
  const titleNode = allNodes(tree, (node) => node.tag === "meta" && node.attrs.name === "DC.Subject")[0];
  const title = kind === "city" ? cleanText(allNodes(byClass(tree, "data_midlle_news_box01")[0], (node) => node.tag === "td")[0]) : titleNode?.attrs.content?.trim();
  if (!title || normalized(title) !== normalized(expected.title)) fail("SOURCE_ID_MISMATCH", "最新消息標題與官方索引不一致");
  const listItem = (label) => allNodes(byId(tree, "data_midlle") || tree, (node) => node.tag === "li").map(cleanText).find((text) => text.startsWith(label))?.slice(label.length).trim();
  const agency = listItem("發布機關："), dateRaw = listItem("發布日期：");
  const content = byClass(tree, "data_midlle_news_box02").map(cleanText).filter(Boolean).join("\n\n");
  if (agency === undefined || !dateRaw || !content) fail("SOURCE_STRUCTURE_CHANGED", "最新消息正文、發布機關或日期缺漏");
  if ((expected.agency && normalized(agency) !== normalized(expected.agency)) || dateIso(dateRaw) !== dateIso(expected.published_at)) fail("SOURCE_ID_MISMATCH", "新聞發布資訊與官方索引不一致");
  return { news_id: id, source_native_id: nativeId, source_kind: kind, title, agency, publisher: agency, publisher_status: agency ? "provided" : "not_provided", publisher_source: agency ? "official-detail" : "official-detail-empty", category: expected.category || "最新消息", published_at: dateIso(dateRaw), published_at_source: dateRaw,
    content, content_summary: content, content_summary_kind: "official-full-text", source_link: detail.url,
    index_source_url: expected.index_url, index_raw_sha256: expected.index_raw_sha256 };
}
function parseIndex(capture, profile) {
  const tree = asHtml(capture), text = cleanText(tree), entries = [];
  const totalMatch = /共\s*([\d,]+)\s*筆/.exec(text);
  if (!totalMatch) fail("SOURCE_TOTAL_MISSING", "官方索引缺少來源總筆數");
  const sourceTotal = Number(totalMatch[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(sourceTotal) || sourceTotal < 0 || sourceTotal > 100000) fail("SOURCE_COUNT_MISMATCH", "官方總筆數超出本機快照容量");
  for (const row of allNodes(tree, (node) => node.tag === "tr")) {
    if (allNodes(row, (node) => node.tag === "tr").length > 1) continue;
    const links = allNodes(row, (node) => {
      if (node.tag !== "a" || !node.attrs.href) return false;
      try { return (profile === "kcg-laws" ? ["/LawContent.aspx"] : ["/News_Content.aspx", "/CityNews_Detail1.aspx"]).includes(new URL(node.attrs.href, capture.url).pathname); } catch { return false; }
    });
    if (!links.length) continue;
    if (links.length !== 1) fail("SOURCE_STRUCTURE_CHANGED", "官方列表列具有多個明細連結");
    const url = safeUrl(links[0].attrs.href, profile, capture.url), id = namespacedId(url, profile);
    const cols = cells(row).map(cleanText);
    const city = profile === "kcg-news" && newsKind(url) === "city";
    entries.push({ id, url, title: cleanText(links[0]), ...(profile === "kcg-news" ? city ? { category: cols[2], published_at: cols[3] } : { agency: cols[1]?.replace(/^發布機關\s*/, ""), published_at: cols[2]?.replace(/^發布日期\s*/, "") } : {}), index_url: capture.url, index_raw_sha256: capture.sha256 });
  }
  if ((!entries.length && sourceTotal !== 0) || new Set(entries.map((item) => item.id)).size !== entries.length) fail("SOURCE_COUNT_MISMATCH", "官方列表為空或身分重複");
  const isCityIndex = new URL(capture.url).pathname === "/CityNews1.aspx";
  const next = isCityIndex ? [] : allNodes(tree, (node) => node.tag === "a" && node.attrs.href && cleanText(node) === "下一頁").map((node) => safeUrl(node.attrs.href, profile, capture.url));
  if (next.length > 1) fail("SOURCE_STRUCTURE_CHANGED", "官方下一頁連結不唯一");
  const nextUrl = next[0] || null;
  if (nextUrl) {
    const current = new URL(capture.url), following = new URL(nextUrl);
    const sameScope = profile === "kcg-laws" ? current.searchParams.get("CategoryID") === following.searchParams.get("CategoryID") : current.searchParams.get("n") === following.searchParams.get("n") && current.searchParams.get("sms") === following.searchParams.get("sms");
    if (following.pathname !== current.pathname || !sameScope || Number(following.searchParams.get("page")) !== Number(current.searchParams.get("page") || 1) + 1) fail("SOURCE_ID_MISMATCH", "分頁範圍或頁次不連續");
  }
  const pageText = isCityIndex ? cleanText(byId(tree, "ContentPlaceHolder1_lblPageCount")) : null;
  const pageMatch = pageText ? /^(\d+)\s*\/\s*(\d+)$/.exec(pageText) : null;
  if (isCityIndex && !pageMatch) fail("SOURCE_STRUCTURE_CHANGED", "市政新聞缺少官方頁次");
  return { entries, source_total: sourceTotal, next_url: nextUrl, ...(isCityIndex ? { current_page: Number(pageMatch[1]), total_pages: Number(pageMatch[2]) } : {}) };
}

function cityPostBody(capture) {
  const tree = asHtml(capture), form = allNodes(tree, (node) => node.tag === "form" && node.attrs.id === "form1")[0];
  if (!form || !byId(tree, "__VIEWSTATE") || !byId(tree, "__EVENTVALIDATION") || !byId(tree, "ContentPlaceHolder1_lbtNext")?.attrs.href) fail("SOURCE_STRUCTURE_CHANGED", "市政新聞原生換頁表單缺漏");
  const fields = new URLSearchParams();
  for (const node of allNodes(form, (node) => node.tag === "input" && node.attrs.name && ["hidden", "text"].includes(node.attrs.type || "text"))) fields.set(node.attrs.name, node.attrs.value || "");
  for (const node of allNodes(form, (node) => node.tag === "select" && node.attrs.name)) {
    const options = allNodes(node, (node) => node.tag === "option");
    fields.set(node.attrs.name, (options.find((node) => node.attrs.selected !== undefined) || options[0])?.attrs.value || "");
  }
  fields.set("__EVENTTARGET", "ctl00$ContentPlaceHolder1$lbtNext"); fields.set("__EVENTARGUMENT", "");
  return fields.toString();
}

async function safeDirectory(root) {
  const absolute = path.resolve(root);
  // Reject symlink components even when an intermediate ancestor already exists.
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("STAGING_PATH_INVALID", "採集路徑不得含 symlink 或非目錄");
  }
  return realpath(absolute);
}
async function regularRead(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) fail("CHECKPOINT_INVALID", "採集檔案非一般檔案或超出大小上限");
  return readFile(file);
}
async function writeCheckpoint(file, state) {
  try { await regularRead(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const encoded = JSON.stringify(state), document = JSON.stringify({ sha256: hash(encoded), state });
  const temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(document); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
function initialState(profile, downloadAttachments = true) {
  return { version: VERSION, profile, download_attachments: downloadAttachments, run_id: randomUUID(), captures: {}, records: [], entries: {}, listing_seen: [],
    queues: profile === "kcg-laws" ? [{ url: LAW_ROOT, type: "categories" }] : [{ url: NEWS_ROOT, type: "index", scope: "messages" }, { url: CITY_ROOT, type: "index", scope: "city", page: 1 }],
    totals: {}, scope_counts: {}, finished_scopes: [], all_listing_done: false, exhausted: false };
}
function checkedLimit(value, fallback, max, name) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > max) fail("CONFIG_INVALID", `${name} 必須介於1與${max}`);
  return number;
}

/** Bounded, resumable official capture. The caller must serialize writers for a
 * root/profile. resume defaults true. Each call publishes the accumulated prefix,
 * never only the newest batch. All network I/O is HTTPS allowlisted and throttled. */
export async function runOfficialCollection(options = {}, dependencies = {}) {
  const { profile } = options, config = OFFICIAL_PROFILES[profile];
  if (!config) fail("PROFILE_UNKNOWN", "未知官方採集 profile");
  if (options.dryRun) return { profile, dataset: config.dataset, status: "pending", dry_run: true, coverage: { scope: config.scope, complete: false, source_total: null }, entrypoint: config.entrypoint };
  if (typeof options.root !== "string" || !options.root) fail("ROOT_REQUIRED", "必須指定 NAS 本機資料 root");
  const maxRequests = checkedLimit(options.maxRequests, 25, 500, "maxRequests"), maxRecords = checkedLimit(options.maxRecords, 20, 10000, "maxRecords"), maxPages = checkedLimit(options.maxPages, 10, 500, "maxPages");
  const root = await safeDirectory(options.root), directory = await safeDirectory(path.join(root, "staging", "official", profile));
  const captureDirectory = await safeDirectory(path.join(directory, "captures"));
  const checkpoint = path.join(directory, "checkpoint.json");
  const downloadAttachments = options.downloadAttachments !== false;
  let state = initialState(profile, downloadAttachments);
  if (options.resume !== false) {
    try {
      const doc = JSON.parse((await regularRead(checkpoint)).toString("utf8"));
      if (doc.sha256 !== hash(JSON.stringify(doc.state)) || doc.state.version !== VERSION || doc.state.profile !== profile || doc.state.download_attachments !== downloadAttachments) fail("CHECKPOINT_INVALID", "checkpoint 版本、身分、附件策略或校驗不一致");
      state = doc.state;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const store = dependencies.storeFactory ? await dependencies.storeFactory(root) : new LocalStore(root, { readOnly: false });
  const now = dependencies.now || Date.now, sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let requests = 0, pages = 0, added = 0, errorCode = null, receipt = null;
  const newlyIndexed = [];
  let lastRequest = Number(state.last_request_at || 0);
  const startingCaptureCount = Object.keys(state.captures).length;
  const rateLimiter = async () => { const delay = 1000 - (now() - lastRequest); if (lastRequest && delay > 0) await sleep(delay); lastRequest = now(); state.last_request_at = lastRequest; };
  const readStoredCapture = async (key, cached) => {
    if (!cached || !/^[a-f0-9]{64}$/.test(cached.sha256 || "") || cached.request_key !== key ||
        typeof cached.receipt_path !== "string" || path.dirname(cached.receipt_path) !== captureDirectory) fail("CHECKPOINT_INVALID", "官方原件收據或hash身分無效");
    safeUrl(cached.url, profile); safeUrl(cached.requested_url, profile);
    const captureReceipt = JSON.parse((await regularRead(cached.receipt_path)).toString("utf8"));
    if (JSON.stringify(captureReceipt) !== JSON.stringify(cached)) fail("CHECKPOINT_INVALID", "官方原件收據與checkpoint不一致");
    if (typeof store.readRawObject !== "function") fail("STORE_API_UNAVAILABLE", "缺少原始檔雜湊讀回API");
    const bytes = await store.readRawObject(cached.sha256, 32 * 1024 * 1024);
    if (hash(bytes) !== cached.sha256 || bytes.length !== cached.byte_length) fail("RAW_HASH_MISMATCH", "已保存官方原件hash或大小不一致");
    return { ...cached, bytes };
  };
  const capture = async (url, request = {}) => {
    url = safeUrl(url, profile);
    const key = request.key || url;
    const cached = state.captures[key];
    if (cached) return readStoredCapture(key, cached);
    if (requests >= maxRequests) fail("SEGMENT_LIMIT", "本段 request 預算已用完");
    const result = await fetchBounded(url, { allowedHosts: config.hosts, maxBytes: options.maxBytes ?? 8 * 1024 * 1024, timeoutMs: options.timeoutMs ?? 15000, maxRetries: 0, method: request.method || "GET", body: request.body, headers: { "User-Agent": "kcg-civic-local-official/1.0", Accept: "text/html", ...(request.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } }, {
      fetchImpl: async (...args) => { if (requests >= maxRequests) fail("SEGMENT_LIMIT", "本段 request 預算已用完"); requests++; return (dependencies.fetchImpl || fetch)(...args); }, sleep, now, rateLimiter,
    });
    const sha256 = hash(result.bytes), metadata = { url: result.url, requested_url: url, request_key: key, request_method: request.method || "GET", sha256, retrieved_at: new Date(now()).toISOString(), byte_length: result.bytes.length, http_status: result.status, content_type: result.headers.get("content-type") || "" };
    if (!result.bytes.length) fail("SOURCE_EMPTY", "官方原件空白");
    // Immutable bytes first; the metadata checkpoint is durable before parsing.
    await store.putRawObject({ sha256, bytes_base64: result.bytes.toString("base64") });
    metadata.receipt_path = path.join(captureDirectory, `${state.run_id}-${randomUUID()}.json`);
    const captureReceipt = await open(metadata.receipt_path, "wx", 0o600);
    try { await captureReceipt.writeFile(JSON.stringify(metadata)); await captureReceipt.sync(); } finally { await captureReceipt.close(); }
    state.captures[key] = metadata;
    await writeCheckpoint(checkpoint, state);
    return { ...metadata, bytes: result.bytes };
  };
  try {
    while (state.queues.length && pages < maxPages && requests < maxRequests) {
      const task = state.queues[0], requestKey = task.parent_capture_key ? `POST:${task.url}:page:${task.page}` : task.url;
      let request = { key: requestKey };
      if (task.parent_capture_key) {
        const parent = state.captures[task.parent_capture_key];
        if (!parent) fail("CHECKPOINT_INVALID", "換頁缺少原生上頁原件");
        const previous = await capture(parent.requested_url, { key: task.parent_capture_key });
        request = { key: requestKey, method: "POST", body: cityPostBody(previous) };
      }
      const raw = await capture(task.url, request);
      if (task.type === "categories") {
        const tree = asHtml(raw), container = byId(tree, "ctl00_cp_content_ulLawCategoryMobile");
        if (!container) fail("SOURCE_STRUCTURE_CHANGED", "官方全法規分類容器缺漏");
        const links = allNodes(container, (node) => node.tag === "a");
        if (!links.length) fail("SOURCE_STRUCTURE_CHANGED", "官方全法規分類索引缺漏");
        const categories = links.map((node) => {
          if (!node.attrs.href) fail("SOURCE_STRUCTURE_CHANGED", "官方分類缺少可辨識連結");
          const url = new URL(safeUrl(node.attrs.href, profile, raw.url));
          if (url.pathname !== "/LawCategoryContentList.aspx" || url.searchParams.size !== 1 || !/^\d+$/.test(url.searchParams.get("CategoryID") || "")) fail("SOURCE_STRUCTURE_CHANGED", "官方分類連結格式無法辨識");
          return { url: url.toString(), type: "index", scope: url.searchParams.get("CategoryID"), title: cleanText(node) };
        });
        if (new Set(categories.map((item) => item.scope)).size !== categories.length) fail("SOURCE_ID_MISMATCH", "法規分類重複");
        state.queues.shift(); state.queues.push(...categories); state.category_count = categories.length;
      } else {
        if (state.listing_seen.includes(requestKey)) fail("PAGINATION_LOOP", "官方分頁重複");
        const parsed = parseIndex(raw, profile);
        if (task.scope === "city" && parsed.current_page !== task.page) fail("SOURCE_ID_MISMATCH", "市政新聞原生換頁未取得下一頁");
        if (state.totals[task.scope] !== undefined && state.totals[task.scope] !== parsed.source_total) fail("SOURCE_DRIFT", "採集期間官方來源總筆數變動，需新建 run");
        const count = (state.scope_counts[task.scope] || 0) + parsed.entries.length;
        const hasNext = task.scope === "city" ? parsed.current_page < parsed.total_pages : !!parsed.next_url;
        if (count > parsed.source_total || (!hasNext && count !== parsed.source_total)) fail("SOURCE_COUNT_MISMATCH", "官方頁次/條數與來源總數不一致");
        for (const entry of parsed.entries) {
          if (state.entries[entry.id]) fail("SOURCE_ID_MISMATCH", "官方分頁或分類重複明細身分");
          state.entries[entry.id] = entry; newlyIndexed.push(entry.id);
        }
        state.scope_counts[task.scope] = count; state.totals[task.scope] = parsed.source_total;
        state.listing_seen.push(requestKey); state.queues.shift();
        if (hasNext) {
          const nextTask = task.scope === "city" ? { ...task, page: task.page + 1, parent_capture_key: requestKey } : { ...task, url: parsed.next_url };
          if (profile === "kcg-news") state.queues.push(nextTask); else state.queues.unshift(nextTask);
        } else state.finished_scopes.push(task.scope);
      }
      pages++; await writeCheckpoint(checkpoint, state);
      // Alternate bounded index and detail work; a complete corpus need not fit
      // in one runtime or fetch all index pages before publishing useful records.
      if (Object.keys(state.entries).length > state.records.length) break;
    }
    state.all_listing_done = state.queues.length === 0;
    const prioritized = [...newlyIndexed.map((id) => state.entries[id]), ...Object.values(state.entries).filter((entry) => !newlyIndexed.includes(entry.id))];
    for (const entry of prioritized) {
      if (state.records.some((record) => record.id === entry.id)) continue;
      if (added >= maxRecords || requests >= maxRequests) break;
      const detail = await capture(entry.url);
      if (namespacedId(detail.url, profile) !== entry.id) fail("SOURCE_ID_MISMATCH", "官方 redirect 改變明細身分");
      let data;
      if (profile === "kcg-laws") {
        const history = await capture(`https://outlaw.kcg.gov.tw/LawContentSource.aspx?id=${entry.id}`);
        data = parseOfficialLaw(detail, history, entry);
        if (options.downloadAttachments !== false) {
          for (const attachment of data.attachments) {
            const rawAttachment = await capture(attachment.url);
            if (/text\/html/i.test(rawAttachment.content_type) || /^\s*(?:<!doctype\s+html|<html)/i.test(rawAttachment.bytes.subarray(0, 200).toString("utf8")) ||
                (/\.pdf$/i.test(attachment.title) && rawAttachment.bytes.subarray(0, 5).toString("ascii") !== "%PDF-")) fail("ATTACHMENT_FORMAT_INVALID", "法規附件回應格式與官方檔名不符");
            Object.assign(attachment, { source_url: rawAttachment.url, raw_sha256: rawAttachment.sha256, byte_length: rawAttachment.byte_length, retrieved_at: rawAttachment.retrieved_at, content_type: rawAttachment.content_type });
          }
          data.attachments_downloaded = true;
        }
      } else data = parseOfficialNews(detail, entry);
      state.records.push({ id: entry.id, title: data.law_name || data.title, text: data.full_text || data.content, data, source_url: detail.url, retrieved_at: detail.retrieved_at, raw_sha256: detail.sha256 });
      added++; await writeCheckpoint(checkpoint, state);
    }
    state.exhausted = state.all_listing_done && state.records.length === Object.keys(state.entries).length;
  } catch (error) {
    if (error.code !== "SEGMENT_LIMIT") errorCode = error.code || error.reasonCode || "COLLECTION_FAILED";
  }
  const sourceTotal = profile === "kcg-news" ? Object.keys(state.totals).length === 2 ? Object.values(state.totals).reduce((sum, n) => sum + n, 0) : null
    : state.category_count && Object.keys(state.totals).length === state.category_count ? Object.values(state.totals).reduce((sum, n) => sum + n, 0) : null;
  if (state.exhausted && !state.records.length && !errorCode) errorCode = "SOURCE_EMPTY";
  const rawValidation = { status: "not-run", scope: "all-run-capture-receipts-and-cas-bytes", required_capture_count: Object.keys(state.captures).length, verified_capture_count: 0, verified_raw_object_count: 0 };
  if (!errorCode) {
    try {
      const captures = Object.entries(state.captures), verifiedHashes = new Set();
      for (const [key, saved] of captures) {
        await readStoredCapture(key, saved);
        rawValidation.verified_capture_count++; verifiedHashes.add(saved.sha256);
        rawValidation.verified_raw_object_count = verifiedHashes.size;
      }
      rawValidation.verified_raw_object_count = verifiedHashes.size;
      const requireReference = (sha256, sourceUrl) => {
        if (!/^[a-f0-9]{64}$/.test(sha256 || "") || !captures.some(([, saved]) => saved.sha256 === sha256 && saved.url === sourceUrl)) fail("RAW_REFERENCE_MISSING", "明細必要原件缺少已驗證擷取收據");
      };
      for (const record of state.records) {
        requireReference(record.raw_sha256, record.source_url);
        const entry = state.entries[record.id];
        if (!entry) fail("RAW_REFERENCE_MISSING", "明細缺少原始索引參照");
        requireReference(entry.index_raw_sha256, entry.index_url);
        if (profile === "kcg-laws") {
          requireReference(record.data.history_raw_sha256, record.data.history_source_url);
          if (state.download_attachments) {
            if (record.data.attachments_downloaded !== true) fail("RAW_REFERENCE_MISSING", "法規附件下載狀態未完成");
            for (const attachment of record.data.attachments || []) requireReference(attachment.raw_sha256, attachment.source_url);
          }
        }
      }
      rawValidation.status = "passed";
    } catch (error) {
      rawValidation.status = "failed";
      errorCode = error.code || error.reasonCode || "RAW_VALIDATION_FAILED";
    }
  }
  const complete = !errorCode && state.exhausted && sourceTotal !== null && state.records.length === sourceTotal;
  const coverage = { scope: config.scope, complete, source_total: sourceTotal };
  try {
    if (!errorCode && options.commit !== false && state.records.length) {
      const snapshotId = `official-${profile}-${hash(JSON.stringify(state.records) + JSON.stringify(coverage)).slice(0, 32)}`;
      receipt = await store.importSnapshot({ dataset: config.dataset, snapshot_id: snapshotId, coverage, parser_version: VERSION, validator_version: "official-identity-count-v1", validation_status: "passed", records: state.records, raw_objects: [] });
      const readback = await store.queryRecords(config.dataset, { limit: 1 });
      if (readback.release.snapshot_id !== snapshotId || readback.release.record_count !== state.records.length) fail("COMMIT_READBACK_FAILED", "官方採集快照讀回不一致");
    }
    state.last_error_code = errorCode; state.updated_at = new Date(now()).toISOString();
    await writeCheckpoint(checkpoint, state);
    return { profile, dataset: config.dataset, status: errorCode ? "blocked" : complete ? "complete" : "paused", continuation_required: !errorCode && !complete,
      checkpoint_path: checkpoint, run_id: state.run_id, record_count: state.records.length, segment_added: added, attempted: requests, succeeded: Object.keys(state.captures).length - startingCaptureCount, failed: errorCode ? 1 : 0,
      pages_processed: pages, coverage, receipt, error_code: errorCode, commit_state: receipt ? "committed" : "not-committed", raw_capture_count: Object.keys(state.captures).length, raw_validation: rawValidation,
      ...(profile === "kcg-laws" ? { law_text_count: state.records.filter((record) => record.data.law_record_type !== "repeal_notice").length, repeal_notice_count: state.records.filter((record) => record.data.law_record_type === "repeal_notice").length } : {}),
      caveats: profile === "kcg-laws" ? [options.downloadAttachments === false ? "已明確略過圖表附件 bytes，僅保存官方連結。" : "圖表附件保存官方原件 bytes；附件內文未另做OCR或條文解讀。", "Collection coverage僅表示目前官方頁面捕獲，不代表停止適用法規的歷史條文全文可取得。", "法規效力需依原公告判斷。"] : [] };
  } finally { store.close?.(); }
}
