#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/keychain-secret.sh get <service>
  ./scripts/keychain-secret.sh copy <service>
  ./scripts/keychain-secret.sh wrangler-put <service> <secret_name> [wrangler args...]
  ./scripts/keychain-secret.sh wrangler-version-put <service> <secret_name> [wrangler args...]

macOS Keychain naming standard:
  account: $USER
  service: <project-name>.<SECRET_NAME>

Examples:
  ./scripts/keychain-secret.sh copy taiwan-news-mcp-worker.AUTH_TOKEN
  ./scripts/keychain-secret.sh wrangler-put taiwan-news-mcp-worker.AUTH_TOKEN AUTH_TOKEN
  ./scripts/keychain-secret.sh wrangler-version-put taiwan-news-mcp-worker.AUTH_TOKEN AUTH_TOKEN --name taiwan-news-mcp-worker

Security rules:
  - Never pass the secret value as a command-line argument.
  - Never commit the secret value to GitHub, .env, .dev.vars, docs, or logs.
  - `get` writes the secret to stdout; use only when a consumer needs stdin.
  - Prefer `wrangler-put` / `wrangler-version-put` for Cloudflare injection.
EOF
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: this helper requires macOS Keychain (security command)." >&2
  exit 1
fi

if ! command -v security >/dev/null 2>&1; then
  echo "Error: macOS security command not found." >&2
  exit 1
fi

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
    keychain_read
    ;;
  copy)
    if ! command -v pbcopy >/dev/null 2>&1; then
      echo "Error: pbcopy not found." >&2
      exit 1
    fi
    keychain_read | pbcopy
    echo "Copied Keychain item '$service' to clipboard." >&2
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
