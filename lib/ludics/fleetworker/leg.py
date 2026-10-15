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
--request <id>`` (``--deadline`` alone). When the record carries a ``resolved_revision`` (a
``head-of:<branch>`` request resolved at assignment), ``--rev`` must come to exactly that commit.

THE CHECKOUT AND THE REVISION, on the box (paths absolute, or ``~/``): ``--checkout`` is a git
checkout of the project there, ``--worktree`` a LINKED worktree of it (never the main one), made
with ``git worktree add --detach`` when the path does not exist and checked out ``--detach`` at
the commit when it does -- refused when it is another repository's, or has uncommitted changes,
which a leg never overwrites; and refused when it is not clean once at the commit, submodules
included (a submodule the checkout moved past is refused, never updated). A runner that is no
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

WHAT THE STATUS MEANS. The runner's, when the sentinel line was printed. Without it, nothing ran to
an end: an ``EXECUTION LEG REFUSED`` line says why (1; 2 usage; the slot's own refusal status when
the slot never started the runner), or ``EXECUTION LEG UNREACHABLE`` (4) that the box never answered
or the connection dropped, with the runner perhaps started -- find out on the box before a retry.
"""

import os
import re
import secrets
import subprocess
import sys
import threading

from ludics import cli
from ludics.fleetworker import execution, revision
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.preflight import knob
from ludics.fleetworker.registry import ref_name_ok
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

# The far side, after the prelude. Args: checkout, worktree, remote, rev, want (the assigned commit or
# empty), patch name (in $STATE/leg-control, or empty), request id, the fetch's bound in seconds
# (FLEET_FETCH_TIMEOUT), the status token (see the header), the wrapper's word count and
# words (fleet-worker.sh's own verb and flags, ending before its `--`), each run's nested-slot
# flags' count and words, then the runner's argv.
LEG = r"""co=$(expand_tilde "$1") wt=$(expand_tilde "$2") remote="$3" rev="$4" want="$5" pname="$6" request="$7" fetch_timeout="$8" token="$9" nwrap="${10}"
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
cdir=$(common "$co"); [ -n "$cdir" ] || refuse "--checkout $co is not a git checkout on $BOX"
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
wkey=$(canon "$wt") || refuse "cannot resolve --worktree $wt on $BOX"
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
  bounded "$fetch_timeout" env GIT_TERMINAL_PROMPT=0 git -C "$co" fetch -q --no-tags "$remote" "+$src:$ref" >&2; frc=$?
  [ "$frc" -ne 124 ] || refuse "git fetch $remote $rev in $co did not finish in ${fetch_timeout}s (FLEET_FETCH_TIMEOUT)"
  [ "$frc" -eq 0 ] || refuse "git fetch $remote $rev in $co failed (above): no such branch or commit on $remote, or $remote is unreachable from $BOX"
  sha=$(git -C "$co" rev-parse --verify -q "$ref^{commit}") || refuse "$rev fetched from $remote is not a commit"
  [ "$sha_like" = 0 ] || [ "$sha" = "$rev" ] || refuse "fetching $rev from $remote gave $sha"
  how="fetched from $remote"
fi
[ -z "$want" ] || [ "$sha" = "$want" ] ||
  refuse "$rev is $sha, but request $request was assigned $want (resolved at assignment): run --rev $want"
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
  git -C "$co" worktree add -q --detach "$wt" "$sha" </dev/null >&2 || refuse "git worktree add --detach $wt $sha in $co failed (above)"
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
"${wrap[@]}" -- bash "$results.sh" "$wt" "$patch" "$results" "$BOX" "$fw" "$head" "${#nest[@]}" "${nest[@]}" "$@" </dev/null; wrc=$?
fact() { sed -n "s/^$1=//p" "$results" | head -n1; }
main=$(fact main)
now=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)
[ "$now" = "$head" ] || say "WARNING: HEAD of $wt is ${now:-unreadable} after the run, not $head (the runner moved it)"
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


def refused(text: str, rc: int = 1) -> int:
    cli.say(f"EXECUTION LEG REFUSED: {text}")
    return rc


def box_path(value: str, flag: str) -> str:
    """A path on the box: absolute, or ``~/`` (expanded there)."""
    if not (value.startswith("/") or value.startswith("~/")):
        die(f"execution leg: {flag} must be absolute on the box (or ~/...), not {value!r}")
    return value


def cmd_leg(cfg: Config, args: list[str]) -> int:
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

    # The reservation: a dispatched record, whose execution host is the box.
    done = execution.listing(cfg)
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
    state = execution.jq_text(record.get("state"))
    if state == "suspended":
        return refused(
            f"{request} is suspended by measurement window {execution.jq_text(record.get('suspended_by'))};"
            " run the leg once that window concludes"
        )
    if state not in DISPATCHED:
        return refused(f"{request} is {state}, not dispatched (launching, running or uncertain); nothing ran")
    host = execution.jq_text(execution.field(record, "request", "execution_host"))
    box = values.get("--box", host)
    if fleet_name(cfg, box) != host:
        return refused(f"{request} is reserved on {host}, not {box}")
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
    resolved = record.get("resolved_revision")
    want = resolved if isinstance(resolved, str) and OBJECT_ID.fullmatch(resolved) else ""
    requested = execution.field(record, "request", "requested_revision")
    if isinstance(requested, str) and requested.startswith("head-of:") and not want:
        # Reconciled to running without a dispatch, say: the branch was never resolved, so no commit
        # is this request's, and any --rev would pass.
        return refused(f"{request} follows {requested} but records no resolved_revision (it was never dispatched);"
                       " reconcile it to reserved and dispatch it, which resolves the branch")

    pname = ""
    if control:
        pname = f"{re.sub(r'[^A-Za-z0-9._-]', '_', request)}.{os.getpid()}.patch"
        sent = put_file(cfg, box, control, f"{cfg.state}/leg-control/{pname}")
        if sent.rc != 0:
            if sent.unreachable:
                cli.say(f"EXECUTION LEG UNREACHABLE {box}: the control patch could not be copied; nothing ran")
                return 4
            return refused(f"the control patch could not be copied to {box} (exit {sent.rc}); nothing ran")

    script = prelude(cfg, box) + LEG
    token = secrets.token_hex(8)
    fetch_timeout = knob(cfg, "FLEET_FETCH_TIMEOUT", "300")
    if not SECONDS.fullmatch(fetch_timeout):
        die(f"FLEET_FETCH_TIMEOUT must be a positive whole number of seconds, not {fetch_timeout!r}")
    argv = far_argv(
        cfg, box,
        [checkout, worktree, remote, rev, want, pname, request, fetch_timeout, token, str(len(wrap)), *wrap,
         str(len(nest)), *nest, *runner],
    )
    return stream(argv, script, box, token, local=is_local(cfg, box))


def stream(argv: list[str], script: str, box: str, token: str, *, local: bool) -> int:
    """Run the far side with its stdout passed through, watching for its status line under
    ``token``: the runner's status when it came (printed last, as the plain sentinel), else the far
    side's own (or UNREACHABLE for ssh's 255)."""
    # The status line ends the far side's output; after a runner whose output ended with no newline
    # it ends that line, whose text is kept and ended.
    reported = re.compile(rb"execution-leg " + re.escape(token.encode()) + rb": exit: ([0-9]{1,3})\r?\n?\Z")
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
    out = sys.stdout.buffer

    def line_out(line: bytes) -> None:
        nonlocal sentinel
        found = reported.search(line)
        if found:
            sentinel = int(found.group(1))
            if found.start() > 0:
                out.write(line[: found.start()] + b"\n")
        else:
            out.write(line)

    # Bounded reads, not readline: a runner's output with no newline in it (progress bars, binary)
    # passes through as it comes, and only a short tail of an unfinished line is held back, enough
    # for a sentinel at its end to be seen.
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
