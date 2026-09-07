# 高雄市公民資料 MCP

正式 HTTPS 網址：<https://kcg-civic-mcp-worker.lihong.workers.dev>  
專案名稱：`kcg-civic-mcp-worker`  
MCP Endpoint：<https://kcg-civic-mcp-worker.lihong.workers.dev/mcp>  
版本：`1.1.0`  
平台：Cloudflare Workers + R2 + SQLite Durable Object

## 連線

ChatGPT 自訂連接器請填入上述 `/mcp` 網址，驗證類型選 **OAuth**。支援公開 discovery、CIMD 與 Dynamic Client Registration；使用動態註冊時不必預填 Client ID 或 Client Secret。授權頁輸入擁有者的既有 `MCP_ACCESS_KEY`（若另設 `OAUTH_LOGIN_KEY`，則使用後者），確認後回到 ChatGPT。擁有者金鑰不會傳給 ChatGPT。

CLI 仍可使用 Cloudflare Secret `MCP_ACCESS_KEY` 或 `AUTH_TOKEN` 作為 Bearer。所有 MCP 憑證只接受 `Authorization` header；路徑與 query token 不再支援。

```json
{
  "mcpServers": {
    "高雄市公民資料": {
      "url": "https://kcg-civic-mcp-worker.lihong.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
    }
  }
}
```

## 功能

工具分為預算、法規、新聞與高雄市議會資料。法規及新聞只讀取具有 immutable manifest、內容雜湊及 passed validation 的 release；沒有可信快照時會明確失敗。

議會提案查詢受官方網站多 tab 與分頁限制，務必依 `tab_counts`、`total_count`、`current_page`、`page_count` 與 `is_complete` 判斷完整性。議事錄全文工具只讀既有且身分驗證通過的 R2 文字層，cache miss 只在該次請求記憶體內解析，不會寫入 R2。日程、即時議員／委員會名錄、臨時提案、發言歸屬與議案關聯在正式來源完成前會回 `FEATURE_UNAVAILABLE`。

## 本機開發

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run typecheck
npm run dev
```

本機也需 Bearer 驗證；`MCP_ALLOW_ANONYMOUS` 不會繞過新版 OAuth 驗證。Wrangler 本機開發須將 `PUBLIC_ORIGIN` 覆寫為實際本機 origin。人工 demo/seed 資料不會由正式查詢路徑讀取。

## OAuth 與驗證邊界

- Authorization Code + PKCE S256；禁止 implicit、plain PKCE 及 token exchange grant。
- Scope：`mcp:read`，選用 `offline_access`；access token 1 小時、refresh token 30 天並輪替，可於 `/oauth/token` 撤銷。
- 嚴格綁定 client、redirect URI 與 `/mcp` resource；CSRF cookie、單次 consent、授權碼原子消耗、IP 速率限制。
- OAuth 狀態放在單一 SQLite Durable Object，以序列化請求避免 KV 最終一致性造成的授權碼競爭。工具輸入與資料擷取不經此物件；R2 查詢仍唯讀。
- 官方 MCP SDK Streamable HTTP，JSON response，協定由 SDK 協商（目前最高 `2025-11-25`）。不提供舊式 SSE；GET `/mcp` 驗證後回 405。
- `npm run test:oauth` 在真實本機 workerd／SQLite 執行安全回歸；`node scripts/test-oauth.mjs --production` 使用既有 Keychain 憑證測試正式環境，且不輸出金鑰或 token。
- 自動測試不跟隨 ChatGPT callback，不能取代真實 ChatGPT 授權及工具呼叫的驗收。

`oauth-v1` 是新增 SQLite Durable Object 的 migration；部署保留既有 R2 與 secrets。新增 DO 請求、SQLite 儲存及清理 alarm 會產生用量，實際費用以 Cloudflare 帳務為準。回退程式碼前須確認 Durable Object migration 相容性，不應刪除 OAuth 狀態或輪替既有秘密來代替回退。

## 部署

```bash
npx wrangler secret put MCP_ACCESS_KEY
npm test
npm run deploy
```

不要把任何 access key 寫入 Git、文件、測試輸出或對話。
