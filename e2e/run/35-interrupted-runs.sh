# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# Throwaway clusters only: this section mints sandbox-wire tokens with the site's real keys.
# KOBE-26 (Gate 1: "killing a sandbox mid-run yields interrupted + Retry and history survives").
# No model answers in e2e yet (KOBE-40/41), so real Pi cannot be mid-run: a scripted agent holds
# the owner's sandbox identity (a live claim + a wire token minted with the real keys) from a
# gVisor pod in the team namespace, speaks the real wire frames, starts the run, streams and
# mirrors partial progress, and is then killed with its pod. The server must notice the lost
# connection, interrupt the run after the grace period, hold the thread, keep the entries, and
# accept Retry.
echo "==> interrupted runs and Retry (KOBE-26)"
owner_handle=$( (ensure_sandbox "$E2E_TEAM_ID" e2e "$owner_id" || true) | tail -1)
owner_sandbox=$(json_field sandboxId "$owner_handle")
contains "the owner gets a (user, team) sandbox claim" '^[0-9a-f-]{36}$' "${owner_sandbox:-$owner_handle}"
# Only the scripted agent may hold this identity: suspend the claim's own Sandbox (its pod goes,
# the claim stays live), so no real agent connects in its place (not asserted).
owner_sbx=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
if [[ -n "$owner_sbx" ]]; then
  $KUBECTL -n "$TEAM_NS" patch sandbox "$owner_sbx" --type merge -p '{"spec":{"operatingMode":"Suspended"}}' >/dev/null 2>&1 || true
fi
owner_token=$(mint kobe.sandbox-wire "${owner_sandbox:-none}" "$owner_id")
read -r -d '' AGENT_JS <<'JS' || true
const { default: WebSocket } = await import("/app/node_modules/ws/wrapper.mjs");
const { randomBytes } = await import("node:crypto");
const { KAIJU_WIRE_URL: url, KAIJU_WIRE_TOKEN: token, KAIJU_SANDBOX_ID: sandboxId } = process.env;
const log = (line) => console.log(line);
const hex = () => randomBytes(4).toString("hex");
const sessions = new Map();
const seqs = new Map();
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
for (let i = 0; i < 180 && !ws; i += 1) { // the CNI admits a new pod after a delay
  ws = await open();
  if (!ws) await new Promise((r) => setTimeout(r, 1000));
}
if (!ws) { log("connect=failed"); process.exit(1); }
const send = (frame) => ws.send(JSON.stringify({ v: 1, ...frame }));
const ok = (command_id, data) =>
  send({ type: "command.result", command_id, ok: true, ...(data === undefined ? {} : { data }) });
const event = (start, ev) => {
  const seq = (seqs.get(start.run_id) ?? 0) + 1;
  seqs.set(start.run_id, seq);
  send({ type: "pi.event", run_id: start.run_id, thread_id: start.thread_id, seq, event: ev });
};
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
ws.on("close", (code) => { log("closed=" + code); process.exit(0); });
ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.type === "hello.ack") log("ready");
  else if (f.type === "ping") send({ type: "pong", nonce: f.nonce });
  else if (f.type === "ack") { if (f.seq >= (seqs.get(f.run_id) ?? 0)) log("acked=" + f.run_id); }
  else if (f.type === "pi.command" && f.command.type === "get_entries") {
    const s = sessions.get(f.thread_id) ?? [];
    const since = f.command.since;
    const at = since === undefined ? -1 : s.findIndex((e) => e.id === since);
    if (since !== undefined && at < 0) {
      send({ type: "command.result", command_id: f.command_id, ok: false, error: { code: "pi_rejected", message: "Entry not found" } });
    } else ok(f.command_id, { entries: s.slice(at + 1), leafId: s.at(-1)?.id ?? null });
  } else if (f.type === "run.start") {
    ok(f.command_id);
    // Like Pi: a settings entry at the root, the prompt, then a partial answer (turn_end) — and
    // no agent_settled: the run is still going when the pod dies.
    const now = new Date().toISOString();
    const s = sessions.get(f.thread_id) ?? [];
    if (s.length === 0) {
      s.push({ type: "thinking_level_change", id: hex(), parentId: null, timestamp: now, thinkingLevel: "off" });
      log("root=" + s[0].id);
    }
    const user = { type: "message", id: hex(), parentId: f.parent_entry_id ?? s.at(-1).id, timestamp: now, message: { role: "user", content: f.message } };
    const answer = { type: "message", id: hex(), parentId: user.id, timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] } };
    sessions.set(f.thread_id, [...s, user, answer]);
    event(f, { type: "agent_start" });
    event(f, { type: "message_start", message: { role: "assistant" } });
    for (const delta of ["Work", "ing on", " it"]) {
      event(f, { type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    }
    event(f, { type: "message_end", message: { role: "assistant" } });
    event(f, { type: "turn_end", message: { role: "assistant" } });
    log("started=" + f.run_id);
  } else if (typeof f.command_id === "string") ok(f.command_id);
});
send({ type: "hello", sandbox_id: sandboxId, agent_version: "e2e-scripted", pi_version: "1.4.0", runs: [] });
JS
agent_script=$(printf '%s\n' "$AGENT_JS" | sed 's/^/          /')
PODS+=("-n $TEAM_NS e2e-agent")
$KUBECTL apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: e2e-agent, namespace: $TEAM_NS }
spec:
  restartPolicy: Never
  runtimeClassName: gvisor
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: agent
      image: ghcr.io/splittingatom/kaiju-server:$TAG
      imagePullPolicy: IfNotPresent
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }
      env:
        - { name: KAIJU_WIRE_URL, value: "ws://$server_ip:8081/v1/sandbox/connect" }
        - { name: KAIJU_WIRE_TOKEN, value: "$owner_token" }
        - { name: KAIJU_SANDBOX_ID, value: "${owner_sandbox:-none}" }
      command: ["node", "--input-type=module", "-e"]
      args:
        - |
$agent_script
EOF
agent_logs() { $KUBECTL -n "$TEAM_NS" logs e2e-agent 2>&1; }
contains "the scripted agent connects as the owner's sandbox" '^ready$' "$(wait_for 240 '^(ready|closed=.*|refused=.*|connect=failed)$' agent_logs)"
read -r -d '' API_JS <<'JS' || true
const [team, ...args] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KAIJU_PUBLIC_URL).origin;
const jar = new Map();
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { origin, "content-type": "application/json", "x-kaiju-team": team,
      cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const out = (k, v) => console.log(k + "=" + v);
await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
await call("PUT", "/v1/me/teams/active", { teamId: team });
const entryIds = async (id) => ((await call("GET", "/v1/threads/" + id)).json.entries ?? []).map((e) => e.entry_id).join(",");
JS
read -r -d '' START_JS <<'JS' || true
const thread = await call("POST", "/v1/threads", { title: "e2e interrupted" });
out("thread", thread.json.thread_id);
const msg = await call("POST", "/v1/threads/" + thread.json.thread_id + "/messages", { content: "e2e: a long job" });
out("message", msg.status + ":" + msg.json.queued);
out("run", msg.json.run_id);
JS
api() { # script [args...] → key=value lines from the owner's API calls inside the server pod
  local script="$1"
  shift
  $KUBECTL -n "$NS" exec deploy/kaiju-server -c server -- node --input-type=module -e "$API_JS
$script" "$E2E_TEAM_ID" "$@" 2>&1 | grep -E '^[a-z_]+=' || true
}
start_out=$(api "$START_JS")
i_thread=$(printf '%s\n' "$start_out" | sed -n 's/^thread=//p')
i_run=$(printf '%s\n' "$start_out" | sed -n 's/^run=//p')
contains "a message starts a run on the owner's sandbox" '^message=201:false$' "$start_out"
contains "the sandbox receives run.start and streams partial progress" "^acked=${i_run:-none}$" \
  "$(wait_for 120 "^(acked=${i_run:-none}|closed=.*)$" agent_logs)"
entries_sql="SELECT string_agg(entry_id, ',' ORDER BY seq) FROM thread_entries WHERE thread_id = '${i_thread:-00000000-0000-4000-8000-000000000000}'"
mirrored() { psql_kaiju "SELECT count(*) FROM thread_entries WHERE thread_id = '${i_thread:-00000000-0000-4000-8000-000000000000}'"; }
contains "the partial answer is mirrored into thread_entries (root, prompt, answer)" '^3$' "$(wait_for 60 '^3$' mirrored)"
entries_before=$(psql_kaiju "$entries_sql")
root_entry=$(agent_logs | sed -n 's/^root=//p' | head -1)
run_status() { psql_kaiju "SELECT status FROM runs WHERE id = '${i_run:-00000000-0000-4000-8000-000000000000}'"; }
contains "the run is running before the kill" '^running$' "$(run_status)"
# Kill the sandbox mid-run: its pod is deleted (SIGTERM, then SIGKILL after 1 s).
killed_at=$SECONDS
$KUBECTL -n "$TEAM_NS" delete pod e2e-agent --grace-period=1 --wait=true >/dev/null 2>&1 || true
# Lost connection → 30 s grace → the next sweep (10 s, jittered) interrupts it; allow 240 s.
status_after=$(wait_for 240 '^(interrupted|completed|failed|cancelled)$' run_status)
printf '     interrupted after %ss\n' "$((SECONDS - killed_at))"
contains "killing the sandbox mid-run interrupts the run" '^interrupted$' "$status_after"
contains "the thread is interrupted (its queue is held)" '^interrupted$' \
  "$(psql_kaiju "SELECT status FROM threads WHERE id = '${i_thread:-00000000-0000-4000-8000-000000000000}'")"
contains "the interruption is audited (sandbox gone)" '^sandbox_gone$' \
  "$(psql_kaiju "SELECT target->>'cause' FROM audit_log WHERE action = 'run.interrupted' AND target->>'runId' = '${i_run:-none}'")"
read -r -d '' RETRY_JS <<'JS' || true
const [threadId, runId] = args;
const before = await entryIds(threadId);
const detail = await call("GET", "/v1/threads/" + threadId);
out("thread_status", detail.json.status);
const runs = await call("GET", "/v1/threads/" + threadId + "/runs");
out("interrupted_run", runs.json.interrupted_run?.run_id === runId ? "this" : JSON.stringify(runs.json.interrupted_run));
const events = await call("GET", "/v1/runs/" + runId + "/events");
out("events", (events.text.match(/^event: .*$/gm) || []).map((l) => l.slice(7)).filter((t) => t.startsWith("run.")).join(","));
out("interrupted_payload", /"reason":"sandbox_lost"/.test(events.text) && /"retryable":true/.test(events.text));
const retry = await call("POST", "/v1/runs/" + runId + "/retry");
out("retry", retry.status + ":" + retry.json.queued);
const again = await call("POST", "/v1/runs/" + runId + "/retry");
out("retry_again", again.json.run_id === retry.json.run_id ? "same" : again.status + ":" + again.json.code);
const snap = await call("GET", "/v1/runs/" + retry.json.run_id);
out("retry_run", snap.json.status + ":" + (snap.json.retry_of_run_id === runId));
out("retry_id", retry.json.run_id);
const after = await entryIds(threadId);
out("history", before !== "" && after.startsWith(before) ? "intact" : before + " -> " + after);
out("cancel_retry", (await call("POST", "/v1/runs/" + retry.json.run_id + "/cancel")).json.status);
JS
retry_out=$(api "$RETRY_JS" "${i_thread:-none}" "${i_run:-none}")
printf '     retry: %s\n' "$(printf '%s' "$retry_out" | tr '\n' ' ')"
contains "the API shows the thread interrupted" '^thread_status=interrupted$' "$retry_out"
contains "the thread's runs name the run to retry (survives a reload)" '^interrupted_run=this$' "$retry_out"
contains "the event stream ends with run.interrupted" '^events=run.started,run.interrupted$' "$retry_out"
contains "run.interrupted says sandbox_lost, retryable" '^interrupted_payload=true$' "$retry_out"
contains "Retry starts a new run at once" '^retry=201:false$' "$retry_out"
contains "Retry is once per run (a repeat returns the same retry)" '^retry_again=same$' "$retry_out"
contains "the retry run links the interrupted run" '^retry_run=running:true$' "$retry_out"
contains "history survives the kill and the retry" '^history=intact$' "$retry_out"
retry_id=$(printf '%s\n' "$retry_out" | sed -n 's/^retry_id=//p')
contains "the retry branches beside the interrupted prompt (from the root entry)" "^${root_entry:-none}$" \
  "$(psql_kaiju "SELECT parent_entry_id FROM runs WHERE id = '${retry_id:-00000000-0000-4000-8000-000000000000}'")"
contains "every entry from before the kill is still in Postgres" "^${entries_before:-none}" "$(psql_kaiju "$entries_sql")"
contains "the retry can still be stopped" '^cancel_retry=cancelled$' "$retry_out"

