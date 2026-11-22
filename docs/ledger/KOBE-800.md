# KOBE-800: Server-run tools are decided only under the run the sandbox names

- **Status:** in review (group 77)
- **Branch / worktree:** `group-77-policy-rules` in `../Kobe-g77` (on `group-73-policy-tools-allow`)
- **Depends on:** KOBE-776/777 (`decideAcrossRuns`, `acrossSandboxRuns`), KOBE-783 (same group)

## Finding check

Held on the group-73 branch: `acrossSandboxRuns` (sandbox-wire/policy-check.ts) returned the named
run's decision for every non-MCP tool, and every gated frame (`runGatedToolFrame`) only checks the
allowance recorded under the run the sandbox named. With run A (agent `tools.deny` names the tool)
and run B (no lists) in one sandbox, `policy.check` naming B allowed all ten server-run tools
outright (B's remembered rule even claimed `commit_project` and `share_file`). The new test failed
that way for every kind.

## Decision: decide across the sibling runs (not a run binding)

A binding to the run that issued the call would need something the sandbox can't forge. There is
none: the frame's `run_id`, the tool call id and every run event (`tool_call` included) come from
the sandbox; session tokens are per sandbox (`sandbox/session-token.ts`); per-run tokens
(`x-kobe-run-token`, model gateway) exist, but the sandbox holds every run's token, and the gateway
records no tool call ids from model responses. One sandbox hosts all of the user's runs, so the
server can't tell A's call from B's.

So the gated tools take the MCP rule (KOBE-777, review M1) through the same code:
`decidedAcrossRuns(tool)` = MCP **or** a tool in `BOUND_TOOLS` (artifacts/allowed.ts: exactly the
tools whose allowance the connection records, i.e. every gated frame's tool: `create_artifact`,
`update_artifact`, `share_file`, `remember`, `recall`, `show_memory_item`, `commit_project`,
`save_skill_draft`, `propose_file_edit`, `open_file`, `run_python`). For those,
`acrossSandboxRuns` → `decideAcrossRuns` with the same runs (`loadActiveRuns`) and per-run input
(`policyInputFor`):

- the named run's deny stands; allow only when every active run allows;
- otherwise `require_approval` of the named run: the broker asks the member (card says another
  conversation is running) and signs (team, named run, tool_call_id, tool, expiry, canonical
  `frame.input`); the gated frame then needs the allowance under that same run, tool call and input
  hash, so the approval stays bound to what executes. `commit_project` defers to its frame (CM6),
  which asks over the server-built input instead of committing by the rule;
- a remembered thread/run rule that decided the named run makes every sibling decided on its own
  (review S1), as for MCP.

Tools the sandbox runs itself (Pi file tools, bash) are not combined: a compromised sandbox runs
them without asking, so combining would only add cards.

## Consequence to review (open question for the coordinator)

More cards while runs overlap. A sibling that is stricter for a tool makes that tool ask in the
other conversation. That includes a **scheduled or `auto` sibling**, which refuses unlisted writes:
while one runs, `create_artifact`, `update_artifact`, personal `remember` and `save_skill_draft`
ask in the member's interactive conversation, although they are normally prompt-exempt. The
member's present conversation asks; a scheduled named run is refused instead (it never asks). This
is the rule connector calls follow since KOBE-58/777. A narrower variant would skip an unattended
sibling's "not allow-listed" refusals for prompt-exempt tools, but it re-opens the hole the ticket
closes (an unattended run's call named under the interactive run), so I did not take it.

## Docs (docs/guide evaluation)

Member-visible (new cards), so:

- `internet-and-approvals/approvals.md`: the "all your conversations at the same time" paragraph
  now covers the tools Kobe runs itself, a stricter sibling's refusal, and a scheduled run going
  meanwhile. The remembered thread/run rule note covers them too.
- `for-agents/asking-for-access.md`: a row explaining an unexpected approval.

## Evidence

- ac-1, ac-2: `services/server/src/server-run-sibling-runs.db.test.ts`, one test per gated frame
  kind (artifact.put, file.share, memory.put/read/show, project.commit, file.edit_propose,
  file.open, notebook.run, skill.draft_save): alone the permissive agent's run allows; the
  restrictive agent's run denies itself; naming the permissive run with the restrictive one active
  asks (commit: deferred to its frame, rule not claimed). Plus: the approval row is bound to the
  named run, tool call id and canonical input; after the restrictive run ends the permissive one
  decides alone. 11 of 12 failed before the fix.
- `mcp-sibling-runs.db.test.ts` unchanged and green. `remember-scopes.db.test.ts` (thread scope): a
  thread rule now asks in its own thread while another run of the member is active (expected by
  the rule above); the test ends that run before checking the later run in the same thread.

## Owner decision (Chris, 2026-11-22): accept and document

- Guide: approvals page section "When a scheduled or automatic run overlaps a chat" (what a
  scheduled run skips and where Skipped actions show; connector tools alike; why: the most
  restrictive run decides), plus agents.md (Schedule an agent) and troubleshooting.
- Approval card: when the reason comes from an unattended run (`scheduled_run_no_prompt`,
  `mode_auto_not_allowlisted`, codes the chat's own decision never asks with), the Remember
  controls say remembering won't stop the asking while that run goes (`askedForUnattendedRun`,
  apps/web approval-remember.tsx; test in approvals.test.tsx).
- Migration 0238 not renumbered: the coordinator runs `db:rebase` at landing.
