export interface Env {
  AUTH_TOKEN?: string;
  kcg_civic_data: R2Bucket;
  [key: string]: any;
}

export interface Provenance {
  source_id: string | number;
  source_url: string;
  source_type: "openapi" | "csv_direct" | "r2" | "cache";
  agency: string;
  retrieved_at: string;
  published_at?: string;
  content_hash: string;
}

export interface StandardEnvelope<T> {
  status: "success" | "error" | "partial";
  provider: "kaohsiung_civic_mcp";
  updated_at: string;
  provenance: Provenance;
  meta: Record<string, any>;
  data: T;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  handler: (args: any, env: Env) => Promise<any>;
}
