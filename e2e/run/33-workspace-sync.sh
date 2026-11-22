# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-27: /workspace ↔ S3 (dev/s3.yaml: SeaweedFS, a test-only fixture). A dedicated user, so
# destroying its volume never disturbs the sandboxes later sections use. Write a file, hibernate
# (the agent's final push), destroy the PVC, wake: the file must be back on the new, empty volume.
echo "==> workspace sync (KOBE-27)"
SYNC_USER_ID=5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f
psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$SYNC_USER_ID', 'E2E workspace sync user', 'workspace-sync@e2e.test', true) ON CONFLICT DO NOTHING;
  INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$SYNC_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
sync_lifecycle() { # hibernate|wake → the CLI's answer
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/lifecycle.js "$1" \
    --team-id "$E2E_TEAM_ID" --user-id "$SYNC_USER_ID" 2>&1 | grep -E '^\{"(hibernated|woken)"' || true
}
sync_uid() { $KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$SYNC_USER_ID" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
sync_pod() {
  $KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=$(sync_uid)" \
    -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
sync_pod_gone() { [[ -z "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=$(sync_uid)" -o name 2>/dev/null)" ]]; }
in_sync_sandbox() { $KUBECTL -n "$TEAM_NS" exec "$(sync_pod)" -c agent -- sh -c "$1" 2>&1 || true; }
sync_wire_open() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$SYNC_USER_ID' AND closed_at IS NULL")" == 1 ]]; }
sync_row() { psql_kobe "SELECT sha256 FROM workspace_files WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$SYNC_USER_ID' AND path = 'reports/q3.md' AND NOT deleted"; }
sync_row_present() { [[ "$(sync_row)" =~ ^[0-9a-f]{64}$ ]]; }
SYNC_CONTENT="kobe-27 $(date +%s) $RANDOM"
sync_restored() { [[ "$(in_sync_sandbox 'cat /workspace/reports/q3.md')" == "$SYNC_CONTENT" ]]; }
ensure_sandbox "$E2E_TEAM_ID" e2e "$SYNC_USER_ID" >/dev/null || true
if until_ok 240 sync_wire_open; then ok "the workspace-sync user's sandbox connects"
else fail "the workspace-sync user's sandbox connects"; fi
contains "the sandbox holds no object-storage credentials or endpoint (env)" '^0$' \
  "$(in_sync_sandbox 'env | grep -ciE "s3|aws|secret.?access|access.?key" || true')"
contains "the agent can write a report into its workspace" '^written$' \
  "$(in_sync_sandbox "mkdir -p /workspace/reports && printf '%s' '$SYNC_CONTENT' > /workspace/reports/q3.md && echo written")"
contains "the idle sandbox hibernates" '"hibernated":true' "$(sync_lifecycle hibernate)"
if until_ok 120 sync_pod_gone; then ok "its pod is gone"; else fail "its pod is gone"; fi
# Pushed by the agent's final flush on the way down (the periodic push is 60 s; this is sooner).
if until_ok 60 sync_row_present; then ok "hibernation pushed the file to the durable copy (manifest row)"
else fail "hibernation pushed the file to the durable copy (manifest row): got [$(sync_row)]"; fi
sync_sha=$(sync_row)
contains "its content is in S3 under the team/user prefix, named by its hash" "$sync_sha" \
  "$($KUBECTL -n kobe-deps exec deploy/s3 -- sh -c "echo 'fs.ls /buckets/kobe/teams/$E2E_TEAM_ID/users/$SYNC_USER_ID/workspace/' | weed shell -master=localhost:9333" 2>&1 || true)"
sync_claim=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$SYNC_USER_ID" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
old_pvc=$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${sync_claim:-none}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
$KUBECTL -n "$TEAM_NS" delete pvc "workspace-${sync_claim:-none}" --wait=true --timeout=120s >/dev/null 2>&1 || true
new_pvc=$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${sync_claim:-none}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
if [[ -n "$old_pvc" && "$new_pvc" != "$old_pvc" ]]; then ok "the sandbox's /workspace volume is destroyed"
else fail "the sandbox's /workspace volume is destroyed (uid ${old_pvc:-none} → ${new_pvc:-none})"; fi
sync_wake_at=$SECONDS
contains "the sandbox is woken onto a new, empty volume" '"woken":true' "$(sync_lifecycle wake)"
if until_ok 240 sync_restored; then ok "the file is back after the volume was lost ($((SECONDS - sync_wake_at)) s after the wake)"
else
  fail "the file is back after the volume was lost: got [$(in_sync_sandbox 'cat /workspace/reports/q3.md' | tail -1)]"
  $KUBECTL -n "$TEAM_NS" logs "$(sync_pod)" -c agent --tail=30 2>&1 | sed 's/^/     agent: /' || true
fi
# The file shows in the sandbox before the agent's restore report is stored: wait for the row
# (KOBE-415: once read as 0 right after the file was back).
restored_audits() { psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'workspace.restored' AND target->>'userId' = '$SYNC_USER_ID'"; }
contains "a full restore onto an empty volume is audited" '^[1-9][0-9]*$' \
  "$(wait_for 60 '^[1-9][0-9]*$' restored_audits)"
# Restore timing as the agent measured it (scan + manifest + downloads), for the ledger.
$KUBECTL -n "$TEAM_NS" logs "$(sync_pod)" -c agent 2>/dev/null | grep -E '"msg":"workspace restored"' | head -2 | sed 's/^/     agent: /' || true
# And on a plain wake (volume kept): the cold-start user's last pod (incremental check only).
$KUBECTL -n "$TEAM_NS" logs "${cold_pod:-none}" -c agent 2>/dev/null | grep -E '"msg":"workspace restored"' | head -1 | sed 's/^/     cold-start agent: /' || true

