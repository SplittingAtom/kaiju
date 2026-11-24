# KOBE-821: Dependabot wave, safe patch and minor bumps

- **Branch / worktree:** `group-116-deps-wave` in `../Kobe-g116` (not pushed; the coordinator lands it)
- **Closing the PRs:** after merge, close the applied PRs (#659, #657, #636, #634, #633, #553, #546, #545, #544) and
  note the reason on the dropped and held ones.

## Applied

| PR   | Package                | From → to       | Notes                                                                                                                                                     |
| ---- | ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #659 | @aws-sdk/client-s3     | 3.1164 → 3.1172 | Range raised to `^3.1172.0` in `services/server` and `packages/cli` (the CLI was on `^3.1147.0`).                                                         |
| #657 | @aws-sdk/lib-storage   | 3.1164 → 3.1172 | Same version as client-s3.                                                                                                                                |
| #636 | openid-client          | 6.8.8 → 6.9.0   | Adds `getDecryptedResponses`, `exactOptionalPropertyTypes` typing fix. 6.9.1 is out; the PR's version is used.                                            |
| #634 | typescript-eslint      | 8.72.1 → 8.73.0 | Lint clean.                                                                                                                                               |
| #553 | tailwindcss            | 4.3.3 → 4.3.5   | `@tailwindcss/postcss` stays 4.3.3 (the PR did not touch it); web build and suite green.                                                                  |
| #633 | numpy (sandbox image)  | 2.5.4 → 2.5.5   | `requirements.in` and `requirements.txt` (hashes: all 66 files of the release, from PyPI, same count as before). Needs Python >= 3.12, the image is 3.12. |
| #546 | pandas (sandbox image) | 3.1.0 → 3.1.1   | Same; all 58 release hashes. Pandas requires numpy >= 2.0.2.                                                                                              |
| #545 | docker/login-action    | 4.7.0 → 4.8.0   | `publish.yml`, pinned by sha `8aa5831f...` with the version comment, as before.                                                                           |
| #544 | azure/setup-helm       | 5.0.1 → 5.1.0   | `ci.yml`, `e2e.yml`, `publish.yml`, pinned by sha `2f5e7bc6...` with the version comment.                                                                 |

Licences: `pnpm licenses:update` (THIRD_PARTY_LICENSES.md; NOTICE unchanged), `images/sandbox/third-party-licenses.json`
edited by hand for the two Python versions (same names, same licence classes). `collect-licenses.sh` was not re-run against
the image, so a CI diff on bundled native-library notice text in numpy 2.5.5 is possible; refresh with the command in
`docs/licensing.md` if CI reports one. `pnpm license:check` passes.

## Dropped

| PR   | Package                                 | From → to         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | --------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #660 | jose (server dev dep, better-auth peer) | 6.2.12 → 6.2.18   | `account-lifecycle.db.test.ts` "deactivation ends every session, blocks every sign-in method" fails: after deactivation a passkey sign-in answers 400 `AUTHENTICATION_FAILED` where 403 is expected (the sign-in is still refused). Reverting only jose makes it pass again, so the change is inside better-auth's use of jose (6.2.13 to 6.2.18 changelogs: stricter option and key checks, `alg` required on AKP keys, preserved error causes). An auth-path behaviour change, not small. Needs: find which jose release changes the passkey error, then decide with the owner whether the new code is acceptable (update the test) or better-auth must move first.                                                                                     |
| #658 | @assistant-ui/react                     | 0.15.26 → 0.15.37 | Breaks 11 web tests in 6 files (composer Lakehouse drop chips, @ picker and / menu `aria-expanded`, thinking-level pills, Archived node focus, file-editor Edit and Regenerate buttons); a type change also makes `ThreadListAdapter.unarchive` optional. It also pulls core 0.3.25 → 0.3.38, store, tap, assistant-stream and assistant-cloud. Release notes name an `aria-expanded` omission on the composer input and focus-guard and viewport changes; several failures are not explained by those. Not small or obvious. Baseline passes, and the suite passes again with 0.15.26 and the original transitive lock. Needs: bisect the patch releases (0.15.27 to 0.15.37), then the Playwright composer, thread-list and file-editor specs on gate1. |

## Held for the owner (not applied)

| PR   | Package                                               | Reason and what testing it needs                                                                                                                                                                                      |
| ---- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #558 | Pi 1.4.0 → 1.5.2                                      | Pi stays on 1.4.x. Needs the RPC protocol check, `test-image.sh` pi section and a gate1 conversation with tools.                                                                                                      |
| #638 | minimatch 11 + Pi 1.5.2                               | Held whole. minimatch 11 is Pi 1.5's own dependency (the lock also swaps `grok-mermaid` for `lovely-mermaid` and moves undici); forcing it under Pi 1.4 would be an unsupported major override. Same testing as #558. |
| #637 | @opentelemetry/exporter-trace-otlp-http 0.223 → 0.301 | OpenTelemetry major jump. Needs the telemetry tests plus a real OTLP export check against a collector, and the 0.200 pinned copy used by assistant-cloud kept in mind.                                                |
| #551 | @opentelemetry/core 2.12 → 3.1                        | Major; must move together with the SDK packages (#637). Same testing.                                                                                                                                                 |
| #419 | happy-dom 20 → 21                                     | Major; test environment for the whole web suite (4288 tests). Needs a full web run and a review of any DOM behaviour changes.                                                                                         |
| #302 | mermaid 11 → 12                                       | Major; rendering of diagrams in chat and the Files panel. Needs a visual check in the browser and the mermaid-related specs.                                                                                          |
| #548 | duckdb 1.5.6 → 2.0.0                                  | Major; storage format and API of the sandbox data stack. Needs `test-image.sh` duckdb checks, notebook and Lakehouse paths, and a check that saved database files still open.                                         |
| #547 | pyarrow 25 → 26                                       | Major; must match duckdb and pandas compatibility. Needs the image checks and a parquet read/write round trip.                                                                                                        |
| #656 | pypdf 6.21.4 → 7.1.1                                  | Major; PDF reading in the sandbox. Needs a text-extraction check on sample PDFs and the image checks.                                                                                                                 |

## Verification

Build, typecheck, lint, format:check, `license:check` and `scripts/check-public-hygiene.sh` pass. Unit suites: server, cli and web all
green (counts in the commit message). `@kobe/server test:db` green except the jose case above, which led to dropping #660.
Sandbox image built on the remote Docker host with plain `docker build -f images/sandbox/Dockerfile` and
`images/sandbox/test-image.sh` passed (15 checks, including the data stack imports and duckdb queries); the test image was
removed afterwards. Trivy was not run; CI must prove it.

## User guide

No change: all applied bumps are patch or minor with no change to anything a member, admin or in-sandbox agent sees or can
do. The sandbox data stack moves one patch release (numpy, pandas); the guide names no versions of either.
