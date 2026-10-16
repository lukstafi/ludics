#!/usr/bin/env bash
# The fixture transport the three `pr-review.sh base` suites share, and the wall-clock idiom they
# all have to get right. A suite sources it right after the preamble, and defines nothing of its
# own above either source (ludics-lite#179):
#
#   SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
#   # shellcheck source=test-pr-review-lib.sh
#   source "$SCRIPT_DIR/test-pr-review-lib.sh"
#   # shellcheck source=test-pr-review-base-lib.sh
#   source "$SCRIPT_DIR/test-pr-review-base-lib.sh"
#
# The suites over it, one subject each — `base` was one 900-line, 33-case file carrying the first
# three, where "which suite failed" said only "base":
#
#   test-pr-review-base-red.sh      the RED report: which job failed and where the red started
#                                   (ludics-lite#73, #81)
#   test-pr-review-base-settle.sh   the tip's own ABSENCE: the paths-ignore settle and the one
#                                   absence that is not a race (ludics-lite#156, #163)
#   test-pr-review-base-verdict.sh  what the WAIT LOOP decides: which break ends the wait, what
#                                   each break re-confirms, where the absence clock starts
#                                   (ludics-lite#93)
#   test-pr-review-base-pushless.sh a workflow that no longer runs on push: the tip judged by a
#                                   NAMED source or not at all (ludics-lite#401), and a push
#                                   tip whose own run is in flight: pending, or an interim
#                                   green by the same source under --interim (#308)
#
# What this file provides: the canned answers keyed the way `base` reads them (TIP, WORKFLOWS_JSON,
# RUNS_<id> and its per-round successors, JOBS_<run id>, FILES_<sha initial>, the compare and the
# workflow file), the fixture `gh` that serves them, `reset_fixture` to clear every one of them
# between cases, `run_base` to capture a command's output and status, and the wall-clock idiom
# below.
#
# Executed rather than sourced, it runs its own controls over that transport: the round counter,
# the per-round feed, the delays, the run aged at its read, and the tip move, each read directly
# off the fixture rather than through a `base` run, so they say what the transport does and not
# what the script made of it.

# Executed rather than sourced, this file sources the preamble ITSELF, before it defines anything:
# the preamble refuses a caller that defined functions above it (the shadow in the other
# direction), so its own controls could not otherwise run. Sourced by a suite that skipped the
# preamble it refuses instead, rather than sourcing it from under the suite — a suite's
# definitions belong below both files, and the preamble is the one that can say so.

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape. Sourced by a sibling suite, the `|| return 0` dispatch below ends the source
# inside the group, before the foot's `exit` is reached, so the caller survives.
{
BASE_LIB_BASENAME=$(basename "${BASH_SOURCE[0]}")
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  BASE_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  # shellcheck source=test-pr-review-lib.sh
  source "$BASE_LIB_DIR/test-pr-review-lib.sh"
elif [ -z "${LIB_BASENAME:-}" ]; then
  echo "$BASE_LIB_BASENAME: REFUSING to run: source test-pr-review-lib.sh first — it is what sources pr-review.sh and installs the shadow guard this file's fixture is checked by" >&2
  exit 2
fi

# Every variable name in scope before this file defines anything: pr-review.sh's, the preamble's
# and the environment's. `reset_fixture` clears the per-key answers by NAME PATTERN, and a pattern
# that also matches one of these is refused rather than obeyed: in PR #419 a new prefix,
# WORKFLOW_YAML_, matched pr-review.sh's own WORKFLOW_YAML_FILTER, the first reset unset it, and
# the settle suite went red for a reason with nothing to do with what it tests.
FIXTURE_NAMES_AS_SOURCED=" $(compgen -v | tr '\n' ' ') "

test_tmpdir TEST_ROOT base-fixture

REPO=example/repo
BRANCH=main
REQUEST_LOG="$TEST_ROOT/requests"
# What the fixture `gh` records as PAGINATED: a commit's files are served 300 to a default page,
# so the read that walks them has to ask for every one.
PAGINATE_LOG="$TEST_ROOT/paginated"

# Four commits, oldest last, in the order the fixtures list their runs.
SHA_C=cccccccccccccccccccccccccccccccccccccccc
SHA_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA_0=0000000000000000000000000000000000000000

# --- the fixture transport --------------------------------------------------------------------
# `base` reads the branch tip, the workflow list, then each workflow's runs SEPARATELY (a flat
# page of runs can postdate an infrequent workflow's newest run entirely), and finally — only on
# a red — that run's jobs. So the canned answers are keyed the same way: one per workflow id, one
# per run id. bash 3.2 has no associative arrays; the per-key answers are plain variables reached
# through `eval`, as the other suites' sequence pops are.
#
# The name patterns (EREs, anchored whole) of those per-key answers, which is what `reset_fixture`
# clears: RUNS_<workflow id>, RUNS_<workflow id>_FROM_<round> (set through `runs_from_round`
# below), JOBS_<run id>, RUN_<run id>, WORKFLOW_PATH_<workflow id>, YAML_OF_<file basename> and
# FILES_<sha initial>. A pattern must match only names the cases create, and `reset_fixture`
# refuses one that matches a name in FIXTURE_NAMES_AS_SOURCED.
FIXTURE_KEYS=('RUNS_[0-9]+' 'RUNS_[0-9]+_FROM_[0-9]+' 'JOBS_[0-9]+' 'RUN_[0-9]+' 'WORKFLOW_PATH_[0-9]+'
  'YAML_OF_[A-Za-z0-9_]*' 'FILES_[0-9a-z]')
TIP=""
WORKFLOWS_JSON=""
JOBS_DEFAULT=""
FAIL_ENDPOINT=""
# The HTTP status a failed read reports: a 5xx is transport, which GhSession.retry retries, while a 4xx is
# the API's answer — a 404 or a 403 on the workflow file is how Base.push_trigger meets a missing
# file and a token that may not read it (ludics-lite#401).
FAIL_STATUS=""
# The settle path's three reads (ludics-lite#156): the workflow FILE (its path, then its body at
# the tip, served raw as the library asks for it) and the compare from the judged commit to the
# tip. One body and one file list for every workflow here: the cases that care which compare was
# asked for read $REQUEST_LOG, which records the endpoint.
WORKFLOW_PATH=""
WORKFLOW_YAML=""
# The range the tip adds over the judged commit, and what each of its commits changed: the
# recognition reads the commits ONE BY ONE, because a path filter is evaluated per push and the
# cumulative diff of a range can hide a push that touched source. COMPARE_TOTAL is the compare's
# own total_commits, which a case moves on its own to stand for a range too long or a list the
# answer truncated.
# The commits the tip adds over the judged commit, oldest first, each the first parent of the next
# — the shape a linear range has. COMPARE_PARENTS overrides the first parent of each of them, for
# the cases about a merge reached through its SECOND parent; COMPARE_BEHIND makes the judged commit
# a fork rather than an ancestor, as a force-push leaves it.
COMPARE_COMMITS=""
COMPARE_PARENTS=""
COMPARE_TOTAL=""
COMPARE_BEHIND=""
FILES_DEFAULT=""
# Source (a) of a tip no push run judges (ludics-lite#401): what `commits/<sha>` says about the
# commit beyond its files (COMMIT_META, merged into that answer: its parents, its committer, its
# signature), the pull requests associated with it (TIP_PULLS), and the merged PR's head as
# `checks` reads it — the PR itself (HEAD_PR), its check runs (HEAD_CHECKS) and its workflow runs
# (HEAD_RUNS).
COMMIT_META=""
# The `.github/workflows` directory at a ref, as the Contents API lists it: what confirms that a
# workflow file answering 404 is really absent there.
WORKFLOW_DIR=""
TIP_PULLS=""
# `.github/ship-pr-advisory-checks` as the Contents API serves it raw: what `--advisory-red` reads
# for the jobs of a red run (ludics-lite#651).
ADVISORY_LIST=""
HEAD_PR=""
HEAD_CHECKS=""
HEAD_RUNS=""
# What the head's run list answers from its SECOND read on, when a case sets it: a re-run that
# started between the build signal's read and the one after it.
HEAD_RUNS_LATER=""
# The delay the wall-clock cases spend their grace with, in seconds; set through `spend_grace`
# below, which is where the idiom is written down. DELAY_LOG records each delay actually taken,
# so "once" is a fact the controls can read rather than a property of a marker file's existence.
FIRST_READ_DELAY=""
DELAY_LOG="$TEST_ROOT/delays"
# The delay after round one's runs read, in seconds, set through `delay_after_runs_read`: what puts
# wall clock between the moment a round's runs were read and everything that round checks after
# them. And the run whose created_at the feed stamps at the moment it is READ, set through
# `aged_at_read`: AGED_RUN_ID's row is served AGED_RUN_SECS seconds old, whenever and however
# slowly the read arrives.
RUNS_READ_DELAY=""
AGED_RUN_ID=""
AGED_RUN_SECS=""

# A ci workflow as the fleet's repositories write one: docs are the paths-ignore.
DOCS_IGNORED_YAML='name: ci
on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "**.md"
jobs:
  build:
    runs-on: ubuntu-latest
'

# The tip read answers TIP until the wait has run TIP_AT_ROUND rounds, and TIP_NEXT from then on:
# how a case moves the branch between the round's own tip read and everything that round does
# after it, the settle's and the breaks' re-confirms included. Set through `at_round` below. The
# round counter is the lib's `fixture_call_count rounds`: a file, not a variable, because every
# one of these reads happens inside a command substitution, where an incremented variable would
# die with the subshell (test-pr-review-lib.sh, "counting a fixture's calls"). One count per read
# of the first listed workflow's runs feed, which is one per round; `rounds_polled` below reads
# it back.
TIP_AT_ROUND=""
TIP_NEXT=""
# The workflow list the moved tip answers with, when a case sets it: from the round TIP_NEXT is
# served on, the list is WORKFLOWS_NEXT instead of WORKFLOWS_JSON -- a sibling merge that ADDED a
# workflow. `base` re-reads the list only when the tip it observes moves, so this is how a case
# pins that re-read (review round 6 of the August base --wait work). Its first workflow must be
# WORKFLOWS_JSON's, which the round counter is keyed on.
WORKFLOWS_NEXT=""
# The first listed workflow's id, cached: it is read off WORKFLOWS_JSON, which a case sets after
# reset_fixture, and every read that would compute it happens in a command substitution of its
# own. Cleared with the rest of the fixture.
FIRST_WID_CACHE="$TEST_ROOT/first-wid"

# runs_json <workflow id> <json array of run overrides>, newest first. Each row defaults to a
# completed push run of a workflow named "ci", with a distinct id and a created_at that decreases
# with the index, so the fixture reads the way the API's own newest-first page does: one minute
# apart from 2026-09-10T00:59:00Z (epoch 1789001940), as ISO dates however long the page.
runs_json() {
  jq -cn --argjson wf "$1" --argjson runs "$2" \
    '{workflow_runs: [$runs | to_entries[] | .value + {
        workflow_id: $wf,
        id: (.value.id // (1000 * $wf + .key)),
        name: (.value.name // "ci"),
        status: (.value.status // "completed"),
        head_sha: (.value.head_sha // "0000000000000000000000000000000000000000"),
        created_at: (.value.created_at // (1789001940 - 60 * .key | todate)),
        html_url: (.value.html_url //
                   ("https://example.test/runs/" + ((.value.id // (1000 * $wf + .key)) | tostring)))
      }]}'
}

workflows_json() { jq -cn --argjson wf "$1" '{workflows: $wf}'; }
jobs_json() { jq -cn --argjson jobs "$1" '{jobs: $jobs}'; }

# The canned answer for one key, empty when the case set none: `runs_of 2` reads the feed workflow
# 2 answers in the round the wait is on — RUNS_2_FROM_<k> for the latest <k> not past that round
# when a case set one, else RUNS_2 — and `jobs_of 3003` reads JOBS_3003 and falls back to
# JOBS_DEFAULT. The round is the counter's current total, which the first listed workflow's read
# has already advanced by the time any workflow's feed is served.
runs_of() {
  local k v
  k=$(rounds_polled)
  while [ "$k" -ge 2 ]; do
    eval "v=\"\${RUNS_${1}_FROM_${k}:-}\""
    if [ -n "$v" ]; then
      printf '%s' "$v"
      return 0
    fi
    k=$((k - 1))
  done
  eval "printf '%s' \"\${RUNS_${1}:-}\""
}
# run_of <run id>: RUN_<id> when a case set one, else that run's row from every workflow's feed as
# this round serves it — a run that finishes between rounds reads finished from the round whose
# feed shows it so.
run_of() {
  local v all="" wid
  eval "v=\"\${RUN_$1:-}\""
  if [ -n "$v" ]; then
    printf '%s' "$v"
    return 0
  fi
  for wid in $(compgen -v | LC_ALL=C sed -n 's/^RUNS_\([0-9][0-9]*\)\(_FROM_[0-9][0-9]*\)\{0,1\}$/\1/p' | sort -u); do
    all="$all$(runs_of "$wid")"
  done
  jq -cs --argjson id "$1" '[.[].workflow_runs[] | select(.id == $id)] | first // {}' <<<"$all"
}
jobs_of() { eval "printf '%s' \"\${JOBS_$1:-\$JOBS_DEFAULT}\""; }
# One commit's changed files: keyed by the first character of its sha, which is what tells this
# suite's commits apart (SHA_A, SHA_B, SHA_C, SHA_0 are runs of one character), falling back to
# FILES_DEFAULT for a case that gives every commit the same diff.
files_of() { eval "printf '%s' \"\${FILES_${1:0:1}:-\$FILES_DEFAULT}\""; }

# The id of the first workflow the list answers with, cached in a file: see FIRST_WID_CACHE.
first_wid() {
  [ -s "$FIRST_WID_CACHE" ] ||
    jq -r '.workflows[0].id' <<<"$WORKFLOWS_JSON" >"$FIRST_WID_CACHE"
  cat "$FIRST_WID_CACHE"
}

reset_fixture() {
  local v re keys="" taken=""
  # Every per-key answer a previous case set is cleared, or a case that names none would be served
  # the last case's answers and pass for its neighbour's reasons. The names come from `compgen -v`,
  # which lists names alone, rather than from parsing `set`, whose values can span lines.
  re="^($(
    IFS='|'
    printf '%s' "${FIXTURE_KEYS[*]}"
  ))\$"
  for v in $(compgen -v); do
    [[ $v =~ $re ]] || continue
    case "$FIXTURE_NAMES_AS_SOURCED" in
    *" $v "*) taken="$taken $v" ;;
    *) keys="$keys $v" ;;
    esac
  done
  [ -z "$taken" ] || {
    echo "$BASE_LIB_BASENAME: REFUSING to run: reset_fixture's FIXTURE_KEYS match names that were in scope before any case ran:$taken — those are pr-review.sh's, the preamble's or the environment's, not answers a case set, and unsetting them would break the script under test (PR #419: WORKFLOW_YAML_ matched WORKFLOW_YAML_FILTER); narrow the pattern or rename the fixture key" >&2
    exit 2
  }
  for v in $keys; do unset "$v"; done
  TIP="$SHA_C"
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"}]')
  RUNS_1=$(runs_json 1 '[]')
  JOBS_DEFAULT=$(jobs_json '[]')
  FAIL_ENDPOINT=""
  FAIL_STATUS=500
  WORKFLOW_PATH=".github/workflows/ci.yml"
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  COMPARE_COMMITS=$(jq -cn --arg c "$SHA_C" '[$c]')
  COMPARE_PARENTS=""
  COMPARE_TOTAL=""
  COMPARE_BEHIND=""
  FILES_DEFAULT='[]'
  COMMIT_META='{}'
  WORKFLOW_DIR='[{"type":"file","path":".github/workflows/ci.yml"}]'
  TIP_PULLS='[]'
  ADVISORY_LIST=""
  HEAD_PR='{}'
  HEAD_CHECKS='{"check_runs":[]}'
  HEAD_RUNS='{"workflow_runs":[]}'
  HEAD_RUNS_LATER=""
  fixture_call_reset headruns
  FIRST_READ_DELAY=""
  RUNS_READ_DELAY=""
  AGED_RUN_ID=""
  AGED_RUN_SECS=""
  : >"$DELAY_LOG"
  : >"$PAGINATE_LOG"
  TIP_AT_ROUND=""
  TIP_NEXT=""
  WORKFLOWS_NEXT=""
  fixture_call_reset rounds
  rm -f "$FIRST_WID_CACHE"
  # The wait loop's clocks, for the one case that takes more than a single round.
  retune ABSENT_GRACE=300 CHECKS_INTERVAL=1 CHECKS_HEARTBEAT=600
  : >"$REQUEST_LOG"
}

gh() {
  local response="" rid wid sha base head reads round=""
  # The delay, once — on the FIRST read of the run, which is the round's tip read.
  if [ -n "$FIRST_READ_DELAY" ] && ! grep -qx 'first read' "$DELAY_LOG"; then
    printf 'first read\n' >>"$DELAY_LOG"
    sleep "$FIRST_READ_DELAY"
  fi
  gh_fixture_parse "$@"
  if [ -n "$FAIL_ENDPOINT" ]; then
    # A GLOB, deliberately unquoted, so a case can fail the jobs read alone: it is the read whose
    # failure must not touch the verdict, and a pattern that also failed the runs read would
    # prove that from the wrong end.
    # shellcheck disable=SC2254
    case "$FIXTURE_ENDPOINT" in
    $FAIL_ENDPOINT)
      echo "gh: $FIXTURE_ENDPOINT unavailable (HTTP $FAIL_STATUS)" >&2
      return 1
      ;;
    esac
  fi
  case "$FIXTURE_ENDPOINT" in
  "repos/$REPO/commits/$BRANCH")
    if [ -n "$TIP_AT_ROUND" ] && [ "$(rounds_polled)" -ge "$TIP_AT_ROUND" ]; then
      response=$(jq -cn --arg sha "$TIP_NEXT" '{sha: $sha}')
    else
      response=$(jq -cn --arg sha "$TIP" '{sha: $sha}')
    fi
    ;;
  # The repository itself, for the default branch a `base` with no branch named reads: this
  # fixture's branch.
  "repos/$REPO") response=$(jq -cn --arg b "$BRANCH" '{default_branch: $b}') ;;
  "repos/$REPO/actions/workflows?per_page=100")
    response="$WORKFLOWS_JSON"
    if [ -n "$WORKFLOWS_NEXT" ] && [ -n "$TIP_AT_ROUND" ] && [ "$(rounds_polled)" -ge "$TIP_AT_ROUND" ]; then
      response="$WORKFLOWS_NEXT"
    fi
    ;;
  "repos/$REPO/actions/workflows/"*"/runs?branch=$BRANCH&event=push&per_page=10")
    wid=${FIXTURE_ENDPOINT#*/actions/workflows/}
    wid=${wid%%/*}
    # The round counter: `base` reads every listed non-advisory workflow's runs feed once per
    # round, so the FIRST listed workflow's read is one per round and nothing else here is.
    # (A fixture whose first workflow is advisory would never be read, and would count no
    # rounds — no case lists one, and `is_advisory` is pr-review.sh's own test for it.)
    # `|| return 1`: the fixture function runs without errexit in the bridge's fresh bash, so a
    # count that bails must be turned into a failed read by hand.
    if [ "$wid" = "$(first_wid)" ]; then
      round=$(fixture_call_count rounds) || return 1
    fi
    response=$(runs_of "$wid")
    [ -n "$response" ] || response=$(runs_json "$wid" '[]')
    # One page, as the API serves `per_page=10`: a case with more rows has the older ones only in
    # the hundred-deep read below (the interim's, and the fold's behind a page that judged nothing).
    response=$(jq -c '.workflow_runs |= .[:10]' <<<"$response") || return 1
    if [ -n "$AGED_RUN_ID" ]; then
      # Stamped HERE, at the read: the row is AGED_RUN_SECS old on the API's clock when it is
      # served, however late the read came (`aged_at_read`).
      response=$(jq -c --argjson id "$AGED_RUN_ID" --argjson s "$AGED_RUN_SECS" \
        '.workflow_runs |= map(if .id == $id then .created_at = ((now | floor) - $s | todate) else . end)' \
        <<<"$response") || return 1
    fi
    # The delay after the runs read, once: on round one's, which the counter reaches exactly once.
    if [ -n "$RUNS_READ_DELAY" ] && [ "$round" = 1 ]; then
      printf 'runs read\n' >>"$DELAY_LOG"
      sleep "$RUNS_READ_DELAY"
    fi
    ;;
  # A workflow's push runs a hundred deep, as the interim's deeper read asks and as the fold asks
  # behind a page of ten that judged nothing (ludics-lite#535): the case's rows up to the
  # hundredth, as the API serves `per_page=100`, so a case can set a row past the bound.
  "repos/$REPO/actions/workflows/"*"/runs?branch=$BRANCH&event=push&per_page=100")
    wid=${FIXTURE_ENDPOINT#*/actions/workflows/}
    wid=${wid%%/*}
    response=$(runs_of "$wid")
    [ -n "$response" ] || response=$(runs_json "$wid" '[]')
    response=$(jq -c '.workflow_runs |= .[:100]' <<<"$response") || return 1
    ;;
  "repos/$REPO/actions/runs/"*"/jobs?per_page=100")
    rid=${FIXTURE_ENDPOINT#*/actions/runs/}
    rid=${rid%%/*}
    response=$(jobs_of "$rid")
    ;;
  # One run by its id, as the interim's re-read after its source asks for it (ludics-lite#308):
  # RUN_<id> when a case sets it (a run that finished meanwhile), else that run's row as the
  # workflow's runs feed serves it.
  "repos/$REPO/actions/runs/"[0-9]*)
    rid=${FIXTURE_ENDPOINT#*/actions/runs/}
    response=$(run_of "$rid")
    ;;
  # The workflow's own file: where it lives, then what it says at the tip. The body is served
  # verbatim — the library asks for the raw media type rather than the base64 JSON, whose decoder
  # is spelled differently on this fleet's two platforms.
  "repos/$REPO/actions/workflows/"*)
    wid=${FIXTURE_ENDPOINT#*/actions/workflows/}
    wid=${wid%%[!0-9]*}
    response=""
    [ -z "$wid" ] || eval "response=\"\${WORKFLOW_PATH_$wid:-}\""
    response=$(jq -cn --arg p "${response:-$WORKFLOW_PATH}" '{path: $p}')
    ;;
  "repos/$REPO/contents/.github/workflows?ref="*) response="$WORKFLOW_DIR" ;;
  # A workflow of its own file, when a case names one: WORKFLOW_PATH_<id> for where the list says
  # it lives, and YAML_OF_<basename> for what it says there. Every other workflow shares
  # WORKFLOW_PATH and WORKFLOW_YAML.
  "repos/$REPO/contents/.github/workflows/"*)
    base=${FIXTURE_ENDPOINT#*/contents/.github/workflows/}
    base=${base%%\?*}
    base=${base%.y*ml}
    case "$base" in *[!A-Za-z0-9_]*) base="" ;; esac
    response=""
    [ -z "$base" ] || eval "response=\"\${YAML_OF_$base:-}\""
    [ -n "$response" ] || response="$WORKFLOW_YAML"
    ;;
  # The repository's advisory list, which only `--advisory-red` reads (ludics-lite#651), raw.
  "repos/$REPO/contents/.github/ship-pr-advisory-checks") response="$ADVISORY_LIST" ;;
  "repos/$REPO/contents/"*) response="$WORKFLOW_YAML" ;;
  "repos/$REPO/compare/"*)
    # Oldest first, so each commit's first parent is the one before it and the first commit's is
    # the compare's base — the judged commit, which the endpoint names in the path. A list that
    # holds the endpoint's HEAD ends there, as the API's answer does: a case whose tip moves names
    # both tips in one chain, and each round's compare reaches its own (#375).
    base=${FIXTURE_ENDPOINT#*/compare/}
    head=${base#*...}
    head=${head%%\?*}
    base=${base%%...*}
    response=$(jq -cn --argjson c "$COMPARE_COMMITS" --arg t "$COMPARE_TOTAL" --arg h "$head" \
      --arg b "$base" --arg behind "$COMPARE_BEHIND" --argjson p "${COMPARE_PARENTS:-null}" \
      '($c | index($h)) as $at | (if $at == null then $c else $c[0:$at + 1] end) as $c |
       {total_commits: (if $t == "" then ($c | length) else ($t | tonumber) end),
        behind_by: (if $behind == "" then 0 else ($behind | tonumber) end),
        commits: [$c | to_entries[] |
          {sha: .value,
           parents: [{sha: (if $p != null then $p[.key]
                            else (if .key == 0 then $b else $c[.key - 1] end) end)}]}]}')
    ;;
  "repos/$REPO/commits/"*"/pulls?per_page=100") response="$TIP_PULLS" ;;
  "repos/$REPO/commits/"*"/check-runs?"*) response="$HEAD_CHECKS" ;;
  "repos/$REPO/pulls/"*) response="$HEAD_PR" ;;
  "repos/$REPO/actions/runs?head_sha="*)
    response="$HEAD_RUNS"
    if [ -n "$HEAD_RUNS_LATER" ]; then
      # `|| return 1`, as the round counter's: this runs in a substitution without errexit.
      reads=$(fixture_call_count headruns) || return 1
      [ "$reads" -le 1 ] || response="$HEAD_RUNS_LATER"
    fi
    ;;
  "repos/$REPO/commits/"*)
    sha=${FIXTURE_ENDPOINT#*/commits/}
    sha=${sha%%\?*}
    response=$(jq -cn --argjson f "$(files_of "$sha")" --argjson m "$COMMIT_META" '$m + {files: $f}')
    ;;
  *) bail "unexpected fixture endpoint: $FIXTURE_ENDPOINT" ;;
  esac
  gh_fixture_answer "$response"
}

run_base() {
  local capture rc
  set +e
  capture=$(cmd_base "$BRANCH" "$@" 2>&1)
  rc=$?
  set -e
  BASE_OUTPUT="$capture"
  BASE_RC="$rc"
}

# A window filled to its end with failures: <n> rows, each red, oldest at SHA_0.
all_red_runs() {
  jq -cn --argjson n "$1" '[range($n) | {conclusion: "failure"}]'
}

# --- the wall-clock idiom (ludics-lite#169, #179, #375) ----------------------------------------
# Some cases here depend on SECONDS: a retuned grace, a `--wait` ceiling, and a delay inside the
# fixture. They are the only cases in this repository whose fixture and whose subject are both on
# the clock, and they went red on a loaded machine twice, then on the Git Bash runner, before
# settling into one shape. It is three rules, and each of them is a thing that failed (a fourth,
# below them, keeps a case that needs an AGE off the clock altogether):
#
#   Put the clock in an explicit DELAY. The grace is spent by `spend_grace <seconds>`, which
#   holds up the round's FIRST read by that much, and never by "however long N rounds take".
#   `CHECKS_INTERVAL=1` makes a round about a second on an idle box and rather more on a busy
#   one, so a case counting rounds against a grace is a case that passes when the box is quiet.
#
#   Put the fixture's EVENTS on ROUNDS, counted. `at_round <n> <sha>` moves the branch and
#   `runs_from_round <n> <id> <runs>` changes a workflow's runs, both on the runs-feed read count,
#   which is one per round by construction. A tip that moved "five rounds in" was once counted in
#   tip READS, of which a round takes one or two, and under load four rounds happened where five
#   were counted on (#169, round 2).
#
#   END a wait that has to reach a round on an EVENT, never on its ceiling. A round on the Git
#   Bash runner — a fixture and several jq.exe spawns — outran the two seconds `--wait=2` was
#   counted on to hold two of them, and a six-second ceiling sized to land after round one landed
#   inside it (#375). So a case that needs round <n> makes round <n> end the wait: a run that
#   completes from then on, a tip that moves, a grace that runs out. Its ceiling is
#   `--wait=$EVENT_CEILING`, a safety net that only a broken case reaches, and its claim about how
#   far the wait got is `rounds_polled`. A case whose ceiling IS its subject (the headline a wait
#   prints when it runs out) asserts only what holds however few rounds fit under it.
#
#   Stamp an AGE at the READ. A case that needs a run of a given age when `base` reads it —
#   just inside a window, just past it — has it stamped by the fixture as it serves the feed
#   (`aged_at_read`), never computed from the case's own clock before `run_base`: the gap between
#   the two is load, and a one-second margin spent by it reads the run on the wrong side. Stamped
#   at the read, an age the script measures at its own snapshot (taken before the read) can only
#   come out at or under the stamp, and one measured after a `delay_after_runs_read` of <d>
#   seconds at or over the stamp plus <d> — whatever the box's load.

# The ceiling of a case that ends its wait on an event: an order of magnitude past the longest
# such case's rounds on the slowest runner, so reaching it says the case is broken, not slow.
EVENT_CEILING=60

# spend_grace <seconds>: hold up the fixture's FIRST read by <seconds>, once. An API round takes
# time, and the grace is measured from when the tip was first READ, so a case that needs the grace
# to expire inside the wait spends it here rather than waiting rounds out. Once, because every
# read is a command substitution where a cleared variable would not survive — so the count of
# delays taken is kept in a file, which is also what the control below reads.
spend_grace() {
  case "$1" in '' | *[!0-9]*) bail "spend_grace: seconds, got '$1'" ;; esac
  FIRST_READ_DELAY="$1"
}

# delays_taken: how many times the fixture has held up a read. One, for every case that asks.
delays_taken() { wc -l <"$DELAY_LOG" | tr -d ' '; }

# rounds_polled: how many rounds the wait loop has run, counted as the reads of the FIRST listed
# workflow's runs feed — one per round by construction, since `base` reads every listed
# non-advisory workflow's runs exactly once per round. Counting the runs feed as a whole would
# multiply by the number of workflows a case lists; counting tip reads would add the re-confirm
# read that only some breaks perform.
rounds_polled() { fixture_call_total rounds; }

# at_round <n> <sha>: from the <n>th round on, the branch tip answers <sha>. The move lands
# between that round's own tip read and everything the round does after it — which is where a
# push during the round lands, and so is what every re-confirm in these suites is pinned against.
at_round() {
  [ $# -eq 2 ] || bail "at_round: no sha — \`at_round <n> <sha>\`"
  case "$1" in '' | *[!0-9]* | 0) bail "at_round: a round number from 1, got '$1'" ;; esac
  TIP_AT_ROUND="$1"
  TIP_NEXT="$2"
}

# runs_from_round <k> <workflow id> <runs as runs_json's overrides>: from the <k>th round on,
# that workflow's runs feed answers these runs, until a later round set the same way takes over.
# Rounds before the first <k> read RUNS_<id>, so <k> starts at 2. This is how a run FINISHES
# between rounds, or a moved tip's own run appears — a feed that can change between rounds is
# what the interim's re-round needs to be pinned by its outcome (ludics-lite#426), not only by
# how many rounds it took. The rounds are the counter's, so a feed changes on the read that opens
# its round, and the tip read before it still belongs to that round.
runs_from_round() {
  [ $# -eq 3 ] || bail "runs_from_round: \`runs_from_round <round> <workflow id> <runs>\`, got $# argument(s)"
  case "$1" in '' | *[!0-9]* | 0 | 1 | 0*) bail "runs_from_round: a round number from 2 (round one is RUNS_<id>), got '$1'" ;; esac
  case "$2" in '' | *[!0-9]*) bail "runs_from_round: a workflow id, got '$2'" ;; esac
  printf -v "RUNS_${2}_FROM_${1}" '%s' "$(runs_json "$2" "$3")"
}

# delay_after_runs_read <seconds>: hold up the fixture's answer to round one's runs read by
# <seconds>, once — wall clock between the moment the round's runs were read and everything the
# round does after them (the interim's source, its re-read, its newcomer hold). What it pins is
# WHICH clock a check reads: one taken before the reads cannot see the delay, one taken after can.
delay_after_runs_read() {
  case "$1" in '' | *[!0-9]* | 0) bail "delay_after_runs_read: whole seconds from 1, got '$1'" ;; esac
  RUNS_READ_DELAY="$1"
}

# aged_at_read <run id> <seconds>: the feed serves that run created <seconds> before the moment
# it is read, on whatever round reads it. See "Stamp an AGE at the READ" above.
aged_at_read() {
  [ $# -eq 2 ] || bail "aged_at_read: \`aged_at_read <run id> <seconds>\`, got $# argument(s)"
  case "$1" in '' | *[!0-9]*) bail "aged_at_read: a run id, got '$1'" ;; esac
  case "$2" in '' | *[!0-9]*) bail "aged_at_read: whole seconds, got '$2'" ;; esac
  AGED_RUN_ID="$1"
  AGED_RUN_SECS="$2"
}

# Everything above is in scope in all three suites, exactly as pr-review.sh's functions are, so it
# is protected exactly as they are: the preamble's snapshot was taken before this file existed, and
# `protect_library` extends it over what this file defines (review of ludics-lite#212, round 1).
# `${BASH_SOURCE[0]}` verbatim, because that is the path `declare -F` recorded.
protect_library "${BASH_SOURCE[0]}"

# --- executed: this file's own controls --------------------------------------------------------
# What is controlled here is the TRANSPORT, read directly — a `gh` call at a time, with no `base`
# run around it. The wall-clock devices above are the whole reason: a control that drove
# them through `cmd_base` would be on the clock itself, which is the property that made the cases
# they exist for flaky in the first place.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

# The fixture, called the way `base` calls it: one endpoint, answered.
fixture_gh() { local ep="$1"; shift; gh api "repos/$REPO/$ep" "$@"; }
tip_read() { fixture_gh "commits/$BRANCH" --jq .sha; }
runs_read() { fixture_gh "actions/workflows/$1/runs?branch=$BRANCH&event=push&per_page=10" >/dev/null; }
# runs_feed <workflow id>: one runs read, answered as `<id>:<conclusion>` per row, newest first.
runs_feed() {
  fixture_gh "actions/workflows/$1/runs?branch=$BRANCH&event=push&per_page=10" \
    --jq '[.workflow_runs[] | "\(.id):\(.conclusion)"] | join(" ")'
}

# One read of the first listed workflow's runs feed is one round; nothing else is. A second
# workflow is listed here because counting the runs feed as a whole — the obvious reading — would
# count two, and a wait's rounds would then be double what a case asked for.
test_the_round_counter_counts_rounds_and_not_reads() {
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"fixtures"}]')
  assert_eq "$(rounds_polled)" 0 "no round has been polled yet"
  tip_read >/dev/null
  assert_eq "$(rounds_polled)" 0 "a tip read is not a round: some breaks read it twice"
  runs_read 1
  runs_read 2
  assert_eq "$(rounds_polled)" 1 "a round is a round however many workflows it reads"
  tip_read >/dev/null
  runs_read 1
  runs_read 2
  assert_eq "$(rounds_polled)" 2 "and the next round is the next count"
  reset_fixture
  assert_eq "$(rounds_polled)" 0 "the counter is cleared with the rest of the fixture"
}

# The delay is the first READ's, and it happens once: a delay per read would multiply by the
# number of reads a round makes, which is the count nobody can hold still.
test_the_grace_is_spent_once_on_the_first_read() {
  local started elapsed
  reset_fixture
  spend_grace 1
  assert_eq "$(delays_taken)" 0 "nothing is delayed before the first read"
  started=$(date +%s)
  tip_read >/dev/null
  elapsed=$(($(date +%s) - started))
  assert_eq "$(delays_taken)" 1 "the first read is held up"
  [ "$elapsed" -ge 1 ] || bail "the delay should be real wall clock (took ${elapsed}s)"
  runs_read 1
  tip_read >/dev/null
  assert_eq "$(delays_taken)" 1 "and no read after it is"
  reset_fixture
  assert_eq "$(delays_taken)" 0 "the delay count is cleared with the rest of the fixture"
}

# Where the move lands: after the round's own tip read, before everything that round does next.
# That window is where a push during a round lands, and it is what every re-confirm in these
# suites is pinned against — the re-confirm must see the successor, not the tip its round opened
# with.
test_at_round_moves_the_tip_inside_the_round_it_names() {
  reset_fixture
  at_round 1 "$SHA_B"
  assert_eq "$(tip_read)" "$SHA_C" "round one opens on the tip it was given"
  runs_read 1
  assert_eq "$(tip_read)" "$SHA_B" "and the re-confirm after that round's reads sees the successor"

  reset_fixture
  at_round 2 "$SHA_B"
  assert_eq "$(tip_read)" "$SHA_C" "a later round's move leaves round one alone"
  runs_read 1
  assert_eq "$(tip_read)" "$SHA_C" "including its re-confirm"
  runs_read 1
  assert_eq "$(tip_read)" "$SHA_B" "and lands inside the round it names"

  reset_fixture
  assert_eq "$(tip_read)" "$SHA_C" "a move is cleared with the rest of the fixture"
}

# The moved tip's workflow list is served from the round the tip moves on, and only when a case
# sets one: read the way `base` reads it, before the round's runs, the list of round two is the
# successor's.
test_the_workflow_list_follows_the_moved_tip() {
  local q='[.workflows[].name] | join(" ")'
  reset_fixture
  at_round 1 "$SHA_B"
  WORKFLOWS_NEXT=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"lint"}]')
  assert_eq "$(fixture_gh "actions/workflows?per_page=100" --jq "$q")" "ci" "round one lists what the tip had"
  runs_read 1
  assert_eq "$(fixture_gh "actions/workflows?per_page=100" --jq "$q")" "ci lint" \
    "the next read, after round one's runs, lists the successor's"
  reset_fixture
  at_round 1 "$SHA_B"
  runs_read 1
  assert_eq "$(fixture_gh "actions/workflows?per_page=100" --jq "$q")" "ci" \
    "a moved tip with no list of its own keeps the list"
}

# A feed set from a round on answers from that round's read on — the read that OPENS the round,
# so its tip read still belongs to it — and keeps answering until a later one takes over. A second
# workflow's feed follows the same round, the per-id read serves the run as the round's feed has
# it, and every one of them is cleared with the rest of the fixture.
test_a_runs_feed_changes_on_the_round_it_names() {
  reset_fixture
  WORKFLOWS_JSON=$(workflows_json '[{"id":1,"name":"ci"},{"id":2,"name":"fixtures"}]')
  RUNS_1=$(runs_json 1 '[{"id":7,"status":"in_progress","conclusion":null}]')
  RUNS_2=$(runs_json 2 '[{"id":8,"conclusion":"success"}]')
  runs_from_round 2 1 '[{"id":7,"conclusion":"failure"}]'
  runs_from_round 2 2 '[{"id":9,"conclusion":"success"},{"id":8,"conclusion":"success"}]'
  runs_from_round 4 1 '[{"id":10,"conclusion":"success"},{"id":7,"conclusion":"failure"}]'
  assert_eq "$(runs_feed 1)" "7:null" "round one reads RUNS_1"
  assert_eq "$(runs_feed 2)" "8:success" "and so does the second workflow's read in it"
  assert_eq "$(fixture_gh actions/runs/7 --jq .status)" in_progress "the run reads as round one has it"
  assert_eq "$(runs_feed 1)" "7:failure" "round two's read opens round two, and answers its feed"
  assert_eq "$(runs_feed 2)" "9:success 8:success" "the second workflow follows the same round"
  assert_eq "$(fixture_gh actions/runs/7 --jq .conclusion)" failure "and the run reads finished"
  assert_eq "$(runs_feed 1)" "7:failure" "round three keeps the latest feed not past it"
  assert_eq "$(runs_feed 1)" "10:success 7:failure" "until a later round's takes over"
  assert_eq "$(rounds_polled)" 4 "one round per first-workflow read, as ever"
  reset_fixture
  assert_eq "$(runs_feed 1)" "" "a per-round feed is cleared with the rest of the fixture"
  runs_read 1
  assert_eq "$(runs_feed 1)" "" "on every round"
}

# A compare ends at the head it names, as the API's does, so one chain serves a case whose tip
# moves: each round's walk reaches its own tip. A head the list does not hold gets the whole list,
# which is how a case says the range never reaches the tip.
test_a_compare_ends_at_its_head() {
  local q='[.total_commits, (.commits[] | .sha[0:1] + "<" + .parents[0].sha[0:1])] | join(" ")'
  reset_fixture
  COMPARE_COMMITS=$(jq -cn --arg b "$SHA_B" --arg c "$SHA_C" '[$c, $b]')
  assert_eq "$(fixture_gh "compare/$SHA_A...$SHA_C?per_page=20" --jq "$q")" "1 c<a" \
    "the range to the first tip stops there"
  assert_eq "$(fixture_gh "compare/$SHA_A...$SHA_B?per_page=20" --jq "$q")" "2 c<a b<c" \
    "and the successor's runs through it"
  assert_eq "$(fixture_gh "compare/$SHA_A...$SHA_0?per_page=20" --jq "$q")" "2 c<a b<c" \
    "a head outside the list gets all of it"
}

# The delay after the runs read is round one's, and it happens once, AFTER that read is answered
# rather than before the round's tip read: a clock taken before the runs cannot see it.
test_the_runs_read_delay_is_round_ones_and_once() {
  local started elapsed
  reset_fixture
  delay_after_runs_read 1
  started=$(date +%s)
  tip_read >/dev/null
  elapsed=$(($(date +%s) - started))
  assert_eq "$(delays_taken)" 0 "the tip read is not held up ($elapsed s)"
  started=$(date +%s)
  runs_read 1
  elapsed=$(($(date +%s) - started))
  assert_eq "$(delays_taken)" 1 "round one's runs read is"
  [ "$elapsed" -ge 1 ] || bail "the delay should be real wall clock (took ${elapsed}s)"
  tip_read >/dev/null
  runs_read 1
  assert_eq "$(delays_taken)" 1 "and round two's is not"
  # The first-read delay and this one are told apart: setting both takes each once.
  reset_fixture
  spend_grace 1
  delay_after_runs_read 1
  runs_read 1
  tip_read >/dev/null
  assert_eq "$(sort "$DELAY_LOG" | tr '\n' ,)" "first read,runs read," "each delay is taken once, on its own read"
}

# The aged run is stamped when the feed is READ, not when the case set it: a first-read delay
# between the two shows which, since a stamp taken at the setter would come out a second older.
test_an_aged_run_is_stamped_at_the_read() {
  local before after created
  reset_fixture
  RUNS_1=$(runs_json 1 '[{"id":7,"status":"in_progress","conclusion":null},{"id":6}]')
  aged_at_read 7 100
  spend_grace 1
  tip_read >/dev/null
  before=$(date +%s)
  created=$(fixture_gh "actions/workflows/1/runs?branch=$BRANCH&event=push&per_page=10" \
    --jq '.workflow_runs[] | select(.id == 7) | .created_at | fromdateiso8601')
  after=$(date +%s)
  [ "$created" -ge $((before - 100)) ] && [ "$created" -le $((after - 100)) ] ||
    bail "run 7 should be served 100s old at the read: created $created, read between $before and $after"
  assert_eq "$(fixture_gh "actions/workflows/1/runs?branch=$BRANCH&event=push&per_page=10" \
    --jq '.workflow_runs[1].created_at')" "2026-09-10T00:58:00Z" "and only that run is restamped"
  reset_fixture
  RUNS_1=$(runs_json 1 '[{"id":7,"status":"in_progress","conclusion":null}]')
  assert_eq "$(fixture_gh "actions/workflows/1/runs?branch=$BRANCH&event=push&per_page=10" \
    --jq '.workflow_runs[0].created_at')" "2026-09-10T00:59:00Z" \
    "the stamp is cleared with the rest of the fixture"
}

# A row's default created_at is one minute older than the row above it, from 2026-09-10T00:59:00Z,
# as an ISO date the API would serve, however long the page: past sixty rows the minute used to go
# negative (`00:-1:00Z`), and from the fiftieth it lost its leading zero (`00:9:00Z`), which sorts
# as NEWER than `00:59:00Z` byte for byte -- and `base` orders a feed by created_at as bytes.
test_runs_json_dates_are_a_minute_apart_past_sixty_rows() {
  local rows
  rows=$(runs_json 1 "$(jq -cn '[range(120) | {}]')")
  assert_eq "$(jq -r '.workflow_runs[0].created_at' <<<"$rows")" "2026-09-10T00:59:00Z" "row 0 is today's"
  assert_eq "$(jq -r '.workflow_runs[49].created_at' <<<"$rows")" "2026-09-10T00:10:00Z" "row 49 is today's"
  assert_eq "$(jq -r '.workflow_runs[59].created_at' <<<"$rows")" "2026-09-10T00:00:00Z" \
    "row 59 is today's instant, with its leading zero"
  assert_eq "$(jq -r '.workflow_runs[60].created_at' <<<"$rows")" "2026-09-09T23:59:00Z" \
    "row 60 is the minute before, on the day before"
  assert_eq "$(jq -r '[.workflow_runs[].created_at | fromdateiso8601] | . == (sort | reverse) and (unique | length) == 120' <<<"$rows")" \
    true "every row parses, a minute apart, newest first"
  assert_eq "$(jq -r '[.workflow_runs[].created_at] | . == (sort | reverse)' <<<"$rows")" true \
    "and as bytes too, the order base sorts them in"
}

# Every setter refuses what it cannot mean. `spend_grace 0.5` is the one that would pass for
# honoured: the fixture would sleep a fraction on the platforms whose sleep takes one and refuse
# on the fleet's others, so a case would spend a grace on one box and not on the next.
test_the_fixture_setters_refuse_what_they_cannot_mean() {
  local rc
  reset_fixture
  for rc in "spend_grace 0.5" "spend_grace x" "at_round 0 $SHA_B" "at_round x $SHA_B" \
    "runs_from_round 1 1 '[]'" "runs_from_round 02 1 '[]'" "runs_from_round 2 x '[]'" "runs_from_round 2 1" \
    "delay_after_runs_read 0" "delay_after_runs_read 0.5" "aged_at_read x 5" "aged_at_read 7 1.5" "aged_at_read 7"; do
    set +e
    # shellcheck disable=SC2086 # two words, and they are meant to be two arguments
    (eval $rc) 2>"$TEST_ROOT/refusal"
    [ $? -eq 1 ] || bail "\`$rc\` should be refused"
    set -e
    assert_contains "$(cat "$TEST_ROOT/refusal")" "FAIL: ${rc%% *}:" \
      "the refusal should name the setter that was misused"
  done
  set +e
  (at_round 1) 2>"$TEST_ROOT/refusal"
  [ $? -eq 1 ] || bail "at_round with no sha should be refused"
  set -e
  assert_contains "$(cat "$TEST_ROOT/refusal")" "at_round: no sha" "and say what was missing"
}

# A suite that sources this file without the preamble is refused rather than quietly propped up:
# the preamble is what sources pr-review.sh and installs the shadow guard, and a fixture running
# without that guard is exactly ludics-lite#46's silence.
test_a_suite_that_skips_the_preamble_is_refused() {
  local dir rc out
  test_tmpdir dir base-lib-control
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'source %s\n' "\"$BASE_LIB_DIR/$BASE_LIB_BASENAME\""
  } >"$dir/no-preamble.sh"
  set +e
  out=$(bash "$dir/no-preamble.sh" 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "a refusal is exit 2 ($out)"
  assert_contains "$out" "$BASE_LIB_BASENAME: REFUSING to run: source test-pr-review-lib.sh first" \
    "the refusal should say what is missing, under the name the file goes by"
}

# The reviewer's scenario, from the suite's side: a suite that redefines one of the transport's
# own helpers is refused rather than silently served its own. `reset_fixture` is the one that
# would hurt most — every case opens with it — and before `protect_library` the guard accepted it,
# since the preamble's snapshot was taken before this file was sourced.
test_a_suite_that_shadows_the_transport_is_refused() {
  local dir rc out
  test_tmpdir dir base-lib-shadow
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'source %s\n' "\"$BASE_LIB_DIR/test-pr-review-lib.sh\""
    printf 'source %s\n' "\"$BASE_LIB_DIR/$BASE_LIB_BASENAME\""
    echo 'reset_fixture() { :; }'
    echo 'test_a_case() { assert_eq 1 1 "one is one"; }'
    echo 'run_tests test_a_case -- "$@"'
  } >"$dir/shadow.sh"
  set +e
  out=$(bash "$dir/shadow.sh" 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "a shadow of the transport is a refusal, exit 2 ($out)"
  assert_contains "$out" "$BASE_LIB_BASENAME's reset_fixture ($BASE_LIB_BASENAME:" \
    "the refusal should name this file as the owner, by basename"
  assert_contains "$out" "without \`stub reset_fixture\`" "and name the remedy"
  assert_not_contains "$out" "PASS:" "no case may run under a refusal"
}

# The PR #419 shape: a fixture key pattern that also matches a name pr-review.sh defines. The old
# reset unset WORKFLOW_YAML_FILTER (a constant of the retired shell half) in silence and a suite
# went red somewhere else; the reset now refuses, naming it. The shape here is the same over a
# constant the script still sets, BUDGET_DIR. The control: names a case creates under the same
# patterns are still cleared.
test_reset_fixture_refuses_to_unset_a_name_it_did_not_create() {
  local rc v
  reset_fixture
  [ -n "${BUDGET_DIR+set}" ] || bail "pr-review.sh should define BUDGET_DIR"
  set +e
  (
    FIXTURE_KEYS+=('BUDGET_[A-Za-z0-9_]*')
    reset_fixture
  ) 2>"$TEST_ROOT/refusal"
  rc=$?
  set -e
  assert_eq "$rc" 2 "a key pattern over a library name is refused ($(cat "$TEST_ROOT/refusal"))"
  assert_contains "$(cat "$TEST_ROOT/refusal")" "in scope before any case ran: BUDGET_DIR —" \
    "the refusal should name the library variable the pattern matched, alone"
  RUNS_7=x RUNS_7_FROM_2=x JOBS_7003=x RUN_7003=x WORKFLOW_PATH_7=x YAML_OF_nightly=x FILES_d=x
  reset_fixture
  for v in RUNS_7 RUNS_7_FROM_2 JOBS_7003 RUN_7003 WORKFLOW_PATH_7 YAML_OF_nightly FILES_d; do
    assert_eq "${!v-unset}" unset "reset_fixture should clear the per-key answer $v"
  done
  assert_eq "$(jq -c '.workflow_runs' <<<"$RUNS_1")" '[]' "and set RUNS_1 afresh"
}

tests=(
  test_the_round_counter_counts_rounds_and_not_reads
  test_the_grace_is_spent_once_on_the_first_read
  test_at_round_moves_the_tip_inside_the_round_it_names
  test_a_runs_feed_changes_on_the_round_it_names
  test_the_workflow_list_follows_the_moved_tip
  test_the_runs_read_delay_is_round_ones_and_once
  test_an_aged_run_is_stamped_at_the_read
  test_a_compare_ends_at_its_head
  test_runs_json_dates_are_a_minute_apart_past_sixty_rows
  test_the_fixture_setters_refuse_what_they_cannot_mean
  test_a_suite_that_skips_the_preamble_is_refused
  test_a_suite_that_shadows_the_transport_is_refused
  test_reset_fixture_refuses_to_unset_a_name_it_did_not_create
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
