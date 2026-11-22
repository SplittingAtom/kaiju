# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-25: hibernate → wake (D14) with the real sandbox agent, and the cold-start harness (Pi ready).
# The e2e sandbox (KOBE-22) runs kobe-sandbox-agent; with the database rows above it trades its
# bootstrap token for session tokens and connects. Waits are bounded and end on a positive
# condition (never a fixed sleep before an assertion).
echo "==> hibernate and wake (KOBE-25)"
until_ok() { # seconds command... → succeeds as soon as the command does, fails after `seconds`
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    ((SECONDS >= deadline)) && return 1
    sleep 1
  done
}
wire_open() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$E2E_USER_ID' AND closed_at IS NULL")" == 1 ]]; }
sandbox_pod_name() { # the pod of the e2e sandbox (by its claim uid), if it has one
  $KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${sandbox_id:-none}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
pod_running() { [[ "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${sandbox_id:-none}" \
  -o jsonpath='{.items[*].status.phase}' 2>/dev/null)" == Running ]]; }
pod_gone() { [[ -z "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${sandbox_id:-none}" -o name 2>/dev/null)" ]]; }
in_sandbox() { # shell command → its output inside the sandbox's agent container
  $KUBECTL -n "$TEAM_NS" exec "$(sandbox_pod_name)" -c agent -- sh -c "$1" 2>&1 || true
}
lifecycle() { # hibernate|wake → the CLI's answer (same path, lock and audit as the server)
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/lifecycle.js "$1" \
    --team-id "$E2E_TEAM_ID" --user-id "$E2E_USER_ID" 2>&1 | grep -E '^\{"(hibernated|woken)"' || true
}
claim_sandbox=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$E2E_USER_ID" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
if until_ok 240 wire_open; then ok "the real sandbox agent trades its bootstrap token and connects over the wire"
else
  fail "the real sandbox agent trades its bootstrap token and connects over the wire"
  $KUBECTL -n "$TEAM_NS" logs "$(sandbox_pod_name)" -c agent --tail=30 2>&1 | sed 's/^/     agent: /' || true
fi
contains "the agent can write its workspace and /tmp" '^written$' \
  "$(in_sandbox 'echo kobe-25 > /workspace/kobe-25-marker && echo tmp > /tmp/kobe-25-marker && echo written')"

# Cold start. Gate 1 (D14) is hibernated → FIRST TOKEN p50 ≤ 3 s, p95 ≤ 8 s over 20 trials; with
# no model gateway yet (KOBE-30/40/41) the harness measures hibernated → Pi ready (agent
# reconnected, Pi answering on a thread), a lower bound of first token. Same budgets, honestly
# labelled; docs/ledger/KOBE-25.md records the numbers and the gap. A dedicated user gets its own
# sandbox (first wake: warm pool), so the harness never touches the e2e user's.
# The e2e budget is p95 ≤ 20 s (KOBE_COLD_START_P95_MS) since 2026-10-12, by the user's decision
# (KOBE-264); the D14 target stays 8 s.
# The suite shard leaves these trials to the cold-start shard (the audit check below still runs).
trials=0
if [[ "$SHARD" != suite ]]; then
COLD_USER_ID=9b4c3d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e
psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$COLD_USER_ID', 'E2E cold-start user', 'cold-start@e2e.test', true) ON CONFLICT DO NOTHING;
  INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$COLD_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
cold_start() { # label trials spacing-ms → harness output (one JSON line per trial + summary)
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/cold-start.js \
    --team-id "$E2E_TEAM_ID" --user-id "$COLD_USER_ID" --probe pi --label "$1" --trials "$2" \
    --spacing-ms "$3" --p95-max-ms "${KOBE_COLD_START_P95_MS:-20000}" \
    ${KOBE_COLD_START_P50_MS:+--p50-max-ms "$KOBE_COLD_START_P50_MS"} 2>&1 || true
}
trials="${KOBE_COLD_START_TRIALS:-20}"
cold=$(cold_start back-to-back "$trials" 0)
printf '%s\n' "$cold" | sed 's/^/     cold-start: /'
summary=$(printf '%s\n' "$cold" | grep '"summary":true' || true)
contains "cold-start harness ran $trials back-to-back hibernate → wake trials through the server's wake path" "\"trials\":$trials" "$summary"
# Gated on p95 (Gate 1's criterion); D14's p50 ≤ 3 s target is reported (summary line) and gated
# only when KOBE_COLD_START_P50_MS is set: Pi ready alone measures ≈ 3.5 s on CI (ledger).
contains "hibernated → Pi ready (not first token) p95 ≤ ${KOBE_COLD_START_P95_MS:-20000} ms (back-to-back)" '"pass":true' "$summary"
# Spaced trials: each wake starts after the sandbox sat fully down for a while (nothing of the
# previous pod's start is still in flight on the node).
spaced=$(cold_start spaced "${KOBE_COLD_START_SPACED_TRIALS:-5}" "${KOBE_COLD_START_SPACING_MS:-30000}")
printf '%s\n' "$spaced" | sed 's/^/     cold-start: /'
spaced_summary=$(printf '%s\n' "$spaced" | grep '"summary":true' || true)
contains "hibernated → Pi ready (not first token) p95 ≤ ${KOBE_COLD_START_P95_MS:-20000} ms (spaced trials)" '"pass":true' "$spaced_summary"
# Where an agent start spends its time (startup, session trade attempts, wire ready): last pod.
cold_pod=$($KUBECTL -n "$TEAM_NS" get pods -l "kobe.splittingatom.io/user-id=$COLD_USER_ID" -o name 2>/dev/null | head -1)
[[ -z "$cold_pod" ]] && cold_pod=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$COLD_USER_ID" -o jsonpath='pod/{.status.sandbox.name}' 2>/dev/null || true)
$KUBECTL -n "$TEAM_NS" logs "$cold_pod" -c agent 2>/dev/null \
  | grep -E 'sandbox-agent starting|sandbox session (acquired|retry)|sandbox wire ready' | head -6 | sed 's/^/     agent: /' || true
contains "the harness cleaned up its thread" '^0$' \
  "$(psql_kobe "SELECT count(*) FROM threads WHERE team_id = '$E2E_TEAM_ID' AND owner_user_id = '$COLD_USER_ID'")"
fi # cold-start trials

contains "an idle sandbox can be hibernated" '"hibernated":true' "$(lifecycle hibernate)"
contains "hibernation suspends the agent-sandbox Sandbox" '^Suspended$' \
  "$($KUBECTL -n "$TEAM_NS" get sandbox "${claim_sandbox:-none}" -o jsonpath='{.spec.operatingMode}' 2>&1)"
if until_ok 120 pod_gone; then ok "a hibernated sandbox has no pod"; else fail "a hibernated sandbox has no pod"; fi
contains "its /workspace volume is kept" '^Bound$' \
  "$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${claim_sandbox:-none}" -o jsonpath='{.status.phase}' 2>&1)"
contains "the server records it hibernated and closed its connection" '^hibernated\|0$' \
  "$(psql_kobe "SELECT s.state || '|' || (SELECT count(*) FROM sandbox_connections c WHERE c.team_id = s.team_id AND c.user_id = s.user_id AND c.closed_at IS NULL) FROM sandboxes s WHERE s.team_id = '$E2E_TEAM_ID' AND s.user_id = '$E2E_USER_ID'")"
contains "a hibernated sandbox can be woken" '"woken":true' "$(lifecycle wake)"
if until_ok 120 pod_running; then ok "waking starts a new pod"; else fail "waking starts a new pod"; fi
contains "the woken pod runs under gVisor" '^gvisor$' \
  "$($KUBECTL -n "$TEAM_NS" get pod "$(sandbox_pod_name)" -o jsonpath='{.spec.runtimeClassName}' 2>&1)"
if until_ok 120 wire_open; then ok "the woken sandbox reconnects"; else fail "the woken sandbox reconnects"; fi
contains "its /workspace survived hibernation" '^kobe-25$' "$(in_sandbox 'cat /workspace/kobe-25-marker')"
contains "its /tmp was wiped by hibernation" '^gone$' "$(in_sandbox 'test -e /tmp/kobe-25-marker && echo kept || echo gone')"
audit_counts=$(psql_kobe "SELECT (SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'sandbox.hibernated' AND target->>'trigger' = 'operator') >= $((trials + 1)) AND (SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'sandbox.woken') >= $((trials + 1))")
contains "every hibernation and wake is audited" '^t$' "$audit_counts"
if [[ "$SHARD" == cold-start ]]; then exit "$failed"; fi

