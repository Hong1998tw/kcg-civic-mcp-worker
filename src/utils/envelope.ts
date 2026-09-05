import { Provenance, StandardEnvelope } from "../models/types";

export function buildEnvelope<T>(
  data: T,
  provenance: Provenance,
  meta: Record<string, any> = {}
): StandardEnvelope<T> {
  return {
    status: "success",
    provider: "kaohsiung_civic_mcp",
    updated_at: new Date().toISOString(),
    provenance,
    meta,
    data,
  };
}
