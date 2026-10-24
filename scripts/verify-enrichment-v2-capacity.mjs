#!/usr/bin/env node
// Synthetic fixture preparation uses eight bounded lanes; production collectors remain single-writer.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DerivedStore } from "../src/local/derived-store.mjs";
import {
  KCC_SEARCH_CHUNK_BYTES,
  packKccV2PdfPage,
  packKccV2Record,
} from "../src/local/kcc-payload.mjs";
import { LocalStore } from "../src/local/store.mjs";

const TOOL = "verify-enrichment-v2-capacity";
const MARKER_NAME = ".verify-enrichment-v2-capacity.json";
const MARKER_SCHEMA = "synthetic-kcc-enrichment-v2-capacity-run-v1";
const DATASETS = ["kcc-proposal-details", "kcc-proposal-attachments", "kcc-meeting-records"];
const DEFAULTS = { detailsCount: 32_391, meetingsCount: 2_198 };
const PREPARE_CONCURRENCY = 8;
const MEETING_SEARCH_KEYWORD = "TEST議事容量命中";
const CROSS_BOUNDARY_KEYWORD = "跨界中文詞";
const MEETING_BASE = 87_000_000_000_000_000_000n;
const PROPOSAL_BASE = 2_100_000_000n;
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`不認得的參數：${token}`);
    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    const value = equals < 0 ? argv[++index] : token.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`參數 --${key} 需要值`);
    if (Object.hasOwn(values, key)) throw new Error(`參數 --${key} 不可重複`);
    values[key] = value;
  }
  for (const key of Object.keys(values)) {
    if (!["root", "phase", "details-count", "meetings-count"].includes(key)) throw new Error(`不支援的參數 --${key}`);
  }
  if (!values.root || !values.phase) throw new Error("必須提供 --root 與 --phase prepare|query|restore");
  if (!["prepare", "query", "restore"].includes(values.phase)) throw new Error("--phase 僅接受 prepare、query 或 restore");
  if (!path.isAbsolute(values.root)) throw new Error("--root 必須是絕對路徑");
  const parseCount = (key, fallback) => {
    const value = values[key];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new Error(`--${key} 必須是正整數`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > 100_000) throw new Error(`--${key} 必須介於 1 至 100000`);
    return number;
  };
  return {
    root: path.resolve(values.root),
    phase: values.phase,
    detailsCount: parseCount("details-count", DEFAULTS.detailsCount),
    meetingsCount: parseCount("meetings-count", DEFAULTS.meetingsCount),
    countsSpecified: values["details-count"] !== undefined || values["meetings-count"] !== undefined,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function metrics() {
  return {
    memory_usage_bytes: process.memoryUsage(),
    resource_usage: process.resourceUsage(),
  };
}

function elapsedMs(started) {
  return Math.round((performance.now() - started) * 10) / 10;
}

function nowIso() {
  return new Date().toISOString();
}

function proposalId(index) {
  return (PROPOSAL_BASE + BigInt(index)).toString();
}

function meetingId(index) {
  return (MEETING_BASE + BigInt(index)).toString();
}

function makeNearEightKiBText(seed, targetBytes) {
  const unit = `SYNTHETIC TEST ${seed} 中文「引號」\"quoted\"\n保留換行🙂 `;
  const unitBytes = Buffer.byteLength(unit, "utf8");
  let value = "";
  while (Buffer.byteLength(value, "utf8") + unitBytes <= targetBytes) value += unit;
  const remainder = targetBytes - Buffer.byteLength(value, "utf8");
  value += "x".repeat(remainder);
  assert.equal(Buffer.byteLength(value, "utf8"), targetBytes);
  return value;
}

function insertAtCodePointBoundary(value, index, insertion) {
  let safeIndex = index;
  if (safeIndex > 0 && safeIndex < value.length) {
    const current = value.charCodeAt(safeIndex);
    if (current >= 0xdc00 && current <= 0xdfff) safeIndex += 1;
  }
  return `${value.slice(0, safeIndex)}${insertion}${value.slice(safeIndex)}`;
}

function makeMeetingPageText({ recordIndex, versionIndex, pageNumber, isBoundaryTarget = false }) {
  const seed = `meeting-${recordIndex}-pdf-${versionIndex}-page-${pageNumber}`;
  if (isBoundaryTarget) {
    const firstCodePoint = [...CROSS_BOUNDARY_KEYWORD][0];
    const prefixBytes = KCC_SEARCH_CHUNK_BYTES - Buffer.byteLength(firstCodePoint, "utf8");
    const prefix = "x".repeat(prefixBytes);
    const separator = `\n${MEETING_SEARCH_KEYWORD}\n`;
    const suffixBytes = 74_000 + (recordIndex % 113) - Buffer.byteLength(prefix + CROSS_BOUNDARY_KEYWORD + separator, "utf8");
    const suffix = makeNearEightKiBText(seed, suffixBytes);
    const value = `${prefix}${CROSS_BOUNDARY_KEYWORD}${separator}${suffix}`;
    assert.equal(Buffer.byteLength(prefix + firstCodePoint, "utf8"), KCC_SEARCH_CHUNK_BYTES,
      "the first Chinese code point must end exactly at a 64 KiB boundary");
    assert.ok(Buffer.byteLength(value, "utf8") > KCC_SEARCH_CHUNK_BYTES);
    return value;
  }
  const targetBytes = 7_600 + ((recordIndex * 17 + versionIndex * 101 + pageNumber * 37) % 1_001);
  const marker = `\n${MEETING_SEARCH_KEYWORD}\n`;
  const base = makeNearEightKiBText(seed, targetBytes - Buffer.byteLength(marker, "utf8"));
  return insertAtCodePointBoundary(base, Math.floor(base.length / 2), marker);
}

async function writeAtomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, file);
}

async function readOwnMarker(root) {
  const rootEntry = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`root 不存在：${root}`);
    throw error;
  });
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error("--root 必須是一般資料夾，不能是 symlink 或一般檔案");
  const markerPath = path.join(root, MARKER_NAME);
  const entry = await lstat(markerPath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`找不到本工具 marker：${markerPath}`);
    throw error;
  });
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("本工具 marker 必須是一般檔案");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker?.tool !== TOOL || marker?.schema !== MARKER_SCHEMA || marker?.root !== root || !marker.run_id) {
    throw new Error("root marker 不屬於本工具或其根目錄不符；停止以免碰觸既有資料");
  }
  return { marker, markerPath };
}

async function ensurePrepareRoot(root, counts) {
  let rootEntry = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (rootEntry?.isSymbolicLink() || (rootEntry && !rootEntry.isDirectory())) {
    throw new Error("--root 必須是一般資料夾，不能是 symlink 或一般檔案");
  }
  if (!rootEntry) {
    await mkdir(root, { recursive: true });
    rootEntry = await lstat(root);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error("建立後的 --root 不是一般資料夾");
  }

  const markerPath = path.join(root, MARKER_NAME);
  const markerEntry = await lstat(markerPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!markerEntry) {
    const entries = await readdir(root);
    if (entries.length) throw new Error("prepare 拒絕已有內容但沒有本工具私有 marker 的 root");
    const marker = {
      tool: TOOL,
      schema: MARKER_SCHEMA,
      run_id: randomUUID(),
      root,
      created_at: nowIso(),
      synthetic_fixture: true,
      source_label: "SYNTHETIC TEST; not an official corpus",
      counts: { ...counts, attachmentCount: counts.detailsCount },
      fixture_prepare_concurrency: PREPARE_CONCURRENCY,
      phases: {},
      snapshots: {},
    };
    await writeAtomicJson(markerPath, marker);
    return { marker, markerPath };
  }

  const { marker } = await readOwnMarker(root);
  if (marker.phases?.prepare?.status === "complete") throw new Error("此 marker 的 prepare 已完成；請執行 query/restore 或指定新的空 root");
  if (marker.counts?.detailsCount !== counts.detailsCount ||
      marker.counts?.meetingsCount !== counts.meetingsCount || marker.counts?.attachmentCount !== counts.detailsCount) {
    throw new Error("既有本工具 marker 的 counts 不同；拒絕在同一 root 混用 fixture 規模");
  }
  return { marker, markerPath };
}

export function checkPhasePid(marker, phase, identity = { pid: process.pid, timeOrigin: performance.timeOrigin }) {
  const sameProcess = (prior) => {
    if (!prior || prior.pid !== identity.pid) return false;
    if (Number.isFinite(prior.process_time_origin)) return prior.process_time_origin === identity.timeOrigin;
    // Older markers recorded only PID. Separate containers can both use PID 14;
    // an already-ended phase predating this Node process is a fresh process.
    const ended = Date.parse(prior.finished_at || prior.updated_at || "");
    return !["complete", "failed"].includes(prior.status) || !Number.isFinite(ended) || ended >= identity.timeOrigin;
  };
  if (sameProcess(marker.phases?.[phase])) throw new Error(`${phase} 必須在新的作業系統程序執行`);
  if (phase !== "prepare" && sameProcess(marker.phases?.prepare)) {
    throw new Error(`${phase} 必須在不同於 prepare 的新作業系統程序執行`);
  }
}

async function setPhase(marker, markerPath, phase, status, extra = {}) {
  marker.phases ||= {};
  marker.phases[phase] = {
    ...(marker.phases[phase] || {}),
    status,
    pid: process.pid,
    process_time_origin: performance.timeOrigin,
    updated_at: nowIso(),
    ...extra,
  };
  await writeAtomicJson(markerPath, marker);
}

async function appendProgress(root, phase, record) {
  const line = JSON.stringify({ tool: TOOL, phase, synthetic_fixture: true, ...record });
  await appendFile(path.join(root, `progress-${phase}.jsonl`), `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function baseRecord({ id, dataset, sourceUrl, rawSha, retrievedAt, title, text, data }) {
  return { id, title, text, data, source_url: sourceUrl, retrieved_at: retrievedAt, raw_sha256: rawSha };
}

async function putRaw(store, bytes) {
  const rawSha = sha256(bytes);
  await store.putRawObject({ sha256: rawSha, bytes_base64: bytes.toString("base64") });
  return rawSha;
}

function snapshotFor(dataset, snapshotId, descriptors, count) {
  return {
    schema_version: "local-snapshot-v2",
    dataset,
    snapshot_id: snapshotId,
    coverage: { scope: "SYNTHETIC TEST capacity fixture", complete: true, source_total: count },
    parser_version: "SYNTHETIC-TEST-v2",
    validator_version: "SYNTHETIC-TEST-v2",
    validation_status: "passed",
    records: descriptors,
  };
}

function fullSnapshotId(marker, dataset) {
  const suffix = dataset === "kcc-proposal-details" ? "details"
    : dataset === "kcc-proposal-attachments" ? "attachments" : "meetings";
  return `TEST-capacity-v2-${marker.run_id}-${suffix}`;
}

function assertReceipt(receipt, dataset, count, expectedStatus) {
  assert.equal(receipt.schema_version, "local-snapshot-v2");
  assert.equal(receipt.dataset, dataset);
  assert.equal(receipt.record_count, count);
  assert.equal(receipt.status, expectedStatus);
}

async function importFullDataset(store, marker, dataset, count, makeRecord, root, phaseStarted) {
  const descriptors = new Array(count);
  const laneCount = Math.min(PREPARE_CONCURRENCY, count);
  let nextIndex = 0;
  let completed = 0;
  let totalRawBytes = 0;
  let firstError;
  let progressWrites = Promise.resolve();
  const queueProgress = (record) => {
    progressWrites = progressWrites.then(() => appendProgress(root, "prepare", record));
    return progressWrites;
  };
  const worker = async () => {
    while (!firstError) {
      const index = nextIndex++;
      if (index >= count) return;
      try {
        const { record, rawBytes, pageRefs = [], rawBytesWritten = rawBytes.length } = await makeRecord(index);
        const rawSha = await putRaw(store, rawBytes);
        assert.equal(record.raw_sha256, rawSha, `${dataset} ${record.id} raw SHA binding`);
        const packed = await packKccV2Record(store.derivedStore, { dataset, record, page_refs: pageRefs });
        descriptors[index] = packed.descriptor;
        totalRawBytes += rawBytesWritten;
        completed += 1;
        if (completed % 1_000 === 0 || completed === count) {
          await queueProgress({
            at: nowIso(),
            dataset,
            done: completed,
            total: count,
            descriptors_completed: completed,
            lanes: laneCount,
            raw_bytes_written: totalRawBytes,
            phase_ms: elapsedMs(phaseStarted),
            pid: process.pid,
            ...metrics(),
          });
        }
      } catch (error) {
        firstError ||= error;
        throw error;
      }
    }
  };

  // Wait for every active lane before propagating any error; no background file
  // writes may continue after this function rejects.
  const laneResults = await Promise.allSettled(Array.from({ length: laneCount }, () => worker()));
  await progressWrites;
  const laneFailure = laneResults.find((result) => result.status === "rejected");
  if (laneFailure) throw firstError || laneFailure.reason;
  assert.equal(completed, count, `${dataset} preparation must finish every record`);
  assert.ok(descriptors.every((descriptor) => descriptor && typeof descriptor.id === "string"),
    `${dataset} descriptors must be stored at their original record index`);

  assert.equal(descriptors.length, count);
  const snapshotId = fullSnapshotId(marker, dataset);
  const snapshot = snapshotFor(dataset, snapshotId, descriptors, count);
  await appendProgress(root, "prepare", {
    at: nowIso(),
    event: "full_import_started",
    dataset,
    record_count: descriptors.length,
    phase_ms: elapsedMs(phaseStarted),
    pid: process.pid,
    ...metrics(),
  });
  const receipt = await store.importV2(snapshot);
  assertReceipt(receipt, dataset, count, "imported");
  marker.snapshots[dataset] = {
    snapshot_id: snapshotId,
    record_count: count,
    manifest_sha256: receipt.manifest_sha256,
    initial_import_status: receipt.status,
  };
  await appendProgress(root, "prepare", {
    at: nowIso(),
    event: "full_import_completed",
    dataset,
    record_count: receipt.record_count,
    status: receipt.status,
    manifest_sha256: receipt.manifest_sha256,
    raw_bytes_written: totalRawBytes,
    phase_ms: elapsedMs(phaseStarted),
    pid: process.pid,
    ...metrics(),
  });
}

async function makeProposalRecord(store, index, dataset) {
  const id = proposalId(index + 1);
  const retrievedAt = new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
  if (dataset === "kcc-proposal-details") {
    const sourceUrl = `https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=${id}&ct=TEST`;
    const body = makeNearEightKiBText(`proposal-detail-${id}`, 7_800 + ((index * 73) % 401));
    const rawBytes = Buffer.from(
      `<html><body><input id="ContentPlaceHolder1_hidProposalSN" name="ctl00$ContentPlaceHolder1$hidProposalSN" value="${id}"><!-- SYNTHETIC TEST ${id} -->\n</body></html>`,
      "utf8",
    );
    const rawSha = sha256(rawBytes);
    const record = baseRecord({
      id,
      dataset,
      sourceUrl,
      rawSha,
      retrievedAt,
      title: `SYNTHETIC TEST 議案 ${id}`,
      text: "",
      data: {
        proposal_sn: id,
        detail_url: sourceUrl,
        subject: `SYNTHETIC TEST 提案 ${id}`,
        description: body,
      },
    });
    return { record, rawBytes };
  }

  const sourceUrl = `https://cissearch.kcc.gov.tw/Common/GetAttachmentList.ashx?f=1&s=${id}&t=TEST`;
  const description = makeNearEightKiBText(`proposal-attachments-${id}`, 7_600 + ((index * 73 + 191) % 401));
  const rawBytes = Buffer.from(`SYNTHETIC TEST official attachment-list response\nproposal=${id}\n${index}\n`, "utf8");
  const rawSha = sha256(rawBytes);
  const record = baseRecord({
    id,
    dataset,
    sourceUrl,
    rawSha,
    retrievedAt,
    title: `SYNTHETIC TEST 附件清單 ${id}`,
    text: "",
    data: {
      proposal_sn: id,
      parent_id: id,
      description,
      attachments: [{
        name: `SYNTHETIC TEST 附件 ${id}.pdf`,
        file_type: "pdf",
        url: `https://cissearch.kcc.gov.tw/Download/Attachment/${id}/TEST-${index + 1}.pdf`,
      }],
      total_files: 1,
      attachment_originals_complete: true,
    },
  });
  return { record, rawBytes };
}

function utcDateFor(index) {
  return new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
}

async function makeMeetingRecord(store, index) {
  const id = meetingId(index);
  const date = utcDateFor(index);
  const versionDefinitions = [];
  const pageRefs = [];
  let currentRawBytes;
  for (const versionIndex of [0, 1]) {
    const versionName = versionIndex === 0 ? "original-v1" : "revision-v2";
    const sourceUrl = `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/${versionName}.pdf`;
    const rawBytes = Buffer.from(`SYNTHETIC TEST PDF bytes\nrecord=${id}\nversion=${versionName}\n`, "utf8");
    const rawSha = sha256(rawBytes);
    if (versionIndex === 0) await putRaw(store, rawBytes);
    else currentRawBytes = rawBytes;
    const texts = [];
    for (const pageNumber of [1, 2]) {
      const pageText = makeMeetingPageText({
        recordIndex: index,
        versionIndex,
        pageNumber,
        isBoundaryTarget: index === 0 && versionIndex === 1 && pageNumber === 1,
      });
      texts.push(pageText);
      pageRefs.push(await packKccV2PdfPage(store.derivedStore, {
        dataset: "kcc-meeting-records",
        id,
        source: sourceUrl,
        raw_sha256: rawSha,
        page_number: pageNumber,
        text: pageText,
      }));
    }
    versionDefinitions.push({
      source_url: sourceUrl,
      download_url: sourceUrl,
      pdf_url: sourceUrl,
      file_type: "pdf",
      raw_sha256: rawSha,
      retrieved_at: `${date}T10:00:00.000Z`,
      byte_length: rawBytes.length,
      total_pages: texts.length,
      pages: texts.map((_, pageIndex) => ({ page: pageIndex + 1 })),
    });
  }

  const currentVersion = versionDefinitions[1];
  const rawSha = currentVersion.raw_sha256;
  const record = {
    ...baseRecord({
      id,
      dataset: "kcc-meeting-records",
      sourceUrl: currentVersion.source_url,
      rawSha,
      retrievedAt: `${date}T10:00:00.000Z`,
      title: `SYNTHETIC TEST 議事錄 ${id}`,
      text: "",
      data: {
        record_id: id,
        term: 4,
        date,
        meeting_name: `SYNTHETIC TEST 委員會會議 ${id}`,
        pdf_url: currentVersion.source_url,
        total_pages: 2,
        fulltext_complete: true,
        content_index_status: "indexed",
        originals_complete: true,
        pages: currentVersion.pages.map((page) => ({ ...page })),
        pdf_versions: versionDefinitions,
        original_versions: versionDefinitions.map((version) => structuredClone(version)),
      },
    }),
    text_recipe: { kind: "page-join", slot: "data.pages", separator: "\n" },
  };
  return {
    record,
    rawBytes: currentRawBytes,
    rawBytesWritten: currentRawBytes.length + Buffer.byteLength(`SYNTHETIC TEST PDF bytes\nrecord=${id}\nversion=original-v1\n`, "utf8"),
    pageRefs,
  };
}

async function loadRegistry() {
  const productionBundle = path.join(SOURCE_ROOT, "dist-local", "registry.mjs");
  const bundleEntry = await lstat(productionBundle).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (bundleEntry) {
    if (bundleEntry.isSymbolicLink() || !bundleEntry.isFile()) throw new Error("dist-local/registry.mjs 必須是一般檔案");
    const module = await import(`${pathToFileURL(productionBundle).href}?capacity=${randomUUID()}`);
    return { createLocalRegistry: module.createLocalRegistry, temp: null, source: productionBundle };
  }

  // Development-only fallback: native images should run the bundled production
  // registry and do not need esbuild installed as a production dependency.
  const { build } = await import("esbuild");
  const temp = await mkdtemp(path.join(SOURCE_ROOT, `.tmp-enrichment-v2-capacity-${process.pid}-`));
  const outfile = path.join(temp, "registry.mjs");
  try {
    await build({
      entryPoints: [path.join(SOURCE_ROOT, "src/local/registry.mjs")],
      outfile,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const module = await import(`${pathToFileURL(outfile).href}?capacity=${randomUUID()}`);
    return { createLocalRegistry: module.createLocalRegistry, temp, source: outfile };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

async function preparePhase(options, marker, markerPath, started) {
  checkPhasePid(marker, "prepare");
  marker.fixture_prepare_concurrency = PREPARE_CONCURRENCY;
  await setPhase(marker, markerPath, "prepare", "running", {
    started_at: nowIso(),
    counts: { ...marker.counts },
    fixture_prepare_concurrency: PREPARE_CONCURRENCY,
  });
  const store = new LocalStore(options.root, { readOnly: false });
  assert.ok(store.derivedStore instanceof DerivedStore, "must use the production DerivedStore implementation");
  try {
    const originalImport = store.importV2.bind(store);
    const importCounts = new Map();
    store.importV2 = async (snapshot) => {
      importCounts.set(snapshot.dataset, (importCounts.get(snapshot.dataset) || 0) + 1);
      return await originalImport(snapshot);
    };
    const proposalDatasets = ["kcc-proposal-details", "kcc-proposal-attachments"];
    for (const dataset of proposalDatasets) {
      await importFullDataset(
        store,
        marker,
        dataset,
        options.detailsCount,
        async (index) => await makeProposalRecord(store, index, dataset),
        options.root,
        started,
      );
      await writeAtomicJson(markerPath, marker);
      assert.equal(importCounts.get(dataset), 1, `${dataset} full release must use exactly one importV2 call`);
    }

    await importFullDataset(
      store,
      marker,
      "kcc-meeting-records",
      options.meetingsCount,
      async (index) => await makeMeetingRecord(store, index),
      options.root,
      started,
    );
    await writeAtomicJson(markerPath, marker);
    assert.equal(importCounts.get("kcc-meeting-records"), 1, "meeting full release must use exactly one importV2 call");
    assert.deepEqual([...importCounts.entries()].sort(), DATASETS.map((dataset) => [dataset, 1]).sort());
    await setPhase(marker, markerPath, "prepare", "complete", {
      started_at: marker.phases.prepare.started_at,
      finished_at: nowIso(),
      duration_ms: elapsedMs(started),
      fixture_prepare_concurrency: PREPARE_CONCURRENCY,
      full_dataset_import_calls: Object.fromEntries(importCounts),
      snapshot_ids: Object.fromEntries(DATASETS.map((dataset) => [dataset, marker.snapshots[dataset].snapshot_id])),
    });
  } finally {
    store.close();
  }
}

function instrumentQueryStore(store) {
  const stats = { query_runs: [], payload_hydrations: 0, page_body_reads: [] };
  const queryV2 = store.queryV2.bind(store);
  store.queryV2 = async (dataset, options) => {
    const result = await queryV2(dataset, options);
    stats.query_runs.push({
      dataset,
      record_count: result.release?.record_count,
      metadata_only: result.metadata_only === true,
      limit: options?.limit,
      keyword: options?.keyword ?? "",
      ordered: Boolean(options?.orderBy),
      page_search: Boolean(options?.pageSearch),
    });
    return result;
  };
  const hydrateV2 = store.hydrateV2.bind(store);
  store.hydrateV2 = async (...args) => {
    stats.payload_hydrations += 1;
    return await hydrateV2(...args);
  };
  const readDerivedObject = store.readDerivedObject.bind(store);
  store.readDerivedObject = async (ref, expected, options) => {
    if (expected?.kind === "pdf-page") stats.page_body_reads.push(ref.sha256);
    return await readDerivedObject(ref, expected, options);
  };
  return stats;
}

function registryTool(registry, name) {
  const tool = registry.find((entry) => entry.name === name);
  assert.ok(tool, `registry must provide ${name}`);
  return tool;
}

async function expectRegistryMiss(tool, args, stats, dataset, recordCount) {
  const beforeQueries = stats.query_runs.length;
  const beforeHydrations = stats.payload_hydrations;
  await assert.rejects(() => tool.handler(args), (error) => {
    assert.equal(error?.reasonCode, "LOCAL_DATA_UNAVAILABLE", "the absent identifier should be the only reason for this miss");
    return true;
  });
  assert.equal(stats.query_runs.length, beforeQueries + 1);
  const run = stats.query_runs.at(-1);
  assert.equal(run.dataset, dataset);
  assert.equal(run.record_count, recordCount, `${dataset} metadata scan must verify the full release`);
  assert.equal(run.metadata_only, true);
  assert.equal(stats.payload_hydrations, beforeHydrations, "zero-hit queries must hydrate zero payloads");
}

async function queryPhase(options, marker, markerPath, started) {
  if (marker.phases?.prepare?.status !== "complete") throw new Error("query 需要已完成的 prepare phase");
  checkPhasePid(marker, "query");
  await setPhase(marker, markerPath, "query", "running", { started_at: nowIso() });
  const store = new LocalStore(options.root, { readOnly: true });
  let registryTemp;
  try {
    const stats = instrumentQueryStore(store);
    const loaded = await loadRegistry();
    registryTemp = loaded.temp;
    const registry = loaded.createLocalRegistry(store);
    const detailCount = marker.counts.detailsCount;
    const attachmentCount = marker.counts.attachmentCount;
    const meetingCount = marker.counts.meetingsCount;

    await expectRegistryMiss(registryTool(registry, "kcc_get_attachments"), { proposal_sn: "99999999999999999998" },
      stats, "kcc-proposal-attachments", attachmentCount);

    const selectedProposalId = proposalId(1);
    const detailQueryCount = stats.query_runs.length;
    const selectedProposal = await registryTool(registry, "kcc_get_proposal").handler({ proposal_sn: selectedProposalId });
    assert.equal(selectedProposal.data.proposal_sn, selectedProposalId);
    assert.equal(Buffer.byteLength(selectedProposal.data.description, "utf8"), 7_800,
      "a full detail response must hydrate only the selected synthetic case");
    assert.equal(selectedProposal.data.local_provenance.dataset, "kcc-proposal-details");
    assert.equal(stats.query_runs.length, detailQueryCount + 1);
    assert.equal(stats.query_runs.at(-1).dataset, "kcc-proposal-details");
    assert.equal(stats.query_runs.at(-1).record_count, detailCount);
    assert.equal(stats.payload_hydrations, 1, "one selected detail request may hydrate exactly one payload");

    const latestTool = registryTool(registry, "kcc_search_meeting_record_content");
    const hydrationsBeforeLatest = stats.payload_hydrations;
    const latest = await latestTool.handler({ keyword: MEETING_SEARCH_KEYWORD, limit_records: 15 });
    const expectedLatestCount = Math.min(15, meetingCount);
    assert.equal(latest.data.attempted_records_count, expectedLatestCount);
    assert.equal(latest.data.records.length, expectedLatestCount);
    assert.equal(latest.meta.limit_records, 15, "the production handler must retain its 15-record cap");
    assert.equal(latest.meta.record_count, meetingCount);
    assert.equal(latest.meta.omitted_local_records, Math.max(0, meetingCount - expectedLatestCount));
    assert.equal(latest.data.records[0].record_id, meetingId(meetingCount - 1), "latest-first order must select the newest IDs");
    assert.equal(latest.status, meetingCount > 15 ? "partial" : "success",
      "the real handler marks a capped latest-15 result partial when records are omitted");
    assert.equal(stats.payload_hydrations, hydrationsBeforeLatest, "latest metadata/page search must not hydrate payloads");

    const boundaryRecordIndex = 0;
    const boundaryRecordId = meetingId(boundaryRecordIndex);
    const page2 = makeMeetingPageText({ recordIndex: boundaryRecordIndex, versionIndex: 1, pageNumber: 2 });
    const beforePageReads = stats.page_body_reads.length;
    const single = await registryTool(registry, "kcc_get_meeting_record").handler({
      record_id: boundaryRecordId,
      keyword: CROSS_BOUNDARY_KEYWORD,
      page: 2,
    });
    assert.equal(single.data.record_id, boundaryRecordId);
    assert.equal(single.data.total_pages, 2);
    assert.deepEqual(single.data.matches.map((match) => match.page), [1], "the Chinese keyword must match across the 64 KiB chunk edge");
    assert.equal(single.data.matches[0].match_count, 1);
    assert.ok(single.data.matches[0].snippets[0].includes(CROSS_BOUNDARY_KEYWORD));
    assert.ok(single.data.matches[0].snippets[0].length <= 60 + CROSS_BOUNDARY_KEYWORD.length + 60);
    assert.equal(single.data.page_content, page2, "single-record full-text read must return only the requested page");
    assert.ok(Buffer.byteLength(single.data.page_content, "utf8") < 16_384);
    assert.equal(stats.page_body_reads.length - beforePageReads, 1, "a specified page must read exactly one PDF page body");
    assert.equal(stats.payload_hydrations, hydrationsBeforeLatest, "specified-page retrieval must avoid payload hydration");

    const interpellations = await registryTool(registry, "search_kcg_council_interpellations").handler({
      keyword: MEETING_SEARCH_KEYWORD,
      limit: 5,
    });
    assert.ok(interpellations.data.length > 0 && interpellations.data.length <= 5);
    assert.ok(interpellations.data.every((item) => item.content_summary.includes(MEETING_SEARCH_KEYWORD)));
    assert.ok(interpellations.data.every((item) => item.content_summary.length <= 80 + MEETING_SEARCH_KEYWORD.length + 120),
      "interpellation snippets must stay within the registry's configured bounds");
    assert.equal(stats.payload_hydrations, hydrationsBeforeLatest);

    for (const dataset of DATASETS) {
      const expectedCount = marker.snapshots[dataset].record_count;
      assert.ok(stats.query_runs.some((run) => run.dataset === dataset && run.record_count === expectedCount && run.metadata_only),
        `${dataset} must have a complete metadata verification through a registry handler`);
    }
    await setPhase(marker, markerPath, "query", "complete", {
      started_at: marker.phases.query.started_at,
      finished_at: nowIso(),
      duration_ms: elapsedMs(started),
      pid: process.pid,
      query_runs: stats.query_runs,
      payload_hydrations: stats.payload_hydrations,
      single_case_full_detail: selectedProposalId,
      page_body_reads: stats.page_body_reads.length,
      latest_record_ids: latest.data.records.map((record) => record.record_id),
      boundary_record_id: boundaryRecordId,
      boundary_keyword: CROSS_BOUNDARY_KEYWORD,
      snippet_result_count: interpellations.data.length,
    });
  } finally {
    store.close();
    if (registryTemp) await rm(registryTemp, { recursive: true, force: true });
  }
}

async function verifyRetainedArtifacts(store, marker, archives) {
  const retained = {};
  for (const dataset of ["kcc-proposal-details", "kcc-proposal-attachments"]) {
    const descriptor = archives[dataset].records[0];
    const id = descriptor.id;
    await store.readRawObject(descriptor.raw_sha256, 4 * 1024 * 1024);
    const source = dataset === "kcc-proposal-details"
      ? `https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=${id}&ct=TEST`
      : `https://cissearch.kcc.gov.tw/Common/GetAttachmentList.ashx?f=1&s=${id}&t=TEST`;
    await store.derivedStore.verifyObject(descriptor.envelope_ref, {
      kind: "envelope", dataset, id, source, raw_sha256: descriptor.raw_sha256, schema_version: "kcc-envelope-v2",
    });
    retained[dataset] = { raw_sha256: descriptor.raw_sha256, envelope_sha256: descriptor.envelope_ref.sha256 };
  }

  const meetingArchive = archives["kcc-meeting-records"];
  const meetingDescriptor = meetingArchive.records[0];
  const id = meetingDescriptor.id;
  const meetingSource = `https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/revision-v2.pdf`;
  await store.readRawObject(meetingDescriptor.raw_sha256, 4 * 1024 * 1024);
  await store.derivedStore.verifyObject(meetingDescriptor.envelope_ref, {
    kind: "envelope", dataset: "kcc-meeting-records", id, source: meetingSource,
    raw_sha256: meetingDescriptor.raw_sha256, schema_version: "kcc-envelope-v2",
  });
  retained["kcc-meeting-records"] = {
    raw_sha256: meetingDescriptor.raw_sha256,
    envelope_sha256: meetingDescriptor.envelope_ref.sha256,
  };
  assert.equal(Object.keys(retained).length, DATASETS.length);
  return retained;
}

async function restorePhase(options, marker, markerPath, started) {
  if (marker.phases?.prepare?.status !== "complete" || marker.phases?.query?.status !== "complete") {
    throw new Error("restore 需要已完成的 prepare 與 query phase");
  }
  checkPhasePid(marker, "restore");
  await setPhase(marker, markerPath, "restore", "running", { started_at: nowIso() });
  const store = new LocalStore(options.root, { readOnly: false });
  try {
    const restored = {};
    for (const dataset of DATASETS) {
      const full = marker.snapshots[dataset];
      const archivedBefore = await store.readSnapshotVersionV2(dataset, full.snapshot_id);
      assert.equal(archivedBefore.records.length, full.record_count, `${dataset} full archive must exist before restore`);

      const probeId = `TEST-capacity-v2-${marker.run_id}-${dataset === "kcc-proposal-details" ? "details" : dataset === "kcc-proposal-attachments" ? "attachments" : "meetings"}-probe`;
      const probe = snapshotFor(dataset, probeId, [archivedBefore.records[0]], 1);
      const probeReceipt = await store.importV2(probe);
      assertReceipt(probeReceipt, dataset, 1, "imported");
      await appendProgress(options.root, "restore", {
        at: nowIso(),
        event: "single_record_probe_imported",
        dataset,
        probe_snapshot_id: probeId,
        active_record_count: probeReceipt.record_count,
        phase_ms: elapsedMs(started),
        pid: process.pid,
        ...metrics(),
      });

      const receipt = await store.restoreSnapshotV2(dataset, full.snapshot_id);
      assertReceipt(receipt, dataset, full.record_count, "imported");
      assert.notEqual(receipt.status, "unchanged", `${dataset} restore must rebuild the full release`);
      assert.equal(receipt.snapshot_id, full.snapshot_id);
      assert.equal(receipt.manifest_sha256, full.manifest_sha256);

      const active = await store.queryV2(dataset, { limit: 0, metadataOnly: true });
      assert.equal(active.release.record_count, full.record_count);
      assert.equal(active.release.snapshot_id, full.snapshot_id);
      assert.equal(active.release.manifest_sha256, full.manifest_sha256);
      const archivedAfter = await store.readSnapshotVersionV2(dataset, full.snapshot_id);
      assert.equal(archivedAfter.records.length, full.record_count, `${dataset} archive must remain after restore`);
      restored[dataset] = {
        probe_status: probeReceipt.status,
        restored_status: receipt.status,
        record_count: active.release.record_count,
        snapshot_id: active.release.snapshot_id,
        manifest_sha256: active.release.manifest_sha256,
      };
      await appendProgress(options.root, "restore", {
        at: nowIso(),
        event: "full_restore_verified",
        dataset,
        status: receipt.status,
        record_count: active.release.record_count,
        snapshot_id: active.release.snapshot_id,
        phase_ms: elapsedMs(started),
        pid: process.pid,
        ...metrics(),
      });
    }
    const archives = {};
    for (const dataset of DATASETS) {
      archives[dataset] = await store.readSnapshotVersionV2(dataset, marker.snapshots[dataset].snapshot_id);
    }
    const retainedArtifacts = await verifyRetainedArtifacts(store, marker, archives);
    await setPhase(marker, markerPath, "restore", "complete", {
      started_at: marker.phases.restore.started_at,
      finished_at: nowIso(),
      duration_ms: elapsedMs(started),
      restored,
      retained_artifacts: retainedArtifacts,
      cgroups_and_container_limits: "must be read by the outer runner; this script reports process RSS/resourceUsage only",
    });
  } finally {
    store.close();
  }
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw new Error(`Node.js 24+ required; found ${process.versions.node}`);
  const options = parseArgs(process.argv.slice(2));
  const phaseStarted = performance.now();
  let marker;
  let markerPath;
  if (options.phase === "prepare") {
    ({ marker, markerPath } = await ensurePrepareRoot(options.root, {
      detailsCount: options.detailsCount,
      meetingsCount: options.meetingsCount,
      attachmentCount: options.detailsCount,
    }));
  } else {
    ({ marker, markerPath } = await readOwnMarker(options.root));
    if (options.countsSpecified && (options.detailsCount !== marker.counts.detailsCount || options.meetingsCount !== marker.counts.meetingsCount)) {
      throw new Error("query/restore 的指定 counts 與 root marker 不一致");
    }
  }

  if (marker.synthetic_fixture !== true || marker.source_label !== "SYNTHETIC TEST; not an official corpus") {
    throw new Error("marker 缺少 synthetic-only 標記");
  }
  try {
    if (options.phase === "prepare") await preparePhase(options, marker, markerPath, phaseStarted);
    else if (options.phase === "query") await queryPhase(options, marker, markerPath, phaseStarted);
    else await restorePhase(options, marker, markerPath, phaseStarted);
    const result = {
      tool: TOOL,
      phase: options.phase,
      status: "complete",
      synthetic_fixture: true,
      not_a_real_corpus_gate: true,
      run_id: marker.run_id,
      root: options.root,
      counts: marker.counts,
      fixture_prepare_concurrency: marker.fixture_prepare_concurrency ?? PREPARE_CONCURRENCY,
      duration_ms: elapsedMs(phaseStarted),
      pid: process.pid,
      ...metrics(),
    };
    await appendProgress(options.root, options.phase, { event: "phase_result", at: nowIso(), ...result });
  } catch (error) {
    const phaseRecord = marker.phases?.[options.phase];
    if (phaseRecord) {
      await setPhase(marker, markerPath, options.phase, "failed", {
        started_at: phaseRecord.started_at,
        finished_at: nowIso(),
        duration_ms: elapsedMs(phaseStarted),
        error: error?.message || String(error),
      }).catch(() => {});
    }
    await appendProgress(options.root, options.phase, {
      event: "phase_result",
      at: nowIso(),
      status: "failed",
      error: error?.message || String(error),
      run_id: marker.run_id,
      duration_ms: elapsedMs(phaseStarted),
      pid: process.pid,
      ...metrics(),
    }).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ tool: TOOL, status: "failed", error: error?.message || String(error), ...metrics() })}\n`);
  process.exitCode = 1;
});
