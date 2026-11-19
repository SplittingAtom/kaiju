# KOBE-607: the first tool run after a wake never ends (run stays active, blocks hibernation)

- **Status:** committed on `kobe-607-tool-run-hang`, not pushed
- **Branch / worktree:** `kobe-607-tool-run-hang` in `../Kobe-wt607`
- **Also closes:** the open KOBE-415/KOBE-480 hang ("a tool ran, then the run never ended": memory
  remember, KOBE-39 blocked-egress run). Same signature.

## Root cause (ac-1)

Taken from the "did not end" blocks that KOBE-563's harness printed (executor job of e2e run
43762038984, trial 5, executor on; suite job of 43606311020, trial 4, executor off; the KOBE-39
"blocked run" of 42753401961; agent lines also in 43024675612, 42735701496, 43483120553). Every one
shows the same thing:

```
event 7 tool.call … event 8 tool.result …   run running
agent: runtime_tampered during get_entries: the model file is not what the agent wrote; Pi stopped
server: entry sync failed code=runtime_tampered
```

Neither the executor nor the wake/reconnect is the cause; the wake only makes the timing likely (cold
gVisor I/O, a new thread).

1. **False tamper (sandbox-agent).** After the tool result Pi emits `turn_end`, and the server
   mirrors entries with a `get_entries` `pi.command`. The agent checks the tripwire
   (`Thread.verifyRuntime`) before and after it. At the same moment Pi's next `turn_start` makes
   the trace recorder write the turn's `traceparent` into the model file (`setTraceparent`, not
   awaited). `ModelFile.verify()` awaited the write chain, then read the file _outside_ it. A write
   started during the read either renamed in the new file under the read or set the expected text
   `#writtenText` before the comparison. Old text against the new expected text (or the reverse)
   gave "the model file is not what the agent wrote". `MemoryContextFile` (mid-run
   `conflictsLive` rewrites, KOBE-492) and `EgressTokenFile` (rotation) had the same pattern.
2. **The run never ended (server).** `stopTampered` stops Pi as an _expected_ close, so the agent
   ends the run locally (`endRun`; the wire drops its later frames) and sends no `pi.exited`. The
   server only logged "entry sync failed": the run stayed `running` under the live connection's
   lease, so the lost-run sweep (leaseless runs only) never touched it, and `lockIfIdle` refused
   every hibernate. A real tamper mid-run would have hung the same way.

## Fix (ac-2)

- `services/sandbox-agent/src/models/model-file.ts`, `memory/context-file.ts`,
  `egress/egress-wiring.ts`: `verify()` now runs on the write chain, so no write can start
  between its read and its comparison (writes queued meanwhile wait a few ms for the read).
- `services/server/src/sandbox-wire/delivery.ts`: a `pi.command` answered `runtime_tampered`
  (internal `get_entries` in `fetchNewEntries`, or a row `pi.command` in `#record`) means the agent
  stopped that thread's Pi. `#tamperedMidRun` ends the lease of every live message run of the
  thread and fails it `runtime_tampered`, with the `sandbox.runtime_tampered` audit row in the
  same transaction (`#endTx`, as for a refused start). Pi is not asked for entries again.
  `DeliveryHost.liveMessageRuns(threadId)` is new (implemented in `connection.ts`; compaction
  leases are left alone, since their own result ends them).

### Safety net: limits that already exist (not duplicated)

- Connection gone: the run loses its lease. The lost-run sweep (`runs/sweeper.ts` `lostStarts`) and
  "interrupted runs of lost sandboxes" end it.
- Pi crashes or exits unexpectedly: `pi.exited`, and the server interrupts the thread's runs.
- Stop not answered: the `pendingStops` sweep resends it. Compactions and branch summaries:
  `staleCompactions`.
- The one silent path left, an agent-initiated Pi stop during a run (the tamper stop), now ends
  the run on the server. I did not add a time-based "no frames for N minutes" limit: legitimate
  tool calls and approvals have no common upper bound on the server, and such a limit would fail
  long runs. Nothing remaining needs it.

No wake or lifecycle code was touched (KOBE-636 works there).

## Tests

- `services/sandbox-agent/src/threads/tripwire-race.test.ts` (new): holds the tripwire's read open
  (mocked `readFile` that has already read the file), starts the agent's own rewrite, then releases
  the read. Model file, memory context file, egress token file. Before the fix all 3 failed
  (`expected false to be true`); after it they pass. A rewrite by someone else is still caught.
- `services/server/src/runtime-tamper.db.test.ts` "a run whose Pi was stopped mid-run (get_entries
  refused runtime_tampered) is failed…": tool call, tool result, `turn_end`, `get_entries` refused.
  Before the fix the run stayed `running` (timed out); after it the run is `failed`
  `runtime_tampered`, has one audit row with `runKind: message`, and the thread takes the next run.

- `pnpm verify` green after merging origin/main (no conflicts); sandbox-wire db tests
  (`sandbox-wire`, `-entries`, `-limits`) green.

## Docs

None needed. Nothing new to see or do: a run that hung forever now ends with the existing
`runtime_tampered` failure message, and only on a real tamper. The guide does not describe
tampering.

## For KOBE-563 (next wave)

- The "every first tool run after a wake completed" check should now stay green. If a "did not
  end" block ever shows `runtime_tampered` again, it is a real tamper or a new writer that rewrites
  a guarded file outside its writer class. If it shows something else, it is a different hang. In
  both cases the run now fails instead of blocking hibernation, so the knock-on failures are gone
  either way.
- `owner_hibernate`'s cancel fallback can stay as a guard. It should no longer fire.
- ac-2 "five green hosted executor runs" is for the coordinator to watch after merge.
