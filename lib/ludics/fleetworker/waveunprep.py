"""``wave unprep``: take a prepared, never-launched CLI task back to unprepared (ludics#1130).

    wave unprep <wave.json> <task>

``wave prep`` is not resumable and refuses a task that has a manifest, a row or any of its files,
and ``wave launch`` refuses a prepared task whose base is no longer the branch's tip. So a CLI task
prepared and not launched before the branch moved could only be prepared again under a new id,
its old files and ``pending`` row cleared by hand. This verb clears them, so ``wave prep`` under
the task's own id passes its freshness reads again. Its rule: it goes ahead only where such a
re-prep can succeed, and its refusals mirror prep's reads.

THE MANIFEST IS THE AUTHORITY. Every target is named by ``<wave dir>/prep/<task>.json`` (its task,
its ``standing`` ids and its ``launch`` record: worker, branch, host, worktree, scratch, legs), never
by the wave file, which may have been edited since. The wave file is read for where the wave
directory is and that it names the manifest's wave. Its ``done`` steps are matched by the prefixes
prep writes, a fail-closed allowlist: nothing is parsed out of a step's text.

WHAT IT REFUSES, with nothing removed and nothing written (exit 1):
  - a native task (a manifest whose record is no ``cli`` transport's). A native prep takes the
    worktree, the branch and standing reservations, whose ids the registry never forgets or runs
    twice, and a native worker is spawned outside ``wave launch``, so nothing proves none started:
    reconcile it by hand from prep's ``WAVE PREP MADE`` lines and prepare again under a new task id;
  - a manifest that records a launch (a ``launched`` step), a ``done`` step that is not one of a
    CLI prep's (``manifest``, ``scratch``, ``standing payload``, ``brief``, ``board row``, ``ready``,
    and this verb's own ``unprepare``), a manifest that does not read as prep's, or another wave's;
  - the driver's ledger (``logs/drive.jsonl``) whose last launch line for the task holds a slot
    (wavedrive.py's A SLOT HELD: a launch that may have started a worker);
  - any registry record of the task's standing ids, in any state (a launch that reserved);
  - a board row that is not this prep's: its ``state`` not ``pending``, or its ``worker`` or
    ``branch`` not the manifest's;
  - the branch on origin (a worker pushed);
  - anything at the worktree path on the task's host (prep makes none for a CLI task: a launch
    began);
  - a path prep would write (a payload, a leg's payload, the assign base, the brief) that holds
    something other than a regular file.
A read that does not answer (the anchor, the registry, the board, origin, the host) is exit 4,
nothing removed. No manifest at all is ``nothing recorded to undo``, exit 0: a finished run's re-run.

WHAT IT REMOVES, in this order, each skipped when it is absent already:
  1. the fence: ``unprepare`` appended to the manifest's ``done``, so ``wave launch`` refuses the
     task from here on (its last step is no longer prep's ``ready``);
  2. the row, by the board store's internal ``forget`` (boardstore.py): a compare-and-delete under
     the lease lock, while the row is the manifest's worker's ``pending`` row;
  3. the scratch ``runs/`` directory and the scratch directory, local tasks only, by ``rmdir``: a
     non-empty one is left, said in a ``WAVE UNPREP NOTE`` line (prep accepts it as it is);
  4. prep's files: the payloads, the legs' payloads, the assign base and the brief. Each is at a
     name built from the task id, and prep refused every one of them existing before it wrote its
     manifest, so a file there is this prep's, its write recorded or not (a crash between the two);
  5. one ``board log`` line, the board's record of the removal (a failure is a NOTE);
  6. last, the manifest is renamed ``prep/<task>.unprepared-<UTC stamp>.json``, the record of
     what was prepared; prep no longer sees a manifest.
Then ``WAVE UNPREP <task>: unprepared: ...``, exit 0.

THE RECOVERY BOUNDARY. A refusal or an unknown in the reads writes nothing, not even the fence. A
failure past the fence prints ``WAVE UNPREP FAILED <task> at <step>: <why>`` (``UNKNOWN``, exit 4,
when the anchor did not answer the row's removal), one ``WAVE UNPREP REMOVED <task>: <what>`` line
per removal made, and exits 1 (4). A re-run reads again, finds the fence (accepted as its own) and
the removed pieces absent, and goes on; a row removal whose acknowledgement was lost is no row on
the re-run. A run stopped between the log line and the rename logs again on its re-run: a log line
is never edited or removed (boardstore.py). What a re-run refuses rather than guesses is the list
above: the fence never makes a refused read pass.

THE TASK LOCK (waveprep.py): this verb holds ``prep/<task>.lock`` throughout, as ``wave prep`` and
``wave launch`` do, so none of them runs on the task meanwhile; a held lock refuses, nothing done.
The driver (wavedrive.py) calls this verb for a stale prepared task it finds, and takes no task
lock itself.

Exit: 0 unprepared or nothing recorded; 1 refused or failed; 2 usage; 4 unknown.
"""

import json
import os
import shlex
from datetime import datetime, timezone
from typing import Any, cast

from ludics import cli, proc
from ludics.fleetworker.board import forget_row
from ludics.fleetworker.boardstore import NO_BOARD_EXIT
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import listing, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import anchor_gate
from ludics.fleetworker.takeover import board_status, row_of
from ludics.fleetworker.transport import prelude, run, run_on, substitution
from ludics.fleetworker.wave import USAGE, Wave, load_wave, shim
from ludics.fleetworker.wavebrief import write_atomically
from ludics.fleetworker.wavelaunch import STATE, WORKTREE_STATE, Record, record_of
from ludics.fleetworker.waveprep import READY, TASK, Stop, task_lock

FENCE = "unprepare"  # this verb's own step: a manifest that ends with it is no prep's ready one
EXACT = ("manifest", READY, FENCE)  # the CLI prep steps (waveprep.write) a step may be, whole
PREFIXES = ("scratch ", "standing payload ", "brief ", "board row ")  # ...or by its first words
LAUNCH_TURN = -1  # wavedrive.LAUNCH, the ledger's turn for a queued task's launch


def quoted(text: str) -> str:
    return shlex.quote(text)


def read(path: str, wave: Wave, task: str) -> tuple[dict[str, Any], Record, list[str]] | None:
    """The manifest, its record and its steps (WHAT IT REFUSES), or None when there is none."""
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: the prep manifest {quoted(path)} cannot be read ({exc}); nothing removed") from None
    manifest = cast(dict[str, Any], data) if isinstance(data, dict) else {}
    record = record_of(manifest.get("launch"))
    steps: Any = manifest.get("done")
    standing: Any = manifest.get("standing")
    if (record is None or manifest.get("task") != task or not isinstance(steps, list)
            or not all(isinstance(step, str) for step in cast(list[Any], steps)) or not isinstance(standing, list)):
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: {quoted(path)} is no manifest wave prep wrote for {task}; nothing removed")
    done = cast(list[str], steps)
    if record.transport != "cli":
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: a {record.transport} task: its prep took a worktree, a branch and standing"
                      " reservations the registry never forgets, and its worker is spawned outside wave launch, so nothing"
                      " proves none started; reconcile it by hand from its WAVE PREP MADE lines and prepare it again under a"
                      " new task id; nothing removed")
    if record.wave != wave.wave or manifest.get("wave") != wave.wave:
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: {quoted(path)} was prepared for wave {record.wave}, and the wave file"
                      f" names {wave.wave}; nothing removed")
    if any(step.startswith("launched ") for step in done):
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: {quoted(path)} records a launch; its worker is the coordinator's to"
                      " close; nothing removed")
    unknown = [step for step in done if step not in EXACT and not step.startswith(PREFIXES)]
    if unknown:
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: {quoted(path)} records a step no CLI prep writes ({unknown[0][:200]!r});"
                      " nothing removed")
    if [str(s) for s in cast(list[Any], standing)] != [record.standing, *(leg.standing for leg in record.legs)]:
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: {quoted(path)}'s standing ids are not its launch record's; nothing removed")
    return manifest, record, done


def files_of(wave: Wave, task: str, record: Record) -> list[str]:
    """Prep's files for the task (waveprep.artifacts), named from the manifest's legs."""
    names = [f"{task}.json", *(f"{task}-{leg.suffix}.json" for leg in record.legs), f"{task}-base.json"]
    return [*(os.path.join(wave.directory, "reserve", name) for name in names), os.path.join(wave.directory, "briefs", f"brief-{task}.md")]


def check_ledger(wave: Wave, task: str) -> None:
    last: dict[str, Any] | None = None
    try:
        with open(os.path.join(wave.directory, "logs", "drive.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    entry: Any = json.loads(line)
                except ValueError:
                    continue  # a torn last line, as the driver reads it
                if isinstance(entry, dict) and cast(dict[str, Any], entry).get("task") == task \
                        and cast(dict[str, Any], entry).get("turn") == LAUNCH_TURN:
                    last = cast(dict[str, Any], entry)
    except FileNotFoundError:
        return
    except OSError as exc:
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: the driver's ledger cannot be read ({exc.strerror}); nothing removed") from None
    if last is not None and last.get("holds"):
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: the driver's last launch line for the task ({last.get('status')}) holds a"
                      f" slot on {last.get('holds')}: a launch that may have started a worker; read its status there; nothing removed")


def check_registry(cfg: Config, task: str, standing: list[str]) -> None:
    listed = listing(cfg)
    records = records_of(listed.out) if listed.rc == 0 else None
    if records is None:
        raise Stop(4, f"WAVE UNPREP UNKNOWN {task}: the anchor's registry could not be read; nothing removed")
    wanted = {s.lower() for s in standing}
    for r in records:
        if str(r.get("request_id")).lower() in wanted:
            raise Stop(1, f"WAVE UNPREP REFUSED {task}: the registry holds {r.get('request_id')} ({r.get('state')}): a launch"
                          " reserved it, and the registry never runs an id twice; prepare the task again under a new task id;"
                          " nothing removed")


def check_row(cfg: Config, wave: Wave, task: str, record: Record) -> None:
    doc = board_status(cfg, wave.wave)
    if doc == 4:
        raise Stop(4, f"WAVE UNPREP UNKNOWN {task}: the board of {wave.wave} could not be read; nothing removed")
    if isinstance(doc, int):
        if doc == NO_BOARD_EXIT:
            return
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: the board of {wave.wave} could not be read (above); nothing removed")
    row = row_of(doc, task)
    fields: Any = row.get("fields") if row is not None else None
    if row is None:
        return
    got = cast(dict[str, Any], fields) if isinstance(fields, dict) else {}
    if (got.get("state"), got.get("worker"), got.get("branch")) != ("pending", record.worker, record.branch):
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: the board's row for {task} is state={got.get('state')!r}"
                      f" worker={got.get('worker')!r} branch={got.get('branch')!r}, not this prep's pending row of"
                      f" {record.worker} on {record.branch}; nothing removed")


def check_origin(wave: Wave, task: str, record: Record) -> None:
    remote = proc.run_tool("git", ["-C", wave.checkout, "ls-remote", "--heads", "origin", f"refs/heads/{record.branch}"], timeout=60)
    if remote.rc != 0:
        raise Stop(4, f"WAVE UNPREP UNKNOWN {task}: origin's branches could not be read ({remote.stderr.strip()[-200:]}); nothing removed")
    if remote.stdout.strip():
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: branch {record.branch} exists on origin (a worker pushed); nothing removed")


def check_worktree(cfg: Config, task: str, record: Record) -> None:
    seen = run_on(cfg, record.host, prelude(cfg, record.host) + WORKTREE_STATE, [record.worktree], capture=True)
    said = substitution(seen.out).splitlines()[-1] if seen.out.strip() else ""
    if seen.unreachable or seen.rc != 0 or not (said == "worktree=absent" or STATE.fullmatch(said)):
        raise Stop(4, f"WAVE UNPREP UNKNOWN {task}: the worktree path {quoted(record.worktree)} on {record.host} could not be"
                      f" read (exit {seen.rc}); nothing removed")
    if said != "worktree=absent":
        raise Stop(1, f"WAVE UNPREP REFUSED {task}: {quoted(record.worktree)} exists on {record.host} ({said}): prep makes no"
                      " worktree for a CLI task, so a launch began; read status there; nothing removed")


def check_files(task: str, paths: list[str]) -> None:
    for path in paths:
        if os.path.lexists(path) and (os.path.islink(path) or not os.path.isfile(path)):
            raise Stop(1, f"WAVE UNPREP REFUSED {task}: {quoted(path)} is no regular file, and prep writes one there; nothing removed")


def unprepared(cfg: Config, wave: Wave, task: str) -> int:
    gated = anchor_gate(cfg, "WAVE UNPREP", task, False)
    if gated != 0:
        return gated
    path = os.path.join(wave.directory, "prep", f"{task}.json")
    read_back = read(path, wave, task)
    if read_back is None:
        cli.say(f"WAVE UNPREP {task}: nothing recorded to undo (no prep manifest {quoted(path)})")
        return 0
    manifest, record, done = read_back
    files = files_of(wave, task, record)
    check_ledger(wave, task)
    check_registry(cfg, task, [record.standing, *(leg.standing for leg in record.legs)])
    check_row(cfg, wave, task, record)
    check_origin(wave, task, record)
    check_worktree(cfg, task, record)
    check_files(task, files)
    removed: list[str] = []
    notes: list[str] = []

    def failed(step: str, why: str, rc: int = 1) -> int:
        cli.say(f"WAVE UNPREP {'UNKNOWN' if rc == 4 else 'FAILED'} {task} at {step}: {why}")
        for what in removed:
            cli.say(f"WAVE UNPREP REMOVED {task}: {what}")
        cli.say(f"WAVE UNPREP {task}: a re-run goes on from here (the manifest {quoted(path)} ends with {FENCE!r})"
                if done[-1:] == [FENCE] else f"WAVE UNPREP {task}: nothing removed")
        return rc

    if done[-1:] != [FENCE]:
        try:
            write_atomically(path, json.dumps({**manifest, "done": [*done, FENCE]}, indent=1) + "\n")
        except OSError as exc:
            return failed("fence", f"cannot write {quoted(path)} ({exc.strerror})")
        done = [*done, FENCE]
    rc = forget_row(cfg, wave.wave, task, record.worker)
    if rc != 0:
        return failed("row", f"the row's removal exited {rc} (above)", 4 if rc == 4 else 1)
    removed.append(f"the board row {wave.wave} {task}, if it was there")
    if not record.remote:
        for directory in (os.path.join(record.scratch, "runs"), record.scratch):
            try:
                os.rmdir(directory)
                removed.append(f"the empty directory {quoted(directory)}")
            except FileNotFoundError:
                pass
            except OSError as exc:
                notes.append(f"{quoted(directory)} is left ({exc.strerror}); prep takes it as it is")
                break
    for item in files:
        try:
            os.remove(item)
            removed.append(quoted(item))
        except FileNotFoundError:
            pass
        except OSError as exc:
            return failed("files", f"cannot remove {quoted(item)} ({exc.strerror})")
    logged = run([shim(cfg), "board", "log", wave.wave, f"{task} unprepared: its prep at {record.base[:12]} taken back"
                  " (wave unprep), to be prepared again under its own id"], stdout_to_stderr=True).rc
    if logged != 0:
        notes.append(f"the board log line was not written (board log exit {logged})")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    tomb = os.path.join(wave.directory, "prep", f"{task}.unprepared-{stamp}.json")
    try:
        os.replace(path, tomb)
    except OSError as exc:
        return failed("manifest", f"cannot rename {quoted(path)} to {quoted(tomb)} ({exc.strerror})")
    for note in notes:
        cli.say(f"WAVE UNPREP NOTE {task}: {note}")
    cli.say(f"WAVE UNPREP {task}: unprepared: {len(removed)} piece(s) removed, the manifest kept as {quoted(tomb)};"
            " wave prep it again under its own id")
    return 0


def cmd_unprep(cfg: Config, args: list[str]) -> int:
    if len(args) != 2 or args[0].startswith("--") or args[1].startswith("--"):
        die(f"wave unprep: name the wave file and the task; usage: {USAGE}")
    if not TASK.fullmatch(args[1]):
        die(f"wave unprep: task {args[1]!r} does not match {TASK.pattern}")
    wave = load_wave(args[0], "unprep")
    try:
        with task_lock(wave.directory, args[1], "WAVE UNPREP"):
            return unprepared(cfg, wave, args[1])
    except Stop as stop:
        cli.say(stop.line)
        return stop.rc
