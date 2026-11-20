#!/usr/bin/env bash
# The repository is public: infrastructure details (LAN hosts and addresses, SSH users, local paths)
# belong in the gitignored CLAUDE.local.md, never in tracked files. Fails on any match.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
failed=0
pattern='\.atom\.splittingatom\.io|claude@compute|192\.168\.1\.[0-9]|/Users/[a-z]+/|AI Notes/'
if git grep -nIE "$pattern" -- . ':!scripts/check-public-hygiene.sh'; then
  echo "error: infrastructure details in tracked files (move them to CLAUDE.local.md)" >&2
  failed=1
fi

# Credentials known to have been committed once (KOBE-700: the dev Postgres password, SEC-11) are
# matched by their SHA-256, so this file does not publish them again. Checked: the password in a
# URL's userinfo (scheme://user:password@) and the value of a *PASSWORD*= / *PASSWORD*: assignment.
leaked_sha256=(
  82cdbaf27703fce0a797a312d86c898d574f7d806625118ea6a5f494e31bb9f9
)
url_password='[a-z][a-z0-9+.-]*://[^:/@[:space:]"'"'"'`]+:[^@/[:space:]"'"'"'`]+@'
assigned_password='[A-Za-z_]*PASSWORD[A-Za-z_]*["'"'"']?[[:space:]]*[=:][[:space:]]*["'"'"']?[^"'"'"'[:space:],;]+'
while IFS= read -r hit; do
  # hit is path:line:match; the password follows the last ':' of the URL userinfo or the '='/':'.
  match="${hit#*:*:}"
  if [[ "$match" == *://* ]]; then
    secret="${match%@}"
    secret="${secret#*://*:}"
  else
    secret="$(sed -E 's/^[^=:]*[=:][[:space:]]*["'"'"']?//' <<<"$match")"
  fi
  digest="$(printf '%s' "$secret" | sha256sum | cut -d' ' -f1)"
  for known in "${leaked_sha256[@]}"; do
    if [[ "$digest" == "$known" ]]; then
      echo "${hit%%:*}:$(cut -d: -f2 <<<"$hit"): a credential that leaked before (sha256 ${known:0:12}...)"
      echo "error: credential in a tracked file (use an obviously fake value)" >&2
      failed=1
    fi
  done
done < <(git grep -noIE -e "$url_password" -e "$assigned_password" -- . ':!scripts/check-public-hygiene.sh' || true)
[[ "$failed" == 0 ]] || exit 1
echo "public hygiene: ok"
