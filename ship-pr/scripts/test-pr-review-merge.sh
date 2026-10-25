#!/usr/bin/env bash
# Focused fixture tests for pr-review.sh's `merge`: the binding of the merge to the head the build
# signal was read for, the refusals of a --require-green (close-out) merge (ludics-lite#39), what an
# --override waives and what it leaves to --wait (ludics-lite#392), and the closing-keyword scan of
# the PR body that runs before the merge is issued (ludics-lite#227), and the same scan over the
# messages of the PR's commit series (ludics-lite#296).
# The build signal is read through the fixture `gh` below with the plainest feeds that carry each
# case's verdict (a check list, one run, a commit date); the gate's own behaviour is
# test-pr-review-checks-absent.sh's. BLACK-BOX (ludics-lite#403): no case calls or replaces an
# internal function, so the cases judge the shell and the Python implementation alike.

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

REPO=example/repo
test_tmpdir TEST_ROOT merge-test
OUT_FILE="$TEST_ROOT/out"
ERR_FILE="$TEST_ROOT/err"
CALLS_FILE="$TEST_ROOT/calls"

CURRENT_HEAD=head-sha
SKIPS_ONLY=""                          # the head's checks all skipped/neutral
CHECK_ROWS=""                          # nonempty = the head's check runs, as row() rows (class,
                                       # name, conclusion, url, check suite), one per line
CHECK_ROWS_LATER=""                    # nonempty = the rows from the SECOND check-run read on
NO_CHECKS=""                           # the head carries no build check and no workflow run; its
                                       # commit is older than the run-creation grace, so the gate
                                       # reads that as ABSENT
MERGE_STATE="merged=true state=MERGED" # what REST says after the merge call
MERGE_QUEUE=""                         # nonempty = the base has a merge queue
MERGE_NOT_MERGEABLE=""                 # nonempty = the FIRST pr merge call fails as not mergeable
MERGE_BASE_MODIFIED=""                 # nonempty = the FIRST pr merge call loses a race to the base
MERGE_REFUSAL=""                       # nonempty = every pr merge call is refused by gh with it
HEAD_AFTER_MERGE=""                    # nonempty = what the head re-read after a refusal answers
PR_BASE=main                           # the branch this PR targets
BASE_LATER=""                          # nonempty = the base read answers with this from the 2nd on
DEFAULT_BRANCH=main                    # the repository default branch
DEFAULT_BRANCH_FAIL=""                 # nonempty = the default-branch read answers with a 404
DEFAULT_BRANCH_FAIL_LATER=""           # nonempty = it answers with a 404 from the SECOND read on
PR_BODY="A body with nothing to close."  # what the body read answers with
PR_BODY_LATER=""                       # nonempty = what the SECOND body read on answers with
BODY_FAIL=""                           # nonempty = the body read answers with a 404
THREADS_JSON='[]'                      # the PR's review threads (review_thread rows)
THREADS_JSON_LATER=""                  # nonempty = what the SECOND threads read on answers with
FAIL_GRAPHQL=""                        # nonempty = the review-threads read gets a 503
SERIES_JSON=""                         # the PR's commits as the endpoint serves them (see reset)
SERIES_JSON_LATER=""                   # nonempty = what the SECOND series read on answers with
SERIES_COUNT=""                        # nonempty = the commit count the PR states, over the rows'
SERIES_FAIL=""                         # nonempty = the commits read answers with a 503
ADVISORY_FAIL=""                       # nonempty = the advisory-list read answers with a 503
# An ABSENT verdict's base, re-read before each merge attempt (ludics-lite#523). The gate reads
# base-sha until the merge loop's first base read; from that read on, every read answers BASE_MOVED
# when it is set -- the base advanced between the gate's read and the merge call.
BASE_MOVED=""
BASE_READ_FAIL=""                      # nonempty = the merge loop's base read answers with a 503
HEAD_AFTER_MOVE=""                     # nonempty = the head the gate reads once the base moved
MOVED_RUN_RC=""                        # 4 = once the base has moved, a run is queued on it (no verdict)
BASE_KEEPS_MOVING=""                   # nonempty = every base read answers a base no read gave before
CHECKS_FAIL=""                         # nonempty = the head's check-run read does not answer
# The gate's per-round head re-read (ludics-lite#795): a number = that many of them answer a 503
# before the rest answer; `always` = none ever does; `refused` = every one answers a 404.
HEAD_REREAD_FAIL=""
# The merge build (ludics-lite#611): the head the gate reads, the base branch's tip the drift read
# anchors on, the drift's two compares, the repository's .github/ship-pr-merge-build, and the
# directory merge runs in (a clone of the fixture remote; build_fixture below).
GATED_HEAD=head-sha
BASE_TIP=base-tip
COMPARE_FORWARD=""                     # nonempty = the compare from the tip to the head (the PR's paths)
COMPARE_REVERSE=""                     # nonempty = the compare from the head to the tip (the base's)
MERGE_BUILD_CONFIG=""                  # nonempty = the config's contents; empty = no file (a 404)
MERGE_BUILD_CONFIG_FAIL=""             # nonempty = the config read answers with a 503
MERGE_CWD=""                           # nonempty = the directory merge runs in
MERGEABLE=true                         # what the mergeable read answers; FAIL = it does not answer
# A --wait's conflict preflight (ludics-lite#729): "<mergeable> TAB <mergeable_state>" as the read
# answers it, the first read MERGEABILITY, every later one MERGEABILITY_LATER when that is set;
# FAIL = the read does not answer.
MERGEABILITY=$'true\tclean'
MERGEABILITY_LATER=""
STATE_FAIL=""                          # nonempty = the merged-state read after the call does not answer
DISABLE_AUTO_FAIL=""                   # nonempty = `pr merge --disable-auto` is refused
MERGE_QUEUE_FAIL=""                    # nonempty = the merge-queue read gets a 503
# A build job that never got a runner (ludics-lite#560/#728; prreview/runners.py). RUNNER_CASE names
# the head run's story: `no-runner` (run 100 completed cancelled, its job cancelled with no step
# and no runner) or `never-started` (run 100 in flight, its job queued since the head was pushed,
# while run 130 of the same workflow has a job on the same labels running). The recovery's writes
# (`run cancel`, `run rerun`) are logged and leave a marker; after the cancel the run reads
# completed with its job no runner took, and after the rerun it reads as attempt 2 -- the same
# story again, unless RUNNER_RECOVERS is set: then green.
RUNNER_CASE=""
RUNNER_RECOVERS=""
# The "from the SECOND read on" switches above are counted by the lib's fixture_call_count, under
# the names body, base and default-branch: every call runs the fixture in a fresh bash of its own
# (the forward's bridge), so a variable it increments dies with that shell, and the count has to travel
# in a file -- as CALLS_FILE already does. Three hand-rolled files did this before (ludics-lite#274).
# Each count is captured with its status and a failure returned before an answer is chosen: a
# `[ "$(...)" -ge 2 ]` over a count that could not be made is merely false, and the fixture would
# then answer the FIRST-read shape with a clean status, passing a case that never reached the
# later-read behaviour it exists for (review round 1 of ludics-lite#301).

# The head's check runs as the commits/<sha>/check-runs feed serves them, for the <n>th read: row()
# rows turned into the feed's objects (a `pending` conclusion is the null of a check still running;
# a row with no fifth column has no check suite).
check_runs_answer() { # <n>
  local rows
  if [ -n "$RUNNER_CASE" ]; then
    case "$(runner_state)" in
    recovered) rows=$(printf 'green\tbuild\tsuccess\thttps://example/build\t1') ;;
    norunner) rows=$(printf 'nogo\tbuild\tcancelled\thttps://example/build\t1') ;;
    *) rows=$(printf 'pending\tbuild\tpending\thttps://example/build\t1') ;;
    esac
  elif [ -n "$CHECK_ROWS_LATER" ] && [ "$1" -ge 2 ]; then
    rows="$CHECK_ROWS_LATER"
  elif [ -n "$CHECK_ROWS" ]; then
    rows="$CHECK_ROWS"
  elif [ -n "$NO_CHECKS" ]; then
    rows=""
  elif [ -n "$SKIPS_ONLY" ]; then
    rows=$(printf 'green\tci\tskipped\thttps://example/run\ngreen\tdocs\tneutral\thttps://example/run2')
  else
    rows=$(printf 'green\tci\tsuccess\thttps://example/run')
  fi
  printf '%s\n' "$rows" | jq -cRn '{check_runs: [inputs | select(length > 0) | split("\t")
    | {name: .[1], conclusion: (if .[2] == "pending" then null else .[2] end), html_url: .[3]}
      + (if .[4] == null then {} else {check_suite: {id: (.[4] | tonumber)}} end)]}'
}

# Where RUNNER_CASE's story stands: `queued` (the never-started job waits), `norunner` (the run
# completed with its job cancelled before any runner took it), or `recovered` (green after the
# rerun). The attempt is 2 once the rerun was sent.
runner_state() {
  if [ -e "$TEST_ROOT/runner-rerun" ] && [ -n "$RUNNER_RECOVERS" ]; then
    echo recovered
  elif [ "$RUNNER_CASE" = no-runner ] || { [ -e "$TEST_ROOT/runner-cancel" ] && [ ! -e "$TEST_ROOT/runner-rerun" ]; }; then
    echo norunner
  else
    echo queued
  fi
}
runner_attempt() { if [ -e "$TEST_ROOT/runner-rerun" ]; then echo 2; else echo 1; fi; }
runner_run() { # <status> <conclusion|null>
  printf '{"workflow_runs":[{"id":100,"workflow_id":1,"event":"pull_request","name":"ci","status":"%s","conclusion":%s,"created_at":"2026-09-01T00:00:00Z","check_suite_id":1}]}\n' \
    "$1" "$([ "$2" = null ] && echo null || printf '"%s"' "$2")"
}
# The jobs of run <id>: the head run's one job as the story has it, or the newer run's started one.
runner_jobs() { # <run id>
  if [ "$1" = 130 ]; then
    printf '%s\n' '{"jobs":[{"id":601,"name":"build","status":"in_progress","conclusion":null,"created_at":"2026-09-01T00:10:00Z","steps":[{"name":"Set up job"}],"runner_name":"GitHub Actions 7","labels":["macos-14"],"run_attempt":1}]}'
    return 0
  fi
  case "$(runner_state)" in
  recovered)
    jq -cn --argjson a "$(runner_attempt)" '{jobs:[{id:501,name:"build",status:"completed",conclusion:"success",
      created_at:"2026-09-01T00:00:00Z",steps:[{name:"Set up job"}],runner_name:"GitHub Actions 3",labels:["macos-14"],run_attempt:$a}]}'
    ;;
  norunner)
    jq -cn --argjson a "$(runner_attempt)" '{jobs:[{id:501,name:"build",status:"completed",conclusion:"cancelled",
      created_at:"2026-09-01T00:00:00Z",steps:[],runner_name:null,labels:["macos-14"],run_attempt:$a}]}'
    ;;
  *)
    jq -cn --argjson a "$(runner_attempt)" '{jobs:[{id:501,name:"build",status:"queued",conclusion:null,
      created_at:"2026-09-01T00:00:00Z",steps:[],runner_name:null,labels:["macos-14"],run_attempt:$a}]}'
    ;;
  esac
}

# The head's workflow runs: one finished green run, unless the head has no checks (no run either),
# or MOVED_RUN_RC=4 and the merge loop has read a moved base -- then a run is queued on the new base,
# which no gate read can judge yet.
runs_answer() {
  if [ -n "$RUNNER_CASE" ]; then
    case "$(runner_state)" in
    recovered) runner_run completed success ;;
    norunner) runner_run completed cancelled ;;
    *) runner_run in_progress null ;;
    esac
  elif [ -n "$MOVED_RUN_RC" ] && [ "$(fixture_call_total base-sha)" -ge 1 ]; then
    printf '%s\n' '{"workflow_runs":[{"id":101,"workflow_id":1,"event":"pull_request","name":"ci","status":"queued","conclusion":null,"created_at":"2026-09-01T00:00:00Z","check_suite_id":1}]}'
  elif [ -n "$NO_CHECKS" ]; then
    printf '%s\n' '{"workflow_runs":[]}'
  else
    printf '%s\n' '{"workflow_runs":[{"id":100,"workflow_id":1,"event":"pull_request","name":"ci","status":"completed","conclusion":"success","created_at":"2026-09-01T00:00:00Z","check_suite_id":1}]}'
  fi
}

# The PR's base and head as the gate's reads see them: moved once the merge loop has read the base.
fixture_base() {
  if [ -n "$BASE_KEEPS_MOVING" ]; then
    printf 'moved-%s\n' "$(fixture_call_total base-sha)"
  elif [ -n "$BASE_MOVED" ] && [ "$(fixture_call_total base-sha)" -ge 1 ]; then
    printf '%s\n' "$BASE_MOVED"
  else
    printf '%s\n' base-sha
  fi
}
fixture_head() {
  if [ -n "$HEAD_AFTER_MOVE" ] && [ "$(fixture_call_total base-sha)" -ge 1 ]; then
    printf '%s\n' "$HEAD_AFTER_MOVE"
  else
    printf '%s\n' "$1"
  fi
}
gh() {
  local reads
  case "${1:-} ${2:-}" in
  "api repos/$REPO/pulls/7")
    case "$*" in
    # The gate reads the PR twice per round with DIFFERENT projections: `updated_at` rides on the
    # first, which binds the head, and the revalidation at the end of the round asks for the head,
    # the base and the head ref alone. The revalidation is the one that can answer with a
    # successor, so the two are told apart by `updated_at` rather than by field count.
    # The series scan's count read: the count and the head, derived from the rows the matching
    # commits read serves, so the two agree unless a case says otherwise.
    # The --wait's conflict preflight (ludics-lite#729), told by its interpolated projection.
    *'\(.mergeable)'*)
      printf 'CALL mergeability\n' >>"$CALLS_FILE"
      reads=$(fixture_call_count mergeability) || return 1
      if [ -n "$MERGEABILITY_LATER" ] && [ "$reads" -ge 2 ]; then
        reads=$MERGEABILITY_LATER
      else
        reads=$MERGEABILITY
      fi
      if [ "$reads" = FAIL ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      printf '%s\t%s\n' "$reads" "$PR_BASE"
      ;;
    *'.commits|tostring'*)
      printf 'CALL commits-count\n' >>"$CALLS_FILE"
      reads=$(fixture_call_count series-count) || return 1
      gh_fixture_parse "$@"
      gh_fixture_answer "$(series_answer "$reads" |
        jq -c --arg c "$SERIES_COUNT" '{commits: (if $c == "" then length else ($c | tonumber) end), head: {sha: .[-1].sha}}')"
      ;;
    # The base-drift read (its projection is the one carrying mergeable_state): logged, so a case
    # can count the drift reads and see where they fall among the merge's other calls.
    *mergeable_state*)
      printf 'CALL warn_base_drift\n' >>"$CALLS_FILE"
      printf '%s\t%s\tclean\n' "$PR_BASE" "$(fixture_head "$CURRENT_HEAD")"
      ;;
    *'.updated_at'*)
      printf '%s\t2026-09-01T00:00:00Z\t%s\tclaude/topic\n' "$(fixture_head "$GATED_HEAD")" "$(fixture_base)"
      ;;
    *'--jq .head.sha // "-"') printf '%s\n' "${HEAD_AFTER_MERGE:-$CURRENT_HEAD}" ;;
    *'--jq .base.sha // "-"')
      printf 'CALL base-sha\n' >>"$CALLS_FILE"
      fixture_call_count base-sha >/dev/null || return 1
      if [ -n "$BASE_READ_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      fixture_base
      ;;
    *'.head.sha'*)
      reads=$(fixture_call_count head-reread) || return 1
      case "$HEAD_REREAD_FAIL" in
      refused)
        printf 'gh: Not Found (HTTP 404)\n' >&2
        return 1
        ;;
      always)
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
        ;;
      '') ;;
      *)
        if [ "$reads" -le "$HEAD_REREAD_FAIL" ]; then
          printf 'gh: 503 No server is currently available to service your request\n' >&2
          return 1
        fi
        ;;
      esac
      printf '%s\t%s\tclaude/topic\n' "$(fixture_head "$CURRENT_HEAD")" "$(fixture_base)"
      ;;
    *'.base.ref'*)
      reads=$(fixture_call_count base) || return 1
      if [ -n "$BASE_LATER" ] && [ "$reads" -ge 2 ]; then
        printf '%s\n' "$BASE_LATER"
      else
        printf '%s\n' "$PR_BASE"
      fi
      ;;
    *'.body'*)
      reads=$(fixture_call_count body) || return 1
      if [ -n "$BODY_FAIL" ]; then
        printf 'gh: Not Found (HTTP 404)\n' >&2
        return 1
      fi
      if [ -n "$PR_BODY_LATER" ] && [ "$reads" -ge 2 ]; then
        printf '%s\n' "$PR_BODY_LATER"
      else
        printf '%s\n' "$PR_BODY"
      fi
      ;;
    *merged=*)
      if [ -n "$STATE_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      echo "$MERGE_STATE"
      ;;
    *'.mergeable'*)
      if [ "$MERGEABLE" = FAIL ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      echo "$MERGEABLE"
      ;;
    *) bail "unexpected pulls read: $*" ;;
    esac
    ;;
  # The head's commit date (the gate's push clock, read only for a head with no check: long past
  # the run-creation grace) and the base branch's tip (the drift read's anchor).
  "api repos/$REPO/commits/"*)
    case "$*" in
    *committer.date*) printf '2026-09-01T00:00:00Z\n' ;;
    *) printf '%s\n' "$BASE_TIP" ;;
    esac
    ;;
  # The drift read's two compares: nothing behind, and no path changed on the base's side --
  # unless a case sets them, the forward one told by its tip-first range.
  "api repos/$REPO/compare/"*)
    gh_fixture_parse "$@"
    case "$*" in
    *"compare/$BASE_TIP..."*) reads=$COMPARE_FORWARD ;;
    *) reads=$COMPARE_REVERSE ;;
    esac
    [ -n "$reads" ] || reads='{"behind_by":0,"ahead_by":1,"merge_base_commit":{"sha":"merge-base"},"files":[]}'
    gh_fixture_answer "$reads"
    ;;
  "api repos/$REPO")
    reads=$(fixture_call_count default-branch) || return 1
    if [ -n "$DEFAULT_BRANCH_FAIL_LATER" ] && [ "$reads" -ge 2 ]; then
      printf 'gh: Not Found (HTTP 404)\n' >&2
      return 1
    fi
    if [ -n "$DEFAULT_BRANCH_FAIL" ]; then
      printf 'gh: Not Found (HTTP 404)\n' >&2
      return 1
    fi
    printf '%s\n' "$DEFAULT_BRANCH"
    ;;
  # The repository's advisory list (ludics-lite#530): no file, a 404, unless a case says otherwise.
  "api -H")
    case "$*" in
    *"repos/$REPO/contents/.github/ship-pr-advisory-checks")
      printf 'CALL advisory\n' >>"$CALLS_FILE"
      if [ -n "$ADVISORY_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      printf 'gh: Not Found (HTTP 404)\n' >&2
      return 1
      ;;
    # The merge build's config (ludics-lite#611): no file unless a case writes one.
    *"repos/$REPO/contents/.github/ship-pr-merge-build")
      printf 'CALL merge-build-config\n' >>"$CALLS_FILE"
      if [ -n "$MERGE_BUILD_CONFIG_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      if [ -n "$MERGE_BUILD_CONFIG" ]; then
        printf '%s\n' "$MERGE_BUILD_CONFIG"
        return 0
      fi
      printf 'gh: Not Found (HTTP 404)\n' >&2
      return 1
      ;;
    *) bail "unexpected header read: $*" ;;
    esac
    ;;
  # The listing that confirms the advisory list's 404: a `.github` without the file.
  "api repos/$REPO/contents/.github")
    gh_fixture_parse "$@"
    gh_fixture_answer '[{"name":"workflows","type":"dir"}]'
    ;;
  "api --paginate")
    case "$*" in
    *"repos/$REPO/commits/"*"/check-runs?filter=latest&per_page=100"*)
      reads=$(fixture_call_count checks) || return 1
      if [ -n "$CHECKS_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      gh_fixture_parse "$@"
      gh_fixture_answer "$(check_runs_answer "$reads")"
      ;;
    *"repos/$REPO/actions/runs?head_sha="*)
      gh_fixture_parse "$@"
      gh_fixture_answer "$(runs_answer)"
      ;;
    *"repos/$REPO/actions/runs/"*"/jobs?per_page=100"*)
      gh_fixture_parse "$@"
      if [ -n "$RUNNER_CASE" ]; then
        reads=${FIXTURE_ENDPOINT#repos/"$REPO"/actions/runs/}
        gh_fixture_answer "$(runner_jobs "${reads%%/*}")"
      else
        gh_fixture_answer '{"jobs":[]}'
      fi
      ;;
    *"repos/$REPO/pulls/7/commits"*)
      printf 'CALL commits\n' >>"$CALLS_FILE"
      reads=$(fixture_call_count series) || return 1
      if [ -n "$SERIES_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      gh_fixture_parse "$@"
      gh_fixture_answer "$(series_answer "$reads")"
      ;;
    *) bail "unexpected paginated read: $*" ;;
    esac
    ;;
  "api graphql")
    case "$*" in
    *reviewThreads*)
      printf 'CALL reviewThreads\n' >>"$CALLS_FILE"
      reads=$(fixture_call_count threads) || return 1
      if [ -n "$FAIL_GRAPHQL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      gh_fixture_parse "$@"
      if [ -n "$THREADS_JSON_LATER" ] && [ "$reads" -ge 2 ]; then
        gh_fixture_answer "$(review_threads_answer "$THREADS_JSON_LATER" "$@")"
      else
        gh_fixture_answer "$(review_threads_answer "$THREADS_JSON" "$@")"
      fi
      ;;
    *mergeQueue*)
      printf 'CALL %s\n' "$*" >>"$CALLS_FILE"
      if [ -n "$MERGE_QUEUE_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      echo "$MERGE_QUEUE"
      ;;
    *) bail "unexpected graphql call: $*" ;;
    esac
    ;;
  "pr merge")
    printf 'CALL %s\n' "$*" >>"$CALLS_FILE"
    case "$*" in *--disable-auto*)
      if [ -n "$DISABLE_AUTO_FAIL" ]; then
        printf 'gh: 503 No server is currently available to service your request\n' >&2
        return 1
      fi
      return 0
      ;;
    esac
    if [ -n "$MERGE_REFUSAL" ]; then
      printf '%s\n' "$MERGE_REFUSAL" >&2
      return 1
    fi
    # The stale pre-recompute verdict: the first attempt fails as not mergeable, await_mergeable
    # then reads mergeable=true and cmd_merge retries. One failure only, so the retry lands.
    if [ -n "$MERGE_NOT_MERGEABLE" ] && [ ! -f "$TEST_ROOT/merge-failed-once" ]; then
      : >"$TEST_ROOT/merge-failed-once"
      printf 'gh: Pull request is not mergeable\n' >&2
      return 1
    fi
    if [ -n "$MERGE_BASE_MODIFIED" ] && [ ! -f "$TEST_ROOT/merge-failed-once" ]; then
      : >"$TEST_ROOT/merge-failed-once"
      printf 'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)\n' >&2
      return 1
    fi
    ;;
  # The newer runs of the head run's workflow (runners.py's evidence for NEVER STARTED).
  "api repos/$REPO/actions/workflows/1/runs?"*)
    gh_fixture_parse "$@"
    gh_fixture_answer '{"workflow_runs":[{"id":130,"status":"in_progress","created_at":"2026-09-01T00:10:00Z"}]}'
    ;;
  "run cancel" | "run rerun")
    printf 'CALL %s\n' "$*" >>"$CALLS_FILE"
    : >"$TEST_ROOT/runner-$2"
    ;;
  *) bail "unexpected fixture gh call: $*" ;;
  esac
}

# The series the <n>th read of it answers with: SERIES_JSON_LATER from the second on, when set.
series_answer() { # <n>
  if [ -n "$SERIES_JSON_LATER" ] && [ "$1" -ge 2 ]; then
    printf '%s\n' "$SERIES_JSON_LATER"
  else
    printf '%s\n' "$SERIES_JSON"
  fi
}

# One commit of a series, as the commits endpoint serves it.
commit_row() { # <sha> <message>
  jq -cn --arg s "$1" --arg m "$2" '{sha: $s, commit: {message: $m}}'
}

# In a subshell: cmd_merge's refusals are `fail`, which exits the shell it runs in. The calls
# and output travel through files, so the subshell costs nothing the assertions need.
# The two streams are kept APART as well as together: the closing-keyword warning is required to
# reach BOTH, and a single merged capture cannot tell a line that went to one from a line that went
# to the other. MERGE_OUTPUT stays the pair, which is what every older case asserts against.
run_merge() {
  local rc
  fixture_call_reset
  : >"$CALLS_FILE"
  set +e
  (if [ -n "$MERGE_CWD" ]; then cd "$MERGE_CWD" || exit 99; fi; cmd_merge "$REPO#7" "$@") >"$OUT_FILE" 2>"$ERR_FILE"
  rc=$?
  set -e
  MERGE_STDOUT=$(cat "$OUT_FILE")
  MERGE_STDERR=$(cat "$ERR_FILE")
  MERGE_OUTPUT=$(cat "$OUT_FILE" "$ERR_FILE")
  MERGE_RC="$rc"
  MERGE_CALLS=$(cat "$CALLS_FILE")
}

assert_no_merge_call() {
  case "$MERGE_CALLS" in *"pr merge"*) bail "no merge call should have been made ($MERGE_CALLS)" ;; esac
}

reset() {
  CURRENT_HEAD=head-sha
  SKIPS_ONLY=""
  CHECK_ROWS=""
  CHECK_ROWS_LATER=""
  NO_CHECKS=""
  MERGE_STATE="merged=true state=MERGED"
  MERGE_QUEUE=""
  MERGE_NOT_MERGEABLE=""
  MERGE_BASE_MODIFIED=""
  MERGE_REFUSAL=""
  HEAD_AFTER_MERGE=""
  PR_BASE=main
  BASE_LATER=""
  DEFAULT_BRANCH=main
  DEFAULT_BRANCH_FAIL=""
  DEFAULT_BRANCH_FAIL_LATER=""
  rm -f "$TEST_ROOT/merge-failed-once"
  PR_BODY="A body with nothing to close."
  PR_BODY_LATER=""
  BODY_FAIL=""
  THREADS_JSON='[]'
  THREADS_JSON_LATER=""
  FAIL_GRAPHQL=""
  SERIES_JSON="[$(commit_row head-sha 'A commit with nothing to close.')]"
  SERIES_JSON_LATER=""
  SERIES_COUNT=""
  SERIES_FAIL=""
  ADVISORY_FAIL=""
  BASE_MOVED=""
  BASE_READ_FAIL=""
  HEAD_AFTER_MOVE=""
  MOVED_RUN_RC=""
  BASE_KEEPS_MOVING=""
  CHECKS_FAIL=""
  HEAD_REREAD_FAIL=""
  GATED_HEAD=head-sha
  BASE_TIP=base-tip
  COMPARE_FORWARD=""
  COMPARE_REVERSE=""
  MERGE_BUILD_CONFIG=""
  MERGE_BUILD_CONFIG_FAIL=""
  MERGE_CWD=""
  MERGEABLE=true
  MERGEABILITY=$'true\tclean'
  MERGEABILITY_LATER=""
  STATE_FAIL=""
  DISABLE_AUTO_FAIL=""
  MERGE_QUEUE_FAIL=""
  RUNNER_CASE=""
  RUNNER_RECOVERS=""
  rm -f "$TEST_ROOT/runner-cancel" "$TEST_ROOT/runner-rerun"
}

# The merge is bound to the head the gate read: a push during a long --wait must not land a head
# with neither a read green nor a 👍.
test_merge_binds_to_the_gated_head() {
  reset
  run_merge
  assert_eq "$MERGE_RC" 0 "a green head merges ($MERGE_OUTPUT)"
  assert_contains "$MERGE_CALLS" "--match-head-commit head-sha " "merge is bound to the gated head"
  assert_contains "$MERGE_CALLS" " --merge" "the repo convention stays"
}

# The repository's advisory list is read before the gate, and a read that did not answer is an
# unknown policy: exit 3, and no merge call (ludics-lite#530).
test_an_unread_advisory_list_never_merges() {
  reset
  run_merge
  assert_contains "$MERGE_CALLS" "CALL advisory" "the list is read on every merge"
  reset
  ADVISORY_FAIL=1
  run_merge
  assert_eq "$MERGE_RC" 3 "an unread advisory list is unknown, not the default list"
  assert_contains "$MERGE_OUTPUT" "policy is UNKNOWN" "and says so"
  assert_no_merge_call
}

test_forwarded_head_binding_is_refused() {
  reset
  run_merge -- --match-head-commit other --merge
  assert_eq "$MERGE_RC" 2 "a forwarded --match-head-commit is a usage error"
  assert_contains "$MERGE_OUTPUT" "cannot be forwarded" "should say the flag is the script's"
  assert_no_merge_call
  run_merge -- --match-head-commit=other --merge
  assert_eq "$MERGE_RC" 2 "the = form is refused too"
}

# Skipped and neutral are green for the ordinary gate; a close-out merge needs a build that RAN.
test_require_green_refuses_green_by_skips_only() {
  reset
  SKIPS_ONLY=1
  run_merge
  assert_eq "$MERGE_RC" 0 "the ordinary gate lets skips-only through"
  run_merge --require-green
  assert_eq "$MERGE_RC" 4 "--require-green refuses skips-only"
  assert_contains "$MERGE_OUTPUT" "skipped or neutral — green, but no build RAN" "should say why"
  assert_no_merge_call
}

test_require_green_refuses_auto() {
  reset
  run_merge --require-green -- --auto --merge
  assert_eq "$MERGE_RC" 2 "--auto with --require-green is a usage error"
  assert_contains "$MERGE_OUTPUT" "cannot be combined with --auto" "should name the conflict"
  assert_no_merge_call
}

# On a base that defers merges, gh returns 0 having only ENABLED auto-merge; a close-out merge
# takes that back rather than leaving a later head armed to land ungated.
test_require_green_disables_a_deferred_auto_merge() {
  reset
  MERGE_STATE="merged=false state=OPEN"
  run_merge
  assert_eq "$MERGE_RC" 1 "an ordinary deferred merge is exit 1"
  case "$MERGE_CALLS" in *--disable-auto*) bail "the ordinary path must not disable auto-merge" ;; esac
  run_merge --require-green
  assert_eq "$MERGE_RC" 1 "a deferred close-out merge is exit 1"
  assert_contains "$MERGE_CALLS" "--disable-auto" "auto-merge should be disabled again"
  assert_contains "$MERGE_OUTPUT" "auto-merge DISABLED again" "should say it took it back"
}

# A merge queue makes `gh pr merge` an enqueue, which --disable-auto cannot undo: a close-out
# merge refuses before calling merge, and reads the queue again right before the call. The
# ordinary gate never asks.
test_require_green_refuses_a_merge_queue() {
  reset
  MERGE_QUEUE=MQ_1
  run_merge
  assert_eq "$MERGE_RC" 0 "the ordinary gate merges on a queued base as before"
  case "$MERGE_CALLS" in *mergeQueue*) bail "the ordinary path must not read the queue" ;; esac
  run_merge --require-green
  assert_eq "$MERGE_RC" 1 "--require-green refuses a base with a merge queue"
  assert_contains "$MERGE_OUTPUT" "has a merge queue" "should say why"
  assert_contains "$MERGE_CALLS" "mergeQueue(branch:" "should have read the queue"
  assert_no_merge_call
  MERGE_QUEUE=""
  run_merge --require-green
  assert_eq "$MERGE_RC" 0 "no queue: --require-green merges ($MERGE_OUTPUT)"
  assert_eq "$(grep -c 'mergeQueue(branch:' "$CALLS_FILE")" 2 "the queue is read before and after the gate"
  local calls
  calls=$(grep -n 'mergeQueue\|pr merge' "$CALLS_FILE" | cut -d: -f2- | cut -c1-14 | tr '\n' ',')
  assert_eq "$calls" "CALL api graph,CALL api graph,CALL pr merge ," "both reads precede the merge call"
}

# A head with no build check and no workflow run, long after it was pushed, is ABSENT: nothing is
# red, and nothing is coming. The ordinary gate lands the gated head on it; a close-out merge still
# refuses -- a record-based merge is required to have READ a green, and a head nothing builds has
# none to read. (The same two outcomes on an absence the paths-ignore recognition settles inside
# the grace, ludics-lite#176, are pinned by test-pr-review-checks-absent.sh, whose fixture models
# the recognition's feeds.)
test_an_absent_head_merges_and_a_close_out_refuses_it() {
  reset
  NO_CHECKS=1
  run_merge
  assert_eq "$MERGE_RC" 0 "the ordinary gate merges a head nothing builds ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" ": ABSENT" "the verdict is the absence, not a green"
  assert_contains "$MERGE_OUTPUT" "no workflow run exists for this head in the" "carrying the reason"
  assert_contains "$MERGE_CALLS" "--match-head-commit head-sha " "still bound to the gated head"
  run_merge --require-green
  assert_eq "$MERGE_RC" 4 "a close-out merge needs a green it READ, which this head has none of"
  assert_contains "$MERGE_OUTPUT" "the build signal is absent" "the refusal names the verdict"
  assert_contains "$MERGE_OUTPUT" "path filters" "and points at the dispatch that would get one"
  assert_no_merge_call
}

# ludics-lite#623: a coordinated wave's close-out merge may go over its owned base red. A red
# --override waived is a verdict READ, so --require-green takes it and keeps its other refusals:
# without the override the red still refuses, and a waived red with no passing check beside it is
# still no build that RAN green.
test_require_green_takes_a_waived_red() {
  local why='base red, not this PR: ubuntu, test t, red at base-sha; owned by o/r#1'
  reset
  CHECK_ROWS="$(row red ubuntu failure)"$'\n'"$(row green macos success)"
  run_merge --require-green
  assert_eq "$MERGE_RC" 1 "a close-out without the override refuses the red ($MERGE_OUTPUT)"
  assert_no_merge_call
  run_merge --require-green --override "$why"
  assert_eq "$MERGE_RC" 0 "a close-out with the override merges over the waived red ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "OVERRIDE: merging example/repo#7 over a RED build signal — $why" \
    "the override is announced with its reason"
  reset
  CHECK_ROWS="$(row red ubuntu failure)"
  run_merge --require-green --override "$why"
  assert_eq "$MERGE_RC" 4 "a waived red with nothing green beside it is no build that ran green ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "beside the red --override waived" "the refusal says what it read"
  # The announcement waits for the refusals (ludics-lite#684's negative control printed it above one).
  assert_not_contains "$MERGE_OUTPUT" "OVERRIDE: merging" "and nothing is announced as merged over"
  assert_no_merge_call
}

test_superseded_head_never_merges() {
  reset
  CURRENT_HEAD=successor-sha
  run_merge --wait=30 --allow-no-verdict --override 'unrelated red on base'
  assert_eq "$MERGE_RC" 5 "superseded refuses even both verdict overrides"
  assert_contains "$MERGE_OUTPUT" "SUPERSEDED" "refusal names the transition"
  assert_no_merge_call
}

# ludics-lite#392. An override waives the reds the gate read when it was given, and nothing else:
# lukstafi/ocannl-staging#776 merged over an unrelated ubuntu red while its macOS leg was still
# RUNNING. One red plus one in-flight check is the issue's own fixture.
OVERRIDE_WHY='the ubuntu red is a pidfile race in an unrelated benchmark test'
# One check-run row: <class> <name> <concl> [<check suite id>, default 1].
row() { printf '%s\t%s\t%s\thttps://example/%s\t%s' "$1" "$2" "$3" "$2" "${4:-1}"; }

test_an_override_waits_for_a_check_still_running() {
  reset
  retune CHECKS_INTERVAL=1
  CHECK_ROWS="$(row red ubuntu failure)"$'\n'"$(row pending macos pending)"
  # The control: a red with nothing else outstanding is what the override is for.
  CHECK_ROWS_LATER="$(row red ubuntu failure)"$'\n'"$(row green macos success)"
  run_merge
  assert_eq "$MERGE_RC" 1 "the red refuses without an override ($MERGE_OUTPUT)"
  assert_no_merge_call
  # Without --wait: the red is waived, the running leg is not, and it is named.
  CHECK_ROWS_LATER=""
  run_merge --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 4 "a check still running is no verdict, override or not ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "running  macos (no verdict yet)" "the refusal names the running check"
  assert_contains "$MERGE_OUTPUT" "ubuntu (failure — WAIVED" "and marks the red it does waive"
  assert_contains "$MERGE_OUTPUT" "no override covers it" "saying the override is not the flag for it"
  assert_not_contains "$MERGE_OUTPUT" "OVERRIDE:" "nothing is announced as merged over"
  assert_no_merge_call
  # Under --wait: held until the leg has its verdict, then merged over the waived red alone.
  CHECK_ROWS_LATER="$(row red ubuntu failure)"$'\n'"$(row green macos success)"
  run_merge --wait=30 --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 0 "the leg went green, so the waived red is the only red ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total checks)" 2 "the gate read the checks again after the first read"
  assert_contains "$MERGE_OUTPUT" "RED, WAIVED" "the verdict says the red was waived"
  assert_contains "$MERGE_OUTPUT" "OVERRIDE: merging example/repo#7 over a RED build signal — $OVERRIDE_WHY" \
    "the override is announced with its reason"
  assert_contains "$MERGE_CALLS" "--match-head-commit head-sha " "and the merge is bound to the gated head"
  # Both flags are both facts: merging unread over the running leg also announces the waived red.
  CHECK_ROWS_LATER=""
  run_merge --override "$OVERRIDE_WHY" --allow-no-verdict
  assert_eq "$MERGE_RC" 0 "--allow-no-verdict is still the flag for a missing verdict ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "ALLOW-NO-VERDICT:" "the unread merge is announced"
  assert_contains "$MERGE_OUTPUT" "OVERRIDE: merging" "and so is the red it goes over"
  # ...in its own terms: with a red beside the unjudged leg, "nothing has failed" is false.
  assert_not_contains "$MERGE_OUTPUT" "nothing has failed, nothing has passed" "the unread-merge line does not deny the red"
  assert_contains "$MERGE_OUTPUT" "this is not 'nothing has failed'" "it says a red stands beside it"
}

# The waived set is the FIRST read's, not the one re-read after the wait: a check that turns red
# during it is a red nobody gave the override for, and it refuses as a plain red does.
test_a_check_that_turns_red_during_the_wait_is_not_waived() {
  reset
  retune CHECKS_INTERVAL=1
  CHECK_ROWS="$(row red ubuntu failure)"$'\n'"$(row pending macos pending)"
  CHECK_ROWS_LATER="$(row red ubuntu failure)"$'\n'"$(row red macos failure)"
  run_merge --wait=30 --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 1 "a red after the first read is not waived ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "  RED      macos (failure)  " "the new red is listed as a plain red"
  assert_contains "$MERGE_OUTPUT" "ubuntu (failure — WAIVED" "beside the one that was waived"
  assert_contains "$MERGE_OUTPUT" "RED that --override did not" "the refusal says the override does not reach it"
  assert_not_contains "$MERGE_OUTPUT" "OVERRIDE: merging" "nothing is announced as merged over"
  assert_no_merge_call
  # A waived check that is re-run is waited for while it runs, and stays waived by name.
  CHECK_ROWS="$(row red ubuntu failure)"$'\n'"$(row green macos success)"
  CHECK_ROWS_LATER="$(row pending ubuntu pending)"$'\n'"$(row green macos success)"
  run_merge --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 0 "the first read's red alone is waived at once ($MERGE_OUTPUT)"
  CHECK_ROWS="$(row pending ubuntu pending)"$'\n'"$(row green macos success)"
  CHECK_ROWS_LATER="$(row red ubuntu failure)"$'\n'"$(row green macos success)"
  run_merge --wait=30 --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 1 "a check with no verdict at the first read was never waived ($MERGE_OUTPUT)"
  assert_no_merge_call
  # A name is not an identity: two workflows can each run a job called `build`, and one's red
  # must not waive the other's later failure (review round 1). The key is the suite AND the name.
  CHECK_ROWS="$(row red build failure 1)"$'\n'"$(row pending build pending 2)"
  CHECK_ROWS_LATER="$(row red build failure 1)"$'\n'"$(row red build failure 2)"
  run_merge --wait=30 --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 1 "the other workflow's same-named check was not waived ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "  RED      build (failure)  " "it is listed as a plain red"
  assert_contains "$MERGE_OUTPUT" "build (failure — WAIVED" "beside the one that was waived"
  assert_no_merge_call
  # Nor is suite-and-name always unique: two jobs of ONE workflow may share a name, and nothing
  # tells which of the pair a re-run replaced (review rounds 3 and 4). A red under such a key is
  # never waived: refused at the first read, before any wait.
  CHECK_ROWS="$(row red build failure 1)"$'\n'"$(row pending build pending 1)"
  CHECK_ROWS_LATER="$(row green build success 1)"$'\n'"$(row red build failure 1)"
  run_merge --wait=30 --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 1 "a red with a same-named twin is not waived ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total checks)" 1 "refused at the first read, without waiting"
  assert_not_contains "$MERGE_OUTPUT" "— WAIVED" "neither row of the ambiguous key is waived"
  assert_no_merge_call
  # And a waived key that comes to name two rows after the first read is waived no longer.
  CHECK_ROWS="$(row red build failure 1)"$'\n'"$(row pending macos pending 1)"
  CHECK_ROWS_LATER="$(row red build failure 1)"$'\n'"$(row red build failure 1)"$'\n'"$(row green macos success 1)"
  run_merge --wait=30 --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 1 "a second row under a waived key un-waives it ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "— WAIVED" "neither row is waived"
  assert_no_merge_call
}

# ludics-lite#227. A closing keyword binds to every `#N` in its sentence, so one sentence naming two
# issues closes both -- which is how ludics-lite#205 was closed by a phase reference in #210. The
# scan says so before the merge lands, on both streams, naming the sentence and every issue.
test_one_sentence_closing_two_issues_warns() {
  reset
  PR_BODY='## What

The scanner lands. Closes #401 and #402
'
  run_merge
  assert_eq "$MERGE_RC" 0 "the warning is not a gate: the merge still lands ($MERGE_OUTPUT)"
  assert_contains "$MERGE_CALLS" "pr merge" "the merge call is still made"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING" "warns on stdout"
  assert_contains "$MERGE_STDERR" "CLOSING-KEYWORD WARNING" "and on stderr"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #401 #402" "names every issue it closes"
  assert_contains "$MERGE_STDOUT" "Closes #401 and #402" "names the sentence"
  # The sentence, not the line: the half before the full stop carries no keyword of its own.
  assert_not_contains "$MERGE_STDOUT" "The scanner lands." "the unit is the sentence, not the line"
}

# The other half of #227, and the shape that closed #205 a SECOND time: a keyword inside a `> `
# quote or a fenced block closes exactly as a statement does, so there ONE reference is already one
# nobody meant to close. The single plain `Closes` line in the same body stays out of the report.
test_a_closing_keyword_in_a_quoted_or_fenced_line_warns() {
  reset
  PR_BODY='Review record: the reviewer asked about the shape

> Closes #205

and about the one the skill prescribes:

```
Fixes #206
```

Closes #403
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_CALLS" "pr merge" "the merge call is still made"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #205" \
    "a quoted keyword is reported at ONE reference"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #206" \
    "a fenced one too"
  assert_contains "$MERGE_STDERR" "#205" "the quoted finding reaches stderr as well"
  assert_not_contains "$MERGE_STDOUT" "403" "the plain single-issue Closes line is not reported"
}

# The control, and the one that decides the unit: the shape ship-pr/SKILL.md *Open* PRESCRIBES --
# one `Closes #N` per line -- is silent. Markdown joins those two lines into one paragraph, so a
# paragraph-sized unit would make the prescribed shape the loudest warning in the file.
test_the_prescribed_shape_stays_silent() {
  reset
  PR_BODY='Two issues, one PR, and a third this only partially addresses.

Closes #404
Closes #405

Refs #406 and #407. A close-out merge of #408 and #409 names neither as done.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "the control merges ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "two Closes lines, a keyword-free reference and a hyphenated close-out are all silent"
}

# A body that could not be READ is not a body with nothing in it. Without this line the scan's
# silence is indistinguishable from a clean body -- the false negative this file refuses everywhere
# else (an unread approval is never "no approval yet").
test_an_unread_body_is_not_a_clean_body() {
  reset
  BODY_FAIL=1
  run_merge
  assert_eq "$MERGE_RC" 0 "an unreadable body does not block the merge"
  assert_contains "$MERGE_CALLS" "pr merge" "the merge call is still made"
  assert_contains "$MERGE_STDERR" "the closing-keyword scan did NOT run" \
    "the silence is announced as unread, not as clean"
}

# Review round 1, P2. A fence closes only on its own delimiter at its own length: a four-backtick
# fence exists so it can CONTAIN a three-backtick one, and an unconditional toggle reads the inner
# fence as the close -- after which the keyword inside the example reads as ordinary prose and the
# scan, whose whole subject is that example, says nothing.
test_a_longer_fence_is_not_closed_by_an_inner_one() {
  reset
  PR_BODY='How a body should NOT be written:

````markdown
```
Closes #410
```
````

Closes #411
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #410" \
    "the inner fence must not close the four-backtick one"
  assert_not_contains "$MERGE_STDOUT" "411" "the plain line after the real fence close is silent"
}

# Review rounds 1, 4 and 5 on one rule, and its removal. An abbreviation guard stood here for three
# rounds and was narrowed twice; both of its errors were FALSE POSITIVES, naming a reference that
# belonged to the next sentence and offering to reopen a live issue. Terminal punctuation now ends a
# unit outright: the cost is a missed warning when an abbreviation sits between two references, which
# is the fourth documented limitation, and the gain is that a sentence ending in a version number or
# a section letter can no longer produce wrong reopen advice.
test_a_period_ends_the_unit_with_no_abbreviation_guard() {
  reset
  # The two false positives the guard used to cause: both silent now.
  PR_BODY='Closes #616 in version 2. See #617 for follow-up.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" "a version number ends the sentence"
  PR_BODY='Closes #618 in appendix A. See #619 for context.
'
  run_merge
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" "a section letter ends it too"
  # The documented cost, asserted rather than merely described: this one IS missed.
  PR_BODY='Closes #621 and, e.g. #622
'
  run_merge
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "an abbreviation between two references is the fourth documented limitation"
  # And the rule the whole scan exists for is untouched.
  PR_BODY='Closes #623 and #624
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #623 #624" "the ordinary shape still warns"
}

# Review round 1, P2. A reference is reported as the body spells it, and `owner/tracker#123` names
# an issue this repository does not have: a remediation hardcoding the PR's own repo would reopen a
# same-numbered issue here, or fail.
test_the_reopen_remedy_does_not_hardcode_this_repo() {
  reset
  PR_BODY='Closes other/tracker#416 and other/tracker#417
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "other/tracker#416 other/tracker#417" \
    "the cross-repository form is reported whole"
  assert_contains "$MERGE_STDOUT" "in the repository its own reference names" \
    "the remedy sends the reader to the reference's own repository"
  assert_not_contains "$MERGE_STDOUT" "gh issue reopen <n> --repo $REPO" \
    "and never hardcodes this PR's repository"
}

# Review round 1, P2. A PR body stays editable through a --wait that can run two hours, and editing
# it does not move the head, so --match-head-commit cannot see it. The scan that matters is the one
# taken last; the early one is lead time.
test_the_body_is_scanned_again_before_the_merge() {
  reset
  PR_BODY='Nothing to see here.
'
  PR_BODY_LATER='Closes #418 and #419
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "was EDITED since the scan above" "the re-scan says what moved"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #418 #419" \
    "and reports the body that actually lands"
}

# The other side of the re-scan: an unchanged body is not the whole block printed twice.
test_an_unchanged_body_is_not_reported_twice() {
  reset
  PR_BODY='Closes #420 and #421
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_eq "$(grep -c 'ONE sentence, 2 issues: #420 #421' "$OUT_FILE")" 1 \
    "the findings block is printed once, by the scan that had lead time"
  assert_contains "$MERGE_STDOUT" "is UNCHANGED since the scan above" \
    "and the re-scan confirms the body that lands is that one"
  # And an edit that REMOVES the sentence retracts the warning rather than leaving it standing.
  reset
  PR_BODY='Closes #422 and #423
'
  PR_BODY_LATER='Closes #422
'
  run_merge
  assert_contains "$MERGE_STDOUT" "WARNING WITHDRAWN" "a fixed body retracts the earlier finding"
}

# Review round 2, P2. A repository NAME may lead with punctuation -- `github/.github` is real --
# while an owner, like a GitHub login, may not. Requiring an alphanumeric on both sides made a body
# naming two such references produce no warning at all.
test_a_repository_name_may_lead_with_punctuation() {
  reset
  PR_BODY='Closes github/.github#424 and github/.github#425
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: github/.github#424 github/.github#425" \
    "a dot-leading repository name is still a reference"
}

# Review round 2, P2. A CLOSING fence carries no info string: only spaces or tabs may follow its
# run. A content line that merely starts with the delimiter was ending the block, after which the
# rest of the example read as ordinary prose.
test_a_closing_fence_takes_no_info_string() {
  reset
  PR_BODY='An example of what not to write:

````markdown
````not-a-close
Closes #426
````

Closes #427
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #426" \
    "a delimiter with a suffix does not close the block"
  assert_not_contains "$MERGE_STDOUT" "427" "the line after the real close is outside the block"
}

# Review round 3, P2. A blockquote nested in a list item is still a blockquote, and the `>` test
# ran against a line the list marker still led -- so the quoted rule, which fires at ONE reference,
# never saw it and the ordinary rule ignores a single reference by design.
test_a_quote_nested_in_a_list_item_is_still_quoted() {
  reset
  PR_BODY='The shapes to avoid:

- > Closes #601
  1. > Fixes #602

Closes #603
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #601" \
    "a quote behind a list marker is quoted"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #602" \
    "and behind an ordered one too"
  assert_not_contains "$MERGE_STDOUT" "603" "the plain line is still silent"
}

# Review round 3, P2. A closing quote sits between the full stop and the space often enough to
# matter: without it the two sentences stayed one unit and the warning named an issue belonging to
# the next one -- a false positive that would have sent the operator to reopen a live issue.
test_a_closing_quote_still_ends_the_sentence() {
  reset
  PR_BODY='The example says "Closes #604." See #605 for follow-up.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "the quoted full stop ends the sentence, so #605 is not bound"
}

# Review round 3, P2. A body here is full of run links. A fragment in one is not an issue, and a
# host with a path was even being reported as a cross-repository reference.
test_a_url_fragment_is_not_an_issue_reference() {
  reset
  PR_BODY='Closes #606; see https://example.com/docs/#607 and https://example.com/page#608 for details.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "one real reference and two URL fragments is one reference"
}

# Review round 3, P2. One issue named twice is one issue: counting occurrences made the count, the
# list and the reopen advice all false.
test_the_same_issue_named_twice_is_one_issue() {
  reset
  PR_BODY='The request in #609 is complete, so this closes #609.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a repeated reference is not a second issue"
  # Two distinct ones in the same shape still warn, so the dedupe did not disarm the rule.
  # #610 stands BEFORE the keyword, so only #611 is bound -- see the forward-binding case below.
  PR_BODY='This closes #610 and #611.
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #610 #611" "two distinct ones still warn"
}

# Review round 4, P2. Four leading spaces make an indented CODE block, which SKILL.md names as a
# shape this scanner does not read. Stripping all leading whitespace made one a blockquote, so the
# scan warned about the very example the documentation says it ignores -- and an indented fence
# opened a phantom block that swallowed the ordinary text after it.
test_four_space_indentation_is_not_a_quote_or_a_fence() {
  reset
  PR_BODY='An indented example, which is code and is not read:

    > Closes #612
    ```
    Closes #613
    ```

Closes #614 and #615
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_STDOUT" "612" "an indented quote is code, not a blockquote"
  assert_not_contains "$MERGE_STDOUT" "613" "and the indented fence opens nothing"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #614 #615" \
    "the ordinary line after it is still read, so no phantom fence swallowed it"
}

# Review round 4, P2. GitHub numbers start at 1, so `#0` is prose -- and reopen advice for it would
# point at an issue that does not exist.
test_hash_zero_is_not_an_issue_reference() {
  reset
  PR_BODY='Closes #620; step #0 initializes the state.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" "#0 is not a second issue"
  # A number that merely starts with a zero digit later is untouched.
  PR_BODY='Closes #620 and #1024
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #620 #1024" "ordinary numbers still count"
}

# Review round 5, P2. A schemeless link produced a bogus cross-repository reference out of a host
# label and a path. Enumerating URL spellings was the wrong shape of fix; the boundary closes the
# genre instead -- a reference preceded by a dot or a slash is a path or a host, whatever scheme it
# carries or does not carry.
test_a_schemeless_link_is_not_an_issue_reference() {
  reset
  PR_BODY='Closes #625; see www.example.com/page#626 and https://example.com/docs/#627 for details.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "one real reference and two links is one reference"
}

# Review round 5, P2. The bare and the fully qualified spelling of an issue in THIS repository name
# one issue, and the repository is knowable here because the caller passes it in.
test_the_local_qualified_spelling_is_the_same_issue() {
  reset
  PR_BODY='Closes #628 (example/repo#628).
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a bare and a locally qualified reference are one issue"
  # A reference to another repository is a different issue, and still counts.
  PR_BODY='Closes #629 (other/tracker#629).
'
  run_merge
  assert_contains "$MERGE_STDOUT" "2 issues: #629 other/tracker#629" \
    "another repository is another issue"
}

# Review round 5, P2. await_mergeable can hold for tens of seconds before the loop retries the
# merge, and a body edited in that window moves no head. The authoritative scan therefore runs
# before EVERY attempt, not once before the loop.
test_the_body_is_rescanned_before_a_retried_merge() {
  reset
  MERGE_NOT_MERGEABLE=1
  PR_BODY='Nothing to see here.
'
  PR_BODY_LATER='Closes #630 and #631
'
  run_merge
  assert_eq "$MERGE_RC" 0 "the retry still merges ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #630 #631" \
    "the body added during the mergeability wait is reported"
}

# GitHub refuses a merge whose BASE moved during the call with the same "was modified" as a moved
# head. On ludics-lite#348 the script told the caller a push had moved the head, which was still the
# gated SHA. The head re-read tells the two apart: an unchanged head re-reads the drift and retries.
test_a_base_moved_during_the_call_is_not_a_head_move() {
  reset
  MERGE_BASE_MODIFIED=1
  run_merge
  assert_eq "$MERGE_RC" 0 "the retry onto the moved base merges ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "BASE moved during the merge call, not its head (still head-sha)" \
    "the base move is named as a base move"
  assert_not_contains "$MERGE_OUTPUT" "head is no longer" "no push is claimed"
  assert_eq "$(grep -c 'pr merge' <<<"$MERGE_CALLS")" 2 "one retry"
  assert_eq "$(grep -c 'warn_base_drift' <<<"$MERGE_CALLS")" 2 "the drift is re-read for the new base"
  reset
  MERGE_BASE_MODIFIED=1
  HEAD_AFTER_MERGE=pushed-sha
  run_merge
  assert_eq "$MERGE_RC" 1 "a head that moved as well is refused ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "head is no longer head-sha" "a real head move keeps its message"
  assert_eq "$(grep -c 'pr merge' <<<"$MERGE_CALLS")" 1 "and is not retried"
  # Review round 1: a head the read did not name is unread, not moved.
  reset
  MERGE_BASE_MODIFIED=1
  HEAD_AFTER_MERGE=-
  run_merge
  assert_eq "$MERGE_RC" 3 "an unnamed head is unread ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "head is no longer" "and claims no push"
  # Review round 1: ABSENT was recognized against the base that just moved, so it is not retried.
  reset
  MERGE_BASE_MODIFIED=1
  NO_CHECKS=1
  run_merge
  assert_eq "$MERGE_RC" 1 "an ABSENT verdict is refused after a base move ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "ABSENT verdict was recognized against the old base" \
    "the refusal names the base as the reason"
  assert_eq "$(grep -c 'pr merge' <<<"$MERGE_CALLS")" 1 "and is not retried"
}

# ludics-lite#523: an ABSENT verdict can rest on the base, and the merge call binds only the head,
# so the base is re-read last before each attempt and a moved one is gated again. The recognition
# itself, on a base that added a workflow, is test-pr-review-checks-absent.sh's; these are the
# merge loop's own outcomes.
test_an_absent_verdict_rereads_its_base_before_the_call() {
  # Green rests on the head's own runs: no base read.
  reset
  run_merge
  assert_eq "$MERGE_RC" 0 "a green head merges ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_CALLS" "CALL base-sha" "a green verdict does not re-read the base"
  # Absent on an unmoved base: one read, then the call.
  reset
  NO_CHECKS=1
  run_merge
  assert_eq "$MERGE_RC" 0 "an absent head on an unmoved base merges ($MERGE_OUTPUT)"
  assert_eq "$(grep -c 'CALL base-sha' <<<"$MERGE_CALLS")" 1 "one base read"
  assert_not_contains "$MERGE_OUTPUT" "gating the head again" "and no second gate"
  # Moved, and the second gate still finds the absence: merged on the new base after a rescan.
  reset
  NO_CHECKS=1
  BASE_MOVED=moved-base
  run_merge
  assert_eq "$MERGE_RC" 0 "an absence the new base still settles merges ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "base moved since its ABSENT verdict was read (base-sha -> moved-ba)" \
    "the move is named"
  assert_eq "$(grep -c 'CALL base-sha' <<<"$MERGE_CALLS")" 2 "the rescan reads the base once more"
  assert_eq "$(grep -c 'warn_base_drift' <<<"$MERGE_CALLS")" 2 "the drift is re-read for the new base"
  assert_eq "$(grep -c 'pr merge' <<<"$MERGE_CALLS")" 1 "one merge call"
  # Moved, and the second gate has no verdict: refused with the gate's status, nothing merged.
  reset
  NO_CHECKS=1
  BASE_MOVED=moved-base
  MOVED_RUN_RC=4
  run_merge
  assert_eq "$MERGE_RC" 4 "no verdict on the new base is not merged ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "the gate read against the new base is unjudged" "says why"
  assert_no_merge_call
  # Moved, and the head moved too: the second gate is about another head.
  reset
  NO_CHECKS=1
  BASE_MOVED=moved-base
  HEAD_AFTER_MOVE=pushed-sha
  run_merge
  assert_eq "$MERGE_RC" 5 "a head that moved with the base is refused ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "head moved too (head-sha -> pushed-s)" "and named"
  assert_no_merge_call
  # An unread base is unknown, not unmoved.
  reset
  NO_CHECKS=1
  BASE_READ_FAIL=1
  run_merge
  assert_eq "$MERGE_RC" 3 "an unread base is not merged on ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "base could not be re-read" "says so"
  assert_no_merge_call
}

# ludics-lite#471: gh refusing the merge call's own flags is a gh/script version mismatch, exit 2
# on the one call. With the caller's flags forwarded after `--`, the call is the caller's (review
# of #490): a refusal there may be the caller's typo, and a forwarded `--delete-branch` runs git
# after the merge, so it keeps the write policy's ambiguous exit 3.
test_a_refused_merge_call_is_the_scripts_only_without_forwarded_flags() {
  reset
  MERGE_REFUSAL='unknown flag: --match-head-commit'
  run_merge
  assert_eq "$MERGE_RC" 2 "the script's own merge call refused is exit 2 ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "refused this script's own call, which sent nothing: gh pr merge 7" \
    "naming the call"
  assert_eq "$(grep -c 'pr merge' <<<"$MERGE_CALLS")" 1 "on its first attempt"
  reset
  MERGE_REFUSAL='unknown flag: --nosuchflag'
  run_merge -- --squash --nosuchflag
  assert_eq "$MERGE_RC" 3 "with forwarded flags it stays ambiguous ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "AMBIGUOUSLY" "as a write that may have landed"
  assert_not_contains "$MERGE_OUTPUT" "refused this script's own call" "not the script's mismatch"
}

# Review round 6, P2. A body keyword binds only on a merge into the repository DEFAULT branch. On a
# PR targeting a release or staging branch it closes nothing, so warning there would name issues
# this merge leaves open and offer to reopen issues that were never closed -- the one thing this
# scan may never do.
test_no_warning_when_the_base_is_not_the_default_branch() {
  reset
  PR_BODY='Closes #632 and #633
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #632 #633" "on the default branch it warns"
  reset
  PR_BODY='Closes #632 and #633
'
  PR_BASE=release-1.2
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a keyword is inert on a merge into a non-default branch"
}

# ... and an unread comparison is not an inert one: the findings still print, with the doubt named.
test_an_unread_default_branch_is_not_an_inert_keyword() {
  reset
  PR_BODY='Closes #634 and #635
'
  DEFAULT_BRANCH_FAIL=1
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #634 #635" "the findings still print"
  assert_contains "$MERGE_STDOUT" "could NOT be read" "with the doubt on the line"
}

# Review round 6, P2. An owner or a repository may be NAMED `closed`, and the keyword boundary
# accepted the `/` that follows it -- so a sentence carrying no closing directive at all produced a
# two-issue warning with reopen guidance.
test_a_repository_named_like_a_keyword_is_not_a_keyword() {
  reset
  PR_BODY='See closed/tracker#636 and closed/tracker#637 for context.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a keyword that is a path component is not a directive"
}

# Review round 6, P2. Owner and repository names are case-insensitive on GitHub, so two spellings
# of one reference are one issue.
test_reference_case_does_not_make_a_second_issue() {
  reset
  PR_BODY='Closes Other/Tracker#638 and other/tracker#638
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "two spellings of one reference are one issue"
}

# Review round 6, P2. Indentation is COLUMNS: a tab advances to the next stop, so one to three
# spaces before one still reach column four, which is code and not a blockquote.
test_a_tab_after_spaces_is_still_code_indentation() {
  reset
  PR_BODY=$(printf 'An indented example:\n\n  \t> Closes #639\n\nCloses #640 and #641\n')
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_STDOUT" "639" "two spaces then a tab is column four, so code"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #640 #641" "the ordinary line still reads"
}

# Review round 6, P2. A backtick opener carries no backtick in its info string; such a line opens
# nothing, and treating it as an opener left the rest of the body in a phantom fenced block.
test_an_invalid_backtick_opener_opens_no_fence() {
  reset
  PR_BODY='An invalid opener:

```bad`info

Closes #642
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "the plain line after an invalid opener is not fenced"
  # A valid opener still opens one.
  PR_BODY='A valid opener:

```markdown
Closes #643
```
'
  run_merge
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #643" \
    "a valid info string still opens a fence"
}

# Review round 7, P2. A PR can be RETARGETED during a wait that runs two hours, so the base/default
# comparison is read every time rather than cached -- the same reason cmd_merge reads the merge
# queue twice. A cached answer would skip the scan on a PR moved ONTO the default branch.
test_a_retarget_during_the_gate_is_seen() {
  reset
  PR_BODY='Closes #644 and #645
'
  PR_BASE=release-1.2
  # The early scan sees a non-default base and says nothing; the fixture then reports the default
  # base from the second read on, which is what a retarget during the wait looks like.
  BASE_LATER=main
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #644 #645" \
    "the authoritative scan re-reads the base and finds the keyword now binds"
}

# Review round 7, P2. The unknown state must carry the reason that caused it: the successful body
# read that follows clears the shared error file, so reading it back printed an empty cause.
test_an_unknown_comparison_names_its_cause() {
  reset
  PR_BODY='Closes #646 and #647
'
  DEFAULT_BRANCH_FAIL=1
  run_merge
  assert_contains "$MERGE_STDOUT" "the default branch could not be read: gh: Not Found (HTTP 404)" \
    "the cause of the uncertainty survives the body read"
}

# Review round 7, P2. A Markdown link destination sits between the terminator and the space, so the
# two sentences stayed one unit and the scan named a reference from the next one.
test_a_link_destination_does_not_join_two_sentences() {
  reset
  PR_BODY='[Closes #648.](https://example.test/x) See #649 for context.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "the link destination does not hold two sentences together"
  # A version number must still NOT split, which is what the alphanumeric guard is for.
  PR_BODY='Closes #650 and #651 in release 3.5 of the tool
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #650 #651" "a decimal is not a boundary"
}

# Review round 7, P2. "Unchanged" was decided on the FINDINGS, so a body that gained an ordinary
# single-reference `Closes` line compared equal -- and the re-scan confirmed the merge closed what
# it had listed while it was about to close one more.
test_an_added_plain_closes_line_is_not_an_unchanged_body() {
  reset
  PR_BODY='Closes #652 and #653
'
  PR_BODY_LATER='Closes #652 and #653

Closes #654
'
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_STDOUT" "is UNCHANGED since the scan above" \
    "a body that gained a closing line is not unchanged"
  assert_contains "$MERGE_STDOUT" "was EDITED since the scan above" "the re-scan says the body moved"
}

# Review round 7, P2. A query string puts `=` or `&` in front of a hash, which two rounds of
# blacklisting the preceding character did not cover. The boundary is a whitelist now.
test_a_query_string_hash_is_not_an_issue_reference() {
  reset
  PR_BODY='Closes #655; see www.example.com/?issue=#656 for details.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" "a query-string hash is not a reference"
  # The shapes a human actually writes still count, including a reference in inline code or
  # brackets -- the whitelist has to admit those or the scan goes quiet on ordinary bodies.
  PR_BODY='Closes (#657) and `#658`
'
  run_merge
  assert_contains "$MERGE_STDOUT" "2 issues: #657 #658" "brackets and inline code still open a reference"
}

# Review round 8, P2. The mirror of the retarget case: when the lead-time scan warned and the PR is
# then moved OFF the default branch, returning silently leaves that warning standing in the
# transcript still saying issues are about to close.
test_a_retarget_off_the_default_branch_withdraws_the_warning() {
  reset
  PR_BODY='Closes #659 and #660
'
  PR_BASE=main
  BASE_LATER=release-1.2
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #659 #660" "the lead-time scan warned"
  assert_contains "$MERGE_STDOUT" "no longer targets the default branch" \
    "and the authoritative scan retracts it"
}

# Review round 8, P2. A Markdown destination may be followed by a quoted title inside the same
# parentheses, so the group has to run to its closing paren and not to the next space.
test_a_titled_link_does_not_join_two_sentences() {
  reset
  PR_BODY='[Closes #661.](https://example.test/x "the title") See #662 for context.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a titled link does not hold two sentences together"
}

# Review round 8, P2. A URL can CONTAIN the characters a human writes a reference after, so the
# boundary whitelist alone was not enough: schemeless hosts are stripped as well.
test_a_schemeless_url_containing_a_delimiter_is_stripped() {
  reset
  PR_BODY='Closes #663; see www.example.com/?issues=foo,#664 for details.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a comma inside a URL does not open a reference"
}

# Review round 8, P2. An EXCLUDING character class is ASCII-shaped, so the first byte of a non-ASCII
# letter read as punctuation and a French past participle matched as a closing keyword.
test_a_non_ascii_word_is_not_a_keyword() {
  reset
  PR_BODY='Ceci fixes #665 et #666.
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #665 #666" \
    "the ASCII spelling really is a keyword, so the case has something to distinguish"
  reset
  PR_BODY=$(printf 'Ceci fix\303\251s #665 et #666.\n')
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a keyword followed by a non-ASCII letter is part of another word"
}

# Review round 9, P2. The fourth Markdown link form to reach the sentence boundary in four rounds,
# and the one that ended the enumeration: the boundary no longer lists closers at all.
test_a_reference_style_link_does_not_join_two_sentences() {
  reset
  PR_BODY='[Closes #667.][details] See #668 for context.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a reference-style link suffix does not hold two sentences together"
  # The three earlier forms, and the decimal that must still not split, all in one body.
  PR_BODY='[Closes #669.](https://example.test/x "t") See #670. "Closes #671." See #672.
'
  run_merge
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" "the earlier link forms still split"
  PR_BODY='Closes #673 and #674 in release 3.5 of the tool
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #673 #674" "a decimal is still not a boundary"
}

# Review round 9, P2. A boundary is owed on both sides of a reference: the numeric run stopped
# where the digits did, so a CSS colour was read as an issue and carried reopen advice for it.
test_a_reference_needs_a_boundary_after_its_digits() {
  reset
  PR_BODY='Closes #675 after changing #123abc.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" "a hex colour is not an issue"
  # A reference followed by ordinary punctuation, or ending the line, still counts.
  PR_BODY='Closes #676, #677.
'
  run_merge
  assert_contains "$MERGE_STDOUT" "2 issues: #676 #677" "punctuation and end of line are boundaries"
}

# Review round 10, P2. A query may follow a bare host with no path at all, so the schemeless-URL
# suffix has to start at a slash, a question mark or a hash.
test_a_query_only_schemeless_url_is_stripped() {
  reset
  PR_BODY='Closes #678; see www.example.com?issues=foo,#679 for details.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" \
    "a query with no path is still part of the URL"
}

# Review round 10, P2. Markdown allows at most nine digits in an ordered marker, so a longer run is
# ordinary text -- and peeling it made a line a list item it is not, after which a `>` behind it
# read as a blockquote.
test_an_over_long_numeric_prefix_is_not_a_list_marker() {
  reset
  PR_BODY='1234567890. > Closes #680
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" \
    "a ten-digit prefix is text, not an ordered marker"
  # A marker of a length Markdown does accept still peels, so the round-3 fix survives.
  PR_BODY='123456789. > Closes #681
'
  run_merge
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #681" \
    "a nine-digit marker is still a list marker"
}

# Review round 10, P2. The close-out queue refusal has to be the LAST thing before the merge call:
# the body scan makes three REST reads, and a queue enabled during them would turn the call into an
# enqueue that --require-green exists to refuse.
test_the_queue_is_read_after_the_body_scan() {
  reset
  PR_BODY='Closes #682 and #683
'
  run_merge --require-green
  assert_eq "$MERGE_RC" 0 "a close-out merge still lands ($MERGE_OUTPUT)"
  # The queue read is made twice as before, and the LAST one now follows the scan.
  assert_eq "$(grep -c 'mergeQueue(branch:' "$CALLS_FILE")" 2 "still two queue reads on the happy path"
  local order
  order=$(grep -n 'mergeQueue\|pr merge' "$CALLS_FILE" | cut -d: -f2- | cut -c1-14 | tr '\n' ',')
  assert_eq "$order" "CALL api graph,CALL api graph,CALL pr merge ," "both reads still precede the merge"
}

# Review round 11, P2. The documentation says an indented code block is a shape this scanner does
# not read; suppressing only the quote and fence tests still had an indented ordinary sentence
# warned about, which contradicted it in the one direction that matters.
test_an_indented_code_line_is_not_scanned_at_all() {
  reset
  PR_BODY='An indented example:

    Closes #684 and #685

Closes #686 and #687
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_STDOUT" "684" "an indented sentence is code, and code is not read"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #686 #687" "the ordinary line still is"
}

# Review round 11, P2. A list marker takes ONE space of padding; four columns beyond it open an
# indented code block inside the item, so stripping the whole run made code look like a blockquote.
test_a_list_marker_does_not_swallow_code_indentation() {
  reset
  PR_BODY='-     > Closes #688
- > Closes #689
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_STDOUT" "688" "four columns past the padding is code"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #689" \
    "one space of padding is still a list item with a quote in it"
}

# Review round 11, P2. A port stands between a schemeless host and its suffix.
test_a_port_in_a_schemeless_url_is_stripped() {
  reset
  PR_BODY='Closes #690; see www.example.com:8080/?issues=foo,#691 for details.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD WARNING" "a port does not end the URL"
}

# Review round 11, P2. Only a warning that was PRINTED can be withdrawn: a clean body edited to
# another clean body was producing a loud retraction of nothing at all.
test_a_clean_body_edited_to_another_clean_body_is_silent() {
  reset
  PR_BODY='Nothing here.
'
  PR_BODY_LATER='Still nothing here.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "WITHDRAWN" "nothing was warned, so nothing is withdrawn"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "and the merge is silent throughout"
}

# Review round 11, P2. An unchanged BODY is not an unchanged answer: if the comparison can no
# longer be read, the last word on a finding the caller has already read must say so.
test_an_unchanged_body_still_reports_a_lost_comparison() {
  reset
  PR_BODY='Closes #692 and #693
'
  DEFAULT_BRANCH_FAIL_LATER=1
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "is UNCHANGED since the scan above" "the body did not move"
  assert_contains "$MERGE_STDOUT" "whether they bind could NOT be re-read" \
    "but whether the keywords bind is no longer known"
}

# Review rounds 12 and 16 on one rule. Round 12 let an open fence close at any indentation, to
# reach a delimiter indented as a list-item continuation; round 16 showed that errs in the UNSAFE
# direction, because closing early turns fenced lines into ordinary prose and promotes a notice
# into a warning that says issues close. Leaving the fence OPEN is the safe error: what it swallows
# becomes a notice, which claims nothing. The round-12 shape is the documented cost.
test_an_indented_delimiter_leaves_the_fence_open() {
  reset
  PR_BODY='- ```
      example
      ```

Closes #694 and #695
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD NOTICE" \
    "the fence stays open, so what follows is read as an example"
  assert_not_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING" \
    "and is never promoted to a claim that issues close"
}

# Review round 12, convergence. The two findings make different claims, and only one of them rests
# on the block classifier: a quoted or fenced line is flagged to be READ, and says nothing about
# what closes, so a misreading of the Markdown cannot produce a false statement about a merge.
test_a_quoted_finding_claims_nothing_about_closing() {
  reset
  PR_BODY='> Closes #695
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD NOTICE" "a quoted-only body is a notice"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #695" \
    "and names the line"
  assert_contains "$MERGE_STDOUT" "may be ordinary prose" "and says the reading is best-effort"
  assert_not_contains "$MERGE_STDOUT" "EDIT THE BODY now" "no reopen remedy for a flagged line"
  assert_not_contains "$MERGE_STDOUT" "gh issue reopen" "and no reopen command"
  # A multi-reference sentence still makes the strong claim, because it consults no Markdown.
  reset
  PR_BODY='Closes #696 and #697
'
  run_merge
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING" "a sentence finding is still a warning"
  assert_contains "$MERGE_STDOUT" "EDIT THE BODY now" "and still carries the remedy"
}

# Review round 13, P2 and BLOCKING: this path undid the guarantee round 12 established. An
# unchanged quoted-only body reached the re-scan shortcut and was reported with a WARNING saying
# the merge closes what it listed -- the exact claim the quoted class was stripped of.
test_an_unchanged_quoted_only_body_keeps_notice_wording() {
  reset
  PR_BODY='> Closes #702
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD NOTICE" "the lead-time scan is a notice"
  assert_not_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING" \
    "and the re-scan of the unchanged body must not promote it to a warning"
  assert_not_contains "$MERGE_STDOUT" "closes what it listed" "nor claim what the merge closes"
  assert_contains "$MERGE_STDOUT" "the line flagged there is the line that lands" \
    "it says the body did not move, in the register it said the rest in"
  # A body that DOES carry a sentence finding still gets the strong register on the re-scan.
  reset
  PR_BODY='Closes #703 and #704
'
  run_merge
  assert_contains "$MERGE_STDOUT" "is UNCHANGED since the scan above, so the merge closes what it listed" \
    "a sentence finding keeps the strong wording"
}

# Review round 13, P2. An intraword underscore is not an emphasis boundary, so admitting `_` as a
# keyword boundary made an ordinary identifier a closing directive -- a strong warning with reopen
# guidance on a sentence carrying no directive at all.
test_an_identifier_containing_a_keyword_is_not_a_keyword() {
  reset
  PR_BODY='The auto_closes_items helper covers #705 and #706.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "an identifier is not a directive"
  # Asterisk emphasis around a real keyword still is one.
  PR_BODY='*Closes #707 and #708*
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #707 #708" "emphasis still bounds a keyword"
}

# Review round 13, P2. The sentence is contributor-controlled text on its way to a terminal, and
# this warning is the whole product of the scan: an ESC or a carriage return could erase or forge
# it. printf stops format-string expansion; it does not neutralize terminal control bytes.
test_control_bytes_in_the_body_cannot_forge_the_warning() {
  reset
  PR_BODY=$(printf 'Closes #709 and #710\033[2K\rFORGED LINE\n')
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #709 #710" "the finding still reports"
  case "$MERGE_OUTPUT" in
  *$'\033'*) bail "an escape byte reached the output" ;;
  *$'\r'*) bail "a carriage return reached the output" ;;
  esac
  assert_contains "$MERGE_STDOUT" "?[2K?FORGED LINE" "the control bytes are shown, not executed"
}

# Review round 14, P2 and BLOCKING. The third of three lines that speak about a finding the caller
# has already read, and the last one still announcing a quoted-only finding as a WARNING that says
# what the merge closes -- directly against the guarantee the quoted class was given.
test_an_edited_body_with_a_quoted_only_finding_keeps_notice_wording() {
  reset
  PR_BODY='Nothing here.
'
  PR_BODY_LATER='> Closes #711
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD NOTICE" "the edited-body banner is a notice"
  assert_not_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING" "and never a warning"
  assert_not_contains "$MERGE_STDOUT" "what this merge closes is below" "nor a claim about closing"
  assert_contains "$MERGE_STDOUT" "reads as a QUOTED or FENCED example, 1 reference(s): #711" \
    "the finding itself still reports"
  # A body edited to carry a SENTENCE finding still gets the strong banner.
  reset
  PR_BODY='Nothing here.
'
  PR_BODY_LATER='Closes #712 and #713
'
  run_merge
  assert_contains "$MERGE_STDOUT" "what this merge closes is below, not there" \
    "a sentence finding keeps the strong banner"
}

# Review round 14, P2. A dot after a keyword makes a dotted TOKEN, not a boundary: a filename and a
# hostname were both being read as closing directives, with the strong warning and reopen guidance
# on prose carrying no directive at all.
test_a_dotted_token_containing_a_keyword_is_not_a_keyword() {
  reset
  PR_BODY='The fixes.md file covers #714 and #715.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "a filename is not a directive"
  PR_BODY='See fixes.co for #716 and #717.
'
  run_merge
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "nor is a hostname"
  # The boundaries a real directive uses are untouched -- including a full stop that ENDS the
  # sentence, whose references stand before the keyword, which dropping the dot outright would
  # have silenced. The suite caught that overreach.
  PR_BODY='Closes: #718, #719
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #718 #719" "a colon still bounds a keyword"
  # Round 15 corrected this: a keyword ENDING the sentence binds nothing, because GitHub closing
  # syntax is the keyword followed by the reference. Round 14 asserted the opposite here, on my
  # reasoning about the dot rather than about GitHub.
  PR_BODY='Issues #720 and #721 are now fixed.
'
  run_merge
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" \
    "references standing before the keyword are not bound by it"
}

# Review round 15, P2. GitHub closing syntax is the keyword FOLLOWED BY the reference, so a
# reference standing before the keyword is not bound -- and reporting one as closed, with advice to
# reopen it, is the false claim this scan exists to avoid making.
test_references_before_the_keyword_are_not_bound() {
  reset
  PR_BODY='Issues #722 and #723 are now fixed.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "neither reference follows the keyword"
  # One before and one after binds only the one after, which is one issue and so silent.
  PR_BODY='#724 is done, and this closes #725.
'
  run_merge
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "only the reference after the keyword binds"
  # The incident this feature was built for had both references after the keyword.
  PR_BODY='Resolves #726 and #727 for the phase
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #726 #727" "forward binding still warns"
}

# Review round 15, P2. The fourth register path: a retarget off the default branch retracted a
# quoted-only finding with WARNING WITHDRAWN.
test_a_retarget_withdrawal_keeps_the_finding_register() {
  reset
  PR_BODY='> Closes #728
'
  PR_BASE=main
  BASE_LATER=release-1.2
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge still lands ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD NOTICE WITHDRAWN" "a notice is withdrawn as one"
  assert_not_contains "$MERGE_STDOUT" "WARNING WITHDRAWN" "and never promoted to a warning"
}

# Review round 15, P2. A mixed body: "closes what it listed" swept the quoted entry into a claim
# the scan refuses to make about it.
test_a_mixed_unchanged_body_confirms_each_class_in_its_own_terms() {
  reset
  PR_BODY='Closes #729 and #730

> Closes #731
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "closes the issues its WARNING listed" \
    "the confirmation is scoped to the sentence finding"
  assert_contains "$MERGE_STDOUT" "still claims nothing" "and the quoted entry keeps its register"
  assert_not_contains "$MERGE_STDOUT" "so the merge closes what it listed" \
    "the unscoped wording is gone on a mixed body"
}

# Review round 15, P2. A dot followed by an identifier continuation is not a boundary either.
test_a_dot_underscore_token_is_not_a_keyword() {
  reset
  PR_BODY='#801 and #802 use fix._config
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "a dotted identifier is not a directive"
}

# Review round 16, P2. Inside a top-level fence an indented delimiter is CONTENT, so closing there
# would turn the fenced lines after it into ordinary prose -- promoting a notice that claims
# nothing into a warning that says issues close.
test_an_indented_delimiter_inside_a_fence_is_content() {
  reset
  PR_BODY='```
    ```
Closes #802 and #803
```
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD NOTICE" "the line stays inside the fence"
  assert_not_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING" "and is not a closing claim"
}

# Review round 16, P2. The keyword must be located in the SAME text the references are read from:
# scrubbing inside refs_of let a keyword match a word in a URL path, after which the forward slice
# handed refs_of a fragment with the scheme and host already cut away.
test_a_keyword_inside_a_url_path_is_not_a_directive() {
  reset
  PR_BODY='See https://example.com/path,closes,details for issues #804 and #805.
'
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "a word in a URL path is not a directive"
  # A real directive alongside a URL still reports.
  PR_BODY='Closes #806 and #807; see https://example.com/path,closes,details.
'
  run_merge
  assert_contains "$MERGE_STDOUT" "ONE sentence, 2 issues: #806 #807" "the real directive still binds"
}

# Review round 16, P2. When the body could not be read, the deferred-merge refusal may not claim
# the scan spoke for the body.
test_the_deferred_merge_note_does_not_claim_an_unread_scan() {
  reset
  BODY_FAIL=1
  MERGE_STATE="merged=false state=OPEN"
  run_merge
  assert_eq "$MERGE_RC" 1 "a deferred merge is exit 1"
  assert_contains "$MERGE_OUTPUT" "scan did NOT read the body for this attempt" \
    "the refusal says the scan did not run"
  assert_not_contains "$MERGE_OUTPUT" "spoke for the body as it is NOW" \
    "and never claims it did"
  # With a readable body the original wording stands.
  reset
  MERGE_STATE="merged=false state=OPEN"
  run_merge
  assert_contains "$MERGE_OUTPUT" "spoke for the body as it is NOW" "a read body keeps the claim"
}

# Review round 17, P2. The no-bind path returns without reading the body, so an earlier scan's
# status is stale from there on -- including a CLEAN earlier scan, which leaves no withdrawal to
# print and so used to slip past the clearing, after which the deferred-merge note claimed a scan
# had spoken for the body as it is now.
test_a_retarget_skip_clears_a_clean_earlier_scan() {
  reset
  PR_BODY='Nothing to close here.
'
  PR_BASE=main
  BASE_LATER=release-1.2
  MERGE_STATE="merged=false state=OPEN"
  run_merge
  assert_eq "$MERGE_RC" 1 "a deferred merge is exit 1"
  assert_contains "$MERGE_OUTPUT" "scan did NOT read the body for this attempt" \
    "the skipped authoritative scan leaves no claim standing"
  assert_not_contains "$MERGE_OUTPUT" "spoke for the body as it is NOW" \
    "the lead-time scan does not speak for the landing body"
}

# ludics-lite#289: an open review thread refuses the merge, whatever head it cites and whatever the
# build gate said — PR #277's round 6 had two, written against the previous head, under a 👍.
test_an_open_review_thread_refuses_the_merge() {
  reset
  THREADS_JSON="[$(review_thread 4053098120 false),$(review_thread 4053098001 true)]"
  run_merge
  assert_eq "$MERGE_RC" 1 "an open thread refuses the merge ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "REFUSING to merge $REPO#7: 1 review thread(s) still UNRESOLVED — 4053098120 by codex[bot] on a.sh" \
    "the refusal names the open thread by the id resolve takes"
  assert_not_contains "$MERGE_OUTPUT" 4053098001 "a resolved thread is not named"
  assert_contains "$MERGE_OUTPUT" "pr-review.sh resolve $REPO#7 <id>" "and says what clears it"
  assert_no_merge_call
  # No flag bypasses it: an override is about a red build, not about an open finding.
  run_merge --override 'unrelated red on the base' --allow-no-verdict
  assert_eq "$MERGE_RC" 1 "the build overrides do not reach it"
  assert_no_merge_call
  # The control: every thread resolved, the merge lands, on ONE read of the threads.
  THREADS_JSON="[$(review_thread 4053098120 true),$(review_thread 4053098001 true)]"
  run_merge
  assert_eq "$MERGE_RC" 0 "with every thread resolved the merge lands ($MERGE_OUTPUT)"
  assert_eq "$(grep -c -x 'CALL reviewThreads' "$CALLS_FILE")" 1 "one read of the threads per merge"
}

test_a_thread_opened_between_merge_attempts_refuses_the_retry() {
  # The threads are read before EVERY attempt (review of #370, round 2): a thread opened while the
  # first attempt was refused as not mergeable moves no head, so --match-head-commit would let the
  # retry land over it.
  reset
  MERGE_NOT_MERGEABLE=1
  THREADS_JSON_LATER="[$(review_thread 4095865442 false)]"
  run_merge
  assert_eq "$MERGE_RC" 1 "the retry is refused on the thread opened since the first attempt ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "1 review thread(s) still UNRESOLVED — 4095865442" "naming it"
  assert_eq "$(grep -c -x 'CALL reviewThreads' "$CALLS_FILE")" 2 "one read per attempt"
  assert_eq "$(grep -c '^CALL pr merge' "$CALLS_FILE")" 1 "and only the first attempt was made"
  # The control: nothing opens in between, and the retry lands on its own read.
  THREADS_JSON_LATER=""
  rm -f "$TEST_ROOT/merge-failed-once"
  run_merge
  assert_eq "$MERGE_RC" 0 "the retry lands ($MERGE_OUTPUT)"
  assert_eq "$(grep -c -x 'CALL reviewThreads' "$CALLS_FILE")" 2 "one read per attempt"
}

test_an_unread_thread_connection_refuses_as_transport() {
  reset
  FAIL_GRAPHQL=1
  run_merge
  assert_eq "$MERGE_RC" 3 "a thread read that did not answer is exit 3"
  assert_contains "$MERGE_OUTPUT" "whether review threads are still open is UNKNOWN" \
    "and is not 'none are open'"
  assert_no_merge_call
}

# ludics-lite#296. This repository merges with --merge, so every commit message lands on the
# default branch, where GitHub applies its closing keywords as it does a body's. PR #274's first
# commit quoted the #210 incident sentence as an illustration, in its BODY; the scan reads each
# message with the body's own filter and names the commit and the line, on both streams.
test_a_quoted_closing_sentence_in_a_commit_body_warns() {
  reset
  SERIES_JSON="[$(commit_row c0ffee0000000001 'ship-pr: a closing keyword binds to every #N

The #210 body said "Resolves #194 and #205 §1" and closed #205 with it.'),$(commit_row head-sha 'Review fixes round 1')]"
  run_merge
  assert_eq "$MERGE_RC" 0 "a commit finding is not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING: $REPO#7's commit series closes issues" \
    "the series finding is announced"
  assert_contains "$MERGE_STDOUT" "commit c0ffee00: ONE sentence, 2 issues: #194 #205" \
    "naming the commit and every issue the sentence binds"
  assert_contains "$MERGE_STDOUT" 'The #210 body said "Resolves #194 and #205 §1" and closed #205 with it.' \
    "and the line itself"
  assert_contains "$MERGE_STDERR" "commit c0ffee00: ONE sentence, 2 issues" "on stderr as well"
  assert_contains "$MERGE_STDOUT" "reword the commit" "with the remedy a commit needs"
  assert_contains "$MERGE_STDOUT" "If the commit has already reached the default branch, reopen" \
    "and the reopen advice keyed to the default branch, not to this merge"
  assert_contains "$MERGE_CALLS" "--match-head-commit head-sha " "and the merge still lands"
  # A message is plain text GitHub reads whole: an INDENTED or `>` quotation closes as surely as a
  # statement, so it is read and reported as closing, with the remedy (review round 1).
  reset
  SERIES_JSON="[$(commit_row head-sha 'Quote the incident

    Resolves #194 and #205 §1
> Fixes #206
')]"
  run_merge
  assert_eq "$MERGE_RC" 0 "still not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING: $REPO#7's commit series closes issues" \
    "a quoted line in a message is a closing claim"
  assert_contains "$MERGE_STDOUT" "commit head-sha: a QUOTED, FENCED or INDENTED line, and it closes all the same, 2 issue(s): #194 #205" \
    "the indented copy, naming the commit and the issues"
  assert_contains "$MERGE_STDOUT" "and it closes all the same, 1 issue(s): #206" "and the > copy, even with one"
  assert_contains "$MERGE_STDOUT" "reword the commit" "with the remedy"
  assert_not_contains "$MERGE_STDOUT" "NOTICE" "never in the register that claims nothing"
}

# Review round 1. A body keyword binds only on its own merge into the default branch, so the body
# scan is silent on another base; a commit keyword binds whenever the commit REACHES the default
# branch, and a merge into a staging branch is the last cheap point to reword it -- so the series
# is scanned whatever the base.
test_the_series_is_scanned_whatever_the_base() {
  reset
  PR_BASE=release-1.2
  SERIES_JSON="[$(commit_row head-sha 'Resolves #41 and #42')]"
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge lands ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "commit head-sha: ONE sentence, 2 issues: #41 #42" \
    "a staging base does not make a commit keyword inert"
}

# Review round 3. The merge method is not read: telling a --squash that replaces the messages from
# one that lands them met gh's option table (`--merge --body --squash` is a body text), so every
# merge is scanned and a replacing --squash draws a warning -- the loud direction.
test_the_series_is_scanned_whatever_the_merge_method() {
  local form
  for form in "--merge --body --squash" "--squash --body=Squashed." "--rebase"; do
    reset
    SERIES_JSON="[$(commit_row head-sha 'Resolves #43 and #44')]"
    # shellcheck disable=SC2086 # the form is several words on purpose
    run_merge -- $form
    assert_eq "$MERGE_RC" 0 "the merge lands ($form: $MERGE_OUTPUT)"
    assert_contains "$MERGE_STDOUT" "commit head-sha: ONE sentence, 2 issues: #43 #44" "scanned under $form"
  done
}

# Review round 2. `gh pr merge` can return having only ENABLED auto-merge, which
# --match-head-commit binds at enable time only: a push before it fires lands a series nothing read.
test_a_deferred_merge_says_the_series_is_unbound() {
  reset
  MERGE_STATE="merged=false state=OPEN"
  run_merge
  assert_eq "$MERGE_RC" 1 "a deferred merge is exit 1"
  assert_contains "$MERGE_OUTPUT" "read the series up to head-sha; a push before the auto-merge fires lands messages nothing here reads" \
    "the refusal says the series scan does not bind the landing head"
  reset
  MERGE_STATE="merged=false state=OPEN"
  SERIES_FAIL=1
  run_merge
  assert_contains "$MERGE_OUTPUT" "commit-series scan did NOT read the series" "and never claims a read that failed"
}

# The legitimate shape: a commit that really closes the PR's own issue is silent, as a body's lone
# `Closes #N` is -- and the series is read once, on two calls.
test_a_commit_closing_the_pr_own_issue_is_silent() {
  reset
  SERIES_JSON="[$(commit_row c0ffee0000000002 'merge: read the series

Closes #296'),$(commit_row head-sha 'Fixes #296 for good')]"
  run_merge
  assert_eq "$MERGE_RC" 0 "the merge lands ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "CLOSING-KEYWORD" "a lone closing keyword is what was meant"
  assert_not_contains "$MERGE_OUTPUT" "did NOT run" "and the scan did run"
  assert_eq "$(grep -c -x 'CALL commits-count' "$CALLS_FILE")" 1 "one count read per merge"
  assert_eq "$(grep -c -x 'CALL commits' "$CALLS_FILE")" 1 "one series read per merge"
}

# A message is restored byte for byte from the @tsv the read asks for: a backslash is not an
# escape, and a tab does not split the row.
test_a_commit_message_is_read_as_written() {
  reset
  SERIES_JSON="[$(commit_row head-sha "$(printf 'Paths like C:\\new\\table stay;\tCloses #11 and #12')")]"
  run_merge
  assert_contains "$MERGE_STDOUT" 'ONE sentence, 2 issues: #11 #12' "the finding is read off the message"
  assert_contains "$MERGE_STDOUT" 'C:\new\table stay;' "and a backslash in it is shown as written"
}

# Review rounds 4 and 5. The series is relative to the BASE, which --match-head-commit does not
# bind, so it is read before every attempt, as the body is -- and a retry whose findings repeat the
# last ones costs no line, while one whose series lost them withdraws them.
test_the_series_is_read_before_every_merge_attempt() {
  local form
  for form in MERGE_NOT_MERGEABLE MERGE_BASE_MODIFIED; do
    reset
    printf -v "$form" 1
    SERIES_JSON="[$(commit_row head-sha 'Resolves #45 and #46')]"
    run_merge
    assert_eq "$MERGE_RC" 0 "the retry lands ($form: $MERGE_OUTPUT)"
    assert_eq "$(grep -c '^CALL pr merge' "$CALLS_FILE")" 2 "two attempts were made ($form)"
    assert_eq "$(grep -c -x 'CALL commits' "$CALLS_FILE")" 2 "one series read per attempt ($form)"
    assert_eq "$(grep -c 'ONE sentence, 2 issues: #45 #46' "$OUT_FILE")" 1 \
      "and an unchanged finding is printed once ($form)"
  done
  # A base moved between attempts changes the series without moving the head: new findings are
  # printed, and findings the series lost are withdrawn.
  reset
  MERGE_BASE_MODIFIED=1
  SERIES_JSON="[$(commit_row head-sha 'Nothing to close')]"
  SERIES_JSON_LATER="[$(commit_row base-commit 'Resolves #47 and #48'),$(commit_row head-sha 'Nothing to close')]"
  run_merge
  assert_contains "$MERGE_STDOUT" "commit base-com: ONE sentence, 2 issues: #47 #48" \
    "a commit the base move brought into the series is read before the retry"
  reset
  MERGE_BASE_MODIFIED=1
  SERIES_JSON="[$(commit_row base-commit 'Resolves #47 and #48'),$(commit_row head-sha 'Nothing to close')]"
  SERIES_JSON_LATER="[$(commit_row head-sha 'Nothing to close')]"
  run_merge
  assert_contains "$MERGE_STDOUT" "CLOSING-KEYWORD WARNING WITHDRAWN: $REPO#7's commit series, read again for this attempt" \
    "and a finding the series lost is withdrawn"
}

# The series is read AFTER the gate, for the head the merge is bound to: a PR whose head is no longer
# the gated one is a series that will not land, and the merge's head binding refuses it anyway, so
# the scan says it did not run rather than reading it (review round 2 moved the read here).
test_the_series_is_read_for_the_gated_head() {
  reset
  SERIES_JSON="[$(commit_row head-sha 'Nothing'),$(commit_row pushed-sha 'Resolves #31 and #32')]"
  run_merge
  assert_contains "$MERGE_OUTPUT" "head is now pushed-s, not head-sha, the head the build signal was read for" \
    "a series past the gated head is not scanned"
  assert_contains "$MERGE_OUTPUT" "scan did NOT run" "and says so"
  assert_not_contains "$MERGE_OUTPUT" "#31" "without reporting a series that will not land"
  assert_eq "$(grep -c -x 'CALL commits' "$CALLS_FILE")" 0 "nor reading its rows"
  # The read follows the gate: its count read comes after warn_base_drift, the gate's last word.
  reset
  run_merge
  local order
  order=$(grep -n 'warn_base_drift\|commits-count' "$CALLS_FILE" | cut -d: -f2 | tr '\n' ',')
  assert_eq "$order" "CALL warn_base_drift,CALL commits-count," "the series is read after the gate"
}

# The series is read WHOLE or not at all, and a scan that did not run says so rather than going
# quiet -- without refusing the merge, which a warning never does.
test_an_unread_or_partial_series_says_the_scan_did_not_run() {
  reset
  SERIES_COUNT=251
  run_merge
  assert_eq "$MERGE_RC" 0 "a capped series is not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "has 251 commits and the commits endpoint serves at most 250" \
    "past the endpoint's cap the scan refuses"
  assert_eq "$(grep -c -x 'CALL commits' "$CALLS_FILE")" 0 "without reading a part as the whole"
  reset
  SERIES_COUNT=3
  run_merge
  assert_eq "$MERGE_RC" 0 "a short read is not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "answered 1 row(s) ending at head-sha, while the PR states 3" \
    "a row count below the stated count is not the series"
  assert_contains "$MERGE_OUTPUT" "closing-keyword scan did NOT run" "and says the scan did not run"
  reset
  SERIES_FAIL=1
  run_merge
  assert_eq "$MERGE_RC" 0 "an unread series is not a gate ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "could not read $REPO#7's commits" "an unread series is named"
  assert_contains "$MERGE_OUTPUT" "scan did NOT run" "and is not a clean one"
}

# --- the merge command's own refusals, pinned from its fix history (ludics-lite#403) ---------------
# Each of these is a path a review round wrote into cmd_merge and no case above walked. They are
# pinned before the port so that the Python carries every one of them (the issue's "history first").

# A reason, not a token: "--override yes" would make the gate a formality one keystroke wide, so a
# one-word override is a usage error, in either spelling, and nothing is read or merged.
test_an_override_is_a_reason_in_words() {
  reset
  CHECK_ROWS="$(row red ubuntu failure)"
  run_merge --override yes
  assert_eq "$MERGE_RC" 2 "a one-word override is a usage error ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "--override takes a REASON in words, not 'yes'" "and says what it wants"
  assert_no_merge_call
  run_merge --override=yes
  assert_eq "$MERGE_RC" 2 "the = form is held to the same rule"
  run_merge "--override=$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 0 "the = form carries a reason in words ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "OVERRIDE: merging example/repo#7 over a RED build signal — $OVERRIDE_WHY" \
    "and announces it"
  # With no reason at all the shell's own parameter check refuses it (bash's `${2:?}`, status 1):
  # pinned as a refusal that names the missing reason, not by the status bash happens to use.
  run_merge --override
  [ "$MERGE_RC" -ne 0 ] || bail "an override with no reason at all must refuse ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "--override needs a reason" "naming what is missing"
  assert_no_merge_call
}

# The gate's flags are the script's, and `gh pr merge`'s go after `--`.
test_an_unknown_merge_option_is_a_usage_error() {
  reset
  run_merge --squash
  assert_eq "$MERGE_RC" 2 "a gh flag before -- is not the script's ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "merge: unknown option '--squash'" "it names the option"
  assert_contains "$MERGE_OUTPUT" "go after --" "and where it belongs"
  assert_no_merge_call
}

# No verdict is not "nothing is red" (ahrefs/ocannl#745): without --allow-no-verdict a head with a
# check still running refuses with exit 4 and names both ways forward.
test_no_verdict_refuses_without_the_flag() {
  reset
  CHECK_ROWS="$(row pending macos pending)"
  run_merge
  assert_eq "$MERGE_RC" 4 "a running check is no verdict ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "no verdict after 0 min" "the refusal says how long it waited"
  assert_contains "$MERGE_OUTPUT" "re-run with --allow-no-verdict to merge unread" "and names the flag"
  assert_no_merge_call
  run_merge --allow-no-verdict
  assert_eq "$MERGE_RC" 0 "the flag merges it unread ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "ALLOW-NO-VERDICT: merging example/repo#7 with NO build verdict on the head commit" \
    "and says so on stdout"
  assert_contains "$MERGE_STDERR" "nothing has failed, nothing has passed either" "and on stderr"
  # ...but only for a merge it makes: a close-out's refusal of the same head announces nothing.
  run_merge --allow-no-verdict --require-green
  assert_eq "$MERGE_RC" 4 "a close-out merge needs a verdict it READ ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "ALLOW-NO-VERDICT: merging" "nothing is announced as merged unread"
  assert_no_merge_call
}

# ludics-lite#728 (and #560): a build job that never gets a runner held `merge --wait` for its whole
# window (120 min, four times in one OCANNL wave). A job queued while a newer run of its workflow got
# a runner for the same labels is NEVER STARTED: without --wait the refusal is 6 at once, naming the
# commands and writing nothing; under --wait the merge recovers ONCE -- cancel, then rerun the
# failed jobs -- and when the rerun's job never starts either, the wait ends early with 6.
test_a_never_started_job_ends_the_wait_early_with_its_commands() {
  local start
  reset
  retune CHECKS_INTERVAL=1
  RUNNER_CASE=never-started
  run_merge
  assert_eq "$MERGE_RC" 6 "a never-started job is its own refusal ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "NEVER STARTED  build — run 100, attempt 1: queued" "the job is named"
  assert_contains "$MERGE_OUTPUT" "while run 130 of the same workflow got a runner for them" "with the run that got one"
  assert_contains "$MERGE_OUTPUT" "gh run cancel 100 --repo $REPO, then once it completes gh run rerun 100 --failed --repo $REPO" \
    "and the commands that recover it"
  assert_contains "$MERGE_OUTPUT" "merge reruns a run only under --wait" "saying why nothing was rerun"
  assert_not_contains "$MERGE_CALLS" "CALL run " "a merge that does not wait writes nothing"
  assert_no_merge_call
  start=$SECONDS
  run_merge --wait=600
  assert_eq "$MERGE_RC" 6 "the rerun's job never started either ($MERGE_OUTPUT)"
  assert_eq "$(grep -c '^CALL run cancel 100 --repo example/repo$' <<<"$MERGE_CALLS")" 1 "one cancel"
  assert_eq "$(grep -c '^CALL run rerun 100 --failed --repo example/repo$' <<<"$MERGE_CALLS")" 1 "then one rerun"
  assert_contains "$MERGE_OUTPUT" "run 100 got no runner again on its rerun (attempt 2)" "the second occurrence ends it"
  assert_contains "$MERGE_OUTPUT" "gh run rerun 100 --repo $REPO" "naming the full rerun for the next try"
  [ $((SECONDS - start)) -lt 120 ] || bail "the wait should end early, not at its 600 s ceiling ($((SECONDS - start)) s)"
  assert_no_merge_call
}

# The rerun that works: a job no runner took (NO RUNNER) is rerun once, the wait goes on to the
# rerun's verdict, and the merge lands. --allow-no-verdict still merges a 6 unread, as it merges a 4.
test_a_job_no_runner_took_is_rerun_once_and_merges() {
  reset
  retune CHECKS_INTERVAL=1
  RUNNER_CASE=no-runner
  RUNNER_RECOVERS=1
  run_merge --wait=600
  assert_eq "$MERGE_RC" 0 "the rerun's green merges ($MERGE_OUTPUT)"
  assert_eq "$(grep -c '^CALL run rerun 100 --failed --repo example/repo$' <<<"$MERGE_CALLS")" 1 "after one rerun"
  assert_not_contains "$MERGE_CALLS" "CALL run cancel" "a completed run needs no cancel"
  assert_contains "$MERGE_CALLS" "--match-head-commit head-sha " "bound to the gated head"
  reset
  RUNNER_CASE=no-runner
  run_merge --allow-no-verdict
  assert_eq "$MERGE_RC" 0 "the operator's merge-unread flag still merges it ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "ALLOW-NO-VERDICT:" "announced as unread"
  assert_not_contains "$MERGE_CALLS" "CALL run " "and nothing was rerun without a wait"
}

# A gate that could not read the checks is UNKNOWN, and no flag merges past it.
test_an_unread_build_signal_never_merges() {
  reset
  CHECKS_FAIL=1
  run_merge --allow-no-verdict --override "$OVERRIDE_WHY"
  assert_eq "$MERGE_RC" 3 "an unread signal is exit 3 ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "the build signal could not be READ" "and is not 'nothing is red'"
  assert_no_merge_call
}

# "Not mergeable" is GitHub's stale pre-recompute answer as often as it is a conflict, so the
# mergeable field decides (ocannl-staging#373): false is a real conflict, exit 1; an unread field
# is unknown, exit 3; and a merge that keeps failing so after three attempts is base drift.
test_not_mergeable_is_decided_by_the_mergeable_field() {
  reset
  MERGE_REFUSAL='gh: Pull request is not mergeable'
  MERGEABLE=false
  run_merge
  assert_eq "$MERGE_RC" 1 "mergeable=false after the recompute is a real conflict ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "really does not merge cleanly (mergeable=false after the recompute)" \
    "and says so"
  assert_eq "$(grep -c 'pr merge' <<<"$MERGE_CALLS")" 1 "with no retry"
  reset
  MERGE_REFUSAL='gh: Pull request is not mergeable'
  MERGEABLE=FAIL
  run_merge
  assert_eq "$MERGE_RC" 3 "an unread mergeable field is unknown ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "its mergeable field is unknown" "and is named as such"
  reset
  MERGE_REFUSAL='gh: Pull request is not mergeable'
  run_merge
  assert_eq "$MERGE_RC" 1 "a merge that keeps failing as not mergeable stops ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "keeps failing as not mergeable after 3 attempts" "naming the count"
  assert_eq "$(grep -c '^CALL pr merge' "$CALLS_FILE")" 3 "after three calls"
}

# ludics-lite#729. A conflict ends no wait in a merge: on ocannl-staging#1259 `merge --wait` found
# one only at the merge call, after 120 minutes on CI. A --wait reads the PR's mergeability FIRST
# and refuses a conflict before the gate reads anything. The base leg of each case is realistic:
# the check still running and the merge call refused as GitHub refuses a conflicting PR.
test_a_conflicting_pr_is_refused_before_the_wait() {
  local answer mergeable state
  for answer in $'false\tdirty' $'false\tblocked' $'true\tdirty'; do
    mergeable=${answer%%$'\t'*}
    state=${answer#*$'\t'}
    reset
    retune CHECKS_INTERVAL=1
    CHECK_ROWS="$(row pending ci pending)"
    CHECK_ROWS_LATER="$(row green ci success)"
    MERGE_REFUSAL='gh: Pull request is not mergeable'
    MERGEABLE=false
    MERGEABILITY=$answer
    run_merge --wait=30
    assert_eq "$MERGE_RC" 1 "a conflict ($mergeable $state) is refused ($MERGE_OUTPUT)"
    assert_contains "$MERGE_STDERR" "REFUSING to merge example/repo#7 before the wait: it CONFLICTS with its base" \
      "before the wait, saying why"
    assert_contains "$MERGE_STDERR" "(mergeable=$mergeable, mergeable_state=$state)" "naming what GitHub answered"
    assert_contains "$MERGE_STDERR" "Merge or rebase origin/main in" "with the rebase hint"
    assert_eq "$(fixture_call_total checks)" 0 "the gate read nothing"
    assert_no_merge_call
  done
  # Without --wait nothing is read early: the gate is one read and the call's refusal answers it.
  reset
  MERGE_REFUSAL='gh: Pull request is not mergeable'
  MERGEABLE=false
  MERGEABILITY=$'false\tdirty'
  run_merge
  assert_eq "$(fixture_call_total mergeability)" 0 "a merge with no wait has no preflight ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "really does not merge cleanly" "the merge call's refusal still decides"
  # A clean answer is silent, and the wait goes on to the merge.
  reset
  run_merge --wait=30
  assert_eq "$MERGE_RC" 0 "a clean PR merges ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total mergeability)" 1 "after one preflight read"
  assert_not_contains "$MERGE_OUTPUT" "mergeab" "which says nothing"
}

# GitHub computes mergeability lazily: null (or unknown) is "not computed yet", read again a
# bounded number of times and never read as clean or as conflicting. On the test clock, so the
# pauses are logged rather than waited.
test_an_uncomputed_mergeability_is_read_again_never_judged() (
  export SHIP_PR_TEST_CLOCK="$TEST_ROOT/clock"
  date +%s >"$SHIP_PR_TEST_CLOCK"
  sleep() {
    printf '%s\n' "$1" >>"$TEST_ROOT/sleeps"
    printf '%s\n' "$(($(cat "$SHIP_PR_TEST_CLOCK") + $1))" >"$SHIP_PR_TEST_CLOCK"
  }
  reset
  : >"$TEST_ROOT/sleeps"
  MERGEABILITY=$'null\tunknown'
  MERGEABILITY_LATER=$'false\tdirty'
  run_merge --wait=30
  assert_eq "$MERGE_RC" 1 "the computed conflict is refused ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total mergeability)" 2 "on the second read"
  assert_eq "$(tr '\n' ' ' <"$TEST_ROOT/sleeps")" "5 " "five seconds after the first"
  assert_no_merge_call
  # Either field still computing is not computed: mergeable=false beside unknown is read again.
  reset
  : >"$TEST_ROOT/sleeps"
  MERGEABILITY=$'false\tunknown'
  MERGEABILITY_LATER=$'true\tclean'
  run_merge --wait=30
  assert_eq "$MERGE_RC" 0 "a half-computed answer is not a conflict ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total mergeability)" 2 "it was read again"
  # Still computing after the last read: said, and the wait goes on -- not refused, not clean.
  reset
  : >"$TEST_ROOT/sleeps"
  MERGEABILITY=$'null\tunknown'
  run_merge --wait=60
  assert_eq "$MERGE_RC" 0 "an answer never computed refuses nothing ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total mergeability)" 8 "after eight reads"
  assert_eq "$(tr '\n' ' ' <"$TEST_ROOT/sleeps" | cut -c1-14)" "5 5 5 5 5 5 5 " "five seconds apart"
  assert_contains "$MERGE_STDERR" "mergeability is NOT YET COMPUTED after 8 read(s) within the wait" "it says so"
  assert_contains "$MERGE_STDERR" "not read as clean or as conflicting" "in its own terms"
  # The re-reads stay inside the command's own wait ceiling: no pause past it.
  reset
  : >"$TEST_ROOT/sleeps"
  MERGEABILITY=$'null\tunknown'
  run_merge --wait=12
  assert_eq "$MERGE_RC" 0 "a short wait still reaches the gate ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total mergeability)" 3 "after the reads its ceiling holds"
  assert_eq "$(tr '\n' ' ' <"$TEST_ROOT/sleeps")" "5 5 " "and no pause past it"
  assert_contains "$MERGE_STDERR" "NOT YET COMPUTED after 3 read(s) within the wait" "it says how many"
)

# An unread answer, or one in no shape the check knows, can only fail to refuse early: it is said,
# never read as clean, and the merge call stays the judge.
test_an_unread_mergeability_neither_refuses_nor_clears() {
  reset
  MERGEABILITY=FAIL
  run_merge --wait=30
  assert_eq "$MERGE_RC" 0 "an unread preflight blocks nothing ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "conflicts with its base is UNREAD" "it is named as unread"
  assert_contains "$MERGE_STDERR" "which is not 'no conflict'" "and not as clean"
  reset
  MERGEABILITY=$'maybe\tclean'
  run_merge --wait=30
  assert_eq "$MERGE_RC" 0 "an unknown shape blocks nothing ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "a shape this check does not know" "it is named"
  assert_contains "$MERGE_STDERR" "(mergeable=maybe, mergeable_state=clean)" "with what was read"
}

# ludics-lite#795: on ocannl-staging#1388 `merge --wait` ended with 3 on the gate's head re-read,
# its four attempts spent, with most of the wait still to go. Under a wait a head re-read that
# did not answer is one failed poll: the round is read again after a pause, and the wait ends with
# 3 only once its budget is spent, or at once on a refusal no retry changes. Without --wait there
# is no budget to ride anything out in. On the test clock, so the pauses are logged.
test_a_wait_rides_out_failed_head_rereads() (
  export SHIP_PR_TEST_CLOCK="$TEST_ROOT/clock"
  date +%s >"$SHIP_PR_TEST_CLOCK"
  sleep() {
    printf '%s\n' "$1" >>"$TEST_ROOT/sleeps"
    printf '%s\n' "$(($(cat "$SHIP_PR_TEST_CLOCK") + $1))" >"$SHIP_PR_TEST_CLOCK"
  }
  retune API_ATTEMPTS=4
  reset
  : >"$TEST_ROOT/sleeps"
  HEAD_REREAD_FAIL=24
  run_merge --wait=3600
  assert_eq "$MERGE_RC" 0 "six head re-reads that never answered end no wait ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total head-reread)" 25 "the seventh read answered, after 6 x 4 failed attempts"
  assert_contains "$MERGE_STDERR" "failed head read 6 of this wait, reading it again within the wait" \
    "each failure is said as it happens"
  assert_contains "$MERGE_STDERR" "6 head read(s) failed during this wait and were read again within it" \
    "and the final word names them"
  assert_eq "$(grep -c '^CALL pr merge' "$CALLS_FILE")" 1 "and the head was merged"
  reset
  : >"$TEST_ROOT/sleeps"
  HEAD_REREAD_FAIL=always
  run_merge --wait=600
  assert_eq "$MERGE_RC" 3 "a head that never re-reads ends the wait with 3 ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "head reads failed during this wait, and its budget is spent" \
    "once the budget is spent, naming the failures"
  assert_contains "$MERGE_STDERR" "No server is currently available" "with the failure's own line"
  [ "$(awk '{ s += $1 } END { print s + 0 }' "$TEST_ROOT/sleeps")" -ge 600 ] ||
    bail "the wait should have ended only after its 600 s ($(tr '\n' ' ' <"$TEST_ROOT/sleeps"))"
  assert_no_merge_call
  reset
  : >"$TEST_ROOT/sleeps"
  HEAD_REREAD_FAIL=refused
  run_merge --wait=600
  assert_eq "$MERGE_RC" 3 "a refused head re-read is 3 at once ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "GitHub refused the read, which no retry changes" "and says why"
  assert_eq "$(fixture_call_total head-reread)" 1 "after one read"
  assert_no_merge_call
  # The negative control: without --wait there is no budget, so the first failure is the end.
  reset
  HEAD_REREAD_FAIL=always
  run_merge
  assert_eq "$MERGE_RC" 3 "without --wait a failed head re-read is 3 at once ($MERGE_OUTPUT)"
  assert_eq "$(fixture_call_total head-reread)" 4 "after one read's attempts"
  assert_contains "$MERGE_STDERR" "with no wait left to read it again in" "and says so"
  assert_no_merge_call
)

# A base that moves during every call is retried twice and then refused, never looped on.
test_a_base_that_moves_during_every_call_stops_after_three() {
  reset
  MERGE_REFUSAL='GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)'
  run_merge
  assert_eq "$MERGE_RC" 1 "three base moves end the retries ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "base moved during each of 3 merge calls; its head is still head-sha" \
    "naming the count and the unmoved head"
  assert_eq "$(grep -c '^CALL pr merge' "$CALLS_FILE")" 3 "after three calls"
}

# An ABSENT verdict whose base moves on every read is not chased forever (ludics-lite#523).
test_an_absent_base_that_keeps_moving_stops_after_three_reads() {
  reset
  NO_CHECKS=1
  BASE_KEEPS_MOVING=1
  run_merge
  assert_eq "$MERGE_RC" 1 "a base that never holds still is refused ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "base kept moving under its ABSENT verdict (3 gate reads)" "naming the count"
  assert_no_merge_call
}

# The answer to a merge call is the API's: a 4xx is a rejection (exit 1), anything else that is not
# a gateway refusal may have landed (exit 3, pinned above), and a state read that did not answer
# after a call that returned 0 is never reported as landed or not.
test_a_rejected_merge_call_and_an_unconfirmed_state() {
  reset
  MERGE_REFUSAL='gh: Required status check "ci" is expected. (HTTP 405)'
  run_merge
  assert_eq "$MERGE_RC" 1 "a 4xx is the API's answer ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "gh pr merge was rejected: gh: Required status check" "quoting it"
  reset
  STATE_FAIL=1
  run_merge
  assert_eq "$MERGE_RC" 3 "an unconfirmed state is unknown ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "the state could not be confirmed" "and says so"
  assert_contains "$MERGE_OUTPUT" "do NOT re-merge" "with the warning that matters"
}

# A close-out merge that could not take back the auto-merge it armed leaves a later head armed to
# land ungated: exit 3, and the instruction to disable it by hand.
test_a_deferred_close_out_that_cannot_be_disarmed_is_loud() {
  reset
  MERGE_STATE="merged=false state=OPEN"
  DISABLE_AUTO_FAIL=1
  run_merge --require-green
  assert_eq "$MERGE_RC" 3 "an armed auto-merge that stays armed is exit 3 ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "auto-merge could NOT be disabled" "and says so"
  assert_contains "$MERGE_OUTPUT" "Disable it by hand" "with the instruction"
}

# The queue is GraphQL-only, and an unread answer is not "no queue".
test_an_unread_merge_queue_refuses_a_close_out() {
  reset
  MERGE_QUEUE_FAIL=1
  run_merge --require-green
  assert_eq "$MERGE_RC" 3 "an unread queue is unknown ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "could not read whether main has a merge queue" "and says so"
  assert_no_merge_call
}

# --- the build of the would-be merge commit (ludics-lite#611) -----------------------------------
# lukstafi/ocannl-staging#1142 and #1139 merged minutes apart on 2026-10-15, each on its own green
# head, their shared paths changed "all in DISJOINT hunks" -- and the merge did not compile. These
# cases run `merge` in a real clone against real branches: a bare remote whose path ends in the
# repository's owner/name (how the build finds its clone), `main` at the base's tip, and
# refs/pull/7/head at the PR's head; the fixture `gh` answers the drift's compares with the paths
# each side changed. The build runs bare (FLEET_LOCAL_BOX names no fleet box, so the slot probe
# answers no PROBE line), and its command is `sh ./api.sh`, which fails on a call to a function
# nobody defines.

# The fixture's commits, under a fixed identity.
build_git() { git -c user.name=fixture -c user.email=fixture@example.com -C "$@"; }

# A compare response for <from>...<to> in <work>, as GitHub serves one: each changed path with its
# patch (the hunks from the first `@@` on) and its counts, so the drift read splits the overlap by
# whether the two sides' hunks meet.
build_compare() { # <work> <from> <to> <behind> <ahead>
  local files
  files=$(git -C "$1" diff --numstat "$2" "$3" | while IFS=$'\t' read -r add del path; do
    jq -cn --arg f "$path" --arg p "$(git -C "$1" diff -U0 "$2" "$3" -- "$path" | sed -n '/^@@/,$p')" \
      --argjson a "$add" --argjson d "$del" '{filename: $f, patch: $p, additions: $a, deletions: $d}'
  done | jq -cs .)
  jq -cn --argjson files "$files" --argjson b "$4" --argjson a "$5" \
    '{behind_by: $b, ahead_by: $a, merge_base_commit: {sha: "merge-base"}, files: $files}'
}

# <kind>: clash = the base renames hook() on api.sh's first line while the PR calls hook on a line
# appended at its end: disjoint hunks, a clean textual merge, and a merge commit `sh ./api.sh`
# fails on, while each side alone runs clean; compatible = the same, the PR calling keep(), which
# both sides keep; notes = both sides edit notes.md alone, in disjoint hunks; split = the base
# renames hook() as in clash while the PR calls hook from a new use.sh: a clash across paths only one
# side changed, with no path changed on both sides (ludics-lite#635); config = clash, the PR
# also ADDING the merge-build config ($MERGE_BUILD_SH) that would refuse it (ludics-lite#730:
# #738's shape). Sets BUILD_CLONE,
# BUILD_HEAD and BUILD_TIP, and points the fixture's gated head, tip, compares and series at them.
build_fixture() { # <kind>
  local root="$TEST_ROOT/build-$1" work remote base
  rm -rf "${root:?}"
  mkdir -p "$root/remotes/example"
  remote="$root/remotes/example/repo.git"
  work="$root/work"
  git init -q --bare "$remote"
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git init -q "$work"
  printf '%s\n' 'hook() { :; }' '# one' '# two' '# three' '# four' 'keep() { :; }' \
    '# five' '# six' '# seven' '# eight' >"$work/api.sh"
  printf '%s\n' 'Notes' 'a' 'b' 'c' 'd' 'e' 'f' 'g' >"$work/notes.md"
  build_git "$work" add -A
  build_git "$work" commit -q -m base
  build_git "$work" push -q "$remote" HEAD:refs/heads/main
  base=$(git -C "$work" rev-parse HEAD)
  # Cloned before either side moves, so its origin/main is behind the base's tip: a fetch that
  # moved it (a configured refmap) would show in assert_clone_untouched.
  git clone -q "$remote" "$root/clone"
  BUILD_CLONE="$root/clone"
  BUILD_REFS=$(git -C "$BUILD_CLONE" for-each-ref --format='%(refname) %(objectname)')
  case "$1" in
  clash) printf 'hook\n' >>"$work/api.sh" ;;
  config)
    printf 'hook\n' >>"$work/api.sh"
    mkdir -p "$work/.github"
    printf '%s\n' "$MERGE_BUILD_SH" >"$work/.github/ship-pr-merge-build"
    build_git "$work" add .github
    ;;
  compatible) printf 'keep\n' >>"$work/api.sh" ;;
  notes) printf 'pr\n' >>"$work/notes.md" ;;
  split)
    printf '%s\n' '. ./api.sh' 'hook' >"$work/use.sh"
    build_git "$work" add use.sh
    ;;
  *) bail "build_fixture: no kind $1" ;;
  esac
  build_git "$work" commit -q -a -m 'the PR'
  build_git "$work" push -q "$remote" HEAD:refs/pull/7/head
  BUILD_HEAD=$(git -C "$work" rev-parse HEAD)
  build_git "$work" checkout -q --detach HEAD~1
  case "$1" in
  notes)
    printf '%s\n' 'Notes, renamed' 'a' 'b' 'c' 'd' 'e' 'f' 'g' >"$work/notes.md"
    ;;
  *)
    printf '%s\n' 'seam() { :; }' '# one' '# two' '# three' '# four' 'keep() { :; }' \
      '# five' '# six' '# seven' '# eight' >"$work/api.sh"
    ;;
  esac
  build_git "$work" commit -q -a -m "the base's advance"
  build_git "$work" push -q "$remote" HEAD:refs/heads/main
  BUILD_TIP=$(git -C "$work" rev-parse HEAD)
  GATED_HEAD=$BUILD_HEAD
  CURRENT_HEAD=$BUILD_HEAD
  BASE_TIP=$BUILD_TIP
  SERIES_JSON="[$(commit_row "$BUILD_HEAD" 'The PR.')]"
  COMPARE_FORWARD=$(build_compare "$work" "$base" "$BUILD_HEAD" 1 1)
  COMPARE_REVERSE=$(build_compare "$work" "$base" "$BUILD_TIP" 1 1)
  MERGE_CWD=$BUILD_CLONE
}

MERGE_BUILD_SH=$'# The fixture\'s merge build.\ncommand sh ./api.sh\ninput *.sh\ntimeout 120'

# Under Git Bash (and MSYS, Cygwin) pr-review runs on Windows' Python -- scripts/py takes the `py`
# launcher there, the same uname arms -- and a merge that needs a build is refused by design
# (exit 2, mergebuild.py's HOSTS AND CLONES boundary) before anything is built or merged. So each
# case that would build asserts that refusal there, and the build's own verdicts on POSIX hosts
# only; a case whose merge needs no build runs the same everywhere (ludics-lite#515).
case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS* | CYGWIN*) MERGE_BUILD_RUNS=0 ;;
*) MERGE_BUILD_RUNS=1 ;;
esac

# The Windows refusal of a merge that needs a build (exit 2): it names why the merge needed one and
# where to run it, builds nothing, makes no merge call and leaves the clone as it was.
assert_posix_only_refusal() { # <what> [<why>]
  local why=${2:-'1 build input(s) changed on both sides: api.sh'}
  assert_eq "$MERGE_RC" 2 "$1 is refused under Windows, the merge build being POSIX-only ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "NOT merging $REPO#7: $why, and the merge build runs on POSIX hosts only (the fleet's macOS and Linux boxes). Run this merge from one of them." \
    "the refusal names why it needed a build and where to run it"
  assert_not_contains "$MERGE_STDOUT" "merge build $REPO#7" "nothing was built"
  assert_no_merge_call
  assert_clone_untouched
}

# The caller's clone after a merge build: its working tree, its worktrees and every ref as they
# were -- its remote-tracking ones included.
assert_clone_untouched() {
  assert_eq "$(git -C "$BUILD_CLONE" status --porcelain)" "" "the clone's working tree is untouched"
  assert_eq "$(git -C "$BUILD_CLONE" worktree list --porcelain | grep -c '^worktree ')" 1 \
    "the scratch worktree is gone"
  assert_eq "$(git -C "$BUILD_CLONE" for-each-ref --format='%(refname) %(objectname)')" "$BUILD_REFS" \
    "every ref is as it was"
}

# The issue's acceptance: two greens whose hunks are textually disjoint and do not compile together.
# `merge` builds their merge commit and refuses it, with the build's output; no merge call is made.
test_a_merge_commit_that_does_not_build_is_refused() {
  reset
  build_fixture clash
  MERGE_BUILD_CONFIG=$MERGE_BUILD_SH
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  if [ "$MERGE_BUILD_RUNS" -eq 0 ]; then
    assert_posix_only_refusal "a merge commit that needs a build"
    return 0
  fi
  assert_eq "$MERGE_RC" 1 "a merge commit that does not build is refused ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" '1 path(s) changed on both sides, all in DISJOINT hunks' \
    "the incident's shape: git merges the two by construction"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: 1 build input(s) changed on both sides: api.sh" \
    "says why it builds"
  assert_contains "$MERGE_STDOUT" "bare (this box has no run-time slots)" "runs bare off the fleet"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: FAILED" "says the build failed"
  assert_contains "$MERGE_STDOUT" "  | " "and shows its output"
  assert_contains "$MERGE_STDOUT" "hook" "the output names what does not resolve"
  assert_contains "$MERGE_STDERR" "REFUSING to merge $REPO#7: ${BUILD_HEAD:0:8} merged with main at ${BUILD_TIP:0:8} does not build" \
    "the refusal names the merge it built"
  assert_not_contains "$MERGE_OUTPUT" "NOTE this PR changes" "a PR that leaves the config alone gets no note"
  assert_no_merge_call
  assert_clone_untouched
  # Each side alone runs clean: the clash is the merge's.
  git -C "$TEST_ROOT/build-clash/work" checkout -q --detach "$BUILD_HEAD"
  (cd "$TEST_ROOT/build-clash/work" && sh ./api.sh) || bail "the PR's head alone must run clean"
  git -C "$TEST_ROOT/build-clash/work" checkout -q --detach "$BUILD_TIP"
  (cd "$TEST_ROOT/build-clash/work" && sh ./api.sh) || bail "the base's tip alone must run clean"
}

# The control: the same layout, whose merge commit builds, merges -- bound to the gated head.
test_a_merge_commit_that_builds_merges() {
  reset
  build_fixture compatible
  MERGE_BUILD_CONFIG=$MERGE_BUILD_SH
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  if [ "$MERGE_BUILD_RUNS" -eq 0 ]; then
    assert_posix_only_refusal "a merge commit that would build"
    return 0
  fi
  assert_eq "$MERGE_RC" 0 "a merge commit that builds merges ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: PASSED" "says the build passed"
  assert_contains "$MERGE_CALLS" "--match-head-commit $BUILD_HEAD " "the merge is bound to the gated head"
  assert_clone_untouched
}

# The base moved, and the paths both sides changed hold no build input: the config is read, nothing
# is built, and the merge proceeds. So with no path changed on both sides (the default trigger). With
# a side that changed nothing, no trigger can hold, and the config is not even read.
test_no_build_input_on_both_sides_builds_nothing() {
  reset
  build_fixture notes
  MERGE_BUILD_CONFIG=$MERGE_BUILD_SH
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 0 "no build input on both sides merges ($MERGE_OUTPUT)"
  assert_contains "$MERGE_CALLS" "CALL merge-build-config" "the config was read"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: no build — none of the 1 path(s) changed on both sides is a build input (*.sh)" \
    "and says why nothing was built"
  assert_not_contains "$MERGE_STDOUT" "building" "nothing was built"
  assert_contains "$MERGE_CALLS" "pr merge 7" "the merge is made"
  COMPARE_REVERSE=$(jq -cn '{behind_by:1, ahead_by:0, merge_base_commit:{sha:"merge-base"}, files:[{filename:"other.sh"}]}')
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 0 "nothing changed on both sides merges ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: no build — no path changed on both sides (trigger same-input)" \
    "and says why nothing was built"
  COMPARE_REVERSE=$(jq -cn '{behind_by:1, ahead_by:0, merge_base_commit:{sha:"merge-base"}, files:[]}')
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 0 "a base whose advance changed no path merges ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_CALLS" "CALL merge-build-config" "and the config is not read"
}

# A clash across paths only ONE side changed (ludics-lite#635): the base renames hook() in api.sh,
# the PR calls hook from its new use.sh. The default trigger builds nothing and merges, as before;
# `trigger any-input` builds the merge commit, since each side changed a build input, and refuses it.
MERGE_BUILD_SPLIT=$'command for f in *.sh; do sh "$f" || exit 1; done\ninput *.sh\ntimeout 120'
test_any_input_catches_a_single_side_clash() {
  reset
  build_fixture split
  MERGE_BUILD_CONFIG=$MERGE_BUILD_SPLIT
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 0 "the default trigger merges a single-side clash unbuilt ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: no build — no path changed on both sides (trigger same-input)" \
    "and says why nothing was built"
  assert_contains "$MERGE_CALLS" "pr merge 7" "the merge is made"
  reset
  build_fixture split
  MERGE_BUILD_CONFIG=$'trigger any-input\n'"$MERGE_BUILD_SPLIT"
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  local why="build inputs changed on each side (trigger any-input): the PR's use.sh; the base's api.sh"
  if [ "$MERGE_BUILD_RUNS" -eq 0 ]; then
    assert_posix_only_refusal "a single-side clash under trigger any-input" "$why"
    return 0
  fi
  assert_eq "$MERGE_RC" 1 "trigger any-input refuses a single-side clash ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: $why" "says why it builds"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: FAILED" "says the build failed"
  assert_contains "$MERGE_STDOUT" "hook" "the output names what does not resolve"
  assert_no_merge_call
  assert_clone_untouched
}

# A repository without the config keeps today's behaviour: the clash above merges unbuilt.
test_a_repository_without_the_config_builds_nothing() {
  reset
  build_fixture clash
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 0 "no config: the merge proceeds as before ($MERGE_OUTPUT)"
  assert_contains "$MERGE_CALLS" "CALL merge-build-config" "the config was looked for"
  assert_not_contains "$MERGE_OUTPUT" "merge build" "and nothing was built"
  assert_contains "$MERGE_CALLS" "pr merge 7" "the merge is made"
}

# A config that is not one, an unread config, and a merge that runs outside a clone each refuse
# before anything is built or merged.
test_an_unusable_merge_build_never_merges() {
  reset
  build_fixture clash
  MERGE_BUILD_CONFIG=$'command sh ./api.sh\ninputs *.sh'
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 2 "a line outside the grammar refuses ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "inputs *.sh" "naming the line"
  assert_no_merge_call
  MERGE_BUILD_CONFIG=""
  MERGE_BUILD_CONFIG_FAIL=1
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 3 "an unread config is unknown ($MERGE_OUTPUT)"
  assert_no_merge_call
  MERGE_BUILD_CONFIG_FAIL=""
  MERGE_BUILD_CONFIG=$MERGE_BUILD_SH
  MERGE_CWD=$TEST_ROOT
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  if [ "$MERGE_BUILD_RUNS" -eq 0 ]; then
    # The host refusal comes before the clone is looked for.
    assert_posix_only_refusal "a merge build outside a clone"
    return 0
  fi
  assert_eq "$MERGE_RC" 2 "a merge build outside a clone refuses ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "Run merge from a clone of $REPO, or name one" \
    "and says where to run it, or how to name the clone"
  assert_contains "$MERGE_STDERR" "with -C <clone>" "naming -C"
  assert_no_merge_call
}

# merge -C <clone> (ludics-lite#730): run from a directory that is no clone, it builds in the clone -C
# names, and refuses the clash as from inside it. -C naming no checkout is exit 2 before anything
# is read.
test_merge_builds_in_the_clone_c_names() {
  reset
  build_fixture clash
  MERGE_BUILD_CONFIG=$MERGE_BUILD_SH
  MERGE_CWD=$TEST_ROOT
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge -C "$BUILD_CLONE"
  if [ "$MERGE_BUILD_RUNS" -eq 0 ]; then
    assert_posix_only_refusal "a merge build in the clone -C names"
  else
    assert_eq "$MERGE_RC" 1 "the clash is refused from outside the clone ($MERGE_OUTPUT)"
    assert_contains "$MERGE_STDOUT" "merge build $REPO#7: FAILED" "built in the clone -C names"
    assert_no_merge_call
    assert_clone_untouched
  fi
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge -C "$TEST_ROOT"
  assert_eq "$MERGE_RC" 2 "-C naming no checkout refuses ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDERR" "is not a directory inside a git checkout" "and says so"
  assert_eq "$MERGE_CALLS" "" "before anything is read"
}

# A PR that adds the merge-build config is judged by the default branch's copy, not its own
# (ludics-lite#730, #738's case): with none there, the clash merges unbuilt, and merge says which
# copy judged it. The dry run (merge-build, #751) is the control: the PR's own copy refuses the same
# pair, and the default branch's (none) builds nothing.
test_a_pr_changing_the_config_is_told_which_copy_judged_it() {
  reset
  build_fixture config
  FLEET_LOCAL_BOX=not-a-fleet-box run_merge
  assert_eq "$MERGE_RC" 0 "the default branch has no config: the merge proceeds unbuilt ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "merge build $REPO#7: NOTE this PR changes .github/ship-pr-merge-build; this merge is judged by the copy on $REPO's default branch, never the PR's own (absent there: nothing is built)" \
    "the note names the copy that judged it"
  assert_contains "$MERGE_STDOUT" "merge-build --base $BUILD_TIP --head $BUILD_HEAD --config" \
    "and the dry run that shows the PR's own copy"
  assert_contains "$MERGE_CALLS" "pr merge 7" "the merge is made"
  git -C "$BUILD_CLONE" fetch -q origin refs/pull/7/head main
  git -C "$TEST_ROOT/build-config/work" show "$BUILD_HEAD:.github/ship-pr-merge-build" >"$TEST_ROOT/pr-config"
  run_dry --base "$BUILD_TIP" --head "$BUILD_HEAD" --config "$TEST_ROOT/pr-config"
  if [ "$MERGE_BUILD_RUNS" -eq 0 ]; then
    assert_eq "$MERGE_RC" 2 "the dry run is POSIX-only too ($MERGE_OUTPUT)"
  else
    assert_eq "$MERGE_RC" 1 "the PR's own copy refuses the pair ($MERGE_OUTPUT)"
    assert_contains "$MERGE_STDOUT" "1 build input(s) changed on both sides: api.sh" "for the clash"
    assert_contains "$MERGE_STDOUT" "FAILED" "with the build's output"
  fi
  assert_not_contains "$MERGE_CALLS" "CALL" "a dry run with --config reads nothing on GitHub"
  run_dry --base "$BUILD_TIP" --head "$BUILD_HEAD"
  assert_eq "$MERGE_RC" 0 "the default branch's copy (none) builds nothing ($MERGE_OUTPUT)"
  assert_contains "$MERGE_STDOUT" "no build — $REPO's default branch has no .github/ship-pr-merge-build" "and says so"
  assert_contains "$MERGE_CALLS" "CALL merge-build-config" "the default branch's copy was read"
}

# merge-build in the fixture's clone, as run_merge runs merge.
run_dry() {
  local rc
  fixture_call_reset
  : >"$CALLS_FILE"
  set +e
  (cd "$BUILD_CLONE" || exit 99; FLEET_LOCAL_BOX=not-a-fleet-box cmd_merge_build "$@") >"$OUT_FILE" 2>"$ERR_FILE"
  rc=$?
  set -e
  MERGE_STDOUT=$(cat "$OUT_FILE")
  MERGE_STDERR=$(cat "$ERR_FILE")
  MERGE_OUTPUT=$(cat "$OUT_FILE" "$ERR_FILE")
  MERGE_RC="$rc"
  MERGE_CALLS=$(cat "$CALLS_FILE")
}

tests=(
  test_a_refused_merge_call_is_the_scripts_only_without_forwarded_flags
  test_superseded_head_never_merges
  test_merge_binds_to_the_gated_head
  test_an_unread_advisory_list_never_merges
  test_forwarded_head_binding_is_refused
  test_require_green_refuses_green_by_skips_only
  test_require_green_refuses_auto
  test_require_green_disables_a_deferred_auto_merge
  test_require_green_refuses_a_merge_queue
  test_an_absent_head_merges_and_a_close_out_refuses_it
  test_an_override_waits_for_a_check_still_running
  test_a_check_that_turns_red_during_the_wait_is_not_waived
  test_one_sentence_closing_two_issues_warns
  test_a_closing_keyword_in_a_quoted_or_fenced_line_warns
  test_the_prescribed_shape_stays_silent
  test_an_unread_body_is_not_a_clean_body
  test_a_longer_fence_is_not_closed_by_an_inner_one
  test_a_period_ends_the_unit_with_no_abbreviation_guard
  test_the_reopen_remedy_does_not_hardcode_this_repo
  test_the_body_is_scanned_again_before_the_merge
  test_an_unchanged_body_is_not_reported_twice
  test_a_repository_name_may_lead_with_punctuation
  test_a_closing_fence_takes_no_info_string
  test_a_quote_nested_in_a_list_item_is_still_quoted
  test_a_closing_quote_still_ends_the_sentence
  test_a_url_fragment_is_not_an_issue_reference
  test_the_same_issue_named_twice_is_one_issue
  test_four_space_indentation_is_not_a_quote_or_a_fence
  test_hash_zero_is_not_an_issue_reference
  test_a_schemeless_link_is_not_an_issue_reference
  test_the_local_qualified_spelling_is_the_same_issue
  test_the_body_is_rescanned_before_a_retried_merge
  test_a_base_moved_during_the_call_is_not_a_head_move
  test_an_absent_verdict_rereads_its_base_before_the_call
  test_no_warning_when_the_base_is_not_the_default_branch
  test_an_unread_default_branch_is_not_an_inert_keyword
  test_a_repository_named_like_a_keyword_is_not_a_keyword
  test_reference_case_does_not_make_a_second_issue
  test_a_tab_after_spaces_is_still_code_indentation
  test_an_invalid_backtick_opener_opens_no_fence
  test_a_retarget_during_the_gate_is_seen
  test_an_unknown_comparison_names_its_cause
  test_a_link_destination_does_not_join_two_sentences
  test_an_added_plain_closes_line_is_not_an_unchanged_body
  test_a_query_string_hash_is_not_an_issue_reference
  test_a_retarget_off_the_default_branch_withdraws_the_warning
  test_a_titled_link_does_not_join_two_sentences
  test_a_schemeless_url_containing_a_delimiter_is_stripped
  test_a_non_ascii_word_is_not_a_keyword
  test_a_reference_style_link_does_not_join_two_sentences
  test_a_reference_needs_a_boundary_after_its_digits
  test_a_query_only_schemeless_url_is_stripped
  test_an_over_long_numeric_prefix_is_not_a_list_marker
  test_the_queue_is_read_after_the_body_scan
  test_an_indented_code_line_is_not_scanned_at_all
  test_a_list_marker_does_not_swallow_code_indentation
  test_a_port_in_a_schemeless_url_is_stripped
  test_a_clean_body_edited_to_another_clean_body_is_silent
  test_an_unchanged_body_still_reports_a_lost_comparison
  test_an_indented_delimiter_leaves_the_fence_open
  test_a_quoted_finding_claims_nothing_about_closing
  test_an_unchanged_quoted_only_body_keeps_notice_wording
  test_an_identifier_containing_a_keyword_is_not_a_keyword
  test_control_bytes_in_the_body_cannot_forge_the_warning
  test_an_edited_body_with_a_quoted_only_finding_keeps_notice_wording
  test_a_dotted_token_containing_a_keyword_is_not_a_keyword
  test_references_before_the_keyword_are_not_bound
  test_a_retarget_withdrawal_keeps_the_finding_register
  test_a_mixed_unchanged_body_confirms_each_class_in_its_own_terms
  test_a_dot_underscore_token_is_not_a_keyword
  test_an_indented_delimiter_inside_a_fence_is_content
  test_a_keyword_inside_a_url_path_is_not_a_directive
  test_the_deferred_merge_note_does_not_claim_an_unread_scan
  test_a_retarget_skip_clears_a_clean_earlier_scan
  test_an_open_review_thread_refuses_the_merge
  test_an_unread_thread_connection_refuses_as_transport
  test_a_thread_opened_between_merge_attempts_refuses_the_retry
  test_a_quoted_closing_sentence_in_a_commit_body_warns
  test_a_commit_closing_the_pr_own_issue_is_silent
  test_a_commit_message_is_read_as_written
  test_the_series_is_read_before_every_merge_attempt
  test_the_series_is_read_for_the_gated_head
  test_an_unread_or_partial_series_says_the_scan_did_not_run
  test_the_series_is_scanned_whatever_the_base
  test_the_series_is_scanned_whatever_the_merge_method
  test_a_deferred_merge_says_the_series_is_unbound
  test_an_override_is_a_reason_in_words
  test_an_unknown_merge_option_is_a_usage_error
  test_no_verdict_refuses_without_the_flag
  test_a_never_started_job_ends_the_wait_early_with_its_commands
  test_a_job_no_runner_took_is_rerun_once_and_merges
  test_an_unread_build_signal_never_merges
  test_not_mergeable_is_decided_by_the_mergeable_field
  test_a_conflicting_pr_is_refused_before_the_wait
  test_an_uncomputed_mergeability_is_read_again_never_judged
  test_an_unread_mergeability_neither_refuses_nor_clears
  test_a_wait_rides_out_failed_head_rereads
  test_a_base_that_moves_during_every_call_stops_after_three
  test_an_absent_base_that_keeps_moving_stops_after_three_reads
  test_a_rejected_merge_call_and_an_unconfirmed_state
  test_a_deferred_close_out_that_cannot_be_disarmed_is_loud
  test_an_unread_merge_queue_refuses_a_close_out
  test_require_green_takes_a_waived_red
  test_a_merge_commit_that_does_not_build_is_refused
  test_a_merge_commit_that_builds_merges
  test_no_build_input_on_both_sides_builds_nothing
  test_a_repository_without_the_config_builds_nothing
  test_an_unusable_merge_build_never_merges
  test_any_input_catches_a_single_side_clash
  test_merge_builds_in_the_clone_c_names
  test_a_pr_changing_the_config_is_told_which_copy_judged_it
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
