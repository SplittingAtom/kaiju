# KOBE-824: RN-11: record the owner's rename answers of 2026-11-24; regroup the provisional allowlist

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (branch only; no push, no PR)
- **Branch / worktree:** `group-129-rename-11-spec` in `../Kobe-g129`, on main `3f1ae3d2` (after
  #723, KOBE-752)
- **Spec:** `docs/specs/rename-kaiju.md` (amended here, new §11); tooling `scripts/rename/README.md`

## ac-1: spec amended

- New §11 "Owner answers 2026-11-24": all 15 answers (A1–A15) with the step that owns each.
- §10 tickets table gains RN-11..RN-20 (KOBE-824..833) and the order of work.
- §3 "changes" gains item 9 (stored names members or agents see, per §11); "stays" now lists the
  specs of earlier lanes (A1), names held outside the database (Bifrost names, git trailers), the
  Kubernetes label keys (A9, with the selector label value and database name of KOBE-750) and the
  existing install's namespace prefix (A15, KOBE-751). §1, §5 (database: the §11 data migrations)
  and §7 (label keys out of scope) follow.
- **`kobe-models/*` correction** (§2 table and §3 stays 3): `git grep kobe-models` outside ledgers
  finds only the spec itself and two older specs that name the in-sandbox Pi extension's directory
  (`kobe-models/register.ts`, renamed `kaiju-models` in RN-3). No migration under
  `packages/db/drizzle`, schema or catalog code holds it. The stored model names are the Bifrost
  provider/key/customer names (`kobe-${providerId}-<fp>` in `services/server/src/models/desired.ts`,
  `kobe-site`, `kobe-install`: permanent), `kobe-local/...` model ids (RN-15) and the Pi provider
  id `kobe` (RN-14).

**Question numbering.** The KOBE-745 "Open questions" list differs from the answer list from item
12 on: its item 12 is the `kobe-models/*` claim (no answer needed; corrected above), its item 13
the gallery agent (A13), and the built-in skills/prompts question exists there only as allowlist
group Q12 (added in review round 2). Mapped by subject; allowlist groups Q1–Q13 match A1–A13.

## ac-2: allowlist regrouped

| Was | Now              | Was | Now              |
| --- | ---------------- | --- | ---------------- |
| Q1  | permanent        | Q7  | RN-17 (KOBE-830) |
| Q2  | RN-12 (KOBE-825) | Q8  | RN-18 (KOBE-831) |
| Q3  | RN-13 (KOBE-826) | Q10 | RN-19 (KOBE-832) |
| Q4  | RN-14 (KOBE-827) | Q11 | RN-19 (KOBE-832) |
| Q5  | RN-15 (KOBE-828) | Q12 | RN-20 (KOBE-833) |
| Q6  | RN-16 (KOBE-829) | Q13 | RN-18 (KOBE-831) |

Q9 (label keys) was already permanent (KOBE-750). No `provisional` group remains.

- **Step registration** (`scripts/rename/lib.mjs`): `STEPS` is RN-2..RN-8, RN-12..RN-20, RN-9.
  RN-9 (fresh install with restore) moves last so it checks every migration on restored data;
  the guard's order check and `--apply`'s earlier-step refusal use this order. RN-10 and RN-11 are
  not registered: neither owns allowlist groups, and a registered step without groups counts as
  done, so RN-10 (next release) would always be "done out of order". Group headers may name the
  ticket (`== RN-13 (KOBE-826): ...`); the header regex is built from `STEPS`.
- **Step files** `scripts/rename/steps/RN-12.txt`..`RN-20.txt`: the group headers only, no
  patterns. Each ticket writes its patterns and moves the old names its migration and read-both
  fallbacks keep into a permanent group.
- **Path entries**: kept groups also owned file paths; step groups do not, so four `path` entries
  were added (`kobe.skill.yaml` manifests to RN-12, two `kobe-builtin-*.db.test.ts` to RN-13, the
  gallery agent files to RN-18, `kobe_rules.py` to RN-20).
- **Ownership check**: occurrence owners compared before and after with a scratch script. Moving
  from one kept bucket to separate steps exposed three mis-owned spots, fixed by narrowing:
  `/home/kobe` (16 lines) went to the connector group through its `/kobe"` route pattern (now
  `(?<!…|\/home)`, so it goes to RN-17 with the Unix users); `.kobe/<name>` in `stamps.ts` matched
  the branch prefix (now `(?<!\.)`, stays RN-14); the stored `builtin = 'kobe'` connector kind
  stays with RN-13 (dropped `builtin` from the RN-18 enum keyword list). The built-in
  `kobe-guide/SKILL.md` lines that name the connector now belong to RN-20 (pinned skill bytes need
  a new version) instead of RN-13. `--pairs` reports no split value.
- File order: step groups read bottom-up in the order of work (RN-9 on top, RN-12 last).
- README: step order, header format.

## Docs evaluation

No guide change: this ticket amends a spec and the rename tooling only. Nothing a member, admin or
in-sandbox agent sees or can do changes; the guide changes belong to RN-12..RN-20 as they rename.

## Evidence (TMPDIR=~/tmp)

- `node scripts/rename/guard.mjs`: ok, 37,707 allowed occurrences, 200 entries.
- `node scripts/rename/guard.mjs --final`: 12 groups not done, all real steps: RN-9 (1), RN-20 (1),
  RN-19 (2), RN-18 (2), RN-17, RN-16, RN-15, RN-14, RN-13, RN-12 (1 each); no provisional group.
- `node --test scripts/rename/rename.test.mjs`: 24 pass (new test: step order RN-12..RN-20 before
  RN-9, ticket in headers, RN-10/RN-11 refused, out-of-order cases).
- prettier check on the changed files, `scripts/check-public-hygiene.sh`,
  `scripts/check-site-wording.mjs`: pass.
