# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
  $KUBECTL create namespace "$LLM_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  $KUBECTL -n "$LLM_NS" run llm --restart=Never --image="ghcr.io/splittingatom/kobe-model-gateway:$TAG" \
    --image-pull-policy=IfNotPresent --labels=app=llm --command -- node dist/testing/fake-llm-main.js >/dev/null
  $KUBECTL -n "$LLM_NS" expose pod llm --port=80 --target-port=8080 --name=llm >/dev/null
  $KUBECTL -n "$LLM_NS" wait --for=condition=Ready pod/llm --timeout=180s >/dev/null 2>&1 || true
  wait_endpoints "$LLM_NS" llm
  LLM="http://llm.$LLM_NS.svc.cluster.local"
  # Bifrost may reach the fake provider (a private address): explicit egress rule, like a LAN Ollama.
  llm_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}],"ports":[{"protocol":"TCP","port":8080}]}]' "$LLM_NS")
  if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set-json "bifrost.networkPolicy.extraEgress=$llm_rule" --set bifrost.allowUnsafeProviderEndpoints=true 2>&1); then
    ok "Bifrost may reach the fake model provider (test-only unsafe endpoints switch on)"
  else fail "Bifrost may reach the fake model provider: $out"; fi

  # A member of the e2e team with no sandbox row yet (tokens are minted for live claims only), and
  # the Owner as that team's admin (to choose the team's models through the team API).
  MODEL_USER_ID=8b3f3c4d-2e5f-4a7b-8c1d-2e3f4a5b6c7d
  psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$MODEL_USER_ID', 'E2E models', 'models@e2e.test', true) ON CONFLICT DO NOTHING;
    INSERT INTO teams (id, slug, name) VALUES ('$E2E_TEAM_ID', 'e2e', 'E2E') ON CONFLICT DO NOTHING;
    INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$MODEL_USER_ID', 'member') ON CONFLICT DO NOTHING;
    INSERT INTO team_members (team_id, user_id, role) SELECT '$E2E_TEAM_ID', id, 'team_admin' FROM users WHERE email = 'owner@e2e.test'
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'team_admin';" >/dev/null
  # The admin API as the Owner, from inside a server pod: signs in once, then sends each request
  # (one per argument: "METHOD /path [json]") and prints "<status> <body>" per request.
  as_owner() {
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
      const base = 'http://127.0.0.1:8080', origin = process.env.KAIJU_PUBLIC_URL;
      const h = { origin, 'content-type': 'application/json', 'x-kobe-team': '$E2E_TEAM_ID' };
      // Sign-in is rate limited (3 per 10 s per address): wait out a 429 instead of failing.
      let login;
      for (let i = 0; i < 4; i++) {
        login = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: h,
          body: JSON.stringify({ email: 'owner@e2e.test', password: 'e2e owner password' }) });
        if (login.status !== 429) break;
        await new Promise((r) => setTimeout(r, 11000));
      }
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      await fetch(base + '/v1/me/teams/active', { method: 'PUT', headers: { ...h, cookie },
        body: JSON.stringify({ teamId: '$E2E_TEAM_ID' }) });
      for (const req of process.argv.slice(1)) {
        const [method, path, ...rest] = req.split(' ');
        const body = rest.join(' ');
        const res = await fetch(base + path, { method, headers: { ...h, cookie }, ...(body ? { body } : {}) });
        console.log(res.status + ' ' + (await res.text()).slice(0, 400));
      }
    " "$@" 2>&1
  }
  setup_models=$(as_owner \
    "POST /v1/site/models/providers {\"kind\":\"openai\",\"name\":\"Fake OpenAI\",\"api_key\":\"e2e-provider-key-openai\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/site/models/providers {\"kind\":\"anthropic\",\"name\":\"Fake Anthropic\",\"api_key\":\"e2e-provider-key-anthropic\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/site/models/providers {\"kind\":\"gemini\",\"name\":\"Fake Gemini\",\"api_key\":\"e2e-provider-key-gemini\",\"base_url\":\"$LLM/v1beta\",\"allow_private_network\":true}" \
    "POST /v1/site/models/providers {\"kind\":\"ollama\",\"name\":\"Fake Ollama\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/site/models/providers {\"kind\":\"openai_compatible\",\"id\":\"vllm\",\"name\":\"Fake vLLM\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/site/models/catalog {\"alias\":\"fast\",\"provider_id\":\"openai\",\"model\":\"gpt-fake\"}" \
    "POST /v1/site/models/catalog {\"alias\":\"smart\",\"provider_id\":\"anthropic\",\"model\":\"claude-fake\"}" \
    "POST /v1/site/models/catalog {\"alias\":\"gem\",\"provider_id\":\"gemini\",\"model\":\"gemini-fake\"}" \
    "POST /v1/site/models/catalog {\"alias\":\"local\",\"provider_id\":\"ollama\",\"model\":\"llama-fake\"}" \
    "POST /v1/site/models/catalog {\"alias\":\"qwen\",\"provider_id\":\"vllm\",\"model\":\"qwen-fake\"}" \
    "PUT /v1/team/models/fast {\"enabled\":true,\"is_default\":true}" \
    "PUT /v1/team/models/smart {\"enabled\":true}" \
    "PUT /v1/team/models/gem {\"enabled\":true}" \
    "PUT /v1/team/models/local {\"enabled\":true}" \
    "PUT /v1/team/models/qwen {\"enabled\":true}")
  printf '     model admin: %s\n' "$(printf '%s' "$setup_models" | cut -c1-60 | tr '\n' '|')"
  expect "the Owner configures providers, the catalog and the team's models (admin API)" '^(200|201) ' "$setup_models"
  if printf '%s' "$setup_models" | grep -q 'e2e-provider-key'; then fail "provider keys are never returned"
  else ok "provider keys are never returned"; fi
  contains "provider key changes are audited without the key" '^5$' \
    "$(psql_kobe "SELECT count(*) FROM audit_log WHERE action = 'models.provider.added' AND target::text NOT LIKE '%e2e-provider-key%'")"
  t0=$SECONDS
  synced=$(wait_for 60 '^in_sync=true' gateway_state)
  contains "Bifrost reflects the configuration (gateway in sync)" '^in_sync=true error=-$' "$synced"
  printf '     gateway in sync after %ss\n' "$((SECONDS - t0))"
  if [[ "$SHARD" == gate1-prep ]]; then exit "$failed"; fi

  # KOBE-265: an install synced before KOBE-256 (every team under customer kobe-install), plus the
  # empty kobe-site that KOBE-256's create-and-move left on kobe-gate1, converges on the real
  # Bifrost: kobe-install is renamed in place, the stray goes, virtual keys keep their ids and
  # values, and the next pass writes nothing. Bifrost's admin API is reachable from the server pod
  # only; key values are hashed, never printed.
  gw_customers() { # state|legacy → "customers=<names> teams_on=<their customers> vks=<hash>"
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
      const { createHttpBifrostAdmin } = await import('/app/dist/models/bifrost-admin.js');
      const { createHash } = await import('node:crypto');
      const admin = createHttpBifrostAdmin({ baseUrl: process.env.KAIJU_BIFROST_URL,
        username: process.env.KAIJU_BIFROST_ADMIN_USERNAME || 'kobe', password: process.env.KAIJU_BIFROST_ADMIN_PASSWORD });
      if (process.argv[1] === 'legacy') {
        const [site] = await admin.listCustomers();
        await admin.updateCustomer(site.id, 'kobe-install');
        const stray = await admin.addCustomer('kobe-site');
        for (const t of await admin.listTeams()) await admin.updateTeam(t.id, stray.id);
      }
      const customers = await admin.listCustomers();
      const name = (id) => customers.find((c) => c.id === id)?.name ?? 'none';
      const teamsOn = [...new Set((await admin.listTeams()).map((t) => name(t.customerId)))].sort();
      const vks = (await admin.listVirtualKeys()).map((v) => v.id + ':' + v.value).sort().join(',');
      console.log('customers=' + customers.map((c) => c.name).sort().join(',') + ' teams_on=' + teamsOn.join(',')
        + ' vks=' + createHash('sha256').update(vks).digest('hex').slice(0, 16));
    " "$1" 2>&1 | tail -1
  }
  gw_pass() { # bumps the desired version (as an admin change does) and waits for the pass
    psql_kobe "UPDATE model_gateway_state SET desired_version = desired_version + 1 WHERE id = 1; SELECT pg_notify('kobe_models', 'config');" >/dev/null
    wait_for 60 '^in_sync=true error=-$' gateway_state
  }
  gw_synced_lines() { # sync passes that wrote to Bifrost in the last $1 seconds, on any server pod
    local pod
    for pod in $($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name); do
      $KUBECTL -n "$NS" logs "$pod" -c server --since="$1s" 2>/dev/null || true
    done | grep -cE '"msg":"model gateway (synced|sync incomplete)"' || true
  }
  gw_before=$(gw_customers state)
  contains "Bifrost holds one site customer with every team (before the upgrade check)" \
    '^customers=kobe-site teams_on=kobe-site vks=' "$gw_before"
  contains "Bifrost v2.2.5 keeps a team's customer on update (KOBE-256's move left the teams behind)" \
    '^customers=kobe-install,kobe-site teams_on=kobe-install vks=' "$(gw_customers legacy)"
  contains "upgrade from kobe-install: the sync pass reports in sync" '^in_sync=true error=-$' "$(gw_pass)"
  contains "upgrade from kobe-install: renamed in place, stray removed, virtual keys unchanged (KOBE-265)" \
    "^customers=kobe-site teams_on=kobe-site ${gw_before##* }\$" "$(gw_customers state)"
  sleep 3 # the log window below must not reach back to the pass above
  t_pass=$SECONDS
  contains "upgrade from kobe-install: the next pass is in sync" '^in_sync=true error=-$' "$(gw_pass)"
  contains "upgrade from kobe-install: the next pass writes nothing to Bifrost (converged)" '^0$' \
    "$(gw_synced_lines $((SECONDS - t_pass + 1)))"

  # KOBE-44: the catalog's model listing asks the real Bifrost to call a provider with its key. A
  # provider on a private address WITHOUT allow_private_network must not be reached that way.
  priv_add=$(as_owner "POST /v1/site/models/providers {\"kind\":\"openai_compatible\",\"id\":\"e2epriv\",\"name\":\"Private, not allowed\",\"api_key\":\"e2e-private-key\",\"base_url\":\"$LLM\",\"allow_private_network\":false}")
  expect "a keyed provider on a private address is added with private network off" '^201 ' "$priv_add"
  # Wait until Bifrost has the provider (the listing answers 200, not 409 provider_not_synced).
  priv_listed() { as_owner "GET /v1/site/models/providers/e2epriv/models" | head -1; }
  priv_ready=$(wait_for 45 '^200 ' priv_listed)
  printf '     private provider in the gateway: %s | %s\n' "$(printf '%s' "$priv_ready" | cut -c1-120)" "$(gateway_state)"
  priv_refresh=$(as_owner "POST /v1/site/models/providers/e2epriv/models/refresh")
  printf '     private refresh: %s\n' "$(printf '%s' "$priv_refresh" | cut -c1-200)"
  # Bifrost v2.2.5 refuses such a provider when the sync pushes it (gateway error bifrost_rejected,
  # observed in CI), so it never gets as far as a list-models call; a Bifrost that accepted it must
  # still not list its models. Either way no model list comes back.
  if printf '%s' "$priv_refresh" | grep -q '"discovery":"ok"'; then
    fail "listing models of a private-address provider (private network off) is refused: $(printf '%s' "$priv_refresh" | cut -c1-200)"
  elif printf '%s' "$priv_refresh" | grep -q '^200 ' || \
      { printf '%s' "$priv_refresh" | grep -q 'provider_not_synced' && [[ "$(gateway_state)" == *bifrost_rejected* ]]; }; then
    ok "listing models of a private-address provider (private network off) is refused"
  else fail "listing models of a private-address provider (private network off) is refused: $(printf '%s' "$priv_refresh" | cut -c1-200)"; fi
  priv_seen=$(probe "$NS" "$(answers "$LLM/_seen")")
  if [[ -n "$priv_seen" ]] && ! printf '%s' "$priv_seen" | grep -q 'e2e-private-key'; then
    ok "Bifrost never sent that provider's key to the private address"
  else fail "Bifrost never sent that provider's key to the private address"; fi
  contains "the refresh is audited without the key" '^1$' \
    "$(psql_kobe "SELECT count(*) FROM audit_log WHERE action = 'models.provider.models_refreshed' AND target->>'providerId' = 'e2epriv' AND target::text NOT LIKE '%e2e-private-key%'")"
  as_owner "DELETE /v1/site/models/providers/e2epriv" >/dev/null
  contains "the gateway is in sync again once that provider is removed" '^in_sync=true error=-$' \
    "$(wait_for 60 '^in_sync=true' gateway_state)"

  # The sandbox-like client: team namespace (team NetworkPolicy), gVisor, no DNS, the shim at
  # model-gateway.kobe.internal as in real sandboxes; a model-gateway token for the model user.
  MODEL_CLIENT="model-client-$RANDOM"
  PODS+=("-n $TEAM_NS $MODEL_CLIENT")
  $KUBECTL -n "$TEAM_NS" run "$MODEL_CLIENT" --restart=Never --image="$KAIJU_SANDBOX_IMAGE" --overrides="{\"spec\":{
    \"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"serviceAccountName\":\"kobe-sandbox\",$SEC_POD,
    \"dnsPolicy\":\"None\",\"dnsConfig\":{\"nameservers\":[\"127.0.0.1\"]},
    \"hostAliases\":[{\"ip\":\"${mg_ip:-0.0.0.0}\",\"hostnames\":[\"model-gateway.kobe.internal\"]}],
    \"containers\":[{\"name\":\"client\",\"image\":\"$KAIJU_SANDBOX_IMAGE\",\"command\":[\"sleep\",\"3600\"],$SEC_CTR,
      \"resources\":{\"requests\":{\"cpu\":\"50m\",\"memory\":\"64Mi\"},\"limits\":{\"cpu\":\"500m\",\"memory\":\"256Mi\"}},
      \"volumeMounts\":[{\"name\":\"tmp\",\"mountPath\":\"/tmp\"}]}],
    \"volumes\":[{\"name\":\"tmp\",\"emptyDir\":{}}]}}" >/dev/null 2>&1 || true
