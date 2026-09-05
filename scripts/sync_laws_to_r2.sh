#!/bin/bash
set -e

echo "=== 啟動高雄市法規自動更新與 R2 備援同步 ==="
node scripts/crawl_kcg_laws.mjs

echo "=== 上傳最新法規庫至 Cloudflare R2 (kcg-civic-data/laws/kcg_laws.json) ==="
npx wrangler r2 object put kcg-civic-data/laws/kcg_laws.json --file=scripts/kcg_laws.json

echo "✅ 高雄市主管法規 R2 災備更新完成！"
