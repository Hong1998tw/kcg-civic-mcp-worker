#!/bin/bash
set -e

ENDPOINT="https://kcg-civic-mcp-worker.lihong.workers.dev/mcp"
TOKEN="${AUTH_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "⚠️ 警告: 未偵測到 AUTH_TOKEN 環境變數，若伺服器啟用驗證可能回傳 401。"
fi

call_mcp_tool() {
  local id="$1"
  local tool="$2"
  local args="$3"
  local title="$4"

  echo "============================================================"
  echo "[$id] 正在查詢: $title ($tool)"
  echo "參數: $args"
  echo "------------------------------------------------------------"

  response=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}")

  has_error=$(echo "$response" | jq -r '.error // empty')
  if [ -n "$has_error" ]; then
    echo "❌ 執行失敗: $(echo "$response" | jq -c '.error')"
    return
  fi

  raw_text=$(echo "$response" | jq -r '.result.content[0].text // empty')
  if [ -z "$raw_text" ]; then
    echo "❌ 格式錯誤: 查無 content[0].text"
    return
  fi

  echo "來源型態: $(echo "$raw_text" | jq -r '.provenance.source_type // "未知"')"
  echo "來源網址: $(echo "$raw_text" | jq -r '.provenance.source_url // "未知"')"
  echo "回傳資料:"
  echo "$raw_text" | jq '.data'
  echo ""
}

# 1. 查詢騎樓管理自治條例
call_mcp_tool 1 "search_kcg_laws" '{"keyword":"騎樓"}' "查詢騎樓法規"

# 2. 查詢市政即時新聞
call_mcp_tool 2 "search_kcg_news" '{"keyword":"交通"}' "查詢市政新聞"

# 3. 查詢議會提案與質詢紀錄
call_mcp_tool 3 "search_kcg_council_interpellations" '{"keyword":"輕軌"}' "查詢議會質詢/提案"
