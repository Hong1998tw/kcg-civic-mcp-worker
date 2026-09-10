import { writeFileSync } from "node:fs";
import { extractTokensFromHtml } from "../src/kcc/client";
import { searchKccProposals } from "../src/kcc/search";

const URL_ = "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";

const orig = globalThis.fetch;
let lastHtml = "";
let lastCookie = "";

globalThis.fetch = (async (...a: any[]) => {
  const res = await (orig as any)(...a);
  if ((a[1]?.method || "GET") === "POST") {
    lastHtml = await res.clone().text();
    lastCookie = a[1]?.headers?.Cookie || "";
  }
  return res;
}) as any;

(async () => {
  await searchKccProposals({ councilor: "陳慧文", period: "4", session: "7" });
  globalThis.fetch = orig;

  console.log("lastCookie =", JSON.stringify(lastCookie));
  console.log("lastHtml len =", lastHtml.length);
  const tk = extractTokensFromHtml(lastHtml, lastCookie);
  console.log("viewState len =", tk.viewState.length, "eventValidation len =", tk.eventValidation.length);
  const f = new URLSearchParams();
  f.append("__EVENTTARGET", "ctl00$ContentPlaceHolder1$DataPager4$ctl01$ctl02");
  f.append("__EVENTARGUMENT", "");
  f.append("__VIEWSTATE", tk.viewState);
  f.append("__VIEWSTATEGENERATOR", tk.viewStateGenerator);
  f.append("__EVENTVALIDATION", tk.eventValidation);
  f.append("ctl00$txtKeyword", "");
  f.append("ctl00$ContentPlaceHolder1$hidCurrentTab", "");
  f.append("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod", "07");
  f.append("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession", "0704");
  f.append("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlMeeting", "07040700");
  f.append("ctl00$ContentPlaceHolder1$ddlCouncilor", "陳慧文");
  f.append("ctl00$ContentPlaceHolder1$ddlPetitionCouncilor", "");
  f.append("ctl00$ContentPlaceHolder1$ddlCategory", "");
  f.append("ctl00$ContentPlaceHolder1$ddlProposalKind", "0");
  f.append("ctl00$ContentPlaceHolder1$rblState", "");
  f.append("ctl00$ContentPlaceHolder1$ddlState", "");
  f.append("ctl00$ContentPlaceHolder1$txtKeyword", "");

  const r = await orig(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: lastCookie,
      "User-Agent": UA,
      Referer: URL_,
    },
    body: f.toString(),
  });

  const html = await r.text();
  writeFileSync("/tmp/kcc_page2.html", html);
  console.log("HTTP", r.status);
  console.log("rows =", (html.match(/hidProposalSN/g) || []).length);
  console.log("pager:", html.match(/共\s*(\d+)\s*筆[\s\S]{0,80}?(\d+)\s*\/\s*(\d+)\s*頁/)?.slice(1));
})();
