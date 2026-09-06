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

Examples:
  ./scripts/keychain-secret.sh copy taiwan-news-mcp-worker.AUTH_TOKEN
  ./scripts/keychain-secret.sh wrangler-put taiwan-news-mcp-worker.AUTH_TOKEN AUTH_TOKEN
  ./scripts/keychain-secret.sh wrangler-version-put taiwan-news-mcp-worker.AUTH_TOKEN AUTH_TOKEN --name taiwan-news-mcp-worker

Security rules:
  - Never pass the secret value as a command-line argument.
  - Never commit the secret value to GitHub, .env, .dev.vars, docs, or logs.
  - Prefer wrangler-put / wrangler-version-put for Cloudflare injection.
  - copy is for manual UI entry only and auto-clears the clipboard if it is unchanged.
  - debug-get writes the secret to stdout and is disabled unless explicitly unlocked.
EOF
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: this helper requires macOS Keychain (security command)." >&2
  exit 1
fi

for cmd in security shasum; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found." >&2
    exit 1
  fi
done

if [[ $# -lt 2 ]]; then
  usage >&2
  exit 64
fi

mode="$1"
service="$2"

keychain_read() {
  security find-generic-password \
    -a "$USER" \
    -s "$service" \
    -w
}

case "$mode" in
  get)
    echo "Error: 'get' is disabled because it exposes the secret on stdout." >&2
    echo "Use 'debug-get' with MCP_ALLOW_SECRET_STDOUT=1 only for explicit debugging." >&2
    exit 64
    ;;
  debug-get)
    if [[ "${MCP_ALLOW_SECRET_STDOUT:-0}" != "1" ]]; then
      echo "Error: debug-get is locked. Set MCP_ALLOW_SECRET_STDOUT=1 only when stdout exposure is explicitly required." >&2
      exit 77
    fi
    keychain_read
    ;;
  copy)
    for cmd in pbcopy pbpaste; do
      if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' not found." >&2
        exit 1
      fi
    done

    ttl="${MCP_CLIPBOARD_TTL_SECONDS:-60}"
    if ! [[ "$ttl" =~ ^[0-9]+$ ]] || (( ttl < 1 || ttl > 300 )); then
      echo "Error: MCP_CLIPBOARD_TTL_SECONDS must be an integer between 1 and 300." >&2
      exit 64
    fi

    secret_hash="$(keychain_read | tee >(pbcopy) | shasum -a 256 | awk '{print $1}')"
    echo "Copied Keychain item '$service' to clipboard; auto-clear scheduled in ${ttl}s if clipboard is unchanged." >&2

    (
      sleep "$ttl"
      current_hash="$(pbpaste | shasum -a 256 | awk '{print $1}')"
      if [[ "$current_hash" == "$secret_hash" ]]; then
        printf '' | pbcopy
      fi
    ) >/dev/null 2>&1 &
    ;;
  wrangler-put)
    if [[ $# -lt 3 ]]; then
      usage >&2
      exit 64
    fi
    secret_name="$3"
    shift 3
    keychain_read | npx wrangler secret put "$secret_name" "$@"
    ;;
  wrangler-version-put)
    if [[ $# -lt 3 ]]; then
      usage >&2
      exit 64
    fi
    secret_name="$3"
    shift 3
    keychain_read | npx wrangler versions secret put "$secret_name" "$@"
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
