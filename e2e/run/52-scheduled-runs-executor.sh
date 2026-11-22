# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
# KOBE-116 (KOBE-72 ac-2): a chart upgrade that changes the team NetworkPolicy reaches a sandbox that
# is already awake, through the server's reconcile (KOBE-115), without waking or recreating it. The
# team policy's allow-list comes from sandbox.modelGatewayAccess: the upgrade first withdraws the
# model gateway (the sandbox must lose it), then allows it again (the sandbox must gain it, the
# "newly allowed service"). Last section: it rolls the server twice (the sandbox wire reconnects), so
# no run is leased across it; it needs only the e2e sandbox. Waits end on conditions (the reconcile
# log line of a server pod started by the upgrade, then a bounded reachability probe), never sleeps.
# KOBE-181 (65f of KOBE-65): scheduled runs end to end (e2e/scheduled-runs.sh): a skipped write
# reported, success and failure notified in-app and in Mailpit, and a deactivated member's schedule
# stops firing. Schedules are pulled due in Postgres; the e2e runner ticks every 5 s. Not repeated in
# the executor shard (nothing here depends on where Pi's tools run).
echo "==> scheduled runs (KOBE-181)"
if [[ "${KOBE_E2E_TOOL_EXECUTOR:-}" == 1 ]]; then
  echo "SKIP scheduled runs (KOBE-181: runs in the suite shard only)"
elif [[ -n "${KOBE_SANDBOX_IMAGE:-}" && "$(type -t chat_run)" == function && -n "${owner_id:-}" ]]; then
  source e2e/scheduled-runs.sh
  scheduled_run_checks
elif [[ "${CI:-}" == "true" ]]; then
  fail "the scheduled-run checks need KOBE_SANDBOX_IMAGE and the model setup"
else
  echo "SKIP scheduled runs (KOBE_SANDBOX_IMAGE not set)"
fi

# KOBE-168: cold start (hibernated → first token, first tool call) with the executor on or off, and
# KOBE-27 workspace sync with tools under the partner uid. Needs the model setup of the sections above.
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && "$(type -t chat_run)" == function ]]; then
  source e2e/executor/trials.sh
  executor_first_token_trials
  if [[ "${KOBE_E2E_TOOL_EXECUTOR:-}" == 1 ]]; then executor_sync_checks; fi
fi

