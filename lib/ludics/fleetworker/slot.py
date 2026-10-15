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
- THE WINDOW WAIT (ludics-lite#557): ``slot --wait-window[=<seconds>]`` turns the refusal beside an
  outstanding measurement on this box (a window or not) into a bounded wait for it to conclude, then
  queues for a slot under ``--wait`` as usual: two waits, each with its own bound and refusal line.
  It is a separate flag, so a caller that relies on the immediate refusal (a runner's nested slot)
  is never parked for a whole window, and it does not wait inside a measurement's hold, where it
  would wait for its own measurement.
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
# Exit: the command's own status; 127 with `EXECUTION HOLD REFUSED` when it cannot be run; 2 usage;
# 124 when --deadline ended the command's process group (ludics-lite#566).

import fcntl
import os
import re
import select
import shutil
import signal
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, NoReturn, assert_never

from ludics import cli
from ludics.fleetworker.config import (
    Config,
    SpecError,
    box_correctness_slots,
    box_gpu_tokens,
    in_roster,
    short_hostname,
)
from ludics.fleetworker import cotenants, group
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
                recorder: "Recorder | None" = None) -> NoReturn:
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
    started records nothing, and the deadline counts from the command's start as before."""
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
              command: Sequence[str], bound: int | None) -> NoReturn:
    """Wait up to ``wait`` seconds for a slot (a GPU token unless ``cpu``), then run the command in it."""
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
            held = f"slot {index} of {cap}"
            if tokens and index <= tokens:
                held += f", GPU token {index} of {tokens}"
            errline(f"{SLOT_PREFIX} {box}: {held} held for: {' '.join(command)}")
            # The marker a nested `execution slot` (and a runner that takes its own slot) reads.
            os.environ["FLEET_SLOT_HELD"] = f"{box} {index} {cap} {'gpu' if not tokens or index <= tokens else 'cpu'}"
            run_command(SLOT_PREFIX, box, command, inhibitor, f"{box} {held}: {' '.join(command)}", bound)
        if time.monotonic() >= deadline:
            if tokens and not cpu:
                cli.say(f"{SLOT_PREFIX} REFUSED {box}: all {tokens} GPU tokens (slots 1-{tokens} of {cap}) busy"
                        f" after {wait}s; a batch that holds no GPU declares --cpu")
            else:
                cli.say(f"{SLOT_PREFIX} REFUSED {box}: all {cap} run-time correctness slots busy after {wait}s")
            raise cli.Exit(1)
        time.sleep(1)


def hold(box: str, inhibitor: str, why: str, hold_lock: str, marker: str, cap: int,
         command: Sequence[str], deadline: int | None) -> NoReturn:
    """``execution hold``: with a measurement (``hold_lock``), THE DRAIN and the marker's shared lock
    first, then the command under the guard, THE CO-TENANTS recorded before and after it."""
    recorder: Recorder | None = None
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
                descriptor = os.open(os.path.join(directory, f"slot.{index}"), os.O_CREAT | os.O_RDWR, 0o644)
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    errline(f"{HOLD_PREFIX} {box}: measurement {request} waits for the batch in slot {index} to end")
                    fcntl.flock(descriptor, fcntl.LOCK_EX)
                os.set_inheritable(descriptor, True)
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
    run_command(HOLD_PREFIX, box, command, inhibitor, why, deadline, recorder=recorder)


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


def parse_deadline(verb: str, args: list[str], i: int) -> int:
    """``--deadline <seconds>`` at ``args[i]``: a positive whole number (THE DEADLINE, group.py)."""
    if i + 1 >= len(args) or not re.fullmatch(r"[0-9]+", args[i + 1]) or int(args[i + 1]) < 1:
        die(f"execution {verb}: --deadline takes a positive whole number of seconds")
    return int(args[i + 1])


def parse_slot(args: list[str]) -> SlotArgs:
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
class Unread:
    """The anchor's registry could not be read: the lines a refusal prints, and its status."""

    rc: int
    lines: tuple[str, ...]


def read_registry(cfg: Config, box: str) -> list[dict[str, Any]] | Unread:
    done = listing(cfg)
    if done.unreachable:
        return Unread(4, (f"{SLOT_PREFIX} UNREACHABLE {cfg.anchor}: registry unread, no slot taken",))
    if done.rc != 0:
        return Unread(1, (substitution(done.out), f"{SLOT_PREFIX} REFUSED {box}: the anchor's registry could not be read"))
    records = records_of(done.out)
    if records is None:
        return Unread(1, (f"{SLOT_PREFIX} REFUSED {box}: the anchor's registry did not parse",))
    return records


def describe_measurement(box: str, record: dict[str, Any]) -> str:
    """Which measurement holds the box, and whose: one line, said once per measurement waited for."""
    what = "measurement window" if record.get("window") is True else "measurement"
    owner = jq_text(record.get("coordinator"))
    worker = jq_text(field(record, "request", "worker"))
    issue = jq_text(field(record, "request", "issue"))
    since = jq_text(record.get("created_at"))
    return (
        f"{SLOT_PREFIX} {box}: {what} {jq_text(record.get('request_id'))} holds {box} (coordinator {owner};"
        f" {worker} for {issue}; reserved {since}; no expected end is recorded)"
    )


def await_measurements(cfg: Config, box: str, records: list[dict[str, Any]], bound: int,
                       command: Sequence[str]) -> list[dict[str, Any]] | int:
    """``--wait-window`` (ludics-lite#557): block until no measurement is outstanding on this box,
    re-reading the registry every ``FLEET_SLOT_WINDOW_POLL`` seconds (15), for at most ``bound``
    seconds; the registry it last read, or the refusal's status. A measurement on another box is
    not this box's (``measurement_records``), so it never blocks. Each measurement waited for is
    named once, and a line every ``WINDOW_PROGRESS`` seconds says the batch is still waiting."""
    try:
        poll = max(float(cfg.env.get("FLEET_SLOT_WINDOW_POLL", "15")), 0.1)
    except ValueError:
        poll = 15.0
    start = time.monotonic()
    deadline, progress = start + bound, start + WINDOW_PROGRESS
    named: set[str] = set()
    unread: Unread | None = None
    while True:
        holding = measurement_records(records, box)
        if not holding and unread is None:
            if named:
                errline(f"{SLOT_PREFIX} {box}: no measurement holds {box} after {int(time.monotonic() - start)}s;"
                        " taking a slot")
            return records
        for record in holding:
            identity = jq_text(record.get("request_id"))
            if identity not in named:
                named.add(identity)
                errline(describe_measurement(box, record))
                errline(f"{SLOT_PREFIX} {box}: waiting up to {bound}s (--wait-window) for it to conclude, then for a"
                        f" slot, for: {' '.join(command)}")
        now = time.monotonic()
        ids = ", ".join(jq_text(r.get("request_id")) for r in holding)
        if now >= deadline:
            if unread is not None:
                for line in unread.lines:
                    cli.say(line)
                return unread.rc
            cli.say(f"{SLOT_PREFIX} REFUSED {box}: measurement {ids} still holds {box} after {bound}s"
                    " (--wait-window); no slot taken")
            return 1
        if now >= progress:
            errline(f"{SLOT_PREFIX} {box}: still waiting for measurement {ids}"
                    f" ({int(now - start)}s of {bound}s, --wait-window)")
            progress += WINDOW_PROGRESS
        time.sleep(min(poll, deadline - now))
        if time.monotonic() >= deadline:
            # The bound is the bound: no read after it, which over a remote anchor could run past
            # it by the transport's timeout and then admit the batch late.
            continue
        read = read_registry(cfg, box)
        if isinstance(read, Unread):
            # One failed read mid-wait is not the window's answer: said, and asked again until the
            # bound, when the refusal is the read's own.
            unread = read
            errline(f"{SLOT_PREFIX} {box}: the registry could not be read while waiting"
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
    if measuring and parsed.window_wait is not None and not marker_measure:
        waited = await_measurements(cfg, box, records, parsed.window_wait, command)
        if isinstance(waited, int):
            return waited
        records = waited
        measuring = outstanding_measurements(records, box, window_only=False)
        window = outstanding_measurements(records, box, window_only=True)
    elif measuring and parsed.window_wait is not None:
        errline(f"{SLOT_PREFIX} {box}: --wait-window does not wait inside a measurement's hold, where it would"
                " wait for its own measurement")
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
    take_slot(box, directory, cap, tokens, cpu, parsed.wait, inhibitor_path(cfg), command, parsed.deadline)


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
    hold(box, inhibitor_path(cfg), why, hold_lock, marker, cap, command, deadline)
