import { fetchWebFormsTokens } from "./client";

export interface MeetingRecordSearchArgs {
  keyword?: string;
  period?: string;
  session?: string;
  meeting?: string;
}

export interface KccMeetingRecord {
  record_id: string;
  meeting: string;
  date: string;
  record_type: string;
  pdf_url: string;
  source_url: string;
}

const KCC_BASE_URL = "https://cissearch.kcc.gov.tw";
const KCC_MEETING_RECORD_URL = `${KCC_BASE_URL}/System/meetingrecord/default.aspx`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchKccMeetingRecords(
  args: MeetingRecordSearchArgs = {},
): Promise<{
  total: number;
  keyword: string;
  records: KccMeetingRecord[];
}> {
  const tokens = await fetchWebFormsTokens(KCC_MEETING_RECORD_URL);

  const period = (args.period || "07").trim();
  const session = (args.session || "").trim();
  const meeting = args.meeting || "";
  const keyword = (args.keyword || "").trim();
  if (!/^\d{2,4}$/.test(period)) throw new Error("period 格式無效");
  if (session && !/^\d{4}$/.test(session)) throw new Error("session 必須是 4 位官方代碼");
  if (meeting && !/^\d{8}$/.test(meeting)) throw new Error("meeting 必須是 8 位官方代碼");
  if (keyword.length > 200) throw new Error("keyword 長度不可超過 200 字元");

  const formData = new URLSearchParams();
  formData.append("__EVENTTARGET", "ctl00$ContentPlaceHolder1$btnSearch");
  formData.append("__EVENTARGUMENT", "");
  formData.append("__LASTFOCUS", "");
  formData.append("__VIEWSTATE", tokens.viewState);
  formData.append("__VIEWSTATEGENERATOR", tokens.viewStateGenerator);
  formData.append("__VIEWSTATEENCRYPTED", "");
  formData.append("__EVENTVALIDATION", tokens.eventValidation);

  formData.append(
    "ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod",
    period,
  );
  if (session) {
    formData.append(
      "ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession",
      session,
    );
  }
  if (meeting) {
    formData.append(
      "ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlMeeting",
      meeting,
    );
  }
  formData.append("ctl00$ContentPlaceHolder1$txtKeyword", keyword);

  const resp = await fetch(KCC_MEETING_RECORD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: tokens.cookieHeader,
      "User-Agent": USER_AGENT,
      Referer: KCC_MEETING_RECORD_URL,
    },
    body: formData.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`會議紀錄查詢 POST 失敗: HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const records: KccMeetingRecord[] = [];

  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRegex) ?? [];

  for (const row of rows) {
    // 嚴格判定：必須包含 .pdf 檔案連結才視為有效會議紀錄列
    if (!row.includes(".pdf")) continue;

    const hrefMatch = row.match(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i);
    if (!hrefMatch) continue;

    const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? [];
    if (cells.length < 3) continue;

    const values = cells.map((c) => stripHtml(c));
    const date = values[1] || "";
    const meetingTitle = values[2] || "";

    const rawPath = decodeHtml(hrefMatch[1]);
    let absolutePdfUrl: string;
    try {
      const parsed = new URL(rawPath, KCC_BASE_URL);
      if (parsed.protocol !== "https:" || parsed.hostname !== "cissearch.kcc.gov.tw") continue;
      absolutePdfUrl = parsed.toString();
    } catch { continue; }

    // 從 /Upload/Attachment/MeetingRecord/{record_id}/... 擷取 record_id
    const idMatch = rawPath.match(/MeetingRecord\/(\d+)\//i);
    const recordId = idMatch ? idMatch[1] : "";

    records.push({
      record_id: recordId,
      meeting: meetingTitle,
      date,
      record_type: "議事錄",
      pdf_url: absolutePdfUrl,
      source_url: KCC_MEETING_RECORD_URL,
    });
  }

  return {
    total: records.length,
    keyword,
    records,
  };
}
