# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
    # KOBE-146 (53f of KOBE-53): uploads end to end. The Owner uploads a file into a new thread
    # through the API, a limit error is refused, the file is attached to a message, and the
    # Owner's real sandbox reads it under /workspace/uploads/<thread>/ (the fake model answers
    # "bash: <command>" with a bash tool call; `exit 0` ends the command before the attachment
    # note the agent appends to the prompt). Then the thread is deleted forever: its object leaves
    # S3. ClamAV is off in this site (its image and signature download cost minutes and
    # ~1 GiB of memory per cluster): uploads report scan "skipped". The scan itself (EICAR
    # rejected, clamd down = 503) runs when KAIJU_E2E_CLAMAV=1 (the nightly and manual runs).
    echo "==> uploads (KOBE-146)"
    read -r -d '' UPLOAD_JS <<'JS' || true
const [team, mode, threadArg, content] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KAIJU_PUBLIC_URL).origin;
const jar = new Map();
const call = async (method, path, body, extra = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { origin, "x-kaiju-team": team, ...extra, cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") },
    body,
  });
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const jsonCall = (m, p, b) => call(m, p, b === undefined ? undefined : JSON.stringify(b), { "content-type": "application/json" });
const upload = (name, bytes, threadId) => {
  const form = new FormData();
  if (threadId) form.append("thread_id", threadId);
  form.append("file", new File([bytes], name, { type: "text/plain" }));
  return call("POST", "/v1/uploads", form);
};
const out = (k, v) => console.log(k + "=" + v);
let login;
for (let i = 0; i < 4; i++) {
  login = await jsonCall("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
  if (login.status !== 429) break;
  await new Promise((r) => setTimeout(r, 11000));
}
out("signin", login.status);
await jsonCall("PUT", "/v1/me/teams/active", { teamId: team });
if (mode === "scan") {
  // Built at run time so this file holds no antivirus signature as a literal.
  const eicar = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR", "-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");
  const bad = await upload("eicar.txt", eicar, threadArg);
  out("eicar", bad.status + ":" + (bad.json.code ?? "-"));
  const good = await upload("clean.txt", "clean " + Date.now(), threadArg);
  out("clean", good.status + ":" + (good.json.scan ?? good.json.code ?? "-"));
  const again = await upload("clean2.txt", "clean2 " + Date.now(), threadArg);
  out("again", again.status + ":" + (again.json.scan ?? again.json.code ?? "-"));
} else {
  const thread = await jsonCall("POST", "/v1/threads", { title: "kobe-146" });
  const threadId = thread.json.thread_id;
  out("thread_id", threadId ?? "-");
  const ok = await upload("e2e-upload.txt", content ?? "", threadId);
  out("upload", ok.status + ":" + (ok.json.scan ?? "-") + ":" + (ok.json.size_bytes ?? "-") + ":" + (ok.json.name ?? "-"));
  out("file_id", ok.json.file_id ?? "-");
  const big = await upload("big.bin", new Uint8Array(2 * 1024 * 1024).fill(97), threadId);
  out("limit", big.status + ":" + (big.json.code ?? "-") + ":" + (big.json.limit_bytes ?? "-"));
}
JS
    upload_js() { # mode [thread-id] → the UPLOAD_JS output
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- \
        node --input-type=module -e "$UPLOAD_JS" "$E2E_TEAM_ID" "$1" "${2:-}" "${UPLOAD_CONTENT:-}" 2>&1 | tail -8
    }
    UPLOAD_CONTENT="kobe-146 $(date +%s) $RANDOM"
    up_out=$(upload_js plain)
    printf '     upload: %s\n' "$(printf '%s' "$up_out" | tr '\n' ' ')"
    up_thread=$(printf '%s\n' "$up_out" | sed -n 's/^thread_id=//p')
    up_file=$(printf '%s\n' "$up_out" | sed -n 's/^file_id=//p')
    contains "uploads: the Owner uploads a file into a thread (201, not scanned, its size and name)" \
      "^upload=201:skipped:${#UPLOAD_CONTENT}:e2e-upload.txt\$" "$up_out"
    contains "uploads: a file over the limit is refused (413 file_too_large, the limit named)" \
      '^limit=413:file_too_large:1048576$' "$up_out"
    contains "uploads: the stored file has a row (kind upload, scan_status none)" '^upload\|none$' \
      "$(psql_kobe "SELECT kind || '|' || scan_status FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${up_file:-00000000-0000-4000-8000-000000000000}'")"
    contains "uploads: only the one accepted file is stored (the refused one left nothing)" '^1$' \
      "$(psql_kobe "SELECT count(*) FROM files WHERE team_id = '$E2E_TEAM_ID' AND thread_id = '${up_thread:-00000000-0000-4000-8000-000000000000}'")"
    s3_ls() { # thread-id → the object listing of the thread's uploads in S3
      $KUBECTL -n kobe-deps exec deploy/s3 -- sh -c "echo 'fs.ls /buckets/kobe/teams/$E2E_TEAM_ID/threads/$1/uploads/' | weed shell -master=localhost:9333" 2>&1 || true
    }
    contains "uploads: the object is in S3 inside the thread's tree" "${up_file:-none}" "$(s3_ls "${up_thread:-none}")"
    msg_out=$(chat_run "bash: cat /workspace/uploads/$up_thread/e2e-upload.txt; exit 0" 300000 "" "" "$up_thread" 1 "$up_file")
    printf '     upload message: %s\n' "$(printf '%s' "$msg_out" | tr '\n' ' ' | cut -c1-500)"
    contains "uploads: a message with the file starts a run (201)" '^message=201$' "$msg_out"
    contains "uploads: the run completed" '^terminal=run.completed$' "$msg_out"
    contains "uploads: the sandbox read the file under /workspace/uploads/<thread>/" \
      "^text=fake-openai: tool said: ${UPLOAD_CONTENT}( |\$)" "$msg_out"
    contains "uploads: the file is attached to the run (files.run_id set)" '^t$' \
      "$(psql_kobe "SELECT run_id IS NOT NULL FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${up_file:-00000000-0000-4000-8000-000000000000}'")"
    contains "uploads: attaching the file keeps its object until the thread goes" "${up_file:-none}" \
      "$(s3_ls "${up_thread:-none}")"
    # KOBE-223 (CE22): an @file mention. The upload is now a file of the Owner's workspace
    # (uploads/<thread>/e2e-upload.txt); the message names it by the composer's marker and lists
    # it in `mentions`; the server rewrites it to the absolute sandbox path, and the real sandbox
    # reads exactly that path. Unlisted `@file(...)` text stays literal; bad mentions are refused
    # before any run exists.
    mention_path="uploads/$up_thread/e2e-upload.txt"
    mention_out=$(CHAT_MENTIONS="$mention_path" chat_run "bash: cat @file($mention_path); exit 0" 300000 "" "" "$up_thread" 1)
    printf '     mention message: %s\n' "$(printf '%s' "$mention_out" | tr '\n' ' ' | cut -c1-500)"
    mention_run=$(printf '%s\n' "$mention_out" | sed -n 's/^run=//p')
    contains "mentions: a message with an @file mention starts a run (201)" '^message=201$' "$mention_out"
    contains "mentions: the stored prompt names the absolute sandbox path, not the marker" \
      "^bash: cat /workspace/$mention_path; exit 0\$" \
      "$(psql_kobe "SELECT input FROM runs WHERE team_id = '$E2E_TEAM_ID' AND id = '${mention_run:-00000000-0000-4000-8000-000000000000}'")"
    contains "mentions: the agent read the mentioned file by that path" \
      "^text=fake-openai: tool said: ${UPLOAD_CONTENT}( |\$)" "$mention_out"
    mention_runs() { psql_kobe "SELECT count(*) FROM runs WHERE team_id = '$E2E_TEAM_ID' AND thread_id = '${up_thread:-00000000-0000-4000-8000-000000000000}'"; }
    mention_before=$(mention_runs)
    for bad in "/etc/passwd" "../../etc/passwd" "uploads/$up_thread/missing.txt"; do
      contains "mentions: $bad is refused (422)" '^message=422$' \
        "$(CHAT_MENTIONS="$bad" chat_run "bash: cat @file($bad); exit 0" 30000 "" "" "$up_thread")"
    done
    contains "mentions: no refused mention left a run" "^${mention_before:-x}\$" "$(mention_runs)"
    up_purged() { ! s3_ls "$up_thread" | grep -q "${up_file:-none}"; }
    as_owner "DELETE /v1/threads/$up_thread" >/dev/null
    contains "uploads: Delete forever of the thread answers 204" '^204 ' "$(as_owner "POST /v1/threads/$up_thread/purge")"
    if until_ok 60 up_purged; then ok "uploads: the thread purge removed the object from S3"
    else fail "uploads: the thread purge removed the object from S3"; fi
    contains "uploads: the file row is gone with the thread" '^0$' \
      "$(psql_kobe "SELECT count(*) FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${up_file:-00000000-0000-4000-8000-000000000000}'")"

    if [[ "${KAIJU_E2E_CLAMAV:-}" == 1 ]]; then
      # ClamAV on (the real clamav/clamav image; it downloads its signature database first, so the
      # rollout is given 10 min). EICAR is rejected and leaves no object or row, a clean file passes
      # with scan "clean", and with clamd gone uploads fail closed (503 scan_unavailable).
      echo "==> uploads with ClamAV (KOBE-146)"
      if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 10m --set clamav.enabled=true 2>&1); then
        ok "uploads: chart upgraded with clamav.enabled=true"
      else fail "uploads: chart upgraded with clamav.enabled=true: $out"; fi
      av_pod_user() { $KUBECTL -n "$NS" get pod -l app.kubernetes.io/component=clamav -o jsonpath='{.items[0].spec.securityContext.runAsUser}' 2>/dev/null; }
      contains "uploads: clamd runs as a non-root user (uid 100)" '^100$' "$(av_pod_user)"
      contains "uploads: the clamd container really runs as uid 100, not root" '^100$' \
        "$($KUBECTL -n "$NS" exec deploy/kobe-clamav -- id -u 2>&1 | tr -d ' ')"
      scan_thread=$(as_owner "POST /v1/threads {\"title\":\"kobe-146-scan\"}" | sed -n 's/.*"thread_id":"\([0-9a-f-]*\)".*/\1/p')
      scan_out=$(upload_js scan "$scan_thread")
      printf '     scan: %s\n' "$(printf '%s' "$scan_out" | tr '\n' ' ')"
      contains "uploads: an EICAR upload is rejected (422 scan_rejected)" '^eicar=422:scan_rejected$' "$scan_out"
      contains "uploads: a clean upload passes the scan (201, scan clean)" '^clean=201:clean$' "$scan_out"
      contains "uploads: the rejection is audited" '^1$' \
        "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'workspace.upload_scan_refused' AND target->>'reason' = 'scan_rejected'")"
      contains "uploads: the rejected file left no row (only the clean files)" '^2$' \
        "$(psql_kobe "SELECT count(*) FROM files WHERE team_id = '$E2E_TEAM_ID' AND thread_id = '${scan_thread:-00000000-0000-4000-8000-000000000000}'")"
      $KUBECTL -n "$NS" scale deploy/kobe-clamav --replicas=0 >/dev/null 2>&1 || true
      $KUBECTL -n "$NS" wait --for=delete pod -l app.kubernetes.io/component=clamav --timeout=120s >/dev/null 2>&1 || true
      down_out=$(upload_js scan "$scan_thread")
      contains "uploads: with clamd down an upload fails closed (503 scan_unavailable)" '^clean=503:scan_unavailable$' "$down_out"
      if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m --set clamav.enabled=false 2>&1); then
        ok "uploads: chart upgraded back with clamav.enabled=false"
      else fail "uploads: chart upgraded back with clamav.enabled=false: $out"; fi
    fi

    # ac-2: a revoked session token cannot call Bifrost (the member left the team; token unexpired).
    psql_kobe "DELETE FROM team_members WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$MODEL_USER_ID';" >/dev/null
    contains "a revoked session token (member removed) is refused (401)" '^code=401$' \
      "$(until_code 401 openai/gpt-fake "$model_token")"
