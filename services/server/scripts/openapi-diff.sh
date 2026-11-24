#!/usr/bin/env bash
# Shows how the OpenAPI document changes against a base ref (KOBE-815): openapi.json is not
# committed, so request/response shape changes (zod schemas in routes or @kaiju/protocol) do not
# show as a file diff in a PR. Builds the server for the working tree and for the base (in a
# temporary git worktree, reusing this checkout's Turbo cache), then prints the JSON diff.
#
#   pnpm --filter @kaiju/server openapi:diff [base-ref]     # default origin/main
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
BASE="${1:-origin/main}"
PNPM="${PNPM:-pnpm}"
export TURBO_CACHE_DIR="$ROOT/.turbo/cache"

if [[ "$BASE" == origin/* ]]; then git fetch -q origin "${BASE#origin/}"; fi
git rev-parse -q --verify "${BASE}^{commit}" >/dev/null || {
  echo "openapi:diff: unknown base ref: $BASE" >&2
  exit 1
}
TMP="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$TMP/base" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Writes the document of the server built under $1 to $2 (works for bases from before KOBE-815,
# which have no scripts/write-openapi.mjs).
write_doc() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  node --input-type=module -e '
    const [dist, out] = process.argv.slice(1);
    const { openApiDocument } = await import(`${dist}/openapi/document.js`);
    (await import("node:fs")).writeFileSync(out, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
  ' "$1/services/server/dist" "$2"
}

echo "openapi:diff: building the working tree" >&2
"$PNPM" exec turbo run build --filter=@kaiju/server --output-logs=errors-only >&2
write_doc "$ROOT" "$TMP/head.json"

echo "openapi:diff: building $BASE in a temporary worktree" >&2
git worktree add -q --detach "$TMP/base" "$BASE"
(
  cd "$TMP/base"
  "$PNPM" install --frozen-lockfile --prefer-offline >/dev/null
  "$PNPM" exec turbo run build --filter=@kaiju/server --output-logs=errors-only >&2
)
write_doc "$TMP/base" "$TMP/base.json"

if git --no-pager diff --no-index --stat "$TMP/base.json" "$TMP/head.json" >/dev/null; then
  echo "openapi:diff: no change against $BASE"
else
  git --no-pager diff --no-index "$TMP/base.json" "$TMP/head.json" |
    sed -e "s|[ab]\?$TMP/base.json|openapi.json ($BASE)|g" -e "s|[ab]\?$TMP/head.json|openapi.json (working tree)|g" || true
fi
