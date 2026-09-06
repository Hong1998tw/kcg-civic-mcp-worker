#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/keychain-secret.sh copy <service>
  ./scripts/keychain-secret.sh wrangler-put <service> <secret_name> [wrangler args...]
  ./scripts/keychain-secret.sh wrangler-version-put <service> <secret_name> [wrangler args...]
  MCP_ALLOW_SECRET_STDOUT=1 ./scripts/keychain-secret.sh debug-get <service>

macOS Keychain naming standard:
  account: $USER
  service: <project-name>.<SECRET_NAME>

Environment:
  MCP_CLIPBOARD_TTL_SECONDS   Clipboard TTL for copy mode. Default: 60, max: 300.
  MCP_ALLOW_SECRET_STDOUT     Must be exactly 1 to enable debug-get.
EOF
}

[[ "$(uname -s)" == "Darwin" ]] || { echo "Error: macOS required." >&2; exit 1; }
for cmd in security shasum; do command -v "$cmd" >/dev/null 2>&1 || { echo "Error: $cmd not found." >&2; exit 1; }; done
[[ $# -ge 2 ]] || { usage >&2; exit 64; }
mode="$1"; service="$2"
keychain_read() { security find-generic-password -a "$USER" -s "$service" -w; }

case "$mode" in
  get)
    echo "Error: get is disabled; use explicit debug-get only when required." >&2; exit 64 ;;
  debug-get)
    [[ "${MCP_ALLOW_SECRET_STDOUT:-0}" == "1" ]] || { echo "Error: debug-get is locked." >&2; exit 77; }
    keychain_read ;;
  copy)
    command -v pbcopy >/dev/null && command -v pbpaste >/dev/null || { echo "Error: pbcopy/pbpaste required." >&2; exit 1; }
    ttl="${MCP_CLIPBOARD_TTL_SECONDS:-60}"
    [[ "$ttl" =~ ^[0-9]+$ ]] && (( ttl >= 1 && ttl <= 300 )) || { echo "Error: TTL must be 1..300." >&2; exit 64; }
    secret_hash="$(keychain_read | tee >(pbcopy) | shasum -a 256 | awk '{print $1}')"
    echo "Secret copied; auto-clear in ${ttl}s if clipboard is unchanged." >&2
    ( sleep "$ttl"; current_hash="$(pbpaste | shasum -a 256 | awk '{print $1}')"; [[ "$current_hash" != "$secret_hash" ]] || printf '' | pbcopy ) >/dev/null 2>&1 & ;;
  wrangler-put)
    [[ $# -ge 3 ]] || { usage >&2; exit 64; }; secret_name="$3"; shift 3
    keychain_read | npx wrangler secret put "$secret_name" "$@" ;;
  wrangler-version-put)
    [[ $# -ge 3 ]] || { usage >&2; exit 64; }; secret_name="$3"; shift 3
    keychain_read | npx wrangler versions secret put "$secret_name" "$@" ;;
  *) usage >&2; exit 64 ;;
esac
