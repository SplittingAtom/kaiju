# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
echo "==> chart upgrade reaches an awake sandbox (KOBE-116)"
if [[ -n "${KAIJU_SANDBOX_IMAGE:-}" && -n "${sandbox_id:-}" ]]; then
  # Exit status = reachability, from the real agent container; --noproxy: the pod's HTTP_PROXY
  # would otherwise send the request through the egress proxy.
  sbx_reaches() { # url
    $KUBECTL -n "$TEAM_NS" exec "$(sandbox_pod_name)" -c agent -- curl -sf --noproxy '*' -m 3 -o /dev/null "$1" >/dev/null 2>&1
  }
  sbx_cannot_reach() { ! sbx_reaches "$1"; }
  sbx_uid() { $KUBECTL -n "$TEAM_NS" get pod "$(sandbox_pod_name)" -o jsonpath='{.metadata.uid}' 2>/dev/null; }
  server_pods() { $KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name | sort; }
  # Newest reconcile summary with changed policy from a server pod that did not exist before the
  # upgrade (given as $1, a sorted list of pod names): only a pass of the new config counts.
  changed_summary() {
    local pod
    for pod in $(server_pods | grep -vxF -f <(printf '%s\n' "$1" | sed 's/^$/-none-/')); do
      $KUBECTL -n "$NS" logs "$pod" -c server 2>/dev/null || true
    done | grep '"msg":"team namespaces reconciled"' | grep '"policyChanged":[1-9]' | tail -n 1 || true
  }
  upgrade_gateway_access() { # true|false → sets the flag; prints the helm output
    $HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set "sandbox.modelGatewayAccess=$1" --set server.sessionTokenTtlSeconds=900 2>&1
  }

  mg_url="http://$(svc_ip kobe-model-gateway)/healthz"
  server_url="http://$(svc_ip kobe-server):8081/healthz"
  # The sandbox is awake and connected when the section starts (hibernation is off the path here).
  if ! pod_running; then lifecycle wake >/dev/null; fi
  until_ok 120 pod_running || true
  until_ok 120 wire_open || true
  sbx_uid_before=$(sbx_uid)
  sbx_pod_before=$(sandbox_pod_name)
  contains "an awake sandbox pod is running before the upgrade" '^[0-9a-f-]{36}$' "$sbx_uid_before"
  if until_ok 90 sbx_reaches "$mg_url"; then ok "before: the awake sandbox reaches the model gateway (control)"
  else fail "before: the awake sandbox reaches the model gateway (control)"; fi

  # Withdraw the model gateway: the live sandbox must lose it once the reconcile applies the policy.
  before_pods=$(server_pods)
  if out=$(upgrade_gateway_access false); then ok "chart upgraded with sandbox.modelGatewayAccess=false"
  else fail "chart upgraded with sandbox.modelGatewayAccess=false: $out"; fi
  contains "the reconcile of the upgraded server changed the team policy (gateway withdrawn)" '"policyChanged":[1-9]' \
    "$(wait_for 120 '"policyChanged":[1-9]' changed_summary "$before_pods")"
  contains "control: the awake sandbox still reaches the server's sandbox port" '^yes$' \
    "$(if until_ok 90 sbx_reaches "$server_url"; then echo yes; else echo no; fi)"
  if until_ok 90 sbx_cannot_reach "$mg_url"; then ok "the awake sandbox can no longer reach the model gateway"
  else fail "the awake sandbox can no longer reach the model gateway"; fi

  # Allow it again: the newly allowed service, reached by the same sandbox pod, no wake, no recreate.
  before_pods=$(server_pods)
  if out=$(upgrade_gateway_access true); then ok "chart upgraded with sandbox.modelGatewayAccess=true"
  else fail "chart upgraded with sandbox.modelGatewayAccess=true: $out"; fi
  contains "the reconcile of the upgraded server changed the team policy (gateway allowed)" '"policyChanged":[1-9]' \
    "$(wait_for 120 '"policyChanged":[1-9]' changed_summary "$before_pods")"
  if until_ok 90 sbx_reaches "$mg_url"; then ok "after the reconcile the awake sandbox reaches the newly allowed model gateway"
  else fail "after the reconcile the awake sandbox reaches the newly allowed model gateway"; fi
  contains "it is the same sandbox pod (not woken or recreated)" "^${sbx_pod_before}\\|${sbx_uid_before}\$" \
    "$(sandbox_pod_name)|$(sbx_uid)"
elif [[ "${CI:-}" == "true" ]]; then
  fail "the upgrade-reaches-sandbox check needs KAIJU_SANDBOX_IMAGE and the e2e sandbox"
else
  echo "SKIP upgrade-reaches-sandbox check (KAIJU_SANDBOX_IMAGE not set)"
fi

