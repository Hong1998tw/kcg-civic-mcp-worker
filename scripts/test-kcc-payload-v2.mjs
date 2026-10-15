import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  KCC_SEARCH_CHUNK_BYTES,
  KCC_V2_SCHEMA,
  buildKccV2SearchChunks,
  canonicalKccJson,
  hydrateKccV2Record,
  packKccV2PdfPage,
  packKccV2Record,
  readKccV2PageText,
  streamKccV2PageText,
  verifyKccV2Descriptor,
  verifyKccV2Envelope,
  verifyKccV2SearchChunks,
} from "../src/local/kcc-payload.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pageUrl = (id, name = "record.pdf") => `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/${name}`;

class FakeDerivedStore {
  objects = new Map();
  writes = [];
  reads = [];

  async putObject({ kind, dataset, id, source, raw_sha256, schema_version, body }) {
    const bytes = Buffer.from(body);
    const header = { format: "TEST-derived-v1", kind, dataset, id, source, raw_sha256, schema_version, body_byte_length: bytes.byteLength };
    const headerBytes = Buffer.from(canonicalKccJson(header));
    const stored = { header, body: bytes, fullBytes: Buffer.concat([headerBytes, bytes]) };
    const ref = { sha256: sha256(stored.fullBytes), byte_length: stored.fullBytes.byteLength };
    this.objects.set(ref.sha256, stored);
    this.writes.push({ kind, id, schema_version, body_byte_length: bytes.byteLength, ref });
    return ref;
  }

  async readObject(ref, expected, { maxBytes = 64 * 1024 * 1024 } = {}) {
    const stored = this.objects.get(ref.sha256);
    assert.ok(stored, `missing object ${ref.sha256}`);
    assert.equal(stored.fullBytes.byteLength, ref.byte_length);
    assert.equal(stored.fullBytes.byteLength > maxBytes, false);
    assert.equal(sha256(stored.fullBytes), ref.sha256);
    for (const [key, value] of Object.entries(expected)) assert.equal(stored.header[key], value, `binding ${key}`);
    this.reads.push({ kind: expected.kind, id: expected.id, schema_version: expected.schema_version, ref });
    return Buffer.from(stored.body);
  }

  async *readObjectStream(ref, expected, { chunkBytes = 16 } = {}) {
    const body = await this.readObject(ref, expected, { maxBytes: 64 * 1024 * 1024 });
    for (let offset = 0; offset < body.length; offset += chunkBytes) yield body.subarray(offset, offset + chunkBytes);
  }
}

class FakeLocalStore {
  payloadReads = 0;

  constructor(derived) { this.derived = derived; }

  async hydrateV2(dataset, selectedRecord, { maxBytes = 64 * 1024 * 1024 } = {}) {
    this.payloadReads += 1;
    return await this.derived.readObject(selectedRecord.descriptor.payload_ref, {
      kind: "payload",
      dataset,
      id: selectedRecord.id,
      source: selectedRecord.envelope.source_url,
      raw_sha256: selectedRecord.descriptor.raw_sha256,
      schema_version: KCC_V2_SCHEMA.payload,
    }, { maxBytes });
  }

  async readDerivedObject(ref, expected, options) { return await this.derived.readObject(ref, expected, options); }
  async readDerivedObjectStream(ref, expected, options) { return this.derived.readObjectStream(ref, expected, options); }
}

async function readEnvelope(derived, dataset, descriptor, source) {
  const bytes = await derived.readObject(descriptor.envelope_ref, {
    kind: "envelope", dataset, id: descriptor.id, source, raw_sha256: descriptor.raw_sha256,
    schema_version: KCC_V2_SCHEMA.envelope,
  });
  return JSON.parse(bytes.toString("utf8"));
}

function queryRecord(descriptor, envelope, snapshotId = "TEST-snapshot-v1") {
  return {
    id: descriptor.id,
    title: envelope.title,
    text: "",
    data: envelope.data,
    source_url: envelope.source_url,
    retrieved_at: envelope.retrieved_at,
    raw_sha256: descriptor.raw_sha256,
    snapshot_id: snapshotId,
    manifest_sha256: "a".repeat(64),
    descriptor,
    envelope,
  };
}

async function testChunkSemantics() {
  const boundary = `${"a".repeat(KCC_SEARCH_CHUNK_BYTES - 3)}中文“引號”\n😀尾`;
  const chunks = buildKccV2SearchChunks({ title: "標題甲", text: "內文乙", data: {} }, boundary);
  verifyKccV2SearchChunks(chunks, { id: "TEST-boundary" });
  const dataChunks = chunks.filter((item) => item.source === "data");
  assert.equal(dataChunks.length, 2);
  assert.ok(dataChunks.every((item) => item.byte_length <= KCC_SEARCH_CHUNK_BYTES));
  assert.equal(dataChunks.map((item) => item.text).join(""), boundary);
  assert.equal(dataChunks[0].text.includes("中文"), false);
  assert.equal(dataChunks[1].text.includes("中文"), false);
  assert.equal(dataChunks.map((item) => item.text).join("").includes("中文"), true,
    "the keyword search adapter must carry the tail across adjacent blocks of one channel");
  const title = chunks.filter((item) => item.source === "title").map((item) => item.text).join("");
  const text = chunks.filter((item) => item.source === "text").map((item) => item.text).join("");
  assert.equal(title + text, "標題甲內文乙");
  assert.equal(title.includes("甲內"), false);

  const tampered = structuredClone(chunks);
  tampered[0].text += "改";
  assert.throws(() => verifyKccV2SearchChunks(tampered, { id: "TEST-tamper" }), /hash\/長度無效/);
  const reordered = structuredClone(chunks);
  [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
  assert.throws(() => verifyKccV2SearchChunks(reordered, { id: "TEST-reorder" }), /順序或結構無效/);
}

async function testPackAndHydrate() {
  const derived = new FakeDerivedStore();
  const recordId = "999";
  const pdfHash = sha256(Buffer.from("TEST pdf raw bytes"));
  const source = pageUrl(recordId);
  const page1 = "測試第一頁\n保留 quote \"text\"。";
  const page2 = "😀 第二頁\n跨行關鍵字 TARGET。";
  const record = {
    id: recordId,
    title: "TEST 議事錄",
    text: `${page1}\n${page2}`,
    data: {
      record_id: recordId,
      meeting_name: "TEST 第四屆會議",
      date: "2026-10-15",
      term: 4,
      pdf_url: source,
      total_pages: 2,
      content_index_status: "indexed",
      fulltext_complete: true,
      originals_complete: true,
      pages: [{ page: 1, text: page1 }, { page: 2, text: page2 }],
      pdf_versions: [{ source_url: source, download_url: source, raw_sha256: pdfHash, total_pages: 2,
        pages: [{ page: 1, text: page1 }, { page: 2, text: page2 }] }],
      original_versions: [{ source_url: source, download_url: source, raw_sha256: pdfHash, total_pages: 2,
        pages: [{ page: 1, text: page1 }, { page: 2, text: page2 }] }],
    },
    source_url: source,
    retrieved_at: "2026-10-15T01:00:00.000Z",
    raw_sha256: pdfHash,
  };
  const packed = await packKccV2Record(derived, { dataset: "kcc-meeting-records", record });
  const descriptor = verifyKccV2Descriptor(packed.descriptor);
  assert.ok(Buffer.byteLength(canonicalKccJson(descriptor)) <= 1024);
  assert.equal(packed.derived_objects_written.page_count, 2, "same PDF page refs are shared across legacy shapes");
  const envelope = await readEnvelope(derived, "kcc-meeting-records", descriptor, source);
  assert.equal(Object.keys(envelope.page_sets).length, 3);
  assert.deepEqual(envelope.pages.map((page) => page.page_number), [1, 2]);
  assert.ok(envelope.pages.every((page) => page.version_id === pdfHash));
  const searchManifestBytes = await derived.readObject(descriptor.search_ref, {
    kind: "search-manifest", dataset: "kcc-meeting-records", id: recordId, source, raw_sha256: pdfHash,
    schema_version: KCC_V2_SCHEMA.search,
  });
  const searchManifest = JSON.parse(searchManifestBytes.toString("utf8"));
  assert.ok(searchManifest.chunks.some((chunk) => chunk.channel === "page" && chunk.version_id === pdfHash && chunk.page_number === 2));
  assert.ok(searchManifest.chunks.every((chunk) => !Object.hasOwn(chunk, "text")));

  const selected = queryRecord(descriptor, envelope);
  verifyKccV2Envelope(selected, "kcc-meeting-records");
  const local = new FakeLocalStore(derived);
  const page2Entry = envelope.pages.find((page) => page.version_id === pdfHash && page.page_number === 2);
  assert.equal(await readKccV2PageText(local, "kcc-meeting-records", selected, page2Entry), page2);
  const streamed = [];
  for await (const part of streamKccV2PageText(local, "kcc-meeting-records", selected, page2Entry, { chunkBytes: 3 })) streamed.push(part);
  assert.equal(streamed.join(""), page2, "UTF-8 code points survive split byte streams");

  const pageReadsBeforeFullHydrate = derived.reads.filter((read) => read.kind === "pdf-page").length;
  const hydrated = await hydrateKccV2Record(local, "kcc-meeting-records", selected);
  assert.equal(local.payloadReads, 1);
  assert.equal(hydrated.text, record.text);
  assert.deepEqual(hydrated.data, record.data);
  assert.equal(hydrated.data.pdf_versions[0].pages[1].text, page2);
  assert.equal(hydrated.data.original_versions[0].pages[0].text, page1);
  assert.equal(derived.reads.filter((read) => read.kind === "pdf-page").length - pageReadsBeforeFullHydrate, 6,
    "full hydrate reads each legacy shape page ref exactly once");

  const reorderedEnvelopeRecord = structuredClone(selected);
  reorderedEnvelopeRecord.envelope.pages.reverse();
  assert.throws(() => verifyKccV2Envelope(reorderedEnvelopeRecord, "kcc-meeting-records"), /順序無效/);
  const tamperedEnvelopeRecord = structuredClone(selected);
  tamperedEnvelopeRecord.envelope.pages[0].ref.sha256 = "0".repeat(64);
  await assert.rejects(hydrateKccV2Record(local, "kcc-meeting-records", tamperedEnvelopeRecord), /page ref 不一致/);

  const repeated = await packKccV2Record(derived, { dataset: "kcc-meeting-records", record });
  assert.deepEqual(repeated.descriptor, descriptor, "derived refs are stable without a candidate snapshot id");
}

async function testIncrementalPagePacking() {
  const derived = new FakeDerivedStore();
  const id = "888";
  const pdfHash = sha256(Buffer.from("TEST incremental PDF"));
  const source = pageUrl(id, "revision.pdf");
  const text = "逐頁抽取後才包完整 record。\n".repeat(10);
  const bundle = await packKccV2PdfPage(derived, { dataset: "kcc-meeting-records", id, source, raw_sha256: pdfHash, page_number: 1, text });
  assert.equal(bundle.page_ref.version_id, pdfHash);
  assert.ok(bundle.search_chunks.every((chunk) => chunk.channel === "page" && chunk.page_number === 1));
  const record = {
    id, title: "TEST incremental", text_recipe: { kind: "page-join", slot: "data.pages", separator: "\n" },
    data: {
      record_id: id, meeting_name: "TEST incremental", date: "2026-10-15", term: 4, pdf_url: source,
      total_pages: 1, fulltext_complete: true, content_index_status: "indexed",
      pages: [{ page: 1 }],
      pdf_versions: [{ source_url: source, raw_sha256: pdfHash, total_pages: 1, pages: [{ page: 1 }] }],
    },
    source_url: source, retrieved_at: "2026-10-15T02:00:00.000Z", raw_sha256: pdfHash,
  };
  const packed = await packKccV2Record(derived, { dataset: "kcc-meeting-records", record, page_refs: [bundle] });
  const envelope = await readEnvelope(derived, "kcc-meeting-records", packed.descriptor, source);
  const selected = queryRecord(packed.descriptor, envelope);
  const local = new FakeLocalStore(derived);
  const hydrated = await hydrateKccV2Record(local, "kcc-meeting-records", selected);
  assert.equal(hydrated.text, text);
  assert.equal(hydrated.data.pages[0].text, text);
}

await testChunkSemantics();
await testPackAndHydrate();
await testIncrementalPagePacking();
process.stdout.write("KCC payload v2 codec fixtures passed\n");
