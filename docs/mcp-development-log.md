# 高雄市公民資料 MCP 專案開發與部署日誌 (kcg-civic-mcp-worker)

- **專案名稱**：kcg-civic-mcp-worker
- **目前版本**：v0.5.0[cite: 1]
- **雲端正式網址**：https://kcg-civic-mcp-worker.lihong.workers.dev[cite: 1]
- **正式 MCP Endpoint**：https://kcg-civic-mcp-worker.lihong.workers.dev/mcp[cite: 1]
- **Cloudflare Deployment Version ID**：bda43ff8-cea9-4870-8305-1a62988b84df[cite: 1]

## 1. 核心功能與工具清單
已成功整併 10 項核心公民與議會工具至 `TOOL_REGISTRY`，包含最新上線的高雄市議會即時動態檢索工具：
1. `get_kcg_budget_summary`[cite: 1]
2. `search_kcg_laws`[cite: 1]
3. `get_kcg_law_detail`[cite: 1]
4. `get_kcg_council_meetings`[cite: 1]
5. `search_kcg_council_interpellations`[cite: 1]
6. `get_kcg_latest_news`[cite: 1]
7. `search_kcg_news`[cite: 1]
8. `kcc_search_proposals`（即時 ASP.NET WebForms 議案檢索）
9. `kcc_get_proposal`（結構化解析議案詳情與審議進度）
10. `kcc_get_attachments`（即時取得議案附件下載清單）

## 2. 驗收狀態
- **本機端對端整合測試 (5/5 PASS)**：`initialize`、`tools/list`、`kcc_search_proposals`、`kcc_get_proposal`、`kcc_get_attachments` 全數通過[cite: 1]。
- **TypeScript 嚴格編譯**：`npx tsc --noEmit` 驗證 0 錯誤[cite: 1]。
- **Production Deployment**：已成功透過 `npx wrangler deploy` 上線，並完成 `AUTH_TOKEN` 雲端密鑰安全綁定[cite: 1]。
