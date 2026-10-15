import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error("local runtime build requires Node.js >=24");
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function buildLocal(options = {}) {
  assertNode24();
  const outdir = path.resolve(options.outdir || option("--outdir") || path.join(ROOT, "dist-local"));
  await mkdir(outdir, { recursive: true });
  const outfile = path.join(outdir, "server.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/local/server.mjs")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    packages: "external",
    sourcemap: false,
    logLevel: "warning",
  });
  return { outfile };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildLocal().then(({ outfile }) => process.stdout.write(`built local MCP: ${outfile}\n`)).catch((error) => {
    process.stderr.write(`local MCP build failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
