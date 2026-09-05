import { fetchWebFormsTokens } from "./client";

export interface ProposalSearchArgs {
  category?: string;
  keyword?: string;
  period?: string;
  session?: string;
  meeting?: string;
  meeting_number?: string | number;
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

export interface KccProposalSearchResponse {
  returned_count: number;
  total_count: number | null;
  is_complete: boolean | null;
  current_page: number | null;
  page_count: number | null;
  official_url: string;
  notice: string | null;
  keyword: string;
  councilor: string;
  proposals: KccProposalSearchResult[];
}

export interface OfficialMeetingOption {
  value: string;
  label: string;
}

export const KCC_SEARCH_URL = "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";
const USER_AGENT = "kcg-civic-mcp/1.0 (official KCC data client)";

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

function cleanText(value: string): string {
  return decodeHtml(value.replace(/<br\s*\/?>(?=.)/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePeriod(value?: string): string {
  const input = (value || "07").trim();
  if (!/^\d{1,2}$/.test(input)) return input;
  return input.padStart(2, "0");
}

function normalizeSession(value?: string): string {
  const input = (value || "0704").trim();
  if (/^\d{4}$/.test(input)) return input;
  if (/^\d{1,2}$/.test(input)) return `07${input.padStart(2, "0")}`;
  return input;
}

function validateCode(value: string, field: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`${field} 格式無效`);
  return value;
}

function parseOfficialMeetingOptions(html: string): OfficialMeetingOption[] {
  const selectMatch = html.match(
    /<select\b[^>]*(?:name|id)=["'][^"']*ddlMeeting[^"']*["'][^>]*>([\s\S]*?)<\/select>/i,
  );
  if (!selectMatch) return [];
  const options: OfficialMeetingOption[] = [];
  const optionRegex = /<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let match: RegExpExecArray | null;
  while ((match = optionRegex.exec(selectMatch[1])) !== null) {
    const value = decodeHtml(match[1]).trim();
    if (value) options.push({ value, label: cleanText(match[2]) });
  }
  return options;
}

export async function resolveOfficialMeetings(): Promise<OfficialMeetingOption[]> {
  const resp = await fetch(KCC_SEARCH_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`取得高雄市議會議案查詢頁失敗: HTTP ${resp.status}`);
  return parseOfficialMeetingOptions(await resp.text());
}

export function resolveMeetingId(
  meetings: OfficialMeetingOption[],
  session: string,
  meetingNumber?: string | number,
): string {
  if (/^\d{8}$/.test(session)) return session;
  const number = String(meetingNumber ?? "").trim();
  if (!/^\d+$/.test(number)) return "";
  const prefix = session.slice(0, 4);
  const labelPattern = new RegExp(`第\\s*${Number(number)}\\s*次`);
  return meetings.find((m) => m.value.startsWith(prefix) && labelPattern.test(m.label))?.value || "";
}

function attr(html: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return decodeHtml(html.match(re)?.[2] || "");
}

export function parseProposalRows(html: string): KccProposalSearchResult[] {
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
  const results: KccProposalSearchResult[] = [];
  for (const row of rows) {
    if (!/hidProposalSN/i.test(row)) continue;
    const snInput = row.match(/<input\b[^>]*name=["'][^"']*hidProposalSN[^"']*["'][^>]*>/i)?.[0] || "";
    const sn = attr(snInput, "value");
    if (!/^\d+$/.test(sn)) continue;
    const kindInput = row.match(/<input\b[^>]*name=["'][^"']*hidProposalKind[^"']*["'][^>]*>/i)?.[0] || "";
    const kind = attr(kindInput, "value") || "1";
    const detailMatch = row.match(/Detail\.aspx\?([^"'\s<>]+)/i);
    const detailUrl = detailMatch ? decodeHtml(`Detail.aspx?${detailMatch[1]}`) : `Detail.aspx?s=${encodeURIComponent(sn)}`;
    const rawCells: string[] = [];
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cell: RegExpExecArray | null;
    while ((cell = cellRegex.exec(row)) !== null) rawCells.push(cleanText(cell[1]));
    if (rawCells.length < 6) continue;
    results.push({
      proposal_sn: sn,
      proposal_kind: kind,
      detail_url: detailUrl,
      number: rawCells[1] || "",
      category: rawCells[2] || "",
      councilor: (rawCells[3] || "").replace(/[,，\s]+$/, ""),
      subject: rawCells[4] || "",
      status: rawCells[5] || "",
    });
  }
  return [...new Map(results.map((item) => [item.proposal_sn, item])).values()];
}

function parsePager(html: string): { total: number | null; page: number | null; pages: number | null } {
  const totalMatch = html.match(/共\s*([\d,]+)\s*筆/i);
  const pagesMatch = html.match(/(\d+)\s*\/\s*(\d+)\s*頁/i);
  return {
    total: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null,
    page: pagesMatch ? Number(pagesMatch[1]) : null,
    pages: pagesMatch ? Number(pagesMatch[2]) : null,
  };
}

export async function searchKccProposals(args: ProposalSearchArgs = {}): Promise<KccProposalSearchResponse> {
  const tokens = await fetchWebFormsTokens(KCC_SEARCH_URL);
  if (!tokens.viewState || !tokens.eventValidation) throw new Error("議會查詢頁缺少 WebForms 驗證欄位");
  const period = validateCode(normalizePeriod(args.period), "period", /^\d{2,4}$/);
  const session = validateCode(normalizeSession(args.session), "session", /^\d{4}$/);
  let meeting = (args.meeting || "").trim();
  if (meeting) validateCode(meeting, "meeting", /^\d{8}$/);
  if (!meeting && args.meeting_number !== undefined) {
    meeting = resolveMeetingId(await resolveOfficialMeetings(), session, args.meeting_number);
    if (!meeting) throw new Error(`官方查詢頁找不到 ${session} 的第 ${args.meeting_number} 次會議`);
  }
  const keyword = (args.keyword || "").trim();
  const category = (args.category || "").trim();
  const councilor = (args.councilor || "").trim();
  if (keyword.length > 200 || category.length > 50 || councilor.length > 100) throw new Error("查詢條件過長");

  const formData = new URLSearchParams();
  formData.set("__EVENTTARGET", "ctl00$ContentPlaceHolder1$LinkButton1");
  formData.set("__EVENTARGUMENT", "");
  formData.set("__LASTFOCUS", "");
  formData.set("__VIEWSTATE", tokens.viewState);
  formData.set("__VIEWSTATEGENERATOR", tokens.viewStateGenerator);
  formData.set("__VIEWSTATEENCRYPTED", "");
  formData.set("__EVENTVALIDATION", tokens.eventValidation);
  formData.set("ctl00$ContentPlaceHolder1$hidCurrentTab", "");
  formData.set("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod", period);
  formData.set("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession", session);
  formData.set("ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlMeeting", meeting);
  formData.set("ctl00$ContentPlaceHolder1$ddlCouncilor", councilor);
  formData.set("ctl00$ContentPlaceHolder1$ddlPetitionCouncilor", "");
  formData.set("ctl00$ContentPlaceHolder1$ddlCategory", category);
  formData.set("ctl00$ContentPlaceHolder1$ddlProposalKind", "0");
  formData.set("ctl00$ContentPlaceHolder1$rblState", "");
  formData.set("ctl00$ContentPlaceHolder1$ddlState", "");
  formData.set("ctl00$ContentPlaceHolder1$txtKeyword", keyword);

  const resp = await fetch(KCC_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: tokens.cookieHeader, "User-Agent": USER_AGENT, Referer: KCC_SEARCH_URL },
    body: formData.toString(),
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`議案查詢 POST 請求失敗: HTTP ${resp.status}`);
  const html = await resp.text();
  const proposals = parseProposalRows(html);
  const pager = parsePager(html);
  const isComplete = pager.total === null ? null : proposals.length >= pager.total;
  return {
    returned_count: proposals.length,
    total_count: pager.total,
    is_complete: isComplete,
    current_page: pager.page,
    page_count: pager.pages,
    official_url: KCC_SEARCH_URL,
    notice: isComplete === false
      ? `官方查詢系統採分頁，本次僅回傳目前頁 ${proposals.length} 筆；符合條件總數為 ${pager.total} 筆。請至 official_url 查閱其餘頁次。`
      : null,
    keyword,
    councilor,
    proposals,
  };
}
