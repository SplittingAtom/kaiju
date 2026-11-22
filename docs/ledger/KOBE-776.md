# KOBE-776: An agent's tools.allow list is not enforced on each tool call

- **Status:** in review (group 73)
- **Branch / worktree:** `group-73-policy-tools-allow` in `../Kobe-g73`
- **Depends on:** none (KOBE-777 builds on it)

## Finding check (review pass 2, P2-2 and P2-25)

Held as described on `origin/main` a303f342: `createDbRunContextSource` returned only
`toolsDeny`/`dangerousTools`, so `buildInput` (sandbox) and `policyInputFor` (MCP proxy) always sent
`tools_allow: []` and the engine's allow branch (`checkAgentTools`, policy/gates.ts) never ran.
`versionAllowsCall`/`manifestAllowsTool` had no runtime caller. `enforceMcpCall` was used only by
tests. The new gated tool frames (`runGatedToolFrame`) require a prior `policy.check` allow for the
same tool call and input, so enforcing in the engine covers them too.

## Decisions

- **One enforcement place:** `loadRunAgentTools` now returns `toolsAllow` (published version: frozen
  `manifest.tools_allow`; test chat: the draft's `tools.allow`). Both context sources use it (the MCP
  proxy's `loadActiveRuns` goes through the same `RunPolicyContextSource`), and the engine's existing
  `checkAgentTools` refuses with `agent_tool_deny` (stage `team_deny`). So refusals take the existing
  shapes and records: `policy.denied` event + skipped action at the sandbox, `mcp.tool_call` denied
  audit at the proxy.
- **Naming:** MCP tools are matched by their `mcp__<server>__<tool>` name, the same name the run
  start already filters `run.start.mcp` (and the Kobe connector's tools) by, so Pi is never offered
  an MCP tool the server then refuses.
- **No allow list = no narrowing** (empty or absent), as the manifest and the builder already treat
  it. Most agents (and runs without an agent) see no change.
- **Not enforced per call: the frozen `tools` set.** A version without an allow list keeps built-ins
  added after it was published (e.g. memory tools, `commit_project`); refusing them would break every
  published agent. Documented in the manifest contract comment. `versionAllowsCall` (dead, encoded
  that ceiling) removed; its test now checks the engine gate on a version's frozen lists.
- **In-flight runs / pinned versions:** the lists are read from the run's own `runs.agent_version`
  on every call, so a run already going when this deploys is narrowed from its next call. Its Pi
  MCP tool list was already filtered by the same list, so only built-ins outside the list (which
  Pi still offered) start being refused. Team agents read `team_agent_versions`, personal and
  gallery agents `site_agent_versions`.
- **Dangerous:** unchanged derivation (`explicitToolNames(tools_allow)`); every Dangerous tool is in
  the allow list, so it is never refused by it. A sibling run whose allow list excludes an MCP tool
  now makes the proxy's combination ask (as a sibling deny always did; KOBE-777 makes the sandbox
  ask too).
- **Viewed-file guard:** `proposeAvailable` already honoured a non-empty `tools.allow`; with the list
  now loaded, an agent whose allow list leaves out `propose_file_edit` is asked instead of being
  pointed at a tool it can't use (test added).
- **P2-25:** `enforceMcpCall`/`McpEnforcement` and `enforce-scheduled.test.ts` deleted. Its
  composition cases are on `decideMcpCall` in mcp.db.test.ts: unsigned call (existing "refuses an
  unsigned call"), scheduled run (existing KOBE-178 block), canonical key order / number spelling
  (new). The approvals.db.test cases now call the verifier directly.

## Docs (docs/guide evaluation)

Changed: `agents/agents.md` says what **Allowed tools** does at run time (server refuses others,
connector tool names, empty = no limit, never skips an approval, per version);
`for-agents/asking-for-access.md` gets a row for a tool outside the agent's list. The builder's own
hint ("Only the tools listed here are allowed") already matched the new behaviour.

## Evidence

- ac-1, ac-2: `services/server/src/agent-tools-allow.db.test.ts` (sandbox: team, personal, draft,
  argument shorthand, no list; proxy: refused + audited, allowed by glob, no list). Failed before the
  fix (3 of 5: `allow` / `risk_read` where `agent_tool_deny` was expected), pass after.
- ac-3: `enforceMcpCall` removed; `grep -rn enforceMcpCall services` is empty.
- Adjusted: dangerous-mode.db.test (connector-only allow list now refuses built-ins), viewed-file-guard
  .db.test (Dangerous fixture names `propose_file_edit`).
