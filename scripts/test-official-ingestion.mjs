import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, realpath, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runOfficialCollection, parseOfficialLaw, parseOfficialNews } from "../src/ingestion/official-collection.mjs";
import { LocalStore } from "../src/local/store.mjs";

// These are deliberately synthetic structural fixtures. They exercise the
// parser/transaction boundaries and provide NO evidence about live source facts.
const NEWS = "https://www.kcg.gov.tw/News.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D";
const CITY = "https://www.kcg.gov.tw/CityNews1.aspx?n=3A379BB94CA5F12D";
const ids = ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC"];
const url = (id) => `https://www.kcg.gov.tw/News_Content.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D&s=${id}`;
const index = (items, next, total = 3) => `<table>${items.map((i) => `<tr><td><a href="${url(ids[i])}">測試新聞${i}</a></td><td>測試機關</td><td>115-10-15</td></tr>`).join("")}</table><p>共${total}筆</p>${next ? `<a href="${NEWS}&page=2">下一頁</a>` : ""}`;
const detail = (i, extra = "") => `<meta name="DC.Subject" content="測試新聞${i}"><form action="${url(ids[i])}"><div id="data_midlle"><li><span>發布機關：</span>測試機關</li><li><span>發布日期：</span>115-10-15</li><div class="data_midlle_news_box02"><p>測試正文${i} &amp; 原件內容。</p>${extra}</div></div></form>`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const base = await realpath(await mkdtemp(path.join(tmpdir(), "official-ingestion-test-")));
let passed = 0;
async function test(name, work) { await work(); passed++; console.log(`PASS ${name}`); }
const makeDeps = (overrides = {}) => {
  let instant = 10000;
  const requests = [], delays = [];
  return { requests, delays, now: () => instant, sleep: async (ms) => { delays.push(ms); instant += ms; }, fetchImpl: async (input, options) => {
    const address = String(input); requests.push(address);
    assert.equal(options.redirect, "manual"); assert.ok(options.signal);
    if (overrides[address] !== undefined) return typeof overrides[address] === "function" ? overrides[address]() : new Response(overrides[address], { headers: { "content-type": "text/html; charset=utf-8" } });
    if (address === NEWS) return new Response(index([0, 1], true));
    if (address === CITY) return new Response('<p>共0筆</p><span id="ContentPlaceHolder1_lblPageCount">1/1</span>');
    if (address === NEWS + "&page=2") return new Response(index([2], false));
    const i = ids.findIndex((id) => address === url(id));
    if (i >= 0) return new Response(detail(i));
    throw new Error("Unexpected fixture URL: " + address);
  } };
};
function lawFixture({ styles = ['relative'], externalCategory = false, externalAttachment = false, unknownCategory = false, unknownAttachment = false } = {}) {
  const origin = 'https://outlaw.kcg.gov.tw'; let instant = 10000; const requests = [];
  const href = (route, style) => style === 'absolute' ? origin + '/' + route : style === 'root-relative' ? '/' + route : route;
  return { requests, now: () => instant, sleep: async (ms) => { instant += ms; }, fetchImpl: async (input) => {
    const address = String(input); requests.push(address); const parsed = new URL(address);
    if (parsed.pathname === '/LawCategoryMain.aspx') return new Response(`<ul id="ctl00_cp_content_ulLawCategoryMobile">${styles.map((style, i) => `<a href="${externalCategory && i === styles.length - 1 ? 'https://example.com/LawCategoryContentList.aspx?CategoryID=35' : unknownCategory ? 'UnknownCategory.aspx?CategoryID=34' : href('LawCategoryContentList.aspx?CategoryID=' + (34 + i), style)}">測試分類${i}</a>`).join('')}</ul>`);
    if (parsed.pathname === '/LawCategoryContentList.aspx') { const i = Number(parsed.searchParams.get('CategoryID')) - 34; return new Response(`<table><tr><td><a href="LawContent.aspx?id=GL99999${i}">測試法規${i}</a></td></tr></table>共1筆`); }
    const i = Number((parsed.searchParams.get('id') || '').slice(-1)); const lawId = `GL99999${i}`, title = `測試法規${i}`;
    const header = `<table><tr><th>法規名稱：</th><td>${title}</td></tr><tr><th>公發布日：</th><td>民國115年10月15日</td></tr><tr><th>法規體系：</th><td>測試機關</td></tr></table>`;
    if (parsed.pathname === '/LawContent.aspx') {
      const link = externalAttachment ? `https://example.com/Download.ashx?FileID=${i + 1}&id=${lawId}&type=LAW` : unknownAttachment ? 'UnknownDownload.aspx?id=' + lawId : href(`Download.ashx?FileID=${i + 1}&id=${lawId}&type=LAW`, styles[i]);
      return new Response(`<form action="LawContent.aspx?id=${lawId}">${header}<table><tr><th>圖表附件：</th><td><a href="${link}">測試附件.pdf</a></td></tr></table><div id="ctl00_cp_content_divContent">第一條 測試條文${i}。</div></form>`);
    }
    if (parsed.pathname === '/LawContentSource.aspx') return new Response(`<form action="LawContentSource.aspx?id=${lawId}">${header}<div id="ctl00_cp_content_divLawContentSource">測試沿革${i}</div></form>`);
    if (parsed.pathname === '/Download.ashx') return new Response(`%PDF-1.7\nfixture ${i}\n%%EOF`, { headers: { 'content-type': 'application/pdf' } });
    throw new Error('unexpected law proof fixture URL');
  } };
}
async function finishLaw(root, deps) {
  let result;
  for (let i = 0; i < 5; i++) { result = await runOfficialCollection({ profile: 'kcg-laws', root, maxRequests: 20 }, deps); if (result.status !== 'paused') return result; }
  assert.fail('fixture law collection did not finish');
}
try {
  await test("三段續作累積資料，來源窮盡且總數相符才完整", async () => {
    const root = path.join(base, "resume"), deps = makeDeps();
    const first = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 2, maxPages: 1 }, deps);
    assert.equal(first.status, "paused", JSON.stringify(first)); assert.equal(first.continuation_required, true); assert.equal(first.record_count, 1); assert.equal(first.coverage.complete, false);
    const second = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 2, maxPages: 1 }, deps);
    assert.equal(second.record_count, 2); assert.equal(second.run_id, first.run_id); assert.equal(second.status, "paused");
    const third = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 2, maxPages: 1 }, deps);
    assert.equal(third.status, "complete"); assert.equal(third.record_count, 3); assert.equal(third.coverage.source_total, 3);
    assert.equal(third.continuation_required, false);
    const store = new LocalStore(root); const found = await store.queryRecords("kcg-news", { limit: 10 });
    assert.equal(found.records.length, 3); assert.equal(found.records[0].id, 'messages:' + ids[0]); assert.equal(found.records[0].data.source_kind, 'messages'); assert.equal(found.records[0].data.content, "測試正文0 & 原件內容。"); store.close();
    assert.equal(new Set(deps.requests).size, deps.requests.length, "checkpoint原件不可重送");
    assert.equal(deps.delays.length, deps.requests.length - 1, "跨段也保持1秒節流");
    assert.ok(deps.delays.every((ms) => ms >= 1000));
  });
  await test("解析失敗仍先保存原件，不匯入不合身分資料", async () => {
    const root = path.join(base, "identity"), deps = makeDeps({ [url(ids[0])]: detail(0).replace('content="測試新聞0"', 'content="錯誤標題"') });
    const result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 2 }, deps);
    assert.equal(result.status, "blocked"); assert.equal(result.error_code, "SOURCE_ID_MISMATCH"); assert.equal(result.receipt, null);
    const checkpoint = JSON.parse(await readFile(result.checkpoint_path, "utf8")).state;
    const capture = checkpoint.captures[url(ids[0])];
    const bytes = await readFile(path.join(root, "raw", "sha256", capture.sha256.slice(0, 2), capture.sha256));
    assert.equal(digest(bytes), capture.sha256); assert.ok(capture.retrieved_at); assert.equal(capture.url, url(ids[0]));
    const store = new LocalStore(root); assert.equal(await store.hasDataset("kcg-news"), false); store.close();
  });
  await test("每一跳redirect限官方HTTPS", async () => {
    const root = path.join(base, "redirect"), deps = makeDeps({ [NEWS]: () => new Response("", { status: 302, headers: { location: "https://example.com/blocked" } }) });
    const result = await runOfficialCollection({ profile: "kcg-news", root }, deps);
    assert.equal(result.error_code, "URL_REJECTED"); assert.equal(deps.requests.length, 1);
  });
  await test("來源總數變動停止，不覆蓋已發布前段", async () => {
    const root = path.join(base, "drift"), deps = makeDeps({ [NEWS + "&page=2"]: index([2], false, 4) });
    const first = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 2, maxPages: 1 }, deps);
    const second = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 2, maxPages: 1 }, deps);
    const next = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 2, maxPages: 1 }, deps);
    assert.equal(next.error_code, "SOURCE_DRIFT"); assert.equal(next.receipt, null);
    const store = new LocalStore(root); assert.equal((await store.queryRecords("kcg-news", { limit: 10 })).release.snapshot_id, second.receipt.snapshot_id); store.close();
  });
  await test("byte上限拒絕超大原件", async () => {
    const result = await runOfficialCollection({ profile: "kcg-news", root: path.join(base, "bytes"), maxBytes: 20 }, makeDeps());
    assert.equal(result.error_code, "BYTE_LIMIT"); assert.equal(result.record_count, 0);
  });
  await test("法規沿革身分、完整條文與內文引用區隔", async () => {
    const lawUrl = "https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL999999";
    const historyUrl = "https://outlaw.kcg.gov.tw/LawContentSource.aspx?id=GL999999";
    const header = `<table><tr><th>法規名稱：</th><td>測試法規</td></tr><tr><th>公發布日：</th><td>民國115年10月15日</td></tr><tr><th>法規體系：</th><td>測試機關</td></tr></table>`;
    const law = { url: lawUrl, bytes: Buffer.from(`<form action="${lawUrl}">${header}<div id="ctl00_cp_content_divContent"><strong>第一條</strong> 測試正文。<br>第<strong>二條</strong> 依第一條規定辦理。<br>第二<strong>十八條　</strong> 分散標籤條號。</div></form>`) };
    const history = { url: historyUrl, sha256: "f".repeat(64), bytes: Buffer.from(`<form action="${historyUrl}">${header}<div id="ctl00_cp_content_divLawContentSource">測試沿革</div></form>`) };
    const parsed = parseOfficialLaw(law, history, { title: "測試法規" });
    assert.equal(parsed.articles.length, 3); assert.equal(parsed.articles[1].content, "依第一條規定辦理。"); assert.equal(parsed.articles[2].article_no, "第二十八條"); assert.equal(parsed.history, "測試沿革");
    assert.throws(() => parseOfficialLaw(law, { ...history, url: historyUrl.replace("999999", "999998") }, { title: "測試法規" }), /沿革身分不一致/);
  });
  await test("廢停法規展示badge與真正名稱分離並保留官方停止適用日期", async () => {
    const url = 'https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL001565', historyUrl = 'https://outlaw.kcg.gov.tw/LawContentSource.aspx?id=GL001565';
    const name = '高雄市政府所屬各機關購置公務車輛作業要點';
    const badge = '<span id="ctl00_cp_content_lawheader1_spanCauseCode" class="label-fei">廢/停</span>';
    const header = `<table><tr><th>法規名稱：</th><td>${badge}${name}</td></tr><tr><th>公發布日：</th><td>民國101年05月08日</td></tr><tr><th>廢止/停止適用日期：</th><td>民國107年12月31日</td></tr><tr><th>法規體系：</th><td>行政暨國際處</td></tr></table>`;
    const detail = { url, bytes: Buffer.from(`<form action="${url}">${header}<div id="ctl00_cp_content_divContent">一、測試完整正文。</div></form>`) };
    const history = { url: historyUrl, sha256: 'a'.repeat(64), bytes: Buffer.from(`<form action="${historyUrl}">${header}<div id="ctl00_cp_content_divLawContentSource">測試停止適用沿革。</div></form>`) };
    const law = parseOfficialLaw(detail, history, { title: name });
    assert.equal(law.law_name, name); assert.equal(law.status_label, '廢/停'); assert.equal(law.law_name_display_source, '廢/停' + name); assert.equal(law.repealed_or_suspended_at, '2018-12-31'); assert.equal(law.legal_effect_verified, false);
    assert.equal(law.law_record_type, 'law_text'); assert.equal(law.fulltext_complete, true);
    const noticeText = `「${name}」自中華民國107年12月31日起停止適用。`;
    const noticeDetail = { ...detail, bytes: Buffer.from(detail.bytes.toString().replace('一、測試完整正文。', noticeText)) };
    const notice = parseOfficialLaw(noticeDetail, history, { title: name });
    assert.equal(notice.law_record_type, 'repeal_notice'); assert.equal(notice.articles_unavailable, true); assert.equal(notice.fulltext_complete, false); assert.deepEqual(notice.articles, []); assert.equal(notice.notice_text, noticeText); assert.equal(notice.full_text, noticeText); assert.equal(notice.article_segmentation, 'not-applicable-repeal-notice');
    assert.throws(() => parseOfficialLaw(detail, history, { title: '不同法規名稱' }), /法規名稱與官方索引或沿革不一致/);
    const changedHistory = { ...history, bytes: Buffer.from(history.bytes.toString().replaceAll(name, '另一個法規名稱')) };
    assert.throws(() => parseOfficialLaw(detail, changedHistory, { title: name }), /法規名稱與官方索引或沿革不一致/);
    const plainPrefix = { ...detail, bytes: Buffer.from(detail.bytes.toString().replace(badge, '廢/停')) };
    assert.throws(() => parseOfficialLaw(plainPrefix, history, { title: name }), /法規名稱與官方索引或沿革不一致/);
  });
  await test("官方新聞明示空發布機關保留未知，缺欄或缺正文仍拒絕", async () => {
    const url = 'https://www.kcg.gov.tw/CityNews_Detail1.aspx?n=3A379BB94CA5F12D&ss=598182DA152F961C';
    const html = `<form action="${url}"><div class="data_midlle_news_box01"><table><tr><td>測試新聞空發布者</td></tr></table></div><div id="data_midlle"><li><span>發布日期：</span>115-10-01</li><li><span>發布機關：</span></li><div class="data_midlle_news_box02"><p>原件完整正文。</p></div></div></form>`;
    const expected = { title: '測試新聞空發布者', category: '市政新聞', published_at: '115-10-01' }, captured = (source) => ({ url, bytes: Buffer.from(source) });
    const item = parseOfficialNews(captured(html), expected);
    assert.equal(item.agency, ''); assert.equal(item.publisher, ''); assert.equal(item.publisher_status, 'not_provided'); assert.equal(item.publisher_source, 'official-detail-empty'); assert.equal(item.content, '原件完整正文。');
    const provided = parseOfficialNews(captured(html.replace('<span>發布機關：</span></li>', '<span>發布機關：</span>官方明示機關</li>')), expected);
    assert.equal(provided.publisher, '官方明示機關'); assert.equal(provided.publisher_status, 'provided'); assert.equal(provided.publisher_source, 'official-detail');
    assert.throws(() => parseOfficialNews(captured(html.replace('<li><span>發布機關：</span></li>', '')), expected), /正文、發布機關或日期缺漏/);
    assert.throws(() => parseOfficialNews(captured(html.replace('<p>原件完整正文。</p>', '')), expected), /正文、發布機關或日期缺漏/);
    assert.throws(() => parseOfficialNews(captured(html.replace('<li><span>發布日期：</span>115-10-01</li>', '')), expected), /正文、發布機關或日期缺漏/);
    assert.throws(() => parseOfficialNews(captured(html), { ...expected, agency: '索引有機關但明細為空' }), /發布資訊與官方索引不一致/);
  });
  await test("網站通用DC.Subject以正式可見標題核對，真正標題衝突仍拒絕", async () => {
    const url = 'https://www.kcg.gov.tw/News_Content.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D&s=2E98CCB38C0FDA07';
    const title = '測試正式可見標題', generic = '高雄市政府全球資訊網-中文版';
    const html = `<meta name="DC.Subject" content="${generic}"><form action="${url}"><div class="data_midlle_news_box01"><table><tr><td>${title}</td></tr></table></div><div id="data_midlle"><li>發布日期：115-08-23</li><li>發布機關：交通局</li><div class="data_midlle_news_box02"><p>測試原件正文。</p></div></div></form>`;
    const expected = { title, agency: '交通局', published_at: '115-08-23' }, captured = (source) => ({ url, bytes: Buffer.from(source) });
    const value = parseOfficialNews(captured(html), expected);
    assert.equal(value.title, title); assert.equal(value.title_source, 'official-detail-visible-title'); assert.equal(value.title_meta_subject, generic);
    const absent = parseOfficialNews(captured(html.replace(`<meta name="DC.Subject" content="${generic}">`, '')), expected);
    assert.equal(absent.title, title); assert.equal(absent.title_meta_subject, null);
    const specific = parseOfficialNews(captured(html.replace(`content="${generic}"`, `content="${title}"`)), expected);
    assert.equal(specific.title_source, 'official-detail-meta-subject');
    assert.throws(() => parseOfficialNews(captured(html.replace(`content="${generic}"`, `content="${title}"`).replace(`<td>${title}</td>`, '<td>另一個可見標題</td>')), expected), /可見標題與官方索引不一致/);
    assert.throws(() => parseOfficialNews(captured(html.replace(`content="${generic}"`, 'content="另一篇文章標題"')), expected), /標題與官方索引不一致/);
    assert.throws(() => parseOfficialNews(captured(html.replace(`<td>${title}</td>`, '<td>另一篇文章標題</td>')), expected), /標題與官方索引不一致/);
    assert.throws(() => parseOfficialNews(captured(html.replace(`<td>${title}</td>`, '<td></td>')), expected), /標題與官方索引不一致/);
    assert.throws(() => parseOfficialNews(captured(html.replaceAll('s=2E98CCB38C0FDA07', 's=AAAAAAAAAAAAAAAA')), expected), /原始 HTML form 身分/);
  });
  await test("法規附件預設保存原件，request中斷後續作不遺失", async () => {
    const root = path.join(base, "law-attachments"), lawUrl = "https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL999999", historyUrl = "https://outlaw.kcg.gov.tw/LawContentSource.aspx?id=GL999999";
    const category = "https://outlaw.kcg.gov.tw/LawCategoryContentList.aspx?CategoryID=34", attachment = "https://outlaw.kcg.gov.tw/Download.ashx?FileID=1&id=GL999999&type=LAW";
    const header = `<table><tr><th>法規名稱：</th><td>測試法規</td></tr><tr><th>公發布日：</th><td>民國115年10月15日</td></tr><tr><th>法規體系：</th><td>測試機關</td></tr></table>`;
    let instant = 10000, requests = 0;
    const deps = { now: () => instant, sleep: async (ms) => { instant += ms; }, fetchImpl: async (input) => {
      requests++; const address = String(input);
      if (address.endsWith("LawCategoryMain.aspx?type=M")) return new Response('<ul id="ctl00_cp_content_ulLawCategoryMobile"><a href="LawCategoryContentList.aspx?CategoryID=34">測試分類</a></ul>');
      if (address === category) return new Response(`<table><tr><td><a href="${lawUrl}">測試法規</a></td></tr></table>共1筆`);
      if (address === lawUrl) return new Response(`<form action="${lawUrl}">${header}<a href="Download.ashx?FileID=1&id=GL999999&type=LAW">測試附件.pdf</a><div id="ctl00_cp_content_divContent">第一條 測試條文。</div></form>`);
      if (address === historyUrl) return new Response(`<form action="${historyUrl}">${header}<div id="ctl00_cp_content_divLawContentSource">測試沿革</div></form>`);
      if (address === attachment) return new Response('%PDF-1.7\nfixture only\n%%EOF', { headers: { 'content-type': 'application/pdf' } });
      throw new Error("unexpected law fixture URL");
    } };
    const first = await runOfficialCollection({ profile: "kcg-laws", root, maxRequests: 4 }, deps);
    assert.equal(first.status, "paused"); assert.equal(first.record_count, 0); assert.equal(first.raw_capture_count, 4);
    const next = await runOfficialCollection({ profile: "kcg-laws", root, maxRequests: 2 }, deps);
    assert.equal(next.status, "complete"); assert.equal(next.record_count, 1); assert.equal(requests, 5);
    const store = new LocalStore(root), found = await store.queryRecords("kcg-laws", { limit: 1 }); store.close();
    const data = found.records[0].data; assert.equal(data.attachments_downloaded, true); assert.equal(data.attachments[0].content_type, 'application/pdf');
    const sha = data.attachments[0].raw_sha256; assert.equal(digest(await readFile(path.join(root, 'raw', 'sha256', sha.slice(0, 2), sha))), sha);
  });
  await test("市政新聞原生POST分頁、發布者與namespace保留", async () => {
    const root = path.join(base, "city"), requestLog = []; let instant = 10000;
    const cityDetail = (id, title) => `https://www.kcg.gov.tw/CityNews_Detail1.aspx?n=3A379BB94CA5F12D&ss=${id}`;
    const cityIndex = (page) => `<form id="form1"><input name="__VIEWSTATE" id="__VIEWSTATE" type="hidden" value="fixture-page-${page}"><input name="__EVENTVALIDATION" id="__EVENTVALIDATION" type="hidden" value="fixture-only"><table><tr><td><table><tr><td></td><td><a href="${cityDetail(ids[page - 1])}">市政測試${page}</a></td><td>市政新聞</td><td>115-10-15</td></tr></table></td></tr></table>共2筆<span id="ContentPlaceHolder1_lblPageCount">${page}/2</span>${page === 1 ? '<a id="ContentPlaceHolder1_lbtNext" href="javascript:ignored">下一頁</a>' : ''}</form>`;
    const cityBody = (i) => `<form action="${cityDetail(ids[i])}"><div class="data_midlle_news_box01"><table><tr><td>市政測試${i + 1}</td></tr></table></div><div id="data_midlle"><li>發布機關：原件發布者</li><li>發布日期：115-10-15</li><div class="data_midlle_news_box02"><p>市政正文${i}</p></div></div></form>`;
    const deps = { now: () => instant, sleep: async (ms) => { instant += ms; }, fetchImpl: async (input, options) => {
      const address = String(input); requestLog.push({ address, method: options.method });
      if (address === NEWS) return new Response('<p>共0筆</p>');
      if (address === CITY) {
        if (options.method === 'POST') { const body = new URLSearchParams(options.body); assert.equal(body.get('__EVENTTARGET'), 'ctl00$ContentPlaceHolder1$lbtNext'); assert.equal(body.get('__VIEWSTATE'), 'fixture-page-1'); return new Response(cityIndex(2)); }
        return new Response(cityIndex(1));
      }
      const i = ids.findIndex((id) => address === cityDetail(id)); if (i >= 0) return new Response(cityBody(i));
      throw new Error('unexpected city fixture URL');
    } };
    let result = await runOfficialCollection({ profile: 'kcg-news', root, maxRequests: 2 }, deps);
    assert.equal(result.status, 'paused'); assert.equal(result.record_count, 0);
    result = await runOfficialCollection({ profile: 'kcg-news', root, maxRequests: 2 }, deps); assert.equal(result.record_count, 1);
    result = await runOfficialCollection({ profile: 'kcg-news', root, maxRequests: 2 }, deps); assert.equal(result.status, 'complete'); assert.equal(result.record_count, 2);
    assert.equal(requestLog.filter((r) => r.method === 'POST').length, 1);
    const store = new LocalStore(root), found = await store.queryRecords('kcg-news', { limit: 10 }); store.close();
    assert.equal(found.records[0].id, 'city:' + ids[0]); assert.equal(found.records[0].data.source_native_id, ids[0]); assert.equal(found.records[0].data.publisher, '原件發布者'); assert.equal(found.records[0].data.content, '市政正文0');
  });
  await test("全部必需原件缺失或竄改，complete續作必須blocked且不重新fetch", async () => {
    for (const source of ['history', 'attachment']) for (const damage of ['missing', 'tampered']) {
      const root = path.join(base, `proof-${source}-${damage}`), deps = lawFixture();
      const first = await finishLaw(root, deps); assert.equal(first.status, 'complete'); assert.equal(first.raw_validation.status, 'passed');
      const state = JSON.parse(await readFile(first.checkpoint_path, 'utf8')).state;
      const data = state.records[0].data;
      const sha = source === 'history' ? data.history_raw_sha256 : data.attachments[0].raw_sha256;
      const file = path.join(root, 'raw', 'sha256', sha.slice(0, 2), sha);
      if (damage === 'missing') await rm(file); else await writeFile(file, 'tampered fixture bytes');
      const before = deps.requests.length;
      const next = await runOfficialCollection({ profile: 'kcg-laws', root }, deps);
      assert.equal(next.status, 'blocked', `${source}/${damage}`); assert.equal(next.coverage.complete, false); assert.equal(next.continuation_required, false); assert.equal(next.receipt, null); assert.equal(next.raw_validation.status, 'failed');
      assert.equal(deps.requests.length, before, '不可重新下載掩蓋原件缺失或竄改');
    }
  });
  await test("每次發布核對完整receipt metadata與bytes長度", async () => {
    for (const field of ['byte_length', 'requested_url', 'request_method', 'http_status', 'content_type']) {
      const root = path.join(base, 'metadata-' + field), deps = lawFixture(); const first = await finishLaw(root, deps); assert.equal(first.status, 'complete');
      const state = JSON.parse(await readFile(first.checkpoint_path, 'utf8')).state; const saved = Object.values(state.captures)[0];
      const receipt = JSON.parse(await readFile(saved.receipt_path, 'utf8')); receipt[field] = typeof receipt[field] === 'number' ? receipt[field] + 1 : receipt[field] + '-tampered'; await writeFile(saved.receipt_path, JSON.stringify(receipt));
      const before = deps.requests.length, next = await runOfficialCollection({ profile: 'kcg-laws', root }, deps);
      assert.equal(next.status, 'blocked', field); assert.equal(next.raw_validation.status, 'failed'); assert.equal(next.coverage.complete, false); assert.equal(deps.requests.length, before);
    }
  });
  await test("官方分類與附件相對、root-relative、absolute皆完整採集", async () => {
    const root = path.join(base, 'url-forms'), deps = lawFixture({ styles: ['relative', 'root-relative', 'absolute'] });
    const result = await finishLaw(root, deps); assert.equal(result.status, 'complete'); assert.equal(result.record_count, 3); assert.equal(result.coverage.source_total, 3);
    assert.equal(result.raw_validation.status, 'passed'); assert.equal(result.raw_validation.required_capture_count, 13); assert.equal(result.raw_validation.verified_capture_count, 13);
    const state = JSON.parse(await readFile(result.checkpoint_path, 'utf8')).state; assert.ok(state.records.every((record) => record.data.attachments_downloaded && record.data.attachments.length === 1));
  });
  await test("分類及附件外站或未知格式皆failclosed而非忽略後complete", async () => {
    for (const flag of ['externalCategory', 'externalAttachment', 'unknownCategory', 'unknownAttachment']) {
      const root = path.join(base, flag), deps = lawFixture({ styles: ['relative', 'absolute'], [flag]: true });
      const result = await finishLaw(root, deps); assert.equal(result.status, 'blocked', flag); assert.equal(result.coverage.complete, false); assert.equal(result.receipt, null); assert.ok(['URL_REJECTED', 'SOURCE_STRUCTURE_CHANGED'].includes(result.error_code));
      assert.ok(deps.requests.every((address) => new URL(address).hostname === 'outlaw.kcg.gov.tw'));
    }
  });
  await test("路徑symlink與附件策略不一致的resume拒絕", async () => {
    const target = path.join(base, "target"); await mkdir(target); const linked = path.join(base, "link"); await symlink(target, linked);
    await assert.rejects(runOfficialCollection({ profile: "kcg-news", root: linked }, makeDeps()), /symlink/);
    await assert.rejects(runOfficialCollection({ profile: "kcg-news", root: path.join(base, "resume"), downloadAttachments: false }, makeDeps()), /附件策略/);
  });
  console.log(`official ingestion structural tests: ${passed} passed; live authority requires separate canary`);
} finally { await rm(base, { recursive: true, force: true }); }
