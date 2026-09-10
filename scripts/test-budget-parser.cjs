const assert = require("node:assert/strict");
const path = require("node:path");

const parserPath = path.resolve(process.cwd(), ".tmp-budget-parser", "budget.parser.js");
const { parseBudgetSummaryRaw } = require(parserPath);

const csvFixture = `\uFEFFSeq,科目名稱,本年度預算數,上年度預算數,前年度決算數,本年度與上年度比較\n1,合計,"197,823,502","193,651,554","164,102,633","4,171,948"\n2,高雄市議會主管,"938,407","904,738","752,533","33,669"\n3,高雄市政府主管,"8,373,640","8,316,105","7,024,304","57,535"\n4,高雄市政府民政局主管,"2,109,070","1,669,588","1,468,396","439,482"\n5,高雄市政府財政局主管,"4,594,128","4,393,087","3,705,814","201,041"\n6,高雄市政府教育局主管,"61,864,076","60,523,147","57,891,618","1,340,929"\n7,高雄市政府經濟發展局主管,"2,370,206","2,023,224","902,955","346,982"\n`;

const parsed = parseBudgetSummaryRaw(csvFixture);

assert.equal(parsed.official_total_budget_thousand_twd, 197823502);
assert.equal(parsed.agency_count, 6);
assert.equal(parsed.agency_sum_budget_thousand_twd, 80249527);
assert.deepEqual(parsed.highest, {
  record_type: "agency",
  account_name: "高雄市政府教育局主管",
  budget_thousand_twd: 61864076,
});
assert.deepEqual(parsed.lowest, {
  record_type: "agency",
  account_name: "高雄市議會主管",
  budget_thousand_twd: 938407,
});

assert.throws(
  () => parseBudgetSummaryRaw("Seq,其他欄位\n1,foo\n"),
  /schema 不符|解析失敗/
);

console.log("Budget parser regression test passed");
