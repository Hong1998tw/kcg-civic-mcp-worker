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

正常分段會匯入「累積至今所有已驗證明細」，不是只留下最後一段。任何未完成母體均維持 `coverage.complete: false`；來源總數尚未收齊時為 `null`。發生錯誤時不覆蓋先前已發布快照。沒有明細的分段不建立空成功快照。來源總數變動回報 `SOURCE_DRIFT`，需檢查後以新 run 重新採集。

`resume: false` 開始新的 run，保留既有 raw 與歷史快照。每日排程的新 job 應使用 `resume: false`；同一 job 的下一段才使用 `resume: true`。已完成 run 的 checkpoint 不能當成隔日重新抓取的證據。parser 版本或附件策略變更會拒絕舊 checkpoint，避免混用不同驗證契約。

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

新聞 ID 與來源身分如下，避免兩來源相同 native ID 碰撞：

| 欄位 | 最新消息 | 市政新聞 |
| --- | --- | --- |
| `record.id` / `data.news_id` | `messages:<s>` | `city:<ss>` |
| `source_native_id` | 官方 `s` | 官方 `ss` |
| `source_kind` | `messages` | `city` |
| `source_link` | 原 `News_Content.aspx` URL | 原 `CityNews_Detail1.aspx` URL |

`agency` 與 `publisher` 取自明細的「發布機關」，日期取自明細「發布日期」，分別與索引已提供的欄位比對。完整正文存於 `content`；為相容既有 schema，`content_summary` 同樣保存全文，並標示 `content_summary_kind: official-full-text`，不假裝產生摘要。官方圖片與外站媒體不自動下載；正文與完整原 HTML 都保留。

這些檢查證明原件來源、身分與本機內容一致；沒有把 schema 合格當成法規法律效力或新聞主張均已查證。

## 驗證紀錄與限制

執行 `node scripts/test-official-ingestion.mjs`。十三項結構與安全測試涵蓋跨段累積、來源總數、raw 先保存、來源身分、redirect allowlist、byte limit、來源漂移保留前段、分散 HTML 標籤條號、附件中斷續作、WebForms 原生 POST 及 namespace、symlink 與 checkpoint 契約，並在完整 law snapshot 後刪除／竄改沿革與附件 bytes、竄改各 receipt metadata 欄位，核對無重新抓取且不得回報 complete；另測三種 URL 形式及外站／未知格式拒絕。測試使用明確的合成結構 fixture，不能代替 live authority 證據。

2026-10-15 實際官方 canary 已核驗：`GL000020` 的41條完整正文（含跨標籤的第二十八條）、沿革及 PDF；`GL000021` 的15條、沿革及 PDF；最新消息兩則與市政新聞兩則全文，以及市政新聞第2頁 POST。當次兩新聞來源宣告總數為 1,726 + 610 = 2,336；此為擷取時點的觀察值，不是固定設定。bounded canary 均維持 partial coverage，沒有宣稱全站已下載。

[市政行程](https://www.kcg.gov.tw/CitySchedule.aspx?n=5075DEA56BE7DE52&sms=CBE053952D27CC97)另有官方入口；現有 store 無對應市府行程 dataset，未用新聞或議會會議資料替代。議員名錄、委員會及議會日程由 KCC ingestion 負責，本模組未修改其檔案。
