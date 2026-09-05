import { ToolDefinition } from "../models/types";
import { fetchBudgetRawData } from "../adapters/budget.adapter";
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
            official_total_budget_thousand_twd: { type: "number" },
            highest: { type: "object" },
            lowest: { type: "object" },
          },
          required: ["year", "agency_count", "agency_sum_budget_thousand_twd", "official_total_budget_thousand_twd"],
        },
      },
      required: ["status", "provider", "updated_at", "provenance", "data"],
    },
    handler: async (args, env) => {
      const year = args.year || 115;
      const { rawContent, provenance } = await fetchBudgetRawData(
        year,
        101174,
        "6712fdb8-c0ff-4f0c-901f-03023c17e15d",
        env
      );

      const lines = rawContent.split("\n").filter((l) => l.trim().length > 0);
      let agencySum = 0;
      let agencyCount = 0;
      let highest = { record_type: "agency", account_name: "", budget_thousand_twd: 0 };
      let lowest = { record_type: "agency", account_name: "", budget_thousand_twd: Number.MAX_SAFE_INTEGER };

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        const name = cols[0];
        const val = parseInt(cols[1]?.replace(/[^\d]/g, ""), 10);
        if (!isNaN(val) && name && !name.includes("合計") && !name.includes("總額")) {
          agencyCount++;
          agencySum += val;
          if (val > highest.budget_thousand_twd) highest = { record_type: "agency", account_name: name, budget_thousand_twd: val };
          if (val < lowest.budget_thousand_twd) lowest = { record_type: "agency", account_name: name, budget_thousand_twd: val };
        }
      }

      return buildEnvelope(
        {
          year,
          agency_count: agencyCount,
          agency_sum_budget_thousand_twd: agencySum,
          official_total_budget_thousand_twd: 197823502,
          highest,
          lowest,
        },
        provenance,
        { dataset_id: 101174, year, unit: "新臺幣千元" }
      );
    },
  },
];
