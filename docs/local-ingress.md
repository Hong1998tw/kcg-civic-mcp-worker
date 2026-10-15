# 本機 MCP 固定目標 Ingress Proxy

`scripts/local-ingress.mjs` 提供 Node.js 24 原生 HTTP ingress proxy，讓既有 Cloudflare Tunnel 經由專用 proxy 連到本機唯讀 query 服務。Proxy 只接受固定後端 `http://query:8787`；程式不讀取 `HTTP_PROXY`、`HTTPS_PROXY` 或其他代理環境設定，也不把程序環境值複製到上游標頭。

```text
Client
  │ HTTPS
  ▼
既有 Cloudflare Tunnel
  │ tunnel Docker network
  ▼
Ingress proxy :8788 ── local_private network ──► query:8787
       同時加入 tunnel Docker network
```

部署時由 Compose 將 proxy 加入既有 tunnel Docker network 與 query 使用的 `internal: true` 網路。Query 只加入內部網路，不加入 tunnel 網路；proxy 不掛載資料或憑證、不發布 host port，並以唯讀根檔案系統及 UID 1000 執行。這些容器隔離設定由 Compose 負責，本程式不會建立或修改 Docker 資源。

## 固定路由

代理只接受下列精確路徑和方法；其他路徑回覆 `404`，不支援的方法回覆 `405`。`/mcp` 與 `/authorize` 可帶 query string；其餘路徑不得帶 query string。

| 路徑 | 方法 | 用途 |
| --- | --- | --- |
| `/mcp` | `POST`, `GET`, `DELETE` | MCP JSON 與 SSE 串流 |
| `/health` | `GET` | 轉送 query 健康狀態 |
| `/.well-known/oauth-authorization-server` | `GET` | OAuth 授權伺服器中繼資料 |
| `/.well-known/oauth-protected-resource/mcp` | `GET` | query 原生提供的受保護資源中繼資料 |
| `/.well-known/oauth-protected-resource` | `GET` | 固定別名，轉送至上一列的原生路徑 |
| `/authorize` | `GET` | OAuth 授權頁與用戶端回呼 |
| `/consent` | `POST` | 表單同意流程 |
| `/register` | `POST` | OAuth 動態用戶端註冊 |
| `/token` | `POST` | OAuth 權杖交換 |
| `/revoke` | `POST` | OAuth 權杖撤銷 |

受保護資源的原生端點是 `/.well-known/oauth-protected-resource/mcp`。需求列出的根路徑由 proxy 作為固定別名轉到該端點，不會開放其他路徑重寫。

## 主機與標頭

預設只接受 `Host: kcg-civic-mcp.kshong.com`，不含 port；`PUBLIC_HOST` 可指定另一個精確的小寫 DNS hostname。缺少、重複或不符的 Host 不會轉送。包含絕對 URL、重複斜線、反斜線、fragment、錯誤百分比編碼或過長內容的 request-target 會在轉送前拒絕。

上游 Host 保持公開 hostname。Proxy 僅轉送 MCP/OAuth 需要的 `Accept`、`Authorization`、`Content-Type`、`Origin`、必要 MCP session 標頭及 consent 的 `Cookie`；其他任意標頭不會轉送。所有 `Connection` 指定的逐跳標頭、`Forwarded`、`X-Forwarded-*`、`CF-*`、`Proxy-Authorization` 及未列入白名單的標頭都會移除。若提供 `Origin`，必須精確等於 `https://` 加上公開 hostname。

OAuth 的 `Location`、`Set-Cookie`、`WWW-Authenticate` 與必要 MCP/SSE 回應標頭會保留；回應一律設為 `Cache-Control: no-store`。代理不記錄請求本文、Authorization、Cookie 或環境值。

## 資源上限與執行設定

| 項目 | 上限 |
| --- | ---: |
| Request 標頭 | 16 KiB、32 個欄位 |
| Request URL | 8 KiB |
| Request 本文 | 256 KiB |
| Response 標頭 | 16 KiB、32 個欄位 |
| Response 本文 | 8 MiB |
| 單一請求總時間 | 60 秒 |
| 同時連線 | 128 |

請求與回應透過 Node stream 傳送，不會先將完整內容載入記憶體。超過本文上限時，request 本文會停止轉送並回覆 `413`；若上游在送出回應標頭前超過回應上限，代理回覆 `502`，串流途中超量則關閉該回應。逾時回覆 `504`（若回應已開始則關閉串流），並銷毀上游連線。上游連線失敗回覆不含內部錯誤細節的 `502`。

生產執行只使用以下環境值：

| 環境變數 | 預設 | 限制 |
| --- | --- | --- |
| `PUBLIC_HOST` | `kcg-civic-mcp.kshong.com` | 精確小寫 hostname；不接受 scheme、port、萬用字元或路徑 |
| `LOCAL_INGRESS_UPSTREAM` | `http://query:8787` | 若設定，只接受完全相同的固定值 |
| `LOCAL_INGRESS_PORT` | `8788` | 1024–65535 的整數；服務固定監聽容器內 `0.0.0.0` |

測試使用 `createLocalIngressServer({ testTarget })` 注入 `http://127.0.0.1:<port>`。測試目標只接受 loopback IPv4 字面值，不接受主機名稱、其他 IP、userinfo、路徑或 query；此參數不會從環境變數讀取。測試也可將監聽位址設為 `127.0.0.1`、port 設為 `0`，以及調短測試逾時。

## Docker 與健康探測

Cloudflare Tunnel 的既有 ingress origin 應指向 Compose 內的 proxy `http://<proxy-service>:8788`，並保留公開 Host。Query 的 `LOCAL_ALLOWED_HOSTS` 必須包含 `kcg-civic-mcp.kshong.com`，`MCP_ALLOWED_ORIGINS` 必須包含 `https://kcg-civic-mcp.kshong.com`；proxy 不會以 `X-Forwarded-*` 覆蓋這些來源。

`/health` 也必須使用精確 Host。Docker 網路內可用以下請求探測 proxy 與 query 的連通狀態：

```sh
curl --fail --silent --show-error \
  -H 'Host: kcg-civic-mcp.kshong.com' \
  http://127.0.0.1:8788/health
```

直接探測 query 時，Host 也需符合 query 的 allowlist，例如 `http://query:8787/health` 搭配 `Host: kcg-civic-mcp.kshong.com`。

## 驗證

以 Node.js 24 執行：

```sh
node scripts/test-local-ingress.mjs
```

測試會啟動真正的本機 HTTP proxy 與測試上游，再以 HTTP 請求驗證固定 Host/路徑/方法、標頭與 cookie 邊界、OAuth redirect/form、MCP JSON、SSE 即時串流、request/response 上限、上游連線失敗及逾時關閉。
