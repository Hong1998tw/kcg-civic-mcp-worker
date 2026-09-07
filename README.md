# 高雄市公民資料 MCP

正式 HTTPS 網址：<https://kcg-civic-mcp-worker.lihong.workers.dev>  
專案名稱：`kcg-civic-mcp-worker`  
MCP Endpoint：<https://kcg-civic-mcp-worker.lihong.workers.dev/mcp>  
版本：`1.0.0`  
平台：Cloudflare Workers + R2

## 連線

正式環境必須使用 Cloudflare Secret `MCP_ACCESS_KEY` 或 `AUTH_TOKEN`，且只接受 `Authorization: Bearer <token>`；路徑與 query token 不再支援。

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

`MCP_ALLOW_ANONYMOUS=true` 只應用於 localhost；正式環境不應開啟。人工 demo/seed 資料不會由正式查詢路徑讀取。

## 部署

```bash
npx wrangler secret put MCP_ACCESS_KEY
npm test
npm run deploy
```

不要把任何 access key 寫入 Git、文件、測試輸出或對話。
