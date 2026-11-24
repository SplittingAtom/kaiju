# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.

# KOBE-22: the server's sandbox provider creates a team namespace (default-deny NetworkPolicy,
# quota, warm pool) and a (user, team) sandbox under gVisor; admission policies pin isolation.
echo "==> sandbox provider (KOBE-22)"
ensure_sandbox() { # [team-id slug user-id]: defaults to the e2e team and sandbox user
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/sandbox.js ensure \
    --team-id "${1:-$E2E_TEAM_ID}" --team-slug "${2:-e2e}" --user-id "${3:-$E2E_USER_ID}" 2>&1
}
json_field() { # field, single-line JSON object with string values → value (no node/jq on runners)
  printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1
}
ensure_out=$(ensure_sandbox || true)
handle=$(printf '%s\n' "$ensure_out" | tail -1)
sandbox_id=$(json_field sandboxId "$handle")
sandbox_pod=$(json_field podName "$handle")
contains "server creates a (user, team) sandbox through the isolation gate" '^[0-9a-f-]{36}$' "${sandbox_id:-$ensure_out}"
contains "ensuring it again returns the same sandbox" "^${sandbox_id:-none}$" \
  "$(json_field sandboxId "$( (ensure_sandbox || true) | tail -1)")"
contains "team namespace carries its team id" "^${E2E_TEAM_ID}$" \
  "$($KUBECTL get namespace "$TEAM_NS" -o jsonpath='{.metadata.labels.kobe\.splittingatom\.io/team-id}')"
contains "team namespace enforces Pod Security 'baseline' (KOBE-71; the rest of 'restricted' by admission)" '^baseline$' \
  "$($KUBECTL get namespace "$TEAM_NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')"
# KOBE-126: the server's team-namespace reconcile (KOBE-115) must converge the namespace just created
# with failed=0 (no 403 from missing RBAC). dev/values.yaml runs it every 30 s; read the newest summary
# line of any server pod (whichever replica holds the lock logs it), waiting for one that saw the team.
reconcile_summary() {
  local pod
  for pod in $($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name); do
    $KUBECTL -n "$NS" logs "$pod" -c server 2>/dev/null || true
  done | grep '"msg":"team namespaces reconciled"' | grep -v '"converged":0,' | tail -n 1 || true
}
reconcile_line=$(wait_for 120 '"converged":[1-9]' reconcile_summary)
contains "team-namespace reconcile converges the team namespace (KOBE-126)" '"converged":[1-9]' "$reconcile_line"
contains "team-namespace reconcile reports failed=0 (KOBE-126)" '"failed":0,' "$reconcile_line"
np_spec() { $KUBECTL -n "$TEAM_NS" get networkpolicy kobe-sandbox-isolation -o jsonpath="$1"; }
# Every pod but Orbit eval pods (KOBE-93) and external skill scan pods (KOBE-341), each of which has
# its own, narrower policy below: an excluded label is only safe while its policy is in place.
contains "team NetworkPolicy selects every pod but Orbit eval and skill scan pods (KOBE-93, KOBE-341)" \
  '^\{"matchExpressions":\[\{"key":"kobe\.splittingatom\.io/orbit-eval","operator":"DoesNotExist"\},\{"key":"kobe\.splittingatom\.io/skill-scan","operator":"DoesNotExist"\}\]\}$' "$(np_spec '{.spec.podSelector}')"
# Egress is governed and its rule list empty (an empty array or none): scan pods reach nothing.
contains "skill scan NetworkPolicy selects only skill scan pods and allows no ingress and no egress (KOBE-341)" \
  '^\{"matchExpressions":\[\{"key":"kobe\.splittingatom\.io/skill-scan","operator":"Exists"\}\]\} \["Ingress","Egress"\] (\[\])? (\[\])?$' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy kobe-skill-scan -o jsonpath='{.spec.podSelector} {.spec.policyTypes} {.spec.ingress} {.spec.egress}')"
contains "eval NetworkPolicy selects only Orbit eval pods and allows no ingress (KOBE-93)" \
  '^\{"matchExpressions":\[\{"key":"kobe\.splittingatom\.io/orbit-eval","operator":"Exists"\}\]\} (\[\])?$' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy kobe-orbit-eval-isolation -o jsonpath='{.spec.podSelector} {.spec.ingress}')"
contains "eval NetworkPolicy allows egress to the model gateway only" '^model-gateway$' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy kobe-orbit-eval-isolation -o jsonpath='{.spec.egress[*].to[*].podSelector.matchLabels.app\.kubernetes\.io/component}')"
contains "team NetworkPolicy governs ingress and egress" '^\["Ingress","Egress"\]$' "$(np_spec '{.spec.policyTypes}')"
contains "team NetworkPolicy allows no ingress at all" '^(\[\])?$' "$(np_spec '{.spec.ingress}')"
contains "team namespace has only Kaiju's three NetworkPolicies (controller policy unmanaged)" '^kobe-orbit-eval-isolation kobe-sandbox-isolation kobe-skill-scan $' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy -o name | sed 's|.*/||' | sort | tr '\n' ' ')"
# The team quota is the members' share plus the eval share (KOBE-325); members are held to theirs.
contains "team ResourceQuota is in place (members' 20 CPU plus the eval share)" '^20[0-9]{3}m$' \
  "$($KUBECTL -n "$TEAM_NS" get resourcequota kobe-team-quota -o jsonpath='{.spec.hard.requests\.cpu}')"
contains "member ResourceQuota holds members to the team's 20 CPU" '^20$' \
  "$($KUBECTL -n "$TEAM_NS" get resourcequota kobe-team-member-quota -o jsonpath='{.spec.hard.requests\.cpu}')"
contains "eval ResourceQuota is in place" '^[0-9]+m?$' \
  "$($KUBECTL -n "$TEAM_NS" get resourcequota kobe-skill-eval-quota -o jsonpath='{.spec.hard.requests\.cpu}')"
contains "team warm pool exists" '^1$' \
  "$($KUBECTL -n "$TEAM_NS" get sandboxwarmpool kobe-sandbox -o jsonpath='{.spec.replicas}')"
contains "sandbox pod is set to the gVisor RuntimeClass" '^gvisor$' \
  "$($KUBECTL -n "$TEAM_NS" get pod "${sandbox_pod:-none}" -o jsonpath='{.spec.runtimeClassName}' 2>&1)"
expect "every pod in the team namespace (sandbox + warm pool) uses gVisor" '^gvisor$' \
  "$($KUBECTL -n "$TEAM_NS" get pods -o jsonpath='{range .items[*]}{.spec.runtimeClassName}{"\n"}{end}')"
node=$($KUBECTL -n "$TEAM_NS" get pod "${sandbox_pod:-none}" -o jsonpath='{.spec.nodeName}' 2>/dev/null || true)
if [[ -n "$node" ]] && docker inspect "$node" >/dev/null 2>&1; then
  handler=""
  for _ in $(seq 1 30); do
    handler=$(docker exec "$node" crictl pods --name "$sandbox_pod" --namespace "$TEAM_NS" -o json 2>/dev/null \
      | sed -n 's/.*"runtimeHandler": *"\([^"]*\)".*/\1/p' | head -1 || true)
    [[ -n "$handler" ]] && break
    sleep 2
  done
  contains "the node runs the sandbox pod with the runsc (gVisor) handler" '^runsc$' "$handler"
else
  echo "SKIP node runtime handler check (k3d node container not reachable from here)"
fi

admission() { # pod spec overrides (JSON) → kubectl's answer for a pod in the team namespace
  $KUBECTL -n "$TEAM_NS" run "adm-$RANDOM" --restart=Never --image=busybox:1.37 --dry-run=server \
    --overrides="$1" -o name 2>&1 || true
}
SEC_POD='"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}}'
SEC_CTR='"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}'
contains "admission refuses a team pod without the gVisor RuntimeClass" 'must use RuntimeClass' \
  "$(admission "{\"spec\":{\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
# A RuntimeClass that exists but does not isolate (cluster-scoped; removed on exit).
printf 'apiVersion: node.k8s.io/v1\nkind: RuntimeClass\nmetadata: {name: kaiju-e2e-runc}\nhandler: runc\n' \
  | $KUBECTL apply -f - >/dev/null 2>&1 || true
contains "admission refuses a team pod under a non-isolating RuntimeClass" 'must use RuntimeClass' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"kaiju-e2e-runc\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
contains "admission refuses a team pod mounting a Secret" 'must not mount Secrets' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}],\"volumes\":[{\"name\":\"s\",\"secret\":{\"secretName\":\"x\"}}]}}")"
contains "admission refuses a team pod with a Kubernetes API token" 'must not mount a Kubernetes API token' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
# KOBE-71: the namespace is Pod Security "baseline" so sandboxes can add SETUID/SETGID for their
# Pi identities; Kaiju's own policy keeps the rest of "restricted".
contains "admission refuses a team container adding any other capability (KOBE-71)" "only the sandbox container 'agent'" \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",\"securityContext\":{\"capabilities\":{\"drop\":[\"ALL\"],\"add\":[\"SETUID\",\"CHOWN\"]}}}]}}")"
contains "admission refuses a team pod running as root (KOBE-71)" 'must run as non-root' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"securityContext\":{\"runAsUser\":0,\"seccompProfile\":{\"type\":\"RuntimeDefault\"}},\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
contains "admission refuses SETUID on any container but the sandbox's own (KOBE-71)" "only the sandbox container 'agent'" \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",\"securityContext\":{\"allowPrivilegeEscalation\":false,\"capabilities\":{\"drop\":[\"ALL\"],\"add\":[\"SETUID\"]}}}]}}")"
contains "admission refuses privilege escalation on any container but the sandbox's own (KOBE-71)" "only the sandbox container 'agent'" \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",\"securityContext\":{\"allowPrivilegeEscalation\":true,\"capabilities\":{\"drop\":[\"ALL\"]}}}]}}")"
server_sa="system:serviceaccount:$NS:kobe-server"
contains "the server's ServiceAccount cannot create namespaces outside kobe-team-*" 'only manage kobe-team-\* namespaces' \
  "$($KUBECTL create namespace kaiju-e2e-evil --as="$server_sa" --dry-run=server 2>&1 || true)"
contains "the server's ServiceAccount cannot read Secrets in team namespaces" 'forbidden' \
  "$($KUBECTL -n "$TEAM_NS" get secrets --as="$server_sa" 2>&1 || true)"
contains "the server's ServiceAccount cannot create pods in team namespaces" 'forbidden' \
  "$($KUBECTL -n "$TEAM_NS" run x --image=busybox:1.37 --as="$server_sa" --dry-run=server 2>&1 || true)"
contains "nobody else may add NetworkPolicies to a team namespace" 'only the Kaiju server manages NetworkPolicies' \
  "$(printf 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: allow-all, namespace: %s}\nspec: {podSelector: {}, egress: [{}], policyTypes: [Egress]}\n' "$TEAM_NS" \
    | $KUBECTL apply --dry-run=server -f - 2>&1 || true)"

TEAM_PROBES=()
team_pod() { # namespace, name, shell command → a sandbox-like pod (gVisor, bootstrap token)
  TEAM_PROBES+=("$2")
  PODS+=("-n $1 $2")
  $KUBECTL -n "$1" run "$2" --restart=Never --image=busybox:1.37 --overrides="{\"spec\":{
    \"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"serviceAccountName\":\"kobe-sandbox\",$SEC_POD,
    \"containers\":[{\"name\":\"$2\",\"image\":\"busybox:1.37\",\"command\":[\"sh\",\"-c\",\"$3\"],$SEC_CTR,
      \"resources\":{\"requests\":{\"cpu\":\"50m\",\"memory\":\"32Mi\"},\"limits\":{\"cpu\":\"200m\",\"memory\":\"64Mi\"}},
      \"volumeMounts\":[{\"name\":\"kobe-bootstrap\",\"mountPath\":\"/var/run/secrets/kobe\"}]}],
    \"volumes\":[{\"name\":\"kobe-bootstrap\",\"projected\":{\"sources\":[{\"serviceAccountToken\":{
      \"audience\":\"kobe.sandbox-bootstrap\",\"expirationSeconds\":3600,\"path\":\"bootstrap-token\"}}]}}]}}" >/dev/null
}
team_probe() { # shell command → its output, run from a sandbox-like pod in the team namespace
  local name="tprobe-$BASHPID-$RANDOM$RANDOM" phase="" i
  team_pod "$TEAM_NS" "$name" "$1" || { echo "team probe could not start"; return; }
  for i in $(seq 1 180); do
    phase=$($KUBECTL -n "$TEAM_NS" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
    sleep 2
  done
  $KUBECTL -n "$TEAM_NS" logs "$name" 2>/dev/null || true
}
listener='mkdir -p /tmp/w && echo REACHED > /tmp/w/index.html && httpd -f -p 8080 -h /tmp/w'
start_listener() { # namespace → name of a running HTTP listener on 8080 there
  local name="listener-$RANDOM"
  team_pod "$1" "$name" "$listener"
  $KUBECTL -n "$1" wait --for=condition=Ready "pod/$name" --timeout=120s >/dev/null 2>&1 || true
  echo "$name"
}

# A second team (its own namespace) with a listener: sandboxes of one team must not reach it.
handle2=$( (ensure_sandbox 8e3f3c4d-2e5f-4a7b-8c1d-2e3f4a5b6c7d e2e2 || true) | tail -1)
contains "a second team gets its own sandbox namespace" '^kobe-team-e2e2$' "$(json_field namespace "$handle2")"
other_listener=$(start_listener "$TEAM2_NS")
other_ip=$($KUBECTL -n "$TEAM2_NS" get pod "$other_listener" -o jsonpath='{.status.podIP}' 2>/dev/null || true)

svc_ip() { $KUBECTL -n "$NS" get svc "$1" -o jsonpath='{.spec.clusterIP}'; }
server_ip=$(svc_ip kobe-server || true); web_ip=$(svc_ip kobe-web || true); bifrost_ip=$(svc_ip kobe-bifrost || true)
mg_ip=$(svc_ip kobe-model-gateway || true)
dns_ip=$($KUBECTL -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}' || true)
api_ip=$($KUBECTL -n default get svc kubernetes -o jsonpath='{.spec.clusterIP}' || true)
node_ip=$($KUBECTL get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' || true)
tcp() { # label host port → "label=REACHED|BLOCKED" (TCP connect only)
  echo "nc -w 4 $2 $3 </dev/null >/dev/null 2>&1 && echo $1=REACHED || echo $1=BLOCKED;"
}
targets="$(tcp api "$api_ip" 443) $(tcp apiserver "$node_ip" 6443) $(tcp kubelet "$node_ip" 10250)"
# Diagnostics: an unlabelled listener in the release namespace on 8080 and 9090 (not asserted;
# shows how the CNI applies the team egress policy's selectors).
PODS+=("-n $NS diag-listener")
$KUBECTL -n "$NS" run diag-listener --restart=Never --image=busybox:1.37 --command -- sh -c \
  'mkdir -p /tmp/w && echo ok > /tmp/w/index.html && (httpd -p 9090 -h /tmp/w &) && httpd -f -p 8080 -h /tmp/w' >/dev/null
$KUBECTL -n "$NS" wait --for=condition=Ready pod/diag-listener --timeout=120s >/dev/null 2>&1 || true
diag_ip=$($KUBECTL -n "$NS" get pod diag-listener -o jsonpath='{.status.podIP}' 2>/dev/null || true)
web_pod_ip=$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=web -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || true)
# Controls first: the destinations the sandbox must not reach are up and reachable from the
# release namespace, so BLOCKED below is the sandbox policy, not a dead target.
wait_endpoints "$NS" kobe-server kobe-web kobe-bifrost kobe-model-gateway
controls=$(probe "$NS" "$(retry "$(answers http://$server_ip/healthz)"); \
  $(retry "nc -w 3 $api_ip 443 </dev/null"); $(retry "nc -w 3 $node_ip 10250 </dev/null"); \
  $(tcp api "$api_ip" 443) $(tcp kubelet "$node_ip" 10250) \
  wget -qO- -T 5 http://$server_ip/healthz >/dev/null 2>&1 && echo user-api=REACHED || echo user-api=BLOCKED")
contains "control: the API Service is reachable from the release namespace" '^api=REACHED$' "$controls"
contains "control: the kubelet is reachable from the release namespace" '^kubelet=REACHED$' "$controls"
contains "control: the user API is reachable from the release namespace" '^user-api=REACHED$' "$controls"
# A new pod joins the CNI's policy ipsets after a delay: the sandbox probes run only once the
# sandbox port (the positive control from the same pod) answers, so BLOCKED is the policy. Allow
# 180 s, the budget of the loop this replaced; admitted-after records how long it took.
# Team-probe prefix: the sandbox port is the positive control from the same pod. On timeout it
# prints sandbox-port=BLOCKED and <label>=UNTESTED and ends the probe, so every check after fails.
sandbox_port_gate() { # label
  echo "t0=\$(date +%s); if ! $(retry "$(answers http://$server_ip:8081/healthz)" 180); then \
echo sandbox-port=BLOCKED; echo $1=UNTESTED; exit 0; fi; echo admitted-after=\$((\$(date +%s) - t0))s;"
}
egress=$(team_probe "$(sandbox_port_gate egress) \
  wget -qO- -T 5 http://${diag_ip:-0.0.0.0}:8080/ >/dev/null 2>&1 && echo diag-8080=REACHED || echo diag-8080=BLOCKED; \
  wget -qO- -T 5 http://${diag_ip:-0.0.0.0}:9090/ >/dev/null 2>&1 && echo diag-9090=REACHED || echo diag-9090=BLOCKED; \
  wget -qO- -T 5 http://${web_pod_ip:-0.0.0.0}:8080/api/healthz >/dev/null 2>&1 && echo web-pod=REACHED || echo web-pod=BLOCKED; \
  wget -qO- -T 5 http://$server_ip:8081/healthz >/dev/null 2>&1 && echo sandbox-port=REACHED || echo sandbox-port=BLOCKED; \
  wget -qO- -T 5 http://$server_ip/healthz >/dev/null 2>&1 && echo user-api=REACHED || echo user-api=BLOCKED; \
  wget -qO- -T 5 http://$bifrost_ip:8080/health >/dev/null 2>&1 && echo bifrost=REACHED || echo bifrost=BLOCKED; \
  wget -qO- -T 5 http://${mg_ip:-0.0.0.0}/healthz >/dev/null 2>&1 && echo model-gateway=REACHED || echo model-gateway=BLOCKED; \
  wget -qO- -T 5 http://$web_ip/api/healthz >/dev/null 2>&1 && echo web=REACHED || echo web=BLOCKED; \
  wget -qO- -T 5 http://${other_ip:-0.0.0.0}:8080/ >/dev/null 2>&1 && echo other-team=REACHED || echo other-team=BLOCKED; \
  wget -qO- -T 5 http://169.254.169.254/ >/dev/null 2>&1 && echo metadata=REACHED || echo metadata=BLOCKED; \
  $targets \
  nslookup kubernetes.default.svc.cluster.local $dns_ip >/dev/null 2>&1 && echo dns=REACHED || echo dns=BLOCKED; \
  wget -qO- -T 5 http://1.1.1.1/ >/dev/null 2>&1 && echo internet=REACHED || echo internet=BLOCKED; \
  wget -qO- -T 5 -S --post-data= --header \\\"Authorization: Bearer \$(cat /var/run/secrets/kobe/bootstrap-token)\\\" \
    http://$server_ip:8081/v1/sandbox/session 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | sed 's/^/bootstrap=/'; \
  wget -qO- -T 5 -S --post-data= --header 'Authorization: Bearer forged.token.value-xxxxxxxxxx' \
    http://$server_ip:8081/v1/sandbox/session 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | sed 's/^/forged=/'")
printf '     egress from a sandbox: %s\n' "$(printf '%s' "$egress" | tr '\n' ' ')"
contains "sandboxes reach the server's sandbox port" '^sandbox-port=REACHED$' "$egress"
contains "sandboxes cannot reach the web pod directly" '^web-pod=BLOCKED$' "$egress"
contains "sandboxes cannot reach the server's user API port" '^user-api=BLOCKED$' "$egress"
contains "sandboxes reach the model-gateway shim (KOBE-40)" '^model-gateway=REACHED$' "$egress"
contains "sandboxes cannot reach Bifrost directly (only through the token-verifying shim)" '^bifrost=BLOCKED$' "$egress"
contains "sandboxes cannot reach other Kaiju services (web)" '^web=BLOCKED$' "$egress"
contains "sandboxes cannot reach another team's pods" '^other-team=BLOCKED$' "$egress"
contains "sandboxes cannot reach the Kubernetes API Service" '^api=BLOCKED$' "$egress"
contains "sandboxes cannot reach the API server on the node" '^apiserver=BLOCKED$' "$egress"
contains "sandboxes cannot reach the kubelet" '^kubelet=BLOCKED$' "$egress"
contains "sandboxes cannot reach a cloud metadata endpoint" '^metadata=BLOCKED$' "$egress"
contains "sandboxes get no DNS (no exfiltration channel)" '^dns=BLOCKED$' "$egress"
contains "sandboxes cannot reach the internet directly" '^internet=BLOCKED$' "$egress"
contains "an unclaimed sandbox pod's bootstrap token is recognised but not assigned (409)" '^bootstrap=HTTP/1.1 409$' "$egress"
contains "a forged bootstrap token is refused (401)" '^forged=HTTP/1.1 401$' "$egress"
contains "the sandbox session endpoint is not exposed through the ingress" 'HTTP/1.1 (401|404)' \
  "$(ingress POST /v1/sandbox/session '{}')"

# Inbound: a listener in the team namespace is unreachable; the same listener elsewhere is reachable.
team_listener=$(start_listener "$TEAM_NS")
$KUBECTL create namespace "$SANDBOX_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
PODS+=("-n $SANDBOX_NS control-listener")
$KUBECTL -n "$SANDBOX_NS" run control-listener --restart=Never --image=busybox:1.37 --command -- sh -c "$listener" >/dev/null
$KUBECTL -n "$SANDBOX_NS" wait --for=condition=Ready pod/control-listener --timeout=120s >/dev/null 2>&1 || true
team_ip=$($KUBECTL -n "$TEAM_NS" get pod "$team_listener" -o jsonpath='{.status.podIP}' 2>/dev/null || true)
control_ip=$($KUBECTL -n "$SANDBOX_NS" get pod control-listener -o jsonpath='{.status.podIP}' 2>/dev/null || true)
inbound=$(probe "$NS" "$(gated "http://${control_ip:-0.0.0.0}:8080/" sandbox "http://${team_ip:-0.0.0.0}:8080/")")
contains "the team listener is up (so BLOCKED below means the policy)" '^Running$' \
  "$($KUBECTL -n "$TEAM_NS" get pod "$team_listener" -o jsonpath='{.status.phase}')"
contains "a listener outside team namespaces is reachable (control)" '^control=REACHED$' "$inbound"
contains "nothing can connect into a sandbox (no inbound)" '^sandbox=BLOCKED$' "$inbound"

