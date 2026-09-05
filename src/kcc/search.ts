
/**
 * 官方 WebForms 參數映射表：將使用者慣用代碼轉換為高雄市議會內部實際代碼
 */
function mapOfficialParameters(period?: string, session?: string) {
  const periodMap: Record<string, string> = {
    "4": "07",
    "04": "07",
    "7": "07",
    "07": "07"
  };
  
  const sessionMap: Record<string, string> = {
    "6": "0704",
    "7": "0704",
    "8": "0704",
    "0704": "0704"
  };

  return {
    mappedPeriod: period ? (periodMap[period] || period) : "07",
    mappedSession: session ? (sessionMap[session] || session) : "0704"
  };
}

import { fetchWebFormsTokens } from "./client";

export interface ProposalSearchArgs {
  category?: string;
  keyword?: string;
  period?: string;
  session?: string;
  meeting?: string;
  councilor?: string;
}

export interface KccProposalSearchResult {
  category?: string;
  proposal_sn: string;
  proposal_kind: string;
  detail_url: string;
  number?: string;
  councilor?: string;
  subject?: string;
  status?: string;
}

const KCC_SEARCH_URL =
  "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 10)),
    );
}

function cleanText(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}


interface OfficialMeetingOption {
  value: string;
  label: string;
}

function parseOfficialMeetingOptions(html: string): OfficialMeetingOption[] {
  const selectMatch = html.match(
    /<select\b[^>]*name=["']ctl00\$ContentPlaceHolder1\$uscPeriodSessionMeeting\$ddlMeeting["'][^>]*>([\s\S]*?)<\/select>/i,
  );

  if (!selectMatch) {
    return [];
  }

  const options: OfficialMeetingOption[] = [];
  const optionRegex =
    /<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;

  let match: RegExpExecArray | null;

  while ((match = optionRegex.exec(selectMatch[1])) !== null) {
    const value = decodeHtml(match[1]).trim();
    const label = cleanText(match[2]);

    if (!value) continue;

    options.push({
      value,
      label,
    });
  }

  return options;
}

export async function resolveOfficialMeetings(): Promise<OfficialMeetingOption[]> {
  const resp = await fetch(KCC_SEARCH_URL, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error(`取得高雄市議會議案查詢頁失敗: HTTP ${resp.status}`);
  }

  const html = await resp.text();
  return parseOfficialMeetingOptions(html);
}

export function resolveMeetingId(
  meetings: OfficialMeetingOption[],
  session: string,
  meetingNumber?: string,
): string {
  if (/^07\d{2}\d{4}$/.test(session)) {
    return session;
  }

  const sessionNumber = Number(meetingNumber ?? session);

  if (!Number.isInteger(sessionNumber) || sessionNumber <= 0) {
    return "";
  }

  const regularMeeting = meetings.find(
    (m) =>
      m.value.startsWith("0704") &&
      m.value.endsWith("00") &&
      m.label === `第${sessionNumber}次定期大會`,
  );

  return regularMeeting?.value || "";
}

function parseProposalRows(html: string): KccProposalSearchResult[] {
  const trRegex = /<tr\b[\s\S]*?<\/tr>/gi;
  const rows = html.match(trRegex) ?? [];
  const results: KccProposalSearchResult[] = [];

  for (const row of rows) {
    if (!row.includes("hidProposalSN")) continue;

    const snMatch = row.match(/name="[^"]*hidProposalSN"[^>]*value="(\d+)"/i);
    if (!snMatch) continue;
    const proposalSn = snMatch[1];

    const kindMatch = row.match(/name="[^"]*hidProposalKind"[^>]*value="(\d+)"/i);
    const proposalKind = kindMatch ? kindMatch[1] : "1";

    // 自當前 <tr> 的 onclick / href 擷取專屬加密 Detail 網址
    const detailMatch = row.match(/Detail\.aspx\?([a-zA-Z0-9_=&;%-]+)/i);
    let detailUrl = `Detail.aspx?s=${encodeURIComponent(proposalSn)}`;
    if (detailMatch) {
      detailUrl = decodeHtml(`Detail.aspx?${detailMatch[1]}`);
    }

    // 提取當前列之所有 td
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const rawCells: string[] = [];
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cellRegex.exec(row)) !== null) {
      rawCells.push(cleanText(cMatch[1]));
    }

    if (rawCells.length >= 6) {
      results.push({
        proposal_sn: proposalSn,
        proposal_kind: proposalKind,
        detail_url: detailUrl,
        number: rawCells[1] || "",
        category: rawCells[2] || "",
        councilor: (rawCells[3] || "").replace(/[,，\s]+$/, ""),
        subject: rawCells[4] || "",
        status: rawCells[5] || "",
      });
    }
  }

  // 依據 proposal_sn 去除重複
  const unique = new Map<string, KccProposalSearchResult>();
  for (const item of results) {
    if (!unique.has(item.proposal_sn)) {
      unique.set(item.proposal_sn, item);
    }
  }

  return [...unique.values()];
}

export interface KccProposalSearchResponse {
  returned_count: number;
  total_count: number | null;
  is_complete: boolean | null;
  official_url: string;
  notice: string | null;
  keyword: string;
  councilor: string;
  proposals: KccProposalSearchResult[];
}

export async function searchKccProposals(
  args: ProposalSearchArgs,
): Promise<KccProposalSearchResponse> {
  const tokens = await fetchWebFormsTokens(KCC_SEARCH_URL);

  const inputPeriod = args.period || "07";
  const inputSession = args.session || "0704";

  const {
    mappedPeriod,
    mappedSession,
  } = mapOfficialParameters(inputPeriod, inputSession);

  const period = mappedPeriod;
  const session = mappedSession;

  let meeting = args.meeting || "";

  // 使用者輸入第幾次定期大會時，自動解析官方 ddlMeeting。
  // ddlSession 仍維持官方 Session ID，例如 0704。
  if (!meeting && inputSession !== mappedSession) {
    const meetings = await resolveOfficialMeetings();
    meeting = resolveMeetingId(meetings, mappedSession, inputSession);

    console.log("[KCC Meeting Mapping]", {
      inputSession,
      session: mappedSession,
      meeting,
    });
  }
  const keyword = (args.keyword || "").trim();
  const category = (args.category || "").trim();
  const councilor = (args.councilor || "").trim();

  console.log("[KCC Proposal Mapping]", {
    inputPeriod,
    inputSession,
    mappedPeriod,
    mappedSession,
    meeting,
    councilor,
  });

  const formData = new URLSearchParams();
  formData.append("__EVENTTARGET", "ctl00$ContentPlaceHolder1$LinkButton1");
  formData.append("__EVENTARGUMENT", "");
  formData.append("__LASTFOCUS", "");
  formData.append("__VIEWSTATE", tokens.viewState);
  formData.append("__VIEWSTATEGENERATOR", tokens.viewStateGenerator);
  formData.append("__VIEWSTATEENCRYPTED", "");
  formData.append("__EVENTVALIDATION", tokens.eventValidation);

  formData.append("ctl00$txtKeyword", "");
  formData.append("ctl00$ContentPlaceHolder1$hidCurrentTab", "");
  formData.append(
    "ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod",
    period,
  );
  formData.append(
    "ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession",
    session,
  );
  formData.append(
    "ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlMeeting",
    meeting,
  );
  formData.append("ctl00$ContentPlaceHolder1$ddlCouncilor", councilor);
  formData.append("ctl00$ContentPlaceHolder1$ddlPetitionCouncilor", "");
  formData.append("ctl00$ContentPlaceHolder1$ddlCategory", category);
  formData.append("ctl00$ContentPlaceHolder1$ddlProposalKind", "0");
  formData.append("ctl00$ContentPlaceHolder1$rblState", "");
  formData.append("ctl00$ContentPlaceHolder1$ddlState", "");
  formData.append("ctl00$ContentPlaceHolder1$txtKeyword", keyword);

  const resp = await fetch(KCC_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: tokens.cookieHeader,
      "User-Agent": USER_AGENT,
      Referer: KCC_SEARCH_URL,
    },
    body: formData.toString(),
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error(`議案查詢 POST 請求失敗: HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const proposals = parseProposalRows(html);

  const pagerIdx = html.indexOf('id="ContentPlaceHolder1_DataPager4"');
  const pagerSeg = pagerIdx >= 0 ? html.slice(pagerIdx, pagerIdx + 1500) : "";
  const totalMatch = pagerSeg.match(/共\s*(\d+)\s*筆/);
  const officialTotal = totalMatch ? Number(totalMatch[1]) : null;
  const pageMatch = pagerSeg.match(/(\d+)\s*\/\s*(\d+)\s*頁/);
  console.log("[KCC Pager]", {
    officialTotal,
    page: pageMatch ? `${pageMatch[1]}/${pageMatch[2]}` : null,
    parsed: proposals.length,
  });

  const returnedCount = proposals.length;
  const isComplete = officialTotal === null ? null : returnedCount >= officialTotal;

  return {
    returned_count: returnedCount,
    total_count: officialTotal,
    is_complete: isComplete,
    official_url: "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx",
    notice:
      isComplete === false
        ? `受官方查詢系統分頁限制，本次僅回傳 ${returnedCount} 筆，官方共 ${officialTotal} 筆。完整清單請至官方系統查詢。`
        : null,
    keyword,
    councilor,
    proposals,
  };
}
