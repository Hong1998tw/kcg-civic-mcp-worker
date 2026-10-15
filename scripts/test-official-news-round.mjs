import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "../src/local/store.mjs";
import { prepareNewsIndexRound, runOfficialCollection } from "../src/ingestion/official-collection.mjs";

const NEWS = "https://www.kcg.gov.tw/News.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D";
const CITY = "https://www.kcg.gov.tw/CityNews1.aspx?n=3A379BB94CA5F12D";
const MESSAGE_IDS = ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC"];
const CITY_IDS = ["DDDDDDDDDDDDDDDD", "EEEEEEEEEEEEEEEE"];
const PUBLISHED = "115-10-15";
const OLD_URL = (id) => `https://www.kcg.gov.tw/News_Content.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D&s=${id}`;
const CITY_DETAIL = (id) => `https://www.kcg.gov.tw/CityNews_Detail1.aspx?n=3A379BB94CA5F12D&ss=${id}`;
const base = await realpath(await mkdtemp(path.join(tmpdir(), "official-news-round-test-")));
const hash = (value) => createHash("sha256").update(value).digest("hex");
let passed = 0;
async function test(name, work) { await work(); passed++; console.log(`PASS ${name}`); }

function messageDetail(id, title, body = "新聞正文") {
  const url = OLD_URL(id);
  return `<meta name="DC.Subject" content="${title}"><form action="${url}"><div id="data_midlle"><li><span>發布機關：</span>測試機關</li><li><span>發布日期：</span>${PUBLISHED}</li><div class="data_midlle_news_box02"><p>${body}</p></div></div></form>`;
}
function messageIndex(items, next = false, total = 3) {
  const rows = items.map(({ id, title = `最新消息${id[0]}`, agency = "測試機關", date = PUBLISHED }) =>
    `<tr><td><a href="${OLD_URL(id)}">${title}</a></td><td>${agency}</td><td>${date}</td></tr>`).join("");
  return `<table>${rows}</table><p>共${total}筆</p>${next ? `<a href="${NEWS}&page=2">下一頁</a>` : ""}`;
}
function cityIndex(page) {
  const id = CITY_IDS[page - 1], title = `市政新聞${page}`;
  return `<form id="form1"><input name="__VIEWSTATE" id="__VIEWSTATE" type="hidden" value="view-${page}"><input name="__EVENTVALIDATION" id="__EVENTVALIDATION" type="hidden" value="event-${page}"><table><tr><td></td><td><a href="${CITY_DETAIL(id)}">${title}</a></td><td>市政新聞</td><td>${PUBLISHED}</td></tr></table>共2筆<span id="ContentPlaceHolder1_lblPageCount">${page}/2</span>${page === 1 ? '<a id="ContentPlaceHolder1_lbtNext" href="javascript:ignored">下一頁</a>' : ""}</form>`;
}
function cityDetail(id, page) {
  const title = `市政新聞${page}`, url = CITY_DETAIL(id);
  return `<form action="${url}"><div class="data_midlle_news_box01"><table><tr><td>${title}</td></tr></table></div><div id="data_midlle"><li>發布機關：市府測試機關</li><li>發布日期：${PUBLISHED}</li><div class="data_midlle_news_box02"><p>市政正文${page}</p></div></div></form>`;
}
function releaseRecords(count, rawHash) {
  return Array.from({ length: count }, (_, index) => {
    const id = `messages:OLD${String(index).padStart(13, "0")}`;
    return { id, title: `舊發布${index}`, text: "舊快照記錄", data: { news_id: id, title: `舊發布${index}` },
      source_url: NEWS, retrieved_at: "2026-10-15T00:00:00.000Z", raw_sha256: rawHash };
  });
}

async function seedDrift(root, { lastError = "SOURCE_DRIFT", profile = "kcg-news", attempt = 0, publishedCount = 180 } = {}) {
  const runId = "5cc8c147-ea95-49d9-a7ad-6d2c483c9946";
  const detailUrl = OLD_URL(MESSAGE_IDS[0]), detailBytes = Buffer.from(messageDetail(MESSAGE_IDS[0], "最新消息A", "從舊CAS重新解析"));
  const detailSha = hash(detailBytes), oldRaw = Buffer.from("active release raw fixture"), oldRawSha = hash(oldRaw);
  const store = new LocalStore(root, { readOnly: false });
  await store.putRawObject({ sha256: detailSha, bytes_base64: detailBytes.toString("base64") });
  const oldRecords = releaseRecords(publishedCount, oldRawSha);
  await store.importSnapshot({ dataset: "kcg-news", snapshot_id: `official-kcg-news-existing-${publishedCount}`, coverage: { scope: "synthetic prior release", complete: false, source_total: 2336 },
    parser_version: "official-html-2026-10-15-v5", validator_version: "official-identity-count-v1", validation_status: "passed",
    records: oldRecords, raw_objects: [{ sha256: oldRawSha, bytes_base64: oldRaw.toString("base64") }] });
  store.close();

  const directory = path.join(root, "staging", "official", "kcg-news"), captureDirectory = path.join(directory, "captures");
  await mkdir(captureDirectory, { recursive: true });
  const detailCapture = { url: detailUrl, requested_url: detailUrl, request_key: detailUrl, request_method: "GET", sha256: detailSha,
    retrieved_at: "2026-10-15T01:00:00.000Z", byte_length: detailBytes.length, http_status: 200,
    content_type: "text/html; charset=utf-8", receipt_path: path.join(captureDirectory, `${runId}-cached-detail.json`) };
  await writeFile(detailCapture.receipt_path, JSON.stringify(detailCapture));
  const onePrior = { id: `messages:${MESSAGE_IDS[0]}`, title: "舊採集中的消息", text: "舊解析結果", data: { news_id: `messages:${MESSAGE_IDS[0]}`, content: "舊解析結果" },
    source_url: detailUrl, retrieved_at: detailCapture.retrieved_at, raw_sha256: detailSha };
  const state = {
    version: "official-html-2026-10-15-v5", profile, download_attachments: true, run_id: runId,
    captures: { [detailUrl]: detailCapture }, records: [onePrior, ...oldRecords.slice(1)],
    entries: { [onePrior.id]: { id: onePrior.id, url: detailUrl, title: "舊採集中的消息", published_at: PUBLISHED, agency: "測試機關", index_url: NEWS, index_raw_sha256: "1".repeat(64) } },
    listing_seen: [NEWS], queues: [{ url: CITY, type: "index", scope: "city", page: 7, parent_capture_key: `POST:${CITY}:page:6` },
      { url: `${NEWS}&page=8&PageSize=20`, type: "index", scope: "messages" }],
    totals: { messages: 1726, city: 610 }, scope_counts: { messages: 140, city: 60 }, finished_scopes: [],
    all_listing_done: false, exhausted: false, last_error_code: lastError, last_request_at: 10000,
  };
  if (attempt) { state.index_round_version = 1; state.index_round_id = randomUUID(); state.index_round_attempt = attempt; state.index_round_phase = "indexing";
    state.index_round_pages = []; state.index_round_verifications = {}; state.index_round_frozen_at = null; state.index_round_digest = null; }
  const encoded = JSON.stringify(state), checkpointDoc = { sha256: hash(encoded), state }, checkpointPath = path.join(directory, "checkpoint.json");
  await writeFile(checkpointPath, JSON.stringify(checkpointDoc));
  return { runId, checkpointPath, checkpointDoc, checkpointBytes: await readFile(checkpointPath), detailUrl, detailSha };
}

function roundDeps({ replaceHome = false, mixScope = false } = {}) {
  const requests = [];
  let newsGets = 0, cityGets = 0, instant = Date.now();
  return { requests, now: () => instant, sleep: async (ms) => { instant += ms; }, fetchImpl: async (input, options) => {
    const address = String(input), method = options.method || "GET";
    requests.push({ address, method });
    if (address === NEWS) {
      newsGets++;
      if (mixScope && newsGets === 1) return new Response(`<table><tr><td><a href="${CITY_DETAIL(CITY_IDS[0])}">跨scope市政稿</a></td><td>測試機關</td><td>${PUBLISHED}</td></tr></table><p>共3筆</p><a href="${NEWS}&page=2">下一頁</a>`);
      if (replaceHome && newsGets === 2) return new Response(messageIndex([
        { id: MESSAGE_IDS[0], title: "最新消息A被同總數置換" }, { id: MESSAGE_IDS[1], title: "最新消息B" },
      ], true));
      return new Response(messageIndex([
        { id: MESSAGE_IDS[0], title: "最新消息A" }, { id: MESSAGE_IDS[1], title: "最新消息B" },
      ], true));
    }
    if (address === `${NEWS}&page=2` || address === `${NEWS}&page=2&PageSize=20`) {
      return new Response(messageIndex([{ id: MESSAGE_IDS[2], title: "最新消息C" }], false));
    }
    if (address === CITY) {
      if (method === "POST") {
        const fields = new URLSearchParams(options.body);
        assert.equal(fields.get("__EVENTTARGET"), "ctl00$ContentPlaceHolder1$lbtNext");
        assert.equal(fields.get("__VIEWSTATE"), "view-1");
        return new Response(cityIndex(2));
      }
      cityGets++;
      return new Response(cityIndex(1));
    }
    const mi = MESSAGE_IDS.findIndex((id) => address === OLD_URL(id));
    if (mi >= 0) return new Response(messageDetail(MESSAGE_IDS[mi], `最新消息${String.fromCharCode(65 + mi)}`, mi === 0 ? "從舊CAS重新解析" : `消息正文${mi}`));
    const ci = CITY_IDS.findIndex((id) => address === CITY_DETAIL(id));
    if (ci >= 0) return new Response(cityDetail(CITY_IDS[ci], ci + 1));
    throw new Error(`unexpected round fixture request: ${method} ${address}`);
  }, counters: () => ({ newsGets, cityGets }) };
}

async function prepare(root, seeded) {
  return prepareNewsIndexRound({ root, expectedCheckpointSha256: seeded.checkpointDoc.sha256 });
}
async function currentCheckpoint(pathname) { return JSON.parse(await readFile(pathname, "utf8")); }

try {
  await test("僅精確 SOURCE_DRIFT checkpoint 可遷移；archive 讀回及重試冪等", async () => {
    const root = path.join(base, "archive"), seeded = await seedDrift(root);
    const prepared = await prepare(root, seeded);
    assert.equal(prepared.status, "prepared"); assert.equal(prepared.idempotent, false); assert.equal(prepared.run_id, seeded.runId);
    assert.equal(prepared.prior_published_count, 180); assert.equal(prepared.index_round_attempt, 1);
    const archive = await readFile(prepared.archive_path); assert.deepEqual(archive, seeded.checkpointBytes); assert.equal(hash(archive), prepared.archive_sha256);
    const state = (await currentCheckpoint(seeded.checkpointPath)).state;
    assert.equal(state.run_id, seeded.runId); assert.equal(Object.keys(state.captures).length, 1); assert.equal(state.records.length, 0);
    assert.equal(state.prior_published_count, 180); assert.equal(state.index_round_phase, "indexing"); assert.equal(state.index_round_version, 1);
    assert.equal(state.queues[0].scope, "messages"); assert.equal(state.queues[1].scope, "city");
    const retry = await prepareNewsIndexRound({ root, expectedCheckpointSha256: seeded.checkpointDoc.sha256 });
    assert.equal(retry.idempotent, true); assert.equal(retry.index_round_id, prepared.index_round_id);
    await assert.rejects(prepareNewsIndexRound({ root, expectedCheckpointSha256: "0".repeat(64) }), (error) => error.code === "CHECKPOINT_CHANGED");
    const store = new LocalStore(root); const live = await store.queryRecords("kcg-news", { limit: 1 }); store.close();
    assert.equal(live.release.snapshot_id, "official-kcg-news-existing-180"); assert.equal(live.release.record_count, 180);
  });

  await test("profile、錯誤碼與resume:false gate 不得重設既有 run", async () => {
    for (const [name, options] of [["profile", { profile: "kcg-laws" }], ["error", { lastError: "COLLECTION_FAILED" }]]) {
      const root = path.join(base, `gate-${name}`), seeded = await seedDrift(root, options);
      await assert.rejects(prepare(root, seeded), (error) => error.code === "INDEX_ROUND_GATE_REJECTED");
      const bytes = await readFile(seeded.checkpointPath); assert.deepEqual(bytes, seeded.checkpointBytes);
    }
    const root = path.join(base, "resume-false"), seeded = await seedDrift(root); const prepared = await prepare(root, seeded);
    await assert.rejects(runOfficialCollection({ profile: "kcg-news", root, resume: false }, roundDeps()), (error) => error.code === "NEWS_INDEX_ROUND_PREPARE_REQUIRED");
    assert.equal((await currentCheckpoint(seeded.checkpointPath)).state.index_round_id, prepared.index_round_id);
  });

  await test("index_round 分段完成索引與雙首頁新抓取，凍結前不取明細不改發布", async () => {
    const root = path.join(base, "multisegment"), seeded = await seedDrift(root), prepared = await prepare(root, seeded), deps = roundDeps();
    let result;
    for (let segment = 0; segment < 6; segment++) {
      result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 1, maxPages: 1 }, deps);
      assert.equal(result.run_id, seeded.runId); assert.equal(result.index_round.prior_published_count, 180);
      assert.equal(result.record_count, segment < 5 ? 0 : 0);
      assert.equal(deps.requests.some((request) => MESSAGE_IDS.some((id) => request.address === OLD_URL(id)) || CITY_IDS.some((id) => request.address === CITY_DETAIL(id))), false,
        "凍結前沒有明細請求；第六段剛凍結且預算已用完");
      if (segment < 5) assert.ok(["indexing", "verifying"].includes(result.index_round.phase));
    }
    assert.equal(result.index_round.phase, "details"); assert.equal(result.index_round.page_count, 4);
    assert.equal(deps.counters().newsGets, 2); assert.equal(deps.counters().cityGets, 2);
    const state = (await currentCheckpoint(seeded.checkpointPath)).state;
    assert.equal(state.index_round_phase, "details"); assert.match(state.index_round_digest, /^[a-f0-9]{64}$/);
    assert.equal(state.index_round_verifications.messages.request_method, "GET"); assert.equal(state.index_round_verifications.city.request_method, "GET");
    assert.ok(Object.keys(state.captures).some((key) => key.startsWith(`NEWS-VERIFY:${prepared.index_round_id}:messages:page:1:`)));
    assert.ok(Object.keys(state.captures).some((key) => key.startsWith(`NEWS-VERIFY:${prepared.index_round_id}:city:page:1:`)));
    assert.equal(state.index_round_scope_evidence.city.last_page.request_method, "POST");
    assert.equal(state.index_round_scope_evidence.city.last_page.final_url, CITY);
    assert.ok(state.index_round_scope_evidence.messages.pages.every((page) => /^[a-f0-9]{64}$/.test(page.ordered_entries_sha256)));
    assert.match(state.index_round_capture_window.semantics, /不代表官方同一交易快照/);
    assert.equal(result.publication_deferred, true); assert.equal(result.commit_state, "held-for-prior-release");
    const store = new LocalStore(root); const live = await store.queryRecords("kcg-news", { limit: 1 }); store.close();
    assert.equal(live.release.snapshot_id, "official-kcg-news-existing-180"); assert.equal(live.release.record_count, 180);

    const before = deps.requests.length;
    result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 1, maxPages: 10 }, deps);
    const added = deps.requests.slice(before);
    assert.ok(added.length <= 1); assert.ok(added.every((request) => ![NEWS, `${NEWS}&page=2`, CITY].includes(request.address)), "凍結續作不重抓 listing 或 verification");
    const resumedState = (await currentCheckpoint(seeded.checkpointPath)).state;
    assert.equal(resumedState.run_id, seeded.runId); assert.equal(resumedState.index_round_id, prepared.index_round_id);
    assert.ok(resumedState.records.some((record) => record.id === `messages:${MESSAGE_IDS[0]}`));
    const reused = resumedState.records.find((record) => record.id === `messages:${MESSAGE_IDS[0]}`);
    assert.equal(reused.raw_sha256, seeded.detailSha); assert.equal(reused.data.content, "從舊CAS重新解析");
    const afterStore = new LocalStore(root); const stillLive = await afterStore.queryRecords("kcg-news", { limit: 1 }); afterStore.close();
    assert.equal(stillLive.release.record_count, 180, "少於原已發布數時保留 active release");
  });

  await test("同筆數首頁有序內容置換時拒絕凍結，維持先前發布", async () => {
    const root = path.join(base, "same-count-swap"), seeded = await seedDrift(root); await prepare(root, seeded);
    const deps = roundDeps({ replaceHome: true });
    const result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 20, maxPages: 20 }, deps);
    assert.equal(result.status, "blocked"); assert.equal(result.error_code, "SOURCE_DRIFT"); assert.equal(result.record_count, 0);
    assert.equal(deps.requests.some((request) => MESSAGE_IDS.some((id) => request.address === OLD_URL(id)) || CITY_IDS.some((id) => request.address === CITY_DETAIL(id))), false);
    const state = (await currentCheckpoint(seeded.checkpointPath)).state;
    assert.equal(state.index_round_phase, "verifying"); assert.equal(state.index_round_frozen_at, null);
    const store = new LocalStore(root); const live = await store.queryRecords("kcg-news", { limit: 1 }); store.close();
    assert.equal(live.release.record_count, 180);
  });

  await test("第二輪須由root明確準備並先保存上一輪漂移 checkpoint", async () => {
    const root = path.join(base, "attempt-two"), seeded = await seedDrift(root); const first = await prepare(root, seeded);
    const deps = roundDeps({ replaceHome: true });
    const failed = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 20, maxPages: 20 }, deps);
    assert.equal(failed.error_code, "SOURCE_DRIFT"); assert.equal(failed.index_round.attempt, 1);
    const priorBytes = await readFile(seeded.checkpointPath), priorDoc = JSON.parse(priorBytes.toString("utf8"));
    const second = await prepareNewsIndexRound({ root, expectedCheckpointSha256: priorDoc.sha256 });
    assert.equal(second.index_round_attempt, 2); assert.equal(second.run_id, seeded.runId);
    assert.notEqual(second.index_round_id, first.index_round_id); assert.equal(second.prior_published_count, 180);
    assert.deepEqual(await readFile(second.archive_path), priorBytes); assert.equal(hash(await readFile(second.archive_path)), second.archive_sha256);
    const newState = (await currentCheckpoint(seeded.checkpointPath)).state;
    assert.equal(newState.records.length, 0); assert.equal(Object.keys(newState.captures).length, Object.keys(priorDoc.state.captures).length);
  });

  await test("拒絕新索引回應混入另一個 scope entry", async () => {
    const root = path.join(base, "scope-mix"), seeded = await seedDrift(root); await prepare(root, seeded);
    const deps = roundDeps({ mixScope: true });
    const result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 10, maxPages: 10 }, deps);
    assert.equal(result.status, "blocked"); assert.equal(result.error_code, "SOURCE_ID_MISMATCH"); assert.equal(result.record_count, 0);
    assert.equal(deps.requests.length, 1); assert.equal(deps.requests[0].address, NEWS);
  });

  await test("明確重試最多三輪，第三輪漂移後拒絕第四輪", async () => {
    const root = path.join(base, "max-attempt"), seeded = await seedDrift(root), first = await prepare(root, seeded);
    const driftState = (await currentCheckpoint(seeded.checkpointPath)).state;
    driftState.index_round_attempt = 3; driftState.last_error_code = "SOURCE_DRIFT";
    const encoded = JSON.stringify(driftState), checkpoint = { sha256: hash(encoded), state: driftState };
    await writeFile(seeded.checkpointPath, JSON.stringify(checkpoint));
    await assert.rejects(prepareNewsIndexRound({ root, expectedCheckpointSha256: checkpoint.sha256 }), (error) => error.code === "INDEX_ROUND_ATTEMPTS_EXHAUSTED");
    const after = await currentCheckpoint(seeded.checkpointPath);
    assert.equal(after.state.run_id, seeded.runId); assert.equal(after.state.index_round_attempt, 3); assert.equal(first.index_round_attempt, 1);
  });

  await test("固定索引路徑與 n/sms 不符時在網路請求前拒絕", async () => {
    const root = path.join(base, "fixed-scope"), seeded = await seedDrift(root); await prepare(root, seeded);
    const doc = await currentCheckpoint(seeded.checkpointPath);
    doc.state.queues[0].url = NEWS.replace("sms=19902EF36D6B551D", "sms=BAD");
    doc.sha256 = hash(JSON.stringify(doc.state)); await writeFile(seeded.checkpointPath, JSON.stringify(doc));
    const deps = roundDeps();
    const result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 5, maxPages: 5 }, deps);
    assert.equal(result.error_code, "SOURCE_ID_MISMATCH"); assert.equal(deps.requests.length, 0);
  });

  await test("完整新母體小於原發布數時停止，保留原 active release", async () => {
    const root = path.join(base, "population-reduced"), seeded = await seedDrift(root); await prepare(root, seeded);
    const result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 30, maxPages: 20 }, roundDeps());
    assert.equal(result.status, "blocked"); assert.equal(result.error_code, "SOURCE_POPULATION_REDUCED");
    assert.equal(result.record_count, 5); assert.equal(result.coverage.complete, false); assert.equal(result.publication_deferred, true);
    const store = new LocalStore(root); const actual = await store.queryRecords("kcg-news", { limit: 0 }); store.close();
    assert.equal(actual.release.record_count, 180); assert.equal(actual.release.snapshot_id, "official-kcg-news-existing-180");
  });

  await test("完整新索引與全部明細核對後才發布完整新母體", async () => {
    const root = path.join(base, "round-complete"), seeded = await seedDrift(root, { publishedCount: 1 }); await prepare(root, seeded);
    const result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 30, maxPages: 20 }, roundDeps());
    assert.equal(result.status, "complete"); assert.equal(result.error_code, null); assert.equal(result.coverage.complete, true);
    assert.equal(result.record_count, 5); assert.equal(result.index_round.phase, "complete");
    const store = new LocalStore(root); const actual = await store.queryRecords("kcg-news", { limit: 0 }); store.close();
    assert.equal(actual.release.record_count, 5); assert.equal(actual.release.manifest_sha256, result.receipt.manifest_sha256);
  });

  await test("索引與首頁複核的同站 redirect 仍必須保留固定 scope", async () => {
    for (const stage of ["index", "verification"]) {
      const root = path.join(base, `redirect-${stage}`), seeded = await seedDrift(root); await prepare(root, seeded);
      const deps = roundDeps(), original = deps.fetchImpl;
      const wrong = NEWS.replace("n=F29A02A9D36C47F0", "n=AAAAAAAAAAAAAAAA").replace("sms=19902EF36D6B551D", "sms=BBBBBBBBBBBBBBBB");
      let homeCalls = 0;
      deps.fetchImpl = async (input, options) => {
        const address = String(input);
        if (address === NEWS && ++homeCalls === (stage === "index" ? 1 : 2)) return new Response("", { status: 302, headers: { location: wrong } });
        return original(address === wrong ? NEWS : input, options);
      };
      const result = await runOfficialCollection({ profile: "kcg-news", root, maxRequests: 30, maxPages: 20 }, deps);
      assert.equal(result.status, "blocked"); assert.equal(result.error_code, "SOURCE_ID_MISMATCH");
      const state = (await currentCheckpoint(seeded.checkpointPath)).state;
      assert.equal(state.index_round_frozen_at, null); assert.equal(result.receipt, null);
    }
  });

  console.log(`official news index-round tests: ${passed} passed; fixture-only, no live corpus work performed`);
} finally {
  await rm(base, { recursive: true, force: true });
}
