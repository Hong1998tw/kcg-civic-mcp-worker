import fs from "node:fs";
import path from "node:path";

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

const sourceText = filesUnder(path.resolve("src"))
  .filter((file) => /\.(?:ts|js|mjs|cjs)$/.test(file))
  .map((file) => `${file}\n${fs.readFileSync(file, "utf8")}`)
  .join("\n");

const forbidden = [
  ["legacy law object", "laws/kcg_laws.json"],
  ["legacy news object", "news/kcg_news.json"],
  ["demo-data production flag", "MCP_ALLOW_DEMO_DATA"],
  ["query token authentication", 'searchParams.get("token")'],
  ["query key authentication", 'searchParams.get("key")'],
];

for (const [label, needle] of forbidden) {
  if (sourceText.includes(needle)) throw new Error(`Production safety check failed: ${label}`);
}

const legacySync = fs.readFileSync(path.resolve("scripts/sync_laws_to_r2.sh"), "utf8");
if (!/BLOCKED:/.test(legacySync) || !/^exit 1$/m.test(legacySync) || /r2 object put/.test(legacySync)) {
  throw new Error("Production safety check failed: legacy R2 writer is not blocked");
}

console.log("Production safety checks passed");
