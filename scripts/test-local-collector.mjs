import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStore } from "../src/local/store.mjs";
import {
  PROFILE_MANIFEST,
  SOURCE_MANIFEST,
  coverageFromCounts,
  fetchBounded,
  loadTypeScriptParser,
  parseCollectorArgs,
  runCollection,
  sha256Bytes,
  validateOfficialUrl,
} from "../src/ingestion/collector.mjs";

const budgetCsv = "科目名稱,本年度預算數\n高雄市政府A局,1200\n高雄市政府B局,800\n";

function mockStore() {
  const raw = new Map();
  const snapshots = new Map();
  return {
    raw,
    snapshots,
    lastInput: null,
    async putRawObject({ sha256, bytes_base64 }) {
      const bytes = Buffer.from(bytes_base64, "base64");
      assert.equal(sha256Bytes(bytes), sha256, "raw object hash must match bytes");
      raw.set(sha256, bytes);
    },
    async importSnapshot(input) {
      this.lastInput = input;
      for (const record of input.records) assert.ok(raw.has(record.raw_sha256), "record raw must be stored before snapshot import");
      const normalized = JSON.stringify(input);
      const prior = snapshots.get(input.snapshot_id);
      if (prior !== undefined) {
        assert.equal(prior, normalized, "same snapshot id must be byte-for-byte idempotent");
        return { status: "unchanged", dataset: input.dataset, snapshot_id: input.snapshot_id, record_count: input.records.length, coverage: input.coverage, idempotent: true };
      }
      snapshots.set(input.snapshot_id, normalized);
      return { status: "imported", dataset: input.dataset, snapshot_id: input.snapshot_id, record_count: input.records.length, coverage: input.coverage, idempotent: false };
    },
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("allowlist rejects private, non-HTTPS, credentialed, and lookalike URLs", async () => {
  for (const url of [
    "http://openapi.kcg.gov.tw/Api/Service/Get/x",
    "https://127.0.0.1/admin",
    "https://openapi.kcg.gov.tw.evil.example/data",
    "https://user:pass@openapi.kcg.gov.tw/data",
  ]) {
    assert.throws(() => validateOfficialUrl(url, ["openapi.kcg.gov.tw"]), { code: "URL_REJECTED" });
  }
});

test("redirect to a private address is rejected before a second request", async () => {
  let calls = 0;
  await assert.rejects(fetchBounded("https://openapi.kcg.gov.tw/start", {
    allowedHosts: ["openapi.kcg.gov.tw"], maxRetries: 0, minIntervalMs: 0,
  }, { fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  }, sleep: async () => {}, now: () => 1 }), { code: "URL_REJECTED" });
  assert.equal(calls, 1);
});

test("redirect to a non-official hostname is rejected", async () => {
  let calls = 0;
  await assert.rejects(fetchBounded("https://openapi.kcg.gov.tw/start", {
    allowedHosts: ["openapi.kcg.gov.tw"], maxRetries: 0, minIntervalMs: 0,
  }, { fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 301, headers: { location: "https://evil.example/collect" } });
  }, sleep: async () => {}, now: () => 1 }), { code: "URL_REJECTED" });
  assert.equal(calls, 1);
});

test("redirect hops are checked individually and same-host official redirect succeeds", async () => {
  const seen = [];
  const result = await fetchBounded("https://openapi.kcg.gov.tw/start", {
    allowedHosts: ["openapi.kcg.gov.tw", "data.kcg.gov.tw"], maxRetries: 0, minIntervalMs: 0,
  }, { fetchImpl: async (url) => {
    seen.push(url);
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "https://data.kcg.gov.tw/file" } });
    return new Response("ok", { status: 200 });
  }, sleep: async () => {}, now: () => 1 });
  assert.equal(result.bytes.toString(), "ok");
  assert.equal(result.redirects, 1);
  assert.deepEqual(seen, ["https://openapi.kcg.gov.tw/start", "https://data.kcg.gov.tw/file"]);
});

test("declared and streamed response bytes are capped", async () => {
  await assert.rejects(fetchBounded("https://openapi.kcg.gov.tw/large", {
    allowedHosts: ["openapi.kcg.gov.tw"], maxBytes: 4, maxRetries: 0, minIntervalMs: 0,
  }, { fetchImpl: async () => new Response("12345", { headers: { "content-length": "5" } }), sleep: async () => {}, now: () => 1 }), { code: "BYTE_LIMIT" });
  await assert.rejects(fetchBounded("https://openapi.kcg.gov.tw/large", {
    allowedHosts: ["openapi.kcg.gov.tw"], maxBytes: 4, maxRetries: 0, minIntervalMs: 0,
  }, { fetchImpl: async () => new Response("12345"), sleep: async () => {}, now: () => 1 }), { code: "BYTE_LIMIT" });
});

test("timeout is bounded and reported without leaking response data", async () => {
  await assert.rejects(fetchBounded("https://openapi.kcg.gov.tw/slow", {
    allowedHosts: ["openapi.kcg.gov.tw"], timeoutMs: 5, maxRetries: 0, minIntervalMs: 0,
  }, { fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), 100);
    signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(new DOMException("timed out", "TimeoutError"));
    }, { once: true });
  }), sleep: async () => {}, now: () => 1 }), { code: "SOURCE_TIMEOUT" });
});

test("empty parser output cannot become an empty success and pending sources stay pending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-empty-"));
  const store = mockStore();
  const tokenHtml = '<input name="__VIEWSTATE" value="state"><input name="__EVENTVALIDATION" value="validation"><input name="__VIEWSTATEGENERATOR" value="generator">';
  const resultHtml = '<select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod"><option value="07" selected>07</option></select><select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession"><option value="0704" selected>0704</option></select><input name="ctl00$ContentPlaceHolder1$txtKeyword" value="道路">';
  let calls = 0;
  const outcome = await runCollection({ profile: "proposals-pilot", root, maxPages: 1, run: true }, {
    storeFactory: () => store,
    minIntervalMs: 0,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response(tokenHtml, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "ASP.NET_SessionId=test; Path=/" } })
        : new Response(resultHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.error_code, "PARSER_EMPTY");
  assert.equal(outcome.record_count, 0);
  assert.equal(store.snapshots.size, 0, "empty parse must not advance the current collection snapshot");
  assert.equal(store.raw.size, 2, "raw pages are saved before parser validation");
  assert.ok(SOURCE_MANIFEST.some((source) => source.dataset === "kcc-meeting-records" && source.state === "pending"));
  await rm(root, { recursive: true, force: true });
});

test("proposal pilot reuses the official index parser and commits only a bounded one-page result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-proposal-"));
  const store = mockStore();
  const tokenHtml = '<input name="__VIEWSTATE" value="state"><input name="__EVENTVALIDATION" value="validation"><input name="__VIEWSTATEGENERATOR" value="generator">';
  const resultHtml = `<select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod"><option value="07" selected>07</option></select>
    <select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession"><option value="0704" selected>0704</option></select>
    <input name="ctl00$ContentPlaceHolder1$txtKeyword" value="道路">
    <table><tr><td><input name="ctl00$hidProposalSN" value="123456"><input name="ctl00$hidProposalKind" value="01"></td><td>第 1 號</td><td>交通</td><td>陳議員</td><td><a href="Detail.aspx?s=123456">道路改善案</a></td><td>審議中</td></tr></table>
    <span>共 1 筆</span>`;
  let calls = 0;
  const outcome = await runCollection({ profile: "proposals-pilot", root, maxPages: 1, run: true }, {
    storeFactory: () => store,
    minIntervalMs: 0,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response(tokenHtml, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "ASP.NET_SessionId=test; Path=/" } })
        : new Response(resultHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.record_count, 1);
  assert.equal(outcome.coverage.source_total, 1);
  assert.equal(calls, 2, "pilot only retrieves a token page and one result page");
  assert.equal(store.snapshots.size, 1);
  assert.equal(store.lastInput.records[0].id, "123456");
  assert.equal(store.lastInput.records[0].data.proposal_sn, "123456");
  assert.equal(store.lastInput.records[0].data.period, "07");
  assert.equal(store.lastInput.records[0].data.session, "0704");
  assert.equal(store.lastInput.records[0].data.field_source, "confirmed_query_scope");
  assert.equal(Object.values(store.lastInput.records[0].data).some((value) => value === undefined), false);
  await rm(root, { recursive: true, force: true });
});

test("proposal pilot blocks valid-looking rows when the fixed keyword is missing or changed", async () => {
  const tokenHtml = '<input name="__VIEWSTATE" value="state"><input name="__EVENTVALIDATION" value="validation"><input name="__VIEWSTATEGENERATOR" value="generator">';
  for (const keywordField of ["", '<input name="ctl00$ContentPlaceHolder1$txtKeyword" value="交通">']) {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-query-filter-"));
    const store = mockStore();
    const rows = `<select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod"><option value="07" selected>07</option></select>
      <select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession"><option value="0704" selected>0704</option></select>
      ${keywordField}
      <table><tr><td><input name="ctl00$hidProposalSN" value="654321"></td><td>第 1 號</td><td>交通</td><td>陳議員</td><td>道路改善案</td><td>審議中</td></tr></table><span>共 1 筆</span>`;
    let calls = 0;
    const result = await runCollection({ profile: "proposals-pilot", root, maxPages: 1, run: true }, {
      storeFactory: () => store, minIntervalMs: 0, sleep: async () => {}, now: () => 1_700_000_000_000,
      fetchImpl: async () => new Response(calls++ === 0 ? tokenHtml : rows, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.error_code, "FILTER_NOT_CONFIRMED");
    assert.equal(store.snapshots.size, 0, "unconfirmed query must not import rows");
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal pilot rejects a non-first page and keeps multi-tab totals unknown", async () => {
  const tokenHtml = '<input name="__VIEWSTATE" value="state"><input name="__EVENTVALIDATION" value="validation"><input name="__VIEWSTATEGENERATOR" value="generator">';
  const baseRows = `<select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod"><option value="07" selected>07</option></select>
    <select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession"><option value="0704" selected>0704</option></select>
    <input name="ctl00$ContentPlaceHolder1$txtKeyword" value="道路">
    <table><tr><td><input name="ctl00$hidProposalSN" value="13579"></td><td>第 1 號</td><td>交通</td><td>陳議員</td><td>道路改善案</td><td>審議中</td></tr></table>`;
  const nonFirstRoot = await mkdtemp(path.join(os.tmpdir(), "local-collector-page-check-"));
  const nonFirstStore = mockStore();
  let calls = 0;
  const nonFirst = await runCollection({ profile: "proposals-pilot", root: nonFirstRoot, maxPages: 1, run: true }, {
    storeFactory: () => nonFirstStore, minIntervalMs: 0, sleep: async () => {}, now: () => 1_700_000_000_000,
    fetchImpl: async () => new Response(calls++ === 0 ? tokenHtml : `${baseRows}<span>2 / 3 頁</span><span>共 3 筆</span>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  assert.equal(nonFirst.status, "blocked");
  assert.equal(nonFirst.error_code, "PAGE_NOT_FIRST");
  assert.equal(nonFirstStore.snapshots.size, 0);
  await rm(nonFirstRoot, { recursive: true, force: true });

  const multiTabRoot = await mkdtemp(path.join(os.tmpdir(), "local-collector-tab-check-"));
  const multiTabStore = mockStore();
  calls = 0;
  const multiTab = await runCollection({ profile: "proposals-pilot", root: multiTabRoot, maxPages: 1, run: true }, {
    storeFactory: () => multiTabStore, minIntervalMs: 0, sleep: async () => {}, now: () => 1_700_000_000_000,
    fetchImpl: async () => new Response(calls++ === 0 ? tokenHtml : `${baseRows}<span>共 1 筆</span><span>共 2 筆</span>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  assert.equal(multiTab.status, "partial");
  assert.equal(multiTab.coverage.source_total, null, "multiple tabs cannot be collapsed into one source total");
  assert.equal(multiTab.coverage.complete, false);
  assert.deepEqual(multiTabStore.lastInput.records[0].data.pager.tab_counts, [1, 2]);
  await rm(multiTabRoot, { recursive: true, force: true });
});

test("attempt staging rejects symlinked subdirectories before writing outside the root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-symlink-"));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(root, ".local-collect-attempts"), "dir");
  const store = mockStore();
  let calls = 0;
  const result = await runCollection({ profile: "budget-115", root, maxPages: 1, run: true }, {
    storeFactory: () => store, minIntervalMs: 0, sleep: async () => {}, now: () => 1_700_000_000_000,
    fetchImpl: async () => {
      calls++;
      return new Response(budgetCsv, { headers: { "content-type": "text/csv; charset=utf-8" } });
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.error_code, "STAGING_PATH_INVALID");
  assert.equal(calls, 1, "unsafe staging path stops fallback requests");
  assert.equal(store.raw.size, 0);
  assert.equal(await readdir(outside).then((items) => items.length), 0);
  await rm(root, { recursive: true, force: true });
});

test("store root itself must not be a symlink", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "local-collector-root-symlink-"));
  const outside = path.join(parent, "outside");
  const rootLink = path.join(parent, "store-link");
  await mkdir(outside);
  await symlink(outside, rootLink, "dir");
  let opened = false;
  let fetched = false;
  const result = await runCollection({ profile: "budget-115", root: rootLink, maxPages: 1, run: true }, {
    storeFactory: () => { opened = true; return mockStore(); },
    fetchImpl: async () => { fetched = true; return new Response(budgetCsv); },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.error_code, "STAGING_PATH_INVALID");
  assert.equal(opened, false);
  assert.equal(fetched, false);
  assert.equal(await readdir(outside).then((items) => items.length), 0);
  await rm(parent, { recursive: true, force: true });
});

test("raw and capture staging reject nested symlinks", async () => {
  for (const blockedChild of ["raw", "captures"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-nested-symlink-"));
    const profileDir = path.join(root, ".local-collect-attempts", "budget-115");
    const outside = path.join(root, "outside");
    await mkdir(profileDir, { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(profileDir, blockedChild), "dir");
    const store = mockStore();
    let calls = 0;
    const result = await runCollection({ profile: "budget-115", root, maxPages: 1, run: true }, {
      storeFactory: () => store, minIntervalMs: 0, sleep: async () => {}, now: () => 1_700_000_000_000,
      fetchImpl: async () => {
        calls++;
        return new Response(budgetCsv, { headers: { "content-type": "text/csv; charset=utf-8" } });
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.error_code, "STAGING_PATH_INVALID");
    assert.equal(calls, 1);
    assert.equal(store.raw.size, 0);
    assert.equal(await readdir(outside).then((items) => items.length), 0);
    await rm(root, { recursive: true, force: true });
  }
});

test("jobs symlink is rejected and reported without writing outside or hiding committed collection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-jobs-symlink-"));
  const profileDir = path.join(root, ".local-collect-attempts", "budget-115");
  const outside = path.join(root, "outside");
  await mkdir(profileDir, { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(profileDir, "jobs"), "dir");
  const store = mockStore();
  const result = await runCollection({ profile: "budget-115", root, maxPages: 1, run: true }, {
    storeFactory: () => store, minIntervalMs: 0, sleep: async () => {}, now: () => 1_700_000_000_000,
    fetchImpl: async () => new Response(budgetCsv, { headers: { "content-type": "text/csv; charset=utf-8" } }),
  });
  assert.equal(result.status, "partial");
  assert.equal(result.commit_state, "committed");
  assert.equal(result.job_manifest_status, "blocked");
  assert.equal(result.job_manifest_error_code, "STAGING_PATH_INVALID");
  assert.equal(await readdir(outside).then((items) => items.length), 0);
  assert.equal(store.snapshots.size, 1);
  await rm(root, { recursive: true, force: true });
});

test("budget-115 collects a bounded official-shaped resource, keeps unknown coverage partial, and reruns without duplicate rows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-budget-"));
  const store = mockStore();
  let calls = 0;
  const dependencies = {
    storeFactory: () => store,
    minIntervalMs: 0,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, "https://openapi.kcg.gov.tw/Api/Service/Get/6712fdb8-c0ff-4f0c-901f-03023c17e15d");
      return new Response(budgetCsv, { headers: { "content-type": "text/csv; charset=utf-8" } });
    },
  };
  const first = await runCollection({ profile: "budget-115", root, maxPages: 1, run: true }, dependencies);
  const second = await runCollection({ profile: "budget-115", root, maxPages: 1, run: true }, dependencies);
  assert.equal(first.status, "partial");
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.source_total, null);
  assert.equal(first.record_count, 1);
  assert.equal(first.receipt.status, "imported");
  assert.equal(second.receipt.status, "unchanged");
  assert.equal(store.snapshots.size, 1, "reruns must not duplicate the dataset collection");
  assert.equal(calls, 2, "each explicit run makes one bounded resource request");
  assert.equal(PROFILE_MANIFEST["budget-115"].maxPages, 1);
  await rm(root, { recursive: true, force: true });
});

test("coverage is complete only with a known total covered by non-empty records", async () => {
  assert.deepEqual(coverageFromCounts("query", 1, null), { scope: "query", complete: false, source_total: null });
  assert.deepEqual(coverageFromCounts("query", 1, 1), { scope: "query", complete: true, source_total: 1 });
  assert.deepEqual(coverageFromCounts("query", 1, 2), { scope: "query", complete: false, source_total: 2 });
  assert.deepEqual(coverageFromCounts("query", 0, 0), { scope: "query", complete: false, source_total: 0 });
});

test("default collection mode is a non-network dry run", async () => {
  const result = await runCollection({ profile: "budget-115", root: "/tmp/local-collector-dry-run", maxPages: 1, run: false }, {
    storeFactory: () => { throw new Error("dry run must not open the store"); },
    fetchImpl: async () => { throw new Error("dry run must not fetch"); },
  });
  assert.equal(result.status, "pending");
  assert.equal(result.dry_run, true);
  assert.equal(result.attempted, 0);
  assert.equal(result.commit_state, "not-started");
});

test("CLI accepts only named profiles, local root, and the profile page cap", async () => {
  assert.deepEqual(parseCollectorArgs(["--profile", "budget-115", "--root", "/tmp/store", "--max-pages", "1"]), {
    profile: "budget-115", root: "/tmp/store", maxPages: 1, run: false,
  });
  assert.throws(() => parseCollectorArgs(["--profile", "custom-url", "--root", "/tmp/store"]), { code: "PROFILE_NOT_ALLOWLISTED" });
  for (const inheritedKey of ["__proto__", "constructor", "toString"]) {
    assert.throws(() => parseCollectorArgs(["--profile", inheritedKey, "--root", "/tmp/store"]), { code: "PROFILE_NOT_ALLOWLISTED" });
  }
  assert.throws(() => parseCollectorArgs(["--profile", "budget-115", "--root", "/tmp/store", "--max-pages", "2"]), { code: "PAGE_LIMIT" });
});

test("native Node 24 TypeScript stripping fallback works without esbuild", async () => {
  const budgetParser = await loadTypeScriptParser("../tools/budget.parser.ts", { forceNative: true });
  const summary = budgetParser.parseBudgetSummaryRaw(budgetCsv);
  assert.equal(summary.agency_count, 2);
  const proposalParser = await loadTypeScriptParser("../kcc/search.ts", {
    forceNative: true,
    replace: (source) => source.replace(/^import\s+\{\s*fetchWebFormsTokens\s*\}\s+from\s+["']\.\/client["'];?\s*$/m, "const fetchWebFormsTokens = async () => { throw new Error('bounded collector supplies its own request'); };")
  });
  const rows = proposalParser.parseProposalRows('<table><tr><td><input name="ctl00$hidProposalSN" value="99"></td><td>1</td><td>交通</td><td>議員</td><td>道路改善案</td><td>處理中</td></tr></table>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proposal_sn, "99");
});

test("collector output imports into LocalStore and the local proposal registry applies the same confirmed scope", async () => {
  const esbuild = await import("esbuild");
  const registryPath = fileURLToPath(new URL("../src/local/registry.mjs", import.meta.url));
  const bundledRegistry = await esbuild.build({
    entryPoints: [registryPath], bundle: true, write: false, format: "esm", platform: "node", target: "node24", logLevel: "silent",
  });
  const registryModule = await import(`data:text/javascript;base64,${Buffer.from(bundledRegistry.outputFiles[0].text).toString("base64")}`);
  const root = await mkdtemp(path.join(os.tmpdir(), "local-collector-registry-integration-"));
  const tokenHtml = '<input name="__VIEWSTATE" value="state"><input name="__EVENTVALIDATION" value="validation"><input name="__VIEWSTATEGENERATOR" value="generator">';
  const resultHtml = `<select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod"><option value="07" selected>07</option></select>
    <select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession"><option value="0704" selected>0704</option></select>
    <input name="ctl00$ContentPlaceHolder1$txtKeyword" value="道路">
    <table><tr><td><input name="ctl00$hidProposalSN" value="24680"></td><td>第 1 號</td><td>交通</td><td>陳議員</td><td>道路改善案</td><td>審議中</td></tr></table><span>共 1 筆</span>`;
  let calls = 0;
  const collected = await runCollection({ profile: "proposals-pilot", root, maxPages: 1, run: true }, {
    storeFactory: (storeRoot) => new LocalStore(storeRoot, { readOnly: false }),
    minIntervalMs: 0, sleep: async () => {}, now: () => 1_700_000_000_000,
    fetchImpl: async () => new Response(calls++ === 0 ? tokenHtml : resultHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  assert.equal(collected.status, "complete");
  assert.equal(collected.commit_state, "committed");
  assert.equal(collected.receipt.record_count, 1);
  const store = new LocalStore(root);
  try {
    const tools = registryModule.createLocalRegistry(store);
    const searchProposals = tools.find((tool) => tool.name === "kcc_search_proposals");
    const result = await searchProposals.handler({ period: "07", session: "0704", keyword: "道路" });
    assert.equal(result.status, "success");
    assert.equal(result.meta.dataset, "kcc-proposals-pilot");
    assert.equal(result.meta.local_match_count, 1);
    assert.equal(result.data.proposals.length, 1);
    assert.equal(result.data.proposals[0].proposal_sn, "24680");
    assert.equal(Object.hasOwn(result.data.proposals[0], "period"), false, "query scope must not be presented as a proposal field");
    assert.equal(Object.hasOwn(result.data.proposals[0], "session"), false, "query scope must not be presented as a proposal field");
    assert.equal(Object.hasOwn(result.data.proposals[0], "field_source"), false);
    assert.deepEqual(result.data.proposals[0].local_provenance.confirmed_query_scope, { period: "07", session: "0704" });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    process.stdout.write(`PASS ${item.name}\n`);
  } catch (error) {
    failed++;
    process.stderr.write(`FAIL ${item.name}: ${error?.stack || error}\n`);
  }
}
process.stdout.write(`${tests.length - failed}/${tests.length} local collector checks passed\n`);
if (failed) process.exitCode = 1;
