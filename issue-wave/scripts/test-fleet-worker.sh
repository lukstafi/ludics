#!/usr/bin/env bash
# Exercises fleet-worker.sh against the local box with shim `claude`/`codex` CLIs on PATH -- no
# model calls, no network, no ssh. Every case runs in a scratch HOME with its own tmux socket and
# state dir, so it is safe beside real workers. The far-side script is the same for local and
# remote boxes, so what passes here is what runs over ssh; only the transport is untested.
#
# Usage: test-fleet-worker.sh [section ...] (exit 0 all pass, 1 otherwise; skips with a notice
#                                          when tmux is not installed, which is the CI runner's
#                                          state unless the workflow installs it)
#        test-fleet-worker.sh --list       (the section names)
#
# With no arguments every section runs; each argument selects every section whose name contains
# it, so a prefix or any distinctive substring will do. An argument matching no section is refused
# before anything runs. The setup the sections share -- the shim CLIs, the scratch skills checkout,
# the scratch project repo -- runs whatever is selected, and a section that needs more than that
# (the coordinator lease, a finished worker) takes it explicitly, so any section runs on its own.
#
# Each section prints its elapsed time when it ends, and a run that blocks fails by name: a section
# (or the setup between two) still running after FLEET_WORKER_TEST_SECTION_TIMEOUT seconds (default
# 300; 0 or off disables the watchdog) is reported, and the run's process group stopped. See the
# section watchdog below.

set -uo pipefail
# No `... | grep -q` under that pipefail: grep exits on its first match and the writer takes
# SIGPIPE, so the pipeline reads 141 -- a refusal message long enough for two writes turned the
# ownership-race assertion into a flake (the gh-ocannl-949 mechanism). Matches read from files or
# here-strings, which bash backs with a file.

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape.
{
HERE=$(cd "$(dirname "$0")" && pwd)
FW="$HERE/fleet-worker.sh"

# --- section selection ------------------------------------------------------------------------
# The `--- name` headers below, in the order they run. Arguments are matched against these, and a
# selected run still runs the sections in file order: each reads what the ones above it left.
SECTIONS=(
  "the real checkout under the README's install loops"
  "base gate"
  "coordinator lease"
  "preflight"
  "load"
  "launch / attach / status / log with a project repo and --repo/--branch"
  "failure verdicts"
  "unstick"
  "codex workers"
  "log --last-result (fixture streams)"
  "halt"
  "board"
  "execution run and conclude --from-run"
  "execution conclude --from-bg-run"
  "execution tip-run"
  "execution revisions resolve"
  "execution conclude --standing-handback"
  "execution leg"
  "prs (the supervision read)"
  "refresh (execution-only boxes)"
  "execution slot"
  "usage"
  "section watchdog"
)

usage() {
  cat <<'USAGE'
usage: test-fleet-worker.sh [--list] [section ...]

With no arguments every section runs. Each argument selects every section whose
name contains it, so a prefix or any distinctive substring ("coord", "unstick",
"status") will do; --list prints the names. An argument matching no section is
refused before anything runs.

Selected sections run in file order, after the setup they all share: the shim
CLIs, the scratch skills checkout and the scratch project repo. A section that
needs more than that -- the coordinator lease, a finished worker to read -- takes
it itself, so any section stands on its own.

Each section prints its elapsed time. One still running after
FLEET_WORKER_TEST_SECTION_TIMEOUT seconds (default 300; 0 or off disables this)
fails the run by its name, and the run's processes are stopped.
USAGE
}

NAMED=0
SELECTED=()
# select_section <name>: add it once. Two arguments can match the same section (`coord lease` both
# name the lease section), and a section running twice would assert against its own leftovers.
select_section() {
  local s
  for s in ${SELECTED[@]+"${SELECTED[@]}"}; do [ "$s" = "$1" ] && return 0; done
  SELECTED+=("$1")
}
ARGS=("$@")   # as given, for the section watchdog's run of this file
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --list) printf '%s\n' "${SECTIONS[@]}"; exit 0 ;;
    -*) echo "FAIL: unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      matched=0
      for s in "${SECTIONS[@]}"; do
        case "$s" in *"$1"*) select_section "$s"; matched=1 ;; esac
      done
      [ "$matched" -eq 1 ] || {
        echo "FAIL: no section matches: $1" >&2
        echo "run with --list to see the ${#SECTIONS[@]} section names" >&2
        exit 1
      }
      NAMED=1
      ;;
  esac
  shift
done
SECTION_TIMEOUT=${FLEET_WORKER_TEST_SECTION_TIMEOUT:-300}
case "$SECTION_TIMEOUT" in
  off) SECTION_TIMEOUT=0 ;;
  '' | *[!0-9]*)
    printf '%s\n' "FAIL: FLEET_WORKER_TEST_SECTION_TIMEOUT must be a number of seconds, 0, or off, got $(printf '%q' "$SECTION_TIMEOUT")" >&2
    exit 1
    ;;
  *) SECTION_TIMEOUT=$((10#$SECTION_TIMEOUT)) ;;
esac

CURRENT_SECTION=""   # the selected section running now, for section_left
SECTION_STARTED=0    # ...and $SECONDS when it started
# section <name>: print the header, and say whether this run includes the section. Every section
# below is `section "..." && { ... }`, so an unselected one is skipped whole.
section() {
  local s found=0
  section_left
  [ "$NAMED" -eq 1 ] || found=1
  for s in ${SELECTED[@]+"${SELECTED[@]}"}; do [ "$s" = "$1" ] && found=1; done
  [ "$found" -eq 1 ] || return 1
  CURRENT_SECTION="$1"
  SECTION_STARTED=$SECONDS
  watch_now "section \"$1\""
  echo "--- $1"
}

command -v tmux >/dev/null 2>&1 || { echo "SKIP: tmux not installed"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

# --- section watchdog (ludics-lite#640) -------------------------------------------------------
# A hang used to end in the CI job's own timeout, a cancel that named nothing: three heads of #633
# lost their 20 minutes each to an orphaned `sleep` holding a worktree lock's descriptor. So the
# suite runs as the child of a supervisor -- this same file, run again with TEST_FLEET_WORKER_WATCH
# naming a directory where the child records what runs now and since when (`watch_now`: a section,
# or the setup before or between them) and where its scratch tree is -- in a process group of its
# own (`set -m`). A label past SECTION_TIMEOUT seconds fails the run by that name. The group is
# sent TERM, which runs the child's own cleanup, and KILL after WATCH_GRACE seconds for whatever
# ignores it; then the supervisor removes what a killed child's cleanup left (its tmux servers and
# scratch tree). INT, TERM and HUP to the supervisor stop the group the same way, and a group left
# running after the child exits is stopped and noted. Boundary: the supervisor stops the child's
# process group, the orphan that kept it (the #633 shape) included, and the run's own tmux servers
# and scratch tree, nothing else. A process that left the group (setsid, a `set -m` job of its own)
# is the section's to stop, as in scripts/run-against-base.sh; a KILL of the supervisor itself
# gives it no chance to act, and the child then runs on unwatched, as the suite ran before. Process
# state is read with `ps -o` (a zombie still answers kill -0; a host whose ps cannot print fields
# is refused, since every run would read as already over), or with kill -0 on the Cygwin family,
# whose ps has no -o and whose kill skips exited processes; Git for Windows ships no tmux, so
# there the suite skips above before any of this runs. Why the KILL is load-bearing: a shell with
# an EXIT trap that is blocked reading a `$(...)` whose pipe an orphan holds -- the #633 shape --
# ignores TERM (bash 3.2 retries the interrupted read), so its own cleanup never runs either.
WATCH_GRACE=5
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) PROC_READING=kill ;; *) PROC_READING=ps ;; esac
# proc_alive <pid> / group_alive <pgid>: running, zombies excluded.
proc_alive() {
  if [ "$PROC_READING" = kill ]; then kill -0 "$1" 2>/dev/null; return; fi
  case "$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')" in '' | Z*) return 1 ;; esac
}
group_alive() {
  if [ "$PROC_READING" = kill ]; then kill -0 -- "-$1" 2>/dev/null; return; fi
  ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'
}
proc_pgid() {
  if [ "$PROC_READING" = kill ]; then cat "/proc/$1/pgid" 2>/dev/null; return; fi
  ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '
}
# stop_group <pgid>: TERM, then KILL for what is still running after the grace.
stop_group() {
  local tries=0
  kill -TERM -- "-$1" 2>/dev/null
  while group_alive "$1" && [ "$tries" -lt $((WATCH_GRACE * 5)) ]; do sleep 0.2; tries=$((tries + 1)); done
  ! group_alive "$1" || kill -KILL -- "-$1" 2>/dev/null
  return 0
}
# run_cleanup <pid> <scratch>: a run's tmux servers, named after its shell's pid, and its scratch
# tree. The servers go first: they hold sockets and cwds inside the tree.
run_cleanup() {
  local s
  for s in "fwtest-$1" "fwtest-env-$1" "fwtest-none-$1"; do
    tmux -L "$s" kill-server 2>/dev/null
    rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$s"
  done
  rm -rf "${2:?}"
}
# watch_now <label>: tell the supervisor what runs from now on (a no-op in an unwatched run).
watch_now() {
  [ -n "${TEST_FLEET_WORKER_WATCH:-}" ] || return 0
  printf '%s %s\n' "$(date +%s)" "$1" > "$TEST_FLEET_WORKER_WATCH/now.new" &&
    mv -f "$TEST_FLEET_WORKER_WATCH/now.new" "$TEST_FLEET_WORKER_WATCH/now"
}
# watch_end <status>: the supervisor's exit -- stop whatever of the run is still going, remove what
# it left, and exit.
watch_end() {
  trap '' INT TERM HUP
  [ -z "$poll" ] || kill "$poll" 2>/dev/null
  if [ -n "$child" ]; then
    group_alive "$child" && stop_group "$child"
    wait "$child" 2>/dev/null
    left=$(cat "$WATCH/tmp" 2>/dev/null) || left=""
    case "$left" in */fleet-worker-test.*) [ ! -d "$left" ] || run_cleanup "$child" "$left" ;; esac
  fi
  rm -rf "${WATCH:?}"
  exit "$1"
}
if [ "$SECTION_TIMEOUT" -gt 0 ] && [ -z "${TEST_FLEET_WORKER_WATCH:-}" ]; then
  # A ps that cannot print fields answers empty for every process, which reads as a run already
  # over: the watchdog would stop watching at once and block on the run instead. Refused up front.
  [ "$PROC_READING" = kill ] || ps -o pgid=,stat= -p "$$" >/dev/null 2>&1 || {
    echo "FAIL: the section watchdog reads processes with ps -o, which this host's ps refuses; FLEET_WORKER_TEST_SECTION_TIMEOUT=off runs the suite unwatched" >&2
    exit 1
  }
  WATCH=$(mktemp -d "${TMPDIR:-/tmp}/fleet-worker-watch.XXXXXX")
  WATCH=$(CDPATH= cd "${WATCH:?}" && pwd -P) ||
    { echo "FAIL: could not create the section watchdog's scratch directory" >&2; exit 1; }
  child="" poll="" pending=""
  # Deferred until `child` is recorded: a signal taken in between would leave the run unstopped.
  trap 'pending=130' INT
  trap 'pending=143' TERM HUP
  set -m
  TEST_FLEET_WORKER_WATCH="$WATCH" "$BASH" "$0" ${ARGS[@]+"${ARGS[@]}"} </dev/null &
  child=$!
  set +m
  trap 'watch_end 130' INT
  trap 'watch_end 143' TERM HUP
  [ -z "$pending" ] || watch_end "$pending"
  # Proven, not trusted: a child outside a group of its own could not be stopped as one, and the
  # watchdog would then report a stop that never happened (job control's setpgid races on macOS).
  [ "$(proc_pgid "$child")" = "$child" ] || ! proc_alive "$child" || {
    kill -TERM "$child" 2>/dev/null
    echo "FAIL: the section watchdog could not place the run in a process group of its own"
    watch_end 1
  }
  since=$(date +%s) label="the start-up"
  while proc_alive "$child"; do
    [ ! -f "$WATCH/now" ] || read -r since label < "$WATCH/now" || true
    if [ $(($(date +%s) - since)) -ge "$SECTION_TIMEOUT" ]; then
      stop_group "$child"
      wait "$child" 2>/dev/null
      echo "FAIL: $label still running after ${SECTION_TIMEOUT}s (FLEET_WORKER_TEST_SECTION_TIMEOUT; raise it on a box this slow); the run's process group was stopped"
      watch_end 1
    fi
    # Waited in the background, so a signal is taken at once rather than after the sleep.
    sleep 1 >/dev/null 2>&1 </dev/null &
    poll=$!
    wait "$poll"
    poll=""
  done
  wait "$child"
  rc=$?
  if group_alive "$child"; then
    echo "note: the run left processes in its process group; the section watchdog stopped them"
  fi
  watch_end "$rc"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/fleet-worker-test.XXXXXX")
TMP=$(cd "$TMP" && pwd -P)   # canonical: macOS mktemp answers under /var, which resolves to /private/var
[ -z "${TEST_FLEET_WORKER_WATCH:-}" ] || printf '%s\n' "$TMP" > "$TEST_FLEET_WORKER_WATCH/tmp"
watch_now "the setup before the first section"
export HOME="$TMP/home"
mkdir -p "$HOME/.claude/skills" "$HOME/.codex/skills" "$TMP/bin"
# Hermetic: every ambient FLEET_* and ISSUE_WAVE_* knob is cleared before the suite sets its own. A
# fleet box's ~/.config/fleet/env.sh exports the roster and, on the hub, a slot spec: an inherited
# `mac-studio=6` beside a `testbox other` roster refused every execution case as naming a box
# outside it (ludics-lite#329), and an inherited FLEET_SLOT_STATE would point the slot cases at the
# box's real locks. By prefix, so a knob added later cannot leak either. Every case that depends on
# the roster or the slot spec sets or unsets it itself.
while IFS= read -r v; do
  case "$v" in FLEET_*|ISSUE_WAVE_*) unset "$v" ;; esac
done < <(compgen -e)
# Paths with spaces on purpose: every far-side line that forgets to quote shows up here.
export ISSUE_WAVE_STATE="$TMP/st ate"
export FLEET_TMUX_SOCKET="fwtest-$$"
export FLEET_LOCAL_BOX="testbox"
export FLEET_ANCHOR="testbox"
# The coordinator identity, pinned: without either harness session variable the script refuses to
# guess (tested below), so a test must name it, as would any coordinator whose harness supplies no
# session identity.
export FLEET_COORDINATOR="test-coordinator"
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID
# An exported GitHub token changes the preflight's credential repair text (ludics-lite#360), so the
# runner's own must not reach it.
unset GH_TOKEN GITHUB_TOKEN
SUITE_PATH="$PATH"   # as the suite found it, for the section watchdog's copy of the suite
export PATH="$TMP/bin:$PATH"
# `execution slot` runs its command under `execution hold`, which wraps it in systemd-inhibit when
# one resolves (ludics-lite#317). The CI runner is Ubuntu, whose real systemd-inhibit would make
# every slot case below a probe of that runner's polkit, so the suite pins it to a name that
# resolves to nothing -- the bare arm, as on macOS -- and the cases that exercise the inhibitor
# point it at a stub instead.
export FLEET_SYSTEMD_INHIBIT="fleet-test-no-systemd-inhibit"
# A scratch git identity, so worktree/commit steps work on a bare runner.
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# kill-server leaves the socket file behind, so each run's own are removed by name (run_cleanup,
# above, beside the watchdog that also calls it): never a prefix glob, since peer sessions run this
# suite concurrently on the same box. FLEET_TMUX_SOCKET is the first of its names.
cleanup() { run_cleanup "$$" "$TMP"; }
trap cleanup EXIT

# Copy the dispatcher beside a canned base helper: no live GitHub reads, and no
# production bypass knob. The production helper's own suites pin its red diagnostics.
mkdir -p "$TMP/dispatcher/issue-wave/scripts" "$TMP/dispatcher/ship-pr/scripts" "$TMP/dispatcher/scripts"
cp "$FW" "$TMP/dispatcher/issue-wave/scripts/fleet-worker.sh"
# The standalone registry while there is one; the interpreter wrapper and the package the ported
# subcommands forward to (ludics-lite#403) travel with the dispatcher either way.
[ ! -f "$HERE/fleet-execution.py" ] || cp "$HERE/fleet-execution.py" "$TMP/dispatcher/issue-wave/scripts/fleet-execution.py"
cp "$HERE/../../scripts/py" "$TMP/dispatcher/scripts/py"
cp -R "$HERE/../../lib" "$TMP/dispatcher/lib"
cp "$HERE/bg-run.sh" "$TMP/dispatcher/issue-wave/scripts/bg-run.sh"
FW="$TMP/dispatcher/issue-wave/scripts/fleet-worker.sh"
export BASE_CALL_LOG="$TMP/base-calls"
export SHIM_FW="$FW"   # the dispatcher copy, for the shim's mid-read conclusion below
cat > "$TMP/dispatcher/ship-pr/scripts/pr-review.sh" <<'EOF'
#!/usr/bin/env bash
# The call is logged with --advisory-red's file spelled FILE: the gate stages a fresh one per read
# (ludics-lite#651), and the exact call lines below pin everything else about it.
logged="" prev="" advisory_file=""
for arg in "$@"; do
  if [ "$prev" = --advisory-red ]; then advisory_file="$arg"; arg=FILE; fi
  logged="${logged:+$logged }$arg"
  prev="$arg"
done
printf '%s\n' "$logged grace=${SHIP_PR_BASE_ABSENT_GRACE:-unset} interval=${SHIP_PR_CHECKS_INTERVAL:-unset}" >> "$BASE_CALL_LOG"
# `prs` reads (SHIM_PRS names a fixture directory): the open-PR list, `rounds`, `checks` and the
# head commit's date, each answered from a file there, or 3 (the API never answered) without one.
# `rounds-N` holds the count, then optionally the trailer line to print instead of the real shape
# (`-` prints none); `checks-N` holds the exit status, the verdict's prose, and the trailer line
# as printed (empty: none), then any lines to print after it. A wave issue's cross-reference read
# (GraphQL, ludics-lite#650's follow-up) is answered from `xref-<owner>-<name>-<N>`: its pages as
# printed, or `exit <n>` alone for that status.
if [ -n "${SHIM_PRS:-}" ]; then
  printf '%s\n' "$* threshold=${SHIP_PR_ROUND_THRESHOLD:-unset}" >> "$SHIM_PRS/calls"
  if [ "$1 $3 $4" = "retry api graphql" ]; then
    xo="" xn="" xi=""
    for arg in "$@"; do
      case "$arg" in owner=*) xo=${arg#owner=} ;; name=*) xn=${arg#name=} ;; number=*) xi=${arg#number=} ;; esac
    done
    xf="$SHIM_PRS/xref-$xo-$xn-$xi"
    [ -f "$xf" ] || exit 3
    case "$(head -n 1 "$xf")" in "exit "*) exit "$(head -n 1 "$xf" | cut -c6-)" ;; esac
    cat "$xf"; exit 0
  fi
  case "$1 $3" in
    "retry pr") [ -f "$SHIM_PRS/list.json" ] || exit 3; cat "$SHIM_PRS/list.json"; exit 0 ;;
    "retry api") [ -f "$SHIM_PRS/date-${4##*/}" ] || exit 3; cat "$SHIM_PRS/date-${4##*/}"; exit 0 ;;
  esac
  case "$1" in
    rounds)
      [ "${SHIP_PR_ROUND_THRESHOLD:-}" = off ] || exit 2
      [ -f "$SHIM_PRS/rounds-${2##*#}" ] || { echo "review rounds: UNKNOWN — fixture; this is NOT 'no rounds yet', retry"; echo "rounds: n=unknown threshold=off first=unknown"; exit 3; }
      { read -r cnt; read -r trailer || trailer="rounds: n=$cnt threshold=off first=0"; } < "$SHIM_PRS/rounds-${2##*#}"
      echo "review rounds with findings: $cnt (fixture); no threshold set"
      [ "$trailer" = - ] || printf '%s\n' "$trailer"; exit 0 ;;
    checks)
      [ -f "$SHIM_PRS/checks-${2##*#}" ] || exit 3
      { read -r crc; read -r line; read -r trailer; } < "$SHIM_PRS/checks-${2##*#}"
      printf 'build signal %s @abcdef12: %s\n  a check line\n' "$2" "$line"
      [ -z "$trailer" ] || printf '%s\n' "$trailer"
      tail -n +4 "$SHIM_PRS/checks-${2##*#}"; exit "$crc" ;;
  esac
  exit 2
fi
# The integration records the gate stages for the checker are logged by content: the file is
# removed once the read returns (ludics-lite#401).
prev=""
for arg in "$@"; do
  [ "$prev" != --integration-records ] || sed 's/^/records: /' "$arg" >> "$BASE_CALL_LOG"
  prev="$arg"
done
if [ "$3" = retry ]; then
  [ -z "${SHIM_BASE_TIP_FAIL:-}" ] || exit 3
  ref="${6##*/}"
  tip=$(git -C "$BASE_PROJECT" rev-parse "origin/$ref") || exit 3
  if [ -n "${SHIM_MOVE_REF_AFTER_CONFIRM:-}" ]; then
    git -C "$BASE_PROJECT" update-ref "refs/remotes/origin/$ref" "$SHIM_MOVE_REF_AFTER_CONFIRM" || exit 3
  fi
  echo "${SHIM_BASE_TIP:-$tip}"
  exit 0
fi
# Fail if the dispatch contract drifts; ambient REPO must not select this read.
[ "$1" = --repo ] && [ "$2" = example/project ] && [ "$3" = base ] || exit 2
[ "${SHIP_PR_BASE_ABSENT_GRACE:-}" = 300 ] || exit 3
# Pinned, not cleared: the ceiling below is arithmetic over the grace AND this interval, so the
# gate has to put both in force rather than leave one to the checker's default (ludics-lite#175).
[ "${SHIP_PR_CHECKS_INTERVAL:-}" = 60 ] || exit 3
for knob in SHIP_PR_ADVISORY_CHECKS SHIP_PR_TEST_SOURCE_ONLY SHIP_PR_CHECKS_WAIT SHIP_PR_CHECKS_HEARTBEAT SHIP_PR_API_ATTEMPTS SHIP_PR_API_BACKOFF; do
  [ -z "${!knob}" ] || exit 3
done
# The gate's one base read is the bounded --wait one: `base --wait` settles a path-filtered tip
# for the older verdict itself (ludics-lite#156), so the gate has no second, plain read to make.
# Its ceiling is DERIVED from the two knobs above — the grace plus one round of the checker's
# wait — and is checked here as that arithmetic rather than against a literal, so a gate that
# moved either knob and left the ceiling behind fails here (ludics-lite#175).
case " $* " in *" --wait=$((SHIP_PR_BASE_ABSENT_GRACE + SHIP_PR_CHECKS_INTERVAL)) "*) ;; *) exit 4 ;; esac
# And it opts in to the interim verdict (ludics-lite#308): a launch through a merge burst is not
# waiting for the tip's own run, so every gate read carries --interim.
case " $* " in *" --interim "*) ;; *) exit 4 ;; esac
# And it hands the checker a file for --advisory-red (ludics-lite#651), which a green fills: with
# the jobs SHIM_BASE_ADVISORY_RED names (a JSON array, as the checker writes it), `[]` when it is
# unset, and nothing at all when it is set empty (a green that never wrote the file).
[ -n "$advisory_file" ] && [ -f "$advisory_file" ] || exit 4
if [ "${SHIM_BASE_RC:-0}" = 0 ]; then printf '%s' "${SHIM_BASE_ADVISORY_RED-[]}" > "$advisory_file" || exit 3; fi
# SHIM_BASE_TOUCH: a marker this read leaves behind, so a test can change the world between the
# preflight and the launch's far side (the tmux shim's SHIM_TMUX_GENV_WHEN reads it).
[ -z "${SHIM_BASE_TOUCH:-}" ] || touch "$SHIM_BASE_TOUCH"
# SHIM_BASE_CONCLUDE: an execution conclusion payload the read concludes while it "waits", as an
# integration run finishing mid-gate would (ludics-lite#401, review round 6).
[ -z "${SHIM_BASE_CONCLUDE:-}" ] || env FLEET_BOXES="testbox other" "$SHIM_FW" execution conclude "$SHIM_BASE_CONCLUDE" >/dev/null || exit 3
# SHIM_BASE_HALT: a halt reason the read records while it "waits", as a coordinator halting the
# fleet during a minutes-long base read would: the gate re-reads the lease and halt after it.
[ -z "${SHIM_BASE_HALT:-}" ] || "$SHIM_FW" halt "$SHIM_BASE_HALT" >/dev/null || exit 3
if [ -n "${SHIM_BASE_REQUIRE_PREFLIGHT:-}" ] && [ ! -e "$SHIM_BASE_REQUIRE_PREFLIGHT" ]; then
  echo 'base read occurred before preflight'; exit 3
fi
echo "${SHIM_BASE_MESSAGE:-BASE GREEN example/project tested abc1234}"
exit "${SHIM_BASE_RC:-0}"
EOF
chmod +x "$TMP/dispatcher/ship-pr/scripts/pr-review.sh"

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "PASS: $*"; }
ko() { fail=$((fail + 1)); echo "FAIL: $*"; }
# expect <label> <want-rc> <want-substring> -- <cmd...>; captures output for later assertions in $out.
expect() {
  local label="$1" want_rc="$2" want="$3"; shift 3; [ "$1" = -- ] && shift
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq "$want_rc" ] && grep -q -- "$want" <<<"$out"; then ok "$label"
  else ko "$label (rc=$rc want $want_rc; want /$want/) -- $out"; fi
}
# fixture_done <id>: conclude a fixture reservation nothing ran under, so its box is free for the
# cases after it. The one helper every section concludes its fixtures through.
fixture_done() {
  jq -n --arg id "$1" '{request_id:$id, verdict:"not-launched", log:"/dev/null", evidence:"fixture: nothing ran"}' > "$TMP/done-$1.json"
  env FLEET_BOXES="testbox other" "$FW" execution conclude "$TMP/done-$1.json" >/dev/null || ko "could not conclude $1 (setup)"
}
# section_left: after each section (section() runs it for the one before, and the foot for the
# last), fail THAT section by name for any record it left outstanding on testbox. A leftover
# otherwise fails some later section's reservation, as a misleading "(setup)" (#417).
section_left() {
  local left
  [ -n "$CURRENT_SECTION" ] || return 0
  if left=$(env FLEET_BOXES="testbox other" "$FW" execution list --active 2>/dev/null |
      jq -r '[.[] | select(.request.execution_host == "testbox") | "\(.request_id) (\(.state))"] | join(", ")' 2>/dev/null); then
    [ -z "$left" ] || ko "section \"$CURRENT_SECTION\" left outstanding on testbox: $left"
  else
    ko "section \"$CURRENT_SECTION\": the registry could not be read after it"
  fi
  echo "--- $((SECONDS - SECTION_STARTED))s: $CURRENT_SECTION"
  watch_now "the setup after section \"$CURRENT_SECTION\""
  CURRENT_SECTION=""
}

# --- shim CLIs ------------------------------------------------------------------------------
# claude: honours -p/--output-format/--session-id/--resume; the brief on stdin drives it: a line
# `SLEEP <n>` sleeps (a live worker to unstick), `FAIL` makes the result an error.
# With --input-format stream-json (a worker's channel, ludics-lite#259) it is the long-lived
# process the real CLI is: one turn per input line, alive until stdin closes, each message echoed
# under its uuid with --replay-user-messages. A line arriving during a SLEEP is taken mid-turn,
# as Claude Code 2.1.282 takes one at its next tool boundary, and its text joins the reply; `BG
# <n>` ends the turn with a background task listed that finishes <n> s later and starts a turn
# of its own; `SILENT` exits 0 with no events; `FAIL` answers with an error result and stays up.
# A control request line (`unstick --interrupt`, ludics-lite#424) is answered as Claude Code 2.1.284
# answers it: a `control_response` receipt under its request_id, and, during a SLEEP, the turn
# ends at once in an aborted `result` (error_during_execution, terminal_reason aborted_tools);
# idle, the receipt alone. `NOINT` in a turn's message answers an interrupt with an error instead.
cat > "$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
sid=""; fmt=text; resume=""; infmt=text; replay=0; probe=0
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid="$2"; shift ;;
    --resume) resume="$2"; sid="$2"; shift ;;
    --output-format) fmt="$2"; shift ;;
    --input-format) infmt="$2"; shift ;;
    --replay-user-messages) replay=1 ;;
    --no-session-persistence) probe=1 ;;   # the preflight's live probe
  esac
  shift
done
if [ "$infmt" = stream-json ]; then
  # SHIM_CLAUDE_OLD: a CLI that predates the stream-json channel, as commander reports it.
  [ -z "${SHIM_CLAUDE_OLD:-}" ] || { echo "error: unknown option '--input-format'" >&2; exit 1; }
  if [ "$probe" = 1 ]; then
    [ -z "${SHIM_BASE_REQUIRE_PREFLIGHT:-}" ] || touch "$SHIM_BASE_REQUIRE_PREFLIGHT"
    [ -n "${SHIM_CLAUDE_HANG:-}" ] && sleep 30
  fi
  echo_line() { [ "$replay" = 0 ] || jq -c '. + {isReplay: true}' <<<"$1"; }
  say() { jq -cn --arg t "$1" '{type: "assistant", message: {content: [{type: "text", text: $t}]}}'; }
  result() { jq -cn --arg t "$1" --arg s "$sid" --argjson e "${2:-false}" --arg tr "${3:-}" '{type: "result", subtype: (if $e then "error_during_execution" else "success" end), is_error: $e, num_turns: 1, result: $t, session_id: $s} + (if $tr == "" then {} else {terminal_reason: $tr} end)'; }
  is_control() { [ "$(jq -r '.type // empty' <<<"$1" 2>/dev/null)" = control_request ]; }
  # control <line> [refuse]: the receipt of an interrupt, or with `refuse` an error answer.
  control() {
    local r; r=$(jq -r '.request_id // empty' <<<"$1")
    if [ -n "${2:-}" ]; then jq -cn --arg r "$r" '{type: "control_response", response: {subtype: "error", request_id: $r, error: "shim: not now"}}'; return 1; fi
    jq -cn --arg r "$r" '{type: "control_response", response: {subtype: "success", request_id: $r, response: {still_queued: []}}}'
  }
  init() { printf '{"type":"system","subtype":"init","session_id":"%s","resumed":%s}\n' "$sid" "$([ -n "$resume" ] && echo true || echo false)"; }
  while IFS= read -r line; do
    if is_control "$line"; then control "$line"; continue; fi
    msg=$(jq -r '.message.content // empty' <<<"$line" 2>/dev/null)
    init; echo_line "$line"
    grep -q '^SILENT' <<<"$msg" && exit 0
    # HALFTURN: answers, then starts another turn (as a ScheduleWakeup would) and exits in it.
    if grep -q '^HALFTURN' <<<"$msg"; then say "half"; result "half"; init; exit 0; fi
    extra=""
    n=$(sed -n '/^SLEEP [0-9]/ { s/^SLEEP \([0-9]*\).*/\1/; p; q; }' <<<"$msg")
    i=0; aborted=0; noint=""; grep -q 'NOINT' <<<"$msg" && noint=1
    while [ -n "$n" ] && [ "$i" -lt "$n" ]; do
      if IFS= read -r -t 1 more; then
        if is_control "$more"; then control "$more" "$noint" && { aborted=1; break; }
        else echo_line "$more"; extra="$extra +msg: $(jq -r '.message.content // empty' <<<"$more" | tr '\n' ' ' | cut -c1-30)"; fi
      else
        rs=$?; [ "$rs" -gt 128 ] || sleep 1   # >128 is the timeout, which already waited
      fi
      i=$((i + 1))
    done
    if [ "$aborted" = 1 ]; then
      echo '{"type":"system","subtype":"task_notification","task_id":"t1","status":"stopped"}'
      result "" true aborted_tools; continue
    fi
    text="did: $(printf '%s' "$msg" | tr '\n' ' ' | cut -c1-40)$extra"
    say "$text"
    if grep -q '^FAIL' <<<"$msg"; then result "boom: $text" true; continue; fi
    bg=$(sed -n '/^BG [0-9]/ { s/^BG \([0-9]*\).*/\1/; p; q; }' <<<"$msg")
    if [ -n "$bg" ]; then
      echo '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash"}]}'
      result "$text"; sleep "$bg"
      # As the real CLI: the task list clears, then the notification lands, then the new turn's
      # init, in separate writes (gaps widened so a reader can land between them).
      echo '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'
      sleep 2; echo '{"type":"system","subtype":"task_notification","task_id":"b1","status":"completed"}'
      sleep 2; init; text="background task done"; say "$text"
    fi
    result "$text"
  done
  exit 0
fi
brief=$(cat)
# The real CLI refuses an empty stdin prompt; the shim must too, or a probe whose prompt was lost
# on the way (bash 3.2 backgrounding, the mac-studio preflight failure) passes here and fails live.
[ -n "$brief" ] || { echo "Error: Input must be provided either through stdin or as a prompt argument when using --print" >&2; exit 1; }
sleep_s=$(sed -n '/^SLEEP [0-9]/ { s/^SLEEP \([0-9]*\).*/\1/; p; q; }' <<<"$brief")
[ -n "${SHIM_CLAUDE_HANG:-}" ] && sleep 30
if [ "$fmt" = json ]; then
  [ -z "${SHIM_BASE_REQUIRE_PREFLIGHT:-}" ] || touch "$SHIM_BASE_REQUIRE_PREFLIGHT"
  printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"%s"}\n' "${sid:-none}"; exit 0
fi
if grep -q '^SILENT' <<<"$brief"; then exit 0; fi
printf '{"type":"system","subtype":"init","session_id":"%s","resumed":%s}\n' "$sid" "$([ -n "$resume" ] && echo true || echo false)"
[ -n "$sleep_s" ] && sleep "$sleep_s"
text="did: $(LC_ALL=C; printf '%s' "${brief:0:40}" | tr '\n' ' ')"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$text"
if grep -q '^FAIL' <<<"$brief"; then
  printf '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"result":"boom","session_id":"%s"}\n' "$sid"; exit 1
fi
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"%s","session_id":"%s"}\n' "$text" "$sid"
EOF
# codex: `exec --json ... -o <file> -` and `exec resume <id> --yolo --json -`.
cat > "$TMP/bin/codex" <<'EOF'
#!/usr/bin/env bash
[ "$1" = login ] && { [ -z "${SHIM_CODEX_LOGIN_DOWN:-}" ]; exit $?; }
[ "$1" = exec ] && shift
case " $* " in *" -C / "*) case " $* " in *" --skip-git-repo-check "*) ;; *) echo "Not inside a trusted directory and --skip-git-repo-check was not specified." >&2; exit 1 ;; esac ;; esac
if [ -n "${SHIM_CODEX_DOWN:-}" ]; then printf '{"type":"thread.started","thread_id":"x"}\n{"type":"turn.failed","error":{"message":"401 Unauthorized"}}\n'; exit 1; fi
tid=""; out=""
resumed=""
if [ "${1:-}" = resume ]; then shift; tid="$1"; shift; resumed=1; fi
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done
[ -n "$tid" ] || tid="0199-shim-$(date +%s)-$$"
brief=$(cat)
[ -n "$brief" ] || { echo "No prompt provided via stdin." >&2; exit 1; }
if [ -n "${SHIM_CODEX_SILENT_RESUME:-}" ] && [ "$1" != "" ] 2>/dev/null; then :; fi
if [ -n "${SHIM_CODEX_SILENT_RESUME:-}" ] && [ -n "$resumed" ]; then exit 0; fi
printf '{"type":"thread.started","thread_id":"%s"}\n{"type":"turn.started"}\n' "$tid"
sleep 1
text="codex did: $(LC_ALL=C; printf '%s' "${brief:0:40}" | tr '\n' ' ')"
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n{"type":"turn.completed"}\n' "$text"
[ -n "$out" ] && printf '%s\n' "$text" > "$out"
exit 0
EOF
REAL_GIT=$(command -v git)
cat > "$TMP/bin/git" <<EOF
#!/usr/bin/env bash
if [ -n "\${SHIM_GIT_HANG_FETCH:-}" ]; then for a in "\$@"; do [ "\$a" = fetch ] && sleep 60; done; fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$TMP/bin/git"
REAL_TMUX=$(command -v tmux)
cat > "$TMP/bin/tmux" <<EOF
#!/usr/bin/env bash
# A worker's session only (iw-*): the GitHub probe's own session (ludics-lite#374) goes through.
if [ -n "\${SHIM_TMUX_FAIL_NEW:-}" ]; then case " \$* " in *" new-session "*" -s iw-"*) echo "shim: tmux refuses new-session" >&2; exit 1 ;; esac; fi
# The server the preflight's environment check reads (ludics-lite#327): SHIM_TMUX_GENV names a
# file holding \`show-environment -g\` output, or \`none\` for no server running; SHIM_TMUX_SESSIONS
# lists its session names and SHIM_TMUX_UPDATE_ENV its update-environment option; with
# SHIM_TMUX_GENV_WHEN it plays that server only once the named file exists. Unset, the real
# server on the test socket answers.
if [ -n "\${SHIM_TMUX_GENV:-}" ] && { [ -z "\${SHIM_TMUX_GENV_WHEN:-}" ] || [ -e "\$SHIM_TMUX_GENV_WHEN" ]; }; then
  case " \$* " in
    *" list-sessions "*|*" show-environment "*|*" show-options "*)
      [ "\$SHIM_TMUX_GENV" != none ] || { echo "no server running on /tmp/shim/\${FLEET_TMUX_SOCKET:-default}" >&2; exit 1; }
      case " \$* " in
        *" list-sessions "*) for s in \${SHIM_TMUX_SESSIONS:-}; do echo "\$s"; done ;;
        *" show-options "*) for s in DISPLAY SSH_AUTH_SOCK \${SHIM_TMUX_UPDATE_ENV:-}; do echo "\$s"; done ;;
        *) cat "\$SHIM_TMUX_GENV" ;;
      esac
      exit 0 ;;
  esac
fi
exec "$REAL_TMUX" "\$@"
EOF
# ssh: the preflight's cross-box reach probe (ludics-lite#57) -- the one ssh shape these tests
# answer, `ssh <opts> <host> exit 0`. `SHIM_SSH_DENY=<host>` answers a missing credential,
# `SHIM_SSH_DOWN=<host>` a box that does not answer; every other probed host is reachable. Any
# other invocation (run_on's `bash -s` to a box the tests never map as local) is unresolvable, as
# it would be for real: nothing in these tests reaches a real box. The one exception is
# `SHIM_SSH_LOCAL=<host>`, which runs whatever reaches that host here, as its remote shell would:
# the stand-in for a second box, so a cross-box path is exercised through run_on's real quoting.
# `SHIM_SSH_PY=<list>` is that box's own LUDICS_PY_CANDIDATES: a box whose Pythons are not the
# coordinator's, which the coordinator's own environment cannot fake (it runs under scripts/py too).
# `SHIM_SSH_ENV=<file>` is that box's own ~/.config/fleet/env.sh, sourced there as the ssh shell's
# ~/.bashrc sources it: a box whose fleet configuration is not the coordinator's (ludics-lite#632).
cat > "$TMP/bin/ssh" <<'SHIMEOF'
#!/usr/bin/env bash
host=""
while [ $# -gt 0 ]; do case "$1" in -o) shift ;; -*) ;; *) host="$1"; break ;; esac; shift; done
shift
[ -z "${SHIM_SSH_LOCAL:-}" ] || [ "$host" != "$SHIM_SSH_LOCAL" ] || [ -z "${SHIM_SSH_PY:-}" ] || export LUDICS_PY_CANDIDATES="$SHIM_SSH_PY"
# shellcheck disable=SC1090  # the box's env.sh, named by the case
[ -z "${SHIM_SSH_LOCAL:-}" ] || [ "$host" != "$SHIM_SSH_LOCAL" ] || [ -z "${SHIM_SSH_ENV:-}" ] || . "$SHIM_SSH_ENV"
[ -n "${SHIM_SSH_LOCAL:-}" ] && [ "$host" = "$SHIM_SSH_LOCAL" ] && exec bash -c "$*"
[ "$*" = "exit 0" ] || { echo "ssh: Could not resolve hostname $host: nodename nor servname provided" >&2; exit 255; }
[ "$host" = "${SHIM_SSH_HANG:-}" ] && sleep 30
[ "$host" = "${SHIM_SSH_SLURP:-}" ] && cat > /dev/null
[ "$host" = "${SHIM_SSH_DENY:-}" ] && { echo "$host: Permission denied (publickey)." >&2; exit 255; }
[ "$host" = "${SHIM_SSH_DOWN:-}" ] && { echo "ssh: connect to host $host port 22: Connection timed out" >&2; exit 255; }
exit 0
SHIMEOF
# gh: the preflight's GitHub credential call (ludics-lite#360), `gh api user -q .login`, in the
# shapes a real gh answers with: SHIM_GH=401 is gh 2.46 over a dead keyring token (the JSON body
# on stdout with no newline, then the error on stderr, exit 1; rog-nv-linux, 2026-09-24),
# `noauth` a box never logged in (exit 4), `down` a network that cannot reach api.github.com,
# `5xx` a GitHub outage, `hang` a call that never returns. Unset, it answers a login.
# It is also git's credential helper for https://github.com, configured in the suite's global git
# config the way `gh auth setup-git` writes it (the list reset first, so no system helper answers): the
# preflight's `git credential fill` (ludics-lite#374) gets a credential from it unless
# SHIM_GH_CRED=none (no credential, as gh with no login answers) or `hang`; `dead` returns one
# the API call then refuses, as GitHub refuses a stale password (the API call reads the token it
# was given, GH_TOKEN, as gh does), `other` one that answers as another account, and `slowcheck`
# one GitHub never answers for.
# SHIM_GH_SLOW=<s> delays every API answer; SHIM_GH_LOGIN=<login> answers as that account.
# It also answers `execution`'s commit check (ludics-lite#561), `gh api --hostname github.com
# repos/<owner>/<name>/commits/<sha> -q .sha`, as GitHub does: the SHA back, unless it is listed in
# SHIM_GH_NO_COMMIT (422: no commit), the repository is SHIM_GH_NO_REPO (404), SHIM_GH=down (no
# answer), `spam` (GitHub's other 422) or `hang` (a call that never returns, from a child process as
# a stalled connection would). Each such call appends its path to $SHIM_GH_COMMIT_LOG.
# A branch head (ludics-lite#558's head-of requests), `gh api --hostname github.com
# repos/<owner>/<name>/git/ref/heads/<branch> -q .object.sha`, is answered from SHIM_GH_HEADS, a file
# of `<branch> <sha>` lines (a branch it does not list is GitHub's 404), or not at all under
# SHIM_GH=down; each such call appends its path to $SHIM_GH_COMMIT_LOG too.
# `auth token -h github.com` answers gh's stored token (ludics-lite#567): SHIM_GH_STORED's value,
# or with none set gh's "no oauth token" (exit 1); `hang` never returns. Asked with GH_TOKEN or
# GITHUB_TOKEN in its environment, even empty, it fails loudly: gh would answer that variable, so
# the preflight must ask with both removed.
cat > "$TMP/bin/gh" <<'SHIMEOF'
#!/usr/bin/env bash
if [ "$#" -eq 6 ] && [ "$1 $2 $3 $5 $6" = "api --hostname github.com -q .object.sha" ]; then
  case "$4" in repos/*/*/git/ref/heads/*) ;; *) echo "gh shim: unexpected call: $*" >&2; exit 2 ;; esac
  printf '%s\n' "$4" >> "$SHIM_GH_COMMIT_LOG"
  [ "${SHIM_GH:-}" != down ] || { printf 'error connecting to api.github.com\n' >&2; exit 1; }
  branch=${4#repos/*/*/git/ref/heads/}
  sha=$(awk -v b="$branch" '$1 == b { print $2 }' "${SHIM_GH_HEADS:-/dev/null}" | tail -n 1)
  [ -n "$sha" ] || { printf '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
  printf '%s\n' "$sha"; exit 0
fi
if [ "$#" -eq 6 ] && [ "$1 $2 $3 $5 $6" = "api --hostname github.com -q .sha" ]; then
  case "$4" in repos/*/*/commits/*) ;; *) echo "gh shim: unexpected call: $*" >&2; exit 2 ;; esac
  printf '%s\n' "$4" >> "$SHIM_GH_COMMIT_LOG"
  sha=${4##*/}; repo=${4#repos/}; repo=${repo%/commits/*}
  [ "${SHIM_GH:-}" != down ] || { printf 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n' >&2; exit 1; }
  [ "${SHIM_GH:-}" != spam ] || { echo "gh: Validation Failed: endpoint has been spammed (HTTP 422)" >&2; exit 1; }
  [ "${SHIM_GH:-}" != hang ] || sleep 30
  [ "$repo" != "${SHIM_GH_NO_REPO:-}" ] || { printf '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
  case " ${SHIM_GH_NO_COMMIT:-} " in
    *" $sha "*) printf '{"message":"No commit found for SHA: %s","status":"422"}' "$sha"; echo "gh: No commit found for SHA: $sha (HTTP 422)" >&2; exit 1 ;;
  esac
  printf '%s\n' "$sha"; exit 0
fi
if [ "$*" = "auth git-credential get" ]; then
  cat > /dev/null
  case "${SHIM_GH_CRED:-}" in none) exit 1 ;; hang) sleep 30 ;; esac
  case "${SHIM_GH_CRED:-}" in dead) tok=dead-token ;; other) tok=other-token ;; slowcheck) tok=slow-token ;; *) tok=shim-token ;; esac
  printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n' "$tok"; exit 0
fi
if [ "$*" = "auth token -h github.com" ]; then
  [ -z "${GH_TOKEN+x}${GITHUB_TOKEN+x}" ] || { echo "gh shim: auth token asked with a token variable set"; exit 3; }
  case "${SHIM_GH_STORED:-}" in '') echo "no oauth token found for github.com" >&2; exit 1 ;; hang) sleep 30 ;; esac
  printf '%s\n' "$SHIM_GH_STORED"; exit 0
fi
[ "$*" = "api --hostname github.com user -q .login" ] || { echo "gh shim: unexpected call: $*" >&2; exit 2; }
[ -z "${SHIM_GH_SLOW:-}" ] || sleep "$SHIM_GH_SLOW"
[ "${GH_TOKEN:-}" != dead-token ] || { echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; }
[ "${GH_TOKEN:-}" != other-token ] || { echo other-user; exit 0; }
[ "${GH_TOKEN:-}" != slow-token ] || sleep 30
[ -z "${SHIM_GH_DEAD_WHEN:-}" ] || [ ! -e "$SHIM_GH_DEAD_WHEN" ] || { echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; }
case "${SHIM_GH:-}" in
  401) printf '{\n  "message": "Bad credentials",\n  "status": "401"\n}'; echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
  noauth) printf 'To get started with GitHub CLI, please run:  gh auth login\n' >&2; exit 4 ;;
  down) printf 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n' >&2; exit 1 ;;
  5xx) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;
  hang) sleep 30 ;;
esac
echo "${SHIM_GH_LOGIN:-shim-user}"
SHIMEOF
chmod +x "$TMP/bin/claude" "$TMP/bin/codex" "$TMP/bin/tmux" "$TMP/bin/ssh" "$TMP/bin/gh"
export SHIM_GH_COMMIT_LOG="$TMP/gh-commits.log"
# Through GIT_CONFIG_GLOBAL, not ~/.gitconfig: some sections preflight under a HOME of their own.
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
git config --global --add credential.https://github.com.helper ""
git config --global --add credential.https://github.com.helper "!gh auth git-credential"

# --- the real checkout, installed by the README's own loops, must pass the preflight ---------
# The scratch checkout further down is built to the layout the preflight expects, so the two
# can agree with each other while both disagree with the repository: after the extraction into
# this repo the preflight went on scanning a ClaudeDesktop/ tree that no longer existed, and the
# suite passed (ludics-lite#16). This pins the served-tree assumption to the actual tree. The
# commit this test lives in is pushed to a scratch origin, cloned to ~/ludics-lite under a
# scratch HOME, installed with the install loops extracted from README.md (minus their git
# clone), and preflighted for both worker kinds, so the README's loop and the preflight's
# expected link target are read from where they live rather than restated here.
section "the real checkout under the README's install loops" && {
real_top=$(git -C "$HERE" rev-parse --show-toplevel)
readme_block() { # <text>: the first fenced code block of README.md containing the text
  awk -v want="$1" '
    /^```/ { if (inblock) { if (index(block, want)) { printf "%s", block; exit } block = "" }; inblock = !inblock; next }
    inblock { block = block $0 "\n" }
  ' "$real_top/README.md"
}
real_home="$TMP/real-home"; real_origin="$TMP/real-origin.git"
mkdir -p "$real_home"
git init -q --bare "$real_origin"
git -C "$real_top" push -q "$real_origin" HEAD:refs/heads/main || ko "could not push the real checkout's HEAD to the scratch origin (setup, not the launcher)"
# Use the transport even for a local path: push can leave background object maintenance
# running, and a local clone's hardlink walk races with repacking (seen in PR #149).
git clone --no-local -q -b main "$real_origin" "$real_home/ludics-lite" || ko "could not clone the scratch origin (setup, not the launcher)"
claude_loop=$(readme_block 'ludics-lite/*/' | grep -v '^git clone ')
codex_loop=$(readme_block 'for s in ship-pr wait-and-proceed after-merge' | grep -v '^git clone ')
[ -n "$claude_loop" ] && [ -n "$codex_loop" ] && ok "README.md carries both install loops" || ko "could not find the README's install loops"
( export HOME="$real_home"; eval "$claude_loop" && eval "$codex_loop" ) || ko "the README's install loops failed: $claude_loop $codex_loop"

# Read the layout rather than naming today's skills. A new top-level directory has to declare
# itself as infrastructure here, or carry SKILL.md and therefore become part of the install set.
# What the repository tracks, not what the working tree holds: the agent harness writes an
# untracked `.claude/` into every checkout it opens, so reading the working tree failed this guard
# on every local run while CI, whose actions/checkout leaves no such scratch, stayed green -- a
# suite whose one local failure is always the same false positive is a suite people stop reading.
# Tracked paths close the class rather than one name (post-merge-cleanup.sh, which has to judge a
# real checkout rather than a declaration, exempts `.claude/` by name instead). `.git` is never
# tracked, so unlike under `find` it no longer has to be declared.
non_skill_dirs=".github lib routines scripts"
top_dirs() { # <checkout>: the top-level directories the repository declares, one per line
  git -C "$1" ls-files -z | while IFS= read -r -d '' path; do
    case $path in */*) printf '%s\n' "${path%%/*}" ;; esac
  done | sort -u
}
is_tracked_skill() { # <checkout> <name>: does that top-level directory declare a SKILL.md?
  git -C "$1" ls-files --error-unmatch -- "$2/SKILL.md" >/dev/null 2>&1
}
undeclared_dirs() { # <checkout>: declared directories that are neither a skill nor infrastructure
  top_dirs "$1" | while IFS= read -r name; do
    is_tracked_skill "$1" "$name" && continue
    declared=0
    for non_skill in $non_skill_dirs; do [ "$name" = "$non_skill" ] && declared=1; done
    [ "$declared" -eq 1 ] || printf ' %s' "$name"
  done
}
tree_skills=$(top_dirs "$real_top" | while IFS= read -r name; do
  is_tracked_skill "$real_top" "$name" && printf '%s\n' "$name"
done)
unknown_dirs=$(undeclared_dirs "$real_top")
[ -n "$tree_skills" ] && [ -z "$unknown_dirs" ] \
  && ok "every top-level directory is a skill or a declared non-skill ($non_skill_dirs)" \
  || ko "top-level directories without SKILL.md outside the declared non-skill set:$unknown_dirs"

# Both halves of that reading, on a clone of the real tree: the untracked scratch the harness
# leaves behind stays invisible, and a directory the tree actually gains -- declaring neither
# SKILL.md nor infrastructure -- still trips the guard, which is the whole point of having it.
guard_clone="$TMP/guard-clone"
git clone --no-local -q -b main "$real_origin" "$guard_clone" || ko "could not clone the scratch origin for the layout guard (setup, not the launcher)"
mkdir -p "$guard_clone/.claude/skills" && : > "$guard_clone/.claude/settings.json"
untracked_verdict=$(undeclared_dirs "$guard_clone")
[ -z "$untracked_verdict" ] \
  && ok "an untracked top-level directory does not reach the layout guard" \
  || ko "an untracked top-level directory tripped the layout guard:$untracked_verdict"
mkdir -p "$guard_clone/newthing" && : > "$guard_clone/newthing/notes.md"
git -C "$guard_clone" add newthing/notes.md || ko "could not track the guard clone's new directory (setup, not the launcher)"
tracked_verdict=$(undeclared_dirs "$guard_clone")
[ "$tracked_verdict" = " newthing" ] \
  && ok "...while a tracked directory that is neither a skill nor declared infrastructure trips it" \
  || ko "the layout guard missed a tracked undeclared top-level directory (verdict:$tracked_verdict)"

linked_skills=$(find "$real_home/.claude/skills" -mindepth 1 -maxdepth 1 -type l -exec basename {} \; | sort)
[ "$linked_skills" = "$tree_skills" ] \
  && ok "the README's Claude loop links exactly the skills the tree declares" \
  || ko "the README's Claude loop and tree disagree (tree: $tree_skills; links: $linked_skills)"

# Read the lint steps' patterns from the checkout rather than restating them: restating them here
# would let the test and workflow drift together. Until ludics-lite#221 that meant slicing them out
# of the workflow's own `run:` blocks; the list now lives once in scripts/preflight.sh, which the
# lint job calls, and `preflight.sh globs` is the reading of it. What this guard no longer sees on
# its own is a lint step rewritten to sweep something ELSE inline -- the globs would still be read
# from the script while CI ran the inline copy. That is scripts/test-preflight.sh's pin (every
# lint `run:` is preflight.sh or a command in its step table), and the two are the whole claim.
# Every shell file must be covered by BOTH the syntax and shellcheck step, which is one list today.
lint_globs() { # lint_globs <checkout>
  "$1/scripts/preflight.sh" globs
}
workflow_matches() { # workflow_matches <checkout> <newline-separated patterns>: the paths they cover
  # Expand the patterns the way the workflow's own shell does, over a tree holding exactly what the
  # repository TRACKS -- mirrored here as empty files, since only the paths decide the match.
  # Tracked paths on this side too, for the reason the other side reads them: expanding into the
  # checkout answers what the worktree HOLDS, so a tracked script the worktree is missing (an
  # unstaged deletion, a sparse checkout) would be matched by no pattern and reported uncovered,
  # which is the very false positive this guard was fixed for. Re-implementing the expansion over
  # a list of paths instead is the trap: `case` lets `*` cross a slash, and git's `:(glob)`
  # pathspec stops that but still matches a leading `.`, which bash does only under `dotglob` --
  # so a tracked `.github/scripts/check.sh` would read as covered while the workflow's glob never
  # expands to it. Mirroring keeps every rule of the expansion with the shell that has them.
  local checkout="$1" patterns="$2" mirror path matched
  mirror=$(mktemp -d "$TMP/glob-mirror.XXXXXX") || return 1
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    case $path in */*) mkdir -p "$mirror/${path%/*}" || return 1 ;; esac
    : > "$mirror/$path" || return 1
  done <<EOF
$(tracked_shell_files "$checkout")
EOF
  (
    cd "$mirror" || exit 1
    while IFS= read -r pattern; do
      [ -n "$pattern" ] || continue
      # Unquoted on purpose: this is the workflow's own pathname expansion, run by the same shell
      # over the same names. Only `*.sh` is mirrored, and every pattern ends in `.sh`.
      # shellcheck disable=SC2086
      for matched in $pattern; do [ -f "$matched" ] && printf '%s\n' "$matched"; done
    done <<EOF
$patterns
EOF
  ) | sort -u
  rm -rf "$mirror"
}
tracked_shell_files() { # <checkout>: the shell scripts the repository tracks, one per line
  # Tracked paths, for the reason the layout guard above reads them: CI's lint steps run over an
  # actions/checkout, which holds no untracked file, so a scratch `*.sh` an agent leaves in a local
  # worktree is not something these globs were ever meant to cover -- and under `find` it failed
  # this guard with a message about the workflow. `*.sh` here is a git pathspec, not a pathname
  # glob: its `*` crosses `/`, so it matches at every depth, which is what this guard wants, since
  # the workflow's globs cover nested paths too.
  git -C "$1" ls-files -z -- '*.sh' | while IFS= read -r -d '' path; do printf '%s\n' "$path"; done | sort
}
uncovered_shell_files() { # <checkout>: "<step>:<path>" for every tracked script a lint step misses
  local syntax_files shellcheck_files uncovered="" f
  # Both steps sweep the one list, so these two are the same set today; they stay separate
  # because the claim the verdict makes is per step, and a step given a narrower list of its own
  # would be read here without another edit.
  syntax_files=$(workflow_matches "$1" "$(lint_globs "$1")")
  shellcheck_files=$(workflow_matches "$1" "$(lint_globs "$1")")
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -Fqx -- "$f" <<<"$syntax_files" || uncovered="$uncovered bash-n:$f"
    grep -Fqx -- "$f" <<<"$shellcheck_files" || uncovered="$uncovered shellcheck:$f"
  done <<EOF
$(tracked_shell_files "$1")
EOF
  printf '%s' "$uncovered"
}
syntax_globs=$(lint_globs "$real_top")
shellcheck_globs=$syntax_globs
uncovered=$(uncovered_shell_files "$real_top")
[ -n "$syntax_globs" ] && [ -n "$shellcheck_globs" ] && [ -z "$uncovered" ] \
  && ok "the lint job's own syntax and shellcheck globs cover every shell script in the tree" \
  || ko "lint shell globs are missing or leave files uncovered:$uncovered (bash -n: $syntax_globs; shellcheck: $shellcheck_globs)"

# Both halves of that reading, on the layout guard's clone: the scratch script an agent drops in a
# worktree stays invisible, and the same path once the tree TRACKS it -- at the root, where none of
# the workflow's globs reach -- is still reported against both lint steps.
printf '#!/usr/bin/env bash\ntrue\n' > "$guard_clone/scratch-probe.sh"
untracked_sh_verdict=$(uncovered_shell_files "$guard_clone")
[ -z "$untracked_sh_verdict" ] \
  && ok "an untracked shell script does not reach the lint-coverage guard" \
  || ko "an untracked shell script tripped the lint-coverage guard:$untracked_sh_verdict"
git -C "$guard_clone" add scratch-probe.sh || ko "could not track the guard clone's scratch script (setup, not the launcher)"
tracked_sh_verdict=$(uncovered_shell_files "$guard_clone")
[ "$tracked_sh_verdict" = " bash-n:scratch-probe.sh shellcheck:scratch-probe.sh" ] \
  && ok "...while a tracked shell script no lint glob covers trips it" \
  || ko "the lint-coverage guard missed a tracked uncovered shell script (verdict:$tracked_sh_verdict)"
rm "$guard_clone/scratch-probe.sh" "$guard_clone/scripts/sync-routines.sh" \
  || ko "could not remove the guard clone's shell scripts (setup, not the launcher)"
missing_sh_verdict=$(uncovered_shell_files "$guard_clone")
[ "$missing_sh_verdict" = " bash-n:scratch-probe.sh shellcheck:scratch-probe.sh" ] \
  && ok "...and both sides read the declaration: a covered script the worktree is missing stays covered" \
  || ko "a tracked script absent from the worktree changed the lint-coverage verdict (verdict:$missing_sh_verdict)"
# A hidden directory is the one place the expansion's rules decide the verdict rather than merely
# where it reads from: `*/scripts/*.sh` does not reach `.github/scripts/`, because bash matches a
# leading `.` only when the pattern spells it, so a script there is genuinely unlinted in CI.
mkdir -p "$guard_clone/.github/scripts" && : > "$guard_clone/.github/scripts/check.sh"
git -C "$guard_clone" add .github/scripts/check.sh || ko "could not track the guard clone's hidden-directory script (setup, not the launcher)"
hidden_sh_verdict=$(uncovered_shell_files "$guard_clone")
[ "$hidden_sh_verdict" = " bash-n:.github/scripts/check.sh shellcheck:.github/scripts/check.sh bash-n:scratch-probe.sh shellcheck:scratch-probe.sh" ] \
  && ok "...and a tracked script under a hidden directory, which the workflow's glob never expands to, trips it" \
  || ko "the lint-coverage guard read a hidden-directory script as covered (verdict:$hidden_sh_verdict)"

[ -L "$real_home/.claude/skills/ship-pr" ] && ok "the README's loop links ship-pr" || ko "the README's loop did not link ship-pr into ~/.claude/skills"
[ ! -e "$real_home/.claude/skills/routines" ] && ok "the README's loop keeps routines/ out of ~/.claude/skills" || ko "the README's loop linked routines/ into ~/.claude/skills"
[ ! -e "$real_home/.claude/skills/scripts" ] && ok "...and scripts/ too" || ko "the README's loop linked scripts/ into ~/.claude/skills"
# FLEET_SKILLS_REPO is at its default here on purpose: ~/ludics-lite is where the README clones
# to, and the default must agree with it. Unset explicitly, since a configured fleet environment
# exports it, and an absolute value would send this preflight to the box's real checkout.
expect "the real checkout, installed the README's way, passes the claude preflight" 0 "PREFLIGHT OK" -- \
  env -u FLEET_SKILLS_REPO HOME="$real_home" "$FW" preflight testbox --no-probe
expect "...and the codex preflight" 0 "PREFLIGHT OK" -- \
  env -u FLEET_SKILLS_REPO HOME="$real_home" "$FW" preflight testbox --codex --no-probe
unverified_skills=""
while IFS= read -r s; do
  [ -n "$s" ] || continue
  rm "$real_home/.claude/skills/$s"
  missing_out=$(env -u FLEET_SKILLS_REPO HOME="$real_home" "$FW" preflight testbox --no-probe 2>&1); missing_rc=$?
  if [ "$missing_rc" -ne 1 ] || ! grep -Fq ".claude/skills/$s -> missing" <<<"$missing_out"; then
    unverified_skills="$unverified_skills $s"
  fi
  ln -sfn "$real_home/ludics-lite/$s" "$real_home/.claude/skills/$s"
done <<EOF
$tree_skills
EOF
[ -z "$unverified_skills" ] \
  && ok "production preflight refuses every skill link derived from the tree when it is missing" \
  || ko "production preflight did not refuse these missing derived skill links:$unverified_skills"
}
section_left   # here, so the shared setup below is not timed as this section

# --- a scratch skills checkout with an origin, deployed the way the README deploys it --------
origin="$TMP/origin.git"; repo="$TMP/ludics lite"
git init -q --bare "$origin"
git init -q -b main "$repo"
for s in issue-wave ship-pr wait-and-proceed after-merge; do
  mkdir -p "$repo/$s"; echo "# $s" > "$repo/$s/SKILL.md"
  ln -sfn "$repo/$s" "$HOME/.claude/skills/$s"
done
for s in ship-pr wait-and-proceed after-merge; do ln -sfn "$repo/$s" "$HOME/.codex/skills/$s"; done
git -C "$repo" add -A && git -C "$repo" commit -q -m init
git -C "$repo" remote add origin "$origin" && git -C "$repo" push -q -u origin main
export FLEET_SKILLS_REPO="$repo"

# --- setup every section shares ---------------------------------------------------------------
# The project repo and the brief live here, not in the launch section, so a later section selected
# on its own still finds them; the two helpers below take what only some sections need.
proj="$TMP/pro j"; git init -q -b master "$proj" && echo a > "$proj/a" && git -C "$proj" add a && git -C "$proj" commit -q -m a
git init -q --bare "$TMP/proj.git" && git -C "$proj" remote add origin "$TMP/proj.git" && git -C "$proj" push -q -u origin master
export BASE_PROJECT="$proj"
brief="$TMP/brief.md"; printf 'Fix issue #1: handle `$(rm -rf /)` and `backticks` in prose\n' > "$brief"
# The unstick message: the unstick, codex and usage sections all pass it to `unstick --message`.
printf 'Stop and answer now.\n' > "$TMP/msg.md"
# A second coordinator: its own state dir (own token), the same anchor state.
B=(env ISSUE_WAVE_STATE="$TMP/state-b" FLEET_ANCHOR_STATE="$ISSUE_WAVE_STATE" "$FW")
# need_lease: the coordinator lease, held by us -- what every section from the launches on assumes.
# The lease section leaves it unheld and the launch section claims it, and a claim by the holder is
# idempotent, so this is a no-op in a full run.
need_lease() { "$FW" claim >/dev/null || ko "could not claim the coordinator lease (setup, not the launcher)"; }
# settle <name>: wait for the worker's turn to end, then end the worker. A claude worker's process
# outlives its turns (ludics-lite#259) and an IDLE one still owns its worktree, so a case that
# needs it finished closes it; for a worker that already ended, close prints its verdict.
settle() { "$FW" attach testbox "$1" --interval 1 >/dev/null 2>&1; "$FW" close testbox "$1" >/dev/null 2>&1; }
# need_worker <name>: a finished worker and its worktree, as the launch section leaves behind for
# the sections that read one. A no-op once that section has run.
need_worker() {
  [ -d "$ISSUE_WAVE_STATE/workers/$1" ] && return 0
  need_lease
  "$FW" launch testbox "$1" --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch "claude/$1" >/dev/null &&
    settle "$1" && [ -f "$ISSUE_WAVE_STATE/workers/$1/exit" ] ||
    ko "could not prepare worker $1 (setup, not the launcher)"
}

section "base gate" && {
need_lease
for verdict in 1 3 4; do
  expect "native gate blocks base exit $verdict with diagnostics" 1 "job broken; first red commit deadbee" -- \
    env SHIM_BASE_RC="$verdict" SHIM_BASE_MESSAGE="job broken; first red commit deadbee" "$FW" gate --target-repo example/project --base-branch topic
  expect "CLI blocks base exit $verdict before creating worker" 1 "dispatch blocked" -- \
    env SHIM_BASE_RC="$verdict" "$FW" launch testbox base-red --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/base-red
  [ ! -e "$ISSUE_WAVE_STATE/workers/base-red" ] && [ ! -e "$proj-worktrees/base-red" ] && ok "refusal left no worker or checkout" || ko "base refusal wrote worker state"
done
expect "native green pins target and wait despite ambient settings" 0 "BASE GREEN" -- env REPO=wrong/repo SHIP_PR_BASE_ABSENT_GRACE=0 SHIP_PR_ADVISORY_CHECKS=.* SHIP_PR_TEST_SOURCE_ONLY=1 SHIP_PR_CHECKS_INTERVAL=0 SHIP_PR_CHECKS_WAIT=0 SHIP_PR_CHECKS_HEARTBEAT=0 SHIP_PR_API_ATTEMPTS=0 SHIP_PR_API_BACKOFF=0 "$FW" gate --target-repo example/project --base-branch topic
expect "missing repository refuses" 2 "--target-repo" -- "$FW" gate
expect "triage force cannot bypass red base" 1 "dispatch blocked" -- env SHIM_BASE_RC=1 "$FW" gate --target-repo example/project --force
expect "explicit red triage override passes with reason" 0 "BASE TRIAGE OVERRIDE: example/project default branch: fix broken job" -- env SHIM_BASE_RC=1 "$FW" gate --target-repo example/project --force --allow-red-base 'fix broken job'
expect "override needs force" 2 "requires --force" -- "$FW" gate --target-repo example/project --allow-red-base fix
for verdict in 3 4; do
  expect "triage cannot override unknown $verdict" 1 "dispatch blocked" -- env SHIM_BASE_RC="$verdict" "$FW" gate --target-repo example/project --force --allow-red-base fix
done
expect "missing helper refuses with unknown diagnostic" 1 "checker missing" -- env SHIM_BASE_RC=0 bash -c 'mv "$1" "$1.saved"; "$2" gate --target-repo example/project; rc=$?; mv "$1.saved" "$1"; exit "$rc"' _ "$TMP/dispatcher/ship-pr/scripts/pr-review.sh" "$FW"
# Installed, the script is reached through ~/.claude/skills/issue-wave, a symlink: ship-pr's helper
# is found from the checkout the link points into, not beside the link, so a skills directory that
# holds no ship-pr link of its own still reaches it. A plain `cd` passes that alone -- bash retries a
# logical path that does not exist as a physical one -- so the decoy is what tells the two apart: a
# ship-pr beside the link that is some other checkout's, which a collapsed `..` would find first.
mkdir -p "$TMP/lone-skills" && ln -s "$TMP/dispatcher/issue-wave" "$TMP/lone-skills/issue-wave"
expect "the gate finds ship-pr's helper through an issue-wave symlink alone" 0 "BASE GREEN" -- \
  "$TMP/lone-skills/issue-wave/scripts/fleet-worker.sh" gate --target-repo example/project --base-branch topic
mkdir -p "$TMP/lone-skills/ship-pr/scripts" && printf '#!/usr/bin/env bash\necho "DECOY CHECKER"; exit 1\n' > "$TMP/lone-skills/ship-pr/scripts/pr-review.sh" &&
  chmod +x "$TMP/lone-skills/ship-pr/scripts/pr-review.sh" || ko "could not plant the decoy ship-pr (setup)"
expect "...and from that checkout, not from a ship-pr beside the link" 0 "BASE GREEN" -- \
  "$TMP/lone-skills/issue-wave/scripts/fleet-worker.sh" gate --target-repo example/project --base-branch topic
grep -q "DECOY" <<<"$out" && ko "the gate read the decoy checker beside the link: $out" || ok "...and the decoy was never read"
grep -Fxq -- '--repo example/project base topic --wait=360 --interim --advisory-red FILE grace=300 interval=60' "$BASE_CALL_LOG" && ok "explicit native branch passed to coordinator helper" || ko "native branch lost"
grep -Fxq -- '--repo example/project base master --wait=360 --interim --advisory-red FILE grace=300 interval=60' "$BASE_CALL_LOG" && ok "worktree base branch passed to coordinator helper" || ko "worktree base lost"
# The value itself, and the relation behind it: 360 is 300 + 60, a whole round of margin over the
# grace. `--wait=301` left a one-second margin that one round's API latency swallowed, so the gate
# reached its ceiling and refused dispatch for a docs-only tip the next round would have settled
# (ludics-lite#175); the checker now warns loudly about that band, and nothing here may spell it.
grep -q -- '--wait=301 ' "$BASE_CALL_LOG" && ko "the hand-spelled 301 ceiling is back" || ok "no base read carries a ceiling inside the grace's own round"
# A red only in jobs the repository's advisory file names (ludics-lite#651) is the checker's to
# take out of the verdict under --advisory-red, and it hands the jobs back in the file at its
# green: the gate admits and names each one. The checker's side -- which red is advisory-only,
# and that a required red or an unreadable list keeps the red -- is pinned in
# test-pr-review-base-red.sh; what is here is the gate reading the file, fail closed.
adv_sha=0123456789abcdef0123456789abcdef01234567
adv_row='{"workflow":"skill scripts","sha":"'"$adv_sha"'","run":"7","job":"bash 3.2 suites, a (macos)","conclusion":"failure"}'
expect "an advisory-only red is admitted, each job named with its commit" 0 \
  "ADVISORY-RED: 'bash 3.2 suites, a (macos)' at $adv_sha; launching" -- \
  env SHIM_BASE_ADVISORY_RED="[$adv_row,${adv_row/a (macos)/b (macos)}]" "$FW" gate --target-repo example/project --base-branch topic
grep -Fq "ADVISORY-RED: 'bash 3.2 suites, b (macos)' at $adv_sha; launching" <<<"$out" && ok "...one line per job" || ko "the second job was not named: $out"
expect "a green with no advisory red names none" 0 "BASE GREEN" -- "$FW" gate --target-repo example/project --base-branch topic
grep -q "ADVISORY-RED" <<<"$out" && ko "a plain green printed an advisory line: $out" || ok "...and prints no ADVISORY-RED line"
for bad in '' '{}' '[{"job":"x"}]' '[{"job":"","sha":"'"$adv_sha"'"}]' 'not json'; do
  expect "a green whose advisory-red file reads $(printf %q "$bad") refuses" 1 "without a readable advisory-red record" -- \
    env SHIM_BASE_ADVISORY_RED="$bad" "$FW" gate --target-repo example/project --base-branch topic
done
expect "an advisory-only red launches through the CLI too" 0 "ADVISORY-RED: 'bash 3.2 suites, a (macos)' at $adv_sha; launching" -- \
  env SHIM_BASE_ADVISORY_RED="[$adv_row]" "$FW" launch testbox advisory-red --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/advisory-red
settle advisory-red
original_base=$(git -C "$proj" rev-parse origin/master)
later_base=$(git -C "$proj" commit-tree 'HEAD^{tree}' -p HEAD -m later)
expect "new worktree uses confirmed SHA despite later ref movement" 0 "LAUNCHED testbox/pinned-base" -- env SHIM_MOVE_REF_AFTER_CONFIRM="$later_base" "$FW" launch testbox pinned-base --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/pinned-base
settle pinned-base
[ "$(git -C "$proj-worktrees/pinned-base" rev-parse HEAD)" = "$original_base" ] && ok "worktree starts from pinned SHA" || ko "worktree followed moving ref"
git -C "$proj" update-ref refs/remotes/origin/master "$original_base"
expect "target movement refuses new worktree" 1 "differs from fetched base" -- env SHIM_BASE_TIP=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$FW" launch testbox moved-base --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/moved-base
[ ! -e "$proj-worktrees/moved-base" ] && ok "moved base created no worktree" || ko "moved base created worktree"
expect "unreadable target confirmation blocks" 1 "cannot confirm" -- env SHIM_BASE_TIP_FAIL=1 "$FW" launch testbox unread-base --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/unread-base
expect "base read follows freshness preflight" 1 "dispatch blocked" -- env SHIM_BASE_REQUIRE_PREFLIGHT="$TMP/preflight-ran" SHIM_BASE_RC=1 "$FW" launch testbox base-order --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
"$FW" release >/dev/null
}

section "coordinator lease" && {
expect "no identity at all is refused, not guessed" 2 "no coordinator identity" -- env -u FLEET_COORDINATOR "$FW" claim
expect "a Codex thread id supplies the coordinator identity" 3 "nobody holds the lease" -- \
  env -u FLEET_COORDINATOR CODEX_THREAD_ID=test-thread "$FW" coordinator
mkdir "$ISSUE_WAVE_STATE/COORDINATOR.lock" 2>/dev/null || { mkdir -p "$ISSUE_WAVE_STATE"; mkdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"; }
expect "a first claim also waits on the lease lock and fails after the bound" 1 "CLAIM FAILED: lease lock" -- env FLEET_LOCK_WAIT=1 "$FW" claim
rmdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"
expect "coordinator: nobody yet, exit 3" 3 "nobody holds the lease" -- "$FW" coordinator
expect "claim takes the lease" 0 "CLAIMED coordinator lease on testbox" -- "$FW" claim
expect "claim again is idempotent for the holder" 0 "CLAIMED already held" -- "$FW" claim
expect "coordinator: me" 0 "COORDINATOR: you" -- "$FW" coordinator
expect "a second coordinator's claim is refused while held" 1 "CLAIM REFUSED: coordinator lease held by" -- "${B[@]}" claim
expect "a second coordinator cannot halt" 1 "HALT REFUSED fleet: coordinator lease held by" -- "${B[@]}" halt "not mine"
mkdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"
expect "resume-launches waits for the lease lock and fails after the bound" 1 "RESUME-LAUNCHES FAILED: lease lock" -- env FLEET_LOCK_WAIT=1 "$FW" resume-launches
rmdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"
expect "release by a non-holder is refused" 1 "RELEASE REFUSED" -- "${B[@]}" release
expect "--take adopts the lease" 0 "CLAIMED (adopted) coordinator lease" -- "${B[@]}" claim --take
expect "the previous holder now sees the lease as not theirs" 1 "(not you)" -- "$FW" coordinator
expect "...and takes it back with --take" 0 "CLAIMED (adopted)" -- "$FW" claim --take
expect "another session on the same box (same state dir) is not the holder" 1 "CLAIM REFUSED" -- env FLEET_COORDINATOR=other-session "$FW" claim
expect "...and cannot launch through the holder's token" 1 "coordinator lease held by" -- env FLEET_COORDINATOR=other-session "$FW" launch testbox nope --target-repo example/project --kind claude --brief /dev/null --cwd "$TMP"
# Two adopters at once: the takeover lock serializes them, exactly one holds afterwards.
env FLEET_COORDINATOR=race-a "$FW" claim --take >"$TMP/race-a.out" 2>&1 & ra=$!
env FLEET_COORDINATOR=race-b "$FW" claim --take >"$TMP/race-b.out" 2>&1 & rb=$!
wait "$ra" "$rb"
holders=0
ra=$(env FLEET_COORDINATOR=race-a "$FW" coordinator 2>&1); grep -q "COORDINATOR: you" <<<"$ra" && holders=$((holders + 1))
rb=$(env FLEET_COORDINATOR=race-b "$FW" coordinator 2>&1); grep -q "COORDINATOR: you" <<<"$rb" && holders=$((holders + 1))
[ "$holders" -eq 1 ] && ok "concurrent takeovers leave exactly one holder" || ko "concurrent takeovers: $holders holders -- $(cat "$TMP/race-a.out" "$TMP/race-b.out")"
[ -d "$ISSUE_WAVE_STATE/COORDINATOR.lock" ] && ko "takeover lock left behind" || ok "takeover lock released"
mkdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"
expect "a held lease lock makes --take fail after the bounded wait" 1 "CLAIM FAILED: lease lock" -- env FLEET_LOCK_WAIT=1 "$FW" claim --take
expect "release under a held lease lock fails after the bounded wait, not silently" 1 "RELEASE FAILED: lease lock" -- env FLEET_LOCK_WAIT=1 "$FW" release
rmdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"
"$FW" claim --take >/dev/null
mkdir -p "$TMP/state-c"; : > "$TMP/state-c/tokens"
expect "a token that cannot be persisted refuses the claim" 1 "CLAIM REFUSED: cannot persist" -- env ISSUE_WAVE_STATE="$TMP/state-c" FLEET_ANCHOR_STATE="$ISSUE_WAVE_STATE" FLEET_COORDINATOR=c "$FW" claim --take
grep -q '^token=$' "$ISSUE_WAVE_STATE/COORDINATOR" && ko "an empty token reached the lease" || ok "no empty-token lease was written"
"$FW" release >/dev/null 2>&1
env FLEET_COORDINATOR=fresh "$FW" claim >"$TMP/fresh-a.out" 2>&1 & fa=$!
env FLEET_COORDINATOR=fresh "$FW" claim >"$TMP/fresh-b.out" 2>&1 & fb=$!
wait "$fa" "$fb"
expect "two first claims of one new identity leave that identity holding" 0 "COORDINATOR: you" -- env FLEET_COORDINATOR=fresh "$FW" coordinator
env FLEET_COORDINATOR=fresh "$FW" release >/dev/null; "$FW" claim >/dev/null
expect "an identity outside the safe set is refused, not folded" 2 "coordinator identity 'team/a' must be" -- env FLEET_COORDINATOR=team/a "$FW" claim
chmod 555 "$ISSUE_WAVE_STATE"
expect "release on an unwritable anchor fails at once, not after the lock wait" 1 "RELEASE FAILED: lease lock on testbox: cannot create lock" -- "$FW" release
chmod 755 "$ISSUE_WAVE_STATE"
expect "release drops it" 0 "RELEASED coordinator lease" -- "$FW" release
expect "coordinator after release: nobody" 3 "nobody holds" -- "$FW" coordinator
# The lease lock is take_lock's: a lock whose recorded holder is dead (a coordinator killed mid
# mutation, a rebooted anchor) is reclaimed, not a wedge for every later claim.
mkdir "$ISSUE_WAVE_STATE/COORDINATOR.lock" && echo 999999 > "$ISSUE_WAVE_STATE/COORDINATOR.lock/pid"
expect "a lease lock left by a dead holder is reclaimed by the next claim" 0 "CLAIMED coordinator lease on testbox" -- env FLEET_LOCK_WAIT=1 "$FW" claim
[ -d "$ISSUE_WAVE_STATE/COORDINATOR.lock" ] && ko "the reclaimed lease lock was left behind" || ok "...and released afterwards"
"$FW" release >/dev/null
expect "claim refuses an unknown option" 2 "claim: unknown option --tak" -- "$FW" claim --tak
# Lease and halt live on the anchor: one that does not answer is unreachable (exit 4), never a
# refusal or a verdict about the lease.
for verb in claim release coordinator; do
  label=$(printf '%s' "$verb" | tr 'a-z' 'A-Z')
  expect "$verb against an anchor that does not answer is unreachable" 4 "^$label UNREACHABLE far-anchor$" -- env FLEET_ANCHOR=far-anchor "$FW" "$verb"
done
mkdir -p "$ISSUE_WAVE_STATE/COORDINATOR"
expect "claim --take that cannot write the lease fails, not CLAIMED" 1 "CLAIM FAILED: could not write" -- "$FW" claim --take
expect "a plain claim over an unwritable lease path fails too" 1 "CLAIM FAILED: could not write" -- "$FW" claim
rmdir "$ISSUE_WAVE_STATE/COORDINATOR"
}

section "preflight" && {
expect "clean main on origin passes (claude, live probe via shim)" 0 "PREFLIGHT OK" -- "$FW" preflight testbox
expect "clean main passes for codex (live probe via shim)" 0 "PREFLIGHT OK" -- "$FW" preflight testbox --codex
expect "a stalling skills fetch is bounded and refused" 1 "git fetch in .* timed out after 2s" -- env SHIM_GIT_HANG_FETCH=1 FLEET_FETCH_TIMEOUT=2 "$FW" preflight testbox --no-probe
# Cross-box reach (ludics-lite#57): a missing credential refuses, a box that is down is noted.
expect "a sibling refusing the key refuses the preflight" 1 "no non-interactive ssh to otherbox from testbox: .*Permission denied" -- env FLEET_BOXES="testbox otherbox" SHIM_SSH_DENY=otherbox "$FW" preflight testbox --no-probe
expect "a sibling that does not answer is noted on the OK line" 0 "PREFLIGHT OK.*cross-box unreachable, asleep or off the network: otherbox" -- env FLEET_BOXES="testbox otherbox" SHIM_SSH_DOWN=otherbox "$FW" preflight testbox --no-probe
expect "a reachable sibling adds nothing to the OK line" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- env FLEET_BOXES="testbox otherbox" "$FW" preflight testbox --no-probe
expect "--no-cross skips the reach probe" 0 "PREFLIGHT OK" -- env FLEET_BOXES="testbox otherbox" SHIM_SSH_DENY=otherbox "$FW" preflight testbox --no-probe --no-cross
expect "a sibling whose login never returns is bounded and noted, not hung" 0 "PREFLIGHT OK.*otherbox(no answer in 2s)" -- env FLEET_BOXES="testbox otherbox" SHIM_SSH_HANG=otherbox FLEET_CROSS_TIMEOUT=2 "$FW" preflight testbox --no-probe
# The same through the DEFAULT roster (ludics-lite#320): tuf-amd-linux has no Wake-on-LAN and is woken by
# hand, so from mac-studio it is often the one sibling asleep. Its silence is a note naming it
# alone, never a refusal, and rog and minix answering add nothing (the `$` anchor says so).
expect "mac-studio with the default roster notes a sleeping TUF and still passes" 0 "PREFLIGHT OK mac-studio skills=[0-9a-f]* (cross-box unreachable, asleep or off the network: tuf-amd-linux)$" -- \
  env -u FLEET_BOXES FLEET_LOCAL_BOX=mac-studio SHIM_SSH_DOWN=tuf-amd-linux "$FW" preflight mac-studio --no-probe
[ -d "$repo/.git/fleet-checkout.lock" ] && ko "preflight lock left after the bounded reach probe" || ok "preflight lock released after the bounded reach probe"
# The slot count per roster box is on the preflight's output (ludics-lite#329): it showed nowhere
# but in a batch's own slot line, so a day of one-slot Mac batches passed every preflight. Each
# case sets or unsets both variables itself.
# A one-slot count is matched as `mac-studio[=]1`: check-prompts reads the bare pair anywhere in
# this file as a statement of the site default, and this is a count the fixture configured.
PFROSTER="mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux"
PFM=(env FLEET_LOCAL_BOX=mac-studio "$FW" preflight mac-studio --no-probe --no-cross)
expect "preflight prints the site default's slot counts under an exported default roster" 0 "^PREFLIGHT SLOTS mac-studio=6 rog-nv-linux=4(gpu=2) minix-amd-linux=4 tuf-amd-linux=3 (site default)$" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS FLEET_BOXES="$PFROSTER" "${PFM[@]}"
grep -q "WARNING" <<<"$out" && ko "...and warns about a configuration that is the site default -- $out" || ok "...and warns about nothing"
# The other direction of that pairing: the boxes the site default widens, read off its own line,
# are exactly the boxes an empty spec warns about -- so a box added to the default and not to the
# warning's list (or the reverse) fails here.
pf_widened=$(sed -n 's/^PREFLIGHT SLOTS \(.*\) (site default)$/\1/p' <<<"$out" | tr ' ' '\n' | sed 's/(gpu=[0-9]*)$//' | awk -F= '$2 + 0 > 1 {print $1}' | sort | tr '\n' ' ')
expect "an empty spec under the default roster warns, box by box" 0 "does not name" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
pf_warned=$(sed -n 's/^PREFLIGHT SLOTS WARNING: .* does not name \([^,]*\), which falls.*/\1/p' <<<"$out" | sort | tr '\n' ' ')
[ -n "$pf_widened" ] && [ "$pf_widened" = "$pf_warned" ] && ok "...about exactly the boxes the site default widens: $pf_warned" \
  || ko "the collapse warning names '$pf_warned', the site default widens '$pf_widened'"
expect "...the same under an unset roster" 0 "^PREFLIGHT SLOTS mac-studio=6 .*(site default)$" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS -u FLEET_BOXES "${PFM[@]}"
expect "a spec that leaves mac-studio out under the default roster is a loud warning, not a refusal" 0 "PREFLIGHT SLOTS WARNING: the default roster, but FLEET_BOX_CORRECTNESS_SLOTS=\"rog-nv-linux=2\" does not name mac-studio, which falls to one slot" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-linux=2" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
grep -q "^PREFLIGHT OK mac-studio" <<<"$out" && grep -q "^PREFLIGHT SLOTS mac-studio[=]1 rog-nv-linux=2 minix-amd-linux=1 tuf-amd-linux=1 (FLEET_BOX_CORRECTNESS_SLOTS)$" <<<"$out" \
  && ok "...beside the OK line and the counts it names" || ko "the collapse warning lost the OK line or the counts -- $out"
expect "...as is an explicitly empty spec" 0 "PREFLIGHT SLOTS WARNING: .* does not name mac-studio" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
expect "a spec naming every widened box at one slot is a choice, printed without a warning" 0 "^PREFLIGHT SLOTS mac-studio[=]1 rog-nv-linux[=]1 minix-amd-linux[=]1 tuf-amd-linux[=]1 (FLEET_BOX_CORRECTNESS_SLOTS)$" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=1 rog-nv-linux=1 minix-amd-linux=1 tuf-amd-linux=1" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
grep -q "WARNING" <<<"$out" && ko "a spec naming every widened box at one slot drew a collapse warning -- $out" || ok "...and no warning"
# The hub's 2026-09-23 mitigation shape: a spec naming only the Mac collapses the native GPU boxes
# (ludics-lite#316), so it warns about each of them and not about mac-studio.
expect "a spec naming only mac-studio warns about each native GPU box it leaves at one slot" 0 "does not name rog-nv-linux, which falls to one slot" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=4" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
grep -q "does not name minix-amd-linux, which falls" <<<"$out" && grep -q "does not name tuf-amd-linux, which falls" <<<"$out" \
  && ! grep -q "does not name mac-studio" <<<"$out" \
  && ok "...minix-amd-linux and tuf-amd-linux too, and not the Mac it names" || ko "the per-box collapse warnings are wrong -- $out"
expect "a roster over several lines prints every box" 0 "^PREFLIGHT SLOTS mac-studio=6 rog-nv-linux=4(gpu=2) minix-amd-linux=4 tuf-amd-linux=3 (site default)$" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS FLEET_BOXES="mac-studio rog-nv-linux
minix-amd-linux tuf-amd-linux" "${PFM[@]}"
expect "a custom roster prints one slot each, without a warning" 0 "^PREFLIGHT SLOTS testbox=1 otherbox=1 (custom roster: one slot each)$" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS FLEET_BOXES="testbox otherbox" "$FW" preflight testbox --no-probe --no-cross
grep -q "WARNING" <<<"$out" && ko "a custom roster drew a collapse warning -- $out" || ok "...and no warning"
expect "a malformed spec is a warning on the preflight, which still passes" 0 "PREFLIGHT SLOTS WARNING: FLEET_BOX_CORRECTNESS_SLOTS names stale-box, which is not in FLEET_BOXES" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="stale-box=2" FLEET_BOXES="testbox otherbox" "$FW" preflight testbox --no-probe --no-cross
# The GPU tokens (ludics-lite#391) show beside a box's slots where they are fewer, and a token
# spec that leaves out a box the site default narrows is the same loud warning, paired the same
# way: the boxes the default shows with `(gpu=` are exactly the ones an empty token spec names.
env -u FLEET_BOX_CORRECTNESS_SLOTS FLEET_BOXES="$PFROSTER" "${PFM[@]}" > "$TMP/pf-tokens.out" 2>&1
pf_tokened=$(sed -n 's/^PREFLIGHT SLOTS \(.*\) (site default)$/\1/p' "$TMP/pf-tokens.out" | tr ' ' '\n' | sed -n 's/=.*(gpu=.*//p' | sort | tr '\n' ' ')
expect "an empty GPU-token spec under the default roster warns about the box it un-narrows" 0 "PREFLIGHT SLOTS WARNING: the default roster, but FLEET_BOX_GPU_TOKENS=\"\" does not name rog-nv-linux, so all 4 of its slots may hold its GPU at once (the site default allows 2)" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS FLEET_BOX_GPU_TOKENS="" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
pf_twarned=$(sed -n 's/^PREFLIGHT SLOTS WARNING: .*FLEET_BOX_GPU_TOKENS=.* does not name \([^,]*\), so all.*/\1/p' <<<"$out" | sort | tr '\n' ' ')
[ -n "$pf_tokened" ] && [ "$pf_tokened" = "$pf_twarned" ] && ok "...about exactly the boxes the site default narrows: $pf_twarned" \
  || ko "the token warning names '$pf_twarned', the site default narrows '$pf_tokened'"
grep -q "^PREFLIGHT SLOTS mac-studio=6 rog-nv-linux=4 minix-amd-linux=4 tuf-amd-linux=3 (site default; FLEET_BOX_GPU_TOKENS)$" <<<"$out" \
  && ok "...beside a slots line with no tokens and the override named" || ko "the un-narrowed slots line is wrong -- $out"
expect "a token spec naming rog-nv-linux at every slot is a choice, printed without a warning" 0 "^PREFLIGHT SLOTS mac-studio=6 rog-nv-linux=4 minix" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS FLEET_BOX_GPU_TOKENS="rog-nv-linux=4" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
grep -q "WARNING" <<<"$out" && ko "a token spec naming rog-nv-linux drew a warning -- $out" || ok "...and no warning"
expect "...and so is a slot spec that leaves rog-nv-linux no more slots than the token default" 0 "rog-nv-linux=2 minix" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=6 rog-nv-linux=2 minix-amd-linux=4 tuf-amd-linux=3" FLEET_BOX_GPU_TOKENS="" FLEET_BOXES="$PFROSTER" "${PFM[@]}"
grep -q "WARNING" <<<"$out" && ko "a two-slot rog-nv-linux drew a token warning -- $out" || ok "...with no warning"
expect "a malformed token spec is a warning on the preflight, which still passes" 0 "PREFLIGHT SLOTS WARNING: FLEET_BOX_GPU_TOKENS names stale-box, which is not in FLEET_BOXES" -- \
  env FLEET_BOX_GPU_TOKENS="stale-box=1" FLEET_BOXES="testbox otherbox" "$FW" preflight testbox --no-probe --no-cross
# The probe must not read the far-side program off stdin: a sibling that swallows its stdin would
# otherwise end the preflight early with status 0 over an earlier refusal (Codex P1 on #67).
echo x >> "$repo/ship-pr/SKILL.md"
expect "a reachable sibling does not swallow the refusal that follows the probe" 1 "1 local change(s) in the served tree" -- env FLEET_BOXES="testbox otherbox" SHIM_SSH_SLURP=otherbox "$FW" preflight testbox --no-probe
git -C "$repo" checkout -q -- ship-pr/SKILL.md
[ -d "$repo/.git/fleet-checkout.lock" ] && ko "preflight lock left after the bounded fetch" || ok "preflight lock released after the bounded fetch"
# `execution slot` runs a flock on the box that runs the batches, and since ludics-lite#403 every
# fleet-worker.sh verb there but the slot probe runs under scripts/py: the first Python >= 3.12 in
# its order (LUDICS_PY_CANDIDATES replaces the order). So the preflight asks the box that order --
# never a bare python3, which on a Mac's non-interactive ssh is Xcode's 3.9 -- and refuses a box
# where it finds none, or one that cannot import fcntl. The coordinator runs under scripts/py
# itself, so a box without one is `other` (SHIM_SSH_PY is its own candidate list), and the local
# box's fixture is an interpreter that is Python >= 3.12 for everything but fcntl.
real_py=$("$TMP/dispatcher/scripts/py" -c 'import sys; print(sys.executable)')
mkdir -p "$TMP/pys"
printf '#!/bin/sh\ncase "$*" in *"import fcntl"*) exit 1 ;; esac\nexec "%s" "$@"\n' "$real_py" > "$TMP/pys/py-nofcntl"
printf '#!/bin/sh\nexit 1\n' > "$TMP/pys/not-python"
printf '#!/bin/sh\necho 3.9.6; exit 1\n' > "$TMP/pys/old-python"
chmod +x "$TMP/pys/py-nofcntl" "$TMP/pys/not-python" "$TMP/pys/old-python"
expect "a box whose Python >= 3.12 cannot import fcntl refuses (the run-time slot lock needs it)" 1 \
  "PREFLIGHT REFUSED testbox: $TMP/pys/py-nofcntl, the Python >= 3.12 scripts/py would run here, cannot import fcntl" -- \
  env LUDICS_PY_CANDIDATES="$TMP/pys/py-nofcntl" "$FW" preflight testbox --no-probe --no-cross
expect "a box with no Python >= 3.12 in scripts/py's order refuses, naming what it found" 1 \
  "PREFLIGHT REFUSED other: no Python >= 3.12 in scripts/py's order on other (tried $TMP/pys/missing: absent, $TMP/pys/old-python ($TMP/pys/old-python): Python 3.9.6, older than 3.12, $TMP/pys/not-python ($TMP/pys/not-python): did not run as Python (exit 1)): fleet-worker.sh runs under it here" -- \
  env FLEET_BOXES="testbox other" SHIM_SSH_LOCAL=other SHIM_SSH_PY="$TMP/pys/missing
$TMP/pys/old-python
$TMP/pys/not-python" "$FW" preflight other --no-probe --no-cross
expect "...and passes once the order reaches one" 0 "^PREFLIGHT OK other skills=[0-9a-f]*$" -- \
  env FLEET_BOXES="testbox other" SHIM_SSH_LOCAL=other SHIM_SSH_PY="$TMP/pys/old-python
$real_py" "$FW" preflight other --no-probe --no-cross
mkdir -p "$TMP/pk-yes" "$TMP/pk-no"; printf '#!/bin/sh\nexit 0\n' > "$TMP/pk-yes/pkcheck"; printf '#!/bin/sh\nexit 1\n' > "$TMP/pk-no/pkcheck"
chmod +x "$TMP/pk-yes/pkcheck" "$TMP/pk-no/pkcheck"; printf '#!/bin/sh\n' > "$TMP/pk-yes/fleet-test-inhibit"; chmod +x "$TMP/pk-yes/fleet-test-inhibit"
expect "a box with systemd-inhibit and the polkit grant adds nothing to the OK line" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- \
  env PATH="$TMP/pk-yes:$PATH" FLEET_SYSTEMD_INHIBIT=fleet-test-inhibit "$FW" preflight testbox --no-probe --no-cross
expect "...and without the grant notes the unguarded sleep guard on the OK line" 0 "PREFLIGHT OK testbox skills=[0-9a-f]* (no polkit grant for the sleep guard (runs unguarded; see issue-wave/references/executions.md#the-os-level-sleep-guard))$" -- \
  env PATH="$TMP/pk-no:$TMP/pk-yes:$PATH" FLEET_SYSTEMD_INHIBIT=fleet-test-inhibit "$FW" preflight testbox --no-probe --no-cross
# The repairs that differ by box are read from `other`, a second box the ssh shim maps here, so
# they go through run_on's real ssh path; `testbox` is this suite's LOCAL box.
FWO=(env FLEET_BOXES="testbox other" SHIM_SSH_LOCAL=other "$FW")
# The GitHub credential call (ludics-lite#360): a refused token refuses in every mode with the
# user-side repair, a GitHub that does not answer is a note, as a sleeping sibling is.
expect "a live GitHub credential passes and adds nothing to the OK line" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- "$FW" preflight testbox --no-probe --no-cross
expect "a gh token answering HTTP 401 refuses with the repair" 1 "PREFLIGHT REFUSED other: GitHub credential refused in a non-interactive session on other (gh api user: gh: Bad credentials (HTTP 401)).*desktop console.*repair: ssh -t other 'gh auth login -h github.com -p https -w && gh auth setup-git'" -- \
  env SHIM_GH=401 "${FWO[@]}" preflight other --no-probe --no-cross
expect "...and refuses the native Claude preflight too" 1 "GitHub credential refused in a non-interactive session on testbox" -- env SHIM_GH=401 "$FW" preflight testbox --native-claude --no-cross
expect "...and the native Codex preflight" 1 "GitHub credential refused in a non-interactive session on testbox" -- env SHIM_GH=401 "$FW" preflight testbox --native-codex --no-cross
expect "...and the Codex CLI preflight" 1 "GitHub credential refused" -- env SHIM_GH=401 "$FW" preflight testbox --codex --no-probe --no-cross
expect "a rejected token exported in the session names it in the repair" 1 "repair: remove the GH_TOKEN this session exports (it outranks gh's stored login and blocks gh auth login) from other's shell startup, then restart any tmux server that inherited it; for the stored login: ssh -t other" -- \
  env SHIM_GH=401 GH_TOKEN=gho_dead "${FWO[@]}" preflight other --native-claude --no-cross
# The fleet's PAT file (2026-09-24): its contract is checked whatever gh answers, and a dead PAT
# is replaced in the file, never by gh auth login.
mkdir -p "$HOME/.config/fleet"; printf 'export GH_TOKEN=ghp_dead\n' > "$HOME/.config/fleet/gh-token.sh"; chmod 600 "$HOME/.config/fleet/gh-token.sh"
# Two states pass (ludics-lite#567): the earlier one, where the session exports the file's token
# (noted, since every child process sees it), and the target, where the session exports none and
# gh's stored token is the file's. A session with no working credential in either is refused.
expect "the earlier state, the session exporting the file's PAT, passes with a note" 0 "PREFLIGHT OK testbox skills=[0-9a-f]* (this session exports the fleet PAT as GH_TOKEN, so every process it starts sees it: store it in gh and drop the export, ludics-lite#567)$" -- \
  env GH_TOKEN=ghp_dead "$FW" preflight testbox --native-claude --no-cross
expect "...and so does one exporting it as GITHUB_TOKEN, named" 0 "PREFLIGHT OK other skills=[0-9a-f]* (this session exports the fleet PAT as GITHUB_TOKEN," -- \
  env GITHUB_TOKEN=ghp_dead "${FWO[@]}" preflight other --native-claude --no-cross
expect "the target state, no export and gh storing the file's PAT, passes clean" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- \
  env -u GH_TOKEN -u GITHUB_TOKEN SHIM_GH_STORED=ghp_dead "$FW" preflight testbox --native-claude --no-cross
expect "...over ssh too" 0 "PREFLIGHT OK other skills=[0-9a-f]*$" -- \
  env -u GH_TOKEN -u GITHUB_TOKEN SHIM_GH_STORED=ghp_dead "${FWO[@]}" preflight other --native-claude --no-cross
expect "...and an empty GH_TOKEN is no export: gh is asked with it removed" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- \
  env GH_TOKEN= SHIM_GH_STORED=ghp_dead "$FW" preflight testbox --native-claude --no-cross
out=$(env -u GH_TOKEN -u GITHUB_TOKEN SHIM_GH_STORED=ghp_other "$FW" preflight testbox --native-claude --no-cross 2>&1)
grep -q -e ghp_dead -e ghp_other <<<"$out" && ko "a token reached the preflight's output -- $out" || ok "neither the file's token nor gh's stored one reaches the output"
expect "no export and nothing stored in gh is refused with the store repair, on stdin" 1 "PREFLIGHT REFUSED other: this session exports no GitHub token and gh on other answers none stored (gh auth token -h github.com, bounded [0-9]*s) -- repair: store the fleet PAT in gh: ssh other '(. ~/.config/fleet/gh-token.sh; printenv GH_TOKEN) | env -u GH_TOKEN -u GITHUB_TOKEN gh auth login -h github.com --with-token --insecure-storage'$" -- \
  env -u GH_TOKEN -u GITHUB_TOKEN "${FWO[@]}" preflight other --native-claude --no-cross
expect "...in a terminal on the anchor" 1 "gh on testbox answers none stored .*-- repair: store the fleet PAT in gh: in a terminal on this box: (\. ~/.config/fleet/gh-token.sh; printenv GH_TOKEN) | env -u GH_TOKEN" -- \
  env -u GH_TOKEN -u GITHUB_TOKEN "$FW" preflight testbox --native-claude --no-cross
expect "...and a gh token store that never answers is bounded and refused" 1 "gh on testbox answers none stored (gh auth token -h github.com, bounded 2s)" -- \
  env -u GH_TOKEN -u GITHUB_TOKEN SHIM_GH_STORED=hang FLEET_GH_TIMEOUT=2 "$FW" preflight testbox --native-claude --no-cross
expect "a stored token other than the file's is a per-box login, refused though it is live" 1 "PREFLIGHT REFUSED testbox: gh's stored token on testbox is not the PAT in ~/.config/fleet/gh-token.sh (a per-box login) -- repair: store the fleet PAT in gh" -- \
  env -u GH_TOKEN -u GITHUB_TOKEN SHIM_GH_STORED=ghp_other "$FW" preflight testbox --native-claude --no-cross
expect "the stored file's PAT, dead, is refused with replace-then-store" 1 "repair: the PAT in ~/.config/fleet/gh-token.sh is dead: replace it from the anchor: ssh other .*; then store it in gh (ssh other '(. ~/.config/fleet/gh-token.sh; printenv GH_TOKEN) | env -u GH_TOKEN -u GITHUB_TOKEN gh auth login .*') and restart any tmux server that inherited the old value$" -- \
  env -u GH_TOKEN -u GITHUB_TOKEN SHIM_GH=401 SHIM_GH_STORED=ghp_dead "${FWO[@]}" preflight other --native-claude --no-cross
expect "a dead PAT from gh-token.sh is replaced from the anchor's file" 1 "repair: the PAT in ~/.config/fleet/gh-token.sh is dead: replace it from the anchor: ssh other 'f=~/.config/fleet/gh-token.sh; umask 077; cat > .*f.new.* && chmod 600 .*f.new.* && mv .*f.new.*' < ~/.config/fleet/gh-token.sh; then store it in gh (.*) and restart any tmux server that inherited the old value$" -- \
  env SHIM_GH=401 GH_TOKEN=ghp_dead "${FWO[@]}" preflight other --native-claude --no-cross
expect "a LIVE token a later startup line exports is refused as the override" 1 "PREFLIGHT REFUSED other: this session's GH_TOKEN is not the token ~/.config/fleet/gh-token.sh exports on other: a line of its shell startup sets it.*grep -Hnos -e GH_TOKEN -e GITHUB_TOKEN" -- \
  env GH_TOKEN=ghp_other "${FWO[@]}" preflight other --native-claude --no-cross
expect "...and a dead one points at that, not at the file" 1 "repair: fix the token file first (above)" -- \
  env SHIM_GH=401 GH_TOKEN=ghp_other "$FW" preflight testbox --native-claude --no-cross
expect "...and so is a LIVE GITHUB_TOKEN other than the file's, named" 1 "PREFLIGHT REFUSED other: this session's GITHUB_TOKEN is not the token ~/.config/fleet/gh-token.sh exports on other" -- \
  env GITHUB_TOKEN=ghp_other "${FWO[@]}" preflight other --native-claude --no-cross
expect "an empty GH_TOKEN with nothing stored is no credential in either place" 1 "this session exports no GitHub token and gh on testbox answers none stored" -- \
  env GH_TOKEN= "$FW" preflight testbox --native-claude --no-cross
expect "on the anchor, a mismatch says to re-source the file or open a new shell, with no ssh" 1 "this shell's GH_TOKEN is not the token ~/.config/fleet/gh-token.sh exports -- repair: unset GH_TOKEN (or open a new shell) and rerun" -- \
  env GH_TOKEN=ghp_other "$FW" preflight local --native-claude --no-cross
expect "...and so does the anchor addressed by its own name" 1 "this shell's GH_TOKEN is not the token ~/.config/fleet/gh-token.sh exports -- repair: unset GH_TOKEN" -- \
  env GH_TOKEN=ghp_other FLEET_LOCAL_BOX=anchorbox "$FW" preflight anchorbox --native-claude --no-cross
printf 'export GH_TOKEN=\n' > "$HOME/.config/fleet/gh-token.sh"
expect "a gh-token.sh exporting an empty GH_TOKEN is replaced" 1 "gh-token.sh on other exports no GH_TOKEN -- repair: replace it from the anchor" -- \
  env GH_TOKEN= "${FWO[@]}" preflight other --native-claude --no-cross
printf 'GH_TOKEN=ghp_dead\n' > "$HOME/.config/fleet/gh-token.sh"
expect "...and so is one that assigns GH_TOKEN without exporting it" 1 "gh-token.sh on testbox exports no GH_TOKEN" -- \
  env GH_TOKEN=ghp_dead "$FW" preflight testbox --native-claude --no-cross
printf 'export GH_TOKEN=ghp_dead\n' > "$HOME/.config/fleet/gh-token.sh"
chmod 644 "$HOME/.config/fleet/gh-token.sh"
expect "a group-readable gh-token.sh refuses even with a live token, with the replace-the-file repair" 1 "gh-token.sh on other is not a regular mode-0600 file this user owns (-rw-r--r-- uid [0-9]*).*repair: replace it from the anchor" -- \
  env GH_TOKEN=ghp_dead "${FWO[@]}" preflight other --native-claude --no-cross
rm "$HOME/.config/fleet/gh-token.sh"; mkdir "$HOME/.config/fleet/gh-token.sh"
expect "...and a directory, whose repair removes it before the copy" 1 "gh-token.sh on other is not a regular mode-0600 file this user owns (d.*repair: move the path aside first (ssh other 'mv ~/.config/fleet/gh-token.sh ~/.config/fleet/gh-token.sh.aside'" -- \
  env GH_TOKEN=ghp_dead "${FWO[@]}" preflight other --native-claude --no-cross
rmdir "$HOME/.config/fleet/gh-token.sh"; ln -s "$TMP" "$HOME/.config/fleet/gh-token.sh"
expect "...and a symlink to a directory, the same" 1 "gh-token.sh on other is not a regular mode-0600 file this user owns (l.*repair: move the path aside first (ssh other 'mv ~/.config/fleet/gh-token.sh ~/.config/fleet/gh-token.sh.aside'" -- \
  env GH_TOKEN=ghp_dead "${FWO[@]}" preflight other --native-claude --no-cross
rm "$HOME/.config/fleet/gh-token.sh"; ln -s /dev/null "$HOME/.config/fleet/gh-token.sh"
expect "...and so does a symlink" 1 "gh-token.sh on testbox is not a regular mode-0600 file this user owns (l" -- \
  env GH_TOKEN=ghp_dead "$FW" preflight testbox --native-claude --no-cross
rm "$HOME/.config/fleet/gh-token.sh"
expect "a box never logged in to gh refuses (an unnamed failure fails closed)" 1 "GitHub credential refused.*gh auth login" -- env SHIM_GH=noauth "$FW" preflight testbox --no-probe --no-cross
expect "a GitHub that cannot be reached is noted on the OK line" 0 "PREFLIGHT OK testbox .*(GitHub unreachable from testbox: gh api user: check your internet connection" -- env SHIM_GH=down "$FW" preflight testbox --no-probe --no-cross
expect "a GitHub outage (HTTP 5xx) is noted, not refused" 0 "PREFLIGHT OK.*GitHub unreachable from testbox: gh api user: gh: Server Error (HTTP 502)" -- env SHIM_GH=5xx "$FW" preflight testbox --no-probe --no-cross
expect "a gh call that never returns is bounded and noted" 0 "PREFLIGHT OK.*GitHub unreachable from testbox: no answer from gh api user in 2s" -- env SHIM_GH=hang FLEET_GH_TIMEOUT=2 "$FW" preflight testbox --no-probe --no-cross
# The push half (ludics-lite#374): a live API token with no git credential for https://github.com
# is refused, since a worker's push asks git, not gh; the credential itself is never printed.
expect "no git credential for github.com refuses with gh auth setup-git" 1 "PREFLIGHT REFUSED other: git gets no GitHub credential in a non-interactive session on other (git credential fill for https://github.com: fatal: could not read Username for 'https://github.com': terminal prompts disabled), so a worker's push would fail -- repair: ssh other 'gh auth setup-git'$" -- \
  env SHIM_GH_CRED=none "${FWO[@]}" preflight other --native-claude --no-cross
expect "...on the anchor, in a terminal there" 1 "repair: in a terminal on this box: gh auth setup-git$" -- env SHIM_GH_CRED=none "$FW" preflight testbox --no-probe --no-cross
expect "...and a helper that never answers is bounded and refused" 1 "git credential fill for https://github.com: no answer from git's credential helper in 9s" -- env SHIM_GH_CRED=hang FLEET_GH_TIMEOUT=2 "$FW" preflight testbox --no-probe --no-cross
expect "...and the git probe still runs when GitHub's API did not answer" 1 "PREFLIGHT REFUSED testbox: git gets no GitHub credential" -- env SHIM_GH=down SHIM_GH_CRED=none "$FW" preflight testbox --no-probe --no-cross
expect "a git credential GitHub refuses is refused, though gh's own token passes" 1 "PREFLIGHT REFUSED other: GitHub rejects the credential git returns for https://github.com in a non-interactive session on other (gh: Bad credentials (HTTP 401)) though gh's own token passes, so a worker's push would fail -- repair: ssh other 'gh auth setup-git' (it makes gh git's helper for github.com)$" -- \
  env SHIM_GH_CRED=dead "${FWO[@]}" preflight other --native-claude --no-cross
grep -q 'dead-token' <<<"$out" && ko "the refused git credential reached the output -- $out" || ok "...and the credential it refused is not printed"
expect "GitHub not answering the try of git's credential is noted, not read as a helper timeout" 0 "PREFLIGHT OK testbox .*(GitHub unreachable from testbox: checking git's credential: no answer from gh api user in 2s)$" -- \
  env SHIM_GH_CRED=slowcheck FLEET_GH_TIMEOUT=2 "$FW" preflight testbox --native-claude --no-cross
expect "a git credential for another account than gh's is refused" 1 "PREFLIGHT REFUSED testbox: git's credential for https://github.com is another account's than gh's in a non-interactive session on testbox (git's credential is other-user's, gh's token is shim-user's), so a worker would push as one account and open its PR as the other -- repair: in a terminal on this box: gh auth setup-git" -- \
  env SHIM_GH_CRED=other "$FW" preflight testbox --native-claude --no-cross
out=$(env SHIM_GH=down SHIM_GH_CRED=none "$FW" preflight testbox --no-probe --no-cross 2>&1)
grep -q 'shim-token' <<<"$out" && ko "the git credential reached the preflight's output -- $out" || ok "the git credential never reaches the output"
out=$(env GH_TOKEN=ghp_dead "$FW" preflight testbox --native-claude --no-cross 2>&1)
grep -q 'shim-token' <<<"$out" && ko "the git credential reached a passing preflight's output -- $out" || ok "...nor a passing one's"
expect "a hanging live probe is bounded and refused" 1 "claude headless probe timed out after 2s" -- env SHIM_CLAUDE_HANG=1 FLEET_PROBE_TIMEOUT=2 "$FW" preflight testbox
expect "the live probe runs the worker's own stream-json mode: a CLI without it is refused" 1 "claude cannot run headless: error: unknown option '--input-format'" -- env SHIM_CLAUDE_OLD=1 "$FW" preflight testbox
expect "native preflight needs neither CLI login nor a model probe" 0 "PREFLIGHT OK" -- env SHIM_CODEX_LOGIN_DOWN=1 SHIM_CODEX_DOWN=1 SHIM_CLAUDE_DOWN=1 "$FW" preflight testbox --native-codex
expect "native Claude needs no CLI model probe" 0 "PREFLIGHT OK" -- env SHIM_CLAUDE_DOWN=1 SHIM_CODEX_LOGIN_DOWN=1 "$FW" preflight testbox --native-claude
expect "legacy preflight still requires CLI login" 1 "codex not logged in" -- env SHIM_CODEX_LOGIN_DOWN=1 "$FW" preflight testbox --codex --no-probe
expect "codex that cannot run headless refuses despite login status" 1 "codex cannot run headless: \"message\":\"401 Unauthorized\"" -- env SHIM_CODEX_DOWN=1 "$FW" preflight testbox --codex
echo x >> "$repo/ship-pr/SKILL.md"
expect "a tracked change under the served tree refuses" 1 "1 local change(s) in the served tree" -- "$FW" preflight testbox --no-probe
git -C "$repo" checkout -q -- .
touch "$repo/ship-pr/scripts.sh"
expect "untracked file under the served tree refuses" 1 "1 local change(s) in the served tree" -- "$FW" preflight testbox --no-probe
git -C "$repo" config status.showUntrackedFiles no
expect "...even when the box's git config hides untracked files" 1 "1 local change(s) in the served tree" -- "$FW" preflight testbox --no-probe
git -C "$repo" config --unset status.showUntrackedFiles
git -C "$repo" update-index --skip-worktree ship-pr/SKILL.md; echo hidden >> "$repo/ship-pr/SKILL.md"
expect "a skip-worktree edit under the served tree refuses" 1 "index-hidden (skip-worktree/assume-unchanged) file(s) in the served tree" -- "$FW" preflight testbox --no-probe
git -C "$repo" update-index --no-skip-worktree ship-pr/SKILL.md; git -C "$repo" checkout -q -- .
git -C "$repo" config status.relativePaths bogus
expect "a git status that cannot run refuses instead of passing an empty scan" 1 "git status failed in" -- "$FW" preflight testbox --no-probe
git -C "$repo" config --unset status.relativePaths
printf '*.tmp\n' > "$TMP/excludes"; git -C "$repo" config core.excludesFile "$TMP/excludes"; touch "$repo/ship-pr/x.tmp"
expect "an ignored file under the served tree still refuses" 1 "local change(s) in the served tree" -- "$FW" preflight testbox --no-probe
rm "$repo/ship-pr/x.tmp" "$repo/ship-pr/scripts.sh"
# Python bytecode caches under lib/ (ludics-lite#585): still refused, but with the directories to
# remove named, shell-quoted (this checkout's path has a space) -- and only while every served
# entry is one: a single other entry keeps the plain refusal.
printf '__pycache__/\n' > "$TMP/excludes"
mkdir -p "$repo/lib/ludics/__pycache__" "$repo/lib/ludics/fleetworker/__pycache__"
touch "$repo/lib/ludics/__pycache__/cli.cpython-312.pyc" "$repo/lib/ludics/fleetworker/__pycache__/farside.cpython-312.pyc" "$repo/lib/ludics/fleetworker/__pycache__/slot.cpython-312.pyc"
expect "bytecode caches under lib/ refuse, naming the repair" 1 "PREFLIGHT REFUSED testbox: 2 local change(s) in the served tree, every one an ignored Python bytecode cache under lib/" -- "$FW" preflight testbox --no-probe
want_repair="-- repair, on testbox: rm -rf $(printf '%q' "$repo/lib/ludics/__pycache__") $(printf '%q' "$repo/lib/ludics/fleetworker/__pycache__")"
grep -qF -- "$want_repair" <<<"$out" && ok "...each cache directory once, shell-quoted" || ko "the repair is not '$want_repair' -- $out"
git -C "$repo" update-index --skip-worktree ship-pr/SKILL.md
expect "...but an index-hidden file beside them keeps the plain refusal" 1 "PREFLIGHT REFUSED testbox: 1 index-hidden (skip-worktree/assume-unchanged) file(s) in the served tree; 2 local change(s) in the served tree$" -- "$FW" preflight testbox --no-probe
git -C "$repo" update-index --no-skip-worktree ship-pr/SKILL.md
touch "$repo/ship-pr/x.tmp"; printf '__pycache__/\n*.tmp\n' > "$TMP/excludes"
expect "...as does one other ignored file beside them" 1 "PREFLIGHT REFUSED testbox: 3 local change(s) in the served tree$" -- "$FW" preflight testbox --no-probe
grep -qE 'bytecode|rm -rf' <<<"$out" && ko "a mixed served tree was offered the bytecode repair -- $out" || ok "...with no repair offered for it"
rm -rf "${repo:?}/lib" "$repo/ship-pr/x.tmp"; git -C "$repo" config --unset core.excludesFile
touch "$repo/ship-pr/a b.sh"
expect "an untracked served file whose path git would quote still refuses" 1 "1 local change(s) in the served tree" -- "$FW" preflight testbox --no-probe
rm "$repo/ship-pr/a b.sh"
mkdir -p "$repo/outside"; git -C "$repo" mv after-merge/SKILL.md outside/gone.md
expect "a file renamed out of the served tree refuses (the source side counts)" 1 "1 local change(s) in the served tree" -- "$FW" preflight testbox --no-probe
git -C "$repo" mv outside/gone.md after-merge/SKILL.md; rmdir "$repo/outside"
mkdir -p "$repo/.claude"; echo '{}' > "$repo/.claude/settings.local.json"
expect "a stray .claude/ (the one path outside the served tree) passes with a notice" 0 "PREFLIGHT OK.*ignored: .claude/" -- "$FW" preflight testbox --no-probe
git -C "$repo" mv ship-pr/SKILL.md .claude/moved.md
expect "a served file renamed into .claude/ refuses (the source side counts)" 1 "1 local change(s) in the served tree" -- "$FW" preflight testbox --no-probe
git -C "$repo" mv .claude/moved.md ship-pr/SKILL.md
rm -rf "$repo/.claude"
# Behind origin: a second clone pushes; the preflight must fast-forward and pass. The bare origin
# has no HEAD for `main` (the runner's git may default to master), so name the branch to clone.
git clone --no-local -q -b main "$origin" "$TMP/other" && echo more >> "$TMP/other/ship-pr/SKILL.md" \
  && git -C "$TMP/other" commit -q -am upstream && git -C "$TMP/other" push -q origin main \
  || ko "could not advance the scratch origin (setup, not the launcher)"
expect "behind origin fast-forwards and passes" 0 "PREFLIGHT OK" -- "$FW" preflight testbox --no-probe
[ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$TMP/other" rev-parse HEAD)" ] && ok "checkout was fast-forwarded" || ko "checkout not fast-forwarded"
echo local >> "$repo/after-merge/SKILL.md" && git -C "$repo" commit -q -am "unpushed"
expect "ahead of origin (unpushed local commit) refuses" 1 "!= origin/main" -- "$FW" preflight testbox --no-probe
git -C "$repo" reset -q --hard origin/main
git -C "$repo" checkout -q -b topic
expect "wrong branch refuses" 1 "checked out topic, not main" -- "$FW" preflight testbox --no-probe
git -C "$repo" checkout -q main && git -C "$repo" branch -q -D topic
rm "$HOME/.codex/skills/after-merge"
expect "missing codex skill link refuses only for codex" 1 "codex/skills/after-merge -> missing" -- "$FW" preflight testbox --codex --no-probe
expect "native preflight still requires Codex skill links" 1 "codex/skills/after-merge -> missing" -- "$FW" preflight testbox --native-codex
expect "...and claude preflight still passes" 0 "PREFLIGHT OK" -- "$FW" preflight testbox --no-probe
expect "native Claude does not require Codex skill links" 0 "PREFLIGHT OK" -- "$FW" preflight testbox --native-claude
ln -sfn "$repo/after-merge" "$HOME/.codex/skills/after-merge"
mkdir -p "$TMP/elsewhere"; ln -sfn "$TMP/elsewhere" "$HOME/.claude/skills/ship-pr"
expect "skill link pointing outside the checkout refuses" 1 "skills/ship-pr -> $TMP/elsewhere" -- "$FW" preflight testbox --no-probe
expect "native Claude still requires deployed Claude skill links" 1 "skills/ship-pr -> $TMP/elsewhere" -- "$FW" preflight testbox --native-claude
mkdir -p "$TMP/outside-skill"; ln -sfn "$repo/../outside-skill" "$HOME/.claude/skills/ship-pr"
expect "skill link that escapes the checkout through .. refuses" 1 "skills/ship-pr -> $TMP/outside-skill" -- "$FW" preflight testbox --no-probe
rm "$HOME/.claude/skills/ship-pr"; cp -R "$repo/ship-pr" "$HOME/.claude/skills/ship-pr"
expect "a real directory in place of the link refuses" 1 "skills/ship-pr -> missing/not a link" -- "$FW" preflight testbox --no-probe
rm -rf "$HOME/.claude/skills/ship-pr"; ln -sfn "$repo/wait-and-proceed" "$HOME/.claude/skills/ship-pr"
expect "a link swapped to a sibling skill refuses" 1 "skills/ship-pr -> .*/wait-and-proceed (not " -- "$FW" preflight testbox --no-probe
ln -sfn "$repo/ship-pr" "$HOME/.claude/skills/ship-pr"
# A stale tmux server environment (ludics-lite#327): a new session takes the server's
# environment, so a server started before an env.sh/gpu.sh edit hands CLI workers the old values.
# The shim plays the server; `fresh` pins the three GPU/OCaml variables of the far-side shell, the
# reference a server started now would inherit.
fresh=(env -u ROCM_PATH -u HIP_PATH -u OPAM_SWITCH_PREFIX)
printf 'PATH=%s\n-ROCM_PATH\nTERM=screen\n' "$PATH" > "$TMP/genv-match"
printf 'PATH=%s\nROCM_PATH=/usr\n' "$PATH" > "$TMP/genv-rocm"
printf 'PATH=/old/bin:%s\n' "$PATH" > "$TMP/genv-path"
expect "a tmux server whose environment matches a fresh shell passes" 0 "PREFLIGHT OK" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-match" SHIM_TMUX_SESSIONS="iw-live" "$FW" preflight testbox --no-probe
expect "no tmux server running passes (the next launch starts a fresh one)" 0 "PREFLIGHT OK" -- \
  "${fresh[@]}" HIP_PATH=/usr SHIM_TMUX_GENV=none "$FW" preflight testbox --no-probe
expect "a server still exporting a dropped ROCM_PATH refuses, naming it, and says to wait for its live worker" 1 \
  "stale tmux server environment (ROCM_PATH is /usr in the server but unset in a fresh shell): .*wait for its live worker session(s) (iw-w7 iw-w8; \`fleet-worker.sh ls testbox\`) to finish" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-rocm" SHIM_TMUX_SESSIONS="iw-w7 iw-w8" "$FW" preflight testbox --no-probe
grep -q 'restart it with' <<<"$out" && ko "kill-server offered as the fix while a worker session is live -- $out" \
  || ok "no restart is offered while a worker session is live"
expect "with no live worker session, the refusal names the socket's kill-server" 1 \
  "ROCM_PATH is /usr in the server .*no worker session is live on it, so restart it with \`tmux -L $FLEET_TMUX_SOCKET kill-server\` and try again" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-rocm" "$FW" preflight testbox --no-probe
expect "...and warns which non-worker sessions a kill-server would end" 1 "kill-server also ends its non-worker session(s): notes)" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-rocm" SHIM_TMUX_SESSIONS="notes" "$FW" preflight testbox --no-probe
expect "...and warns of them too when the advice is to wait for live workers first" 1 "to finish, then .*kill-server.* if it outlives them (kill-server also ends its non-worker session(s): notes)" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-rocm" SHIM_TMUX_SESSIONS="iw-w7 notes" "$FW" preflight testbox --no-probe
expect "a variable tmux refreshes from the client (update-environment) is not compared" 0 "PREFLIGHT OK" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-rocm" SHIM_TMUX_UPDATE_ENV="ROCM_PATH" "$FW" preflight testbox --no-probe
expect "...while the variables it does not refresh still are" 1 "PATH is /old/bin:.* in the server" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-path" SHIM_TMUX_UPDATE_ENV="ROCM_PATH" "$FW" preflight testbox --no-probe
expect "a variable the fresh shell gained since the server started refuses too" 1 "HIP_PATH is unset in the server but /usr in a fresh shell" -- \
  "${fresh[@]}" HIP_PATH=/usr SHIM_TMUX_GENV="$TMP/genv-match" "$FW" preflight testbox --no-probe
expect "a PATH that moved since the server started refuses" 1 "PATH is /old/bin:.* in the server but .* in a fresh shell" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-path" "$FW" preflight testbox --no-probe
expect "every stale variable is named in one refusal" 1 "(ROCM_PATH is /usr in the server but unset in a fresh shell, OPAM_SWITCH_PREFIX is unset in the server but /o in a fresh shell)" -- \
  "${fresh[@]}" OPAM_SWITCH_PREFIX=/o SHIM_TMUX_GENV="$TMP/genv-rocm" "$FW" preflight testbox --no-probe
expect "native workers never run under tmux, so a stale server does not refuse them" 0 "PREFLIGHT OK" -- \
  "${fresh[@]}" SHIM_TMUX_GENV="$TMP/genv-rocm" "$FW" preflight testbox --native-claude
# The same fact against a real tmux server, on a socket of its own: the shim above must not be the
# only thing that knows the output shape of show-environment.
envsock="fwtest-env-$$"
"${fresh[@]}" ROCM_PATH=/usr "$REAL_TMUX" -L "$envsock" new-session -d -s iw-real 'sleep 60'
expect "a real server started with ROCM_PATH=/usr refuses a fresh shell without it" 1 \
  "ROCM_PATH is /usr in the server but unset in a fresh shell): .*wait for its live worker session(s) (iw-real;" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe
# update-environment, on the real server: tmux copies ROCM_PATH from the launching client into
# each new session, so the stale global value reaches no worker and the launch is safe.
"$REAL_TMUX" -L "$envsock" set-option -ga update-environment ROCM_PATH
expect "a real server that refreshes ROCM_PATH from the client passes despite its stale global value" 0 "PREFLIGHT OK" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe
"$REAL_TMUX" -L "$envsock" set-option -gu update-environment
# exit-empty off: the server outlives its last session and a new one would still inherit from it.
"$REAL_TMUX" -L "$envsock" set-option -g exit-empty off
"$REAL_TMUX" -L "$envsock" kill-session -t iw-real
expect "a real server left with no session (exit-empty off) is still checked" 1 "ROCM_PATH is /usr in the server .*no worker session is live on it, so restart it with \`tmux -L $envsock kill-server\`" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
"${fresh[@]}" "$REAL_TMUX" -L "$envsock" new-session -d -s iw-real 'sleep 60'
# The GitHub probe runs inside that server too (ludics-lite#374), as a throwaway session, and
# remain-on-exit must not leave it behind.
"$REAL_TMUX" -L "$envsock" set-option -g remain-on-exit on
expect "...and a real server started from the same environment passes" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
left=$("$REAL_TMUX" -L "$envsock" list-sessions -F '#{session_name}' 2>&1)
[ "$left" = iw-real ] && ok "...leaving no probe session behind" || ko "sessions after the probe: $left"
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
# A server whose environment hands gh a dead credential (the shim reads SHIM_GH from the
# environment it runs in, as gh reads GH_TOKEN): this session's probe passes, the server's refuses.
"${fresh[@]}" SHIM_GH=401 "$REAL_TMUX" -L "$envsock" new-session -d -s iw-real 'sleep 60'
expect "a real server whose environment has a dead GitHub credential refuses a CLI launch" 1 \
  "PREFLIGHT REFUSED testbox: the running tmux server on testbox gives a new session a GitHub credential that does not work (gh api user: gh: Bad credentials (HTTP 401)): a CLI worker started now would inherit it; wait for its live worker session(s) (iw-real; " -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
expect "...but not a native one, which never runs under tmux" 0 "PREFLIGHT OK" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --native-claude --no-cross
# update-environment copies the variable from the launching client into each new session, so the
# worker gets this session's value whatever the global one is: the probe session does too.
"$REAL_TMUX" -L "$envsock" set-option -ga update-environment SHIM_GH
expect "...and passes once the server refreshes that variable from the client" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
"${fresh[@]}" SHIM_GH_CRED=none "$REAL_TMUX" -L "$envsock" new-session -d -s notes 'sleep 60'
expect "a real server whose git gets no credential refuses, and names kill-server" 1 \
  "server on testbox gives a new session a GitHub credential that does not work (git credential fill: fatal: could not read Username .*no worker session is live on it, so restart it with \`tmux -L $envsock kill-server\` (kill-server also ends its non-worker session(s): notes) and try again" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
# The server must answer as the account this session proved, not merely with a live token: here it
# holds another account's, for gh and git alike.
"${fresh[@]}" SHIM_GH_LOGIN=other-user "$REAL_TMUX" -L "$envsock" new-session -d -s iw-real 'sleep 60'
expect "a real server whose credential is another account's refuses" 1 "the running tmux server on testbox gives a new session a GitHub credential that does not work (gh api user answers as other-user, not as shim-user)" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
# A server still holding the token every session used to export (ludics-lite#567): its credential
# works, so nothing refuses, but a CLI worker started there hands it to every process it starts.
"${fresh[@]}" GH_TOKEN=ghp_dead "$REAL_TMUX" -L "$envsock" new-session -d -s iw-real 'sleep 60'
expect "a real server that still gives new sessions GH_TOKEN is noted, with the restart" 0 "PREFLIGHT OK testbox skills=[0-9a-f]* (a new session of the running tmux server on testbox gets GH_TOKEN, so a CLI worker started now hands the fleet PAT to every process it starts: wait for its live worker session(s) (iw-real; .*; ludics-lite#567)$" -- \
  "${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
expect "...and not when this session exports one too (its own export is the cause)" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- \
  "${fresh[@]}" GH_TOKEN=ghp_dead FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
# No server running: the worker's session starts one from this shell, run by tmux's default shell,
# whose startup can change the credential (zsh's ~/.zshenv sources env.sh on the anchor). A default
# shell that exports a dead one is refused though this shell's passes, and the probe's server exits
# with its session.
printf '#!/usr/bin/env bash\nexport SHIM_GH=401\nexec bash "$@"\n' > "$TMP/badshell"; chmod +x "$TMP/badshell"
nosock="fwtest-none-$$"
expect "with no server, a default shell whose startup sets a dead credential refuses" 1 "PREFLIGHT REFUSED testbox: a tmux server started from this session on testbox gives a new session a GitHub credential that does not work (gh api user: gh: Bad credentials (HTTP 401)), though this session's own passes: its default shell's startup files change it" -- \
  "${fresh[@]}" SHELL="$TMP/badshell" FLEET_TMUX_SOCKET="$nosock" "$FW" preflight testbox --no-probe --no-cross
for _ in $(seq 1 30); do "$REAL_TMUX" -L "$nosock" list-sessions >/dev/null 2>&1 || break; sleep 0.1; done
"$REAL_TMUX" -L "$nosock" list-sessions >/dev/null 2>&1 && ko "the probe left a tmux server running on $nosock" || ok "...and the server the probe started exits with it"
expect "...while a default shell that leaves it alone passes" 0 "PREFLIGHT OK testbox skills=[0-9a-f]*$" -- \
  "${fresh[@]}" SHELL="$(command -v bash)" FLEET_TMUX_SOCKET="$nosock" "$FW" preflight testbox --no-probe --no-cross
"$REAL_TMUX" -L "$nosock" kill-server 2>/dev/null
printf '#!/usr/bin/env bash\nexport GITHUB_TOKEN=ghp_dead\nexec bash "$@"\n' > "$TMP/tokshell"; chmod +x "$TMP/tokshell"
expect "...and one whose startup exports a token is noted, naming the variable" 0 "PREFLIGHT OK testbox skills=[0-9a-f]* (a tmux server started from this session on testbox gives a new session GITHUB_TOKEN: its default shell's startup files export it" -- \
  "${fresh[@]}" SHELL="$TMP/tokshell" FLEET_TMUX_SOCKET="$nosock" "$FW" preflight testbox --no-probe --no-cross
"$REAL_TMUX" -L "$nosock" kill-server 2>/dev/null
# A preflight killed outright (no trap runs) while its probe session is live: the probe ends that
# session itself, so a remain-on-exit server keeps no dead fw-ghprobe-* session.
"${fresh[@]}" SHIM_GH_SLOW=3 "$REAL_TMUX" -L "$envsock" new-session -d -s iw-real 'sleep 60'
"$REAL_TMUX" -L "$envsock" set-option -g remain-on-exit on
killtree() { local c; for c in $(pgrep -P "$1"); do killtree "$c"; done; kill -9 "$1" 2>/dev/null; }
"${fresh[@]}" FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross > /dev/null 2>&1 & pfpid=$!
seen=0; for _ in $(seq 1 150); do
  "$REAL_TMUX" -L "$envsock" list-sessions -F '#{session_name}' 2>/dev/null | grep -q '^fw-ghprobe-' && { seen=1; break; }
  sleep 0.1
done
killtree "$pfpid"; wait "$pfpid" 2>/dev/null
for _ in $(seq 1 100); do
  "$REAL_TMUX" -L "$envsock" list-sessions -F '#{session_name}' 2>/dev/null | grep -q '^fw-ghprobe-' || break
  sleep 0.1
done
left=$("$REAL_TMUX" -L "$envsock" list-sessions -F '#{session_name}' 2>&1)
if [ "$seen" = 1 ] && [ "$left" = iw-real ]; then ok "a probe session outlives no killed preflight, even under remain-on-exit"
else ko "probe session seen=$seen; sessions after the killed preflight: $left"; fi
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
"${fresh[@]}" SHIM_GH=hang "$REAL_TMUX" -L "$envsock" new-session -d -s iw-real 'sleep 60'
expect "a gh call that hangs only in the server is bounded and noted" 0 "PREFLIGHT OK .*(GitHub unreachable from testbox: in a tmux session: no answer from gh api user in 1s)" -- \
  "${fresh[@]}" FLEET_GH_TIMEOUT=1 FLEET_TMUX_SOCKET="$envsock" "$FW" preflight testbox --no-probe --no-cross
"$REAL_TMUX" -L "$envsock" kill-server 2>/dev/null
}

# --- load: an asleep box is a row, not a failure ------------------------------------------------
# `load` is placement input, and the box it most often reports asleep is tuf-amd-linux (no Wake-on-LAN,
# manual wake; ludics-lite#320). The payload below is flotilla's own shape for an endpoint that did
# not answer, copied from http://mac-studio:7799/api/fleet on 2026-09-23 (`data` null, null
# averages, an ssh error). curl is shimmed on this case's PATH only.
section "load" && {
mkdir -p "$TMP/loadbin"
printf '#!/usr/bin/env bash\ncat "$SHIM_FLEET_JSON"\n' > "$TMP/loadbin/curl"; chmod +x "$TMP/loadbin/curl"
cat > "$TMP/fleet-asleep.json" <<'JSON'
{"machines":[
 {"name":"mac-studio","endpoints":{"local":{"kind":"unix","host":"local","ok":true,"data":{"counts":{"dune":0},"sessions":{"claude":[1],"codex":[]},"gpu":{"name":"Apple M4 Max"}},"avg":{"m5":{"cpu_pct":12.7,"gpu_util_pct":0}}}}},
 {"name":"tuf","sleep_status":null,"wol":false,"endpoints":{"linux":{"kind":"unix","host":"tuf-amd-linux","ok":false,"data":null,"error":"exit 255: ssh: connect to host tuf-amd-linux port 22: Operation timed out","fetched_at":null,"avg":{"m1":{"cpu_pct":null,"gpu_util_pct":null,"samples":0},"m5":{"cpu_pct":null,"gpu_util_pct":null,"samples":0},"m15":{"cpu_pct":null,"gpu_util_pct":null,"samples":0}}},"win":{"kind":"windows","host":"tuf-amd-win","ok":false,"data":null}}}
]}
JSON
tab=$'\t'
out=$(env PATH="$TMP/loadbin:$PATH" SHIM_FLEET_JSON="$TMP/fleet-asleep.json" "$FW" load 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q "^tuf${tab}tuf-amd-linux${tab}ok=false${tab}cpu5=?%" <<<"$out" &&
   grep -q "^mac-studio${tab}local${tab}ok=true" <<<"$out"; then
  ok "load reports a sleeping TUF as an ok=false row beside the live boxes, exit 0"
else ko "load over a sleeping TUF (rc=$rc) -- $out"; fi
# A number prints as the payload spelled it, as jq 1.8 prints a literal it did not compute with:
# 1E+2 stays 1E+2 (not 100.0), 3.50 keeps its zero, -0 its sign, and a lowercase exponent reads
# in jq's canonical spelling (1.5e3 is 1.5E+3), inside an array as well as alone; a number's
# length (its absolute value) keeps the literal too, its sign dropped.
cat > "$TMP/fleet-literals.json" <<'JSON'
{"machines":[{"name":3.50,"endpoints":{"e":{"kind":"unix","host":"h","ok":1.10,"data":{"counts":{"dune":-0},"sessions":{"claude":-3.50,"codex":-0},"gpu":{"name":[1.5e3,2]}},"avg":{"m5":{"cpu_pct":0.0000001,"gpu_util_pct":1E+2}}}}}]}
JSON
out=$(env PATH="$TMP/loadbin:$PATH" SHIM_FLEET_JSON="$TMP/fleet-literals.json" "$FW" load 2>&1); rc=$?
want="3.50${tab}h${tab}ok=1.10${tab}cpu5=1E-7%${tab}gpu5=1E+2%${tab}dune=-0${tab}claude=3.50${tab}codex=0${tab}gpu=[1.5E+3,2]"
if [ "$rc" -eq 0 ] && [ "$out" = "$want" ]; then
  ok "load prints each number as the payload spelled it, in jq 1.8's canonical form"
else ko "load over number literals (rc=$rc) -- got: $out -- want: $want"; fi
# A payload that parses only in part: jq printed the rows of every document before the one it
# could not parse, then refused -- the refusal comes after them, not instead of them.
{ printf '%s' '{"machines":[{"name":"a","endpoints":{"e":{"kind":"unix","host":"h","ok":true}}}]}'
  printf '%s' ' {"machines":[]} {"machines":'; } > "$TMP/fleet-cut.json"
out=$(env PATH="$TMP/loadbin:$PATH" SHIM_FLEET_JSON="$TMP/fleet-cut.json" FLEET_FLOTILLA=http://fl "$FW" load 2>&1); rc=$?
want="a${tab}h${tab}ok=true${tab}cpu5=?%${tab}gpu5=-%${tab}dune=?${tab}claude=0${tab}codex=0${tab}gpu=-
LOAD: unexpected payload from http://fl/api/fleet"
if [ "$rc" -eq 1 ] && [ "$out" = "$want" ]; then
  ok "load over a payload cut short prints the rows before the cut, then refuses, exit 1"
else ko "load over a cut payload (rc=$rc) -- got: $out -- want: $want"; fi
}

section "launch / attach / status / log with a project repo and --repo/--branch" && {
expect "launch without a lease refuses" 1 "LAUNCH REFUSED testbox/w1: no coordinator lease" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/w1
"$FW" claim >/dev/null
# --repo is a checkout path on the box; --target-repo is owner/repo. A missing --repo shaped like
# owner/name is the two swapped, refused as usage; an existing relative path of that shape is
# still a path (here a plain directory, so the launch goes on and fails at its fetch).
expect "launch refuses an owner/name --repo that is no path on the box" 2 "launch: --repo takes the path of a checkout on testbox, not a GitHub owner/name like example/project; the GitHub repository goes in --target-repo" -- \
  "$FW" launch testbox w-swap --target-repo example/project --kind claude --brief "$brief" --repo example/project --branch claude/w-swap
mkdir -p "$TMP/relrepo/example/project"
expect "an existing relative --repo shaped like owner/name is still a path" 1 "fetch failed in example/project" -- \
  bash -c 'cd "$1" && shift && "$@"' _ "$TMP/relrepo" "$FW" launch testbox w-rel --target-repo example/project --kind claude --brief "$brief" --repo example/project --branch claude/w-rel
expect "launch says on stderr which sibling did not answer, and still launches" 0 "preflight note for testbox/w-cross: (cross-box unreachable, asleep or off the network: otherbox)" -- \
  env FLEET_BOXES="testbox otherbox" SHIM_SSH_DOWN=otherbox "$FW" launch testbox w-cross --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
settle w-cross
echo x >> "$repo/ship-pr/SKILL.md"
expect "launch runs the preflight on the box and refuses a dirty served tree" 1 "LAUNCH REFUSED testbox/w1: PREFLIGHT REFUSED testbox: 1 local change(s) in the served tree" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/w1
git -C "$repo" checkout -q -- .
# The launch's far side re-reads the tmux server just before new-session (ludics-lite#327): the
# base gate between it and the preflight can take minutes. Here the server turns stale during it.
printf 'PATH=%s\nROCM_PATH=/usr\n' "$PATH" > "$TMP/genv-late"; rm -f "$TMP/stale-now"
expect "a tmux server that turns stale after the preflight still refuses the launch" 1 "LAUNCH REFUSED testbox/wz: stale tmux server environment (ROCM_PATH is /usr in the server" -- \
  env -u ROCM_PATH -u HIP_PATH -u OPAM_SWITCH_PREFIX SHIM_TMUX_GENV="$TMP/genv-late" SHIM_TMUX_GENV_WHEN="$TMP/stale-now" SHIM_BASE_TOUCH="$TMP/stale-now" \
  "$FW" launch testbox wz --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
grep -q 'PREFLIGHT REFUSED' <<<"$out" && ko "the stale server was caught by the preflight, not the late re-read -- $out" || ok "the late re-read, not the preflight, caught it"
[ -e "$ISSUE_WAVE_STATE/workers/wz" ] && ko "a stale-server refusal left a record behind" || ok "a stale-server refusal leaves no record"
rm -f "$TMP/stale-now"
# ...and so is its GitHub probe of that server (ludics-lite#374): here the server's credential
# dies during the base gate, after the preflight's probe of the same server passed.
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" new-session -d -s holder374 'sleep 300'
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" set-environment -g SHIM_GH_DEAD_WHEN "$TMP/gh-dead-now"; rm -f "$TMP/gh-dead-now"
expect "a tmux server whose GitHub credential dies after the preflight still refuses the launch" 1 "LAUNCH REFUSED testbox/wg: the running tmux server on testbox gives a new session a GitHub credential that does not work (gh api user: gh: Bad credentials (HTTP 401)): a CLI worker started now would inherit it" -- \
  env SHIM_BASE_TOUCH="$TMP/gh-dead-now" "$FW" launch testbox wg --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
[ -e "$ISSUE_WAVE_STATE/workers/wg" ] && ko "a GitHub refusal at launch left a record behind" || ok "...and leaves no record"
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" set-environment -gu SHIM_GH_DEAD_WHEN; rm -f "$TMP/gh-dead-now"
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" kill-session -t =holder374
# The late probe first re-proves the launch's own far-side shell, the one a new server would start
# from: here its credential dies during the base gate, with no server running.
nosock="fwtest-none-$$"
expect "with no tmux server, a credential that dies after the preflight still refuses the launch" 1 "LAUNCH REFUSED testbox/wn: GitHub credential refused in a non-interactive session on testbox (gh api user: gh: Bad credentials (HTTP 401)) -- \`fleet-worker.sh preflight testbox\` names the repair" -- \
  env FLEET_TMUX_SOCKET="$nosock" SHIM_GH_DEAD_WHEN="$TMP/gh-dead-now" SHIM_BASE_TOUCH="$TMP/gh-dead-now" "$FW" launch testbox wn --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
"$REAL_TMUX" -L "$nosock" list-sessions >/dev/null 2>&1 && ko "the refused launch started a tmux server on $nosock" || ok "...and starts no server"
[ -e "$ISSUE_WAVE_STATE/workers/wn" ] && ko "a no-server GitHub refusal left a record behind" || ok "...and leaves no record"
rm -f "$TMP/gh-dead-now"
expect "launch creates the worktree and reports the session" 0 "LAUNCHED testbox/w1 kind=claude session=[0-9a-f-]\{36\} cwd=$proj-worktrees/w1" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/w1 -- --model opus
[ -d "$proj-worktrees/w1" ] && [ "$(git -C "$proj-worktrees/w1" rev-parse --abbrev-ref HEAD)" = claude/w1 ] && ok "worktree on the requested branch" || ko "worktree missing or wrong branch"
grep -q -- "--model opus" "$ISSUE_WAVE_STATE/workers/w1/run.sh" && ok "extra CLI args reach the command line" || ko "extra args lost"
# ludics-lite#259: a claude worker is one stream-json process fed from input.jsonl, the brief first.
grep -q -- "{ tail -n +1 -f .*input.jsonl .* | {" "$ISSUE_WAVE_STATE/workers/w1/run.sh" && grep -q -- "claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages " "$ISSUE_WAVE_STATE/workers/w1/run.sh" &&
  ok "a claude worker runs one stream-json process fed from its input channel" || ko "claude command: $(cat "$ISSUE_WAVE_STATE/workers/w1/run.sh")"
[ "$(jq -j '.message.content' "$ISSUE_WAVE_STATE/workers/w1/input.jsonl")" = "$(cat "$brief")" ] && [ "$(grep -c '' "$ISSUE_WAVE_STATE/workers/w1/input.jsonl")" -eq 1 ] &&
  ok "the brief is the channel's first line, byte for byte" || ko "input.jsonl: $(cat "$ISSUE_WAVE_STATE/workers/w1/input.jsonl")"
expect "attach returns IDLE when the turn ends: the process stays up for the next message" 0 "IDLE testbox/w1 success is_error=false .* | awaiting input" -- "$FW" attach testbox w1 --interval 1
expect "...ls reads it as IDLE" 0 "testbox/w1 IDLE kind=claude" -- "$FW" ls testbox
expect "...status names the turn state and no unread input" 0 "IDLE testbox/w1 kind=claude .* | turn=ended background_tasks=0 unread=0 | " -- "$FW" status testbox w1
expect "...and attach re-armed on an IDLE worker answers at once" 0 "IDLE testbox/w1 " -- "$FW" attach testbox w1 --interval 30
expect "close ends an IDLE worker and prints the final verdict" 0 "DONE testbox/w1 exit=0 success is_error=false" -- "$FW" close testbox w1
[ ! -e "$ISSUE_WAVE_STATE/workers/w1/feeder.pid" ] && ok "the process's end removes its feeder pid" || ko "feeder pid left behind"
expect "close of an ended worker prints its verdict as it stands" 0 "DONE testbox/w1 exit=0" -- "$FW" close testbox w1
git -C "$proj" branch -q -f alt-base master && echo b > "$proj/b" && git -C "$proj" add b && git -C "$proj" commit -q -m b && git -C "$proj" push -q origin master alt-base
expect "FLEET_BASE_REF sets the worktree's start point when --base is not given" 0 "LAUNCHED testbox/wb " -- \
  env FLEET_BASE_REF=origin/alt-base "$FW" launch testbox wb --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/wb
[ "$(git -C "$proj-worktrees/wb" rev-parse HEAD)" = "$(git -C "$proj" rev-parse origin/alt-base)" ] && ok "worktree started from FLEET_BASE_REF" || ko "worktree did not start from FLEET_BASE_REF"
settle wb
[ "$(cat "$ISSUE_WAVE_STATE/workers/w1/brief.md")" = "$(cat "$brief")" ] && ok "brief crossed byte-for-byte" || ko "brief mangled"
expect "status after exit names head and branch" 0 "EXITED(0) testbox/w1 kind=claude .*branch=claude/w1" -- "$FW" status testbox w1
expect "log prints the assistant text" 0 "did: Fix issue #1" -- "$FW" log testbox w1
expect "unknown worker is UNKNOWN, exit 3" 3 "UNKNOWN testbox/nope" -- "$FW" status testbox nope
expect "the literal box name local is the same box, labelled as typed" 0 "EXITED(0) local/w1 kind=claude" -- "$FW" status local w1
printf 'a different brief\n' > "$TMP/brief2.md"
expect "a finished worker's name is not reused silently" 1 "finished worker's record is here" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$TMP/brief2.md" --cwd "$proj-worktrees/w1"
[ "$(cat "$ISSUE_WAVE_STATE/workers/w1/brief.md")" = "$(cat "$brief")" ] && ok "a refused launch leaves the recorded brief untouched" || ko "refused launch overwrote brief.md"
grep -q '^w1-' <<<"$(ls "$ISSUE_WAVE_STATE/incoming/" 2>/dev/null)" && ko "refused launch left its staged brief behind" || ok "refused launch cleans up its staged brief"
git -C "$proj-worktrees/w1" checkout -q -b other
expect "a reused worktree on another branch refuses" 1 "exists but is on 'other', not claude/w1" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/w1 --replace
git -C "$proj-worktrees/w1" checkout -q claude/w1 && git -C "$proj-worktrees/w1" branch -q -D other
foreign="$proj-worktrees/wx"; git init -q -b claude/wx "$foreign" && echo z > "$foreign/z" && git -C "$foreign" add z && git -C "$foreign" commit -q -m z
expect "a foreign repository at the derived path is refused even on the right branch" 1 "exists but is not a worktree of" -- \
  "$FW" launch testbox wx --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/wx
rm -rf "$foreign"
expect "a reused worktree on the requested branch is accepted" 0 "reusing existing worktree .* (on claude/w1)" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/w1 --replace
settle w1
bash -c 'sleep 30; :' claude "$ISSUE_WAVE_STATE/workers/w1/" >/dev/null 2>&1 & orphan=$!
expect "--replace refuses while a process still carries the old worker's path" 1 "a CLI from the previous launch is still running" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj-worktrees/w1" --replace
kill "$orphan" 2>/dev/null; wait "$orphan" 2>/dev/null
rm -rf "$ISSUE_WAVE_STATE/replaced"; : > "$ISSUE_WAVE_STATE/replaced"
expect "--replace with an unusable archive namespace refuses and changes nothing" 1 "cannot archive the previous record .* nothing was changed" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj-worktrees/w1" --replace
[ -s "$ISSUE_WAVE_STATE/workers/w1/stream.jsonl" ] && [ -f "$ISSUE_WAVE_STATE/workers/w1/exit" ] && ok "the old record is intact" || ko "old record damaged by a failed archive"
rm -f "$ISSUE_WAVE_STATE/replaced"
oldstream=$(cat "$ISSUE_WAVE_STATE/workers/w1/stream.jsonl")
expect "--replace archives the previous record and starts a fresh one" 0 "LAUNCHED testbox/w1 .* replaced=.*/replaced/w1-" -- \
  "$FW" launch testbox w1 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj-worktrees/w1" --replace
arch=$(printf '%s' "$out" | sed -n 's/.* replaced=//p')
[ -n "$arch" ] && [ "$(cat "$arch/stream.jsonl")" = "$oldstream" ] && [ -f "$arch/exit" ] && ok "the archived record keeps the old stream and exit" || ko "archive missing or incomplete: $arch"
[ "$(cat "$ISSUE_WAVE_STATE/workers/w1/brief.md")" = "$(cat "$brief")" ] && ok "the fresh record has the new brief" || ko "fresh record brief wrong"
settle w1
expect "ls lists local workers with state" 0 "testbox/w1 EXITED(0) kind=claude" -- "$FW" ls testbox
out=$(FLEET_BOXES="testbox" "$FW" ls 2>&1)
[ "$(printf '%s\n' "$out" | grep -c '/w1 ')" -eq 1 ] && grep -q '^local/w1 ' <<<"$out" && ok "default ls sweeps the fleet minus the local box, once" || ko "default ls: $out"
}

section "failure verdicts" && {
need_lease   # this section and every one below launch workers; see the shared setup above
# Its result text says `is_error=false`: the verdict reads the field, never the text.
printf 'FAIL on purpose; is_error=false\n' > "$TMP/fail.md"
"$FW" launch testbox wf --target-repo example/project --kind claude --brief "$TMP/fail.md" --cwd "$proj" >/dev/null
expect "an erroring turn attaches as FAILED idle, exit 1: the process awaits input" 1 "FAILED testbox/wf idle error_during_execution is_error=true .* | awaiting input" -- "$FW" attach testbox wf --interval 1
expect "...and its close reports the failed last turn" 1 "FAILED testbox/wf exit=0 error_during_execution is_error=true" -- "$FW" close testbox wf
tail -n +1 -f "$ISSUE_WAVE_STATE/workers/wf/input.jsonl" >/dev/null 2>&1 & stale=$!; echo "$stale" > "$ISSUE_WAVE_STATE/workers/wf/feeder.pid"
expect "close of an ended worker still prints its verdict" 1 "FAILED testbox/wf exit=0" -- "$FW" close testbox wf
sleep 0.5; kill -0 "$stale" 2>/dev/null && { ko "...but left a feeder that outlived its CLI running"; kill "$stale"; } || ok "...after ending a feeder that outlived its CLI"
wait "$stale" 2>/dev/null
# A CLI that outlived its session and finished its turn idles on its input forever: attach says so.
bash -c 'sleep 6; :' claude "$ISSUE_WAVE_STATE/workers/wf/" >/dev/null 2>&1 & orphan=$!; t0=$(date +%s)
expect "attach reports an orphaned CLI whose turn ended, rather than waiting on it" 1 "ORPHANED testbox/wf: its turn ended but the CLI outlived its tmux session" -- "$FW" attach testbox wf --interval 1
[ $(( $(date +%s) - t0 )) -lt 5 ] && ok "...at once" || ko "attach waited out the orphan"
kill "$orphan" 2>/dev/null; wait "$orphan" 2>/dev/null
printf 'HALFTURN\n' > "$TMP/half.md"
"$FW" launch testbox whalf --target-repo example/project --kind claude --brief "$TMP/half.md" --cwd "$proj" >/dev/null
expect "a process that ended inside a later turn is FAILED, not DONE on the earlier result" 1 "FAILED testbox/whalf exit=0 success is_error=false .* | the process ended mid-turn (turn=working" -- "$FW" attach testbox whalf --interval 1
printf 'SILENT\n' > "$TMP/silent.md"
"$FW" launch testbox wsil --target-repo example/project --kind claude --brief "$TMP/silent.md" --cwd "$proj" >/dev/null
expect "exit 0 with no terminal event is FAILED, not DONE" 1 "FAILED testbox/wsil exit=0 no terminal event" -- "$FW" attach testbox wsil --interval 1
printf 'SLEEP 30\n' > "$TMP/slow.md"
"$FW" launch testbox wv --target-repo example/project --kind claude --brief "$TMP/slow.md" --cwd "$proj" >/dev/null
sleep 1; tmux -L "$FLEET_TMUX_SOCKET" kill-session -t iw-wv
expect "a killed session with no exit record is VANISHED, exit 3" 3 "VANISHED testbox/wv" -- "$FW" attach testbox wv --interval 1
expect "relaunching a vanished name refuses without --replace" 1 "left no exit record" -- "$FW" launch testbox wv --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
# An orphan: tmux gone, a process still carrying the worker's state dir. Supervision must see it.
bash -c 'sleep 4; :' claude "$ISSUE_WAVE_STATE/workers/wv/" >/dev/null 2>&1 & disown; sleep 0.5
expect "status reports an orphaned CLI as ORPHANED" 0 "ORPHANED testbox/wv" -- "$FW" status testbox wv
expect "ls reports it as ORPHANED too" 0 "testbox/wv ORPHANED" -- "$FW" ls testbox
t0=$(date +%s)
expect "attach waits for the orphan to exit and then reports VANISHED" 3 "VANISHED testbox/wv" -- "$FW" attach testbox wv --interval 1
[ $(( $(date +%s) - t0 )) -ge 2 ] && ok "attach held while the orphan lived" || ko "attach returned before the orphan exited"
# ludics-lite#361: a DONE turn that ended announcing a pending wait is marked, not failed.
printf 'The watch is ARMED; it will wake me\n' > "$TMP/strand.md"
"$FW" launch testbox wst --target-repo example/project --kind claude --brief "$TMP/strand.md" --cwd "$proj" >/dev/null
expect "a final message announcing a pending wait marks IDLE as a PROBABLE STRAND when no background task is listed, exit still 0" 0 \
  'IDLE testbox/wst .* | PROBABLE STRAND: the final message says "will wake me"; no background task of the worker is pending' -- "$FW" attach testbox wst --interval 1
expect "...and so does the DONE its close prints" 0 \
  'DONE testbox/wst exit=0 .* | PROBABLE STRAND: the final message says "will wake me"' -- "$FW" close testbox wst
printf 'The watch returned rc=0 and it merged\n' > "$TMP/nostrand.md"
"$FW" launch testbox wns --target-repo example/project --kind claude --brief "$TMP/nostrand.md" --cwd "$proj" >/dev/null
out=$("$FW" attach testbox wns --interval 1 2>&1)
grep -q '^IDLE testbox/wns ' <<<"$out" && ! grep -q 'PROBABLE STRAND' <<<"$out" && ok "a final message with no listed phrase is a plain IDLE" || ko "unlisted final message: $out"
settle wns
# A turn that ends with a background task listed is not the worker idle: the task's completion
# starts a turn of its own (Claude Code 2.1.282), so attach waits it out.
printf 'BG 5 then report\n' > "$TMP/bg.md"
"$FW" launch testbox wbg --target-repo example/project --kind claude --brief "$TMP/bg.md" --cwd "$proj" >/dev/null
for i in $(seq 1 20); do grep -q '"background_tasks_changed","tasks":\[{' "$ISSUE_WAVE_STATE/workers/wbg/stream.jsonl" 2>/dev/null && break; sleep 0.25; done
expect "a turn ended with a background task listed reads as RUNNING, not IDLE" 0 "RUNNING testbox/wbg .* turn=ended background_tasks=1 " -- "$FW" status testbox wbg
for i in $(seq 1 40); do grep -q '"tasks":\[\]' "$ISSUE_WAVE_STATE/workers/wbg/stream.jsonl" 2>/dev/null && break; sleep 0.25; done
expect "...and the task list clearing starts the task's turn before its notification or init: RUNNING, turn=working" 0 "RUNNING testbox/wbg .* turn=working background_tasks=0 " -- "$FW" status testbox wbg
for i in $(seq 1 40); do grep -q '"task_notification"' "$ISSUE_WAVE_STATE/workers/wbg/stream.jsonl" 2>/dev/null && break; sleep 0.25; done
expect "...as does the notification before the init" 0 "RUNNING testbox/wbg .* turn=working background_tasks=0 " -- "$FW" status testbox wbg
expect "...attach waits for the turn the task's completion starts" 0 "IDLE testbox/wbg .*background task done" -- "$FW" attach testbox wbg --interval 1
settle wbg
# A feeder that outlived its CLI must not follow the archived record forever after a --replace.
tail -n +1 -f "$ISSUE_WAVE_STATE/workers/wbg/input.jsonl" >/dev/null 2>&1 & stale=$!; echo "$stale" > "$ISSUE_WAVE_STATE/workers/wbg/feeder.pid"
"$FW" launch testbox wbg --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --replace >/dev/null
sleep 0.5; kill -0 "$stale" 2>/dev/null && { ko "--replace left the old record's feeder running"; kill "$stale"; } || ok "--replace ends a feeder the old record left behind"
wait "$stale" 2>/dev/null; settle wbg
# The verdict of an ended process reads only what follows the echo of the latest message: a
# message echoed and never answered is no DONE, even with an earlier turn's result after the append.
printf 'BG 4\n' > "$TMP/bg4b.md"; printf 'SILENT\n' > "$TMP/silent-msg.md"
"$FW" launch testbox wqs --target-repo example/project --kind claude --brief "$TMP/bg4b.md" --cwd "$proj" >/dev/null
for i in $(seq 1 20); do grep -q '"background_tasks_changed","tasks":\[{' "$ISSUE_WAVE_STATE/workers/wqs/stream.jsonl" 2>/dev/null && break; sleep 0.25; done
FLEET_DELIVERY_WAIT=0 "$FW" unstick testbox wqs --message "$TMP/silent-msg.md" >/dev/null
expect "a message echoed but never answered before the CLI exited is FAILED, not the earlier turn's DONE" 1 "FAILED testbox/wqs exit=0 no terminal event" -- "$FW" attach testbox wqs --interval 1
}

section "unstick" && {
need_lease
need_worker w1   # its own worktree, for the sibling-session case below
# ludics-lite#259: a live claude worker takes the message by append -- mid-turn it reaches the
# model at the next tool boundary, idle it starts the next turn -- with no kill and no resume.
wsd="$ISSUE_WAVE_STATE/workers/ws"
printf 'SLEEP 6 then report\n' > "$TMP/slow.md"
"$FW" launch testbox ws --target-repo example/project --kind claude --brief "$TMP/slow.md" --cwd "$proj" >/dev/null; sleep 1
pid_before=$(cat "$wsd/feeder.pid")
expect "unstick of a live worker mid-turn appends the message and proves delivery from its echo" 0 \
  "APPENDED testbox/ws kind=claude session=[0-9a-f-]\{36\} to=RUNNING .* delivered (echoed by the CLI)" -- "$FW" unstick testbox ws --message "$TMP/msg.md"
expect "...the turn in flight answers it: attach waits for that reply" 0 "IDLE testbox/ws success .*did: SLEEP 6 then report +msg: Stop and answer now" -- "$FW" attach testbox ws --interval 1
[ "$(cat "$wsd/feeder.pid")" = "$pid_before" ] && ! grep -q '"resumed":true' "$wsd/stream.jsonl" && grep -q '^resumes=0$' "$wsd/meta" &&
  ok "...the same process took it: no restart, no resume" || ko "the append restarted the worker: $(cat "$wsd/meta")"
[ "$(grep -c '' "$wsd/input.jsonl")" -eq 2 ] && [ "$(sed -n 2p "$wsd/input.jsonl" | jq -j '.message.content')" = "$(cat "$TMP/msg.md")" ] &&
  ok "...and input.jsonl logs the message after the brief" || ko "input.jsonl: $(cat "$wsd/input.jsonl")"
printf 'Now the next step.\n' > "$TMP/msg2.md"
expect "an append to an IDLE worker starts its next turn" 0 "APPENDED testbox/ws .* to=IDLE .* delivered" -- "$FW" unstick testbox ws --message "$TMP/msg2.md"
expect "...whose reply attach returns" 0 "IDLE testbox/ws success .*did: Now the next step" -- "$FW" attach testbox ws --interval 1
expect "a live worker refuses extra CLI args on the append path: they need a new process" 1 "UNSTICK REFUSED testbox/ws: extra CLI arguments (--model opus) cannot reach a live process" -- "$FW" unstick testbox ws --message "$TMP/msg.md" -- --model opus
mv "$proj" "$proj.moved"
expect "a live worker whose worktree is gone refuses the append too" 1 "UNSTICK REFUSED testbox/ws: recorded working directory .* is gone" -- "$FW" unstick testbox ws --message "$TMP/msg.md"
mv "$proj.moved" "$proj"
[ "$(grep -c '' "$wsd/input.jsonl")" -eq 3 ] && ok "...neither refusal touched the input channel" || ko "a refused append wrote input: $(cat "$wsd/input.jsonl")"
# meta naming a message input.jsonl never got (a writer killed between the two) strands nothing.
cp "$wsd/meta" "$TMP/ws.meta"; sed -i.bak 's/^awaiting=.*/awaiting=never-sent/' "$wsd/meta" && rm -f "$wsd/meta.bak"
expect "an awaited message missing from the input is not waited on: attach answers IDLE" 0 "IDLE testbox/ws " -- "$FW" attach testbox ws --interval 1
cp "$TMP/ws.meta" "$wsd/meta"
# An appended line the CLI has not read (here: the CLI paused): close would drop it.
cpid=$(pgrep -f -- "session-id $(sed -n 's/^session=//p' "$wsd/meta")" | head -n1)
kill -STOP "$cpid"
printf 'Third message.\n' > "$TMP/msg3.md"
FLEET_DELIVERY_WAIT=0 "$FW" unstick testbox ws --message "$TMP/msg3.md" >/dev/null
expect "close refuses an IDLE worker whose latest message has no reply yet" 1 "CLOSE REFUSED testbox/ws: idle, but the latest message sent has no reply yet" -- "$FW" close testbox ws
kill -CONT "$cpid"
expect "...which it answers once it reads it" 0 "IDLE testbox/ws .*did: Third message" -- "$FW" attach testbox ws --interval 1
cp "$wsd/feeder.pid" "$TMP/feeder.saved"; echo $$ > "$wsd/feeder.pid"
expect "a live session whose input feeder is gone refuses the append and names --kill" 1 "UNSTICK REFUSED testbox/ws: the CLI's session is up but its input channel is not" -- "$FW" unstick testbox ws --message "$TMP/msg.md"
cp "$TMP/feeder.saved" "$wsd/feeder.pid"
jq -cn '{type: "user", uuid: "x-1", message: {role: "user", content: "SLEEP 4"}}' >> "$wsd/input.jsonl"; sleep 2
expect "close refuses a worker whose turn is in progress" 1 "CLOSE REFUSED testbox/ws: not idle (turn=working" -- "$FW" close testbox ws
# A record from before the channel, still running its one-shot turn: no input to append to.
sleep 3; sed -i.bak '/^channel=/d' "$wsd/meta" && rm -f "$wsd/meta.bak"
expect "a live one-shot claude worker still refuses without --kill" 1 "still running.*pass --kill" -- "$FW" unstick testbox ws --message "$TMP/msg.md"
echo "channel=stream-json" >> "$wsd/meta"
expect "unstick --kill stops a live worker and resumes the same session" 0 "RESUMED testbox/ws kind=claude session=[0-9a-f-]\{36\} resume=1 .*(kill-and-resume: --kill stopped the live CLI)" -- \
  "$FW" unstick testbox ws --message "$TMP/msg.md" --kill
sid=$(sed -n 's/^session=//p' "$wsd/meta")
grep -q -- "--resume $sid" "$wsd/run.sh" && grep -q -- "tail -n +6 -f " "$wsd/run.sh" && ok "the resume addresses the recorded session and feeds from the message's own line" || ko "resume command wrong: $(cat "$wsd/run.sh")"
expect "the resumed process answers the message and idles" 0 "IDLE testbox/ws .*did: Stop and answer now" -- "$FW" attach testbox ws --interval 1
grep -q '"resumed":true' "$wsd/stream.jsonl" && ok "stream appended, not truncated, across the resume" || ko "stream lost the resume"
[ "$(tail -n +"$(( $(sed -n 's/^proc_offset=//p' "$wsd/meta") + 1 ))" "$wsd/stream.jsonl" | grep -c '"isReplay":true')" -eq 1 ] && ok "the resumed process read no line an earlier one had" || ko "the resume replayed old input"
grep -q '^resumes=1$' "$wsd/meta" && ok "meta counts the resume" || ko "meta resumes not bumped"
# A CLI that outlives its session (an orphan carrying this record's path) still holds close open.
bash -c 'sleep 4; :' claude "$wsd/" >/dev/null 2>&1 & orphan=$!; t0=$(date +%s)
expect "close ends it with the resumed turn's verdict" 0 "DONE testbox/ws exit=0 .*did: Stop and answer now" -- "$FW" close testbox ws
[ $(( $(date +%s) - t0 )) -ge 3 ] && ! kill -0 "$orphan" 2>/dev/null && ok "...and waits out a CLI still running past its session" || ko "close returned while an orphaned CLI still ran"
wait "$orphan" 2>/dev/null
# Delivery is proven by the echo, not assumed: a CLI that has not read the line yet (here inside a
# turn that reads nothing) leaves it queued and unread, and attach waits for its reply.
printf 'BG 6\n' > "$TMP/bg4.md"
"$FW" launch testbox wq --target-repo example/project --kind claude --brief "$TMP/bg4.md" --cwd "$proj" >/dev/null
for i in $(seq 1 20); do grep -q '"background_tasks_changed","tasks":\[{' "$ISSUE_WAVE_STATE/workers/wq/stream.jsonl" 2>/dev/null && break; sleep 0.25; done
expect "a message the CLI has not read is reported queued, not delivered" 0 "APPENDED testbox/wq .* queued: not echoed within 1s" -- env FLEET_DELIVERY_WAIT=1 "$FW" unstick testbox wq --message "$TMP/msg.md"
expect "...status counts it unread" 0 "turn=.* unread=1 " -- "$FW" status testbox wq
expect "...and attach returns the reply to it, not the turn that ended before it was read" 0 "IDLE testbox/wq .*did: Stop and answer now" -- "$FW" attach testbox wq --interval 1
expect "...after which it is read" 0 "unread=0 " -- "$FW" status testbox wq
settle wq
# A message still queued when the process is killed is fed to the resumed one, before the new one.
"$FW" launch testbox wr --target-repo example/project --kind claude --brief "$TMP/bg4.md" --cwd "$proj" >/dev/null
for i in $(seq 1 20); do grep -q '"background_tasks_changed","tasks":\[{' "$ISSUE_WAVE_STATE/workers/wr/stream.jsonl" 2>/dev/null && break; sleep 0.25; done
FLEET_DELIVERY_WAIT=0 "$FW" unstick testbox wr --message "$TMP/msg.md" >/dev/null
expect "a kill-and-resume over a queued message" 0 "RESUMED testbox/wr " -- "$FW" unstick testbox wr --message "$TMP/msg2.md" --kill
grep -q -- "tail -n +2 -f " "$ISSUE_WAVE_STATE/workers/wr/run.sh" && ok "...resumes from the first line the dead process never echoed" || ko "resume skipped the queued message: $(cat "$ISSUE_WAVE_STATE/workers/wr/run.sh")"
expect "...and the resumed process answers both, the new one last" 0 "IDLE testbox/wr .*did: Now the next step" -- "$FW" attach testbox wr --interval 1
grep -q '"text":"did: Stop and answer now' "$ISSUE_WAVE_STATE/workers/wr/stream.jsonl" && ok "...the queued message had its own turn" || ko "queued message lost across the resume"
settle wr
# A partial last line (an append that failed) is never appended onto, and a resume drops it.
"$FW" launch testbox wp --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" >/dev/null
"$FW" attach testbox wp --interval 1 >/dev/null
printf '{"type":"user","uuid":"par' >> "$ISSUE_WAVE_STATE/workers/wp/input.jsonl"
expect "an append onto a partial input line is refused and names --kill" 1 "UNSTICK REFUSED testbox/wp: .*input.jsonl ends in a partial line" -- "$FW" unstick testbox wp --message "$TMP/msg.md"
expect "...unstick --kill resumes" 0 "RESUMED testbox/wp " -- "$FW" unstick testbox wp --message "$TMP/msg.md" --kill
[ "$(grep -c '' "$ISSUE_WAVE_STATE/workers/wp/input.jsonl")" -eq 2 ] && ! grep -q '"par$' "$ISSUE_WAVE_STATE/workers/wp/input.jsonl" && ok "...with the partial line dropped and the message on its own line" || ko "input after the repair: $(cat "$ISSUE_WAVE_STATE/workers/wp/input.jsonl")"
expect "...and the message is answered" 0 "IDLE testbox/wp .*did: Stop and answer now" -- "$FW" attach testbox wp --interval 1
settle wp
# A feeder whose pid cannot be recorded could never be closed: the worker stops before its CLI.
# FLEET_FEEDER_WAIT=1: a second of polling for the pid, not the default ten.
mkdir "$ISSUE_WAVE_STATE/workers/wr/feeder.pid"
FLEET_FEEDER_WAIT=1 "$FW" unstick testbox wr --message "$TMP/msg.md" >/dev/null
grep -q -- '-lt 5 ]' "$ISSUE_WAVE_STATE/workers/wr/run.sh" && ok "...FLEET_FEEDER_WAIT=1 bounds run.sh's feeder wait at five polls" || ko "run.sh ignored FLEET_FEEDER_WAIT: $(cat "$ISSUE_WAVE_STATE/workers/wr/run.sh")"
expect "an unwritable feeder pid file stops the worker before the CLI starts" 1 "FAILED testbox/wr exit=95" -- "$FW" attach testbox wr --interval 1
rmdir "$ISSUE_WAVE_STATE/workers/wr/feeder.pid"

# ludics-lite#424: --interrupt stops the turn in flight, tool call included, through the same
# channel; a message given with it goes in only after the CLI's receipt, as the next turn.
wid="$ISSUE_WAVE_STATE/workers/wi"
printf 'SLEEP 60 then report\n' > "$TMP/slow60.md"
"$FW" launch testbox wi --target-repo example/project --kind claude --brief "$TMP/slow60.md" --cwd "$proj" >/dev/null; sleep 1
pid_before=$(cat "$wid/feeder.pid"); t0=$(date +%s)
expect "unstick --interrupt --message stops a turn mid-tool, proven by the CLI's receipt" 0 \
  "^INTERRUPTED testbox/wi kind=claude session=[0-9a-f-]\{36\} from=RUNNING request=[0-9a-f-]\{36\} receipt: still_queued=0$" -- "$FW" unstick testbox wi --interrupt --message "$TMP/msg.md"
rid=$(sed -n 's/^INTERRUPTED .* request=\([0-9a-f-]*\) .*/\1/p' <<<"$out")
grep -q "^APPENDED testbox/wi .* delivered (echoed by the CLI)$" <<<"$out" && ok "...then appends the message, which the CLI echoes" || ko "no delivered append after the interrupt: $out"
expect "...the message is its own turn, answered at once" 0 "IDLE testbox/wi success .*did: Stop and answer now" -- "$FW" attach testbox wi --interval 1
[ $(( $(date +%s) - t0 )) -lt 30 ] && ! grep -q '+msg: Stop' "$wid/stream.jsonl" && ok "...not after the 60 s call, and not folded into the aborted turn" || ko "the interrupt did not stop the turn: $(tail -n 5 "$wid/stream.jsonl")"
[ "$(cat "$wid/feeder.pid")" = "$pid_before" ] && ! grep -q '"resumed":true' "$wid/stream.jsonl" && grep -q '^resumes=0$' "$wid/meta" &&
  ok "...the same process: no restart, no resume" || ko "the interrupt restarted the worker: $(cat "$wid/meta")"
[ "$(jq -c 'select(.type == "result") | [.is_error, .terminal_reason]' "$wid/stream.jsonl" | tr '\n' ' ')" = '[true,"aborted_tools"] [false,null] ' ] &&
  ok "...the aborted turn ends in its own error result, before the message's" || ko "results: $(jq -c 'select(.type == "result")' "$wid/stream.jsonl")"
[ "$(sed -n 2p "$wid/input.jsonl" | jq -c .)" = "{\"type\":\"control_request\",\"request_id\":\"$rid\",\"request\":{\"subtype\":\"interrupt\"}}" ] &&
  [ "$(sed -n 3p "$wid/input.jsonl" | jq -j '.message.content')" = "$(cat "$TMP/msg.md")" ] &&
  ok "...and input.jsonl logs the request, then the message" || ko "input.jsonl: $(cat "$wid/input.jsonl")"
expect "status counts no unread message: a control line is not a message" 0 "turn=ended background_tasks=0 unread=0" -- "$FW" status testbox wi
expect "a bare --interrupt to an IDLE worker: a receipt, nothing to stop" 0 "^INTERRUPTED testbox/wi .* from=IDLE .* still_queued=0$" -- "$FW" unstick testbox wi --interrupt
expect "...which leaves its last reply standing" 0 "IDLE testbox/wi success .*did: Stop and answer now" -- "$FW" attach testbox wi --interval 1
jq -cn '{type: "user", uuid: "x-2", message: {role: "user", content: "SLEEP 60"}}' >> "$wid/input.jsonl"; sleep 2
expect "a bare --interrupt mid-turn stops it" 0 "^INTERRUPTED testbox/wi .* from=RUNNING " -- "$FW" unstick testbox wi --interrupt
expect "...and attach names the aborted turn's terminal_reason, which a crash does not" 1 "FAILED testbox/wi idle error_during_execution is_error=true turns=[0-9]* terminal_reason=aborted_tools " -- "$FW" attach testbox wi --interval 1
expect "...and attach reads the aborted turn as FAILED idle, awaiting input" 1 "FAILED testbox/wi idle error_during_execution is_error=true .*awaiting input" -- "$FW" attach testbox wi --interval 1
jq -cn '{type: "user", uuid: "x-3", message: {role: "user", content: "SLEEP 60 NOINT"}}' >> "$wid/input.jsonl"; sleep 2
n_in=$(grep -c '' "$wid/input.jsonl")
expect "a CLI that answers the interrupt with an error: FAILED, and the message is not sent" 1 \
  "^INTERRUPT FAILED testbox/wi request=[0-9a-f-]\{36\}: the CLI answered it with an error: shim: not now; the message was NOT sent (it stays at .*/messages/" -- "$FW" unstick testbox wi --interrupt --message "$TMP/msg2.md"
[ "$(grep -c '' "$wid/input.jsonl")" -eq $((n_in + 1)) ] && ok "...only the request went in" || ko "input after a failed interrupt: $(cat "$wid/input.jsonl")"
expect "--interrupt and --kill are refused together" 2 "unstick: --interrupt stops the turn and keeps the process" -- "$FW" unstick testbox wi --interrupt --kill
expect "--interrupt takes no CLI arguments" 2 "unstick: --interrupt reaches a live process, which takes no CLI arguments" -- "$FW" unstick testbox wi --interrupt -- --model opus
expect "a non-holder cannot interrupt" 1 "UNSTICK REFUSED testbox/wi: coordinator lease held by" -- env FLEET_COORDINATOR=other-session "$FW" unstick testbox wi --interrupt
"$FW" unstick testbox wi --message "$TMP/msg.md" --kill >/dev/null; settle wi
expect "an ended worker refuses --interrupt: it never falls back to a resume" 1 "UNSTICK REFUSED testbox/wi: --interrupt reaches only a live claude worker .* EXITED(0) .* nothing was sent" -- "$FW" unstick testbox wi --interrupt --message "$TMP/msg.md"
grep -q '^resumes=1$' "$wid/meta" && [ -f "$wid/exit" ] && ok "...and did not resume it" || ko "a refused interrupt resumed: $(cat "$wid/meta")"
# A CLI that never reads the request (here: inside a turn that reads nothing) sends no receipt:
# the message stays out, and a kill-and-resume behind a queued message does not feed the new
# process that request, which would abort the turn it resumes into.
printf 'BG 30\n' > "$TMP/bg30.md"   # reads nothing for 30 s; the --kill below ends it sooner
"$FW" launch testbox wu --target-repo example/project --kind claude --brief "$TMP/bg30.md" --cwd "$proj" >/dev/null
wud="$ISSUE_WAVE_STATE/workers/wu"
for i in $(seq 1 20); do grep -q '"background_tasks_changed","tasks":\[{' "$wud/stream.jsonl" 2>/dev/null && break; sleep 0.25; done
FLEET_DELIVERY_WAIT=0 "$FW" unstick testbox wu --message "$TMP/msg.md" >/dev/null
expect "an interrupt the CLI never answers is UNCONFIRMED, and the message is not sent" 1 \
  "^INTERRUPT UNCONFIRMED testbox/wu request=[0-9a-f-]\{36\}: on the input channel, but the CLI sent no receipt within 1s .*the message was NOT sent .*unstick --kill" -- \
  env FLEET_DELIVERY_WAIT=1 "$FW" unstick testbox wu --interrupt --message "$TMP/msg2.md"
[ "$(grep -c '' "$wud/input.jsonl")" -eq 3 ] && grep -q '^{"type":"control_request"' <<<"$(sed -n 3p "$wud/input.jsonl")" && ok "...the request is the input's last line" || ko "input: $(cat "$wud/input.jsonl")"
expect "a kill-and-resume behind a queued message and an unanswered interrupt" 0 "RESUMED testbox/wu " -- "$FW" unstick testbox wu --message "$TMP/msg2.md" --kill
grep -q -- "tail -n +2 -f " "$wud/run.sh" && [ "$(grep -c '' "$wud/input.jsonl")" -eq 3 ] && ! grep -q control_request "$wud/input.jsonl" &&
  ok "...feeds the queued message and drops the stale request" || ko "resume input: $(cat "$wud/run.sh") -- $(cat "$wud/input.jsonl")"
expect "...and the resumed process answers both, the new one last" 0 "IDLE testbox/wu success .*did: Now the next step" -- "$FW" attach testbox wu --interval 1
grep -q '"text":"did: Stop and answer now' <<<"$(tail -n +"$(( $(sed -n 's/^proc_offset=//p' "$wud/meta") + 1 ))" "$wud/stream.jsonl")" && ok "...the queued message had its own turn" || ko "queued message lost across the resume"
settle wu

printf 'SLEEP 60\n' > "$TMP/slow.md"
"$FW" launch testbox a.b --target-repo example/project --kind claude --brief "$TMP/slow.md" --cwd "$proj" >/dev/null; sleep 1
expect "a dotted name is killed by a literal match, not a regex" 0 "RESUMED testbox/a.b" -- "$FW" unstick testbox a.b --message "$TMP/msg.md" --kill
# tmux turns a `.` in a session name into `_`: the session must still be found by the worker's name.
expect "...and its session is found by its own name, not read as an orphan" 0 "^\(RUNNING\|IDLE\) testbox/a.b " -- "$FW" status testbox a.b
settle a.b
mkdir -p "$TMP/nouuid"; printf '#!/bin/sh\nexit 1\n' > "$TMP/nouuid/uuidgen"; chmod +x "$TMP/nouuid/uuidgen"
expect "no uuidgen: a fallback still yields a session id" 0 "LAUNCHED testbox/nu kind=claude session=[0-9a-f-]\{36\}" -- \
  env PATH="$TMP/nouuid:$PATH" "$FW" launch testbox nu --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
settle nu

"$FW" launch testbox wo --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" >/dev/null; settle wo
bash -c 'sleep 30; :' claude "$ISSUE_WAVE_STATE/workers/wo/" >/dev/null 2>&1 & orphan=$!; disown; sleep 0.5
expect "an orphaned CLI (tmux gone) refuses a plain unstick" 1 "tmux is gone but a CLI still runs" -- "$FW" unstick testbox wo --message "$TMP/msg.md"
kill -0 "$orphan" 2>/dev/null && ok "the orphan was not killed by the refused unstick" || ko "plain unstick killed the orphan"
expect "unstick --kill terminates the orphan and resumes" 0 "RESUMED testbox/wo" -- "$FW" unstick testbox wo --message "$TMP/msg.md" --kill
kill -0 "$orphan" 2>/dev/null && ko "orphan survived --kill" || ok "--kill terminated the orphan"
settle wo
mv "$ISSUE_WAVE_STATE/workers/wo/run.sh" "$TMP/run.saved"; mkdir "$ISSUE_WAVE_STATE/workers/wo/run.sh"
expect "unstick refuses when the resume script cannot be written" 1 "UNSTICK REFUSED testbox/wo: cannot write .*run.sh" -- "$FW" unstick testbox wo --message "$TMP/msg.md"
[ -f "$ISSUE_WAVE_STATE/workers/wo/exit" ] && ok "a refused unstick keeps the previous exit record" || ko "refused unstick destroyed the exit record"
rmdir "$ISSUE_WAVE_STATE/workers/wo/run.sh"; mv "$TMP/run.saved" "$ISSUE_WAVE_STATE/workers/wo/run.sh"
bash -c 'sleep 3; :' tail -f "$ISSUE_WAVE_STATE/workers/wo/stream.jsonl" >/dev/null 2>&1 & disown; sleep 0.5
expect "a diagnostic process on the record does not block a plain unstick" 0 "RESUMED testbox/wo" -- "$FW" unstick testbox wo --message "$TMP/msg.md"
settle wo
cp "$ISSUE_WAVE_STATE/workers/wo/meta" "$TMP/meta.before"; cp "$ISSUE_WAVE_STATE/workers/wo/input.jsonl" "$TMP/input.before"
expect "a tmux failure during unstick restores exit and meta" 1 "tmux failed (previous exit record and meta kept)" -- env SHIM_TMUX_FAIL_NEW=1 "$FW" unstick testbox wo --message "$TMP/msg.md"
cmp -s "$ISSUE_WAVE_STATE/workers/wo/meta" "$TMP/meta.before" && [ -f "$ISSUE_WAVE_STATE/workers/wo/exit" ] && ok "meta and exit are as before the failed resume" || ko "meta or exit changed by a failed resume"
cmp -s "$ISSUE_WAVE_STATE/workers/wo/input.jsonl" "$TMP/input.before" && ok "...and the input channel takes the undelivered message back" || ko "input.jsonl changed by a failed resume: $(cat "$ISSUE_WAVE_STATE/workers/wo/input.jsonl")"
# A resume creates a tmux session with no preflight in front of it, so it runs the stale-server
# check itself (ludics-lite#327), before it touches the record.
printf 'PATH=%s\nROCM_PATH=/usr\n' "$PATH" > "$TMP/genv-stale"
expect "a resume refuses against a stale tmux server" 1 "UNSTICK REFUSED testbox/wo: stale tmux server environment (ROCM_PATH is /usr in the server but unset in a fresh shell)" -- \
  env -u ROCM_PATH -u HIP_PATH -u OPAM_SWITCH_PREFIX SHIM_TMUX_GENV="$TMP/genv-stale" "$FW" unstick testbox wo --message "$TMP/msg.md"
cmp -s "$ISSUE_WAVE_STATE/workers/wo/meta" "$TMP/meta.before" && [ -f "$ISSUE_WAVE_STATE/workers/wo/exit" ] && ok "a resume refused over a stale server leaves meta and exit as they were" || ko "meta or exit changed by a stale-server refusal"
expect "...and the worker still reads as its previous successful turn" 0 "DONE testbox/wo exit=0" -- "$FW" attach testbox wo --interval 1
# ...and its GitHub probe of the server (ludics-lite#374): a server handing out a dead credential.
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" new-session -d -s holder374 'sleep 300'
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" set-environment -g SHIM_GH 401
expect "a resume refuses against a tmux server whose GitHub credential is dead" 1 "UNSTICK REFUSED testbox/wo: the running tmux server on testbox gives a new session a GitHub credential that does not work (gh api user: gh: Bad credentials (HTTP 401))" -- \
  "$FW" unstick testbox wo --message "$TMP/msg.md"
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" set-environment -gu SHIM_GH
"$REAL_TMUX" -L "$FLEET_TMUX_SOCKET" kill-session -t =holder374
cmp -s "$ISSUE_WAVE_STATE/workers/wo/meta" "$TMP/meta.before" && [ -f "$ISSUE_WAVE_STATE/workers/wo/exit" ] && ok "...leaving meta and exit as they were" || ko "meta or exit changed by a GitHub refusal"
expect "...and with no server running, against the credential of the shell that would start one" 1 "UNSTICK REFUSED testbox/wo: GitHub credential refused in a non-interactive session on testbox (gh api user: gh: Bad credentials (HTTP 401))" -- \
  env SHIM_GH=401 FLEET_TMUX_SOCKET="fwtest-none-$$" "$FW" unstick testbox wo --message "$TMP/msg.md"
cmp -s "$ISSUE_WAVE_STATE/workers/wo/meta" "$TMP/meta.before" && [ -f "$ISSUE_WAVE_STATE/workers/wo/exit" ] && ok "...leaving meta and exit as they were too" || ko "meta or exit changed by a no-server GitHub refusal"
echo 99 > "$ISSUE_WAVE_STATE/workers/wo/exit.prev"; echo "kind=stale" > "$ISSUE_WAVE_STATE/workers/wo/meta.prev"; cp "$ISSUE_WAVE_STATE/workers/wo/meta" "$TMP/wo.meta"
mv "$proj" "$proj.moved"
expect "unstick refuses when the recorded worktree is gone, before touching the record" 1 "recorded working directory .* is gone" -- "$FW" unstick testbox wo --message "$TMP/msg.md"
[ -f "$ISSUE_WAVE_STATE/workers/wo/exit" ] && [ "$(cat "$ISSUE_WAVE_STATE/workers/wo/exit")" = 0 ] && cmp -s "$ISSUE_WAVE_STATE/workers/wo/meta" "$TMP/wo.meta" && ok "the exit record survived and stale .prev files were not restored over it" || ko "exit/meta changed by the refused unstick: $(cat "$ISSUE_WAVE_STATE/workers/wo/exit")"
rm -f "$ISSUE_WAVE_STATE/workers/wo/exit.prev" "$ISSUE_WAVE_STATE/workers/wo/meta.prev"
mv "$proj.moved" "$proj"
expect "a non-holder cannot unstick" 1 "UNSTICK REFUSED testbox/wo: coordinator lease held by" -- env FLEET_COORDINATOR=other-session "$FW" unstick testbox wo --message "$TMP/msg.md"

printf 'SLEEP 5\n' > "$TMP/slow5.md"
"$FW" launch testbox dup --target-repo example/project --kind claude --brief "$TMP/slow5.md" --cwd "$proj" >"$TMP/dup-a.out" 2>&1 & da=$!
"$FW" launch testbox dup --target-repo example/project --kind claude --brief "$TMP/slow5.md" --cwd "$proj" >"$TMP/dup-b.out" 2>&1 & db=$!
wait "$da" "$db"
launched=$(cat "$TMP/dup-a.out" "$TMP/dup-b.out" | grep -c '^LAUNCHED testbox/dup')
[ "$launched" -eq 1 ] && ok "two overlapping launches of one name: exactly one LAUNCHED" || ko "overlapping launches: $launched LAUNCHED -- $(cat "$TMP/dup-a.out" "$TMP/dup-b.out")"
# Three guards can refuse the loser, depending on where the winner is when the loser arrives: the
# name lock, the liveness guard, or -- once the winner has published its record and its CLI is up --
# the worktree ownership check. Each is a refusal; which one fires is timing.
grep -q 'another launch or unstick of this name is in progress\|already running\|already owned by live worker' "$TMP/dup-a.out" "$TMP/dup-b.out" && ok "the other was refused by the lock, the liveness guard or ownership" || ko "no refusal for the overlapping launch -- $(cat "$TMP/dup-a.out" "$TMP/dup-b.out")"
[ -d "$ISSUE_WAVE_STATE/locks/dup" ] && ko "launch lock left behind" || ok "launch lock released"
settle dup   # dup shares $proj; a live owner would refuse q
mkdir -p "$ISSUE_WAVE_STATE/locks/q"; echo 999999 > "$ISSUE_WAVE_STATE/locks/q/pid"
expect "a lock left by a dead holder is reclaimed" 0 "LAUNCHED testbox/q" -- "$FW" launch testbox q --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
settle q
mkdir -p "$ISSUE_WAVE_STATE/locks/q"
expect "a fresh ownerless lock (registration in progress) still refuses" 1 "another launch or unstick of this name is in progress" -- "$FW" launch testbox q --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --replace
touch -t 202001010000 "$ISSUE_WAVE_STATE/locks/q"
expect "an old ownerless lock (shell died before the pid write) is reclaimed" 0 "LAUNCHED testbox/q" -- "$FW" launch testbox q --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --replace
settle q
mkdir -p "$ISSUE_WAVE_STATE/locks/q"; echo $$ > "$ISSUE_WAVE_STATE/locks/q/pid"; echo "bogus start" > "$ISSUE_WAVE_STATE/locks/q/start"
expect "a lock whose pid is live but whose start time differs (pid reuse) is reclaimed" 0 "LAUNCHED testbox/q" -- "$FW" launch testbox q --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --replace
settle q
mkdir -p "$ISSUE_WAVE_STATE/locks/q"; echo $$ > "$ISSUE_WAVE_STATE/locks/q/pid"; ps -o lstart= -p $$ | tr -s ' ' > "$ISSUE_WAVE_STATE/locks/q/start"
expect "a lock held by a live process still refuses" 1 "another launch or unstick of this name is in progress" -- "$FW" launch testbox q --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --replace
rm -rf "$ISSUE_WAVE_STATE/locks/q"
"$FW" launch testbox q.mutating --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" >/dev/null; settle q.mutating
expect "a worker named like a lock suffix does not block its sibling" 0 "LAUNCHED testbox/q" -- "$FW" launch testbox q --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --replace
settle q
settle dup
"$FW" unstick testbox dup --message "$TMP/msg.md" >"$TMP/un-a.out" 2>&1 & ua=$!
"$FW" unstick testbox dup --message "$TMP/msg.md" >"$TMP/un-b.out" 2>&1 & ub=$!
wait "$ua" "$ub"
resumed=$(cat "$TMP/un-a.out" "$TMP/un-b.out" | grep -c '^RESUMED testbox/dup')
# The other one either met the name lock, or came after the resume and appended to its process.
other=$(cat "$TMP/un-a.out" "$TMP/un-b.out" | grep -c '^APPENDED testbox/dup\|another launch or unstick of this name is in progress')
[ "$resumed" -eq 1 ] && [ "$other" -eq 1 ] && ok "two overlapping unsticks of one ended worker: exactly one RESUMED, the other locked out or appended" || ko "overlapping unsticks: $resumed RESUMED -- $(cat "$TMP/un-a.out" "$TMP/un-b.out")"
settle dup
bash -c 'sleep 3; :' tail -f "$ISSUE_WAVE_STATE/workers/dup/stream.jsonl" >/dev/null 2>&1 & disown; sleep 0.5
expect "a diagnostic process on a record file is not the worker" 0 "EXITED(0) testbox/dup" -- "$FW" status testbox dup
rm -rf "$ISSUE_WAVE_STATE/incoming"; : > "$ISSUE_WAVE_STATE/incoming"
expect "a brief that cannot be staged is a refusal, not an unreachable box" 1 "LAUNCH REFUSED testbox/blocked: cannot stage the brief" -- "$FW" launch testbox blocked --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
rm -f "$ISSUE_WAVE_STATE/incoming"
: > "$ISSUE_WAVE_STATE/workers/blocked"
expect "a record directory that cannot be created is a refusal naming it" 1 "LAUNCH REFUSED testbox/blocked: cannot create the worker record" -- "$FW" launch testbox blocked --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
rm -f "$ISSUE_WAVE_STATE/workers/blocked"

printf 'SLEEP 20\n' > "$TMP/slow20.md"
"$FW" launch testbox own-a --target-repo example/project --kind claude --brief "$TMP/slow20.md" --cwd "$proj" >/dev/null; sleep 1
expect "a second worker on a worktree a live worker owns is refused" 1 "already owned by live worker own-a" -- "$FW" launch testbox own-b --target-repo example/project --kind claude --brief "$brief" --cwd "$proj/"
"$FW" unstick testbox own-a --message "$TMP/msg.md" --kill >/dev/null; settle own-a
expect "...and allowed once that worker has finished" 0 "LAUNCHED testbox/own-b" -- "$FW" launch testbox own-b --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
settle own-b
"$FW" launch testbox race-x --target-repo example/project --kind claude --brief "$TMP/slow5.md" --cwd "$proj" >"$TMP/rx.out" 2>&1 & rx=$!
"$FW" launch testbox race-y --target-repo example/project --kind claude --brief "$TMP/slow5.md" --cwd "$proj" >"$TMP/ry.out" 2>&1 & ry=$!
wait "$rx" "$ry"
n=$(cat "$TMP/rx.out" "$TMP/ry.out" | grep -c '^LAUNCHED ')
[ "$n" -eq 1 ] && ok "two concurrent launches under different names on one worktree: exactly one LAUNCHED" || ko "worktree race: $n LAUNCHED -- $(cat "$TMP/rx.out" "$TMP/ry.out")"
grep -q 'already owned by live worker' "$TMP/rx.out" "$TMP/ry.out" && ok "the other was refused by ownership" || ko "no ownership refusal: $(cat "$TMP/rx.out" "$TMP/ry.out")"
[ -d "$ISSUE_WAVE_STATE/launch.lock" ] && ko "box-wide launch lock left behind" || ok "box-wide launch lock released"
for w in race-x race-y; do "$FW" unstick testbox $w --message "$TMP/msg.md" --kill >/dev/null 2>&1; settle $w; done
"$FW" launch testbox hold --target-repo example/project --kind claude --brief "$TMP/slow20.md" --cwd "$proj" >/dev/null; sleep 1
expect "unstick refuses to resume into a worktree another live worker now owns" 1 "UNSTICK REFUSED testbox/own-b: worktree .* is now owned by live worker hold" -- "$FW" unstick testbox own-b --message "$TMP/msg.md"
"$FW" unstick testbox hold --message "$TMP/msg.md" --kill >/dev/null; settle hold
"$FW" launch testbox p-1 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" >/dev/null; settle p-1
"$FW" launch testbox p-12 --target-repo example/project --kind claude --brief "$TMP/slow20.md" --cwd "$proj-worktrees/w1" >/dev/null; sleep 1   # its own worktree: ownership is not what this case tests
expect "a finished worker is not read as running through a prefix-matching sibling session" 0 "EXITED(0) testbox/p-1 " -- "$FW" status testbox p-1
expect "unstick --kill of the finished worker leaves the sibling session alone" 0 "RESUMED testbox/p-1" -- "$FW" unstick testbox p-1 --message "$TMP/msg.md" --kill
expect "...the sibling is still running" 0 "RUNNING testbox/p-12" -- "$FW" status testbox p-12
settle p-1
"$FW" unstick testbox p-12 --message "$TMP/msg.md" --kill >/dev/null; settle p-12
expect "a first launch whose tmux fails leaves no record behind" 1 "LAUNCH REFUSED testbox/tf: tmux failed" -- env SHIM_TMUX_FAIL_NEW=1 "$FW" launch testbox tf --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
[ -d "$ISSUE_WAVE_STATE/workers/tf" ] && ko "failed first launch left a record" || ok "no record left by the failed first launch"
expect "...so the name launches normally afterwards" 0 "LAUNCHED testbox/tf" -- "$FW" launch testbox tf --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
settle tf
expect "a --replace whose tmux fails restores the previous record" 1 "tmux failed (previous record restored)" -- env SHIM_TMUX_FAIL_NEW=1 "$FW" launch testbox tf --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --replace
expect "...and the previous worker still reads as done" 0 "EXITED(0) testbox/tf" -- "$FW" status testbox tf
expect "a stalling project fetch is bounded and refused before any record is touched" 1 "git fetch in .* timed out after 2s" -- \
  env SHIM_GIT_HANG_FETCH=1 FLEET_FETCH_TIMEOUT=2 "$FW" launch testbox fh --target-repo example/project --kind claude --brief "$brief" --repo "$proj" --branch claude/fh
[ -d "$ISSUE_WAVE_STATE/workers/fh" ] && ko "a refused fetch left a record" || ok "no record left by the refused fetch"
grep -q '^fh-' <<<"$(ls "$ISSUE_WAVE_STATE/incoming/" 2>/dev/null)" && ko "a refused fetch left a staged brief" || ok "no staged brief left by the refused fetch"
}

section "codex workers" && {
need_lease
expect "codex launch captures the thread id from the stream" 0 "LAUNCHED testbox/c1 kind=codex session=0199-shim-" -- \
  "$FW" launch testbox c1 --target-repo example/project --kind codex --brief "$brief" --cwd "$proj"
grep -qF -- "codex exec --json --yolo -C $(printf '%q' "$proj") -o " "$ISSUE_WAVE_STATE/workers/c1/run.sh" && grep -qF -- "last-message.md - < " "$ISSUE_WAVE_STATE/workers/c1/run.sh" && ok "codex command shape (brief on stdin, -o last message)" || ko "codex command: $(cat "$ISSUE_WAVE_STATE/workers/c1/run.sh")"
expect "codex attach reads turn.completed and the last message" 0 "DONE testbox/c1 exit=0 turn.completed .*codex did: Fix issue" -- "$FW" attach testbox c1 --interval 1
expect "codex log prints agent messages" 0 "codex did: Fix issue" -- "$FW" log testbox c1
printf '{"type":"item.completed","item":{"type":"agent_mes' >> "$ISSUE_WAVE_STATE/workers/c1/stream.jsonl"; printf '\n{"type":"item.completed","item":{"type":"agent_message","text":"after the damage"}}\n' >> "$ISSUE_WAVE_STATE/workers/c1/stream.jsonl"
expect "a truncated JSONL line does not hide the events after it" 0 "after the damage" -- "$FW" log testbox c1
sed -i.bak '/^session=/d' "$ISSUE_WAVE_STATE/workers/c1/meta" && rm -f "$ISSUE_WAVE_STATE/workers/c1/meta.bak"
expect "status recovers the thread id from the stream when meta lacks it" 0 "session=0199-shim-" -- "$FW" status testbox c1
expect "codex unstick resumes by thread id (from the stream) with --yolo" 0 "RESUMED testbox/c1 kind=codex session=0199-shim-" -- "$FW" unstick testbox c1 --message "$TMP/msg.md"
tid=$(sed -n '/^session=/ { s/^session=//; p; q; }' "$ISSUE_WAVE_STATE/workers/c1/meta")
grep -q -- "codex exec resume $tid --yolo --json -" "$ISSUE_WAVE_STATE/workers/c1/run.sh" && ok "codex resume command shape" || ko "codex resume: $(cat "$ISSUE_WAVE_STATE/workers/c1/run.sh")"
settle c1
expect "a resumed turn that emits nothing is FAILED even though the first turn succeeded" 1 "FAILED testbox/c1 exit=0 no terminal event" -- \
  env SHIM_CODEX_SILENT_RESUME=1 bash -c '"$0" unstick testbox c1 --message "$1" && "$0" attach testbox c1 --interval 1' "$FW" "$TMP/msg.md"
"$FW" unstick testbox c1 --message "$TMP/msg.md" >/dev/null
expect "the resumed codex turn's verdict carries the NEW message, from the stream" 0 "DONE testbox/c1 exit=0 turn.completed .*| codex did: Stop and answer now" -- "$FW" attach testbox c1 --interval 1
printf 'Watch armed; it wakes me later\n' > "$TMP/cstrand.md"
"$FW" launch testbox cst --target-repo example/project --kind codex --brief "$TMP/cstrand.md" --cwd "$proj" >/dev/null
expect "a codex turn's last agent message is read for the strand mark too" 0 \
  'DONE testbox/cst exit=0 turn.completed .* | PROBABLE STRAND: the final message says "wakes me"' -- "$FW" attach testbox cst --interval 1
}

section "log --last-result (fixture streams)" && {
# Hand-written records: the far side reads meta's kind and stream.jsonl, nothing else, so a
# fixture stream pins the turn rules (farside.LOG_LAST_RESULT) without a CLI run.
# fixture_stream <name> <kind>: a finished record whose stream is stdin.
fixture_stream() {
  local d="$ISSUE_WAVE_STATE/workers/$1"
  mkdir -p "$d" && printf 'kind=%s\n' "$2" > "$d/meta" && cat > "$d/stream.jsonl" && printf '0\n' > "$d/exit"
}
# expect_exact <label> <want-rc> <want-file> -- <cmd...>: stdout byte for byte, and the status.
expect_exact() {
  local label="$1" want_rc="$2" want="$3"; shift 3; [ "$1" = -- ] && shift
  "$@" > "$TMP/exact.out" 2>&1; rc=$?
  if [ "$rc" -eq "$want_rc" ] && cmp -s "$want" "$TMP/exact.out"; then ok "$label"
  else ko "$label (rc=$rc want $want_rc) -- $(diff "$want" "$TMP/exact.out" | head -n 8)"; fi
}
two=$(printf 'EXECUTION_REQUEST /state/workers/lr-turns/request.json\nThe hand-back, line two.')
jq -cn --arg two "$two" '
  {type:"system",subtype:"init",session_id:"s1"},
  {type:"assistant",message:{content:[{type:"text",text:"working on turn one"}]}},
  {type:"result",subtype:"success",is_error:false,result:"turn one final"},
  {type:"user",isReplay:true,uuid:"u2",message:{content:"continue"}},
  {type:"assistant",message:{content:[{type:"text",text:"working on turn two"}]}},
  {type:"result",subtype:"success",is_error:false,result:$two}' | fixture_stream lr-turns claude
printf '%s\n' "$two" > "$TMP/want-turns"
expect_exact "a claude stream of several turns prints the last result alone, whole" 0 "$TMP/want-turns" -- "$FW" log testbox lr-turns --last-result
printf '%s\n' '{"type":"user","isReplay":true,"uuid":"u3","message":{"content":"more"}}' '{"type":"assistant","message":{"content":[{"type":"text","text":"turn three, mid-flight"}]}}' >> "$ISSUE_WAVE_STATE/workers/lr-turns/stream.jsonl"
expect_exact "...and a turn still in progress leaves the latest ended turn's result in place" 0 "$TMP/want-turns" -- "$FW" log testbox lr-turns --last-result
seq -f 'hand-back line %g' 1 60 > "$TMP/want-long"
jq -cn --rawfile r "$TMP/want-long" '($r | rtrimstr("\n")) as $t
  | {type:"assistant",message:{content:[{type:"text",text:$t}]}}, {type:"result",subtype:"success",is_error:false,result:$t}' | fixture_stream lr-long claude
expect_exact "a result longer than log's 40-line default prints whole" 0 "$TMP/want-long" -- "$FW" log testbox lr-long --last-result
out=$("$FW" log testbox lr-long 2>&1); [ "$(grep -c '' <<<"$out")" -eq 40 ] && ok "...where plain log still shows the 40-line tail" || ko "plain log of lr-long: $(grep -c '' <<<"$out") lines"
expect "-n with --last-result is refused" 2 "log: --last-result prints the whole final message; -n does not apply" -- "$FW" log testbox lr-long --last-result -n 5
jq -cn '{type:"system",subtype:"init",session_id:"s1"}, {type:"assistant",message:{content:[{type:"text",text:"still going"}]}}' | fixture_stream lr-none claude
printf 'NO RESULT testbox/lr-none: no result event in the stream: no turn has ended yet\n' > "$TMP/want-none"
expect_exact "a claude stream with no result event is one NO RESULT line, exit 1" 1 "$TMP/want-none" -- "$FW" log testbox lr-none --last-result
jq -cn '{type:"result",subtype:"error_max_turns",is_error:true}' | fixture_stream lr-notext claude
expect "a last result with no text names its subtype" 1 "^NO RESULT testbox/lr-notext: the latest turn ended (error_max_turns) with no result text$" -- "$FW" log testbox lr-notext --last-result
expect "an unknown worker stays UNKNOWN, exit 3" 3 "^UNKNOWN testbox/lr-nope" -- "$FW" log testbox lr-nope --last-result
# codex: a turn is turn.started .. turn.completed|turn.failed; each resume appends one.
jq -cn '
  {type:"thread.started",thread_id:"t1"}, {type:"turn.started"},
  {type:"item.completed",item:{type:"agent_message",text:"codex turn one final"}}, {type:"turn.completed"},
  {type:"thread.started",thread_id:"t1"}, {type:"turn.started"},
  {type:"item.completed",item:{type:"agent_message",text:"codex turn two, a progress note"}},
  {type:"item.completed",item:{type:"command_execution",command:"dune test"}},
  {type:"item.completed",item:{type:"agent_message",text:"EXECUTION_RESULT /state/result.json\ncodex turn two final"}}, {type:"turn.completed"},
  {type:"thread.started",thread_id:"t1"}, {type:"turn.started"},
  {type:"item.completed",item:{type:"agent_message",text:"a turn the exec never finished"}}' | fixture_stream lr-codex codex
printf 'EXECUTION_RESULT /state/result.json\ncodex turn two final\n' > "$TMP/want-codex"
expect_exact "a codex stream prints the last agent_message of the last completed turn" 0 "$TMP/want-codex" -- "$FW" log testbox lr-codex --last-result
printf '%s\n' '{"type":"thread.started","thread_id":"t1"}' '{"type":"turn.started"}' '{"type":"turn.failed","error":{"message":"Selected model is at capacity"}}' >> "$ISSUE_WAVE_STATE/workers/lr-codex/stream.jsonl"
expect "...and a latest turn that failed is NO RESULT naming the failure" 1 "^NO RESULT testbox/lr-codex: the latest turn ended turn.failed: Selected model is at capacity$" -- "$FW" log testbox lr-codex --last-result
jq -cn '{type:"thread.started",thread_id:"t2"}, {type:"turn.started"}, {type:"item.completed",item:{type:"agent_message",text:"mid-turn"}}' | fixture_stream lr-codex-none codex
expect "a codex stream with no ended turn is NO RESULT" 1 "^NO RESULT testbox/lr-codex-none: no turn.completed or turn.failed in the stream" -- "$FW" log testbox lr-codex-none --last-result
}

section "halt" && {
need_lease
mkdir -p "$ISSUE_WAVE_STATE/HALT"
expect "halt that cannot write its marker fails loudly" 1 "HALT FAILED: cannot write" -- "$FW" halt "unwritable"
rmdir "$ISSUE_WAVE_STATE/HALT"
expect "native gate accepts the lease holder" 0 "" -- "$FW" gate --target-repo example/project
expect "native gate refuses another coordinator" 1 "coordinator lease held" -- "${B[@]}" gate --target-repo example/project
expect "native gate rejects unknown flags" 2 "gate: expected" -- "$FW" gate --target-repo example/project --oops
expect "halted reports open" 0 "launches open" -- "$FW" halted
expect "halt records the reason" 0 "HALTED: launches refused" -- "$FW" halt "master red at abc123, owner: coordinator"
expect "halted reports the reason, exit 1" 1 "HALTED .*master red at abc123" -- "$FW" halted
expect "native gate refuses while halted" 1 "launches halted" -- "$FW" gate --target-repo example/project
expect "native triage gate allows the holder during halt" 0 "" -- "$FW" gate --target-repo example/project --force
expect "native triage gate still refuses a non-holder" 1 "coordinator lease held" -- "${B[@]}" gate --target-repo example/project --force
expect "launch refuses while halted" 1 "LAUNCH REFUSED testbox/h1: launches halted -- .*master red" -- "$FW" launch testbox h1 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
expect "--force launches anyway (the triage worker)" 0 "LAUNCHED testbox/h1" -- "$FW" launch testbox h1 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj" --force
settle h1
expect "resume-launches clears it" 0 "RESUMED launches" -- "$FW" resume-launches
expect "launch works again" 0 "LAUNCHED testbox/h2" -- "$FW" launch testbox h2 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
settle h2
"$FW" halt "adopted mid-halt" >/dev/null
"${B[@]}" claim --take >/dev/null
expect "a coordinator adopting the lease inherits the halt" 1 "LAUNCH REFUSED testbox/h3: launches halted -- .*adopted mid-halt" -- \
  "${B[@]}" launch testbox h3 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
expect "...and reads it with halted" 1 "HALTED .*adopted mid-halt" -- "${B[@]}" halted
"$FW" claim --take >/dev/null; "$FW" resume-launches >/dev/null
expect "halt needs a reason" 2 "halt: give the reason" -- "$FW" halt
expect "resume-launches with no halt says so, exit 0" 0 "^launches were not halted$" -- "$FW" resume-launches
# A marker written before halts carried an identity (1b80779): its first line stays the halt's
# generation -- the registry binds a triage reservation to it -- and a later halt appends an update.
printf '2026-09-01T00:00:00Z legacy reason with no identity\n' > "$ISSUE_WAVE_STATE/HALT"
expect "a halt over a legacy marker keeps it, appending the update" 0 "^HALTED: launches refused until resume-launches -- newer reason$" -- "$FW" halt "newer reason"
[ "$(head -n 1 "$ISSUE_WAVE_STATE/HALT")" = "2026-09-01T00:00:00Z legacy reason with no identity" ] &&
  grep -Eq '^update [0-9T:-]+Z newer reason$' "$ISSUE_WAVE_STATE/HALT" && ok "...first line kept, update appended" || ko "legacy marker rewritten: $(cat "$ISSUE_WAVE_STATE/HALT")"
"$FW" resume-launches >/dev/null
# A halt's identity outlives a re-halt (the generation the registry binds triage to).
"$FW" halt "first reason" >/dev/null
first_id=$(sed -n '1s/^[^ ]* id=\([^ ]*\) .*/\1/p' "$ISSUE_WAVE_STATE/HALT")
"$FW" halt "second reason" >/dev/null
[ -n "$first_id" ] && grep -q "^[^ ]* id=$first_id second reason$" "$ISSUE_WAVE_STATE/HALT" && ok "a re-halt keeps the halt's identity, with the new reason" || ko "re-halt identity: $(cat "$ISSUE_WAVE_STATE/HALT")"
"$FW" resume-launches >/dev/null
# The gate reads the lease and halt again AFTER the base read, which can take minutes: a halt
# recorded meanwhile refuses the dispatch it would otherwise have green-lit.
expect "a halt recorded during the gate's base read refuses the gate" 1 "GATE REFUSED native-worker: launches halted -- .*halted mid-read" -- \
  env SHIM_BASE_HALT="halted mid-read" "$FW" gate --target-repo example/project
"$FW" resume-launches >/dev/null
expect "the gate's --allow-red-base needs a reason" 2 "requires a triage reason" -- "$FW" gate --target-repo example/project --force --allow-red-base " "
expect "the gate refuses a base branch that reads as an option" 2 "base gate: invalid --base-branch" -- "$FW" gate --target-repo example/project --base-branch -x
expect "the gate refuses a malformed repository" 2 "base gate: --target-repo <owner/repo> required" -- "$FW" gate --target-repo 'not a repo'
for verb in halt resume-launches halted gate; do
  case "$verb" in
    halt) want="^HALT UNREACHABLE far-anchor$"; args=(halt "a reason") ;;
    resume-launches) want="^RESUME-LAUNCHES UNREACHABLE far-anchor$"; args=(resume-launches) ;;
    halted) want="^HALTED? UNREACHABLE far-anchor$"; args=(halted) ;;
    gate) want="^GATE REFUSED native-worker: anchor far-anchor unreachable"; args=(gate --target-repo example/project) ;;
  esac
  expect "$verb against an anchor that does not answer is unreachable" 4 "$want" -- env FLEET_ANCHOR=far-anchor "$FW" "${args[@]}"
done
}

section "board" && {
# The wave board as structured data (ludics-lite#619): the cell texts that broke `sed` on a markdown
# board travel through the command line, the far side's bash -s and the shipped store unchanged.
need_lease
hostile='a|b (c) #d /e `f` $(touch "$TMP/pwned") '"'q'"' "dq" s/x/y/g \ & <br>'
expect "a writer refuses a wave with no board" 1 "^BOARD REFUSED: no board for wave bw on the anchor (start it with set or note --create)$" -- \
  "$FW" board set bw "ll#1" state=x
expect "log never starts a board" 1 "^BOARD REFUSED: no board for wave bw on the anchor" -- "$FW" board log bw x
expect "...and takes no --create" 2 "board log: takes no --create" -- "$FW" board log --create bw x
expect "set --create starts the board" 0 '^BOARD SET bw: "ll#1" state pr$' -- "$FW" board set --create bw "ll#1" "state=$hostile" pr=
expect "a note takes any text" 0 "^BOARD NOTE bw: base scope$" -- "$FW" board note bw base=abc "scope=$hostile"
expect "a log line is appended" 0 "^BOARD LOG bw: line 1 at " -- "$FW" board log bw "$hostile"
expect "a task name takes the same text" 0 "^BOARD SET bw: " -- "$FW" board set bw "$hostile" "pr=#12 (draft)"
"$FW" board show bw --json > "$TMP/board.json"
got=$(jq -r '[.tasks[0].task, .tasks[0].fields.state, .notes.scope, .log[0].text, .tasks[1].task, .tasks[1].fields.pr] | join("\n")' "$TMP/board.json")
want=$(printf '%s\n' "ll#1" "$hostile" "$hostile" "$hostile" "$hostile" "#12 (draft)")
[ "$got" = "$want" ] && ok "every field round-trips byte for byte" || ko "round trip: got [$got] want [$want]"
[ ! -e "$TMP/pwned" ] && ok "...and nothing in it ran" || ko "a value was run as a command"
[ "$(jq -r '.log[0].by' "$TMP/board.json")" = test-coordinator ] && ok "a log line names its coordinator" || ko "log by: $(jq -c '.log[0]' "$TMP/board.json")"
expect "show renders the markdown view, the pipe escaped" 0 '^| ll#1 | a\\|b (c) #d /e `f` ' -- "$FW" board show bw
grep -q '^| task | state | pr |$' <<<"$out" && grep -q '^## Log$' <<<"$out" && ok "...with the table header and the log" || ko "view: $out"
expect "another coordinator reads the board without the lease" 0 "^# Board: bw$" -- "${B[@]}" board show bw
expect "...and without any identity" 0 "^# Board: bw$" -- env -u FLEET_COORDINATOR "$FW" board show bw
expect "...but cannot write it" 1 "BOARD REFUSED fleet: coordinator lease held by" -- "${B[@]}" board log bw "not mine"
expect "a writer needs an identity" 2 "no coordinator identity" -- env -u FLEET_COORDINATOR "$FW" board log bw x
mkdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"
expect "a writer waits for the lease lock and fails after the bound" 1 "BOARD FAILED: lease lock" -- env FLEET_LOCK_WAIT=1 "$FW" board log bw x
rmdir "$ISSUE_WAVE_STATE/COORDINATOR.lock"
[ "$(jq '.log | length' "$ISSUE_WAVE_STATE/boards/bw.json")" = 1 ] && ok "no refused write reached the board" || ko "board after refusals: $(cat "$ISSUE_WAVE_STATE/boards/bw.json")"
expect "a key outside the grammar is refused by the store" 1 "^BOARD REFUSED: a key must be" -- "$FW" board set bw t "bad key=1"
expect "a field without = is a usage error" 2 "board set: expected <key>=<value>" -- "$FW" board set bw t novalue
expect "show of a wave with no board refuses" 1 "^BOARD REFUSED: no board for wave none on the anchor$" -- "$FW" board show none
expect "an unknown board action is a usage error" 2 "board: expected set, note, log or show" -- "$FW" board edit bw
expect "show against an anchor that does not answer is unreachable" 4 "^BOARD UNREACHABLE far-anchor$" -- env FLEET_ANCHOR=far-anchor "$FW" board show bw
expect "...and so is a write" 4 "^BOARD UNREACHABLE far-anchor$" -- env FLEET_ANCHOR=far-anchor "$FW" board log bw x
}

section "execution run and conclude --from-run" && {
need_lease
# A finished test-run.sh record on the local box: `exit`, `log`, `wt`, `cmd` under a
# timestamped directory, with the checkout it ran in and that checkout's own runner shim
# (`tools/test-run.sh status <run>` is the authority on "published, nothing left running").
runs="$TMP/test-runs"; wt="$TMP/run-wt"
git clone -q "$TMP/proj.git" "$wt" && mkdir -p "$wt/tools"
cat > "$wt/tools/test-run.sh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = status ] || exit 2
exit "${SHIM_RUN_STATUS:-0}"
EOF
chmod +x "$wt/tools/test-run.sh"
ran=$(git -C "$wt" rev-parse HEAD)
mkrun() { # <name> <exit or ->
  local d="$runs/$1"; mkdir -p "$d"; printf 'build @scans\n' > "$d/cmd"; printf '%s\n' "$wt" > "$d/wt"
  printf 'exit: %s\n' "$2" > "$d/log"; [ "$2" = - ] || printf '%s\n' "$2" > "$d/exit"
}
mkrun 20260915T201414Z-1 0; mkrun 20260915T201414Z-2 -; mkrun 20260915T201414Z-3 142; mkrun 20260915T201414Z-4 1; mkrun 20260915T201414Z-5 0
reqjson() { # <id> [host] -> a reservation payload file
  jq -n --arg id "$1" --arg host "${2:-testbox}" '{request_id:$id, wave:"w", worker:$id, transport:"subagent", issue:"o/r#1", purpose:"fixture",
    agent_host:"testbox", execution_host:$host, repository:"o/r", requested_revision:"origin/master", kind:"correctness"}' > "$TMP/$1.json"
  printf '%s' "$TMP/$1.json"
}
FWX=(env FLEET_BOXES="testbox other" "$FW")
run1="$runs/20260915T201414Z-1"
expect "execution run reserves and dispatches in one call" 0 '"state": "launching"' -- "${FWX[@]}" execution run "$(reqjson run-a)"
expect "a second run of the same request is refused, never re-launched" 1 "already dispatched" -- "${FWX[@]}" execution run "$(reqjson run-a)"
expect "conclude --from-run needs an absolute run directory" 2 "must be absolute" -- "${FWX[@]}" execution conclude --from-run runs/x --request run-a --sha "$ran"
expect "conclude --from-run needs the request id" 2 "--request <id> required" -- "${FWX[@]}" execution conclude --from-run "$run1" --sha "$ran"
expect "conclude --from-run needs the revision that ran (the record has none)" 2 "--sha <full commit SHA> required" -- "${FWX[@]}" execution conclude --from-run "$run1" --request run-a
expect "conclude --from-run refuses a stray flag" 2 "conclude --from-run <run-dir>" -- "${FWX[@]}" execution conclude --from-run "$run1" --request run-a --sha "$ran" --oops
expect "conclude --from-run refuses a short --sha" 2 "full commit SHA" -- "${FWX[@]}" execution conclude --from-run "$run1" --request run-a --sha abc
expect "a record without a verdict file is refused" 1 "FROM-RUN REFUSED: .*has no exit" -- "${FWX[@]}" execution conclude --from-run "$runs/20260915T201414Z-2" --request run-a --sha "$ran"
expect "a missing run directory is refused" 1 "FROM-RUN REFUSED: no run directory" -- "${FWX[@]}" execution conclude --from-run "$runs/nope" --request run-a --sha "$ran"
expect "the checkout's runner saying 'still running' refuses" 1 "not a finished run" -- env SHIM_RUN_STATUS=3 "${FWX[@]}" execution conclude --from-run "$run1" --request run-a --sha "$ran"
expect "a revision the checkout does not contain is refused" 1 "does not contain the reported revision" -- "${FWX[@]}" execution conclude --from-run "$run1" --request run-a --sha "$(printf 'a%.0s' $(seq 40))"
"${FWX[@]}" execution run "$(reqjson run-other other)" >/dev/null
expect "evidence read on a box other than the reserved one is refused by the registry" 1 "evidence from testbox cannot conclude an assignment reserved on other" -- \
  "${FWX[@]}" execution conclude --from-run "$run1" --request run-other --sha "$ran" --box testbox
"$FW" execution list | grep -c '"state": "launching"' | grep -qx 2 && ok "every refusal left the assignments dispatched, not concluded" || ko "a refusal changed a record"
: > "$SHIM_GH_COMMIT_LOG"
expect "a passed run concludes with its verdict, log, checkout, handle and revision, on the reserved box by default" 0 '"verdict": "pass"' -- "${FWX[@]}" execution conclude --from-run "$run1" --request run-a --sha "$ran"
grep -qx "repos/o/r/commits/$ran" "$SHIM_GH_COMMIT_LOG" && ok "...its --sha checked on GitHub in the request's repository (ludics-lite#561)" ||
  ko "--from-run's --sha was not checked on GitHub: $(cat "$SHIM_GH_COMMIT_LOG")"
for want in "\"observed_sha\": \"$ran\"" "\"remote_checkout\": \"$wt\"" "\"handle\": \"test-run:20260915T201414Z-1\"" "\"log\": \"$run1/log\"" "exit 0 published"; do
  grep -Fq -- "$want" <<<"$out" && ok "...recorded $want" || ko "missing $want in $out"
done
jq -e '.history[-1].data | has("execution_host") | not' <<<"$out" >/dev/null && ok "...and the box check left no field behind" || ko "the box bound to the evidence leaked into the record: $out"
grep -Fq "the record has no head or dirty" <<<"$out" && ok "...and says the record named no revision of its own" || ko "a record without head/dirty concluded silently: $out"
"${FWX[@]}" execution run "$(reqjson run-gh)" >/dev/null 2>&1 || ko "could not reserve run-gh (setup)"
expect "--from-run refuses a --sha its checkout holds but the request's repository does not (another repository's run)" 1 "EXECUTION REFUSED: --sha $ran is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$ran" "${FWX[@]}" execution conclude --from-run "$run1" --request run-gh --sha "$ran" --box testbox
fixture_done run-gh
run_conclude() { local id="$1" dir="$2"; shift 2; "${FWX[@]}" execution run "$(reqjson "$id")" >/dev/null && "${FWX[@]}" execution conclude --from-run "$dir" --request "$id" --sha "$ran" "$@"; }
expect "a capped run concludes as timeout" 0 '"verdict": "timeout"' -- run_conclude run-b "$runs/20260915T201414Z-3"
expect "a red run concludes as fail, with the given evidence" 0 '"evidence": "sweep red on scans; the record has no head or dirty' -- run_conclude run-c "$runs/20260915T201414Z-4" --evidence "sweep red on scans"
grep -q '"verdict": "fail"' <<<"$out" && ok "...as fail" || ko "exit 1 did not read as fail: $out"
expect "conclude --from-run on an unknown request is refused before any box is read" 1 "unknown request_id run-zz" -- "${FWX[@]}" execution conclude --from-run "$run1" --request run-zz --sha "$ran"
# A checkout that moved on after the run still concludes on the reported revision, and says so.
git -C "$wt" commit -q --allow-empty -m moved   # a guaranteed new head, whatever the clone holds
expect "a moved checkout concludes on the reported revision and records the drift" 0 "revision is $ran as reported by the worker; checkout head is now $(git -C "$wt" rev-parse HEAD)" -- run_conclude run-d "$runs/20260915T201414Z-5"
grep -Fq "\"observed_sha\": \"$ran\"" <<<"$out" && ok "...with the reported revision as observed_sha" || ko "wrong observed_sha: $out"
# The launch-time source record (ludics-lite#438; OCANNL's test-run.sh since ocannl-staging#808):
# `head` and `dirty`, both or neither. The records above carry neither, the fallback. Each case
# below is its own record under its own reservation, so on a checker that reads neither file each
# one fails on its own, not behind an earlier case's conclusion.
moved=$(git -C "$wt" rev-parse HEAD)
mksrc() { # <name> <head or -> <dirty lines or -> -> a finished passed record with that source record
  mkrun "$1" 0; [ "$2" = - ] || printf '%s\n' "$2" > "$runs/$1/head"
  [ "$3" = - ] || printf '%s' "$3" > "$runs/$1/dirty"
}
mksrc src-clean "$ran" ""; mksrc src-other "$moved" ""; mksrc src-dirty "$ran" $' M lib/a.ml\n?? test/new_test.ml\n'
mksrc src-head-only "$ran" -; mksrc src-dirty-only - ""; mksrc src-bad-head "not-a-sha" ""
# src_refused <label> <record> <want>: a refusal that leaves its reservation dispatched.
src_refused() {
  "${FWX[@]}" execution run "$(reqjson "run-$2")" >/dev/null || ko "could not reserve run-$2 (setup)"
  expect "$1" 1 "$3" -- "${FWX[@]}" execution conclude --from-run "$runs/$2" --request "run-$2" --sha "$ran"
  "$FW" execution list | jq -e --arg id "run-$2" '[.[] | select(.request_id == $id) | .state] == ["launching"]' >/dev/null &&
    ok "...and left the assignment dispatched" || ko "the refusal of $2 changed its record"
  fixture_done "run-$2"
}
src_refused "a record launched at another revision is refused, naming both" src-other "FROM-RUN REFUSED: .*/head records $moved as the revision launched, but the reported revision is $ran"
src_refused "a record launched over uncommitted edits is refused, with their count" src-dirty "FROM-RUN REFUSED: .*/dirty lists 2 uncommitted path"
src_refused "a head without a dirty is a malformed record" src-head-only "FROM-RUN REFUSED: .*has a head but no dirty"
src_refused "a dirty without a head is a malformed record" src-dirty-only "FROM-RUN REFUSED: .*has a dirty but no head"
src_refused "a head that is not a commit ID is a malformed record" src-bad-head "FROM-RUN REFUSED: .*/head holds 'not-a-sha'"
expect "a record launched clean at the reported revision concludes, and says so" 0 "launched at $ran on a clean tree" -- run_conclude run-src-clean "$runs/src-clean"
grep -Fq "\"observed_sha\": \"$ran\"" <<<"$out" && grep -Fq '"verdict": "pass"' <<<"$out" && ok "...as a pass at the recorded revision" || ko "clean record: $out"
fixture_done run-other
expect "a run of a request outside the roster is refused" 1 "canonical FLEET_BOXES" -- "$FW" execution run "$(reqjson run-e)"
# The command line's own refusals and the anchor's transport, each with its exit code.
expect "a mutation needs a readable payload file" 2 "execution reserve: readable JSON file required" -- "${FWX[@]}" execution reserve "$TMP/no-such-payload.json"
printf 'not json\n' > "$TMP/not-json.json"
expect "a window payload that is not JSON is refused before the anchor is asked" 2 "execution window: $TMP/not-json.json is not a JSON reservation" -- "${FWX[@]}" execution window testbox "$TMP/not-json.json"
# Several JSON values are jq's stream, one wrapped line each: the anchor is asked, and its registry
# refuses the payload (exit 1), not the command line (2).
printf '{"a":1}\n{"b":2}\n' > "$TMP/two-json.json"
expect "a window payload of several JSON values is the registry's refusal, not a usage error" 1 "^EXECUTION REFUSED: Extra data: line 2 column 1" -- \
  "${FWX[@]}" execution window testbox "$TMP/two-json.json"
# A reader that went away: the verb dies of SIGPIPE as the shell did (141 under pipefail), with no
# traceback. The writer starts after its reader has exited, so the first write is the broken one.
env FLEET_BOXES="testbox other" sh -c 'sleep 1; exec "$0" execution list' "$FW" 2> "$TMP/epipe.err" | true
rc=${PIPESTATUS[0]}
[ "$rc" -eq 141 ] && [ ! -s "$TMP/epipe.err" ] && ok "a closed stdout ends the verb by SIGPIPE (141), silently" ||
  ko "a closed stdout: rc=$rc (want 141) -- $(cat "$TMP/epipe.err")"
expect "an unknown execution action is a usage error" 2 "execution: list, slot -- <command>" -- "${FWX[@]}" execution bogus
expect "an anchor that does not answer leaves the outcome unknown (exit 4)" 4 "^EXECUTION UNREACHABLE far-anchor: outcome unknown; reconcile before retrying dispatch$" -- \
  env FLEET_ANCHOR=far-anchor "${FWX[@]}" execution list
expect "conclude --from-run with no --box cannot resolve the host over an unreachable anchor" 4 "EXECUTION UNREACHABLE far-anchor: cannot resolve the request's execution host" -- \
  env FLEET_ANCHOR=far-anchor "${FWX[@]}" execution conclude --from-run "$run1" --request run-a --sha "$ran"
"${FWX[@]}" execution run "$(reqjson run-far)" >/dev/null || ko "could not reserve run-far (setup)"
expect "a run record on a box that does not answer concludes nothing (exit 4)" 4 "^FROM-RUN UNREACHABLE far-box: nothing concluded$" -- \
  "${FWX[@]}" execution conclude --from-run "$run1" --request run-far --sha "$ran" --box far-box
fixture_done run-far
# The base gate offers the checker the registry's INTEGRATION RECORDS for its target (ludics-lite
# #401): concluded records marked `"integration": true` for that repository, with a pass or fail at
# an exact SHA. An unmarked run, another repository's, and a timeout are not sources.
intreq() { # <id> <transport> <repository> <integration: true|-> -> a reservation payload file
  jq -n --arg id "$1" --arg t "$2" --arg repo "$3" --arg i "$4" '{request_id:$id, wave:"w", worker:"coordinator", transport:$t, issue:"o/r#1",
    purpose:"integration run at the merged tip", agent_host:"testbox", execution_host:"testbox", repository:$repo,
    requested_revision:"origin/master", kind:"correctness"} + (if $i == "true" then {integration: true} else {} end)' > "$TMP/$1.json"
  printf '%s' "$TMP/$1.json"
}
intdone() { # <id> <verdict>: conclude it at $ran
  jq -n --arg id "$1" --arg v "$2" --arg sha "$ran" --arg wt "$wt" '{request_id:$id, verdict:$v, log:"/dev/null",
    evidence:"fixture integration run", observed_sha:$sha, remote_checkout:$wt, handle:"fixture"}' > "$TMP/$1-done.json"
  "${FWX[@]}" execution conclude "$TMP/$1-done.json" >/dev/null || ko "could not conclude $1 (setup)"
}
# The coordinator's own correctness run WITHOUT `"integration": true` is a targeted batch as far
# as the gate is concerned (review round 2 of #401): only the explicit field makes a source. And
# int-a spells the repository in other letters, which is still the same GitHub repository (round 4).
for spec in "int-a coordinator Example/Project pass true" "int-b coordinator example/project pass -" \
  "int-c coordinator o/r fail true" "int-d coordinator example/project timeout true"; do
  read -r int_id int_t int_repo int_v int_i <<<"$spec"
  "${FWX[@]}" execution run "$(intreq "$int_id" "$int_t" "$int_repo" "$int_i")" >/dev/null || ko "could not reserve $int_id (setup)"
  intdone "$int_id" "$int_v"
done
: > "$BASE_CALL_LOG"
expect "the gate hands the checker its target's integration records" 0 "BASE GREEN" -- "$FW" gate --target-repo example/project
grep -Fq -- '--repo example/project base --wait=360 --interim --advisory-red FILE --integration-records ' "$BASE_CALL_LOG" && ok "...after the wait, as a file" || ko "no records file handed over: $(cat "$BASE_CALL_LOG")"
[ "$(grep -c '^records: ' "$BASE_CALL_LOG")" = 1 ] && grep -q "^records: $ran	pass	int-a	" "$BASE_CALL_LOG" && ok "...only the marked integration pass/fail for that repository" || ko "wrong records offered: $(cat "$BASE_CALL_LOG")"
# (With no record for the target, the call carries no flag at all: the "base gate" section's
# exact call lines above pin that, since its gates ran before any record existed.)
# A record concluding while the checker reads is one its verdict did not see: the green is refused
# and the coordinator reads again (review round 6 of #401). The shim concludes one mid-read.
: > "$BASE_CALL_LOG"
"${FWX[@]}" execution run "$(intreq int-e coordinator example/project true)" >/dev/null || ko "could not reserve int-e (setup)"
jq -n --arg sha "$ran" --arg wt "$wt" '{request_id:"int-e", verdict:"fail", log:"/dev/null",
  evidence:"fixture integration run", observed_sha:$sha, remote_checkout:$wt, handle:"fixture"}' > "$TMP/int-e-done.json"
expect "a record concluded during the read refuses the green" 1 "concluded during the read" -- \
  env SHIM_BASE_CONCLUDE="$TMP/int-e-done.json" "$FW" gate --target-repo example/project
: > "$BASE_CALL_LOG"
expect "...and the next read hands it over" 0 "BASE GREEN" -- "$FW" gate --target-repo example/project
grep -q "^records: $ran	fail	int-e	" "$BASE_CALL_LOG" && ok "...with the failed record in the file" || ko "the concluded record was not offered: $(cat "$BASE_CALL_LOG")"
# An unreadable registry refuses the gate rather than withholding the source: a failed record
# there would outrank a green PR head (review round 3 of #401).
printf 'not json\n' > "$ISSUE_WAVE_STATE/executions/zz-broken.json"
: > "$BASE_CALL_LOG"
expect "an unreadable registry refuses the gate" 1 "the execution registry could not be read" -- "$FW" gate --target-repo example/project
[ -s "$BASE_CALL_LOG" ] && ko "the checker ran over an unread registry: $(cat "$BASE_CALL_LOG")" || ok "...before the checker is asked anything"
rm -f "$ISSUE_WAVE_STATE/executions/zz-broken.json"
}

section "execution conclude --from-bg-run" && {
need_lease
# ludics-lite#405: runs that are not test-run.sh records -- a machine-verify trip, a measurement
# script -- block under bg-run.sh, whose directory (`rc`, `log`, `pid`/`cpid`) is read
# here through bg-run.sh's own `wait --within 0`. Each directory below is a real bg-run.sh run
# (`new`, then `start`, which returns when the command does), except the ones whose state has to
# be staged: a live task, a killed one, one never started.
BG="$TMP/dispatcher/issue-wave/scripts/bg-run.sh"
bgdir() { # <name> <command...>: a finished bg-run.sh directory, its path on stdout
  local d
  d=$(bash "$BG" new "$TMP/bg runs/$1") || return 1; shift
  bash "$BG" start "$d" -- "$@" >/dev/null 2>&1
  printf '%s' "$d"
}
bgreq() { # <id> -> a dispatched reservation on testbox
  jq -n --arg id "$1" '{request_id:$id, wave:"w", worker:$id, transport:"subagent", issue:"o/r#405", purpose:"bg-run fixture",
    agent_host:"testbox", execution_host:"testbox", repository:"o/r", requested_revision:"origin/main", kind:"correctness"}' > "$TMP/$1.json"
  "${FWB[@]}" execution run "$TMP/$1.json" >/dev/null 2>&1 || ko "could not dispatch $1 (setup)"
}
FWB=(env FLEET_BOXES="testbox other" SHIM_SSH_LOCAL=other "$FW")
sha=$(printf 'b%.0s' $(seq 40))
bgc() { # <id> <dir> [flags...]: dispatch <id>, then conclude it from <dir>
  local id="$1" dir="$2"; shift 2
  bgreq "$id" && "${FWB[@]}" execution conclude --from-bg-run "$dir" --request "$id" --sha "$sha" "$@"
}
ok_dir=$(bgdir pass sh -c 'echo building; echo "exit: 1 (a test named exit)"; echo "x: ssh exit: 5"')
expect "a bg-run that returned 0 concludes as pass" 0 '"verdict": "pass"' -- bgc bg-pass "$ok_dir"
for want in "\"observed_sha\": \"$sha\"" "\"handle\": \"bg-run:testbox:$ok_dir\"" "\"log\": \"testbox:$ok_dir/log\"" \
  "rc=0; the command returned; revision $sha as reported by the worker" "\"remote_checkout\": \"not recorded (bg-run keeps no checkout"; do
  grep -Fq -- "$want" <<<"$out" && ok "...recorded $want" || ko "missing $want in $out"
done
grep -q "runner sentinel" <<<"$out" && ko "a line outside the sentinel grammar was read as one: $out" || ok "...reading neither a sentinel with trailing text nor a transport line as the runner's"
expect "a retry of that conclusion (its answer lost) composes the same payload, which the registry takes as a harmless retry" 0 '"state": "concluded"' -- \
  "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-pass --sha "$sha"
expect "the runner's nonzero sentinel wins over a 0 rc: fail" 0 "runner sentinel 'runner: exit: 1'" -- bgc bg-sent1 "$(bgdir sent1 sh -c 'echo "runner: exit: 1"; echo tail output')"
grep -q '"verdict": "fail"' <<<"$out" && ok "...as fail" || ko "a failing sentinel under rc 0 did not read as fail: $out"
expect "a zero sentinel does not rescue a nonzero rc: fail" 0 '"verdict": "fail"' -- bgc bg-sent0 "$(bgdir sent0 sh -c 'echo "exit: 0"; exit 1')"
expect "the LAST sentinel is the runner's: a cap is timeout" 0 '"verdict": "timeout"' -- bgc bg-cap "$(bgdir cap sh -c 'echo "exit: 1"; echo "machine-verify: exit: 142"; echo "machine-verify: ssh exit: 142"; exit 142')"
expect "rc 124 (timeout(1)) concludes as timeout" 0 '"verdict": "timeout"' -- bgc bg-124 "$(bgdir t124 sh -c 'exit 124')"
expect "a signal death concludes as cancelled" 0 '"verdict": "cancelled"' -- bgc bg-term "$(bgdir term sh -c 'kill -TERM $$')"
expect "any other status concludes as fail, with the given evidence and checkout" 0 '"evidence": "sweep red"' -- \
  bgc bg-fail "$(bgdir fail sh -c 'exit 3')" --evidence "sweep red" --checkout "testbox:/w/verify (removed)"
grep -q '"verdict": "fail"' <<<"$out" && grep -Fq '"remote_checkout": "testbox:/w/verify (removed)"' <<<"$out" && ok "...as fail, naming the checkout given" || ko "exit 3 or --checkout misread: $out"
# The box that drove the run over ssh holds the directory; the conclusion names it.
expect "a directory read on the box that drove the run concludes, naming that box" 0 "read on other, which drove the run on testbox" -- bgc bg-drove "$ok_dir" --box other
grep -Fq "\"log\": \"other:$ok_dir/log\"" <<<"$out" && ok "...in the log it cites" || ko "the driving box is missing from the log: $out"
# A checkout already on the record is kept when --checkout is absent, and replaced when it is given.
bgreq bg-rec && jq -n '{request_id:"bg-rec", state:"running", evidence:"fixture", remote_checkout:"/rec/wt"}' > "$TMP/bg-rec-rec.json" &&
  "${FWB[@]}" execution record "$TMP/bg-rec-rec.json" >/dev/null || ko "could not record bg-rec's checkout (setup)"
expect "a checkout the record already carries is kept" 0 '"remote_checkout": "/rec/wt"' -- "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-rec --sha "$sha"
bgreq bg-rec2 && jq -n '{request_id:"bg-rec2", state:"running", evidence:"fixture", remote_checkout:"/rec/wt"}' > "$TMP/bg-rec2-rec.json" &&
  "${FWB[@]}" execution record "$TMP/bg-rec2-rec.json" >/dev/null || ko "could not record bg-rec2's checkout (setup)"
expect "...and an explicit --checkout replaces it" 0 '"remote_checkout": "/named/wt"' -- "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-rec2 --sha "$sha" --checkout /named/wt
# Staged states: bg-run.sh's own verdicts, never re-derived here.
d="$TMP/bg runs/died"; mkdir -p "$d"; sh -c 'exit 0' & gone=$!; wait "$gone"; printf '%s\n\n' "$gone" > "$d/pid"; : > "$d/log"
expect "a task killed before the command returned (DIED) is refused, never concluded" 1 "FROM-BG-RUN REFUSED: bg-run.sh wait: DIED" -- bgc bg-died "$d"
fixture_done bg-died
# ludics-lite#638: the same dead task with the marker `bg-run.sh stop` leaves reads STOPPED, which
# concludes as cancelled; a log sentinel there is not read.
d="$TMP/bg runs/stopped"; mkdir -p "$d"; sh -c 'exit 0' & gone=$!; wait "$gone"; printf '%s\n\n' "$gone" > "$d/pid"
printf 'exit: 0\n' > "$d/log"; printf 'process group %s\n' "$gone" > "$d/stopped"
expect "a run bg-run.sh stop ended (STOPPED) concludes as cancelled" 0 '"verdict": "cancelled"' -- bgc bg-stopped "$d"
grep -Fq "STOPPED by bg-run.sh stop before the command returned, no process of it left; revision $sha" <<<"$out" \
  && ok "...saying so in its evidence" || ko "the stopped conclusion's evidence: $out"
d="$TMP/bg runs/live"; mkdir -p "$d"; printf '%s\n\n' "$$" > "$d/pid"
expect "a live task (RUNNING) is refused" 1 "FROM-BG-RUN REFUSED: bg-run.sh wait: RUNNING" -- bgc bg-live "$d"
d="$TMP/bg runs/never"; mkdir -p "$d"
expect "a directory no task claimed (STARTING) is refused" 1 "FROM-BG-RUN REFUSED: bg-run.sh wait: STARTING" -- "${FWB[@]}" execution conclude --from-bg-run "$d" --request bg-live --sha "$sha"
expect "a missing directory is refused" 1 "FROM-BG-RUN REFUSED: no run directory" -- "${FWB[@]}" execution conclude --from-bg-run "$TMP/bg runs/nope" --request bg-live --sha "$sha"
expect "an unknown request is refused before any box is read" 1 "unknown request_id bg-zz" -- "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-zz --sha "$sha"
expect "--from-bg-run needs an absolute directory" 2 "must be absolute" -- "${FWB[@]}" execution conclude --from-bg-run bg/x --request bg-live --sha "$sha"
expect "--from-bg-run needs the request id" 2 "--request <id> required" -- "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --sha "$sha"
expect "--from-bg-run needs the revision that ran" 2 "--sha <full commit SHA> required" -- "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-live
expect "--from-bg-run refuses a stray flag" 2 "conclude --from-bg-run <run-dir>" -- "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-live --sha "$sha" --oops
expect "a directory on a box that does not answer concludes nothing (exit 4)" 4 "^FROM-BG-RUN UNREACHABLE far-box: nothing concluded$" -- \
  "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-live --sha "$sha" --box far-box
expect "...nor does one whose anchor does not answer" 4 "EXECUTION UNREACHABLE far-anchor: cannot resolve the request's execution host" -- \
  env FLEET_ANCHOR=far-anchor "${FWB[@]}" execution conclude --from-bg-run "$ok_dir" --request bg-live --sha "$sha"
"$FW" execution list | jq -e '[.[] | select(.request_id == "bg-live") | .state] == ["launching"]' >/dev/null && ok "every refusal left the assignment dispatched" || ko "a refusal changed bg-live"
fixture_done bg-live
}

section "execution tip-run" && {
need_lease
# ludics-lite#615: one integration-loop run in one call. Each case drives the real far side on
# testbox (local), a real clone and a real detached bg-run, and reads the registry it left.
BG="$TMP/dispatcher/issue-wave/scripts/bg-run.sh"
torigin="$TMP/tip origin.git"; tsrc="$TMP/tip src"; tco="$TMP/tip co"
git init -q --bare "$torigin" && git init -q -b main "$tsrc" && echo one > "$tsrc/f" &&
  git -C "$tsrc" add f && git -C "$tsrc" commit -q -m one && git -C "$tsrc" remote add origin "$torigin" &&
  git -C "$tsrc" push -q origin main && git -C "$torigin" symbolic-ref HEAD refs/heads/main && git clone -q "$torigin" "$tco" || ko "could not stage the tip-run repositories (setup)"
# The tip lands after the checkout was cloned, so the first run has to fetch it.
echo two > "$tsrc/f" && git -C "$tsrc" commit -q -am two && git -C "$tsrc" push -q origin main || ko "could not push the tip (setup)"
tip=$(git -C "$tsrc" rev-parse HEAD)
absent=$(printf 'c%.0s' $(seq 40))   # a commit no repository here has
tipreq() { # <id> [sha] [jq object to add] -> a loop run's request on testbox
  local more='{}'; [ -z "${3:-}" ] || more=$3
  jq -n --arg id "$1" --arg sha "${2:-$tip}" --argjson more "$more" '{request_id:$id, wave:"w", worker:"coordinator",
    transport:"coordinator", issue:"o/r integration", purpose:"GPU integration loop, cuda: fixture", agent_host:"testbox",
    execution_host:"testbox", repository:"o/r", requested_revision:$sha, kind:"correctness"} + $more' > "$TMP/$1.json"
  printf '%s' "$TMP/$1.json"
}
state_of() { "$FW" execution list | jq -r --arg id "$1" '.[] | select(.request_id == $id) | "\(.state) \(.verdict // "-")"'; }
# Two slots, one of them the GPU token, as rog-nv-linux has four and two.
FWT=(env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=2" FLEET_BOX_GPU_TOKENS="testbox=1" "$FW")
# A worker's standing reservation on the box is no reason to yield: its batches take slots as they run.
jq -n '{request_id:"tip-stand", wave:"w", worker:"w1", transport:"subagent", issue:"o/r#1", purpose:"iterate",
  agent_host:"testbox", execution_host:"testbox", repository:"o/r", requested_revision:"origin/main", kind:"correctness", standing:true}' > "$TMP/tip-stand.json"
"${FWT[@]}" execution run "$TMP/tip-stand.json" >/dev/null 2>&1 || ko "could not take the standing reservation (setup)"
expect "a loop run starts at the tip, beside a standing reservation, on a GPU token" 0 "^TIP-RUN STARTED tip-a testbox $tip /" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-a)" --checkout "$tco" -- sh -c 'echo "ran at $(git rev-parse HEAD)"; echo "exit: 0"'
tdir=$(sed -n "s/^TIP-RUN STARTED tip-a testbox $tip //p" <<<"$out")
case "$tdir" in "$ISSUE_WAVE_STATE/tip-runs/"*) ok "...in a run directory under the state's tip-runs by default" ;; *) ko "run directory: '$tdir' -- $out" ;; esac
bash "$BG" wait "$tdir" --within 30 >/dev/null
grep -q "GPU token 1 of 1 held for: " "$tdir/log" && grep -Fq "ran at $tip" "$tdir/log" && ok "...the command ran in the checkout, fetched and detached at the tip, holding the token" ||
  ko "the run's log: $(cat "$tdir/log" 2>/dev/null)"
"$FW" execution list | jq -e --arg d "$tdir" --arg tip "$tip" --arg co "$tco" '.[] | select(.request_id == "tip-a") |
  .state == "running" and .observed_sha == $tip and .remote_checkout == $co and .handle == "bg-run:testbox:\($d)" and .log == "testbox:\($d)/log"' >/dev/null &&
  ok "...and recorded it running, with its revision, checkout, handle and log" || ko "tip-a's record: $("$FW" execution list | jq -c '.[] | select(.request_id == "tip-a")')"
expect "...which concludes from its bg-run directory" 0 '"verdict": "pass"' -- "${FWT[@]}" execution conclude --from-bg-run "$tdir" --request tip-a --sha "$tip"
expect "a request id the registry holds is never run again" 1 "^TIP-RUN NOT STARTED tip-a: the registry already holds it (concluded); a loop run takes a fresh request id$" -- \
  "${FWT[@]}" execution tip-run "$TMP/tip-a.json" --checkout "$tco" -- echo never
# THE YIELD: a worker's assigned leg (any non-standing record) on the box, and nothing is reserved.
jq -n '{request_id:"tip-leg", wave:"w", worker:"w1", transport:"subagent", issue:"o/r#1", purpose:"cuda leg",
  agent_host:"testbox", execution_host:"testbox", repository:"o/r", requested_revision:"origin/main", kind:"correctness"}' > "$TMP/tip-leg.json"
"${FWT[@]}" execution run "$TMP/tip-leg.json" >/dev/null 2>&1 || ko "could not dispatch the worker's leg (setup)"
expect "a loop run yields to a worker's leg on the box" 1 "^TIP-RUN NOT STARTED tip-b: testbox has tip-leg (launching) outstanding; a loop run yields to it; nothing reserved$" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-b)" --checkout "$tco" -- echo never
[ -z "$(state_of tip-b)" ] && ok "...reserving nothing" || ko "tip-b was reserved: $(state_of tip-b)"
fixture_done tip-leg
# The token taken only if free now: a batch holding the box's one GPU token turns the run away, and
# what was reserved is concluded not-launched.
"${FWT[@]}" execution slot -- sleep 30 > "$TMP/tip-holder.log" 2>&1 &
tholder=$!
for _ in $(seq 40); do grep -q "held for" "$TMP/tip-holder.log" 2>/dev/null && break; sleep 1; done
expect "a loop run never waits for a busy GPU token" 1 "^TIP-RUN NOT STARTED tip-c: the slot did not run the command (EXECUTION SLOT REFUSED testbox: all 1 GPU tokens" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-c)" --checkout "$tco" -- echo never
[ "$(state_of tip-c)" = "concluded not-launched" ] && ok "...and concludes what it reserved not-launched" || ko "tip-c: $(state_of tip-c)"
expect "...while a CPU run (--cpu) takes the other slot beside it" 0 "^TIP-RUN STARTED tip-d testbox $tip /" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-d)" --checkout "$tco" --runs "$TMP/tip runs" --cpu -- sh -c 'exit 3'
tdir=$(sed -n "s/^TIP-RUN STARTED tip-d testbox $tip //p" <<<"$out")
kill -9 "$tholder" 2>/dev/null; wait "$tholder" 2>/dev/null
bash "$BG" wait "$tdir" --within 30 >/dev/null
expect "...and a red command concludes as fail" 0 '"verdict": "fail"' -- "${FWT[@]}" execution conclude --from-bg-run "$tdir" --request tip-d --sha "$tip"
# A checkout with changes of its own is never touched or run over.
echo stray > "$tco/stray"
expect "a dirty checkout is refused before anything touches it" 1 "^TIP-RUN NOT STARTED tip-e: $tco on testbox has uncommitted changes (1 path(s))" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-e)" --checkout "$tco" -- echo never
[ "$(state_of tip-e)" = "concluded not-launched" ] && ok "...concluding what it reserved not-launched" || ko "tip-e: $(state_of tip-e)"
rm -f "$tco/stray"
expect "a revision the origin does not have is refused after one fetch" 1 "^TIP-RUN NOT STARTED tip-f: $tco on testbox does not have $absent even after fetching origin" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-f "$absent")" --checkout "$tco" -- echo never
# A halt refuses the reservation, as for any run outside its one triage reservation.
"$FW" halt "cuda red at $tip, rerun pending" >/dev/null
expect "a halted fleet starts no loop run" 1 "^TIP-RUN NOT STARTED tip-g: the reservation was refused (above)" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-g)" --checkout "$tco" -- echo never
grep -q "fleet halted" <<<"$out" && ok "...naming the halt" || ko "no halt named: $out"
"$FW" resume-launches >/dev/null
# The request is the loop's shape, or a usage refusal before the anchor is asked.
expect "an abbreviated revision is refused" 2 "requested_revision must be exactly one full 40-hex commit SHA" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-h "${tip:0:12}")" --checkout "$tco" -- echo never
expect "a standing request is refused" 2 "a loop run is never standing" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-h "$tip" '{"standing":true}')" --checkout "$tco" -- echo never
expect "a measurement is refused" 2 "kind must be correctness" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-h "$tip" '{"kind":"measurement"}')" --checkout "$tco" -- echo never
expect "a worker's request is refused" 2 "transport must be coordinator" -- \
  "${FWT[@]}" execution tip-run "$(tipreq tip-h "$tip" '{"transport":"subagent"}')" --checkout "$tco" -- echo never
expect "a relative checkout is refused" 2 "--checkout must be absolute" -- "${FWT[@]}" execution tip-run "$(tipreq tip-h)" --checkout co -- echo never
expect "the checkout is required" 2 "execution tip-run <json-file> --checkout <dir>" -- "${FWT[@]}" execution tip-run "$(tipreq tip-h)" -- echo never
expect "the command is required" 2 "a command to run is required" -- "${FWT[@]}" execution tip-run "$(tipreq tip-h)" --checkout "$tco" --
[ -z "$(state_of tip-h)" ] && ok "...each before anything is reserved" || ko "tip-h was reserved: $(state_of tip-h)"
jq -n '{request_id:"tip-stand", evidence:"fixture: iteration over", verdict:"not-launched", log:"/dev/null"}' > "$TMP/tip-stand-done.json"
"$FW" execution conclude "$TMP/tip-stand-done.json" >/dev/null || ko "could not conclude tip-stand (setup)"
}

section "execution revisions resolve" && {
need_lease
# ludics-lite#561: two standing conclusions of the 2026-10-05 wave recorded an observed_sha with the
# right prefix and a wrong tail, and records are immutable. Every commit a payload names is checked
# in the request's repository on GitHub (the gh shim answers for it) before the anchor is asked, and
# `--observed-from <checkout>` reads the checkout's HEAD instead of a SHA copied by hand.
FWR=(env FLEET_BOXES="testbox other far-box" "$FW")
obs="$TMP/obs wt"; git clone -q "$TMP/proj.git" "$obs" && git -C "$obs" commit -q --allow-empty -m observed
head=$(git -C "$obs" rev-parse HEAD)
good=$(printf 'c%.0s' $(seq 40)); typo="${good%?}d"
rv_req() { # <id> <requested_revision> [host] -> a reservation payload file
  jq -n --arg id "$1" --arg rev "$2" --arg host "${3:-testbox}" '{request_id:$id, wave:"w", worker:$id, transport:"subagent", issue:"o/r#561",
    purpose:"revision fixture", agent_host:"testbox", execution_host:$host, repository:"o/r", requested_revision:$rev, kind:"correctness"}' > "$TMP/$1.json"
  printf '%s' "$TMP/$1.json"
}
rv_done() { # <id> <observed_sha or -> -> a pass conclusion payload file
  jq -n --arg id "$1" --arg sha "$2" '{request_id:$id, verdict:"pass", log:"/logs/x", evidence:"fixture run", handle:"fixture",
    remote_checkout:"/w/x"} + (if $sha == "-" then {} else {observed_sha:$sha} end)' > "$TMP/$1-done.json"
  printf '%s' "$TMP/$1-done.json"
}
state_of() { "$FW" execution list | jq -r --arg id "$1" '[.[] | select(.request_id == $id) | .state] | join(",")'; }
# Reserve: a SHA-shaped word of requested_revision must be a full SHA GitHub has; a ref is not read.
: > "$SHIM_GH_COMMIT_LOG"
expect "a requested_revision whose SHA resolves to no commit is refused, naming it and the repository" 1 \
  "EXECUTION REFUSED: requested_revision $typo is no commit of o/r (checked on GitHub: gh: No commit found" -- \
  env SHIM_GH_NO_COMMIT="$typo" "${FWR[@]}" execution run "$(rv_req rv-typo "$typo")"
[ -z "$(state_of rv-typo)" ] && ok "...and nothing was reserved" || ko "a refused request left a record: $(state_of rv-typo)"
expect "an abbreviated requested_revision is refused before GitHub is asked" 1 "requested_revision names f8e0721f0, which is not a full commit ID" -- \
  "${FWR[@]}" execution reserve "$(rv_req rv-short f8e0721f0)"
grep -q f8e0721f0 "$SHIM_GH_COMMIT_LOG" && ko "an abbreviation was sent to GitHub" || ok "...without a GitHub call"
: > "$SHIM_GH_COMMIT_LOG"
# `run` dispatches a record still reserved: one reserved before this check existed (staged here by
# reserving while GitHub still answers for the SHA) is checked then, not waved through as a retry.
"${FWR[@]}" execution reserve "$(rv_req rv-old "$typo")" >/dev/null 2>&1 || ko "could not reserve rv-old (setup)"
expect "run of a reservation still reserved checks its requested_revision" 1 "requested_revision $typo is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$typo" "${FWR[@]}" execution run "$(rv_req rv-old "$typo")"
[ "$(state_of rv-old)" = reserved ] && ok "...and does not dispatch it" || ko "rv-old was dispatched: $(state_of rv-old)"
fixture_done rv-old
expect "a SHA with a note is read word by word, and its SHA checked" 0 '"state": "launching"' -- "${FWR[@]}" execution run "$(rv_req rv-note "$good plus working diff")"
grep -qx "repos/o/r/commits/$good" "$SHIM_GH_COMMIT_LOG" && ok "...in the request's repository" || ko "wrong or no GitHub call: $(cat "$SHIM_GH_COMMIT_LOG")"
fixture_done rv-note
: > "$SHIM_GH_COMMIT_LOG"
expect "a ref is a requested_revision the check does not read" 0 '"state": "launching"' -- "${FWR[@]}" execution run "$(rv_req rv-ref origin/main)"
[ -s "$SHIM_GH_COMMIT_LOG" ] && ko "a ref was sent to GitHub: $(cat "$SHIM_GH_COMMIT_LOG")" || ok "...and asks GitHub nothing"
# Conclude, record: an observed_sha GitHub does not have is refused; a GitHub that cannot answer is
# a distinct exit 4; every refusal leaves the assignment dispatched.
expect "a conclusion whose observed_sha resolves to no commit is refused, naming the SHA and where it was checked" 1 \
  "EXECUTION REFUSED: observed_sha $typo is no commit of o/r (checked on GitHub" -- \
  env SHIM_GH_NO_COMMIT="$typo" "${FWR[@]}" execution conclude "$(rv_done rv-ref "$typo")"
expect "a record whose observed_sha resolves to no commit is refused too" 1 "observed_sha $typo is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$typo" "${FWR[@]}" execution record "$(jq -n --arg sha "$typo" '{request_id:"rv-ref", state:"running", evidence:"fixture", observed_sha:$sha}' > "$TMP/rv-rec.json"; printf '%s' "$TMP/rv-rec.json")"
expect "a GitHub that does not answer is UNVERIFIED (exit 4), never a silent accept" 4 "^EXECUTION UNVERIFIED github.com: observed_sha $good could not be checked in o/r (check your internet connection" -- \
  env SHIM_GH=down "${FWR[@]}" execution conclude "$(rv_done rv-ref "$good")"
expect "GitHub's other 422 (an endpoint it calls spammed) is UNVERIFIED, not a missing commit" 4 "^EXECUTION UNVERIFIED github.com: observed_sha $good could not be checked in o/r (gh: Validation Failed" -- \
  env SHIM_GH=spam "${FWR[@]}" execution conclude "$(rv_done rv-ref "$good")"
gh_t0=$SECONDS   # not SECONDS=0: the section clock and the run's total read SECONDS too
expect "a GitHub call that never returns is cut at FLEET_GH_TIMEOUT: UNVERIFIED" 4 "could not be checked in o/r (gh: no answer in 1s)" -- \
  env SHIM_GH=hang FLEET_GH_TIMEOUT=1 "${FWR[@]}" execution conclude "$(rv_done rv-ref "$good")"
gh_t=$((SECONDS - gh_t0))
[ "$gh_t" -lt 25 ] && ok "...in ${gh_t}s, its child process killed with it" || ko "the bound did not hold: ${gh_t}s"
expect "a FLEET_GH_TIMEOUT that is not a number of seconds is a usage error" 2 "FLEET_GH_TIMEOUT must be a positive whole number" -- \
  env FLEET_GH_TIMEOUT=soon "${FWR[@]}" execution conclude "$(rv_done rv-ref "$good")"
expect "a 404 is UNVERIFIED: no repository, or a private one the token cannot see" 4 "Not Found (HTTP 404): no repository o/r, or one this box's gh token cannot see" -- \
  env SHIM_GH_NO_REPO=o/r "${FWR[@]}" execution conclude "$(rv_done rv-ref "$good")"
expect "a SHA-256 observed_sha is refused: GitHub cannot hold one" 1 "is a SHA-256 object ID" -- \
  "${FWR[@]}" execution conclude "$(rv_done rv-ref "$(printf 'e%.0s' $(seq 64))")"
[ "$(state_of rv-ref)" = launching ] && ok "every refusal left the assignment dispatched" || ko "a refusal changed rv-ref: $(state_of rv-ref)"
# --observed-from: the checkout's HEAD, read on the execution host, is the observed_sha.
expect "--observed-from must name an absolute checkout" 2 "must be absolute" -- "${FWR[@]}" execution conclude "$(rv_done rv-ref -)" --observed-from "obs wt"
expect "--observed-from refuses a payload SHA that is not the checkout's HEAD, naming both" 1 "observed_sha $good is not HEAD $head of $obs on testbox" -- \
  "${FWR[@]}" execution conclude "$(rv_done rv-ref "$good")" --observed-from "$obs"
expect "--observed-from refuses a HEAD GitHub does not have in the repository (another repository's checkout)" 1 "observed_sha $head is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$head" "${FWR[@]}" execution conclude "$(rv_done rv-ref -)" --observed-from "$obs"
expect "--observed-from refuses a directory that is no checkout" 1 "OBSERVED-FROM REFUSED: cannot read HEAD of $TMP on testbox" -- \
  "${FWR[@]}" execution conclude "$(rv_done rv-ref -)" --observed-from "$TMP"
: > "$SHIM_GH_COMMIT_LOG"
jq -n '{request_id:"rv-ref", verdict:"pass", log:"/logs/x", evidence:"fixture run", handle:"fixture"}' > "$TMP/rv-obs.json"
expect "--observed-from records the checkout's HEAD as observed_sha" 0 "\"observed_sha\": \"$head\"" -- \
  "${FWR[@]}" execution conclude "$TMP/rv-obs.json" --observed-from "$obs"
grep -Fq "\"remote_checkout\": \"$obs\"" <<<"$out" && grep -Fq "fixture run; observed_sha read as HEAD of $obs on testbox" <<<"$out" &&
  ok "...with the checkout it read and the provenance in the evidence" || ko "checkout or evidence missing: $out"
grep -qx "repos/o/r/commits/$head" "$SHIM_GH_COMMIT_LOG" && ok "...and checks that HEAD on GitHub, in the request's repository" ||
  ko "--observed-from's HEAD was not checked: $(cat "$SHIM_GH_COMMIT_LOG")"
# The answer lost, the retry comes after the worker moved its checkout on: the recorded SHA stands.
git -C "$obs" commit -q --allow-empty -m "moved on"
expect "...and a retry once the checkout has moved on composes the same payload, the registry's harmless retry" 0 '"state": "concluded"' -- \
  "${FWR[@]}" execution conclude "$TMP/rv-obs.json" --observed-from "$obs"
grep -Fq "\"observed_sha\": \"$head\"" <<<"$out" && ok "...at the SHA the conclusion recorded" || ko "the retry recorded another SHA: $out"
git -C "$obs" reset -q --hard "$head"
# A reservation that landed with its answer lost is retried while GitHub is down: the registry holds
# the request id, so GitHub is not asked and the registry answers (the identical request returned).
"${FWR[@]}" execution reserve "$(rv_req rv-rsv "$good")" >/dev/null 2>&1 || ko "could not reserve rv-rsv (setup)"
expect "a retry of a landed reservation naming a SHA is the registry's idempotent answer, whatever GitHub says" 0 '"state": "reserved"' -- \
  env SHIM_GH=down "${FWR[@]}" execution reserve "$(rv_req rv-rsv "$good")"
expect "...and a changed request under that id is still the registry's refusal" 1 "already names a different assignment" -- \
  env SHIM_GH=down "${FWR[@]}" execution reserve "$(rv_req rv-rsv "$good plus edits")"
# Dispatch carries evidence too, and an observed_sha it records is inherited by the conclusion.
jq -n --arg sha "$typo" '{request_id:"rv-rsv", evidence:"about to launch", observed_sha:$sha}' > "$TMP/rv-dispatch.json"
expect "a dispatch whose observed_sha resolves to no commit is refused" 1 "observed_sha $typo is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$typo" "${FWR[@]}" execution dispatch "$TMP/rv-dispatch.json"
[ "$(state_of rv-rsv)" = reserved ] && ok "...leaving it reserved" || ko "the refused dispatch changed rv-rsv: $(state_of rv-rsv)"
fixture_done rv-rsv
# A conclusion naming no observed_sha inherits the record's, which a record written before this
# check may hold mistyped (staged here by recording it while GitHub still answers for it).
"${FWR[@]}" execution run "$(rv_req rv-inh origin/main)" >/dev/null 2>&1 || ko "could not reserve rv-inh (setup)"
jq -n --arg sha "$typo" '{request_id:"rv-inh", state:"running", evidence:"before the check", observed_sha:$sha}' > "$TMP/rv-inh-rec.json"
"${FWR[@]}" execution record "$TMP/rv-inh-rec.json" >/dev/null || ko "could not record rv-inh's SHA (setup)"
expect "a conclusion inheriting a record's observed_sha that resolves to no commit is refused" 1 "inherited observed_sha $typo is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$typo" "${FWR[@]}" execution conclude "$(rv_done rv-inh -)"
[ "$(state_of rv-inh)" = running ] && ok "...leaving it running" || ko "the refusal changed rv-inh: $(state_of rv-inh)"
fixture_done rv-inh
# A conclusion that landed with its answer lost is retried while GitHub is down: the record is
# concluded, so GitHub is not asked again and the registry takes the identical retry.
"${FWR[@]}" execution run "$(rv_req rv-gh origin/main)" >/dev/null 2>&1 || ko "could not reserve rv-gh (setup)"
"${FWR[@]}" execution conclude "$(rv_done rv-gh "$good")" >/dev/null || ko "could not conclude rv-gh (setup)"
expect "a retry of a landed conclusion is the registry's harmless retry, whatever GitHub says" 0 '"state": "concluded"' -- \
  env SHIM_GH=down "${FWR[@]}" execution conclude "$(rv_done rv-gh "$good")"
"${FWR[@]}" execution run "$(rv_req rv-far origin/main far-box)" >/dev/null 2>&1 || ko "could not reserve rv-far (setup)"
expect "--observed-from on an execution host that does not answer concludes nothing (exit 4)" 4 "^OBSERVED-FROM UNREACHABLE far-box: nothing concluded$" -- \
  "${FWR[@]}" execution conclude "$(rv_done rv-far -)" --observed-from "$obs"
fixture_done rv-far
# --from-bg-run: --sha is checked on GitHub, or --observed-from replaces it.
BG="$TMP/dispatcher/issue-wave/scripts/bg-run.sh"
bgd=$(bash "$BG" new "$TMP/bg runs/rv-pass"); bash "$BG" start "$bgd" -- true >/dev/null 2>&1
"${FWR[@]}" execution run "$(rv_req rv-bg origin/main)" >/dev/null 2>&1 || ko "could not reserve rv-bg (setup)"
expect "--from-bg-run refuses a --sha that resolves to no commit" 1 "EXECUTION REFUSED: --sha $typo is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$typo" "${FWR[@]}" execution conclude --from-bg-run "$bgd" --request rv-bg --sha "$typo"
expect "--from-bg-run --observed-from refuses a --sha that is not HEAD" 1 "--sha $good is not HEAD $head of $obs on testbox" -- \
  "${FWR[@]}" execution conclude --from-bg-run "$bgd" --request rv-bg --sha "$good" --observed-from "$obs"
[ "$(state_of rv-bg)" = launching ] && ok "...each refusal leaving it dispatched" || ko "a refusal changed rv-bg: $(state_of rv-bg)"
expect "--from-bg-run --observed-from concludes at the checkout's HEAD" 0 "\"observed_sha\": \"$head\"" -- \
  "${FWR[@]}" execution conclude --from-bg-run "$bgd" --request rv-bg --observed-from "$obs"
grep -Fq "\"remote_checkout\": \"$obs\"" <<<"$out" && grep -Fq "revision $head read as HEAD of $obs on testbox" <<<"$out" &&
  ok "...naming the checkout read, in the field and the evidence" || ko "checkout or evidence missing: $out"
git -C "$obs" commit -q --allow-empty -m "moved on"
expect "...and a retry once the checkout has moved on is the registry's harmless retry" 0 "\"observed_sha\": \"$head\"" -- \
  "${FWR[@]}" execution conclude --from-bg-run "$bgd" --request rv-bg --observed-from "$obs"
git -C "$obs" reset -q --hard "$head"
"${FWR[@]}" execution run "$(rv_req rv-bg3 origin/main)" >/dev/null 2>&1 || ko "could not reserve rv-bg3 (setup)"
"${FWR[@]}" execution conclude --from-bg-run "$bgd" --request rv-bg3 --sha "$good" >/dev/null || ko "could not conclude rv-bg3 (setup)"
expect "--from-bg-run: a retry of a landed --sha conclusion asks GitHub nothing" 0 '"state": "concluded"' -- \
  env SHIM_GH=down "${FWR[@]}" execution conclude --from-bg-run "$bgd" --request rv-bg3 --sha "$good"
"${FWR[@]}" execution run "$(rv_req rv-bg2 origin/main)" >/dev/null 2>&1 || ko "could not reserve rv-bg2 (setup)"
expect "--from-bg-run --observed-from keeps the provenance beside an --evidence of its own" 0 "\"evidence\": \"leg green; revision $head read as HEAD of $obs on testbox\"" -- \
  "${FWR[@]}" execution conclude --from-bg-run "$bgd" --request rv-bg2 --observed-from "$obs" --evidence "leg green"
# A request that follows a branch (ludics-lite#558): `head-of:<branch>` names no commit when it is
# made, so it cannot go stale in the queue; the dispatch resolves it on GitHub and records the commit.
export SHIM_GH_HEADS="$TMP/gh-heads"
printf 'claude/topic %s\n' "$good" > "$SHIM_GH_HEADS"
: > "$SHIM_GH_COMMIT_LOG"
expect "a head-of request is reserved as it is, asking GitHub nothing" 0 '"requested_revision": "head-of:claude/topic"' -- \
  "${FWR[@]}" execution reserve "$(rv_req rv-head head-of:claude/topic)"
[ -s "$SHIM_GH_COMMIT_LOG" ] && ko "a reservation resolved the branch at request time: $(cat "$SHIM_GH_COMMIT_LOG")" || ok "...and records no commit at request time"
grep -q resolved_revision <<<"$out" && ko "the reserved record carries a resolution: $out" || ok "...nor a resolution"
moved_head="${good%??}ee"
printf 'claude/topic %s\n' "$moved_head" > "$SHIM_GH_HEADS"   # the worker pushes while the request waits
printf '{"request_id":"rv-head","evidence":"about to launch"}' > "$TMP/rv-head-dispatch.json"
expect "its dispatch resolves the branch at assignment, to the head GitHub names then" 0 "\"resolved_revision\": \"$moved_head\"" -- \
  "${FWR[@]}" execution dispatch "$TMP/rv-head-dispatch.json"
grep -q "^EXECUTION RESOLVED rv-head: head-of:claude/topic is $moved_head in o/r, read at assignment$" <<<"$out" && ok "...and says so" ||
  ko "no resolution line: $out"
grep -qx "repos/o/r/git/ref/heads/claude/topic" "$SHIM_GH_COMMIT_LOG" && ok "...asking GitHub for that branch of the request's repository" ||
  ko "wrong or no branch read: $(cat "$SHIM_GH_COMMIT_LOG")"
"$FW" execution list | jq -e --arg sha "$moved_head" '[.[] | select(.request_id == "rv-head")][0] | .resolved_revision == $sha and (.history[-1].data.resolved_revision == $sha)' >/dev/null &&
  ok "...kept on the record and its dispatch entry" || ko "the resolution is not on the record"
jq -n --arg sha "$moved_head" '{request_id:"rv-head", verdict:"pass", log:"/logs/x", evidence:"fixture run", handle:"fixture", remote_checkout:"/w/x", observed_sha:$sha}' > "$TMP/rv-head-done.json"
"${FWR[@]}" execution conclude "$TMP/rv-head-done.json" >/dev/null || ko "could not conclude rv-head (setup)"
"$FW" execution list | jq -e --arg sha "$moved_head" '[.[] | select(.request_id == "rv-head")][0] | .state == "concluded" and .resolved_revision == $sha' >/dev/null &&
  ok "...and on the conclusion" || ko "the concluded record lost its resolution"
: > "$SHIM_GH_COMMIT_LOG"
expect "a head-of run resolves in the same call" 0 "\"resolved_revision\": \"$moved_head\"" -- "${FWR[@]}" execution run "$(rv_req rv-head2 head-of:claude/topic)"
fixture_done rv-head2
expect "a head-of branch GitHub does not have is refused, nothing recorded" 1 "EXECUTION REFUSED: head-of:claude/gone: GitHub has no branch claude/gone in o/r" -- \
  "${FWR[@]}" execution run "$(rv_req rv-head3 head-of:claude/gone)"
[ -z "$(state_of rv-head3)" ] && ok "...and nothing was reserved" || ko "a refused head-of run left a record: $(state_of rv-head3)"
expect "a GitHub that cannot resolve the branch is UNVERIFIED (exit 4)" 4 "^EXECUTION UNVERIFIED github.com: head-of:claude/topic could not be resolved in o/r" -- \
  env SHIM_GH=down "${FWR[@]}" execution run "$(rv_req rv-head4 head-of:claude/topic)"
expect "a malformed head-of is refused at reserve" 1 "is not head-of:<one branch name>" -- \
  "${FWR[@]}" execution reserve "$(rv_req rv-head5 'head-of:main plus edits')"
expect "head-of:HEAD names no branch, refused at reserve" 1 "is not head-of:<one branch name>" -- \
  "${FWR[@]}" execution reserve "$(rv_req rv-head6 'head-of:HEAD')"
unset SHIM_GH_HEADS
}

section "execution conclude --standing-handback" && {
need_lease
# ludics-lite#605 item 3: a standing reservation is concluded at its worker's hand-back. Its last
# batch ran over uncommitted edits, or at a local commit later rebased away, or in a worktree since
# removed: `--from-run` rightly refuses each as evidence for one commit, so the coordinator wrote
# JSON by hand. The standing form records each in the evidence, reads observed_sha off the
# checkout, takes the verdict from the record or the hand-back (never a default), and refuses a
# request that is not standing.
FWH=(env FLEET_BOXES="testbox other" "$FW")
hwt="$TMP/handback wt"; git clone -q "$TMP/proj.git" "$hwt" && mkdir -p "$hwt/tools"
cat > "$hwt/tools/test-run.sh" <<'RUNNER'
#!/usr/bin/env bash
[ "$1" = status ] || exit 2
exit "${SHIM_RUN_STATUS:-0}"
RUNNER
chmod +x "$hwt/tools/test-run.sh"
hbase=$(git -C "$hwt" rev-parse HEAD)
git -C "$hwt" commit -q --allow-empty -m "the pushed head"
hhead=$(git -C "$hwt" rev-parse HEAD)
hruns="$TMP/handback runs"
hrun() { # <name> <exit or -> <launch head or -> <dirty lines or -> [worktree] -> a test-run.sh record
  local d="$hruns/$1"; mkdir -p "$d"; printf 'build @scans\n' > "$d/cmd"; printf '%s\n' "${5:-$hwt}" > "$d/wt"
  printf 'exit: %s\n' "$2" > "$d/log"; [ "$2" = - ] || printf '%s\n' "$2" > "$d/exit"
  [ "$3" = - ] || { printf '%s\n' "$3" > "$d/head"; printf '%s' "${4#-}" > "$d/dirty"; }
}
hreq() { # <id> [standing: true|false] -> a reservation payload file, requested at the base (#634)
  jq -n --arg id "$1" --arg rev "$hbase" --argjson standing "${2:-true}" '{request_id:$id, wave:"w", worker:$id, transport:"subagent",
    issue:"o/r#605", purpose:"standing fixture", agent_host:"testbox", execution_host:"testbox", repository:"o/r",
    requested_revision:$rev, kind:"correctness"} + (if $standing then {standing:true} else {} end)' > "$TMP/$1.json"
  "${FWH[@]}" execution run "$TMP/$1.json" >/dev/null 2>&1 || ko "could not reserve $1 (setup)"
}
hb() { local id="$1"; shift; "${FWH[@]}" execution conclude --standing-handback --request "$id" --observed-from "$hwt" "$@"; }
hstate() { "$FW" execution list | jq -r --arg id "$1" '[.[] | select(.request_id == $id) | .state] | join(",")'; }
hrun dirty 0 "$hbase" $' M lib/a.ml\n?? test/new_test.ml\n'; hrun rewritten 0 "$(printf 'd%.0s' $(seq 40))" ""
hrun gone 1 - - "$TMP/handback removed wt"; hrun unfinished - - -; hrun truncated 0 "${hbase%??????}" ""
hreq hb-usage
expect "the standing form needs the request" 2 "--request <id> required" -- "${FWH[@]}" execution conclude --standing-handback --observed-from "$hwt" --evidence x --verdict pass
expect "...the checkout observed_sha is read off" 2 "--observed-from <checkout> required" -- "${FWH[@]}" execution conclude --standing-handback --request hb-usage --evidence x --verdict pass
expect "...an absolute one" 2 "must be absolute" -- hb hb-usage --observed-from "handback wt" --evidence x --verdict pass
expect "...the hand-back's evidence" 2 "--evidence <text> required" -- hb hb-usage --verdict pass
expect "...and a verdict when no run is named: there is no default" 2 "--verdict pass|fail|timeout|cancelled required without --from-run" -- hb hb-usage --evidence "all green"
expect "...a verdict of the registry's vocabulary that names a run" 2 "--verdict must be one of pass|fail|timeout|cancelled, not 'not-launched'" -- hb hb-usage --evidence x --verdict not-launched
expect "...an absolute run directory" 2 "--from-run <run-dir> must be absolute" -- hb hb-usage --evidence x --from-run runs/x
expect "...and no stray flag" 2 "conclude --standing-handback --request <id>" -- hb hb-usage --evidence x --verdict pass --sha "$hhead"
hreq hb-plain false
expect "a request that is not standing is refused, naming the plain forms" 1 "hb-plain is not a standing reservation .*use conclude --from-run <run-dir>" -- hb hb-plain --evidence x --verdict pass
[ "$(hstate hb-plain)" = launching ] && ok "...and left dispatched" || ko "the refusal changed hb-plain: $(hstate hb-plain)"
fixture_done hb-plain
expect "an unknown request is refused" 1 "unknown request_id hb-none" -- hb hb-none --evidence x --verdict pass
expect "an unfinished run is still refused: no verdict to read" 1 "FROM-RUN REFUSED: .*has no exit" -- hb hb-usage --evidence x --from-run "$hruns/unfinished"
expect "...as is a run its runner says is still going" 1 "not a finished run" -- env SHIM_RUN_STATUS=3 "${FWH[@]}" execution conclude --standing-handback --request hb-usage --observed-from "$hwt" --evidence x --from-run "$hruns/dirty"
expect "...as is a launch head that is no exact object ID (a truncated one would read as rewritten)" 1 "FROM-RUN REFUSED: .*/head holds '${hbase%??????}', not one commit ID" -- \
  hb hb-usage --evidence x --from-run "$hruns/truncated"
expect "a --verdict the run record contradicts is refused" 1 "--verdict fail, but $hruns/dirty reads pass .*give one of them" -- hb hb-usage --evidence x --from-run "$hruns/dirty" --verdict fail
expect "an observed HEAD GitHub does not have in the repository is refused" 1 "observed_sha $hhead is no commit of o/r" -- \
  env SHIM_GH_NO_COMMIT="$hhead" "${FWH[@]}" execution conclude --standing-handback --request hb-usage --observed-from "$hwt" --evidence x --verdict pass
[ "$(hstate hb-usage)" = launching ] && ok "every refusal left the standing record dispatched" || ko "a refusal changed hb-usage: $(hstate hb-usage)"
fixture_done hb-usage
# The three cases --from-run refuses, each concluded with what made it no evidence for one commit.
hreq hb-dirty
expect "a last batch over uncommitted edits at an earlier commit concludes with its verdict, requested at the base, observed at the head" 0 '"verdict": "pass"' -- \
  hb hb-dirty --evidence "all batches green" --from-run "$hruns/dirty"
for want in "\"observed_sha\": \"$hhead\"" "\"remote_checkout\": \"$hwt\"" "\"handle\": \"test-run:dirty\"" "\"log\": \"$hruns/dirty/log\"" \
    "all batches green; standing hand-back, observed_sha read as HEAD of $hwt on testbox" \
    "exit 0 (pass), launched at $hbase, an ancestor of observed_sha over 2 uncommitted path(s) its dirty lists"; do
  grep -Fq -- "$want" <<<"$out" && ok "...recorded $want" || ko "missing $want in $out"
done
hreq hb-rewritten
expect "a last batch at a commit since rewritten concludes, saying so" 0 "launched at $(printf 'd%.0s' $(seq 40)), which is not in observed_sha's history (rewritten by a rebase, or never pushed) on a clean tree" -- \
  hb hb-rewritten --evidence "green" --from-run "$hruns/rewritten"
hreq hb-gone
expect "a last batch whose worktree is gone concludes with its red verdict, saying so" 0 "its recorded worktree $TMP/handback removed wt is gone" -- \
  hb hb-gone --evidence "one batch red" --from-run "$hruns/gone"
grep -Fq '"verdict": "fail"' <<<"$out" && ok "...as fail" || ko "exit 1 did not read as fail: $out"
# A --from-run hand-back whose answer was lost, retried once the worker's run worktree is removed:
# re-read, the record would say "gone", so the recorded conclusion is the retry's payload.
rwt="$TMP/handback run wt"; git clone -q "$TMP/proj.git" "$rwt"
hrun later 0 - - "$rwt"; hreq hb-retry
hb hb-retry --evidence "green" --from-run "$hruns/later" > "$TMP/hb-retry.out" 2>&1 || ko "could not conclude hb-retry (setup): $(cat "$TMP/hb-retry.out")"
rm -rf "${rwt:?}"
expect "a --from-run retry after its worktree is removed is the registry's harmless retry" 0 '"state": "concluded"' -- \
  env SHIM_GH=down "${FWH[@]}" execution conclude --standing-handback --request hb-retry --observed-from "$hwt" --evidence "green" --from-run "$hruns/later"
grep -Fq "is gone" <<<"$out" && ko "the retry recomposed its evidence: $out" || ok "...with the evidence the conclusion recorded"
hreq hb-verdict
expect "with no run named, the hand-back's own verdict concludes it" 0 "verdict fail as the worker's hand-back reports it, no run record named" -- \
  hb hb-verdict --evidence "the scans batch stayed red" --verdict fail
grep -Fq '"handle": "standing-handback:hb-verdict"' <<<"$out" && grep -Fq '"verdict": "fail"' <<<"$out" && ok "...as fail, its handle naming the hand-back" || ko "no-run conclusion: $out"
# The answer lost, the retry comes after the worker moved its checkout on: the recorded SHA stands.
git -C "$hwt" commit -q --allow-empty -m "moved on"
expect "...and a retry once the checkout has moved on is the registry's harmless retry" 0 "\"observed_sha\": \"$hhead\"" -- \
  env SHIM_GH=down "${FWH[@]}" execution conclude --standing-handback --request hb-verdict --observed-from "$hwt" --evidence "the scans batch stayed red" --verdict fail
}

section "execution leg" && {
need_lease
# ludics-lite#558: one reserved run of a project's runner on a box, at an exact commit, in a worktree
# the leg makes or moves there; the fake remote is a bare repository, the box this one (and, once,
# "other" through the ssh shim). The project's runner prints what it was given and under what, and
# exits with its `verdict` file's status, 4 when a control patch added `broken`; it ends with a
# runner sentinel as OCANNL's test-run.sh does, so the leg's own must come after it.
# Four slots here, the first the one GPU token, so a batch declared --cpu shows in the slot it takes.
FWL=(env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=4 other=2" FLEET_BOX_GPU_TOKENS="testbox=1"
  FLEET_SKILLS_REPO="$TMP/dispatcher" "$FW")
lsrc="$TMP/leg src"; lremote="$TMP/leg.git"; lco="$TMP/leg co"; lwt="$TMP/leg wts/w 1"
export LEG_MARK="$TMP/leg-ran"; : > "$LEG_MARK"
git init -q -b main "$lsrc" && mkdir -p "$lsrc/tools" && printf '0\n' > "$lsrc/verdict" && printf 'leg fixture\n' > "$lsrc/README"
cat > "$lsrc/tools/check.sh" <<'EOF'
#!/usr/bin/env bash
printf 'runner argv:'; printf ' [%s]' "$@"; printf '\n'
printf 'runner slot: %s\n' "${FLEET_SLOT_HELD:-none}"
printf 'runner hold: %s\n' "${FLEET_MEASUREMENT_HELD:-none}"
printf '%s\n' "$(git rev-parse HEAD)" >> "$LEG_MARK"
rc=$(cat verdict); [ ! -e broken ] || rc=4
printf 'check: exit: %s\n' "$rc"
exit "$rc"
EOF
chmod +x "$lsrc/tools/check.sh"
git -C "$lsrc" add -A && git -C "$lsrc" commit -q -m A && la=$(git -C "$lsrc" rev-parse HEAD)
git -C "$lsrc" checkout -q -b claude/topic && printf 'b\n' > "$lsrc/b" && git -C "$lsrc" add b && git -C "$lsrc" commit -q -m B && lb=$(git -C "$lsrc" rev-parse HEAD)
git -C "$lsrc" checkout -q -b red main && printf '1\n' > "$lsrc/verdict" && git -C "$lsrc" commit -q -am C && lred=$(git -C "$lsrc" rev-parse HEAD)
git init -q --bare "$lremote" && git -C "$lsrc" push -q "$lremote" main claude/topic red
# A tag named like the branch `red`, at another commit: a leg at the branch must not take it.
git -C "$lsrc" tag red-tag main && git -C "$lsrc" push -q "$lremote" "refs/tags/red-tag:refs/tags/red" && git -C "$lsrc" tag -d red-tag >/dev/null
git clone -q -b main "$lremote" "$lco" || ko "could not clone the leg checkout (setup)"
git -C "$lsrc" checkout -q main
# The control patches: one the runner catches (adds `broken`), one it cannot (README), one that does
# not apply to any commit here.
mkpatch() { # <name> <file> <content>
  git -C "$lsrc" checkout -q main && printf '%s\n' "$3" > "$lsrc/$2" && git -C "$lsrc" add -N "$2" &&
    git -C "$lsrc" diff > "$TMP/$1.patch" && git -C "$lsrc" reset -q && git -C "$lsrc" checkout -q -- . && rm -f "$lsrc/broken"
}
mkpatch break broken x; mkpatch harmless README "leg fixture, edited"
sed 's/^-leg fixture$/-no such line/; s/^ leg fixture$/ no such line/' "$TMP/harmless.patch" > "$TMP/stale.patch"
rm "$lsrc/tools/check.sh" && git -C "$lsrc" diff > "$TMP/rm-runner.patch" && git -C "$lsrc" checkout -q -- .
lreq() { # <id> [host] [kind] [revision] -> run it, print the payload path
  jq -n --arg id "$1" --arg host "${2:-testbox}" --arg kind "${3:-correctness}" --arg rev "${4:-origin/main}" '{request_id:$id, wave:"w", worker:$id,
    transport:"subagent", issue:"o/r#558", purpose:"leg fixture", agent_host:"testbox", execution_host:$host, repository:"o/r",
    requested_revision:$rev, kind:$kind}' > "$TMP/$1.json"
  "${FWL[@]}" execution run "$TMP/$1.json" >/dev/null 2>&1 || ko "could not run $1 (setup)"
}
leg() { "${FWL[@]}" execution leg "$@"; }
marks() { grep -c '' "$LEG_MARK"; }
last_line() { tail -n 1 <<<"$out"; }
lreq leg-a
expect "a leg needs --rev" 2 "execution leg: --rev required" -- leg --request leg-a --checkout "$lco" --worktree "$lwt" -- tools/check.sh
expect "a leg needs a runner command" 2 "execution leg --request <id>" -- leg --request leg-a --rev main --checkout "$lco" --worktree "$lwt"
expect "an abbreviated --rev is refused before anything is asked" 2 "looks like an abbreviated or uppercase SHA" -- \
  leg --request leg-a --rev "${la:0:9}" --checkout "$lco" --worktree "$lwt" -- tools/check.sh
expect "a --deadline given twice is a usage error" 2 "execution leg: --deadline given twice" -- \
  leg --request leg-a --rev main --checkout "$lco" --worktree "$lwt" --deadline 10 --deadline 5 -- tools/check.sh
expect "a bad FLEET_FETCH_TIMEOUT is refused before anything is copied to the box" 2 "FLEET_FETCH_TIMEOUT must be a positive whole number" -- \
  env FLEET_FETCH_TIMEOUT=soon "${FWL[@]}" execution leg --request leg-a --rev main --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- tools/check.sh
[ -z "$(find "$ISSUE_WAVE_STATE/leg-control" -type f 2>/dev/null)" ] && ok "...no patch staged" || ko "a refused leg left a staged patch"
expect "--worktree must not be the checkout" 2 "--worktree must not be --checkout" -- leg --request leg-a --rev main --checkout "$lco" --worktree "$lco/" -- tools/check.sh
expect "a leg runs only inside a reservation the registry holds" 1 "EXECUTION LEG REFUSED: unknown request_id leg-zz" -- \
  leg --request leg-zz --rev main --checkout "$lco" --worktree "$lwt" -- tools/check.sh
jq -n '{request_id:"leg-r", wave:"w", worker:"leg-r", transport:"subagent", issue:"o/r#558", purpose:"leg fixture", agent_host:"testbox",
  execution_host:"testbox", repository:"o/r", requested_revision:"origin/main", kind:"correctness"}' > "$TMP/leg-r.json"
"${FWL[@]}" execution reserve "$TMP/leg-r.json" >/dev/null || ko "could not reserve leg-r (setup)"
expect "...and only a dispatched one" 1 "leg-r is reserved, not dispatched" -- leg --request leg-r --rev main --checkout "$lco" --worktree "$lwt" -- tools/check.sh
fixture_done leg-r
lreq leg-o other
expect "...on the box it reserved" 1 "leg-o is reserved on other, not testbox" -- leg --request leg-o --box testbox --rev main --checkout "$lco" --worktree "$lwt" -- tools/check.sh
[ "$(marks)" = 0 ] && ok "...each refusal before the runner ran" || ko "a refused leg ran its runner"
# The leg proper: a branch, fetched from the remote into a private ref, a worktree made at it.
expect "a leg at a branch makes the worktree there and runs the runner in it under a slot" 0 "runner argv: \\[two words\\] \\[\$(x)\\] \\[\\]" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --cpu -- tools/check.sh "two words" '$(x)' ''
grep -q "^EXECUTION LEG testbox: created $lwt at $lb (claude/topic, fetched from origin) for request leg-a; observed_sha=$lb$" <<<"$out" &&
  ok "...naming the worktree and the observed_sha" || ko "no creation line: $out"
grep -q "^runner slot: testbox [2-4] 4 cpu$" <<<"$out" && ok "...inside execution slot, which took a CPU slot for the --cpu it was given" || ko "the runner held no CPU slot: $out"
[ "$(last_line)" = "execution-leg: exit: 0" ] && ok "...its sentinel the last line, after the runner's own" || ko "last line: $(last_line)"
[ "$(git -C "$lwt" rev-parse HEAD)" = "$lb" ] && [ "$(tail -n 1 "$LEG_MARK")" = "$lb" ] && ok "...at the branch's commit" || ko "the worktree is not at $lb"
[ -z "$(git -C "$lco" for-each-ref refs/fleet-leg)" ] && ok "...the private ref deleted" || ko "a fleet-leg ref was left: $(git -C "$lco" for-each-ref refs/fleet-leg)"
[ "$(git -C "$lco" rev-parse HEAD)" = "$la" ] && ok "...the main checkout untouched" || ko "the main checkout moved"
expect "a full SHA the checkout has refreshes the worktree there, nothing fetched" 0 "refreshed $lwt at $la ($la, already in $lco)" -- \
  leg --request leg-a --rev "$la" --checkout "$lco" --worktree "$lwt" -- tools/check.sh
expect "the runner's 125 survives the trip unchanged" 125 "execution-leg: exit: 125" -- leg --request leg-a --rev main --checkout "$lco" --worktree "$lwt" -- sh -c 'exit 125'
expect "...and so does a status of 128 or more" 130 "execution-leg: exit: 130" -- leg --request leg-a --rev main --checkout "$lco" --worktree "$lwt" -- sh -c 'exit 130'
expect "a runner whose output ends without a newline still reports its status, the sentinel on a line of its own" 255 "^partial$" -- \
  leg --request leg-a --rev main --checkout "$lco" --worktree "$lwt" -- sh -c 'printf partial; exit 255'
[ "$(last_line)" = "execution-leg: exit: 255" ] && ok "...as the last line" || ko "last line: $(last_line)"
n=$(marks)
: > "$lwt/stray"
expect "a worktree with uncommitted changes is refused, never overwritten" 1 "EXECUTION LEG REFUSED testbox: --worktree $lwt has uncommitted changes (1 path(s))" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/check.sh
rm -f "$lwt/stray"
grep -q "execution-leg: exit" <<<"$out" && ko "a refusal printed the runner's sentinel: $out" || ok "...with no sentinel, the runner never started"
expect "a revision the remote does not have is refused" 1 "git fetch origin claude/none in $lco failed" -- \
  leg --request leg-a --rev claude/none --checkout "$lco" --worktree "$lwt" -- tools/check.sh
expect "the repository's main checkout is never moved" 1 "--worktree $lco is the repository's main checkout" -- \
  leg --request leg-a --rev main --checkout "$lwt" --worktree "$lco" -- tools/check.sh
expect "a directory of another repository is no worktree to move" 1 "is not a worktree of $lco" -- \
  leg --request leg-a --rev main --checkout "$lco" --worktree "$proj" -- tools/check.sh
[ "$(marks)" = "$n" ] && ok "...none of them ran the runner" || ko "a refused leg ran its runner"
# The control: a patch that must make the runner fail, in the same slot, reverted after.
expect "a control the runner catches makes the leg pass" 0 "control failed as required (exit 4), patch reverted" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- tools/check.sh
[ "$(last_line)" = "execution-leg: exit: 0" ] && ok "...its sentinel after the control run's own exit: 4" || ko "last line: $(last_line)"
[ "$(marks)" = $((n + 2)) ] && [ -z "$(git -C "$lwt" status --porcelain)" ] && ok "...two runs, the worktree clean after" || ko "runs $(marks) (from $n), status: $(git -C "$lwt" status --porcelain)"
expect "a control the runner does not catch fails the leg" 1 "CONTROL PASSED: the runner passed with" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/harmless.patch" -- tools/check.sh
[ "$(last_line)" = "execution-leg: exit: 1" ] && [ -z "$(git -C "$lwt" status --porcelain)" ] && ok "...reverted, its sentinel 1" || ko "last line $(last_line)"
expect "a control run cut by --deadline is no verdict, its status kept" 124 "the control run was cut (exit 124): no control verdict" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" --deadline 3 -- \
  sh -c 'if [ -e broken ]; then sleep 30; fi; exit 0'
grep -q "EXECUTION SLOT testbox: --deadline 3s reached" <<<"$out" && [ -z "$(git -C "$lwt" status --porcelain)" ] &&
  ok "...cut by the control run's own nested deadline, and the patch reverted" || ko "the cut control left the worktree: $(git -C "$lwt" status --porcelain) -- $out"
expect "a control patch the run made impossible to revert fails the leg, whatever the control did" 1 "CONTROL NOT REVERTED: the control patch could not be reverted" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- \
  sh -c 'if [ -e broken ]; then echo changed > broken; exit 3; fi; exit 0'
[ "$(last_line)" = "execution-leg: exit: 1" ] && ok "...its sentinel 1" || ko "last line: $(last_line)"
rm -f "$lwt/broken"
# One leg at a time per worktree: a second is refused while the first runs, never queued.
rm -f "$TMP/leg-started" "$TMP/leg-go"
leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" -- \
  sh -c 'touch "$1"; while [ ! -e "$2" ]; do sleep 0.2; done' x "$TMP/leg-started" "$TMP/leg-go" > "$TMP/leg-first.out" 2>&1 &
first=$!
for _ in $(seq 100); do [ -e "$TMP/leg-started" ] && break; sleep 0.2; done
expect "a second leg in a worktree another leg is running in is refused" 1 "another leg is using it" -- \
  leg --request leg-a --rev "$la" --checkout "$lco" --worktree "$lwt/" -- tools/check.sh
touch "$TMP/leg-go"; wait "$first"; first_rc=$?
[ "$first_rc" = 0 ] && [ "$(git -C "$lwt" rev-parse HEAD)" = "$lb" ] && ok "...the first leg's worktree left at its commit" ||
  ko "the first leg: rc=$first_rc head=$(git -C "$lwt" rev-parse HEAD) -- $(cat "$TMP/leg-first.out")"
expect "...and once it is done the next leg takes it" 0 "execution-leg: exit: 0" -- leg --request leg-a --rev "$la" --checkout "$lco" --worktree "$lwt" -- tools/check.sh
# The fetch is bounded by FLEET_FETCH_TIMEOUT: a remote that accepts and then stalls. Its shell
# forks the sleep (dash does even for `sh -c 'sleep 20'`, as on the CI runner), which outlives the
# bound; it must not hold the worktree's lock, so the next case runs at once.
git -C "$lco" remote add slow "$lremote" && git -C "$lco" config remote.slow.uploadpack "sh -c 'sleep 20; exit 1'"
expect "a fetch that stalls is cut at FLEET_FETCH_TIMEOUT and refused" 1 "did not finish in 2s (FLEET_FETCH_TIMEOUT)" -- \
  env FLEET_FETCH_TIMEOUT=2 "${FWL[@]}" execution leg --request leg-a --rev claude/topic --remote slow --checkout "$lco" --worktree "$lwt" -- tools/check.sh
rm -f "$TMP/leg-late"
expect "a runner's background leftovers are reaped before the control runs" 0 "control failed as required (exit 3)" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- \
  sh -c 'if [ -e broken ]; then exit 3; fi; (sleep 3; touch "$1") & exit 0' x "$TMP/leg-late"
sleep 4
[ ! -e "$TMP/leg-late" ] && ok "...the main run's background child ended with it" || ko "a background child of the main run outlived it"
# A submodule the checkout moves past is refused, never updated: the runner would test its old commit.
lsub="$TMP/leg sub.git"; git init -q --bare -b main "$lsub"
git clone -q "$lsub" "$TMP/leg sub" 2>/dev/null; git -C "$TMP/leg sub" commit -q --allow-empty -m S1 && git -C "$TMP/leg sub" push -q origin HEAD:main
s1=$(git -C "$TMP/leg sub" rev-parse HEAD); git -C "$TMP/leg sub" commit -q --allow-empty -m S2 && git -C "$TMP/leg sub" push -q origin HEAD:main
git -C "$lsrc" checkout -q -b subbed main && git -C "$lsrc" -c protocol.file.allow=always submodule add -q "$lsub" sub >/dev/null 2>&1 &&
  git -C "$lsrc/sub" checkout -q "$s1" && git -C "$lsrc" add sub && git -C "$lsrc" commit -q -m "sub at S1" &&
  git -C "$lsrc/sub" checkout -q main && git -C "$lsrc" commit -q -am "sub at S2" && git -C "$lsrc" push -q "$lremote" HEAD~1:refs/heads/sub1 HEAD:refs/heads/sub2 &&
  git -C "$lsrc" checkout -q main || ko "could not build the submodule fixture (setup)"
lwt2="$TMP/leg wts/sub"
leg --request leg-a --rev sub1 --checkout "$lco" --worktree "$lwt2" -- true >/dev/null 2>&1 || ko "could not make the submodule worktree (setup)"
git -C "$lwt2" -c protocol.file.allow=always submodule update -q --init >/dev/null 2>&1 || ko "could not initialize the submodule (setup)"
expect "a submodule the checkout moved past is refused, never updated" 1 "is not clean at $(git -C "$lremote" rev-parse sub2) ( M sub;)" -- \
  leg --request leg-a --rev sub2 --checkout "$lco" --worktree "$lwt2" -- tools/check.sh
n=$(marks)
expect "a control that does not apply is refused before anything runs" 1 "the control patch does not apply to $lb" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/stale.patch" -- tools/check.sh
[ "$(marks)" = "$n" ] && ok "...the runner not started" || ko "the runner ran under a control that does not apply"
expect "a control whose patch removes the runner is no control, never a pass" 1 "NO CONTROL: the control run could not execute the runner (the patch removed it" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/rm-runner.patch" -- tools/check.sh
[ "$(last_line)" = "execution-leg: exit: 1" ] && [ -z "$(git -C "$lwt" status --porcelain)" ] && ok "...status 1, the patch reverted" || ko "last line $(last_line), status $(git -C "$lwt" status --porcelain)"
expect "a main run that moves HEAD gets no control on the commit it left" 1 "NO CONTROL: the main run left $lwt at $la, not $lb" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- \
  sh -c 'if [ ! -e broken ]; then git checkout -q --detach HEAD~1; fi; exit 0'
grep -q "control patch applied" <<<"$out" && ko "the control ran on a moved worktree: $out" || ok "...the patch never applied"
git -C "$lco" config status.showUntrackedFiles no   # a configuration hiding untracked files hides nothing from the leg
expect "a control run that leaves residue is no control, never a pass" 1 "NO CONTROL: after the control run $lwt is not clean at $lb (?? residue;" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- \
  sh -c 'if [ -e broken ]; then : > residue; exit 3; fi; exit 0'
rm -f "$lwt/residue"; git -C "$lco" config --unset status.showUntrackedFiles
# Each run carries the leg's --deadline; the wrapper holding both runs carries none, so a main run
# that spends most of it leaves the control its own.
expect "a controlled leg gives each run the whole --deadline" 0 "control failed as required (exit 3)" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" --deadline 4 -- \
  sh -c 'sleep 3; if [ -e broken ]; then exit 3; fi; exit 0'
expect "the checkout spelled another way is still no worktree to move" 1 "is --checkout" -- \
  leg --request leg-a --rev main --checkout "$lwt" --worktree "$lwt/." -- tools/check.sh
expect "a runner that is no executable command is refused, never a status" 1 "EXECUTION LEG REFUSED testbox: the runner is not an executable command" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/no-such-runner.sh
grep -q "execution-leg: exit" <<<"$out" && ko "an unexecutable runner printed a sentinel: $out" || ok "...with no sentinel"
expect "a main run that leaves files behind gets no control" 1 "NO CONTROL: the main run left 1 changed or untracked path(s)" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- \
  sh -c 'if [ ! -e broken ]; then : > leftover; fi; exit 0'
grep -q "control patch applied" <<<"$out" && ko "the control ran on a dirty worktree: $out" || ok "...the patch never applied"
rm -f "$lwt/leftover"
expect "--wait 0 is the slot's refuse-at-once, passed through" 0 "execution-leg: exit: 0" -- \
  leg --request leg-a --rev claude/topic --checkout "$lco" --worktree "$lwt" --wait 0 --wait-window=0 -- tools/check.sh
expect "a main run that fails is the leg's status, its control not run (and the branch red, not the tag red) " 1 "runner exit 1 at $lred" -- \
  leg --request leg-a --rev red --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- tools/check.sh
grep -q "control patch applied" <<<"$out" && ko "the control ran after a red main run: $out" || ok "...the control skipped"
[ -z "$(find "$ISSUE_WAVE_STATE/leg-control" -type f 2>/dev/null)" ] && ok "...and every copied patch removed from the box" || ko "a patch was left: $(ls "$ISSUE_WAVE_STATE/leg-control")"
# A leg blocked under bg-run concludes from its directory: the leg's sentinel wins over the
# control run's, which a runner prints last otherwise.
lbg=$(bash "$TMP/dispatcher/issue-wave/scripts/bg-run.sh" new "$TMP/leg runs") || ko "could not allocate a bg-run directory (setup)"
bash "$TMP/dispatcher/issue-wave/scripts/bg-run.sh" start "$lbg" -- "${FWL[@]}" execution leg --request leg-a --rev claude/topic \
  --checkout "$lco" --worktree "$lwt" --control "$TMP/break.patch" -- tools/check.sh >/dev/null 2>&1
expect "a controlled leg under bg-run concludes pass from its directory" 0 '"verdict": "pass"' -- \
  "${FWL[@]}" execution conclude --from-bg-run "$lbg" --request leg-a --sha "$(sed -n 's/.*; observed_sha=//p' "$lbg/log")"
grep -Fq "runner sentinel 'execution-leg: exit: 0'" <<<"$out" && grep -Fq "\"observed_sha\": \"$lb\"" <<<"$out" &&
  ok "...reading the leg's sentinel, at the observed_sha it printed" || ko "the conclusion read another sentinel or SHA: $out"
# Over ssh (the shim runs "other" here): every runner word crosses the remote shell intact.
expect "a leg over ssh passes the runner's words through the remote shell untouched" 0 "runner argv: \\[a b\\] \\['q'\\] \\[\$HOME\\] \\[;\\]" -- \
  env SHIM_SSH_LOCAL=other "${FWL[@]}" execution leg --request leg-o --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/check.sh "a b" "'q'" '$HOME' ';'
grep -q "^EXECUTION LEG other: refreshed $lwt at $lb" <<<"$out" && ok "...on the reserved box" || ko "not run as other: $out"
expect "a box that does not answer is UNREACHABLE (exit 4), not a runner's status" 4 "^EXECUTION LEG UNREACHABLE other: ssh failed or the connection dropped" -- \
  leg --request leg-o --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/check.sh
# ludics-lite#632: the box's own env.sh names another roster, anchor, registry and slot spec. The
# leg's slot there runs under the coordinator's: its roster has the box, its spec four slots, and
# its registry is the one the leg's own record is in. Read with the box's, the slot would refuse.
cat > "$TMP/other-env.sh" <<EOF
export FLEET_BOXES="elsewhere" FLEET_ANCHOR="nowhere" FLEET_ANCHOR_STATE="$TMP/not the registry"
export FLEET_BOX_CORRECTNESS_SLOTS="elsewhere=1" FLEET_BOX_GPU_TOKENS=""
EOF
expect "a leg over ssh takes its slot under the coordinator's fleet configuration, not the box's env.sh" 0 "^runner slot: testbox [1-4] 4 gpu$" -- \
  env SHIM_SSH_LOCAL=other SHIM_SSH_ENV="$TMP/other-env.sh" "${FWL[@]}" execution leg --request leg-o --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/check.sh
# ...and a fleet-worker.sh under it that something re-pointed at another registry refuses (the pin).
expect "a fleet-worker.sh under the leg whose anchor was re-set refuses to read another registry" 1 "REFUSED: this box resolves the execution registry as anchor nowhere, .*but the coordinator that started it reads anchor testbox, " -- \
  env SHIM_SSH_LOCAL=other SHIM_SSH_ENV="$TMP/other-env.sh" "${FWL[@]}" execution leg --request leg-o --rev claude/topic --checkout "$lco" --worktree "$lwt" -- \
  env FLEET_ANCHOR=nowhere "$FW" execution list
fixture_done leg-o
# A head-of request's leg runs the commit resolved at assignment, not where the branch is now.
printf 'claude/topic %s\n' "$lb" > "$TMP/leg-heads"
SHIM_GH_HEADS="$TMP/leg-heads" lreq leg-h testbox correctness head-of:claude/topic
git -C "$lsrc" checkout -q claude/topic && git -C "$lsrc" commit -q --allow-empty -m D && git -C "$lsrc" push -q "$lremote" claude/topic && git -C "$lsrc" checkout -q main
expect "a head-of leg refuses the branch once it has moved past the assigned commit" 1 "claude/topic is $(git -C "$lsrc" rev-parse claude/topic), but request leg-h was assigned $lb: run --rev $lb" -- \
  leg --request leg-h --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/check.sh
expect "...and runs the assigned commit" 0 "execution-leg: exit: 0" -- leg --request leg-h --rev "$lb" --checkout "$lco" --worktree "$lwt" -- tools/check.sh
fixture_done leg-h
# A request for one exact commit binds its leg to that commit as well.
lreq leg-x testbox correctness "$la"
expect "a leg of an exact-SHA request refuses another commit" 1 "but request leg-x was assigned $la: run --rev $la" -- \
  leg --request leg-x --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/check.sh
expect "...and runs that one" 0 "execution-leg: exit: 0" -- leg --request leg-x --rev "$la" --checkout "$lco" --worktree "$lwt" -- tools/check.sh
fixture_done leg-x
# A head-of record never dispatched was never resolved: no commit is its, so reconcile will not
# make it active (and a leg refuses one that is, as a record written otherwise would be).
jq -n '{request_id:"leg-hu", wave:"w", worker:"leg-hu", transport:"subagent", issue:"o/r#558", purpose:"leg fixture", agent_host:"testbox",
  execution_host:"testbox", repository:"o/r", requested_revision:"head-of:claude/topic", kind:"correctness"}' > "$TMP/leg-hu.json"
"${FWL[@]}" execution reserve "$TMP/leg-hu.json" >/dev/null || ko "could not reserve leg-hu (setup)"
printf '{"request_id":"leg-hu","state":"running","evidence":"fixture: recovered"}' > "$TMP/leg-hu-rec.json"
expect "reconcile never makes an unresolved head-of record running" 1 "head-of:claude/topic was never resolved (no dispatch)" -- \
  "${FWL[@]}" execution reconcile "$TMP/leg-hu-rec.json"
fixture_done leg-hu
# A measurement runs under the hold of its own request, which takes no slot flags.
lreq leg-m testbox measurement
expect "a measurement's leg takes no slot flags" 2 "is a measurement, run under \`execution hold\`" -- \
  leg --request leg-m --rev main --checkout "$lco" --worktree "$lwt" --cpu -- tools/check.sh
expect "a measurement's leg runs under execution hold --request" 0 "^runner hold: testbox leg-m$" -- \
  leg --request leg-m --rev main --checkout "$lco" --worktree "$lwt" --deadline 600 -- tools/check.sh
fixture_done leg-m
# THE WINDOW WAIT (ludics-lite#666): a standing record a measurement window suspended is refused
# at once without --wait-window; with it the leg waits in the slot's own wait, on this side, for
# its record's box, under the one bound, and runs once nothing holds the box.
legwin() { # <id> -> open a measurement window on testbox under that id
  jq -n --arg id "$1" '{request_id:$id, wave:"w", worker:$id, transport:"subagent", issue:"o/r#666", purpose:"leg window fixture",
    agent_host:"testbox", execution_host:"testbox", repository:"o/r", requested_revision:"origin/main", kind:"measurement"}' > "$TMP/$1.json"
  "${FWL[@]}" execution window testbox "$TMP/$1.json" >/dev/null 2>&1 || ko "could not open window $1 (setup)"
}
jq -n '{request_id:"leg-s", wave:"w", worker:"leg-s", transport:"subagent", issue:"o/r#666", purpose:"leg fixture", agent_host:"testbox",
  execution_host:"testbox", repository:"o/r", requested_revision:"origin/main", kind:"correctness", standing:true}' > "$TMP/leg-s.json"
"${FWL[@]}" execution run "$TMP/leg-s.json" >/dev/null 2>&1 || ko "could not take the standing reservation leg-s (setup)"
legwin leg-w1
n=$(marks)
expect "a leg of a standing record a window suspended is refused at once without --wait-window, naming the window" 1 \
  "EXECUTION LEG REFUSED: leg-s is suspended by measurement window leg-w1; run the leg once that window concludes, or give it --wait-window" -- \
  leg --request leg-s --rev claude/topic --checkout "$lco" --worktree "$lwt" -- tools/check.sh
expect "...and with --wait-window on the wrong box, refused before any wait" 1 "leg-s is reserved on testbox, not other" -- \
  leg --request leg-s --box other --rev claude/topic --checkout "$lco" --worktree "$lwt" --wait-window=60 -- tools/check.sh
expect "a window that outlasts the leg's --wait-window bound refuses it there, naming the window" 1 \
  "^EXECUTION LEG REFUSED testbox: measurement leg-w1 still holds testbox after 1s (--wait-window); nothing ran$" -- \
  env FLEET_SLOT_WINDOW_POLL=1 "${FWL[@]}" execution leg --request leg-s --rev claude/topic --checkout "$lco" --worktree "$lwt" --wait-window=1 -- tools/check.sh
grep -q "^EXECUTION LEG testbox: measurement window leg-w1 holds testbox (coordinator " <<<"$out" && ok "...having named the window and its owner" || ko "the bounded leg never named the window: $out"
[ "$(marks)" = "$n" ] && ok "...none of them ran the runner" || ko "a leg ran its runner during the window"
# The coordinator's back-to-back windows: leg-w1 concludes and leg-w2 opens while the leg waits.
# Its re-reads are 5 s apart, so the two registry calls land between two of them and the leg reads
# the second window, never the gap (a leg admitted in a gap would be any batch's case: the slot on
# the box and the window's drain see to it).
leg_said() { # <pattern>: wait up to 40 s for the waiting leg's output to show it
  local i; for i in $(seq 200); do grep -q "$1" "$TMP/leg-ww.out" 2>/dev/null && return 0; sleep 0.2; done; return 1
}
env FLEET_SLOT_WINDOW_POLL=5 "${FWL[@]}" execution leg --request leg-s --rev claude/topic --checkout "$lco" --worktree "$lwt" \
  --wait-window=120 -- tools/check.sh > "$TMP/leg-ww.out" 2>&1 &
lww=$!
if leg_said "^EXECUTION LEG testbox: waiting up to 120s (--wait-window) for it to conclude, then for a slot, for: tools/check.sh$"; then
  ok "a leg given --wait-window waits for the window that suspended its standing record"
  fixture_done leg-w1; legwin leg-w2
  leg_said "^EXECUTION LEG testbox: measurement window leg-w2 holds testbox" && ok "...and for a window opened mid-wait, which it names" ||
    ko "the waiting leg never named the window opened mid-wait: $(cat "$TMP/leg-ww.out")"
  [ "$(marks)" = "$n" ] && kill -0 "$lww" 2>/dev/null && ok "...still waiting, the runner not run" || ko "the leg ran or ended during the second window: $(cat "$TMP/leg-ww.out")"
  fixture_done leg-w2
  wait "$lww"; lwwrc=$?
  [ "$lwwrc" = 0 ] && [ "$(tail -n 1 "$TMP/leg-ww.out")" = "execution-leg: exit: 0" ] && [ "$(marks)" = $((n + 1)) ] &&
    ok "...and once it concludes inside the bound the leg runs, once, its status the runner's" || ko "the waited leg: rc=$lwwrc runs $(marks) (from $n) -- $(cat "$TMP/leg-ww.out")"
  grep -q "^EXECUTION LEG testbox: no measurement holds testbox after [0-9]*s; running the leg$" "$TMP/leg-ww.out" &&
    grep -q "^EXECUTION SLOT testbox: slot [0-9] of 4[^:]* held for: bash" "$TMP/leg-ww.out" && ok "...in a slot on the box, after saying the box is free" || ko "the waited leg's output: $(cat "$TMP/leg-ww.out")"
else
  ko "the leg never said it waits for the window: $(cat "$TMP/leg-ww.out")"; kill "$lww" 2>/dev/null; wait "$lww" 2>/dev/null; fixture_done leg-w1
fi
fixture_done leg-s
unset LEG_MARK
}

section "prs (the supervision read)" && {
# ludics-lite#405: one line per open PR, from ship-pr's pr-review.sh (stubbed: SHIM_PRS).
P="$TMP/prs"; mkdir -p "$P"; export SHIM_PRS="$P"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n --arg now "$now" '[
  {number: 12, title: "second\tPR", headRefName: "claude/issue-12", headRefOid: "c12", createdAt: "2026-09-01T00:00:00Z", isDraft: true,
   closingIssuesReferences: [{number: 12, repository: {name: "r", owner: {login: "o"}}}]},
  {number: 7, title: "first PR", headRefName: "claude/issue-7", headRefOid: "c7", createdAt: $now, isDraft: false,
   closingIssuesReferences: [{number: 7, repository: {name: "other", owner: {login: "o"}}}]},
  {number: 9, title: "", headRefName: "claude/issue-9", headRefOid: "c9", createdAt: $now, isDraft: false, closingIssuesReferences: []}]' > "$P/list.json"
echo 6 > "$P/rounds-12"; echo 2 > "$P/rounds-7"
printf '0\ngreen — 3 build checks passed\nchecks: verdict=green\n' > "$P/checks-12"
printf '4\nNO VERDICT YET — still running\nchecks: verdict=pending\n' > "$P/checks-7"
printf '0\nABSENT — no build check ran on this commit: x\nchecks: verdict=absent\n' > "$P/checks-9"
echo "2026-09-02T00:00:00Z" > "$P/date-c12"; echo "$now" > "$P/date-c7"
expect "prs flags a PR at five or more rounds, exit 1" 1 "o/r#12 rounds=6 ci=green head=[0-9]*d[0-9]*h draft claude/issue-12: second.tPR -- CONVERGE: 6 review rounds with findings (flag at 5)" -- "$FW" prs o/r
grep -q "^o/r#7 rounds=2 ci=pending head=[01]m claude/issue-7: first PR$" <<<"$out" && ok "...a PR under the flag gets its line, no note, age from the newer of commit and creation" || ko "PR 7's line: $out"
grep -q "^o/r#9 rounds=? ci=absent head=[01]m claude/issue-9: -$" <<<"$out" && ok "...an unread count reads as ?, never as 0, and an unread commit date leaves the age to the creation time" || ko "PR 9's line: $out"
[ "$(grep -o '^o/r#[0-9]*' <<<"$out" | tr '\n' ' ')" = "o/r#7 o/r#9 o/r#12 " ] && ok "...in PR order" || ko "order: $out"
grep -q "rounds o/r#12 threshold=off" "$P/calls" && grep -q "^retry --read pr list --repo o/r --state open" "$P/calls" && ok "...through pr-review.sh, the repo spelled out in every read" || ko "calls: $(cat "$P/calls")"
expect "--flag-at raises the flag; an unread count alone exits 4" 4 "o/r#9 rounds=?" -- "$FW" prs o/r --flag-at 7
grep -q CONVERGE <<<"$out" && ko "a PR under --flag-at was flagged: $out" || ok "...and nothing is flagged under it"
expect "a list that reaches its cap says PRs past it are not shown, exit 4" 4 "PRS INCOMPLETE o/r: the list reached its cap of 3 open PRs" -- env FLEET_PRS_LIMIT=3 "$FW" prs o/r --flag-at 7
grep -q "^o/r#12 rounds=6" <<<"$out" && ok "...and still lists what it read" || ko "a capped list dropped its rows: $out"
# Only the trailers are read (ludics-lite#423): the prose may be reworded, and a trailer that is
# missing, malformed or at odds with the exit status reads as unknown -- never as green. The old
# scrape read a reworded ABSENT line under exit 0 as ci=green.
cp "$P/list.json" "$P/list-full.json"
jq '[.[] | select(.number == 9)]' "$P/list-full.json" > "$P/list.json"
probe() { # <rounds file> <checks file>: PR 9's line from those fixtures
  printf '%b' "$1" > "$P/rounds-9"; printf '%b' "$2" > "$P/checks-9"
  out=$("$FW" prs o/r 2>&1); rc=$?
}
probe '3\n' '0\nnothing ran on this commit -- x\n'
[ "$rc" -eq 4 ] && grep -q "^o/r#9 rounds=3 ci=unknown " <<<"$out" && ok "a reworded ABSENT line with no trailer is ci=unknown, exit 4, never green" || ko "no checks trailer (exit $rc): $out"
probe '3\n' '0\nnothing ran on this commit -- x\nchecks: verdict=absent\n'
[ "$rc" -eq 0 ] && grep -q "^o/r#9 rounds=3 ci=absent " <<<"$out" && ok "...and with its trailer it is ci=absent, whatever the prose says" || ko "reworded prose, absent trailer (exit $rc): $out"
probe '3\n' '0\ngreen -- 3 passed\nchecks: verdict=red\n'
[ "$rc" -eq 4 ] && grep -q "^o/r#9 rounds=3 ci=unknown " <<<"$out" && ok "a verdict its exit status cannot carry is ci=unknown" || ko "0:red (exit $rc): $out"
probe '3\n' '0\ngreen -- 3 passed\nchecks: verdict=green extra\n'
[ "$rc" -eq 4 ] && grep -q " ci=unknown " <<<"$out" && ok "a malformed checks trailer is ci=unknown" || ko "malformed checks trailer (exit $rc): $out"
probe '3\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n  a line after it\n'
[ "$rc" -eq 4 ] && grep -q " ci=unknown " <<<"$out" && ok "a checks trailer that is not the last line is not read" || ko "trailer not last (exit $rc): $out"
probe '3\n-\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n'
[ "$rc" -eq 4 ] && grep -q "^o/r#9 rounds=? ci=green " <<<"$out" && ok "a count with no rounds trailer is rounds=?, even under readable prose" || ko "no rounds trailer (exit $rc): $out"
probe '3\nrounds: n=6 threshold=off first=0\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n'
[ "$rc" -eq 1 ] && grep -q "^o/r#9 rounds=6 ci=green .*CONVERGE" <<<"$out" && ok "...and the count is the trailer's, not the prose's" || ko "trailer count (exit $rc): $out"
probe '3\nrounds: n=6 threshold=off\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n'
[ "$rc" -eq 4 ] && grep -q "^o/r#9 rounds=? " <<<"$out" && ok "a rounds trailer without round 1's size is not read" || ko "no first= (exit $rc): $out"
# ludics-lite#650: round 3 is due after a round 1 of five or more inline findings, round 5 otherwise.
probe '3\nrounds: n=3 threshold=off first=5\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n'
[ "$rc" -eq 1 ] && grep -q "^o/r#9 rounds=3 ci=green .* -- CONVERGE: 3 review rounds with findings after a round 1 of 5 (flag at 3 after 5 or more)" <<<"$out" && ok "a large round 1 is flagged at round 3" || ko "early flag (exit $rc): $out"
probe '3\nrounds: n=4 threshold=off first=4\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n'
[ "$rc" -eq 0 ] && ! grep -q CONVERGE <<<"$out" && ok "...and a smaller one waits for round 5" || ko "small round 1 (exit $rc): $out"
probe '3\nrounds: n=4 threshold=off first=unknown\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n'
[ "$rc" -eq 4 ] && grep -q "^o/r#9 rounds=4 ci=green " <<<"$out" && ! grep -q CONVERGE <<<"$out" && ok "...and an unread round 1 is exit 4, no flag" || ko "unread round 1 (exit $rc): $out"
probe '3\nrounds: n=6 threshold=12 first=0\n' '0\ngreen -- 3 passed\nchecks: verdict=green\n'
[ "$rc" -eq 4 ] && grep -q "^o/r#9 rounds=? " <<<"$out" && ok "a rounds trailer under a threshold prs did not ask for is not read" || ko "threshold mismatch (exit $rc): $out"
echo '{}' > "$P/list.json"
expect "an open-PR list of another shape is REFUSED, exit 1" 1 "^PRS REFUSED: the open-PR list of o/r did not parse" -- "$FW" prs o/r
rm "$P/list.json" "$P/list-full.json"
expect "an open-PR list that never answered is UNREACHABLE, exit 4" 4 "PRS UNREACHABLE: the open PRs of o/r did not answer" -- "$FW" prs o/r
expect "prs needs an owner/repo" 2 "prs: <owner/repo> required" -- "$FW" prs
expect "prs refuses a zero --flag-at" 2 "positive number of rounds" -- "$FW" prs o/r --flag-at 0
# --wave: the wave's issues are the ones its execution records name.
need_lease
jq -n --arg now "$now" '[{number: 7, title: "first PR", headRefName: "claude/issue-7", headRefOid: "c7", createdAt: $now, isDraft: false,
  closingIssuesReferences: [{number: 7, repository: {name: "other", owner: {login: "o"}}}]},
  {number: 12, title: "second", headRefName: "claude/issue-12", headRefOid: "c12", createdAt: $now, isDraft: false,
  closingIssuesReferences: [{number: 12, repository: {name: "r", owner: {login: "o"}}}]}]' > "$P/list.json"
jq -n '{request_id:"prs-7", wave:"wv", worker:"prs-7", transport:"subagent", issue:"o/other#7", purpose:"prs fixture",
  agent_host:"testbox", execution_host:"testbox", repository:"o/r", requested_revision:"origin/main", kind:"correctness", standing:true}' > "$TMP/prs-7.json"
env FLEET_BOXES="testbox other" "$FW" execution reserve "$TMP/prs-7.json" >/dev/null 2>&1 || ko "could not reserve prs-7 (setup)"
xref() { # <issue file suffix> <PR source repo> <number...>: one cross-reference page naming those PRs
  local f="$P/xref-$1" r="$2"; shift 2
  printf '%s\n' "$@" | jq -n --arg r "$r" '{data: {repository: {issue: {timelineItems: {pageInfo: {hasNextPage: false, endCursor: null},
    nodes: ([inputs | {source: {__typename: "PullRequest", number: tonumber, repository: {nameWithOwner: $r}}}] + [{source: {__typename: "Issue"}}])}}}}}' > "$f"
}
xref o-other-7 o/elsewhere 12
: > "$P/calls"
expect "--wave keeps the PRs closing an issue its records name" 0 "^o/r#7 rounds=2" -- "$FW" prs o/r --wave wv
grep -q "o/r#12" <<<"$out" && ko "a PR of no wave issue was listed: $out" || ok "...and drops the rest, a PR of another repository referencing the issue included"
grep -q "^retry --read api graphql --paginate -f query=.*CROSS_REFERENCED_EVENT.* -f owner=o -f name=other -F number=7 " "$P/calls" && [ "$(grep -c graphql "$P/calls")" = 1 ] \
  && ok "...through one cross-reference read of the wave issue" || ko "cross-reference calls: $(grep graphql "$P/calls")"
# A wave PR for one item of a multi-item issue says `Refs #N` and closes nothing (lukstafi/ludics-lite#655).
xref o-other-7 O/R 12
expect "--wave keeps a PR that only references a wave issue" 0 "^o/r#12 rounds=6 " -- "$FW" prs o/r --wave wv --flag-at 7
grep -q "^o/r#7 rounds=2" <<<"$out" && ok "...beside the one closing it" || ko "the closing PR went missing: $out"
printf 'exit 3\n' > "$P/xref-o-other-7"
expect "a cross-reference read that does not answer is UNREACHABLE, exit 4, never a silently narrower list" 4 "^PRS UNREACHABLE: the cross-references of o/other#7 did not answer" -- "$FW" prs o/r --wave wv --flag-at 7
grep -q "^o/r#7 rounds=2" <<<"$out" && ok "...and still lists the PR it can name" || ko "the closing PR went missing: $out"
printf 'exit 1\n' > "$P/xref-o-other-7"
expect "a refused cross-reference read is REFUSED, exit 1" 1 "^PRS REFUSED: the cross-references of o/other#7 were refused (pr-review.sh exit 1)" -- "$FW" prs o/r --wave wv --flag-at 7
printf '{"data": {"repository": {"issue": null}}}\n' > "$P/xref-o-other-7"
expect "a cross-reference page of another shape is REFUSED, exit 1" 1 "^PRS REFUSED: the cross-references of o/other#7 did not parse" -- "$FW" prs o/r --wave wv --flag-at 7
jq '[.[] | select(.number == 7)]' "$P/list.json" > "$P/list-7.json" && mv "$P/list-7.json" "$P/list.json"
: > "$P/calls"
expect "with every open PR kept by its closing references, nothing more is read" 0 "^o/r#7 rounds=2" -- "$FW" prs o/r --wave wv
grep -q graphql "$P/calls" && ko "a cross-reference read with nothing to find: $(cat "$P/calls")" || ok "...no cross-reference read"
expect "--wave with no records is refused, not read as an empty wave" 1 "no execution record names wave nowave" -- "$FW" prs o/r --wave nowave
fixture_done prs-7
unset SHIM_PRS
}

section "refresh (execution-only boxes)" && {
need_lease
# ludics-lite#362: only launch and preflight fast-forwarded a box's skills checkout, so a box the
# fleet only EXECUTES on kept a stale one (tuf lacked `execution hold`). `refresh` is the
# preflight's own freshness function alone, and a cross-box `execution run`/`dispatch` runs it on
# the execution host after the dispatch. `other` is the second box: SHIM_SSH_LOCAL runs its far
# side here, against the same scratch checkout.
git -C "$repo" fetch -q origin && git -C "$repo" merge --ff-only -q origin/main || ko "could not bring the scratch checkout current (setup)"
upstream() { # <line>: advance the scratch origin by one commit, from a clone of its own
  [ -d "$TMP/refresh-up" ] || git clone --no-local -q -b main "$origin" "$TMP/refresh-up"
  git -C "$TMP/refresh-up" pull -q --ff-only origin main && echo "$1" >> "$TMP/refresh-up/ship-pr/SKILL.md" \
    && git -C "$TMP/refresh-up" commit -q -am "$1" && git -C "$TMP/refresh-up" push -q origin main \
    || ko "could not advance the scratch origin (setup)"
}
rreq() { # <id> [execution host] -> a reservation payload, on `other` unless named
  jq -n --arg id "$1" --arg host "${2:-other}" '{request_id:$id, wave:"w", worker:$id, transport:"subagent", issue:"o/r#362", purpose:"refresh fixture",
    agent_host:"testbox", execution_host:$host, repository:"o/r", requested_revision:"origin/main", kind:"correctness"}' > "$TMP/refresh-$1.json"
  printf '%s' "$TMP/refresh-$1.json"
}
FWR=(env FLEET_BOXES="testbox other" SHIM_SSH_LOCAL=other "$FW")
cur=$(git -C "$repo" rev-parse HEAD)
expect "a current checkout reports already current" 0 "^REFRESH OK testbox skills=${cur:0:9} (already current)$" -- "$FW" refresh testbox
upstream stale-1
expect "a stale checkout is fast-forwarded, and says from where" 0 "^REFRESH OK testbox skills=[0-9a-f]* (fast-forwarded from ${cur:0:9})$" -- "$FW" refresh testbox
[ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$TMP/refresh-up" rev-parse HEAD)" ] && ok "...to origin/main" || ko "refresh did not bring the checkout to origin/main"
upstream stale-2; cur=$(git -C "$repo" rev-parse HEAD)
echo local-fix >> "$repo/issue-wave/SKILL.md"
expect "a divergent checkout is reported, not refreshed" 1 "^REFRESH FAILED testbox: 1 local change(s) in the served tree -- left as it is, never reset" -- "$FW" refresh testbox
[ "$(git -C "$repo" rev-parse HEAD)" = "$cur" ] && grep -q local-fix "$repo/issue-wave/SKILL.md" && ok "...and left exactly as it was: HEAD and the local edit" || ko "a divergent checkout was moved or reset"
git -C "$repo" checkout -q -- issue-wave/SKILL.md
expect "a stalling fetch is bounded by FLEET_REFRESH_TIMEOUT and reported" 1 "REFRESH FAILED testbox: git fetch in .* timed out after 2s" -- env SHIM_GIT_HANG_FETCH=1 FLEET_REFRESH_TIMEOUT=2 "$FW" refresh testbox
[ -d "$repo/.git/fleet-checkout.lock" ] && ko "refresh left the checkout's lock behind" || ok "...and releases the lock it shares with the preflight"
# The lock is the checkout's own, in its git directory, so a caller under another ISSUE_WAVE_STATE
# (the sweep beside a wave) meets it too. A holder may yet fail, so a busy lock is waited out and
# the checkout then checked here; one never freed in time is a failure, not a pass.
hold_checkout_lock() { # <seconds>: a live holder of the checkout's lock, as take_lock records one
  sleep "$1" & lockholder=$!
  mkdir "$repo/.git/fleet-checkout.lock" && ps -o lstart= -p "$lockholder" | tr -s ' ' > "$repo/.git/fleet-checkout.lock/start" \
    && echo "$lockholder" > "$repo/.git/fleet-checkout.lock/pid" || ko "could not plant the lock holder (setup)"
}
upstream stale-lock; cur=$(git -C "$repo" rev-parse HEAD)
hold_checkout_lock 3
expect "a refresh waits out a holder that finishes, then checks the checkout itself" 0 "^REFRESH OK testbox skills=[0-9a-f]* (fast-forwarded from ${cur:0:9})$" -- \
  env ISSUE_WAVE_STATE="$TMP/sweep-state" FLEET_REFRESH_TIMEOUT=15 "$FW" refresh testbox
wait "$lockholder" 2>/dev/null
hold_checkout_lock 60
expect "a holder that outlasts the bound fails the refresh, whatever the caller's state directory" 1 "^REFRESH FAILED testbox: lock .*fleet-checkout.lock held by pid $lockholder for 2s" -- \
  env ISSUE_WAVE_STATE="$TMP/sweep-state" FLEET_REFRESH_TIMEOUT=2 "$FW" refresh testbox
kill "$lockholder" 2>/dev/null; wait "$lockholder" 2>/dev/null; rm -rf "$repo/.git/fleet-checkout.lock"
expect "a box that does not answer is unreachable (exit 4), not failed" 4 "^REFRESH UNREACHABLE other: its skills checkout was not checked" -- env FLEET_BOXES="testbox other" "$FW" refresh other
expect "several boxes: one line each, and a failure outranks an unreachable box" 1 "REFRESH UNREACHABLE other" -- env FLEET_BOXES="testbox other" SHIM_GIT_HANG_FETCH=1 FLEET_REFRESH_TIMEOUT=1 "$FW" refresh other testbox
grep -q "^REFRESH FAILED testbox" <<<"$out" && ok "...with the failed box's own line" || ko "multi-box refresh lost a line: $out"
expect "refresh needs a box" 2 "refresh: which box" -- "$FW" refresh
# The execution path. The checkout is stale again; a dispatch to `other` refreshes it, on stderr,
# with the record alone on stdout and the dispatch's own status.
upstream stale-3; cur=$(git -C "$repo" rev-parse HEAD)
"${FWR[@]}" execution run "$(rreq rf-a)" > "$TMP/rf-a.out" 2> "$TMP/rf-a.err"; rc=$?
[ "$rc" -eq 0 ] && jq -e '.state == "launching"' "$TMP/rf-a.out" >/dev/null && ok "a cross-box execution run dispatches, with only the record on stdout" || ko "cross-box run: rc=$rc $(cat "$TMP/rf-a.out" "$TMP/rf-a.err")"
grep -q "^REFRESH OK other skills=[0-9a-f]* (fast-forwarded from ${cur:0:9})$" "$TMP/rf-a.err" && ok "...and fast-forwards the execution host's skills checkout, reported on stderr" || ko "cross-box run did not refresh: $(cat "$TMP/rf-a.err")"
fixture_done rf-a
expect "a refused dispatch never touches the execution host" 1 "already dispatched" -- "${FWR[@]}" execution run "$(rreq rf-a)"
grep -q REFRESH <<<"$out" && ko "a refused run refreshed the box: $out" || ok "...(no refresh line)"
upstream stale-4; cur=$(git -C "$repo" rev-parse HEAD)
expect "a run on the anchor and local box refreshes it too (no launch need have preflighted it)" 0 "REFRESH OK testbox skills=[0-9a-f]* (fast-forwarded from ${cur:0:9})" -- "${FWR[@]}" execution run "$(rreq rf-b testbox)"
upstream stale-4b; cur=$(git -C "$repo" rev-parse HEAD)
fixture_done rf-b
echo local-fix >> "$repo/issue-wave/SKILL.md"
expect "a divergent execution host is reported and the dispatch still stands" 0 "REFRESH FAILED other: 1 local change(s) in the served tree -- left as it is, never reset" -- "${FWR[@]}" execution run "$(rreq rf-c)"
[ "$(git -C "$repo" rev-parse HEAD)" = "$cur" ] && grep -q local-fix "$repo/issue-wave/SKILL.md" && ok "...with the checkout left as it was" || ko "a divergent execution host was moved or reset"
git -C "$repo" checkout -q -- issue-wave/SKILL.md; fixture_done rf-c
# A dispatch whose record cannot be read says so, rather than skipping the refresh silently. Not a
# case here: the registry's own output is the record, so no command line makes it unreadable, and
# the shell's version of this case broke the reader by putting a failing `jq` first on PATH, which
# tests the implementation's tool rather than the command (ludics-lite#403). The rule is pinned
# where the reader is: lib/ludics/tests/test_fleetworker_execution.py.
# The reserve + dispatch pair refreshes at the dispatch, which is where the box is about to be used.
"${FWR[@]}" execution reserve "$(rreq rf-d)" 2>&1 | grep -q REFRESH && ko "a bare reserve refreshed the box" || ok "a bare reserve does not refresh"
jq -n '{request_id:"rf-d", evidence:"fixture dispatch"}' > "$TMP/refresh-rf-d-dispatch.json"
expect "...its dispatch does" 0 "REFRESH OK other skills=[0-9a-f]* (fast-forwarded from ${cur:0:9})" -- "${FWR[@]}" execution dispatch "$TMP/refresh-rf-d-dispatch.json"
fixture_done rf-d
# The refresh runs after the registry's lock is released: a fetch that hangs on the execution host
# must not keep other coordinator mutations out. While it hangs, a mutation with no lock wait at
# all goes through (a record on the same request, so no slot is in question).
upstream stale-5
env SHIM_GIT_HANG_FETCH=1 FLEET_REFRESH_TIMEOUT=6 "${FWR[@]}" execution run "$(rreq rf-e)" > "$TMP/rf-e.out" 2> "$TMP/rf-e.err" &
hung=$!
for _ in $(seq 40); do grep -q '"state": "launching"' "$TMP/rf-e.out" 2>/dev/null && break; sleep 0.25; done
jq -n '{request_id:"rf-e", state:"running", evidence:"fixture: recorded while the refresh hangs"}' > "$TMP/refresh-rf-e-record.json"
expect "while the refresh's fetch hangs, the registry lock is free" 0 '"state": "running"' -- env FLEET_LOCK_WAIT=0 "${FWR[@]}" execution record "$TMP/refresh-rf-e-record.json"
kill -0 "$hung" 2>/dev/null && ok "...(the refresh was still running)" || ko "the hanging refresh had already ended; the lock check proved nothing"
wait "$hung"; rc=$?
[ "$rc" -eq 0 ] && grep -q "REFRESH FAILED other: git fetch in .* timed out after 6s" "$TMP/rf-e.err" && ok "...and the bounded fetch is reported, the dispatch standing" || ko "hung refresh: rc=$rc $(cat "$TMP/rf-e.err")"
fixture_done rf-e
git -C "$repo" fetch -q origin && git -C "$repo" merge --ff-only -q origin/main || ko "could not leave the scratch checkout current (teardown)"
}

section "execution slot" && {
need_lease
# The run-time half of the correctness cap (ludics-lite#160): the registry record is ownership,
# the flock here is what actually bounds concurrent load on the box. testbox has one slot unless
# the spec says otherwise, and every holder below is killed before the section ends.
FWS=(env FLEET_BOXES="testbox other" "$FW")
FWS2=(env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=2" "$FW")
# held <log> <pattern>: wait until a background holder has announced the slot it took. The line
# is written after the flock succeeded, so seeing it proves the lock is held, not merely asked for.
held() {
  local i
  for i in $(seq 40); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 1; done
  ko "no holder announced $2 in $1: $(cat "$1" 2>/dev/null)"; return 1
}
# THE GROUP's fixtures (ludics-lite#566) each sleep with an argument of this run's own,
# 45.566<suite pid><n>, so a check for leftovers cannot see a sibling's processes, nor another case's.
# Every case ends its sleep within 5 s when correct, and none needs it to outlive more than that, so
# 45 s caps what a group-kill regression costs a case, where 600 s once made a run 828 s for 75.
GM="45.566$$"
# gmre <n>: the pgrep pattern (an ERE) for marker <n>'s sleep, its dot escaped and its END anchored
# (a non-digit or the end of the command line), so marker 1 is not a prefix of marker 10's.
gmre() { printf '%s' "sleep ${GM%%.*}\\.${GM#*.}$1([^0-9]|\$)"; }
# swept <n>: no process of marker <n> is left, within 5 s.
swept() {
  local i
  for i in $(seq 50); do pgrep -f "$(gmre "$1")" >/dev/null 2>&1 || return 0; sleep 0.1; done
  return 1
}
# The anchor's own case: a live marker 11 is not marker 1's, which the unanchored `sleep $GM1`
# reported (a prefix match), so the next marker added could pass or fail a case for the wrong reason.
sleep "${GM}11" &
gm11=$!
for gmi in $(seq 50); do pgrep -f "$(gmre 11)" >/dev/null 2>&1 && break; sleep 0.1; done
if ! pgrep -f "$(gmre 11)" >/dev/null 2>&1; then ko "the marker-11 fixture never showed: $(pgrep -fl "sleep ${GM}")"
elif swept 1; then ok "swept 1 does not report a live marker 11"
else ko "swept 1 reported marker 11 as marker 1's: $(pgrep -fl "sleep ${GM}1")"
fi
kill "$gm11" 2>/dev/null; wait "$gm11" 2>/dev/null
slotreq() { # <id> <kind> [standing] [host] -> a reservation payload file on host (agent and execution), default testbox
  jq -n --arg id "$1" --arg kind "$2" --argjson standing "${3:-false}" --arg host "${4:-testbox}" \
    '{request_id:$id, wave:"w", worker:$id, transport:"subagent", issue:"o/r#1", purpose:"slot fixture",
      agent_host:$host, execution_host:$host, repository:"o/r", requested_revision:"origin/master",
      kind:$kind} + (if $standing then {standing:true} else {} end)' > "$TMP/slot-$1.json"
  printf '%s' "$TMP/slot-$1.json"
}
expect "a batch runs under one of the box's run-time slots" 0 "EXECUTION SLOT testbox: slot 1 of 1 held for: echo batch-ran" -- "${FWS[@]}" execution slot -- echo batch-ran
grep -q batch-ran <<<"$out" && ok "...and the command's own output came through" || ko "the wrapped command's output was lost: $out"
expect "...and the wrapped command's own status is what the slot call returns" 3 "slot 1 of 1" -- "${FWS[@]}" execution slot -- sh -c 'exit 3'
expect "a command that cannot be run is a refusal, not a held slot" 127 "cannot run /nonexistent/runner" -- "${FWS[@]}" execution slot -- /nonexistent/runner
expect "...and the slot it never took is still free" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo still-free
"${FWS[@]}" execution slot -- sleep 30 > "$TMP/slot-h0.log" 2>&1 &
h0=$!
held "$TMP/slot-h0.log" "slot 1 of 1 held" &&
  expect "a second batch is refused while the box's only run-time slot is held" 1 "all 1 run-time correctness slots busy after 0s" -- "${FWS[@]}" execution slot --wait 0 -- echo second
# The lock is the kernel's, held on an open descriptor the batch inherits, so there is no lock file
# to strand: killing the batch's wrapper outright -- what a cancelled or stuck suite gets -- frees
# the slot, once its guardian has killed the batch's process group (ludics-lite#566), so the next
# batch may wait a moment for it.
kill -9 "$h0" 2>/dev/null; wait "$h0" 2>/dev/null
expect "a killed batch frees its slot (the kernel holds the lock, not a file)" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 5 -- echo after-kill
"${FWS2[@]}" execution slot -- sleep 30 > "$TMP/slot-h1.log" 2>&1 &
h1=$!
"${FWS2[@]}" execution slot -- sleep 30 > "$TMP/slot-h2.log" 2>&1 &
h2=$!
if held "$TMP/slot-h1.log" "held" && held "$TMP/slot-h2.log" "held"; then
  grep -q "slot 2 of 2 held" "$TMP/slot-h1.log" "$TMP/slot-h2.log" && ok "two batches run side by side on a two-slot box" || ko "the second batch did not take the second slot"
  expect "...and a third waits for the deadline, then is refused" 1 "all 2 run-time correctness slots busy after 1s" -- "${FWS2[@]}" execution slot --wait 1 -- echo third
fi
kill -9 "$h1" "$h2" 2>/dev/null; wait "$h1" 2>/dev/null; wait "$h2" 2>/dev/null
expect "the widened cap is read from FLEET_BOX_CORRECTNESS_SLOTS, not baked in" 0 "slot 1 of 2" -- "${FWS2[@]}" execution slot --wait 5 -- echo widened
# A measurement owns the box through the registry, and the run-time lock reads that before locking.
"${FWS[@]}" execution run "$(slotreq slot-measure measurement)" >/dev/null || ko "could not reserve the measurement (setup)"
expect "a batch is refused while a measurement is outstanding on the box" 1 "a measurement holds the box exclusively (slot-measure)" -- "${FWS[@]}" execution slot -- echo during-measurement
fixture_done slot-measure
expect "...and admitted once the measurement is concluded" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo after-measurement
# The standing iteration record is ownership and evidence for the worker's whole life, so it
# does not consume the box's one correctness slot -- an agent start is never gated on it.
expect "a standing iteration reservation is admitted" 0 '"standing": true' -- "${FWS[@]}" execution run "$(slotreq slot-iterate correctness true)"
expect "...and leaves the box's correctness slot free for an ordinary reservation" 0 '"state": "launching"' -- "${FWS[@]}" execution run "$(slotreq slot-ordinary correctness)"
expect "...which does fill it: the next ordinary reservation is refused" 1 "correctness slots 1/1 on testbox" -- "${FWS[@]}" execution run "$(slotreq slot-ordinary-2 correctness)"
expect "...while another standing record is still admitted" 0 '"standing": true' -- "${FWS[@]}" execution run "$(slotreq slot-iterate-2 correctness true)"
expect "a batch still takes a run-time slot beside them" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo beside-standing
fixture_done slot-iterate; fixture_done slot-iterate-2; fixture_done slot-ordinary
# The cap is the BOX's, so the slot files must not hang off ISSUE_WAVE_STATE, which is each
# coordinator's own directory: two workers on one host under different coordinators would each
# take slot 1 and the cap would bound nothing (PR #166 review, round 1).
env ISSUE_WAVE_STATE="$TMP/other-coordinator-state" FLEET_BOXES="testbox other" "$FW" execution slot -- sleep 30 > "$TMP/slot-h3.log" 2>&1 &
h3=$!
held "$TMP/slot-h3.log" "slot 1 of 1 held" &&
  expect "a batch under another coordinator's state contends for the same box slot" 1 "all 1 run-time correctness slots busy after 0s" -- "${FWS[@]}" execution slot --wait 0 -- echo other-state
kill -9 "$h3" 2>/dev/null; wait "$h3" 2>/dev/null
[ -e "$HOME/.local/state/fleet-execution-slots/testbox/slot.1" ] && ok "...because the locks live in the box-wide slot directory, not the coordinator's" || ko "the slot lock is not in the box-wide directory"
expect "FLEET_SLOT_STATE relocates that directory" 0 "slot 1 of 1" -- \
  env FLEET_SLOT_STATE="$TMP/slot state" FLEET_BOXES="testbox other" "$FW" execution slot --wait 0 -- echo relocated
[ -e "$TMP/slot state/testbox/slot.1" ] && ok "...to where it says" || ko "FLEET_SLOT_STATE did not move the lock files"
# A local name outside the roster would lock under a spelling of its own while reading the
# registry for that spelling too, so a batch could run beside a measurement on the canonical one.
expect "a local box outside FLEET_BOXES is refused, as the registry refuses a noncanonical host" 1 "not a canonical FLEET_BOXES entry" -- \
  env FLEET_LOCAL_BOX=testbox-alias FLEET_BOXES="testbox other" "$FW" execution slot -- echo alias
# The registry parses the spec into a dict, so a repeated box keeps its LAST value; a first-match
# read here would run six batches against a registry that admits one.
expect "a repeated box in the spec reads as its last value, as the registry reads it" 0 "slot 1 of 1" -- \
  env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=6 testbox=1" "$FW" execution slot --wait 0 -- echo last-wins
expect "...and a malformed later entry is still refused" 1 "<box>=<positive n>" -- \
  env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=2 other=0" "$FW" execution slot -- echo bad-tail
expect "...and a spec naming a box outside the roster, as the registry refuses it" 1 "names stale-box, which is not in FLEET_BOXES" -- \
  env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=2 stale-box=1" "$FW" execution slot -- echo stale-spec
# A wrapper must not change a batch's verdict: Python ignores SIGPIPE and an ignored disposition
# survives exec, so without the reset the pipeline below exits 1 with a "Broken pipe" line.
expect "a pipeline under the slot dies of SIGPIPE exactly as it does unwrapped" 141 "slot 1 of 1" -- \
  "${FWS[@]}" execution slot -- bash -c 'set -o pipefail; yes | head -n1 >/dev/null'
grep -q "Broken pipe" <<<"$out" && ko "the wrapped pipeline reported a broken pipe the bare one does not" || ok "...and without the diagnostic the bare pipeline never prints"
# The site default, the number the references quote: six on mac-studio (ludics-lite#160), the
# measured counts on the native GPU boxes (ludics-lite#316, #344), and one anywhere the spec does not name -- which is every box under a custom FLEET_BOXES.
# The default applies whenever the roster IS the default one (ludics-lite#329): on 2026-09-22 every
# box's env.sh began exporting FLEET_BOXES with exactly the default boxes, and a test on the
# variable's presence dropped mac-studio to one slot for a day. Each case sets or unsets both
# variables itself.
DEFROSTER="mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux"
FWM=(env FLEET_LOCAL_BOX=mac-studio FLEET_ANCHOR=mac-studio)
expect "the site default gives mac-studio six run-time slots" 0 "slot 1 of 6" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS -u FLEET_BOXES "${FWM[@]}" "$FW" execution slot --wait 0 -- echo default-cap
# The native GPU boxes' measured counts (ludics-lite#316, #344, #391): four on rog-nv-linux, of
# which two hold a GPU token, four on minix-amd-linux, three on tuf-amd-linux. Each box is its own
# anchor here, so the registry read stays local.
for pair in rog-nv-linux:4 minix-amd-linux:4 tuf-amd-linux:3; do
  box=${pair%%:*} n=${pair#*:}
  expect "...and $box $n" 0 "slot 1 of $n" -- \
    env -u FLEET_BOX_CORRECTNESS_SLOTS -u FLEET_BOXES FLEET_LOCAL_BOX=$box FLEET_ANCHOR=$box "$FW" execution slot --wait 0 -- echo default-cap
done
expect "...and so does an exported roster equal to the default (the 2026-09-22 shape)" 0 "slot 1 of 6" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS "${FWM[@]}" FLEET_BOXES="$DEFROSTER" "$FW" execution slot --wait 0 -- echo exported-default
expect "...or the default boxes in another order and spacing (a word set, not a string)" 0 "slot 1 of 6" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS "${FWM[@]}" FLEET_BOXES="  tuf-amd-linux mac-studio   minix-amd-linux rog-nv-linux " "$FW" execution slot --wait 0 -- echo reordered-default
expect "...or the default boxes over several lines (every line is read, not the first)" 0 "slot 1 of 6" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS "${FWM[@]}" FLEET_BOXES="mac-studio rog-nv-linux
minix-amd-linux
tuf-amd-linux" "$FW" execution slot --wait 0 -- echo multiline-default
expect "a box on a later line of the roster is in it, and a spec may name it" 0 "slot 1 of 2" -- \
  env FLEET_LOCAL_BOX=testbox FLEET_BOXES="other
testbox" FLEET_BOX_CORRECTNESS_SLOTS="other=1
testbox=2" "$FW" execution slot --wait 0 -- echo multiline-roster
expect "a custom roster still gives mac-studio one slot" 0 "slot 1 of 1" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS "${FWM[@]}" FLEET_BOXES="mac-studio rog-nv-linux" "$FW" execution slot --wait 0 -- echo custom-roster
expect "an explicit spec overrides the default under an unset roster" 0 "slot 1 of 2" -- \
  env -u FLEET_BOXES "${FWM[@]}" FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=2" "$FW" execution slot --wait 0 -- echo explicit-unset-roster
expect "...and under an exported default roster" 0 "slot 1 of 3" -- \
  "${FWM[@]}" FLEET_BOXES="$DEFROSTER" FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=3" "$FW" execution slot --wait 0 -- echo explicit-default-roster
expect "...where an explicitly empty spec is one slot everywhere" 0 "slot 1 of 1" -- \
  "${FWM[@]}" FLEET_BOXES="$DEFROSTER" FLEET_BOX_CORRECTNESS_SLOTS="" "$FW" execution slot --wait 0 -- echo explicit-empty
expect "...and under a custom roster" 0 "slot 1 of 4" -- \
  "${FWM[@]}" FLEET_BOXES="mac-studio rog-nv-linux" FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=4" "$FW" execution slot --wait 0 -- echo explicit-custom
expect "...and a box the spec does not name has one" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo unnamed-box
# The GPU tokens (ludics-lite#391): where a box has fewer than its slots, the first N slot files
# are the tokens. Fail-closed: every batch is a GPU batch unless it declares --cpu.
expect "the site default gives rog-nv-linux two GPU tokens among its four slots" 0 "slot 1 of 4, GPU token 1 of 2 held" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS -u FLEET_BOXES FLEET_LOCAL_BOX=rog-nv-linux FLEET_ANCHOR=rog-nv-linux "$FW" execution slot --wait 0 -- echo default-tokens
expect "...and a batch declared --cpu takes the highest free slot there, not a token" 0 "slot 4 of 4 held" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS -u FLEET_BOXES FLEET_LOCAL_BOX=rog-nv-linux FLEET_ANCHOR=rog-nv-linux "$FW" execution slot --wait 0 --cpu -- echo default-cpu
expect "a box with as many tokens as slots is unchanged (the tokens cannot bind there)" 0 "slot 1 of 6 held" -- \
  env -u FLEET_BOX_CORRECTNESS_SLOTS -u FLEET_BOXES "${FWM[@]}" "$FW" execution slot --wait 0 --cpu -- echo mac-no-token
grep -q "GPU token" <<<"$out" && ko "mac-studio named a GPU token -- $out" || ok "...(no token named)"
FWT=(env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=3" FLEET_BOX_GPU_TOKENS="testbox=1" "$FW")
"${FWT[@]}" execution slot -- sleep 30 > "$TMP/slot-g1.log" 2>&1 &
g1=$!
if held "$TMP/slot-g1.log" "slot 1 of 3, GPU token 1 of 1 held"; then
  expect "an undeclared batch waits for the token though slots are free (fail-closed)" 1 "all 1 GPU tokens (slots 1-1 of 3) busy after 1s" -- "${FWT[@]}" execution slot --wait 1 -- echo undeclared
  expect "...and so does one declared --gpu" 1 "all 1 GPU tokens" -- "${FWT[@]}" execution slot --wait 0 --gpu -- echo declared
  # A GPU batch queued behind the token must not sit on a slot meanwhile: start one waiting, and
  # the CPU batches still find both slots left beside the holder. It polls once a second, so two
  # seconds put it well inside its loop first.
  "${FWT[@]}" execution slot --wait 20 -- echo queued-gpu > "$TMP/slot-g2.log" 2>&1 &
  g2=$!
  sleep 2
  "${FWT[@]}" execution slot --cpu -- sleep 30 > "$TMP/slot-c1.log" 2>&1 &
  c1=$!
  if held "$TMP/slot-c1.log" "slot 3 of 3 held"; then
    expect "CPU batches run beside the token holder, and a queued GPU batch holds no slot" 0 "slot 2 of 3 held for: echo cpu-beside" -- "${FWT[@]}" execution slot --wait 0 --cpu -- echo cpu-beside
  fi
  kill -9 "$g1" 2>/dev/null; wait "$g1" 2>/dev/null
  wait "$g2"; rc=$?
  [ "$rc" -eq 0 ] && grep -q "GPU token 1 of 1 held for: echo queued-gpu" "$TMP/slot-g2.log" \
    && ok "...and the queued GPU batch takes the token once it is released" || ko "the queued GPU batch did not run: rc=$rc $(cat "$TMP/slot-g2.log")"
  kill -9 "$c1" 2>/dev/null; wait "$c1" 2>/dev/null
fi
kill -9 "$g1" 2>/dev/null; wait "$g1" 2>/dev/null
# Safe across the switch: a batch started by the version before the tokens took the first free of
# the box's slots, which is a token slot now, so it is counted without knowing it. Here the old
# script's shape is a one-slot spec on the same directory.
env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=1" "$FW" execution slot -- sleep 30 > "$TMP/slot-old.log" 2>&1 &
o1=$!
held "$TMP/slot-old.log" "slot 1 of 1 held" &&
  expect "a batch holding slot 1 under the old count is a GPU token to the new one" 1 "all 1 GPU tokens" -- "${FWT[@]}" execution slot --wait 0 -- echo after-switch
kill -9 "$o1" 2>/dev/null; wait "$o1" 2>/dev/null
# THE PROBE (ahrefs/ocannl#1004): a project runner asks what a slot here would be before taking
# one itself; it takes nothing and reads no registry.
expect "the probe names the box, its slots and its GPU tokens" 0 "^EXECUTION SLOT PROBE testbox 3 1$" -- \
  "${FWT[@]}" execution slot --probe
expect "...and a box whose tokens do not bind has one per slot" 0 "^EXECUTION SLOT PROBE testbox 1 1$" -- \
  "${FWS[@]}" execution slot --probe
"${FWS[@]}" execution slot -- sleep 30 > "$TMP/slot-p1.log" 2>&1 &
p1=$!
held "$TMP/slot-p1.log" "slot 1 of 1 held" &&
  expect "...and it answers while every slot is held (it takes none)" 0 "^EXECUTION SLOT PROBE testbox 1 1$" -- \
    "${FWS[@]}" execution slot --probe
kill -9 "$p1" 2>/dev/null; wait "$p1" 2>/dev/null
# THE HOLDERS (ludics-lite#639): who holds the box's slots, one JSON line per held slot with its kind,
# read from the flocks -- the holder from /proc/locks where the box has one (Linux), and elsewhere
# named unknown in a field. A GPU batch holds the token (slot 1 of 3), a --cpu one the top slot; each
# wrapper keeps its pid through every exec, so $! is the lock's holder.
"${FWT[@]}" execution slot -- sleep 30 > "$TMP/slot-w1.log" 2>&1 &
w1=$!
"${FWT[@]}" execution slot --cpu -- sleep 30 > "$TMP/slot-w2.log" 2>&1 &
w2=$!
if held "$TMP/slot-w1.log" "slot 1 of 3, GPU token 1 of 1 held" && held "$TMP/slot-w2.log" "slot 3 of 3 held"; then
  expect "--holders lists the two held slots" 0 '"event":"held"' -- "${FWT[@]}" execution slot --holders
  kinds=$(jq -r '"\(.slot) \(.kind) \(.slots) \(.box)"' <<<"$out" 2>/dev/null | tr '\n' ' ')
  [ "$kinds" = "1 gpu 3 testbox 3 cpu 3 testbox " ] && ok "...with their kinds: the GPU token and the --cpu batch's slot" \
    || ko "--holders listed '$kinds', want slot 1 gpu and slot 3 cpu -- $out"
  if [ -r /proc/locks ]; then
    who=$(jq -r '"\(.slot) \(.source) \(.pid) \(.unknown | length) \(.command | test("sleep 30")) \(.cwd != null)"' <<<"$out" 2>/dev/null | tr '\n' ' ')
    [ "$who" = "1 proc-locks $w1 0 true true 3 proc-locks $w2 0 true true " ] && ok "...each with its holder's pid, command and cwd read from /proc/locks" \
      || ko "--holders did not name the holders $w1 and $w2 from /proc/locks: '$who' -- $out"
  else
    who=$(jq -r '"\(.source) \(.pid) \(.unknown | keys | join(","))"' <<<"$out" 2>/dev/null | sort -u | tr '\n' ' ')
    [ "$who" = "flock-test null command,cwd,pid,user " ] && ok "...and with no /proc/locks, each holder's fields null and named in unknown" \
      || ko "--holders without /proc/locks said '$who' -- $out"
  fi
fi
kill -9 "$w1" "$w2" 2>/dev/null; wait "$w1" 2>/dev/null; wait "$w2" 2>/dev/null
for wi in $(seq 50); do out=$("${FWT[@]}" execution slot --holders 2>&1); [ -z "$out" ] && break; sleep 0.1; done
[ -z "$out" ] && ok "--holders lists nothing once the batches are gone" || ko "--holders still lists holders after the kill -- $out"
expect "--holders takes no other word" 2 "--holders takes no other word" -- "${FWT[@]}" execution slot --holders --cpu
expect "a host with no fleet name has no probe answer" 2 "this host has no fleet name" -- \
  env FLEET_LOCAL_BOX= FLEET_BOXES="testbox other" "$FW" execution slot --probe
# THE PROBE WITHOUT PYTHON: any answer but the PROBE line sends a project runner on without a
# slot, so the probe needs no Python >= 3.12 (scripts/py's probe finds none here).
printf '#!/bin/sh\nexit 1\n' > "$TMP/no-python"; chmod +x "$TMP/no-python"
expect "the probe answers on a box with no Python >= 3.12" 0 "^EXECUTION SLOT PROBE testbox 3 1$" -- \
  env LUDICS_PY_CANDIDATES="$TMP/no-python" "${FWT[@]}" execution slot --probe
expect "...and says the spec's own counts" 0 "^EXECUTION SLOT PROBE testbox 007 007$" -- \
  env FLEET_BOX_CORRECTNESS_SLOTS="testbox=007" "${FWS[@]}" execution slot --probe
expect "...and a non-probe still needs one (scripts/py's refusal, exit 2)" 2 "no Python >= 3.12 found" -- \
  env LUDICS_PY_CANDIDATES="$TMP/no-python" "${FWS[@]}" execution slot --wait 0 -- echo no-python
# THE PROBE'S WORDS (fleet-worker.sh): the shell answers a probe line exactly when Python's
# parse_slot and probe answer it, and with Python's line; every other line is Python's to refuse.
# The oracle is Python itself (scripts/py -m ludics.fleetworker, run directly, so the shell's
# answer cannot stand in for it); the shell's side runs with no Python >= 3.12, where a line it does
# not recognize gets scripts/py's refusal. The words tried are a superset that the oracle judges:
# every `--word` in SLOT_USAGE (Python's side; an option parse_slot takes but its usage text does
# not name is outside this pin) and every `--word` in the text of fleet-worker.sh's fw_is_probe,
# from its `fw_is_probe() {` line to the first lone `}` (the shell's side; a word spelled there only
# through a variable, or a glob label its own literal prefix does not match, is outside it). Each is
# tried bare, with a good value, a bad one, as `=5` and before --probe, plus the pairs below.
PY="$HERE/../../scripts/py"
FWT_ENV=(env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=3" FLEET_BOX_GPU_TOKENS="testbox=1")
usage_text=$("$PY" -c 'from ludics.fleetworker.slot import SLOT_USAGE; print(SLOT_USAGE)' 2>&1) || ko "could not read SLOT_USAGE (setup): $usage_text"
shell_text=$(awk '/^fw_is_probe\(\) \{$/ { f = 1 } f { print } f && /^}$/ { exit }' "$FW")
probe_words=$({ grep -o -- '--[a-z][a-z-]*' <<<"$usage_text"; grep -o -- '--[a-z][a-z-]*' <<<"$shell_text"; } | LC_ALL=C sort -u)
# probe_verdict <output> <status>: the PROBE line a run answered, or `refused`.
probe_verdict() {
  local line
  line=$(grep '^EXECUTION SLOT PROBE ' <<<"$1")
  if [ "$2" -eq 0 ] && [ -n "$line" ]; then printf '%s\n' "$line"; else printf 'refused\n'; fi
}
pin_tried=0; pin_answered=0; pin_refused=0; pin_drift=""
# pin_line <args...>: one `execution slot` line, judged by Python and answered by the shell.
pin_line() {
  local py_out py_rc sh_out sh_rc want got
  py_out=$("${FWT_ENV[@]}" "$PY" -m ludics.fleetworker "$FW" execution slot "$@" 2>&1); py_rc=$?
  sh_out=$(env LUDICS_PY_CANDIDATES="$TMP/no-python" "${FWT_ENV[@]}" "$FW" execution slot "$@" 2>&1); sh_rc=$?
  want=$(probe_verdict "$py_out" "$py_rc"); got=$(probe_verdict "$sh_out" "$sh_rc")
  pin_tried=$((pin_tried + 1))
  if [ "$want" = refused ]; then pin_refused=$((pin_refused + 1)); else pin_answered=$((pin_answered + 1)); fi
  [ "$want" = "$got" ] || pin_drift="$pin_drift
  execution slot $*: Python says '$want', the shell '$got' ($sh_out)"
}
case "$probe_words" in *--probe*) ;; *) ko "the pin found no --probe in SLOT_USAGE or fw_is_probe (setup): $usage_text" ;; esac
while IFS= read -r w; do
  [ -n "$w" ] || continue
  pin_line --probe "$w"
  pin_line --probe "$w" 5
  pin_line --probe "$w" x
  pin_line --probe "$w=5"
  pin_line "$w" 5 --probe
done <<<"$probe_words"
pin_line --probe --cpu --gpu
pin_line --probe --gpu --gpu
pin_line --probe --wait-window=
pin_line --probe -- echo x
if [ -z "$pin_drift" ] && [ "$pin_answered" -ge 5 ] && [ "$pin_refused" -ge 5 ]; then
  ok "the shell answers a probe line exactly when Python does, with Python's line ($pin_tried lines: $pin_answered answered, $pin_refused refused)"
else
  ko "the shell's probe words drifted from parse_slot ($pin_tried lines: $pin_answered answered, $pin_refused refused):$pin_drift"
fi
# The wrapper hands the batch its caller's environment: scripts/py's PYTHONPATH (the checkout's lib/)
# must not reach the batch, set or unset.
mkdir -p "$TMP/pp"
expect "a slot's batch keeps the caller's PYTHONPATH" 0 "^pp=$TMP/pp$" -- \
  env PYTHONPATH="$TMP/pp" "${FWS[@]}" execution slot --wait 0 -- sh -c 'echo "pp=${PYTHONPATH-unset}"'
expect "...and the caller's lack of one" 0 "^pp=unset$" -- \
  env -u PYTHONPATH "${FWS[@]}" execution slot --wait 0 -- sh -c 'echo "pp=${PYTHONPATH-unset}"'
expect "...and so does a hold's" 0 "^pp=$TMP/pp$" -- \
  env PYTHONPATH="$TMP/pp" "${FWS[@]}" execution hold -- sh -c 'echo "pp=${PYTHONPATH-unset}"'
expect "...and its lack of one" 0 "^pp=unset$" -- \
  env -u PYTHONPATH "${FWS[@]}" execution hold -- sh -c 'echo "pp=${PYTHONPATH-unset}"'
# THE NESTED SLOT (ahrefs/ocannl#1004): a held slot exports its marker, and an `execution slot`
# inside it runs under that slot instead of taking another -- a runner that takes its own slot
# inside a worker's wrapper must not hold two, or deadlock a full box.
expect "a held slot exports its marker to the command" 0 "^testbox 1 1 gpu$" -- \
  "${FWS[@]}" execution slot --wait 0 -- sh -c 'echo "$FLEET_SLOT_HELD"'
expect "a slot taken --cpu past the tokens is marked cpu" 0 "^testbox 3 3 cpu$" -- \
  "${FWT[@]}" execution slot --wait 0 --cpu -- sh -c 'echo "$FLEET_SLOT_HELD"'
expect "a nested execution slot on a one-slot box runs inside the held slot (no deadlock, no refusal)" 0 "inside slot 1 of 1, held by an enclosing batch, for: echo nested-ran" -- \
  "${FWS[@]}" execution slot --wait 0 -- "$FW" execution slot --wait 0 -- echo nested-ran
grep -q "^nested-ran$" <<<"$out" && ok "...and the inner command ran" || ko "the nested command did not run -- $out"
expect "...and returns the inner command's own status (3 is not read as a verdict)" 3 "inside slot 1 of 1" -- \
  "${FWS[@]}" execution slot --wait 0 -- "$FW" execution slot --wait 0 -- sh -c 'exit 3'
expect "a nested --cpu batch runs inside an enclosing GPU token" 0 "inside slot 1 of 3" -- \
  "${FWT[@]}" execution slot --wait 0 -- "$FW" execution slot --wait 0 --cpu -- echo cpu-in-token
expect "a nested GPU batch inside a slot taken --cpu is refused" 1 "EXECUTION SLOT REFUSED testbox: this batch runs inside slot 3 of 3, which an enclosing batch took as --cpu" -- \
  "${FWT[@]}" execution slot --wait 0 --cpu -- "$FW" execution slot --wait 0 -- echo gpu-in-cpu
expect "a marker naming a slot nobody holds is ignored, and a slot is taken" 0 "slot 1 of 1 held for: echo stale" -- \
  env FLEET_SLOT_HELD="testbox 1 1 gpu" "${FWS[@]}" execution slot --wait 0 -- echo stale
grep -q "does not cover this batch (slot 1 is not held)" <<<"$out" && ok "...saying why" || ko "the stale marker was not reported -- $out"
expect "a marker naming another box is ignored" 0 "slot 1 of 1 held for: echo other-box" -- \
  env FLEET_SLOT_HELD="other 1 1 gpu" "${FWS[@]}" execution slot --wait 0 -- echo other-box
expect "a malformed marker is ignored" 0 "slot 1 of 1 held for: echo malformed" -- \
  env FLEET_SLOT_HELD="garbage" "${FWS[@]}" execution slot --wait 0 -- echo malformed
# A marker for a HELD slot, exported by hand beside a real holder: the marker is judged by the
# lock, so it runs inside -- the holder's slot is the box's bound either way, and the batch adds
# to its load only as much as the holder's own children would.
"${FWS[@]}" execution slot -- sleep 30 > "$TMP/slot-n1.log" 2>&1 &
n1=$!
if held "$TMP/slot-n1.log" "slot 1 of 1 held"; then
  expect "a hand-exported marker for a held slot runs inside it" 0 "inside slot 1 of 1" -- \
    env FLEET_SLOT_HELD="testbox 1 1 gpu" "${FWS[@]}" execution slot --wait 0 -- echo beside-holder
  expect "...while a batch with no marker is still refused" 1 "all 1 run-time correctness slots busy" -- \
    "${FWS[@]}" execution slot --wait 0 -- echo no-marker
fi
kill -9 "$n1" 2>/dev/null; wait "$n1" 2>/dev/null
# THE DETACHED BATCH (ludics-lite#181): `--bg <parent>` runs the same slot-held batch under
# bg-run.sh's `spawn`, returning the run directory at once; bg-run.sh's `wait` is its one wait. The
# commands wait on a gate file, so each is seen holding its slot after the call that started it
# returned.
BGR="$HERE/bg-run.sh"
# shellcheck disable=SC2016 # the batch's own sh expands these
GATED='while [ ! -e "$0" ]; do sleep 0.1; done; echo gated-done; exit "$1"'
bgkill() { local f; for f in pid cpid; do [ -s "$1/$f" ] && kill -9 "$(head -n 1 "$1/$f")" 2>/dev/null; done; }
bgcmd=(sh -c "$GATED" "$TMP/slot-bg-gate1" 3)
expect "execution slot --bg returns at once with a bg-run.sh run directory" 0 "^$TMP/slot-bg/run-1$" -- \
  "${FWS[@]}" execution slot --bg "$TMP/slot-bg" -- "${bgcmd[@]}"
bgd="$TMP/slot-bg/run-1"
if [ "$out" = "$bgd" ] && held "$bgd/log" "slot 1 of 1 held for: sh -c"; then
  ok "...whose detached batch takes the slot"
  expect "...and holds it after the call returned: a foreground batch is refused" 1 "all 1 run-time correctness slots busy" -- \
    "${FWS[@]}" execution slot --wait 0 -- echo beside-bg
  expect "...and bg-run.sh wait reads it RUNNING" 3 RUNNING -- "$BGR" wait "$bgd" --within 0
  : > "$TMP/slot-bg-gate1"
  expect "...then the batch's own status (rc=3)" 0 "rc=3" -- "$BGR" wait "$bgd" --within 30
  grep -q "^gated-done$" "$bgd/log" && ok "...with its output in the run's log" || ko "the --bg batch's log: $(cat "$bgd/log")"
  expect "...and the slot is free once it ends" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo after-bg
else ko "the --bg batch printed $out and never took the slot: $(cat "$bgd/log" 2>/dev/null)"; fi
bgkill "$bgd"
# Inside an enclosing slot the detached batch runs under it, and keeps it held past the end of
# the enclosing command that spawned it: the flock is inherited, like FLEET_SLOT_HELD.
bgcmd=(sh -c "$GATED" "$TMP/slot-bg-gate2" 0)
expect "a --bg batch inside an enclosing slot returns its directory from within it" 0 "$TMP/slot-bg/run-2" -- \
  "${FWS[@]}" execution slot --wait 0 -- "$FW" execution slot --wait 0 --bg "$TMP/slot-bg" -- "${bgcmd[@]}"
bgd="$TMP/slot-bg/run-2"
if held "$bgd/log" "inside slot 1 of 1, held by an enclosing batch"; then
  ok "...and runs inside that slot rather than waiting for a second one"
  expect "...which stays held after the enclosing command ended" 1 "all 1 run-time correctness slots busy" -- \
    "${FWS[@]}" execution slot --wait 0 -- echo beside-nested-bg
  : > "$TMP/slot-bg-gate2"
  expect "...until the batch ends (rc=0)" 0 "rc=0" -- "$BGR" wait "$bgd" --within 30
  expect "...and then it is free" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo after-nested-bg
else ko "the nested --bg batch did not run inside the enclosing slot: $(cat "$bgd/log" 2>/dev/null)"; fi
bgkill "$bgd"
# The detached batch starts with INT and HUP at their default dispositions (ludics-lite#524), so a
# suite that signals its own children runs under --bg as in the foreground: a batch that signals
# itself dies of it, through the slot's wrapper, where before the run inherited both ignored.
for sc in INT:130 HUP:129; do
  sig=${sc%%:*}
  "${FWS[@]}" execution slot --bg "$TMP/slot-bg-sig" -- sh -c 'kill -"$0" $$; sleep 1; echo "survived $0"' "$sig" > "$TMP/slot-bg-sig.out" 2>&1
  bgd=$(tail -n 1 "$TMP/slot-bg-sig.out")
  expect "a --bg batch dies of the $sig it sends itself (rc=${sc#*:})" 0 "rc=${sc#*:}" -- "$BGR" wait "$bgd" --within 30
  grep -q "^survived" "$bgd/log" 2>/dev/null && ko "...but it survived $sig: $(cat "$bgd/log")" || ok "...rather than surviving it"
  bgkill "$bgd"
done
expect "--bg on a host with no fleet name is refused in the foreground" 2 "no fleet name" -- \
  env -u FLEET_LOCAL_BOX FLEET_HOSTNAME_MAP="nomatch*=testbox" "$FW" execution slot --bg "$TMP/slot-bg-none" -- echo x
[ ! -e "$TMP/slot-bg-none" ] && ok "...and allocates no run directory" || ko "a refused --bg allocated $TMP/slot-bg-none"
expect "--bg takes an absolute parent, as bg-run.sh does" 2 "absolute" -- "${FWS[@]}" execution slot --bg rel/runs -- echo x
expect "--bg with --probe is a usage error" 2 "--probe takes no --bg" -- "${FWS[@]}" execution slot --probe --bg "$TMP/slot-bg"
expect "--cpu and --gpu together are a usage error" 2 "exclusive" -- "${FWT[@]}" execution slot --cpu --gpu -- true
expect "a token count below one is refused, as a slot count is" 1 "FLEET_BOX_GPU_TOKENS entry must be <box>=<positive n>: testbox=0" -- \
  env FLEET_BOXES="testbox other" FLEET_BOX_GPU_TOKENS="testbox=0" "$FW" execution slot -- true
expect "...and one naming a box outside the roster" 1 "FLEET_BOX_GPU_TOKENS names stale-box, which is not in FLEET_BOXES" -- \
  env FLEET_BOXES="testbox other" FLEET_BOX_GPU_TOKENS="stale-box=1" "$FW" execution slot -- true
# The OS-level sleep guard (ludics-lite#317). The stub logs its arguments and its pid and, like
# the real systemd-inhibit, runs the command after its options -- the helper that holds the
# inhibitor for as long as the batch's lifetime pipe is open; INHIBIT_DENY is polkit refusing
# the block, which the real one reports as "Failed to inhibit: Access denied" and exit 1.
mkdir -p "$TMP/inhibit"
cat > "$TMP/inhibit/systemd-inhibit" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$INHIBIT_LOG"
printf '%s\n' "$$" > "$INHIBIT_PID"
[ -z "${INHIBIT_DENY:-}" ] || { echo "Failed to inhibit: Access denied (stub)" >&2; exit 1; }
while [ "$#" -gt 0 ]; do case "$1" in --) shift; break ;; --*) shift ;; *) break ;; esac; done
exec "$@"
EOF
chmod +x "$TMP/inhibit/systemd-inhibit"
export INHIBIT_LOG="$TMP/inhibit.log" INHIBIT_PID="$TMP/inhibit.pid"
HELPER_ARGV="-- sh -c echo HELD; exec cat >/dev/null"
# gone <pidfile>: the helper recorded there has exited (the inhibitor is released), within 10s.
gone() {
  local i pid; pid=$(cat "$1" 2>/dev/null) || return 1
  for i in $(seq 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  return 1
}
FWI=(env FLEET_SYSTEMD_INHIBIT="$TMP/inhibit/systemd-inhibit" FLEET_BOXES="testbox other" "$FW")
: > "$INHIBIT_LOG"
expect "on a host with systemd-inhibit a slot's batch runs under a sleep:idle block inhibitor" 3 "EXECUTION HOLD testbox: sleep:idle block inhibitor held for: testbox slot 1 of 1: sh -c exit 3" -- \
  "${FWI[@]}" execution slot -- sh -c 'exit 3'
grep -Fxq -- "--what=sleep:idle --mode=block --who=fleet-worker --why=testbox slot 1 of 1: sh -c exit 3 $HELPER_ARGV" "$INHIBIT_LOG" &&
  ok "...as systemd-inhibit --mode=block, never block-weak, which the caller's own uid would ignore" || ko "the batch did not run under the block inhibitor: $(cat "$INHIBIT_LOG")"
grep -q "slot 1 of 1 held for: sh -c exit 3" <<<"$out" && ok "...inside the slot, which it still holds" || ko "the inhibited batch lost its slot line: $out"
gone "$INHIBIT_PID" && ok "...and the inhibitor is released when the batch ends" || ko "the inhibitor helper outlived the batch"
# The inhibitor is held BESIDE the batch, never around it (PR #323 review, round 1: under a
# systemd-inhibit wrapper the pid a caller holds was systemd-inhibit's). That pid is the slot's
# wrapper, the batch's parent, and the batch leads a process group of its own (ludics-lite#566):
# killing the wrapper outright ends the batch through its guardian, which frees the slot and
# releases the inhibitor.
"${FWI[@]}" execution slot -- sleep 30 > "$TMP/slot-i0.log" 2>&1 &
ipid=$!
if held "$TMP/slot-i0.log" "block inhibitor held"; then
  kill -0 "$(cat "$INHIBIT_PID")" 2>/dev/null && ok "an inhibited batch's helper is alive while the batch runs" || ko "the helper was not running under a live batch"
  ichild=""
  for _ in $(seq 50); do ichild=$(pgrep -P "$ipid" sleep 2>/dev/null) && break; sleep 0.1; done
  [ -n "$ichild" ] && [ "$(ps -o pgid= -p "$ichild" | tr -d ' ')" = "$ichild" ] &&
    ok "...and the batch, the child of the pid the caller holds, leads a process group of its own" ||
    ko "the batch is not a group leader under the caller's pid: child=$ichild $(ps -o pid,pgid,comm -p "${ichild:-$ipid}")"
  kill -KILL "$ipid"; wait "$ipid" 2>/dev/null
  gone "$INHIBIT_PID" && ok "...killing that pid releases the inhibitor" || ko "the inhibitor outlived its killed batch"
  expect "...and frees the slot" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo after-inhibited-kill
fi
# The batch still inherits the slot flock, as it did unwrapped: a descendant that outlives the
# batch's top process keeps both the slot and the inhibitor, since it is still using the box.
: > "$INHIBIT_LOG"
"${FWI[@]}" execution slot -- sh -c 'sleep 30 & echo "child $!"' > "$TMP/slot-i1.log" 2>&1
child=$(sed -n 's/^child //p' "$TMP/slot-i1.log")
if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
  expect "a descendant outliving its batch still holds the slot" 1 "slots busy" -- "${FWS[@]}" execution slot --wait 0 -- echo while-child
  kill -0 "$(cat "$INHIBIT_PID")" 2>/dev/null && ok "...and the inhibitor" || ko "the inhibitor was released under a still-running descendant"
  kill "$child"
  gone "$INHIBIT_PID" && ok "...until it exits" || ko "the inhibitor outlived the last descendant"
else ko "no surviving descendant to test with: $(cat "$TMP/slot-i1.log")"; fi
: > "$INHIBIT_LOG"
expect "without systemd-inhibit (macOS) the batch runs bare, and says nothing about it" 0 "slot 1 of 1 held for: echo bare" -- "${FWS[@]}" execution slot -- echo bare
grep -q "EXECUTION HOLD" <<<"$out" && ko "the bare arm announced an inhibitor: $out" || ok "...with no hold line"
[ -s "$INHIBIT_LOG" ] && ko "the bare arm called systemd-inhibit: $(cat "$INHIBIT_LOG")" || ok "...and no systemd-inhibit call"
expect "a polkit refusal of the block runs the batch anyway, under a WARNING" 0 "WARNING: running WITHOUT a sleep inhibitor" -- \
  env INHIBIT_DENY=1 "${FWI[@]}" execution slot -- echo denied-but-ran
grep -q "^denied-but-ran$" <<<"$out" && grep -q "Access denied (stub)" <<<"$out" && ok "...naming the refusal, and the batch ran" || ko "a refused inhibitor stopped the batch or hid why: $out"
: > "$INHIBIT_LOG"
expect "a command that cannot be run is still the slot's own refusal under the inhibitor" 127 "EXECUTION SLOT REFUSED testbox: cannot run /nonexistent/runner" -- \
  "${FWI[@]}" execution slot -- /nonexistent/runner
[ -s "$INHIBIT_LOG" ] && ko "an unrunnable command took an inhibitor: $(cat "$INHIBIT_LOG")" || ok "...refused before any inhibitor is taken"
# `hold` is the measurement's wrapper: the slot refuses while a measurement is outstanding, the
# measurement's own included, so the guard has to come without the slot.
"${FWS[@]}" execution run "$(slotreq hold-measure measurement)" >/dev/null || ko "could not reserve the measurement (setup)"
: > "$INHIBIT_LOG"
expect "execution hold runs a measurement's runner under the inhibitor while the slot refuses it" 0 "sleep:idle block inhibitor held for: testbox hold: echo measured" -- \
  "${FWI[@]}" execution hold -- echo measured
grep -Fxq -- "--what=sleep:idle --mode=block --who=fleet-worker --why=testbox hold: echo measured $HELPER_ARGV" "$INHIBIT_LOG" && ok "...the same block inhibitor the slot takes" || ko "hold did not take the block inhibitor: $(cat "$INHIBIT_LOG")"
expect "...beside a slot that is refused for that very measurement" 1 "a measurement holds the box exclusively (hold-measure)" -- "${FWI[@]}" execution slot -- echo during
# THE MEASUREMENT'S OWN RUN (ludics-lite#480): a runner that takes the slot itself (OCANNL's
# tools/test-run.sh) inside its own measurement's `hold --request` runs under that hold, with no
# slot taken; every batch the registry and the hold's lock do not confirm is still refused.
: > "$INHIBIT_LOG"
expect "a slot inside its own measurement's hold runs under that hold instead of being refused" 0 "inside measurement hold-measure, held by an enclosing .execution hold.; no slot taken, for: echo own-run" -- \
  "${FWI[@]}" execution hold --request hold-measure -- "$FW" execution slot -- echo own-run
grep -q "^own-run$" <<<"$out" && ok "...and its command ran" || ko "the measurement's own batch did not run: $out"
grep -Eq "slot [0-9]+ of [0-9]+ held|REFUSED" <<<"$out" && ko "the measurement's own batch took a slot or was refused: $out" || ok "...taking no slot"
[ "$(grep -c -- "--what=sleep:idle" "$INHIBIT_LOG")" -eq 1 ] && grep -Fq -- "--why=testbox measurement hold-measure hold: " "$INHIBIT_LOG" &&
  ok "...under the hold's one sleep guard, which names the measurement" || ko "the measurement's own batch took a second guard, or the hold's names no measurement: $(cat "$INHIBIT_LOG")"
expect "...and the probe inside that hold reports it" 0 "^EXECUTION SLOT PROBE testbox 1 1 measurement hold-measure$" -- \
  "${FWS[@]}" execution hold --request hold-measure -- "$FW" execution slot --probe
expect "...where a probe with no Python >= 3.12 to judge the marker still answers, naming none" 0 "^EXECUTION SLOT PROBE testbox 1 1$" -- \
  "${FWS[@]}" execution hold --request hold-measure -- env LUDICS_PY_CANDIDATES="$TMP/no-python" "$FW" execution slot --probe
expect "...as does a slot nested a level deeper, through a shell" 0 "^deeper$" -- \
  "${FWS[@]}" execution hold --request hold-measure -- sh -c '"$1" execution slot -- "$1" execution slot -- echo deeper' _ "$FW"
# The slot inside its measurement's hold runs in the hold's process group, not one of its own, so
# the hold's group kill reaches everything it started (ludics-lite#566).
expect "a measurement hold's --deadline ends a grandchild that the slot inside it started" 124 "EXECUTION HOLD testbox: --deadline 2s reached" -- \
  "${FWS[@]}" execution hold --request hold-measure --deadline 2 -- "$FW" execution slot -- bash -c "sleep ${GM}10 & wait"
swept 10 && ok "...leaving no sleep behind" || ko "the hold's deadline missed the nested slot's grandchild: $(pgrep -fl "$(gmre 10)")"
"${FWS[@]}" execution hold --request hold-measure -- sleep 30 > "$TMP/hold-m0.log" 2>&1 &
m0=$!
if held "$TMP/hold-m0.log" "measurement hold-measure held"; then
  expect "an independent batch beside the live hold, with no marker, is still refused" 1 "a measurement holds the box exclusively (hold-measure); only a batch inside its own" -- \
    "${FWS[@]}" execution slot -- echo independent
  expect "...and its probe reports no measurement" 0 "^EXECUTION SLOT PROBE testbox 1 1$" -- "${FWS[@]}" execution slot --probe
fi
kill -9 "$m0" 2>/dev/null; wait "$m0" 2>/dev/null
expect "a marker naming another box is not confirmed, and the batch is refused" 1 "FLEET_MEASUREMENT_HELD='other hold-measure' does not cover this batch (another box's)" -- \
  "${FWS[@]}" execution hold --request hold-measure -- env FLEET_MEASUREMENT_HELD="other hold-measure" "$FW" execution slot -- echo other-box
grep -q "a measurement holds the box exclusively (hold-measure)" <<<"$out" && ok "...by the measurement" || ko "the other box's marker was not refused by the measurement: $out"
expect "a marker naming an unknown request is not confirmed, and the batch is refused" 1 "the registry has no outstanding measurement no-such-request on testbox" -- \
  "${FWS[@]}" execution hold --request no-such-request -- "$FW" execution slot -- echo unknown
grep -q "a measurement holds the box exclusively (hold-measure)" <<<"$out" && ok "...by the measurement" || ko "the unknown request's marker was not refused by the measurement: $out"
expect "a marker no live hold backs (copied by hand, or outliving its hold) is not confirmed" 1 "no .execution hold --request. is live on testbox" -- \
  env FLEET_MEASUREMENT_HELD="testbox hold-measure" "${FWS[@]}" execution slot -- echo stale
expect "...nor a malformed one" 1 "FLEET_MEASUREMENT_HELD='testbox' does not cover this batch (malformed)" -- \
  "${FWS[@]}" execution hold --request hold-measure -- env FLEET_MEASUREMENT_HELD="testbox" "$FW" execution slot -- echo malformed
expect "...and the probe reports neither" 0 "^EXECUTION SLOT PROBE testbox 1 1$" -- env FLEET_MEASUREMENT_HELD="testbox hold-measure" "${FWS[@]}" execution slot --probe
mkdir -p "$TMP/slot-nolock/testbox/measurement.lock"
expect "a hold whose lock cannot be taken still runs the measurement, saying so" 0 "WARNING: no measurement marker" -- \
  env FLEET_SLOT_STATE="$TMP/slot-nolock" "${FWS[@]}" execution hold --request hold-measure -- echo measured-unlocked
grep -q "^measured-unlocked$" <<<"$out" && ok "...and the runner ran" || ko "the unlocked hold did not run its command: $out"
expect "...while a slot inside it, with no marker, is refused" 1 "a measurement holds the box exclusively (hold-measure)" -- \
  env FLEET_SLOT_STATE="$TMP/slot-nolock" "${FWS[@]}" execution hold --request hold-measure -- "$FW" execution slot -- echo x
fixture_done hold-measure
"${FWS[@]}" execution run "$(slotreq hold-measure-2 measurement)" >/dev/null || ko "could not reserve the second measurement (setup)"
expect "a marker naming a concluded measurement is not confirmed beside an outstanding one" 1 "the registry has no outstanding measurement hold-measure on testbox" -- \
  "${FWS[@]}" execution hold --request hold-measure -- "$FW" execution slot -- echo concluded
grep -q "a measurement holds the box exclusively (hold-measure-2)" <<<"$out" && ok "...and the batch is refused by that one" || ko "the concluded request's marker was not refused: $out"
fixture_done hold-measure-2
# With nothing outstanding the hold still holds every slot of the box (THE DRAIN, ludics-lite#481),
# so a slot of the batch's own would wait for the very hold it runs in: it runs under the hold.
expect "...and with nothing outstanding the batch runs under the hold, which holds the box's slots" 0 "inside the enclosing .execution hold --request hold-measure., which holds this box's slots (the registry has no outstanding measurement hold-measure on testbox); no slot taken, for: echo after-measurements" -- \
  "${FWS[@]}" execution hold --request hold-measure -- "$FW" execution slot --wait 0 -- echo after-measurements
grep -q "^after-measurements$" <<<"$out" && ok "...and runs" || ko "the batch under a hold with nothing outstanding did not run: $out"
# THE CO-TENANTS (ludics-lite#566): a measurement's hold records the box's GPU-using processes
# outside its own tree when it opens and when it closes, and the measurement's conclusion cites the
# record. The probe is a stub nvidia-smi listing the hold itself (its parent) and every pid in
# $GPU_APPS: a planted sleep, and a leftover the hold's command adds to the list and leaves running in
# its group. Only the planted one is a co-tenant. The other probes are pointed at nothing.
mkdir -p "$TMP/gpu"
printf '%s\n' '#!/bin/sh' '[ -z "${GPU_SLOW:-}" ] || sleep "$GPU_SLOW"' 'echo "$PPID, fleet-hold, 1"' 'while read -r pid; do echo "$pid, stub-gpu-app, 640"; done < "$GPU_APPS"' > "$TMP/gpu/nvidia-smi"
chmod +x "$TMP/gpu/nvidia-smi"
FWG=(env GPU_APPS="$TMP/gpu/apps" FLEET_NVIDIA_SMI="$TMP/gpu/nvidia-smi" FLEET_DRM_PROC="$TMP/gpu/no-proc" FLEET_IOREG="$TMP/gpu/no-ioreg" "${FWS[@]}")
gpurec="$HOME/.local/state/fleet-execution-slots/testbox/measurement.gpu-measure.gpu.jsonl"
"${FWS[@]}" execution run "$(slotreq gpu-measure measurement)" >/dev/null || ko "could not reserve the GPU measurement (setup)"
sleep "${GM}20" &
planted=$!
printf '%s\n' "$planted" > "$TMP/gpu/apps"
expect "a measurement hold's record lists a planted GPU-using process" 0 "measurement gpu-measure: GPU co-tenants at open: 1 \[pid $planted [^ ]* sleep ${GM}20 (nvidia-smi, 640 MiB)\] (nvidia-smi ran)" -- \
  "${FWG[@]}" execution hold --request gpu-measure -- sh -c 'sleep "$1" & echo "$!" >> "$GPU_APPS"' _ "${GM}21"
grep -q "GPU co-tenants at close: 1 \[pid $planted " <<<"$out" && ok "...at its close too, leaving out the hold and its command's leftover" || ko "the closing snapshot: $out"
pkill -f "$(gmre 21)"
printf '%s\n' "$planted" > "$TMP/gpu/apps"  # the leftover is gone, as nvidia-smi would say
[ "$(jq -sc --argjson p "$planted" '[.[] | [.event, ([.gpu_processes[].pid] == [$p]), .own_tree_gpu_processes]]' "$gpurec" 2>&1)" = '[["opened",true,1],["closed",true,2]]' ] &&
  ok "...in the record on the box: one opened and one closed line, the hold's own tree counted, not listed" || ko "the co-tenant record: $(cat "$gpurec" 2>&1)"
"${FWG[@]}" execution hold --request gpu-measure -- "$FW" execution hold --request gpu-measure -- true >/dev/null 2>&1
[ "$(jq -sc --argjson p "$planted" '[.[2:][] | [.event, ([.gpu_processes[].pid] == [$p])]]' "$gpurec" 2>&1)" = '[["opened",true],["opened",true],["closed",true],["closed",true]]' ] &&
  ok "...and a hold nested in a hold of the same measurement records its own pair, leaving out the measurement" || ko "the nested hold's record: $(cat "$gpurec")"
printf '#!/nonexistent/interpreter\n' > "$TMP/gpu/no-interp.sh"; chmod +x "$TMP/gpu/no-interp.sh"
expect "a hold whose command cannot be started is refused" 127 "EXECUTION HOLD REFUSED testbox: cannot run" -- \
  "${FWG[@]}" execution hold --request gpu-measure -- "$TMP/gpu/no-interp.sh"
[ "$(grep -c '' "$gpurec")" -eq 6 ] && ok "...and records no snapshot, which would read as a hold that never closed" || ko "the unstarted hold's record: $(cat "$gpurec")"
# A 4 s command under a 2 s deadline, beside a 3 s opening probe: a deadline counted from the end of
# the probe (as when the snapshot ran with the command already started) would let it finish, exit 0.
expect "a slow opening probe does not eat into --deadline, which counts from the command's start" 124 "EXECUTION HOLD testbox: --deadline 2s reached" -- \
  env GPU_SLOW=3 "${FWG[@]}" execution hold --request gpu-measure --deadline 2 -- sleep 4
kill "$planted" 2>/dev/null; wait "$planted" 2>/dev/null
jq -n '{request_id:"gpu-measure", verdict:"pass", log:"/dev/null", evidence:"fixture: measured",
  observed_sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", remote_checkout:"/tmp/x", handle:"fixture"}' > "$TMP/gpu-done.json"
expect "the measurement's conclusion carries the co-tenant record in its evidence" 0 "fixture: measured; GPU co-tenants on testbox (testbox:$gpurec): hold [0-9]* opened [^ ]*: 1 \[pid $planted " -- \
  "${FWS[@]}" execution conclude "$TMP/gpu-done.json"
rm -f "$gpurec"
expect "...and a retry of that conclusion, its answer lost, is the registry's identical retry though the record is gone" 0 "GPU co-tenants on testbox (testbox:$gpurec): hold " -- \
  "${FWS[@]}" execution conclude "$TMP/gpu-done.json"
# A record past the MiB a conclusion reads is read from its end, and the conclusion says so.
"${FWS[@]}" execution run "$(slotreq gpu-big measurement)" >/dev/null || ko "could not reserve the long-record measurement (setup)"
bigrec="$HOME/.local/state/fleet-execution-slots/testbox/measurement.gpu-big.gpu.jsonl"
awk 'BEGIN { for (i = 0; i < 20000; i++) printf "{\"pad\":\"%080d\"}\n", i }' > "$bigrec"
jq -cn '{hold_pid: 9, event: "opened", at: "T1", probes: [], gpu_processes: []}, {hold_pid: 9, event: "closed", at: "T2", probes: [], gpu_processes: []}' >> "$bigrec"
jq -n '{request_id:"gpu-big", verdict:"pass", log:"/dev/null", evidence:"fixture: measured",
  observed_sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", remote_checkout:"/tmp/x", handle:"fixture"}' > "$TMP/gpu-big.json"
expect "a record longer than the MiB a conclusion reads is read from its end, saying what it left out" 0 "the record is [0-9]* bytes, of which its last 1048576 were read, so the earliest snapshots are left out; .*hold 9 opened T1: none" -- \
  "${FWS[@]}" execution conclude "$TMP/gpu-big.json"
"${FWS[@]}" execution run "$(slotreq gpu-none measurement)" >/dev/null || ko "could not reserve the second GPU measurement (setup)"
jq -n '{request_id:"gpu-none", verdict:"pass", log:"/dev/null", evidence:"fixture: measured",
  observed_sha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", remote_checkout:"/tmp/x", handle:"fixture"}' > "$TMP/gpu-none.json"
expect "...and one whose box holds no record says so" 0 "no GPU co-tenant record on testbox (.*): the measurement ran under no .execution hold --request gpu-none. there" -- \
  "${FWS[@]}" execution conclude "$TMP/gpu-none.json"
# THE MEASUREMENT WINDOW (ludics-lite#481): a measurement on a box whose workers hold standing
# reservations suspends them; a batch there is refused naming the window, the measurement's own
# run is still admitted inside its hold (#480), and the conclusion restores the standing ones.
"${FWS[@]}" execution run "$(slotreq win-iterate correctness true)" >/dev/null || ko "could not take the standing reservation (setup)"
expect "a plain measurement is refused beside a standing reservation, pointing at the window" 1 "every one is standing, which .fleet-worker.sh execution window. suspends" -- \
  "${FWS[@]}" execution run "$(slotreq win-plain measurement)"
"${FWS[@]}" execution slot -- sleep 30 > "$TMP/win-b0.log" 2>&1 &
b0=$!
held "$TMP/win-b0.log" "slot 1 of 1 held"
expect "execution window opens a measurement over the box's standing reservations" 0 "EXECUTION WINDOW testbox: win-measure open; suspended win-iterate" -- \
  "${FWS[@]}" execution window testbox "$(slotreq win-measure measurement)"
grep -q '"window": true' <<<"$out" && grep -q '"state": "launching"' <<<"$out" && ok "...dispatched, and marked a window" || ko "the window's record: $out"
listing=$("${FWS[@]}" execution list --active --compact 2>&1)
[ "$(jq -r '.[] | select(.request_id == "win-iterate") | "\(.state) \(.suspended_by)"' <<<"$listing")" = "suspended win-measure" ] &&
  ok "...and execution list --active --compact shows the standing reservation suspended by it" || ko "the suspended reservation is not shown as such: $listing"
# THE DRAIN: a batch already running when the window opened ends before the measurement starts,
# and while the measurement's hold holds the box's slots no batch starts beside it, a stale slot
# marker included.
"${FWS[@]}" execution hold --request win-measure -- sh -c 'echo measuring; sleep 30' > "$TMP/win-m.log" 2>&1 &
m0=$!
if held "$TMP/win-m.log" "measurement win-measure waits for the batch in slot 1 to end"; then
  grep -q "^measuring$" "$TMP/win-m.log" && ko "the measurement started beside a running batch: $(cat "$TMP/win-m.log")" ||
    ok "the measurement's hold waits for a batch running when the window opened"
  # THE HOLDER RECORD (ludics-lite#668): a batch with no --deadline may hold the slot long, so the
  # drain names it after the line above, as its slot record says: its pid, its cap and its command.
  held "$TMP/win-m.log" "measurement win-measure waits on slot 1: recorded holder pid [0-9]*, slot taken [0-9]*s ago, no --deadline recorded; for: sleep 30$" &&
    ok "...naming the batch it waits for, which no --deadline bounds"
  kill -9 "$b0" 2>/dev/null; wait "$b0" 2>/dev/null
  held "$TMP/win-m.log" "^measuring$" && ok "...and starts once it ends"
  expect "...after which a slot marker is not trusted, since the hold is what holds that slot" 1 "does not cover this batch (a measurement's .execution hold --request. holds this box's slots)" -- \
    env FLEET_SLOT_HELD="testbox 1 1 gpu" "${FWS[@]}" execution slot -- echo stale-marker
  grep -q "^stale-marker$" <<<"$out" && ko "a stale slot marker ran beside the measurement: $out" || ok "...and the batch is refused"
fi
kill -9 "$b0" "$m0" 2>/dev/null; wait "$b0" 2>/dev/null; wait "$m0" 2>/dev/null
expect "a hold nested in a hold of the same measurement does not wait for its own slots" 0 "^nested-hold$" -- \
  "${FWS[@]}" execution hold --request win-measure -- "$FW" execution hold --request win-measure -- echo nested-hold
expect "a batch during the window is refused, naming it" 1 "measurement window win-measure is open on testbox, and holds the box exclusively; standing reservations here are suspended until it concludes, so retry this batch then (no request needed)" -- \
  "${FWS[@]}" execution slot -- echo during-window
expect "...while the measurement's own run is admitted inside its hold" 0 "inside measurement win-measure, held by an enclosing .execution hold.; no slot taken, for: echo window-own-run" -- \
  "${FWS[@]}" execution hold --request win-measure -- "$FW" execution slot -- echo window-own-run
grep -q "^window-own-run$" <<<"$out" && ok "...and runs" || ko "the window's own run did not run: $out"
expect "a second window on the box is refused while one is open" 1 "measurement window win-measure is already open on testbox" -- \
  "${FWS[@]}" execution window testbox "$(slotreq win-second measurement)"
expect "execution window takes a box and a reservation" 2 "execution window <box> <measurement reserve.json>" -- "${FWS[@]}" execution window testbox
expect "concluding the measurement restores the standing reservation" 0 "EXECUTION WINDOW testbox: win-measure concluded; restored win-iterate (launching)" -- \
  "${FWS[@]}" execution conclude "$(jq -n '{request_id:"win-measure", verdict:"not-launched", log:"/dev/null", evidence:"fixture: nothing ran"}' > "$TMP/win-done.json"; printf '%s' "$TMP/win-done.json")"
expect "...and a batch is admitted again" 0 "slot 1 of 1 held for: echo after-window" -- "${FWS[@]}" execution slot --wait 0 -- echo after-window
fixture_done win-iterate
# THE WINDOW WAIT (ludics-lite#557): `slot --wait-window` waits out a measurement on this box rather
# than refusing, then queues for a slot as --wait says; a measurement on another box never blocks
# it. `execution list --host` selects one box's records, an alias selecting its roster entry's.
"${FWS[@]}" execution run "$(slotreq ww-iterate correctness true)" >/dev/null || ko "could not take the standing reservation (setup)"
"${FWS[@]}" execution window testbox "$(slotreq ww-measure measurement)" >/dev/null 2>&1 || ko "could not open the window (setup)"
expect "a --bg batch with --wait-window returns its run directory at once during a window" 0 "^$TMP/slot-ww/run-1$" -- \
  env FLEET_SLOT_WINDOW_POLL=1 "${FWS[@]}" execution slot --bg "$TMP/slot-ww" --wait-window=60 --wait 0 -- echo after-window-wait
bgd="$TMP/slot-ww/run-1"
if held "$bgd/log" "waiting up to 60s (--wait-window) for it to conclude, then for a slot, for: echo after-window-wait"; then
  grep -q "measurement window ww-measure holds testbox (coordinator test-coordinator; ww-measure for o/r#1; reserved " "$bgd/log" &&
    ok "...which names the window, its box and its owner once" || ko "the waiting batch did not name the window: $(cat "$bgd/log")"
  grep -q "^after-window-wait$" "$bgd/log" && ko "the batch ran during the window: $(cat "$bgd/log")" || ok "...and runs nothing while it is open"
  expect "a foreground --wait-window batch is refused at its bound, naming the window" 1 "EXECUTION SLOT REFUSED testbox: measurement ww-measure still holds testbox after 1s (--wait-window); no slot taken" -- \
    env FLEET_SLOT_WINDOW_POLL=1 "${FWS[@]}" execution slot --wait-window=1 -- echo bounded
  grep -q "^bounded$" <<<"$out" && ko "the bounded batch ran: $out" || ok "...running nothing"
  expect "--wait-window does not wait inside a measurement's hold, where it would wait for its own measurement" 1 "does not wait inside a measurement's hold" -- \
    "${FWS[@]}" execution hold --request no-such-request -- "$FW" execution slot --wait-window=60 -- echo in-hold
  fixture_done ww-measure
  expect "...and once the window concludes the waiting batch takes a slot and runs (rc=0)" 0 "rc=0" -- "$BGR" wait "$bgd" --within 30
  grep -q "slot 1 of 1 held for: echo after-window-wait" "$bgd/log" && grep -q "^after-window-wait$" "$bgd/log" &&
    ok "...in its slot, with its output in the run's log" || ko "the waited batch's log: $(cat "$bgd/log")"
else ko "the --wait-window batch never said it waits: $(cat "$bgd/log" 2>/dev/null)"; fixture_done ww-measure; fi
bgkill "$bgd"
"${FWS[@]}" execution window other "$(slotreq ww-other measurement false other)" >/dev/null 2>&1 || ko "could not open the other box's window (setup)"
expect "a window on another box does not block a --wait-window batch" 0 "slot 1 of 1 held for: echo not-blocked" -- \
  "${FWS[@]}" execution slot --wait-window=60 --wait 0 -- echo not-blocked
grep -q "waiting up to" <<<"$out" && ko "the batch waited for another box's window: $out" || ok "...nor make it wait"
expect "execution list --host selects one box's records" 0 '"ww-other"' -- "${FWS[@]}" execution list --active --compact --host other
grep -q '"ww-iterate"' <<<"$out" && ko "--host other listed testbox's record: $out" || ok "...and none of another box's"
expect "...by case, as ssh reads a host name" 0 '"ww-iterate"' -- "${FWS[@]}" execution list --active --compact --host TESTBOX
# An alias is read off the endpoint map, which the dispatcher copy has none of: a copy beside a
# one-row wake-lab.sh stand-in gives it one.
cp -R "$TMP/dispatcher" "$TMP/dispatcher-map"
printf '%s\n' '#!/usr/bin/env bash' '[ "$1" = endpoint-map ] && printf "%s\n" "rog rog-nv-linux rog-nv-wsl"' > "$TMP/dispatcher-map/scripts/wake-lab.sh"
FWM=(env FLEET_BOXES="testbox other rog-nv-linux" "$TMP/dispatcher-map/issue-wave/scripts/fleet-worker.sh")
"${FWM[@]}" execution reserve "$(slotreq ww-rog correctness true rog-nv-linux)" >/dev/null || ko "could not reserve on rog-nv-linux (setup)"
expect "...and an alias (rog) selects its roster entry's (rog-nv-linux) records" 0 '"ww-rog"' -- \
  "${FWM[@]}" execution list --active --compact --host rog
grep -q '"ww-iterate"\|"ww-other"' <<<"$out" && ko "--host rog listed another box's records: $out" || ok "...and only those"
expect "a --host that is no roster entry's box is refused, not answered with an empty list" 1 "list --host rgo: no FLEET_BOXES entry" -- \
  "${FWS[@]}" execution list --host rgo
expect "--host needs a box" 2 "expected a box for --host" -- "${FWS[@]}" execution list --host
fixture_done ww-rog; fixture_done ww-other; fixture_done ww-iterate
expect "execution slot refuses a non-numeric --wait-window" 2 "--wait-window takes a whole number of seconds" -- "${FWS[@]}" execution slot --wait-window=soon -- echo x
expect "execution hold --request needs a request id" 2 "--request takes the measurement's request id" -- "${FWS[@]}" execution hold --request "../x" -- true
expect "...and this host's fleet name, which the marker names" 2 "--request needs this host's fleet name" -- \
  env -u FLEET_LOCAL_BOX FLEET_HOSTNAME_MAP="nomatch*=testbox" "$FW" execution hold --request hold-measure -- true
expect "execution hold --why names the holder in the inhibitor" 0 "held for: rog run 7" -- "${FWI[@]}" execution hold --why "rog run 7" -- true
expect "execution hold passes the command's own status through" 5 "held for" -- "${FWI[@]}" execution hold -- sh -c 'exit 5'
expect "...a signal death's too, which a systemd-inhibit wrapper would have turned into 1" 143 "held for" -- "${FWI[@]}" execution hold -- sh -c 'kill -TERM $$'
printf '#!/nonexistent/interpreter\n' > "$TMP/no-interp.sh"; chmod +x "$TMP/no-interp.sh"
expect "execution hold refuses a script whose interpreter is missing with 127, not the run's 1" 127 "EXECUTION HOLD REFUSED testbox: cannot run $TMP/no-interp.sh" -- "${FWI[@]}" execution hold -- "$TMP/no-interp.sh"
expect "...and so does the slot" 127 "EXECUTION SLOT REFUSED testbox: cannot run $TMP/no-interp.sh" -- "${FWI[@]}" execution slot -- "$TMP/no-interp.sh"
expect "execution hold runs bare where there is no systemd-inhibit" 0 "^bare-hold$" -- "${FWS[@]}" execution hold -- echo bare-hold
expect "execution hold refuses a command that cannot be run" 127 "EXECUTION HOLD REFUSED testbox: cannot run /nonexistent/runner" -- "${FWS[@]}" execution hold -- /nonexistent/runner
expect "execution hold needs a command after --" 2 "a command to hold the box around is required" -- "${FWS[@]}" execution hold --
# The usage cases match the verb and the `-- <command>` tail, not the option list between them, so
# a PR that adds a flag does not edit them; each case's own claim is its negative check.
expect "execution hold takes no slot options" 2 "execution hold .--why <text>. .* -- <command>" -- "${FWS[@]}" execution hold --wait 5 -- true
grep -Eq -- "--(bg|wait|cpu|gpu|probe)" <<<"$out" && ko "...the hold's usage offers a slot option: $out" || ok "...and its usage offers none"
expect "execution slot needs a command after --" 2 "a command to hold the slot around is required" -- "${FWS[@]}" execution slot --
expect "execution slot refuses a non-numeric --wait" 2 "whole number of seconds" -- "${FWS[@]}" execution slot --wait soon -- echo x
expect "execution slot takes no --box: the slot is this box's own" 2 "execution slot .--bg <parent>. .* -- <command>" -- "${FWS[@]}" execution slot --box other -- echo x
grep -q -- "--box" <<<"$out" && ko "...the slot's usage offers --box: $out" || ok "...and its usage offers none"
expect "a malformed slots spec refuses before anything is locked" 1 "<box>=<positive n>" -- \
  env FLEET_BOXES="testbox other" FLEET_BOX_CORRECTNESS_SLOTS="testbox=x" "$FW" execution slot -- echo x
expect "a host with no fleet name has no slot to take" 2 "no fleet name" -- \
  env -u FLEET_LOCAL_BOX FLEET_HOSTNAME_MAP="nomatch*=testbox" "$FW" execution slot -- echo x
expect "a registry that does not answer takes no slot (exit 4)" 4 "^EXECUTION SLOT UNREACHABLE far-anchor: registry unread, no slot taken$" -- \
  env FLEET_ANCHOR=far-anchor "${FWS[@]}" execution slot --wait 0 -- echo x
grep -q "^x$" <<<"$out" && ko "the batch ran over an unread registry: $out" || ok "...and runs nothing"
# ludics-lite#617: still at once, and the refusal tells a caller whose box just woke that only its
# ssh to the anchor may be missing, so a retry may be all it needs.
grep -q "^EXECUTION SLOT UNREACHABLE far-anchor: a box woken in the last few minutes may only need its ssh to far-anchor to come up; retry" <<<"$out" \
  && ok "...and its refusal says a box woken minutes ago may only need its anchor leg, so retry" \
  || ko "the unreachable refusal gives no retry hint for a freshly woken box: $out"
expect "execution hold --why needs its text" 2 "execution hold: expected text for --why" -- "${FWS[@]}" execution hold --why "" -- true
expect "execution slot --cpu and --gpu together are refused whatever their order" 2 "--cpu and --gpu are exclusive" -- "${FWS[@]}" execution slot --gpu --cpu -- true
expect "...while repeating one is not" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 --cpu --cpu -- true
# THE GROUP (ludics-lite#566): the batch leads a process group of its own and the wrapper stays its
# parent, so a --deadline, a signal to the wrapper, or a kill -9 of it ends the batch's whole tree.
# The #1192 benchmark ran on, orphaned on the GPU, for half an hour past an alarm that killed only
# the driver script that started it.
expect "hold --deadline ends the command's tree at the bound, exit 124, naming the bound" 124 "EXECUTION HOLD testbox: --deadline 5s reached" -- \
  "${FWS[@]}" execution hold --deadline 5 -- bash -c "sleep ${GM}1 & wait"
swept 1 && ok "...leaving no sleep behind" || ko "the deadline left the grandchild running: $(pgrep -fl "$(gmre 1)")"
expect "slot --deadline reaches a process orphaned inside the group, as the #1192 benchmark was" 124 "EXECUTION SLOT testbox: --deadline 2s reached" -- \
  "${FWS[@]}" execution slot --wait 0 --deadline 2 -- bash -c "sh -c 'sleep ${GM}2 >/dev/null 2>&1 &'; exec sleep ${GM}3"
swept 2 && swept 3 && ok "...and ends it with the batch" || ko "the deadline missed the orphan: $(pgrep -fl "sleep ${GM}")"
expect "a batch that ends before its deadline takes what it left running with it" 0 "still runs: ending it (--deadline)" -- \
  "${FWS[@]}" execution slot --wait 0 --deadline 60 -- sh -c "sleep ${GM}4 >/dev/null 2>&1 &"
swept 4 && ok "...so nothing of it outlives the slot" || ko "a leftover outlived its deadline-bound batch: $(pgrep -fl "$(gmre 4)")"
# The slot's flock and the sleep guard keep their lifetimes: both end with the group a deadline ends.
"${FWI[@]}" execution slot --wait 0 --deadline 2 -- bash -c "sleep ${GM}9 & wait" > "$TMP/group-guard.log" 2>&1; rc=$?
[ "$rc" -eq 124 ] && grep -q "sleep:idle block inhibitor held" "$TMP/group-guard.log" &&
  ok "a deadline ends a batch under the sleep guard (124)" || ko "the guarded deadline: rc=$rc $(cat "$TMP/group-guard.log")"
gone "$INHIBIT_PID" && ok "...releasing the inhibitor with the group" || ko "the inhibitor outlived the group its deadline ended"
expect "...and the slot" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 0 -- echo after-guarded-deadline
swept 9 || ko "the guarded deadline left its sleep running: $(pgrep -fl "$(gmre 9)")"
# THE NESTED SLOT runs in its enclosing slot's process group: a group of its own would leave its
# tree to the inner wrapper's own reaping, out of the outer group kill's reach.
expect "an outer slot's --deadline ends a grandchild started under a nested slot" 124 "EXECUTION SLOT testbox: --deadline 2s reached" -- \
  "${FWS[@]}" execution slot --wait 0 --deadline 2 -- "$FW" execution slot --wait 0 -- bash -c "sleep ${GM}5 & wait"
swept 5 && ok "...leaving no sleep behind" || ko "the outer deadline missed the nested slot's grandchild: $(pgrep -fl "$(gmre 5)")"
expect "...and one started under a nested slot with a later deadline of its own" 124 "EXECUTION SLOT testbox: --deadline 2s reached" -- \
  "${FWS[@]}" execution slot --wait 0 --deadline 2 -- "$FW" execution slot --wait 0 --deadline 600 -- bash -c "sleep ${GM}6 & wait"
swept 6 && ok "...which the inner wrapper ends when the outer group kill reaches it" || ko "the nested deadline's group outlived the outer deadline: $(pgrep -fl "$(gmre 6)")"
# A signalled wrapper (a harness stopping the task, a Ctrl-C) ends its group, then dies of the
# signal, so its caller reads the status it read when the batch was the pid it signalled.
"${FWS[@]}" execution hold -- bash -c "echo started; sleep ${GM}7 & wait" > "$TMP/group-term.log" 2>&1 &
gt=$!
if held "$TMP/group-term.log" "^started$"; then
  kill -TERM "$gt"; wait "$gt"; rc=$?
  [ "$rc" -eq 143 ] && grep -q "EXECUTION HOLD testbox: SIGTERM received: ending the command's process group" "$TMP/group-term.log" &&
    ok "a hold signalled TERM ends its command's group, then dies of TERM (143)" || ko "the signalled hold: rc=$rc $(cat "$TMP/group-term.log")"
  swept 7 && ok "...leaving no sleep behind" || ko "the signalled hold left its group running: $(pgrep -fl "$(gmre 7)")"
fi
kill -9 "$gt" 2>/dev/null; wait "$gt" 2>/dev/null
# A wrapper killed outright can end nothing: its guardian, in a session of its own, kills the group.
"${FWS[@]}" execution slot --wait 0 -- bash -c "echo started; sleep ${GM}8 & wait" > "$TMP/group-kill.log" 2>&1 &
gk=$!
if held "$TMP/group-kill.log" "^started$"; then
  kill -KILL "$gk"; wait "$gk" 2>/dev/null
  swept 8 && ok "a slot killed outright (SIGKILL) still ends its batch's group, through its guardian" || ko "the killed slot's group ran on: $(pgrep -fl "$(gmre 8)")"
  grep -q "its guardian killed process group" "$TMP/group-kill.log" && ok "...which says so" || ko "the guardian said nothing: $(cat "$TMP/group-kill.log")"
  expect "...and the slot is free" 0 "slot 1 of 1" -- "${FWS[@]}" execution slot --wait 5 -- echo after-guardian
fi
kill -9 "$gk" 2>/dev/null; wait "$gk" 2>/dev/null
expect "--deadline takes a positive whole number of seconds" 2 "--deadline takes a positive whole number of seconds" -- "${FWS[@]}" execution hold --deadline 0 -- true
expect "...in the slot too" 2 "--deadline takes a positive whole number of seconds" -- "${FWS[@]}" execution slot --deadline 5s -- true
expect "--probe takes no --deadline" 2 "--probe takes no --deadline" -- "${FWS[@]}" execution slot --probe --deadline 5
}

section "usage" && {
need_lease
need_worker w1
expect "no command prints usage, exit 2" 2 "Usage:" -- "$FW"
expect "bad worker name refuses" 2 "name must be" -- "$FW" launch testbox "bad name" --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
expect "dot names refuse" 2 "name must be" -- "$FW" launch testbox .. --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
expect "a dot-prefixed name refuses (ls could not see it)" 2 "not start with a dot" -- "$FW" launch testbox .triage --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
expect "unstick validates the name before writing anything" 2 "unstick: name must be" -- "$FW" unstick testbox ../escape --message "$TMP/msg.md"
expect "status validates the name" 2 "status: name must be" -- "$FW" status testbox "a b"
expect "close validates the name" 2 "close: name must be" -- "$FW" close testbox ../escape
expect "close takes no options" 2 "close: unknown option" -- "$FW" close testbox w1 --kill
expect "launch refuses a feeder wait that is not a positive number" 2 "launch: FLEET_FEEDER_WAIT must be a positive number" -- env FLEET_FEEDER_WAIT=0 "$FW" launch testbox fw0 --target-repo example/project --kind claude --brief "$brief" --cwd "$proj"
expect "...and so does unstick" 2 "unstick: FLEET_FEEDER_WAIT must be a positive number" -- env FLEET_FEEDER_WAIT=1s "$FW" unstick testbox w1 --message "$TMP/msg.md"
expect "close is fenced by the lease" 1 "CLOSE REFUSED testbox/w1: coordinator lease held by" -- env FLEET_COORDINATOR=other-session "$FW" close testbox w1
expect "without FLEET_LOCAL_BOX an unrecognized host is local only to 'local'" 0 "EXITED(0) local/w1" -- env -u FLEET_LOCAL_BOX "$FW" status local w1
out=$(env -u FLEET_LOCAL_BOX "$FW" status testbox w1 2>&1); rc=$?
[ "$rc" -eq 4 ] && grep -q "UNREACHABLE testbox" <<<"$out" && ok "...and a named box that is not this host goes over ssh (unreachable here)" || ko "named box without local mapping: rc=$rc $out"
me=$(hostname -s | tr 'A-Z' 'a-z')
expect "FLEET_HOSTNAME_MAP maps this host to a fleet name (glob, first match wins)" 0 "EXITED(0) testbox/w1" -- env -u FLEET_LOCAL_BOX FLEET_HOSTNAME_MAP="nomatch*=other ${me%?}*=testbox *=wrong" "$FW" status testbox w1
expect "...and a map that does not match leaves the host unnamed" 4 "UNREACHABLE testbox" -- env -u FLEET_LOCAL_BOX FLEET_HOSTNAME_MAP="nomatch*=testbox" "$FW" status testbox w1
mkdir "$TMP/glob-cwd"; touch "$TMP/glob-cwd/cache=testbox"
expect "hostname-map tokens do not expand as filenames in the launcher's cwd" 0 "EXITED(0) testbox/w1" -- \
  bash -c 'cd "$1" && exec env -u FLEET_LOCAL_BOX FLEET_HOSTNAME_MAP="*=testbox" "$2" status testbox w1' _ "$TMP/glob-cwd" "$FW"
expect "attach rejects a zero interval" 2 "positive number of seconds" -- "$FW" attach testbox w1 --interval 0
expect "attach rejects a non-numeric interval" 2 "positive number of seconds" -- "$FW" attach testbox w1 --interval fast
expect "missing brief refuses" 2 "readable file" -- "$FW" launch testbox nb --target-repo example/project --kind claude --brief "$TMP/none.md" --cwd "$proj"
( cd "$TMP" && "$FW" launch testbox rel --target-repo example/project --kind claude --brief "$brief" --cwd "pro j" >/dev/null ) && settle rel
grep -q "^cwd=$proj\$" "$ISSUE_WAVE_STATE/workers/rel/meta" && ok "a relative --cwd is recorded as its absolute path" || ko "relative cwd recorded: $(grep '^cwd=' "$ISSUE_WAVE_STATE/workers/rel/meta")"
expect "a path with a newline refuses" 2 "must not contain newlines" -- "$FW" launch testbox nl --target-repo example/project --kind claude --brief "$brief" --cwd "$(printf '%s\nx' "$proj")"
# Every verb but the slot probe runs in Python, through the checkout's scripts/py: a copy of the
# script away from its checkout has none, and says so (exit 2, the environment is wrong) instead of
# leaving it to exec's own error.
mkdir -p "$TMP/stray/issue-wave/scripts" && cp "$FW" "$TMP/stray/issue-wave/scripts/fleet-worker.sh"
expect "a copy of the script away from its checkout names the missing scripts/py, exit 2" 2 \
  "^fleet-worker.sh: no .*/stray/scripts/py: run this script from its skills checkout" -- \
  bash "$TMP/stray/issue-wave/scripts/fleet-worker.sh" status testbox w1
}

section "section watchdog" && {
# ludics-lite#640: a section still running past FLEET_WORKER_TEST_SECTION_TIMEOUT fails the run by
# its name, and nothing of the run outlives it. The run under test is a copy of this suite, in a
# mirror of the checkout's layout (the dispatcher it copies sits beside it), with a stall planted
# at the top of "usage" in the #633 shape: a tmux server on the copy's socket, as a launch starts
# one (a daemon, outside the run's process group, so only a cleanup reaches it), then a `$(...)`
# whose pipe an orphan holds open -- a background `sleep` that ignores TERM. The shell blocked
# reading that pipe ignores TERM too (with an EXIT trap set, bash 3.2 retries the interrupted read),
# so only the KILL ends either, and the copy's own cleanup never runs: the supervisor's has to.
# "load" runs first, so the copy also shows a finished section's elapsed-time line. The copy runs
# with the PATH this suite found and a TMPDIR of its own, which must be empty afterwards (its
# scratch tree and the watchdog's), and writes to a file: a stall the watchdog missed would hold a
# pipe, and this section would hang on it instead of failing.
expect "a section timeout that is not a number of seconds is refused before anything runs" 1 \
  "FLEET_WORKER_TEST_SECTION_TIMEOUT must be a number of seconds, 0, or off, got soon" -- \
  env -u TEST_FLEET_WORKER_WATCH FLEET_WORKER_TEST_SECTION_TIMEOUT=soon "$BASH" "$HERE/test-fleet-worker.sh" usage
wd="$TMP/watchdog"; mir="$TMP/watchdog/copy"
mkdir -p "$mir/issue-wave/scripts" "$mir/scripts" "$wd/tmp" "$wd/nops"
printf '#!/bin/sh\nexit 1\n' > "$wd/nops/ps" && chmod +x "$wd/nops/ps"
expect "a host whose ps cannot print fields is refused, not watched blind (every run would read as over)" 1 \
  "reads processes with ps -o, which this host's ps refuses" -- \
  env -u TEST_FLEET_WORKER_WATCH PATH="$wd/nops:$SUITE_PATH" "$BASH" "$HERE/test-fleet-worker.sh" usage
cp "$HERE/fleet-worker.sh" "$HERE/bg-run.sh" "$mir/issue-wave/scripts/"
[ ! -f "$HERE/fleet-execution.py" ] || cp "$HERE/fleet-execution.py" "$mir/issue-wave/scripts/"
cp "$HERE/../../scripts/py" "$mir/scripts/py"
cp -R "$HERE/../../lib" "$mir/lib"
plant="echo \$\$ > $(printf '%q' "$wd/shell.pid"); tmux -L \"\$FLEET_TMUX_SOCKET\" new-session -d -s stall 'sleep 3571' && : > $(printf '%q' "$wd/had-socket"); held=\$(sh -c 'trap \"\" TERM; echo \$\$ > \"\$0\"; exec sleep 3571' $(printf '%q' "$wd/stall.pid") &)"
PLANT="$plant" awk '{ print } $0 == "section \"usage\" && {" { print ENVIRON["PLANT"] }' "$HERE/test-fleet-worker.sh" \
  > "$mir/issue-wave/scripts/test-fleet-worker.sh"
if grep -qxF -- "$plant" "$mir/issue-wave/scripts/test-fleet-worker.sh"; then
  env -u TEST_FLEET_WORKER_WATCH PATH="$SUITE_PATH" TMPDIR="$wd/tmp" FLEET_WORKER_TEST_SECTION_TIMEOUT=3 \
    "$BASH" "$mir/issue-wave/scripts/test-fleet-worker.sh" load usage > "$wd/out" 2>&1 </dev/null; rc=$?
  out=$(cat "$wd/out")
  [ "$rc" -eq 1 ] && grep -qx 'FAIL: section "usage" still running after 3s (FLEET_WORKER_TEST_SECTION_TIMEOUT; raise it on a box this slow); the run'"'"'s process group was stopped' <<<"$out" &&
    ok "a section past FLEET_WORKER_TEST_SECTION_TIMEOUT fails the run by its name, exit 1" ||
    ko "the stalled section was not failed by name (rc=$rc) -- $out"
  grep -qx -- '--- [0-9]*s: load' <<<"$out" && ok "...after the section before it printed its elapsed time" ||
    ko "no elapsed-time line for the finished section -- $out"
  stall=$(cat "$wd/stall.pid" 2>/dev/null) shell=$(cat "$wd/shell.pid" 2>/dev/null)
  if [ -n "$stall" ] && [ -n "$shell" ]; then
    # A settle, not a deadline: the stall sleeps for an hour unless the watchdog killed it.
    tries=0
    while proc_alive "$stall" && [ "$tries" -lt 20 ]; do sleep 0.1; tries=$((tries + 1)); done
    if proc_alive "$stall"; then
      ko "the TERM-ignoring stall (pid $stall) outlived the watchdog"; kill -KILL "$stall" 2>/dev/null
    else ok "...and the stall that ignored TERM did not outlive it"; fi
    if [ ! -e "$wd/had-socket" ]; then ko "the copy's tmux server never started, so nothing checks its removal"
    elif [ ! -e "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/fwtest-$shell" ]; then ok "...nor did the copy's tmux server"
    else ko "the stopped copy left its tmux socket fwtest-$shell"; fi
  else ko "the planted stall never ran, so nothing here checks the stop -- $out"; fi
  left=$(ls -A "$wd/tmp")
  [ -z "$left" ] && ok "...nor its scratch tree or the watchdog's" || ko "the stopped copy left in its TMPDIR: $left"
else ko "could not plant the stall in the copy of the suite (setup)"; fi
}

section_left
echo
if [ "$NAMED" -eq 1 ]; then
  echo "$pass passed, $fail failed (${#SELECTED[@]} of ${#SECTIONS[@]} sections) in ${SECONDS}s"
else
  echo "$pass passed, $fail failed in ${SECONDS}s"
fi
[ "$fail" -eq 0 ]
exit "$?"
}
