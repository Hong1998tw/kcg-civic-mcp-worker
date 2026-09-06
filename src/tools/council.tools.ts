import { ToolDefinition } from "../models/types";
import { searchKccMeetingRecords } from "../kcc/meeting";
import { searchSpeeches, KCC_PORTAL_URL } from "../kcc/advanced";
import { buildKccEnvelope, boundedLimit } from "../utils/envelope";

const KCC_RECORD_URL = `${KCC_PORTAL_URL}/System/meetingrecord/default.aspx`;

const PROVENANCE_SCHEMA = {
  type: "object",
  properties: {
    source_id: { type: ["string", "number"] },
    source_url: { type: "string" },
    source_type: { type: "string", enum: ["openapi", "csv_direct", "official_web", "r2", "cache", "fallback"] },
    agency: { type: "string" },
    retrieved_at: { type: "string" },
    content_hash: { type: "string" },
  },
  required: ["source_id", "source_url", "source_type", "agency", "retrieved_at", "content_hash"],
};

function termToKccPeriod(term: number): string {
  if (term === 4) return "07";
  throw new Error("目前僅完成高雄市議會第 4 屆與 KCC 官方屆次代碼的正式映射");
}

function sessionPeriodToKccSession(period: string, sessionPeriod?: number): string | undefined {
  if (sessionPeriod === undefined) return undefined;
  return `${period}${String(sessionPeriod).padStart(2, "0")}`;
}

export const COUNCIL_TOOLS: ToolDefinition[] = [
  {
    name: "get_kcg_council_meetings",
    description: "透過高雄市議會官方 KCC 議事錄查詢系統，查詢第 4 屆會議紀錄與官方 PDF。",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "number", description: "屆期；目前正式支援第 4 屆", default: 4 },
        session_period: { type: "number", description: "選填，會期序號；例如 4 會映射為官方會期代碼 0704" },
        limit: { type: "number", description: "回傳紀錄上限", default: 10 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "error"] },
        provider: { type: "string" },
        updated_at: { type: "string" },
        provenance: PROVENANCE_SCHEMA,
        meta: { type: "object" },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              meeting_id: { type: "string" },
              term: { type: "number" },
              session_period: { type: ["number", "null"] },
              meeting_name: { type: "string" },
              meeting_date: { type: "string" },
              record_type: { type: "string" },
              pdf_url: { type: "string" },
            },
            required: ["meeting_id", "term", "meeting_name", "meeting_date", "record_type", "pdf_url"],
          },
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args) => {
      const term = args.term === undefined ? 4 : Number(args.term);
      if (!Number.isInteger(term) || term < 1) throw new Error("term 必須是正整數");
      const sessionPeriod = args.session_period === undefined ? undefined : Number(args.session_period);
      if (sessionPeriod !== undefined && (!Number.isInteger(sessionPeriod) || sessionPeriod < 1)) {
        throw new Error("session_period 必須是正整數");
      }
      const limit = boundedLimit(args.limit, 10, 100);
      const period = termToKccPeriod(term);
      const session = sessionPeriodToKccSession(period, sessionPeriod);

      const result = await searchKccMeetingRecords({ period, session });
      const data = result.records.slice(0, limit).map((record) => ({
        meeting_id: record.record_id,
        term,
        session_period: sessionPeriod ?? null,
        meeting_name: record.meeting,
        meeting_date: record.date,
        record_type: record.record_type,
        pdf_url: record.pdf_url,
      }));

      return buildKccEnvelope(data, KCC_RECORD_URL, {
        term,
        kcc_period: period,
        kcc_session: session || "all",
        total: data.length,
        official_total: result.total,
      });
    },
  },
  {
    name: "search_kcg_council_interpellations",
    description: "直接檢索高雄市議會官方議事錄 PDF 文字層；可依議題關鍵字與議員姓名交叉比對同頁命中。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "質詢主題或發言關鍵字" },
        legislator_name: { type: "string", description: "選填，指定議員姓名；與 keyword 同時提供時採同一議事錄頁面交叉命中" },
        limit: { type: "number", description: "回傳筆數上限", default: 10 },
      },
      required: ["keyword"],
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "error"] },
        provider: { type: "string" },
        updated_at: { type: "string" },
        provenance: PROVENANCE_SCHEMA,
        meta: { type: "object" },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              record_id: { type: "string" },
              term: { type: "number" },
              legislator_name: { type: "string" },
              topic: { type: "string" },
              content_summary: { type: "string" },
              date: { type: "string" },
              meeting_name: { type: "string" },
              page: { type: "number" },
            },
            required: ["record_id", "term", "legislator_name", "topic", "content_summary", "date", "meeting_name", "page"],
          },
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const keyword = String(args.keyword || "").trim();
      const legislator = args.legislator_name ? String(args.legislator_name).trim() : "";
      if (!keyword || keyword.length > 200) throw new Error("keyword 不可為空且不得超過 200 字元");
      if (legislator.length > 100) throw new Error("legislator_name 長度不可超過 100 字元");
      const limit = boundedLimit(args.limit, 10, 50);

      const result = await searchSpeeches({ keyword, speaker: legislator || undefined }, env);
      const data = result.speeches.slice(0, limit).map((speech) => ({
        record_id: speech.record_id,
        term: 4,
        legislator_name: legislator || "未結構化標註",
        topic: keyword,
        content_summary: speech.content_summary,
        date: speech.date,
        meeting_name: speech.meeting,
        page: speech.page,
      }));

      return buildKccEnvelope(data, KCC_RECORD_URL, {
        query_keyword: keyword,
        query_legislator: legislator || "all",
        total: data.length,
        official_match_total: result.total,
        note: result.notice,
      });
    },
  },
];
