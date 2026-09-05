import { getKccProposal } from "../src/kcc/proposal";

async function main() {
  const result = await getKccProposal(
    "145231",
    "Detail.aspx?s=877CB6CEB53C8056&ct=EB02F15B1CDF9E89",
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
