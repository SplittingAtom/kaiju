# KOBE-837: Docs page shows the running build next to the guide title

- **Status:** in review (not pushed; the coordinator opens the PR)
- **Branch / worktree:** `group-128-build-info` in `../Kobe-g128`
- **Depends on:** none

## Plan

Bake the build facts into the web (and service) images as build args that become runtime ENV,
read them on the server per request, validate them and show them beside the guide title.

## Decisions

- **Names:** `KAIJU_BUILD_SHA` (commit, hex), `KAIJU_BUILD_DATE` (ISO 8601 with offset),
  `KAIJU_BUILD_VERSION` (optional, `[v]X.Y.Z[-pre]`). New names, so no `KOBE_*` alias (RN-4).
- **Runtime, not inlined.** `ARG` + `ENV` at the end of the runtime stage of `apps/web/Dockerfile`
  and `services/Dockerfile` (last layer, so a new commit rebuilds only that layer). Not
  `NEXT_PUBLIC_*` and not in `next.config.ts` `env`. `apps/web/lib/build/build-info.ts`
  (`currentBuildInfo()` reads `process.env`) is called by the docs page server component
  (`app/docs/[[...slug]]/page.tsx`, which also calls `connection()` so it is never prerendered)
  and passed to `GuideView` as a prop. Unrelated to KOBE-487's `KAIJU_BUILD_ID` (inlined).
- **Validation:** sha `^[0-9a-f]{7,40}$` (case-insensitive, shown lower case, first 12); date must
  match ISO 8601 with time and offset and parse; otherwise "Development build". A malformed version
  is dropped, the build still shows. React escapes the text anyway.
- **Format** (muted `text-xs`, real text, `<time dateTime>`):
  `Build 1e6fff80abcd · 2026-11-24 14:03 UTC`, with a version
  `Version 1.4.0 · Build 1e6fff80abcd · 2026-11-24 14:03 UTC`, else `Development build`.
  Home: beside the `<appName> guide` h1. Guide pages: on the section line above the page title.
- **Date in publish.yml: the commit time** (`git log -1 --format=%cI "${GITHUB_SHA}"`), not the
  run start: a re-run of the same commit gets the same args, so the scan build and the push build
  (and re-runs) reuse the cache. The shallow checkout has the commit, so this works.
- **Which images:** `build-info: true` on web and all four Node services (they share
  `services/Dockerfile`); not the sandbox. No version is passed (publish runs on main, no releases).
- **Server:** args/ENV only; nothing reads them yet (no trivial existing endpoint to extend
  without an API/protocol change).
- **Other image builds unchanged:** the args default to empty, so `scripts/check-images.sh`,
  `e2e.yml`, the Tiltfile and the sandbox/orbit-eval/skill-scan workflows build as before
  (and show "Development build").
- **Coordinator action, gate1 deploy script** (`~/.kobe-coord/deploy-gate1.sh`): add to the web
  and services `docker build` lines
  `--build-arg KAIJU_BUILD_SHA="$(git rev-parse HEAD)" --build-arg KAIJU_BUILD_DATE="$(git log -1 --format=%cI)"`
  (optionally `--build-arg KAIJU_BUILD_VERSION=<x.y.z>`). Without them gate1 shows "Development build".

## Docs evaluation

Members see a new line on the guide, so the guide changes: `docs/guide/reference/troubleshooting.md`
(Account, "Which version of Kaiju is running?") says where to find the build and how to read it;
it also reaches agents through `/llms-full.txt` and the page's `.md`. Developer docs:
`docs/development.md` "Building images by hand" documents the args for local builds. The build
line itself is not added to the llms/markdown output (not cheap: that output is built from the
bundled guide, and agents can ask the user).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/docs/build-line.test.tsx` (values present, version, missing →
  "Development build", garbage rejected; GuideView home and page), `apps/web/lib/build/build-info.test.ts`.
- ac-2: `apps/web/lib/build/build-info-images.test.ts` (both Dockerfiles declare the args and
  runtime ENV, no `NEXT_PUBLIC_`; publish.yml passes sha and commit date to web and server).
- ac-3: troubleshooting FAQ entry; this ledger's coordinator action.
- Checks run (TMPDIR=~/tmp): build, typecheck, lint, format:check, web unit suite,
  check-site-wording, check-public-hygiene, rename guard: see the commit's report.
