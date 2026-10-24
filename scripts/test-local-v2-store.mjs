import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DerivedStore } from "../src/local/derived-store.mjs";
import { LocalStore, LocalStoreError } from "../src/local/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sourceUrl(id) {
  return `https://cissearch.kcc.gov.tw/Meeting/Record?id=${id}`;
}

async function prepareRecord(store, { id, date, title, textChunks, pageTexts }) {
  const rawBytes = Buffer.from(`TEST official source ${id}`);
  const rawSha = sha256(rawBytes);
  await store.putRawObject({ sha256: rawSha, bytes_base64: rawBytes.toString("base64") });
  const url = sourceUrl(id);
  const pdfBytes = Buffer.from(`TEST official PDF ${id}`);
  const pdfRawSha = sha256(pdfBytes);
  await store.putRawObject({ sha256: pdfRawSha, bytes_base64: pdfBytes.toString("base64") });
  const pdfUrl = `https://cissearch.kcc.gov.tw/Files/${id}.pdf`;
  const pages = [];
  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageNumber = index + 1;
    const pageText = Buffer.from(pageTexts[index], "utf8");
    const ref = await store.derivedStore.putObject({
      kind: "pdf-page", dataset: "kcc-meeting-records", id, source: pdfUrl,
      raw_sha256: pdfRawSha, schema_version: "kcc-pdf-page-v2", body: pageText,
    });
    pages.push({ version_id: pdfRawSha, page_number: pageNumber, source: pdfUrl, raw_sha256: pdfRawSha, ref });
  }
  const envelope = {
    id,
    raw_sha256: rawSha,
    title,
    source_url: url,
    retrieved_at: `${date}T10:00:00.000Z`,
    data: { record_id: id, meeting_date: date, title },
    pages,
    page_sets: { "data.pages": pdfRawSha },
    page_totals: { "data.pages": pageTexts.length },
  };
  const envelopeBytes = Buffer.from(canonical(envelope));
  const envelopeRef = await store.derivedStore.putObject({
    kind: "envelope", dataset: "kcc-meeting-records", id, source: url,
    raw_sha256: rawSha, schema_version: "kcc-envelope-v2", body: envelopeBytes,
  });
  const payloadBytes = Buffer.from(canonical({ schema_version: "fixture-payload", id, full_text: "TEST payload body" }));
  const payloadRef = await store.derivedStore.putObject({
    kind: "payload", dataset: "kcc-meeting-records", id, source: url,
    raw_sha256: rawSha, schema_version: "kcc-payload-v2", body: payloadBytes,
  });
  assert.notEqual(payloadRef.sha256, rawSha, "derived payload SHA must not masquerade as official raw SHA");

  const searchChunks = [];
  const addChunk = async (channel, chunkIndex, text, pageNumber = null) => {
    if (!text) return;
    const bytes = Buffer.from(text, "utf8");
    const source = channel === "page" ? pdfUrl : url;
    const chunkRawSha = channel === "page" ? pdfRawSha : rawSha;
    const versionId = channel === "page" ? pdfRawSha : null;
    const ref = await store.derivedStore.putObject({
      kind: "search-chunk", dataset: "kcc-meeting-records", id, source,
      raw_sha256: chunkRawSha, schema_version: "kcc-search-chunk-v2", body: bytes,
    });
    searchChunks.push({
      block_index: searchChunks.length,
      channel,
      version_id: versionId,
      page_number: channel === "page" ? pageNumber : null,
      chunk_index: chunkIndex,
      source,
      raw_sha256: chunkRawSha,
      schema_version: "kcc-search-chunk-v2",
      sha256: sha256(bytes),
      byte_length: bytes.length,
      ref: { sha256: ref.sha256, byte_length: ref.byte_length },
    });
  };
  await addChunk("title", 0, title);
  for (let index = 0; index < textChunks.length; index += 1) await addChunk("text", index, textChunks[index]);
  await addChunk("data", 0, canonical(envelope.data));
  for (let index = 0; index < pageTexts.length; index += 1) await addChunk("page", 0, pageTexts[index], index + 1);
  const manifestBytes = Buffer.from(canonical({ schema_version: "kcc-search-manifest-v2", chunks: searchChunks }));
  const searchRef = await store.derivedStore.putObject({
    kind: "search-manifest", dataset: "kcc-meeting-records", id, source: url,
    raw_sha256: rawSha, schema_version: "kcc-search-manifest-v2", body: manifestBytes,
  });
  return {
    descriptor: {
      id,
      raw_sha256: rawSha,
      envelope_ref: { sha256: envelopeRef.sha256, byte_length: envelopeRef.byte_length },
      payload_ref: { sha256: payloadRef.sha256, byte_length: payloadRef.byte_length },
      search_ref: { sha256: searchRef.sha256, byte_length: searchRef.byte_length },
    },
    payloadBytes,
    pages,
  };
}

function snapshot(snapshotId, descriptors) {
  return {
    schema_version: "local-snapshot-v2",
    dataset: "kcc-meeting-records",
    snapshot_id: snapshotId,
    coverage: { scope: "TEST fixture", complete: true, source_total: descriptors.length },
    parser_version: "TEST-parser-v2",
    validator_version: "TEST-validator-v2",
    validation_status: "passed",
    records: descriptors,
  };
}

async function expectStoreError(action, reasonCode) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof LocalStoreError || error?.reasonCode === reasonCode, String(error));
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 24, `test requires Node >=24; running ${process.versions.node}`);
  const temp = await mkdtemp(path.join(tmpdir(), "local-v2-store-"));
  const dataRoot = path.join(temp, "data");
  const writer = new LocalStore(dataRoot, { readOnly: false });
  try {
    const first = await prepareRecord(writer, {
      id: "MEET-1", date: "2026-10-14", title: "一般會議",
      textChunks: ["跨界", "中文字詞命中"], pageTexts: ["第一頁命中內容", ""],
    });
    const second = await prepareRecord(writer, {
      id: "MEET-2", date: "2026-10-15", title: "跨",
      textChunks: ["界中"], pageTexts: ["頁一內容", "頁二內容"],
    });
    const firstSnapshot = snapshot("TEST-v2-1", [first.descriptor, second.descriptor]);
    const receipt = await writer.importV2(firstSnapshot);
    assert.equal(receipt.status, "imported");
    assert.equal(receipt.schema_version, "local-snapshot-v2");
    assert.equal(receipt.raw_objects_verified, 4);
    assert.equal(receipt.derived_objects_verified.envelope, 2);
    assert.equal(receipt.derived_objects_verified.payload, 2);
    assert.equal(receipt.derived_objects_verified.page, 4);
    assert.ok(receipt.derived_objects_verified.search_chunk >= 8);
    assert.ok(Buffer.byteLength(canonical(first.descriptor)) <= 1024);
    assert.equal(await writer.getDatasetVersion("kcc-meeting-records"), "v2");

    const historical = await writer.readSnapshotVersionV2("kcc-meeting-records", "TEST-v2-1");
    assert.equal(historical.records.length, 2);
    assert.equal(historical.records[0].payload_ref.sha256 !== undefined, true);
    assert.equal(Object.hasOwn(historical.records[0], "data"), false, "v2 history stores refs, not record bodies");

    const reader = new LocalStore(dataRoot, { readOnly: true });
    const originalReadObject = reader.derivedStore.readObject.bind(reader.derivedStore);
    let payloadReads = 0;
    reader.derivedStore.readObject = async (ref, expected, options) => {
      if (expected?.kind === "payload") payloadReads += 1;
      return await originalReadObject(ref, expected, options);
    };
    try {
      const crossChunk = await reader.queryV2("kcc-meeting-records", { keyword: "界中文" });
      assert.equal(crossChunk.local_match_count, 1);
      assert.equal(crossChunk.records[0].id, "MEET-1");
      const crossChannel = await reader.queryV2("kcc-meeting-records", {
        keyword: "跨界", predicate: (record) => record.id === "MEET-2",
      });
      assert.equal(crossChannel.local_match_count, 0, "keyword must not cross title/text channel boundaries");
      const noHit = await reader.queryV2("kcc-meeting-records", { keyword: "不存在的關鍵字" });
      assert.equal(noHit.local_match_count, 0);
      assert.equal(payloadReads, 0, "query and zero-hit search must not hydrate payloads");

      const topK = await reader.queryV2("kcc-meeting-records", {
        orderBy: { field: "date", descending: true }, limit: 1,
        pageSearch: { keyword: "命中", slots: ["data.pages"], normalizeWhitespace: true },
      });
      assert.equal(topK.records.length, 1);
      assert.equal(topK.records[0].id, "MEET-2");
      assert.equal(topK.page_matches.length, 0, "page search runs after top-K selection");
      assert.equal(payloadReads, 0);

      const oneMeeting = await reader.queryV2("kcc-meeting-records", {
        predicate: (record) => record.id === "MEET-1", limit: 1,
        pageSearch: { keyword: "命中", slots: ["data.pages"], normalizeWhitespace: true },
      });
      assert.equal(oneMeeting.page_matches.length, 1);
      assert.equal(oneMeeting.page_matches[0].page_number, 1);
      assert.equal(oneMeeting.page_matches[0].page_ref.sha256, first.pages[0].ref.sha256);
      assert.equal(oneMeeting.empty_text_page_count, 1);
      assert.equal(payloadReads, 0);
      const hydrated = await reader.hydrateV2("kcc-meeting-records", oneMeeting.records[0]);
      assert.deepEqual(hydrated, first.payloadBytes);
      assert.equal(payloadReads, 1);
      const payloadPath = writer.derivedStore.objectPath(first.descriptor.payload_ref.sha256);
      const goodPayloadBytes = await readFile(payloadPath);
      await writeFile(payloadPath, Buffer.from(`X${goodPayloadBytes.toString("utf8").slice(1)}`));
      await expectStoreError(reader.hydrateV2("kcc-meeting-records", oneMeeting.records[0]), "SNAPSHOT_UNVERIFIED");
      await writeFile(payloadPath, goodPayloadBytes);

      const pageBoundary = await reader.queryV2("kcc-meeting-records", {
        predicate: (record) => record.id === "MEET-2", limit: 1,
        pageSearch: { keyword: "頁一內容頁二", slots: ["data.pages"] },
      });
      assert.equal(pageBoundary.total_page_matches, 0, "page search must not cross page boundaries");
    } finally {
      reader.close();
    }

    const fullScanStore = new LocalStore(path.join(temp, "all-page-scan"), { readOnly: false });
    try {
      const descriptors = [];
      for (let index = 0; index < 5; index++) {
        const item = await prepareRecord(fullScanStore, { id: `SCAN-${index}`, date: "2026-10-15", title: "TARGET metadata", textChunks: ["TARGET metadata"], pageTexts: [index === 4 ? "TARGET actual page" : "unrelated page"] });
        descriptors.push(item.descriptor);
      }
      await fullScanStore.importV2(snapshot("all-matching-page-scan", descriptors));
      const scanned = await fullScanStore.queryV2("kcc-meeting-records", { keyword: "TARGET", limit: 1, includePageRefs: true,
        pageSearch: { keyword: "TARGET", allMatchingRecords: true, slots: ["data.pages"], maxMatches: 1, maxSnippets: 1 } });
      assert.equal(scanned.local_match_count, 5);
      assert.equal(scanned.records.length, 1); assert.equal(scanned.records[0].id, "SCAN-4");
      assert.equal(scanned.page_matches.length, 1); assert.equal(scanned.matched_pages_count, 1);
      assert.equal(scanned.page_scan_scope, "entire_verified_snapshot"); assert.equal(scanned.page_search_complete, true);
    } finally { fullScanStore.close(); }

    const rawPath = path.join(dataRoot, "raw", "sha256", second.descriptor.raw_sha256.slice(0, 2), second.descriptor.raw_sha256);
    const goodRawBytes = await readFile(rawPath);
    await writeFile(rawPath, Buffer.from(`X${goodRawBytes.toString("utf8").slice(1)}`));
    const rawTamperReader = new LocalStore(dataRoot, { readOnly: true });
    try {
      await expectStoreError(rawTamperReader.queryV2("kcc-meeting-records", { keyword: "不存在" }), "SNAPSHOT_UNVERIFIED");
    } finally {
      rawTamperReader.close();
      await writeFile(rawPath, goodRawBytes);
    }

    const secondSnapshot = snapshot("TEST-v2-2", [first.descriptor, second.descriptor]);
    await writer.importV2(secondSnapshot);
    const restored = await writer.restoreSnapshotV2("kcc-meeting-records", "TEST-v2-1");
    assert.equal(restored.status, "imported");

    // A long-lived reader that already verified this release must still notice a later tamper.
    const cachedReader = new LocalStore(dataRoot, { readOnly: true });
    const verifiedOnce = await cachedReader.queryV2("kcc-meeting-records", { keyword: "不存在" });
    const servedFromCache = await cachedReader.queryV2("kcc-meeting-records", { keyword: "不存在" });
    assert.equal(cachedReader.releaseVerificationCache.size, 1, "a passed v2 verification is remembered");
    assert.deepEqual(servedFromCache.release, verifiedOnce.release, "a cached verification returns the same release facts");

    const db = new DatabaseSync(path.join(dataRoot, "index.sqlite"));
    db.prepare("UPDATE v2_search_blocks SET text=? WHERE dataset=? AND id=? AND block_index=0").run("TAMPERED", "kcc-meeting-records", "MEET-1");
    db.close();
    try {
      await expectStoreError(cachedReader.queryV2("kcc-meeting-records", { keyword: "不存在" }), "SNAPSHOT_UNVERIFIED");
    } finally { cachedReader.close(); }
    const tamperedReader = new LocalStore(dataRoot, { readOnly: true });
    try {
      await expectStoreError(tamperedReader.queryV2("kcc-meeting-records", { keyword: "TAMPERED" }), "SNAPSHOT_UNVERIFIED");
      await expectStoreError(tamperedReader.queryV2("kcc-meeting-records", { keyword: "不存在" }), "SNAPSHOT_UNVERIFIED");
    } finally {
      tamperedReader.close();
    }

    const tamperRoot = path.join(temp, "cas-tamper");
    await mkdir(tamperRoot);
    const derived = new DerivedStore(tamperRoot, { readOnly: false });
    const ref = await derived.putObject({
      kind: "search-chunk", dataset: "kcc-meeting-records", id: "CAS-1",
      source: "https://cissearch.kcc.gov.tw/", raw_sha256: sha256(Buffer.from("raw")),
      schema_version: "kcc-search-chunk-v2", body: Buffer.from("SAFE"),
    });
    const objectPath = derived.objectPath(ref.sha256);
    await writeFile(objectPath, Buffer.from("TAMPERED CAS"));
    await assert.rejects(derived.readObject(ref, {
      kind: "search-chunk", dataset: "kcc-meeting-records", id: "CAS-1",
      source: "https://cissearch.kcc.gov.tw/", raw_sha256: sha256(Buffer.from("raw")),
      schema_version: "kcc-search-chunk-v2",
    }), (error) => error?.reasonCode === "SNAPSHOT_UNVERIFIED");

    const streamRoot = path.join(temp, "stream-cas");
    await mkdir(streamRoot);
    const streamStore = new DerivedStore(streamRoot, { readOnly: false });
    const streamBody = Buffer.from("跨區塊搜尋測試".repeat(20_000));
    const streamBinding = {
      kind: "search-chunk", dataset: "kcc-meeting-records", id: "STREAM-1",
      source: "https://cissearch.kcc.gov.tw/", raw_sha256: sha256(Buffer.from("stream-raw")),
      schema_version: "kcc-search-chunk-v2",
    };
    async function* bodyStream() {
      for (let offset = 0; offset < streamBody.length; offset += 7919) yield streamBody.subarray(offset, offset + 7919);
    }
    const streamRef = await streamStore.putObjectStream({ ...streamBinding, body_byte_length: streamBody.length, body: bodyStream() });
    const streamed = [];
    for await (const part of streamStore.readObjectStream(streamRef, streamBinding, { chunkBytes: 4096 })) streamed.push(part);
    assert.deepEqual(Buffer.concat(streamed), streamBody);
    const hardlinkPath = path.join(temp, "unexpected-hardlink.obj");
    await link(streamStore.objectPath(streamRef.sha256), hardlinkPath);
    await assert.rejects(streamStore.readObject(streamRef, streamBinding), (error) => error?.reasonCode === "SNAPSHOT_UNVERIFIED");

    const symlinkRoot = path.join(temp, "symlink-cas");
    const symlinkTarget = path.join(temp, "symlink-target");
    await mkdir(symlinkRoot);
    await mkdir(symlinkTarget);
    const symlinkStore = new DerivedStore(symlinkRoot, { readOnly: false });
    const symlinkInput = {
      kind: "search-chunk", dataset: "kcc-meeting-records", id: "SYMLINK-1",
      source: "https://cissearch.kcc.gov.tw/", raw_sha256: sha256(Buffer.from("symlink-raw")),
      schema_version: "kcc-search-chunk-v2", body: Buffer.from("blocked"),
    };
    const symlinkRef = DerivedStore.calculateRef(symlinkInput);
    await mkdir(path.join(symlinkRoot, "derived", "sha256"), { recursive: true });
    await symlink(symlinkTarget, path.join(symlinkRoot, "derived", "sha256", symlinkRef.sha256.slice(0, 2)), "dir");
    await assert.rejects(symlinkStore.putObject(symlinkInput), (error) => error?.reasonCode === "SNAPSHOT_UNVERIFIED");
    assert.deepEqual(await readdir(symlinkTarget), []);

    process.stdout.write("PASS local v2 descriptor import, streaming mirrors, top-K, page search, hydration, history restore, and tamper rejection\n");
  } finally {
    writer.close();
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`local v2 storage test failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
