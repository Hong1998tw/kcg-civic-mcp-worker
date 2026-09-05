# 高雄市公民資料 MCP 專案開發與部署日誌 (kcg-civic-mcp-worker)

- **雲端正式網址**：https://kcg-civic-mcp-worker.lihong.workers.dev
- **正式 MCP Endpoint**：https://kcg-civic-mcp-worker.lihong.workers.dev/mcp
- **專案名稱**：kcg-civic-mcp-worker
- **目前版本**：v1.0.0
- **Cloudflare Deployment Version ID**：以 Cloudflare 最新部署回傳值為準；本 repository 不保存 access key 或部署密鑰。

## 1. 核心功能與工具清單
目前整併 21 項工具至 `TOOL_REGISTRY`，包含：
1. `get_kcg_budget_summary`
2. `search_kcg_laws`
3. `get_kcg_law_detail`
4. `get_kcg_council_meetings`
5. `search_kcg_council_interpellations`
6. `get_kcg_latest_news`
7. `search_kcg_news`
8. `kcc_search_proposals`（即時 ASP.NET WebForms 議案檢索）
9. `kcc_get_proposal`（結構化解析議案詳情與審議進度）
10. `kcc_get_attachments`（即時取得議案附件下載清單）
11. `kcc_search_meeting_records`、`kcc_get_schedule`、`kcc_get_meeting_record`
12. `kcc_search_meeting_record_content`（議事錄 PDF 文字層與 R2 快取）
13. `kcc_get_councilor`、`kcc_get_councilor_proposals`、`kcc_get_proposal_result`
14. `kcc_search_temporary_proposals`、`kcc_search_committees`、`kcc_search_speeches`
15. `kcc_get_proposal_relations`

## 2. 驗收狀態
- **TypeScript 嚴格編譯**：使用 `npm run typecheck`。
- **安全性**：正式環境無密鑰時拒絕連線；SSE endpoint 不再把 token 寫入 event URL；議案詳情與議事錄 PDF 僅允許 `cissearch.kcc.gov.tw`。
- **資料完整性**：議案搜尋回傳 `returned_count`、`total_count`、`current_page`、`page_count`、`is_complete`；官方分頁未完整時會明確告知，不把第一頁當成全集。
- **資料備援**：官方端點失敗時使用 R2；demo snapshot 僅在 `MCP_ALLOW_DEMO_DATA=true` 明確開啟時使用，且 provenance 標示為 `fallback`。
