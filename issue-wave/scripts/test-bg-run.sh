#!/usr/bin/env bash
# Exercises bg-run.sh with real background processes in a scratch directory -- no network, no
# harness. The command under test is always a small `sh -c` fixture, and every wait runs with a
# 1 s poll (BG_RUN_POLL=1) so the suite takes seconds rather than the production cadence.
#
# What it pins:
#   - a finished run reads rc=<its exit status> with exit 0, whatever that status is, and the
#     background `start` itself exits with it too, its directory left holding cpid, log, pid and rc;
#   - `new` allocates: it creates the parent and prints <parent>/run-<N>, holding only its `.new`
#     token, one past the highest run-<N> there (other names not counted); two `new`s racing for the same N each get
#     a directory of their own, and a copy without the exclusive mkdir is the control that
#     hands both the same one; a parent it cannot write in, or that is a file, is an error, not an
#     endless search; a wait on a `new` directory before `start` reads STARTING, and `start`
#     there runs and reads rc;
#   - race 1: a task killed before its command returned (so no rc is ever written) reads DIED,
#     promptly, rather than RUNNING until the window is spent -- with RUNNING as the control
#     while it was alive;
#   - race 2: output that quotes `rc=`, DIED or REFUSED cannot settle a wait, because the status is
#     a file the command's output does not reach: the wait reads RUNNING while that output sits
#     in the log, and then the real status;
#   - race 3: a wait that runs before the pid is published reads STARTING, never DIED -- on an
#     absent directory and on an empty one -- gives up on it after the start grace rather than
#     the whole window, and a wait already polling when `start` runs picks the run up;
#   - a wrapper killed alone while its command runs on reads RUNNING, not DIED, through cpid; and
#     a command that exited unreaped (a zombie, which still answers kill -0) reads DIED, and so
#     does a pid the system has reused for a process with another start time;
#   - `start` runs only in a directory `new` allocated and no start has claimed (ludics-lite#425):
#     it refuses, runs nothing and writes nothing, on a path that does not exist, on a directory
#     `new` did not make, and on one a start has claimed -- a finished run's, whose rc and log stay
#     untouched and which a wait still reads as that run's (the caller error the retired ended-run
#     marker used to catch, pinned here as accepted), and a live run's, which a wait still reads as
#     RUNNING;
#   - two starts racing on one fresh directory: exactly one runs its command, the other is refused
#     and leaves the winner's verdict alone -- also when the winner has already finished by the
#     time the loser's claim fails;
#   - a --within shorter than the poll interval is spent in full rather than answered at once;
#   - a wait that reaches its bound says `RUNNING after <e> s of --within <w>` (a STARTING line
#     likewise), and while it blocks prints heartbeat lines on stderr only, none starting with a
#     verdict word, none with BG_RUN_HEARTBEAT=0;
#   - the finish-between-reads order: a dead pid beside an rc reads rc, not DIED;
#   - the usage errors (relative directory, missing `--`, a --within that is not a number), and
#     that a zero-padded number is read as decimal;
#   - `spawn` returns while its command runs, with the pid already published, printing the
#     directory `new` would have and nothing else; a wait there reads RUNNING, then the command's
#     status, its arguments intact in the log, the directory in start's layout; its usage errors
#     create nothing;
#   - the command starts with SIGINT, SIGQUIT, SIGHUP and SIGTERM at their default dispositions
#     (ludics-lite#524): a spawned command that signals itself dies of it, also when the caller had
#     all four ignored, and so does one under a `start` launched with `&` (INT and QUIT ignored);
#     a copy with the reset emptied is the control, whose command survives each;
#   - `stop` (ludics-lite#510) ends a spawned run's whole group, a grandchild behind an exited
#     subshell included, from a caller that survives it, and a wait there then reads STOPPED
#     (exit 7, ludics-lite#638), never DIED, its `stopped` marker the one file added; it sends
#     KILL after BG_RUN_STOP_GRACE to a command that ignores TERM; it signals nothing, exit 1, on a
#     run that finished, one never started, one already stopped, and a pid the system has reused
#     for another process; and it refuses, exit 2, a run started by `start` in a group it does not
#     lead, which runs on;
#   - STOPPED (ludics-lite#638): a stop ended inside its grace, the wrapper gone but a member of its
#     group left, reads RUNNING, not DIED (the marker is in before the signal) and not STOPPED;
#     a second stop ends that remnant, and the run then reads STOPPED. Staged: a dead pid with the
#     marker reads STOPPED, with an rc beside it rc, and without the marker DIED (the control); a
#     live process that has since taken the wrapper's pid, leading a group of its own, is not
#     read as the run's group;
#   - when zsh is installed, a start issued through `zsh -c` the way the Bash tool issues it,
#     with its arguments passed through intact.
#
# Usage: test-bg-run.sh   (exit 0 all pass, 1 otherwise)

set -uo pipefail

# One brace group, so bash parses this file WHOLE before its first line runs and an edit landing
# while a run is in flight cannot resume the shell at a shifted offset; the `exit` at the foot
# means the shell never comes back to the file for a next command. Two lines here and two at the
# foot, with the body's own indentation untouched (ludics-lite#10, #247); scripts/check-parse-guards.sh
# checks the shape.
{
HERE=$(cd "$(dirname "$0")" && pwd)
BG="$HERE/bg-run.sh"
export BG_RUN_POLL=1
TMP=$(mktemp -d "${TMPDIR:-/tmp}/bg-run-test.XXXXXX") || exit 1
# Physical path, so the directories the cases name are the ones bg-run.sh sees; on macOS $TMPDIR
# sits under /var, a link to /private/var.
TMP=$(CDPATH= cd "$TMP" && pwd -P) || exit 1
# Every background process a case starts is recorded here and killed on the way out, so a failed
# case cannot leave a sleeper behind.
BGPIDS=
trap 'for p in $BGPIDS; do kill -9 "$p" 2>/dev/null; done; rm -rf "$TMP"' EXIT
# From inside it, so the relative-directory cases below cannot touch the caller's tree.
cd "$TMP" || exit 1

pass=0; fail=0
# Both report and then RETURN 0 explicitly, for the `<test> && ok ... || ko ...` house style.
ok() { pass=$((pass + 1)); echo "PASS: $*"; return 0; }
ko() { fail=$((fail + 1)); echo "FAIL: $*"; return 0; }
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
# expect <label> <want-rc> <want-substring> -- <cmd...>; leaves the output in $out, rc in $rc.
expect() {
  local label="$1" want_rc="$2" want="$3"; shift 3; [ "$1" = -- ] && shift
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq "$want_rc" ] && contains "$out" "$want"; then ok "$label"
  else ko "$label (rc=$rc want $want_rc; want /$want/) -- $out"; fi
}
# until_file <path> <seconds>: poll for a nonempty file; 0 once it is there. until_exists: any file.
until_file() {
  local i=0
  while [ "$i" -lt $(($2 * 5)) ]; do [ -s "$1" ] && return 0; sleep 0.2; i=$((i + 1)); done
  return 1
}
until_exists() {
  local i=0
  while [ "$i" -lt $(($2 * 5)) ]; do [ -e "$1" ] && return 0; sleep 0.2; i=$((i + 1)); done
  return 1
}
# fresh <name>: a run directory from `new` under $TMP/<name>, in d.
fresh() { d=$("$BG" new "$TMP/$1") || ko "new under $TMP/$1 failed"; }
# bg_start <dir> <cmd...>: `start` in the background, the way the Bash tool runs it; its pid in S.
bg_start() {
  local d=$1; shift
  "$BG" start "$d" -- "$@" > /dev/null 2>&1 &
  S=$!; BGPIDS="$BGPIDS $S"
}

# --- a finished run ------------------------------------------------------------------------------
fresh finished
bg_start "$d" sh -c 'echo hello; exit 7'
expect "a finished run reads rc=7, exit 0" 0 'rc=7' -- "$BG" wait "$d" --within 20
wait "$S"; src=$?
[ "$src" -eq 7 ] && ok "...and the background start exits with the command's status" \
  || ko "the background start exited $src, want 7"
[ "$(cat "$d/log")" = hello ] && ok "...and the command's output is in log" \
  || ko "log holds: $(cat "$d/log")"
[ "$(ls -A "$d" | tr '\n' ' ')" = "cpid log pid rc " ] && ok "...and the directory holds cpid, log, pid, rc and nothing else" \
  || ko "the directory holds: $(ls -A "$d" | tr '\n' ' ')"
fresh finished0
fin0=$d
bg_start "$d" true
expect "a run exiting 0 reads rc=0" 0 'rc=0' -- "$BG" wait "$d" --within 20

# --- new: the run directory allocated for the caller ----------------------------------------------
p="$TMP/runs"
expect "new on an absent parent creates it and prints run-1" 0 "$p/run-1" -- "$BG" new "$p"
[ "$out" = "$p/run-1" ] && ok "...and prints that path and nothing else" || ko "new printed: $out"
[ -d "$p/run-1" ] && [ "$(ls -A "$p/run-1")" = .new ] && ok "...a directory holding only new's token" \
  || ko "run-1 is not a directory holding only .new: $(ls -A "$p/run-1" 2>&1)"
expect "a second new prints run-2" 0 "$p/run-2" -- "$BG" new "$p/"
[ "$out" = "$p/run-2" ] && ok "...with the parent's trailing slash dropped" || ko "new printed: $out"
mkdir "$p/run-7"; : > "$p/run-12x"; mkdir "$p/other"; : > "$p/run-"; mkdir "$p/run-0000000000099"
expect "new counts past the highest run-<N>, not the other names beside it" 0 "$p/run-8" -- "$BG" new "$p"
: > "$p/run-9"
expect "a FILE named run-<N> is counted too, and never reused" 0 "$p/run-10" -- "$BG" new "$p"
# The race: two `new`s held past the scan until both are there, so both try the same N and only
# the exclusive mkdir can tell them apart. The control patches it into `mkdir -p`, which must then
# hand both the same directory.
# twin_news <script> <parent>: sets TWIN_OUT (the two printed paths, sorted) and TWIN_NRCS.
twin_news() {
  local gate="$2.gate" a b ra rb i=0
  mkdir -p "$2"
  BG_RUN_NEW_GATE=$gate "$1" new "$2" > "$2.a" 2>&1 &
  a=$!
  BG_RUN_NEW_GATE=$gate "$1" new "$2" > "$2.b" 2>&1 &
  b=$!
  BGPIDS="$BGPIDS $a $b"
  while [ -z "$(find "$TMP" -maxdepth 1 -name "${gate##*/}.$a")" ] \
    || [ -z "$(find "$TMP" -maxdepth 1 -name "${gate##*/}.$b")" ]; do
    [ "$i" -lt 100 ] || break
    sleep 0.1; i=$((i + 1))
  done
  : > "$gate"
  wait "$a"; ra=$?; wait "$b"; rb=$?
  TWIN_OUT=$(cat "$2.a" "$2.b" | sort | tr '\n' ' ')
  TWIN_NRCS="$ra $rb"
}
twin_news "$BG" "$TMP/twin-new"
[ "$TWIN_NRCS" = "0 0" ] && [ "$TWIN_OUT" = "$TMP/twin-new/run-1 $TMP/twin-new/run-2 " ] \
  && ok "two news racing for one N each get a directory of their own (run-1, run-2)" \
  || ko "twin news exited $TWIN_NRCS and printed: $TWIN_OUT"
sed 's|if mkdir -- "$base/run-$n"|if mkdir -p -- "$base/run-$n"|' "$BG" > "$TMP/unexclusive.sh"
chmod +x "$TMP/unexclusive.sh"
if cmp -s "$BG" "$TMP/unexclusive.sh"; then
  ko "control: the patch found no exclusive mkdir to replace in $BG"
else
  twin_news "$TMP/unexclusive.sh" "$TMP/twin-new-control"
  [ "$TWIN_OUT" = "$TMP/twin-new-control/run-1 $TMP/twin-new-control/run-1 " ] \
    && ok "control: with mkdir -p, both news print run-1" \
    || ko "control: the copy without the exclusive mkdir printed $TWIN_OUT, so the case above proves nothing"
fi
: > "$TMP/a-file"
expect "new under a parent that is a file is refused" 2 'cannot create' -- "$BG" new "$TMP/a-file"
p="$TMP/locked"; mkdir -p "$p"; chmod 555 "$p"
if [ -w "$p" ]; then
  echo "SKIP: a mode-555 directory is still writable here (root, or no POSIX modes); the unwritable parent is not exercised"
else
  t0=$SECONDS
  expect "new in a parent it cannot write in is refused" 2 'cannot create a run directory' -- "$BG" new "$p"
  [ $((SECONDS - t0)) -le 3 ] && ok "...at once, not after a search" || ko "the refusal took $((SECONDS - t0)) s"
fi
chmod 755 "$p"
d=$("$BG" new "$TMP/runs2")
expect "a wait on a new directory before start reads STARTING" 4 STARTING -- \
  env BG_RUN_START_GRACE=60 "$BG" wait "$d" --within 0
bg_start "$d" sh -c 'echo from-new; exit 5'
expect "...and start there runs and reads rc=5" 0 'rc=5' -- "$BG" wait "$d" --within 20
[ "$(cat "$d/log")" = from-new ] && ok "...with its output in log" || ko "log holds: $(cat "$d/log")"

# --- race 1: the task is killed before the command returns ---------------------------------------
fresh killed
bg_start "$d" sh -c 'echo "$$" > "$0"; exec sleep 60' "$TMP/killed.child"
if until_file "$d/pid" 10 && until_file "$TMP/killed.child" 10; then
  child=$(cat "$TMP/killed.child"); BGPIDS="$BGPIDS $child"
  expect "control: while the task lives, a wait reads RUNNING (exit 3)" 3 RUNNING -- "$BG" wait "$d" --within 0
  kill -9 "$S" "$child" 2>/dev/null
  { wait "$S"; } 2>/dev/null
  t0=$SECONDS
  expect "race 1: a killed task that wrote no rc reads DIED (exit 5)" 5 DIED -- "$BG" wait "$d" --within 30
  [ $((SECONDS - t0)) -le 3 ] && ok "...at once, not at the end of the window" \
    || ko "DIED took $((SECONDS - t0)) s of a 30 s window"
  [ ! -e "$d/rc" ] && ok "...and no rc was invented for it" || ko "an rc appeared: $(cat "$d/rc")"
else
  ko "race 1: the fixture task never published its pid"
fi
fresh orphan
bg_start "$d" sleep 60
if until_file "$d/pid" 10 && until_file "$d/cpid" 10; then
  child=$(head -n 1 "$d/cpid"); BGPIDS="$BGPIDS $child"
  kill -9 "$S" 2>/dev/null
  { wait "$S"; } 2>/dev/null
  expect "a wrapper killed alone, its command still running, reads RUNNING, not DIED" 3 RUNNING -- \
    "$BG" wait "$d" --within 0
  kill -9 "$child" 2>/dev/null
  expect "...and DIED once the command is gone too" 5 DIED -- "$BG" wait "$d" --within 5
else
  ko "the orphan fixture never published its pid and cpid"
fi

# A command that exited as an orphan under a parent that never reaps it is a zombie, which still
# answers kill -0. Made here by a shell that backgrounds an exiting child and then execs a sleep,
# which never waits for it.
d="$TMP/zombie"; mkdir -p "$d"
sh -c 'sleep 0 & echo "$!" > "$0"; exec sleep 30' "$d/cpid" &
zp=$!; BGPIDS="$BGPIDS $zp"
printf '99999999\n' > "$d/pid"
zombie_seen=false
if until_file "$d/cpid" 10; then
  z=$(head -n 1 "$d/cpid")
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    case $(ps -o stat= -p "$z" 2>/dev/null | tr -d ' ') in Z*) zombie_seen=true; break ;; esac
    sleep 0.2
  done
fi
if $zombie_seen && kill -0 "$z" 2>/dev/null; then
  ok "control: the fixture command is a zombie that still answers kill -0"
  expect "a zombie command beside a dead wrapper reads DIED, not RUNNING" 5 DIED -- "$BG" wait "$d" --within 0
else
  ko "the zombie fixture did not produce a zombie that answers kill -0"
fi
kill -9 "$zp" 2>/dev/null; { wait "$zp"; } 2>/dev/null

# A pid the system has reused: the file names a live process, but one that started at another time
# than the run recorded. A live sleep stands in for the unrelated process; the controls are the
# same pid with its own start time recorded, and with none recorded (where ps could not say).
sleep 30 &
sp=$!; BGPIDS="$BGPIDS $sp"
sp_start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$sp" 2>/dev/null | tr -d ' ')
if [ -n "$sp_start" ]; then
  d="$TMP/reused"; mkdir -p "$d"
  printf '%s\n%s\n' "$sp" 'ThuJan100:00:001970' > "$d/pid"
  expect "a reused pid (live, but started at another time) reads DIED, not RUNNING" 5 DIED -- \
    "$BG" wait "$d" --within 0
  d="$TMP/same-start"; mkdir -p "$d"
  printf '%s\n%s\n' "$sp" "$sp_start" > "$d/pid"
  expect "control: the same pid with its own start time reads RUNNING" 3 RUNNING -- "$BG" wait "$d" --within 0
else
  ko "ps -o lstart= gave nothing for a live process here, so the reuse case cannot be built"
fi
d="$TMP/no-start"; mkdir -p "$d"
printf '%s\n' "$sp" > "$d/pid"
expect "control: a pid with no start time recorded falls back to kill -0 (RUNNING)" 3 RUNNING -- \
  "$BG" wait "$d" --within 0
kill -9 "$sp" 2>/dev/null; { wait "$sp"; } 2>/dev/null

# --- race 2: the command's output quotes the verdicts --------------------------------------------
fresh quoting
bg_start "$d" sh -c 'printf "rc=0\nDIED\nREFUSED: no\n"; sleep 3; exit 7'
if until_file "$d/log" 10; then
  expect "race 2: output quoting rc=0 does not settle the wait (RUNNING)" 3 RUNNING -- "$BG" wait "$d" --within 0
  expect "...and the wait then reads the command's real status" 0 'rc=7' -- "$BG" wait "$d" --within 20
  contains "$(cat "$d/log")" 'rc=0' && ok "...while the log still quotes rc=0" \
    || ko "the log lost its rc=0 line: $(cat "$d/log")"
else
  ko "race 2: the fixture command wrote no log"
fi

# --- race 3: the wait runs before the pid is published -------------------------------------------
d="$TMP/absent"
expect "race 3: no directory yet reads STARTING (exit 4), not DIED" 4 STARTING -- \
  env BG_RUN_START_GRACE=60 "$BG" wait "$d" --within 1
[ ! -e "$d" ] && ok "...and the wait created nothing" || ko "the wait created $d"
d="$TMP/empty"; mkdir -p "$d"
expect "race 3: an empty directory reads STARTING, not DIED" 4 STARTING -- \
  env BG_RUN_START_GRACE=60 "$BG" wait "$d" --within 1
t0=$SECONDS
expect "race 3: no pid within the start grace reads STARTING" 4 STARTING -- \
  env BG_RUN_START_GRACE=2 "$BG" wait "$TMP/never" --within 540
[ $((SECONDS - t0)) -le 6 ] && ok "...after the grace, not the 540 s window" \
  || ko "STARTING took $((SECONDS - t0)) s with a 2 s grace"
fresh late
"$BG" wait "$d" --within 30 > "$TMP/late.out" 2>&1 &
W=$!; BGPIDS="$BGPIDS $W"
sleep 2
bg_start "$d" sh -c 'exit 0'
wait "$W"; wrc=$?
[ "$wrc" -eq 0 ] && contains "$(cat "$TMP/late.out")" 'rc=0' \
  && ok "race 3: a wait already polling when start runs picks the run up (rc=0)" \
  || ko "the early wait exited $wrc -- $(cat "$TMP/late.out")"

# --- start runs only in a directory new allocated and no start has claimed (ludics-lite#425) -----
expect "start on a path that does not exist is refused (exit 2)" 2 'does not exist' -- \
  "$BG" start "$TMP/named" -- sh -c 'touch "$0"' "$TMP/named.ran"
[ ! -e "$TMP/named" ] && [ ! -e "$TMP/named.ran" ] && ok "...creates nothing and runs nothing" \
  || ko "the refused start created its directory or ran its command"
d="$TMP/self-made"; mkdir -p "$d"
expect "start in a directory new did not allocate is refused" 2 'not allocated by new' -- \
  "$BG" start "$d" -- sh -c 'touch "$0"' "$TMP/self.ran"
[ -z "$(ls -A "$d")" ] && [ ! -e "$TMP/self.ran" ] && ok "...writes nothing there and runs nothing" \
  || ko "the refused start ran or wrote: $(ls -A "$d")"
expect "...and a wait there reads STARTING, as for any directory no start claimed" 4 STARTING -- \
  env BG_RUN_START_GRACE=60 "$BG" wait "$d" --within 0
# A path new printed, handed to a second start after its run ended: refused, runs nothing, and
# writes nothing, so a wait there reads the FIRST run's status. That is the caller error the
# retired ended-run marker turned into REFUSED; this pins that it is accepted, not missed.
fresh reused
bg_start "$d" sh -c 'echo first; exit 3'
expect "a run to reuse finishes (rc=3)" 0 'rc=3' -- "$BG" wait "$d" --within 20
expect "a second start on a finished run's directory is refused" 2 'already claimed' -- \
  "$BG" start "$d" -- sh -c 'touch "$0"; exit 9' "$TMP/reused.ran"
[ ! -e "$TMP/reused.ran" ] && ok "...and runs nothing" || ko "the refused start ran its command"
[ "$(cat "$d/rc")" = 3 ] && [ "$(cat "$d/log")" = first ] && [ "$(ls -A "$d" | tr '\n' ' ')" = "cpid log pid rc " ] \
  && ok "...and leaves the earlier run's files as they were, adding none" \
  || ko "the earlier run's directory changed: $(ls -A "$d" | tr '\n' ' ')"
expect "...so a wait there reads the earlier run's rc=3: the accepted caller error" 0 'rc=3' -- "$BG" wait "$d" --within 0
fresh stale-live
bg_start "$d" sleep 30
live=$S
if until_file "$d/pid" 10; then
  expect "a start over a live run is refused and runs nothing" 2 'already claimed' -- \
    "$BG" start "$d" -- sh -c 'touch "$0"' "$TMP/live.ran"
  [ ! -e "$TMP/live.ran" ] && ok "...its command did not run" || ko "the refused start ran its command"
  expect "...and leaves the live run's verdict alone (RUNNING)" 3 RUNNING -- \
    "$BG" wait "$d" --within 0
else
  ko "the live fixture never published its pid"
fi
kill -9 "$live" 2>/dev/null; { wait "$live"; } 2>/dev/null
[ -s "$d/cpid" ] && kill -9 "$(head -n 1 "$d/cpid")" 2>/dev/null

# Two starts racing on one fresh directory (a duplicated tool call, a retry): exactly one may run
# its command. BG_RUN_CLAIM_GATE holds both past the token check until both are there, so the
# claim is what decides and the race is lost every time rather than by luck; the control is a copy whose exclusive link
# is patched into an overwriting rename, which must then run the command twice.
# twin_starts <script> <name>: launch two starts at once on one directory new allocates under
# $TMP/<name>; sets TWIN_DIR, TWIN_RAN (times the command ran) and TWIN_RCS (the two start exits).
twin_starts() {
  local ran="$2.ran" gate="$2.gate" a b ra rb i=0
  TWIN_DIR=$("$1" new "$2")
  BG_RUN_CLAIM_GATE=$gate "$1" start "$TWIN_DIR" -- sh -c 'echo x >> "$0"; sleep 1' "$ran" > /dev/null 2>&1 &
  a=$!
  BG_RUN_CLAIM_GATE=$gate "$1" start "$TWIN_DIR" -- sh -c 'echo x >> "$0"; sleep 1' "$ran" > /dev/null 2>&1 &
  b=$!
  BGPIDS="$BGPIDS $a $b"
  # Open the gate once both starts stand at it (or after 10 s, when the counts below say why).
  while [ -z "$(find "$TMP" -maxdepth 1 -name "${gate##*/}.$a")" ] \
    || [ -z "$(find "$TMP" -maxdepth 1 -name "${gate##*/}.$b")" ]; do
    [ "$i" -lt 100 ] || break
    sleep 0.1; i=$((i + 1))
  done
  : > "$gate"
  wait "$a"; ra=$?; wait "$b"; rb=$?
  TWIN_RAN=$(grep -c x "$ran" 2>/dev/null); TWIN_RAN=${TWIN_RAN:-0}
  TWIN_RCS=$(printf '%s\n' "$ra" "$rb" | sort | tr '\n' ' ')
}
twin_starts "$BG" "$TMP/twin"
[ "$TWIN_RAN" -eq 1 ] && [ "$TWIN_RCS" = "0 2 " ] \
  && ok "twin starts on one directory: the command ran once and the other start was refused" \
  || ko "twin starts: the command ran $TWIN_RAN time(s); the starts exited $TWIN_RCS"
expect "...and the losing start left the winner's verdict alone (rc=0)" 0 'rc=0' -- \
  "$BG" wait "$TWIN_DIR" --within 0
# A start that loses the claim to a winner that has already FINISHED: the start is held past the
# token check, a finished run is put in place under it, and then it is let go. It must write
# nothing, so the winner's rc is what a wait reads.
fresh lost-to-finished
BG_RUN_CLAIM_GATE="$d.gate" "$BG" start "$d" -- sh -c 'touch "$0"' "$TMP/lost.ran" > "$TMP/lost.out" 2>&1 &
L=$!; BGPIDS="$BGPIDS $L"
if until_exists "$d.gate.$L" 10; then
  printf '%s\n' 99999999 > "$d/pid"; printf '0\n' > "$d/rc"; : > "$d/log"
  : > "$d.gate"
  wait "$L"; lrc=$?
  [ "$lrc" -eq 2 ] && contains "$(cat "$TMP/lost.out")" 'claimed' && [ ! -e "$TMP/lost.ran" ] \
    && ok "a start that loses the claim to a finished run is refused and runs nothing" \
    || ko "the losing start exited $lrc, ran=$([ -e "$TMP/lost.ran" ] && echo yes || echo no) -- $(cat "$TMP/lost.out")"
  expect "...and writes nothing: a wait reads the winner's rc=0" 0 'rc=0' -- "$BG" wait "$d" --within 0
else
  ko "the gated start never reached the gate"
fi

sed 's|ln -- "$dir/.pid.$$" "$dir/pid"|mv -f -- "$dir/.pid.$$" "$dir/pid"|' "$BG" > "$TMP/unclaimed.sh"
chmod +x "$TMP/unclaimed.sh"
if cmp -s "$BG" "$TMP/unclaimed.sh"; then
  ko "control: the patch found no exclusive link to replace in $BG"
else
  twin_starts "$TMP/unclaimed.sh" "$TMP/twin-control"
  [ "$TWIN_RAN" -eq 2 ] && ok "control: with an overwriting rename for the claim, both starts run the command" \
    || ko "control: the unclaimed copy ran the command $TWIN_RAN time(s), so the case above proves nothing"
fi

# The window is spent in full when it is shorter than the poll: a running command with --within 3
# and a 10 s poll holds the call ~3 s rather than answering at once.
fresh short-window
bg_start "$d" sleep 30
if until_file "$d/pid" 10; then
  t0=$(date +%s)
  expect "a --within shorter than the poll still reads RUNNING" 3 RUNNING -- \
    env BG_RUN_POLL=10 "$BG" wait "$d" --within 3
  took=$(( $(date +%s) - t0 ))
  [ "$took" -ge 2 ] && [ "$took" -le 6 ] && ok "...after the 3 s window (took ${took} s), not at once" \
    || ko "a 3 s window with a 10 s poll took ${took} s"
  [ -s "$d/cpid" ] && kill -9 "$(head -n 1 "$d/cpid")" 2>/dev/null
else
  ko "the short-window fixture never published its pid"
fi
kill -9 "$S" 2>/dev/null; { wait "$S"; } 2>/dev/null

# A wait that reaches its bound names the elapsed time and the bound on its RUNNING line, and says
# it is still waiting at each heartbeat (here every 1 s) on stderr only, never in a line that starts
# with a verdict word; stdout stays the one verdict line (ludics-lite#571).
fresh heartbeat
bg_start "$d" sleep 30
if until_file "$d/pid" 10; then
  env BG_RUN_HEARTBEAT=1 "$BG" wait "$d" --within 3 > "$TMP/hb.out" 2> "$TMP/hb.err"; hrc=$?
  hout=$(cat "$TMP/hb.out"); herr=$(cat "$TMP/hb.err")
  case $hout in
    'RUNNING after '[3-6]' s of --within 3') [ "$hrc" -eq 3 ] \
      && ok "a wait that reaches its bound says how long it waited, against which bound ($hout)" \
      || ko "the bound-reached wait exited $hrc, want 3 -- $hout" ;;
    *) ko "the bound-reached wait printed /$hout/ (rc=$hrc), want 'RUNNING after <3..6> s of --within 3'" ;;
  esac
  beats=$(printf '%s\n' "$herr" | grep -c '^bg-run: still waiting after [1-9][0-9]* s of --within 3 (the run is live)$')
  # Two beats fit the 3 s window (at 1 s and 2 s); a loaded box may stretch a 1 s poll past one.
  [ "$beats" -ge 1 ] && ok "...with a heartbeat line on stderr while it blocked ($beats of them)" \
    || ko "want a heartbeat line on stderr, got $beats -- $herr"
  if printf '%s\n' "$herr" | grep -E -q '^(rc=|RUNNING|STARTING|STOPPED|DIED|REFUSED)'; then
    ko "a heartbeat line starts with a verdict word -- $herr"
  else
    ok "...none of which starts with a verdict word"
  fi
  [ "$(printf '%s\n' "$hout" | wc -l | tr -d ' ')" = 1 ] && ok "...and stdout holds the one verdict line" \
    || ko "stdout holds more than the verdict -- $hout"
  expect "a poll slower than the heartbeat still wakes for it" 3 'bg-run: still waiting after' -- \
    env BG_RUN_POLL=10 BG_RUN_HEARTBEAT=1 "$BG" wait "$d" --within 3
  expect "BG_RUN_HEARTBEAT=0 prints no heartbeat" 3 'RUNNING after' -- \
    env BG_RUN_HEARTBEAT=0 "$BG" wait "$d" --within 2
  contains "$out" 'still waiting' && ko "a heartbeat was printed with BG_RUN_HEARTBEAT=0 -- $out" \
    || ok "...and says nothing while it blocks"
  # $SECONDS ticks on whole seconds, so a read that straddles a tick says 1 s (main went red on
  # it, 2026-10-17); what the case pins is that the wait returns at once, with its bound named.
  expect "a --within 0 wait reads 'RUNNING after <0|1> s of --within 0'" 3 ' s of --within 0' -- \
    "$BG" wait "$d" --within 0
  case $out in 'RUNNING after '[01]' s of --within 0') ok "...at once ($out)" ;;
    *) ko "the --within 0 wait printed /$out/" ;; esac
  [ -s "$d/cpid" ] && kill -9 "$(head -n 1 "$d/cpid")" 2>/dev/null
else
  ko "the heartbeat fixture never published its pid"
fi
kill -9 "$S" 2>/dev/null; { wait "$S"; } 2>/dev/null
expect "usage: a BG_RUN_HEARTBEAT that is not a number is refused" 2 'whole number' -- \
  env BG_RUN_HEARTBEAT=often "$BG" wait "$TMP/u6" --within 0
expect "a STARTING wait names its elapsed time and bound too" 4 ' s of --within 1' -- \
  "$BG" wait "$TMP/never-started" --within 1
case $out in 'STARTING after '[1-3]' s of --within 1') ok "...as 'STARTING after <e> s of --within 1' ($out)" ;;
  *) ko "the STARTING line reads /$out/" ;; esac

# --- the finish-between-reads order ------------------------------------------------------------------
d="$TMP/dead-with-rc"; mkdir -p "$d"
printf '99999999\n' > "$d/pid"; printf '3\n' > "$d/rc"
expect "a dead pid beside an rc reads rc=3, not DIED" 0 'rc=3' -- "$BG" wait "$d" --within 0
d="$TMP/dead-no-rc"; mkdir -p "$d"
printf '99999999\n' > "$d/pid"
expect "control: a dead pid with no rc reads DIED" 5 DIED -- "$BG" wait "$d" --within 0
# The stop marker (ludics-lite#638): the same dead pid reads STOPPED once a stop has marked it, and
# an rc beside the marker still wins.
: > "$d/stopped"
expect "a dead pid with no rc and a stop's marker reads STOPPED (exit 7), not DIED" 7 \
  'STOPPED by bg-run.sh stop before the command returned' -- "$BG" wait "$d" --within 0
expect "...and stop there signals nothing (NOT RUNNING: STOPPED)" 1 'NOT RUNNING: STOPPED' -- "$BG" stop "$d"
printf '143\n' > "$d/rc"
expect "an rc beside a stop's marker reads rc: the command returned" 0 'rc=143' -- "$BG" wait "$d" --within 0
# A live process that has taken the wrapper's pid since, leading a group of its own, is another
# process (its start time differs), and its group is not the run's: STOPPED, not RUNNING.
set -m
sleep 30 &
sp=$!
set +m
BGPIDS="$BGPIDS $sp"
d="$TMP/stopped-reused"; mkdir -p "$d"
printf '%s\n%s\n' "$sp" 'ThuJan100:00:001970' > "$d/pid"; cp "$d/pid" "$d/cpid"; : > "$d/stopped"
expect "a stopped run whose wrapper pid a new group leader has taken reads STOPPED" 7 STOPPED -- "$BG" wait "$d" --within 0
kill -9 "$sp" 2>/dev/null; { wait "$sp"; } 2>/dev/null

# --- spawn: new plus a detached start, in one call that returns ------------------------------------
p="$TMP/spawned"
# The command waits on a gate file, so the spawn is shown returning while it still runs.
expect "spawn returns while its command runs, printing the run directory new allocates" 0 "$p/run-1" -- \
  "$BG" spawn "$p" -- sh -c 'while [ ! -e "$0" ]; do sleep 0.1; done; printf "%s\n" "$@"; exit 5' "$TMP/spawn-gate" 'a b' '$HOME'
[ "$out" = "$p/run-1" ] && ok "...and prints that path and nothing else" || ko "spawn printed: $out"
d="$p/run-1"
for f in pid cpid; do [ -s "$d/$f" ] && BGPIDS="$BGPIDS $(head -n 1 "$d/$f")"; done
[ -s "$d/pid" ] && ok "...having waited for the start to publish its pid" || ko "spawn returned before the claim: $(ls -A "$d")"
expect "a wait on a spawned run that is still going reads RUNNING" 3 RUNNING -- "$BG" wait "$d" --within 0
: > "$TMP/spawn-gate"
expect "...and its status once it finishes (rc=5)" 0 'rc=5' -- "$BG" wait "$d" --within 20
[ "$(cat "$d/log")" = "$(printf '%s\n' 'a b' '$HOME')" ] && ok "...with its arguments passed through intact, in its log" \
  || ko "the spawned run logged: $(cat "$d/log")"
[ "$(ls -A "$d" | tr '\n' ' ')" = "cpid log pid rc " ] && ok "...in the directory layout start writes, and nothing else" \
  || ko "the spawned directory holds: $(ls -A "$d" | tr '\n' ' ')"
expect "a second spawn takes the next directory" 0 "$p/run-2" -- "$BG" spawn "$p" -- true
expect "...and reads its own status" 0 'rc=0' -- "$BG" wait "$p/run-2" --within 20
expect "usage: spawn refuses a relative parent" 2 'absolute' -- "$BG" spawn rel/parent -- true
[ ! -e rel ] && ok "...and creates nothing" || ko "a relative spawn created ./rel"
expect "usage: spawn without -- is refused" 2 'usage:' -- "$BG" spawn "$TMP/u5" true
expect "usage: spawn with no command is refused" 2 'usage:' -- "$BG" spawn "$TMP/u5" --
[ ! -e "$TMP/u5" ] && ok "...and creates nothing" || ko "a refused spawn created its parent"
: > "$TMP/spawn-file"
expect "spawn under a parent that is a file is an error, and starts nothing" 2 'cannot create' -- "$BG" spawn "$TMP/spawn-file" -- true

# --- the command's signal dispositions (ludics-lite#524) ---------------------------------------------
# A command that signals itself dies of it only where the signal is at its default disposition: an
# ignored one is survived, and the command says so. Each spawn is made from a subshell that ignores
# all four, so every one is inherited ignored and only the reset can undo it; the control is a copy
# with the reset emptied, whose command must survive each.
printf '%s\n' '#!/bin/sh' 'kill -"$1" $$' 'sleep 1' 'echo "survived $1"' > "$TMP/selfsig.sh"
sig_spawn() { # <script> <parent> <SIG>: the run directory, spawned with all four signals ignored
  ( trap '' INT QUIT HUP TERM; "$1" spawn "$2" -- sh "$TMP/selfsig.sh" "$3" )
}
for sc in INT:130 QUIT:131 HUP:129 TERM:143; do
  sig=${sc%%:*} want=${sc#*:}
  d=$(sig_spawn "$BG" "$TMP/sig-$sig" "$sig")
  expect "a spawned command sees $sig at its default disposition, though its caller ignored it (rc=$want)" 0 "rc=$want" -- \
    "$BG" wait "$d" --within 20
  contains "$(cat "$d/log" 2>/dev/null)" survived && ko "...but it survived $sig: $(cat "$d/log")" \
    || ok "...and did not survive it"
done
fresh sig-start
bg_start "$d" sh "$TMP/selfsig.sh" INT
expect "a command under a start launched with & (INT ignored) dies of INT too (rc=130)" 0 'rc=130' -- \
  "$BG" wait "$d" --within 20
sed "s|^reset_signals='INT QUIT HUP TERM'$|reset_signals=''|" "$BG" > "$TMP/noreset.sh"
chmod +x "$TMP/noreset.sh"
if cmp -s "$BG" "$TMP/noreset.sh"; then
  ko "control: the patch found no reset_signals line to empty in $BG"
else
  for sig in INT QUIT HUP TERM; do
    d=$(sig_spawn "$TMP/noreset.sh" "$TMP/sig-control-$sig" "$sig")
    "$BG" wait "$d" --within 20 > /dev/null 2>&1
    contains "$(cat "$d/log" 2>/dev/null)" "survived $sig" && ok "control: without the reset, the command survives $sig" \
      || ko "control: without the reset the command did not survive $sig ($(cat "$d/rc" 2>/dev/null)), so the case above proves nothing"
  done
fi

# --- stop: a spawned run's whole tree (ludics-lite#510) ---------------------------------------------
# The command leaves a grandchild behind a subshell that has already exited, so the grandchild is
# reparented out of the run's process tree. The caller, which spawns and stops, gets a process
# group of its own (set -m), so a stop that wrongly signalled its caller's group would end that
# caller -- what the case checks -- and not this suite.
printf '%s\n' '#!/bin/sh' '( sh -c '"'"'echo $$ > "$0"; exec sleep 300'"'"' "$1" & )' 'exec sleep 300' > "$TMP/tree.sh"
printf '%s\n' '#!/bin/bash' 'd=$("$1" spawn "$2" -- sh "$3" "$4") || exit 9' 'echo "dir $d"' \
  'i=0; while [ ! -s "$4" ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done' \
  '"$1" stop "$d"; echo "stop-rc $?"' 'echo caller-survived' > "$TMP/stopper.sh"
set -m
bash "$TMP/stopper.sh" "$BG" "$TMP/stop" "$TMP/tree.sh" "$TMP/stop.gc" > "$TMP/stopper.out" 2>&1 &
sp=$!
set +m
BGPIDS="$BGPIDS $sp"
wait "$sp"; sprc=$?
sout=$(cat "$TMP/stopper.out")
d=$(sed -n 's/^dir //p' "$TMP/stopper.out")
gc=$(cat "$TMP/stop.gc" 2>/dev/null)
[ -n "$gc" ] && BGPIDS="$BGPIDS $gc"
[ "$sprc" -eq 0 ] && contains "$sout" caller-survived && contains "$sout" 'stop-rc 0' \
  && contains "$sout" "STOPPED $d: process group" \
  && ok "stop ends a live spawned run (STOPPED, exit 0), and its caller survives it" \
  || ko "the stopper exited $sprc -- $sout"
gone=false
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  case $(ps -o stat= -p "${gc:-99999999}" 2>/dev/null) in ''|Z*) gone=true; break ;; esac
  sleep 0.2
done
[ -n "$gc" ] && $gone && ok "...a grandchild behind an exited subshell included" \
  || ko "the grandchild (${gc:-never recorded}) outlived the stop"
expect "...and a wait there reads STOPPED (exit 7), not DIED (ludics-lite#638)" 7 \
  'STOPPED by bg-run.sh stop before the command returned' -- "$BG" wait "$d" --within 5
[ "$(ls -A "$d" | tr '\n' ' ')" = "cpid log pid stopped " ] && ok "...its marker the one file the stop added" \
  || ko "the stopped directory holds: $(ls -A "$d" | tr '\n' ' ')"
expect "a second stop there signals nothing (NOT RUNNING, exit 1)" 1 'NOT RUNNING: STOPPED' -- "$BG" stop "$d"
# A stop ended inside its grace (ludics-lite#638): the command leaves a TERM-ignoring grandchild
# behind an exited subshell, the stop is killed once the wrapper is gone, and the grandchild is
# the remnant. A wait then reads RUNNING -- not DIED, since the marker went in before the signal,
# and not STOPPED, since a member of the group is left -- and a second stop ends it.
printf '%s\n' '#!/bin/sh' '( sh -c '"'"'trap "" TERM; echo $$ > "$0"; while :; do sleep 1; done'"'"' "$1" & )' 'exec sleep 300' > "$TMP/stubborn-tree.sh"
d=$("$BG" spawn "$TMP/remnant" -- sh "$TMP/stubborn-tree.sh" "$TMP/remnant.gc")
until_file "$TMP/remnant.gc" 10
rgc=$(cat "$TMP/remnant.gc" 2>/dev/null); BGPIDS="$BGPIDS $rgc"
rw=$(head -n 1 "$d/pid" 2>/dev/null)
env BG_RUN_STOP_GRACE=60 "$BG" stop "$d" > "$TMP/remnant.stop" 2>&1 &
rs=$!; BGPIDS="$BGPIDS $rs"
# A wrapper a non-reaping PID 1 leaves a zombie has exited, as bg-run.sh's own `running` reads it.
proc_live() {
  kill -0 "$1" 2>/dev/null || return 1
  case $(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ') in Z*|X*) return 1 ;; esac
  return 0
}
i=0
while proc_live "${rw:-99999999}" && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
kill -9 "$rs" 2>/dev/null; { wait "$rs"; } 2>/dev/null
if [ -n "$rgc" ] && proc_live "$rgc" && ! proc_live "${rw:-99999999}"; then
  expect "a stop ended in its grace leaves a remnant that reads RUNNING, not DIED or STOPPED" 3 RUNNING -- \
    "$BG" wait "$d" --within 0
  expect "...and a second stop ends the remnant" 0 'TERM, then KILL after 1 s' -- env BG_RUN_STOP_GRACE=1 "$BG" stop "$d"
  case $(ps -o stat= -p "$rgc" 2>/dev/null) in ''|Z*) ok "...the grandchild included" ;;
    *) ko "the remnant grandchild ($rgc) outlived the second stop" ;; esac
  expect "...after which the run reads STOPPED" 7 STOPPED -- "$BG" wait "$d" --within 0
else
  ko "the remnant fixture did not stage (wrapper ${rw:-none}, grandchild ${rgc:-none}) -- $(cat "$TMP/remnant.stop")"
fi
# A command that ignores TERM gets KILL after the grace.
d=$("$BG" spawn "$TMP/stubborn" -- sh -c 'trap "" TERM; : > "$0"; while :; do sleep 1; done' "$TMP/stubborn.ready")
until_exists "$TMP/stubborn.ready" 10
c=$(head -n 1 "$d/cpid" 2>/dev/null); BGPIDS="$BGPIDS $c"
expect "stop sends KILL to a command that ignores TERM, after BG_RUN_STOP_GRACE" 0 'TERM, then KILL after 1 s' -- \
  env BG_RUN_STOP_GRACE=1 "$BG" stop "$d"
sleep 0.5
case $(ps -o stat= -p "${c:-99999999}" 2>/dev/null) in ''|Z*) ok "...and the command is gone" ;;
  *) ko "the TERM-ignoring command ($c) outlived the KILL" ;; esac
# Nothing to stop: a finished run, one never started, a pid reused by another process.
d=$("$BG" spawn "$TMP/stop-done" -- true)
"$BG" wait "$d" --within 20 > /dev/null
expect "stop on a finished run signals nothing (exit 1)" 1 'NOT RUNNING: rc=0' -- "$BG" stop "$d"
fresh stop-never
expect "stop on a directory no start has claimed signals nothing" 1 'NOT RUNNING: STARTING' -- "$BG" stop "$d"
sleep 30 &
sp=$!; BGPIDS="$BGPIDS $sp"
d="$TMP/stop-reused"; mkdir -p "$d"
printf '%s\n%s\n' "$sp" 'ThuJan100:00:001970' > "$d/pid"; cp "$d/pid" "$d/cpid"
expect "stop on a pid the system reused (another start time) signals nothing" 1 'NOT RUNNING: DIED' -- "$BG" stop "$d"
kill -0 "$sp" 2>/dev/null && ok "...and the process that now has that pid runs on" || ko "stop killed the unrelated process $sp"
kill -9 "$sp" 2>/dev/null; { wait "$sp"; } 2>/dev/null
# A run started by `start` in a group it does not lead (here the group of a shell started with
# set -m, standing in for a harness task) has no group of its own: refused, and it runs on.
fresh stop-start
set -m
sh -c '"$0" start "$1" -- sleep 300; :' "$BG" "$d" > /dev/null 2>&1 &
par=$!
set +m
BGPIDS="$BGPIDS $par"
if until_file "$d/cpid" 10; then
  BGPIDS="$BGPIDS $(head -n 1 "$d/pid") $(head -n 1 "$d/cpid")"
  expect "stop refuses a start-launched run that shares its caller's group (exit 2)" 2 'no process group of its own' -- \
    "$BG" stop "$d"
  expect "...which runs on (RUNNING)" 3 RUNNING -- "$BG" wait "$d" --within 0
  kill -0 "$par" 2>/dev/null && ok "...as does the shell that started it" || ko "the refused stop ended the starting shell"
else
  ko "the start-launched fixture never published its cpid"
fi
kill -9 -- "-$par" 2>/dev/null; { wait "$par"; } 2>/dev/null
expect "usage: stop refuses a relative directory" 2 'absolute' -- "$BG" stop rel/dir
expect "usage: stop with no directory is refused" 2 'usage:' -- "$BG" stop
expect "usage: a BG_RUN_STOP_GRACE that is not a number is refused" 2 'whole number' -- \
  env BG_RUN_STOP_GRACE=soon "$BG" stop "$TMP/stop-never/run-1"

# --- usage -------------------------------------------------------------------------------------------
expect "usage: start refuses a relative directory" 2 'absolute' -- "$BG" start rel/dir -- true
[ ! -e rel ] && ok "...and creates nothing" || ko "a relative start created ./rel"
expect "usage: wait refuses a relative directory" 2 'absolute' -- "$BG" wait rel/dir --within 0
expect "usage: start without -- is refused" 2 'usage:' -- "$BG" start "$TMP/u1" true
[ ! -e "$TMP/u1" ] && ok "...and creates nothing" || ko "a start without -- created its directory"
expect "usage: start with no command is refused" 2 'usage:' -- "$BG" start "$TMP/u2" --
expect "usage: a --within that is not a number is refused" 2 'whole number' -- "$BG" wait "$TMP/u3" --within soon
expect "a zero-padded --within is decimal, not octal (08 is no arithmetic error)" 0 'rc=0' -- \
  "$BG" wait "$fin0" --within 08
expect "...and so are zero-padded BG_RUN_POLL and BG_RUN_START_GRACE" 4 STARTING -- \
  env BG_RUN_POLL=01 BG_RUN_START_GRACE=09 "$BG" wait "$TMP/padded" --within 02
expect "usage: no subcommand is refused" 2 'usage:' -- "$BG"
expect "usage: --help prints the synopsis" 0 'bg-run.sh start <dir> --' -- "$BG" --help
expect "...and names new" 0 'bg-run.sh new   <parent>' -- "$BG" --help
expect "...and spawn" 0 'bg-run.sh spawn <parent> -- <cmd>' -- "$BG" --help
expect "...and stop" 0 'bg-run.sh stop  <dir>' -- "$BG" --help
expect "usage: new refuses a relative parent" 2 'absolute' -- "$BG" new rel/parent
[ ! -e rel ] && ok "...and creates nothing" || ko "a relative new created ./rel"
expect "usage: new with no parent is refused" 2 'usage:' -- "$BG" new
expect "usage: new with a second argument is refused" 2 'usage:' -- "$BG" new "$TMP/u4" extra
[ ! -e "$TMP/u4" ] && ok "...and creates nothing" || ko "a refused new created its parent"

# --- through zsh, the way the Bash tool issues it ------------------------------------------------------
if command -v zsh > /dev/null 2>&1; then
  fresh zsh
  # shellcheck disable=SC2016 # the single quotes are zsh's to expand
  zsh -fc '"$0" start "$1" -- printf "%s\n" "owner/repo#12" "a b" "\$HOME"' "$BG" "$d" > /dev/null 2>&1 &
  BGPIDS="$BGPIDS $!"
  expect "zsh: a start issued through zsh -c finishes (rc=0)" 0 'rc=0' -- "$BG" wait "$d" --within 20
  [ "$(cat "$d/log")" = "$(printf '%s\n' 'owner/repo#12' 'a b' '$HOME')" ] \
    && ok "...with its arguments passed through intact" || ko "zsh start logged: $(cat "$d/log")"
else
  echo "SKIP: zsh is not installed; the zsh -c start is not exercised here"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
exit "$?"
}
