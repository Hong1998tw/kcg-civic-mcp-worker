import { TOOL_REGISTRY } from "../src/mcp/tools";

async function main() {
  const tool = TOOL_REGISTRY.find(
    (t) => t.name === "kcc_get_proposal",
  );

  if (!tool) {
    throw new Error("找不到 kcc_get_proposal");
  }

  const result = await tool.handler(
    {
      proposal_sn: "145231",
      detail_url:
        "Detail.aspx?s=877CB6CEB53C8056&ct=EB02F15B1CDF9E89",
    },
    {} as any,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
