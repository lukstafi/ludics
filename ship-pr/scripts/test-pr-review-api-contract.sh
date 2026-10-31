#!/usr/bin/env bash
# Fixture tests for pr-review-api-contract.sh (ludics-lite#91). The contract asks the live API
# what the fixture suites take on faith, so its OWN logic — which claims pin and which skip, the
# `pages` wrapper, the `is_list`/UNUSABLE fallbacks, the parent-count branch, how a failed read is
# sorted, and the cleanup on exit — was checkable only by finding a live anchor with the right
# shape. Here it runs against a fixture world instead, in two ways:
#
#   - SOURCED with CONTRACT_TEST_SOURCE_ONLY=1, in a child bash, which loads the helpers, the
#     scratch directory and the EXIT trap and stops before the first read: the helper cases.
#   - RUN whole, as its own process, with a fixture `gh` and `sleep` first on PATH: the world
#     cases. The contract is a script that sources pr-review.sh itself and runs under its own
#     errexit, so its `gh` has to be a command, not a function of this shell.
#
# The fixture `gh` answers `gh api <endpoint>` from one file per endpoint in a world directory,
# and nothing else — the boundary is a fail-closed allowlist: an endpoint with no file is a 404
# (the contract's exit 4), and an option, a header or an endpoint character outside the small set
# it models is a 400, so a request the contract changes can never be answered by a fixture that
# widened (the request-side drift of #103). The healthy case also holds the other direction:
# every answer in the world was asked for, so a read the contract stops making is a dead fixture
# this suite reports rather than one it keeps.
#
# The world's inline rows come from test-pr-review-lib.sh's shared builders, inline_comment and
# positional_comment, and the contract's own pins run over them: a builder that stops carrying a
# field the contract names fails the healthy case here (the response-side drift this issue's
# second half is about, for those two builders).
#
# The healthy case pins the whole list of verdict lines — every `ok`, `MOVED` and `skip` line,
# in order — so a claim that turns into a skip, or a new claim, changes this file in the same PR.

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
test_tmpdir TEST_ROOT api-contract-test

CONTRACT="$SCRIPT_DIR/pr-review-api-contract.sh"
REPO=example/contract
BIN="$TEST_ROOT/bin"
WORLD="$TEST_ROOT/world"
mkdir -p "$BIN"

sha40() { printf '%040d' 0 | tr 0 "$1"; }
TIP=$(sha40 a)  # the base branch's tip
B7=$(sha40 b)   # the stale-base anchor #7's .base.sha snapshot
P1=$(sha40 c)   # its merge commit's first parent, which the snapshot is behind
H7=$(sha40 d)   # its head
M7=$(sha40 e)   # its merge commit
C7=$(sha40 f)   # its first commit
H9=$(sha40 1)   # the reviewed anchor #9's head
H12=$(sha40 2)  # the open PR #12's head, the open-PR anchor
H13=$(sha40 4)  # another open PR's head, for the cases where the anchor is not the only one
WIDE=$(sha40 3)  # the wide commit, past one default page of files
WIDE_REPO=example/wide
BOT="${REVIEWER}[bot]"
# The gate's review-threads query, which the contract asks of the Python and sends verbatim: the
# fixture answers that query and no other.
# LF line ends asked for, since a native Python on Windows prints CRLF.
GATE_PY="$SCRIPT_DIR/../../scripts/py"
GATE_THREADS_QUERY=$("$GATE_PY" -c 'import sys; sys.stdout.reconfigure(newline="\n")
from ludics.prreview.threads import THREADS_QUERY; print(THREADS_QUERY)')

# --- the fixture gh and sleep -------------------------------------------------------------------
# The endpoint's file name: `/?&=` mapped to `,@+~`, which the alphabet below excludes from an
# endpoint, so the map is one-to-one. The fixture spells the same `tr`; a drift between the two
# copies answers every read with a 404, which no case survives.
fixture_key() { printf '%s' "$1" | tr '/?&=' ',@+~'; }

cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
# The contract suite's fixture gh: `gh api [--paginate] [-H <the raw media type>] <endpoint>`
# answered from $CONTRACT_FIXTURE_WORLD, one file per endpoint, and `gh api graphql` with the
# reviewThreads query's fields, answered from the file of the virtual endpoint
# `graphql?pr=<pr>&first=<page size>&after=<cursor, or ->`; nothing else.
set -u
printf '%s\n' "$*" >>"$CONTRACT_FIXTURE_CALLS"
refuse() { printf 'gh: %s\n' "$1" >&2; exit 1; }
[ "${1:-}" = api ] || refuse "the fixture answers gh api only (HTTP 400): $*"
shift
endpoint="" paginate="" raw="" query="" owner="" name="" pr="" after="" fields=""
while [ $# -gt 0 ]; do
  case "$1" in
  --paginate) paginate=1 ;;
  -f | -F)
    fields=1
    case "${2:-}" in
    query=*) query="${2#query=}" ;;
    owner=*) owner="${2#owner=}" ;;
    name=*) name="${2#name=}" ;;
    pr=*) pr="${2#pr=}" ;;
    after=*) after="${2#after=}" ;;
    *) refuse "a field the fixture does not model (HTTP 400): ${2:-}" ;;
    esac
    shift
    ;;
  -H)
    [ "${2:-}" = "Accept: application/vnd.github.raw" ] || refuse "a header the fixture does not model (HTTP 400): ${2:-}"
    raw=.raw
    shift
    ;;
  -*) refuse "an option the fixture does not model (HTTP 400): $1" ;;
  *)
    [ -z "$endpoint" ] || refuse "a second endpoint (HTTP 400): $1"
    endpoint="$1"
    ;;
  esac
  shift
done
[ -z "${CONTRACT_FIXTURE_FAIL:-}" ] || refuse "the fixture refuses every read ($CONTRACT_FIXTURE_FAIL)"
if [ "$endpoint" = graphql ]; then
  # The gate's THREADS_QUERY, verbatim but for the page size, on this repository: anything
  # else is a query the world does not model.
  first=${query#*reviewThreads(first:}
  first=${first%%,*}
  case "$first" in '' | *[!0123456789]*) refuse "a GraphQL query without a reviewThreads page size (HTTP 400)" ;; esac
  [ "${query/"reviewThreads(first:$first,"/reviewThreads(first:100,}" = "$CONTRACT_FIXTURE_THREADS_QUERY" ] ||
    refuse "a GraphQL query that is not the gate's THREADS_QUERY (HTTP 400)"
  [ "$owner/$name" = "$CONTRACT_FIXTURE_REPO" ] || refuse "a GraphQL read of another repository (HTTP 400): $owner/$name"
  endpoint="graphql?pr=$pr&first=$first&after=${after:--}"
elif [ -n "$fields" ]; then
  refuse "a field on a REST read (HTTP 400): $endpoint"
fi
case "$endpoint" in
'' | *[!A-Za-z0-9/?\&=._%-]*) refuse "an endpoint outside the fixture's alphabet (HTTP 400): $endpoint" ;;
esac
file="$CONTRACT_FIXTURE_WORLD/$(printf '%s' "$endpoint" | tr '/?&=' ',@+~')$raw"
[ -f "$file" ] || refuse "Not Found (HTTP 404): the fixture world has no answer for $endpoint$raw"
# One body per page, as gh --paginate prints them: a read that is not paginated gets one page.
if [ -z "$paginate" ] && [ -z "$raw" ] && [ "$(jq -s length <"$file" | tr -d '\r')" != 1 ]; then
  refuse "a multi-page answer to an unpaginated read (HTTP 400): $endpoint"
fi
printf '%s\n' "$endpoint$raw" >>"$CONTRACT_FIXTURE_ASKED"
cat "$file"
EOF
# The backoff between retries, recorded instead of slept: three attempts would cost 15 seconds.
cat >"$BIN/sleep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CONTRACT_FIXTURE_SLEEPS"
EOF
chmod +x "$BIN/gh" "$BIN/sleep"

# --- the world -----------------------------------------------------------------------------------
answer() { # <endpoint> <json>...: one page per argument
  local endpoint="$1"
  shift
  printf '%s\n' "$@" >"$WORLD/$(fixture_key "$endpoint")"
}
answer_raw() { printf '%s' "$2" >"$WORLD/$(fixture_key "$1").raw"; }
unanswer() { rm -f "$WORLD/$(fixture_key "$1")"; }
# doctor <endpoint> <jq filter>: rewrites a one-page answer, the response a case needs moved.
doctor() {
  local f
  f="$WORLD/$(fixture_key "$1")"
  [ -f "$f" ] || bail "doctor: the world has no answer for $1"
  jq -c "$2" "$f" >"$f.new" || bail "doctor: the filter did not apply to $1: $2"
  mv "$f.new" "$f"
}

run_row() { # <id> <workflow id> <check suite id> <event> <status> <conclusion|null> <created_at> <head>
  jq -cn --argjson id "$1" --argjson w "$2" --argjson s "$3" --arg e "$4" --arg st "$5" \
    --argjson c "$6" --arg at "$7" --arg h "$8" \
    '{id:$id, workflow_id:$w, check_suite_id:$s, event:$e, name:"CI", status:$st, conclusion:$c,
      created_at:$at, head_sha:$h, head_branch:"main", html_url:"https://example/runs/\($id)"}'
}
wide_files() { # <from> <count>: one page of the wide commit's files, the 301st a rename
  jq -cn --argjson from "$1" --argjson n "$2" --arg sha "$WIDE" \
    '{sha:$sha, files:[range($from; $from + $n)
       | if . == 300 then {filename:"f300", status:"renamed", previous_filename:"old-f300"}
         else {filename:"f\(.)", status:"modified"} end]}'
}
check_run() { # <id> <name> <check suite id> <conclusion>
  jq -cn --argjson id "$1" --arg n "$2" --argjson s "$3" --arg c "$4" \
    '{id:$id, name:$n, status:"completed", conclusion:$c, html_url:"https://example/checks/\($id)",
      app:{slug:"github-actions"}, check_suite:{id:$s}}'
}

# The healthy world: every read the contract makes on a merge-merged anchor, answered in the shape
# the contract pins, with the anchors that turn its conditional claims on — a tip with two runs, a
# red run whose red job is on the SECOND page of its jobs (so only a joined `pages` sees it), a
# re-run on the tip, a renamed file in the anchor compare, a reply to an inline finding, a migrated
# anchor on each inline feed, and a merged PR whose findings review precedes its Completed row.
world_healthy() {
  local R="repos/$REPO" tip_runs inline threads
  rm -rf "$WORLD"
  mkdir -p "$WORLD"
  answer "$R" '{"default_branch":"main"}'
  answer "$R/commits/main" "{\"sha\":\"$TIP\",\"commit\":{\"committer\":{\"date\":\"2026-09-30T10:00:00Z\"}}}"
  tip_runs="[$(run_row 202 11 402 push completed '"success"' 2026-09-30T10:00:05Z "$TIP"),$(run_row 201 11 401 pull_request completed '"failure"' 2026-09-30T10:00:00Z "$TIP")]"
  answer "$R/actions/runs?head_sha=$TIP&per_page=100" "{\"total_count\":2,\"workflow_runs\":$tip_runs}"
  answer "$R/actions/runs?head_sha=$TIP&per_page=10" "{\"total_count\":2,\"workflow_runs\":$tip_runs}"
  answer "$R/actions/runs?per_page=100" "{\"total_count\":3,\"workflow_runs\":$(jq -c --argjson older \
    "$(run_row 150 11 350 push completed '"success"' 2026-09-29T10:00:00Z "$P1")" '. + [$older]' <<<"$tip_runs")}"
  answer "$R/actions/workflows/11" '{"id":11,"name":"CI","path":".github/workflows/ci.yml","state":"active"}'
  answer_raw "$R/contents/.github/workflows/ci.yml?ref=$TIP" $'name: CI\non:\n  push:\n'
  answer "$R/actions/workflows?per_page=100" '{"total_count":1,"workflows":[{"id":11,"name":"CI","path":".github/workflows/ci.yml","state":"active"}]}'
  answer "$R/actions/workflows/11/runs?branch=main&event=push&per_page=10" \
    "{\"total_count\":2,\"workflow_runs\":[$(run_row 202 11 402 push completed '"success"' 2026-09-30T10:00:05Z "$TIP"),$(run_row 150 11 350 push completed '"success"' 2026-09-29T10:00:00Z "$P1")]}"
  answer "$R/actions/runs/201/jobs?per_page=100" \
    '{"total_count":2,"jobs":[{"name":"lint","status":"completed","conclusion":"success","created_at":"2026-09-30T10:00:01Z","completed_at":"2026-09-30T10:01:00Z"}]}' \
    '{"total_count":2,"jobs":[{"name":"test","status":"completed","conclusion":"failure","created_at":"2026-09-30T10:00:01Z","completed_at":"2026-09-30T10:02:00Z"}]}'
  answer "$R/actions/runs/202/jobs?per_page=100" '{"total_count":1,"jobs":[{"name":"test","status":"completed","conclusion":"success","created_at":"2026-09-30T10:00:06Z","completed_at":"2026-09-30T10:02:00Z"}]}'
  answer "$R/commits/$TIP/check-runs?filter=latest&per_page=100" \
    "{\"total_count\":2,\"check_runs\":[$(check_run 502 test 402 success),$(check_run 501 test 401 failure)]}"
  answer "$R/commits/$TIP/check-runs?filter=all&per_page=100" \
    "{\"total_count\":3,\"check_runs\":[$(check_run 502 test 402 success),$(check_run 501 test 401 failure),$(check_run 500 test 401 cancelled)]}"

  # The stale-base anchor #7, merge-merged behind a sibling. Its mergeability is the computed
  # shape GitHub serves for a merged PR since 2026-10-27 (ludics#818); the uncomputed one it served
  # before is a case of its own below.
  answer "$R/pulls/7" "{\"number\":7,\"merged\":true,\"merged_at\":\"2026-09-20T10:00:00Z\",\"merge_commit_sha\":\"$M7\",
    \"base\":{\"sha\":\"$B7\",\"ref\":\"main\"},\"head\":{\"sha\":\"$H7\"},\"mergeable\":true,\"mergeable_state\":\"clean\",\"commits\":2}"
  answer "$R/pulls/7/commits?per_page=100" \
    "[{\"sha\":\"$C7\",\"commit\":{\"message\":\"first\"}},{\"sha\":\"$H7\",\"commit\":{\"message\":\"second\"}}]"
  answer "$R/commits/$M7" "{\"sha\":\"$M7\",\"parents\":[{\"sha\":\"$P1\"},{\"sha\":\"$H7\"}],
    \"commit\":{\"committer\":{\"email\":\"noreply@github.com\"},\"verification\":{\"verified\":true}}}"
  answer "$R/commits/$M7/pulls?per_page=100" \
    "[{\"number\":7,\"merged_at\":\"2026-09-20T10:00:00Z\",\"merge_commit_sha\":\"$M7\",\"head\":{\"sha\":\"$H7\"},\"base\":{\"ref\":\"main\"}}]"
  answer "$R/compare/$B7...$P1?per_page=1" "$(jq -cn --arg b "$B7" '{status:"ahead", behind_by:0, ahead_by:1,
    merge_base_commit:{sha:$b},
    files:[{filename:"a.sh", status:"modified", additions:1, deletions:0, changes:1, patch:"@@ -1 +1,2 @@\n a\n+b"},
           {filename:"b.sh", previous_filename:"old-b.sh", status:"renamed", additions:0, deletions:0, changes:0}]}')"
  answer "$R/pulls?state=closed&sort=updated&direction=desc&per_page=100" \
    '[{"number":7,"merged_at":"2026-09-20T10:00:00Z"},{"number":8,"merged_at":null}]'
  answer "$R/pulls?state=open&per_page=10" '[{"number":12}]'
  answer "$R/pulls/12" "{\"number\":12,\"state\":\"open\",\"draft\":true,\"head\":{\"sha\":\"$H12\"},\"base\":{\"ref\":\"main\"},\"created_at\":\"2026-09-30T09:00:00Z\",
    \"updated_at\":\"2026-09-30T09:30:00Z\",\"mergeable\":true,\"mergeable_state\":\"clean\"}"

  # The reviewed anchor #9: the inline rows are the shared builders', a migrated anchor on each feed.
  answer "$R/issues/9/reactions?per_page=100" \
    "[{\"content\":\"eyes\",\"user\":{\"login\":\"$BOT\"},\"created_at\":\"2026-09-10T10:00:00Z\"},{\"content\":\"+1\",\"user\":{\"login\":\"$BOT\"},\"created_at\":\"2026-09-10T11:00:00Z\"}]"
  answer "$R/issues/9/comments?per_page=100" "$(jq -cn --arg bot "$BOT" \
    '[{id:70, user:{login:$bot}, created_at:"2026-09-10T10:01:00Z", updated_at:"2026-09-10T10:05:00Z",
       body:"<!-- codex-pull-request-review-summary -->\nfindings"}]')"
  inline="[$(inline_comment 900 "$H9" "$H9" 'P2: a finding' a.sh 3 '' '{"pull_request_review_id":31}'),$(inline_comment 901 "$H9" "$H9" 'P2: another' a.sh 12 9 '{"pull_request_review_id":31}'),$(inline_comment 902 "$H9" "$H9" 'fixed' a.sh 3 '' '{"pull_request_review_id":32,"in_reply_to_id":900,"user":{"login":"lukstafi"}}')]"
  answer "$R/pulls/9/comments?per_page=100" "$inline"
  answer "$R/pulls/9/comments" "$inline"
  answer "$R/pulls/9/reviews?per_page=100" "$(jq -cn --arg bot "$BOT" --arg h "$H9" \
    '[{id:31, user:{login:$bot}, state:"COMMENTED", commit_id:$h, submitted_at:"2026-09-10T10:04:00Z", body:"findings"},
      {id:32, user:{login:"lukstafi"}, state:"COMMENTED", commit_id:$h, submitted_at:"2026-09-10T10:30:00Z", body:""},
      {id:33, user:{login:$bot}, state:"COMMENTED", commit_id:$h, submitted_at:"2026-09-10T10:40:00Z", body:"no new findings"}]')"
  answer "$R/pulls/9/reviews/31/comments?per_page=100" \
    "[$(positional_comment 900 "$H9" 'P2: a finding' 3 3 '{"pull_request_review_id":31}'),$(positional_comment 901 "$H9" 'P2: another' 7 4 '{"pull_request_review_id":31}')]"

  # The reviewThreads anchor is #9 too: three threads, the lib's review_thread rows, their first
  # comments past 2^31 (databaseId null, as the builder serves it), read verbatim and then walked
  # at the contract's derived page of two. Their commits: written on #9's head, one of them now
  # outdated (commit null, as GraphQL serves a comment whose lines are gone).
  threads="[$(review_thread 4095735684 false a.sh 'codex[bot]' "$H9"),$(review_thread 4095735690 true a.sh 'codex[bot]' "$H9"),$(review_thread 4095735700 false b.sh 'codex[bot]' "$H9" null)]"
  answer "graphql?pr=9&first=100&after=-" "$(review_threads_answer "$threads")"
  answer "graphql?pr=9&first=2&after=-" "$(THREADS_FIXTURE_PAGE=2 review_threads_answer "$threads")"
  answer "graphql?pr=9&first=2&after=c2" "$(THREADS_FIXTURE_PAGE=2 review_threads_answer "$threads" after=c2)"

  # The wide commit, in a repository of its own: 301 files, one default page of 300 unpaginated,
  # four pages of at most 100 paginated, the last row a rename.
  answer "repos/$WIDE_REPO/commits/$WIDE" "$(wide_files 0 300)"
  answer "repos/$WIDE_REPO/commits/$WIDE?per_page=100" "$(wide_files 0 100)" "$(wide_files 100 100)" "$(wide_files 200 100)" "$(wide_files 300 1)"

  # The summary-row sample: #7, the one merged PR, ended on a findings round. An older summary
  # comment of its carries a Completed row naming no commit, the row whose Review trigger
  # _receipt_binding reads (ludics#825); only the newest summary is read for the order claim.
  answer "$R/issues/7/comments?per_page=100" "$(jq -cn --arg bot "$BOT" --arg s "${H7:0:7}" \
    '[{id:71, user:{login:$bot}, created_at:"2026-09-20T09:00:00Z", updated_at:"2026-09-20T09:10:10Z",
       body:("<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-09-20T09:10:10.510504Z\">x</relative-time> | `" + $s + "` | New commits |")},
      {id:69, user:{login:$bot}, created_at:"2026-09-19T09:00:00Z", updated_at:"2026-09-19T09:05:00Z",
       body:"<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-09-19T09:05:00.25Z\">x</relative-time> | — | PR opened |"}]')"
  answer "$R/pulls/7/reviews?per_page=100" "$(jq -cn --arg bot "$BOT" --arg h "$H7" \
    '[{id:72, user:{login:$bot}, state:"COMMENTED", commit_id:$h, submitted_at:"2026-09-20T09:10:08Z", body:"findings"}]')"
}

# --- running it ----------------------------------------------------------------------------------
# A function the environment exported reaches the contract's shell and shadows the command of that
# name: run-pr-review-hostile.sh exports a `gh` that answers every read with nothing. So each run
# drops the export from every function this shell inherited, in the subshell it starts the run
# from; the suite's own shell keeps them, which is the lib's guard's business.
unexport_functions() {
  local f
  for f in $(declare -Fx | sed -n 's/^declare -fx //p'); do export -fn "$f"; done
}

# One run of the contract against the world, in a TMPDIR of its own that the case can then hold
# empty. Everything the environment could steer it with is set or unset here: under Actions,
# GITHUB_RUN_ID, GITHUB_REPOSITORY and GITHUB_EVENT_NAME are set for the suite too.
run_contract() { # [VAR=value...]: extra environment for this run
  local tmp
  tmp="$TEST_ROOT/tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  RUN_TMP="$tmp"
  : >"$TEST_ROOT/calls"
  : >"$TEST_ROOT/asked"
  : >"$TEST_ROOT/sleeps"
  CONTRACT_RC=0
  (
    unexport_functions
    exec env -u GITHUB_RUN_ID -u CONTRACT_OWN_HEAD -u CONTRACT_BASE -u GITHUB_REPOSITORY -u GITHUB_EVENT_NAME \
      -u CONTRACT_SUMMARY_SAMPLE -u CONTRACT_TEST_SOURCE_ONLY -u CONTRACT_FIXTURE_FAIL \
      PATH="$BIN:$PATH" TMPDIR="$tmp" REVIEWER="$REVIEWER" \
      CONTRACT_STALE_BASE_PR=7 CONTRACT_REVIEWED_PR=9 CONTRACT_THREADS_PR=9 CONTRACT_OPEN_PR=12 \
      CONTRACT_WIDE_COMMIT="$WIDE_REPO@$WIDE" CONTRACT_WIDE_COMMIT_FILES=301 \
      CONTRACT_FIXTURE_REPO="$REPO" CONTRACT_FIXTURE_THREADS_QUERY="$GATE_THREADS_QUERY" \
      CONTRACT_FIXTURE_WORLD="$WORLD" CONTRACT_FIXTURE_CALLS="$TEST_ROOT/calls" \
      CONTRACT_FIXTURE_ASKED="$TEST_ROOT/asked" CONTRACT_FIXTURE_SLEEPS="$TEST_ROOT/sleeps" "$@" \
      bash "$CONTRACT" "$REPO"
  ) >"$TEST_ROOT/out" 2>"$TEST_ROOT/err" || CONTRACT_RC=$?
  CONTRACT_OUT=$(cat "$TEST_ROOT/out")
  CONTRACT_ERR=$(cat "$TEST_ROOT/err")
}

# The contract's verdict lines, without the filter/read detail a MOVED line carries.
verdicts() { grep -E '^(ok    |MOVED |skip  )' <<<"$CONTRACT_OUT" || true; }

# What a run left in its TMPDIR: nothing, whatever way it ended.
assert_nothing_left() { # <what>
  local left
  left=$(ls -A "$RUN_TMP")
  assert_eq "$left" "" "$1 should leave nothing in TMPDIR"
}

# A child bash that SOURCES the contract and runs <script> there, in a TMPDIR of its own.
sourced() { # <script> [VAR=value...]
  local script="$1" tmp
  shift
  tmp="$TEST_ROOT/tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  RUN_TMP="$tmp"
  : >"$TEST_ROOT/calls"
  : >"$TEST_ROOT/asked"
  : >"$TEST_ROOT/sleeps"
  SOURCED_RC=0
  SOURCED_OUT=$(
    unexport_functions
    exec env -u CONTRACT_FIXTURE_FAIL PATH="$BIN:$PATH" TMPDIR="$tmp" CONTRACT_TEST_SOURCE_ONLY=1 \
      CONTRACT_FIXTURE_REPO="$REPO" CONTRACT_FIXTURE_THREADS_QUERY="$GATE_THREADS_QUERY" \
      CONTRACT_FIXTURE_WORLD="$WORLD" CONTRACT_FIXTURE_CALLS="$TEST_ROOT/calls" \
      CONTRACT_FIXTURE_ASKED="$TEST_ROOT/asked" CONTRACT_FIXTURE_SLEEPS="$TEST_ROOT/sleeps" "$@" \
      bash -c 'source "$1" '"$REPO"'; eval "$2"' _ "$CONTRACT" "$script" 2>"$TEST_ROOT/err"
  ) || SOURCED_RC=$?
  SOURCED_ERR=$(cat "$TEST_ROOT/err")
}

# --- the helpers, sourced ------------------------------------------------------------------------
test_sourcing_stops_before_the_first_read() {
  world_healthy
  sourced 'printf "claims=%s moved=%s skipped=%s scratch=%s\n" "$CLAIMS" "$MOVED" "$SKIPPED" "$([ -d "$SCRATCH" ] && echo yes)"'
  assert_eq "$SOURCED_RC" 0 "sourcing the contract should succeed ($SOURCED_ERR)"
  assert_eq "$SOURCED_OUT" "claims=0 moved=0 skipped=0 scratch=yes" "a source should load the helpers and the scratch directory, and make no claim"
  assert_eq "$(cat "$TEST_ROOT/calls")" "" "a source should make no read"
  assert_nothing_left "a sourced contract's exit"
  run_contract CONTRACT_TEST_SOURCE_ONLY=1
  assert_eq "$CONTRACT_RC" 2 "running the contract with the source-only switch should be refused"
  assert_contains "$CONTRACT_ERR" "is for sourcing this file" "the refusal should say why"
  assert_eq "$(cat "$TEST_ROOT/calls")" "" "the refused run should make no read"
  assert_nothing_left "the refused run"
}

test_pages_joins_every_page_and_nulls_a_moved_wrapper() {
  sourced '
    printf "%s\n" "{\"jobs\":[1]}" "{\"jobs\":[2,3]}" | pages jobs | jq -c .
    printf "%s\n" "{\"jobs\":[1]}" "{\"total_count\":1}" | pages jobs | jq -c .
    printf "%s\n" "{\"jobs\":{}}" | pages jobs | jq -c .
    printf "%s\n" "[1]" | pages jobs | jq -c .
    printf "" | pages jobs | jq -c .'
  assert_eq "$SOURCED_RC" 0 "the pages probes should run ($SOURCED_ERR)"
  assert_eq "$SOURCED_OUT" $'[1,2,3]\nnull\nnull\nnull\nnull' \
    "pages should join every page's list, and answer null when any page lacks it, a page is not an object, or there is no page"
}

test_pin_and_skip_count_and_report() {
  sourced '
    pin "holds" ".a == 1" "{\"a\":1}"
    pin "moved" ".a == 1" "{\"a\":2}"
    pin "takes its value as an argument" ".a == \$v" "{\"a\":\"x\\\"y\"}" --arg v "x\"y"
    pin "a filter that does not parse" ".a ==" "{\"a\":1}"
    pin "a filter that yields false on no input" "." ""
    skip "unpinned" "no anchor"
    echo "claims=$CLAIMS moved=$MOVED skipped=$SKIPPED"'
  assert_eq "$SOURCED_RC" 0 "the pin probes should run ($SOURCED_ERR)"
  assert_contains "$SOURCED_OUT" "ok    holds" "a pin that holds should print ok"
  assert_contains "$SOURCED_OUT" $'MOVED moved\n      filter: .a == 1\n      read:   {"a":2}' \
    "a pin that fails should print MOVED with its filter and what it read"
  assert_contains "$SOURCED_OUT" "ok    takes its value as an argument" "a pin's jq arguments should reach its filter"
  assert_contains "$SOURCED_OUT" "MOVED a filter that does not parse" "a filter jq refuses should be a MOVED, not a pass or a crash"
  assert_contains "$SOURCED_OUT" "MOVED a filter that yields false on no input" "a pin on empty input should be a MOVED"
  assert_contains "$SOURCED_OUT" "skip  unpinned — no anchor" "a skip should print its reason"
  assert_contains "$SOURCED_OUT" "claims=5 moved=3 skipped=1" "pin and skip should count what they printed"
}

test_is_list_and_the_read_guards() {
  sourced '
    for v in "[]" "[1]" null "{}" "" "not json" "\"[]\""; do is_list "$v" && echo list || echo not; done
    for v in "$S_OK" "$S_SHORT" "$S_LONG" "$S_UPPER" ""; do is_sha "$v" && echo sha || echo not; done
    for v in 7 007 "" -1 1.5 "7 "; do is_num "$v" && echo num || echo not; done
    echo "$UNUSABLE"' S_OK="$TIP" S_SHORT="${TIP:0:39}" S_LONG="${TIP}0" S_UPPER="$(sha40 A)"
  assert_eq "$SOURCED_RC" 0 "the guard probes should run ($SOURCED_ERR)"
  assert_eq "$(sed -n 1,7p <<<"$SOURCED_OUT" | tr '\n' ' ')" "list list not not not not not " \
    "is_list should accept an array and nothing else, a string holding one included"
  assert_eq "$(sed -n 8,12p <<<"$SOURCED_OUT" | tr '\n' ' ')" "sha not not not not " \
    "is_sha should accept 40 lowercase hex and nothing else"
  assert_eq "$(sed -n 13,18p <<<"$SOURCED_OUT" | tr '\n' ' ')" "num num not not not not " \
    "is_num should accept digits and nothing else"
  assert_eq "$(sed -n 19p <<<"$SOURCED_OUT")" "its input is not usable — see the MOVED above" \
    "UNUSABLE is the reason a row-level skip gives"
}

# How api sorts a failed read: the exit, how many attempts it made, and the backoff it took.
test_api_sorts_a_failed_read_by_its_status() {
  local row fail want_rc want_calls want_sleeps
  world_healthy
  for row in \
    "HTTP 502|3|3|5 10" \
    "HTTP 429|3|3|5 10" \
    "HTTP 408|3|3|5 10" \
    "HTTP 425|3|3|5 10" \
    "API rate limit exceeded (HTTP 403)|3|3|5 10" \
    "HTTP 401|5|1|" \
    "HTTP 403|5|1|" \
    "HTTP 404|4|1|" \
    "HTTP 422|4|1|" \
    "Something went wrong while executing your query|3|3|5 10" \
    '{"errors":[{"type":"NOT_FOUND"}]}|4|1|'; do
    IFS='|' read -r fail want_rc want_calls want_sleeps <<<"$row"
    sourced 'api "repos/'"$REPO"'"' CONTRACT_FIXTURE_FAIL="$fail"
    assert_eq "$SOURCED_RC" "$want_rc" "a read failing with '$fail' should exit $want_rc ($SOURCED_ERR)"
    assert_eq "$(wc -l <"$TEST_ROOT/calls" | tr -d ' ')" "$want_calls" "a read failing with '$fail' should be attempted $want_calls time(s)"
    assert_eq "$(tr '\n' ' ' <"$TEST_ROOT/sleeps" | sed 's/ $//')" "$want_sleeps" "a read failing with '$fail' should back off '$want_sleeps'"
    assert_contains "$SOURCED_ERR" "$fail" "the message should quote the failure"
    assert_nothing_left "a read failing with '$fail'"
  done
  sourced 'api "repos/'"$REPO"'"'
  assert_eq "$SOURCED_RC" 0 "an answered read should succeed ($SOURCED_ERR)"
  assert_eq "$SOURCED_OUT" '{"default_branch":"main"}' "an answered read should print the body"
  sourced 'api "repos/'"$REPO"'" --jq .default_branch'
  assert_eq "$SOURCED_RC" 2 "a read asking gh for a --jq projection should be refused"
  assert_eq "$(cat "$TEST_ROOT/calls")" "" "the refused read should never reach gh"
}

# The one piece of the gate's reading the contract restates in jq (SUMMARY_ROW_INSTANT_DEF: the
# gate runs no jq), held to the gate's own state.instant: a fraction of any length, none, and a
# whole-second stamp, each padded to the same nine digits by both.
test_the_instant_def_answers_as_the_gate_s_instant() {
  local samples want
  samples='["2026-09-04T22:47:25.387018Z","2026-09-04T22:47:25Z","2026-09-04T22:47:25.1Z","2026-09-04T22:47:25.123456789Z","2026-09-04T22:47:25.1234567891Z"]'
  want=$("$GATE_PY" -c 'import json, sys; sys.stdout.reconfigure(newline="\n")
from ludics.prreview.state import instant
print(json.dumps([instant(s) for s in json.loads(sys.argv[1])], separators=(",", ":")))' "$samples")
  sourced 'jq -cn --argjson s "$SAMPLES" "$SUMMARY_ROW_INSTANT_DEF [\$s[] | instant]"' SAMPLES="$samples"
  assert_eq "$SOURCED_RC" 0 "the jq spelling should run ($SOURCED_ERR)"
  assert_eq "$(tr -d '\r' <<<"$SOURCED_OUT")" "$want" "the jq spelling of instant should answer as the gate's"
  assert_contains "$want" '"2026-09-04T22:47:25.000000000"' "control: the samples include a padded whole second"
}

# The EXIT trap removes the scratch directory on every exit, and names an exit it did not choose.
# The control proves the assertion can fail: with the trap's function emptied, the directory is
# left behind. (pr-review.sh, which the contract sources, leaves nothing of its own to remove since
# its shell half was retired; while it did, this trap called its cleanup by name, ludics-lite#195.)
test_the_exit_trap_cleans_up_and_names_an_unchosen_exit() {
  sourced "exit 3"
  assert_eq "$SOURCED_RC" 3 "the planted exit should be the child's"
  assert_nothing_left "an exit 3"
  assert_not_contains "$SOURCED_ERR" "stopped early" "an exit the contract chose should not be called an early stop"
  sourced "exit 7"
  assert_eq "$SOURCED_RC" 7 "the planted exit should be the child's"
  assert_nothing_left "an exit 7"
  assert_contains "$SOURCED_ERR" "the contract stopped early with exit 7 after 0 beliefs (0 moved)" \
    "an exit the contract did not choose should be named"
  sourced "on_exit() { :; }; exit 3"
  assert_contains "$(ls -A "$RUN_TMP")" "pr-review-api-contract." \
    "control: without the trap's removal the scratch directory is left behind, so the assertion above can fail"
}

# --- whole runs ----------------------------------------------------------------------------------
# What the healthy world pins and what it skips, line by line. The skips are the claims the
# contract never makes off Actions or at all (its own run, a push under observation, the push
# clock, more than 100 review threads, a 300-file compare) and one that waits on an anchor the
# world does not carry (more than a page of inline comments). A belief the contract adds or rewords lands here in
# the same PR, and the world grows the fields it pins.
IFS= read -r -d '' HEALTHY_VERDICTS <<'EOF' || :
ok    repos/<owner/name> carries default_branch (the drift anchor's ref when none is given)
ok    commits/<encode_ref branch> answers the branch tip's sha and committer date (the drift anchor and the push clock)
ok    the feed is workflow_runs[]
ok    every row carries the fields the fold indexes: numeric id and workflow_id, string event, name and status, created_at (created_at and id are the sort key it orders on)
ok    every row's head_sha is the sha asked for (the filter filters)
ok    status strings are in the known vocabulary
ok    every row carries conclusion (present, null until completed) and it is in the vocabulary conclusion_class classifies
ok    a row that is not completed has no conclusion yet
ok    runs?head_sha= comes back newest-first (created_at non-increasing, on the tip's 2 rows)
skip  this job's own run is a row on its head, and that head is newest-first — not running under Actions (GITHUB_RUN_ID and CONTRACT_OWN_HEAD unset)
ok    workflow_id resolves to a workflow FILE whose name is the run's name (the fold keys on the file, not the display name)
ok    contents/<path> under the raw media type answers with the workflow file's own text, not the base64 JSON envelope
ok    the workflow list is workflows[], with total_count beside it
ok    every workflow carries the two fields the row projection reads: a numeric id and a non-empty name with no tab in it
ok    every workflow carries the path the paths-ignore read asks for, under .github/workflows/
ok    every workflow carries a state drawn from the vocabulary the head recognition reads (active = can create a run)
ok    this repository's workflows fit the single page cmd_base reads (1 of a page of 100)
ok    workflow 11's branch-and-event feed is workflow_runs[]
ok    every row carries the eight fields the fold projects: numeric workflow_id and id, string name and status, a 40-hex head_sha, an ISO created_at, and an html_url
ok    every row carries conclusion (present, null until completed), in the vocabulary conclusion_class classifies
ok    status strings are in the known vocabulary
ok    the workflow_id in the path is the workflow every row belongs to (the per-workflow query really is per workflow)
ok    the event= filter filters: every row is a push run
ok    the branch= filter filters: every row's head_branch is main
ok    the page comes back newest-first (created_at non-increasing over its 2 rows), so per_page=10 is the newest ten
ok    the feed is jobs[] (run 201, the latest red run: failure)
ok    jobs[] rows carry a non-empty name (run_red_is_advisory_only skips a row with none) and conclusion (present, null while unfinished)
ok    job conclusions are in the same vocabulary as run conclusions
ok    jobs[] rows carry an ISO created_at, and every finished job an ISO completed_at (run_inflight_is_advisory_only's settle)
ok    a red run's jobs carry the red: at least one job concluded failure, timed_out or startup_failure, or no jobs at all (the startup_failure shape)
ok    the feed is check_runs[]
ok    every check run carries a non-empty name (build_checks skips a row with none), conclusion (present, null while unfinished), html_url and app.slug
ok    every check run carries a status string, never "completed" while its conclusion is null (the build wait's pause reads "in_progress" as running)
ok    check-run conclusions are in the vocabulary conclusion_class classifies
ok    every check run carries a check_suite.id (build_checks reads by name across every suite and provider)
ok    GitHub Actions' own check runs carry app.slug == "github-actions" (providers_are_actions_only's literal)
ok    filter=latest is a subset of filter=all by id (it filters; it does not invent rows)
ok    every check run filter=all has that filter=latest lacks (1, with 0 created between the two reads set aside) is a superseded attempt: a newer row of the same suite and name is in filter=latest (no stale twin, and no uniqueness asked of same-named jobs)
ok    every run row carries a numeric check_suite_id (the join to a check run's check_suite.id)
ok    every github-actions check run of the tip's newest 10 runs is named after a job of ITS run (the advisory deny-list matches JOB names), on 2 check runs
ok    the anchor PR #7 is merged, with a merge_commit_sha, a base.sha, a head.sha and a base.ref
ok    a merged PR's mergeability never reads as a conflict: mergeable present, true or null, and mergeable_state in the vocabulary, not 'dirty' (what conflict_preflight, await_mergeable and status refuse on)
ok    pulls/<n>/commits serves as many rows as the PR's .commits, oldest first, each with a sha and a string commit.message, the last one the PR's head (warn_series_close's shape)
ok    a merged PR's head.sha is the head it merged at: the merge commit's second parent (confirm()'s merged-head check)
ok    GitHub's merge commit is committed by noreply@github.com with a verified signature (tip_pr_head_verdict's clean-merge test)
ok    commits/<merge sha>/pulls lists the PR it merged, with merged_at, that merge_commit_sha, its head.sha and base.ref (tip_pr_head_verdict's lookup)
ok    `.base.sha` is a SNAPSHOT, not the base the merge was built on: on #7 it differs from the merge commit's first parent
ok    ... and the snapshot is BEHIND that parent (an ancestor, so 'behind' counts read off it undercount)
ok    compare/<a>...<b>?per_page=1 carries behind_by, ahead_by, merge_base_commit.sha and files[].filename (the drift fixture's shape)
ok    compare files[] rows carry string filename and status, numeric additions, deletions and changes, and previous_filename absent, null or non-empty (valid_file's shape)
ok    on every compare file that carries a patch, its +/- line counts equal additions/deletions (compare_hunks's consistency test)
ok    ... and merge_base_commit is the older side when it is an ancestor
ok    a renamed entry carries previous_filename
ok    pulls?state=closed is a list whose rows carry merged_at (present, null when closed unmerged)
ok    on the 1 most recently merged PRs (of the latest 100 closed), base.sha is the merge's first parent or an ancestor of it — never off the base line
ok    pulls?state=open is a list
ok    every row of the open-PR list carries a numeric number
ok    the open-PR anchor #12 is open and a draft (reopen it, or make a new one as the header says and point CONTRACT_OPEN_PR at it)
ok    an open PR's pulls/<n> read carries head.sha, base.ref, updated_at, and mergeable (present) in {true,false,null}
ok    ... and created_at, the review clock's floor, no later than updated_at
ok    ... and a mergeable_state in the vocabulary status_state renders (dirty is CONFLICTS, unknown is not yet computed)
skip  a push made while mergeable_state=dirty gets no pull_request run — needs a dirty PR pushed to under observation; not manufactured here
skip  a push moves the PR's updated_at (the push clock) — push time is not an API field; measured live on ludics-lite#38, not re-checkable without a push
ok    the reactions feed is a list
ok    reactions carry content, user.login and created_at
ok    the app's login carries the [bot] suffix: 'chatgpt-codex-connector[bot]' reacted, and nothing is logged in as bare 'chatgpt-codex-connector'
ok    the approval is a '+1' reaction from the app (the merge gate's 👍)
ok    the issue-comments feed is a list
ok    issue comments carry numeric id, created_at, updated_at, body and user.login
ok    the app's summary comment carries the codex-pull-request-review-summary machine tag
ok    the paginated inline-comments feed is a list
ok    the unpaginated inline-comments read is a list
ok    inline comments carry numeric id, pull_request_review_id, commit_id, the original_commit_id poll stamps and folds by, user.login, a non-empty path, body, and the line/original_line pair poll renders
ok    the reviews feed is a list
ok    reviews carry numeric id, state, commit_id, submitted_at (present, null while pending), user.login and a body (poll renders it)
ok    the app's review states are in the vocabulary (the projections filter to the app before classifying; other participants' states are not read)
ok    a round with findings is COMMENTED reviews from the app, and the approval is NOT an APPROVED review (it is the reaction above)
ok    a reply to an inline comment is a COMMENTED review by the replier in the same feed as the app's rounds (so 'new' must be id > watermark, not a count; review 32 by lukstafi)
skip  the flat listing paginates at 30 by default — #9 has 3 inline comments, not more than a page; a larger anchor shows it
ok    a review's own comments endpoint answers with exactly the flat listing's rows for that review, by id (the merge-by-id read; review 31)
ok    the per-review rows carry what poll renders and folds from this feed alone while the flat listing lags: numeric id and pull_request_review_id, commit_id, the original_commit_id the head stamp needs, the position pair the fold keys on, user.login, a non-empty path, body
ok    every Code Review row of the sampled PRs' summaries is Completed or Failed in the allowlisted shape, Completed naming no commit, or Running, dated by an ISO 8601 UTC datetime not in the future (2 rows on 1 PRs; 0 Failed)
ok    every Code Review row's Review trigger cell is a word the gate knows, Manual request, PR opened, New commits, Draft marked ready (_receipt_binding approves a commit-less receipt only on the first two; 2 rows, 1 of them Completed naming no commit)
ok    a findings review is submitted before its row flips to Completed: the app's last review naming the newest Completed row's commit is not after that row, on 1 sampled PRs (status_state's 'nothing since the 👀' rests on it, #453)
ok    the gate's own THREADS_QUERY, sent verbatim, answers #9's reviewThreads as a connection: nodes[], a numeric totalCount and a boolean pageInfo.hasNextPage
ok    every thread carries a non-empty node id (resolve's threadId) and isResolved as a boolean (closed only when literally true)
ok    every thread's first comment carries fullDatabaseId as a decimal string (the BigInt threads.thread_id names a thread by, ahead of databaseId)
ok    every thread's first comment carries originalCommit.oid as a 40-hex SHA, and commit as null or a 40-hex oid (threads.threads_by_head splits the open threads by head on them)
ok    databaseId is not clamped past 2^31: on #9's 3 thread(s) whose first comment id is past it, databaseId is null or the very number fullDatabaseId spells (threads.thread_id's fallback)
ok    on a walk of #9 at 2 a page (2 pages), EVERY page states a numeric totalCount, nodes[] and a boolean hasNextPage, with a non-empty endCursor whenever there is a next page (threads_walk reads the last page's count)
ok    ... and the pages add up: each states the verbatim read's totalCount (3), their rows reach it, and the last says hasNextPage false (threads_walk's whole-read test)
skip  reviewThreads paged past 100 threads — no PR here has more than one page of 100 threads; the paging itself is pinned above on a smaller page of the same query
ok    an unpaginated commits/<sha> read answers ONE default page: 300 of 3333333333333333333333333333333333333333's 301 files (a single read is a truncated diff, which is why commit_files pages, and a list of exactly 300 is what its refusal at 300 catches)
ok    commits/<sha>?per_page=100 under --paginate is one commit object per page with files[], each page 100 rows but the last, which has 1 to 100 (the page size commit_files asks for is honoured)
ok    ... and the joined pages are the WHOLE first-parent diff, past 300: 301 rows with distinct, non-empty string filenames (the read commit_files takes as the commit's changed paths is not capped at the default page)
ok    a renamed row carries a non-empty previous_filename (commit_files lists both names as changed paths)
skip  compare's 300-file cap — no compare of that size exists in this repository
EOF
HEALTHY_VERDICTS=${HEALTHY_VERDICTS%$'\n'}

test_a_healthy_world_pins_what_it_can_and_skips_the_rest() {
  local asked world
  world_healthy
  run_contract
  assert_eq "$CONTRACT_RC" 0 "the contract should hold on the healthy world ($CONTRACT_ERR)"
  assert_eq "$(verdicts)" "$HEALTHY_VERDICTS" "the healthy world's verdict lines"
  assert_contains "$CONTRACT_OUT" ", 0 moved," "the verdict should count no moved belief"
  assert_nothing_left "a healthy run"
  # Both directions of the request set: everything asked was answered (or the run would have
  # ended 4), and everything answered was asked — a read the contract stopped making is a dead
  # fixture to remove, not one to keep answering.
  asked=$(tr '/?&=' ',@+~' <"$TEST_ROOT/asked" | sort -u)
  world=$(ls "$WORLD" | sort)
  assert_eq "$asked" "$world" "every answer in the healthy world should be read, and nothing else"
}

test_a_squash_merged_anchor_skips_the_second_parent_claims() {
  world_healthy
  doctor "repos/$REPO/commits/$M7" '.parents |= .[0:1]'
  unanswer "repos/$REPO/commits/$M7/pulls?per_page=100"
  run_contract
  assert_eq "$CONTRACT_RC" 0 "a one-parent anchor should not move a belief ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "skip  a merged PR's head.sha is the head it merged at: the merge commit's second parent (confirm()'s merged-head check) — #7 was squash- or rebase-merged" \
    "a one-parent anchor should skip the second-parent claim, saying why"
  assert_not_contains "$(verdicts)" "GitHub's merge commit is committed by noreply@github.com" \
    "the clean-merge claim rides on the second parent and should not be made"
  assert_contains "$(verdicts)" "ok    \`.base.sha\` is a SNAPSHOT" "the snapshot claim needs only the first parent and should still pin"
  assert_not_contains "$(cat "$TEST_ROOT/asked")" "/pulls?per_page=100" "the merge commit's PR lookup should not be read"
  assert_nothing_left "a squash-anchor run"
}

# The uncomputed shape GitHub served for a merged PR until 2026-10-27 (null, 'unknown') holds the
# merged-mergeability claim as the computed one does (ludics#818): no reader refuses on it, so a
# return to it is not drift. The claim moves on what they refuse on, the doctored rows below.
test_a_merged_anchor_s_uncomputed_mergeability_still_holds() {
  world_healthy
  doctor "repos/$REPO/pulls/7" '.mergeable = null | .mergeable_state = "unknown"'
  run_contract
  assert_eq "$CONTRACT_RC" 0 "a merged anchor answering null/'unknown' should move no belief ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "ok    a merged PR's mergeability never reads as a conflict" "the merged-mergeability claim should pin"
  assert_nothing_left "an uncomputed-anchor run"
}

# The open-PR anchor (ludics#825): the open-PR claims are made on it when nothing else is open,
# and an anchor that stopped being an open draft is a MOVED that names it -- never a quiet skip.
test_the_open_pr_anchor_keeps_the_open_pr_claims_made() {
  local R="repos/$REPO"
  # The anchor alone: the open list's page is empty, and the claims are still made, on it.
  world_healthy
  answer "$R/pulls?state=open&per_page=10" '[]'
  run_contract
  assert_eq "$CONTRACT_RC" 0 "an open anchor with nothing else open should move no belief ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "ok    an open PR's pulls/<n> read carries head.sha, base.ref, updated_at, and mergeable" \
    "the open-PR claims should be made on the anchor"
  assert_contains "$(verdicts)" "ok    the open-PR anchor #12 is open and a draft" "the anchor claim should pin"
  assert_not_contains "$(verdicts)" "skip  open PRs' mergeability and clock fields" "nothing should skip while the anchor is open"
  assert_contains "$(cat "$TEST_ROOT/asked")" "$R/pulls/12" "the anchor should be read though the list does not hold it"
  assert_nothing_left "an anchor-only run"

  # The anchor closed, nothing else open: the one MOVED names it, and the claims skip saying why.
  world_healthy
  answer "$R/pulls?state=open&per_page=10" '[]'
  doctor "$R/pulls/12" '.state = "closed"'
  run_contract
  assert_eq "$CONTRACT_RC" 1 "a closed anchor should end the run 1 ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "MOVED the open-PR anchor #12 is open and a draft" "a closed anchor should be a MOVED that names it"
  assert_eq "$(verdicts | grep -c '^MOVED ' || true)" 1 "the closed anchor should be the one MOVED"
  assert_contains "$(verdicts)" "skip  open PRs' mergeability and clock fields — no open PR right now, and the anchor #12 is not open — see the MOVED above" \
    "the open-PR claims should skip, pointing at the anchor"
  assert_nothing_left "a closed-anchor run"

  # The anchor closed, another PR open: the claims are made on that one, and the closed anchor's
  # row is not among them.
  world_healthy
  answer "$R/pulls?state=open&per_page=10" '[{"number":13}]'
  answer "$R/pulls/13" "{\"number\":13,\"state\":\"open\",\"draft\":false,\"head\":{\"sha\":\"$H13\"},\"base\":{\"ref\":\"main\"},\"created_at\":\"2026-09-30T09:00:00Z\",
    \"updated_at\":\"2026-09-30T09:30:00Z\",\"mergeable\":true,\"mergeable_state\":\"clean\"}"
  doctor "$R/pulls/12" '.state = "closed" | .mergeable_state = "surprise"'
  run_contract
  assert_eq "$CONTRACT_RC" 1 "a closed anchor beside an open PR should end the run 1 ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "MOVED the open-PR anchor #12 is open and a draft" "the closed anchor should be the MOVED"
  assert_eq "$(verdicts | grep -c '^MOVED ' || true)" 1 "a closed anchor's own fields should not be judged as an open PR's"
  assert_contains "$(verdicts)" "ok    ... and a mergeable_state in the vocabulary status_state renders" "the open PR's claims should be made"
  assert_contains "$CONTRACT_OUT" "open PRs: #13 clean" "only the open PR should be among the open PRs read"
  assert_nothing_left "a closed-anchor run beside an open PR"

  # No anchor named (another repository's run): a skip that says what to set, and the open list's
  # own PRs judged as before.
  world_healthy
  run_contract CONTRACT_OPEN_PR=
  assert_eq "$CONTRACT_RC" 0 "a run naming no anchor should move no belief ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "skip  the open-PR anchor is an open draft — set CONTRACT_OPEN_PR to a long-lived draft PR" \
    "a run naming no anchor should say so"
  assert_contains "$(verdicts)" "ok    an open PR's pulls/<n> read carries" "the listed open PR should still be judged"
  run_contract CONTRACT_OPEN_PR=12x
  assert_eq "$CONTRACT_RC" 2 "an anchor that is not a PR number should be refused ($CONTRACT_ERR)"
  assert_contains "$CONTRACT_ERR" "CONTRACT_OPEN_PR must be a PR number, got '12x'" "the refusal should name the value"
  assert_nothing_left "a refused-anchor run"
}

# The Review-trigger belief names the gate's own vocabulary (state.REVIEW_TRIGGERS, read from the
# gate rather than restated), and a sample with no commit-less Completed row says so as a skip
# beside the claim rather than as a pass about rows it never saw (ludics#825).
test_the_review_trigger_claim_is_the_gate_s_vocabulary() {
  local R="repos/$REPO" words
  words=$("$GATE_PY" -c 'import sys; sys.stdout.reconfigure(newline="\n")
from ludics.prreview.state import REVIEW_TRIGGERS; print(", ".join(REVIEW_TRIGGERS))')
  world_healthy
  run_contract
  assert_contains "$(verdicts)" "ok    every Code Review row's Review trigger cell is a word the gate knows, $words (" \
    "the claim should name the gate's vocabulary"
  world_healthy
  doctor "$R/issues/7/comments?per_page=100" '.[0:1]'
  run_contract
  assert_eq "$CONTRACT_RC" 0 "a sample with no commit-less row should move no belief ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "ok    every Code Review row's Review trigger cell is a word the gate knows, $words (_receipt_binding approves a commit-less receipt only on the first two; 1 rows, 0 of them Completed naming no commit)" \
    "the claim should still be made on the stamped rows"
  assert_contains "$(verdicts)" "skip  a Completed row naming no commit carries a known Review trigger, live — none among the sampled 1 rows" \
    "a sample with no commit-less row should say so"
  assert_nothing_left "a run with no commit-less row"
}

# One response moved at a time, each a field or a word some projection reads: the pin that names
# it must say MOVED, and it alone, and the run must end 1 with every other claim still made.
# The review-state row is the #278 shape: a vocabulary pin that cannot fail passed {state:
# "surprise"}; this one must not.
test_a_doctored_response_moves_its_pin_and_only_it() {
  local row endpoint filter belief R="repos/$REPO"
  for row in \
    "$R/actions/runs?head_sha=$TIP&per_page=100^.workflow_runs[1] |= del(.created_at)^MOVED every row carries the fields the fold indexes" \
    "$R/actions/runs?head_sha=$TIP&per_page=100^.workflow_runs[0] |= (.status = \"surprise\" | .conclusion = null)^MOVED status strings are in the known vocabulary" \
    "$R/actions/runs?head_sha=$TIP&per_page=100^.workflow_runs[0] |= del(.conclusion)^MOVED every row carries conclusion (present, null until completed) and it is in the vocabulary" \
    "$R/actions/workflows?per_page=100^.workflows[0].state = \"paused\"^MOVED every workflow carries a state drawn from the vocabulary" \
    "$R/actions/runs/201/jobs?per_page=100^.jobs[0] |= del(.completed_at)^MOVED jobs[] rows carry an ISO created_at, and every finished job an ISO completed_at" \
    "$R/commits/$TIP/check-runs?filter=latest&per_page=100^.check_runs[0].conclusion = \"surprise\"^MOVED check-run conclusions are in the vocabulary" \
    "$R/commits/$TIP/check-runs?filter=latest&per_page=100^.check_runs[1].conclusion = null^MOVED every check run carries a status string, never \"completed\" while its conclusion is null" \
    "$R/commits/$M7^.commit.verification.verified = false^MOVED GitHub's merge commit is committed by noreply@github.com" \
    "$R/pulls/7^.mergeable = false^MOVED a merged PR's mergeability never reads as a conflict" \
    "$R/pulls/7^.mergeable_state = \"dirty\"^MOVED a merged PR's mergeability never reads as a conflict" \
    "$R/pulls/7^del(.mergeable)^MOVED a merged PR's mergeability never reads as a conflict" \
    "$R/pulls/7^.mergeable_state = \"surprise\"^MOVED a merged PR's mergeability never reads as a conflict" \
    "$R/pulls/12^.mergeable_state = \"surprise\"^MOVED ... and a mergeable_state in the vocabulary" \
    "$R/pulls/12^.draft = false^MOVED the open-PR anchor #12 is open and a draft" \
    "$R/issues/7/comments?per_page=100^.[0].body |= sub(\"New commits\"; \"Ready for review\")^MOVED every Code Review row's Review trigger cell is a word the gate knows" \
    "$R/issues/7/comments?per_page=100^.[1].body |= sub(\" [|] PR opened [|]\"; \" |\")^MOVED every Code Review row's Review trigger cell is a word the gate knows" \
    "$R/pulls/9/reviews?per_page=100^.[2].state = \"surprise\"^MOVED the app's review states are in the vocabulary" \
    "$R/pulls/9/comments?per_page=100^.[1] |= del(.original_line)^MOVED inline comments carry numeric id" \
    "$R/pulls/9/reviews/31/comments?per_page=100^.[1] |= del(.original_position)^MOVED the per-review rows carry what poll renders" \
    "graphql?pr=9&first=100&after=-^.data.repository.pullRequest.reviewThreads.nodes[0].isResolved = \"true\"^MOVED every thread carries a non-empty node id (resolve's threadId) and isResolved as a boolean" \
    "graphql?pr=9&first=2&after=c2^.data.repository.pullRequest.reviewThreads.totalCount = 4^MOVED ... and the pages add up: each states the verbatim read's totalCount (3)" \
    "graphql?pr=9&first=100&after=-^.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].databaseId = 2147483647^MOVED databaseId is not clamped past 2^31" \
    "graphql?pr=9&first=100&after=-^.data.repository.pullRequest.reviewThreads.nodes[1].comments.nodes[0].originalCommit = null^MOVED every thread's first comment carries originalCommit.oid as a 40-hex SHA" \
    "graphql?pr=9&first=100&after=-^.data.repository.pullRequest.reviewThreads.nodes[2].comments.nodes[0].commit = {oid: \"abc1234\"}^MOVED every thread's first comment carries originalCommit.oid as a 40-hex SHA" \
    "repos/$WIDE_REPO/commits/$WIDE^.files |= .[:30]^MOVED an unpaginated commits/<sha> read answers ONE default page"; do
    IFS='^' read -r endpoint filter belief <<<"$row"
    world_healthy
    doctor "$endpoint" "$filter"
    run_contract
    assert_eq "$CONTRACT_RC" 1 "doctoring $endpoint with '$filter' should end the run 1 ($CONTRACT_ERR)"
    assert_contains "$(verdicts)" "$belief" "doctoring $endpoint with '$filter' should move its pin"
    assert_eq "$(verdicts | grep -c '^MOVED ' || true)" 1 "doctoring $endpoint with '$filter' should move that pin alone"
    assert_contains "$CONTRACT_OUT" ", 1 moved," "the verdict should count the one moved belief"
    assert_nothing_left "a run that moved"
  done
}

# A wrapper that moved is ONE MOVED, and the row-level claims on it skip with UNUSABLE instead of
# crashing a jq under errexit or reading an empty list as "no rows". The jobs feed's moved wrapper
# is on its second page, which only a `pages` that reads every page can see.
test_a_moved_wrapper_is_one_moved_and_its_rows_skip() {
  local R="repos/$REPO"
  world_healthy
  doctor "$R/actions/runs?head_sha=$TIP&per_page=100" 'del(.workflow_runs)'
  run_contract
  assert_eq "$CONTRACT_RC" 1 "a moved runs wrapper should end the run 1 ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "MOVED the feed is workflow_runs[]" "the wrapper claim should record the move"
  assert_contains "$(verdicts)" "skip  the row-level claims on the tip's runs — its input is not usable — see the MOVED above" \
    "the row-level claims should skip on the unusable list"
  assert_contains "$(verdicts)" "skip  workflow_id resolves to a workflow file — its input is not usable" \
    "the read built from a moved row's field should not be made"
  assert_eq "$(verdicts | grep -c '^MOVED ' || true)" 1 "the moved wrapper should be the one MOVED"
  assert_nothing_left "a moved-wrapper run"

  world_healthy
  answer "$R/actions/runs/201/jobs?per_page=100" \
    '{"total_count":2,"jobs":[{"name":"test","status":"completed","conclusion":"failure"}]}' '{"total_count":2}'
  run_contract
  assert_eq "$CONTRACT_RC" 1 "a jobs page without its wrapper should end the run 1 ($CONTRACT_ERR)"
  assert_contains "$(verdicts)" "MOVED the feed is jobs[] (run 201, the latest red run: failure)" \
    "a wrapper missing from the second page should move the feed claim"
}

# Exit 3 is transport, not drift, and it ends the run at once — after the retries, with the
# scratch directory gone and no verdict claimed (ludics-lite#195's manual check, as a case).
test_an_unanswered_api_exits_3_and_leaves_nothing_behind() {
  world_healthy
  run_contract CONTRACT_FIXTURE_FAIL="HTTP 502"
  assert_eq "$CONTRACT_RC" 3 "an API that never answers should end the run 3 ($CONTRACT_ERR)"
  assert_contains "$CONTRACT_ERR" "the API did not answer: gh api repos/$REPO" "the message should name the read"
  assert_eq "$(wc -l <"$TEST_ROOT/calls" | tr -d ' ')" 3 "the first read should be tried three times, and nothing after it"
  assert_not_contains "$CONTRACT_OUT" "beliefs checked" "no verdict should be claimed"
  assert_not_contains "$CONTRACT_ERR" "stopped early" "exit 3 is a chosen exit"
  assert_nothing_left "an exit 3"
  run_contract CONTRACT_FIXTURE_FAIL="HTTP 401"
  assert_eq "$CONTRACT_RC" 5 "a refused read should end the run 5 ($CONTRACT_ERR)"
  assert_nothing_left "an exit 5"
  world_healthy
  unanswer "repos/$REPO/pulls/12"
  run_contract
  assert_eq "$CONTRACT_RC" 4 "a read the API answers 404 should end the run 4 ($CONTRACT_ERR)"
  assert_contains "$CONTRACT_ERR" "answered 4xx (retired, renamed, or a wrong anchor): gh api repos/$REPO/pulls/12" \
    "the message should name the endpoint"
  assert_nothing_left "an exit 4"
}

# The contract speaks in the gate's words by asking the gate's Python for them (the branch
# encoder first), so a Python that does not answer is a usage-class stop, exit 2 -- never an
# empty ref read as the base. Run from a copy of the two scripts whose checkout's scripts/py
# fails, since the contract finds its runner beside itself as pr-review.sh's forward does.
test_a_gate_python_that_does_not_answer_exits_2() {
  local tree="$TEST_ROOT/no-py"
  rm -rf "${tree:?}"
  mkdir -p "$tree/ship-pr/scripts" "$tree/scripts"
  cp "$SCRIPT_DIR/pr-review.sh" "$SCRIPT_DIR/pr-review-api-contract.sh" "$tree/ship-pr/scripts/"
  printf '#!/bin/sh\necho "no gate here" >&2\nexit 1\n' >"$tree/scripts/py"
  chmod +x "$tree/scripts/py"
  world_healthy
  local CONTRACT="$tree/ship-pr/scripts/pr-review-api-contract.sh"
  run_contract
  assert_eq "$CONTRACT_RC" 2 "a gate Python that does not answer should end the run 2 ($CONTRACT_ERR)"
  assert_contains "$CONTRACT_ERR" "the gate's Python ($tree/scripts/py) did not answer; the contract cannot speak in its words" \
    "the message should name the runner"
  assert_eq "$(cat "$TEST_ROOT/calls")" "api repos/$REPO" "the run should stop after the repository read, before reading an unencoded ref"
  assert_not_contains "$CONTRACT_OUT" "beliefs checked" "no verdict should be claimed"
  assert_nothing_left "an exit 2"
}

tests=(
  test_sourcing_stops_before_the_first_read
  test_pages_joins_every_page_and_nulls_a_moved_wrapper
  test_pin_and_skip_count_and_report
  test_is_list_and_the_read_guards
  test_api_sorts_a_failed_read_by_its_status
  test_the_instant_def_answers_as_the_gate_s_instant
  test_the_exit_trap_cleans_up_and_names_an_unchosen_exit
  test_a_healthy_world_pins_what_it_can_and_skips_the_rest
  test_a_squash_merged_anchor_skips_the_second_parent_claims
  test_a_merged_anchor_s_uncomputed_mergeability_still_holds
  test_the_open_pr_anchor_keeps_the_open_pr_claims_made
  test_the_review_trigger_claim_is_the_gate_s_vocabulary
  test_a_doctored_response_moves_its_pin_and_only_it
  test_a_moved_wrapper_is_one_moved_and_its_rows_skip
  test_an_unanswered_api_exits_3_and_leaves_nothing_behind
  test_a_gate_python_that_does_not_answer_exits_2
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
