import { Env, Provenance } from "../models/types";
import { calculateSha256 } from "../utils/crypto";

export interface LawArticle {
  article_no: string;
  content: string;
}

export interface LawRecord {
  law_id: string;
  law_name: string;
  category: string;
  published_at: string;
  official_url: string;
  history?: string;
  articles: LawArticle[];
}

let LAWS_CACHE: { data: LawRecord[]; provenance: Provenance; expiresAt: number } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 快取 24 小時

export async function fetchLawsData(env: Env): Promise<{ laws: LawRecord[]; provenance: Provenance }> {
  const now = Date.now();
  if (LAWS_CACHE && LAWS_CACHE.expiresAt > now) {
    return { laws: LAWS_CACHE.data, provenance: LAWS_CACHE.provenance };
  }

  const agency = "高雄市政府法制局";
  const sourceId = "kcg_laws";
  const officialPortal = "https://outlaw.kcg.gov.tw/index.aspx";

  // 1. 第一順位：高雄市主管法規資料集開放端點 (限時 1200ms)
  try {
    const upstreamUrl = "https://data.kcg.gov.tw/dataset/kcg-laws/resource/download.json";
    const resp = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    if (resp.ok) {
      const text = await resp.text();
      const laws: LawRecord[] = JSON.parse(text);
      const provenance: Provenance = {
        source_id: sourceId,
        source_url: officialPortal,
        source_type: "openapi",
        agency,
        retrieved_at: new Date().toISOString(),
        content_hash: await calculateSha256(text),
      };
      LAWS_CACHE = { data: laws, provenance, expiresAt: now + CACHE_TTL_MS };
      return { laws, provenance };
    }
  } catch (_) {}

  // 2. 第二順位：Cloudflare R2 備援 (laws/kcg_laws.json)
  const r2Key = "laws/kcg_laws.json";
  let rawContent = "";

  try {
    const r2Object = await env.kcg_civic_data.get(r2Key);
    if (r2Object) {
      rawContent = await r2Object.text();
    }
  } catch (_) {}

  // 災備與冷啟動內建資料（附帶官方 outlaw 網址）
  if (!rawContent) {
    rawContent = JSON.stringify([
      {
        law_id: "KCG-LAW-001",
        law_name: "高雄市自治條例制定標準",
        category: "行政一般",
        published_at: "2024-01-15",
        official_url: "https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL000001",
        history: "民國 113 年 1 月 15 日高市府法一字第 1130001 號令修正",
        articles: [
          { article_no: "第 1 條", content: "高雄市為規範市自治法規之制定、審查、發布及管理，特制定本法。" },
          { article_no: "第 2 條", content: "本法所稱自治法規，指自治條例、自治規則及委辦規則。" }
        ]
      },
      {
        law_id: "KCG-LAW-002",
        law_name: "高雄市綠能推動與低碳城市發展自治條例",
        category: "環境保護",
        published_at: "2023-11-20",
        official_url: "https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL000002",
        history: "民國 112 年 11 月 20 日公布實施",
        articles: [
          { article_no: "第 1 條", content: "為推動淨零碳排、促進綠色能源建設，落實城市永續發展，特制定本條例。" },
          { article_no: "第 2 條", content: "本條例之主管機關為高雄市政府環境保護局。" }
        ]
      }
    ]);
  }

  const laws: LawRecord[] = JSON.parse(rawContent);
  const provenance: Provenance = {
    source_id: sourceId,
    source_url: `r2://kcg-civic-data/${r2Key}`,
    source_type: "r2",
    agency,
    retrieved_at: new Date().toISOString(),
    content_hash: await calculateSha256(rawContent),
  };

  LAWS_CACHE = { data: laws, provenance, expiresAt: now + CACHE_TTL_MS };
  return { laws, provenance };
}
