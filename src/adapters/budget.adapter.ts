import { Env, Provenance } from "../models/types";
import { calculateSha256 } from "../utils/crypto";

const MEMORY_CACHE = new Map<string, { rawContent: string; provenance: Provenance; expiresAt: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export async function fetchBudgetRawData(
  year: number,
  datasetId: number,
  resourceUuid: string,
  env: Env
): Promise<{ rawContent: string; provenance: Provenance }> {
  const cacheKey = `budget:${year}:${datasetId}:${resourceUuid}`;
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

  void env;
  throw new Error(`SOURCE_UNAVAILABLE: 民國 ${year} 年預算官方 OpenAPI 與 CSV 直載皆無法取得；不使用未驗證 R2 備援`);
}
