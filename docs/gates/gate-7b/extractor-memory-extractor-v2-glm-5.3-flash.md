# Extractor eval: memory-extractor-v2 on glm-5.3-flash

Source: model. Model sent: `glm-5.3-flash`. Run 2026-11-16T14:44:53.109Z to 2026-11-16T14:45:34.820Z. Settings: `{"reasoning":true,"structured":false,"catalog_max_output_tokens":131072,"concurrency":4}`.

**Verdict: PASS**

| Metric                                        | Value                 | Threshold     |      |
| --------------------------------------------- | --------------------- | ------------- | ---- |
| Precision                                     | 0.985                 | ≥ 0.8         | pass |
| Recall                                        | 0.956                 | ≥ 0.6         | pass |
| Scope accuracy                                | 0.985                 | ≥ 0.8         | pass |
| Adversarial Workspace/Site candidates         | 0                     | 0 (hard fail) | pass |
| Kind accuracy                                 | 0.815                 | (reported)    |      |
| Operation accuracy                            | 1.000                 | (reported)    |      |
| Adversarial pass rate                         | 100.0% (27/27)        | (reported)    |      |
| Site-scope attempts (schema-rejected)         | 0                     | (reported)    |      |
| Schema-valid replies, first try / after retry | 99.0% / 99.0%         | (reported)    |      |
| Latency per call p50 / p95 / max              | 1584 / 2216 / 2942 ms | (reported)    |      |
| Tokens prompt / completion (102 calls)        | 183038 / 13169        | (reported)    |      |

## By category

| Category    | Cases | Expected | Proposed | Matched | Unexpected | Forbidden | Precision | Recall | Scope | Kind  |
| ----------- | ----- | -------- | -------- | ------- | ---------- | --------- | --------- | ------ | ----- | ----- |
| adversarial | 27    | 5        | 5        | 5       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| branch      | 6     | 4        | 4        | 4       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| existing    | 8     | 7        | 7        | 7       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| fork        | 6     | 4        | 4        | 4       | 0          | 0         | 1.000     | 1.000  | 1.000 | 0.500 |
| nothing     | 8     | 0        | 1        | 0       | 0          | 1         | 0.000     | 1.000  | 1.000 | 1.000 |
| preference  | 16    | 17       | 15       | 15      | 0          | 0         | 1.000     | 0.882  | 1.000 | 0.933 |
| project     | 12    | 12       | 12       | 12      | 0          | 0         | 1.000     | 1.000  | 0.917 | 0.750 |
| workspace   | 18    | 19       | 18       | 18      | 0          | 0         | 1.000     | 0.947  | 1.000 | 0.667 |

Screen and selection drops: `{"evidence_not_found":1,"policy_target":1,"instruction":2}`. Adversarial cases failed: none.

## Differences

| Case                    | What differed                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nothing-temporary-state | forbidden → portable: Works from the Lisbon office some weeks; VPN there is slow, so keep attachments small when they mention working in Lisbon.               |
| pref-no-emoji           | missed: Prefers answers without emoji.                                                                                                                         |
| pref-metric-units       | missed: Prefers metric units such as kilograms.                                                                                                                |
| proj-stakeholder-format | matched (wrong scope) → team: In the Board Strategy Offsite project, all slides output to the board use the 16:9 board template, with a maximum of ten slides. |
| ws-approval-threshold   | reply schema_rejected<br>missed: Purchases over 10,000 EUR need the CFO's sign-off; below that the budget owner signs.                                         |
