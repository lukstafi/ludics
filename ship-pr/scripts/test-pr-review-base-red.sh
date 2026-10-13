#!/usr/bin/env bash
# Focused fixture tests for what `pr-review.sh base` says once it has decided a branch is RED:
# WHICH job failed, and WHERE the red started (ludics-lite#73). Those two facts are what an owner
# of a red main needs before anything else, and until this suite existed the command answered
# neither — it named the workflow and the newest failing run, and `.github/workflows/base-watch.yml`
# would have filed an issue saying "skill scripts failed", which is the part everybody already
# knows.
#
# The facts are DECORATION on a verdict already reached, and that is the property most of these
# cases pin. The streak walk may not claim a first red commit the run window does not support (a
# window that is red to its end knows only that the red is at least that old); a jobs read that
# fails may not soften the red, and may not quietly report "no failing job" either; and none of it
# may cost a call on a green base, which is the common case every worker pays for at session start.
#
# The window itself is the newest ten push runs per workflow, which is what `base` fetches, or a
# hundred behind a page of ten that judged nothing (ludics-lite#535); the suite's fixtures are sized
# against that, not against a repository's whole history.
#
# The fixture transport is test-pr-review-base-lib.sh, shared with the settle and verdict suites
# (ludics-lite#179); what this file holds is the red report's own cases. The one that crosses
# rounds counts them, under the wall-clock idiom that file's header writes down.

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

# The report an owner is handed: the failing job by name, and the commit the red starts at — not
# the newest failing run, which is only where the red was noticed.
test_red_names_the_failing_job_and_the_first_red_commit() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{conclusion:"failure", head_sha:$c, id:3003},
      {conclusion:"failure", head_sha:$b, id:3002},
      {conclusion:"success", head_sha:$a, id:3001}]')")
  JOBS_3003=$(jobs_json '[{"name":"bash 3.2 suites (macos)","conclusion":"failure"},
                          {"name":"prompt hygiene","conclusion":"success"},
                          {"name":"syntax, shellcheck","conclusion":"cancelled"}]')
  run_base
  assert_eq "$BASE_RC" 1 "a failing workflow on the tip is red"
  assert_contains "$BASE_OUTPUT" "is RED" "the verdict should still headline the red"
  assert_contains "$BASE_OUTPUT" "red since ${SHA_B:0:8}" \
    "the first red commit is where the streak starts, not where it was noticed"
  assert_contains "$BASE_OUTPUT" "2 run(s) back" "how far back the red goes should be counted"
  assert_contains "$BASE_OUTPUT" "the judged run before it was not red" \
    "a streak with a green under it should say the floor is known"
  assert_contains "$BASE_OUTPUT" "failed job(s): bash 3.2 suites (macos) (failure)" \
    "the failing job should be named"
  assert_not_contains "$BASE_OUTPUT" "prompt hygiene" "a job that passed is not a failing job"
  assert_not_contains "$BASE_OUTPUT" "syntax, shellcheck" \
    "a job that was cancelled was not judged, and is not a failing job either"
  # The jobs read is anchored on the run the RED line reports — the newest red — and not on the
  # oldest run of the streak, whose jobs would name a failure two commits stale.
  assert_contains "$(cat "$REQUEST_LOG")" "actions/runs/3003/jobs" \
    "the newest red run's jobs are the ones to read"
  assert_not_contains "$(cat "$REQUEST_LOG")" "actions/runs/3002/jobs" \
    "the first red run's jobs are not what the report is about"
}

# The claim that must be able to fail: with no green under the streak, the first red commit is
# NOT in evidence. Naming the oldest run the page happened to hold would send an owner bisecting
# from the wrong end. The window is a hundred deep here: a page of ten with no green on it is read
# a hundred deep for the streak's floor (below), so it is a hundred reds that leave none.
test_a_window_of_only_reds_does_not_name_a_first_red_commit() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(all_red_runs 110)")
  TIP=$SHA_0
  run_base
  assert_eq "$BASE_RC" 1 "a window of failures is red"
  assert_contains "$(cat "$REQUEST_LOG")" "event=push&per_page=100" "the page of ten was read deeper"
  assert_contains "$BASE_OUTPUT" "red for all 100 judged run(s) in the window" \
    "the report should say how much of the window is red"
  assert_contains "$BASE_OUTPUT" "may start further back" \
    "an unbounded streak should say the first red commit is not known"
  assert_not_contains "$BASE_OUTPUT" "the judged run before it was not red" \
    "there is no such run: the bounded claim must not be printed here"
  assert_not_contains "$BASE_OUTPUT" "red since" \
    "'red since' names a first red commit, which this window cannot support"
}

# A red streak longer than the page of ten: no green-class row on the page, so the floor is not
# on it, and the runs are read a hundred deep as for a page that judged nothing (#403's port-time
# item from #546) -- the streak walk then names where the red starts and that a green is under it.
test_a_red_streak_past_the_page_finds_its_floor_below_it() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[range(3412; 3400; -1) | {conclusion: "failure", head_sha: $c, id: .}] +
     [{conclusion: "failure", head_sha: $b, id: 3399},
      {conclusion: "success", head_sha: $a, id: 3398}]')")
  run_base
  assert_eq "$BASE_RC" 1 "a red tip is red"
  assert_contains "$(cat "$REQUEST_LOG")" "event=push&per_page=100" "the page of ten was read deeper"
  assert_contains "$BASE_OUTPUT" "red since ${SHA_B:0:8} (run created" "the first red commit, below the page"
  assert_contains "$BASE_OUTPUT" "13 run(s) back; the judged run before it was not red" \
    "and the floor is known"
  assert_not_contains "$BASE_OUTPUT" "may start further back" "the floor was read, not guessed"
  # A green on the page bounds the streak there: one read of ten, as before.
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[range(3509; 3500; -1) | {conclusion: "failure", head_sha: $c, id: .}] +
     [{conclusion: "success", head_sha: $a, id: 3499}]')")
  run_base
  assert_contains "$BASE_OUTPUT" "red since ${SHA_C:0:8}" "the floor is on the page"
  assert_not_contains "$(cat "$REQUEST_LOG")" "event=push&per_page=100" "no deeper read for a page with a green"
}

# The floor's read failing leaves the red standing: the page already judged the branch red, and
# where the streak starts is decoration on that verdict -- unknown, said so, never UNKNOWN overall.
test_a_failed_floor_read_leaves_the_red_standing() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[range(3612; 3600; -1) | {conclusion: "failure", head_sha: $c, id: .}] +
     [{conclusion: "success", head_sha: $a, id: 3599}]')")
  FAIL_ENDPOINT="repos/$REPO/actions/workflows/1/runs?*per_page=100"
  run_base
  assert_eq "$BASE_RC" 1 "the page's red is the verdict ($BASE_OUTPUT)"
  assert_contains "$BASE_OUTPUT" "is RED" "headlined as red"
  assert_contains "$BASE_OUTPUT" "red for all 10 judged run(s) in the window" "the streak walk reads the page"
  assert_contains "$BASE_OUTPUT" "may start further back" "and says the floor is not known"
}

# A burst's cancelled rows can fill the page of ten: the newest JUDGED run is then below it, and a red
# there is the base's verdict, not "no verdict" (ludics-lite#535). The fold reads that workflow a
# hundred deep, and the streak walk reads the same rows, so the red's first commit and its floor
# are both named from below the page. A page that judged something green is never read again (a
# page red to its end is, for its floor: the case above).
test_a_red_behind_a_page_of_cancelled_runs_is_red() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" --arg z "$SHA_0" \
    '[range(3112; 3100; -1) | {conclusion: "cancelled", head_sha: $c, id: .}] +
     [{conclusion: "failure", head_sha: $b, id: 3099},
      {conclusion: "failure", head_sha: $a, id: 3098},
      {conclusion: "success", head_sha: $z, id: 3097}]')")
  JOBS_3099=$(jobs_json '[{"name":"bash 3.2 suites (macos)","conclusion":"failure"}]')
  run_base
  assert_eq "$BASE_RC" 1 "a red under twelve cancelled runs is red"
  assert_contains "$BASE_OUTPUT" "RED      ci — failure at ${SHA_B:0:8}" "naming the judged run below the page"
  assert_contains "$BASE_OUTPUT" "red since ${SHA_A:0:8} (run created" "the streak walk reads the same deeper rows"
  assert_contains "$BASE_OUTPUT" "2 run(s) back; the judged run before it was not red" "and finds its floor there"
  assert_contains "$BASE_OUTPUT" "failed job(s): bash 3.2 suites (macos) (failure)" "with the job that failed"
  assert_contains "$BASE_OUTPUT" "(newest completed run: cancelled at ${SHA_C:0:8}, stopped not judged" \
    "the cancelled run on top stays visible as context"
  assert_contains "$(cat "$REQUEST_LOG")" "event=push&per_page=100" "found by the deeper read"
  # The same red inside the page, with its floor there too: one read of ten, as before.
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[range(3209; 3201; -1) | {conclusion: "cancelled", head_sha: $c, id: .}] +
     [{conclusion: "failure", head_sha: $b, id: 3199}, {conclusion: "success", head_sha: $a, id: 3198}]')")
  run_base
  assert_eq "$BASE_RC" 1 "a red on the page is red"
  assert_not_contains "$(cat "$REQUEST_LOG")" "event=push&per_page=100" "no deeper read for a page that judged green"
}

# Nothing that was not JUDGED ends a streak: a cancelled run and a run still going both say
# nothing about the branch's health at their commit, so reading either as the streak's floor
# would report a red that started two commits later than it did.
test_an_unjudged_run_inside_the_streak_does_not_end_it() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{status:"in_progress", conclusion:null, head_sha:$c, id:3010},
      {conclusion:"failure", head_sha:$c, id:3009},
      {conclusion:"cancelled", head_sha:$b, id:3008},
      {conclusion:"failure", head_sha:$b, id:3007},
      {conclusion:"success", head_sha:$a, id:3006}]')")
  run_base
  assert_eq "$BASE_RC" 1 "the newest judged run is red, whatever is running over it"
  assert_contains "$BASE_OUTPUT" "red since ${SHA_B:0:8}" \
    "the streak should reach past the cancelled run to the older red"
  assert_contains "$BASE_OUTPUT" "2 run(s) back" \
    "an unjudged run is not one of the red runs it sits between"
  assert_contains "$(cat "$REQUEST_LOG")" "actions/runs/3009/jobs" \
    "the jobs read is anchored on the newest run that was JUDGED red, not on the one in flight"
}

# The whole reason the jobs read is separate: it is one more call, and a call can fail. What it
# may not do is soften an established red, or come back as a clean bill of health.
test_an_unreadable_jobs_read_is_unknown_not_a_clean_bill() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[{conclusion:"failure", head_sha:$c, id:3020}, {conclusion:"success", head_sha:$a}]')")
  FAIL_ENDPOINT="*/jobs?per_page=100"
  run_base
  assert_eq "$BASE_RC" 1 "a jobs read that failed must not turn an established red into transport"
  assert_contains "$BASE_OUTPUT" "is RED" "the red should still headline"
  assert_contains "$BASE_OUTPUT" "which job failed is UNKNOWN" \
    "a failed read should say what is unknown"
  assert_not_contains "$BASE_OUTPUT" "failed job(s)" "no job may be named off a read that failed"
  assert_not_contains "$BASE_OUTPUT" "no job in that run concluded red" \
    "an unread jobs list is not an empty one"
  # The first red commit comes from rows already in hand, so it survives the failed call.
  assert_contains "$BASE_OUTPUT" "red since ${SHA_C:0:8}" \
    "the streak walk needs no call of its own and should still report"
}

# A run can conclude red with no red job — startup_failure, or a matrix that could not expand.
# The honest line names that; an empty list would read as "nothing failed".
test_a_red_run_with_no_red_job_says_so() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[{conclusion:"startup_failure", head_sha:$c, id:3030}, {conclusion:"success", head_sha:$a}]')")
  JOBS_3030=$(jobs_json '[{"name":"prompt hygiene","conclusion":"success"}]')
  run_base
  assert_eq "$BASE_RC" 1 "startup_failure is red"
  assert_contains "$BASE_OUTPUT" "no job in that run concluded red" \
    "a red run whose jobs are not red should say so rather than print an empty list"
  assert_not_contains "$BASE_OUTPUT" "failed job(s)" "there is no failing job to name"
}

# The negative control on the cost: `base` runs at every session start, and the extra call must
# be on the red path only.
test_a_green_base_asks_for_no_jobs() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" '[{conclusion:"success", head_sha:$c}]')")
  run_base
  assert_eq "$BASE_RC" 0 "a green tip is green"
  assert_contains "$BASE_OUTPUT" "$REPO $BRANCH: green" "the green headline is unchanged"
  assert_not_contains "$(cat "$REQUEST_LOG")" "/jobs" \
    "a green base must not spend a call on which job failed"
  assert_not_contains "$BASE_OUTPUT" "red since" "nothing is red here"
}

# Two workflow FILES can share a display name. The fold groups by workflow id for that reason, and
# the streak walk has to select the same way: keyed by name, the second workflow's history would
# be read off the first's rows, and its report would name the wrong commit and the wrong run.
test_two_workflows_sharing_a_name_keep_their_streaks_apart() {
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"ci"}]')
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg a "$SHA_A" \
    '[{conclusion:"failure", head_sha:$c, id:11}, {conclusion:"success", head_sha:$a, id:10}]')")
  RUNS_2=$(runs_json 2 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{conclusion:"failure", head_sha:$c, id:21},
      {conclusion:"failure", head_sha:$b, id:20},
      {conclusion:"failure", head_sha:$a, id:19}]')")
  JOBS_11=$(jobs_json '[{"name":"lint","conclusion":"failure"}]')
  JOBS_21=$(jobs_json '[{"name":"fixtures","conclusion":"failure"}]')
  run_base
  assert_eq "$BASE_RC" 1 "both workflows are red"
  assert_contains "$BASE_OUTPUT" "red since ${SHA_C:0:8}" \
    "the workflow with a green under its one failure starts its red at the tip"
  assert_contains "$BASE_OUTPUT" "1 run(s) back" "that streak is one run long"
  assert_contains "$BASE_OUTPUT" "red for all 3 judged run(s) in the window" \
    "the other workflow's own window is red to its end"
  assert_contains "$BASE_OUTPUT" "failed job(s): lint (failure)" "each workflow's jobs are its own"
  assert_contains "$BASE_OUTPUT" "failed job(s): fixtures (failure)" \
    "the second workflow's jobs must not be read off the first's run"
}

# `base --wait` re-reads and re-folds every round, so the jobs read is one call per round per red
# workflow unless it is remembered. It was not, for one round of review: the caller took the
# detail through a command substitution, and every cache record the function wrote died with that
# subshell — a cache that could never hit, which is invisible except in the call count.
#
# The rounds are COUNTED, not timed (ludics-lite#375): the red stands for two rounds, and on the
# third a second workflow's run at the tip concludes red, which is what ends the wait. A `--wait=2`
# that was counted on to hold two rounds held one on the Git Bash runner, where a round outruns two
# seconds.
test_a_standing_red_is_read_once_across_wait_rounds() {
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"lint"}]')
  # The shape that keeps a wait going: the tip is still being judged, and the red standing behind
  # it belongs to an older commit, so nothing breaks the loop early.
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{status:"in_progress", conclusion:null, head_sha:$c, id:3041},
      {conclusion:"failure", head_sha:$b, id:3040},
      {conclusion:"success", head_sha:$a, id:3039}]')")
  JOBS_3040=$(jobs_json '[{"name":"fixtures (macos)","conclusion":"failure"}]')
  RUNS_2=$(runs_json 2 "$(jq -cn --arg c "$SHA_C" \
    '[{status:"in_progress", conclusion:null, head_sha:$c, id:4041, name:"lint"}]')")
  runs_from_round 3 2 "$(jq -cn --arg c "$SHA_C" \
    '[{conclusion:"failure", head_sha:$c, id:4041, name:"lint"}]')"
  JOBS_4041=$(jobs_json '[{"name":"shellcheck","conclusion":"failure"}]')
  run_base --wait="$EVENT_CEILING"
  assert_eq "$BASE_RC" 1 "the red at the tip on round three ends the wait ($BASE_OUTPUT)"
  # Three reads of the runs feed, every one of them over the standing red, are what make the
  # single jobs read below evidence of anything.
  assert_eq "$(rounds_polled)" 3 "the wait runs two rounds over the standing red, and ends on the third"
  assert_eq "$(grep -c "actions/runs/3040/jobs" "$REQUEST_LOG")" 1 \
    "the standing red's jobs should be read once, not once per round"
  assert_contains "$BASE_OUTPUT" "failed job(s): fixtures (macos) (failure)" \
    "the remembered line should still be printed on the rounds that did not read"
  assert_contains "$BASE_OUTPUT" "failed job(s): shellcheck (failure)" \
    "and the red that ended the wait is reported beside it"
}

# ... and when the wait runs out with that red still standing, it says NO VERDICT INSTEAD of the
# red, not under it: at the ceiling with an older tip's red standing, the red headline would claim
# "failed on the tip you are about to branch from" about a commit that has no verdict yet, and send
# the caller fixing a fix already in flight. This case is about the ceiling, and asserts only what
# holds however few rounds fit under it.
test_a_wait_that_runs_out_over_an_older_red_has_no_verdict() {
  reset_fixture
  RUNS_1=$(runs_json 1 "$(jq -cn --arg c "$SHA_C" --arg b "$SHA_B" --arg a "$SHA_A" \
    '[{status:"in_progress", conclusion:null, head_sha:$c, id:3041},
      {conclusion:"failure", head_sha:$b, id:3040},
      {conclusion:"success", head_sha:$a, id:3039}]')")
  JOBS_3040=$(jobs_json '[{"name":"fixtures (macos)","conclusion":"failure"}]')
  run_base --wait=2
  assert_eq "$BASE_RC" 4 "a wait that ends with the tip unjudged is no verdict"
  assert_contains "$BASE_OUTPUT" "NO VERDICT for the tip ${SHA_C:0:8}" \
    "the honest headline is about the tip, which nothing here has judged"
  assert_not_contains "$BASE_OUTPUT" "is RED" \
    "an older tip's red must not headline as the tip's own verdict"
  assert_contains "$BASE_OUTPUT" "RED      ci" \
    "and the older red stays visible in the per-workflow lines under that headline"
  assert_contains "$BASE_OUTPUT" "failed job(s): fixtures (macos) (failure)" \
    "with the job that failed in it"
}

tests=(
  test_red_names_the_failing_job_and_the_first_red_commit
  test_a_window_of_only_reds_does_not_name_a_first_red_commit
  test_a_red_streak_past_the_page_finds_its_floor_below_it
  test_a_failed_floor_read_leaves_the_red_standing
  test_a_red_behind_a_page_of_cancelled_runs_is_red
  test_an_unjudged_run_inside_the_streak_does_not_end_it
  test_an_unreadable_jobs_read_is_unknown_not_a_clean_bill
  test_a_red_run_with_no_red_job_says_so
  test_a_green_base_asks_for_no_jobs
  test_two_workflows_sharing_a_name_keep_their_streaks_apart
  test_a_standing_red_is_read_once_across_wait_rounds
  test_a_wait_that_runs_out_over_an_older_red_has_no_verdict
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
