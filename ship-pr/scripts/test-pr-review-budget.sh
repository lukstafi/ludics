#!/usr/bin/env bash
# Focused fixture tests for pr-review.sh's polling budget (ludics-lite#543): the pause an observer
# takes between reads, the quota hold every process on the host shares, and the one observer per
# PR. The 2026-10-04 OCANNL wave exhausted the account's REST quota while approved heads waited
# for hosted macOS runners. Each `merge --wait` re-read every minute, a quota 403 ended it with
# exit 3 and its caller armed another, and recovery took a coordinator-wide hold, one observer per
# issue, and 300 s and 600 s polls. The three fixtures the issue names are the acceptance:
#
#   - a quota or transport failure stays UNKNOWN and never permits a merge, and while the hold
#     stands no command calls GitHub at all;
#   - an observer resumes only after a successful request to the endpoint that failed, read from
#     that endpoint's own headers (never /rate_limit), and a second observer of the PR is refused;
#   - a meaningful failure still ends the wait at once, while an unchanged queued poll prints
#     nothing and backs off toward the cap.
#
# The clock is a file: `date +%s` and `sleep` are suite functions that read and advance it, so the
# hold's end, the probes and the pauses are exact, and nothing here sleeps for real. The fixture
# gh answers every request from that clock: before QUOTA_UNTIL, as GitHub answers an exhausted
# quota (a 403 whose first stderr line says so, and `-i` headers naming the reset); after it, as
# the endpoint.
#
# Every case drives a command (ludics-lite#403): the commands are served by Python, which reads the
# clock file as SHIP_PR_TEST_CLOCK and calls the suite's `sleep` through the shell bridge, and the
# hold that stands is read off the state directory, whose format every version on a host shares.
# What no command line reaches (the parse of a run view whose options precede its id, lock_reap's
# race, a write inside an observer's ceiling) is pinned in lib/ludics/tests/test_prreview_budget.py.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=test-pr-review-lib.sh
source "$SCRIPT_DIR/test-pr-review-lib.sh"

# One brace group over everything below the preamble (ludics-lite#10, #247; the retry suite says
# why it opens below the sources).
{
test_tmpdir TEST_ROOT budget-test

REPO=example/repo
# The fixture's own name for the repository, which a case that runs a command with REPO cleared
# (base resolving it from the checkout) cannot take from under it.
FIXTURE_REPO="$REPO"
PR_NUM=7
HEAD_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
BASE_SHA=babababababababababababababababababababa
CALL_LOG="$TEST_ROOT/requests"
SLEEP_LOG="$TEST_ROOT/sleeps"
CLOCK="$TEST_ROOT/clock"
MERGE_LOG="$TEST_ROOT/merge-calls"
T0=$(command date +%s)
export SHIP_PR_TEST_CLOCK="$CLOCK"

CHECKS_SEQ=()
QUOTA_UNTIL=0        # fake epoch before which every request answers quota
QUOTA_RESET=""       # the reset its headers name ("" = the quota's own end)
QUOTA_ENDPOINT=""    # a glob: only this endpoint answers quota (empty: every endpoint)
QUOTA_RESETS=()      # per probe, in order, when a case wants the reset to move
FAIL_502=""          # an endpoint glob that answers 502 (transport)
PROBE_ANSWERS=""     # nonempty: a probe answers even during the quota (a secondary limit on the
                     # refused operation, which the probe's cheaper request does not meet)
PROBE_HOOK=""        # run as a probe answers: what lands meanwhile, e.g. another refusal's hold
READ_HOOK=""         # run as any other request arrives (FIXTURE_ENDPOINT set): what lands first
REPO_VIEW_QUOTA=""   # nonempty: `gh repo view` is refused on quota
RUN_STATUSES=()      # the run await's reads, in order ("" = completed at once)
GRAPHQL_PROBE=""     # how GraphQL's probe answers: "" (200, quota left), exhausted (a 200 with
                     # Remaining 0), secondary (a 200 whose body says so, no header)

# A merge that passes its gate reads on before its call: the drift and the commit series (which the
# fixture's PR answers too thinly to judge, a warning each and no stop) and the open review threads
# (none open). A case that wants something to land after the gate hooks those reads.

# The clock. `date +%s` is every reader's (the budget's and the gate's); any other form is the
# real date's.
date() {
  if [ "$*" = "+%s" ]; then
    cat "$CLOCK"
  else
    command date "$@"
  fi
}
SLEEP_HOOK=""         # run on every sleep: what happens while this process sleeps
sleep() {
  [ -z "$SLEEP_HOOK" ] || eval "$SLEEP_HOOK"
  printf '%s\n' "$1" >>"$SLEEP_LOG"
  printf '%s' "$(($(cat "$CLOCK") + $1))" >"$CLOCK"
}
now() { cat "$CLOCK"; }

next_check() {
  local counter="$TEST_ROOT/checks.calls" idx
  idx=$(cat "$counter" 2>/dev/null) || idx=0
  printf '%s' "$((idx + 1))" >"$counter"
  [ "$idx" -lt "${#CHECKS_SEQ[@]}" ] || idx=$((${#CHECKS_SEQ[@]} - 1))
  printf '%s' "${CHECKS_SEQ[$idx]}"
}
# The state the gate reads, one word per read: pending, green or red; or queued and running, a
# head with no check row yet whose workflow run is queued or in progress.
check_runs() {
  case "$1" in
  queued | running) printf '{"check_runs":[]}' ;;
  pending) printf '{"check_runs":[{"name":"build","status":"in_progress","conclusion":null,"html_url":"u","check_suite":{"id":1}}]}' ;;
  green) printf '{"check_runs":[{"name":"build","status":"completed","conclusion":"success","html_url":"u","check_suite":{"id":1}}]}' ;;
  red) printf '{"check_runs":[{"name":"build","status":"completed","conclusion":"failure","html_url":"u","check_suite":{"id":1}}]}' ;;
  esac
}
workflow_runs() {
  local status=completed conclusion=success
  case "$1" in
  pending | running) status=in_progress conclusion=null ;;
  queued) status=queued conclusion=null ;;
  red) conclusion=failure ;;
  esac
  jq -cn --arg s "$status" --arg c "$conclusion" --arg sha "$HEAD_SHA" \
    '{workflow_runs:[{id:101, workflow_id:1, name:"ci", event:"pull_request", head_sha:$sha,
       status:$s, conclusion:(if $c == "null" then null else $c end),
       created_at:"2026-10-04T00:00:00Z"}]}'
}

probe_reset() {
  local counter="$TEST_ROOT/probes" idx
  idx=$(cat "$counter" 2>/dev/null) || idx=0
  printf '%s' "$((idx + 1))" >"$counter"
  if [ "$idx" -lt "${#QUOTA_RESETS[@]}" ]; then
    printf '%s' "${QUOTA_RESETS[$idx]}"
  else
    printf '%s' "${QUOTA_RESET:-$QUOTA_UNTIL}"
  fi
}

gh() {
  local include="" a body state REPO="$FIXTURE_REPO"
  if [ "${1:-} ${2:-}" = "pr merge" ]; then
    printf '%s\n' "$*" >>"$MERGE_LOG"
    return 0
  fi
  if [ "${1:-} ${2:-}" = "repo view" ]; then
    printf 'repo view\n' >>"$CALL_LOG"
    if [ -n "$REPO_VIEW_QUOTA" ]; then
      echo "GraphQL: API rate limit exceeded for user ID 1." >&2
      return 1
    fi
    printf '%s\n' "$REPO"
    return 0
  fi
  if [ "${1:-} ${2:-}" = "run view" ]; then
    printf 'run %s\n' "$3" >>"$CALL_LOG"
    if [ "$(now)" -lt "$QUOTA_UNTIL" ]; then
      echo "gh: API rate limit exceeded for user ID 1. (HTTP 403)" >&2
      return 1
    fi
    if [ "${#RUN_STATUSES[@]}" -gt 0 ]; then
      a=$(cat "$TEST_ROOT/runs.calls" 2>/dev/null) || a=0
      printf '%s' "$((a + 1))" >"$TEST_ROOT/runs.calls"
      [ "$a" -lt "${#RUN_STATUSES[@]}" ] || a=$((${#RUN_STATUSES[@]} - 1))
      case "${RUN_STATUSES[$a]}" in
      completed) printf 'completed\tsuccess\n' ;;
      *) printf '%s\tpending\n' "${RUN_STATUSES[$a]}" ;;
      esac
      return 0
    fi
    printf 'completed\tsuccess\n'
    return 0
  fi
  local host="" next="" method=""
  for a in "$@"; do
    [ -z "$next" ] || { host="$a" next=""; }
    case "$a" in -i | --include) include=1 ;; --hostname) next=1 ;; -X | --method) method=1 ;; esac
  done
  # A probe is the call with headers that names no method (a GET, or GraphQL's viewer query). The
  # script's own writes carry --include too (ludics-lite#612), and they always name theirs.
  [ -z "$method" ] || include=""
  # A probe names github.com itself, whatever GH_HOST says.
  [ -z "$include" ] || [ "$host" = github.com ] || printf 'probe to %s\n' "${host:-GH_HOST}" >>"$CALL_LOG"
  gh_fixture_parse "$@"
  if [ -n "$FAIL_502" ]; then
    # shellcheck disable=SC2254 # a glob on purpose
    case "$FIXTURE_ENDPOINT" in $FAIL_502)
      echo "gh: Bad Gateway (HTTP 502)" >&2
      return 1
      ;;
    esac
  fi
  [ -n "$include" ] || [ -z "$READ_HOOK" ] || eval "$READ_HOOK"
  # shellcheck disable=SC2254 # a glob on purpose
  if [ "$(now)" -lt "$QUOTA_UNTIL" ] && { [ -z "$include" ] || [ -z "$PROBE_ANSWERS" ]; } &&
    case "$FIXTURE_ENDPOINT" in ${QUOTA_ENDPOINT:-*}) true ;; *) false ;; esac; then
    if [ -n "$include" ]; then
      [ -z "$PROBE_HOOK" ] || eval "$PROBE_HOOK"
      printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: %s\r\n\r\n{"message":"API rate limit exceeded"}\n' "$(probe_reset)"
      printf 'probe %s\n' "$FIXTURE_ENDPOINT" >>"$CALL_LOG"
    else
      printf 'read %s quota\n' "$FIXTURE_ENDPOINT" >>"$CALL_LOG"
    fi
    echo "gh: API rate limit exceeded for user ID 1. If you reach out to GitHub Support for help, please include the request ID A:B. (HTTP 403)" >&2
    return 1
  fi
  if [ -n "$include" ]; then
    printf 'probe %s ok\n' "$FIXTURE_ENDPOINT" >>"$CALL_LOG"
    [ -z "$PROBE_HOOK" ] || eval "$PROBE_HOOK"
    case "$FIXTURE_ENDPOINT $GRAPHQL_PROBE" in
    "graphql exhausted")
      printf 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: %s\r\n\r\n{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded for user ID 1."}]}\n' "$((T0 + 2400))"
      ;;
    "graphql secondary")
      printf 'HTTP/2.0 200 OK\r\n\r\n{"errors":[{"message":"You have exceeded a secondary rate limit."}]}\n'
      ;;
    *) printf 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4999\r\n\r\n{}\n' ;;
    esac
    return 0
  fi
  printf 'read %s\n' "$FIXTURE_ENDPOINT" >>"$CALL_LOG"
  case "$FIXTURE_ENDPOINT" in
  "repos/$REPO/pulls/7")
    # Merged once a merge call has gone out, as merge's read after its call wants it.
    a=false state=open
    [ ! -s "$MERGE_LOG" ] || a=true state=closed
    body=$(jq -cn --arg sha "$HEAD_SHA" --arg base "$BASE_SHA" --argjson merged "$a" --arg state "$state" \
      '{head:{sha:$sha, ref:"topic"}, base:{sha:$base}, updated_at:"2026-10-04T00:00:00Z",
        merged:$merged, state:$state, mergeable:true, mergeable_state:"clean"}')
    ;;
  "repos/$REPO/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100")
    state=$(next_check)
    printf '%s' "$state" >"$TEST_ROOT/state"
    body=$(check_runs "$state")
    ;;
  "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100")
    body=$(workflow_runs "$(cat "$TEST_ROOT/state")")
    ;;
  "repos/$REPO/contents/.github/ship-pr-advisory-checks")
    body='^claude$'
    ;;
  # No merge-build config (ludics-lite#611), which merge looks for when its drift read is UNKNOWN
  # (this fixture's PR carries no base ref): a 404 the listing confirms.
  "repos/$REPO/contents/.github/ship-pr-merge-build")
    echo "gh: Not Found (HTTP 404)" >&2
    return 1
    ;;
  "repos/$REPO/contents/.github") body='[{"name":"ship-pr-advisory-checks","type":"file"}]' ;;
  "repos/ghe/repo") body='{}' ;;
  # `base`'s read of the repository it resolved: no default branch, so it stops there (exit 3).
  "repos/$REPO") body='{"default_branch":""}' ;;
  # The open review threads a merge reads after its gate: none.
  graphql) body=$(review_threads_answer '[]' "$@") ;;
  "repos/$REPO/actions/runs/101/jobs?per_page=100")
    body='{"jobs":[{"name":"build","status":"in_progress","conclusion":null,"created_at":"2026-10-04T00:00:00Z","completed_at":null}]}'
    ;;
  *) bail "the fixture has no answer for $FIXTURE_ENDPOINT" ;;
  esac
  gh_fixture_answer "$body"
}

reset_fixture() {
  STATE_DIR="$TEST_ROOT/state-dir"
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  # Assigned, not retuned: on a base without the budget these names mean nothing, and the cases
  # must then fail on what the commands DO, not on a refused retune.
  BUDGET_DIR="$STATE_DIR"
  BUILD_POLL_CAP=600
  REVIEW_POLL_CAP=300
  retune CHECKS_INTERVAL=60 CHECKS_HEARTBEAT=7200 ADVISORY_FROM_ENV=1
  printf '%s' "$T0" >"$CLOCK"
  : >"$CALL_LOG"
  : >"$SLEEP_LOG"
  : >"$MERGE_LOG"
  rm -f "$TEST_ROOT/checks.calls" "$TEST_ROOT/probes" "$TEST_ROOT/state" "$TEST_ROOT/hooked" \
    "$TEST_ROOT/holder" "$TEST_ROOT/holder-live"
  CHECKS_SEQ=(green)
  QUOTA_UNTIL=0
  QUOTA_RESET=""
  QUOTA_RESETS=()
  FAIL_502=""
  PROBE_ANSWERS=""
  PROBE_HOOK=""
  READ_HOOK=""
  GRAPHQL_PROBE=""
  REPO_VIEW_QUOTA=""
  QUOTA_ENDPOINT=""
  SLEEP_HOOK=""
  RUN_STATUSES=()
  rm -f "$TEST_ROOT/runs.calls"
  retune ADVISORY_FROM_ENV=1
}

# run <var-prefix> <command...>: runs it in a subshell (the commands exit), keeping stdout, stderr
# and status.
run() {
  local name="$1" rc
  shift
  set +e
  ("$@") >"$TEST_ROOT/$name.out" 2>"$TEST_ROOT/$name.err"
  rc=$?
  set -e
  printf '%s' "$rc" >"$TEST_ROOT/$name.rc"
}
out() { cat "$TEST_ROOT/$1.out"; }
err() { cat "$TEST_ROOT/$1.err"; }
rc() { cat "$TEST_ROOT/$1.rc"; }
requests() { cat "$CALL_LOG"; }
# plant_hold <until> <endpoint> <length>: one hold entry, as a refusal leaves it.
plant_hold() {
  mkdir -p "$STATE_DIR/quota-holds"
  printf '%s\t%s\t%s\n' "$2" "$3" "its headers" >"$STATE_DIR/quota-holds/$1.planted.$RANDOM"
}
# The hold that stands, as every reader sees it: "<until> TAB <endpoint> TAB <length>", or nothing.
# Read off the state directory the way every version reads it (the entry with the latest end; a line
# it did not write is no hold), so it judges whichever implementation serves the commands.
standing() {
  local f u best="" best_until=0 ep="" len="" src=""
  for f in "$STATE_DIR/quota-holds"/[0-9]*; do
    [ -f "$f" ] || continue
    u="${f##*/}"
    u="${u%%.*}"
    case "$u" in '' | *[!0-9]*) continue ;; esac
    [ "$u" -gt "$best_until" ] || continue
    best="$f"
    best_until="$u"
  done
  [ -n "$best" ] || return 0
  IFS=$'\t' read -r ep len src <"$best" 2>/dev/null || return 0
  case "$len" in '' | *[!0-9]*) return 0 ;; esac
  [ -n "$ep" ] && [ -n "$src" ] || return 0
  printf '%s\t%s\t%s' "$best_until" "$ep" "$len"
}
# Every entry's endpoint, sorted, as one line.
entries() { cat "$STATE_DIR/quota-holds"/[0-9]* | cut -f1 | sort | tr '\n' ' '; }

# --- fixture 1: a quota or transport failure stays unknown and never permits a merge ------------

test_a_quota_refusal_is_unknown_and_holds_every_caller() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 1800))
  run merge1 cmd_merge "$REPO#7"
  assert_eq "$(rc merge1)" 3 "a merge whose gate read was refused on quota is UNKNOWN ($(err merge1))"
  assert_eq "$(cat "$MERGE_LOG")" "" "and it never calls the merge"
  assert_contains "$(err merge1)" "UNKNOWN" "the refusal says the signal is unknown"
  assert_contains "$(requests)" "probe repos/$REPO/pulls/7" \
    "the quota's end is read from the failing endpoint itself"
  assert_not_contains "$(requests)" "rate_limit" "and never from /rate_limit"
  assert_eq "$(standing | cut -f1-2)" "$((T0 + 1800))	repos/$REPO/pulls/7" \
    "the hold ends where that endpoint's X-RateLimit-Reset says, and names the endpoint"

  # Every later caller on the host, while the hold stands: no call at all, still UNKNOWN.
  : >"$CALL_LOG"
  printf '%s' "$((T0 + 600))" >"$CLOCK"
  run merge2 cmd_merge "$REPO#7"
  assert_eq "$(rc merge2)" 3 "a merge during the hold is UNKNOWN ($(err merge2))"
  assert_eq "$(requests)" "" "and makes no request while the hold stands"
  assert_eq "$(cat "$MERGE_LOG")" "" "and never merges"
  assert_contains "$(err merge2)" "quota hold until" "it says why nothing was read"
  run checks2 cmd_checks "$REPO#7"
  assert_eq "$(rc checks2)" 3 "a single checks read during the hold is UNKNOWN"
  assert_contains "$(out checks2)" "checks: verdict=unknown" "with the unknown trailer"
  assert_eq "$(requests)" "" "and makes no request either"

  # The await of one run: a quota answer about the run is not "no such run" (exit 2) either.
  rm -rf "$STATE_DIR/quota-holds"
  : >"$CALL_LOG"
  printf '%s' "$T0" >"$CLOCK"
  BUDGET_DIR=""
  run await cmd_retry run watch "$REPO#55"
  assert_eq "$(rc await)" 3 "a quota refusal of the run read is UNKNOWN, not an invocation error ($(err await))"
  assert_not_contains "$(err await)" "has no run" "and is not reported as a missing run"
}

test_a_transport_failure_is_unknown_and_never_merges() {
  reset_fixture
  FAIL_502="repos/$REPO/commits/*/check-runs*"
  run merge cmd_merge "$REPO#7"
  assert_eq "$(rc merge)" 3 "a gate read that never answered is UNKNOWN ($(err merge))"
  assert_eq "$(cat "$MERGE_LOG")" "" "and it never calls the merge"
  assert_eq "$(standing)" "" "transport sets no quota hold"
}

# --- fixture 2: observers resume from verified endpoint recovery, without duplicates -----------

test_an_observer_resumes_only_after_the_failing_endpoint_answers() {
  local reads
  reset_fixture
  CHECKS_SEQ=(pending green)
  # The quota ends at +1800, but the first probe's headers name +1200: the probe at +1200 still
  # finds it exhausted (naming +1800 now), so the hold is set again from those headers.
  QUOTA_UNTIL=$((T0 + 1800))
  QUOTA_RESETS=($((T0 + 1200)) $((T0 + 1800)))
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 0 "the observer waits the hold out and reads the green ($(err wait))"
  assert_contains "$(out wait)" "green" "the verdict is the head's own"
  reads=$(requests)
  assert_eq "$(printf '%s\n' "$reads" | sed -n 1,4p)" "read repos/$REPO/pulls/7 quota
probe repos/$REPO/pulls/7
probe repos/$REPO/pulls/7
probe repos/$REPO/pulls/7 ok" \
    "after the refusal, nothing but probes of that endpoint until one answers"
  assert_eq "$(printf '%s\n' "$reads" | sed -n 5p)" "read repos/$REPO/pulls/7" \
    "and then the refused read is repeated"
  assert_eq "$(sed -n 1,2p "$SLEEP_LOG" | tr '\n' ' ')" "1200 600 " \
    "it sleeps to each reset its headers named, and calls nothing in between"
  assert_eq "$(err wait | grep -c 'quota hold:')" 2 "one line per hold"
  assert_eq "$(err wait | grep -c 'quota hold lifted')" 1 "and one when the endpoint answers again"
  assert_eq "$(standing)" "" "the hold is gone once it answered"
}

test_a_second_observer_of_the_pr_is_refused() {
  local holder
  reset_fixture
  command sleep 300 &
  holder=$!
  mkdir -p "$STATE_DIR/observers/example~repo#7.build"
  printf '%s\n%s\n' "$holder" "$T0" >"$STATE_DIR/observers/example~repo#7.build/owner"
  run second cmd_checks "$REPO#7" --wait
  assert_eq "$(rc second)" 2 "a second build observer of the PR is refused ($(err second))"
  assert_contains "$(err second)" "pid $holder" "naming the one already observing"
  assert_eq "$(requests)" "" "having read nothing"
  # Refused before the preflight reads too: the repository's advisory list, and merge's body.
  retune ADVISORY_FROM_ENV=
  run second_checks cmd_checks "$REPO#7" --wait
  run second_merge cmd_merge "$REPO#7" --wait
  retune ADVISORY_FROM_ENV=1
  # The review observer is another kind: a second watch of the PR is refused alike.
  mkdir -p "$STATE_DIR/observers/example~repo#7.review"
  printf '%s\n%s\n' "$holder" "$T0" >"$STATE_DIR/observers/example~repo#7.review/owner"
  run second_watch eval 'WATCH_INTERVAL=1 WATCH_TIMEOUT=1 cmd_watch 7 0,0,0'
  kill "$holder" 2>/dev/null || :
  wait "$holder" 2>/dev/null || :
  assert_eq "$(rc second_checks) $(rc second_merge)" "2 2" \
    "checks --wait and merge --wait are refused alike ($(err second_checks) / $(err second_merge))"
  assert_eq "$(rc second_watch)" 2 "and so is a second watch ($(err second_watch))"
  assert_contains "$(err second_watch)" "review observer: pid $holder" "naming the one already watching"
  assert_eq "$(requests)" "" "before any read of their own"
  # The holder is gone now: its lock is replaced, and a single read never takes one.
  run third cmd_checks "$REPO#7" --wait
  assert_eq "$(rc third)" 0 "a holder that is no longer running is replaced ($(err third))"
  run plain cmd_checks "$REPO#7"
  assert_eq "$(rc plain)" 0 "a plain read is no observer and is never refused"
}

# Under Git Bash a lock names an MSYS pid, whoever wrote it, and MSYS numbers its processes apart
# from Windows: a live WINDOWS process of the lock's number is no holder. (Run 38235190240: a dead
# holder's MSYS pid 2380 was also an svchost.exe's Windows pid, and the next observer was refused.)
test_a_windows_process_of_the_number_is_no_holder() {
  local p winpid=""
  case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *)
    echo "SKIP test_a_windows_process_of_the_number_is_no_holder: only Git Bash numbers a process twice"
    return 0
    ;;
  esac
  reset_fixture
  # A running Windows process whose number no MSYS process has: this shell's own, unless MSYS has
  # that number too.
  for p in "/proc/$$" /proc/[0-9]*; do
    winpid=$(cat "$p/winpid" 2>/dev/null) || continue
    kill -0 "$winpid" 2>/dev/null || break
    winpid=""
  done
  assert_eq "${winpid:+found}" found "a running Windows pid that is no MSYS pid"
  mkdir -p "$STATE_DIR/observers/example~repo#7.build"
  printf '%s\n%s\n' "$winpid" "$T0" >"$STATE_DIR/observers/example~repo#7.build/owner"
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 0 "a lock naming Windows pid $winpid is replaced ($(err wait))"
}

# And this port's own observer is held by the pid the shell's kill -0 reads: a second observer
# started while the first waits is refused, naming it.
test_a_running_observer_is_refused_by_the_shells_pid() {
  reset_fixture
  CHECKS_SEQ=(pending green)
  SLEEP_HOOK='[ -e "$TEST_ROOT/hooked" ] || {
    : >"$TEST_ROOT/hooked"
    head -n 1 "$STATE_DIR/observers/example~repo#7.build/owner" >"$TEST_ROOT/holder"
    if kill -0 "$(cat "$TEST_ROOT/holder")" 2>/dev/null; then echo live >"$TEST_ROOT/holder-live"; fi
    # The second is the port itself, run as the forward runs it: this hook is a fresh bash (the
    # bridge), where the sourced pr-review.sh no longer knows its own path.
    run second "$SCRIPT_DIR/../../scripts/py" -m ludics.prreview checks "$REPO#7" --wait
  }'
  run first cmd_checks "$REPO#7" --wait
  assert_eq "$(rc first)" 0 "the first observer reads the green ($(err first))"
  assert_eq "$(cat "$TEST_ROOT/holder-live" 2>/dev/null)" live \
    "its lock names a pid the shell's kill -0 reaches ($(cat "$TEST_ROOT/holder" 2>/dev/null))"
  assert_eq "$(rc second)" 2 "a second observer started while it waits is refused ($(err second))"
  assert_contains "$(err second)" "pid $(cat "$TEST_ROOT/holder" 2>/dev/null)," "naming the first"
}

test_one_process_probes_an_ended_hold() {
  local holder
  reset_fixture
  plant_hold "$((T0 - 1))" "repos/$REPO/pulls/7" 600
  command sleep 300 &
  holder=$!
  mkdir -p "$STATE_DIR/quota-probe"
  printf '%s\n%s\n' "$holder" "$T0" >"$STATE_DIR/quota-probe/owner"
  run single cmd_checks "$REPO#7"
  kill "$holder" 2>/dev/null || :
  wait "$holder" 2>/dev/null || :
  assert_eq "$(rc single)" 3 "while another process probes the ended hold, a read is UNKNOWN ($(err single))"
  assert_eq "$(requests)" "" "and sends nothing of its own"
  run after cmd_checks "$REPO#7"
  assert_eq "$(rc after)" 0 "once that prober is gone, the next caller probes and proceeds ($(err after))"
  assert_eq "$(requests | sed -n 1p)" "probe repos/$REPO/pulls/7 ok" "probing the held endpoint first"
}

# A secondary limit can refuse the operation and not the probe's cheaper GET. The probe answering
# is then no evidence the operation may go again: the backoff hold is set all the same, and it
# doubles from the last one while the operation keeps being refused.
test_a_probe_that_answers_still_holds_the_refused_operation() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  PROBE_ANSWERS=1
  run first cmd_checks "$REPO#7"
  assert_eq "$(rc first)" 3 "the refused read is UNKNOWN ($(err first))"
  assert_eq "$(standing | cut -f1,3)" "$((T0 + 60))	60" \
    "a minute's hold although the probe answered"
  printf '%s' "$((T0 + 60))" >"$CLOCK"
  : >"$CALL_LOG"
  run second cmd_checks "$REPO#7"
  assert_eq "$(rc second)" 3 "refused again after the lift ($(err second))"
  assert_eq "$(requests | sed -n 1,2p)" "probe repos/$REPO/pulls/7 ok
read repos/$REPO/pulls/7 quota" "the ended hold is probed, lifted, and the read refused again"
  assert_eq "$(standing | cut -f3)" 120 "so the next hold doubles"
}

# Requests in flight when the quota ran out each come back refused, and the last must not cut
# short a longer hold another one set: the hold is only ever extended while it stands.
# The longer hold lands while this refusal's probe is out (another request's refusal), so it is
# standing when the probe's own reset is recorded.
test_a_later_refusal_never_shortens_the_hold() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  QUOTA_RESET=$((T0 + 60))
  PROBE_HOOK='plant_hold "$((T0 + 3600))" graphql 3600'
  run first cmd_checks "$REPO#7"
  assert_eq "$(rc first)" 3 "the refused read is UNKNOWN ($(err first))"
  assert_eq "$(standing | cut -f1-2)" "$((T0 + 3600))	graphql" \
    "an earlier reset leaves the standing hold as it was"
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  QUOTA_RESET=$((T0 + 5400))
  PROBE_HOOK='plant_hold "$((T0 + 3600))" graphql 3600'
  run second cmd_checks "$REPO#7"
  assert_eq "$(standing | cut -f1-2)" "$((T0 + 5400))	repos/$REPO/pulls/7" \
    "a later one extends it"
}

# A write never waits a hold out: its caller read the write's preconditions just before it, and
# sending it after the hold would act on reads the hold has made stale. A read in an observer does
# wait. (The one write an observer makes, watch's re-request, is pinned with the observer's own
# ceiling set in test_prreview_budget.py.)
test_a_write_never_waits_a_hold() {
  reset_fixture
  plant_hold "$((T0 + 600))" "repos/$REPO/pulls/7" 600
  run write cmd_comment "$REPO#7" "a note"
  assert_eq "$(rc write)" 3 "a write during a hold is not sent ($(err write))"
  assert_eq "$(requests)" "" "no request at all"
  assert_eq "$(cat "$SLEEP_LOG")" "" "and no wait"
  run read cmd_checks "$REPO#7" --wait
  assert_eq "$(rc read)" 0 "a read in an observer waits the hold out ($(err read))"
  assert_eq "$(cat "$SLEEP_LOG")" 600 "for exactly the hold"
}

# A prober that died between taking the lock and writing its owner leaves an ownerless lock. It is
# given a second (a claimant mid-write), then replaced, rather than locking every caller out.
test_an_ownerless_probe_lock_is_recovered() {
  reset_fixture
  plant_hold "$((T0 - 1))" "repos/$REPO/pulls/7" 600
  mkdir -p "$STATE_DIR/quota-probe"
  run single cmd_checks "$REPO#7"
  assert_eq "$(rc single)" 0 "the ownerless lock is replaced and the hold probed ($(err single))"
  assert_eq "$(cat "$SLEEP_LOG")" 1 "after the second a claimant mid-write is owed"
  assert_eq "$(requests | sed -n 1p)" "probe repos/$REPO/pulls/7 ok" "probing the held endpoint first"
}

# The ceiling a hold is waited out within is the wait's own: both run from one timestamp taken
# before the first read, so a hold at the start uses up the wait rather than extending it.
test_a_hold_at_the_start_counts_toward_the_ceiling() {
  reset_fixture
  CHECKS_SEQ=(pending)
  QUOTA_UNTIL=$((T0 + 300))
  run wait cmd_checks "$REPO#7" --wait=600
  assert_eq "$(rc wait)" 4 "a queue still running at the ceiling is no verdict ($(err wait))"
  assert_eq "$(now)" "$((T0 + 600))" "and the ceiling is 600 s from the start, the hold included"
  # ... and from the command's start, not the gate's: a hold met by the preflight read of the
  # repository's advisory list uses the wait up too.
  reset_fixture
  retune ADVISORY_FROM_ENV=
  CHECKS_SEQ=(pending)
  QUOTA_UNTIL=$((T0 + 300))
  run wait cmd_checks "$REPO#7" --wait=600
  assert_eq "$(rc wait)" 4 "the same with the advisory list read first ($(err wait))"
  assert_contains "$(requests | sed -n 1p)" "contents/.github/ship-pr-advisory-checks" "which met the hold"
  assert_eq "$(now)" "$((T0 + 600))" "and the ceiling still runs from the command's start"
}

# `base` resolves a repository from the checkout with `gh repo view`, a call GhSession.retry never sees,
# so it passes the hold's gate itself. A standing hold is exit 3, never a fall back to the origin
# remote (in a fork that names the fork, not the repository gh resolved); an ended one is probed
# and lifted first, as for any read.
# Driven through `base` with no repository named; the fixture's answer for the repository it
# resolves has no default branch, so `base` stops right after the resolution (exit 3), and the
# request log says what the resolution did.
test_resolving_the_repo_passes_the_hold() {
  reset_fixture
  run control eval 'REPO=; cmd_base'
  assert_eq "$(requests | tr '\n' '|')" "repo view|read repos/$REPO|" \
    "with no hold, gh is asked, and the repository it names is the one read"
  : >"$CALL_LOG"
  plant_hold "$((T0 + 600))" graphql 600
  run held eval 'REPO=; cmd_base'
  assert_eq "$(rc held)" 3 "a standing hold is exit 3 ($(err held))"
  assert_contains "$(err held)" "could not resolve the repository from the checkout: quota hold until" \
    "with no repository guessed from the remote"
  assert_eq "$(out held)" "" "and nothing on stdout"
  assert_eq "$(requests)" "" "and gh is not asked"
  printf '%s' "$((T0 + 600))" >"$CLOCK"
  run ended eval 'REPO=; cmd_base'
  assert_eq "$(requests | tr '\n' '|')" "probe graphql ok|repo view|read repos/$REPO|" \
    "an ended hold is probed and lifted, then gh is asked ($(err ended))"
  # gh repo view refused on quota itself: a hold like any other call's, and still no guess.
  reset_fixture
  REPO_VIEW_QUOTA=1
  run refused eval 'REPO=; cmd_base'
  assert_eq "$(rc refused)" 3 "a quota refusal of gh repo view is exit 3 ($(err refused))"
  assert_contains "$(err refused)" "gh repo view was refused on quota" "with no repository guessed from the remote"
  assert_eq "$(out refused)" "" "and nothing on stdout"
  assert_eq "$(standing | cut -f2)" graphql "and it sets the hold, on GraphQL"
}

# base --wait waits a hold out within its ceiling (ludics-lite#551) from its first read: with no
# branch named, that is the read of the default branch, before the branch's observer is known.
# (The fixture's repository has no default branch, so base stops right after that read, exit 3.)
test_base_wait_waits_a_hold_from_its_first_read() {
  reset_fixture
  plant_hold "$((T0 + 600))" graphql 600
  run base eval 'REPO=; cmd_base "$FIXTURE_REPO" --wait=1200'
  assert_eq "$(cat "$SLEEP_LOG")" 600 "the hold is waited out ($(err base))"
  assert_eq "$(requests | tr '\n' '|')" "probe graphql ok|read repos/$REPO|" \
    "then the default branch is read"
  assert_eq "$(rc base)" 3 "which the fixture leaves empty"
  # Without --wait, the same hold is exit 3 at once.
  reset_fixture
  plant_hold "$((T0 + 600))" graphql 600
  run once eval 'REPO=; cmd_base "$FIXTURE_REPO"'
  assert_eq "$(rc once) $(cat "$SLEEP_LOG")" "3 " "no wait without --wait ($(err once))"
  assert_eq "$(requests)" "" "and no request"
}

# Entries for different endpoints end separately and are probed separately: GraphQL and REST have
# separate quotas, so one answering lifts only its own entries, and the gate then probes the next.
test_each_endpoint_is_probed_before_its_hold_lifts() {
  reset_fixture
  plant_hold "$((T0 - 10))" "repos/$REPO/pulls/7" 600
  plant_hold "$((T0 - 1))" graphql 600
  run single cmd_checks "$REPO#7"
  assert_eq "$(rc single)" 0 "both answer, and the read goes out ($(err single))"
  assert_eq "$(requests | sed -n 1,3p | tr '\n' '|')" "probe graphql ok|probe repos/$REPO/pulls/7 ok|read repos/$REPO/pulls/7|" \
    "the latest entry's endpoint first, then the other's, each before its own entries go"
  assert_eq "$(standing)" "" "and nothing stands after"
}

# The run await is an observer too: a run that stays queued backs off toward the build cap.
test_the_run_await_backs_off_on_a_still_run() {
  reset_fixture
  RUN_STATUSES=(queued queued queued queued completed)
  run await cmd_retry run watch "$REPO#55"
  assert_eq "$(rc await)" 0 "the run's green is the verdict ($(err await))"
  assert_eq "$(tr '\n' ' ' <"$SLEEP_LOG")" "60 120 240 480 " "an unchanged status doubles the pause"
}

# The endpoint a `run view` probe addresses: the run itself, not a value of the read's own options
# (`--json status,conclusion`). Every value-taking option's value is consumed first, whatever the
# order (test_prreview_budget.py: no command here puts an option before the id).
test_a_run_view_probe_finds_the_run_id() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 600))
  run await cmd_retry run watch "$REPO#123"
  assert_eq "$(rc await)" 0 "the await waits the hold out and reads the run ($(err await))"
  assert_contains "$(requests)" "probe repos/$REPO/actions/runs/123" "the probe addresses the run"
  assert_not_contains "$(requests)" "status,conclusion" "and no option's value"
}

# A lock that cannot be made at all (here: its parent is a file) is an error, status 2, at once:
# not a holder to wait on forever.
# Requests in flight when the quota ran out come back refused together. Only one of them probes:
# a refusal while a hold already stands, or while another probe runs, adds its endpoint's backoff
# entry unprobed, for the gate to probe in turn once it has ended.
# The request in flight is refused just after another request's refusal set a hold (the fixture
# plants it as this one arrives). A run view with no repository named anywhere has no endpoint to
# probe, and sets nothing: test_prreview_budget.py (every run view of this script names one).
test_refusals_behind_a_hold_or_a_probe_are_not_probed() {
  local holder
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  READ_HOOK='[ "$FIXTURE_ENDPOINT" != "repos/$REPO/pulls/7" ] || plant_hold "$((T0 + 600))" graphql 600'
  run single cmd_checks "$REPO#7"
  assert_eq "$(rc single)" 3 "the refused read is UNKNOWN ($(err single))"
  assert_eq "$(requests)" "read repos/$REPO/pulls/7 quota" "no probe while a hold stands"
  assert_eq "$(entries)" "graphql repos/$REPO/pulls/7 " \
    "but the endpoint's own entry is added beside the standing one, for its turn"
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  command sleep 300 &
  holder=$!
  mkdir -p "$STATE_DIR/quota-probe"
  printf '%s\n%s\n' "$holder" "$T0" >"$STATE_DIR/quota-probe/owner"
  run single cmd_checks "$REPO#7"
  kill "$holder" 2>/dev/null || :
  wait "$holder" 2>/dev/null || :
  assert_eq "$(requests)" "read repos/$REPO/pulls/7 quota" "no probe while another one runs"
  assert_eq "$(standing | cut -f2)" "repos/$REPO/pulls/7" "and the entry is there all the same"
}

# GH_HOST never redirects a probe: an await that names github.com is in the budget whatever GH_HOST
# says, and its probe names github.com itself. (GH_REPO naming a run view's repository when no -R
# does: test_prreview_budget.py.)
test_a_probe_follows_the_environment_gh_reads() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 600))
  run await eval 'GH_HOST=ghe.example.com cmd_retry run watch 55 -R "github.com/$REPO"'
  assert_eq "$(rc await)" 0 "the await waits the hold out ($(err await))"
  assert_contains "$(requests)" "probe repos/$REPO/actions/runs/55 ok" "the probe answers"
  assert_not_contains "$(requests)" "probe to" "on github.com, named on the probe itself"
}

# The hold is checked again once the probe lock is held: another refusal can probe and set a hold
# between the first check and the lock, and a second probe then would be the burst again.
# The other refusal wins the race while this process takes the lock: the lock it meets is ownerless
# (a claimant mid-write), and in the second it is given the hold lands.
test_a_hold_set_before_the_lock_stops_the_probe() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  mkdir -p "$STATE_DIR/quota-probe"
  SLEEP_HOOK='plant_hold "$((T0 + 600))" graphql 600'
  run single cmd_checks "$REPO#7"
  assert_eq "$(rc single)" 3 "the refused read is UNKNOWN ($(err single))"
  assert_eq "$(requests)" "read repos/$REPO/pulls/7 quota" "no probe once a hold stands under the lock"
  assert_eq "$(entries)" "graphql repos/$REPO/pulls/7 " "the refusal's entry is added unprobed"
}

# The script's own calls name no host, so gh sends them to GH_HOST when it is set: an Enterprise
# GH_HOST puts them outside the budget. A job-only run view reads the job.
# A GH_HOST naming another host would put the calls out of the budget, so it is refused before
# any call (ludics-lite#551). (A job-only run view reading the job: test_prreview_budget.py.)
test_the_scope_and_the_job_read_what_gh_reads() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  run ghe eval 'GH_HOST=ghe.example.com cmd_checks "$REPO#7"'
  assert_eq "$(rc ghe) $(requests)" "2 " "a GH_HOST naming another host is refused, unasked ($(err ghe))"
  assert_eq "$(standing)" "" "and holds nothing"
  run dotcom eval 'GH_HOST=github.com cmd_checks "$REPO#7"'
  assert_eq "$(standing | cut -f2)" "repos/$REPO/pulls/7" "and github.com keeps them in ($(err dotcom))"
}

# A gate round that waited a hold out between its reads is two moments: a check read green before
# the wait may have been re-run red since. The round is read again, and the red is the verdict.
test_a_round_split_by_a_hold_is_read_again() {
  reset_fixture
  CHECKS_SEQ=(green red)
  QUOTA_UNTIL=$((T0 + 600))
  QUOTA_ENDPOINT="repos/$REPO/actions/runs?head_sha=*"
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 1 "the re-read round's red is the verdict, not the green read before the wait ($(err wait))"
  assert_contains "$(err wait)" "reading the round again" "and it says why it read again"
}

# The observer lock reads the PR's number as GitHub does, an integer: #007 is PR 7.
test_the_observer_lock_reads_the_number_as_an_integer() {
  local holder
  reset_fixture
  command sleep 300 &
  holder=$!
  mkdir -p "$STATE_DIR/observers/example~repo#7.build"
  printf '%s\n%s\n' "$holder" "$T0" >"$STATE_DIR/observers/example~repo#7.build/owner"
  run second cmd_checks "$REPO#007" --wait
  kill "$holder" 2>/dev/null || :
  wait "$holder" 2>/dev/null || :
  assert_eq "$(rc second)" 2 "#007 is the same PR's observer ($(err second))"
}

# Round 7. The first refusal on a fresh state directory still probes (the directory is made before
# the probe lock), so the hold ends at the endpoint's own reset and not at a minute's guess.
test_a_fresh_state_directory_still_probes() {
  reset_fixture
  rm -rf "$STATE_DIR"
  QUOTA_UNTIL=$((T0 + 1800))
  run single cmd_checks "$REPO#7"
  assert_eq "$(rc single)" 3 "the refused read is UNKNOWN ($(err single))"
  assert_contains "$(requests)" "probe repos/$REPO/pulls/7" "and the endpoint is probed"
  assert_eq "$(standing | cut -f1)" "$((T0 + 1800))" "so the hold ends at its reset"
}

# An ended hold is read again once its probe lock is held: the prober before may have lifted it
# meanwhile, and probing its endpoint again would be a request for nothing.
# The prober before lifts it in the second this process gives the ownerless lock it meets.
test_an_ended_hold_lifted_before_the_lock_is_not_probed() {
  reset_fixture
  plant_hold "$((T0 - 1))" "repos/$REPO/pulls/7" 600
  mkdir -p "$STATE_DIR/quota-probe"
  SLEEP_HOOK='rm -rf "$STATE_DIR/quota-holds"'
  run single cmd_checks "$REPO#7"
  assert_eq "$(rc single)" 0 "the read goes out ($(err single))"
  assert_eq "$(requests | sed -n 1p)" "read repos/$REPO/pulls/7" "first, with no probe of a lifted hold"
  assert_not_contains "$(requests)" "probe" "and none after"
}

# merge's own call stays in the budget with a caller's `gh pr merge` flags forwarded: a write
# during a hold is not sent.
# The hold lands on the last read after the gate (the open threads), so the gate and every read
# pass and only the merge call itself meets it.
test_a_forwarded_merge_is_still_gated() {
  reset_fixture
  run control cmd_merge "$REPO#7" -- --squash
  assert_eq "$(rc control)" 0 "with no hold the merge goes through ($(err control))"
  assert_contains "$(cat "$MERGE_LOG")" "--squash" "with the flags forwarded"
  reset_fixture
  READ_HOOK='[ "$FIXTURE_ENDPOINT" != graphql ] || plant_hold "$((T0 + 600))" graphql 600'
  run merge cmd_merge "$REPO#7" -- --squash
  assert_eq "$(rc merge)" 3 "the merge is not sent during the hold ($(err merge))"
  assert_contains "$(requests | tail -n 1)" "read graphql" "the threads were read, the hold landing as they were"
  assert_eq "$(cat "$MERGE_LOG")" "" "and no merge call at all"
}

# The gate's verdict is about its last round: no read after it waits a hold out (merge --wait's
# ceiling is the gate's), so a merge never lands on a verdict the wait made old. A hold landing on
# the drift read, the first read after the gate, stops the merge at the next read, exit 3: this
# fixture's PR carries no base ref, so the drift is UNKNOWN, and that next read is the merge-build
# config an UNKNOWN drift makes merge look for (ludics-lite#611); with a known drift it is the threads.
test_no_read_after_the_gate_waits_a_hold() {
  reset_fixture
  # The drift read's @tsv projection, not the --wait's conflict preflight before the gate (#729).
  READ_HOOK='case "$FIXTURE_FILTER" in *mergeable_state*@tsv*) plant_hold "$((T0 + 600))" graphql 600 ;; esac'
  run merge cmd_merge "$REPO#7" --wait=1200
  assert_eq "$(rc merge)" 3 "the merge stops ($(err merge))"
  assert_contains "$(err merge)" "could not read $REPO's .github/ship-pr-merge-build" "at the next read"
  assert_contains "$(err merge)" "no call was made" "which the hold kept from being sent"
  assert_eq "$(cat "$SLEEP_LOG")" "" "with no wait"
  assert_eq "$(cat "$MERGE_LOG")" "" "and no merge call"
}

# A wait behind another process's recovery probe is a wait too: it marks the round for a re-read,
# as a hold's wait does.
# The hold (already ended) lands inside the round, at its check-run read, while another process is
# probing it, so the round's run read waits behind that probe.
test_a_wait_behind_a_probe_marks_the_round() {
  local holder
  reset_fixture
  command sleep 300 &
  holder=$!
  mkdir -p "$STATE_DIR/quota-probe"
  printf '%s\n%s\n' "$holder" "$T0" >"$STATE_DIR/quota-probe/owner"
  READ_HOOK='case "$FIXTURE_ENDPOINT" in */check-runs*)
    [ -e "$TEST_ROOT/hooked" ] || { : >"$TEST_ROOT/hooked"; plant_hold "$((T0 - 1))" "repos/$REPO/pulls/7" 600; } ;;
  esac'
  # The other prober finishes while this one sleeps: its lock goes, and it stays alive (a holder
  # killed here would be this shell's job, reported on its stderr, or an orphan a container may
  # never reap).
  SLEEP_HOOK='rm -rf "$STATE_DIR/quota-probe"'
  run read cmd_checks "$REPO#7" --wait
  kill "$holder" 2>/dev/null || :
  wait "$holder" 2>/dev/null || :
  assert_eq "$(rc read)" 0 "the re-read round is the verdict ($(err read))"
  assert_contains "$(err read)" "reading the round again" "the round is marked for a re-read"
  assert_eq "$(cat "$SLEEP_LOG")" 5 "after one wait"
}

# An observer on another host is never retried on quota: since ludics-lite#551 it is refused before
# its first request, so there is no refusal to retry.
test_an_out_of_scope_refusal_is_not_retried() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 600))
  run read eval 'GH_HOST=ghe.example.com cmd_checks "$REPO#7" --wait'
  assert_eq "$(rc read)" 2 "it is refused ($(err read))"
  assert_eq "$(requests)" "" "before any request"
}

# The run await's -R can name another host (HOST/OWNER/REPO): that server's quota is its own, so
# its refusal sets no github.com hold. A github.com/OWNER/REPO name is github.com's.
test_a_host_qualified_run_await_is_scoped_by_its_host() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 600))
  run ghe cmd_retry run watch 55 -R ghe.example.com/o/r
  assert_eq "$(rc ghe) $(requests)" "2 " "another host is refused before any request (ludics-lite#551) ($(err ghe))"
  assert_eq "$(standing)" "" "and sets no hold"
  reset_fixture
  QUOTA_UNTIL=$((T0 + 600))
  run dotcom cmd_retry run watch 55 -R "github.com/$REPO"
  assert_contains "$(requests)" "probe repos/$REPO/actions/runs/55" \
    "a github.com-qualified repository is probed at its own endpoint ($(err dotcom))"
}

# GH_HOST applies only when a call names no host: a run await whose -R names github.com is
# github.com's, in the budget, whatever GH_HOST says.
test_an_explicit_github_repo_overrides_gh_host() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 600))
  run await eval 'GH_HOST=ghe.example.com cmd_retry run watch 55 -R "github.com/$REPO"'
  assert_eq "$(rc await)" 0 "a named github.com host is in scope under an Enterprise GH_HOST ($(err await))"
  assert_eq "$(sed -n 1p "$SLEEP_LOG")" 600 "so its refusal held it, and it waited the hold out"
}

# A probe whose answer the state directory cannot record (here: the entries' directory is made
# unwritable) is an error at once, never a loop of probes on the same ended hold.
test_an_unrecordable_probe_answer_stops_the_gate() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  plant_hold "$((T0 - 1))" "repos/$REPO/pulls/7" 600
  chmod a-w "$STATE_DIR/quota-holds"
  if mkdir "$STATE_DIR/quota-holds/probe-writable" 2>/dev/null; then
    rmdir "$STATE_DIR/quota-holds/probe-writable"
    chmod u+w "$STATE_DIR/quota-holds"
    echo "SKIP test_an_unrecordable_probe_answer_stops_the_gate: this platform writes into a read-only directory"
    return 0
  fi
  run single cmd_checks "$REPO#7"
  chmod u+w "$STATE_DIR/quota-holds"
  assert_eq "$(rc single)" 3 "the gate stops with UNKNOWN ($(err single))"
  assert_eq "$(requests | grep -c probe)" 1 "after one probe"
  assert_contains "$(err single)" "could not be updated" "naming the state directory"
}

# The observer lock's name is taken by a file, so the lock cannot be made at all.
test_a_lock_that_cannot_be_made_is_an_error() {
  reset_fixture
  mkdir -p "$STATE_DIR/observers"
  : >"$STATE_DIR/observers/example~repo#7.build"
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 2 "an unmakeable lock is status 2 ($(err wait))"
  assert_contains "$(err wait)" "cannot take the build observer lock" "naming the lock"
  assert_eq "$(cat "$SLEEP_LOG")" "" "without waiting"
  assert_eq "$(requests)" "" "and without reading"
}

# A refusal can land while an ended hold is being probed (a request already in flight). The lift
# removes only the entries that had ended when the probe started, so the new hold still stands.
test_a_refusal_during_the_probe_survives_the_lift() {
  reset_fixture
  plant_hold "$((T0 - 1))" "repos/$REPO/pulls/7" 600
  PROBE_HOOK='plant_hold "$((T0 + 900))" graphql 900'
  run single cmd_checks "$REPO#7"
  assert_eq "$(rc single)" 3 "the new hold stands after the lift ($(err single))"
  assert_eq "$(requests)" "probe repos/$REPO/pulls/7 ok" "and the read is not sent"
  assert_eq "$(standing | cut -f1-2)" "$((T0 + 900))	graphql" "the new hold is the one standing"
}

# Two processes can judge the same dead lock at once. The reap renames the lock aside and deletes
# it only if its owner is still the one judged, so the lock the first one took meanwhile survives:
# test_prreview_budget.py (the race has no seam a command line reaches). From outside: a dead
# holder's observer lock is reaped and replaced, with nothing left aside.
test_a_reap_keeps_a_lock_retaken_meanwhile() {
  local dead
  reset_fixture
  command sleep 0 &
  dead=$!
  wait "$dead" 2>/dev/null || :
  mkdir -p "$STATE_DIR/observers/example~repo#7.build"
  printf '%s\n%s\n' "$dead" "$T0" >"$STATE_DIR/observers/example~repo#7.build/owner"
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 0 "the dead holder's lock is replaced ($(err wait))"
  assert_eq "$(ls -A "$STATE_DIR/observers" | grep -c reap || true)" 0 "nothing left aside"
}

# The budget is this script's own calls to github.com. A `retry` caller's arguments (any host,
# repository or command form) are outside it: neither gated nor held, its refusal still exit 3.
test_a_callers_call_is_outside_the_budget() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 600))
  run caller cmd_retry --read api repos/ghe/repo
  assert_eq "$(rc caller)" 3 "a caller's quota refusal is still UNKNOWN ($(err caller))"
  assert_eq "$(standing)" "" "but sets no hold"
  assert_not_contains "$(requests)" "probe" "and probes nothing"
  QUOTA_UNTIL=0
  : >"$CALL_LOG"
  plant_hold "$((T0 + 600))" graphql 600
  run caller2 cmd_retry --read api repos/ghe/repo
  assert_eq "$(rc caller2)" 0 "a hold does not stop it ($(err caller2))"
}

# GraphQL answers an exhausted quota with a 200 (GitHub's GraphQL rate-limit documentation), so the
# probe reads the quota headers, and the body's words, on every status.
# Each probe is of an ended GraphQL hold, and what it read is the hold it leaves.
test_a_graphql_200_can_still_be_quota() {
  reset_fixture
  plant_hold "$((T0 - 1))" graphql 600
  GRAPHQL_PROBE=exhausted
  run exhausted cmd_checks "$REPO#7"
  assert_eq "$(rc exhausted) $(standing | cut -f1)" "3 $((T0 + 2400))" \
    "Remaining 0 on a 200 is quota until its reset ($(err exhausted))"
  reset_fixture
  plant_hold "$((T0 - 1))" graphql 600
  GRAPHQL_PROBE=secondary
  run secondary cmd_checks "$REPO#7"
  assert_eq "$(rc secondary) $(standing | cut -f1,3)" "3 $((T0 + 1200))	1200" \
    "a 200 whose body names a secondary limit is quota, with no reset: the backoff ($(err secondary))"
  reset_fixture
  plant_hold "$((T0 - 1))" graphql 600
  GRAPHQL_PROBE=""
  run answered cmd_checks "$REPO#7"
  assert_eq "$(rc answered) $(standing)" "0 " "a 200 with quota left is the answer ($(err answered))"
}

# --- fixture 3: a meaningful failure notifies; an unchanged queued poll does not ---------------

test_a_still_queue_backs_off_and_a_red_still_ends_the_wait() {
  reset_fixture
  CHECKS_SEQ=(pending pending pending pending pending red)
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 1 "a red after a still queue ends the wait at once ($(err wait))"
  assert_contains "$(out wait)" "RED" "and says RED"
  assert_eq "$(tr '\n' ' ' <"$SLEEP_LOG")" "60 120 240 480 600 " \
    "unchanged polls double the pause from the interval up to the build cap"
  assert_eq "$(err wait)" "" "and an unchanged poll prints nothing"
}

test_a_moving_signal_is_read_at_the_interval() {
  reset_fixture
  CHECKS_SEQ=(pending pending green)
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 0 "the green is the verdict ($(err wait))"
  assert_eq "$(tr '\n' ' ' <"$SLEEP_LOG")" "60 120 " "the pause doubles only while nothing moves"
}

test_a_hold_inside_a_wait_is_one_line_and_no_exit() {
  reset_fixture
  CHECKS_SEQ=(pending pending red)
  QUOTA_UNTIL=$((T0 + 100))
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 1 "the wait outlives the hold and ends on the red ($(err wait))"
  assert_eq "$(err wait | grep -c .)" 2 "the hold and its lifting are the only lines on the way"
  assert_eq "$(cat "$MERGE_LOG")" "" "nothing merges from a checks read"
}

# --- ludics-lite#551: the budget's residuals ------------------------------------------------------

# A first refusal whose hold the state directory cannot record (here: the entries' name is taken by
# a file) is a state-directory error at once: no resend of the refused read, and a message naming
# SHIP_PR_STATE_DIR, since every other process on the host goes on calling unheld.
test_an_unrecordable_first_hold_is_a_state_directory_error() {
  reset_fixture
  QUOTA_UNTIL=$((T0 + 7200))
  : >"$STATE_DIR/quota-holds"
  run wait cmd_checks "$REPO#7" --wait=600
  assert_eq "$(rc wait)" 3 "the refused read is UNKNOWN ($(err wait))"
  assert_eq "$(requests | grep -c '^read ')" 1 "and it is not resent"
  assert_contains "$(err wait)" "SHIP_PR_STATE_DIR" "naming the state directory"
  assert_contains "$(err wait)" "could not be recorded" "as the hold that could not be recorded"
}

# The build pause keys on the workflow runs too: a run that moves before any check row exists
# (queued, then in progress) is movement, and the pause goes back to the interval (ludics-lite#551).
test_a_moving_run_before_any_check_resets_the_pause() {
  reset_fixture
  CHECKS_SEQ=(queued queued running running green)
  run wait cmd_checks "$REPO#7" --wait
  assert_eq "$(rc wait)" 0 "the green is the verdict ($(err wait))"
  assert_eq "$(tr '\n' ' ' <"$SLEEP_LOG")" "60 120 60 120 " \
    "the run's own status moving resets the pause, with no check row to show it"
}

# Another host is refused loudly, before any request, in one message: the budget covers github.com
# alone, and the fleet uses nothing else (ludics-lite#551, the coordinator's round-9 proposal on
# #549). A retry caller's own call is outside the budget, whatever host it names.
test_another_host_is_refused_loudly() {
  reset_fixture
  run ghe eval 'GH_HOST=ghe.example.com cmd_checks "$REPO#7"'
  assert_eq "$(rc ghe)" 2 "a GH_HOST naming another server is refused ($(err ghe))"
  assert_contains "$(err ghe)" "ghe.example.com" "naming it"
  assert_eq "$(err ghe | grep -c .)" 1 "in one message"
  assert_eq "$(requests)" "" "before any request"
  run named cmd_retry run watch 55 -R ghe.example.com/o/r
  assert_eq "$(rc named)" 2 "a named host is refused alike ($(err named))"
  assert_eq "$(err named | grep -c .)" 1 "in one message"
  assert_eq "$(requests)" "" "before any request"
  run base eval 'REPO=; GH_HOST=ghe.example.com cmd_base'
  assert_eq "$(rc base) $(requests)" "2 " "and so is base's resolution of the repository ($(err base))"
  run caller eval 'GH_HOST=ghe.example.com cmd_retry --read api repos/ghe/repo'
  assert_eq "$(rc caller)" 0 "a retry caller's call is outside the budget, any host ($(err caller))"
}

run_tests \
  test_a_quota_refusal_is_unknown_and_holds_every_caller \
  test_a_transport_failure_is_unknown_and_never_merges \
  test_an_observer_resumes_only_after_the_failing_endpoint_answers \
  test_a_second_observer_of_the_pr_is_refused \
  test_a_windows_process_of_the_number_is_no_holder \
  test_a_running_observer_is_refused_by_the_shells_pid \
  test_one_process_probes_an_ended_hold \
  test_a_probe_that_answers_still_holds_the_refused_operation \
  test_a_later_refusal_never_shortens_the_hold \
  test_a_write_never_waits_a_hold \
  test_an_ownerless_probe_lock_is_recovered \
  test_a_hold_at_the_start_counts_toward_the_ceiling \
  test_resolving_the_repo_passes_the_hold \
  test_base_wait_waits_a_hold_from_its_first_read \
  test_a_refusal_during_the_probe_survives_the_lift \
  test_a_reap_keeps_a_lock_retaken_meanwhile \
  test_a_callers_call_is_outside_the_budget \
  test_a_graphql_200_can_still_be_quota \
  test_each_endpoint_is_probed_before_its_hold_lifts \
  test_the_run_await_backs_off_on_a_still_run \
  test_a_run_view_probe_finds_the_run_id \
  test_a_lock_that_cannot_be_made_is_an_error \
  test_refusals_behind_a_hold_or_a_probe_are_not_probed \
  test_a_probe_follows_the_environment_gh_reads \
  test_a_hold_set_before_the_lock_stops_the_probe \
  test_the_scope_and_the_job_read_what_gh_reads \
  test_a_round_split_by_a_hold_is_read_again \
  test_the_observer_lock_reads_the_number_as_an_integer \
  test_a_fresh_state_directory_still_probes \
  test_an_ended_hold_lifted_before_the_lock_is_not_probed \
  test_a_forwarded_merge_is_still_gated \
  test_no_read_after_the_gate_waits_a_hold \
  test_a_wait_behind_a_probe_marks_the_round \
  test_an_out_of_scope_refusal_is_not_retried \
  test_a_host_qualified_run_await_is_scoped_by_its_host \
  test_an_explicit_github_repo_overrides_gh_host \
  test_an_unrecordable_probe_answer_stops_the_gate \
  test_a_still_queue_backs_off_and_a_red_still_ends_the_wait \
  test_a_moving_signal_is_read_at_the_interval \
  test_a_hold_inside_a_wait_is_one_line_and_no_exit \
  test_an_unrecordable_first_hold_is_a_state_directory_error \
  test_a_moving_run_before_any_check_resets_the_pause \
  test_another_host_is_refused_loudly \
  -- "$@"
exit "$?"
}
