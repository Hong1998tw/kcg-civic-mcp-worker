import { ToolDefinition } from "../models/types";
import { fetchNewsData } from "../adapters/news.adapter";
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

export const NEWS_TOOLS: ToolDefinition[] = [
  {
    name: "get_kcg_latest_news",
    description: "取得高雄市政府最新市政焦點新聞與各局處重要公告快訊",
    inputSchema: {
      type: "object",
      properties: {
        agency: { type: "string", description: "選填，依特定局處名稱篩選（例如：交通局、經濟發展局）" },
        category: { type: "string", description: "選填，新聞分類（例如：產業發展、交通運輸、文化生活）" },
        limit: { type: "number", description: "回傳筆數上限", default: 10 },
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
              news_id: { type: "string" },
              title: { type: "string" },
              agency: { type: "string" },
              category: { type: "string" },
              published_at: { type: "string" },
              content_summary: { type: "string" },
              source_link: { type: "string" },
            },
            required: ["news_id", "title", "agency", "category", "published_at", "content_summary"],
          },
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const agency = args.agency?.trim();
      const category = args.category?.trim();
      const limit = typeof args.limit === "number" ? args.limit : 10;

      const { news, provenance } = await fetchNewsData(env);

      const matched = news
        .filter((item) => {
          const matchAgency = !agency || item.agency.includes(agency);
          const matchCategory = !category || item.category.includes(category);
          return matchAgency && matchCategory;
        })
        .slice(0, limit);

      return buildEnvelope(matched, provenance, {
        agency_filter: agency || "all",
        category_filter: category || "all",
        total: matched.length,
      });
    },
  },
  {
    name: "search_kcg_news",
    description: "依關鍵字檢索高雄市政施政報導、公共工程進度及政策公告歷史",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "新聞標題或內容關鍵字" },
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
              news_id: { type: "string" },
              title: { type: "string" },
              agency: { type: "string" },
              category: { type: "string" },
              published_at: { type: "string" },
              content_summary: { type: "string" },
              source_link: { type: "string" },
            },
            required: ["news_id", "title", "agency", "category", "published_at", "content_summary"],
          },
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const keyword = (args.keyword || "").trim();
      const limit = typeof args.limit === "number" ? args.limit : 10;

      const { news, provenance } = await fetchNewsData(env);

      const matched = news
        .filter((item) => item.title.includes(keyword) || item.content_summary.includes(keyword))
        .slice(0, limit);

      return buildEnvelope(matched, provenance, {
        query_keyword: keyword,
        total: matched.length,
      });
    },
  },
];
