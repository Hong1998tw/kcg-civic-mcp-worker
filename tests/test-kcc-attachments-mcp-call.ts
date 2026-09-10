import { TOOL_REGISTRY } from "../src/mcp/tools";

async function main() {
  const tool = TOOL_REGISTRY.find(
    (t) => t.name === "kcc_get_attachments",
  );

  if (!tool) {
    throw new Error("找不到 kcc_get_attachments");
  }

  const result = await tool.handler(
    {
      proposal_sn: "145231",
    },
    {} as any,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
