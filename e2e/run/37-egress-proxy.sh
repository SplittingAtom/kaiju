# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-38: sandboxes reach the internet only through the egress proxy (HTTPS CONNECT, SNI match),
# only to domains their team enabled within the site ceiling; never internal addresses.
echo "==> egress proxy (KOBE-38)"
UPSTREAM_HOST="upstream.$UPSTREAM_NS.svc.cluster.local"
INTERNAL_HOST="kaiju-server.$NS.svc.cluster.local"
if [[ -n "${KAIJU_SANDBOX_IMAGE:-}" && -n "${sandbox_pod:-}" ]]; then
  # The "internet": a TLS server (self-signed, s_server -www) behind a Service on 443. It has a
  # private ClusterIP, so the proxy may reach it only because this test allows exactly that IP.
  $KUBECTL create namespace "$UPSTREAM_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  $KUBECTL -n "$UPSTREAM_NS" run upstream --restart=Never --image="$KAIJU_SANDBOX_IMAGE" --labels=app=upstream \
    --command -- sh -c 'cd /tmp && openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 1 \
      -subj /CN=upstream >/dev/null 2>&1 && exec openssl s_server -quiet -accept 8443 -cert c.pem -key k.pem -www' >/dev/null
  $KUBECTL -n "$UPSTREAM_NS" expose pod upstream --port=443 --target-port=8443 --name=upstream >/dev/null
  $KUBECTL -n "$UPSTREAM_NS" wait --for=condition=Ready pod/upstream --timeout=180s >/dev/null 2>&1 || true
  wait_endpoints "$UPSTREAM_NS" upstream
  up_ip=$($KUBECTL -n "$UPSTREAM_NS" get svc upstream -o jsonpath='{.spec.clusterIP}')
  # Allow exactly that Service IP as an internal target (proxy check) and its pods (proxy policy);
  # flush the connection audit every 5 s instead of 60.
  up_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}]},%s]' "$UPSTREAM_NS" "$OTEL_RULE")
  if out=$($HELM upgrade kaiju charts/kaiju -n "$NS" --reuse-values --wait --timeout 5m \
      --set-json "egressProxy.allowedInternalCidrs=[\"$up_ip/32\"]" --set-json "egressProxy.networkPolicy.extraEgress=$up_rule" \
      --set egressProxy.auditFlushSeconds=5 2>&1); then ok "egress proxy reconfigured with the test upstream"
  else fail "egress proxy reconfigured with the test upstream: $out"; fi
  # The sandbox's team and user (the proxy checks active membership, D7); the KOBE-24 section
  # above created them too.
  psql_kaiju "INSERT INTO users (id, name, email) VALUES ('$E2E_USER_ID', 'E2E', 'e2e-sandbox@e2e.test') ON CONFLICT DO NOTHING;
    INSERT INTO teams (id, slug, name) VALUES ('$E2E_TEAM_ID', 'e2e', 'E2E') ON CONFLICT DO NOTHING;
    INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$E2E_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
  # Client: a sandbox-like pod in the team namespace (same NetworkPolicy, gVisor, the sandbox image
  # for curl/openssl, the proxy at egress-proxy.kaiju.internal like real sandboxes) with an
  # egress-audience session token for this (user, team) sandbox minted with the real key. It does
  # not depend on the sandbox agent process (the agent's own bootstrap trade is KOBE-25's e2e).
  proxy_ip=$(svc_ip kaiju-egress-proxy || true)
  EGRESS_CLIENT="egress-client-$RANDOM"
  PODS+=("-n $TEAM_NS $EGRESS_CLIENT")
  $KUBECTL -n "$TEAM_NS" run "$EGRESS_CLIENT" --restart=Never --image="$KAIJU_SANDBOX_IMAGE" --overrides="{\"spec\":{
    \"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"serviceAccountName\":\"kaiju-sandbox\",$SEC_POD,
    \"dnsPolicy\":\"None\",\"dnsConfig\":{\"nameservers\":[\"127.0.0.1\"]},
    \"hostAliases\":[{\"ip\":\"${proxy_ip:-0.0.0.0}\",\"hostnames\":[\"egress-proxy.kaiju.internal\"]}],
    \"containers\":[{\"name\":\"client\",\"image\":\"$KAIJU_SANDBOX_IMAGE\",\"command\":[\"sleep\",\"3600\"],$SEC_CTR,
      \"resources\":{\"requests\":{\"cpu\":\"50m\",\"memory\":\"64Mi\"},\"limits\":{\"cpu\":\"500m\",\"memory\":\"256Mi\"}},
      \"volumeMounts\":[{\"name\":\"tmp\",\"mountPath\":\"/tmp\"}]}],
    \"volumes\":[{\"name\":\"tmp\",\"emptyDir\":{}}]}}" >/dev/null 2>&1 || true
  # Exec only into a running, ready container; on timeout show why (status, last state, logs).
  if $KUBECTL -n "$TEAM_NS" wait --for=condition=Ready "pod/$EGRESS_CLIENT" --timeout=240s >/dev/null 2>&1; then
    ok "the egress client pod (sandbox image, gVisor) is ready"
    client_ready=1
  else
    fail "the egress client pod (sandbox image, gVisor) is ready: $($KUBECTL -n "$TEAM_NS" get pod "$EGRESS_CLIENT" \
      -o jsonpath='{.status.phase} {.status.containerStatuses[0].state} {.status.containerStatuses[0].lastState}' 2>&1)"
    $KUBECTL -n "$TEAM_NS" describe pod "$EGRESS_CLIENT" 2>&1 | tail -25 || true
    $KUBECTL -n "$TEAM_NS" logs "$EGRESS_CLIENT" --previous --tail=30 2>&1 || true
    client_ready=0
  fi
  in_sandbox() { $KUBECTL -n "$TEAM_NS" exec "$EGRESS_CLIENT" -c client -- sh -c "$1" 2>&1 || true; }
  egress_token=$(mint kobe.egress-proxy)
  contains "an egress-proxy session token for the sandbox was minted" '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' "$egress_token"
  # → "connect=<CONNECT status> code=<origin status>" then the body; waits out a new proxy pod's
  # CNI warm-up (until the proxy answers the CONNECT at all) instead of failing on it.
  # The port is explicit: curl assumes 1080 for a proxy URL without one.
  proxy_url="http://kaiju:$egress_token@egress-proxy.kaiju.internal:80"
  # One answer from the proxy for this pod (any CONNECT status but 000) = positive control; it
  # also waits out a new proxy pod's CNI warm-up (receiving-side policy) before the checks.
  proxy_up=$(in_sandbox "if $(retry "curl -s -o /dev/null -m 5 -w %{http_connect} -x $proxy_url https://$UPSTREAM_HOST/ | grep -q '[1-9]'" 120); \
    then echo proxy=ANSWERS; else echo proxy=SILENT; fi")
  contains "control: the egress proxy answers the sandbox-like client" '^proxy=ANSWERS$' "$proxy_up"
  # → the body, then "connect=<CONNECT status> code=<origin status>".
  via_proxy() { # url [proxy url]
    in_sandbox "curl -sk -m 15 -x '${2:-$proxy_url}' -w '\nconnect=%{http_connect} code=%{http_code}\n' '$1' 2>/dev/null"
  }
  # Positive wait after a change hint: re-asks until the answer matches (bounded), then prints it.
  until_proxy() { # url regex [seconds]
    local out="" end=$((SECONDS + ${3:-20}))
    while :; do
      out=$(via_proxy "$1")
      if grep -Eq "$2" <<<"$out" || ((SECONDS >= end)); then break; fi
      sleep 1
    done
    printf '%s\n' "$out"
  }
  notify_egress() { psql_kaiju "SELECT pg_notify('kobe_egress', 'ceiling'); SELECT pg_notify('kobe_egress', '$E2E_TEAM_ID');" >/dev/null; }

  if [[ "$client_ready" == 1 ]]; then
  fresh=$(via_proxy "https://$UPSTREAM_HOST/")
  contains "fresh install: a sandbox reaches nothing through the proxy (not in the ceiling)" '^connect=403 ' "$fresh"
  contains "fresh install: package registries are in the ceiling but not enabled for teams" '^connect=403 ' "$(via_proxy https://pypi.org/)"
  contains "the proxy refuses requests without the sandbox's token (407)" '^connect=407 ' "$(via_proxy "https://$UPSTREAM_HOST/" 'http://kaiju:forged@egress-proxy.kaiju.internal:80')"
  contains "the proxy refuses plain HTTP (HTTPS only)" '^connect=000 code=403' "$(via_proxy "http://$UPSTREAM_HOST/")"
  # Negative checks only after a positive control from the same pod: the proxy answered it above.
  if [[ "$proxy_up" == *proxy=ANSWERS* ]]; then
    direct=$(in_sandbox "curl -sk -m 8 --noproxy '*' https://$up_ip/ >/dev/null 2>&1 && echo up=REACHED || echo up=BLOCKED; \
      curl -sk -m 8 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 && echo internet=REACHED || echo internet=BLOCKED")
  else
    direct="up=UNTESTED internet=UNTESTED (the proxy never answered this pod)"
  fi
  contains "direct egress to the upstream (bypassing the proxy) is blocked by NetworkPolicy" '^up=BLOCKED$' "$direct"
  contains "direct egress to the internet (bypassing the proxy) is blocked by NetworkPolicy" '^internet=BLOCKED$' "$direct"

  # A site admin adds the domains to the ceiling; the team admin enables them (D28).
  psql_kaiju "INSERT INTO egress_domains (domain, in_ceiling) VALUES ('$UPSTREAM_HOST', true), ('$INTERNAL_HOST', true) ON CONFLICT DO NOTHING;
    INSERT INTO team_egress (team_id, domain, enabled_by) VALUES ('$E2E_TEAM_ID', '$UPSTREAM_HOST', '$E2E_USER_ID'),
      ('$E2E_TEAM_ID', '$INTERNAL_HOST', '$E2E_USER_ID') ON CONFLICT DO NOTHING;" >/dev/null
  notify_egress
  allowed=$(until_proxy "https://$UPSTREAM_HOST/" '^connect=200 ')
  contains "an enabled domain is reachable through the proxy (CONNECT 200)" '^connect=200 code=200$' "$allowed"
  contains "the enabled domain's TLS server answered end to end (no interception)" 's_server' "$allowed"
  contains "an enabled domain that resolves to an internal address is refused" '^connect=403 ' "$(via_proxy "https://$INTERNAL_HOST/")"
  contains "a not-enabled domain is still blocked" '^connect=403 ' "$(via_proxy https://registry.npmjs.org/)"
  # SNI must equal the CONNECT host: the same tunnel with another TLS server name is cut.
  # "New, TLSv1.x, Cipher is …" only after a completed handshake ("New, (NONE)" otherwise; the
  # "SSL handshake has read" line is printed either way).
  s_client="openssl s_client -proxy egress-proxy.kaiju.internal:80 -proxy_user kaiju -proxy_pass 'pass:$egress_token' -connect $UPSTREAM_HOST:443"
  contains "control: a TLS handshake with the matching server name completes through the proxy" '^1$' \
    "$(in_sandbox "echo | $s_client -servername $UPSTREAM_HOST 2>&1 | grep -c '^New, TLS'")"
  contains "a TLS server name that differs from the CONNECT host is cut (SNI mismatch)" '^0$' \
    "$(in_sandbox "echo | $s_client -servername evil.example.com 2>&1 | grep -c '^New, TLS'")"

  # Revocation reaches open tunnels: keep one open, disable the domain, the proxy closes it.
  in_sandbox "rm -f /tmp/kaiju-e2e-tunnel.log; setsid nohup sh -c \"sleep 120 | ($s_client -servername $UPSTREAM_HOST -quiet \
    >/dev/null 2>&1; echo CLOSED >> /tmp/kaiju-e2e-tunnel.log)\" >/dev/null 2>&1 & sleep 5; echo started" >/dev/null
  contains "an open tunnel to an enabled domain stays up" '^OPEN$' \
    "$(in_sandbox 'grep -q CLOSED /tmp/kaiju-e2e-tunnel.log 2>/dev/null && echo CLOSED || echo OPEN')"
  psql_kaiju "DELETE FROM team_egress WHERE team_id = '$E2E_TEAM_ID' AND domain = '$UPSTREAM_HOST';" >/dev/null
  notify_egress
  contains "disabling the domain closes the already-open tunnel" '^CLOSED$' \
    "$(in_sandbox 'for i in $(seq 1 20); do grep -q CLOSED /tmp/kaiju-e2e-tunnel.log 2>/dev/null && break; sleep 1; done; \
      grep -q CLOSED /tmp/kaiju-e2e-tunnel.log 2>/dev/null && echo CLOSED || echo OPEN')"
  contains "a disabled domain is blocked again (change hint, no restart)" '^connect=403 ' \
    "$(until_proxy "https://$UPSTREAM_HOST/" '^connect=403 ')"

  contains "blocked attempts are recorded as egress.blocked events for the run" '^[1-9][0-9]*$' \
    "$(psql_kaiju "SELECT count(*) FROM events WHERE team_id = '$E2E_TEAM_ID' AND kind = 'egress.blocked'")"
  conn_audit=""
  for _ in $(seq 1 20); do
    conn_audit=$(psql_kaiju "SELECT string_agg(DISTINCT target->>'outcome', ',' ORDER BY target->>'outcome') FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action = 'egress.connection'")
    [[ "$conn_audit" == *allowed* && "$conn_audit" == *blocked* ]] && break
    sleep 2
  done
  contains "every connection is in the audit log (egress.connection: allowed and blocked)" '^allowed,blocked' "$conn_audit"
  contains "connection audit records bytes for allowed tunnels" '^[1-9][0-9]*$' \
    "$(psql_kaiju "SELECT max((target->>'bytesDown')::bigint) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'egress.connection' AND target->>'outcome' = 'allowed'")"
  fi # client_ready
  # Receiving side: only team namespaces may connect to the proxy (release namespace is refused),
  # checked only after the same probe pod reached the server (positive control).
  wait_endpoints "$NS" kaiju-server kaiju-egress-proxy
  recv=$(probe "$NS" "$(gated http://kaiju-server/healthz proxy http://kaiju-egress-proxy/healthz)")
  contains "control: the release-namespace probe reaches the server" '^control=REACHED$' "$recv"
  contains "the egress proxy admits nothing but sandboxes (probe from the release namespace)" '^proxy=BLOCKED$' "$recv"
elif [[ "${CI:-}" == "true" ]]; then
  fail "egress checks need KAIJU_SANDBOX_IMAGE and a sandbox pod"
else
  echo "SKIP egress checks (KAIJU_SANDBOX_IMAGE not set)"
fi


