# 高雄市公民資料 MCP Worker (kcg-civic-mcp-worker) 開發日誌與架構規範

## 1. 專案現狀與架構亮點
- **專案名稱**：kcg-civic-mcp-worker (v1.0.0)
- **核心功能**：整併高雄市主計預算、主管法規、市議會與市政新聞工具，所有工具採一致的 JSON-RPC 與資料信封格式。
- **資料容錯**：官方端點 ➔ 官方下載資源 ➔ Cloudflare R2 災備，並具備 `provenance` 審計追溯；demo snapshot 必須明確開啟，不會被冒充為官方全集。

## 2. 議會模組升級：ASP.NET WebForms 動態即時請求
針對高雄市議會資訊系統（`cissearch.kcc.gov.tw`）的動態特性，目前採「即時動態請求鏈」，並以 R2 儲存議事錄文字層快取：
1. **GET Token**：無狀態取得動態 `__VIEWSTATE` 與 `__EVENTVALIDATION`。
2. **POST Query**：將屆次、會期與關鍵字送出，解析出核心識別碼 `ProposalSN`。
3. **Detail & Attachments**：透過 `ProposalSN` 串接詳細頁路由與 `GetAttachmentList.ashx` 取得附件清單。
