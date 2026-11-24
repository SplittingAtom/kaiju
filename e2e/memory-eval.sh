#!/usr/bin/env bash
# Semantic memory eval harness (KOBE-387; v1.3 SM25/SM30, Gate A = KOBE-388). KOBE-400 extends it
# with the extractor eval. Method and results: docs/gates/gate-7a.md; the relevance set and how it
# was built: e2e/fixtures/memory-relevance/README.md.
#
#   e2e/memory-eval.sh relevance
#     Seeds e2e/fixtures/memory-relevance/items.json into a throwaway database on
#     KOBE_TEST_DATABASE_URL's server (a superuser URL; the database is created and dropped), runs
#     the KOBE-382 selector's store read for each of the ~150 queries and prints recall@8 per kind
#     and overall (the Gate A number: Phase D vectors only if it is below 0.85).
#     KOBE-409 hybrid comparison: also set an OpenAI-compatible embedding endpoint (from the
#     operator's shell, never committed) and the report adds hybrid recall@8 and the per-message
#     query embedding latency:
#       KOBE_EVAL_EMBED_URL    base URL ending in /v1 (an Ollama, the in-cluster model, a provider)
#       KOBE_EVAL_EMBED_MODEL  the endpoint's model name, e.g. nomic-embed-text
#       KOBE_EVAL_EMBED_KEY    bearer key, if the endpoint needs one
#     The scratch database needs pgvector on that server (it is enabled as the superuser).
#     KOBE-664: both reports add a "recall tool" column: recall@8 of what the agent's
#     recall({ query }) answers for each query (keyword-only, then hybrid with the same vector).
#
#   e2e/memory-eval.sh cache
#     Replays the 20 messages of e2e/fixtures/memory-cache/turns.json in one new thread on a
#     running Kaiju (real model through the gateway) and prints the cache-read share from the
#     thread's gateway usage (all turns, and turns 2-20). Environment (from the operator's shell,
#     never committed):
#       KOBE_EVAL_URL       the install's public URL, e.g. https://kobe.example.com (required)
#       KOBE_EVAL_EMAIL / KOBE_EVAL_PASSWORD   a member's password sign-in, or
#       KOBE_EVAL_COOKIE    a signed-in browser's Cookie header value (SSO-only installs)
#       KOBE_EVAL_TEAM_ID   the Workspace to use (default: the member's active one)
#       KOBE_EVAL_AGENT_ID  agent to chat with (its Memory setting must be Full; default agent if unset)
#       KOBE_EVAL_MODEL     model alias for the thread (default: the team's default)
#       KOBE_EVAL_SEED=1    first create the memories of e2e/fixtures/memory-cache/seed.json
#                           (once per install; Policy rows need a Site admin)
#       KOBE_EVAL_LABEL     a label for the output (before/after)
#       KOBE_EVAL_PLACEMENTS  KOBE-658: comma-separated Site memory placements (system,
#                           latest_user_keep, latest_user_strip, stable_plus_delta, tool_only);
#                           replays once per mode in a new thread and reports each mode's
#                           cache-read share and memory use (e2e/fixtures/memory-cache/expect.json).
#                           The member must be a Site admin; the Site's placement is restored.
#
#   e2e/memory-eval.sh extractor
#     KOBE-400 (spec U52, Gate B): runs the current extractor prompt over the ~100 seeded
#     transcripts of e2e/fixtures/memory-extractor/cases/ (README there), screens and selects each
#     reply as a learning pass does, and scores precision, recall, scope/kind/operation accuracy,
#     adversarial Workspace/Site offers, schema-valid rate, latency and tokens. Exits non-zero
#     when a Gate B threshold is missed (precision >= 0.8, recall >= 0.6, scope accuracy >= 0.8,
#     zero adversarial Workspace/Site candidates). Writes
#     docs/gates/gate-7b/extractor-<prompt version>-<label>.{json,md} and the run's row in
#     docs/gates/gate-7b.md (method: that page). One source, from the operator's shell:
#       KOBE_EXTRACTOR_URL    an OpenAI-compatible base URL (e.g. https://provider.example/v1) of
#                             the provider behind the Site's learning model, with
#       KOBE_EVAL_MODEL       the provider's model id (required with the URL)
#       KOBE_EXTRACTOR_API_KEY or KOBE_EXTRACTOR_API_KEY_FILE   the provider key (never printed)
#       KOBE_EXTRACTOR_LABEL  name the results are filed under (default: the model id; use the
#                             Site's learning model alias, e.g. the catalog alias)
#       KOBE_EXTRACTOR_REASONING=1   the catalog marks the model as reasoning (reasoning_effort low,
#                                    16k output cap), as the server sends it
#       KOBE_EXTRACTOR_STRUCTURED=1  send the extractor's response_format (OpenAI-kind providers)
#       KOBE_EXTRACTOR_MAX_OUTPUT_TOKENS  the catalog's max output tokens (clamps the cap)
#       KOBE_EXTRACTOR_CONCURRENCY (default 4), KOBE_EXTRACTOR_TIMEOUT_S (default 60, per call)
#     or KOBE_EXTRACTOR_REPLAY=<results .json>  re-scores an earlier run's recorded replies
#     or KOBE_EXTRACTOR_DRY_RUN=1  oracle replies (fixtures and harness check, no model).
#     KOBE_EXTRACTOR_ONLY=<regex on category/id> runs a subset (the gate page is not updated);
#     KOBE_EVAL_OUT_DIR=<dir> writes the results elsewhere; KOBE_EXTRACTOR_GATE_DOC=none skips
#     the gate page.
#
#   KOBE_EVAL_OUT=<file>  also writes the report as JSON (relevance and cache).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:-}
case "$mode" in
  relevance)
    : "${KOBE_TEST_DATABASE_URL:?set KOBE_TEST_DATABASE_URL to a Postgres 17 superuser URL (a scratch database is created and dropped)}"
    file=relevance.eval.ts
    ;;
  cache)
    : "${KOBE_EVAL_URL:?set KOBE_EVAL_URL to the public URL of the install}"
    if [[ -z "${KOBE_EVAL_COOKIE:-}" && (-z "${KOBE_EVAL_EMAIL:-}" || -z "${KOBE_EVAL_PASSWORD:-}") ]]; then
      echo "set KOBE_EVAL_EMAIL and KOBE_EVAL_PASSWORD, or KOBE_EVAL_COOKIE" >&2
      exit 2
    fi
    file=cache.eval.ts
    ;;
  extractor)
    if [[ -z "${KOBE_EXTRACTOR_URL:-}" && -z "${KOBE_EXTRACTOR_REPLAY:-}" && "${KOBE_EXTRACTOR_DRY_RUN:-}" != 1 ]]; then
      echo "set KOBE_EXTRACTOR_URL and KOBE_EVAL_MODEL, or KOBE_EXTRACTOR_REPLAY, or KOBE_EXTRACTOR_DRY_RUN=1" >&2
      exit 2
    fi
    if [[ -n "${KOBE_EXTRACTOR_URL:-}" && -z "${KOBE_EVAL_MODEL:-}" ]]; then
      echo "set KOBE_EVAL_MODEL to the provider's model id" >&2
      exit 2
    fi
    # Paths the operator gives are relative to their shell, not to services/server.
    for var in KOBE_EXTRACTOR_REPLAY KOBE_EXTRACTOR_API_KEY_FILE KOBE_EVAL_OUT_DIR KOBE_EXTRACTOR_GATE_DOC; do
      value=${!var:-}
      if [[ -n "$value" && "$value" != none && "$value" != /* ]]; then
        export "$var=$PWD/$value"
      fi
    done
    file=extractor.eval.ts
    ;;
  *)
    echo "usage: e2e/memory-eval.sh relevance|cache|extractor" >&2
    exit 2
    ;;
esac

cd "$root"
# The server's workspace dependencies are consumed from dist/ (turbo caches the build).
pnpm turbo run build --filter '@kaiju/server^...' --output-logs=errors-only >&2
if [[ "$mode" != extractor ]]; then
  cd services/server
  exec pnpm exec vitest run -c vitest.eval.config.ts "src/testing/memory-eval/$file"
fi
status=0
(cd services/server && pnpm exec vitest run -c vitest.eval.config.ts "src/testing/memory-eval/$file") || status=$?
# The results pages and the gate table are written unpadded; format them like the rest of docs/.
out_dir=${KOBE_EVAL_OUT_DIR:-$root/docs/gates/gate-7b}
gate_doc=${KOBE_EXTRACTOR_GATE_DOC:-$root/docs/gates/gate-7b.md}
pages=("$out_dir"/extractor-*.md)
[[ "$gate_doc" != none && -f "$gate_doc" ]] && pages+=("$gate_doc")
[[ -e "${pages[0]}" ]] && pnpm exec prettier --write --log-level warn "${pages[@]}" >&2 || true
exit "$status"
