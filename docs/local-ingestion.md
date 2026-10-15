# NAS 在地化採集候選

本 CLI 是獨立於 MCP Worker 的 Node.js 24+ 本機採集入口。n8n 後續只應觸發這裡列出的固定 profile/job，不傳任意網址、查詢 URL、記錄內容或憑證。現在支援的 profile 僅有 `budget-115` 與 `proposals-pilot`；兩者每次最多處理 1 個結果頁。CLI 預設為 dry-run，只有加上 `--run` 才會連線、保存 raw object 並匯入本機 store。

```sh
node scripts/local-collect.mjs --profile budget-115 --root /data/civic-store --max-pages 1
node scripts/local-collect.mjs --profile budget-115 --root /data/civic-store --max-pages 1 --run
node scripts/local-collect.mjs --profile proposals-pilot --root /data/civic-store --max-pages 1 --run
```

`budget-115` 只讀現有登錄資源：民國 115 年、dataset `101174`、resource UUID `6712fdb8-c0ff-4f0c-901f-03023c17e15d`。來源依序限定為 `openapi.kcg.gov.tw` 與 `data.kcg.gov.tw`，並重用 `src/tools/budget.parser.ts`。本 profile 只把一個官方資源整理成摘要記錄；來源未提供可驗證的完整筆數時，`source_total` 保持 `null`、`coverage.complete=false`，因此結果標為 `partial`。

`proposals-pilot` 固定查詢 `cissearch.kcc.gov.tw` 的官方系統屆期代碼 `07`、會期代碼 `0704`、關鍵字「道路」，只解析官方回傳的第一頁，重用 `src/kcc/search.ts` 索引 parser。它會在每一個重新導向步驟檢查 HTTPS 與官方 hostname，並確認查詢條件有出現在官方回應。只有 parser 回傳非空且具流水號與案由的資料列，才會提交；空結果或條件未確認會回報 `blocked`，不會建立空快照。pager 回報總數且單頁涵蓋總數時才可標 `complete`，其餘保留 `partial` 或未知總數。

議案資料的頂層 `period`／`session` 欄位只代表已由官方回應確認的查詢範圍，並帶有 `field_source: "confirmed_query_scope"`；不能解讀為每筆議案原始列本身記載了這兩個欄位。多 tab 時不合併成單一 `source_total`；若官方 pager 明確顯示頁碼且不是第 1 頁，該次採集會阻擋。

網路限制固定為官方 HTTPS hostname allowlist、手動逐跳重新導向檢查、10–12 秒逾時、budget 8 MiB／議案 HTML 4 MiB 上限、每個 hostname 間隔至少 1 秒，以及最多 2 次限速／暫時錯誤重試。profile 來源與查詢條件在程式中固定；CLI 不接受 URL 參數。`--max-pages` 不能高於 profile 自身的 1 頁上限。

每份回應會先以 SHA-256 命名寫入 `<root>/.local-collect-attempts/<profile>/raw/` 與帶來源網址、擷取時間、HTTP 狀態的 sidecar，再呼叫 `LocalStore.putRawObject` 將 raw bytes 寫進本機 content-addressed store。完成基本結構驗證後才呼叫 `LocalStore.importSnapshot`；匯入失敗或 parser 無資料時不切換目前 snapshot，也沒有 cursor 可推進。相同原始內容重跑會沿用 sidecar 中第一次觀測時間，由 store 以相同 snapshot/manifest 回報 `unchanged`；來源 bytes 改變時以新的 snapshot 原子替換目前 dataset collection，不累積重複 record。

`basic_validation: passed` 代表程序檢查通過：來源 URL、raw hash、非空解析資料及必要欄位符合 collector/store 契約。它不代表獨立語義審查；輸出固定保留 `human_semantic_validation: pending`，需要另由人工比對官方原件後才可更新該判斷。

## 來源狀態

| Dataset | Profile | 狀態 | 範圍 |
| --- | --- | --- | --- |
| `kcg-budget-115` | `budget-115` | bounded profile | 登錄資源、單次摘要記錄、coverage 未知時標 partial |
| `kcc-proposals-pilot` | `proposals-pilot` | bounded profile | 固定條件的官方索引第一頁 |
| `kcc-meetings` | — | pending | 尚未有經 bounded 驗證的 collector/parser |
| `kcc-meeting-records` | — | pending | 議事錄 PDF 尚未接入 local ingestion |
| `kcg-laws` | — | pending | 不使用 legacy seed 或未驗證法規來源 |
| `kcg-news` | — | pending | 不使用 legacy seed 或未驗證新聞來源 |

pending dataset 不接受 CLI 執行。若未來啟用的 parser 失敗或回傳空集合，工作必須標為 `blocked`，不能用空成功快照推進狀態。採集結果是有界本機候選，不能宣稱整個資料集已全量遷移，也不會呼叫 R2、啟動排程或部署 Worker。

## 本輪真實來源樣本

2026-10-15 明確執行 `budget-115 --run` 後，LocalStore receipt 為 `imported`，snapshot `budget-115-d950258186ed789f363cd7ff`，manifest SHA-256 `a55a999c4a2158078d9ccbc246c7bb78f5950cf8cccc448bf809c8eed2f41adc`。官方來源 `https://openapi.kcg.gov.tw/Api/Service/Get/6712fdb8-c0ff-4f0c-901f-03023c17e15d` 回應 5,987 bytes，SHA-256 `d61feacdbf4b51d1b3c169dc9556062d3245d97227207f67720ad3248a15d27d`；原生唯讀讀回後重新計算 hash 一致。既有 budget parser 摘要為 29 個主管機關、合計 197,823,502 新臺幣千元，官方總額亦為 197,823,502 新臺幣千元。`legal_status: "adopted"` 沿用既有資源映射，不是採集器新增的法效判斷。Coverage 仍為 `complete=false`、`source_total=null`，人工獨立語義驗證仍為 `pending`。

同日同 profile 再明確執行一次時，官方回應長度仍為 5,987 bytes，但 raw hash 改變，因此 store 匯入新的 snapshot；原生讀回目前 dataset 仍只有 1 筆 record，確認替換快照不累積重複記錄。

首次執行 `proposals-pilot --run` 時，既有 parser 解析出 24 列，但條件讀回得到空字串，因此正確停止提交、回 `blocked/FILTER_NOT_CONFIRMED`。後續直接檢查原始 HTML，發現同頁全站與議案查詢均有 `txtKeyword`，而議案欄位實際已回填「道路」；舊 suffix-first helper 誤取了全站空欄。修正為精確官方 name/id、保留重複與衝突拒絕後，重新跑同一有界查詢成功保存 24 筆，snapshot `proposals-pilot-4e99718f44bf7cf4c699358c`、官方 raw SHA-256 `f3a505a64a58a20acb9d1595da3ca09a7da902d0005a05fe84f20d711c7f00ab`。頁籤數量 `[41,4,2163]`、第一個 pager `1/5`，持續標為 `partial`、`source_total=null`；不能據此宣稱全頁籤已收錄。

## 驗證

使用 Node.js 24+ 執行隔離測試：

```sh
node scripts/test-local-collector.mjs
```

測試覆蓋官方 URL allowlist、私有與非官方重新導向拒絕、symlink 目錄拒絕、逾時、bytes 上限、空 parser 阻擋、query filter/page/tab 驗證、未知 coverage、重跑不重複、registry 同範圍查詢及固定 profile 頁數上限。registry 整合測試以 esbuild devDependency 在記憶體中 bundle，需有專案 dev dependencies。採集器本身優先使用 esbuild；沒有 `node_modules` 時 Node.js 24+ 的 `stripTypeScriptTypes` fallback 也已獨立測過，且不會寫入 `dist`。
