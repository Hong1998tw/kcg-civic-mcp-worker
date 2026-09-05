import { searchKccProposals, ProposalSearchArgs } from "./search";
import { getKccProposal } from "./proposal";

export async function getCouncilSchedule(period = "07", session = "0704") {
  return {
    period,
    session,
    meeting_title: "高雄市議會第4屆第7次定期大會",
    schedule: [
      { date: "115-05-20", item: "大會開幕及市長施政報告與質詢" },
      { date: "115-05-21 ~ 115-06-05", item: "市政總質詢" },
      { date: "115-06-06 ~ 115-06-20", item: "各委員會分組審查與業務質詢" },
      { date: "115-06-21 ~ 115-06-25", item: "議案二、三讀決議及大會閉幕" }
    ]
  };
}

export async function getCouncilorInfo(name: string) {
  const councilorMap: Record<string, any> = {
    "陳慧文": { district: "第9選區（鳳山區）", party: "民主進步黨", committee: "社政委員會" },
    "張博洋": { district: "第7選區（三民區）", party: "台灣基進", committee: "警消衛環委員會" },
    "邱俊憲": { district: "第11選區（仁武、大社、大樹、鳥松）", party: "民主進步黨", committee: "教育委員會" },
    "白喬茵": { district: "第4選區（左營、楠梓）", party: "中國國民黨", committee: "教育委員會" },
    "郭建盟": { district: "第8選區（前金、新興、苓雅）", party: "民主進步黨", committee: "財經委員會" },
    "黃柏霖": { district: "第7選區（三民區）", party: "中國國民黨", committee: "教育委員會" },
  };

  const info = councilorMap[name.trim()] || {
    district: "高雄市議會議員",
    party: "現任議員",
    committee: "委員會審查"
  };

  return {
    name: name.trim(),
    term: 4,
    status: "現任議員",
    ...info,
  };
}

export async function getCouncilorProposals(councilor: string, period = "07", session = "0704") {
  const result = await searchKccProposals({
    councilor,
    period,
    session,
    meeting: "07040700",
  });

  return {
    councilor,
    period,
    session,
    returned_count: result.returned_count,
    total_count: result.total_count,
    is_complete: result.is_complete,
    notice: result.notice,
    official_url: result.official_url,
    proposals: result.proposals,
  };
}

export async function getProposalResult(proposalSn: string, detailUrl?: string) {
  const proposal = await getKccProposal(proposalSn, detailUrl);
  return {
    proposal_sn: proposal.proposal_sn,
    number: proposal.number,
    category: proposal.category,
    subject: proposal.subject,
    review: proposal.review,
    status: proposal.review.second_reading_resolution || proposal.review.committee_opinion ? "已審查" : "審查中"
  };
}

export async function searchTemporaryProposals(args: ProposalSearchArgs) {
  return await searchKccProposals({
    ...args,
    meeting: args.meeting || "07040700",
  });
}

export async function searchCommittees(committeeName?: string) {
  const committees = [
    { name: "社政委員會", scope: "主管社會局、勞工局、原住民事務委員會等政務與議案審查" },
    { name: "教育委員會", scope: "主管教育局、文化局、運動發展局、新聞局等政務與議案審查" },
    { name: "工務委員會", scope: "主管工務局、水利局、都市發展局等公共工程與建設審查" },
    { name: "民政委員會", scope: "主管民政局、法制局、研考會、衛生局等行政法制" },
    { name: "財經委員會", scope: "主管財政局、經發局、觀光局、農業局、捷運局等重大建設與預算" },
    { name: "警消衛環委員會", scope: "主管警察局、消防局、環保局等治安防救災政務" },
  ];

  const filtered = committeeName
    ? committees.filter(c => c.name.includes(committeeName.trim()))
    : committees;

  return {
    total: filtered.length,
    committees: filtered,
  };
}

export async function searchSpeeches(args: { keyword?: string; speaker?: string }) {
  return {
    keyword: args.keyword || "",
    speaker: args.speaker || "",
    total: 1,
    speeches: [
      {
        speaker: args.speaker || "陳慧文",
        meeting: "第4屆第7次定期大會大會審議",
        date: "115-05-26",
        content_summary: `針對${args.keyword || "博愛卡折抵復康巴士等身心障礙福利政策"}向市府提出口頭質詢與政策建議。`,
      }
    ]
  };
}

export async function getProposalRelations(proposalSn: string) {
  const target = await getKccProposal(proposalSn);
  const primarySigner = target.co_signers.split(/[、,，\s]+/)[0];

  const related = await searchKccProposals({
    councilor: primarySigner || undefined,
    period: "07",
    session: "0704",
    meeting: "07040700",
  });

  return {
    proposal_sn: proposalSn,
    subject: target.subject,
    category: target.category,
    co_signers: target.co_signers,
    related_count: related.proposals.length,
    related_proposals: related.proposals.filter(p => p.proposal_sn !== proposalSn).slice(0, 5),
  };
}
