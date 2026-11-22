# KOBE-783: Policy rule matching and truthfulness (review pass 2: P2-21, 22, 23, 24)

- **Status:** in review (group 77)
- **Branch / worktree:** `group-77-policy-rules` in `../Kobe-g77` (on `group-73-policy-tools-allow`)
- **Depends on:** KOBE-776/777 (same files)

## Finding check

All four held on the group-73 branch (4bec0bfb):

- **P2-21:** `listLive` (policy/user-rules.ts) neither selected nor passed `exact_keys`, so
  `exactPattern` judged an exact rule of a tool without a primary argument (MCP, `remember`)
  inexact under exact-only limits: listed "No longer applies" while the engine (rule-store reads
  `exact_keys`) allowed with it. New test failed on `applies`.
- **P2-22:** `projectCommitSpec` took the allowance with `check`: after a rule-allowed commit
  settled, the same `project.commit` frame committed again from a changed working copy. New test
  committed twice.
- **P2-23:** the glob subject of a non-string is its canonical JSON and of a string the string, so
  a rule pinned from `{"limit": 5}` (`/limit: "5"`) also matched `{"limit": "5"}`; `exact_keys`
  checks keys only. New unit test allowed the string.
- **P2-24:** `tool NOT LIKE 'mcp\_\_%'` in a JS template cooks to `mcp__%` (both `_` wildcards).
  New test: a consumed approval of `mcpXYlookalike` was not voided. (The other LIKE uses with
  member-typed text, `teams/add-existing.ts` and `schedules/mention-moves.ts`, already escape
  `\`, `%` and `_`.)

## Decisions

- **P2-21:** the SELECT reads `tool_rules.exact_keys` and the judged rule carries it, exactly as
  `toPolicyRule` does for the engine.
- **P2-22:** `project.commit` uses `allowance: "consume"` (single use, like the other
  non-idempotent frames). A repeat of the call's frame while its commit is still going (approval
  pending) is answered `pending_approval` as before (the spec tracks its own in-flight calls by
  run and tool call); after that, `not_allowed` ("This tool call was already used; make a new
  call to commit."). A remembered rule's one recorded use (`recordRuleApplied` at `policy.check`)
  now covers the one commit; revoking it stops later calls.
- **P2-23:** new nullable column `tool_rules.exact_input` (migration 0238, plain `ADD COLUMN`, no
  RLS change: the table's policies cover every column). An "only this exact action" rule over
  every argument (`exact_keys`) stores `canonicalJson(prepareInput(...).view)` of the approved
  input, the canonicalisation the approval HMAC uses; `ruleMatches` requires the call's prepared
  input to have exactly that canonical form (`exactInputMatch`). Key order and number spelling
  (`2.0` = `2`) don't matter; JSON type does. Primary-argument rules (bash command, file path) are
  string-only by the tool schemas and unchanged.
  - **Rules made before the column** have only their glob text, which can't tell `5` from `"5"`.
    They now match only string values whose text is not the canonical JSON of a non-string (fail
    closed: such a member is asked again once and the new rule stores the canonical form). They
    still show as applying on the Approvals pages (they do apply to plain-text inputs).
  - A column rather than a tagged glob: any tag inside the glob text is ambiguous with old rows.
    Migration is in this group's PR; land it first or `db:rebase` if main gains a 0238.
- **P2-24:** `left(tool, 5) <> 'mcp__'` instead of LIKE (no escaping to get wrong).

## Docs (docs/guide evaluation)

`internet-and-approvals/approvals.md` (Remember an approval) gets a paragraph: exactly this input
means the same values of the same kind (`5` vs `"5"`, list vs its text; field order doesn't
matter), and an older exact approval with numbers/true-false/nested values asks once more.
P2-21 makes the existing "No longer applies" text true; P2-22 and P2-24 change nothing a member
sees (the agent gets the new refusal text only on a replayed frame).

## Evidence

- P2-21: `remember-scopes.db.test.ts` "an exact rule of a tool without a primary argument applies
  under exact-only…" (also checks the stored `exact_input`).
- P2-22: `project-commit-agent.db.test.ts` "a rule-allowed call commits once…" and the repeat of
  `k1` while pending in the ask test; `tool-frame-gate.test.ts` mode tables.
- P2-23: `policy/remember-scopes.test.ts` "only this exact action matches on canonical JSON"
  (types, key order/number spelling, legacy rows).
- P2-24: `approvals.db.test.ts` "voiding an undelivered allow".
