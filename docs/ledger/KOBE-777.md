# KOBE-777: MCP decisions with two runs at once (sandbox allowed, proxy denied)

- **Status:** in review (group 73)
- **Branch / worktree:** `group-73-policy-tools-allow` in `../Kobe-g73`
- **Depends on:** KOBE-776 (same files)

## Finding check (review pass 2, P2-3 and P2-26)

Held as described on `origin/main` a303f342 after the frames/\* split: `decidePolicyCheck`
(sandbox-wire/policy-check.ts) evaluated an MCP call under the named run only, while
`decideMcpCall` (mcp/decide.ts) combined every active run of the sandbox (`combineDecisions`: a
sibling ask or deny means a signed approval is required). With a stricter sibling (ask-all), or a
thread-bound remembered rule plus any sibling (review S1), the sandbox answered `allow` (even
announcing "Allowed by your rule") and the proxy then denied with `no_approval`. The new test
`mcp-sibling-runs.db.test.ts` failed on main in exactly that way (no `policy.pending`). P2-26
(`decidePolicyCheck` ~205 lines, the deny triplet repeated) also held.

## Decisions

- **One shared rule:** `decideAcrossRuns` (mcp/decide-policy.ts) holds the sibling selection
  (distinct contexts; every other run when a remembered rule decided the named run) and the
  combination. The proxy's `decideUnderRuns` and the sandbox's new `acrossSandboxRuns` both call
  it with the same runs (`loadActiveRuns` for the connection's sandbox id) and the same per-run
  input (`policyInputFor`, now taking the enforcement point and claimed exposure; the sandbox
  claims `all`, the engine applies the team's real exposure either way). Siblings get the Kobe
  admin guard per run, as the proxy's Kobe connector does.
- **When the combination asks but the named run allowed** (read, remembered rule, Dangerous), the
  sandbox turns the call into an ask through the broker, so the proxy finds the signed approval
  it requires. The approval's reason is the sibling's first reason (the code the proxy audits),
  with a message saying another conversation in the sandbox needs it. `policy.rule_applied` and the
  Dangerous audit are not recorded then (only on a combined allow).
- **Remembered approvals (ac-2):** a rule that covers every run (e.g. user-wide `forever`) allows on
  both sides with siblings running, no prompt. A thread- or run-bound rule still can't decide alone
  while another thread runs (review S1, unchanged): the member now gets an approval card instead of
  a silent proxy deny; once the sibling ends, the rule allows again on both sides.
- **Unchanged outcomes elsewhere:** auto and scheduled named runs still deny where the combination
  asks (`neverPromptReason` here, `skip`/no approval at the proxy); skill evals still deny;
  too many runs denies on both sides (`run_not_active`).
- `dangerousToolsFor` moved to policy/dangerous-mode.ts (re-exported) so mcp/run-context.ts no
  longer imports sandbox-wire/policy-check.ts (which now imports it).
- **P2-26 (separate refactor commit, no behaviour change):** `refuse()` (record denied + skipped +
  deny frame), `allowOutcome()` (eval refusal, Dangerous audit, rule record, file link) and
  `askOutcome()` (never-prompt, eval, deferral, broker) extracted from `decidePolicyCheck`.

## Docs (docs/guide evaluation)

`internet-and-approvals/approvals.md`: a connector call asks whenever any of the member's running
conversations would ask; a connector approval remembered for this conversation or run applies only
while no other conversation runs (longer ones keep applying). No "For agents" change: agents
already treat an ask as "held for approval".

## Evidence

- ac-1, ac-2: `services/server/src/mcp-sibling-runs.db.test.ts` (ask-all sibling → card → approve →
  proxy `approval_granted`; every run allows → no card, proxy `risk_read`; thread rule + sibling →
  card, no `policy.rule_applied`, proxy `approval_granted`, then sibling ends → rule allows on both
  sides; user-wide rule + sibling → allowed on both sides). Two of four failed before the fix.
- Existing proxy behaviour unchanged: `mcp.db.test.ts` (M1, S1, KOBE-178 blocks) green.
- ac-3: refactor commit; same test files green before and after.
