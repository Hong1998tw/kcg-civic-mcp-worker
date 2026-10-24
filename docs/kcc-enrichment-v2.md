# KCC enrichment v2 staging

## 生產路由與相容入口

`src/ingestion/dispatch.mjs` 對 `kcc-proposal-details` 與 `kcc-meeting-records` 固定呼叫 v2 enrichment。`parseDispatchArgs` 不接受格式選擇參數，因此 n8n request 無法切回 v1。既有 `runKccCollection`／`runKccCollectionV1` 保留為測試及直接程式呼叫的 v1 相容入口；新生產路由不使用它們。

其他 KCC index profile 仍由既有 collector 處理，沒有改動 index 採集、每屆完成 yield 或 news 可見 title 相容邏輯。

## Staging 與 checkpoint

每個 enrichment scope 在原 `.kcc-collection/<profile>/<scope-hash>/` 下使用 `enrichment-v2/`。`journal.json` 只保存：固定母集 release 與 source IDs immutable ref、`committed_cursor`、`prepared_cursor`、目前未提交 descriptor bundle refs、當前 work ref、pending candidate ref、receipts 與議事全文索引完整性旗標。母集 IDs、work、prepared descriptors、pending candidates 都是分開的檔案；checkpoint 不包含完整 `records` 或 source ID array。

work 每次更新為一筆完整 record 的獨立 ref，先耐久寫入，再更新 journal ref。PDF work 只保留頁碼、中繼資料及 page/search derived refs；每個 PDF version 擷取後逐頁寫入 Derived CAS，checkpoint work 不重複保存頁面正文。官方原件仍寫入既有 raw CAS。

prepared record files 只含 v2 descriptors、record ID、cursor 與批次大小。發布前的 pending candidate 只含 header、descriptor refs、base releases 及每個 dataset 的 confirmed/unknown/publishing 狀態，不保存 envelope、payload 或全文。

## 批次與發布

提案詳情與附件清單以 100 筆或 8 MiB 先達者 flush；議事原件以 25 筆或 8 MiB 先達者 flush。批次跨 25 個 HTTP request／75 秒段落累積，每段最多發布一次；整個母集已備妥時，不足門檻的最後一批仍會 flush。未滿批可先回 `paused`，下一段由 `prepared_cursor` 接續，不重抓已保存的 work。

HTTP request 的 25／75 秒界線由 collector 維持，發布不受限於單一 HTTP 段落。NAS R9 全規模 32,391 筆一次匯入實測中，`kcc-proposal-details` 驗證／發布耗時 139,737 ms，`kcc-proposal-attachments` 耗時 145,652 ms；詳情批次逐一處理兩個 dataset 的本機發布至少約 285 秒。worker 的 collector 子程序時限固定為 900,000 ms（15 分鐘），涵蓋子程序內的本機驗證、發布及讀回，不提供任意外部時限覆寫；時限到達仍維持 `outcome_unknown` 與原有 reconciliation 契約。NAS `jobs` role 的停止寬限為 1200 秒，讓停止中的 worker 有時間等待子程序及讀回結束。

發布使用鎖定的 flat API：`LocalStore.importV2({schema_version, dataset, snapshot_id, coverage, parser_version, validator_version, validation_status, records})`。候選 snapshot 重用既有 v2 archive 的 descriptors，合併本批 prepared refs；發布後以 `readSnapshotVersionV2` 讀回 archive，再用 `queryV2(..., {limit: 0, metadataOnly: true})` 確認 active release。詳情的 `kcc-proposal-details` 與 `kcc-proposal-attachments` 都讀回成功才推進 `committed_cursor`。部分成功先保留已確認 receipt，只重試尚未確認的 dataset；任何 active release 或固定母集 release 漂移都拒絕推進。

準備完成與正式提交分開保存。若 import 結果不明，重試前先查 active release 是否已是候選；若 checkpoint 在兩個 dataset 都成功後未能推進，下一段依 pending candidate 與原生 release 確認後提交，不重複匯入已生效的候選。

## 舊 checkpoint 遷移

若同 scope 存在 v1 `checkpoint.json` 而尚無已提交 v2 journal，先核對母集 release、source IDs 及 v1 active receipts，再逐筆把已確認 prefix 轉成 derived refs；現行未提交 work 也轉成新 ref，沿用已下載原件與頁面，不重新抓取。遷移以相同 scope 發布等價 v2 snapshot。成功以前保留舊 checkpoint、cursor、raw CAS 與舊 archive；確認成功後，新 journal 接續原 cursor。

## 輸出欄位

- `record_count`：已發布 receipt 的筆數；部分批次未提交時仍回前一筆已確認 receipt 數量，沒有 v2 receipt 時為 `0`。
- `prepared_count`：`prepared_cursor`，表示已完成 staging 的母集位置，可能大於已提交位置。
- `progress.committed_cursor`、`progress.prepared_cursor`：分別是已提交與已準備位置；`current_id` 指向未完成 work。
- `status: "paused"` 與 `continuation_required: true`：尚有未完成或未提交工作，可安全續作。
- `commit_state`：`not-committed`、`partial`、`unknown` 或 `committed`；`uncertain_datasets` 與 `needs_reconciliation` 指出尚需原生核對的發布結果。
- 議事錄的 `archive_complete` 與 `fulltext_complete` 分開回報。Word 原件、未知格式或 PDF 部分缺少文字時，保留原件及 `partial`／未索引標記，不冒充完整全文。

## 驗證

執行 `node scripts/test-kcc-enrichment-v2.mjs`。此專用測試涵蓋 durable work/journal refs、100/25 筆及 8 MiB 批次門檻、終端 flush、跨段續作、雙 dataset 部分發布、提交後 journal 失敗復原、active／母集 drift、v1 checkpoint 與 work 遷移，以及真實 `LocalStore` + KCC payload codec 的 page refs、import、native readback 與 hydration。

此測試不代表全量生產容量驗收。最終 1 GiB 候選匯入、查詢、還原及非作者審查由整合主代理執行。

子程序退出後，worker 還會獨立讀回目前 release；這一步在 900 秒子程序計時之外。1200 秒容器停止寬限額外配置約 300 秒給父程序讀回與回執落盤，讀回時程以全規模查詢驗收衡量。
