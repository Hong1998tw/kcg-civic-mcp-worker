# 2026-09-08 稽核修復紀錄

本文件記錄本機 checkout `e29ac7be9438ae80640acd94bcd0a1eae07f83bf` 上的修復，不代表 Production、R2 或 GitHub 已變更，也不把離線測試描述為 21 工具正式驗收。

## 已完成：Phase 0 fail-closed

- 法規與新聞不再讀取 `laws/kcg_laws.json`、`news/kcg_news.json` 或 demo fallback。查詢只接受 `releases/<dataset>/active.json` 指向的 immutable manifest，並驗證 pointer hash、dataset/snapshot identity、validation status、revocation、parser/validator version、coverage、record count 與 normalized content hash。
- 稽核確認的 laws/news 污染 SHA-256 已列為 revoked，即使有人把舊內容包進 `passed` manifest 也會拒絕。
- active pointer 在每次查詢、process cache 之前讀取；cache 以 snapshot ID 鍵控，release 切換或撤銷不會被舊 cache 遮蔽。
- 議案詳情從來源 HTML 擷取 `proposal_sn` 並與請求值比對；不一致或無法識別即 `SOURCE_ID_MISMATCH`。
- 審議 parser 分離 label/value/date；只有 UI 空標籤的 145223 型態不再被判定為已完成。輸出將官方案件狀態、議會審議狀態與市府執行狀態分開。
- 提案與會議查詢會比對回應 DOM 的實際 selected/input value；被忽略的 active filter 改回 `FILTER_NOT_CONFIRMED`。
- 多 tab 提案頁不再將第一個 pager 當成混合 rows 的共同母體；此時 `total_count`/`is_complete` 為 null，另回 `tab_counts` 與警告。
- 缺少 `proposal_kind` 不再預設為議員提案；政府機關名稱不再寫入 `councilor`。
- PDF cache、輸入 URL 與最終下載 URL 均須和 record ID 一致；cache 頁數與頁序必須一致；越界 page 明確失敗。
- PDF query cache miss 不再寫 R2。跨 PDF 搜尋回 attempted/succeeded/failed；部分失敗是 `partial`，全部失敗是 `PDF_EXTRACTION_FAILED`。
- 日程、即時議員／委員會名錄、臨時提案、發言歸屬、議案關聯在正式來源完成前改為 `FEATURE_UNAVAILABLE`，避免名實不符的 success。
- 115 年原總預算綁定已核對 resource UUID 與 `original/adopted` 口徑；其他年度不再只改 year 標籤，會明確 unavailable。未驗證 R2 預算 fallback 已移除。
- MCP tool execution error 使用 `isError: true`，正常輸出提供 `structuredContent`；認證只接受 Authorization Bearer，不再接受 path/query token。
- legacy law R2 同步腳本已硬性封鎖；predeploy 新增完整測試與 production safety scan。

## 驗證命令

```sh
npm run predeploy
npx wrangler deploy --dry-run --outdir /tmp/kcg-civic-mcp-dry-run
```

已通過：TypeScript、budget parser regression、integrity regressions、production safety、Wrangler version 及 Worker bundle dry-run。

## 尚未完成／不得宣稱

- 尚未建立或發布 laws/news 的新官方 raw、normalized、validation report 與 active release objects；在此之前兩組工具會誠實 unavailable。
- 尚未以官方 DOM trace 完成 WebForms dependent PostBack state machine、逐 tab 翻頁與 cursor；目前策略是無法確認 filter/scope 就拒絕成功。
- 尚未接通真正 schedule、councilor/committee directory、temporary proposal tab、逐字稿 document type 與 deterministic proposal relations。
- 尚未取得 Production Worker version、bundle hash、tool registry hash、R2 inventory/writer log 或部署授權；沒有執行 deploy、R2 寫入／刪除、secret 修改、push、merge。
- 尚未跑真實瀏覽器／ChatGPT callback 與 Production 21-tool contract suite。

## 後續 release / data migration gate

1. 由獨立 ingestion job 保存官方 raw bytes、擷取 URL/時間/hash；parser 產生 immutable normalized object。
2. validator 核對來源身分、語意 canary、coverage、record count、parser/validator version，產生 immutable report 與 manifest。
3. staging 回讀所有 object 並驗 hash，再以條件寫入切換唯一 active pointer；不可覆寫或刪除舊 object。
4. 執行正例、污染反例、ID mutation、filter mutation、partial/all-failed PDF、revocation cache-hit 測試。
5. 綁定 clean git SHA、bundle hash、Worker version、tool registry hash 與 data manifest ID 後才 promotion；rollback 只能指向已驗證且 schema 相容的 code+data 組合。
