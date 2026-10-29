"""Reaching a box: how the far-side shell scripts travel (fleet-worker.sh's ``run_on``, ``put_file``,
``prelude``).

fleet-worker.sh's FAR SIDE stays bash (``ludics.fleetworker.farside``), composed by the near side
and read by ``bash -s`` on the box -- a local child for this box (``is_local``), ``ssh <box> bash -s``
for any other -- with its arguments as positional parameters. Only the near side moved to Python
(ludics-lite#403), so every line a box runs is exactly what it ran, and the anchor's lease lock
(``take_lock``, a mkdir lock recording its holder's pid and start time) is still one implementation.

``prelude`` is what every far side starts with: the paths, BOX and its locality, the coordinator's
fleet configuration for any fleet-worker.sh the far side starts (``fleet_worker``, below), then the
shell's prelude helpers byte for byte. ``run`` starts a process with a script on its stdin and the far
side's stderr passed through, which ``ludics.proc.run_tool`` (captured streams, inherited stdin)
does not offer.
"""

import json
import os
import shlex
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ludics.fleetworker.config import REGISTRY_PIN, Config, anchor_name, registry_pin
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


# THE COORDINATOR'S FLEET CONFIGURATION ON THE FAR SIDE (ludics-lite#632). A fleet-worker.sh that a
# far side starts on a box -- `execution leg`'s slot or hold, `execution tip-run`'s `slot --bg` --
# reads its configuration from its environment, which on a remote box is that box's own (its
# ~/.config/fleet/env.sh, sourced by the ssh shell's ~/.bashrc, and the header's defaults). So
# every such start goes through the prelude's `fleet_worker`, which runs it under the
# coordinator's resolved value of each knob below: the facts every box must resolve alike.
#
# The boundary, a fail-closed allowlist: FORWARDED alone travels. Never forwarded, because each is
# the box's own: FLEET_LOCAL_BOX (its name), FLEET_SLOT_STATE (its slot locks, which every caller
# on the box must share, or two caps would count two lock sets), ISSUE_WAVE_STATE (its worker
# state; the far side's own paths already come from the prelude's STATE), FLEET_SYSTEMD_INHIBIT and
# FLEET_TMUX_SOCKET; nor the per-call bounds (FLEET_*_TIMEOUT, FLEET_*_WAIT, FLEET_SLOT_WINDOW_POLL)
# or the identity (FLEET_COORDINATOR: a far side's verbs read the registry, which needs none). Only
# a far side that starts fleet-worker.sh gets the knobs, and only for that process and what it
# starts: never the far shell itself, whose children include a launch's tmux server, which would
# keep them in its global environment for every later session (the hazard ludics-lite#327 names).
# Where the far side reaches a box by a hand-written ssh instead (no run_on), nothing travels:
# that is what `execution leg` is for.
#
# The registry's location is pinned too (config.REGISTRY_PIN): FLEET_ANCHOR travels as a fleet
# name, so a coordinator anchor of `local` becomes the coordinator's own box name, and with no name
# to give it the start is REFUSED on the far side, never run against the box's own state. The pin
# goes with the knobs, and any fleet-worker.sh under the started one checks it.
FORWARDED = (
    "FLEET_BOXES",
    "FLEET_HOSTNAME_MAP",
    "FLEET_ANCHOR",
    "FLEET_ANCHOR_STATE",
    "FLEET_LAB_HOST",
    "FLEET_BOX_CORRECTNESS_SLOTS",
    "FLEET_BOX_GPU_TOKENS",
    "FLEET_SKILLS_REPO",
)

# The far side's runner of a fleet-worker.sh: `fleet_worker <fleet-worker.sh> <verb> ...`, its
# configuration FLEET_FORWARD (the names above and the pin, as `env` assignments), or, when the
# coordinator's configuration cannot be given to this box, a refusal naming why (exit 2, as a
# usage refusal: the call cannot be made from here as configured).
FLEET_WORKER = r"""fleet_worker() {
  if [ -n "$FLEET_FORWARD_REFUSED" ]; then
    printf '%s\n' "fleet-worker.sh not started on $BOX: $FLEET_FORWARD_REFUSED" >&2
    return 2
  fi
  env "${FLEET_FORWARD[@]}" "$@"
}
"""


class Unforwardable(Exception):
    """The coordinator's configuration names something the box cannot resolve as it does."""


def fleet_box_of(cfg: Config, box: str, variable: str, value: str) -> str:
    """A box-valued knob for the far side: ``local`` is the coordinator's own box, by name."""
    if value != "local" or is_local(cfg, box):
        return value
    if cfg.local_box:
        return cfg.local_box
    raise Unforwardable(
        f"the coordinator's {variable} is local, and its own box has no fleet name to give {box}"
        " (set FLEET_LOCAL_BOX on the coordinator)"
    )


def forwarded(cfg: Config, box: str) -> list[tuple[str, str]]:
    """The coordinator's resolved value of each FORWARDED knob, then the registry pin, as the far
    side's fleet-worker.sh must read them. Values travel unexpanded: a ``$HOME/`` path is expanded
    where it is used (the anchor's state on the anchor), never on the box in between."""
    anchor = fleet_box_of(cfg, box, "FLEET_ANCHOR", cfg.anchor)
    values = {
        "FLEET_BOXES": cfg.boxes,
        "FLEET_HOSTNAME_MAP": cfg.hostname_map,
        "FLEET_ANCHOR": anchor,
        "FLEET_ANCHOR_STATE": cfg.anchor_state,
        "FLEET_LAB_HOST": fleet_box_of(cfg, box, "FLEET_LAB_HOST", cfg.lab_host),
        "FLEET_BOX_CORRECTNESS_SLOTS": cfg.slots,
        "FLEET_BOX_GPU_TOKENS": cfg.gpu_tokens,
        "FLEET_SKILLS_REPO": cfg.skills_repo,
    }
    pin = registry_pin(anchor if anchor != "local" else anchor_name(cfg), cfg.anchor_state)
    return [(name, values[name]) for name in FORWARDED] + [(REGISTRY_PIN, pin)]


def forward_text(cfg: Config, box: str) -> str:
    """The prelude's FLEET_FORWARD and FLEET_FORWARD_REFUSED, then ``fleet_worker``."""
    try:
        pairs = forwarded(cfg, box)
    except Unforwardable as why:
        return f"FLEET_FORWARD=()\nFLEET_FORWARD_REFUSED={shlex.quote(str(why))}\n" + FLEET_WORKER
    words = " ".join(shlex.quote(f"{name}={value}") for name, value in pairs)
    return f"FLEET_FORWARD=({words})\nFLEET_FORWARD_REFUSED=''\n" + FLEET_WORKER


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
        + forward_text(cfg, box)
        + HELPERS
    )


# A SHIPPED PROGRAM'S PAYLOAD (ludics-lite#636). The execution registry and the board store run on the
# anchor as Python reading its program from stdin (a here-document of the module's source), their
# small words -- state root, action, coordinator, token, roster, slots, endpoint map, names -- as
# argv. Their JSON payload does not ride argv: one argv word is capped (Linux's MAX_ARG_STRLEN,
# 128 KiB, for the local `bash -s` and for ssh's one remote command word alike), and a payload past
# it failed execve (exit 127) with nothing recorded. It travels inside the far-side script instead,
# which is the far shell's stdin and has no such cap, as a second here-document: the program's file
# descriptor 3, holding ONE line, the payload as a JSON string (ASCII-escaped, so no line of it can
# be the delimiter, it starts with `"`, and no byte of it is ever a shell word). The program's argv
# says so with the payload word PAYLOAD_ON_FD, which no JSON payload can be; the program reads fd 3
# to its end, decodes the one string, and closes it (registry.py's and boardstore.py's
# ``payload_word``). Any other payload word is the payload itself, as a direct ``python registry.py``
# call and the in-process suites pass it.
PAYLOAD_ON_FD = "-"


def shipped_python(find_python: str, source: str, tag: str, payload: str) -> str:
    """The far side's last lines: ``source`` run as a program from stdin by the ``$py`` that
    ``find_python`` sets, ``"$ANCHOR_STATE" "$@"`` its argv (the payload word PAYLOAD_ON_FD among
    them), ``payload`` on its fd 3 (the contract above). ``tag`` delimits the source; ``tag_PAYLOAD``
    the payload."""
    return (
        find_python
        + f"\"$py\" -X utf8 -P - \"$ANCHOR_STATE\" \"$@\" 3<<'{tag}_PAYLOAD' <<'{tag}'\n"
        + json.dumps(payload)
        + f"\n{tag}_PAYLOAD\n"
        + source
        + f"\n{tag}\n"
    )


# THE CARRIED BG-RUN.SH. A far side that reads a bg-run directory runs the coordinator's own
# bg-run.sh -- the one beside this fleet-worker.sh -- never the far box's skills checkout's copy, so
# every run's `wait` line is printed by the version whose grammar ludics.bgrun reads, however far
# that box's checkout lags or leads (ludics#826's one parser). The source travels inside the far-side
# script, the far shell's stdin, as a here-document: a script opens it with ``<<'BG_RUN_TAG'``
# (quoted, so nothing in it is expanded) and ``carried_bg_run`` is its body and closing line. Its
# readers: ``conclude --from-bg-run`` and ``tip-run --wait`` (each `bash -s` of it once) and
# ``board takeover`` (it writes it to a scratch file, once, for its loop over the runs).
BG_RUN_TAG = "FLEET_BG_RUN_SH"


def bg_run_path(cfg: Config) -> str:
    """The coordinator's bg-run.sh: the one beside this fleet-worker.sh."""
    return os.path.join(cfg.here, "bg-run.sh")


def carried_bg_run(path: str) -> str:
    """bg-run.sh at ``path`` (``bg_run_path``'s, but for a suite) as a here-document's body and
    closing ``BG_RUN_TAG`` line. Raises OSError when it cannot be read; each caller says so in its
    own words."""
    with open(path, encoding="utf-8", errors="surrogateescape") as f:
        source = f.read()
    return source + ("" if source.endswith("\n") else "\n") + BG_RUN_TAG + "\n"


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

