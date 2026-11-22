#!/usr/bin/env bash
# Kobe k3d end-to-end suite (KOBE-7). Expects a cluster from scripts/dev-cluster.sh and the Kobe
# images available to it under ghcr.io/splittingatom/kobe-*:${KOBE_IMAGE_TAG} (e.g. via
# `k3d image import`). Starts from clean state each run (dev Postgres, release, namespaces), installs
# the chart with dev/values.yaml, then checks platform invariants. Later tickets add their stories.
# Refuses to run against anything but a k3d context (or KOBE_E2E_CONTEXT, named explicitly).
set -euo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # sections are sourced relative to this script
cd "$(dirname "$0")/.."
# shellcheck source=lib/run-common.sh
source "$E2E_DIR/lib/run-common.sh"
# shellcheck source=run/10-deploy.sh
source "$E2E_DIR/run/10-deploy.sh"
# shellcheck source=run/20-checks.sh
source "$E2E_DIR/run/20-checks.sh"
# gate1-prep skips from here to the KOBE-40 model setup (the end of this `if` is marked).
if [[ "$SHARD" != gate1-prep ]]; then
# shellcheck source=run/30-sandbox-provider.sh
source "$E2E_DIR/run/30-sandbox-provider.sh"
# shellcheck source=run/31-sandbox-wire.sh
source "$E2E_DIR/run/31-sandbox-wire.sh"
# shellcheck source=run/32-hibernate-wake.sh
source "$E2E_DIR/run/32-hibernate-wake.sh"
# shellcheck source=run/33-workspace-sync.sh
source "$E2E_DIR/run/33-workspace-sync.sh"
# shellcheck source=run/34-runs.sh
source "$E2E_DIR/run/34-runs.sh"
# shellcheck source=run/35-interrupted-runs.sh
source "$E2E_DIR/run/35-interrupted-runs.sh"
# shellcheck source=run/36-approvals.sh
source "$E2E_DIR/run/36-approvals.sh"
# shellcheck source=run/37-egress-proxy.sh
source "$E2E_DIR/run/37-egress-proxy.sh"
fi # gate1-prep skips the sections above

# KOBE-40: models through Bifrost. A fake OpenAI/Anthropic/Gemini upstream stands in for the
# providers (CI has no provider keys). The Owner configures providers (with keys), the catalog and
# the team's models through the admin API; the gateway sync pushes them to Bifrost; a sandbox-like
# client calls each provider kind through the model-gateway shim with its model-gateway session
# token, and is refused without it, with another audience's token, and after revocation.
echo "==> model gateway (KOBE-40)"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" ]]; then
# shellcheck source=run/40-model-gateway-setup.sh
source "$E2E_DIR/run/40-model-gateway-setup.sh"
  if $KUBECTL -n "$TEAM_NS" wait --for=condition=Ready "pod/$MODEL_CLIENT" --timeout=240s >/dev/null 2>&1; then
# shellcheck source=run/41-model-gateway-access.sh
source "$E2E_DIR/run/41-model-gateway-access.sh"
# shellcheck source=run/42-model-gateway-run.sh
source "$E2E_DIR/run/42-model-gateway-run.sh"
# shellcheck source=run/43-compaction-and-stop.sh
source "$E2E_DIR/run/43-compaction-and-stop.sh"
# shellcheck source=run/44-artifacts.sh
source "$E2E_DIR/run/44-artifacts.sh"
# shellcheck source=run/45-projects-fork.sh
source "$E2E_DIR/run/45-projects-fork.sh"
# shellcheck source=run/46-titles-follow-ups.sh
source "$E2E_DIR/run/46-titles-follow-ups.sh"
# shellcheck source=run/47-uploads-revocation.sh
source "$E2E_DIR/run/47-uploads-revocation.sh"
  else
    fail "the model client pod (sandbox image, gVisor) is ready: $($KUBECTL -n "$TEAM_NS" get pod "$MODEL_CLIENT" \
      -o jsonpath='{.status.phase} {.status.containerStatuses[0].state}' 2>&1)"
  fi
elif [[ "${CI:-}" == "true" ]]; then
  fail "model gateway checks need KOBE_SANDBOX_IMAGE"
else
  echo "SKIP model gateway checks (KOBE_SANDBOX_IMAGE not set)"
fi

# shellcheck source=run/50-request-access.sh
source "$E2E_DIR/run/50-request-access.sh"
# shellcheck source=run/51-mcp-proxy.sh
source "$E2E_DIR/run/51-mcp-proxy.sh"
# shellcheck source=run/52-scheduled-runs-executor.sh
source "$E2E_DIR/run/52-scheduled-runs-executor.sh"
# shellcheck source=run/53-mcp-token-rotation.sh
source "$E2E_DIR/run/53-mcp-token-rotation.sh"
# shellcheck source=run/54-chart-upgrade.sh
source "$E2E_DIR/run/54-chart-upgrade.sh"
exit "$failed"
