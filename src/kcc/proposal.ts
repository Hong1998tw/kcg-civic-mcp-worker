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
          ].includes(label)
        ) {
          result[label] = cells[i + 1] || "";
        }
      }
    }
  }
  return result;
}

function parseReviewTable(html: string): Record<string, string> {
  const tables = getTables(html);
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = getRows(table);
    for (const cells of rows) {
      const row = cells.join(" ").trim();
      if (row.includes("一讀(交付)")) {
        result.first_reading = row;
      }
      if (row.includes("委員會審查意見")) {
        result.committee_opinion = row;
      }
      if (row.includes("二讀決議")) {
        result.second_reading_resolution = row;
      }
      if (row.includes("三讀決議")) {
        result.third_reading_session = row;
      }
    }
  }
  return result;
}

export async function getKccProposal(
  proposalSn: string,
  detailUrl?: string,
): Promise<KccProposal> {
  const cleanPath = (
    detailUrl || `Detail.aspx?s=${encodeURIComponent(proposalSn)}`
  ).trim();

  const absoluteUrl = cleanPath.startsWith("http")
    ? cleanPath
    : `${KCC_BASE_URL}/System/Proposal/${cleanPath.replace(/^\/+/, "")}`;

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

  const html = await resp.text();
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
