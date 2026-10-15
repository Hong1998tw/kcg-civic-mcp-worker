# Enrichment v2 合成容量 fixture

`scripts/verify-enrichment-v2-capacity.mjs` 以正式 `LocalStore`、`DerivedStore`、payload codec 與 registry handler 建立三個 v2 snapshot。預設建立 32,391 個配對提案 ID，details 和 attachments 各 32,391 筆，另建立 2,198 筆多版本、多頁議事候選。來源 URL、raw 與正文都標記為 `SYNTHETIC TEST`；結果只量測合成儲存路徑，不能代替真實語料、正式 worker/ingress Gate 或 single-large-PDF parser Gate。

使用全新、絕對路徑的 root。容量實測各 phase 要用獨立 Node 程序執行，外層 runner 負責設定 1 GiB prepare 容器、384 MiB query 容器，並記錄 cgroup peak/OOM 與容器 RSS：

```sh
node source/scripts/verify-enrichment-v2-capacity.mjs --root /absolute/path/to/capacity-root --phase prepare
node source/scripts/verify-enrichment-v2-capacity.mjs --root /absolute/path/to/capacity-root --phase query
node source/scripts/verify-enrichment-v2-capacity.mjs --root /absolute/path/to/capacity-root --phase restore
```

`query` 優先載入 `dist-local/registry.mjs` production bundle；只有 bundle 不存在時才動態載入開發用 esbuild fallback。它透過實際 registry handler 驗證完整 metadata、零命中零 hydration、單案完整 detail、最新 15 筆、跨 64 KiB 中文詞、多頁指定頁、snippet 上限及單頁全文。`prepare` 對 details、attachments、meetings 使用 8 個有界 fixture write lanes 建立不同 record 的 raw/CAS 物件，descriptor 依原始 index 收集，全部完成後每個 dataset 仍只呼叫一次 `importV2`；每 1,000 筆依 completed 數量將 JSON progress 附加到 root 的 `progress-prepare.jsonl`，並輸出 process RSS、`process.memoryUsage()` 與 `process.resourceUsage()`。這項 concurrency 僅供合成 fixture 寫入，正式 collector 維持單一寫入者。`restore` 先切換至一筆 probe snapshot，再還原原始 full snapshot 並重新驗證 active release；保留原始 raw、derived CAS 與 archive。

小型三階段 smoke 可用：

```sh
node source/scripts/verify-enrichment-v2-capacity.mjs --root /tmp/enrichment-v2-capacity-smoke --phase prepare --details-count 3 --meetings-count 2
node source/scripts/verify-enrichment-v2-capacity.mjs --root /tmp/enrichment-v2-capacity-smoke --phase query
node source/scripts/verify-enrichment-v2-capacity.mjs --root /tmp/enrichment-v2-capacity-smoke --phase restore
```

`prepare` 只接受新空 root 或本工具建立且規模相同的未完成 marker；不會清理 root，也不允許在已完成的 prepare 上重跑。各 phase 時間、receipt、測試結果及 process 資源用量會寫入 marker/progress JSON，不能單憑 script 輸出宣稱外層 cgroup 或真語料 Gate 通過。
