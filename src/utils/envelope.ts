import { Provenance, StandardEnvelope } from "../models/types";

export function buildEnvelope<T>(
  data: T,
  provenance: Provenance,
  meta: Record<string, any> = {}
): StandardEnvelope<T> {
  return {
    status: provenance.source_type === "fallback" ? "partial" : "success",
    provider: "kaohsiung_civic_mcp",
    updated_at: new Date().toISOString(),
    provenance,
    meta,
    data,
  };
}

export function buildOfficialProvenance(
  sourceUrl: string,
  sourceId: string | number = "kcc-official",
  agency = "高雄市議會",
): Provenance {
  return {
    source_id: sourceId,
    source_url: sourceUrl,
    source_type: "official_web",
    agency,
    retrieved_at: new Date().toISOString(),
    content_hash: "not-computed",
  };
}

export function buildKccEnvelope<T>(
  data: T,
  sourceUrl: string,
  meta: Record<string, any> = {},
): StandardEnvelope<T> {
  return buildEnvelope(data, buildOfficialProvenance(sourceUrl), meta);
}

export function buildPartialEnvelope<T>(
  data: T,
  provenance: Provenance,
  meta: Record<string, any> = {},
): StandardEnvelope<T> {
  return { ...buildEnvelope(data, provenance, meta), status: "partial" };
}

export function isTruthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

export function boundedString(value: unknown, field: string, max = 200): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${field} 必須是文字`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} 長度不可超過 ${max} 字元`);
  return result;
}

export function boundedLimit(value: unknown, fallback = 10, max = 100): number {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error("limit 必須是正整數");
  return Math.min(result, max);
}

export function assertOfficialKccUrl(value: string, field = "URL"): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${field} 格式無效`); }
  if (url.protocol !== "https:" || url.hostname !== "cissearch.kcc.gov.tw") {
    throw new Error(`${field} 僅允許高雄市議會官方網域`);
  }
  return url.toString();
}
