# 高雄市公民資料 MCP 開發與驗收日誌 (v0.1.0)

## 專案資訊
- 專案名稱：kcg-civic-mcp-worker
- Deployment Version ID: 8e48b604-6d50-4f8c-a949-a87b4d0b59ae
- 正式 MCP 端點：https://kcg-civic-mcp-worker.lihong.workers.dev/mcp
- 資料備援：Cloudflare R2 (kcg-civic-data)

## Credential／Secret 取用規範
- 本機／CLI Secret 預設從 macOS Keychain 即時取得。
- Keychain Account：`$USER`。
- Keychain Service：`<project-name>.<SECRET_NAME>`。
- GitHub 只保存取用指令／helper，不保存任何秘密值。
- 人工貼上：`security find-generic-password -a "$USER" -s "<project-name>.<SECRET_NAME>" -w | pbcopy`。
- Cloudflare 注入：優先用 stdin 直接傳給 Wrangler，避免 Secret 出現在 shell history。
- 通用 helper：`scripts/keychain-secret.sh`。
- 完整規範：`docs/credential-access.md`。

## Production 驗收結果 (115 年預算總表)
- 驗收工具：get_kcg_budget_summary
- 資料集 ID：101174
- 來源類型：r2 (Fallback 成功)
- 內容雜湊：6a43d9ca23c4d11df61befd360317017ba7886093d5a0e1161310a0119c193f7
- 驗收項目全數通過：Authorization, Worker, JSON-RPC, tools/call, R2 Fallback, Provenance.
