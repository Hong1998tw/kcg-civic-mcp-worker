# 高雄市議會公開來源全量與可恢復採集

入口為 `src/ingestion/kcc-collector.mjs` 的 `runKccCollection(options, dependencies)`；採集程序獨立於唯讀查詢程序。

| profile | dataset | 來源與完成條件 |
| --- | --- | --- |
| `kcc-proposals-full` | `kcc-proposals` | 官方選單全部屆次、官方導覽全部tab、各自全部頁次。每tab頁序連續、ID無重複、列數等於該tab官方總數且最後頁沒有下一頁，才能完成。 |
| `kcc-meetings-full` | `kcc-meetings` | 官方議事錄索引全部屆次及分頁。每列保留全部PDF版本，不以檔案數冒充索引筆數。 |
| `kcc-proposal-details` | `kcc-proposal-details`、`kcc-proposal-attachments` | 逐筆使用已驗證提案索引的官方加密Detail URL；核對原頁身分、附件官方清單及全部原件後，才發布該筆。 |
| `kcc-meeting-records` | `kcc-meeting-records` | 逐筆取已驗證議事錄索引，下載所有官方PDF版本、確認PDF檔頭與總頁數、保存每頁文字及空文字頁，再發布該筆。 |

```js
import { runKccCollection } from './src/ingestion/kcc-collector.mjs';
const result = await runKccCollection({
  profile: 'kcc-proposals-full',
  root: '/data',
  maxRequests: 25,
  maxPages: 5000,
  maxDurationMs: 80000,
  pageSize: 100,
});
// 同一job以相同profile/root/範圍再呼叫；可依result.continuation_required續段。
```

`periods` 預設從官方議會選單發現；現行 `07` 是高雄市議會代碼。`sessions` 預設從官方屆次選單發現，現行為 `0701`–`0704`。`session` 可指定單一屆次，`keyword` 可限定可驗證的查詢範圍。這些選項及 `pageSize` 共同決定scope；改scope會使用另一份checkpoint，不能宣稱沿用同一全量工作。全量工作應省略sessions/keyword限制。

依賴注入包含 `storeFactory(root)`、`fetchImpl`、`sleep`、`now`、`pdfExtractor(bytes)`；未提供storeFactory時以 `LocalStore(root,{readOnly:false})` 寫入。PDF預設使用既有 `unpdf`，沒有新增套件。注入的PDF擷取器仍須回傳 `total_pages` 與從1開始連續的 `pages:[{page,text}]`，通過相同驗證。

## 分段、原件與發布順序

```text
官方回應
  → 固定官方HTTPS allowlist、單程序每網域至少1秒、HTTP/大小/逾時上限
  → 原始bytes與SHA-256不可變保存
  → exact來源身分／查詢控制／tab頁碼／列數驗證
  → pending-publication.json（精確候選狀態）
  → LocalStore.importSnapshot（累積同scope全部已驗證資料）
  → 核對snapshot收據
  → checkpoint.json成功cursor
```

- `maxRequests` 預設25、`maxPages` 預設5000、`maxDurationMs` 預設80000。上限只限制單段；未到來源終態回 `status:'paused',continuation_required:true`。每次都先讀既有checkpoint，不會每段只發布當批子集。
- 索引續作時取得新WebForms狀態及程序記憶體Cookie，再用官方Go欄位直接跳至下一個未完成頁。Cookie及回應Set-Cookie不進checkpoint、sidecar或回傳值；公開HTML原件保持原始bytes。
- checkpoint放在 `.kcc-collection/<profile>/<scope-sha前24碼>/checkpoint.json`；raw原件在 `.kcc-collection/raw/<sha256>.bin`，並寫入LocalStore content-addressed raw。capture sidecar只含公開來源URL、時間、hash、位元組數及HTTP狀態。
- `pending-publication.json` 保留未確認提交的候選狀態。import失敗或程序中斷後，先重放同一候選快照，確認收據才推進cursor。每個dataset的已確認收據即時寫入pending；若後續dataset失敗，回傳 `commit_state:unknown`、`publication_status:partial`、已確認收據、實際可見筆數及未知dataset，成功cursor維持原位。恢復先讀原生active release：已確認項目一致就略過；未知項目只有在原baseline未變或精確候選snapshot已生效時，才重試或以同snapshot作冪等確認。其他scope已取代active時回 `RELEASE_DRIFT`，不自動覆蓋。
- `.kcc-collection/collector.lock` 阻止同root的KCC程序並行。程序正常結束會移除；被強制終止後需先核對鎖內pid確定原程序已退出，再由工作管理器恢復鎖，不能依時間猜測程序已死。
- 來源總數改變、tab集合改變、頁碼不前進、重複ID、列數不符、來源導向錯誤均回 `blocked`，保留最後成功cursor及已抓原件；不把未知來源當空集合，也不盲目重送原件寫入。
- 完成checkpoint重入及每次回覆前，核對每個已確認dataset的原生active release之dataset、snapshot ID、manifest SHA-256及筆數。不一致回 `RELEASE_DRIFT`、`needs_reconciliation:true`，不以歷史receipt冒稱目前生效。
- enrichment固定依賴已驗證索引snapshot。母集每1000筆分頁均核對同一dataset、snapshot ID、manifest及總數，任一分頁或中途索引更換會 `DEPENDENCY_DRIFT` 停止，不把兩個不同母集默默合併。母集coverage不完整，即使掃完目前母集也只回partial。

## 身分與資料語意

官方Detail URL的 `s` 是加密值，數字 `proposal_sn` 來自索引隱藏欄位。新採集嚴格核對詳情精確欄位 `ctl00$ContentPlaceHolder1$uscAttachment$hidDataSN` 等於該數字，且 `hidDataType=1`；兼容精確 `ctl00$ContentPlaceHolder1$hidProposalSN`；所有存在的官方身分欄位均須唯一、name/id相容且值一致，不能以其中一組正確掩蓋另一組矛盾。`source_identity_field`、`source_proposal_sn`、原始Detail URL及hash共同保存證據。查詢端仍須讀原件核對，不能只信 `source_id_verified` 旗標。

`src/kcc/search.ts` 的Detail URL擷取會先解HTML entity，再切開onclick的引號，避免把結尾 `&#39;` 變成加密參數的一部分。詳情另保存案由、說明、辦法、連署資訊、審查意見、各讀會決議及日期。審查日期位於意見文字之前時，保留後方實際意見。

PDF與附件原件在redirect後再次核對最終URL的父項目ID及精確檔案路徑／query；同官方網域但跳至其他議事錄、提案或檔案也會拒絕發布。

議事錄相同record_id可能有原版與更正版。`pdf_versions` 保存各版本URL、原件hash、頁數及頁文字；主要 `pdf_url/pages` 採官方同列最後一個檔案，以 `selected_version_policy:'last-official-listed-file'` 明示政策，並不宣稱官方已宣告其取代前版。

PDF `coverage.complete` 表示已保存指定範圍原件及逐頁擷取序列，不代表每頁均有可搜尋文字。`text_layer_status` 為 `present/partial/absent`，`empty_text_pages` 明示無可擷取文字頁；沒有執行OCR。`speaker_attribution:'not-inferred'` 表示頁面文字不構成發言者歸屬證據。查詢端應把缺少文字層的限制一併回傳。

## 驗證與已確認界線

執行 `node scripts/test-kcc-ingestion.mjs`。17項測試涵蓋獨立tab完整性、分段接續、HTTP來源失敗、發布失敗不推進cursor、重複頁阻擋、詳情/附件原件跨段保存、多版本PDF續作、HTML entity URL回歸、頁序及空文字層，另重現並阻擋跨ID redirect、矛盾身分欄位、active release替換、母集A1000+B1混讀與雙dataset部分發布。含原生SQLite的別scope保護及「已寫入後拋錯」冪等恢復測試。

2026-10-15真實有界canary證據位於工作區 `../evidence/kcc-ingestion-canary/`：

| 範圍 | 實際結果 |
| --- | --- |
| 提案 `0704/道路` | 首段保存tab1全部41筆；續段25次HTTP請求累積至2208筆（41+4+2163），全部tab頁序／唯一ID／總數通過，scope coverage complete。此結果不等於全歷史所有提案已抓完。 |
| 議事錄 `0704` | 官方660筆，首段保存100筆，全部版本URL已列舉。coverage partial。 |
| 提案128802 | Detail原件、精確附件身分、官方附件清單及1份附件原件hash均已寫入LocalStore並原生讀回。 |
| 議事錄9752 | 官方PDF原件8頁，逐頁文字及原件hash已寫入LocalStore並原生讀回。母集目前100筆，coverage partial。 |

IAB探測回 `Browser is not available: iab`，因此上述真實採集使用有界官方HTTP讀取。全歷史NAS終態、全部detail/附件/PDF以及查詢端完整覆蓋，須由整合工作管理器持續執行同一scope各profile並核對原生回執；這份canary本身不宣稱那些範圍已完成。
