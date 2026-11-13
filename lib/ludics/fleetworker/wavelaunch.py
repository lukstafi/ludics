"""``wave launch``: start a prepared CLI worker (the second half of what each wave's ``next.sh`` did).

    wave launch <wave.json> <task>

``wave prep`` prepares a CLI task and makes nothing on its box (waveprep.py's A CLI TASK): the
worktree and the standing reservation are ``fleet-worker.sh launch --standing``'s to make, in one
fenced step. This verb is that step and what the coordinator typed around it: the scratch directory
on the box, the launch, the standing reservations on the task's GPU home boxes, and the row.

THE MANIFEST IS THE TASK. Everything this verb does comes from the ``launch`` record prep wrote in
``<wave dir>/prep/<task>.json``: the wave's name and repository, the base branch, the worker's
kind, model, effort, host and the host's clone, its name, branch, base, worktree and scratch, its
issue and allowed rivals, its standing id, and each leg's box, far-side worktree and standing id.
The wave file is read for two things only: where the wave directory is, and that it still names
the wave the manifest was prepared for. Nothing else of it is read again, so a profile, a host or
a leg edited after the prep cannot make this verb launch one thing and reserve or record another:
it launches what the brief, the payloads and the row were written for. A wave file changed on
purpose for a prepared task means preparing it again under a new task id.

WHAT IT DOES, in this order:

1. The manifest. None, one with no ``launch`` record (a prep older than this verb), one whose
   record is no CLI worker's (a native worker is spawned by its coordinator's runtime), one whose
   last step is not prep's ``ready`` (a prep that failed part-way left a brief with no assign base
   or no row), one that records a launch already, one prepared for another wave than the wave file
   names, or one with no base branch (prep found no ``vars.MAIN``) refuses.
2. The rival PRs, read again as prep read them (a queued task can wait hours for its launch).
3. The worktree path on the worker's host (``WORKTREE_STATE``): nothing there, or a clean worktree
   whose HEAD is prep's base (an earlier launch that made it and started nothing: the retry). Any
   other thing at the path refuses: ``launch`` reuses a worktree on the right branch whatever its
   HEAD or edits, and the brief and the reservation speak of prep's base. Then the scratch
   ``runs/`` directory there.
4. ``fleet-worker.sh launch <host> <worker> --target-repo <repository> --kind <kind> --brief <brief>
   --repo <the host's clone> --branch <branch> --base <prep's base SHA> --base-branch <MAIN>
   --standing <reserve/<task>.json> -- <the model and effort>``. Its own gates are the launch's:
   the lease and the halt, the box's preflight, the base gate. Its output is printed whole; a
   status other than 0 is this verb's, and nothing below runs.
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
step 3, on the worktree it left, or by ``launch`` itself, on the worker's record on its box.

Exit: 0 launched; 1 refused; 2 usage; 3 launched, with a NOTE to reconcile; 4 unknown.
"""

import json
import os
import re
from dataclasses import dataclass
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import prelude, run, run_on, substitution
from ludics.fleetworker.wave import USAGE, load_wave, shim
from ludics.fleetworker.wavebrief import write_atomically
from ludics.fleetworker.waveprep import READY, Rivalry, Stop, check_rivals

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
TEXTS = ("wave", "repository", "main", "transport", "kind", "model", "effort", "host", "host_checkout", "scratch", "worker",
         "branch", "base", "worktree", "number", "issue_ref", "standing")
LEG_TEXTS = ("box", "suffix", "worktree", "standing")


@dataclass(frozen=True)
class Leg:
    box: str
    suffix: str
    worktree: str
    standing: str


@dataclass(frozen=True)
class Record:
    """THE MANIFEST IS THE TASK (the header): prep's ``launch`` record, read fail-closed."""
    wave: str
    repository: str
    main: str
    transport: str
    kind: str
    model: str
    effort: str
    host: str
    host_checkout: str
    scratch: str
    worker: str
    branch: str
    base: str
    worktree: str
    number: str
    issue_ref: str
    standing: str
    remote: bool
    allow_rival: frozenset[str]
    legs: tuple[Leg, ...]


def record_of(raw: Any) -> Record | None:
    """The record, or None when it is not the shape prep writes: every text a string, ``remote`` a
    boolean, ``allow_rival`` a list of strings, each leg its four texts, and no other key."""
    if not isinstance(raw, dict):
        return None
    data = cast(dict[str, Any], raw)
    legs: Any = data.get("legs")
    rivals: Any = data.get("allow_rival")
    if set(data) != {*TEXTS, "remote", "allow_rival", "legs"} or not all(isinstance(data[key], str) for key in TEXTS):
        return None
    if not isinstance(data["remote"], bool) or not isinstance(legs, list) or not isinstance(rivals, list):
        return None
    if not all(isinstance(pr, str) for pr in cast(list[Any], rivals)):
        return None
    made: list[Leg] = []
    for entry in cast(list[Any], legs):
        if not isinstance(entry, dict) or set(cast(dict[str, Any], entry)) != set(LEG_TEXTS):
            return None
        leg = cast(dict[str, Any], entry)
        if not all(isinstance(leg[key], str) and leg[key] for key in LEG_TEXTS):
            return None
        made.append(Leg(*(leg[key] for key in LEG_TEXTS)))
    texts = {key: cast(str, data[key]) for key in TEXTS}
    return Record(**texts, remote=data["remote"], allow_rival=frozenset(cast(list[str], rivals)), legs=tuple(made))


def cli_args(record: Record) -> list[str]:
    """The model and effort as the worker's CLI takes them (``launch`` keeps them for every resume)."""
    if record.kind == "codex":
        return [*(["-m", record.model] if record.model else []),
                *(["-c", f"model_reasoning_effort={record.effort}"] if record.effort else [])]
    return [*(["--model", record.model] if record.model else []), *(["--effort", record.effort] if record.effort else [])]


def read_manifest(path: str, task: str) -> tuple[dict[str, Any], Record, list[str]]:
    """Step 1's read: the manifest, its launch record and its steps, or Stop."""
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except FileNotFoundError:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: no prep manifest {path}: wave prep the task first") from None
    except (OSError, ValueError) as exc:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: the prep manifest {path} cannot be read ({exc})") from None
    manifest = cast(dict[str, Any], data) if isinstance(data, dict) else {}
    steps: Any = manifest.get("done")
    record = record_of(manifest.get("launch"))
    if record is None or not isinstance(steps, list):
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: {path} holds no launch record wave prep wrote; prepare the task again")
    return manifest, record, [str(step) for step in cast(list[Any], steps)]


def launched(cfg: Config, path: str, task: str) -> int:
    wave = load_wave(path, "launch")
    manifest_path = os.path.join(wave.directory, "prep", f"{task}.json")
    manifest, record, done = read_manifest(manifest_path, task)
    if record.transport != "cli":
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: a {record.transport} worker is spawned by its coordinator's runtime;"
                      " wave launch starts CLI workers")
    if any(step.startswith("launched ") for step in done):
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: {manifest_path} records a launch already")
    if not done or done[-1] != READY:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: its prep did not finish ({manifest_path} ends at"
                      f" {done[-1] if done else 'nothing'!r}, not {READY!r}): reconcile what that prep made, and prepare the task again")
    if record.wave != wave.wave:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: {manifest_path} was prepared for wave {record.wave}, and {path} names"
                      f" {wave.wave}; its reservations and row are {record.wave}'s")
    if not record.main:
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: its prep recorded no base branch (the wave file had no vars.MAIN then),"
                      " which launch reads CI for; add it and prepare the task again")
    check_rivals(cfg, Rivalry(task, "WAVE LAUNCH", record.repository, record.branch, record.number, record.issue_ref, record.allow_rival))
    seen = run_on(cfg, record.host, prelude(cfg, record.host) + WORKTREE_STATE, [record.worktree], capture=True)
    said_state = substitution(seen.out).splitlines()[-1] if seen.out.strip() else ""
    state = STATE.fullmatch(said_state)
    if seen.unreachable or seen.rc != 0 or not (said_state == "worktree=absent" or state):
        raise Stop(4, f"WAVE LAUNCH UNKNOWN {task}: the worktree path {record.worktree} on {record.host} could not be read"
                      f" (exit {seen.rc}); nothing launched")
    if state and (state.group(1) != record.base or state.group(2) != "0"):
        raise Stop(1, f"WAVE LAUNCH REFUSED {task}: {record.worktree} exists on {record.host} at {state.group(1)} with"
                      f" {state.group(2)} uncommitted path(s), not a clean worktree at prep's base {record.base}; launch would"
                      " reuse it as it is. Remove it there, or prepare the task again; nothing launched")
    runs = os.path.join(record.scratch, "runs")
    if record.remote:
        made = run_on(cfg, record.host, prelude(cfg, record.host) + MKDIR, [runs], capture=True)
        if made.unreachable or made.rc != 0:
            raise Stop(4 if made.unreachable else 1, f"WAVE LAUNCH {'UNKNOWN' if made.unreachable else 'REFUSED'} {task}:"
                       f" cannot make {runs} on {record.host} (exit {made.rc}); nothing launched")
    script = shim(cfg)
    payload = os.path.join(wave.directory, "reserve", f"{task}.json")
    brief = os.path.join(wave.directory, "briefs", f"brief-{task}.md")
    started = run([script, "launch", record.host, record.worker, "--target-repo", record.repository, "--kind", record.kind,
                   "--brief", brief, "--repo", record.host_checkout, "--branch", record.branch, "--base", record.base,
                   "--base-branch", record.main, "--standing", payload, "--", *cli_args(record)], capture=True)
    said = substitution(started.out)
    cli.emit(said)
    if started.rc != 0:
        return started.rc
    found = [m for m in (LAUNCHED.match(line) for line in said.splitlines()) if m]
    if not found:
        cli.say(f"WAVE LAUNCH UNKNOWN {task}: launch exited 0 and printed no LAUNCHED line with its cwd; read status"
                f" {record.host} {record.worker} before anything else")
        return 4
    worktree = found[-1].group(1)
    notes: list[str] = []
    reserved: list[Leg] = []
    for leg in record.legs:
        rc = run([script, "execution", "run", os.path.join(wave.directory, "reserve", f"{task}-{leg.suffix}.json")],
                 stdout_to_stderr=True).rc
        if rc == 0:
            reserved.append(leg)
        else:
            notes.append(f"the standing leg on {leg.box} is not reserved (execution run exit {rc})")
    far = " ".join(f"{leg.box}:{leg.worktree}" for leg in reserved)
    standing = " ".join([record.standing, *(leg.standing for leg in reserved)])
    rc = run([script, "board", "set", record.wave, task, f"worktree={worktree}", "state=launched", f"standing={standing}",
              f"exec_hosts={','.join([record.host, *(leg.box for leg in reserved)])}", f"farside={far or 'none'}"],
             stdout_to_stderr=True).rc
    if rc != 0:
        notes.append(f"the row is not set (board set exit {rc}): worktree={worktree} state=launched standing={standing}")
    try:
        write_atomically(manifest_path, json.dumps({**manifest, "worktree": worktree, "done": [*done, f"launched {record.host}/{record.worker}"]},
                                                   indent=1) + "\n")
    except OSError as exc:
        notes.append(f"the manifest does not record the launch ({exc.strerror})")
    for note in notes:
        cli.say(f"WAVE LAUNCH NOTE {task}: {note}")
    cli.say(f"WAVE LAUNCH {task}: launched {record.host}/{record.worker} worktree {worktree} standing {standing}")
    return 3 if notes else 0


def cmd_launch(cfg: Config, args: list[str]) -> int:
    if len(args) != 2 or args[0].startswith("--") or args[1].startswith("--"):
        die(f"wave launch: name the wave file and the task; usage: {USAGE}")
    try:
        return launched(cfg, args[0], args[1])
    except Stop as stop:
        cli.say(stop.line)
        return stop.rc
