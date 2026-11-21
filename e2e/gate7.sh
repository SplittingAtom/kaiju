#!/usr/bin/env bash
# Gate 7 (KOBE-675, v1.3 Semantic Memory) on k3d: user stories U39-U54 (spec 4b0acbf3), one
# verdict per story. A story is proven by its API checks in a server pod (e2e/gate7/client/*.mjs:
# learning passes end to end with the fake model's scripted extractor, proposals, Site curation,
# Policy, switches, budgets, holds, break-glass) and, where it has some, its browser checks
# (Playwright in Chromium, e2e/browser: the memory specs written for its tickets and
# e2e/browser/tests/gate7/ for what they leave out). docs/gates/gate-7.md ("k3d checks") lists each
# story's checks and what is proven elsewhere (the relevance and extractor harnesses).
#
#   e2e/gate7.sh                      every story (after the gate1-prep install on k3d)
#   KOBE_GATE7_STORIES="U41 U47" ...  some stories
#   KOBE_GATE7_BROWSER=0 ...          API checks only; prints the browser command to run elsewhere,
#                                     whose report KOBE_GATE7_RESULTS=<results.json> then judges
#
# A real install: KOBE_GATE7_NS, _RELEASE, _CONTEXT, _MODEL (the fake's `fast` on k3d: the team
# default and the Site's learning model), _UNENABLED (a catalog alias the gate teams don't enable),
# _OWNER_EMAIL/_PASSWORD. It creates users gate7-{ad,m2,st,bd,ob}@gate7.test in teams gate7-a and
# gate7-b, joins the owner to gate7-a as a Team admin, and sets the Site's learning model. The
# extractor checks need the fake model (KOBE_GATE7_MODEL=fast): a real model is not scripted.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
NS="${KOBE_GATE7_NS:-kobe-dev}"
RELEASE="${KOBE_GATE7_RELEASE:-kobe}"
STORIES="${KOBE_GATE7_STORIES:-U39 U40 U41 U42 U43 U44 U45 U46 U47 U48 U49 U50 U51 U52 U53 U54}"
MODEL_ALIAS="${KOBE_GATE7_MODEL:-fast}"
UNENABLED="${KOBE_GATE7_UNENABLED:-gem}"
FAKE="${KOBE_GATE7_FAKE:-$([[ "$MODEL_ALIAS" == fast ]] && echo 1 || echo 0)}"
OWNER_EMAIL="${KOBE_GATE7_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATE7_OWNER_PASSWORD:-e2e owner password}"
BROWSER="${KOBE_GATE7_BROWSER:-$([[ "${CI:-}" == true ]] && echo 1 || echo 0)}"
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
NONCE="$(date +%s | tr 0-9 bcdfghjkmn)" # letters: a long number reads as a phone number (personal data)
USER_PASSWORD="gate1 user password" # the fixtures' password (e2e/gate1/client.mjs)
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATE7_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATE7_CONTEXT=$context)" >&2
  exit 2
fi
if [[ "$FAKE" != 1 ]]; then
  echo "Gate 7's learning checks script the fake model's extractor: run with KOBE_GATE7_MODEL=fast" >&2
  exit 2
fi

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=lib/gate-turns.sh
source e2e/lib/gate-turns.sh

# shellcheck disable=SC2034 # read by client() in gate-common.sh
CLIENT_JS="$(for f in e2e/gate1/client.mjs e2e/gate2/client.mjs e2e/gate3/client.mjs; do sed '/^const MODES = {/,$d' "$f"; done
  cat e2e/gate7/client/*.mjs)" # one file per scenario, run as one script: numeric prefixes fix the order (KOBE-728)
WORK=$(mktemp -d)
chmod 700 "$WORK"
PODS=()
UNDO=()
cleanup() {
  local rc=$?
  local u p
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  for u in "${UNDO[@]+"${UNDO[@]}"}"; do eval "$u" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
  verdict_on_exit "$rc" "Gate 7"
}
trap cleanup EXIT
want() { [[ " $STORIES " == *" $1 "* ]]; }
# A story's API section fails the story (not only the run), as in e2e/gate5.sh.
API_FAILED=" "
failed_before=0
api_begin() { failed_before=$failed; failed=0; }
api_end() { # story
  ((failed)) && API_FAILED+="$1 "
  ((failed_before)) && failed=1
  return 0
}

STORY_TEXT=(
  "U39|Learn for the thread author only (+ menu, /learn, Mod+Shift+L); a pass returns at most 10 candidates in To review with verified quotes; nothing is saved without a click."
  "U40|Saves apply with chip and Undo in this workspace only; portable preferences (after confirmation) reach the person's other workspaces; a portable fact is impossible."
  "U41|Incremental passes from the watermark on the visible branch; dismissals don't return; an existing item returns as an update with its old wording; a fork learns from its own messages."
  "U42|Workspace proposals reach curators; approval reaches every member's next run; outcome notified; 30-day expiry with re-propose."
  "U43|Curators (Team admins + stewards) save, edit, archive, pin (at most 10), tag, import with preview, export; 80% warns, 100% blocks; audited."
  "U44|Site proposals need a Team admin's confirmation; the Site reviewer sees statement, kind, justification, workspace and date only; request changes at most 3 rounds."
  "U45|Site curators approve, merge, reject with a reason; Policy (at most 2 KiB) renders first in every workspace even with the opt-out; contradicting saves blocked with an audited override."
  "U46|No seeded injection is offered at Workspace/Site scope; secrets blocked at every scope; the lint override audited; show_memory_item changes nothing; items change no tools or egress."
  "U47|memory_learn usage recorded; refused at 100% budget; an unenabled learning model fails clearly; memory off hides Notes and Memories and deletes nothing; the daily pass limit holds."
  "U48|Run detail lists the memories in context with versions; changes apply from the next run; picks are made per message."
  "U49|Retention settings; legal holds; offboarding keeps the person's memory; Site break-glass for portable preferences with audit in every workspace of the person."
  "U50|Without embeddings, retrieval is keyword only (FTS); the vector half is the relevance harness (gate-7a, gate-7d)."
  "U51|Notes, remember and recall(path) unchanged in the Notes tab; one bar icon and /memory remain; the guide and What's new cover the master-switch widening."
  "U52|Every pass records its prompt version and model; the extractor thresholds are the extractor harness (gate-7b)."
  "U53|Project-specific candidates offer Add to project notes through the signed approval; a forged approval is refused."
  "U54|'forget X' yields an Open in Memory chip; one click archives with Undo; the next run no longer receives it."
)
SPECS=(
  "U39|learn-from-chat.spec.ts gate7/u39-review.spec.ts"
  "U40|memory-editor.spec.ts gate7/u39-review.spec.ts"
  "U43|memory-consoles.spec.ts"
  "U44|site-proposals.spec.ts"
  "U45|memory-consoles.spec.ts"
  "U47|memory-quality-nudge.spec.ts"
  "U51|gate7/u51-notes.spec.ts"
  "U54|gate7/u54-forget.spec.ts"
)
specs_of() { printf '%s\n' "${SPECS[@]}" | grep "^$1|" | cut -d'|' -f2 || true; }
text_of() { printf '%s\n' "${STORY_TEXT[@]}" | grep "^$1|" | cut -d'|' -f2-; }

# ---- fixtures: teams gate7-a (ad, m2, st) and gate7-b (bd, ob); m2 joins b too ------------------
user_json() { # key team ip-suffix → fixture JSON
  printf '{"key":"%s","email":"gate7-%s@gate7.test","name":"Gate7 %s","team":"%s","ip":"198.51.100.%s"}' "$1" "$1" "$1" "$2" "$3"
}
echo "==> fixtures: teams gate7-a and gate7-b"
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":[%s,%s,%s,%s,%s],"teams":[{"key":"a","slug":"gate7-a","name":"Gate 7 A"},{"key":"b","slug":"gate7-b","name":"Gate 7 B"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" \
  "$(user_json ad a 71)" "$(user_json m2 a 72)" "$(user_json st a 73)" "$(user_json bd b 74)" "$(user_json ob b 75)")")
printf '%s\n' "$fx" | sed 's/^/     /'
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; }
TEAM_A=$(json_get a)
TEAM_B=$(json_get b)
declare -A UID_OF
for k in ad m2 st bd ob; do UID_OF[$k]=$(json_get "$k"); done
if [[ ! "$TEAM_A $TEAM_B ${UID_OF[ad]} ${UID_OF[m2]} ${UID_OF[st]} ${UID_OF[bd]} ${UID_OF[ob]}" =~ ^([0-9a-f-]{36}\ ){6}[0-9a-f-]{36}$ ]]; then
  fail "fixtures: the teams and their users"
  exit 1
fi
ok "fixtures: the teams and their users"
users_json() {
  local k team ip=70 sep="" s="{"
  for k in ad m2 st bd ob; do
    ip=$((ip + 1))
    team=$TEAM_A
    [[ $k == bd || $k == ob ]] && team=$TEAM_B
    s+=$(printf '%s"%s":{"key":"%s","email":"gate7-%s@gate7.test","ip":"198.51.100.%s","teamId":"%s","userId":"%s"}' "$sep" "$k" "$k" "$k" "$ip" "$team" "${UID_OF[$k]}")
    sep=","
  done
  printf '%s}' "$s"
}
COMMON=$(printf '"base":"%s","owner":{"email":"%s","password":"%s"},"nonce":"%s","teamA":"%s","teamB":"%s","alias":"%s","unenabledAlias":"%s","users":%s' \
  "$BASE" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$NONCE" "$TEAM_A" "$TEAM_B" "$MODEL_ALIAS" "$UNENABLED" "$(users_json)")
step() { client "{\"mode\":\"$1\",$COMMON}"; }
ensure_fake_llm
su=$(step g7-setup)
show "setup" "$su"
contains "the owner is a Team admin of gate7-a (the browser's user)" '^owner_team_admin=200:team_admin$' "$su"
contains "the second member belongs to gate7-b too" '^m2_in_b=200$' "$su"
contains "the Site's learning model is the fake ($MODEL_ALIAS)" "^learning_model=200:$MODEL_ALIAS\$" "$su"
contains "...and Bifrost has the models (gateway in sync)" '^gateway_in_sync=true$' "$su"
contains "...and Learn is available in gate7-a" "^learn_available=true:$MODEL_ALIAS\$" "$su"

# A story's checks: `story Uxx` runs its client step, then each `expect name regex` line.
OUT=""
story() { # Uxx label
  echo "==> $1 api: $2"
  OUT=$(step "g7-$(tr 'U' 'u' <<<"$1")")
  show "$1" "$OUT"
}
expect() { contains "$CUR: $1" "$2" "$OUT"; }

# ---- API checks -----------------------------------------------------------------------------------
if want U39; then
  api_begin
  CUR=U39
  story U39 "a pass over twelve scripted facts; quotes; nothing saved without a click; the author only"
  expect "the turn completes" '^turn=run.completed$'
  expect "the learning pass completes with the fake extractor's twelve, keeping ten" '^pass=completed:replied=12:stored=10:'
  expect "To review lists ten candidates" '^candidates=10$'
  expect "every quote is a verbatim span of the person's message" '^quotes_verified=10/10$'
  expect "nothing is saved before a click" '^saved_before_click=0$'
  expect "one click saves one memory" '^save_click=200:user$'
  expect "...and only that one" '^saved_after_click=1$'
  expect "a Team admin reading the shared thread gets read_only (state)" '^reader_state=403:read_only$'
  expect "...and cannot start a pass" '^reader_start=403:read_only$'
  api_end U39
fi
if want U40; then
  api_begin
  CUR=U40
  story U40 "save, Undo, this workspace only; portable after confirmation; no portable fact"
  expect "the pass completes" '^pass=completed:'
  expect "a preference may be portable" '^allowed_pref=.*portable'
  expect "a fact may not" '^allowed_fact=user(,team)?$'
  expect "the fact is saved for the person" '^save_fact=200:user$'
  expect "...in this workspace" '^fact_in_a=1$'
  expect "...and not in their other workspace" '^fact_in_b=0$'
  expect "Undo of the save" '^undo=200$'
  expect "...takes it back" '^fact_after_undo=0$'
  expect "portable needs the confirmation" '^portable_unconfirmed=400:'
  expect "a portable fact is refused" '^portable_fact=400:'
  expect "the confirmed preference is portable" '^portable_saved=200:portable$'
  expect "...listed in the person's other workspace" '^portable_in_b=1$'
  expect "...and given to a run there" '^portable_in_b_run=true$'
  api_end U40
fi
if want U41; then
  api_begin
  CUR=U41
  story U41 "watermark, dismissal, update with the old wording, visible branch, fork"
  expect "the first pass completes" '^pass1=completed:'
  expect "a candidate is saved" '^save_alpha=200$'
  expect "another is dismissed" '^dismiss_beta=200$'
  expect "the second pass completes" '^pass2=completed:'
  expect "...with the new message's candidate" '^pass2_has_gamma=true$'
  expect "...and not the dismissed one" '^pass2_has_beta=false$'
  expect "an existing memory returns as an update showing its current wording (the diff)" '^update_diff=update:target=true:1$'
  expect "nothing new since the watermark" '^nothing_new=409:nothing_to_learn$'
  expect "Rescan completes" '^pass3=completed:'
  expect "...and the dismissal holds" '^pass3_has_beta=false$'
  p2=$(field pass2_entries "$OUT")
  p3=$(field pass3_entries "$OUT")
  if [[ "$p2" =~ ^[0-9]+$ && "$p3" =~ ^[0-9]+$ ]] && ((p2 < p3)); then
    ok "U41: the incremental pass read only the new entries ($p2 of $p3)"
  else fail "U41: the incremental pass read only the new entries: got [$p2 of $p3]"; fi
  expect "a branch other than the one in view is refused" '^other_branch=409:not_current_branch$'
  expect "the thread is forked" '^fork=20[01]:'
  expect "the fork's Rescan completes" '^fork_pass=completed:'
  expect "...with its own message only, never the copied prefix" '^fork_candidates=delta=true,alpha=false,beta=false,gamma=false,alpha=false$'
  api_end U41
fi
if want U42; then
  api_begin
  CUR=U42
  story U42 "propose, curators, approval in every member's run, notices, expiry and re-propose"
  expect "the pass completes" '^pass=completed:'
  expect "a member cannot save to the workspace" '^member_save_team=4(00|03):'
  expect "...and proposes instead" '^propose=201:'
  expect "a proposal lives 30 days" '^expires_days=30$'
  expect "the curators' queue lists it" '^curator_queue=200:true$'
  expect "...and a curator is notified" '^curator_notified=true$'
  expect "a curator approves it" '^approve=200:'
  expect "...it is a Workspace memory" '^team_item=1$'
  expect "the proposer is notified of the outcome" '^proposer_notified=true$'
  expect "another member's next run is given it" '^member_run_has_it=true$'
  expect "a lapsed proposal may be proposed again" '^lapsed_may_repropose=true$'
  expect "...which its proposer does" '^repropose=201:'
  expect "...with a new 30-day clock" '^repropose_days=30$'
  api_end U42
fi
if want U43; then
  api_begin
  CUR=U43
  story U43 "steward rights, pins, import preview, export, limits, audit"
  expect "a Team admin names a memory steward" '^steward_grant=20[01]$'
  expect "the steward saves a Workspace memory" '^steward_create=201:'
  expect "...edits and tags it" '^steward_edit=200:gate7\|finance$'
  expect "...pins it" '^steward_pin=200:'
  expect "...archives it" '^steward_archive=200:'
  expect "a plain member cannot" '^member_create=403:memory_not_allowed$'
  expect "export" '^export=200:true$'
  expect "import preview" '^import_preview=200:'
  expect "the 11th pin is refused" '^pin_limit=11:409:memory_pin_limit$'
  expect "the scope cap blocks at 100%" '^cap_blocked=([0-9]+)/\1:409:memory_scope_full$'
  expect "the curators were told at 80%" '^near_full_notified=true$'
  expect "the steward's changes are audited" '^audited=.*memory\.'
  api_end U43
fi
if want U44; then
  api_begin
  CUR=U44
  story U44 "Site proposal: Team admin confirms; what the Site sees; three rounds"
  expect "the pass completes" '^pass=completed:'
  expect "a member proposes a candidate to the Site" '^site_propose=201:'
  expect "the Site queue doesn't have it before a Team admin confirms" '^site_queue_before_confirm=false$'
  expect "a steward cannot confirm" '^steward_confirm=40[34]:'
  expect "the Team admin confirms" '^admin_confirm=200:'
  expect "...then the Site queue has it" '^site_queue_after_confirm=true$'
  expect "the Site detail opens" '^site_detail=200$'
  expect "...with statement, kind, justification, workspace and date" '^site_detail_shows=statement,kind,justification,from_workspace,created_at$'
  expect "...and nothing of the conversation (probe: fields, ids, words)" '^site_detail_leaks=none$'
  expect "request changes three rounds, then decide" '^rounds=200:-,c200,200:-,c200,200:-,c200,409:'
  expect "the Site approves it" '^approve=200:'
  expect "...members read it as a Site memory" '^site_item_for_member=true$'
  api_end U44
fi
if want U45; then
  api_begin
  CUR=U45
  story U45 "approve, merge, reject with a reason; Policy budget, opt-out, contradiction"
  expect "approve" '^approve=200:'
  expect "merge into it" '^merge=200:'
  expect "...its next version" '^merged_version=200:2$'
  expect "a rejection needs a reason" '^reject_no_reason=400:'
  expect "reject with a reason" '^reject=200:'
  expect "...the proposer reads the reason" '^proposer_sees_reason=true$'
  expect "a Site admin sets Policy" '^policy=201:'
  expect "the Policy budget (2 KiB) refuses more" '^policy_budget=[1-5]:409:memory_policy_budget_full$'
  expect "gate7-b opts out of Site memories" '^opt_out=200$'
  expect "...its run is given Policy first" '^policy_first_b=policy:true$'
  expect "...and no other Site memory" '^site_lane_b=0$'
  expect "a contradicting save is blocked" '^contradiction=409:memory_policy_conflict$'
  expect "...until saved anyway" '^contradiction_anyway=201:'
  expect "...which is audited" '^override_audited=true$'
  api_end U45
fi
if want U46; then
  api_begin
  CUR=U46
  story U46 "injections, secrets, lint override, show_memory_item, no capability change"
  expect "the adversarial pass completes" '^pass=completed:'
  expect "only the genuine fact is offered to the workspace" '^shared_candidates=control$'
  expect "no injected statement is offered at any scope" '^adversarial_offered=0$'
  expect "a secret is refused at every scope" '^secrets=user=422:memory_secret,portable=422:memory_secret,team=422:memory_secret,site=422:memory_secret$'
  expect "an instruction is held for the lint tick" '^lint_warn=409:memory_lint_warning$'
  expect "...saved anyway" '^lint_saved=201:'
  expect "...and audited" '^lint_audited=true$'
  expect "show_memory_item answers" '^show_ok=true$'
  expect "...and changes nothing" '^show_unchanged=true:true:active$'
  expect "a pinned memory claiming powers is given to the run" '^power_in_context=true$'
  expect "...the run's tools are the same" '^tools_same=true:true$'
  expect "...and the egress rules are the same" '^egress_same=true$'
  api_end U46
fi
if want U47; then
  api_begin
  CUR=U47
  story U47 "usage, budget, learning model, master switch, daily limit"
  expect "the pass completes" '^pass=completed:'
  expect "its memory_learn call is in the usage records" '^learn_usage_rows=[1-9]'
  expect "a used-up member budget blocks Learn (state)" '^budget_blocker=budget_exhausted$'
  expect "...and refuses a pass" '^budget_refused=402:budget_exhausted$'
  expect "a learning model the workspace hasn't enabled is refused, no fallback" '^unenabled_alias=409:memory_learning_model_unavailable:'
  expect "...with a message saying why" '^unenabled_message=.{10,}'
  expect "a team override to an unenabled model is refused" '^team_override_unenabled=4[0-9][0-9]:'
  expect "memory off: Notes and Memories off" '^effective_off=notes=false:memories=false$'
  expect "...the run has no memory tools" '^off_tools=no memory tools$'
  expect "...and no personal memories" '^off_context_user=0$'
  expect "...and turning it on again finds every memory" '^items_kept=true:'
  expect "the 21st pass in a day is refused" '^rate_limited=429:learn_rate_limited$'
  api_end U47
fi
if want U48; then
  api_begin
  CUR=U48
  story U48 "memories in context with versions; next run; per-message picks; owner only"
  expect "the run is given the matching memory, version 1" '^run1=200:user:v1$'
  expect "an edit" '^edit=200:'
  expect "...applies from the next run (version 2)" '^run2=v2:true:run_changed=true$'
  expect "a message that doesn't match leaves it out" '^run3_has_it=false$'
  expect "a reader of the shared thread is refused" '^reader_context=403:not_owner$'
  api_end U48
fi
if want U49; then
  api_begin
  CUR=U49
  story U49 "retention, legal hold, offboarding, portable break-glass"
  expect "the Site memory retention setting" '^retention_days=[0-9]+$'
  expect "the Site retention table" '^site_retention=200$'
  expect "the workspace retention" '^team_retention=200:'
  expect "a legal hold on one person is placed" '^hold_active=200:active$'
  expect "the person is removed from the workspace" '^remove_member=20[04]$'
  expect "...and listed as offboarded" '^offboarded_listed=200:true$'
  expect "...their personal memory is kept" '^ob_items_kept=[1-9]'
  expect "the hold is released (two-step)" '^hold_released=200:released$'
  expect "Site break-glass for portable memories is approved" '^grant_approve=200:(approved|active)$'
  expect "...reads the person's portable preferences" '^grant_read=200:true$'
  expect "...audited in every workspace of the person" '^read_audited=a=[1-9][0-9]*,b=[1-9][0-9]*$'
  expect "...and revoked" '^grant_revoke=200$'
  api_end U49
fi
if want U50; then
  api_begin
  CUR=U50
  story U50 "no embedding model: keyword retrieval"
  expect "no embedding model on this install" '^vectors=200:model=none:'
  expect "a keyword match is picked" '^keyword_pick=true$'
  expect "a paraphrase with no shared word is not (keyword only)" '^paraphrase_pick=false$'
  api_end U50
fi
if want U51; then
  api_begin
  CUR=U51
  story U51 "remember, recall(path), the Notes document, the tools"
  expect "remember completes" '^remember=run.completed$'
  expect "...and writes a personal note" "^memory_updated=user:notes/gate7-$NONCE.md:v1\$"
  expect "recall(path) reads it back" '^recall=run.completed:true$'
  expect "the Notes API shows it" '^notes_doc=200:true$'
  expect "remember, recall and show_memory_item are the run's memory tools" '^tools=remember=true,recall=true,show_memory_item=true$'
  api_end U51
fi
if want U52; then
  api_begin
  CUR=U52
  story U52 "what every pass records"
  expect "the gate's passes are recorded" '^passes=[1-9]'
  expect "...each with its prompt version and model" '^recorded=true$'
  expect "...on the fake learning model" "^versions=memory-extractor-v[0-9]+/$MODEL_ALIAS"
  expect "Learn's pass numbers for curators" '^quality_passes=200:'
  api_end U52
fi
if want U53; then
  api_begin
  CUR=U53
  story U53 "a project fact to the project's notes"
  expect "a project" '^project=201:'
  expect "the pass completes" '^pass=completed:'
  expect "the project fact's destination is the project's notes" '^destination=project_notes$'
  expect "...which the author may add to" '^notes_status=true:'
  expect "the preview signs the change" '^preview=200:Learned$'
  expect "a forged approval is refused" '^forged=403:'
  expect "the signed approval adds it" '^added=200:[0-9]+$'
  expect "...to the project's notes" '^notes_has_line=200:true$'
  api_end U53
fi
if want U54; then
  api_begin
  CUR=U54
  story U54 "show the memory, archive with Undo, the next run"
  expect "show_memory_item (the chip's call) succeeds" '^show_result=true$'
  expect "archive" '^archive=200:'
  expect "Undo" '^undo=200:'
  expect "archive again" '^archive_again=200:'
  expect "the next run is not given it" '^next_run_has_it=false$'
  api_end U54
fi
# ---- the browser checks -----------------------------------------------------------------------------
files=()
for s in $STORIES; do
  for f in $(specs_of "$s"); do
    [[ " ${files[*]-} " == *" $f "* ]] || files+=("$f")
  done
done
PUBLIC_URL=$($KUBECTL -n "$NS" exec "$SERVER" -c server -- printenv KOBE_PUBLIC_URL 2>/dev/null || true)
FORGET_ID=""
FORGET_TEXT=""
if want U54; then
  bi=$(step g7-browser-item)
  FORGET_ID=$(field browser_item "$bi" | sed -n 's/^201://p')
  FORGET_TEXT=$(field browser_item_text "$bi")
fi
browser_env() { # the variables the specs read, except the passwords
  printf 'KOBE_BASE_URL=%s KOBE_USER=%s KOBE_USER2=gate7-m2@gate7.test KOBE_USER3=gate7-ad@gate7.test KOBE_TEAM=gate7-a KOBE_FAKE_MODEL=1 KOBE_GATE7_FORGET_ITEM=%s' \
    "$PUBLIC_URL" "$OWNER_EMAIL" "$FORGET_ID"
}
RESULTS="${KOBE_GATE7_RESULTS:-}"
if ((${#files[@]} == 0)); then
  :
elif [[ "$BROWSER" == 1 ]]; then
  echo "==> browser: ${#files[@]} spec files in Chromium against $PUBLIC_URL"
  map="${KOBE_GATE7_BROWSER_MAP:-}"
  if [[ -z "$map" && "$context" == k3d-* ]]; then
    # Chromium beside kubectl reaches the ingress through a port-forward, under the site's own origin.
    $KUBECTL -n kube-system port-forward svc/traefik 18080:80 >"$WORK/port-forward.log" 2>&1 &
    pf=$!
    UNDO+=("kill $pf")
    map=127.0.0.1:18080
    ingress_up() { curl -s -o /dev/null -m 3 -H "Host: ${PUBLIC_URL#*://}" "http://$map/v1/setup"; }
    until_ok 30 ingress_up || echo "     the port-forward to the ingress did not answer: $(tail -2 "$WORK/port-forward.log")"
  fi
  RESULTS="$WORK/results.json"
  # shellcheck disable=SC2046 # browser_env is a list of NAME=value words
  (cd e2e/browser && env $(browser_env) KOBE_PW="$OWNER_PASSWORD" KOBE_PW2="$USER_PASSWORD" KOBE_PW3="$USER_PASSWORD" \
    KOBE_GATE7_FORGET_TEXT="$FORGET_TEXT" KOBE_BROWSER_MAP="$map" KOBE_BROWSER_RESULTS="$RESULTS" \
    npx playwright test "${files[@]}" >"$WORK/playwright.log" 2>&1) || true
  grep -E '✓|✘|-  |passed|failed|skipped|flaky' "$WORK/playwright.log" | tail -60 | sed 's/^/     /' || true
elif [[ -z "$RESULTS" ]]; then
  echo "skip browser checks (KOBE_GATE7_BROWSER=$BROWSER); run them where Chromium reaches $PUBLIC_URL, then judge with KOBE_GATE7_RESULTS=<results.json>:"
  echo "     cd e2e/browser && npm ci && npx playwright install chromium && $(browser_env) KOBE_GATE7_FORGET_TEXT='$FORGET_TEXT' KOBE_PW=<the owner's password> KOBE_PW2=<the fixtures' password> KOBE_PW3=<same> KOBE_BROWSER_RESULTS=<results.json> npx playwright test ${files[*]}"
fi

# ---- verdict -----------------------------------------------------------------------------------------
proven=0
xfailed_stories=0
echo "==> Gate 7: user stories $STORIES"
for s in $STORIES; do
  specs=$(specs_of "$s")
  lines=""
  if [[ -z "$specs" ]]; then
    lines="ok   $s: API checks only (no browser surface beyond the specs of other stories)"
  elif [[ -n "$RESULTS" ]]; then
    # shellcheck disable=SC2086 # the story's spec files
    lines=$(node e2e/gate5/verdict.mjs "$RESULTS" $specs)
  else
    lines="NOTRUN $s browser checks: not run here"
  fi
  echo "==> $s: browser"
  printf '%s\n' "$lines"
  verdict=ok
  [[ "$API_FAILED" == *" $s "* ]] && verdict=FAIL && echo "       its API checks failed (above)"
  grep -qE '^(FAIL|XPASS|INVALID|NOTRUN) ' <<<"$lines" && verdict=FAIL
  [[ "$verdict" == ok ]] && grep -q '^XFAIL ' <<<"$lines" && verdict=XFAIL
  [[ "$verdict" == XFAIL && "${KOBE_GATE_STRICT:-0}" == 1 ]] && verdict=FAIL
  case "$verdict" in
    ok) echo "PASS $s $(text_of "$s")"; proven=$((proven + 1)) ;;
    XFAIL) echo "XFAIL $s $(text_of "$s")"; xfailed_stories=$((xfailed_stories + 1)) ;;
    *) echo "FAIL $s $(text_of "$s")"; failed=1 ;;
  esac
done
n=$(wc -w <<<"$STORIES" | tr -d ' ')
if ((failed)); then
  # The server's own account of failed passes, for the log.
  $KUBECTL -n "$NS" logs -l app.kubernetes.io/component=server -c server --tail=-1 --since=60m 2>/dev/null \
    | grep -E 'learning pass failed|"level":(40|50)' | tail -30 | cut -c1-400 | sed 's/^/     server: /' || true
  verdict "Gate 7: FAILED ($proven of $n stories proven; the API checks above count too)"
  exit 1
fi
if ((xfailed_stories)); then
  verdict "Gate 7: $proven of $n stories proven, $xfailed_stories with expected failures (filed; KOBE_GATE_STRICT=1 fails them)"
else
  verdict "Gate 7: all $n stories proven"
fi
