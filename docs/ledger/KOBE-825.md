# KOBE-825: RN-12: skill manifest kaiju.skill.yaml for new skills; kobe.skill.yaml still read

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-130-rename-12-manifest` in `../Kobe-g130`, stacked on
  `group-129-rename-11-spec` (KOBE-824, PR #726)
- **Spec:** `docs/specs/rename-kaiju.md` §11 answer A2 (accept both names); tooling
  `scripts/rename/README.md`

## What changed

- **Narrowed before the apply** (commit `chore: KOBE-825 narrow RN-12`): step patterns written
  (`scripts/rename/steps/RN-12.txt`), and the built-in packages' own manifest paths
  (`services/server/builtin-skills/*/kobe.skill.yaml`) moved to the RN-20 group (see Decisions).
- **Scripted** (`rename.mjs --apply --step RN-12`, its own commit): 240 occurrences in 89 files
  (comments, messages, UI labels, tests, the e2e manifest spec, operator and guide docs, the
  `compatibility.kobe` key in the protocol schema and fixture).
- **Hand work, protocol** (`packages/protocol/src/skill-package/layout.ts`):
  `MANIFEST_PATH = "kaiju.skill.yaml"`, `LEGACY_MANIFEST_PATH = "kobe.skill.yaml"`,
  `MANIFEST_PATHS`, `isManifestPath`, `manifestPathIn` (which name a file set holds, new first),
  `manifestWritePath`. `packageFileRole` gives both names the `manifest` role, so the runtime
  payload (what sandboxes get) excludes both and the package hash includes whichever is there.
  Both names are reserved root names (case variants refused). New problem code `two_manifests`
  (reported on the old name's path) when a set holds both.
- **Compatibility field** (`manifest.ts`): `compatibility` accepts `kaiju` (current) and `kobe`
  (pre-rename). Rule when both are present: equal ranges are accepted, different ones are refused
  (issue at `compatibility.kobe`, "keep compatibility.kaiju only"). Nothing reads the range today
  (informational) and nothing Kaiju generates writes it (the model-drafted manifest takes no
  `compatibility`), so no writer changed.
- **Server readers:** `bundle.ts` `readManifestIn(files, name)` reads either name and refuses
  both with `TWO_MANIFESTS_MESSAGE` (code `invalid_manifest`); `validateZipBundle` (upload,
  import, Workbench save and test, Site catalog edits, Kaiju package set) and
  `classifyStoredZip` (hash recompute) use it; messages name the file actually read. Edits keep
  the manifest where it is: Save version's number (`manifest-sync.ts`), a fork's rename
  (`fork.ts`), bump advice (`bump.ts`). "Create kaiju.skill.yaml" (draft route and Promote panel)
  refuses when either name exists and writes the new name. The model call's file list, the
  review diff's reading order and the export's manifest check (`skill-store.ts`, which refuses
  a stored package holding both as legacy `two_manifests`) take either name. Publish and
  promote-check messages say "the manifest".
- **Web:** Workbench new-path check explains `two_manifests`; the draft's Create-manifest offer
  hides when either name exists; the SKILL.md lint treats either name as a package path.
- **Unchanged on purpose:** schema id `kobe.dev/skill/v1` (permanent group); the skill-scan
  image (`images/skill-scan`) scans whatever files it is given and never names the manifest;
  the sandbox agent and Pi load the runtime payload, which never held a manifest (no
  `*.real-pi.test.ts` reads one; checked `kaiju-tools.skill-draft.real-pi.test.ts`); the git
  mirror and registry write the stored package bytes as they are.

## Decisions

- **Built-in packages stay `kobe.skill.yaml` here; RN-20 (KOBE-833) renames them.** Renaming a
  built-in's manifest changes its package hash (`kaiju-packages.test.ts` pins every published
  version's hashes, and a Site refuses other bytes under a published version), so it needs a new
  version of every built-in. RN-20 already publishes new versions of all of them under the new
  name (with an eval); doing it here would publish eight versions whose only change is the
  file name, then eight more. They are read like any old package meanwhile. No built-in's
  content names the manifest (checked), so none writes the old name. The brief asked to update
  them here; this is the one deliberate deviation.
- **Stored packages are never rewritten.** S3 packages, Registry versions and downloaded exports
  keep `kobe.skill.yaml`; the golden vector with the old name still hashes to its old value
  (kept, and a new vector for the new name appended: `skill-hash-vectors.ts`).
- **Edits write where the file is,** new manifests under the new name: a pre-rename draft keeps
  `kobe.skill.yaml` until its author deletes it (no rename operation exists in drafts).
- **Edge accepted:** a package stored before this release with an ordinary payload file named
  `kaiju.skill.yaml` (the name meant nothing then) is now read as a manifest; with
  `kobe.skill.yaml` beside it, export refuses it as legacy `two_manifests`. Hash-check rows are
  written once, so existing rows don't move.

## Allowlist

- RN-12 group removed. New permanent group "The skill manifest's pre-rename names, read
  everywhere next to the new ones": the protocol constant and schema key, the readers' messages
  and comments, the old golden vector, `docs/skill-package.md`, the guide pages and the tests that
  read the old names; file-scoped entries only.
- The built-in manifest path entry moved to RN-20; `rename.test.mjs` sample owner updated.

## Docs evaluation

Members and agents see the manifest name in the Workbench, the Promote panel and the guide, so
the guide changes in this PR (ac-3):

- `docs/guide/agents/skills.md` (`kaiju.skill.yaml` section): the old names still work
  everywhere, new files use the new names, a skill with both files is refused, both
  compatibility keys must agree.
- `docs/guide/whats-new.md` ("Kobe is now Kaiju"): a paragraph for skill authors.
- `docs/skill-package.md` (contract): both names, never-rewritten packages, `two_manifests`, the
  compatibility rule, the built-ins until KOBE-833.
- UI labels ("Create kaiju.skill.yaml") renamed by the script; the guide matches.
- No "For agents" page names the manifest (checked `docs/guide/for-agents/`), so none changes.

## Evidence (TMPDIR=~/tmp)

- `pnpm build`, `typecheck`, `lint`, `format:check`: pass.
- Unit suites: protocol 1392 passed; server 4593 passed (8 skipped); web 4314 passed;
  sandbox-agent 1294 passed (196 skipped: real-Pi tests run in CI only). skill-scan has no unit
  suite (its `test-image.sh` needs the built image; nothing in it names the manifest).
- Server DB suite (`test:db`): first run 3746 passed, 5 failed, all tests that edited a
  built-in's manifest as `kaiju.skill.yaml` or matched the old publish message; fixed (they now
  edit the manifest where it is, `manifestWritePath`), the three files rerun: 34 passed.
- `check-public-hygiene.sh`, `check-site-wording.mjs`, `rename/guard.mjs`,
  `node --test scripts/rename/rename.test.mjs` (24 passed): ok.
