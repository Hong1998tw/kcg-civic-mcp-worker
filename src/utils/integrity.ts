import { Env } from "../models/types";
import { calculateSha256 } from "./crypto";

export type IntegrityReasonCode =
  | "SNAPSHOT_UNVERIFIED"
  | "SNAPSHOT_REVOKED"
  | "SOURCE_ID_MISMATCH"
  | "FILTER_NOT_CONFIRMED"
  | "FEATURE_UNAVAILABLE"
  | "PDF_EXTRACTION_FAILED"
  | "PARTIAL_SCAN";

export class IntegrityError extends Error {
  constructor(public readonly reasonCode: IntegrityReasonCode, message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

interface ReleasePointer {
  manifest_key: string;
  manifest_sha256: string;
}

export interface VerifiedManifest {
  schema_version: string;
  dataset_id: string;
  snapshot_id: string;
  normalized_key: string;
  normalized_sha256: string;
  source_url: string;
  fetched_at: string;
  validated_at: string;
  validation_status: "passed" | "pending" | "failed";
  revoked: boolean;
  record_count: number;
  coverage: { scope: string; complete: boolean };
  parser_version: string;
  validator_version: string;
}

const REVOKED_NORMALIZED_SHA256: Record<string, Set<string>> = {
  "kcg-laws": new Set(["152d0dc2c8e25367e5b09a81bf5b35d73f6ea11a17877be6222e0cc0373d68a3"]),
  "kcg-news": new Set(["9ac6851713ad29a410e156d54e9f636c480113d3a920a363b44e4586e40281f9"]),
};

function isHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isSafeVerifiedKey(key: unknown, datasetId: string): key is string {
  return typeof key === "string" && key.startsWith(`verified/${datasetId}/`) && !key.includes("..") && !key.startsWith("/");
}

async function readObjectText(env: Env, key: string): Promise<string> {
  if (!env.kcg_civic_data) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${key} 無可用的資料儲存桶`);
  }
  const object = await env.kcg_civic_data.get(key);
  if (!object) throw new IntegrityError("SNAPSHOT_UNVERIFIED", `找不到 ${key}`);
  return object.text();
}

function parseJson(value: string, label: string): any {
  try { return JSON.parse(value); } catch {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${label} 不是有效 JSON`);
  }
}

/**
 * Resolve one immutable, independently validated dataset release. The active
 * pointer is read on every request, before any process cache is consulted, so a
 * revocation or release switch cannot be hidden by a stale in-memory cache.
 */
export async function loadVerifiedSnapshot<T>(env: Env, datasetId: string): Promise<{
  records: T[];
  manifest: VerifiedManifest;
  normalizedText: string;
}> {
  const pointerKey = `releases/${datasetId}/active.json`;
  const pointerText = await readObjectText(env, pointerKey);
  const pointer = parseJson(pointerText, pointerKey) as Partial<ReleasePointer>;
  if (!isSafeVerifiedKey(pointer.manifest_key, datasetId) || !isHexSha256(pointer.manifest_sha256)) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} release pointer 格式無效`);
  }

  const manifestText = await readObjectText(env, pointer.manifest_key);
  if ((await calculateSha256(manifestText)) !== pointer.manifest_sha256.toLowerCase()) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} manifest 雜湊不一致`);
  }
  const manifest = parseJson(manifestText, pointer.manifest_key) as Partial<VerifiedManifest>;
  if (manifest.dataset_id !== datasetId || typeof manifest.snapshot_id !== "string" || !manifest.snapshot_id) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} manifest 身分不一致`);
  }
  if (manifest.revoked === true) {
    throw new IntegrityError("SNAPSHOT_REVOKED", `${datasetId} snapshot 已撤銷`);
  }
  if (manifest.validation_status !== "passed") {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} snapshot 尚未通過驗證`);
  }
  if (manifest.schema_version !== "2.0" || typeof manifest.parser_version !== "string" || !manifest.parser_version ||
      typeof manifest.validator_version !== "string" || !manifest.validator_version ||
      !Number.isFinite(Date.parse(String(manifest.fetched_at))) || !Number.isFinite(Date.parse(String(manifest.validated_at)))) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} manifest 缺少版本或驗證時間`);
  }
  if (Date.parse(String(manifest.validated_at)) < Date.parse(String(manifest.fetched_at))) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} validated_at 早於 fetched_at`);
  }
  if (!isSafeVerifiedKey(manifest.normalized_key, datasetId) || !isHexSha256(manifest.normalized_sha256)) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} normalized object 宣告無效`);
  }
  if (!pointer.manifest_key.includes(`/${manifest.snapshot_id}/`) || !manifest.normalized_key.includes(`/${manifest.snapshot_id}/`)) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} immutable key 與 snapshot_id 不一致`);
  }
  if (REVOKED_NORMALIZED_SHA256[datasetId]?.has(manifest.normalized_sha256.toLowerCase())) {
    throw new IntegrityError("SNAPSHOT_REVOKED", `${datasetId} snapshot 指紋已列入撤銷清單`);
  }
  if (!manifest.coverage || typeof manifest.coverage.scope !== "string" || typeof manifest.coverage.complete !== "boolean") {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} coverage 宣告缺失`);
  }

  const normalizedText = await readObjectText(env, manifest.normalized_key);
  if ((await calculateSha256(normalizedText)) !== manifest.normalized_sha256.toLowerCase()) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} normalized 資料雜湊不一致`);
  }
  const records = parseJson(normalizedText, manifest.normalized_key);
  if (!Array.isArray(records) || !Number.isInteger(manifest.record_count) || records.length !== manifest.record_count) {
    throw new IntegrityError("SNAPSHOT_UNVERIFIED", `${datasetId} record_count 不一致`);
  }
  return { records: records as T[], manifest: manifest as VerifiedManifest, normalizedText };
}

export function unavailable(feature: string): never {
  throw new IntegrityError("FEATURE_UNAVAILABLE", `${feature} 尚未接通可驗證的官方來源，已停止輸出推測結果`);
}
