# MCP 本機金鑰存取與 Cloudflare Secret 注入規範

所有本機／CLI Secret 預設從 macOS Keychain 即時取得；Proton Pass 仍是長期秘密值權威。GitHub 只保存取用腳本、Required Secret 名稱、版本閘門與非秘密 Metadata。

## Keychain 命名
- Account：`$USER`
- Service：`<project-name>.<SECRET_NAME>`
- 本專案 Production 主要存取金鑰：`kcg-civic-mcp-worker.MCP_ACCESS_KEY`

## 正式注入
優先直接 pipe 到 Wrangler：

```bash
security find-generic-password -a "$USER" -s "kcg-civic-mcp-worker.MCP_ACCESS_KEY" -w \
  | npx wrangler secret put MCP_ACCESS_KEY
```

或：

```bash
./scripts/keychain-secret.sh wrangler-put \
  kcg-civic-mcp-worker.MCP_ACCESS_KEY MCP_ACCESS_KEY
```

## 人工貼入
`copy` 僅限人工 Client／管理介面，預設 60 秒後且剪貼簿未變時才清空。一般 `get` 已停用；stdout 只有 `MCP_ALLOW_SECRET_STDOUT=1 ... debug-get` 可顯式解鎖，屬 DEBUG ONLY。

## Required Secrets
`wrangler.jsonc` 必須宣告 `MCP_ACCESS_KEY` 為 Production required secret。`AUTH_TOKEN` 僅是程式相容讀取項，不作此施工分支的 Required Secret。

## Toolchain
Production 固定：

```bash
npm ci
npm run verify:toolchain
npm test
npm run deploy
```

Wrangler 版本閘門要求實際安裝版本為 `4.129.0`；`.npmrc` 使用 `save-exact=true` 控制未來 dependency 更新。

禁止把 Secret 放入 CLI argument、Shell history、`.env`／`.dev.vars`、README、Issue、commit message、測試輸出或 Log。Keychain lookup 成功不代表 Proton Pass 已備份。
