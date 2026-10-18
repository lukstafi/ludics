#!/usr/bin/env bash
# The preamble the pr-review.sh fixture suites (test-pr-review-*.sh) share. A suite sources it
# right after `set -euo pipefail`, before defining anything of its own:
#
#   SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
#   # shellcheck source=test-pr-review-lib.sh
#   source "$SCRIPT_DIR/test-pr-review-lib.sh"
#
# Sourced, it exports the test environment and sources pr-review.sh in SHIP_PR_TEST_SOURCE_ONLY
# mode, and then provides what every suite used to copy (ludics-lite#46):
#
#   bail <msg>                          the reporter: FAIL: <msg> on stderr, exit 1
#   assert_eq <got> <want> <msg>        the assertion trio
#   assert_contains <hay> <needle> <msg>
#   assert_not_contains <hay> <needle> <msg>
#   state_tok / state_age /             the fields of a state line (`status-state`'s answer):
#     state_merge / state_detail <line> token, age, mergeability, and the rest, pipes kept
#   test_tmpdir <var> <label>           a throwaway directory in <var> (any name but the two the
#                                       function itself uses, which it refuses), removed at exit —
#                                       this file owns the EXIT trap (pr-review.sh, sourced,
#                                       installs none, and the guard below keeps it so), so a
#                                       suite never touches `trap`. <label> is
#                                       interpolated into the created directory's NAME, so a case
#                                       that must prove something about a spaced path just asks
#                                       for one — test_the_guard_survives_a_path_with_spaces
#                                       hand-rolled its own mktemp and TEST_CLEANUP entry believing
#                                       it could not ask (ludics-lite#106, undone in #122)
#   review_thread <id> <resolved> …     one row of the reviewThreads connection, and the paged
#   review_threads_answer <nodes> "$@"  GraphQL answer over such rows, for a fixture `gh`'s
#                                       reviewThreads arm (ludics-lite#289)
#   inline_comment <id> <orig> <cur> …  one inline finding as the flat listing serves it, and as
#   positional_comment <id> <orig> …    the per-review endpoint does: the shapes
#                                       pr-review-api-contract.sh pins, held to its pins by
#                                       test-pr-review-api-contract.sh (ludics-lite#91)
#   gh_fixture_parse "$@"               inside a fixture `gh`: refuses anything but `gh api`, any
#   gh_fixture_answer <response>        option outside gh api's own table (below), and any
#                                       endpoint that is neither `graphql` nor a REST path with a
#                                       `/` (ludics-lite#86, #102); sets FIXTURE_ENDPOINT /
#                                       FIXTURE_FILTER / FIXTURE_PAGINATE,
#                                       logs the endpoint to $REQUEST_LOG (and, when paginated,
#                                       $PAGINATE_LOG) if the suite set them; the answer goes
#                                       through the --jq filter the call carried, if any
#   fixture_call_count <name>           inside a fixture `gh`: one more call under <name>, and
#   fixture_call_total <name>           the new total on stdout, so `[ "$(fixture_call_count
#   fixture_call_reset [<name>...]      body)" -ge 2 ]` is "from the second read on". The count
#                                       lives in a FILE under $TEST_ROOT, never in a variable:
#                                       every call of the fixture runs in a shell of its own (a
#                                       fresh bash through the forward's bridge, as the shell's
#                                       `$(gh ...)` once did), and a variable the fixture
#                                       increments dies with it — the merge suite hand-rolled three such files
#                                       (ludics-lite#274) and the base fixture a fourth before
#                                       these took their place. total is the current count
#                                       WITHOUT counting — 0 for a counter never made — for a
#                                       case's assertion or a fixture's other branches. reset
#                                       zeroes the named counters, or all of them, between cases
#   retune <NAME>=<value>...            moves pr-review.sh's source-time constants (GRACE, STALL,
#                                       ROUND_GAP, ABSENT_GRACE, CHECKS_INTERVAL, …) for the
#   restore_tuning                      current case; run_tests restores them when it ends, and a
#                                       case that wants them back sooner calls restore_tuning
#   stub <fn>...                        declares the library functions this suite redefines on
#                                       purpose (no suite does today; the base suites' second
#                                       library is the one that has been stubbed)
#   jq_crlf_stub <dir> <mode>           a jq that ends its lines CRLF the way a native jq.exe
#   SHIP_PR_TEST_JQ_EOL=crlf|           does, in <dir>; with the variable set the whole suite
#     crlf-no-binary                    runs over one, which is how Ubuntu and macOS hold
#                                       pr-review.sh's `jq_lf` without Windows (ludics-lite#335)
#   protect_library <file>              extends the guard over a second library sourced after
#                                       this one (test-pr-review-base-lib.sh), whose functions
#                                       the snapshot below could not see
#   run_tests <case>... -- "$@"         the guard below, then each case with a PASS line.
#                                       A case that is not a defined function when run_tests is
#                                       reached is refused before any case runs. Case names on
#                                       the suite's command line, or SHIP_PR_TEST_CASES="<case>
#                                       <case>", run only those, and say so on a closing
#                                       `SUBSET: n of m cases` line; a call without the `--`
#                                       forward is refused
#
# The guard is why the file exists. Every function pr-review.sh and this file define is in scope in
# every suite the moment it is sourced, and a suite helper that happens to share a name silently
# replaces the library's: a reporter named `fail` turned every refusal of the script under test
# into the reporter's exit 1 (ludics-lite#39, then #45 in three more suites), and a collision on a
# helper whose output a case reads (`jq_lf`, or the clock helpers the shell half carried until it
# was retired) would produce wrong test RESULTS instead, with nothing shouting. Shellcheck is silent about it at every severity. So the function table is snapshotted
# here — name, line and defining file for everything pr-review.sh and this file define — and
# `run_tests` reads it again before the first case: a protected function that is no longer the
# one its file defined is REFUSED (exit 2, naming the function, its owner and where the suite
# redefined it) unless the suite declared it with `stub`; and a `stub` that names a function the
# suite never redefined is refused too, so the declarations stay honest. A suite's fixture `gh`
# is outside the guard's scope on purpose: it shadows a command, not a function of the library.
#
# Executed rather than sourced, this file runs its own controls: throwaway suites that source it.
# The tests array below is the register of those controls. The negative controls prove the guard
# can fail; CI runs this file beside the fixture suites.
# `retune` is covered in the same run, by a pair of cases: one moves two constants, the next reads
# them back as pr-review.sh set them, which is the restore no case performs itself.
#
# The mutation controls below automate two recorded regressions: splitting the snapshot path
# into fields, and losing the failed probe status. Each runs only its target case, so there is
# no recursive self-test; an unchanged copy must pass before the mutant fails its named assertion.
# mutation_copy refuses patches that match zero or multiple sites, with its own refusal controls.
#
# To SHOW another guard can fail — which is how a control earns its place here — copy this file and
# pr-review.sh into a scratch directory, revert the fix in the COPY, and run the copy:
#
#   cp ship-pr/scripts/{test-pr-review-lib.sh,pr-review.sh} "$d"/ && mv "$d"/test-pr-review-lib.sh "$d"/lib-reverted.sh
#   $EDITOR "$d"/lib-reverted.sh && bash "$d"/lib-reverted.sh   # the control you added must fail
#   SHIP_PR_TEST_CASES=<the control> bash "$d"/lib-reverted.sh   # or just that control
#
# The tracked file is never touched, so a session that dies mid-way leaves the repo clean; the
# alternative — mutating the tracked file in place and restoring it — does not have that property.
# The copy needs pr-review.sh beside it (TEST_LIB_DIR comes from BASH_SOURCE and HELPER from that)
# and nothing else: any directory will do, and the name of the copy does not matter, because this
# file names itself through LIB_BASENAME rather than spelling it. The last control is what keeps
# that true — it runs a renamed copy for real and holds it to this file's own PASS list, so a name
# spelled instead of derived fails here rather than under whoever next tries the route
# (ludics-lite#101). The PASS list alone would not do it: what a refusal SAYS is checked by the
# controls that provoke it, so `assert_refused` matches "$LIB_BASENAME: REFUSING" rather than the
# bare word, and the renamed inner run is where a re-spelled prefix then fails. `--inner-copy`,
# which that control passes, is the only argument this file takes — exactly, with no trailing
# word, since a marker that could be typed past would skip that control in silence.

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape. Sourced by a sibling suite, the `|| return 0` dispatch below ends the source
# inside the group, before the foot's `exit` is reached, so the caller survives.
{
TEST_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
TEST_LIB_FILE="$TEST_LIB_DIR/$(basename "${BASH_SOURCE[0]}")"
HELPER="$TEST_LIB_DIR/pr-review.sh"
# How this file names ITSELF, everywhere below: derived, never spelled. A copy is how a guard is
# shown to fail without touching the tracked file (see the executed section's copy control), and a
# copy is named something else — so every message and every assertion that spells the canonical
# name is a false failure waiting for whoever tries that route. One did: run as `lib-reverted.sh`,
# `test_lib_helpers_are_protected` asserted on a literal "test-pr-review-lib.sh's assert_eq" while
# the guard correctly reported `lib-reverted.sh's assert_eq`, and the case failed for a reason
# with nothing to do with the mutation under test. pr-review.sh keeps its literal name, in prose
# and in HELPER both: a copy has to sit beside a file of exactly that name to run at all.
LIB_BASENAME=$(basename "$TEST_LIB_FILE")

# Everything a suite defines must come AFTER this file: a function defined before pr-review.sh
# is sourced is replaced by the library's same-named one (the shadow in the other direction),
# and the snapshot below could not tell.
# `declare -f <name>` for an ordinary function, `declare -fx <name>` for one the ENVIRONMENT
# exported into this shell (`export -f`). Only the former is the suite's doing, so only the former
# is matched — printing just the matches, and not every line with a prefix stripped where it
# happened to occur. An inherited function is not something a suite can be asked to move below the
# source, and it is harmless besides: a library name among them is replaced when pr-review.sh is
# sourced a few lines down, and the snapshot then records the library's. Before this, any exported
# function in the environment refused every suite, naming "declare -fx <name>" as the definition.
lib_predefined=$(declare -F | sed -n 's/^declare -f \(.*\)/\1/p' | tr '\n' ' ')
if [ -n "$lib_predefined" ]; then
  echo "$LIB_BASENAME: REFUSING to run: the suite defined functions before sourcing this file (${lib_predefined% }); source it first, so the shadow guard sees every definition" >&2
  exit 2
fi
unset lib_predefined

export SHIP_PR_TEST_SOURCE_ONLY=1
export SHIP_PR_API_ATTEMPTS=1
export SHIP_PR_API_BACKOFF=0
# The set `retune` accepts: the names sourcing pr-review.sh ASSIGNS, asked of a probe that does
# exactly that in a pristine environment, where the names in scope before and after the source
# differ by precisely what the source set. Two cheaper answers were both wrong, in opposite ways.
#
# Differencing the names across THIS shell's source depends on who invoked the suite: a name the
# environment already carries — `env GRACE=777 ./test-pr-review-lib.sh`, or an exported
# `ABSENT_GRACE` — is in scope on both sides, so it read as the caller's, dropped out of the set,
# and every migrated `retune GRACE=1` was refused with "sets no GRACE".
#
# Reading the assignments out of pr-review.sh's TEXT is invoker-independent but cannot tell a
# source-time assignment from one inside a function body, and "is it set now" cannot separate them
# either for a name the shell itself always provides: `IFS=… read` appears in several of its
# functions and every shell has IFS set, so `retune IFS=x` was accepted and would have altered the
# harness's own word splitting — a typo guard that admits IFS is not a guard.
#
# The probe answers the question that was being approximated. `env -i` so nothing is inherited;
# PATH, HOME and TMPDIR because the source reads them; the same SHIP_PR_* the suites source under.
# Function bodies do not run, so their locals never appear. It is written inline rather than as a
# helper because a function defined before the source is the one shape this file refuses from a
# suite: pr-review.sh would replace a same-named one, and the snapshot could not tell.
#
# The shell creates variables of its own as it runs, and those are not the script's constants.
# `PIPESTATUS` is the one that reached the set: absent from the first snapshot, materialized by
# bash when the source ran a top-level pipeline, and so indistinguishable by name alone from
# something pr-review.sh assigned — `retune PIPESTATUS=x` was accepted, and did nothing. Both
# halves below are against that: the WARM-UP runs the constructs that materialize such variables
# before the first snapshot, so they are on the "before" side where they belong; the deny-list
# catches the ones no warm-up here triggers, and the two overlap on purpose, because a new bash
# maintaining one more name should be caught by the warm-up without anyone editing a list.
#
# The status is captured rather than propagated. `set -e` is on in every suite by the time this
# runs, so a probe that failed took the assignment's exit status with it and killed the suite
# where it stood — before the refusal below could say what happened, and with the source's own
# stderr discarded. The `|| lib_probe_rc=$?` is what lets the diagnostic run at all.
lib_probe_err="${TMPDIR:-/tmp}/pr-review-probe.$$.err"
lib_probe_rc=0
HELPER_CONSTANTS=" $(
  env -i "PATH=$PATH" "HOME=${HOME:-}" "TMPDIR=${TMPDIR:-/tmp}" \
    SHIP_PR_TEST_SOURCE_ONLY=1 \
    bash -c '
      # The warm-up: a pipeline for PIPESTATUS, a regex match for BASH_REMATCH, a read for REPLY.
      : | : >/dev/null
      [[ x =~ x ]] || :
      printf "%s\n" x | { read -r _ignored || :; }
      before=" $(compgen -v | tr "\n" " ")before n "
      . "$1" >/dev/null || exit 1
      for n in $(compgen -v); do
        case "$before" in *" $n "*) continue ;; esac
        # The names bash maintains, which a script does not assign and retune must not accept.
        case " BASH_ARGC BASH_ARGV BASH_ARGV0 BASH_COMMAND BASH_LINENO BASH_REMATCH BASH_SOURCE \
BASH_SUBSHELL COMP_CWORD COMP_KEY COMP_LINE COMP_POINT COMP_TYPE COMP_WORDBREAKS COMP_WORDS \
EPOCHREALTIME EPOCHSECONDS FUNCNAME GROUPS LINENO OPTARG OPTIND PIPESTATUS RANDOM REPLY SECONDS \
SRANDOM " in *" $n "*) continue ;; esac
        printf "%s " "$n"
      done
    ' _ "$HELPER" 2>"$lib_probe_err"
)" || lib_probe_rc=$?

# A probe that failed or answered nothing is a broken setup, not a script with no constants:
# retune would otherwise refuse every name and each suite would fail somewhere in its middle with
# "sets no GRACE" rather than here, where the reason is.
case "$lib_probe_rc$HELPER_CONSTANTS" in
0*[![:space:]]*) rm -f "$lib_probe_err" ;;
*)
  echo "$LIB_BASENAME: REFUSING to run: the probe that reads pr-review.sh's source-time constants exited $lib_probe_rc and named $(printf '%s' "$HELPER_CONSTANTS" | wc -w | tr -d ' ') constant(s), so \`retune\` could accept no name. What the source said:" >&2
  sed 's/^/  /' "$lib_probe_err" >&2 || :
  rm -f "$lib_probe_err"
  exit 2
  ;;
esac
unset lib_probe_err lib_probe_rc

# shellcheck source=pr-review.sh
source "$HELPER"

# What sourcing pr-review.sh installed on EXIT, read HERE because this file installs a trap of its
# own a few lines down and a trap is REPLACED, not chained: after that line the script's own is
# gone and unrecoverable. It installs none -- the forward leaves nothing behind for one to remove
# -- and the guard under the snapshot refuses the suites the day it does (ludics-lite#195).
LIB_HELPER_EXIT_TRAP=$(trap -p EXIT)

# --- the reporter and the assertions ----------------------------------------------------------
# Not `fail`: that is pr-review.sh's, and its refusals' exit codes are what the suites read.
bail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || bail "$3 (got '$1', expected '$2')"
}

assert_contains() {
  case "$1" in *"$2"*) ;; *) bail "$3 (missing '$2' in: $1)" ;; esac
}

assert_not_contains() {
  case "$1" in *"$2"*) bail "$3 (unexpected '$2' in: $1)" ;; *) ;; esac
}

# --- the state line's fields -------------------------------------------------------------------
# `token|age|mergeability|detail`, as the Python's `status-state` entry point prints it (the state
# the status and watch suites read): the detail is everything after the third `|`, pipes and all.
state_tok() { printf '%s' "${1%%|*}"; }
state_age() {
  local rest="${1#*|}"
  printf '%s' "${rest%%|*}"
}
state_merge() {
  local rest="${1#*|}"
  rest="${rest#*|}"
  printf '%s' "${rest%%|*}"
}
state_detail() {
  local rest="${1#*|}"
  rest="${rest#*|}"
  printf '%s' "${rest#*|}"
}

# --- temporary paths and the one EXIT trap ----------------------------------------------------
# This file owns the EXIT trap: the suite registers its scratch space through test_tmpdir instead
# of installing a trap of its own. Only paths mktemp created are ever removed.
TEST_CLEANUP=()
test_cleanup() {
  local p
  # bash 3.2 under `set -u` rejects "${TEST_CLEANUP[@]}" while it is empty.
  [ "${#TEST_CLEANUP[@]}" -eq 0 ] || for p in "${TEST_CLEANUP[@]}"; do rm -rf "$p"; done
}
trap test_cleanup EXIT

# test_tmpdir <var> <label>: a fresh directory under TMPDIR, its path in <var>. A function, not a
# `$(...)`, because the registration must reach this shell, and a command substitution's does not.
#
# Its own names are namespaced, because <var> is the caller's word and `printf -v` writes to
# whatever is in scope: a suite that asked for the obvious `dir` used to have the path land on the
# then-local of that name and never reach the suite, leaving an unbound variable one line later
# under `set -u`, or — worse, with a prior value — a stale path while the fresh directory sat
# registered in TEST_CLEANUP (ludics-lite#79). The two names it still cannot get out of the way of
# are refused instead of written past: its own local, and TEST_CLEANUP, which `printf -v` would
# overwrite as the array's first element and so drop every path already registered for removal.
# Refusing, rather than quietly renaming, is the register the preamble's own guards use.
test_tmpdir() {
  local __test_tmpdir_path
  case "$1" in
  __test_tmpdir_path | TEST_CLEANUP)
    bail "test_tmpdir: refusing to write the path into \$$1 — test_tmpdir uses that name itself; name the variable something else"
    ;;
  esac
  # `pr-review-test.<pid>.<label>.XXXXXX`, not `pr-review-<label>.XXXXXX`: the label alone names
  # no owner, so a directory a killed suite left behind was uncollectable by construction — the
  # `pr-review-cwd-checkout.VLoj1M` that sat in this box's TMPDIR from 09-10 is one, and it is
  # what put test_tmpdir in ludics-lite#219 alongside pr-review.sh's own temporaries. With the pid
  # in it, `watch`'s tmp_sweep_stale (prreview/watch.py) collects it on the same owner-gone test as
  # everything else. The label stays in the name, after the pid, because it is what makes a leftover
  # identifiable at a glance, and it may carry a space (`lib space`), which the quoting here and
  # the sweep's own quoting both survive.
  __test_tmpdir_path=$(mktemp -d "${TMPDIR:-/tmp}/pr-review-test.$$.$2.XXXXXX") || bail "mktemp -d failed for $2"
  # Physically resolved before anyone sees it, and here rather than in each suite: on macOS
  # $TMPDIR sits under /var, a symlink to /private/var, while pr-review.sh computes its own
  # paths with `pwd -P`. Unresolved, the two spellings of one directory differ, so a suite's
  # comparison against a $scratch path silently stops matching -- and the "must NOT appear"
  # half then passes over anything at all (ludics-lite#208).
  #
  # `CDPATH= cd`, not a bare `cd`: with CDPATH exported and a RELATIVE $TMPDIR, a successful `cd`
  # PRINTS the directory it chose, and the substitution then captures two lines while still
  # exiting zero -- a scratch path that does not exist, written into every case below. The
  # assignment prefix is temporary, `cd` being a regular builtin.
  __test_tmpdir_path=$(CDPATH= cd "$__test_tmpdir_path" && pwd -P) || bail "cannot resolve the scratch directory for $2"
  TEST_CLEANUP+=("$__test_tmpdir_path")
  printf -v "$1" '%s' "$__test_tmpdir_path"
}

# --- the fixture gh's argument parsing --------------------------------------------------------
FIXTURE_ENDPOINT=""
FIXTURE_FILTER=""
FIXTURE_PAGINATE=""
# What the request CARRIES, as gh would build it, for a fixture that asserts on a write: the
# effective method (gh's default when none is named: POST once a field or --input is added, GET
# otherwise), and the `body` and `query` fields with the kind of field each came as -- `raw` for
# -f/--raw-field, sent as written; `typed` for -F/--field, which converts values and reads `@file`
# -- or `input` when --input replaces the body with a file and moves the fields to the query
# string. Read off the parse below, never off a second scan of the arguments: a second scan
# re-reads an option's consumed VALUE as an option of its own (`-X --method=POST` is a method of
# "--method=POST" to gh, which refuses it, and POST to a naive scan).
FIXTURE_METHOD=""
FIXTURE_BODY=""
FIXTURE_BODY_KIND=""
FIXTURE_QUERY=""
FIXTURE_INPUT=""
__fixture_field_keys=" "

# gh_fixture_field <raw|typed> <key=value>: one -f/-F field. gh refuses a key with no `=` ("invalid
# key") and one given twice ("unexpected override existing field"), so the fixture refuses both
# rather than answering a request gh never sends. A bracketed key (`k[]`, `k[a]`, and the valueless
# `k[]` gh reads as an empty array) builds gh's nested parameter map, which pr-review.sh never
# sends and this parser does not model: it is refused as unmodeled -- the same answer as an option
# missing from the table below, and taught the same way, when a call first needs one.
gh_fixture_field() {
  local key="${2%%=*}"
  case "$key" in *"["*) bail "fixture does not model the bracketed field key '$key' in: gh $call -- pr-review.sh sends none; teach gh_fixture_field gh's nested map when a call needs one" ;; esac
  case "$2" in *=*) ;; *) bail "fixture received field '$2' with no '=' in: gh $call -- gh refuses it ('invalid key') and makes no request" ;; esac
  case "$__fixture_field_keys" in *" $key "*)
    bail "fixture received field '$key' twice in: gh $call -- gh refuses the override and makes no request" ;;
  esac
  __fixture_field_keys="$__fixture_field_keys$key "
  case "$key" in
  body) FIXTURE_BODY="${2#body=}" FIXTURE_BODY_KIND="$1" ;;
  query) FIXTURE_QUERY="${2#query=}" ;;
  esac
}

# gh api's OPTION TABLE, as of gh 2.99.0: every option the command accepts AS PART OF A REQUEST,
# split by whether it carries a value, each spelling its own entry and surrounded by spaces so a
# lookup is exact. `--help` is deliberately in neither list — it is an action, not an option, and
# is refused below.
#
# Two lists preceded this one and each was a guess about the options NOT named. #86 listed the
# value-taking options and let anything else stand alone, so a value-taking option it had missed
# put its value in the endpoint slot: `--input fixtures/body.json` even looks like a REST path,
# which is why a check of the slot's shape did not catch it (ludics-lite#102, round 1). Inverting
# it — list the booleans, assume everything else carries a value — moved the silence rather than
# ending it: an unknown boolean AFTER the endpoint left the endpoint intact and swallowed the
# NEXT option, so `repos/o/n/thing --future-boolean --jq .a` parsed with no filter and the
# fixture answered the raw body (round 2). Both guesses fail the same way, quietly, one gh
# release after they were written.
#
# So the fixture is exhaustive instead, and refuses what it has not been told: an option in
# neither list is a `bail` naming it. That is the right failure for a fixture — the calls it sees
# are the ones pr-review.sh makes, so an unknown option means the library grew a call this file
# has yet to learn, and one line here teaches it. A refusal is also the answer to a form the
# table cannot express (a boolean with an inline value, a bundled short): loud and unparsed beats
# parsed wrong, which is the whole lesson of the two lists above.
FIXTURE_GH_BOOLS=" -i --include --paginate --silent --slurp --verbose --allow-escape-sequences "
FIXTURE_GH_VALUED=" -X --method -f --raw-field -F --field -H --header -q --jq -t --template -p --preview --cache --hostname --input "

gh_fixture_parse() {
  local arg name value inline positional opts_ended="" positionals=0 call="$*"
  FIXTURE_ENDPOINT=""
  FIXTURE_FILTER=""
  FIXTURE_PAGINATE=""
  FIXTURE_METHOD=""
  FIXTURE_BODY=""
  FIXTURE_BODY_KIND=""
  FIXTURE_QUERY=""
  FIXTURE_INPUT=""
  FIXTURE_INCLUDE=""
  __fixture_field_keys=" "
  local method_named="" slurp="" outputs=" "
  [ "${1:-}" = api ] || bail "fixture received non-api gh call: $*"
  shift
  while [ $# -gt 0 ]; do
    arg="$1"
    shift
    positional=""
    if [ -n "$opts_ended" ]; then
      positional=1
    else
      # Split the option's NAME from an inline value, in each of pflag's spellings: `--name=v`,
      # `-x=v`, and the attached short `-xv`. `--` ends option parsing, and everything after it is
      # positional however much it looks like an option; a lone `-` is the endpoint (gh reads a
      # body from stdin, not an option).
      case "$arg" in
      --) opts_ended=1 && continue ;;
      --*=*)
        name="${arg%%=*}"
        value="${arg#*=}"
        inline=1
        ;;
      --?*)
        name="$arg"
        value=""
        inline=""
        ;;
      -?=*)
        name="${arg%%=*}"
        value="${arg#*=}"
        inline=1
        ;;
      -?)
        name="$arg"
        value=""
        inline=""
        ;;
      -??*)
        name="${arg:0:2}"
        value="${arg:2}"
        inline=1
        ;;
      *) positional=1 ;;
      esac
    fi
    if [ -n "$positional" ]; then
      # `gh api <endpoint> [flags]` takes exactly ONE positional. A second is a call the CLI
      # would have refused outright, so a fixture that answered it would be answering a request
      # production cannot send — which a test could then pass against (ludics-lite#102, round 3;
      # round 2's own control had enshrined `api -- repos/o/n/thing --paginate` as valid).
      positionals=$((positionals + 1))
      [ "$positionals" -eq 1 ] ||
        bail "fixture received $positionals positional arguments in: gh $call — gh api takes exactly one, the endpoint; the real CLI answers 'accepts 1 arg(s), received $positionals' and makes no request"
      # gh sends `/repos/...` and `repos/...` as one request, so the leading slash is spelling.
      FIXTURE_ENDPOINT="${arg#/}"
      continue
    fi
    # `--help` is a terminal ACTION, not part of a request: gh prints the help, exits 0 and calls
    # nothing, whichever side of the endpoint it sits on. It is kept out of the boolean list and
    # refused by name, so a library call that grew one by accident cannot find a fixture willing
    # to answer it (round 3).
    [ "$name" != --help ] ||
      bail "fixture received --help in: gh $call — gh api would have printed its help and made no request, so no answer here could be the right one"
    case "$FIXTURE_GH_BOOLS" in
    *" $name "*)
      # An inline value on a boolean is either pflag's `--bool=false` or a bundle of shorts, and
      # the table can express neither. Refuse it rather than pick a reading.
      [ -z "$inline" ] ||
        bail "fixture cannot parse '$arg' in: gh $call — $name takes no value, so this is either a boolean written as '$name=$value' or short options bundled as one word; write them apart"
      case "$name" in
      --paginate) FIXTURE_PAGINATE=1 ;;
      -i | --include) FIXTURE_INCLUDE=1 ;;
      --slurp) slurp=1 ;;
      --silent | --verbose) outputs="$outputs$name " ;;
      esac
      continue
      ;;
    esac
    case "$FIXTURE_GH_VALUED" in
    *" $name "*) ;;
    *) bail "fixture does not know the gh api option $name in: gh $call — add it to FIXTURE_GH_BOOLS or FIXTURE_GH_VALUED, whichever it is; guessing is what put an option's value in the endpoint slot twice (ludics-lite#86, #102)" ;;
    esac
    if [ -z "$inline" ]; then
      [ $# -gt 0 ] ||
        bail "fixture received $name with no value in: gh $call -- gh refuses it ('flag needs an argument') and makes no request"
      value="$1"
      shift || true
    fi
    case "$name" in
    --jq | -q) FIXTURE_FILTER="$value" outputs="$outputs--jq " ;;
    --template | -t) outputs="$outputs--template " ;;
    -X | --method) FIXTURE_METHOD="$value" method_named=1 ;;
    -f | --raw-field) gh_fixture_field raw "$value" ;;
    -F | --field) gh_fixture_field typed "$value" ;;
    --input) FIXTURE_INPUT="$value" ;;
    esac
  done
  # The combinations gh refuses before it sends anything (probed against gh 2.101.0). The output
  # modes count once each, so a repeated --jq is gh's last-one-wins, not a conflict.
  local mode modes=""
  for mode in --jq --template --silent --verbose; do
    case "$outputs" in *" $mode "*) modes="$modes $mode" ;; esac
  done
  case "$modes" in " "*" "*) bail "fixture received$modes together in: gh $call -- gh allows only one of them and makes no request" ;; esac
  [ -z "$slurp" ] || [ -n "$FIXTURE_PAGINATE" ] ||
    bail "fixture received --slurp without --paginate in: gh $call -- gh refuses it and makes no request"
  [ -z "$slurp" ] || case "$modes" in *--jq* | *--template*)
    bail "fixture received --slurp with$modes in: gh $call -- gh refuses it and makes no request" ;;
  esac
  [ -z "$FIXTURE_PAGINATE" ] || [ -z "$FIXTURE_INPUT" ] ||
    bail "fixture received --paginate with --input in: gh $call -- gh refuses it and makes no request"
  if [ -n "$FIXTURE_PAGINATE" ] && [ -n "$method_named" ] && [ "$FIXTURE_ENDPOINT" != graphql ]; then
    case "$FIXTURE_METHOD" in [Gg][Ee][Tt]) ;; *)
      bail "fixture received --paginate with -X $FIXTURE_METHOD in: gh $call -- gh refuses it for a non-GET request" ;;
    esac
  fi
  [ -z "$FIXTURE_INPUT" ] || FIXTURE_BODY_KIND=input
  if [ -z "$FIXTURE_METHOD" ]; then
    if [ "$__fixture_field_keys" != " " ] || [ -n "$FIXTURE_INPUT" ]; then FIXTURE_METHOD=POST; else FIXTURE_METHOD=GET; fi
  fi
  FIXTURE_METHOD=$(printf '%s' "$FIXTURE_METHOD" | tr '[:lower:]' '[:upper:]')
  # The endpoint's SHAPE, the last thing between a mis-parse and a fixture dispatching on it.
  # Every endpoint pr-review.sh addresses is `graphql` or a REST path, so anything else is a word
  # the caller never wrote as one — a `POST` the table failed to consume, or no endpoint at all —
  # and answering it would mean answering the wrong branch, which is the failure that PASSES.
  case "$FIXTURE_ENDPOINT" in
  graphql | */*) ;;
  *) bail "fixture parsed '$FIXTURE_ENDPOINT' as the endpoint of: gh $call — an endpoint is 'graphql' or a REST path carrying a '/'" ;;
  esac
  [ -z "${REQUEST_LOG:-}" ] || printf '%s\n' "$FIXTURE_ENDPOINT" >>"$REQUEST_LOG"
  [ -z "$FIXTURE_PAGINATE" ] || [ -z "${PAGINATE_LOG:-}" ] ||
    printf '%s\n' "$FIXTURE_ENDPOINT" >>"$PAGINATE_LOG"
}

# A call with --include (pr-review.sh's own writes, ludics-lite#612) gets what gh prints ahead of the
# body: the status line, the headers and a blank line, CRLF-ended (gh 2.101.0's processResponse).
gh_fixture_headers() { # <status line, e.g. "200 OK">
  printf 'HTTP/2.0 %s\r\nContent-Type: application/json; charset=utf-8\r\nX-Github-Request-Id: FIX:TURE\r\n\r\n' "$1"
}

# What gh prints for an answer it could not read the body of: under --include the status line still
# reaches stdout, and stderr is the JSON decoder's complaint alone, with no `gh: ` and no status
# (ludics-lite#612). gh then exits 1, which is the caller's `return 1`.
gh_fixture_unreadable() { # <status line>
  if [ -n "$FIXTURE_INCLUDE" ]; then gh_fixture_headers "$1"; fi
  printf 'unexpected end of JSON input\n' >&2
}

gh_fixture_answer() {
  if [ -n "$FIXTURE_INCLUDE" ]; then
    case "$FIXTURE_METHOD" in POST) gh_fixture_headers "201 Created" ;; *) gh_fixture_headers "200 OK" ;; esac
  fi
  if [ -n "$FIXTURE_FILTER" ]; then
    jq -r "$FIXTURE_FILTER" <<<"$1"
  else
    printf '%s\n' "$1"
  fi
}

# --- review threads (ludics-lite#289) --------------------------------------------------------
# One thread as the reviewThreads connection serves it: isResolved, the path, and the first
# comment's ids and author — the fields pr-review.sh's open-thread read asks for. Both ids, as
# GitHub serves them: fullDatabaseId a BigInt STRING, databaseId the same value as a number below
# 2^31 and null from there on — the schema types it a 32-bit Int, and review comment ids already
# run past that.
review_thread() { # <first comment id> <true|false> [path] [author]
  jq -cn --argjson id "$1" --argjson r "$2" --arg p "${3:-a.sh}" --arg a "${4:-codex[bot]}" \
    '{id:("T" + ($id | tostring)), isResolved:$r, path:$p,
      comments:{nodes:[{fullDatabaseId:($id | tostring),
                        databaseId:(if $id < 2147483648 then $id else null end),
                        author:{login:$a}}]}}'
}

# The GraphQL answer to the open-thread query over <nodes> (a JSON array of review_thread rows),
# paged as GitHub pages it: THREADS_FIXTURE_PAGE rows a page (100), the cursor `c<offset>`, read
# back from the call's own `after=` field (both readers, the gate and `find_thread`, page this
# way since they share threads_walk), and a totalCount of the whole array unless
# THREADS_FIXTURE_TOTAL states another (a count that leads the rows). Pass the fixture's "$@"
# after the nodes, and send the result through gh_fixture_answer for the call's --jq.
review_threads_answer() { # <nodes json> <the gh call's args...>
  local nodes="$1" arg start=0
  shift
  for arg in "$@"; do
    case "$arg" in
    after=c*) start="${arg#after=c}" ;;
    after=*) bail "review_threads_answer: a cursor this fixture never served: $arg" ;;
    esac
    case "$start" in '' | *[!0-9]*) bail "review_threads_answer: a cursor this fixture never served: $arg" ;; esac
  done
  jq -cn --argjson nodes "$nodes" --argjson start "$start" \
    --argjson size "${THREADS_FIXTURE_PAGE:-100}" --argjson total "${THREADS_FIXTURE_TOTAL:-null}" '
    {data:{repository:{pullRequest:{reviewThreads:{
      totalCount: ($total // ($nodes | length)),
      pageInfo: {hasNextPage: (($start + $size) < ($nodes | length)),
                 endCursor: ("c" + (($start + $size) | tostring))},
      nodes: $nodes[$start:($start + $size)]}}}}}'
}

# --- inline comment rows (ludics-lite#91) ------------------------------------------------------
# The two shapes GitHub serves one inline finding in, built here once so a suite cannot drift from
# what pr-review-api-contract.sh pins of them: test-pr-review-api-contract.sh builds the contract's
# reviewed-PR world from THESE builders and runs the contract's own pins over it, so a builder
# that stops carrying a field the contract names turns that suite red. Both carry the two commit
# fields — GitHub migrates `commit_id` forward to the current head for a comment whose lines still
# exist, while `original_commit_id` stays the commit the reviewer wrote it against — the
# `pull_request_review_id` the contract pins on both feeds (1 unless the extra json says
# otherwise; poll's fold deny-lists it), and BOTH halves of the anchor pair the row migrates in,
# the original defaulting to the current one, so a migrated anchor is an argument rather than a
# case nobody can write (#272: one position argument written to both fields hid a renderer gap
# from every fixture).
#
# inline_comment: a row of the FLAT listing (pulls/<n>/comments), anchored by line/original_line.
inline_comment() { # <id> <original commit> <current commit> [body] [path] [line] [original line] [extra json]
  jq -cn --argjson id "$1" --arg orig "$2" --arg cur "$3" --arg b "${4:-a finding}" \
    --arg p "${5:-a.sh}" --argjson ln "${6:-3}" --argjson oln "${7:-${6:-3}}" \
    --argjson extra "${8:-null}" --arg rev "$REVIEWER" \
    '{id:$id, pull_request_review_id:1, user:{login:($rev + "[bot]")}, path:$p, line:$ln,
      original_line:$oln, body:$b, original_commit_id:$orig, commit_id:$cur} + ($extra // {})'
}

# positional_comment: a row as the PER-REVIEW comments endpoint (pulls/<n>/reviews/<id>/comments)
# serves it, which is not the flat listing's shape: no `line` and no `original_line` at all —
# verified against this repository's live API on 2026-09-10 — with the location carried by
# position/original_position instead. poll renders such a row by the field it actually has,
# `:@<position>`.
positional_comment() { # <id> <original commit> <body> <position> [original position] [extra json]
  jq -cn --argjson id "$1" --arg orig "$2" --arg b "$3" --argjson pos "$4" \
    --argjson opos "${5:-$4}" --argjson extra "${6:-null}" --arg rev "$REVIEWER" \
    '{id:$id, pull_request_review_id:1, user:{login:($rev + "[bot]")}, path:"a.sh", body:$b,
      position:$pos, original_position:$opos, original_commit_id:$orig, commit_id:$orig}
     + ($extra // {})'
}

# --- counting a fixture's calls --------------------------------------------------------------
# A fixture `gh` that must answer differently from the Nth call on needs a count that SURVIVES
# it: every call runs the fixture in a shell of its own (the forward's bridge, a fresh bash per
# call, as the shell's `$(gh ...)` once did), and a `CALLS=$((CALLS + 1))` inside it is thrown
# away with the answer captured. A file is the only
# thing a subshell can leave behind for the next one, which is why every suite that needed this
# grew a `printf x >>"$FILE"` and a `wc -l` of its own (the merge suite three of them, the base
# fixture's round counter a fourth). One helper, keyed by name, under the suite's $TEST_ROOT so
# the EXIT trap collects it with everything else; there is no default root to write into, so a
# suite without a TEST_ROOT is refused rather than counted in $PWD. `fixture_call_total` reads
# the same file without appending: what a case asserts on, and what a fixture branch that must
# NOT be the counting one (the base fixture's tip read, keyed off its round count) consults.
#
# One line appended and the lines counted, rather than a number read, bumped and written back:
# appends of one short line are atomic where a read-modify-write is not, and the fixture runs in
# whatever order the calls fork it, so a rewritten total could lose a call.
#
# EVERY filesystem step in all three helpers is `|| bail`: the mkdir, the append, each count, and
# each removal. A count runs inside a command substitution, which does not inherit errexit, so a step
# whose status is dropped there answers with a stale or empty total under a clean status — and a
# caller's `reads=$(fixture_call_count x) || return 1` then sees nothing wrong. `bail` exits the
# substitution's shell with 1, which is what that caller's `||` catches; from a reset, called at
# the top of a case, it ends the suite, which is what a reset that left stale counters deserves
# (review rounds 1 and 2 of ludics-lite#301 found two of these one at a time; the rule closes
# the class).
#
# A name is ONE path component, and a plain one: it is joined to the directory as a filename, so
# `../victim` would count — and `fixture_call_reset ../victim` would remove — a file outside the
# root the EXIT trap owns. Refused by shape rather than resolved: a slash either way, `.` and
# `..`, an empty name, and a leading `-` (which `rm -f` would read as an option) are all names no
# suite means, and the refusal is cheaper than a counter that lands somewhere else.
fixture_call_name_ok() {
  case "$1" in
  '' | . | .. | -* | */* | *\\*) return 1 ;;
  esac
}

fixture_call_count() {
  local dir total
  [ $# -eq 1 ] || bail "fixture_call_count: one counter name expected, got $# argument(s): $*"
  fixture_call_name_ok "$1" || bail "fixture_call_count: a counter name is one plain path component, not '$1'"
  [ -n "${TEST_ROOT:-}" ] || bail "fixture_call_count $1: TEST_ROOT is unset — ask test_tmpdir for one before the fixture runs"
  dir="$TEST_ROOT/fixture-calls"
  mkdir -p "$dir" || bail "fixture_call_count $1: cannot create $dir"
  printf 'x\n' >>"$dir/$1" || bail "fixture_call_count $1: cannot append to $dir/$1"
  total=$(wc -l <"$dir/$1") || bail "fixture_call_count $1: cannot read $dir/$1"
  printf '%s\n' "${total// /}"
}

# fixture_call_total <name>: the current total under <name>, WITHOUT counting; 0 when nothing has
# counted under it yet (the file does not exist), which is also what a reset leaves behind. A
# counter file that exists but cannot be read is a failed call, not a zero.
fixture_call_total() {
  local dir total
  [ $# -eq 1 ] || bail "fixture_call_total: one counter name expected, got $# argument(s): $*"
  fixture_call_name_ok "$1" || bail "fixture_call_total: a counter name is one plain path component, not '$1'"
  [ -n "${TEST_ROOT:-}" ] || bail "fixture_call_total $1: TEST_ROOT is unset — ask test_tmpdir for one before the fixture runs"
  dir="$TEST_ROOT/fixture-calls"
  if [ ! -e "$dir/$1" ]; then
    echo 0
    return 0
  fi
  total=$(wc -l <"$dir/$1") || bail "fixture_call_total $1: cannot read $dir/$1"
  printf '%s\n' "${total// /}"
}

# fixture_call_reset [<name>...]: the named counters back to zero, or every counter with no name.
# A missing counter is already zero, so resetting one that never counted is not an error.
fixture_call_reset() {
  local dir name
  [ -n "${TEST_ROOT:-}" ] || bail "fixture_call_reset: TEST_ROOT is unset — ask test_tmpdir for one before the fixture runs"
  dir="$TEST_ROOT/fixture-calls"
  if [ $# -eq 0 ]; then
    rm -rf "$dir" || bail "fixture_call_reset: cannot remove $dir — the next case would count on from this one's total"
    return 0
  fi
  for name in "$@"; do
    fixture_call_name_ok "$name" || bail "fixture_call_reset: a counter name is one plain path component, not '$name'"
  done
  for name in "$@"; do
    rm -f "$dir/$name" || bail "fixture_call_reset: cannot remove $dir/$name — the next case would count on from this one's total"
  done
}

# --- a jq that writes CRLF, on every platform (ludics-lite#335) --------------------------------
# A native jq.exe (what Windows users and the Git Bash CI leg have) ends every output line CRLF,
# and pr-review.sh reads it through `jq_lf`, which it decides once at source time. This is that jq
# where there is none: a stub that runs the jq on PATH and adds one \r before every \n it writes,
# which is what text mode does (a CRLF inside a raw string comes out \r\r\n). <mode> says what it
# does with a leading `-b`: `binary` drops it and writes LF (jq 1.7+ on Windows), `no-binary`
# refuses it the way jq 1.6 refuses an option it does not know.
#
# The jq it wraps is read LF first, through pr-review.sh's own probe of it, so the stub adds
# exactly one \r wherever it runs — over the Git Bash leg's jq.exe as over a Unix jq — and over
# another stub. `type -P`, not `command -v`: pr-review.sh makes `jq` a function, which
# `command -v` would name.
jq_crlf_stub() { # <dir> <binary|no-binary>
  local real real_eol saved="$JQ_EOL"
  real=$(type -P jq) || bail "jq_crlf_stub: no jq on PATH to wrap"
  jq_eol_probe
  real_eol="$JQ_EOL"
  JQ_EOL="$saved"
  {
    echo '#!/usr/bin/env bash'
    echo "# A jq.exe stand-in written by $LIB_BASENAME (ludics-lite#335)."
    echo 'set -o pipefail'
    printf 'real=%q\n' "$real"
    # shellcheck disable=SC2016 # the stub's own words, expanded when the stub runs
    case "$real_eol" in
    lf) echo 'lf() { "$real" "$@"; }' ;;
    binary) echo 'lf() { "$real" -b "$@"; }' ;;
    *) echo 'lf() { "$real" "$@" | sed $'"'"'s/\r$//'"'"'; }' ;;
    esac
    # shellcheck disable=SC2016
    case "$2" in
    binary) echo 'if [ "${1:-}" = -b ]; then shift; lf "$@"; exit; fi' ;;
    no-binary) echo 'if [ "${1:-}" = -b ]; then echo "jq: Unknown arguments: -b" >&2; exit 2; fi' ;;
    *) bail "jq_crlf_stub: mode is binary or no-binary, not '$2'" ;;
    esac
    # shellcheck disable=SC2016
    echo 'lf "$@" | sed $'"'"'s/$/\r/'"'"
  } >"$1/jq" || bail "jq_crlf_stub: cannot write $1/jq"
  chmod +x "$1/jq" || bail "jq_crlf_stub: cannot make $1/jq executable"
}

# SHIP_PR_TEST_JQ_EOL=crlf (a jq.exe that takes -b) or crlf-no-binary (one that does not) runs the
# whole suite with that stub first on PATH, and pr-review.sh's probe re-asked under it: how CI on
# Ubuntu and macOS holds the four suites ludics-lite#335 found red under Git Bash, without Windows.
# The probe's answer is checked, not assumed: a stub that stopped writing CRLF would otherwise run
# the suite as an ordinary LF one and pass it, proving nothing.
case "${SHIP_PR_TEST_JQ_EOL:-}" in
'') ;;
crlf | crlf-no-binary)
  lib_jq_mode=binary lib_jq_want=binary
  [ "$SHIP_PR_TEST_JQ_EOL" = crlf ] || lib_jq_mode=no-binary lib_jq_want=strip
  test_tmpdir lib_jq_dir jq-crlf
  jq_crlf_stub "$lib_jq_dir" "$lib_jq_mode"
  PATH="$lib_jq_dir:$PATH"
  jq_eol_probe
  if [ "$JQ_EOL" != "$lib_jq_want" ]; then
    echo "$LIB_BASENAME: REFUSING to run: SHIP_PR_TEST_JQ_EOL=$SHIP_PR_TEST_JQ_EOL should make pr-review.sh read jq as '$lib_jq_want', and it probed '$JQ_EOL' — the suite would run over a jq that is not the one it was asked for" >&2
    exit 2
  fi
  unset lib_jq_mode lib_jq_want lib_jq_dir
  ;;
*)
  echo "$LIB_BASENAME: REFUSING to run: SHIP_PR_TEST_JQ_EOL is crlf, crlf-no-binary or empty, not '$SHIP_PR_TEST_JQ_EOL'" >&2
  exit 2
  ;;
esac

# --- retuning pr-review.sh's source-time constants --------------------------------------------
# GRACE, STALL, ROUND_GAP, ABSENT_GRACE, CHECKS_INTERVAL and the rest are read from the
# environment ONCE, when pr-review.sh is sourced. So `SHIP_PR_REVIEW_GRACE=1 run_watch ...` reaches
# nothing in a suite that sourced the script minutes earlier: a case that needs a different clock
# has to assign the constant itself. Done by hand that is a save, an assignment and a restore per
# case (the `grace_was` triple the watch suite carried six times over), and the restore is the part
# that gets forgotten — a constant left retuned leaks into every case after it, which is a wrong
# RESULT, not a failure. `retune` remembers the value as sourced and `run_tests` puts it back when
# the case ends, so no case has to.
TUNED_SAVED=()

# retune <NAME>=<value>...: move constants for the current case. A name pr-review.sh does not set
# when it is sourced is a typo — assigning it would invent a variable the script never reads, and
# the case would pass while proving nothing — so it is refused.
retune() {
  local assignment name
  [ $# -gt 0 ] || bail "retune: no constant named"
  for assignment in "$@"; do
    case "$assignment" in
    [A-Za-z_]*=*) ;;
    *) bail "retune: '$assignment' is not a NAME=value assignment" ;;
    esac
    name=${assignment%%=*}
    case "$HELPER_CONSTANTS" in
    *" $name "*) ;;
    *) bail "retune $name: pr-review.sh sets no $name when it is sourced — nothing to retune" ;;
    esac
    # Only the FIRST retune of a name is saved, so a case that moves one constant twice is still
    # restored to the value pr-review.sh gave it, not to the intermediate.
    case " $(lib_tuned_names) " in
    *" $name "*) ;;
    *) TUNED_SAVED+=("$name=${!name-}") ;;
    esac
    printf -v "$name" '%s' "${assignment#*=}"
  done
}

lib_tuned_names() {
  local assignment
  [ "${#TUNED_SAVED[@]}" -eq 0 ] || for assignment in "${TUNED_SAVED[@]}"; do
    printf '%s ' "${assignment%%=*}"
  done
}

# restore_tuning: every retuned constant back to the value it was sourced with. run_tests calls it
# after each case; a case that wants the constants back before its own assertions may call it too.
restore_tuning() {
  local assignment
  [ "${#TUNED_SAVED[@]}" -eq 0 ] || for assignment in "${TUNED_SAVED[@]}"; do
    printf -v "${assignment%%=*}" '%s' "${assignment#*=}"
  done
  TUNED_SAVED=()
}

# --- the stub declarations and the shadow guard -----------------------------------------------
# `declare -F <names>` under extdebug prints "<name> <line> <file>" per function; the option is
# set in a subshell so its debugger side effects (function and error tracing) touch nothing else.
lib_function_table() {
  local names
  names=$(declare -F | sed 's/^declare -f //')
  # shellcheck disable=SC2086 # the names are one word each, and the point is to split them
  (shopt -s extdebug && declare -F $names) || true
}

# lib_owner_of <name> <table>: the "<line> <file>" the table records for <name>, empty if none.
#
# A here-string, not `printf … | awk`: awk stops at the first match, and a reader that exits early
# closes the pipe under the writer. The writer then takes a SIGPIPE, `set -o pipefail` — which
# every suite runs under — makes that the pipeline's status, and the caller's `$(…)` assignment
# fails under `set -e`. It is a race on whether the table still fits the pipe buffer when awk
# leaves, so it fires once in many runs and reproduces nowhere: main went red on 2026-09-10 with
# `line 418: printf: write error: Broken pipe` out of test_own_functions_pass, a case that touches
# none of this. A here-string is fed from a temporary file rather than a pipe, so there is no
# reader to close and nothing to signal. Same output, same status, in all three cases the callers
# rely on — a match at either end of the table, and no match at all. This is ludics-lite#118's
# shape (`printf … | grep -q`) in the preamble that issue holds up as the model for the fix.
lib_owner_of() {
  awk -v n="$1" '$1 == n { sub(/^[^ ]+ /, ""); print; exit }' <<<"$2"
}

# The names below this point are not protected: the snapshot is taken once everything this file
# defines exists, at the end of the sourced part.
STUBS=""

# stub <fn>...: the suite redefines these on purpose. A name the library lacks is a typo, and a
# declaration never honoured is refused by the guard.
stub() {
  local fn
  [ $# -gt 0 ] || bail "stub: no function named"
  for fn in "$@"; do
    [ -n "$(lib_owner_of "$fn" "$LIB_SNAPSHOT")" ] ||
      bail "stub $fn: neither pr-review.sh nor $LIB_BASENAME defines $fn — nothing to stub"
    STUBS="$STUBS $fn "
  done
}

lib_declared_stub() { case "$STUBS" in *" $1 "*) ;; *) return 1 ;; esac; }

# The files whose functions are protected, one per line — pr-review.sh and this file to begin
# with, and whatever `protect_library` adds. Newline-separated rather than space-separated
# because a checkout's path can contain spaces, which is a shape this file's own controls run in.
LIB_PROTECTED_FILES="$HELPER
$TEST_LIB_FILE"

# A path as the suite's reader would write it: a protected library file by basename, the suite as
# it was invoked (which is what `declare -F` records).
lib_show_file() {
  case "
$LIB_PROTECTED_FILES
" in
  *"
$1
"*) basename "$1" ;;
  *) printf '%s' "$1" ;;
  esac
}

check_shadows() {
  local table name owner now file line owner_file owner_line problems=""
  table=$(lib_function_table)
  while read -r name owner_line owner_file; do
    [ -n "$name" ] || continue
    now=$(lib_owner_of "$name" "$table")
    if [ "$now" = "$owner_line $owner_file" ]; then
      ! lib_declared_stub "$name" ||
        problems="$problems
  - stub $name is declared, but $name is still $(lib_show_file "$owner_file")'s: drop the declaration or define the stub"
      continue
    fi
    lib_declared_stub "$name" && continue
    line=${now%% *}
    file=${now#* }
    problems="$problems
  - $(lib_show_file "$owner_file")'s $name ($(lib_show_file "$owner_file"):$owner_line) is redefined at $(lib_show_file "$file"):$line without \`stub $name\`"
  done <<<"$LIB_SNAPSHOT"
  [ -z "$problems" ] || {
    echo "$LIB_BASENAME: REFUSING to run the cases: a suite function replaces a library function it did not declare (ludics-lite#46) — a same-named helper silently takes over every call the library makes (a reporter named \`fail\` turns each refusal's exit code into 1); declare a deliberate override with \`stub <fn>\`, else rename the suite's function:$problems" >&2
    exit 2
  }
}

# run_tests <case>... -- "$@": the guard, then the cases in order, each announced on stdout. A
# case's retuned constants are put back before the next one starts, whether or not it restored
# them.
#
# SHIP_PR_TEST_CASES, a space-separated list of case names, runs only those — in the suite's order,
# not the list's, since some cases lean on the one before them — and ends the run with
# `SUBSET: <n> of <m> cases`, a line a full run never prints, so a partial run cannot pass for a
# full one. A name the suite does not run is refused rather than skipped, since a typo would run
# nothing and report green; so is any subset under GITHUB_ACTIONS=true, so CI never runs part of
# a suite. The variable is read once and unset before the first case: a case that runs a
# throwaway suite of its own must not hand it a list naming the outer suite's cases.
#
# The suite's own arguments, after `--`, select the same way, so `bash <suite> <case>...` is the
# list spelled on the command line; naming cases both ways is refused rather than merged. The
# `--` is required, not optional: a suite that never forwarded its arguments ran the whole suite
# for `bash test-pr-review-base-verdict.sh <case>` and said nothing, and a forward that may be
# left out would let the next suite drop them the same way.
#
# Every case named must already be a function when run_tests is reached, and the run is refused
# before the first case otherwise. PR #415 defined a case inside another case's body: the full run
# was green, since the outer case defined the inner one before its turn came, but a subset naming
# the inner case alone had nothing to call — and only the reviewer noticed. A name the register
# carries and no function answers is a defect of the suite, whichever cases a run selects.
run_tests() {
  local test_name cases=() listed=() wanted=() selected=() missing="" undefined="" from
  check_shadows
  while [ $# -gt 0 ] && [ "$1" != -- ]; do
    cases+=("$1")
    shift
  done
  [ $# -gt 0 ] || {
    echo "$LIB_BASENAME: REFUSING to run: run_tests was not handed the suite's arguments — end the call with \`-- \"\$@\"\`, or a case named on the suite's command line is ignored and the whole suite runs in its place" >&2
    exit 2
  }
  shift
  [ "${#cases[@]}" -gt 0 ] || bail "run_tests: no cases named"
  for test_name in "${cases[@]}"; do
    declare -F "$test_name" >/dev/null || undefined="$undefined $test_name"
  done
  [ -z "$undefined" ] || {
    echo "$LIB_BASENAME: REFUSING to run: run_tests names cases that are not defined functions:$undefined — define every case at the top level of the suite, where it exists before the first case runs (a case defined inside another case's body cannot be selected alone)" >&2
    exit 2
  }
  read -r -d '' -a listed <<<"${SHIP_PR_TEST_CASES:-}" || true
  unset SHIP_PR_TEST_CASES
  if [ $# -gt 0 ]; then
    [ "${#listed[@]}" -eq 0 ] || {
      echo "$LIB_BASENAME: REFUSING to run: cases are named both on the command line ($*) and in SHIP_PR_TEST_CASES (${listed[*]}) — name them one way" >&2
      exit 2
    }
    wanted=("$@")
    from="the command line"
  elif [ "${#listed[@]}" -gt 0 ]; then
    wanted=("${listed[@]}")
    from=SHIP_PR_TEST_CASES
  fi
  if [ "${#wanted[@]}" -eq 0 ]; then
    selected=("${cases[@]}")
  else
    [ "${GITHUB_ACTIONS:-}" != true ] || {
      echo "$LIB_BASENAME: REFUSING to run: $from asks for a subset (${wanted[*]}) under GITHUB_ACTIONS=true — CI runs every case of a suite, never a part of one" >&2
      exit 2
    }
    for test_name in "${wanted[@]}"; do
      lib_is_one_of "$test_name" "${cases[@]}" || missing="$missing $(printf '%q' "$test_name")"
    done
    [ -z "$missing" ] || {
      echo "$LIB_BASENAME: REFUSING to run: $from names what this suite does not run:$missing — a name that selects nothing would run nothing and report green" >&2
      exit 2
    }
    for test_name in "${cases[@]}"; do
      if lib_is_one_of "$test_name" "${wanted[@]}"; then selected+=("$test_name"); fi
    done
  fi
  for test_name in "${selected[@]}"; do
    "$test_name"
    restore_tuning
    echo "PASS: $test_name"
  done
  [ "${#wanted[@]}" -eq 0 ] || echo "SUBSET: ${#selected[@]} of ${#cases[@]} cases"
}

# lib_is_one_of <word> <word>...: whether the first word is one of the rest, compared whole — a
# command-line argument may carry a space, and a space-joined match would take `"a b"` for both.
lib_is_one_of() {
  local word="$1" each
  shift
  for each in "$@"; do
    [ "$each" != "$word" ] || return 0
  done
  return 1
}

# protect_library <file>: extend the guard over a SECOND library, sourced after this one — the
# base suites' shared fixture transport is the first (ludics-lite#179). The snapshot below is
# taken while this file is being sourced, so everything a later library defines is outside it, and
# a suite redefining one of those names was accepted in silence: the three suites over
# test-pr-review-base-lib.sh share `gh`, `reset_fixture`, `run_base` and the wall-clock setters,
# and a suite helper colliding with one of them replaces it for every call the transport makes —
# which is ludics-lite#46 exactly, one library further out (review of #212, round 1).
#
# <file> is the path as the shell records it, which is `${BASH_SOURCE[0]}` inside the library
# itself: `declare -F` prints the path the file was sourced through, and a resolved one would
# match nothing. A file that defines no function is refused rather than protecting nothing —
# an empty extension is the same silent pass as no extension at all.
protect_library() {
  local file="$1" added
  [ -n "$file" ] || bail "protect_library: no file named"
  added=$(lib_function_table |
    awk -v f="$file" '{ path = $0; sub(/^[^ ]+ [^ ]+ /, "", path); if (path == f) print }')
  case "$added" in
  *[![:space:]]*) ;;
  *) bail "protect_library: $file defines no function in this shell — name the file as \`\${BASH_SOURCE[0]}\` from inside it, after its definitions" ;;
  esac
  LIB_SNAPSHOT="$LIB_SNAPSHOT
$added"
  LIB_PROTECTED_FILES="$LIB_PROTECTED_FILES
$file"
}

# --- the second guard: pr-review.sh installs no EXIT trap for this file's to replace ------------
# This file installs an EXIT trap, and a trap is REPLACED, not chained: a trap that sourcing
# pr-review.sh installed would never run in a suite. When the script still had temporaries of its
# own, this guard held this file's trap to CALLING the script's cleanup by name, because the copies
# that restated it drifted: ludics-lite#191 added a snapshot directory to the script's trap alone,
# and from then on every suite run leaked one into the real TMPDIR while every suite and CI stayed
# green (ludics-lite#195). Since the shell half was retired the script leaves nothing behind -- the
# forward removes its bridge file before it returns -- and installs no trap. So the guard is now
# that it stays so: a trap that comes back is refused here, by name, before a suite can run
# without it, rather than discovered as debris in TMPDIR.
lib_refuse_trap() {
  echo "$LIB_BASENAME: REFUSING to run: $1 — this file installs its own EXIT trap over it, REPLACING it, so it would never run in a suite. Leave pr-review.sh trapless: a temporary it makes is removed by the code that made it, as the forward removes its bridge file. A trap's cleanup restated here instead is how ludics-lite#191's snapshot directory leaked from every suite run in silence (ludics-lite#195)." >&2
  exit 2
}

[ -z "$LIB_HELPER_EXIT_TRAP" ] ||
  lib_refuse_trap "sourcing pr-review.sh installed an EXIT trap ($LIB_HELPER_EXIT_TRAP)"

# What is PROTECTED is what these two files define, and only that — the table is filtered on the
# defining file rather than taken whole. A function the environment exported in (`export -f`) is
# in scope here too, and bash records it with no file at all; recorded as library-owned, it made a
# suite's own fixture `gh` read as a redefinition of it and refused the suite ("(null)'s gh
# ((null):0) is redefined at …"). An inherited function is not the library's, and a suite is free
# to define one of any name — which is the same ground the fixture `gh` has always stood on.
# Only the snapshot is filtered: `check_shadows` reads the CURRENT table unfiltered, because the
# file it reports a redefinition from is the suite's own.
#
# The path is the INTACT remainder of the record, not a field: `declare -F` prints "<name> <line>
# <file>", and a checkout under a path with a space in it — `/tmp/ludics review.XXXX`, which is
# what a scratch clone looks like — splits that file across awk's fields. Comparing `$3` then
# matched nothing, the snapshot came out EMPTY, and an empty snapshot does not fail: it protects
# no function at all, so every shadow is accepted and the file's own first control passes a
# deliberate `fail` through. Hence the check under it, which is the same guard the constants probe
# carries: this file's whole purpose is a refusal, and a refusal that quietly has nothing to say
# is the failure mode it was written against.
LIB_SNAPSHOT=$(lib_function_table |
  awk -v h="$HELPER" -v t="$TEST_LIB_FILE" '{
    path = $0
    sub(/^[^ ]+ [^ ]+ /, "", path)
    if (path == h || path == t) print
  }')
case "$LIB_SNAPSHOT" in
*[![:space:]]*) ;;
*)
  echo "$LIB_BASENAME: REFUSING to run: the function-table snapshot named nothing, so the shadow guard would protect no function and every ludics-lite#46 shadow would be accepted silently; pr-review.sh ($HELPER) and this file should between them define some seventy" >&2
  exit 2
  ;;
esac

# --- executed: this file's own controls -------------------------------------------------------
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0
set -euo pipefail

# The copy control at the end runs this very file again, from a renamed copy. That inner run must
# not copy itself a third time, and the marker that stops it is an ARGUMENT rather than an
# exported variable on purpose: an argument cannot arrive from an ambient environment, so no stray
# `export` in a caller's shell can delete the control from an ordinary run and leave the file
# reporting a PASS for a case that did nothing. Any other option is a typo, and a typo that ran
# the whole suite anyway would look like the flag had been honoured. Words that are not options
# are case names, handed to run_tests like any suite's, which refuses one this file does not run.
#
# The COUNT is part of the match, not just the first word. Reading `$1` alone accepted
# `--inner-copy typo`: the trailing word was ignored, the copy control skipped itself, and the run
# reported all 19 PASS lines — the whole suite green with the one control it was told to refuse
# silently missing, which is the failure this parser exists to prevent.
LIB_INNER_RUN=""
case "$#:${1:-}" in
"1:--inner-copy")
  LIB_INNER_RUN=1
  shift
  ;;
*:-*)
  echo "$LIB_BASENAME: REFUSING to run: expected case names, or exactly \`--inner-copy\` alone (which this file passes to a copy of itself); got $# argument(s): $*" >&2
  exit 2
  ;;
esac

test_tmpdir CONTROL_ROOT lib-test
CONTROL_N=0

# control <body...>: a throwaway suite that sources this file and runs a passing case, with the
# given lines in between. Its exit code, stdout and stderr land in CONTROL_RC / _OUT / _ERR, and
# the suite it wrote in CONTROL_FILE.
control() {
  control_in "$CONTROL_ROOT" "$@"
}

# control_in <dir> <body...>: `control`, with the throwaway suite written in <dir> instead of
# beside the others. It sources the preamble copy in <dir> when the caller has put one there —
# and so runs against whatever pr-review.sh sits beside THAT copy, which is what a control over
# the source itself needs — and this file where it lives when <dir> holds no copy, which is the
# plain `control` above. A control wanting a directory of its own makes one with `test_tmpdir`,
# whose label is part of the name and so may carry a space, and copies in what it wants read.
#
# What is written is always a throwaway SUITE, never this file: a control that ran the preamble
# itself would re-enter the case that called it, and that one would run it again, forever. The one
# control that does run the preamble — test_the_self_test_runs_from_a_renamed_copy, which has to,
# since what it pins is that the file works when executed under another name — does not go through
# here for exactly that reason: it runs the copy itself, and passes `--inner-copy` to stop the
# recursion this paragraph describes.
control_in() {
  local dir file lib
  dir="$1"
  shift
  [ -d "$dir" ] || bail "control_in: $dir is not a directory"
  lib="$dir/$(basename "$TEST_LIB_FILE")"
  [ -f "$lib" ] || lib="$TEST_LIB_FILE"
  CONTROL_N=$((CONTROL_N + 1))
  file="$dir/control-$CONTROL_N.sh"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'source %s\n' "\"$lib\""
    printf '%s\n' "$@"
    echo 'test_a_case() { assert_eq 1 1 "one is one"; }'
    echo 'run_tests test_a_case -- "$@"'
  } >"$file"
  CONTROL_FILE="$file"
  control_run "$file"
}

# control_run <script> [<arg>...]: run <script> with <arg>s and land its exit code, stdout and
# stderr in CONTROL_RC / _OUT / _ERR. For the controls that cannot be a plain body — a wrapper
# that exports a function in before exec'ing a suite, a suite that defines one above the source,
# a suite given case names — which need the capture and nothing else. The two capture files stay in $CONTROL_ROOT wherever <script> is, so a
# control with a directory of its own has in it only what it was given.
control_run() {
  local rc
  set +e
  bash "$@" >"$CONTROL_ROOT/out" 2>"$CONTROL_ROOT/err"
  rc=$?
  set -e
  CONTROL_RC="$rc"
  CONTROL_OUT=$(cat "$CONTROL_ROOT/out")
  CONTROL_ERR=$(cat "$CONTROL_ROOT/err")
}

# mutation_copy <destination> <old> <new>: patch exactly one literal occurrence in the sourced
# preamble. Restricting the patch to the sourced section keeps the mutation's own quoted recipe
# out of its match count. The tracked file is read only; a missing/ambiguous target refuses
# before any output file is written.
mutation_copy() {
  perl - "$TEST_LIB_FILE" "$@" <<'PERL'
use strict;
use warnings;
my ($source, $dest, $old, $new) = @ARGV;
open my $in, '<', $source or die "$source: $!\n";
local $/;
my $text = <$in>;
my $boundary = index($text, '# --- executed:');
die "mutation_copy: missing executed boundary\n" if $boundary < 0;
my $preamble = substr($text, 0, $boundary);
my $count = 0;
my $pos = -1;
if (length $old) {
  while (($pos = index($preamble, $old, $pos + 1)) >= 0) { $count++; }
}
die "mutation_copy: expected exactly one patch target, found $count\n" if $count != 1;
substr($text, index($preamble, $old), length($old)) = $new;
open my $out, '>', $dest or die "$dest: $!\n";
print {$out} $text or die "$dest: $!\n";
close $out or die "$dest: $!\n";
PERL
}

# mutant <case> <old> <new> <failure>: prove the unmodified case passes first, then
# require its assertion failure, not a syntax/load failure or an unrelated earlier case. The
# copy runs <case> alone, named on its command line, with GITHUB_ACTIONS emptied for that one
# call: CI runs this file with it set to true, and run_tests refuses any subset under it. An
# assignment prefix can empty it but not unset it, and run_tests reads empty as not-CI; a prefix
# is what keeps the outer suite's own value intact for the cases after this one.
mutant() {
  local root copy
  # The field-splitting mutant must load before the target case puts it in a spaced path.
  # Keep the outer copy outside an ambient TMPDIR with spaces. Each case creates its own
  # required path; confine even a broken probe's uncleaned diagnostics to this registered root.
  TMPDIR=/tmp test_tmpdir root mutation
  copy="$root/$LIB_BASENAME"
  cp "$HELPER" "$root/"
  mutation_copy "$copy" "$2" "$2"
  GITHUB_ACTIONS='' TMPDIR="$root" control_run "$copy" "$1"
  assert_eq "$CONTROL_RC" 0 "mutation baseline for $1 ($CONTROL_ERR)"
  assert_eq "$CONTROL_OUT" "PASS: $1
SUBSET: 1 of ${#tests[@]} cases" "the selected baseline case must run, alone"
  assert_eq "$CONTROL_ERR" "" "the baseline must be clean"
  mutation_copy "$copy" "$2" "$3"
  GITHUB_ACTIONS='' TMPDIR="$root" control_run "$copy" "$1"
  assert_eq "$CONTROL_RC" 1 "mutant must fail the assertion in $1 ($CONTROL_ERR)"
  assert_eq "$CONTROL_OUT" "" "the mutated case must not report a pass"
  assert_contains "$CONTROL_ERR" "FAIL: $4" "the named case must fail for the intended reason"
}

# The refusal is matched WITH the name the file gives itself — "$LIB_BASENAME: REFUSING", not the
# bare word. Every refusal here opens with that prefix, and under a renamed copy the prefix is the
# copy's name, so this one line is what pins the LIB_BASENAME rendering in every refusal a control
# can reach: the early-definition guard, the shadow guard, and whatever refusal is added next.
# Matching only "REFUSING" left those prefixes free to be spelled again — with the literal restored
# in the early-definition refusal, the outer run and the renamed inner copy both passed all 19
# cases, so the copy control's PASS-list equality was asserting less than it claimed.
assert_refused() { # <msg>: the guard's refusal, with no case run
  assert_eq "$CONTROL_RC" 2 "$1: a refusal is exit 2 ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "$LIB_BASENAME: REFUSING" \
    "$1: the refusal should say so, under the name the file goes by"
  assert_not_contains "$CONTROL_OUT" "PASS:" "$1: no case may run under a refusal"
}

# The ludics-lite#46 shape itself: a reporter named `fail`, which is pr-review.sh's refusal path.
test_undeclared_shadow_is_refused() {
  control 'fail() { echo "FAIL: $*" >&2; exit 1; }'
  assert_refused "a suite-defined fail"
  assert_contains "$CONTROL_ERR" "pr-review.sh's fail (pr-review.sh:" "the owner and its line should be named"
  assert_contains "$CONTROL_ERR" "redefined at $CONTROL_FILE:4 without \`stub fail\`" \
    "the suite's definition should be located and the remedy named"
  assert_contains "$CONTROL_ERR" "ludics-lite#46" "the refusal should cite the trap"
}

# Every library function is protected, not a hand-picked list: a name that would corrupt results
# rather than exit codes is caught the same way, and so are two at once.
test_every_library_function_is_protected() {
  control 'jq_lf() { echo 0; }' 'py_forward() { echo 0; }'
  assert_refused "shadowed jq_lf and py_forward"
  assert_contains "$CONTROL_ERR" "pr-review.sh's jq_lf (" "jq_lf should be named"
  assert_contains "$CONTROL_ERR" "pr-review.sh's py_forward (" "py_forward should be named"
  assert_eq "$(grep -c 'redefined at' <<<"$CONTROL_ERR")" 2 "both shadows in one refusal"
}

# A suite may not quietly replace this file's helpers either.
test_lib_helpers_are_protected() {
  control 'assert_eq() { :; }'
  assert_refused "a redefined assert_eq"
  assert_contains "$CONTROL_ERR" "$LIB_BASENAME's assert_eq ($LIB_BASENAME:" \
    "the owner should be this file"
}

test_declared_stub_is_allowed() {
  control 'stub jq_lf' 'jq_lf() { echo 0; }'
  assert_eq "$CONTROL_RC" 0 "a declared stub runs ($CONTROL_ERR)"
  assert_contains "$CONTROL_OUT" "PASS: test_a_case" "the case should run"
  # The declaration may come after the definition too: the guard reads the table at run_tests.
  control 'cmd_merge() { :; }' 'cmd_checks() { :; }' 'stub cmd_merge cmd_checks'
  assert_eq "$CONTROL_RC" 0 "stubs declared after their definitions run ($CONTROL_ERR)"
}

test_stub_without_a_redefinition_is_refused() {
  control 'stub jq_lf'
  assert_refused "a stub never honoured"
  assert_contains "$CONTROL_ERR" "stub jq_lf is declared, but jq_lf is still pr-review.sh's" \
    "the stale declaration should be named"
}

test_stub_of_an_unknown_name_is_refused() {
  control 'stub no_such_function'
  assert_eq "$CONTROL_RC" 1 "an unknown stub is the reporter's exit 1 ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "stub no_such_function: neither pr-review.sh nor $LIB_BASENAME defines no_such_function" \
    "the unknown name should be named"
  assert_not_contains "$CONTROL_OUT" "PASS:" "no case may run"
}

# The suite's own functions are its business: a fixture gh and helpers of any other name pass.
test_own_functions_pass() {
  control 'gh() { gh_fixture_parse "$@"; gh_fixture_answer "{}"; }' 'helper_of_my_own() { :; }'
  assert_eq "$CONTROL_RC" 0 "a suite with only its own functions runs ($CONTROL_ERR)"
  assert_contains "$CONTROL_OUT" "PASS: test_a_case" "the case should run"
  # And still when the ENVIRONMENT exported a function of the same name in. Bash records an
  # inherited function with no defining file, so a snapshot taken whole protected it and the
  # suite's own fixture `gh` read as a redefinition of it: every suite refused, from a shell that
  # merely had `gh` exported, with "(null)'s gh ((null):0) is redefined at …". The exporting shell
  # is a file of its own because `export -f` carries the definition's file and line with it.
  local exporter="$CONTROL_ROOT/exporter-gh.sh"
  {
    echo 'gh() { echo "an inherited gh"; }'
    echo 'export -f gh'
    printf 'exec bash %s\n' "\"$CONTROL_FILE\""
  } >"$exporter"
  control_run "$exporter"
  assert_eq "$CONTROL_RC" 0 "an inherited gh must not make the suite's own fixture a shadow ($CONTROL_ERR)"
  assert_contains "$CONTROL_OUT" "PASS: test_a_case" "the case should run"
  assert_not_contains "$CONTROL_ERR" "REFUSING" "and nothing should be refused"
}

test_definitions_before_sourcing_are_refused() {
  local file
  file="$CONTROL_ROOT/early.sh"
  {
    echo 'set -euo pipefail'
    echo 'early() { :; }'
    printf 'source %s\n' "\"$TEST_LIB_FILE\""
    echo 'run_tests early -- "$@"'
  } >"$file"
  control_run "$file"
  assert_refused "a function defined before the source"
  assert_contains "$CONTROL_ERR" "defined functions before sourcing this file (early)" \
    "the early definition should be named"
  # A function the ENVIRONMENT exported into the suite's shell is not the suite defining one, and
  # refusing it made every suite unrunnable from such a shell. The exporting shell is a file of its
  # own, because `export -f` carries the definition's file and line with it and defining these here
  # would attribute them to this file. One of the two is `fail` deliberately — the ludics-lite#46
  # name — to pin that an inherited library name is not a shadow either: pr-review.sh's own
  # definition replaces it when the preamble sources it, which is what the snapshot then records.
  local exporter="$CONTROL_ROOT/exporter.sh"
  control 'helper_of_my_own() { :; }'
  {
    echo 'fail() { echo "an inherited fail"; }'
    echo 'inherited_helper() { :; }'
    echo 'export -f fail inherited_helper'
    printf 'exec bash %s\n' "\"$CONTROL_FILE\""
  } >"$exporter"
  control_run "$exporter"
  assert_eq "$CONTROL_RC" 0 "an exported function in the environment must not refuse a suite ($CONTROL_ERR)"
  assert_contains "$CONTROL_OUT" "PASS: test_a_case" "the case should run"
  assert_not_contains "$CONTROL_ERR" "REFUSING" "and nothing should be refused"
}

# test_tmpdir writes to the CALLER's variable, whatever it is named — including `dir`, the name
# the function itself once held its scratch value in (ludics-lite#79). The target is pre-set, so
# the silent half of the trap is covered too: the caller's stale value must not survive, and the
# path that comes back must be the one registered for removal, in the caller's shell.
test_tmpdir_writes_to_a_target_named_dir() {
  local path pid
  control 'dir=stale' \
    'test_tmpdir dir tmpdir-target' \
    'printf "target=%s\n" "$dir"' \
    '[ -d "$dir" ] || bail "test_tmpdir did not return a directory: $dir"' \
    '[ "${TEST_CLEANUP[0]}" = "$dir" ] || bail "registered ${TEST_CLEANUP[0]}, returned $dir"'
  assert_eq "$CONTROL_RC" 0 "a caller's variable named dir is written ($CONTROL_ERR)"
  path=$(sed -n 's/^target=//p' <<<"$CONTROL_OUT")
  assert_not_contains "$path" stale "the caller's prior value must not survive the call"
  assert_contains "$path" ".tmpdir-target." "the label should still reach the caller's directory name"
  # And the owning pid, read back with the very parse `watch`'s tmp_sweep_stale uses on it:
  # a scratch directory whose name does not carry a pid cannot be told from a live sibling's, and
  # so is collectable by nothing at all once the suite that made it is killed (ludics-lite#219).
  # Pinning the SHAPE here rather than in prose is what stops the label-only spelling coming back.
  pid=${path##*/pr-review-test.}
  pid=${pid%%.*}
  case "$pid" in '' | *[!0-9]*)
    bail "the scratch directory should be keyed by the owning pid, so a killed suite's is swept: $path" ;;
  esac
  [ ! -d "$path" ] || bail "the control left $path behind: the registration did not reach its shell"
}

# The two names it cannot get out of the way of are refused by name rather than written past.
test_tmpdir_refuses_a_name_it_uses() {
  control 'test_tmpdir __test_tmpdir_path tmpdir-own-local'
  assert_eq "$CONTROL_RC" 1 "its own local as the target is the reporter's exit 1 ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" 'refusing to write the path into $__test_tmpdir_path' \
    "the refusal should name the variable asked for"
  assert_not_contains "$CONTROL_OUT" "PASS:" "no case may run"
  control 'test_tmpdir TEST_CLEANUP tmpdir-cleanup-list'
  assert_eq "$CONTROL_RC" 1 "the cleanup list as the target is refused too ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" 'refusing to write the path into $TEST_CLEANUP' \
    "the refusal should name the cleanup list"
}

# What the forward writes, it removes. A sourced call with a fixture `gh` goes through the shell
# bridge, whose file of this shell's state sits in TMPDIR while the Python runs; nothing traps for
# it (see the second guard above), so the forward removes it itself, on the Python's success and
# on its failure alike, before the stub returns or exits. Both are run in a TMPDIR of the case's own
# and the TMPDIR must be empty after each -- which is ludics-lite#191's leak, measured directly, for
# the one temporary the script still makes. The control proves the assertion can fail: a copy of
# pr-review.sh without the removal leaves the file behind.
#
# A forward needs the checkout around pr-review.sh (scripts/py, lib/), which a copy of this file
# beside a bare pr-review.sh does not have; so the renamed copy's inner run leaves this case to the
# run that started it, as it leaves the copy control.
test_the_forward_leaves_nothing_in_tmpdir() {
  local root tmp bare
  [ -z "$LIB_INNER_RUN" ] || return 0
  test_tmpdir root forward-cleanup
  tmp="$root/tmpdir"
  mkdir "$tmp"
  control 'gh() { echo "{\"ok\":1}"; }' \
    'test_forward() {' \
    '  cmd_retry api repos/o/n/thing >/dev/null' \
    '  local rc=0' \
    '  (cmd_reply not-a-pr 1 body) 2>/dev/null || rc=$?' \
    '  assert_eq "$rc" 2 "a refused call is the Python exit, carried"' \
    '}' \
    'test_forward'
  assert_eq "$CONTROL_RC" 0 "a forward through the bridge should run, both ways ($CONTROL_ERR)"
  # That ran under the suite's own TMPDIR; again, under one of this case's own.
  TMPDIR="$tmp" control_run "$CONTROL_FILE"
  assert_eq "$CONTROL_RC" 0 "the forward should run under a TMPDIR of its own ($CONTROL_ERR)"
  assert_eq "$(find "$tmp" -mindepth 1 -print | tr '\n' ' ')" "" \
    "the bridge file must be gone once the forward returns or exits"
  # The control: a checkout copy whose forward never removes the file. A copy of the checkout's
  # layout, so the copy's scripts/py and lib are found where the forward looks for them.
  bare="$root/checkout"
  mkdir -p "$bare/ship-pr/scripts" "$bare/scripts"
  cp "$HELPER" "$TEST_LIB_FILE" "$bare/ship-pr/scripts/"
  cp -p "$TEST_LIB_DIR/../../scripts/py" "$bare/scripts/"
  cp -pR "$TEST_LIB_DIR/../../lib" "$bare/"
  perl -0777 -i -pe 'my $n = s/\n    rm -f "\$state"\n/\n/; die "expected one removal to delete, found $n\n" unless $n == 1' \
    "$bare/ship-pr/scripts/pr-review.sh"
  cp "$CONTROL_FILE" "$bare/ship-pr/scripts/control.sh"
  perl -0777 -i -pe 's/^source .*$/source "\$(dirname "\$0")\/'"$LIB_BASENAME"'"/m' "$bare/ship-pr/scripts/control.sh"
  rm -rf "$tmp" && mkdir "$tmp"
  TMPDIR="$tmp" control_run "$bare/ship-pr/scripts/control.sh"
  assert_eq "$CONTROL_RC" 0 "control: the copy should run as the original does ($CONTROL_ERR)"
  assert_contains "$(find "$tmp" -mindepth 1 -print)" "/pr-review-bridge." \
    "control: without the removal the bridge file is left behind, so the assertion above can fail"
  rm -rf "$tmp"
}

# And the guard that keeps the script trapless. A trap added back to pr-review.sh would be replaced
# by this file's own and never run in a suite, so it is refused, inline body or named function.
test_a_trap_in_pr_review_sh_is_refused() {
  local root line
  test_tmpdir root trap-guard
  for line in 'trap '\''rm -f "$TMPDIR/x"'\'' EXIT' 'some_cleanup() { :; }; trap some_cleanup EXIT'; do
    cp "$HELPER" "$TEST_LIB_FILE" "$root/"
    NEW="$line" perl -0777 -i -pe 'my $n = s/^(\[ "\$\{SHIP_PR_TEST_SOURCE_ONLY:-\}" = 1 \] \|\| main "\$@")$/$ENV{NEW}\n$1/m; die "expected one foot line, found $n\n" unless $n == 1' "$root/pr-review.sh"
    control_in "$root"
    assert_refused "an EXIT trap in pr-review.sh ($line)"
    assert_contains "$CONTROL_ERR" "sourcing pr-review.sh installed an EXIT trap" "the trap should be named"
    assert_contains "$CONTROL_ERR" "ludics-lite#195" "the refusal should cite the trap it exists against"
  done
}

# The parser the api-only suites share, pinned once: the endpoint, the filter, the pagination
# flag, and the two logs.
test_gh_fixture_parse() {
  local log="$CONTROL_ROOT/req" plog="$CONTROL_ROOT/pag" out
  REQUEST_LOG="$log"
  PAGINATE_LOG="$plog"
  : >"$log"
  : >"$plog"
  gh_fixture_parse api --paginate repos/o/n/thing --jq '.a' -X GET
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "the first non-option argument is the endpoint"
  assert_eq "$FIXTURE_FILTER" .a "the --jq filter is kept"
  assert_eq "$FIXTURE_PAGINATE" 1 "--paginate is noted"
  assert_eq "$(cat "$log")" repos/o/n/thing "the endpoint is logged"
  assert_eq "$(cat "$plog")" repos/o/n/thing "a paginated read is logged as such"
  out=$(gh_fixture_answer '{"a":"x"}')
  assert_eq "$out" x "the answer goes through the filter"
  # A write: the method's value is not the endpoint, and neither is a field's.
  gh_fixture_parse api -X POST repos/o/n/thing/replies -f body=hello --jq .html_url
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing/replies "-X POST does not become the endpoint"
  assert_eq "$FIXTURE_FILTER" .html_url "the filter still parses after an option with a value"
  gh_fixture_parse api -f query=q graphql
  assert_eq "$FIXTURE_ENDPOINT" graphql "nor does a field's value, wherever the endpoint sits"
  gh_fixture_parse api repos/o/n/other
  assert_eq "$FIXTURE_FILTER" "" "no filter without --jq"
  assert_eq "$FIXTURE_INCLUDE" "" "no header block without --include"
  assert_eq "$FIXTURE_PAGINATE" "" "not paginated without the flag"
  assert_eq "$(cat "$plog")" repos/o/n/thing "an unpaginated read is not logged as paginated"
  out=$(gh_fixture_answer '{"a":"x"}')
  assert_eq "$out" '{"a":"x"}' "the raw answer without a filter"
  set +e
  out=$(gh_fixture_parse pr merge 2>&1)
  assert_eq "$?" 1 "a non-api call is refused"
  set -e
  assert_contains "$out" "fixture received non-api gh call: pr merge" "the call should be quoted"
  REQUEST_LOG=""
  PAGINATE_LOG=""
}

# The option table, exercised in every spelling pflag accepts. Each case here is a form one of
# the two guessing lists parsed wrongly and silently.
test_gh_fixture_parse_knows_gh_s_option_table() {
  # A value that looks like a REST path (#102 round 1), and the four other value options #86's
  # list had missed.
  gh_fixture_parse api --input fixtures/body.json repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "a path-shaped option value is not the endpoint"
  gh_fixture_parse api --cache 5m --hostname github.com -t '{{.x}}' -p nebula repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "nor a duration, a host, a template or a preview"
  # The booleans, which must not consume what follows them — in either position.
  # (Two calls, as gh allows one output mode per call and --slurp only under --paginate.)
  gh_fixture_parse api -i --silent --allow-escape-sequences repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "a boolean does not consume the endpoint"
  gh_fixture_parse api --paginate --slurp --verbose repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "nor do --paginate, --slurp and --verbose"
  gh_fixture_parse api repos/o/n/thing --include --jq .a
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "nor when it stands after the endpoint"
  assert_eq "$FIXTURE_INCLUDE" 1 "--include is noted, so the answer carries the header block"
  assert_eq "$FIXTURE_FILTER" .a "and it does not swallow the option after it (#102 round 2)"
  # The filter in every spelling gh accepts: separated long and short, and each attached form.
  gh_fixture_parse api repos/o/n/thing -q .a
  assert_eq "$FIXTURE_FILTER" .a "-q is --jq"
  gh_fixture_parse api --jq=.b repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "--jq=<filter> consumes nothing further"
  assert_eq "$FIXTURE_FILTER" .b "--jq=<filter> is the filter"
  gh_fixture_parse api repos/o/n/thing -q.c
  assert_eq "$FIXTURE_FILTER" .c "an attached short value is the filter (#102 round 2)"
  gh_fixture_parse api repos/o/n/thing -q=.d
  assert_eq "$FIXTURE_FILTER" .d "so is one attached with an ="
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "and neither attached form loses the endpoint"
  gh_fixture_parse api --cache=5m repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "nor does any other inline-value long option"
  # `--` ends option parsing: what follows is the endpoint, and is not consumed as a value
  # (#102 round 2).
  gh_fixture_parse api -- repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "-- is the end of options, not an option"
  gh_fixture_parse api --jq .a -- repos/o/n/thing
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "options before -- still parse"
  assert_eq "$FIXTURE_FILTER" .a "and their values are still read"
}

# What a request carries, for a fixture asserting on a write: the method gh sends (its default
# when none is named), the body and query fields, and the kind of field the body came as.
test_gh_fixture_parse_records_the_request() {
  gh_fixture_parse api repos/o/n/thing
  assert_eq "$FIXTURE_METHOD" GET "no field and no method is gh's GET"
  gh_fixture_parse api repos/o/n/thing -f body=hi
  assert_eq "$FIXTURE_METHOD" POST "a field makes gh's default a POST"
  assert_eq "$FIXTURE_BODY $FIXTURE_BODY_KIND" "hi raw" "-f is a raw field"
  gh_fixture_parse api -Xpatch /repos/o/n/thing --field=body=@f.md -F query=q
  assert_eq "$FIXTURE_METHOD" PATCH "a named method, uppercased as gh sends it"
  assert_eq "$FIXTURE_ENDPOINT" repos/o/n/thing "and a leading slash is the same endpoint"
  assert_eq "$FIXTURE_BODY $FIXTURE_BODY_KIND $FIXTURE_QUERY" "@f.md typed q" "-F is a typed field"
  gh_fixture_parse api repos/o/n/thing --input b.json -f body=hi
  assert_eq "$FIXTURE_BODY_KIND" input "--input replaces the body, whatever the fields say"
  gh_fixture_parse api graphql --paginate -X POST -f query=q
  assert_eq "$FIXTURE_METHOD" POST "graphql paginates over POST, as gh allows"
  gh_fixture_parse api repos/o/n/thing --jq .a -q .b
  assert_eq "$FIXTURE_FILTER" .b "a repeated filter is gh's last-one-wins, not a conflict"
}

# The calls gh itself refuses before sending anything (each probed against gh 2.101.0). Answering
# one would be answering a request production cannot make.
test_gh_fixture_parse_refuses_what_gh_refuses() {
  local call out
  for call in "repos/o/n/thing -X" "repos/o/n/thing --jq .a --silent" "repos/o/n/thing -t x --verbose" \
    "repos/o/n/thing --slurp" "repos/o/n/thing --paginate --slurp --jq .a" \
    "repos/o/n/thing --paginate --input b.json" "repos/o/n/thing --paginate -X POST" \
    "repos/o/n/thing -f body=a -f body=b" "repos/o/n/thing -f nobody" \
    "repos/o/n/thing -f body[]=a" "repos/o/n/thing -f items[]"; do
    set +e
    # shellcheck disable=SC2086 # one call, split into its words
    out=$(gh_fixture_parse api $call 2>&1)
    assert_eq "$?" 1 "'gh api $call' is refused"
    set -e
    assert_contains "$out" "gh api $call" "and the refusal quotes the call"
  done
}

# What the table refuses. Every one of these was parsed, wrongly and in silence, by one of the
# two lists that guessed at the options they did not name.
test_gh_fixture_parse_refuses_what_it_cannot_parse() {
  local log="$CONTROL_ROOT/guard-req" out
  REQUEST_LOG="$log"
  : >"$log"
  # An option the table lacks, in the position where assuming it carries a value swallows the
  # endpoint...
  set +e
  out=$(gh_fixture_parse api --future-option repos/o/n/thing 2>&1)
  assert_eq "$?" 1 "an option the table lacks is refused before the endpoint"
  set -e
  assert_contains "$out" "does not know the gh api option --future-option" "the option should be named"
  assert_contains "$out" "gh api --future-option repos/o/n/thing" "the whole call should be quoted"
  assert_contains "$out" "FIXTURE_GH_BOOLS or FIXTURE_GH_VALUED" "the fix should be named"
  # ...and in the position where it leaves the endpoint intact and swallows the NEXT option
  # instead, which is the round-2 shape and the one no guard on the endpoint can see.
  set +e
  out=$(gh_fixture_parse api repos/o/n/thing --future-option --jq .a 2>&1)
  assert_eq "$?" 1 "an option the table lacks is refused after the endpoint too"
  set -e
  assert_contains "$out" "does not know the gh api option --future-option" "the option should be named"
  # A boolean carrying an inline value, and a bundle of shorts, are the same unparseable word.
  set +e
  out=$(gh_fixture_parse api --paginate=false repos/o/n/thing 2>&1)
  assert_eq "$?" 1 "a boolean with an inline value is refused"
  set -e
  assert_contains "$out" "cannot parse '--paginate=false'" "the word should be quoted"
  assert_contains "$out" "write them apart" "the fix should be named"
  set +e
  out=$(gh_fixture_parse api -iq .a repos/o/n/thing 2>&1)
  assert_eq "$?" 1 "bundled short options are refused"
  set -e
  assert_contains "$out" "cannot parse '-iq'" "the bundle should be quoted"
  # `gh api` takes exactly one positional. A second is a call the CLI refuses outright, so
  # answering it would be answering a request production cannot send — and round 2's own control
  # had pinned this very invocation as valid (round 3).
  set +e
  out=$(gh_fixture_parse api -- repos/o/n/thing --paginate 2>&1)
  assert_eq "$?" 1 "a second positional is refused, even past --"
  set -e
  assert_contains "$out" "received 2 positional arguments" "the count should be named"
  assert_contains "$out" "accepts 1 arg(s), received 2" "the CLI's own refusal should be quoted"
  set +e
  out=$(gh_fixture_parse api repos/o/n/thing repos/o/n/other 2>&1)
  assert_eq "$?" 1 "two endpoints are refused without a -- in sight"
  set -e
  assert_contains "$out" "received 2 positional arguments" "the count should be named"
  # `--help` is an ACTION: gh prints its help and makes no request, so no answer is the right one
  # (round 3). Refused from either side of the endpoint.
  set +e
  out=$(gh_fixture_parse api --help repos/o/n/thing 2>&1)
  assert_eq "$?" 1 "--help before the endpoint is refused"
  set -e
  assert_contains "$out" "fixture received --help" "the flag should be named"
  assert_contains "$out" "made no request" "why no answer can be right should be stated"
  set +e
  out=$(gh_fixture_parse api repos/o/n/thing --help 2>&1)
  assert_eq "$?" 1 "--help after the endpoint is refused too"
  set -e
  assert_contains "$out" "fixture received --help" "the flag should be named"
  # The shape guard under it all: a word that is no endpoint, and no endpoint at all.
  set +e
  out=$(gh_fixture_parse api POST 2>&1)
  assert_eq "$?" 1 "a word that is not an endpoint is refused"
  set -e
  assert_contains "$out" "fixture parsed 'POST' as the endpoint" "the bad endpoint should be named"
  set +e
  out=$(gh_fixture_parse api --paginate 2>&1)
  assert_eq "$?" 1 "an api call with no endpoint is refused"
  set -e
  assert_contains "$out" "fixture parsed '' as the endpoint" "the empty endpoint should be named"
  assert_eq "$(cat "$log")" "" "a refused call is not logged"
  REQUEST_LOG=""
}

# --- SHIP_PR_TEST_CASES: a subset, and only ever a visible one -------------------------------
# subset_suite <line>...: a throwaway suite of three cases, with the given lines above its
# `run_tests`, written to CONTROL_FILE and run through control_run with no arguments. Each case
# asserts the variable is gone by the time it runs, which is what keeps a case's own throwaway
# suites from inheriting the outer list. The lines unset GITHUB_ACTIONS themselves where they need
# to: CI runs this file with it set.
subset_suite() {
  local file="$CONTROL_ROOT/subset-$((CONTROL_N += 1)).sh" name
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'source %s\n' "\"$TEST_LIB_FILE\""
    for name in test_one test_two test_three; do
      echo "$name() { assert_eq \"\${SHIP_PR_TEST_CASES-unset}\" unset 'the list is consumed before a case runs'; }"
    done
    printf '%s\n' "$@"
    echo 'run_tests test_one test_two test_three -- "$@"'
  } >"$file"
  CONTROL_FILE="$file"
  control_run "$file"
}

test_a_subset_runs_the_cases_it_names_and_says_so() {
  subset_suite 'unset GITHUB_ACTIONS' 'SHIP_PR_TEST_CASES=" test_three   test_one "'
  assert_eq "$CONTROL_RC" 0 "a subset of known names runs ($CONTROL_ERR)"
  # The suite's order, not the list's; and the closing line a full run never prints.
  assert_eq "$CONTROL_OUT" "PASS: test_one
PASS: test_three
SUBSET: 2 of 3 cases" "only the named cases run, in the suite's order, and the run says it was partial"
  subset_suite 'unset GITHUB_ACTIONS' 'SHIP_PR_TEST_CASES=" "'
  assert_eq "$CONTROL_OUT" "PASS: test_one
PASS: test_two
PASS: test_three" "a list naming nothing is a full run, with no SUBSET line ($CONTROL_ERR)"
}

test_a_subset_naming_a_case_the_suite_lacks_is_refused() {
  subset_suite 'unset GITHUB_ACTIONS' 'SHIP_PR_TEST_CASES="test_one test_tow"'
  assert_refused "a misspelt case"
  assert_contains "$CONTROL_ERR" "does not run: test_tow —" "the unknown name should be named, alone"
}

# The PR #415 shape: a case defined inside another case's body. The full run used to pass — the
# outer case defined the inner one before its turn — while a subset naming the inner case alone
# could not select it. Both are refused now, before any case runs.
# two_case_suite <definition>...: a throwaway suite running test_outer and test_inner, with the
# given definitions above its `run_tests`, written to CONTROL_FILE.
two_case_suite() {
  CONTROL_FILE="$CONTROL_ROOT/two-cases-$((CONTROL_N += 1)).sh"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'source %s\n' "\"$TEST_LIB_FILE\""
    printf '%s\n' "$@"
    echo 'unset GITHUB_ACTIONS'
    echo 'run_tests test_outer test_inner -- "$@"'
  } >"$CONTROL_FILE"
}

test_a_case_that_is_not_a_function_is_refused() {
  local list
  two_case_suite 'test_outer() { test_inner() { :; }; }'
  for list in '' test_inner; do
    SHIP_PR_TEST_CASES=$list control_run "$CONTROL_FILE"
    assert_refused "a nested case (SHIP_PR_TEST_CASES='$list')"
    assert_contains "$CONTROL_ERR" "not defined functions: test_inner —" \
      "the undefined case should be named, alone ($list)"
  done
  # The control: the same two cases, both at the top level, run whole.
  two_case_suite 'test_outer() { :; }' 'test_inner() { :; }'
  control_run "$CONTROL_FILE"
  assert_eq "$CONTROL_RC" 0 "top-level cases run ($CONTROL_ERR)"
  assert_eq "$CONTROL_OUT" "PASS: test_outer
PASS: test_inner" "both cases run once the inner one is defined at the top level"
}

test_a_subset_under_ci_is_refused() {
  subset_suite 'GITHUB_ACTIONS=true' 'SHIP_PR_TEST_CASES=test_one'
  assert_refused "a subset in CI"
  assert_contains "$CONTROL_ERR" "under GITHUB_ACTIONS=true" "the refusal should say why"
  # And CI's full run is untouched by the refusal: no list, no SUBSET line, every case.
  subset_suite 'GITHUB_ACTIONS=true'
  assert_eq "$CONTROL_OUT" "PASS: test_one
PASS: test_two
PASS: test_three" "a full run in CI runs every case ($CONTROL_ERR)"
}

# --- cases named on the command line --------------------------------------------------------
# `bash test-pr-review-base-verdict.sh <case>` used to run the whole suite: run_tests saw only the
# suite's own register, and the argument was dropped without a word. Each suite now hands
# run_tests its arguments after `--`, and a name there selects exactly as SHIP_PR_TEST_CASES does.
test_cases_named_on_the_command_line_select_like_the_list() {
  subset_suite 'unset GITHUB_ACTIONS'
  control_run "$CONTROL_FILE" test_three test_one
  assert_eq "$CONTROL_RC" 0 "a subset named on the command line runs ($CONTROL_ERR)"
  assert_eq "$CONTROL_OUT" "PASS: test_one
PASS: test_three
SUBSET: 2 of 3 cases" "only the named cases run, in the suite's order, and the run says it was partial"
  control_run "$CONTROL_FILE" test_one test_tow
  assert_refused "a misspelt case on the command line"
  assert_contains "$CONTROL_ERR" "the command line names what this suite does not run: test_tow —" \
    "the unknown name should be named, alone, with where it came from"
  # An argument is one name, compared whole: a space-joined match would take it for two.
  control_run "$CONTROL_FILE" "test_one test_two"
  assert_refused "two names in one argument"
  assert_contains "$CONTROL_ERR" 'does not run: test_one\ test_two —' "the argument should be named as given"
  SHIP_PR_TEST_CASES=test_two control_run "$CONTROL_FILE" test_one
  assert_refused "a name in each place"
  assert_contains "$CONTROL_ERR" "(test_one) and in SHIP_PR_TEST_CASES (test_two) — name them one way" \
    "both lists should be named"
  subset_suite 'GITHUB_ACTIONS=true'
  control_run "$CONTROL_FILE" test_one
  assert_refused "a subset named on the command line in CI"
  assert_contains "$CONTROL_ERR" "the command line asks for a subset (test_one) under GITHUB_ACTIONS=true" \
    "the refusal should say why"
}

# The forward is not left to discipline: a suite that calls run_tests without `--` is refused
# whether or not it was given arguments, so the next suite cannot drop them the old way.
test_a_suite_that_does_not_forward_its_arguments_is_refused() {
  local file="$CONTROL_ROOT/no-forward.sh" args
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'source %s\n' "\"$TEST_LIB_FILE\""
    echo 'test_one() { :; }'
    echo 'run_tests test_one'
  } >"$file"
  for args in '' test_one; do
    # shellcheck disable=SC2086 # no argument at all, then one
    control_run "$file" $args
    assert_refused "a run_tests call without -- (arguments: '$args')"
    assert_contains "$CONTROL_ERR" "run_tests was not handed the suite's arguments — end the call with \`-- \"\$@\"\`" \
      "the refusal should name the remedy ($args)"
  done
}

# --- a jq that writes CRLF (ludics-lite#335) ---------------------------------------------------
# A native jq.exe's text mode ends every line CRLF, and four suites went red under Git Bash on the
# \r. These hold pr-review.sh's `jq_lf` to reading any jq back LF, on every platform, through the
# CRLF stub in both of its modes; the Git Bash leg adds the real jq.exe as the jq on PATH.
#
# Every read is judged in BYTES, through a pipe into `od`, never by comparing a `$(...)`: Git
# Bash's command substitution drops a trailing \r with the \n, so there a `$(...)` of a CRLF jq's
# one-line answer reads clean, and an assertion shaped that way passes over the defect it is for.
# Each read re-probes in its own subshell, so neither the stub's PATH nor its JQ_EOL outlives it.
od_bytes() { od -An -c | tr -d ' \n'; } # stdin as od -c spells it, `x\r\n` for x CR LF

jq_under_stub() { # <stub dir> <jq args...>: pr-review.sh's jq, re-probed with the stub first
  local dir="$1"
  shift
  PATH="$dir:$PATH"
  jq_eol_probe
  jq "$@"
}

test_a_crlf_jq_is_read_back_lf() {
  local mode want dir out rc
  assert_eq "$(jq -rn '"x"' | od_bytes)" 'x\n' "the jq on PATH should read back LF as sourced (JQ_EOL=$JQ_EOL)"
  for mode in binary no-binary; do
    test_tmpdir dir "jq-$mode"
    jq_crlf_stub "$dir" "$mode"
    # The control's own control: a stub that writes LF would make every assertion below vacuous.
    assert_eq "$(PATH="$dir:$PATH" command jq -rn '"x"' | od_bytes)" 'x\r\n' "the $mode stub should write CRLF"
    want=binary
    [ "$mode" = binary ] || want=strip
    assert_eq "$(PATH="$dir:$PATH" && jq_eol_probe && printf '%s' "$JQ_EOL")" "$want" \
      "a CRLF jq in $mode mode should probe as $want"
    assert_eq "$(jq_under_stub "$dir" -r .c <<<'{"c":"failure"}' | od_bytes)" 'failure\n' \
      "$mode: a conclusion should read back without its \\r, or it is not red"
    assert_eq "$(jq_under_stub "$dir" -r '.[]' <<<'["a","b"]' | od_bytes)" 'a\nb\n' \
      "$mode: every line should lose its \\r, not only the last"
    # A CRLF inside a raw string: `-b` keeps it as the data it is, and the strip takes it to LF
    # with the rest (pr-review.sh says why that is the price of the strip path).
    want='one\r\ntwo\n'
    [ "$mode" = binary ] || want='one\ntwo\n'
    assert_eq "$(jq_under_stub "$dir" -r .b <<<'{"b":"one\r\ntwo"}' | od_bytes)" "$want" \
      "$mode: a CRLF inside a raw string"
    rc=0
    (jq_under_stub "$dir" -e .c <<<'{"c":false}' >/dev/null) || rc=$?
    assert_eq "$rc" 1 "$mode: jq's own status should reach the caller"
    # pr-review.sh's own `jq`, sourced alone in a fresh bash, under the stub from the start, as a
    # Windows user runs it.
    out=$(PATH="$dir:$PATH" SHIP_PR_TEST_SOURCE_ONLY=1 bash -c '. "$1" && jq -r .c' _ "$HELPER" <<<'{"c":"failure"}' | od_bytes)
    assert_eq "$out" 'failure\n' "$mode: pr-review.sh's own jq, sourced alone, should read back LF"
  done
}

# The knob CI runs whole suites under: each mode probes as the jq it stands for, and the suite's
# own reads come back LF; a value it does not know is refused rather than run as an LF suite.
# Byte counts, for the reason above: 3 is x CR LF, 2 is x LF.
test_the_crlf_knob_runs_a_suite_over_the_stub() {
  local knob want
  for knob in crlf crlf-no-binary; do
    want=binary
    [ "$knob" = crlf ] || want=strip
    SHIP_PR_TEST_JQ_EOL="$knob" control 'printf "eol=%s\n" "$JQ_EOL"' \
      '[ "$(($(command jq -rn "\"x\"" | wc -c)))" = 3 ] || bail "the stub is not the jq on PATH"' \
      '[ "$(($(jq -rn "\"x\"" | wc -c)))" = 2 ] || bail "a read came back with its CR"'
    assert_eq "$CONTROL_RC" 0 "SHIP_PR_TEST_JQ_EOL=$knob should run the suite ($CONTROL_ERR)"
    assert_contains "$CONTROL_OUT" "eol=$want" "SHIP_PR_TEST_JQ_EOL=$knob should probe as $want"
    assert_contains "$CONTROL_OUT" "PASS: test_a_case" "and the case should run"
  done
  SHIP_PR_TEST_JQ_EOL=crlf-typo control
  assert_refused "an unknown SHIP_PR_TEST_JQ_EOL"
  assert_contains "$CONTROL_ERR" "not 'crlf-typo'" "the value should be named"
}

# --- protecting a second library ---------------------------------------------------------------
# The guard's snapshot is taken while this file is sourced, so a library sourced AFTER it — the
# base suites' shared fixture transport — is outside it until `protect_library` says otherwise.
# `extra_control <redefinition...>` builds that situation: a second library beside the throwaway
# suite, protecting itself the way the real one does, and a suite that sources it and then does
# whatever the caller passes.
extra_control() {
  local dir="$CONTROL_ROOT/extra"
  mkdir -p "$dir"
  {
    echo 'extra_helper() { echo library; }'
    echo 'protect_library "${BASH_SOURCE[0]}"'
  } >"$dir/extra-lib.sh"
  control "source \"$dir/extra-lib.sh\"" "$@"
}

# The shape the base transport was in when the review found it: its helpers outside the snapshot,
# so a suite could replace one and `run_tests` would accept it.
test_a_second_library_is_protected_once_it_says_so() {
  extra_control
  assert_eq "$CONTROL_RC" 0 "a suite over a second library still runs ($CONTROL_ERR)"
  assert_eq "$CONTROL_OUT" "PASS: test_a_case" "and its case passes"

  extra_control 'extra_helper() { echo suite; }'
  assert_refused "a suite-defined extra_helper"
  assert_contains "$CONTROL_ERR" "extra-lib.sh's extra_helper (extra-lib.sh:" \
    "the second library is named by its basename, like the other two"
  assert_contains "$CONTROL_ERR" "redefined at $CONTROL_FILE:" "and the suite's line is located"

  # And the declaration works over it, so a deliberate override is still available.
  extra_control 'stub extra_helper' 'extra_helper() { echo suite; }'
  assert_eq "$CONTROL_RC" 0 "a declared stub of the second library's function is allowed ($CONTROL_ERR)"
}

# A library that protects nothing is refused rather than passing: the whole value of the call is
# the names it adds, and a path that matches no record — a resolved one, say, where the shell
# recorded the path it was sourced through — adds none and would look exactly like success.
test_protect_library_refuses_a_file_that_defines_nothing() {
  control 'protect_library "/nowhere/not-a-library.sh"'
  assert_eq "$CONTROL_RC" 1 "a file defining nothing must refuse ($CONTROL_OUT)"
  assert_contains "$CONTROL_ERR" "protect_library: /nowhere/not-a-library.sh defines no function" \
    "the refusal should name the file"
  assert_not_contains "$CONTROL_OUT" "PASS:" "and no case may run under it"
}

# --- retune, and the restore no case performs itself -------------------------------------------
# The values pr-review.sh gave the two constants when this file sourced it, read once so the pair
# below asserts against the script's own defaults rather than a number copied out of it.
GRACE_AS_SOURCED="$GRACE"
ABSENT_GRACE_AS_SOURCED="$ABSENT_GRACE"

test_retune_moves_a_constant() {
  assert_eq "$GRACE" "$GRACE_AS_SOURCED" "the case starts from the grace pr-review.sh was sourced with"
  retune GRACE=1 ABSENT_GRACE=0
  assert_eq "$GRACE" 1 "the grace this case runs under"
  assert_eq "$ABSENT_GRACE" 0 "and a second constant in the same call"
  # Twice over, which is what a case with a control in it does: the saved value is still the one
  # pr-review.sh set, not the 1 above — restoring to that would leak the case's own clock.
  retune GRACE=2
  assert_eq "$GRACE" 2 "the second move takes"
  # A case may put them back mid-case; the next case proves it need not.
  restore_tuning
  assert_eq "$GRACE" "$GRACE_AS_SOURCED" "restore_tuning returns the value as sourced, not the first move"
  assert_eq "$ABSENT_GRACE" "$ABSENT_GRACE_AS_SOURCED" "and every name it held, not only the last moved"
  # BOTH are left moved, with nothing here restoring them, because the next case is judged on what
  # run_tests restores by itself. Leaving only GRACE moved — which this case used to do, the second
  # constant having been put back by the restore_tuning above — made that case's ABSENT_GRACE
  # assertion green whatever run_tests did with it, so it could not tell a restore of ONE retuned
  # constant from a restore of all of them.
  retune GRACE=3 ABSENT_GRACE=9
  assert_eq "$GRACE" 3 "and retuning again after a restore still works"
  assert_eq "$ABSENT_GRACE" 9 "for every name, so the case after this one has two to check"
}

# Listed immediately after the case above, and reading what that case left behind: nothing there
# restored GRACE=3 or ABSENT_GRACE=0, so anything but the sourced values here is the leak.
test_retune_is_undone_when_the_case_ends() {
  assert_eq "$GRACE" "$GRACE_AS_SOURCED" "run_tests restored the grace the case before it moved"
  assert_eq "$ABSENT_GRACE" "$ABSENT_GRACE_AS_SOURCED" "and every other constant that case moved"
}

# A typo would otherwise invent a variable pr-review.sh never reads, and the case would pass while
# running under the untouched constant it meant to move.
test_retune_of_a_name_the_script_does_not_set_is_refused() {
  control 'retune GARCE=1'
  assert_eq "$CONTROL_RC" 1 "an unknown constant is the reporter's exit 1 ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "retune GARCE: pr-review.sh sets no GARCE when it is sourced" \
    "the unknown name should be named"
  assert_not_contains "$CONTROL_OUT" "PASS:" "no case may run"
  # A bare name is the other way to write it wrong: `retune GRACE 1` would silently do nothing.
  control 'retune GRACE 1'
  assert_eq "$CONTROL_RC" 1 "a bare name is refused too ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "retune: 'GRACE' is not a NAME=value assignment" \
    "the malformed argument should be quoted"
  # A name the SHELL always provides is not a constant of pr-review.sh's, whatever its text says.
  # IFS is the one that matters: `IFS=… read` sat in several of its function bodies and every
  # shell has IFS set, so a set derived from the text plus "is it set now" accepted `retune IFS=x`
  # — which would have altered the word splitting of the harness doing the retuning.
  control 'retune IFS=x'
  assert_eq "$CONTROL_RC" 1 "IFS is not a source-time constant ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "retune IFS: pr-review.sh sets no IFS when it is sourced" \
    "IFS should be refused by name"
  # PIPESTATUS is the same class arriving by the other door: the shell CREATES it, mid-source,
  # when the script runs a top-level pipeline. It is absent from a naive first snapshot and
  # present in the second, so by name alone it is indistinguishable from something the script
  # assigned — and `retune PIPESTATUS=x` was accepted, and did nothing at all.
  control 'retune PIPESTATUS=x'
  assert_eq "$CONTROL_RC" 1 "a variable the shell creates is not a constant ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "retune PIPESTATUS: pr-review.sh sets no PIPESTATUS when it is sourced" \
    "PIPESTATUS should be refused by name"
  # The other side of that probe: the constants it must accept, from both ends of the file — the
  # block that runs as pr-review.sh is sourced, and the ones set further down the file, which a
  # probe that stopped reading early would miss.
  control 'retune GRACE=1 STALL=2 ROUND_GAP=3 ABSENT_GRACE=4 CHECKS_INTERVAL=5 STALE_BASE=6' \
    '[ "$GRACE$STALL$ROUND_GAP$ABSENT_GRACE$CHECKS_INTERVAL$STALE_BASE" = 123456 ] ||
       bail "the constants did not take: $GRACE$STALL$ROUND_GAP$ABSENT_GRACE$CHECKS_INTERVAL$STALE_BASE"'
  assert_eq "$CONTROL_RC" 0 "every documented constant is retunable ($CONTROL_ERR)"
  assert_contains "$CONTROL_OUT" "PASS: test_a_case" "the case should run"
}

# A probe that cannot read pr-review.sh's constants must say so HERE, with the reason. Every
# suite has `set -e` on by the time the probe runs, so a failure that propagated through the
# assignment killed the suite where it stood — exit 1, no output, and the source's own stderr
# discarded — which reads as the suite failing rather than as a setup that never started. The
# control is a copy of this file beside a pr-review.sh that refuses to source.
test_a_probe_that_cannot_read_the_constants_refuses_with_the_reason() {
  local root
  test_tmpdir root probe-fail
  cp "$TEST_LIB_FILE" "$root/"
  printf '#!/usr/bin/env bash\necho "missing dependency: frobnicator not found" >&2\nreturn 1\n' \
    >"$root/pr-review.sh"
  control_in "$root"
  assert_eq "$CONTROL_RC" 2 "a probe that cannot read the constants is a refusal, not a suite failure ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "$LIB_BASENAME: REFUSING to run: the probe that reads pr-review.sh's source-time constants" \
    "the refusal should name what could not be read, under the name the file goes by"
  assert_contains "$CONTROL_ERR" "missing dependency: frobnicator not found" \
    "and carry what the source itself said, which is the only thing that localizes it"
  assert_eq "$CONTROL_OUT" "" "nothing may run"
}

# The probe writes the source's stderr to `pr-review-probe.<pid>.err` in TMPDIR and removes it on
# both of its paths — and neither removal was there at first. The debris is still on this box: a
# 0-byte file from 09-10 19:17, three minutes before the SUCCESS path learned to remove it
# (6de6cff), and four carrying this file's own "frobnicator" line from 09-12 19:07, four minutes
# before `mutant` gave a broken probe a TMPDIR of its own (ced18ba). Both leaks are fixed and
# nothing held them fixed; this case is what does. `watch`'s tmp_sweep_stale is the backstop
# behind it, for the one path no removal here can cover — a suite killed while the probe runs.
test_a_refused_probe_leaves_no_diagnostics_in_tmpdir() {
  local root
  test_tmpdir root probe-leak
  cp "$TEST_LIB_FILE" "$root/"
  printf '#!/usr/bin/env bash\necho "missing dependency: frobnicator not found" >&2\nreturn 1\n' \
    >"$root/pr-review.sh"
  # A TMPDIR of this case's own, so what is asserted empty is only what the refused probe put
  # there: control_in writes its throwaway suite in $root and control_run its capture files in
  # CONTROL_ROOT, and neither is under this one. The assignment prefix is the idiom `mutant`
  # already uses to point a control's temporaries somewhere registered.
  mkdir "$root/tmpdir"
  TMPDIR="$root/tmpdir" control_in "$root"
  assert_eq "$CONTROL_RC" 2 "the refusal is what this case provokes ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "missing dependency: frobnicator not found" \
    "the refusal must still carry what the source said"
  assert_eq "$(find "$root/tmpdir" -mindepth 1 -print | tr '\n' ' ')" "" \
    "a refused probe must leave nothing in TMPDIR"
}

# The guard has to survive the PATH it is checked out under. `declare -F` prints "<name> <line>
# <file>", and a directory with a space in it — a scratch clone at `/tmp/ludics review.XXXX` —
# splits that file across the fields of anything reading it positionally. Comparing a field rather
# than the intact remainder emptied the snapshot, and an EMPTY snapshot protects nothing and says
# nothing: this file's own first control passed a deliberate `fail` through.
#
# The control cannot be "run this file from a spaced directory" — it would run this case again,
# forever. It is a throwaway suite there instead, carrying the ludics-lite#46 shadow, which must
# still be refused.
# The counter's one claim: a fixture run inside a command substitution can still count. The
# body below increments from a `$(...)`, a shell of its own as every call of a fixture is, and a variable
# bumped in the same place is shown NOT to reach the case — which is the reason the helper exists.
test_fixture_call_count_survives_a_command_substitution() {
  local root
  test_tmpdir root fixture-calls
  control "TEST_ROOT=$(printf '%q' "$root")" \
    'VAR=0' \
    'fixture() { VAR=$((VAR + 1)); fixture_call_count body; }' \
    'test_counts() {' \
    '  local n' \
    '  n=$(fixture_call_total body); assert_eq "$n" 0 "a total before any count is 0, not a refusal"' \
    '  n=$(fixture); assert_eq "$n" 1 "the first call"' \
    '  n=$(fixture); assert_eq "$n" 2 "the second call, counted across the substitution"' \
    '  assert_eq "$VAR" 0 "the variable bumped in the same substitution never reaches the case"' \
    '  n=$(fixture_call_total body); assert_eq "$n" 2 "the total after two counts is 2"' \
    '  n=$(fixture_call_total body); assert_eq "$n" 2 "and reading the total does not count"' \
    '  n=$(fixture); assert_eq "$n" 3 "the next count carries on from 2, not from a total that counted"' \
    '  n=$(fixture_call_count other); assert_eq "$n" 1 "a second name counts on its own"' \
    '  fixture_call_reset body' \
    '  n=$(fixture_call_total body); assert_eq "$n" 0 "a reset counter totals 0 again"' \
    '  n=$(fixture); assert_eq "$n" 1 "reset by name starts that counter over"' \
    '  n=$(fixture_call_count other); assert_eq "$n" 2 "and leaves the other alone"' \
    '  fixture_call_reset' \
    '  n=$(fixture_call_count other); assert_eq "$n" 1 "reset with no name zeroes them all"' \
    '}' \
    'run_tests test_counts -- "$@"'
  assert_eq "$CONTROL_RC" 0 "the counter should survive the substitution ($CONTROL_ERR)"
  assert_contains "$CONTROL_OUT" "PASS: test_counts" "the throwaway case should run"
  control 'TEST_ROOT=' 'test_no_root() { fixture_call_count body; }' 'run_tests test_no_root -- "$@"'
  assert_eq "$CONTROL_RC" 1 "with no TEST_ROOT the count is refused, not written somewhere ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "TEST_ROOT is unset" "the refusal should say what is missing"
  control 'TEST_ROOT=' 'test_no_root() { fixture_call_total body; }' 'run_tests test_no_root -- "$@"'
  assert_eq "$CONTROL_RC" 1 "with no TEST_ROOT a total is refused too, not answered 0 ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "TEST_ROOT is unset" "with the same refusal"
  control 'test_two_names() { fixture_call_count a b; }' 'run_tests test_two_names -- "$@"'
  assert_eq "$CONTROL_RC" 1 "two names is a call that meant something else ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "one counter name expected" "and the refusal says so"
  control 'test_two_names() { fixture_call_total a b; }' 'run_tests test_two_names -- "$@"'
  assert_eq "$CONTROL_RC" 1 "two names to a total meant something else as well ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "one counter name expected" "with the same refusal"
  # A name that is not one plain path component is refused BEFORE it is joined to the directory,
  # by count and by reset alike: `../victim` would otherwise land — and be removed — outside the
  # root the EXIT trap owns (review round 1 of ludics-lite#301). The victim is planted to show it.
  local bad
  for bad in '../victim' 'a/b' '.' '..' '' '-rf' 'a\\b'; do
    control "TEST_ROOT=$(printf '%q' "$root")" \
      "test_bad_name() { fixture_call_count $(printf '%q' "$bad"); }" 'run_tests test_bad_name -- "$@"'
    assert_eq "$CONTROL_RC" 1 "counting under '$bad' must be refused ($CONTROL_ERR)"
    assert_contains "$CONTROL_ERR" "one plain path component" "and the refusal says what a name is ('$bad')"
    control "TEST_ROOT=$(printf '%q' "$root")" \
      "test_bad_name() { fixture_call_reset $(printf '%q' "$bad"); }" 'run_tests test_bad_name -- "$@"'
    assert_eq "$CONTROL_RC" 1 "resetting '$bad' must be refused too ($CONTROL_ERR)"
    assert_contains "$CONTROL_ERR" "one plain path component" "with the same refusal ('$bad')"
    control "TEST_ROOT=$(printf '%q' "$root")" \
      "test_bad_name() { fixture_call_total $(printf '%q' "$bad"); }" 'run_tests test_bad_name -- "$@"'
    assert_eq "$CONTROL_RC" 1 "a total under '$bad' must be refused too ($CONTROL_ERR)"
    assert_contains "$CONTROL_ERR" "one plain path component" "with the same refusal ('$bad')"
  done
  : >"$root/victim"
  mkdir -p "$root/fixture-calls"
  control "TEST_ROOT=$(printf '%q' "$root/fixture-calls")" \
    'test_traversal() { fixture_call_reset ../victim; }' 'run_tests test_traversal -- "$@"'
  assert_eq "$CONTROL_RC" 1 "a traversal reset is refused ($CONTROL_ERR)"
  [ -f "$root/victim" ] || bail "the refusal came after the removal: the planted file is gone"
  # A step that fails is a failed CALL, never a stale total (round 2): an unwritable counter file
  # makes the count refuse — through the substitution, which is where the caller reads it — and an
  # unremovable directory makes the reset refuse instead of leaving the next case to count on.
  # Skipped where the caller is root, whom permission bits do not stop.
  if [ "$(id -u)" != 0 ]; then
    mkdir -p "$root/ro/fixture-calls"
    printf 'x\n' >"$root/ro/fixture-calls/body"
    chmod 0444 "$root/ro/fixture-calls/body"
    control "TEST_ROOT=$(printf '%q' "$root/ro")" \
      'test_ro() { local n; n=$(fixture_call_count body) || return 1; bail "stale total $n under a clean status"; }' \
      'run_tests test_ro -- "$@"'
    assert_eq "$CONTROL_RC" 1 "an append that fails is a failed count ($CONTROL_ERR)"
    assert_contains "$CONTROL_ERR" "cannot append" "and says so"
    assert_not_contains "$CONTROL_ERR" "stale total" "the caller's \`|| return 1\` must see the failure"
    # The two controls below are also skipped where the mode bits do not take: under Git Bash
    # on NTFS a 0000 file stays readable and a 0555 directory still lets its entries go, so
    # there is no failure to provoke (ludics-lite#318). Probed, not assumed per platform, and
    # skipped as silently as the root case above: this case's stdout and stderr are compared
    # exactly by test_the_self_test_runs_from_a_renamed_copy, so a skip note would fail it.
    chmod 0000 "$root/ro/fixture-calls/body"
    if ! [ -r "$root/ro/fixture-calls/body" ]; then
      control "TEST_ROOT=$(printf '%q' "$root/ro")" \
        'test_ro_total() { local n; n=$(fixture_call_total body) || return 1; bail "stale total $n under a clean status"; }' \
        'run_tests test_ro_total -- "$@"'
      assert_eq "$CONTROL_RC" 1 "a counter that exists but cannot be read is a failed total, not 0 ($CONTROL_ERR)"
      assert_contains "$CONTROL_ERR" "cannot read" "and says so"
      assert_not_contains "$CONTROL_ERR" "stale total" "through the substitution the caller reads it in"
    fi
    chmod 0444 "$root/ro/fixture-calls/body"
    chmod 0555 "$root/ro/fixture-calls"
    if (: >"$root/ro/fixture-calls/.probe") 2>/dev/null; then
      rm -f "$root/ro/fixture-calls/.probe"
    else
      control "TEST_ROOT=$(printf '%q' "$root/ro")" 'test_reset() { fixture_call_reset; }' 'run_tests test_reset -- "$@"'
      assert_eq "$CONTROL_RC" 1 "a reset that cannot remove the counters refuses ($CONTROL_ERR)"
      assert_contains "$CONTROL_ERR" "cannot remove" "and says so"
    fi
    chmod -R u+w "$root/ro"
  fi
}

test_the_guard_survives_a_path_with_spaces() {
  local root
  test_tmpdir root "lib space"
  case "$root" in *" "*) ;; *) bail "the control needs a path with a space in it: $root" ;; esac
  cp "$HELPER" "$TEST_LIB_FILE" "$root/"
  control_in "$root" 'fail() { echo "FAIL: $*" >&2; exit 1; }'
  assert_eq "$CONTROL_RC" 2 "the shadow guard must still refuse from a spaced path ($CONTROL_ERR)"
  assert_contains "$CONTROL_ERR" "without \`stub fail\`" "the refusal should name the shadow, not the snapshot"
  assert_not_contains "$CONTROL_OUT" "PASS:" "no case may run"
  # And the snapshot itself is not empty there — the refusal above would also fire if the file
  # merely failed to load, and this is the difference between the two.
  assert_not_contains "$CONTROL_ERR" "the function-table snapshot named nothing" \
    "the snapshot should be populated, not empty-and-refused"
}

test_mutation_copy_refuses_missing_or_ambiguous_targets() {
  local root rc err old
  test_tmpdir root mutation-target
  for old in 'no such preamble text' 'local'; do
    rc=0
    mutation_copy "$root/copy.sh" "$old" broken 2>"$root/err" || rc=$?
    err=$(cat "$root/err")
    [ "$rc" -ne 0 ] || bail "a missing or ambiguous mutation target must fail"
    assert_contains "$err" 'mutation_copy: expected exactly one patch target, found' \
      "the patch count should explain the refusal"
    [ ! -e "$root/copy.sh" ] || bail "a refused mutation must not write a copy"
  done
}

test_snapshot_path_mutation_is_caught() {
  mutant test_the_guard_survives_a_path_with_spaces \
    '    path = $0
    sub(/^[^ ]+ [^ ]+ /, "", path)' '    path = $3' \
    'the refusal should name the shadow, not the snapshot'
}

test_probe_status_mutation_is_caught() {
  mutant test_a_probe_that_cannot_read_the_constants_refuses_with_the_reason \
    ')" || lib_probe_rc=$?' ')"' \
    "a probe that cannot read the constants is a refusal, not a suite failure ("
  assert_contains "$CONTROL_ERR" "got '1', expected '2'" "the probe must expose the lost status capture"
}

# And the other half of that probe: the diagnostics it writes. Reverting the refusal path's
# removal is a one-line change that leaves every existing case green — which is exactly how it
# went missing in the first place, and why the emptiness assertion needs a mutant of its own
# rather than the reader's trust (ludics-lite#219).
test_probe_diagnostics_mutation_is_caught() {
  mutant test_a_refused_probe_leaves_no_diagnostics_in_tmpdir \
    'rm -f "$lib_probe_err"
  exit 2' 'exit 2' \
    "a refused probe must leave nothing in TMPDIR (got '"
  assert_contains "$CONTROL_ERR" "pr-review-probe." \
    "the mutant must name the diagnostics file it left behind"
}

# The route the whole file depends on: to SHOW a guard can fail you copy this file and pr-review.sh
# into a scratch directory, revert the fix in the COPY, and run the copy — the tracked file is
# never touched, so a session that dies between mutating and restoring leaves the repo clean. The
# fallback when that route is broken is to mutate the tracked file in place and put it back, which
# does not have that property.
#
# It was broken by a single assertion that spelled this file's name where it meant "this file":
# run as `lib-reverted.sh`, `test_lib_helpers_are_protected` failed on the owner string rather than
# on the mutation (ludics-lite#101). Nothing caught it, because nothing here had ever run this file
# from anywhere but its own path. This case is what stops the spelling from creeping back: it runs
# the copy for real and holds it to the same PASS list, so a name spelled instead of derived fails
# HERE, in the file that spelled it.
#
# A copy needs pr-review.sh beside it — TEST_LIB_DIR comes from BASH_SOURCE and HELPER from that —
# and needs nothing else: any directory will do, which is why the copy goes to a test_tmpdir
# rather than into ship-pr/scripts/.
#
# The inner run is given `--inner-copy` so it skips this case instead of copying itself forever.
# It still reports a PASS line for it, so the two lists match exactly and a case silently lost
# from the copy is a diff rather than a shorter list nobody counted.
#
# What the equality below pins is the PASS list; what pins the diagnostics is the inner run's own
# controls, each of which asserts on the refusal it provoked. That is why `assert_refused` matches
# the "$LIB_BASENAME: REFUSING" prefix: the copies of those refusals rendered in the renamed run
# are the only place a re-spelled prefix shows up, and while it matched the bare word, restoring
# the literal in the early-definition refusal left both runs green through all 19 cases.
test_the_self_test_runs_from_a_renamed_copy() {
  local root copy out err rc want bad
  [ -z "$LIB_INNER_RUN" ] || return 0
  test_tmpdir root renamed-copy
  copy="$root/lib-reverted.sh"
  cp "$TEST_LIB_FILE" "$copy"
  cp "$HELPER" "$root/"
  set +e
  out=$(bash "$copy" --inner-copy 2>"$root/err")
  rc=$?
  set -e
  err=$(cat "$root/err")
  assert_eq "$rc" 0 "a renamed copy beside pr-review.sh must run its own controls ($err)"
  assert_eq "$err" "" "and say nothing on stderr"
  want=$(printf 'PASS: %s\n' "${tests[@]}")
  assert_eq "$out" "$want" "the copy should report every case this file runs, in the same order"
  # The marker's own guard, shown to refuse rather than assumed to. Reading `$1` alone accepted
  # `--inner-copy typo` — the trailing word ignored, this case skipped, and all 19 PASS lines
  # reported by a run that had silently dropped the one control the typo was meant to refuse.
  # A run that skips a case must not be reachable by anything but the exact marker.
  for bad in "--inner-copy typo" "--bogus" "--inner-copy --inner-copy"; do
    set +e
    # shellcheck disable=SC2086 # the point is to pass these as separate words
    out=$(bash "$copy" $bad 2>"$root/err")
    rc=$?
    set -e
    err=$(cat "$root/err")
    assert_eq "$rc" 2 "\`$bad\` must be refused, not honoured ($err)"
    assert_contains "$err" "lib-reverted.sh: REFUSING to run: expected case names" \
      "the refusal should carry the COPY's name, which is the prefix a renamed run renders"
    assert_eq "$out" "" "no case may run under a refused command line"
  done
}

tests=(
  test_undeclared_shadow_is_refused
  test_every_library_function_is_protected
  test_lib_helpers_are_protected
  test_declared_stub_is_allowed
  test_stub_without_a_redefinition_is_refused
  test_stub_of_an_unknown_name_is_refused
  test_own_functions_pass
  test_definitions_before_sourcing_are_refused
  test_tmpdir_writes_to_a_target_named_dir
  test_tmpdir_refuses_a_name_it_uses
  test_the_forward_leaves_nothing_in_tmpdir
  test_a_trap_in_pr_review_sh_is_refused
  test_gh_fixture_parse
  test_gh_fixture_parse_knows_gh_s_option_table
  test_gh_fixture_parse_records_the_request
  test_gh_fixture_parse_refuses_what_gh_refuses
  test_gh_fixture_parse_refuses_what_it_cannot_parse
  test_a_crlf_jq_is_read_back_lf
  test_the_crlf_knob_runs_a_suite_over_the_stub
  test_a_subset_runs_the_cases_it_names_and_says_so
  test_a_subset_naming_a_case_the_suite_lacks_is_refused
  test_a_subset_under_ci_is_refused
  test_cases_named_on_the_command_line_select_like_the_list
  test_a_suite_that_does_not_forward_its_arguments_is_refused
  test_a_case_that_is_not_a_function_is_refused
  test_a_second_library_is_protected_once_it_says_so
  test_protect_library_refuses_a_file_that_defines_nothing
  test_retune_moves_a_constant
  test_retune_is_undone_when_the_case_ends # must stay directly after the case above
  test_retune_of_a_name_the_script_does_not_set_is_refused
  test_a_probe_that_cannot_read_the_constants_refuses_with_the_reason
  test_a_refused_probe_leaves_no_diagnostics_in_tmpdir
  test_the_guard_survives_a_path_with_spaces
  test_fixture_call_count_survives_a_command_substitution
  test_the_self_test_runs_from_a_renamed_copy
  test_mutation_copy_refuses_missing_or_ambiguous_targets
  test_snapshot_path_mutation_is_caught
  test_probe_status_mutation_is_caught
  test_probe_diagnostics_mutation_is_caught
)

run_tests "${tests[@]}" -- "$@"
exit "$?"
}
