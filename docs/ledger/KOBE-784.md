# KOBE-784: Connector lifecycle edge cases; OAuth connectors probed with a site admin's grant

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group 76)
- **Branch / worktree:** `group-76-connectors-oauth` in `../Kobe-g76`
- **Depends on:** KOBE-778 (leased refresh, same branch)

Second-pass review findings P2-27, P2-30, P2-31, P2-32 and P2-13 (private review notes).

## Findings checked against the code

All held. P2-27: `finishFlow`/`storeGrant` never compared the state's `resource` with the
connector URL. P2-30: `updateConnector` dropped grants only on a URL or credential-source change.
P2-31: `obtainClient` registered a new client on every start, no rate limit, no overall deadline.
P2-32: `countTeamsUsing` (registry), `teamsUsing` (drift recipients), `listTeamsUsing`
(team-usage). P2-13: `chooseProbeCredential` returned `none` for every non-`api_key` connector.

## Decisions

- **P2-27:** `GrantMaterial.resource`; `storeGrant` refuses (`not_available`) under its connector
  share lock when it differs from the connector URL. The callback redirects with
  `connector_oauth=failed&reason=not_available`.
- **P2-30:** an auth-kind change deletes every member's grant (`dropConnectorGrants`, audited
  `mcp.grant.removed` per grant, before any audit row of the transaction) and the kept OAuth
  client. A site key already goes with the credential-source change an auth-kind change implies
  (`site` needs `api_key`).
- **P2-31:** the dynamically registered client is kept in `connectors.oauth_client` (migration
  `0239_connector_oauth_client`, generated; CHECK on the envelope format): sealed with the site
  envelope bound to connector + URL hash, holding issuer, redirect URI, client id and secret;
  reused while issuer and redirect URI match, replaced otherwise; cleared on URL and auth-kind
  changes; written only while the URL is unchanged. A column rather than a table: one per
  connector (Kobe has one redirect URI) and the connectors table is already site-wide. Counted in
  the start-up sealed key check. CIMD clients are never stored. `POST .../oauth/start` is rate
  limited per member (`OAUTH_START_RATE`, 30 per 10 min, 429 `rate_limited`, before any lookup);
  discovery + registration share one 30 s deadline (`oauth_unreachable`).
- **P2-32:** one walk, `enablementsOf` in `connectors/team-usage.ts` (bounded concurrency);
  `teamIdsUsing` for the removal count and drift recipients, `listTeamsUsing` for the panel.
- **P2-13 (owner decision, Chris 2026-11-22: yes, mirror KOBE-431):**
  - `chooseProbeCredential` for an `oauth` connector: the acting admin's own OAuth access token
    (pin, re-pin, Re-probe) or `pinned_by`'s (periodic refresh), only while that user is an active
    site admin, revealed through `revealCredential` with this process's leased refresh
    (`McpService.oauthRefresh`, the same gate as the proxy's reveals); never a member's.
  - Sent to the proxy probe as `access_token` (new field, never with `api_key`); the proxy makes it
    a bearer token for that probe's upstream session only (initialize, tools/list, ui:// reads).
    The token never goes to the decide/call path or a sandbox: it is fetched only by the probe
    code, held for one request.
  - Audit `mcp.connector.probe_credential` / `mcp.connector.refreshed` gain `admin_oauth`
    (`docs/audit-log.md`). `nextPinnedBy` applies the same rule to OAuth grants.
  - No grant: the probe runs without a credential, so a server that lists anonymously still pins;
    one that wants sign-in fails `auth_required` with "connect your own account for this connector
    first" (pin, Re-probe), and the admin page's skip notice says "needs a connected account".
    (Interpretation of "the pin fails with a clear message": we do not refuse servers that list
    anonymously, which pinned fine before.)
- **Docs:** guide `admin/site-admin.md` (how Kobe checks tools, OAuth needs the admin's own
  account; URL/auth changes delete keys and sign-ins), `connectors-and-apps.md` (keys and
  sign-ins go when the address or sign-in method changes; a late sign-in is refused).

## Left out

- The drift email for an `auth_required` skip still gives the API-key remedy text for an OAuth
  connector (`drift-notify.ts skippedMessage`); the console notice and pin messages are right.

## Evidence

- `services/server/src/connector-oauth.db.test.ts` "connector lifecycle edge cases (KOBE-784)":
  late callback refused; one registration reused across members, sealed, re-registered after a
  URL change; 31st start → 429; auth-kind change deletes 2 grants (2 audit rows), switching back
  revives nothing. "fails without registration" clears the kept client first.
- `services/server/src/connector-oauth-probe.db.test.ts`: no grant → 502 with the connect message;
  admin's own token probes (`access_token`), member's never, `pinned_by` set, `admin_oauth`
  audited without the value; periodic check refreshes the expired token through the lease and
  probes with the new one; no admin grant → skipped `auth_required`, no member token.
- `services/mcp-proxy/src/probe.test.ts` (access token as bearer, never both);
  `routes/reprobe-reply.test.ts`; web `connectors-page.test.tsx` (OAuth skip notice).
