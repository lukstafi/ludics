#!/usr/bin/env bash
# Focused fixture tests for pr-review.sh's `status` state line — the mergeability that rides on
# every state and turns "the next move is yours" into "merge the base in first" — and for `watch`
# reading the base drift the moment a round lands rather than at merge time (ludics-lite#44).
#
# Plus the `failed` state (ludics-lite#78): the reviewer answering with an initialization failure
# instead of a round, which used to read as `expected` and send `watch` into the grace. Its
# fixtures carry the comment body verbatim from lukstafi/ocannl-staging#677.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=test-pr-review-lib.sh
source "$SCRIPT_DIR/test-pr-review-lib.sh"

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
test_tmpdir TEST_ROOT status-test

# The clock is the script's own test clock (SHIP_PR_TEST_CLOCK, prreview/clock.py), as in
# test-pr-review-watch.sh: a file holding the epoch second every age and every watch deadline is
# measured on, which a watch's sleep ADVANCES instead of waiting. So a window a watch holds (a
# grace, a nudge's pickup) takes no wall time here. On the wall clock it took real seconds, and
# when the watch began holding a window (#583) one case waited out the real 20-minute grace until
# the suite was killed at 775 s. reset_fixture sets it to the wall time, and a case dates whatever
# must be fresh on it (clock_at), never on jq's own `now`, which this clock does not move.
export SHIP_PR_TEST_CLOCK="$TEST_ROOT/clock"
date +%s >"$SHIP_PR_TEST_CLOCK"

# The fixture clock's time, plus an offset in seconds, as GitHub dates things.
clock_at() { # [offset]
  jq -rn --argjson t "$(cat "$SHIP_PR_TEST_CLOCK")" --argjson o "${1:-0}" '($t + $o) | todate'
}

REPO=example/repo
REQUEST_LOG="$TEST_ROOT/requests"
REACTIONS_JSON='[]'
REVIEWS_JSON='[]'
COMMENTS_JSON='[]'
INLINE_JSON='[]'
FAIL_INLINE=""
HEAD_SHA=head-sha
MERGEABLE_STATE=clean
FAIL_PULLS=""
# Which READS the two simulated pushes fire on, counted from the start of the case: a watch reads
# every feed once for its opening status and again for each round, so "the push landed on the
# round's read" is 2, and a bare `status` case's only read is 1.
PUSH_ON_REVIEWS_READ=""
# The same simulated push, one read later: the PR read itself arms it, so the FIRST PR read of the
# process answers the old head and every one after it answers the pushed one. That is a push landing
# in the gap between a round's head read and the state read beside it — the gap ludics-lite#95
# closes, and the one a state that re-read the PR would report the round through.
PUSH_AFTER_PULLS_READ=""
# The flat inline feed refusing to answer: the shape that fails a poll ROUND, so a case can ask what
# a round that did not answer leaves behind for the state read after it.
FAIL_INLINE_FEED=""
# The PR's review threads (review_thread rows), how the connection pages them, and GraphQL
# refusing to answer — the open-thread read an approval is checked with (ludics-lite#289).
THREADS_JSON='[]'
THREADS_FIXTURE_PAGE=""
THREADS_FIXTURE_TOTAL=""
FAIL_GRAPHQL=""
# One of the three state feeds (reactions, comments, reviews) refusing to answer.
FAIL_FEED=""
# A comment POST refusing (a watch's re-request of a failed run, #453). What does post is kept in
# $TEST_ROOT/posted, one comment per line, and served back by the comments read after it.
FAIL_POST=""
# A posted comment the comments feed has not caught up with yet: the POST lands, and the reads after
# it do not serve it back.
HIDE_POSTED=""
# A 👍 landing mid-watch: from this reactions read on (counted from the case's reset), the feed
# answers REACTIONS_JSON plus a 👍 — how a case puts one between a round's read and the write
# that round decided on.
THUMBS_ON_REACTIONS_READ=""
# Extra arguments for the watch (`--no-nudge`).
WATCH_FLAG=""
# The base's tip, and the head PUSH_ON_REVIEWS_READ swaps in. With HEAD_SHA these are the only
# SHAs the transport below spells out, so a case that needs a new head just sets HEAD_SHA.
BASE_SHA=base-sha
PUSHED_HEAD=new-head-sha
PAST=2026-09-01T00:00:00Z
# The head commit's own date, which is what a failure naming no ref is dated against.
HEAD_AT=2026-09-01T00:00:00Z
# The two refs ocannl-staging#677's failures named, and its third head, which reviewed normally.
FAILED_HEAD=0ac6fef8038e95481f82deddc1edfa2ab8ca8827
OTHER_REF=099131cc90960b2ad144f9f33c374c6be81035c8

reset_fixture() {
  REACTIONS_JSON='[]'
  REVIEWS_JSON='[]'
  COMMENTS_JSON='[]'
  INLINE_JSON='[]'
  FAIL_INLINE=""
  HEAD_SHA=head-sha
  MERGEABLE_STATE=clean
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT=""
  FAIL_PULLS=""
  PUSH_ON_REVIEWS_READ=""
  PUSH_AFTER_PULLS_READ=""
  FAIL_INLINE_FEED=""
  THREADS_JSON='[]'
  THREADS_FIXTURE_PAGE=""
  THREADS_FIXTURE_TOTAL=""
  FAIL_GRAPHQL=""
  FAIL_FEED=""
  FAIL_POST=""
  HIDE_POSTED=""
  THUMBS_ON_REACTIONS_READ=""
  WATCH_FLAG=""
  rm -f "$TEST_ROOT/pushed" "$TEST_ROOT/posted" "$TEST_ROOT"/nth.*
  : >"$REQUEST_LOG"
  date +%s >"$SHIP_PR_TEST_CLOCK"
}

reaction() { # <content> <created_at>
  jq -cn --arg c "$1" --arg at "$2" --arg rev "$REVIEWER" \
    '{user:{login:($rev + "[bot]")}, content:$c, created_at:$at}'
}

review() { # <id> <commit> <submitted_at>
  jq -cn --argjson id "$1" --arg sha "$2" --arg at "$3" --arg rev "$REVIEWER" \
    '{id:$id, user:{login:($rev + "[bot]")}, state:"COMMENTED", commit_id:$sha,
      submitted_at:$at, body:"findings"}'
}

verdict_comment() { # <id> <sha> <created_at>
  jq -cn --argjson id "$1" --arg sha "$2" --arg at "$3" --arg rev "$REVIEWER" \
    '{id:$id, user:{login:($rev + "[bot]")}, created_at:$at, updated_at:$at,
      body:("Codex Review: Didn'"'"'t find any major issues.\n**Reviewed commit:** `" + $sha + "`")}'
}

plain_comment() { # <id> <created_at> <body>
  jq -cn --argjson id "$1" --arg at "$2" --arg b "$3" --arg rev "$REVIEWER" \
    '{id:$id, user:{login:($rev + "[bot]")}, created_at:$at, updated_at:$at, body:$b}'
}

# The initialization failure as the connector posts it: the curly quotes, the ref in a fenced
# block, and the "About Codex in GitHub" details block every one of its comments carries. Nothing
# machine-tags it, which is why it reads as the reviewer's last word. `-` for a failure that
# names no ref.
FAILURE_HEAD_LINE='Codex Review: Something went wrong. Try again later by commenting “@codex review”.'
FAILURE_TAIL='<details> <summary>ℹ️ About Codex in GitHub</summary>
Reviews are triggered when you open a pull request or comment "@codex review".
</details>'

failure_body() { # <ref|->
  printf '%s\n' "$FAILURE_HEAD_LINE" ""
  [ "$1" = - ] || printf '```\nProvided git ref %s does not exist\n```\n\n' "$1"
  printf '%s\n' "$FAILURE_TAIL"
}

failure_comment() { # <id> <ref|-> <created_at>
  plain_comment "$1" "$3" "$(failure_body "$2")"
}

compare_json() { # <behind> <ahead> <file>
  jq -cn --argjson behind "$1" --argjson ahead "$2" --arg f "$3" \
    '{behind_by:$behind, ahead_by:$ahead, merge_base_commit:{sha:"merge-base-sha"},
      files:[{filename:$f}]}'
}

# Which read of <feed> this is, counted from the case's reset. gh runs in a subshell, so the count
# lives in a file for the same reason the pushed marker does.
FIXTURE_NTH=0
fixture_nth() { # <feed>
  local f="$TEST_ROOT/nth.$1"
  FIXTURE_NTH=$(($(cat "$f" 2>/dev/null || echo 0) + 1))
  echo "$FIXTURE_NTH" >"$f"
}

# Is this SHA a head the fixture is standing behind? The commit read and both compare directions
# ask, so the three of them agree on one answer and a case that needs a new head costs the one
# HEAD_SHA assignment it already makes — spelling a head into an endpoint pattern is what used to
# cost three edits or a `bail`.
fixture_head() { # <sha>
  [ "$1" = "$HEAD_SHA" ] || [ "$1" = "$PUSHED_HEAD" ]
}

# Does FAIL_FEED name <feed>? Then the read answers as GitHub does in an outage.
fixture_feed_down() { # <feed>
  [ "$FAIL_FEED" = "$1" ] || return 1
  echo "gh: 503 No server is currently available to service your request" >&2
}

# Minimal gh fixture transport for every feed `status` and `watch` read. The --jq filter matters
# here: the PR read asks gh to format its head/mergeability snapshot. --paginate is ignored (one
# page is the whole feed).
gh() {
  local response="" spec left right posted
  gh_fixture_parse "$@"
  case "$FIXTURE_ENDPOINT" in
  "repos/$REPO/issues/7/reactions?per_page=100")
    fixture_feed_down reactions && return 1
    fixture_nth reactions
    response="$REACTIONS_JSON"
    [ -z "$THUMBS_ON_REACTIONS_READ" ] || [ "$FIXTURE_NTH" -lt "$THUMBS_ON_REACTIONS_READ" ] ||
      response=$(jq -c --argjson r "$(reaction +1 "$(clock_at)")" '. + [$r]' <<<"$response")
    ;;
  "repos/$REPO/pulls/7/reviews?per_page=100")
    # The simulated push: gh runs in a subshell, so the "new head" travels through a file that
    # the PR read below consults.
    fixture_feed_down reviews && return 1
    fixture_nth reviews
    [ "$PUSH_ON_REVIEWS_READ" != "$FIXTURE_NTH" ] || : >"$TEST_ROOT/pushed"
    response="$REVIEWS_JSON"
    ;;
  "repos/$REPO/issues/7/comments?per_page=100")
    fixture_feed_down comments && return 1
    response="$COMMENTS_JSON"
    [ -n "$HIDE_POSTED" ] || [ ! -s "$TEST_ROOT/posted" ] ||
      response=$(jq -c --slurpfile p "$TEST_ROOT/posted" '. + $p' <<<"$response")
    ;;
  "repos/$REPO/issues/7/comments")
    [ "$FIXTURE_METHOD" = POST ] || bail "unexpected ${FIXTURE_METHOD:-GET} on $FIXTURE_ENDPOINT"
    if [ -n "$FAIL_POST" ]; then
      echo "gh: HTTP 502: Bad Gateway" >&2
      return 1
    fi
    # Ids above every fixture comment's, dated on the fixture clock, as GitHub numbers and dates a
    # new comment.
    posted=0
    [ ! -e "$TEST_ROOT/posted" ] || posted=$(($(wc -l <"$TEST_ROOT/posted")))
    jq -cn --argjson id "$((900 + posted))" \
      --arg b "$FIXTURE_BODY" --arg at "$(clock_at)" \
      '{id:$id, user:{login:"me"}, created_at:$at, updated_at:$at, body:$b}' >>"$TEST_ROOT/posted"
    response='{"html_url":"https://github.com/example/repo/pull/7#issuecomment-900"}'
    ;;
  "repos/$REPO/pulls/7/comments?per_page=100")
    if [ -n "$FAIL_INLINE_FEED" ]; then
      echo "gh: 503 No server is currently available to service your request" >&2
      return 1
    fi
    response='[]'
    ;;
  "repos/$REPO/pulls/7/reviews/"*"/comments?per_page=100")
    [ -z "$FAIL_INLINE" ] || return 1
    response="$INLINE_JSON" ;;
  "repos/$REPO/pulls/7")
    if [ -n "$FAIL_PULLS" ]; then
      echo "gh: pull request unavailable (HTTP 500)" >&2
      return 1
    fi
    # base.sha is a stale snapshot on purpose, as on a conflicted PR (see the base-drift suite).
    [ ! -e "$TEST_ROOT/pushed" ] || HEAD_SHA="$PUSHED_HEAD"
    response=$(jq -cn --arg h "$HEAD_SHA" --arg m "$MERGEABLE_STATE" --arg c "${PR_CREATED_AT:-}" \
      '{base:{ref:"main",sha:"stale-base-sha"}, head:{sha:$h}, mergeable_state:$m, state:"open", draft:false}
       + (if $c == "" then {} else {created_at:$c} end)')
    # Armed AFTER the answer, so THIS read still sees the old head and the next one does not.
    fixture_nth pulls
    [ "$PUSH_AFTER_PULLS_READ" != "$FIXTURE_NTH" ] || : >"$TEST_ROOT/pushed"
    ;;
  # Before the head arm: `main` is a ref this fixture resolves, not a head it serves.
  "repos/$REPO/commits/main") response="{\"sha\":\"$BASE_SHA\"}" ;;
  "repos/$REPO/commits/"*)
    fixture_head "${FIXTURE_ENDPOINT#"repos/$REPO/commits/"}" ||
      bail "unexpected fixture endpoint: $FIXTURE_ENDPOINT"
    # The date is the whole answer here — this read is `--jq .commit.committer.date` — so the
    # `sha` stays the placeholder it has always been rather than echoing the head back.
    response=$(jq -cn --arg d "$HEAD_AT" '{sha:"head-sha", commit:{committer:{date:$d}}}') ;;
  # The query suffix is part of the endpoint, not decoration: matching it here is what keeps the
  # generalization to the head SHA alone, so a compare that lost its `?per_page=1` still bails.
  "repos/$REPO/compare/"*"?per_page=1")
    spec=${FIXTURE_ENDPOINT#"repos/$REPO/compare/"}
    spec=${spec%"?per_page=1"}
    left=${spec%%...*}
    right=${spec#*...}
    if [ "$left" = "$BASE_SHA" ] && fixture_head "$right"; then
      response=$(compare_json 7 15 pr.txt) # base...head, the forward read: 7 behind, 15 ahead
    elif [ "$right" = "$BASE_SHA" ] && fixture_head "$left"; then
      response=$(compare_json 15 7 base.txt) # head...base, the reverse read: the counts swap
    else
      bail "unexpected fixture endpoint: $FIXTURE_ENDPOINT"
    fi
    ;;
  graphql)
    case "$*" in *reviewThreads*) ;; *) bail "unexpected graphql call: $*" ;; esac
    if [ -n "$FAIL_GRAPHQL" ]; then
      echo "gh: 503 No server is currently available to service your request" >&2
      return 1
    fi
    response=$(review_threads_answer "$THREADS_JSON" "$@")
    ;;
  *) bail "unexpected fixture endpoint: $FIXTURE_ENDPOINT" ;;
  esac
  gh_fixture_answer "$response"
}

# The state line and its rendering, as `status` produces them: the Python's own state and
# rendering (ludics-lite#403), asked through the two entry points of ludics.prreview that
# pr-review.sh's command line does not route to (`status-state <pr> [<pending-request watermark>]`,
# `status-line <state line> [<pr number>]`), so every case here judges what `status` and `watch`
# run. The arguments are what the reads take from their caller (watch_nudge_after, PR_NUM).
run_status() {
  STATE=$(py_forward call status-state 7 "${watch_nudge_after:-}")
  LINE=$(py_forward call status-line "$STATE" "${PR_NUM:-}")
}

# cmd_status in a subshell: its exit code is the assertion, and it must not end this reporter.
run_cmd_status() {
  local rc
  set +e
  CMD_OUT=$(cmd_status 7 2>&1)
  rc=$?
  set -e
  CMD_RC="$rc"
}

# A watch that returns on its first poll. stdout and stderr are kept apart: the contract is that
# a round's stdout is byte-identical to poll's, so the drift read has to be on stderr.
# The interval and the timeout are arguments so a case can pin the number of ROUNDS a window makes:
# an interval past the timeout is exactly one loop round and then the settle.
run_watch() { # [watermark] [interval] [timeout]
  local rc
  set +e
  WATCH_INTERVAL="${2:-1}" WATCH_TIMEOUT="${3:-3}" cmd_watch 7 "${1:-0,0,0}" ${WATCH_FLAG:+"$WATCH_FLAG"} >"$TEST_ROOT/watch.out" 2>"$TEST_ROOT/watch.err"
  rc=$?
  set -e
  WATCH_RC="$rc"
  WATCH_OUT=$(cat "$TEST_ROOT/watch.out")
  WATCH_ERR=$(cat "$TEST_ROOT/watch.err")
}

pulls_reads() {
  grep -c "^repos/$REPO/pulls/7\$" "$REQUEST_LOG" || true
}

# How many times an endpoint was asked, for the cases that count a round's calls.
reads_of() { # <endpoint, without the repos/<repo>/ prefix>
  grep -c -F -x "repos/$REPO/$1" "$REQUEST_LOG" || true
}

idle_fixture() {
  reset_fixture
  REVIEWS_JSON="[$(review 5 head-sha "$PAST")]"
}

CONFLICT="CONFLICTS with the base (mergeable_state=dirty)"

test_idle_clean_says_next_move_is_yours() {
  idle_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a reviewed head with no 👍 is idle"
  assert_eq "$(state_merge "$STATE")" clean "the mergeability rides on the state line"
  assert_contains "$LINE" "the next move is yours" "a clean idle PR hands the move to the caller"
  assert_not_contains "$LINE" "CONFLICTS" "a clean PR must not claim a conflict"
}

test_idle_dirty_says_conflicts_not_next_move() {
  idle_fixture
  MERGEABLE_STATE=dirty
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a conflict is not a review state: the head is still reviewed"
  assert_eq "$(state_merge "$STATE")" dirty "the dirty mergeability should ride on the state line"
  assert_contains "$LINE" "$CONFLICT" "a conflicted idle PR should say CONFLICTS"
  assert_contains "$LINE" "no pull_request run tests that merge" \
    "the line should say what the conflict costs: the head merged with the base goes untested"
  assert_not_contains "$LINE" "no workflow runs on this head" \
    "a run that completed before the base moved may exist: do not claim nothing ran"
  assert_contains "$LINE" "merge the base in" "the line should name the remedy"
  assert_not_contains "$LINE" "the next move is yours" \
    "a conflicted PR must not invite another push as the next move"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "the merge gate is the state, not the mergeability: idle stays exit 0"
  assert_contains "$CMD_OUT" "$CONFLICT" "cmd_status should print the conflict"
}

test_idle_draft_names_gh_pr_ready() {
  idle_fixture
  MERGEABLE_STATE=draft
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a draft is not a review state: the head is still reviewed"
  assert_eq "$(state_merge "$STATE")" draft "the draft mergeability should ride on the state line"
  assert_contains "$LINE" "DRAFT (mergeable_state=draft)" "an idle draft should say DRAFT"
  assert_contains "$LINE" "gh pr ready" "the line should name the move that lands a draft"
  assert_contains "$LINE" "--repo $REPO" \
    "the command names the repository: a bare number cannot resolve it from a background shell"
  assert_not_contains "$LINE" "the next move is yours" \
    "a draft must not invite another push as the move that lands it"
  assert_not_contains "$LINE" "CONFLICTS" "a draft is not a conflict"
}

test_reviewing_dirty_still_says_conflicts() {
  reset_fixture
  MERGEABLE_STATE=dirty
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a live 👀 with nothing posted is a round in flight"
  assert_contains "$LINE" "wait it out" "an in-flight round is still waited out"
  assert_contains "$LINE" "$CONFLICT" \
    "a round in flight on a conflicted PR is a round CI is not testing, and the line must say so"
}

test_expected_dirty_says_conflicts() {
  reset_fixture
  MERGEABLE_STATE=dirty
  run_status
  assert_eq "$(state_tok "$STATE")" expected "an unreviewed head with no 👀 is expected"
  assert_contains "$LINE" "review EXPECTED" "expected renders as before"
  assert_contains "$LINE" "$CONFLICT" "a push awaiting review on a conflicted PR should say CONFLICTS"
}

test_approved_dirty_says_conflicts_and_survives_a_failed_pr_read() {
  reset_fixture
  MERGEABLE_STATE=dirty
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "👍 is the merge gate"
  assert_contains "$LINE" "$CONFLICT" "an approved conflicted PR should say the merge will not build"
  FAIL_PULLS=1
  run_status
  assert_eq "$(state_tok "$STATE")" approved \
    "a failed PR read must not hide a 👍 behind unknown: the reactions feed alone answers it"
  assert_eq "$(state_merge "$STATE")" unread "a failed PR read is 'unread', not a value"
  assert_not_contains "$LINE" "CONFLICTS" "an unread mergeability must not claim a conflict"
  assert_contains "$LINE" "mergeability UNREAD" \
    "an approved line that could not read the mergeability must say so, not look clean"
}

test_reviewing_with_a_failed_pr_read_says_unread() {
  reset_fixture
  FAIL_PULLS=1
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a live 👀 is a round in flight whatever the PR read did"
  assert_contains "$LINE" "wait it out" "the round is still waited out"
  assert_contains "$LINE" "mergeability UNREAD" \
    "a reviewing line that could not read the mergeability must say so"
  assert_contains "$LINE" "not 'no'" "unread must not read as 'does not conflict'"
}

test_head_is_read_after_the_feeds() {
  # A push lands between the feed reads and the PR read: the review on file is of the PREVIOUS
  # head. Read after the feeds, the PR read sees the new head and the state is expected; read
  # before them, the old head would have matched its own review and reported idle.
  idle_fixture
  PUSH_ON_REVIEWS_READ=1
  run_status
  PUSH_ON_REVIEWS_READ=""
  assert_eq "$(state_tok "$STATE")" expected \
    "a head pushed while the feeds were read is unreviewed, not idle"
  assert_contains "$(state_detail "$STATE")" "no review of head new-hea" \
    "the state should be about the head as read after the feeds"
  local order
  order=$(awk -v feed="repos/$REPO/pulls/7/reviews?per_page=100" -v pr="repos/$REPO/pulls/7" '
    $0 == feed { f = NR } $0 == pr { p = NR }
    END { if (f && p && p > f) print "after"; else print "feed=" f " pr=" p }' "$REQUEST_LOG")
  assert_eq "$order" after "the PR read should come after the reviews feed"
}

test_computing_mergeability_is_not_a_conflict() {
  idle_fixture
  MERGEABLE_STATE=unknown
  run_status
  assert_eq "$(state_merge "$STATE")" unknown "GitHub still computing is carried as is"
  assert_contains "$LINE" "the next move is yours" \
    "a mergeability still being computed does not take the move away: only a known conflict does"
  assert_not_contains "$LINE" "CONFLICTS" "unknown mergeability is not a conflict"
  assert_contains "$LINE" "mergeability NOT YET COMPUTED" \
    "the first status after a push that caused a conflict must not read as a clean bill of health"
  assert_contains "$LINE" "re-read status in a minute" \
    "the caveat should name the remedy: look again once GitHub has computed it"
}

test_failed_pr_read_is_unknown_where_the_head_decides() {
  idle_fixture
  FAIL_PULLS=1
  run_status
  assert_eq "$(state_tok "$STATE")" unknown "idle needs the head SHA, and it was not read"
  assert_contains "$(state_detail "$STATE")" "the pulls API did not answer for the head SHA" \
    "the detail should say which read failed"
  assert_contains "$(state_detail "$STATE")" "HTTP 500" \
    "the detail should quote the PR read's own error, not a later call's"
  run_cmd_status
  assert_eq "$CMD_RC" 3 "an unread state is exit 3, not 'not approved'"
}

test_one_pr_read_per_status() {
  # A no-findings verdict for ANOTHER head used to cost a second PR read on the way to idle.
  idle_fixture
  COMMENTS_JSON="[$(verdict_comment 9 other-sha "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a verdict naming another head does not approve this one"
  assert_eq "$(pulls_reads)" 1 "the head and the mergeability come from one PR read"
}

test_detail_is_the_last_field_and_keeps_pipes() {
  local line='unknown|-|-|gh: 502 | Bad Gateway'
  assert_eq "$(state_tok "$line")" unknown "token is the first field"
  assert_eq "$(state_age "$line")" - "age is the second field"
  assert_eq "$(state_merge "$line")" - "mergeability is the third field"
  assert_eq "$(state_detail "$line")" 'gh: 502 | Bad Gateway' "detail is everything after the third |"
}

test_watch_reads_the_drift_when_a_round_lands() {
  idle_fixture
  MERGEABLE_STATE=dirty
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a review above the watermark is a round to act on"
  assert_contains "$WATCH_OUT" "--- review id=5" "the round is on stdout, as poll prints it"
  assert_contains "$WATCH_OUT" "watermark: " "the watermark is on stdout, last"
  assert_not_contains "$WATCH_OUT" "base freshness" "the drift read must not pollute poll's stdout"
  assert_contains "$WATCH_ERR" "base freshness $REPO#7: 7 commit(s) behind main, 15 ahead" \
    "the drift count should be read against the base's tip the round it matters"
  assert_contains "$WATCH_ERR" "!!! $REPO#7 CONFLICTS with main (mergeable_state=dirty)" \
    "the drift read should say the PR conflicts"
  assert_contains "$WATCH_ERR" "status: nothing in flight" "the status context still prints"
  assert_contains "$WATCH_ERR" "$CONFLICT" "the status context carries the conflict"
  assert_contains "$(cat "$REQUEST_LOG")" "repos/$REPO/compare/base-sha...head-sha?per_page=1" \
    "the forward compare should be read on a round"
}

test_watch_approved_leaves_the_drift_to_merge() {
  reset_fixture
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "an approval is something to act on"
  assert_contains "$WATCH_OUT" "approved (👍 from" "the approval is on stdout"
  assert_not_contains "$(cat "$REQUEST_LOG")" "compare/" \
    "merge prints the drift read next; the watch does not duplicate it"
}


# --- one observation per round (ludics-lite#95) ------------------------------------------------
# A watch round used to read the comments, the reviews and the PR twice: once for the round and
# once again, a second later, for the state reported beside it. The round now publishes what it
# read and the state takes it, so both halves of a round are about one pair of instants. These
# cases pin the three things that made the second read look necessary — the call count it cost,
# the ordering it kept, and the head it was anchored on — and the two it must not break: a failed
# round hands the state nothing, and a `status` on its own still reads for itself.

test_a_round_and_its_state_are_one_read() {
  idle_fixture
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a review of the head is a round to act on"
  # Two of each, and both are reads the watch could not do without: one for the state the watch
  # opens with (nothing has been polled yet) and one for the round. Before the snapshot each of
  # these was read THREE times a window — the opening state, the round, and the state read again
  # beside it — which on a real watch is four duplicated calls every ninety seconds.
  assert_eq "$(reads_of 'issues/7/comments?per_page=100')" 2 \
    "the comments feed should be read once for the opening state and once for the round"
  assert_eq "$(reads_of 'pulls/7/reviews?per_page=100')" 2 \
    "the reviews feed should be read once for the opening state and once for the round"
  # Three PR reads, and the third is not a duplicate of either: `watch_act` reads the base drift
  # when a round lands, which asks the PR for its base branch and its mergeability at merge-advice
  # time. It is one read per ROUND THAT LANDS, not one per poll, and it is a different question.
  assert_eq "$(pulls_reads)" 3 \
    "one PR read for the opening state, one for the round, and the drift read a landing round makes"
  # The per-review comments endpoint is the other duplicate: poll re-reads a new review's own
  # comments because the flat feed lags it, and substantive_reviews asks the same question of the
  # same review to tell an envelope from findings.
  reset_fixture
  REVIEWS_JSON="[$(review 5 head-sha "$PAST" | jq '.body=""')]"
  INLINE_JSON="[$(jq -cn --arg rev "$REVIEWER" \
    '{id:41, user:{login:($rev + "[bot]")}, path:"a.sh", line:3, body:"a finding",
      original_commit_id:"head-sha", commit_id:"head-sha"}')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "an empty-bodied review with findings of its own is still a round"
  assert_eq "$(reads_of 'pulls/7/reviews/5/comments?per_page=100')" 2 \
    "review 5's own comments should be read once for the opening state and once for the round"
}

test_a_round_reads_the_head_after_its_feeds() {
  # The #47 ordering, now a property of the ROUND: the push lands on the round's reviews read, so
  # the review on file is of the head as it was when the feeds were read and the head read after
  # them is the new one. The round holds its item back and the state is about the new head.
  # Reversed — the head read before the feeds — the round would have matched that review to the
  # head it named and acted on it, and the state beside it would have reported `idle` for a head
  # that had already been replaced.
  idle_fixture
  # A head pushed seconds ago, so the `expected` grace this leaves cannot expire underneath the
  # case and turn the quiet window into the nudge verdict.
  HEAD_AT=$(clock_at)
  PUSH_ON_REVIEWS_READ=2
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 "a review of the head the feeds were read at is not a review of the new head"
  assert_contains "$WATCH_ERR" "NOT about head ${PUSHED_HEAD:0:7}" \
    "the round should classify its item against the head read after its feeds"
  assert_contains "$WATCH_ERR" "no review of head ${PUSHED_HEAD:0:7}" \
    "and the state beside it should be about that same head, never the one the push replaced"
  local order
  order=$(awk -v feed="repos/$REPO/pulls/7/reviews?per_page=100" -v pr="repos/$REPO/pulls/7" '
    $0 == feed { f = NR } $0 == pr { p = NR }
    END { if (f && p && p > f) print "after"; else print "feed=" f " pr=" p }' "$REQUEST_LOG")
  assert_eq "$order" after "the round's PR read should come after its feeds"
}

test_the_state_is_about_the_head_the_round_was_classified_against() {
  # The push lands in the gap the second read opened: after the round's head read, before the
  # state beside it. Re-anchoring there is what swallowed a round just delivered about the head
  # being watched (the P2 rebutted in the review of ludics-lite#84) — the watch would print the
  # round and, beside it, a state saying no review of the head exists.
  idle_fixture
  PUSH_AFTER_PULLS_READ=2
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the round about the head the feeds were read at is still the round"
  assert_contains "$WATCH_ERR" "reviewed head ${HEAD_SHA:0:7}" \
    "the state should name the head the round was classified against"
  assert_not_contains "$WATCH_ERR" "no review of head" \
    "a push landing after the round's head read must not re-anchor the state to it"
}

test_a_failed_round_hands_the_state_nothing() {
  # Only a round that ANSWERED publishes. A poll that failed leaves no snapshot, so the state read
  # after it reads the feeds itself and reports what its own read says — the collapse api_list
  # refuses to make (a failed read as an empty feed) must not come back in through the snapshot.
  idle_fixture
  FAIL_INLINE_FEED=1
  run_watch 0,0,0 9 1
  assert_eq "$WATCH_RC" 3 "a window whose polls never answered is not a quiet window"
  assert_contains "$WATCH_ERR" "the next move is yours" \
    "the state beside a failed round is still read, and reads the reviewer's idle head"
  assert_eq "$(reads_of 'pulls/7/reviews?per_page=100')" 4 \
    "one read per failed poll and one per state read after it: nothing is shared from a round that failed"
}

test_status_after_a_watch_reads_for_itself() {
  # The snapshot belongs to its watch. A `status` asked afterwards — the same process, since these
  # suites source the script — must read the PR as it is now, not replay the window that ended.
  idle_fixture
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the round lands and the watch returns"
  REVIEWS_JSON="[$(review 5 other-sha "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "a status after the watch should read the feeds as they are now"
  assert_contains "$(state_detail "$STATE")" "no review of head ${HEAD_SHA:0:7}" \
    "and report the head it just read, not the one the watch was holding"
}

test_a_dead_watch_s_snapshot_directory_is_swept() {
  # A watch killed with SIGKILL runs no EXIT trap, so its snapshot files outlive it. They are one
  # directory per process, named with the owning pid, and the next watch to start sweeps the ones
  # whose owner is gone — without touching a CONCURRENT watch's, which is the failure mode that
  # matters: several watches share a TMPDIR routinely, one per PR in flight.
  idle_fixture
  local root live dead dead_dir live_dir
  root="$TEST_ROOT/snap-root"
  mkdir -p "$root"
  # A pid that is certainly gone: a child that has already exited and been reaped.
  (exit 0) &
  dead=$!
  wait "$dead" 2>/dev/null || true
  # And one that is certainly alive for the length of this case.
  sleep 30 &
  live=$!
  dead_dir="$root/pr-review-snap.$dead.AAAAAA"
  live_dir="$root/pr-review-snap.$live.BBBBBB"
  mkdir -p "$dead_dir" "$live_dir"
  : >"$dead_dir/round.feeds.pr"
  : >"$live_dir/round.feeds.pr"
  # And the loose files the first cut of the snapshot left in TMPDIR, keyed the same way.
  : >"$root/pr-review-snap.$dead.feeds.pr"
  : >"$root/pr-review-snap.$live.feeds.pr"

  # The scratch root is the watch's TMPDIR: the sweep reads the environment of the call.
  TMPDIR="$root" run_watch 0,0,0
  kill "$live" 2>/dev/null || true
  wait "$live" 2>/dev/null || true

  assert_eq "$WATCH_RC" 0 "the round still lands; the sweep is not part of what a watch reports"
  if [ -d "$dead_dir" ]; then
    bail "the snapshot directory of a pid that is gone should be swept at watch start"
  fi
  if [ ! -d "$live_dir" ]; then
    bail "a live watch's snapshot directory must survive another watch's sweep"
  fi
  if [ -e "$root/pr-review-snap.$dead.feeds.pr" ]; then
    bail "a loose snapshot file of a pid that is gone should be swept too"
  fi
  if [ ! -e "$root/pr-review-snap.$live.feeds.pr" ]; then
    bail "a live watch's loose snapshot file must survive another watch's sweep"
  fi
  # And the watch left nothing of its own in the root once it returned: no loose snapshot file,
  # and no directory of its own either, so the live watch's two entries are all there is. Where a
  # round is kept while the watch runs (memory in the Python; a per-process directory in the
  # retired shell) is not visible from outside; what a watch that returned leaves behind is.
  assert_eq "$(cd "$root" && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')" \
    "$(printf '%s\n' "pr-review-snap.$live.BBBBBB" "pr-review-snap.$live.feeds.pr" | LC_ALL=C sort | tr '\n' ' ')" \
    "a watch that returned leaves no snapshot file or directory of its own beside the live one's"
  rm -rf "$root"
}

test_every_other_family_a_dead_process_leaves_is_swept_too() {
  # The snapshot directory was never the only thing a killed run leaves in TMPDIR, and until
  # ludics-lite#219 it was the only thing anything collected. GH_ERR_FILE, gh_retry's per-attempt
  # capture, the constants probe's stderr in test-pr-review-lib.sh and a fixture suite's scratch
  # directory all outlive an owner that never reached its trap, and the sweep did not know their
  # names: seven of them sat in this box's real TMPDIR, dated 09-10 to 09-14.
  #
  # The live half is the half that matters. Ten fixture suites and several watches share one
  # TMPDIR on a wave day, so a sweep that went by age rather than by owner would delete a sibling's
  # fixtures mid-run — which is why every family carries the owning pid, and why a name whose pid
  # field is not a number is left alone instead of being guessed about.
  idle_fixture
  local root live dead f
  root="$TEST_ROOT/tmp-root"
  mkdir -p "$root"
  # A pid that is certainly gone: a child that has already exited and been reaped.
  (exit 0) &
  dead=$!
  wait "$dead" 2>/dev/null || true
  # And one that is certainly alive for the length of this case.
  sleep 30 &
  live=$!
  for f in "err.$dead" "gh.$dead.AAAAAA" "probe.$dead.err" \
    "err.$live" "gh.$live.BBBBBB" "probe.$live.err"; do
    : >"$root/pr-review-$f"
  done
  # test_tmpdir's directories, which are swept whole rather than file by file.
  mkdir -p "$root/pr-review-test.$dead.cwd-checkout.AAAAAA" \
    "$root/pr-review-test.$live.cwd-checkout.BBBBBB"
  : >"$root/pr-review-test.$dead.cwd-checkout.AAAAAA/fixture"
  # The shape the two unkeyed templates used to make: a suffix where the pid should be. It names
  # no owner, so this sweep has nothing to decide about it and must leave it exactly where it is.
  : >"$root/pr-review-gh.vswQwU"

  TMPDIR="$root" run_watch 0,0,0
  kill "$live" 2>/dev/null || true
  wait "$live" 2>/dev/null || true

  assert_eq "$WATCH_RC" 0 "the round still lands; the sweep is not part of what a watch reports"
  for f in "err.$dead" "gh.$dead.AAAAAA" "probe.$dead.err"; do
    if [ -e "$root/pr-review-$f" ]; then
      bail "pr-review-$f: a file whose owning pid is gone should be swept at watch start"
    fi
  done
  if [ -d "$root/pr-review-test.$dead.cwd-checkout.AAAAAA" ]; then
    bail "a dead suite's scratch directory should be swept whole, fixtures and all"
  fi
  for f in "err.$live" "gh.$live.BBBBBB" "probe.$live.err"; do
    if [ ! -e "$root/pr-review-$f" ]; then
      bail "pr-review-$f: a LIVE sibling's file must survive another run's sweep"
    fi
  done
  if [ ! -d "$root/pr-review-test.$live.cwd-checkout.BBBBBB" ]; then
    bail "a live suite's scratch directory must survive another run's sweep"
  fi
  if [ ! -e "$root/pr-review-gh.vswQwU" ]; then
    bail "a name with no pid in it names no owner, and must be left alone rather than aged out"
  fi
  rm -rf "$root"
}

# --- the reviewer that never started (ludics-lite#78) ------------------------------------------
# The head is the SHA the first ocannl-staging#677 failure named, so "the ref it could not fetch"
# and "the PR's head" are the same string, as they were there.
failed_fixture() { # <the ref the failure names, or - for none>
  reset_fixture
  HEAD_SHA="$FAILED_HEAD"
  COMMENTS_JSON="[$(failure_comment 100 "$1" "$PAST")]"
}

test_initialization_failure_is_its_own_state() {
  failed_fixture "$FAILED_HEAD"
  run_status
  assert_eq "$(state_tok "$STATE")" failed \
    "the reviewer's newest word saying it could not fetch the head is not a review that is due"
  assert_eq "$(state_merge "$STATE")" clean "the mergeability rides on this state line too"
  assert_contains "$LINE" "reviewer FAILED at initialization on head ${FAILED_HEAD:0:7} — " \
    "the line should name the state and the head it happened on"
  assert_contains "$LINE" "nudge it once with a '@codex review' comment" \
    "the line should name the move that usually gets the reviewer through"
  assert_contains "$LINE" "clone is behind, not your push" \
    "the line should say whose side the failure is on, since the push looks guilty"
  assert_not_contains "$LINE" "review EXPECTED" \
    "the failure must not read as a round that has yet to start"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "a state that was READ is exit 0, whatever it says"
  assert_contains "$CMD_OUT" "reviewer FAILED at initialization" "cmd_status should print it"
  assert_contains "$CMD_OUT" "review rounds with findings: 0 of 12" \
    "an attempt that never ran is not a round with findings"
}

# A failure that names no ref at all is still about the head the round was due on: it is the
# reviewer's newest word and it contradicts nothing.
# A failure that names no ref is not attributed to any head. Two review rounds went into trying:
# the only clock is the head commit's committer date, which a force-push or a reset to an older
# commit dates BEFORE the failure, so the old failure would be reported against a head whose round
# is still inside its grace. The cost of not attributing it is one grace, on a shape the connector
# has never posted; the cost of attributing it wrongly is a nudge over a round that is coming.
test_a_failure_naming_no_ref_is_not_attributed() {
  failed_fixture -
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "a failure that names no head is not evidence about this one"
  assert_contains "$LINE" "review EXPECTED but not started" "the ordinary due-round line"
  assert_not_contains "$LINE" "FAILED at initialization" "and no verdict is claimed from it"
  # The same body WITH the ref is the shape that fires: this case is about the ref, nothing else.
  COMMENTS_JSON="[$(failure_comment 100 "$FAILED_HEAD" "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed "the ref is what attributes a failure to a head"
}

# The deliberate, loud miss. The matcher is the reviewer's own opening sentence and nothing
# looser, so a failure worded differently reads as `expected` and costs one grace. Every looser
# shape tried in review swallowed a comment-only ROUND whose finding quotes the ref error, which
# costs a finding and says nothing — the trade is stated in the matcher's comment.
test_a_differently_worded_failure_is_missed_not_guessed() {
  reset_fixture
  HEAD_SHA="$FAILED_HEAD"
  COMMENTS_JSON="[$(plain_comment 100 "$PAST" "$(printf '%s\n\n```\nProvided git ref %s does not exist\n```\n' \
    'Codex Review: the review could not be started.' "$FAILED_HEAD")")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "the opening sentence is the whole matcher: anything else waits out the grace"
  # And a finding that gets as far as the retry instruction before diverging: the sentence is
  # matched through the command it names, not up to the last word they share.
  COMMENTS_JSON="[$(plain_comment 101 "$PAST" "$(printf '%s\n\n```\nProvided git ref %s does not exist\n```\n' \
    'Codex Review: Something went wrong. Try again later by commenting on the retry logic' \
    "$FAILED_HEAD")")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "the sentence runs through '@codex review', so a finding that stops short is a finding"
}

# The finding this state could hide, and the reason the matcher is anchored to that sentence: a
# comment-only ROUND whose finding quotes the CURRENT head's ref error. Reported as `failed` it
# would send the caller to nudge while the round's finding sat unread in the same comment.
test_a_round_quoting_this_head_s_ref_error_is_not_a_failure() {
  reset_fixture
  HEAD_SHA="$FAILED_HEAD"
  COMMENTS_JSON="[$(plain_comment 100 "$PAST" "$(printf '%s\n\n```\nProvided git ref %s does not exist\n```\n\n%s\n' \
    'Codex Review: P2 — the matcher reads a quoted error as a failure' "$FAILED_HEAD" \
    'so a round about it disappears.')")]"
  run_status
  assert_not_contains "$LINE" "FAILED at initialization" \
    "a round that quotes this head's ref error is a round, not the reviewer failing"
  assert_eq "$(state_tok "$STATE")" expected "and it reads as the round it is"
  # The compound of that and the sentence: a finding whose own first words are the connector's,
  # over the same quoted error. The matcher takes the sentence WHOLE, through the retry
  # instruction, so "Something went wrong in the retry path" is a finding about a retry path.
  COMMENTS_JSON="[$(plain_comment 101 "$PAST" "$(printf '%s\n\n```\nProvided git ref %s does not exist\n```\n' \
    'Codex Review: Something went wrong in the retry path, and the head it names is this one' \
    "$FAILED_HEAD")")]"
  run_status
  assert_not_contains "$LINE" "FAILED at initialization" \
    "three shared words are not the failure sentence"
  assert_eq "$(state_tok "$STATE")" expected "the finding stands as a round"
}

# Both moves are on the line, in order, whatever the history: the nudge that usually works, and
# the new head for when it does not. No count decides between them — a reaction-only success
# leaves nothing to count from, and the re-request that fails clears the 👍 that was its only
# trace (review of #82, round 6), so a script that claimed to know which case you are in would
# be claiming more than the feeds can tell it.
test_the_line_states_both_moves() {
  failed_fixture "$FAILED_HEAD"
  run_status
  assert_contains "$LINE" "nudge it once with a '@codex review' comment" "the first move"
  assert_contains "$LINE" "if the SAME head fails again, push a new head instead" "the second"
  assert_contains "$LINE" "pr-review.sh comment $REPO#" "the nudge should be runnable"
  # A second failure on the same head does not change the line: it was already saying this.
  COMMENTS_JSON="[$(failure_comment 100 "$FAILED_HEAD" "$PAST"),$(
    failure_comment 101 "$FAILED_HEAD" 2026-09-01T00:03:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed "still a failure"
  assert_contains "$LINE" "if the SAME head fails again, push a new head instead" \
    "the escalation is stated the same way, not counted into"
}

# The head moved on after the failure: a round is due on the NEW head, and that is `expected`.
test_a_failure_naming_another_head_is_expected() {
  failed_fixture "$OTHER_REF"
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "a failure about a head that has since been replaced is a round due on the new one"
  assert_contains "$LINE" "review EXPECTED but not started" "the ordinary due-round line"
  assert_not_contains "$LINE" "FAILED at initialization" \
    "the previous head's failure must not be reported against this one"
}

test_a_round_of_the_head_after_the_failure_wins() {
  failed_fixture "$FAILED_HEAD"
  REVIEWS_JSON="[$(review 5 "$FAILED_HEAD" 2026-09-01T01:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle \
    "a round that landed on this head after the failure is the newer truth"
  # The negative control on the same comparison: the round landed BEFORE the failed re-request
  # (a '@codex review' with no push), so it does not answer for it.
  REVIEWS_JSON="[$(review 5 "$FAILED_HEAD" 2026-08-31T23:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed \
    "a round from before the failure does not make the failed re-request a round"
  # And a review of some OTHER head is not a review of this one, whenever it landed.
  REVIEWS_JSON="[$(review 5 old-head-sha 2026-09-01T01:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed "the comparison is against reviews of THIS head"
}

test_a_newer_reviewer_word_supersedes_the_failure() {
  failed_fixture "$FAILED_HEAD"
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing \
    "a 👀 raised after the failure is a round that started after it — wait that one out"
  failed_fixture "$FAILED_HEAD"
  COMMENTS_JSON="[$(failure_comment 100 "$FAILED_HEAD" "$PAST"),$(
    verdict_comment 101 "$FAILED_HEAD" 2026-09-01T01:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved \
    "a no-findings verdict after the failure is the reviewer's newest word"
  failed_fixture "$FAILED_HEAD"
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "the 👍 is the merge gate whatever followed it"
}

# The wrong verdict this state could produce, and the anchor that refuses it. A review QUOTING the
# failure — this repository's own reviewer reads these fixtures — must not be read as one.
test_a_quoted_failure_is_not_a_failure() {
  reset_fixture
  HEAD_SHA="$FAILED_HEAD"
  COMMENTS_JSON="[$(plain_comment 100 "$PAST" "$(printf '%s\n\n```\n%s\n```\n\n%s\n' \
    'Round 3, on the summary: the matcher is anchored to the body start, so' \
    "$FAILURE_HEAD_LINE" 'quoting it in a finding cannot fire the state.')")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "a finding that quotes the failure sentence is not the reviewer failing"
  # Quoted whole, ref line and all: still a quotation, since the sentence is not where the body
  # opens. (The ref-vs-head guard behind the anchor is what
  # test_a_failure_naming_another_head_is_expected exercises, on a genuine failure body.)
  COMMENTS_JSON="[$(plain_comment 101 "$PAST" "$(printf 'Round 4, the fixture body is\n\n%s\n' \
    "$(failure_body "$OTHER_REF")")")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "a failure quoted below the first line is a quotation, not the reviewer failing"
}

# ludics-lite#792: the first move over an initialization failure is the one '@codex review',
# which clears nothing while no 👍 stands, so `watch` posts it itself as it does for a Failed row
# (#791's opening drew the missing-environment answer 27 seconds after its head's commit, and the
# worker posted that request by hand), then waits out its grace.
test_watch_requests_over_the_initialization_failure_once() {
  retune GRACE=2
  failed_fixture "$FAILED_HEAD"
  # The watermark is already past the comment: this is the SECOND window, the one that used to
  # report "review EXPECTED but not started" and wait the grace out, then handed the post back.
  run_watch 0,200,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "one request posted over the initialization failure"
  assert_contains "$WATCH_ERR" "re-requested the review with '@codex review' — the initialization on head ${FAILED_HEAD:0:7} failed" \
    "the watch says it did"
  assert_contains "$WATCH_ERR" "fresh review nudge; waiting for pickup" "and then waits out the request's grace"
  assert_not_contains "$WATCH_OUT" "FAILED" "the failure it answered is not the verdict"
  assert_contains "$WATCH_OUT" "watermark: " "the watch still ends on a watermark"
  # The first window, where the comment is itself the new activity (ludics#824): it is not a
  # round, so the window prints it for the record and posts the same one request instead of
  # ending on it with "`watch` posts it itself" and no post.
  failed_fixture "$FAILED_HEAD"
  run_watch 0,0,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "the window that sees the failure comment posts the request"
  assert_contains "$WATCH_ERR" "are the reviewer's initialization failure (first: summary id=100" \
    "the comment is named as the failure, not a round"
  assert_contains "$WATCH_ERR" "--- summary id=100" "and printed for the record"
  assert_not_contains "$WATCH_OUT" "--- summary id=100" "stdout is not ended on it"
}

# The same head failing again after a request on it keeps the exit, with the move that is left:
# a new head for the git-ref shape (the next is the maintainer's, for the environment one).
test_watch_hands_back_an_initialization_failure_after_a_request() {
  failed_fixture "$FAILED_HEAD"
  COMMENTS_JSON="[$(request_comment 99 2026-09-01T00:01:00Z),$(failure_comment 100 "$FAILED_HEAD" 2026-09-01T00:03:00Z)]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" git-again "a failure answering a request on this head"
  assert_contains "$LINE" "request at 2026-09-01T00:01:00Z" "naming the request it answers"
  run_watch 0,200,0 1 3
  assert_eq "$WATCH_RC" 0 "a second failure is something to act on"
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "and nothing is posted"
  assert_contains "$WATCH_OUT" "reviewer FAILED at initialization AGAIN on head ${FAILED_HEAD:0:7}" \
    "the verdict is on stdout"
  assert_contains "$WATCH_OUT" "not re-requested a second time: push a new head" "with the git-ref shape's move"
  assert_contains "$WATCH_ERR" "base freshness $REPO#7:" \
    "the drift read rides along, as it does on the other exits"
  # A request from before the head arrived was an earlier head's: still the first failure.
  HEAD_AT=2026-09-01T00:02:00Z
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" git "a request before the head arrived is not on it"
  # A request after the failure has answered it: the round it asked for is due, not a failure.
  failed_fixture "$FAILED_HEAD"
  COMMENTS_JSON="[$(failure_comment 100 "$FAILED_HEAD" 2026-09-01T00:03:00Z),$(request_comment 101 2026-09-01T00:04:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a failure already re-requested is not re-requested again"
}

# The request's gates beyond the state read: a 👍 on the PR, whatever head it is for (a request
# clears it), or a PR that is not open and clean bars the post, and `--no-nudge` leaves it to the
# caller; each exits with the advice.
test_watch_does_not_request_over_an_initialization_failure_when_barred() {
  failed_fixture "$FAILED_HEAD"
  REACTIONS_JSON="[$(reaction +1 2026-08-31T23:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed "control: a 👍 older than the head leaves the failure standing"
  run_watch 0,200,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "nothing is posted"
  assert_eq "$WATCH_RC" 0 "the failure is the caller's to act on"
  assert_contains "$WATCH_OUT" "the watch did not post the '@codex review' over the initialization failure on head ${FAILED_HEAD:0:7}: a 👍 from" \
    "the verdict says why"
  # Review of #805, round 1: a push landing after the failed state's fresh read is a head that has
  # not failed, and the gate's read clearing that new head does not license a request for it. The
  # third PR read is that fresh read's; the gate's own reads see the new head.
  failed_fixture "$FAILED_HEAD"
  PUSH_AFTER_PULLS_READ=3
  run_watch 0,200,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 \
    "nothing is posted for a head that has not failed"
  assert_eq "$WATCH_RC" 1 "the final read finds the new head due, so the caller re-arms"
  assert_contains "$WATCH_OUT" "the state moved to 'expected' while it was being read" "and says so"
  # The write gate, as the stall nudge's: a PR that conflicts with its base is not nudged.
  failed_fixture "$FAILED_HEAD"
  MERGEABLE_STATE=dirty
  run_watch 0,200,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "nothing is posted"
  assert_contains "$WATCH_OUT" "failure on head ${FAILED_HEAD:0:7}: the PR reads open but mergeable_state=dirty, not open" \
    "the verdict says why"
  failed_fixture "$FAILED_HEAD"
  WATCH_FLAG=--no-nudge
  run_watch 0,200,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "nothing is posted"
  assert_eq "$WATCH_RC" 0 "the failure is the caller's to act on"
  assert_contains "$WATCH_OUT" "--no-nudge: the watch did not re-request the initialization failure on head ${FAILED_HEAD:0:7}" \
    "the verdict says the request is the caller's"
  assert_contains "$WATCH_OUT" "reviewer FAILED at initialization on head ${FAILED_HEAD:0:7}" "beside the state it is about"
}

# --- the missing environment (ludics-lite#421) -------------------------------------------------
# The connector's other way of not starting, verbatim from PR #420 (issuecomment-5846369911). It
# names no ref, so it is attributed by the clock: newer than the head's commit date (HEAD_AT).
ENV_FAILURE_BODY='To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).'
ENV_FAILED_AT=2026-09-01T00:05:00Z

env_failed_fixture() { # [created_at]
  reset_fixture
  COMMENTS_JSON="[$(plain_comment 100 "${1:-$ENV_FAILED_AT}" "$ENV_FAILURE_BODY")]"
}

test_the_missing_environment_is_a_failed_state() {
  env_failed_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" failed \
    "the connector saying it has no environment is a round that never ran, not one that is due"
  assert_contains "$LINE" "reviewer FAILED at initialization on head head-sh — " \
    "the line should name the state and the head"
  assert_contains "$LINE" "nudge it once with a '@codex review' comment" "the first move is the nudge"
  assert_contains "$LINE" "create an environment for this repo" "the line says which failure it was"
  assert_contains "$LINE" "the environment is the maintainer's to set up" \
    "and whose the second move is, since no push reaches it"
  assert_not_contains "$LINE" "clone is behind" "the git-ref diagnosis is not this failure's"
  assert_not_contains "$LINE" "review EXPECTED" "and it must not read as a round yet to start"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "a state that was READ is exit 0"
  assert_contains "$CMD_OUT" "review rounds with findings: 0 of 12" \
    "an attempt that never ran is not a round with findings"
}

# The clock is the only attribution this shape has, so both of its edges are pinned: an answer
# older than the head's commit is about a head since replaced, and a commit date that cannot be
# read, or lies in the future, attributes nothing — each costs the grace rather than a nudge.
test_the_missing_environment_is_attributed_by_the_clock() {
  env_failed_fixture 2026-08-31T23:55:00Z
  run_status
  assert_eq "$(state_tok "$STATE")" expected \
    "an answer from before the head's commit is not about this head"
  assert_not_contains "$LINE" "FAILED at initialization" "and no failure is claimed from it"
  env_failed_fixture
  HEAD_AT=""
  run_status
  assert_eq "$(state_tok "$STATE")" expected "an unread commit date attributes nothing"
  env_failed_fixture
  HEAD_AT=2099-01-01T00:00:00Z
  run_status
  assert_eq "$(state_tok "$STATE")" expected "nor does a commit date in the future"
  # And a round of this head after the answer is the newer truth, as for the git-ref shape.
  env_failed_fixture
  REVIEWS_JSON="[$(review 5 head-sha 2026-09-01T01:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "the round the nudge got supersedes the failure"
}

# ludics-lite#792 on the environment shape, #791's own: the first answer draws the watch's one
# request; the same answer after a request on the head is the maintainer's, handed back unposted.
test_watch_requests_over_the_missing_environment_once() {
  retune GRACE=2
  env_failed_fixture
  run_watch 0,200,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "one request posted over the missing environment"
  assert_contains "$WATCH_ERR" "re-requested the review with '@codex review' — the initialization on head head-sh failed" \
    "the watch says it did"
  assert_not_contains "$WATCH_OUT" "FAILED" "the failure it answered is not the verdict"
  env_failed_fixture
  COMMENTS_JSON="[$(request_comment 99 2026-09-01T00:02:00Z),$(plain_comment 100 "$ENV_FAILED_AT" "$ENV_FAILURE_BODY")]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" env-again "the same answer after a request on this head"
  run_watch 0,200,0 1 3
  assert_eq "$WATCH_RC" 0 "a second failure is something to act on"
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "and nothing is posted"
  assert_contains "$WATCH_OUT" "reviewer FAILED at initialization AGAIN on head head-sh" "the verdict is on stdout"
  assert_contains "$WATCH_OUT" "the environment is the maintainer's to set up" "with the maintainer as the move"
  assert_not_contains "$WATCH_OUT" "push a new head" "no push reaches it"
}

# Anchored like the git-ref shape: the sentence has to OPEN the body, so a finding that quotes it
# is a finding.
test_a_quoted_missing_environment_is_not_a_failure() {
  reset_fixture
  COMMENTS_JSON="[$(plain_comment 100 "$ENV_FAILED_AT" "$(printf 'Codex Review: P2 — the connector said\n\n> %s\n\nand this reads it as a round.' \
    "$ENV_FAILURE_BODY")")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a quotation of the sentence is not the reviewer failing"
  # Nor a finding that opens with the words and carries on (review of #434, round 1).
  COMMENTS_JSON="[$(plain_comment 101 "$ENV_FAILED_AT" \
    'To use Codex here, create an environment for this repository before running the tests.')]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "'repository' is not the connector's 'repo'"
}

# The merge gate against a failure, both ways round — the deliberate part of the ranking. A round
# that ANNOUNCED itself and then failed closes the gate; a re-request that never announced itself
# does not withdraw the verdict this head already has, exactly as a 👍 would not be withdrawn.
test_a_standing_verdict_survives_a_failed_re_request() {
  failed_fixture "$FAILED_HEAD"
  COMMENTS_JSON="[$(verdict_comment 99 "$FAILED_HEAD" "$PAST"),$(
    failure_comment 100 "$FAILED_HEAD" 2026-09-01T01:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved \
    "a round that never ran does not take back the verdict this head already has"
  assert_contains "$LINE" "no-findings verdict for head" "the approval names the verdict it rests on"
  # With a 👀 between them — the re-request that did announce a round — the verdict is no longer
  # the reviewer's newest word about the attempt, and the failure is what the caller must act on.
  REACTIONS_JSON="[$(reaction eyes 2026-09-01T00:30:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed \
    "a round that announced itself and then failed leaves the failure as the newest word"
  assert_contains "$LINE" "reviewer FAILED at initialization" "and the line says so"
}

# --- the verdict comment and the 👀 clock, pinned from the fix history ----------------------------
# Lessons the state machine learned in review rounds whose commits added no case of their own,
# pinned here before the v2 port (ludics-lite#403) so the rewrite cannot quietly drop one. Each
# names the commit that encoded it.
VERDICT_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# 254facf: the connector can deliver its no-findings verdict as an issue comment instead of the 👍
# (ocannl-staging#531, where a re-request had cleared the reaction while the comment persisted).
test_a_verdict_comment_naming_the_head_is_an_approval() {
  reset_fixture
  HEAD_SHA="$VERDICT_HEAD"
  COMMENTS_JSON="[$(verdict_comment 9 aaaaaaa "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a no-findings verdict naming the head approves it with no 👍"
  assert_contains "$(state_detail "$STATE")" "posted a no-findings verdict for head aaaaaaa at $PAST" \
    "the approval names the verdict it rests on"
  # The control: a verdict naming another head approves nothing here.
  COMMENTS_JSON="[$(verdict_comment 9 bbbbbbb "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a verdict for another head is not this head's"
}

# 0c4580d: a re-request without a push raises a fresh 👀 over a verdict whose SHA still matches; the
# verdict is the previous round's, and approving on it would open the gate under a running round.
test_a_verdict_older_than_a_fresh_eyes_is_not_an_approval() {
  reset_fixture
  HEAD_SHA="$VERDICT_HEAD"
  COMMENTS_JSON="[$(verdict_comment 9 aaaaaaa "$PAST")]"
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a 👀 newer than the verdict is a round still running"
}

# ac6c498 / 0c4580d: a verdict delivered by EDITING the round-started placeholder carries the edit
# time in updated_at, which is newer than the round's 👀, so it approves where a leftover would not.
test_an_edited_placeholder_verdict_approves_over_its_eyes() {
  reset_fixture
  HEAD_SHA="$VERDICT_HEAD"
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -120)")]"
  COMMENTS_JSON="[$(jq -cn --arg rev "$REVIEWER" --arg c "$PAST" --arg u "$(clock_at -30)" \
    '{id:9, user:{login:($rev + "[bot]")}, created_at:$c, updated_at:$u,
      body:"<!-- codex-pull-request-review-summary -->\nCodex Review: Didn'"'"'t find any major issues.\n**Reviewed commit:** `aaaaaaa`"}')]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "the edited placeholder's verdict is newer than the 👀 it answers"
  # The same comment never edited since before the 👀: a leftover, which the 👀 outranks.
  COMMENTS_JSON=$(jq -c --arg c "$PAST" 'map(.updated_at = $c)' <<<"$COMMENTS_JSON")
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "an unedited verdict older than the 👀 does not approve"
}

# e17ceac: a re-requested round on the same head that ends WITH findings spends its 👀 through its
# own review, and a SHA-only check would then approve on the earlier verdict over those findings.
test_a_verdict_older_than_a_later_findings_review_is_idle() {
  reset_fixture
  HEAD_SHA="$VERDICT_HEAD"
  COMMENTS_JSON="[$(verdict_comment 9 aaaaaaa 2026-09-01T00:00:00Z)]"
  REACTIONS_JSON="[$(reaction eyes 2026-09-01T00:30:00Z)]"
  REVIEWS_JSON="[$(review 5 "$VERDICT_HEAD" 2026-09-01T01:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "findings after the verdict are the reviewer's newer word"
}

# 0506b1e: the machine-tagged round-started placeholder lands moments after the 👀; counted as the
# reviewer's last word it made a LIVE 👀 look spent.
test_the_round_started_placeholder_does_not_spend_the_eyes() {
  reset_fixture
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  COMMENTS_JSON="[$(plain_comment 9 "$(clock_at -30)" '<!-- codex-pull-request-review-summary -->
🔄 Running')]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "the placeholder is an announcement, not the reviewer speaking"
  # The control: an untagged comment at the same moment IS the reviewer speaking, and spends it.
  COMMENTS_JSON="[$(plain_comment 9 "$(clock_at -30)" 'Codex Review: a finding')]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a comment after the 👀 spends it"
}

# b6b09ee: a reaction is a LEVEL, not an event, and the app does not always take its 👀 back
# (#364: three windows of "reviewing — wait it out" over a PR nothing was reading).
test_a_spent_eyes_is_not_a_running_round() {
  reset_fixture
  REACTIONS_JSON="[$(reaction eyes 2026-09-01T00:10:00Z)]"
  REVIEWS_JSON="[$(review 5 other-sha 2026-09-01T00:20:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a 👀 older than the reviewer's last review is spent"
  assert_not_contains "$LINE" "wait it out" "and nothing is waited out on it"
  # The same 👀 with nothing posted since, long past any round: stalled, never reviewing.
  REVIEWS_JSON='[]'
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a 👀 older than any round takes, with nothing since, is a stall"
  assert_contains "$(state_detail "$STATE")" "with nothing posted since" "and says so"
}

# 9197c23 / 3497844: an API failure and a genuinely empty feed both render as `[]`, so a read that
# failed reports UNKNOWN and exits 3 — never "no approval yet", the silent false negative on the
# merge gate that fired during the 2026-08-17 outage on an approved PR.
test_a_feed_that_did_not_answer_is_unknown_not_a_fact() {
  local feed
  for feed in reactions comments reviews; do
    idle_fixture
    FAIL_FEED="$feed"
    run_status
    assert_eq "$(state_tok "$STATE")" unknown "$feed: a feed that did not answer is unknown"
    assert_contains "$(state_detail "$STATE")" "the $feed API did not answer (gh: 503 No server" \
      "$feed: the detail names the read and quotes its error"
    assert_contains "$LINE" "this is NOT 'not approved', retry" "$feed: the line refuses rather than reports"
    run_cmd_status
    assert_eq "$CMD_RC" 3 "$feed: status exits 3 on a feed that did not answer"
  done
  # Under a 👍 the reactions feed alone decides, so a comments or reviews outage cannot hide it.
  approved_fixture
  FAIL_FEED=comments
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a 👍 stands over a comments read that did not answer"
}

# A feed jq refuses to parse is a read that did not answer, whatever another JSON parser makes of
# it. jq 1.8 refuses a lone high-surrogate escape ("Invalid \uXXXX\uXXXX surrogate pair escape");
# Python's json reads one as a code point, which once gave a definite state, exit 0, where the
# shell's api_list (and so `watch`) said UNKNOWN, exit 3.
test_a_feed_jq_cannot_parse_is_unknown_not_a_fact() {
  local feed
  for feed in comments reviews; do
    idle_fixture
    case "$feed" in
    comments) COMMENTS_JSON='[{"id":3,"user":{"login":"someone"},"created_at":"2026-09-01T00:00:00Z","body":"\ud83d"}]' ;;
    reviews) REVIEWS_JSON='[{"id":5,"user":{"login":"someone"},"state":"COMMENTED","commit_id":"head-sha","submitted_at":"2026-09-01T00:00:00Z","body":"x\ud83dy"}]' ;;
    esac
    run_status
    assert_eq "$(state_tok "$STATE")" unknown "$feed: a feed jq cannot parse is unknown"
    assert_contains "$(state_detail "$STATE")" "the $feed API did not answer" \
      "$feed: the detail names the read"
    run_cmd_status
    assert_eq "$CMD_RC" 3 "$feed: status exits 3 on a feed jq cannot parse"
  done
}

test_empty_reviews_need_their_own_findings() {
  reset_fixture
  REVIEWS_JSON="[$(review 88 "$HEAD_SHA" "$PAST" | jq '.body=" \n\t"')]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "empty envelope does not review the head"
  INLINE_JSON='[{"id":1,"body":"a real finding","pull_request_review_id":88}]'
  run_status
  assert_eq "$(state_tok "$STATE")" idle "own inline finding reviews head even while flat feed is empty"
  # The connector's environment reply in a thread, which a mention of the handle draws there
  # (ludics-lite#472; inline comment 4138519259 on #465, verbatim), is an envelope too: the head
  # it is filed on was not reviewed.
  INLINE_JSON='[{"id":4138519259,"in_reply_to_id":4138480284,"body":"To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).","pull_request_review_id":88}]'
  run_status
  assert_eq "$(state_tok "$STATE")" expected "the connector's thread reply does not review the head"
  FAIL_INLINE=1
  run_status
  assert_eq "$(state_tok "$STATE")" unknown "unread own inline feed is not empty"
  FAIL_INLINE=""
  INLINE_JSON='[]'
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "empty envelope preserves approval"
  HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  REVIEWS_JSON="[$(review 88 "$HEAD_SHA" 2026-09-01T00:02:00Z | jq '.body=null')]"
  COMMENTS_JSON="[$(plain_comment 1 "$PAST" '<!-- codex-pull-request-review-summary -->
| Code Review | Running <relative-time datetime="2026-09-01T00:01:00Z"> | `aaaaaaa` |')]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "newer empty envelope cannot supersede current-head Running row"
}

# --- a read that does not parse must not render as a fact (ludics-lite#89) ----------------------
# Each site is reached from OUTSIDE: a feed answering a shape its read cannot take (an entry that is
# not an object, a body that is not text), so the case judges what serves `status`. A site no feed
# can reach on its own -- an earlier read of the same feed takes every shape it would -- is broken
# by hand in the package's own tests instead (lib/ludics/tests/test_prreview_readers.py,
# BrokenReads); this suite broke the shell's jq programs for those until the shell was retired.

# assert_unknown_state <detail fragment> <site>: the state standing after a run refuses rather than
# answers. Each case pairs it with a control run on the same fixture, so an `unknown` the fixture
# itself produced could not pass for the site's own refusal.
assert_unknown_state() {
  assert_eq "$(state_tok "$STATE")" unknown "$2: a read that did not parse must not render as a value"
  assert_contains "$(state_detail "$STATE")" "$1" "$2: the detail should name the read that did not answer"
  assert_contains "$LINE" "this is NOT 'not approved', retry" \
    "$2: the rendered line should refuse, not report"
}

# A reviewer's comment whose body is not text: the shape that reaches a comment read past the
# reviewer filter every one of them applies first.
reviewer_entry_with_a_number_body() {
  jq -cn --arg rev "$REVIEWER" '{id:41, user:{login:($rev + "[bot]")}, created_at:"2026-09-01T00:00:00Z", body:7}'
}

test_a_broken_jq_program_is_unknown_not_a_value() {
  idle_fixture
  # The baseline the rest of this case rests on: read with nothing broken, this fixture is idle,
  # so every `unknown` below is a site refusing rather than the fixture's own reading.
  run_status
  assert_eq "$(state_tok "$STATE")" idle "the ordinary reading of this fixture"

  # An entry of the reactions feed that is not an object.
  REACTIONS_JSON='["not a reaction"]'
  run_status
  assert_unknown_state "the reactions feed did not parse" "the reactions feed"
  REACTIONS_JSON='[]'
  # A reviewer's comment whose body is not text: the first read of the comments takes it.
  COMMENTS_JSON="[$(reviewer_entry_with_a_number_body)]"
  run_status
  assert_unknown_state "the comments feed did not parse" "the reviewer's last comment"
  COMMENTS_JSON='[]'
}

test_a_broken_jq_program_is_unknown_on_the_pending_request_read() {
  idle_fixture
  # The watch watermark cmd_watch passes down; status_state reads it to identify the request a
  # round is owed to. A standalone `status` has none, so the site is reached by setting it here.
  local watch_nudge_after=0
  run_status
  assert_eq "$(state_tok "$STATE")" idle "control: the pending-request read changes nothing here"
  # The pending-request read is the first to take the comments, and reads every author's: a
  # comment above the watermark whose body is not text.
  COMMENTS_JSON='[{"id":42,"user":{"login":"me"},"created_at":"2026-09-01T00:00:00Z","body":7}]'
  run_status
  assert_unknown_state "the pending-request comments feed did not parse" "the pending-request read"
}

test_a_broken_jq_program_is_unknown_on_the_current_head_evidence() {
  reset_fixture
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "control: this fixture reaches the evidence scan"
  # Under a 👍 the evidence scan is the first read of the comments: a reviewer's body not text.
  COMMENTS_JSON="[$(reviewer_entry_with_a_number_body)]"
  run_status
  assert_unknown_state "the current-head review evidence did not parse" "the current-head evidence scan"
}

# The other half of ludics-lite#89: a `capture` that never errors, it just stops producing. The
# table test admits a Code Review Running row and SUMMARY_ROW_STAMP_RE re-matches the same
# row; unbracketed, a row the second pattern misses is deleted from the stream — with every row
# after it — and the older 👍 then stands unopposed. Bracketed, the miss is a null that is
# counted, and a table this script can only half read is not an approval.
test_a_running_row_the_stamp_pattern_misses_is_unknown() {
  reset_fixture
  HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
  COMMENTS_JSON="[$(plain_comment 1 "$PAST" '<!-- codex-pull-request-review-summary -->
| Code Review | Running <relative-time datetime="2026-09-01T00:01:00Z"> | `aaaaaaa` |')]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "control: a row both patterns read is read"
  # The same row with the `datetime` attribute the stamp pattern needs taken out: still a Running
  # row to the test beside it, no longer one the stamp can read.
  COMMENTS_JSON="[$(plain_comment 1 "$PAST" '<!-- codex-pull-request-review-summary -->
| Code Review | Running now | `aaaaaaa` |')]"
  run_status
  assert_eq "$(state_tok "$STATE")" unknown \
    "a Running row the stamp pattern cannot read is not an approval"
  assert_contains "$(state_detail "$STATE")" "matched the Running test but not the" \
    "the detail should name the two patterns that stopped agreeing"
}

# --- one reader of the summary's Running row (ludics-lite#752) -----------------------------------
# The 👍 path read Running rows from EVERY summary of the reviewer's; #586's arm, only the newest
# summary's newest row. Every arm reads that one row now, so a Running row in an older summary --
# a round the reviewer has since written past -- no longer holds a 👍 back.
test_an_older_summarys_running_row_does_not_outrank_the_thumbs_up() {
  reset_fixture
  HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  REACTIONS_JSON="[$(reaction +1 2026-09-01T00:01:00Z)]"
  COMMENTS_JSON="[$(plain_comment 1 2026-09-01T00:02:00Z '<!-- codex-pull-request-review-summary -->
| Code Review | Running <relative-time datetime="2026-09-01T00:02:00Z"> | `aaaaaaa` |'),$(plain_comment 2 2026-09-01T00:09:00Z '<!-- codex-pull-request-review-summary -->
| Code Review | ✅ **Completed** <relative-time datetime="2026-09-01T00:09:00Z"> | `aaaaaaa` |')]"
  run_status
  assert_eq "$STATE" "approved|-|clean|👍 from $REVIEWER" "the newest summary's row is the one read"
  # The control: the same Running row in the NEWEST summary is a round in flight on the head.
  COMMENTS_JSON="[$(plain_comment 1 2026-09-01T00:02:00Z '<!-- codex-pull-request-review-summary -->
| Code Review | Running <relative-time datetime="2026-09-01T00:02:00Z"> | `aaaaaaa` |')]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a newest Running row outranks the older 👍"
}

# --- a 👀 older than the head's arrival (#770's hand-back, folded into ludics-lite#752) -----------
# #770's head 1af99c3 read "STALLED ... 81m" seconds after its push: the 👀 its predecessor's hung
# round left up. Inside the head's pickup margin (knobs.PICKUP, the one watch holds its nudge for)
# that 👀 reads as the head's pickup; after it, as the stall it is, so watch's nudge stands.
test_an_old_eyes_over_a_fresh_push_is_its_pickup_then_its_stall() {
  reset_fixture
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -5000)")]"
  HEAD_AT=$(clock_at -60)
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a push a minute old is inside its pickup"
  assert_contains "$LINE" "predates head ${HEAD_SHA:0:7}'s arrival at $HEAD_AT" "and the line says why"
  HEAD_AT=$(clock_at -400)
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "past the pickup the 👀 is the stall it is"
  assert_contains "$(state_detail "$STATE")" "with nothing posted since" "aged from the 👀, as before"
}

# --- an approval over open review threads (ludics-lite#289) -----------------------------------
# PR #277, round 6: two findings written against the previous head, the 👍 on the base-merge commit
# above it, and a `status` that said `approved` over both. An open thread is a finding nobody
# closed, whatever head it cites, so an approval with one under it is reported as `unresolved`,
# naming each thread by the id `reply` and `resolve` take and saying what clears it.

graphql_reads() { grep -c -x graphql "$REQUEST_LOG" || true; }

approved_fixture() {
  reset_fixture
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
}

test_an_approval_over_open_threads_is_unresolved() {
  approved_fixture
  THREADS_JSON="[$(review_thread 4053098120 false),$(review_thread 4053098122 false b.sh),$(review_thread 4053098001 true)]"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "a state the reads answered exits 0; merge is the gate that refuses it"
  assert_contains "$CMD_OUT" "approved (👍 from $REVIEWER) BUT 2 review thread(s) still UNRESOLVED" \
    "the approval is named and so are the open threads under it"
  assert_contains "$CMD_OUT" "4053098120 by codex[bot] on a.sh, 4053098122 by codex[bot] on b.sh" \
    "each open thread by the id reply and resolve take"
  assert_not_contains "$CMD_OUT" 4053098001 "a resolved thread is not open"
  assert_contains "$CMD_OUT" "pr-review.sh resolve $REPO#7 <id>" "and the line says what clears it"
  assert_eq "$(graphql_reads)" 1 "one read of the threads, for the one approval reported"
}

test_an_approval_with_every_thread_resolved_stays_approved() {
  approved_fixture
  THREADS_JSON="[$(review_thread 4053098001 true)]"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "a clean approval"
  assert_contains "$CMD_OUT" "approved (👍 from $REVIEWER)" "reads as it always did"
  assert_not_contains "$CMD_OUT" UNRESOLVED "with nothing open under it"
}

test_status_walks_the_threads_once_whatever_the_state() {
  # The read budget since ludics-lite#587: `status` counts the open threads whatever the state, in
  # ONE walk the approval gate shares (a watch round that reports no approval still reads none:
  # test-pr-review-watch.sh's test_the_exit_counts_threads_by_head).
  idle_fixture
  THREADS_JSON="[$(review_thread 4053098120 false)]"
  run_cmd_status
  assert_contains "$CMD_OUT" "the next move is yours" "an idle head is reported as idle"
  assert_eq "$(graphql_reads)" 1 "and its threads are walked once, for the count"
  approved_fixture
  THREADS_JSON="[$(review_thread 4053098120 false)]"
  run_cmd_status
  assert_contains "$CMD_OUT" "BUT 1 review thread(s) still UNRESOLVED" "an approval is gated"
  assert_eq "$(graphql_reads)" 1 "on the same one walk the count reads"
}

# --- the open threads counted by head (ludics-lite#587) ---------------------------------------
# lukstafi/ocannl-staging#1063 read the first head's findings only after pushing a second fix:
# nothing said which head the open threads were written on. `status` now prints, after the state
# line, the threads written on the head and those on earlier heads, the earlier ones named.
test_status_counts_open_threads_on_the_head_and_on_earlier_heads() {
  local old=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  reset_fixture
  HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  REVIEWS_JSON="[$(review 5 "$HEAD_SHA" "$PAST")]"
  THREADS_JSON="[$(review_thread 4095735684 false a.sh 'codex[bot]' "$HEAD_SHA"),$(review_thread 4053098120 false b.sh 'codex[bot]' "$old" "$HEAD_SHA"),$(review_thread 4053098001 true c.sh 'codex[bot]' "$old")]"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "the count never changes the exit"
  assert_contains "$CMD_OUT" "nothing in flight" "the state line is as before"
  assert_contains "$CMD_OUT" "review threads: 1 open on head aaaaaaa, 1 on earlier heads (1 of them on lines head aaaaaaa still has): 4053098120 by codex[bot] on b.sh — answer and resolve these before pushing past them" \
    "the current head's open thread and the earlier head's are counted apart, the earlier one named"
  assert_not_contains "$CMD_OUT" 4053098001 "a resolved thread is not counted"
  assert_eq "$(sed -n 2p <<<"$CMD_OUT" | cut -c1-15)" "review threads:" "on the line after the state"
  # The same open threads under an approval: the gate's line and the count, from one walk.
  REACTIONS_JSON="[$(reaction +1 "$PAST")]"
  REVIEWS_JSON='[]'
  : >"$REQUEST_LOG"
  run_cmd_status
  assert_contains "$CMD_OUT" "BUT 2 review thread(s) still UNRESOLVED" "the gate names both"
  assert_contains "$CMD_OUT" "review threads: 1 open on head aaaaaaa, 1 on earlier heads" "and the count splits them"
  assert_eq "$(graphql_reads)" 1 "one walk for both"
  FAIL_GRAPHQL=1
  REACTIONS_JSON='[]'
  REVIEWS_JSON="[$(review 5 "$HEAD_SHA" "$PAST")]"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "an unread count is not an unread state"
  assert_contains "$CMD_OUT" "review threads: UNREAD — GraphQL did not answer" "and it is never 'none open'"
}

test_an_unread_thread_connection_is_unknown_not_approved() {
  approved_fixture
  FAIL_GRAPHQL=1
  run_cmd_status
  assert_eq "$CMD_RC" 3 "a thread read that did not answer is exit 3"
  assert_contains "$CMD_OUT" "UNKNOWN — GraphQL did not answer the review-threads read" \
    "and says it is transport, not an approval"
  assert_not_contains "$CMD_OUT" "approved (" "the approval is withheld, never granted on a failed read"
}

test_the_thread_read_pages_to_the_end() {
  approved_fixture
  THREADS_FIXTURE_PAGE=2
  THREADS_JSON="[$(review_thread 1 true),$(review_thread 2 true),$(review_thread 3 true),$(review_thread 4 true),$(review_thread 5 false)]"
  run_cmd_status
  assert_contains "$CMD_OUT" "BUT 1 review thread(s) still UNRESOLVED — NOT a clean approval, and \`merge\` refuses it: 5 by" \
    "an open thread on the third page is found"
  assert_eq "$(graphql_reads)" 3 "one read per page, and no more"
}

test_a_count_that_leads_the_rows_is_unread() {
  # #293's lesson: a connection that states more threads than it served is a partial read, and
  # the missing ones are exactly where an open thread could be.
  approved_fixture
  THREADS_FIXTURE_TOTAL=9
  THREADS_JSON="[$(review_thread 1 true),$(review_thread 2 true),$(review_thread 3 true)]"
  run_cmd_status
  assert_eq "$CMD_RC" 3 "a partial read is unread"
  assert_contains "$CMD_OUT" "ended at 3 thread(s) while the PR states 9" "and says how it was short"
}

test_a_read_still_paging_at_the_cap_is_unread() {
  approved_fixture
  retune THREADS_PAGE_CAP=2
  THREADS_FIXTURE_PAGE=2
  THREADS_JSON="[$(review_thread 1 true),$(review_thread 2 true),$(review_thread 3 true),$(review_thread 4 true),$(review_thread 5 true)]"
  run_cmd_status
  assert_eq "$CMD_RC" 3 "a prefix is not the connection"
  assert_contains "$CMD_OUT" "still paging after 2 pages of 100" "the cap refuses rather than judging a prefix"
  assert_eq "$(graphql_reads)" 2 "and stops at the cap"
}

test_a_thread_with_no_resolution_field_is_open() {
  approved_fixture
  THREADS_JSON="[$(review_thread 77 false | jq -c 'del(.isResolved)')]"
  run_cmd_status
  assert_contains "$CMD_OUT" "BUT 1 review thread(s) still UNRESOLVED" \
    "only an isResolved of true closes a thread"
}

test_a_thread_path_is_shell_quoted() {
  approved_fixture
  THREADS_JSON="[$(review_thread 77 false 'dir/a b;c.sh')]"
  run_cmd_status
  assert_contains "$CMD_OUT" "77 by codex[bot] on $(printf '%q' 'dir/a b;c.sh')" \
    "a repository-controlled path is quoted in the line"
}

test_a_broken_jq_program_is_unknown_on_the_thread_read() {
  approved_fixture
  THREADS_JSON="[$(review_thread 77 false)]"
  run_cmd_status
  assert_contains "$CMD_OUT" "BUT 1 review thread(s) still UNRESOLVED" "control: this fixture reads the threads"
  # A thread node that is not an object, inside a connection that is whole.
  THREADS_JSON='["not a thread"]'
  run_cmd_status
  assert_eq "$CMD_RC" 3 "open threads that did not parse are not 'none are open'"
  assert_contains "$CMD_OUT" "threads that did not parse" "the site says so"
}

test_a_thread_is_named_by_its_full_width_id() {
  # databaseId is a 32-bit Int in the schema and review comment ids already run past 2^31, so the
  # BigInt string is the id the line names, and databaseId is only its fallback (review of #370).
  # The first row is past 2^31, so review_thread serves its databaseId null, as GitHub does; the
  # second drops fullDatabaseId, and so stays below 2^31, where databaseId still carries the id.
  approved_fixture
  THREADS_JSON="[$(review_thread 4095735704 false),$(review_thread 2095735696 false | jq -c 'del(.comments.nodes[0].fullDatabaseId)')]"
  run_cmd_status
  assert_contains "$CMD_OUT" "4095735704 by codex[bot] on a.sh, 2095735696 by codex[bot] on a.sh" \
    "the full-width id first, and the Int one where it is all the row carries"
}

test_resolve_reaches_every_thread_the_gate_can_name() {
  # The gate pages to THREADS_PAGE_CAP; `resolve` looks threads up with find_thread, which used to
  # stop at twenty pages. A thread the gate names past that, with no flag to bypass the gate, could
  # then never be cleared (review of #370, round 1): both reads now share the cap.
  approved_fixture
  THREADS_FIXTURE_PAGE=1
  local i nodes=""
  for i in $(seq 1 25); do nodes="$nodes,$(review_thread "$((9000 + i))" true)"; done
  THREADS_JSON="[${nodes#,}]"
  local rc=0
  # `resolve` itself, not its internal lookup, so the case holds for the Python port of resolve
  # (ludics-lite#403). The thread is resolved, so the answer costs no mutation.
  (cmd_resolve 7 9025) >"$TEST_ROOT/resolve.out" 2>&1 || rc=$?
  assert_eq "$rc" 0 "a thread on page 25 is found by resolve ($(cat "$TEST_ROOT/resolve.out"))"
  assert_eq "$(cat "$TEST_ROOT/resolve.out")" "true (already resolved)" "and answered as the thread it is"
}

# --- a 👍 from before the head arrived (ludics-lite#418) --------------------------------------
# PR #411: the 👍 at 09:49 on the previous head, a push, and `watch` returning `approved` at once for
# a head nobody had reviewed, until the app's 👀 for it took the 👍 down four minutes later. A 👍
# older than the head's arrival is that head's `expected`, and the ordinary grace and nudge apply.

# The reviewer's summary comment as the app writes it, one Code Review row naming a commit.
summary_row() { # <id> <status> <short sha> <datetime>
  plain_comment "$1" "$4" "<!-- codex-pull-request-review-summary -->
| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
| 📝 **Code Review** | ✅ **$2** <relative-time datetime=\"${4%Z}.510504Z\">$4</relative-time> | \`$3\` | New commits |"
}

# How many times this case read <endpoint>, which is logged without its host.
endpoint_reads() { # <endpoint below repos/$REPO/>
  grep -c -x -F "repos/$REPO/$1" "$REQUEST_LOG" || true
}

test_a_thumbs_up_the_summary_gives_another_head_is_not_an_approval() {
  reset_fixture
  HEAD_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  # Committed BEFORE the 👍 and pushed after it (#415's head sat nine minutes between the two), so
  # the commit's date cannot tell; the row, which still names the previous head, does.
  HEAD_AT=2026-09-01T00:05:00Z
  REACTIONS_JSON="[$(reaction +1 2026-09-01T00:10:03Z)]"
  COMMENTS_JSON="[$(summary_row 1 Completed aaaaaaa 2026-09-01T00:10:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a 👍 the summary gives another head does not approve this one"
  assert_contains "$LINE" "review EXPECTED but not started" "the round for this head is due"
  assert_contains "$(state_detail "$STATE")" "the 👍 at 2026-09-01T00:10:03Z is for aaaaaaa, per" \
    "the line says whose 👍 it is"
  # The fall-through repeats none of the reads the 👍 path made; the commit read is the expected
  # clock's own.
  assert_eq "$(endpoint_reads "issues/7/comments?per_page=100")" 1 "one comments read"
  assert_eq "$(endpoint_reads "pulls/7/reviews?per_page=100")" 1 "one reviews read"
  assert_eq "$(endpoint_reads pulls/7)" 1 "one PR read"
  assert_eq "$(endpoint_reads "commits/$HEAD_SHA")" 1 "one commit read"
  # The control: the row naming this head is its approval, and costs no commit read.
  COMMENTS_JSON="[$(summary_row 1 Completed bbbbbbb 2026-09-01T00:10:00Z)]"
  : >"$REQUEST_LOG"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a 👍 the summary gives this head approves it"
  assert_eq "$(endpoint_reads "commits/$HEAD_SHA")" 0 "the row decided, so the clock is not read"
}

test_a_thumbs_up_older_than_the_head_commit_is_not_an_approval() {
  reset_fixture
  # No summary row to read, so the head commit's date decides: #411's timeline, the 👍 at 09:49
  # and the head committed at 10:02.
  REACTIONS_JSON="[$(reaction +1 2026-09-01T09:49:00Z)]"
  HEAD_AT=2026-09-01T10:02:11Z
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a 👍 older than the head's commit does not approve it"
  assert_contains "$(state_detail "$STATE")" "predates head head-sh's commit date 2026-09-01T10:02:11Z" \
    "the line says why the 👍 was not taken"
  assert_eq "$(endpoint_reads commits/head-sha)" 1 "the commit is read once, for both uses"
  # The control: a 👍 newer than the head's commit is its approval.
  HEAD_AT=2026-09-01T09:40:00Z
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a 👍 newer than the head's commit approves it"
}

# Review of #420, round 1: a commit date in the future proves nothing (the review clock refuses it
# too), and a newest summary the stamp cannot read hands the decision to the clock rather than to
# an older summary's row.
test_a_thumbs_up_is_judged_only_on_evidence_that_can_prove_it_stale() {
  reset_fixture
  REACTIONS_JSON="[$(reaction +1 "$(clock_at -60)")]"
  HEAD_AT=$(clock_at 3600)
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a commit dated in the future cannot prove a 👍 stale"
  # The older summary's row names another head; the newest summary's row is one the stamp cannot
  # read. The 👍 is newer than the head's commit, so the clock approves.
  HEAD_AT=2026-09-01T00:05:00Z
  REACTIONS_JSON="[$(reaction +1 2026-09-01T00:10:03Z)]"
  COMMENTS_JSON="[$(summary_row 1 Completed aaaaaaa 2026-09-01T00:01:00Z),$(plain_comment 2 2026-09-01T00:10:00Z '<!-- codex-pull-request-review-summary -->
| 📝 **Code Review** | ✅ **Completed** just now | `head-sh` | New commits |')]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "an unreadable newest summary hands the 👍 to the clock, not to an older row"
  # The same unreadable summary over a 👍 older than the head's commit: the clock still decides.
  HEAD_AT=2026-09-01T00:20:00Z
  run_status
  assert_eq "$(state_tok "$STATE")" expected "and the clock demotes a 👍 older than the head's commit"
}

test_a_stale_thumbs_up_leaves_the_ordinary_states() {
  reset_fixture
  REACTIONS_JSON="[$(reaction eyes 2026-09-01T09:40:00Z),$(reaction +1 2026-09-01T09:49:00Z)]"
  HEAD_AT=2026-09-01T10:02:11Z
  run_status
  # The 👀 of the round that ended in the 👍 is spent by it, not a round in flight.
  assert_eq "$(state_tok "$STATE")" expected "the 👀 under a stale 👍 is that round's, and spent"
  # The new head's 👀 lands before the app takes the old 👍 down: that round is in flight. Dated
  # from now, so the 👀 is young enough to be `reviewing` rather than `stalled`.
  HEAD_AT=$(clock_at -120)
  REACTIONS_JSON="[$(reaction +1 "$(clock_at -600)"),$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a 👀 newer than the stale 👍 is the new head's round"
  HEAD_AT=2026-09-01T10:02:11Z
  # And `watch` does not end its wait on it. The head is due, so the watch nudges it: a stale 👍
  # is no approval of this head for the request to clear, and the state the watch re-reads right
  # before it posts (the read that keeps a nudge off a real 👍) has to judge it stale too. (The PR
  # read answers an open, non-draft PR, so the write gate lets the post through. The test clock
  # makes the pickup window take no wall time, and test-pr-review-watch.sh pins the nudge's own
  # machinery.)
  REACTIONS_JSON="[$(reaction +1 2026-09-01T09:49:00Z)]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT$WATCH_ERR" "approved" "watch does not read the stale 👍 as an approval"
  assert_contains "$WATCH_OUT$WATCH_ERR" "review EXPECTED but not started" "it reads the due round"
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "the due head is nudged once: a stale 👍 is no approval of it to clear"
  assert_contains "$WATCH_ERR" "posted '@codex review' on head head-sh" "the watch says it posted the nudge"
}

# --- a round the summary marks Completed with no 👍 (ludics-lite#439) ---------------------------
# ocannl-staging#828, 2026-09-27: a findings review on the previous head b67e463 at 01:03:11Z, the
# push of fc6ff6a, the 👀 for it at 01:06:53Z, and the summary's Code Review row flipped to
# "✅ Completed" on fc6ff6a at 01:10:51Z. No review, no 👍, the 👀 left up — and `status` read
# STALLED 56 minutes later and recommended the nudge that clears approvals.
COMPLETED_HEAD=fc6ff6ae371000202d46683c50e62cdc1f125357

completed_fixture() {
  reset_fixture
  HEAD_SHA="$COMPLETED_HEAD"
  HEAD_AT=2026-09-27T01:06:05Z
  REVIEWS_JSON="[$(review 5 b67e463000000000000000000000000000000000 2026-09-27T01:03:11Z)]"
  REACTIONS_JSON="[$(reaction eyes 2026-09-27T01:06:53Z)]"
  COMMENTS_JSON="[$(summary_row 1 Completed fc6ff6a 2026-09-27T01:10:51Z)]"
}

# The summary as it stands while that round runs: the same row, Running.
running_row() { # <id> <short sha> <datetime>
  plain_comment "$1" "$3" "<!-- codex-pull-request-review-summary -->
| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
| 📝 **Code Review** | 🔄 **Running** <relative-time datetime=\"${3%Z}.484070Z\">$3</relative-time> | \`$2\` | New commits |"
}

test_a_completed_row_on_the_head_is_a_verdict() {
  completed_fixture
  COMMENTS_JSON="[$(running_row 1 fc6ff6a 2026-09-27T01:07:02Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "control: the same round while its row reads Running"
  completed_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a round the summary marks Completed on the head, silent since its 👀"
  assert_contains "$LINE" "summary marks head fc6ff6a's Code Review Completed at 2026-09-27T01:10:51Z" \
    "the approval names the row it rests on"
  assert_contains "$LINE" "since its 👀 at 2026-09-27T01:06:53Z (no 👍 was given)" \
    "and the 👀 that bounds the round"
  # The comments are read BEFORE the reviews, so a findings review the app submits seconds before
  # it flips the row is in the reviews read whenever the flipped row is in the comments read.
  assert_eq "$(grep -F -x -e "repos/$REPO/issues/7/comments?per_page=100" \
    -e "repos/$REPO/pulls/7/reviews?per_page=100" "$REQUEST_LOG" | head -1)" \
    "repos/$REPO/issues/7/comments?per_page=100" "the comments are read before the reviews"
  assert_eq "$(endpoint_reads "issues/7/comments?per_page=100")" 1 "one comments read"
  assert_eq "$(endpoint_reads "pulls/7/reviews?per_page=100")" 1 "one reviews read"
  # A `watch` ends its wait on it, where it used to sit out the 👀 until the stall.
  run_watch 0,0,0
  assert_contains "$WATCH_OUT$WATCH_ERR" "approved" "watch ends on the Completed round"
}

test_a_completed_row_for_another_head_is_not_this_head_s_verdict() {
  completed_fixture
  COMMENTS_JSON="[$(summary_row 1 Completed b67e463 2026-09-27T01:10:51Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a Completed row naming an older head approves nothing here"
}

test_a_completed_row_after_a_findings_review_is_not_clean() {
  completed_fixture
  # #427's order: the findings review three seconds before the row flips.
  REVIEWS_JSON="[$(review 6 "$COMPLETED_HEAD" 2026-09-27T01:10:48Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a round that posted findings before its row flipped is not clean"
  # Or after it: anything the reviewer says inside the round disqualifies the row.
  REVIEWS_JSON="[$(review 6 "$COMPLETED_HEAD" 2026-09-27T01:11:30Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "nor one that posted findings after it"
  # An empty COMMENTED envelope is not a finding (#88), and leaves the verdict standing.
  REVIEWS_JSON="[$(review 6 "$COMPLETED_HEAD" 2026-09-27T01:10:48Z | jq -c '.body=""')]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "an empty envelope inside the round is not a finding"
}

test_a_completed_row_needs_a_round_to_bound_it() {
  completed_fixture
  # A re-request on the same head: its fresh 👀 over a row that is still the last round's.
  REACTIONS_JSON="[$(reaction eyes 2026-09-27T01:20:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a row older than the 👀 is the previous round's"
  # No 👀 at all: no round to bound, so the reading is what it was before the row was read.
  REACTIONS_JSON='[]'
  run_status
  assert_eq "$(state_tok "$STATE")" expected "with no 👀 the row is not read as a verdict"
  # A 👀 older than a pending request inside a watch is spent, and so is the row under it.
  completed_fixture
  COMMENTS_JSON="[$(summary_row 1 Completed fc6ff6a 2026-09-27T01:10:51Z),$(jq -cn \
    '{id:2, user:{login:"me"}, created_at:"2026-09-27T01:30:00Z", updated_at:"2026-09-27T01:30:00Z",
      body:"@codex review"}')]"
  local watch_nudge_after=1
  run_status
  assert_eq "$(state_tok "$STATE")" nudged "a Completed row from before a pending request does not answer it"
}

test_a_completed_row_outside_the_allowlist_is_not_a_verdict() {
  completed_fixture
  # The stamp dates it; the allowlist refuses the status cell.
  COMMENTS_JSON="[$(summary_row 1 'Completed with errors' fc6ff6a 2026-09-27T01:10:51Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a reworded Completed cell is not a verdict"
  # A Completed row that is not the newest Code Review row of the summary.
  COMMENTS_JSON="[$(plain_comment 1 2026-09-27T01:12:00Z "<!-- codex-pull-request-review-summary -->
| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-09-27T01:10:51.1Z\">x</relative-time> | \`fc6ff6a\` | New commits |
| 📝 **Code Review** | 🔄 **Running** <relative-time datetime=\"2026-09-27T01:11:40.1Z\">x</relative-time> | \`fc6ff6a\` | Comment |")]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a Completed row under a newer Running row is not the round's end"
  # A Code Review row the stamp cannot date beside it: no row can be called the newest.
  COMMENTS_JSON="[$(plain_comment 1 2026-09-27T01:12:00Z "<!-- codex-pull-request-review-summary -->
| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-09-27T01:10:51.1Z\">x</relative-time> | \`fc6ff6a\` | New commits |
| 📝 **Code Review** | 🔄 **Running** just now | \`fc6ff6a\` | Comment |")]"
  run_status
  assert_eq "$(state_tok "$STATE")" unknown \
    "an undatable row beside it leaves no newest row, and an undatable Running row may be the round (#586)"
  # Only the NEWEST summary comment is read: an older one's Completed row is history.
  COMMENTS_JSON="[$(summary_row 1 Completed fc6ff6a 2026-09-27T01:10:51Z),$(running_row 2 fc6ff6a 2026-09-27T01:11:40Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "an older summary's Completed row is not read past the newest one"
}

test_a_completed_row_approval_passes_the_thread_gate() {
  completed_fixture
  THREADS_JSON="[$(review_thread 4053098120 false)]"
  run_cmd_status
  assert_contains "$CMD_OUT" "BUT 1 review thread(s) still UNRESOLVED" \
    "an open thread under the Completed row's approval is unresolved, as under a 👍"
}

# --- a clean round the app records only in its hidden state (ludics-lite#702) -----------------
# lukstafi/ludics-lite#690, 2026-10-18: findings reviews on a448221 and f6121fb, the push of
# 66de063, and the summary comment rewritten at 16:27:30Z with its hidden record for that head:
# completed, no unresolved findings. No review, no 👍, and no 👀 left up -- `status` read EXPECTED
# and `watch` advised the nudge that clears approvals. The record and the row are that comment's,
# verbatim; has_any_findings stays true from the earlier heads.
STATE_HEAD=66de0633a9d67f2b922c8d2a22727515720a4498
STATE_RECORD='{"code_review":{"commit_sha":"66de0633a9d67f2b922c8d2a22727515720a4498","has_any_findings":true,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}}'

# STATE_RECORD with one code_review field set to a JSON value, as a record that still parses: a
# variant that did not would pass every "is not a verdict" case below as no reading at all.
state_record_with() { # <field> <json value>
  jq -c --arg f "$1" --argjson v "$2" '.code_review[$f] = $v' <<<"$STATE_RECORD"
}

state_summary() { # <id> <updated_at> <record>
  jq -cn --argjson id "$1" --arg at "$2" --arg rec "$3" --arg rev "$REVIEWER" \
    '{id:$id, user:{login:($rev + "[bot]")}, created_at:"2026-10-18T15:55:45Z", updated_at:$at,
      body:("<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 " + $rec
        + " -->\n\n## Codex Review Summary\n\nThis comment shows the latest Codex review activity on this pull request.\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-10-18T16:27:29.001490Z\">2026-10-18T16:27:29.001490Z</relative-time> | `66de063` | New commits |\n\n\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n</details>")}'
}

state_fixture() {
  reset_fixture
  HEAD_SHA="$STATE_HEAD"
  HEAD_AT=2026-10-18T16:23:00Z
  REVIEWS_JSON="[$(review 5 a4482215c1b71473b5417e05bc38f15c3f05efb9 2026-10-18T16:01:59Z),$(
    review 6 f6121fbc3e97a504a041502e934df817a09b88db 2026-10-18T16:17:01Z)]"
  COMMENTS_JSON="[$(state_summary 1 2026-10-18T16:27:30Z "$STATE_RECORD")]"
}

test_a_clean_state_record_on_the_head_is_a_verdict() {
  state_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" approved "the record of a clean round on the head, with no 👍 and no 👀"
  assert_contains "$LINE" "summary records head 66de063's Code Review completed with no unresolved findings, Completed at 2026-10-18T16:27:29Z" \
    "the approval names the record it rests on"
  # The same comment's record for another head, or with findings open, is no verdict here.
  COMMENTS_JSON="[$(state_summary 1 2026-10-18T16:27:30Z \
    "$(state_record_with commit_sha '"f6121fbc3e97a504a041502e934df817a09b88db"')")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a record naming another head approves nothing here"
  COMMENTS_JSON="[$(state_summary 1 2026-10-18T16:27:30Z "$(state_record_with has_unresolved_findings true)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a record with unresolved findings is not clean"
  COMMENTS_JSON="[$(state_summary 1 2026-10-18T16:27:30Z "$(state_record_with status '"running"')")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a running record is no verdict"
  # A record that does not parse whole is no reading, never a field fished out of it.
  COMMENTS_JSON="[$(state_summary 1 2026-10-18T16:27:30Z "${STATE_RECORD:0:${#STATE_RECORD}-1}")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a truncated record is no reading"
  # And `watch` ends its wait on it, with no nudge and no advice to post one.
  state_fixture
  run_watch 0,0,0
  assert_contains "$WATCH_OUT$WATCH_ERR" "approved (" "watch ends on the clean record"
  assert_not_contains "$WATCH_OUT$WATCH_ERR" "consider nudging" "and advises no nudge"
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "and posts none"
}

test_a_state_record_yields_to_what_the_reviewer_posted() {
  state_fixture
  # #683's order: a findings review of the head three seconds before the record is written.
  REVIEWS_JSON="[$(review 7 "$STATE_HEAD" 2026-10-18T16:27:27Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a round that posted findings on the head is not clean"
  # A word after the record, whatever its head, is newer than the record.
  state_fixture
  REVIEWS_JSON="[$(review 7 f6121fbc3e97a504a041502e934df817a09b88db 2026-10-18T16:28:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a review posted after the record outranks it"
  # A 👀 newer than the record is a new round, read as a round.
  state_fixture
  REACTIONS_JSON="[$(reaction eyes 2026-10-18T16:30:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a 👀 newer than the record is not answered by it"
  # Nor once an edit of the summary (its security-review row) moves the comment's updated_at past
  # that 👀: the Code Review row dates the record, and it still predates the 👀.
  COMMENTS_JSON="[$(state_summary 1 2026-10-18T16:31:00Z "$STATE_RECORD")]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a summary edited after the 👀 is not a newer verdict"
}

# --- a stale 👀 under the head's Running row (ludics-lite#586) -----------------------------------
# lukstafi/ludics-lite#581, 2026-10-12: the round on head 4960114 hung with its 👀 up for over 40
# minutes; the worker merged main, moving the head to fb80745, and the summary's Code Review row
# read "🔄 Running since 16:46:01" on fb80745. `status` and `watch` read STALLED from the old 👀,
# and the watch exited; fb80745's review landed, with a 👍, three minutes later. Dated on the
# fixture clock: the 👀 past STALL (1800 s), the row a minute old.
STALE_EYES_HEAD=fb80745000000000000000000000000000000000

stale_eyes_fixture() {
  reset_fixture
  HEAD_SHA="$STALE_EYES_HEAD"
  HEAD_AT=$(clock_at -300)
  REVIEWS_JSON="[$(review 5 4960114000000000000000000000000000000000 "$(clock_at -6000)")]"
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -3000)")]"
  COMMENTS_JSON="[$(running_row 1 fb80745 "$(clock_at -60)")]"
}

test_a_stale_eyes_under_the_head_s_running_row_is_reviewing() {
  stale_eyes_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "the head's Running row after an old 👀 is the round in flight"
  assert_contains "$(state_detail "$STATE")" "Code Review Running for head fb80745 since" \
    "the state names the row it rests on"
  # And `watch` waits it out: no stall verdict, no exit before its window.
  run_watch 0,0,0 1 3
  assert_not_contains "$WATCH_OUT$WATCH_ERR" "STALLED" "watch does not read the old 👀 as a stall"
  assert_contains "$WATCH_ERR" "Code Review Running for head fb80745 since" "it reads the row's round"
  # The row ages into a stall of its own: a hung round on THIS head is still a stall.
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -6000)")]"
  COMMENTS_JSON="[$(running_row 1 fb80745 "$(clock_at -3000)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a Running row past STALL is a stall, dated by the row"
  assert_contains "$(state_detail "$STATE")" "Code Review Running for head fb80745 since" \
    "and the stall names the row"
}

test_a_stale_eyes_still_decides_without_the_head_s_newer_running_row() {
  # The row names the OLD head: the reactions decide, as before the row was read.
  stale_eyes_fixture
  COMMENTS_JSON="[$(running_row 1 4960114 "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a Running row for an older head does not answer this head's 👀"
  assert_contains "$(state_detail "$STATE")" "with nothing posted since" "the 👀 decides"
  # A 👀 newer than the row: that 👀 is the newer round, and the reactions decide either way.
  stale_eyes_fixture
  COMMENTS_JSON="[$(running_row 1 fb80745 "$(clock_at -4000)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" stalled "a row older than the 👀 does not rescue a stalled 👀"
  assert_contains "$(state_detail "$STATE")" "with nothing posted since" "the 👀 decides"
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "and a live 👀 over an old row reads by the 👀"
  assert_contains "$(state_detail "$STATE")" "👀 from" "the 👀 decides"
  # The same Running row with no stamp to read: the round may be this head's, so no verdict.
  stale_eyes_fixture
  COMMENTS_JSON="[$(plain_comment 1 "$(clock_at -60)" '<!-- codex-pull-request-review-summary -->
| 📝 **Code Review** | 🔄 **Running** just now | `fb80745` | New commits |')]"
  run_status
  assert_eq "$(state_tok "$STATE")" unknown "an unreadable Running row is no stall"
  assert_contains "$(state_detail "$STATE")" "matched the Running test but not the" "and says why"
}

# Review of #747, round 1: findings on the head spend the old 👀, then a rerun on the same head puts
# the row back to Running. That is the round in flight, not `idle` on the findings it follows.
test_a_same_head_rerun_after_findings_is_reviewing() {
  stale_eyes_fixture
  REVIEWS_JSON="[$(review 6 "$STALE_EYES_HEAD" "$(clock_at -600)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "the head's Running row after its findings is the rerun"
  REACTIONS_JSON='[]'
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "with no 👀 at all, too"
  # Control: the row older than the findings is the round that posted them.
  COMMENTS_JSON="[$(running_row 1 fb80745 "$(clock_at -900)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a row older than the reviewer's last word is that round's"
  # Review of #747, round 2: the same rerun after a no-findings verdict on the head. The verdict is
  # the reviewer's last word, and a Running row newer than it outranks it, as one outranks a 👍.
  stale_eyes_fixture
  COMMENTS_JSON="[$(verdict_comment 2 fb80745 "$(clock_at -600)"),$(running_row 1 fb80745 "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "the head's Running row after its verdict is the rerun"
  COMMENTS_JSON="[$(verdict_comment 2 fb80745 "$(clock_at -600)"),$(running_row 1 fb80745 "$(clock_at -900)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a row older than the verdict is the round that gave it"
}

# --- a reviewer run the summary marks Failed (ludics-lite#453) ----------------------------------
# lukstafi/ocannl-staging#633, 2026-09-04: the last findings review on 8c090d3 at 22:24:34Z, head
# 1e14b13 committed at 22:46:29Z, and the summary's Code Review row "⚠️ Failed" on it at
# 22:47:25Z — no review of it, no 👍, no 👀 left up. The row below is that comment's, verbatim.
FAILED_RUN_HEAD=1e14b1368a51d19726b17bb6d2a6e557680d0b4b
FAILED_RUN_ROW='| 📝 **Code Review** | ⚠️ **Failed** <relative-time datetime="2026-09-04T22:47:25.387018Z">2026-09-04T22:47:25.387018Z</relative-time> | `1e14b13` | New commits |'

failed_run_summary() { # <id> <row>
  plain_comment "$1" 2026-09-04T22:47:26Z "<!-- codex-pull-request-review-summary -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
$2"
}

failed_run_fixture() {
  reset_fixture
  HEAD_SHA="$FAILED_RUN_HEAD"
  HEAD_AT=2026-09-04T22:46:29Z
  REVIEWS_JSON="[$(review 5 8c090d3000000000000000000000000000000000 2026-09-04T22:24:34Z)]"
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW")]"
}

# A request comment from the caller, as `comment` posts one.
request_comment() { # <id> <created_at>
  jq -cn --argjson id "$1" --arg at "$2" \
    '{id:$id, user:{login:"me"}, created_at:$at, updated_at:$at,
      body:"@codex review\n\n_🤖 Addressed by an automated coding agent_"}'
}

test_a_failed_run_on_the_head_is_a_failed_state() {
  failed_run_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" failed "a run the summary marks Failed on the head is not a round that is due"
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run "and nobody has re-requested it on this head"
  assert_contains "$LINE" "reviewer's run FAILED on head 1e14b13 — no review and no 👍" \
    "the line names the state, the head, and why a re-request is safe"
  assert_contains "$LINE" "\`watch\` posts it itself, once per head" "and who makes it"
  assert_contains "$LINE" "Failed at 2026-09-04T22:47:25Z" "the row it rests on"
  assert_not_contains "$LINE" "review EXPECTED" "the reading #633 had before"
  run_cmd_status
  assert_eq "$CMD_RC" 0 "a state that was READ is exit 0"
  assert_contains "$CMD_OUT" "review rounds with findings: 1 of 12" "the failed run is not a round"
  # ludics-lite#462's row, 2026-09-29, read back from the summary's edit history (the app has since
  # rewritten it): the same shape, on a PR's opening round.
  COMMENTS_JSON="[$(failed_run_summary 1 '| 📝 **Code Review** | ⚠️ **Failed** <relative-time datetime="2026-09-29T17:40:02.163602Z">2026-09-29T17:40:02.163602Z</relative-time> | `1e14b13` | PR opened |')]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run "#462's row reads as the same failed run"
  failed_run_fixture
  # A 👀 left up under the row, with nothing said since it, is the same failed run.
  REACTIONS_JSON="[$(reaction eyes 2026-09-04T22:46:40Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed "a 👀 older than the row, silent since, bounds the same run"
}

# Each control keeps the reading status gave before the row was read.
test_a_failed_run_needs_the_head_and_no_approval() {
  failed_run_fixture
  COMMENTS_JSON="[$(failed_run_summary 1 "${FAILED_RUN_ROW//1e14b13/8c090d3}")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a Failed row naming another head is not this head's run"
  failed_run_fixture
  REACTIONS_JSON="[$(reaction +1 2026-09-04T22:30:00Z)]"
  run_status
  assert_not_contains "$(state_tok "$STATE")" failed "with a 👍 on the PR the re-request could clear it"
  # And a 👍 a pending request has superseded is still a 👍 on the PR.
  local watch_nudge_after=1
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(request_comment 2 2026-09-04T22:40:00Z)]"
  run_status
  assert_not_contains "$(state_tok "$STATE")" failed "nor a 👍 older than a pending request"
}

test_a_failed_run_needs_a_silent_reviewer() {
  failed_run_fixture
  REVIEWS_JSON="[$(review 6 "$FAILED_RUN_HEAD" 2026-09-04T22:47:22Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a review of the head, with no 👀 to bound the run, is not a silent run"
  # With a 👀 up: a review inside the run, before the row flips as a findings round's does.
  REACTIONS_JSON="[$(reaction eyes 2026-09-04T22:46:40Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a review between the 👀 and the row is the reviewer speaking"
  # A 👀 newer than the row is a round started after the failure.
  failed_run_fixture
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a 👀 above the row is a round to wait out"
  # A reviewer comment after the row is its newer word.
  failed_run_fixture
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(failure_comment 2 "$FAILED_RUN_HEAD" 2026-09-04T22:50:00Z)]"
  run_status
  assert_contains "$LINE" "reviewer FAILED at initialization" "the newer word is the one read"
}

test_a_failed_run_counts_the_requests_on_its_head() {
  failed_run_fixture
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(request_comment 2 2026-09-04T22:47:00Z)]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run-again "a failure answering a request on this head"
  assert_contains "$LINE" "reviewer's run FAILED AGAIN on head 1e14b13" "is surfaced, not re-requested"
  assert_contains "$LINE" "request at 2026-09-04T22:47:00Z" "naming the request it answers"
  # A request in the head commit's own second counts as on it: the clock cannot say otherwise.
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(request_comment 2 "$HEAD_AT")]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run-again "a request at the arrival's own second"
  # A request from before the head's commit was about an earlier head.
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(request_comment 2 2026-09-04T22:40:00Z)]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run "a request before the head arrived is not on it"
  # With no readable arrival, every request counts: the clock can only suppress a re-request.
  HEAD_AT=""
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run-again "an unread commit date counts every request"
  HEAD_AT=2099-01-01T00:00:00Z
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run-again "and so does one in the future"
  # A request in the row's own second is after it (the row's stamp is cut to whole seconds, and
  # the comment's is served that way): pending, not the cause of a second failure.
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(request_comment 2 2026-09-04T22:47:25Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a request in the row's second is not read as answered by it"
  # A request after the row has answered it: the round it asked for is due.
  failed_run_fixture
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(request_comment 2 2026-09-04T22:50:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a failure already re-requested is not re-requested again"
  local watch_nudge_after=1
  run_status
  assert_eq "$(state_tok "$STATE")" nudged "and inside a watch it is that request's grace"
}

# ludics-lite#465, this reading's own PR, 2026-09-29: head d208deb committed 17:53:20Z, the
# connector's missing-environment answer at 18:08:06Z, a '@codex review' at 18:08:34Z, then a
# "Something went wrong" naming d208deb at 18:09:10Z and the row flipping to Failed ("Manual
# request") one second later. The comment posted with the row is the same failed run.
test_a_failed_run_posted_with_an_initialization_failure() {
  reset_fixture
  HEAD_SHA=d208debe08508c6ffe2c5c6f2a12466225832581
  HEAD_AT=2026-09-29T17:53:20Z
  local row='| 📝 **Code Review** | ⚠️ **Failed** <relative-time datetime="2026-09-29T18:09:11.056100Z">2026-09-29T18:09:11.056100Z</relative-time> | `d208deb` | Manual request |'
  COMMENTS_JSON="[$(plain_comment 1 2026-09-29T18:08:06Z "$ENV_FAILURE_BODY"),$(request_comment 2 2026-09-29T18:08:34Z),$(
    failed_run_summary 3 "$row"),$(failure_comment 4 "$HEAD_SHA" 2026-09-29T18:09:10Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed "the run failed"
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run-again "after the request made on this head"
  # The same row and comment on a head nobody re-requested: the run, to re-request.
  COMMENTS_JSON="[$(failed_run_summary 3 "$row"),$(failure_comment 4 "$HEAD_SHA" 2026-09-29T18:09:10Z)]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run "the comment posted with the row does not disqualify it"
  # A failure comment AFTER the row is the reviewer's newer word, and its own arm reads it.
  COMMENTS_JSON="[$(failed_run_summary 3 "$row"),$(failure_comment 4 "$HEAD_SHA" 2026-09-29T18:09:30Z)]"
  run_status
  assert_contains "$LINE" "reviewer FAILED at initialization" "a later comment is read by its own arm"
}

test_a_failed_row_outside_the_allowlist_is_not_read() {
  local row
  for row in "${FAILED_RUN_ROW/⚠️/⚠}" "${FAILED_RUN_ROW/⚠️/❌}" "${FAILED_RUN_ROW/Failed/Error}" \
    "${FAILED_RUN_ROW/\*\*Failed\*\*/Failed}"; do
    failed_run_fixture
    COMMENTS_JSON="[$(failed_run_summary 1 "$row")]"
    run_status
    assert_eq "$(state_tok "$STATE")" expected "a failure row outside the observed shape keeps the old reading: $row"
  done
  # Review of #465, round 3: the newest row is found by instant, not by string. A whole-second
  # Failed stamp sorts after a later fractional one in the same second as a string, and would be
  # taken for the newest over a Running row that superseded it.
  failed_run_fixture
  COMMENTS_JSON="[$(failed_run_summary 1 "${FAILED_RUN_ROW//2026-09-04T22:47:25.387018Z/2026-09-04T22:47:25Z}
| 📝 **Code Review** | 🔄 **Running** since <relative-time datetime=\"2026-09-04T22:47:25.5Z\">x</relative-time> | \`1e14b13\` | Manual request |")]"
  run_status
  # The newest row is the head's round, Running for weeks on the fixture clock: a stall (#586).
  assert_eq "$(state_tok "$STATE")" stalled "a Running row later in the same second is the newest, and no failure is read"
  # The shape with a datetime the comparisons cannot order: malformed, or in the future.
  for row in "${FAILED_RUN_ROW//2026-09-04T22:47:25.387018Z/garbage}" \
    "${FAILED_RUN_ROW//2026-09-04T22:47:25.387018Z/2099-01-01T00:00:00.1Z}"; do
    failed_run_fixture
    COMMENTS_JSON="[$(failed_run_summary 1 "$row")]"
    run_status
    assert_eq "$(state_tok "$STATE")" expected "a Failed row whose datetime cannot be ordered is not read: $row"
  done
}

test_a_broken_jq_program_is_unknown_on_the_request_read() {
  failed_run_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" failed "control: this fixture reaches the request read"
  # The request read is the one that reads OTHER authors' comment bodies: one that is not text.
  COMMENTS_JSON="[$(failed_run_summary 1 "$FAILED_RUN_ROW"),$(jq -cn \
    '{id:2, user:{login:"me"}, created_at:"2026-09-04T22:50:00Z", updated_at:"2026-09-04T22:50:00Z", body:7}')]"
  run_status
  assert_unknown_state "the review-request comments feed did not parse" "the request read"
}

test_watch_re_requests_a_failed_run_once() {
  # A grace short enough that the request's pickup window ends inside the case.
  retune GRACE=2
  failed_run_fixture
  run_watch 0,1,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "one re-request posted for the failed run"
  assert_eq "$(jq -r .body "$TEST_ROOT/posted")" "@codex review

_🤖 Addressed by an automated coding agent_" "the plain request the pending-nudge reader recognizes"
  assert_contains "$WATCH_ERR" "re-requested the review with '@codex review'" "the watch says it did"
  assert_contains "$WATCH_ERR" "fresh review nudge; waiting for pickup" "and then waits out the request's grace"
  assert_not_contains "$WATCH_OUT" "FAILED" "the failure it answered is not the verdict"
  # The same run failing again after that request: surfaced, not re-requested.
  mv "$TEST_ROOT/posted" "$TEST_ROOT/posted.keep"
  failed_run_fixture
  COMMENTS_JSON="[$(failed_run_summary 1 "${FAILED_RUN_ROW//2026-09-04T22:47:25.387018Z/2026-09-04T23:05:00.1Z}"),$(request_comment 2 2026-09-04T22:50:00Z)]"
  run_watch 0,2,0 1 3
  assert_eq "$WATCH_RC" 0 "a second failure is something to act on"
  assert_contains "$WATCH_OUT" "reviewer's run FAILED AGAIN on head 1e14b13" "the verdict is on stdout"
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "and nothing is posted"
  rm -f "$TEST_ROOT/posted.keep"
}

# lukstafi/ocannl-staging#1347 (ludics-lite#787), 2026-10-23: head ee97b22 committed 09:45:45Z,
# the PR opened 09:47:16Z, and its first round's summary row flipped to Completed at 09:52:39Z with
# an em dash for the commit and a null commit_sha in its record — no review, no 👍, no verdict. The
# worker posted the '@codex review' by hand at 09:59:02Z. Row and record are that comment's, read
# back from its edit history.
COMMITLESS_HEAD=ee97b22531d19e1537dcc0736d5812c783ab2ba9
COMMITLESS_ROW='| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-23T09:52:39.550684Z">2026-10-23T09:52:39.550684Z</relative-time> | — | PR opened |'
COMMITLESS_RECORD='{"code_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}}'

commitless_summary() { # <id> <row> [record]
  plain_comment "$1" 2026-10-23T09:52:40Z "<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 ${3:-$COMMITLESS_RECORD} -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
$2"
}

commitless_fixture() {
  reset_fixture
  HEAD_SHA="$COMMITLESS_HEAD"
  HEAD_AT=2026-10-23T09:45:45Z
  COMMENTS_JSON="[$(commitless_summary 1 "$COMMITLESS_ROW")]"
}

test_a_commitless_completed_row_is_a_failed_run() {
  commitless_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" failed "a round closed naming no commit, with nothing posted, is not a round that is due"
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run "and nobody has re-requested it on this head"
  assert_contains "$LINE" "reviewer's run FAILED on head ee97b22" "the line names the state and the head"
  assert_contains "$LINE" "Completed at 2026-10-23T09:52:39Z naming no commit" "and the row it rests on"
  assert_not_contains "$LINE" "review EXPECTED" "the reading staging#1347 had before"
  # The hand request the worker posted, before the row: the same run, answered by that request.
  COMMENTS_JSON="[$(commitless_summary 1 "$COMMITLESS_ROW"),$(request_comment 2 2026-10-23T09:50:00Z)]"
  run_status
  assert_eq "$(state_detail "$STATE" | cut -d'|' -f2)" run-again "a commit-less close answering a request on this head"
  # ...and after it: pending, so the round it asked for is due.
  COMMENTS_JSON="[$(commitless_summary 1 "$COMMITLESS_ROW"),$(request_comment 2 2026-10-23T09:59:02Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a commit-less close already re-requested is not re-requested again"
  # A 👀 older than the row, silent since, bounds the same run.
  commitless_fixture
  REACTIONS_JSON="[$(reaction eyes 2026-10-23T09:47:20Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" failed "a 👀 under the row is the round it closed"
}

# Each control keeps the reading status gave before the row was read.
test_a_commitless_completed_row_needs_the_head_and_a_silent_reviewer() {
  commitless_fixture
  HEAD_AT=2026-10-23T09:55:00Z
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a row older than the head's arrival is an earlier head's"
  HEAD_AT=""
  run_status
  assert_not_contains "$(state_tok "$STATE")" failed "an arrival that does not read binds the row to no head"
  # ...even with the PR's creation readable: a push long after it would inherit an earlier head's row.
  PR_CREATED_AT=2026-10-23T09:47:16Z
  run_status
  assert_not_contains "$(state_tok "$STATE")" failed "the PR's creation alone does not bind the row to the head"
  HEAD_AT=2026-10-23T09:45:45Z
  run_status
  assert_eq "$(state_tok "$STATE")" failed "with the commit date read, the creation is only a later floor"
  commitless_fixture
  REACTIONS_JSON="[$(reaction +1 2026-10-23T09:50:00Z)]"
  run_status
  assert_not_contains "$(state_tok "$STATE")" failed "with a 👍 on the PR the re-request could clear it"
  commitless_fixture
  REVIEWS_JSON="[$(review 6 "$COMMITLESS_HEAD" 2026-10-23T09:52:37Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a review of the head is the reviewer speaking"
  commitless_fixture
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a 👀 above the row is a round to wait out"
}

test_a_commitless_row_outside_the_allowlist_is_not_read() {
  local rec
  for rec in "$(jq -c '.code_review.commit_sha = "ee97b22531d19e1537dcc0736d5812c783ab2ba9"' <<<"$COMMITLESS_RECORD")" \
             "$(jq -c '.code_review.status = "running"' <<<"$COMMITLESS_RECORD")" \
             "$(jq -c 'del(.code_review.commit_sha)' <<<"$COMMITLESS_RECORD")"; do
    commitless_fixture
    COMMENTS_JSON="[$(commitless_summary 1 "$COMMITLESS_ROW" "$rec")]"
    run_status
    assert_eq "$(state_tok "$STATE")" expected "a record that does not say no commit leaves the row unread: $rec"
  done
  commitless_fixture
  COMMENTS_JSON="[$(commitless_summary 1 "${COMMITLESS_ROW//— |/- |}")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a commit cell other than the em dash is not the shape"
  # A newer row naming a commit is the newest row: the commit-less one is history.
  commitless_fixture
  COMMENTS_JSON="[$(commitless_summary 1 "$COMMITLESS_ROW
| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-10-23T09:53:00Z\">x</relative-time> | \`ee97b22\` | Manual request |")]"
  run_status
  assert_not_contains "$(state_tok "$STATE")" failed "an older commit-less row under a newer one is not read"
}

# lukstafi/ocannl-staging#1424 (ludics#815), 2026-10-26: one head, 5f3a033, committed 09:44:19Z;
# the PR opened 09:46:15Z; the worker asked '@codex review' at 10:21:23Z; at 10:24:02Z the reviewer
# posted a no-findings receipt naming no commit, and its summary row flipped to Completed at
# 10:24:03Z with an em dash for the commit and "Manual request" for the trigger. No 👀, no 👍.
# `status` read the ludics-lite#787 failed run AGAIN, and `watch` advised a pointless new head.
# Both bodies are the comments' own, read back from the API.
RECEIPT_HEAD=5f3a0330fbc04d081dd84ed2bee493b9eabcff59
RECEIPT_BODY=$(jq -r . <<'EOF'
"<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. :+1:\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\".\n\nIf Codex has suggestions, it will comment; otherwise it will react with 👍.\n\n\n\n\nCodex can also answer questions or update the PR. Try commenting \"@codex address that feedback\".\n            \n</details>"
EOF
)
RECEIPT_SUMMARY_BODY=$(jq -r . <<'EOF'
"<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {\"code_review\":{\"commit_sha\":null,\"has_any_findings\":null,\"has_unresolved_findings\":null,\"status\":\"completed\"},\"security_review\":{\"commit_sha\":null,\"has_any_findings\":null,\"has_unresolved_findings\":null,\"status\":null}} -->\n\n## Codex Review Summary\n\nThis comment shows the latest Codex review activity on this pull request.\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-10-26T10:24:03.723881Z\">2026-10-26T10:24:03.723881Z</relative-time> | — | Manual request |\n\n\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\" or \"@codex security review\".\n\nCodex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.\n\n</details>"
EOF
)

receipt_summary() { # [summary body]
  jq -cn --arg b "${1:-$RECEIPT_SUMMARY_BODY}" --arg rev "$REVIEWER" \
    '{id:6412989521, user:{login:($rev + "[bot]")}, created_at:"2026-10-26T09:46:29Z",
      updated_at:"2026-10-26T10:24:04Z", body:$b}'
}

receipt_fixture() { # [receipt body]
  reset_fixture
  HEAD_SHA="$RECEIPT_HEAD"
  HEAD_AT=2026-10-26T09:44:19Z
  PR_CREATED_AT=2026-10-26T09:46:15Z
  COMMENTS_JSON="[$(receipt_summary),$(request_comment 6413661149 2026-10-26T10:21:23Z),$(
    plain_comment 6413711632 2026-10-26T10:24:02Z "${1:-$RECEIPT_BODY}")]"
}

test_a_commitless_receipt_approves_the_head_at_its_request() {
  receipt_fixture
  run_status
  assert_eq "$(state_tok "$STATE")" approved "staging#1424's receipt is the verdict for the head it was asked on"
  assert_contains "$STATE" "no-findings receipt naming no commit at 2026-10-26T10:24:02Z" "the line names the receipt"
  assert_contains "$STATE" "answering the '@codex review' request at 2026-10-26T10:21:23Z, after head 5f3a033 arrived at 2026-10-26T09:46:15Z" \
    "and the request and arrival that bind it to the head"
  assert_not_contains "$LINE" "FAILED" "the reading staging#1424 had before"
  # The shape from before the receipt marker (ocannl-staging#27, 2026-06-05), another flourish.
  receipt_fixture "${RECEIPT_BODY#<!-- codex-review-receipt:v1 -->$'\n\n'}"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "the marker-less receipt is the same receipt"
  receipt_fixture "${RECEIPT_BODY/:+1:/Already looking forward to the next diff.}"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a flourish is not read"
  # The PR's opening is the request when no '@codex review' precedes the receipt: "PR opened".
  receipt_fixture
  COMMENTS_JSON="[$(receipt_summary "${RECEIPT_SUMMARY_BODY/Manual request/PR opened}"),$(
    plain_comment 6413711632 2026-10-26T10:24:02Z "$RECEIPT_BODY")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "the opening round's receipt is the opening head's verdict"
  assert_contains "$STATE" "answering the PR's opening at 2026-10-26T09:46:15Z" "named as the opening"
  # A 👀 the round left up under the receipt is that round.
  receipt_fixture
  REACTIONS_JSON="[$(reaction eyes 2026-10-26T10:21:30Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a 👀 older than the receipt does not outrank it"
}

# Every way out of the binding: never approved, and never the failed run it was read as.
test_a_commitless_receipt_approves_no_other_head() {
  receipt_fixture
  HEAD_AT=2026-10-26T10:22:00Z
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a head pushed after the request is not approved by its receipt"
  assert_contains "$STATE" "arrived at 2026-10-26T10:22:00Z, after the '@codex review' request at 2026-10-26T10:21:23Z" \
    "the line says why the head does not read"
  assert_contains "$STATE" "a verdict for an unknown head" "and what the receipt is then"
  assert_not_contains "$LINE" "FAILED" "never the failed run"
  HEAD_AT=""
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a commit date that does not read binds the receipt to no head"
  assert_contains "$STATE" "commit date does not read" "and says so"
  receipt_fixture
  COMMENTS_JSON="[$(request_comment 6413661149 2026-10-26T10:21:23Z),$(
    plain_comment 6413711632 2026-10-26T10:24:02Z "$RECEIPT_BODY")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "with no summary row, the request it answers is not recorded"
  receipt_fixture
  COMMENTS_JSON="[$(receipt_summary "${RECEIPT_SUMMARY_BODY/Manual request/New commits}"),$(
    request_comment 6413661149 2026-10-26T10:21:23Z),$(plain_comment 6413711632 2026-10-26T10:24:02Z "$RECEIPT_BODY")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a push-triggered round names no head it reviewed"
  # A draft marked ready (#847's row, ludics#838): with no '@codex review' before it, the opening is
  # the only request the binding dates, and the row says the round was not the opening's.
  receipt_fixture
  COMMENTS_JSON="[$(receipt_summary "${RECEIPT_SUMMARY_BODY/Manual request/Draft marked ready}"),$(
    plain_comment 6413711632 2026-10-26T10:24:02Z "$RECEIPT_BODY")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a round triggered by marking the draft ready binds no head: its moment is not read"
  assert_contains "$STATE" "triggered by 'PR opened'" "and the line says the row is not the opening's round"
  receipt_fixture
  COMMENTS_JSON="[$(receipt_summary "${RECEIPT_SUMMARY_BODY//10:24:03.723881Z/10:24:01.5Z}"),$(
    request_comment 6413661149 2026-10-26T10:21:23Z),$(plain_comment 6413711632 2026-10-26T10:24:02Z "$RECEIPT_BODY")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a row older than the receipt is not the round it closed"
  # A head that arrived after the receipt: an earlier head's verdict, read as before.
  receipt_fixture
  HEAD_AT=2026-10-26T10:30:00Z
  run_status
  assert_not_contains "$(state_tok "$STATE")" approved "a receipt older than the head is an earlier head's"
  assert_not_contains "$STATE" "unknown head" "and not this head's at all"
  # Anything newer than the receipt outranks it.
  receipt_fixture
  COMMENTS_JSON="${COMMENTS_JSON%]},$(request_comment 6413800000 2026-10-26T10:25:00Z)]"
  run_status
  assert_not_contains "$(state_tok "$STATE")" approved "a request since the receipt asks for a round still due"
  receipt_fixture
  REACTIONS_JSON="[$(reaction eyes "$(clock_at -60)")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "a 👀 since the receipt is a round to wait out"
  receipt_fixture
  REVIEWS_JSON="[$(review 6 "$RECEIPT_HEAD" 2026-10-26T10:25:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "a review since the receipt is the reviewer's newer word"
}

test_a_commitless_receipt_outside_the_allowlist_is_not_read() {
  local body
  for body in "$RECEIPT_BODY
P.S. one more thing" \
              "${RECEIPT_BODY/:+1:/:+1:

A paragraph the receipt does not carry.}" \
              "${RECEIPT_BODY/Codex Review: /}" \
              "${RECEIPT_BODY/<br\/>/<details>a second block</details>}"; do
    receipt_fixture "$body"
    run_status
    assert_not_contains "$(state_tok "$STATE")" approved "a body outside the receipt's shape is no receipt: ${body:0:60}"
  done
  # A receipt stamped with another commit is that commit's verdict, never this head's.
  receipt_fixture "${RECEIPT_BODY/:+1:/:+1:

**Reviewed commit:** \`777a7f5\`}"
  run_status
  assert_not_contains "$(state_tok "$STATE")" approved "a stamp naming another commit is not read as commit-less"
}

test_watch_reads_a_commitless_receipt_as_the_approval_it_is() {
  receipt_fixture
  run_watch 0,1,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "nothing is posted"
  assert_contains "$WATCH_OUT$WATCH_ERR" "approved" "the watch reports the approval"
  assert_not_contains "$WATCH_OUT$WATCH_ERR" "FAILED" "not the failed run staging#1424's worker was told of"
  assert_not_contains "$WATCH_OUT$WATCH_ERR" "push a new head" "and no new head is advised"
}

test_watch_re_requests_a_commitless_completed_row_once() {
  retune GRACE=2
  commitless_fixture
  run_watch 0,1,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "one request posted for the commit-less round (staging#1347's worker posted it by hand)"
  assert_contains "$WATCH_ERR" "re-requested the review with '@codex review'" "the watch says it did"
  assert_not_contains "$WATCH_OUT" "FAILED" "the close it answered is not the verdict"
}

# Review of #465, round 1: a failure first seen on the window's LAST regular poll still gets the
# request's grace — the deadline is set by the post, not by the round's `failed` read, which has
# none — so the watch goes on to read the request back instead of ending on it.
test_watch_waits_out_a_re_request_posted_on_its_last_poll() {
  retune GRACE=2
  failed_run_fixture
  # An interval past the timeout: one regular round, then the boundary.
  run_watch 0,1,0 5 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 "the request is posted"
  assert_contains "$WATCH_ERR" "extending watch for the live review or fresh nudge" \
    "and the window extends for its grace"
  assert_contains "$WATCH_ERR" "fresh review nudge; waiting for pickup" "reading the request back"
  assert_eq "$WATCH_RC" 0 "the window ends on the request's grace, not as a quiet window (exit 1)"
  assert_contains "$WATCH_OUT" "no review materialized" "the grace verdict is the request's own"
}

# Review of #465, rounds 1 and 2: the round decided on its snapshot, and a 👍 landing before the
# write would be cleared by it. The state is read fresh before the round is dispatched, the post is
# made only on that read, and whatever the read says instead is handled by the same round — here
# on the window's LAST regular poll, where a state only logged would have ended the window quiet
# on the stale failure.
test_watch_does_not_post_over_an_approval_that_landed_since_the_round() {
  failed_run_fixture
  # Reactions reads: the opening status (1), the round's state (2), the fresh read before the
  # write (3) — the 👍 lands between the round and the write.
  THUMBS_ON_REACTIONS_READ=3
  # An interval past the timeout: this round is the last regular one.
  run_watch 0,1,0 5 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "nothing is posted"
  assert_contains "$WATCH_ERR" "not re-requesting the failed run on 1e14b13 — a fresh read says: approved" \
    "and the watch says why"
  assert_eq "$WATCH_RC" 0 "the approval ends the wait"
  assert_contains "$WATCH_OUT" "approved (👍 from" "and is what the watch reports, not the stale failure"
  assert_not_contains "$WATCH_OUT" "FAILED" "the failure the round read is not reported"
}

test_watch_surfaces_a_re_request_that_did_not_post() {
  failed_run_fixture
  FAIL_POST=1
  # Four attempts is GhSession.retry's write default: the request must be sent once whatever it is.
  retune API_ATTEMPTS=4
  run_watch 0,1,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "a gateway refusal is not re-sent: it may have landed (review of #465, round 4)"
  assert_eq "$WATCH_RC" 0 "the caller has a move to make"
  assert_contains "$WATCH_OUT" "re-request for the failed run on head 1e14b13 did not go through" \
    "the watch says the request is not known to be on the PR"
  assert_contains "$WATCH_OUT" "watermark: " "and ends on a watermark"
}

# The `failed` arm's other half (dc0c749): the request is on the PR, but the comments feed has not
# caught up with it, so the rounds after the post still read the run as failed and never
# re-requested. One post per head per process — it is polled, not posted again — and the request's
# grace, not the failed state's lack of one, bounds the window.
test_watch_does_not_post_twice_while_the_feed_lags_its_request() {
  retune GRACE=2
  failed_run_fixture
  HIDE_POSTED=1
  run_watch 0,1,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 1 \
    "one request, however many rounds still read the failure"
  assert_contains "$WATCH_ERR" "re-requested the review with '@codex review'" "the watch made it"
  assert_eq "$WATCH_RC" 1 "the request's grace ran out with nothing read back: a quiet window, re-arm"
  assert_contains "$WATCH_OUT" "no reviewer activity about head" "and it says so"
}

# The opt-out (ludics-lite#570): `--no-nudge` posts nothing, the failed run's re-request included,
# and hands the failure back with the request to post.
test_watch_no_nudge_leaves_a_failed_run_to_the_caller() {
  failed_run_fixture
  WATCH_FLAG=--no-nudge
  run_watch 0,1,0 1 3
  assert_eq "$(grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true)" 0 "nothing is posted"
  assert_eq "$WATCH_RC" 0 "the failed run is something to act on"
  assert_contains "$WATCH_OUT" "--no-nudge: the watch did not re-request the failed run on head 1e14b13" \
    "the verdict says the request is the caller's"
  assert_contains "$WATCH_OUT" "reviewer's run FAILED on head 1e14b13" "beside the state it is about"
}

tests=(
  test_watch_no_nudge_leaves_a_failed_run_to_the_caller
  test_empty_reviews_need_their_own_findings
  test_idle_clean_says_next_move_is_yours
  test_idle_dirty_says_conflicts_not_next_move
  test_idle_draft_names_gh_pr_ready
  test_reviewing_dirty_still_says_conflicts
  test_expected_dirty_says_conflicts
  test_approved_dirty_says_conflicts_and_survives_a_failed_pr_read
  test_reviewing_with_a_failed_pr_read_says_unread
  test_head_is_read_after_the_feeds
  test_computing_mergeability_is_not_a_conflict
  test_failed_pr_read_is_unknown_where_the_head_decides
  test_one_pr_read_per_status
  test_detail_is_the_last_field_and_keeps_pipes
  test_watch_reads_the_drift_when_a_round_lands
  test_watch_approved_leaves_the_drift_to_merge
  test_a_round_and_its_state_are_one_read
  test_a_round_reads_the_head_after_its_feeds
  test_the_state_is_about_the_head_the_round_was_classified_against
  test_a_failed_round_hands_the_state_nothing
  test_status_after_a_watch_reads_for_itself
  test_a_dead_watch_s_snapshot_directory_is_swept
  test_every_other_family_a_dead_process_leaves_is_swept_too
  test_initialization_failure_is_its_own_state
  test_a_failure_naming_no_ref_is_not_attributed
  test_a_differently_worded_failure_is_missed_not_guessed
  test_a_round_quoting_this_head_s_ref_error_is_not_a_failure
  test_the_line_states_both_moves
  test_a_failure_naming_another_head_is_expected
  test_a_round_of_the_head_after_the_failure_wins
  test_a_newer_reviewer_word_supersedes_the_failure
  test_a_quoted_failure_is_not_a_failure
  test_watch_requests_over_the_initialization_failure_once
  test_watch_hands_back_an_initialization_failure_after_a_request
  test_watch_does_not_request_over_an_initialization_failure_when_barred
  test_watch_requests_over_the_missing_environment_once
  test_the_missing_environment_is_a_failed_state
  test_the_missing_environment_is_attributed_by_the_clock
  test_a_quoted_missing_environment_is_not_a_failure
  test_a_standing_verdict_survives_a_failed_re_request
  test_a_verdict_comment_naming_the_head_is_an_approval
  test_a_verdict_older_than_a_fresh_eyes_is_not_an_approval
  test_an_edited_placeholder_verdict_approves_over_its_eyes
  test_a_verdict_older_than_a_later_findings_review_is_idle
  test_the_round_started_placeholder_does_not_spend_the_eyes
  test_a_spent_eyes_is_not_a_running_round
  test_a_feed_that_did_not_answer_is_unknown_not_a_fact
  test_a_feed_jq_cannot_parse_is_unknown_not_a_fact
  test_a_broken_jq_program_is_unknown_not_a_value
  test_a_broken_jq_program_is_unknown_on_the_pending_request_read
  test_a_broken_jq_program_is_unknown_on_the_current_head_evidence
  test_a_running_row_the_stamp_pattern_misses_is_unknown
  test_an_older_summarys_running_row_does_not_outrank_the_thumbs_up
  test_an_old_eyes_over_a_fresh_push_is_its_pickup_then_its_stall
  test_an_approval_over_open_threads_is_unresolved
  test_an_approval_with_every_thread_resolved_stays_approved
  test_status_walks_the_threads_once_whatever_the_state
  test_status_counts_open_threads_on_the_head_and_on_earlier_heads
  test_an_unread_thread_connection_is_unknown_not_approved
  test_the_thread_read_pages_to_the_end
  test_a_count_that_leads_the_rows_is_unread
  test_a_read_still_paging_at_the_cap_is_unread
  test_a_thread_with_no_resolution_field_is_open
  test_a_thread_path_is_shell_quoted
  test_a_broken_jq_program_is_unknown_on_the_thread_read
  test_a_thread_is_named_by_its_full_width_id
  test_resolve_reaches_every_thread_the_gate_can_name
  test_a_thumbs_up_the_summary_gives_another_head_is_not_an_approval
  test_a_thumbs_up_older_than_the_head_commit_is_not_an_approval
  test_a_stale_thumbs_up_leaves_the_ordinary_states
  test_a_thumbs_up_is_judged_only_on_evidence_that_can_prove_it_stale
  test_a_completed_row_on_the_head_is_a_verdict
  test_a_completed_row_for_another_head_is_not_this_head_s_verdict
  test_a_completed_row_after_a_findings_review_is_not_clean
  test_a_completed_row_needs_a_round_to_bound_it
  test_a_completed_row_outside_the_allowlist_is_not_a_verdict
  test_a_completed_row_approval_passes_the_thread_gate
  test_a_clean_state_record_on_the_head_is_a_verdict
  test_a_state_record_yields_to_what_the_reviewer_posted
  test_a_stale_eyes_under_the_head_s_running_row_is_reviewing
  test_a_stale_eyes_still_decides_without_the_head_s_newer_running_row
  test_a_same_head_rerun_after_findings_is_reviewing
  test_a_failed_run_on_the_head_is_a_failed_state
  test_a_failed_run_needs_the_head_and_no_approval
  test_a_failed_run_needs_a_silent_reviewer
  test_a_failed_run_counts_the_requests_on_its_head
  test_a_failed_run_posted_with_an_initialization_failure
  test_a_failed_row_outside_the_allowlist_is_not_read
  test_a_commitless_completed_row_is_a_failed_run
  test_a_commitless_completed_row_needs_the_head_and_a_silent_reviewer
  test_a_commitless_row_outside_the_allowlist_is_not_read
  test_a_commitless_receipt_approves_the_head_at_its_request
  test_a_commitless_receipt_approves_no_other_head
  test_a_commitless_receipt_outside_the_allowlist_is_not_read
  test_watch_reads_a_commitless_receipt_as_the_approval_it_is
  test_a_broken_jq_program_is_unknown_on_the_request_read
  test_watch_re_requests_a_failed_run_once
  test_watch_re_requests_a_commitless_completed_row_once
  test_watch_surfaces_a_re_request_that_did_not_post
  test_watch_waits_out_a_re_request_posted_on_its_last_poll
  test_watch_does_not_post_over_an_approval_that_landed_since_the_round
  test_watch_does_not_post_twice_while_the_feed_lags_its_request
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
