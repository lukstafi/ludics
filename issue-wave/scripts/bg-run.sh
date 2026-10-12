#!/usr/bin/env bash
# bg-run.sh -- run one command as a background task and block on it in bounded foreground calls.
#
# A native worker has nothing that holds its turn on a background task except a foreground Bash
# call, and that call is capped at 600 s. So a command that can outlast the cap (ship-pr's
# `pr-review.sh watch`, `merge --wait`) runs in the background under `start`, and the worker
# re-issues `wait` in the foreground until it reports the command's exit status
# (issue-wave/references/native-claude.md, *Blocking on a run*). This replaces the two lines of
# hand-copied shell that took three review rounds of races (ludics-lite#354, #357):
#
#   bg-run.sh spawn <parent> -- <cmd> [arg...] # foreground; `new` + a detached `start`, prints <dir>
#   bg-run.sh wait  <dir> [--within <s>]       # run it in the foreground; default 540
#
# or, with the start as the harness's own background task:
#
#   bg-run.sh new   <parent>                   # foreground; prints <dir>, a fresh directory
#   bg-run.sh start <dir> -- <cmd> [arg...]    # run it with Bash run_in_background: true
#   bg-run.sh wait  <dir> [--within <s>]
#
# `spawn` is the two-call form (ludics-lite#181): it allocates <dir> as `new` does, runs `start`
# there DETACHED -- its stdio on /dev/null and SIGHUP ignored, so the foreground call that ran
# `spawn` returns while the command runs on -- waits up to 10 s for that start to publish its pid
# (the claim, below), and prints <dir> and nothing else; `wait` on it is the one wait. The run is
# the same `start` on the same directory, so every verdict below reads it as it reads any other.
# What differs is who can kill it: a detached run is no background task of the harness's, so the
# harness's own kill of a long task (the DIED case below) does not reach it, and neither does a
# task-stop; a `kill` of the pid on <dir>/cpid's first line does (the command; <dir>/pid names its
# wrapper the same way), once the file's second line still matches the process's start time as
# `alive` checks it. It signals that one process: a child the command is running then runs on to
# its own end. Never signal a process group: `spawn` makes none of its own, so the run shares its
# caller's and a group kill reaches the caller. A start
# that has not published its pid by the time `spawn` returns is said so on stderr, and `wait` then
# reads it as STARTING, as for any start. `fleet-worker.sh execution slot --bg <parent>` is this
# around a slot-held batch; there the command is the slot's wrapper, and a kill of it reaches the
# batch's whole process group (ludics-lite#566).
#
# `new` allocates the run directory, so no caller has to keep a fresh name by hand: it creates
# <parent> if need be (absolute), then <parent>/run-<N> with one exclusive `mkdir`, N one past the
# highest run-<N> already there, and prints that path and nothing else. A `mkdir` lost to a
# racing `new` moves on to the next N, so every `new` gets a directory of its own, created empty
# by that call. A directory from `new` has never held a run, so a `wait` on it, even one issued
# before `start`, can only read this run or STARTING.
#
# <dir> is absolute and FRESH for every run. `new` is the way to get one; a caller may still name
# its own (`start` creates a directory that does not exist yet), and then keeping the name fresh
# is its own half. `start` refuses a directory that already holds anything. It writes four files
# there and nothing else:
#   pid  -- this script's own pid, published before the command starts. Publishing it is the
#           claim: it is created exclusively, so of two starts racing on one directory exactly one
#           runs its command;
#   cpid -- the command's own pid, published by the command's process before it execs the
#           command, so a command that outlives a killed wrapper is still seen running;
#           Each pid file carries a second line, the process's start time as `ps -o lstart=`
#           gives it, so a pid the system has since reused for another process is not read as
#           the run's (where ps cannot say, the line is empty and the bare pid stands);
#   log  -- the command's stdout and stderr, and the only file the command's output reaches;
#   rc   -- the command's exit status, published (by rename) after the command returns.
# A start refused over an earlier run that has ENDED (finished, or died) writes `refused` into
# that directory, so a wait there says REFUSED instead of reading the earlier status as this
# run's. A directory from `new` never gets one unless the caller hands it to a second `start`;
# the marker stays for the caller that names its own directory and reuses a name. A start
# refused over a run that is still live, or still being claimed, marks nothing: that is the run
# a wait there should report, since the likeliest way to reach it is a duplicated
# or retried `start` of the same command -- marking it would send the caller off to run it again.
# A duplicate that arrives only after its twin has ENDED cannot be told from the reuse of an old
# directory, and is refused the same way: that costs a second run, loudly, where the other
# reading would report an earlier run's status as this one's, silently. The commands this is for
# (a review watch, a merge wait) are reads that a second run repeats harmlessly.
#
# `wait` polls every 5 s (BG_RUN_POLL, whole seconds) and returns the first settled verdict, or
# the current one once --within seconds are spent (default 540, under the 600 s cap on a foreground
# tool call). It prints one line on stdout and exits with its code. The verdict is the line's
# first word; anything after it is for the reader, never the grammar:
#   rc=<n>     0  the command finished; <n> is its exit status (also in <dir>/rc). Exit 0 means
#                 FINISHED, not succeeded: a command may exit with any status, so no exit code
#                 of this script can both carry it and stay distinct from the verdicts below.
#   RUNNING    3  the pid or the cpid is alive and there is no rc yet: re-issue the wait. The line
#                 is `RUNNING after <e> s of --within <w>`, so a return at the bound (e >= w) can
#                 be told from an early one, which would be a bug (ludics-lite#571).
#   STARTING   4  no pid yet, said as `STARTING after <e> s of --within <w>`. A background task
#                 that has not published its pid is starting, not dead. Returned at the
#                 --within deadline, or once no pid has appeared for 60 s of this wait
#                 (BG_RUN_START_GRACE): re-issue once, and a second STARTING means the launch
#                 itself failed, so start again in a NEW directory.
#   DIED       5  a pid was published, it and the command are both gone, and no rc was
#                 written: the task was killed before the command returned (the harness does this, ~40 min into a
#                 backgrounded `merge --wait`). It says nothing about what the command saw:
#                 re-arm it in a new directory.
#   REFUSED    6  `start` refused this directory (the reason follows): start again in a NEW one.
# While it blocks, every 120 s of the wait (BG_RUN_HEARTBEAT, whole seconds; 0 for none) it says
# so on stderr, `bg-run: still waiting after <e> s of --within <w> (<state>)`, so a long wait does
# not read as a hang. A heartbeat line starts with `bg-run:`, never with a verdict word, and is
# never on stdout, whose one line stays the verdict.
# `new` exits 0 having printed the directory, and 2 when it cannot create one (a parent that is a
# file, or one it cannot write in: an error, never a search through ever higher N). Usage errors
# exit 2, from any subcommand.
#
# The races this closes, each pinned by test-bg-run.sh:
#   1. a killed task never writes rc: `wait` reads the dead pid as DIED instead of polling forever;
#   2. rc is a file of its own, not a line of the log, so output that quotes `rc=` (a review body
#      does) cannot end a wait;
#   3. a wait that runs before the task has published its pid reads STARTING, not DIED;
#   and a stale directory, whose rc belongs to an earlier run, is refused rather than reused.
#   A run that finishes between the rc read and the pid probe is read as finished: a dead pid is
#   followed by a second read of rc before DIED is concluded.
# And a wrapper killed on its own (not with its process group, as the harness does) leaves the
# command running: its cpid keeps the verdict RUNNING rather than a DIED that would re-arm a
# duplicate beside it.
# What it does not close: on a directory the caller named itself and an earlier run left behind,
# a `wait` that runs before `start` has run AT ALL reads that run's status; `start`'s refusal
# catches the reuse only once it has run. `new` closes this by construction for the directories
# it allocates. Nor a wrapper killed alone in the instant between forking the command's process
# and that process publishing cpid: a wait in that instant reads DIED.
#
# The directory layout is a contract a reader may rely on without going through `wait`
# (ludics-lite#405's `execution conclude --from-bg-run` reads it): `rc` holds one line, the decimal
# exit status, and appears only once complete (rename); `log` is the command's whole output;
# `refused`, when present, says `start` refused the directory, and an `rc` beside it may be an
# earlier run's, so it is never read as the caller's. So a reader checks `refused` first, then `rc`,
# in `wait`'s own order; `pid` and `cpid` are the liveness evidence behind RUNNING and DIED.
# Dot-files are in-flight temporaries, never a reader's. `wait <dir> --within 0` gives the same
# verdict in one call.
#
# Portable to bash 3.2 (macOS /bin/bash) and GNU bash; the Bash tool's zsh only passes argv.

set -u

# Bash reads a script by OFFSET while it runs, so a writer that rewrites this file IN PLACE, through
# its own inode (`cp` over it, a shell `>` redirection, `rsync --inplace`, an editor that saves in
# place), resumes a running shell mid-command in whatever text now sits at the offset it left off
# at. `start` lives as long as the command it supervises (a `pr-review.sh watch` runs for hours), and
# `wait` for up to its bound, both from the checkout that `refresh` and a hub fast-forward update.
# A git fast-forward is not such a writer: checkout unlinks the old file and creates a new one, and
# a running shell keeps reading the old inode (measured for ludics-lite#437). Everything below is
# one brace group, parsed whole before its first command runs, and the closing exit means the shell
# never comes back to the file; the body keeps its own indentation, so the guard is these lines and
# two at the foot. scripts/check-parse-guards.sh holds the shape (ALSO_GUARDED), and
# scripts/test-check-parse-guards.sh rewrites the file in place under a running copy.
{

usage() {
  printf '%s\n' 'usage: bg-run.sh spawn <parent> -- <cmd> [arg...]' \
    '       bg-run.sh new <parent>' \
    '       bg-run.sh start <dir> -- <cmd> [arg...]' \
    '       bg-run.sh wait <dir> [--within <seconds>]' >&2
  exit 2
}

say() { printf 'bg-run: %s\n' "$*" >&2; }

# An absolute directory, so a background shell that did not start in the caller's cwd (ship-pr's
# SKILL.md records that it need not) and the foreground waiter name the same place.
need_absolute() {
  case $1 in
    /*) ;;
    *) say "the run directory must be an absolute path, got $(printf '%q' "$1")"; exit 2 ;;
  esac
}

# refuse_start <dir>: refuse a directory that already holds a run, and exit. One that has ended is
# marked, so a wait on it reads REFUSED rather than its status; a live one is left alone.
refuse_start() {
  verdict "$1"
  case $V in
    RUNNING|STARTING)
      say "refused: $(printf '%q' "$1") holds a run that is live or still being claimed; a wait there reports that run, and this start ran nothing" ;;
    REFUSED)
      say "refused: $(printf '%q' "$1") was already refused; start again in a new directory" ;;
    *)
      reason="$(printf '%q' "$1") already holds a run that has ended; start again in a new directory"
      printf '%s\n' "$reason" > "$1/refused"
      say "refused: $reason" ;;
  esac
  exit 2
}

cmd_new() {
  [ $# -eq 1 ] || usage
  parent=$1
  need_absolute "$parent"
  # Trailing slashes off, so the path printed has one spelling (and / stays /).
  while [ "$parent" != / ]; do
    case $parent in */) parent=${parent%/} ;; *) break ;; esac
  done
  mkdir -p -- "$parent" 2>/dev/null && [ -d "$parent" ] \
    || { say "cannot create $(printf '%q' "$parent")"; exit 2; }
  base=${parent%/}
  # The highest run-<N> already there; any other name, and a run-<N> too long to be a number
  # bash arithmetic can hold, is not counted.
  top=0
  for e in "$base"/run-*; do
    n=${e##*/run-}
    case $n in ''|*[!0-9]*) continue ;; esac
    [ "${#n}" -le 9 ] || continue
    n=$((10#$n))
    [ "$n" -le "$top" ] || top=$n
  done
  # A test seam, unset in use: test-bg-run.sh holds two `new`s here, past the scan, until both
  # have reached it (each drops <gate>.<pid>; the suite then creates <gate>), so both try the same
  # N and the exclusive mkdir below is what decides between them.
  if [ -n "${BG_RUN_NEW_GATE:-}" ]; then
    : > "$BG_RUN_NEW_GATE.$$"
    while [ ! -e "$BG_RUN_NEW_GATE" ]; do sleep 0.1; done
  fi
  # `mkdir` without -p fails when the name exists, so exactly one caller creates each run-<N>. A
  # failure with the name still absent is not a race lost but a parent that refuses the write:
  # that is an error, not a reason to try the next N. The bound only stops a pathological loop.
  n=$((top + 1)); tries=0
  while [ "$tries" -lt 1000 ]; do
    if mkdir -- "$base/run-$n" 2>/dev/null; then
      printf '%s\n' "$base/run-$n"
      exit 0
    fi
    [ -e "$base/run-$n" ] || [ -L "$base/run-$n" ] \
      || { say "cannot create a run directory in $(printf '%q' "$parent")"; exit 2; }
    n=$((n + 1)); tries=$((tries + 1))
  done
  say "no free run directory in $(printf '%q' "$parent") after $tries tries"
  exit 2
}

cmd_start() {
  [ $# -ge 3 ] || usage
  dir=$1; shift
  [ "$1" = -- ] || usage
  shift
  need_absolute "$dir"
  mkdir -p -- "$dir" || { say "cannot create $(printf '%q' "$dir")"; exit 2; }
  [ -z "$(ls -A -- "$dir")" ] || refuse_start "$dir"
  # A test seam, unset in use: test-bg-run.sh holds two starts here, past the emptiness check,
  # until both have reached it (each drops <gate>.<pid>; the suite then creates <gate>), so the
  # claim below is what decides between them.
  if [ -n "${BG_RUN_CLAIM_GATE:-}" ]; then
    : > "$BG_RUN_CLAIM_GATE.$$"
    while [ ! -e "$BG_RUN_CLAIM_GATE" ]; do sleep 0.1; done
  fi
  # The claim is the pid itself, published by a hard link, which fails when `pid` exists: of two
  # starts that both found the directory empty, exactly one gets it and the other is refused
  # before its command runs. The content is complete before the link makes it visible. A lost
  # claim marks nothing, whatever state the winner has reached by now: the winner's run, finished
  # or not, is the one a wait there should report.
  printf '%s\n%s\n' "$$" "$(started $$)" > "$dir/.pid.$$" || { say "cannot write in $(printf '%q' "$dir")"; exit 2; }
  if ! ln -- "$dir/.pid.$$" "$dir/pid" 2>/dev/null; then
    rm -f -- "$dir/.pid.$$"
    say "refused: another start claimed $(printf '%q' "$dir") first; a wait there reports that run, and this start ran nothing"
    exit 2
  fi
  rm -f -- "$dir/.pid.$$"
  # The command's process publishes its own pid before it execs the command, so there is no moment
  # at which the command runs untracked.
  # shellcheck disable=SC2016 # expanded by the inner sh
  sh -c 'printf "%s\n%s\n" "$$" "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$$" 2>/dev/null | tr -d " ")" > "$0.$$" \
    && mv -f "$0.$$" "$0" && exec "$@"' "$dir/cpid" "$@" \
    < /dev/null > "$dir/log" 2>&1 &
  wait "$!"
  rc=$?
  printf '%s\n' "$rc" > "$dir/.rc.tmp" && mv -f -- "$dir/.rc.tmp" "$dir/rc" \
    || say "cannot publish the exit status $rc in $(printf '%q' "$dir")"
  exit "$rc"
}

# spawn <parent> -- <cmd>: `new`, then `start` on the directory it printed, detached (header). The
# start is a fresh bash on this file rather than a subshell, because a subshell's $$ is still this
# process's pid, which `start` publishes as the run's and which is gone the moment `spawn` returns.
cmd_spawn() {
  [ $# -ge 3 ] || usage
  parent=$1; shift
  [ "$1" = -- ] || usage
  shift
  dir=$(cmd_new "$parent") || exit 2
  ( trap '' HUP; exec "${BASH:-bash}" "$0" start "$dir" -- "$@" ) < /dev/null > /dev/null 2>&1 &
  tries=0
  while [ ! -s "$dir/pid" ] && [ "$tries" -lt 50 ]; do sleep 0.2; tries=$((tries + 1)); done
  [ -s "$dir/pid" ] || say "the start in $(printf '%q' "$dir") has not published its pid after 10 s; a wait there reads STARTING until it does"
  printf '%s\n' "$dir"
  exit 0
}

# started <pid>: the process's start time, blanks removed, in one fixed locale and zone so the
# start and the wait spell it alike; empty where ps cannot say. (The inner sh in cmd_start spells
# the same pipeline out, since it cannot call this function.)
started() { TZ=UTC LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -d ' '; }

# alive <pid-file>: whether the process it names is still the run's, and running. `kill -0` alone
# answers yes for two processes that are not: a zombie -- an orphaned command that exited under a
# parent that never reaps it (a minimal container's PID 1) -- which ps reports in state Z (or X),
# and an unrelated process the system has since given the same pid, whose start time differs from
# the one recorded. Where ps cannot say, kill -0 stands.
alive() {
  [ -s "$1" ] || return 1
  { IFS= read -r p; IFS= read -r t; } < "$1"
  kill -0 "$p" 2>/dev/null || return 1
  case $(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ') in Z*|X*) return 1 ;; esac
  if [ -n "${t:-}" ]; then
    now=$(started "$p")
    [ -z "$now" ] || [ "$now" = "$t" ] || return 1
  fi
  return 0
}

# verdict <dir>: sets V to rc | REFUSED | STARTING | RUNNING | DIED.
verdict() {
  if [ -s "$1/refused" ]; then V=REFUSED
  elif [ -s "$1/rc" ]; then V=rc
  elif [ ! -s "$1/pid" ]; then V=STARTING
  elif alive "$1/pid" || alive "$1/cpid"; then V=RUNNING
  elif [ -s "$1/rc" ]; then V=rc   # it finished between the rc read and the probe
  else V=DIED
  fi
}

cmd_wait() {
  [ $# -ge 1 ] || usage
  dir=$1; shift
  within=540
  while [ $# -gt 0 ]; do
    case $1 in
      --within) [ $# -ge 2 ] || usage; within=$2; shift 2 ;;
      --within=*) within=${1#--within=}; shift ;;
      *) usage ;;
    esac
  done
  interval=${BG_RUN_POLL:-5}
  grace=${BG_RUN_START_GRACE:-60}
  beat=${BG_RUN_HEARTBEAT:-120}
  for n in "$within" "$interval" "$grace" "$beat"; do
    case $n in ''|*[!0-9]*) say "not a whole number of seconds: $(printf '%q' "$n")"; exit 2 ;; esac
  done
  # Decimal, whatever the padding: bash arithmetic reads a leading 0 as octal (08 is an error).
  within=$((10#$within)); interval=$((10#$interval)); grace=$((10#$grace)); beat=$((10#$beat))
  [ "$interval" -ge 1 ] || { say 'BG_RUN_POLL must be at least 1'; exit 2; }
  need_absolute "$dir"
  t0=$SECONDS
  next_beat=$beat
  while :; do
    verdict "$dir"
    elapsed=$((SECONDS - t0))
    case $V in
      RUNNING) ;;
      STARTING) [ "$elapsed" -lt "$grace" ] || break ;;
      *) break ;;
    esac
    # The last nap is only what is left of the window, so a --within shorter than the poll, or
    # not a multiple of it, is still spent in full.
    left=$((within - elapsed))
    [ "$left" -gt 0 ] || break
    # The heartbeat, only while the wait goes on. The nap below also ends at the next one, so a
    # poll slower than the heartbeat cannot skip it.
    if [ "$beat" -gt 0 ] && [ "$elapsed" -ge "$next_beat" ]; then
      case $V in RUNNING) state='the run is live' ;; *) state='no pid published yet' ;; esac
      say "still waiting after $elapsed s of --within $within ($state)"
      while [ "$next_beat" -le "$elapsed" ]; do next_beat=$((next_beat + beat)); done
    fi
    nap=$interval
    [ "$left" -ge "$nap" ] || nap=$left
    [ "$beat" -eq 0 ] || [ $((next_beat - elapsed)) -ge "$nap" ] || nap=$((next_beat - elapsed))
    sleep "$nap"
  done
  case $V in
    rc) printf 'rc=%s\n' "$(cat "$dir/rc")"; exit 0 ;;
    RUNNING) printf 'RUNNING after %s s of --within %s\n' "$elapsed" "$within"; exit 3 ;;
    STARTING) printf 'STARTING after %s s of --within %s\n' "$elapsed" "$within"; exit 4 ;;
    DIED) echo DIED; exit 5 ;;
    REFUSED) printf 'REFUSED: %s\n' "$(cat "$dir/refused")"; exit 6 ;;
  esac
}

[ $# -ge 1 ] || usage
sub=$1; shift
case $sub in
  spawn) cmd_spawn "$@" ;;
  new) cmd_new "$@" ;;
  start) cmd_start "$@" ;;
  wait) cmd_wait "$@" ;;
  -h|--help) sed -n '2,/^$/s/^# \{0,1\}//p' "$0"; exit 0 ;;
  *) usage ;;
esac
exit "$?"
}
