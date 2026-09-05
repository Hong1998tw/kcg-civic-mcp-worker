import { TOOL_REGISTRY } from "../src/mcp/tools";

console.log(`目前註冊總工具數: ${TOOL_REGISTRY.length}`);
console.log("\n已註冊的 KCC 即時議案工具：");
TOOL_REGISTRY.filter(t => t.name.startsWith("kcc_")).forEach(t => {
  console.log(`- ${t.name}: ${t.description}`);
});
