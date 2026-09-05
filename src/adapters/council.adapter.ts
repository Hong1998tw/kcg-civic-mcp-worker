import { Env, Provenance } from "../models/types";
import { calculateSha256 } from "../utils/crypto";
import { isTruthy } from "../utils/envelope";

export interface CouncilMeeting {
  meeting_id: string;
  term: number;
  session_period: number;
  meeting_name: string;
  meeting_date: string;
  agenda: string;
}

export interface CouncilInterpellation {
  record_id: string;
  term: number;
  session_period: number;
  legislator_name: string;
  topic: string;
  content_summary: string;
  date: string;
}

export interface CouncilData {
  meetings: CouncilMeeting[];
  interpellations: CouncilInterpellation[];
}

let COUNCIL_CACHE: { data: CouncilData; provenance: Provenance; expiresAt: number } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

export async function fetchCouncilData(env: Env): Promise<{ data: CouncilData; provenance: Provenance }> {
  const now = Date.now();
  if (COUNCIL_CACHE && COUNCIL_CACHE.expiresAt > now) {
    return { data: COUNCIL_CACHE.data, provenance: COUNCIL_CACHE.provenance };
  }

  const agency = "高雄市議會";
  const sourceId = "kcg_council";

  // 1. 第一順位：高雄市議會開放資料端點 (限時 1200ms)
  try {
    const upstreamUrl = "https://data.kcg.gov.tw/dataset/kcg-council/resource/download.json";
    const resp = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    if (resp.ok) {
      const text = await resp.text();
      const parsed = JSON.parse(text) as Partial<CouncilData>;
      if (!Array.isArray(parsed.meetings) || !Array.isArray(parsed.interpellations)) throw new Error("council schema");
      const data = parsed as CouncilData;
      const provenance: Provenance = {
        source_id: sourceId,
        source_url: upstreamUrl,
        source_type: "openapi",
        agency,
        retrieved_at: new Date().toISOString(),
        content_hash: await calculateSha256(text),
      };
      COUNCIL_CACHE = { data, provenance, expiresAt: now + CACHE_TTL_MS };
      return { data, provenance };
    }
  } catch (_) {}

  // 2. 第二順位：Cloudflare R2 備援 (council/council_data.json)
  const r2Key = "council/council_data.json";
  let rawContent = "";
  let usedDemo = false;

  if (env.kcg_civic_data) {
    try {
      const r2Object = await env.kcg_civic_data.get(r2Key);
      if (r2Object) rawContent = await r2Object.text();
    } catch (_) {}
  }

  // Demo data is opt-in. Production must never present fabricated council
  // records as official data when upstream and R2 are unavailable.
  if (!rawContent && isTruthy(env.MCP_ALLOW_DEMO_DATA)) {
    usedDemo = true;
    rawContent = JSON.stringify({
      meetings: [
        {
          meeting_id: "MTG-04-03-01",
          term: 4,
          session_period: 3,
          meeting_name: "第 4 屆第 3 次定期大會 第 1 次會議",
          meeting_date: "2024-04-10",
          agenda: "市長施政報告與質詢、各委員會審議議案",
        },
        {
          meeting_id: "MTG-04-04-01",
          term: 4,
          session_period: 4,
          meeting_name: "第 4 屆第 4 次定期大會 市政總質詢",
          meeting_date: "2024-10-15",
          agenda: "市政總質詢、114年度地方總預算案二三讀審查",
        },
      ],
      interpellations: [
        {
          record_id: "INT-04-04-001",
          term: 4,
          session_period: 4,
          legislator_name: "李議員",
          topic: "輕軌成圓後營運班距優化與轉乘接駁配套研析",
          content_summary: "建請交通局與捷運工程局持續檢討尖峰班距，並加強沿線 YouBike 站點調度與行人動線整合。",
          date: "2024-10-16",
        },
        {
          record_id: "INT-04-04-002",
          term: 4,
          session_period: 4,
          legislator_name: "陳議員",
          topic: "楠梓產業園區半導體供應鏈水電配套與周邊交通疏導進度",
          content_summary: "督促經發局與水利局確保再生水廠如期通水，並要求交通局提早啟動周邊幹道號誌時相重整規劃。",
          date: "2024-10-18",
        },
      ],
    });
  }

  if (!rawContent) throw new Error("無法取得議會資料：官方端點與 R2 備援皆不可用");

  let data: CouncilData;
  try {
    const parsed = JSON.parse(rawContent) as Partial<CouncilData>;
    if (!Array.isArray(parsed.meetings) || !Array.isArray(parsed.interpellations)) throw new Error("schema");
    data = parsed as CouncilData;
  } catch {
    throw new Error("議會資料格式無效");
  }
  const provenance: Provenance = {
    source_id: sourceId,
    source_url: `r2://kcg-civic-data/${r2Key}`,
    source_type: usedDemo ? "fallback" : "r2",
    agency,
    retrieved_at: new Date().toISOString(),
    content_hash: await calculateSha256(rawContent),
  };

  COUNCIL_CACHE = { data, provenance, expiresAt: now + CACHE_TTL_MS };
  return { data, provenance };
}
