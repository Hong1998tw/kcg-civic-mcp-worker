# MCP 本機金鑰存取與 Cloudflare Secret 注入規範

## 1. 核心原則

所有本機／CLI 執行所需 Secret，預設從 macOS Keychain 即時取得，不把秘密值寫入 GitHub、README、`.env`、`.dev.vars`、Shell history、操作日誌或文件。

GitHub 只保存：
- Keychain Service 命名規則
- Secret 取得指令範本
- 自動部署／Wrangler 注入腳本
- 必要 Secret 名稱（例如 `AUTH_TOKEN`）
- 非秘密 Metadata

## 2. Keychain 命名標準

- Account：`$USER`
- Service：`<project-name>.<SECRET_NAME>`

範例：

```bash
security find-generic-password \
  -a "$USER" \
  -s "taiwan-news-mcp-worker.AUTH_TOKEN" \
  -w
```

一般流程不得直接把此輸出顯示在 Terminal；正式 Cloudflare 注入應直接 pipe 到 Wrangler。

## 3. 人工貼上模式

只有需要人工貼入 Client／管理介面時才使用剪貼簿：

```bash
security find-generic-password \
  -a "$USER" \
  -s "taiwan-news-mcp-worker.AUTH_TOKEN" \
  -w | pbcopy
```

Repo helper 的 `copy` 模式預設 60 秒後自動檢查剪貼簿；只有剪貼簿內容仍是原 Secret 時才清空，避免覆蓋使用者之後複製的新內容。TTL 可用 `MCP_CLIPBOARD_TTL_SECONDS` 設為 1～300 秒。

```bash
./scripts/keychain-secret.sh copy taiwan-news-mcp-worker.AUTH_TOKEN
```

## 4. Cloudflare Wrangler 注入模式

正式流程優先使用 stdin 直接注入，避免 Secret 出現在指令列參數、Shell history、檔案或 Log。

```bash
security find-generic-password \
  -a "$USER" \
  -s "taiwan-news-mcp-worker.AUTH_TOKEN" \
  -w | npx wrangler secret put AUTH_TOKEN
```

若採 Workers Versions secrets：

```bash
security find-generic-password \
  -a "$USER" \
  -s "taiwan-news-mcp-worker.AUTH_TOKEN" \
  -w | npx wrangler versions secret put AUTH_TOKEN --name taiwan-news-mcp-worker
```

Repo helper：

```bash
./scripts/keychain-secret.sh wrangler-put <project-name>.<SECRET_NAME> <SECRET_NAME>
./scripts/keychain-secret.sh wrangler-version-put <project-name>.<SECRET_NAME> <SECRET_NAME> --name <project-name>
```

## 5. stdout 除錯閘門

一般 `get` 模式已停用，避免誤把 Secret 直接印在 Terminal。

只有明確需要 stdout 除錯時，才能使用：

```bash
MCP_ALLOW_SECRET_STDOUT=1 \
  ./scripts/keychain-secret.sh debug-get <project-name>.<SECRET_NAME>
```

此模式屬 DEBUG ONLY，不得用於日常部署、文件截圖、錄影或操作日誌。

## 6. Required Secrets Gate

正式 Worker 必須在 `wrangler.jsonc` 宣告部署所需的 Secret 名稱，例如：

```jsonc
{
  "secrets": {
    "required": ["AUTH_TOKEN"]
  }
}
```

這只記錄 Secret 名稱，不包含秘密值。若 Cloudflare Worker 未設定必要 Secret，`wrangler deploy`／`wrangler versions upload` 應在部署階段失敗，不允許產生缺少憑證的 Production 版本。

## 7. Toolchain Reproducibility Gate

部署必須使用 committed `package-lock.json`：

```bash
npm ci
npm run verify:toolchain
npm run deploy
```

本 repo 的部署前閘門要求實際安裝的 Wrangler 版本必須為 `4.129.0`。若版本不一致，部署中止。

`.npmrc` 使用 `save-exact=true`，後續新增／更新套件預設寫入 exact version。既有 lockfile 仍是安裝解析版本的權威來源，因此不得用 `npm install` 任意重算依賴後直接部署。

## 8. 禁止事項

不得：
- `echo "actual-secret" | wrangler ...`
- `wrangler ... --token actual-secret`
- 把 Secret 寫進 `.env.example`／`.dev.vars.example`
- 把 Secret 寫進 README／GitHub issue／commit message
- 長時間把 Secret 存在 Shell 變數並輸出到 log
- 把 access token／refresh token／authorization code 寫入文件
- 日常使用 `debug-get` 顯示 Secret
- 以未受 package-lock／版本閘門控制的 Wrangler 直接 Production deploy

## 9. 權威來源

- 秘密值權威保管：Proton Pass
- 本機執行快取／CLI 取用：macOS Keychain
- Runtime Secret：Cloudflare Workers Secret
- 程式／指令範本：GitHub
- 必要 Secret 名稱：`wrangler.jsonc` 的 `secrets.required`
- 狀態 Metadata：Notion Project State

Keychain 是本機執行層，不取代 Proton Pass 的長期備份與治理角色；`secrets.required` 也只保存名稱，不是秘密值保管機制。
