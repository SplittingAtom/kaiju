# KOBE-835: OAuth connectors cannot be connected from the web app

- **Status:** in review (branch ready, not pushed)
- **Branch / worktree:** `group-121-oauth-connect` in `../Kobe-g121`
- **Depends on:** KOBE-109 (server OAuth flow), KOBE-784 (admin OAuth probe credential)

## Plan

1. My connectors lists OAuth connectors with Connect / Reconnect / Disconnect and the state.
2. The callback result is shown once as a notice; the query is cleared.
3. Site console: an OAuth connector with no tools explains why, offers **Connect your account**
   (the admin's own grant, back to the registry) and **Re-probe** to pin.
4. Long tool lists stay usable (filter, choose all shown, scrolling columns).
5. Chat + menu wording; guide pages for members, admins and agents.

## Decisions

- **Callback lands on `/me/connectors`**, not `/`; a site admin who started from the Site console
  lands on `/admin/site/connectors`. The target is a name (`return_to: "me" | "site"`) sealed in
  the encrypted state, mapped server-side to a fixed path on `publicUrl`'s origin: no URL ever
  comes from the request (no open redirect). `site` is honoured only for `site.connectors.manage`;
  anyone else goes to My connectors. Any other start body is a 400. In-flight states without the
  field still work (`ret` is optional, default `me`).
- **Callback refusals before the state opens are pages, not JSON** (review round 1): a wrapper on
  the callback path only (`oauthCallbackRefusals`, mounted ahead of the session check) turns a 401
  into a 303 to `/sign-in` and a 400 / 403 / 409 into a 303 to
  `/me/connectors?connector_oauth=failed&reason=invalid_state|no_workspace`: fixed paths on
  `publicUrl`, no connector id, nothing from the request. No grant is stored on any of them.
- **Failure reasons** are fixed codes; the web maps known ones to its own sentences and anything
  else to a generic one. The connector is named from the page's own list by UUID, never from the
  query. The authorization server's `error_description` is never forwarded (test).
- **Disconnect = delete the member's grant** via the existing `DELETE /v1/connector-grants/{id}`
  (RLS through `withTeam()`, audited `mcp.grant.removed`; works for OAuth grants already). No
  upstream RFC 7009 revocation: Kobe does not discover revocation endpoints today and it would
  add an outbound call per disconnect; the guide tells members to revoke at the service. No new
  route was needed.
- **States on My connectors:** not connected (no grant, or a grant of another kind), connected,
  "Sign-in expired, reconnect". Review round 1: `GET /v1/connector-grants` now sends
  `refreshable` (OAuth grant holding a refresh token, and this server has OAuth refresh wired;
  read by opening the sealed bundle server-side, nothing from it returned; false for API keys).
  A grant whose access token ran out stays **Connected** while refreshable; expired only when it
  is not. "Needs reconnect" after a refused refresh shows as not connected (the server drops the
  grant). The card shows "First connected" (`created_at`, which a refresh or reconnect keeps),
  not the last refresh. The result notice renders once, after the list loads, so it is
  announced once.
- **OAuth connectors are listed on My connectors even with 0 tools**, so members and admins can
  connect first.
- **Chat + menu keeps hiding a connector with nothing exposed** (the "team shows the member
  nothing" rule in `listChatConnectors`): a 0-tool connector has nothing to turn on, and listing it
  would add a toggle-less row with a problem only. The fix link label is now "My connectors"
  (`PROBLEM_TEXT`), and `not_connected` / `grant_expired` point there, where Connect lives.
- **Site console connect uses the admin's active workspace.** A grant lives in a team; the start
  needs the connector enabled there. If it is not, **Your account** says so and the button is off
  (no site-level grant without a team: that would change KOBE-784's model).
- **Refresh/pin picks up the new grant:** checked. Re-probe on an unpinned connector goes through
  `pinNow` → `adminPinCredential` → `chooseProbeCredential(adminId)` → `adminProbeGrant`, which
  searches all the admin's teams; `nextPinnedBy` records the admin. New DB test covers it.
- **Long lists:** shared `useToolFilter` / `ToolFilterField` (from 12 tools; name, title,
  description), columns scroll inside themselves; team **Chosen tools** gets **Choose all
  (shown)** / **Clear all (shown)** over choosable tools only; the review panel filters waiting
  tools ("Approve all N" still approves every waiting tool). Initial pinning has no per-tool
  selection (pin = whole snapshot, unchanged).
- **Wording:** "My connector keys" renamed "My connectors" everywhere (page title, chat fix link,
  pin/re-probe/drift messages, agents page). OAuth pin/re-probe failures now say "Connect your
  account in the connector's details, or My connectors, in a workspace that enabled it, then
  Re-probe". `oauth_unreachable` added to the web's shown 5xx codes (fixed server sentence).

- **State is not single use** (pre-existing, KOBE-109): the nonce is not recorded. Left as is
  (review round 1): a replay needs the same user's session and active team plus a fresh code the
  authorization server issued for that state's PKCE verifier, so it is not exploitable.

## Open questions (for Chris or the coordinator)

- ac-4 (verify on the test install with Massive) not done here: needs a deploy and a person to
  sign in at Massive. Massive's tool count is unknown; the probe follows up to 20 `tools/list`
  pages and 16 MiB.
- Upstream token revocation on Disconnect (RFC 7009) if wanted later.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/me/my-connectors-oauth.test.tsx` (Connect → start + navigation,
  non-http URL refused, 422/429/502/503 server sentences, Reconnect, Disconnect with confirm,
  expired, result notice + query cleared, unknown reason/connector never echoed);
  `services/server/src/connectors/connector-oauth.db.test.ts` "where the callback sends the
  browser" (paths, `return_to` refusals, member cannot pick `site`, reason only, disconnect audit).
- ac-2: `apps/web/components/admin/connector-oauth-connect.test.tsx` (no-tools badge and
  explanation, connect with `return_to: site` and the team header, blocked when the active
  workspace did not enable it, back with the result → details open → Re-probe pins);
  `services/server/src/connectors/connector-oauth-probe.db.test.ts` "connect from the Site
  console, then Re-probe".
- Long lists: `team-connectors-page.test.tsx`, `connector-detail-panel.test.tsx` (KOBE-835 blocks).
- ac-3 browser: `e2e/browser/tests/connector-oauth.spec.ts`, skipped unless
  `KOBE_OAUTH_CONNECTOR` names a connector backed by a consent-at-once server. To run it against
  the existing fake `e2e/lib/fake-oauth-mcp.js` (today only started in a pod by gate4's U7 story)
  it would take: serving the fake where both the Playwright browser and the server reach it (a
  Service plus the browser's host map, `KOBE_BROWSER_MAP`, as Gate 5 does), its address allowed by
  the connector address policy (chart `mcpProxy.allowedInternalCidrs` / the server's connector
  policy) and its port, an OAuth connector registered to it and enabled for `KOBE_USER`'s team,
  and `KOBE_OAUTH_CONNECTOR` set. Its `tools/list` needs no token, so it would not exercise the
  0-tool admin-connect path; that would need a flag making `tools/list` require a token. Not built
  (follow-up).
- Guide: `docs/guide/connectors-and-apps.md` (Connect your account or add your own key),
  `docs/guide/admin/site-admin.md` (Adding a connector that uses OAuth, filter),
  `docs/guide/admin/team-admin.md` (filter, Choose all shown),
  `docs/guide/for-agents/asking-for-access.md` (what to tell the user for an OAuth sign-in).
