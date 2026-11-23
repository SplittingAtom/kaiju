# KOBE-817: Scheduler logs an error at start that KOBE_APPROVAL_KEY is not set

- **Status:** in review
- **Branch / worktree:** `group-111-small-followups` in `../Kobe-g111`

## Decisions

- The scheduler process (`KOBE_PROCESS=scheduler`) cannot reach an approval decision or sign or
  verify an approval: `startListeners` builds its app without deps (health endpoints only, so no
  `/v1/approvals` route), attaches the sandbox wire and the internal listener only on a server
  process, and a scheduled run does not wait for approvals (broker: "scheduled runs do not wait").
  Its only approvals job is the expiry sweep, which uses no key.
- So the chart stays as it is (the scheduler chart test already asserts it gets no
  `KOBE_APPROVAL_KEY`); the scheduler passes `SCHEDULER_APPROVALS` (`decides: false`) and does not
  log the error. Without a key approvals are still denied everywhere; no bypass.
- Docs: no change to `docs/guide/`; nothing a member, admin or agent sees changes (a log line).

## Evidence

- ac-1/ac-2: `services/server/src/approvals/service-key.test.ts`.
- ac-3: not applicable (the scheduler does not need the key); `charts/kobe/tests/scheduler.test.ts`
  keeps asserting it is absent.
