import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError, fetchBounded, loadTypeScriptParser, sha256Bytes } from './collector.mjs';
import { PROPOSAL_URL, MEETING_URL, KCC_HOST, PREFIX, MEETING_PREFIX, controls, optionsFor, assertQuery, parseProposalTabs, parseMeetingPage, parseDetail, parseAttachments, official } from './kcc-html.mjs';

const VERSION = 'kcc-all-tabs-resumable-v1';
export const KCC_PROFILE_MANIFEST = Object.freeze({
  'kcc-proposals-full': { dataset: 'kcc-proposals', scope: 'all-official-sessions/all-tabs/all-pages', state: 'implemented-resumable' },
  'kcc-meetings-full': { dataset: 'kcc-meetings', scope: 'all-official-sessions/all-pages', state: 'implemented-resumable' },
  'kcc-proposal-details': { dataset: 'kcc-proposal-details', scope: 'verified-local-proposal-index/all-details-and-attachments', state: 'implemented-resumable' },
  'kcc-meeting-records': { dataset: 'kcc-meeting-records', scope: 'verified-local-meetings/all-pdf-versions/page-text', state: 'implemented-resumable' },
});
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = () => new CollectorError('COLLECTION_YIELD', '本段資源上限，已保存可續作進度');
async function plain(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new CollectorError('STAGING_PATH_INVALID', '採集狀態不得使用symlink或非預期檔案類型');
}
async function safeDirectory(root, components) {
  const absolute = path.resolve(root); await mkdir(absolute, { recursive: true, mode: 0o700 }); await plain(absolute, true);
  if (await realpath(absolute) !== absolute) throw new CollectorError('STAGING_PATH_INVALID', 'store root需為實體路徑');
  let current = absolute;
  for (const component of components) {
    current = path.join(current, component); await mkdir(current, { recursive: true, mode: 0o700 }); await plain(current, true);
  }
  return current;
}
async function jsonRead(file, fallback) {
  try { await plain(file); return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomicJson(file, value) {
  try { await plain(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, file);
}
function normalizeOptions(options) {
  const profile = options.profile;
  if (!Object.hasOwn(KCC_PROFILE_MANIFEST, profile)) throw new CollectorError('PROFILE_INVALID', '未知KCC採集profile');
  if (!options.root) throw new CollectorError('ROOT_REQUIRED', '必須指定本機store root');
  const sessions = options.sessions || (options.session ? [options.session] : null);
  if (sessions && (!Array.isArray(sessions) || !sessions.length || sessions.some((s) => !/^\d{4}$/.test(s)))) throw new CollectorError('CONFIG_INVALID', 'sessions需為官方四位代碼陣列');
  const periods = options.periods || null;
  if (periods && (!Array.isArray(periods) || !periods.length || periods.some((s) => !/^\d{2}$/.test(s)))) throw new CollectorError('CONFIG_INVALID', 'periods需為官方兩位代碼陣列');
  const pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new CollectorError('CONFIG_INVALID', 'pageSize範圍1–500');
  const maxRequests = options.maxRequests ?? 25, maxPages = options.maxPages ?? 5000, maxDurationMs = options.maxDurationMs ?? 80000;
  for (const n of [maxRequests, maxPages, maxDurationMs]) if (!Number.isSafeInteger(n) || n < 1) throw new CollectorError('CONFIG_INVALID', '採集段落上限需為正整數');
  const keyword = options.keyword || '';
  if (typeof keyword !== 'string' || keyword.length > 200) throw new CollectorError('CONFIG_INVALID', 'keyword上限200字');
  return { profile, periods, sessions, pageSize, maxRequests, maxPages, maxDurationMs, keyword };
}
function coverage(state, complete = false, sourceTotal = null) {
  return { scope: state.scope, complete, source_total: sourceTotal };
}
function indexTotals(state) {
  const queries = Object.values(state.queries || {});
  const discoveredAll = state.discovery && queries.length === state.discovery.queries.length;
  const tabs = queries.flatMap((q) => Object.values(q.tabs || {}));
  return { complete: Boolean(discoveredAll && tabs.length && tabs.every((t) => t.complete)), sourceTotal: discoveredAll && tabs.every((t) => Number.isSafeInteger(t.total)) ? tabs.reduce((n, t) => n + t.total, 0) : null, tabs };
}
async function importRecords(ctx, state, dataset, records, cov) {
  if (!records.length) return null;
  const snapshotId = `kcc-${digest({ dataset, records, cov }).slice(0, 40)}`;
  const receipt = await ctx.store.importSnapshot({ dataset, snapshot_id: snapshotId, records, coverage: cov, raw_objects: [], parser_version: VERSION, validator_version: 'official-id-tab-page-count-hash-v1', validation_status: 'passed' });
  if (!receipt || !['imported', 'unchanged'].includes(receipt.status) || receipt.dataset !== dataset || receipt.snapshot_id !== snapshotId || receipt.record_count !== records.length || !/^[a-f0-9]{64}$/i.test(receipt.manifest_sha256 || '')) throw new CollectorError('RECEIPT_INVALID', '本機快照收據不一致');
  return receipt;
}
function sameRelease(left, right) {
  return Boolean(left && right && ['dataset','snapshot_id','manifest_sha256','record_count'].every((key)=>left[key] === right[key]));
}
async function activeRelease(ctx, dataset) {
  if (typeof ctx.store.queryRecords !== 'function') throw new CollectorError('STORE_API_UNAVAILABLE', '缺少原生active release核對API');
  if (typeof ctx.store.hasDataset === 'function' && !await ctx.store.hasDataset(dataset)) return null;
  try { return (await ctx.store.queryRecords(dataset,{limit:0})).release; }
  catch (error) { if (error.reasonCode === 'LOCAL_DATA_UNAVAILABLE' || error.code === 'LOCAL_DATA_UNAVAILABLE') return null; throw error; }
}
async function assertActiveReceipts(ctx, receipts = ctx.state.receipts) {
  for (const [dataset,receipt] of Object.entries(receipts)) {
    if (receipt && !sameRelease(receipt,await activeRelease(ctx,dataset))) throw new CollectorError('RELEASE_DRIFT', `${dataset}目前active release與已保存收據不同，需核對範圍後再接續`);
  }
}
async function publishState(ctx, candidate, publications, recovered = null) {
  // Write the exact pending candidate before publication. A crash/import failure
  // replays this immutable candidate; the successful cursor never moves early.
  const pending = recovered || { state:candidate,publications,base_releases:{},confirmed_receipts:{},publication_states:{} };
  pending.base_releases ||= {}; pending.confirmed_receipts ||= {}; pending.publication_states ||= {};
  ctx.pendingPublication = pending;
  // A legacy pending candidate may contain a receipt confirmed before its
  // checkpoint was advanced. Keep it only when the native release agrees.
  for (const item of publications) {
    if (!Object.hasOwn(pending.base_releases,item.dataset)) pending.base_releases[item.dataset] = recovered ? ctx.state.receipts[item.dataset] || null : await activeRelease(ctx,item.dataset);
  }
  await atomicJson(ctx.pendingPath, pending);
  for (const item of publications) {
    const dataset = item.dataset, active = await activeRelease(ctx,dataset), confirmed = pending.confirmed_receipts[dataset];
    if (confirmed) {
      if (!sameRelease(confirmed,active)) throw new CollectorError('RELEASE_DRIFT', `${dataset}部分發布後active release已改變，拒絕覆蓋其他範圍`);
      candidate.receipts[dataset] = confirmed; continue;
    }
    const records = Object.values(candidate.records[dataset] || {}).sort((a,b)=>a.id.localeCompare(b.id));
    const expectedSnapshot = `kcc-${digest({dataset,records,cov:item.coverage}).slice(0,40)}`;
    const baseline = pending.base_releases[dataset];
    if (!sameRelease(active,baseline) && !(active === null && baseline === null) && active?.snapshot_id !== expectedSnapshot) throw new CollectorError('RELEASE_DRIFT', `${dataset}待發布期間active release已改變，需先核對`);
    // For an uncertain prior call, the native release above proves either the
    // exact candidate is active (idempotent confirmation), or baseline is intact.
    pending.publication_states[dataset] = 'publishing'; await atomicJson(ctx.pendingPath,pending);
    try {
      const receipt = await importRecords(ctx,candidate,dataset,records,item.coverage);
      candidate.receipts[dataset] = receipt; pending.confirmed_receipts[dataset] = receipt; pending.publication_states[dataset] = 'confirmed';
      await atomicJson(ctx.pendingPath,pending);
    } catch (error) {
      pending.publication_states[dataset] = 'unknown';
      try { await atomicJson(ctx.pendingPath,pending); } catch { /* keep the original uncertain publication error */ }
      throw error;
    }
  }
  candidate.updated_at = new Date(ctx.now()).toISOString();
  await atomicJson(ctx.statePath, candidate);
  await unlink(ctx.pendingPath);
  ctx.state = candidate;
  ctx.pendingPublication = null;
}
function assertOriginalIdentity(requestedUrl, finalUrl, family, id) {
  const requested = new URL(official(requestedUrl)), final = new URL(official(finalUrl));
  const pattern = new RegExp(`^/Upload/Attachment/${family}/(\\d+)/[^/]+$`,'i');
  if (requested.pathname.match(pattern)?.[1] !== id || final.pathname.match(pattern)?.[1] !== id || requested.pathname !== final.pathname || requested.search !== final.search) throw new CollectorError('SOURCE_ID_MISMATCH', '原件最終網址與官方清單的檔案／父項目身分不一致');
}
async function capture(ctx, url, options = {}) {
  if (ctx.requests >= ctx.config.maxRequests || ctx.now() - ctx.started >= ctx.config.maxDurationMs) throw pause();
  const result = await fetchBounded(url, { allowedHosts: [KCC_HOST], maxBytes: options.maxBytes || 16 * 1024 * 1024, timeoutMs: 20000, maxRetries: 0, maxRedirects: 2, ...options, headers: { 'User-Agent': 'kcg-civic-local-collector/0.2 (public archival client; 1 request/second)', Accept: '*/*', ...(options.headers || {}) } }, {
    fetchImpl: async (...args) => {
      if (ctx.requests >= ctx.config.maxRequests || ctx.now() - ctx.started >= ctx.config.maxDurationMs) throw pause();
      ctx.requests++; return ctx.fetchImpl(...args);
    }, sleep: ctx.sleep, now: ctx.now, rateLimiter: ctx.rateLimiter,
  });
  const hash = sha256Bytes(result.bytes), filename = path.join(ctx.rawDirectory, `${hash}.bin`);
  try { await writeFile(filename, result.bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await plain(filename); if (sha256Bytes(await readFile(filename)) !== hash) throw new CollectorError('STAGING_COLLISION', 'raw原件hash不一致'); }
  const time = new Date(ctx.now()).toISOString();
  await atomicJson(path.join(ctx.captureDirectory, `${randomUUID()}.json`), { source_url: result.url, retrieved_at: time, sha256: hash, byte_length: result.bytes.length, status: result.status });
  await ctx.store.putRawObject({ sha256: hash, bytes_base64: result.bytes.toString('base64') });
  const cookieParts = result.headers?.getSetCookie?.() || [];
  for (const part of cookieParts) { const pair = part.split(';')[0], eq = pair.indexOf('='); if (eq > 0) ctx.cookies.set(pair.slice(0, eq), pair.slice(eq + 1)); }
  return { ...result, sha256: hash, retrieved_at: time, html: result.bytes.toString('utf8') };
}
function postForm(html, query, target, tab, page, pageSize) {
  const form = controls(html);
  if (!form.get('__VIEWSTATE') || !form.get('__EVENTVALIDATION')) throw new CollectorError('WEBFORMS_TOKEN_MISSING', '官方頁缺少WebForms驗證欄位');
  form.set(`${MEETING_PREFIX}ddlPeriod`, query.period); form.set(`${MEETING_PREFIX}ddlSession`, query.session); form.set(`${MEETING_PREFIX}ddlMeeting`, ''); form.set(`${PREFIX}txtKeyword`, query.keyword);
  form.set('__EVENTTARGET', target || '');
  if (tab) {
    const number = tab.pagerId || tab.tab;
    form.set(`${PREFIX}hidCurrentTab`, String(Number(tab.tab) - 1));
    form.set(`${PREFIX}DataPager${number}$ctl02$txtCurrentPage`, String(page));
    form.set(`${PREFIX}DataPager${number}$ctl02$txtPageSize`, String(pageSize));
    form.set(`${PREFIX}btnGo${number === '1' ? '' : number}`, ' Go ');
    form.set('__EVENTTARGET', '');
  }
  return form.toString();
}
async function post(ctx, url, html, query, target, tab, page, pageSize) {
  const result = await capture(ctx, url, { method: 'POST', body: postForm(html, query, target, tab, page, pageSize), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: [...ctx.cookies].map(([k,v])=>`${k}=${v}`).join('; '), Referer: url } });
  if (new URL(result.url).pathname.toLowerCase() !== new URL(url).pathname.toLowerCase()) throw new CollectorError('PARSER_CONTRACT_CHANGED', '官方查詢導向非預期頁面');
  assertQuery(result.html, query); return result;
}
function normalizedRow(row, query, tab, response, meetings) {
  const id = meetings ? row.record_id : row.proposal_sn;
  const title = meetings ? row.meeting : row.subject;
  if (!/^\d+$/.test(id) || !title?.trim()) throw new CollectorError('RECORD_INVALID', '來源列缺少識別碼或標題');
  const data = { ...JSON.parse(JSON.stringify(row)), period: query.period, session: query.session, session_code: query.session, term: Number(query.session.slice(-2)), session_period: Number(query.session.slice(-2)), query, official_tab: tab.tab, source_page: tab.page, source_page_count: tab.pages, source_tab_total: tab.total };
  if (!meetings) data.detail_url = official(row.detail_url, PROPOSAL_URL);
  return { id, title, text: [title, row.proposer, row.status, row.date].filter(Boolean).join('\n'), data, source_url: response.url, retrieved_at: response.retrieved_at, raw_sha256: response.sha256 };
}
async function collectIndex(ctx, meetings) {
  const url = meetings ? MEETING_URL : PROPOSAL_URL, dataset = meetings ? 'kcc-meetings' : 'kcc-proposals';
  const parser = meetings ? null : await loadTypeScriptParser('../kcc/search.ts', { forceNative:true, replace:(source)=>source.replace(/^import[^\n]+from "\.\/client";?\s*$/m, "const fetchWebFormsTokens=()=>{throw new Error('bounded collector owns requests')};") });
  const parse = (html) => meetings ? parseMeetingPage(html) : parseProposalTabs(html, parser.parseProposalRows);
  if (indexTotals(ctx.state).complete) return;
  let initial = await capture(ctx, url);
  if (!ctx.state.discovery) {
    const officialPeriods = optionsFor(initial.html, 'ddlPeriod');
    const periods = ctx.config.periods || officialPeriods.map((v) => v.value);
    for (const p of periods) if (!officialPeriods.some((v) => v.value === p)) throw new CollectorError('FILTER_NOT_CONFIRMED', '指定period不在官方選單');
    const officialSessions = optionsFor(initial.html, 'ddlSession');
    const sessions = ctx.config.sessions || officialSessions.map((v) => v.value);
    for (const s of sessions) if (!officialSessions.some((v) => v.value === s)) throw new CollectorError('FILTER_NOT_CONFIRMED', '指定session不在官方選單');
    const queries = periods.flatMap((period) => sessions.filter((session) => session.startsWith(period)).map((session) => ({ period, session, keyword: ctx.config.keyword })));
    if (!queries.length) throw new CollectorError('DISCOVERY_EMPTY', '官方範圍沒有有效屆次');
    const candidate = structuredClone(ctx.state); candidate.discovery = { official_periods: officialPeriods, official_sessions: officialSessions, queries, source_url: initial.url, raw_sha256: initial.sha256, retrieved_at: initial.retrieved_at, declared_scope: ctx.config.sessions ? 'explicit-sessions' : 'all-enumerated-official-sessions' };
    await publishState(ctx, candidate, []);
  }
  // Enumerate every declared query before harvesting pages. This makes the
  // overall source size observable in the first bounded segment, while each
  // tab retains its own total and independent completeness proof.
  for (const query of ctx.state.discovery.queries) {
    const key = `${query.period}/${query.session}`;
    if (ctx.state.queries[key]) continue;
    const response = await post(ctx, url, initial.html, query, `${PREFIX}${meetings ? 'linkBtnSearch' : 'LinkButton1'}`);
    const observed = parse(response.html), next = structuredClone(ctx.state);
    next.queries[key] = { query, tab_ids:observed.map((t)=>t.tab), enumeration_source_url:response.url, enumeration_raw_sha256:response.sha256, enumeration_retrieved_at:response.retrieved_at,
      tabs:Object.fromEntries(observed.map((t)=>[t.tab,{tab:t.tab,pagerId:t.pagerId,total:t.total,pageSize:ctx.config.pageSize,next_page:1,pages_proof:[],ids:[],complete:t.total===0}])), complete:observed.every((t)=>t.total===0) };
    await publishState(ctx,next,[]); initial=response;
  }
  for (const query of ctx.state.discovery.queries) {
    const key = `${query.period}/${query.session}`;
    if (ctx.state.queries[key]?.complete) continue;
    let response = await post(ctx, url, initial.html, query, `${PREFIX}${meetings ? 'linkBtnSearch' : 'LinkButton1'}`);
    let observed = parse(response.html);
    const candidate = structuredClone(ctx.state), existing = candidate.queries[key];
    if (existing) {
      if (existing.tab_ids.join(',') !== observed.map((t) => t.tab).join(',')) throw new CollectorError('SOURCE_DRIFT', '來源tab集合改變，需重新驗證');
      for (const tab of observed) if (existing.tabs[tab.tab].total !== tab.total) throw new CollectorError('SOURCE_DRIFT', '來源總數改變，既有頁序不得直接接續');
    } else {
      candidate.queries[key] = { query, tab_ids: observed.map((t)=>t.tab), tabs: Object.fromEntries(observed.map((t) => [t.tab, { tab: t.tab, pagerId: t.pagerId, total: t.total, pageSize: ctx.config.pageSize, next_page: 1, page_ids: [], pages_proof: [], ids: [], complete: t.total === 0 }])), complete: false };
      await publishState(ctx, candidate, []);
    }
    for (const original of observed) {
      while (!ctx.state.queries[key].tabs[original.tab].complete) {
        if (ctx.pages >= ctx.config.maxPages) throw pause();
        const progress = ctx.state.queries[key].tabs[original.tab];
        let current = parse(response.html).find((t) => t.tab === original.tab);
        if (current.page !== progress.next_page || current.pageSize !== ctx.config.pageSize) {
          response = await post(ctx, url, response.html, query, '', current, progress.next_page, ctx.config.pageSize);
          current = parse(response.html).find((t) => t.tab === original.tab);
        }
        if (!current || current.total !== progress.total || current.page !== progress.next_page || current.pageSize !== ctx.config.pageSize) throw new CollectorError('PAGER_NOT_ADVANCED', '官方頁序或每頁筆數未確認');
        const normalized = current.rows.map((row) => normalizedRow(row, query, current, response, meetings));
        const ids = normalized.map((row)=>row.id);
        if (new Set(ids).size !== ids.length || ids.some((id) => progress.ids.includes(id))) throw new CollectorError('DUPLICATE_PAGE_OR_ID', '同tab分頁出現重複識別碼');
        const next = structuredClone(ctx.state); const nextTab = next.queries[key].tabs[original.tab];
        next.records[dataset] ||= {};
        for (const record of normalized) {
          if (next.records[dataset][record.id]) throw new CollectorError('DUPLICATE_SCOPE_ID', '不同tab/屆次出現相同識別碼，拒絕混算總數');
          next.records[dataset][record.id] = record;
        }
        nextTab.ids.push(...ids); nextTab.pages_proof.push({ page: current.page, pages: current.pages, total: current.total, row_count: ids.length, ids_sha256: digest(ids), raw_sha256: response.sha256 }); nextTab.next_page++;
        nextTab.complete = current.page === current.pages && nextTab.ids.length === current.total && nextTab.pages_proof.length === current.pages && !current.nextTarget;
        if (current.page === current.pages && !nextTab.complete) throw new CollectorError('SOURCE_TOTAL_INCONSISTENT', '最後頁無法證明完整列數與頁序');
        next.queries[key].complete = Object.values(next.queries[key].tabs).every((t)=>t.complete);
        const totals = indexTotals(next); await publishState(ctx, next, [{ dataset, coverage: coverage(next, totals.complete, totals.sourceTotal) }]); ctx.pages++;
        if (nextTab.complete) break;
        if (ctx.pages >= ctx.config.maxPages) throw pause();
        response = await post(ctx, url, response.html, query, '', current, nextTab.next_page, ctx.config.pageSize);
      }
    }
    if (!ctx.state.queries[key].complete && Object.values(ctx.state.queries[key].tabs).every((t)=>t.complete)) {
      const next = structuredClone(ctx.state); next.queries[key].complete = true; const totals = indexTotals(next);
      await publishState(ctx, next, Object.keys(next.records[dataset] || {}).length ? [{ dataset, coverage: coverage(next, totals.complete, totals.sourceTotal) }] : []);
    }
    initial = response;
  }
}
async function readAll(store, dataset) {
  if (!await store.hasDataset(dataset)) throw new CollectorError('DEPENDENCY_UNAVAILABLE', `缺少已驗證${dataset}索引`);
  const rows = []; let release;
  for (let offset = 0; ; offset += 1000) {
    const result = await store.queryRecords(dataset, { limit: 1000, offset });
    if (!result.release || !/^[a-f0-9]{64}$/i.test(result.release.manifest_sha256 || '') ||
        (release && !sameRelease(release,result.release)) || result.local_match_count !== result.release.record_count) throw new CollectorError('DEPENDENCY_DRIFT', '母集分頁讀取期間snapshot、manifest或總數改變');
    release ||= result.release;
    rows.push(...result.records.map(({json,...r})=>r));
    if (rows.length > release.record_count || (rows.length < release.record_count && result.records.length !== 1000)) throw new CollectorError('DEPENDENCY_DRIFT', '母集頁面列數與固定快照總數不一致');
    if (rows.length >= result.local_match_count) break;
  }
  if (new Set(rows.map((row)=>row.id)).size !== rows.length) throw new CollectorError('DEPENDENCY_DRIFT', '母集跨頁出現重複識別碼');
  return { rows, release };
}
async function initializeEnrichment(ctx, sourceDataset) {
  const source = await readAll(ctx.store, sourceDataset);
  if (ctx.state.dependency) {
    if (!sameRelease(ctx.state.dependency,source.release)) throw new CollectorError('DEPENDENCY_DRIFT', '索引快照已更新，先完成或重新裁決現有採集範圍');
  } else {
    const next = structuredClone(ctx.state); next.dependency = source.release; next.source_ids = source.rows.map((r)=>r.id); next.cursor = 0; next.work = null;
    await publishState(ctx, next, []);
  }
  return source.rows;
}
async function saveWork(ctx, work) { const next = structuredClone(ctx.state); next.work = work; await publishState(ctx, next, []); }
async function collectDetails(ctx) {
  const rows = await initializeEnrichment(ctx, 'kcc-proposals');
  for (let cursor = ctx.state.cursor; cursor < rows.length; cursor = ctx.state.cursor) {
    const row = rows[cursor], sn = row.id;
    let work = ctx.state.work;
    if (!work) {
      const url = official(row.data.detail_url.replace(/(?:%27|')$/i, ''), PROPOSAL_URL);
      if (new URL(url).pathname !== '/System/Proposal/Detail.aspx') throw new CollectorError('URL_REJECTED', '提案詳情來源必須為Detail.aspx');
      const response = await capture(ctx, url); const data = parseDetail(response.html, sn, response.url);
      work = { id: sn, detail: { id: sn, title: data.subject, text: [data.subject,data.explanation,data.method,data.remarks].filter(Boolean).join('\n'), data: { ...row.data,...data }, source_url: response.url, raw_sha256: response.sha256, retrieved_at: response.retrieved_at }, attachments: null, list: null, downloaded: 0 };
      await saveWork(ctx, work);
    }
    if (work.attachments === null) {
      const url = `https://${KCC_HOST}/Common/GetAttachmentList.ashx?f=1&s=${sn}&t=False`;
      const response = await capture(ctx, url, { headers: { Referer: work.detail.source_url, 'X-Requested-With':'XMLHttpRequest', Cookie: [...ctx.cookies].map(([k,v])=>`${k}=${v}`).join('; ') } });
      const actual = new URL(response.url);
      if (actual.pathname !== '/Common/GetAttachmentList.ashx' || actual.searchParams.get('s') !== sn) throw new CollectorError('SOURCE_ID_MISMATCH', '附件清單來源不一致');
      work.attachments = parseAttachments(response.html, sn); work.list = { source_url: response.url, raw_sha256: response.sha256, retrieved_at: response.retrieved_at }; await saveWork(ctx, work);
    }
    while (work.downloaded < work.attachments.length) {
      const attachment = work.attachments[work.downloaded];
      assertOriginalIdentity(attachment.download_url,attachment.download_url,'Proposal',sn);
      const response = await capture(ctx, attachment.download_url, { maxBytes: 64 * 1024 * 1024, headers: { Referer: work.detail.source_url } });
      assertOriginalIdentity(attachment.download_url,response.url,'Proposal',sn);
      attachment.raw_sha256 = response.sha256; attachment.byte_length = response.bytes.length; attachment.retrieved_at = response.retrieved_at; attachment.source_url = response.url;
      if (!response.bytes.length || /^text\/html/i.test(response.headers?.get?.('content-type') || '')) throw new CollectorError('ATTACHMENT_CONTENT_INVALID', '附件回應不是有效原件');
      work.downloaded++; await saveWork(ctx, work);
    }
    const next = structuredClone(ctx.state); next.records['kcc-proposal-details'] ||= {}; next.records['kcc-proposal-attachments'] ||= {};
    work.detail.data.attachments = work.attachments; work.detail.data.attachment_list_raw_sha256 = work.list.raw_sha256;
    next.records['kcc-proposal-details'][sn] = work.detail;
    next.records['kcc-proposal-attachments'][sn] = { id: sn, title: `${work.detail.title} 附件清單`, text: work.attachments.map((a)=>a.name).join('\n') || '官方來源明示無附件', data: { proposal_sn: sn, attachments: work.attachments, total_files: work.attachments.length, attachment_originals_complete: true }, ...work.list };
    next.cursor++; next.work = null;
    const complete = next.cursor === rows.length && sourceComplete(next), cov = coverage(next, complete, rows.length);
    await publishState(ctx, next, [{ dataset:'kcc-proposal-details',coverage:cov },{ dataset:'kcc-proposal-attachments',coverage:cov }]);
  }
}
const sourceComplete = (state) => state.dependency?.coverage?.complete === true;
export async function extractPdfPages(bytes) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const document = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const result = await extractText(document, { mergePages: false });
    if (!Number.isSafeInteger(result.totalPages) || result.totalPages < 1 || !Array.isArray(result.text) || result.text.length !== result.totalPages) throw new CollectorError('PDF_PAGE_SEQUENCE_INVALID', 'PDF逐頁擷取結果與原始頁數不一致');
    return { total_pages: result.totalPages, pages: result.text.map((value,index)=>({ page:index+1,text:value, has_text_layer:Boolean(value.trim()) })) };
  } finally { await document.destroy?.(); }
}
export function validatePdfExtraction(result) {
  if (!result || !Number.isSafeInteger(result.total_pages) || result.total_pages < 1 || !Array.isArray(result.pages) || result.pages.length !== result.total_pages || result.pages.some((p,i)=>p.page!==i+1 || typeof p.text!=='string')) throw new CollectorError('PDF_PAGE_SEQUENCE_INVALID', 'PDF逐頁文字缺頁、重號或缺少總頁數');
  const empty = result.pages.filter((p)=>!p.text.trim()).map((p)=>p.page);
  return { ...result, empty_text_pages:empty, text_layer_status:empty.length === result.total_pages ? 'absent' : empty.length ? 'partial' : 'present', speaker_attribution:'not-inferred' };
}
async function collectPdfs(ctx) {
  const rows = await initializeEnrichment(ctx, 'kcc-meetings');
  for (let cursor = ctx.state.cursor; cursor < rows.length; cursor = ctx.state.cursor) {
    const row = rows[cursor], id = row.id;
    let work = ctx.state.work || { id, versions:[] };
    const urls = row.data.pdf_urls || [row.data.pdf_url];
    for (let index = work.versions.length; index < urls.length; index++) {
      const url = official(urls[index], MEETING_URL);
      assertOriginalIdentity(url,url,'MeetingRecord',id);
      const response = await capture(ctx, url, { maxBytes: 96 * 1024 * 1024 });
      assertOriginalIdentity(url,response.url,'MeetingRecord',id);
      if (response.bytes.subarray(0,5).toString() !== '%PDF-') throw new CollectorError('PDF_SIGNATURE_INVALID', '官方回應沒有PDF檔頭');
      const extraction = validatePdfExtraction(await ctx.pdfExtractor(response.bytes));
      work.versions.push({ pdf_url:response.url,raw_sha256:response.sha256,retrieved_at:response.retrieved_at,byte_length:response.bytes.length,...extraction }); await saveWork(ctx, work);
    }
    const selected = work.versions.at(-1), next = structuredClone(ctx.state);
    next.records['kcc-meeting-records'] ||= {};
    next.records['kcc-meeting-records'][id] = { id, title:row.title, text:selected.pages.map((p)=>p.text).join('\n') || 'PDF原件無可擷取文字層；尚未OCR', data:{ ...row.data,...selected,record_id:id,pdf_versions:work.versions,selected_version_policy:'last-official-listed-file',pdf_originals_complete:true },source_url:selected.pdf_url,retrieved_at:selected.retrieved_at,raw_sha256:selected.raw_sha256 };
    next.cursor++; next.work = null;
    const complete = next.cursor === rows.length && sourceComplete(next);
    await publishState(ctx,next,[{ dataset:'kcc-meeting-records',coverage:coverage(next,complete,rows.length) }]);
  }
}
export async function runKccCollection(options = {}, dependencies = {}) {
  const config = normalizeOptions(options), root = path.resolve(options.root), scope = JSON.stringify({ profile:config.profile,periods:config.periods,sessions:config.sessions,keyword:config.keyword,pageSize:config.pageSize });
  const directory = await safeDirectory(root,['.kcc-collection',config.profile,digest(scope).slice(0,24)]);
  const lockPath = path.join(root,'.kcc-collection','collector.lock'); let lockAcquired = false, store;
  const now = dependencies.now || Date.now, sleep = dependencies.sleep || ((ms)=>new Promise((resolve)=>setTimeout(resolve,ms)));
  const ctx = { config, directory,statePath:path.join(directory,'checkpoint.json'),pendingPath:path.join(directory,'pending-publication.json'),rawDirectory:await safeDirectory(root,['.kcc-collection','raw']),captureDirectory:await safeDirectory(root,['.kcc-collection','captures']),now,sleep,started:now(),requests:0,pages:0,cookies:new Map(),fetchImpl:dependencies.fetchImpl || fetch,pdfExtractor:dependencies.pdfExtractor || extractPdfPages };
  let error = null;
  try {
    try { await writeFile(lockPath,JSON.stringify({pid:process.pid,started_at:new Date(now()).toISOString()}),{flag:'wx',mode:0o600});lockAcquired=true; }
    catch (e) { if(e.code==='EEXIST') throw new CollectorError('COLLECTION_LOCKED','同scope已有採集鎖；確認原程序終止後才可移除鎖');throw e; }
    const factory = dependencies.storeFactory || (async (location)=>{const {LocalStore}=await import('../local/store.mjs');return new LocalStore(location,{readOnly:false});});
    store=await factory(root); ctx.store=store;
    if(typeof store.putRawObject!=='function'||typeof store.importSnapshot!=='function') throw new CollectorError('STORE_API_UNAVAILABLE','缺少本機原件或快照寫入API');
    ctx.state=await jsonRead(ctx.statePath,{version:VERSION,scope,config:{profile:config.profile,periods:config.periods,sessions:config.sessions,keyword:config.keyword,pageSize:config.pageSize},created_at:new Date(now()).toISOString(),queries:{},records:{},receipts:{}});
    if(ctx.state.version!==VERSION||ctx.state.scope!==scope) throw new CollectorError('CHECKPOINT_MISMATCH','checkpoint版本或範圍不一致');
    await atomicJson(ctx.statePath,ctx.state);
    const pending=await jsonRead(ctx.pendingPath,null);
    if(pending) { if(pending.state.scope!==scope) throw new CollectorError('CHECKPOINT_MISMATCH','待發布範圍不一致');await publishState(ctx,pending.state,pending.publications,pending); }
    await assertActiveReceipts(ctx);
    let lastStart=-Infinity;
    ctx.rateLimiter=async()=>{const wait=Math.max(0,1000-(now()-lastStart));if(wait) await sleep(wait);lastStart=now();};
    if(config.profile==='kcc-proposals-full'||config.profile==='kcc-meetings-full') await collectIndex(ctx,config.profile==='kcc-meetings-full');
    else if(config.profile==='kcc-proposal-details') await collectDetails(ctx);
    else await collectPdfs(ctx);
  } catch (e) { error=e; }
  finally {
    if (ctx.state && store && !ctx.pendingPublication) {
      try { await assertActiveReceipts(ctx); } catch (verificationError) { error = verificationError; }
    }
    if(store?.close) store.close(); if(lockAcquired) await unlink(lockPath);
  }
  const state=ctx.state, totals=state ? indexTotals(state) : {complete:false,sourceTotal:null,tabs:[]};
  const indexProfile=config.profile.endsWith('-full');
  const exhausted=state && (indexProfile?totals.complete:state.dependency&&state.cursor===state.source_ids?.length);
  const blocked=Boolean(error&&error.code!=='COLLECTION_YIELD');
  const complete=Boolean(!blocked&&exhausted&&(indexProfile||sourceComplete(state)));
  const dataset=KCC_PROFILE_MANIFEST[config.profile].dataset;
  const pending = ctx.pendingPublication;
  const receipts = {...state?.receipts,...pending?.confirmed_receipts};
  const uncertainDatasets = Object.entries(pending?.publication_states || {}).filter(([,status])=>status==='publishing'||status==='unknown').map(([name])=>name);
  const commitState = uncertainDatasets.length ? 'unknown' : pending && Object.keys(pending.confirmed_receipts || {}).length ? 'partial' : Object.keys(receipts).length ? 'committed' : 'not-committed';
  return { profile:config.profile,dataset,status:blocked?'blocked':exhausted?(complete?'complete':'partial'):'paused',continuation_required:!blocked&&!exhausted,source_exhausted:Boolean(exhausted),dry_run:false,commit_state:commitState,publication_status:pending&&Object.keys(pending.confirmed_receipts||{}).length?'partial':uncertainDatasets.length?'unknown':'confirmed',uncertain_datasets:uncertainDatasets,needs_reconciliation:Boolean(uncertainDatasets.length||error?.code==='RELEASE_DRIFT'),record_count:receipts[dataset]?.record_count??Object.keys(state?.records?.[dataset]||{}).length,attempted:ctx.requests,succeeded:ctx.pages,failed:blocked?1:0,error_code:blocked?(error.code||error.reasonCode||'COLLECTION_FAILED'):null,error_message:blocked?String(error.message).slice(0,500):null,coverage:state?coverage(state,complete,indexProfile?totals.sourceTotal:state.source_ids?.length??null):{scope,complete:false,source_total:null},checkpoint_path:ctx.statePath,checkpoint_status:state?'persisted':'not-created',receipts,receipt:receipts[dataset]||null,source_discovery:state?.discovery||null,progress:indexProfile?{queries:Object.fromEntries(Object.entries(state?.queries||{}).map(([key,q])=>[key,{complete:q.complete,tabs:Object.fromEntries(Object.entries(q.tabs).map(([id,t])=>[id,{total:t.total,next_page:t.next_page,collected_ids:t.ids.length,collected_pages:t.pages_proof.length,complete:t.complete,last_page:t.pages_proof.at(-1)||null}]))}])),source_total_estimate:totals.sourceTotal,discovered_total_so_far:totals.tabs.reduce((n,t)=>n+t.total,0)}:{cursor:state?.cursor??0,total:state?.source_ids?.length??null,current_id:state?.work?.id??null,dependency:state?.dependency||null},basic_validation:blocked?'not-passed':'passed',human_semantic_validation:'pending' };
}
