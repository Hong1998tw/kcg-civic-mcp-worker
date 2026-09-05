#!/bin/bash
set -e

ENDPOINT="${1:-https://kcg-civic-mcp-worker.lihong.workers.dev/mcp}"
TOKEN="${AUTH_TOKEN:-}"

echo "=== 開始驗證高雄市公民資料 MCP ==="
echo "目標端點: $ENDPOINT"

TOTAL_TESTS=0
PASSED_TESTS=0

run_test() {
  local id="$1"
  local tool="$2"
  local args="$3"
  TOTAL_TESTS=$((TOTAL_TESTS + 1))

  printf "[%02d] 測試 %-30s ... " "$id" "$tool"

  response=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}")

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo "❌ 失敗 (HTTP 狀態碼: $http_code)"
    return
  fi

  has_error=$(echo "$body" | jq -r '.error // empty')
  if [ -n "$has_error" ]; then
    echo "❌ 錯誤: $(echo "$body" | jq -c '.error')"
    return
  fi

  raw_text=$(echo "$body" | jq -r '.result.content[0].text // empty')
  status=$(echo "$raw_text" | jq -r '.status // empty')
  source_type=$(echo "$raw_text" | jq -r '.provenance.source_type // empty')

  if [ "$status" = "success" ]; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
    echo "✅ 成功 (來源: $source_type)"
  else
    echo "❌ Envelope 結構不符"
  fi
}

curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":100,"method":"tools/list"}' | jq -e '.result.tools' > /dev/null && echo "✅ tools/list 通過"

run_test 1 "get_kcg_budget_summary" '{"year":115}'

echo "=========================================="
echo "結果: $PASSED_TESTS / $TOTAL_TESTS 通過"
[ "$PASSED_TESTS" -eq "$TOTAL_TESTS" ] && exit 0 || exit 1
