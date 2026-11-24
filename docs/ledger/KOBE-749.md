# KOBE-749: RN-5: headers, cookies, browser storage keys, telemetry attribute names

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (no PR yet; branch only)
- **Branch / worktree:** `group-123-rename-5-wire` in `../Kobe-g123`, stacked on `group-122-rename-4-env` (KOBE-748, PR #719)
- **Spec:** `docs/specs/rename-kaiju.md` §3 changes 6 and 8, §4 step 5; tooling `scripts/rename/README.md`

## What changed

- **Narrowed before the apply** (commit `chore: KOBE-749 narrow RN-5`): the span attribute
  `kobe.team_id` shares its spelling with the Postgres setting, so the permanent settings entry
  held it in telemetry code too; the entry now excludes the nine telemetry files (spans, memory
  learn pass, trace frames and their tests, `docs/tracing.md`) and RN-5 renames them. The step
  file now repeats every RN-5 allowlist group, so nothing was "left for hand edits".
- **Scripted** (`rename.mjs --apply --step RN-5`): 855 occurrences in 342 files. RN-5 groups
  deleted from the allowlist.
- **Misfiled names renamed by hand:** `kobe.turn.index`, `kobe.compaction.*`, `kobe.app_call.*`
  (span attributes, held by the Q4 group meant for Pi custom entry types: removed from it), the
  theme cookie `kobe-theme` (held by an RN-6 Kubernetes-name pattern: removed from it), the
  session-storage key `kobe.reload-drafts` (Q4) and the local-storage keys `kobe.learn-hint.v1`,
  `kobe.learn-nudge.v1` (matched the permanent `kobe.*.v<n>` schema-id pattern only by shape).
  `service.name` of relayed sandbox spans and of OTLP audit forwarding (`kobe-sandbox-agent`,
  `kobe-server`, held by the RN-6 image group) and the e2e 42 assertions on them
  (`services=kaiju-model-gateway,kaiju-sandbox-agent,kaiju-server`, the escaped
  `kaiju\.tool\.(input|output)` content-key regex).

## Decisions

- **ac-1 amended (coordinator, review round 1 MEDIUM):** for this release senders send **both**
  the new and the old header name and receivers accept either, so a rolling `helm upgrade` has no
  window where a new sender meets an old receiver (or the reverse); "send only the new names"
  applies from KOBE-754 on, which deletes the old names in one place.
- **Internal headers: both names both ways for one release.** One map in
  `packages/protocol/src/legacy-headers.ts` (`LEGACY_HEADER_NAMES`; receivers `readRenamedHeader`,
  `withRenamedHeaders`; senders `withLegacyHeaderNames`, `setRenamedHeader`); the new name wins
  when both arrive. Senders: web (`teamHeaders`/`setTeamHeader` in `lib/teams.ts`), mcp-proxy and
  egress-proxy → server (sandbox token), server → gateway (server-call token, chat and
  embeddings), sandbox agent → mcp-proxy (thread header in Pi's MCP config) and the kobe-models
  extension → gateway (run id and token; the extension mirrors the old names, pinned by a test).
  Security kept: the sender helper always overwrites or drops a value already under an old name,
  the extension drops Pi-config copies of its own headers under both names, the gateway
  normalises and drops old names before every check and forwards an allowlist only, and
  mcp-proxy forwards neither thread header upstream (tested).
  - server: `x-kaiju-team` / `x-kobe-team` (`teamHeaderOf` in `authz/middleware.ts`, both read
    sites); `kaiju-sandbox-token` / `kobe-sandbox-token` on the internal MCP and git routes
    (`sandboxTokenOf` in `mcp/principal.ts`; senders are mcp-proxy and egress-proxy);
  - mcp-proxy: `kaiju-thread-id` / `kobe-thread-id` (Pi's MCP config, written by the agent);
  - model-gateway: `x-kaiju-run-id`, `x-kaiju-run-token`, `x-kaiju-server-call` and their old
    names, normalised once per request (`req.headers = withRenamedHeaders(...)`), so the
    attribution, the server-call/sandbox mixing check and the strip-before-Bifrost logic read
    only new names (old names are dropped, never forwarded);
  - egress-proxy receives none of them (it only sends the sandbox token to the server).
- **Response headers crossing a version boundary are sent under both names for one release:**
  the workspace file's `x-kaiju-workspace-entry` (server → sandbox agent; an old sandbox image
  runs until its template is reconciled and the sandbox restarts) and the skill export's
  `x-kaiju-sha256` (read by API clients). The sandbox agent also reads the old entry header (a
  new sandbox talking to an old server pod mid-rollout).
- **Span attributes of older sandbox agents:** trace frames are a sandbox-wire contract with
  strict per-span schemas, so `parseSandboxSpan` reads `kobe.*` attribute keys as `kaiju.*` for
  one release (else every span of an old-image sandbox would be dropped as invalid).
- **Signed and persisted values: nothing signed embeds a renamed name.** Checked: approval HMACs
  (domain `kobe.approval.v1`, kept), run tokens and server-call tokens (claims and `typ`, no
  header name; audiences `kobe.*` kept), session tokens, SSO state and link-intent cookies (AEAD
  labels `kobe-sso-*-v1` kept; only the cookie names change, so an SSO sign-in in flight during
  the upgrade must start again), audit hash chain (row data; forwarding names are not hashed).
  Better Auth plugin ids (`kaiju-sso`, `kaiju-audit`, ...) are not persisted. Lock keys,
  rate-limit keys, audit action names, Pi custom entry types (`kobe.branch`, ...), the notebook
  frame's postMessage type (Q4) and the WebSocket subprotocol `kobe.sandbox.v1` are unchanged.
- **Egress header rules** keep `x-kobe-` reserved next to `x-kaiju-` (receivers still read the
  old names, so no team rule may inject one).
- **Session cookie not renamed:** Better Auth uses its default prefix (`better-auth.*`, no
  product name), so ac-2 holds without it; members stay signed in. Changing `cookiePrefix` would
  sign everyone out for no requirement. The release note says so instead of "sign in again"
  (owner's expectation was a sign-out; one config line if wanted). No Next.js proxy/middleware
  reads cookies.
- **Per-browser conveniences reset** (owner-accepted): last team and thread, tabs, panel sizes,
  scroll, dismissed notices, theme. One exception: the reload-draft stash is read once from the
  old key, because the Reload that installs this release starts on the old build and would
  otherwise lose the composer text the banner promised to keep.
- **Telemetry:** every `kobe.*` span/attribute/scope name, tracer names and `service.name`
  values are `kaiju`; no metric instruments exist (the perf SQL's column aliases renamed).
  Syslog APP-NAME `kaiju-audit`, SD-ID `kaiju@<PEN>`, OTLP audit `kaiju.audit.*`.

## Review round 1 (fix first: one MEDIUM, two LOWs)

- **MEDIUM** (new sender → old receiver during the rollout): fixed by dual-send as above; tests
  per pair assert both names sent (web client and `teamHeaders`, mcp-proxy grant call, egress git
  decision, server chat and embeddings calls, extension run headers, Pi MCP config) and the
  receiver working with either (server team header and sandbox token, mcp-proxy thread header,
  gateway run id, run token and server-call). `docs/install.md` Upgrade notes corrected.
- **LOW-1** (break-glass DB race): the revocation and expiry tests now wait for the mail whose
  subject says "was revoked" / "ended" after `before`, instead of taking the last mail (the
  approval notice, sent through the outbox after the approve response, could arrive late).
- **LOW-2** (sign-out wording): kept as is by coordinator decision: the session cookie keeps its
  name, members stay signed in; ledger and release note say so.

## Allowlist

- New permanent group "Old header names, the span attribute prefix and a session-storage key
  read for one release" (helper, receivers, response headers, trace-frame prefix, reload-draft
  key, their tests); removed with the fallbacks in KOBE-754. Forgery tests also send
  `x-kobe-delegation` (entry widened). Rename notes in `docs/guide/whats-new.md`,
  `docs/install.md` and `docs/tracing.md` in the rename-note group.
- Self-test samples: old header names are now unowned except in receivers; telemetry
  `kobe.team_id` in `spans.ts` is unowned, the setting stays permanent.

## Doc evaluation

- **Guide** (`docs/guide/whats-new.md`, "Kobe is now Kaiju"): members see that the browser
  forgets its choices once and that they stay signed in; admins with API scripts send
  `X-Kaiju-Team` (old name works this release). No other guide page names a header, cookie or
  telemetry name (checked).
- **Operators:** `docs/tracing.md` "Names after the rename to Kaiju" (ac-3); attribute lists,
  `docs/audit-log.md` (APP-NAME, SD-ID, OTLP attributes), `docs/perf/latency-queries.sql`,
  `docs/development.md` (OpenAPI `x-kaiju-*` extensions) renamed by the script; `docs/install.md`
  Upgrade notes bullet; rename paragraph in `docs/releases/README.md` (unreleased notes).

## Left open / outside the repo

- Coordinator scripts outside the repository that send old names keep working for one release
  through the fallbacks but should move now: the Playwright runner's `x-kobe-team`, anything
  that seeds `kobe.lastTeamId` in localStorage (now `kaiju.lastTeamId`; old key is ignored) or
  sets the `kobe-theme` cookie, the gate1 deploy script if it calls the API.
- Backends (Langfuse removed on gate1; any SIEM) need their queries renamed; nothing in the repo.

## Evidence

One command at a time, TMPDIR on disk:

- `pnpm build`, `typecheck`, `lint`, `format:check`: ok. Guard ok (40,886 allowed, 220 entries;
  RN-5 owns 0); self-test 23/23; `check-site-wording.mjs` and `check-public-hygiene.sh` ok.
- Unit suites of the touched packages: protocol 1,387; telemetry 32; db 1,111; egress-proxy 182;
  mcp-proxy 174; model-gateway 266; sandbox-agent 1,294 (196 skipped: real-helper and real-Pi
  files, read by hand: their header and dialog names pair with the agent's own constants);
  server 4,571 (8 skipped); web 4,313; chart 398; guide 33.
- DB suites: `@kaiju/db test:db` 2,180 passed; `@kaiju/server test:db` 3,750 passed, 1 failed
  (`break-glass.db.test.ts` "revocation applies to the very next request": the last mail was
  still the approval mail, an ordering race; the file passed 28/28 twice on rerun, untouched by
  this step apart from one header name in another test).
- Found by the unit suites (fixed): the telemetry config test's `kobe-server` service name, and
  the team-setter test's allowed mentions for the two telemetry files (the span attribute is
  no longer spelled like the setting).
- Not run here: browser suite, e2e gate scripts, image builds (CI and e2e per step).

Review round 1 rerun (after dual-send and the break-glass fix): build, typecheck, lint,
format:check, guard (40,936 allowed, 219 entries; later recount includes this ledger), self-test
23/23 ok. Unit: protocol 1,389; egress-proxy 182; mcp-proxy 174; model-gateway 266;
sandbox-agent 1,294 (196 skipped); server 4,571 (8 skipped); web 4,313. `@kaiju/server test:db`
3,751 passed, 0 failed.

CI round (PR #720, run 45447906077): the real-Pi tests (skipped locally until then) failed because
their tap in `testing/real-pi-rpc.ts` removed only `x-kaiju-run-token` before forwarding to the
local gateway; the extension's dual-sent `x-kobe-run-token` reached it, was normalised to the new
name and failed verification (401, so compaction, branch summary and the redirect plants failed).
The tap now removes both names. Reproduced locally with the pinned Pi (`npm ci --prefix
images/sandbox/pi`): 11 failures before, the four files 15 passed / 7 skipped (paired-executor
cases needing test identities) after; whole `@kaiju/sandbox-agent` suite with Pi 1,432 passed,
58 skipped.
