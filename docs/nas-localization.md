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

worker 對單次 collector 子程序使用固定 900,000 ms（15 分鐘）框架時限，涵蓋子程序內的擷取、耐久儲存、發布及原生讀回；時限到達、程序被殺或退出結果不明仍須回 `outcome_unknown` 並依原 job reconcile。HTTP 採集維持 collector 自身每段最多 25 requests／75 秒的界線；這個 request 界線不會截斷之後的本機驗證與發布。NAS R9 全規模 32,391 筆一次匯入實測，`kcc-proposal-details` 花 139,737 ms、`kcc-proposal-attachments` 花 145,652 ms；同一詳情批次依序驗證並發布兩個 dataset 至少需要約 285 秒，因此 180 秒 worker 時限不足。

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

## 可攜式 NAS Compose 模板

`compose.nas.yaml` 是可攜式角色與隔離設定模板，供 NAS 本機環境填入實際路徑與既有 tunnel network 名稱後檢查。`jobs` 設定 1200 秒停止寬限，讓 worker 收到停止訊號後有時間等待 collector 子程序完成或達到固定時限，並完成必要的本機讀回；此值不改變 collector 的 HTTP 分段預算。`compose.local.yaml` 目前只有唯讀查詢服務，沒有 `jobs` role，因此不設定 worker 停止寬限。模板不代表目前 NAS 的即時部署狀態；專案狀態、實際部署與收錄範圍仍以本文件開頭所列 MCP 主檔與 CTX 為準。

| 角色 | 本機資料與網路權限 | 容器隔離 |
| --- | --- | --- |
| `jobs` | `data` 與 `queue` 可寫；加入 `ingestion` 官方來源採集網路 | UID 1000、唯讀根檔案系統、1.5 CPU、1024 MiB、1200 秒停止寬限 |
| `query` | `data` 唯讀、`auth` 可寫、Bearer 與 owner key 以唯讀檔案 secret 注入；只加入 `local_private` 內部網路 | UID 1000、唯讀根檔案系統、384 MiB；沒有 host port |
| `ingress` | 沒有資料 volume 或 secret；同時加入 `local_private` 與既有 tunnel network，以 `kcg-civic-ingress` alias 提供固定 Host 入口 | 可選 `tunnel` profile、UID 1000、唯讀根檔案系統、`cap_drop: ALL`；沒有 host port |

三個服務共用 `CIVIC_LOCAL_IMAGE` 指定的同一映像。模板沒有 `build` 區塊；先在 NAS 本機明確建置 `Dockerfile.local`，再由 Compose 使用本機映像，避免隱性拉取或在 NAS 上改用不同來源建置。

| Compose 變數 | 用途 |
| --- | --- |
| `CIVIC_LOCAL_IMAGE` | 本機建立並供三個角色共用的映像標籤 |
| `CIVIC_DATA_DIR` | NAS 本機原生檔案系統上的資料目錄；禁止指向 SMB／NFS 掛載 |
| `CIVIC_AUTH_DIR` | NAS 本機原生檔案系統上的私有 OAuth SQLite 目錄 |
| `CIVIC_QUEUE_DIR` | NAS 本機原生檔案系統上的工作佇列目錄 |
| `CIVIC_MCP_ACCESS_KEY_FILE` | MCP Bearer key 的私有檔案路徑參照 |
| `CIVIC_OAUTH_OWNER_KEY_FILE` | OAuth owner login key 的獨立私有檔案路徑參照 |
| `CIVIC_PUBLIC_HOST` | OAuth issuer 與 ingress 使用的精確公開 hostname |
| `CIVIC_TUNNEL_NETWORK` | 已存在 Cloudflare Tunnel Docker network 的名稱 |
| `CIVIC_ENRICHMENT_ENABLED` | 預設 `false`；`kcc-proposal-details` 與 `kcc-meeting-records` 的容量閘門 |

大量 `kcc-proposal-details` 與 `kcc-meeting-records` 工作先維持容量暫停。`CIVIC_ENRICHMENT_ENABLED` 未設定或設為 `true` 時，worker 保持既有行為；Compose 範本預設提供 `false`，此時 worker 驗證 request 後會把這兩類工作留在同一 job 的 processing/progress 狀態，標記 `held_capacity_review` 與 `ENRICHMENT_STORAGE_UPGRADE_REQUIRED`，不建立 terminal receipt，也不啟動採集器，並繼續處理其他 profile。只有在 compact/batch 儲存設計通過容量驗證後，才將該設定改為 `true`。此閘門不代表詳情、PDF 或完整資料已收錄。

以上路徑、image 標籤、hostname 與 network 名稱由每台 NAS 的本機環境提供，不應把實際 NAS 路徑或秘密值提交到 repo。Bearer key 與 owner login key 是不同用途、不同檔案；Compose 只將檔案掛載為唯讀 secret，不使用 `MCP_ACCESS_KEY` 之類的明文環境值。兩個 secret 檔由 UID 1000 擁有，權限限制為該 UID 可讀；auth 目錄由 UID 1000 擁有且維持私有目錄權限。

資料目錄只由 `jobs` 寫入，`query` 以唯讀方式開啟；SQLite/OAuth 狀態留在獨立 `auth` 目錄，工作 request/receipt 留在 `queue`。n8n 來源工作流在 repo 的 `n8n/` 目錄；執行時需將同一 NAS-native queue 目錄掛載到 worker 的 `/jobs` 與 n8n 設定的工作流可見路徑。n8n 不掛載語料資料或 OAuth DB。完整官方原始檔與供查詢使用的全文索引是不同產物：索引可支援搜尋，但不能替代原件、來源雜湊或完整性驗證。

`query` 僅接 `local_private`，該網路設為 `internal: true`；官方來源出站只由 `jobs` 經 `ingestion` 網路執行。`ingress` 僅連到 query 與既有 tunnel network，固定轉送至 `http://query:8787`，監聽容器內 `8788`。Tunnel origin 應使用該服務的 `kcg-civic-ingress` alias、保留 `CIVIC_PUBLIC_HOST` 作為 Host，並選擇啟用 `tunnel` profile。模板不發布任何 host port。

Query 的 `OAUTH_ISSUER_URL` 固定由 `https://${CIVIC_PUBLIC_HOST}` 組成；owner consent 頁面由同一 issuer 提供。支援的 MCP OAuth 用戶端由伺服器端 SDK 執行授權碼與 PKCE 流程。直接從另一個網站 origin 以瀏覽器跨來源呼叫 MCP 尚未提供 CORS 支援。健康探測使用 Node 原生 `node:http` 的 `http.get`，明確傳入 `Host: ${CIVIC_PUBLIC_HOST}`；不要用 `fetch` 設定自訂 Host，該探測方式可能忽略覆寫而得到 403。

`Dockerfile.local` 的映像建置與 Compose 啟動分開執行。設定本機必要變數與唯讀 secret 檔後，先在 shell 匯出同一個 `CIVIC_LOCAL_IMAGE` 並建置映像；Compose 則從當前環境或未追蹤的本機 `.env` 讀取其他變數。檢查 Compose 展開結果；只有在核對來源目錄位於 NAS 本機原生檔案系統、external tunnel network 已存在且 UID 權限正確後，才執行服務更新：

```sh
docker build -f Dockerfile.local -t "$CIVIC_LOCAL_IMAGE" .
docker compose -f compose.nas.yaml --profile tunnel config --quiet
```

OAuth 備份需同時保存可一致還原的 `auth` SQLite 狀態與 Proton Pass 中的秘密參照及復原資訊。不要只複製執行中的 `oauth.sqlite` 主檔，也不要將 Bearer 或 owner key 值寫入 `.env`、Compose、repo、日誌或一般備份說明。備份後要在隔離位置驗證 SQLite 還原與兩個秘密參照的安全取回流程；此流程不改變本文件所列唯一專案狀態來源。

子程序退出後，worker 還會獨立讀回目前 release；這一步在 900 秒子程序計時之外。1200 秒容器停止寬限額外配置約 300 秒給父程序讀回與回執落盤，讀回時程以全規模查詢驗收衡量。
