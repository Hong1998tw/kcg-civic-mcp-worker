export type BudgetSummaryParsed = {
  agency_count: number;
  agency_sum_budget_thousand_twd: number;
  official_total_budget_thousand_twd: number | null;
  highest: { record_type: "agency"; account_name: string; budget_thousand_twd: number };
  lowest: { record_type: "agency"; account_name: string; budget_thousand_twd: number };
};

const NAME_HEADERS = ["科目名稱", "科目", "主管名稱", "機關名稱"];
const AMOUNT_HEADERS = ["本年度預算數", "本年度預算", "預算數"];
const TOTAL_MARKERS = ["合計", "總計", "總額"];

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const normalized = normalizeText(value).replace(/,/g, "").replace(/\s+/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }

  cells.push(cell.trim());
  return cells;
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const normalizedHeaders = headers.map(normalizeText);
  for (const candidate of candidates) {
    const exact = normalizedHeaders.indexOf(candidate);
    if (exact >= 0) return exact;
  }
  return -1;
}

function summarizeRows(rows: Array<{ name: string; amount: number }>): BudgetSummaryParsed {
  let agencyCount = 0;
  let agencySum = 0;
  let officialTotal: number | null = null;
  let highest: BudgetSummaryParsed["highest"] | null = null;
  let lowest: BudgetSummaryParsed["lowest"] | null = null;

  for (const row of rows) {
    const name = normalizeText(row.name);
    const amount = row.amount;
    if (!name || !Number.isFinite(amount)) continue;

    if (TOTAL_MARKERS.some((marker) => name.includes(marker))) {
      officialTotal = amount;
      continue;
    }

    agencyCount++;
    agencySum += amount;

    if (!highest || amount > highest.budget_thousand_twd) {
      highest = { record_type: "agency", account_name: name, budget_thousand_twd: amount };
    }
    if (!lowest || amount < lowest.budget_thousand_twd) {
      lowest = { record_type: "agency", account_name: name, budget_thousand_twd: amount };
    }
  }

  if (agencyCount === 0 || !highest || !lowest) {
    throw new Error("預算資料解析失敗：找不到可用的主管機關預算列；請檢查來源 schema／編碼");
  }

  return {
    agency_count: agencyCount,
    agency_sum_budget_thousand_twd: agencySum,
    official_total_budget_thousand_twd: officialTotal,
    highest,
    lowest,
  };
}

function parseCsv(rawContent: string): BudgetSummaryParsed {
  const lines = rawContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("預算 CSV 解析失敗：資料列不足");
  }

  const headers = parseCsvLine(lines[0]).map(normalizeText);
  const nameIndex = findHeaderIndex(headers, NAME_HEADERS);
  const amountIndex = findHeaderIndex(headers, AMOUNT_HEADERS);

  if (nameIndex < 0 || amountIndex < 0) {
    throw new Error(`預算 CSV schema 不符：找不到科目名稱或本年度預算數欄位；實際欄位=${headers.join("|")}`);
  }

  const rows: Array<{ name: string; amount: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = normalizeText(cols[nameIndex]);
    const amount = parseAmount(cols[amountIndex]);
    if (name && amount !== null) rows.push({ name, amount });
  }

  return summarizeRows(rows);
}

function recordHasBudgetFields(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).map(normalizeText);
  return NAME_HEADERS.some((candidate) => keys.includes(candidate)) &&
    AMOUNT_HEADERS.some((candidate) => keys.includes(candidate));
}

function findBudgetRecordArray(value: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 5) return null;

  if (Array.isArray(value)) {
    const records = value.filter((item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)
    );
    if (records.some(recordHasBudgetFields)) return records;
    for (const item of value) {
      const nested = findBudgetRecordArray(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const priorityKeys = ["data", "result", "records", "Data", "Result", "Records"];
    for (const key of priorityKeys) {
      if (key in obj) {
        const nested = findBudgetRecordArray(obj[key], depth + 1);
        if (nested) return nested;
      }
    }
    for (const nestedValue of Object.values(obj)) {
      const nested = findBudgetRecordArray(nestedValue, depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

function parseJson(rawContent: string): BudgetSummaryParsed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error("預算 JSON 解析失敗：來源不是有效 JSON");
  }

  const records = findBudgetRecordArray(parsed);
  if (!records) {
    throw new Error("預算 JSON schema 不符：找不到含科目名稱與本年度預算數的資料列");
  }

  const rows: Array<{ name: string; amount: number }> = [];
  for (const record of records) {
    const entries = Object.entries(record).map(([key, value]) => [normalizeText(key), value] as const);
    const nameEntry = entries.find(([key]) => NAME_HEADERS.includes(key));
    const amountEntry = entries.find(([key]) => AMOUNT_HEADERS.includes(key));
    const name = normalizeText(nameEntry?.[1]);
    const amount = parseAmount(amountEntry?.[1]);
    if (name && amount !== null) rows.push({ name, amount });
  }

  return summarizeRows(rows);
}

export function parseBudgetSummaryRaw(rawContent: string): BudgetSummaryParsed {
  const trimmed = rawContent.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error("預算資料解析失敗：來源內容為空");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJson(trimmed);
  }

  return parseCsv(trimmed);
}
