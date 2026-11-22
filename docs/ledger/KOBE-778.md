# KOBE-778: OAuth refresh lease across replicas; reactive refresh; proxy grant deadline

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group 76)
- **Branch / worktree:** `group-76-connectors-oauth` in `../Kobe-g76`
- **Depends on:** none

Second-pass review findings P2-4, P2-28, P2-29 (private review notes).

## Findings checked against the code

- **P2-4 holds.** `RefreshGate` is per process; the compare-and-set only chose which result was
  stored, after both replicas had sent the same refresh token. One detail of the finding did not
  hold: the old test fake already made refresh tokens single-use, so "two replicas race" passed
  through the 1 s reject grace, not because the fake accepted a token twice. With reuse
  detection (the whole family revoked on a second use) the old code broke, which the new test
  shows (red before, green after).
- **P2-28 holds.** No `expires_in` gave `expires_at = NULL`, never refreshed; an upstream 401 was
  only reported as "Reconnect it".
- **P2-29 holds.** Proxy grant call 10 s, server OAuth deadline 10 s plus grace and queueing.

## Decisions

- **Lease in the row** (migration `0238_connector_grant_refresh_lease`, generated):
  `connector_grants.refresh_lease_until`, `refresh_lease_owner` (random uuid per refresh). RLS
  unchanged (same team table, columns nullable). Code in `connectors/grant-refresh.ts` (moved out
  of `grants.ts`, shared reads in `connectors/grant-read.ts`):
  - a short `withTeam` UPDATE takes the lease only while `sealed` is still what was read and no
    live lease exists; nothing is held during the token request;
  - only the holder calls the token endpoint; others re-read every 100 ms and serve the rotated
    bundle, or a still-valid stale token when the wait (the lease length) ends, or take the lease
    once it expired;
  - the holder writes with CAS on its own lease + `sealed`, clearing the lease; the write is
    retried 3 times (the old refresh token is spent once sent); a rejected refresh drops the grant
    under its own lease (the 1 s grace is gone: nobody else spent the token through Kobe);
  - `dropIfUnchanged` refuses while another replica holds a live lease; a reconnect (`storeGrant`)
    clears any lease.
  - Lease = refresh deadline + 5 s, so it cannot expire while its holder waits for an answer.
- **P2-28:** no `expires_in` with a refresh token → default 1 h expiry (callback and refresh).
  Reactive: the grant endpoint takes `{"refresh": "force"}`; the server refreshes an OAuth grant
  unless it was written in the last 30 s (rate limit per grant). The proxy asks once after an
  `auth_required` upstream answer for a member's OAuth token and retries the call once if it got a
  different token, within the same upstream deadline. A 401/403 means the call did not run, so the
  retry cannot run it twice. API keys and site keys are never retried. MCP Apps' own calls
  (`apps/call.ts`) are not retried (left out: the browser shows the error and the next call
  refreshes by expiry).
- **P2-29:** server refresh deadline 5 s (`REFRESH_TIMEOUT_MS`, was 10 s; the connect flow keeps
  10 s); proxy `KOBE_MCP_GRANT_TIMEOUT_MS` default 25 s (lease wait 10 s + own refresh 5 s + DB),
  refused below `KOBE_MCP_SERVER_TIMEOUT_MS`.
- **Docs:** guide `connectors-and-apps.md` ("Add your own key"): OAuth sign-ins are renewed by
  Kobe, also after a refusal; sign in again only when the provider ended it. The new env var is an
  internal default (no chart value; the chart does not set the server timeout either).

## Evidence

- ac-1: `services/server/src/connector-refresh.db.test.ts` "refresh lease across replicas":
  strict rotation + reuse revokes the family, two replicas → one token request, both serve the
  winner, lease released, next refresh still works; a replica finding a foreign live lease
  serves the holder's token without a request; no drop under a foreign lease. Red before.
- ac-2: same file "reactive refresh" (no `expires_in` → expiry set; forced refresh, then rate
  limited); `services/mcp-proxy/src/mcp.test.ts` "reactive OAuth refresh" (refresh + one retry,
  one retry only, same token → no retry, API key never); `credentials.test.ts`.
- ac-3: `services/mcp-proxy/src/config.test.ts` (grant deadline 25 s > server calls; refused
  below), `credentials.test.ts` (grant call outlasts `timeoutMs`).
