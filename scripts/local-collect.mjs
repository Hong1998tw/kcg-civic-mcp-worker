#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { CollectorError } from "../src/ingestion/collector.mjs";
import { COLLECTION_PROFILES, parseDispatchArgs, runDispatchedCollection } from "../src/ingestion/dispatch.mjs";

function assertLocalRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new CollectorError("RUNTIME_UNSUPPORTED", "local collector 需要 Node.js >=24。 ");
  }
}

export async function main(argv = process.argv.slice(2)) {
  assertLocalRuntime();
  const options = parseDispatchArgs(argv);
  const { LocalStore } = await import("../src/local/store.mjs");
  const result = await runDispatchedCollection(options, { storeFactory: (root) => new LocalStore(root, { readOnly: false }) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "blocked") process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof CollectorError ? error.code : "COLLECTION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "blocked", error_code: code, message: error?.message || "local collector failed" })}\n`);
    process.exitCode = 2;
  });
}

export { COLLECTION_PROFILES as PROFILE_MANIFEST };
