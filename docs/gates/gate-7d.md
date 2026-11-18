# Gate 7D: v1.3 Semantic Memory Phase D (earned retrieval and quality) verification

Gate D (KOBE-412) proves Phase D: vectors earned their place (U50), the Learn nudge (KOBE-410,
SM17) and the quality signals (KOBE-411, SM22, SM30). Install: gate1 at main `5642c909c769`
(`local-5642c909c769`, deployed for Gate C after a database dump), which carries every Phase D
ticket; learning model `glm-5.3-flash` (Ollama Cloud), embeddings from the in-cluster service
(KOBE-659, `kobe-local/nomic-embed-text`).

## Checks

| Check                                         | Result                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| U50: hybrid beats keyword only (KOBE-408/409) | **PASS** recall@8 **0.894** against 0.573 on the 151-query set, on `5642c909` with the in-cluster model (below)           |
| Degrades to keywords without vectors          | **PASS** server DB tests (below); embeddings route takes server-call tokens only (`memory_embed`, gateway tests)          |
| Learn nudge on gate1 (KOBE-410)               | **PASS** `memory-quality-nudge.spec.ts`, twice: pulse after the 10th message, again after a thumbs-down; never a pass     |
| Quality signals on gate1 (KOBE-411)           | **PASS** same spec: queue health, per-memory signals and flags, Learn pass numbers on Workspace and Site Memory › Quality |
| Gate 1 and Gate 2 shards on one commit        | **PASS** on `2088782d` (main with #605; merge-queue e2e run 44409422267, gate1 and gate2 shards and ci all green)         |

## U50: vectors (KOBE-408, KOBE-409, KOBE-659)

Gate A measured keyword retrieval at recall@8 0.573, under the 0.85 line, so KOBE-408 unblocked
vectors (decision and pgvector presence in [gate-7a.md](gate-7a.md)). KOBE-409 added hybrid
retrieval and tuned it on a held-out split ([gate-7b.md](gate-7b.md#vectors-kobe-409)).

Re-measured for this gate on 2026-11-18 at main `5642c909` with `e2e/memory-eval.sh relevance`
(dev Postgres 17 + pgvector), embeddings from gate1's in-cluster service through a port-forward:

| Group             | Queries | recall@8 (relevance) | recall@8 (selector score) | in block | negative above answer |
| ----------------- | ------- | -------------------- | ------------------------- | -------- | --------------------- |
| **overall**       | 151     | **0.894**            | 0.874                     | 0.917    | 16.8%                 |
| preference        | 30      | 0.883                | 0.933                     | 0.983    | 16.7%                 |
| fact              | 30      | 0.883                | 0.867                     | 0.883    | 12.5%                 |
| convention        | 30      | 0.900                | 0.850                     | 0.900    | 23.5%                 |
| definition        | 31      | 0.919                | 0.855                     | 0.919    | 15.4%                 |
| decision          | 30      | 0.883                | 0.867                     | 0.900    | 16.7%                 |
| style: literal    | 50      | 1.000                | 0.990                     | 1.000    | 0.0%                  |
| style: paraphrase | 61      | 0.836                | 0.852                     | 0.852    | 37.5%                 |
| style: indirect   | 40      | 0.850                | 0.762                     | 0.912    | 3.6%                  |

Keyword only on the same set: 0.573 overall, 0.139 on paraphrases. Query embedding p50 54 ms /
p95 81 ms (CPU, measured through the port-forward from the dev VM). Same numbers as at Gate B
(`ee806045`): Phase C and D2 did not move retrieval. The harness's closing line ("Phase D vectors
not indicated") applies the Gate A rule to the hybrid number; it is not a separate verdict.

**Without vectors** (`services/server/src/memory-vectors.db.test.ts`): "Build vectors is
unavailable without a model"; "hybrid selection finds a similar item with no shared word; late
vectors mean keywords only"; "embeds on save …; a budget refusal keeps the save"; an embedding
model must be a gateway provider's (an unknown one is refused, no fallback); vector writes stay
inside the Workspace (RLS); members get 403 on the Site vector routes. The gateway refuses
`memory_embed` for anything but a server-call token (`services/model-gateway/src/server-call.test.ts`).

## Learn nudge and quality signals on gate1

[`e2e/browser/tests/memory-quality-nudge.spec.ts`](../../e2e/browser/tests/memory-quality-nudge.spec.ts),
run from the Playwright 1.55 container against gate1 as the owner, passed twice in a row:

- **Nudge (KOBE-410):** Site settings shows **Nudge to learn**, on (read only). One thread, ten
  short turns: after the 9th message the Learn state has no nudge; after the 10th it reports
  reason `messages` and the `+` dot pulses (`data-kobe-learn-nudge="pulse"`, 2.4 s, counted with a
  MutationObserver). A thumbs-down then gives reason `correction` and a second pulse (cleared
  afterwards). Throughout: no blocker, `running` null, no spinner: the nudge never starts a pass.
  A thumbs-down shows on the next read of the Learn state (reload, run end or opening the Memory
  submenu), as built.
- **Quality (KOBE-411):** on both the Workspace and the Site Memory › Quality tabs: queue health
  (pending, oldest, decided, median time to decision), per-memory runs received, last received,
  thumbs-down and flags (or the empty state), and Learn's pass numbers (shown, saved, proposed,
  dismissed, edited before save), checked for presence and format, not exact values.

Threshold (ac-2 of KOBE-410): 10 user messages (`LEARN_NUDGE_MESSAGES`). gate1's Phase B data
(36 hand-started acceptance passes on short chats) is too small to tune from; recorded in
[KOBE-410's ledger](../ledger/KOBE-410.md). Unit and DB evidence for both tickets is in
[KOBE-410](../ledger/KOBE-410.md) and [KOBE-411](../ledger/KOBE-411.md) (flags never archive;
queue health on seeded data; pass signals; 1,000-item performance seed).

## Acceptance criteria

| Criterion | Evidence                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------- |
| ac-1 U50  | Hybrid 0.894 vs keyword 0.573 on the 151-query set at `5642c909`, in-cluster model; degradation DB tests |
| ac-2      | Nudge and quality signals visible on gate1: `memory-quality-nudge.spec.ts`, two passing runs             |
| ac-3      | Gate 1 and Gate 2 shards green on `2088782d` (e2e run 44409422267)                                       |

## Decisions for Chris

None new from Phase D. Open from earlier gates and needed before Gate 7 (KOBE-413):

1. **Licences** (`pnpm license:gate` pending): `pgvector` (PostgreSQL License) and
   `llama-cpp-image-packages` (GPL-built ffmpeg and curl in the llama.cpp server image; the
   embedding service is on by default). See [gate-7b.md](gate-7b.md#decisions-for-chris).
2. The other open decisions in [gate-7b.md](gate-7b.md#decisions-for-chris) and
   [gate-7c.md](gate-7c.md).
3. KOBE-410: the nudge threshold stays at 10 until there is real use to tune from; the pulse for a
   thumbs-down waits for the next Learn state read. Both as built.
