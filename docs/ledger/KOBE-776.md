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
  it. Most agents (and runs without an agent) see no change. (Built-ins: see the owner decision
  below.)
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

## Review follow-up (group 73 review, 2026-11-22)

- **Owner decision (Chris, 2026-11-22): restrict built-ins only if the list names one.** One rule in
  `policy/agent-allow.ts`, used by the engine gate (`checkAgentTools`, so both the sandbox and the
  proxy), the run start and the manifest's exclusions. Connector (MCP, incl. Kobe) tools: limited
  whenever the list is not empty. Built-ins (`BUILTIN_TOOLS`, the one source of names): limited only
  when an entry's tool part matches a built-in name (`read`, `bas?`, `bash:ls *`, `*`).
  Examples: `[mcp__github__get_issue]` = that GitHub tool plus every built-in (what the builder
  writes for a chosen connector); `[read, grep, mcp__github__get_issue]` = exactly those three.
- **Run start = what will be allowed:** when built-ins are restricted the server sends
  `run.start.config.hidden_tools` (additive optional field; older agents strip it), the agent passes
  it to Pi as `KOBE_HIDDEN_TOOLS`, and kobe-policy (loaded last) removes those names from Pi's active
  tools before every prompt. The field is in Pi's launch key only when set. Needs a sandbox image
  rebuild to take effect; until then Pi still lists them and the server refuses them.
- **Empty list:** the builder never writes `allow: []` (form-model drops the key; `withKobeDocs`
  keeps "empty = not narrowed"), so empty = absent = no limit everywhere: the run start's connector
  and Kobe tool lists now agree with the engine (they treated `[]` as "nothing").
- **Test chat draft:** a missing draft row or a malformed allow list (not an array, or a non-string
  entry) throws, so every call is denied (`policy_error`), like the published path.
- `return await refuse(...)` everywhere in `decidePolicyCheck`.
- **Follow-up for the coordinator (pre-existing, R1):** server-run tools (the gated frames: memory,
  project commit, artifacts, notebook, file open/propose, skill draft save) are decided only under
  the run the sandbox names in `policy.check`, not combined across sibling runs as MCP calls are.
  True for `tools.deny` and memory-off since KOBE-481; a compromised sandbox could name a sibling run
  whose agent allows the tool (scoped to that sibling's thread and run).

## Docs (docs/guide evaluation)

Changed: `agents/agents.md` says what **Allowed tools** does at run time (connector tools limited
whenever listed, built-ins only when the list names one, both examples, empty = no limit, never
skips an approval, per version); the builder's Allowed tools hint says the same;
`for-agents/asking-for-access.md` gets a row for a tool outside the agent's list.

## Evidence

- ac-1, ac-2: `services/server/src/agent-tools-allow.db.test.ts` (sandbox: team, personal, draft,
  argument shorthand, no list; proxy: refused + audited, allowed by glob, no list). Failed before the
  fix (3 of 5: `allow` / `risk_read` where `agent_tool_deny` was expected), pass after.
- ac-3: `enforceMcpCall` removed; `grep -rn enforceMcpCall services` is empty.
- Adjusted: viewed-file-guard.db.test (Dangerous fixture names `propose_file_edit`).
- Review follow-up: `policy/agent-allow.test.ts` (rule, both examples, empty), agent-tools-allow
  .db.test (connector-only list keeps built-ins, still limits MCP at the proxy; draft empty and
  malformed), dangerous-mode.db.test ("a connector-only agent's built-ins still ask" restored),
  runs-resolver.db.test (`hidden_tools`), run-mcp.test (empty list), sandbox-agent
  hidden-tools.test and pi-launch.test.
