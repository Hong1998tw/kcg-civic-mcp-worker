/**
 * The provider's KV-shaped storage API backed by strongly consistent DO SQLite.
 * All provider requests run under blockConcurrencyWhile in OAuthState, making
 * authorization-code consumption and refresh rotation atomic across requests.
 * Only the KV operations used by the pinned provider are implemented here.
 */
export class OAuthStorage {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_records (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, expiration INTEGER, metadata TEXT
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS oauth_expiration ON oauth_records(expiration)");
  }

  async get<T = string>(key: string, options?: string | { type?: string }): Promise<T | null> {
    const row = this.sql.exec<{ value: string; expiration: number | null }>(
      "SELECT value, expiration FROM oauth_records WHERE key = ?", key,
    ).toArray()[0];
    if (!row) return null;
    if (row.expiration !== null && row.expiration <= Math.floor(Date.now() / 1000)) {
      await this.delete(key);
      return null;
    }
    const type = typeof options === "string" ? options : options?.type;
    return (type === "json" ? JSON.parse(row.value) : row.value) as T;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    if (typeof value !== "string") throw new TypeError("OAuth storage requires string values");
    const expiration = options?.expiration ?? (options?.expirationTtl !== undefined
      ? Math.floor(Date.now() / 1000) + options.expirationTtl : null);
    this.sql.exec(
      "INSERT OR REPLACE INTO oauth_records (key, value, expiration, metadata) VALUES (?, ?, ?, ?)",
      key, value, expiration, options?.metadata === undefined ? null : JSON.stringify(options.metadata),
    );
  }

  async delete(key: string): Promise<void> {
    this.sql.exec("DELETE FROM oauth_records WHERE key = ?", key);
  }

  async list(options: KVNamespaceListOptions = {}) {
    const limit = Math.max(1, Math.min(options.limit || 1000, 1000));
    const prefix = options.prefix || "";
    const rows = this.sql.exec<{ key: string; expiration: number | null; metadata: string | null }>(
      `SELECT key, expiration, metadata FROM oauth_records
       WHERE key >= ? AND substr(key, 1, length(?)) = ? AND key > ?
       AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?`,
      prefix, prefix, prefix, options.cursor || "", Math.floor(Date.now() / 1000), limit + 1,
    ).toArray();
    const page = rows.slice(0, limit);
    return {
      keys: page.map((row) => ({ name: row.key,
        ...(row.expiration !== null ? { expiration: row.expiration } : {}),
        ...(row.metadata !== null ? { metadata: JSON.parse(row.metadata) } : {}),
      })),
      list_complete: rows.length <= limit,
      cursor: rows.length > limit ? page[page.length - 1].key : undefined,
      cacheStatus: null,
    };
  }

  purgeExpired(): void {
    this.sql.exec("DELETE FROM oauth_records WHERE expiration <= ?", Math.floor(Date.now() / 1000));
  }
}
