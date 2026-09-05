import { Env, Provenance } from "../models/types";
import { calculateSha256 } from "../utils/crypto";
import { isTruthy } from "../utils/envelope";

export interface NewsItem {
  news_id: string;
  title: string;
  agency: string;
  category: string;
  published_at: string;
  content_summary: string;
  source_link?: string;
}

let NEWS_CACHE: { data: NewsItem[]; provenance: Provenance; expiresAt: number } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 30; // 新聞快取 30 分鐘

export async function fetchNewsData(env: Env): Promise<{ news: NewsItem[]; provenance: Provenance }> {
  const now = Date.now();
  if (NEWS_CACHE && NEWS_CACHE.expiresAt > now) {
    return { news: NEWS_CACHE.data, provenance: NEWS_CACHE.provenance };
  }

  const agency = "高雄市政府新聞局";
  const sourceId = "kcg_news";

  // 1. 第一順位：高雄市政府即時新聞開放資料端點 (限時 1200ms)
  try {
    const upstreamUrl = "https://data.kcg.gov.tw/dataset/kcg-news/resource/download.json";
    const resp = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    if (resp.ok) {
      const text = await resp.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("news schema");
      const news: NewsItem[] = parsed.filter((item: any) => item && typeof item.news_id === "string" && typeof item.title === "string");
      if (news.length === 0) throw new Error("empty news data");
      const provenance: Provenance = {
        source_id: sourceId,
        source_url: upstreamUrl,
        source_type: "openapi",
        agency,
        retrieved_at: new Date().toISOString(),
        content_hash: await calculateSha256(text),
      };
      NEWS_CACHE = { data: news, provenance, expiresAt: now + CACHE_TTL_MS };
      return { news, provenance };
    }
  } catch (_) {}

  // 2. 第二順位：Cloudflare R2 備援 (news/kcg_news.json)
  const r2Key = "news/kcg_news.json";
  let rawContent = "";
  let usedDemo = false;

  if (env.kcg_civic_data) {
    try {
      const r2Object = await env.kcg_civic_data.get(r2Key);
      if (r2Object) rawContent = await r2Object.text();
    } catch (_) {}
  }

  // Demo data is opt-in; never label a tiny hand-written sample as latest news.
  if (!rawContent && isTruthy(env.MCP_ALLOW_DEMO_DATA)) {
    usedDemo = true;
    rawContent = JSON.stringify([
      {
        news_id: "NEWS-202609-001",
        title: "高市府推動半導體 S 廊帶綠能配套，加速淨零碳排示範專案",
        agency: "經濟發展局",
        category: "產業發展",
        published_at: "2026-09-02T09:30:00Z",
        content_summary: "市府持續配合國家半導體生態系佈局，推動楠梓產業園區與橋頭科學園區之低碳綠能建設，落實產業與永續共榮願景。",
        source_link: "https://www.kcg.gov.tw/News_Content.aspx?n=1&s=001"
      },
      {
        news_id: "NEWS-202609-002",
        title: "高雄輕軌尖峰加密班距並優化轉乘動線，提升大眾運輸轉乘效能",
        agency: "交通局",
        category: "交通運輸",
        published_at: "2026-09-04T14:15:00Z",
        content_summary: "因應開學季與市區通勤旅次增加，輕軌成圓後重點路段全面精進時相號誌，並加密沿線公共自行車調度。",
        source_link: "https://www.kcg.gov.tw/News_Content.aspx?n=1&s=002"
      }
    ]);
  }

  if (!rawContent) throw new Error("無法取得新聞資料：官方端點與 R2 備援皆不可用");

  let news: NewsItem[];
  try {
    const parsed = JSON.parse(rawContent);
    if (!Array.isArray(parsed)) throw new Error("schema");
    news = parsed.filter((item: any) => item && typeof item.news_id === "string" && typeof item.title === "string");
    if (news.length === 0) throw new Error("empty");
  } catch {
    throw new Error("新聞資料格式無效");
  }
  const provenance: Provenance = {
    source_id: sourceId,
    source_url: `r2://kcg-civic-data/${r2Key}`,
    source_type: usedDemo ? "fallback" : "r2",
    agency,
    retrieved_at: new Date().toISOString(),
    content_hash: await calculateSha256(rawContent),
  };

  NEWS_CACHE = { data: news, provenance, expiresAt: now + CACHE_TTL_MS };
  return { news, provenance };
}
