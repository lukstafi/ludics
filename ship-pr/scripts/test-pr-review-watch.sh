#!/usr/bin/env bash
# Fixture tests for what ends a `watch` (ludics-lite#72). The loop used to return 0 on any
# `--- ` line a poll rendered, whoever it was about: on this repository a round's watch exited on
# the inline findings and took its watermark from that poll, the reviewer's separate summary
# review landed seconds later with a higher id, and the NEXT window returned 0 on it at once —
# a wake, a re-arm, and nothing about the new head to act on. So the wait now ends only on
# reviewer activity about the head being watched, every exit says what it is exiting on, and a
# verdict that says nothing came polls once more before it says it.
#
# The `expected` clock is here too, the same issue's other half: it used to start at the head
# commit's committer date alone, which on a PR opened seconds earlier read "due for 22m" and
# recommended a nudge at a reviewer that had had no time at all.
#
# The fixture answers the feeds IN SEQUENCE across polls (see `schedule`), which is what a
# watch-level case needs and what the single-answer suites do not do: the round a final poll
# catches has to be absent from the round before it.

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
test_tmpdir TEST_ROOT watch-test

# The clock is the script's own test clock (SHIP_PR_TEST_CLOCK, prreview/clock.py): a file
# holding the epoch second, which every age the state reads and every deadline the watch keeps is
# measured on, and which the watch's sleep ADVANCES instead of waiting. A window is then as long as
# its arithmetic says and takes no wall time, and an age is exactly what a case dated it, however
# slowly the box runs — through the environment alone, so the same cases drive any implementation
# behind the command line (ludics-lite#403). It used to be a suite `sleep` advancing SECONDS and a
# stubbed `age_of`, and the status outages a stubbed `status_state`: both are black-box now, the
# outages as the reactions read failing at a round (FAIL_REACTIONS, below).
export SHIP_PR_TEST_CLOCK="$TEST_ROOT/clock"
date +%s >"$SHIP_PR_TEST_CLOCK"

# The fixture clock's time, plus an offset in seconds, as GitHub dates things.
clock_at() { # [offset]
  jq -rn --argjson t "$(cat "$SHIP_PR_TEST_CLOCK")" --argjson o "${1:-0}" '($t + $o) | todate'
}

REPO=example/repo
REQUEST_LOG="$TEST_ROOT/requests"
FEEDS="$TEST_ROOT/feeds"

# Two heads: H2 is what the watch is bound to, H1 the head a previous round was about. Full
# 40-hex, as GitHub serves them, so the seven-character stamp poll renders is a real truncation.
H1=1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
H2=2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
HEAD_SHA="$H2"
MERGEABLE_STATE=clean
# The PR's own state (open, closed), which the automatic nudge reads last; and a push landing
# exactly then: from the write gate's read of the PR on, its head is PUSH_AT_WRITE_GATE.
PR_STATE=open
PUSH_AT_WRITE_GATE=""
DRAFT_AT_WRITE_GATE=""
FAIL_PULLS=""
# The poll round from which the feeds stop answering (the transport failure a final poll can hit),
# and the one from which the PR read stops answering. 0 is never.
FAIL_FEEDS_FROM=0
FAIL_PULLS_FROM=0
# The last round of a FAIL_PULLS_FROM outage (0: it never ends).
FAIL_PULLS_UNTIL=0
# A review's own comments endpoint refusing to answer: the per-review re-read poll makes for every
# new review, whose failure fails the round (23755d8).
FAIL_REVIEW_COMMENTS=""
# The reactions read failing — the read every state line starts with, so a state read made while
# it fails is `unknown`: always (FAIL_REACTIONS=1), at one poll round (FAIL_REACTIONS_ROUND), or
# from one on (FAIL_REACTIONS_FROM, 0 is never). And the comments feed failing from a round on,
# which fails a poll after the inline feed it reads first has answered.
FAIL_REACTIONS=""
FAIL_REACTIONS_ROUND=""
FAIL_REACTIONS_FROM=0
FAIL_COMMENTS_FROM=0
# The watch's own '@codex review' (ludics-lite#453's failed run, #570's automatic nudge): a POST
# kept in $FEEDS/posted, one comment per line, and served back by the comments reads after it
# unless HIDE_POSTED (a feed that has not caught up); FAIL_POST refuses it. NUDGE_ANSWER is the id
# of the review the reviewer answers a posted request with: a review of the head the PR had when
# the request was posted, served from the round after it.
FAIL_POST=""
HIDE_POSTED=""
NUDGE_ANSWER=""
# Extra arguments for the watch (`--no-nudge`).
WATCH_FLAG=""
# The head's committer date and the PR's creation, the two clocks the `expected` state runs on.
# Fresh by default, so a case about what ends a wait is never decided by the grace expiring
# underneath it; the clock cases set them where they need them.
HEAD_AT=""
PR_CREATED_AT=""

# --- the sequenced fixture ---------------------------------------------------------------------
# Every feed answers per POLL ROUND: `schedule <feed> <round> <json>` says what it answers from
# that round on, and a round with no schedule of its own answers the newest one below it. So a
# feed set once holds for the whole window, and one set at round 2 is invisible to round 1. Round
# 0 is the reads a watch makes before its first poll (its opening state), which answer nothing
# unless a case schedules round 0 itself.
# The round counter lives in a file because the fixture runs inside the command substitution each
# poll is made in, where a variable would not survive to the next call.

reset_fixture() {
  rm -rf "$FEEDS"
  mkdir -p "$FEEDS"
  echo 0 >"$FEEDS/round"
  schedule reactions 1 '[]'
  schedule reviews 1 '[]'
  schedule comments 1 '[]'
  schedule inline 1 '[]'
  schedule review_comments 1 '[]'
  HEAD_SHA="$H2"
  MERGEABLE_STATE=clean
  PR_STATE=open
  PUSH_AT_WRITE_GATE=""
  DRAFT_AT_WRITE_GATE=""
  FAIL_PULLS=""
  FAIL_FEEDS_FROM=0
  FAIL_PULLS_FROM=0
  FAIL_PULLS_UNTIL=0
  FAIL_REVIEW_COMMENTS=""
  FAIL_REACTIONS=""
  FAIL_REACTIONS_ROUND=""
  FAIL_REACTIONS_FROM=0
  FAIL_COMMENTS_FROM=0
  FAIL_POST=""
  HIDE_POSTED=""
  NUDGE_ANSWER=""
  WATCH_FLAG=""
  date +%s >"$SHIP_PR_TEST_CLOCK"
  HEAD_AT=$(clock_at -60)
  PR_CREATED_AT=$(clock_at -60)
  : >"$REQUEST_LOG"
}

schedule() { # <feed> <round> <json>
  printf '%s\n' "$3" >"$FEEDS/$1.$2"
}

# cmd_poll reads the inline feed first on every round, so that endpoint is the round boundary.
poll_rounds() { cat "$FEEDS/round"; }

feed_answer() { # <feed>
  local round n
  round=$(cat "$FEEDS/round")
  n="$round"
  while [ "$n" -ge 0 ]; do
    if [ -e "$FEEDS/$1.$n" ]; then
      cat "$FEEDS/$1.$n"
      return 0
    fi
    n=$((n - 1))
  done
  echo '[]'
}

reaction() { # <content> <created_at>
  jq -cn --arg c "$1" --arg at "$2" --arg rev "$REVIEWER" \
    '{user:{login:($rev + "[bot]")}, content:$c, created_at:$at}'
}

# A 👍 given for the fixture's head: dated after reset_fixture's HEAD_AT (a minute ago), because a
# 👍 older than the head's commit is a previous head's and approves nothing (#418).
head_thumb() {
  reaction +1 "$(clock_at -30)"
}

review() { # <id> <commit> <submitted_at> [body]
  jq -cn --argjson id "$1" --arg sha "$2" --arg at "$3" --arg b "${4:-findings}" --arg rev "$REVIEWER" \
    '{id:$id, user:{login:($rev + "[bot]")}, state:"COMMENTED", commit_id:$sha,
      submitted_at:$at, body:$b}'
}

# The inline rows, inline_comment (the flat listing) and positional_comment (the per-review
# endpoint), are test-pr-review-lib.sh's since ludics-lite#91, where the contract suite holds them
# to the fields pr-review-api-contract.sh pins.

# How many times a string occurs in the whole of what a watch printed. A fold is only a fold if
# the duplicated BODY is printed once, and "contains it" cannot tell one copy from three.
occurrences() { # <haystack> <needle>
  grep -c -F -- "$2" <<<"$1" || true
}

# How many DISTINCT places a round's inline entries print, the id field aside. The claim of #113
# is not that some anchor token appears somewhere: it is that two entries the fold KEPT APART
# cannot read as one finding posted twice, and only the whole header minus the ids can say that.
# An assertion per token would pass on a rendering that printed the same line for both.
distinct_inline_headers() { # <haystack>
  { grep -F -- '--- inline ' <<<"$1" || true; } | sed 's/ id=[^ ]*//' | sort -u | wc -l | tr -d '[:space:]'
}

summary_comment() { # <id> <created_at> <body>
  jq -cn --argjson id "$1" --arg at "$2" --arg b "$3" --arg rev "$REVIEWER" \
    '{id:$id, user:{login:($rev + "[bot]")}, created_at:$at, updated_at:$at, body:$b}'
}

stamped_summary() { # <id> <created_at> <commit> <text>
  summary_comment "$1" "$2" "$(printf '%s\n\n**Reviewed commit:** `%s`\n' "$4" "${3:0:7}")"
}

# Whether the poll feeds answer this round: a transport failure that starts at a given round is
# how a final poll is made to fail while the loop rounds before it succeeded.
feeds_answering() {
  [ "$FAIL_FEEDS_FROM" -eq 0 ] || [ "$(cat "$FEEDS/round")" -lt "$FAIL_FEEDS_FROM" ]
}

compare_json() { # <behind> <ahead> <file>
  jq -cn --argjson behind "$1" --argjson ahead "$2" --arg f "$3" \
    '{behind_by:$behind, ahead_by:$ahead, merge_base_commit:{sha:"merge-base-sha"},
      files:[{filename:$f}]}'
}

gh() {
  local response="" posted head
  gh_fixture_parse "$@"
  case "$FIXTURE_ENDPOINT" in
  "repos/$REPO/pulls/7/comments?per_page=100")
    # The round boundary: poll reads this feed first, before anything else it reads.
    echo $(($(cat "$FEEDS/round") + 1)) >"$FEEDS/round"
    feeds_answering || {
      echo "gh: 503 No server is currently available to service your request" >&2
      return 1
    }
    response=$(feed_answer inline)
    ;;
  "repos/$REPO/issues/7/reactions?per_page=100")
    if [ -n "$FAIL_REACTIONS" ] || [ "$(poll_rounds)" = "$FAIL_REACTIONS_ROUND" ] ||
      { [ "$FAIL_REACTIONS_FROM" -ne 0 ] && [ "$(poll_rounds)" -ge "$FAIL_REACTIONS_FROM" ]; }; then
      echo "gh: reactions unavailable (HTTP 500)" >&2
      return 1
    fi
    response=$(feed_answer reactions)
    ;;
  "repos/$REPO/pulls/7/reviews?per_page=100")
    response=$(feed_answer reviews)
    [ ! -e "$FEEDS/answer" ] || [ "$(poll_rounds)" -le "$(cat "$FEEDS/answer.round")" ] ||
      response=$(jq -c --slurpfile a "$FEEDS/answer" '. + $a' <<<"$response")
    ;;
  "repos/$REPO/issues/7/comments?per_page=100")
    if [ "$FAIL_COMMENTS_FROM" -ne 0 ] && [ "$(poll_rounds)" -ge "$FAIL_COMMENTS_FROM" ]; then
      echo "gh: 503 No server is currently available to service your request" >&2
      return 1
    fi
    response=$(feed_answer comments)
    [ -n "$HIDE_POSTED" ] || [ ! -s "$FEEDS/posted" ] ||
      response=$(jq -c --slurpfile p "$FEEDS/posted" '. + $p' <<<"$response")
    ;;
  "repos/$REPO/issues/7/comments")
    [ "$FIXTURE_METHOD" = POST ] || bail "unexpected ${FIXTURE_METHOD:-GET} on $FIXTURE_ENDPOINT"
    if [ -n "$FAIL_POST" ]; then
      echo "gh: HTTP 502: Bad Gateway" >&2
      return 1
    fi
    # Ids above every fixture comment's, dated on the fixture clock, as GitHub numbers a new one.
    posted=0
    head="$HEAD_SHA"
    [ ! -e "$FEEDS/posted" ] || posted=$(($(wc -l <"$FEEDS/posted")))
    jq -cn --argjson id "$((9000 + posted))" --arg b "$FIXTURE_BODY" --arg at "$(clock_at)" \
      '{id:$id, user:{login:"me"}, created_at:$at, updated_at:$at, body:$b}' >>"$FEEDS/posted"
    [ ! -e "$FEEDS/head.0" ] || head=$(feed_answer head)
    [ -z "$NUDGE_ANSWER" ] || {
      review "$NUDGE_ANSWER" "$head" "$(clock_at 1)" 'the round the request asked for' >"$FEEDS/answer"
      poll_rounds >"$FEEDS/answer.round"
    }
    response='{"html_url":"https://github.com/example/repo/pull/7#issuecomment-9000"}'
    ;;
  "repos/$REPO/pulls/7/reviews/"*"/comments?per_page=100")
    if [ -n "$FAIL_REVIEW_COMMENTS" ]; then
      echo "gh: 503 No server is currently available to service your request" >&2
      return 1
    fi
    response=$(feed_answer review_comments)
    ;;
  "repos/$REPO/pulls/7")
    if [ -n "$FAIL_PULLS" ] ||
      { [ "$FAIL_PULLS_FROM" -ne 0 ] && [ "$(cat "$FEEDS/round")" -ge "$FAIL_PULLS_FROM" ] &&
        { [ "$FAIL_PULLS_UNTIL" -eq 0 ] || [ "$(cat "$FEEDS/round")" -le "$FAIL_PULLS_UNTIL" ]; }; }; then
      echo "gh: pull request unavailable (HTTP 500)" >&2
      return 1
    fi
    # The head per round when a case schedules one (`schedule head <round> <sha>`), else HEAD_SHA.
    head="$HEAD_SHA"
    [ ! -e "$FEEDS/head.0" ] || head=$(feed_answer head)
    case "$FIXTURE_FILTER" in *.state*) [ -z "$PUSH_AT_WRITE_GATE" ] || : >"$FEEDS/pushed" ;; esac
    [ ! -e "$FEEDS/pushed" ] || head="$PUSH_AT_WRITE_GATE"
    local draft=false
    case "$FIXTURE_FILTER" in *.draft*) [ -z "$DRAFT_AT_WRITE_GATE" ] || draft=true ;; esac
    response=$(jq -cn --arg h "$head" --arg m "$MERGEABLE_STATE" --arg c "$PR_CREATED_AT" --arg s "$PR_STATE" \
      --argjson d "$draft" \
      '{base:{ref:"main",sha:"stale-base-sha"}, head:{sha:$h}, mergeable_state:$m, created_at:$c, state:$s, draft:$d}')
    ;;
  "repos/$REPO/commits/$H1" | "repos/$REPO/commits/$H2")
    response=$(jq -cn --arg d "$HEAD_AT" '{sha:"head-sha", commit:{committer:{date:$d}}}')
    ;;
  "repos/$REPO/commits/main") response='{"sha":"base-sha"}' ;;
  # The open-thread read an approval is checked with (ludics-lite#289), answered per round like
  # the feeds: `schedule threads <round> <review_thread rows>`, none by default.
  graphql)
    case "$*" in *reviewThreads*) ;; *) bail "unexpected graphql call: $*" ;; esac
    response=$(review_threads_answer "$(feed_answer threads)" "$@")
    ;;
  "repos/$REPO/compare/base-sha...$H1?per_page=1" | "repos/$REPO/compare/base-sha...$H2?per_page=1")
    response=$(compare_json 1 2 pr.txt)
    ;;
  "repos/$REPO/compare/$H1...base-sha?per_page=1" | "repos/$REPO/compare/$H2...base-sha?per_page=1")
    response=$(compare_json 2 1 base.txt)
    ;;
  *) bail "unexpected fixture endpoint: $FIXTURE_ENDPOINT" ;;
  esac
  gh_fixture_answer "$response"
}

# A watch over a short window. WATCH_INTERVAL above WATCH_TIMEOUT means exactly one loop poll and
# then the final one, which is the shape the final-poll cases need; the default pair here polls
# twice in the loop.
run_watch() { # [watermark] [interval] [timeout]
  local rc
  set +e
  WATCH_INTERVAL="${2:-1}" WATCH_TIMEOUT="${3:-1}" \
    cmd_watch 7 "${1:-0,0,0}" ${WATCH_FLAG:+"$WATCH_FLAG"} >"$TEST_ROOT/watch.out" 2>"$TEST_ROOT/watch.err"
  rc=$?
  set -e
  WATCH_RC="$rc"
  WATCH_OUT=$(cat "$TEST_ROOT/watch.out")
  WATCH_ERR=$(cat "$TEST_ROOT/watch.err")
}

# The state and its rendering, as the watch reads them: the Python's own, through the two entry
# points of ludics.prreview that the command line does not route to (test-pr-review-status.sh).
run_status() {
  STATE=$(py_forward call status-state 7)
  LINE=$(py_forward call status-line "$STATE")
}

# --- what ends the wait -------------------------------------------------------------------------

# The shape the issue was filed on: the reviewer's summary review for the PREVIOUS head, sitting
# above the watermark the last window ended on. It is not this head's round and must not be
# mistaken for one — and the negative control right below is the same review on THIS head, which
# must still end the wait, or this test would pass on a watch that never returns.
test_a_review_of_another_head_does_not_end_the_wait() {
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H1" 2026-09-01T00:01:00Z 'the previous round, summarised')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 "a review of another head leaves the window quiet"
  assert_not_contains "$WATCH_OUT" "--- review id=500" \
    "stdout is what to act on, and a previous head's round is not it"
  assert_contains "$WATCH_ERR" "1 item(s) NOT about head ${H2:0:7}" \
    "the round that scrolled past should be named on stderr"
  assert_contains "$WATCH_ERR" "--- review id=500 state=COMMENTED commit=${H1:0:7}" \
    "and printed for the record, whole: nothing renders it again"
  assert_contains "$WATCH_ERR" "the previous round, summarised" "the body is part of the record"
  assert_contains "$WATCH_OUT" "watermark: 0,0,500" \
    "the watermark advances past it, or the next window sees it again"
  # The control: the same review, about the head being watched.
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z 'this head, reviewed')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a review of the head being watched is the round to act on"
  assert_contains "$WATCH_OUT" "--- review id=500 state=COMMENTED commit=${H2:0:7}" \
    "and it goes to stdout, as poll printed it"
}

# The stamp on an inline finding is `original_commit_id`, not `commit_id`: GitHub migrates the
# latter forward to the current head for a comment whose lines still exist, so a previous round's
# finding would stamp itself with the head being watched and pass any test put to it.
test_an_inline_finding_is_bound_by_the_commit_it_was_written_against() {
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H1" "$H2" 'a finding from the round before')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 \
    "a finding written against the previous head is not this head's round, whatever commit_id says"
  assert_contains "$WATCH_ERR" "--- inline id=900 a.sh:3 commit=${H1:0:7}" \
    "the stamp is the commit the reviewer wrote it against"
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'a finding on the head')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a finding written against this head ends the wait"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:3 commit=${H2:0:7}" "on stdout"
}

# A comment's only head association is the "Reviewed commit:" stamp. One naming another commit is
# a previous round's summary; one naming NOTHING is not evidence about any head, and is acted on
# — the reviewer's initialization failure is exactly that shape, and swallowing it would leave a
# watch waiting on a round that will never start.
test_a_summary_is_bound_by_the_commit_it_names() {
  reset_fixture
  schedule comments 1 "[$(stamped_summary 700 2026-09-01T00:01:00Z "$H1" 'Codex Review: the previous head')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 "a summary naming another commit does not end the wait"
  assert_contains "$WATCH_ERR" "--- summary id=700 commit=${H1:0:7}" "it is recorded as what it is"
  reset_fixture
  schedule comments 1 "[$(summary_comment 700 2026-09-01T00:01:00Z 'Codex Review: no commit named here')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a summary that names no commit is acted on, never swallowed"
  assert_contains "$WATCH_OUT" "--- summary id=700 commit=-" "and its stamp says it names none"
}

# The head could not be read. Nothing can be held back for being about another commit, so
# everything is acted on and the line says why — the alternative is a watch that swallows a round
# because a PR read 500'd.
test_an_unread_head_holds_nothing_back() {
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H1" 2026-09-01T00:01:00Z)]"
  FAIL_PULLS=1
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "with no head to compare against, the round is acted on"
  assert_contains "$WATCH_ERR" "the head did not read this round, so nothing was held back" \
    "and the exit line says which case it is in"
}

# The silent half of the fold, found in round 1 of #86. When the flat comments feed lags a new
# review, poll supplements it from the per-review endpoint, whose rows carry NO line at all.
# Folded, the second is answered by a reply it never got and resolved with the first, and the
# watermark has advanced past its id, so nothing renders it again. The key therefore carries every
# location field the row has, and an absent line is never the thing two rows are folded on.
#
# The rendering has to show that too. `:0` said "unknown" in the shape of a line number, so the
# two rows below printed identically and a fold that ate one of them was invisible to the reader
# checking the round; the position each row does carry is printed instead, as `@12`.
test_rows_with_no_line_are_folded_only_when_their_positions_agree() {
  reset_fixture
  local same="the same body, at two places in one file"
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z)]"
  schedule review_comments 1 "[$(positional_comment 900 "$H2" "$same" 12),$(positional_comment 901 "$H2" "$same" 40)]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the round is acted on"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:@12" \
    "with no line to print, the first row renders the position it does carry"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:@40" \
    "and the second renders its own: two places, and they no longer LOOK alike"
  assert_not_contains "$WATCH_OUT" "id=900+901" \
    "but two positions in one file are two findings, and folding them loses the second for good"
  assert_eq "$(occurrences "$WATCH_OUT" "$same")" 2 "each is rendered, so each can be answered"
  # The control: rows agreeing on every anchor either of them has really are indistinguishable,
  # and do fold — or the case above would pass on a fold that had simply stopped working.
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z)]"
  schedule review_comments 1 "[$(positional_comment 900 "$H2" "$same" 12),$(positional_comment 901 "$H2" "$same" 12)]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "--- inline id=900+901 a.sh:@12" \
    "with nothing to tell them apart, they are one finding and one reply"
  assert_eq "$(occurrences "$WATCH_OUT" "$same")" 1 "and one body"
}

# The remaining case of an absent line: a row with no `position` either — a file-level comment
# carries `line: null` and nothing to fall back to. There is no number to print, so the rendering
# says there is none rather than printing a place the reviewer never named.
test_a_row_with_no_location_at_all_says_so() {
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z)]"
  schedule inline 1 \
    "[$(inline_comment 900 "$H2" "$H2" 'a finding about the whole file' a.sh null '' '{"subject_type":"file"}')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the round is acted on"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:?" "an unknown line renders as unknown"
  assert_not_contains "$WATCH_OUT" "a.sh:0" "and never as line zero, which reads as a line number"
}

# --- what each exit says it exits on --------------------------------------------------------------

test_the_acting_exit_names_the_item() {
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z)]"
  # Two PLACES: two findings, not one posted twice. Threads at one anchor fold into a single entry
  # (ludics-lite#76), which is the right count for a duplicate and the wrong fixture for a case
  # about how much else the exit is ending on.
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'a finding' a.sh 3),$(inline_comment 901 "$H2" "$H2" 'another finding' a.sh 9)]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the round ends the wait"
  assert_contains "$WATCH_ERR" \
    "ending the wait on inline id=900 commit=${H2:0:7} by ${REVIEWER}[bot]" \
    "the exit names the item: its id, its short commit and its author"
  assert_contains "$WATCH_ERR" "(+2 more about this head)" \
    "and how much else it is ending on, so a truncated log still says how many"
  # A review carries a state, and the exit line names it: a COMMENTED round and an APPROVED one
  # are different windows.
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z)]"
  run_watch 0,0,0
  assert_contains "$WATCH_ERR" \
    "ending the wait on review id=500 state=COMMENTED commit=${H2:0:7} by ${REVIEWER}[bot]" \
    "a review's state is part of what the exit names"
}

# Which round the wait ended on, by the count `rounds` reports (ludics-lite#423, part 2): #259's
# worker numbered its round 12 as 13 from memory and posted a threshold deferral it had to
# retract. The fixture is that shape in small: a round on H1, one on H2, and a re-requested round
# on H2 with no push — so counting heads (or pushes) says 2, and the line must say 3.
test_the_ending_line_names_the_round() (
  reset_fixture
  schedule reviews 1 "[$(review 400 "$H1" 2026-09-01T00:00:00Z),$(review 500 "$H2" 2026-09-01T01:00:00Z),$(
    review 600 "$H2" 2026-09-01T01:30:00Z)]"
  run_watch 0,0,500
  assert_eq "$WATCH_RC" 0 "the round ends the wait"
  assert_contains "$WATCH_ERR" \
    "ending the wait on review id=600 state=COMMENTED commit=${H2:0:7} by ${REVIEWER}[bot] — this window opened round 3 of 12" \
    "the exit line carries the round as \`rounds\` counts it, against the threshold"
  assert_contains "$(cmd_rounds 7 || :)" "review rounds with findings: 3 of 12" \
    "the same count \`rounds\` reports"
  # The same window as a machine-readable trailer on stdout (ludics-lite#423, part 1), just above
  # the watermark, which stays the last line.
  assert_eq "$(tail -n 2 <<<"$WATCH_OUT" | head -n 1)" "watch-rounds: from=2 to=3 threshold=12" \
    "the trailer carries the window's counts and the threshold"
  assert_contains "$(tail -n 1 <<<"$WATCH_OUT")" "watermark: " "and the watermark is still last"
  # Past the threshold the line says what that means, where the caller is about to act on it.
  ROUND_THRESHOLD=2
  run_watch 0,0,500
  assert_contains "$WATCH_ERR" "— this window opened round 3 of 2, PAST the threshold: blocking-only from here" \
    "a round past the threshold says so on the exit line"
  ROUND_THRESHOLD=off
  run_watch 0,0,500
  assert_contains "$WATCH_ERR" "— this window opened round 3 (no threshold set)" "and with none set, the count alone"
  assert_contains "$WATCH_OUT" "watch-rounds: from=2 to=3 threshold=off" "the trailer says off"
  # A span that crosses the threshold says where blocking-only starts, not that all of it is past
  # (review of #434, round 5): rounds 1–3 against a threshold of 2 keep rounds 1–2 in full.
  ROUND_THRESHOLD=2
  run_watch 0,0,0
  assert_contains "$WATCH_ERR" \
    "— this window opened rounds 1–3 of 2; from round 3 on PAST the threshold: blocking-only there, rounds 1–2 in full" \
    "the rounds before the threshold are addressed in full"
  ROUND_THRESHOLD=1
  run_watch 0,0,400
  assert_contains "$WATCH_ERR" "— this window opened rounds 2–3 of 1, PAST the threshold: blocking-only from here" \
    "a span wholly past the threshold is past as a whole"
)

# The line claims only what the window's own items opened (review of #434, round 1). A first watch
# over a backlog holds several rounds, and naming the last one against the first item would
# mislabel it; the tail of a round the previous window already ended on opens none.
test_the_ending_line_claims_only_the_rounds_the_window_opened() (
  reset_fixture
  schedule reviews 1 "[$(review 400 "$H1" 2026-09-01T00:00:00Z),$(review 500 "$H2" 2026-09-01T01:00:00Z),$(
    review 600 "$H2" 2026-09-01T01:30:00Z),$(review 601 "$H2" 2026-09-01T01:30:05Z)]"
  run_watch 0,0,0
  assert_contains "$WATCH_ERR" "— this window opened rounds 1–3 of 12" \
    "a backlog names the span, not the last round against the first item"
  assert_contains "$WATCH_OUT" "watch-rounds: from=0 to=3 threshold=12" "and the trailer the same span"
  run_watch 0,0,600
  assert_contains "$WATCH_ERR" "ending the wait on review id=601" "the burst's tail still ends the wait"
  assert_contains "$WATCH_ERR" "— this window opened no round; rounds with findings: 3 of 12" \
    "the tail of round 3 is not round 4, nor round 3 claimed again as new"
  assert_contains "$WATCH_OUT" "watch-rounds: from=3 to=3 threshold=12" "a window that opened none: from = to"
  # A tail past the threshold is still past it: its findings are blocking-only too (review of
  # #434, round 4).
  ROUND_THRESHOLD=2
  run_watch 0,0,600
  assert_contains "$WATCH_ERR" \
    "— this window opened no round; rounds with findings: 3 of 2, PAST the threshold: blocking-only from here" \
    "the tail of an over-threshold round keeps the warning"
  ROUND_THRESHOLD=12
  # The tail of round 3 AND a new round 4 in one window (review of #434, round 2): the named item
  # is the tail, so the line speaks of what the window opened, not of the item's round.
  schedule reviews 1 "[$(review 400 "$H1" 2026-09-01T00:00:00Z),$(review 500 "$H2" 2026-09-01T01:00:00Z),$(
    review 600 "$H2" 2026-09-01T01:30:00Z),$(review 601 "$H2" 2026-09-01T01:30:05Z),$(
    review 700 "$H2" 2026-09-01T02:30:00Z)]"
  run_watch 0,0,600
  assert_contains "$WATCH_ERR" \
    "ending the wait on review id=601 state=COMMENTED commit=${H2:0:7} by ${REVIEWER}[bot] (+1 more about this head) — this window opened round 4 of 12" \
    "the window opened round 4; review 601 is not claimed to be it"
)

# The window is the whole watch, not the last poll (review of #434, round 3): the first poll sees
# only a round about H1, scrolls past it and advances the watermark; the round about H2 lands on
# the second. The watch opened both, as it would have read them in a single poll.
test_the_round_span_is_the_whole_watch() {
  reset_fixture
  schedule reviews 1 "[$(review 400 "$H1" 2026-09-01T00:00:00Z)]"
  schedule reviews 2 "[$(review 400 "$H1" 2026-09-01T00:00:00Z),$(review 500 "$H2" 2026-09-01T01:00:00Z)]"
  run_watch 0,0,0 1 10
  assert_eq "$(poll_rounds)" 2 "the round about the head lands on the second poll"
  assert_contains "$WATCH_ERR" "ending the wait on review id=500" "and ends the wait"
  assert_contains "$WATCH_ERR" "— this window opened rounds 1–2 of 12" \
    "the span is counted from the watermark the watch started with"
  assert_contains "$WATCH_OUT" "watch-rounds: from=0 to=2 threshold=12" "and so is the trailer's"
}

# The label reads no feed of its own inside a round (review of #434, round 2): both counts take the
# round's snapshot, and an empty-bodied review's own comments — which substantive_reviews asks for
# on every count — come from the per-round cache the poll and the state read already filled.
test_the_round_label_costs_no_request() (
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T01:00:00Z ' '),$(review 600 "$H2" 2026-09-01T01:30:00Z ' ')]"
  schedule review_comments 1 "[$(inline_comment 900 "$H2" "$H2")]"
  run_watch 0,0,500
  assert_contains "$WATCH_ERR" "— this window opened round 2 of 12" "the empty-bodied reviews are rounds"
  # ONE read of review 500's comments, and the watch cannot do without it: the round's state read
  # (the poll reads only NEW reviews' own comments, 600's, and the opening state saw an empty feed —
  # the schedule starts at round 1). The label's two counts add none: nothing re-reads it after.
  # (The bodies are a space because the fixture's `review` defaults an empty body to "findings".)
  assert_eq "$(grep -c -F -x "repos/$REPO/pulls/7/reviews/500/comments?per_page=100" "$REQUEST_LOG" || true)" 1 \
    "the round label adds no read of a review's comments"
  assert_eq "$(grep -c -F -x "repos/$REPO/pulls/7/reviews?per_page=100" "$REQUEST_LOG" || true)" 2 \
    "nor of the reviews feed: the opening state and the round's poll"
)

# The missing-environment answer (ludics-lite#421), as #420 saw it: the connector's first word on
# the head. The first window ends on the comment — it is new activity — but with the state beside
# it saying what it is, and the round count saying it is not one; the next window, already past
# it, exits on the nudge remedy at once instead of holding the grace.
test_the_missing_environment_ends_the_wait_with_the_nudge() {
  local now
  reset_fixture
  now=$(clock_at)
  schedule comments 1 "[$(summary_comment 100 "$now" \
    'To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a new comment is something to act on"
  assert_contains "$WATCH_OUT" "--- summary id=100 commit=-" "the comment is what poll saw"
  assert_contains "$WATCH_ERR" "status: reviewer FAILED at initialization on head ${H2:0:7}" \
    "the state beside it is the failure, not a round"
  assert_contains "$WATCH_ERR" "nudge it once with a '@codex review' comment" "and it names the nudge"
  assert_contains "$WATCH_ERR" \
    "ending the wait on summary id=100 commit=- by ${REVIEWER}[bot] — this window opened no round; rounds with findings: 0 of 12" \
    "the exit line must not number the failure as a round"
  run_watch 0,100,0
  assert_eq "$WATCH_RC" 0 "the failure is a verdict to act on, as a stall is"
  assert_contains "$WATCH_OUT" "reviewer FAILED at initialization on head ${H2:0:7}" \
    "the verdict is on stdout, where the caller reads it"
  assert_contains "$WATCH_OUT" "the environment is the maintainer's to set up" \
    "with the remedy for this failure, not the git-ref one"
  assert_not_contains "$WATCH_OUT" "no review materialized" "and without waiting out the grace"
  # Unattributed — a head commit dated in the future attributes nothing, so the state is
  # `expected` — the comment still ends the first window, and still is not numbered as a round.
  reset_fixture
  HEAD_AT=2099-01-01T00:00:00Z
  schedule comments 1 "[$(summary_comment 100 "$now" \
    'To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).')]"
  run_watch 0,0,0
  assert_contains "$WATCH_ERR" "status: review EXPECTED" "unattributed, the state is the ordinary one"
  assert_contains "$WATCH_ERR" "— this window opened no round; rounds with findings: 0 of 12" \
    "and the count, not the state, decides that no round was opened"
  assert_not_contains "$WATCH_ERR" "— round 0" "never an impossible round zero"
}

# The same reply posted INTO a review thread (ludics-lite#472), as #465 saw it: a thread reply that
# quoted the nudge summoned the connector, which answered in the thread (inline comment 4138519259,
# an empty-bodied COMMENTED review on the head). The window still ends on it, since it is new
# activity about the head, but its line must not number it: #465's said "opened round 5 of 12".
# The control is the same envelope carrying a finding, which does open the next round.
test_the_connector_thread_reply_opens_no_round() {
  local env_body='To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).'
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H1" 2026-09-01T00:00:00Z),$(review 600 "$H2" 2026-09-01T01:00:00Z ' ')]"
  schedule inline 1 "[$(inline_comment 4138519259 "$H2" "$H2" "$env_body" a.sh 3 '' '{"in_reply_to_id":900}')]"
  schedule review_comments 1 "[$(inline_comment 4138519259 "$H2" "$H2" "$env_body" a.sh 3 '' '{"in_reply_to_id":900}')]"
  run_watch 0,0,500
  assert_eq "$WATCH_RC" 0 "the reply is new activity about the head"
  assert_contains "$WATCH_ERR" "— this window opened no round; rounds with findings: 1 of 12" \
    "the connector's thread reply is not numbered as a round"
  assert_contains "$WATCH_OUT" "watch-rounds: from=1 to=1 threshold=12" "nor counted in the trailer"
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H1" 2026-09-01T00:00:00Z),$(review 600 "$H2" 2026-09-01T01:00:00Z ' ')]"
  schedule inline 1 "[$(inline_comment 901 "$H2" "$H2" 'a finding')]"
  schedule review_comments 1 "[$(inline_comment 901 "$H2" "$H2" 'a finding')]"
  run_watch 0,0,500
  assert_contains "$WATCH_ERR" "— this window opened round 2 of 12" "a finding in the envelope is a round"
  assert_contains "$WATCH_OUT" "watch-rounds: from=1 to=2 threshold=12" "and the trailer counts it"
}

# The two silences a log could not tell apart: a window in which the reviewer said nothing about
# anything, and one in which it spoke three times about a head that is no longer the head.
test_the_quiet_exit_names_the_head_and_what_scrolled_past() {
  reset_fixture
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 "nothing at all is a quiet window"
  assert_contains "$WATCH_OUT" "no reviewer activity about head ${H2:0:7} in 1s" \
    "the quiet exit names the head the wait was bound to"
  assert_not_contains "$WATCH_OUT" "scrolled past" "and claims no traffic that did not happen"
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H1" 2026-09-01T00:01:00Z)]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 "an old round scrolling past is still a quiet window"
  assert_contains "$WATCH_OUT" \
    "1 item(s) about another commit scrolled past (last: review id=500 state=COMMENTED commit=${H1:0:7}" \
    "and the exit says so, with the item, so the two silences read differently"
}

# The polling budget (ludics-lite#543): a window whose state does not move backs off from the
# interval toward the review cap, so a quiet 900s window at the 90s interval reads six times, not
# eleven. The last pause is cut to the window's end, so the window's last read is at its end. A subshell case, like the
# others that redefine sleep, so it is listed after the cases that make the snapshot directory in
# the suite's own shell (one made in a subshell outlives it). The sleep is the suite's, to log each
# pause, and it advances the test clock the window is kept on (the shell bridge hands it to the
# Python; SECONDS is what a shell watch kept its window on).
test_an_unmoving_window_backs_off_to_the_review_cap() (
  sleep() {
    printf '%s\n' "$1" >>"$TEST_ROOT/sleeps"
    SECONDS=$((SECONDS + $1))
    [ -z "${SHIP_PR_TEST_CLOCK:-}" ] ||
      printf '%s\n' "$(($(cat "$SHIP_PR_TEST_CLOCK") + $1))" >"$SHIP_PR_TEST_CLOCK"
  }
  reset_fixture
  : >"$TEST_ROOT/sleeps"
  REVIEW_POLL_CAP=300
  run_watch 0,0,0 90 900
  assert_eq "$WATCH_RC" 1 "nothing at all is a quiet window"
  local last
  assert_eq "$(sed -n 1,4p "$TEST_ROOT/sleeps" | tr '\n' ' ')" "90 180 300 300 " \
    "an unchanged state doubles the pause up to the review cap"
  # The cut pause is what is left of the window: 30s, less any real second the case took.
  last=$(sed -n 5p "$TEST_ROOT/sleeps")
  assert_eq "$([ "${last:-0}" -ge 1 ] && [ "$last" -le 30 ] && echo cut)" cut \
    "and the last is cut to the window's end (got '$last')"
  assert_eq "$(poll_rounds)" 7 "six reads in the window, the last at its end, and the settle"
)

# A new head is movement even when the state's token stays put (ludics-lite#551): the pause keys on
# the head and the state's detail, without its age, and goes back to the interval. A subshell case
# for its sleep, like the one above.
test_a_new_head_in_one_state_resets_the_pause() (
  sleep() {
    printf '%s\n' "$1" >>"$TEST_ROOT/sleeps"
    SECONDS=$((SECONDS + $1))
    [ -z "${SHIP_PR_TEST_CLOCK:-}" ] ||
      printf '%s\n' "$(($(cat "$SHIP_PR_TEST_CLOCK") + $1))" >"$SHIP_PR_TEST_CLOCK"
  }
  reset_fixture
  : >"$TEST_ROOT/sleeps"
  REVIEW_POLL_CAP=300
  schedule head 0 "$H2"
  schedule head 3 "$H1"
  run_watch 0,0,0 90 900
  assert_eq "$WATCH_RC" 1 "nothing about either head is a quiet window ($WATCH_ERR)"
  assert_eq "$(sed -n 1,4p "$TEST_ROOT/sleeps" | tr '\n' ' ')" "90 180 90 180 " \
    "the pause doubles while the head stands, and the new head's round is read at the interval"
)

# --- one final poll before any verdict ------------------------------------------------------------

# WATCH_INTERVAL above WATCH_TIMEOUT: the loop polls once and breaks. A round posted in the gap
# between that poll and the report is what the final poll is for — reported quiet, it costs a
# whole re-arm, and the round sits unread meanwhile.
test_a_round_landing_after_the_last_loop_poll_is_still_caught() {
  reset_fixture
  schedule reviews 2 "[$(review 500 "$H2" 2026-09-01T00:01:00Z 'landed in the gap')]"
  run_watch 0,0,0 5 1
  assert_eq "$(poll_rounds)" 2 "the window polls once in the loop and once more at the end"
  assert_eq "$WATCH_RC" 0 "the round the final poll found is acted on, not reported quiet"
  assert_contains "$WATCH_OUT" "--- review id=500" "and it reaches stdout like any other round"
  assert_contains "$WATCH_ERR" "ending the wait on review id=500" "named, like any other"
  # The control: the same window with nothing to find still polls that second time, and still
  # reports quiet — a final poll that only ever fires on a hit would prove nothing here.
  reset_fixture
  run_watch 0,0,0 5 1
  assert_eq "$(poll_rounds)" 2 "the final poll happens whether or not it changes the answer"
  assert_eq "$WATCH_RC" 1 "and an empty one leaves the window quiet"
}

# The same race on the loudest verdict there is: `expected` past its grace tells the caller to
# nudge the reviewer, and a nudge posted over a round that landed seconds earlier re-requests a
# review and CLEARS the 👍 it may be about to get.
test_a_verdict_polls_once_more_before_recommending_a_nudge() {
  reset_fixture
  # GRACE is read when pr-review.sh is sourced, so SHIP_PR_REVIEW_GRACE cannot reach it here and
  # the constant itself is what `retune` moves (run_tests puts it back when the case ends). The
  # grace is one second, so the head is past due on the first round and the loop reaches the
  # verdict this case is about.
  retune GRACE=1
  schedule reviews 2 "[$(review 500 "$H2" 2026-09-01T00:01:00Z 'the round the nudge would have talked over')]"
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 0 "the round wins over the verdict that was about to be printed"
  assert_not_contains "$WATCH_OUT" "no review materialized" \
    "and the nudge is not recommended over a round that has landed"
  assert_contains "$WATCH_OUT" "--- review id=500" "the round is what the caller reads"
  assert_contains "$WATCH_ERR" "status: nothing in flight" \
    "the state beside it is re-read, not the one the dropped verdict was about"
}

test_a_verdict_that_still_stands_names_the_head_it_is_about() {
  reset_fixture
  retune GRACE=1
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 0 "a due round that never started is still something to act on"
  assert_contains "$WATCH_OUT" "no review materialized" "the verdict stands"
  assert_contains "$WATCH_OUT" "no reviewer activity about head ${H2:0:7}" \
    "and it says what it is exiting on"
  assert_contains "$WATCH_OUT" "review EXPECTED but not started" "beside the state itself"
}

# --- a verdict is only ever printed from calls that answered ---------------------------------------

# A final poll that does not answer rules nothing out. Printing the nudge anyway would be a claim
# about the PR made from a call that failed — the one thing this script must never do — and the
# nudge is the move that re-requests a review and CLEARS a standing 👍.
test_a_final_poll_that_did_not_answer_withholds_the_verdict() {
  reset_fixture
  retune GRACE=1
  FAIL_FEEDS_FROM=2 # the loop round answers; the final poll does not
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 3 "an unobserved tail is transport, not a verdict"
  assert_contains "$WATCH_OUT" "the verdict is WITHHELD" "and the line says the verdict was withheld"
  assert_not_contains "$WATCH_OUT" "no review materialized" "the nudge is not recommended"
  assert_contains "$WATCH_OUT" "watermark: " "the watch still ends on a watermark"
  # The control: the same window with a final poll that answers prints the verdict.
  reset_fixture
  retune GRACE=1
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 0 "with the tail observed, the verdict stands"
  assert_contains "$WATCH_OUT" "no review materialized" "and recommends the nudge"
}

# The withheld verdict quotes the final poll's error, which is the last gh call's: here the new
# review's own comments read, after the three feeds answered. While the poll ran in Python and the
# line was printed by the shell (ludics-lite#403), the error had to come back through a file the
# shell read, and a poll that did not hand it back made the line say "did not answer ()"; both are
# Python now, and the line must still carry the error.
test_a_withheld_verdict_quotes_the_final_poll_s_error() {
  reset_fixture
  retune GRACE=1
  schedule reviews 2 "[$(review 800 other-sha 2026-09-01T10:00:00Z)]"
  FAIL_REVIEW_COMMENTS=1
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 3 "an unobserved tail is transport, not a verdict"
  assert_contains "$WATCH_OUT" "the verdict is WITHHELD" "and the line says the verdict was withheld"
  assert_contains "$WATCH_OUT" "did not answer (gh: 503 No server is currently available" \
    "and quotes the final poll's own error"
}

# The 👍 is a REACTION, and cmd_poll reads comments and reviews. An approval landing in the same
# gap the final poll covers is invisible to that poll, so the state is re-read before the verdict
# is printed — or the loop recommends a nudge at a PR that has just been approved, and the
# re-request clears the approval.
test_an_approval_landing_during_the_final_poll_drops_the_verdict() {
  reset_fixture
  retune GRACE=1
  # Round 1 holds the due verdict for the pickup margin (min(PICKUP, GRACE): a second), round 2
  # reaches it, and round 3 is its final poll.
  schedule reactions 3 "[$(head_thumb)]"
  run_watch 0,0,0 5 1
  assert_eq "$(nudges_posted)" 0 "no nudge is posted over the 👍"
  assert_eq "$WATCH_RC" 0 "an approved PR is something to act on"
  assert_contains "$WATCH_OUT" "the 👍 landed while it was being read" "and the line says why"
  assert_contains "$WATCH_OUT" "approved (👍 from" "the approval is what the caller reads"
  assert_not_contains "$WATCH_OUT" "no review materialized" \
    "the nudge that would have cleared it is not recommended"
}

# Any other move of the state falsifies the verdict too, and the honest report is a quiet window:
# a round announcing itself (👀) between the poll and the print is not "no review is coming".
test_a_state_that_moved_drops_the_verdict_as_quiet() {
  reset_fixture
  retune GRACE=1
  # Round 3 is the verdict's final poll (the pickup margin holds round 1).
  schedule reactions 3 "[$(reaction eyes "$(clock_at -5)")]"
  run_watch 0,0,0 5 1
  assert_eq "$(nudges_posted)" 0 "no nudge is posted over the new round"
  assert_eq "$WATCH_RC" 1 "a round that just started is a quiet window, not a verdict"
  assert_contains "$WATCH_OUT" "the state moved to 'reviewing'" "and the line says what it moved to"
  assert_not_contains "$WATCH_OUT" "no review materialized" "no nudge over a round in flight"
}

# A state that cannot be re-read is not a state either: the verdict is withheld, exit 3.
test_a_state_that_could_not_be_re_read_withholds_the_verdict() {
  reset_fixture
  retune GRACE=1
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 0 "the control: with everything readable the verdict stands"
  # The PR read fails from the final poll on, so the loop reads its state and reaches the verdict
  # while the re-read behind it lands in `unknown`.
  reset_fixture
  retune GRACE=1
  FAIL_PULLS_FROM=3 # the verdict's final poll (the pickup margin holds round 1)
  run_watch 0,0,0 5 1
  assert_eq "$(nudges_posted)" 0 "nothing is posted on a state that did not read"
  assert_eq "$WATCH_RC" 3 "an unreadable state is not 'the reviewer stayed quiet'"
  assert_contains "$WATCH_OUT" "is WITHHELD" "and the verdict is withheld"
}

# --- a body is not an item -------------------------------------------------------------------------

# The reviewer quotes this script in its findings, output included. A body line that looks exactly
# like a rendered item header must not be classified as an item: read as one it carries no
# `commit=`, which counts as "about the head", and the watch would end on the very round it was
# skipping. So the classification reads the machine-readable `items:` line poll emits, never the
# rendering.
test_a_body_that_quotes_an_item_header_is_not_an_item() {
  reset_fixture
  local quoted
  quoted=$(printf 'Round 1, on the watch loop: the rendering below is a body, not a round.\n\n%s\n%s\n' \
    "--- review id=999 state=COMMENTED commit=${H2:0:7} by ${REVIEWER}[bot]" \
    "--- inline id=998 a.sh:1 commit=${H2:0:7} by ${REVIEWER}[bot]")
  schedule reviews 1 "[$(review 500 "$H1" 2026-09-01T00:01:00Z "$quoted")]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 \
    "a previous head's round that quotes item headers is still a previous head's round"
  assert_contains "$WATCH_ERR" "1 item(s) NOT about head" "exactly one item, the review itself"
  # Not a vacuous case: the header-shaped lines really are in what poll rendered, and the old
  # classification scanned exactly those lines.
  assert_contains "$WATCH_ERR" "--- review id=999 state=COMMENTED" \
    "the quoted header is in the rendering, where a scan would have found it"
  assert_not_contains "$WATCH_ERR" "id=999 commit=" \
    "but it is not an item: the index poll emits carries only the three real ones"
  # The control: the same quoted body on a round about THIS head still ends the wait, so the
  # refusal above is about the classification and not about the quoting.
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z "$quoted")]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a round about this head ends the wait, quoted headers and all"
}

# The connector writes its "Reviewed commit:" stamp as a FOOTER, and a findings body can mention
# another commit above it — a review of this very parsing does. Taking the first match would stamp
# the round with a commit it merely mentions and discard it as an old head: a round lost in
# silence, which is worse than a false wake.
test_a_summary_is_stamped_by_its_footer_not_by_what_it_mentions() {
  reset_fixture
  schedule comments 1 "[$(summary_comment 700 2026-09-01T00:01:00Z \
    "$(printf 'Codex Review: the stamp reader takes the first match, so a body saying\n\n**Reviewed commit:** `%s`\n\nabove its own footer is misread.\n\n**Reviewed commit:** `%s`\n' \
      "${H1:0:7}" "${H2:0:7}")")]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the footer names this head, so the summary is this head's round"
  assert_contains "$WATCH_OUT" "--- summary id=700 commit=${H2:0:7}" "and it is stamped with the footer"
  # The control: with the footer naming the OTHER head, the same body is a previous round.
  reset_fixture
  schedule comments 1 "[$(summary_comment 700 2026-09-01T00:01:00Z \
    "$(printf 'Codex Review: mentions\n\n**Reviewed commit:** `%s`\n\nand ends with\n\n**Reviewed commit:** `%s`\n' \
      "${H2:0:7}" "${H1:0:7}")")]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 "the last stamp decides, whichever head it names"
}

# --- the clock a due review is late against -------------------------------------------------------

# The report this issue was filed on: a PR opened seconds ago whose head commit was written 40
# minutes earlier read "due for 40m" and recommended a nudge. The committer date cannot bound the
# wait from underneath — a force-push to an older commit, or a first push of a morning's work,
# dates the head long before the push — and the PR's own creation can: nothing about a PR is due
# before the PR exists.
test_the_review_clock_starts_no_earlier_than_the_pr() {
  reset_fixture
  HEAD_AT=$(clock_at -2400)
  PR_CREATED_AT=$(clock_at -30)
  run_status
  assert_eq "$(state_tok "$STATE")" expected "an unreviewed head with no 👀 is expected"
  local age
  age=$(state_age "$STATE")
  [ "$age" -lt 120 ] ||
    bail "the clock should start at the PR's creation, not the commit's date (age ${age}s)"
  assert_contains "$LINE" "due for " "the line still says how late the review is"
  # The negative control on the same fixture: with the PR itself old, the committer date is the
  # newer bound and the clock runs from it — the floor must not become the answer.
  PR_CREATED_AT=$(clock_at -86400)
  run_status
  age=$(state_age "$STATE")
  [ "$age" -ge 2400 ] && [ "$age" -lt 3000 ] ||
    bail "with an old PR the head's committer date is the clock (age ${age}s)"
}

# Each clock is validated on its own before the freshest wins: a committer date in the future
# (clock skew, or an explicit GIT_COMMITTER_DATE) is the newest timestamp there is and has no
# age at all, so taking it would leave the state with no clock and the grace unable to expire.
test_a_future_commit_date_does_not_blind_the_clock() {
  reset_fixture
  HEAD_AT=$(clock_at 3600)
  PR_CREATED_AT=$(clock_at -1800)
  run_status
  assert_eq "$(state_tok "$STATE")" expected "still a due review"
  local age
  age=$(state_age "$STATE")
  case "$age" in '' | *[!0-9]*) bail "a future commit date left the state with no clock ($age)" ;; esac
  [ "$age" -ge 1700 ] && [ "$age" -lt 2100 ] ||
    bail "the usable clock is the PR's creation (age ${age}s)"
}

# A PR read that fails costs the floor, not the state: the reviewer's own timestamps remain, and
# a state with no clock at all is what freshest_age exists to avoid.
test_a_clockless_expected_state_says_so_rather_than_guessing() {
  reset_fixture
  HEAD_AT=""
  PR_CREATED_AT=""
  run_status
  assert_eq "$(state_tok "$STATE")" expected "the state does not need a clock to be read"
  assert_eq "$(state_age "$STATE")" - "with nothing datable, the age is '-', never 0"
  assert_contains "$LINE" "due for an unknown time" "and the line says so rather than '0s'"
}

# --- duplicated inline threads ----------------------------------------------------------------

# Round 11 of ludics-lite#66 posted nine inline threads for four findings: the reviewer had
# duplicated several verbatim, and each duplicate cost its own composed reply and its own resolve.
# Identical here means identical in everything the entry shows — path, line, body, commit stamp and
# author — so the folded entry prints exactly what each of its members would have printed, once,
# under an id that lists them all.
test_identical_inline_threads_fold_into_one_entry() {
  reset_fixture
  local dup="the same finding, posted three times"
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$dup"),$(inline_comment 901 "$H2" "$H2" "$dup"),$(inline_comment 902 "$H2" "$H2" "$dup")]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "a duplicated finding is still a round to act on"
  assert_contains "$WATCH_OUT" "--- inline id=900+901+902 a.sh:3 commit=${H2:0:7}" \
    "the three threads render as one entry naming every id, anchor first"
  assert_contains "$WATCH_OUT" "(3 identical threads, one reply answers all)" \
    "and the entry says why it carries three ids"
  assert_eq "$(occurrences "$WATCH_OUT" "$dup")" 1 \
    "the body is printed once: a fold that still printed it three times saves the caller nothing"
  assert_contains "$WATCH_OUT" "items: inline:900+901+902:${H2:0:7}:${REVIEWER}[bot]:-" \
    "the machine index folds with the rendering, and keeps its five fields"
  assert_contains "$WATCH_ERR" "ending the wait on inline id=900+901+902 commit=${H2:0:7}" \
    "the exit names the whole list, so it can be handed straight to reply"
  assert_not_contains "$WATCH_ERR" "more about this head" \
    "one finding is one item: the fold must not read as several"
  assert_contains "$WATCH_OUT" "watermark: 902,0,0" \
    "every duplicate's id is still advanced past — the watermark reads the unfolded feed"
}

# What folds is a PLACE, not a text — the measured difference between a fold that fires and one
# that never does. On the round the issue was filed on (#66 head 252e336), grouping by body finds
# ZERO groups among 51 findings while grouping by the anchor finds four covering nine threads: the
# reviewer duplicates a finding by RE-WRITING it, and the three threads at one line there carry
# bodies of 546, 575 and 570 characters saying the same thing. So two threads at one anchor fold
# whatever their text, and the entry prints EVERY distinct body under the id of its own thread —
# which is what keeps that safe: the caller sees every word the reviewer wrote and answers once.
test_threads_at_one_anchor_fold_with_every_body_shown() {
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'the first finding'),$(inline_comment 901 "$H2" "$H2" 'the second finding')]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the round is acted on"
  assert_contains "$WATCH_OUT" "--- inline id=900+901 a.sh:3" \
    "one place is one entry and one reply, whatever the two texts say"
  assert_contains "$WATCH_OUT" "(2 threads at one location, 2 findings as written" \
    "and the note says there are two of them to answer"
  assert_contains "$WATCH_OUT" "[thread 900]" "each body is filed under its own thread id"
  assert_contains "$WATCH_OUT" "the first finding" "the first body is printed"
  assert_contains "$WATCH_OUT" "[thread 901]" "including the second thread's"
  assert_contains "$WATCH_OUT" "the second finding" "and the second body: nothing is dropped"
  assert_not_contains "$WATCH_OUT" "identical threads" \
    "they are not identical, and the note must not say so"
  # Identical bodies keep the shorter rendering: a repeat is printed once.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'one finding, twice'),$(inline_comment 901 "$H2" "$H2" 'one finding, twice')]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "(2 identical threads, one reply answers all)" \
    "an exact repeat is reported as one"
  assert_eq "$(occurrences "$WATCH_OUT" "one finding, twice")" 1 "and printed once"
  assert_not_contains "$WATCH_OUT" "[thread 900]" "with no per-thread labelling to read past"
}

# The negative control the fold's whole claim rests on: a different PLACE must stay a different
# entry. Without this the fold could be collapsing unrelated findings and every other case here
# would still pass.
test_threads_at_different_places_are_not_folded() {
  # Same body, different LINE.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'a finding' a.sh 3),$(inline_comment 901 "$H2" "$H2" 'a finding' a.sh 9)]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:3" "one line"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:9" "and another are two places to fix"
  # Same body and line, different PATH.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'a finding' a.sh 3),$(inline_comment 901 "$H2" "$H2" 'a finding' b.sh 3)]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:3" "one file"
  assert_contains "$WATCH_OUT" "--- inline id=901 b.sh:3" "and another, likewise"
}

# The key is a deny-list: the whole row minus the fields that MUST differ between two posts of one
# finding. So a location field nobody enumerated — `side` on a LEFT-vs-RIGHT anchor, a multi-line
# `start_line`, or one GitHub has yet to invent — keeps two threads apart on its own, and the
# failure mode of an unknown field is an extra reply rather than a lost finding.
test_an_unrecognized_field_keeps_two_threads_apart() {
  reset_fixture
  local same="the same text at two anchors"
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"side":"LEFT"}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"side":"RIGHT"}')]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT" "id=900+901" "a deletion and an addition at one line separate"
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"start_line":1}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"start_line":3}')]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT" "id=900+901" "and so does a multi-line range"
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"an_anchor_github_has_yet_to_invent":"a"}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"an_anchor_github_has_yet_to_invent":"b"}')]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT" "id=900+901" \
    "a field this script has never heard of is identifying by default"
  # The control the deny-list rests on: two threads differing ONLY in the fields that must differ
  # between two posts of one finding still fold — or the fold would never fire on a real pair.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"node_id":"A","url":"u/900","html_url":"h/900","pull_request_url":"p","pull_request_review_id":11,"created_at":"2026-09-01T00:00:01Z","updated_at":"2026-09-01T00:00:01Z","reactions":{"url":"r/900"},"_links":{"self":{"href":"s/900"}}}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"node_id":"B","url":"u/901","html_url":"h/901","pull_request_url":"p","pull_request_review_id":12,"created_at":"2026-09-01T00:00:02Z","updated_at":"2026-09-01T00:00:02Z","reactions":{"url":"r/901"},"_links":{"self":{"href":"s/901"}}}')]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "--- inline id=900+901 a.sh:3" \
    "ids, urls, timestamps, reactions, links and the per-comment review id are not the finding"
  assert_contains "$WATCH_OUT" "(2 identical threads" "and the pair is one finding"
}

# The loud half of that same key (#113). Every field above keeps two rows apart, and until this
# case the header named none of them: a deletion commented on the LEFT and an addition on the
# RIGHT at line 3 of one file printed two headers byte-identical apart from the id, and correctly
# did NOT fold. What the reader sees is the reviewer posting one finding twice and the fold
# failing to catch it, with nothing on the page to say otherwise — the mirror of the `:0` defect
# of #105, where two places looked like one. So each anchor field the row carries is on the line,
# in the `k=v` grammar the rest of the header already speaks, and the oracle is the whole header
# rather than the presence of a token: two unfolded entries must read as two places.
test_the_anchor_fields_that_keep_two_rows_apart_are_on_the_line() {
  local same="the same text at two anchors"
  # A deletion and an addition at one line. RIGHT is where every other row is and prints nothing.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"side":"LEFT"}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"side":"RIGHT"}')]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT" "id=900+901" "two sides are two findings, as the key already had it"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:3 side=LEFT commit=${H2:0:7}" \
    "the one on the deletion side says so"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:3 commit=${H2:0:7}" \
    "and the default side prints nothing: RIGHT on every row would be noise"
  assert_eq "$(distinct_inline_headers "$WATCH_OUT")" 2 \
    "two entries the fold kept apart read as two places, the id aside"
  # A multi-line anchor and a single line at its end: two places, two renderings.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"start_line":1,"start_side":"RIGHT","side":"RIGHT"}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"side":"RIGHT"}')]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT" "id=900+901" "a range and a line are two findings"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:1-3 commit=${H2:0:7}" \
    "a multi-line anchor renders the range it covers"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:3 commit=${H2:0:7}" \
    "and the line at its end is its own place"
  assert_eq "$(distinct_inline_headers "$WATCH_OUT")" 2 "so the two entries read as two"
  # A range whose ends are on different sides. The end's side is the default and says nothing, so
  # the start's is named: `start_side` prints exactly when it differs from the side of the end.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"start_line":1,"start_side":"LEFT","side":"RIGHT"}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"start_line":1,"start_side":"LEFT","side":"LEFT"}')]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:1-3 start_side=LEFT commit=${H2:0:7}" \
    "a range from the deletion side to the addition side names the end that is not the default"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:1-3 side=LEFT commit=${H2:0:7}" \
    "and a range wholly on the deletion side names it once"
  assert_eq "$(distinct_inline_headers "$WATCH_OUT")" 2 "which is what keeps the two apart"
  # An anchor that has MOVED since it was written: GitHub migrates `line`/`start_line` forward as
  # the branch advances while the `original_*` pair stays where the reviewer wrote it, and the
  # key holds both — so two findings written at different places can sit at one place today.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 40 34 '{"start_line":36,"original_start_line":30}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 40 34 '{"start_line":36,"original_start_line":32}')]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT" "id=900+901" "two anchors as written are two findings"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:36-40 was=30-34 commit=${H2:0:7}" \
    "where the finding sits now, and where it was written"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:36-40 was=32-34 commit=${H2:0:7}" \
    "which is the only thing telling this one from the last"
  assert_eq "$(distinct_inline_headers "$WATCH_OUT")" 2 "two places, however alike they sit today"
  # A positional row migrates too, in the unit it has: the per-review endpoint serves no line at
  # all, and `position`/`original_position` are both in the key, so two rows at one current
  # position written at different ones are two findings (review of #272, round 1).
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z)]"
  schedule review_comments 1 "[$(positional_comment 900 "$H2" "$same" 12 5),$(positional_comment 901 "$H2" "$same" 12 9)]"
  run_watch 0,0,0
  assert_not_contains "$WATCH_OUT" "id=900+901" "two original positions are two findings"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:@12 was=@5 commit=${H2:0:7}" \
    "a position that has moved prints the one it was written at"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:@12 was=@9 commit=${H2:0:7}" \
    "which is the only thing telling these two apart"
  assert_eq "$(distinct_inline_headers "$WATCH_OUT")" 2 "so they read as the two places they are"
  # And a row that has NOT moved prints no token at all, in either unit: `was=` on every row
  # would be the `side=RIGHT` noise one column over.
  reset_fixture
  schedule reviews 1 "[$(review 500 "$H2" 2026-09-01T00:01:00Z)]"
  schedule review_comments 1 "[$(positional_comment 900 "$H2" "$same" 12)]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:@12 commit=${H2:0:7}" \
    "an unmigrated position is the position, and nothing else"
  assert_not_contains "$WATCH_OUT" "was=" "with no token for a move that did not happen"
  # And the control the whole rendering rests on: rows agreeing on every anchor field still fold,
  # and the folded entry prints that anchor once. Without it these cases would pass on a header
  # that had simply started printing the id of every thread separately.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$same" a.sh 3 '' '{"start_line":1,"start_side":"LEFT","side":"LEFT"}'),$(inline_comment 901 "$H2" "$H2" "$same" a.sh 3 '' '{"start_line":1,"start_side":"LEFT","side":"LEFT"}')]"
  run_watch 0,0,0
  assert_contains "$WATCH_OUT" "--- inline id=900+901 a.sh:1-3 side=LEFT commit=${H2:0:7}" \
    "one anchor in every field is one finding and one reply"
  assert_eq "$(distinct_inline_headers "$WATCH_OUT")" 1 "and one place on the page"
  assert_eq "$(occurrences "$WATCH_OUT" "$same")" 1 "with the body printed once"
}

# The commit stamp is in the fold key because it is what `watch` classifies an item BY: folding a
# finding written against the previous head into one written against this head would force a
# single verdict onto two different head associations — and here it would drag a stale finding
# onto stdout as part of this head's round.
test_the_same_body_against_two_heads_is_not_folded() {
  reset_fixture
  local same="a finding the reviewer repeated after the push"
  schedule inline 1 "[$(inline_comment 900 "$H1" "$H2" "$same"),$(inline_comment 901 "$H2" "$H2" "$same")]"
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the finding about this head ends the wait"
  assert_contains "$WATCH_OUT" "--- inline id=901 a.sh:3 commit=${H2:0:7}" \
    "this head's copy is what the caller acts on"
  assert_not_contains "$WATCH_OUT" "id=900+901" \
    "and the previous head's copy is not folded into it"
  assert_contains "$WATCH_ERR" "(+1 about another commit, below)" \
    "it stays a separate item, classified by its own stamp"
  assert_contains "$WATCH_OUT" "--- inline id=900 a.sh:3 commit=${H1:0:7}" \
    "and is rendered under the stamp it was written against, not this head's"
}

# A nudge buys one observer window, identified by its comment id. Carrying the
# returned watermark into the next window must not buy that same grace again.
#
# The cases from here on run on the fixture clock (see the top of the file) with an interval of a
# whole GRACE where a sleep used to jump the clock by one: each pause then spends the grace in one
# step, as the stubbed sleep did, and the extension caps a pause at what is left of it.
test_a_nudge_buys_exactly_one_window() {
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  local now mark
  now=$(clock_at)
  schedule comments 1 "$(jq -cn --arg at "$now" '{id:700,user:{login:"maintainer"},created_at:$at,
    body:"@codex review\n\n_🤖 Addressed by an automated coding agent_"}' | jq -s '.')"
  run_watch 0,699,0 "$GRACE" 0
  assert_eq "$WATCH_RC" 0 "a fresh nudge is observed until its grace expires"
  assert_contains "$WATCH_ERR" "extending watch" "the nudge owns the full grace beyond timeout"
  [ "$(poll_rounds)" -ge 3 ] || bail "the nudge verdict returned on the first poll"
  mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
  assert_eq "$mark" 0,700,0 "the nudge identity is consumed by the outgoing watermark"
  run_watch "$mark" "$GRACE" 0
  assert_eq "$WATCH_RC" 0 "the next window cannot renew the same nudge"
  assert_contains "$WATCH_OUT" "no review materialized" "the overdue verdict remains available"
}

# The advice path's clock (`--no-nudge`): with the default, a quoted summon is a request the
# connector answers, and its grace holds the automatic nudge (test_a_standing_request_holds_the_nudge).
test_an_ordinary_reply_or_old_nudge_does_not_reset_grace() {
  local body
  for body in 'Thanks, @codex review was requested earlier' '@codex review'; do
    reset_fixture
    WATCH_FLAG=--no-nudge
    HEAD_AT=2026-09-01T00:00:00Z
    PR_CREATED_AT="$HEAD_AT"
    local at
    at=$(clock_at)
    [ "$body" != '@codex review' ] || at="$HEAD_AT"
    schedule comments 1 "$(jq -cn --arg at "$at" --arg body "$body"       '[{id:700,user:{login:"maintainer"},created_at:$at,body:$body}]')"
    run_watch 0,699,0 1 0
    assert_eq "$WATCH_RC" 0 "an ordinary reply or expired nudge grants no grace"
    assert_contains "$WATCH_OUT" "no review materialized" "the old PR clock still expires"
  done
}

test_a_live_round_extends_the_quiet_window() {
  reset_fixture
  local now
  now=$(clock_at)
  schedule reactions 1 "[$(reaction eyes "$now")]"
  # With timeout zero, the old loop settled at round 2 and missed round 3.
  schedule reviews 3 "[$(review 501 "$H2" "$now")]"
  run_watch 0,0,0 1 0
  assert_eq "$WATCH_RC" 0 "the in-flight round is observed beyond the quiet deadline"
  assert_contains "$WATCH_OUT" '--- review id=501' "the eventual round ends the wait"
  assert_contains "$WATCH_ERR" 'extending watch' "the extension is explicit"
}

# Neither slow setup nor scheduler delays can spend the five-second extension before it starts:
# the fixture clock moves only when the watch sleeps.
test_a_live_round_extension_is_bounded() {
  reset_fixture
  retune GRACE=5
  local now
  now=$(clock_at)
  schedule reactions 1 "[$(reaction eyes "$now")]"
  run_watch 0,0,0 1 0
  assert_eq "$WATCH_RC" 1 "a round with no result cannot extend forever"
  assert_contains "$WATCH_OUT" 'no reviewer activity' "the exhausted extension returns quiet"
  assert_contains "$WATCH_ERR" 'extending watch' "the ordinary window was extended first"
  assert_not_contains "$WATCH_OUT" 'in 0s' "the verdict reports the extended elapsed duration"
}

test_nudges_wait_past_old_failed_and_stalled_states() {
  local kind old now comments
  old=2026-09-01T00:00:00Z
  for kind in failed stalled; do
    reset_fixture
    HEAD_AT="$old"
    PR_CREATED_AT="$old"
    now=$(clock_at)
    comments=$(jq -cn --arg at "$now"       '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')
    if [ "$kind" = stalled ]; then
      schedule reactions 1 "[$(reaction eyes "$old")]"
    else
      local body
      body=$(printf 'Codex Review: Something went wrong. Try again later by commenting “@codex review”.\n```\nProvided git ref %s does not exist\n```' "$H2")
      comments=$(jq -cn --argjson n "$comments" --argjson f "$(summary_comment 699 "$old" "$body")" '$n + [$f]')
    fi
    schedule comments 1 "$comments"
    run_watch 0,699,0 "$GRACE" 0
    assert_eq "$WATCH_RC" 0 "fresh nudge waits until its grace expires before $kind"
    [ "$(poll_rounds)" -ge 3 ] || bail "the $kind verdict returned before the nudge grace"
    assert_contains "$WATCH_ERR" 'fresh review nudge' "the nudge explains the new wait"
    run_watch 0,700,0 "$GRACE" 0
    assert_eq "$WATCH_RC" 0 "the same nudge cannot suppress $kind for another window"
  done
}

test_an_extension_holds_through_unknown_status() {
  reset_fixture
  # Preserve actual feed/status parsing, failing only the status read at round 2.
  FAIL_REACTIONS_ROUND=2
  local now
  now=$(clock_at)
  schedule reactions 1 "[$(reaction eyes "$now")]"
  # Before the fix, unknown round 2 broke out and settled at round 3, missing 4.
  schedule reviews 4 "[$(review 501 "$H2" "$now")]"
  run_watch 0,0,0 1 0
  assert_eq "$WATCH_RC" 0 "a transient status outage cannot cut short the frozen extension"
  assert_contains "$WATCH_OUT" '--- review id=501' "the later round is caught"
  assert_contains "$WATCH_ERR" "holding 'reviewing'" "the unknown status held the known live state"
}

test_an_unknown_boundary_uses_the_last_live_deadline() {
  reset_fixture
  FAIL_REACTIONS_ROUND=2
  local now
  now=$(clock_at)
  schedule reactions 1 "[$(reaction eyes "$now")]"
  schedule reviews 4 "[$(review 501 "$H2" "$now")]"
  run_watch 0,0,0 100 100
  assert_eq "$WATCH_RC" 0 "the first boundary outage keeps the cached live deadline"
  assert_contains "$WATCH_OUT" '--- review id=501' "the later round is still observed"
  assert_contains "$WATCH_ERR" "holding 'reviewing'" "the boundary actually read unknown"
}

test_a_late_review_gets_its_own_grace_after_the_nudge() {
  reset_fixture
  retune GRACE=1000
  local fresh_at review_at
  fresh_at=$(clock_at)
  review_at=$(clock_at 900)
  schedule comments 1 "$(jq -cn --arg at "$fresh_at"     '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')"
  schedule reactions 2 "[$(reaction eyes "$review_at")]"
  # Without handoff, the nudge deadline stops at round 3 and settles at 4.
  schedule reviews 5 "[$(review 501 "$H2" "$review_at")]"
  run_watch 0,699,0 900 0
  assert_eq "$WATCH_RC" 0 "the late-started review owns a full eyes-start grace"
  assert_contains "$WATCH_OUT" '--- review id=501' "the review outlives the nudge pickup deadline"
  assert_contains "$WATCH_ERR" 'handing off' "the phase transition is explicit"
  assert_eq "$(occurrences "$WATCH_ERR" 'handing off')" 1 "later eyes observations cannot renew it"
}

test_a_final_poll_leaves_an_unarmed_nudge_pending() {
  local fresh_at kind mark
  for kind in quiet overdue; do
    reset_fixture
    fresh_at=$(clock_at)
    if [ "$kind" = overdue ]; then
      HEAD_AT=2026-09-01T00:00:00Z
      PR_CREATED_AT="$HEAD_AT"
    fi
    schedule comments 2 "$(jq -cn --arg at "$fresh_at"       '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')"
    run_watch 0,0,0 "$GRACE" 0
    assert_eq "$WATCH_RC" 1 "the $kind final poll discovers a nudge it has not observed through grace"
    mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
    assert_eq "$mark" 0,0,0 "the $kind exit must leave the final nudge unconsumed"
    run_watch "$mark" "$GRACE" 0
    assert_contains "$WATCH_ERR" 'extending watch' "the next watch grants the pending nudge its full grace"
  done
}

test_a_fresh_nudge_supersedes_old_same_head_results() {
  local fresh_at kind old comments
  old=2026-09-01T00:00:00Z
  for kind in idle verdict thumb; do
    reset_fixture
    fresh_at=$(clock_at)
    comments=$(jq -cn --arg at "$fresh_at"       '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')
    case "$kind" in
    idle) schedule reviews 1 "[$(review 599 "$H2" "$old")]" ;;
    verdict) comments=$(jq -cn --argjson n "$comments" --argjson v "$(stamped_summary 699 "$old" "$H2" "Codex Review: Didn't find any major issues.")" '$n + [$v]') ;;
    thumb) schedule reactions 1 "[$(reaction +1 "$old")]" ;;
    esac
    schedule comments 1 "$comments"
    run_watch 0,699,599 "$GRACE" 0
    assert_contains "$WATCH_ERR" 'extending watch' "a fresh request supersedes the older $kind result"
    assert_not_contains "$WATCH_OUT" 'approved' "the older $kind cannot approve the requested round"
  done
  # A demonstrably newer approval still wins immediately.
  reset_fixture
  fresh_at=$(clock_at)
  schedule comments 1 "$(jq -cn --arg at "$fresh_at"     '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')"
  schedule reactions 1 "[$(reaction +1 "$(clock_at 1)")]"
  run_watch 0,699,599 "$GRACE" 0
  assert_contains "$WATCH_OUT" 'approved' "a later thumbs-up approves the new round"
}

test_unreadable_status_cannot_consume_a_loop_nudge() {
  reset_fixture
  local fresh_at mark
  FAIL_REACTIONS=1
  fresh_at=$(clock_at)
  schedule comments 1 "$(jq -cn --arg at "$fresh_at"     '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')"
  run_watch 0,0,0 "$GRACE" 0
  mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
  assert_eq "$mark" 0,0,0 "no healthy status read ever armed this nudge"
  FAIL_REACTIONS=""
  run_watch "$mark" "$GRACE" 0
  assert_contains "$WATCH_ERR" 'extending watch' "the recovered observer grants the still-pending nudge grace"
}

test_one_empty_reaction_read_retains_the_live_boundary() {
  reset_fixture
  local now
  now=$(clock_at)
  schedule reactions 1 "[$(reaction eyes "$now")]"
  schedule reactions 2 '[]'
  schedule reactions 3 "[$(reaction eyes "$now")]"
  schedule reviews 4 "[$(review 501 "$H2" "$now")]"
  run_watch 0,0,0 100 100
  assert_eq "$WATCH_RC" 0 "one empty reaction read cannot terminate a held live deadline"
  assert_contains "$WATCH_OUT" '--- review id=501' "the returning live round remains observed"
}

test_a_pre_push_nudge_keeps_the_fresher_head_clock() {
  reset_fixture
  HEAD_AT=$(clock_at)
  PR_CREATED_AT=2026-09-01T00:00:00Z
  schedule comments 1 '[{"id":700,"user":{"login":"maintainer"},"created_at":"2026-09-01T00:00:00Z","body":"@codex review"}]'
  run_watch 0,699,0 "$GRACE" 0
  assert_contains "$WATCH_ERR" 'extending watch' "the old request cannot shorten a fresh head clock"
  [ "$(poll_rounds)" -ge 3 ] || bail "the fresh head received no observation window"
}

# The issue-comment field of a watermark.
mark_issue() { # <watermark>
  cut -d, -f2 <<<"$1"
}

test_old_unseen_findings_leave_the_new_request_pending() {
  local fresh_at kind comments mark
  for kind in review summary inline; do
    reset_fixture
    fresh_at=$(clock_at)
    comments=$(jq -cn --arg at "$fresh_at"       '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')
    case "$kind" in
    review) schedule reviews 1 "[$(review 599 "$H2" 2026-09-01T00:00:00Z 'still actionable old finding')]" ;;
    summary) comments=$(jq -cn --argjson n "$comments" --argjson r "$(stamped_summary 699 2026-09-01T00:00:00Z "$H2" 'still actionable old finding')" '$n + [$r]') ;;
    inline) schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'still actionable old finding')]" ;;
    esac
    schedule comments 1 "$comments"
    run_watch 0,0,0 "$GRACE" 0
    assert_eq "$WATCH_RC" 0 "old $kind findings are still actionable"
    assert_contains "$WATCH_OUT" 'still actionable old finding' "the finding must not be filtered away"
    mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
    assert_eq "$(mark_issue "$mark")" 699 "the new request remains pending after the old $kind result"
    run_watch "$mark" "$GRACE" 0
    assert_contains "$WATCH_ERR" 'extending watch' "the next observer grants the pending request grace"
    assert_not_contains "$WATCH_OUT" 'still actionable old finding' "the old $kind is not replayed"
  done
}

# The opening state is the one healthy read: the reactions answer before the first poll (round 0)
# and from then on do not, and the nudge is in the comments from round 0.
test_initial_grace_cannot_renew_indefinitely_after_unknown_reads() {
  reset_fixture
  local fresh_at mark nudge
  FAIL_REACTIONS_FROM=1
  fresh_at=$(clock_at)
  nudge=$(jq -cn --arg at "$fresh_at"     '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')
  schedule comments 0 "$nudge"
  schedule comments 1 "$nudge"
  # Keep the head older too, so recovery cannot inherit an unrelated fresh-head clock.
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  run_watch 0,0,0 "$GRACE" 0
  assert_contains "$WATCH_ERR" 'from: review EXPECTED but not started — fresh review nudge' \
    "the opening read is the healthy one, and it reads the nudge"
  assert_contains "$WATCH_ERR" 'extending watch' "initial healthy status grants the creation-time grace"
  mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
  FAIL_REACTIONS_FROM=0
  run_watch "$mark" "$GRACE" 0
  assert_not_contains "$WATCH_ERR" 'extending watch' "the creation-time clock cannot restart on recovery"
  assert_contains "$WATCH_OUT" 'no review materialized' "recovery returns a due verdict, not another full window"
}

test_a_second_nudge_at_settle_remains_pending() {
  reset_fixture
  local fresh_at mark
  fresh_at=$(clock_at)
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  schedule comments 1 '[{"id":700,"user":{"login":"maintainer"},"created_at":"2026-09-01T00:00:00Z","body":"@codex review"}]'
  schedule comments 2 "$(jq -cn --arg at "$fresh_at" '[{id:700,user:{login:"maintainer"},created_at:"2026-09-01T00:00:00Z",body:"@codex review"},{id:701,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')"
  run_watch 0,699,0 "$GRACE" 0
  assert_contains "$WATCH_OUT" 'a newer nudge still needs its grace' "same state token does not mean same request"
  assert_not_contains "$WATCH_OUT" 'no review materialized' "the older expired verdict is dropped"
  mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
  assert_eq "$(mark_issue "$mark")" 700 "the second request remains pending"
  run_watch "$mark" "$GRACE" 0
  assert_contains "$WATCH_ERR" 'extending watch' "the recovered observer grants the second request its grace"
}

test_an_actionable_result_with_unknown_status_keeps_pending_comments() {
  reset_fixture
  local fresh_at mark
  FAIL_REACTIONS_ROUND=1
  fresh_at=$(clock_at)
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  schedule reviews 1 "[$(review 599 "$H2" 2026-09-01T00:00:00Z 'actionable during status outage')]"
  schedule comments 1 "$(jq -cn --arg at "$fresh_at" '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')"
  run_watch 0,699,0 "$GRACE" 0
  assert_contains "$WATCH_OUT" 'actionable during status outage' "the readable review is surfaced"
  mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
  assert_eq "$mark" 0,699,599 "only the unverified issue cursor is retained"
  FAIL_REACTIONS_ROUND=""
  run_watch "$mark" "$GRACE" 0
  assert_contains "$WATCH_ERR" 'extending watch' "the fresh request receives grace on recovery"
  assert_not_contains "$WATCH_OUT" 'actionable during status outage' "the consumed review is not replayed"
}

# The second request lands 100s into the first one's grace (on round 2, one 100s pause in), and
# for `reviewing` a round starts on it at the same instant.
test_a_new_request_during_fixed_grace_remains_pending() {
  local kind fresh_at review_at mark comments second_nudge
  for kind in nudged reviewing; do
    reset_fixture
    retune GRACE=200
    fresh_at=$(clock_at -5)
    review_at=$(clock_at 100)
    HEAD_AT=2026-09-01T00:00:00Z
    PR_CREATED_AT="$HEAD_AT"
    comments=$(jq -cn --arg at "$fresh_at" '[{id:700,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')
    schedule comments 1 "$comments"
    second_nudge="$review_at"
    [ "$kind" != reviewing ] || second_nudge=$(clock_at 99)
    schedule comments 2 "$(jq -cn --argjson old "$comments" --arg at "$second_nudge" '$old + [{id:701,user:{login:"maintainer"},created_at:$at,body:"@codex review"}]')"
    if [ "$kind" = reviewing ]; then
      schedule reactions 1 "[$(reaction eyes "$(clock_at -2)")]"
      schedule reactions 2 "[$(reaction eyes "$review_at")]"
    fi
    run_watch 0,699,0 100 0
    assert_eq "$WATCH_RC" 1 "the $kind extension stays bounded at the original deadline"
    mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
    assert_eq "$(mark_issue "$mark")" 700 "the request arriving during fixed $kind grace remains pending"
    assert_contains "$WATCH_ERR" 'comments after the fixed grace began remain pending' "the caller is told to re-arm"
    run_watch "$mark" 100 0
    assert_contains "$WATCH_ERR" 'extending watch' "the next observer grants the remaining new request grace"
  done
}

# The actual summary row uses fractional UTC seconds and a short commit stamp.
activity_summary() { # <sha> <status> <time>
  summary_comment 700 "$3" "<!-- codex-pull-request-review-summary -->
| Review | Status | Commit | Review trigger |
| 📝 **Code Review** | 🔄 **$2** <relative-time datetime=\"${3%Z}.484070Z\">$3</relative-time> | \`$1\` | New commits |"
}

test_current_head_running_blocks_older_approval_until_completion() {
  reset_fixture
  local started earlier
  started=$(clock_at -2)
  earlier=$(clock_at -60)
  schedule reactions 1 "[$(reaction +1 "$earlier")]"
  schedule comments 1 "[$(activity_summary "${H2:0:7}" Running "$started")]"
  schedule comments 2 "[$(activity_summary "${H2:0:7}" Completed "$started")]"
  run_watch 0,0,0 1 2
  assert_eq "$WATCH_RC" 0 "completion removes the known contradiction to the standing approval"
  assert_contains "$WATCH_OUT" 'approved (👍' "the reaction still supplies the approval"
  [ "$(poll_rounds)" -ge 2 ] || bail "older approval ended watch while current-head review was Running"

  # A completed review with findings contradicts the old reaction too.
  reset_fixture
  echo 1 >"$FEEDS/round"
  schedule reactions 1 "[$(reaction +1 "$earlier")]"
  schedule comments 1 "[$(activity_summary "${H2:0:7}" Completed "$started")]"
  schedule reviews 1 "[$(review 500 "$H2" "$started")]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "current-head findings supersede the earlier thumbs-up"

  # A newer stamped no-findings verdict beats an outlived Running placeholder.
  schedule reviews 1 '[]'
  schedule comments 1 "[$(activity_summary "${H2:0:7}" Running "$earlier"),$(summary_comment 701 "$started" "Didn't find any major issues. **Reviewed commit:** \`$H2\`")]"
  schedule reactions 1 "[$(reaction +1 2026-01-01T00:00:00Z)]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "newer current-head no-findings verdict settles the review"

  # The reviewer's newest row naming ANOTHER head says which head it last took up, and it is not
  # this one: the 👍 is that head's, left standing (#418), and this head's round is due. (Before
  # #418 this was a control that another head's activity leaves the approval alone.)
  reset_fixture
  echo 1 >"$FEEDS/round"
  schedule reactions 1 "[$(reaction +1 "$earlier")]"
  schedule comments 1 "[$(activity_summary "${H1:0:7}" Running "$started")]"
  run_status
  assert_eq "$(state_tok "$STATE")" expected "a 👍 under a row naming another head is not this head's approval"
  # Controls: a completed row naming this head does not contradict the reaction.
  schedule comments 1 "[$(activity_summary "${H2:0:7}" Completed "$started")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "completed activity preserves reaction-only approval"
  schedule comments 1 "[$(activity_summary "${H2:0:7}" Running "$earlier")]"
  schedule reactions 1 "[$(reaction +1 "$started")]"
  run_status
  assert_eq "$(state_tok "$STATE")" approved "a newer approval supersedes a lingering Running row"
}

test_current_head_evidence_handles_unknown_age_footer_and_large_feeds() {
  reset_fixture
  echo 1 >"$FEEDS/round"
  local future earlier current body
  future=$(clock_at 3600)
  earlier=$(clock_at -60)
  current=$(clock_at -2)
  schedule reactions 1 "[$(reaction +1 "$earlier")]"
  schedule comments 1 "[$(activity_summary "${H2:0:7}" Running "$future")]"
  run_status
  assert_eq "$(state_tok "$STATE")" reviewing "clock skew cannot erase known Running evidence"
  assert_eq "$(state_age "$STATE")" - "unknown age only prevents the stalled decision"

  body="The older result said **Reviewed commit:** \`$H1\`.
Current findings follow.
**Reviewed commit:** \`$H2\`"
  schedule comments 1 "[$(summary_comment 701 "$current" "$body")]"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "the footer stamp attributes comment-only findings to this head"

  # Generate the large feed on stdin, too: the fixture must reach the production parser.
  { printf '%s\n' "[$(summary_comment 701 "$current" "$body")]"; } | \
    jq '.[0].body += ("x" * 200000)' >"$FEEDS/comments.1"
  run_status
  assert_eq "$(state_tok "$STATE")" idle "paginated evidence larger than one argv element still parses"
}

# --- a read that does not parse must fail the poll round (ludics-lite#89) -----------------------
# Each site is reached from outside, by a feed answering a shape its read cannot take, so the case
# judges whichever implementation serves `poll` (ludics-lite#403). Four sites of the shell's jq
# programs had no such shape -- the items line's three fields and the watermark maxima read
# nothing the renderings before them had not read first -- and were pinned only by breaking the
# program by name; with the programs gone (`poll` is Python), the round-level property they
# guarded is what the renderings' cases below hold: a failure after any output fails the round
# with no watermark.
#
# cmd_poll's reads used to be unguarded, and each failed in the shape that is hardest to see: the
# list of new reviews to re-read came back empty (no new reviews), a rendering printed nothing (no
# items of that kind), and an `items:`/`watermark:` field built inside the `echo`'s own command
# substitution came back empty while the line still printed — and the watermark was then advanced
# past findings that were never shown.

run_poll() { # [watermark]
  local rc
  set +e
  POLL_OUT=$(cmd_poll 7 "${1:-0,0,0}" 2>"$TEST_ROOT/poll.err")
  rc=$?
  set -e
  POLL_RC="$rc"
  POLL_ERR=$(cat "$TEST_ROOT/poll.err")
}

# assert_poll_refuses <feed> <json> <expected exit> <site>: schedule the feed's malformed answer
# over the standing fixture and require the round to be refused whole — no watermark, so the
# caller keeps the one it had and polls the same feed again rather than advancing past what this
# round could not render.
assert_poll_refuses() {
  local feed="$1" good
  good=$(feed_answer "$feed")
  schedule "$feed" 1 "$2"
  run_poll
  schedule "$feed" 1 "$good"
  assert_eq "$POLL_RC" "$3" "$4: a read that did not parse must fail the round"
  assert_not_contains "$POLL_OUT" "watermark: " "$4: a failed round must not write a watermark"
}

test_a_broken_jq_program_fails_the_poll_round() {
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2")]"
  schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z)]"
  schedule comments 1 "[$(summary_comment 700 2026-09-01T10:00:00Z 'a findings summary')]"
  # The baseline every refusal below is measured against: this fixture, polled with nothing
  # broken, is an ordinary complete round.
  run_poll
  assert_eq "$POLL_RC" 0 "the ordinary round succeeds"
  assert_contains "$POLL_OUT" "items: inline:900" "the control round renders its inline item"
  assert_contains "$POLL_OUT" "summary:700" "and its summary item"
  assert_contains "$POLL_OUT" "review:800" "and its review item"
  assert_contains "$POLL_OUT" "watermark: 900,700,800" "and writes the watermark"

  # The review list feeding the per-review re-read: empty used to mean "no new reviews", so a
  # broken read dropped every review's own inline comments and the round still printed. An entry
  # that is not a review.
  assert_poll_refuses reviews '["not a review"]' 3 "the list of reviews to re-read"
  assert_contains "$POLL_ERR" "this round is UNKNOWN, not quiet" \
    "the refusal should say the round is unknown rather than quiet"

  # An inline finding whose commit is not a SHA: its stamp cannot be rendered.
  assert_poll_refuses inline "[$(inline_comment 900 "$H2" "$H2" | jq -c '.original_commit_id = 7')]" 4 \
    "the inline rendering"
  # A summary whose body is not text.
  assert_poll_refuses comments '[{"id":700,"user":{"login":"chatgpt-codex-connector[bot]"},"created_at":"2026-09-01T10:00:00Z","body":7}]' 4 \
    "the summary rendering"
  # A review whose commit is not a SHA, rendered after the inline and summary bodies printed.
  assert_poll_refuses reviews "[$(review 800 "$H2" 2026-09-01T10:00:00Z | jq -c '.commit_id = 7')]" 4 \
    "the review rendering"
}

# --- poll's own lessons, pinned from the fix history ---------------------------------------------
# Pinned before the v2 port (ludics-lite#403): each names the commit that encoded the rule and
# added no case of its own.

# 9e9e427: the connector's round-started placeholder (machine-tagged, "🔄 Running") is posted the
# moment a round STARTS. Rendered, it made `watch` return 0 with nothing to act on; it is dropped
# from the rendering and the items line, while the watermark still advances past its id.
test_poll_drops_the_round_started_placeholder_but_advances_past_it() {
  reset_fixture
  schedule comments 1 "[$(summary_comment 701 2026-09-01T10:00:00Z '<!-- codex-pull-request-review-summary -->
🔄 Running')]"
  run_poll
  assert_eq "$POLL_RC" 0 "a round with only the placeholder still answers"
  assert_not_contains "$POLL_OUT" "--- summary id=701" "the placeholder is not rendered"
  assert_not_contains "$POLL_OUT" "summary:701" "nor indexed as an item"
  assert_contains "$POLL_OUT" "watermark: 0,701,0" "and the watermark advances past it"
  # The control: a stamped summary beside it renders and is indexed.
  schedule comments 1 "[$(summary_comment 701 2026-09-01T10:00:00Z '<!-- codex-pull-request-review-summary -->
🔄 Running'),$(stamped_summary 702 2026-09-01T10:01:00Z "$H2" 'a findings summary')]"
  run_poll
  assert_contains "$POLL_OUT" "--- summary id=702 commit=${H2:0:7}" "a real summary is rendered"
  assert_contains "$POLL_OUT" "summary:702:${H2:0:7}" "and indexed"
  assert_contains "$POLL_OUT" "watermark: 0,702,0" "the watermark is the feed's maximum"
}

# 23755d8: a just-submitted review appears in pulls/<n>/reviews BEFORE its inline comments reach the
# flat pulls/<n>/comments listing, so every NEW review's own comments endpoint is read too and
# merged by id. The flat copy wins where both carry a comment (only it carries current lines), and
# a failure of the per-review read fails the round rather than dropping the review's findings.
test_poll_reads_a_new_review_s_own_comments() {
  reset_fixture
  schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z)]"
  schedule review_comments 1 "[$(inline_comment 900 "$H2" "$H2" 'only the review has it yet')]"
  run_poll
  assert_eq "$POLL_RC" 0 "the round answers"
  assert_contains "$POLL_OUT" "--- inline id=900 a.sh:3 commit=${H2:0:7}" \
    "an inline finding the flat feed lags is read from the review's own endpoint"
  assert_contains "$POLL_OUT" "only the review has it yet" "with its body"
  assert_contains "$POLL_OUT" "items: inline:900:${H2:0:7}" "and indexed"
  # Both feeds carry 900: the flat copy wins; 901 exists only in the review's endpoint and joins it.
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'the flat copy' a.sh 7)]"
  schedule review_comments 1 "[$(inline_comment 900 "$H2" "$H2" 'the per-review copy' a.sh 3),$(
    inline_comment 901 "$H2" "$H2" 'a second finding' b.sh 4)]"
  run_poll
  assert_contains "$POLL_OUT" "--- inline id=900 a.sh:7 " "the flat feed's copy of 900 is rendered"
  assert_not_contains "$POLL_OUT" "the per-review copy" "and the lagging copy is not"
  assert_contains "$POLL_OUT" "--- inline id=901 b.sh:4 " "the per-review-only comment is merged in"
  assert_contains "$POLL_OUT" "watermark: 901,0,800" \
    "the merged comments advance the inline watermark, so 901 is not replayed when the flat feed catches up"
  # A review whose own comments cannot be read fails the round: no watermark, exit 3.
  FAIL_REVIEW_COMMENTS=1
  run_poll
  assert_eq "$POLL_RC" 3 "an unread per-review endpoint fails the round"
  assert_not_contains "$POLL_OUT" "watermark: " "and writes no watermark"
  assert_contains "$POLL_ERR" "API error reading review 800's comments on PR 7" "naming the review"
  assert_contains "$POLL_ERR" "this round is UNKNOWN, not quiet" "and saying the round is unknown"
  # Only NEW reviews are re-read: one at or below the watermark costs no call.
  : >"$REQUEST_LOG"
  run_poll 0,0,800
  assert_eq "$POLL_RC" 0 "a review behind the watermark is not re-read, so its endpoint's outage is moot"
  assert_eq "$(grep -c '/reviews/800/comments' "$REQUEST_LOG" || true)" 0 "and its endpoint is not asked"
}

# 9197c23 / 3497844: a feed that did not answer is a round that is UNKNOWN, not a quiet one, and
# it writes no watermark: an unwritten watermark keeps the caller's, so a transient error cannot
# advance past findings it never saw.
test_poll_a_feed_that_did_not_answer_is_unknown() {
  reset_fixture
  schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z)]"
  FAIL_FEEDS_FROM=1
  run_poll
  assert_eq "$POLL_RC" 3 "a feed that did not answer is transport, exit 3"
  assert_not_contains "$POLL_OUT" "watermark: " "and writes no watermark"
  assert_not_contains "$POLL_OUT" "review id=800" "nor renders the feeds that did answer"
  assert_contains "$POLL_ERR" "API error reading PR 7 feed(s): inline after 1 attempts each" \
    "the warning names the feed that failed"
  assert_contains "$POLL_ERR" "this round is UNKNOWN, not quiet" "and says the round is unknown"
}

# A round that fails PARTWAY has already printed the bodies it got through, and a reviewer body
# can carry a line that looks exactly like the watermark line — the trap the `items:` line
# documents, in the other feed. Read before the exit code was checked, such a line advanced the
# watermark on a round that showed nothing, and the retry would never show it either
# (review of ludics-lite#162, round 4).
#
# Driven through the command line: a poll that answers takes the watermark it computed, never the
# quoted one, and a poll that fails — here the comments feed, read after the inline one — leaves
# the window blind on the caller's watermark. (The partway shape itself, bodies printed and then a
# rendering failing, needs a jq program to break mid-round; that half was pinned by breaking the
# shell's own rendering's programs, until poll was ported and the programs were gone.)
test_a_failed_round_takes_no_watermark_from_a_quoted_line() {
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'a finding
watermark: 9000,9000,9000')]"
  schedule comments 1 "[$(summary_comment 700 2026-09-01T10:00:00Z 'a findings summary')]"
  # The control: nothing broken, so the round succeeds and its OWN watermark is the last line.
  run_watch 5,5,5
  assert_eq "$WATCH_RC" 0 "control: the round about the head is acted on"
  assert_contains "$WATCH_OUT" "watermark: 9000,9000,9000" "control: the quoted line is in the round's output"
  assert_eq "$(tail -n 1 <<<"$WATCH_OUT")" "watermark: 900,700,5" \
    "a successful round ends on the watermark it computed"
  # Now the comments feed fails on every poll, after the inline feed carrying the quote answered.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'a finding
watermark: 9000,9000,9000')]"
  FAIL_COMMENTS_FROM=1
  run_watch 5,5,5 5 1
  assert_eq "$WATCH_RC" 3 "a window whose polls failed is blind, not quiet"
  assert_eq "$(tail -n 1 <<<"$WATCH_OUT")" "watermark: 5,5,5" \
    "a feed that did not answer keeps the caller's watermark"
  # The case the quote is there for: every feed answers, the inline body carrying the quoted line
  # is rendered, and the rendering fails AFTER it -- a review whose commit_id is a number, which
  # the commit column cannot slice. That round's partial output holds a "watermark:" line, and
  # only its exit status says it is not a round.
  reset_fixture
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" 'a finding
watermark: 9000,9000,9000')]"
  schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z | jq -c '.commit_id = 12345')]"
  run_watch 5,5,5 5 1
  assert_eq "$WATCH_RC" 3 "a window whose rounds did not render is blind, not quiet"
  assert_not_contains "$WATCH_OUT" "9000,9000,9000" "the quoted line is not read as a watermark"
  assert_eq "$(tail -n 1 <<<"$WATCH_OUT")" "watermark: 5,5,5" \
    "a failed round keeps the caller's watermark; a quoted line is not a watermark"
}

# --- the connector's "About Codex in GitHub" block (ludics-lite#358) -----------------------------
# The block as the connector serves it, byte for byte from a review of ludics-lite#354 (read
# through the reviews API on 2026-09-24): LF line ends, U+2139 U+FE0F in the summary, and the
# whitespace-only lines on either side of the text. Written with printf escapes so the emoji
# bytes are visible here rather than trusted to an editor.
CODEX_ABOUT_OPEN=$(printf '<details> <summary>\xe2\x84\xb9\xef\xb8\x8f About Codex in GitHub</summary>')
codex_about_block() {
  printf '%s\n<br/>\n\n%s\n%s\n%s\n%s\n\n%s\n\n\n\n\n%s\n            \n</details>' \
    "$CODEX_ABOUT_OPEN" \
    '[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you' \
    '- Open a pull request for review' '- Mark a draft as ready' '- Comment "@codex review".' \
    "$(printf 'If Codex has suggestions, it will comment; otherwise it will react with \xf0\x9f\x91\x8d.')" \
    'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".'
}
# A review body in the connector's shape: its header, the text before the block, the stamp, then
# the block. <before-block> is what a case puts between the stamp and the opener.
codex_review_body() { # <commit> <before-block> <block>
  printf '\n### \xf0\x9f\x92\xa1 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** `%s`\n    \n%s\n\n%s' \
    "${1:0:10}" "$2" "$3"
}
CODEX_FOLDED='[Codex "About Codex in GitHub" boilerplate folded]'
CODEX_BOILERPLATE='Your team has set up Codex'

# The shape the issue was filed on, in both bodies the connector writes it into: a review, and a
# comment. The comment carries the block with other text inside (the connector writes such a
# variant too, which is why the interior is not read). The findings above the block stay whole, and
# the block is one line.
test_the_about_codex_block_is_folded_to_one_line() {
  reset_fixture
  local finding variant
  finding=$(printf 'P1: the sweep deletes a live run directory.\nIt reads the lock after the rm.')
  schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z \
    "$(codex_review_body "$H2" "$finding" "$(codex_about_block)")")]"
  variant=$(printf '%s\n<br/>\n\nCodex reacts with \xf0\x9f\x91\x80 while any review is running.\n\n</details>' \
    "$CODEX_ABOUT_OPEN")
  # The verdict comment's shape (ludics-lite#136): the stamp, then the block.
  schedule comments 1 "[$(summary_comment 700 2026-09-01T10:00:00Z \
    "$(printf 'Codex Review: Didn'"'"'t find any major issues.\n\n**Reviewed commit:** `%s`\n\n%s' \
      "${H2:0:10}" "$variant")")]"
  run_poll
  assert_eq "$POLL_RC" 0 "the round succeeds"
  assert_contains "$POLL_OUT" "$finding" "the findings above the block are rendered intact"
  assert_contains "$POLL_OUT" "**Reviewed commit:** \`${H2:0:10}\`" "and so is the stamp"
  assert_eq "$(occurrences "$POLL_OUT" "$CODEX_FOLDED")" 2 "each body's block is ONE line"
  assert_not_contains "$POLL_OUT" "$CODEX_BOILERPLATE" "the review's block text is gone"
  assert_not_contains "$POLL_OUT" "while any review is running" "and so is the comment's variant"
  assert_not_contains "$POLL_OUT" "About Codex in GitHub</summary>" "opener included"
  assert_not_contains "$POLL_OUT" "</details>" "closer included"
  # Rendering only: the stamp, the index and the watermark are what they were.
  assert_contains "$POLL_OUT" "--- summary id=700 commit=${H2:0:7}" "the summary keeps its stamp"
  assert_contains "$POLL_OUT" "items:  summary:700:${H2:0:7}" "the index is untouched"
  assert_contains "$POLL_OUT" "review:800:${H2:0:7}" "for the review too"
  assert_contains "$POLL_OUT" "watermark: 0,700,800" "and so is the watermark"
}

# The boundary is one exact shape, and each way out of it renders the body byte for byte: the
# opener without the emoji, without its variation selector, with other spacing, or with another
# summary; an unterminated block; a block with text after it; and a block holding a second
# `</details>`. And an inline finding is never folded, whatever it carries.
test_what_is_not_the_about_codex_block_renders_as_is() {
  local body case_name
  local -a cases=(
    'no emoji' '<details> <summary>About Codex in GitHub</summary>'
    'no variation selector' "$(printf '<details> <summary>\xe2\x84\xb9 About Codex in GitHub</summary>')"
    'no space' "$(printf '<details><summary>\xe2\x84\xb9\xef\xb8\x8f About Codex in GitHub</summary>')"
    'another summary' "$(printf '<details> <summary>\xe2\x84\xb9\xef\xb8\x8f About Codex in GitLab</summary>')"
  )
  local i=0
  while [ "$i" -lt "${#cases[@]}" ]; do
    case_name="${cases[$i]}"
    body=$(codex_review_body "$H2" "a finding" \
      "$(codex_about_block | sed "1s|.*|${cases[$((i + 1))]}|")")
    reset_fixture
    schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z "$body")]"
    run_poll
    assert_eq "$POLL_RC" 0 "$case_name: the round succeeds"
    assert_contains "$POLL_OUT" "$body" "$case_name: a near-miss opener renders the body as-is"
    assert_not_contains "$POLL_OUT" "$CODEX_FOLDED" "$case_name: and folds nothing"
    i=$((i + 2))
  done

  # The sed above must have produced the near-misses, not the real opener: the control is the same
  # construction with the real opener, which folds.
  reset_fixture
  body=$(codex_review_body "$H2" "a finding" \
    "$(codex_about_block | sed "1s|.*|${CODEX_ABOUT_OPEN}|")")
  schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z "$body")]"
  run_poll
  assert_contains "$POLL_OUT" "$CODEX_FOLDED" "control: the same construction with the real opener folds"

  local block unterminated
  block=$(codex_about_block)
  unterminated="${block%</details>}"
  local -a shapes=(
    'unterminated' "$(codex_review_body "$H2" "a finding" "$unterminated")"
    'text after the block' "$(codex_review_body "$H2" "a finding" "$block")
P2: a finding the connector wrote below the block."
    'a second closer' "$(codex_review_body "$H2" "a finding" "$block
</details>")"
  )
  i=0
  while [ "$i" -lt "${#shapes[@]}" ]; do
    case_name="${shapes[$i]}"
    body="${shapes[$((i + 1))]}"
    reset_fixture
    schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z "$body")]"
    run_poll
    assert_eq "$POLL_RC" 0 "$case_name: the round succeeds"
    assert_contains "$POLL_OUT" "$body" "$case_name: renders the body as-is"
    assert_not_contains "$POLL_OUT" "$CODEX_FOLDED" "$case_name: and folds nothing"
    i=$((i + 2))
  done

  reset_fixture
  body=$(printf 'a finding\n\n%s' "$block")
  schedule inline 1 "[$(inline_comment 900 "$H2" "$H2" "$body")]"
  run_poll
  assert_contains "$POLL_OUT" "$body" "an inline finding renders as-is, block and all"
  assert_not_contains "$POLL_OUT" "$CODEX_FOLDED" "and is never folded"
}

# A finding that QUOTES the opener sits above the real block. Only the block that ends the body is
# folded: the quoted opener, and every finding between it and the real block, render intact.
test_a_quoted_opener_above_the_block_keeps_the_findings() {
  reset_fixture
  local finding
  finding=$(printf 'P2: poll matches `%s` too loosely.\n\nP3: and a second finding after the quote.' \
    "$CODEX_ABOUT_OPEN")
  schedule reviews 1 "[$(review 800 "$H2" 2026-09-01T10:00:00Z \
    "$(codex_review_body "$H2" "$finding" "$(codex_about_block)")")]"
  run_poll
  assert_eq "$POLL_RC" 0 "the round succeeds"
  assert_contains "$POLL_OUT" "$finding" "the findings, quoted opener and all, are intact"
  assert_eq "$(occurrences "$POLL_OUT" "$CODEX_FOLDED")" 1 "the real block is folded"
  assert_not_contains "$POLL_OUT" "$CODEX_BOILERPLATE" "and its text is gone"
}

# --- an approval over the findings the watch scrolled past (ludics-lite#289) ---------------------
# PR #277, round 6, as it was: two inline findings written against the previous head, the 👍 on the
# base-merge commit above it. The round classifies the findings NOT about head and moves past them
# — correctly, they are not this head's round — and the approval then ends the wait. What it must
# not do is end it as a clean `approved`: the merge changed neither line, so both findings were live
# in the head about to be merged, and the threads carrying them were still open.
two_head_fixture() { # <resolved: true|false>
  reset_fixture
  schedule reviews 1 "[$(review 4053090000 "$H1" 2026-09-01T00:01:00Z)]"
  schedule inline 1 "[$(inline_comment 4053098120 "$H1" "$H2" 'P2: a live defect'),$(inline_comment 4053098122 "$H1" "$H2" 'P2: another' b.sh 9)]"
  schedule reactions 1 "[$(head_thumb)]"
  schedule threads 1 "[$(review_thread 4053098120 "$1"),$(review_thread 4053098122 "$1" b.sh)]"
}

test_an_approval_over_findings_scrolled_past_is_not_clean() {
  two_head_fixture false
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "an approval ends the wait"
  assert_contains "$WATCH_ERR" "item(s) NOT about head ${H2:0:7}" \
    "the findings on the previous head are still classified as not this head's round"
  assert_contains "$WATCH_ERR" "a thread among them left unresolved still holds an approval back" \
    "and the record of them says an open one still counts"
  local last
  last=$(grep -v '^watermark: ' <<<"$WATCH_OUT" | tail -1)
  assert_contains "$last" "BUT 2 review thread(s) still UNRESOLVED — NOT a clean approval" \
    "the approval is reported over the open threads, not as a clean approval"
  assert_contains "$last" "4053098120 by codex[bot] on a.sh, 4053098122 by codex[bot] on b.sh" \
    "naming both findings the watch moved past"
  assert_eq "$(grep -c -x graphql "$REQUEST_LOG" || true)" 1 \
    "one thread read, on the round the approval ends"
  # The control: the same two heads with both threads answered and closed is a clean approval.
  two_head_fixture true
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 0 "the approval ends the wait"
  last=$(grep -v '^watermark: ' <<<"$WATCH_OUT" | tail -1)
  assert_eq "$last" "approved (👍 from $REVIEWER)" "with every thread resolved it is clean"
}

test_an_approval_landing_in_the_final_poll_is_checked_too() {
  # watch_end's approval: the 👍 landing while a no-review verdict was being read. It ends the wait
  # as any approval does, so it is checked for open threads the same way.
  reset_fixture
  retune GRACE=1
  schedule reactions 3 "[$(head_thumb)]" # the verdict's final poll, after the pickup margin
  schedule threads 1 "[$(review_thread 4053098120 false)]"
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 0 "an approval is something to act on"
  assert_contains "$WATCH_OUT" "the 👍 landed while it was being read" "the verdict is dropped for it"
  assert_contains "$WATCH_OUT" "BUT 1 review thread(s) still UNRESOLVED" \
    "and the approval is reported over its open thread"
}

test_an_approval_beside_a_final_poll_round_is_checked_too() {
  # watch_end's other exit: the final poll finds a round about the head, and the 👍 is newer than
  # it, so the state printed beside that round is an approval — checked like any other (review of
  # #370, round 1), never a clean `status: approved` over an older open thread.
  reset_fixture
  retune GRACE=1
  schedule inline 2 "[$(inline_comment 4095735684 "$H2" "$H2" 'a finding on this head')]"
  schedule reactions 2 "[$(head_thumb)]"
  schedule threads 1 "[$(review_thread 4053098120 false)]"
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 0 "the round the final poll found is the exit"
  assert_contains "$WATCH_OUT" "--- inline id=4095735684" "and it is printed as the round"
  assert_contains "$WATCH_ERR" "status: approved (👍 from $REVIEWER) BUT 1 review thread(s) still UNRESOLVED" \
    "the approval beside it is reported over the open thread"
}

# --- edges the fix history encoded (pinned before the v2 port, ludics-lite#403) -------------------

# A live 👀 that stops reading as live without a review of the head is a round that ended with
# nothing (b6b09ee, "a spent 👀 must not read as a review is running"). One read is not proof — a
# reaction read can come back empty once (test_one_empty_reaction_read_retains_the_live_boundary)
# — so the second consecutive one is, and it ends the wait on the nudge advice after the final
# poll, rather than holding the window or the grace. The advice is what `--no-nudge` prints; by
# default the watch posts the nudge itself (test_a_push_during_a_live_round_gets_the_new_head_reviewed).
test_a_live_round_that_reads_ended_twice_ends_on_the_nudge_advice() {
  reset_fixture
  WATCH_FLAG=--no-nudge
  schedule reactions 1 "[$(reaction eyes "$(clock_at -5)")]"
  schedule reactions 2 '[]'
  run_watch 0,0,0 1 5
  assert_eq "$WATCH_RC" 0 "a round that ended with nothing is a verdict to act on"
  assert_contains "$WATCH_OUT" \
    "the 👀 round on PR $REPO#7 ended without a review of the head commit — consider nudging" \
    "the verdict names what happened and the move"
  assert_contains "$WATCH_OUT" "no reviewer activity about head ${H2:0:7}; status: review EXPECTED" \
    "beside the state it was read from"
  assert_eq "$(poll_rounds)" 4 "two loop reads after the live one, then the final poll"
  assert_eq "$(nudges_posted)" 0 "and --no-nudge posts nothing"
}

# A 👀 older than any round takes is `stalled`, and the watch answers it like the other
# nothing-is-coming verdicts: one final poll, the state re-read, then the line (b6b09ee, 71f2862).
test_a_stalled_round_ends_the_wait_with_its_verdict() {
  reset_fixture
  retune STALL=30
  schedule reactions 1 "[$(reaction eyes "$(clock_at -60)")]"
  run_watch 0,0,0 1 5
  assert_eq "$WATCH_RC" 0 "a stall is something to act on"
  assert_contains "$WATCH_OUT" "no reviewer activity about head ${H2:0:7}; status: STALLED — 👀 from" \
    "the verdict is the stall, said beside the head it is about"
  assert_eq "$(poll_rounds)" 2 "one loop read reaches it, and the final poll precedes the verdict"
}

# A window in which no poll answered is not a quiet window, and one whose LAST polls did not answer
# did not observe its tail (9197c23): both exit 3, each saying which it was, never exit 1.
test_a_blind_window_is_not_a_quiet_one() {
  reset_fixture
  FAIL_FEEDS_FROM=1
  run_watch 0,0,0 5 1
  assert_eq "$WATCH_RC" 3 "nothing observed is transport, not a verdict"
  assert_contains "$WATCH_OUT" "could not read PR $REPO#7 for the whole 1s window — NOT the same as quiet" \
    "the line says the whole window was blind"
  assert_contains "$WATCH_OUT" "watermark: 0,0,0" "and hands the caller's watermark back"
  reset_fixture
  FAIL_FEEDS_FROM=2
  run_watch 0,0,0 1 1
  assert_eq "$WATCH_RC" 3 "an unobserved tail is transport too"
  assert_contains "$WATCH_OUT" "poll(s) of the 1s window on PR $REPO#7 did not answer, so the tail of this window was NOT observed" \
    "the line says the tail was blind"
  assert_not_contains "$WATCH_OUT" "no reviewer activity" "and does not report a quiet window"
}

# A PR read that fails leaves the state unknown, which the loop holds without concluding anything,
# and the quiet exit says the head was never read rather than naming none (692d42e). The opening
# line on stderr is the log's record of what the window started from.
test_an_unread_head_is_named_unread_in_the_quiet_exit() {
  reset_fixture
  FAIL_PULLS=1
  run_watch 0,0,0
  assert_eq "$WATCH_RC" 1 "the feeds answered and nothing came, so the window is quiet"
  assert_contains "$WATCH_ERR" "watching PR $REPO#7, every 1s for up to 1s; from: UNKNOWN" \
    "the opening line names the window and the state it started from"
  assert_contains "$WATCH_ERR" "state unreadable this round on PR $REPO#7; holding 'unknown'" \
    "an unknown state is held, round by round"
  assert_contains "$WATCH_OUT" "no reviewer activity about head UNREAD in 1s; status: UNKNOWN" \
    "the quiet line says the head was not read"
}

# --- the automatic nudge (ludics-lite#570) -------------------------------------------------------

# The watch's own '@codex review' posts, counted off the request log: the POST is the only call on
# the bare comments endpoint (every read carries ?per_page=100).
nudges_posted() {
  grep -c -x "repos/$REPO/issues/7/comments" "$REQUEST_LOG" || true
}

# OCANNL post-wave 1, p1t7 (lukstafi/ocannl-staging#1057): a push landed while the reviewer was
# still on the old head; its round ended with a review of that head, and the new head sat
# unreviewed until a hand nudge. Head H1 under a live 👀, H2 pushed at round 2, H1's review landing
# at round 3: the round ends without a review of the head, and the watch nudges once and ends on
# the new head's round.
test_a_push_during_a_live_round_gets_the_new_head_reviewed() {
  reset_fixture
  schedule head 0 "$H1"
  schedule head 2 "$H2"
  schedule reactions 1 "[$(reaction eyes "$(clock_at -5)")]"
  schedule reviews 3 "[$(review 501 "$H1" "$(clock_at -1)" 'the round on the head before the push')]"
  NUDGE_ANSWER=502
  run_watch 0,0,0 60 900
  assert_eq "$WATCH_RC" 0 "the new head's round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502 state=COMMENTED commit=${H2:0:7}" \
    "the watch ends on the round about the pushed head"
  assert_contains "$WATCH_ERR" "1 item(s) NOT about head ${H2:0:7}" "the old head's round scrolled past"
  assert_eq "$(nudges_posted)" 1 "after exactly one automatic nudge"
  assert_eq "$(jq -r .body "$FEEDS/posted")" "@codex review

_🤖 Addressed by an automated coding agent_" "a plain top-level request, never a reply quoting it (#472)"
}

# p1t9 (lukstafi/ocannl-staging#1048): the reviewer never started on a head, no 👀 at all, and
# "review EXPECTED but not started" cost a window before anyone nudged.
test_a_head_with_no_eyes_past_its_grace_gets_reviewed() {
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  NUDGE_ANSWER=502
  run_watch 0,0,0 60 900
  assert_eq "$WATCH_RC" 0 "the head's round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502 state=COMMENTED commit=${H2:0:7}" \
    "the watch ends on the round the nudge drew"
  assert_eq "$(nudges_posted)" 1 "after exactly one automatic nudge"
  assert_not_contains "$WATCH_OUT" "no review materialized" "the overdue head is not handed back as a verdict"
}

# The opt-out: the same overdue head, and the watch hands the verdict back with the advice, as it
# did before #570, having posted nothing.
test_no_nudge_posts_nothing() {
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  NUDGE_ANSWER=502
  WATCH_FLAG=--no-nudge
  run_watch 0,0,0 60 900
  assert_eq "$WATCH_RC" 0 "the overdue head is a verdict to act on"
  assert_contains "$WATCH_OUT" "since it became due — consider nudging with a '@codex review' comment" \
    "the advice is printed instead"
  assert_eq "$(nudges_posted)" 0 "and nothing is posted"
}

# A head something already stands for is never nudged: an approval ends the wait as one, and a
# verdict the state machine does not read as an approval still bars the request -- a no-findings
# comment for the head with a later reviewer word under it, and the summary's Completed row for
# the head with its 👀 gone. The control is the same overdue head with neither.
test_a_head_with_a_verdict_is_never_nudged() {
  local kind
  for kind in thumb verdict outlived-verdict completed-row control; do
    reset_fixture
    retune GRACE=1
    HEAD_AT=2026-09-01T00:00:00Z
    PR_CREATED_AT="$HEAD_AT"
    case "$kind" in
    thumb) schedule reactions 1 "[$(head_thumb)]" ;;
    verdict) schedule comments 1 "[$(stamped_summary 700 "$(clock_at -100)" "$H2" "Codex Review: Didn't find any major issues.")]" ;;
    outlived-verdict)
      schedule comments 1 "[$(stamped_summary 700 "$(clock_at -100)" "$H2" "Codex Review: Didn't find any major issues."),$(
        summary_comment 701 "$(clock_at -50)" 'a later word, about no commit')]"
      schedule reactions 1 "[$(reaction eyes "$(clock_at -75)")]"
      ;;
    completed-row)
      schedule comments 1 "[$(summary_comment 700 "$(clock_at -100)" "<!-- codex-pull-request-review-summary -->
| Review | Status | Commit | Review trigger |
| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"$(clock_at -100)\">x</relative-time> | \`${H2:0:7}\` | New commits |")]"
      ;;
    esac
    run_watch 0,701,0 60 120
    assert_eq "$WATCH_RC" 0 "$kind: a verdict to act on"
    case "$kind" in
    thumb | verdict)
      assert_contains "$WATCH_OUT" "approved (" "$kind: the approval ends the wait"
      assert_eq "$(nudges_posted)" 0 "$kind: and nothing is posted over it"
      ;;
    control)
      assert_eq "$(nudges_posted)" 1 "control: the same overdue head with nothing standing is nudged"
      ;;
    *)
      assert_contains "$WATCH_OUT" "review EXPECTED but not started" "$kind: the state machine reads the head as due"
      assert_contains "$WATCH_OUT" "not nudged automatically ($REVIEWER" "$kind: the request is barred, by name"
      assert_eq "$(nudges_posted)" 0 "$kind: and nothing is posted"
      ;;
    esac
  done
}

# Once per head: the watch that posted the nudge waits out its grace and says it drew nothing, and a
# watch re-armed on its watermark reads the request on the PR and posts no second one. Within one
# watch the in-process record holds even while the comments feed has not caught up with the post.
test_a_head_is_nudged_once_across_re_armed_watches() {
  local mark
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  run_watch 0,0,0 60 900
  assert_eq "$WATCH_RC" 0 "a nudge that drew nothing is a verdict to act on"
  assert_eq "$(nudges_posted)" 1 "one nudge"
  assert_contains "$WATCH_OUT" "this watch's own '@codex review' on head ${H2:0:7}" "the verdict names the nudge it posted"
  assert_contains "$WATCH_OUT" "a second is never posted automatically" "and says no second follows"
  assert_contains "$WATCH_ERR" "extending watch" "the window held for the request's grace"
  mark=$(sed -n 's/^watermark: //p' <<<"$WATCH_OUT" | tail -1)
  run_watch "$mark" 60 900
  assert_eq "$WATCH_RC" 0 "the re-armed watch reaches the same verdict"
  assert_eq "$(nudges_posted)" 1 "and posts no second nudge"
  assert_contains "$WATCH_OUT" "already stands on head ${H2:0:7}, so the watch posts no second one" \
    "naming the request that stands"
  # The feed lagging the post: the rounds after it still read the head as overdue and unasked.
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  HIDE_POSTED=1
  run_watch 0,0,0 60 900
  assert_eq "$(nudges_posted)" 1 "one nudge however many rounds miss it"
  assert_contains "$WATCH_ERR" "extending watch" "and its grace, not the stale state's lack of one, bounds the window"
  assert_contains "$WATCH_OUT" "this watch's own '@codex review' on head ${H2:0:7}" "before the verdict names it"
}

# A nudge whose POST failed is not retried: it may have landed (the #453 rule for the failed run's
# re-request), and the verdict says so.
test_a_nudge_that_did_not_post_is_not_retried() {
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  FAIL_POST=1
  retune API_ATTEMPTS=4
  run_watch 0,0,0 60 900
  assert_eq "$WATCH_RC" 0 "the caller has a move to make"
  assert_eq "$(nudges_posted)" 1 "the request is sent once whatever its error"
  assert_contains "$WATCH_OUT" "the automatic '@codex review' nudge for head ${H2:0:7} did not go through" \
    "and the verdict says it is not known to be on the PR"
}

# Review of #583, round 1. A commit's date is not its push: an old-dated head reads as overdue the
# moment it lands, before the reviewer's own automatic round has had a chance to start. The watch
# holds the nudge until it has itself seen the head for the pickup margin (five minutes): here the
# 👀 lands at the third round, two minutes in, and the round it starts is what the watch ends on.
test_an_old_dated_push_gets_the_pickup_margin() {
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  schedule reactions 3 "[$(reaction eyes "$(clock_at 110)")]"
  schedule reviews 5 "[$(review 502 "$H2" "$(clock_at 230)" 'the automatic round on the push')]"
  run_watch 0,0,0 60 900
  assert_eq "$(nudges_posted)" 0 "nothing is posted inside the pickup margin"
  assert_eq "$WATCH_RC" 0 "the automatic round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502" "and the watch ends on it"
}

# Review of #583, round 2. The pickup margin holds for a head the verdict's own final poll reads
# first, too: H1 is held its five minutes and reaches the verdict (round 4, the pause having
# doubled to 60+120+240s), whose final poll (round 5) reads a new old-dated head H2. H2 gets its
# own margin, in which the reviewer's automatic round on it starts and lands.
test_a_head_the_final_poll_reads_first_gets_the_pickup_margin() {
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  schedule head 0 "$H1"
  schedule head 5 "$H2"
  schedule reactions 6 "[$(reaction eyes "$(clock_at 470)")]"
  schedule reviews 7 "[$(review 502 "$H2" "$(clock_at 500)" 'the automatic round on the push')]"
  run_watch 0,0,0 60 900
  assert_eq "$(nudges_posted)" 0 "nothing is posted for the head the final poll read first"
  assert_eq "$WATCH_RC" 0 "the automatic round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502 state=COMMENTED commit=${H2:0:7}" "and the watch ends on it"
}

# Review of #583, round 5. The write gate reads the draft flag and the mergeability too: a PR made a
# draft, or conflicted, between the state read and the post is not nudged. The fixture turns the PR
# into a draft at exactly the gate's read (DRAFT_AT_WRITE_GATE).
test_a_pr_made_a_draft_at_the_write_gate_is_not_nudged() {
  reset_fixture
  retune GRACE=1
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  DRAFT_AT_WRITE_GATE=1
  run_watch 0,0,0 60 120
  assert_eq "$(nudges_posted)" 0 "nothing is posted on the draft"
  assert_contains "$WATCH_OUT" "not nudged automatically: the PR reads a draft, not open" "and the verdict says why"
}

# Review of #583, round 4. A push landing between the nudge's read and its post: the write gate
# reads the PR's head with its state, and a head other than the one the nudge was read for is held
# to its own pickup margin, in which its automatic round lands. Pauses held at the interval: the
# verdict is at round 6 (300s), its final poll round 7, and H1 arrives at that poll's write gate.
test_a_push_at_the_write_gate_is_held() {
  reset_fixture
  retune REVIEW_POLL_CAP=60
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  PUSH_AT_WRITE_GATE="$H1"
  schedule reactions 9 "[$(reaction eyes "$(clock_at 410)")]"
  schedule reviews 10 "[$(review 502 "$H1" "$(clock_at 470)" 'the automatic round on the push')]"
  run_watch 0,0,0 60 900
  assert_eq "$(nudges_posted)" 0 "nothing is posted for the head that moved under the gate"
  assert_eq "$WATCH_RC" 0 "the automatic round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502 state=COMMENTED commit=${H1:0:7}" "and the watch ends on it"
}

# Review of #583, round 4. A head read after reads that did not answer is a new arrival too: the
# branch may have moved and come back unseen. H2 is seen at round 1, the PR read fails for rounds 2
# to 6, and H2 read again at round 7 (360s, past a margin counted from round 1) gets a margin of its
# own, in which the automatic round lands.
test_a_head_read_after_an_outage_gets_the_pickup_margin_again() {
  reset_fixture
  retune REVIEW_POLL_CAP=60
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  FAIL_PULLS_FROM=2
  FAIL_PULLS_UNTIL=6
  schedule reactions 9 "[$(reaction eyes "$(clock_at 470)")]"
  schedule reviews 10 "[$(review 502 "$H2" "$(clock_at 530)" 'the automatic round')]"
  run_watch 0,0,0 60 900
  assert_eq "$(nudges_posted)" 0 "nothing is posted inside the margin after the outage"
  assert_eq "$WATCH_RC" 0 "the automatic round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502" "and the watch ends on it"
}

# Review of #583, round 4. Under --no-nudge a failed run's remedy is the final read's: a request on
# the head that the final poll is the first to see turns the run into `run-again`, whose line names
# the move, so the watch does not tell the caller to post a request that already stands.
test_a_no_nudge_failed_run_takes_its_remedy_from_the_final_read() {
  local row summary request
  reset_fixture
  WATCH_FLAG=--no-nudge
  HEAD_AT=$(clock_at -300)
  PR_CREATED_AT=$(clock_at -400)
  row="| 📝 **Code Review** | ⚠️ **Failed** <relative-time datetime=\"$(clock_at -100)\">x</relative-time> | \`${H2:0:7}\` | New commits |"
  summary=$(summary_comment 1 "$(clock_at -99)" "<!-- codex-pull-request-review-summary -->
| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
$row")
  request=$(jq -cn --arg at "$(clock_at -200)" '{id:2,user:{login:"me"},created_at:$at,body:"@codex review"}')
  schedule comments 1 "[$summary]"
  schedule comments 2 "[$summary,$request]"
  run_watch 0,0,0 60 900
  assert_eq "$(nudges_posted)" 0 "nothing is posted"
  assert_contains "$WATCH_OUT" "reviewer's run FAILED AGAIN on head ${H2:0:7}" "the final read is the verdict"
  assert_not_contains "$WATCH_OUT" "post it yourself" "and no request is asked for over the one that stands"
}

# Review of #583, round 3. A head that comes back (H2, then H1, then H2 again: a push back to it)
# is a new arrival and gets the pickup margin again; H2's first sight, six minutes before, does not
# count. The pause is held at the interval (a minute) so the rounds fall where the schedule says.
test_a_returning_head_gets_the_pickup_margin_again() {
  reset_fixture
  retune REVIEW_POLL_CAP=60
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  schedule head 0 "$H2"
  schedule head 2 "$H1"
  schedule head 7 "$H2"
  schedule reactions 9 "[$(reaction eyes "$(clock_at 470)")]"
  schedule reviews 10 "[$(review 502 "$H2" "$(clock_at 530)" 'the automatic round on the push back')]"
  run_watch 0,0,0 60 900
  assert_eq "$(nudges_posted)" 0 "nothing is posted inside the returning head's margin"
  assert_eq "$WATCH_RC" 0 "the automatic round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502 state=COMMENTED commit=${H2:0:7}" "and the watch ends on it"
}

# Review of #583, round 3. A hold that begins inside an extension already running extends it. The
# window (a minute) is extended for a live 👀 to that round's grace, 200s in; the round ends without
# a review of the head at the third round, whose verdict is held to the head's pickup margin, 300s
# in. The window lasts to the hold, and the nudge and its round follow.
test_a_hold_inside_an_extension_extends_it() {
  reset_fixture
  retune REVIEW_POLL_CAP=60
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  schedule reactions 1 "[$(reaction eyes "$(clock_at -1000)")]"
  schedule reviews 2 "[$(review 501 "$H1" "$(clock_at -900)" 'the round on another head')]"
  NUDGE_ANSWER=502
  run_watch 0,0,0 60 60
  assert_contains "$WATCH_ERR" "extending watch" "the window was extended for the live round"
  assert_eq "$(nudges_posted)" 1 "the hold outlasted that extension, and the nudge followed it"
  assert_eq "$WATCH_RC" 0 "the head's round is something to act on"
  assert_contains "$WATCH_OUT" "--- review id=502 state=COMMENTED commit=${H2:0:7}" "and the watch ends on it"
}

# Review of #583, round 3. A PR closed or merged while the watch runs is not nudged: the state
# machine still reads its head as due, and the PR's own state is the write's last gate.
test_a_closed_pr_is_not_nudged() {
  reset_fixture
  retune GRACE=1
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  PR_STATE=closed
  run_watch 0,0,0 60 120
  assert_eq "$(nudges_posted)" 0 "nothing is posted on a closed PR"
  assert_contains "$WATCH_OUT" "not nudged automatically: the PR reads closed, not open" "and the verdict says why"
}

# Review of #583, round 1. A request on the head that is younger than its grace is waited out, not
# reported as one that drew nothing: a watch re-armed on a watermark past a request seconds old
# (after a transport exit, say) holds the window to that request's grace before it says so.
test_a_standing_request_holds_the_nudge() {
  local started ended
  reset_fixture
  HEAD_AT=2026-09-01T00:00:00Z
  PR_CREATED_AT="$HEAD_AT"
  schedule comments 1 "$(jq -cn --arg at "$(clock_at -10)" \
    '[{id:700,user:{login:"me"},created_at:$at,body:"@codex review\n\n_🤖 Addressed by an automated coding agent_"}]')"
  started=$(cat "$SHIP_PR_TEST_CLOCK")
  run_watch 0,700,0 60 900
  ended=$(cat "$SHIP_PR_TEST_CLOCK")
  assert_eq "$(nudges_posted)" 0 "no second request is posted"
  assert_contains "$WATCH_ERR" "extending watch" "the window is held for the request's grace"
  [ $((ended - started)) -ge $((GRACE - 10)) ] ||
    bail "the verdict came $((ended - started))s in, inside the standing request's grace"
  assert_contains "$WATCH_OUT" "already stands on head ${H2:0:7}, so the watch posts no second one" \
    "and only then names the request that drew nothing"
}

# Review of #583, round 1. A draft or a PR that conflicts with its base is not nudged: no review
# lands it until the move its status line names is made, and the request would be spent on a head
# that move replaces.
test_a_draft_or_conflicted_pr_is_not_nudged() {
  local merge
  for merge in draft dirty; do
    reset_fixture
    retune GRACE=1
    HEAD_AT=2026-09-01T00:00:00Z
    PR_CREATED_AT="$HEAD_AT"
    MERGEABLE_STATE="$merge"
    run_watch 0,0,0 60 120
    assert_eq "$WATCH_RC" 0 "$merge: the overdue head is still a verdict"
    assert_eq "$(nudges_posted)" 0 "$merge: and nothing is posted"
    assert_contains "$WATCH_OUT" "not nudged automatically: a review of this head cannot land it" \
      "$merge: the verdict says why"
  done
}

tests=(
  test_a_pr_made_a_draft_at_the_write_gate_is_not_nudged
  test_a_push_at_the_write_gate_is_held
  test_a_head_read_after_an_outage_gets_the_pickup_margin_again
  test_a_no_nudge_failed_run_takes_its_remedy_from_the_final_read
  test_a_returning_head_gets_the_pickup_margin_again
  test_a_hold_inside_an_extension_extends_it
  test_a_closed_pr_is_not_nudged
  test_a_head_the_final_poll_reads_first_gets_the_pickup_margin
  test_an_old_dated_push_gets_the_pickup_margin
  test_a_standing_request_holds_the_nudge
  test_a_draft_or_conflicted_pr_is_not_nudged
  test_no_nudge_posts_nothing
  test_a_head_with_a_verdict_is_never_nudged
  test_a_head_is_nudged_once_across_re_armed_watches
  test_a_nudge_that_did_not_post_is_not_retried
  test_a_push_during_a_live_round_gets_the_new_head_reviewed
  test_a_head_with_no_eyes_past_its_grace_gets_reviewed
  test_the_about_codex_block_is_folded_to_one_line
  test_what_is_not_the_about_codex_block_renders_as_is
  test_a_quoted_opener_above_the_block_keeps_the_findings
  test_a_broken_jq_program_fails_the_poll_round
  test_poll_drops_the_round_started_placeholder_but_advances_past_it
  test_poll_reads_a_new_review_s_own_comments
  test_poll_a_feed_that_did_not_answer_is_unknown
  test_a_failed_round_takes_no_watermark_from_a_quoted_line
  test_current_head_evidence_handles_unknown_age_footer_and_large_feeds
  test_current_head_running_blocks_older_approval_until_completion
  test_a_new_request_during_fixed_grace_remains_pending
  test_a_second_nudge_at_settle_remains_pending
  test_an_actionable_result_with_unknown_status_keeps_pending_comments
  test_one_empty_reaction_read_retains_the_live_boundary
  test_a_pre_push_nudge_keeps_the_fresher_head_clock
  test_old_unseen_findings_leave_the_new_request_pending
  test_initial_grace_cannot_renew_indefinitely_after_unknown_reads
  test_a_fresh_nudge_supersedes_old_same_head_results
  test_unreadable_status_cannot_consume_a_loop_nudge
  test_a_final_poll_leaves_an_unarmed_nudge_pending
  test_a_late_review_gets_its_own_grace_after_the_nudge
  test_an_unknown_boundary_uses_the_last_live_deadline
  test_nudges_wait_past_old_failed_and_stalled_states
  test_the_ending_line_names_the_round
  test_the_ending_line_claims_only_the_rounds_the_window_opened
  test_the_round_label_costs_no_request
  test_the_round_span_is_the_whole_watch
  test_an_unmoving_window_backs_off_to_the_review_cap
  test_a_new_head_in_one_state_resets_the_pause
  test_the_missing_environment_ends_the_wait_with_the_nudge
  test_the_connector_thread_reply_opens_no_round
  test_an_extension_holds_through_unknown_status
  test_a_nudge_buys_exactly_one_window
  test_an_ordinary_reply_or_old_nudge_does_not_reset_grace
  test_a_live_round_extends_the_quiet_window
  test_a_live_round_extension_is_bounded
  test_a_review_of_another_head_does_not_end_the_wait
  test_an_inline_finding_is_bound_by_the_commit_it_was_written_against
  test_identical_inline_threads_fold_into_one_entry
  test_threads_at_one_anchor_fold_with_every_body_shown
  test_threads_at_different_places_are_not_folded
  test_an_unrecognized_field_keeps_two_threads_apart
  test_the_anchor_fields_that_keep_two_rows_apart_are_on_the_line
  test_the_same_body_against_two_heads_is_not_folded
  test_rows_with_no_line_are_folded_only_when_their_positions_agree
  test_a_row_with_no_location_at_all_says_so
  test_a_summary_is_bound_by_the_commit_it_names
  test_an_unread_head_holds_nothing_back
  test_the_acting_exit_names_the_item
  test_the_quiet_exit_names_the_head_and_what_scrolled_past
  test_a_round_landing_after_the_last_loop_poll_is_still_caught
  test_a_verdict_polls_once_more_before_recommending_a_nudge
  test_a_verdict_that_still_stands_names_the_head_it_is_about
  test_a_final_poll_that_did_not_answer_withholds_the_verdict
  test_a_withheld_verdict_quotes_the_final_poll_s_error
  test_an_approval_landing_during_the_final_poll_drops_the_verdict
  test_a_state_that_moved_drops_the_verdict_as_quiet
  test_a_state_that_could_not_be_re_read_withholds_the_verdict
  test_a_body_that_quotes_an_item_header_is_not_an_item
  test_a_summary_is_stamped_by_its_footer_not_by_what_it_mentions
  test_the_review_clock_starts_no_earlier_than_the_pr
  test_a_future_commit_date_does_not_blind_the_clock
  test_a_clockless_expected_state_says_so_rather_than_guessing
  test_an_approval_over_findings_scrolled_past_is_not_clean
  test_an_approval_landing_in_the_final_poll_is_checked_too
  test_an_approval_beside_a_final_poll_round_is_checked_too
  test_a_live_round_that_reads_ended_twice_ends_on_the_nudge_advice
  test_a_stalled_round_ends_the_wait_with_its_verdict
  test_a_blind_window_is_not_a_quiet_one
  test_an_unread_head_is_named_unread_in_the_quiet_exit
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
