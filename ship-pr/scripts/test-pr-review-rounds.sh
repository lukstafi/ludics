#!/usr/bin/env bash
# Focused fixture tests for pr-review.sh's review-round count — the number the convergence policy's
# threshold is read against (ludics-lite#12).

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
REVIEWS_JSON='[]'
COMMENTS_JSON='[]'
INLINE_JSON='[]'
FAIL_INLINE=""
FAIL_READ=""

# Minimal gh fixture transport: the reviews feed is the only endpoint the counter reads. It is
# fetched with --paginate, which the fixture accepts and ignores (one page is the whole feed).
gh() {
  local response=""
  gh_fixture_parse "$@"
  case "$FIXTURE_ENDPOINT" in
  "repos/$REPO/pulls/7/reviews?per_page=100")
    if [ -n "$FAIL_READ" ]; then
      echo "gh: reviews unavailable (HTTP 500)" >&2
      return 1
    fi
    response="$REVIEWS_JSON"
    ;;
  "repos/$REPO/issues/7/comments?per_page=100") response="$COMMENTS_JSON" ;;
  "repos/$REPO/pulls/7/reviews/"*"/comments?per_page=100")
    [ -z "$FAIL_INLINE" ] || return 1
    response="$INLINE_JSON" ;;
  *) bail "unexpected fixture endpoint: $FIXTURE_ENDPOINT" ;;
  esac
  gh_fixture_answer "$response"
}

review() { # <login> <state> <commit> <submitted_at|null>
  jq -cn --arg u "$1" --arg s "$2" --arg c "$3" --arg t "$4" \
    '{user:{login:$u}, state:$s, commit_id:$c, body:"findings",
      submitted_at:(if $t == "null" then null else $t end)}'
}

set_reviews() {
  REVIEWS_JSON=$(printf '%s\n' "$@" | jq -cs .)
  COMMENTS_JSON='[]'
  FAIL_READ=""
}

# The body goes to jq on stdin: a shell function's arguments are not exec arguments, but a
# `--arg` is, and the large-feed fixture below is over Linux's per-argument limit by design.
comment() { # <login> <created_at> <body>
  printf '%s' "$3" | jq -c -R -s --arg u "$1" --arg t "$2" \
    '{user:{login:$u}, created_at:$t, body:.}'
}

set_comments() {
  COMMENTS_JSON=$(printf '%s\n' "$@" | jq -cs .)
}

# The initialization failure, verbatim from lukstafi/ocannl-staging#677 (2026-09-09): a summary
# comment with no findings under it, because the review never ran (ludics-lite#78).
failure_body() { # <the ref the reviewer could not fetch>
  printf '%s\n\n```\nProvided git ref %s does not exist\n```\n' \
    'Codex Review: Something went wrong. Try again later by commenting “@codex review”.' "$1"
}

# The connector's other way of not starting, verbatim from ludics-lite#420 (issuecomment-5846369911,
# 2026-09-26): no ref, no findings, no "Codex Review:" prefix (ludics-lite#421).
ENV_FAILURE_BODY='To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).'

# The whole `rounds` command, as a caller runs it: its prose line, its trailer and its exit, from
# whichever implementation serves it (ludics-lite#403).
run_rounds() {
  local capture rc
  set +e
  capture=$(cmd_rounds 7 2>&1)
  rc=$?
  set -e
  ROUNDS_OUTPUT="$capture"
  ROUNDS_RC="$rc"
}

# Two heads carry findings. The approval, the author's own reply (a COMMENTED review in the same
# feed), the pending draft and the second inline comment on head A must not add rounds.
test_counts_distinct_heads_with_findings() {
  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:01Z)" \
    "$(review "$REVIEWER" CHANGES_REQUESTED bbbb 2026-09-01T11:00:00Z)" \
    "$(review "$REVIEWER" APPROVED cccc 2026-09-01T12:00:00Z)" \
    "$(review lukstafi COMMENTED bbbb 2026-09-01T11:30:00Z)" \
    "$(review "$REVIEWER" COMMENTED dddd null)"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "two rounds under a threshold of 12 should exit 0"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" "should count two heads"
  assert_not_contains "$ROUNDS_OUTPUT" "PAST" "two of twelve is not past the threshold"
}

# A re-requested round on the same head ('@codex review' without a push) is a separate burst of
# reviews minutes later; it must count, or twelve rounds on one head would read as one.
test_rerequested_round_on_same_head_counts() {
  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:03Z)" \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:40:00Z)" \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:40:02Z)" \
    "$(review "$REVIEWER" COMMENTED bbbb 2026-09-01T11:00:00Z)"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "three rounds under the threshold should exit 0"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 3 of 12" \
    "two bursts on one head plus one on another are three rounds"
  assert_contains "$ROUNDS_OUTPUT" "over 2 head(s)" "should still report the heads"
}

# Order in the feed is not submission order, and a burst straddling the gap by one review is one
# round: the gap is measured review to review, not from the round's first review.
test_rounds_are_ordered_by_submission_and_chained() {
  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:20:00Z)" \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:10:00Z)"
  ROUND_THRESHOLD=12
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "reviews 10 minutes apart in a chain are one round"
}

test_malformed_threshold_is_refused() {
  local out rc
  set +e
  out=$(SHIP_PR_ROUND_THRESHOLD=12x bash "$HELPER" rounds "$REPO#7" 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 2 "a malformed threshold is a usage error, not 'off'"
  assert_contains "$out" "SHIP_PR_ROUND_THRESHOLD must be a number of rounds or 'off', got '12x'" \
    "should name the bad value"
  set +e
  out=$(SHIP_PR_ROUND_THRESHOLD=off SHIP_PR_TEST_SOURCE_ONLY=1 bash "$HELPER" 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 0 "off is accepted"
}

# The command line of the three readers, pinned before their v2 port (ludics-lite#403): a missing
# PR is bash's `${1:?usage: ...}`, exit 1 naming the usage; a malformed one and one with no repository
# named are pr_arg's refusals, exit 2. Nothing is read in any of them. (The library exports
# SHIP_PR_TEST_SOURCE_ONLY for its own sourcing; these runs are the whole command, so they drop it.)
test_the_readers_refuse_a_missing_or_malformed_pr() {
  local out rc sub
  for sub in poll status rounds; do
    set +e
    out=$(env -u REPO -u SHIP_PR_TEST_SOURCE_ONLY bash "$HELPER" "$sub" 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 1 "$sub with no PR is bash's parameter error"
    assert_contains "$out" "usage: $sub <pr>" "$sub names its usage"
    # bash's own message, which names the script, its line and the parameter; the Python half
    # cannot spell the first two, so the forwarder makes this refusal itself.
    case "$out" in "$HELPER: line "[0-9]*": 1: usage: $sub <pr>"*) ;; *)
      bail "$sub with no PR should be bash's \${1:?} message, got: $out" ;;
    esac
    set +e
    out=$(env -u SHIP_PR_TEST_SOURCE_ONLY bash "$HELPER" "$sub" "" 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 1 "$sub with an empty PR is bash's parameter error too"
    case "$out" in "$HELPER: line "[0-9]*": 1: usage: $sub <pr>"*) ;; *)
      bail "$sub with an empty PR should be bash's \${1:?} message, got: $out" ;;
    esac
    set +e
    out=$(env -u SHIP_PR_TEST_SOURCE_ONLY bash "$HELPER" "$sub" "$REPO#x" 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 2 "$sub with a malformed PR is a usage error"
    assert_contains "$out" "PR must be a number or owner/name#number, got '$REPO#x'" "$sub names the argument"
    set +e
    out=$(env -u REPO -u SHIP_PR_TEST_SOURCE_ONLY bash "$HELPER" "$sub" 7 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 2 "$sub with a bare number and no repository is refused"
    assert_contains "$out" "Pass it as owner/name#7" "$sub says how to name it"
  done
}

test_malformed_gap_is_refused() {
  local out rc v
  for v in '"900"' true -1 900.5 x; do
    set +e
    out=$(SHIP_PR_ROUND_GAP="$v" bash "$HELPER" rounds "$REPO#7" 2>&1)
    rc=$?
    set -e
    assert_eq "$rc" 2 "a gap of '$v' is a usage error"
    assert_contains "$out" "SHIP_PR_ROUND_GAP must be a nonnegative number of seconds" \
      "should name the setting for '$v'"
  done
  set +e
  out=$(SHIP_PR_ROUND_GAP=0 SHIP_PR_TEST_SOURCE_ONLY=1 bash "$HELPER" 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 0 "a zero gap is accepted"
}

# A round delivered only as an issue comment is a round; the running placeholder and the clean
# verdict are not; a comment quoting the head it reviewed joins that head's burst.
test_comment_only_rounds_count() {
  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:02Z)"
  set_comments \
    "$(comment "$REVIEWER" 2026-09-01T09:59:00Z '<!-- codex-pull-request-review-summary --> 🔄 Running')" \
    "$(comment "$REVIEWER" 2026-09-01T10:00:05Z 'Summary for **Reviewed commit:** `aaaa111` with one finding')" \
    "$(comment "$REVIEWER" 2026-09-01T10:45:00Z 'Codex Review: one more thing about the lock, no lines')" \
    "$(comment lukstafi 2026-09-01T10:50:00Z 'Round 2, on the summary: fixed')" \
    "$(comment "$REVIEWER" 2026-09-01T11:30:00Z "Codex Review: Didn't find any major issues. **Reviewed commit:** \`bbbb\`")"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "two rounds under the threshold"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" \
    "the inline round (with its summary comment) plus one comment-only round"
}

# The feeds travel on stdin, not the argument list: one 300 KB comment is over Linux's per-argument
# limit, and a long PR has many.
test_large_comment_feed_still_counts() {
  set_reviews "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)"
  local big
  big=$(head -c 300000 /dev/zero | tr '\0' x)
  set_comments \
    "$(comment "$REVIEWER" 2026-09-01T10:45:00Z "Codex Review: $big")" \
    "$(comment "$REVIEWER" 2026-09-01T11:30:00Z "Codex Review: $big")"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "a large comment feed still reads"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 3 of 12" \
    "the inline round plus two comment-only rounds"
}

# What #677 actually read: two failed fetches, minutes apart, both landing in the comment feed
# with no "Reviewed commit" to attribute them to a head — counted as one comment-shaped round,
# reported as "1 round(s) of findings over 0 head(s)", and charged against the threshold.
test_initialization_failures_are_not_rounds() {
  set_reviews
  set_comments \
    "$(comment "$REVIEWER" 2026-09-09T17:00:54Z \
      "$(failure_body 0ac6fef8038e95481f82deddc1edfa2ab8ca8827)")" \
    "$(comment "$REVIEWER" 2026-09-09T17:03:22Z \
      "$(failure_body 099131cc90960b2ad144f9f33c374c6be81035c8)")"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "an unread threshold is not what a failed fetch produces"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 0 of 12" \
    "a review that never started carries no findings"
  # Beside a real round, the failures still add nothing.
  set_reviews "$(review "$REVIEWER" COMMENTED aaaa 2026-09-09T10:00:00Z)"
  set_comments \
    "$(comment "$REVIEWER" 2026-09-09T17:00:54Z \
      "$(failure_body 0ac6fef8038e95481f82deddc1edfa2ab8ca8827)")" \
    "$(comment "$REVIEWER" 2026-09-09T17:03:22Z \
      "$(failure_body 099131cc90960b2ad144f9f33c374c6be81035c8)")"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "the inline round is the only round the two failures sit beside"
  # The negative control on the matcher: a comment-only round that merely says the words is a
  # round, and must not be swept up with them.
  set_comments "$(comment "$REVIEWER" 2026-09-09T17:00:54Z \
    'Codex Review: drop the lock — something went wrong in round 2 for a different reason')"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" \
    "a finding that mentions the wording is still a finding"
}

# #420's shape: the missing-environment answer is no more a round than the failed fetch. Before
# ludics-lite#421 it counted as one comment-shaped round, over a PR the reviewer had not read.
test_the_missing_environment_is_not_a_round() {
  set_reviews
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z "$ENV_FAILURE_BODY")"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "a count that was read is exit 0"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 0 of 12" \
    "a review that never started carries no findings"
  # Beside the round the nudge got, it still adds nothing.
  set_reviews "$(review "$REVIEWER" COMMENTED aaaa 2026-09-26T13:05:00Z)"
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z "$ENV_FAILURE_BODY")"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "the nudged round is the only round"
  # The negative control: a comment-only round that QUOTES the sentence below its opening is a round.
  set_reviews
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z \
    "$(printf 'Codex Review: P2 — the connector answered\n\n> %s\n\nand this reads it as a round.' \
      "$ENV_FAILURE_BODY")")"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "a finding that quotes the sentence is still a finding"
  # The phrase is bounded (review of #434, round 1): a finding that CONTINUES it is a finding,
  # while the sentence unlinked, alone on its line, is still the connector's.
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z \
    'To use Codex here, create an environment for this repository before running the tests.')"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" "'repository' is not 'repo'"
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z \
    'To use Codex here, create an environment for this repo. The tests assume one.')"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "a sentence that goes on past the full stop is a finding"
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z \
    'To use Codex here, [create an environment for this repo](https://example.test/env) — the suite needs one.')"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "a finding that carries on past the link is a finding (review of #434, round 4)"
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z \
    "$(printf '%s\n%s' 'To use Codex here, create an environment for this repo.' \
      'The suite shells out to a sandbox that has none.')")"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "a finding that carries on on the next line is a finding (review of #434, round 5)"
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z \
    "$(printf '%s\n\n' 'To use Codex here, create an environment for this repo.')")"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 0 of 12" \
    "trailing whitespace is still the whole body"
  set_comments "$(comment "$REVIEWER" 2026-09-26T12:44:03Z \
    'To use Codex here, create an environment for this repo.')"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 0 of 12" \
    "the sentence unlinked, and nothing after it, is the connector's"
}

# The connector's environment reply posted INTO a review thread (ludics-lite#472): a mention of
# '@codex' in a thread reply on #465 drew inline comment 4138519259, which GitHub filed as an
# empty-bodied COMMENTED review on the head, and the count took it for round 5. Verbatim from that
# comment. The envelope holding only that body is no round; the controls are that same envelope
# with a real finding beside it, and a finding that QUOTES the reply.
test_the_connector_thread_reply_is_not_a_round() {
  local findings
  findings=$(review "$REVIEWER" COMMENTED aaaa 2026-09-29T21:24:38Z)
  set_reviews "$findings" \
    "$(review "$REVIEWER" COMMENTED bbbb 2026-09-29T21:29:15Z | jq -c '. + {id:5358720309,body:""}')"
  ROUND_THRESHOLD=12
  INLINE_JSON=$(jq -cn --arg b "$ENV_FAILURE_BODY" \
    '[{id:4138519259, in_reply_to_id:4138480284, pull_request_review_id:5358720309, body:$b}]')
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "a count that was read is exit 0"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "the connector's thread reply opens no round"
  assert_contains "$ROUNDS_OUTPUT" "over 1 head(s)" "and adds no head"
  INLINE_JSON=$(jq -cn --arg b "$ENV_FAILURE_BODY" '[{id:1, in_reply_to_id:9, body:($b + "\n\n")}]')
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "trailing whitespace is still the verbatim body"
  # Only as a THREAD reply (review of #488, round 1): a top-level comment with that text is a finding.
  INLINE_JSON=$(jq -cn --arg b "$ENV_FAILURE_BODY" '[{id:1, body:$b}]')
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" \
    "the text as a top-level comment, replying to nothing, is a round"
  INLINE_JSON=$(jq -cn --arg b "$ENV_FAILURE_BODY" '[{id:1, in_reply_to_id:9, body:$b}, {id:2, body:"a real finding"}]')
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" \
    "an envelope holding a finding beside the reply is a round"
  INLINE_JSON=$(jq -cn --arg b "$ENV_FAILURE_BODY" '[{id:1, in_reply_to_id:9, body:("The connector answered\n\n> " + $b)}]')
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" \
    "a finding that quotes the reply is a finding"
  INLINE_JSON=$(jq -cn '[{id:1, in_reply_to_id:9, body:"To use Codex here, create an environment for this repo."}]')
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" \
    "a wording the allowlist does not hold verbatim is still a round, loudly"
  INLINE_JSON='[]'
}

# The other side of that filter: a comment-only round whose finding QUOTES the ref error is a
# round. This function has no head to check a quoted ref against, so it drops a comment only when
# the body OPENS with the failure sentence itself — under the shape `status` uses, a round about
# this very matcher would vanish from the convergence count (review of #82, round 1).
test_a_round_quoting_the_ref_error_still_counts() {
  set_reviews
  set_comments "$(comment "$REVIEWER" 2026-09-09T17:00:54Z \
    "$(printf '%s\n\n```\nProvided git ref %s does not exist\n```\n\n%s\n' \
      'Codex Review: P2 — the matcher drops a round whose body quotes' \
      0ac6fef8038e95481f82deddc1edfa2ab8ca8827 'from the convergence count.')")"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "a round is a round"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "a finding that quotes the ref error must not be swept up with the failures"
  # Nor one whose own opening words are the connector's: the sentence is matched whole, through
  # the retry instruction (review of #82, round 3).
  set_comments "$(comment "$REVIEWER" 2026-09-09T17:00:54Z \
    'Codex Review: Something went wrong in the retry path — the backoff is not reset')"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "three shared words are not the failure sentence"
  # Nor most of the sentence: it is matched through the command it tells you to comment
  # (review of #82, round 7).
  set_comments "$(comment "$REVIEWER" 2026-09-09T17:00:54Z \
    'Codex Review: Something went wrong. Try again later by commenting on the retry logic')"
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 of 12" \
    "a round that diverges before the command is a round"
}

test_no_rounds_yet() {
  set_reviews "$(review "$REVIEWER" APPROVED cccc 2026-09-01T12:00:00Z)"
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "an approval alone is zero rounds with findings"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 0 of 12" "should count zero"
}

test_threshold() {
  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED bbbb 2026-09-01T11:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED cccc 2026-09-01T12:00:00Z)"
  ROUND_THRESHOLD=3
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "the threshold round itself is still addressed in full"
  assert_contains "$ROUNDS_OUTPUT" "3 of 3 — the last round addressed in full" \
    "should say the threshold round is the last full one"
  ROUND_THRESHOLD=2
  run_rounds
  assert_eq "$ROUNDS_RC" 1 "past the threshold should exit 1"
  assert_contains "$ROUNDS_OUTPUT" "3, PAST the 2-round threshold" "should say it is past"
  assert_contains "$ROUNDS_OUTPUT" "blocking-only from here" "should carry the triage rule"
  assert_contains "$ROUNDS_OUTPUT" "introduced or materially worsened by the PR" "should require attribution for defect blockers"
  assert_contains "$ROUNDS_OUTPUT" "invalidated central claims or evidence" "should retain the claim gate"
  assert_contains "$ROUNDS_OUTPUT" "all non-advisory checks" "should match the build gate"
  assert_contains "$ROUNDS_OUTPUT" "pre-existing defect does not block" "should distinguish discovery from introduction"
  assert_not_contains "$ROUNDS_OUTPUT" "of 2" "past the threshold is not 'N of M'"
}

test_threshold_off() {
  set_reviews "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)"
  ROUND_THRESHOLD=off
  run_rounds
  assert_eq "$ROUNDS_RC" 0 "no threshold should exit 0"
  assert_contains "$ROUNDS_OUTPUT" "no threshold set" "should say there is no threshold"
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1 " "should still count"
}

# An unread feed is not "no rounds yet": the count says UNKNOWN and the exit is 3, the same
# collapse the rest of the script refuses to make.
test_api_failure_is_unknown() {
  set_reviews "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)"
  FAIL_READ=1
  ROUND_THRESHOLD=12
  run_rounds
  assert_eq "$ROUNDS_RC" 3 "an unread feed should exit 3"
  assert_contains "$ROUNDS_OUTPUT" "UNKNOWN" "an unread feed should say UNKNOWN"
  assert_contains "$ROUNDS_OUTPUT" "NOT 'no rounds yet'" "should refuse the zero reading"
  assert_not_contains "$ROUNDS_OUTPUT" "rounds with findings: 0" "must not print a zero count"
}

test_empty_reviews_need_their_own_findings() {
  set_reviews "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z | jq '. + {id:88,body:" \n\t"}')"
  INLINE_JSON='[]'
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 0" "empty envelope is no round"
  assert_contains "$ROUNDS_OUTPUT" "over 0 head(s)" "empty envelope contributes no head"
  INLINE_JSON='[{"id":1,"body":"a real finding","pull_request_review_id":88}]'
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 1" "own inline finding counts"
  FAIL_INLINE=1
  run_rounds
  assert_eq "$ROUNDS_RC" 3 "unread inline feed is unknown"
  FAIL_INLINE=""
  INLINE_JSON='[]'
}

# `rounds` ends with its machine-readable trailer (ludics-lite#423), the line `fleet-worker.sh prs`
# reads instead of the prose: the count or `unknown`, the threshold or `off`, and round 1's inline
# findings or `unknown` (ludics-lite#650), on the LAST line. Every round-1 review's comments read
# INLINE_JSON here: two findings and a thread reply that is none.
test_rounds_ends_with_its_trailer() {
  local out rc
  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z | jq -c '.id = 11')" \
    "$(review "$REVIEWER" COMMENTED bbbb 2026-09-01T11:00:00Z | jq -c '.id = 12')"
  INLINE_JSON='[{"id":1,"body":"P2"},{"id":2,"body":"P1"},{"id":3,"body":"ok","in_reply_to_id":1}]'
  ROUND_THRESHOLD=12
  set +e
  out=$(cmd_rounds 7 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 0 "under the threshold"
  assert_contains "$out" "review rounds with findings: 2 of 12" "the prose line stays"
  assert_eq "$(tail -n 1 <<<"$out")" "rounds: n=2 threshold=12 first=2" "and the trailer is the last line"
  ROUND_THRESHOLD=1
  set +e
  out=$(cmd_rounds 7 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 1 "past the threshold, the exit is unchanged"
  assert_eq "$(tail -n 1 <<<"$out")" "rounds: n=2 threshold=1 first=2" "and the trailer still follows"
  ROUND_THRESHOLD=off
  out=$(cmd_rounds 7 2>&1)
  assert_eq "$(tail -n 1 <<<"$out")" "rounds: n=2 threshold=off first=2" "no threshold reads as off"
  FAIL_INLINE=1
  ROUND_THRESHOLD=12
  set +e
  out=$(cmd_rounds 7 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 0 "an unread round 1 leaves the exit to the count"
  assert_eq "$(tail -n 1 <<<"$out")" "rounds: n=2 threshold=12 first=unknown" "and its size says unknown, not 0"
  FAIL_INLINE=""
  INLINE_JSON='[]'
  FAIL_READ=1
  ROUND_THRESHOLD=12
  set +e
  out=$(cmd_rounds 7 2>&1)
  rc=$?
  set -e
  assert_eq "$rc" 3 "an unread feed exits 3"
  assert_eq "$(tail -n 1 <<<"$out")" "rounds: n=unknown threshold=12 first=unknown" "and its trailer says unknown, not 0"
}

# --- a read that does not parse must not render as a count (ludics-lite#89) ---------------------
# The count's read is reached from outside: a review whose submission time is not a date. The
# head tally beside it reads nothing the count did not read first, so no feed reaches it alone; it
# is broken by hand in the package's own tests (lib/ludics/tests/test_prreview_readers.py, Rounds),
# which pin that its default is the visible `?` and never a plausible number. This suite broke the
# shell's program for it by name until the shell half was retired.

test_a_broken_jq_program_is_not_a_round_count() {
  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED bbbb 2026-09-01T11:00:00Z)"
  ROUND_THRESHOLD=12
  # The baseline every broken run below is measured against: this fixture, read with nothing
  # broken. That the shim breaks ONLY what it is pointed at is the preamble's control now.
  run_rounds
  assert_contains "$ROUNDS_OUTPUT" "review rounds with findings: 2 of 12" \
    "the ordinary reading of this fixture"
  assert_contains "$ROUNDS_OUTPUT" "over 2 head(s)" "and the head tally with it"

  set_reviews \
    "$(review "$REVIEWER" COMMENTED aaaa 2026-09-01T10:00:00Z)" \
    "$(review "$REVIEWER" COMMENTED bbbb 'yesterday, about noon')"
  run_rounds
  assert_eq "$ROUNDS_RC" 3 "a count that could not be read is UNKNOWN, not a number"
  assert_contains "$ROUNDS_OUTPUT" "NOT 'no rounds yet'" "and the line says so"
  assert_contains "$ROUNDS_OUTPUT" "the reviews feed did not parse" "naming the read"
  assert_not_contains "$ROUNDS_OUTPUT" "rounds with findings: 0" "must not print a zero count"
  assert_eq "$(tail -n 1 <<<"$ROUNDS_OUTPUT")" "rounds: n=unknown threshold=12 first=unknown" "and the trailer says unknown"
}

tests=(
  test_empty_reviews_need_their_own_findings
  test_counts_distinct_heads_with_findings
  test_rerequested_round_on_same_head_counts
  test_rounds_are_ordered_by_submission_and_chained
  test_malformed_threshold_is_refused
  test_malformed_gap_is_refused
  test_the_readers_refuse_a_missing_or_malformed_pr
  test_comment_only_rounds_count
  test_large_comment_feed_still_counts
  test_initialization_failures_are_not_rounds
  test_the_missing_environment_is_not_a_round
  test_the_connector_thread_reply_is_not_a_round
  test_a_round_quoting_the_ref_error_still_counts
  test_no_rounds_yet
  test_threshold
  test_threshold_off
  test_api_failure_is_unknown
  test_a_broken_jq_program_is_not_a_round_count
  test_rounds_ends_with_its_trailer
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
