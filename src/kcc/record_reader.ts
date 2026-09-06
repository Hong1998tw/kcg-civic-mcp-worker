import { extractText } from "unpdf";
import { searchKccMeetingRecords } from "./meeting";

export interface MeetingRecordContentArgs {
  record_id: string;
  pdf_url?: string;
  keyword?: string;
  page?: number;
}

export interface CrossMeetingSearchArgs {
  keyword: string;
  limit_records?: number;
  period?: string;
  session?: string;
}

export interface PageMatch {
  page: number;
  match_count: number;
  snippets: string[];
}

export interface MeetingRecordContentResult {
  record_id: string;
  pdf_url: string;
  total_pages: number;
  from_cache: boolean;
  keyword?: string;
  matched_pages_count: number;
  matches: PageMatch[];
  page_content?: string;
}

export interface MeetingRecordSearchMatch {
  record_id: string;
  meeting: string;
  date: string;
  pdf_url: string;
  from_cache: boolean;
  matched_pages_count: number;
  matches: PageMatch[];
}

export interface CrossMeetingSearchResult {
  keyword: string;
  scanned_records_count: number;
  matched_records_count: number;
  records: MeetingRecordSearchMatch[];
}

interface CachedMeetingRecord {
  record_id: string;
  pdf_url: string;
  total_pages: number;
  pages: Array<{ page: number; text: string }>;
  cached_at: string;
}

function isCachedMeetingRecord(value: unknown): value is CachedMeetingRecord {
  const item = value as Partial<CachedMeetingRecord> | null;
  return !!item && typeof item.record_id === "string" && typeof item.pdf_url === "string" &&
    typeof item.total_pages === "number" && Array.isArray(item.pages) &&
    item.pages.every((page) => page && typeof page.page === "number" && typeof page.text === "string");
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";

/**
 * 區間合併演算法：自動合併同一頁中距離相近或重疊的關鍵字命中片段
 */
function extractSnippets(text: string, keyword: string, maxSnippets = 3, padding = 45): string[] {
  const intervals: Array<[number, number]> = [];
  let index = 0;

  while (true) {
    const pos = text.indexOf(keyword, index);
    if (pos === -1) break;

    const start = Math.max(0, pos - padding);
    const end = Math.min(text.length, pos + keyword.length + padding);
    intervals.push([start, end]);

    index = pos + keyword.length;
  }

  if (intervals.length === 0) return [];

  // 合併相鄰或重疊的索引區間
  const merged: Array<[number, number]> = [];
  let current = intervals[0];

  for (let i = 1; i < intervals.length; i++) {
    const next = intervals[i];
    if (next[0] <= current[1]) {
      current[1] = Math.max(current[1], next[1]);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged.slice(0, maxSnippets).map(([start, end]) => {
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";
    return `${prefix}${snippet}${suffix}`;
  });
}

export async function getMeetingRecordContent(
  args: MeetingRecordContentArgs,
  env?: any,
): Promise<MeetingRecordContentResult> {
  if (!args || typeof args.record_id !== "string") throw new Error("record_id 必須是文字識別碼");
  const recordId = args.record_id.trim();
  if (!/^\d+$/.test(recordId)) throw new Error("record_id 必須是數字識別碼");
  if (recordId.length > 20) throw new Error("record_id 格式無效");
  if (args.keyword && args.keyword.length > 200) throw new Error("keyword 長度不可超過 200 字元");
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1)) throw new Error("page 必須是正整數");
  const cacheKey = `meeting_records/${recordId}.json`;
  let recordData: CachedMeetingRecord | null = null;
  let fromCache = false;

  // 1. 嘗試從 R2 取得快取的文字層
  if (env?.kcg_civic_data) {
    try {
      const cachedObject = await env.kcg_civic_data.get(cacheKey);
      if (cachedObject) {
        const cached = await cachedObject.json();
        if (isCachedMeetingRecord(cached) && (() => {
          try {
            const cachedUrl = new URL(cached.pdf_url);
            return cachedUrl.protocol === "https:" && cachedUrl.hostname === "cissearch.kcc.gov.tw";
          } catch { return false; }
        })()) {
          recordData = cached;
          fromCache = true;
        }
      }
    } catch {
      // 容錯降級處理
    }
  }

  // 2. 快取未命中：下載 PDF 並以 unpdf 抽取各頁文字
  if (!recordData) {
    let pdfUrl = args.pdf_url?.trim();

    if (!pdfUrl) {
      const searchRes = await searchKccMeetingRecords({});
      const found = searchRes.records.find((r) => r.record_id === recordId);
      if (!found || !found.pdf_url) {
        throw new Error(`找不到 record_id 為 ${recordId} 的議事錄 PDF 連結`);
      }
      pdfUrl = found.pdf_url;
    }

    if (!pdfUrl) throw new Error(`找不到 record_id 為 ${recordId} 的議事錄 PDF 連結`);

    let parsedPdfUrl: URL;
    try { parsedPdfUrl = new URL(pdfUrl); } catch { throw new Error("pdf_url 格式無效"); }
    if (parsedPdfUrl.protocol !== "https:" || parsedPdfUrl.hostname !== "cissearch.kcc.gov.tw") {
      throw new Error("pdf_url 僅允許高雄市議會官方網域");
    }
    const resp = await fetch(parsedPdfUrl.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`下載議事錄 PDF 失敗: HTTP ${resp.status}`);
    }

    const declaredLength = Number(resp.headers.get("content-length") || "0");
    if (declaredLength > 25 * 1024 * 1024) throw new Error("議事錄 PDF 超過 25 MB 大小上限");

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > 25 * 1024 * 1024) throw new Error("議事錄 PDF 超過 25 MB 大小上限");
    const { text, totalPages } = await extractText(new Uint8Array(buffer), {
      mergePages: false,
    });

    const pagesArray = Array.isArray(text) ? text : [text];
    const pages = pagesArray.map((pText, idx) => ({
      page: idx + 1,
      text: pText || "",
    }));

    recordData = {
      record_id: recordId,
      pdf_url: parsedPdfUrl.toString(),
      total_pages: totalPages,
      pages,
      cached_at: new Date().toISOString(),
    };

    // 3. 寫入 R2 快取儲存桶
    if (env?.kcg_civic_data) {
      try {
        await env.kcg_civic_data.put(
          cacheKey,
          JSON.stringify(recordData),
          {
            httpMetadata: { contentType: "application/json" },
          },
        );
      } catch {
        // 快取寫入失敗不阻斷主查詢
      }
    }
  }

  // 4. 關鍵字命中檢索（套用區間合併去重）
  const matches: PageMatch[] = [];
  const keyword = args.keyword?.trim();

  if (keyword) {
    for (const p of recordData.pages) {
      if (p.text.includes(keyword)) {
        const occurrences = p.text.split(keyword).length - 1;
        matches.push({
          page: p.page,
          match_count: occurrences,
          snippets: extractSnippets(p.text, keyword),
        });
      }
    }
  }

  let pageContent: string | undefined;
  if (args.page && args.page >= 1 && args.page <= recordData.total_pages) {
    pageContent = recordData.pages[args.page - 1].text;
  }

  return {
    record_id: recordId,
    pdf_url: recordData.pdf_url,
    total_pages: recordData.total_pages,
    from_cache: fromCache,
    keyword,
    matched_pages_count: matches.length,
    matches,
    page_content: pageContent,
  };
}

/**
 * 跨議事錄批次內容檢索：自動掃描最新會議紀錄並回傳命中結果
 */
export async function searchMeetingRecordsContent(
  args: CrossMeetingSearchArgs,
  env?: any,
): Promise<CrossMeetingSearchResult> {
  const keyword = args.keyword?.trim();
  if (!keyword) {
    throw new Error("請提供欲檢索之關鍵字 (keyword)");
  }

  const requestedLimit = args.limit_records === undefined ? 8 : Number(args.limit_records);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error("limit_records 必須是正整數");
  const limit = Math.min(requestedLimit, 15);
  const searchRes = await searchKccMeetingRecords({
    period: args.period,
    session: args.session,
  });

  const recordsToScan = searchRes.records.slice(0, limit);
  const matchedRecords: MeetingRecordSearchMatch[] = [];

  // Limit concurrent PDF work so one request cannot exhaust Worker memory/CPU.
  for (let index = 0; index < recordsToScan.length; index += 3) {
    const batch = recordsToScan.slice(index, index + 3);
    const results = await Promise.all(batch.map(async (rec) => {
      try {
        const detail = await getMeetingRecordContent({ record_id: rec.record_id, pdf_url: rec.pdf_url, keyword }, env);
        if (detail.matched_pages_count === 0) return null;
        return { record_id: rec.record_id, meeting: rec.meeting, date: rec.date, pdf_url: rec.pdf_url, from_cache: detail.from_cache, matched_pages_count: detail.matched_pages_count, matches: detail.matches };
      } catch { return null; }
    }));
    matchedRecords.push(...results.filter((item): item is NonNullable<typeof item> => item !== null));
  }

  return {
    keyword,
    scanned_records_count: recordsToScan.length,
    matched_records_count: matchedRecords.length,
    records: matchedRecords,
  };
}
