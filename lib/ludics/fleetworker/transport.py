"""Reaching a box: how the far-side shell scripts travel (fleet-worker.sh's ``run_on``, ``put_file``,
``prelude``).

fleet-worker.sh's FAR SIDE stays bash (``ludics.fleetworker.farside``), composed by the near side
and read by ``bash -s`` on the box -- a local child for this box (``is_local``), ``ssh <box> bash -s``
for any other -- with its arguments as positional parameters. Only the near side moved to Python
(ludics-lite#403), so every line a box runs is exactly what it ran, and the anchor's lease lock
(``take_lock``, a mkdir lock recording its holder's pid and start time) is still one implementation.

``prelude`` is what every far side starts with: the paths, BOX and its locality, then the shell's
prelude helpers byte for byte. ``run`` starts a process with a script on its stdin and the far
side's stderr passed through, which ``ludics.proc.run_tool`` (captured streams, inherited stdin)
does not offer.
"""

import shlex
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ludics.fleetworker.config import Config
from ludics.fleetworker.farside import HELPERS

SSH_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
]  # fmt: skip

# ssh's own transport failure; a local child cannot produce it, so it always means the box never
# answered and the caller may retry rather than conclude anything.
UNREACHABLE = 255


@dataclass(frozen=True)
class Done:
    """A finished far-side run: its status, and its stdout when it was captured (else empty)."""

    rc: int
    out: str

    @property
    def unreachable(self) -> bool:
        return self.rc == UNREACHABLE


def is_local(cfg: Config, box: str) -> bool:
    return box == "local" or (cfg.local_box != "" and box == cfg.local_box)


def fleet_name(cfg: Config, box: str) -> str:
    """A configured box as a fleet name: ``local`` is this box's own name, when it has one."""
    return cfg.local_box if box == "local" and cfg.local_box else box


def emit_var(name: str, value: str) -> str:
    """A far-side assignment: a leading literal ``$HOME/`` stays expandable there, the rest quoted."""
    if value.startswith("$HOME/"):
        return f'{name}="$HOME"/{shlex.quote(value[len("$HOME/") :])}\n'
    return f"{name}={shlex.quote(value)}\n"


def prelude(cfg: Config, box: str) -> str:
    """What every far-side script here starts with: BOX is the name the coordinator addressed the
    box by, so every line it prints is greppable by that name."""
    return (
        emit_var("STATE", cfg.state)
        + emit_var("SKILLS_REPO", cfg.skills_repo)
        + emit_var("ANCHOR_STATE", cfg.anchor_state)
        + f"TMUX_SOCKET={shlex.quote(cfg.tmux_socket)}\n"
        + f"BOX={shlex.quote(box)}\n"
        + f"FEEDER_WAIT={shlex.quote(cfg.feeder_wait)}\n"
        + f"BOX_IS_LOCAL={1 if is_local(cfg, box) else 0}\n"
        + HELPERS
    )


def run(
    argv: Sequence[str],
    *,
    stdin: bytes | None = None,
    capture: bool = False,
    stdout_to_stderr: bool = False,
    stderr_null: bool = False,
    env: Mapping[str, str] | None = None,
) -> Done:
    """Start ``argv``; stderr is the caller's (or the null device: ``2>/dev/null``). stdin is
    ``stdin`` when given (else inherited), stdout captured, sent to our stderr (the shell's ``>&2``),
    or the caller's. A program that cannot be started completes 127, as the shell's would."""
    sys.stdout.flush()
    sys.stderr.flush()
    out = subprocess.PIPE if capture else (sys.stderr.fileno() if stdout_to_stderr else None)
    try:
        proc = subprocess.run(
            list(argv),
            input=stdin,
            stdout=out,
            stderr=subprocess.DEVNULL if stderr_null else None,
            env=None if env is None else dict(env),
            check=False,
        )
    except OSError as exc:
        if not stderr_null:
            sys.stderr.write(f"{argv[0]}: {exc.strerror}\n")
        return Done(127, "")
    text = proc.stdout.decode("utf-8", "surrogateescape") if capture else ""
    return Done(proc.returncode, text)


def run_on(
    cfg: Config, box: str, script: str, args: Sequence[str], *, capture: bool = False, stdout_to_stderr: bool = False
) -> Done:
    """Run ``script`` (on stdin) on the box, ``args`` as its $1..: a local ``bash -s`` here, ``bash -s``
    over ssh for any other box, its arguments quoted for the remote login shell (bash on every box)."""
    argv = far_argv(cfg, box, args)
    return run(argv, stdin=script.encode("utf-8", "surrogateescape"), capture=capture, stdout_to_stderr=stdout_to_stderr)


def far_argv(cfg: Config, box: str, args: Sequence[str]) -> list[str]:
    """The command that reads a far-side script on stdin on the box (``run_on``'s)."""
    if is_local(cfg, box):
        return [_bash(), "-s", "--", *args]
    quoted = "".join(" " + shlex.quote(a) for a in args)
    return [_ssh(), *SSH_OPTS, box, "bash -s --" + quoted]


def _bash() -> str:
    return shutil.which("bash") or "/bin/bash"


def _ssh() -> str:
    return shutil.which("ssh") or "ssh"


# The writer of a file on the box: its bytes are stdin, so nothing in it is ever a shell word anywhere.
_PUT = 'mkdir -p "$(dirname "$1")" && cat > "$1"'


def put_file(cfg: Config, box: str, src: str, dst: str) -> Done:
    """Copy a local file to a path on the box, its parent created (fleet-worker.sh's ``put_file``).
    The destination travels as ONE quoted word ($HOME kept expandable, the rest quoted), never
    interpolated into the command text where a quote or $() in a configured path would run."""
    try:
        with open(src, "rb") as f:
            data = f.read()
    except OSError as exc:
        sys.stderr.write(f"{src}: {exc.strerror}\n")
        return Done(1, "")
    if is_local(cfg, box):
        return run([_bash(), "-c", _PUT, "--", cfg.path(dst)], stdin=data)
    if dst.startswith("$HOME/"):
        word = '"$HOME"/' + shlex.quote(dst[len("$HOME/") :])
    else:
        word = shlex.quote(dst)
    return run([_ssh(), *SSH_OPTS, box, f"bash -c '{_PUT}' -- {word}"], stdin=data)


def err(text: str) -> None:
    """A line on stderr as the shell's ``echo ... >&2`` wrote it: no prefix, after any stdout."""
    sys.stdout.flush()
    sys.stderr.write(text + "\n")
    sys.stderr.flush()


def substitution(text: str) -> str:
    """What the shell's ``$(...)`` keeps of a command's output: every trailing newline dropped."""
    return text.rstrip("\n")

