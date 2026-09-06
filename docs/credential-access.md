# MCP 本機金鑰存取與 Cloudflare Secret 注入規範

## 1. 核心原則

所有本機／CLI 執行所需 Secret，預設從 macOS Keychain 即時取得，不把秘密值寫入 GitHub、README、`.env`、`.dev.vars`、Shell history、操作日誌或文件。

GitHub 只保存：
- Keychain Service 命名規則
- Secret 取得指令範本
- 自動部署／Wrangler 注入腳本
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

## 3. 人工貼上模式

需要將秘密值放進剪貼簿時：

```bash
security find-generic-password \
  -a "$USER" \
  -s "taiwan-news-mcp-worker.AUTH_TOKEN" \
  -w | pbcopy
```

此模式只用於需要人工貼入 Client／管理介面的情況。使用後應避免在其他應用程式誤貼內容。

## 4. Cloudflare Wrangler 注入模式

優先使用 stdin 直接注入，避免秘密值出現在指令列參數或 shell history。

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

## 5. Repo helper

本 repo 提供：

```bash
./scripts/keychain-secret.sh copy <project-name>.<SECRET_NAME>
./scripts/keychain-secret.sh wrangler-put <project-name>.<SECRET_NAME> <SECRET_NAME>
./scripts/keychain-secret.sh wrangler-version-put <project-name>.<SECRET_NAME> <SECRET_NAME> --name <project-name>
```

範例：

```bash
./scripts/keychain-secret.sh copy taiwan-news-mcp-worker.AUTH_TOKEN

./scripts/keychain-secret.sh wrangler-put \
  taiwan-news-mcp-worker.AUTH_TOKEN \
  AUTH_TOKEN

./scripts/keychain-secret.sh wrangler-version-put \
  taiwan-news-mcp-worker.AUTH_TOKEN \
  AUTH_TOKEN \
  --name taiwan-news-mcp-worker
```

## 6. 禁止事項

不得：
- `echo "actual-secret" | wrangler ...`
- `wrangler ... --token actual-secret`
- 把 Secret 寫進 `.env.example`／`.dev.vars.example`
- 把 Secret 寫進 README／GitHub issue／commit message
- 用 Shell 變數長時間保存 Secret 再輸出到 log
- 把 access token／refresh token／authorization code 寫入文件

## 7. 權威來源

- 秘密值權威保管：Proton Pass
- 本機執行快取／CLI 取用：macOS Keychain
- Runtime Secret：Cloudflare Workers Secret
- 程式／指令範本：GitHub
- 狀態 Metadata：Notion Project State

Keychain 是本機執行層，不取代 Proton Pass 的長期備份與治理角色。
