# Rename tooling (Kobe → Kaiju)

Spec: [`docs/specs/rename-kaiju.md`](../../docs/specs/rename-kaiju.md). Built in KOBE-745 (RN-1);
used by every later step (RN-2..RN-9), one step per PR.

| File              | What it is                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allowlist.txt`   | Every allowed remaining use of the old name, in groups: `permanent`, `provisional` (an open question) or a step (`RN-2`..`RN-9`), each with its reason |
| `guard.mjs`       | The guard: fails on an occurrence no entry owns, and on an entry that owns nothing (stale); `--final` also fails while any group is not permanent      |
| `steps/RN-n.txt`  | The replacement patterns of one step                                                                                                                   |
| `rename.mjs`      | Dry run (default) or `--apply --step RN-n`                                                                                                             |
| `lib.mjs`         | Shared engine (parsing, globs, ownership, case-keeping swap)                                                                                           |
| `rename.test.mjs` | Self-test on fixture repositories, plus owners of sample lines on the real allowlist (`node --test scripts/rename/rename.test.mjs`)                    |

CI's static job and `pnpm verify` run the guard and the self-test. The guard is a root script, not
a package test, so turbo never replays a cached pass after a change elsewhere in the tree.

## List format (allowlist and step files)

```text
# comment
== <step>: <reason>                 a group; <step> is permanent, provisional or RN-2..RN-9
<glob>... /<regex>/[i]              an entry: matched line by line in the selected files' contents
path <glob>... /<regex>/[i]         an entry: matched against the file's path
```

Globs are repo-relative (`**`, `*`, `?`, `{a,b}`; a leading `!` excludes). An entry covers an
occurrence of `kobe` (any case) when one of its regex matches spans all four letters. Every
tracked file is scanned, binary files too (read as latin1; text that is not valid UTF-8 counts as
binary; a symlink as its target), so a binary that gains the name needs a deliberate entry. The
script never rewrites a binary file or a symlink: a step that would is refused. Generated files (lockfile, licence inventories, snapshots) are scanned like any
file; their entries say which command regenerates them.

**What is kept.** Anything persisted in an existing install (database rows and constraints, object
names in the cluster, S3 keys, signed strings, lock keys, audit names, values in external
repositories or services) is `permanent`, or needs an explicit migration owned by a named step.
When unsure, it is `provisional` with a question for the owner in the group name (`(Qn)`):
held exactly like permanent until answered, but `guard.mjs --final` fails while any remains.
Kept groups protect file paths as well as contents: their content entries also match paths
(applied migrations, `kobe.skill.yaml` manifests, ledger file names).

**Ownership.** Allowlist groups are checked top to bottom; the first entry that covers an
occurrence owns it. `permanent` groups come first, then `provisional` (the guard refuses otherwise). Specific steps sit
above the generic ones (RN-3 identifiers, RN-2 prose, then the `Triage:` tails), so the file reads
bottom-up in the order of work. `--report` prints totals per step and per group; `--tokens` lists
unowned occurrences by area and word.

## How a step uses it

1. Narrow your step's list: `node scripts/rename/rename.mjs --step RN-n` shows what the step would
   change and what the allowlist gives the step that its patterns leave alone ("left for hand
   edits": the `Triage:` and `Generated:` groups, or a missing pattern). Turn the `Triage:` groups
   of your step into precise patterns (step file and allowlist groups together), or move entries to
   another step or to `permanent` with a reason; never widen a permanent entry silently.
2. Apply: `node scripts/rename/rename.mjs --apply --step RN-n`. It rewrites contents (staged) and
   moves paths with `git mv`. An occurrence changes only where the step's pattern matches it, the
   allowlist owns it in a group whose header the step file repeats, and no kept entry covers it;
   only the four letters change, keeping case (Kobe → Kaiju, kobe → kaiju, KOBE → KAIJU). A second
   run changes nothing. It is all or nothing: it first refuses when an earlier step still has
   allowlist groups (steps run strictly in order), the tree is not clean, a binary or symlink
   would be rewritten, a target path exists or collides (case-insensitive), or a renamed file's
   references stay old because another step (or a left-out group) owns them, so the PR would not
   build on its own (`--conflicts` lists them; Markdown and generated files are only reported).
   If anything fails while writing, it resets to HEAD.
3. Do the hand work named at the top of the step file (fallbacks, regenerated files, config).
4. Delete the step's groups from `allowlist.txt` and run `node scripts/rename/guard.mjs`: anything
   it still reports is either a miss (rename it) or a deliberate exception (an entry with a
   reason). Then the usual checks, CI and e2e.

At the end only `permanent` groups remain (`node scripts/rename/guard.mjs --final`): that list is
the definition of done (spec §8.2).
