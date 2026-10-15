# 高雄市官方法規與新聞在地化採集

`src/ingestion/official-collection.mjs` 提供 `runOfficialCollection(options, dependencies)`，供 NAS 的獨立 ingestion worker 分段執行。n8n 僅送出工作及輪詢；HTML、PDF、checkpoint、SQLite 索引及版本快照皆寫在指定的 `root`，不存進 n8n 資料庫。

## 官方來源與資料範圍

| Profile | 官方母體 | 明細與原件 | 完整性條件 |
| --- | --- | --- | --- |
| `kcg-laws` | [法規體系全部機關分類](https://outlaw.kcg.gov.tw/LawCategoryMain.aspx?type=M) → 各 `LawCategoryContentList.aspx?CategoryID=` 全部分頁 | `LawContent.aspx?id=GL…`、`LawContentSource.aspx?id=GL…`、同站 `Download.ashx` 附件 | 全部分類與頁次窮盡、無重複身分、各分類列數等於官方總數、全部明細與附件驗證通過 |
| `kcg-news` | [最新消息](https://www.kcg.gov.tw/News.aspx?n=F29A02A9D36C47F0&sms=19902EF36D6B551D)及[市政新聞](https://www.kcg.gov.tw/CityNews1.aspx?n=3A379BB94CA5F12D)全部分頁 | `News_Content.aspx?s=` 與 `CityNews_Detail1.aspx?ss=` | 兩來源全部頁次窮盡、每頁身分無重複、所有明細與兩來源官方總數相符 |

法規首頁僅列近六個月最新異動，不能代替完整法規母體。這裡不讀取 `scripts/kcg_laws.json`、`scripts/kcg_news.json` 或其他 legacy seed，也不啟用外部媒體 RSS 或退役新聞專案。

市政新聞採原生 WebForms POST：上一頁官方原始 HTML 提供換頁狀態，由程式重建固定下一頁事件；實際回應必須宣告正確下一頁頁碼。POST 的 parent capture key 留在 checkpoint；表單狀態不另複製至工作佇列，不需登入或 Cookie。兩新聞來源輪流取得索引，避免另一來源必須等待全部最新消息下載完成。

## API 與執行方式

```js
import { runOfficialCollection } from './src/ingestion/official-collection.mjs';

const result = await runOfficialCollection({
  profile: 'kcg-laws',       // 或 kcg-news
  root: '/data',            // NAS container 的實體資料掛載目錄
  maxRequests: 25,          // 每段真正網路請求上限，包含 redirect
  maxRecords: 20,           // 每段新增已驗證明細上限
  maxPages: 10,             // 每段索引頁處理上限
  maxBytes: 8 * 1024 * 1024,// 每個原件上限；包含附件
  timeoutMs: 15000,
  downloadAttachments: true,
  resume: true,
  commit: true,
});
```

`dependencies` 可注入 `storeFactory(root)`、`fetchImpl`、`now` 及 `sleep`，供測試或既有 worker 整合。預設使用 `LocalStore(root, { readOnly: false })`，因此 API 自行關閉該 store。呼叫端需序列化同一 `root/profile` 的寫入。

每段固定至少一秒節流，跨段沿用最後請求時間。只允許來源表列的 HTTPS 主機；每次 redirect 重新驗證，不接受任意外站、HTTP、帳密或 port。`maxRequests` 預設 25、上限 500；`maxRecords` 預設 20、上限 10,000；`maxPages` 預設 10、上限 500。

| 回傳 | 意義與 worker 下一步 |
| --- | --- |
| `status: paused`、`continuation_required: true` | 本段正常結束，還有索引或明細；同一 job 以 `resume: true` 繼續 |
| `status: complete`、`coverage.complete: true` | 整個宣告母體已窮盡且來源總數核對完成 |
| `status: blocked` | 來源結構、身分、總數、大小、權限或連線有實際阻礙；檢查 `error_code`，不盲目重送 |
| `dryRun: true` | 僅回傳 profile 定義，不抓取或寫入 |

正常分段會匯入「累積至今所有已驗證明細」，不是只留下最後一段。任何未完成母體均維持 `coverage.complete: false`；來源總數尚未收齊時為 `null`。發生錯誤時不覆蓋先前已發布快照。沒有明細的分段不建立空成功快照。來源總數變動回報 `SOURCE_DRIFT`。法規及一般新聞 run 維持既有 checkpoint 行為；只有官方新聞的 SOURCE_DRIFT 修復使用下方同 run 索引回合，不以舊快取頁重複卡在原漂移位置。

`resume: false` 開始新的 run，保留既有 raw 與歷史快照。每日排程的新 job 應使用 `resume: false`；同一 job 的下一段才使用 `resume: true`。已完成 run 的 checkpoint 不能當成隔日重新抓取的證據。`kcg-news` 的 SOURCE_DRIFT checkpoint 或已啟動 index_round 會拒絕 `resume: false`，避免在同一工作上重設 run。parser 版本或附件策略變更會拒絕舊 checkpoint，避免混用不同驗證契約。

### 官方新聞來源漂移：同一 run 的索引回合

`prepareNewsIndexRound({ root, expectedCheckpointSha256 })` 是 root-native 的明確遷移 API。它只接受 `profile: kcg-news`、目前 parser v5 checkpoint，且 `state.last_error_code` **精確等於** `SOURCE_DRIFT`。`expectedCheckpointSha256` 必須是 `checkpoint.json` envelope 的 `.sha256` 欄位；API 先驗證此欄位等於 `SHA-256(JSON.stringify(state))`，再比對呼叫端預期值。它不建立新 run、不改 `run_id`、不碰 n8n job key，也不呼叫 `resume: false`。

遷移先把完整舊 checkpoint bytes 以不可覆寫方式保存至 `checkpoint-archives/<archive-bytes-sha256>.json`，同步檔案後原始 bytes 讀回並核 hash；確認後才以原子 rename 寫入新 checkpoint。若呼叫端在結果不明後以同一預期 `.sha256` 重試，API 會核驗 archive 原件並回傳同一回合，不重做遷移。每一輪來源漂移 checkpoint 都可用它當下的 `.sha256` 明確準備下一輪，最多三輪。

新狀態保留 `run_id`、全部 captures／原始 CAS、歷史 snapshot 與目前 active release；另建 `index_round_id`、`index_round_attempt` 和專屬 request-key namespace，重新建立 `messages` 與 `city` 兩個來源的索引佇列。舊 checkpoint 的 `records.length` 留在 `prior_published_count`，所以新的 `record_count: 0` 表示「本索引回合尚未重解析明細」，不表示工作歸零。索引與複核階段不取明細、不發布；未重建的新 records 尚少於原發布數時，發布仍保留原快照。

回合依 `indexing → verifying → frozen → details → complete` 前進。最新消息索引路徑只明確接受 `/News.aspx` 與實測 ASP alias `/news.aspx`；不將路徑全面轉小寫，其他大小寫形式如 `/NEWS.aspx` 仍拒絕。原始 `requested_url`、capture URL 與 entry `index_url` 保留收到的路徑大小寫。索引每頁先驗證固定路徑、`scope`、`n`／`sms`、頁次連續、列數、全體唯一 ID 和正確 `messages:`／`city:` namespace；每頁另存依序排列的 ID、標題、日期、機關（市政新聞另保留類別）digest，以及兩來源首末頁的 capture 證據。完成兩個來源後，以新的 namespaced GET 分別重抓最新消息首頁與市政新聞首頁，核對來源總數及首頁有序 digest；市政新聞末頁證據沿用本輪 WebForms POST 鏈的真實原件，不把尾頁偽裝成 GET。兩次首頁複核都通過後，完整索引 digest 與 capture window 先寫入 checkpoint，才允許明細階段。

`index_round_capture_window` 表示跨分段採集與複核時間範圍，不代表官方同一交易快照。明細階段會先按 receipt 和 CAS hash 讀回已存在的明細 capture，再重新執行 `parseOfficialNews`，不沿用舊 parsed record。若本輪又發生 `SOURCE_DRIFT`，一般 resume 會保留該輪狀態並再次停在錯誤；只有 root 明確以目前 checkpoint SHA 呼叫 API 才開始下一輪。

## 原件、身分與驗證

處理順序為：

```text
官方回應 bytes
  → SHA-256 immutable raw 物件
  → 每次擷取的不可覆寫收據（URL／時間／hash／大小／HTTP／request method）
  → durable checkpoint
  → 結構、官方身分、日期、索引名稱、列數與來源總數檢查
  → 累積 snapshot transaction
  → LocalStore 原生讀回 snapshot_id 與 record_count
```

原件位於 `root/raw/sha256/<前兩碼>/<SHA-256>`；不可覆寫收據位於 `root/staging/official/<profile>/captures/`；目前接續點位於 `root/staging/official/<profile>/checkpoint.json`。新 run 不覆寫歷次 capture 收據。續作會重新驗證收據與 raw hash，不重抓已保存的同一原件。

每次發布或回報 complete 前，重新實讀本 run 全部 CAS 原件（含分類／索引、正文、沿革與附件），核對 SHA-256、實際 byte length 及整份 capture receipt metadata，另檢查每筆 record 所引用的必要原件均有對應的已驗證收據。這包含已存 record 被略過的 resume 情況；缺檔或竄改一律 blocked，不重新下載掩蓋既有證據失效。`raw_validation` 回報核驗範圍與實際驗證的 capture／唯一 raw 數量，metadata 存在不算原件驗證通過。此契約及 URL 正規化修正採 parser v5，舊版 checkpoint 必須重新開 run。

法規分類與附件先依來源 base URL 正規化，因此相對、root-relative 與絕對官方 URL 效果一致。分類容器及附件欄位內的未知格式會 blocked；外站先拒絕，不會默默略過後宣稱完整。

法規保留官方 ID、名稱、機關分類、原日期、解析日期、修正／廢止日期（原件有提供時）、完整正文、條文陣列、沿革、沿革 hash 與附件來源。原 HTML 條號跨標籤拆字仍可正確分條；不將正文中的法條引用誤當條文標題。沒有可確認條號的行政規則保留 `article_no: 全文`、`article_segmentation: unsegmented-full-text`，不自造編號。圖表附件預設下載原件；PDF 要求 `%PDF-` 檔頭，HTML 錯誤頁不能冒充附件。

法規名稱欄的精確官方狀態元素 `ctl00_cp_content_lawheader1_spanCauseCode`（例如「廢/停」badge）屬展示狀態，與真正法規名稱分離。保留 `status_label`、原展示名稱及「廢止/停止適用日期」的 `repealed_or_suspended_at`／原日期；正文與沿革的真正名稱及狀態仍需一致，未標記的字首不任意刪除，也不把「廢/停」擅自判定為其中一種法律狀態。此相容性修正沿用 v5 checkpoint，已保存的明細、raw 與工作身分保持不動。

若官方目前「法規內容」僅保留該法規停止適用／廢止／整編通知，存為 `law_record_type: repeal_notice`、`articles_unavailable: true`、`fulltext_complete: false`、`articles: []`，`notice_text` 與 `full_text` 保存官方通知原文。它仍是可搜尋的官方法規紀錄，不能漏掉後宣稱完整；也不能把通知轉成條文。正常正文則使用 `law_record_type: law_text`、`articles_unavailable: false`、`fulltext_complete: true`。查詢端應在 notice 情況拒絕提供條文全文並回報 `SOURCE_FULLTEXT_UNAVAILABLE` 及官方 URL。

法規的 **collection coverage 只表示目前官方各分類、索引及內容頁已捕獲**，不代表已取得停止適用法規的歷史條文全文。回傳的 `law_text_count` 與 `repeal_notice_count` 分開呈現兩種原件，驗收時需同時看這些數量與 `fulltext_complete`。2026-10-15 NAS r3 的 `GL001565` 原件只有43字停止適用公告，已由該次CAS正文與沿革重新驗證；其歷史條文不可由公告推造。

若官方目前「法規內容」只包含修正公告而非完整整編正文，且官方兩個修正欄位均以「修正＋精確法規名稱＋條號／點次範圍」結尾，歸類為 `law_record_type: amendment_notice`、`articles_unavailable: true`、`fulltext_complete: false`、`articles: []`。必須同時有官方附件，保留公告原文與附件連結；一般未編號正文、名稱後接其他敘述或只含一個修正欄位都不符合例外，仍停止並回報來源結構錯誤。明示空白的沿革容器可保留為 `history_status: not_provided`，但沿革容器本身缺漏仍拒絕。`law_text_count`、`repeal_notice_count`、`amendment_notice_count` 分開呈現三種官方紀錄。

新聞 ID 與來源身分如下，避免兩來源相同 native ID 碰撞：

| 欄位 | 最新消息 | 市政新聞 |
| --- | --- | --- |
| `record.id` / `data.news_id` | `messages:<s>` | `city:<ss>` |
| `source_native_id` | 官方 `s` | 官方 `ss` |
| `source_kind` | `messages` | `city` |
| `source_link` | 原 `News_Content.aspx` URL | 原 `CityNews_Detail1.aspx` URL |

`agency` 與 `publisher` 取自明細的「發布機關」，日期取自明細「發布日期」，分別與索引已提供的欄位比對。完整正文存於 `content`；為相容既有 schema，`content_summary` 同樣保存全文，並標示 `content_summary_kind: official-full-text`，不假裝產生摘要。官方圖片與外站媒體不自動下載；正文與完整原 HTML 都保留。

官方明細確實存在「發布機關：」但內容為空時，保留 `agency`／`publisher` 空字串，標示 `publisher_status: not_provided`、`publisher_source: official-detail-empty`，不推猜新聞局或其他機關。有明示值則為 `publisher_status: provided`、`publisher_source: official-detail`。發布機關欄位整個不存在、正文或日期缺失，仍為結構錯誤並停止；索引有機關但明細空白也保留身分不一致阻擋。NAS r3 的 `city:598182DA152F961C` 即為明示空欄、正文與日期齊全的已驗證實例。

最新消息的 `DC.Subject` 若為精確網站通用值「高雄市政府全球資訊網-中文版」或缺值，以明細正式標題區的可見標題與索引精確核對，保留 `title_source: official-detail-visible-title` 與原 `title_meta_subject`。具體文章 meta 標題仍正常核對；具體 meta、可見標題或索引有真正衝突時停止，不用 fallback 掩蓋。`messages:2E98CCB38C0FDA07` 的 r6 NAS CAS 已證明上述通用 meta 情況，官方 ID／URL、可見標題、日期及機關均一致。

這些檢查證明原件來源、身分與本機內容一致；沒有把 schema 合格當成法規法律效力或新聞主張均已查證。

## 驗證紀錄與限制

執行 `node scripts/test-official-ingestion.mjs` 驗證 17 項既有 parser、原件、法規、新聞及 checkpoint 情境；另執行 `node scripts/test-official-news-round.mjs` 驗證 14 項回合情境，涵蓋來源漂移 gate、checkpoint archive／讀回／冪等重試、同 run identity、分段索引、雙首頁 fresh GET、固定 scope 與 entry namespace、同總數首頁替換拒絕、POST 尾頁證據、舊 detail CAS 重解析、發布保留、最多三輪，以及 `/news.aspx` 跨頁 alias 與 `/NEWS.aspx` 反例。舊 collector 和 index_round 都保留原始 URL 大小寫。測試均使用合成 fixture，不能代替 live authority 證據，也不執行 NAS 全量採集。

2026-10-15 實際官方 canary 已核驗：`GL000020` 的41條完整正文（含跨標籤的第二十八條）、沿革及 PDF；`GL000021` 的15條、沿革及 PDF；最新消息兩則與市政新聞兩則全文，以及市政新聞第2頁 POST。當次兩新聞來源宣告總數為 1,726 + 610 = 2,336；此為擷取時點的觀察值，不是固定設定。bounded canary 均維持 partial coverage，沒有宣稱全站已下載。

[市政行程](https://www.kcg.gov.tw/CitySchedule.aspx?n=5075DEA56BE7DE52&sms=CBE053952D27CC97)另有官方入口；現有 store 無對應市府行程 dataset，未用新聞或議會會議資料替代。議員名錄、委員會及議會日程由 KCC ingestion 負責，本模組未修改其檔案。
