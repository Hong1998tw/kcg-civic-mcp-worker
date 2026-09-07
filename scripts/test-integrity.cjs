const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { loadVerifiedSnapshot } = require("../.tmp-integrity/utils/integrity.js");
const { extractProposalSn, parseReviewTable } = require("../.tmp-integrity/kcc/proposal.js");
const { recordIdFromPdfUrl } = require("../.tmp-integrity/kcc/identity.js");
const { parsePager, parseProposalRows, selectedControlValue } = require("../.tmp-integrity/kcc/search.js");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

class FakeBucket {
  constructor(objects = {}) { this.objects = new Map(Object.entries(objects)); }
  async get(key) {
    if (!this.objects.has(key)) return null;
    const value = this.objects.get(key);
    return { text: async () => value };
  }
}

function releaseObjects({ status = "passed", revoked = false, normalizedText = "[]" } = {}) {
  const normalizedKey = "verified/kcg-laws/snapshot-1/normalized.json";
  const manifestKey = "verified/kcg-laws/snapshot-1/manifest.json";
  const manifest = JSON.stringify({
    schema_version: "2.0",
    dataset_id: "kcg-laws",
    snapshot_id: "snapshot-1",
    normalized_key: normalizedKey,
    normalized_sha256: sha256(normalizedText),
    source_url: "https://outlaw.kcg.gov.tw/index.aspx",
    fetched_at: "2026-09-08T00:00:00.000Z",
    validated_at: "2026-09-08T00:10:00.000Z",
    validation_status: status,
    revoked,
    record_count: JSON.parse(normalizedText).length,
    coverage: { scope: "selected_laws", complete: true },
    parser_version: "test-parser-1",
    validator_version: "test-validator-1",
  });
  const pointer = JSON.stringify({ manifest_key: manifestKey, manifest_sha256: sha256(manifest) });
  return {
    "releases/kcg-laws/active.json": pointer,
    [manifestKey]: manifest,
    [normalizedKey]: normalizedText,
  };
}

async function rejectsCode(objects, code) {
  await assert.rejects(() => loadVerifiedSnapshot({ kcg_civic_data: new FakeBucket(objects) }, "kcg-laws"),
    (error) => error && error.reasonCode === code);
}

(async () => {
  await rejectsCode({}, "SNAPSHOT_UNVERIFIED");
  await rejectsCode(releaseObjects({ status: "pending" }), "SNAPSHOT_UNVERIFIED");
  await rejectsCode(releaseObjects({ revoked: true }), "SNAPSHOT_REVOKED");

  const valid = releaseObjects();
  valid["verified/kcg-laws/snapshot-1/normalized.json"] = "[{}]";
  await rejectsCode(valid, "SNAPSHOT_UNVERIFIED");

  const loaded = await loadVerifiedSnapshot({ kcg_civic_data: new FakeBucket(releaseObjects()) }, "kcg-laws");
  assert.equal(loaded.manifest.snapshot_id, "snapshot-1");
  assert.deepEqual(loaded.records, []);

  const emptyReview = parseReviewTable(`<table>
    <tr><td>一讀(交付) 決議/交付日期：</td></tr>
    <tr><td>委員會審查意見</td><td>審查日期：</td></tr>
    <tr><td>二讀決議</td><td>決議日期：</td></tr>
    <tr><td>三讀決議 決議大會屆次：</td><td>決議日期：</td></tr>
  </table>`);
  assert.deepEqual(emptyReview, {
    first_reading: "", first_reading_date: "", committee_opinion: "", committee_date: "",
    second_reading_resolution: "", second_reading_date: "", third_reading_session: "", third_reading_date: "",
  });

  const positiveReview = parseReviewTable(`<table>
    <tr><td>一讀(交付) 決議：</td><td>交付民政委員會</td><td>交付日期：</td><td>115/09/08</td></tr>
    <tr><td>二讀決議：</td><td>照案通過</td><td>決議日期：</td><td>115/09/09</td></tr>
  </table>`);
  assert.equal(positiveReview.first_reading, "交付民政委員會");
  assert.equal(positiveReview.first_reading_date, "115/09/08");
  assert.equal(positiveReview.second_reading_resolution, "照案通過");

  assert.equal(extractProposalSn(`<input name="hidProposalSN" value="130445">`), "130445");
  assert.equal(extractProposalSn(`<input value="145223" id="ctl_hidProposalSN">`), "145223");
  assert.equal(recordIdFromPdfUrl("https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/9847/a.pdf"), "9847");
  assert.equal(recordIdFromPdfUrl("https://evil.example/Upload/Attachment/MeetingRecord/9847/a.pdf"), "");
  assert.equal(recordIdFromPdfUrl("https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/130445/a.pdf"), "130445");

  assert.deepEqual(parsePager("共 59 筆 1 / 6 頁 共 21 筆 共 4 筆 共 1 筆"), {
    total: null, page: 1, pages: 6, tabCounts: [59, 21, 4, 1],
  });
  assert.equal(selectedControlValue(`<select name="ddlPeriod"><option selected="selected" value="07">第四屆</option></select>`, "ddlPeriod"), "07");
  assert.equal(selectedControlValue(`<input value="不存在測試ZZZ" name="txtKeyword">`, "txtKeyword"), "不存在測試ZZZ");

  const mutationRows = parseProposalRows(`<table><tr>
    <td><input name="hidProposalSN" value="145223"></td><td>客決算案</td><td>民政</td>
    <td>客家文化事務基金會</td><td>114年度決算案</td><td>上程</td>
  </tr></table>`);
  assert.equal(mutationRows[0].proposal_kind, null);
  assert.equal(mutationRows[0].proposer_type, "unknown");
  assert.equal(mutationRows[0].councilor, undefined);

  console.log("Integrity regression tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
