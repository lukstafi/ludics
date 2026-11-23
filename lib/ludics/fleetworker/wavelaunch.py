"""``wave launch``: start a prepared CLI worker (the second half of what each wave's ``next.sh`` did).

    wave launch <wave.json> <task> [--status <file>] [--launch-id <id>]

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
purpose for a prepared task, or a base the branch has moved past, means un-preparing it (``wave
unprep``, waveunprep.py) and preparing it again under its own id.

THE TASK LOCK (waveprep.py): the verb holds the task's ``prep/<task>.lock`` throughout, so no
``wave prep`` or ``wave unprep`` of the task runs meanwhile; a held lock refuses, nothing launched.

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
6. The row: ``worktree`` (the path launch made, read from its structured result), ``state=launched``,
   ``standing`` and ``exec_hosts`` naming what was reserved, and ``farside`` naming the worker's
   own host/worktree plus each reserved leg. The worker path is read from the JSON result; its host
   is the prepared host passed to launch.
   A placement with whitespace, or a host with a colon, cannot fit one cleanup word: it is omitted
   with a NOTE (exit 3, reconcile by hand), never split into a different cleanup target.
7. The manifest records the launch.

THE RECOVERY BOUNDARY. JSON strings preserve paths including whitespace and Unicode separators.
Only the caller-named JSON result file is read for the worker path;
stdout (including legacy LAUNCHED lines) is never a fallback. The result must name the prepared
host and worker and an absolute worktree. Missing or malformed results return UNKNOWN before
publishing cleanup targets. The result proves startup, not worker readiness.
A launch refused before it started anything (exit 1 from step 4: a gate, a
red base, a preflight) left nothing, and a re-run is the retry. ``LAUNCH UNKNOWN`` (exit 4) may have
started the worker: read ``status`` and ``execution list`` before anything else, as launch's line
says. Past step 4 the worker runs, so nothing after it stops the verb: a leg that could not be
reserved and a row that could not be set are each a ``WAVE LAUNCH NOTE`` line, and the exit is 3,
launched with something to reconcile. A driver's lost lease (exit 6) ends further anchor writes,
but a worker already started still gets its local manifest record. The manifest's record is what refuses a second launch; a
launch that ran and whose record was not written (a crash between steps 4 and 7) is refused by
step 3, on the worktree it left, or by ``launch`` itself, on the worker's record on its box.

THE STATUS (ludics#1290). ``--status <file>`` writes one JSON object atomically on every non-usage
exit (never on usage exit 2): ``{"exit", "wave", "task", "host", "launch_id", "outcome"}``, where
``launch_id`` is the caller-supplied ``--launch-id <id>`` (validated against ``boardstore.LAUNCH_ID``,
shared with ``board spawned``; ``""`` when omitted) and ``outcome`` is one of ``workers.LAUNCH_OUTCOMES``.
Step 4 passes its own fresh ``--status`` file to ``launch`` and propagates ``launch``'s outcome only
when that file passes ``workers.read_launch_status`` (matching exit, host and worker); any missing,
malformed or mismatched child status fails closed to ``uncertain``, never inferred from stdout/stderr
prose. Steps 1-3 write ``pre-start``; steps 5-7 (after worker startup) always write ``started``,
including on a post-start lease loss (exit 6). A write failure prints a ``WAVE LAUNCH STATUS NOTE``
on stderr and leaves the exit status unchanged.

Exit: 0 launched; 1 refused; 2 usage; 3 launched, with a NOTE to reconcile; 4 unknown; 6 lease lost (under ``--lease-status``).
"""

import json
import os
import re
import shlex
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.boardstore import LAUNCH_ID, placement_word
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import LEASE_LOST_STATUS
from ludics.fleetworker.transport import prelude, run, run_on, substitution
from ludics.fleetworker.wave import USAGE, Wave, load_wave
from ludics.fleetworker.wavebrief import write_atomically
from ludics.fleetworker.waveprep import READY, Rivalry, Stop, check_rivals, task_lock
from ludics.fleetworker.workers import LAUNCH_OUTCOMES, read_launch_status, read_status_file, write_status_file

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


def write_wave_launch_status(path: str, rc: int, wave_name: str, task: str, host: str, launch_id: str, outcome: str) -> None:
    """THE STATUS (the header): replaced whole; a write failure is a NOTE and never changes the exit."""
    write_status_file(
        path,
        {"exit": rc, "wave": wave_name, "task": task, "host": host, "launch_id": launch_id, "outcome": outcome},
        f"WAVE LAUNCH STATUS NOTE {task}",
    )


def read_wave_launch_status(path: str, rc: int, wave_name: str, task: str, host: str, launch_id: str) -> dict[str, Any] | None:
    """Read ``wave launch --status`` fail-closed: exact schema, matching exit/wave/task/host/launch_id, known outcome."""
    return read_status_file(
        path,
        {"exit": rc, "wave": wave_name, "task": task, "host": host, "launch_id": launch_id},
        LAUNCH_OUTCOMES,
    )


def launched(cfg: Config, path: str, task: str, *, status_file: str = "", launch_id: str = "") -> int:
    wave = load_wave(path, "launch")
    manifest_path = os.path.join(wave.directory, "prep", f"{task}.json")
    lock_path = os.path.join(wave.directory, "prep", f"{task}.lock")
    if status_file and os.path.realpath(status_file) in {
        os.path.realpath(path), os.path.realpath(manifest_path), os.path.realpath(lock_path),
    }:
        die("wave launch: --status names a file of its own, never the wave file, prep manifest or task lock")
    status_host = [""]

    def finish(rc: int, outcome: str, host: str = "") -> int:
        if status_file:
            write_wave_launch_status(status_file, rc, wave.wave, task, host or status_host[0], launch_id, outcome)
        return rc

    try:
        with task_lock(wave.directory, task, "WAVE LAUNCH"):
            return launched_locked(cfg, wave, path, task, finish, status_host)
    except Stop as stop:
        cli.say(stop.line)
        return finish(stop.rc, "pre-start")


def launched_locked(
    cfg: Config,
    wave: Wave,
    path: str,
    task: str,
    finish: Callable[[int, str, str], int],
    status_host: list[str],
) -> int:
    manifest_path = os.path.join(wave.directory, "prep", f"{task}.json")
    manifest, record, done = read_manifest(manifest_path, task)
    status_host[0] = record.host
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
    command = cfg.shim_command()
    payload = os.path.join(wave.directory, "reserve", f"{task}.json")
    brief = os.path.join(wave.directory, "briefs", f"brief-{task}.md")
    with tempfile.TemporaryDirectory(prefix="ludics-launch-") as result_dir:
        result_path = os.path.join(result_dir, "result.json")
        launch_status_path = os.path.join(result_dir, "status.json")
        started = run([*command, "launch", record.host, record.worker, "--target-repo", record.repository, "--kind", record.kind,
                       "--brief", brief, "--repo", record.host_checkout, "--branch", record.branch, "--base", record.base,
                       "--base-branch", record.main, "--standing", payload, "--result-file", result_path,
                       "--status", launch_status_path, "--", *cli_args(record)], capture=True)
        cli.emit(substitution(started.out))
        if started.rc != 0:
            if started.rc == 2:
                return 2
            child = read_launch_status(launch_status_path, started.rc, record.host, record.worker)
            outcome = str(child["outcome"]) if child is not None else "uncertain"
            return finish(started.rc, outcome, record.host)
        try:
            with open(result_path, encoding="utf-8") as source:
                result = json.load(source)
            if not isinstance(result, dict):
                raise ValueError("result is not an object")
            result = cast(dict[str, Any], result)
            if (result.get("host") != record.host
                    or result.get("worker") != record.worker or not isinstance(result.get("session"), str)):
                raise ValueError("result identity differs from prepared launch")
            worktree = result.get("worktree")
            if not isinstance(worktree, str) or not worktree.startswith("/") or "\0" in worktree:
                raise ValueError("result worktree is not an absolute path")
        except (OSError, ValueError):
            cli.say(f"WAVE LAUNCH UNKNOWN {task}: missing or invalid structured launch result; read status"
                    f" {record.host} {record.worker} and reconcile before retrying")
            return finish(4, "uncertain", record.host)
    notes: list[str] = []
    reserved: list[Leg] = []
    lost_lease = False
    for leg in record.legs:
        rc = run([*command, "execution", "run", os.path.join(wave.directory, "reserve", f"{task}-{leg.suffix}.json")],
                 stdout_to_stderr=True).rc
        if rc == 0:
            reserved.append(leg)
        else:
            notes.append(f"the standing leg on {leg.box} is not reserved (execution run exit {rc})")
            if rc == LEASE_LOST_STATUS:
                lost_lease = True
                break
    far_words: list[str] = []
    for box, checkout in [(record.host, worktree), *((leg.box, leg.worktree) for leg in reserved)]:
        try:
            far_words.append(placement_word(box, checkout))
        except ValueError as exc:
            notes.append(f"cannot record farside placement {shlex.quote(box + ':' + checkout)} ({exc}); reconcile by hand")
    far = " ".join(dict.fromkeys(far_words))
    standing = " ".join([record.standing, *(leg.standing for leg in reserved)])
    if lost_lease:
        notes.append("the lease was lost after startup; reconcile the remaining legs and the board row")
    else:
        rc = run([*command, "board", "set", record.wave, task, f"worktree={worktree}", "state=launched", f"standing={standing}",
                  f"exec_hosts={','.join([record.host, *(leg.box for leg in reserved)])}", f"farside={far or 'none'}"],
                 stdout_to_stderr=True).rc
        if rc != 0:
            notes.append(f"the row is not set (board set exit {rc}): worktree={worktree} state=launched standing={standing}")
        lost_lease = rc == LEASE_LOST_STATUS
    try:
        write_atomically(manifest_path, json.dumps({**manifest, "worktree": worktree, "done": [*done, f"launched {record.host}/{record.worker}"]},
                                                   indent=1) + "\n")
    except OSError as exc:
        notes.append(f"the manifest does not record the launch ({exc.strerror})")
    for note in notes:
        cli.say(f"WAVE LAUNCH NOTE {task}: {note}")
    cli.say(f"WAVE LAUNCH {task}: launched {record.host}/{record.worker} worktree {worktree} standing {standing}")
    rc = LEASE_LOST_STATUS if lost_lease else (3 if notes else 0)
    return finish(rc, "started", record.host)


def cmd_launch(cfg: Config, args: list[str]) -> int:
    positional: list[str] = []
    status_file = launch_id = ""
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--status", "--launch-id"):
            if i + 1 >= len(args) or not args[i + 1] or args[i + 1].startswith("-"):
                die(f"wave launch: expected a value for {arg}; usage: {USAGE}")
            value = args[i + 1]
            if arg == "--status":
                if status_file:
                    die(f"wave launch: --status may be given at most once; usage: {USAGE}")
                status_file = value
            else:
                if launch_id:
                    die(f"wave launch: --launch-id may be given at most once; usage: {USAGE}")
                if not LAUNCH_ID.fullmatch(value):
                    die(f"wave launch: --launch-id must be {LAUNCH_ID.pattern}; usage: {USAGE}")
                launch_id = value
            i += 2
        elif arg.startswith("--"):
            die(f"wave launch: unknown option {arg}; usage: {USAGE}")
        else:
            positional.append(arg)
            i += 1
    if len(positional) != 2:
        die(f"wave launch: name the wave file and the task; usage: {USAGE}")
    return launched(cfg, positional[0], positional[1], status_file=status_file, launch_id=launch_id)
