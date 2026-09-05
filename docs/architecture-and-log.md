# 高雄市公民資料 MCP Worker (kcg-civic-mcp-worker) 開發日誌與架構規範

## 1. 專案現狀與架構亮點
- **專案名稱**：kcg-civic-mcp-worker (v0.5.0)[cite: 1]
- **核心功能**：整併高雄市主計預算、主管法規、市議會與市政新聞共 7 項工具，全數通過自動化回歸測試 (7/7 PASS)[cite: 1]。
- **資料容錯**：三層防護機制（KCG OpenAPI ➔ 官方 CSV ➔ Cloudflare R2 災備），並具備完整 `provenance` 審計追溯[cite: 1]。

## 2. 議會模組升級：ASP.NET WebForms 動態即時請求
針對高雄市議會資訊系統（`cissearch.kcc.gov.tw`）的動態特性，後續架構將由「靜態 R2 快照」轉型為「即時動態請求鏈」：
1. **GET Token**：無狀態取得動態 `__VIEWSTATE` 與 `__EVENTVALIDATION`。
2. **POST Query**：將屆次、會期與關鍵字送出，解析出核心識別碼 `ProposalSN`。
3. **Detail & Attachments**：透過 `ProposalSN` 串接詳細頁路由與 `GetAttachmentList.ashx` 取得附件清單。
