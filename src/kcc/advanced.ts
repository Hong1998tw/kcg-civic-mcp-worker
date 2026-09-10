import { searchKccProposals, ProposalSearchArgs } from "./search";
import { getKccProposal } from "./proposal";
import { searchKccMeetingRecords } from "./meeting";
import { searchMeetingRecordsContent } from "./record_reader";
import { unavailable } from "../utils/integrity";

export const KCC_PORTAL_URL = "https://cissearch.kcc.gov.tw";

export async function getCouncilSchedule(period = "07", session = "0704"): Promise<any> {
  void period; void session;
  return unavailable("議事日程（現有實作誤用議事錄來源）");
}

export async function getCouncilorInfo(name: string): Promise<any> {
  const normalized = String(name || "").trim();
  if (!normalized || normalized.length > 50) throw new Error("請提供有效的議員姓名");
  return unavailable(`議員名錄：${normalized}`);
}

export async function getCouncilorProposals(
  councilor: string,
  period = "07",
  session = "0704",
  meeting?: string,
) {
  const name = String(councilor || "").trim();
  if (!name) throw new Error("councilor 不可為空");
  const result = await searchKccProposals({ councilor: name, period, session, meeting });
  return { ...result, period, session };
}

export async function getProposalResult(proposalSn: string, detailUrl?: string) {
  const proposal = await getKccProposal(proposalSn, detailUrl);
  const review = proposal.review;
  return {
    proposal_sn: proposal.proposal_sn,
    number: proposal.number,
    category: proposal.category,
    subject: proposal.subject,
    review,
    official_status: proposal.official_status || null,
    council_review_status: review.third_reading_session || review.third_reading_date || review.second_reading_resolution || review.second_reading_date
      ? "已完成議會審議"
      : review.committee_opinion || review.first_reading
        ? "已進入審議程序"
        : "官方頁面未載明審議結果",
    executive_status: null,
    status: proposal.official_status || "官方頁面未載明案件狀態",
    detail_url: proposal.detail_url,
  };
}

export async function searchTemporaryProposals(args: ProposalSearchArgs = {}): Promise<any> {
  void args;
  return unavailable("臨時提案專用種類／分頁查詢");
}

export async function searchCommittees(committeeName?: string): Promise<any> {
  void committeeName;
  return unavailable("議會委員會即時名錄");
}

export async function searchSpeeches(args: { keyword?: string; speaker?: string }, env?: any): Promise<any> {
  const keyword = String(args.keyword || "").trim();
  const speaker = String(args.speaker || "").trim();
  if (!keyword && !speaker) throw new Error("請提供 keyword 或 speaker");

  void env;
  return unavailable(`發言歸屬查詢：${speaker || keyword}`);
}

export async function getProposalRelations(proposalSn: string): Promise<any> {
  if (!/^\d+$/.test(String(proposalSn || ""))) throw new Error("proposal_sn 必須是數字流水號");
  return unavailable(`議案關聯推論：${proposalSn}`);
}
