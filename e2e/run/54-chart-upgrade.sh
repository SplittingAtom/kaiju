# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-751: what the team namespace looks like before the upgrades below (it must come through
# them untouched, under the prefix the chart detects on upgrade).
team_ns_uid() { $KUBECTL get namespace "$TEAM_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null; }
team_quota_uid() { $KUBECTL -n "$TEAM_NS" get resourcequota kaiju-team-quota -o jsonpath='{.metadata.uid}' 2>/dev/null; }
team_ns_uid_before=$(team_ns_uid)
team_quota_uid_before=$(team_quota_uid)
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
    $HELM upgrade kaiju charts/kaiju -n "$NS" --reuse-values --wait --timeout 5m \
      --set "sandbox.modelGatewayAccess=$1" --set server.sessionTokenTtlSeconds=900 2>&1
  }

  mg_url="http://$(svc_ip kaiju-model-gateway)/healthz"
  server_url="http://$(svc_ip kaiju-server):8081/healthz"
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

echo "==> team namespace prefix: detected on upgrade, exactly one in force (KOBE-751)"
deployed_prefix() {
  $KUBECTL -n "$NS" get deploy kaiju-server -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="KAIJU_SANDBOX_CONFIG")].value}' \
    | grep -o '"teamNamespacePrefix":"[^"]*"'
}
# The upgrades above reuse the install's values, where the prefix is empty: the chart looked it up.
contains "the upgraded release keeps the detected prefix kaiju-team-" '^"teamNamespacePrefix":"kaiju-team-"$' "$(deployed_prefix)"
same_uid() { # name, uid before, uid after: both set and equal
  if [[ -n "$2" && "$2" == "$3" ]]; then ok "$1"; else fail "$1: before [$2] after [$3]"; fi
}
same_uid "the team namespace came through the upgrades untouched (same uid)" "$team_ns_uid_before" "$(team_ns_uid)"
same_uid "its ResourceQuota came through the upgrades untouched (same uid)" "$team_quota_uid_before" "$(team_quota_uid)"
# A team namespace under the other prefix: the chart refuses to render (a server-side dry run can
# look it up), and the running server's team reconcile (every 30 s here, dev/values.yaml) visits
# it, skips it and writes nothing into it.
PROBE_NS=kobe-team-e2e-prefix-probe
probe_at=$(date +%s)
$KUBECTL create namespace "$PROBE_NS" >/dev/null 2>&1 || true
$KUBECTL label namespace "$PROBE_NS" kobe.splittingatom.io/team-namespace=true --overwrite >/dev/null
dry=$($HELM upgrade kaiju charts/kaiju -n "$NS" --reuse-values --dry-run=server 2>&1 || true)
contains "an upgrade with team namespaces under both prefixes fails, naming them" 'both prefixes kaiju-team- and kobe-team-' "$dry"
reconciled_since_probe() { # reconcile summaries logged after the probe namespace existed
  local since=$(($(date +%s) - probe_at + 1)) pod
  for pod in $($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name); do
    $KUBECTL -n "$NS" logs "$pod" -c server --since="${since}s" 2>/dev/null || true
  done | grep '"msg":"team namespaces reconciled"' | grep '"skipped":[1-9]' | tail -n 1 || true
}
contains "a team reconcile ran over the other prefix's namespace and skipped it" '"skipped":[1-9]' \
  "$(wait_for 120 '"skipped":[1-9]' reconciled_since_probe)"
leaked=$($KUBECTL -n "$PROBE_NS" get networkpolicy,resourcequota,limitrange,rolebinding,sandboxtemplates.extensions.agents.x-k8s.io -o name 2>/dev/null) ||
  leaked="(the listing failed)"
nothing_leaked() { # listing output: passes only when it lists no object (and did not error)
  if [[ -z "$1" ]]; then ok "$2"; else fail "$2: found [$1]"; fi
}
nothing_leaked "$leaked" "the server wrote nothing into the other prefix's namespace"
# Gone before anything else could restart a server or upgrade the chart next to it.
$KUBECTL delete namespace "$PROBE_NS" --wait=true --timeout=120s >/dev/null 2>&1 || true
