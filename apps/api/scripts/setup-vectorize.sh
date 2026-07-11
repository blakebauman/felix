#!/usr/bin/env bash
#
# Create the Vectorize metadata indexes the commerce features require.
#
# Vectorize only filters on metadata fields that have an index. Product/image
# embeddings and semantic memory are stored in a single index and isolated by
# `{ tenant, kind }` metadata filters — without these indexes, every filtered
# query returns empty (recommendations + visual search silently break).
#
# Metadata indexes only apply to vectors inserted AFTER the index is active, so
# after running this on a fresh/existing index you must re-insert vectors
# (re-import a catalog, or POST /brands/:id/reindex).
#
# Usage:
#   scripts/setup-vectorize.sh <index-name>
#   scripts/setup-vectorize.sh felix-memory-staging
#   scripts/setup-vectorize.sh felix-memory-prod
#
# Idempotent: re-running on an index that already has the indexes is a no-op
# (Cloudflare returns "already exists").

set -euo pipefail

INDEX="${1:-}"
if [[ -z "$INDEX" ]]; then
  echo "usage: $0 <index-name>   (e.g. felix-memory-staging | felix-memory-prod)" >&2
  exit 1
fi

for prop in tenant kind; do
  echo "→ creating metadata index '$prop' on $INDEX"
  npx wrangler vectorize create-metadata-index "$INDEX" --property-name "$prop" --type string || true
done

echo "✅ requested. Verify with: npx wrangler vectorize list-metadata-index $INDEX"
echo "   Then re-insert vectors (re-import a catalog or POST /brands/:id/reindex)."
