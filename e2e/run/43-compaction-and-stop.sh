# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
    # KOBE-213 (CE15): Compact now on the Owner's real sandbox and real Pi. A turn larger than
    # Pi's keepRecentTokens (20k) gives Pi something to fold; the fake model writes the summary,
    # billed to the compaction run (its token reaches Pi without a prompt: session_before_compact).
    echo "==> compaction (KOBE-213)"
    compact_thread=$(printf '%s\n' "$chat_out" | sed -n 's/^thread_id=//p')
    # ~100k characters in 50 long words: over the 20k-token window by Pi's estimate (chars / 4), yet
    # only ~50 streamed chunks (the fake model streams word by word), so the turn and the summary
    # calls stay quick under gVisor.
    big_word=$(printf 'a%.0s' $(seq 1 1990))
    big_msg="big:"
    for _ in $(seq 1 50); do big_msg+=" $big_word"; done
    # The echoed text is left out of what is matched (grep -q on it would end the pipe early).
    big_out=$(chat_run "$big_msg" 300000 "" "" "${compact_thread:-none}" | grep -v '^text=' || true)
    contains "a large turn on the same thread completed" '^terminal=run.completed$' "$big_out"
    read -r -d '' COMPACT_JS <<'JS' || true
const [team, threadId] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KAIJU_PUBLIC_URL).origin;
const jar = new Map();
const headers = () => ({ origin, "content-type": "application/json", "x-kaiju-team": team,
  cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") });
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
};
const out = (k, v) => console.log(k + "=" + v);
let login;
for (let i = 0; i < 4; i++) {
  login = await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
  if (login.status !== 429) break;
  await new Promise((r) => setTimeout(r, 11000));
}
out("signin", login.status);
out("active_team", (await call("PUT", "/v1/me/teams/active", { teamId: team })).status);
const focus = "keep the e2e numbers";
// The answer waits for Pi (up to the server's 12 min command deadline): node:http, not fetch,
// whose headers timeout (5 min) would end it first.
const { request } = await import("node:http");
const longPost = (path, body) => new Promise((resolve, reject) => {
  const req = request(base + path, { method: "POST", headers: headers(), timeout: 0 }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (d) => (text += d));
    res.on("end", () => { let json = {}; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
  });
  req.on("error", reject);
  req.end(JSON.stringify(body));
});
const compacted = await longPost("/v1/threads/" + threadId + "/compact", { focus });
out("compact", compacted.status);
out("compact_code", compacted.json.code ?? "-");
out("summary_by_model", (compacted.json.summary ?? "").includes("fake-openai:") ? "yes" : "no");
out("focus_in_summary", (compacted.json.summary ?? "").includes(focus) ? "yes" : "no");
const entries = await call("GET", "/v1/threads/" + threadId + "/entries?limit=500");
out("entry", (entries.json.entries ?? []).some((e) => e.type === "compaction") ? "compaction" : "none");
const again = await call("POST", "/v1/threads/" + threadId + "/compact", {});
out("again", again.status + ":" + (again.json.code ?? "-"));
JS
    compact_out=$($KUBECTL -n "$NS" exec deploy/kaiju-server -c server -- node --input-type=module -e "$COMPACT_JS" "$E2E_TEAM_ID" "${compact_thread:-none}" 2>&1 | grep -E '^(signin|active_team|compact|compact_code|summary_by_model|focus_in_summary|entry|again)=' || true)
    printf '     compact: %s\n' "$(printf '%s' "$compact_out" | tr '\n' ' ')"
    if ! grep -q '^compact=200$' <<<"$compact_out"; then
      # Diagnostics: what the server and the Owner's sandbox said about the compaction.
      $KUBECTL -n "$NS" logs deploy/kaiju-server -c server --since=20m 2>/dev/null | grep -iE 'compact' | tail -20 || true
      $KUBECTL -n "$TEAM_NS" logs "${owner_pod:-pod/none}" -c agent --since=20m 2>/dev/null | grep -iE 'compact|refused' | tail -20 || true
    fi
    contains "the compaction check signed in and chose the team" '^active_team=200$' "$compact_out"
    contains "Compact now answered 200" '^compact=200$' "$compact_out"
    contains "Pi wrote the summary with the conversation's model (the fake model's answer)" '^summary_by_model=yes$' "$compact_out"
    contains "the focus reached Pi's summary prompt" '^focus_in_summary=yes$' "$compact_out"
    contains "the compaction entry is mirrored into the thread" '^entry=compaction$' "$compact_out"
    contains "compacting again right away has nothing to compact (409)" '^again=409:nothing_to_compact$' "$compact_out"
    compact_usage() { psql_kaiju "SELECT count(*) FROM run_usage u JOIN runs r ON r.team_id = u.team_id AND r.id = u.run_id WHERE u.team_id = '$E2E_TEAM_ID' AND r.thread_id = '${compact_thread:-00000000-0000-4000-8000-000000000000}' AND r.kind = 'compaction' AND r.status = 'completed'"; }
    contains "the summary call is billed to the completed compaction run" '^[1-9][0-9]*$' "$(wait_for 30 '^[1-9]' compact_usage)"

    # KOBE-290: Stop before the first token on real Pi. The fake model holds back its answer to a
    # `kaiju-slow-start` prompt, so the run is stopped once Pi has the prompt (the server mirrors it
    # when Pi announces it) and before any text. A reload then shows the prompt once.
    echo "==> Stop before the first token (KOBE-290)"
    read -r -d '' STOP_EARLY_JS <<'JS' || true
const [team, content] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KAIJU_PUBLIC_URL).origin;
const jar = new Map();
const headers = () => ({ origin, "content-type": "application/json", "x-kaiju-team": team,
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
const thread = await call("POST", "/v1/threads", { title: "kobe-290" });
const id = thread.json.thread_id;
const sent = await call("POST", "/v1/threads/" + id + "/messages", { content });
out("message", sent.status);
const runId = sent.json.run_id;
// Follow the run until Pi's prompt is committed (entry.committed, a user message), counting text.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240000);
let committed = false, deltas = 0;
try {
  const res = await fetch(base + "/v1/runs/" + runId + "/events", { headers: { ...headers(), accept: "text/event-stream" }, signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!committed) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = (block.match(/^event: (.*)$/m) || [])[1];
      let payload = {}; try { payload = JSON.parse((block.match(/^data: (.*)$/m) || [])[1]).payload ?? {}; } catch {}
      if (type === "text.delta") deltas += 1;
      if (type === "entry.committed" && payload.payload?.message?.role === "user") committed = true;
    }
  }
  controller.abort();
} catch (e) { if (!committed) out("stream_error", e.name); }
clearTimeout(timer);
out("committed", committed + ":" + deltas);
out("cancel", (await call("POST", "/v1/runs/" + runId + "/cancel")).json.status);
// Pi settles after the abort; its late frames are refused, the prompt stays.
await new Promise((r) => setTimeout(r, 5000));
const reload = await call("GET", "/v1/threads/" + id);
const entries = reload.json.entries || [];
const prompts = entries.filter((e) => e.payload?.message?.role === "user" && JSON.stringify(e.payload.message.content).includes(content));
out("reload", reload.status + ":" + prompts.length + ":" + (prompts[0]?.entry_id === reload.json.leaf_entry_id));
out("answers", entries.filter((e) => e.payload?.message?.role === "assistant").length);
const run = await call("GET", "/v1/runs/" + runId);
out("run", run.json.status + ":" + (run.json.user_entry_id === prompts[0]?.entry_id));
const markers = await call("GET", "/v1/threads/" + id + "/markers");
out("marker", (markers.json.runs || []).map((r) => r.status + ":" + (r.user_entry_id === prompts[0]?.entry_id)).join(",") || "-");
JS
    stop_early_out=$($KUBECTL -n "$NS" exec deploy/kaiju-server -c server -- node --input-type=module -e "$STOP_EARLY_JS" "$E2E_TEAM_ID" "kaiju-slow-start stop me $RANDOM" 2>&1 || true)
    printf '     stop early: %s\n' "$(tr '\n' ' ' <<<"$stop_early_out")"
    contains "KOBE-290: the prompt is mirrored once Pi has it, before any text" '^committed=true:0$' "$stop_early_out"
    contains "KOBE-290: Stop cancels the run before the first token" '^cancel=cancelled$' "$stop_early_out"
    contains "KOBE-290: after a reload the prompt is there once, as the leaf" '^reload=200:1:true$' "$stop_early_out"
    contains "KOBE-290: the aborted answer of the stopped run is not stored" '^answers=0$' "$stop_early_out"
    contains "KOBE-290: the run is bound to its prompt entry" '^run=cancelled:true$' "$stop_early_out"
    contains "KOBE-290: after a reload the prompt carries a Stopped marker" '^marker=cancelled:true$' "$stop_early_out"

    # KOBE-44: a model chosen for the thread is the run's model (here the vLLM-style custom
    # provider, `qwen`, not the team default); once the team disables it, the run fails clearly.
    # (KOBE-40's checks above left qwen disabled: enable it for the team first.)
    expect "the team enables qwen" '^200 ' "$(as_owner "PUT /v1/team/models/qwen {\"enabled\":true}")"
    chosen_out=$(chat_run "hello-qwen-$RANDOM" 300000 qwen)
    # The user decided this check is non-blocking: right after the enable a run may fail
    # model_not_enabled for a while (possibly provider-side); retry for about 60 s, then warn.
    chosen_end=$((SECONDS + 60))
    while grep -q '^code=model_not_enabled$' <<<"$chosen_out" && ((SECONDS < chosen_end)); do
      sleep 5
      chosen_out=$(chat_run "hello-qwen-$RANDOM" 300000 qwen)
    done
    printf '     chat (thread model): %s\n' "$(printf '%s' "$chosen_out" | grep -v '^text=' | tr '\n' ' ')"
    contains "a thread created with a chosen model stores it (KOBE-44)" '^thread=201:qwen$' "$chosen_out"
    contains "the run started on the thread's model, not the team default" '^started_model=qwen$' "$chosen_out"
    if grep -q '^code=model_not_enabled$' <<<"$chosen_out"; then
      echo "WARN model enable slow, provider-side (the thread's model answered model_not_enabled for 60 s)"
    else
      contains "and was answered through that model's provider" '^terminal=run.completed$' "$chosen_out"
    fi
    expect "the team disables the thread's model" '^200 ' "$(as_owner "PUT /v1/team/models/qwen {\"enabled\":false}")"
    gone_out=$(chat_run "gone-$RANDOM" 120000 qwen)
    contains "a thread can't choose a model the team disabled (409)" '^thread=409:default$' "$gone_out"
    as_owner "PUT /v1/team/models/qwen {\"enabled\":true}" >/dev/null

    # A clear failure when the team has no model: the run fails with the server's message, nothing hangs.
    expect "the team disables its models" '^200 ' "$(as_owner "PUT /v1/team/models/fast {\"enabled\":false}")"
    no_model=$(chat_run "no-model-$RANDOM" 180000)
    printf '     chat (no model): %s\n' "$(printf '%s' "$no_model" | grep -v '^text=' | tr '\n' ' ')"
    contains "without a team model the run fails model_not_configured" '^terminal=run.failed$' "$no_model"
    contains "with the server's own message" '^code=model_not_configured$' "$no_model"
    contains "that tells the user what to do" '^error_message=No model is enabled for your team yet' "$no_model"
    as_owner "PUT /v1/team/models/fast {\"enabled\":true,\"is_default\":true}" >/dev/null

    # KOBE-42 / Gate 2: a budget stops a run after its current step. The fake model answers the
    # first call with a bash tool call reporting a 1,000,000-token prompt ($10,000 at these prices),
    # which uses up the team's $1,000 budget, so the run's next model call never starts and the run
    # ends budget_stopped. The budget is above the request's input estimate (Pi's prompt, about
    # $100 at these prices): a request whose input exceeds the budget is refused outright
    # (KOBE-259 budget_below_call).
    budget_setup=$(as_owner \
      "PATCH /v1/site/models/catalog/fast {\"input_usd_per_mtok\":10000,\"output_usd_per_mtok\":10000}" \
      "PUT /v1/team/budgets/team {\"monthly_usd\":1000}")
    expect "the catalog model is priced and the team budget set" '^200 ' "$budget_setup"
    budget_out=$(chat_run "kaiju-tool-step budget-$RANDOM" 300000)
    printf '     chat (budget): %s\n' "$(printf '%s' "$budget_out" | grep -v '^text=' | tr '\n' ' ')"
    budget_run=$(printf '%s\n' "$budget_out" | sed -n 's/^run=//p')
    budget_run_sql="'${budget_run:-00000000-0000-4000-8000-000000000000}'"
    contains "Gate 2: the run ends budget_stopped" '^terminal=run.budget_stopped$' "$budget_out"
    contains "Gate 2: with the budget's message" 'used up' \
      "$(psql_kaiju "SELECT payload->>'message' FROM run_events WHERE run_id = $budget_run_sql AND type = 'run.budget_stopped'")"
    contains "Gate 2: the step in flight finished (its model call is in the ledger)" '^1$' \
      "$(psql_kaiju "SELECT count(*) FROM run_usage WHERE run_id = $budget_run_sql AND status = 200")"
    # Deterministic: the fake model's tool step runs 3 s, and the stop reaches Pi meanwhile.
    contains "Gate 2: the stop reached the run during its step (after_step)" '^after_step$' \
      "$(psql_kaiju "SELECT CASE WHEN EXISTS (SELECT 1 FROM audit_log WHERE action = 'run.budget_stopped' AND target->>'runId' = '${budget_run:-none}') THEN 'after_step' END")"
    contains "Gate 2: no new model call started after the budget was used up" '^1$' \
      "$(psql_kaiju "SELECT count(*) FROM run_usage WHERE run_id = $budget_run_sql")"
    contains "Gate 2: the budget reached is audited once" '^1$' \
      "$(psql_kaiju "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'models.budget.reached'")"
    contains "Gate 2: new runs are refused while the budget is used up" '^message=429$' \
      "$(chat_run "refused-$RANDOM" 60000)"
    restore=$(as_owner \
      "PUT /v1/team/budgets/team {\"monthly_usd\":null}" \
      "PATCH /v1/site/models/catalog/fast {\"input_usd_per_mtok\":null,\"output_usd_per_mtok\":null}")
    expect "the budget and prices are removed again" '^200 ' "$restore"

    # KOBE-89, KOBE-254: the one gallery agent, Kobe, completes a short sample task per built-in
    # skill in the Owner's real sandbox (gVisor, no network). Since KOBE-317 the skills are Kaiju's
    # catalog skills, fetched as bundles into the run's skill store (sk-<runtime hash>),
    # through the fake model: it answers "bash: <command>" with a bash tool call. Kaiju pins no
    # model, so the runs use the team default. The server seeded it at start. Sandbox tools run
    # without approval unless a rule asks (KOBE-37 left one).
    echo "==> gallery agent Kobe (KOBE-89, KOBE-254)"
    psql_kaiju "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team';" >/dev/null
    gallery_id() { psql_kaiju "SELECT id FROM site_agents WHERE scope = 'gallery' AND gallery_key = '$1' AND archived_at IS NULL"; }
    gallery_run() { # key content [timeout-ms] → CHAT_JS output for a thread with that gallery agent
      local id
      id=$(gallery_id "$1")
      if [[ -z "$id" ]]; then echo "gallery_agent=missing:$1"; return; fi
      chat_run "$2" "${3:-300000}" "" "$id"
    }
    gal_dir='cd "${TMPDIR:-/tmp}" && rm -rf g89 && mkdir g89 && cd g89'
    kaiju_dir() { # a Kaiju skill's directory in the run's skill store: its newest approved version
      printf '/run/kaiju-skills/store/sk-%s' "$(psql_kaiju "SELECT v.runtime_hash FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id WHERE s.name = '$1' AND s.publisher = 'kobe' AND v.state = 'approved' ORDER BY v.seq DESC LIMIT 1")"
    }
    contains "Kaiju skills: the eight are Kaiju-published catalog skills, approved (KOBE-317; kobe-guide KOBE-620)" '^8$' \
      "$(psql_kaiju "SELECT count(DISTINCT s.name) FROM registry_skills s JOIN registry_versions v ON v.skill_id = s.id WHERE s.publisher = 'kobe' AND v.state = 'approved'")"
    contains "the gallery holds exactly one agent, Kobe (key kobe)" '^kobe$' \
      "$(psql_kaiju "SELECT string_agg(gallery_key, ',') FROM site_agents WHERE scope = 'gallery' AND archived_at IS NULL")"
    contains "Kaiju asks for every team connector and narrows no tool" '^all:none$' \
      "$(psql_kaiju "SELECT (v.frontmatter->>'connectors') || ':' || coalesce(v.frontmatter->>'tools', 'none') FROM site_agent_versions v JOIN site_agents a ON a.id = v.agent_id AND v.version = a.current_version WHERE a.gallery_key = 'kobe'")"
    g_out=$(gallery_run kobe "hello-kaiju-$RANDOM")
    printf '     gallery kobe: %s\n' "$(printf '%s' "$g_out" | grep -v '^text=' | tr '\n' ' ')"
    contains "Kaiju: a thread with it starts (201, team default model)" '^thread=201:default$' "$g_out"
    contains "Kaiju: the run completed with the expected text" '^text=fake-openai: hello-kaiju-[0-9]+$' "$g_out"
    contains "Kaiju: the thread is pinned to the gallery agent" '^gallery$' \
      "$(psql_kaiju "SELECT agent_scope FROM threads WHERE id = '$(printf '%s\n' "$g_out" | sed -n 's/^thread_id=//p')'")"
    g_out=$(gallery_run kobe "bash: $gal_dir && python $(kaiju_dir data-analysis)/scripts/describe.py $(kaiju_dir data-analysis)/scripts/sample.csv | grep -c 'rows: 6' && python $(kaiju_dir charts)/scripts/chart.py $(kaiju_dir charts)/scripts/sample.csv --kind bar --x region --y amount --agg sum --title t --out c.png >/dev/null && echo chart-bytes \$(wc -c < c.png)")
    printf '     kobe data: %s\n' "$(printf '%s' "$g_out" | tr '\n' ' ' | cut -c1-400)"
    contains "Kaiju data: the run completed" '^terminal=run.completed$' "$g_out"
    contains "Kaiju data: the data-analysis skill profiled the data and the charts skill produced a PNG" \
      '^text=fake-openai: tool said: 1 chart-bytes [0-9]{4,}$' "$g_out"
    # KOBE-123: the agent's prompt reaches Pi (--append-system-prompt) and so the model: the fake
    # model answers "system?" with the system messages it received.
    g_out=$(gallery_run kobe "system?")
    contains "Kaiju: the system-prompt run completes" '^terminal=run.completed$' "$g_out"
    contains "Kaiju: its research guidance (connectors, KOBE-606) reaches the model through Pi's system prompt" \
      '^text=fake-openai: system said: .*Research: for current or outside facts, use a connector tool' "$g_out"
    contains "Kaiju: its published prompt no longer names the retired built-in web search (KOBE-606)" '^0$' \
      "$(psql_kaiju "SELECT count(*) FROM site_agent_versions v JOIN site_agents a ON a.id = v.agent_id AND v.version = a.current_version WHERE a.gallery_key = 'kobe' AND v.prompt ~* 'web_search|web search'")"
    g_out=$(gallery_run kobe "bash: $gal_dir && python $(kaiju_dir docx)/scripts/md_to_docx.py $(kaiju_dir docx)/scripts/sample.md out.docx --title T >/dev/null && python $(kaiju_dir docx)/scripts/docx_text.py out.docx | grep -c 'south | 310.35' && python $(kaiju_dir pdf)/scripts/md_to_pdf.py $(kaiju_dir pdf)/scripts/sample.md out.pdf --title T >/dev/null && test -s out.pdf && echo docx-and-pdf-produced")
    printf '     kobe documents: %s\n' "$(printf '%s' "$g_out" | tr '\n' ' ' | cut -c1-400)"
    contains "Kaiju documents: the docx and pdf skills produced and read back the files offline" \
      '^text=fake-openai: tool said: 1 docx-and-pdf-produced$' "$g_out"
    g_out=$(gallery_run kobe "bash: $gal_dir && python $(kaiju_dir code-review)/scripts/scan.py $(kaiju_dir code-review)/scripts/sample.py | grep -o '[0-9]* finding' | head -1")
    printf '     kobe code: %s\n' "$(printf '%s' "$g_out" | tr '\n' ' ' | cut -c1-400)"
    contains "Kaiju code: the code-review skill scanned the sample" '^text=fake-openai: tool said: 4 finding$' "$g_out"

