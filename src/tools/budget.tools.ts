import { ToolDefinition } from "../models/types";
import { fetchBudgetRawData } from "../adapters/budget.adapter";
import { buildEnvelope } from "../utils/envelope";
import { parseBudgetSummaryRaw } from "./budget.parser";

const SUMMARY_CACHE = new Map<number, { result: any; expiresAt: number }>();
const SUMMARY_CACHE_TTL_MS = 1000 * 60 * 60;

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

export const BUDGET_TOOLS: ToolDefinition[] = [
  {
    name: "get_kcg_budget_summary",
    description: "取得高雄市政府指定民國年度之總預算綜合統計指標",
    inputSchema: {
      type: "object",
      properties: {
        year: { type: "number", description: "民國年度（例如：115）", default: 115 },
      },
      required: ["year"],
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
            year: { type: "number" },
            agency_count: { type: "number" },
            agency_sum_budget_thousand_twd: { type: "number" },
            official_total_budget_thousand_twd: { type: ["number", "null"], description: "原始資料明載之總額；未明載時為 null" },
            highest: { type: "object" },
            lowest: { type: "object" },
          },
          required: ["year", "agency_count", "agency_sum_budget_thousand_twd", "official_total_budget_thousand_twd"],
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const year = args.year === undefined ? 115 : Number(args.year);
      if (!Number.isInteger(year) || year < 1 || year > 999) throw new Error("year 必須是有效的民國年度");

      const cached = SUMMARY_CACHE.get(year);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }

      const { rawContent, provenance } = await fetchBudgetRawData(
        year,
        101174,
        "6712fdb8-c0ff-4f0c-901f-03023c17e15d",
        env
      );

      const parsed = parseBudgetSummaryRaw(rawContent);
      const result = buildEnvelope(
        {
          year,
          agency_count: parsed.agency_count,
          agency_sum_budget_thousand_twd: parsed.agency_sum_budget_thousand_twd,
          official_total_budget_thousand_twd: parsed.official_total_budget_thousand_twd,
          highest: parsed.highest,
          lowest: parsed.lowest,
        },
        provenance,
        {
          dataset_id: 101174,
          year,
          unit: "新臺幣千元",
          parser: "schema-aware-v2",
        }
      );

      SUMMARY_CACHE.set(year, { result, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS });
      return result;
    },
  },
];
