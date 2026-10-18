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
#   bg-run.sh stop  <dir>                      # foreground; ends a spawned run's whole tree
#
# or, with the start as the harness's own background task:
#
#   bg-run.sh new   <parent>                   # foreground; prints <dir>, a fresh directory
#   bg-run.sh start <dir> -- <cmd> [arg...]    # run it with Bash run_in_background: true
#   bg-run.sh wait  <dir> [--within <s>]
#
# `spawn` is the two-call form (ludics-lite#181): it allocates <dir> as `new` does, runs `start`
# there DETACHED -- in a session of its own, its stdio on /dev/null and SIGHUP ignored, so the
# foreground call that ran `spawn` returns while the command runs on -- waits up to 10 s for that
# start to publish its pid (the claim, below), and prints <dir> and nothing else; `wait` on it is
# the one wait. The run is the same `start` on the same directory, so every verdict below reads it
# as it reads any other. What differs is who can kill it: a detached run is no background task of
# the harness's, so the harness's own kill of a long task (the DIED case below) does not reach it,
# and neither does a task-stop; `stop` does. The session (perl's setsid; macOS ships no setsid(1))
# is what lets `stop` end the run whole (ludics-lite#510): the wrapper, `start`, leads the
# session's one process group, and everything the command starts stays in that group unless it
# leaves on its own. A group kill reaches a grandchild whose parent has already exited, which a
# walk of the process tree misses (it is reparented out of the tree), and it cannot reach the
# caller, which a group the run shared with its caller would. Nothing aimed at the caller's group or
# terminal (a hangup, a Ctrl-C, a harness's group kill) reaches the run either. Without perl the
# start runs in the caller's group, as before ludics-lite#510, and `stop` refuses it. A start
# that has not published its pid by the time `spawn` returns is said so on stderr, and `wait` then
# reads it as STARTING, as for any start. `fleet-worker.sh execution slot --bg <parent>` is this
# around a slot-held batch; there the command is the slot's wrapper, which runs the batch in a
# group of its own and ends that group on the TERM `stop` sends it (ludics-lite#566).
#
# `stop <dir>` ends a run's whole tree. It reads the run as `wait` does, and a run that is not
# RUNNING it leaves alone and says so: `NOT RUNNING: <verdict>`, exit 1 -- a run that has
# finished, one that died, one a stop has already ended, one whose pid the system has since reused for another process (the
# start-time check `alive` makes), one that has published no pid yet. For a live run it reads the
# process group of the identity-checked wrapper (or, the wrapper gone, command), and signals it
# only when that group is the run's own: led by the wrapper's pid, as `spawn` makes it, and not
# `stop`'s own. It re-checks the identity, publishes the marker `stopped` in <dir> (ludics-lite#638),
# sends SIGTERM to the group, and sends SIGKILL once BG_RUN_STOP_GRACE seconds (whole, default 10)
# pass with any member still running; it prints `STOPPED <dir>: process group <g> (TERM)` (or
# `(TERM, then KILL after <n> s)`) and exits 0. A wait there then reads STOPPED, never DIED: the run
# was ended on purpose, and DIED's re-arm would relaunch what was stopped. The marker goes in BEFORE
# the signal, so no wait between the wrapper's death and the stop's end reads DIED; until no member
# of the group is left, a wait reads RUNNING (the stop is still ending it). A stop that was itself
# ended inside its grace leaves such a remnant, and a second stop signals that group again. A
# signal that finds the group already gone takes this stop's marker back out. A run whose wrapper
# does not lead its own group (a `start` run as a harness task, or a managed session's command)
# shares its caller's, and `stop` refuses it, exit 2, signalling nothing: the harness's own
# task-stop ends that one. What `stop` does not reach: a process that left the group itself (one
# that calls setsid). The window it leaves: the system does not reuse an id while a group by that
# id exists, so the group can be mistaken only if its last member exits after the re-check and a
# new process takes the id as a group of its own before the signal, in the same instant.
#
# The command starts with SIGINT, SIGQUIT, SIGHUP and SIGTERM at their DEFAULT dispositions,
# whatever `start` inherited (ludics-lite#524): perl resets them and execs the command, since a
# shell cannot un-ignore a signal it was started with ignored. Before that, `start`'s own `&` (a
# non-interactive shell starts background jobs with INT and QUIT ignored) and spawn's ignored HUP
# reached the command, so a suite that signals its own children false-redded under `spawn`, and a
# TERM could be lost. Every other disposition, and the signal mask, pass through. A command that is
# meant to outlive a hangup says so itself: `spawn <parent> -- nohup <cmd>`. Where perl is missing
# the command starts with what it inherited, and a `bg-run:` line in the log says so.
#
# `new` allocates the run directory, so no caller has to keep a fresh name by hand: it creates
# <parent> if need be (absolute), then <parent>/run-<N> with one exclusive `mkdir`, N one past the
# highest run-<N> already there, leaves the token `.new` in it, and prints that path and nothing
# else. A `mkdir` lost to a racing `new` moves on to the next N, so every `new` gets a directory of
# its own, created by that call. A directory from `new` has never held a run, so a `wait` on it,
# even one issued before `start`, can only read this run or STARTING.
#
# <dir> is absolute and FRESH for every run, and `new` is the only way to get one (ludics-lite#425):
# `start` runs only in a directory that holds `new`'s token, and its claim (below) removes the
# token. So it refuses, exit 2, writing nothing and running nothing, a directory that does not
# exist, one `new` did not allocate, and one a start has already claimed -- a duplicated or
# retried `start`, or a path `new` printed handed to a second one. A wait there reads whatever run
# the directory holds, and that is the one caller error this does not catch: a caller who hands a
# printed path to a second `start` after the first run has ENDED, and waits there, reads the first
# run's status as its own, with only the refusal on the second start's stderr to say so. Until
# ludics-lite#425 an ended-run marker (`refused`, the REFUSED verdict) turned that wait into a
# refusal; it was kept for callers that named their own directories, which `start` no longer
# accepts, so it is gone, and this is the case its removal accepts. Over a run that is still live
# the refusal is what it always was: the run there is the one a wait should report. `start`
# writes four files and nothing else:
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
#                 re-arm it in a new directory. A run `stop` ended reads STOPPED instead.
#   STOPPED    7  `stop` ended the run (its marker `stopped` is there), and no process of it is
#                 left: not the wrapper, not the command, no member of the wrapper's process group.
#                 The run was ended on purpose, so it is NOT re-armed; the line is `STOPPED by
#                 bg-run.sh stop before the command returned`. An rc written before the signal
#                 landed still wins: the command returned, and rc=<n> says how.
# While it blocks, every 120 s of the wait (BG_RUN_HEARTBEAT, whole seconds; 0 for none) it says
# so on stderr, `bg-run: still waiting after <e> s of --within <w> (<state>)`, so a long wait does
# not read as a hang. A heartbeat line starts with `bg-run:`, never with a verdict word, and is
# never on stdout, whose one line stays the verdict.
# `new` exits 0 having printed the directory, and 2 when it cannot create one (a parent that is a
# file, or one it cannot write in: an error, never a search through ever higher N). `stop` exits 0
# having stopped the run, 1 when it is not running, 2 when it refuses one. Usage errors exit 2,
# from any subcommand. (Exit 6, the retired REFUSED verdict, is never used; STOPPED took 7 so that
# no reader of an older bg-run.sh takes it for REFUSED.)
#
# The races this closes, each pinned by test-bg-run.sh:
#   1. a killed task never writes rc: `wait` reads the dead pid as DIED instead of polling forever;
#   2. rc is a file of its own, not a line of the log, so output that quotes `rc=` (a review body
#      does) cannot end a wait;
#   3. a wait that runs before the task has published its pid reads STARTING, not DIED;
#   and a directory that has held a run, whose rc belongs to that run, is never started again.
#   A run that finishes between the rc read and the pid probe is read as finished: a dead pid is
#   followed by a second read of rc before DIED is concluded.
# And a wrapper killed on its own (not with its process group, as the harness does) leaves the
# command running: its cpid keeps the verdict RUNNING rather than a DIED that would re-arm a
# duplicate beside it.
# What it does not close: a caller that waits on a directory whose run had ended before the
# caller's own `start` was refused there (above). Nor a wrapper killed alone in the instant between
# forking the command's process and that process publishing cpid: a wait in that instant reads
# DIED.
#
# The directory layout is a contract a reader may rely on without going through `wait`
# (ludics-lite#405's `execution conclude --from-bg-run` reads it): `rc` holds one line, the decimal
# exit status, and appears only once complete (rename); `log` is the command's whole output;
# `pid` and `cpid` are the liveness evidence behind RUNNING and DIED; `stopped`, which only `stop`
# writes (complete, by rename, before it signals), is what turns a run with no process left into
# STOPPED rather than DIED, its content (`process group <g>`) for the reader. A directory written by a
# bg-run.sh from before ludics-lite#425 may also hold `refused`, which nothing reads any more.
# Dot-files (`new`'s token, in-flight temporaries) are never a reader's. `wait <dir> --within 0` gives the same
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
    '       bg-run.sh wait <dir> [--within <seconds>]' \
    '       bg-run.sh stop <dir>' >&2
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

# The signals the command starts with at their default dispositions, and the perl that resets
# them and execs the command (header; ludics-lite#524). `exec { $ARGV[0] } @ARGV` never goes
# through a shell, whatever the arguments hold; a command that cannot be run exits 127 when it is
# not found and 126 otherwise, as a shell's exec would.
reset_signals='INT QUIT HUP TERM'
# shellcheck disable=SC2016 # perl's own variables
reset_pl='$SIG{$_} = "DEFAULT" for qw('"$reset_signals"'); exec { $ARGV[0] } @ARGV;
print STDERR "bg-run: cannot run $ARGV[0]: $!\n"; exit($!{ENOENT} ? 127 : 126);'

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
      # The token `start` requires (header): this directory is new's, and unclaimed.
      : > "$base/run-$n/.new" || { say "cannot write in $(printf '%q' "$base/run-$n")"; exit 2; }
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
  # Only a directory `new` allocated and no start has claimed (header). The claim below is what
  # decides between two starts that both get past this; the token only turns away the rest, and
  # the refusal writes nothing, so a wait there reads whatever run the directory already holds.
  if [ ! -f "$dir/.new" ]; then
    if [ ! -d "$dir" ]; then why='does not exist'
    elif [ -e "$dir/pid" ]; then why='was already claimed by a start (a duplicated or retried start, or a reused path); a wait there reports that run, not this one'
    else why='was not allocated by new (it holds no .new token)'
    fi
    say "refused: $(printf '%q' "$dir") $why; this start ran nothing -- allocate a run directory with bg-run.sh new <parent>, or use spawn"
    exit 2
  fi
  # A test seam, unset in use: test-bg-run.sh holds two starts here, past the token check,
  # until both have reached it (each drops <gate>.<pid>; the suite then creates <gate>), so the
  # claim below is what decides between them.
  if [ -n "${BG_RUN_CLAIM_GATE:-}" ]; then
    : > "$BG_RUN_CLAIM_GATE.$$"
    while [ ! -e "$BG_RUN_CLAIM_GATE" ]; do sleep 0.1; done
  fi
  # The claim is the pid itself, published by a hard link, which fails when `pid` exists: of two
  # starts that both found the token, exactly one gets it and the other is refused before its
  # command runs. The content is complete before the link makes it visible. The winner then takes
  # the token away, so no later start gets past the check above. A lost claim writes nothing,
  # whatever state the winner has reached by now: the winner's run, finished or not, is the one a
  # wait there should report.
  printf '%s\n%s\n' "$$" "$(started $$)" > "$dir/.pid.$$" || { say "cannot write in $(printf '%q' "$dir")"; exit 2; }
  if ! ln -- "$dir/.pid.$$" "$dir/pid" 2>/dev/null; then
    rm -f -- "$dir/.pid.$$"
    say "refused: another start claimed $(printf '%q' "$dir") first; a wait there reports that run, and this start ran nothing"
    exit 2
  fi
  rm -f -- "$dir/.pid.$$" "$dir/.new"
  # The command's process publishes its own pid before it execs the command, so there is no moment
  # at which the command runs untracked; it then execs perl, which resets the dispositions and
  # execs the command, all in that one process, so cpid and its start time stay the command's.
  # shellcheck disable=SC2016 # expanded by the inner sh
  sh -c 'cpid=$0 pl=$1; shift
    printf "%s\n%s\n" "$$" "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$$" 2>/dev/null | tr -d " ")" > "$cpid.$$" \
      && mv -f "$cpid.$$" "$cpid" || exit
    command -v perl > /dev/null 2>&1 && exec perl -e "$pl" -- "$@"
    printf "%s\n" "bg-run: no perl here, so the command starts with the signal dispositions start inherited" >&2
    exec "$@"' "$dir/cpid" "$reset_pl" "$@" \
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
  # A session of its own, so the wrapper leads the run's one process group (header). Without perl
  # the start stays in the caller's group, and `stop` refuses it.
  if command -v perl > /dev/null 2>&1; then
    # shellcheck disable=SC2016 # perl's own variables
    ( trap '' HUP; exec perl -MPOSIX -e 'POSIX::setsid(); exec { $ARGV[0] } @ARGV; exit 127' \
        -- "${BASH:-bash}" "$0" start "$dir" -- "$@" ) < /dev/null > /dev/null 2>&1 &
  else
    ( trap '' HUP; exec "${BASH:-bash}" "$0" start "$dir" -- "$@" ) < /dev/null > /dev/null 2>&1 &
  fi
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

# verdict <dir>: sets V to rc | STARTING | RUNNING | STOPPED | DIED.
verdict() {
  if [ -s "$1/rc" ]; then V=rc
  elif [ ! -s "$1/pid" ]; then V=STARTING
  elif alive "$1/pid" || alive "$1/cpid"; then V=RUNNING
  elif [ -s "$1/rc" ]; then V=rc   # it finished between the rc read and the probe
  elif [ -e "$1/stopped" ]; then
    # A stop signalled the group the wrapper leads (cmd_stop). A member left in it is the stop
    # still ending the run. A live process that holds the wrapper's pid now is another process:
    # the system does not reuse an id while a group by that id exists, so the run's group is gone.
    { IFS= read -r lead; } < "$1/pid"
    if group_left "$lead" && ! running "$lead"; then V=RUNNING; else V=STOPPED; fi
  else V=DIED
  fi
}

# running <pid>: a live process holds the pid; a zombie, which has exited, does not.
running() {
  kill -0 "$1" 2>/dev/null || return 1
  case $(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ') in Z*|X*) return 1 ;; esac
  return 0
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
    STOPPED) printf '%s\n' 'STOPPED by bg-run.sh stop before the command returned'; exit 7 ;;
  esac
}

# group_left <g>: whether a process of group <g> is still running; a zombie, which has exited, is
# not. Where ps cannot list the groups, kill -0 on the group stands.
group_left() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  kill -0 -- "-$1" 2>/dev/null || return 1
  members=$(ps -A -o pgid= -o stat= 2>/dev/null) && [ -n "$members" ] || return 0
  printf '%s\n' "$members" | awk -v g="$1" '$1 == g && $2 !~ /^[ZX]/ { f = 1 } END { exit !f }'
}

# stop <dir>: end a spawned run's whole process group (header; ludics-lite#510).
cmd_stop() {
  [ $# -eq 1 ] || usage
  dir=$1
  grace=${BG_RUN_STOP_GRACE:-10}
  case $grace in ''|*[!0-9]*) say "not a whole number of seconds: $(printf '%q' "$grace")"; exit 2 ;; esac
  grace=$((10#$grace))
  need_absolute "$dir"
  verdict "$dir"
  case $V in
    rc) printf 'NOT RUNNING: rc=%s, the command has finished; nothing was signalled\n' "$(cat "$dir/rc")"; exit 1 ;;
    STARTING) printf '%s\n' 'NOT RUNNING: STARTING, no start has published its pid here; nothing was signalled'; exit 1 ;;
    DIED) printf '%s\n' 'NOT RUNNING: DIED, no process of the run is alive (a pid there names another process, or none); nothing was signalled'; exit 1 ;;
    STOPPED) printf '%s\n' 'NOT RUNNING: STOPPED, a stop has already ended this run and no process of it is left; nothing was signalled'; exit 1 ;;
  esac
  # The group of a live process of the run, identity-checked; the run's own only when the wrapper
  # leads it, as spawn makes it, and never this stop's own.
  { IFS= read -r lead; } < "$dir/pid"
  g=
  for f in pid cpid; do
    alive "$dir/$f" || continue
    { IFS= read -r p; } < "$dir/$f"
    g=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -z "$g" ] || break
  done
  # Wrapper and command gone, a member of their group left, and a stop's marker there: a stop
  # ended inside its grace left this remnant, and the group is still the wrapper's (verdict).
  [ -n "$g" ] || [ ! -e "$dir/stopped" ] || g=$lead
  mine=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')
  if [ -z "$g" ] || [ "$g" != "$lead" ] || [ "$g" = "$mine" ]; then
    say "refused: the run in $(printf '%q' "$dir") has no process group of its own (it was started by start, not spawn), so a group kill would reach whoever started it; nothing was signalled -- stop it through the task that runs it"
    exit 2
  fi
  # The identity again, immediately before the signal, to keep the window narrow (header).
  verdict "$dir"
  if [ "$V" != RUNNING ]; then
    printf '%s\n' 'NOT RUNNING: the run ended while stop read it; nothing was signalled'
    exit 1
  fi
  # The marker before the signal (header): a wait that reads the wrapper gone reads STOPPED, never
  # the DIED whose re-arm would relaunch what is being stopped.
  marked=
  if [ ! -e "$dir/stopped" ]; then
    { printf 'process group %s\n' "$g" > "$dir/.stopped.$$" && mv -f -- "$dir/.stopped.$$" "$dir/stopped"; } || {
      rm -f -- "$dir/.stopped.$$"
      say "refused: cannot publish the stopped marker in $(printf '%q' "$dir"), so a wait there would read DIED; nothing was signalled"
      exit 2
    }
    marked=1
  fi
  kill -TERM -- "-$g" 2>/dev/null || {
    [ -z "$marked" ] || rm -f -- "$dir/stopped"
    printf '%s\n' 'NOT RUNNING: the run ended while stop read it; nothing was signalled'
    exit 1
  }
  how=TERM
  t0=$SECONDS
  while group_left "$g"; do
    if [ $((SECONDS - t0)) -ge "$grace" ]; then
      kill -KILL -- "-$g" 2>/dev/null
      how="TERM, then KILL after $grace s"
      # A killed member is gone at once, short of a process stuck in the kernel; 2 s for it.
      n=0
      while group_left "$g" && [ "$n" -lt 20 ]; do sleep 0.1; n=$((n + 1)); done
      break
    fi
    sleep 0.2
  done
  printf 'STOPPED %s: process group %s (%s)\n' "$dir" "$g" "$how"
  exit 0
}

[ $# -ge 1 ] || usage
sub=$1; shift
case $sub in
  spawn) cmd_spawn "$@" ;;
  new) cmd_new "$@" ;;
  start) cmd_start "$@" ;;
  wait) cmd_wait "$@" ;;
  stop) cmd_stop "$@" ;;
  -h|--help) sed -n '2,/^$/s/^# \{0,1\}//p' "$0"; exit 0 ;;
  *) usage ;;
esac
exit "$?"
}
