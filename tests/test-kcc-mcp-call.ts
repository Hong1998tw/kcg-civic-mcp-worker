import { TOOL_REGISTRY } from "../src/mcp/tools";

async function main() {
  const tool = TOOL_REGISTRY.find(
    (t) => t.name === "kcc_search_proposals",
  );

  if (!tool) {
    throw new Error("找不到 kcc_search_proposals");
  }

  const result = await tool.handler(
    {
      keyword: "總預算",
      period: "07",
      session: "0704",
      meeting: "07040800",
    },
    {} as any,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
