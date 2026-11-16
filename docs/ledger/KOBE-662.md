# KOBE-662: prompt cache busted by memory placement (keep, strip, tool_only at 0%)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** fixed locally (commits on `kobe-662-sm`; coordinator pushes, deploys and re-runs
  the gate1 replay)
- **Branch / worktree:** `kobe-662-sm` in `../Kobe-wt662`
- **Evidence:** gate1 reports `cache-gate-b.json` / `cache-gate-b-rerun.json` (operator's tmp),
  gate1 `run_usage` and `thread_entries` for the five threads, docs/gates/gate-7a.md
  (Memory placement replay)

## Cause

1. **Pi restarts for every message.** The server sends each run after the first with
   `parent_entry_id` = the thread's leaf (`runs/lifecycle.ts`), so `ThreadManager.#prepareRun`
   stops Pi, appends a `kobe.branch` marker and starts a new Pi (gate1: one marker per run). The
   server's KOBE-290 prompt check relies on that marker, so this stays as it is (not in scope).
2. **Notes lived in kobe-tools' process memory** (KOBE-658), so every new Pi lost the earlier
   messages' notes. `latest_user_keep` behaved like strip (gate1 prompt growth per turn: keep
   about the same as strip); `tool_only` runs as keep (`TOOL_ONLY_AVAILABLE = false`).
3. **First differing byte:** in the provider request of turn N+1 against turn N, the first
   user-role message after the system prompt and tools: turn N had its "What Kobe knows for this
   message" note there, turn N+1 the bare message 0 (local real-Pi reproduction, JSON offset
   14665 of the request). System prompt, tools and nonce were byte-identical (one `system`
   entry per thread on gate1; nonce per thread, KOBE-383).
4. **Provider:** Ollama Cloud (glm-5.3-flash, same through Bifrost v2.5.1) keeps one checkpoint a
   block or two before the end of each request: cached = previous prompt rounded down to 64,
   minus 64; any change in that tail gives 0, no partial prefix. So a dropped note costs the whole
   prompt, and `stable_plus_delta` only ever hit turn 1's checkpoint (4,800 tokens constant).

## Fix

- The sandbox agent (`threads/thread.ts`) renders the run's note as kobe-tools does
  (`perMessageNote`, shared), binds it to the run's starting message from Pi's `message_end`
  event (first user message, or a non-kobe-tools custom message; same rule as kobe-tools), keeps
  it per thread (256 notes, 4 MiB, oldest dropped) and writes the history into the run file as
  `picks_notes` (`[[timestamp, text], ...]`). kobe-tools merges those with its own binding for the
  current run. A malformed `picks_notes` fails the file closed.
- No change to rendering, fences or the nonce: notes are the agent's own sanitised, fenced text
  (thread nonce, HMAC under the agent's process key), in the agent-owned, tripwire-checked run
  file, never in the session or `thread_entries`. A new agent process (sandbox wake) still starts
  without notes and with a new fence key: one uncached request, as before.

## Tests

- `memory-cache-prefix.real-pi.test.ts` (real Pi, real kobe-tools, server-like `parent_entry_id`
  per run): keep, tool_only, stable_plus_delta: each request opens with the whole previous one;
  strip: only the newest note moves; system: history stable, prompt changes with picks. Failed
  before the fix (keep and stable at the note, strip's prefix).
- `memory-placement.test.ts`: the same per placement with a new hooks instance per turn (Pi
  restart) and the agent's notes in the run file; failed without the merge. Malformed
  `picks_notes` fails closed.
- `memory-hooks.test.ts` updated; whole sandbox-agent suite green except two `runtime-dir`
  tests that fail on main too in this VM.
- Wire check: the test's HTTP bodies (real kobe-models and model-gateway shim) replayed through a
  local Bifrost v2.5.1 to Ollama Cloud: keep 94%, stable_plus_delta 94% cached on turn 5,
  strip 0%, system hits only when picks repeat.

## Follow-ups (for the coordinator)

- Re-run `KOBE_EVAL_PLACEMENTS=... e2e/memory-eval.sh cache` on gate1 after deploy; fill the
  gate-7a table.
- `latest_user_strip` cannot cache on providers like Ollama Cloud (guide says so now).
- Restarting Pi for every plain message (leaf as `parent_entry_id`) costs a process start per
  message; skipping the marker when the parent is already the session leaf would need the
  server's KOBE-290 prompt check to accept marker-less runs. Not done here.
- The faux model test extension gained `dumpContext` (records each request).
