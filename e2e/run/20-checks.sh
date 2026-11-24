# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
echo "==> checks"
psql_kaiju() { $KUBECTL -n kaiju-deps exec deploy/pg -- psql -U postgres -d kobe -tAc "$1" 2>&1; }
# KOBE-415: a run whose event stream ended without a terminal event (the 5-minute stream timeout).
# Says where it stopped: its events and status, and the server's warnings and sandbox-wire lines.
hung_run_report() { # label run-id team-id
  echo "     $1: run ${2:-?} did not end (events, status):"
  psql_kaiju "SELECT * FROM (
      SELECT 'event ' || seq || ' ' || type || ' ' || left(payload::text, 300) FROM run_events
       WHERE team_id = '$3' AND run_id = '${2:-00000000-0000-4000-8000-000000000000}'
         AND type NOT LIKE '%.delta' ORDER BY seq) e
    UNION ALL SELECT 'run ' || status FROM runs
       WHERE team_id = '$3' AND id = '${2:-00000000-0000-4000-8000-000000000000}'" \
    | sed 's/^/       /' || true
  $KUBECTL -n "$NS" logs -l app.kubernetes.io/component=server -c server --since=7m --tail=-1 2>&1 \
    | grep -E '"level":(40|50)|sandbox-wire' | tail -n 30 | cut -c1-600 | sed 's/^/     server: /' || true
}

for d in web server scheduler mcp-proxy egress-proxy model-gateway bifrost; do
  if $KUBECTL -n "$NS" rollout status "deploy/kaiju-$d" --timeout=60s >/dev/null 2>&1; then ok "deployment kaiju-$d is available"
  else fail "deployment kaiju-$d is available"; fi
done
if [[ ${#restrict_egress[@]} -gt 0 ]]; then
  contains "server and web run under their egress policies (KOBE-698)" '^kaiju-server-egress kaiju-web-egress$' \
    "$($KUBECTL -n "$NS" get networkpolicy kaiju-server-egress kaiju-web-egress -o jsonpath='{.items[*].metadata.name}' 2>&1)"
fi
gated_pods='app.kubernetes.io/component in (server,scheduler)'
gate_fmt='{range .items[*]}{range .status.initContainerStatuses[*]}{.name}={.state.terminated.reason}{"\n"}{end}{end}'
gates=$($KUBECTL -n "$NS" get pods -l "$gated_pods" --field-selector=status.phase=Running -o jsonpath="$gate_fmt")
expect "every server/scheduler init gate (isolation, migrations) completed" '^(isolation-preflight|wait-for-migrations)=Completed$' "$gates"
gate_count=$(printf '%s\n' "$gates" | grep -c .)
# 2 server pods x wait-for-migrations + 1 scheduler pod x (isolation-preflight, wait-for-migrations);
# the server checks isolation in process instead (KOBE-9).
contains "init gates ran on all 3 server/scheduler pods" "^4$" "$gate_count"
expect "app-role grants recorded for the newest migration" '^t$' "$(psql_kaiju \
  'select (select migration_when from drizzle.kobe_grants_applied) = (select max(created_at) from drizzle.__drizzle_migrations)')"
expect "team tables have FORCE ROW LEVEL SECURITY" '^team_members\|true$' "$(psql_kaiju \
  "select c.relname || '|' || c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'team_members'")"
wait_endpoints "$NS" kaiju-web
contains "web answers through the Traefik ingress" '"service":"web"' \
  "$(reachable "$NS" kube-system traefik "--header 'Host: kaiju.localtest.me' http://traefik.kube-system/api/healthz")"
contains "the web app serves the chat (KOBE-32)" 'data-kaiju-chat' \
  "$(reachable "$NS" kube-system traefik "--header 'Host: kaiju.localtest.me' http://traefik.kube-system/")"
contains "server answers" '"service":"server"' "$(reachable "$NS" "$NS" kaiju-server http://kaiju-server/healthz)"
# KOBE-9: every server/scheduler process verified isolation itself (not disclosed by /readyz).
# KOBE-125: judge only the CURRENT pods: those owned by the deployment's newest ReplicaSet and not
# terminating (a rollout leaves old-ReplicaSet and terminating pods that never need to verify).
# The server retries its startup check before turning ready, but the log line is still read
# asynchronously: wait (bounded, 90 s per component) for it. The check itself is unchanged: the pod's own
# log must say its in-process RuntimeClass handler check passed.
isolation_verified() { # pod → succeeds once its log records the verification
  # Read the whole log first: `kubectl logs | grep -q` makes grep exit at the first match, kubectl
  # then dies of SIGPIPE and, under pipefail, a verified pod reads as unverified (KOBE-125).
  local log
  log=$($KUBECTL -n "$NS" logs "$1" 2>/dev/null) || return 1
  grep -q '"msg":"isolation verified: agents enabled"' <<<"$log"
}
current_pods() { # component → names of the live pods of the deployment's current ReplicaSet
  local rs
  rs=$($KUBECTL -n "$NS" get rs -l "app.kubernetes.io/component=$1" \
    -o jsonpath='{range .items[*]}{.metadata.annotations.deployment\.kubernetes\.io/revision}{" "}{.metadata.name}{"\n"}{end}' |
    sort -n | tail -n 1 | cut -d' ' -f2)
  [ -n "$rs" ] || return 0
  $KUBECTL -n "$NS" get pods -l "app.kubernetes.io/component=$1" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.ownerReferences[0].name}{" "}{.metadata.deletionTimestamp}{"\n"}{end}' |
    awk -v rs="$rs" 'NF == 2 && $2 == rs { print $1 }'
}
iso=""
for component in server scheduler; do
  current=""
  deadline=$((SECONDS + 90))
  until current=$(current_pods "$component") && [ -n "$current" ] || ((SECONDS >= deadline)); do sleep 2; done
  [ -n "$current" ] || iso+="$component:no-current-pods "
  for pod in $current; do
    until isolation_verified "$pod" || ((SECONDS >= deadline)); do sleep 2; done
    if isolation_verified "$pod"; then iso+="verified "; else
      iso+="$pod:unverified "
      echo "     $pod isolation log tail: $($KUBECTL -n "$NS" logs "$pod" 2>&1 | grep -i isolation | tail -n 3)"
    fi
  done
done
contains "server and scheduler verified the gVisor RuntimeClass in process" '^verified verified verified $' "$iso"
# KOBE-40: Bifrost admits only the server (config sync) and the model-gateway shim.
# The sync's own record says whether it reached Bifrost (a pass lists and writes through its admin API).
gateway_state() { psql_kaiju "SELECT 'in_sync=' || (synced_version >= desired_version) || ' error=' || coalesce(last_error, '-') FROM model_gateway_state"; }
wait_endpoints "$NS" kaiju-bifrost
bifrost=$(wait_for 180 '^in_sync=true error=-$' gateway_state)
contains "the server's gateway sync reached Bifrost (in sync, no error)" '^in_sync=true error=-$' "$bifrost"
bifrost_restarts=$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=bifrost \
  -o jsonpath='{.items[*].status.containerStatuses[*].restartCount}' 2>/dev/null)
if [[ "$bifrost_restarts" != 0 ]]; then # KOBE-242: say why it restarted (OOM, failed probe) before the check fails
  $KUBECTL -n "$NS" describe pod -l app.kubernetes.io/component=bifrost 2>&1 | grep -E "Last State|Reason|Exit Code|Liveness|Unhealthy" | sed 's/^/     bifrost: /' || true
  bifrost_prev=$($KUBECTL -n "$NS" logs -l app.kubernetes.io/component=bifrost --previous --tail=30 2>&1 || true)
  printf '%s\n' "$bifrost_prev" | sed 's/^/     bifrost prev: /'
  # KOBE-480: on a fresh store Bifrost downloads its pricing datasheet at start and exits (fatal)
  # when the upstream answers 5xx through its 4 attempts; kubelet's restart then succeeds. That
  # is an outage outside the cluster, not an OOM or probe restart. An outage that outlasts the
  # first restart's backoff costs more exits of the same kind, one per kubelet backoff step
  # (2026-10-31, PR #431's queue run: two exits; 2026-11-01, PRs #438 and #440: five and six, all
  # the pricing download, HTTP 5xx), so any number is allowed when the last exit was that failure
  # and no container was ever OOM-killed; anything else fails. The same outage is worded three ways
  # (2026-11-08, PR #469's queue run: "failed to download model parameters data: HTTP 503" in one
  # shard and "failed to unmarshal pricing data: unexpected end of JSON input", a truncated body, in
  # another), so the match is the pricing manager failing to load either datasheet from its URL.
  pricing_exit='"level":"fatal".*failed to initialize pricing manager: failed to sync (pricing|model parameters) data: failed to load .* from URL'
  bifrost_oom=$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=bifrost \
    -o jsonpath='{.items[*].status.containerStatuses[*].lastState.terminated.reason}' 2>/dev/null)
  if [[ "$bifrost_restarts" =~ ^[1-9][0-9]*$ && "$bifrost_oom" != *OOMKilled* ]] &&
    printf '%s\n' "$bifrost_prev" | grep -qE "$pricing_exit"; then
    echo "     bifrost: $bifrost_restarts restart(s) after the upstream pricing download failed (external outage, KOBE-480)"
    bifrost_restarts=0
  fi
fi
contains "Bifrost has not restarted (other than for an upstream pricing outage)" '^0$' "$bifrost_restarts"
# Once the control answers, the probe pod is in the policy ipsets: BLOCKED below is the policy.
np=$(probe default "$(gated http://kaiju-web.$NS/api/healthz bifrost http://kaiju-bifrost.$NS:8080/health)")
contains "probe from another namespace can reach unrestricted services (control)" '^control=REACHED$' "$np"
contains "Bifrost is not reachable from other namespaces" '^bifrost=BLOCKED$' "$np"
np=$(probe "$NS" "$(gated http://kaiju-web/api/healthz bifrost http://kaiju-bifrost:8080/health)")
contains "control: a release-namespace probe reaches the web app" '^control=REACHED$' "$np"
contains "Bifrost refuses other pods of the release namespace (only server and shim)" '^bifrost=BLOCKED$' "$np"
# First-run setup through the ingress (KOBE-12): needs the site's setup token.
setup_token=$($KUBECTL -n "$NS" get secret kaiju-auth -o jsonpath='{.data.setup-token}' | base64 -d)
ingress() { # method path [json]: full response (status line + body) via the Traefik ingress
  local data=""
  if [[ -n "${3:-}" ]]; then data="--post-data '$3'"; fi
  wait_endpoints kube-system traefik
  probe "$NS" "$(retry 'nc -w 3 traefik.kube-system 80 </dev/null'); \
    wget -qO- -S --header 'Host: kaiju.localtest.me' --header 'Origin: http://kaiju.localtest.me' \
    --header 'Content-Type: application/json' $data http://traefik.kube-system$2 2>&1"
}
contains "first-run setup is required on a fresh install" '"required":true' "$(ingress GET /v1/setup)"
# KOBE-257: the install console became the Site console; old links redirect permanently.
old_console=$(ingress GET /admin/install/users)
contains "old /admin/install URLs redirect permanently (308)" 'HTTP/1.1 308' "$old_console"
contains "and land on the same page under /admin/site" '[Ll]ocation: (https?://[^/]+)?/admin/site/users' "$old_console"
contains "setup without the setup token is refused" 'HTTP/1.1 403|invalid_setup_token' \
  "$(ingress POST /v1/setup '{"email":"owner@e2e.test","name":"Owner","password":"e2e owner password"}')"
# Built outside "$(...)": bash 3.2 keeps backslashes from \" inside quoted command substitutions.
owner_with_token=$(printf '{"email":"owner@e2e.test","name":"Owner","password":"e2e owner password","setupToken":"%s"}' "$setup_token")
contains "setup with the setup token creates the Owner" 'HTTP/1.1 201' \
  "$(ingress POST /v1/setup "$owner_with_token")"
contains "setup is disabled once the Owner exists" '"required":false' "$(ingress GET /v1/setup)"
# KOBE-13: password reset mails a link through the configured SMTP relay (Mailpit in e2e); unknown
# addresses get the same answer and no email.
contains "password reset answers 200" 'HTTP/1.1 200' \
  "$(ingress POST /api/auth/request-password-reset '{"email":"owner@e2e.test"}')"
contains "password reset for an unknown address answers the same" 'HTTP/1.1 200' \
  "$(ingress POST /api/auth/request-password-reset '{"email":"nobody@e2e.test"}')"
mailbox=http://mailpit.kaiju-deps:8025/api/v1/messages
wait_endpoints kaiju-deps mailpit
mail=$(probe "$NS" "$(retry "$(answers $mailbox) | grep -q 'Reset your Kaiju password'"); $(answers $mailbox)")
contains "the server delivered the reset email over SMTP" 'Reset your Kaiju password' "$mail"
contains "the reset email went to the account's address" 'owner@e2e.test' "$mail"
if printf '%s' "$mail" | grep -q 'nobody@e2e.test'; then fail "no email for an unknown address"; else ok "no email for an unknown address"; fi
contains "chart refuses a RuntimeClass that does not isolate" 'refuses to run agents' \
  "$($HELM upgrade kaiju charts/kaiju -n "$NS" --reuse-values --set isolation.runtimeClassName=does-not-exist 2>&1 || true)"

start_sandbox() {
  $KUBECTL create namespace "$SANDBOX_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null &&
  $KUBECTL apply -f - <<EOF
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata: { name: e2e, namespace: $SANDBOX_NS }
spec:
  podTemplate:
    spec:
      runtimeClassName: gvisor
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: sandbox
          image: $KAIJU_SANDBOX_IMAGE
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "dmesg | head -1; id -u; pi --version; sleep 600"]
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
          volumeMounts: [{ name: tmp, mountPath: /tmp }, { name: home, mountPath: /home/kobe }]
      volumes: [{ name: tmp, emptyDir: {} }, { name: home, emptyDir: {} }]
EOF
}

if [[ -n "${KAIJU_SANDBOX_IMAGE:-}" ]]; then
  # A real agent-sandbox Sandbox (controller + CRD), not a hand-built pod.
  if ! setup=$(start_sandbox 2>&1); then fail "create agent-sandbox Sandbox: $setup"; fi
  $KUBECTL -n "$SANDBOX_NS" wait --for=condition=Ready sandbox/e2e --timeout=240s >/dev/null 2>&1 || true
  sandbox_logs() { $KUBECTL -n "$SANDBOX_NS" logs e2e 2>&1; }
  # `pi --version` boots Pi (seconds under gVisor): wait for its line, not a fixed delay.
  out=$(wait_for 90 '^1\.4\.' sandbox_logs)
  contains "agent-sandbox Sandbox becomes Ready" '^True$' \
    "$($KUBECTL -n "$SANDBOX_NS" get sandbox e2e -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')"
  contains "sandbox boots under gVisor" 'Starting gVisor' "$out"
  contains "sandbox runs as uid 1000" '^1000$' "$out"
  contains "sandbox has Pi 1.4.x" '^1\.4\.' "$out"
elif [[ "${CI:-}" == "true" ]]; then
  fail "KAIJU_SANDBOX_IMAGE is not set (required in CI)"
else
  echo "SKIP sandbox checks (KAIJU_SANDBOX_IMAGE not set)"
fi


E2E_TEAM_ID=6f1d1a2b-0c3d-4e5f-8a9b-0c1d2e3f4a5b
E2E_USER_ID=7a2e2b3c-1d4e-4f6a-9b0c-1d2e3f4a5b6c

