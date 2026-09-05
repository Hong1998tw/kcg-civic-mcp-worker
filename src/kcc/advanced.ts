import { searchKccProposals, ProposalSearchArgs } from "./search";
import { getKccProposal } from "./proposal";
import { searchKccMeetingRecords } from "./meeting";
import { searchMeetingRecordsContent } from "./record_reader";

export const KCC_PORTAL_URL = "https://cissearch.kcc.gov.tw";

export async function getCouncilSchedule(period = "07", session = "0704") {
  const records = await searchKccMeetingRecords({ period, session });
  return {
    period,
    session,
    official_url: `${KCC_PORTAL_URL}/System/meetingrecord/default.aspx`,
    schedule: records.records.map((record) => ({
      record_id: record.record_id,
      date: record.date,
      meeting: record.meeting,
      record_type: record.record_type,
      pdf_url: record.pdf_url,
    })),
    total: records.total,
    notice: "議事日程以官方議事錄查詢結果為準；本工具不補造未公布的日期。",
  };
}

export async function getCouncilorInfo(name: string) {
  const normalized = String(name || "").trim();
  if (!normalized || normalized.length > 50) throw new Error("請提供有效的議員姓名");
  // The official proposal portal can confirm searchable activity, but it does not
  // expose a stable public profile API for district/party/committee in this worker.
  // Return unknown fields explicitly instead of inventing biographical data.
  return {
    name: normalized,
    term: 4,
    status: "需以官方議員名錄核對",
    district: null,
    party: null,
    committee: null,
    official_url: `${KCC_PORTAL_URL}/System/Proposal/Default.aspx`,
    notice: "目前官方公開查詢介面未提供可穩定擷取的議員名錄欄位；已避免回傳未驗證的選區、政黨或委員會資料。",
  };
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
  return { councilor: name, period, session, ...result };
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
    status: review.third_reading_session || review.second_reading_resolution
      ? "已完成議會審議"
      : review.committee_opinion || review.first_reading
        ? "已進入審議程序"
        : "官方頁面未載明審議結果",
    detail_url: proposal.detail_url,
  };
}

export async function searchTemporaryProposals(args: ProposalSearchArgs = {}) {
  // Do not silently force a meeting code. An explicit meeting supplied by the
  // caller is respected; otherwise the official search covers the selected scope.
  return searchKccProposals({ ...args });
}

export async function searchCommittees(committeeName?: string) {
  const committees = [
    { name: "民政委員會", scope: "民政、法制及行政業務" },
    { name: "財經委員會", scope: "財政、經濟發展、觀光及農業業務" },
    { name: "教育委員會", scope: "教育、文化及體育業務" },
    { name: "工務委員會", scope: "工務、水利及都市發展業務" },
    { name: "警消衛環委員會", scope: "警政、消防、衛生及環境業務" },
    { name: "社政委員會", scope: "社會、勞工及原住民族業務" },
  ];
  const query = String(committeeName || "").trim();
  const filtered = query ? committees.filter((c) => c.name.includes(query) || c.scope.includes(query)) : committees;
  return {
    total: filtered.length,
    committees: filtered,
    official_url: `${KCC_PORTAL_URL}/System/Committee/Default.aspx`,
    notice: "委員會名稱與職掌以高雄市議會最新公告為準。",
  };
}

export async function searchSpeeches(args: { keyword?: string; speaker?: string }, env?: any) {
  const keyword = String(args.keyword || "").trim();
  const speaker = String(args.speaker || "").trim();
  if (!keyword && !speaker) throw new Error("請提供 keyword 或 speaker");
  const content = await searchMeetingRecordsContent({ keyword: speaker || keyword, limit_records: 5 }, env);
  const speeches = content.records.flatMap((record) => record.matches.flatMap((match) =>
    match.snippets.map((snippet) => ({
      speaker: speaker || null,
      meeting: record.meeting,
      date: record.date,
      record_id: record.record_id,
      page: match.page,
      content_summary: snippet,
    }))));
  return {
    keyword,
    speaker,
    total: speeches.length,
    speeches,
    official_url: `${KCC_PORTAL_URL}/System/meetingrecord/default.aspx`,
    notice: speaker
      ? "依議事錄 PDF 文字層命中結果回傳；speaker 只作為查詢關鍵字，不代表官方已標註發言者欄位。"
      : "依議事錄 PDF 文字層命中結果回傳。",
  };
}

export async function getProposalRelations(proposalSn: string) {
  const target = await getKccProposal(proposalSn);
  const query = target.subject.trim().slice(0, 80);
  const related = query ? await searchKccProposals({ keyword: query }) : null;
  return {
    proposal_sn: proposalSn,
    subject: target.subject,
    category: target.category,
    co_signers: target.co_signers,
    related_count: related?.proposals.filter((p) => p.proposal_sn !== proposalSn).length || 0,
    related_proposals: related?.proposals.filter((p) => p.proposal_sn !== proposalSn).slice(0, 5) || [],
    notice: related?.notice || "以案由關鍵字比對官方查詢結果；不推論未被官方資料支持的關聯。",
  };
}
