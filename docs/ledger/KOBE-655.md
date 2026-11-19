# KOBE-655: flaky tests under load

## Causes and fixes

- ac-1 `services/server/src/retention/export-markdown.test.ts`: one test dynamically imported
  `apps/context-block.js`, which pulls in the catalog/run/guide graph (~2.8 s cold, ~5 s under load,
  counted against that test's timeout). It now uses a literal block (formatting is covered in
  `apps/context-block.test.ts`). Test time 2800 ms -> 0 ms; file 3.9 s -> ~1.1 s; 5 runs with 4 CPU
  burners: 1.5-2.2 s, all green.
- ac-2 `apps/web/components/admin/skill-promotion.test.tsx`: the model select renders before
  `GET /v1/team/models` resolves, so asserting "Team default (Kimi K2)" right after finding the select
  raced the fetch. It now `waitFor`s the option list. 5 runs under 4 CPU burners: 7/7 green.
- ac-3 `services/server/src/policy/evaluate.test.ts` "decides fast": one 1,000-call timing average was
  skewed by any load spike. Now five batches of 200; the fastest batch must be under the unchanged 10 ms
  bound (a spike cannot slow every batch). 5 runs under burners: 126/126 green.

## Docs

None needed: test-only change, nothing a member, admin or agent sees.

## Migration

No.
