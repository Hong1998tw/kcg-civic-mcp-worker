import { TOOL_REGISTRY } from "../src/mcp/tools";

async function run(councilor: string) {
  const tool = TOOL_REGISTRY.find(
    (t) => t.name === "kcc_search_proposals",
  );

  if (!tool) {
    throw new Error("找不到 kcc_search_proposals");
  }

  const result = await tool.handler(
    {
      councilor,
      keyword: "",
      period: "07",
      session: "0704",
      meeting: "07040800",
    },
    {} as any,
  );

  console.log(`\n===== ${councilor || "全部議員"} =====`);
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  await run("");
  await run("陳慧文");
  await run("黃捷");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
