import { ToolDefinition } from "../models/types";
import { buildKccEnvelope } from "../utils/envelope";
import { searchKccProposals } from "../kcc/search";
import { getKccProposal } from "../kcc/proposal";
import { getProposalAttachments } from "../kcc/attachment";
import { searchKccMeetingRecords } from "../kcc/meeting";
import { getMeetingRecordContent, searchMeetingRecordsContent } from "../kcc/record_reader";
import {
  getCouncilSchedule,
  getCouncilorInfo,
  getCouncilorProposals,
  getProposalResult,
  searchTemporaryProposals,
  searchCommittees,
  searchSpeeches,
  getProposalRelations,
} from "../kcc/advanced";

const KCC_PORTAL_URL = "https://cissearch.kcc.gov.tw";
const KCC_PROPOSAL_URL = `${KCC_PORTAL_URL}/System/Proposal/Default.aspx`;
const KCC_RECORD_URL = `${KCC_PORTAL_URL}/System/meetingrecord/default.aspx`;

function kccEnvelope<T>(data: T, sourceUrl = KCC_PROPOSAL_URL, meta: Record<string, any> = {}) {
  return buildKccEnvelope(data, sourceUrl, meta);
}

export const PROPOSAL_TOOLS: ToolDefinition[] = [
  {
    name: "kcc_search_proposals",
    description:
      "搜尋高雄市議會提案資料。支援依關鍵字、屆次、會期、類別及提案議員姓名過濾。【重要限制】官方查詢系統採分頁顯示且不開放程式翻頁，本工具僅能取得第一頁結果。請務必檢查 total_count 與 is_complete：當 is_complete 為 false 時，回傳的提案並非全部，須向使用者說明實際總數（total_count）並提供 official_url 供其查閱完整清單，不可將 returned_count 當作總件數。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜尋關鍵字" },
        period: { type: "string", description: "屆次代碼" },
        session: { type: "string", description: "會期代碼" },
        meeting: { type: "string", description: "會議代碼" },
        meeting_number: { type: ["string", "number"], description: "選填，官方頁面顯示的第幾次會議；由官方選項解析代碼" },
        councilor: { type: "string", description: "提案議員中文姓名" },
        category: {
          type: "string",
          description:
            "提案類別代碼：01民政、02社政、03財經、04教育、05農林、06交通、07警消衛環、08工務、09法規。留空為全部。指定類別可縮小結果集，降低被官方分頁截斷的機率。",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        returned_count: { type: "number", description: "本次實際回傳筆數" },
        total_count: {
          type: ["number", "null"],
          description: "官方查詢系統回報之符合條件總筆數；解析失敗時為 null",
        },
        is_complete: {
          type: ["boolean", "null"],
          description: "returned_count 是否已涵蓋 total_count 全部資料",
        },
        official_url: { type: "string", description: "官方查詢系統網址" },
        notice: { type: ["string", "null"], description: "資料不完整時之說明文字" },
        keyword: { type: "string" },
        councilor: { type: "string" },
        proposals: { type: "array" },
      },
    },
    handler: async (args: any) => kccEnvelope(await searchKccProposals(args || {}), KCC_PROPOSAL_URL, { query: args || {} }),
  },
  {
    name: "kcc_get_proposal",
    description: "依據議案流水號（proposal_sn）取得高雄市議會提案完整內容、案由、審查意見與決議。",
    inputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string", description: "議案流水號" },
        detail_url: { type: "string", description: "議案詳情相對路徑（選填）" },
      },
      required: ["proposal_sn"],
    },
    outputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string" },
        subject: { type: "string" },
        explanation: { type: "string" },
      },
    },
    handler: async (args: any) => kccEnvelope(await getKccProposal(args?.proposal_sn, args?.detail_url)),
  },
  {
    name: "kcc_get_attachments",
    description: "依據議案流水號取得該議案附屬文件、市府回覆書函檔案下載連結。",
    inputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string", description: "議案流水號" },
      },
      required: ["proposal_sn"],
    },
    outputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string" },
        attachments: { type: "array" },
      },
    },
    handler: async (args: any) => kccEnvelope(await getProposalAttachments(args?.proposal_sn), `${KCC_PORTAL_URL}/Common/GetAttachmentList.ashx`),
  },
  {
    name: "kcc_search_meeting_records",
    description: "查詢高雄市議會議事錄與會議紀錄（/System/meetingrecord/default.aspx）。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "關鍵字" },
        period: { type: "string", description: "屆次代碼" },
        session: { type: "string", description: "會期代碼" },
        meeting: { type: "string", description: "會議代碼" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        records: { type: "array" },
      },
    },
    handler: async (args: any) => kccEnvelope(await searchKccMeetingRecords(args || {}), KCC_RECORD_URL, { query: args || {} }),
  },
  {
    name: "kcc_get_schedule",
    description: "查詢高雄市議會定期大會與臨時會之議事日程、會期行事曆與各審查會排程。",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "屆次代碼（預設 07）" },
        session: { type: "string", description: "會期代碼（預設 0704）" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        period: { type: "string" },
        session: { type: "string" },
        schedule: { type: "array" },
      },
    },
    handler: async (args: any) => kccEnvelope(await getCouncilSchedule(args?.period, args?.session), KCC_RECORD_URL),
  },
  {
    name: "kcc_get_councilor",
    description: "查詢高雄市議會特定議員之基本資料、選區、所屬政黨與隸屬委員會。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "議員中文姓名（例如：陳慧文）" },
      },
      required: ["name"],
    },
    outputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        district: { type: "string" },
        party: { type: "string" },
        committee: { type: "string" },
      },
    },
    handler: async (args: any) => kccEnvelope(await getCouncilorInfo(args?.name)),
  },
  {
    name: "kcc_get_councilor_proposals",
    description:
      "匯整特定議員於指定會期之提案紀錄。【重要限制】受官方分頁限制，可能僅取得部分結果，請依 total_count 與 is_complete 判斷完整性，勿將 returned_count 當作該議員總提案數。",
    inputSchema: {
      type: "object",
      properties: {
        councilor: { type: "string", description: "議員中文姓名" },
        period: { type: "string", description: "屆次代碼" },
        session: { type: "string", description: "會期代碼" },
        meeting: { type: "string", description: "選填，8 位官方會議代碼" },
      },
      required: ["councilor"],
    },
    outputSchema: {
      type: "object",
      properties: {
        councilor: { type: "string" },
        returned_count: { type: "number", description: "本次實際回傳筆數" },
        total_count: { type: ["number", "null"], description: "官方回報之總筆數" },
        is_complete: { type: ["boolean", "null"], description: "是否已取得全部資料" },
        official_url: { type: "string" },
        notice: { type: ["string", "null"] },
        proposals: { type: "array" },
      },
    },
    handler: async (args: any) =>
      kccEnvelope(await getCouncilorProposals(args?.councilor, args?.period, args?.session, args?.meeting), KCC_PROPOSAL_URL),
  },
  {
    name: "kcc_get_proposal_result",
    description: "精準萃取特定議案流水號之一讀、委員會審查、二三讀決議與辦理狀態。",
    inputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string", description: "議案流水號" },
        detail_url: { type: "string", description: "議案詳情相對路徑" },
      },
      required: ["proposal_sn"],
    },
    outputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string" },
        status: { type: "string" },
        review: { type: "object" },
      },
    },
    handler: async (args: any) =>
      kccEnvelope(await getProposalResult(args?.proposal_sn, args?.detail_url)),
  },
  {
    name: "kcc_search_temporary_proposals",
    description: "專門檢索高雄市議會議員臨時提案紀錄。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "關鍵字" },
        councilor: { type: "string", description: "議員姓名" },
        period: { type: "string", description: "屆次代碼" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        returned_count: { type: "number" },
        total_count: { type: ["number", "null"] },
        is_complete: { type: ["boolean", "null"] },
        official_url: { type: "string" },
        notice: { type: ["string", "null"] },
        proposals: { type: "array" },
      },
    },
    handler: async (args: any) => kccEnvelope(await searchTemporaryProposals(args || {}), KCC_PROPOSAL_URL, { query: args || {} }),
  },
  {
    name: "kcc_search_committees",
    description: "查詢高雄市議會各委員會名稱、權責範疇與審查業務。",
    inputSchema: {
      type: "object",
      properties: {
        committee_name: { type: "string", description: "委員會名稱關鍵字" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        committees: { type: "array" },
      },
    },
    handler: async (args: any) => kccEnvelope(await searchCommittees(args?.committee_name), `${KCC_PORTAL_URL}/System/Committee/Default.aspx`),
  },
  {
    name: "kcc_search_speeches",
    description: "檢索議員在大會或各委員會之發言公報與質詢對話摘要。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "發言內容關鍵字" },
        speaker: { type: "string", description: "發言議員姓名" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        speeches: { type: "array" },
      },
    },
    handler: async (args: any, env: any) => kccEnvelope(await searchSpeeches(args || {}, env), KCC_RECORD_URL, { query: args || {} }),
  },
  {
    name: "kcc_get_proposal_relations",
    description: "針對特定議案進行同類別、相同連署人與關聯提案之交叉分析推介。",
    inputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string", description: "基準議案流水號" },
      },
      required: ["proposal_sn"],
    },
    outputSchema: {
      type: "object",
      properties: {
        proposal_sn: { type: "string" },
        category: { type: "string" },
        related_proposals: { type: "array" },
      },
    },
    handler: async (args: any) => kccEnvelope(await getProposalRelations(args?.proposal_sn)),
  },
  {
    name: "kcc_get_meeting_record",
    description:
      "取得並檢索特定議事錄／會議紀錄 PDF 之完整文字內容（整合 R2 文字層快取）。支援依 record_id 與關鍵字檢索特定議員發言、質詢主題或決議事項。",
    inputSchema: {
      type: "object",
      properties: {
        record_id: { type: "string", description: "會議紀錄 ID（例如：'9847'）" },
        pdf_url: { type: "string", description: "議事錄 PDF 下載連結（選填）" },
        keyword: { type: "string", description: "欲全文檢索之關鍵字（例如：'工務局'、'質詢'）" },
        page: { type: "number", description: "指定讀取之頁碼（選填）" },
      },
      required: ["record_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        record_id: { type: "string" },
        pdf_url: { type: "string" },
        total_pages: { type: "number" },
        from_cache: { type: "boolean" },
        matched_pages_count: { type: "number" },
        matches: { type: "array" },
        page_content: { type: "string" },
      },
    },
    handler: async (args: any, env: any) =>
      kccEnvelope(await getMeetingRecordContent(args || {}, env), KCC_RECORD_URL),
  },
  {
    name: "kcc_search_meeting_record_content",
    description:
      "【跨議事錄全文檢索】自動依序檢索高雄市議會最新數場會議紀錄 PDF 內文（整合 R2 文字層快取）。適合查詢『某議員最近質詢了什麼』、『特定市政議題在哪幾場會議中被提出』等跨會議問答。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "欲跨會議檢索之關鍵字（例如：'陳慧文'、'博愛卡'、'石綿瓦'）" },
        limit_records: { type: "number", description: "向後掃描之最新議事錄數量（預設 8 場，上限 15）" },
        period: { type: "string", description: "指定屆次（選填）" },
        session: { type: "string", description: "指定會期（選填）" },
      },
      required: ["keyword"],
    },
    outputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        scanned_records_count: { type: "number" },
        matched_records_count: { type: "number" },
        records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              record_id: { type: "string" },
              meeting: { type: "string" },
              date: { type: "string" },
              pdf_url: { type: "string" },
              from_cache: { type: "boolean" },
              matched_pages_count: { type: "number" },
              matches: { type: "array" },
            },
          },
        },
      },
    },
    handler: async (args: any, env: any) =>
      kccEnvelope(await searchMeetingRecordsContent(args || {}, env), KCC_RECORD_URL),
  },
];

// Every tool exposes the same top-level contract. The detailed payload remains
// under `data`, allowing clients to handle live KCC and snapshot tools uniformly.
const KCC_ENVELOPE_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "error", "partial"] },
    provider: { type: "string" },
    updated_at: { type: "string" },
    provenance: { type: "object" },
    meta: { type: "object" },
    data: {},
  },
  required: ["status", "provider", "updated_at", "provenance", "meta", "data"],
};
for (const tool of PROPOSAL_TOOLS) tool.outputSchema = KCC_ENVELOPE_SCHEMA;
