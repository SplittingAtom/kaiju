#!/usr/bin/env bash
# Brings the current branch onto a base in one step (KOBE-815): fetch, merge the base (default
# origin/main; another branch to stack on an unmerged one), regenerate the branch's migrations on
# it (db:rebase) when the branch has any, resolve conflicts in generated files by regenerating
# them, and print what still needs a human.
#
#   scripts/onto-main.sh [base-ref]      # e.g. origin/main (default), origin/group-88-x
#
# On a conflict it cannot resolve it stops: resolve the listed files, `git commit`, then run it
# again with the same base. Needs a clean working tree. Generated files it handles:
#   docs/audit-log.md                 event table regenerated (pnpm --filter @kobe/db audit:doc)
#   services/server/src/routes/__snapshots__/route-inventory.*.txt
#                                     regenerated with vitest -u, only when they conflicted
#   services/server/openapi.json      no longer tracked: a branch's old copy is dropped
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PNPM="${PNPM:-pnpm}"
BASE="${1:-origin/main}"
STASH="packages/db/.migration-stash.json"
AUDIT_DOC="docs/audit-log.md"
OPENAPI="services/server/openapi.json"
INVENTORY_DIR="services/server/src/routes/__snapshots__/"

say() { printf 'onto-main: %s\n' "$*"; }
die() {
  printf 'onto-main: %s\n' "$*" >&2
  exit 1
}
merging() { git rev-parse -q --verify MERGE_HEAD >/dev/null; }
build_db() {
  local log
  log="$(mktemp)"
  if ! "$PNPM" --filter @kobe/db build >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    merging && old_table_hint
    die "the @kobe/db build failed (an audit event without its row in events/<area>.doc.ts?)"
  fi
  rm -f "$log"
}
unmerged() { git diff --name-only --diff-filter=U; }
old_table_hint() {
  say "If this branch added or changed rows of the old hand-written audit table (before KOBE-815):"
  say "  git checkout --theirs -- $AUDIT_DOC, put each row in its area's"
  say "  packages/db/src/audit/events/<area>.doc.ts (name order), git add both, git commit, run again"
}

[[ $# -le 1 ]] || die "usage: scripts/onto-main.sh [base-ref]"
merging && die "a merge is in progress: resolve it and \`git commit\`, then run this again"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "working tree is not clean"

START="$(git rev-parse HEAD)"
LOCK_BEFORE="$(git hash-object pnpm-lock.yaml)"
regenerated_inventory=0
# Set when a route-inventory snapshot conflicted alongside files a human resolves: the re-run
# regenerates the snapshots (no merge is in progress by then).
INVENTORY_PENDING="$(git rev-parse --git-path onto-main-inventory-pending)"

if [[ "$BASE" == origin/* ]]; then
  git fetch -q origin "${BASE#origin/}"
fi
git rev-parse -q --verify "${BASE}^{commit}" >/dev/null || die "unknown base ref: $BASE"

# Conflicts in generated files only: regenerate them and commit the merge. Anything else: stop.
resolve_generated() {
  local file files others=()
  # Read the list first: git commands in the loop take the index lock.
  mapfile -t files < <(unmerged)
  for file in "${files[@]}"; do
    case "$file" in
      "$OPENAPI") git rm -q --cached --ignore-unmatch -- "$file" ;;
      "$AUDIT_DOC" | "$INVENTORY_DIR"route-inventory.*.txt) ;;
      *) others+=("$file") ;;
    esac
  done
  if [[ ${#others[@]} -gt 0 ]]; then
    for file in "${files[@]}"; do
      if [[ "$file" == "$INVENTORY_DIR"route-inventory.*.txt ]]; then touch "$INVENTORY_PENDING"; fi
    done
    say "conflicts that need a human:"
    printf '  %s\n' "${others[@]}"
    say "resolve them; for $AUDIT_DOC or a route-inventory snapshot take either side"
    say "  (git checkout --theirs -- <file>): the re-run regenerates both. Then \`git commit\` and run:"
    say "  scripts/onto-main.sh $BASE"
    exit 1
  fi
  mapfile -t files < <(unmerged)
  for file in "${files[@]}"; do
    if [[ "$file" == "$AUDIT_DOC" ]]; then
      build_db
      "$PNPM" --silent --filter @kobe/db audit:doc
      if grep -qE '^(<<<<<<<|=======$|>>>>>>>)' "$AUDIT_DOC"; then
        say "$AUDIT_DOC has conflicts outside the generated table."
        old_table_hint
        die "otherwise resolve the prose by hand, git add, git commit, run again"
      fi
    else
      git checkout --theirs -- "$file"
      regenerated_inventory=1
    fi
    git add -- "$file"
  done
  if [[ $regenerated_inventory -eq 1 ]]; then
    regenerate_inventory
  fi
  git commit -q --no-edit
  say "merge committed (generated files regenerated)"
}

regenerate_inventory() {
  "$PNPM" exec turbo run build --filter='@kobe/server^...' --output-logs=errors-only
  "$PNPM" --filter @kobe/server exec vitest run src/routes/route-inventory.test.ts -u >/dev/null
  git add -- "$INVENTORY_DIR"route-inventory.*.txt
}

install_if_lock_changed() {
  if [[ "$(git hash-object pnpm-lock.yaml)" != "$LOCK_BEFORE" ]]; then
    say "pnpm-lock.yaml changed: installing"
    "$PNPM" install --frozen-lockfile >/dev/null
    LOCK_BEFORE="$(git hash-object pnpm-lock.yaml)"
  fi
}

if [[ ! -f "$STASH" ]]; then
  # Regenerates the branch's migrations on the base (stash, merge, regenerate); a branch without
  # migrations is left as it is and merged below. The base goes positionally, which db:rebase
  # took before KOBE-815 too, so a branch that still has the old script works.
  "$PNPM" --filter @kobe/db db:rebase "$BASE"
  if ! merging && ! git merge-base --is-ancestor "$BASE" HEAD; then
    git merge -q --no-edit "$BASE" || true
    merging || git merge-base --is-ancestor "$BASE" HEAD || die "merging $BASE failed (see above)"
  fi
  if merging; then
    install_if_lock_changed
    resolve_generated
  fi
else
  say "resuming db:rebase from $STASH"
fi
if [[ -f "$STASH" ]]; then
  install_if_lock_changed
  "$PNPM" --filter @kobe/db db:rebase --apply
fi
install_if_lock_changed

# Regenerate generated files from the merged code, then commit whatever changed.
if [[ -f "$INVENTORY_PENDING" ]]; then
  regenerate_inventory
  if ! git diff --cached --quiet; then
    git commit -q -m "chore: regenerate the route inventory on $BASE"
  fi
  rm -f "$INVENTORY_PENDING"
  regenerated_inventory=1
  say "regenerated the route-inventory snapshots (they conflicted)"
fi
build_db
"$PNPM" --silent --filter @kobe/db audit:doc
if [[ -n "$(git status --porcelain -- "$AUDIT_DOC")" ]]; then
  git add -- "$AUDIT_DOC"
  git commit -q -m "chore: regenerate $AUDIT_DOC on $BASE"
  say "committed the regenerated $AUDIT_DOC"
fi

say "done: $(git rev-list --count "$START..HEAD") new commit(s) on top of ${START:0:12}"
say "still for you:"
say "  - pnpm typecheck: union-merged barrels (.gitattributes) only show stale lines there"
[[ -n "$(git log --oneline --grep='^chore: regenerate migrations on' "$START..HEAD")" ]] &&
  say "  - migrations regenerated: pnpm --filter @kobe/db db:check and test:db; reset any dev database that ran the old ones"
[[ $regenerated_inventory -eq 1 ]] &&
  say "  - route-inventory snapshots regenerated: read their diff (git show HEAD -- $INVENTORY_DIR)"
say "  - run the tests your change touches, then push"
