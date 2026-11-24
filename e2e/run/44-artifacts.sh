# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
    # KOBE-131 (KOBE-55): a run's fake model calls create_artifact with an HTML page holding an inline
    # script ("tool: <name> <json>"); the artifact is stored, listed, readable and framed under the
    # D-6 headers; update_artifact in the same thread makes version 2.
    echo "==> artifacts (KOBE-131)"
    art_html='<!doctype html><html><body><h1 id=t>Sales</h1><script>document.getElementById("t").textContent="Sales chart"</script></body></html>'
    art_new="${art_html/Sales chart/Sales chart v2}"
    art_out=$(chat_run "tool: create_artifact {\"kind\":\"html\",\"title\":\"Sales chart\",\"content\":\"${art_html//\"/\\\"}\"}" 300000 "" "$(gallery_id kobe)" "" 1)
    printf '     artifact create: %s\n' "$(printf '%s' "$art_out" | tr '\n' ' ' | cut -c1-500)"
    art_thread=$(printf '%s\n' "$art_out" | sed -n 's/^thread_id=//p')
    contains "artifacts: the run completed" '^terminal=run.completed$' "$art_out"
    contains "artifacts: the event stream carried artifact.created (version 1)" \
      '^artifact_events=artifact.created:[0-9a-f-]{36}:v1$' "$art_out"
    art_id=$(printf '%s\n' "$art_out" | sed -n 's/^artifact_events=artifact.created:\([0-9a-f-]*\):v1$/\1/p')
    art_list=$(as_owner "GET /v1/artifacts?thread_id=$art_thread")
    contains "artifacts: GET /v1/artifacts?thread_id= lists it" "^200 .*\"id\":\"${art_id:-none}\".*\"Sales chart\"" "$art_list"
    # as_owner prints the status and the first 400 bytes only; the header and content checks use a
    # dedicated fetch through the server pod.
    art_fetch() { # path → status, then the headers and body (JSON lines) of an owner-authenticated GET
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
        const base = 'http://127.0.0.1:8080', origin = process.env.KAIJU_PUBLIC_URL;
        const h = { origin, 'content-type': 'application/json', 'x-kobe-team': '$E2E_TEAM_ID' };
        let login;
        for (let i = 0; i < 4; i++) { // sign-in is rate limited (3 per 10 s): wait out a 429
          login = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: h,
            body: JSON.stringify({ email: 'owner@e2e.test', password: 'e2e owner password' }) });
          if (login.status !== 429) break;
          await new Promise((r) => setTimeout(r, 11000));
        }
        const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        await fetch(base + '/v1/me/teams/active', { method: 'PUT', headers: { ...h, cookie }, body: JSON.stringify({ teamId: '$E2E_TEAM_ID' }) });
        const res = await fetch(base + process.argv[1], { headers: { ...h, cookie } });
        console.log('status=' + res.status);
        for (const [k, v] of res.headers) console.log('h:' + k + '=' + v);
        console.log('body=' + (await res.text()).replace(/\\n/g, ' '));
      " "$1" 2>&1
    }
    art_content=$(art_fetch "/v1/artifacts/$art_id/versions/1/content")
    contains "artifacts: the content endpoint returns the bytes (inline script included)" \
      'body=<!doctype html>.*<script>document.getElementById\("t"\).textContent="Sales chart"</script>' "$art_content"
    art_frame=$(art_fetch "/v1/artifacts/$art_id/versions/1/frame?team=$E2E_TEAM_ID")
    contains "artifacts: the frame is served (200)" '^status=200$' "$art_frame"
    contains "artifacts: the frame CSP sandboxes scripts without same-origin (D-6)" \
      '^h:content-security-policy=sandbox allow-scripts allow-forms;' "$art_frame"
    contains "artifacts: the frame CSP forbids network access from the page (connect-src none)" \
      "^h:content-security-policy=.*connect-src 'none'" "$art_frame"
    contains "artifacts: the frame sends X-Frame-Options SAMEORIGIN" '^h:x-frame-options=SAMEORIGIN$' "$art_frame"
    art_out=$(chat_run "tool: update_artifact {\"artifact_id\":\"$art_id\",\"content\":\"${art_new//\"/\\\"}\"}" 300000 "" "" "$art_thread" 1)
    printf '     artifact update: %s\n' "$(printf '%s' "$art_out" | tr '\n' ' ' | cut -c1-500)"
    contains "artifacts: the update run completed" '^terminal=run.completed$' "$art_out"
    contains "artifacts: the event stream carried artifact.updated (version 2)" \
      "^artifact_events=artifact.updated:$art_id:v2\$" "$art_out"
    contains "artifacts: GET /v1/artifacts/:id shows two versions" '^2$' \
      "$(art_fetch "/v1/artifacts/$art_id" | sed -n 's/^body=//p' | grep -o '"version":[0-9]*' | sort -u | wc -l | tr -d ' ')"
    contains "artifacts: version 2 holds the revised content" 'Sales chart v2' \
      "$(art_fetch "/v1/artifacts/$art_id/versions/2/content")"

    # KOBE-152 (54f of KOBE-54): Kaiju writes a file in the Owner's sandbox, then the
    # fake model calls share_file; file.shared carries the file, the thread's reader downloads it
    # (attachment, nosniff), another member of the team gets 404, and the file outlives its workspace
    # copy (deleted from the browser API, which is audited).
    echo "==> share_file (KOBE-152)"
    READER_ID=7e2e0000-0000-4000-8000-0000000000f1
    psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$READER_ID', 'E2E reader', 'reader@e2e.test', true) ON CONFLICT DO NOTHING;
      INSERT INTO accounts (user_id, account_id, provider_id, password)
        SELECT '$READER_ID', '$READER_ID', 'credential', password FROM accounts
        WHERE provider_id = 'credential' AND user_id = '$owner_id'
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = '$READER_ID');
      INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$READER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
    file_fetch() { # email path [method] → status, then the headers and body (JSON lines) of that user's request
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
        const base = 'http://127.0.0.1:8080', origin = process.env.KAIJU_PUBLIC_URL;
        const h = { origin, 'content-type': 'application/json', 'x-kobe-team': '$E2E_TEAM_ID' };
        let login;
        for (let i = 0; i < 4; i++) { // sign-in is rate limited (3 per 10 s): wait out a 429
          login = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: h,
            body: JSON.stringify({ email: process.argv[1], password: 'e2e owner password' }) });
          if (login.status !== 429) break;
          await new Promise((r) => setTimeout(r, 11000));
        }
        const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        await fetch(base + '/v1/me/teams/active', { method: 'PUT', headers: { ...h, cookie }, body: JSON.stringify({ teamId: '$E2E_TEAM_ID' }) });
        const res = await fetch(base + process.argv[2], { method: process.argv[3] || 'GET', headers: { ...h, cookie }, body: process.argv[4] || undefined });
        console.log('status=' + res.status);
        for (const [k, v] of res.headers) console.log('h:' + k + '=' + v);
        console.log('body=' + (await res.text()).replace(/\\n/g, ' '));
      " "$1" "$2" "${3:-}" "${4:-}" 2>&1
    }
    share_text="kobe-152 $(date +%s) $RANDOM"
    sf_out=$(chat_run "bash: echo '$share_text' > /workspace/shared-report.txt; exit 0" 300000 "" "$(gallery_id kobe)" "" 1)
    sf_thread=$(printf '%s\n' "$sf_out" | sed -n 's/^thread_id=//p')
    contains "share_file: the run that wrote the file completed" '^terminal=run.completed$' "$sf_out"
    sf_out=$(chat_run "tool: share_file {\"path\":\"shared-report.txt\",\"description\":\"E2E report\"}" 300000 "" "" "$sf_thread" 1)
    printf '     share_file: %s\n' "$(printf '%s' "$sf_out" | tr '\n' ' ' | cut -c1-500)"
    sf_run=$(printf '%s\n' "$sf_out" | sed -n 's/^run=//p')
    if ! grep -Eq '^file_events=[0-9a-f-]{36}:' <<<"$sf_out"; then
      # KOBE-242/266: no file.shared. Say why: the run's policy decisions and approvals, its audit
      # rows, the server's errors and Postgres's own report of any deadlock.
      echo "     share_file: no file.shared; run $sf_run (events, approvals, audit):"
      psql_kobe "SELECT * FROM (
          SELECT 'event ' || seq || ' ' || type || ' ' || left(payload::text, 300) FROM run_events
           WHERE team_id = '$E2E_TEAM_ID' AND run_id = '${sf_run:-00000000-0000-4000-8000-000000000000}'
             AND type NOT LIKE '%.delta' ORDER BY seq) e
        UNION ALL SELECT 'approval ' || tool || ' ' || status || ' ' || coalesce(cause, '-') FROM approvals
           WHERE team_id = '$E2E_TEAM_ID' AND run_id = '${sf_run:-00000000-0000-4000-8000-000000000000}'
        UNION ALL SELECT * FROM (SELECT 'audit ' || action || ' ' || left(target::text, 200) FROM audit_log
           WHERE team_id = '$E2E_TEAM_ID' AND target ->> 'runId' = '${sf_run:-none}' ORDER BY seq) a" \
        | sed 's/^/       /' || true
      $KUBECTL -n "$NS" logs -l app.kubernetes.io/component=server -c server --since=3m --tail=-1 2>&1 \
        | grep -E '"level":(40|50)' | grep -E "policy|lock|approval|deadlock|share" | tail -n 20 \
        | cut -c1-600 | sed 's/^/     server: /' || true
      $KUBECTL -n kobe-deps logs deploy/pg --since=3m 2>&1 | grep -A8 "deadlock detected" | head -n 20 \
        | cut -c1-300 | sed 's/^/     postgres: /' || true
    fi
    if printf '%s' "$sf_out" | grep -q "Policy could not be evaluated"; then
      fail "share_file: the policy check failed with an error (see server/postgres lines above; KOBE-242/266)"
    else ok "share_file: the policy check was decided, not an error"; fi
    contains "share_file: the run completed" '^terminal=run.completed$' "$sf_out"
    contains "share_file: the event stream carried file.shared (id, name, size)" \
      "^file_events=[0-9a-f-]{36}:shared-report.txt:$((${#share_text} + 1))\$" "$sf_out"
    sf_id=$(printf '%s\n' "$sf_out" | sed -n 's/^file_events=\([0-9a-f-]*\):.*/\1/p')
    contains "share_file: the file has a row (kind shared, in the thread)" "^shared\\|$sf_thread\$" \
      "$(psql_kobe "SELECT kind || '|' || thread_id FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${sf_id:-00000000-0000-4000-8000-000000000000}'")"
    sf_dl=$(file_fetch owner@e2e.test "/v1/files/$sf_id/content")
    contains "share_file: the thread's reader downloads the bytes (200)" '^status=200$' "$sf_dl"
    contains "share_file: the body is the file written in the sandbox" "^body=$share_text( |\$)" "$sf_dl"
    contains "share_file: the download is an attachment" '^h:content-disposition=attachment' "$sf_dl"
    contains "share_file: the download is never sniffed" '^h:x-content-type-options=nosniff$' "$sf_dl"
    sf_other=$(file_fetch reader@e2e.test "/v1/files/$sf_id/content")
    contains "share_file: another member of the team cannot read the thread's file (404)" '^status=404$' "$sf_other"
    if printf '%s' "$sf_other" | grep -q "$share_text"; then fail "share_file: the other user saw no bytes"; else ok "share_file: the other user saw no bytes"; fi
    contains "share_file: the browser API deletes the workspace copy (2xx)" '^status=20[0-9]$' \
      "$(file_fetch owner@e2e.test '/v1/workspace/files?path=shared-report.txt' DELETE)"
    contains "share_file: deleting from the browser is audited" '^1$' \
      "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'workspace.file_deleted'" | awk '$1 >= 1 {print 1; exit} {print 0}')"
    contains "share_file: the shared file survives losing its workspace copy (still 200)" '^status=200$' \
      "$(file_fetch owner@e2e.test "/v1/files/$sf_id/content")"

    # KOBE-158 (56f of KOBE-56): memory end to end. The fake model calls remember (personal writes
    # apply at once); memory.updated carries what Undo needs; the panel API restores the prior
    # version or deletes a created doc; then the team switch turns memory off and the next run
    # lists no remember/recall tools and has no memory index in its system prompt ("tools?" and
    # "system?" make the fake model echo both). The switch is turned back on afterwards.
    echo "==> memory (KOBE-158)"
    mem_id=$(date +%s)-$RANDOM
    mem_marker="kobe-158-index-$mem_id"
    mem_put() { # path content → the chat_run output of a remember call (replace mode)
      chat_run "tool: remember {\"scope\":\"user\",\"path\":\"$1\",\"content\":\"$2\"}" 300000 "" "" "" 1
    }
    mem_settings() { file_fetch owner@e2e.test "/v1/memory/settings?level=team" PUT "$1"; }
    contains "memory: the team switch is on" '^status=200$' "$(mem_settings '{"memory_enabled":true,"project_memory_enabled":true}')"
    mem1=$(mem_put "notes/e2e-$mem_id.md" "v1 $mem_id")
    printf '     memory remember 1: %s\n' "$(printf '%s' "$mem1" | grep -E '^(terminal|memory_events|text)=' | tr '\n' ' ' | cut -c1-400)"
    if ! grep -q '^terminal=run.completed$' <<<"$mem1"; then
      # KOBE-415: once this run hung after memory.updated until the 5-minute stream timeout.
      hung_run_report "memory remember 1" "$(printf '%s\n' "$mem1" | sed -n 's/^run=//p')" "$E2E_TEAM_ID"
    fi
    contains "memory: remember completed" '^terminal=run.completed$' "$mem1"
    contains "memory: memory.updated for the created doc has no previous version" \
      "^memory_events=[0-9a-f-]{36}:notes/e2e-$mem_id.md:v1:none\$" "$mem1"
    mem_doc=$(printf '%s\n' "$mem1" | sed -n 's/^memory_events=\([0-9a-f-]*\):.*/\1/p')
    mem2=$(mem_put "notes/e2e-$mem_id.md" "v2 $mem_id")
    contains "memory: the second write names version 1 as the one to restore" \
      "^memory_events=$mem_doc:notes/e2e-$mem_id.md:v2:1\$" "$mem2"
    contains "memory: the panel API shows the new content" "\"content\":\"v2 $mem_id\"" \
      "$(file_fetch owner@e2e.test "/v1/memory/$mem_doc")"
    contains "memory: Undo (restore version 1) is accepted" '^status=200$' \
      "$(file_fetch owner@e2e.test "/v1/memory/$mem_doc/restore" POST '{"version":1}')"
    mem_after=$(file_fetch owner@e2e.test "/v1/memory/$mem_doc")
    contains "memory: Undo restored the prior content" "\"content\":\"v1 $mem_id\"" "$mem_after"
    contains "memory: Undo made a new version, history is kept" '"current_version":3' "$mem_after"
    contains "memory: another member cannot read the personal doc (404)" '^status=404$' \
      "$(file_fetch reader@e2e.test "/v1/memory/$mem_doc")"
    contains "memory: Undo of a created doc (delete) answers 204" '^status=204$' \
      "$(file_fetch owner@e2e.test "/v1/memory/$mem_doc" DELETE)"
    contains "memory: the deleted doc is gone from the panel API (404)" '^status=404$' \
      "$(file_fetch owner@e2e.test "/v1/memory/$mem_doc")"
    mem_put "MEMORY.md" "- $mem_marker" >/dev/null
    mem_on=$(chat_run "tools?" 300000)
    contains "memory on: the run lists remember" '^text=.*tools said: .*remember' "$mem_on"
    contains "memory on: the run lists recall" '^text=.*tools said: .*recall' "$mem_on"
    contains "memory on: the system prompt carries the memory index" "^text=.*$mem_marker" \
      "$(chat_run "system?" 300000)"
    contains "memory: turning memory off is accepted" '^body=.*"memory_enabled":false' \
      "$(mem_settings '{"memory_enabled":false}')"
    contains "memory: the switch persisted (GET)" '^body=.*"memory_enabled":false' \
      "$(file_fetch owner@e2e.test "/v1/memory/settings?level=team")"
    mem_off=$(chat_run "tools?" 300000)
    contains "memory off: the next run completed" '^terminal=run.completed$' "$mem_off"
    contains "memory off: the run answered with its tool list" '^text=.*tools said: ' "$mem_off"
    if printf '%s' "$mem_off" | grep -qE '^text=.*(remember|recall)'; then fail "memory off: the run lists no remember or recall"; else ok "memory off: the run lists no remember or recall"; fi
    mem_off_sys=$(chat_run "system?" 300000)
    contains "memory off: the system prompt answered" '^text=.*system said: ' "$mem_off_sys"
    if printf '%s' "$mem_off_sys" | grep -q "$mem_marker"; then fail "memory off: the system prompt has no memory index"; else ok "memory off: the system prompt has no memory index"; fi
    contains "memory off: the panel API refuses with memory_disabled (403)" '^status=403$' \
      "$(file_fetch owner@e2e.test "/v1/memory?scope=user")"
    contains "memory: turning memory back on is accepted" '^body=.*"memory_enabled":true' \
      "$(mem_settings '{"memory_enabled":true}')"
    contains "memory back on: the next run lists remember again" '^text=.*tools said: .*remember' \
      "$(chat_run "tools?" 300000)"

