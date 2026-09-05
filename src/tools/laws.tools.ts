import { ToolDefinition } from "../models/types";
import { fetchLawsData } from "../adapters/laws.adapter";
import { buildEnvelope } from "../utils/envelope";

const PROVENANCE_SCHEMA = {
  type: "object",
  properties: {
    source_id: { type: ["string", "number"] },
    source_url: { type: "string" },
    source_type: { type: "string", enum: ["openapi", "csv_direct", "r2", "cache"] },
    agency: { type: "string" },
    retrieved_at: { type: "string" },
    content_hash: { type: "string" },
  },
  required: ["source_id", "source_url", "source_type", "agency", "retrieved_at", "content_hash"],
};

export const LAW_TOOLS: ToolDefinition[] = [
  {
    name: "search_kcg_laws",
    description: "依關鍵字與分類搜尋高雄市主管法規清單與法條摘要",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "法規名稱或條文內容搜尋關鍵字" },
        category: { type: "string", description: "選填，法規類別（例如：環境保護、行政一般、財政金融）" },
        limit: { type: "number", description: "回傳數量上限", default: 10 },
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
              law_id: { type: "string" },
              law_name: { type: "string" },
              category: { type: "string" },
              published_at: { type: "string" },
              matched_articles: { type: "array" },
            },
            required: ["law_id", "law_name", "category", "published_at"],
          },
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const keyword = (args.keyword || "").trim();
      const category = args.category?.trim();
      const limit = typeof args.limit === "number" ? args.limit : 10;

      const { laws, provenance } = await fetchLawsData(env);

      const matched = laws
        .filter((l) => {
          const matchCategory = !category || l.category.includes(category);
          const matchName = l.law_name.includes(keyword);
          const matchArticles = l.articles.some((a) => a.content.includes(keyword));
          return matchCategory && (matchName || matchArticles);
        })
        .slice(0, limit)
        .map((l) => ({
          law_id: l.law_id,
          law_name: l.law_name,
          category: l.category,
          published_at: l.published_at,
          matched_articles: l.articles
            .filter((a) => a.content.includes(keyword))
            .map((a) => `${a.article_no}: ${a.content.slice(0, 80)}...`),
        }));

      return buildEnvelope(matched, provenance, {
        query_keyword: keyword,
        query_category: category || "all",
        total_matched: matched.length,
      });
    },
  },
  {
    name: "get_kcg_law_detail",
    description: "依據法規代碼 (law_id) 或法規名稱查詢特定高雄市自治法規之完整條文與沿革",
    inputSchema: {
      type: "object",
      properties: {
        law_id: { type: "string", description: "法規代碼（例如：KCG-LAW-001）" },
        law_name: { type: "string", description: "法規完整名稱或精準關鍵字" },
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
          type: "object",
          properties: {
            law_id: { type: "string" },
            law_name: { type: "string" },
            category: { type: "string" },
            published_at: { type: "string" },
            history: { type: "string" },
            articles_count: { type: "number" },
            articles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  article_no: { type: "string" },
                  content: { type: "string" },
                },
                required: ["article_no", "content"],
              },
            },
          },
          required: ["law_id", "law_name", "category", "published_at", "articles"],
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const { law_id, law_name } = args;
      if (!law_id && !law_name) {
        throw new Error("必須提供 law_id 或 law_name 其中一項查詢參數");
      }

      const { laws, provenance } = await fetchLawsData(env);
      const target = laws.find(
        (l) => (law_id && l.law_id === law_id) || (law_name && l.law_name.includes(law_name))
      );

      if (!target) {
        throw new Error(`找不到符合條件之法規: ${law_id || law_name}`);
      }

      return buildEnvelope(
        {
          ...target,
          articles_count: target.articles.length,
        },
        provenance,
        { query_id: law_id, query_name: law_name }
      );
    },
  },
];
