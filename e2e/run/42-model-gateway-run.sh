# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
    # KOBE-41: the working path. The Owner (a team member with a real sandbox, suspended since
    # the interrupted-run story) sends a message: the sandbox wakes, kobe-sandbox-agent trades its
    # bootstrap token, Pi starts with kobe-models, calls the team's default model through the
    # model-gateway shim with the sandbox's session token and the run id, Bifrost attaches the
    # provider key, and the fake model's answer streams back to the API as text.delta events.
    echo "==> Pi model wiring (KOBE-41)"
    as_owner "PUT /v1/team/models/fast {\"enabled\":true,\"is_default\":true}" >/dev/null
    # The scripted agents above held the Owner's sandbox identity; the message below must reach
    # the Owner's REAL sandbox (woken by the router), so wait until their connections are gone.
    $KUBECTL -n "$TEAM_NS" delete pod e2e-agent e2e-approver --ignore-not-found --wait=true >/dev/null 2>&1 || true
    owner_closed() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$owner_id' AND closed_at IS NULL")" == 0 ]]; }
    if until_ok 180 owner_closed; then ok "no scripted agent holds the Owner's sandbox identity any more"
    else fail "no scripted agent holds the Owner's sandbox identity any more"; fi
    read -r -d '' CHAT_JS <<'JS' || true
const [team, content, timeoutMs, model, agentId, reuseThread, approveAll, fileIds, projectId, mentions] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KAIJU_PUBLIC_URL).origin;
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
out("signin", login.status);
await call("PUT", "/v1/me/teams/active", { teamId: team });
// KOBE-44: an optional model chosen for the thread (an alias the team enabled).
// KOBE-89: an optional agent (a gallery agent's id) to chat with.
// KOBE-131: an optional existing thread to continue (an artifact update must stay in its thread).
const thread = reuseThread ? { status: 200, json: { thread_id: reuseThread } } : await call("POST", "/v1/threads", { title: "kobe-41", ...(model ? { model } : {}), ...(agentId ? { agent_id: agentId } : {}), ...(projectId ? { project_id: projectId } : {}) });
out("thread", thread.status + ":" + (thread.json.model ?? "default"));
out("thread_id", thread.json.thread_id ?? "-");
const t0 = Date.now();
// KOBE-223: optional @file mentions (comma-separated workspace paths picked with @).
const sent = await call("POST", "/v1/threads/" + thread.json.thread_id + "/messages", { content, ...(fileIds ? { file_ids: fileIds.split(",") } : {}), ...(mentions ? { mentions: mentions.split(",") } : {}) });
out("message", sent.status);
const runId = sent.json.run_id;
out("run", runId);
// KOBE-131: artifact writes are approval-gated in ask-on-write (D23/D29): allow what the run asks.
const approvals = approveAll ? setInterval(async () => {
  const list = await call("GET", "/v1/approvals?status=pending&run_id=" + runId);
  for (const a of list.json.approvals || []) await call("POST", "/v1/approvals/" + a.approval_id, { decision: "allow" });
}, 1000) : undefined;
// Follow the run's event stream until a terminal event (the sandbox may have to wake first).
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
const artifactEvents = [];
const fileEvents = []; // KOBE-152: file.shared as id:name:size
const memoryEvents = []; // KOBE-158: memory.updated as doc:path:vN:previous
let text = "", terminal = "none", code = "-", errorMessage = "-", first = null, waking = "-", startedModel = "-";
try {
  const res = await fetch(base + "/v1/runs/" + runId + "/events", { headers: { ...headers(), accept: "text/event-stream" }, signal: controller.signal });
  out("stream", res.status);
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
      if (type === "sandbox.waking") waking = payload.reason;
      if (type === "run.started") startedModel = payload.model ?? "-";
      if (type === "artifact.created" || type === "artifact.updated") artifactEvents.push(type + ":" + payload.artifact_id + ":v" + (payload.version ?? "?"));
      if (type === "file.shared") fileEvents.push(payload.file_id + ":" + payload.name + ":" + payload.size);
      if (type === "memory.updated") memoryEvents.push(payload.memory_doc_id + ":" + payload.path + ":v" + payload.version + ":" + (payload.previous_version ?? "none"));
      if (type === "text.delta") { if (first === null) first = Date.now() - t0; text += payload.delta ?? ""; }
      if (type === "run.completed" || type === "run.failed" || type === "run.interrupted" || type === "run.budget_stopped") {
        terminal = type;
        code = payload.error?.code ?? "-";
        errorMessage = payload.error?.message ?? "-";
      }
    }
  }
} catch (e) { out("stream_error", e.name); }
clearTimeout(timer);
if (approvals) clearInterval(approvals);
out("waking", waking);
out("started_model", startedModel);
out("first_token_ms", first ?? "-");
out("terminal_ms", Date.now() - t0);
out("artifact_events", artifactEvents.join(",") || "-");
out("file_events", fileEvents.join(",") || "-");
out("memory_events", memoryEvents.join(",") || "-");
out("terminal", terminal);
out("code", code);
out("error_message", errorMessage);
out("text", text);
JS
    chat_run() { # content timeout-ms [model] [agent-id] [thread-id] [approve-all] [file-ids] → the CHAT_JS output (not `chat`: KOBE-40's helper above)
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "$CHAT_JS" "$E2E_TEAM_ID" "$1" "$2" "${3:-}" "${4:-}" "${5:-}" "${6:-}" "${7:-}" "${CHAT_PROJECT:-}" "${CHAT_MENTIONS:-}" 2>&1 | tail -17
    }
    chat_out=$(chat_run "hello-pi-$RANDOM" 300000)
    printf '     chat: %s\n' "$(printf '%s' "$chat_out" | grep -v '^text=' | tr '\n' ' ')"
    chat_run=$(printf '%s\n' "$chat_out" | sed -n 's/^run=//p')
    contains "a message starts a run (201)" '^message=201$' "$chat_out"
    contains "the run completed with the fake model's streamed answer (Pi → shim → Bifrost → upstream)" \
      '^text=fake-openai: hello-pi-[0-9]+$' "$chat_out"
    contains "the run ended run.completed" '^terminal=run.completed$' "$chat_out"
    contains "the woken sandbox produced a first token" '^first_token_ms=[0-9]+$' "$chat_out"
    contains "the shim attributed the model call to the run (x-kobe-run-id from Pi)" "\"runId\":\"$chat_run\"" \
      "$($KUBECTL -n "$NS" logs -l app.kubernetes.io/component=model-gateway --tail=-1 --since=15m 2>/dev/null | grep -F "\"runId\":\"${chat_run:-none}\"" | head -1)"
    # KOBE-43: the shim wrote the call to the run_usage ledger from the upstream's usage report.
    usage_row() { psql_kobe "SELECT status || '|' || usage_source || '|' || input_tokens || '|' || output_tokens FROM run_usage WHERE team_id = '$E2E_TEAM_ID' AND run_id = '${chat_run:-00000000-0000-4000-8000-000000000000}' ORDER BY at LIMIT 1"; }
    contains "the model call is in the run_usage ledger with the provider's reported tokens" \
      '^200\|reported\|[1-9][0-9]*\|[1-9][0-9]*$' "$(wait_for 30 '^200\|' usage_row)"
    contains "the team usage dashboard counts it" '^200 .*"calls":[1-9]' "$(as_owner "GET /v1/team/usage")"
    # KOBE-274: that run is one trace in the OTLP sink: the server's kobe.run root and run.start
    # command span, the sandbox's spans relayed through the server (the sandbox has no collector),
    # and the gateway's model call under a sandbox span; every span in the thread's session, no content.
    echo "==> run traces (KOBE-274)"
    read -r -d '' TRACE_JS <<'JS' || true
const [sink, runId, threadId, userId, waitMs] = process.argv.slice(1);
const hex = runId.replaceAll("-", ""), rootId = hex.slice(16);
const out = (k, v) => console.log(k + "=" + v);
const deadline = Date.now() + Number(waitMs);
let spans = [];
const have = (n) => spans.some((s) => s.name === n);
for (;;) {
  try { spans = await (await fetch(sink + "/spans?trace=" + hex)).json(); } catch { spans = []; }
  if ((have("kobe.run") && have("sandbox.run") && have("model_gateway.request")) || Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 3000));
}
const by = (n) => spans.filter((s) => s.name === n);
const root = by("kobe.run")[0];
const command = by("sandbox.command").find((s) => s.attributes["kobe.command.kind"] === "run.start");
const run = by("sandbox.run")[0];
// The sandbox's model call; the server's title and follow-up calls (KOBE-234) hang under the root.
const gateways = by("model_gateway.request");
const sandboxIds = new Set(spans.filter((s) => s.service === "kobe-sandbox-agent").map((s) => s.spanId));
const nameOf = new Map(spans.map((s) => [s.spanId, s.name]));
out("spans", spans.length);
out("span_names", spans.map((s) => s.name).sort().join(","));
out("gateway_parents", gateways.map((g) => nameOf.get(g.parentSpanId) ?? (g.parentSpanId ? "unknown" : "none")).join(","));
out("services", [...new Set(spans.map((s) => s.service))].sort().join(","));
out("root", root ? (root.spanId === rootId && !root.parentSpanId ? "ok" : "bad") : "missing");
out("command_under_root", command && command.parentSpanId === rootId ? "ok" : "no");
out("sandbox_run_under_command", run && command && run.parentSpanId === command.spanId ? "ok" : "no");
out("gateway_under_sandbox", gateways.some((g) => sandboxIds.has(g.parentSpanId)) ? "ok" : "no");
const sessioned = spans.filter((s) => ["kobe.run", "sandbox.command", "sandbox.run", "sandbox.turn", "model_gateway.request"].includes(s.name));
out("session", sessioned.length >= 4 && sessioned.every((s) => s.attributes["session.id"] === threadId && s.attributes["user.id"] === userId) ? "ok" : "no");
out("content_keys", spans.flatMap((s) => Object.keys(s.attributes)).filter((k) => /^(gen_ai\.(prompt|completion)|kobe\.tool\.(input|output)|url\.query)/.test(k)).length);
out("emails", JSON.stringify(spans).includes("@e2e.test") ? 1 : 0);
out("names", /"(E2E owner|Owner)"/i.test(JSON.stringify(spans)) ? 1 : 0);
JS
    chat_thread=$(printf '%s\n' "$chat_out" | sed -n 's/^thread_id=//p')
    traces=$($KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "$TRACE_JS" \
      "$OTEL_SINK" "${chat_run:-00000000-0000-4000-8000-000000000000}" "${chat_thread:-none}" "${owner_id:-none}" 120000 2>&1 | tail -14)
    printf '     traces: %s\n' "$(printf '%s' "$traces" | tr '\n' ' ')"
    contains "the run is one trace across server, sandbox agent and model gateway" \
      '^services=kobe-model-gateway,kobe-sandbox-agent,kobe-server$' "$traces"
    contains "the trace has the run's kobe.run root with its fixed id" '^root=ok$' "$traces"
    contains "the server's run.start command span hangs under the root" '^command_under_root=ok$' "$traces"
    contains "the sandbox's run span (relayed through the server) hangs under the command span" \
      '^sandbox_run_under_command=ok$' "$traces"
    contains "the gateway's model call hangs under a sandbox span" '^gateway_under_sandbox=ok$' "$traces"
    contains "every run span carries the thread as session.id and the owner as user.id" '^session=ok$' "$traces"
    contains "no content attribute left the server with capture off" '^content_keys=0$' "$traces"
    contains "no email in any span" '^emails=0$' "$traces"
    contains "no display name in any span" '^names=0$' "$traces"
    # ac-3 at the network level: the sandbox cannot reach the collector at all (NetworkPolicy; it
    # has no DNS, so dial the sink's ClusterIP directly).
    sink_ip=$($KUBECTL -n "$OTEL_NS" get svc otlp -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
    trace_claim=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
    trace_pod=$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${trace_claim:-none}" -o name 2>/dev/null | head -1)
    sink_probe=$($KUBECTL -n "$TEAM_NS" exec "${trace_pod:-pod/none}" -c agent -- node -e "
      const s = require('net').connect({ host: '${sink_ip:-0.0.0.0}', port: 4318, timeout: 3000 });
      s.on('connect', () => { console.log('sink=REACHED'); process.exit(0); });
      s.on('timeout', () => { console.log('sink=BLOCKED'); process.exit(0); });
      s.on('error', () => { console.log('sink=BLOCKED'); process.exit(0); });" 2>&1 || true)
    contains "control: the OTLP sink has a ClusterIP (and took the server's spans above)" '^[0-9a-f.:]+$' "$sink_ip"
    contains "the sandbox cannot reach the OTLP sink (NetworkPolicy)" '^sink=BLOCKED$' "$sink_probe"
    seen_now=$(probe "$NS" "$(answers "$LLM/_seen")")
    contains "the upstream saw the provider key (attached by Bifrost, outside the sandbox)" 'e2e-provider-key' "$seen_now"
    if [[ -n "$seen_now" ]] && ! printf '%s' "$seen_now" | grep -q 'eyJ'; then ok "no session token (JWT) reached the upstream"
    else fail "no session token (JWT) reached the upstream"; fi
    # KOBE-71: the Owner's sandbox just ran Pi for that message, under gVisor. Pi runs under a Pi
    # identity, not as the agent; another identity can neither write nor read that Pi's runtime
    # directory, nor read the bootstrap token, nor signal the agent or that Pi. (`kubectl exec`
    # runs with the agent's uid and groups, so it can use kobe-runas as the agent does; 2015 is an
    # identity no Pi uses while a single thread runs.)
    echo "==> sandbox privilege separation (KOBE-71)"
    read -r -d '' PRIVSEP_SH <<'SH' || true
R=/opt/kobe/bin/kobe-runas
agent=$(pgrep -f '^node .*sandbox-agent/dist/index.js' | head -1)
pi=$(ps -eo pid=,uid= | awk '$2 >= 2000 && $2 <= 2063 { print $1; exit }')  # Pi sets its own process title
dir=$(ls -d /run/kobe-pi/pi-* 2>/dev/null | head -1)
echo "agent=$(stat -c %u /proc/$agent) caps=$(awk '/^CapEff/ {print $2}' /proc/$agent/status)"
echo "pi_uid=$(stat -c %u /proc/$pi) dir=$(stat -c '%U:%G %a' $dir)"
echo "plant=$($R 2015 sh -c "echo {} > $dir/agent/settings.json" 2>&1 | grep -c 'Permission denied')"
echo "read_model=$($R 2015 cat "$dir/model.json" 2>&1 | grep -c 'Permission denied')"
echo "read_token=$($R 2015 cat /run/kobe-agent/bootstrap/bootstrap-token 2>&1 | grep -c 'Permission denied')"
echo "signal=$($R 2015 sh -c "kill -0 $agent; kill -0 $pi" 2>&1 | grep -c 'not permitted')"
# As a tool of that Pi (its own uid): no ptrace/memory of an ancestor, no inspector through
# SIGUSR1, no way back into Pi's stdin/stdout (sockets: /proc/<pi>/fd/N cannot be reopened).
u=$(stat -c %u /proc/$pi)
$R $u --probe-ptrace >/dev/null 2>&1; echo "probe=$?"
$R $u sh -c "kill -USR1 $pi"; sleep 1
echo "inspector=$(node -e 'require("net").connect(9229,"127.0.0.1").on("connect",()=>{console.log("open");process.exit(0)}).on("error",()=>console.log("closed"))')"
echo "stdio=$($R $u sh -c "for n in 0 1; do ( : > /proc/$pi/fd/\$n ); done" 2>&1 | grep -cE 'No such device or address|Permission denied')"
echo "pi_alive=$(kill -0 $pi 2>/dev/null; [ -d /proc/$pi ] && echo yes || echo no)"
# RLIMIT_NPROC (1024 per identity) under gVisor: an identity no thread uses tries 1500 processes;
# it must stop at the limit, and --kill-all (no fork needed) must still clear it.
$R 2014 sh -c 'i=0; while [ $i -lt 1500 ]; do sleep 120 & i=$((i+1)); done' >/dev/null 2>&1
echo "nproc=$(ps -eo uid= | awk '$1 == 2014' | wc -l)"
$R 2014 --kill-all; echo "nproc_kill=$?"
sleep 1; echo "nproc_left=$(ps -eo uid=,stat= | awk '$1 == 2014 && $2 !~ /^Z/' | wc -l)"
SH
    # The Owner's sandbox pod: the one whose claim-uid label is the Owner's claim (u-<user id>).
    owner_claim=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
    owner_pod=$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${owner_claim:-none}" -o name 2>/dev/null | head -1)
    privsep=$($KUBECTL -n "$TEAM_NS" exec "${owner_pod:-pod/none}" -c agent -- sh -c "$PRIVSEP_SH" 2>&1 || true)
    printf '     %s\n' "$privsep"
    contains "the agent runs as uid 1000 with no capabilities" '^agent=1000 caps=0+$' "$privsep"
    contains "Pi runs under a Pi identity, its runtime dir the agent's with Pi's group" \
      '^pi_uid=20[0-9][0-9] dir=kobe:kobe-pi-[0-9]+ 2750$' "$privsep"
    contains "another identity cannot plant a file in that Pi's runtime dir (EACCES)" '^plant=1$' "$privsep"
    contains "another identity cannot read that Pi's model file (token, run id)" '^read_model=1$' "$privsep"
    contains "Pi identities cannot read the agent's bootstrap token" '^read_token=1$' "$privsep"
    contains "Pi identities cannot signal the agent or another thread's Pi" '^signal=2$' "$privsep"
    contains "a tool cannot ptrace or read the memory of its Pi (behavioural probe under gVisor)" '^probe=0$' "$privsep"
    contains "SIGUSR1 from a tool opens no inspector in Pi (node --disable-sigusr1)" '^inspector=closed$' "$privsep"
    contains "a tool cannot reopen its Pi's stdin/stdout through /proc (gVisor: EACCES; Linux: ENXIO)" '^stdio=2$' "$privsep"
    contains "Pi survives the SIGUSR1" '^pi_alive=yes$' "$privsep"
    contains "gVisor enforces an identity's process limit (1500 tried, at most 1024 run)" '^nproc=(10[0-2][0-9]|9[5-9][0-9])$' "$privsep"
    contains "--kill-all clears an identity at its process limit" '^nproc_kill=0$' "$privsep"
    contains "nothing of it is left" '^nproc_left=0$' "$privsep"
    # KOBE-168: with the tool executor on, the isolation and workspace checks of the paired uid.
    if [[ "${KAIJU_E2E_TOOL_EXECUTOR:-}" == 1 ]]; then source e2e/executor/isolation.sh; fi

