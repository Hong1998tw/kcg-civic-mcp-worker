export interface Env {
  MCP_ACCESS_KEY?: string;
  AUTH_TOKEN?: string;
  /** Optional dedicated owner login key; existing MCP_ACCESS_KEY remains the fallback. */
  OAUTH_LOGIN_KEY?: string;
  PUBLIC_ORIGIN: string;
  OAUTH_STATE: DurableObjectNamespace;
  /** Set to true only for an explicitly configured local/demo deployment. */
  MCP_ALLOW_ANONYMOUS?: string | boolean;
  CORS_ALLOWED_ORIGINS?: string;
  kcg_civic_data?: R2Bucket;
  [key: string]: any;
}

export interface Provenance {
  source_id: string | number;
  source_url: string;
  source_type: "openapi" | "csv_direct" | "official_web" | "r2" | "cache" | "fallback";
  agency: string;
  retrieved_at: string;
  published_at?: string;
  content_hash: string;
  validation_status?: "passed" | "pending" | "failed";
  snapshot_id?: string;
  coverage?: { scope: string; complete: boolean };
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

export interface RpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}
