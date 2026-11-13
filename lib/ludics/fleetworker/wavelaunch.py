"""``wave launch``: start a prepared CLI worker (the second half of what each wave's ``next.sh`` did).

    wave launch <wave.json> <task>

``wave prep`` prepares a CLI task and makes nothing on its box (waveprep.py's A CLI TASK): the
worktree and the standing reservation are ``fleet-worker.sh launch --standing``'s to make, in one
fenced step. This verb is that step and what the coordinator typed around it: the scratch directory
on the box, the launch, the standing reservations on the task's GPU home boxes, and the row.

WHAT IT DOES, in this order:

1. The task's prep manifest (``<wave dir>/prep/<task>.json``), which names prep's own options: the
   task is rebuilt from them as prep built it. No manifest, a task that is no CLI worker's (a
   native worker is spawned by its coordinator's runtime), or a manifest that records a launch
   refuses. So does a wave file that changed under the prep: the rebuilt worker, branch, worktree,
   scratch, transport, kind or host differing from what the manifest recorded, since the brief,
   the payloads and the row carry the recorded ones. The wave file's ``vars.MAIN`` is the base
   branch ``launch`` reads CI for.
2. The rival PRs, read again as prep read them (a queued task can wait hours for its launch).
3. The worktree path on the worker's host (``WORKTREE_STATE``): nothing there, or a clean worktree
   whose HEAD is prep's base (an earlier launch that made it and started nothing: the retry). Any
   other thing at the path refuses: ``launch`` reuses a worktree on the right branch whatever its
   HEAD or edits, and the brief and the reservation speak of prep's base. Then the scratch
   ``runs/`` directory there.
4. ``fleet-worker.sh launch <host> <worker> --target-repo <repository> --kind <kind> --brief <brief>
   --repo <the host's clone> --branch <branch> --base <prep's base SHA> --base-branch <MAIN>
   --standing <reserve/<task>.json> -- <the profile's model and effort>``. Its own gates are the
   launch's: the lease and the halt, the box's preflight, the base gate. Its output is printed
   whole; a status other than 0 is this verb's, and nothing below runs.
5. Each leg's standing reservation (``execution run`` of the payload prep wrote), on the far-side
   worktree a leg will make.
6. The row: ``worktree`` (the path launch made, read off its ``LAUNCHED`` line), ``state=launched``,
   and ``standing``, ``exec_hosts`` and ``farside`` naming only what was reserved.
7. The manifest records the launch.

THE RECOVERY BOUNDARY. A launch refused before it started anything (exit 1 from step 4: a gate, a
red base, a preflight) left nothing, and a re-run is the retry. ``LAUNCH UNKNOWN`` (exit 4) may have
started the worker: read ``status`` and ``execution list`` before anything else, as launch's line
says. Past step 4 the worker runs, so nothing after it stops the verb: a leg that could not be
reserved and a row that could not be set are each a ``WAVE LAUNCH NOTE`` line, and the exit is 3,
launched with something to reconcile. The manifest's record is what refuses a second launch; a
launch that ran and whose record was not written (a crash between steps 4 and 7) is refused by
``launch`` itself, on the worker's record on its box.

Exit: 0 launched; 1 refused; 2 usage; 3 launched, with a NOTE to reconcile; 4 unknown.
"""

import json
import os
import re
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import prelude, run, run_on, substitution
from ludics.fleetworker.wave import USAGE, load_wave, shim
from ludics.fleetworker.wavebrief import write_atomically
from ludics.fleetworker.waveprep import Prep, Stop, build, check_rivals

# Far side of step 3's read, after the prelude. Arg: the worktree path. Prints `worktree=absent`, or
# `worktree=<HEAD or unreadable> dirty=<count of git status --porcelain entries, or unreadable>`.
WORKTREE_STATE = r"""wt="$1"
if [ ! -e "$wt" ] && [ ! -L "$wt" ]; then printf 'worktree=absent\n'; exit 0; fi
head=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null) || head=unreadable
if left=$(git --no-optional-locks -C "$wt" status --porcelain 2>/dev/null); then dirty=$(printf '%s' "$left" | grep -c '')
else dirty=unreadable; fi
printf 'worktree=%s dirty=%s\n' "$head" "$dirty"
"""
STATE = re.compile(r"worktree=(\S+) dirty=(\S+)")
LAUNCHED = re.compile(r"LAUNCHED \S+ .*?\bcwd=(/.*?) stream=")  # farside.py's line; a path may hold blanks
MKDIR = 'mkdir -p -- "$1"\n'


def cli_args(prep: Prep) -> list[str]:
    """The profile's model and effort as its CLI takes them (``launch`` keeps them for every resume)."""
    if prep.kind == "codex":
        return [*(["-m", prep.model] if prep.model else []), *(["-c", f"model_reasoning_effort={prep.effort}"] if prep.effort else [])]
    return [*(["--model", prep.model] if prep.model else []), *(["--effort", prep.effort] if prep.effort else [])]


def read_manifest(path: str, task: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except FileNotFoundError:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: no prep manifest {path}: wave prep the task first") from None
    except (OSError, ValueError) as exc:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: the prep manifest {path} cannot be read ({exc})") from None
    opts: Any = cast(dict[str, Any], data).get("opts") if isinstance(data, dict) else None
    if not isinstance(opts, dict) or not isinstance(cast(dict[str, Any], data).get("done"), list):
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: {path} is no manifest wave prep wrote for a launch (no opts)")
    return cast(dict[str, Any], data)


def rebuilt(cfg: Config, path: str, task: str, manifest: dict[str, Any]) -> Prep:
    """The task as prep built it, from the options its manifest records."""
    opts = cast(dict[str, Any], manifest["opts"])
    given: dict[str, Any] = {key: str(opts.get(key, "")) for key in ("base", "issue", "source", "legs", "profile", "host")}
    given["mode"] = str(opts.get("mode") or "none")
    rivals: Any = opts.get("allow_rival")
    given["allow_rival"] = {str(pr) for pr in cast(list[Any], rivals)} if isinstance(rivals, list) else set[str]()
    prep = build(cfg, path, task, given)
    prep.verb = "WAVE LAUNCH"
    return prep


def launched(cfg: Config, path: str, task: str) -> int:
    wave = load_wave(path, "launch")
    manifest_path = os.path.join(wave.directory, "prep", f"{task}.json")
    manifest = read_manifest(manifest_path, task)
    prep = rebuilt(cfg, path, task, manifest)
    if not prep.cli:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: a {prep.transport} worker is spawned by its coordinator's runtime;"
                      " wave launch starts CLI workers")
    done = [str(step) for step in cast(list[Any], manifest["done"])]
    if any(step.startswith("launched ") for step in done):
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: {manifest_path} records a launch already")
    if "MAIN" not in wave.vars:
        die(f"wave launch: {path} names no vars.MAIN, the base branch launch reads CI for")
    recorded = {key: str(manifest.get(key, "")) for key in ("worker", "branch", "worktree", "scratch", "transport", "kind", "host")}
    rebuilt_now = {"worker": prep.worker, "branch": prep.branch, "worktree": prep.worktree, "scratch": prep.scratch,
                   "transport": prep.transport, "kind": prep.kind, "host": prep.host}
    changed = [f"{key} was {recorded[key]}, is now {value}" for key, value in rebuilt_now.items() if recorded[key] != value]
    if changed:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: the wave file changed since the task was prepared ({'; '.join(changed)});"
                      " its brief, payloads and row carry the prepared values: prepare it again under a new task id, or restore the wave file")
    check_rivals(cfg, prep)
    seen = run_on(cfg, prep.host, prelude(cfg, prep.host) + WORKTREE_STATE, [prep.worktree], capture=True)
    said_state = substitution(seen.out).splitlines()[-1] if seen.out.strip() else ""
    state = STATE.fullmatch(said_state)
    if seen.unreachable or seen.rc != 0 or not (said_state == "worktree=absent" or state):
        raise Stop(4, f"WAVE LAUNCH UNKNOWN {task}: the worktree path {prep.worktree} on {prep.host} could not be read"
                      f" (exit {seen.rc}); nothing launched")
    if state and (state.group(1) != prep.base or state.group(2) != "0"):
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: {prep.worktree} exists on {prep.host} at {state.group(1)} with"
                      f" {state.group(2)} uncommitted path(s), not a clean worktree at prep's base {prep.base}; launch would"
                      " reuse it as it is. Remove it there, or prepare the task again; nothing launched")
    runs = os.path.join(prep.scratch, "runs")
    if prep.remote:
        made = run_on(cfg, prep.host, prelude(cfg, prep.host) + MKDIR, [runs], capture=True)
        if made.unreachable or made.rc != 0:
            raise Stop(4 if made.unreachable else 1, f"WAVE LAUNCH {'UNKNOWN' if made.unreachable else 'REFUSED'} {task}:"
                       f" cannot make {runs} on {prep.host} (exit {made.rc}); nothing launched")
    script = shim(cfg)
    payload = os.path.join(wave.directory, "reserve", f"{task}.json")
    brief = os.path.join(wave.directory, "briefs", f"brief-{task}.md")
    started = run([script, "launch", prep.host, prep.worker, "--target-repo", wave.repository, "--kind", prep.kind,
                   "--brief", brief, "--repo", prep.host_checkout, "--branch", prep.branch, "--base", prep.base,
                   "--base-branch", wave.vars["MAIN"], "--standing", payload, "--", *cli_args(prep)], capture=True)
    said = substitution(started.out)
    cli.emit(said)
    if started.rc != 0:
        return started.rc
    found = [m for m in (LAUNCHED.match(line) for line in said.splitlines()) if m]
    if not found:
        cli.say(f"WAVE LAUNCH UNKNOWN {task}: launch exited 0 and printed no LAUNCHED line with its cwd; read status"
                f" {prep.host} {prep.worker} before anything else")
        return 4
    worktree = found[-1].group(1)
    notes: list[str] = []
    reserved = [prep.host]
    for leg in prep.legs:
        rc = run([script, "execution", "run", os.path.join(wave.directory, "reserve", f"{task}-{leg.suffix}.json")],
                 stdout_to_stderr=True).rc
        if rc == 0:
            reserved.append(leg.box)
        else:
            notes.append(f"the standing leg on {leg.box} is not reserved (execution run exit {rc})")
    far = " ".join(f"{leg.box}:{prep.leg_worktree(leg)}" for leg in prep.legs if leg.box in reserved)
    standing = " ".join(prep.standing_id(box) for box in reserved)
    rc = run([script, "board", "set", wave.wave, task, f"worktree={worktree}", "state=launched", f"standing={standing}",
              f"exec_hosts={','.join(reserved)}", f"farside={far or 'none'}"], stdout_to_stderr=True).rc
    if rc != 0:
        notes.append(f"the row is not set (board set exit {rc}): worktree={worktree} state=launched standing={standing}")
    try:
        write_atomically(manifest_path, json.dumps({**manifest, "worktree": worktree, "done": [*done, f"launched {prep.host}/{prep.worker}"]},
                                                   indent=1) + "\n")
    except OSError as exc:
        notes.append(f"the manifest does not record the launch ({exc.strerror})")
    for note in notes:
        cli.say(f"WAVE LAUNCH NOTE {task}: {note}")
    cli.say(f"WAVE LAUNCH {task}: launched {prep.host}/{prep.worker} worktree {worktree} standing {standing}")
    return 3 if notes else 0


def cmd_launch(cfg: Config, args: list[str]) -> int:
    if len(args) != 2 or args[0].startswith("--") or args[1].startswith("--"):
        die(f"wave launch: name the wave file and the task; usage: {USAGE}")
    try:
        return launched(cfg, args[0], args[1])
    except Stop as stop:
        cli.say(stop.line)
        return stop.rc
