# KOBE-728: Split e2e/run.sh and e2e/gate7/client.mjs (review CODE-12)

- **Status:** in review (branch `group-68-e2e-script-splits`, not pushed)
- **Kind:** refactor, no behaviour change. Neither script can run outside CI (k3d), so equivalence is proved statically.

## Layout

`e2e/run.sh` (80 lines) keeps the shebang comment, `set -euo pipefail`, `E2E_DIR`, `cd` to the repo root, the
`if`/`elif`/`else`/`fi` wrappers that cannot be cut, one `source` line per file, and the final `exit "$failed"`.
Everything else moved verbatim:

- `e2e/lib/run-common.sh`: settings, `KOBE_E2E_SHARD` validation, context guard, helpers, `trap cleanup EXIT`.
- `e2e/run/10-deploy.sh`, `20-checks.sh`; `30`..`37` (inside the `gate1-prep` skip `if`: sandbox provider, wire,
  hibernate and wake with the cold-start `exit`, workspace sync, runs, interrupted runs, approvals, egress proxy);
  `40`..`47` (model gateway; `40` sets up, `41`..`47` run inside the "model client pod is ready" `if`);
  `50`..`54` (request access, MCP proxy, scheduled runs and executor, MCP token rotation, chart upgrade).
- Files are sourced inside the `if` bodies that enclose them, so a part never holds half a compound command.
- `e2e/gate7/client.mjs` became `e2e/gate7/client/NN-*.mjs`: helpers, setup, one file per scenario (u44 and u45 share
  `siteProposals`, so they share a file), `browser-item`, and `90-modes.mjs` (the `MODES` table and dispatch).

The gate7 client cannot use ES imports: `gate7.sh` pastes the Gate 1-3 helpers and the client together into one
`node --input-type=module -e` script that runs inside a server pod, where no sibling file exists. So `gate7.sh` now
does `cat e2e/gate7/client/*.mjs` (digit prefixes fix the order), and the entry file `client.mjs` no longer exists.

## Equivalence proof

run.sh: replacing each `source "$E2E_DIR/<f>"` line with `<f>` minus its two header lines (and dropping the `E2E_DIR=`
and `# shellcheck source=` lines) reproduces the original `e2e/run.sh` of origin/main byte for byte (`cmp`: identical,
0 lines of `diff`). Order of the `source` lines is the original order.

```bash
grep -v '^E2E_DIR=\|^# shellcheck source=' e2e/run.sh | while IFS= read -r line; do
  if [[ "$line" =~ ^source\ \"\$E2E_DIR/(.*)\"$ ]]; then tail -n +3 "e2e/${BASH_REMATCH[1]}"; else printf '%s\n' "$line"; fi
done | cmp - <(git show origin/main:e2e/run.sh)
```

`bash -n` passes on `run.sh` and all 24 section files with empty stderr (a cut inside a compound command or heredoc
fails it, which is how the cut points were chosen). No subshell, no `local`, no positional-parameter use was added;
`$0`/`BASH_SOURCE` appear only on the `E2E_DIR` line (the one subshell, evaluated before `cd`).

shellcheck 0.11.0: shellcheck does not report findings inside sourced files, so `run.sh` alone shows nothing. Per file
(without context) the findings equal the original's real ones: SC2086 (4 sites), SC2015, SC2028, SC2016 x2, SC2034 (`i`),
all at the original lines. The original's 22 SC2329 ("function never invoked") disappear in the split because
shellcheck sees each file alone; new per-file SC2154/SC2034/SC1091 are only missing context (variables defined in another
file). Two SC2086 on `$NS` in `20-checks.sh` are the same likewise (a known constant in the monolith). No new finding in
the code itself.

client: `cat e2e/gate7/client/*.mjs` equals the old `client.mjs` except that prettier removed the blank line that ended each
part (10 blank lines in all; `diff` of the two with blank lines dropped is empty). `node --check` passes on every part and on the
assembled `CLIENT_JS` (gate1-3 helpers + gate7). No `import`/`export` in any part, so no cycle. Dispatch table, before and after (same order):
fixtures, g7-setup, g7-u39 .. g7-u54, g7-browser-item.

References: `e2e.yml` only calls `e2e/run.sh` and `e2e/gate7.sh` (unchanged names, args, env, exit codes); nothing copies
single e2e files; `docs/gates/gate-7.md` and the `gate7.sh` comments now name `client/*.mjs`; `docs/development.md` gains
the layout note.

## Docs

No change to the user guide (`docs/guide`): test harness only. `docs/development.md` and `docs/gates/gate-7.md` updated.

## Watch on the first merge-queue e2e run

1. Every shard starts: a `source` path failure shows as `No such file` right after the first line of the log (the
   `E2E_DIR` is absolute; the suite is run from the repo root as before).
2. `suite` and `cold-start` (the `exit "$failed"` in `32-hibernate-wake.sh` still ends cold-start), `executor`,
   `gate1-prep` (the exit in `40-model-gateway-setup.sh`: the gate1..gate-sso shards depend on it): same check counts as
   the previous green run.
3. `gate7-a` and `gate7-b`: every story prints its verdict (a wrong cat order would be an `unknown mode` or a
   ReferenceError).
4. A section-order or skip difference would show as a changed number of `ok` lines; compare against the last main run.
