#!/usr/bin/env bash
# Exercises bg-run.sh with real background processes in a scratch directory -- no network, no
# harness. The command under test is always a small `sh -c` fixture, and every wait runs with a
# 1 s poll (BG_RUN_POLL=1) so the suite takes seconds rather than the production cadence.
#
# What it pins:
#   - a finished run reads rc=<its exit status> with exit 0, whatever that status is, and the
#     background `start` itself exits with it too -- on a directory `start` creates itself, the
#     path every caller that names its own directory still takes;
#   - `new` allocates: it creates the parent and prints <parent>/run-<N>, empty, one past the
#     highest run-<N> there (other names not counted); two `new`s racing for the same N each get
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
#   - a stale directory: `start` refuses one whose run has ended (finished or died), runs
#     nothing, leaves the earlier status untouched, and a wait on it reads REFUSED, not the
#     earlier run's rc; over a live run it is refused too, runs nothing, and marks nothing, so a
#     wait there still reports the live run;
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
# bg_start <dir> <cmd...>: `start` in the background, the way the Bash tool runs it; its pid in S.
bg_start() {
  local d=$1; shift
  "$BG" start "$d" -- "$@" > /dev/null 2>&1 &
  S=$!; BGPIDS="$BGPIDS $S"
}

# --- a finished run ------------------------------------------------------------------------------
d="$TMP/finished"
bg_start "$d" sh -c 'echo hello; exit 7'
expect "a finished run reads rc=7, exit 0" 0 'rc=7' -- "$BG" wait "$d" --within 20
wait "$S"; src=$?
[ "$src" -eq 7 ] && ok "...and the background start exits with the command's status" \
  || ko "the background start exited $src, want 7"
[ "$(cat "$d/log")" = hello ] && ok "...and the command's output is in log" \
  || ko "log holds: $(cat "$d/log")"
[ "$(ls -A "$d" | tr '\n' ' ')" = "cpid log pid rc " ] && ok "...and the directory holds cpid, log, pid, rc and nothing else" \
  || ko "the directory holds: $(ls -A "$d" | tr '\n' ' ')"
d="$TMP/finished0"
bg_start "$d" true
expect "a run exiting 0 reads rc=0" 0 'rc=0' -- "$BG" wait "$d" --within 20

# --- new: the run directory allocated for the caller ----------------------------------------------
p="$TMP/runs"
expect "new on an absent parent creates it and prints run-1" 0 "$p/run-1" -- "$BG" new "$p"
[ "$out" = "$p/run-1" ] && ok "...and prints that path and nothing else" || ko "new printed: $out"
[ -d "$p/run-1" ] && [ -z "$(ls -A "$p/run-1")" ] && ok "...an empty directory" \
  || ko "run-1 is not an empty directory: $(ls -A "$p/run-1" 2>&1)"
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
d="$TMP/killed"
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
d="$TMP/orphan"
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
d="$TMP/quoting"
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
d="$TMP/late"
"$BG" wait "$d" --within 30 > "$TMP/late.out" 2>&1 &
W=$!; BGPIDS="$BGPIDS $W"
sleep 2
bg_start "$d" sh -c 'exit 0'
wait "$W"; wrc=$?
[ "$wrc" -eq 0 ] && contains "$(cat "$TMP/late.out")" 'rc=0' \
  && ok "race 3: a wait already polling when start runs picks the run up (rc=0)" \
  || ko "the early wait exited $wrc -- $(cat "$TMP/late.out")"
[ -e "$d/refused" ] && ko "the early wait's directory was refused: $(cat "$d/refused")" \
  || ok "...and the early wait did not make the directory look stale"

# --- a stale directory -----------------------------------------------------------------------------
d="$TMP/stale"; mkdir -p "$d"
printf '99999999\n' > "$d/pid"; printf 'old log\n' > "$d/log"; printf '0\n' > "$d/rc"
expect "stale: start refuses a directory that holds a finished run (exit 2)" 2 'has ended' -- \
  "$BG" start "$d" -- sh -c 'touch "$0"; exit 9' "$TMP/stale.ran"
[ ! -e "$TMP/stale.ran" ] && ok "...and runs nothing" || ko "the refused start ran its command"
[ "$(cat "$d/rc")" = 0 ] && [ "$(cat "$d/log")" = 'old log' ] \
  && ok "...and leaves the earlier run's rc and log untouched" || ko "the earlier run's files changed"
expect "stale: a wait on it reads REFUSED (exit 6), not the earlier rc=0" 6 'REFUSED:' -- "$BG" wait "$d" --within 0
d="$TMP/stale-live"
bg_start "$d" sleep 30
live=$S
if until_file "$d/pid" 10; then
  expect "a start over a live run is refused and runs nothing" 2 'is live' -- \
    "$BG" start "$d" -- sh -c 'touch "$0"' "$TMP/live.ran"
  [ ! -e "$TMP/live.ran" ] && ok "...its command did not run" || ko "the refused start ran its command"
  expect "...and leaves the live run's verdict alone (RUNNING, not REFUSED)" 3 RUNNING -- \
    "$BG" wait "$d" --within 0
else
  ko "stale: the live fixture never published its pid"
fi
kill -9 "$live" 2>/dev/null; { wait "$live"; } 2>/dev/null
[ -s "$d/cpid" ] && kill -9 "$(head -n 1 "$d/cpid")" 2>/dev/null
d="$TMP/stale-dead"; mkdir -p "$d"
printf '99999999\n' > "$d/pid"
expect "stale: start refuses a directory whose run died" 2 'has ended' -- "$BG" start "$d" -- true
expect "...and a wait on it reads REFUSED, not DIED" 6 'REFUSED:' -- "$BG" wait "$d" --within 0

# Two starts racing on one fresh directory (a duplicated tool call, a retry): exactly one may run
# its command. BG_RUN_CLAIM_GATE holds both past the emptiness check until both are there, so the
# claim is what decides and the race is lost every time rather than by luck; the control is a copy whose exclusive link
# is patched into an overwriting rename, which must then run the command twice.
# twin_starts <script> <dir>: launch two starts at once; sets TWIN_RAN (times the command ran) and
# TWIN_RCS (the two start exits).
twin_starts() {
  local ran="$2.ran" gate="$2.gate" a b ra rb i=0
  BG_RUN_CLAIM_GATE=$gate "$1" start "$2" -- sh -c 'echo x >> "$0"; sleep 1' "$ran" > /dev/null 2>&1 &
  a=$!
  BG_RUN_CLAIM_GATE=$gate "$1" start "$2" -- sh -c 'echo x >> "$0"; sleep 1' "$ran" > /dev/null 2>&1 &
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
expect "...and the losing start left the winner's verdict alone (rc=0, not REFUSED)" 0 'rc=0' -- \
  "$BG" wait "$TMP/twin" --within 0
# A start that loses the claim to a winner that has already FINISHED: the start is held past the
# emptiness check, a finished run is put in place under it, and then it is let go. It must mark
# nothing, so the winner's rc is what a wait reads.
d="$TMP/lost-to-finished"
BG_RUN_CLAIM_GATE="$d.gate" "$BG" start "$d" -- sh -c 'touch "$0"' "$TMP/lost.ran" > "$TMP/lost.out" 2>&1 &
L=$!; BGPIDS="$BGPIDS $L"
if until_exists "$d.gate.$L" 10; then
  printf '%s\n' 99999999 > "$d/pid"; printf '0\n' > "$d/rc"; : > "$d/log"
  : > "$d.gate"
  wait "$L"; lrc=$?
  [ "$lrc" -eq 2 ] && contains "$(cat "$TMP/lost.out")" 'claimed' && [ ! -e "$TMP/lost.ran" ] \
    && ok "a start that loses the claim to a finished run is refused and runs nothing" \
    || ko "the losing start exited $lrc, ran=$([ -e "$TMP/lost.ran" ] && echo yes || echo no) -- $(cat "$TMP/lost.out")"
  expect "...and marks nothing: a wait reads the winner's rc=0, not REFUSED" 0 'rc=0' -- "$BG" wait "$d" --within 0
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
d="$TMP/short-window"
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
d="$TMP/heartbeat"
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
  if printf '%s\n' "$herr" | grep -E -q '^(rc=|RUNNING|STARTING|DIED|REFUSED)'; then
    ko "a heartbeat line starts with a verdict word -- $herr"
  else
    ok "...none of which starts with a verdict word"
  fi
  [ "$(printf '%s\n' "$hout" | wc -l | tr -d ' ')" = 1 ] && ok "...and stdout holds the one verdict line" \
    || ko "stdout holds more than the verdict -- $hout"
  expect "BG_RUN_HEARTBEAT=0 prints no heartbeat" 3 'RUNNING after' -- \
    env BG_RUN_HEARTBEAT=0 "$BG" wait "$d" --within 2
  contains "$out" 'still waiting' && ko "a heartbeat was printed with BG_RUN_HEARTBEAT=0 -- $out" \
    || ok "...and says nothing while it blocks"
  expect "a --within 0 wait reads 'RUNNING after 0 s of --within 0'" 3 'RUNNING after 0 s of --within 0' -- \
    "$BG" wait "$d" --within 0
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

# --- usage -------------------------------------------------------------------------------------------
expect "usage: start refuses a relative directory" 2 'absolute' -- "$BG" start rel/dir -- true
[ ! -e rel ] && ok "...and creates nothing" || ko "a relative start created ./rel"
expect "usage: wait refuses a relative directory" 2 'absolute' -- "$BG" wait rel/dir --within 0
expect "usage: start without -- is refused" 2 'usage:' -- "$BG" start "$TMP/u1" true
[ ! -e "$TMP/u1" ] && ok "...and creates nothing" || ko "a start without -- created its directory"
expect "usage: start with no command is refused" 2 'usage:' -- "$BG" start "$TMP/u2" --
expect "usage: a --within that is not a number is refused" 2 'whole number' -- "$BG" wait "$TMP/u3" --within soon
expect "a zero-padded --within is decimal, not octal (08 is no arithmetic error)" 0 'rc=0' -- \
  "$BG" wait "$TMP/finished0" --within 08
expect "...and so are zero-padded BG_RUN_POLL and BG_RUN_START_GRACE" 4 STARTING -- \
  env BG_RUN_POLL=01 BG_RUN_START_GRACE=09 "$BG" wait "$TMP/padded" --within 02
expect "usage: no subcommand is refused" 2 'usage:' -- "$BG"
expect "usage: --help prints the synopsis" 0 'bg-run.sh start <dir> --' -- "$BG" --help
expect "...and names new" 0 'bg-run.sh new   <parent>' -- "$BG" --help
expect "...and spawn" 0 'bg-run.sh spawn <parent> -- <cmd>' -- "$BG" --help
expect "usage: new refuses a relative parent" 2 'absolute' -- "$BG" new rel/parent
[ ! -e rel ] && ok "...and creates nothing" || ko "a relative new created ./rel"
expect "usage: new with no parent is refused" 2 'usage:' -- "$BG" new
expect "usage: new with a second argument is refused" 2 'usage:' -- "$BG" new "$TMP/u4" extra
[ ! -e "$TMP/u4" ] && ok "...and creates nothing" || ko "a refused new created its parent"

# --- through zsh, the way the Bash tool issues it ------------------------------------------------------
if command -v zsh > /dev/null 2>&1; then
  d="$TMP/zsh"
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
