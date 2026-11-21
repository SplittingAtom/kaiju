# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-244 (KOBE-241, KOBE-111 ac-2): a real Pi makes an MCP call, the sandbox session tokens rotate past their
# TTL, and the next MCP call in the same thread still succeeds. Pi resolves the Authorization header
# only when it connects; the mcp-proxy answers 404 to an expired token on the kept Mcp-Session-Id, so
# Pi reconnects, re-reads the rotated token file and retries. The install shortens the token TTL to
# 10 s for this (server.sessionTokenTtlSeconds, 10..900); the 116 section below restores 900. The
# owner's sandbox is hibernated first so its next wake trades tokens of the short TTL. Needs the MCP
# fixture (connector e2e-fake) and the fake model.
echo "==> real Pi past an MCP token rotation (KOBE-244)"
if [[ "${KOBE_E2E_TOOL_EXECUTOR:-}" != 1 ]]; then
  echo "SKIP MCP token rotation check (KOBE-244: runs in the executor shard only)"
elif [[ -n "${KOBE_SANDBOX_IMAGE:-}" && "$(type -t chat_run)" == function && -n "${MCP_CONNECTOR:-}" && -n "${owner_id:-}" ]]; then
  ROT_TTL=10
  ROT_AGENT=6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d
  rot_t0=$SECONDS
  # A published personal agent of the owner: Kobe's definition with only the e2e-fake connector.
  psql_kobe "DELETE FROM site_agents WHERE id = '$ROT_AGENT' AND current_version IS NULL;
    INSERT INTO site_agents (id, scope, owner_user_id, slug, frontmatter, prompt)
      SELECT '$ROT_AGENT', 'personal', '$owner_id', 'e2e-mcp-rotation',
        (a.frontmatter - 'tools') || '{\"name\":\"E2E MCP rotation\",\"connectors\":[\"e2e-fake\"]}'::jsonb, a.prompt
      FROM site_agents a WHERE a.gallery_key = 'kobe' ON CONFLICT DO NOTHING;
    INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest, draft_revision)
      SELECT a.id, 1, a.frontmatter, a.prompt,
        (SELECT v.tool_manifest FROM site_agent_versions v JOIN site_agents g ON g.id = v.agent_id AND v.version = g.current_version
          WHERE g.gallery_key = 'kobe') || '{\"connectors\":[\"e2e-fake\"]}'::jsonb, 1
      FROM site_agents a WHERE a.id = '$ROT_AGENT' ON CONFLICT DO NOTHING;
    UPDATE site_agents SET current_version = 1 WHERE id = '$ROT_AGENT';" >/dev/null
  contains "the owner has a published agent with the e2e-fake connector" '^1$' \
    "$(psql_kobe "SELECT current_version FROM site_agents WHERE id = '$ROT_AGENT'")"
  owner_lifecycle() { # hibernate|wake for the owner's sandbox
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/lifecycle.js "$1" \
      --team-id "$E2E_TEAM_ID" --user-id "$owner_id" 2>&1 | grep -E '^\{"(hibernated|woken)"' || true
  }
  # Must really hibernate (KOBE-563): an awake sandbox keeps its 900 s tokens and never sees a 404.
  if owner_hibernate "token rotation"; then ok "the owner's sandbox is hibernated before the TTL change"
  else fail "the owner's sandbox is hibernated before the TTL change"; fi
  if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set "server.sessionTokenTtlSeconds=$ROT_TTL" 2>&1); then ok "session tokens now live $ROT_TTL s (test install)"
  else fail "session tokens now live $ROT_TTL s (test install): $out"; fi
  rot_calls() { $KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 | grep -c "^CALL get_thing .*\"id\":\"$1\"" || true; }
  rot_t1=$SECONDS
  # One run, three scripted tool calls (the fake model's "steps:" script): an MCP call, a bash sleep
  # past the token's life (Pi's connection and its token are now stale; the file holds a newer one),
  # and the same MCP call again.
  rot_steps='[{"name":"mcp__e2e_fake__get_thing","args":{"id":"101"}},{"name":"bash","args":{"command":"sleep '$((ROT_TTL + 3))'; echo slept"}},{"name":"mcp__e2e_fake__get_thing","args":{"id":"102"}}]'
  rot_out=$(chat_run "steps: $rot_steps" 240000 "" "$ROT_AGENT" "" 1)
  printf '     rotation run: %s\n' "$(printf '%s' "$rot_out" | tr '\n' ' ' | cut -c1-400)"
  contains "the run with an MCP call before and after the token rotation completed" '^terminal=run.completed$' "$rot_out"
  contains "the model saw the fake server's answer to the call after the rotation" 'tool said: .*fake:get_thing' "$rot_out"
  contains "the call before the rotation reached the fake MCP server exactly once" '^1$' "$(rot_calls 101)"
  contains "the call after the rotation reached the fake MCP server exactly once (the 404 retry never runs it twice)" '^1$' "$(rot_calls 102)"
  contains "the mcp-proxy answered an expired token on the live session with 404 (Pi reconnected)" '^[1-9][0-9]*$' \
    "$($KUBECTL -n "$NS" logs -l app.kubernetes.io/component=mcp-proxy --tail=-1 --since=15m 2>/dev/null \
      | grep -c 'expired token on a live session; answered 404' || true)"
  printf '     rotation e2e: %ss in all (setup %ss, run %ss)\n' "$((SECONDS - rot_t0))" "$((rot_t1 - rot_t0))" "$((SECONDS - rot_t1))"
elif [[ "${CI:-}" == "true" ]]; then
  fail "the MCP token rotation check needs KOBE_SANDBOX_IMAGE, the MCP fixture and the model setup"
else
  echo "SKIP MCP token rotation check (KOBE-244: needs the MCP fixture and the model setup)"
fi

