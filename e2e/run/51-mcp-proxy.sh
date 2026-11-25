# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-58: MCP calls go only through the MCP proxy, which asks the server about every call. Gate 2:
# a sandbox with a tampered kaiju-policy (here: a client calling the proxy directly, never asking
# policy.check) still cannot execute an MCP write without a signed approval. Runs from the same
# sandbox-like client pod as the egress checks, against a fake remote MCP server in the cluster.
echo "==> MCP proxy (KOBE-58)"
if [[ -n "${KAIJU_SANDBOX_IMAGE:-}" && -n "${sandbox_id:-}" && "${client_ready:-0}" == 1 ]]; then
  FAKE_MCP_JS=$(cat e2e/lib/fake-mcp.js) # shared with e2e/gate2.sh
  $KUBECTL create namespace "$MCP_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  $KUBECTL -n "$MCP_NS" run fake-mcp --restart=Never --image="$KAIJU_SANDBOX_IMAGE" --labels=app=fake-mcp \
    --command -- node -e "$FAKE_MCP_JS" >/dev/null
  $KUBECTL -n "$MCP_NS" expose pod fake-mcp --port=80 --target-port=8080 --name=fake-mcp >/dev/null
  $KUBECTL -n "$MCP_NS" wait --for=condition=Ready pod/fake-mcp --timeout=180s >/dev/null 2>&1 || true
  wait_endpoints "$MCP_NS" fake-mcp
  fake_mcp_ip=$($KUBECTL -n "$MCP_NS" get svc fake-mcp -o jsonpath='{.spec.clusterIP}')
  # Allow exactly that Service IP (proxy check), plain http on port 80 (CI only), and its pods
  # (proxy NetworkPolicy, which matches the pod port after Service translation).
  mcp_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}]},%s]' "$MCP_NS" "$OTEL_RULE")
  # The e2e sandbox's last run was in the KOBE-26/37 sections, 12-16 minutes ago: the 15-minute
  # idle hibernation (sandbox.hibernation.idleMinutes) would put it to sleep during the upgrade below,
  # and a sleeping sandbox never reconnects. Waking it (a no-op when awake) records fresh activity.
  contains "the e2e sandbox is awake with fresh activity before the upgrade" '"woken":true' "$(lifecycle wake)"
  mcp_upgrade_at=$(psql_kaiju "SELECT clock_timestamp()")
  server_gen_before=$($KUBECTL -n "$NS" get deploy/kaiju-server -o jsonpath='{.metadata.generation}' 2>/dev/null || true)
  if out=$($HELM upgrade kaiju charts/kaiju -n "$NS" --reuse-values --wait --timeout 5m \
      --set mcpProxy.allowInsecureHttp=true --set-json 'mcpProxy.allowedPorts=[80]' \
      --set-json "mcpProxy.allowedInternalCidrs=[\"$fake_mcp_ip/32\"]" \
      --set-json "mcpProxy.networkPolicy.extraEgress=$mcp_rule" 2>&1); then ok "MCP proxy reconfigured with the fake MCP server"
  else fail "MCP proxy reconfigured with the fake MCP server: $out"; fi

  # The registry (KOBE-59's admin API later): one connector, two pinned tools, enabled for the team
  # with exposure "all". A thread with an active run leased to the e2e sandbox (as run.start does).
  MCP_CONNECTOR=3c9e1f20-5a4b-4c6d-8e7f-9a0b1c2d3e4f
  MCP_THREAD=4d0f2031-6b5c-4d7e-9f80-0b1c2d3e4f50
  MCP_RUN=5e103142-7c6d-4e8f-a091-1c2d3e4f5061
  pinned() { # name read-only? → one snapshot entry
    printf '{"name":"%s","pi_name":"mcp__e2e_fake__%s","description":"%s (pinned)","input_schema":{"type":"object"},"annotations":%s,"sha256":"%064d","status":"pinned"}' \
      "$1" "$1" "$1" "$2" 0
  }
  snapshot="[$(pinned get_thing '{"readOnlyHint":true}'),$(pinned create_thing '{"destructiveHint":false}')]"
  # KOBE-132: the upgrade above can roll the server, and the e2e sandbox's agent then reconnects at
  # an arbitrary moment. Its hello lists no run for this fixture lease, so the server interrupts it
  # (D14, not_resumed) and the proxy rightly answers "No active run of this thread". Lease the run
  # only once the sandbox has reconnected to the rolled server, so no hello can still follow.
  server_gen_after=$($KUBECTL -n "$NS" get deploy/kaiju-server -o jsonpath='{.metadata.generation}' 2>/dev/null || true)
  if [[ "$server_gen_after" != "$server_gen_before" ]]; then
    reconnected=0
    for _ in $(seq 1 120); do
      if [[ "$(psql_kaiju "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID'
          AND user_id = '$E2E_USER_ID' AND closed_at IS NULL AND connected_at > '$mcp_upgrade_at'")" == 1 ]]; then
        reconnected=1; break
      fi
      sleep 1
    done
    if [[ "$reconnected" != 1 ]]; then # diagnostics on their own line, only on failure
      printf '     e2e sandbox: %s\n' "$(psql_kaiju "SELECT 'state=' || state || ' idle_s=' || round(extract(epoch FROM now() - last_active_at))
        FROM sandboxes WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$E2E_USER_ID'")"
    fi
    contains "the e2e sandbox reconnected to the rolled server before the MCP run is leased" '^reconnected=1$' "reconnected=$reconnected"
  fi
  psql_kaiju "INSERT INTO connectors (id, name, url, tools_snapshot) VALUES ('$MCP_CONNECTOR', 'e2e-fake', 'http://$fake_mcp_ip/mcp', '$snapshot'::jsonb)
      ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, tools_snapshot = EXCLUDED.tools_snapshot;
    INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ('$E2E_TEAM_ID', '$MCP_CONNECTOR', 'all', '$E2E_USER_ID') ON CONFLICT DO NOTHING;
    INSERT INTO threads (team_id, id, owner_user_id, status) VALUES ('$E2E_TEAM_ID', '$MCP_THREAD', '$E2E_USER_ID', 'running') ON CONFLICT DO NOTHING;
    INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at) VALUES ('$E2E_TEAM_ID', '$MCP_RUN', '$MCP_THREAD', 'user', 'running', now()) ON CONFLICT DO NOTHING;
    INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id) VALUES ('$E2E_TEAM_ID', '$MCP_RUN', '$E2E_USER_ID', '$MCP_THREAD', '$sandbox_id') ON CONFLICT DO NOTHING;" >/dev/null
  mcp_token=$(mint kobe.mcp-proxy)
  contains "an mcp-proxy session token for the sandbox was minted" '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' "$mcp_token"
  mcp_proxy_ip=$(svc_ip kaiju-mcp-proxy || true)
  mcp_rpc() { # token json-body → the answer body, then "status=<http status>"
    in_sandbox "curl -s -m 30 -w '\nstatus=%{http_code}\n' -H 'authorization: Bearer $1' -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' -H 'kaiju-thread-id: $MCP_THREAD' --data-raw '$2' \
      http://$mcp_proxy_ip:80/v1/mcp/$MCP_CONNECTOR"
  }
  # Positive control: the (restarted) proxy answers this pod at all (receiving-side CNI warm-up).
  mcp_up=$(in_sandbox "if $(retry "curl -s -o /dev/null -m 5 -w %{http_code} -X POST http://$mcp_proxy_ip:80/v1/mcp/$MCP_CONNECTOR | grep -q 401" 120); \
    then echo mcp=ANSWERS; else echo mcp=SILENT; fi")
  contains "control: the MCP proxy answers the sandbox-like client" '^mcp=ANSWERS$' "$mcp_up"
  contains "the MCP proxy refuses a forged session token (401)" '^status=401$' \
    "$(mcp_rpc forged.token.value '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  listed=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  contains "tools/list serves the connector's pinned tools (exposure all)" '"name":"get_thing".*"name":"create_thing"' "$listed"
  read_call=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_thing","arguments":{"id":"7"}}}')
  contains "a read-only tool call goes through the proxy to the remote MCP server" 'fake:get_thing' "$read_call"
  write_call=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')
  printf '     MCP write without approval: %s\n' "$(printf '%s' "$write_call" | tr '\n' ' ' | cut -c1-200)"
  contains "Gate 2: an MCP write without a signed approval is refused at the proxy" '"isError":true' "$write_call"
  contains "Gate 2: the refusal is the server's policy decision" 'Kaiju denied this call' "$write_call"
  fake_log=$($KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 || true)
  contains "the remote server received the read call (exact input)" '^CALL get_thing \{"id":"7"\}$' "$fake_log"
  expect "Gate 2: the remote server never received the unapproved write" '^(CALL get_thing .*)?$' "$(printf '%s\n' "$fake_log" | grep '^CALL' || true)"
  contains "the sandbox's session token never reaches the remote server" '^0$' "$(printf '%s\n' "$fake_log" | grep -c AUTH-HEADER-PRESENT || true)"
  contains "every MCP decision is in the audit log (mcp.tool_call: allowed and denied)" '^allowed,denied$' \
    "$(psql_kaiju "SELECT string_agg(DISTINCT target->>'decision', ',' ORDER BY target->>'decision') FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action = 'mcp.tool_call'")"
  contains "the denied write is audited with why its approval was missing" '^risk_write\|no_approval$' \
    "$(psql_kaiju "SELECT (target->>'reason') || '|' || (target->>'approvalFailure') FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action = 'mcp.tool_call' AND target->>'decision' = 'denied' ORDER BY seq DESC LIMIT 1")"
  # The user approves the write (KOBE-37 stores and signs it with the site key in the server;
  # here the same row is written directly, signed in the server pod with the real key). The same
  # direct call then runs exactly once.
  approve() { # tool-call-id input-json → kid|expires_at|mac|canonical input
    $KUBECTL -n "$NS" exec deploy/kaiju-server -c server -- node --input-type=module -e "
      const { approvalKeyring } = await import('/app/dist/approvals/keys.js');
      const { signApproval } = await import('/app/node_modules/@kaiju/protocol/dist/node/index.js');
      const { canonicalJson } = await import('/app/node_modules/@kaiju/protocol/dist/index.js');
      const [tcid, raw] = process.argv.slice(1);
      const input = JSON.parse(raw);
      const t = signApproval({ key: approvalKeyring(process.env.KAIJU_APPROVAL_KEY).current,
        approval_id: '6f214253-8d7e-4f90-b1a2-2d3e4f506172', team_id: '$E2E_TEAM_ID', run_id: '$MCP_RUN',
        tool_call_id: tcid, tool: 'mcp__e2e_fake__create_thing', input, now: new Date() });
      console.log([t.kid, t.expires_at, t.mac, canonicalJson(input)].join('|'));
    " "$1" "$2" 2>&1 | tail -1
  }
  signed=$(approve toolu_e2e_1 '{"title":"x"}')
  IFS='|' read -r a_kid a_exp a_mac a_input <<<"$signed"
  psql_kaiju "INSERT INTO approvals (team_id, id, run_id, thread_id, connection_id, user_id, tool_call_id, tool, input_canonical,
      risk, reasons, status, cause, decided_by, decided_at, expires_at, token_kid, token_expires_at, input_hmac)
    VALUES ('$E2E_TEAM_ID', '6f214253-8d7e-4f90-b1a2-2d3e4f506172', '$MCP_RUN', '$MCP_THREAD', gen_random_uuid(), '$E2E_USER_ID',
      'toolu_e2e_1', 'mcp__e2e_fake__create_thing', '$a_input', 'write', '[]'::jsonb, 'allowed', 'user',
      '$E2E_USER_ID', now(), now() + interval '1 hour', '$a_kid', '$a_exp', '$a_mac') ON CONFLICT DO NOTHING;" >/dev/null
  approved=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')
  contains "Gate 2: with a valid signed approval the same write runs" 'fake:create_thing' "$approved"
  replayed=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')
  contains "Gate 2: the approval is used once (a replay is refused)" '"isError":true' "$replayed"
  contains "Gate 2: the remote server received the approved write exactly once" '^1$' \
    "$($KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 | grep -c '^CALL create_thing ' || true)"
  contains "the approval was consumed and audited (approval.consumed)" '^[1-9][0-9]*$' \
    "$(psql_kaiju "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'approval.consumed'")"
  # KOBE-303: a connector with a site-wide API key. The Owner registers it through the registry API
  # (the fake serves no tools/list, so its tools are pinned here like the fixture above), enables it
  # and sets the key once; two members (the e2e user and the workspace-sync user, each with their own
  # sandbox claim and run) call a tool without adding keys. The fake server sees the site key on
  # every call; the key is in no sandbox env or template, no API answer and no audit row.
  SITE_KEY="e2e-site-key-$(date +%s)-Kaiju303"
  site_reg=$(as_owner "POST /v1/site/connectors {\"name\":\"e2e-site\",\"url\":\"http://$fake_mcp_ip/mcp\",\"authKind\":\"api_key\",\"credentialSource\":\"site\"}")
  SITE_CONNECTOR=$(printf '%s' "$site_reg" | sed -n 's/.*"connector":{"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
  contains "KOBE-303: the Owner registers a site-key connector" '^[0-9a-f-]{36}$' "${SITE_CONNECTOR:-$site_reg}"
  site_snapshot="[$(pinned get_thing '{"readOnlyHint":true}' | sed 's/mcp__e2e_fake__/mcp__e2e_site__/')]"
  SITE_THREAD=7a2c3d4e-5f60-4718-9a2b-3c4d5e6f7081
  SITE_RUN=8b3d4e5f-6071-4829-ab3c-4d5e6f708192
  SITE_THREAD2=9c4e5f60-7182-493a-bc4d-5e6f708192a3
  SITE_RUN2=ad5f6071-8293-4a4b-8d5e-6f708192a3b4
  sync_sandbox=$(sync_uid)
  psql_kaiju "UPDATE connectors SET tools_snapshot = '$site_snapshot'::jsonb WHERE id = '$SITE_CONNECTOR';
    INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ('$E2E_TEAM_ID', '$SITE_CONNECTOR', 'all', '$E2E_USER_ID') ON CONFLICT DO NOTHING;
    INSERT INTO threads (team_id, id, owner_user_id, status) VALUES ('$E2E_TEAM_ID', '$SITE_THREAD', '$E2E_USER_ID', 'running'), ('$E2E_TEAM_ID', '$SITE_THREAD2', '$SYNC_USER_ID', 'running') ON CONFLICT DO NOTHING;
    INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at) VALUES ('$E2E_TEAM_ID', '$SITE_RUN', '$SITE_THREAD', 'user', 'running', now()), ('$E2E_TEAM_ID', '$SITE_RUN2', '$SITE_THREAD2', 'user', 'running', now()) ON CONFLICT DO NOTHING;
    INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id) VALUES ('$E2E_TEAM_ID', '$SITE_RUN', '$E2E_USER_ID', '$SITE_THREAD', '$sandbox_id'), ('$E2E_TEAM_ID', '$SITE_RUN2', '$SYNC_USER_ID', '$SITE_THREAD2', '$sync_sandbox') ON CONFLICT DO NOTHING;" >/dev/null
  site_set=$(as_owner "PUT /v1/site/connectors/$SITE_CONNECTOR/site-key {\"api_key\":\"$SITE_KEY\"}" "GET /v1/site/connectors/$SITE_CONNECTOR")
  contains "KOBE-303: the site key is set and shown only by its last four characters" "\"siteKeyHint\":\"••••${SITE_KEY: -4}\"" "$site_set"
  contains "KOBE-303: no registry answer carries the key" '^0$' "$(printf '%s\n' "$site_set" | grep -c -- "$SITE_KEY" || true)"
  site_rpc() { # token thread json-body → the answer body, then "status=<http status>"
    in_sandbox "curl -s -m 30 -w '\nstatus=%{http_code}\n' -H 'authorization: Bearer $1' -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' -H 'kaiju-thread-id: $2' --data-raw '$3' \
      http://$mcp_proxy_ip:80/v1/mcp/$SITE_CONNECTOR"
  }
  member2_token=$(mint kobe.mcp-proxy "$sync_sandbox" "$SYNC_USER_ID")
  contains "KOBE-303: the first member calls a tool with no key of their own" 'fake:get_thing' \
    "$(site_rpc "$mcp_token" "$SITE_THREAD" '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"get_thing","arguments":{"id":"site-1"}}}')"
  contains "KOBE-303: a second member calls it too, with no setup" 'fake:get_thing' \
    "$(site_rpc "$member2_token" "$SITE_THREAD2" '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"get_thing","arguments":{"id":"site-2"}}}')"
  site_log=$($KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 || true)
  contains "KOBE-303: the fake server received both members' calls" '^2$' \
    "$(printf '%s\n' "$site_log" | grep -cE '^CALL get_thing \{"id":"site-[12]"\}$' || true)"
  contains "KOBE-303: the fake server saw the site key on both calls" '^[2-9]$' \
    "$(printf '%s\n' "$site_log" | grep -cxF "AUTH Bearer $SITE_KEY" || true)"
  contains "KOBE-303: every call is audited with the member who made it" '^2$' \
    "$(psql_kaiju "SELECT count(DISTINCT target->>'userId') FROM audit_log WHERE team_id = '$E2E_TEAM_ID'
      AND action = 'mcp.tool_call' AND target->>'connectorId' = '$SITE_CONNECTOR' AND target->>'decision' = 'allowed'")"
  site_env=$($KUBECTL -n "$TEAM_NS" exec "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=$sandbox_id" -o name | head -1)" \
    -c agent -- env 2>/dev/null || true)
  contains "control: the e2e sandbox's env was read" '^[1-9][0-9]*$' "$(printf '%s\n' "$site_env" | grep -c '^KAIJU_' || true)"
  contains "KOBE-303: the e2e sandbox's env holds no site key" '^0$' "$(printf '%s\n' "$site_env" | grep -c -- "$SITE_KEY" || true)"
  contains "KOBE-303: no SandboxTemplate in the team namespace holds it" '^0$' \
    "$($KUBECTL -n "$TEAM_NS" get sandboxtemplates.extensions.agents.x-k8s.io -o yaml 2>/dev/null | grep -c -- "$SITE_KEY" || true)"
  contains "KOBE-303: no audit row holds it" '^0$' \
    "$(psql_kaiju "SELECT count(*) FROM audit_log WHERE target::text LIKE '%$SITE_KEY%'")"
  contains "KOBE-303: it is stored sealed (never in clear)" '^0$' \
    "$(psql_kaiju "SELECT count(*) FROM connector_site_keys WHERE sealed LIKE '%$SITE_KEY%'")"
  contains "KOBE-303: no server log line holds it" '^0$' \
    "$(for pod in $($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name); do
        $KUBECTL -n "$NS" logs "$pod" -c server 2>/dev/null || true; done | grep -c -- "$SITE_KEY" || true)"
  # KOBE-449: a real run of a member with no key of their own gets the site-key connector in
  # run.start.mcp, so Pi offers its tool and the model calls it (the fake model's "tools?" echo and
  # "steps:" script). The Owner holds no grant for it (a site connector refuses members' keys).
  if [[ "${KAIJU_E2E_TOOL_EXECUTOR:-}" == 1 ]]; then
    echo "SKIP KOBE-449 site-key run (runs in the suite shard only)"
  elif [[ "$(type -t chat_run)" == function && -n "${owner_id:-}" ]]; then
    SITE_AGENT=5e6f7081-92a3-4b4c-9d6e-7f8091a2b3c5
    psql_kaiju "DELETE FROM site_agents WHERE id = '$SITE_AGENT' AND current_version IS NULL;
      INSERT INTO site_agents (id, scope, owner_user_id, slug, frontmatter, prompt)
        SELECT '$SITE_AGENT', 'personal', '$owner_id', 'e2e-site-key',
          (a.frontmatter - 'tools') || '{\"name\":\"E2E site key\",\"connectors\":[\"e2e-site\"]}'::jsonb, a.prompt
        FROM site_agents a WHERE a.gallery_key = 'kaiju' ON CONFLICT DO NOTHING;
      INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest, draft_revision)
        SELECT a.id, 1, a.frontmatter, a.prompt,
          (SELECT v.tool_manifest FROM site_agent_versions v JOIN site_agents g ON g.id = v.agent_id AND v.version = g.current_version
            WHERE g.gallery_key = 'kaiju') || '{\"connectors\":[\"e2e-site\"]}'::jsonb, 1
        FROM site_agents a WHERE a.id = '$SITE_AGENT' ON CONFLICT DO NOTHING;
      UPDATE site_agents SET current_version = 1 WHERE id = '$SITE_AGENT';" >/dev/null
    contains "KOBE-449: the Owner holds no key of their own for the site-key connector" '^0$' \
      "$(psql_kaiju "SELECT count(*) FROM connector_grants WHERE connector_id = '$SITE_CONNECTOR'")"
    site_tools=$(chat_run "tools?" 240000 "" "$SITE_AGENT")
    contains "KOBE-449: the run's model is offered the site-key connector's tool" '^text=.*mcp__e2e_site__get_thing' "$site_tools"
    site_steps='[{"name":"mcp__e2e_site__get_thing","args":{"id":"site-run"}}]'
    site_run=$(chat_run "steps: $site_steps" 240000 "" "$SITE_AGENT")
    printf '     site-key run: %s\n' "$(printf '%s' "$site_run" | tr '\n' ' ' | cut -c1-400)"
    contains "KOBE-449: the run calling the site-key tool completed" '^terminal=run.completed$' "$site_run"
    contains "KOBE-449: the model saw the fake server's answer" 'tool said: .*fake:get_thing' "$site_run"
    site_log=$($KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 || true)
    contains "KOBE-449: the run's call reached the remote server exactly once" '^1$' \
      "$(printf '%s\n' "$site_log" | grep -cxF 'CALL get_thing {"id":"site-run"}' || true)"
    contains "KOBE-449: ...with the site key" '^[3-9]$|^[1-9][0-9]+$' \
      "$(printf '%s\n' "$site_log" | grep -cxF "AUTH Bearer $SITE_KEY" || true)"
  elif [[ "${CI:-}" == "true" ]]; then
    fail "KOBE-449: the site-key run needs the model setup (chat_run) and the Owner"
  else
    echo "SKIP KOBE-449 site-key run (no model setup)"
  fi
  # Sandboxes cannot skip the proxy and ask the server's internal port themselves.
  internal=$(in_sandbox "curl -s -o /dev/null -m 5 http://$server_ip:8081/healthz && echo control=REACHED || echo control=BLOCKED; \
    curl -s -o /dev/null -m 5 http://$server_ip:8082/healthz && echo internal=REACHED || echo internal=BLOCKED")
  contains "control: the sandbox-like client reaches the server's sandbox port" '^control=REACHED$' "$internal"
  contains "sandboxes cannot reach the server's internal port (MCP re-check)" '^internal=BLOCKED$' "$internal"
  # Receiving side: only team namespaces may connect to the proxy (release namespace is refused).
  wait_endpoints "$NS" kaiju-server kaiju-mcp-proxy
  mcp_recv=$(probe "$NS" "$(gated http://kaiju-server/healthz mcp http://kaiju-mcp-proxy/healthz)")
  contains "control: the release-namespace probe reaches the server" '^control=REACHED$' "$mcp_recv"
  contains "the MCP proxy admits nothing but sandboxes (probe from the release namespace)" '^mcp=BLOCKED$' "$mcp_recv"
elif [[ "${CI:-}" == "true" ]]; then
  fail "MCP proxy checks need KAIJU_SANDBOX_IMAGE, the e2e sandbox and the egress client pod"
else
  echo "SKIP MCP proxy checks (KAIJU_SANDBOX_IMAGE not set)"
fi

