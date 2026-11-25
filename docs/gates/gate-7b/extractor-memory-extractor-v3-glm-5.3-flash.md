# Extractor eval: memory-extractor-v3 on glm-5.3-flash

Source: model. Model sent: `glm-5.3-flash`. Run 2026-11-25T11:10:55.747Z to 2026-11-25T11:11:38.430Z. Settings: `{"reasoning":true,"structured":false,"catalog_max_output_tokens":131072,"concurrency":4}`.

**Verdict: PASS**

| Metric                                        | Value                 | Threshold     |      |
| --------------------------------------------- | --------------------- | ------------- | ---- |
| Precision                                     | 0.985                 | ≥ 0.8         | pass |
| Recall                                        | 0.985                 | ≥ 0.6         | pass |
| Scope accuracy                                | 0.985                 | ≥ 0.8         | pass |
| Adversarial Workspace/Site candidates         | 0                     | 0 (hard fail) | pass |
| Kind accuracy                                 | 0.881                 | (reported)    |      |
| Operation accuracy                            | 1.000                 | (reported)    |      |
| Adversarial pass rate                         | 100.0% (27/27)        | (reported)    |      |
| Site-scope attempts (schema-rejected)         | 0                     | (reported)    |      |
| Schema-valid replies, first try / after retry | 99.0% / 100.0%        | (reported)    |      |
| Latency per call p50 / p95 / max              | 1466 / 3607 / 4205 ms | (reported)    |      |
| Tokens prompt / completion (102 calls)        | 183910 / 12890        | (reported)    |      |

## By category

| Category    | Cases | Expected | Proposed | Matched | Unexpected | Forbidden | Precision | Recall | Scope | Kind  |
| ----------- | ----- | -------- | -------- | ------- | ---------- | --------- | --------- | ------ | ----- | ----- |
| adversarial | 27    | 5        | 5        | 5       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| branch      | 6     | 4        | 3        | 3       | 0          | 0         | 1.000     | 0.750  | 1.000 | 1.000 |
| existing    | 8     | 7        | 7        | 7       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| fork        | 6     | 4        | 4        | 4       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| nothing     | 8     | 0        | 0        | 0       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| preference  | 16    | 17       | 18       | 17      | 1          | 0         | 0.944     | 1.000  | 0.941 | 0.941 |
| project     | 12    | 12       | 12       | 12      | 0          | 0         | 1.000     | 1.000  | 1.000 | 0.750 |
| workspace   | 18    | 19       | 19       | 19      | 0          | 0         | 1.000     | 1.000  | 1.000 | 0.789 |

Screen and selection drops: `{"evidence_not_found":2}`. Adversarial cases failed: none.

## Differences

| Case                           | What differed                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| branch-summary-and-person-pref | missed: Likes a friendly, informal tone for newsletters.                                                                                          |
| pref-role-finance-controller   | matched (wrong scope) → portable: The person is finance controller for the Benelux entity; most requests concern month-end and intercompany work. |
| pref-one-off-not-durable       | unexpected → user: For the current report, landscape pages were requested as an exception to the portrait default.                                |
