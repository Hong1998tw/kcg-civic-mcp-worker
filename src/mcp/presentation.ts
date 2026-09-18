export const SERVER_PRESENTATION = {
  title: "高雄市公民資料 MCP",
  description:
    "提供高雄市政府與高雄市議會的可驗證公開資料查詢，包括預算、法規、新聞、提案與議事錄。",
  websiteUrl: "https://github.com/Hong1998tw/kcg-civic-mcp-worker",
} as const;

const TOOL_TITLES: Record<string, string> = {
  get_kcg_budget_summary: "查詢高雄市總預算摘要",
  search_kcg_laws: "搜尋高雄市法規",
  get_kcg_law_detail: "查詢高雄市法規全文",
  get_kcg_council_meetings: "查詢高雄市議會會議紀錄",
  search_kcg_council_interpellations: "搜尋高雄市議會質詢",
  get_kcg_latest_news: "取得高雄市最新市政新聞",
  search_kcg_news: "搜尋高雄市政新聞",
  kcc_search_proposals: "搜尋高雄市議會提案",
  kcc_get_proposal: "查詢高雄市議會提案詳情",
  kcc_get_attachments: "取得高雄市議會議案附件",
  kcc_search_meeting_records: "搜尋高雄市議會議事錄",
  kcc_get_schedule: "查詢高雄市議會日程（暫停）",
  kcc_get_councilor: "查詢高雄市議員資料（暫停）",
  kcc_get_councilor_proposals: "查詢高雄市議員提案",
  kcc_get_proposal_result: "查詢高雄市議案審議結果",
  kcc_search_temporary_proposals: "搜尋高雄市議會臨時提案（暫停）",
  kcc_search_committees: "搜尋高雄市議會委員會（暫停）",
  kcc_search_speeches: "搜尋高雄市議員發言（暫停）",
  kcc_get_proposal_relations: "查詢高雄市議案關聯（暫停）",
  kcc_get_meeting_record: "讀取高雄市議會單筆議事錄全文",
  kcc_search_meeting_record_content: "跨議事錄全文搜尋",
};

export function getToolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name;
}
