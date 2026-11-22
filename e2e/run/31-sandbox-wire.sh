# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-24: the sandbox wire on the sandbox listener (8081). The e2e sandbox above belongs to a user
# and team that only exist in Kubernetes so far; give them database rows (account, team, membership)
# so the wire's liveness + principal checks can pass, mint session tokens inside the server pod with
# the real per-audience keys, and send raw WebSocket upgrades from a sandbox-like pod.
echo "==> sandbox wire (KOBE-24)"
psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$E2E_USER_ID', 'E2E sandbox user', 'sandbox-user@e2e.test', true) ON CONFLICT DO NOTHING;
  INSERT INTO teams (id, slug, name) VALUES ('$E2E_TEAM_ID', 'e2e', 'E2E') ON CONFLICT DO NOTHING;
  INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$E2E_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
mint() { # audience [sub] [user-id] → a session token signed in the server pod with that audience's key
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
    const { signSessionToken } = await import('/app/dist/sandbox/session-token.js');
    const { loadSandboxConfig } = await import('/app/dist/sandbox/config.js');
    const [aud, sub, user_id] = process.argv.slice(1);
    const now = Math.floor(Date.now() / 1000);
    console.log(signSessionToken({ iss: 'kobe-server', aud, sub, team_id: '$E2E_TEAM_ID',
      user_id, iat: now, exp: now + 600,
      jti: 'e2e-' + now + '-' + Math.random().toString(36).slice(2) },
      loadSandboxConfig(process.env).sessionKeys[aud]));
  " "$1" "${2:-${sandbox_id:-00000000-0000-4000-8000-000000000000}}" "${3:-$E2E_USER_ID}" 2>&1 | tail -1
}
wire_token=$(mint kobe.sandbox-wire)
gateway_token=$(mint kobe.model-gateway)
dead_token=$(mint kobe.sandbox-wire 00000000-0000-4000-8000-0000000000de)
upgrade() { # label token → "label=HTTP/1.1 <status>" (raw request: busybox has no WebSocket client)
  # stdin stays open: a half-closed socket (nc after EOF) is not upgraded by ws, unlike a real client.
  echo "(printf 'GET /v1/sandbox/connect HTTP/1.1\r\nHost: kobe-server\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: kobe.sandbox.v1\r\nAuthorization: Bearer $2\r\n\r\n'; sleep 4) \
    | nc -w 5 $server_ip 8081 2>/dev/null | head -1 | grep -o 'HTTP/1.1 [0-9]*' | sed 's/^/$1=/';"
}
# Gated like the egress probe: the upgrades run only once the sandbox port answers this pod.
wire=$(team_probe "$(sandbox_port_gate wire) \
  $(upgrade valid "$wire_token") $(upgrade forged forged.token.value-xxxxxxxxxx) \
  $(upgrade gateway "$gateway_token") $(upgrade dead "$dead_token") \
  wget -qO- -T 5 -S http://$server_ip:8081/v1/sandbox/connect 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | head -1 | sed 's/^/plain=/'")
printf '     sandbox wire upgrades: %s\n' "$(printf '%s' "$wire" | tr '\n' ' ')"
contains "a sandbox with a live claim and a sandbox-wire token connects (101)" '^valid=HTTP/1.1 101$' "$wire"
contains "a forged token is refused at the upgrade (401)" '^forged=HTTP/1.1 401$' "$wire"
contains "a model-gateway token is refused by the wire (audience-bound, 401)" '^gateway=HTTP/1.1 401$' "$wire"
contains "a signed token for a sandbox that does not exist is refused (401)" '^dead=HTTP/1.1 401$' "$wire"
contains "the wire endpoint is not on the user-facing ingress" 'HTTP/1.1 (401|404)' \
  "$(ingress GET /v1/sandbox/connect)"

