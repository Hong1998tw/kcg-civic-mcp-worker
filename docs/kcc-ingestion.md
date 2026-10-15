# 高雄市議會公開來源全量與可恢復採集

入口為 `src/ingestion/kcc-collector.mjs` 的 `runKccCollection(options, dependencies)`；採集程序獨立於唯讀查詢程序。

| profile | dataset | 來源與完成條件 |
| --- | --- | --- |
| `kcc-proposals-full` | `kcc-proposals` | 官方選單全部屆次、官方導覽全部tab、各自全部頁次。每tab頁序連續、ID無重複、列數等於該tab官方總數且最後頁沒有下一頁，才能完成。 |
| `kcc-meetings-full` | `kcc-meetings` | 官方議事錄索引全部屆次及分頁。每列保留全部官方原件類型及版本，不以檔案數冒充索引筆數。 |
| `kcc-proposal-details` | `kcc-proposal-details`、`kcc-proposal-attachments` | 逐筆使用已驗證提案索引的官方加密Detail URL；核對原頁身分、附件官方清單及全部原件後，才發布該筆。 |
| `kcc-meeting-records` | `kcc-meeting-records` | 逐筆取已驗證議事錄索引，保存所有原件；PDF確認檔頭、總頁數及逐頁文字，其他格式明示未索引，再發布該筆。 |

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

PDF `coverage.complete` 需母集完整、原件及逐頁擷取通過，且沒有已知未索引原件或空文字頁；不代表已完成文字語意校對。`archive_complete` 另外表示原件歸檔完整，與全文完整性分開。`text_layer_status` 為 `present/partial/absent`，`empty_text_pages` 明示無可擷取文字頁；沒有執行OCR。`speaker_attribution:'not-inferred'` 表示頁面文字不構成發言者歸屬證據。查詢端應把缺少文字層的限制一併回傳。

## 驗證與已確認界線

執行 `node scripts/test-kcc-ingestion.mjs`。27項測試涵蓋獨立tab完整性、分段接續、HTTP來源失敗、發布失敗不推進cursor、重複頁阻擋、詳情/附件原件跨段保存、多版本PDF續作、HTML entity URL回歸、頁序及空文字層，另重現並阻擋跨ID redirect、矛盾身分欄位、active release替換、母集A1000+B1混讀與雙dataset部分發布。含原生SQLite的別scope保護及「已寫入後拋錯」冪等恢復測試。

2026-10-15真實有界canary證據位於工作區 `../evidence/kcc-ingestion-canary/`：

| 範圍 | 實際結果 |
| --- | --- |
| 提案 `0704/道路` | 首段保存tab1全部41筆；續段25次HTTP請求累積至2208筆（41+4+2163），全部tab頁序／唯一ID／總數通過，scope coverage complete。此結果不等於全歷史所有提案已抓完。 |
| 議事錄 `0704` | 官方660筆，首段保存100筆，全部版本URL已列舉。coverage partial。 |
| 提案128802 | Detail原件、精確附件身分、官方附件清單及1份附件原件hash均已寫入LocalStore並原生讀回。 |
| 議事錄9752 | 官方PDF原件8頁，逐頁文字及原件hash已寫入LocalStore並原生讀回。母集目前100筆，coverage partial。 |

IAB探測回 `Browser is not available: iab`，因此上述真實採集使用有界官方HTTP讀取。全歷史NAS終態、全部detail/附件/PDF以及查詢端完整覆蓋，須由整合工作管理器持續執行同一scope各profile並核對原生回執；這份canary本身不宣稱那些範圍已完成。


## 2026-10-15 NAS r3 全量來源差異與相容續作

真實全量枚舉得到提案32391筆、議事錄2198筆。初版實作在0701提案tab1第5頁碰到來源排序不穩定，以及早期議事錄只有Word原件的列；這兩種情況都不能靠略過資料或降低完整性標準處理。

### 提案來源分頁不穩定

NAS原件證明tab1總數1561，第4頁末尾的45052、45050（案號空白）又出現在第5頁開頭。後續相同官方查詢回傳另一組第5頁排序；因此目前證據支持官方分頁排序跨請求不穩定，而不是本機重送同頁。沒有把排序原因推定為已讀過的官方SQL實作。

提案碰到同tab跨頁重複ID時，改用官方Go對**該tab**要求單一回應完整列舉，限定最多20000列、64 MiB、25秒。只有以下條件全部成立才接受：

- period、session、meeting、keyword控制項均與原query一致；tab集合及每個tab總數不變。
- 指定tab實際回傳page1/1、pageSize等於官方total、沒有下一頁。
- 在KCC parser邊界先數原始HTML資料列及ID；同一回應有重複ID就拒絕，不沿用其他TS consumer的Map去重語意。原始row count、正規化row count與唯一ID數均精確等於官方total。
- 原先已成功保存的ID全部包含於完整回應，而且既有案由、案號、類別、提案者、狀態及詳情URL保持一致。
- 新ID沒有出現在其他屆次或tab；發布累積快照與核對原生收據成功。

成功發布完整tab後立刻以paused結束該段；下一段重新GET/query才處理其他tab，避免完整回應的大pageSize被複製到一般16 MiB請求。此恢復策略僅適用已驗證的提案路徑；議事錄碰撞仍blocked。

既有records及其raw hash／取得時間保持原樣；原pages_proof及next_page不重置。額外的 `tab.reconciliation` 保存 `single-response-complete-tab-v1` 策略、觸發原因、原cursor、原頁數與筆數，以及完整回應bytes/hash/row count/unique count/ID序列hash。若任一條件無法證明，就保持原成功cursor並blocked，不把去重後的部分集合宣稱完整。

此變更相容既有checkpoint版本與scope。NAS的400筆／4頁、next_page5及原snapshot receipt可直接由同job接續；不需要刪checkpoint、改scope或重建資料。當相同page5的新官方回應不再碰撞，會正常續到500筆／next_page6；仍保留原400。

### 議事錄非PDF原件

0701第一個100筆回應的第42列record1449只提供 `.doc` 原件。該列的 `hidDataSN=1449` 與官方 `/MeetingRecord/1449/` URL一致，應計入完整100列與2198母集。

索引保存 `original_files:[{download_url,file_type}]`、`original_availability`、`pdf_urls`。純Word列的pdf_url為null、pdf_urls為空陣列，並明示 `content_index_status:'unindexed_non_pdf'`，不將Word連結偽裝成PDF。

`kcc-meeting-records` 保存全部原件；每個 `original_versions` 項目含source_url、download_url、raw_sha256、byte_length、file_type。目前已驗證非PDF格式限定DOC：須通過完整8-byte CFBF magic `d0cf11e0a1b11ae1`，並拒絕HTML內容（即使HTTP 200及application/octet-stream）。通過後保存 `format_validation:{status:'passed',validation_version:'cfbf-magic-8-v1',detected_container:'CFBF'}`；這只驗證容器簽章，不宣稱已解析Word內容。`extraction_status:'unsupported_text_extraction'`，不執行Word抽文或OCR。DOCX、ODT及其他未驗證格式回 `ORIGINAL_FORMAT_UNSUPPORTED`；raw仍先保存，但不發布originals_complete或archive_complete。主要record的source_url/raw_sha256指向實際已保存的同record原件；若有PDF則主要pages仍選最後官方列出的PDF。新metadata包含：

| 欄位 | 語意 |
| --- | --- |
| `originals_complete:true` | 該索引列已列出的所有原件均保存。 |
| `content_index_status:'unindexed_non_pdf'` | 純非PDF列已歸檔，文字尚未索引。 |
| `content_index_status:'partial_text_layer'` | 有PDF，但仍有非PDF原件或空文字頁未索引。 |
| `fulltext_complete:false` | 不能將此列當成已完整全文檢索。 |
| `original_versions` | 所有類型原件及其實際保存證據。 |
| `pdf_versions` | 僅PDF版本的原件與逐頁文字。 |

掃完母集但仍有非PDF／無文字頁時，profile回 `status:'partial'`、`source_exhausted:true`、`archive_complete:true`（母集也須完整）、`fulltext_complete:false` 與 `unindexed_records`；不為了只收PDF而減少母集。查詢端必須回傳未索引限制，不能把無文字命中解讀為完整零結果。舊work中已保存的PDF版本可用既有pdf_url補足原件metadata後接續，原始bytes不變。

### 真實與受控驗收證據

本輪僅唯讀取得NAS公開checkpoint/raw；所有修復canary寫在本機 `../evidence/kcc-real-r3-diagnosis/`，沒有重啟NAS job或改NAS資料。

| 驗收 | 實際結果與界線 |
| --- | --- |
| `live-400-checkpoint-recovery-result.json` | 等價重建原NAS400筆snapshot，原manifest完全一致；真官方page5續到500筆、next_page6，原400個record JSON保持不變。 |
| `controlled-collision-live-recovery-result.json` | 只對衝突page5受控重播未改動的NAS官方原件，其他3次請求均為真官方HTTP；實際全tab回應1561筆／1561唯一ID，涵蓋原400，tab1 complete、next_page5及4頁proof保留。這不是宣稱新請求再次觀察到相同衝突。 |
| `live-proposals-0701-tab1-complete.html` | 真官方單回應完整tab共3333858 bytes、page1/1、row count=unique count=source total=1561。 |
| `live-meetings-first100-result.json` | 從NAS原0筆checkpoint接真官方0701首100列，100筆均保存；包含Word-only 1449，沒有略過第42列。 |
| `live-doc1449-original-archive-result.json` | 精確1449單列canary：官方Word原件61952 bytes、CFBF檔頭d0cf11e0a1b11ae1、SHA-256為6128dad39052368289677d17e502b7ce2d8a66f96931686c39508df4666e9529；LocalStore原生讀回。archive_complete=true，全文partial且未索引。此canary不等於2198筆均已完成。 |
| `regression-tests.log` | 21項測試通過，包含不完整恢復拒絕、既有cursor/records保留、Word-only計數、非PDF原件歸檔及PDF/Word混合時全文partial。 |


### 獨審補強與既有checkpoint

2026-10-15獨立審查的四組P1均有實際collector路徑測試：

- 大於16 MiB的完整tab回應成功後即yield；下一段fresh GET/query可完成後續tab，不沿用前tab全量尺寸。
- 原HTML實際4列、ID為100/100/101/102而total為3時，以 `DUPLICATE_SOURCE_ROW` 拒絕；不讓TS Map去重後的3列成為完整性證明。
- `assertQuery` 對period/session/meeting/keyword核對精確、唯一的官方name/id，拒衝突身分或多控制項；期望空值時仍要求控制項存在。pager pageSize亦採同一singleton規則。缺少空keyword/meeting或09與07兩個period控制項均會blocked。
- DOC的HTML/octet-stream、錯誤或不完整CFBF簽章以及未驗證DOCX/ODT，raw保留、原件完成判斷拒絕。

checkpoint版本、scope、已成功records及cursor相容，不重置NAS原400。reconciliation成功後的新paused邊界沿同job續作即可。舊checkpoint／work已有DOC原件但缺格式驗證metadata時，先從原生CAS讀回相同hash、補驗CFBF；通過才發布補充metadata，原件bytes、raw hash及cursor不變。驗證失敗保留既有證據並blocked，不把舊弱驗證當新格式通過。

`regression-review-followup.log` 記錄27項測試通過。`review-followup-native-proof.json` 記錄真DOC1449由舊checkpoint進行CAS補驗：0次HTTP、cursor1、61952 bytes及原hash保持一致；真官方1561筆完整回應亦以新邊界重驗原始rows=unique IDs=正規化rows=total=1561，精確singleton查詢控制通過。本輪仍未修改NAS或啟動job。
