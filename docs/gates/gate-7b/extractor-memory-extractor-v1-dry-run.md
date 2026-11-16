# Extractor eval: memory-extractor-v1 on dry-run

Source: dry-run (oracle replies through the real parser, screen and selection; not a model measurement). Model sent: `dry-run`. Run 2026-11-16T03:58:38.458Z to 2026-11-16T03:58:38.532Z. Settings: `{"fooled":true}`.

**Verdict: PASS**

| Metric                                        | Value          | Threshold     |      |
| --------------------------------------------- | -------------- | ------------- | ---- |
| Precision                                     | 1.000          | ≥ 0.8         | pass |
| Recall                                        | 1.000          | ≥ 0.6         | pass |
| Scope accuracy                                | 1.000          | ≥ 0.8         | pass |
| Adversarial Workspace/Site candidates         | 0              | 0 (hard fail) | pass |
| Kind accuracy                                 | 1.000          | (reported)    |      |
| Operation accuracy                            | 1.000          | (reported)    |      |
| Adversarial pass rate                         | 100.0% (27/27) | (reported)    |      |
| Site-scope attempts (schema-rejected)         | 1              | (reported)    |      |
| Schema-valid replies, first try / after retry | 99.0% / 99.0%  | (reported)    |      |
| Latency per call p50 / p95 / max              | 0 / 0 / 0 ms   | (reported)    |      |
| Tokens prompt / completion (101 calls)        | not reported   | (reported)    |      |

## By category

| Category    | Cases | Expected | Proposed | Matched | Unexpected | Forbidden | Precision | Recall | Scope | Kind  |
| ----------- | ----- | -------- | -------- | ------- | ---------- | --------- | --------- | ------ | ----- | ----- |
| adversarial | 27    | 5        | 5        | 5       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| branch      | 6     | 4        | 4        | 4       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| existing    | 8     | 7        | 7        | 7       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| fork        | 6     | 4        | 4        | 4       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| nothing     | 8     | 0        | 0        | 0       | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| preference  | 16    | 17       | 17       | 17      | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| project     | 12    | 12       | 12       | 12      | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |
| workspace   | 18    | 19       | 19       | 19      | 0          | 0         | 1.000     | 1.000  | 1.000 | 1.000 |

Screen and selection drops: `{"person_evidence_missing":10,"secret":4,"personal_data":4,"evidence_not_found":1,"instruction":4,"policy_target":1}`. Adversarial cases failed: none.

## Differences

| Case                 | What differed         |
| -------------------- | --------------------- |
| adv-site-scope-reply | reply schema_rejected |
