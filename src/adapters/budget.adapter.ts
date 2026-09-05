import { Env, Provenance } from "../models/types";
import { calculateSha256 } from "../utils/crypto";

const MEMORY_CACHE = new Map<string, { rawContent: string; provenance: Provenance; expiresAt: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

export async function fetchBudgetRawData(
  year: number,
  datasetId: number,
  resourceUuid: string,
  env: Env
): Promise<{ rawContent: string; provenance: Provenance }> {
  const cacheKey = `budget:${year}:${datasetId}`;
  const now = Date.now();

  const cached = MEMORY_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { rawContent: cached.rawContent, provenance: cached.provenance };
  }

  const agency = "高雄市政府主計處";

  // 1. 第一順位：OpenAPI（逾時 1200ms）
  try {
    const openApiUrl = `https://openapi.kcg.gov.tw/Api/Service/Get/${resourceUuid}`;
    const resp = await fetch(openApiUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    if (resp.ok) {
      const text = await resp.text();
      const result = {
        rawContent: text,
        provenance: {
          source_id: datasetId,
          source_url: openApiUrl,
          source_type: "openapi" as const,
          agency,
          retrieved_at: new Date().toISOString(),
          content_hash: await calculateSha256(text),
        },
      };
      MEMORY_CACHE.set(cacheKey, { ...result, expiresAt: now + CACHE_TTL_MS });
      return result;
    }
  } catch (_) {}

  // 2. 第二順位：官方 CSV 直載（逾時 1200ms）
  try {
    const csvUrl = `https://data.kcg.gov.tw/File/directDownload/${resourceUuid}`;
    const resp = await fetch(csvUrl, { signal: AbortSignal.timeout(1200) });
    if (resp.ok) {
      const text = await resp.text();
      const result = {
        rawContent: text,
        provenance: {
          source_id: datasetId,
          source_url: csvUrl,
          source_type: "csv_direct" as const,
          agency,
          retrieved_at: new Date().toISOString(),
          content_hash: await calculateSha256(text),
        },
      };
      MEMORY_CACHE.set(cacheKey, { ...result, expiresAt: now + CACHE_TTL_MS });
      return result;
    }
  } catch (_) {}

  // 3. 第三順位：Cloudflare R2 備援
  const r2Key = `budget/${year}/${datasetId}.csv`;
  const r2Object = await env.kcg_civic_data.get(r2Key);
  if (!r2Object) {
    throw new Error(`無法取得預算資料：OpenAPI 與 CSV 直載失敗，且 R2 (r2://${r2Key}) 無此備援資料`);
  }

  const text = await r2Object.text();
  const result = {
    rawContent: text,
    provenance: {
      source_id: datasetId,
      source_url: `r2://kcg-civic-data/${r2Key}`,
      source_type: "r2" as const,
      agency,
      retrieved_at: new Date().toISOString(),
      content_hash: await calculateSha256(text),
    },
  };
  MEMORY_CACHE.set(cacheKey, { ...result, expiresAt: now + CACHE_TTL_MS });
  return result;
}
