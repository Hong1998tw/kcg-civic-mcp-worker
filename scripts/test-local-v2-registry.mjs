import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { LocalStore } from "../src/local/store.mjs";
import { packKccV2PdfPage, packKccV2Record } from "../src/local/kcc-payload.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const PDF_URL = (id) => `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/meeting.pdf`;
const COVERAGE = { scope: "TEST v2 registry fixture", complete: true, source_total: 1 };
const MANIFEST = "a".repeat(64);

function v2Record({ id = "999", pages = ["TEST first page", "before TARGET after"], data = {} } = {}) {
  const source = PDF_URL(id);
  const rawSha = sha256(Buffer.from(`TEST raw ${id}`));
  const pageRefs = pages.map((text, index) => ({
    version_id: rawSha,
    page_number: index + 1,
    source,
    raw_sha256: rawSha,
    ref: { sha256: sha256(Buffer.from(`${id}:page:${index + 1}`)), byte_length: index + 100 },
  }));
  const metadata = {
    record_id: id,
    term: 4,
    date: "2026-10-15",
    meeting_name: `TEST 會議 ${id}`,
    pdf_url: source,
    total_pages: pages.length,
    fulltext_complete: true,
    content_index_status: "indexed",
    originals_complete: true,
    ...data,
  };
  const envelope = {
    schema_version: "kcc-envelope-v2",
    dataset: "kcc-meeting-records",
    id,
    raw_sha256: rawSha,
    title: `TEST 會議 ${id}`,
    source_url: source,
    retrieved_at: "2026-10-15T00:00:00.000Z",
    identity: { id, record_id: id },
    filters: { term: 4 },
    date: metadata.date,
    flags: { fulltext_complete: true, content_index_status: "indexed" },
    data: metadata,
    page_sets: { "data.pages": rawSha },
    page_totals: { "data.pages": pages.length },
    pages: pageRefs,
  };
  const descriptor = {
    id,
    raw_sha256: rawSha,
    envelope_ref: { sha256: sha256(Buffer.from(`${id}:envelope`)), byte_length: 200 },
    payload_ref: { sha256: sha256(Buffer.from(`${id}:payload`)), byte_length: 300 },
    search_ref: { sha256: sha256(Buffer.from(`${id}:search`)), byte_length: 400 },
  };
  return {
    id,
    title: envelope.title,
    text: "",
    data: metadata,
    source_url: source,
    retrieved_at: envelope.retrieved_at,
    raw_sha256: rawSha,
    snapshot_id: "TEST-v2-snapshot",
    manifest_sha256: MANIFEST,
    descriptor,
    envelope,
  };
}

function v1Record(record, texts) {
  return {
    id: record.id,
    title: record.title,
    text: texts.join("\n"),
    data: { ...record.data, pages: texts.map((text, index) => ({ page: index + 1, text })) },
    source_url: record.source_url,
    retrieved_at: record.retrieved_at,
    raw_sha256: record.raw_sha256,
  };
}

function release(dataset = "kcc-meeting-records", recordCount = 1) {
  return {
    schema_version: "local-snapshot-v2",
    dataset,
    snapshot_id: "TEST-v2-snapshot",
    record_count: recordCount,
    coverage: COVERAGE,
    manifest_sha256: MANIFEST,
    parser_version: "TEST-parser",
    validator_version: "TEST-validator",
    source_url: PDF_URL("999"),
    retrieved_at: "2026-10-15T00:00:00.000Z",
  };
}

class FixtureStore {
  constructor({ version, response, texts = new Map() }) {
    this.version = version;
    this.response = response;
    this.texts = texts;
    this.pageBodyReads = [];
    this.payloadReads = 0;
    this.queryOptions = [];
  }

  async getDatasetVersion() { return this.version; }
  async hasDataset() { return true; }

  async queryRecords(dataset, options) {
    this.queryOptions.push({ version: "v1", dataset, options });
    return this.response;
  }

  async queryV2(dataset, options) {
    this.queryOptions.push({ version: "v2", dataset, options });
    return this.response;
  }

  async hydrateV2() {
    this.payloadReads += 1;
    throw new Error("unexpected payload hydration in registry fixture");
  }

  async readDerivedObject(ref) {
    this.pageBodyReads.push(ref.sha256);
    const text = this.texts.get(ref.sha256);
    if (text === undefined) throw new Error(`unexpected page ref ${ref.sha256}`);
    return Buffer.from(text, "utf8");
  }

  async *readDerivedObjectStream() {
    throw new Error("page mirror search must not read page body streams");
  }
}

const substringSnippet = (text, keyword, padding) => text.slice(
  Math.max(0, text.indexOf(keyword) - padding),
  Math.min(text.length, text.indexOf(keyword) + keyword.length + padding),
).replace(/\s+/g, " ").trim();

async function loadRegistry() {
  const temp = await mkdtemp(path.join(ROOT, ".tmp-kcc-v2-registry-test-"));
  const outfile = path.join(temp, "registry.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/local/registry.mjs")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const module = await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`);
  return { createLocalRegistry: module.createLocalRegistry, temp };
}

function makeV2Query(record, { pageMatches = [], localMatchCount = 1, records = [record], order = null } = {}) {
  return {
    release: release("kcc-meeting-records", records.length),
    records,
    local_match_count: localMatchCount,
    order_by: order,
    metadata_only: true,
    page_matches: pageMatches,
    matched_pages_count: pageMatches.length,
    total_page_matches: pageMatches.reduce((sum, item) => sum + item.match_count, 0),
    omitted_page_matches: 0,
    omitted_occurrences: 0,
    empty_text_page_count: 0,
    page_search_complete: true,
  };
}

function pageMatch(record, pageNumber, text, keyword, padding, normalizeWhitespace = true) {
  const page = record.envelope.pages.find((item) => item.page_number === pageNumber);
  return {
    id: record.id,
    version_id: page.version_id,
    page_number: page.page_number,
    source: page.source,
    raw_sha256: page.raw_sha256,
    page_ref: page.ref,
    match_count: text.split(keyword).length - 1,
    snippets: [substringSnippet(text, keyword, padding)],
  };
}

async function testSinglePageReadAndV1Equivalence(createLocalRegistry) {
  const texts = ["TEST first page", "before TARGET after"];
  const v2 = v2Record({ pages: texts });
  const v2Result = makeV2Query(v2, { pageMatches: [pageMatch(v2, 2, texts[1], "TARGET", 60)] });
  const v2Store = new FixtureStore({ version: "v2", response: v2Result, texts: new Map([[v2.envelope.pages[0].ref.sha256, texts[0]]]) });
  const v2Registry = createLocalRegistry(v2Store);
  const v2Tool = v2Registry.find((tool) => tool.name === "kcc_get_meeting_record");
  const v2Output = await v2Tool.handler({ record_id: "999", keyword: "TARGET", page: 1 });

  const v1 = v1Record(v2, texts);
  const v1Result = {
    release: { ...v2Result.release, schema_version: undefined },
    records: [v1],
    local_match_count: 1,
    order_by: null,
  };
  const v1Store = new FixtureStore({ version: "v1", response: v1Result });
  const v1Registry = createLocalRegistry(v1Store);
  const v1Tool = v1Registry.find((tool) => tool.name === "kcc_get_meeting_record");
  const v1Output = await v1Tool.handler({ record_id: "999", keyword: "TARGET", page: 1 });

  assert.deepEqual(v2Output.data, v1Output.data);
  assert.equal(v2Output.status, v1Output.status);
  assert.equal(v2Store.payloadReads, 0, "single page query never hydrates payload");
  assert.deepEqual(v2Store.pageBodyReads, [v2.envelope.pages[0].ref.sha256], "only the requested page body is read");
  assert.equal(v2Store.queryOptions[0].options.pageSearch.slots[0], "data.pages");
  assert.equal(v2Store.queryOptions[0].options.includePageRefs, true);
}

async function testZeroHitAndLatestLimit(createLocalRegistry) {
  const emptyRecord = v2Record();
  const emptyResponse = makeV2Query(emptyRecord, { records: [], localMatchCount: 0, pageMatches: [] });
  emptyResponse.release.record_count = 1001;
  const emptyStore = new FixtureStore({ version: "v2", response: emptyResponse });
  const emptyRegistry = createLocalRegistry(emptyStore);
  const interpellation = emptyRegistry.find((tool) => tool.name === "search_kcg_council_interpellations");
  const emptyOutput = await interpellation.handler({ keyword: "NO-HIT", limit: 10 });
  assert.deepEqual(emptyOutput.data, []);
  assert.equal(emptyStore.payloadReads, 0);
  assert.equal(emptyStore.pageBodyReads.length, 0);

  const records = Array.from({ length: 20 }, (_, index) => v2Record({ id: String(2000 + index), pages: ["最新會議 TARGET"] }));
  const pageMatches = records.slice(0, 8).map((record) => pageMatch(record, 1, "最新會議 TARGET", "TARGET", 60));
  const response = makeV2Query(records[0], {
    records: records.slice(0, 8),
    localMatchCount: 20,
    pageMatches,
    order: { field: "date", descending: true, scope: "entire_verified_snapshot" },
  });
  response.release.coverage = { scope: "TEST partial scope", complete: false, source_total: 20 };
  const store = new FixtureStore({ version: "v2", response });
  const registry = createLocalRegistry(store);
  const tool = registry.find((item) => item.name === "kcc_search_meeting_record_content");
  const output = await tool.handler({ keyword: "TARGET", limit_records: 8 });
  assert.equal(output.data.attempted_records_count, 8);
  assert.equal(output.meta.omitted_local_records, 12);
  assert.equal(store.payloadReads, 0);
  assert.equal(store.pageBodyReads.length, 0);
  assert.ok(store.queryOptions[0].options.limit <= 15, "latest search fetches no more than 15 metadata rows");
}

async function testNativeV2OnlyRouting(createLocalRegistry, temp) {
  const root = path.join(temp, "native-store");
  const store = new LocalStore(root, { readOnly: false });
  const pageReads = [];
  let payloadReads = 0;
  const readDerivedObject = store.readDerivedObject.bind(store);
  const hydrateV2 = store.hydrateV2.bind(store);
  store.readDerivedObject = async (ref, expected, options) => {
    if (expected.kind === "pdf-page") pageReads.push(ref.sha256);
    return await readDerivedObject(ref, expected, options);
  };
  store.hydrateV2 = async (...args) => { payloadReads += 1; return await hydrateV2(...args); };
  try {
    const id = "1449";
    const source = PDF_URL(id);
    const raw = Buffer.from("TEST native PDF bytes");
    const rawSha = sha256(raw);
    await store.putRawObject({ sha256: rawSha, bytes_base64: raw.toString("base64") });
    const texts = ["TEST first page", "before TARGET after"];
    const pageRefs = [];
    for (const [index, text] of texts.entries()) pageRefs.push(await packKccV2PdfPage(store.derivedStore, {
      dataset: "kcc-meeting-records", id, source, raw_sha256: rawSha, page_number: index + 1, text,
    }));
    const sourceVersion = {
      source_url: source, download_url: source, pdf_url: source, file_type: "pdf", raw_sha256: rawSha,
      retrieved_at: "2026-10-15T00:00:00.000Z", byte_length: raw.length, total_pages: 2,
      pages: texts.map((_, index) => ({ page: index + 1 })),
    };
    const meeting = {
      id, title: `TEST meeting ${id}`, text_recipe: { kind: "page-join", slot: "data.pages", separator: "\n" },
      data: {
        record_id: id, term: 4, date: "2026-10-15", meeting_name: "TEST native meeting", pdf_url: source,
        total_pages: 2, fulltext_complete: true, content_index_status: "indexed", originals_complete: true,
        pages: texts.map((_, index) => ({ page: index + 1 })),
        pdf_versions: [sourceVersion], original_versions: [sourceVersion],
      },
      source_url: source, retrieved_at: "2026-10-15T00:00:00.000Z", raw_sha256: rawSha,
    };
    const packedMeeting = await packKccV2Record(store.derivedStore, { dataset: "kcc-meeting-records", record: meeting, page_refs: pageRefs });
    await store.importV2({
      schema_version: "local-snapshot-v2", dataset: "kcc-meeting-records", snapshot_id: "TEST-native-meetings-v2",
      coverage: COVERAGE, parser_version: "TEST", validator_version: "TEST", validation_status: "passed",
      records: [packedMeeting.descriptor],
    });
    assert.equal(await store.getDatasetVersion("kcc-meeting-records"), "v2");
    assert.equal(await store.hasDataset("kcc-meeting-records"), false, "hasDataset stays v1-only for a v2-only release");
    const registry = createLocalRegistry(store);
    const meetingTool = registry.find((tool) => tool.name === "kcc_get_meeting_record");
    const output = await meetingTool.handler({ record_id: id, keyword: "TARGET", page: 1 });
    assert.equal(output.data.page_content, texts[0]);
    assert.deepEqual(output.data.matches.map((match) => match.page), [2]);
    assert.equal(payloadReads, 0, "native v2 page query avoids payload hydration");
    assert.deepEqual(pageReads, [pageRefs[0].page_ref.ref.sha256]);

    const attachmentRaw = Buffer.from("TEST attachment listing raw");
    const attachmentRawSha = sha256(attachmentRaw);
    await store.putRawObject({ sha256: attachmentRawSha, bytes_base64: attachmentRaw.toString("base64") });
    const attachmentRecord = {
      id: "ABC123", title: "TEST proposal attachments", text: "TEST proposal attachments",
      data: { proposal_sn: "ABC123", parent_id: "ABC123", attachments: [{ name: "TEST file", url: "https://cissearch.kcc.gov.tw/Download/Attachment/ABC123/file.pdf" }] },
      source_url: "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx",
      retrieved_at: "2026-10-15T00:00:00.000Z", raw_sha256: attachmentRawSha,
    };
    const packedAttachment = await packKccV2Record(store.derivedStore, { dataset: "kcc-proposal-attachments", record: attachmentRecord });
    await store.importV2({
      schema_version: "local-snapshot-v2", dataset: "kcc-proposal-attachments", snapshot_id: "TEST-native-attachments-v2",
      coverage: { scope: "TEST attachment fixture", complete: true, source_total: 1 },
      parser_version: "TEST", validator_version: "TEST", validation_status: "passed",
      records: [packedAttachment.descriptor],
    });
    assert.equal(await store.getDatasetVersion("kcc-proposal-attachments"), "v2");
    assert.equal(await store.hasDataset("kcc-proposal-attachments"), false);
    const attachmentTool = registry.find((tool) => tool.name === "kcc_get_attachments");
    const attachmentOutput = await attachmentTool.handler({ proposal_sn: "ABC123" });
    assert.equal(attachmentOutput.data.attachments.length, 1);
    assert.equal(attachmentOutput.data.attachments[0].name, "TEST file");
    assert.equal(payloadReads, 1, "only a full attachment response hydrates its selected payload");

    // Ingestion republishes the release after the tool selected the record but before it reads it.
    const republished = { ...attachmentRecord, data: { ...attachmentRecord.data, attachments: [{ name: "TEST file v2", url: "https://cissearch.kcc.gov.tw/Download/Attachment/ABC123/file.pdf" }] } };
    const packedRepublished = await packKccV2Record(store.derivedStore, { dataset: "kcc-proposal-attachments", record: republished });
    let switched = false;
    const queryV2 = store.queryV2.bind(store);
    store.queryV2 = async (...args) => {
      const selected = await queryV2(...args);
      if (!switched && args[0] === "kcc-proposal-attachments") {
        switched = true;
        await store.importV2({
          schema_version: "local-snapshot-v2", dataset: "kcc-proposal-attachments", snapshot_id: "TEST-native-attachments-v3",
          coverage: { scope: "TEST attachment fixture", complete: true, source_total: 1 },
          parser_version: "TEST", validator_version: "TEST", validation_status: "passed",
          records: [packedRepublished.descriptor],
        });
      }
      return selected;
    };
    // A record selected from one release must not be read once another release is active.
    const stale = (await queryV2("kcc-proposal-attachments", { limit: 1, metadataOnly: true, includePageRefs: true })).records[0];
    await store.importV2({
      schema_version: "local-snapshot-v2", dataset: "kcc-proposal-attachments", snapshot_id: "TEST-native-attachments-v4",
      coverage: { scope: "TEST attachment fixture", complete: true, source_total: 1 },
      parser_version: "TEST", validator_version: "TEST", validation_status: "passed",
      records: [packedAttachment.descriptor],
    });
    await assert.rejects(() => hydrateV2("kcc-proposal-attachments", stale),
      (error) => error.reasonCode === "SNAPSHOT_UNVERIFIED" && error.releaseChanged === true);
    switched = false;
    const retried = await attachmentTool.handler({ proposal_sn: "ABC123" });
    assert.equal(switched, true, "the release really changed between selection and hydration");
    assert.equal(retried.data.attachments[0].name, "TEST file v2", "the tool answers from the newly published release");
    assert.equal(retried.provenance.source_id, "TEST-native-attachments-v3");
  } finally {
    store.close();
  }
}

async function testV1PageRows(createLocalRegistry, temp) {
  const store = new LocalStore(path.join(temp, 'v1-page-rows'), { readOnly: false });
  try {
    const raw = Buffer.from('TEST original page-row PDF'), hash = sha256(raw), source = PDF_URL('1');
    await store.putRawObject({ sha256: hash, bytes_base64: raw.toString('base64') });
    const records = [1, 2].map((page) => ({ id: `1:${page}`, title: 'TEST meeting', text: page === 2 ? 'TARGET' : 'other',
      data: { record_id: '1', page, text: page === 2 ? 'TARGET' : 'other', total_pages: 2, pdf_url: source, date: '2026-10-15' },
      source_url: source, retrieved_at: '2026-10-15T00:00:00Z', raw_sha256: hash }));
    await store.importSnapshot({ dataset: 'kcc-meeting-records', snapshot_id: 'TEST-v1-page-rows', coverage: { scope: 'TEST', complete: true, source_total: 2 },
      records, raw_objects: [], parser_version: 'TEST', validator_version: 'TEST', validation_status: 'passed' });
    const output = await createLocalRegistry(store).find((tool) => tool.name === 'kcc_search_meeting_record_content').handler({ keyword: 'TARGET', limit_records: 1 });
    assert.equal(output.data.records.length, 1); assert.equal(output.data.records[0].matches[0].page, 2);
  } finally { store.close(); }
}

const { createLocalRegistry, temp } = await loadRegistry();
try {
  await testSinglePageReadAndV1Equivalence(createLocalRegistry);
  await testZeroHitAndLatestLimit(createLocalRegistry);
  await testNativeV2OnlyRouting(createLocalRegistry, temp);
  await testV1PageRows(createLocalRegistry, temp);
  process.stdout.write("Local v2 registry fixtures passed\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
