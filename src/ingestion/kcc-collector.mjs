import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CollectorError, fetchBounded, loadTypeScriptParser, sha256Bytes } from './collector.mjs';
import { PROPOSAL_URL, MEETING_URL, KCC_HOST, PREFIX, MEETING_PREFIX, controls, optionsFor, assertQuery, parseProposalTabs, parseMeetingPage, parseDetail, parseAttachments, official } from './kcc-html.mjs';
import { KccEnrichmentStage, enrichmentBatchReady } from './kcc-enrichment-stage.mjs';

const VERSION = 'kcc-all-tabs-resumable-v1';
export const KCC_PROFILE_MANIFEST = Object.freeze({
  'kcc-proposals-full': { dataset: 'kcc-proposals', scope: 'all-official-sessions/all-tabs/all-pages', state: 'implemented-resumable' },
  'kcc-meetings-full': { dataset: 'kcc-meetings', scope: 'all-official-sessions/all-pages', state: 'implemented-resumable' },
  'kcc-proposal-details': { dataset: 'kcc-proposal-details', scope: 'verified-local-proposal-index/all-details-and-attachments', state: 'implemented-resumable' },
  'kcc-meeting-records': { dataset: 'kcc-meeting-records', scope: 'verified-local-meetings/all-original-versions/pdf-page-text', state: 'implemented-resumable' },
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
async function post(ctx, url, html, query, target, tab, page, pageSize, limits = {}) {
  const result = await capture(ctx, url, { ...limits,method: 'POST', body: postForm(html, query, target, tab, page, pageSize), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: [...ctx.cookies].map(([k,v])=>`${k}=${v}`).join('; '), Referer: url } });
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
async function reconcileCompleteTab(ctx,{url,response,query,key,current,parse,dataset,meetings}) {
  const previous = ctx.state.queries[key].tabs[current.tab];
  if (previous.total > 20000) throw new CollectorError('SOURCE_RECONCILIATION_LIMIT','官方分頁不穩定且單回應完整列舉超過20000列安全界線');
  const full = await post(ctx,url,response.html,query,'',current,1,previous.total,{maxBytes:64*1024*1024,timeoutMs:25000});
  const observed = parse(full.html), known = ctx.state.queries[key];
  if (known.tab_ids.join(',') !== observed.map((t)=>t.tab).join(',') || observed.some((t)=>known.tabs[t.tab].total!==t.total)) throw new CollectorError('SOURCE_DRIFT','完整列舉期間tab集合或總數改變');
  const tab = observed.find((t)=>t.tab===current.tab);
  if (!tab || tab.page!==1 || tab.pages!==1 || tab.pageSize!==previous.total || tab.total!==previous.total || tab.nextTarget || tab.rows.length!==previous.total) throw new CollectorError('SOURCE_RECONCILIATION_FAILED','官方未回傳單一完整tab，拒絕以去重猜完整');
  const records = tab.rows.map((row)=>normalizedRow(row,query,tab,full,meetings)), ids=records.map((r)=>r.id), idSet=new Set(ids), priorSet=new Set(previous.ids);
  if (idSet.size!==previous.total || previous.ids.some((id)=>!idSet.has(id))) throw new CollectorError('SOURCE_RECONCILIATION_FAILED','完整tab不唯一或未涵蓋既有成功識別碼');
  const next=structuredClone(ctx.state);next.records[dataset] ||= {};
  for (const record of records) {
    const existing=next.records[dataset][record.id];
    if (existing && !priorSet.has(record.id)) throw new CollectorError('DUPLICATE_SCOPE_ID','完整列舉識別碼已出現在其他tab或屆次');
    if (existing) {
      for (const field of meetings?['meeting_name','date']:['proposal_kind','number','category','proposer','subject','status','detail_url']) {
        if (String(existing.data[field]??'')!==String(record.data[field]??'')) throw new CollectorError('SOURCE_DRIFT',`完整列舉期間既有資料${record.id}/${field}改變`);
      }
    } else next.records[dataset][record.id]=record;
  }
  const progress=next.queries[key].tabs[current.tab];
  // Keep the original successful records, page receipts, and cursor. A separate
  // stronger proof establishes the whole tab without pretending page 5 is new.
  progress.ids.push(...ids.filter((id)=>!priorSet.has(id)));progress.complete=true;
  progress.reconciliation={strategy:'single-response-complete-tab-v1',trigger:'DUPLICATE_PAGE_OR_ID',preserved_next_page:previous.next_page,preserved_pages:previous.pages_proof.length,preserved_record_count:previous.ids.length,response:{page:1,pages:1,page_size:tab.pageSize,source_total:tab.total,raw_row_count:tab.source_row_count,row_count:ids.length,unique_count:idSet.size,byte_length:full.bytes.length,ids_sha256:digest(ids),raw_sha256:full.sha256,source_url:full.url,retrieved_at:full.retrieved_at},prior_ids_covered:true};
  next.queries[key].complete=Object.values(next.queries[key].tabs).every((t)=>t.complete);
  const totals=indexTotals(next);await publishState(ctx,next,[{dataset,coverage:coverage(next,totals.complete,totals.sourceTotal)}]);ctx.pages++;
  return full;
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
        if (new Set(ids).size !== ids.length || ids.some((id) => progress.ids.includes(id))) {
          if(meetings)throw new CollectorError('DUPLICATE_PAGE_OR_ID','議事錄分頁含重複識別碼；未驗證議事錄單回應恢復策略');
          response=await reconcileCompleteTab(ctx,{url,response,query,key,current,parse,dataset,meetings});
          // The complete response carries an unusually large pager setting.
          // End this segment after its successful receipt; the next segment
          // obtains a fresh GET/query before touching another tab.
          throw pause();
        }
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
    // Official Search retains the previous term's pager offset in ViewState.
    // Preserve this term's successful receipt and start the next term only
    // after a fresh GET in the next segment, never by reusing its last page.
    if (!indexTotals(ctx.state).complete) throw pause();
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
function contentIndexed(record) {
  return record.data.content_index_status === 'indexed' || (!record.data.content_index_status && record.data.text_layer_status === 'present' && Array.isArray(record.data.pages) && record.data.pages.length > 0);
}
const allContentIndexed = (state) => Object.values(state.records['kcc-meeting-records'] || {}).every(contentIndexed);
function validateNonPdfOriginal(bytes,fileType,contentType='') {
  const head=bytes.subarray(0,1024).toString('utf8').replace(/^\uFEFF/,'').trimStart();
  if(/^text\/html/i.test(contentType)||/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(head))throw new CollectorError('ORIGINAL_SIGNATURE_INVALID','非PDF下載回應是HTML，不能當原件歸檔完成');
  if(fileType!=='doc')throw new CollectorError('ORIGINAL_FORMAT_UNSUPPORTED',`尚未驗證議事錄${fileType||'unknown'}格式，raw已保留但不宣稱原件完整`);
  if(bytes.length<8||bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')throw new CollectorError('ORIGINAL_SIGNATURE_INVALID','DOC原件缺少完整8-byte CFBF檔頭');
  return {status:'passed',validation_version:'cfbf-magic-8-v1',declared_file_type:'doc',detected_container:'CFBF'};
}
async function verifyStoredNonPdf(ctx,version) {
  if(version.format_validation?.status==='passed'&&version.format_validation?.validation_version==='cfbf-magic-8-v1'&&version.file_type==='doc')return;
  const bytes=typeof ctx.store.readRawObject==='function'?await ctx.store.readRawObject(version.raw_sha256):await readFile(path.join(ctx.rawDirectory,`${version.raw_sha256}.bin`));
  if(sha256Bytes(bytes)!==version.raw_sha256)throw new CollectorError('STAGING_COLLISION','既存非PDF原件hash不一致');
  version.format_validation=validateNonPdfOriginal(bytes,version.file_type);
}
async function collectPdfs(ctx) {
  const rows = await initializeEnrichment(ctx, 'kcc-meetings');
  const legacyRecords=Object.values(ctx.state.records['kcc-meeting-records']||{}).filter((record)=>(record.data.original_versions||[]).some((version)=>!version.pdf_url&&(version.file_type!=='doc'||version.format_validation?.status!=='passed'||version.format_validation?.validation_version!=='cfbf-magic-8-v1')));
  if(legacyRecords.length){
    const next=structuredClone(ctx.state);
    for(const record of legacyRecords)for(const version of next.records['kcc-meeting-records'][record.id].data.original_versions)if(!version.pdf_url)await verifyStoredNonPdf(ctx,version);
    const complete=next.cursor===rows.length&&sourceComplete(next)&&allContentIndexed(next);
    await publishState(ctx,next,[{dataset:'kcc-meeting-records',coverage:coverage(next,complete,rows.length)}]);
  }
  for (let cursor = ctx.state.cursor; cursor < rows.length; cursor = ctx.state.cursor) {
    const row = rows[cursor], id = row.id;
    const work = ctx.state.work || { id, versions:[] };
    for (const version of work.versions) { version.source_url ||= version.pdf_url;version.download_url ||= version.source_url;version.file_type ||= version.pdf_url?'pdf':'unknown'; }
    for(const version of work.versions)if(!version.pdf_url)await verifyStoredNonPdf(ctx,version);
    const files = row.data.original_files || (row.data.pdf_urls || [row.data.pdf_url]).filter(Boolean).map((url)=>({download_url:url,file_type:'pdf'}));
    for (const file of files) {
      const url = official(file.download_url,MEETING_URL);
      if (work.versions.some((version)=>(version.source_url || version.pdf_url)===url)) continue;
      assertOriginalIdentity(url,url,'MeetingRecord',id);
      const response = await capture(ctx,url,{maxBytes:96*1024*1024});
      assertOriginalIdentity(url,response.url,'MeetingRecord',id);
      const isPdf = file.file_type === 'pdf';
      let extraction;
      if (isPdf) {
        if (response.bytes.subarray(0,5).toString() !== '%PDF-') throw new CollectorError('PDF_SIGNATURE_INVALID','官方回應沒有PDF檔頭');
        extraction=validatePdfExtraction(await ctx.pdfExtractor(response.bytes));
      } else {
        const validation=validateNonPdfOriginal(response.bytes,file.file_type,response.headers?.get?.('content-type')||'');
        extraction={format_validation:validation,extraction_status:'unsupported_text_extraction',text_layer_status:'not_indexed',total_pages:null,pages:[],speaker_attribution:'not-inferred'};
      }
      work.versions.push({source_url:response.url,download_url:url,...(isPdf?{pdf_url:response.url}:{}),file_type:file.file_type,raw_sha256:response.sha256,retrieved_at:response.retrieved_at,byte_length:response.bytes.length,...extraction});await saveWork(ctx,work);
    }
    const pdfs=work.versions.filter((version)=>version.pdf_url),selected=pdfs.at(-1),original=selected || work.versions.at(-1);
    const unindexed=work.versions.filter((version)=>!version.pdf_url || version.text_layer_status!=='present').length;
    const contentStatus=selected?(unindexed?'partial_text_layer':'indexed'):work.versions.length?'unindexed_non_pdf':'no_original_published';
    const next=structuredClone(ctx.state);next.records['kcc-meeting-records'] ||= {};
    next.records['kcc-meeting-records'][id]={id,title:row.title,text:selected?.pages.map((page)=>page.text).join('\n') || (work.versions.length?'官方原件已保存；此列無已索引PDF文字，尚未處理非PDF文字。':'官方索引列未發布原件，沒有可索引文字。'),data:{...row.data,...(selected||{}),record_id:id,pdf_url:selected?.pdf_url||null,pages:selected?.pages||[],total_pages:selected?.total_pages??null,pdf_versions:pdfs,original_versions:work.versions,originals_complete:true,pdf_originals_complete:true,content_index_status:contentStatus,fulltext_complete:contentStatus==='indexed',unindexed_original_count:unindexed,selected_version_policy:'last-official-listed-pdf',speaker_attribution:'not-inferred'},source_url:original?.source_url||original?.pdf_url||row.source_url,retrieved_at:original?.retrieved_at||row.retrieved_at,raw_sha256:original?.raw_sha256||row.raw_sha256};
    next.cursor++;next.work=null;
    const complete=next.cursor===rows.length&&sourceComplete(next)&&allContentIndexed(next);
    await publishState(ctx,next,[{dataset:'kcc-meeting-records',coverage:coverage(next,complete,rows.length)}]);
  }
}

const ENRICHMENT_V2_PARSER = 'kcc-enrichment-v2';
const ENRICHMENT_V2_VALIDATOR = 'official-raw-envelope-page-refs-v2';

function sameV2Release(left, right) {
  return Boolean(left && right && ['dataset', 'snapshot_id', 'manifest_sha256', 'record_count'].every((key) => left[key] === right[key]));
}

async function activeV2Release(ctx, dataset) {
  if (typeof ctx.store.queryV2 !== 'function') throw new CollectorError('STORE_API_UNAVAILABLE', '缺少 LocalStore.queryV2 原生 active release 核對 API');
  try {
    const result = await ctx.store.queryV2(dataset, { limit: 0, metadataOnly: true });
    return result.release || null;
  } catch (error) {
    const code = error.reasonCode || error.code;
    if (['LOCAL_DATA_UNAVAILABLE', 'NO_ACTIVE_RELEASE'].includes(code)) return null;
    throw error;
  }
}

async function readV2Archive(ctx, release) {
  if (!release) return [];
  if (typeof ctx.store.readSnapshotVersionV2 !== 'function') throw new CollectorError('STORE_API_UNAVAILABLE', '缺少 v2 archive descriptor 原生讀取 API');
  const archived = await ctx.store.readSnapshotVersionV2(release.dataset, release.snapshot_id);
  if (!sameV2Release(release, archived) || archived.records?.length !== release.record_count) throw new CollectorError('RELEASE_DRIFT', `${release.dataset} v2 archive 與 active receipt 不一致`);
  return archived.records;
}

async function loadV2Codec(ctx) {
  if (ctx.v2Codec) return ctx.v2Codec;
  ctx.v2Codec = await import('../local/kcc-payload.mjs');
  if (typeof ctx.v2Codec.packKccV2PdfPage !== 'function' || typeof ctx.v2Codec.packKccV2Record !== 'function') {
    throw new CollectorError('STORE_API_UNAVAILABLE', 'KCC payload v2 page/record pack API 尚未就緒');
  }
  return ctx.v2Codec;
}

function recordPageGroups(record) {
  const data = record.data || {};
  const groups = [];
  const versions = Array.isArray(data.pdf_versions) ? data.pdf_versions : [];
  const selected = data.pdf_url
    ? [...versions].reverse().find((version) => [version?.pdf_url, version?.source_url, version?.download_url].includes(data.pdf_url))
    : versions.at(-1);
  if (Array.isArray(data.pages)) groups.push({ pages: data.pages, version: selected || { source_url: data.pdf_url || record.source_url, raw_sha256: data.raw_sha256 || record.raw_sha256 } });
  for (const version of versions) if (Array.isArray(version?.pages)) groups.push({ pages: version.pages, version });
  for (const version of Array.isArray(data.original_versions) ? data.original_versions : []) if (Array.isArray(version?.pages)) groups.push({ pages: version.pages, version });
  return groups;
}

function assignPath(root, parts, value) {
  let cursor = root;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts.at(-1)] = value;
}

async function packRecordV2(ctx, dataset, sourceRecord, savedPageRefs = []) {
  const codec = await loadV2Codec(ctx);
  const record = structuredClone(sourceRecord);
  const pageRefs = [...savedPageRefs];
  const byPage = new Map(pageRefs.map((entry) => [`${entry.page_ref.raw_sha256}:${entry.page_ref.page_number}`, entry]));
  const data = record.data || {};
  const groups = recordPageGroups(record);
  const paths = [];
  if (Array.isArray(data.pages)) {
    const versions = Array.isArray(data.pdf_versions) ? data.pdf_versions : [];
    const selected = data.pdf_url ? [...versions].reverse().find((version) => [version?.pdf_url, version?.source_url, version?.download_url].includes(data.pdf_url)) : versions.at(-1);
    paths.push({ path: ['pages'], pages: data.pages, version: selected || { source_url: data.pdf_url || record.source_url, raw_sha256: data.raw_sha256 || record.raw_sha256 } });
  }
  for (const [index, version] of (Array.isArray(data.pdf_versions) ? data.pdf_versions : []).entries()) if (Array.isArray(version?.pages)) paths.push({ path: ['pdf_versions', index, 'pages'], pages: version.pages, version });
  for (const [index, version] of (Array.isArray(data.original_versions) ? data.original_versions : []).entries()) if (Array.isArray(version?.pages)) paths.push({ path: ['original_versions', index, 'pages'], pages: version.pages, version });
  for (const group of paths) {
    const version = group.version || {};
    const rawSha = version.raw_sha256 || record.raw_sha256;
    const source = version.source_url || version.download_url || version.pdf_url || record.source_url;
    if (!/^[a-f0-9]{64}$/i.test(rawSha || '') || !source) throw new CollectorError('PAGE_REF_INVALID', `${record.id} PDF 頁面缺少來源與 raw SHA-256`);
    const cleanPages = [];
    for (const page of group.pages) {
      if (!Number.isInteger(page?.page) || page.page < 1) throw new CollectorError('PAGE_REF_INVALID', `${record.id} PDF 頁碼無效`);
      const key = `${rawSha.toLowerCase()}:${page.page}`;
      let packed = byPage.get(key);
      if (!packed && typeof page.text === 'string') {
        packed = await codec.packKccV2PdfPage(ctx.store.derivedStore, {
          dataset, id: record.id, source, raw_sha256: rawSha, page_number: page.page, text: page.text,
        });
        byPage.set(key, packed); pageRefs.push(packed);
      }
      if (!packed) throw new CollectorError('PAGE_REF_MISSING', `${record.id} 第 ${page.page} 頁缺少既存 PDF derived ref`);
      const clean = { ...page }; delete clean.text; cleanPages.push(clean);
    }
    assignPath(record.data, group.path, cleanPages);
  }
  const result = await codec.packKccV2Record(ctx.store.derivedStore, { dataset, record, page_refs: pageRefs });
  if (!result?.descriptor) throw new CollectorError('DESCRIPTOR_MISSING', `${record.id} KCC v2 pack 未回傳 descriptor`);
  return { descriptor: result.descriptor, page_refs: pageRefs };
}

function sourceRecordIds(rows) { return rows.map((row) => row.id); }

function batchKey(profile, scope, mother, start, end, candidates) {
  const summaries = Object.fromEntries(Object.entries(candidates).map(([dataset, value]) => [dataset, {
    snapshot_id: value.header.snapshot_id,
    record_count: value.records.length,
    descriptors_sha256: digest(value.records),
  }]));
  return digest({ profile, scope, mother, start, end, summaries }).slice(0, 48);
}

async function makeV2Candidates(ctx, stage, datasets, sourceTotal, complete) {
  const staged = await stage.readPreparedRecords();
  const candidates = {}, baseReleases = {};
  for (const dataset of datasets) {
    const active = await activeV2Release(ctx, dataset);
    const priorReceipt = stage.journal.receipts[dataset] || null;
    if (!sameV2Release(active, priorReceipt) && !(active === null && priorReceipt === null)) {
      throw new CollectorError('RELEASE_DRIFT', `${dataset} active v2 release 與 staging 已確認收據不同`);
    }
    baseReleases[dataset] = active;
    const prior = await readV2Archive(ctx, active);
    const pendingRows = staged[dataset] || [];
    const merged = new Map(prior.map((descriptor) => [descriptor.id, descriptor]));
    for (const descriptor of pendingRows) {
      if (merged.has(descriptor.id)) throw new CollectorError('SOURCE_ID_MISMATCH', `${dataset} staged descriptor 重複既有 prefix id=${descriptor.id}`);
      merged.set(descriptor.id, descriptor);
    }
    const records = [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
    const snapshotId = `kcc-v2-${digest({ dataset, scope: ctx.scope, mother: stage.journal.mother_release, end: stage.journal.prepared_cursor, records }).slice(0, 40)}`;
    const header = {
      schema_version: 'local-snapshot-v2', dataset, snapshot_id: snapshotId,
      coverage: { scope: ctx.scope, complete, source_total: sourceTotal },
      parser_version: ENRICHMENT_V2_PARSER, validator_version: ENRICHMENT_V2_VALIDATOR, validation_status: 'passed',
    };
    candidates[dataset] = { header, records };
  }
  return { candidates, baseReleases };
}

function v2ReceiptMatches(receipt, dataset, candidate) {
  return Boolean(receipt && receipt.dataset === dataset && receipt.snapshot_id === candidate.header.snapshot_id &&
    receipt.record_count === candidate.records.length && /^[a-f0-9]{64}$/i.test(receipt.manifest_sha256 || ''));
}

async function verifyV2Candidate(ctx, dataset, candidate, receipt = null) {
  const archived = await ctx.store.readSnapshotVersionV2(dataset, candidate.header.snapshot_id);
  if (archived.dataset !== dataset || archived.snapshot_id !== candidate.header.snapshot_id ||
      archived.record_count !== candidate.records.length || archived.records.length !== candidate.records.length ||
      archived.records.some((descriptor, index) => JSON.stringify(descriptor) !== JSON.stringify(candidate.records[index])) ||
      !/^[a-f0-9]{64}$/i.test(archived.manifest_sha256 || '')) {
    throw new CollectorError('READBACK_MISMATCH', `${dataset} v2 archive descriptors 原生讀回不一致`);
  }
  const active = await activeV2Release(ctx, dataset);
  if (!active || active.snapshot_id !== candidate.header.snapshot_id || active.manifest_sha256 !== archived.manifest_sha256 || active.record_count !== candidate.records.length) {
    throw new CollectorError('READBACK_MISMATCH', `${dataset} v2 active release 未指向候選 archive`);
  }
  if (receipt && (!v2ReceiptMatches(receipt, dataset, candidate) || receipt.manifest_sha256 !== archived.manifest_sha256)) {
    throw new CollectorError('RECEIPT_INVALID', `${dataset} v2 import receipt 與原生 archive 不一致`);
  }
  return receipt || {
    status: 'unchanged', schema_version: 'local-snapshot-v2', dataset,
    snapshot_id: candidate.header.snapshot_id, record_count: candidate.records.length,
    coverage: candidate.header.coverage, manifest_sha256: archived.manifest_sha256, idempotent: true,
  };
}

async function publishV2Stage(ctx, stage, datasets, sourceTotal, complete) {
  if (ctx.verifyMotherRelease) {
    const activeMother = await ctx.verifyMotherRelease();
    if (!sameRelease(activeMother, stage.journal.mother_release)) throw new CollectorError('DEPENDENCY_DRIFT', 'enrichment 發布期間母集 active release 改變，拒絕推進 cursor');
  }
  let pendingDoc = await stage.readPending();
  if (!pendingDoc) {
    const { candidates, baseReleases } = await makeV2Candidates(ctx, stage, datasets, sourceTotal, complete);
    const key = batchKey(ctx.config.profile, ctx.scope, stage.journal.mother_release, stage.journal.committed_cursor, stage.journal.prepared_cursor, candidates);
    await stage.writePending(key, candidates, baseReleases);
    pendingDoc = await stage.readPending();
  }
  const receipts = {};
  for (const dataset of datasets) {
    const candidate = pendingDoc.candidates[dataset], pendingRef = stage.journal.pending_ref;
    if (!candidate || !pendingRef) throw new CollectorError('PENDING_INVALID', `${dataset} pending candidate 缺漏`);
    const base = pendingRef.base_releases[dataset] || null;
    const active = await activeV2Release(ctx, dataset);
    const confirmed = pendingRef.confirmed[dataset];
    if (confirmed) {
      if (!sameV2Release(active, confirmed)) throw new CollectorError('RELEASE_DRIFT', `${dataset} 已確認部分發布後 active release 改變`);
      receipts[dataset] = await verifyV2Candidate(ctx, dataset, candidate, confirmed);
      continue;
    }
    const sameCandidate = active?.snapshot_id === candidate.header.snapshot_id;
    const sameBase = sameV2Release(active, base) || (!active && !base);
    if (!sameCandidate && !sameBase) throw new CollectorError('RELEASE_DRIFT', `${dataset} 發布期間 active release 漂移，拒絕覆蓋`);
    if (sameCandidate) {
      receipts[dataset] = await verifyV2Candidate(ctx, dataset, candidate);
      await stage.updatePendingDataset(dataset, { state: 'confirmed', receipt: receipts[dataset] });
      continue;
    }
    await stage.updatePendingDataset(dataset, { state: 'publishing' });
    try {
      const receipt = await ctx.store.importV2({ ...candidate.header, records: candidate.records });
      receipts[dataset] = await verifyV2Candidate(ctx, dataset, candidate, receipt);
      await stage.updatePendingDataset(dataset, { state: 'confirmed', receipt: receipts[dataset] });
    } catch (error) {
      await stage.updatePendingDataset(dataset, { state: 'unknown' }).catch(() => {});
      throw error;
    }
  }
  await stage.commitPending(receipts);
  return receipts;
}

export async function publishKccEnrichmentV2Stage(ctx, stage, datasets, sourceTotal, complete) {
  return publishV2Stage(ctx, stage, datasets, sourceTotal, complete);
}

function candidateComplete(profile, cursor, total, dependency) {
  return cursor === total && dependency?.coverage?.complete === true && profile !== 'kcc-meeting-records';
}

async function captureAndPrepareDetail(ctx, stage, row, cursor) {
  const id = row.id;
  let work = await stage.readWork(id) || { id, detail: null, attachments: null, list: null, downloaded: 0, estimated_bytes: 0 };
  if (!Number.isSafeInteger(work.estimated_bytes) || work.estimated_bytes < 0) work.estimated_bytes = 0;
  if (!work.detail) {
    const url = official(row.data.detail_url.replace(/(?:%27|')$/i, ''), PROPOSAL_URL);
    if (new URL(url).pathname !== '/System/Proposal/Detail.aspx') throw new CollectorError('URL_REJECTED', '提案詳情來源必須為Detail.aspx');
    const response = await capture(ctx, url); const data = parseDetail(response.html, id, response.url);
    work.detail = { id, title: data.subject, text: [data.subject, data.explanation, data.method, data.remarks].filter(Boolean).join('\n'), data: { ...row.data, ...data }, source_url: response.url, raw_sha256: response.sha256, retrieved_at: response.retrieved_at };
    work.estimated_bytes = Buffer.byteLength(JSON.stringify(work.detail), 'utf8');
    await stage.saveWork(id, work);
  }
  if (work.attachments === null) {
    const url = `https://${KCC_HOST}/Common/GetAttachmentList.ashx?f=1&s=${id}&t=False`;
    const response = await capture(ctx, url, { headers: { Referer: work.detail.source_url, 'X-Requested-With': 'XMLHttpRequest', Cookie: [...ctx.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } });
    const actual = new URL(response.url);
    if (actual.pathname !== '/Common/GetAttachmentList.ashx' || actual.searchParams.get('s') !== id) throw new CollectorError('SOURCE_ID_MISMATCH', '附件清單來源不一致');
    work.attachments = parseAttachments(response.html, id); work.list = { source_url: response.url, raw_sha256: response.sha256, retrieved_at: response.retrieved_at };
    work.estimated_bytes += Buffer.byteLength(JSON.stringify(work.attachments), 'utf8');
    await stage.saveWork(id, work);
  }
  while (work.downloaded < work.attachments.length) {
    const attachment = work.attachments[work.downloaded];
    assertOriginalIdentity(attachment.download_url, attachment.download_url, 'Proposal', id);
    const response = await capture(ctx, attachment.download_url, { maxBytes: 64 * 1024 * 1024, headers: { Referer: work.detail.source_url } });
    assertOriginalIdentity(attachment.download_url, response.url, 'Proposal', id);
    if (!response.bytes.length || /^text\/html/i.test(response.headers?.get?.('content-type') || '')) throw new CollectorError('ATTACHMENT_CONTENT_INVALID', '附件回應不是有效原件');
    Object.assign(attachment, { raw_sha256: response.sha256, byte_length: response.bytes.length, retrieved_at: response.retrieved_at, source_url: response.url });
    work.downloaded += 1; work.estimated_bytes += response.bytes.length;
    await stage.saveWork(id, work);
  }
  const detail = structuredClone(work.detail); detail.data.attachments = work.attachments; detail.data.attachment_list_raw_sha256 = work.list.raw_sha256;
  const attachmentRecord = { id, title: `${work.detail.title} 附件清單`, text: work.attachments.map((item) => item.name).join('\n') || '官方來源明示無附件', data: { proposal_sn: id, attachments: work.attachments, total_files: work.attachments.length, attachment_originals_complete: true }, ...work.list };
  const detailPacked = await packRecordV2(ctx, 'kcc-proposal-details', detail);
  const attachmentPacked = await packRecordV2(ctx, 'kcc-proposal-attachments', attachmentRecord);
  await stage.prepareRecord({ id, cursor, descriptors: [
    { dataset: 'kcc-proposal-details', descriptor: detailPacked.descriptor },
    { dataset: 'kcc-proposal-attachments', descriptor: attachmentPacked.descriptor },
  ], estimatedBytes: Math.max(work.estimated_bytes, Buffer.byteLength(JSON.stringify(detail), 'utf8') + Buffer.byteLength(JSON.stringify(attachmentRecord), 'utf8')) });
  return work;
}

async function processMeetingVersion(ctx, stage, id, version) {
  const rawBytes = typeof ctx.store.readRawObject === 'function'
    ? await ctx.store.readRawObject(version.raw_sha256)
    : await readFile(path.join(ctx.rawDirectory, `${version.raw_sha256}.bin`));
  if (sha256Bytes(rawBytes) !== version.raw_sha256) throw new CollectorError('STAGING_COLLISION', '既存議事原件 hash 不一致');
  if (version.file_type !== 'pdf') {
    version.format_validation ||= validateNonPdfOriginal(rawBytes, version.file_type);
    version.extraction_status = 'unsupported_text_extraction'; version.text_layer_status = 'not_indexed';
    version.total_pages = null; version.pages = []; version.extraction_complete = true;
    return;
  }
  if (rawBytes.subarray(0, 5).toString() !== '%PDF-') throw new CollectorError('PDF_SIGNATURE_INVALID', '官方回應沒有PDF檔頭');
  if (version.extraction_complete) return;
  const codec = await loadV2Codec(ctx);
  const extraction = validatePdfExtraction(await ctx.pdfExtractor(rawBytes));
  version.total_pages = extraction.total_pages;
  version.empty_text_pages = extraction.empty_text_pages;
  version.text_layer_status = extraction.text_layer_status;
  version.speaker_attribution = 'not-inferred';
  version.pages = [];
  version.page_refs = [];
  version.estimated_page_bytes = 0;
  for (const page of extraction.pages) {
    const packed = await codec.packKccV2PdfPage(ctx.store.derivedStore, {
      dataset: 'kcc-meeting-records', id, source: version.source_url, raw_sha256: version.raw_sha256, page_number: page.page, text: page.text,
    });
    version.pages.push({ page: page.page, has_text_layer: page.has_text_layer });
    version.page_refs.push(packed);
    version.estimated_page_bytes = (version.estimated_page_bytes || 0) + Buffer.byteLength(page.text, 'utf8');
    await stage.saveWork(id, stage.currentWork);
  }
  version.extraction_status = 'indexed'; version.extraction_complete = true;
}

async function captureAndPrepareMeeting(ctx, stage, row, cursor) {
  const id = row.id;
  let work = await stage.readWork(id) || { id, versions: [], page_refs: [], estimated_bytes: 0 };
  const files = row.data.original_files || (row.data.pdf_urls || [row.data.pdf_url]).filter(Boolean).map((url) => ({ download_url: url, file_type: 'pdf' }));
  for (const file of files) {
    const url = official(file.download_url, MEETING_URL);
    if (work.versions.some((version) => (version.source_url || version.pdf_url) === url)) continue;
    assertOriginalIdentity(url, url, 'MeetingRecord', id);
    const response = await capture(ctx, url, { maxBytes: 96 * 1024 * 1024 });
    assertOriginalIdentity(url, response.url, 'MeetingRecord', id);
    const isPdf = file.file_type === 'pdf';
    if (!isPdf) validateNonPdfOriginal(response.bytes, file.file_type, response.headers?.get?.('content-type') || '');
    const version = {
      source_url: response.url, download_url: url, ...(isPdf ? { pdf_url: response.url } : {}),
      file_type: file.file_type, raw_sha256: response.sha256, retrieved_at: response.retrieved_at,
      byte_length: response.bytes.length, pages: [], extraction_complete: false,
    };
    work.versions.push(version);
    await stage.saveWork(id, work);
  }
  stage.currentWork = work;
  for (const version of work.versions) {
    if (version.extraction_complete) continue;
    await processMeetingVersion(ctx, stage, id, version);
    if (version.page_refs) work.page_refs.push(...version.page_refs);
    await stage.saveWork(id, work);
  }
  work.estimated_bytes = Buffer.byteLength(JSON.stringify(row.data), 'utf8') + work.versions.reduce((total, version) => total + (version.estimated_page_bytes || version.byte_length || 0), 0);
  delete stage.currentWork;
  const pdfs = work.versions.filter((version) => version.pdf_url), selected = pdfs.at(-1), original = selected || work.versions.at(-1);
  const unindexed = work.versions.filter((version) => !version.pdf_url || version.text_layer_status !== 'present').length;
  const contentStatus = selected ? (unindexed ? 'partial_text_layer' : 'indexed') : work.versions.length ? 'unindexed_non_pdf' : 'no_original_published';
  const data = {
    ...row.data,
    ...(selected || {}),
    record_id: id, pdf_url: selected?.pdf_url || null,
    pages: selected?.pages || [], total_pages: selected?.total_pages ?? null,
    pdf_versions: pdfs, original_versions: work.versions,
    originals_complete: true, pdf_originals_complete: true,
    content_index_status: contentStatus, fulltext_complete: contentStatus === 'indexed',
    unindexed_original_count: unindexed, selected_version_policy: 'last-official-listed-pdf', speaker_attribution: 'not-inferred',
  };
  const record = {
    id, title: row.title,
    text: selected ? '' : (work.versions.length ? '官方原件已保存；此列無已索引PDF文字，尚未處理非PDF文字。' : '官方索引列未發布原件，沒有可索引文字。'),
    ...(selected ? { text_recipe: { kind: 'page-join', slot: 'data.pages', separator: '\n' } } : {}),
    data, source_url: original?.source_url || original?.pdf_url || row.source_url,
    retrieved_at: original?.retrieved_at || row.retrieved_at,
    raw_sha256: original?.raw_sha256 || row.raw_sha256,
  };
  const packed = await packRecordV2(ctx, 'kcc-meeting-records', record, work.page_refs);
  await stage.prepareRecord({ id, cursor, descriptors: [{ dataset: 'kcc-meeting-records', descriptor: packed.descriptor }], estimatedBytes: Math.max(work.estimated_bytes, Buffer.byteLength(JSON.stringify(record), 'utf8')), contentIndexed: contentStatus === 'indexed' });
  return { record, content_complete: contentStatus === 'indexed' };
}

function enrichedStatus(error, cursor, total, complete) {
  if (error && error.code !== 'COLLECTION_YIELD') return 'blocked';
  if (cursor < total) return 'paused';
  return complete ? 'complete' : 'partial';
}

async function migrateLegacyEnrichment(ctx, stage, legacy, rows, datasets) {
  if (!legacy || stage.journal.committed_cursor > 0) return;
  if (legacy.version !== VERSION || legacy.scope !== ctx.scope || !legacy.dependency ||
      legacy.source_ids?.length !== rows.length || legacy.source_ids.some((id, index) => id !== rows[index].id) ||
      !Number.isSafeInteger(legacy.cursor) || legacy.cursor < 0 || legacy.cursor > rows.length) {
    throw new CollectorError('CHECKPOINT_MISMATCH', '舊 enrichment checkpoint 的母集或 scope 無法確認，拒絕遷移與重抓');
  }
  if (!sameRelease(legacy.dependency, stage.journal.mother_release)) throw new CollectorError('DEPENDENCY_DRIFT', '舊 checkpoint 母集 release 已改變，拒絕遷移');
  const legacyCtx = { ...ctx, state: legacy };
  await assertActiveReceipts(legacyCtx, legacy.receipts || {});
  if (stage.journal.prepared_cursor > legacy.cursor) throw new CollectorError('CHECKPOINT_MIGRATION_INCOMPLETE', 'stage prepared cursor 超過舊 checkpoint 已確認 cursor');
  for (let cursor = stage.journal.prepared_cursor; cursor < legacy.cursor; cursor += 1) {
    const id = rows[cursor].id;
    const descriptors = [];
    for (const dataset of datasets) {
      const record = legacy.records?.[dataset]?.[id];
      if (!record) throw new CollectorError('CHECKPOINT_MIGRATION_INCOMPLETE', `舊 checkpoint 已確認 cursor=${legacy.cursor}，但 ${dataset}/${id} 記錄缺漏`);
      const packed = await packRecordV2(ctx, dataset, record);
      descriptors.push({ dataset, descriptor: packed.descriptor });
    }
    const estimatedBytes = descriptors.reduce((totalBytes, entry) => totalBytes + Buffer.byteLength(JSON.stringify(entry.descriptor), 'utf8'), 0);
    const indexed = ctx.config.profile !== 'kcc-meeting-records' || contentIndexed(legacy.records?.['kcc-meeting-records']?.[id]);
    await stage.prepareRecord({ id, cursor, descriptors, estimatedBytes, contentIndexed: indexed });
  }
  if (legacy.work && legacy.cursor < rows.length) {
    const id = rows[legacy.cursor].id;
    if (legacy.work.id !== id) throw new CollectorError('CHECKPOINT_MIGRATION_INCOMPLETE', '舊 checkpoint 未提交 work 與母集 cursor 身分不符');
    // A crash after importing the legacy work may already have advanced the
    // v2 work. Preserve that durable work rather than overwriting it on resume.
    if (!await stage.readWork(id)) {
      const work = structuredClone(legacy.work);
      if (Array.isArray(work.versions)) {
        const codec = await loadV2Codec(ctx), allPageRefs = [];
        work.estimated_bytes ||= 0;
        for (const version of work.versions) {
          const pages = version.pages || [], pageRefs = [];
          const rawSha = version.raw_sha256, source = version.source_url || version.pdf_url || version.download_url;
          for (const page of pages) {
            if (typeof page.text !== 'string') throw new CollectorError('CHECKPOINT_MIGRATION_INCOMPLETE', `舊 work ${id} 頁面缺少正文或 ref，無法安全遷移`);
            const packed = await codec.packKccV2PdfPage(ctx.store.derivedStore, { dataset: 'kcc-meeting-records', id, source, raw_sha256: rawSha, page_number: page.page, text: page.text });
            pageRefs.push(packed); allPageRefs.push(packed); work.estimated_bytes += Buffer.byteLength(page.text, 'utf8');
          }
          version.pages = pages.map(({ text, ...page }) => page);
          if (pages.length) { version.page_refs = pageRefs; version.extraction_complete = pages.length === version.total_pages; }
        }
        work.page_refs = allPageRefs;
      }
      await stage.saveWork(id, work);
    }
  } else if (legacy.work && legacy.cursor >= rows.length) {
    throw new CollectorError('CHECKPOINT_MIGRATION_INCOMPLETE', '舊 checkpoint cursor 已終止但仍有未提交 work');
  }
  if (legacy.cursor > 0) {
    const terminal = legacy.cursor === rows.length;
    const complete = ctx.config.profile === 'kcc-meeting-records'
      ? terminal && sourceComplete(legacy) && allContentIndexed(legacy)
      : terminal && sourceComplete(legacy);
    const imported = await publishV2Stage(ctx, stage, datasets, rows.length, complete);
    if (stage.journal.committed_cursor !== legacy.cursor) throw new CollectorError('CHECKPOINT_MIGRATION_FAILED', '舊 checkpoint 等價 v2 發布未推進到原 cursor');
    for (const [dataset, receipt] of Object.entries(imported)) ctx.migratedReceipts[dataset] = receipt;
  }
  await stage.markLegacyMigrated(digest(legacy), legacy.cursor);
}

async function runEnrichmentV2Profile(ctx, stage, rows, sourceRelease, dependencies = {}) {
  const datasets = ctx.config.profile === 'kcc-proposal-details'
    ? ['kcc-proposal-details', 'kcc-proposal-attachments']
    : ['kcc-meeting-records'];
  const legacy = stage.journal.legacy_migration?.schema_version === 'kcc-legacy-migration-v1'
    ? null : await jsonRead(ctx.legacyStatePath, null);
  await migrateLegacyEnrichment(ctx, stage, legacy, rows, datasets);
  await stage.readMotherIds();
  const total = rows.length;
  let flushes = 0, error = null;
  const shouldFlush = (terminal) => enrichmentBatchReady(ctx.config.profile, stage.journal.batch_refs.length, stage.journal.batch_bytes, terminal);
  try {
    if (stage.journal.prepared_cursor > stage.journal.committed_cursor && shouldFlush(stage.journal.prepared_cursor === total)) {
      const fulltextComplete = ctx.config.profile !== 'kcc-meeting-records' || stage.journal.all_content_indexed;
      await publishV2Stage(ctx, stage, datasets, total, stage.journal.prepared_cursor === total && sourceComplete({ dependency: sourceRelease }) && fulltextComplete);
      flushes += 1;
    }
    for (let cursor = stage.journal.prepared_cursor; cursor < total; cursor = stage.journal.prepared_cursor) {
      if (flushes >= 1 && shouldFlush(cursor === total)) throw pause();
      if (cursor !== stage.journal.prepared_cursor) throw new CollectorError('PREPARED_CURSOR_INVALID', 'prepared cursor 與來源位置失配');
      const row = rows[cursor];
      if (ctx.config.profile === 'kcc-proposal-details') {
        await captureAndPrepareDetail(ctx, stage, row, cursor);
      } else {
        await captureAndPrepareMeeting(ctx, stage, row, cursor);
      }
      ctx.pages += 1;
      const terminal = stage.journal.prepared_cursor === total;
      if (shouldFlush(terminal)) {
        if (flushes >= 1) throw pause();
        const fulltextComplete = ctx.config.profile !== 'kcc-meeting-records' || stage.journal.all_content_indexed;
        const complete = terminal && sourceComplete({ dependency: sourceRelease }) && fulltextComplete;
        await publishV2Stage(ctx, stage, datasets, total, complete);
        flushes += 1;
      }
      if (ctx.requests >= ctx.config.maxRequests || ctx.now() - ctx.started >= ctx.config.maxDurationMs) throw pause();
    }
  } catch (caught) { error = caught; }
  if (!error && stage.journal.prepared_cursor === total && stage.journal.batch_refs.length) {
    if (flushes >= 1) error = pause();
    else {
      const complete = sourceComplete({ dependency: sourceRelease }) && (ctx.config.profile !== 'kcc-meeting-records' || stage.journal.all_content_indexed);
      try { await publishV2Stage(ctx, stage, datasets, total, complete); flushes += 1; }
      catch (caught) { error = caught; }
    }
  }
  const blocked = Boolean(error && error.code !== 'COLLECTION_YIELD');
  const receipts = { ...stage.journal.receipts, ...(stage.journal.pending_ref?.confirmed || {}) };
  const confirmedAll = datasets.every((dataset) => Boolean(stage.journal.receipts[dataset]));
  const fulltextComplete = ctx.config.profile !== 'kcc-meeting-records' || stage.journal.all_content_indexed;
  const complete = !blocked && stage.journal.committed_cursor === total && sourceComplete({ dependency: sourceRelease }) && fulltextComplete;
  const status = enrichedStatus(error, stage.journal.committed_cursor, total, complete);
  const publishedReceipt = receipts[datasets[0]] || null;
  return {
    profile: ctx.config.profile, dataset: datasets[0], status,
    continuation_required: !blocked && (stage.journal.prepared_cursor < total || stage.journal.committed_cursor < total),
    source_exhausted: stage.journal.prepared_cursor === total,
    ...(ctx.config.profile === 'kcc-meeting-records' ? { archive_complete: !blocked && stage.journal.committed_cursor === total && sourceComplete({ dependency: sourceRelease }), fulltext_complete: complete } : {}),
    dry_run: false,
    commit_state: stage.journal.pending_ref ? (Object.keys(stage.journal.pending_ref.confirmed || {}).length ? 'partial' : 'unknown') : confirmedAll ? 'committed' : 'not-committed',
    publication_status: stage.journal.pending_ref ? (Object.keys(stage.journal.pending_ref.confirmed || {}).length ? 'partial' : 'unknown') : confirmedAll ? 'confirmed' : 'not-started',
    uncertain_datasets: Object.entries(stage.journal.pending_ref?.states || {}).filter(([, state]) => ['publishing', 'unknown'].includes(state)).map(([dataset]) => dataset),
    needs_reconciliation: Boolean(stage.journal.pending_ref && Object.keys(stage.journal.pending_ref.states || {}).some((dataset) => ['publishing', 'unknown'].includes(stage.journal.pending_ref.states[dataset])) || error?.code === 'RELEASE_DRIFT'),
    record_count: publishedReceipt?.record_count ?? 0,
    prepared_count: stage.journal.prepared_cursor,
    attempted: ctx.requests, succeeded: ctx.pages, failed: blocked ? 1 : 0,
    error_code: blocked ? (error.code || error.reasonCode || 'COLLECTION_FAILED') : null,
    error_message: blocked ? String(error.message).slice(0, 500) : null,
    coverage: { scope: ctx.scope, complete, source_total: total },
    checkpoint_path: stage.journalPath, checkpoint_status: 'persisted',
    receipts, receipt: publishedReceipt,
    progress: { committed_cursor: stage.journal.committed_cursor, prepared_cursor: stage.journal.prepared_cursor, total, current_id: stage.journal.work_ref?.id || null, batch_records: stage.journal.batch_refs.length, batch_bytes: stage.journal.batch_bytes },
    basic_validation: blocked ? 'not-passed' : 'passed', human_semantic_validation: 'pending',
  };
}

export async function runKccEnrichmentV2(options = {}, dependencies = {}) {
  const config = normalizeOptions(options);
  if (!['kcc-proposal-details', 'kcc-meeting-records'].includes(config.profile)) throw new CollectorError('PROFILE_INVALID', 'v2 enrichment 僅適用提案詳情或議事錄');
  const root = path.resolve(options.root), scope = JSON.stringify({ profile: config.profile, periods: config.periods, sessions: config.sessions, keyword: config.keyword, pageSize: config.pageSize });
  const directory = await safeDirectory(root, ['.kcc-collection', config.profile, digest(scope).slice(0, 24)]);
  const stageDirectory = await safeDirectory(directory, ['enrichment-v2']);
  const lockPath = path.join(root, '.kcc-collection', 'collector.lock'); let lockAcquired = false, store, stage = null, error = null, result = null;
  const now = dependencies.now || Date.now, sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ctx = {
    config, scope, directory, rawDirectory: await safeDirectory(root, ['.kcc-collection', 'raw']),
    captureDirectory: await safeDirectory(root, ['.kcc-collection', 'captures']),
    legacyStatePath: path.join(directory, 'checkpoint.json'), now, sleep, started: now(), requests: 0, pages: 0,
    cookies: new Map(), fetchImpl: dependencies.fetchImpl || fetch, pdfExtractor: dependencies.pdfExtractor || extractPdfPages,
    v2Codec: dependencies.v2Codec || null, migratedReceipts: {},
  };
  try {
    try { await writeFile(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date(now()).toISOString() }), { flag: 'wx', mode: 0o600 }); lockAcquired = true; }
    catch (caught) { if (caught.code === 'EEXIST') throw new CollectorError('COLLECTION_LOCKED', '同scope已有採集鎖；確認原程序終止後才可移除鎖'); throw caught; }
    const factory = dependencies.storeFactory || (async (location) => { const { LocalStore } = await import('../local/store.mjs'); return new LocalStore(location, { readOnly: false }); });
    store = await factory(root); ctx.store = store;
    if (typeof store.putRawObject !== 'function' || typeof store.importV2 !== 'function' || typeof store.queryV2 !== 'function' || typeof store.readSnapshotVersionV2 !== 'function') throw new CollectorError('STORE_API_UNAVAILABLE', 'LocalStore enrichment v2 API 尚未完整提供');
    const sourceDataset = config.profile === 'kcc-proposal-details' ? 'kcc-proposals' : 'kcc-meetings';
    const source = await readAll(store, sourceDataset);
    stage = await KccEnrichmentStage.open({ directory: stageDirectory, scope, profile: config.profile, motherRelease: source.release, sourceIds: sourceRecordIds(source.rows) });
    ctx.verifyMotherRelease = () => activeRelease(ctx, sourceDataset);
    let lastStart = -Infinity;
    ctx.rateLimiter = async () => { const wait = Math.max(0, 1000 - (now() - lastStart)); if (wait) await sleep(wait); lastStart = now(); };
    result = await runEnrichmentV2Profile(ctx, stage, source.rows, source.release, dependencies);
  } catch (caught) { error = caught; }
  finally { if (store?.close) store.close(); if (lockAcquired) await unlink(lockPath); }
  if (result) return { ...result, ...(Object.keys(ctx.migratedReceipts).length ? { migration_receipts: ctx.migratedReceipts } : {}) };
  const code = error?.code || error?.reasonCode || 'COLLECTION_FAILED';
  const stagedReceipts = { ...(stage?.journal?.receipts || {}), ...(stage?.journal?.pending_ref?.confirmed || {}) };
  const dataset = KCC_PROFILE_MANIFEST[config.profile].dataset;
  return {
    profile: config.profile, dataset,
    status: code === 'COLLECTION_YIELD' ? 'paused' : 'blocked', continuation_required: code === 'COLLECTION_YIELD',
    source_exhausted: false, dry_run: false, commit_state: 'unknown', publication_status: 'unknown',
    record_count: stagedReceipts[dataset]?.record_count ?? 0, prepared_count: stage?.journal?.prepared_cursor ?? 0, attempted: ctx.requests, succeeded: ctx.pages, failed: code === 'COLLECTION_YIELD' ? 0 : 1,
    error_code: code === 'COLLECTION_YIELD' ? null : code, error_message: code === 'COLLECTION_YIELD' ? null : String(error?.message || code).slice(0, 500),
    coverage: { scope, complete: false, source_total: stage?.journal?.mother_release?.record_count ?? null }, checkpoint_path: path.join(stageDirectory, 'journal.json'),
    checkpoint_status: stage ? 'persisted' : 'not-created', receipts: stagedReceipts, receipt: stagedReceipts[dataset] || null,
    progress: { committed_cursor: stage?.journal?.committed_cursor ?? 0, prepared_cursor: stage?.journal?.prepared_cursor ?? 0, total: stage?.journal?.mother_release?.record_count ?? null, current_id: stage?.journal?.work_ref?.id ?? null, batch_records: stage?.journal?.batch_refs?.length ?? 0, batch_bytes: stage?.journal?.batch_bytes ?? 0 },
    basic_validation: code === 'COLLECTION_YIELD' ? 'passed' : 'not-passed', human_semantic_validation: 'pending',
  };
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
  const complete=Boolean(!blocked&&exhausted&&(indexProfile||sourceComplete(state))&&(config.profile!=='kcc-meeting-records'||allContentIndexed(state)));
  const dataset=KCC_PROFILE_MANIFEST[config.profile].dataset;
  const pending = ctx.pendingPublication;
  const receipts = {...state?.receipts,...pending?.confirmed_receipts};
  const uncertainDatasets = Object.entries(pending?.publication_states || {}).filter(([,status])=>status==='publishing'||status==='unknown').map(([name])=>name);
  const commitState = uncertainDatasets.length ? 'unknown' : pending && Object.keys(pending.confirmed_receipts || {}).length ? 'partial' : Object.keys(receipts).length ? 'committed' : 'not-committed';
  return { profile:config.profile,dataset,status:blocked?'blocked':exhausted?(complete?'complete':'partial'):'paused',continuation_required:!blocked&&!exhausted,source_exhausted:Boolean(exhausted),...(config.profile==='kcc-meeting-records'?{archive_complete:Boolean(!blocked&&exhausted&&sourceComplete(state)),fulltext_complete:complete,unindexed_records:Object.values(state?.records?.['kcc-meeting-records']||{}).filter((record)=>!contentIndexed(record)).length}:{}),dry_run:false,commit_state:commitState,publication_status:pending&&Object.keys(pending.confirmed_receipts||{}).length?'partial':uncertainDatasets.length?'unknown':'confirmed',uncertain_datasets:uncertainDatasets,needs_reconciliation:Boolean(uncertainDatasets.length||error?.code==='RELEASE_DRIFT'),record_count:receipts[dataset]?.record_count??Object.keys(state?.records?.[dataset]||{}).length,attempted:ctx.requests,succeeded:ctx.pages,failed:blocked?1:0,error_code:blocked?(error.code||error.reasonCode||'COLLECTION_FAILED'):null,error_message:blocked?String(error.message).slice(0,500):null,coverage:state?coverage(state,complete,indexProfile?totals.sourceTotal:state.source_ids?.length??null):{scope,complete:false,source_total:null},checkpoint_path:ctx.statePath,checkpoint_status:state?'persisted':'not-created',receipts,receipt:receipts[dataset]||null,source_discovery:state?.discovery||null,progress:indexProfile?{queries:Object.fromEntries(Object.entries(state?.queries||{}).map(([key,q])=>[key,{complete:q.complete,tabs:Object.fromEntries(Object.entries(q.tabs).map(([id,t])=>[id,{total:t.total,next_page:t.next_page,collected_ids:t.ids.length,collected_pages:t.pages_proof.length,complete:t.complete,last_page:t.pages_proof.at(-1)||null,reconciliation:t.reconciliation||null}]))}])),source_total_estimate:totals.sourceTotal,discovered_total_so_far:totals.tabs.reduce((n,t)=>n+t.total,0)}:{cursor:state?.cursor??0,total:state?.source_ids?.length??null,current_id:state?.work?.id??null,dependency:state?.dependency||null},basic_validation:blocked?'not-passed':'passed',human_semantic_validation:'pending' };
}

// Explicit legacy entry point retained for callers that are still validating
// the v1 enrichment path. Production dispatch chooses runKccEnrichmentV2.
export const runKccCollectionV1 = runKccCollection;
