import { Env, Provenance } from "../models/types";
import { loadVerifiedSnapshot } from "../utils/integrity";

export interface LawArticle { article_no: string; content: string }
export interface LawRecord {
  law_id: string;
  law_name: string;
  category: string;
  published_at: string;
  official_url: string;
  history?: string;
  articles: LawArticle[];
}

const cache = new Map<string, LawRecord[]>();

function validateLaw(value: unknown): value is LawRecord {
  const law = value as Partial<LawRecord> | null;
  if (!law || typeof law.law_id !== "string" || typeof law.law_name !== "string" ||
      typeof law.category !== "string" || typeof law.published_at !== "string" ||
      typeof law.official_url !== "string" || !Array.isArray(law.articles) || law.articles.length === 0) return false;
  try {
    const url = new URL(law.official_url);
    if (url.protocol !== "https:" || url.hostname !== "outlaw.kcg.gov.tw" || url.searchParams.get("id") !== law.law_id) return false;
  } catch { return false; }
  return law.articles.every((a) => a && typeof a.article_no === "string" && typeof a.content === "string" && !!a.content.trim());
}

export async function fetchLawsData(env: Env): Promise<{ laws: LawRecord[]; provenance: Provenance }> {
  const release = await loadVerifiedSnapshot<LawRecord>(env, "kcg-laws");
  let laws = cache.get(release.manifest.snapshot_id);
  if (!laws) {
    let source: URL;
    try { source = new URL(release.manifest.source_url); } catch { throw new Error("SNAPSHOT_UNVERIFIED: 法規來源 URL 無效"); }
    if (source.protocol !== "https:" || source.hostname !== "outlaw.kcg.gov.tw" || !release.records.every(validateLaw) ||
        new Set(release.records.map((law) => law.law_id)).size !== release.records.length) {
      throw new Error("SNAPSHOT_UNVERIFIED: 法規資料未通過來源、身分與結構驗證");
    }
    laws = release.records;
    cache.clear();
    cache.set(release.manifest.snapshot_id, laws);
  }
  return {
    laws,
    provenance: {
      source_id: release.manifest.snapshot_id,
      source_url: release.manifest.source_url,
      source_type: "r2",
      agency: "高雄市政府法制局",
      retrieved_at: release.manifest.fetched_at,
      content_hash: release.manifest.normalized_sha256,
      validation_status: "passed",
      snapshot_id: release.manifest.snapshot_id,
      coverage: release.manifest.coverage,
    },
  };
}
