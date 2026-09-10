import { Env, Provenance } from "../models/types";
import { loadVerifiedSnapshot } from "../utils/integrity";

export interface NewsItem {
  news_id: string;
  title: string;
  agency: string;
  category: string;
  published_at: string;
  content_summary: string;
  source_link: string;
}

const cache = new Map<string, NewsItem[]>();

function validateNews(value: unknown): value is NewsItem {
  const item = value as Partial<NewsItem> | null;
  if (!item || typeof item.news_id !== "string" || typeof item.title !== "string" ||
      typeof item.agency !== "string" || typeof item.category !== "string" ||
      typeof item.published_at !== "string" || typeof item.content_summary !== "string" ||
      typeof item.source_link !== "string") return false;
  try {
    const url = new URL(item.source_link);
    return url.protocol === "https:" && url.hostname === "www.kcg.gov.tw" && url.pathname === "/News_Content.aspx" && !!url.searchParams.get("s");
  } catch { return false; }
}

export async function fetchNewsData(env: Env): Promise<{ news: NewsItem[]; provenance: Provenance }> {
  const release = await loadVerifiedSnapshot<NewsItem>(env, "kcg-news");
  let news = cache.get(release.manifest.snapshot_id);
  if (!news) {
    let source: URL;
    try { source = new URL(release.manifest.source_url); } catch { throw new Error("SNAPSHOT_UNVERIFIED: 新聞來源 URL 無效"); }
    if (source.protocol !== "https:" || source.hostname !== "www.kcg.gov.tw" || !release.records.every(validateNews) ||
        new Set(release.records.map((item) => item.news_id)).size !== release.records.length) {
      throw new Error("SNAPSHOT_UNVERIFIED: 新聞資料未通過來源、身分與結構驗證");
    }
    news = [...release.records].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    cache.clear();
    cache.set(release.manifest.snapshot_id, news);
  }
  return {
    news,
    provenance: {
      source_id: release.manifest.snapshot_id,
      source_url: release.manifest.source_url,
      source_type: "r2",
      agency: "高雄市政府",
      retrieved_at: release.manifest.fetched_at,
      content_hash: release.manifest.normalized_sha256,
      validation_status: "passed",
      snapshot_id: release.manifest.snapshot_id,
      coverage: release.manifest.coverage,
    },
  };
}
