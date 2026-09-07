export interface KccProposal {
  proposal_sn: string;
  detail_url: string;
  meeting: string;
  proposal_type: string;
  category: string;
  number: string;
  proposing_unit: string;
  handling_unit: string;
  related_units: string;
  co_signers: string;
  subject: string;
  explanation: string;
  method: string;
  remarks: string;
  official_status: string;
  review: {
    first_reading: string;
    first_reading_date: string;
    committee_opinion: string;
    committee_date: string;
    second_reading_resolution: string;
    second_reading_date: string;
    third_reading_session: string;
    third_reading_date: string;
  };
}

const KCC_BASE_URL = "https://cissearch.kcc.gov.tw";

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 10)),
    );
}

function cleanText(value: string): string {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTables(html: string): string[] {
  const tables: string[] = [];
  const regex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    tables.push(match[1]);
  }
  return tables;
}

function getRows(table: string): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(table)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cleanText(cellMatch[1]));
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function normalizeLabel(value: string): string {
  return value
    .replace(/：/g, "")
    .replace(/:/g, "")
    .trim();
}

function parseMainTable(html: string): Record<string, string> {
  const tables = getTables(html);
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = getRows(table);
    for (const cells of rows) {
      if (cells.length < 2) continue;
      for (let i = 0; i < cells.length - 1; i++) {
        const label = normalizeLabel(cells[i]);
        if (
          [
            "類別",
            "編號",
            "提案單位",
            "承辦單位",
            "相關單位",
            "連署人",
            "案由",
            "說明",
            "辦法",
            "備註",
            "提案類型",
            "會議",
            "狀態",
          ].includes(label)
        ) {
          result[label] = cells[i + 1] || "";
        }
      }
    }
  }
  return result;
}

function fieldFromRow(row: string, label: RegExp, stopLabels: RegExp[] = []): string {
  const match = label.exec(row);
  if (!match) return "";
  let value = row.slice((match.index || 0) + match[0].length);
  let stop = value.length;
  for (const stopLabel of stopLabels) {
    const index = value.search(stopLabel);
    if (index >= 0) stop = Math.min(stop, index);
  }
  value = value.slice(0, stop).replace(/^[\s：:/]+|[\s：:/]+$/g, "").trim();
  return /^(?:決議|日期|審查意見|大會屆次)?$/.test(value) ? "" : value;
}

export function parseReviewTable(html: string): Record<string, string> {
  const tables = getTables(html);
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = getRows(table);
    for (const cells of rows) {
      const row = cells.join(" ").trim();
      if (row.includes("一讀(交付)")) {
        result.first_reading = fieldFromRow(row, /一讀\(交付\)\s*(?:決議)?\s*[：:]?/, [/\/?交付日期\s*[：:]?/, /一讀日期\s*[：:]?/]);
        result.first_reading_date = fieldFromRow(row, /(?:交付日期|一讀日期)\s*[：:]?/);
      }
      if (row.includes("委員會審查意見")) {
        result.committee_opinion = fieldFromRow(row, /委員會審查意見\s*[：:]?/, [/審查日期\s*[：:]?/]);
        result.committee_date = fieldFromRow(row, /審查日期\s*[：:]?/);
      }
      if (row.includes("二讀決議")) {
        result.second_reading_resolution = fieldFromRow(row, /二讀決議\s*[：:]?/, [/決議日期\s*[：:]?/]);
        result.second_reading_date = fieldFromRow(row, /決議日期\s*[：:]?/);
      }
      if (row.includes("三讀決議")) {
        result.third_reading_session = fieldFromRow(row, /三讀決議\s*(?:決議大會屆次)?\s*[：:]?/, [/決議日期\s*[：:]?/]);
        result.third_reading_date = fieldFromRow(row, /決議日期\s*[：:]?/);
      }
    }
  }
  return result;
}

export function extractProposalSn(html: string): string {
  const input = html.match(/<input\b[^>]*(?:name|id)=["'][^"']*(?:hidProposalSN|ProposalSN)[^"']*["'][^>]*>/i)?.[0] || "";
  const value = input.match(/\bvalue\s*=\s*(["'])(\d+)\1/i)?.[2];
  if (value) return value;
  return cleanText(html).match(/(?:議案流水號|提案流水號)\s*[：:]?\s*(\d+)/)?.[1] || "";
}

export async function getKccProposal(
  proposalSn: string,
  detailUrl?: string,
): Promise<KccProposal> {
  if (!/^\d+$/.test(String(proposalSn || "").trim())) {
    throw new Error("proposal_sn 必須是數字流水號");
  }
  const cleanPath = (
    detailUrl || `Detail.aspx?s=${encodeURIComponent(proposalSn)}`
  ).trim();

  let absoluteUrl: string;
  try {
    absoluteUrl = cleanPath.startsWith("http")
      ? new URL(cleanPath).toString()
      : new URL(`/System/Proposal/${cleanPath.replace(/^\/+/, "")}`, KCC_BASE_URL).toString();
  } catch {
    throw new Error("議案詳情 URL 格式無效");
  }
  const parsedUrl = new URL(absoluteUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "cissearch.kcc.gov.tw" || parsedUrl.pathname !== "/System/Proposal/Detail.aspx") {
    throw new Error("議案詳情 URL 僅允許高雄市議會官方 Detail.aspx");
  }

  const resp = await fetch(absoluteUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error(
      `無法取得高雄市議會議案詳細資料: HTTP ${resp.status}`,
    );
  }
  const finalUrl = new URL(resp.url);
  if (finalUrl.hostname !== "cissearch.kcc.gov.tw" || finalUrl.pathname !== "/System/Proposal/Detail.aspx") {
    throw new Error("PARSER_CONTRACT_CHANGED: 議案詳情被重新導向非預期頁面");
  }

  const html = await resp.text();
  const sourceProposalSn = extractProposalSn(html);
  if (!sourceProposalSn || sourceProposalSn !== proposalSn) {
    throw new Error(`SOURCE_ID_MISMATCH: 請求 proposal_sn=${proposalSn}，來源頁面為 ${sourceProposalSn || "unknown"}`);
  }
  const main = parseMainTable(html);
  const review = parseReviewTable(html);

  const meetingMatch =
    html.match(/id=["'][^"']*(?:lblMeeting|Meeting)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
    html.match(/(高雄市議會第\d+屆第\d+次(?:定期|臨時)大會[^\s<"']*)/i);

  return {
    proposal_sn: proposalSn,
    detail_url: absoluteUrl,
    meeting: meetingMatch
      ? cleanText(meetingMatch[1] || meetingMatch[0])
      : (main["會議"] || ""),
    proposal_type: main["提案類型"] || "",
    category: main["類別"] || "",
    number: main["編號"] || "",
    proposing_unit: main["提案單位"] || "",
    handling_unit: main["承辦單位"] || "",
    related_units: main["相關單位"] || "",
    co_signers: main["連署人"] || "",
    subject: main["案由"] || "",
    explanation: main["說明"] || "",
    method: main["辦法"] || "",
    remarks: main["備註"] || "",
    official_status: main["狀態"] || "",
    review: {
      first_reading: review.first_reading || "",
      first_reading_date: review.first_reading_date || "",
      committee_opinion: review.committee_opinion || "",
      committee_date: review.committee_date || "",
      second_reading_resolution: review.second_reading_resolution || "",
      second_reading_date: review.second_reading_date || "",
      third_reading_session: review.third_reading_session || "",
      third_reading_date: review.third_reading_date || "",
    },
  };
}
