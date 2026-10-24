import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/kcc/search.ts", import.meta.url), "utf8");
const compiled = await transform(source.replace(/^import.*from "\.\/client";/m,
  "const fetchWebFormsTokens = async () => { throw new Error('offline parser test'); };"), { loader: "ts", format: "esm" });
const { selectedControlValue, parseProposalRows, parsePager } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`,
);

// Minimal official control structure, with entirely synthetic TEST proposal data.
const globalKeyword = '<input name="ctl00$txtKeyword" id="txtKeyword" value="TEST_GLOBAL">';
const queryKeyword = '<input name="ctl00$ContentPlaceHolder1$txtKeyword" type="text" value="道路" id="ContentPlaceHolder1_txtKeyword">';
const dropdowns = '<select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlPeriod" id="ContentPlaceHolder1_uscPeriodSessionMeeting_ddlPeriod"><option selected="selected" value="07">TEST</option></select>'
  + '<select name="ctl00$ContentPlaceHolder1$uscPeriodSessionMeeting$ddlSession" id="ContentPlaceHolder1_uscPeriodSessionMeeting_ddlSession"><option value="0703">TEST</option><option selected="selected" value="0704">TEST</option></select>';
const syntheticRow = '<table><tr><td><input name="TEST$hidProposalSN" value="999001"><input name="TEST$hidProposalKind" value="01"></td><td>TEST 1</td><td>TEST</td><td>TEST</td><td><a href="Detail.aspx?s=999001">TEST 道路改善案</a></td><td>TEST</td></tr></table><span>共 1 筆</span><span>1 / 1 頁</span>';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

test("official proposal controls ignore the earlier master-page search", () => {
  const html = globalKeyword + dropdowns + queryKeyword + syntheticRow;
  for (const [control, expected] of [["ddlPeriod", "07"], ["ddlSession", "0704"], ["txtKeyword", "道路"]]) {
    assert.equal(selectedControlValue(html, control), expected);
  }
  assert.equal(parseProposalRows(html)[0].subject, "TEST 道路改善案");
  assert.deepEqual(parsePager(html), { total: 1, page: 1, pages: 1, tabCounts: [1] });
});
test("control order does not change the selected proposal keyword", () => {
  assert.equal(selectedControlValue(queryKeyword + globalKeyword, "txtKeyword"), "道路");
});
test("a missing proposal keyword cannot use the global search value", () => {
  assert.equal(selectedControlValue(globalKeyword.replace("TEST_GLOBAL", "道路"), "txtKeyword"), "");
});
test("lookalike suffixes and data attributes do not identify a proposal control", () => {
  const html = '<input name="OTHER$txtKeyword" value="道路"><input data-name="ctl00$ContentPlaceHolder1$txtKeyword" value="道路"><input id="ContentPlaceHolder1_txtKeyword_extra" value="道路">';
  assert.equal(selectedControlValue(html, "txtKeyword"), "");
});
test("duplicate official controls fail closed even when values agree", () => {
  assert.throws(() => selectedControlValue(queryKeyword + queryKeyword, "txtKeyword"), /PARSER_CONTRACT_CHANGED/);
});
test("a conflicting name and id fail closed", () => {
  assert.throws(() => selectedControlValue(queryKeyword.replace('id="ContentPlaceHolder1_txtKeyword"', 'id="txtKeyword"'), "txtKeyword"), /PARSER_CONTRACT_CHANGED/);
});
test("either exact official name or exact official id identifies a lone control", () => {
  assert.equal(selectedControlValue('<input name="ctl00$ContentPlaceHolder1$txtKeyword" value="道路">', "txtKeyword"), "道路");
  assert.equal(selectedControlValue('<input id="ContentPlaceHolder1_txtKeyword" value="道路">', "txtKeyword"), "道路");
});
test("official dropdowns reject duplicates and multiple selected values", () => {
  assert.throws(() => selectedControlValue(dropdowns + dropdowns, "ddlPeriod"), /PARSER_CONTRACT_CHANGED/);
  assert.throws(() => selectedControlValue(dropdowns.replace('<option value="0703">', '<option selected value="0703">'), "ddlSession"), /PARSER_CONTRACT_CHANGED/);
});
test("unselected dropdowns and unknown controls cannot confirm a value", () => {
  assert.equal(selectedControlValue(dropdowns.replaceAll('selected="selected"', ''), "ddlPeriod"), "");
  assert.equal(selectedControlValue(queryKeyword, "UNKNOWN"), "");
});
console.log(`${passed} KCC filter-control tests passed (offline synthetic fixtures).`);
