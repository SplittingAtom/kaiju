# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
    # KOBE-226 (Gate C ac-1), KOBE-219 and KOBE-222: auto-titles and follow-ups through the
    # server's own post-run calls to the model gateway (server-call token → shim → Bifrost → the
    # fake upstream). A thread created without a title gets one after its first completed run; the
    # fake model echoes the title prompt ("First message: …"), so the title is the first line of
    # that echo, "fake-openai: First message", never the fallback (the prompt's first line, used
    # only when no call is made or the last one failed). The calls are `title` and `followups`
    # usage rows of the run, without a sandbox. A rename locks the title: later runs announce no
    # title call. Follow-ups need the team switch: on, `thread.suggestions` follows the run (the
    # fake's echo gives the chips; lines ending in ":" are lead-ins and dropped); off, nothing.
    echo "==> auto-titles and follow-ups (KOBE-219, KOBE-222)"
    at_id="$(date +%s)-$RANDOM"
    at_prompt="autotitle-$at_id" at_renamed="Renamed $at_id"
    at_setup=$(as_owner 'PUT /v1/team/settings {"followups_enabled":true}' 'POST /v1/threads {}')
    contains "follow-ups: a team admin turns the team switch on" '^200 \{"followups_enabled":true\}$' "$at_setup"
    at_thread=$(sed -n 's/^201 .*"thread_id":"\([0-9a-f-]*\)".*/\1/p' <<<"$at_setup")
    at_sql="'${at_thread:-00000000-0000-4000-8000-000000000000}'"
    at_title() { psql_kobe "SELECT coalesce(title, '-') || '|' || title_locked FROM threads WHERE id = $at_sql"; }
    at_epilogue() { # run-id → "title:followups" as announced by its run.completed (true/false each)
      psql_kobe "SELECT coalesce(payload->'epilogue' ? 'title', false)::text || ':' || coalesce(payload->'epilogue' ? 'followups', false)::text FROM run_events WHERE run_id = '$1' AND type = 'run.completed'"
    }
    at_after() { # run-id → the epilogue events of the run (a leaf-only thread.updated, KOBE-543, is not one)
      psql_kobe "SELECT coalesce(string_agg(type, ',' ORDER BY type), '-') FROM run_events WHERE run_id = '$1' AND type IN ('thread.updated', 'thread.suggestions') AND NOT (type = 'thread.updated' AND NOT payload ? 'title')"
    }
    at_usage() { # run-id → the run's server-call usage rows as kind:status:no-sandbox
      psql_kobe "SELECT coalesce(string_agg(kind || ':' || status || ':' || (sandbox_id IS NULL), ',' ORDER BY kind), '-') FROM run_usage WHERE team_id = '$E2E_TEAM_ID' AND run_id = '$1' AND kind <> 'run'"
    }
    contains "auto-titles: a thread created without a title starts untitled" '^-\|false$' "$(at_title)"
    at_chat=$(chat_run "$at_prompt" 300000 "" "" "${at_thread:-00000000-0000-4000-8000-000000000000}")
    at_run=$(sed -n 's/^run=//p' <<<"$at_chat")
    at_run=${at_run:-00000000-0000-4000-8000-000000000000}
    contains "auto-titles: the thread's first run completed" '^terminal=run.completed$' "$at_chat"
    contains "auto-titles: its run.completed announces the title and follow-up calls" '^true:true$' "$(at_epilogue "$at_run")"
    contains "auto-titles: the thread is titled from the model's reply through the gateway (not the fallback)" \
      '^fake-openai: First message\|false$' "$(wait_for 45 '^[^-]' at_title)"
    contains "auto-titles: thread.updated and thread.suggestions follow run.completed" \
      '^thread.suggestions,thread.updated$' "$(wait_for 30 '^thread.suggestions,thread.updated$' at_after "$at_run")"
    contains "auto-titles: the title event carries the saved title" '^fake-openai: First message$' \
      "$(psql_kobe "SELECT payload->>'title' FROM run_events WHERE run_id = '$at_run' AND type = 'thread.updated' AND payload ? 'title'")"
    contains "auto-titles: the calls are the run's title and followups usage rows, without a sandbox" \
      '^followups:200:true,title:200:true$' "$(wait_for 30 '^followups:200:true,title:200:true$' at_usage "$at_run")"
    contains "follow-ups: the chips are the fake model's suggestions for the last exchange" \
      "^\[\"$at_prompt\", \"fake-openai: $at_prompt\"\]\$" \
      "$(psql_kobe "SELECT payload->'suggestions' FROM run_events WHERE run_id = '$at_run' AND type = 'thread.suggestions'")"
    contains "auto-titles: the owner renames the thread (200)" '^200 ' \
      "$(as_owner "PATCH /v1/threads/${at_thread:-00000000-0000-4000-8000-000000000000} {\"title\":\"$at_renamed\"}")"
    contains "auto-titles: a rename locks the title" "^$at_renamed\|true\$" "$(at_title)"
    at_chat2=$(chat_run "after-rename-$at_id" 300000 "" "" "${at_thread:-00000000-0000-4000-8000-000000000000}")
    at_run2=$(sed -n 's/^run=//p' <<<"$at_chat2")
    at_run2=${at_run2:-00000000-0000-4000-8000-000000000000}
    contains "auto-titles: a run after the rename completed" '^terminal=run.completed$' "$at_chat2"
    contains "auto-titles: ...and announces follow-ups but no title call" '^false:true$' "$(at_epilogue "$at_run2")"
    contains "auto-titles: ...its follow-ups arrive, with no title event" '^thread.suggestions$' \
      "$(wait_for 30 '^thread.suggestions$' at_after "$at_run2")"
    contains "auto-titles: ...no title call was made (only the followups usage row)" '^followups:200:true$' \
      "$(wait_for 30 '^followups:' at_usage "$at_run2")"
    contains "auto-titles: the renamed thread is never re-titled" "^$at_renamed\|true\$" "$(at_title)"
    contains "follow-ups: a team admin turns the team switch off" '^200 \{"followups_enabled":false\}$' \
      "$(as_owner 'PUT /v1/team/settings {"followups_enabled":false}')"
    at_chat3=$(chat_run "switch-off-$at_id" 300000 "" "" "${at_thread:-00000000-0000-4000-8000-000000000000}")
    at_run3=$(sed -n 's/^run=//p' <<<"$at_chat3")
    at_run3=${at_run3:-00000000-0000-4000-8000-000000000000}
    contains "follow-ups: with the switch off a run completes" '^terminal=run.completed$' "$at_chat3"
    contains "follow-ups: ...and announces no server call at all" '^false:false$' "$(at_epilogue "$at_run3")"
    contains "follow-ups: ...so no suggestions and no server-call usage follow it" '^-\|-$' \
      "$(at_after "$at_run3")|$(at_usage "$at_run3")"

    # KOBE-226 (Gate C ac-1), KOBE-220 and KOBE-221: organizing and sharing a thread, by API. The
    # titled thread above (the Owner's, private, with runs) is pinned and unpinned, archived and
    # unarchived (archiving unpins; an archived thread can't be pinned), moved into a new project,
    # shared to it and moved out again (the move ends the project share: the member loses it).
    # A second thread is busy with a run the fake model holds back (`kobe-slow-start`): moving it
    # is refused until the run is stopped. Then the team share: the reader (a plain member) opens
    # the thread read-only, can't post to it (403 read_only) and forks it; the Owner revokes and
    # the reader gets 404. Last, the Owner as team admin: of two threads the reader starts, the
    # private one stays 404 and only the one shared with the team is readable (read-only) and
    # listed under Shared with me.
    echo "==> organize and team sharing (KOBE-220, KOBE-221)"
    read -r -d '' ORG_JS <<'JS' || true
const [team, readerEmail, readerId, threadArg, marker] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const out = (k, v) => console.log(k + "=" + v);
const session = async (email) => {
  const jar = new Map();
  const call = async (method, path, body) => {
    const headers = { origin, "x-kobe-team": team, cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") };
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
const code = (r) => r.status + ":" + (r.json.code ?? "-");
const has = async (call, path, id = threadArg) => ((await call("GET", path)).json.threads ?? []).some((t) => t.thread_id === id);
const owner = await session("owner@e2e.test");
const reader = await session(readerEmail);
out("signin", owner.login + ":" + reader.login);
const t = "/v1/threads/" + threadArg;
// Pin and archive (KOBE-220): the Pinned and Archived groups are their own lists; the activity
// list (GET /v1/threads) leaves both out.
const pin = await owner("POST", t + "/pin");
out("pin", pin.status + ":" + (pin.json.pinned_at != null));
out("pinned_lists", (await has(owner, "/v1/threads/pinned")) + ":" + (await has(owner, "/v1/threads")));
out("reader_pin", code(await reader("POST", t + "/pin")));
const unpin = await owner("POST", t + "/unpin");
out("unpin", unpin.status + ":" + (unpin.json.pinned_at === null));
out("unpinned_lists", (await has(owner, "/v1/threads/pinned")) + ":" + (await has(owner, "/v1/threads")));
await owner("POST", t + "/pin");
const archive = await owner("POST", t + "/archive");
out("archive", archive.status + ":" + (archive.json.archived_at != null) + ":" + (archive.json.pinned_at === null));
out("archived_lists", (await has(owner, "/v1/threads/archived")) + ":" + (await has(owner, "/v1/threads")) + ":" + (await has(owner, "/v1/threads/pinned")));
out("pin_archived", code(await owner("POST", t + "/pin")));
const unarchive = await owner("POST", t + "/unarchive");
out("unarchive", unarchive.status + ":" + (unarchive.json.archived_at === null));
out("unarchived_lists", (await has(owner, "/v1/threads/archived")) + ":" + (await has(owner, "/v1/threads")));
// Move into a project and out again; a project share ends with the move.
const project = await owner("POST", "/v1/projects", { name: "E2E organize " + marker, member_user_ids: [] });
const projectId = project.json.id;
// The reader reads it as every workspace member does (KOBE-587).
out("project", project.status + ":" + (await reader("GET", "/v1/projects/" + projectId)).json.my_role);
const moveIn = await owner("POST", t + "/move", { project_id: projectId });
out("move_in", moveIn.status + ":" + (moveIn.json.project_id === projectId) + ":" + (await has(owner, "/v1/threads?project_id=" + projectId)));
const pshare = await owner("POST", t + "/share", { visibility: "project" });
const pseen = await reader("GET", t);
out("project_share", pshare.status + ":" + pshare.json.visibility + ":" + pseen.status + ":read_only=" + pseen.json.read_only);
out("reader_move", code(await reader("POST", t + "/move", { project_id: null })));
const moveOut = await owner("POST", t + "/move", { project_id: null });
out("move_out", moveOut.status + ":" + moveOut.json.project_id + ":" + moveOut.json.visibility + ":" + moveOut.json.shared_to_project);
out("reader_after_move", code(await reader("GET", t)));
// Move while a run is active: refused (409 thread_busy) until it is stopped.
const busy = await owner("POST", "/v1/threads", { title: "E2E busy " + marker });
const busyPath = "/v1/threads/" + busy.json.thread_id;
const sent = await owner("POST", busyPath + "/messages", { content: "kobe-slow-start move me " + marker });
out("busy_message", sent.status);
out("busy_move", code(await owner("POST", busyPath + "/move", { project_id: projectId })));
out("busy_cancel", (await owner("POST", "/v1/runs/" + sent.json.run_id + "/cancel")).json.status);
let moved;
for (let i = 0; i < 5; i++) { // the Stop's own write may hold the thread row a moment
  moved = await owner("POST", busyPath + "/move", { project_id: projectId });
  if (moved.status !== 409) break;
  await new Promise((r) => setTimeout(r, 1000));
}
out("move_after_stop", moved.status + ":" + (moved.json.project_id === projectId));
// Team share (KOBE-221): read-only for another member, forkable, revoked at once.
const share = await owner("POST", t + "/share", { visibility: "team" });
out("team_share", share.status + ":" + share.json.visibility);
const seen = await reader("GET", t);
out("reader_get", seen.status + ":read_only=" + seen.json.read_only + ":entries=" + ((seen.json.entries ?? []).length > 0));
out("reader_shared_list", await has(reader, "/v1/threads/shared"));
out("reader_post", code(await reader("POST", t + "/messages", { content: "can I? " + marker })));
out("reader_share", code(await reader("POST", t + "/share", { visibility: "private" })));
const fork = await reader("POST", t + "/fork", {});
const mine = await reader("GET", "/v1/threads/" + fork.json.thread_id);
out("reader_fork", fork.status + ":" + mine.status + ":read_only=" + mine.json.read_only + ":" + mine.json.visibility + ":" + (mine.json.forked_from_thread_id === threadArg) + ":entries=" + ((mine.json.entries ?? []).length > 0));
out("fork_hidden_from_owner", code(await owner("GET", "/v1/threads/" + fork.json.thread_id)));
const revoke = await owner("POST", t + "/share", { visibility: "private" });
out("revoke", revoke.status + ":" + revoke.json.visibility);
out("reader_after_revoke", code(await reader("GET", t)) + ":" + (await has(reader, "/v1/threads/shared")));
// A team admin reads a member's thread only when it is shared with the team.
const hidden = await reader("POST", "/v1/threads", { title: "E2E member private " + marker });
const shared = await reader("POST", "/v1/threads", { title: "E2E member shared " + marker });
out("member_threads", hidden.status + ":" + shared.status + ":" + (await reader("POST", "/v1/threads/" + shared.json.thread_id + "/share", { visibility: "team" })).json.visibility);
out("admin_private", code(await owner("GET", "/v1/threads/" + hidden.json.thread_id)));
const adminSees = await owner("GET", "/v1/threads/" + shared.json.thread_id);
out("admin_shared", adminSees.status + ":read_only=" + adminSees.json.read_only);
out("admin_shared_list", (await has(owner, "/v1/threads/shared", shared.json.thread_id)) + ":" + (await has(owner, "/v1/threads/shared", hidden.json.thread_id)));
out("admin_post", code(await owner("POST", "/v1/threads/" + shared.json.thread_id + "/messages", { content: "admin? " + marker })));
JS
    org_out=$($KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "$ORG_JS" \
      "$E2E_TEAM_ID" reader@e2e.test "$READER_ID" "${at_thread:-00000000-0000-4000-8000-000000000000}" "$at_id" 2>&1 | tail -40)
    printf '     organize: %s\n' "$(tr '\n' ' ' <<<"$org_out" | cut -c1-1200)"
    contains "organize: both users signed in" '^signin=200:200$' "$org_out"
    contains "organize: the owner pins the thread (200, pinned_at set)" '^pin=200:true$' "$org_out"
    contains "organize: a pinned thread is in Pinned, not in the activity list" '^pinned_lists=true:false$' "$org_out"
    contains "organize: another member can't pin it (404)" '^reader_pin=404:thread_not_found$' "$org_out"
    contains "organize: unpin (200, pinned_at cleared)" '^unpin=200:true$' "$org_out"
    contains "organize: an unpinned thread is back in the activity list" '^unpinned_lists=false:true$' "$org_out"
    contains "organize: archiving a pinned thread archives and unpins it" '^archive=200:true:true$' "$org_out"
    contains "organize: an archived thread is in Archived only" '^archived_lists=true:false:false$' "$org_out"
    contains "organize: an archived thread can't be pinned (409 thread_archived)" '^pin_archived=409:thread_archived$' "$org_out"
    contains "organize: unarchive (200, archived_at cleared)" '^unarchive=200:true$' "$org_out"
    contains "organize: an unarchived thread is back in the activity list" '^unarchived_lists=false:true$' "$org_out"
    contains "organize: a project every member reads" '^project=201:reader$' "$org_out"
    contains "organize: the owner moves the thread into the project (listed there)" '^move_in=200:true:true$' "$org_out"
    contains "organize: shared to the project, the member reads it" '^project_share=200:project:200:read_only=true$' "$org_out"
    contains "organize: the member can't move it (403 read_only)" '^reader_move=403:read_only$' "$org_out"
    contains "organize: moved out of the project, the thread is private again" '^move_out=200:null:private:false$' "$org_out"
    contains "organize: the move ended the project share: the member gets 404" '^reader_after_move=404:thread_not_found$' "$org_out"
    contains "organize: both moves are audited" '^2$' \
      "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'thread.moved' AND target->>'threadId' = '${at_thread:-none}'")"
    contains "organize: a message starts a run the fake model holds back" '^busy_message=201$' "$org_out"
    contains "organize: moving a thread with an active run is refused (409 thread_busy)" '^busy_move=409:thread_busy$' "$org_out"
    contains "organize: ...the run is stopped" '^busy_cancel=cancelled$' "$org_out"
    contains "organize: ...and then the move goes through" '^move_after_stop=200:true$' "$org_out"
    contains "share: the owner shares the thread with the team" '^team_share=200:team$' "$org_out"
    contains "share: another member opens it read-only, with the conversation" '^reader_get=200:read_only=true:entries=true$' "$org_out"
    contains "share: it is under the member's Shared with me" '^reader_shared_list=true$' "$org_out"
    contains "share: the member can't post to it (403 read_only)" '^reader_post=403:read_only$' "$org_out"
    contains "share: the member can't change its sharing (403 read_only)" '^reader_share=403:read_only$' "$org_out"
    contains "share: the member forks it into a private thread of their own" \
      '^reader_fork=201:200:read_only=false:private:true:entries=true$' "$org_out"
    contains "share: the fork is invisible to the owner (404)" '^fork_hidden_from_owner=404:thread_not_found$' "$org_out"
    contains "share: the owner revokes the share" '^revoke=200:private$' "$org_out"
    contains "share: after the revoke the member gets 404 and no longer lists it" \
      '^reader_after_revoke=404:thread_not_found:false$' "$org_out"
    contains "share: the team share and revoke are audited" '^1:1$' \
      "$(psql_kobe "SELECT count(*) FILTER (WHERE target->>'visibility' = 'team') || ':' || count(*) FILTER (WHERE target->>'from' = 'team' AND target->>'visibility' = 'private') FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'thread.sharing_changed' AND target->>'threadId' = '${at_thread:-none}'")"
    contains "share: the Owner is a team admin of the team" '^team_admin$' \
      "$(psql_kobe "SELECT role FROM team_members WHERE team_id = '$E2E_TEAM_ID' AND user_id = '${owner_id:-00000000-0000-4000-8000-000000000000}'")"
    contains "share: the member starts a private and a team-shared thread" '^member_threads=201:201:team$' "$org_out"
    contains "share: the team admin can't open the member's private thread (404)" '^admin_private=404:thread_not_found$' "$org_out"
    contains "share: the team admin reads the shared one read-only" '^admin_shared=200:read_only=true$' "$org_out"
    contains "share: only the shared one is in the team admin's Shared with me" '^admin_shared_list=true:false$' "$org_out"
    contains "share: the team admin can't post to it either (403 read_only)" '^admin_post=403:read_only$' "$org_out"

