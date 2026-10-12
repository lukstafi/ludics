#!/usr/bin/env bash
# Focused fixture tests for what the WAIT LOOP of `pr-review.sh base --wait` DECIDES, and the swap
# that decides a verdict (ludics-lite#93).
#
# The red-report and settle suites pin the report (#81) and the tip's absence (#156). This one is
# about the VERDICT: which break ends the wait, what each break re-confirms before it trusts what
# it read, where the absence clock starts, and which run in a workflow's window the verdict is
# taken from — the newest JUDGED one, since under cancel-in-progress concurrency the newest
# completed run on a busy default branch is routinely `cancelled`, stopped and not judged.
#
# Every break here re-confirms the tip before it acts, because the branch moves under a wait as a
# matter of course, and a verdict reported for a commit that is no longer the tip is worse than no
# verdict: it sends the caller fixing a fix already in flight, or branching off a green that was
# about the commit before theirs.
#
# The fixture transport is test-pr-review-base-lib.sh, shared with the red-report and settle
# suites (ludics-lite#179). Three cases here are on the clock, and the idiom that keeps them
# honest — `spend_grace`, `at_round` and `runs_from_round`, `rounds_polled`, a wait ended by an
# event under `EVENT_CEILING` — is written down in that file's header.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=test-pr-review-lib.sh
source "$SCRIPT_DIR/test-pr-review-lib.sh"
# shellcheck source=test-pr-review-base-lib.sh
source "$SCRIPT_DIR/test-pr-review-base-lib.sh"

# One brace group over everything below the preamble, so bash parses the rest of this file WHOLE
# before the first case runs and an edit landing mid-run cannot resume the shell at a shifted
# offset; the `exit` at the foot means it never comes back to the file for a next command
# (ludics-lite#10, #247). The `{` opens BELOW the sources, not above them: bash binds a function's
# `declare -F` location when it PARSES the definition, so inside a group that also holds the
# sources every definition here is parsed first and the libraries' bindings land last -- and the
# shadow guard (ludics-lite#46) then reads every suite function as still the library's, refusing a
# declared stub and accepting an undeclared shadow in silence. scripts/check-parse-guards.sh
# checks the shape, and says what may stand above the `{`.
{

# --- what the WAIT LOOP decides, and the swap that decides a verdict (ludics-lite#93) ----------
# The cases above pin the red REPORT (#81) and the settle (#156). What follows is the VERDICT:
# which break ends the wait, what each break re-confirms before it trusts what it read, where the
# absence clock starts, and which run in a workflow's window is the one the verdict is taken from.

# A red AT THE TIP is the tip's own verdict, so nothing is owed to the wait any more: it ends on
# the round that saw it, without spending the ceiling on a workflow still running beside it. The
# second workflow here is in flight at the tip, so the covered break cannot be what ended this —
# only the red one can.
test_a_red_at_the_tip_ends_the_wait_at_once() {
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"fixtures"}]')
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[{conclusion:"failure", head_sha:$c, id:6011}, {conclusion:"success", head_sha:$a, id:6010}]')")
  RUNS_2=$(runs_json 2 "$(jq -cn --arg c "$SHA_C" \
    '[{status:"in_progress", conclusion:null, head_sha:$c, id:6012, name:"fixtures"}]')")
  run_base --wait=4
  assert_eq "$BASE_RC" 1 "a red at the tip is a verdict for the tip, and the wait is over"
  assert_contains "$BASE_OUTPUT" "is RED" "the red headline is what a red tip gets"
  assert_not_contains "$BASE_OUTPUT" "NO VERDICT" \
    "the tip HAS a verdict here; the run still going beside it does not take it away"
  assert_eq "$(rounds_polled)" 1 \
    "the red should end the wait on the round that saw it, not after another poll"
}

# ... and that break re-confirms the tip first, for the reason the green break does: a fix-forward
# push landing between the round's tip read and this check turns the red into an OLDER tip's red,
# which is exactly the shape the wait exists to keep waiting on. Breaking anyway would report RED
# for a commit that has no verdict yet and send the caller fixing a fix already in flight.
#
# The wait is ENDED by the successor's own verdict on round three, not by a ceiling (#375): a
# ceiling sized to land after round one can land inside it on a slow runner, and then the headline
# is round one's, about the tip that moved.
test_the_red_break_reconfirms_the_tip() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{status:"in_progress", conclusion:null, head_sha:$b, id:6022},
      {conclusion:"failure", head_sha:$c, id:6021},
      {conclusion:"success", head_sha:$a, id:6020}]')")
  # The round reads SHA_C and sees its red; the re-confirm, after that round's own reads, gets
  # the successor. Round two waits on the successor's run, and round three reads its verdict.
  at_round 1 "$SHA_B"
  runs_from_round 3 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{conclusion:"success", head_sha:$b, id:6022},
      {conclusion:"failure", head_sha:$c, id:6021},
      {conclusion:"success", head_sha:$a, id:6020}]')"
  run_base --wait="$EVENT_CEILING"
  assert_eq "$BASE_RC" 0 "the red belonged to a tip that moved, and the successor's own run judged it ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_B:0:8})" \
    "the verdict is the successor's, from its own run"
  assert_not_contains "$BASE_OUTPUT" "is RED" \
    "a red under a moved tip must not headline as the tip's own verdict"
  assert_eq "$(rounds_polled)" 3 \
    "round one's red was not broken on, round two waited on the successor's run, round three read it"
}

# The green break's own re-confirm: coverage is judged against the tip read BEFORE the runs, and a
# sibling merge landing in that window is the integration loop's ordinary traffic. Accepting the
# coverage anyway hands out "green (tip X)" for a branch already pointing at Y. Ended, as above, by
# the successor's own run on round two rather than by a ceiling.
test_the_covered_break_reconfirms_the_tip() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6031}]')")
  at_round 1 "$SHA_B" # everything after the round's own reads answers the successor
  runs_from_round 2 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" \
    '[{conclusion:"success", head_sha:$b, id:6032}, {conclusion:"success", head_sha:$c, id:6031}]')"
  COMPARE_COMMITS=$(jq -cn --arg b "$SHA_B" '[$b]')
  FILES_DEFAULT='[{"filename":"src/main.ml"}]' # the successor is unrecognized: nothing settles it
  run_base --wait="$EVENT_CEILING"
  assert_eq "$BASE_RC" 0 "the successor's own green is its verdict ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_B:0:8})" "and it is about the successor"
  assert_not_contains "$BASE_OUTPUT" "green (tip ${SHA_C:0:8})" \
    "the tip that moved under the round must never be broken green for"
  assert_eq "$(rounds_polled)" 2 "round one's coverage was not broken on, and round two's was"
}

# The absence clock starts at the last time the TIP MOVED. A merge landing after the grace has
# already elapsed would otherwise be declared integration-green on the spot — its run not yet
# created and the timer long spent — which is a green for a commit nothing has built.
#
# This is the idiom test-pr-review-base-lib.sh writes down: the clock in an explicit delay, the
# event on a counted round, the wait ended by an event and not by its ceiling. The first tip read
# answers SHA_C after a delay as long as the grace, and every read from that round's runs read on
# answers the successor. Round one therefore cannot break — its re-confirm, whichever break
# reaches it, sees a tip that moved — and round two is where the two clocks part. Restarted with
# the successor, the grace is stamped by round two itself and cannot have run out in it, so the
# settle comes on round three or later, however long a round takes. Measured from the start of the
# wait, it ran out during the delay, and round two settles. The settle is what ends the wait, so
# no ceiling has to be sized against a round (#375: a six-second one landed inside round one on
# the Git Bash runner).
test_a_tip_that_moves_mid_wait_restarts_the_grace() {
  reset_fixture
  retune ABSENT_GRACE=4 CHECKS_INTERVAL=1
  RUNS_1=$(runs_json 1 "$(jq -cn --arg a "$SHA_A" '[{conclusion:"success", head_sha:$a, id:6061}]')")
  FILES_DEFAULT='[{"filename":"src/main.ml"}]' # unrecognized: only the clock can settle this
  spend_grace 4
  at_round 1 "$SHA_B"
  run_base --wait="$EVENT_CEILING"
  assert_eq "$BASE_RC" 0 "the successor's grace runs out inside the wait ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_B:0:8})" \
    "and the settle is for the successor, the tip that is actually there"
  assert_contains "$BASE_OUTPUT" "no run for the tip appeared" \
    "the wait ends on the successor's own grace running out, not at its ceiling"
  assert_not_contains "$BASE_OUTPUT" "--wait ceiling" "the ceiling is a safety net, not the event"
  local rounds
  rounds=$(rounds_polled)
  [ "$rounds" -ge 3 ] ||
    bail "a grace that restarted with the successor cannot run out on the round that restarted it (settled on round $rounds)"
}

# The `norun` ambiguity, with every OTHER workflow judged at the tip: a listed workflow with no
# push run on this branch is either dispatch- or schedule-only (never coming) or a workflow the
# tip itself just added (on its way). What separates them is whether that newcomer has had its
# creation window SINCE THE PUSH — and the push time is read off the sibling runs AT THE TIP, not
# off the wait's own observation clock. The three cases below differ in nothing but that
# timestamp, which is the whole claim.
test_the_norun_ambiguity_is_settled_by_the_tips_own_age() {
  local now_iso
  now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Old tip, workflow with no history: dispatch-only, and the wait breaks green at once. Reading
  # the observation clock instead would hold every late-started wait for the full grace.
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"nightly"}]')
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" \
    '[{conclusion:"success", head_sha:$c, id:6051, created_at:"2026-09-10T00:00:00Z"}]')")
  RUNS_2=$(jq -cn '{workflow_runs: []}')
  run_base --wait=4
  assert_eq "$BASE_RC" 0 "a tip older than the creation window is not waiting on a newcomer"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_C:0:8})" \
    "a repository carrying a dispatch-only workflow must not park every wait on it"
  assert_eq "$(rounds_polled)" 1 "and it must not spend a single extra round on it"

  # Same shape, a tip pushed just now: the newcomer's first run may still be on its way, and
  # breaking green here would hand out an all-clear over a workflow that has judged nothing.
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"nightly"}]')
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg n "$now_iso" \
    '[{conclusion:"success", head_sha:$c, id:6052, created_at:$n}]')")
  RUNS_2=$(jq -cn '{workflow_runs: []}')
  run_base --wait=2
  assert_eq "$BASE_RC" 4 "a tip inside the creation window is still owed the newcomer's first run"
  assert_contains "$BASE_OUTPUT" "NO VERDICT for the tip ${SHA_C:0:8}" "the refusal stands"

  # And an age that cannot be read is not evidence to hold on: holding on it would park the wait
  # on a shape drift rather than on a workflow.
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"nightly"}]')
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" \
    '[{conclusion:"success", head_sha:$c, id:6053, created_at:"-"}]')")
  RUNS_2=$(jq -cn '{workflow_runs: []}')
  run_base --wait=2
  assert_eq "$BASE_RC" 0 "an unreadable timestamp holds nothing"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_C:0:8})" \
    "the coverage in hand is what the verdict is taken from"
}

# Under cancel-in-progress concurrency the newest COMPLETED run on a busy default branch is
# routinely `cancelled` — stopped, not judged. The verdict is the newest JUDGED run, so a red
# underneath a cancelled one still stands: reading the cancellation as the answer would turn a
# broken base into "no verdict" and let a worker branch off it.
test_a_red_under_a_cancelled_run_at_the_tip_still_stands() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[{conclusion:"cancelled", head_sha:$c, id:6041},
      {conclusion:"failure", head_sha:$c, id:6040},
      {conclusion:"success", head_sha:$a, id:6039}]')")
  JOBS_6040=$(jobs_json '[{"name":"fixtures (ubuntu)","conclusion":"failure"}]')
  run_base
  assert_eq "$BASE_RC" 1 "the newest judged run is red, and a cancellation over it judged nothing"
  assert_contains "$BASE_OUTPUT" "is RED" "the red is the verdict"
  assert_contains "$BASE_OUTPUT" \
    "(newest completed run: cancelled at ${SHA_C:0:8}, stopped not judged — verdict above is the newest judged run)" \
    "the cancelled run stays on the report as context for the verdict it did not give"
  assert_contains "$BASE_OUTPUT" "failed job(s): fixtures (ubuntu) (failure)" \
    "the jobs read is anchored on the judged red, not on the cancelled run over it"
  assert_not_contains "$BASE_OUTPUT" "NO VERDICT" "a judged red is a verdict"

  # The swap is about the newest JUDGED run, whichever way it went: a green under the cancellation
  # is the tip's coverage, and dropping it would leave the tip unjudged over a run that passed.
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" \
    '[{conclusion:"cancelled", head_sha:$c, id:6043}, {conclusion:"success", head_sha:$c, id:6042}]')")
  run_base
  assert_eq "$BASE_RC" 0 "a green under a cancelled re-run is still the tip's verdict"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_C:0:8})" "and the tip is covered by it"
  assert_contains "$BASE_OUTPUT" "stopped not judged" "the cancelled run is still named"
}

# Under --wait the tip is the QUESTION — which commit needs the verdict — so a tip read that
# failed cannot be waited through: the wait would idle to the absent-run grace and then settle for
# an older green, exit 0, never having known what it was waiting for. Without --wait the same read
# only decorates the report, and its failure costs the "not the tip" notes and nothing else.
test_an_unreadable_tip_is_unknown_under_wait_and_decoration_without_it() {
  reset_fixture
  retune API_ATTEMPTS=1
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6081}]')")
  FAIL_ENDPOINT="repos/$REPO/commits/$BRANCH"
  run_base --wait=2
  assert_eq "$BASE_RC" 3 "a wait that cannot read the tip is UNKNOWN, which is not a verdict"
  assert_contains "$BASE_OUTPUT" "base --wait cannot know" "the refusal should say what is missing"
  assert_not_contains "$BASE_OUTPUT" "$REPO $BRANCH: green" \
    "no green headline may come out of a tip nobody read"

  reset_fixture
  retune API_ATTEMPTS=1
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6082}]')")
  FAIL_ENDPOINT="repos/$REPO/commits/$BRANCH"
  run_base
  assert_eq "$BASE_RC" 0 "the plain read's verdict comes from the runs, not from the tip"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green" "the green stands, without a tip to name"
  assert_not_contains "$BASE_OUTPUT" "cannot know" "nothing was being waited for"
}

# Two pushes to this branch inside one second give their runs the same `created_at`, and GitHub
# documents no order between them. The fold below keeps the first row of each workflow it sees, so
# an undocumented order used to decide the verdict: here the tie is a green and a red at the tip,
# and the RED is the later allocation (the higher run id). Ordering the rows on (created_at desc,
# id desc) before the fold settles it the same way run_signal has since ludics-lite#83.
test_a_same_second_tie_goes_to_the_higher_run_id() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[{conclusion:"success",  head_sha:$c, id:6071, created_at:"2026-09-10T00:30:00Z"},
      {conclusion:"failure",  head_sha:$c, id:6072, created_at:"2026-09-10T00:30:00Z"},
      {conclusion:"success",  head_sha:$a, id:6070, created_at:"2026-09-10T00:29:00Z"}]')")
  JOBS_6072=$(jobs_json '[{"name":"syntax, shellcheck","conclusion":"failure"}]')
  run_base
  assert_eq "$BASE_RC" 1 "the later of two runs created in one second is the verdict, and it is red"
  assert_contains "$BASE_OUTPUT" "is RED" "the tie must not be decided by the feed's own order"
  assert_contains "$BASE_OUTPUT" "red since ${SHA_C:0:8}" "the red starts at the tip"
  assert_contains "$(cat "$REQUEST_LOG")" "actions/runs/6072/jobs" \
    "the jobs read follows the run the tie was settled for"
  assert_not_contains "$(cat "$REQUEST_LOG")" "actions/runs/6071/jobs" \
    "the superseded row of the tie is not what the report is about"
}

# A branch whose pushes never cancel each other (no concurrency group, or one keyed on the commit, as
# skill-scripts.yml's main was from ludics-lite#511 to #597) has runs for two merges going at once,
# finishing in either order.
# The fold reads them by creation, never by finish: the newer merge's finished run is the verdict
# whether the older run is still going or finished red after it (the newer tree holds that merge),
# and an older merge's red while the tip's run is going is that merge's red, not the tip's.
test_overlapping_push_runs_are_read_by_creation_not_by_finish() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" \
    '[{conclusion:"success", head_sha:$c, id:6091},
      {status:"in_progress", conclusion:null, head_sha:$b, id:6090}]')")
  run_base --wait=2
  assert_eq "$BASE_RC" 0 "the tip's own green covers it while an older merge's run is still going"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_C:0:8})" "the verdict is the tip's"
  assert_eq "$(rounds_polled)" 1 "and the older run going is not waited for"

  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" \
    '[{conclusion:"success", head_sha:$c, id:6093}, {conclusion:"failure", head_sha:$b, id:6092}]')")
  run_base
  assert_eq "$BASE_RC" 0 \
    "an older merge's red that finished after the tip's green does not displace it"
  assert_not_contains "$BASE_OUTPUT" "RED" "the tip's tree holds that merge and passed"

  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{status:"in_progress", conclusion:null, head_sha:$c, id:6096},
      {conclusion:"failure", head_sha:$b, id:6095}, {conclusion:"success", head_sha:$a, id:6094}]')")
  JOBS_6095=$(jobs_json '[{"name":"fixtures (ubuntu)","conclusion":"failure"}]')
  run_base
  assert_eq "$BASE_RC" 1 "an older merge's red is a red on the branch while the tip's run is going"
  assert_contains "$BASE_OUTPUT" "failure at ${SHA_B:0:8}" "and it is that merge's red"
  assert_contains "$BASE_OUTPUT" "(ci is running now at ${SHA_C:0:8})" \
    "with the tip's run named as going"
}

# shared_group_burst <tip run> <older run>: a shared push group's burst as one round reads it,
# newest first -- the tip's run, three merges' cancelled runs, the older merge's run, and the green
# before the burst.
shared_group_burst() {
  local d=dddddddddddddddddddddddddddddddddddddddd e=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
  jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg d "$d" --arg e "$e" --arg a "$SHA_A" --arg z "$SHA_0" \
    --argjson tip "$1" --argjson older "$2" \
    '[$tip + {head_sha:$c, id:6156},
      {conclusion:"cancelled", head_sha:$b, id:6155},
      {conclusion:"cancelled", head_sha:$d, id:6154},
      {conclusion:"cancelled", head_sha:$e, id:6153},
      $older + {head_sha:$a, id:6152},
      {conclusion:"success", head_sha:$z, id:6151}]'
}

# Pushes sharing one group with `cancel-in-progress: false` (skill-scripts.yml's main since
# ludics-lite#597; OCANNL's `ci`): a burst leaves one run going at an older merge, the tip's run
# pending behind it, and the merges between them with `cancelled` runs, each replaced while it was
# pending. The integration loop reads `base --wait` WITHOUT --interim, and none of those
# cancellations may read red or hold the verdict: the wait ends on the tip's own run, whichever way
# it goes, and a red there names the floor under the cancelled span, where attribution starts.
# (Under --interim the same shape is test-pr-review-base-pushless.sh's
# test_interim_in_a_group_that_does_not_cancel: held while the older run judges, answered once it
# finished green.)
test_a_shared_push_group_burst_is_judged_by_the_tips_own_run() {
  local tip_concl
  for tip_concl in success failure; do
    reset_fixture
    RUNS_1=$(runs_json 1 "$(shared_group_burst '{"status":"pending","conclusion":null}' '{"status":"in_progress","conclusion":null}')")
    runs_from_round 2 1 "$(shared_group_burst '{"status":"in_progress","conclusion":null}' '{"conclusion":"success"}')"
    runs_from_round 3 1 "$(shared_group_burst "{\"conclusion\":\"$tip_concl\"}" '{"conclusion":"success"}')"
    JOBS_6156=$(jobs_json '[{"name":"bash 3.2 suites (macos)","conclusion":"failure"}]')
    run_base --wait="$EVENT_CEILING"
    assert_eq "$(rounds_polled)" 3 "the wait ends on the round the tip's own run finished ($tip_concl)"
    assert_not_contains "$BASE_OUTPUT" "NO VERDICT" "the cancelled runs hold no verdict ($tip_concl)"
    case $tip_concl in
    success)
      assert_eq "$BASE_RC" 0 "the tip's own green is the verdict over the cancelled span ($BASE_OUTPUT)"
      assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_C:0:8})" "about the tip"
      assert_not_contains "$BASE_OUTPUT" "RED" "a cancelled run is never a red"
      ;;
    failure)
      assert_eq "$BASE_RC" 1 "the tip's own red is the verdict ($BASE_OUTPUT)"
      assert_contains "$BASE_OUTPUT" "RED      ci — failure at ${SHA_C:0:8}" "and it is the tip's"
      assert_contains "$BASE_OUTPUT" \
        "red since ${SHA_C:0:8} (run created" "the cancelled runs end no streak"
      assert_contains "$BASE_OUTPUT" \
        "1 run(s) back; the judged run before it was not red (success at ${SHA_A:0:8})" \
        "the floor of the span to attribute is the older run's green, under every cancelled merge"
      ;;
    esac
  done
}

# --- lessons of the fix rounds, pinned before the port (ludics-lite#403) ------------------------
# Each case below pins a rule a review round wrote into cmd_base that no case read until the v2
# rewrite went looking: the rewrite must not quietly drop one.

# base_call <args...>: `base` with exactly these arguments, no branch prepended (run_base names
# BRANCH first), captured the way run_base captures it.
base_call() {
  set +e
  BASE_OUTPUT=$(cmd_base "$@" 2>&1)
  BASE_RC=$?
  set -e
}

# A branch name carries slashes (`claude/topic`), and once the repository is named the first
# slashed argument is the BRANCH, never a second repository (ludics-lite ffefd9a): read as the repo
# it turned `base --repo owner/name claude/topic` into a 404 on repo "claude/topic".
test_a_slashed_branch_is_the_branch_when_the_repo_is_named() {
  local BRANCH=claude/topic
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6101}]')")
  run_base
  assert_eq "$BASE_RC" 0 "the slashed branch is read as the branch ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "$REPO claude/topic: green (tip ${SHA_C:0:8})" \
    "the verdict is about that branch of the named repository"
  assert_contains "$(cat "$REQUEST_LOG")" "repos/$REPO/commits/claude/topic" \
    "and the tip is read from the named repository, the slash kept literal"
}

# A branch name is data, not URL structure (f46932e): `#` would cut the request at a fragment and
# `&` would split the query, so every byte outside the unreserved set is percent-encoded, a UTF-8
# name byte by byte, while `/` stays literal. The fixture's endpoints carry the encoded form.
test_a_branch_name_is_percent_encoded() {
  local BRANCH='rel%231%26x%C3%A9'
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6111}]')")
  base_call 'rel#1&xé'
  assert_eq "$BASE_RC" 0 "the encoded endpoints are the ones read ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "$REPO rel#1&xé: green (tip ${SHA_C:0:8})" \
    "the report names the branch as given"
  assert_contains "$(cat "$REQUEST_LOG")" "repos/$REPO/commits/rel%231%26x%C3%A9" \
    "the tip read carries the encoded name"
  assert_contains "$(cat "$REQUEST_LOG")" "runs?branch=rel%231%26x%C3%A9&event=push&per_page=10" \
    "and so does the runs query, whose & would otherwise split it"
}

# No branch named: the repository's default branch is read, and a read that fails is UNKNOWN.
test_the_default_branch_is_read_when_none_is_named() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6121}]')")
  base_call
  assert_eq "$BASE_RC" 0 "the default branch is read and judged ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green (tip ${SHA_C:0:8})" "it is the default branch's verdict"
  reset_fixture
  retune API_ATTEMPTS=1
  FAIL_ENDPOINT="repos/$REPO"
  base_call
  assert_eq "$BASE_RC" 3 "an unread default branch is unknown"
  assert_contains "$BASE_OUTPUT" "could not read $REPO's default branch" "and says which read failed"
  assert_contains "$BASE_OUTPUT" "UNKNOWN, which is not 'fine'" "and that unknown is not fine"
}

# A branch with no push run of any listed workflow has nothing to read: one empty line through
# tab-IFS `read` once rendered as a phantom workflow and headlined green with exit 0 (ffefd9a).
# A list of advisory workflows alone is the same nothing.
test_a_branch_no_workflow_ran_on_is_not_green() {
  reset_fixture
  run_base
  assert_eq "$BASE_RC" 4 "no run at all is no verdict ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: no build workflow has run on it (nothing to read, not a green light)" \
    "and says there was nothing to read"
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"claude"}]')
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6131}]')")
  run_base
  assert_eq "$BASE_RC" 4 "an advisory workflow is not a build verdict ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "no build workflow has run on it" "so nothing was read"
  assert_not_contains "$(cat "$REQUEST_LOG")" "actions/workflows/1/runs" "and its runs are not even asked for"
}

# The workflow list is read again whenever the observed tip MOVES (7c9cf21): a sibling merge
# landing mid-wait can add a workflow, and a stale list would never query it -- the old set going
# covered would read green over the new workflow's red. Round one's coverage is not broken on (the
# tip moved under it); round two reads the moved tip's list, and its new workflow's red at that tip
# ends the wait. With the list kept, round two would break green on `ci` alone.
test_a_workflow_the_moved_tip_added_is_read() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6141}]')")
  at_round 1 "$SHA_B"
  WORKFLOWS_NEXT=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"lint"}]')
  runs_from_round 2 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" \
    '[{conclusion:"success", head_sha:$b, id:6142}, {conclusion:"success", head_sha:$c, id:6141}]')"
  RUNS_2=$(runs_json 2 "$(jq -cn --arg b "$SHA_B" '[{conclusion:"failure", head_sha:$b, id:6143, name:"lint"}]')")
  JOBS_6143=$(jobs_json '[{"name":"lint","conclusion":"failure"}]')
  run_base --wait="$EVENT_CEILING"
  assert_eq "$BASE_RC" 1 "the added workflow's red at the moved tip is the verdict ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "RED      lint — failure at ${SHA_B:0:8}" "the new workflow was read"
  assert_eq "$(rounds_polled)" 2 "round two re-read the list for the tip that moved"
}

# Every read the verdict rests on is UNKNOWN when it fails, never a quieter answer: the workflow
# list, a workflow's runs, and the deeper read behind a page of ten that judged nothing.
test_an_unreadable_list_or_runs_read_is_unknown() {
  reset_fixture
  retune API_ATTEMPTS=1
  FAIL_ENDPOINT="repos/$REPO/actions/workflows?per_page=100"
  run_base
  assert_eq "$BASE_RC" 3 "an unread workflow list is unknown ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "could not read $REPO's workflow list" "naming the read"
  reset_fixture
  retune API_ATTEMPTS=1
  FAIL_ENDPOINT="repos/$REPO/actions/workflows/1/runs?*per_page=10"
  run_base
  assert_eq "$BASE_RC" 3 "an unread runs page is unknown ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "could not read $REPO's 'ci' runs on $BRANCH" "naming the workflow"
  reset_fixture
  retune API_ATTEMPTS=1
  RUNS_1=$(runs_json 1 "$(jq -cn '[range(10) | {conclusion:"cancelled"}]')")
  FAIL_ENDPOINT="repos/$REPO/actions/workflows/1/runs?*per_page=100"
  run_base
  assert_eq "$BASE_RC" 3 "an unread deeper page is unknown ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "past its newest ten, none of which judged it" "naming why it was asked"
  assert_not_contains "$BASE_OUTPUT" "$REPO $BRANCH: green" "never green"
}

# The command line refuses what it cannot mean, exit 2, before any read.
test_the_command_line_refuses_what_it_cannot_mean() {
  reset_fixture
  run_base --wait=soon
  assert_eq "$BASE_RC" 2 "a --wait that is not seconds is refused ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "base: --wait takes seconds, got 'soon'" "saying what it got"
  run_base --bogus
  assert_eq "$BASE_RC" 2 "an unknown option is refused ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "base: unknown option '--bogus'" "naming it"
  run_base --integration-records
  assert_eq "$BASE_RC" 2 "--integration-records with no file is refused ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "base: --integration-records takes a file" "saying so"
  assert_eq "$(wc -l <"$REQUEST_LOG" | tr -d ' ')" 0 "and nothing was read"
}

# The poll interval is capped at what is left of the ceiling (0c4580d): a 60s interval under a 2s
# --wait must not sleep a minute past the deadline before the clock is read again.
test_the_sleep_is_capped_at_the_ceiling() {
  local started elapsed
  reset_fixture
  retune ABSENT_GRACE=300 CHECKS_INTERVAL=60
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{status:"in_progress", conclusion:null, head_sha:$c, id:6151}]')")
  started=$SECONDS
  run_base --wait=2
  elapsed=$((SECONDS - started))
  assert_eq "$BASE_RC" 4 "the ceiling ends the wait without a verdict ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "--wait ceiling of 0 min reached" "at the ceiling"
  [ "$elapsed" -lt 30 ] || bail "a 2s ceiling under a 60s interval took ${elapsed}s: the sleep was not capped"
}

# A long wait says it is still waiting, once per heartbeat, naming what it waits on.
test_a_wait_heartbeats_what_it_waits_on() {
  reset_fixture
  retune CHECKS_HEARTBEAT=0
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{status:"in_progress", conclusion:null, head_sha:$c, id:6161}]')")
  runs_from_round 2 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c, id:6161}]')"
  run_base --wait="$EVENT_CEILING"
  assert_eq "$BASE_RC" 0 "the run finishing green ends the wait ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "still waiting on $REPO $BRANCH: 1 run(s) in flight, 1 workflow(s) not yet judged at the tip, after 0 min" \
    "the heartbeat names the runs in flight and the workflows not yet judged"
}

# `base --wait` is an observer of the polling budget like a PR's (ludics-lite#551): a branch whose
# runs sit still backs off from the interval to the build cap rather than reading every interval,
# and a second wait on the same branch is refused before it reads the runs. Subshell cases: each
# keeps its clock (the script's test clock, which its own sleep advances and logs) and its state
# directory to itself.
test_a_still_base_wait_backs_off_to_the_build_cap() (
  export SHIP_PR_TEST_CLOCK="$TEST_ROOT/clock"
  date +%s >"$SHIP_PR_TEST_CLOCK"
  sleep() {
    printf '%s\n' "$1" >>"$TEST_ROOT/sleeps"
    printf '%s\n' "$(($(cat "$SHIP_PR_TEST_CLOCK") + $1))" >"$SHIP_PR_TEST_CLOCK"
  }
  reset_fixture
  : >"$TEST_ROOT/sleeps"
  retune CHECKS_INTERVAL=60
  BUILD_POLL_CAP=600
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{status:"in_progress", conclusion:null, head_sha:$c, id:6171}]')")
  run_base --wait=1000
  assert_eq "$BASE_RC" 4 "the ceiling ends the wait without a verdict ($BASE_OUTPUT)"
  assert_eq "$(tr '\n' ' ' <"$TEST_ROOT/sleeps")" "60 120 240 480 100 " \
    "an unchanged branch doubles the pause up to the cap, the last cut to the ceiling"
)

# The branch's runs are part of what "moved" means: a run that goes from queued to in progress,
# the round's counts unchanged, resets the pause to the interval.
test_a_moving_base_run_resets_the_pause() (
  export SHIP_PR_TEST_CLOCK="$TEST_ROOT/clock"
  date +%s >"$SHIP_PR_TEST_CLOCK"
  sleep() {
    printf '%s\n' "$1" >>"$TEST_ROOT/sleeps"
    printf '%s\n' "$(($(cat "$SHIP_PR_TEST_CLOCK") + $1))" >"$SHIP_PR_TEST_CLOCK"
  }
  reset_fixture
  : >"$TEST_ROOT/sleeps"
  retune CHECKS_INTERVAL=60
  BUILD_POLL_CAP=600
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{status:"queued", conclusion:null, head_sha:$c, id:6172}]')")
  runs_from_round 2 1 "$(jq -cn --arg c "$SHA_C" '[{status:"in_progress", conclusion:null, head_sha:$c, id:6172}]')"
  run_base --wait=1000
  assert_eq "$BASE_RC" 4 "the ceiling ends the wait without a verdict ($BASE_OUTPUT)"
  assert_eq "$(tr '\n' ' ' <"$TEST_ROOT/sleeps")" "60 60 120 240 480 40 " \
    "the run's move resets the pause, which then doubles again"
)

test_a_second_base_wait_on_a_branch_is_refused() (
  local holder
  reset_fixture
  BUDGET_DIR="$TEST_ROOT/budget-state"
  mkdir -p "$BUDGET_DIR/observers/example~repo@main.base"
  command sleep 300 &
  holder=$!
  printf '%s\n%s\n' "$holder" "$(date +%s)" >"$BUDGET_DIR/observers/example~repo@main.base/owner"
  run_base --wait=60
  kill "$holder" 2>/dev/null || :
  wait "$holder" 2>/dev/null || :
  rm -rf "$BUDGET_DIR"
  assert_eq "$BASE_RC" 2 "a second wait on the branch is refused ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "pid $holder" "naming the one already waiting"
  assert_eq "$(wc -l <"$REQUEST_LOG" | tr -d ' ')" 0 "having read nothing"
)

tests=(
  test_a_red_at_the_tip_ends_the_wait_at_once
  test_the_red_break_reconfirms_the_tip
  test_the_covered_break_reconfirms_the_tip
  test_a_tip_that_moves_mid_wait_restarts_the_grace
  test_the_norun_ambiguity_is_settled_by_the_tips_own_age
  test_a_red_under_a_cancelled_run_at_the_tip_still_stands
  test_an_unreadable_tip_is_unknown_under_wait_and_decoration_without_it
  test_a_same_second_tie_goes_to_the_higher_run_id
  test_overlapping_push_runs_are_read_by_creation_not_by_finish
  test_a_shared_push_group_burst_is_judged_by_the_tips_own_run
  test_a_slashed_branch_is_the_branch_when_the_repo_is_named
  test_a_branch_name_is_percent_encoded
  test_the_default_branch_is_read_when_none_is_named
  test_a_still_base_wait_backs_off_to_the_build_cap
  test_a_moving_base_run_resets_the_pause
  test_a_second_base_wait_on_a_branch_is_refused
  test_a_branch_no_workflow_ran_on_is_not_green
  test_a_workflow_the_moved_tip_added_is_read
  test_an_unreadable_list_or_runs_read_is_unknown
  test_the_command_line_refuses_what_it_cannot_mean
  test_the_sleep_is_capped_at_the_ceiling
  test_a_wait_heartbeats_what_it_waits_on
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
