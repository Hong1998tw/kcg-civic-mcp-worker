# NAS 在地化設計與驗收

採用 Node.js 24 容器、NAS 原生磁碟上的 SQLite 與原始檔。資料擷取、儲存與查詢均在 NAS；n8n 負責有界工作的觸發與回執讀回。Cloudflare Worker、R2 與 OAuth Durable Object 不作本機服務的必要依賴。

本文件描述實作與驗收契約。最新專案狀態統一回 [MCP 主檔](https://app.notion.com/p/3d3bd1468054812ba171fd045b46eddd)，接續工作回 [CTX-160](https://app.notion.com/p/3fabd1468054815b8479ce15d7423f10)。

```text
官方公開來源
  → 獨立採集者：固定 profile、限速、逾時、來源白名單
  → 原始檔 SHA-256 + 來源／擷取時間
  → 基本結構驗證與正規化
  → 不可變歷史快照 → SQLite 單交易更新目前版本
  → 唯讀 MCP：只讀本機資料 → 結果 + 來源 + 收錄範圍

n8n → 專用 requests → 單一採集者 → receipts → n8n 讀回同一 job
```

## 責任與儲存

| 元件 | 保存／執行內容 | 寫入權限 |
| --- | --- | --- |
| SQLite | 正規化資料、目前版本、完整性資訊 | 採集者；查詢服務唯讀 |
| 原始檔與歷史快照 | 官方回應原件、雜湊、可回復快照 | 採集者；查詢服務唯讀 |
| n8n 專用交接目錄 | 固定 profile 的 request 與 receipt | n8n 與採集者；不直接開啟語料 SQLite |
| MCP | 原有工具名稱與輸入契約、本機資料查詢 | 無資料寫入、無來源網站外連 |
| Mounted secret | 私網 MCP 的專用 Bearer；只在程序中使用 | 原生安全管理；不進 Git、日誌或一般回執 |

SQLite 必須由同一 NAS 主機的程序操作本機磁碟；Mac 不經 SMB／NFS 開啟這份執行中的 DB。[SQLite 網路檔案系統說明](https://www.sqlite.org/useovernet.html)

本階段採單一 writer、輕量 SQLite，降低常駐服務數。多主機寫入、多個獨立採集者或高並行需求出現後，再評估獨立 PostgreSQL；不共用 n8n 的內部資料庫。

## n8n 的範圍

三個手動試辦工作流（健康、115 年預算、議案單頁）位於使用者的 n8n 個人專案根目錄。它們只寫專用交接子目錄，使用固定 profile 與固定 pilot idempotency key。再次執行會讀回同一 job，避免逾時後產生第二次作用。未知結果須核對原 job 與 store，不自行換 key 重送。

35 秒尚未取得回執時回 `pending`；它代表工作流已結束等待，不代表採集完成。採集者逾時、被中止或可能已提交但回執不明時回 `outcome_unknown`。正常提交還需以唯讀 store 再核 snapshot、筆數及 manifest hash。

交接目錄是同一受信任 NAS 內的程序介面；同 UID 的可寫目錄不提供對惡意 n8n 的獨立身分驗證或防竄改證明。正式驗收另核容器與 SQLite／原始檔，不只相信 n8n 回執。

n8n 的執行紀錄、binary data 或 Data Tables 不作正文語料庫；執行紀錄會被清理，容器路徑也須有持久 volume。[執行紀錄保存](https://docs.n8n.io/hosting/scaling/execution-data/)、[檔案讀寫](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.readwritefile/)

## 查詢與完整性

- 所有查詢使用本機 registry；沒有資料、能力未接通、條件不能證實或原始檔／manifest 雜湊不符時，回明確錯誤。
- 工具目錄有 21 個名稱，實際可用範圍由已驗證資料與 handler 決定。目錄存在不能證明 21 種資料都已收錄。
- 本機命中數、來源宣告總數、回傳數與收錄完整性分開呈現；只取得第一頁不能標成全量。
- 查詢期不下載 PDF、不回寫快取；PDF 原件、逐頁文字與 OCR 應由採集者處理。缺頁／無文字層不得冒稱已有完整逐字稿。
- 來源更新保留新版本與歷史原始檔；單次未命中或網路錯誤不觸發刪除。完整 inventory／刪除證據與 tombstone 流程尚需另驗收。
- 基本結構驗證、人工語義驗證、來源全量覆蓋、NAS 常駐、n8n 真實工作、公網用戶端各有不同 Gate。

## 試辦與正式切換

先執行 `npm run build:local`、`npm run test:local`、採集器與工作佇列測試，再以 Dockerfile.local 在 NAS 建置版本固定的映像。查詢容器使用唯讀資料掛載、私網、專用 Bearer，不發布 host port；採集容器持有資料寫入權與官方網站出站網路。

正式切換前仍須確認：所有需要的來源採集器、分頁與 tab、資料覆蓋／缺漏、備份還原、來源更新與下架、實際用戶端的 HTTPS／認證與工具呼叫。舊 Worker／R2 只有在替代服務及回滾 Gate 通過、且有對應切換授權時才調整或退役。

備份需包含一致的 SQLite、歷史快照、原始檔、版本清單及秘密的原生安全備份。不可只複製執行中的 SQLite 主檔；應使用 SQLite backup，或停止本次 writer、確認 journal 終態後備份，並做還原查詢與 hash 驗證。同 NAS 的第二磁碟不等於異地備援。
