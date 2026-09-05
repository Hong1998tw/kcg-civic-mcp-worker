import { ToolDefinition } from "../models/types";
import { BUDGET_TOOLS } from "../tools/budget.tools";
import { LAW_TOOLS } from "../tools/laws.tools";
import { COUNCIL_TOOLS } from "../tools/council.tools";
import { NEWS_TOOLS } from "../tools/news.tools";
import { PROPOSAL_TOOLS } from "../tools/proposals.tools";

export const TOOL_REGISTRY: ToolDefinition[] = [
  ...BUDGET_TOOLS,
  ...LAW_TOOLS,
  ...COUNCIL_TOOLS,
  ...NEWS_TOOLS,
  ...PROPOSAL_TOOLS,
];
