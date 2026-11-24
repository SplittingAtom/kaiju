# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
TAG="${KOBE_IMAGE_TAG:?set KOBE_IMAGE_TAG (use a per-run tag so stale images cannot pass)}"
NS=kobe-dev
SANDBOX_NS=kaiju-e2e-sandbox
TEAM_NS=kobe-team-e2e # KOBE-22: created by the server, not by this script
TEAM2_NS=kobe-team-e2e2
UPSTREAM_NS=kaiju-e2e-upstream # KOBE-38: an in-cluster HTTPS server standing in for the internet
MCP_NS=kaiju-e2e-mcp # KOBE-58: a fake remote MCP server
LLM_NS=kaiju-e2e-llm # KOBE-40: a fake model provider
OTEL_NS=kaiju-e2e-otel # KOBE-274: a minimal OTLP sink (e2e/lib/otlp-sink.js); tracing is on for the suite
OTEL_SINK="http://otlp.$OTEL_NS.svc.cluster.local:4318"
# The proxies and the gateway restrict egress: each may reach the sink (merged into later overrides).
OTEL_RULE=$(printf '{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}],"ports":[{"protocol":"TCP","port":4318}]}' "$OTEL_NS")
# CI runs the suite as parallel shards, each on its own cluster (.github/workflows/e2e.yml).
# KOBE_E2E_TOOL_EXECUTOR=1 installs with sandbox.toolExecutor.enabled=true (KOBE-168): every section
# then runs with Pi's tools in the paired-uid executor, plus the isolation checks of e2e/executor/.
# Every shard installs from clean state and runs the checks section; then:
#   all (default)  every section, in order
#   suite          every section except the KOBE-25 cold-start trials
#   cold-start     the sections up to and including KOBE-25 hibernate and wake, with its trials
#   gate1-prep     only the KOBE-40 model setup e2e/gate1.sh needs; keeps the fake provider running
SHARD="${KOBE_E2E_SHARD:-all}"
case "$SHARD" in
  all | suite | cold-start | gate1-prep) ;;
  *) echo "unknown KOBE_E2E_SHARD '$SHARD' (all, suite, cold-start, gate1-prep)" >&2; exit 2 ;;
esac
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_E2E_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_E2E_CONTEXT=$context)" >&2
  exit 2
fi

ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failed=1; }
# (Written for bash 3.2: no quoted command substitutions nested in double quotes.)
expect() { # name, regex, actual output: passes when every line of actual matches regex
  local got
  got=$(printf '%s\n' "$3" | tail -3)
  if [[ -n "$3" ]] && ! grep -Evq "$2" <<<"$3"; then ok "$1"; else fail "$1: got [$got]"; fi
}
contains() { # name, regex, actual output: passes when some line matches regex
  local got key
  got=$(printf '%s\n' "$3" | tail -3)
  # A `^key=value$` check reports that key's own line, not just the output's last lines.
  if [[ $2 =~ ^\^([a-z_]+)= ]]; then
    key=$(grep -E "^${BASH_REMATCH[1]}=" <<<"$3" | head -3 || true)
    if [[ -n $key ]]; then got=$key; fi
  fi
  if grep -Eq "$2" <<<"$3"; then ok "$1"; else fail "$1: got [$got]"; fi
}

wait_for() { # seconds regex command... → reruns command until a line matches regex (bounded); prints the last output
  local deadline=$((SECONDS + $1)) re="$2" out=""
  shift 2
  while :; do
    out=$("$@" 2>&1 || true)
    if grep -Eq "$re" <<<"$out"; then break; fi
    if ((SECONDS >= deadline)); then break; fi
    sleep 2
  done
  printf '%s\n' "$out"
}

PODS=()
cleanup() {
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  $KUBECTL delete namespace "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  $KUBECTL delete namespace "$TEAM_NS" "$TEAM2_NS" "$UPSTREAM_NS" "$MCP_NS" "$OTEL_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # gate1-prep leaves the fake model provider to e2e/gate1.sh, which runs next.
  if [[ "$SHARD" != gate1-prep ]]; then
    $KUBECTL delete namespace "$LLM_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  $KUBECTL delete runtimeclass kaiju-e2e-runc --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Reachability: positive checks wait for their target (bounded), then assert, so a dead target
# still fails. A Service answers only once it has ready endpoints, and a new pod joins the CNI's
# policy ipsets on kube-router's next sync, so policy-guarded targets refuse it for its first
# seconds (docs/ledger/KOBE-22.md). Negative checks (BLOCKED) run only after a positive control
# succeeded from the same pod; otherwise they report UNTESTED and fail, never pass vacuously.
REACH_TIMEOUT=60
wait_endpoints() { # namespace service... → waits up to REACH_TIMEOUT s for ready endpoints
  local ns="$1" svc deadline=$((SECONDS + REACH_TIMEOUT))
  shift
  for svc in "$@"; do
    until [[ -n "$($KUBECTL -n "$ns" get endpointslices -l "kubernetes.io/service-name=$svc" \
      -o jsonpath='{.items[*].endpoints[?(@.conditions.ready==true)].addresses[0]}' 2>/dev/null)" ]]; do
      if ((SECONDS >= deadline)); then echo "warning: $ns/$svc has no ready endpoints" >&2; break; fi
      sleep 1
    done
  done
}
# Shell snippet for a probe pod: runs a command until it succeeds or [seconds] (default REACH_TIMEOUT) pass; its exit
# status says which: one { } group, so `! $(retry ...)`, `$(retry ...) && ...` and `if` gate on
# it. (No double quotes: team_pod embeds the pod command in JSON.)
retry() { # command [seconds]
  echo "{ ok=0; end=\$((\$(date +%s) + ${2:-$REACH_TIMEOUT})); while :; do if $1 >/dev/null 2>&1; then ok=1; break; fi; \
[ \$(date +%s) -ge \$end ] && break; sleep 1; done; [ \$ok = 1 ]; }"
}
answers() { echo "wget -qO- -T 3 $1"; } # [wget options] URL → a command that succeeds once it answers
# Gated negative check, in a probe pod: when the control URL answers, prints control=REACHED and
# label=REACHED|BLOCKED for URL; otherwise control=BLOCKED and label=UNTESTED.
gated() { # control-url label url
  echo "if $(retry "$(answers "$1")"); then echo control=REACHED; \
$(answers "$3") >/dev/null 2>&1 && echo $2=REACHED || echo $2=BLOCKED; else echo control=BLOCKED; echo $2=UNTESTED; fi"
}
probe() { # namespace, shell command → prints its output (unique pod, cleaned up on exit)
  local ns="$1" name="probe-$BASHPID-$RANDOM$RANDOM" # BASHPID: each $(probe) subshell its own
  PODS+=("-n $ns $name")
  $KUBECTL -n "$ns" run "$name" --restart=Never --image=busybox:1.37 --command -- sh -c "$2" >/dev/null
  local phase="" i
  for i in $(seq 1 120); do # until the pod finishes either way (a failed wget is a valid answer)
    phase=$($KUBECTL -n "$ns" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
    sleep 2
  done
  $KUBECTL -n "$ns" logs "$name" 2>/dev/null || true
}
reachable() { # namespace service-namespace service [wget options] URL → URL's body once it answers
  wait_endpoints "$2" "$3"
  probe "$1" "$(retry "$(answers "$4")"); $(answers "$4")"
}

