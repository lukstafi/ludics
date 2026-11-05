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
# group of its own and ends that group on the TERM `stop` sends it (ludics-lite#566). A command whose
# work runs outside the group ends that work itself on the TERM: `fleet-worker.sh execution leg` ends
# its far side, in an ssh session on another box (ludics-lite#767), and waits for the box to report
# it inside the grace (THE GRACES, below).
#
# `stop <dir>` ends a run's whole tree. It reads the run as `wait` does, and a run that is not
# RUNNING it leaves alone and says so: `NOT RUNNING: <verdict>`, exit 1 -- a run that has
# finished, one that died, one a stop has already ended, one whose pid the system has since reused for another process (the
# start-time check `alive` makes), one that has published no pid yet. For a live run it reads the
# process group of the identity-checked wrapper (or, the wrapper gone, command), and signals it
# only when that group is the run's own: led by the wrapper's pid, as `spawn` makes it, and not
# `stop`'s own. It re-checks the identity, then reads the TREE (wave-20261031 post-1-task-16,
# ahrefs/ocannl#1727): the wrapper's group, and every process group the run's processes formed
# outside it, found before anything is signalled -- every process of a group of the run's, every
# descendant of those by parent pid, and each one's group. A slot-held batch is such a group (the
# slot starts it in a session of its own), and so is a test runner's phase that leads a group of
# its own: the slot's group kill does not reach that one, and a phase that outlived the stop held
# the worktree's run lock, refusing the next batch there. It publishes the marker `stopped` in
# <dir> (ludics-lite#638), naming every group of the tree, sends SIGTERM to the wrapper's group,
# and sends SIGKILL to every group of the tree once the run's grace (THE GRACES, below) passes with
# any member of any of them still running; groups the tree forms meanwhile are added to
# the marker as they are found, and killed with the rest. It prints `STOPPED <dir>: process group
# <g> (TERM)` (or `(TERM, then KILL after <n> s)`; with the other groups the tree held named before
# the parenthesis, `... process group <g> and the run's groups <h> <i> outside it (...)`) and exits
# 0. A wait there then reads STOPPED, never DIED: the run was ended on purpose, and DIED's re-arm
# would relaunch what was stopped. The marker goes in BEFORE the signal, so no wait between the
# wrapper's death and the stop's end reads DIED; until no member of any group the marker names is
# left, a wait reads RUNNING (the stop is still ending it), so STOPPED also says that whatever the
# tree held -- a lock, a slot -- is released. A stop that was itself ended inside its grace leaves
# such a remnant, and a second stop signals it: the wrapper's group while it has a member, else
# every group of the remnant, TERM and then KILL as above. A signal that finds the tree already gone
# (`NOT RUNNING`, exit 1) leaves the marker in place: a concurrent stop may be the one that ended
# it, and a run that ended on its own in that instant still reads rc when it wrote one, and
# otherwise STOPPED, as the stop asked. A run whose wrapper does not lead its own group (a `start`
# run as a harness task, or a managed session's command) shares its caller's, and `stop` refuses
# it, exit 2, signalling nothing: the harness's own task-stop ends that one. What `stop` does not
# reach: a process whose parent had already exited, outside every group of the tree, when the tree
# was read (a daemon's double fork, as the slot's guardian makes, which ends itself), and a process
# on another box. Each group is judged by its leader's start time, recorded in the marker: a
# recorded leader pid running under another start time is another process, and the run's group by
# that id is gone. The window it leaves: the system does not reuse an id while a group by that id
# exists, so a group can be mistaken only if its last member exits after the read and a new
# process takes the id as a group of its own before the signal, in the same instant.
#
# THE GRACES (ludics#827, lib/ludics/fleetworker/graces.py, where the ladder is stated): every layer
# that stops a run escalates TERM to KILL after a grace strictly longer than the layer's inside it,
# so a runner's own cleanup is not cut by an outer KILL. The input is FLEET_RUNNER_GRACE, the whole
# seconds the innermost command needs between its TERM and its exit (default 10); a stop's grace is
# the outermost rung, that plus 25 (35 s by default). `start` derives it from its own environment,
# the one the run's layers inherit, and records it as its pid file's third line, and `stop` gives the
# run that recorded grace, whatever its own environment says; BG_RUN_STOP_GRACE (whole seconds) on
# the stop overrides it, and a run whose pid holds no record gets the one the stop's environment
# derives. A FLEET_RUNNER_GRACE that is not a whole number is refused, exit 2: by `spawn` and `start`
# before anything is allocated or run, and by a `stop` that needs it, before anything is signalled.
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
#           Each pid file carries a second line, the process's start time (THE START TOKEN,
#           below), so a pid the system has since reused for another process is not read as
#           the run's (where it cannot be read, the line is empty and the bare pid stands); `pid`
#           carries a third, the run's stop grace in seconds (THE GRACES);
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
#                 When the rc was already there at this wait's first read -- a re-issued wait,
#                 or one on a run long done -- the line is `rc=<n> (finished earlier, at
#                 <UTC time the rc was published>)` (ludics-lite#816), so it is not read as a
#                 fresh result; the word, the status and the exit code are the same.
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
#                 left: not the wrapper, not the command, no member of any process group of the
#                 run's tree the marker names (the wrapper's, and those outside it; `stop`).
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
# STOPPED rather than DIED; its lines name the tree's groups, `process group <g>` (the wrapper's)
# first, then `process group <h> <its leader's start time, or ->` for each other one, which `wait`
# and a second `stop` read back.
#
# THE START TOKEN (ludics#786), the start time a pid file and the marker record and every identity
# check compares. On Linux it is field 22 of /proc/<pid>/stat, the kernel's own start tick since
# boot, read after the LAST `) ` (the comm field before it may hold blanks and parentheses):
# procps's lstart is that tick added to a boot time the kernel re-derives from the wall clock on
# every read, so after a suspend and resume (or a clock step) the same process can print another
# lstart, and a live run read DIED (ahrefs/ocannl#1448). Everywhere else it is `ps -o lstart=` in one fixed locale and
# zone, blanks removed. A recorded token is read back in its own kind, by its shape: digits only
# are a tick, anything else an lstart -- so a run recorded by a bg-run.sh from before #786 on
# Linux is judged by lstart, as it was, and not read DIED across the upgrade. The boundary: the
# kind is the platform's (`uname -s`), never chosen per process, and a token recorded on one box
# means nothing on another, which no reader asks of it.
#
# A directory written by a
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

# THE GRACES (lib/ludics/fleetworker/graces.py, ludics#827): stop's TERM-to-KILL is the outermost
# rung, BG_RUN, spelled here from graces.py's constants (tests/test_fleetworker_graces.py runs this
# file and pins the two equal): FLEET_RUNNER_GRACE, the innermost command's grace (default 10),
# plus the margin for each layer up to this one.
grace_runner_default=10 grace_margin=5 grace_rung=5
# run_grace: sets G to that grace, from FLEET_RUNNER_GRACE in this environment; 1 (G unset) when it
# is not a whole number of seconds.
run_grace() {
  G=
  r=${FLEET_RUNNER_GRACE:-$grace_runner_default}
  case $r in ''|*[!0-9]*) return 1 ;; esac
  G=$((10#$r + grace_margin * grace_rung))
}
bad_grace() {
  say "refused: FLEET_RUNNER_GRACE must be a whole number of seconds (the innermost command's stop grace), got $(printf '%q' "$FLEET_RUNNER_GRACE"); $1"
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
  # BG_RUN_NEW_GATE_SPIN set, the wait spins instead of napping, so both leave it within
  # microseconds of each other: the suite's stress case, which races the real `mkdir`.
  if [ -n "${BG_RUN_NEW_GATE:-}" ]; then
    : > "$BG_RUN_NEW_GATE.$$"
    while [ ! -e "$BG_RUN_NEW_GATE" ]; do [ -n "${BG_RUN_NEW_GATE_SPIN:-}" ] || sleep 0.1; done
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
  # THE GRACES: the run's stop grace, derived from this start's environment -- the one its layers
  # inherit -- and recorded in the claim, so a stop from another environment gives it that grace.
  run_grace || bad_grace "this start ran nothing"
  # The claim is the pid itself, published by a hard link, which fails when `pid` exists: of two
  # starts that both found the token, exactly one gets it and the other is refused before its
  # command runs. The content is complete before the link makes it visible. The winner then takes
  # the token away, so no later start gets past the check above. A lost claim writes nothing,
  # whatever state the winner has reached by now: the winner's run, finished or not, is the one a
  # wait there should report.
  printf '%s\n%s\n%s\n' "$$" "$(started $$)" "$G" > "$dir/.pid.$$" || { say "cannot write in $(printf '%q' "$dir")"; exit 2; }
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
  sh -c 'cpid=$0 pl=$1 kind=$2; shift 2
    if [ "$kind" = tick ]; then
      t=$( { IFS= read -r l < "/proc/$$/stat"; } 2>/dev/null && set -- ${l##*") "} \
        && [ $# -ge 20 ] && shift 19 && printf "%s" "$1")
    else t=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$$" 2>/dev/null | tr -d " ")
    fi
    printf "%s\n%s\n" "$$" "$t" > "$cpid.$$" \
      && mv -f "$cpid.$$" "$cpid" || exit
    command -v perl > /dev/null 2>&1 && exec perl -e "$pl" -- "$@"
    printf "%s\n" "bg-run: no perl here, so the command starts with the signal dispositions start inherited" >&2
    exec "$@"' "$dir/cpid" "$reset_pl" "$TOKEN_KIND" "$@" \
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
  # The start runs detached, its refusals unseen: an input it would refuse is refused here first.
  run_grace || bad_grace "nothing was allocated or run"
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

# THE START TOKEN (header): the kind this platform records.
case $(uname -s 2>/dev/null) in Linux) TOKEN_KIND=tick ;; *) TOKEN_KIND=lstart ;; esac

# tick_of <pid>: field 22 of /proc/<pid>/stat, the 20th after the last `) `; empty where it cannot
# be read. One line is read: a comm is at most 15 bytes, so a newline in it leaves fewer than 20
# fields on that line, and the read gives nothing rather than another field.
tick_of() {
  { IFS= read -r _st < "/proc/$1/stat"; } 2>/dev/null || return 0
  set -- ${_st##*") "}
  [ $# -lt 20 ] || printf '%s\n' "${20}"
}

# lstart_of <pid>: ps's lstart, blanks removed, in one fixed locale and zone so the start and the
# wait spell it alike; empty where ps cannot say.
lstart_of() { TZ=UTC LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -d ' '; }

# started <pid>: the process's start token in this platform's kind; empty where it cannot be read.
# (The inner sh in cmd_start spells both reads out, since it cannot call these functions.)
started() { if [ "$TOKEN_KIND" = tick ]; then tick_of "$1"; else lstart_of "$1"; fi; }

# start_is <pid> <token>: the pid's start, read in the recorded token's own kind (digits only: a
# tick; else an lstart), is that token -- or cannot be read, where the bare pid stands.
start_is() {
  case $2 in
    *[!0-9]*) now=$(lstart_of "$1") ;;
    *) now=$(tick_of "$1") ;;
  esac
  [ -z "$now" ] || [ "$now" = "$2" ]
}

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
    start_is "$p" "$t" || return 1
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
    # A stop signalled the run's tree (cmd_stop): the group the wrapper leads and every group the
    # marker names. A live member left in any of them is the stop still ending the run -- a process
    # that holds a lock of the run's (a worktree's run lock) included (tree_scan judges each
    # group's identity: a live process that holds a recorded leader's pid now, with another start
    # time, is another process, and the run's group by that id is gone).
    tree_scan "$1"
    if [ -n "$TREE_LIVE" ]; then V=RUNNING; else V=STOPPED; fi
  else V=DIED
  fi
}

# finished_at <rc file>: when the rc was published (its mtime: written once, by rename), in UTC as
# 2026-10-28T13:37:12Z; empty where perl, which reads it alike on BSD and GNU, is missing.
finished_at() {
  # shellcheck disable=SC2016 # perl's own variables
  perl -MPOSIX -e 'my @s = stat $ARGV[0] or exit 1; print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime $s[9])' \
    -- "$1" 2>/dev/null
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
  first=1 earlier=
  while :; do
    verdict "$dir"
    # A run whose rc was already there at this wait's first read finished before it (header).
    [ -z "$first" ] || [ "$V" != rc ] || earlier=1
    first=
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
    rc)
      if [ -n "$earlier" ]; then
        at=$(finished_at "$dir/rc")
        printf 'rc=%s (finished earlier%s)\n' "$(cat "$dir/rc")" "${at:+, at $at}"
      else
        printf 'rc=%s\n' "$(cat "$dir/rc")"
      fi
      exit 0 ;;
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

# tree_scan <dir>: the run's tree as process groups (header, `stop`; ludics-lite#510 and the
# slot-held batch's escapee). Seeds: the group the wrapper leads, under the wrapper's start time
# from `pid`, and every further `process group <g> <start>` line of the marker `stopped`. A group
# is the run's and LIVE when its leader runs under the recorded start time, or, its leader gone,
# when a member that has not exited is left in it; a leader pid running under another start time
# (or none recorded) is another process, which the system could give that id only once the run's
# group was gone. From the live groups it then finds the rest of the tree: every process of a live
# group, every descendant of those (by parent pid), and the group of each, a group the run's
# processes formed outside the wrapper's (`execution slot` puts its batch in a session of its
# own, and a test runner's phases lead groups of their own) recorded with its leader's start time
# and live. Never the group of the process asking (`stop`'s, `wait`'s), nor 0 or 1.
# Sets TREE (one `<g> <start or -> <0|1>` line per group, the seeds first, in the marker's order),
# TREE_LIVE (the live groups' ids, blank-separated, empty for none) and TREE_NEW (the groups found
# this scan). Where ps cannot list the processes, only the seeds are judged, each by kill -0 on its
# group and its leader's identity where it can still be read (the wrapper's as `alive` reads it).
tree_scan() {
  tdir=$1
  { IFS= read -r lead; IFS= read -r lt; } < "$tdir/pid"
  seeds="$lead ${lt:--}"
  if [ -f "$1/stopped" ]; then
    while read -r w1 w2 sg st _; do
      [ "$w1 $w2" = 'process group' ] || continue
      case $sg in ''|*[!0-9]*) continue ;; esac
      [ "$sg" != "$lead" ] || continue
      seeds="$seeds $sg ${st:--}"
    done < "$1/stopped"
  fi
  # THE START TOKEN: the table spells every start as a tick on Linux, so a seed recorded as an
  # lstart (a run from before #786) that is still its process's is re-spelt as that process's tick
  # for the comparisons below; one that is not keeps its lstart, which no tick equals.
  if [ "$TOKEN_KIND" = tick ]; then
    norm=
    set -- $seeds
    while [ $# -ge 2 ]; do
      sg=$1 st=$2; shift 2
      case $st in
        -) ;;
        *[!0-9]*) if start_is "$sg" "$st"; then now=$(tick_of "$sg"); [ -z "$now" ] || st=$now; fi ;;
      esac
      norm="$norm $sg $st"
    done
    seeds=${norm# }
  fi
  me=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')
  if [ "$TOKEN_KIND" = tick ]; then
    # ps lists the processes, as everywhere; each one's start is its tick, read as tick_of reads
    # it (an awk regex for the last `) `), and blank where its stat is gone by now.
    table=$(ps -A -o pid= -o ppid= -o pgid= -o stat= 2>/dev/null | awk '{
      t = ""; f = "/proc/" $1 "/stat"
      if ((getline l < f) > 0) { n = split(l, a, /[)] /); if (split(a[n], b, " ") >= 20) t = b[20] }
      close(f)
      print $1, $2, $3, $4, t
    }')
  else
    table=$(TZ=UTC LC_ALL=C ps -A -o pid= -o ppid= -o pgid= -o stat= -o lstart= 2>/dev/null)
  fi
  if [ -z "$table" ]; then
    TREE='' TREE_LIVE='' TREE_NEW=''
    set -- $seeds
    while [ $# -ge 2 ]; do
      sg=$1 st=$2; shift 2
      live=0
      # A running leader is the run's only under its recorded identity: the wrapper's as `alive`
      # checks it, another's by the start time the marker recorded (where ps cannot say even that,
      # the bare group stands, as it always did here); a group whose leader is gone, by kill -0.
      if [ "$sg" = "$lead" ]; then
        if group_left "$sg" && { ! running "$sg" || alive "$tdir/pid"; }; then live=1; fi
      elif running "$sg"; then
        if [ "$st" != - ] && start_is "$sg" "$st"; then live=1; fi
      elif kill -0 -- "-$sg" 2>/dev/null; then live=1
      fi
      TREE="$TREE$sg $st $live
"
      [ "$live" -eq 0 ] || TREE_LIVE="$TREE_LIVE $sg"
    done
    TREE_LIVE=${TREE_LIVE# }
    return 0
  fi
  TREE=$(printf '%s\n' "$table" | awk -v seeds="$seeds" -v me="${me:-0}" '
    BEGIN {
      n = split(seeds, s, " ")
      for (i = 1; i + 1 <= n; i += 2) {
        if (s[i] in tok) continue
        ord[++ng] = s[i]; tok[s[i]] = s[i + 1]; known[s[i]] = 1
      }
    }
    {
      p = $1; pp[p] = $2; pg[p] = $3; st[p] = $4; ls = ""
      for (k = 5; k <= NF; k++) ls = ls $k
      start[p] = ls; rows[++nr] = p
    }
    function gone(q) { return st[q] ~ /^[ZX]/ }
    END {
      for (i = 1; i <= ng; i++) {
        g = ord[i]; live[g] = 0
        if ((g in st) && !gone(g)) live[g] = (tok[g] != "-" && tok[g] == start[g])
        else for (r = 1; r <= nr; r++) { q = rows[r]; if (pg[q] == g && !gone(q)) { live[g] = 1; break } }
        if (live[g]) inside[g] = 1
      }
      more = 1
      while (more) {
        more = 0
        for (r = 1; r <= nr; r++) {
          q = rows[r]
          if ((q in tree) || gone(q) || !((pg[q] in inside) || (pp[q] in tree))) continue
          tree[q] = 1; more = 1; g = pg[q]
          if ((g in known) || g == me || g <= 1) continue
          ord[++ng] = g; known[g] = 1; inside[g] = 1; live[g] = 1; fresh[g] = 1
          tok[g] = ((g in start) && start[g] != "" && !gone(g)) ? start[g] : "-"
        }
      }
      for (i = 1; i <= ng; i++) printf "%s %s %d%s\n", ord[i], tok[ord[i]], live[ord[i]], (ord[i] in fresh) ? " new" : ""
    }')
  TREE_LIVE=$(printf '%s\n' "$TREE" | awk '$3 == 1 { printf "%s%s", s, $1; s = " " }')
  TREE_NEW=$(printf '%s\n' "$TREE" | awk '$4 == "new" { printf "%s%s", s, $1; s = " " }')
  TREE=$(printf '%s\n' "$TREE" | awk '{ print $1, $2, $3 }')
}

# record_tree <dir>: the marker `stopped`, rewritten (complete, by rename) to name every group in
# TREE: the wrapper's first, as `process group <g>`, then `process group <g> <leader start>` for
# each other one, so a later wait or stop judges each as tree_scan does. 1 when it cannot be written.
record_tree() {
  { IFS= read -r lead; } < "$1/pid"
  {
    printf 'process group %s\n' "$lead"
    printf '%s\n' "$TREE" | awk -v lead="$lead" 'NF >= 2 && $1 != lead { print "process group", $1, $2 }'
  } > "$1/.stopped.$$" && mv -f -- "$1/.stopped.$$" "$1/stopped" && return 0
  rm -f -- "$1/.stopped.$$"
  return 1
}

# stop <dir>: end a spawned run's whole process group (header; ludics-lite#510).
cmd_stop() {
  [ $# -eq 1 ] || usage
  dir=$1
  grace=${BG_RUN_STOP_GRACE:-}
  case $grace in *[!0-9]*) say "not a whole number of seconds: $(printf '%q' "$grace")"; exit 2 ;; esac
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
  # THE GRACES: BG_RUN_STOP_GRACE when given; else the grace the run's start recorded (the third
  # line of its pid); else, for a run whose start recorded none, the one this environment derives.
  if [ -z "$grace" ]; then
    rec=
    { IFS= read -r _; IFS= read -r _; IFS= read -r rec; } < "$dir/pid"
    case $rec in
      ''|*[!0-9]*) run_grace || bad_grace "nothing was signalled"; grace=$G ;;
      *) grace=$rec ;;
    esac
  fi
  grace=$((10#$grace))
  # The identity again, immediately before the signal, to keep the window narrow (header).
  verdict "$dir"
  if [ "$V" != RUNNING ]; then
    printf '%s\n' 'NOT RUNNING: the run ended while stop read it; nothing was signalled'
    exit 1
  fi
  # The tree, read before anything is signalled, while every process of it still has its parent
  # (header; tree_scan): the groups the run formed outside the wrapper's are found through their
  # parents, which a TERM may take away.
  tree_scan "$dir"
  if [ -z "$TREE_LIVE" ]; then
    printf '%s\n' 'NOT RUNNING: the run ended while stop read it; nothing was signalled'
    exit 1
  fi
  # The marker before the signal (header): a wait that reads the wrapper gone reads STOPPED, never
  # the DIED whose re-arm would relaunch what is being stopped. It names every group of the tree,
  # so a wait reads RUNNING, not STOPPED, while any of them has a member left.
  record_tree "$dir" || {
    say "refused: cannot publish the stopped marker in $(printf '%q' "$dir"), so a wait there would read DIED; nothing was signalled"
    exit 2
  }
  # TERM to the wrapper's group while it has a member: the command ends what it runs outside the
  # group itself (header), and gets the grace to. A stop that finds only a remnant outside it (a
  # stop ended inside its grace) signals the remnant's groups. A group already gone keeps the
  # marker (header): another stop may have ended it.
  sent=
  case " $TREE_LIVE " in
    *" $g "*) kill -TERM -- "-$g" 2>/dev/null && sent=1 ;;
    *) for h in $TREE_LIVE; do kill -TERM -- "-$h" 2>/dev/null && sent=1; done ;;
  esac
  if [ -z "$sent" ]; then
    printf '%s\n' 'NOT RUNNING: the run ended while stop read it; nothing was signalled'
    exit 1
  fi
  how=TERM
  t0=$SECONDS
  while :; do
    tree_scan "$dir"
    [ -z "$TREE_NEW" ] || record_tree "$dir" || say "cannot record process groups $TREE_NEW in the stopped marker; a wait may read STOPPED while they run"
    [ -n "$TREE_LIVE" ] || break
    if [ $((SECONDS - t0)) -ge "$grace" ]; then
      how="TERM, then KILL after $grace s"
      # KILL to every group of the tree left, and to any the dying tree still forms; a killed
      # member is gone at once, short of a process stuck in the kernel: 2 s for it.
      n=0
      while [ -n "$TREE_LIVE" ] && [ "$n" -lt 20 ]; do
        for h in $TREE_LIVE; do kill -KILL -- "-$h" 2>/dev/null; done
        sleep 0.1; n=$((n + 1))
        tree_scan "$dir"
        [ -z "$TREE_NEW" ] || record_tree "$dir" || say "cannot record process groups $TREE_NEW in the stopped marker; a wait may read STOPPED while they run"
      done
      break
    fi
    sleep 0.2
  done
  others=$(printf '%s\n' "$TREE" | awk -v g="$g" 'NF && $1 != g { printf " %s", $1 }')
  [ -z "$others" ] || others=" and the run's groups$others outside it"
  printf 'STOPPED %s: process group %s%s (%s)\n' "$dir" "$g" "$others" "$how"
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
