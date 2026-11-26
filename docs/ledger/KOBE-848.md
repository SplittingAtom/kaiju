# KOBE-848: Agent runs the open script in the code editor and reads its run pane

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** committed on `group-150-agent-editor-run` (not pushed)
- **Branch / worktree:** `group-150-agent-editor-run` in `../Kobe-g150`
- **Depends on:** KOBE-464/465 (kernel, `run_python`), KOBE-803/804/805/816 (run log, run pane,
  variables snapshot), KOBE-473/493 (`runs.viewing`), KOBE-157 (untrusted fence).

## Design

**Tools** (kaiju-tools, registered with `notebooks`, the same capability as `run_python`):

- `editor_run {path, timeout_s?}`: runs the whole saved `.py` file, exactly as the editor's Run
  does (the server reads the member's synced copy, runs it in the conversation's kernel, records
  `notebook.started {origin: "agent", tool_call_id, path}` and `notebook.finished`). No `code`,
  no cells, no line ranges.
- `editor_read {path, what}` with `what` one of `output` (the newest run of that file: status,
  timing, error and its printed output), `log` (the file's last 10 runs: when, who, how it ended,
  how long, error name and line) or `variables` (the kernel's user variables: name, type, length
  or shape and dtype, a preview of at most 80 characters).

**Which file.** Only the file the member had open when they sent the message: the run's viewed
file (`runs.viewing.path`, set at send, Retry and regenerate), and only a `.py` file. A server
guard after the engine (`policy/editor-file-guard.ts`, every mode, Dangerous and remembered
approvals included) denies any other path with reason `editor_file` and a message naming what to
do ("ask the user to open it, or use run_python"). The model already sees the viewed path in its
context (KOBE-473). Naming any workspace file was rejected: `run_python {path}` already does that,
and tying the tools to the open editor keeps "the member sees it in the run pane" true.

**Same kernel, same pane.** `editor_run` rides the existing `notebook.run` frame and kaiju-tools
op (`tool: "editor_run"`), so it shares `run_python {path}`'s whole path: the agent pushes the
file through workspace sync, the gate checks capability, run lease and the single-use allowance
for the same canonical input, `runForAgent` reads the synced copy and sends `notebook.execute`
on the same connection. The web run pane already lists every execution of the file in the
thread (member and agent); it opens on a new run. New: the Run Output tab says "The agent
started this run" with a Stop button while it runs.

**Authorization.** `editor_run`: `source kaiju, risk write, scope kaiju`. Kaiju-scoped writes
prompt in `ask-on-write` (the default) and are a floor Dangerous mode does not lift; the member
can approve once or remember; `auto` and scheduled runs deny it unless a team allow rule lists
it; deny/ask rules and `tools.deny` apply as usual. `editor_read`: `risk read, scope kaiju`, no
prompt. Both are denied in skill-eval runs (`eval_run_isolated`): they target the member's files
and kernel. `run_python` stays as it was (sandbox scope, no default prompt): see question 1.

**Concurrency.** A member's Run is a run of kind `notebook` on an idle thread and is refused
(`thread_busy`) while any run is active; the agent's tools exist only inside its active run. So a
member run and an agent run never overlap: an agent run cannot start while a member's Run runs
(the message waits in the thread queue), and the member's Run is refused while the agent works.
Within one agent run, executions queue in the kernel in order (KernelManager). **Stop:** the
member's Stop in the editor sends `notebook.interrupt` (owner only, no busy check), which SIGINTs
the kernel whatever started the code and drops queued executions; the tool answers
`status: interrupted`. Stopping the conversation's run interrupts it as well (failRun).

**Caps and fencing.** The server builds the text: output at most `NOTEBOOK_TOOL_TEXT_MAX_BYTES`
(16 KiB, head and tail kept), log 10 entries, variables 50 (then a count) with 80-character
previews and 50 other names; one answer at most 16 KiB (`EDITOR_READ_TEXT_MAX_BYTES`). The
extension fences every `editor_read` answer and `editor_run`'s output between
`<<<BEGIN UNTRUSTED EDITOR OUTPUT nonce>>>` / `<<<END ... nonce>>>` markers with a fresh nonce per
call, sanitised like recall results (KOBE-157: NFKC, invisible characters removed, `<<<` broken
up), with a notice that it is data, not instructions. Variables come from the KOBE-816 snapshot:
values only for exact built-ins, numpy/pandas summaries, never member code; credential-like
names come back `hidden` and the tool says "(value hidden)". Never `show`, never `refresh`.

**Audit.** New `run.editor_run` (runs area): `userId`, `threadId`, `runId`, `toolCallId`,
`status`, written with `notebook.finished`'s outcome; `run.editor_read`: same ids plus `what`.
No paths, code, output or values. The approval itself is audited by the `approval.*` events.

**Mixed versions.** New server, old sandbox image: the agent never registers the tools (the model
does not see them); nothing changes. New image, old server: the tools are registered, the old
server has no registry entry and denies them `unknown_tool` (the model gets a tool error); an
old server also cannot decode `editor.read`. Variables on an agent without `notebook_inspect`:
the tool answers "not available on this sandbox yet". No migration.

## Decisions

- **Two tools, not four.** `editor_read` takes `what` instead of three read tools: one registry
  entry, one frame, one prompt guideline.
- **`editor_run` rides `notebook.run`** (frame and kaiju-tools op now a union on `tool`), so it
  reuses the gate (single-use allowance for the same canonical input), the broker's push and
  `runForAgent`; the server maps it to `{path, timeout_s}` before resolving the source.
- **Audit names in the `run` category** (`run.editor_run`, `run.editor_read`): a new `editor`
  category would have needed the web audit filter list too. `what` is classified as a Site-view
  key (which tab, no content). Audits are written after the action in their own transaction; a
  failed audit is logged and the answer stands (the execution already happened in the sandbox).
- **Variables to the model** (brief overrides KOBE-803's "never to the model"): only the
  KOBE-816 snapshot (no member code ran), previews cut to 80 characters, hidden names say so.
- **File links:** `editor_run` / `editor_read` link the thread to the file as `read` (they change
  no file), unlike `run_python` (`write`, it can save notebook outputs).
- **Web:** no new store or route: agent executions of the file were already in the run pane;
  Run Output now says "The agent started this run. Stop ends it." with a Stop (owner only; a
  shared reader sees the line without Stop).
- **Protocol contract changed inside a feature branch** (parallel-work.md prefers its own PR):
  additive (new tools, a new frame pair, a union member on `notebook.run`, a new reason code).

## Open questions (for Chris or the coordinator)

1. `run_python {path}` can already run any workspace `.py` (including the open one) without a
   default prompt (sandbox scope, decided 2026-10-03). `editor_run` asks by default as the brief
   says. Should `run_python {path}` on the viewed file ask too, for consistency?
2. KOBE-803 decided variables never reach the model; this ticket asks for names, types and short
   previews. Built as asked, with KOBE-816's withholding of credential-like names kept.

## Docs

Member guide `files/notebooks.md` (new "The agent and the file you have open"), `file-editor.md`
(pointer); for agents `working-in-a-sandbox.md` (tool table, a paragraph on the open script) and
`concepts.md` (Kernel); `docs/approvals.md`; `docs/audit-log.md` regenerated. The model-facing
tool descriptions and guidelines are in `kaiju-tools/editor-tools.ts`.

## Evidence (acceptance criteria → test or command output)

- ac-1: server `notebooks/editor-tools.db.test.ts` "runs the open .py file..." (events with
  `origin: agent`, `path`); sandbox `kaiju-tools.editor.real-pi.test.ts` (real Pi 1.4.0);
  `tools/notebook-broker.test.ts` (push, `tool: editor_run`); web `run-pane.test.tsx`
  "agent-started runs".
- ac-2: `notebooks/editor-text.test.ts` (caps, previews, hidden names), DB test "reads Run Output,
  Log and Variables"; `kaiju-tools/editor-tools.test.ts` (fence cannot be closed or forged, fresh
  nonce, strict reply parsing within the cap).
- ac-3: `policy/editor-tools.test.ts` (engine: ask in ask-on-write, read never asks, remember,
  auto/scheduled, Dangerous, deny rules; the editor-file guard); `policy/editor-tools.db.test.ts`
  (real engine: approval card, allow, deny, other file, auto); audit rows in the DB test.
- ac-4: DB test "refuses the member's Run while the agent works; the member's Stop interrupts the
  agent's run" (409 `thread_busy`, `notebook.interrupt`, status `interrupted`); web Stop test.
- ac-5: as above, plus `tool-frame-gate.test.ts` kinds for `editor_run` / `editor.read`, protocol
  `editor-tools.test.ts`.
- Checks: build, typecheck, lint, format:check; unit suites protocol 1410, db 1117, server 4704,
  web 4498, sandbox-agent 1464 (real-Pi suites ran), guide 33; server DB suite 3795 (one
  failure was this ticket's own test needle, a "42" inside a random id; fixed, 9/9 three times);
  hygiene, wording, rename guard ok. No migration, so no db:check.
