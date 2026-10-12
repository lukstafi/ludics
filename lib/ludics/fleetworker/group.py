"""The command of an ``execution slot`` or ``execution hold`` as the leader of a process group of its
own, and the end of that group (ludics-lite#566).

Until #566 the wrapper exec'd the command on its own pid, so nothing outlived the command but its
descendants, and nothing could bound those: a hand-rolled ``perl -e 'alarm N; exec ...'`` killed
one process, and in the #1192 worker's exclusive window the driver script it killed left its
benchmark child running orphaned on the GPU for half an hour past the hold that was meant to
contain it. So the wrapper now starts the command in a NEW SESSION (``setsid``: a process group
of its own, and no controlling terminal, so a command reading the terminal is not stopped as a
background group) and stays as its parent:

- THE DEADLINE (``--deadline <seconds>``): when it passes, the whole group gets SIGTERM, then
  SIGKILL once the leader and the rest of the group are gone or ``GRACE`` seconds have passed,
  and the wrapper exits 124, naming the bound. A command that exits first leaves the group
  behind only if something it started is still running: with a deadline that remainder is ended
  the same way at once (the bound is on the tree, and a tree whose top has ended has nothing
  left to wait for); without one it runs on, holding the slot's flock and the sleep guard's pipe
  as it always did.
- THE SIGNALLED WRAPPER: SIGTERM, SIGINT, SIGHUP or SIGALRM to the wrapper (a harness stopping a
  task, a Ctrl-C at the terminal, a hand-rolled alarm around the wrapper) ends the group the same
  way, and the wrapper then dies of that signal, so its caller reads the status it read when the
  command itself was the pid it signalled. A signal the caller left IGNORED is left ignored, and
  so inherited by the command, as across the exec before.
- THE GUARDIAN: a wrapper killed outright (SIGKILL, which nothing catches) cannot end anything,
  so a helper in a session of its own holds the read end of a pipe only the wrapper can write.
  The wrapper writes ``D`` (done) before it ends normally; EOF without it means the wrapper died,
  and the guardian sends SIGKILL to the group at once, which is what a ``kill -9`` of the pid did
  when the pid was the command. Being in its own session, no group kill aimed at the wrapper's
  caller reaches it. It holds no descriptor of the wrapper's but that pipe and stderr, so it
  keeps no slot and no sleep guard alive.
- Everything else is the command's own: its exit status is the wrapper's, and a command that
  dies of a signal makes the wrapper die of the same one.

The boundary: the group is what ``killpg`` reaches. A process that leaves it -- a daemon that
calls ``setsid`` itself, a ``bg-run.sh spawn`` run, an ssh session's far side -- is not the
command's to end. A group whose last member exits within the grace, and whose id the system
then hands to a NEW group in that same instant, would receive the escalation: that needs the
pid space to wrap around within a grace, which this module does not guard against. And the
command has no controlling terminal: a program that opens ``/dev/tty`` (a password prompt)
finds none, where it found the caller's before.

POSIX only, like the flock it runs beside.
"""

import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from types import FrameType
from typing import NoReturn

GRACE = 10  # seconds between the SIGTERM to a group and its SIGKILL
FORWARDED = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)


@dataclass(frozen=True)
class Exited:
    """The command ended by itself with this status."""

    code: int


@dataclass(frozen=True)
class Killed:
    """The command died of this signal, sent by anyone but this wrapper."""

    signum: int


@dataclass(frozen=True)
class Expired:
    """The deadline passed, and the group was ended."""


@dataclass(frozen=True)
class Interrupted:
    """The wrapper itself received this signal, and the group was ended."""

    signum: int


type Outcome = Exited | Killed | Expired | Interrupted


class _Stop(Exception):
    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


def group_alive(pgid: int) -> bool:
    """Whether any process is left in the group. A member this user may not signal (it changed its
    credentials) still counts."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _signal_group(pgid: int, signum: int) -> None:
    try:
        os.killpg(pgid, signum)
    except (ProcessLookupError, PermissionError):
        pass


def end_group(pgid: int, grace: float, leader: "subprocess.Popen[bytes] | None") -> None:
    """SIGTERM to the group; SIGKILL to whatever of it is left once the leader and the rest are
    gone, or ``grace`` seconds have passed; then the leader reaped."""
    _signal_group(pgid, signal.SIGTERM)
    until = time.monotonic() + grace
    if leader is not None:
        try:
            leader.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
    while group_alive(pgid) and time.monotonic() < until:
        time.sleep(0.05)
    if group_alive(pgid):
        _signal_group(pgid, signal.SIGKILL)
    if leader is not None:
        leader.wait()


def start_guardian(pgid: int, note: str) -> int:
    """The guardian of ``pgid``, double-forked into a session of its own; returns the write end of
    its pipe, which only this process holds."""
    read_end, write_end = os.pipe()  # both close-on-exec: no command inherits either
    sys.stdout.flush()
    sys.stderr.flush()  # nothing buffered may be written twice by a fork
    middle = os.fork()
    if middle == 0:
        try:
            for signum in FORWARDED:
                signal.signal(signum, signal.SIG_DFL)
            os.setsid()
            if os.fork() == 0:
                os.dup2(read_end, 0)
                devnull = os.open(os.devnull, os.O_WRONLY)
                os.dup2(devnull, 1)
                os.closerange(3, 65536)  # the slot flock, the guard's pipe, the write end: all of it
                if os.read(0, 1) == b"" and group_alive(pgid):
                    _signal_group(pgid, signal.SIGKILL)
                    try:
                        os.write(2, (note + "\n").encode("utf-8", "surrogateescape"))
                    except OSError:
                        pass
        finally:
            os._exit(0)
    os.waitpid(middle, 0)
    os.close(read_end)
    return write_end


def _done(guardian: int) -> None:
    try:
        os.write(guardian, b"D")
    except OSError:
        pass


def run(command: Sequence[str], deadline: int | None, label: str,
        say: Callable[[str], None], grace: float = GRACE) -> Outcome:
    """Run ``command`` as a session leader, wait for it under the deadline and the forwarded
    signals, and say (through ``say``, prefixed with ``label``) whenever this wrapper ended the
    group. Raises OSError when the command cannot be started (nothing is left running then)."""
    received: list[int] = []  # every forwarded signal acted on, in order
    armed = [False]  # whether the handler raises (only while the leader is waited for)
    expires = [0.0]  # when this wrapper's own deadline alarm is due; 0 while none is set
    # A SIGALRM the caller ignores stays ignored, as it was across the exec before: the handler is
    # installed for the deadline's own alarm and acts on no other.
    alarm_ignored = signal.getsignal(signal.SIGALRM) == signal.SIG_IGN

    def due() -> bool:
        return expires[0] > 0 and time.monotonic() >= expires[0] - 0.05

    def handler(signum: int, frame: FrameType | None) -> None:
        if signum == signal.SIGALRM and alarm_ignored and not due():
            return
        received.append(signum)
        if armed[0]:
            armed[0] = False
            raise _Stop(signum)

    # Installed before the fork, so no signal in between is lost; a signal the caller ignores is
    # left ignored (the command inherits that), except the deadline's own SIGALRM.
    previous: dict[int, Callable[[int, FrameType | None], object] | int | None] = {}
    for signum in FORWARDED:
        if signal.getsignal(signum) == signal.SIG_IGN and not (signum == signal.SIGALRM and deadline):
            continue
        previous[signum] = signal.signal(signum, handler)
    try:
        # restore_signals puts back SIGPIPE and SIGXFSZ, which Python ignores and an exec would
        # otherwise pass on: `yes | head -n1` must die of SIGPIPE under the wrapper as without it.
        leader = subprocess.Popen(list(command), close_fds=False, start_new_session=True, restore_signals=True)
    except BaseException:
        for signum, old in previous.items():
            signal.signal(signum, old)
        raise
    pgid = leader.pid
    guardian = start_guardian(
        pgid, f"{label}: the wrapper died without ending its command; its guardian killed process group {pgid}"
    )
    # An alarm the caller armed before exec'ing this wrapper (a hand-rolled `perl -e 'alarm N;
    # exec ...'`) survives the exec, and is the earlier bound when it comes first: kept, it reads
    # as the signal it is. An ignored one bounds nothing, and the deadline replaces it.
    inherited = signal.getitimer(signal.ITIMER_REAL)[0]
    timed = bool(deadline) and (alarm_ignored or not 0 < inherited <= float(deadline or 0))
    outcome: Outcome | None = None
    try:
        try:
            if timed:
                expires[0] = time.monotonic() + float(deadline or 0)
                signal.setitimer(signal.ITIMER_REAL, float(deadline or 0))
            armed[0] = True
            if received:
                armed[0] = False
                raise _Stop(received[0])
            leader.wait()
            armed[0] = False
        except _Stop as stop:
            armed[0] = False
            if stop.signum == signal.SIGALRM and due():
                say(f"{label}: --deadline {deadline}s reached: ending the command's process group {pgid}"
                    f" (SIGTERM, then SIGKILL after {grace:g}s)")
                outcome = Expired()
            else:
                say(f"{label}: {signal.Signals(stop.signum).name} received: ending the command's process group {pgid}"
                    f" (SIGTERM, then SIGKILL after {grace:g}s)")
                outcome = Interrupted(stop.signum)
            if timed:
                signal.setitimer(signal.ITIMER_REAL, 0)
            expires[0] = 0.0
            end_group(pgid, grace, leader)
        if timed:
            signal.setitimer(signal.ITIMER_REAL, 0)
        expires[0] = 0.0
        if outcome is None:
            code = leader.wait()  # reaped already: its status
            outcome = Killed(-code) if code < 0 else Exited(code)
            if deadline and group_alive(pgid):
                say(f"{label}: the command ended, and its process group {pgid} still runs: ending it (--deadline)")
                end_group(pgid, grace, None)
            # Every signal the handler took while armed ended the wait above, so one recorded now
            # came after the command ended -- during that cleanup, say. The wrapper was signalled
            # all the same, and dies of it.
            if received:
                outcome = Interrupted(received[0])
        _done(guardian)
        return outcome
    finally:
        os.close(guardian)
        for signum, old in previous.items():
            signal.signal(signum, old)


def die_of(signum: int) -> NoReturn:
    """End this process by ``signum``, as the command it ran ended (or as the signal it received
    would have ended it), with no core file of the interpreter's own."""
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ImportError, OSError, ValueError):
        pass
    signal.signal(signum, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, [signum])
    os.kill(os.getpid(), signum)
    os._exit(128 + signum)  # a signal that does not end a process (SIGCHLD, SIGWINCH) ends it here
