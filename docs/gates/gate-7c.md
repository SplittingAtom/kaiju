# Gate 7C: v1.3 Semantic Memory Phase C (Site proposals) verification

## Wall probe (KOBE-406)

No thread-derived text crosses to the Site (SM20): only the confirmed statement and justification.

- **Probe:** [`services/server/src/site-wall-probe.db.test.ts`](../../services/server/src/site-wall-probe.db.test.ts)
  (server DB test; runs in CI's DB job and in `pnpm verify` with `KOBE_TEST_DATABASE_URL`).
- **Reusable detector:** [`services/server/src/testing/site-wall-probe.ts`](../../services/server/src/testing/site-wall-probe.ts)
  (`SiteWallProbe`, `findLeaks`, `siteTableRows`, `canary`): a case-insensitive search for canary
  strings and ids, plus forbidden fields (`evidence`, `quote`, `rationale`, `source_thread_id`,
  thread/entry/run/pass/candidate ids) with a value, over every string and key of every value.
- **Seed:** two threads with canaries in the person's message, the evidence quote, the assistant's
  answer, a tool's output and the candidates' rationale, canary entry ids, and their thread, run,
  pass and candidate ids; real learning passes (scripted extractor) make the candidates.
- **Entry points:** Propose → Site from a candidate; Propose to Site from a Workspace memory saved
  from a candidate (its version keeps the thread link); confirm with edit; request changes and
  confirm again; approve (edited); merge; reject.
- **Read paths:** every `site_memory%` table's rows; the Site console queue (each state), detail
  and provenance for Site admins and Site stewards; the Workspace proposal list and detail; Site
  item list, detail and provenance for members and another Workspace's Team admin; run context
  (selector and recall) of a member's run; admin MCP `site_memory_items_list` /
  `site_memory_item_get` (KOBE-650) through the executor's delegated route call; the Site memory
  export (JSON and CSV, inactive included); notifications (rows, digest, swept reminders, email
  rows, the bell API, mail sent); audit entries of these flows (rows and `/v1/site/audit`).
- **Mutation check (ac-2):** the same test corrupts one proposal row (rationale appended) and one
  Site version (evidence quote appended) and asserts the probe reports each read path that shows
  them; a detector test injects an `evidence` field into a view.
