import { ToolDefinition } from "../models/types";
import { fetchCouncilData } from "../adapters/council.adapter";
import { buildEnvelope } from "../utils/envelope";
import { boundedLimit } from "../utils/envelope";

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

export const COUNCIL_TOOLS: ToolDefinition[] = [
  {
    name: "get_kcg_council_meetings",
    description: "查詢高雄市議會歷屆定期大會與臨時會議事日程與審議議程",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "number", description: "屆期（例如：4 代表第 4 屆）", default: 4 },
        session_period: { type: "number", description: "會期（例如：3 代表第 3 次定期大會）" },
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
              session_period: { type: "number" },
              meeting_name: { type: "string" },
              meeting_date: { type: "string" },
              agenda: { type: "string" },
            },
            required: ["meeting_id", "term", "session_period", "meeting_name", "meeting_date"],
          },
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const term = args.term === undefined ? 4 : Number(args.term);
      if (!Number.isInteger(term) || term < 1) throw new Error("term 必須是正整數");
      const sessionPeriod = args.session_period === undefined ? undefined : Number(args.session_period);
      if (sessionPeriod !== undefined && (!Number.isInteger(sessionPeriod) || sessionPeriod < 1)) throw new Error("session_period 必須是正整數");
      const limit = boundedLimit(args.limit, 10, 100);

      const { data, provenance } = await fetchCouncilData(env);

      const matched = data.meetings
        .filter((m) => m.term === term && (sessionPeriod === undefined || m.session_period === sessionPeriod))
        .slice(0, limit);

      return buildEnvelope(matched, provenance, {
        term,
        session_period: sessionPeriod ?? "all",
        total: matched.length,
      });
    },
  },
  {
    name: "search_kcg_council_interpellations",
    description: "依市政關鍵字或議員姓名檢索高雄市議會質詢問政紀錄與主題摘要",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "質詢主題或發言關鍵字" },
        legislator_name: { type: "string", description: "選填，指定質詢議員姓名" },
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
              session_period: { type: "number" },
              legislator_name: { type: "string" },
              topic: { type: "string" },
              content_summary: { type: "string" },
              date: { type: "string" },
            },
            required: ["record_id", "term", "legislator_name", "topic", "content_summary", "date"],
          },
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const keyword = String(args.keyword || "").trim();
      const legislator = args.legislator_name ? String(args.legislator_name).trim() : undefined;
      if (!keyword || keyword.length > 200) throw new Error("keyword 不可為空且不得超過 200 字元");
      if (legislator && legislator.length > 100) throw new Error("legislator_name 長度不可超過 100 字元");
      const limit = boundedLimit(args.limit, 10, 100);

      const { data, provenance } = await fetchCouncilData(env);

      const matched = data.interpellations
        .filter((i) => {
          const matchLegislator = !legislator || i.legislator_name.includes(legislator);
          const matchTopic = i.topic.includes(keyword);
          const matchContent = i.content_summary.includes(keyword);
          return matchLegislator && (matchTopic || matchContent);
        })
        .slice(0, limit);

      return buildEnvelope(matched, provenance, {
        query_keyword: keyword,
        query_legislator: legislator || "all",
        total: matched.length,
      });
    },
  },
];
