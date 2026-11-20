# KOBE-692: Scheduled dependency audit in CI (SEC-3)

- **Status:** in review (group 50, branch `group-50-sec-platform`)
- **Branch / worktree:** `group-50-sec-platform` in `../Kobe-g50`
- **Depends on:** KOBE-691 (same branch: the pins it audits are clean after it)

## Decisions

- `.github/workflows/security-audit.yml`: weekly (Monday 05:41 UTC), `workflow_dispatch`, and on
  pushes to `main` that change the workflow or its script. `permissions: contents: read`, actions
  pinned by SHA (the same pins as the other workflows), `persist-credentials: false`.
- Two audits, both always run, one verdict step: `pnpm audit --prod --audit-level high` and
  `scripts/osv-audit.mjs` over the sandbox Python lock, Pi's lockfile, the orbit-eval and
  skill-scan Python locks and `e2e/browser`'s lockfile. The job fails (GitHub's failed-run mail
  is the alert); no issue is opened, so the job needs no write token.
- `osv-audit.mjs` (node, no dependencies): OSV `querybatch`, then each advisory's GHSA rating
  (followed through aliases, since PYSEC entries carry none), else the highest CVSS v3 base
  score; UNKNOWN is listed but does not fail. Only names and versions are sent. Tests:
  `scripts/osv-audit.test.mjs` (`node --test`, run by the workflow).
- ac-3 (secret scanning, push protection, Dependabot alerts in the repo settings) is the
  owner's; not done here.
- Docs: docs/development.md CI table gains the workflow. No user-facing change.

## Open questions (for Chris or the coordinator)

- Owner: enable secret scanning, push protection and Dependabot alerts/security updates.

## Evidence (acceptance criteria → test or command output)

- ac-1: run locally on the pre-KOBE-691 locks: `osv-audit: 182 pins, 30 advisories, 10 HIGH or
CRITICAL` (exit 1); on the current pins: `359 pins, 0 advisories` (exit 0). `node --test
scripts/osv-audit.test.mjs`: 5 passed.
- ac-2: workflow header (`permissions: contents: read`, SHA-pinned actions).
- ac-3: OWNER.
