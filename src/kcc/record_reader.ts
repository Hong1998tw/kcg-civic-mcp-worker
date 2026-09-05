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

interface CachedMeetingRecord {
  record_id: string;
  pdf_url: string;
  total_pages: number;
  pages: Array<{ page: number; text: string }>;
  cached_at: string;
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
  const recordId = args.record_id.trim();
  const cacheKey = `meeting_records/${recordId}.json`;
  let recordData: CachedMeetingRecord | null = null;
  let fromCache = false;

  // 1. 嘗試從 R2 取得快取的文字層
  if (env?.kcg_civic_data) {
    try {
      const cachedObject = await env.kcg_civic_data.get(cacheKey);
      if (cachedObject) {
        recordData = (await cachedObject.json()) as CachedMeetingRecord;
        fromCache = true;
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

    const resp = await fetch(pdfUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      throw new Error(`下載議事錄 PDF 失敗: HTTP ${resp.status}`);
    }

    const buffer = await resp.arrayBuffer();
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
      pdf_url: pdfUrl,
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
) {
  const keyword = args.keyword?.trim();
  if (!keyword) {
    throw new Error("請提供欲檢索之關鍵字 (keyword)");
  }

  const limit = Math.min(Math.max(args.limit_records || 8, 1), 15);
  const searchRes = await searchKccMeetingRecords({
    period: args.period,
    session: args.session,
  });

  const recordsToScan = searchRes.records.slice(0, limit);
  const matchedRecords: any[] = [];

  for (const rec of recordsToScan) {
    try {
      const detail = await getMeetingRecordContent(
        {
          record_id: rec.record_id,
          pdf_url: rec.pdf_url,
          keyword,
        },
        env,
      );

      if (detail.matched_pages_count > 0) {
        matchedRecords.push({
          record_id: rec.record_id,
          meeting: rec.meeting,
          date: rec.date,
          pdf_url: rec.pdf_url,
          from_cache: detail.from_cache,
          matched_pages_count: detail.matched_pages_count,
          matches: detail.matches,
        });
      }
    } catch {
      // 單場解析異常不中斷整體批次檢索
    }
  }

  return {
    keyword,
    scanned_records_count: recordsToScan.length,
    matched_records_count: matchedRecords.length,
    records: matchedRecords,
  };
}
