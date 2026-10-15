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
  and the wrapper exits 124, naming the bound. The bound is the wrapper's own wait for the
  leader's exit (a pidfd on Linux, a kqueue on macOS), not a timer: no SIGALRM, so an alarm, a
  mask or a disposition the caller set on it stays the caller's. A command that exits first leaves the group
  behind only if something it started is still running: with a deadline that remainder is ended
  the same way at once (the bound is on the tree, and a tree whose top has ended has nothing
  left to wait for); without one it runs on, holding the slot's flock and the sleep guard's pipe
  as it always did.
- THE SIGNALLED WRAPPER: SIGTERM, SIGINT, SIGHUP or SIGALRM to the wrapper (a harness stopping a
  task, a Ctrl-C at the terminal, a hand-rolled alarm around the wrapper) ends the group the same
  way, and the wrapper then dies of that signal, so its caller reads the status it read when the
  command itself was the pid it signalled. A signal the caller left IGNORED is left ignored, and
  so inherited by the command, as across the exec before. One signal arriving while the wrapper
  ends the group for another reason makes the wrapper die of it once the group is gone.
- THE GUARDIAN: a wrapper killed outright (SIGKILL, which nothing catches) cannot end anything,
  so a helper in a session of its own holds the read end of a pipe only the wrapper can write.
  It is started, and has said it is up, before the command is: a guardian that cannot start
  refuses the run with nothing started. The wrapper writes the group's id once the command runs
  and ``D`` (done) before it ends normally; EOF after the id without ``D`` means the wrapper died,
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
finds none, where it found the caller's before. An ignored SIGCHLD is the one disposition not
passed through (``default_sigchld``). A wrapper killed in the instant between starting the command
and telling its guardian the group's id leaves that group to run on.

POSIX only, like the flock it runs beside.
"""

import os
import select
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


def default_sigchld() -> Callable[[int, FrameType | None], object] | int | None:
    """Put SIGCHLD back to its default when the caller left it ignored, and return what it was.

    Under an ignored SIGCHLD the kernel reaps every child at once, so no wait -- this wrapper's for
    its helpers or for the command's status -- can read one: the command would read as exit 0, or
    the helpers' waits fail outright. The command inherits the default with it, the one disposition
    the wrapper does not pass through (POSIX leaves an ignored SIGCHLD's inheritance across exec
    unspecified, and under it the command's own waits fail the same way)."""
    previous = signal.getsignal(signal.SIGCHLD)
    if previous == signal.SIG_IGN:
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    return previous


def start_guardian(label: str) -> int:
    """The guardian, double-forked into a session of its own; returns the write end of its pipe,
    which only this process holds. The wrapper writes the group's id and a newline once the
    command has started, and ``D`` when it ends normally. Raises OSError when the guardian did not
    come up, before anything has been started."""
    to_guardian, from_wrapper = os.pipe()  # close-on-exec, both: no command inherits either
    ready_r, ready_w = os.pipe()
    sys.stdout.flush()
    sys.stderr.flush()  # nothing buffered may be written twice by a fork
    try:
        middle = os.fork()
    except OSError:
        for descriptor in (to_guardian, from_wrapper, ready_r, ready_w):
            os.close(descriptor)
        raise
    if middle == 0:
        try:
            for signum in FORWARDED:
                signal.signal(signum, signal.SIG_DFL)
            os.setsid()
            if os.fork() == 0:
                os.dup2(to_guardian, 0)
                devnull = os.open(os.devnull, os.O_WRONLY)
                os.dup2(devnull, 1)
                os.write(ready_w, b"R")
                os.closerange(3, 65536)  # the slot flock, the guard's pipe, the write end: all of it
                said = b""
                while b"D" not in said:
                    chunk = os.read(0, 64)
                    if not chunk:
                        break
                    said += chunk
                line, newline, _ = said.partition(b"\n")
                if b"D" not in said and newline and line.isdigit() and group_alive(int(line)):
                    _signal_group(int(line), signal.SIGKILL)
                    note = (f"{label}: the wrapper died without ending its command; its guardian killed"
                            f" process group {int(line)}\n")
                    try:
                        os.write(2, note.encode("utf-8", "surrogateescape"))
                    except OSError:
                        pass
        finally:
            os._exit(0)
    os.close(to_guardian)
    os.close(ready_w)
    try:
        os.waitpid(middle, 0)
        ready = os.read(ready_r, 1)
    finally:
        os.close(ready_r)
    if ready != b"R":
        os.close(from_wrapper)
        raise OSError("the guardian that ends the command's group if this wrapper is killed did not start")
    return from_wrapper


def _tell(guardian: int, data: bytes) -> None:
    try:
        os.write(guardian, data)
    except OSError:
        pass


def _await_exit(pid: int, timeout: float) -> None:
    """Block until the child ``pid`` ends or ``timeout`` seconds pass, reaping nothing. No timer and
    no signal: the deadline is this wait's own bound, so a SIGALRM stays the caller's."""
    if sys.platform == "linux":
        try:
            descriptor = os.pidfd_open(pid)
        except OSError:  # a kernel before 5.3
            time.sleep(min(timeout, 0.1))
            return
        try:
            select.select([descriptor], [], [], timeout)
        finally:
            os.close(descriptor)
    elif sys.platform == "darwin":
        queue = select.kqueue()
        try:
            event = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                                  flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
            try:
                queue.control([event], 1, timeout)
            except ProcessLookupError:  # ended before the registration
                pass
        finally:
            queue.close()
    else:
        time.sleep(min(timeout, 0.1))


def run(command: Sequence[str], deadline: int | None, label: str,
        say: Callable[[str], None], grace: float = GRACE,
        started: Callable[[int], None] | None = None) -> Outcome:
    """Run ``command`` as a session leader, wait for it under the deadline and the forwarded
    signals, and say (through ``say``, prefixed with ``label``) whenever this wrapper ended the
    group. ``started`` is told the group's id once the command runs (a measurement's hold leaves
    that group out of its GPU co-tenants, ``cotenants.py``). Raises OSError when the command cannot
    be started (nothing is left running then)."""
    received: list[int] = []  # every forwarded signal taken, in order
    armed = [False]  # whether the handler raises (only while the leader is waited for)

    def handler(signum: int, frame: FrameType | None) -> None:
        received.append(signum)
        if armed[0]:
            armed[0] = False
            raise _Stop(signum)

    # Installed before the fork, so no signal in between is lost. A signal the caller ignores is
    # left ignored, so the command inherits that, as across the exec before.
    previous: dict[int, Callable[[int, FrameType | None], object] | int | None] = {}
    for signum in FORWARDED:
        if signal.getsignal(signum) != signal.SIG_IGN:
            previous[signum] = signal.signal(signum, handler)
    previous[signal.SIGCHLD] = default_sigchld()
    try:
        guardian = start_guardian(label)
    except BaseException:
        for signum, old in previous.items():
            signal.signal(signum, old)
        raise
    try:
        try:
            # restore_signals puts back SIGPIPE and SIGXFSZ, which Python ignores and an exec
            # would otherwise pass on: `yes | head -n1` must die of SIGPIPE under the wrapper.
            leader = subprocess.Popen(list(command), close_fds=False, start_new_session=True, restore_signals=True)
        except BaseException:
            _tell(guardian, b"D")
            raise
        pgid = leader.pid
        _tell(guardian, b"%d\n" % pgid)
        if started is not None:
            started(pgid)
        until = time.monotonic() + deadline if deadline else None
        outcome: Outcome | None = None
        try:
            armed[0] = True
            if received:
                armed[0] = False
                raise _Stop(received[0])
            while leader.poll() is None:
                if until is None:
                    leader.wait()
                elif time.monotonic() >= until:
                    armed[0] = False
                    say(f"{label}: --deadline {deadline}s reached: ending the command's process group {pgid}"
                        f" (SIGTERM, then SIGKILL after {grace:g}s)")
                    outcome = Expired()
                    end_group(pgid, grace, leader)
                    break
                else:
                    _await_exit(pgid, until - time.monotonic())
            armed[0] = False
        except _Stop as stop:
            armed[0] = False
            say(f"{label}: {signal.Signals(stop.signum).name} received: ending the command's process group {pgid}"
                f" (SIGTERM, then SIGKILL after {grace:g}s)")
            outcome = Interrupted(stop.signum)
            end_group(pgid, grace, leader)
        if outcome is None:
            code = leader.wait()  # reaped already: its status
            outcome = Killed(-code) if code < 0 else Exited(code)
            if deadline and group_alive(pgid):
                say(f"{label}: the command ended, and its process group {pgid} still runs: ending it (--deadline)")
                end_group(pgid, grace, None)
        # Every signal the handler took while armed ended the wait above, so one recorded beyond
        # that came while the group was being ended. The wrapper was signalled all the same, and
        # dies of it.
        if received and not isinstance(outcome, Interrupted):
            outcome = Interrupted(received[0])
        _tell(guardian, b"D")
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
