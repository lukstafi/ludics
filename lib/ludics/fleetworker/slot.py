"""``execution slot`` and ``execution hold``: the run-time correctness slots of THIS box, and its
OS-level sleep guard (fleet-worker.sh's ``cmd_execution_slot``, ``cmd_execution_hold`` and the
Python program they ran, ``run_py``, whose four modes -- slot, nested, measured, bare, hold -- are
the functions below, in one process).

The design notes, moved verbatim from fleet-worker.sh, are the comment blocks below this
docstring (THE SLOTS, THE GPU TOKENS, THE NESTED SLOT, THE GUARD; then ``execution hold``'s THE
MEASUREMENT'S OWN RUN and THE DRAIN); issue-wave/references/executions.md is the user's side. In
brief:

- THE SLOTS (ludics-lite#160): one flock file per slot under the box's own state directory, held on
  an open descriptor that survives the exec of the wrapped command, so the kernel releases it
  however the batch dies. There is no ``--box``: a slot on another machine is a lock on the wrong
  disk.
- THE GPU TOKENS (ludics-lite#391): where a box has T tokens, fewer than its slots, the first T
  slot files are the tokens. Fail-closed: a batch is a GPU batch unless it declares ``--cpu``, and
  a ``--cpu`` batch takes the highest free slot, reaching the tokens last.
- THE NESTED SLOT (ahrefs/ocannl#1004) and THE MEASUREMENT'S OWN RUN (ludics-lite#480): an
  enclosing slot's ``FLEET_SLOT_HELD`` marker, or an enclosing ``hold --request``'s
  ``FLEET_MEASUREMENT_HELD``, is JUDGED, never trusted -- it must name this box and a lock held
  NOW -- and a batch it covers runs under the enclosing hold, taking nothing. The two judgements
  are one shape, ``Judged``: Inside, Take (the marker does not cover the batch: say why, take a slot
  of its own), or Refused.
- THE DRAIN (ludics-lite#481): a ``hold --request`` takes every slot of the box before its command
  starts, so no batch runs beside a measurement.
- THE HOLDER RECORD (ludics-lite#668): whoever takes a slot writes into its lock file who it is
  (pid, command, start, ``--deadline``), and a drain waiting on a slot reports that record on
  stderr, as recorded, at once and then every ``FLEET_HOLD_DRAIN_REPEAT`` seconds, so the
  coordinator can decide without first finding what the drain waits for.
- THE WINDOW WAIT (ludics-lite#557): ``slot --wait-window[=<seconds>]`` turns the refusal beside an
  outstanding measurement on this box (a window or not) into a bounded wait for it to conclude, then
  queues for a slot under ``--wait`` as usual: two waits, each with its own bound and refusal line.
  It is a separate flag, so a caller that relies on the immediate refusal (a runner's nested slot)
  is never parked for a whole window, and it does not wait inside a measurement's hold, where it
  would wait for its own measurement.
- THE WAITERS (ludics-lite#719): a batch waiting out a measurement reads the registry with
  ``wait``, which records on the anchor that it waits for this box (registry.py's THE WAITERS), so a
  new window keeps its gap only while someone waits; and a batch waiting here, for a window or for a
  free slot, keeps a ``waiting.<pid>`` record in the slot directory, flocked for as long as it
  waits, which ``--holders`` lists (``WaitingRecord``).
- THE GUARD (ludics-lite#317): a logind ``block`` inhibitor on sleep:idle, held by a HELPER beside
  the command (systemd-inhibit closes the descriptors of the process it runs, SIGTERMs it, and
  rewrites its exit status, so it must never wrap the batch), alive for as long as anything in the
  command's tree holds the lifetime pipe. Fail-open, and loudly.
- THE GROUP (ludics-lite#566, ``group.py``): the command leads a process group of its own, this
  process its parent, and ``--deadline``, a signal to this process, or a SIGKILL of it (through a
  guardian) ends the whole group; a deadline exits 124. A nested batch is exec'd in its enclosing
  group instead (``run_command``), so the enclosing wrapper's group kill reaches its tree.
- THE CO-TENANTS (ludics-lite#566, ``cotenants.py``): a ``hold --request`` records the box's
  GPU-using processes outside its own tree when its command starts and once it has ended, into
  ``<slot dir>/<box>/measurement.<id>.gpu.jsonl``, which the measurement's conclusion cites. A hold
  nested in a hold of the same measurement records its own pair too.

A wrapper must not change a batch's verdict: the command's status is this process's, a command
killed by a signal kills this process with the same one, and the signal dispositions Python
changed (SIGPIPE, SIGXFSZ ignored) are put back for the command.
"""


# ===============================================================================================
# From fleet-worker.sh, above the shell's `run_py`:
#
# `execution slot [--wait <seconds>] -- <command...>`: the RUN-TIME half of the correctness cap
# (ludics-lite#160). The registry reservation is ownership and evidence, held for a worker's whole
# life including its review waits, so counting it against the box's slots capped agents in flight
# rather than concurrent load -- on 2026-09-16 a fourth worker was refused a standing reservation
# while the three holding the slots were reading their briefs and nothing was running at all. So a
# standing record consumes no slot (`"standing": true` in the reservation), and the slots are taken
# HERE instead, by the worker itself, around one suite or batch.
#
# The lock is a real flock, N holders: one file per slot under the box's own state directory, and
# the holder is the open descriptor, inherited across the exec of the wrapped command. That is why
# there is no stale-lock reclaim to get wrong -- the kernel drops the lock when the process dies,
# however it dies, including a kill -9 of a whole batch. The repository's own mkdir `take_lock`
# could not serve: it is defined in the far-side prelude, for scripts shipped to a box, and this
# lock has to outlive the acquiring process's exec on THIS box. There is no --box for the same
# reason: a slot on another machine would be a lock on the wrong disk.
#
# THE GPU TOKENS (ludics-lite#391). On rog-nv-linux the bound is the GPU's 12 GiB, not the box:
# three concurrent cuda batches ran out of device memory, while two ran clean beside two cc
# batches. So where FLEET_BOX_GPU_TOKENS gives a box T tokens, fewer than its slots, the first T
# slot files are its GPU tokens: a GPU batch may take only slot.1..slot.T, and a batch declared
# `--cpu` takes the highest free slot, reaching the GPU ones last. Two properties follow, and both
# are why this is not a second lock pool beside the slots:
#   - fail-closed: a batch is a GPU batch unless it declares `--cpu` (`--gpu` says the default),
#     so one whose caller forgot to declare it is still held to T, and a CPU batch that forgot
#     only waits longer;
#   - safe across the switch: the script before #391 gave rog-nv-linux two slots and took the
#     first free one, so a batch it started holds slot.1 or slot.2 -- which this version counts as
#     a token. A separate token pool would have seen two free tokens beside two such batches and
#     let four cuda batches onto the GPU while the box's checkout moved from one version to the
#     other.
# The cost is fragmentation: a CPU batch that fell back into a GPU slot keeps it until it ends,
# even after a higher slot frees. A GPU batch waiting on a token holds no slot meanwhile. Where a
# box has as many tokens as slots nothing binds, and every batch takes the first free slot as
# before, so every box but the one the token spec narrows is unchanged.
#
# THE NESTED SLOT (ahrefs/ocannl#1004). A project runner may take the slot itself (OCANNL's
# tools/test-run.sh does, declaring --cpu from the backend it resolves), so no brief has to name
# the wrapper and no worker can forget it -- but a worker that still wraps the runner would then
# hold two slots for one batch, and four such workers on a four-slot box would each hold one and
# wait for another until the deadline refused them all. So a held slot exports FLEET_SLOT_HELD
# (`<box> <slot> <slots> <gpu|cpu>`, the last saying whether that slot may hold the GPU) to the
# command, and an `execution slot` that finds it runs its command under the enclosing slot rather
# than taking a second one: no flock, no registry read (the enclosing take made it), no second
# sleep guard. The marker is judged, never trusted: it must name this box and a slot this spec
# has, and that slot must be held NOW (a non-blocking flock on it must fail), so a marker exported
# by hand, or outliving its batch, is said so and ignored and a slot is taken as usual. Whether
# the slot may hold the GPU is judged from the current token spec, not from the marker's own word,
# and a GPU batch inside a slot an enclosing batch took as --cpu is refused: the enclosing
# declaration was wrong, and running would put a GPU batch past the tokens.
#
# The measurement check is a point-in-time gate read from the anchor's registry, exactly as
# `execution dispatch` is: it refuses to start a batch beside an outstanding measurement, and
# a measurement reserved afterwards is the registry's exclusivity to enforce, not this lock's.
# The one batch it admits there is the measurement's own, run inside that measurement's
# `execution hold --request` (THE MEASUREMENT'S OWN RUN, at `execution hold`).
#
# EVERY correctness run on the box goes through this lock, an assigned one (a full suite, a
# cross-box leg) exactly as much as a standing worker's batch: it is the single run-time
# mechanism, and the registry's reservation cap stays a bound on how many non-standing
# assignments may be QUEUED there. Subtracting outstanding assignments from the cap here would
# re-introduce the very thing #160 removes - a run refused because of a record that is not
# running, its own included.
#
# Inside the slot the command runs under the OS-level sleep guard `execution hold` takes
# (ludics-lite#317, below), so a correctness batch on a native Linux box carries the guard a
# measurement does, for exactly as long as the batch runs. One Python program serves both
# subcommands; `slot` is `hold` plus the flock.
# Exit: the wrapped command's own status; 124 when --deadline ended its process group
# (ludics-lite#566); 1 with a line beginning `EXECUTION SLOT REFUSED` (no
# free slot or GPU token before the deadline, an outstanding measurement -- with --wait-window, one
# still outstanding at its bound -- a malformed spec); 4 when the
# anchor's registry could not be read; 127 when the command itself could not be run. The command
# is run and not interpreted, so a pipeline or a builtin goes as `sh -c '...'`.
#
# THE GUARD (ludics-lite#317). Under WSL the Windows-side holder kept a lane's box alive; on
# native Ubuntu nothing at the OS level stopped another session's `wake-lab.sh sleep`, or an idle
# suspend, from taking a box out from under a running worker, because the lab locks are advisory
# and bind only sessions that go through wake-lab.sh. A logind BLOCK inhibitor on sleep:idle is
# the OS-side answer: systemd 259's `systemctl --check-inhibitors=yes suspend` (wake-lab.sh's
# path) refuses on any `block` inhibitor covering sleep, the caller's own uid included -- only
# `block-weak` exempts the same user, which is why the mode here is `block` -- and logind itself
# refuses a suspend request from anyone without `suspend-ignore-inhibit`, a GDM greeter's
# included.
#
# The inhibitor is held by a HELPER beside the command, never by a wrapper around it, and that
# shape is forced by what systemd-inhibit does to the process it runs (measured on rog-nv-linux,
# systemd 259): it closes every descriptor above 2 in its child, so a batch run UNDER it would
# no longer inherit the slot's flock; it SIGTERMs that child when it dies itself; and it turns a
# command killed by a signal into exit 1 and adds a "<cmd> failed with exit status <n>." line --
# a wrapper that changes verdicts, and a PID that is not the workload's, so killing `$!` would
# kill systemd-inhibit and not the batch (PR #323 review, round 1). So the helper is
# `systemd-inhibit ... -- sh -c 'echo HELD; exec cat'`, reading a LIFETIME PIPE whose write end
# the command inherits, and the command is run exactly as before (since ludics-lite#566 as this
# process's child, in a group of its own, inheriting the flock and the pipe alike):
# the inhibitor then lives as long as anything in the command's process tree holds that pipe --
# the same lifetime as the flock, ended by the kernel however the tree ends, including a kill -9
# of the command alone. The helper is double-forked so it is never the command's child: a
# workload that waits for all of its children would otherwise wait on it forever. It reports
# through a readiness pipe -- HELD once the inhibitor is taken, or systemd-inhibit's own refusal
# and EOF -- and the command starts only after that answer, so there is no window in which the
# run has started and the box is not yet held.
#
# Fail-open, and loudly. An unprivileged ssh session is a REMOTE subject to polkit, so
# `org.freedesktop.login1.inhibit-block-sleep` falls under its `allow_any`, which stock Ubuntu
# sets to auth_admin_keep: until the box's one-time polkit grant is installed (executions.md,
# "The OS-level sleep guard") the request is denied. A run refused for that would stop every
# batch on the box over a setup step, so a denial prints a WARNING naming it and runs the command
# bare -- exactly as it runs on macOS, or on a Linux host with no systemd-inhibit at all.
# No `--no-ask-password`: systemd-inhibit gained it in v257, so 255 (Ubuntu 24.04) and 256 reject
# it as an unknown option, which would turn every hold there into the unguarded path (PR #323
# review, round 1). It is not needed either: the helper's stdio are pipes, so systemd-inhibit has
# no terminal to start a polkit agent on, and a denial comes back at once.
#
# ===============================================================================================
# From fleet-worker.sh, above the shell's `cmd_execution_hold`:
#
# `execution hold [--why <text>] [--request <id>] -- <command...>`: run the command under THIS
# box's OS-level guard against sleep and nothing else -- no slot, no registry read, no lease
# (ludics-lite#317; the guard itself is described under THE GUARD above). It is the wrapper for an
# exclusive measurement, which runs the runner without a slot of its own because `execution slot`
# refuses every batch beside an outstanding measurement, and `slot` takes the same guard inside
# the flock, so both kinds of run carry it through one implementation. Where no systemd-inhibit
# resolves it runs the command bare and says nothing. Needs python3, as `slot` does (the per-box
# preflight checks it).
#
# THE MEASUREMENT'S OWN RUN (ludics-lite#480). A runner that takes the slot itself (OCANNL's
# tools/test-run.sh) asked for one inside its own measurement's hold and was refused by that very
# measurement (exit 75, SLOT REFUSED), five times in one wave, and the workaround was folklore
# every brief had to carry (`OCANNL_TOOL_FLEET_WORKER=none`). So `--request <id>` names the
# measurement this hold runs: the command gets FLEET_MEASUREMENT_HELD=`<box> <id>` and inherits a
# SHARED flock on `<slot dir>/measurement.lock`, and an `execution slot` that finds the marker
# runs its command under this hold, with no slot taken, instead of refusing it -- as the nested
# slot runs under an enclosing one. The marker is judged, never trusted, and what confirms it is
# exactly this, nothing else: it names this box, the registry's outstanding measurements on this
# box are that one request id and no other (so an unknown, concluded or correctness request, or
# another box's, is not confirmed), and the lock is held NOW by some `hold --request` on this box.
# That last check is per box, not per request: the registry admits one measurement on a box at a
# time, so a live hold there is that measurement's. An unconfirmed marker is said so and ignored,
# and the batch is refused while any measurement is outstanding -- as is a batch with no marker,
# an independent correctness batch on the measured box among them. The hold itself reads no
# registry, so it never refuses a measurement over the anchor; a mistyped id is caught by the
# first `slot` inside it, which is refused.
#
# THE DRAIN (ludics-lite#481): with --request the hold also takes every slot of the box before the
# command starts, waiting for a batch that holds one, and the command's tree inherits them, so no
# batch runs beside a measurement: not one running when it was reserved (a measurement window
# reserves one on a box whose workers are iterating), nor one that was waiting for a slot then.
# The slot check reads the registry once, at the batch's start, and cannot see either. A nested
# hold of the same live measurement takes none, since its enclosing hold holds them.
#
# THE HOLDER RECORD (ludics-lite#668). A worker's cold tuned search, capped at 100 minutes, ran as a
# correctness batch under its standing reservation; a window's drain waited for it with every other
# slot of the box idle, and said only `waits for the batch in slot <n> to end` -- the coordinator
# had to find the batch before it could decide to stop it or the hold. So every take of a slot, a
# batch's or a drain's, writes into the slot's own lock file a one-line JSON record of who holds it
# (`record_holder`), and the drain, when the slot it waits on is held, still says that line,
# unchanged, and then names the holder (`holder_line`) whenever it may hold the slot long. The
# record is written by the holder AFTER its flock, so the content of a held file is its holder's,
# except across an upgrade: a batch started by a fleet-worker older than #668 writes nothing, and
# the file then holds an earlier taker's record. That is why the line says "recorded" and judges
# nothing: the coordinator reads it as the record, and looks before stopping anything. The waiting
# itself is still a blocking flock (in a thread, so the main one can speak), so a freed slot still
# wakes the drain at once, ahead of a batch polling for one each second.
# Exit: the command's own status; 127 with `EXECUTION HOLD REFUSED` when it cannot be run; 2 usage;
# 124 when --deadline ended the command's process group (ludics-lite#566).

import contextlib
import fcntl
import json
import math
import os
import re
import select
import shlex
import shutil
import signal
import socket
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, NoReturn, assert_never, cast

from ludics import cli
from ludics.fleetworker.config import (
    Config,
    SpecError,
    box_correctness_slots,
    box_gpu_tokens,
    in_roster,
    short_hostname,
)
from ludics.fleetworker import cotenants, group, holders
from ludics.fleetworker.execution import field, jq_text, listing, records_of, registry_source
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import substitution

HOLD_WAIT = 30  # seconds for systemd-inhibit to answer HELD or refuse; it answers at once
SLOT_PREFIX = "EXECUTION SLOT"
HOLD_PREFIX = "EXECUTION HOLD"


@dataclass(frozen=True)
class Inside:
    """The marker covers this batch: run it under the enclosing hold, taking nothing."""


@dataclass(frozen=True)
class Take:
    """The marker does not cover this batch: take a slot of its own."""


@dataclass(frozen=True)
class Refused:
    """The batch must not run: the line to print, exit 1."""

    line: str


type Judged = Inside | Take | Refused


def errline(text: str) -> None:
    sys.stdout.flush()
    sys.stderr.write(text + "\n")
    sys.stderr.flush()


def _is_held(path: str) -> bool | None:
    """Whether some process holds the flock on ``path`` now: a non-blocking exclusive lock on a new
    descriptor fails even for a descendant of the holder. None when the file cannot be opened."""
    try:
        descriptor = os.open(path, os.O_RDWR)
    except OSError:
        return None
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return True
    finally:
        os.close(descriptor)
    return False


# --- THE HOLDER RECORD ----------------------------------------------------------------------------
#
# The boundary of the reader (``read_holder``), as a fail-closed allowlist: it reads at most
# HOLDER_READ bytes of a slot file, as one JSON object, and takes from it exactly five fields --
# ``pid`` (an integer from 1 to PID_MAX, the range of every pid_t this package runs on),
# ``command`` (a non-empty list of strings), ``started`` (a finite number, the epoch second the
# slot was taken), ``deadline`` (null, or the positive whole ``--deadline`` seconds) and
# ``expires`` (absent or null until the command starts, then a finite ``time.monotonic()`` reading
# at which that deadline ends it). Any other key is not read. A file that is empty, longer, not
# that shape, or not readable is no record ("left no record"), never a partial one.
#
# What the drain says is what the record says, labelled as recorded: the slot, the recorded pid,
# the command, how long ago the slot was taken, and the cap. It judges nothing about the pid --
# whether it still runs, was reused, or is a zombie whose descendant holds the lock -- and advises
# no action: the coordinator, who can look, decides (ludics-lite#677's review, rounds 1-3, found a
# corner of such advice each round, so it is not given). The one reading it computes is the cap
# left, on the clock the deadline is enforced on: ``group.run`` waits on ``time.monotonic()``,
# which on Linux and macOS is one system-wide clock that a wall-clock step does not move, and
# ``expires`` is read against the same clock here, on the box the slot file is on.

HOLDER_REPEAT = 300  # FLEET_HOLD_DRAIN_REPEAT's default: seconds between the naming lines
HOLDER_READ = 65536
PID_MAX = 2**31 - 1  # the range of every pid_t this package runs on


@dataclass(frozen=True)
class Holder:
    pid: int
    command: tuple[str, ...]
    started: float
    deadline: int | None
    expires: float | None = None


def record_holder(descriptor: int, command: Sequence[str], deadline: int | None,
                  expires: float | None = None, started: float | None = None) -> float:
    """Write this process's holder record into the slot file it has locked; the ``started`` it
    wrote, which a rewrite at the command's start passes back. Fail-open: a record that cannot be
    written leaves the drain saying the holder left none."""
    when = time.time() if started is None else started
    record = {"pid": os.getpid(), "command": list(command), "started": when, "deadline": deadline,
              "expires": expires}
    data = (json.dumps(record) + "\n").encode("utf-8", "backslashreplace")
    try:
        os.ftruncate(descriptor, 0)
        os.pwrite(descriptor, data, 0)
    except OSError:
        pass
    return when


def _whole(value: object, top: int | None = None) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool) and value > 0
            and (top is None or value <= top))


def _finite(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # a JSON integer past a float's range
        return False


def read_holder(path: str) -> Holder | None:
    """The holder record in ``path`` (the boundary above), or None."""
    try:
        with open(path, "rb") as stream:
            data = stream.read(HOLDER_READ + 1)
    except OSError:
        return None
    if len(data) > HOLDER_READ:
        return None
    try:
        decoded: Any = json.loads(data.decode("utf-8"))
    except (ValueError, RecursionError):  # RecursionError: nesting deeper than the parser's stack
        return None
    if not isinstance(decoded, dict):
        return None
    record = cast(dict[str, Any], decoded)
    pid: Any = record.get("pid")
    command: Any = record.get("command")
    started: Any = record.get("started")
    deadline: Any = record.get("deadline")
    expires: Any = record.get("expires")
    if not _whole(pid, PID_MAX) or not (isinstance(command, list) and command):
        return None
    words = cast(list[Any], command)
    if not all(isinstance(word, str) for word in words):
        return None
    if not _finite(started) or (deadline is not None and not _whole(deadline)):
        return None
    if expires is not None and not _finite(expires):
        return None
    return Holder(int(pid), tuple(str(word) for word in words), float(started),
                  None if deadline is None else int(deadline), None if expires is None else float(expires))


def span(seconds: float) -> str:
    """``1h40m``, ``12m``, ``45s``: a duration at the precision a decision needs."""
    whole = max(int(seconds), 0)
    if whole < 60:
        return f"{whole}s"
    hours, minutes = divmod(whole // 60, 60)
    return f"{hours}h{minutes:02d}m" if hours else f"{minutes}m"


def printable(text: str) -> str:
    """A recorded command, shell-quoted and on one line: what the file says is data."""
    return "".join(ch if ch.isprintable() else ch.encode("unicode_escape").decode("ascii") for ch in text)


def holder_line(box: str, request: str, index: int, holder: Holder | None, now: float, clock: float,
                waited: float | None) -> str:
    """The line reporting slot ``index``'s holder record. ``now`` is the wall clock, ``clock`` this
    box's ``time.monotonic()``; ``waited``: seconds the drain has waited so far, None for the
    first line. Every held slot gets it, whatever its recorded cap: a record may be an earlier
    taker's (THE HOLDER RECORD), so no record of it may silence the line."""
    lead = (f"{HOLD_PREFIX} {box}: measurement {request} " +
            (f"waits on slot {index}" if waited is None else f"still waits for slot {index} after {span(waited)}") + ": ")
    if holder is None:
        return lead + ("its holder left no record of its command or --deadline (a batch started by a fleet-worker"
                       " older than ludics-lite#668, or one whose record could not be written), so nothing says"
                       " when it ends")
    if holder.deadline is None:
        cap = "no --deadline recorded"
    else:
        # Before its command starts the deadline has not begun to count: all of it is ahead.
        left = holder.deadline if holder.expires is None else holder.expires - clock
        cap = f"recorded --deadline {holder.deadline}s, about {span(left)} left"
    return lead + (f"recorded holder pid {holder.pid}, slot taken {span(now - holder.started)} ago, {cap};"
                   f" for: {printable(shlex.join(holder.command))}")


def drain_slot(box: str, request: str, path: str, descriptor: int, index: int, repeat: float) -> None:
    """Take slot ``index`` (its lock file ``path``, open on ``descriptor``) for the measurement,
    waiting for its batch to end: the unchanged ``waits for the batch`` line, then the holder's
    record (``holder_line``) at once and every ``repeat`` seconds. The wait is a blocking flock in
    a thread, so a freed slot wakes it at once. Raises OSError (the take's own failure only:
    naming the holder is a diagnostic, and nothing it raises stops the drain)."""
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return
    except BlockingIOError:
        pass
    errline(f"{HOLD_PREFIX} {box}: measurement {request} waits for the batch in slot {index} to end")
    failure: list[OSError] = []

    def take() -> None:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        except OSError as exc:
            failure.append(exc)

    waiter = threading.Thread(target=take, name=f"drain-slot-{index}", daemon=True)
    start = time.monotonic()
    waiter.start()
    waiter.join(0.2)  # a batch ending in this instant needs no naming
    waited: float | None = None
    while waiter.is_alive():
        try:
            line = holder_line(box, request, index, read_holder(path), time.time(), time.monotonic(), waited)
        except Exception as exc:  # a diagnostic: never the measurement's end
            line = f"{HOLD_PREFIX} {box}: measurement {request} waits on slot {index}: its record is unread ({exc!r})"
        if waiter.is_alive():
            errline(line)
        waiter.join(repeat)
        waited = time.monotonic() - start
    if failure:
        raise failure[0]


# --- the judgements -------------------------------------------------------------------------------


def judge_nested(box: str, directory: str, cap: int, tokens: int, cpu: bool, marker: str,
                 command: Sequence[str]) -> Judged:
    """An enclosing ``execution slot``'s marker, ``<box> <slot> <slots> <gpu|cpu>`` (THE NESTED SLOT)."""

    def not_here(reason: str) -> Judged:
        errline(f"{SLOT_PREFIX} {box}: FLEET_SLOT_HELD={marker!r} does not cover this batch ({reason}); taking a slot")
        return Take()

    fields = marker.split()
    if len(fields) != 4 or not (fields[1].isdigit() and fields[1].isascii()):
        return not_here("malformed")
    if fields[0] != box:
        return not_here("another box's")
    index = int(fields[1])
    if not 1 <= index <= cap:
        return not_here(f"no slot {index} among this box's {cap}")
    # The slot must be held NOW: a marker copied into a shell by hand, or left behind in an
    # environment that outlived its batch, names a slot nobody holds.
    held = _is_held(os.path.join(directory, f"slot.{index}"))
    if held is None:
        return not_here(f"slot {index} has no lock file")
    if not held:
        return not_here(f"slot {index} is not held")
    # A live `execution hold --request` holds every slot (THE DRAIN), and no batch inside it
    # carries this marker, so the slot above being held proves nothing while one is live.
    if _is_held(os.path.join(directory, "measurement.lock")):
        return not_here("a measurement's `execution hold --request` holds this box's slots")
    # Whether that slot may hold the GPU is judged from THIS spec, never from the marker's own
    # word: the tokens are the first <tokens> slot files.
    if tokens and index > tokens and not cpu:
        return Refused(
            f"{SLOT_PREFIX} REFUSED {box}: this batch runs inside slot {index} of {cap}, which an enclosing batch"
            " took as --cpu and is not a GPU token; a batch that holds the GPU must not run there"
            " (the enclosing `execution slot` must not declare --cpu)"
        )
    errline(f"{SLOT_PREFIX} {box}: inside slot {index} of {cap}, held by an enclosing batch, for: {' '.join(command)}")
    return Inside()


@dataclass(frozen=True)
class Covered:
    """The measurement an ``execution slot`` here runs inside, and a note when the registry
    no longer lists it (the live hold still holds the box's slots)."""

    request: str
    note: str


@dataclass(frozen=True)
class Uncovered:
    reason: str


type Measured = Covered | Uncovered


def judge_measurement(box: str, directory: str, marker: str, measuring: str | None) -> Measured:
    """An enclosing ``execution hold --request``'s marker, ``<box> <id>`` (THE MEASUREMENT'S OWN
    RUN), against the registry's outstanding measurements on this box (``", "``-joined), or against
    the lock alone when ``measuring`` is None (the probe, which reads no registry)."""
    fields = marker.split()
    if len(fields) != 2:
        return Uncovered("malformed")
    if fields[0] != box:
        return Uncovered("another box's")
    note = ""
    if measuring is not None:
        outstanding = [i for i in measuring.split(", ") if i]
        if not outstanding:
            # Concluded (or never was) while its runner still runs. The live hold holds every slot
            # of the box (THE DRAIN), so a slot of its own would wait for that very hold.
            note = f"the registry has no outstanding measurement {fields[1]} on {box}"
        elif fields[1] not in outstanding:
            return Uncovered(f"the registry has no outstanding measurement {fields[1]} on {box}")
        elif outstanding != [fields[1]]:
            return Uncovered(f"other measurements are outstanding on {box} too: {measuring}")
    # The hold must be live NOW, as an enclosing slot must be.
    held = _is_held(os.path.join(directory, "measurement.lock"))
    if held is None:
        return Uncovered(f"no `execution hold --request` has run on {box}")
    if held:
        return Covered(fields[1], note)
    return Uncovered(f"no `execution hold --request` is live on {box}")


def measured_verdict(box: str, marker: str, judged: Measured, command: Sequence[str]) -> Judged:
    match judged:
        case Uncovered(reason=reason):
            errline(f"{SLOT_PREFIX} {box}: FLEET_MEASUREMENT_HELD={marker!r} does not cover this batch ({reason})")
            return Take()
        case Covered(request=request, note=note):
            if note:
                errline(
                    f"{SLOT_PREFIX} {box}: inside the enclosing `execution hold --request {request}`, which holds"
                    f" this box's slots ({note}); no slot taken, for: {' '.join(command)}"
                )
            else:
                errline(
                    f"{SLOT_PREFIX} {box}: inside measurement {request}, held by an enclosing `execution hold`;"
                    f" no slot taken, for: {' '.join(command)}"
                )
            return Inside()
        case _:
            assert_never(judged)


# --- running the command --------------------------------------------------------------------------


def refuse_unrunnable(prefix: str, box: str, command: Sequence[str], reason: object) -> NoReturn:
    cli.say(f"{prefix} REFUSED {box}: cannot run {command[0]}: {reason}")
    sys.stdout.flush()
    raise cli.Exit(127)


def start_guard(box: str, inhibitor: str, why: str) -> None:
    """Take the sleep:idle block inhibitor in a double-forked helper reading a lifetime pipe whose
    write end the command inherits; report HELD, or run bare under a WARNING."""
    sys.stdout.flush()
    sys.stderr.flush()  # nothing buffered may be written twice by a fork
    if len(why) > 160:  # one line of `systemd-inhibit --list` and of `wake-lab.sh status`
        why = why[:157] + "..."
    life_r, life_w = os.pipe()
    ready_r, ready_w = os.pipe()
    middle = os.fork()
    if middle == 0:
        helper = os.fork()
        if helper == 0:
            try:
                os.dup2(life_r, 0)
                os.dup2(ready_w, 1)
                os.dup2(ready_w, 2)
                os.closerange(3, 65536)  # the slot flock, the lifetime pipe's write end, all of it
                signal.signal(signal.SIGPIPE, signal.SIG_DFL)
                os.execv(inhibitor, [inhibitor, "--what=sleep:idle", "--mode=block", "--who=fleet-worker",
                                     "--why=" + why, "--", "sh", "-c", "echo HELD; exec cat >/dev/null"])
            finally:
                os._exit(127)
        os.write(ready_w, b"PID %d\n" % helper)
        os._exit(0)
    os.waitpid(middle, 0)
    os.close(life_r)
    os.close(ready_w)
    text, helper_pid, held = b"", None, False
    deadline = time.monotonic() + HOLD_WAIT
    while not held:
        left = deadline - time.monotonic()
        if left <= 0 or not select.select([ready_r], [], [], left)[0]:
            text += b"no answer from systemd-inhibit after %ds" % HOLD_WAIT
            break
        chunk = os.read(ready_r, 4096)
        if not chunk:
            break
        text += chunk
        lines = text.split(b"\n")
        held = b"HELD" in lines
        for line in lines:
            if line.startswith(b"PID "):
                helper_pid = int(line[4:])
    os.close(ready_r)
    if held:
        errline(f"{HOLD_PREFIX} {box}: sleep:idle block inhibitor held for: {why}")
        os.set_inheritable(life_w, True)
        return
    if helper_pid is not None:
        try:
            os.kill(helper_pid, signal.SIGTERM)
        except OSError:
            pass
    os.close(life_w)
    detail = b" ".join(part for part in text.split(b"\n") if part and not part.startswith(b"PID "))
    errline(
        f"{HOLD_PREFIX} {box}: WARNING: running WITHOUT a sleep inhibitor, so nothing at the OS level"
        f" stops a suspend under it -- {inhibitor} refused: {detail.decode('utf-8', 'replace')[:200]}"
        " (the one-time polkit grant: issue-wave/references/executions.md, \"The OS-level sleep guard\")"
    )


def run_command(prefix: str, box: str, command: Sequence[str], inhibitor: str, why: str,
                deadline: int | None, nested: bool = False,
                recorder: "Recorder | None" = None, on_start: Callable[[], None] | None = None) -> NoReturn:
    """Run the command: resolved before the guard (a command that cannot be found takes no
    inhibitor), the guard beside it when there is one, then the command as the leader of a process
    group of its own, which a deadline or a signal to this wrapper ends (THE GROUP, ``group.py``).

    A NESTED batch -- one an enclosing slot or measurement hold covers, taking nothing -- is exec'd
    on this pid in the enclosing group instead, so the enclosing wrapper's group kill reaches its
    whole tree (ludics-lite#566): a group of its own would leave that tree to this wrapper's own
    reaping. Only a nested ``--deadline`` starts one, since a bound needs a group to end; the
    enclosing kill still reaches it through this wrapper, which ends its group when signalled, and
    through its guardian when this wrapper is killed outright.

    ``recorder`` (THE CO-TENANTS) takes its opening snapshot just before the command starts and
    writes it once the command has started, and takes its closing one once the command's leader
    has ended, however it ended, before this wrapper exits or dies: a command that cannot be
    started records nothing, and the deadline counts from the command's start as before.
    ``on_start`` (THE HOLDER RECORD) is called first, once the command has started, the moment its
    deadline starts to count."""
    if shutil.which(command[0]) is None:
        refuse_unrunnable(prefix, box, command, "no such executable")
    if not (nested and deadline is None):
        group.default_sigchld()  # the guard's helper and the group are this process's to wait for
    if inhibitor:
        start_guard(box, inhibitor, why)
    sys.stdout.flush()
    sys.stderr.flush()
    if nested and deadline is None:
        exec_command(prefix, box, command)
    pgid: list[int] = []
    if recorder is not None:
        recorder.prepare()

    def started(leader: int) -> None:
        pgid.append(leader)
        if on_start is not None:
            on_start()
        if recorder is not None:
            recorder.opened(leader)

    try:
        outcome = group.run(command, deadline, f"{prefix} {box}", errline, started=started)
    except OSError as exc:
        # A script whose interpreter is missing passes the lookup above and fails here.
        refuse_unrunnable(prefix, box, command, exc)
    if recorder is not None and pgid:
        recorder.closed(pgid[0])
    match outcome:
        case group.Exited(code=code):
            raise cli.Exit(code)
        case group.Expired():
            raise cli.Exit(124)
        case group.Killed(signum=signum) | group.Interrupted(signum=signum):
            group.die_of(signum)
        case _:
            assert_never(outcome)


def exec_command(prefix: str, box: str, command: Sequence[str]) -> NoReturn:
    """Exec the command on this pid (a nested batch, ``run_command``)."""
    try:
        # Python ignores SIGPIPE (and SIGXFSZ), and an IGNORED disposition survives exec: without
        # this the wrapped batch would see `yes | head -n1` exit 1 with a "Broken pipe" diagnostic
        # where the same script run directly exits 141. A wrapper must not change verdicts.
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        if hasattr(signal, "SIGXFSZ"):
            signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
        os.execvp(command[0], list(command))
    except OSError as exc:
        # A script whose interpreter is missing passes the lookup above and fails here.
        refuse_unrunnable(prefix, box, command, exc)


def take_slot(box: str, directory: str, cap: int, tokens: int, cpu: bool, wait: int, inhibitor: str,
              command: Sequence[str], bound: int | None, waiting: "WaitingRecord | None" = None) -> NoReturn:
    """Wait up to ``wait`` seconds for a slot (a GPU token unless ``cpu``), then run the command in it;
    from the first pass that finds none free, under a WaitingRecord (``waiting``, when the window
    wait already keeps one)."""
    # The candidate slots, in the order this batch tries them (THE GPU TOKENS).
    if not tokens:
        order = range(1, cap + 1)
    elif cpu:
        order = range(cap, 0, -1)
    else:
        order = range(1, tokens + 1)
    deadline = time.monotonic() + wait
    while True:
        for index in order:
            descriptor = os.open(os.path.join(directory, f"slot.{index}"), os.O_CREAT | os.O_RDWR, 0o644)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(descriptor)
                continue
            # The lock lives on this descriptor, which the command inherits. Nothing releases it
            # afterwards -- the kernel does, when the last process holding it ends.
            os.set_inheritable(descriptor, True)
            if waiting is not None:
                waiting.done()
            # THE HOLDER RECORD, for a drain waiting on it; its deadline's end once that counts.
            taken = record_holder(descriptor, command, bound)

            def counting() -> None:
                if bound is not None:
                    record_holder(descriptor, command, bound, time.monotonic() + bound, taken)

            held = f"slot {index} of {cap}"
            if tokens and index <= tokens:
                held += f", GPU token {index} of {tokens}"
            errline(f"{SLOT_PREFIX} {box}: {held} held for: {' '.join(command)}")
            # The marker a nested `execution slot` (and a runner that takes its own slot) reads.
            os.environ["FLEET_SLOT_HELD"] = f"{box} {index} {cap} {'gpu' if not tokens or index <= tokens else 'cpu'}"
            run_command(SLOT_PREFIX, box, command, inhibitor, f"{box} {held}: {' '.join(command)}", bound,
                        on_start=counting)
        if time.monotonic() >= deadline:
            if waiting is not None:
                waiting.done()
            if tokens and not cpu:
                cli.say(f"{SLOT_PREFIX} REFUSED {box}: all {tokens} GPU tokens (slots 1-{tokens} of {cap}) busy"
                        f" after {wait}s; a batch that holds no GPU declares --cpu")
            else:
                cli.say(f"{SLOT_PREFIX} REFUSED {box}: all {cap} run-time correctness slots busy after {wait}s")
            raise cli.Exit(1)
        if waiting is None:
            waiting = WaitingRecord(directory, command, "slot", "cpu" if cpu else "gpu")
        else:
            waiting.phase("slot")
        time.sleep(1)


def hold(box: str, inhibitor: str, why: str, hold_lock: str, marker: str, cap: int,
         command: Sequence[str], deadline: int | None, repeat: float = HOLDER_REPEAT) -> NoReturn:
    """``execution hold``: with a measurement (``hold_lock``), THE DRAIN and the marker's shared lock
    first, then the command under the guard, THE CO-TENANTS recorded before and after it."""
    recorder: Recorder | None = None
    taken: list[tuple[int, float]] = []  # THE HOLDER RECORD: each slot drained, and when

    def counting() -> None:
        if deadline is not None:
            expires = time.monotonic() + deadline
            for descriptor, when in taken:
                record_holder(descriptor, command, deadline, expires, when)

    if hold_lock:
        request = marker.split()[1]
        directory = os.path.dirname(hold_lock)
        indices = set(range(1, cap + 1))
        try:
            indices.update(int(name[5:]) for name in os.listdir(directory)
                           if name.startswith("slot.") and name[5:].isdigit() and name[5:].isascii())
        except OSError:
            pass
        # A hold nested in a live hold of this same measurement finds the slots held by its
        # enclosing one, and waiting for them would wait for itself.
        nested = os.environ.get("FLEET_MEASUREMENT_HELD") == marker and _is_held(hold_lock) is True
        if nested:
            indices = set[int]()
        for index in sorted(indices):
            try:
                path = os.path.join(directory, f"slot.{index}")
                descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
                drain_slot(box, request, path, descriptor, index, repeat)
                os.set_inheritable(descriptor, True)
                # No earlier taker's record outlives the take. While the drain goes on, nothing bounds
                # this hold: its --deadline starts with its command, after the drain.
                taken.append((descriptor, record_holder(descriptor, command, None)))
            except OSError as exc:
                errline(f"{HOLD_PREFIX} {box}: WARNING: slot {index} is not held for the measurement, so a batch"
                        f" may run beside it -- {exc}")
        # The measurement's marker and the lock that proves it live: SHARED, so a second hold of the
        # same measurement is not refused, and inherited by the whole command tree. Fail-open.
        try:
            descriptor = os.open(hold_lock, os.O_CREAT | os.O_RDWR, 0o644)
            fcntl.flock(descriptor, fcntl.LOCK_SH)
            os.set_inheritable(descriptor, True)
        except OSError as exc:
            errline(f"{HOLD_PREFIX} {box}: WARNING: no measurement marker, so an `execution slot`"
                    f" inside this hold is refused -- cannot lock {hold_lock}: {exc}")
        else:
            os.environ["FLEET_MEASUREMENT_HELD"] = marker
            errline(f"{HOLD_PREFIX} {box}: measurement {request} held; an `execution slot` inside it runs"
                    " under this hold")
        # THE CO-TENANTS: every hold records its own pair, a nested one too, since nothing bounds
        # its life by its enclosing hold's (a backgrounded nested hold outlives it).
        recorder = Recorder(box, request, directory, os.getpgrp() if nested else None)
    run_command(HOLD_PREFIX, box, command, inhibitor, why, deadline, recorder=recorder, on_start=counting)


class Recorder:
    """THE CO-TENANTS (``cotenants.py``) of one hold: the opening snapshot is TAKEN before the
    command starts (``prepare``: nothing of the hold's tree runs yet, and the command's deadline is
    not yet counting) and WRITTEN once it has started (``opened``, an append, instant), so a command
    that cannot be started leaves no record; the closing one once its leader has ended. Fail-open,
    and loudly: a record that cannot be written is a WARNING, never a refused measurement."""

    def __init__(self, box: str, request: str, directory: str, enclosing: int | None) -> None:
        self.box, self.request, self.enclosing = box, request, enclosing
        self.path = cotenants.record_path(directory, request)
        self.label = f"{HOLD_PREFIX} {box}: measurement {request}"
        self.first: dict[str, Any] | None = None

    def snap(self, event: str, pgid: int | None) -> dict[str, Any] | None:
        try:
            return cotenants.snapshot(os.environ, event, self.request, self.box, os.getpid(), pgid,
                                      enclosing=self.enclosing)
        except Exception as exc:  # a snapshot is evidence, and never stops the measurement
            errline(f"{self.label}: WARNING: no GPU co-tenant snapshot {event} -- {exc!r}")
            return None

    def write(self, line: dict[str, Any]) -> None:
        # Called inside group.run while the command runs (the opening line): nothing raised here
        # may leave the command unwaited for.
        try:
            cotenants.append(self.path, line)
        except Exception as exc:
            errline(f"{self.label}: WARNING: the GPU co-tenants {line.get('event')} are not recorded for the"
                    f" conclusion, only said here -- {self.path}: {exc}")

    def prepare(self) -> None:
        self.first = self.snap("opened", None)

    def opened(self, pgid: int) -> None:
        if self.first is not None:
            self.write(self.first)
            errline(f"{self.label}: {cotenants.opened_line(self.first)}")

    def closed(self, pgid: int) -> None:
        line = self.snap("closed", pgid)
        if line is not None:
            self.write(line)
            errline(f"{self.label}: {cotenants.closed_line(line)}")


def inhibitor_path(cfg: Config) -> str:
    """The systemd-inhibit this box would take the guard with, or empty for none."""
    return shutil.which(cfg.inhibit) or ""


# --- the commands ---------------------------------------------------------------------------------

SLOT_USAGE = (
    "execution slot [--bg <parent>] [--wait <seconds>] [--wait-window[=<seconds>]] [--cpu|--gpu] [--deadline <seconds>]"
    " -- <command> [args...]"
    " | execution slot --probe"
    " | execution slot --holders"
)
WINDOW_WAIT = 3600  # --wait-window's bound when it names none: an hour of measuring
WINDOW_PROGRESS = 60  # seconds between the lines that say a waiting batch is still waiting
HOLD_USAGE = "execution hold [--why <text>] [--request <id>] [--deadline <seconds>] -- <command> [args...]"


@dataclass(frozen=True)
class SlotArgs:
    wait: int
    kind: str  # "", "--cpu" or "--gpu"
    probe: bool
    bg: str
    command: list[str]
    window_wait: int | None = None  # --wait-window's bound; None: refuse at once under a measurement
    deadline: int | None = None
    holders: bool = False  # --holders (ludics-lite#639): list who holds this box's slots, take nothing


def parse_deadline(verb: str, args: list[str], i: int) -> int:
    """``--deadline <seconds>`` at ``args[i]``: a positive whole number (THE DEADLINE, group.py)."""
    if i + 1 >= len(args) or not re.fullmatch(r"[0-9]+", args[i + 1]) or int(args[i + 1]) < 1:
        die(f"execution {verb}: --deadline takes a positive whole number of seconds")
    return int(args[i + 1])


def parse_slot(args: list[str]) -> SlotArgs:
    if args and args[0] == "--holders":
        # A read of the box's locks, taking none: it takes no option, so no word is accepted and
        # then ignored (a --probe line's options are a runner's, the holders' have no such caller).
        if len(args) > 1:
            die("execution slot: --holders takes no other word; it runs nothing")
        return SlotArgs(600, "", False, "", [], holders=True)
    wait, kind, probe, bg = 600, "", False, ""
    deadline: int | None = None
    window_wait: int | None = None
    wait_text = "600"
    i = 0
    command: list[str] = []
    while i < len(args):
        arg = args[i]
        if arg == "--probe":
            probe = True
        elif arg == "--holders":
            die("execution slot: --holders takes no other word; it runs nothing")
        elif arg == "--bg":
            if i + 1 >= len(args) or not args[i + 1]:
                die("execution slot: expected a parent directory for --bg")
            bg = args[i + 1]
            i += 1
        elif arg == "--wait":
            if i + 1 >= len(args):
                die("execution slot: expected value for --wait")
            wait_text = args[i + 1]
            if not re.fullmatch(r"[0-9]+", wait_text):
                die("execution slot: --wait takes a whole number of seconds")
            wait = int(wait_text)
            i += 1
        elif arg == "--deadline":
            deadline = parse_deadline("slot", args, i)
            i += 1
        elif arg == "--wait-window":
            window_wait = WINDOW_WAIT
        elif arg.startswith("--wait-window="):
            # Its value only after `=`: a bare `--wait-window` is the flag, so the next word is never
            # taken for a bound it was not meant as.
            if not re.fullmatch(r"[0-9]+", arg[len("--wait-window=") :]):
                die("execution slot: --wait-window takes a whole number of seconds, as --wait-window=<seconds>")
            window_wait = int(arg[len("--wait-window=") :])
        elif arg in ("--cpu", "--gpu"):
            if kind and kind != arg:
                die("execution slot: --cpu and --gpu are exclusive")
            kind = arg
        elif arg == "--":
            command = args[i + 1 :]
            break
        else:
            die(SLOT_USAGE)
        i += 1
    if probe and bg:
        die("execution slot: --probe takes no --bg; it runs nothing")
    if probe and deadline is not None:
        die("execution slot: --probe takes no --deadline; it runs nothing")
    if not probe and not command:
        die("execution slot: a command to hold the slot around is required, after --")
    return SlotArgs(wait, kind, probe, bg, command, window_wait, deadline)


def measurement_records(records: list[dict[str, Any]], box: str) -> list[dict[str, Any]]:
    """The outstanding measurements on ``box``, a window or not."""
    return [
        r
        for r in records
        if r.get("state") != "concluded"
        and field(r, "request", "execution_host") == box
        and field(r, "request", "kind") == "measurement"
    ]


def outstanding_measurements(records: list[dict[str, Any]], box: str, window_only: bool) -> str:
    ids = [
        str(r.get("request_id"))
        for r in measurement_records(records, box)
        if not window_only or r.get("window") is True
    ]
    return ", ".join(ids)


@dataclass(frozen=True)
class Voice:
    """Who is waiting, in ``await_measurements``' lines: the slot itself, or a caller that waits
    before it reaches one (``execution leg``, ludics-lite#666), whose lines are its own."""

    prefix: str  # what every line starts with
    proceed: str  # said once nothing holds the box any more
    refused: str  # what a refusal at the bound adds: what did not happen


SLOT_VOICE = Voice(SLOT_PREFIX, "taking a slot", "no slot taken")


@dataclass(frozen=True)
class Unread:
    """The anchor's registry could not be read: the lines a refusal prints, and its status."""

    rc: int
    lines: tuple[str, ...]


# wake-lab.sh's anchor allowlist (its `--wait` check of WAKE_LAB_ANCHOR), restated as the boundary
# of the retry line below: the wake command is offered only for an anchor wake-lab accepts, and
# any other spelling (an IPv6 literal, a scoped one) gets the retry advice without it. Fail-closed:
# a spelling this does not match is never handed a command that would refuse it.
WAKE_LAB_ANCHOR = re.compile(r"[A-Za-z0-9._@][A-Za-z0-9._@-]*")


def unreachable_lines(anchor: str, voice: Voice = SLOT_VOICE) -> tuple[str, ...]:
    """The UNREACHABLE refusal: the registry line, then why a freshly woken box may only need a retry."""
    retry = (f"{voice.prefix} UNREACHABLE {anchor}: a box woken in the last few minutes may only need its"
             f" ssh to {anchor} to come up; retry in a minute")
    if WAKE_LAB_ANCHOR.fullmatch(anchor):
        retry += (f" (on a native-Linux box, WAKE_LAB_ANCHOR={anchor} wake-lab.sh --wait <box> waits for that"
                  " leg; it does not ask a WSL guest's)")
    else:
        retry += ", once its route to the anchor is up"
    return (f"{voice.prefix} UNREACHABLE {anchor}: registry unread, {voice.refused}", retry)


def read_registry(cfg: Config, box: str, voice: Voice = SLOT_VOICE,
                  waiter: dict[str, Any] | None = None) -> list[dict[str, Any]] | Unread:
    done = listing(cfg, waiter)
    if done.unreachable:
        # Refused at once, never retried here: later in a box's uptime an anchor that does not
        # answer is the answer. The first minute after a wake is the exception (ludics-lite#617):
        # the box's sshd answers before its own ssh to the anchor does, so the second line tells
        # the caller that a retry may be all it needs, and -- for an anchor wake-lab accepts, on a
        # native-Linux box -- that `wake-lab.sh --wait` waits for it. The command names this
        # anchor, this box's spelling of it, as WAKE_LAB_ANCHOR wants: wake-lab's own default
        # (mac-studio) is FLEET_ANCHOR's default, not whatever this one is.
        return Unread(4, unreachable_lines(cfg.anchor, voice))
    if done.rc != 0:
        return Unread(1, (substitution(done.out), f"{voice.prefix} REFUSED {box}: the anchor's registry could not be read"))
    records = records_of(done.out)
    if records is None:
        return Unread(1, (f"{voice.prefix} REFUSED {box}: the anchor's registry did not parse",))
    return records


def describe_measurement(box: str, record: dict[str, Any], prefix: str = SLOT_PREFIX) -> str:
    """Which measurement holds the box, and whose: one line, said once per measurement waited for.
    A holder with no ``request`` is one a caller knows only by id (``execution leg``'s suspending
    window, absent from a read), said so."""
    what = "measurement window" if record.get("window") is True else "measurement"
    if "request" not in record:
        return (f"{prefix} {box}: {what} {jq_text(record.get('request_id'))} holds {box} (its record is not in"
                " this read of the registry)")
    owner = jq_text(record.get("coordinator"))
    worker = jq_text(field(record, "request", "worker"))
    # A request without an issue (ludics-lite#664: a post-wave task, an integration run) is named by its purpose.
    issue = jq_text(field(record, "request", "issue") or field(record, "request", "purpose"))
    since = jq_text(record.get("created_at"))
    return (
        f"{prefix} {box}: {what} {jq_text(record.get('request_id'))} holds {box} (coordinator {owner};"
        f" {worker} for {issue}; reserved {since}; no expected end is recorded)"
    )


def waiter_id(cfg: Config) -> str:
    """This waiter's id on the anchor (THE WAITERS): where it runs and its pid, in the registry's
    id alphabet."""
    origin = re.sub(r"[^A-Za-z0-9._-]", "-", cfg.local_box or socket.gethostname().split(".")[0] or "host")
    return f"{origin if origin[:1].isalnum() else 'host'}-{os.getpid()}"


class WaitingRecord:
    """THE WAITING RECORD (ludics-lite#719): ``<slot directory>/waiting.<pid>``, one JSON object
    (``pid``, ``command``, ``since``, ``phase`` -- ``window`` while it waits out a measurement,
    ``slot`` while it waits for a free slot -- and ``kind``, the slot it asks for), flocked by this
    process for as long as it waits. ``slot --holders`` lists a record only while its flock is held,
    so a waiter that died leaves nothing listed, and the kernel is what says so. It is written to a
    temporary name, locked, and only then renamed into place, so a ``waiting.<pid>`` that is not
    locked is one whose owner has gone, and the next waiter removes it. ``done`` removes the record
    and releases it before the batch runs or is refused: the descriptor is not inherited, but this
    process outlives its command as its parent, and would otherwise hold it for the whole batch."""

    def __init__(self, directory: str, command: Sequence[str], phase: str, kind: str) -> None:
        self.path = os.path.join(directory, f"waiting.{os.getpid()}")
        self.fields: dict[str, Any] = {"pid": os.getpid(), "command": " ".join(command)[:300],
                                       "since": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kind": kind}
        self.descriptor: int | None = None
        try:
            os.makedirs(directory, exist_ok=True)
            for name in os.listdir(directory):
                # A record whose owner has gone; or a temporary one a waiter killed between its
                # creation and its rename left, once it is old enough not to be one about to be locked.
                path = os.path.join(directory, name)
                with contextlib.suppress(OSError):
                    stale = name.startswith("waiting.") or (
                        name.startswith(".waiting-") and time.time() - os.lstat(path).st_mtime > 60)
                    if stale and holders.held_now(path) is False:
                        os.unlink(path)
            descriptor, temporary = tempfile.mkstemp(prefix=".waiting-", dir=directory)
            os.fchmod(descriptor, 0o644)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            self.descriptor = descriptor
            self.phase(phase)
            os.rename(temporary, self.path)
        except OSError as exc:
            # A trace for a person, never a gate: a batch is not refused for want of one.
            errline(f"{SLOT_PREFIX}: no waiting record in {directory} ({exc.strerror or exc}); --holders will not list"
                    " this batch while it waits")
            self.done()

    def phase(self, phase: str) -> None:
        if self.descriptor is None or phase == self.fields.get("phase"):
            return
        self.fields["phase"] = phase
        text = json.dumps(self.fields, separators=(",", ":"), ensure_ascii=False).encode()
        with contextlib.suppress(OSError):
            os.ftruncate(self.descriptor, 0)
            os.pwrite(self.descriptor, text + b"\n", 0)

    def done(self) -> None:
        if self.descriptor is None:
            return
        with contextlib.suppress(OSError):
            os.unlink(self.path)
        os.close(self.descriptor)
        self.descriptor = None


def await_measurements(cfg: Config, box: str, records: list[dict[str, Any]], bound: int,
                       command: Sequence[str], voice: Voice = SLOT_VOICE,
                       holders: Callable[[list[dict[str, Any]]], list[dict[str, Any]]] | None = None,
                       ) -> list[dict[str, Any]] | int:
    """``--wait-window`` (ludics-lite#557): block until no measurement is outstanding on ``box``,
    re-reading the registry every ``FLEET_SLOT_WINDOW_POLL`` seconds (15), for at most ``bound``
    seconds; the registry it last read, or the refusal's status. A measurement on another box is
    not this box's (``measurement_records``), so it never blocks. Each measurement waited for is
    named once, and a line every ``WINDOW_PROGRESS`` seconds says the batch is still waiting.
    ``execution leg`` waits here too, on the agent host for its execution host's box, in its own
    ``voice``, with ``holders`` (what holds the box in a registry read; the box's measurements when
    not given) adding the window its record is still suspended by (ludics-lite#666)."""
    try:
        poll = max(float(cfg.env.get("FLEET_SLOT_WINDOW_POLL", "15")), 0.1)
    except ValueError:
        poll = 15.0
    # THE WAITERS (ludics-lite#719): every read in the wait tells the anchor this batch waits for the
    # box, fresh for three polls' worth (at least 30 s), so the heartbeat of the read that finds the
    # box free outlasts the moment it takes to get its slot. The first read is at once, so a window
    # opened before the first poll would be due sees this waiter too.
    waiter = {"box": box, "id": waiter_id(cfg), "command": " ".join(command)[:300],
              "ttl": min(max(30, math.ceil(3 * poll)), 3600)}
    beat = True
    start = time.monotonic()
    deadline, progress = start + bound, start + WINDOW_PROGRESS
    named: set[str] = set()
    unread: Unread | None = None
    while True:
        holding = holders(records) if holders is not None else measurement_records(records, box)
        if not holding and unread is None:
            if named:
                errline(f"{voice.prefix} {box}: no measurement holds {box} after {int(time.monotonic() - start)}s;"
                        f" {voice.proceed}")
            return records
        for record in holding:
            identity = jq_text(record.get("request_id"))
            if identity not in named:
                named.add(identity)
                errline(describe_measurement(box, record, voice.prefix))
                errline(f"{voice.prefix} {box}: waiting up to {bound}s (--wait-window) for it to conclude, then for a"
                        f" slot, for: {' '.join(command)}")
        now = time.monotonic()
        ids = ", ".join(jq_text(r.get("request_id")) for r in holding)
        if now >= deadline:
            if unread is not None:
                for line in unread.lines:
                    cli.say(line)
                return unread.rc
            cli.say(f"{voice.prefix} REFUSED {box}: measurement {ids} still holds {box} after {bound}s"
                    f" (--wait-window); {voice.refused}")
            return 1
        if now >= progress:
            errline(f"{voice.prefix} {box}: still waiting for measurement {ids}"
                    f" ({int(now - start)}s of {bound}s, --wait-window)")
            progress += WINDOW_PROGRESS
        if not beat:
            time.sleep(min(poll, deadline - now))
            if time.monotonic() >= deadline:
                # The bound is the bound: no read after it, which over a remote anchor could run past
                # it by the transport's timeout and then admit the batch late.
                continue
        beat = False
        read = read_registry(cfg, box, voice, waiter)
        if time.monotonic() >= deadline:
            # Nor a read that came back past it: a slow transport must not admit the batch late
            # either (ludics-lite#683 review). Such a read decides which refusal is said -- its
            # own failure, or the measurement's -- and never whether the batch runs.
            unread = read if isinstance(read, Unread) else None
            continue
        if isinstance(read, Unread):
            # One failed read mid-wait is not the window's answer: said, and asked again until the
            # bound, when the refusal is the read's own.
            unread = read
            errline(f"{voice.prefix} {box}: the registry could not be read while waiting"
                    f" ({' '.join(line for line in read.lines if line)}); asking again")
            continue
        records, unread = read, None


def cmd_slot(cfg: Config, args: list[str]) -> int:
    parsed = parse_slot(args)
    command = parsed.command
    box = cfg.local_box
    if not box:
        die("execution slot: this host has no fleet name; set FLEET_LOCAL_BOX (the slot is this box's own)")
    # An alias or a typo would lock under a name of its own and read measurements under another.
    if not in_roster(cfg, box):
        cli.say(f"{SLOT_PREFIX} REFUSED {box}: not a canonical FLEET_BOXES entry ({cfg.boxes})")
        return 1
    try:
        cap = box_correctness_slots(cfg, box)
        tokens = box_gpu_tokens(cfg, box)
    except SpecError as exc:
        cli.say(f"{SLOT_PREFIX} REFUSED {box}: {exc}")
        return 1
    # Where there are as many tokens as slots the tokens cannot bind, and every batch takes any slot.
    if tokens >= cap:
        tokens = 0
    directory = os.path.join(cfg.path(cfg.slot_state), box)
    cpu = parsed.kind == "--cpu"
    marker_measure = os.environ.get("FLEET_MEASUREMENT_HELD", "")
    if parsed.holders:
        # THE HOLDERS (ludics-lite#639, ``holders.py``): who holds this box's slots now, one JSON line
        # per held slot; like the probe, it takes nothing and reads no registry.
        sys.stdout.write(holders.render(holders.holders(box, directory, cap, tokens) + holders.waiters(box, directory)))
        return 0
    if parsed.probe:
        # THE PROBE: what a slot here would be, taking nothing and reading no registry; inside a
        # live `execution hold --request` here, the measurement it runs. fleet-worker.sh answers
        # the probe itself, needing no Python (THE PROBE WITHOUT PYTHON there), and asks this only
        # for the measurement.
        inside = ""
        if marker_measure:
            judged = judge_measurement(box, directory, marker_measure, None)
            if isinstance(judged, Covered):
                inside = judged.request
        cli.say(f"{SLOT_PREFIX} PROBE {box} {cap} {tokens or cap}" + (f" measurement {inside}" if inside else ""))
        return 0
    if parsed.bg:
        # THE DETACHED BATCH (ludics-lite#181): bg-run.sh `spawn` runs this same slot detached and
        # prints its run directory; the run inherits this environment, an enclosing slot included.
        bgrun = os.path.join(cfg.here, "bg-run.sh")
        again = os.path.join(cfg.here, os.path.basename(cfg.script))
        argv = [bgrun, "spawn", parsed.bg, "--", again, "execution", "slot", "--wait", str(parsed.wait)]
        if parsed.window_wait is not None:
            argv.append(f"--wait-window={parsed.window_wait}")
        if parsed.kind:
            argv.append(parsed.kind)
        if parsed.deadline is not None:
            argv += ["--deadline", str(parsed.deadline)]
        argv += ["--", *command]
        sys.stdout.flush()
        sys.stderr.flush()
        try:
            os.execv(bgrun, argv)
        except OSError as exc:
            errline(f"{bgrun}: {exc.strerror}")
            return 126
    marker_slot = os.environ.get("FLEET_SLOT_HELD", "")
    if marker_slot:
        verdict = judge_nested(box, directory, cap, tokens, cpu, marker_slot, command)
        match verdict:
            case Refused(line=line):
                cli.say(line)
                return 1
            case Inside():
                run_command(SLOT_PREFIX, box, command, "", "", parsed.deadline, nested=True)
            case Take():
                del os.environ["FLEET_SLOT_HELD"]
            case _:
                assert_never(verdict)
    registry_source()  # `execution: missing helper` before the registry is asked anything
    records = read_registry(cfg, box)
    if isinstance(records, Unread):
        for line in records.lines:
            cli.say(line)
        return records.rc
    measuring = outstanding_measurements(records, box, window_only=False)
    window = outstanding_measurements(records, box, window_only=True)
    if marker_measure:
        verdict = measured_verdict(box, marker_measure, judge_measurement(box, directory, marker_measure, measuring), command)
        match verdict:
            case Inside():
                run_command(SLOT_PREFIX, box, command, "", "", parsed.deadline, nested=True)
            case Take():
                del os.environ["FLEET_MEASUREMENT_HELD"]
            case Refused(line=line):
                cli.say(line)
                return 1
            case _:
                assert_never(verdict)
    # --wait-window waits here, and never inside a measurement's hold (a batch carrying its
    # marker that the judgement above did not admit): there it would wait for its own measurement.
    waiting: WaitingRecord | None = None
    if measuring and parsed.window_wait is not None and not marker_measure:
        waiting = WaitingRecord(directory, command, "window", "cpu" if cpu else "gpu")
        waited = await_measurements(cfg, box, records, parsed.window_wait, command)
        if isinstance(waited, int):
            waiting.done()
            return waited
        records = waited
        measuring = outstanding_measurements(records, box, window_only=False)
        window = outstanding_measurements(records, box, window_only=True)
    elif measuring and parsed.window_wait is not None:
        errline(f"{SLOT_PREFIX} {box}: --wait-window does not wait inside a measurement's hold, where it would"
                " wait for its own measurement")
    if (window or measuring) and waiting is not None:
        waiting.done()
    if window:
        cli.say(
            f"{SLOT_PREFIX} REFUSED {box}: measurement window {window} is open on {box}, and holds the box"
            " exclusively; standing reservations here are suspended until it concludes, so retry this batch"
            " then (no request needed), or wrap it in `execution slot --wait-window`, which waits for that;"
            " only a batch inside its own `execution hold --request <id>` runs there"
        )
        return 1
    if measuring:
        cli.say(
            f"{SLOT_PREFIX} REFUSED {box}: a measurement holds the box exclusively ({measuring}); only a batch"
            " inside its own `execution hold --request <id>` runs there"
            + ("" if marker_measure or parsed.window_wait is not None else ", and `--wait-window` waits for it")
        )
        return 1
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError:
        die(f"execution slot: cannot create the slot directory {directory}")
    take_slot(box, directory, cap, tokens, cpu, parsed.wait, inhibitor_path(cfg), command, parsed.deadline, waiting)


def cmd_hold(cfg: Config, args: list[str]) -> int:
    why, request = "", ""
    deadline: int | None = None
    command: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--why":
            if i + 1 >= len(args) or not args[i + 1]:
                die("execution hold: expected text for --why")
            why = args[i + 1]
            i += 1
        elif arg == "--request":
            if i + 1 >= len(args) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args[i + 1]):
                die("execution hold: --request takes the measurement's request id ([A-Za-z0-9][A-Za-z0-9._-]*)")
            request = args[i + 1]
            i += 1
        elif arg == "--deadline":
            deadline = parse_deadline("hold", args, i)
            i += 1
        elif arg == "--":
            command = args[i + 1 :]
            break
        else:
            die(HOLD_USAGE)
        i += 1
    if not command:
        die("execution hold: a command to hold the box around is required, after --")
    box = cfg.local_box or short_hostname()
    hold_lock, marker, cap = "", "", 0
    if request:
        # The marker names the box the slot reads it on, so it needs the name the slot has.
        if not cfg.local_box:
            die("execution hold: --request needs this host's fleet name; set FLEET_LOCAL_BOX")
        directory = os.path.join(cfg.path(cfg.slot_state), box)
        try:
            os.makedirs(directory, exist_ok=True)
        except OSError:
            die(f"execution hold: cannot create the slot directory {directory}")
        hold_lock, marker = os.path.join(directory, "measurement.lock"), f"{box} {request}"
        # THE DRAIN takes every slot file there and slots 1..<count>; a spec it cannot read costs
        # only the second half, never the measurement.
        try:
            cap = box_correctness_slots(cfg, box)
        except SpecError:
            cap = 0
    if not why:
        why = f"{box} {'measurement ' + request + ' ' if request else ''}hold: {' '.join(command)}"
    try:
        repeat = float(cfg.env.get("FLEET_HOLD_DRAIN_REPEAT", str(HOLDER_REPEAT)))
    except ValueError:
        repeat = HOLDER_REPEAT
    repeat = max(repeat, 0.1) if math.isfinite(repeat) else HOLDER_REPEAT
    hold(box, inhibitor_path(cfg), why, hold_lock, marker, cap, command, deadline, repeat)
