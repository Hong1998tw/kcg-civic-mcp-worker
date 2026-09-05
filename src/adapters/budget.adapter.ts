import { Env, Provenance } from "../models/types";
import { calculateSha256 } from "../utils/crypto";

export async function fetchBudgetRawData(
  year: number,
  datasetId: number,
  resourceUuid: string,
  env: Env
): Promise<{ rawContent: string; provenance: Provenance }> {
  const agency = "高雄市政府主計處";

  // 1. 第一順位：高雄市政府 OpenAPI
  try {
    const openApiUrl = `https://openapi.kcg.gov.tw/Api/Service/Get/${resourceUuid}`;
    const resp = await fetch(openApiUrl, { headers: { Accept: "application/json" } });
    if (resp.ok) {
      const text = await resp.text();
      return {
        rawContent: text,
        provenance: {
          source_id: datasetId,
          source_url: openApiUrl,
          source_type: "openapi",
          agency,
          retrieved_at: new Date().toISOString(),
          content_hash: await calculateSha256(text),
        },
      };
    }
  } catch (_) {}

  // 2. 第二順位：官方開放平台 CSV 直載
  try {
    const csvUrl = `https://data.kcg.gov.tw/File/directDownload/${resourceUuid}`;
    const resp = await fetch(csvUrl);
    if (resp.ok) {
      const text = await resp.text();
      return {
        rawContent: text,
        provenance: {
          source_id: datasetId,
          source_url: csvUrl,
          source_type: "csv_direct",
          agency,
          retrieved_at: new Date().toISOString(),
          content_hash: await calculateSha256(text),
        },
      };
    }
  } catch (_) {}

  // 3. 第三順位：Cloudflare R2 備援
  const r2Key = `budget/${year}/${datasetId}.csv`;
  const r2Object = await env.kcg_civic_data.get(r2Key);
  if (!r2Object) {
    throw new Error(`無法取得預算資料：OpenAPI 與 CSV 直載失敗，且 R2 (r2://${r2Key}) 無此備援資料`);
  }

  const text = await r2Object.text();
  return {
    rawContent: text,
    provenance: {
      source_id: datasetId,
      source_url: `r2://kcg-civic-data/${r2Key}`,
      source_type: "r2",
      agency,
      retrieved_at: new Date().toISOString(),
      content_hash: await calculateSha256(text),
    },
  };
}
