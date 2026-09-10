import { searchKccProposals } from "../src/kcc/search";

async function main() {
  const result = await searchKccProposals({
    keyword: "總預算",
    period: "07",
    session: "0704",
    meeting: "07040800",
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
