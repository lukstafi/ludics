#!/usr/bin/env bash
# Focused fixture tests for pr-review.sh's build gate, and specifically for everything the CHECK
# list alone cannot say about a head: "no workflow covers this commit" versus "the run for this
# commit has not created its checks yet" (ludics-lite#24), a run that failed or was stopped before
# any check existed, and a green check standing over a sibling run that has not judged the head
# (ludics-lite#38, round 2). None of those may leave the gate as exit 0. And the one place `merge`
# has to act on what this gate read: an ABSENT verdict whose base moves before the merge call
# (ludics-lite#523), and what an --override hands the gate (ludics-lite#392).
#
# BLACK-BOX (ludics-lite#403): every case drives the command line -- `checks` (cmd_checks) or
# `merge` (cmd_merge), the forwarded subcommands -- with the fixture `gh` below as the only stand-in.
# No case calls an internal function or replaces one, so the same cases judge the shell and the
# Python implementation alike. The gate is read through `checks`, which reads the repository's
# advisory list first (a 404 the listing confirms, unless a case says otherwise) and ends with its
# `checks: verdict=` trailer; the override's waiver is read through `merge --override`, the only
# command that hands the gate one; and the advisory list is read off what the gate then counts.

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
test_tmpdir TEST_ROOT checks-absent-test

REPO=example/repo
HEAD_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
# The PR's base branch tip, and the fork point the compare answers with. They are different on
# purpose: the base branch moves under every sibling merge, so the range the paths-ignore
# recognition walks starts at the MERGE BASE and never at `base.sha` (ludics-lite#176).
BASE_SHA=babababababababababababababababababababa
MERGE_BASE=1111111111111111111111111111111111111111
# The PR's own branch. It decides whether a `push` trigger is REACHABLE at all, which is all that
# can be established about a push event here (review round 1): a push's changed files are computed
# between its own before and after, and after a force-push the before is not on the walked path.
HEAD_REF=claude/topic
# The head of the newest merged pull request, which is what the provider question is sampled from.
SAMPLE_SHA=5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a
REQUEST_LOG="$TEST_ROOT/requests"
PAGINATE_LOG="$TEST_ROOT/paginated"

# --- the fixture transport --------------------------------------------------------------------
# One canned answer per endpoint, each a list so a round can differ from the next: the wait loop
# re-reads, and a fixture that could only answer once could not tell a hold from a settle.
HEAD_SEQ=()
CHECK_RUNS_SEQ=()
RUNS_SEQ=()
COMMIT_AGE=""
PR_UPDATED_AGE=""
JOBS_JSON=""
FAIL_ENDPOINT=""
# The repository's advisory list on its default branch (ludics-lite#530): empty is no such file, a
# 404, which is every case's state but the ones that are about the file.
ADVISORY_BODY=""
ADVISORY_HTTP=""                       # nonempty = the read is refused with this HTTP status
# The listings a 404 is confirmed against: `.github`'s entries and the root's, as JSON arrays of
# names; "404" or "500" in place of an array is that answer.
ADVISORY_DIR=""
ADVISORY_ROOT=""
# --- the paths-ignore recognition's own feeds (ludics-lite#176) --------------------------------
# A run-less head inside the grace is the one place the gate can do better than the clock: if
# every workflow's own filter says no run can be created for this head, the absence is settled on
# the spot. These are the answers that question reads — the workflow list, each workflow's file at
# the head, the compare that names the merge base, and what each commit in the range changed.
# PR_BASE is the base SHA the PR read answers with; a case clears it to stand for a PR whose base
# could not be read, which refuses the recognition before any of the rest is asked.
PR_BASE=""
PR_HEAD_REF=""
WORKFLOWS_JSON=""
WORKFLOW_TOTAL=""
WORKFLOW_PATH=""
WORKFLOW_YAML=""
# The base tip's copy of the same file. A `pull_request` run uses the workflow from the MERGE
# context, so the head's copy only speaks for it when the base's copy is identical; a case that
# sets this differently stands for a base-side edit made after the branch diverged.
WORKFLOW_YAML_BASE=""
# What `.github/workflows/` holds at each end of the merge. The repository's workflow LIST is not
# that set — it is built from the default branch plus whatever has run — so a file only one side
# carries is a workflow nothing examines while its first run is on its way.
WORKFLOW_DIR_HEAD=""
WORKFLOW_DIR_BASE=""
# Entries in that directory that are not workflow files. They count towards the endpoint's cap
# just the same, which is what the cap guard has to be read against.
WORKFLOW_DIR_OTHER=""
# The newest merged pull request of this repository, and its head's check runs: where "does this
# repository have a provider other than Actions" is read. The recognition reads workflows, so it
# can answer for nothing else — and a merged PR's head is the population the question is about,
# where the base tip (round 2's sample) was not.
MERGED_PRS_JSON=""
SAMPLE_CHECKS_JSON=""
SAMPLE_CHECKS_TOTAL=""
# What the PR read answers with from its SECOND call on: a retarget, or a base advance, which moves
# the evidence the recognition rests on without moving the head.
PR_BASE_NEXT=""
COMPARE_COMMITS=""
FILES_JSON=""
# The base the PR names once it has ADVANCED between the gate's read and the merge call
# (ludics-lite#523): served by every PR read after the advance (the stubbed warn_base_drift, which
# cmd_merge runs right after the gate, makes it). ADVANCE_ADDS_WORKFLOW nonempty = the advance adds
# a workflow, docs-check.yml, whose `paths:` cover this head's docs-only diff; the head lacks it.
BASE_ADVANCED=""
ADVANCE_ADDS_WORKFLOW=""
DOCS_PATHS_YAML='name: docs-check
on:
  pull_request:
    paths: ["docs/**"]
jobs:
  lint:
    runs-on: ubuntu-latest
'
MERGE_LOG="$TEST_ROOT/merge-calls"

# What merge reads besides the build signal -- the body, the commit series, the review threads, the
# base drift -- is answered plainly below (nothing to close, nothing open, nothing drifted): those
# are test-pr-review-merge.sh's subject. The base-drift read comes right after the gate and before
# the merge loop, so its PR read (the one projecting `mergeable_state`) is where the base advances.
advanced_adds() { [ -n "$ADVANCE_ADDS_WORKFLOW" ] && [ -e "$TEST_ROOT/base-advanced" ]; }

# A workflow with NO path filter at all, which is what this repository's own CI looks like and
# what every case here that is about the CLOCK needs: nothing about it can explain an absence, so
# the recognition refuses and the grace answers, exactly as it did before #176.
UNFILTERED_YAML='name: ci
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
'


# The one shape the recognition can answer for: a workflow triggered on `pull_request` alone, with
# a filter covering the change. A declared `push` refuses whatever it says, so it is not here.
DOCS_IGNORED_YAML='name: ci
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - "**.md"
jobs:
  build:
    runs-on: ubuntu-latest
'

check_runs_json() { jq -cn --argjson runs "$1" '{check_runs:$runs}'; }
# Each row gets a distinct workflow_id unless the case names one, because the gate folds the run
# list per workflow and a shared id means "these are the same workflow's runs" — which is what the
# superseded-run cases below say deliberately. Rows are newest-first, as the API returns them, and
# the default `created_at` says so too: one second earlier per row down the list, so the order and
# the timestamps agree. The gate sorts on (created_at desc, id desc), so a case meaning "these two
# were created in the SAME second" has to name `created_at` on both rows — which is what the tie
# case does. Note that the default ids ASCEND down the list while the times descend: the newest
# row carries the LOWEST id, so a fold that sorted by id alone would invert every superseded-run
# case below (test_newest_run_of_a_workflow_still_counts is where that shows).
RUNS_EPOCH=1767225600 # 2026-01-01T00:00:00Z, a fixed clock: nothing here measures a run's age
runs_json() {
  jq -cn --argjson runs "$1" --argjson t0 "$RUNS_EPOCH" \
    '{workflow_runs: [$runs | to_entries[] | .value + {
        id: (.value.id // (.key + 101)),
        workflow_id: (.value.workflow_id // (.key + 1)),
        created_at: (.value.created_at // (($t0 - .key) | todateiso8601)),
        event: (.value.event // "push")}]}'
}
jobs_json() { jq -cn --argjson jobs "$1" '{jobs:$jobs}'; }
iso_ago() { jq -rn --argjson n "$1" '(now - $n) | todateiso8601'; }

# Pops the next canned answer, and repeats the last one forever after: the round count is the
# behaviour under test, not something each case should have to predict. The round counter lives in
# a FILE because every `gh` call runs the fixture in a fresh bash (the forward's bridge) — a variable
# incremented there dies with that shell, and every round would be served the first answer forever.
next_of() {
  local name="$1" counter="$TEST_ROOT/$1.calls" idx total
  idx=$(cat "$counter" 2>/dev/null) || idx=0
  case "$idx" in '' | *[!0-9]*) idx=0 ;; esac
  printf '%s' "$((idx + 1))" >"$counter"
  eval "total=\${#${name}[@]}"
  [ "$idx" -lt "$total" ] || idx=$((total - 1))
  eval "printf '%s' \"\${${name}[$idx]}\""
}

# The base the PR read answers with: PR_BASE until PR_BASE_NEXT is set, and that from the SECOND
# call on — how a case retargets the PR, or advances its base, between the round's first read and
# the recognition's own re-confirm. The count lives in a FILE for the reason every other counter
# here does: each read is a command substitution, where an incremented variable dies.
next_base() {
  local n
  if [ -e "$TEST_ROOT/base-advanced" ]; then printf '%s' "$BASE_ADVANCED"; return 0; fi
  [ -n "$PR_BASE_NEXT" ] || { printf '%s' "$PR_BASE"; return 0; }
  n=$(cat "$TEST_ROOT/pulls.calls" 2>/dev/null) || n=0
  case "$n" in '' | *[!0-9]*) n=0 ;; esac
  printf '%s' "$((n + 1))" >"$TEST_ROOT/pulls.calls"
  if [ "$n" -eq 0 ]; then printf '%s' "$PR_BASE"; else printf '%s' "$PR_BASE_NEXT"; fi
}

reset_fixture() {
  HEAD_SEQ=("$HEAD_SHA")
  CHECK_RUNS_SEQ=("$(check_runs_json '[]')")
  RUNS_SEQ=("$(runs_json '[]')")
  COMMIT_AGE=3600
  PR_UPDATED_AGE=3600
  JOBS_JSON=$(jobs_json '[]')
  FAIL_ENDPOINT=""
  ADVISORY_BODY=""
  ADVISORY_HTTP=""
  ADVISORY_DIR='["workflows"]'
  ADVISORY_ROOT='[".github","README.md"]'
  PR_BASE="$BASE_SHA"
  PR_HEAD_REF="$HEAD_REF"
  WORKFLOWS_JSON=$(jq -cn '{workflows:[{id:1,name:"ci",state:"active"}]}')
  WORKFLOW_TOTAL=""
  WORKFLOW_PATH=".github/workflows/ci.yml"
  for v in $(set | LC_ALL=C sed -n 's/^\(WORKFLOW_PATH_[0-9][0-9]*\)=.*/\1/p'); do unset "$v"; done
  WORKFLOW_YAML="$UNFILTERED_YAML"
  WORKFLOW_YAML_BASE=""
  WORKFLOW_DIR_HEAD='[".github/workflows/ci.yml"]'
  WORKFLOW_DIR_BASE=""
  WORKFLOW_DIR_OTHER='[]'
  MERGED_PRS_JSON=$(jq -cn --arg s "$SAMPLE_SHA" \
    '[{merged_at:"2026-09-18T00:00:00Z", head:{sha:$s}}]')
  SAMPLE_CHECKS_JSON=$(check_runs_json '[{"name":"ci","app":{"slug":"github-actions"}}]')
  SAMPLE_CHECKS_TOTAL=""
  PR_BASE_NEXT=""
  COMPARE_COMMITS=$(jq -cn --arg h "$HEAD_SHA" '[$h]')
  FILES_JSON='[{"filename":"docs/notes.md"}]'
  BASE_ADVANCED=""
  ADVANCE_ADDS_WORKFLOW=""
  rm -f "$TEST_ROOT/base-advanced" "$TEST_ROOT/merged"
  : >"$MERGE_LOG"
  rm -f "$TEST_ROOT/pulls.calls" "$TEST_ROOT/CHECK_RUNS_SEQ.calls" "$TEST_ROOT/RUNS_SEQ.calls" "$TEST_ROOT/HEAD_SEQ.calls"
  retune ABSENT_GRACE=300 CHECKS_INTERVAL=1 CHECKS_HEARTBEAT=600
  : >"$REQUEST_LOG"
  : >"$PAGINATE_LOG"
}

gh() {
  local response="" fixture_head wid fixture_wpath merged=false
  # cmd_merge's own call, the one non-api call here: logged, and the PR reads answer merged after.
  if [ "${1:-} ${2:-}" = "pr merge" ]; then
    printf '%s\n' "$*" >>"$MERGE_LOG"
    : >"$TEST_ROOT/merged"
    return 0
  fi
  gh_fixture_parse "$@"
  # A GLOB, deliberately unquoted: "repos/o/n/commits/<sha>" is a prefix of the check-runs
  # endpoint, so a substring match could not fail the commit read alone — and a case that failed
  # both reads would pass for the wrong reason.
  if [ -n "$FAIL_ENDPOINT" ]; then
    # shellcheck disable=SC2254
    case "$FIXTURE_ENDPOINT" in
    $FAIL_ENDPOINT)
      echo "gh: $FIXTURE_ENDPOINT unavailable (HTTP 500)" >&2
      return 1
      ;;
    esac
  fi
  # ORDER IS LOAD-BEARING. `case` takes the FIRST arm that matches, and several arms below are
  # globs that also match a more specific endpoint's path — so the specific arm must come before
  # the glob it would otherwise fall into, or the endpoint is silently served the wrong canned
  # answer (no arm fails; the `*)` bail only fires for a path nothing matches). The traps:
  #   - "commits/$HEAD_SHA" (commit date) and "commits/$SAMPLE_SHA/check-runs?…" (sample checks)
  #     must precede "commits/"* (the files of a range commit), which matches both.
  #   - "contents/.github/workflows?ref=$BASE_SHA" (base's workflow dir) must precede
  #     "contents/.github/workflows?ref="* (head's), and both must precede
  #     "contents/"*"?ref=$BASE_SHA" (a workflow file at the base) and "contents/"* (at the
  #     head): a directory listing matches every one of the file-content globs.
  # Adding an arm: put an exact endpoint above every glob whose pattern it satisfies, and a new
  # glob below every exact arm it would swallow. "actions/workflows?…" and "actions/workflows/"*
  # do NOT overlap (the glob demands the slash), nor do "actions/runs?…" and "actions/runs/"*.
  case "$FIXTURE_ENDPOINT" in
  "repos/$REPO/pulls/7")
    # merge --wait's conflict preflight (ludics-lite#729, the one interpolated projection) reads no
    # head: it is answered clean without taking a HEAD_SEQ entry, which stay the gate's reads.
    case "$FIXTURE_FILTER" in
    *'\(.mergeable)'*)
      response='{"mergeable":true,"mergeable_state":"clean","base":{"ref":"main"}}'
      ;;
    *)
    # The base-drift read (the one other projection carrying mergeable_state) runs after the gate
    # and before the merge loop: the moment a case's base advance lands.
    case "$FIXTURE_FILTER" in
    *mergeable_state*) [ -z "$BASE_ADVANCED" ] || : >"$TEST_ROOT/base-advanced" ;;
    esac
    fixture_head=$(next_of HEAD_SEQ)
    if [ "$fixture_head" = UNREADABLE ]; then return 1; fi
    [ ! -e "$TEST_ROOT/merged" ] || merged=true
    if [ -n "$PR_UPDATED_AGE" ]; then
      response=$(jq -cn --arg sha "$fixture_head" --arg at "$(iso_ago "$PR_UPDATED_AGE")" \
        --arg base "$(next_base)" --arg ref "$PR_HEAD_REF" \
        --argjson m "$merged" \
        '{head:({sha:$sha} + (if $ref == "" then {} else {ref:$ref} end)), updated_at:$at,
          merged:$m, state:(if $m then "closed" else "open" end), body:"", commits:1,
          mergeable:true, mergeable_state:"clean"}
         + (if $base == "" then {base:{ref:"main"}} else {base:{sha:$base, ref:"main"}} end)')
    else
      response=$(jq -cn --arg sha "$fixture_head" --arg base "$(next_base)" --arg ref "$PR_HEAD_REF" \
        '{head:({sha:$sha} + (if $ref == "" then {} else {ref:$ref} end)), body:"", commits:1,
          mergeable:true, mergeable_state:"clean"}
         + (if $base == "" then {base:{ref:"main"}} else {base:{sha:$base, ref:"main"}} end)')
    fi
    ;;
    esac
    ;;
  "repos/$REPO/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100")
    response=$(next_of CHECK_RUNS_SEQ)
    ;;
  "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100")
    response=$(next_of RUNS_SEQ)
    ;;
  "repos/$REPO/actions/runs/"*"/jobs?per_page=100") response="$JOBS_JSON" ;;
  "repos/$REPO/commits/$HEAD_SHA")
    response=$(jq -cn --arg at "$(iso_ago "$COMMIT_AGE")" '{commit:{committer:{date:$at}}}')
    ;;
  # --- the recognition's feeds ---------------------------------------------------------------
  "repos/$REPO/actions/workflows?per_page=100")
    response=$(jq -c --arg t "$WORKFLOW_TOTAL" --arg added "$(advanced_adds && echo 1)" \
      '(if $added == "" then . else .workflows += [{id:2,name:"docs-check",state:"active"}] end)
       | . + {total_count: (if $t == "" then (.workflows | length) else ($t | tonumber) end)}' \
      <<<"$WORKFLOWS_JSON")
    ;;
  # The workflow's own file: where it lives, then what it says AT THE HEAD. Served raw, as the
  # library asks for it — the base64 JSON envelope's decoder is spelled differently on this
  # fleet's two platforms.
  "repos/$REPO/actions/workflows/"*)
    # Per id, so a case can give one listed workflow a path of its own (a row whose file is not in
    # either end of the merge); every other id answers with the shared path.
    wid=${FIXTURE_ENDPOINT##*/actions/workflows/}
    eval "fixture_wpath=\${WORKFLOW_PATH_$wid:-\$WORKFLOW_PATH}"
    response=$(jq -cn --arg p "$fixture_wpath" '{path:$p}')
    ;;
  # Entries, not only files: the endpoint's cap is on the array, and a response holding
  # directories can carry fewer files than the cap and still be truncated.
  # The advanced base (ludics-lite#523), above every contents arm it would fall into: its directory
  # carries docs-check.yml when the advance added it, and the head never does (a 404 at the head).
  "repos/$REPO/contents/.github/workflows?ref=${BASE_ADVANCED:-unset}")
    response=$(jq -cn --argjson f "$WORKFLOW_DIR_HEAD" --arg added "$ADVANCE_ADDS_WORKFLOW" \
      '[($f + (if $added == "" then [] else [".github/workflows/docs-check.yml"] end))[]
        | {type:"file", path:.}]')
    ;;
  "repos/$REPO/contents/.github/workflows/docs-check.yml?ref=${BASE_ADVANCED:-unset}")
    response="$DOCS_PATHS_YAML"
    ;;
  "repos/$REPO/contents/.github/workflows/docs-check.yml?ref=$HEAD_SHA")
    echo "gh: Not Found (HTTP 404)" >&2
    return 1
    ;;
  "repos/$REPO/contents/.github/workflows?ref=$BASE_SHA")
    response=$(jq -cn --argjson f "${WORKFLOW_DIR_BASE:-$WORKFLOW_DIR_HEAD}" \
      --argjson d "$WORKFLOW_DIR_OTHER" \
      '[$f[] | {type:"file", path:.}] + [$d[] | {type:"dir", path:.}]')
    ;;
  "repos/$REPO/contents/.github/workflows?ref="*)
    response=$(jq -cn --argjson f "$WORKFLOW_DIR_HEAD" --argjson d "$WORKFLOW_DIR_OTHER" \
      '[$f[] | {type:"file", path:.}] + [$d[] | {type:"dir", path:.}]')
    ;;
  # Exact, and above every contents glob below, which would serve it a workflow file. No `?ref=`:
  # the list is read from the default branch.
  "repos/$REPO/contents/.github/ship-pr-advisory-checks")
    if [ -n "$ADVISORY_HTTP" ]; then
      echo "gh: refused (HTTP $ADVISORY_HTTP)" >&2
      return 1
    fi
    if [ -z "$ADVISORY_BODY" ]; then
      echo "gh: Not Found (HTTP 404)" >&2
      return 1
    fi
    response="$ADVISORY_BODY"
    ;;
  "repos/$REPO/contents/.github") response=$(advisory_listing "$ADVISORY_DIR") || return 1 ;;
  "repos/$REPO/contents") response=$(advisory_listing "$ADVISORY_ROOT") || return 1 ;;
  "repos/$REPO/contents/"*"?ref=$BASE_SHA")
    response="${WORKFLOW_YAML_BASE:-$WORKFLOW_YAML}"
    ;;
  "repos/$REPO/contents/"*) response="$WORKFLOW_YAML" ;;
  "repos/$REPO/pulls?state=closed&sort=updated&direction=desc&per_page=20")
    response="$MERGED_PRS_JSON"
    ;;
  "repos/$REPO/commits/$SAMPLE_SHA/check-runs?filter=latest&per_page=100")
    response=$(jq -c --arg t "$SAMPLE_CHECKS_TOTAL" \
      '. + {total_count: (if $t == "" then (.check_runs | length) else ($t | tonumber) end)}' \
      <<<"$SAMPLE_CHECKS_JSON")
    ;;
  # One answer for both compares the recognition makes: `base...head`, read for the merge base
  # alone, and `merge_base...head`, read for the commits. Oldest first, each commit the first
  # parent of the next and the first one's parent the merge base — the shape a linear range has.
  "repos/$REPO/compare/"*)
    response=$(jq -cn --argjson c "$COMPARE_COMMITS" --arg m "$MERGE_BASE" \
      '{merge_base_commit: {sha: $m}, total_commits: ($c | length), behind_by: 0,
        ahead_by: ($c | length), files: [],
        commits: [$c | to_entries[] |
          {sha: .value,
           parents: [{sha: (if .key == 0 then $m else $c[.key - 1] end)}]}]}')
    ;;
  # merge's own reads, answered plainly: the base branch's tip (the drift read's anchor), the
  # repository's default branch, the commit series and the review threads.
  "repos/$REPO/commits/main") response='{"sha":"7171717171717171717171717171717171717171"}' ;;
  "repos/$REPO/commits/"*) response=$(jq -cn --argjson f "$FILES_JSON" '{files:$f}') ;;
  "repos/$REPO") response='{"default_branch":"main"}' ;;
  "repos/$REPO/pulls/7/commits?per_page=100")
    response=$(jq -cn --arg s "$HEAD_SHA" '[{sha:$s, commit:{message:"A commit."}}]')
    ;;
  graphql)
    case "$FIXTURE_QUERY" in
    *mergeQueue*) response='{"data":{"repository":{"mergeQueue":null}}}' ;;
    *) response=$(review_threads_answer '[]' "$@") ;;
    esac
    ;;
  *) bail "unexpected fixture endpoint: $FIXTURE_ENDPOINT" ;;
  esac
  gh_fixture_answer "$response"
}

advisory_listing() { # <names as a JSON array, or an HTTP status>
  case "$1" in
  404) echo "gh: Not Found (HTTP 404)" >&2; return 1 ;;
  500) echo "gh: unavailable (HTTP 500)" >&2; return 1 ;;
  esac
  jq -c '[.[] | {name: ., type: "file"}]' <<<"$1"
}

run_merge() {
  local rc
  set +e
  (cmd_merge "$REPO#7" "$@") >"$TEST_ROOT/merge-out" 2>&1
  rc=$?
  set -e
  MERGE_OUTPUT=$(cat "$TEST_ROOT/merge-out")
  MERGE_RC="$rc"
  MERGE_CALLS=$(cat "$MERGE_LOG")
}

# The gate, read through `checks` with its --wait (0: one read). Both streams, as the gate's own
# capture was; the trailer closes stdout.
run_gate() {
  local capture rc
  set +e
  capture=$(cmd_checks 7 --wait="${1:-0}" 2>&1)
  rc=$?
  set -e
  GATE_OUTPUT="$capture"
  GATE_RC="$rc"
}

# `checks` with the words a case gives it, verbatim: the --check cases (ludics-lite#569).
run_checks() {
  local capture rc
  set +e
  capture=$(cmd_checks 7 "$@" 2>&1)
  rc=$?
  set -e
  GATE_OUTPUT="$capture"
  GATE_RC="$rc"
}

# --- the cases --------------------------------------------------------------------------------

# The issue itself: `checks --wait` armed seconds after a push, `gh run list` showing the run for
# that head in_progress, and the gate answering exit 0 ABSENT.
test_inflight_run_is_not_absent() {
  reset_fixture
  COMMIT_AGE=20
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress"}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "an in-flight run with no checks yet is no verdict, not absence"
  assert_contains "$GATE_OUTPUT" "NO VERDICT YET" "the in-flight run should headline no verdict"
  assert_contains "$GATE_OUTPUT" "1 workflow run(s) for this head have no conclusion yet" \
    "the reason should name the unfinished run"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "an unfinished run must not print ABSENT"
}

test_queued_run_is_not_absent() {
  reset_fixture
  COMMIT_AGE=99999
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"queued"}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "a queued run is no verdict even long after the push"
  assert_contains "$GATE_OUTPUT" "NO VERDICT YET" "a queued run should headline no verdict"
}

# No run at all, seconds after the push: the creation window, not path filters.
test_fresh_push_without_a_run_waits() {
  reset_fixture
  COMMIT_AGE=30
  run_gate
  assert_eq "$GATE_RC" 4 "a run-less head inside the grace is no verdict"
  assert_contains "$GATE_OUTPUT" "creation grace" "the reason should name the grace"
  assert_contains "$GATE_OUTPUT" "SHIP_PR_BASE_ABSENT_GRACE" "the reason should name the knob"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "a head inside the grace must not print ABSENT"
}

# Past the grace with no run: this is the verdict the word ABSENT was always meant for.
test_stale_push_without_a_run_is_absent() {
  reset_fixture
  COMMIT_AGE=1800
  run_gate
  assert_eq "$GATE_RC" 0 "no run 30 min after the push is the absence verdict"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "past the grace should print ABSENT"
  assert_contains "$GATE_OUTPUT" "no workflow run exists for this head in the 30m" \
    "the absence should say what was read and how long it waited"
}

test_grace_of_zero_settles_at_once() {
  reset_fixture
  COMMIT_AGE=1
  retune ABSENT_GRACE=0
  run_gate
  assert_eq "$GATE_RC" 0 "a zero grace is the escape hatch and must settle immediately"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "a zero grace should print ABSENT"
}

# A finished run that left no build check is the path-filter case, and it needs no grace at all.
test_finished_run_without_checks_is_absent() {
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  run_gate
  assert_eq "$GATE_RC" 0 "a finished run that produced no build check is absence"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "a finished run with no checks should print ABSENT"
  assert_contains "$GATE_OUTPUT" "finished and left no build check behind" \
    "the absence should name the finished run"
}

# --- a head no run can be created for (ludics-lite#176) ----------------------------------------
# `base --wait` has recognized a paths-ignore TIP since #156; the same head, on a PR, waited the
# full grace out before its absence was called. It is the same question with two differences: the
# range is the PR's own (from its merge base, not from a standing verdict's commit), and a PR head
# can be given a run by `pull_request` as readily as by `push`, so every trigger has to answer.
test_a_docs_only_head_is_absent_without_waiting_out_the_grace() {
  reset_fixture
  COMMIT_AGE=5 # seconds into a 300s grace: only the filter can settle this
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  run_gate
  assert_eq "$GATE_RC" 0 "a head whose whole range is paths-ignored is absence, not a wait"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "the recognized absence is the verdict"
  assert_contains "$GATE_OUTPUT" "no workflow run exists for this head, and none can be created" \
    "the reason should say no run is coming, not that one may still appear"
  assert_contains "$GATE_OUTPUT" "none can be created by ci" \
    "and name the workflow that cannot create one"
  assert_not_contains "$GATE_OUTPUT" "creation grace" "the clock is not what settled this"
  # The range is the PR's own fork point, never the base branch tip, which moves under every
  # sibling merge: reading base.sha for the range would walk the base branch's commits too.
  assert_contains "$(cat "$REQUEST_LOG")" "compare/$MERGE_BASE...$HEAD_SHA?per_page=" \
    "the commits are read from the merge base up"
}

# One trigger's docs-only filter says nothing about the trigger beside it, so a `pull_request` with
# no paths-ignore is a run this cannot rule out.
test_a_trigger_without_a_filter_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$UNFILTERED_YAML"
  run_gate
  assert_eq "$GATE_RC" 4 "a trigger with no filter can still create the run"
  assert_contains "$GATE_OUTPUT" "creation grace" "so the clock is all that is left"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "and the absence is not yet a fact"
}

# A declared `push` trigger REFUSES, whatever it says. Nothing about a push event is establishable
# from the feeds here: its changed files are computed between its own before and after, which a
# force-push puts off the walked path; a tag or another branch carries the same SHA; and the one
# lookup that could name those branches describes where the SHA is head NOW rather than where it
# was pushed. Four review rounds each closed a case and found another, so the rule is that there
# is no rule — which costs this recognition most of its reach and costs no head a wrong absence.
test_any_push_trigger_keeps_the_head_waiting() {
  local push
  for push in 'push:' 'push:
    branches: [main]' 'push:
    branches: [main]
    paths-ignore: ["docs/**", "**.md"]'; do
    reset_fixture
    COMMIT_AGE=5
    WORKFLOW_YAML="name: ci
on:
  pull_request:
    paths-ignore: [\"docs/**\", \"**.md\"]
  $push
jobs:
  build:
    runs-on: ubuntu-latest
"
    run_gate
    assert_eq "$GATE_RC" 4 "a declared push trigger is never ruled out"
    assert_contains "$GATE_OUTPUT" "creation grace" "so the grace answers, as it did before #176"
  done
}

# A dispatched or scheduled run CAN carry this head, and an empty run list does not say one is not
# on its way — that emptiness is the not-created-yet window, which is the whole question.
# `gh workflow run --ref <branch>` is a validation somebody asked for by hand, and merging inside
# its creation window is what the grace exists to prevent (review round 4).
test_a_dispatchable_trigger_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML='name: ci
on:
  schedule:
    - cron: "0 0 * * *"
  workflow_dispatch:
  pull_request:
    paths-ignore: ["docs/**", "**.md"]
jobs:
  build:
    runs-on: ubuntu-latest
'
  run_gate
  assert_eq "$GATE_RC" 4 "a run either of them creates would carry this head"
  assert_contains "$GATE_OUTPUT" "creation grace" "so the grace answers"
}

# Per COMMIT, as `base --wait` reads it and for the same reason: a path filter is evaluated per
# push, and a range that nets out to docs can still contain a push that touched source.
test_a_source_file_in_the_range_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  FILES_JSON='[{"filename":"docs/notes.md"},{"filename":"src/main.ml"}]'
  run_gate
  assert_eq "$GATE_RC" 4 "one source path in the range is a run that is coming"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace is what answers instead"
}

# Every way the recognition can be less than certain leaves the wait waiting rather than hand out
# an absence: the parser is narrow on purpose, and a refusal costs only the grace that was there
# before it. A tab is YAML this state machine will not claim to have read.
test_an_unreadable_workflow_file_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML=$(printf 'name: ci\non:\n\tpull_request:\n\t\tpaths-ignore: ["docs/**"]\n')
  run_gate
  assert_eq "$GATE_RC" 4 "a workflow file that does not parse explains nothing"
  assert_contains "$GATE_OUTPUT" "creation grace" "and the grace answers as before"
}

test_an_unreadable_workflow_list_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  FAIL_ENDPOINT="*actions/workflows*"
  run_gate
  assert_eq "$GATE_RC" 4 "a workflow list that could not be read is not evidence of anything"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "and a failed read never becomes an absence"
}

# A PR whose base SHA the read did not carry has no range to walk. The recognition refuses before
# it asks the API anything at all.
test_a_head_without_a_base_sha_is_never_recognized() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  PR_BASE=""
  run_gate
  assert_eq "$GATE_RC" 4 "with no base there is no range and nothing to recognize"
  assert_eq "$(grep -c "compare/" "$REQUEST_LOG")" 0 "and nothing is asked of the API"
  # The branch is evidence too: without it a `push` trigger cannot be shown unreachable.
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  PR_HEAD_REF=""
  run_gate
  assert_eq "$GATE_RC" 4 "with no branch a push trigger cannot be shown out of reach"
  assert_eq "$(grep -c "compare/" "$REQUEST_LOG")" 0 "and that too is settled before any read"
}

# An event is inert only when it is NAMED inert. Rounds 1 and 3 each arrived with a member of the
# same class — merge_group wrongly counted, pull_request_review and pull_request_review_comment
# wrongly ignored — so the rule is inverted rather than patched a third time, and anything nobody
# reasoned about costs the grace instead of a wrong absence.
test_an_event_outside_the_inert_list_keeps_the_head_waiting() {
  local ev
  for ev in pull_request_target pull_request_review pull_request_review_comment release \
    schedule workflow_dispatch repository_dispatch workflow_run; do
    reset_fixture
    COMMIT_AGE=5
    WORKFLOW_YAML="name: ci
on:
  pull_request:
    paths-ignore: [\"docs/**\", \"**.md\"]
  $ev:
jobs:
  build:
    runs-on: ubuntu-latest
"
    run_gate
    assert_eq "$GATE_RC" 4 "an unreasoned trigger ($ev) is not inert"
    assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead ($ev)"
  done
}

# The list itself, both of it. What earns a place is not "nothing has fired it yet" but "a run of
# this event can NEVER carry this commit as its head": a merge-group run is created at the queue's
# own temporary ref, and a called workflow produces no run of its own at all — its jobs appear
# inside the caller's.
test_the_named_inert_events_do_not_block_the_recognition() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML='name: ci
on:
  workflow_call:
  merge_group:
  pull_request:
    paths-ignore: ["docs/**", "**.md"]
jobs:
  build:
    runs-on: ubuntu-latest
'
  run_gate
  assert_eq "$GATE_RC" 0 "neither event can put a run on this head, whatever has happened yet"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "so the pull_request filter answers alone"
}

# The repository's workflow list is not an inventory of the files on a non-default branch: a
# workflow the head ADDS is absent from it, so every listed workflow can pass while the newcomer's
# first run is on its way. Any path under the workflow directory anywhere in the range refuses,
# which closes that and the filter-that-moved-mid-range case with one rule and no extra read.
test_a_workflow_added_by_the_range_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  # A filter that ignores the workflow directory too, so nothing but the guard can refuse this.
  WORKFLOW_YAML='name: ci
on:
  pull_request:
    paths-ignore: ["docs/**", "**.md", ".github/workflows/**"]
jobs:
  build:
    runs-on: ubuntu-latest
'
  FILES_JSON='[{"filename":"docs/notes.md"},{"filename":".github/workflows/new.yml"}]'
  run_gate
  assert_eq "$GATE_RC" 4 "a workflow the repository list cannot carry was never examined"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead"
}

# A merge-group run is created only after the PR enters a merge queue, and its head is the queue's
# own temporary ref — never this one. An unfiltered merge_group beside a filtered pull_request is
# an ordinary shape, and counting it would make every docs-only PR wait the grace out.
test_an_unfiltered_merge_group_does_not_block_the_recognition() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML='name: ci
on:
  merge_group:
  pull_request:
    paths-ignore: ["docs/**", "**.md"]
jobs:
  build:
    runs-on: ubuntu-latest
'
  run_gate
  assert_eq "$GATE_RC" 0 "merge_group cannot create a run for this head"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "so the pull_request filter still answers"
}

# --- review round 2: what a workflow filter cannot speak for -----------------------------------
# The recognition reads WORKFLOWS, so it can only ever answer for Actions — and `build_checks`
# accepts every provider's check runs, so a repository with a third-party CI app has a second way
# to grow a check on a fresh head that no workflow filter describes. That is the mirror of the
# rule the gate already holds in the other direction: an early Codecov green over an empty run
# list does not shortcut the grace either.
test_a_second_check_provider_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  SAMPLE_CHECKS_JSON=$(check_runs_json '[{"name":"ci","app":{"slug":"github-actions"}},
                                       {"name":"buildkite","app":{"slug":"buildkite"}}]')
  run_gate
  assert_eq "$GATE_RC" 4 "a provider the workflows do not describe keeps the creation window open"
  assert_contains "$GATE_OUTPUT" "creation grace" "so the grace answers, as it did before"
}

# The review app posts a check run of its own from a non-Actions app, and counting it would refuse
# on every repository this skill is used in. Advisory names are dropped first, as everywhere else.
test_an_advisory_provider_does_not_block_the_recognition() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  SAMPLE_CHECKS_JSON=$(check_runs_json '[{"name":"ci","app":{"slug":"github-actions"}},
                                       {"name":"claude","app":{"slug":"claude"}}]')
  run_gate
  assert_eq "$GATE_RC" 0 "the review app is advisory in this direction too"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "and the recognition still answers"
}

# No non-advisory check run on the sampled pull request at all is no evidence about this
# repository's providers, so it is not evidence that Actions is the only one. Neither is a
# repository with no merged pull request to sample.
test_a_sample_without_checks_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  SAMPLE_CHECKS_JSON=$(check_runs_json '[]')
  run_gate
  assert_eq "$GATE_RC" 4 "an empty check list on the sample says nothing about providers"
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  MERGED_PRS_JSON=$(jq -cn '[{merged_at:null, head:{sha:"0000000000000000000000000000000000000000"}}]')
  run_gate
  assert_eq "$GATE_RC" 4 "a repository with no merged pull request has nothing to sample"
}

# A `pull_request` run uses the workflow from the MERGE context, base merged with head, so a
# base-side edit that removed a paths-ignore takes effect while the head's own copy still carries
# it — and that edit is outside the walked range, so the workflow-file guard never sees it. The
# two copies must be identical; when both sides of a merge hold the same content, that content is
# what the merge produces.
test_a_base_side_workflow_edit_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOW_YAML_BASE="$UNFILTERED_YAML" # main dropped the paths-ignore after the branch diverged
  run_gate
  assert_eq "$GATE_RC" 4 "the head's copy does not speak for the merge context"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "and nothing is settled on the stale copy"
}

# The BASE is evidence here — the workflow bodies, the file inventory and the merge base all came
# from it — and a PR can be RETARGETED, or its base advance, with the head untouched. The caller's
# head-only revalidation would not notice, and `--match-head-commit` does not bind the base either.
test_a_base_that_moves_under_the_recognition_settles_nothing() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  PR_BASE_NEXT=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
  run_gate
  assert_eq "$GATE_RC" 4 "evidence about a target the PR no longer has settles nothing"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "and nothing is called absent on it"
}

# --- ludics-lite#523: an ABSENT verdict whose base moves before the merge call ----------------
# The recognition read the base's workflows, and the merge call binds only the head. The base here
# advances between the gate's read and the merge call, adding a workflow whose `paths:` cover this
# head's docs-only diff — so a run CAN be created now, and the absence the gate settled is about a
# base the PR no longer has. Merge re-reads the base before the call, gates again, and refuses.
test_merge_regates_an_absent_verdict_when_the_base_moved() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  BASE_ADVANCED=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
  ADVANCE_ADDS_WORKFLOW=1
  WORKFLOW_PATH_2=.github/workflows/docs-check.yml
  run_merge
  assert_eq "$MERGE_RC" 4 "an absence read on the old base is not merged on the new one ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" ": ABSENT" "the first read settled the absence"
  assert_contains "$MERGE_OUTPUT" "base moved since its ABSENT verdict was read (babababa -> cdcdcdcd)" \
    "the move is named"
  assert_contains "$MERGE_OUTPUT" "creation grace" "the second read, on the new base, waits"
  assert_eq "$MERGE_CALLS" "" "no merge call is made"
}

# A base that moved without touching what the recognition reads is gated again and merged: the
# second read settles the same absence against the new base, and the merge goes on it.
test_merge_lands_an_absent_verdict_the_moved_base_still_settles() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  BASE_ADVANCED=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
  run_merge
  assert_eq "$MERGE_RC" 0 "the absence holds on the new base too ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "gating the head again against the new base" "the base was re-gated"
  assert_eq "$(grep -c ': ABSENT' <<<"$MERGE_OUTPUT")" 2 "two reads, each settling the absence"
  assert_contains "$MERGE_CALLS" "--match-head-commit $HEAD_SHA" "one merge, bound to the gated head"
  # And an unmoved base costs the one read and nothing more.
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  run_merge
  assert_eq "$MERGE_RC" 0 "an unmoved base merges ($MERGE_OUTPUT)"
  assert_not_contains "$MERGE_OUTPUT" "gating the head again" "and is not gated twice"
  assert_contains "$MERGE_OUTPUT" "none can be created by ci" "on the absence the recognition gave"
  assert_contains "$MERGE_CALLS" "--match-head-commit $HEAD_SHA" "bound to the gated head"
  # A close-out merge still refuses it: a record-based merge must have READ a green, and a head
  # nothing builds has none to read (moved here from test-pr-review-merge.sh, whose gate is now
  # read black-box too and does not model the recognition's feeds).
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  run_merge --require-green
  assert_eq "$MERGE_RC" 4 "a close-out merge needs a green it READ ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" "the build signal is absent" "the refusal names the verdict"
  assert_contains "$MERGE_OUTPUT" "path filters" "and points at the dispatch that would get one"
  assert_eq "$MERGE_CALLS" "" "no merge call is made"
}

# --- review round 8 ---------------------------------------------------------------------------
# A non-`active` row describes the DEFAULT branch, like every other field of this list. A PR
# against a branch that KEPT a workflow the default branch dropped still has that file in its
# merge context, and the merge context is what runs — so the row's state is not proof that the
# copy here cannot run, and a path present at either end is examined like any other.
test_a_deleted_workflow_still_in_the_merge_context_is_examined() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$UNFILTERED_YAML" # the retained copy cannot explain itself
  WORKFLOWS_JSON=$(jq -cn '{workflows:[{id:1,name:"ci",state:"deleted"}]}')
  run_gate
  assert_eq "$GATE_RC" 4 "a file the merge context still holds is not excused by the list's state"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead"
  # The same row when the file really is gone from both ends: nothing to read, nothing to wait
  # for, and the OTHER workflow's filter answers.
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOWS_JSON=$(jq -cn '{workflows:[{id:1,name:"ci",state:"active"},
                                       {id:9,name:"gone",state:"deleted"}]}')
  WORKFLOW_PATH_9=".github/workflows/gone.yml" # listed, but in neither directory
  run_gate
  assert_eq "$GATE_RC" 0 "a row whose file is in neither end of the merge is skipped"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "and the live workflow's filter answers"
}

# --- review round 6 ---------------------------------------------------------------------------
# The name in the repository's workflow list has no ref: it describes the DEFAULT branch's copy,
# while what runs for this PR is the copy at the head and the base. A workflow the list calls
# advisory is therefore not evidence that the file running here is, so every listed workflow is
# explained now — and one whose own filter cannot explain it costs the grace.
test_a_workflow_the_list_calls_advisory_is_still_explained() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOWS_JSON=$(jq -cn '{workflows:[{id:1,name:"ci",state:"active"},
                                       {id:2,name:"claude",state:"active"}]}')
  # Both ids answer with the same path and the same filtered body here, so the advisory-named one
  # is explained on its own terms and the settle stands.
  run_gate
  assert_eq "$GATE_RC" 0 "an advisory-named workflow whose filter explains it settles like any other"
  # The same list, with the file at that path unable to explain itself: no name skips it now.
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$UNFILTERED_YAML"
  WORKFLOWS_JSON=$(jq -cn '{workflows:[{id:2,name:"claude",state:"active"}]}')
  run_gate
  assert_eq "$GATE_RC" 4 "a name from the default branch does not excuse the file that runs here"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead"
}

# The Contents API caps a directory response and offers no pagination past it, so a directory at
# the cap is one this cannot read — and a workflow beyond it would be in neither inventory.
test_a_capped_workflow_directory_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOW_DIR_HEAD=$(jq -cn '[range(1000) | ".github/workflows/w\(.).yml"]')
  run_gate
  assert_eq "$GATE_RC" 4 "a directory response at the endpoint cap is not an inventory"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead"
  # The cap is on ENTRIES, so a response padded to it with directories is truncated even though
  # its FILE count is far below (review round 7).
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOW_DIR_OTHER=$(jq -cn '[range(999) | ".github/workflows/d\(.)"]')
  run_gate
  assert_eq "$GATE_RC" 4 "the cap is read against the whole array, not the files in it"
}

# --- review round 5: the list is not the file set, and the range is read once ------------------
# The repository's workflow list is built from the default branch plus whatever has run, so it is
# not an inventory of the files the merge context will hold. A workflow only the BASE carries —
# added there after the branch forked — is absent from the head and from the list, and the
# `.github/workflows/` guard over the range cannot see it either, since that range is head-side.
test_a_workflow_only_on_the_base_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOW_DIR_BASE='[".github/workflows/ci.yml", ".github/workflows/added-on-main.yml"]'
  run_gate
  assert_eq "$GATE_RC" 4 "a workflow the list does not carry was never examined"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead"
}

# The same the other way: a file only the head carries. The range guard already refuses this when
# the range shows it, and this is the belt to that brace — the range is capped, and a file added
# before the cap's window is still a file nothing examined.
test_a_workflow_only_on_the_head_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOW_DIR_HEAD='[".github/workflows/ci.yml", ".github/workflows/added-on-branch.yml"]'
  run_gate
  assert_eq "$GATE_RC" 4 "a file at the head that the list does not carry was never examined"
}

# Every workflow asks its own filter about the SAME range, so the range is read once and not once
# per workflow. At the supported limits the old shape was ~2100 requests per attempt, repeated
# every polling round inside the grace — which could turn the gate UNKNOWN on rate limits for
# exactly the heads this is meant to settle.
test_the_range_is_read_once_for_every_workflow() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOWS_JSON=$(jq -cn '{workflows:[{id:1,name:"ci",state:"active"},
                                       {id:2,name:"docs",state:"active"}]}')
  COMPARE_COMMITS=$(jq -cn --arg h "$HEAD_SHA" '["2222222222222222222222222222222222222222", $h]')
  run_gate
  assert_eq "$GATE_RC" 0 "two workflows, both filtered, still settle"
  # One compare for the merge base, one for the range, and one read per commit in it — whatever
  # the number of workflows.
  assert_eq "$(grep -c "compare/" "$REQUEST_LOG")" 2 "the range is compared once, not once per workflow"
  assert_eq "$(grep -cE "/commits/[0-9a-f]+\\?per_page=100$" "$REQUEST_LOG")" 2 \
    "each commit's files are read once, whatever the number of workflows"
}

# One page of 100 on the provider sample too: a large Actions matrix can fill it while the
# third-party provider this is looking for sits on the next page, which would read as exactly the
# answer that settles a head wrongly.
test_a_truncated_provider_sample_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  SAMPLE_CHECKS_TOTAL=2 # one row served, two claimed
  run_gate
  assert_eq "$GATE_RC" 4 "a page is not the sample"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead"
}

# One page of 100, and a repository with more workflows than that would have the later ones
# silently left out — the ones that CAN run for this head, while the ones read say they cannot.
test_a_truncated_workflow_list_keeps_the_head_waiting() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  WORKFLOW_TOTAL=2 # one row served, two claimed: a page, not the list
  run_gate
  assert_eq "$GATE_RC" 4 "a truncated workflow list is not a list of this repository's workflows"
  assert_contains "$GATE_OUTPUT" "creation grace" "the grace answers instead"
}

# A run that EXISTS is never explained by a filter: it was created, so the filter did not stop it,
# and only that run can answer for it. The question is not even asked.
test_a_head_with_a_run_never_consults_the_filter() {
  reset_fixture
  COMMIT_AGE=5
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","conclusion":null}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "an in-flight run is a verdict on its way"
  assert_eq "$(grep -c "compare/" "$REQUEST_LOG")" 0 \
    "with a run in hand there is nothing for a filter to explain"
}

# Past the grace the absence is already the verdict, so the reads the recognition would make buy
# nothing and are not made.
test_a_head_past_the_grace_never_consults_the_filter() {
  reset_fixture
  COMMIT_AGE=1800
  WORKFLOW_YAML="$DOCS_IGNORED_YAML"
  run_gate
  assert_eq "$GATE_RC" 0 "past the grace the clock has already settled it"
  assert_contains "$GATE_OUTPUT" "past the" "and says so on the clock's own terms"
  assert_eq "$(grep -c "compare/" "$REQUEST_LOG")" 0 "no read is spent on an answer already given"
}

# The advisory list is the same list in both directions: the review app's own run must not hold a
# build wait open.
test_advisory_run_does_not_hold_the_gate() {
  reset_fixture
  COMMIT_AGE=1800
  RUNS_SEQ=("$(runs_json '[{"name":"claude","status":"in_progress","conclusion":null}]')")
  run_gate
  assert_eq "$GATE_RC" 0 "an in-flight advisory run is not a build signal on the way"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "an advisory-only run should still read as absence"
}

# A failed second read is UNKNOWN, like every other failed read on this path — the one thing it
# must not become is a reassuring exit 0.
test_unreadable_run_list_is_unknown() {
  reset_fixture
  COMMIT_AGE=1800
  FAIL_ENDPOINT="*actions/runs*"
  run_gate
  assert_eq "$GATE_RC" 3 "an unreadable run list is unknown"
  assert_contains "$GATE_OUTPUT" "UNKNOWN" "an unreadable run list should say UNKNOWN"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "an unread absence must not print ABSENT"
}

test_unreadable_push_time_is_unknown() {
  reset_fixture
  PR_UPDATED_AGE=""
  FAIL_ENDPOINT="repos/$REPO/commits/$HEAD_SHA"
  run_gate
  assert_eq "$GATE_RC" 3 "with both clocks gone the absence is undecidable"
  assert_contains "$GATE_OUTPUT" "UNKNOWN" "an unreadable push time should say UNKNOWN"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "an undecidable absence must not print ABSENT"
}

# Green checks over a finished, judged run list are green — and the head's age is nobody's
# business then: run rows for one event are created together, so a head showing a check has had
# its rows created, and holding every fresh green head for the grace would buy nothing.
test_green_over_finished_runs_is_green() {
  reset_fixture
  COMMIT_AGE=5
  PR_UPDATED_AGE=5
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  run_gate
  assert_eq "$GATE_RC" 0 "green checks over a finished run list are green"
  assert_contains "$GATE_OUTPUT" "green — 1 build checks passed" "green should headline green"
}

# Round 2 of the review of ludics-lite#38, P1: one workflow's green check says nothing about a
# SIBLING workflow whose run is queued and has yet to create its own.
test_green_over_a_queued_sibling_is_not_green() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"a","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"a","status":"completed","conclusion":"success"},
                           {"name":"b","status":"queued","conclusion":null}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "a queued sibling run leaves the head unjudged"
  assert_contains "$GATE_OUTPUT" "NO VERDICT YET" "the sibling should headline no verdict"
  assert_contains "$GATE_OUTPUT" "1 build check(s) have passed so far" \
    "the line should still say what passed"
  assert_not_contains "$GATE_OUTPUT" "green — " "a queued sibling must not read as green"
}

# Round 2, P1: a workflow that fails before its jobs start leaves no check run to be red. The check
# list cannot show it, so the run list has to.
test_checkless_red_run_is_red() {
  local concl
  for concl in startup_failure failure timed_out; do
    reset_fixture
    RUNS_SEQ=("$(runs_json "$(jq -cn --arg c "$concl" \
      '[{name:"ci", status:"completed", conclusion:$c}]')")")
    run_gate
    assert_eq "$GATE_RC" 1 "a checkless $concl run is a red build signal"
    assert_contains "$GATE_OUTPUT" ": RED" "a checkless $concl run should headline RED"
    assert_contains "$GATE_OUTPUT" "ci ($concl)" "the red run should be named"
    assert_not_contains "$GATE_OUTPUT" ": ABSENT" "a red run must not print ABSENT"
  done
}

# ... and it outranks a green check on the same head, for the same reason: nothing in the check
# list can carry that run's failure.
test_checkless_red_run_outranks_a_green_check() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"a","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"a","status":"completed","conclusion":"success"},
                           {"name":"b","status":"completed","conclusion":"startup_failure"}]')")
  run_gate
  assert_eq "$GATE_RC" 1 "a checkless red sibling is red, not green"
  assert_contains "$GATE_OUTPUT" "b (startup_failure)" "the red sibling should be named"
}

# A red in the check list is a verdict the fold already has; the run list adds nothing to it.
test_red_checks_never_consult_the_run_list() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"failure","html_url":"u"}]')")
  run_gate
  assert_eq "$GATE_RC" 1 "a failed check is red"
  assert_contains "$GATE_OUTPUT" "RED" "red should headline RED"
  assert_not_contains "$(cat "$REQUEST_LOG")" "actions/runs" \
    "a red check list should not need the run list"
}

# Round 3 of the review, P1: a pending or cancelled check on one workflow while a sibling has
# already concluded red without producing a check. Reporting 4 there would let --allow-no-verdict
# merge a failed head without facing the red-build --override.
test_checkless_red_run_outranks_a_pending_check() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"a","conclusion":null,"html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"a","status":"in_progress","conclusion":null},
                           {"name":"b","status":"completed","conclusion":"startup_failure"}]')")
  run_gate
  assert_eq "$GATE_RC" 1 "a checkless red sibling outranks a still-running check"
  assert_contains "$GATE_OUTPUT" ": RED" "the pending fold should still headline RED"
  assert_contains "$GATE_OUTPUT" "b (startup_failure)" "the red sibling should be named"
}

test_checkless_red_run_outranks_a_stopped_check() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"a","conclusion":"cancelled","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"a","status":"completed","conclusion":"cancelled"},
                           {"name":"b","status":"completed","conclusion":"failure"}]')")
  run_gate
  assert_eq "$GATE_RC" 1 "a checkless red sibling outranks a stopped-not-judged fold"
  assert_contains "$GATE_OUTPUT" "b (failure)" "the red sibling should be named"
}

# An unread run list cannot rule out such a red, so even a plainly pending fold is UNKNOWN rather
# than the milder 4 it could have claimed on its own.
test_pending_with_an_unreadable_run_list_is_unknown() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"a","conclusion":null,"html_url":"u"}]')")
  FAIL_ENDPOINT="*actions/runs*"
  run_gate
  assert_eq "$GATE_RC" 3 "an unread run list under a pending fold is unknown"
  assert_contains "$GATE_OUTPUT" "UNKNOWN" "it should say UNKNOWN"
}

# Round 3, P1: build_checks accepts every provider's check runs, so an early non-Actions green
# proves nothing about whether Actions has created its rows.
test_non_actions_check_without_runs_keeps_the_grace() {
  reset_fixture
  COMMIT_AGE=20
  PR_UPDATED_AGE=20
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"codecov","conclusion":"success","html_url":"u"}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "a green app check with no Actions run yet is not a build verdict"
  assert_contains "$GATE_OUTPUT" "run-creation grace" "the hold should name the grace"
  assert_not_contains "$GATE_OUTPUT" "green — " "an unbacked green must not read as green"
}

test_non_actions_check_past_the_grace_is_green() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"codecov","conclusion":"success","html_url":"u"}]')")
  run_gate
  assert_eq "$GATE_RC" 0 "past the grace the check fold's own verdict stands"
  assert_contains "$GATE_OUTPUT" "green — 1 build checks passed" "green should headline green"
}

# Round 3, P2: several runs of ONE workflow at one head — a queued invocation cancelled, then a
# fresh one. Only the newest counts, as `filter=latest` does for the check list.
test_superseded_stopped_run_does_not_hold() {
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"workflow_id":7,"name":"ci","status":"completed","conclusion":"success"},
                           {"workflow_id":7,"name":"ci","status":"completed","conclusion":"cancelled"}]')")
  run_gate
  assert_eq "$GATE_RC" 0 "a superseded cancelled run must not park the gate at no-verdict"
  assert_not_contains "$GATE_OUTPUT" "stopped-not-judged" \
    "the superseded row should not be the one classified"
}

test_superseded_red_run_does_not_stay_red() {
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"workflow_id":7,"name":"ci","status":"completed","conclusion":"success"},
                           {"workflow_id":7,"name":"ci","status":"completed","conclusion":"failure"}]')")
  run_gate
  assert_eq "$GATE_RC" 0 "a superseded failure must not hold the gate red"
  assert_not_contains "$GATE_OUTPUT" ": RED" "the superseded row should not be the one classified"
}

test_newest_run_of_a_workflow_still_counts() {
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"workflow_id":7,"name":"ci","status":"completed","conclusion":"failure"},
                           {"workflow_id":7,"name":"ci","status":"completed","conclusion":"success"}]')")
  run_gate
  assert_eq "$GATE_RC" 1 "the newest run of a workflow is the one that counts"
  assert_contains "$GATE_OUTPUT" "ci (failure)" "the newest row should be the one classified"
}

# ludics-lite#70: two runs of ONE workflow-and-event key created in the SAME second. Their order
# in the feed is documented nowhere and no fixture could encode it, so the fold does not take it:
# it sorts on (created_at desc, id desc), and the tie goes to the higher run id — the later
# allocation. Both orientations are here and they disagree about the verdict, which is what makes
# the claim able to fail: a fold that kept the feed's first row would answer each of them the
# wrong way round, and one that simply dropped a red twin would answer the second one wrong.
test_same_second_tie_prefers_the_higher_run_id() {
  local same=2026-01-01T00:00:00Z
  reset_fixture
  RUNS_SEQ=("$(runs_json "$(jq -cn --arg t "$same" '[
    {id:101, workflow_id:7, created_at:$t, name:"ci", status:"completed", conclusion:"failure"},
    {id:202, workflow_id:7, created_at:$t, name:"ci", status:"completed", conclusion:"success"}]')")")
  run_gate
  assert_eq "$GATE_RC" 0 "the higher run id wins the tie, so the lower-id failure is superseded"
  assert_not_contains "$GATE_OUTPUT" ": RED" "the lower-id row must not be the one classified"
  assert_contains "$GATE_OUTPUT" "1 workflow run(s) for this head finished" \
    "the tied rows should fold to one run, not two"
  # The control, and the reason this is not just "a red twin is always dropped": with the ids the
  # other way up — the feed order unchanged — the winner is the red one, and the gate must say so.
  reset_fixture
  RUNS_SEQ=("$(runs_json "$(jq -cn --arg t "$same" '[
    {id:101, workflow_id:7, created_at:$t, name:"ci", status:"completed", conclusion:"success"},
    {id:202, workflow_id:7, created_at:$t, name:"ci", status:"completed", conclusion:"failure"}]')")")
  run_gate
  assert_eq "$GATE_RC" 1 "the higher run id wins the tie the other way up too"
  assert_contains "$GATE_OUTPUT" "ci (failure)" "the higher-id row should be the one classified"
}

# Round 3, P2: a committer date in the future (clock skew, an explicit GIT_COMMITTER_DATE) is the
# newest timestamp there is, and its age is unreadable. The PR clock must still decide.
test_future_commit_date_falls_back_to_the_pr_clock() {
  reset_fixture
  COMMIT_AGE=-86400
  PR_UPDATED_AGE=7200
  run_gate
  assert_eq "$GATE_RC" 0 "a future commit date must not block the absence verdict"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "the PR clock should carry it past the grace"
}

test_future_commit_date_still_holds_a_fresh_pr() {
  reset_fixture
  COMMIT_AGE=-86400
  PR_UPDATED_AGE=20
  run_gate
  assert_eq "$GATE_RC" 4 "a fresh PR clock still holds under a future commit date"
  assert_contains "$GATE_OUTPUT" "run-creation grace" "the hold should name the grace"
}

# Round 2, P2: a head with a long re-run history can push a queued run off the first page.
test_run_lookup_is_paginated() {
  reset_fixture
  run_gate
  assert_contains "$(cat "$PAGINATE_LOG")" "actions/runs" \
    "the run lookup should ask for every page"
}

# --wait must hold through the not-created-yet window and then read the verdict that appears,
# which is the whole point of backgrounding it.
test_wait_holds_until_the_checks_appear() {
  reset_fixture
  COMMIT_AGE=10
  retune CHECKS_HEARTBEAT=0
  CHECK_RUNS_SEQ=(
    "$(check_runs_json '[]')"
    "$(check_runs_json '[]')"
    "$(check_runs_json '[{"name":"ci","conclusion":"failure","html_url":"u"}]')"
  )
  RUNS_SEQ=(
    "$(runs_json '[]')"
    "$(runs_json '[{"name":"ci","status":"in_progress"}]')"
  )
  run_gate 30
  assert_eq "$GATE_RC" 1 "the wait should end on the red that appeared"
  assert_contains "$GATE_OUTPUT" "RED" "the verdict that appeared should be reported"
  assert_contains "$GATE_OUTPUT" "still waiting" "the hold should heartbeat"
  assert_contains "$GATE_OUTPUT" "creation grace" \
    "the heartbeat should say what it is waiting for, not '0 check(s) running'"
  assert_not_contains "$GATE_OUTPUT" "0 check(s) running" \
    "an unstarted hold has no running checks to count"
}

# The ceiling is not a pass: a wait that runs out with the run still queued exits 4, so the merge
# gate refuses instead of merging unread.
test_wait_ceiling_with_a_queued_run_is_no_verdict() {
  reset_fixture
  COMMIT_AGE=30
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"queued"}]')")
  run_gate 2
  assert_eq "$GATE_RC" 4 "a spent ceiling over a queued run is no verdict"
  assert_contains "$GATE_OUTPUT" "NO VERDICT YET" "the ceiling should report no verdict"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "the ceiling must not turn a queued run into absence"
}

# ludics-lite#569, the issue itself: a worker wanted the verdict of one ~2-minute job while a 45-minute
# one ran beside it in the same workflow run. `--check <ERE>` judges the matching check alone, so
# its verdict lands while the slow check, and the run around both, are still running -- green and
# red alike. The same head without the selection holds the whole wait.
test_a_selected_check_settles_while_a_slow_one_runs() {
  local concl want verdict
  for concl in success failure; do
    reset_fixture
    CHECK_RUNS_SEQ=(
      "$(check_runs_json '[{"name":"torch-runner","conclusion":null,"html_url":"t"},
                           {"name":"slow-suite","conclusion":null,"html_url":"s"}]')"
      "$(check_runs_json "$(jq -cn --arg c "$concl" '[{name:"torch-runner", conclusion:$c, html_url:"t"},
                           {name:"slow-suite", conclusion:null, html_url:"s"}]')")"
    )
    RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","conclusion":null}]')")
    run_checks --wait=30 --check '^torch-runner$'
    if [ "$concl" = success ]; then want=0 verdict=green; else want=1 verdict=red; fi
    assert_eq "$GATE_RC" "$want" "a $concl selected check is the verdict while the slow one runs"
    assert_contains "$GATE_OUTPUT" "checks: verdict=$verdict" "the trailer carries the selection's verdict"
    assert_contains "$GATE_OUTPUT" "(--check '^torch-runner\$')" "the headline names the selection"
    assert_not_contains "$GATE_OUTPUT" "slow-suite" "an unselected check is not judged or listed"
  done
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"torch-runner","conclusion":"success","html_url":"t"},
                                       {"name":"slow-suite","conclusion":null,"html_url":"s"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","conclusion":null}]')")
  run_checks --wait=2
  assert_eq "$GATE_RC" 4 "without the selection the slow check holds the head"
}

# ludics-lite#569: an hour on "1 check(s) running" read as a stall. The heartbeat names the
# check(s) it is still waiting on, a bounded list, and so does the no-verdict headline.
test_the_progress_line_names_the_running_checks() {
  reset_fixture
  retune CHECKS_HEARTBEAT=0
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"lint","conclusion":"success","html_url":"l"},
                                       {"name":"build (macos-latest)","conclusion":null,"html_url":"m"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","conclusion":null}]')")
  run_checks --wait=2
  assert_eq "$GATE_RC" 4 "a check still running at the ceiling is no verdict"
  assert_contains "$GATE_OUTPUT" "(1 check(s) running: build (macos-latest))" \
    "the heartbeat names the running check"
  assert_contains "$GATE_OUTPUT" "NO VERDICT YET — 1 check(s) still running: build (macos-latest)" \
    "the no-verdict headline names it too"
  reset_fixture
  retune CHECKS_HEARTBEAT=0
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"a","conclusion":null},{"name":"b","conclusion":null},
                                       {"name":"c","conclusion":null},{"name":"d","conclusion":null},
                                       {"name":"e","conclusion":null}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","conclusion":null}]')")
  run_checks --wait=2
  assert_contains "$GATE_OUTPUT" "5 check(s) running: a, b, c (+2 more)" "the list is bounded"
}

# ludics-lite#569: a selection that matches nothing is a refusal, never green and never ABSENT --
# once no matching check can still appear. While a run is in flight it may yet create one, so the
# selection holds like any unstarted head.
test_a_selection_matching_nothing_is_refused() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"lint","conclusion":"success","html_url":"l"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  run_checks --check '^torch'
  assert_eq "$GATE_RC" 2 "a finished head with no matching check refuses"
  assert_contains "$GATE_OUTPUT" "REFUSING: no check run of" "the refusal says why"
  assert_contains "$GATE_OUTPUT" "checks: verdict=unknown" "the trailer is unknown, never green"
  # Review round 1, P2: a run that STOPPED is finished for a selection -- only a re-run creates
  # checks for it -- so a selection matching nothing refuses rather than spending the wait.
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"cancelled"}]')")
  run_checks --wait=30 --check '^torch'
  assert_eq "$GATE_RC" 2 "a stopped run with no matching check refuses"
  assert_contains "$GATE_OUTPUT" "re-run the workflow" "the refusal carries the run's reason"
  assert_not_contains "$GATE_OUTPUT" "still waiting" "and spends none of the wait"
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"lint","conclusion":"success","html_url":"l"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","conclusion":null}]')")
  run_checks --check '^torch'
  assert_eq "$GATE_RC" 4 "a run in flight may still create the check: no verdict yet"
  assert_contains "$GATE_OUTPUT" "no check run matches --check '^torch' yet" "the hold names the selection"
  # The usage errors: an ERE grep refuses, an empty one, two of them, and merge's subset.
  for bad in "--check=[" "--check=" "--check"; do
    reset_fixture
    run_checks "$bad"
    assert_eq "$GATE_RC" 2 "checks $bad is a usage error"
  done
  run_checks --check a --check b
  assert_eq "$GATE_RC" 2 "a second --check is a usage error"
  run_merge --check a
  assert_eq "$MERGE_RC" 2 "merge takes no --check"
  assert_contains "$MERGE_OUTPUT" "never a subset" "merge says why"
  assert_eq "$MERGE_CALLS" "" "and merges nothing"
}

# A selection names its checks itself: an advisory check it matches is waited for, and the
# repository's advisory file is not read at all.
test_a_selection_waits_on_an_advisory_check_it_names() {
  reset_fixture
  ADVISORY_HTTP=500
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"claude","conclusion":"failure","html_url":"c"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  run_checks --check '^claude$'
  assert_eq "$GATE_RC" 1 "the advisory check the selection names is judged"
  assert_not_contains "$(cat "$REQUEST_LOG")" "ship-pr-advisory-checks" "the advisory file is not read"
}

# Round 1 of the review of ludics-lite#38, P1: a run cancelled while still QUEUED reports
# `completed` with no check runs behind it. Stopped is not judged anywhere else in this file, and
# it is not absence here.
test_cancelled_run_is_not_absent() {
  local concl
  for concl in cancelled stale action_required; do
    reset_fixture
    RUNS_SEQ=("$(runs_json "$(jq -cn --arg c "$concl" \
      '[{name:"ci", status:"completed", conclusion:$c}]')")")
    run_gate
    assert_eq "$GATE_RC" 4 "a $concl run left no verdict, and no absence either"
    assert_contains "$GATE_OUTPUT" "stopped-not-judged" "the reason should name what happened"
    assert_contains "$GATE_OUTPUT" "re-run the workflow" "the remedy should be named"
    assert_not_contains "$GATE_OUTPUT" ": ABSENT" "a $concl run must not print ABSENT"
  done
}

# Round 1 of the same review, P1: one finished workflow is evidence about one workflow. A repo
# where A finishes with every job skipped while B's run row is not created yet must still hold.
test_one_finished_run_does_not_bypass_the_grace() {
  reset_fixture
  COMMIT_AGE=30
  PR_UPDATED_AGE=30
  RUNS_SEQ=("$(runs_json '[{"name":"a","status":"completed","conclusion":"skipped"}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "a finished run inside the grace does not settle the whole head"
  assert_contains "$GATE_OUTPUT" "run-creation grace" "the hold should name the grace"
  assert_contains "$GATE_OUTPUT" "1 workflow run(s) for this head finished" \
    "the hold should still report what was seen"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" \
    "a finished run inside the grace must not print ABSENT"
}

# Round 1 of the same review, P1: an old commit pushed just now has a committer date older than any
# grace. The PR's updated_at moves with the push, so the fresher of the two clocks wins.
test_old_commit_freshly_pushed_waits() {
  reset_fixture
  COMMIT_AGE=86400
  PR_UPDATED_AGE=20
  run_gate
  assert_eq "$GATE_RC" 4 "a day-old commit pushed 20s ago is inside the creation window"
  assert_contains "$GATE_OUTPUT" "in place at most 2" \
    "the fresher clock (~20s) should be the one reported, not the day-old commit date"
  assert_not_contains "$GATE_OUTPUT" "in place at most 1440m" \
    "the committer date must not be the clock here"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" \
    "a freshly pushed old commit must not print ABSENT"
}

# ... and the converse: a stale PR whose head really has no CI still reaches its verdict.
test_old_commit_and_quiet_pr_is_absent() {
  reset_fixture
  COMMIT_AGE=86400
  PR_UPDATED_AGE=7200
  run_gate
  assert_eq "$GATE_RC" 0 "an old head on a quiet PR is the absence verdict"
  assert_contains "$GATE_OUTPUT" ": ABSENT" "a quiet old head should print ABSENT"
}

# The push clock has two sources, and only losing BOTH is unknown.
test_unreadable_commit_still_decides_on_the_pr_clock() {
  reset_fixture
  PR_UPDATED_AGE=20
  FAIL_ENDPOINT="repos/$REPO/commits/$HEAD_SHA"
  run_gate
  assert_eq "$GATE_RC" 4 "the PR's own clock is enough to hold"
  assert_contains "$GATE_OUTPUT" "run-creation grace" "the hold should name the grace"
}

# Round 4 of the review, P1: one workflow file triggered on both `push` and `pull_request`
# produces two INDEPENDENT runs at the same head, sharing a workflow id. Folding them together
# hides a queued invocation behind a newer one that finished.
test_two_events_of_one_workflow_are_two_runs() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"workflow_id":7,"event":"pull_request","name":"ci",
                            "status":"completed","conclusion":"success"},
                           {"workflow_id":7,"event":"push","name":"ci",
                            "status":"queued","conclusion":null}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "the queued push run is not superseded by the pull_request run"
  assert_contains "$GATE_OUTPUT" "NO VERDICT YET" "the queued invocation should hold the gate"
}

# Round 5 of the review, P2: two independent invocations of one workflow at one head share a
# workflow id AND an event, so no key tells them apart — but a queued row has not been superseded
# by anything, and only finished rows compete to be the answer.
test_queued_invocation_survives_a_finished_twin() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"id":201,"workflow_id":7,"event":"workflow_dispatch","name":"ci",
                            "status":"completed","conclusion":"success"},
                           {"id":202,"workflow_id":7,"event":"workflow_dispatch","name":"ci",
                            "status":"queued","conclusion":null}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "a queued invocation is not superseded by a finished twin"
  assert_contains "$GATE_OUTPUT" "NO VERDICT YET" "the queued invocation should hold the gate"
}

# Round 4, P2: a stopped check under a queued run used to break the wait loop at once.
test_stopped_checks_with_a_queued_run_keep_waiting() {
  reset_fixture
  retune CHECKS_HEARTBEAT=0
  CHECK_RUNS_SEQ=(
    "$(check_runs_json '[{"name":"a","conclusion":"cancelled","html_url":"u"}]')"
    "$(check_runs_json '[{"name":"a","conclusion":"cancelled","html_url":"u"},
                         {"name":"b","conclusion":"failure","html_url":"u"}]')"
  )
  RUNS_SEQ=("$(runs_json '[{"name":"a","status":"completed","conclusion":"cancelled"},
                           {"name":"b","status":"queued","conclusion":null}]')")
  run_gate 30
  assert_eq "$GATE_RC" 1 "the wait should have stayed for the queued run's verdict"
  assert_contains "$GATE_OUTPUT" "still waiting" "a mixed fold over a queued run should wait"
}

# Round 4, P2: `completed` with no conclusion recorded yet is not judged.
test_completed_run_without_a_conclusion_is_unjudged() {
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":null}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "a completed run with no conclusion has judged nothing"
  assert_contains "$GATE_OUTPUT" "no conclusion yet" "the reason should say so"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "it must not settle as absence"
}

# Round 4, P1: the advisory list is a deny-list of CHECK names, and build_checks applies it per
# check run. A non-advisory workflow whose only failing job is advisory must not come back as red
# through the run-level conclusion.
test_advisory_job_failure_is_not_a_red_run() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"build","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"failure"}]')")
  JOBS_JSON=$(jobs_json '[{"name":"build","conclusion":"success"},
                          {"name":"claude","conclusion":"failure"}]')
  run_gate
  assert_eq "$GATE_RC" 0 "a red explained entirely by an advisory job is not a build red"
  assert_contains "$GATE_OUTPUT" "green — 1 build checks passed" "the check fold's verdict stands"
}

test_non_advisory_job_failure_is_a_red_run() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"lint","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"failure"}]')")
  JOBS_JSON=$(jobs_json '[{"name":"lint","conclusion":"success"},
                          {"name":"build","conclusion":"failure"}]')
  run_gate
  assert_eq "$GATE_RC" 1 "a red job the gate does not ignore is still red"
  assert_contains "$GATE_OUTPUT" "ci (failure)" "the red run should be named"
}

# ludics-lite#392: what merge --override hands the gate. A waived leg's run concludes `failure` once
# its sibling finishes, and its job is the waived check by name, so the run's red is explained, as
# an advisory job's is; the verdict is the waiver's, not a run-level red nobody named. The second
# half is the control: the same leg with no waiver is a plain red at the first read. Read through
# `merge --override`, the one command that hands the gate a waiver: a waived red is merged over
# (and announced), any other red refuses with exit 1.
WAIVE_WHY='the ubuntu red is a pidfile race in an unrelated benchmark test'
test_a_waived_leg_does_not_redden_its_run() {
  local suite
  # The job is joined to its check through the run's check suite, so the same job name in ANOTHER
  # suite explains nothing: with the run in suite 22, its red stands (review round 1).
  for suite in 11 22; do
    reset_fixture
    CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ubuntu","conclusion":"failure","html_url":"u","check_suite":{"id":11}},
                                          {"name":"macos","conclusion":null,"html_url":"m","check_suite":{"id":11}}]')"
      "$(check_runs_json '[{"name":"ubuntu","conclusion":"failure","html_url":"u","check_suite":{"id":11}},
                           {"name":"macos","conclusion":"success","html_url":"m","check_suite":{"id":11}}]')")
    RUNS_SEQ=("$(runs_json "$(jq -cn --argjson s "$suite" '[{name:"ci",status:"in_progress",check_suite_id:$s}]')")"
      "$(runs_json "$(jq -cn --argjson s "$suite" '[{name:"ci",status:"completed",conclusion:"failure",check_suite_id:$s}]')")")
    JOBS_JSON=$(jobs_json '[{"name":"ubuntu","conclusion":"failure"},
                            {"name":"macos","conclusion":"success"}]')
    run_merge --wait=30 --override "$WAIVE_WHY"
    assert_contains "$MERGE_OUTPUT" "ubuntu (failure — WAIVED" "the waived check is marked (run in suite $suite)"
    if [ "$suite" = 11 ]; then
      assert_eq "$MERGE_RC" 0 "the only red is the waived one, so the override merges ($MERGE_OUTPUT)"
      assert_contains "$MERGE_OUTPUT" ": RED, WAIVED" "the only red is the one waived at the first read"
      assert_not_contains "$MERGE_OUTPUT" "concluded red with no build check" "its run is not a red of its own"
      assert_contains "$MERGE_OUTPUT" "OVERRIDE: merging $REPO#7 over a RED build signal — $WAIVE_WHY" \
        "and the merge over it is announced"
    else
      assert_eq "$MERGE_RC" 1 "a waived red is still a red, and this run's is not waived ($MERGE_OUTPUT)"
      assert_contains "$MERGE_OUTPUT" "concluded red with no build check" "another suite's job name explains nothing"
      assert_eq "$MERGE_CALLS" "" "no merge call is made"
    fi
  done
  # A poll whose check list momentarily lacks the waived row still reads the run's red: it is a
  # waived red, never a green (review round 5) — --require-green and the OVERRIDE record rest on it.
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ubuntu","conclusion":"failure","html_url":"u","check_suite":{"id":11}},
                                        {"name":"macos","conclusion":null,"html_url":"m","check_suite":{"id":11}}]')"
    "$(check_runs_json '[{"name":"macos","conclusion":"success","html_url":"m","check_suite":{"id":11}}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","check_suite_id":11}]')"
    "$(runs_json '[{"name":"ci","status":"completed","conclusion":"failure","check_suite_id":11}]')")
  JOBS_JSON=$(jobs_json '[{"name":"ubuntu","conclusion":"failure"},
                          {"name":"macos","conclusion":"success"}]')
  run_merge --wait=30 --override "$WAIVE_WHY"
  assert_eq "$MERGE_RC" 0 "the run's red is the waived one ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" ": RED, WAIVED" "a waived red, not a green"
  assert_contains "$MERGE_OUTPUT" "workflow run ci (red through a check above that is WAIVED)" "naming the run"
  assert_not_contains "$MERGE_OUTPUT" ": green" "never a green"
  assert_contains "$MERGE_OUTPUT" "OVERRIDE: merging" "so the merge goes over a red, and says so"
  # ...which --require-green takes as a verdict READ since ludics-lite#623 (a coordinated wave's
  # close-out over its owned base red): the merge still goes over a red, and still says so.
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ubuntu","conclusion":"failure","html_url":"u","check_suite":{"id":11}},
                                        {"name":"macos","conclusion":null,"html_url":"m","check_suite":{"id":11}}]')"
    "$(check_runs_json '[{"name":"macos","conclusion":"success","html_url":"m","check_suite":{"id":11}}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","check_suite_id":11}]')"
    "$(runs_json '[{"name":"ci","status":"completed","conclusion":"failure","check_suite_id":11}]')")
  JOBS_JSON=$(jobs_json '[{"name":"ubuntu","conclusion":"failure"},
                          {"name":"macos","conclusion":"success"}]')
  run_merge --wait=30 --override "$WAIVE_WHY" --require-green
  assert_eq "$MERGE_RC" 0 "a close-out merge takes the waived red as read ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" ": RED, WAIVED" "still a waived red, not a green"
  assert_contains "$MERGE_OUTPUT" "OVERRIDE: merging" "and the merge over it is announced"
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ubuntu","conclusion":"failure","html_url":"u"},
                                        {"name":"macos","conclusion":null,"html_url":"m"}]')")
  run_gate 30
  assert_eq "$GATE_RC" 1 "without a waiver the red is a verdict at once"
  assert_contains "$GATE_OUTPUT" ": RED — 1 of 2" "and it headlines as a plain red"
}

# A run-level red (no check to show for it) at the first read is waived by the run's name; one that
# appears after it is not. Nothing here explains a run from its jobs: the job list is empty, the
# startup_failure shape.
test_a_run_level_red_is_waived_only_from_the_first_read() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"build","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"pages","status":"completed","conclusion":"startup_failure"},
                           {"name":"ci","status":"completed","conclusion":"success"}]')")
  run_merge --override "$WAIVE_WHY"
  assert_eq "$MERGE_RC" 0 "a waived run-level red is merged over ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" ": RED, WAIVED" "the waiver covers it"
  assert_contains "$MERGE_OUTPUT" "workflow run pages (no build check behind it — WAIVED" "and names it"
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"build","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"pages","status":"completed","conclusion":"startup_failure"},
                           {"name":"ci","status":"in_progress"}]')"
    "$(runs_json '[{"name":"pages","status":"completed","conclusion":"startup_failure"},
                   {"name":"ci","status":"completed","conclusion":"failure"}]')")
  run_merge --wait=30 --override "$WAIVE_WHY"
  assert_eq "$MERGE_RC" 1 "a run that went red during the wait is a red ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" ": RED — 1 workflow run(s)" "a plain run-level red, not a waived one"
  assert_contains "$MERGE_OUTPUT" "ci (failure)" "naming the run that was not waived"
  assert_eq "$MERGE_CALLS" "" "no merge call is made"
  # The waiver is the INVOCATION's, not its workflow's: a second dispatch of the same workflow and
  # event, running at the first read and red after it, is a run nobody read (review round 2).
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"build","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"id":202,"workflow_id":7,"event":"workflow_dispatch","name":"pages","status":"in_progress"},
                           {"id":201,"workflow_id":7,"event":"workflow_dispatch","name":"pages","status":"completed","conclusion":"startup_failure"}]')"
    "$(runs_json '[{"id":202,"workflow_id":7,"event":"workflow_dispatch","name":"pages","status":"completed","conclusion":"startup_failure"},
                   {"id":201,"workflow_id":7,"event":"workflow_dispatch","name":"pages","status":"completed","conclusion":"startup_failure"}]')")
  run_merge --wait=30 --override "$WAIVE_WHY"
  assert_eq "$MERGE_RC" 1 "the later dispatch's red is a red ($MERGE_OUTPUT)"
  assert_contains "$MERGE_OUTPUT" ": RED — 1 workflow run(s)" "not waived by the earlier dispatch's red"
  assert_eq "$MERGE_CALLS" "" "no merge call is made"
}

# A red this cannot disprove stands: no jobs at all is the startup_failure shape, and an
# unreadable job list is not evidence of innocence.
test_unreadable_jobs_keep_the_red() {
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"failure"}]')")
  FAIL_ENDPOINT="*/jobs?per_page=100"
  run_gate
  assert_eq "$GATE_RC" 1 "an unreadable job list leaves the red standing"
  assert_contains "$GATE_OUTPUT" ": RED" "the red should still headline"
}

# --- an in-flight run whose only unfinished jobs are advisory (ludics-lite#500) -----------------
# `macos` stands for the advisory leg a repository's advisory list names; build_checks
# drops its check run, so the check list below carries only the required job's. Each row's times
# are given as AGES in seconds (created_ago, completed_ago; an absent age is a null field), since
# what run_inflight_is_advisory_only weighs is how long the run's job list has been still.
inflight_jobs() {
  jq -cn --argjson jobs "$1" \
    '{jobs: [$jobs[] | {name, conclusion: (.conclusion // null),
      created_at: (if .created_ago == null then null else ((now - .created_ago) | floor | todateiso8601) end),
      completed_at: (if .completed_ago == null then null else ((now - .completed_ago) | floor | todateiso8601) end)}]}'
}
advisory_inflight_fixture() { # <jobs, as inflight_jobs takes them>
  reset_fixture
  retune BUILD_ADVISORY='^(claude|macos)$'
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"build","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress","conclusion":null}]')")
  JOBS_JSON=$(inflight_jobs "$1")
}

# The issue itself: every required job finished green a while ago and only the advisory leg is
# still running, so `--wait` ends on the green instead of sitting out the advisory runner queue —
# and the report says which run it did not wait for.
test_a_run_with_only_advisory_jobs_left_does_not_hold() {
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":600},
                              {"name":"macos","created_ago":900}]'
  run_gate 30
  assert_eq "$GATE_RC" 0 "an in-flight run whose only unfinished job is advisory has no verdict on its way"
  assert_contains "$GATE_OUTPUT" "green — 1 build checks passed" "the check fold's verdict stands"
  assert_contains "$GATE_OUTPUT" "1 of them still running, but only advisory jobs" \
    "the report names the run it did not wait for"
  assert_eq "$(grep -c "actions/runs/101/jobs" "$REQUEST_LOG")" 1 "one jobs read for the one in-flight run"
}

# A required job the check list does not show yet (its check run lags its job) keeps the run held,
# however advisory the rest of it is.
test_a_pending_required_job_holds_its_run() {
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":600},
                              {"name":"test","created_ago":900},
                              {"name":"macos","created_ago":900}]'
  run_gate
  assert_eq "$GATE_RC" 4 "a required job still running is a verdict on its way"
  assert_contains "$GATE_OUTPUT" "1 workflow run(s) for this head have no conclusion yet" "the run holds"
}

# Fail closed on what the read cannot show: a run that has not created its jobs, and a read that
# did not answer, both hold — neither is evidence that only advisory work is left.
test_an_inflight_run_without_jobs_holds() {
  advisory_inflight_fixture '[]'
  run_gate
  assert_eq "$GATE_RC" 4 "a run with no jobs yet holds"
  assert_contains "$GATE_OUTPUT" "have no conclusion yet" "as a run in flight"
}

test_an_unreadable_jobs_read_holds_its_run() {
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":600},
                              {"name":"macos","created_ago":900}]'
  FAIL_ENDPOINT="*/jobs?per_page=100"
  run_gate
  assert_eq "$GATE_RC" 4 "an unread job list holds the run"
  assert_contains "$GATE_OUTPUT" "have no conclusion yet" "as a run in flight"
}

# The `needs:` race. GitHub creates a dependent job only once its dependencies finish, so in the
# instant after `build` finishes its dependents are not listed yet; a job list that changed inside
# ADVISORY_SETTLE is not taken as the run's whole job set. The control is the first case above:
# the same run with `build` finished ten minutes ago is released.
test_a_job_list_inside_the_settle_holds_its_run() {
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":5},
                              {"name":"macos","created_ago":900}]'
  run_gate
  assert_eq "$GATE_RC" 4 "a required job that has only just finished may have dependents on the way"
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":600},
                              {"name":"macos","created_ago":5}]'
  run_gate
  assert_eq "$GATE_RC" 4 "a job created inside the settle is a job list still moving"
}

# A run still in flight with NO unfinished job is between jobs, or finishing: its next job may not
# exist yet, and its row's conclusion is what settles it.
test_a_run_between_jobs_holds() {
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":600},
                              {"name":"macos","conclusion":"success","created_ago":900,"completed_ago":600}]'
  run_gate
  assert_eq "$GATE_RC" 4 "an in-flight run with nothing unfinished in its list holds"
}

# This read only ever releases. A required job that finished red or stopped, which the check list
# has not caught up with, holds the run until its row says what the run concluded.
test_a_red_or_stopped_required_job_holds_its_run() {
  local concl
  for concl in failure cancelled; do
    advisory_inflight_fixture "$(jq -cn --arg c "$concl" \
      '[{name:"build",conclusion:"success",created_ago:900,completed_ago:600},
        {name:"test",conclusion:$c,created_ago:900,completed_ago:600},
        {name:"macos",created_ago:900}]')"
    run_gate
    assert_eq "$GATE_RC" 4 "a required job that concluded $concl is not released past"
  done
}

# A job with no timestamp cannot be placed against the settle, so it proves nothing.
test_an_untimed_job_holds_its_run() {
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":600},
                              {"name":"macos"}]'
  run_gate
  assert_eq "$GATE_RC" 4 "a job with no created_at holds"
  advisory_inflight_fixture '[{"name":"build","conclusion":"success","created_ago":900},
                              {"name":"macos","created_ago":900}]'
  run_gate
  assert_eq "$GATE_RC" 4 "a finished job with no completed_at holds"
}

# A successor never inherits the observed head's checks, even when those checks passed
# or were cancelled. The unchanged sequence is the control for the additional head reads.
test_wait_superseded_head() {
  local conclusion terminal_checks
  for conclusion in success cancelled; do
    reset_fixture
    HEAD_SEQ=("$HEAD_SHA" "$HEAD_SHA" feedbeeffeedbeeffeedbeeffeedbeeffeedbeef)
    terminal_checks=$(jq -cn --arg conclusion "$conclusion" \
      '{check_runs:[{name:"ci",conclusion:$conclusion}]}')
    CHECK_RUNS_SEQ=(
      "$(check_runs_json '[{"name":"ci","status":"in_progress"}]')"
      "$terminal_checks"
    )
    RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
    run_gate 30
    assert_eq "$GATE_RC" 5 "a moved head supersedes the old $conclusion verdict"
    assert_contains "$GATE_OUTPUT" "SUPERSEDED" "the distinct outcome is named"
    assert_contains "$GATE_OUTPUT" "$HEAD_SHA" "the observed head is named"
    assert_contains "$GATE_OUTPUT" "feedbeef" "the successor is named"
    assert_eq "$(cat "$TEST_ROOT/CHECK_RUNS_SEQ.calls")" 2 "the superseded wait ends promptly"
  done
}

test_wait_unchanged_head_turns_green() {
  reset_fixture
  CHECK_RUNS_SEQ=(
    "$(check_runs_json '[{"name":"ci","status":"in_progress"}]')"
    "$(check_runs_json '[{"name":"ci","conclusion":"success"}]')"
  )
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  run_gate 30
  assert_eq "$GATE_RC" 0 "unchanged pending head settles green"
  assert_contains "$GATE_OUTPUT" "green —" "unchanged green is still reported"
}

# --- the repository's own advisory list (ludics-lite#530) ---------------------------------------
# Read through `checks`, black-box: the policy's refusals are the command's exit status and stderr,
# and the list it settles on is read off what the gate then counts. The PROBE is a head whose check
# list carries the names a list can tell apart -- `claude` (advisory by default), `macos` (advisory
# only when a list names it), `claude-nightly` and `macos-extra` (for the anchors) -- each RED, and
# a green `build` -- over one judged run. Whatever the gate lists as RED is what the list did not
# name; a head whose only reds were advisory is green.
advisory_probe() { # [<check names that are red, default: claude macos claude-nightly macos-extra>]
  local names="${*:-claude macos claude-nightly macos-extra}" rows
  rows=$(jq -cn --arg n "$names" \
    '[($n | split(" ")[] | {name: ., conclusion: "failure", html_url: ("u/" + .)}),
      {name: "build", conclusion: "success", html_url: "u/build"}]')
  CHECK_RUNS_SEQ=("$(check_runs_json "$rows")")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
}

# `checks` over the probe: ADVISORY_RC its status, ADVISORY_OUT its stdout, ADVISORY_ERR its stderr.
advisory_read() {
  set +e
  ADVISORY_OUT=$(cmd_checks 7 2>"$TEST_ROOT/advisory.err")
  ADVISORY_RC=$?
  set -e
  ADVISORY_ERR=$(cat "$TEST_ROOT/advisory.err")
}

test_no_advisory_file_keeps_the_default_list() {
  reset_fixture
  advisory_probe claude
  advisory_read
  assert_eq "$ADVISORY_RC" 0 "a 404 is a repository with no list, and the default list stands ($ADVISORY_OUT)"
  assert_contains "$ADVISORY_OUT" "green — 1 build checks passed" "so the red claude check is advisory"
  assert_eq "$ADVISORY_ERR" "" "and nothing is said about a file that is not there"
  assert_eq "$(grep -c 'contents/.github$' "$REQUEST_LOG")" 1 "the 404 is confirmed by the listing"
  reset_fixture
  advisory_probe claude
  ADVISORY_DIR=404
  ADVISORY_ROOT='["README.md"]'
  advisory_read
  assert_eq "$ADVISORY_RC" 0 "a repository with no .github, by the root listing, has no list ($ADVISORY_OUT)"
}

# A 404 is also GitHub's answer to a token without Contents access on a private repository, so
# the file counts as absent only when a listing that answered leaves it out (review of #531).
test_an_unconfirmed_404_is_not_an_absent_file() {
  reset_fixture
  ADVISORY_DIR='["workflows","ship-pr-advisory-checks"]'
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "a file the listing shows is not absent, whatever its read said"
  assert_contains "$ADVISORY_ERR" "could not be established" "and says so"
  assert_eq "$(tail -n 1 <<<"$ADVISORY_OUT")" "checks: verdict=unknown" "and judges nothing"
  reset_fixture
  ADVISORY_DIR=404
  ADVISORY_ROOT=404
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "nothing listable is no confirmation"
  reset_fixture
  ADVISORY_DIR=404
  ADVISORY_ROOT='[".github"]'
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "a .github the root lists but that reads 404 is no confirmation"
  reset_fixture
  ADVISORY_DIR=500
  advisory_read
  assert_eq "$ADVISORY_RC" 3 "a listing that did not answer is unknown"
  reset_fixture
  ADVISORY_DIR=$(jq -cn --argjson n "$CONTENTS_DIR_CAP" '[range($n) | "f\(.)"]')
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "a listing at the endpoint's cap may have left the file out"
}

test_the_advisory_file_replaces_the_list() {
  reset_fixture
  advisory_probe claude macos
  ADVISORY_BODY=$'# a comment\n\n  # an indented one\n^claude$\r\n^macos$\n\n'
  advisory_read
  assert_eq "$ADVISORY_RC" 0 "a list file is read, and it names both reds ($ADVISORY_OUT)"
  assert_contains "$ADVISORY_ERR" "advisory checks, from $REPO's .github/ship-pr-advisory-checks: ^claude\$|^macos\$" \
    "its lines are the list, joined, comments, blanks and the CR aside, and the log says where it came from"
  assert_eq "$(grep -c 'contents/.github/ship-pr-advisory-checks$' "$REQUEST_LOG")" 1 \
    "one read, of the default branch (no ref)"
  # The file REPLACES the default list: a name only the default list carries is no longer advisory.
  reset_fixture
  advisory_probe claude macos
  ADVISORY_BODY=$'^macos$\n'
  advisory_read
  assert_eq "$ADVISORY_RC" 1 "claude is not on the file's list ($ADVISORY_OUT)"
  assert_contains "$ADVISORY_OUT" "  RED      claude (failure)" "so its red counts"
  assert_not_contains "$ADVISORY_OUT" "RED      macos" "while the file's own name does not"
}

# End to end through `checks`: the in-flight run whose only unfinished job is `macos` holds under
# a list that does not name it, and is released once the repository's file does.
test_checks_reads_the_repository_list() {
  local jobs='[{"name":"build","conclusion":"success","created_ago":900,"completed_ago":600},
              {"name":"macos","created_ago":900}]'
  advisory_inflight_fixture "$jobs"
  retune BUILD_ADVISORY='^claude$'
  check_trailer 4 unjudged "NO VERDICT YET"
  advisory_inflight_fixture "$jobs"
  retune BUILD_ADVISORY='^claude$'
  ADVISORY_BODY=$'^claude$\n^macos$'
  check_trailer 0 green "green — 1 build checks passed"
}

# Fail closed: no read is taken for "no file" but a 404, and a file that is not a list of EREs is
# a configuration error rather than the default list.
test_an_advisory_file_that_cannot_be_used_refuses() {
  reset_fixture
  FAIL_ENDPOINT="*/ship-pr-advisory-checks"
  advisory_read
  assert_eq "$ADVISORY_RC" 3 "a read that did not answer is unknown, not the default list"
  assert_contains "$ADVISORY_ERR" "policy is UNKNOWN" "and says so"
  reset_fixture
  ADVISORY_HTTP=403
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "a refusal other than 404 is a configuration error"
  reset_fixture
  ADVISORY_BODY=$'# only a comment\n'
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "a file with no ERE is refused, not read as an empty list"
  reset_fixture
  ADVISORY_BODY=$'^claude$\n^(macos'
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "a line grep refuses is refused, whatever the other lines say"
  assert_contains "$ADVISORY_ERR" "not an ERE grep accepts: ^(macos" "and names the line"
  # A backreference would be renumbered by the join, so the list cannot keep it (review of #531).
  reset_fixture
  ADVISORY_BODY=$'^claude$\n^(macos)\\1$'
  advisory_read
  assert_eq "$ADVISORY_RC" 2 "a line with a backreference is refused"
  assert_contains "$ADVISORY_ERR" "backreference" "and says why"
}

# An ERE that starts with `-` is a pattern, never a grep option: GNU grep's `--help` would exit 0
# for every name (review of #531). The variable's path, which the file's grouping cannot protect.
test_an_option_shaped_advisory_ere_is_a_pattern() {
  reset_fixture
  retune ADVISORY_FROM_ENV=1 BUILD_ADVISORY='--help'
  advisory_probe build x--helpy
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"build","conclusion":"failure","html_url":"u/build"},
                                        {"name":"x--helpy","conclusion":"failure","html_url":"u/x"}]')")
  advisory_read
  assert_eq "$ADVISORY_RC" 1 "build is red, so the option-shaped ERE did not make it advisory ($ADVISORY_OUT)"
  assert_contains "$ADVISORY_OUT" "  RED      build (failure)" "build is listed red"
  assert_not_contains "$ADVISORY_OUT" "x--helpy" "and the ERE is still matched as a pattern"
}

# The list is grep's to read, as it always was: a translation of the ERE that read a pattern outside
# its own grammar as matching nothing turned an advisory red into a build red, and an advisory pass
# into a build pass -- an ABSENT head read as green (parity review of the Python port). Two readings
# both greps share that the translation missed: `\b`, and a newline, which makes each line a pattern.
docs_red_probe() {
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"github pages docs","conclusion":"failure","html_url":"u/docs"},
                                        {"name":"build","conclusion":"success","html_url":"u/build"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
}

test_the_advisory_ere_is_greps_to_read() {
  local pattern
  for pattern in '^(claude|Claude Code)$|\bdocs\b' $'^claude$\n^github pages docs$'; do
    reset_fixture
    retune ADVISORY_FROM_ENV=1 BUILD_ADVISORY="$pattern"
    docs_red_probe
    advisory_read
    assert_eq "$ADVISORY_RC" 0 "the docs red is advisory under '$pattern' ($ADVISORY_OUT)"
    assert_contains "$ADVISORY_OUT" "green — 1 build checks passed" "so build alone is the signal"
  done
}

# In the caller's locale: BSD grep refuses `[+-.]` in a UTF-8 locale and reads it in C, so the file
# holding it is refused where grep refuses it and read where grep reads it -- whichever this box's
# grep does (GNU grep may read it in both).
test_the_advisory_file_is_validated_in_the_callers_locale() {
  local loc want
  for loc in en_US.UTF-8 C; do
    want=0
    printf '' | LC_ALL="$loc" grep -Eq -- '^[+-.]$' 2>/dev/null || [ "$?" -ne 2 ] || want=2
    reset_fixture
    docs_red_probe
    ADVISORY_BODY=$'^github pages docs$\n^[+-.]$'
    LC_ALL="$loc" advisory_read
    assert_eq "$ADVISORY_RC" "$want" "LC_ALL=$loc: the file is refused exactly when grep refuses it ($ADVISORY_OUT)"
  done
}

# SHIP_PR_ADVISORY_CHECKS set when the script was sourced still wins, without a read: here the
# variable's list is the default one, so `macos`, which only the file names, stays red.
test_the_variable_wins_over_the_file() {
  reset_fixture
  retune ADVISORY_FROM_ENV=1
  advisory_probe claude macos
  ADVISORY_BODY='^(claude|macos)$'
  advisory_read
  assert_eq "$ADVISORY_RC" 1 "the variable's list is used, unchanged by the file ($ADVISORY_OUT)"
  assert_contains "$ADVISORY_OUT" "  RED      macos (failure)" "macos is not on it"
  assert_not_contains "$ADVISORY_OUT" "RED      claude" "claude is"
  assert_not_contains "$ADVISORY_ERR" "advisory checks, from" "and nothing says a file was used"
  assert_eq "$(grep -c 'ship-pr-advisory-checks' "$REQUEST_LOG")" 0 "the file is not read at all"
}

# An anchor binds to its own line: `^claude` still matches a longer name and `macos$` does not.
test_each_advisory_line_keeps_its_anchors() {
  reset_fixture
  advisory_probe claude-nightly macos-extra
  ADVISORY_BODY=$'^claude\nmacos$'
  advisory_read
  assert_eq "$ADVISORY_RC" 1 "one of the two reds is not advisory ($ADVISORY_OUT)"
  assert_not_contains "$ADVISORY_OUT" "claude-nightly" "the first line's prefix match was kept"
  assert_contains "$ADVISORY_OUT" "  RED      macos-extra (failure)" "the second line's suffix anchor did not leak"
}

test_head_reread_unknown() {
  local head
  for head in UNREADABLE ''; do
    reset_fixture
    HEAD_SEQ=("$HEAD_SHA" "$head")
    CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"success"}]')")
    RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
    run_gate 30
    assert_eq "$GATE_RC" 3 "unreadable or empty head remains unknown over green"
    assert_not_contains "$GATE_OUTPUT" "SUPERSEDED" "an unread head proves no movement"
    assert_not_contains "$GATE_OUTPUT" "green —" "an unread head never reports green"
  done
}

# `checks` ends with its machine-readable trailer (ludics-lite#423): `fleet-worker.sh prs` reads
# the verdict from it, never from the prose, whose ABSENT wording it once scraped — a reworded line
# there read as green. One fixture per exit status, the trailer the LAST line of stdout, and the
# prose left as it was.
check_trailer() { # <expected rc> <expected verdict> <prose> [checks args]
  local want_rc="$1" want="$2" prose="$3" out rc
  shift 3
  set +e
  out=$(cmd_checks 7 "$@" 2>/dev/null)
  rc=$?
  set -e
  assert_eq "$rc" "$want_rc" "$want: the exit status is unchanged"
  assert_contains "$out" "$prose" "$want: the prose line stays"
  assert_eq "$(tail -n 1 <<<"$out")" "checks: verdict=$want" "$want: the trailer is the last line"
}

test_checks_ends_with_its_verdict_trailer() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  check_trailer 0 green "green — 1 build checks passed"
  reset_fixture
  COMMIT_AGE=1800
  check_trailer 0 absent ": ABSENT"
  reset_fixture
  COMMIT_AGE=20
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"in_progress"}]')")
  check_trailer 4 unjudged "NO VERDICT YET"
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","status":"in_progress"}]')")
  check_trailer 4 pending "NO VERDICT YET — 1 check(s) still running: ci"
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"failure","html_url":"u"}]')")
  check_trailer 1 red ": RED"
  reset_fixture
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"startup_failure"}]')")
  check_trailer 1 runred ": RED"
  reset_fixture
  COMMIT_AGE=1800
  FAIL_ENDPOINT="*actions/runs*"
  check_trailer 3 unknown ""
  reset_fixture
  HEAD_SEQ=("$HEAD_SHA" "$HEAD_SHA" feedbeeffeedbeeffeedbeeffeedbeeffeedbeef)
  CHECK_RUNS_SEQ=(
    "$(check_runs_json '[{"name":"ci","status":"in_progress"}]')"
    "$(check_runs_json '[{"name":"ci","conclusion":"success"}]')"
  )
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  check_trailer 5 superseded "SUPERSEDED" --wait=30
  # A policy that could not be read is not a verdict either, and the trailer still closes the
  # output (review of #531).
  reset_fixture
  FAIL_ENDPOINT="*/ship-pr-advisory-checks"
  check_trailer 3 unknown ""
  reset_fixture
  ADVISORY_BODY='^(macos'
  check_trailer 2 unknown ""
}

# --- the gate's own refusals, pinned from its fix history (ludics-lite#403) ------------------------
# Paths a review round wrote into the gate and no case above walked, pinned before the port.

# A stopped check over a run list that is otherwise judged is INCOMPLETE: stopped is not a verdict,
# so it is exit 4 and never a green (ludics-lite#38), with what DID pass counted.
test_a_stopped_check_over_judged_runs_is_incomplete() {
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"build","conclusion":"success","html_url":"u"},
                                        {"name":"lint","conclusion":"cancelled","html_url":"v"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  run_gate
  assert_eq "$GATE_RC" 4 "a stopped check is no verdict"
  assert_contains "$GATE_OUTPUT" "INCOMPLETE — 1 passed, the rest were stopped without a verdict" \
    "headlined as incomplete, counting the green"
  assert_contains "$GATE_OUTPUT" "no verdict  lint (cancelled — stopped, not judged)  v" \
    "and the stopped check is listed"
  check_trailer 4 mixed "INCOMPLETE"
}

# A check list that could not be read is UNKNOWN, which is NOT "nothing is red": the outage and a
# commit with no checks are told apart (build_checks prints nothing on a failed read).
test_an_unreadable_check_list_is_unknown() {
  reset_fixture
  COMMIT_AGE=1800
  FAIL_ENDPOINT="*/check-runs?filter=latest&per_page=100"
  run_gate
  assert_eq "$GATE_RC" 3 "an unread check list is unknown"
  assert_contains "$GATE_OUTPUT" "could not read the checks of $REPO#7 @deadbeef" "and says what was unread"
  assert_not_contains "$GATE_OUTPUT" ": ABSENT" "never an absence"
  check_trailer 3 unknown ""
}

# `checks` takes one option; anything else is a usage error. A bare --wait is the configured
# ceiling, which a head that already has its verdict does not wait out.
test_checks_options() {
  local out rc
  reset_fixture
  set +e
  out=$(cmd_checks 7 --bogus 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "an unknown option is a usage error ($out)"
  assert_contains "$out" "checks: unknown option '--bogus'" "naming it"
  reset_fixture
  CHECK_RUNS_SEQ=("$(check_runs_json '[{"name":"ci","conclusion":"success","html_url":"u"}]')")
  RUNS_SEQ=("$(runs_json '[{"name":"ci","status":"completed","conclusion":"success"}]')")
  check_trailer 0 green "green — 1 build checks passed" --wait
}

# A list line with an escaped backslash before a digit is refused with the backreferences: refusing
# too much is a file to fix, never a weaker gate (review of #531).
test_an_escaped_backslash_before_a_digit_is_refused_too() {
  reset_fixture
  ADVISORY_BODY='^claude\\1$'
  check_trailer 2 unknown ""
}

tests=(
  test_checks_ends_with_its_verdict_trailer
  test_a_stopped_check_over_judged_runs_is_incomplete
  test_an_unreadable_check_list_is_unknown
  test_checks_options
  test_an_escaped_backslash_before_a_digit_is_refused_too
  test_wait_superseded_head
  test_wait_unchanged_head_turns_green
  test_head_reread_unknown
  test_inflight_run_is_not_absent
  test_queued_run_is_not_absent
  test_fresh_push_without_a_run_waits
  test_stale_push_without_a_run_is_absent
  test_grace_of_zero_settles_at_once
  test_finished_run_without_checks_is_absent
  test_advisory_run_does_not_hold_the_gate
  test_a_docs_only_head_is_absent_without_waiting_out_the_grace
  test_a_trigger_without_a_filter_keeps_the_head_waiting
  test_a_dispatchable_trigger_keeps_the_head_waiting
  test_any_push_trigger_keeps_the_head_waiting
  test_a_source_file_in_the_range_keeps_the_head_waiting
  test_an_unreadable_workflow_file_keeps_the_head_waiting
  test_an_unreadable_workflow_list_keeps_the_head_waiting
  test_a_head_without_a_base_sha_is_never_recognized
  test_an_event_outside_the_inert_list_keeps_the_head_waiting
  test_the_named_inert_events_do_not_block_the_recognition
  test_a_workflow_added_by_the_range_keeps_the_head_waiting
  test_an_unfiltered_merge_group_does_not_block_the_recognition
  test_a_truncated_workflow_list_keeps_the_head_waiting
  test_a_truncated_provider_sample_keeps_the_head_waiting
  test_a_workflow_only_on_the_base_keeps_the_head_waiting
  test_a_workflow_only_on_the_head_keeps_the_head_waiting
  test_the_range_is_read_once_for_every_workflow
  test_a_workflow_the_list_calls_advisory_is_still_explained
  test_a_capped_workflow_directory_keeps_the_head_waiting
  test_a_deleted_workflow_still_in_the_merge_context_is_examined
  test_a_base_that_moves_under_the_recognition_settles_nothing
  test_a_second_check_provider_keeps_the_head_waiting
  test_an_advisory_provider_does_not_block_the_recognition
  test_a_sample_without_checks_keeps_the_head_waiting
  test_a_base_side_workflow_edit_keeps_the_head_waiting
  test_a_head_with_a_run_never_consults_the_filter
  test_a_head_past_the_grace_never_consults_the_filter
  test_unreadable_run_list_is_unknown
  test_unreadable_push_time_is_unknown
  test_cancelled_run_is_not_absent
  test_one_finished_run_does_not_bypass_the_grace
  test_old_commit_freshly_pushed_waits
  test_old_commit_and_quiet_pr_is_absent
  test_unreadable_commit_still_decides_on_the_pr_clock
  test_green_over_finished_runs_is_green
  test_green_over_a_queued_sibling_is_not_green
  test_checkless_red_run_is_red
  test_checkless_red_run_outranks_a_green_check
  test_red_checks_never_consult_the_run_list
  test_run_lookup_is_paginated
  test_checkless_red_run_outranks_a_pending_check
  test_checkless_red_run_outranks_a_stopped_check
  test_pending_with_an_unreadable_run_list_is_unknown
  test_non_actions_check_without_runs_keeps_the_grace
  test_non_actions_check_past_the_grace_is_green
  test_superseded_stopped_run_does_not_hold
  test_superseded_red_run_does_not_stay_red
  test_newest_run_of_a_workflow_still_counts
  test_same_second_tie_prefers_the_higher_run_id
  test_future_commit_date_falls_back_to_the_pr_clock
  test_future_commit_date_still_holds_a_fresh_pr
  test_two_events_of_one_workflow_are_two_runs
  test_queued_invocation_survives_a_finished_twin
  test_stopped_checks_with_a_queued_run_keep_waiting
  test_completed_run_without_a_conclusion_is_unjudged
  test_advisory_job_failure_is_not_a_red_run
  test_non_advisory_job_failure_is_a_red_run
  test_a_waived_leg_does_not_redden_its_run
  test_a_run_level_red_is_waived_only_from_the_first_read
  test_unreadable_jobs_keep_the_red
  test_a_run_with_only_advisory_jobs_left_does_not_hold
  test_a_pending_required_job_holds_its_run
  test_an_inflight_run_without_jobs_holds
  test_an_unreadable_jobs_read_holds_its_run
  test_no_advisory_file_keeps_the_default_list
  test_the_advisory_file_replaces_the_list
  test_checks_reads_the_repository_list
  test_an_advisory_file_that_cannot_be_used_refuses
  test_the_variable_wins_over_the_file
  test_an_option_shaped_advisory_ere_is_a_pattern
  test_the_advisory_ere_is_greps_to_read
  test_the_advisory_file_is_validated_in_the_callers_locale
  test_each_advisory_line_keeps_its_anchors
  test_an_unconfirmed_404_is_not_an_absent_file
  test_a_job_list_inside_the_settle_holds_its_run
  test_a_run_between_jobs_holds
  test_a_red_or_stopped_required_job_holds_its_run
  test_an_untimed_job_holds_its_run
  test_wait_holds_until_the_checks_appear
  test_wait_ceiling_with_a_queued_run_is_no_verdict
  test_a_selected_check_settles_while_a_slow_one_runs
  test_the_progress_line_names_the_running_checks
  test_a_selection_matching_nothing_is_refused
  test_a_selection_waits_on_an_advisory_check_it_names
  test_merge_regates_an_absent_verdict_when_the_base_moved
  test_merge_lands_an_absent_verdict_the_moved_base_still_settles
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
