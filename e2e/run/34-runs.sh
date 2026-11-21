# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-30: messages and runs through the server API against the in-cluster Postgres. No model or
# agent answers yet, so the run is stopped while its start waits for the (unwoken) sandbox.
echo "==> runs (KOBE-30)"
owner_id=$(psql_kobe "SELECT id FROM users WHERE email = 'owner@e2e.test'")
psql_kobe "INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$owner_id', 'member') ON CONFLICT DO NOTHING;" >/dev/null
read -r -d '' RUNS_JS <<'JS' || true
const [team] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const jar = new Map();
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      "x-kobe-team": team,
      cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
    },
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
out("signin", (await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" })).status);
out("active", (await call("PUT", "/v1/me/teams/active", { teamId: team })).status);
const thread = await call("POST", "/v1/threads", { title: "e2e" });
const id = thread.json.thread_id;
const first = await call("POST", "/v1/threads/" + id + "/messages", { content: "hello" });
out("message", first.status + ":" + first.json.queued);
const second = await call("POST", "/v1/threads/" + id + "/messages", { content: "again" });
out("queued", second.status + ":" + second.json.queued + ":" + second.json.run_id);
out("run", (await call("GET", "/v1/runs/" + first.json.run_id)).json.status);
const pending = await call("GET", "/v1/threads/" + id + "/pending-messages");
out("pending", pending.status + ":" + (pending.json.messages || []).map((m) => m.status + "/" + m.content).join(","));
out("cancel", (await call("POST", "/v1/runs/" + first.json.run_id + "/cancel")).json.status);
out("paused", (await call("GET", "/v1/threads/" + id + "/runs")).json.queue_paused + ":" +
  (await call("GET", "/v1/runs/" + second.json.run_id)).json.status);
out("cancel2", (await call("POST", "/v1/runs/" + second.json.run_id + "/cancel")).json.status);
const events = await call("GET", "/v1/runs/" + first.json.run_id + "/events");
// A leaf-only thread.updated (a commit's leaf move, KOBE-543) is not a title event: left out.
const sse = events.text.split(/\n\n+/).map((block) => ({
  type: (block.match(/^event: (.*)$/m) || [])[1],
  data: (block.match(/^data: (.*)$/m) || [])[1] || "",
}));
const leafOnly = (e) => e.type === "thread.updated" && !/"title":/.test(e.data);
out("events", sse.filter((e) => e.type && !leafOnly(e)).map((e) => e.type).join(","));
out("retry", (await call("POST", "/v1/runs/" + first.json.run_id + "/retry")).json.code);
// KOBE-290: a reload still shows the stopped prompt (Pi never had it: the server keeps it), once;
// the deleted queued message is gone.
const reload = await call("GET", "/v1/threads/" + id);
const said = (text) => (reload.json.entries || []).filter((e) => e.payload?.message?.role === "user" &&
  JSON.stringify(e.payload.message.content).includes(text));
out("reload", reload.status + ":" + said("hello").length + ":" + said("again").length + ":" +
  (said("hello")[0]?.entry_id === reload.json.leaf_entry_id));
JS
runs_out=$($KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "$RUNS_JS" "$E2E_TEAM_ID" 2>&1 | tail -14)
printf '     runs: %s\n' "$(printf '%s' "$runs_out" | tr '\n' ' ')"
contains "a team member signs in and selects the team" '^active=200$' "$runs_out"
contains "a message starts a run at once on an idle thread" '^message=201:false$' "$runs_out"
contains "a second message queues behind the active run" '^queued=201:true:' "$runs_out"
contains "the run is running while its sandbox start is pending" '^run=running$' "$runs_out"
contains "pending messages: the active prompt, then the queue (KOBE-32)" '^pending=200:running/hello,queued/again$' "$runs_out"
contains "Stop cancels the active run" '^cancel=cancelled$' "$runs_out"
contains "Stop pauses the message queued behind it (KOBE-26)" '^paused=true:queued$' "$runs_out"
contains "Stop deletes the queued message (or stops it once it started)" '^cancel2=cancelled$' "$runs_out"
contains "the event stream records the start, the kept prompt and the stop, then ends" '^events=run.started,(sandbox.waking,)?entry.committed,run.interrupted$' "$runs_out"
contains "a cancelled run cannot be retried (interrupted runs only)" '^retry=invalid_transition$' "$runs_out"
contains "KOBE-290: after a reload the stopped prompt is there once, as the leaf; the deleted one is not" '^reload=200:1:0:true$' "$runs_out"

