#!/usr/bin/env bash
# Focused fixture tests for pr-review.sh's `retry`: the plain retry's line between an answer, a
# caller error and transport, and `retry run watch`'s — how the run is addressed, and the line
# between an invocation error and a verdict about the run (ludics-lite#74).
#
# The await used to resolve the repository from the cwd when no -R/REPO named one. A worker whose
# background shell had started in another project's worktree awaited a run id from this one: the
# read 404'd against the repo the cwd named, and the await exited 1 — a red gate manufactured out
# of a wrong-target invocation. So the run now travels as owner/name#<run-id>, like every other
# subcommand's argument, and the cases below pin BOTH halves: the refusals that replaced the
# guess, and the exits 0/1/3/4 that must survive them (a refusal policy that swallowed the real
# verdicts would be worse than the inference it replaced).
#
# It also pins the plain `retry`'s line between a GraphQL answer and transport (ludics-lite#422): a
# query-cost rejection was retried four times and reported as "the API never answered", and so was
# a NOT_FOUND for an issue that does not exist (ludics-lite#663). The fixed-answer bodies below are
# verbatim from real `gh` 2.101.0 calls; each must exit 1 on its first attempt, while a gateway
# failure and the near-misses outside the allowlist still retry to exit 3.
# And gh's own refusal of a caller's arguments (ludics-lite#452): `gh pr view 1 --json nosuchfield`
# sends nothing, yet was retried four times and reported as exit 3. Those bodies are verbatim too,
# and each must exit 2 on its first attempt, while their near-misses still retry to exit 3 (Cobra's
# flag-syntax and minimum-count refusals joined in ludics-lite#468; the `discussion` path did not). And
# gh refusing an argument the SCRIPT sends (ludics-lite#471: a gh upgrade renaming a field) stops the
# whole command with exit 2, where it used to retry to exit 3 and leave `watch` re-arming forever.

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
test_tmpdir TEST_ROOT retry-test

CALL_LOG="$TEST_ROOT/gh-calls"
: >"$CALL_LOG"

RUN_STATUS=completed
RUN_CONCLUSION=success
RUN_ERROR="" # gh's stderr when the read must fail, e.g. "gh: Not Found (HTTP 404)"
# What `repo_from_cwd` would answer if anything asked it. The point of every refusal case below is
# that nothing does: this value must never reach a run read.
CWD_REPO=cwd-inferred/repo
# What a failing `gh api graphql` prints: GQL_ERROR on stderr (a case always sets it) and GQL_OUT on
# stdout, where `gh api graphql` puts the error document itself.
GQL_ERROR=""
GQL_OUT=""
# What gh prints on stderr when it refuses its arguments before sending anything: any call made
# while it is set fails with it, whatever the command, since the refusal is gh's and not the API's.
CLIENT_ERROR=""
# What gh prints when it withholds an answer for the terminal escape sequences in it.
ESCAPE_REFUSAL='the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway'

# The fixture gh. Not gh_fixture_parse: that one refuses everything but `gh api`, and this await
# reads `gh run view`. `repo view` is answered rather than refused ON PURPOSE — it is the first
# thing the removed cwd inference asked, so a regression that brings the guess back shows up as a
# `run view` in the call log instead of as a fixture error nobody can attribute.
gh() {
  local filter="" repo="" run_id="" json=""
  printf '%s\n' "$*" >>"$CALL_LOG"
  if [ -n "$CLIENT_ERROR" ]; then
    printf '%s\n' "$CLIENT_ERROR" >&2
    return 1
  fi
  case "$1 ${2:-}" in
  "repo view")
    printf '%s\n' "$CWD_REPO"
    return 0
    ;;
  "run view") ;;
  # Two answers for the plain retry's own output: one with a NUL byte and an invalid one in it, and
  # one far longer than a pipe holds.
  "api nul")
    printf 'a\0b\377c\n'
    return 0
    ;;
  "api lines")
    awk 'BEGIN { for (i = 1; i <= 200000; i++) print i }'
    return 0
    ;;
  # A job's log, plain text with ANSI colour in it (post-wave-3 task 8): gh withholds such a body
  # unless the call opts in, after the API has answered, and exits 1 -- the refusal is verbatim
  # from gh 2.101.0 reading a real Actions job log with its stdout redirected to a file.
  "api repos/"*"/actions/jobs/"*"/logs")
    case " $* " in
    *" --allow-escape-sequences "*)
      printf '\033[36;1mstep\033[0m ok\n'
      return 0
      ;;
    esac
    printf '%s\n' "$ESCAPE_REFUSAL" >&2
    return 1
    ;;
  "api graphql")
    [ -n "$GQL_ERROR" ] || bail "fixture api graphql was called with no GQL_ERROR set: $*"
    printf '%s' "$GQL_OUT"
    printf '%s\n' "$GQL_ERROR" >&2
    return 1
    ;;
  *)
    echo "gh: unsupported fixture call: $*" >&2
    return 1
    ;;
  esac
  shift 2
  run_id="${1:-}"
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
    --repo)
      repo="${2:-}"
      shift
      ;;
    --jq)
      filter="${2:-}"
      shift
      ;;
    --json) shift ;;
    esac
    shift
  done
  [ -n "$run_id" ] || bail "fixture run view got no run id: $*"
  [ -n "$repo" ] || bail "fixture run view got no --repo: $*"
  if [ -n "$RUN_ERROR" ]; then
    echo "$RUN_ERROR" >&2
    return 1
  fi
  json=$(jq -cn --arg s "$RUN_STATUS" --arg c "$RUN_CONCLUSION" \
    '{status:$s, conclusion:(if $c == "" then null else $c end)}')
  if [ -n "$filter" ]; then jq -r "$filter" <<<"$json"; else printf '%s\n' "$json"; fi
}

reset_fixture() {
  RUN_STATUS=completed
  RUN_CONCLUSION=success
  RUN_ERROR=""
  GQL_ERROR=""
  GQL_OUT=""
  CLIENT_ERROR=""
  REPO=""
  AWAIT_WAIT=""
  : >"$CALL_LOG"
}

# `retry run watch` in a command substitution: its refusals call `exit`, and a subshell is what
# keeps them from ending this reporter. The subshell is also where AWAIT_WAIT is applied, so a case
# that shortens the deadline cannot leak that to the next one. It drives the subcommand a caller
# runs, `cmd_retry`, and not the await's internal function, so the cases hold whichever language
# serves the subcommand (ludics-lite#403).
AWAIT_WAIT=""
run_await() {
  local rc
  : >"$CALL_LOG"
  set +e
  AWAIT_OUT=$(CHECKS_WAIT="${AWAIT_WAIT:-$CHECKS_WAIT}" cmd_retry run watch "$@" 2>&1)
  rc=$?
  set -e
  AWAIT_RC="$rc"
}

gh_calls() { cat "$CALL_LOG"; }
# How many `gh api` calls were made: the log has a line per call, but a call's field can hold
# newlines of its own (a reply's body, a GraphQL query), so the calls are counted by their head.
api_calls() { grep -c '^api ' "$CALL_LOG" || true; }

# cmd_retry in a command substitution, for the same reason: its verdicts call `exit`.
run_retry() {
  local rc
  : >"$CALL_LOG"
  set +e
  RETRY_OUT=$(cmd_retry "$@" 2>&1)
  rc=$?
  set -e
  RETRY_RC="$rc"
}

# A scratch checkout whose origin is a third repository, so the git half of the removed inference
# is armed too: `repo_from_cwd` falls back to `git remote get-url origin` when gh does not answer.
# It sets CWD_CHECKOUT rather than printing the path: test_tmpdir registers the directory for
# removal in the shell it runs in, and a $(...) would register it in a subshell that then exits.
CWD_CHECKOUT=""
scratch_checkout() {
  test_tmpdir CWD_CHECKOUT cwd-checkout
  git -C "$CWD_CHECKOUT" init -q >/dev/null 2>&1 || bail "git init failed in $CWD_CHECKOUT"
  git -C "$CWD_CHECKOUT" remote add origin https://github.com/cwd-git/repo.git ||
    bail "git remote add failed in $CWD_CHECKOUT"
}

# --- the refusals that replaced the guess -----------------------------------------------------

# The regression control. Both inference paths are armed — the fixture answers `repo view`, and
# the cwd is a checkout whose origin names yet another repo — and the await must still refuse
# without reading anything. On the old code this case reports exit 1 over `cwd-inferred/repo`.
test_bare_run_id_without_a_repo_is_refused() {
  local rc
  reset_fixture
  scratch_checkout
  : >"$CALL_LOG"
  set +e
  AWAIT_OUT=$(cd "$CWD_CHECKOUT" && cmd_retry run watch 12345 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "a bare run id with no repo is an invocation error ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "name the repo" "the refusal should say what is missing"
  assert_contains "$AWAIT_OUT" "owner/name#12345" "the refusal should spell the accepted form"
  assert_contains "$AWAIT_OUT" "ludics-lite#74" "the refusal should cite the failure it prevents"
  assert_not_contains "$AWAIT_OUT" "cwd-inferred/repo" "the cwd's repo must not be named as a target"
  assert_not_contains "$AWAIT_OUT" "cwd-git/repo" "the origin remote must not be named as a target"
  assert_eq "$(gh_calls)" "" "nothing may be read before the repo is known"
}

# The positive control on that refusal: the same bare id passes the moment a repo is named, so the
# refusal is about the missing repo and not about the bare form.
test_bare_run_id_with_a_named_repo_is_accepted() {
  reset_fixture
  run_await -R example/repo 12345
  assert_eq "$AWAIT_RC" 0 "a bare id with -R should run ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "run 12345 in example/repo: success" "the verdict line"
  assert_contains "$(gh_calls)" "--repo example/repo" "the read should name the repo given"
  reset_fixture
  REPO=env/repo
  run_await 12345
  assert_eq "$AWAIT_RC" 0 "a bare id with REPO= should run ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "run 12345 in env/repo: success" "REPO= names the target too"
}

# The form the skill now documents.
test_owner_name_hash_run_is_accepted() {
  reset_fixture
  REPO=env/repo
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 0 "owner/name#<run-id> should run ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "run 4242 in example/repo: success" "the verdict names the argument's repo"
  assert_contains "$(gh_calls)" "run view 4242 --repo example/repo" "the read should use the argument"
  assert_not_contains "$(gh_calls)" "env/repo" "the argument overrides the REPO= default"
}

# Two spellings that both name a target and disagree: refused, not silently resolved either way.
test_conflicting_repos_are_refused() {
  reset_fixture
  run_await -R other/repo example/repo#4242
  assert_eq "$AWAIT_RC" 2 "two disagreeing targets are an invocation error ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "example/repo" "the refusal should name the argument's repo"
  assert_contains "$AWAIT_OUT" "other/repo" "the refusal should name the flag's repo"
  assert_eq "$(gh_calls)" "" "nothing may be read while the target is ambiguous"
  # The negative control: the same two spellings AGREEING are not a conflict.
  reset_fixture
  run_await -R example/repo example/repo#4242
  assert_eq "$AWAIT_RC" 0 "two spellings that agree should run ($AWAIT_OUT)"
}

test_malformed_run_argument_is_refused() {
  reset_fixture
  run_await example/repo#abc
  assert_eq "$AWAIT_RC" 2 "a non-numeric run id is refused ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "owner/name#<run-id>" "the refusal should spell the form"
  reset_fixture
  run_await example/repo
  assert_eq "$AWAIT_RC" 2 "a repo with no run id is refused ($AWAIT_OUT)"
  reset_fixture
  run_await
  assert_eq "$AWAIT_RC" 2 "no run argument at all is refused ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "name the run" "the refusal should say what is missing"
  reset_fixture
  run_await example/repo#1 example/repo#2
  assert_eq "$AWAIT_RC" 2 "two run arguments are refused ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "name exactly one" "the refusal should say so"
  assert_eq "$(gh_calls)" "" "a malformed invocation reads nothing"
}

# An argument that carries unparsed input in FRONT of a valid one is the same wrong-target
# failure, arriving through the parse instead of through the cwd: taking the tail after the last
# `#` would name run 222 and run 123 here, and answer about them.
test_unparsed_prefixes_are_refused() {
  reset_fixture
  run_await example/repo#111#222
  assert_eq "$AWAIT_RC" 2 "a second '#' is refused ($AWAIT_OUT)"
  assert_eq "$(gh_calls)" "" "run 222 must not be read"
  reset_fixture
  run_await -R example/repo junk#123
  assert_eq "$AWAIT_RC" 2 "a junk prefix before '#' is refused ($AWAIT_OUT)"
  assert_eq "$(gh_calls)" "" "run 123 must not be read"
  reset_fixture
  run_await -R example/repo '#123'
  assert_eq "$AWAIT_RC" 2 "a bare '#123' is refused ($AWAIT_OUT)"
  reset_fixture
  run_await example/repo/extra#4242
  assert_eq "$AWAIT_RC" 2 "a third path segment is refused ($AWAIT_OUT)"
  reset_fixture
  run_await "example repo#4242"
  assert_eq "$AWAIT_RC" 2 "a repo outside GitHub's name characters is refused ($AWAIT_OUT)"
  assert_eq "$(gh_calls)" "" "nothing may be read on any of these"
}

# --- the verdicts the refusals must not swallow -----------------------------------------------

# A 4xx is the API answering about the pair you named, so it is an invocation error too — but it
# must not borrow exit 1 from the run's own failure, which is what read as a red gate.
test_a_rejected_pair_is_not_a_failed_run() {
  reset_fixture
  RUN_ERROR="gh: Not Found (HTTP 404)"
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 2 "a 404 on the pair is an invocation error ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "no run 4242 readable here" "the refusal should name the pair"
  assert_contains "$AWAIT_OUT" "not a failure" "it must say what it is not"
  assert_not_contains "$AWAIT_OUT" "FAILED" "a 404 is not a verdict about the run"
}

# The negative control for the case above: exit 1 is still reachable, and only a real conclusion
# reaches it. Without this, "a 404 is not exit 1" would be a claim that cannot fail.
test_a_failed_run_is_still_exit_1() {
  reset_fixture
  RUN_CONCLUSION=failure
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 1 "a failed run is the verdict ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "the run FAILED" "the verdict should say so"
  assert_contains "$AWAIT_OUT" "--log-failed" "and point at the failure"
}

# Transport stays apart from both: nothing was learned, so nothing is claimed.
test_transport_failure_is_unknown() {
  reset_fixture
  RUN_ERROR="gh: Something went wrong (HTTP 503)"
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 3 "an unanswered read is transport ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "UNKNOWN" "it should say the state is unknown"
  assert_not_contains "$AWAIT_OUT" "not a failure, so it is" "no verdict is implied"
  # The run read is a READ: a 500, which the write policy would take as ambiguous and stop on after
  # one call, is retried to the last attempt.
  reset_fixture
  retune API_ATTEMPTS=3
  RUN_ERROR="gh: HTTP 500: Internal Server Error"
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 3 "a 500 on the run read is transport ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "after 3 attempts" "after every attempt"
  assert_eq "$(grep -c '^run view' "$CALL_LOG")" 3 "the run read is retried like a read"
}

# And a run still going at the deadline is exit 4, stopped-not-judged like everywhere else.
test_no_verdict_is_exit_4() {
  reset_fixture
  RUN_STATUS=in_progress
  RUN_CONCLUSION=""
  AWAIT_WAIT=0
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 4 "a run still going at the deadline has no verdict ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "NO VERDICT" "it should say so"
  assert_contains "$AWAIT_OUT" "in_progress" "and report the status it read"
}

# --- a GraphQL answer is not transport (ludics-lite#422) ------------------------------------

# Every allowlisted shape, verbatim, under both prefixes gh prints: `gh: ` from `gh api graphql`
# (whose stdout then carries the error document) and `GraphQL: ` from every other command (the
# cost body is the one `gh pr list --json commits --limit 1000` printed). Each is the API's
# answer, so the read stops on its first attempt and says it was rejected.
test_a_fixed_graphql_answer_is_a_rejection() {
  local body
  local -a bodies=(
    'GraphQL: By the time this query traverses to the authors connection, it is requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000.'
    'gh: By the time this query traverses to the comments connection, it is requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000.'
    'gh: Requesting 101 records on the `repositories` connection exceeds the `first` limit of 100 records.'
    'gh: Requesting 101 records on the `repositories` connection exceeds the `last` limit of 100 records.'
    "gh: Field 'nosuchfield' doesn't exist on type 'User'"
    'gh: Expected NAME, actual: (none) ("") at [1, 12]'
    'gh: Expected one of SCHEMA, SCALAR, TYPE, ENUM, INPUT, UNION, INTERFACE, actual: RCURLY ("}") at [1, 22]'
    # A gateway marker the message only QUOTES, from `{ viewer { login "Bad gateway" } }`: the
    # gateway scan reads substrings, so the allowlist has to be read before it (review round 1).
    'gh: Expected NAME, actual: STRING ("Bad gateway") at [1, 18]'
  )
  retune API_ATTEMPTS=3
  for body in "${bodies[@]}"; do
    reset_fixture
    GQL_ERROR="$body"
    GQL_OUT='{"errors":[{"message":"(the error document gh api graphql prints)"}]}'
    run_retry --read api graphql -f query=q
    assert_eq "$RETRY_RC" 1 "a fixed answer is exit 1 ($body: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "was rejected: $body" "the message is the API's answer, quoted"
    assert_not_contains "$RETRY_OUT" "never answered" "the API did answer ($body)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and it is not re-sent ($body)"
  done
  # The write policy too, on every body: rejected rather than ambiguous, since a query GraphQL
  # refused to validate ran nothing, and not re-sent even where the body quotes a gateway marker,
  # which the write policy's own gateway scan would otherwise retry (review round 2).
  for body in "${bodies[@]}"; do
    reset_fixture
    GQL_ERROR="$body"
    run_retry api graphql -f query=q
    assert_eq "$RETRY_RC" 1 "a write whose query was refused is exit 1 ($body: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "was rejected: $body" "and is reported as rejected"
    assert_not_contains "$RETRY_OUT" "AMBIGUOUSLY" "not as a write that may have landed ($body)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "nor re-sent ($body)"
  done
}

# GraphQL's NOT_FOUND (ludics-lite#663): a wave issue that does not exist was read four times and
# reported as the API never answering. Verbatim from gh 2.101.0, `gh api graphql`'s bare line (its
# stdout the real error document) and gh's own commands' line with the error's path. Never re-sent;
# a read is the fact (exit 1), but a write stays ambiguous (exit 3), since unlike a query GraphQL
# refused to validate, the document ran and another of its fields may have landed.
test_a_graphql_not_found_is_fixed() {
  local body
  local -a bodies=(
    'gh: Could not resolve to an Issue with the number of 99999.'
    "gh: Could not resolve to a Repository with the name 'lukstafi/no-such-repo-xyz'."
    'GraphQL: Could not resolve to an issue or pull request with the number of 99999. (repository.issue)'
  )
  retune API_ATTEMPTS=3
  for body in "${bodies[@]}"; do
    reset_fixture
    GQL_ERROR="$body"
    GQL_OUT='{"data":{"repository":{"issue":null}},"errors":[{"type":"NOT_FOUND","path":["repository","issue"],"locations":[{"line":1,"column":50}],"message":"Could not resolve to an Issue with the number of 99999."}]}'
    run_retry --read api graphql -f query=q
    assert_eq "$RETRY_RC" 1 "a read of what does not exist is exit 1 ($body: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "was rejected: $body" "the message is the API's answer, quoted"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and it is not re-sent ($body)"
    reset_fixture
    GQL_ERROR="$body"
    run_retry api graphql -f query=q
    assert_eq "$RETRY_RC" 3 "a write that met a NOT_FOUND may have landed a field ($body: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "AMBIGUOUSLY" "so it is reported as ambiguous ($body)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and not re-sent ($body)"
  done
}

# The control: a gateway failure and GraphQL's execution failure are transport and still retry to
# exit 3, so the case above cannot pass by never retrying anything.
test_a_graphql_outage_still_retries() {
  local body
  retune API_ATTEMPTS=3
  for body in 'gh: HTTP 502: Bad gateway (https://api.github.com/graphql)' \
    'gh: Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `0D8E:1234:5678:9ABC:66F0A1B2` when reporting this issue.'; do
    reset_fixture
    GQL_ERROR="$body"
    run_retry --read api graphql -f query=q
    assert_eq "$RETRY_RC" 3 "an outage is transport ($body: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "never answered" "and is reported as unknown"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "after every attempt ($body)"
  done
}

# The near-misses: an allowlisted sentence anywhere but as the whole first stderr line after one of
# gh's two prefixes keeps the retry. Behind another prefix; with gh's ` (<path>)` suffix; on the
# second line; and in stdout only, where a read's data can quote it.
test_a_near_miss_still_retries() {
  local body
  local -a bodies=(
    'gh: proxy: By the time this query traverses to the comments connection, it is requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000.'
    "GraphQL: Field 'nosuchfield' doesn't exist on type 'User' (query.viewer.nosuchfield)"
    $'gh: Something went wrong (HTTP 500)\ngh: Field \'nosuchfield\' doesn\'t exist on type \'User\''
    # NOT_FOUND's path suffix is `GraphQL: `'s alone, and required there.
    'gh: Could not resolve to an Issue with the number of 99999. (repository.issue)'
    'GraphQL: Could not resolve to an Issue with the number of 99999.'
  )
  retune API_ATTEMPTS=3
  for body in "${bodies[@]}"; do
    reset_fixture
    GQL_ERROR="$body"
    run_retry --read api graphql -f query=q
    assert_eq "$RETRY_RC" 3 "outside the allowlist keeps the retry ($body: $RETRY_OUT)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "every attempt was spent ($body)"
  done
  reset_fixture
  GQL_ERROR='gh: Something went wrong (HTTP 500)'
  GQL_OUT="{\"body\":\"gh: Field 'nosuchfield' doesn't exist on type 'User'\"}"
  run_retry --read api graphql -f query=q
  assert_eq "$RETRY_RC" 3 "a sentence in stdout is not read ($RETRY_OUT)"
  assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "so the read is retried"
}

# --- gh refusing the caller's arguments (ludics-lite#452) -------------------------------------

# Every allowlisted shape, verbatim from gh 2.101.0 with the lines gh prints after it, each from a
# call that sent nothing (the command is beside it). A refusal is the caller's error, so it stops on
# its first attempt and exits 2 under both policies: re-sending prints the same refusal, and a write
# whose arguments gh refused cannot have landed.
test_a_client_refusal_is_a_usage_error() {
  local body mode
  local -a bodies=(
    # gh pr view 1 --repo lukstafi/ludics --json nosuchfield
    $'Unknown JSON field: "nosuchfield"\nAvailable fields:\n  additions'
    # gh pr view 1 --repo lukstafi/ludics --json 'a b'
    $'Unknown JSON field: "a b"\nAvailable fields:\n  additions'
    # gh pr list --repo lukstafi/ludics --json
    $'Specify one or more comma-separated fields for `--json`:\n  additions'
    # gh pr view 1 --repo lukstafi/ludics --nosuchflag
    $'unknown flag: --nosuchflag\n\nDisplay the title, body, and other information about a pull request.'
    # gh pr list --repo lukstafi/ludics --foo_bar (review round 1: punctuation in the name)
    'unknown flag: --foo_bar'
    # gh pr list --repo lukstafi/ludics --foo.bar
    'unknown flag: --foo.bar'
    # gh pr list --repo lukstafi/ludics -_
    "unknown shorthand flag: '_' in -_"
    # gh pr view 1 --repo lukstafi/ludics -z
    $'unknown shorthand flag: \'z\' in -z\n\nDisplay the title, body, and other information about a pull request.'
    # gh pr view 1 --repo lukstafi/ludics --jq
    $'flag needs an argument: --jq\n'
    # gh api -X
    $'flag needs an argument: \'X\' in -X\n\nMakes an authenticated HTTP request to the GitHub API and prints the response.'
    # gh pr list --repo lukstafi/ludics -L abc
    $'invalid argument "abc" for "-L, --limit" flag: strconv.ParseInt: parsing "abc": invalid syntax\n'
    # gh pr list --repo lukstafi/ludics --state bogus
    $'invalid argument "bogus" for "-s, --state" flag: valid values are {open|closed|merged|all}\n'
    # gh issue close
    'accepts 1 arg(s), received 0'
    # gh pr view 1 2 --repo lukstafi/ludics
    'accepts at most 1 arg(s), received 2'
    # gh pr nosuchcmd
    $'unknown command "nosuchcmd" for "gh pr"\n\nUsage:  gh pr <command> [flags]'
    # gh label nosuchcmd
    'unknown command "nosuchcmd" for "gh label"'
    # gh pr list --repo lukstafi/ludics --=x (ludics-lite#468: Cobra's flag-syntax refusal)
    $'bad flag syntax: --=x\n\nList pull requests in a GitHub repository. By default, this only lists open PRs.'
    # gh pr list --repo lukstafi/ludics ---x
    'bad flag syntax: ---x'
    # gh release upload --repo lukstafi/ludics (Cobra's minimum-count refusal)
    'requires at least 2 arg(s), only received 0'
    # gh release upload v0 --repo lukstafi/ludics
    'requires at least 2 arg(s), only received 1'
  )
  retune API_ATTEMPTS=3
  for mode in --read --write; do
    for body in "${bodies[@]}"; do
      reset_fixture
      CLIENT_ERROR="$body"
      run_retry "$mode" pr view 1 --repo example/repo --json nosuchfield
      assert_eq "$RETRY_RC" 2 "a refused argument is a usage error ($mode, $body: $RETRY_OUT)"
      assert_contains "$RETRY_OUT" "refused its own arguments and sent nothing: ${body%%$'\n'*}." \
        "the message quotes gh's refusal, its first line ($mode)"
      assert_not_contains "$RETRY_OUT" "never answered" "no API was asked ($mode, $body)"
      assert_not_contains "$RETRY_OUT" "AMBIGUOUSLY" "and no write can have landed ($mode, $body)"
      assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and it is not re-sent ($mode, $body)"
    done
  done
}

# The controls: a refusal line anywhere but as the whole first stderr line, and gh's client-side
# messages outside the list, keep the retry. Behind the prefix the API's words carry; with a
# suffix; on the second line; unquoted; a flag name holding whitespace; a jq expression gh parses after the request was sent; and a
# refusal that depends on whether a terminal is attached.
test_a_client_refusal_near_miss_still_retries() {
  local body
  local -a bodies=(
    'gh: unknown flag: --nosuchflag'
    'unknown flag: --nosuchflag (HTTP 502)'
    $'gh: Something went wrong (HTTP 500)\nUnknown JSON field: "nosuchfield"'
    'Unknown JSON field: nosuchfield'
    'unknown flag: --foo bar'
    $'failed to parse jq expression (line 1, column 3)\n    .[\n      ^  unexpected EOF'
    $'flags required when not running interactively\n'
    'gh: bad flag syntax: --=x'
    'requires at least 2 arg(s), only received 0 (HTTP 502)'
  )
  retune API_ATTEMPTS=3
  for body in "${bodies[@]}"; do
    reset_fixture
    CLIENT_ERROR="$body"
    run_retry --read pr view 1 --repo example/repo --json number
    assert_eq "$RETRY_RC" 3 "outside the allowlist keeps the retry ($body: $RETRY_OUT)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "every attempt was spent ($body)"
  done
}

# The other half of the scope (review rounds 1 and 2): the line is read only for a command path
# that runs no program but gh. An alias or an extension is handed every argument, and some built-in
# subcommands run git after a write (`repo fork --clone`, `pr merge --delete-branch`), so on those
# the same line keeps the retry on a read and stays ambiguous on a write. A listed path whose
# parent takes any subcommand (`project list`, `label nosuchcmd`) is read, the positive control.
test_a_delegating_command_refusal_is_not_read() {
  local -a cmd
  local spec
  retune API_ATTEMPTS=3
  # `discussion` is gh 2.101.0's own preview command, but an older gh hands it to a `gh-discussion`
  # extension, so it is read as one (review of #490).
  for spec in 'myext --later' 'co --later' 'repo fork o/r --clone --later' 'pr merge 1 --later' \
    'pr checkout 1 --later' 'pr -R o/r view 1 --later' 'discussion list --repo o/r --later'; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    CLIENT_ERROR='unknown flag: --later'
    run_retry --read "${cmd[@]}"
    assert_eq "$RETRY_RC" 3 "an unlisted path's refusal-shaped line keeps the retry ($spec: $RETRY_OUT)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "every attempt was spent ($spec)"
    reset_fixture
    CLIENT_ERROR='unknown flag: --later'
    run_retry "${cmd[@]}"
    assert_eq "$RETRY_RC" 3 "and a write through it stays ambiguous ($spec: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "AMBIGUOUSLY" "it may have landed ($spec)"
    assert_not_contains "$RETRY_OUT" "sent nothing" "nothing is claimed about what was sent ($spec)"
  done
  for spec in 'project list --owner o --foo_bar' 'label nosuchcmd' 'api repos/o/r --later' \
    'issue comment 1 --later'; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    CLIENT_ERROR='unknown flag: --later'
    run_retry "${cmd[@]}"
    assert_eq "$RETRY_RC" 2 "a listed path is read ($spec: $RETRY_OUT)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and not re-sent ($spec)"
  done
}

# --- gh withholding an answer for its escape sequences (post-wave-3 task 8) --------------------

# `retry --read api repos/<o>/<r>/actions/jobs/<id>/logs` without `--allow-escape-sequences`: GitHub
# answered, and gh refused to print the answer. It was read as transport, retried four times and
# reported as UNKNOWN. Re-sending it prints the same refusal, so it is the caller's call that is
# wrong: exit 2 on the first attempt, under both policies, naming the flag. Unlike an argument
# refusal, the request DID reach GitHub, so the message must not say nothing was sent.
test_a_withheld_answer_is_a_usage_error() {
  local mode
  retune API_ATTEMPTS=3
  for mode in --read --write; do
    reset_fixture
    run_retry "$mode" api repos/example/repo/actions/jobs/7/logs
    assert_eq "$RETRY_RC" 2 "a withheld answer is a usage error ($mode: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "gh api withheld GitHub's answer: $ESCAPE_REFUSAL." \
      "the message quotes gh's refusal ($mode)"
    assert_contains "$RETRY_OUT" "re-run it with --allow-escape-sequences" "and names the flag ($mode)"
    assert_not_contains "$RETRY_OUT" "never answered" "GitHub did answer ($mode)"
    assert_not_contains "$RETRY_OUT" "sent nothing" "and the request was sent ($mode)"
    assert_not_contains "$RETRY_OUT" "AMBIGUOUSLY" "and it is not an ambiguous write ($mode)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and it is not re-sent ($mode)"
  done
  # The flag the message names is the fix: the same read with it passes the log through, escape
  # bytes and all.
  reset_fixture
  run_retry --read api repos/example/repo/actions/jobs/7/logs --allow-escape-sequences
  assert_eq "$RETRY_RC" 0 "with the flag the log is read ($RETRY_OUT)"
  assert_eq "$RETRY_OUT" $'\033[36;1mstep\033[0m ok' "and passed through as gh printed it"
}

# The controls: the refusal anywhere but as the whole first stderr line keeps the retry, and so
# does the exact line on a command path whose stderr is not read as gh's (an alias or extension).
test_a_withheld_answer_near_miss_still_retries() {
  local body spec
  local -a cmd
  local -a bodies=(
    "gh: $ESCAPE_REFUSAL"
    "$ESCAPE_REFUSAL (HTTP 502)"
    $'gh: Something went wrong (HTTP 500)\n'"$ESCAPE_REFUSAL"
  )
  retune API_ATTEMPTS=3
  for body in "${bodies[@]}"; do
    reset_fixture
    CLIENT_ERROR="$body"
    run_retry --read api repos/example/repo/actions/jobs/7/logs
    assert_eq "$RETRY_RC" 3 "outside the exact line keeps the retry ($body: $RETRY_OUT)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "every attempt was spent ($body)"
  done
  for spec in 'myext logs' 'pr checkout 1'; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    CLIENT_ERROR="$ESCAPE_REFUSAL"
    run_retry --read "${cmd[@]}"
    assert_eq "$RETRY_RC" 3 "an unlisted path's line is not read as gh's ($spec: $RETRY_OUT)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "every attempt was spent ($spec)"
  done
}

# --- gh refusing this script's own arguments (ludics-lite#471) -------------------------------

# Inside the process: a refusal of an argument the script itself sends is a gh/script version
# mismatch, so the call is not retried, the caller's verdict is not printed over it, and nothing
# after it calls gh. Each block drives a subcommand as the suite's other cases do (sourced, with
# the fixture gh), so it pins the behaviour whether the shell or the Python serves the subcommand.
OWN_REFUSAL='Unknown JSON field: "status"'
test_the_scripts_own_refused_call_is_exit_2() {
  local rc out
  retune API_ATTEMPTS=3
  # The issue's fixture: the run await's own read, fed an unknown JSON field.
  reset_fixture
  CLIENT_ERROR=$'Unknown JSON field: "status"\nAvailable fields:\n  attempt'
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 2 "the await's refused read is exit 2 ($AWAIT_OUT)"
  assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "on its first attempt"
  assert_contains "$AWAIT_OUT" "refused this script's own call, which sent nothing: gh run view 4242" \
    "the message names the refused invocation"
  assert_contains "$AWAIT_OUT" "-> $OWN_REFUSAL. That is a version mismatch" "and quotes gh's refusal"
  assert_not_contains "$AWAIT_OUT" "UNKNOWN" "it is not transport"
  assert_not_contains "$AWAIT_OUT" "attempts" "and no retry count is reported"
  # A write of the script's own, under the write policy: refused, not ambiguous, and not re-sent.
  # This block drove the merge write through the internal gh_retry; it drives a writing subcommand
  # now, so it holds for the Python port too, and the merge write itself is pinned whole-process
  # in the next case, against a refusing gh on PATH.
  reset_fixture
  CLIENT_ERROR="$OWN_REFUSAL"
  set +e
  out=$(cmd_comment example/repo#7 "The comment." 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "a refused comment write is exit 2 ($out)"
  assert_contains "$out" "gh api -X POST repos/example/repo/issues/7/comments -f body=... --jq .html_url" \
    "naming the call"
  assert_not_contains "$out" "AMBIGUOUSLY" "not a write that may have landed"
  assert_eq "$(api_calls)" 1 "and it is not re-sent"
  # A field's value is payload, and is not copied into the message (review of #490): a refused
  # reply names its endpoint and its raw field, and a refused body edit its typed `@file` field,
  # never the text that was not posted nor the file it was read from.
  reset_fixture
  CLIENT_ERROR="unknown flag: --raw-field"
  set +e
  out=$(cmd_reply example/repo#7 9 'a private draft' 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "a refused reply is exit 2 ($out)"
  assert_contains "$out" "repos/example/repo/pulls/7/comments/9/replies -f body=... --jq .html_url" \
    "the call keeps its endpoint and field name"
  assert_not_contains "$out" "private" "and loses the field's value"
  reset_fixture
  printf 'a private draft\n' >"$TEST_ROOT/secret-draft.md"
  CLIENT_ERROR="unknown flag: --field"
  set +e
  out=$(cmd_body example/repo#7 "$TEST_ROOT/secret-draft.md" 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "a refused body edit is exit 2 ($out)"
  assert_contains "$out" "repos/example/repo/pulls/7 -F body=... --jq .html_url" \
    "the call keeps its endpoint and field name"
  assert_not_contains "$out" "secret-draft" "and loses the file the value was read from"
  assert_not_contains "$out" "private draft" "and its content"
  # After a refusal, the command calls gh no more, and the verdict it would have composed from the
  # refused call is not printed over it: the refusal is said once, and the exit is 2, not the 3 a
  # write or a lookup that did not go through reports. This block ran gh_retry twice in one
  # subshell to show the marker file stopping the second call; it drives the two subcommands that
  # make several calls now, a folded reply and a folded resolve, whose second call is the one that
  # must never be made.
  reset_fixture
  CLIENT_ERROR="$OWN_REFUSAL"
  set +e
  out=$(cmd_reply example/repo#7 900+901 "The answer." 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "the reply's refused write is exit 2 ($out)"
  assert_eq "$(api_calls)" 1 "the second thread's write never reached gh"
  assert_eq "$(grep -c 'refused this script' <<<"$out")" 1 "the refusal is said once"
  assert_not_contains "$out" "did not go through" "and no transport verdict follows it"
  assert_not_contains "$out" "AMBIGUOUSLY" "nor an ambiguous one"
  reset_fixture
  CLIENT_ERROR="$OWN_REFUSAL"
  set +e
  out=$(cmd_resolve example/repo#7 900+901 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "the resolve's refused lookup is exit 2 ($out)"
  assert_eq "$(api_calls)" 1 "no second call reached gh"
  assert_eq "$(grep -c 'refused this script' <<<"$out")" 1 "the refusal is said once"
  assert_not_contains "$out" "did not complete" "and no transport verdict follows it"
  assert_not_contains "$out" "no review thread" "nor a missing thread"
  reset_fixture
}

# Whole commands, as a caller runs them: main traps the refusal from inside a command
# substitution and stops the process there. `watch` is the one that re-armed forever: its reads
# failing held the window blind and returned exit 3, so a short window here turns a regression
# into a fast exit 3 rather than a hang. The gh on PATH is a stub, and refuses every call.
test_a_refused_own_call_stops_the_command() {
  local stub tmp rc out spec
  local -a cmd
  test_tmpdir stub own-refusal-gh
  test_tmpdir tmp own-refusal-tmp
  cat >"$stub/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${1:-} ${2:-}" >>"$STUB_LOG" # one line per call: a --jq argument can hold several
printf '%s\n' 'Unknown JSON field: "status"' 'Available fields:' '  attempt' >&2
exit 1
STUB
  chmod +x "$stub/gh"
  # poll, status and rounds pinned before their v2 port (ludics-lite#403): #471's stop is an
  # exception reaching main there, and each must still make exactly one call and say it once.
  for spec in 'watch example/repo#7' 'merge example/repo#7' 'retry run watch example/repo#4242' \
    'checks example/repo#7 --wait' 'poll example/repo#7' 'status example/repo#7' \
    'rounds example/repo#7'; do
    read -r -a cmd <<<"$spec"
    : >"$CALL_LOG"
    set +e
    # `env -i`, as the lib's constants probe does: an exported `gh` function (this suite's own,
    # under the hostile runner's inherited names) outranks the stub on PATH in the child.
    out=$(env -i "PATH=$stub:$PATH" "HOME=${HOME:-}" "TMPDIR=$tmp" "STUB_LOG=$CALL_LOG" \
      SHIP_PR_API_ATTEMPTS=3 WATCH_TIMEOUT=4 WATCH_INTERVAL=1 SHIP_PR_CHECKS_WAIT=4 \
      bash "$HELPER" "${cmd[@]}" 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 2 "$spec stops on the refusal ($out)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "$spec makes no call after it"
    assert_contains "$out" "refused this script's own call" "$spec says what happened"
    assert_eq "$(grep -c 'refused this script' <<<"$out")" 1 "$spec says it once"
    assert_not_contains "$out" "re-arm the watch" "$spec does not ask to be re-armed"
    assert_not_contains "$out" "UNKNOWN" "$spec does not report transport"
    assert_eq "$(find "$tmp" -name 'pr-review-refused.*' | wc -l | tr -d ' ')" 0 \
      "$spec leaves no refusal file behind"
  done
}

# --- what the fix rounds taught `retry`, pinned before the port (ludics-lite#403) --------------
# Each of these was a review round's finding, or a branch its fix added, that no case above
# reached; the Python port has to keep every one of them. They drive `retry` itself, the command
# a caller runs.

# The flag spellings `gh run watch` takes, and the two native no-ops a pasted line carries (round 1
# of self-improve#8's review): each reaches the verdict about the run it names, in one read.
test_run_watch_takes_every_spelling_of_its_flags() {
  local spec
  local -a cmd
  for spec in '-R example/repo 4242' '-R=example/repo 4242' '--repo example/repo 4242' \
    '--repo=example/repo 4242' 'example/repo#4242 -i 5' 'example/repo#4242 -i=5' \
    'example/repo#4242 --interval 5' 'example/repo#4242 --interval=5' \
    'example/repo#4242 --exit-status --compact'; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    run_retry run watch "${cmd[@]}"
    assert_eq "$RETRY_RC" 0 "'$spec' awaits the run ($RETRY_OUT)"
    assert_eq "$RETRY_OUT" "run 4242 in example/repo: success" "and its one line is the verdict ($spec)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "after one read ($spec)"
    assert_contains "$(gh_calls)" "run view 4242 --repo example/repo" "of that run ($spec)"
  done
  # `retry`'s own spellings in front of it change nothing: the await is never forwarded to gh.
  for spec in '--read run watch' 'gh run watch' '--write gh run watch'; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    run_retry "${cmd[@]}" example/repo#4242
    assert_eq "$RETRY_RC" 0 "'$spec' is the same await ($RETRY_OUT)"
    assert_eq "$RETRY_OUT" "run 4242 in example/repo: success" "with the same verdict ($spec)"
  done
}

# Everything else is refused before any read: an unknown flag (a catch-all that discarded it turned
# a mistyped repo flag into a watch of whatever REPO named, round 1 of self-improve#8's review), a
# flag missing its value, and an interval that is not whole seconds or is 0, which busy-looped the
# API for up to the whole ceiling (round 9 of #13, folded in by #14).
test_run_watch_refuses_what_it_does_not_take() {
  local spec
  local -a cmd
  for spec in 'example/repo#4242 --foo' 'example/repo#4242 -x' 'example/repo#4242 --exit-status=true' \
    'example/repo#4242 -R' 'example/repo#4242 --repo' 'example/repo#4242 -i' \
    'example/repo#4242 --interval' 'example/repo#4242 -i 0' 'example/repo#4242 -i=0' \
    'example/repo#4242 -i abc' 'example/repo#4242 -i 1.5' 'example/repo#4242 --interval='; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    run_retry run watch "${cmd[@]}"
    assert_eq "$RETRY_RC" 2 "'$spec' is an invocation error ($RETRY_OUT)"
    assert_eq "$(gh_calls)" "" "and reads nothing ($spec)"
  done
  reset_fixture
  run_retry run watch example/repo#4242 --foo
  assert_contains "$RETRY_OUT" "unsupported flag '--foo'" "an unknown flag is named"
  reset_fixture
  run_retry run watch example/repo#4242 -R
  assert_contains "$RETRY_OUT" "-R needs owner/name" "a flag missing its value says what it needs"
  reset_fixture
  run_retry run watch example/repo#4242 -i 0
  assert_contains "$RETRY_OUT" "the interval must be at least 1 second" "a zero interval is refused as one"
  # Past bash's integer, `[ "$interval" -gt 0 ]` failed as it does for 0: refused, nothing read.
  reset_fixture
  run_retry run watch example/repo#4242 -i 99999999999999999999
  assert_eq "$RETRY_RC" 2 "an interval past bash's integer is refused ($RETRY_OUT)"
  assert_contains "$RETRY_OUT" "the interval must be at least 1 second" "as the shell's test refused it"
  assert_eq "$(gh_calls)" "" "and nothing is read"
  reset_fixture
  run_retry run watch example/repo#4242 -i 1.5
  assert_contains "$RETRY_OUT" "the interval must be seconds, got '1.5'" "and a fraction as not whole seconds"
}

# Which conclusions are a verdict: the red ones exit 1, the green ones 0, and a run that stopped
# without being judged -- cancelled, stale, action_required, or completed with no conclusion at
# all -- exits 4: never the 1 that reads as a failed run, and never a pass.
test_run_watch_reads_each_conclusion_class() {
  local concl
  for concl in success skipped neutral; do
    reset_fixture
    RUN_CONCLUSION=$concl
    run_retry run watch example/repo#4242
    assert_eq "$RETRY_RC" 0 "$concl is green ($RETRY_OUT)"
    assert_eq "$RETRY_OUT" "run 4242 in example/repo: $concl" "and the line names it"
  done
  for concl in failure timed_out startup_failure; do
    reset_fixture
    RUN_CONCLUSION=$concl
    run_retry run watch example/repo#4242
    assert_eq "$RETRY_RC" 1 "$concl is red ($RETRY_OUT)"
    assert_contains "$RETRY_OUT" "run 4242 in example/repo concluded $concl — the run FAILED" "and says so"
  done
  for concl in cancelled stale action_required ""; do
    reset_fixture
    RUN_CONCLUSION=$concl
    run_retry run watch example/repo#4242
    assert_eq "$RETRY_RC" 4 "'$concl' is no verdict ($RETRY_OUT)"
    assert_contains "$RETRY_OUT" "concluded ${concl:-pending} — stopped, not judged" "and says so"
    assert_not_contains "$RETRY_OUT" "FAILED" "never a failure ('$concl')"
  done
}

# A run still going is polled on the interval, but never slept past the deadline: an -i longer
# than what was left slept the await far past its ceiling before the clock was read again (round
# 5 of self-improve#8). While it waits, the heartbeat goes to stderr in place of the redraws `gh
# run watch` streamed (self-improve#8).
test_run_watch_sleeps_no_further_than_its_deadline() {
  local started elapsed
  reset_fixture
  RUN_STATUS=in_progress
  RUN_CONCLUSION=""
  retune CHECKS_WAIT=3 CHECKS_HEARTBEAT=0
  started=$SECONDS
  run_retry run watch example/repo#4242 -i 30
  elapsed=$((SECONDS - started))
  assert_eq "$RETRY_RC" 4 "a run still going at the deadline has no verdict ($RETRY_OUT)"
  [ "$elapsed" -lt 20 ] || bail "the await slept past its 3s deadline on a 30s interval: ${elapsed}s"
  assert_contains "$RETRY_OUT" "still waiting on run 4242 in example/repo: in_progress after 0 min" \
    "the heartbeat says what it is waiting on"
  assert_contains "$RETRY_OUT" "NO VERDICT after 0 min (status: in_progress)" "and the end says so"
  assert_eq "$(gh_calls | wc -l | tr -d ' ')" 2 "one read at the start and one at the deadline"
}

# The plain retry's success is gh's own answer: its stdout and nothing else, whichever of the
# spellings a caller pastes (the leading `gh`, --read, --write), and nothing at all for an empty
# one. With no gh arguments left there is nothing to run, which is a usage error.
test_a_plain_retry_passes_the_answer_through() {
  local spec
  local -a cmd
  for spec in 'run view' '--read run view' '--write run view' 'gh run view' '--read gh run view'; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    run_retry "${cmd[@]}" 4242 --repo example/repo --json status,conclusion --jq .status
    assert_eq "$RETRY_RC" 0 "'$spec' succeeds ($RETRY_OUT)"
    assert_eq "$RETRY_OUT" completed "and prints gh's answer, alone ($spec)"
    assert_eq "$(gh_calls)" "run view 4242 --repo example/repo --json status,conclusion --jq .status" \
      "the call is the caller's, minus retry's own words ($spec)"
  done
  reset_fixture
  run_retry --read run view 4242 --repo example/repo --json status --jq empty
  assert_eq "$RETRY_RC" 0 "an empty answer is still an answer ($RETRY_OUT)"
  assert_eq "$RETRY_OUT" "" "and prints nothing"
  for spec in '' '--read' 'gh' '--write gh'; do
    read -r -a cmd <<<"$spec"
    reset_fixture
    run_retry ${cmd[@]+"${cmd[@]}"}
    assert_eq "$RETRY_RC" 2 "'$spec' has nothing to run ($RETRY_OUT)"
    assert_contains "$RETRY_OUT" "usage: retry [--read] <gh args...>" "and says how it is used"
    assert_eq "$(gh_calls)" "" "and calls nothing ($spec)"
  done
}

# A first word that is not a whole subcommand gets pr-review.sh's own usage, exit 2, before
# anything is forwarded or read -- including a word that merely CONTAINS subcommands ('body
# reply'), which the retired shell's space-padded py_ported glob forwarded to the Python's refusal.
test_a_word_that_is_not_a_subcommand_gets_the_usage() {
  local word out rc
  for word in 'body reply' 'poll status' 'retry poll' frobnicate '' --repo=example/repo; do
    reset_fixture
    set +e
    out=$(main "$word" x 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 2 "'$word' is not a subcommand ($out)"
    assert_contains "$out" "pr-review.sh: usage: pr-review.sh [--repo owner/name] {poll|watch|status|rounds|checks|merge|reply|resolve} <pr> ..." \
      "and gets the usage ('$word')"
    assert_not_contains "$out" "not a subcommand ported to Python" "never the Python's refusal ('$word')"
    assert_eq "$(gh_calls)" "" "and nothing is called ('$word')"
  done
}

# What the plain retry writes is what the shell's `printf '%s\n' "$out"` wrote: the answer as its
# command substitution kept it, NUL bytes dropped and every other byte intact; and a reader that
# closes early (`| head -1`) ends it the way SIGPIPE ended the shell, 141, never 1, which in this CLI
# says the API rejected the call.
test_a_plain_retry_writes_as_the_shell_did() {
  reset_fixture
  set +e
  cmd_retry --read api nul >"$TEST_ROOT/raw" 2>"$TEST_ROOT/raw-err"
  RETRY_RC=$?
  set -e
  assert_eq "$RETRY_RC" 0 "the answer passes ($(cat "$TEST_ROOT/raw-err"))"
  assert_eq "$(LC_ALL=C od -An -tx1 <"$TEST_ROOT/raw" | tr -s ' \n' ' ')" " 61 62 ff 63 0a " \
    "with its NUL dropped and its other bytes as they came"
  reset_fixture
  # The status is written from inside the pipeline rather than read off PIPESTATUS, which the
  # hostile pass hands in from the environment and bash 3.2 then never updates.
  set +e
  {
    (cmd_retry --read api lines 2>"$TEST_ROOT/raw-err")
    echo "$?" >"$TEST_ROOT/raw-rc"
  } | head -1 >"$TEST_ROOT/raw"
  set -e
  assert_eq "$(cat "$TEST_ROOT/raw-rc")" 141 "a closed reader ends the retry as SIGPIPE did ($(cat "$TEST_ROOT/raw-err"))"
  assert_eq "$(cat "$TEST_ROOT/raw")" 1 "after the reader had its line"
  assert_not_contains "$(cat "$TEST_ROOT/raw-err")" "Traceback" "with no traceback"
}

# The plain retry's failures, under each policy (9197c23): a 4xx is the API answering (exit 1, not
# re-sent); a gateway refusal is re-sent under either policy, to an exit 3 that says the outcome is
# unknown; and anything else ambiguous is re-sent by a read but not by a write, which says it may
# have landed.
test_a_plain_retry_keeps_its_exits_apart() {
  local mode
  retune API_ATTEMPTS=3
  for mode in --read --write; do
    reset_fixture
    RUN_ERROR="gh: Not Found (HTTP 404)"
    run_retry "$mode" run view 4242 --repo example/repo --json status
    assert_eq "$RETRY_RC" 1 "a 404 is the API's answer ($mode: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "gh run was rejected: gh: Not Found (HTTP 404)" "quoted as one ($mode)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and not re-sent ($mode)"
    reset_fixture
    RUN_ERROR="gh: HTTP 503: Service Unavailable"
    run_retry "$mode" run view 4242 --repo example/repo --json status
    assert_eq "$RETRY_RC" 3 "a gateway refusal is transport ($mode: $RETRY_OUT)"
    assert_contains "$RETRY_OUT" "gh run did not go through after 3 attempts (gh: HTTP 503: Service Unavailable)" \
      "and says how many attempts it took ($mode)"
    assert_contains "$RETRY_OUT" "the outcome is UNKNOWN" "and that nothing was learned ($mode)"
    assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "after every attempt ($mode)"
  done
  reset_fixture
  RUN_ERROR="gh: Internal Server Error (HTTP 500)"
  run_retry run view 4242 --repo example/repo --json status
  assert_eq "$RETRY_RC" 3 "an ambiguous write is not a verdict ($RETRY_OUT)"
  assert_contains "$RETRY_OUT" "gh run failed AMBIGUOUSLY: gh: Internal Server Error (HTTP 500)" "and says why"
  assert_contains "$RETRY_OUT" "a write may have landed" "and what that means"
  assert_eq "$(gh_calls | wc -l | tr -d ' ')" 1 "and the write policy does not re-send it"
  reset_fixture
  RUN_ERROR="gh: Internal Server Error (HTTP 500)"
  run_retry --read run view 4242 --repo example/repo --json status
  assert_eq "$RETRY_RC" 3 "the same failure on a read is transport ($RETRY_OUT)"
  assert_contains "$RETRY_OUT" "did not go through after 3 attempts" "re-sent to the end"
  assert_eq "$(gh_calls | wc -l | tr -d ' ')" 3 "by the read policy"
}

# --- the await's own edges (pinned before the v2 port, ludics-lite#403) --------------------------

# The interval is seconds and at least one (10b94dd, f46932e): a zero would busy-loop the API for
# the whole two-hour ceiling. Both spellings of the flag take a value.
test_the_await_interval_is_whole_seconds_above_zero() {
  reset_fixture
  run_await -i 0 example/repo#4242
  assert_eq "$AWAIT_RC" 2 "a zero interval is refused ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "the interval must be at least 1 second, got '0'" "and says why"
  reset_fixture
  run_await --interval=soon example/repo#4242
  assert_eq "$AWAIT_RC" 2 "a non-numeric interval is refused ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "the interval must be seconds, got 'soon'" "and says why"
  assert_eq "$(gh_calls)" "" "neither reads anything"
  reset_fixture
  run_await -i=5 example/repo#4242
  assert_eq "$AWAIT_RC" 0 "a whole number of seconds is accepted ($AWAIT_OUT)"
}

# A pasted `gh run watch` line keeps working: the two native flags this await subsumes are no-ops,
# and every OTHER flag is refused rather than dropped (09b2453) — a discarded flag is how a typo'd
# repo flag becomes a watch against whatever REPO resolves to.
test_the_await_takes_the_native_no_ops_and_refuses_other_flags() {
  reset_fixture
  run_await --exit-status --compact example/repo#4242
  assert_eq "$AWAIT_RC" 0 "the native no-ops are accepted ($AWAIT_OUT)"
  reset_fixture
  run_await --repo-typo example/repo example/repo#4242
  assert_eq "$AWAIT_RC" 2 "an unknown flag is refused ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "unsupported flag '--repo-typo'" "naming it"
  assert_eq "$(gh_calls)" "" "and nothing is read"
}

# A run stopped without a verdict (a cancel, a superseding push) is exit 4, never red and never
# green (10b94dd).
test_a_cancelled_run_is_stopped_not_judged() {
  reset_fixture
  RUN_CONCLUSION=cancelled
  run_await example/repo#4242
  assert_eq "$AWAIT_RC" 4 "a cancel is no verdict ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "concluded cancelled — stopped, not judged" "and says so"
}

# A long await says it is still waiting, at the heartbeat, and never sleeps past its own deadline
# (0c4580d): an interval longer than what is left is capped at what is left.
test_the_await_beats_and_never_sleeps_past_its_deadline() {
  local started
  reset_fixture
  retune CHECKS_HEARTBEAT=0
  RUN_STATUS=in_progress
  RUN_CONCLUSION=""
  AWAIT_WAIT=2
  started=$SECONDS
  run_await -i 600 example/repo#4242
  assert_eq "$AWAIT_RC" 4 "still running at the deadline is no verdict ($AWAIT_OUT)"
  assert_contains "$AWAIT_OUT" "still waiting on run 4242 in example/repo: in_progress after 0 min" \
    "the heartbeat says what it is waiting on"
  [ $((SECONDS - started)) -lt 60 ] ||
    bail "a 600s interval slept past a 2s deadline ($((SECONDS - started))s)"
}

# --- the shared parse -------------------------------------------------------------------------

# parse_ref is what both this await and every PR argument read their argument with; pinning both
# readers here keeps the two spellings from drifting apart behind their different refusal messages.
# It drives the subcommands (`retry run watch`, `comment`), not the internal function, so it holds
# for the Python port (ludics-lite#403). Not carried over from the in-process form: that a failed
# parse leaves no REF_REPO/REF_NUM behind, which is shell state a subcommand never shows.
test_parse_ref() {
  reset_fixture
  run_await example/repo#12
  assert_eq "$AWAIT_RC" 0 "owner/name#number should parse ($AWAIT_OUT)"
  assert_contains "$(gh_calls)" "run view 12 --repo example/repo" "the repo and the number come off the argument"
  reset_fixture
  run_await -R example/repo 34
  assert_eq "$AWAIT_RC" 0 "a bare number should parse ($AWAIT_OUT)"
  assert_contains "$(gh_calls)" "run view 34 --repo example/repo" "and take the repo named beside it"
  # The names GitHub actually allows on both halves, so the tightening below refuses only what
  # cannot be a repository.
  reset_fixture
  run_await my-org_1.x/repo.name-2#7
  assert_eq "$AWAIT_RC" 0 "dots, dashes and underscores should parse ($AWAIT_OUT)"
  assert_contains "$(gh_calls)" "run view 7 --repo my-org_1.x/repo.name-2" "the repo comes through intact"
  local rc bad out
  for bad in example/repo#x "" "#123" "junk#123" "example/repo#111#222" "example/repo/extra#1" \
    "example repo#1" "/repo#1" "example/#1" "example/repo#" "example/repo"; do
    reset_fixture
    run_await -R example/repo "$bad"
    assert_eq "$AWAIT_RC" 2 "'$bad' must not parse as a run ($AWAIT_OUT)"
    assert_eq "$(gh_calls)" "" "and nothing is read for '$bad'"
    reset_fixture
    set +e
    out=$(cmd_comment "$bad" "The comment." 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 2 "'$bad' must not parse as a PR ($out)"
    assert_contains "$out" "PR must be a number or owner/name#number, got '$bad'" "and is refused as one"
    assert_eq "$(gh_calls)" "" "and nothing is posted for '$bad'"
    # And a subcommand the shell still serves, which parses through the shell's parse_ref rather
    # than the Python's: the two copies are held to one list (ludics-lite#403). The empty argument
    # is left out here, since `status`'s own `${1:?usage}` refuses it before any parse does.
    [ -n "$bad" ] || continue
    reset_fixture
    set +e
    out=$(cmd_status "$bad" 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 2 "'$bad' must not parse as a PR for status ($out)"
    assert_contains "$out" "PR must be a number or owner/name#number, got '$bad'" "and status refuses it as one"
    assert_eq "$(gh_calls)" "" "and nothing is read for '$bad'"
  done
}

tests=(
  test_bare_run_id_without_a_repo_is_refused
  test_bare_run_id_with_a_named_repo_is_accepted
  test_owner_name_hash_run_is_accepted
  test_conflicting_repos_are_refused
  test_malformed_run_argument_is_refused
  test_unparsed_prefixes_are_refused
  test_a_rejected_pair_is_not_a_failed_run
  test_a_failed_run_is_still_exit_1
  test_transport_failure_is_unknown
  test_no_verdict_is_exit_4
  test_the_await_interval_is_whole_seconds_above_zero
  test_the_await_takes_the_native_no_ops_and_refuses_other_flags
  test_a_cancelled_run_is_stopped_not_judged
  test_the_await_beats_and_never_sleeps_past_its_deadline
  test_a_fixed_graphql_answer_is_a_rejection
  test_a_graphql_not_found_is_fixed
  test_a_graphql_outage_still_retries
  test_a_near_miss_still_retries
  test_a_client_refusal_is_a_usage_error
  test_a_client_refusal_near_miss_still_retries
  test_a_delegating_command_refusal_is_not_read
  test_a_withheld_answer_is_a_usage_error
  test_a_withheld_answer_near_miss_still_retries
  test_the_scripts_own_refused_call_is_exit_2
  test_a_refused_own_call_stops_the_command
  test_run_watch_takes_every_spelling_of_its_flags
  test_run_watch_refuses_what_it_does_not_take
  test_run_watch_reads_each_conclusion_class
  test_run_watch_sleeps_no_further_than_its_deadline
  test_a_plain_retry_passes_the_answer_through
  test_a_word_that_is_not_a_subcommand_gets_the_usage
  test_a_plain_retry_keeps_its_exits_apart
  test_a_plain_retry_writes_as_the_shell_did
  test_parse_ref
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
