# NAS 原生 OAuth 候選

本模組使用已安裝的 `@modelcontextprotocol/sdk@1.31.0` 官方 `mcpAuthRouter` 與 `OAuthServerProvider` 契約，提供 NAS 本機授權、SQLite 憑證狀態與 MCP access token 驗證。Express 需直接固定為 `5.2.1`。它不匯入 Cloudflare runtime，不呼叫舊 Worker／OAuth Durable Object，不下載 CIMD 或其他用戶端 URL。

本機官方 SDK 的 OAuth 與 MCP 通訊驗證不代表 ChatGPT、外部 HTTPS、Portal 或 NAS 重啟已通過。公開 hostname、Tunnel／DNS、Access、正式切換由原工作整合驗收。

```text
用戶端 → HTTPS／Tunnel 網路入口 → NAS Node24
                                  ├─ OAuth：獨立 RW authRoot/oauth.sqlite
                                  ├─ 擁有者登入：獨立 mounted owner key
                                  └─ MCP：唯讀 corpus 與原始檔

採集者／n8n ──原有有界工作──→ corpus
```

## 接入介面

```js
import { createLocalOAuth } from "./oauth-native.mjs";

const oauth = await createLocalOAuth({
  issuerUrl: "https://<已核准的正式hostname>/",
  authRoot: "/auth",                      // 本機原生磁碟；獨立 RW volume
  ownerKeyFile: "/run/secrets/owner_key", // 獨立於 API Bearer 的高熵秘密
  bearerKeyFile: "/run/secrets/mcp_key",  // 可選：明確保留的 API Bearer 相容
  allowedHosts: [],                       // 預設僅允許 issuer.host
});

// 在任何 body reader 前交給 OAuth handler；它自行驗 Host／大小／格式。
if (oauth.handles(pathname)) {
  oauth.handler(req, res);
  return;
}
if (pathname === "/mcp") {
  const authInfo = await oauth.authenticateMcp(req, res);
  if (!authInfo) return; // 已寫 401 與 resource_metadata challenge
  // 接原有 MCP transport；仍只使用本機唯讀 registry。
}

// 關閉 HTTP server 後：
oauth.close();
```

回傳另有 `verifyAccessToken(token)`、`metadata`、`resourceMetadata`、`resourceMetadataUrl`。`verifyAccessToken` 回 SDK `AuthInfo` 或拋出固定錯誤；回傳的 `token` 僅供執行層使用，不可記錄。`authenticateMcp` 嚴格解析一個 `Bearer`，失敗時只回固定 `unauthorized`。

`issuerUrl` 必須為根目錄 HTTPS URL，不允許 userinfo、query、fragment 或子路徑。`allowLoopbackHttp: true` 僅供明確本機測試；正式環境不啟用。`PUBLIC_ORIGIN`／issuer 由可信部署設定指定，不能由使用者的 Host 或 forwarded header 推導。

反向代理需保留正式 Host，或由部署設定精確指定 `allowedHosts`；不要加萬用字元。模組不信任 `X-Forwarded-*` 作授權身分或 scheme。TLS 由已核准的入口終結，正式 Cookie 仍依 HTTPS issuer 設定 `Secure`。

## 端點與契約

| 路徑 | 方法 | 作用 |
| --- | --- | --- |
| `/.well-known/oauth-authorization-server` | GET | SDK metadata，縮限公開 PKCE client、`none` 與 S256 |
| `/.well-known/oauth-protected-resource/mcp` | GET | `resource=<issuer>/mcp`、授權伺服器及 `mcp:read` |
| `/register` | POST JSON | DCR；只接受 `token_endpoint_auth_method=none`，不發 client secret |
| `/authorize` | GET | 官方 SDK 檢查後顯示擁有者登入與明確同意表單 |
| `/consent` | POST form | 驗同源 Origin、signed state、CSRF、Cookie、擁有者登入及同意／取消 |
| `/token` | POST form | 官方 SDK S256 code exchange／refresh，再由 SQLite 驗綁定與單次作用 |
| `/revoke` | POST form | 只可撤銷該 client 的 token family；未知 token 仍成功回應 |
| `/mcp` | 由主服務處理 | `authenticateMcp` 驗 token；未授權附 `WWW-Authenticate` 與 resource metadata URL |

新端點使用 SDK 的 `/authorize` 等原生名稱，不沿用舊 Worker 的 `/oauth/*`。舊 OAuth grant／token 不移入本機資料庫；用戶端應重新授權新 issuer。

授權與換發均要求精確 `resource=<issuer>/mcp`。code exchange 必須重送當次精確 `redirect_uri`。DCR redirect 只允 HTTPS 或 HTTP loopback，不允 userinfo、fragment、控制空白與不安全 scheme；即使 SDK 對 loopback port 允許彈性，本 provider 仍要求與註冊字串完全一致。SDK client 若改用不同 callback port，需重新註冊精確 URI。

支援 `mcp:read` 與可選 `offline_access`。只要求唯讀時不簽 refresh token；scope 不能擴大。換發後的 scope 縮限會保存到新 token，拿掉 `offline_access` 後不再簽發 refresh token。

## 儲存與安全邊界

- Node.js 24 以上；`authRoot` 必須為 `0700` 私有實體目錄，`oauth.sqlite` 為 `0600` 私有實體檔案。SQLite 採 WAL、`synchronous=FULL`、foreign keys、`BEGIN IMMEDIATE`；無網路儲存或跨主機 SQLite。
- Corpus volume 保持唯讀。只有獨立 auth volume 可寫，不共用 n8n 內部 DB，也不把 OAuth DB 放進 corpus 發布快照。
- Owner 與可選 Bearer 檔案皆須為私有 regular file、不可 symlink、不可 group／world read，內容至少 32 字元、無空白且最多 4096 bytes。請由原生安全機制提供高熵值；模組不生成、輸出或備份真實秘密。
- 啟動時拒絕 owner 與 Bearer 為同值。Bearer 相容只允 MCP 唯讀；不能拿來登入 consent。Owner key 不能直接呼叫 MCP。
- Auth codes、access tokens、refresh tokens、Cookie nonce 及 CSRF 都不以明文存 DB。Token 只在標準 OAuth 回應／程序記憶體出現；資料庫保存 SHA-256 digest。Client metadata、PKCE challenge、授權 scope 與 client state 為必要狀態。
- Signed state 使用由 mounted owner key 以固定用途 HMAC 派生的 signing key，不增加一般檔案中的秘密副本。正式 Cookie 為 `__Host-kcg-oauth`、`Secure; HttpOnly; SameSite=Lax; Path=/`，沒有 Domain。
- Consent 限時 10 分鐘、最多 5 次錯誤 owner key；必須明確按同意，不自動批准。拒絕同樣驗 Cookie／CSRF，成功作用後 pending state 刪除。拒絕 `Origin:null`、跨來源、Cookie 缺少／重複及不符的簽章。
- Code 預設 120 秒；access 預設 1 小時；refresh family 最長 30 天且不因換發無限延長。單次 code 消耗與 token 簽發在同一 SQLite transaction。
- Refresh rotation 後舊 token 標 consumed。重播會在交易中持久撤銷整個 family，再回 `invalid_grant`；必須重新授權。未知／錯 client 的 token 不會撤銷他人的 family。
- 撤銷任一有效 access 或 refresh 會撤銷整個 family，屬此候選的明確安全策略。API Bearer 相容是獨立 mounted secret，不屬 OAuth grant；其輪換由原生秘密管理處理。
- SDK 預設對 authorize／token／register／revoke 限速；Express 不信任代理來源 IP，經同一 connector 的用戶可能共用配額。正式擴容／代理 IP 策略須另驗，不接受任意 forwarded IP。
- 輸入大小 16 KiB；DCR 最多 8 個精確 redirects，預設最多 5000 clients。Pending consent 上限 10000。過期狀態於建立授權／註冊時清理，refresh replay 證據保留到 family 過期。
- 不設定 access log，不將 URL query、form body、Authorization、Set-Cookie、Location 或 token 回應加入一般 log／回執。代理與用戶端也須保留同一秘密邊界。

授權 DB 固定綁定 issuer，換 issuer 使用另一個經審查的 authRoot，避免把既有 grant 默默移給新資源。DB／WAL／SHM 與 owner/Bearer 的原生秘密備份屬不同項目；備份／還原需在原生私有位置與一致性機制驗收，不把 live DB 複製當成可還原證明。

## 驗證

使用 Node24 執行：

```sh
node scripts/test-local-oauth.mjs
```

測試使用臨時合成秘密及本機 HTTP，完成後清理。驗證官方 SDK client 的 metadata、DCR、PKCE／S256、同意、token exchange，以及真 MCP SDK `initialize`／`tools/list`／`tools/call`。另覆蓋錯 resource／redirect／client、單次 code 競態、refresh rotation／replay／撤銷／scope 縮限、到期、SQLite 重開、CSRF／Cookie／null Origin、owner/Bearer 分離、Unsafe issuer、秘密檔權限，以及 DB／WAL／SHM 無明文秘密。

HTTPS issuer 的 Cookie／Host 行為用本機代理 harness 檢查，沒有把 HTTP 模擬宣稱為 TLS 驗證。正式外部 TLS、實際指定 Client、NAS 實機、反向代理、秘密備份與正式切換仍是獨立 Gate。
