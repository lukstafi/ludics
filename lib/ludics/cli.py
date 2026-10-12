"""What every entry point shares: the streams, and how a command ends.

A command ends by RETURNING its exit status from its ``run``, or by raising ``Exit`` from any
depth -- the Python form of the shell's ``fail <rc> <message>``, which exits from inside whatever
function noticed. ``main_guard`` turns that into the message on stderr, prefixed with the script's
name the way the shell printed it, and the status.
"""

import io
import os
import signal
import sys
from collections.abc import Callable, MutableMapping
from typing import NoReturn

from ludics import proc


class Exit(Exception):
    """End the command with ``rc``; ``message`` (one line, may be empty) goes to stderr as
    ``<prog>: <message>``, or as given when ``raw`` (an already-prefixed block)."""

    def __init__(self, rc: int, message: str = "", *, raw: bool = False) -> None:
        super().__init__(message)
        self.rc = rc
        self.message = message
        self.raw = raw


def exit_with(rc: int, *parts: str) -> NoReturn:
    """The shell's ``fail rc a b c``: the parts joined with single spaces, as ``$*`` joins them."""
    raise Exit(rc, " ".join(parts))


def setup_streams() -> None:
    """UTF-8 out and err, LF line ends on every platform, and stdout flushed per line.

    LF: Python on Windows writes CRLF in text mode, which is exactly the bug a native jq.exe put
    into the shell (ludics-lite#335). Line buffering: the shell wrote each line as it went, and a
    caller reading stdout and stderr interleaved, or a run cut off by a timeout, sees the same.
    """
    for stream, buffered in ((sys.stdout, True), (sys.stderr, False)):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(
                encoding="utf-8", errors="surrogateescape", newline="\n", line_buffering=buffered
            )


def say(text: str) -> None:
    """One line (or several) to stdout, newline-terminated, as ``printf '%s\\n'``."""
    sys.stdout.write(text + "\n")


def emit(text: str) -> None:
    """The shell's ``[ -n "$out" ] && printf '%s\\n' "$out"``: nothing at all for empty output."""
    if text:
        say(text)


def note(prog: str, text: str) -> None:
    """A diagnostic line on stderr, ``<prog>: <text>``, ordered after any stdout already written."""
    sys.stdout.flush()
    sys.stderr.write(f"{prog}: {text}\n")
    sys.stderr.flush()


def main_guard(prog: str, run: Callable[[list[str]], int], argv: list[str]) -> int:
    """Run ``run(argv)``; an ``Exit`` from anywhere inside becomes its message and status. stdout is
    flushed before the status is returned, so a reader that went away is noticed here, where it
    ends the command as it ended the shell's ``printf`` (``die_of_sigpipe``)."""
    setup_streams()
    try:
        try:
            rc = run(argv)
        except Exit as end:
            if end.message:
                sys.stdout.flush()
                sys.stderr.write(end.message + "\n" if end.raw else f"{prog}: {end.message}\n")
                sys.stderr.flush()
            rc = end.rc
        sys.stdout.flush()
        return rc
    except BrokenPipeError:
        return die_of_sigpipe()


def die_of_sigpipe() -> int:
    """stdout's reader went away (``| head -1``): end as the shell's ``printf`` did, killed by
    SIGPIPE -- the caller's ``$?`` (or pipefail) reads 141, and nothing is printed. Python ignores
    SIGPIPE and raises BrokenPipeError instead, and would end in a traceback and exit 120 from its
    flush at shutdown; 1 would be worse, since this CLI says the API rejected a call with it. stdout
    is pointed at the null device first so no later flush can fail again. Where there is no
    SIGPIPE (Windows), the status is returned instead."""
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, sys.stdout.fileno())
    os.close(devnull)
    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGPIPE)
    return 128 + 13


# scripts/py's notes of the caller's PYTHONPATH and PYTHONCOERCECLOCALE: ``=<value>`` when it was
# set, empty when not.
CALLER_PYTHONPATH = "LUDICS_CALLER_PYTHONPATH"
# pr-review.sh's forward under Git Bash sets MSYS2_ARG_CONV_EXCL=* so that this interpreter's
# arguments arrive as typed, and notes the caller's own value here the same way.
CALLER_ARG_CONV_EXCL = "LUDICS_CALLER_ARG_CONV_EXCL"
CALLER_NOTES = {
    CALLER_PYTHONPATH: "PYTHONPATH",
    "LUDICS_CALLER_PYTHONCOERCECLOCALE": "PYTHONCOERCECLOCALE",
    CALLER_ARG_CONV_EXCL: "MSYS2_ARG_CONV_EXCL",
}


def restore_caller_environment(env: MutableMapping[str, str]) -> None:
    """Put back what scripts/py replaced: the PYTHONPATH it set to the checkout's lib/, and the
    PYTHONCOERCECLOCALE=0 it set for this interpreter's startup, so every program an entry point
    runs -- a batch under ``fleet-worker.sh execution slot``, a local far side, git's hooks, a
    fixture's gh -- sees the caller's environment, not the ``ludics`` package. This process's own
    path and locale were fixed at startup. A run not through scripts/py has no notes, and keeps
    what it has. Likewise MSYS2_ARG_CONV_EXCL, which pr-review.sh's forward set only for this
    interpreter's own start: an MSYS program this one runs (the bridge's bash) must rewrite its
    native children's arguments as the caller's shell would. And scripts/py's note of this
    interpreter's Git Bash pid, which is this process's alone (``proc.take_shell_pid``)."""
    proc.take_shell_pid(env)
    for note, name in CALLER_NOTES.items():
        saved = env.pop(note, None)
        if saved is None:
            continue
        if saved.startswith("="):
            env[name] = saved[1:]
        else:
            env.pop(name, None)


def main(prog: str, run: Callable[[list[str]], int]) -> int:
    """An entry point's ``main``: the caller's environment back, then ``run`` under ``main_guard``
    with this process's arguments."""
    restore_caller_environment(os.environ)
    return main_guard(prog, run, sys.argv[1:])
