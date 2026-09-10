import { readFileSync, writeFileSync } from "node:fs";
import { searchKccProposals } from "../src/kcc/search";

const URL_ = "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";

const orig = globalThis.fetch;
let html = "", cookie = "", lastHeaders: any = null;
globalThis.fetch = (async (...a: any[]) => {
  const res = await (orig as any)(...a);
  if ((a[1]?.method || "GET") === "POST") {
    html = await res.clone().text();
    cookie = a[1]?.headers?.Cookie || "";
    lastHeaders = a[1]?.headers;
  }
  return res;
}) as any;

function harvest(h: string): URLSearchParams {
  const f = new URLSearchParams();
  for (const m of h.matchAll(/<input([^>]*)>/g)) {
    const a = m[1];
    const name = /name="([^"]*)"/.exec(a)?.[1];
    if (!name) continue;
    const type = (/type="([^"]*)"/.exec(a)?.[1] || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image") continue;
    if ((type === "checkbox" || type === "radio") && !/checked/.test(a)) continue;
    const v = /value="([^"]*)"/.exec(a)?.[1] ?? "";
    f.append(name, v.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  for (const m of h.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = /name="([^"]*)"/.exec(m[1])?.[1];
    if (!name) continue;
    const sel = /value="([^"]*)"[^>]*selected/.exec(m[2]);
    f.append(name, sel?.[1] ?? "");
  }
  return f;
}

(async () => {
  await searchKccProposals({ councilor: "陳慧文", period: "4", session: "7" });
  globalThis.fetch = orig;

  const f = harvest(html);
  f.set("__EVENTTARGET", "ctl00$ContentPlaceHolder1$DataPager4$ctl01$ctl02");
  f.set("__EVENTARGUMENT", "");

  console.log("fields =", [...f.keys()].length);

  const r = await orig(URL_, {
    method: "POST",
    headers: { ...(lastHeaders || {}) },
    body: f.toString(),
    redirect: "manual",
  });
  console.log("status", r.status, "location", r.headers.get("location"));
  console.log("set-cookie", (r.headers as any).getSetCookie?.());
  const out = await r.text();
  writeFileSync("/tmp/kcc_p2.html", out);
  console.log("HTTP", r.status, "len", out.length);
  console.log("rows =", (out.match(/hidProposalSN/g) || []).length);
  console.log("pager =", out.match(/共\s*(\d+)\s*筆[\s\S]{0,120}?(\d+)\s*\/\s*(\d+)\s*頁/)?.slice(1));
})();
