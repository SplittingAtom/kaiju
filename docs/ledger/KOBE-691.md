# KOBE-691: Security dependency refresh (review SEC-2, SEC-13)

- **Status:** in review (group 50, branch `group-50-sec-platform`)
- **Branch / worktree:** `group-50-sec-platform` in `../Kobe-g50`
- **Depends on:** none

## Plan

Bump the runtime npm packages behind security fixes, refresh the base-image digests (one python
digest for all three Python images), pin ClamAV by digest, bump the image Python/npm pins with
fixed advisories, group Dependabot's docker updates, refresh every license inventory.

## Decisions

- npm: zod `^4.6.7` everywhere (Dependabot #549's bump), nodemailer `^10.5.0` (#554), next
  `^16.4.5` (resolves 16.4.6), hono `^4.13.16` (resolves 4.13.19); transitive dompurify 3.4.18,
  ip-address 10.7.6 and vite 8.3.8 through `pnpm update -r`. Dev: happy-dom `^21.0.4` (the web
  suite passes on it: 426 files, 3815 tests), `@playwright/test` 1.55.1 in `e2e/browser`.
  The coordinator's Playwright runner container is `v1.55.0-noble`: move it to `v1.55.1-noble`
  with the next gate1 browser run.
- Left as is (no fix inside a compatible range, moderate/low, not reached): katex via mermaid
  (needs mermaid's own bump, Dependabot #302), `@opentelemetry/core` 2.0.0 via assistant-cloud,
  esbuild 0.18 via drizzle-kit, minimatch 10 via typescript-eslint (dev).
- Base digests (resolved with `docker buildx imagetools inspect`, multi-arch index digests):
  node:24-slim `dc26ae92…` (Node 24.22.3), node:22-trixie-slim `68c76cfa…` (22.23.5),
  python:3.12-slim-trixie `5e2bdb1b…` (3.12.16) for sandbox, orbit-eval and skill-scan.
- ClamAV: new `clamav.image.digest` (index digest of `1.4` on 2026-11-20, `b7357e2c…`); an empty
  digest falls back to the tag (for mirrors that re-tag). Schema and chart test added.
- Sandbox: tornado 6.6.1. (Pi's minimatch override to 11.0.5 was reverted in review, see
  below.)
- orbit-eval (`ci/orbit/requirements.txt`): fsspec and s3fs 2026.6.0 (s3fs pins fsspec exactly),
  urllib3 2.8.0, soupsieve 4.0.0, multidict 6.9.1.
- skill-scan: filelock 4.2.1, multidict 6.9.1, litellm 1.100.5. litellm 1.95.0 (the review's
  "fixed" version) carries GHSA-7hp6-4w63-5g45 (HIGH, introduced 1.91.0, fixed 1.100.4), so 1.100.5
  is the first release clear of both; it adds boto3/botocore/s3transfer/jmespath/
  python-dateutil/six and pydantic-settings, hashed from `uv pip compile --generate-hashes
--exclude-newer 2026-11-06`. All three Python locks still resolve together (`uv pip compile` of
  the pins, x86_64 linux, py3.12).
- multidict 6.9.1 keeps its free-text "Apache License 2.0" label: the version-pinned approvals
  (6.7.1) are Chris's, so the 6.9.1 entries in orbit-eval and skill-scan are `pending: gate review`.
- Dependabot: orbit-eval and skill-scan added to the docker entry; groups `node-base` and
  `python-base` with `group-by: dependency-name` (one PR per base image across directories).
  Caveat: the Dockerfiles take the base from `ARG NODE_IMAGE=…@sha256`; Dependabot has never opened
  a digest PR for them (review part 1), so it may not parse ARG defaults. KOBE-692's weekly audit
  is the backstop; worth a check after the next Dependabot run.
- Docs: no member/admin/agent-visible change. ClamAV's digest is documented in `values.yaml`
  next to the key; docs/install.md has no ClamAV image section to update.

## Review follow-up (coordinator, 2026-11-20)

- **Pi's minimatch override reverted.** The image's `pi` is `dist/bundle/cli.js`, and Pi's
  bundle inlines its own minimatch (only the unbundled `dist/core` imports the package), so the
  npm override changed the inventory and the scanners' view but not the code Pi runs in RPC mode.
  Back to Pi's exact pin (minimatch 10.2.6, GHSA-g3hv-75wg-m249, moderate, inside the sandbox
  only); the fix comes with a Pi release whose bundle carries minimatch >= 11.0.1 (check at the
  next Pi bump, Dependabot #558). Hence no glob check in test-image.sh: there is no override left
  to guard. The OSV audit lists it as MODERATE (not failing).
- **Decision (Chris, 2026-11-20): Trivy gate on fixable HIGH for the Node service images.** In
  `publish`, server, mcp-proxy, egress-proxy, model-gateway and web fail on a fixable HIGH or
  CRITICAL (matrix `gate`); sandbox, orbit-eval and skill-scan stay CRITICAL-only with HIGH
  reported. docs/development.md updated. Today's service images (built from this branch, Trivy
  latest, `--ignore-unfixed`): no fixable HIGH or CRITICAL in any of the five.

## Open questions (for Chris or the coordinator)

- Approve multidict 6.9.1 (orbit-eval, skill-scan) at the next gate review.

## Evidence (acceptance criteria → test or command output)

- ac-1: `pnpm audit --prod`: 2 findings (1 moderate `@opentelemetry/core`, 1 low katex), no high
  or critical; `pnpm audit` (dev too): no high or critical.
- ac-2: all five Node service Dockerfiles on `dc26ae92…`; sandbox on `68c76cfa…` + `5e2bdb1b…`;
  orbit-eval and skill-scan on `5e2bdb1b…`.
- ac-3: `charts/kobe/tests/render.test.ts` "pins the image by tag and digest".
- ac-4: `scripts/osv-audit.mjs` (KOBE-692) over the sandbox, Pi, orbit and skill-scan pins:
  0 advisories (before: 10 HIGH). Images built on the remote Docker host; `collect-licenses.sh` +
  `inventory-cli image-report` refreshed the three `third-party-licenses.json`;
  `pnpm licenses:update` regenerated THIRD_PARTY_LICENSES.md and NOTICE. The images' own
  acceptance scripts pass on those builds: `images/sandbox/test-image.sh` (78 ok),
  `images/skill-scan/test-image.sh` (litellm 1.100.5, filelock 4),
  `images/orbit-eval/test-image.sh` (soupsieve 4, fsspec 2026.6).
- ac-5: `.github/dependabot.yml` groups.
- ac-6: `pnpm verify` green locally (format, lint and typecheck in one run; the tests re-run
  with `--concurrency=2` after two skill-scanner timeouts under the shared machine's load, then
  license:check, hygiene and wording); images and license:check in CI after the push.
