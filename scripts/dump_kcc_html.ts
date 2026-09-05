import { writeFileSync } from "node:fs";
import { searchKccProposals } from "../src/kcc/search";

const orig = globalThis.fetch;
let n = 0;

globalThis.fetch = (async (...args: any[]) => {
  const res = await (orig as any)(...args);
  const text = await res.clone().text();
  n += 1;
  const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
  const method = args[1]?.method || "GET";
  const file = `/tmp/kcc_${n}.html`;
  writeFileSync(file, text);
  console.log(`[capture ${n}] ${method} ${url} -> ${file} (${text.length} bytes)`);
  return res;
}) as any;

(async () => {
  const r = await searchKccProposals({
    councilor: "陳慧文",
    period: "4",
    session: "7",
  });
  console.log("parsed len =", r.proposals.length);
})();
