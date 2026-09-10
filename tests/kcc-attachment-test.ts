import { getProposalAttachments } from "../src/kcc/attachment";

async function main() {
  const result = await getProposalAttachments("145231");

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
