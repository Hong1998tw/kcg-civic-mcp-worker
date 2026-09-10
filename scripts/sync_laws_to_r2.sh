#!/bin/bash
set -eu

echo "BLOCKED: legacy law sync used unverified generated data and may not write production R2." >&2
echo "Use a separately reviewed ingestion + validation + immutable promotion workflow." >&2
exit 1
