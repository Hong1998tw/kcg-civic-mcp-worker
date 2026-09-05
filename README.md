# 高雄市公民資料 MCP

正式 HTTPS 網址：<https://kcg-civic-mcp-worker.lihong.workers.dev>  
專案名稱：`kcg-civic-mcp-worker`  
MCP Endpoint：<https://kcg-civic-mcp-worker.lihong.workers.dev/mcp>  
版本：`1.0.0`  
平台：Cloudflare Workers + R2

## 連線

正式環境必須使用 Cloudflare Secret `MCP_ACCESS_KEY` 或 `AUTH_TOKEN`。請以 `Authorization: Bearer <token>` 呼叫；路徑 token 與 query token 僅為相容舊客戶端的方式，請避免出現在瀏覽器歷史、日誌或分享連結。

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

工具分為預算、法規、新聞、議會快照與高雄市議會官方即時資料。每一項工具均回傳一致的信封：`status`、`provider`、`updated_at`、`provenance`、`meta`、`data`。

議會提案查詢受官方網站分頁限制，務必依 `total_count`、`current_page`、`page_count` 與 `is_complete` 判斷完整性。議事錄全文工具會從官方 PDF 取文字，並以 R2 儲存文字層快取。

## 本機開發

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run typecheck
npm run dev
```

`MCP_ALLOW_ANONYMOUS=true` 只應用於 localhost；正式環境不應開啟。`MCP_ALLOW_DEMO_DATA=true` 僅供離線測試，demo 資料不是官方全集。

## 部署

```bash
npx wrangler secret put MCP_ACCESS_KEY
npm run typecheck
npm run deploy
```

不要把任何 access key 寫入 Git、文件、測試輸出或對話。
