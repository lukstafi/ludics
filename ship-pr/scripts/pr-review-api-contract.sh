#!/usr/bin/env bash
# The live-API contract behind pr-review.sh's fixtures (ludics-lite#41).
#
# The fixture suites (test-pr-review-*.sh) drive the gate against canned answers, so they pin the
# LOGIC and take the SHAPES on faith: which fields the projections read, in what order the runs
# feed comes back, which status and conclusion strings occur, what a PR read says about its base
# and its mergeability. A renamed field, a changed default ordering or a new conclusion string
# leaves every fixture green and a merge gate reading a head wrong — the silent direction. This
# script asks the repository's own live API the same questions, one jq read per belief, and
# reports each belief on its own line, so a failure localizes to the field that moved rather than
# to "the gate said something odd". It reads only what the projections read; it never judges a
# head, and it never writes.
#
# Usage: pr-review-api-contract.sh [owner/name]      (default: $GITHUB_REPOSITORY, else the
#                                                     repository this script was written in)
# Environment, all optional:
#   CONTRACT_BASE            the base branch (default: the repository's default branch)
#   CONTRACT_STALE_BASE_PR   a MERGED PR whose `.base.sha` is NOT its merge commit's first parent
#                            (ludics-lite#53: merged behind a sibling, so the snapshot stood
#                            still) — the pulls-API belief from ludics-lite#44/#47. The snapshot
#                            claims hold whatever the merge strategy was; the separate
#                            second-parent claim needs a MERGE-merged anchor and skips itself,
#                            saying so, on a squash- or rebase-merged one
#   CONTRACT_REVIEWED_PR     a PR the review app reviewed with at least one round of inline
#                            findings AND approved (ludics-lite#39) — the reactions, reviews and
#                            comments beliefs of the status/rounds suites; the pagination belief
#                            needs more than 30 inline comments and skips on a smaller anchor
#   CONTRACT_OWN_HEAD        under Actions: the head this job's own run is attached to
#                            (github.event.pull_request.head.sha, else github.sha); with
#                            GITHUB_RUN_ID it pins the job's own row as the newest for that head
#   CONTRACT_SUMMARY_SAMPLE  how many of the newest merged PRs the summary-row beliefs read
#                            (default 60; two paginated reads each)
#   CONTRACT_THREADS_PR      a PR with at least three review threads whose first comments' ids
#                            run past 2^31 (ludics-lite#389) — the reviewThreads beliefs of the
#                            open-thread gate and `resolve`; the not-clamped claim skips on an
#                            anchor whose ids are all below 2^31
#   CONTRACT_WIDE_COMMIT     <owner/name>@<sha> of a commit whose first-parent diff has more files
#                            than the endpoint's default page (300), and CONTRACT_WIDE_COMMIT_FILES
#                            that diff's file count, counted with git (`git diff --name-only
#                            <sha>^1 <sha> | wc -l`; a fact of an immutable commit) — the
#                            commit-files paging commit_files rests on (ludics-lite#177). Another
#                            repository's commit, by default: this one has none that wide, and
#                            the endpoint's paging is GitHub's, not a repository's
#   REVIEWER                 the review app's login without its [bot] suffix (pr-review.sh's)
#
# Exit 0: every checkable belief holds. 1: at least one MOVED (listed, all of them — the script
# does not stop at the first). 3: the API did not answer (no answer, a 5xx, a request timeout —
# 408, 425 — or throttling — 429 or a 403 naming a rate limit — after retries), which is not a
# moved belief and ends the run
# at once — every read is an assignment under errexit, so a failed read cannot feed empty data
# into the claims after it. 4: an endpoint or anchor the contract addresses answered a 4xx other
# than those — the input was validated, so this is a retired or renamed endpoint (drift), or a
# wrong anchor; it ends the run the same way. 5: the read was refused (401/403 that is not a rate
# limit) — the token or the workflow's permissions, not a moved belief, but a red a schedule
# would otherwise hide. Any other exit is the contract stopping early, and the EXIT trap says
# so; the workflow reports every exit but 0 and 3, naming which. A belief this repository
# cannot check prints as `skip`, with the reason, so the unpinned set is visible in every run
# rather than assumed away.
#
# This script's own logic — which claims pin and which skip, the read guards, how a failed read is
# sorted, the cleanup on exit — is pinned by test-pr-review-api-contract.sh against a fixture world
# (ludics-lite#91): a belief added or reworded here changes that suite's expected verdict list too.

set -euo pipefail

# pr-review.sh itself, sourced without running, for its `jq` (the line ending a native jq.exe
# writes is decided there once, for every script that sources it). Every function this file defines
# comes after this line and shares no name with the library's (the trap test-pr-review-lib.sh
# guards the suites against).
export SHIP_PR_TEST_SOURCE_ONLY=1
# shellcheck source=pr-review.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/pr-review.sh"
# The gate itself is Python (lib/ludics/prreview, ludics-lite#403), and what this contract sends
# in its words is asked of it rather than restated: the branch encoder warn_base_drift's tip read
# uses (shtext.encode_ref), and the review-threads query (threads.THREADS_QUERY). The checkout's
# runner, physically resolved, as pr-review.sh's forward finds it.
CONTRACT_PY="$(CDPATH= cd -P "$(dirname "${BASH_SOURCE[0]}")" && cd -P ../.. && pwd -P)/scripts/py"
gate_py() { # <python statements, reading sys.argv[1:]> [arg...]
  "$CONTRACT_PY" -c "import sys
sys.stdout.reconfigure(newline='\\n')
$1" "${@:2}" || {
    echo "pr-review-api-contract.sh: the gate's Python ($CONTRACT_PY) did not answer; the contract cannot speak in its words" >&2
    exit 2
  }
}
encode_ref() { gate_py 'from ludics.prreview.shtext import encode_ref; print(encode_ref(sys.argv[1]))' "$1"; }
# How status_state orders a summary row's datetime, spelled in jq for the reads below: the gate's
# state.instant (fraction padded to nine digits, so the string order is the time order). It is the
# one piece of the gate's reading this file restates, since the gate itself runs no jq;
# test-pr-review-api-contract.sh holds the two spellings to the same answers.
SUMMARY_ROW_INSTANT_DEF='def instant: sub("Z$"; "") | (if test("\\.") then . else . + "." end) + "000000000" | .[0:29];'

REPO="${1:-${GITHUB_REPOSITORY:-lukstafi/ludics-lite}}"
REVIEWER="${REVIEWER:-chatgpt-codex-connector}"
BOT="${REVIEWER}[bot]" # how an app's login reads in every feed: matched by prefix in the gate
STALE_BASE_PR="${CONTRACT_STALE_BASE_PR:-}"
REVIEWED_PR="${CONTRACT_REVIEWED_PR:-}"
THREADS_PR="${CONTRACT_THREADS_PR:-}"
WIDE_COMMIT="${CONTRACT_WIDE_COMMIT:-}"
WIDE_COMMIT_FILES="${CONTRACT_WIDE_COMMIT_FILES:-}"
if [ "$REPO" = lukstafi/ludics-lite ]; then
  : "${STALE_BASE_PR:=53}"
  : "${REVIEWED_PR:=39}"
  # #370: five threads, their first comments 4095735684 and up, all past 2^31.
  : "${THREADS_PR:=370}"
  # The merge of origin/master into a branch, 353 files against its first parent, one a rename.
  if [ -z "$WIDE_COMMIT" ]; then
    WIDE_COMMIT=lukstafi/ocannl@eaa6313d983cbb2c698e23507a7094dde99e79bb
    WIDE_COMMIT_FILES=353
  fi
fi

# The vocabularies the projections classify. conclusion_class (prreview/checkruns.py) maps failure,
# timed_out and startup_failure to red; success, skipped and neutral to green; null to pending;
# and EVERYTHING ELSE to stopped-not-judged — so a conclusion string outside this list would be
# absorbed silently, which is why membership is a belief and not a tautology.
STATUS_VOCAB='["queued","in_progress","completed","waiting","requested","pending"]'
CONCLUSION_VOCAB='["success","failure","cancelled","skipped","neutral","timed_out","action_required","stale","startup_failure"]'
MERGEABLE_STATE_VOCAB='["clean","dirty","unstable","blocked","behind","unknown","draft","has_hooks"]'
REVIEW_STATE_VOCAB='["APPROVED","CHANGES_REQUESTED","COMMENTED","DISMISSED","PENDING"]'
# How the projections select the reviewer's rows: by PREFIX — `(.user.login // "") |
# startswith($rev)` in status_state, review_rounds and cmd_poll alike. Every claim below about
# the app's rows selects the same way, so the set a claim is made about is the set the gate acts
# on. Selecting on the exact `$BOT` login was narrower than that: a login carrying some other
# suffix would be consumed by the projections and covered by no belief here (ludics-lite#70, from
# #66's round 13). That the suffix IS `[bot]` stays a belief of its own — the one claim that must
# keep naming the exact login, since exactness is what it is about.
APP='((.user.login // "") | startswith($rev))'
ISO='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
HEX40='^[0-9a-f]{40}$'

CLAIMS=0
MOVED=0
SKIPPED=0
# The one part of CLAIMS that varies with nothing drifting: cmd_base's section claims the runs
# wrapper once per workflow it asks before one has push runs on the base, so the total moves with
# the workflow list's order and history (52, 64, 66 and 67 over four runs of #169). The verdict
# names it, so two runs' totals compare (ludics-lite#177).
WRAPPER_CLAIMS=0

# api <gh api args...>: one read, of the raw body — never with --jq. A projection that fails
# inside gh exits nonzero with no HTTP status, indistinguishable from transport, so every
# projection is a local jq on the body, where a wrong shape is a claim (MOVED) or an early stop
# the EXIT trap names — reported either way, never a suppressed exit 3. The HTTP status sorts
# the failures. Throttling (429, or a 403 naming a rate limit), a 5xx and no answer at all are
# retried three times and are then transport — exit 3, not drift, left to the next run. 401 and
# 403 otherwise are the token or the workflow's permissions refusing the read — exit 5, not
# drift either, but reported. Any other 4xx is the API answering "no such thing" about an input
# this script validated before asking: a retired or renamed endpoint, or a wrong anchor — exit
# 4, drift, no retry. GraphQL answers a query it rejects — a field it no longer has, or a PR
# number that resolves to nothing — inside an HTTP 200, as an `errors` list with no status line,
# so that shape is the same exit 4 rather than three retries ending as transport (exit 3, which
# the workflow does not report); its own timeout message is retried like a 5xx. Each ends the run
# from inside a command substitution too: the caller's assignment fails, and the script runs
# under errexit.
api() {
  local attempt out
  case " $* " in
  *" --jq "* | *" --jq="* | *" -q "*)
    echo "pr-review-api-contract.sh: api takes no --jq — project the body locally, where a wrong shape is a claim and not a transport failure: gh api $*" >&2
    exit 2
    ;;
  esac
  for attempt in 1 2 3; do
    if out=$(gh api "$@" 2>&1); then
      printf '%s\n' "$out"
      return 0
    fi
    case "$out" in
    # The 4xx about the connection rather than the request: throttling, and a request timeout.
    *"HTTP 429"* | *"HTTP 408"* | *"HTTP 425"* | *"rate limit"* | *"Rate limit"*) ;; # retried, transport if it persists
    *"HTTP 401"* | *"HTTP 403"*)
      echo "pr-review-api-contract.sh: the API refused the read (the token or the workflow's permissions, not a moved belief): gh api $* -> ${out##*$'\n'}" >&2
      exit 5
      ;;
    *"HTTP 4"[0-9][0-9]*)
      echo "pr-review-api-contract.sh: an endpoint the contract addresses answered 4xx (retired, renamed, or a wrong anchor): gh api $* -> ${out##*$'\n'}" >&2
      exit 4
      ;;
    *"HTTP 5"[0-9][0-9]* | *"Something went wrong while executing your query"*) ;; # retried
    *'"errors":['*)
      echo "pr-review-api-contract.sh: GraphQL rejected the query (a field it asks for is gone or renamed, or a wrong anchor): gh api ${1:-} -> ${out##*$'\n'}" >&2
      exit 4
      ;;
    esac
    [ "$attempt" -eq 3 ] || sleep $((attempt * 5))
  done
  echo "pr-review-api-contract.sh: the API did not answer: gh api $* -> ${out##*$'\n'}" >&2
  exit 3
}

# Paginated wrapper lists: gh emits one body per page, and the pages' <field> lists are joined
# here — null when any page lacks the list, so the wrapper claim after the read records the
# MOVED and the row-level claims skip on an unusable input.
pages() { # <field>
  jq -s --arg f "$1" 'if length > 0 and all(.[]; type == "object" and (.[$f] | type == "array")) then map(.[$f]) | add else null end'
}

# Scratch files, for the lists a claim compares against: the paginated feed of a long-reviewed
# PR is over Linux's per-argument limit (the rounds suite's known trap), and a head's job-name
# list grows with every re-run, so a list never rides the argument vector — a claim's subject
# arrives on stdin and its comparison lists through --slurpfile (each read as $name[0]).
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/pr-review-api-contract.XXXXXX")
# Physical path, the house idiom: on macOS $TMPDIR is under /var, a symlink to /private/var, and
# a path that reaches a message or a comparison unresolved reads as a different directory than
# the same one spelled with `pwd -P` (ludics-lite#208).
SCRATCH=$(CDPATH= cd "$SCRATCH" && pwd -P)

# Any exit this script did not choose — a jq that cannot iterate a wrapper that moved, say — is
# named here, so the log says what stopped and the workflow's reporter (every exit but 0 and 3)
# has something to point at. Sourcing pr-review.sh installs no trap of its own for this one to
# replace (it leaves nothing behind since its shell half was retired); when it did, this trap
# called its cleanup by name rather than restating it (ludics-lite#195).
on_exit() {
  local rc=$?
  rm -rf "$SCRATCH"
  case "$rc" in
  0 | 1 | 2 | 3 | 4 | 5) ;;
  *) echo "pr-review-api-contract.sh: the contract stopped early with exit $rc after $CLAIMS beliefs ($MOVED moved): a shape it did not expect, most likely — read the log as drift until shown otherwise" >&2 ;;
  esac
}
trap on_exit EXIT

# pin <belief> <jq filter> <json> [jq args...]: the filter must yield true on the json. A value
# the filter compares against travels as a jq argument (--arg / --argjson), never interpolated
# into the program, so a legal but odd value (a quote in a workflow name) cannot change its syntax.
pin() {
  local belief="$1" filter="$2" json="$3"
  shift 3
  CLAIMS=$((CLAIMS + 1))
  if jq -e "$@" "$filter" <<<"$json" >/dev/null 2>&1; then
    printf 'ok    %s\n' "$belief"
  else
    MOVED=$((MOVED + 1))
    printf 'MOVED %s\n      filter: %s\n      read:   %s\n' "$belief" "$filter" \
      "$(jq -c . <<<"$json" 2>/dev/null | cut -c1-400)"
  fi
}

# A read built from a field another read returned validates that field first: a field that moved
# has already been recorded MOVED above, and the dependent request would only turn that drift
# into a 404 — exit 3, transport — and hide every MOVED line after it.
# The sets are spelled out, never ranges: a bracket range collates by the locale, and under bash
# 3.2 in en_US.UTF-8 `a-f` admits the capitals between them, so an upper-case sha passed (found by
# test-pr-review-api-contract.sh's hostile-locale pass, ludics-lite#91).
is_sha() { case "$1" in *[!0123456789abcdef]* | '') return 1 ;; esac; [ "${#1}" -eq 40 ]; }
is_num() { case "$1" in '' | *[!0123456789]*) return 1 ;; esac; }
# A list whose wrapper moved arrives as null; row-level claims on it would crash a jq under
# errexit instead of standing behind the MOVED the wrapper claim recorded.
is_list() { jq -e 'type == "array"' <<<"$1" >/dev/null 2>&1; }
UNUSABLE="its input is not usable — see the MOVED above"

skip() { # <belief> <why>
  SKIPPED=$((SKIPPED + 1))
  printf 'skip  %s — %s\n' "$1" "$2"
}

section() { printf '\n== %s\n' "$*"; }

# The fixture suite (test-pr-review-api-contract.sh) loads everything above — the helpers, the
# scratch directory and the EXIT trap that removes it — without the reads below: sourced with
# CONTRACT_TEST_SOURCE_ONLY=1, this file ends here (ludics-lite#91). pr-review.sh's own
# SHIP_PR_TEST_SOURCE_ONLY cannot serve, since this file exports it itself to source the library.
if [ "${CONTRACT_TEST_SOURCE_ONLY:-}" = 1 ]; then
  return 0 2>/dev/null || { echo "pr-review-api-contract.sh: CONTRACT_TEST_SOURCE_ONLY=1 is for sourcing this file, not running it" >&2; exit 2; }
fi

# --- the anchors ------------------------------------------------------------------------------
section "anchors on $REPO"
if [ -n "${CONTRACT_BASE:-}" ]; then
  BASE="$CONTRACT_BASE"
else
  repo=$(api "repos/$REPO")
  pin "repos/<owner/name> carries default_branch (the drift anchor's ref when none is given)" \
    '.default_branch | type == "string" and length > 0' "$repo"
  BASE=$(jq -r '.default_branch // empty' <<<"$repo")
  [ -n "$BASE" ] || { echo "pr-review-api-contract.sh: the repository read carries no default branch; nothing below can be anchored (1 moved)" >&2; exit 1; }
fi
# The ref goes through the gate's encoder, as warn_base_drift's tip read sends it: a legal
# name such as release#1 would otherwise become a URL fragment. Encoded once, by itself, so an
# encoder that did not answer stops the contract (exit 2) instead of reading an empty ref.
BASE_ENC=$(encode_ref "$BASE")
tip=$(api "repos/$REPO/commits/$BASE_ENC")
pin "commits/<encode_ref branch> answers the branch tip's sha and committer date (the drift anchor and the push clock)" \
  "(.sha | test(\"$HEX40\")) and (.commit.committer.date | test(\"$ISO\"))" "$tip"
HEAD=$(jq -r '.sha // empty' <<<"$tip")
is_sha "$HEAD" || { echo "pr-review-api-contract.sh: the tip read carries no usable sha; nothing below can be anchored (1 moved)" >&2; exit 1; }
echo "      base $BASE tip $HEAD"

# --- actions/runs?head_sha= -------------------------------------------------------------------
section "actions/runs?head_sha=<tip> — run_signal's feed"
# The newest 100 rows, not the whole history: these are shape claims, a sample carries them, and
# a tip that accumulates a scheduled run a day would otherwise grow every read without bound.
runs=$(api "repos/$REPO/actions/runs?head_sha=$HEAD&per_page=100" | pages workflow_runs)
pin "the feed is workflow_runs[]" 'type == "array"' "$runs"
# An empty list is a valid signal the gate handles (a paths-ignored push, a repository without
# push workflows), not a moved shape: the row-level claims need a sample, and say so without one.
if ! is_list "$runs"; then
  skip "the row-level claims on the tip's runs" "$UNUSABLE"
  runs='[]'
elif [ "$(jq length <<<"$runs")" -eq 0 ]; then
  skip "the row-level claims on the tip's runs" "the tip has no Actions run (a paths-ignored push, or a repository without push workflows)"
else
pin "every row carries the fields the fold indexes: numeric id and workflow_id, string event, name and status, created_at (created_at and id are the sort key it orders on)" \
  'all(.[]; (.id | type == "number") and (.workflow_id | type == "number") and (.event | type == "string" and length > 0)
             and (.name | type == "string") and (.status | type == "string") and (.created_at | test("'"$ISO"'")))' "$runs"
pin "every row's head_sha is the sha asked for (the filter filters)" \
  'all(.[]; .head_sha == $head)' "$runs" --arg head "$HEAD"
pin "status strings are in the known vocabulary" \
  "all(.[]; .status as \$s | $STATUS_VOCAB | index(\$s))" "$runs"
# A nullable field is asserted PRESENT and then null-or-valid: jq reads an absent key as null,
# so `== null` alone would pass a feed that dropped the field — which the projections would read
# as pending forever (`.conclusion // "pending"`), the silent direction.
pin "every row carries conclusion (present, null until completed) and it is in the vocabulary conclusion_class classifies" \
  "all(.[]; has(\"conclusion\") and (.conclusion == null or (.conclusion as \$c | $CONCLUSION_VOCAB | index(\$c))))" "$runs"
pin "a row that is not completed has no conclusion yet" \
  'all(.[]; .status == "completed" or .conclusion == null)' "$runs"
echo "      events seen on the tip: $(jq -r '[.[].event] | unique | join(" ")' <<<"$runs")"
echo "      status/conclusion seen: $(jq -r '[.[] | "\(.status)/\(.conclusion)"] | unique | join(" ")' <<<"$runs")"
fi

# Newest-first on this feed is no longer load-bearing for any fold: run_signal sorts its rows on
# (created_at desc, id desc) itself (ludics-lite#70), and since ludics-lite#90 so does cmd_base —
# which reads a different endpoint besides (the per-workflow, branch-and-event feed pinned in its
# own section below, where the order still decides WHICH rows a per_page=10 window holds). The
# claim stays because this endpoint IS read unpaged at per_page=100 and an order that moved would
# change which runs a head's page carries; one row proves nothing about order, so it is made on
# the tip when it has several, else on the repository's whole feed, which the same endpoint
# serves.
if [ "$(jq length <<<"$runs")" -ge 2 ]; then
  pin "runs?head_sha= comes back newest-first (created_at non-increasing, on the tip's $(jq length <<<"$runs") rows)" \
    '[.[].created_at] | . == (sort | reverse)' "$runs"
  # Ties (two rows created in the same second) are ordered by nothing GitHub documents, so their
  # order is observed here, not asserted — and since ludics-lite#70 nothing rests on it either:
  # run_signal sorts the feed on (created_at desc, id desc) before folding, so within a
  # workflow-and-event key a tied pair is settled by the higher run id, the later allocation.
  # The count still prints, because how often the shape occurs at all is worth seeing (two
  # invocations of one key inside a second is two dispatches on one sha; a re-run keeps its row,
  # run_attempt bumped) — but it is an observation now, not a hazard.
  echo "      created_at ties on the tip: $(jq '[group_by(.created_at)[] | select(length > 1)] | length' <<<"$runs") group(s); same workflow-and-event inside one tie: $(jq '[group_by(.created_at)[] | select(length > 1) | group_by([.workflow_id, .event])[] | select(length > 1)] | length' <<<"$runs")"
else
  all_runs=$(api "repos/$REPO/actions/runs?per_page=100" | pages workflow_runs)
  pin "actions/runs is workflow_runs[] here too" 'type == "array"' "$all_runs"
  if is_list "$all_runs" && [ "$(jq length <<<"$all_runs")" -ge 2 ]; then
    pin "actions/runs comes back newest-first (created_at non-increasing, over the latest $(jq length <<<"$all_runs") runs)" \
      '[.[].created_at] | . == (sort | reverse)' "$all_runs"
  else
    skip "actions/runs comes back newest-first" "fewer than two runs to order, or the list is not usable"
  fi
fi

if is_num "${GITHUB_RUN_ID:-}" && is_sha "${CONTRACT_OWN_HEAD:-}"; then
  own=$(api "repos/$REPO/actions/runs?head_sha=$CONTRACT_OWN_HEAD&per_page=100" | pages workflow_runs) # the own run is among the newest on its head
  is_list "$own" || own='[]' # the wrapper claim above has recorded the MOVED; these then move too, on an empty list
  pin "this job's own run (id $GITHUB_RUN_ID) is a row on its head, unfinished, with no conclusion" \
    'any(.[]; .id == $run and .status != "completed" and .conclusion == null)' "$own" --argjson run "$GITHUB_RUN_ID"
  # On a scheduled or dispatched run the head is the base tip, whose push run came long before
  # this one, so the list has at least two rows created apart — a live newest-first check on a
  # filtered head. Not "this run is row 0": another workflow dispatched on the same SHA after
  # this run was created may rightly sit above it.
  case "${GITHUB_EVENT_NAME:-}" in
  schedule | workflow_dispatch)
    # One row cannot show an order: a dispatch on a sha with no earlier run is valid and skips.
    if [ "$(jq length <<<"$own")" -ge 2 ]; then
      pin "on a $GITHUB_EVENT_NAME run, runs?head_sha= for this job's own head ($(jq length <<<"$own") rows) is newest-first by created_at, live" \
        '[.[].created_at] | . == (sort | reverse)' "$own"
    else
      skip "newest-first on this job's own head, live" "a $GITHUB_EVENT_NAME run on a sha with no earlier run: one row shows no order"
    fi
    ;;
  *) skip "newest-first on a multi-row head, live" "on a ${GITHUB_EVENT_NAME:-?} run the head's rows are created in the same second" ;;
  esac
else
  skip "this job's own run is a row on its head, and that head is newest-first" "not running under Actions (GITHUB_RUN_ID and CONTRACT_OWN_HEAD unset)"
fi

wid=$(jq -r '.[0].workflow_id // empty' <<<"$runs")
wname=$(jq -r '.[0].name // empty' <<<"$runs")
if is_num "$wid"; then
  wf=$(api "repos/$REPO/actions/workflows/$wid")
  pin "workflow_id resolves to a workflow FILE whose name is the run's name (the fold keys on the file, not the display name)" \
    '(.path | startswith(".github/workflows/")) and .name == $wname' "$wf" --arg wname "$wname"
  # The file's own text, which is what `base --wait` reads to decide whether a tip with no run is
  # one the workflow's paths-ignore excludes, and whether the workflow still runs on push at all
  # (base.py's Base.push_trigger, ludics-lite#401). It asks for the RAW media
  # type, because the JSON envelope's base64 body wants a decoder spelled `-d` on one of this
  # fleet's platforms and `-D` on the other. What can move is the media type being ignored and the
  # envelope arriving anyway: the parser would see one long line of base64, refuse it, and every
  # paths-ignore recognition would quietly cost the grace instead.
  wpath=$(jq -r '.path // empty' <<<"$wf")
  case "$wpath" in
  .github/workflows/*)
    wbody=$(api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/$wpath?ref=$HEAD")
    pin "contents/<path> under the raw media type answers with the workflow file's own text, not the base64 JSON envelope" \
      '(test("(^|\n)(on|\"on\")[ ]*:")) and (test("\"content\"[ ]*:") | not)' "$(jq -Rs . <<<"$wbody")"
    ;;
  *) skip "the workflow file's own text" "$UNUSABLE" ;;
  esac
else
  skip "workflow_id resolves to a workflow file" "$UNUSABLE"
fi

# --- actions/workflows, and actions/workflows/<id>/runs?branch=&event=push -----------------------
# The two endpoints `cmd_base` reads, and neither was addressed here until ludics-lite#90: the
# suites' fixtures imitated both shapes and nothing checked the imitation against the live API —
# #41's class exactly. `base` is what every worker reads at session start, what the coordinator
# reads after a merge, and what base-watch files issues from, so a field that moved here is a
# false green or a false red with no fixture able to notice.
section "actions/workflows?per_page=100 and actions/workflows/<id>/runs?branch=&event=push — cmd_base's feeds"
wfs=$(api "repos/$REPO/actions/workflows?per_page=100")
pin "the workflow list is workflows[], with total_count beside it" \
  '(.workflows | type == "array") and (.total_count | type == "number")' "$wfs"
wflist=$(jq -c '.workflows // null' <<<"$wfs")
if ! is_list "$wflist" || [ "$(jq length <<<"$wflist")" -eq 0 ]; then
  skip "the row-level claims on the workflow list" "$UNUSABLE"
  wflist='[]'
else
  # The projection is `[(.id | tostring), .name] | @tsv`: two columns, and a name carrying a TAB
  # would shift the second past the first through the fold's tab-IFS `read`. The id is what the
  # fold groups on — two workflow FILES can share a display name — and `is_advisory` matches on
  # the name, so an empty one would silently opt a workflow out of that classification.
  pin "every workflow carries the two fields the row projection reads: a numeric id and a non-empty name with no tab in it" \
    'all(.[]; (.id | type == "number") and (.name | type == "string" and length > 0 and (test("\t") | not)))' "$wflist"
  pin "every workflow carries the path the paths-ignore read asks for, under .github/workflows/" \
    'all(.[]; .path | type == "string" and startswith(".github/workflows/"))' "$wflist"
  # head_within_paths_ignore examines only an `active` workflow: a disabled one, or one listed
  # after its file was deleted, has no filter to read at the head and no run to wait for. A state
  # vocabulary that grew a new word for "live" would make that read skip a workflow that does run,
  # and the recognition would settle a head whose run is on its way.
  pin "every workflow carries a state drawn from the vocabulary the head recognition reads (active = can create a run)" \
    'all(.[]; .state as $s | ($s | type == "string") and (["active", "deleted", "disabled_fork", "disabled_inactivity", "disabled_manually"] | index($s)))' "$wflist"
  # One page of 100 is all cmd_base asks for: past that a workflow simply vanishes from the
  # report, and its standing verdict with it. Worth knowing before it happens, not after.
  pin "this repository's workflows fit the single page cmd_base reads ($(jq length <<<"$wflist") of a page of 100)" \
    '(.total_count // 0) <= 100 and ((.workflows | length) == (.total_count // 0))' "$wfs"
fi

# The runs feed, asked per workflow rather than as one flat page: on an active branch a page of
# mixed runs can entirely postdate an infrequent workflow's newest run. The anchor is the first
# listed workflow that actually has push runs on the base — a workflow with none is the `norun`
# shape the wait loop has its own grace for, a valid answer and not drift.
bruns='[]'
banchor=""
bname=""
for wf_id in $(jq -r '.[].id // empty' <<<"$wflist"); do
  is_num "$wf_id" || continue
  bruns=$(api "repos/$REPO/actions/workflows/$wf_id/runs?branch=$BASE_ENC&event=push&per_page=10" | pages workflow_runs)
  # The wrapper is claimed for EVERY workflow this loop asks about, before the answer is used for
  # anything. A feed that dropped or renamed `workflow_runs` comes back null, and moving on to the
  # next workflow without recording that would walk the whole list and land on the "no push run"
  # skip below — the contract exiting 0 over exactly the drift this section exists to catch
  # (#169, round 1). An empty list is not that: a workflow with no push run on this branch is the
  # `norun` shape the wait loop has its own grace for, a valid answer and not drift.
  pin "workflow $wf_id's branch-and-event feed is workflow_runs[]" 'type == "array"' "$bruns"
  WRAPPER_CLAIMS=$((WRAPPER_CLAIMS + 1))
  is_list "$bruns" || { bruns='[]'; continue; }
  if [ "$(jq length <<<"$bruns")" -gt 0 ]; then
    banchor="$wf_id"
    bname=$(jq -r --argjson w "$wf_id" '[.[] | select(.id == $w)][0].name // empty' <<<"$wflist")
    break
  fi
done
if [ -z "$banchor" ]; then
  skip "the branch-and-event runs feed" "no listed workflow has a push run on $BASE (every one of them is the norun shape)"
else
  echo "      anchored on workflow $banchor (${bname:-?}) with $(jq length <<<"$bruns") push run(s) on $BASE"
  # The projection cmd_base reads, column by column: workflow_id (the fold's grouping key), name,
  # status, conclusion, head_sha, created_at, html_url, and — since ludics-lite#81 — id, which
  # anchors the jobs read the red report spends and, since #90, breaks a same-second tie.
  pin "every row carries the eight fields the fold projects: numeric workflow_id and id, string name and status, a 40-hex head_sha, an ISO created_at, and an html_url" \
    "all(.[]; (.workflow_id | type == \"number\") and (.id | type == \"number\")
              and (.name | type == \"string\") and (.status | type == \"string\")
              and (.head_sha | test(\"$HEX40\")) and (.created_at | test(\"$ISO\"))
              and (.html_url | type == \"string\" and length > 0))" "$bruns"
  # Asserted PRESENT and then null-or-known: jq reads an absent key as null, and the projection's
  # `.conclusion // "pending"` would render a dropped field as pending forever — a workflow stuck
  # at "no verdict" on a branch that is in fact green or red, the silent direction.
  pin "every row carries conclusion (present, null until completed), in the vocabulary conclusion_class classifies" \
    "all(.[]; has(\"conclusion\") and (.conclusion == null or (.conclusion as \$c | $CONCLUSION_VOCAB | index(\$c))))" "$bruns"
  pin "status strings are in the known vocabulary" \
    "all(.[]; .status as \$s | $STATUS_VOCAB | index(\$s))" "$bruns"
  pin "the workflow_id in the path is the workflow every row belongs to (the per-workflow query really is per workflow)" \
    'all(.[]; .workflow_id == $w)' "$bruns" --argjson w "$banchor"
  pin "the event= filter filters: every row is a push run" 'all(.[]; .event == "push")' "$bruns"
  pin "the branch= filter filters: every row's head_branch is $BASE" \
    'all(.[]; .head_branch == $b)' "$bruns" --arg b "$BASE"
  # Newest-first is what makes `per_page=10` a WINDOW of the newest ten runs rather than ten
  # arbitrary ones: cmd_base's fold and base_red_detail's streak walk both read that window as a
  # history, and a page ordered any other way would report a red as starting at the wrong commit
  # — or hide a newer verdict behind an older one entirely. Since ludics-lite#90 the fold no
  # longer depends on the order WITHIN the page (it sorts each page on (created_at desc, id desc)
  # itself), so this claim is now about which rows the page holds, not about which of them wins.
  if [ "$(jq length <<<"$bruns")" -ge 2 ]; then
    pin "the page comes back newest-first (created_at non-increasing over its $(jq length <<<"$bruns") rows), so per_page=10 is the newest ten" \
      '[.[].created_at] | . == (sort | reverse)' "$bruns"
    echo "      created_at ties in this window: $(jq '[group_by(.created_at)[] | select(length > 1)] | length' <<<"$bruns") group(s) — settled by the higher run id since ludics-lite#90"
  else
    skip "the page comes back newest-first" "one push run on $BASE for this workflow: a single row shows no order"
  fi
fi

# --- actions/runs/<id>/jobs ---------------------------------------------------------------------
section "actions/runs/<id>/jobs — run_jobs' feed (run_red_is_advisory_only, run_inflight_is_advisory_only)"
all_runs="${all_runs:-$(api "repos/$REPO/actions/runs?per_page=100" | pages workflow_runs)}"
# The sample is the latest run of ANY conclusion conclusion_class calls red, since the advisory
# read runs for each of them, not only for `failure`.
red_run=""
if is_list "$all_runs"; then
  red_run=$(jq -r '[.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure"))][0].id // empty' <<<"$all_runs")
fi
if is_num "$red_run"; then
  red_concl=$(jq -r --argjson id "$red_run" '.[] | select(.id == $id) | .conclusion' <<<"$all_runs")
  jobs=$(api --paginate "repos/$REPO/actions/runs/$red_run/jobs?per_page=100" | pages jobs)
  pin "the feed is jobs[] (run $red_run, the latest red run: $red_concl)" 'type == "array"' "$jobs"
  is_list "$jobs" || jobs='[]'
  # `.status` is deliberately NOT pinned here: run_jobs projects `.name`, `.conclusion`,
  # `.created_at` and `.completed_at` and nothing else, and a claim about a field no projection
  # reads would file a drift issue over a harmless change (ludics-lite#70, from #66's round 13).
  # The field stays pinned on `workflow_runs[]` above, where run_signal does read it.
  pin "jobs[] rows carry a non-empty name (run_red_is_advisory_only skips a row with none) and conclusion (present, null while unfinished)" \
    'all(.[]; (.name | type == "string" and length > 0) and has("conclusion") and (.conclusion == null or (.conclusion | type == "string")))' "$jobs"
  pin "job conclusions are in the same vocabulary as run conclusions" \
    "all(.[]; .conclusion == null or (.conclusion as \$c | $CONCLUSION_VOCAB | index(\$c)))" "$jobs"
  # The settle run_inflight_is_advisory_only waits out is measured on these two fields, and a
  # missing one HOLDS the run (ludics-lite#500) — so a field that moved would not merge anything
  # early, it would quietly turn SHIP_PR_ADVISORY_CHECKS back into a full wait. That is the drift
  # this names.
  pin "jobs[] rows carry an ISO created_at, and every finished job an ISO completed_at (run_inflight_is_advisory_only's settle)" \
    "all(.[]; (.created_at | type == \"string\" and test(\"$ISO\"))
              and (.conclusion == null or (.completed_at | type == \"string\" and test(\"$ISO\"))))" "$jobs"
  # The belief run_red_is_advisory_only rests on: it discards a run's red when no non-advisory
  # job is HARD red (failure, timed_out, startup_failure — conclusion_class's red), so a red run
  # whose jobs were all cancelled or stale would lose its red silently. A MOVED here is a gap in
  # that projection, which is the direction the contract exists to show.
  pin "a red run's jobs carry the red: at least one job concluded failure, timed_out or startup_failure, or no jobs at all (the startup_failure shape)" \
    'length == 0 or any(.[]; .conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure")' "$jobs"
elif is_list "$all_runs"; then
  skip "a red run's jobs name the red job" "no failure, timed_out or startup_failure run among the latest $(jq length <<<"$all_runs")"
else
  skip "a red run's jobs name the red job" "$UNUSABLE"
fi

# --- commits/<sha>/check-runs ---------------------------------------------------------------------
section "commits/<tip>/check-runs?filter=latest — build_checks's feed"
checks=$(api "repos/$REPO/commits/$HEAD/check-runs?filter=latest&per_page=100" | pages check_runs) # the first 100: a sample, like the runs
pin "the feed is check_runs[]" 'type == "array"' "$checks"
if ! is_list "$checks"; then
  skip "the row-level claims on the tip's check runs" "$UNUSABLE"
elif [ "$(jq length <<<"$checks")" -eq 0 ]; then
  skip "the row-level claims on the tip's check runs" "the tip has no check run (nothing ran on it, or nothing has created its checks yet)"
else
# The pending/finished distinction build_checks reads off the null conclusion, never off `.status`.
# `.status` is projected too, but only for the build wait's pause (ludics-lite#740): `in_progress`
# alone reads as a running check, polled at twice the interval, and any other value backs off to
# the build cap. So its vocabulary is not pinned closed (a new value is safe); that it is a string,
# and never `completed` beside a null conclusion, is. `.app.slug` is pinned because the correlation
# below selects on it — and because providers_are_actions_only now decides a GATE on it: it answers
# "does this repository have a check provider the workflow filters cannot speak for", and a slug
# for Actions that moved would make every check look like a third party's and cost the
# paths-ignore recognition its fast path (ludics-lite#176, review round 2).
pin "every check run carries a non-empty name (build_checks skips a row with none), conclusion (present, null while unfinished), html_url and app.slug" \
  'all(.[]; (.name | type == "string" and length > 0) and has("conclusion") and (.conclusion == null or (.conclusion | type == "string"))
             and (.html_url | type == "string") and (.app.slug | type == "string"))' "$checks"
pin "every check run carries a status string, never \"completed\" while its conclusion is null (the build wait's pause reads \"in_progress\" as running)" \
  'all(.[]; (.status | type == "string" and length > 0) and (.conclusion != null or .status != "completed"))' "$checks"
pin "check-run conclusions are in the vocabulary conclusion_class classifies" \
  "all(.[]; .conclusion == null or (.conclusion as \$c | $CONCLUSION_VOCAB | index(\$c)))" "$checks"
pin "every check run carries a check_suite.id (build_checks reads by name across every suite and provider)" \
  'all(.[]; .check_suite.id | type == "number")' "$checks"
# The literal providers_are_actions_only compares against. This repository's own checks are Actions'
# alone, so at least one row must carry it; a slug that moved shows up here rather than as a
# recognition that silently stopped firing.
pin "GitHub Actions' own check runs carry app.slug == \"github-actions\" (providers_are_actions_only's literal)" \
  'any(.[]; .app.slug == "github-actions")' "$checks"
# What build_checks asks of filter=latest is not uniqueness — two jobs may legally share a name,
# and it emits one row per check run — but that a re-run's superseded attempt is DROPPED, since
# a stale red twin would otherwise redden the head. So the belief is stated against filter=all:
# latest is a subset of all by id, and every row all has that latest lacks is superseded by a
# newer (higher-id) row of the same suite and name. The second half needs a re-run on the tip
# to be non-vacuous, and says so when there is none.
checks_all=$(api "repos/$REPO/commits/$HEAD/check-runs?filter=all&per_page=100" | pages check_runs)
if ! is_list "$checks_all"; then
  skip "filter=latest drops a re-run's superseded attempt" "the filter=all read is not a list — $UNUSABLE"
elif [ "$(jq length <<<"$checks_all")" -ge 100 ]; then
  skip "filter=latest drops a re-run's superseded attempt" "the tip has a page or more of check runs under filter=all; the sample cannot be compared whole"
else
  jq -c '[.[].id]' <<<"$checks" >"$SCRATCH/latest_ids.json"
  printf '%s\n' "$checks" >"$SCRATCH/latest.json"
  pin "filter=latest is a subset of filter=all by id (it filters; it does not invent rows)" \
    '[.[].id] as $all | $latest[0] | all(.[]; . as $i | $all | index($i))' "$checks_all" --slurpfile latest "$SCRATCH/latest_ids.json"
  # Two snapshots, read latest-then-all: a row in the later `all` that the earlier `latest`
  # lacks is either a superseded attempt or one CREATED BETWEEN the reads (a workflow starting on
  # the tip meanwhile). Check-run ids increase globally, so a row created after the first read
  # has an id above every id that read returned, while a superseded attempt never does — its
  # newer twin sits in `latest` with the higher id. The rows above that watermark are excluded
  # exactly, rather than by a re-read that only narrows the window; the claim counts them.
  n_dropped=$(jq --slurpfile latest "$SCRATCH/latest_ids.json" '($latest[0] | max) as $mark | [.[] | select((.id as $i | $latest[0] | index($i) | not) and .id < $mark)] | length' <<<"$checks_all")
  n_after=$(jq --slurpfile latest "$SCRATCH/latest_ids.json" '($latest[0] | max) as $mark | [.[] | select(.id > $mark)] | length' <<<"$checks_all")
  if [ "$n_dropped" -ge 1 ]; then
    pin "every check run filter=all has that filter=latest lacks ($n_dropped, with $n_after created between the two reads set aside) is a superseded attempt: a newer row of the same suite and name is in filter=latest (no stale twin, and no uniqueness asked of same-named jobs)" \
      '($latest[0] | max) as $mark | [.[] | select((.id as $i | $latest[0] | index($i) | not) and .id < $mark)]
       | all(.[]; .check_suite.id as $s | .name as $n | .id as $i | $lat[0] | any(.[]; .check_suite.id == $s and .name == $n and .id > $i))' \
      "$checks_all" --slurpfile latest "$SCRATCH/latest_ids.json" --slurpfile lat "$SCRATCH/latest.json"
  else
    skip "filter=latest drops a re-run's superseded attempt" "no re-run on the tip: filter=all has no row below filter=latest's newest that filter=latest lacks ($(jq length <<<"$checks") rows, $n_after created between the reads)"
  fi
fi
# A check run's suite is its run's — check_suite.id on the check joins check_suite_id on the run
# — so the correlation is exact (a check is named after a job of ITS run, not of some run on the
# tip) and bounded: the newest CORRELATE runs, whatever their status, since a check run exists
# only once its job does and a tip whose run is still queued has no completed run yet. One jobs
# read per run in the sample, never per run in the history: a tip accumulating a scheduled run
# a day would otherwise grow the loop without bound. Read AFTER the checks: a run exists before
# any of its checks, so a snapshot taken after the check read cannot lack the run behind a check
# — while the earlier snapshot could, for a workflow started on the tip in between. The names
# accumulate in a file and reach the claim through --slurpfile, off the argument vector.
CORRELATE=10
runs_after=$(api "repos/$REPO/actions/runs?head_sha=$HEAD&per_page=$CORRELATE" | pages workflow_runs)
correlation="every github-actions check run of the tip's newest $CORRELATE runs is named after a job of ITS run (the advisory deny-list matches JOB names)"
if ! is_list "$runs_after"; then
  skip "$correlation" "$UNUSABLE"
else
  pin "every run row carries a numeric check_suite_id (the join to a check run's check_suite.id)" \
    'all(.[]; .check_suite_id | type == "number")' "$runs_after"
  : >"$SCRATCH/suite_jobs"
  jobs_unusable=""
  for pair in $(jq -r '.[] | "\(.id // "-"):\(.check_suite_id // "-")"' <<<"$runs_after"); do
    rid=${pair%%:*}
    sid=${pair#*:}
    if ! is_num "$rid" || ! is_num "$sid"; then
      jobs_unusable=1
      continue
    fi
    api --paginate "repos/$REPO/actions/runs/$rid/jobs?per_page=100" | jq -c --argjson sid "$sid" '{suite: ($sid | tostring), jobs: [.jobs[]?.name]}' >>"$SCRATCH/suite_jobs"
  done
  jq -s 'group_by(.suite) | map({key: .[0].suite, value: (map(.jobs) | add | unique)}) | from_entries' "$SCRATCH/suite_jobs" >"$SCRATCH/suite_jobs.json"
  in_sample=$(jq --slurpfile m "$SCRATCH/suite_jobs.json" '[.[] | select(.app.slug == "github-actions") | select((.check_suite.id | tostring) as $s | $m[0] | has($s))] | length' <<<"$checks")
  if [ -n "$jobs_unusable" ]; then
    skip "$correlation" "a run row has no usable id or check_suite_id — see the MOVED above"
  elif [ "$in_sample" -eq 0 ]; then
    skip "$correlation" "none of the tip's check runs belongs to its newest $CORRELATE runs' suites (their jobs have not started yet)"
  else
    pin "$correlation, on $in_sample check runs" \
      '[.[] | select(.app.slug == "github-actions") | select((.check_suite.id | tostring) as $s | $m[0] | has($s))]
       | all(.[]; (.check_suite.id | tostring) as $s | .name as $n | $m[0][$s] | index($n))' "$checks" --slurpfile m "$SCRATCH/suite_jobs.json"
  fi
fi
fi

# --- pulls/<n> -----------------------------------------------------------------------------------
section "pulls/<n> — pr_head_read, the review and build clocks, warn_base_drift and await_mergeable"
if [ -n "$STALE_BASE_PR" ]; then
  pr=$(api "repos/$REPO/pulls/$STALE_BASE_PR")
  pin "the anchor PR #$STALE_BASE_PR is merged, with a merge_commit_sha, a base.sha, a head.sha and a base.ref" \
    "(.merged == true) and (.merge_commit_sha | test(\"$HEX40\")) and (.base.sha | test(\"$HEX40\")) and (.head.sha | test(\"$HEX40\")) and (.base.ref | type == \"string\" and length > 0)" "$pr"
  pin "a merged PR's mergeability is not computed: mergeable present and null, mergeable_state 'unknown'" \
    'has("mergeable") and .mergeable == null and .mergeable_state == "unknown"' "$pr"
  base_sha=$(jq -r '.base.sha // empty' <<<"$pr")
  merge_sha=$(jq -r '.merge_commit_sha // empty' <<<"$pr")
  head_sha=$(jq -r '.head.sha // empty' <<<"$pr")
  # warn_series_close's reading (ludics-lite#296): the PR's stated count leads the rows, and the
  # last row is the head -- a count that stopped agreeing would make every scan say it did not run.
  # Paginated as the reader is, and the pages' arrays joined, so an anchor of 101-250 commits is
  # judged on its whole series rather than on its first page (review round 1). Past the endpoint's
  # 250 cap the reader refuses to scan, so the claim is not made there either (round 2).
  series_n=$(jq '.commits // -1' <<<"$pr")
  if [ "$series_n" -gt 250 ] 2>/dev/null; then
    skip "pulls/<n>/commits agrees with the PR's .commits" "#$STALE_BASE_PR has $series_n commits, past the endpoint's 250 cap, where warn_series_close refuses to scan; an anchor under the cap pins this claim"
  else
    series=$(api --paginate "repos/$REPO/pulls/$STALE_BASE_PR/commits?per_page=100" |
      jq -cs 'if length > 0 and all(.[]; type == "array") then add else null end')
    pin "pulls/<n>/commits serves as many rows as the PR's .commits, oldest first, each with a sha and a string commit.message, the last one the PR's head (warn_series_close's shape)" \
      '(length == $n) and all(.[]; (.sha | test($hex)) and (.commit.message | type == "string")) and (.[-1].sha == $head)' \
      "$series" --argjson n "$series_n" --arg hex "$HEX40" --arg head "$head_sha"
  fi
  parent1=""
  if is_sha "$base_sha" && is_sha "$merge_sha" && is_sha "$head_sha"; then
    merge_commit=$(api "repos/$REPO/commits/$merge_sha")
    parent1=$(jq -r '.parents[0].sha // empty' <<<"$merge_commit")
    # Only a MERGE-merged anchor has a second parent to claim anything about. Squash and rebase
    # merges give `merge_commit_sha` a single parent and do not keep the head in the history at
    # all, so asserting it there reports MOVED about the repository's merge strategy rather than
    # about a field that moved — the drift signal reading as drift when nothing drifted
    # (ludics-lite#70, from #66's round 13). The parent COUNT settles which anchor this is, and a
    # one-parent anchor skips this claim with that reason on the line. The snapshot claims below
    # do not need the second parent: they are about `.base.sha` against the FIRST parent, which
    # every merge strategy has.
    if [ "$(jq '.parents | length' <<<"$merge_commit")" -ge 2 ]; then
      pin "the merge commit's second parent is the PR's head" '.parents[1].sha == $head' "$merge_commit" --arg head "$head_sha"
      # What tip_pr_head_verdict reads to call a tip a CLEAN merge of a PR head (ludics-lite#401):
      # GitHub's own merge commits are committed as noreply@github.com with a signature GitHub
      # verified. If either moved, every pushless tip would quietly read "no verdict".
      pin "GitHub's merge commit is committed by noreply@github.com with a verified signature (tip_pr_head_verdict's clean-merge test)" \
        '.commit.committer.email == "noreply@github.com" and .commit.verification.verified == true' "$merge_commit"
      tip_pulls=$(api "repos/$REPO/commits/$merge_sha/pulls?per_page=100")
      pin "commits/<merge sha>/pulls lists the PR it merged, with merged_at, that merge_commit_sha, its head.sha and base.ref (tip_pr_head_verdict's lookup)" \
        'any(.[]; .number == $n and .merged_at != null and .merge_commit_sha == $m and .head.sha == $h and (.base.ref | type == "string"))' \
        "$tip_pulls" --argjson n "$STALE_BASE_PR" --arg m "$merge_sha" --arg h "$head_sha"
    else
      skip "the merge commit's second parent is the PR's head" "#$STALE_BASE_PR was squash- or rebase-merged: its merge_commit_sha has one parent and does not carry the head as a parent at all; a merge-commit anchor pins this claim"
    fi
    pin "\`.base.sha\` is a SNAPSHOT, not the base the merge was built on: on #$STALE_BASE_PR it differs from the merge commit's first parent" \
      '.parents[0].sha != $base' "$merge_commit" --arg base "$base_sha"
  else
    skip "the anchor PR's merge commit and the base.sha snapshot" "$UNUSABLE"
  fi
  if is_sha "$parent1" && [ "$parent1" != "$base_sha" ]; then
    cmp=$(api "repos/$REPO/compare/$base_sha...$parent1?per_page=1")
    pin "... and the snapshot is BEHIND that parent (an ancestor, so 'behind' counts read off it undercount)" \
      '.status == "ahead" and .behind_by == 0 and .ahead_by >= 1' "$cmp"
    pin "compare/<a>...<b>?per_page=1 carries behind_by, ahead_by, merge_base_commit.sha and files[].filename (the drift fixture's shape)" \
      '(.behind_by | type == "number") and (.ahead_by | type == "number") and (.merge_base_commit.sha | test($hex))
       and (.files | type == "array" and length >= 1 and all(.[]; .filename | type == "string"))' "$cmp" --arg hex "$HEX40"
    # What compare_hunks and warn_base_drift's valid_file read per file: the counts and status,
    # previous_filename absent, null or non-empty, and a patch whose +/- line counts equal
    # additions/deletions — compare_hunks's own consistency test, failing which a file's hunks
    # read as unknown and every shared path becomes a possible same-region overlap. GitHub omits
    # patch on binary and oversized diffs, so the consistency claim is on the files that carry
    # one, of which the anchor compare must have at least one.
    pin "compare files[] rows carry string filename and status, numeric additions, deletions and changes, and previous_filename absent, null or non-empty (valid_file's shape)" \
      'all(.files[]; (.filename | type == "string" and length > 0) and (.status | type == "string") and (.additions | type == "number") and (.deletions | type == "number") and (.changes | type == "number")
                     and ((has("previous_filename") | not) or .previous_filename == null or ((.previous_filename | type) == "string" and (.previous_filename | length) > 0)))' "$cmp"
    if jq -e 'any(.files[]; .patch | type == "string")' <<<"$cmp" >/dev/null; then
      pin "on every compare file that carries a patch, its +/- line counts equal additions/deletions (compare_hunks's consistency test)" \
        'all(.files[] | select(.patch | type == "string");
           ([.patch | split("\n")[] | select(startswith("+"))] | length) == .additions and ([.patch | split("\n")[] | select(startswith("-"))] | length) == .deletions)' "$cmp"
    else
      skip "a compare file's patch agrees with its additions/deletions" "no file of the anchor compare carries a patch (binary or oversized diffs); an anchor with a text change shows it"
    fi
    pin "... and merge_base_commit is the older side when it is an ancestor" '.merge_base_commit.sha == $base' "$cmp" --arg base "$base_sha"
    if jq -e 'any(.files[]; .status == "renamed")' <<<"$cmp" >/dev/null; then
      pin "a renamed entry carries previous_filename" 'all(.files[] | select(.status == "renamed"); .previous_filename | type == "string")' "$cmp"
    else
      skip "a renamed compare entry carries previous_filename" "no rename in the anchor compare"
    fi
  else
    skip "the compare between the base.sha snapshot and the merge's first parent" "$UNUSABLE"
  fi
else
  skip "base.sha is a stale snapshot on a merged PR" "set CONTRACT_STALE_BASE_PR to a merged PR whose base moved before it merged"
fi

# Merged first, then the cut: closed-unmerged PRs would otherwise eat the sample, silently — and
# merged_at is asserted present, since a dropped field would empty the sample the same way.
closed=$(api "repos/$REPO/pulls?state=closed&sort=updated&direction=desc&per_page=100")
pin "pulls?state=closed is a list whose rows carry merged_at (present, null when closed unmerged)" \
  'type == "array" and all(.[]; has("merged_at"))' "$closed"
is_list "$closed" || closed='[]'
recent=$(jq -c '[.[] | select(.merged_at != null)] | .[0:10]' <<<"$closed")
n_recent=$(jq length <<<"$recent")
if [ "$n_recent" -ge 1 ]; then
  ok_all=true
  for n in $(jq -r '.[].number // "-"' <<<"$recent"); do
    if ! is_num "$n"; then
      ok_all=false
      echo "      a merged row of the closed-PR list has no numeric number ($n)"
      continue
    fi
    p=$(api "repos/$REPO/pulls/$n")
    bs=$(jq -r '.base.sha // "-"' <<<"$p")
    ms=$(jq -r '.merge_commit_sha // "-"' <<<"$p")
    if ! is_sha "$bs" || ! is_sha "$ms"; then
      ok_all=false
      echo "      #$n: base.sha or merge_commit_sha is not a sha ($bs, $ms)"
      continue
    fi
    p1=$(api "repos/$REPO/commits/$ms" | jq -r '.parents[0].sha // "-"')
    if ! is_sha "$p1"; then
      ok_all=false
      echo "      #$n: the merge commit has no first parent sha ($p1)"
      continue
    fi
    st=$(api "repos/$REPO/compare/$bs...$p1?per_page=1" | jq -r '.status // "-"')
    case "$st" in identical | ahead) ;; *) ok_all=false; echo "      #$n: base.sha $bs vs first parent $p1: compare status $st" ;; esac
  done
  pin "on the $n_recent most recently merged PRs (of the latest 100 closed), base.sha is the merge's first parent or an ancestor of it — never off the base line" \
    ". == true" "$ok_all"
else
  skip "base.sha stays on the base line across recently merged PRs" "no merged PR among the latest 100 closed"
fi

# Mergeability is on the single-PR read only — the list endpoint omits mergeable and
# mergeable_state — which is why pr_head_read reads pulls/<n> per PR. So does this.
open_list=$(api "repos/$REPO/pulls?state=open&per_page=10")
pin "pulls?state=open is a list" 'type == "array"' "$open_list"
is_list "$open_list" || open_list='[]'
if [ "$(jq length <<<"$open_list")" -ge 1 ]; then
  pin "every row of the open-PR list carries a numeric number" 'all(.[]; .number | type == "number")' "$open_list"
  # One projected row per PR, accumulated in a file: mergeable is nullable, so an absent key is
  # projected as "absent" rather than read as null, and fails the {true,false,null} claim.
  : >"$SCRATCH/open_prs"
  for n in $(jq -r '.[].number // "-"' <<<"$open_list"); do
    is_num "$n" || continue # recorded MOVED just above; no request is built from it
    api "repos/$REPO/pulls/$n" | jq -c '{number, head_sha: .head.sha, base_ref: .base.ref, updated_at,
      created_at, mergeable: (if has("mergeable") then .mergeable else "absent" end), mergeable_state}' >>"$SCRATCH/open_prs"
  done
  open_prs=$(jq -s . "$SCRATCH/open_prs")
  pin "an open PR's pulls/<n> read carries head.sha, base.ref, updated_at, and mergeable (present) in {true,false,null}" \
    "all(.[]; (.head_sha | test(\"$HEX40\")) and (.base_ref | type == \"string\" and length > 0) and (.updated_at | test(\"$ISO\")) and (.mergeable == true or .mergeable == false or .mergeable == null))" "$open_prs"
  # created_at is the floor the review clock starts at (status_state's `expected`), and unlike
  # updated_at it must not move: a clock that comments could push forward would never let the
  # grace expire. That it does not move is not checkable in one read; that it is there, is.
  pin "... and created_at, the review clock's floor, no later than updated_at" \
    "all(.[]; (.created_at | test(\"$ISO\")) and (.created_at <= .updated_at))" "$open_prs"
  pin "... and a mergeable_state in the vocabulary status_state renders (dirty is CONFLICTS, unknown is not yet computed)" \
    "all(.[]; .mergeable_state as \$m | $MERGEABLE_STATE_VOCAB | index(\$m))" "$open_prs"
  echo "      open PRs: $(jq -r '[.[] | "#\(.number) \(.mergeable_state)"] | join(", ")' <<<"$open_prs")"
  if jq -e 'any(.[]; .mergeable_state == "dirty")' <<<"$open_prs" >/dev/null; then
    echo "      a dirty PR is open: that no pull_request run is created for a push made while dirty can be checked on it by hand"
  fi
else
  skip "open PRs' mergeability and clock fields" "no open PR right now"
fi
skip "a push made while mergeable_state=dirty gets no pull_request run" "needs a dirty PR pushed to under observation; not manufactured here"
# The push clock: the gate (gate.py) reads updated_at because a push to the head branch moves it, and
# status_state's review clock reads created_at instead, as a floor that comments cannot move. The
# push time itself is not an API field, and a committer date is not one either (a skewed or
# assigned date can be later than the real push), so the belief was measured live on
# ludics-lite#38 (09:12:31Z before a push, 09:17:29Z five seconds after) and is not re-checkable
# without pushing; the field's shape on the single-PR read is pinned above.
skip "a push moves the PR's updated_at (the push clock)" "push time is not an API field; measured live on ludics-lite#38, not re-checkable without a push"

# --- the reviewer's feeds ----------------------------------------------------------------------------
section "reactions, reviews and comments on a reviewed PR — status_state's and review_rounds's feeds"
if [ -n "$REVIEWED_PR" ]; then
  reactions=$(api --paginate "repos/$REPO/issues/$REVIEWED_PR/reactions?per_page=100" | jq -s 'add')
  pin "the reactions feed is a list" 'type == "array"' "$reactions"
  is_list "$reactions" || reactions='[]'
  pin "reactions carry content, user.login and created_at" \
    "all(.[]; (.content | type == \"string\") and (.user.login | type == \"string\") and (.created_at | test(\"$ISO\")))" "$reactions"
  pin "the app's login carries the [bot] suffix: '$BOT' reacted, and nothing is logged in as bare '$REVIEWER'" \
    'any(.[]; .user.login == $bot) and all(.[]; .user.login != $rev)' "$reactions" --arg bot "$BOT" --arg rev "$REVIEWER"
  pin "the approval is a '+1' reaction from the app (the merge gate's 👍)" \
    "any(.[]; .content == \"+1\" and $APP)" "$reactions" --arg rev "$REVIEWER"
  comments=$(api --paginate "repos/$REPO/issues/$REVIEWED_PR/comments?per_page=100" | jq -s 'add')
  pin "the issue-comments feed is a list" 'type == "array"' "$comments"
  is_list "$comments" || comments='[]'
  pin "issue comments carry numeric id, created_at, updated_at, body and user.login" \
    "all(.[]; (.id | type == \"number\") and (.created_at | test(\"$ISO\")) and (.updated_at | test(\"$ISO\")) and (.body | type == \"string\") and (.user.login | type == \"string\"))" "$comments"
  pin "the app's summary comment carries the codex-pull-request-review-summary machine tag" \
    "any(.[]; $APP and (.body | test(\"codex-pull-request-review-summary\")))" "$comments" --arg rev "$REVIEWER"
  inline_all=$(api --paginate "repos/$REPO/pulls/$REVIEWED_PR/comments?per_page=100" | jq -s 'add')
  inline_page=$(api "repos/$REPO/pulls/$REVIEWED_PR/comments")
  # Two claims, each fed on stdin: the paginated feed of a long-reviewed PR is over Linux's
  # per-argument limit (the rounds suite's known trap), so it never travels as an argument.
  pin "the paginated inline-comments feed is a list" 'type == "array"' "$inline_all"
  pin "the unpaginated inline-comments read is a list" 'type == "array"' "$inline_page"
  is_list "$inline_all" || inline_all='[]'
  is_list "$inline_page" || inline_page='[]'
  # The row shape poll renders, asserted on BOTH feeds: while the flat listing lags a fresh
  # round, the per-review feed is the only source of these fields.
  # `original_commit_id` is in this row because TWO behaviours rest on it and neither would say so
  # if it vanished: poll stamps an inline finding with it (the head binding of ludics-lite#72 —
  # `commit_id` MIGRATES forward and would stamp an old finding with the current head), and it is
  # part of the key that folds duplicate threads (ludics-lite#76). Both fall back to `commit_id`,
  # silently and wrongly, so its absence has to be a reported MOVED rather than a fallback nobody
  # notices.
  INLINE_ROW="all(.[]; (.id | type == \"number\") and (.pull_request_review_id | type == \"number\") and (.commit_id | test(\"$HEX40\")) and (.original_commit_id | test(\"$HEX40\")) and (.user.login | type == \"string\") and (.path | type == \"string\" and length > 0) and (.body | type == \"string\") and has(\"line\") and has(\"original_line\"))"
  pin "inline comments carry numeric id, pull_request_review_id, commit_id, the original_commit_id poll stamps and folds by, user.login, a non-empty path, body, and the line/original_line pair poll renders" \
    "$INLINE_ROW" "$inline_all"
  # The reviews feed is read AFTER the inline feed, the way the check-run correlation orders its
  # reads and for the same reason: the reply belief below correlates a reply found in the INLINE
  # feed with the COMMENTED review that carries it, and a review exists before its comments do.
  # Read the other way round, a reply posted BETWEEN the two reads is in the inline snapshot with
  # no review in the earlier reviews snapshot, and the belief reports MOVED over a race
  # (ludics-lite#70, from #66's round 13). The default anchor #39 is closed and can never show
  # that; a CONTRACT_REVIEWED_PR still being replied to would.
  reviews=$(api --paginate "repos/$REPO/pulls/$REVIEWED_PR/reviews?per_page=100" | jq -s 'add')
  pin "the reviews feed is a list" 'type == "array"' "$reviews"
  is_list "$reviews" || reviews='[]'
  pin "reviews carry numeric id, state, commit_id, submitted_at (present, null while pending), user.login and a body (poll renders it)" \
    "all(.[]; (.id | type == \"number\") and (.state | type == \"string\") and (.commit_id | test(\"$HEX40\")) and has(\"submitted_at\") and (.submitted_at == null or (.submitted_at | test(\"$ISO\"))) and (.user.login | type == \"string\") and has(\"body\"))" "$reviews"
  pin "the app's review states are in the vocabulary (the projections filter to the app before classifying; other participants' states are not read)" \
    "all(.[] | select($APP); .state as \$s | $REVIEW_STATE_VOCAB | index(\$s))" "$reviews" --arg rev "$REVIEWER"
  pin "a round with findings is COMMENTED reviews from the app, and the approval is NOT an APPROVED review (it is the reaction above)" \
    "any(.[]; $APP and .state == \"COMMENTED\") and all(.[] | select($APP); .state != \"APPROVED\")" "$reviews" --arg rev "$REVIEWER"
  # The belief behind id-based watermarks: a reply to an inline comment creates a COMMENTED
  # review by the replier, in the same feed as the app's rounds. Detected from a reply (a comment
  # the projections would NOT read as the app's — the same prefix predicate, negated — carrying
  # an in_reply_to_id) rather than required of the anchor, which need not carry one; skips when
  # it does not.
  reply_review=$(jq -r --arg rev "$REVIEWER" "[.[]? | select(($APP | not) and (.in_reply_to_id | type == \"number\"))][0] | if . == null then empty else \"\(.pull_request_review_id // \"-\")\t\(.user.login)\" end" <<<"$inline_all")
  if [ -n "$reply_review" ]; then
    IFS=$'\t' read -r rr_id rr_user <<<"$reply_review"
    if is_num "$rr_id"; then
      pin "a reply to an inline comment is a COMMENTED review by the replier in the same feed as the app's rounds (so 'new' must be id > watermark, not a count; review $rr_id by $rr_user)" \
        'any(.[]; .id == $r and .state == "COMMENTED" and .user.login == $u)' "$reviews" --argjson r "$rr_id" --arg u "$rr_user"
    else
      skip "a reply to an inline comment is a COMMENTED review by the replier" "the reply's pull_request_review_id is not a number — see the MOVED above"
    fi
  else
    skip "a reply to an inline comment is a COMMENTED review by the replier" "#$REVIEWED_PR carries no non-app reply to an inline comment; an anchor with one shows it"
  fi
  n_inline=$(jq length <<<"$inline_all")
  if [ "$n_inline" -gt 30 ]; then
    pin "the flat listing paginates at 30 by default: an unpaginated read of #$REVIEWED_PR's $n_inline inline comments returns 30" \
      'length == 30' "$inline_page"
  else
    skip "the flat listing paginates at 30 by default" "#$REVIEWED_PR has $n_inline inline comments, not more than a page; a larger anchor shows it"
  fi
  # The review whose comments are read is one the flat listing NAMES (a pull_request_review_id
  # it carries), the way the merge-by-id read is made — not the app's first COMMENTED review,
  # which may be a summary with no inline comment — so the claim is exact: the per-review feed
  # is the flat listing's rows for that review, as a set of ids.
  named_review=$(jq -r '[.[]?.pull_request_review_id | select(type == "number")][0] // empty' <<<"$inline_all")
  if is_num "$named_review"; then
    per_review=$(api --paginate "repos/$REPO/pulls/$REVIEWED_PR/reviews/$named_review/comments?per_page=100" | jq -s 'add')
    jq -c --argjson r "$named_review" '[.[]? | select(.pull_request_review_id == $r) | .id] | sort' <<<"$inline_all" >"$SCRATCH/named_ids.json"
    pin "a review's own comments endpoint answers with exactly the flat listing's rows for that review, by id (the merge-by-id read; review $named_review)" \
      'type == "array" and ([.[].id] | sort) == $ids[0]' "$per_review" --slurpfile ids "$SCRATCH/named_ids.json"
    is_list "$per_review" || per_review='[]'
    # The per-review feed is NOT the flat listing's shape: live, it carries position and
    # original_position but no line/original_line (nor side, start_line, subject_type) — which
    # is why the merge-by-id read lets the flat feed's copy win, and why poll renders a row it has
    # from this feed alone as `:@<position>` — the field it does carry — rather than as a line
    # number it was never served. So the claim is the fields poll reads from this feed; the
    # line-number gap is printed, not asserted, since the rendering falls back either way.
    #
    # `original_commit_id` is asserted on THIS feed as well as on the flat one, and the row above
    # is not evidence for it: these are the rows poll has while the flat listing lags, so if the
    # field were dropped here alone, the flat-feed belief would stay green while every supplemented
    # finding fell back to the MIGRATING `commit_id` — stamping a previous round's finding with the
    # current head, which is the one thing the head-bound watch must never do (#86 round 3).
    # position/original_position are asserted for the same reason: with no line to fall back to,
    # they are the whole anchor these rows fold on.
    pin "the per-review rows carry what poll renders and folds from this feed alone while the flat listing lags: numeric id and pull_request_review_id, commit_id, the original_commit_id the head stamp needs, the position pair the fold keys on, user.login, a non-empty path, body" \
      "all(.[]; (.id | type == \"number\") and (.pull_request_review_id | type == \"number\") and (.commit_id | test(\"$HEX40\")) and (.original_commit_id | test(\"$HEX40\")) and has(\"position\") and has(\"original_position\") and (.user.login | type == \"string\") and (.path | type == \"string\" and length > 0) and (.body | type == \"string\"))" "$per_review"
    echo "      per-review rows carrying line/original_line: $(jq '[.[] | select(has("line") and has("original_line"))] | length' <<<"$per_review") of $(jq length <<<"$per_review") (the flat listing's copy wins on a merge because it carries them)"
  else
    skip "a review's own comments endpoint" "the flat listing names no review — $UNUSABLE"
  fi
else
  skip "the reviewer feeds' shapes" "set CONTRACT_REVIEWED_PR to a PR the review app reviewed and approved"
fi

# --- the summary row on recent merged PRs ---------------------------------------------------------
# status_state reads the summary comment's newest Code Review row as a verdict: Completed on the
# head, with nothing posted since the 👀, is a clean round (#439); Failed on the head, with no
# review and no 👍, is a run to re-request (#453). Two beliefs carry those readings and no anchor
# PR can: they are about what the app writes NOW, so they are asked of the newest merged PRs.
#   - The vocabulary: every Code Review row is one of the three shapes status_state reads —
#     SUMMARY_COMPLETED_ROW_RE, SUMMARY_FAILED_ROW_RE, or a Running row (the test the 👍 path's
#     Running read makes) — each dated by a well-formed UTC datetime not in the future, since
#     status_state orders these stamps as strings. A row outside them keeps the pre-#439
#     reading, which is safe but silent: a new failure word would read as a stall rather than as
#     a failed run.
#   - The ORDER the Completed reading rests on (#453): the app submits a round's findings review
#     BEFORE it flips the row to Completed (9 of 9 findings rounds sampled on 2026-09-28, 2-4 s
#     apart), which is why "nothing since the 👀" is the test and "nothing after the row" would
#     call every findings round clean. Asked of every sampled PR whose last app review names the
#     commit its newest Completed row names: that review's submitted_at is not after the row's
#     datetime (fractional seconds dropped, as status_state drops them). If the app ever reverses
#     the order, this goes red before a findings round is read as approved.
# The sample is the newest merged PRs (CONTRACT_SUMMARY_SAMPLE, default 60) of the closed-PR list
# the pulls section read (the 100 most recently updated), since the summary comment is edited in
# place and a merged PR's is the last state it reached — so only a PR merged on a findings round
# (its last review naming the head its Completed row names) carries the order at all: 8 of the 60
# on this repository when the belief was written (2026-09-29), every one holding by 2-4 s. A
# sample with no such PR says so as a skip.
section "the Codex summary row on recent merged PRs — status_state's Completed and Failed readings"
SUMMARY_SAMPLE="${CONTRACT_SUMMARY_SAMPLE:-60}"
is_num "$SUMMARY_SAMPLE" || { echo "pr-review-api-contract.sh: CONTRACT_SUMMARY_SAMPLE must be a number, got '$SUMMARY_SAMPLE'" >&2; exit 2; }
# The row patterns are the gate's own (prreview/state.py, written in jq's dialect for this read).
SUMMARY_COMPLETED_ROW_RE=$(gate_py 'from ludics.prreview.state import SUMMARY_COMPLETED_ROW_RE as r; print(r)')
SUMMARY_FAILED_ROW_RE=$(gate_py 'from ludics.prreview.state import SUMMARY_FAILED_ROW_RE as r; print(r)')
SUMMARY_ROW_STAMP_RE=$(gate_py 'from ludics.prreview.state import SUMMARY_ROW_STAMP_RE as r; print(r)')
: >"$SCRATCH/summary_rows.jsonl"
for n in $(jq -r --argjson k "$SUMMARY_SAMPLE" '[.[] | select(.merged_at != null) | .number | select(type == "number")] | .[:$k] | .[]' <<<"$closed"); do
  # Through files, not the argument vector: a long-reviewed PR's feed is over Linux's
  # per-argument limit (the rounds suite's known trap).
  api --paginate "repos/$REPO/issues/$n/comments?per_page=100" | jq -s 'add // []' >"$SCRATCH/s_comments.json"
  api --paginate "repos/$REPO/pulls/$n/reviews?per_page=100" | jq -s 'add // []' >"$SCRATCH/s_reviews.json"
  # One line per PR: every Code Review row of its summaries classified, and the newest row of the
  # newest summary — none when a row there is one the stamp cannot date, as status_state reads
  # it — beside the app's last submitted review. The Running test is the 👍 path's.
  jq -cn --argjson pr "$n" --arg rev "$REVIEWER" --arg done "$SUMMARY_COMPLETED_ROW_RE" \
    --arg failed "$SUMMARY_FAILED_ROW_RE" --arg stamp "$SUMMARY_ROW_STAMP_RE" \
    --slurpfile comments "$SCRATCH/s_comments.json" --slurpfile reviews "$SCRATCH/s_reviews.json" "
    def app: $APP; $SUMMARY_ROW_INSTANT_DEF"'
    def kind: if test($done) then "completed" elif test($failed) then "failed"
              elif test("^\\|[^|]*Code Review[^|]*\\|[^|]*Running") then "running" else "other" end;
    def rows: (.body // "") | split("\n")[] | select(test("^\\|[^|]*Code Review[^|]*\\|"));
    def dated: [capture($stamp)] | first
      | if . == null then false
        else (.at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))
          and ((try (.at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch null) as $t
               | $t != null and $t <= now)
        end;
    [$comments[0][] | select(app) | select((.body // "") | contains("codex-pull-request-review-summary"))] as $sums
    | ($sums | max_by(.updated_at // .created_at)
       | if . == null then null
         else [rows | . as $row | [capture($stamp)] | first
               | if . == null then null
                 else {at: (.at | sub("\\.[0-9]+Z$"; "Z")), key: (.at | instant), sha, kind: ($row | kind)} end]
           | if length == 0 or any(.[]; . == null) then null else max_by(.key) end
         end) as $newest
    | ([$reviews[0][] | select(app) | select(.submitted_at != null)] | max_by(.submitted_at)) as $last
    | {pr: $pr, rows: [$sums[] | rows | {kind: kind, dated: dated, row: .}], newest: $newest,
       review: (if $last == null then null else {at: $last.submitted_at, sha: ($last.commit_id // "")} end)}' \
    >>"$SCRATCH/summary_rows.jsonl"
done
summary_rows=$(jq -s . "$SCRATCH/summary_rows.jsonl")
n_rows=$(jq '[.[].rows[]] | length' <<<"$summary_rows")
if [ "$n_rows" -eq 0 ]; then
  skip "every Code Review row is a shape status_state reads" "the $(jq length <<<"$summary_rows") sampled merged PRs carry no Code Review row"
else
  # Failing rows first, so the MOVED line's 400 characters show them.
  pin "every Code Review row of the sampled PRs' summaries is Completed or Failed in the allowlisted shape, or Running, dated by an ISO 8601 UTC datetime not in the future ($n_rows rows on $(jq length <<<"$summary_rows") PRs; $(jq '[.[].rows[] | select(.kind == "failed")] | length' <<<"$summary_rows") Failed)" \
    'all(.[]; .kind != "other" and .dated)' "$(jq -c '[.[] | .pr as $pr | .rows[] | {pr: $pr} + .] | sort_by(.kind != "other" and .dated)' <<<"$summary_rows")"
fi
ordered=$(jq -c '[.[] | select(.newest != null and .newest.kind == "completed" and .review != null)
                 | select(.newest.sha as $s | $s != "" and (.review.sha | startswith($s)))
                 | {pr, review_at: .review.at, row_at: .newest.at, sha: .newest.sha}]
                | sort_by(.review_at <= .row_at)' <<<"$summary_rows")
if [ "$(jq length <<<"$ordered")" -eq 0 ]; then
  skip "a findings review is submitted before its row flips to Completed" "no sampled merged PR's last app review names the commit of its newest Completed row (every one ended on a clean round); a larger CONTRACT_SUMMARY_SAMPLE finds one"
else
  pin "a findings review is submitted before its row flips to Completed: the app's last review naming the newest Completed row's commit is not after that row, on $(jq length <<<"$ordered") sampled PRs (status_state's 'nothing since the 👀' rests on it, #453)" \
    'all(.[]; .review_at <= .row_at)' "$ordered"
fi

# --- reviewThreads (GraphQL) ------------------------------------------------------------------------
# The one GraphQL read: the open-thread gate (unresolved_threads) and `resolve` (find_thread) both
# page reviewThreads through threads_walk with the gate's own THREADS_QUERY, sent here verbatim,
# so a field the query asks for that GraphQL stopped serving is this script's exit 4 rather than a
# restatement that kept passing. What the fixtures invent and nothing pinned (ludics-lite#389):
#   - totalCount on EVERY page — threads_walk takes the read as whole only when the rows reach the
#     count the LAST page states, so a count served on the first page alone would refuse every
#     multi-page PR, and one that stopped agreeing across pages would judge a prefix;
#   - the node `id`, which `resolve` hands to resolveReviewThread as threadId (the fixtures make it
#     up as "T<comment id>");
#   - `isResolved` a boolean — the gate counts a thread closed only when it is literally true, so
#     a string "true" would hold every approval as unresolved, and a dropped field the same;
#   - the first comment's `fullDatabaseId` a decimal string, which threads.thread_id names a thread by
#     ahead of `databaseId` — the schema types databaseId as a 32-bit Int while review-comment ids
#     run past 2^31, and the reply fixture assumes it null there. What GitHub serves past 2^31 is
#     printed, and the claim is the one the fallback needs: null or the same number, never clamped;
#   - the first comment's `originalCommit.oid` a 40-hex SHA and its `commit` null or one
#     (ludics-lite#587): threads.threads_by_head puts a thread on the head only when its original
#     commit IS the head, so an origin that stopped reading as a SHA would quietly move every
#     current-head finding to "earlier heads", and the fixtures make both up.
# Reads: one verbatim page of 100, then the same query on a page small enough to make the anchor
# span several pages, since one page shows nothing about "every page".
section "reviewThreads on #${THREADS_PR:-?} (GraphQL) — the open-thread gate's and resolve's read"
if [ -z "$THREADS_PR" ]; then
  skip "the reviewThreads connection's shape" "set CONTRACT_THREADS_PR to a PR with review threads whose first comments' ids run past 2^31"
else
  is_num "$THREADS_PR" || { echo "pr-review-api-contract.sh: CONTRACT_THREADS_PR must be a PR number, got '$THREADS_PR'" >&2; exit 2; }
  threads_conn() { # stdin: a GraphQL answer -> its reviewThreads connection, or null
    jq -c 'try .data.repository.pullRequest.reviewThreads catch null'
  }
  THREADS_QUERY=$(gate_py 'from ludics.prreview.threads import THREADS_QUERY; print(THREADS_QUERY)')
  tconn=$(api graphql -f query="$THREADS_QUERY" -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F pr="$THREADS_PR" | threads_conn)
  pin "the gate's own THREADS_QUERY, sent verbatim, answers #$THREADS_PR's reviewThreads as a connection: nodes[], a numeric totalCount and a boolean pageInfo.hasNextPage" \
    '(.nodes | type == "array") and (.totalCount | type == "number") and (.pageInfo.hasNextPage | type == "boolean")' "$tconn"
  tnodes=$(jq -c '.nodes? // null' <<<"$tconn")
  ttotal=$(jq -r '.totalCount? // empty' <<<"$tconn")
  if ! is_list "$tnodes" || ! is_num "$ttotal"; then
    skip "the row-level and paging claims on #$THREADS_PR's review threads" "$UNUSABLE"
  elif [ "$(jq length <<<"$tnodes")" -eq 0 ]; then
    skip "the row-level and paging claims on #$THREADS_PR's review threads" "#$THREADS_PR has no review thread; an anchor with three or more shows them"
  else
    pin "every thread carries a non-empty node id (resolve's threadId) and isResolved as a boolean (closed only when literally true)" \
      'all(.[]; (.id | type == "string" and length > 0) and (.isResolved | type == "boolean"))' "$tnodes"
    pin "every thread's first comment carries fullDatabaseId as a decimal string (the BigInt threads.thread_id names a thread by, ahead of databaseId)" \
      'all(.[]; .comments.nodes[0].fullDatabaseId | type == "string" and test("^[1-9][0-9]*$"))' "$tnodes"
    pin "every thread's first comment carries originalCommit.oid as a 40-hex SHA, and commit as null or a 40-hex oid (threads.threads_by_head splits the open threads by head on them)" \
      'all(.[]; .comments.nodes[0] | (.originalCommit.oid | type == "string" and test("^[0-9a-f]{40}$"))
                and (.commit == null or (.commit.oid | type == "string" and test("^[0-9a-f]{40}$"))))' "$tnodes"
    # Past 2^31 is selected on the decimal string, so the claim is about exactly the threads whose
    # 32-bit databaseId the schema cannot hold; jq's numbers are doubles, exact far past these ids.
    BIG='.comments.nodes[0] | select((.fullDatabaseId | type == "string" and test("^[1-9][0-9]*$")) and (.fullDatabaseId | tonumber) > 2147483647)'
    n_big=$(jq "[.[] | $BIG] | length" <<<"$tnodes")
    if [ "$n_big" -ge 1 ]; then
      pin "databaseId is not clamped past 2^31: on #$THREADS_PR's $n_big thread(s) whose first comment id is past it, databaseId is null or the very number fullDatabaseId spells (threads.thread_id's fallback)" \
        "all(.[] | $BIG; .databaseId == null or ((.databaseId | type == \"number\") and (.databaseId | tostring) == .fullDatabaseId))" "$tnodes"
      echo "      databaseId past 2^31 on #$THREADS_PR: $(jq -r "[.[] | $BIG | if .databaseId == null then \"null\" elif (.databaseId | tostring) == .fullDatabaseId then \"whole\" else \"other\" end] | group_by(.) | map(\"\(.[0]) on \(length)\") | join(\", \")" <<<"$tnodes")"
    else
      skip "databaseId is not clamped past 2^31" "#$THREADS_PR's thread ids are all below 2^31; an anchor past it pins this"
    fi
    if [ "$ttotal" -lt 3 ]; then
      skip "totalCount on every page of reviewThreads" "#$THREADS_PR has $ttotal thread(s): too few to span two pages of two; an anchor with three or more shows it"
    else
      # The verbatim query at a smaller page — the one edit, made on the gate's text so every
      # field stays the gate's. A query that no longer reads `reviewThreads(first:100,` is a change
      # this read must follow, and it stops rather than walking some other query.
      tsize=$(((ttotal + 2) / 3))
      [ "$tsize" -ge 2 ] || tsize=2
      [ "$tsize" -le 100 ] || tsize=100
      tfrom='reviewThreads(first:100,'
      tto="reviewThreads(first:$tsize,"
      tquery=${THREADS_QUERY/"$tfrom"/$tto}
      [ "$tquery" != "$THREADS_QUERY" ] || { echo "pr-review-api-contract.sh: THREADS_QUERY no longer asks for reviewThreads(first:100, ...); the paged read derives from it and must be updated with it" >&2; exit 2; }
      : >"$SCRATCH/thread_pages"
      tcursor=""
      for ((tpage = 1; tpage <= 10; tpage++)); do
        tafter=()
        [ -z "$tcursor" ] || tafter=(-f "after=$tcursor")
        api graphql -f query="$tquery" -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F pr="$THREADS_PR" ${tafter[@]+"${tafter[@]}"} | threads_conn |
          jq -c 'if type == "object" then {has_total: has("totalCount"), total: .totalCount,
                   n: (.nodes | if type == "array" then length else null end),
                   next: .pageInfo.hasNextPage, cursor: .pageInfo.endCursor} else {has_total: false} end' >>"$SCRATCH/thread_pages"
        # The cursor rides the next request only when it is a usable one; otherwise the walk ends
        # here and the claims below report the page that broke it.
        [ "$(tail -n 1 "$SCRATCH/thread_pages" | jq -r '.next')" = true ] || break
        tcursor=$(tail -n 1 "$SCRATCH/thread_pages" | jq -r '.cursor | if type == "string" then . else empty end')
        [ -n "$tcursor" ] || break
      done
      tpages=$(jq -cs . "$SCRATCH/thread_pages")
      pin "on a walk of #$THREADS_PR at $tsize a page ($(jq length <<<"$tpages") pages), EVERY page states a numeric totalCount, nodes[] and a boolean hasNextPage, with a non-empty endCursor whenever there is a next page (threads_walk reads the last page's count)" \
        'length >= 2 and all(.[]; .has_total and (.total | type == "number") and (.n | type == "number") and (.next | type == "boolean")
                              and (.next == false or (.cursor | type == "string" and length > 0)))' "$tpages"
      pin "... and the pages add up: each states the verbatim read's totalCount ($ttotal), their rows reach it, and the last says hasNextPage false (threads_walk's whole-read test)" \
        'all(.[]; .total == $t) and ((map(.n // 0) | add) == $t) and (.[-1].next == false)' "$tpages" --argjson t "$ttotal"
    fi
  fi
fi
skip "reviewThreads paged past 100 threads" "no PR here has more than one page of 100 threads; the paging itself is pinned above on a smaller page of the same query"

# --- commits/<sha> files ------------------------------------------------------------------------------
# What commit_files reads for the paths-ignore recognition (ludics-lite#163, #177): one commit's
# files, its first-parent diff, through `--paginate` at per_page=100, refusing a list of 300 or
# more as possibly truncated. The fixtures can record only that --paginate was passed; what makes
# it necessary, and what makes the joined pages the whole diff, is the endpoint's paging, asked
# here of a commit wider than one default page. Live (2026-10-01), against the belief #163's
# review wrote into the comments (30 a page, 300 in all): the default page is 300 files, with a
# rel=next Link past it; per_page is honoured; and the paginated read is NOT capped at 300 — it
# joins to the whole diff (GitHub documents 3000 as the most it serves). So commit_files' refusal
# at 300 is conservative rather than a cap it must respect, and it is the backstop that refuses an
# unpaginated read, whose wide answer is exactly one default page of 300.
section "commits/<sha> files on ${WIDE_COMMIT:-?} — commit_files's feed (the paths-ignore walk)"
if [ -z "$WIDE_COMMIT" ] || [ -z "$WIDE_COMMIT_FILES" ]; then
  skip "the commit-files paging commit_files rests on" "set CONTRACT_WIDE_COMMIT (<owner/name>@<sha>, wider than 300 files) and CONTRACT_WIDE_COMMIT_FILES (its file count)"
else
  wrepo=${WIDE_COMMIT%@*}
  wsha=${WIDE_COMMIT##*@}
  case "$wrepo" in
  */*/* | /* | */ | *[!A-Za-z0-9._/-]*) wrepo="" ;;
  */*) ;;
  *) wrepo="" ;;
  esac
  if [ -z "$wrepo" ] || ! is_sha "$wsha" || ! is_num "$WIDE_COMMIT_FILES"; then
    echo "pr-review-api-contract.sh: CONTRACT_WIDE_COMMIT must be <owner/name>@<40-hex sha> and CONTRACT_WIDE_COMMIT_FILES a count, got '$WIDE_COMMIT' and '$WIDE_COMMIT_FILES'" >&2
    exit 2
  fi
  if [ "$WIDE_COMMIT_FILES" -le 300 ]; then
    skip "the commit-files paging commit_files rests on" "the anchor has $WIDE_COMMIT_FILES files: no wider than the default page, it shows no paging"
  else
    # Projected to the fields commit_files reads as each page arrives: the rows carry patches, and
    # a wide commit's pages run to megabytes.
    PAGE_ROWS='if type == "object" then {files: (.files | if type == "array" then map(if type == "object" then {filename, status, previous_filename} else . end) else . end)} else . end'
    wone=$(api "repos/$wrepo/commits/$wsha" | jq -c "$PAGE_ROWS")
    pin "an unpaginated commits/<sha> read answers ONE default page: 300 of $wsha's $WIDE_COMMIT_FILES files (a single read is a truncated diff, which is why commit_files pages, and a list of exactly 300 is what its refusal at 300 catches)" \
      '.files | type == "array" and length == 300' "$wone"
    wpages=$(api --paginate "repos/$wrepo/commits/$wsha?per_page=100" | jq -cs "map($PAGE_ROWS)")
    pin "commits/<sha>?per_page=100 under --paginate is one commit object per page with files[], each page 100 rows but the last, which has 1 to 100 (the page size commit_files asks for is honoured)" \
      'length >= 2 and all(.[]; .files | type == "array") and all(.[:-1][]; .files | length == 100)
       and (.[-1].files | length >= 1 and length <= 100)' "$wpages"
    pin "... and the joined pages are the WHOLE first-parent diff, past 300: $WIDE_COMMIT_FILES rows with distinct, non-empty string filenames (the read commit_files takes as the commit's changed paths is not capped at the default page)" \
      '[.[].files[]?] | length == $n and all(.[]; .filename | type == "string" and length > 0) and ([.[].filename] | unique | length) == $n' \
      "$wpages" --argjson n "$WIDE_COMMIT_FILES"
    if jq -e 'any(.[].files[]?; .status == "renamed")' <<<"$wpages" >/dev/null; then
      pin "a renamed row carries a non-empty previous_filename (commit_files lists both names as changed paths)" \
        'all(.[].files[]? | select(.status == "renamed"); .previous_filename | type == "string" and length > 0)' "$wpages"
    else
      skip "a renamed commit-files row carries previous_filename" "no rename in the anchor commit"
    fi
  fi
fi
skip "compare's 300-file cap" "no compare of that size exists in this repository"

# --- the verdict --------------------------------------------------------------------------------------
section "verdict"
echo "$CLAIMS beliefs checked ($((CLAIMS - WRAPPER_CLAIMS)) + $WRAPPER_CLAIMS per-workflow wrapper claim(s), one per workflow the base-runs search asked), $MOVED moved, $SKIPPED unpinned here"
[ "$MOVED" -eq 0 ] || { echo "pr-review-api-contract.sh: $MOVED belief(s) the fixtures encode no longer hold on $REPO — see MOVED above" >&2; exit 1; }
