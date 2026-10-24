# Enrichment v2 儲存與驗收契約

此文件是程式與資料格式的施工契約；專案目前狀態仍以 MCP 主檔為準。目的為消除逐筆完整前綴快照及整份正文進入 checkpoint 的容量放大，不提高 v1 的 256 MiB 上限、不刪文字、不刪歷史。

## 固定範圍

僅 `kcc-proposal-details`、`kcc-proposal-attachments`、`kcc-meeting-records` 使用 `local-snapshot-v2`。其他 dataset 及 v1 canonical、manifest、已知錯誤雜湊拒絕與 restore 路徑不變。現有 enrichment 容量閘門維持關閉，直到原生容量驗收及獨立審查通過。

每個 v2 描述資料序列化後至多 1 KiB，只含 `id`、官方 `raw_sha256` 與 `envelope_ref`／`payload_ref`／`search_ref`；ref 僅有 SHA-256 及 byte_length，禁止任意路徑／URL。manifest digest 必須綁 v2 版本、dataset、snapshot、coverage、parser／validator 及排序後的描述資料。

## 物件與查詢

- Derived CAS 與官方 raw 分開命名，物件 hash、長度、schema、kind、dataset、record ID 及來源綁定皆驗證；不得把 derived SHA 當官方 raw SHA。每個物件有大小上限、symlink／hardlink／路徑檢查，寫入原子且耐久。
- envelope 保存題名、來源、擷取時間、篩選／排序與完整性欄位。SQLite 保留可驗證鏡像。
- payload 保存完整來源欄位；PDF 每個版本、每頁文字各自一份 derived 物件。舊 `pages`、`pdf_versions[].pages`、`original_versions[].pages` 形狀按需還原，不能重複序列化正文。
- search 是可重建投影，保留舊 title、text、canonical data 的 keyword 語意。固定區塊約 64 KiB，區塊序號、來源、hash及長度可驗。SQLite 鏡像逐塊驗後才決定命中，不能先用 SQL WHERE 跳過未驗資料；中文及跨區塊字詞不可漏。
- query 在同一 SQLite read transaction 驗整份描述資料 manifest及 envelope／搜尋鏡像，只保留有界選中 envelope／refs，最後才讀選中的正文。零命中正文 hydration 必須為 0。
- `kcc_search_meeting_record_content` 先取全域最新最多 15 筆 metadata，再掃各頁；不能先 hydration 1000 筆。`search_kcg_council_interpellations` 串流累計命中，只保留有界 snippets。單案只還原一案，指定頁只讀該頁；零命中仍要保留未索引／partial 與來源證據。
- MCP 名稱、參數、輸出、頁碼／身分證明、官方 URL／raw SHA、缺資料與 partial 契約不變。Word 未抽文與官方未提供原件不冒充 PDF／全文。

## Compact staging 與發布

每個 work／完整 record 個別原子保存；checkpoint 只留固定母集 snapshot／manifest、`committed_cursor`、`prepared_cursor`、staged refs及 receipts。準備完成不等於已提交；每個 HTTP 不重寫累積正文。

詳情每 100 筆或 8 MiB、議事原件每 25 筆或 8 MiB（先達者）發布；跨 HTTP 段累積，每段最多一次發布，終態不足一批仍 flush。每段 25 HTTP／75秒仍是採集限制。

pending 保存固定候選描述 manifest/hash、base releases與各 dataset confirmed／unknown，不複製完整正文。兩個詳情 dataset 都原生讀回成功才推進 committed cursor；已生效部分沿用，失敗只補差額。active／母集漂移拒絕。

舊 checkpoint 遷移先核 active receipt，逐筆轉 refs，同 scope 發布等價 v2；成功前保留舊 checkpoint、已確認 cursor、原 raw與 archives，不能重抓已確認原件或重設工作身分。

## 分工與介面

`local_store_v2` 為 storage API 協調者，先與 `kcc_payload_v2` 鎖定 DerivedStore、prepare／envelope／search／hydrate 的實際函式簽名並通知 root。兩者各自單一寫入；協調用內部訊息，不共同修改同一檔。

- Storage：新增 `src/local/derived-store.mjs`，修改 `src/local/store.mjs`，新增專用 storage tests。新增表／格式欄位，不破壞 v1 collections。提供 v2 import/query/history/restore及按需 hydration／串流頁面搜尋的 API。
- Payload／registry：新增 `src/local/kcc-payload.mjs`，修改 `src/local/registry.mjs`，新增專用 pack／搜尋／相容測試。只依約定 storage API；不改 store 或 derived-store。
- Collector：待 root 交辦後修改 `src/ingestion/kcc-collector.mjs`／測試及獨立 compact staging 模組，使用上述 API。不要同時修改來源索引修復中的 hunk。
- Root：唯一整合者、正式來源寫入者、NAS operator。套件／CI scripts及共同文件由 root 整合；子代理不 commit、不改 NAS／Notion／CF，不建立 CTX。

## 放行測試

1. v1／v2 MCP fixture 結果等價；舊 v1 測試保持通過。
2. 零命中 0 正文 hydration、單頁只讀所需頁、最新大於1000排序、串流 snippets 有界。
3. envelope、搜尋鏡像／區塊順序、payload、原 raw 竄改均拒絕，不能靜默變零命中。
4. 中文、引號、換行、跨區塊字詞與各 filter 不漏／不改語意。
5. batch內中斷、雙dataset部分提交、提交後checkpoint失敗、active／母集漂移、舊checkpoint遷移、跨段不足批次與終端flush。
6. 小 fixture 證發布次數；不要用全量逐批 N² 測試。
7. root 用獨立 1 GiB 容器只建立一次 32,391 案與 2,198 議事最終候選，測 import/query/restore；內容需有不同長度及多版本 PDF，不能全共用一個小 blob。記錄 cgroup peak/OOM、最大 RSS，保留約20%餘裕，再驗實際 query 容器限制。

單份大型 PDF 擷取峰值、真正來源全量終態與人工語義驗收仍各有 Gate，不以描述資料尺寸或合成壓測代替。
