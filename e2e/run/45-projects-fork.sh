# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
    # KOBE-164 (57f of KOBE-57): projects end to end, as the web UI drives them. The Owner (team
    # admin) creates a project and a second one nobody else is in, adds the reader (role reader,
    # Workspaces PR3: views, lists files, converses; cannot upload, change or manage),
    # uploads a file, and starts a conversation in the project (a real run: the fork copies its
    # entries). Then the thread is shared: the reader sees it read-only (reads, lists, cannot
    # post) and forks it into a private thread of their own; unsharing hides it again; an archived
    # project refuses new files. Non-members get 404 for the project, never 403.
    echo "==> projects (KOBE-164)"
    read -r -d '' PROJECTS_JS <<'JS' || true
const [team, mode, readerEmail, projectArg, threadArg, readerId] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KAIJU_PUBLIC_URL).origin;
const out = (k, v) => console.log(k + "=" + v);
const session = async (email) => {
  const jar = new Map();
  const call = async (method, path, body, form) => {
    const headers = { origin, "x-kaiju-team": team, cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    const text = await res.text();
    let json = {}; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  let login;
  for (let i = 0; i < 4; i++) { // sign-in is rate limited (3 per 10 s): wait out a 429
    login = await call("POST", "/api/auth/sign-in/email", { email, password: "e2e owner password" });
    if (login.status !== 429) break;
    await new Promise((r) => setTimeout(r, 11000));
  }
  await call("PUT", "/v1/me/teams/active", { teamId: team });
  call.login = login.status;
  return call;
};
const owner = await session("owner@e2e.test");
const reader = await session(readerEmail);
const upload = (call, projectId, name, text) => {
  const form = new FormData();
  form.append("path", "docs");
  form.append("file", new Blob([text], { type: "text/plain" }), name);
  return call("POST", "/v1/projects/" + projectId + "/files", undefined, form);
};
const code = (r) => r.status + ":" + (r.json.code ?? "-");
out("signin", owner.login + ":" + reader.login);
if (mode === "setup") {
  const marker = "E2E projects " + Date.now();
  const created = await owner("POST", "/v1/projects", { name: marker, instructions: "Always answer in " + marker, member_user_ids: [] });
  const id = created.json.id;
  out("project_id", id ?? "-");
  out("create", created.status + ":" + created.json.my_role + ":" + ("visibility" in created.json));
  // Every workspace member reads every project (KOBE-587, RV1): no row needed, no reader role.
  out("member_list", (await reader("GET", "/v1/projects")).json.projects.some((p) => p.id === id));
  out("reader_role_refused", code(await owner("POST", "/v1/projects/" + id + "/members", { user_id: readerId, role: "reader" })));
  const mine = await reader("GET", "/v1/projects/" + id);
  out("member_get", mine.status + ":" + mine.json.my_role + ":" + (mine.json.instructions === "Always answer in " + marker));
  out("member_patch", code(await reader("PATCH", "/v1/projects/" + id, { name: "mine now" })));
  out("member_add", code(await reader("POST", "/v1/projects/" + id + "/members", { user_id: readerId, role: "owner" })));
  const up = await upload(owner, id, "brief.txt", "project brief " + marker);
  out("upload", up.status + ":" + (up.json.path ?? "-") + ":" + (up.json.source ?? "-"));
  out("member_upload", code(await upload(reader, id, "nope.txt", "x")));
  const files = await reader("GET", "/v1/projects/" + id + "/files");
  out("member_files", files.status + ":" + (files.json.files ?? []).map((f) => f.path).join(","));
  const list = await owner("GET", "/v1/projects");
  out("owner_list", list.json.projects.find((p) => p.id === id)?.file_count);
} else {
  const share = await owner("POST", "/v1/threads/" + threadArg + "/share", { visibility: "project" });
  out("share", share.status + ":" + share.json.visibility);
  out("reader_share", code(await reader("POST", "/v1/threads/" + threadArg + "/share", { visibility: "private" })));
  const seen = await reader("GET", "/v1/threads/" + threadArg);
  out("reader_get", seen.status + ":read_only=" + seen.json.read_only);
  out("reader_list", (await reader("GET", "/v1/threads?project_id=" + projectArg)).json.threads.some((t) => t.thread_id === threadArg));
  out("reader_default_list", (await reader("GET", "/v1/threads")).json.threads.some((t) => t.thread_id === threadArg));
  out("reader_post", code(await reader("POST", "/v1/threads/" + threadArg + "/messages", { content: "can I?" })));
  out("reader_rename", code(await reader("PATCH", "/v1/threads/" + threadArg, { title: "mine" })));
  const fork = await reader("POST", "/v1/threads/" + threadArg + "/fork", {});
  out("fork", fork.status);
  const mine = await reader("GET", "/v1/threads/" + fork.json.thread_id);
  out("fork_get", mine.status + ":read_only=" + mine.json.read_only + ":" + mine.json.visibility + ":" + (mine.json.project_id === projectArg) + ":entries=" + (mine.json.entries?.length > 0));
  out("fork_hidden_from_owner", code(await owner("GET", "/v1/threads/" + fork.json.thread_id)));
  const unshare = await owner("POST", "/v1/threads/" + threadArg + "/share", { visibility: "private" });
  out("unshare", unshare.status + ":" + unshare.json.visibility);
  out("reader_after_unshare", code(await reader("GET", "/v1/threads/" + threadArg)));
  const archived = await owner("PATCH", "/v1/projects/" + projectArg, { archived: true });
  out("archive", archived.status + ":" + (archived.json.archived_at != null));
  out("archived_upload", code(await upload(owner, projectArg, "late.txt", "late")));
  out("archived_listed", (await owner("GET", "/v1/projects")).json.projects.some((p) => p.id === projectArg));
  out("archived_listed_when_asked", (await owner("GET", "/v1/projects?include_archived=true")).json.projects.some((p) => p.id === projectArg));
}
JS
    projects_js() { # mode [project-id] [thread-id] → the PROJECTS_JS output
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- \
        node --input-type=module -e "$PROJECTS_JS" "$E2E_TEAM_ID" "$1" reader@e2e.test "${2:-}" "${3:-}" "$READER_ID" 2>&1 | tail -24
    }
    pr_out=$(projects_js setup)
    printf '     projects: %s\n' "$(printf '%s' "$pr_out" | tr '\n' ' ' | cut -c1-700)"
    pr_id=$(printf '%s\n' "$pr_out" | sed -n 's/^project_id=//p')
    contains "projects: both users signed in" '^signin=200:200$' "$pr_out"
    contains "projects: the Owner creates a project and becomes its owner (201, no visibility)" '^create=201:owner:false$' "$pr_out"
    contains "projects: every workspace member lists the project (KOBE-587)" '^member_list=true$' "$pr_out"
    contains "projects: explicit reader rows are refused (owner or editor only)" '^reader_role_refused=400:invalid_request$' "$pr_out"
    contains "projects: the member sees the project, its role and instructions" '^member_get=200:reader:true$' "$pr_out"
    contains "projects: a reader cannot change the project (403)" '^member_patch=403:forbidden$' "$pr_out"
    contains "projects: a reader cannot manage members (403)" '^member_add=403:forbidden$' "$pr_out"
    contains "projects: the Owner uploads a project file (201, upload, in its folder)" '^upload=201:docs/brief.txt:upload$' "$pr_out"
    contains "projects: a reader cannot upload (403)" '^member_upload=403:forbidden$' "$pr_out"
    contains "projects: a reader lists the file" '^member_files=200:docs/brief.txt$' "$pr_out"
    contains "projects: the project counts one file" '^owner_list=1$' "$pr_out"
    CHAT_PROJECT="$pr_id"
    pr_chat=$(chat_run "hello-project-$RANDOM" 300000 "" "" "" 1)
    CHAT_PROJECT=""
    pr_thread=$(printf '%s\n' "$pr_chat" | sed -n 's/^thread_id=//p')
    contains "projects: a conversation in the project completes a run" '^terminal=run.completed$' "$pr_chat"
    contains "projects: the thread belongs to the project and is private" '^true\|false$' \
      "$(psql_kobe "SELECT (project_id = '${pr_id:-00000000-0000-4000-8000-000000000000}')::text || '|' || shared_to_project::text FROM threads WHERE id = '${pr_thread:-00000000-0000-4000-8000-000000000000}'")"
    # KOBE-245: the instructions reach the model (the fake model echoes the system messages it got);
    # a conversation outside any project never sees them.
    pr_marker=$(psql_kobe "SELECT instructions FROM projects WHERE id = '${pr_id:-00000000-0000-4000-8000-000000000000}'")
    pr_sys=$(chat_run "system?" 300000 "" "" "$pr_thread")
    contains "projects: a project run's model input has the labelled instructions" \
      '^text=.*Project instructions \(set by project admins\)' "$pr_sys"
    contains "projects: ...and the instructions the admins wrote" "^text=.*${pr_marker:-no-marker}" "$pr_sys"
    pr_plain=$(chat_run "system?" 300000)
    contains "projects: a conversation outside a project answered" '^text=.*system said: ' "$pr_plain"
    if printf '%s' "$pr_plain" | grep -q "Project instructions"; then fail "projects: a non-project run has no project instructions"; else ok "projects: a non-project run has no project instructions"; fi
    pr_out=$(projects_js share "$pr_id" "$pr_thread")
    printf '     projects share: %s\n' "$(printf '%s' "$pr_out" | tr '\n' ' ' | cut -c1-900)"
    contains "projects: the author shares the thread to the project" '^share=200:project$' "$pr_out"
    contains "projects: the reader cannot change the sharing (403 read_only)" '^reader_share=403:read_only$' "$pr_out"
    contains "projects: the member opens the shared thread read-only" '^reader_get=200:read_only=true$' "$pr_out"
    contains "projects: the shared thread is in the member's project list" '^reader_list=true$' "$pr_out"
    contains "projects: it is not in the member's own thread list" '^reader_default_list=false$' "$pr_out"
    contains "projects: the member cannot post to it (403 read_only)" '^reader_post=403:read_only$' "$pr_out"
    contains "projects: the member cannot rename it (403 read_only)" '^reader_rename=403:read_only$' "$pr_out"
    contains "projects: the member forks it (201)" '^fork=201$' "$pr_out"
    contains "projects: the fork is the member's own private thread in the project, with the conversation" \
      '^fork_get=200:read_only=false:private:true:entries=true$' "$pr_out"
    contains "projects: the fork is invisible to the author (404)" '^fork_hidden_from_owner=404:thread_not_found$' "$pr_out"
    contains "projects: unsharing makes the thread private again" '^unshare=200:private$' "$pr_out"
    contains "projects: the member loses the thread at once (404)" '^reader_after_unshare=404:thread_not_found$' "$pr_out"
    contains "projects: archiving works (200, archived_at set)" '^archive=200:true$' "$pr_out"
    contains "projects: an archived project refuses new files (409 archived)" '^archived_upload=409:archived$' "$pr_out"
    contains "projects: archived projects are listed only when asked" '^archived_listed=false$' "$pr_out"
    contains "projects: ...and are listed when asked" '^archived_listed_when_asked=true$' "$pr_out"

    # KOBE-284 (Gate B ac-2): KOBE-216's "Fork to a new thread" at a chosen message, with a title.
    # The Owner has a private thread with two exchanges and forks it at the first answer: the new
    # thread has the title, the history up to that answer only and the fork provenance, and the
    # source is unchanged. The fork's first run continues from the copied history (Pi rebuilds the
    # session from the copied entries; the fake model echoes the conversation it was given for
    # "history?"). The reader, a team member who cannot open the source, is refused (404).
    echo "==> fork at a message (KOBE-284)"
    read -r -d '' FORK_JS <<'JS' || true
const [team, mode, readerEmail, sourceId, markerA, markerB, title, forkArg, chosenArg] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KAIJU_PUBLIC_URL).origin;
const out = (k, v) => console.log(k + "=" + v);
const session = async (email) => {
  const jar = new Map();
  const call = async (method, path, body) => {
    const headers = { origin, "x-kaiju-team": team, cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    const text = await res.text();
    let json = {}; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  let login;
  for (let i = 0; i < 4; i++) { // sign-in is rate limited (3 per 10 s): wait out a 429
    login = await call("POST", "/api/auth/sign-in/email", { email, password: "e2e owner password" });
    if (login.status !== 429) break;
    await new Promise((r) => setTimeout(r, 11000));
  }
  await call("PUT", "/v1/me/teams/active", { teamId: team });
  call.login = login.status;
  return call;
};
const ids = (detail) => (detail.json.entries ?? []).map((e) => e.entry_id);
const sig = (detail) => ids(detail).length + ":" + detail.json.leaf_entry_id + ":" + detail.json.title + ":" + detail.json.forked_from_thread_id;
const owner = await session("owner@e2e.test");
const src = "/v1/threads/" + sourceId;
if (mode === "fork") {
  const reader = await session(readerEmail);
  out("signin", owner.login + ":" + reader.login);
  const before = await owner("GET", src);
  const all = ids(before);
  const isAnswer = (e, marker) => e.type === "message" && e.payload?.message?.role === "assistant" && JSON.stringify(e.payload).includes(marker);
  const chosen = before.json.entries?.find((e) => isAnswer(e, markerA))?.entry_id;
  const second = before.json.entries?.find((e) => isAnswer(e, markerB))?.entry_id;
  out("chosen_id", chosen ?? "-");
  out("chosen_is_middle", chosen !== undefined && second !== undefined && all.indexOf(chosen) < all.indexOf(second) && before.json.leaf_entry_id === second);
  out("source_sig", sig(before));
  const fork = await owner("POST", src + "/fork", { entry_id: chosen, title });
  out("fork", fork.status);
  out("fork_id", fork.json.thread_id ?? "-");
  const mine = await owner("GET", "/v1/threads/" + fork.json.thread_id);
  out("fork_title", mine.status + ":" + (mine.json.title === title));
  out("fork_history", chosen !== undefined && ids(mine).join(",") === all.slice(0, all.indexOf(chosen) + 1).join(",") ? "prefix" : ids(mine).join(",") + " vs " + all.join(","));
  out("fork_leaf", mine.json.leaf_entry_id === chosen && ids(mine).at(-1) === chosen);
  out("fork_without_second", !JSON.stringify(mine.json.entries ?? []).includes(markerB));
  out("provenance", (mine.json.forked_from_thread_id === sourceId) + ":" + (mine.json.forked_at_entry_id === chosen) + ":" + (mine.json.forked_from_title === before.json.title));
  out("source_after_fork", sig(await owner("GET", src)));
  const refused = await reader("POST", src + "/fork", { entry_id: chosen, title: "not yours" });
  out("reader_fork", refused.status + ":" + (refused.json.code ?? "-"));
} else {
  out("signin", owner.login);
  const mine = await owner("GET", "/v1/threads/" + forkArg);
  const next = (mine.json.entries ?? []).find((e) => e.parent_id === chosenArg);
  out("fork_continued", mine.status + ":" + (next !== undefined && mine.json.leaf_entry_id !== chosenArg));
  out("source_after_run", sig(await owner("GET", src)));
}
JS
    fork_js() { # mode source-id marker-a marker-b title [fork-id] [chosen-id] → the FORK_JS output
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- \
        node --input-type=module -e "$FORK_JS" "$E2E_TEAM_ID" "$1" reader@e2e.test "$2" "$3" "$4" "$5" "${6:-}" "${7:-}" 2>&1 | tail -16
    }
    fk_id="$(date +%s)-$RANDOM"
    fk_a="fork-first-$fk_id" fk_b="fork-second-$fk_id" fk_title="E2E fork $fk_id"
    fk_chat=$(chat_run "$fk_a" 300000)
    fk_src=$(sed -n 's/^thread_id=//p' <<<"$fk_chat")
    contains "fork: the source's first exchange completed" '^terminal=run.completed$' "$fk_chat"
    contains "fork: the source's second exchange completed" '^terminal=run.completed$' \
      "$(chat_run "$fk_b" 300000 "" "" "${fk_src:-00000000-0000-4000-8000-000000000000}")"
    fk_out=$(fork_js fork "${fk_src:-00000000-0000-4000-8000-000000000000}" "$fk_a" "$fk_b" "$fk_title")
    printf '     fork: %s\n' "$(tr '\n' ' ' <<<"$fk_out" | cut -c1-900)"
    fk_chosen=$(sed -n 's/^chosen_id=//p' <<<"$fk_out")
    fk_thread=$(sed -n 's/^fork_id=//p' <<<"$fk_out")
    fk_sig=$(sed -n 's/^source_sig=//p' <<<"$fk_out")
    contains "fork: both users signed in" '^signin=200:200$' "$fk_out"
    contains "fork: the chosen entry is the first answer, before the second exchange" '^chosen_is_middle=true$' "$fk_out"
    contains "fork: the Owner forks at that entry with a title (201)" '^fork=201$' "$fk_out"
    contains "fork: the new thread has the title" '^fork_title=200:true$' "$fk_out"
    contains "fork: its history is the source's up to the chosen entry" '^fork_history=prefix$' "$fk_out"
    contains "fork: its history ends at the chosen entry" '^fork_leaf=true$' "$fk_out"
    contains "fork: the second exchange is not in it" '^fork_without_second=true$' "$fk_out"
    contains "fork: forked_from_thread_id, forked_at_entry_id (and the source title) are set" \
      '^provenance=true:true:true$' "$fk_out"
    if [[ -n "$fk_sig" ]] && grep -qxF "source_after_fork=$fk_sig" <<<"$fk_out"; then ok "fork: the source thread is unchanged"
    else fail "fork: the source thread is unchanged (before $fk_sig)"; fi
    contains "fork: a member who cannot open the source is refused (404)" '^reader_fork=404:thread_not_found$' "$fk_out"
    fk_run=$(chat_run "history?" 300000 "" "" "${fk_thread:-00000000-0000-4000-8000-000000000000}")
    contains "fork: the fork's first run completed" '^terminal=run.completed$' "$fk_run"
    contains "fork: the model is given the copied history" "^text=fake-openai: history said: .*user: $fk_a \| assistant: fake-openai: $fk_a" "$fk_run"
    if grep -qF "$fk_b" <<<"$fk_run"; then fail "fork: the model is not given the exchange after the fork point"
    else ok "fork: the model is not given the exchange after the fork point"; fi
    fk_after=$(fork_js after "${fk_src:-00000000-0000-4000-8000-000000000000}" "$fk_a" "$fk_b" "$fk_title" \
      "${fk_thread:-00000000-0000-4000-8000-000000000000}" "${fk_chosen:--}")
    contains "fork: the run continued the fork from the chosen entry" '^fork_continued=200:true$' "$fk_after"
    if [[ -n "$fk_sig" ]] && grep -qxF "source_after_run=$fk_sig" <<<"$fk_after"; then ok "fork: the fork's run left the source unchanged"
    else fail "fork: the fork's run left the source unchanged (before $fk_sig)"; fi

