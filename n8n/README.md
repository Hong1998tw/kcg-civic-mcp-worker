# NAS 手動編排來源

此目錄保存已通過 n8n Workflow SDK 驗證的工作流原始碼。實際執行狀態與 execution/job 回執以 n8n／NAS 原生來源為準，專案狀態回 MCP 主檔。

- `00-health`、`01-budget-115`、`02-proposals-pilot` 保留原有界試辦。
- `03-full-migration` 提交六種固定官方 profile；詳情與議事原件需等目前完整母集，依同一 job ID 分段續作。

全部使用手動觸發，不包含排程、任意 URL／SQL 或秘密。工作流以 n8n 可見路徑 `/data/storage/kcg-civic-jobs` 交接；NAS writer 將同一主機目錄掛載至 `/jobs`。目錄需要兩端執行 UID 可讀寫，語料與 OAuth DB 不掛入 n8n。

固定冪等鍵用於同一次遷移。重按只查原工作，不會重新下載已完成工作。`queued`、`running` 或 n8n 節點成功只表示編排狀態；資料完成必須核 NAS 終態、當前 snapshot、筆數、coverage 與原件 hash。需要另一輪來源更新時，先核原任務與 checkpoint，再按契約裁決範圍，避免盲換 key。

工作流修改需重新經原生 SDK 驗證、寫入、讀回及手動執行驗收。`scripts/test-local-jobs.mjs` 使用本目錄真實 Code 內容驗證檔案佇列整合，CI 不依賴 repo 外的工作目錄。
