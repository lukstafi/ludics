"""``execution leg``: one reserved run of a project's runner on a fleet box, at an exact commit
(ludics-lite#558).

Every worker that needed a correctness leg on another box hand-wrote the same script -- create or
refresh a worktree at an exact SHA there, run the project's runner, maybe apply a patch that must
make it fail -- and the 2026-10-05 wave paid for each copy: a fetch resolved from a linked worktree,
which cannot see the main checkout's ``FETCH_HEAD``; a hard-coded commit re-pinned twice. This verb
is that script, once, inside the reservation:

    execution leg --request <id> [--box <box>] --rev <sha|branch> --checkout <dir> --worktree <dir>
                  [--remote <name>] [--control <patch>] [--cpu|--gpu] [--wait <s>]
                  [--wait-window[=<s>]] [--deadline <s>] -- <runner command...>

THE RESERVATION. ``--request`` names a dispatched record (``launching``, ``running`` or
``uncertain``; a standing iteration record counts), read from the anchor's registry, which needs no
coordinator identity. The box is the record's execution host (``--box``, when given, must be it);
a correctness record runs the runner under ``execution slot`` on that box (``--cpu``/``--gpu``,
``--wait``, ``--wait-window``, ``--deadline`` passed to it), a measurement under ``execution hold
--request <id>`` (``--deadline`` alone). When the registry binds the record to one commit
(``registry.bound_commit``: a ``head-of:<branch>`` request's ``resolved_revision``, or a non-standing
request whose ``requested_revision`` is exactly one commit, ludics-lite#634), ``--rev`` must come to
exactly that commit.

THE WINDOW WAIT (ludics-lite#666). A standing record a measurement window has ``suspended`` is
refused at once -- unless the leg was given ``--wait-window[=<s>]``, when it waits here, on the
caller's box, in the slot's own wait (``slot.await_measurements``, in this verb's voice): until no
measurement is outstanding on the record's box and the record is no longer suspended, re-reading
the anchor's registry, for at most the bound (when none is given, to the window's recorded deadline,
or an hour where it records none: ludics-lite#737); past it, refused naming
the measurement, as the slot is. The record counts too, as held by the window it names, because a
listing is no snapshot: a conclusion restores the records it suspended and then concludes the
window, file by file, and an opening publishes the window and then suspends, so one read can show
the window concluded, or not yet listed, beside the record still suspended. A suspension the
registry never ends (which its conclusion rules out) is therefore waited out to the bound like a
window. Then the record is judged as above, and the leg goes on to the box with its flags as given:
a window opened after this wait (the next of a coordinator's back-to-back windows) is the slot's to
wait for there, under its own ``--wait-window``, as for any batch. So these are two waits, each
under the bound, as the slot's own window wait and slot wait are; the bound is not carried across
the setup between them (the copy, the ssh, the fetch), whose time no clock on either side measures
for the other. The leg waits for no window when its record is not suspended: the slot on the box
does, as for any batch.

Its boundary: a bounded, best-effort wait that re-reads the registry. It ends at once when the
record is gone or concluded (a worker handing back mid-window), and otherwise proceeds only on a
read in which the record is active again; the leg then judges that record as above (launching,
running or uncertain), so it never runs against a record that read showed suspended or concluded.
It refuses loudly on a registry it cannot read at the bound, and at the bound. When a refusal
lands within a poll interval of the window's own end, or which of two failed reads it names, is
outside it.

THE CHECKOUT AND THE REVISION, on the box (paths absolute, or ``~/``): ``--checkout`` is a git
checkout of the project there, ``--worktree`` a LINKED worktree of it (never the main one), made
with ``git worktree add --detach`` when the path does not exist and checked out ``--detach`` at
the commit when it does -- refused when it is another repository's, or has uncommitted changes,
which a leg never overwrites; and refused when it is not clean once at the commit, submodules
included (a submodule the checkout moved past is refused, never updated). A ``~/`` must arrive
quoted: one the caller's shell expanded names that host's home, and a checkout or worktree refused
under a home directory that is not the box's says so (``NOT_HOME``, ludics-lite#669). A runner that is no
executable command in the worktree is refused before it is counted as run. A full SHA already in the checkout is used as it is; anything else is
fetched from ``--remote`` (``origin``) -- a branch as ``refs/heads/<rev>``, so a tag of the same
name is never taken for it -- INTO A PRIVATE REF of the checkout, ``refs/fleet-leg/<pid>``,
and resolved there: never through ``FETCH_HEAD``, which a linked worktree cannot see and which two
legs fetching in one checkout would overwrite. The ref is deleted once the worktree holds the
commit. ``observed_sha`` is the worktree's ``git rev-parse HEAD`` before the runner starts. The fetch is
bounded by FLEET_FETCH_TIMEOUT (300 s). One leg at a time holds a worktree, from its status check
through the control's revert (a flock under ``$STATE/leg-locks``, keyed by the worktree's physical
path, held by every process the leg starts, the runner's wrapper included, so it outlives a far
shell that dies first): a second is refused, never queued, since a worktree moved under a running leg would make it test another commit than the one
it reports.

THE RUNNER. The command after ``--`` runs in the worktree, its argv passed untouched (each word
quoted for the box's shell), stdin closed; nothing here names a project's runner. Its status is the
leg's, unchanged -- a 125 or a signal's 128+n survives the trip -- and the last line on stdout is
``execution-leg: exit: <status>``, the sentinel ``conclude --from-bg-run`` reads. This verb prints
that line itself, once the far side has ended, and only when the far side reported the status under
this invocation's own random token (``execution-leg <token>: exit: <status>``, consumed, never
passed through): a runner's output -- a nested leg's sentinel, say -- cannot stand in for it, even
when the connection drops after printing it. A runner's own plain sentinel lines pass through as
output.

Each run (the main one, the control) is a nested ``execution slot --deadline`` inside the leg's slot
or hold, taking none of its own: its process group is reaped when the runner returns, so nothing the
runner left in the background overlaps the next run. The bound is the leg's ``--deadline``, or a
day, for each run; the enclosing slot or hold takes none, so a main run cannot spend the control's.
After the control, the reverted worktree must be clean at the commit again, or it is NO CONTROL.

THE CONTROL. With ``--control <patch>`` (a file on this box, copied to the box's state directory),
the patch must apply (``git apply --check``) before anything runs. After a main run that passed it
is applied, the runner runs again in the same slot and must FAIL, and the patch is reverted. The
leg's status is then 0 when the control failed (1-127 but 124, the slot's deadline); 1 when it
passed (``CONTROL PASSED``: the runner does not see what the patch breaks); the control's own status
when it was cut by the deadline or a signal (124, 128+), the patch reverted all the same; a patch
that cannot be reverted is ``CONTROL NOT REVERTED``, status 1, whatever the control did. A control
that is not exercised is ``NO CONTROL``, status 1, never a pass: its nested slot never started the
runner, the runner was no executable command with the patch applied, or the main run left the
worktree at another commit than the one the leg reports, or not clean. A main run
that failed is the leg's status, and the control does not run.

After the run, beside the warning that the runner moved HEAD, a worktree the runner left with
changed or untracked paths is said (``WARNING: <wt> has N uncommitted path(s) after the run``,
ludics-lite#749): the next leg refuses that worktree, and the runner that auto-promoted goldens into
it should be caught by the leg that ran it. It is a warning, never a status. It is not printed when
the control patch was applied (the after-control check judges that state) or when the main run
already recorded the dirt as NO CONTROL.

WHAT THE STATUS MEANS. The runner's, when the sentinel line was printed. Without it, nothing ran to
an end: an ``EXECUTION LEG REFUSED`` line says why (1; 2 usage; the slot's own refusal status when
the slot never started the runner), or ``EXECUTION LEG UNREACHABLE`` (4) that the box never answered
or the connection dropped, with the runner perhaps started -- find out on the box before a retry.

THE RECORD'S CHECKOUT (ludics-lite#749). A record that names a ``checkout`` (registry.py's THE
CHECKOUT: the one checkout its conclusion reads, for a leg the far-side worktree) refuses a
``--worktree`` that is not it, before anything is copied to the box: a leg under a standing id must
not move another worker's worktree. The comparison is ``execution.same_checkout``, the rule
``conclude --observed-from`` applies, and its boundary: lexical, byte-equal once trailing ``/`` or
``\\`` are dropped, no symlink resolved, no ``~`` expanded, so another spelling of the same directory
is refused, naming the recorded one. A record that names none is not checked; ``--checkout`` is not.

THE BACKEND PIN (ludics-lite#766). Four legs meant for CUDA or HIP ran with no backend selected,
resolved to the CPU backend, and reported green. The backend's names are the project's, so the
project states them: ``.github/fleet-leg``, read on the box from the checkout's object store AT THE
COMMIT under test (``git show <sha>:.github/fleet-leg``), before the worktree is touched. Its
grammar, a fail-closed allowlist: blank lines, ``#`` comment lines, and
  - ``pin-flag <option>``: the runner's argv holds ``<option> <value>`` or ``<option>=<value>``, the
    value nonempty, among its words after the first and before its first ``--`` (what follows a
    ``--`` is passed on to something else);
  - ``pin-env <NAME>``: the runner is ``env NAME=<value> ... <command>``, its first word ``env`` and
    NAME among the assignments that directly follow it.
Any other line refuses the leg, naming it: a file this leg cannot read is never ignored. A leg that
may hold the GPU -- one that does not declare ``--cpu``, the slot's own fail-closed definition, so a
measurement's too -- whose repository's file names a pin and whose argv satisfies none is refused
before anything runs. The boundary: argv words as given, nothing else -- a pin inside a ``sh -c``
string, an environment the caller exported (it does not travel to the box), or a project file that
selects the backend does not count. It establishes that the command NAMES a backend, never that the
run held it: that is the runner's own check (OCANNL's ``--expect-backend``), and no refusal here is
GPU evidence. A repository without the file, and a ``--cpu`` leg, are not checked.

THE STOP (ludics-lite#767). The far side reports its shell's pid first, under this invocation's
token (``execution-leg <token>: far: <pid>``, consumed, never passed through). While the leg streams,
a SIGTERM, SIGINT or SIGHUP to it (``bg-run.sh stop`` signals the run's whole group; a Ctrl-C) ends
the far side too, where until #767 it ran on holding the worktree's lock: the leg starts ``STOP`` on
the box in a session of its own (so the stop's group signals do not cut it), which, once the pid
still carries the token, sends SIGTERM to the far shell (in its setup this ends it; during the runs
a trap defers it) and, every second for up to 30 s, to the far shell's ``execution slot`` or
``execution hold`` child, the wrapper, which ends the runner's process group and dies (group.py, THE
SIGNALLED WRAPPER). The far shell then winds down as after any ended run -- the control reverted,
its files removed -- even with its connection gone, since it ignores SIGPIPE once the wrapper has
returned. The leg waits up to 8 s for the stop's report, then dies of the signal it got; a second
signal ends it at once. The boundary: only a signal the leg receives while it streams reaches the
far side. A SIGKILL of the leg, a dropped connection, and a box that ssh cannot reach at stop time
(``EXECUTION LEG STOP UNREACHABLE``, which prints the pid and the command that ends it there) leave
the runner running, as UNREACHABLE says. A stop in the far side's setup ends its shell, and a git
command it started finishes on its own; its private ref and staged patch are left. A process the
runner moved out of its group (``setsid``) is not reached. The stop reads ``ps -o args`` on the box
(Linux, macOS, WSL).
"""

import os
import re
import secrets
import signal
import subprocess
import sys
import threading
from collections.abc import Callable
from types import FrameType
from typing import Any

from ludics import cli
from ludics.fleetworker import execution, revision, slot
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.preflight import knob
from ludics.fleetworker.registry import bound_commit, ref_name_ok
from ludics.fleetworker.transport import fleet_name, far_argv, is_local, prelude, put_file, substitution

USAGE = (
    "execution leg --request <id> [--box <box>] --rev <sha|branch> --checkout <dir> --worktree <dir>"
    " [--remote <name>] [--control <patch>] [--cpu|--gpu] [--wait <seconds>] [--wait-window[=<seconds>]]"
    " [--deadline <seconds>] -- <runner command...>"
)
DISPATCHED = ("launching", "running", "uncertain")
HEX = re.compile(r"[0-9a-fA-F]{7,}")
OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
REMOTE = re.compile(r"[A-Za-z0-9._-]+")
SECONDS = re.compile(r"[1-9][0-9]*")
WHOLE = re.compile(r"[0-9]+")
RUN_BOUND = "86400"  # each run's --deadline when the leg names none: a day, a bound only to reap with
HELD_BACK = 64  # bytes of an unfinished line kept back for the status line; it is never longer than 45

# A HINT FOR A PATH FROM ANOTHER BOX'S HOME (ludics-lite#669), appended to the far side's refusals of
# a --checkout or --worktree it cannot use. A `~` the CALLER's shell expanded arrives as that box's
# home (rog's /home/<user> at mac-studio, whose home is /Users/<user>), which expand_tilde, seeing no
# `~`, cannot undo. Its boundary, an allowlist: a path under /home/<name> or /Users/<name> whose home
# directory is neither this box's $HOME nor, physically, the directory $HOME is, and which is not
# under $HOME, gets the hint; any other path, and a box with no $HOME, gets none (empty output). It
# says why only as a question: another user's home on this box is the same shape.
NOT_HOME = r"""not_home() {
  local rest name top here
  case "$1" in /home/?*|/Users/?*) ;; *) return 0 ;; esac
  [ -n "${HOME:-}" ] || return 0
  case "$1" in "${HOME%/}"|"${HOME%/}"/*) return 0 ;; esac
  rest=${1#/*/}; name=${rest%%/*}; [ -n "$name" ] || return 0
  top="${1%%/"$rest"}/$name"
  here=$(cd "$HOME" 2>/dev/null && pwd -P) || here=${HOME%/}
  [ -d "$top" ] && [ "$(cd "$top" 2>/dev/null && pwd -P)" = "$here" ] && return 0
  printf "; %s is not %s's home directory (%s): a ~ expanded by the caller's shell? spell far-side paths absolutely, or quote '~/...'" "$top" "$BOX" "$HOME"
}
"""

# THE BACKEND PIN (see the header): `backend_pin <file text> <gpu: 0|1> <runner argv...>` exits 0
# when the leg may run, and otherwise prints why (one line, no prefix) and exits 1. The file is
# parsed whatever the leg declares, so a line this version cannot read refuses a --cpu leg too.
# Bash 3.2: no arrays of its own, no case conversion.
PIN = r"""backend_pin() {
  local text="$1" gpu="$2" d w extra good n=0 flags="" envs="" a f prev first want=""
  shift 2
  while read -r d w extra || [ -n "$d" ]; do
    n=$((n + 1))
    case "$d" in ''|'#'*) continue ;; esac
    good=""
    case "$d" in
      pin-flag) case "$w" in -*[!A-Za-z0-9_.-]*|-|--) ;; -*) good=1 ;; esac ;;
      pin-env) case "$w" in *[!A-Za-z0-9_]*|[0-9]*|'') ;; *) good=1 ;; esac ;;
    esac
    if [ -z "$good" ] || [ -n "$extra" ]; then
      printf '%s' ".github/fleet-leg line $n is not one this leg reads ($d${w:+ $w}${extra:+ $extra}): pin-flag <option>, pin-env <NAME>, a # comment or a blank line"
      return 1
    fi
    if [ "$d" = pin-flag ]; then flags="$flags $w"; want="$want, $w <backend>"; else envs="$envs $w"; want="$want, env $w=<backend>"; fi
  done <<FLEET_LEG_PIN
$text
FLEET_LEG_PIN
  [ "$gpu" = 1 ] && [ -n "$flags$envs" ] || return 0
  if [ -n "$envs" ] && [ "${1##*/}" = env ]; then
    first=1
    for a in "$@"; do
      if [ -n "$first" ]; then first=""; continue; fi
      case "$a" in [A-Za-z_]*=?*) ;; *) break ;; esac
      for f in $envs; do case "$a" in "$f="?*) return 0 ;; esac; done
    done
  fi
  first=1; prev=""
  for a in "$@"; do
    if [ -n "$first" ]; then first=""; continue; fi
    [ "$a" != -- ] || break
    [ -z "$prev" ] || [ -z "$a" ] || return 0
    prev=""
    for f in $flags; do
      [ "$a" != "$f" ] || prev=1
      case "$a" in "$f="?*) return 0 ;; esac
    done
  done
  printf '%s' "this leg may hold the GPU (no --cpu), but its runner pins no backend, and .github/fleet-leg asks for one of: ${want#, }; pin it (as words of the runner's own argv), or declare --cpu for a leg that holds no GPU"
  return 1
}
"""

# The far side, after the prelude. Args: checkout, worktree, remote, rev, want (the assigned commit or
# empty), patch name (in $STATE/leg-control, or empty), request id, the fetch's bound in seconds
# (FLEET_FETCH_TIMEOUT), the status token (see the header), the wrapper's word count and
# words (fleet-worker.sh's own verb and flags, ending before its `--`), each run's nested-slot
# flags' count and words, then the runner's argv.
LEG = NOT_HOME + PIN + r"""co=$(expand_tilde "$1") wt=$(expand_tilde "$2") remote="$3" rev="$4" want="$5" pname="$6" request="$7" fetch_timeout="$8" token="$9" nwrap="${10}"
# THE STOP (see the header): this shell's pid, first, under the token; the leg keeps it.
printf 'execution-leg %s: far: %s\n' "$token" "$$"
shift 10
fw="$SKILLS_REPO/issue-wave/scripts/fleet-worker.sh"
wrap=("$fw")
while [ "$nwrap" -gt 0 ]; do wrap+=("$1"); shift; nwrap=$((nwrap - 1)); done
nnest="$1"; shift; nest=()
while [ "$nnest" -gt 0 ]; do nest+=("$1"); shift; nnest=$((nnest - 1)); done
patch=""; [ -z "$pname" ] || patch="$STATE/leg-control/$pname"
ref="refs/fleet-leg/$$"; results=""
say() { printf 'EXECUTION LEG %s: %s\n' "$BOX" "$*" >&2; }
cleanup() {
  [ -z "$patch" ] || rm -f "$patch"
  [ -z "$results" ] || rm -f "$results" "$results.sh"
  git -C "$co" update-ref -d "$ref" >/dev/null 2>&1
  return 0
}
refuse() { printf 'EXECUTION LEG REFUSED %s: %s\n' "$BOX" "$*" >&2; cleanup; exit 1; }
finish() { cleanup; printf 'execution-leg %s: exit: %s\n' "$token" "$1"; exit "$1"; }
# A path's git common directory, physical; empty when it is no checkout.
common() { (cd "$1" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P); }
gitdir() { (cd "$1" 2>/dev/null && cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P); }
# What makes a worktree not the commit at its HEAD: changed, staged or untracked paths and
# submodules, whatever the configuration says to show or ignore; git's own failure is its status,
# never an empty (clean) answer.
dirt() { git -C "$1" status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null; }
[ -x "$fw" ] || refuse "no executable fleet-worker.sh at $fw (the skills checkout on $BOX; run fleet-worker.sh refresh $BOX)"
cdir=$(common "$co"); [ -n "$cdir" ] || refuse "--checkout $co is not a git checkout on $BOX$(not_home "$co")"
# One leg at a time in a worktree, from the status check through the control's revert: a second
# leg moving it would make the first test another commit than the observed_sha it reports. The lock
# is a flock on a file under $STATE/leg-locks, taken on descriptor 9 of this shell, which every
# process started from here inherits -- the slot or hold wrapper included, which stays the parent of
# the runner's group for as long as any of it runs. A flock belongs to the open file, so it holds
# until the last of those processes has exited: this shell dying while the runner runs on (a
# dropped connection) does not free the worktree. Taken by scripts/py (Python >= 3.12, which
# `execution slot` needs on the box anyway), since macOS has no flock(1).
# The key: the nearest existing ancestor's physical path, then the rest as given, so a leg before the
# worktree exists and one after it name the same lock.
canon() {
  local p="$1" rest="" base
  while [ ! -d "$p" ] && [ "$p" != / ] && [ "$p" != . ]; do rest="/$(basename "$p")$rest"; p=$(dirname "$p"); done
  base=$(cd "$p" && pwd -P) || return 1
  printf '%s%s' "${base%/}" "$rest"
}
wkey=$(canon "$wt") || refuse "cannot resolve --worktree $wt on $BOX$(not_home "$wt")"
mkdir -p "$STATE/leg-locks" || refuse "cannot create $STATE/leg-locks on $BOX"
wlock="$STATE/leg-locks/$(printf '%s' "$wkey" | cksum | tr ' ' -)"
exec 9>>"$wlock" || refuse "cannot open the worktree lock $wlock on $BOX"
"$SKILLS_REPO/scripts/py" -c 'import fcntl, sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(3)' </dev/null; lrc=$?
[ "$lrc" -ne 3 ] || refuse "--worktree $wt: another leg is using it (lock $wlock); wait for it, or name another worktree"
[ "$lrc" -eq 0 ] || refuse "cannot lock --worktree $wt ($SKILLS_REPO/scripts/py exit $lrc, above)"
# The commit, into a private ref of the checkout (never FETCH_HEAD: see the module header).
case "$rev" in *[!0-9a-f]*) sha_like=0 ;; *) case ${#rev} in 40|64) sha_like=1 ;; *) sha_like=0 ;; esac ;; esac
if [ "$sha_like" = 1 ] && git -C "$co" cat-file -e "$rev^{commit}" 2>/dev/null; then
  sha=$rev how="already in $co"
else
  # A branch is named as one (refs/heads/...): an unqualified source would take a tag of the same
  # name first. A SHA is fetched as itself.
  src=$rev; [ "$sha_like" = 1 ] || src="refs/heads/$rev"
  # Without the worktree lock's descriptor: a transport process the bound outlives (a stalled
  # upload-pack's child) must not hold the worktree for the next leg.
  # (A subshell's `exec 9>&-`, not a redirection on the call, which bash keeps a saved copy of.)
  ( exec 9>&-; bounded "$fetch_timeout" env GIT_TERMINAL_PROMPT=0 git -C "$co" fetch -q --no-tags "$remote" "+$src:$ref" >&2 ); frc=$?
  [ "$frc" -ne 124 ] || refuse "git fetch $remote $rev in $co did not finish in ${fetch_timeout}s (FLEET_FETCH_TIMEOUT)"
  [ "$frc" -eq 0 ] || refuse "git fetch $remote $rev in $co failed (above): no such branch or commit on $remote, or $remote is unreachable from $BOX"
  sha=$(git -C "$co" rev-parse --verify -q "$ref^{commit}") || refuse "$rev fetched from $remote is not a commit"
  [ "$sha_like" = 0 ] || [ "$sha" = "$rev" ] || refuse "fetching $rev from $remote gave $sha"
  how="fetched from $remote"
fi
[ -z "$want" ] || [ "$sha" = "$want" ] ||
  refuse "$rev is $sha, but request $request was assigned $want: run --rev $want"
# THE BACKEND PIN (see the header): the project's rule at this commit, before the worktree moves.
if [ "$(git -C "$co" cat-file -t "$sha:.github/fleet-leg" 2>/dev/null)" = blob ]; then
  pins=$(git -C "$co" show "$sha:.github/fleet-leg") || refuse "cannot read .github/fleet-leg at $sha in $co (above)"
  case " ${nest[*]} " in *" --cpu "*) gpu=0 ;; *) gpu=1 ;; esac
  why=$(backend_pin "$pins" "$gpu" "$@") || refuse "$why (.github/fleet-leg at $sha); nothing ran"
fi
# The worktree: a linked worktree of the checkout, made or moved to the commit, never overwritten.
if [ -e "$wt" ] || [ -L "$wt" ]; then
  [ -d "$wt" ] || refuse "--worktree $wt exists and is not a directory"
  [ "$(common "$wt")" = "$cdir" ] || refuse "--worktree $wt exists but is not a worktree of $co; name a new path, or a worktree of that checkout"
  top=$(cd "$wt" && git rev-parse --show-toplevel 2>/dev/null)
  [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(cd "$wt" && pwd -P)" ] || refuse "--worktree $wt is inside a worktree, not its top"
  [ "$(gitdir "$wt")" != "$cdir" ] || refuse "--worktree $wt is the repository's main checkout; a leg moves only a linked worktree"
  [ "$(cd "$wt" && pwd -P)" != "$(cd "$co" && pwd -P)" ] || refuse "--worktree $wt is --checkout $co itself; a leg moves only another worktree"
  dirty=$(dirt "$wt") || refuse "cannot read the status of $wt"
  [ -z "$dirty" ] || refuse "--worktree $wt has uncommitted changes ($(printf '%s\n' "$dirty" | grep -c '') path(s)), which a leg never overwrites: clean it, or name another worktree"
  git -C "$wt" checkout -q --detach "$sha" </dev/null >&2 || refuse "git checkout --detach $sha in $wt failed (above)"
  made=refreshed
else
  git -C "$co" worktree prune >/dev/null 2>&1
  git -C "$co" worktree add -q --detach "$wt" "$sha" </dev/null >&2 || refuse "git worktree add --detach $wt $sha in $co failed (above)$(not_home "$wt")"
  made=created
fi
head=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}') || refuse "cannot read HEAD of $wt"
[ "$head" = "$sha" ] || refuse "HEAD of $wt is $head after checking out $sha"
# Clean at the commit, submodules included: a submodule the checkout moved past is refused, never
# updated, since the runner would test its old commit under this one's observed_sha.
dirty=$(dirt "$wt") || refuse "cannot read the status of $wt"
[ -z "$dirty" ] || refuse "$wt is not clean at $sha ($(printf '%s\n' "$dirty" | head -n 3 | tr '\n' ';')): a submodule that does not follow the checkout, or a file it left; a leg updates no submodule"
git -C "$co" update-ref -d "$ref" >/dev/null 2>&1
if [ -n "$patch" ]; then
  [ -f "$patch" ] || refuse "the control patch did not arrive at $patch"
  git -C "$wt" apply --check "$patch" >&2 || refuse "the control patch does not apply to $sha in $wt (above)"
fi
say "$made $wt at $sha ($rev, $how) for request $request; observed_sha=$head"
results=$(mktemp "${TMPDIR:-/tmp}/fleet-leg.XXXXXX") || refuse "cannot create a scratch file on $BOX"
# The runs, under ONE slot (or the measurement's hold): the main run, then the control. Each step
# that ends is written to the results file, so a wrapper that refused is told from a runner that ran.
# The script is a file beside it, so the slot's "held for" line names it rather than quoting it.
# Each run is a nested `execution slot --deadline` (inside the enclosing slot or hold, taking none
# of its own): with a deadline it leads a process group of its own, and a command that ends first
# takes anything it left running in that group with it (group.py, ludics-lite#566), so a runner's
# leftover background child cannot overlap the control run, nor outlive the leg.
cat > "$results.sh" <<'FLEET_LEG_RUNS' || refuse "cannot write a scratch file on $BOX"
wt="$1" patch="$2" results="$3" box="$4" fw="$5" head="$6" n="$7"; shift 7
nest=(); while [ "$n" -gt 0 ]; do nest+=("$1"); shift; n=$((n - 1)); done
cd "$wt" || exit 1
# go <tag> <runner...>: one run in its nested slot; <tag>-started is written by the shell the slot
# starts, just before it becomes the runner, so a slot that refused is told from a runner that ran.
go() {
  local tag="$1"; shift
  "$fw" execution slot "${nest[@]}" -- bash -c '
    case "$3" in */*) [ -f "$3" ] && [ -x "$3" ] ;; *) command -v "$3" >/dev/null ;; esac ||
      { printf "%s-unexecutable\n" "$1" >> "$2"; echo "EXECUTION LEG: $3 is not an executable command here" >&2; exit 127; }
    printf "%s-started\n" "$1" >> "$2"; shift 2; exec "$@"' leg-run "$tag" "$results" "$@" </dev/null
}
printf "started\n" >> "$results"
go main "$@"; rc=$?
printf "main=%s\n" "$rc" >> "$results"
{ [ "$rc" -eq 0 ] && [ -n "$patch" ] && grep -qx main-started "$results"; } || exit "$rc"
# The control is made against the commit the leg reports, clean, or not at all.
now=$(git rev-parse --verify -q "HEAD^{commit}")
[ "$now" = "$head" ] || { printf "moved=%s\n" "${now:-unreadable}" >> "$results"; exit 0; }
st=$(git status --porcelain --untracked-files=all --ignore-submodules=none) || { printf "dirty=unreadable\n" >> "$results"; exit 0; }
[ -z "$st" ] || { printf "dirty=%s\n" "$(printf "%s\n" "$st" | grep -c "")" >> "$results"; exit 0; }
git apply "$patch" >&2 || { printf "apply=failed\n" >> "$results"; exit 1; }
printf "applied\n" >> "$results"
printf "EXECUTION LEG %s: control patch applied; the runner again, which must fail\n" "$box" >&2
go control "$@"; crc=$?
printf "control=%s\n" "$crc" >> "$results"
git apply -R "$patch" >&2 && printf "revert=ok\n" >> "$results"
exit 0
FLEET_LEG_RUNS
# THE STOP (see the header): a TERM to this shell while the wrapper runs is deferred by the trap,
# never cutting a run; the stop ends the wrapper instead. A trap with a command is not inherited, so
# the wrapper and the runner get TERM at its default. Once the wrapper has returned this shell ignores
# SIGPIPE (never before: an ignored signal would be the runner's too), so a connection that is gone
# does not end it before the control is reverted and its files are removed.
stop_asked=""
trap 'stop_asked=1' TERM
fleet_worker "${wrap[@]}" -- bash "$results.sh" "$wt" "$patch" "$results" "$BOX" "$fw" "$head" "${#nest[@]}" "${nest[@]}" "$@" </dev/null; wrc=$?
trap '' PIPE
[ -z "$stop_asked" ] || say "stopped (SIGTERM from the leg's stop): the wrapper exit $wrc"
fact() { sed -n "s/^$1=//p" "$results" | head -n1; }
main=$(fact main)
now=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)
[ "$now" = "$head" ] || say "WARNING: HEAD of $wt is ${now:-unreadable} after the run, not $head (the runner moved it)"
# A worktree the run left dirty (ludics-lite#749), unless the control's checks below judge it.
if ! grep -qx applied "$results" && [ -z "$(fact dirty)" ]; then
  if left=$(dirt "$wt"); then
    [ -z "$left" ] || say "WARNING: $wt has $(printf '%s\n' "$left" | grep -c '') uncommitted path(s) after the run ($(printf '%s\n' "$left" | head -n 3 | tr '\n' ';')): the runner left them, and the next leg refuses this worktree until it is cleaned"
  else
    say "WARNING: cannot read the status of $wt after the run"
  fi
fi
if [ -z "$main" ]; then
  if grep -qx started "$results"; then
    say "the runner was ended before it returned (wrapper exit $wrc)"
    finish "$wrc"
  fi
  printf 'EXECUTION LEG REFUSED %s: the runner never started: %s exit %s (above)\n' "$BOX" "${wrap[*]}" "$wrc" >&2
  cleanup; exit "$wrc"
fi
if grep -qx main-unexecutable "$results"; then
  printf 'EXECUTION LEG REFUSED %s: the runner is not an executable command in %s (above); nothing ran\n' "$BOX" "$wt" >&2
  cleanup; exit 1
fi
if ! grep -qx main-started "$results"; then
  printf 'EXECUTION LEG REFUSED %s: the runner never started: its nested execution slot exit %s (above)\n' "$BOX" "$main" >&2
  cleanup; exit "$main"
fi
say "runner exit $main at $head"
{ [ "$main" -eq 0 ] && [ -n "$patch" ]; } || finish "$main"
moved=$(fact moved)
if [ -n "$moved" ]; then
  say "NO CONTROL: the main run left $wt at $moved, not $head, so a control there would not be about $head; no control verdict"
  finish 1
fi
left=$(fact dirty)
if [ -n "$left" ]; then
  say "NO CONTROL: the main run left $left changed or untracked path(s) in $wt, so a control failing there need not be the patch's doing; no control verdict"
  finish 1
fi
if [ "$(fact apply)" = failed ]; then
  printf 'EXECUTION LEG REFUSED %s: the control patch passed --check but did not apply after the run (above); %s may be dirty\n' "$BOX" "$wt" >&2
  cleanup; exit 1
fi
crc=$(fact control)
# A deadline or a signal that ended the control run ended the script that would have reverted the
# patch with it: the revert is made here, once the wrapper has reaped the group, while the patch is
# still on the box.
if [ "$(fact revert)" != ok ] && grep -qx applied "$results"; then
  if git -C "$wt" apply -R "$patch" >&2; then
    say "control patch reverted after the control run"
  else
    # The worktree is not the commit the leg reports, so no control verdict stands on it.
    say "CONTROL NOT REVERTED: the control patch could not be reverted in $wt (above), which a later leg will refuse until it is cleaned; no control verdict"
    finish 1
  fi
fi
# Reverted is not clean: the control run may have left files of its own, or moved HEAD.
if grep -qx applied "$results"; then
  left=$(dirt "$wt") || left="(git status failed)"; now=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)
  if [ -n "$left" ] || [ "$now" != "$head" ]; then
    say "NO CONTROL: after the control run $wt is not clean at $head ($(printf '%s\n' "$left" | head -n 3 | tr '\n' ';') HEAD ${now:-unreadable}), which a later leg will refuse until it is cleaned; no control verdict"
    finish 1
  fi
fi
if [ -z "$crc" ]; then
  say "the control run was ended before it returned (wrapper exit $wrc): no control verdict"
  finish "$wrc"
elif grep -qx control-unexecutable "$results"; then
  say "NO CONTROL: the control run could not execute the runner (the patch removed it, or its mode); no control verdict"
  finish 1
elif ! grep -qx control-started "$results"; then
  say "NO CONTROL: the control's nested execution slot never started the runner (exit $crc, above); no control verdict"
  finish 1
elif [ "$crc" -eq 0 ]; then
  say "CONTROL PASSED: the runner passed with $pname applied, so it does not detect what the patch breaks"
  finish 1
elif [ "$crc" -eq 124 ] || [ "$crc" -ge 128 ]; then
  say "the control run was cut (exit $crc): no control verdict"
  finish "$crc"
fi
say "control failed as required (exit $crc), patch reverted"
finish 0
"""

# THE STOP's far side (see the header), after the prelude. Args: the far shell's pid, the leg's token,
# the bound in seconds. It ignores SIGPIPE so that a connection cut under it does not end it before
# its signals are sent.
STOP = r"""pid="$1" token="$2" bound="$3"
trap '' PIPE
say() { printf 'EXECUTION LEG STOP %s: %s\n' "$BOX" "$*" >&2; }
# Still this leg: the pid's command line carries the token (bash -s -- ... <token> ...), which a
# process the system gave the pid since does not.
ours() { case " $(ps -ww -o args= -p "$pid" 2>/dev/null) " in *" $token "*) return 0 ;; esac; return 1; }
ours || { say "no leg with token $token runs as pid $pid: it has ended; nothing was signalled"; exit 0; }
# In its setup this ends the far shell; while the wrapper runs, its trap defers it.
kill -TERM "$pid" 2>/dev/null
sent=" "; t=0
while ours; do
  for kid in $(ps -A -ww -o pid=,ppid=,args= 2>/dev/null | awk -v p="$pid" '$2 == p && / execution (slot|hold)( |$)/ { print $1 }'); do
    case "$sent" in *" $kid "*) continue ;; esac
    sent="$sent$kid "
    kill -TERM "$kid" 2>/dev/null && say "SIGTERM to the leg's wrapper (pid $kid), which ends the runner's process group"
  done
  [ "$t" -lt "$bound" ] || { say "the leg (pid $pid) still runs after ${bound}s, holding its worktree's lock; look on $BOX"; exit 1; }
  sleep 1; t=$((t + 1))
done
say "the leg (pid $pid) has ended"
"""
STOP_BOUND = "30"  # seconds the far stop waits for the far shell to end
STOP_WAIT = 8.0  # seconds the leg waits for the far stop, under bg-run.sh stop's 10 s grace
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)


class LegStopped(Exception):
    """A signal ended the leg while it streamed (THE STOP); the far side was dealt with."""

    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


def refused(text: str, rc: int = 1) -> int:
    cli.say(f"EXECUTION LEG REFUSED: {text}")
    return rc


LEG_VOICE = slot.Voice("EXECUTION LEG", "running the leg", "nothing ran")


def window_bound(slot_flags: list[str]) -> slot.WindowBound | None:
    """The leg's ``--wait-window`` bound, the last given winning as in the slot: its seconds, or for a
    bare one ``slot.BY_DEADLINE`` (the window's own deadline, ludics-lite#737); None without one."""
    bound: slot.WindowBound | None = None
    for flag in slot_flags:
        if flag == "--wait-window":
            bound = slot.BY_DEADLINE
        elif flag.startswith("--wait-window="):
            bound = int(flag[len("--wait-window=") :])
    return bound


def await_window(cfg: Config, request: str, record: dict[str, Any], records: list[dict[str, Any]],
                 slot_flags: list[str], runner: list[str]) -> dict[str, Any] | int:
    """THE WINDOW WAIT (see the header) for a ``suspended`` record: the record read again once no
    measurement holds its box; or the refusal's status."""
    window = execution.jq_text(record.get("suspended_by"))
    bound = window_bound(slot_flags)
    if bound is None:
        return refused(f"{request} is suspended by measurement window {window}; run the leg once that window"
                       " concludes, or give it --wait-window, which waits for it")
    host = execution.jq_text(execution.field(record, "request", "execution_host"))

    def holders(read: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # The box's measurements; else the window this record is still suspended by, from the read
        # or by its id alone when the read does not list it (a torn read, see the header).
        own = execution.record_of(read, request)
        if own is None or own.get("state") not in ("suspended", *DISPATCHED):
            return []  # gone or concluded: nothing to wait for, and the leg refuses it
        held = slot.measurement_records(read, host)
        if held or own.get("state") != "suspended":
            return held
        by = execution.jq_text(own.get("suspended_by"))
        return [execution.record_of(read, by) or {"request_id": by, "window": True}]

    waited = slot.await_measurements(cfg, host, records, bound, runner, LEG_VOICE, holders, registered=True)
    if isinstance(waited, int):
        return waited
    again = execution.record_of(waited, request)
    if again is None:
        return refused(f"unknown request_id {request} after waiting for window {window}: a leg runs only inside"
                       " a dispatched reservation")
    return again


def box_path(value: str, flag: str) -> str:
    """A path on the box: absolute, or ``~/`` (expanded there)."""
    if not (value.startswith("/") or value.startswith("~/")):
        die(f"execution leg: {flag} must be absolute on the box (or ~/...), not {value!r}")
    return value


def cmd_leg(cfg: Config, args: list[str]) -> int:
    try:
        return leg_command(cfg, args)
    except LegStopped as stopped:
        # THE STOP: die of the signal, as the slot's wrapper does, so a caller reads what it sent.
        signal.signal(stopped.signum, signal.SIG_DFL)
        os.kill(os.getpid(), stopped.signum)
        return 128 + stopped.signum


def leg_command(cfg: Config, args: list[str]) -> int:
    values: dict[str, str] = {}
    slot_flags: list[str] = []
    runner: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            runner = args[i + 1 :]
            break
        if arg in ("--request", "--box", "--rev", "--checkout", "--worktree", "--remote", "--control"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"execution leg: expected a value for {arg}")
            values[arg] = args[i + 1]
            i += 2
            continue
        if arg in slot_flags and arg in ("--wait", "--deadline"):
            die(f"execution leg: {arg} given twice")
        if arg in ("--wait", "--deadline"):
            # --wait 0 is the slot's refuse-at-once; a deadline is positive.
            if i + 1 >= len(args) or not (SECONDS if arg == "--deadline" else WHOLE).fullmatch(args[i + 1]):
                die(f"execution leg: {arg} takes a {'positive ' if arg == '--deadline' else ''}whole number of seconds")
            slot_flags += [arg, args[i + 1]]
            i += 2
            continue
        if arg in ("--cpu", "--gpu", "--wait-window") or (
            arg.startswith("--wait-window=") and WHOLE.fullmatch(arg[len("--wait-window=") :])
        ):
            slot_flags.append(arg)
            i += 1
            continue
        die(USAGE)
    if not runner:
        die(USAGE)
    for flag in ("--request", "--rev", "--checkout", "--worktree"):
        if flag not in values:
            die(f"execution leg: {flag} required ({USAGE})")
    request, rev = values["--request"], values["--rev"]
    checkout = box_path(values["--checkout"], "--checkout")
    worktree = box_path(values["--worktree"], "--worktree")
    if checkout.rstrip("/") == worktree.rstrip("/"):
        die("execution leg: --worktree must not be --checkout; a leg moves only a linked worktree")
    remote = values.get("--remote", "origin")
    if not REMOTE.fullmatch(remote) or remote.startswith("-"):
        die(f"execution leg: --remote must be a remote's name, not {remote!r}")
    if not ref_name_ok(rev) or (not OBJECT_ID.fullmatch(rev) and not revision.git_branch_ok(rev)):
        die(f"execution leg: --rev must be a full commit SHA or a branch name, not {rev!r}")
    if HEX.fullmatch(rev) and not OBJECT_ID.fullmatch(rev):
        die(f"execution leg: --rev {rev} looks like an abbreviated or uppercase SHA: give the full one (git rev-parse)")
    control = values.get("--control", "")
    if control and not (os.path.isfile(control) and os.access(control, os.R_OK)):
        die(f"execution leg: --control {control} is not a readable patch file")

    fetch_timeout = knob(cfg, "FLEET_FETCH_TIMEOUT", "300")
    if not SECONDS.fullmatch(fetch_timeout):
        die(f"FLEET_FETCH_TIMEOUT must be a positive whole number of seconds, not {fetch_timeout!r}")

    # The reservation: a dispatched record, whose execution host is the box. A leg that may wait out a
    # window registers as its waiter in this same read, by its request (THE WAITERS, ludics-lite#719):
    # the read that finds its record suspended must not leave a moment unseen before the first heartbeat.
    # It releases the heartbeat when it does not wait, or its wait is refused; after a wait it lets it
    # expire, so the moment of setup before its slot on the box (the copy, the ssh, the fetch) is
    # still counted, and the slot there, given --wait-window too, registers on its own.
    waiter = slot.waiter_of(cfg, runner, request=request) if window_bound(slot_flags) is not None else None
    done = execution.listing(cfg, waiter)
    if done.unreachable:
        cli.say(f"EXECUTION LEG UNREACHABLE {cfg.anchor}: cannot read request {request}'s record; nothing ran")
        return 4
    records = execution.records_of(done.out) if done.rc == 0 else None
    if records is None:
        cli.emit(substitution(done.out))
        return refused("the anchor's registry could not be read; nothing ran")
    record = execution.record_of(records, request)
    if record is None:
        return refused(f"unknown request_id {request}: a leg runs only inside a dispatched reservation")
    host = execution.jq_text(execution.field(record, "request", "execution_host"))
    box = values.get("--box", host)
    # The box before any wait: a leg named for another box is refused now, not after a window.
    if fleet_name(cfg, box) != host:
        slot.release_waiter(cfg, waiter)
        return refused(f"{request} is reserved on {host}, not {box}")
    if execution.jq_text(record.get("state")) == "suspended":
        waited = await_window(cfg, request, record, records, slot_flags, runner)
        if isinstance(waited, int):
            slot.release_waiter(cfg, waiter)
            return waited
        record = waited
        try:
            # Kept through the setup before the slot on the box, and released when the leg ends,
            # whatever ends it: a heartbeat left to expire would make a window opened just after a
            # short leg wait out the gap for nobody.
            return run_leg(cfg, request, record, slot_flags, runner, box, checkout, worktree, remote, rev, control,
                           fetch_timeout)
        finally:
            slot.release_waiter(cfg, waiter)
    slot.release_waiter(cfg, waiter)
    return run_leg(cfg, request, record, slot_flags, runner, box, checkout, worktree, remote, rev, control,
                   fetch_timeout)


def run_leg(cfg: Config, request: str, record: dict[str, Any], slot_flags: list[str], runner: list[str], box: str, checkout: str, worktree: str, remote: str, rev: str, control: str,
            fetch_timeout: str) -> int:
    """The leg on its dispatched record: refuse what the registry would not record, then run it on
    ``box`` (the far side's slot or hold around it) and stream its result."""
    state = execution.jq_text(record.get("state"))
    if state not in DISPATCHED:
        return refused(f"{request} is {state}, not dispatched (launching, running or uncertain); nothing ran")
    # THE RECORD'S CHECKOUT (see the header).
    bound = execution.recorded_checkout(record)
    if bound and not execution.same_checkout(bound, worktree):
        host = execution.jq_text(execution.field(record, "request", "execution_host"))
        return refused(f"--worktree {worktree} is not {request}'s recorded checkout {bound} on {host}"
                       " (ludics-lite#749: a leg moves only its own record's worktree); nothing ran")
    kind = execution.jq_text(execution.field(record, "request", "kind"))
    if kind == "measurement":
        extra = [flag for flag in slot_flags if flag.startswith("--") and flag != "--deadline"]
        if extra:
            die(f"execution leg: {request} is a measurement, run under `execution hold`, which takes no slot: drop {' '.join(extra)}")
    # The bound is each run's (the leg's --deadline, or a day), carried by the nested slot of each
    # run, which reaps that run's group as it ends; the enclosing wrapper, holding both runs, takes
    # none, so a main run cannot spend the control's time.
    deadline = slot_flags[slot_flags.index("--deadline") + 1] if "--deadline" in slot_flags else RUN_BOUND
    if "--deadline" in slot_flags:
        at = slot_flags.index("--deadline")
        slot_flags = slot_flags[:at] + slot_flags[at + 2 :]
    if kind == "measurement":
        wrap = ["execution", "hold", "--request", request, *slot_flags]
    else:
        wrap = ["execution", "slot", *slot_flags]
    nest = ["--deadline", deadline, *[flag for flag in slot_flags if flag in ("--cpu", "--gpu")]]
    # The registry's binding (ludics-lite#634): the commit it would accept as this record's
    # observed_sha, so the leg runs nothing the registry would refuse to record.
    want = bound_commit(record) or ""
    requested = execution.field(record, "request", "requested_revision")
    if isinstance(requested, str) and requested.startswith("head-of:") and not want:
        # Reconciled to running without a dispatch, say: the branch was never resolved, so no commit
        # is this request's, and any --rev would pass.
        return refused(f"{request} follows {requested} but records no resolved_revision (it was never dispatched);"
                       " reconcile it to reserved and dispatch it, which resolves the branch")

    # One random token per invocation: the status line's (see the header), and the staged patch's
    # name on the box, which no other leg's can share.
    token = secrets.token_hex(8)
    pname = ""
    if control:
        pname = f"{re.sub(r'[^A-Za-z0-9._-]', '_', request)}.{token}.patch"
        sent = put_file(cfg, box, control, f"{cfg.state}/leg-control/{pname}")
        if sent.rc != 0:
            if sent.unreachable:
                cli.say(f"EXECUTION LEG UNREACHABLE {box}: the control patch could not be copied; nothing ran")
                return 4
            return refused(f"the control patch could not be copied to {box} (exit {sent.rc}); nothing ran")

    script = prelude(cfg, box) + LEG
    argv = far_argv(
        cfg, box,
        [checkout, worktree, remote, rev, want, pname, request, fetch_timeout, token, str(len(wrap)), *wrap,
         str(len(nest)), *nest, *runner],
    )

    def stop(far_pid: str) -> tuple[list[str], str]:
        return far_argv(cfg, box, [far_pid, token, STOP_BOUND]), prelude(cfg, box) + STOP

    return stream(argv, script, box, token, local=is_local(cfg, box), stop=stop)


def end_far(box: str, far_pid: str | None, signum: int, stop: Callable[[str], tuple[list[str], str]], *,
            local: bool) -> None:
    """THE STOP (see the header): end the far side whose shell reported ``far_pid``, through a far
    stop in a session of its own, waiting up to STOP_WAIT for its report."""
    name = signal.Signals(signum).name
    if far_pid is None:
        cli.say(f"EXECUTION LEG STOPPED {box}: {name} before the far side reported its pid; whether the runner"
                f" started there is unknown -- look on {box} before running the leg again")
        return
    cli.say(f"EXECUTION LEG STOPPING {box}: {name}; ending the far side (pid {far_pid})")
    argv, script = stop(far_pid)
    sys.stdout.flush()
    sys.stderr.flush()
    remedy = f"ssh {box} pkill -TERM -P {far_pid} -f 'execution (slot|hold)'"
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, start_new_session=True)
    except OSError as exc:
        cli.say(f"EXECUTION LEG STOP UNREACHABLE {box}: {argv[0]}: {exc.strerror}; the far side (pid {far_pid})"
                f" may still run and hold its worktree's lock: {remedy}")
        return
    assert proc.stdin is not None
    try:
        proc.stdin.write(script.encode("utf-8", "surrogateescape"))
        proc.stdin.close()
    except OSError:
        pass
    try:
        rc = proc.wait(timeout=STOP_WAIT)
    except subprocess.TimeoutExpired:
        cli.say(f"EXECUTION LEG STOPPING {box}: the far stop goes on after {STOP_WAIT:g}s; its last line follows on"
                " this output")
        return
    if rc == 255 and not local:
        cli.say(f"EXECUTION LEG STOP UNREACHABLE {box}: ssh failed; the far side (pid {far_pid}) may still run and"
                f" hold its worktree's lock: {remedy}")
    elif rc != 0:
        cli.say(f"EXECUTION LEG STOPPING {box}: the far stop exit {rc} (above); if the far side still runs: {remedy}")


def stream(argv: list[str], script: str, box: str, token: str, *, local: bool,
           stop: Callable[[str], tuple[list[str], str]] | None = None) -> int:
    """Run the far side with its stdout passed through, watching for its status line under
    ``token``: the runner's status when it came (printed last, as the plain sentinel), else the far
    side's own (or UNREACHABLE for ssh's 255). With ``stop``, which builds the far stop's argv and
    script for a pid, a SIGTERM, SIGINT or SIGHUP while it streams ends the far side too, and raises
    LegStopped (THE STOP)."""
    # The status line ends the far side's output; after a runner whose output ended with no newline
    # it ends that line, whose text is kept and ended.
    reported = re.compile(rb"execution-leg " + re.escape(token.encode()) + rb": exit: ([0-9]{1,3})\r?\n?\Z")
    far = re.compile(rb"execution-leg " + re.escape(token.encode()) + rb": far: ([0-9]+)\r?\n")
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    except OSError as exc:
        sys.stderr.write(f"{argv[0]}: {exc.strerror}\n")
        return 127
    assert child.stdin is not None and child.stdout is not None
    stdin = child.stdin

    def feed() -> None:
        # From a thread of its own: bash reads a script on stdin as it runs it, so a far side that
        # writes before it has read the whole script must never wait for this write to finish.
        try:
            stdin.write(script.encode("utf-8", "surrogateescape"))
            stdin.close()
        except OSError:
            pass

    feeder = threading.Thread(target=feed, daemon=True)
    feeder.start()
    sentinel: int | None = None
    far_pid: str | None = None
    out = sys.stdout.buffer

    def line_out(line: bytes) -> None:
        nonlocal sentinel, far_pid
        if far_pid is None and (pid := far.fullmatch(line)):
            far_pid = pid.group(1).decode()
            return
        found = reported.search(line)
        if found:
            sentinel = int(found.group(1))
            if found.start() > 0:
                out.write(line[: found.start()] + b"\n")
        else:
            out.write(line)

    def stopped(signum: int, frame: FrameType | None) -> None:
        raise LegStopped(signum)

    previous: dict[signal.Signals, Any] = {}
    try:
        if stop is not None and threading.current_thread() is threading.main_thread():
            for sig in STOP_SIGNALS:
                previous[sig] = signal.signal(sig, stopped)
        # Bounded reads, not readline: a runner's output with no newline in it (progress bars,
        # binary) passes through as it comes, and only a short tail of an unfinished line is held
        # back, enough for a sentinel at its end to be seen.
        pending = b""
        fd = child.stdout.fileno()
        while chunk := os.read(fd, 65536):
            pending += chunk
            *lines, pending = pending.split(b"\n")
            for line in lines:
                line_out(line + b"\n")
            if len(pending) > HELD_BACK:
                out.write(pending[:-HELD_BACK])
                pending = pending[-HELD_BACK:]
            out.flush()
        if pending:
            line_out(pending)
            out.flush()
        rc = child.wait()
    except LegStopped as why:
        # A second signal ends this process at once; the far stop runs in a session of its own.
        for sig in previous:
            signal.signal(sig, signal.SIG_DFL)
        try:
            out.flush()
        except OSError:
            pass
        assert stop is not None
        end_far(box, far_pid, why.signum, stop, local=local)
        child.stdout.close()
        raise
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    feeder.join()
    if sentinel is not None:
        out.write(b"execution-leg: exit: %d\n" % sentinel)
        out.flush()
        return sentinel
    if rc == 255 and not local:
        cli.say(
            f"EXECUTION LEG UNREACHABLE {box}: ssh failed or the connection dropped before the leg reported;"
            " the runner may have started there -- check the box before running the leg again"
        )
        return 4
    return rc
