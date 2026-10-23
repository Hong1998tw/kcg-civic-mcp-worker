import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalStore, LocalStoreError } from "../src/local/store.mjs";
import { buildLocal } from "./build-local.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE24 = process.execPath;
const TEST_TOKEN = "TEST-local-token-only";

function assertNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 24, `test requires Node >=24; running ${process.versions.node}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function testRecord({ id, data, title, text, url, retrievedAt = "2026-10-15T00:00:00.000Z", rawHash }) {
  return {
    id,
    title: `TEST ${title || id}`,
    text: `TEST ${text || title || id}`,
    data: { test_fixture: true, ...data },
    source_url: url,
    retrieved_at: retrievedAt,
    raw_sha256: rawHash,
  };
}

function proposalSnapshot(snapshotId, rawHash, textSuffix = "TEST 道路") {
  const baseIds = [
    ["A", "2026-01-01"],
    ["a", "2026-01-02"],
    ["._:-", "2026-01-03"],
    ...Array.from({ length: 18 }, (_, index) => [`P${String(index + 1).padStart(3, "0")}`, `2026-01-${String(index + 4).padStart(2, "0")}`]),
  ];
  const records = baseIds.map(([id, date]) => testRecord({
    id,
    title: `${textSuffix} 提案 ${id}`,
    text: `${textSuffix} 提案內容 ${id}`,
    rawHash,
    url: "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx",
    retrievedAt: `${date}T00:00:00.000Z`,
    data: {
      proposal_sn: id,
      subject: `${textSuffix} 提案 ${id}`,
      category: "交通",
      proposer: "TEST 議員",
      proposer_type: "councilor",
      period: "07",
      session: "0704",
      field_source: "confirmed_query_scope",
      query: { period: "07", session: "0704", category: "06" },
      meeting: "07040800",
      meeting_number: 8,
    },
  }));
  return {
    dataset: "kcc-proposals-pilot",
    snapshot_id: snapshotId,
    records,
    coverage: { scope: "TEST fixture only; 30 official-scope rows declared", complete: false, source_total: 30 },
    raw_objects: [],
    parser_version: "TEST-parser-v1",
    validator_version: "TEST-validator-v1",
    validation_status: "passed",
  };
}

function lawSnapshot(rawHash) {
  const lawId = "LAW-TEST-1";
  return {
    dataset: "kcg-laws",
    snapshot_id: "TEST-laws-v1",
    records: [testRecord({
      id: lawId,
      title: "TEST 高雄輕軌自治條例",
      text: "TEST 第一條 保障公共運輸資訊透明。",
      rawHash,
      url: `https://outlaw.kcg.gov.tw/index.aspx?id=${lawId}`,
      data: {
        law_id: lawId,
        law_name: "TEST 高雄輕軌自治條例",
        category: "交通",
        published_at: "2026-10-15",
        official_url: `https://outlaw.kcg.gov.tw/index.aspx?id=${lawId}`,
        history: "TEST history",
        articles: [{ article_no: "第一條", content: "保障公共運輸資訊透明。" }],
      },
    })],
    coverage: { scope: "TEST fixture only", complete: true, source_total: 1 },
    raw_objects: [],
    parser_version: "TEST-parser-v1",
    validator_version: "TEST-validator-v1",
    validation_status: "passed",
  };
}

function budgetSnapshot(rawHash) {
  return {
    dataset: "kcg-budget-115",
    snapshot_id: "TEST-budget-v1",
    records: [testRecord({
      id: "115",
      title: "TEST 115年度預算摘要",
      text: "TEST 預算摘要",
      rawHash,
      url: "https://openapi.kcg.gov.tw/Api/Service/Get/TEST",
      data: {
        year: 115,
        summary: {
          agency_count: 2,
          agency_sum_budget_thousand_twd: 12345,
          official_total_budget_thousand_twd: null,
          highest: { agency: "TEST A", budget_thousand_twd: 8000 },
          lowest: { agency: "TEST B", budget_thousand_twd: 4345 },
        },
      },
    })],
    coverage: { scope: "TEST fixture only", complete: true, source_total: 1 },
    raw_objects: [],
    parser_version: "TEST-parser-v1",
    validator_version: "TEST-validator-v1",
    validation_status: "passed",
  };
}

function meetingSnapshot(rawHash) {
  const records = [];
  for (let number = 1000; number < 1019; number += 1) {
    const meetingId = String(number);
    const pdf = `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${meetingId}/TEST.pdf`;
    records.push(testRecord({
      id: meetingId,
      title: `TEST 第 ${number} 場會議`,
      text: `TEST 第 ${number} 場 keyword 議事錄`,
      rawHash,
      url: pdf,
      retrievedAt: `2026-10-${String((number % 15) + 1).padStart(2, "0")}T00:00:00.000Z`,
      data: {
        record_id: meetingId,
        term: 4,
        date: `2026-10-${String((number % 15) + 1).padStart(2, "0")}`,
        meeting_name: `TEST 第 ${number} 場會議`,
        pdf_url: pdf,
        total_pages: 1,
        pages: [{ page: 1, text: `TEST 第 ${number} 場 keyword 議事錄` }],
      },
    }));
  }
  const meetingId = "999";
  const pdf = `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${meetingId}/TEST.pdf`;
  records.push(testRecord({
    id: meetingId,
    title: "TEST 多頁議事錄",
    text: "TEST first page TARGET second page",
    rawHash,
    url: pdf,
    retrievedAt: "2026-10-15T00:00:00.000Z",
    data: {
      record_id: meetingId,
      term: 4,
      date: "2026-10-15",
      meeting_name: "TEST 多頁議事錄",
      pdf_url: pdf,
      total_pages: 2,
      pages: [{ page: 1, text: "TEST first page" }, { page: 2, text: "TARGET second page" }],
    },
  }));
  return {
    dataset: "kcc-meeting-records",
    snapshot_id: "TEST-meeting-records-v1",
    records,
    coverage: { scope: "TEST fixture only", complete: true, source_total: records.length },
    raw_objects: [],
    parser_version: "TEST-parser-v1",
    validator_version: "TEST-validator-v1",
    validation_status: "passed",
  };
}

function errorCode(error) {
  return error?.reasonCode || /^([A-Z_]+):/.exec(error?.message || "")?.[1] || "";
}

async function expectLocalError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(errorCode(error), code, error?.message);
    return true;
  });
}

async function importTestSnapshots(root) {
  const raw = Buffer.from("TEST-only source bytes; never official source data");
  const rawHash = sha256(raw);
  const store = new LocalStore(root, { readOnly: false });
  const rawObject = { sha256: rawHash, bytes_base64: raw.toString("base64") };
  const withRaw = (snapshot) => ({ ...snapshot, raw_objects: [rawObject] });
  await store.importSnapshot(withRaw(proposalSnapshot("TEST-proposals-v1", rawHash)));
  await store.importSnapshot(withRaw(lawSnapshot(rawHash)));
  await store.importSnapshot(withRaw(budgetSnapshot(rawHash)));
  await store.importSnapshot(withRaw(meetingSnapshot(rawHash)));
  store.close();
  return { raw, rawHash };
}

async function testStore(root, rawHash) {
  const store = new LocalStore(root, { readOnly: true });
  const ordered = await store.queryRecords("kcc-proposals-pilot", { limit: 100 });
  assert.deepEqual(ordered.records.slice(0, 3).map((record) => record.id), ["._:-", "A", "P001"]);
  assert.equal(ordered.records.at(-1).id, "a");
  assert.equal(ordered.local_match_count, 21);
  assert.equal(ordered.release.coverage.source_total, 30);
  assert.ok(ordered.records.every((record) => record.raw_sha256 === rawHash));
  store.close();

  const historyRoot = path.join(root, "history-test");
  const writer = new LocalStore(historyRoot, { readOnly: false });
  const raw = Buffer.from("TEST history bytes");
  const historyRawHash = sha256(raw);
  const first = {
    ...proposalSnapshot("TEST-history-v1", historyRawHash, "TEST v1"),
    raw_objects: [{ sha256: historyRawHash, bytes_base64: raw.toString("base64") }],
  };
  const second = { ...proposalSnapshot("TEST-history-v2", historyRawHash, "TEST v2"), raw_objects: [] };
  const receiptV1 = await writer.importSnapshot(first);
  await writer.importSnapshot(second);
  const archivedV1 = await writer.readSnapshotVersion("kcc-proposals-pilot", "TEST-history-v1");
  assert.equal(archivedV1.manifest_sha256, receiptV1.manifest_sha256);
  assert.ok(archivedV1.records.every((record) => !Object.hasOwn(record, "bytes_base64")));
  const restored = await writer.restoreSnapshot("kcc-proposals-pilot", "TEST-history-v1");
  assert.equal(restored.status, "imported");
  assert.equal((await writer.queryRecords("kcc-proposals-pilot", { keyword: "v1" })).local_match_count, 21);
  await expectLocalError(writer.importSnapshot({ ...first, records: first.records.map((record) => ({ ...record, text: "TEST collision" })) }), "SOURCE_ID_MISMATCH");
  writer.close();

  const emptyRoot = path.join(root, "empty-test");
  const emptyWriter = new LocalStore(emptyRoot, { readOnly: false });
  emptyWriter.close();
  const emptyReader = new LocalStore(emptyRoot, { readOnly: true });
  await expectLocalError(emptyReader.queryRecords("kcg-laws"), "LOCAL_DATA_UNAVAILABLE");
  emptyReader.close();
}

async function testRegistryAndSchemas(bundle, root) {
  const store = new LocalStore(root, { readOnly: true });
  const registry = bundle.createLocalRegistry(store);
  assert.equal(registry.length, 21);
  const tool = (name) => registry.find((item) => item.name === name);

  const proposals = await tool("kcc_search_proposals").handler({
    keyword: "TEST",
    period: "07",
    session: "0704",
    category: "06",
  });
  assert.equal(proposals.status, "partial");
  assert.equal(proposals.data.returned_count, 20);
  assert.equal(proposals.data.total_count, 21);
  assert.equal(proposals.data.is_complete, false);
  assert.equal(proposals.meta.source_official_total, 30);
  assert.equal(proposals.data.proposals[0].period, undefined);
  assert.equal(proposals.data.proposals[0].local_provenance.confirmed_query_scope.period, "07");
  assert.equal(proposals.meta.omitted_local_matches, 1);
  assert.equal(proposals.data.offset, 0);
  assert.equal(proposals.data.next_offset, 20);
  assert.match(proposals.data.notice, /共 21 筆符合，本次回傳第 1–20 筆；續查請帶 offset=20。/);

  const firstIds = proposals.data.proposals.map((item) => item.proposal_sn);
  const secondPage = await tool("kcc_search_proposals").handler({ keyword: "TEST", offset: 20 });
  assert.equal(secondPage.data.returned_count, 1);
  assert.equal(secondPage.data.total_count, 21);
  assert.equal(secondPage.data.next_offset, null);
  assert.equal(secondPage.data.is_complete, false);
  assert.equal(secondPage.meta.omitted_local_matches, 20);
  assert.ok(!firstIds.includes(secondPage.data.proposals[0].proposal_sn), "offset page must not repeat first-page records");
  assert.match(secondPage.data.notice, /本次回傳第 21–21 筆。$/);

  const smallPages = [];
  for (let offset = 0; offset !== null;) {
    const page = await tool("kcc_search_proposals").handler({ keyword: "TEST", limit: 8, offset });
    assert.ok(page.data.returned_count <= 8);
    smallPages.push(...page.data.proposals.map((item) => item.proposal_sn));
    offset = page.data.next_offset;
  }
  assert.equal(smallPages.length, 21);
  assert.equal(new Set(smallPages).size, 21);

  const wide = await tool("kcc_search_proposals").handler({ keyword: "TEST", limit: 100 });
  assert.equal(wide.data.returned_count, 21);
  assert.equal(wide.data.next_offset, null);
  const beyond = await tool("kcc_search_proposals").handler({ keyword: "TEST", offset: 50 });
  assert.equal(beyond.data.returned_count, 0);
  assert.match(beyond.data.notice, /offset=50 已超出結果範圍/);
  await expectLocalError(tool("kcc_search_proposals").handler({ keyword: "TEST", limit: 101 }), "INVALID_ARGUMENT");
  await expectLocalError(tool("kcc_search_proposals").handler({ keyword: "TEST", limit: 0 }), "INVALID_ARGUMENT");
  await expectLocalError(tool("kcc_search_proposals").handler({ keyword: "TEST", offset: -1 }), "INVALID_ARGUMENT");
  await expectLocalError(tool("kcc_search_proposals").handler({ keyword: "TEST", limit: 2.5 }), "INVALID_ARGUMENT");

  const councilorPage = await tool("kcc_get_councilor_proposals").handler({ councilor: "TEST 議員", limit: 5, offset: 5 });
  assert.equal(councilorPage.data.total_count, 21);
  assert.equal(councilorPage.data.returned_count, 5);
  assert.equal(councilorPage.data.offset, 5);
  assert.equal(councilorPage.data.next_offset, 10);
  assert.deepEqual(councilorPage.data.proposals.map((item) => item.proposal_sn), smallPages.slice(5, 10));

  await assert.rejects(tool("kcc_search_proposals").handler({ keyword: "TEST", ignored_filter: "x" }),
    (error) => errorCode(error) === "UNSUPPORTED_FILTER");
  await expectLocalError(tool("kcc_get_schedule").handler({}), "FEATURE_UNAVAILABLE");
  await expectLocalError(tool("kcc_search_meeting_records").handler({}), "LOCAL_DATA_UNAVAILABLE");
  await expectLocalError(tool("kcc_search_speeches").handler({ keyword: "TEST" }), "FEATURE_UNAVAILABLE");
  await expectLocalError(tool("kcc_get_proposal").handler({ proposal_sn: "A" }), "LOCAL_DATA_UNAVAILABLE");
  await expectLocalError(tool("kcc_get_proposal_result").handler({ proposal_sn: "A" }), "LOCAL_DATA_UNAVAILABLE");

  const law = await tool("get_kcg_law_detail").handler({ law_id: "LAW-TEST-1" });
  assert.equal(law.status, "success");
  assert.equal(law.data.articles_count, 1);
  assert.equal(law.data.articles[0].content, "保障公共運輸資訊透明。");
  const lawSearch = await tool("search_kcg_laws").handler({ keyword: "公共運輸", limit: 1 });
  assert.equal(lawSearch.data.length, 1);
  assert.ok(lawSearch.data[0].matched_articles[0].includes("第一條"));

  const budget = await tool("get_kcg_budget_summary").handler({ year: 115 });
  assert.equal(budget.status, "success");
  assert.equal(budget.data.agency_sum_budget_thousand_twd, 12345);
  assert.equal(budget.data.official_total_budget_thousand_twd, null);
  assert.equal(budget.data.summary, undefined);

  const pageRecord = await tool("kcc_get_meeting_record").handler({ record_id: "999", keyword: "TARGET", page: 1 });
  assert.equal(pageRecord.data.total_pages, 2);
  assert.equal(pageRecord.data.matched_pages_count, 1);
  assert.equal(pageRecord.data.matches[0].page, 2);
  assert.equal(pageRecord.data.page_content, "TEST first page");
  const crossMeeting = await tool("kcc_search_meeting_record_content").handler({ keyword: "keyword", limit_records: 8 });
  assert.equal(crossMeeting.status, "partial");
  assert.equal(crossMeeting.data.scan_status, "partial");
  assert.equal(crossMeeting.data.attempted_records_count, 8);
  assert.equal(crossMeeting.meta.omitted_local_records, 12);

  store.close();
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 7000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local server exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`local server health timeout: ${lastError?.message || "no response"}`);
}

async function testHttp(root, buildDir, bundle) {
  const guardPath = path.join(buildDir, "network-guard.mjs");
  await writeFile(guardPath, "globalThis.fetch = async () => { throw new Error('TEST outbound fetch disabled'); };\n");
  const reservation = await import("node:http").then(({ createServer }) => new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  }));
  const port = reservation;
  const child = spawn(NODE24, ["--import", guardPath, path.join(buildDir, "server.mjs")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      BIND_HOST: "127.0.0.1",
      LOCAL_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`,
      KCG_CIVIC_DATA_DIR: root,
      MCP_ACCESS_KEY: TEST_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  let client;
  try {
    const healthResponse = await waitForHealth(`${origin}/health`, child);
    const health = await healthResponse.json();
    assert.deepEqual(health, { status: "ok" });
    assert.equal(await (await fetch(`${origin}/health`, { headers: { Origin: "https://evil.invalid" } })).status, 403);
    assert.equal(await (await fetch(`${origin}/mcp`, { method: "GET" })).status, 405);
    assert.equal(await (await fetch(`${origin}/mcp`, { method: "POST", body: "{}" })).status, 401);
    assert.equal(await (await fetch(`${origin}/mcp`, {
      method: "POST", headers: { Authorization: "Bearer wrong-test-token" }, body: "{}",
    })).status, 401);
    assert.equal(await (await fetch(`${origin}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${TEST_TOKEN}` }, body: Buffer.alloc(1024 * 1024 + 1),
    })).status, 413);

    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    });
    client = new Client({ name: "TEST local acceptance", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const sourceByName = new Map(bundle.LOCAL_SOURCE_TOOL_SCHEMAS.map((item) => [item.name, item]));
    assert.equal(listed.tools.length, 21);
    for (const item of listed.tools) {
      const original = sourceByName.get(item.name);
      assert.ok(original, `unexpected tool ${item.name}`);
      assert.deepEqual(item.inputSchema, original.inputSchema, `input schema changed for ${item.name}`);
    }
    const keySchema = listed.tools.find((item) => item.name === "kcc_search_proposals")._meta?.securitySchemes?.[0]
      || listed.tools.find((item) => item.name === "kcc_search_proposals").securitySchemes?.[0];
    assert.equal(keySchema?.type, "apiKey");
    assert.equal(keySchema?.in, "header");
    assert.equal(keySchema?.name, "Authorization");

    const toolResult = await client.callTool({
      name: "kcc_search_proposals",
      arguments: { keyword: "TEST", period: "07", session: "0704", category: "06" },
    });
    assert.equal(toolResult.isError, undefined);
    assert.equal(toolResult.structuredContent.data.total_count, 21);
    assert.equal(toolResult.structuredContent.status, "partial");
    for (const name of ["kcc_search_proposals", "kcc_get_councilor_proposals"]) {
      const listedSchema = listed.tools.find((item) => item.name === name).inputSchema;
      assert.deepEqual(Object.keys(listedSchema.properties).filter((key) => key === "limit" || key === "offset"), ["limit", "offset"]);
    }
    const pagedResult = await client.callTool({ name: "kcc_search_proposals", arguments: { keyword: "TEST", limit: 5, offset: 20 } });
    assert.equal(pagedResult.isError, undefined);
    assert.equal(pagedResult.structuredContent.data.returned_count, 1);
    assert.equal(pagedResult.structuredContent.data.next_offset, null);

    const lawResult = await client.callTool({ name: "get_kcg_law_detail", arguments: { law_id: "LAW-TEST-1" } });
    assert.equal(lawResult.structuredContent.data.articles[0].content, "保障公共運輸資訊透明。");
    const budgetResult = await client.callTool({ name: "get_kcg_budget_summary", arguments: { year: 115 } });
    assert.equal(budgetResult.structuredContent.data.agency_sum_budget_thousand_twd, 12345);
    assert.equal(budgetResult.structuredContent.data.summary, undefined);

    const unknown = await client.callTool({ name: "kcc_get_schedule", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.reason_code, "FEATURE_UNAVAILABLE");
    const emptyDataset = await client.callTool({ name: "kcc_search_meeting_records", arguments: {} });
    assert.equal(emptyDataset.isError, true);
    assert.equal(emptyDataset.structuredContent.reason_code, "LOCAL_DATA_UNAVAILABLE");
    const unsupported = await client.callTool({ name: "kcc_search_proposals", arguments: { keyword: "TEST", unsupported_filter: "x" } });
    assert.equal(unsupported.isError, true);
    assert.equal(unsupported.structuredContent.reason_code, "UNSUPPORTED_FILTER");
  } catch (error) {
    error.message += `\nserver output: ${logs}`;
    throw error;
  } finally {
    await client?.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

async function testTamper(root, raw, rawHash) {
  const dbRoot = path.join(root, "tamper-db");
  const dbWriter = new LocalStore(dbRoot, { readOnly: false });
  const snapshot = lawSnapshot(rawHash);
  await dbWriter.importSnapshot({ ...snapshot, snapshot_id: "TEST-tamper-db-v1", raw_objects: [{ sha256: rawHash, bytes_base64: raw.toString("base64") }] });
  dbWriter.close();
  const db = new DatabaseSync(path.join(dbRoot, "index.sqlite"));
  db.prepare("UPDATE collections SET text = ? WHERE dataset = ? AND id = ?").run("TEST TAMPERED", "kcg-laws", "LAW-TEST-1");
  db.close();
  const dbReader = new LocalStore(dbRoot, { readOnly: true });
  await expectLocalError(dbReader.queryRecords("kcg-laws", { keyword: "TAMPERED" }), "SNAPSHOT_UNVERIFIED");
  dbReader.close();

  const rawRoot = path.join(root, "tamper-raw");
  const rawWriter = new LocalStore(rawRoot, { readOnly: false });
  await rawWriter.importSnapshot({ ...snapshot, snapshot_id: "TEST-tamper-raw-v1", raw_objects: [{ sha256: rawHash, bytes_base64: raw.toString("base64") }] });
  rawWriter.close();
  const rawPath = path.join(rawRoot, "raw", "sha256", rawHash.slice(0, 2), rawHash);
  await writeFile(rawPath, Buffer.from("TEST tampered raw bytes"));
  const rawReader = new LocalStore(rawRoot, { readOnly: true });
  await expectLocalError(rawReader.queryRecords("kcg-laws", { keyword: "TEST" }), "SNAPSHOT_UNVERIFIED");
  rawReader.close();

  const archiveRoot = path.join(root, "tamper-archive");
  const archiveWriter = new LocalStore(archiveRoot, { readOnly: false });
  await archiveWriter.importSnapshot({ ...snapshot, snapshot_id: "TEST-tamper-archive-v1", raw_objects: [{ sha256: rawHash, bytes_base64: raw.toString("base64") }] });
  const archivePath = path.join(archiveRoot, "snapshots", "kcg-laws", "TEST-tamper-archive-v1.json");
  const savedArchive = await readFile(archivePath);
  const doc = JSON.parse(savedArchive.toString("utf8"));
  doc.records[0].text = "TEST tampered archive";
  await writeFile(archivePath, JSON.stringify(doc));
  await expectLocalError(archiveWriter.readSnapshotVersion("kcg-laws", "TEST-tamper-archive-v1"), "SNAPSHOT_UNVERIFIED");
  await writeFile(archivePath, savedArchive);
  archiveWriter.close();
}

async function testSymlinkRejection(root, raw, rawHash) {
  const targetRoot = path.join(root, "symlink-target-root");
  const rootAlias = path.join(root, "symlink-root-alias");
  await mkdir(targetRoot);
  await symlink(targetRoot, rootAlias, "dir");
  assert.throws(() => new LocalStore(rootAlias, { readOnly: false }), (error) => errorCode(error) === "SNAPSHOT_UNVERIFIED");
  assert.deepEqual(await readdir(targetRoot), []);

  const rawRoot = path.join(root, "symlink-raw-root");
  const rawTarget = path.join(root, "symlink-raw-target");
  await mkdir(rawTarget);
  const rawWriter = new LocalStore(rawRoot, { readOnly: false });
  await symlink(rawTarget, path.join(rawRoot, "raw"), "dir");
  await expectLocalError(rawWriter.putRawObject({ sha256: rawHash, bytes_base64: raw.toString("base64") }), "SNAPSHOT_UNVERIFIED");
  assert.deepEqual(await readdir(rawTarget), []);
  rawWriter.close();

  const snapshotsRoot = path.join(root, "symlink-snapshots-root");
  const snapshotsTarget = path.join(root, "symlink-snapshots-target");
  await mkdir(snapshotsTarget);
  const snapshotsWriter = new LocalStore(snapshotsRoot, { readOnly: false });
  await symlink(snapshotsTarget, path.join(snapshotsRoot, "snapshots"), "dir");
  await expectLocalError(snapshotsWriter.importSnapshot({
    ...lawSnapshot(rawHash),
    snapshot_id: "TEST-symlink-snapshot-v1",
    raw_objects: [{ sha256: rawHash, bytes_base64: raw.toString("base64") }],
  }), "SNAPSHOT_UNVERIFIED");
  assert.deepEqual(await readdir(snapshotsTarget), []);
  snapshotsWriter.close();
}

async function main() {
  assertNode24();
  const temp = await mkdtemp(path.join(tmpdir(), "kcg-local-acceptance-"));
  const dataRoot = path.join(temp, "data");
  const buildDir = path.join(temp, "build");
  try {
    const { raw, rawHash } = await importTestSnapshots(dataRoot);
    await testStore(dataRoot, rawHash);
    const { outfile } = await buildLocal({ outdir: buildDir });
    await symlink(path.join(ROOT, "node_modules"), path.join(buildDir, "node_modules"), "dir");
    const bundle = await import(pathToFileURL(outfile).href);
    await testRegistryAndSchemas(bundle, dataRoot);
    await testTamper(temp, raw, rawHash);
    await testSymlinkRejection(temp, raw, rawHash);
    await testHttp(dataRoot, buildDir, bundle);
    process.stdout.write("PASS local store, history restore, registry schemas, MCP HTTP/auth, offline queries, tamper, and partial coverage\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`local acceptance failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
