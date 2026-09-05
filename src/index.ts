/**
 * 高雄市政官方資料 MCP 伺服器
 * kcg-civic-mcp-worker
 *
 * 目前版本：
 * - JSON-RPC 2.0
 * - MCP initialize
 * - tools/list
 * - tools/call
 * - 高雄市政府官方 Open Data 資料清冊
 * - 高雄市政府 OpenAPI
 * - 高雄市政府新聞 RSS
 * - 高雄市預算資料
 * - 高雄數位市民市政服務
 *
 * 注意：
 * 本版本先採穩定的 HTTP JSON-RPC 架構，
 * 不建立永不結束的 SSE TransformStream，
 * 避免 Cloudflare Workers runtime hang。
 */

export interface Env {
  AUTH_TOKEN?: string;
  [key: string]: unknown;
}

const OPENAPI_BASE = "https://openapi.kcg.gov.tw/Api/Service/Get";
const DATAGOV_API_BASE = "https://data.gov.tw/api/v2/rest";

const CIVIC_SERVICE_UUID =
  "e6ab600a-54ef-48a0-ab0d-11f670bc850e";

const RSS_CHANNELS: Record<string, string> = {
  municipal_news:
    "https://kcginfo.kcg.gov.tw/Rss_News.aspx?n=C527413F7300192A",

  kh_style:
    "https://kcginfo.kcg.gov.tw/Rss_Publish.aspx?n=59DACBB77BAEDC12",

  love_kaohsiung:
    "https://kcginfo.kcg.gov.tw/Rss_Publish.aspx?n=A22859B204186560",

  subsidy_announcements:
    "https://kcginfo.kcg.gov.tw/Rss_Publish.aspx?n=9D4549952C13C7D2",
};

/* =========================================================
 * 共用工具
 * ========================================================= */


/* =========================================================
 * 高雄市官方 Resource 取得器
 *
 * 優先使用：
 *   1. 高雄 OpenAPI JSON
 *
 * 若 Cloudflare Workers 無法連線至 OpenAPI（例如 HTTP 522），
 * 自動 fallback：
 *   2. 高雄市政府資料開放平台官方 CSV
 *
 * CSV URL：
 *   https://data.kcg.gov.tw/File/directDownload/{resource_uuid}
 * ========================================================= */

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

function parseCsvRecords(csv: string): Record<string, string>[] {
  const normalized = csv
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = normalized
    .split("\n")
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) =>
    header.trim()
  );

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const record: Record<string, string> = {};

    headers.forEach((header, index) => {
      record[header] = values[index] ?? "";
    });

    return record;
  });
}

function extractResourceUuid(resourceUrl: string): string {
  const match = resourceUrl.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
  );

  return match?.[1] ?? "";
}

async function fetchKcgResourceRecords(
  resourceUrl: string
): Promise<{
  records: any[];
  sourceUrl: string;
  format: "json" | "csv";
}> {
  const primaryUrl = String(resourceUrl || "").trim();

  if (!primaryUrl) {
    throw new Error("Resource URL 為空");
  }

  let primaryError = "";

  try {
    const response = await fetch(primaryUrl, {
      headers: {
        "User-Agent": "Kaohsiung-Civic-MCP/1.0",
        "Accept": "application/json",
      },
    });

    if (response.ok) {
      const raw = (await response.json()) as any;

      const records =
        Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];

      return {
        records,
        sourceUrl: primaryUrl,
        format: "json",
      };
    }

    primaryError = `HTTP ${response.status}`;
  } catch (error) {
    primaryError =
      error instanceof Error
        ? error.message
        : String(error);
  }

  const uuid = extractResourceUuid(primaryUrl);

  if (!uuid) {
    throw new Error(
      `Resource JSON 請求失敗 (${primaryError})，且無法解析 Resource UUID`
    );
  }

  const csvUrl =
    `https://data.kcg.gov.tw/File/directDownload/${uuid}`;

  try {
    const csvResponse = await fetch(csvUrl, {
      headers: {
        "User-Agent": "Kaohsiung-Civic-MCP/1.0",
        "Accept": "text/csv,*/*",
      },
    });

    if (!csvResponse.ok) {
      throw new Error(
        `HTTP ${csvResponse.status}`
      );
    }

    const csvText = await csvResponse.text();
    const records = parseCsvRecords(csvText);

    if (records.length === 0) {
      throw new Error("CSV 沒有資料紀錄");
    }

    return {
      records,
      sourceUrl: csvUrl,
      format: "csv",
    };
  } catch (error) {
    const csvError =
      error instanceof Error
        ? error.message
        : String(error);

    throw new Error(
      `Resource JSON 請求失敗 (${primaryError})；官方 CSV fallback 也失敗 (${csvError})`
    );
  }
}

async function calculateHash(content: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(content);

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    msgUint8
  );

  const hashArray = Array.from(
    new Uint8Array(hashBuffer)
  );

  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildCivicEnvelope<T>(
  data: T,
  provenance: {
    source_id: string;
    source_url: string;
    source_type: "ckan" | "openapi" | "rss" | "crawler";
    agency: string;
    published_at?: string;
  },
  meta: Record<string, unknown> = {}
) {
  const now = new Date().toISOString();
  const jsonString = JSON.stringify(data);
  const contentHash = await calculateHash(jsonString);

  return {
    status: "success",
    provider: "kaohsiung_civic_mcp",
    updated_at: now,

    provenance: {
      source_id: provenance.source_id,
      source_url: provenance.source_url,
      source_type: provenance.source_type,
      agency: provenance.agency,
      retrieved_at: now,
      published_at:
        provenance.published_at || now,
      content_hash: contentHash,
    },

    meta: {
      total: Array.isArray(data) ? data.length : 1,
      ...meta,
    },

    data,
  };
}


function classifyBudgetRecord(record: any): {
  record_type: "agency" | "total" | "special" | "unknown";
  account_name: string;
} {
  const accountName = String(
    record?.科目名稱 ??
    record?.名稱 ??
    record?.機關名稱 ??
    record?.機關 ??
    ""
  ).trim();

  if (!accountName) {
    return {
      record_type: "unknown",
      account_name: ""
    };
  }

  if (
    accountName === "合計" ||
    accountName.includes("總計")
  ) {
    return {
      record_type: "total",
      account_name: accountName
    };
  }

  if (
    accountName.includes("統籌支撥科目") ||
    accountName === "高雄市政府主管"
  ) {
    return {
      record_type: "special",
      account_name: accountName
    };
  }

  if (
    accountName.includes("高雄市政府") &&
    accountName.includes("主管")
  ) {
    return {
      record_type: "agency",
      account_name: accountName
    };
  }

  return {
    record_type: "unknown",
    account_name: accountName
  };
}

function parseBudgetValue(value: unknown): number {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? Math.round(value)
      : 0;
  }

  const clean = String(value).replace(
    /[^\d.-]/g,
    ""
  );

  const parsed = Number.parseFloat(clean);

  return Number.isFinite(parsed)
    ? Math.round(parsed)
    : 0;
}

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        ...extraHeaders,
      },
    }
  );
}

/* =========================================================
 * MCP Tools Registry
 * ========================================================= */

export const TOOL_REGISTRY = [

  {
    name: "get_kcg_budget_rank",
    description:
      "查詢指定民國年度高雄市政府各機關預算排名，單位為新臺幣千元",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "number",
          description: "民國年度，例如 115",
          default: 115,
        },
        keyword: {
          type: "string",
          description: "機關或歲出科目名稱篩選",
        },
        limit: {
          type: "number",
          description: "排名筆數上限",
          default: 20,
        },
      },
      required: ["year"],
    },
  },
  {
    name: "get_kcg_budget_change_rank",
    description:
      "比較兩個年度高雄市政府各機關預算增減排名，可依增加或減少排序",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "number",
          description: "目標民國年度，例如 115",
          default: 115,
        },
        compare_year: {
          type: "number",
          description: "比較民國年度，例如 114",
          default: 114,
        },
        direction: {
          type: "string",
          enum: ["increase", "decrease", "absolute"],
          description: "increase=增加最多、decrease=減少最多、absolute=變動幅度最大",
          default: "absolute",
        },
        limit: {
          type: "number",
          description: "排名筆數上限",
          default: 20,
        },
      },
      required: ["year", "compare_year"],
    },
  },
  {
    name: "get_kcg_budget_summary",
    description:
      "取得指定年度高雄市政府歲出機關別預算統計摘要",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "number",
          description: "民國年度，例如 115",
          default: 115,
        },
        keyword: {
          type: "string",
          description: "機關或歲出科目名稱篩選",
        },
      },
      required: ["year"],
    },
  },
  {
    name: "get_kcg_budget_top",
    description:
      "取得指定年度高雄市政府預算最高的前 N 個機關或科目",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "number",
          description: "民國年度，例如 115",
          default: 115,
        },
        limit: {
          type: "number",
          description: "Top N，預設 10",
          default: 10,
        },
        keyword: {
          type: "string",
          description: "機關或歲出科目名稱篩選",
        },
      },
      required: ["year"],
    },
  },
  {
    name: "get_kcg_budget_trend_multi",
    description:
      "一次查詢多個機關或科目的跨年度總預算趨勢",
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: {
            type: "string",
          },
          description: "機關或科目名稱關鍵字陣列，例如 ['教育局','工務局','衛生局']",
        },
        start_year: {
          type: "number",
          description: "起始民國年度，例如 110",
        },
        end_year: {
          type: "number",
          description: "結束民國年度，例如 115",
        },
      },
      required: ["keywords", "start_year", "end_year"],
    },
  },
  {
    name: "get_kcg_budget_trend",
    description:
      "查詢高雄市政府主計處指定機關或科目跨年度總預算趨勢，單位為新臺幣千元",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "機關或歲出科目名稱關鍵字，例如教育局"
        },
        start_year: {
          type: "number",
          description: "起始民國年度，例如 110"
        },
        end_year: {
          type: "number",
          description: "結束民國年度，例如 115"
        }
      },
      required: ["keyword", "start_year", "end_year"]
    }
  },
  {
    name: "search_kcg_opendata",

    description:
      "透過高雄市政府官方 Open Data 資料清冊搜尋資料集、資源名稱、格式與提供機關",

    inputSchema: {
      type: "object",

      properties: {
        query: {
          type: "string",
          description:
            "關鍵字或資料集名稱",
        },

        agency: {
          type: "string",
          description:
            "提供機關名稱過濾，例如主計處、工務局",
        },

        rows: {
          type: "number",
          description:
            "回傳資料集數量上限",
          default: 10,
        },
      },

      required: ["query"],
    },
  },

  {
    name: "get_kcg_dataset",
    description:
      "依資料集名稱、資源名稱、提供機關或 Seq 查詢高雄市政府 Open Data 資料集與資源資訊",
    inputSchema: {
      type: "object",
      properties: {
        dataset_name: {
          type: "string",
          description:
            "資料集名稱，例如高雄市總預算歲出機關別預算比較總表",
        },
        resource_name: {
          type: "string",
          description:
            "資源名稱，例如115年度高雄市總預算歲出機關別預算比較總表",
        },
        agency: {
          type: "string",
          description:
            "提供機關名稱，例如主計處、工務局",
        },
        seq: {
          type: "number",
          description:
            "資料清冊 Seq 編號",
        },
        limit: {
          type: "number",
          description:
            "最多回傳幾筆結果",
          default: 20,
        },
      },
    },
  },

  {
    name: "get_kcg_dataset_metadata",
    description:
      "透過政府資料開放平臺官方 API 取得高雄資料集完整詮釋資料、資源分布與下載網址",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: {
          type: "number",
          description:
            "政府資料開放平臺資料集識別碼，例如 101174",
        },
      },
      required: ["dataset_id"],
    },
  },

  {
    name: "get_kcg_resource_data",

    description:
      "依據 Resource UUID 透過高雄市政府 OpenAPI 資源服務抓取原生 JSON 資料",

    inputSchema: {
      type: "object",

      properties: {
        resource_uuid: {
          type: "string",
          description:
            "開放資料資源唯一 UUID",
        },

        limit: {
          type: "number",
          description:
            "回傳紀錄筆數限制",
          default: 50,
        },
      },

      required: ["resource_uuid"],
    },
  },

  {
    name: "get_kcg_budget_report",

    description:
      "查詢高雄市政府主計處總預算歲出機關別預算比較資料，單位為新臺幣千元",

    inputSchema: {
      type: "object",

      properties: {
        year: {
          type: "number",
          description:
            "民國年度，例如 115、114、113、112",
          default: 115,
        },

        keyword: {
          type: "string",
          description:
            "機關或歲出科目名稱篩選",
        },
      },

      required: ["year"],
    },
  },

  {
    name: "get_kcg_budget_compare",
    description:
      "比較高雄市政府主計處兩個年度的總預算歲出機關別預算，計算預算增減金額與增減百分比，單位為新臺幣千元",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "number",
          description:
            "目標民國年度，例如 115",
          default: 115,
        },
        compare_year: {
          type: "number",
          description:
            "比較民國年度，例如 114",
          default: 114,
        },
        keyword: {
          type: "string",
          description:
            "機關或歲出科目名稱關鍵字篩選",
        },
        limit: {
          type: "number",
          description:
            "最多回傳幾筆結果",
          default: 100,
        },
      },
      required: ["year", "compare_year"],
    },
  },
  {
    name: "get_kcg_latest_news",

    description:
      "抓取高雄市政府新聞局 RSS 即時市政新聞、高雄款、愛高雄或補助公告",

    inputSchema: {
      type: "object",

      properties: {
        channel: {
          type: "string",

          enum: [
            "municipal_news",
            "kh_style",
            "love_kaohsiung",
            "subsidy_announcements",
          ],

          description:
            "新聞頻道類別",

          default: "municipal_news",
        },

        limit: {
          type: "number",
          description:
            "新聞筆數上限",

          default: 10,
        },
      },
    },
  },

  {
    name: "get_kcg_civic_service_cases",

    description:
      "查詢高雄數位市民市政服務平台案件資料",

    inputSchema: {
      type: "object",

      properties: {
        keyword: {
          type: "string",
          description:
            "案件內容關鍵字",
        },

        limit: {
          type: "number",
          description:
            "回傳筆數上限",
          default: 20,
        },
      },
    },
  },
];

/* =========================================================
 * Tool 執行器
 * ========================================================= */

async function executeCivicTool(
  name: string,
  args: Record<string, unknown> = {}
) {
  switch (name) {
    /* -----------------------------------------------------
     * 1. KCG Open Data Registry
     * ----------------------------------------------------- */


    /* -----------------------------------------------------
     * Batch Budget Analytics
     * ----------------------------------------------------- */

    case "get_kcg_budget_rank": {
      const year = Number(args.year) || 115;
      const keyword =
        typeof args.keyword === "string"
          ? args.keyword.trim()
          : "";
      const limit = Math.min(
        Math.max(Number(args.limit) || 20, 1),
        100
      );

      if (!Number.isInteger(year) || year <= 0) {
        throw new Error("year 必須是正整數民國年度");
      }

      const datasetId = 101174;
      const metadataUrl =
        `${DATAGOV_API_BASE}/dataset/${datasetId}`;

      const metadataResponse = await fetch(metadataUrl, {
        headers: {
          "User-Agent": "Kaohsiung-Civic-MCP/1.0",
          "Accept": "application/json",
        },
      });

      if (!metadataResponse.ok) {
        throw new Error(
          `取得預算資料集 metadata 失敗：HTTP ${metadataResponse.status}`
        );
      }

      const rawMetadata = await metadataResponse.json() as any;
      const metadata =
        rawMetadata?.payload ??
        rawMetadata?.result ??
        rawMetadata;

      const distributions = Array.isArray(metadata?.distribution)
        ? metadata.distribution
        : [];

      const matched = distributions.find((resource: any) => {
        const description = String(
          resource.resourceDescription ?? ""
        );
        const format = String(
          resource.resourceFormat ?? ""
        ).toUpperCase();

        return (
          description.includes(`${year}年度`) &&
          format === "JSON"
        );
      });

      if (!matched) {
        throw new Error(
          `找不到 ${year} 年度 JSON 預算 Resource`
        );
      }

      const resourceUrl = String(
        matched.resourceDownloadUrl ?? ""
      ).trim();

      if (!resourceUrl) {
        throw new Error(
          `${year} 年度預算 Resource 沒有 resourceDownloadUrl`
        );
      }

      const resourceResult =
        await fetchKcgResourceRecords(resourceUrl);

      const records =
        resourceResult.records;

      const normalized = records
        .map((record: any) => {
          const accountName = String(
            record["科目名稱"] ??
            record["名稱"] ??
            record["機關名稱"] ??
            record["機關"] ??
            ""
          ).trim();

          return {
            account_name: accountName,
            budget_thousand_twd:
              parseBudgetValue(record["本年度預算數"]),
            record,
          };
        })
        .filter((item: any) =>
          item.account_name &&
          (!keyword ||
            item.account_name.includes(keyword))
        )
        .filter((item: any) =>
          classifyBudgetRecord(item.record).record_type ===
          "agency"
        )
        .sort(
          (a: any, b: any) =>
            b.budget_thousand_twd -
            a.budget_thousand_twd
        );

      const result = normalized
        .slice(0, limit)
        .map((item: any, index: number) => ({
          rank: index + 1,
          account_name: item.account_name,
          budget_thousand_twd:
            item.budget_thousand_twd,
          year,
        }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            await buildCivicEnvelope(
              result,
              {
                source_id: "kcg_budget_rank",
                source_url: resourceUrl,
                source_type: "openapi",
                agency: "高雄市政府主計處",
              },
              {
                dataset_id: datasetId,
                year,
                keyword,
                unit: "新臺幣千元",
                returned: result.length,
                total_matched: normalized.length,
                sort: "budget_desc",
              }
            )
          ),
        }],
      };
    }

    case "get_kcg_budget_change_rank": {
      const year = Number(args.year) || 115;
      const compareYear =
        Number(args.compare_year) || (year - 1);
      const direction =
        typeof args.direction === "string"
          ? args.direction
          : "absolute";
      const limit = Math.min(
        Math.max(Number(args.limit) || 20, 1),
        100
      );

      if (!Number.isInteger(year) || year <= 0) {
        throw new Error("year 必須是正整數民國年度");
      }

      if (
        !Number.isInteger(compareYear) ||
        compareYear <= 0
      ) {
        throw new Error(
          "compare_year 必須是正整數民國年度"
        );
      }

      if (year === compareYear) {
        throw new Error(
          "year 與 compare_year 不可相同"
        );
      }

      if (
        !["increase", "decrease", "absolute"].includes(
          direction
        )
      ) {
        throw new Error(
          "direction 必須是 increase、decrease 或 absolute"
        );
      }

      const datasetId = 101174;
      const metadataUrl =
        `${DATAGOV_API_BASE}/dataset/${datasetId}`;

      const metadataResponse = await fetch(metadataUrl, {
        headers: {
          "User-Agent": "Kaohsiung-Civic-MCP/1.0",
          "Accept": "application/json",
        },
      });

      if (!metadataResponse.ok) {
        throw new Error(
          `取得預算資料集 metadata 失敗：HTTP ${metadataResponse.status}`
        );
      }

      const rawMetadata = await metadataResponse.json() as any;
      const metadata =
        rawMetadata?.payload ??
        rawMetadata?.result ??
        rawMetadata;

      const distributions = Array.isArray(metadata?.distribution)
        ? metadata.distribution
        : [];

      async function getBudgetRecords(targetYear: number) {
        const matched = distributions.find((resource: any) => {
          const description = String(
            resource.resourceDescription ?? ""
          );
          const format = String(
            resource.resourceFormat ?? ""
          ).toUpperCase();

          return (
            description.includes(`${targetYear}年度`) &&
            format === "JSON"
          );
        });

        if (!matched) {
          throw new Error(
            `找不到 ${targetYear} 年度 JSON 預算 Resource`
          );
        }

        const resourceUrl = String(
          matched.resourceDownloadUrl ?? ""
        ).trim();

        if (!resourceUrl) {
          throw new Error(
            `${targetYear} 年度預算 Resource 沒有 resourceDownloadUrl`
          );
        }

        const resourceResult =
          await fetchKcgResourceRecords(resourceUrl);

        const records =
          resourceResult.records;

        return {
          records,
          resourceUrl,
        };
      }

      const [current, previous] = await Promise.all([
        getBudgetRecords(year),
        getBudgetRecords(compareYear),
      ]);

      const getName = (record: any) =>
        String(
          record["科目名稱"] ??
          record["名稱"] ??
          record["機關名稱"] ??
          record["機關"] ??
          ""
        ).trim();

      const previousMap = new Map<string, number>();

      for (const record of previous.records) {
        const name = getName(record);
        if (!name) continue;

        previousMap.set(
          name,
          parseBudgetValue(record["本年度預算數"])
        );
      }

      const agencyCurrentRecords =
        current.records.filter(
          (record: any) =>
            classifyBudgetRecord(record).record_type ===
            "agency"
        );

      const result = agencyCurrentRecords
        .map((record: any) => {
          const accountName = getName(record);
          if (!accountName) return null;

          const currentBudget =
            parseBudgetValue(
              record["本年度預算數"]
            );

          const compareBudget =
            previousMap.get(accountName) ?? 0;

          const difference =
            currentBudget - compareBudget;

          const changePercent =
            compareBudget !== 0
              ? (difference / compareBudget) * 100
              : null;

          return {
            account_name: accountName,
            year,
            compare_year: compareYear,
            current_budget_thousand_twd:
              currentBudget,
            compare_budget_thousand_twd:
              compareBudget,
            difference_thousand_twd:
              difference,
            change_percent: changePercent,
          };
        })
        .filter((item: any) => item !== null);

      if (direction === "increase") {
        result.sort(
          (a: any, b: any) =>
            b.difference_thousand_twd -
            a.difference_thousand_twd
        );
      } else if (direction === "decrease") {
        result.sort(
          (a: any, b: any) =>
            a.difference_thousand_twd -
            b.difference_thousand_twd
        );
      } else {
        result.sort(
          (a: any, b: any) =>
            Math.abs(b.difference_thousand_twd) -
            Math.abs(a.difference_thousand_twd)
        );
      }

      const finalResult = result
        .slice(0, limit)
        .map((item: any, index: number) => ({
          rank: index + 1,
          ...item,
        }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            await buildCivicEnvelope(
              finalResult,
              {
                source_id: "kcg_budget_change_rank",
                source_url: current.resourceUrl,
                source_type: "openapi",
                agency: "高雄市政府主計處",
              },
              {
                dataset_id: datasetId,
                year,
                compare_year: compareYear,
                direction,
                unit: "新臺幣千元",
                returned: finalResult.length,
                total_compared: result.length,
              }
            )
          ),
        }],
      };
    }

    case "get_kcg_budget_summary": {
      const year = Number(args.year) || 115;
      const keyword =
        typeof args.keyword === "string"
          ? args.keyword.trim()
          : "";

      if (!Number.isInteger(year) || year <= 0) {
        throw new Error("year 必須是正整數民國年度");
      }

      const datasetId = 101174;
      const metadataUrl =
        `${DATAGOV_API_BASE}/dataset/${datasetId}`;

      const metadataResponse = await fetch(metadataUrl, {
        headers: {
          "User-Agent": "Kaohsiung-Civic-MCP/1.0",
          "Accept": "application/json",
        },
      });

      if (!metadataResponse.ok) {
        throw new Error(
          `取得預算資料集 metadata 失敗：HTTP ${metadataResponse.status}`
        );
      }

      const rawMetadata = await metadataResponse.json() as any;
      const metadata =
        rawMetadata?.payload ??
        rawMetadata?.result ??
        rawMetadata;

      const distributions = Array.isArray(metadata?.distribution)
        ? metadata.distribution
        : [];

      const matched = distributions.find((resource: any) => {
        const description = String(
          resource.resourceDescription ?? ""
        );
        const format = String(
          resource.resourceFormat ?? ""
        ).toUpperCase();

        return (
          description.includes(`${year}年度`) &&
          format === "JSON"
        );
      });

      if (!matched) {
        throw new Error(
          `找不到 ${year} 年度 JSON 預算 Resource`
        );
      }

      const resourceUrl = String(
        matched.resourceDownloadUrl ?? ""
      ).trim();

      const resourceResult =
        await fetchKcgResourceRecords(resourceUrl);

      const records =
        resourceResult.records;

      const getName = (record: any) =>
        String(
          record["科目名稱"] ??
          record["名稱"] ??
          record["機關名稱"] ??
          record["機關"] ??
          ""
        ).trim();

      const classified = records.map(
        (record: any) => {
          const classification =
            classifyBudgetRecord(record);

          return {
            ...classification,
            budget_thousand_twd:
              parseBudgetValue(
                record["本年度預算數"]
              ),
          };
        }
      );

      const officialTotalRecord =
        classified.find(
          (item: any) =>
            item.record_type === "total"
        );

      const officialTotalBudget =
        officialTotalRecord?.budget_thousand_twd ??
        null;

      const budgets = classified
        .filter(
          (item: any) =>
            item.record_type === "agency"
        )
        .filter(
          (item: any) =>
            !keyword ||
            item.account_name.includes(keyword)
        );

      const values = budgets.map(
        (item: any) =>
          item.budget_thousand_twd
      );

      const total = values.reduce(
        (sum: number, value: number) =>
          sum + value,
        0
      );

      const average =
        values.length > 0
          ? total / values.length
          : 0;

      const highest =
        budgets.length > 0
          ? [...budgets].sort(
              (a: any, b: any) =>
                b.budget_thousand_twd -
                a.budget_thousand_twd
            )[0]
          : null;

      const lowest =
        budgets.length > 0
          ? [...budgets].sort(
              (a: any, b: any) =>
                a.budget_thousand_twd -
                b.budget_thousand_twd
            )[0]
          : null;

      const summary = {
        year,
        keyword,
        agency_count: budgets.length,
        agency_sum_budget_thousand_twd: total,
          official_total_budget_thousand_twd:
            officialTotalBudget,
        average_budget_thousand_twd:
          Math.round(average),
        highest,
        lowest,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            await buildCivicEnvelope(
              summary,
              {
                source_id: "kcg_budget_summary",
                source_url: resourceUrl,
                source_type: "openapi",
                agency: "高雄市政府主計處",
              },
              {
                dataset_id: datasetId,
                year,
                keyword,
                unit: "新臺幣千元",
              }
            )
          ),
        }],
      };
    }

    case "get_kcg_budget_top": {
      const year = Number(args.year) || 115;
      const limit = Math.min(
        Math.max(Number(args.limit) || 10, 1),
        100
      );
      const keyword =
        typeof args.keyword === "string"
          ? args.keyword.trim()
          : "";

      if (!Number.isInteger(year) || year <= 0) {
        throw new Error("year 必須是正整數民國年度");
      }

      const rankResult: any = await executeCivicTool(
        "get_kcg_budget_rank",
        {
          year,
          keyword,
          limit,
        }
      );

      return rankResult;
    }

    case "get_kcg_budget_trend_multi": {
      const rawKeywords = args.keywords;

      if (!Array.isArray(rawKeywords)) {
        throw new Error(
          "keywords 必須是字串陣列"
        );
      }

      const keywords = rawKeywords
        .filter(
          (item): item is string =>
            typeof item === "string"
        )
        .map((item) => item.trim())
        .filter(Boolean);

      if (keywords.length === 0) {
        throw new Error(
          "keywords 不可為空"
        );
      }

      if (keywords.length > 20) {
        throw new Error(
          "keywords 最多 20 個"
        );
      }

      const startYear = Number(args.start_year);
      const endYear = Number(args.end_year);

      if (
        !Number.isInteger(startYear) ||
        !Number.isInteger(endYear)
      ) {
        throw new Error(
          "start_year 與 end_year 必須為整數"
        );
      }

      if (startYear > endYear) {
        throw new Error(
          "start_year 不可大於 end_year"
        );
      }

      if (endYear - startYear > 20) {
        throw new Error(
          "年度範圍不可超過 20 年"
        );
      }

      const results: any[] = await Promise.all(
        keywords.map(async (keyword): Promise<any> => {
          const response: any = await executeCivicTool(
            "get_kcg_budget_trend",
            {
              keyword,
              start_year: startYear,
              end_year: endYear,
            }
          );

          return {
            keyword,
            result: response,
          };
        })
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            await buildCivicEnvelope(
              results,
              {
                source_id:
                  "kcg_budget_trend_multi",
                source_url:
                  `${OPENAPI_BASE}`,
                source_type: "openapi",
                agency:
                  "高雄市政府主計處",
              },
              {
                dataset_id: 101174,
                keywords,
                start_year: startYear,
                end_year: endYear,
                unit: "新臺幣千元",
                returned: results.length,
              }
            )
          ),
        }],
      };
    }

    case "search_kcg_opendata": {
      const query =
        typeof args.query === "string"
          ? args.query.trim()
          : "高雄";

      const agency =
        typeof args.agency === "string"
          ? args.agency.trim()
          : "";

      const rows = Math.min(
        Math.max(
          Number(args.rows) || 10,
          1
        ),
        100
      );

      /*
       * 高雄市政府「資料開放平台資料清冊」
       *
       * 官方資料集：
       * data.gov.tw/dataset/85423
       *
       * JSON Resource UUID：
       * 7d1af154-54f6-4748-b55c-fe21f01ece4d
       */
      const registryUuid =
        "7d1af154-54f6-4748-b55c-fe21f01ece4d";

      const targetUrl =
        `${OPENAPI_BASE}/${registryUuid}`;

      const response = await fetch(
        targetUrl,
        {
          headers: {
            "User-Agent":
              "Kaohsiung-Civic-MCP/1.0",
            "Accept":
              "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `高雄市政府資料清冊 API 連線失敗 (HTTP ${response.status})`
        );
      }

      const raw =
        (await response.json()) as any;

      /*
       * 高雄 OpenAPI 資源可能直接回傳陣列，
       * 也可能包在 data 裡。
       */
      const records =
        Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : Array.isArray(raw?.result)
              ? raw.result
              : [];

      if (records.length === 0) {
        throw new Error(
          "高雄市政府資料清冊 API 已連線，但沒有取得資料紀錄"
        );
      }

      const normalized = records
        .map((record: any) => {
          const datasetName =
            String(
              record["資料集名稱"] ||
              record["datasetName"] ||
              record["DatasetName"] ||
              record["title"] ||
              ""
            ).trim();

          const resourceName =
            String(
              record["資源名稱"] ||
              record["resourceName"] ||
              record["ResourceName"] ||
              ""
            ).trim();

          const format =
            String(
              record["資源格式"] ||
              record["resourceFormat"] ||
              record["format"] ||
              ""
            ).trim();

          const provider =
            String(
              record["提供機關"] ||
              record["providerAgency"] ||
              record["agency"] ||
              record["publisher"] ||
              ""
            ).trim();

          const downloadUrl =
            String(
              record["資料資源下載網址"] ||
              record["資料下載網址"] ||
              record["resourceDownloadUrl"] ||
              record["downloadURL"] ||
              record["url"] ||
              ""
            ).trim();

          const seq =
            record["Seq"] ??
            record["seq"] ??
            record["序號"] ??
            null;

          return {
            seq,
            dataset_name: datasetName,
            resource_name: resourceName,
            format,
            agency: provider,
            download_url: downloadUrl,
            source_record: record,
          };
        })
        .filter((record: any) => {
          const searchable = [
            record.dataset_name,
            record.resource_name,
            record.agency,
            record.format,
            record.download_url,
          ]
            .join(" ")
            .toLowerCase();

          const queryMatched =
            !query ||
            searchable.includes(
              query.toLowerCase()
            );

          const agencyMatched =
            !agency ||
            record.agency.includes(
              agency
            );

          return (
            queryMatched &&
            agencyMatched
          );
        })
        .slice(0, rows);

      const envelope =
        await buildCivicEnvelope(
          normalized,
          {
            source_id:
              "kcg_open_data_registry",

            source_url:
              targetUrl,

            source_type:
              "openapi",

            agency:
              "高雄市政府研究發展考核委員會",
          },
          {
            query,
            agency,
            registry_uuid:
              registryUuid,

            total_registry_records:
              records.length,

            matched_datasets:
              normalized.length,
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    /* -----------------------------------------------------
     * 2. Open Data Dataset Detail
     * ----------------------------------------------------- */

    case "get_kcg_dataset": {
      const datasetName =
        typeof args.dataset_name === "string"
          ? args.dataset_name.trim()
          : "";

      const resourceName =
        typeof args.resource_name === "string"
          ? args.resource_name.trim()
          : "";

      const agency =
        typeof args.agency === "string"
          ? args.agency.trim()
          : "";

      const requestedSeq =
        args.seq !== undefined &&
        args.seq !== null &&
        String(args.seq).trim() !== ""
          ? Number(args.seq)
          : null;

      const limit = Math.min(
        Math.max(
          Number(args.limit) || 20,
          1
        ),
        100
      );

      if (
        !datasetName &&
        !resourceName &&
        !agency &&
        requestedSeq === null
      ) {
        throw new Error(
          "至少需要提供 dataset_name、resource_name、agency 或 seq 其中一項"
        );
      }

      const registryUuid =
        "7d1af154-54f6-4748-b55c-fe21f01ece4d";

      const targetUrl =
        `${OPENAPI_BASE}/${registryUuid}`;

      const response = await fetch(
        targetUrl,
        {
          headers: {
            "User-Agent":
              "Kaohsiung-Civic-MCP/1.0",
            "Accept":
              "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `高雄市政府資料清冊 API 連線失敗 (HTTP ${response.status})`
        );
      }

      const raw =
        (await response.json()) as any;

      const records =
        Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];

      const normalized = records
        .map((record: any) => ({
          seq:
            record["Seq"] ??
            record["seq"] ??
            null,

          dataset_name:
            String(
              record["資料集名稱"] ||
              record["datasetName"] ||
              record["DatasetName"] ||
              ""
            ).trim(),

          resource_name:
            String(
              record["資源名稱"] ||
              record["resourceName"] ||
              record["ResourceName"] ||
              ""
            ).trim(),

          format:
            String(
              record["資源格式"] ||
              record["resourceFormat"] ||
              record["format"] ||
              ""
            ).trim(),

          agency:
            String(
              record["提供機關"] ||
              record["providerAgency"] ||
              record["agency"] ||
              ""
            ).trim(),

          download_url:
            String(
              record["資料資源下載網址"] ||
              record["資料下載網址"] ||
              record["resourceDownloadUrl"] ||
              record["downloadURL"] ||
              record["url"] ||
              ""
            ).trim(),

          source_record:
            record,
        }))
        .filter((record: any) => {
          const datasetMatched =
            !datasetName ||
            record.dataset_name.includes(
              datasetName
            );

          const resourceMatched =
            !resourceName ||
            record.resource_name.includes(
              resourceName
            );

          const agencyMatched =
            !agency ||
            record.agency.includes(
              agency
            );

          const seqMatched =
            requestedSeq === null ||
            Number(record.seq) ===
              requestedSeq;

          return (
            datasetMatched &&
            resourceMatched &&
            agencyMatched &&
            seqMatched
          );
        })
        .slice(0, limit);

      const envelope =
        await buildCivicEnvelope(
          normalized,
          {
            source_id:
              "kcg_open_data_registry",

            source_url:
              targetUrl,

            source_type:
              "openapi",

            agency:
              "高雄市政府研究發展考核委員會",
          },
          {
            dataset_name:
              datasetName,

            resource_name:
              resourceName,

            agency,

            seq:
              requestedSeq,

            registry_uuid:
              registryUuid,

            returned:
              normalized.length,

            total_registry_records:
              records.length,
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    /* -----------------------------------------------------
     * 3. Data.gov.tw Dataset Metadata
     * ----------------------------------------------------- */

    case "get_kcg_dataset_metadata": {
      const datasetId =
        Number(args.dataset_id);

      if (
        !Number.isInteger(datasetId) ||
        datasetId <= 0
      ) {
        throw new Error(
          "dataset_id 必須是正整數"
        );
      }

      const targetUrl =
        `${DATAGOV_API_BASE}/dataset/${datasetId}`;

      const response = await fetch(
        targetUrl,
        {
          headers: {
            "User-Agent":
              "Kaohsiung-Civic-MCP/1.0",
            "Accept":
              "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `政府資料開放平臺 Dataset API 請求失敗 (HTTP ${response.status})`
        );
      }

      const raw =
        (await response.json()) as any;

      /*
       * data.gov.tw v2 metadata API
       * 可能直接回傳 metadata，
       * 也可能包在 payload / result。
       */
      const metadata =
        raw?.payload ??
        raw?.result ??
        raw;

      if (
        !metadata ||
        typeof metadata !== "object"
      ) {
        throw new Error(
          "政府資料開放平臺回傳的 Dataset Metadata 格式無法辨識"
        );
      }

      /*
       * 將 distribution / resource 做標準化，
       * 方便後續直接交給 get_kcg_resource_data。
       */
      const distributions =
        Array.isArray(
          metadata.distribution
        )
          ? metadata.distribution
          : Array.isArray(
              metadata.distributions
            )
            ? metadata.distributions
            : [];

      const resources =
        distributions.map(
          (item: any) => ({
            title:
              item.title ||
              item.resourceName ||
              item.name ||
              "",

            format:
              item.format ||
              item.resourceFormat ||
              "",

            download_url:
              item.resourceDownloadURL ||
              item.resourceDownloadUrl ||
              item.downloadURL ||
              item.url ||
              "",

            description:
              item.description ||
              "",

            resource_id:
              item.resourceID ||
              item.resourceId ||
              item.id ||
              "",

            raw: item,
          })
        );

      const result = {
        dataset_id:
          metadata.datasetId ??
          metadata.datasetID ??
          datasetId,

        title:
          metadata.title ||
          metadata.datasetName ||
          "",

        description:
          metadata.description ||
          "",

        type:
          metadata.type ||
          "",

        publisher:
          metadata.publisher ||
          metadata.dataProvider ||
          metadata.provideFrom ||
          "",

        publisher_oid:
          metadata.publisherOID ||
          "",

        modified_at:
          metadata.modifiedDate ||
          metadata.modified_at ||
          "",

        published_at:
          metadata.publishedDate ||
          metadata.published_at ||
          "",

        license:
          metadata.license ||
          "",

        cost:
          metadata.cost ||
          "",

        resources,

        raw_metadata:
          metadata,
      };

      const envelope =
        await buildCivicEnvelope(
          result,
          {
            source_id:
              "data_gov_tw_dataset_metadata",

            source_url:
              targetUrl,

            source_type:
              "openapi",

            agency:
              "國家資料開放平臺",
          },
          {
            dataset_id:
              datasetId,

            resource_count:
              resources.length,
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    /* -----------------------------------------------------
     * 4. OpenAPI Resource
     * ----------------------------------------------------- */

    case "get_kcg_resource_data": {
      const uuid =
        typeof args.resource_uuid ===
        "string"
          ? args.resource_uuid.trim()
          : "";

      if (!uuid) {
        throw new Error(
          "缺少必要參數: resource_uuid"
        );
      }

      const targetUrl =
        `${OPENAPI_BASE}/${uuid}`;

      const response = await fetch(
        targetUrl
      );

      if (!response.ok) {
        throw new Error(
          `無法存取高雄 OpenAPI 資源 (HTTP ${response.status})`
        );
      }

      const raw =
        (await response.json()) as any;

      const records =
        Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];

      const limit = Math.min(
        Math.max(
          Number(args.limit) || 50,
          1
        ),
        500
      );

      const result =
        records.slice(0, limit);

      const envelope =
        await buildCivicEnvelope(
          result,
          {
            source_id:
              "kcg_openapi",

            source_url:
              targetUrl,

            source_type:
              "openapi",

            agency:
              "高雄市政府",
          },
          {
            resource_uuid: uuid,
            requested_limit: limit,
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    /* -----------------------------------------------------
     * 3. Budget Compare
     * ----------------------------------------------------- */

    case "get_kcg_budget_trend": {
      const keyword = String(args.keyword ?? "").trim();
      const startYear = Number(args.start_year);
      const endYear = Number(args.end_year);

      if (!keyword) {
        throw new Error("keyword 不可為空");
      }

      if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
        throw new Error("start_year 與 end_year 必須為整數");
      }

      if (startYear > endYear) {
        throw new Error("start_year 不可大於 end_year");
      }

      if (endYear - startYear > 20) {
        throw new Error("年度範圍不可超過 20 年");
      }

      const datasetId = 101174;

      const metadataResponse = await fetch(
        `${DATAGOV_API_BASE}/dataset/${datasetId}`
      );

      if (!metadataResponse.ok) {
        throw new Error(
          `取得預算資料集 metadata 失敗：HTTP ${metadataResponse.status}`
        );
      }

      const metadataPayload = await metadataResponse.json() as any;
      const metadata =
        metadataPayload?.payload ??
        metadataPayload?.result ??
        metadataPayload;

      const distributions = Array.isArray(metadata?.distribution)
        ? metadata.distribution
        : [];

      async function resolveTrendResource(targetYear: number) {
        const distribution = distributions.find((item: any) => {
          const description = String(
            item.resourceDescription ??
            item.resource_description ??
            item.name ??
            ""
          );

          const format = String(
            item.resourceFormat ??
            item.resource_format ??
            ""
          ).toLowerCase();

          return (
            description.includes(`${targetYear}年度`) &&
            format === "json" &&
            Boolean(
              item.resourceDownloadUrl ??
              item.resourceDownloadURL ??
              item.download_url
            )
          );
        });

        if (!distribution) {
          throw new Error(`找不到 ${targetYear} 年預算 JSON 資源`);
        }

        const resourceUrl =
          distribution.resourceDownloadUrl ??
          distribution.resourceDownloadURL ??
          distribution.download_url;

        const match = String(resourceUrl).match(
          /([0-9a-f]{8}-[0-9a-f-]{27,})/i
        );

        if (!match) {
          throw new Error(`無法解析 ${targetYear} 年 Resource UUID`);
        }

        return {
          uuid: match[1],
          url: `${OPENAPI_BASE}/${match[1]}`
        };
      }

      const years = Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => startYear + index
      );

      const resources = await Promise.all(
        years.map(async (year) => ({
          year,
          resource: await resolveTrendResource(year)
        }))
      );

      const yearlyRecords = await Promise.all(
        resources.map(async ({ year, resource }) => {
          const response = await fetch(resource.url);

          if (!response.ok) {
            throw new Error(
              `${year} 年預算資料抓取失敗：HTTP ${response.status}`
            );
          }

          const payload = await response.json() as any;

          const records =
            Array.isArray(payload?.data)
              ? payload.data
              : Array.isArray(payload)
                ? payload
                : [];

          return {
            year,
            resource,
            records
          };
        })
      );

      const accountMap = new Map<string, Map<number, any>>();

      for (const { year, records } of yearlyRecords) {
        for (const record of records) {
          const accountName = String(
            record?.科目名稱 ??
            record?.名稱 ??
            record?.機關名稱 ??
            record?.機關 ??
            ""
          ).trim();

          if (!accountName || !accountName.includes(keyword)) {
            continue;
          }

          if (!accountMap.has(accountName)) {
            accountMap.set(accountName, new Map());
          }

          accountMap.get(accountName)!.set(year, {
            budget_thousand_twd: parseBudgetValue(
              record?.本年度預算數
            ),
            record
          });
        }
      }

      const data = Array.from(accountMap.entries())
        .map(([accountName, yearMap]) => {
          const yearly = years.map((year) => {
            const found = yearMap.get(year);

            return {
              year,
              budget_thousand_twd:
                found?.budget_thousand_twd ?? null
            };
          });

          const available = yearly.filter(
            (item) => item.budget_thousand_twd !== null
          );

          const first = available[0]?.budget_thousand_twd ?? null;
          const last =
            available[available.length - 1]?.budget_thousand_twd ?? null;

          const difference =
            first !== null && last !== null
              ? last - first
              : null;

          const changePercent =
            first !== null &&
            first !== 0 &&
            difference !== null
              ? (difference / first) * 100
              : null;

          const values = available.map(
            (item) => item.budget_thousand_twd as number
          );

          const highest =
            values.length > 0 ? Math.max(...values) : null;

          const lowest =
            values.length > 0 ? Math.min(...values) : null;

          const highestYear =
            highest === null
              ? null
              : available.find(
                  (item) => item.budget_thousand_twd === highest
                )?.year ?? null;

          const lowestYear =
            lowest === null
              ? null
              : available.find(
                  (item) => item.budget_thousand_twd === lowest
                )?.year ?? null;

          return {
            account_name: accountName,
            yearly,
            first_year_budget_thousand_twd: first,
            last_year_budget_thousand_twd: last,
            difference_thousand_twd: difference,
            change_percent: changePercent,
            highest_budget_thousand_twd: highest,
            highest_budget_year: highestYear,
            lowest_budget_thousand_twd: lowest,
            lowest_budget_year: lowestYear
          };
        })
        .sort(
          (a, b) =>
            Math.abs(b.difference_thousand_twd ?? 0) -
            Math.abs(a.difference_thousand_twd ?? 0)
        );

      return buildCivicEnvelope(
        {
          status: "success",
          provider: "kaohsiung_civic_mcp",
          data: data.slice(0, 100)
        },
        {
          source_id: "kcg_budget_trend",
          source_url: resources[resources.length - 1]?.resource.url ?? "",
          source_type: "openapi",
          agency: "高雄市政府主計處"
        },
        {
          dataset_id: datasetId,
          keyword,
          start_year: startYear,
          end_year: endYear,
          unit: "新臺幣千元",
          returned: data.length
        }
      );
    }

    case "get_kcg_budget_compare": {
      const year =
        Number(args.year) || 115;

      const compareYear =
        Number(args.compare_year) || (year - 1);

      if (
        !Number.isInteger(year) ||
        year <= 0
      ) {
        throw new Error(
          "year 必須是正整數民國年度"
        );
      }

      if (
        !Number.isInteger(compareYear) ||
        compareYear <= 0
      ) {
        throw new Error(
          "compare_year 必須是正整數民國年度"
        );
      }

      if (year === compareYear) {
        throw new Error(
          "year 與 compare_year 不可相同"
        );
      }

      const datasetId = 101174;

      /*
       * ---------------------------------------------------
       * 取得指定年度 Resource
       * ---------------------------------------------------
       */

      async function resolveBudgetResource(
        targetYear: number
      ): Promise<{
        resourceUrl: string;
        resourceUuid: string;
        description: string;
      }> {
        const metadataUrl =
          `${DATAGOV_API_BASE}/dataset/${datasetId}`;

        const metadataResponse =
          await fetch(
            metadataUrl,
            {
              headers: {
                "User-Agent":
                  "Kaohsiung-Civic-MCP/1.0",
                "Accept":
                  "application/json",
              },
            }
          );

        if (!metadataResponse.ok) {
          throw new Error(
            `Dataset ${datasetId} Metadata 請求失敗 (HTTP ${metadataResponse.status})`
          );
        }

        const rawMetadata =
          (await metadataResponse.json()) as any;

        const metadata =
          rawMetadata?.payload ??
          rawMetadata?.result ??
          rawMetadata;

        const distributions =
          Array.isArray(
            metadata?.distribution
          )
            ? metadata.distribution
            : [];

        const yearText =
          `${targetYear}年度`;

        const matched =
          distributions.find(
            (resource: any) => {
              const description =
                String(
                  resource.resourceDescription ||
                  ""
                );

              const format =
                String(
                  resource.resourceFormat ||
                  ""
                ).toUpperCase();

              return (
                description.includes(
                  yearText
                ) &&
                format === "JSON"
              );
            }
          );

        if (!matched) {
          throw new Error(
            `Dataset ${datasetId} 找不到 ${targetYear} 年度 JSON Resource`
          );
        }

        const resourceUrl =
          String(
            matched.resourceDownloadUrl ||
            ""
          ).trim();

        if (!resourceUrl) {
          throw new Error(
            `${targetYear} 年度 Resource 沒有 resourceDownloadUrl`
          );
        }

        const uuidMatch =
          resourceUrl.match(
            /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i
          );

        if (!uuidMatch) {
          throw new Error(
            `無法從 ${targetYear} 年度 Resource URL 解析 UUID: ${resourceUrl}`
          );
        }

        return {
          resourceUrl,
          resourceUuid:
            uuidMatch[1],
          description:
            String(
              matched.resourceDescription ||
              `${targetYear}年度高雄市總預算歲出機關別預算比較總表`
            ),
        };
      }

      /*
       * ---------------------------------------------------
       * 同時解析兩個年度 Resource
       * ---------------------------------------------------
       */

      const [
        currentResource,
        compareResource,
      ] = await Promise.all([
        resolveBudgetResource(year),
        resolveBudgetResource(compareYear),
      ]);

      /*
       * ---------------------------------------------------
       * 同時抓取兩年度資料
       * ---------------------------------------------------
       */

      const [
        currentResponse,
        compareResponse,
      ] = await Promise.all([
        fetch(
          currentResource.resourceUrl,
          {
            headers: {
              "User-Agent":
                "Kaohsiung-Civic-MCP/1.0",
              "Accept":
                "application/json",
            },
          }
        ),
        fetch(
          compareResource.resourceUrl,
          {
            headers: {
              "User-Agent":
                "Kaohsiung-Civic-MCP/1.0",
              "Accept":
                "application/json",
            },
          }
        ),
      ]);

      if (!currentResponse.ok) {
        throw new Error(
          `${year} 年度預算 Resource 請求失敗 (HTTP ${currentResponse.status})`
        );
      }

      if (!compareResponse.ok) {
        throw new Error(
          `${compareYear} 年度預算 Resource 請求失敗 (HTTP ${compareResponse.status})`
        );
      }

      const [
        currentRaw,
        compareRaw,
      ] = await Promise.all([
        currentResponse.json() as Promise<any>,
        compareResponse.json() as Promise<any>,
      ]);

      const currentRecords =
        Array.isArray(currentRaw)
          ? currentRaw
          : Array.isArray(currentRaw?.data)
            ? currentRaw.data
            : [];

      const compareRecords =
        Array.isArray(compareRaw)
          ? compareRaw
          : Array.isArray(compareRaw?.data)
            ? compareRaw.data
            : [];

      if (
        currentRecords.length === 0
      ) {
        throw new Error(
          `${year} 年度預算 Resource 沒有資料紀錄`
        );
      }

      if (
        compareRecords.length === 0
      ) {
        throw new Error(
          `${compareYear} 年度預算 Resource 沒有資料紀錄`
        );
      }

      /*
       * ---------------------------------------------------
       * 標準化名稱
       * ---------------------------------------------------
       */

      const getAccountName =
        (record: any): string =>
          String(
            record["科目名稱"] ||
            record["名稱"] ||
            record["機關名稱"] ||
            record["機關"] ||
            ""
          ).trim();

      /*
       * ---------------------------------------------------
       * 建立比較年度 Map
       * ---------------------------------------------------
       */

      const compareMap =
        new Map<string, any>();

      for (
        const record of compareRecords
      ) {
        const name =
          getAccountName(record);

        if (!name) {
          continue;
        }

        compareMap.set(
          name,
          record
        );
      }

      const keyword =
        typeof args.keyword === "string"
          ? args.keyword.trim()
          : "";

      /*
       * ---------------------------------------------------
       * 產生比較結果
       * ---------------------------------------------------
       */

      const compared =
        currentRecords
          .map((record: any) => {
            const accountName =
              getAccountName(record);

            if (!accountName) {
              return null;
            }

            if (
              keyword &&
              !accountName.includes(
                keyword
              )
            ) {
              return null;
            }

            const previous =
              compareMap.get(
                accountName
              );

            const currentBudget =
              parseBudgetValue(
                record["本年度預算數"]
              );

            const compareBudget =
              previous
                ? parseBudgetValue(
                    previous[
                      "本年度預算數"
                    ]
                  )
                : 0;

            const difference =
              currentBudget -
              compareBudget;

            const percentage =
              compareBudget !== 0
                ? Number(
                    (
                      difference /
                      compareBudget
                    ) *
                      100
                  )
                : null;

            return {
              account_name:
                accountName,

              year:
                year,

              compare_year:
                compareYear,

              current_year_budget_thousand_twd:
                currentBudget,

              compare_year_budget_thousand_twd:
                compareBudget,

              difference_thousand_twd:
                difference,

              change_percent:
                percentage,

              comparison_status:
                previous
                  ? "matched"
                  : "current_year_only",

              current_record:
                record,

              compare_record:
                previous || null,
            };
          })
          .filter(
            (
              item: any
            ): item is Record<string, unknown> =>
              item !== null
          )
          .sort(
            (
              a: any,
              b: any
            ) =>
              Math.abs(
                Number(
                  b.difference_thousand_twd
                )
              ) -
              Math.abs(
                Number(
                  a.difference_thousand_twd
                )
              )
          );

      /*
       * ---------------------------------------------------
       * limit
       * ---------------------------------------------------
       */

      const limit =
        Math.min(
          Math.max(
            Number(args.limit) || 100,
            1
          ),
          500
        );

      const result =
        compared.slice(
          0,
          limit
        );

      /*
       * ---------------------------------------------------
       * Summary
       * ---------------------------------------------------
       */

      const increased =
        compared.filter(
          (item: any) =>
            item.difference_thousand_twd >
            0
        ).length;

      const decreased =
        compared.filter(
          (item: any) =>
            item.difference_thousand_twd <
            0
        ).length;

      const unchanged =
        compared.filter(
          (item: any) =>
            item.difference_thousand_twd ===
            0
        ).length;

      const envelope =
        await buildCivicEnvelope(
          result,
          {
            source_id:
              "kcg_budget_compare",

            /*
             * provenance 使用兩個官方 Resource，
             * source_url 以目標年度為主。
             */
            source_url:
              currentResource.resourceUrl,

            source_type:
              "openapi",

            agency:
              "高雄市政府主計處",
          },
          {
            dataset_id:
              datasetId,

            year,

            compare_year:
              compareYear,

            unit:
              "新臺幣千元",

            current_resource_uuid:
              currentResource.resourceUuid,

            compare_resource_uuid:
              compareResource.resourceUuid,

            current_resource_url:
              currentResource.resourceUrl,

            compare_resource_url:
              compareResource.resourceUrl,

            keyword,

            returned:
              result.length,

            matched_total:
              compared.length,

            increased_count:
              increased,

            decreased_count:
              decreased,

            unchanged_count:
              unchanged,

            sort:
              "absolute_difference_desc",
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    /* -----------------------------------------------------
     * 3. Budget
     * ----------------------------------------------------- */

    case "get_kcg_budget_report": {
      const year =
        Number(args.year) || 115;

      const datasetId = 101174;

      const metadataUrl =
        `${DATAGOV_API_BASE}/dataset/${datasetId}`;

      /*
       * 直接從政府資料開放平臺取得
       * 101174 完整 Dataset Metadata。
       *
       * 不再使用已失效的 CKAN package_show。
       */
      const metadataResponse =
        await fetch(
          metadataUrl,
          {
            headers: {
              "User-Agent":
                "Kaohsiung-Civic-MCP/1.0",
              "Accept":
                "application/json",
            },
          }
        );

      if (!metadataResponse.ok) {
        throw new Error(
          `高雄市總預算 Dataset Metadata 請求失敗 (HTTP ${metadataResponse.status})`
        );
      }

      const rawMetadata =
        (await metadataResponse.json()) as any;

      const metadata =
        rawMetadata?.payload ??
        rawMetadata?.result ??
        rawMetadata;

      const distributions =
        Array.isArray(
          metadata?.distribution
        )
          ? metadata.distribution
          : [];

      /*
       * 找指定年度的 JSON Resource。
       *
       * Resource Description 例如：
       * 115年度高雄市總預算歲出機關別預算比較總表
       */
      const yearText =
        `${year}年度`;

      const matched =
        distributions.find(
          (resource: any) => {
            const description =
              String(
                resource.resourceDescription ||
                ""
              );

            const format =
              String(
                resource.resourceFormat ||
                ""
              ).toUpperCase();

            return (
              description.includes(
                yearText
              ) &&
              format === "JSON"
            );
          }
        );

      if (!matched) {
        throw new Error(
          `在 Dataset ${datasetId} 找不到 ${year} 年度 JSON 預算 Resource`
        );
      }

      const resourceUrl =
        String(
          matched.resourceDownloadUrl ||
          ""
        ).trim();

      if (!resourceUrl) {
        throw new Error(
          `找到 ${year} 年度預算 Resource，但沒有 resourceDownloadUrl`
        );
      }

      /*
       * 從官方 OpenAPI URL 解析 UUID。
       */
      const uuidMatch =
        resourceUrl.match(
          /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i
        );

      if (!uuidMatch) {
        throw new Error(
          `無法從 Resource URL 解析 Resource UUID: ${resourceUrl}`
        );
      }

      const resourceUuid =
        uuidMatch[1];

      const dataResponse =
        await fetch(
          resourceUrl,
          {
            headers: {
              "User-Agent":
                "Kaohsiung-Civic-MCP/1.0",
              "Accept":
                "application/json",
            },
          }
        );

      if (!dataResponse.ok) {
        throw new Error(
          `${year} 年度預算 Resource 請求失敗 (HTTP ${dataResponse.status})`
        );
      }

      const raw =
        (await dataResponse.json()) as any;

      const records =
        Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];

      const keyword =
        typeof args.keyword === "string"
          ? args.keyword.trim()
          : "";

      const normalized =
        records
          .map((record: any) => {
            const accountName =
              String(
                record["科目名稱"] ||
                record["名稱"] ||
                ""
              ).trim();

            return {
              ...record,

              account_name:
                accountName,

              current_year_budget_thousand_twd:
                parseBudgetValue(
                  record["本年度預算數"]
                ),

              last_year_budget_thousand_twd:
                parseBudgetValue(
                  record["上年度預算數"]
                ),

              prior_year_final_thousand_twd:
                parseBudgetValue(
                  record["前年度決算數"]
                ),

              comparison_diff_thousand_twd:
                parseBudgetValue(
                  record[
                    "本年度與上年度比較"
                  ]
                ),
            };
          })
          .filter(
            (record: any) =>
              !keyword ||
              String(
                record.account_name
              ).includes(keyword)
          );

      const envelope =
        await buildCivicEnvelope(
          normalized,
          {
            source_id:
              "kcg_budget",

            source_url:
              resourceUrl,

            source_type:
              "openapi",

            agency:
              "高雄市政府主計處",
          },
          {
            year,

            dataset_id:
              datasetId,

            unit:
              "新臺幣千元",

            resource_uuid:
              resourceUuid,

            resource_format:
              "JSON",

            resource_description:
              matched.resourceDescription ||
              `${year}年度高雄市總預算歲出機關別預算比較總表`,

            keyword,

            total:
              normalized.length,
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    /* -----------------------------------------------------
     * 4. News RSS
     * ----------------------------------------------------- */

    case "get_kcg_latest_news": {
      const channel =
        typeof args.channel ===
        "string"
          ? args.channel
          : "municipal_news";

      const targetUrl =
        RSS_CHANNELS[channel] ||
        RSS_CHANNELS.municipal_news;

      const response =
        await fetch(targetUrl);

      if (!response.ok) {
        throw new Error(
          `新聞 RSS 抓取失敗 (HTTP ${response.status})`
        );
      }

      const xml =
        await response.text();

      const items: Array<{
        title: string;
        link: string;
        published_at: string;
        description: string;
      }> = [];

      const itemMatches =
        xml.matchAll(
          /<item>([\s\S]*?)<\/item>/gi
        );

      for (
        const match of itemMatches
      ) {
        const content = match[1];

        const titleMatch =
          content.match(
            /<title>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/title>/i
          ) ||
          content.match(
            /<title>([\s\S]*?)<\/title>/i
          );

        const linkMatch =
          content.match(
            /<link>\s*([\s\S]*?)\s*<\/link>/i
          );

        const dateMatch =
          content.match(
            /<pubDate>\s*([\s\S]*?)\s*<\/pubDate>/i
          );

        const descriptionMatch =
          content.match(
            /<description>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/description>/i
          ) ||
          content.match(
            /<description>([\s\S]*?)<\/description>/i
          );

        const description =
          descriptionMatch
            ? descriptionMatch[1]
                .trim()
                .replace(
                  /<[^>]*>/g,
                  ""
                )
            : "";

        items.push({
          title: titleMatch
            ? titleMatch[1].trim()
            : "無標題",

          link: linkMatch
            ? linkMatch[1].trim()
            : "",

          published_at: dateMatch
            ? dateMatch[1].trim()
            : "",

          description,
        });
      }

      const limit = Math.min(
        Math.max(
          Number(args.limit) || 10,
          1
        ),
        100
      );

      const result =
        items.slice(0, limit);

      const envelope =
        await buildCivicEnvelope(
          result,
          {
            source_id:
              "kcg_news",

            source_url:
              targetUrl,

            source_type:
              "rss",

            agency:
              "高雄市政府新聞局",
          },
          {
            channel,
            returned:
              result.length,
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    /* -----------------------------------------------------
     * 5. Civic Service
     * ----------------------------------------------------- */

    case "get_kcg_civic_service_cases": {
      const targetUrl =
        `${OPENAPI_BASE}/${CIVIC_SERVICE_UUID}`;

      const response =
        await fetch(targetUrl);

      if (!response.ok) {
        throw new Error(
          `市政服務 API 請求失敗: HTTP ${response.status}`
        );
      }

      const raw =
        (await response.json()) as any;

      const records =
        Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];

      const keyword =
        typeof args.keyword ===
        "string"
          ? args.keyword.trim()
          : "";

      const limit = Math.min(
        Math.max(
          Number(args.limit) || 20,
          1
        ),
        200
      );

      const filtered =
        records
          .filter(
            (record: any) =>
              !keyword ||
              JSON.stringify(
                record
              ).includes(keyword)
          )
          .slice(0, limit);

      const envelope =
        await buildCivicEnvelope(
          filtered,
          {
            source_id:
              "kcg_civic_service",

            source_url:
              targetUrl,

            source_type:
              "openapi",

            agency:
              "高雄市政府研究發展考核委員會",
          },
          {
            keyword,
            requested_limit:
              limit,
          }
        );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope
            ),
          },
        ],
      };
    }

    default:
      throw new Error(
        `未支援的工具: ${name}`
      );
  }
}

/* =========================================================
 * JSON-RPC / MCP
 * ========================================================= */

async function processRpc(
  body: any,
  env: Env
) {
  const id = body?.id;
  const method = body?.method;
  const params =
    body?.params || {};

  /* MCP initialize */

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,

      result: {
        protocolVersion:
          "2024-11-05",

        capabilities: {
          tools: {
            listChanged: false,
          },
        },

        serverInfo: {
          name:
            "kcg-civic-mcp-worker",

          version:
            "1.0.0",
        },
      },
    };
  }

  /* initialized notification */

  if (
    method ===
    "notifications/initialized"
  ) {
    return null;
  }

  /* ping */

  if (method === "ping") {
    return {
      jsonrpc: "2.0",
      id,
      result: {},
    };
  }

  /* tools/list */

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,

      result: {
        tools: TOOL_REGISTRY,
      },
    };
  }

  /* tools/call */

  if (method === "tools/call") {
    try {
      const toolName =
        typeof params.name ===
        "string"
          ? params.name
          : "";

      if (!toolName) {
        throw new Error(
          "tools/call 缺少 name"
        );
      }

      const argumentsObject =
        params.arguments &&
        typeof params.arguments ===
          "object"
          ? params.arguments
          : {};

      const result =
        await executeCivicTool(
          toolName,
          argumentsObject
        );

      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "市政資料調度發生例外錯誤";

      return {
        jsonrpc: "2.0",
        id,

        error: {
          code: -32603,
          message,
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,

    error: {
      code: -32601,

      message:
        `不支援的方法: ${method}`,
    },
  };
}

/* =========================================================
 * Authorization
 * ========================================================= */

function checkAuthorized(
  request: Request,
  env: Env
): boolean {
  if (!env.AUTH_TOKEN) {
    return true;
  }

  const url =
    new URL(request.url);

  const queryToken =
    url.searchParams.get(
      "token"
    );

  if (
    queryToken &&
    queryToken === env.AUTH_TOKEN
  ) {
    return true;
  }

  const authorization =
    request.headers.get(
      "Authorization"
    ) || "";

  const parts =
    authorization.split(" ");

  return (
    parts.length === 2 &&
    parts[0] === "Bearer" &&
    parts[1] === env.AUTH_TOKEN
  );
}

/* =========================================================
 * Worker
 * ========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const corsHeaders = {
      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS",

      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, mcp-session-id",

      "Access-Control-Expose-Headers":
        "mcp-session-id",
    };

    /* OPTIONS */

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders,
        }
      );
    }

    /* Authorization */

    if (
      !checkAuthorized(
        request,
        env
      )
    ) {
      return jsonResponse(
        {
          jsonrpc: "2.0",

          id: null,

          error: {
            code: -32000,

            message:
              "未經授權之請求",
          },
        },

        401,

        corsHeaders
      );
    }

    const url =
      new URL(request.url);

    /* Root health check */

    if (
      request.method ===
        "GET" &&
      url.pathname === "/"
    ) {
      return jsonResponse(
        {
          ok: true,

          service:
            "kcg-civic-mcp-worker",

          version:
            "1.0.0",

          mcp: true,

          message:
            "Kaohsiung Civic MCP Worker is running.",

          endpoint:
            "/mcp",
        },

        200,

        corsHeaders
      );
    }

    /*
     * MCP endpoint
     *
     * 目前接受 POST JSON-RPC。
     */

    if (
      request.method ===
        "POST" &&
      (
        url.pathname ===
          "/mcp" ||
        url.pathname === "/"
      )
    ) {
      try {
        const body =
          await request.json();

        /*
         * JSON-RPC batch
         */

        if (
          Array.isArray(body)
        ) {
          const results: unknown[] =
            [];

          for (
            const item of body
          ) {
            const result =
              await processRpc(
                item,
                env
              );

            if (result !== null) {
              results.push(result);
            }
          }

          if (
            results.length === 0
          ) {
            return new Response(
              null,
              {
                status: 202,
                headers:
                  corsHeaders,
              }
            );
          }

          return jsonResponse(
            results,
            200,
            corsHeaders
          );
        }

        /*
         * Single JSON-RPC request
         */

        const result =
          await processRpc(
            body,
            env
          );

        /*
         * Notification 不需要 response
         */

        if (result === null) {
          return new Response(
            null,
            {
              status: 202,
              headers:
                corsHeaders,
            }
          );
        }

        return jsonResponse(
          result,
          200,
          corsHeaders
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Invalid JSON-RPC request";

        return jsonResponse(
          {
            jsonrpc: "2.0",

            id: null,

            error: {
              code: -32700,

              message,
            },
          },

          400,

          corsHeaders
        );
      }
    }

    /*
     * GET /mcp
     *
     * 不再建立無限期 TransformStream。
     * 直接回傳服務資訊，避免 Worker hang。
     */

    if (
      request.method ===
        "GET" &&
      url.pathname === "/mcp"
    ) {
      return jsonResponse(
        {
          ok: true,

          service:
            "kcg-civic-mcp-worker",

          mcp: true,

          endpoint:
            "/mcp",

          transport:
            "HTTP JSON-RPC",

          message:
            "Send MCP JSON-RPC requests with POST.",
        },

        200,

        corsHeaders
      );
    }

    return new Response(
      "Not Found",
      {
        status: 404,
        headers:
          corsHeaders,
      }
    );
  },
};
