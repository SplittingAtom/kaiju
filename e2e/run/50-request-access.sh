# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-39 (Gate 2: "blocked domain → request access → enablement works", U12). A tool in the Owner's
# REAL sandbox is blocked, the Owner asks for access from the thread, the team admin approves, and
# the same tool succeeds. The fake model answers "bash: <command>" with a bash tool call, so Pi runs
# curl through its own bash: HTTPS_PROXY comes from the agent's egress token file via the image's
# BASH_ENV script (no credentials in the pod spec or Pi's environment). The Owner is the team's only
# admin, so it both asks and decides here; that members can't decide is services/server
# egress-requests.db.test.ts. Then header injection: CONNECT to a header domain is refused, and the
# plain-HTTP upgrade verifies the upstream's certificate (the test upstream's is self-signed: 502).
echo "==> request access and header injection (KOBE-39)"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && -n "${owner_id:-}" && -n "${UPSTREAM_HOST:-}" ]] && declare -F as_owner >/dev/null; then
  read -r -d '' EGRESS_JS <<'JS' || true
const [team, content, timeoutMs, threadArg, ask] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const jar = new Map();
const headers = () => ({ origin, "content-type": "application/json", "x-kobe-team": team,
  cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") });
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const out = (k, v) => console.log(k + "=" + v);
let login;
for (let i = 0; i < 4; i++) {
  login = await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
  if (login.status !== 429) break;
  await new Promise((r) => setTimeout(r, 11000));
}
await call("PUT", "/v1/me/teams/active", { teamId: team });
const threadId = threadArg && threadArg !== "-" ? threadArg : (await call("POST", "/v1/threads", { title: "kobe-39" })).json.thread_id;
out("thread", threadId);
const sent = await call("POST", "/v1/threads/" + threadId + "/messages", { content });
out("message", sent.status);
const runId = sent.json.run_id;
out("run", runId);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
let text = "", terminal = "none";
const blocked = [];
try {
  const res = await fetch(base + "/v1/runs/" + runId + "/events", { headers: { ...headers(), accept: "text/event-stream" }, signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (terminal === "none") {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (!type) continue;
      let payload = {}; try { payload = JSON.parse(data).payload ?? {}; } catch {}
      if (type === "egress.blocked") blocked.push(payload.domain + ":" + payload.request_access);
      if (type === "text.delta") text += payload.delta ?? "";
      if (["run.completed", "run.failed", "run.interrupted", "run.budget_stopped"].includes(type)) terminal = type;
    }
  }
} catch (e) { out("stream_error", e.name); }
clearTimeout(timer);
out("terminal", terminal);
out("blocked", blocked.join(",") || "-");
out("text", text.replace(/\s+/g, " "));
if (ask === "ask") {
  // The chat notice's Request access: the blocked domain and this thread.
  const domain = (blocked[0] ?? "").split(":")[0] || process.env.KOBE_E2E_DOMAIN;
  const req = await call("POST", "/v1/egress/requests", { domain, thread_id: threadId });
  out("request", req.status + ":" + (req.json.request?.status ?? req.json.code));
  out("request_id", req.json.request?.id ?? "-");
}
JS
  egress_chat() { # content [thread-id|-] [ask] → key=value lines
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- env KOBE_E2E_DOMAIN="$UPSTREAM_HOST" \
      node --input-type=module -e "$EGRESS_JS" "$E2E_TEAM_ID" "$1" 300000 "${2:--}" "${3:-}" 2>&1 | grep -E '^[a-z_]+=' || true
  }
  # Sandbox tools run without approval unless a rule asks (KOBE-37's story left an ask rule on bash);
  # the upstream is in the ceiling (KOBE-38's story) but not enabled for the team.
  psql_kobe "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team';
    DELETE FROM team_egress WHERE team_id = '$E2E_TEAM_ID' AND domain = '$UPSTREAM_HOST';
    INSERT INTO egress_domains (domain, in_ceiling) VALUES ('$UPSTREAM_HOST', true)
      ON CONFLICT (domain) DO UPDATE SET in_ceiling = true;
    SELECT pg_notify('kobe_egress', '$E2E_TEAM_ID'); SELECT pg_notify('kobe_egress', 'ceiling');" >/dev/null
  tool="bash: curl -sSk -m 20 https://$UPSTREAM_HOST/ 2>&1 | head -c 300"
  first=$(egress_chat "$tool" - ask)
  printf '     blocked run: %s\n' "$(printf '%s' "$first" | tr '\n' ' ' | cut -c1-400)"
  if ! grep -q '^terminal=run.completed$' <<<"$first"; then
    # KOBE-415: this run (and the next on its thread) once hung until the stream timeout, which
    # pushed the executor shard past its 45-minute limit.
    hung_run_report "blocked run" "$(printf '%s\n' "$first" | sed -n 's/^run=//p')" "$E2E_TEAM_ID"
  fi
  e_thread=$(printf '%s\n' "$first" | sed -n 's/^thread=//p')
  contains "the tool's run completed (Pi ran curl through its bash tool)" '^terminal=run.completed$' "$first"
  contains "the tool was blocked by the egress proxy (no team enablement yet)" '^text=.*(403|Kobe egress)' "$first"
  contains "the blocked request reached the run as egress.blocked with request access" \
    "^blocked=.*${UPSTREAM_HOST}:true" "$first"
  contains "the proxy attributed the blocked request to the thread (BASH_ENV proxy user = thread id)" '^[1-9][0-9]*$' \
    "$(psql_kobe "SELECT count(*) FROM events WHERE team_id = '$E2E_TEAM_ID' AND kind = 'egress.blocked'
      AND ref->>'domain' = '$UPSTREAM_HOST' AND ref->>'thread_id' = '${e_thread:-none}'")"
  contains "the member asked for access from the thread (pending)" '^request=201:pending$' "$first"
  e_request=$(printf '%s\n' "$first" | sed -n 's/^request_id=//p')
  contains "the team admin sees the request (domain + thread metadata)" "\"thread_id\":\"${e_thread:-none}\"" \
    "$(as_owner "GET /v1/team/egress/requests")"
  # (as_owner prints the first 400 characters of each answer.)
  contains "the team admin approves the request" '^200 \{"request":\{.*"status":"approved"' \
    "$(as_owner "POST /v1/team/egress/requests/${e_request:-none} {\"decision\":\"approve\"}")"
  contains "the approval enabled the domain for the team" '^1$' \
    "$(psql_kobe "SELECT count(*) FROM team_egress WHERE team_id = '$E2E_TEAM_ID' AND domain = '$UPSTREAM_HOST'")"
  # A first run that never ended still holds the thread: the second would only queue behind it
  # and wait out another stream timeout (KOBE-415). Stop it so the second runs.
  e_first_run=$(printf '%s\n' "$first" | sed -n 's/^run=//p')
  if ! grep -q '^terminal=run.completed$' <<<"$first" && [[ -n "$e_first_run" ]]; then
    printf '     blocked run: cancelled before the retry: %s\n' \
      "$(as_owner "POST /v1/runs/$e_first_run/cancel" | cut -c1-120)"
  fi
  second=$(egress_chat "$tool" "${e_thread:-}")
  printf '     after approval: %s\n' "$(printf '%s' "$second" | tr '\n' ' ' | cut -c1-400)"
  contains "the same tool succeeds after the approval (Gate 2)" '^text=.*s_server' "$second"
  contains "request access is audited (created, decided)" '^egress.request.created,egress.request.decided$' \
    "$(psql_kobe "SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action LIKE 'egress.request.%'")"

  # Header injection: the team admin sets a header for the (now enabled) upstream.
  contains "a team admin sets an injected header (write-only)" '^200 .*"header_names":\["X-E2E-Key"\]' \
    "$(as_owner "PUT /v1/team/egress/domains/$UPSTREAM_HOST/headers {\"headers\":[{\"name\":\"X-E2E-Key\",\"value\":\"e2e-header-secret-value\"}]}")"
  if ! as_owner "GET /v1/team/egress" | grep -q 'e2e-header-secret-value'; then ok "the header value is never returned by the API"
  else fail "the header value is never returned by the API"; fi
  if [[ -n "${EGRESS_CLIENT:-}" ]]; then
    h_token=$(mint kobe.egress-proxy)
    h_proxy="http://kobe:$h_token@egress-proxy.kobe.internal:80"
    hdr=$($KUBECTL -n "$TEAM_NS" exec "$EGRESS_CLIENT" -c client -- sh -c "
      for i in \$(seq 1 20); do
        c=\$(curl -sk -m 10 -o /dev/null -w '%{http_connect}' -x '$h_proxy' https://$UPSTREAM_HOST/)
        [ \"\$c\" = 403 ] && break; sleep 1
      done; echo connect=\$c
      curl -s -m 20 -o /dev/null -w 'upgrade=%{http_code}\n' -x '$h_proxy' http://$UPSTREAM_HOST/" 2>&1 || true)
    contains "CONNECT to a header-injected domain is refused (use http://)" '^connect=403$' "$hdr"
    contains "the plain-HTTP upgrade verifies the upstream certificate (self-signed: refused, 502)" '^upgrade=502$' "$hdr"
  else
    fail "header injection checks need the egress client pod (KOBE-38 section)"
  fi
  contains "header changes are audited by name only" '^1$' \
    "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'egress.header.set'
      AND target->'headerNames' = '[\"X-E2E-Key\"]' AND target::text NOT LIKE '%e2e-header-secret-value%'")"
  contains "the header value is stored sealed (never in clear)" '^0$' \
    "$(psql_kobe "SELECT count(*) FROM team_egress WHERE headers_sealed LIKE '%e2e-header-secret-value%'")"
  expect "the team admin removes the header" '^204 ' \
    "$(as_owner "DELETE /v1/team/egress/domains/$UPSTREAM_HOST/headers")"
elif [[ "${CI:-}" == "true" ]]; then
  fail "request access checks need KOBE_SANDBOX_IMAGE and the egress and model sections"
else
  echo "SKIP request access checks (KOBE_SANDBOX_IMAGE not set)"
fi

