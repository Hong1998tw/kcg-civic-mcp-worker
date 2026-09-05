import { searchKccProposals } from "../src/kcc/search";
import { searchKccMeetingRecords } from "../src/kcc/meeting";

async function run() {
  console.log("=== 1. 測試議員提案搜尋 ===");
  const searchResult = await searchKccProposals({
    councilor: "陳慧文",
    period: "07",
    session: "0704",
    meeting: "07040700",
  });
  console.log(`找到提案數: ${searchResult.returned_count}/${searchResult.total_count ?? "未知"}`);
  if (searchResult.proposals.length > 0) {
    console.log("首筆提案 SN:", searchResult.proposals[0].proposal_sn);
  }

  console.log("\n=== 2. 測試議會議事錄／會議紀錄 ===");
  const meetingResult = await searchKccMeetingRecords({
    period: "07",
    keyword: "大會",
  });
  console.log(`找到會議紀錄數: ${meetingResult.total}`);
  if (meetingResult.records.length > 0) {
    console.log("首筆會議名稱:", meetingResult.records[0].meeting);
  }
}

run().catch(console.error);
