"""Readiness check for enabling a fleet merge lease.

READINESS BOUNDARY. Reads each target box's served ship-pr parser with a fixed synthetic
``lease fleet`` config, stats only the configured state directory on the anchor reached by that
box, and takes one bounded, read-only process snapshot (``LC_ALL=C ps -Aww -o pid=,stat=,args=``)
on each reachable box. ``FLEET_CROSS_TIMEOUT`` (positive whole seconds, default 20) bounds the
inner anchor probe and the process probe; twice that value bounds the outer reader probe. The
reader wire allowlist is one JSON record containing an anchor reply, itself one JSON
host/path/device/inode record. The repository argument labels the report. This reads no
repository config, PR, registry, process environment or lease records, runs no build, tests no
writes, and acquires nothing.

RECOGNIZED MERGE PROCESSES (closed allowlist) AND SNAPSHOT LIMIT. The process parser requires
well-formed ``pid stat [args]`` rows with recognized POSIX/BSD/Linux state tokens and at least
one live (non-``Z*``/``X*``) row carrying readable arguments (fail-closed on empty, missing-state,
argumentless, or malformed listings), skips zombie/dead states (``Z*``, ``X*``), and splits the
``args`` column on ASCII whitespace. After optionally peeling one leading ``env`` wrapper
(``-i``, ``-0``, ``-S``, ``-``, ``-u``, ``-C``, ``--``, and ``NAME=VALUE`` assignments), an argv
is recognized as an in-flight ship-pr merge iff it matches one of three forms:
  1. ``[shell [non--c/-s flags]] <.../pr-review.sh> [--repo <v>|--repo=<v>] merge ...``
  2. ``[shell [non--c/-s flags]] <.../scripts/py> [python flags] -m ludics.prreview [--repo <v>|--repo=<v>] merge ...``
  3. ``<.../python[3[.N]]|.../Python[3[.N]]> [python flags] -m ludics.prreview [--repo <v>|--repo=<v>] merge ...``
Reported commands omit any peeled leading ``env`` wrapper so inline environment assignments are
never copied into preflight output. All matching ship-pr merge processes on every checked box are
reported and refuse readiness regardless of ``<owner/repo>``, because ``pr-review.sh --repo <repo> merge <n>``
and ``REPO=`` remove the repository from the exec'd Python argv. Deliberately unread: shell command
strings (``sh -c``, ``bash -c``, ``python -c``), wrappers that do not exec into one of the three
forms, renamed scripts/interpreters, paths or values containing whitespace before ``merge`` across
``ps``'s unquoted spacing, process environments, unexamined hosts, web/API merges, direct pushes,
and merges started after each box's snapshot.
"""

import json
import os
import re
import shlex
from collections.abc import Sequence
from dataclasses import dataclass

from ludics import cli, proc
from ludics.fleetworker.config import Config, load_config, roster_words
from ludics.fleetworker.farside import FLEET_PYTHON
from ludics.fleetworker.preflight import knob
from ludics.fleetworker.transport import UNREACHABLE, far_argv, fleet_name
from ludics.prreview.core import die, fail, parse_ref
from ludics.prreview.mergebuild import fleet_worker_path

_BOX = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_POSITIVE_INT = re.compile(r"[1-9][0-9]*")

_ENV_ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
_ENV_SINGLE_FLAGS = frozenset({"-i", "-0", "-S", "-"})
_ENV_VALUE_FLAGS = frozenset({"-u", "-C"})
_ENV_VALUE_PREFIXES = ("-u", "-C")
_SHELLS = frozenset({"sh", "bash", "dash", "zsh"})
_SHELL_FLAGS = frozenset("abefhklmnptuvxBEHPT")
_SHELL_VALUE_FLAGS = frozenset({"-o", "+o"})
_PYTHON_BIN = re.compile(r"[Pp]ython(?:3(?:\.[0-9]+)?)?")
_PYTHON_FLAGS = frozenset("bBdEiIOPqSsuv")
_PYTHON_VALUE_FLAGS = frozenset({"-X", "-W", "--check-hash-based-pycs"})
_PYTHON_VALUE_PREFIXES = ("-X", "-W", "--check-hash-based-pycs=")
_REPO_FLAG = "--repo"
_REPO_PREFIX = "--repo="
_MODULE_FLAG = "-m"
_PRREVIEW_MODULE = "ludics.prreview"
_PS_LINE = re.compile(r"^\s*([0-9]+)\s+(\S+)(?:\s+(.*))?$")
# POSIX/BSD/Linux state codes, including Linux `P` (parked) and BSD/macOS transient `?` (`?`, `?+`, `?E`).
_PS_STAT = re.compile(r"[DIPRSTUZtWX?][+<>AELNSVWXls]*")
_PROCESS_PROBE = b"LC_ALL=C ps -Aww -o pid=,stat=,args=\n"

SNAPSHOT_LIMIT = (
    "Snapshot limit: point-in-time read of visible POSIX process argvs on the checked boxes; "
    "does not cover merges started after each box's probe, unexamined hosts, web/API merges, "
    "or unrecognized wrappers/command lines."
)

_ANCHOR = FLEET_PYTHON + """\
# A local anchor runs from the merge's worktree, and SSH normally starts in its home.
case "$ANCHOR_STATE" in /*) ;; *) exit 3 ;; esac
py=$(fleet_python) || exit 1
CDPATH= cd -P -- "$ANCHOR_STATE" || exit 1
exec "$py" -B -X utf8 -P - <<'ANCHOR_PY'
import json
import os
import socket

directory = os.stat(".")
print(json.dumps([socket.gethostname(), os.getcwd(), directory.st_dev, directory.st_ino]))
ANCHOR_PY
"""

# Import the merging box's current reader. Shipping our own parser would make an older box
# appear ready, and requiring a new probe verb there would reject a compatible older reader.
_READER = """\
root=$(CDPATH= cd -P "$HOME/.claude/skills/ship-pr/scripts" && cd -P ../.. && pwd -P) || exit 1
test -x "$root/ship-pr/scripts/pr-review.sh" || exit 1
exec "$root/scripts/py" - "$root" "$@" <<'READER_PY'
import json
import os
import re
import sys

from ludics import cli, proc
from ludics.fleetworker.config import anchor_name, load_config, pin_refusal
from ludics.fleetworker.transport import emit_var, far_argv
from ludics.prreview.mergebuild import parse_config

cli.restore_caller_environment(os.environ)
fixture = parse_config("command true\\ntrigger always\\nlease fleet\\n", "lease preflight fixture")
accepted = fixture is not None and getattr(fixture, "fleet_lease", False) is True
cfg = load_config(os.path.join(sys.argv[1], "issue-wave", "scripts", "fleet-worker.sh"), os.environ)
endpoint = anchor_name(cfg)
anchor_timeout = int(sys.argv[4])
if pin_refusal(cfg):
    print(json.dumps([accepted, endpoint, 2, ""]))
elif not all(re.fullmatch(sys.argv[3], name) for name in (cfg.anchor, endpoint)):
    print(json.dumps([accepted, endpoint, 4, ""]))
else:
    argv = far_argv(cfg, cfg.anchor, [])
    script = emit_var("ANCHOR_STATE", cfg.anchor_state) + sys.argv[2]
    try:
        done = proc.run_tool(argv[0], argv[1:], stdin=script.encode(), timeout=anchor_timeout)
    except OSError:
        print(json.dumps([accepted, endpoint, 255, ""]))
    else:
        print(json.dumps([accepted, endpoint, done.rc, done.stdout]))
READER_PY
""".encode()


@dataclass(frozen=True)
class Anchor:
    endpoint: str
    host: str
    device: int
    inode: int


@dataclass(frozen=True)
class MergeProcess:
    pid: int
    command: str


@dataclass(frozen=True)
class ReaderProbe:
    reachable: bool
    report: str
    anchor: Anchor | None


@dataclass(frozen=True)
class MergeScan:
    ok: bool
    summary: str
    processes: tuple[MergeProcess, ...] = ()


def _record(text: str) -> object:
    try:
        return json.loads(text)
    except ValueError:
        return None


def _cross_timeout(cfg: Config) -> int:
    raw = knob(cfg, "FLEET_CROSS_TIMEOUT", "20")
    if not _POSITIVE_INT.fullmatch(raw):
        die(f"FLEET_CROSS_TIMEOUT must be a positive whole number of seconds, not {shlex.quote(raw)}")
    return int(raw)


def _basename(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def _peel_env(tokens: Sequence[str]) -> int | None:
    if not tokens or _basename(tokens[0]) != "env":
        return 0
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--":
            return i + 1
        if tok in _ENV_SINGLE_FLAGS:
            i += 1
        elif tok in _ENV_VALUE_FLAGS:
            if i + 1 >= len(tokens):
                return None
            i += 2
        elif tok.startswith(_ENV_VALUE_PREFIXES):
            i += 1
        elif _ENV_ASSIGN.fullmatch(tok):
            i += 1
        else:
            break
    return i


def _peel_shell(tokens: Sequence[str], i: int) -> int | None:
    if i >= len(tokens):
        return None
    name = _basename(tokens[i]).lstrip("-")
    if name not in _SHELLS:
        return i
    i += 1
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--":
            return i + 1
        if tok in _SHELL_VALUE_FLAGS:
            if i + 1 >= len(tokens):
                return None
            i += 2
        elif len(tok) > 1 and tok[0] in ("-", "+") and tok[-1] == "o" and all(ch in _SHELL_FLAGS for ch in tok[1:-1]):
            if i + 1 >= len(tokens):
                return None
            i += 2
        elif len(tok) > 1 and tok[0] in ("-", "+") and all(ch in _SHELL_FLAGS for ch in tok[1:]):
            i += 1
        else:
            break
    return i


def _match_merge_subcommand(tokens: Sequence[str], i: int) -> bool:
    if i >= len(tokens):
        return False
    if tokens[i] == _REPO_FLAG:
        if i + 1 >= len(tokens) or not tokens[i + 1]:
            return False
        i += 2
    elif tokens[i].startswith(_REPO_PREFIX):
        i += 1
    return i < len(tokens) and tokens[i] == "merge"


def _match_python_prreview_merge(tokens: Sequence[str], i: int) -> bool:
    while i < len(tokens):
        tok = tokens[i]
        if tok == _MODULE_FLAG:
            if i + 1 >= len(tokens) or tokens[i + 1] != _PRREVIEW_MODULE:
                return False
            return _match_merge_subcommand(tokens, i + 2)
        if tok in _PYTHON_VALUE_FLAGS:
            if i + 1 >= len(tokens):
                return False
            i += 2
        elif tok.startswith(_PYTHON_VALUE_PREFIXES):
            i += 1
        elif tok.startswith("-") and not tok.startswith("--") and len(tok) > 1:
            body = tok[1:]
            if "m" in body:
                prefix, _, rest = body.partition("m")
                if not all(ch in _PYTHON_FLAGS for ch in prefix):
                    return False
                if rest == "":
                    if i + 1 >= len(tokens) or tokens[i + 1] != _PRREVIEW_MODULE:
                        return False
                    return _match_merge_subcommand(tokens, i + 2)
                if rest != _PRREVIEW_MODULE:
                    return False
                return _match_merge_subcommand(tokens, i + 1)
            if not all(ch in _PYTHON_FLAGS for ch in body):
                return False
            i += 1
        else:
            return False
    return False


def _merge_command_start(tokens: Sequence[str]) -> int | None:
    """Return the token index after any peeled ``env`` wrapper if ``tokens`` is a merge argv, else None."""
    start = _peel_env(tokens)
    if start is None or start >= len(tokens):
        return None
    if _PYTHON_BIN.fullmatch(_basename(tokens[start])):
        return start if _match_python_prreview_merge(tokens, start + 1) else None
    idx = _peel_shell(tokens, start)
    if idx is None or idx >= len(tokens):
        return None
    prog = tokens[idx]
    if _basename(prog) == "pr-review.sh":
        return start if _match_merge_subcommand(tokens, idx + 1) else None
    if prog == "scripts/py" or prog.endswith("/scripts/py"):
        return start if _match_python_prreview_merge(tokens, idx + 1) else None
    return None


def is_merge_argv(tokens: Sequence[str]) -> bool:
    """Return True iff ``tokens`` matches the closed allowlist of ship-pr merge argv forms."""
    return _merge_command_start(tokens) is not None


def _sanitize_command(text: str) -> str:
    return "".join("?" if ord(ch) < 32 or ord(ch) == 127 else ch for ch in text.strip())


def parse_merge_processes(ps_output: str) -> list[MergeProcess] | None:
    """Parse ``ps -Aww -o pid=,stat=,args=`` output fail-closed; None means unreadable listing."""
    live_with_args = 0
    found: list[MergeProcess] = []
    for line in ps_output.split("\n"):
        if not line.strip():
            continue
        match = _PS_LINE.match(line)
        if match is None:
            return None
        pid_s, state, args_text = match.group(1), match.group(2), match.group(3) or ""
        if not _PS_STAT.fullmatch(state):
            return None
        if state.startswith(("Z", "X")):
            continue
        tokens = args_text.split()
        if tokens:
            live_with_args += 1
        start = _merge_command_start(tokens)
        if start is not None:
            reported = " ".join(tokens[start:])
            found.append(MergeProcess(int(pid_s), _sanitize_command(reported)))
    if live_with_args == 0:
        return None
    found.sort(key=lambda item: item.pid)
    return found


def _probe_reader(cfg: Config, box: str, cross_timeout: int) -> ReaderProbe:
    argv = far_argv(cfg, box, [_ANCHOR, _BOX.pattern, str(cross_timeout)])
    try:
        done = proc.run_tool(argv[0], argv[1:], stdin=_READER, timeout=2 * cross_timeout)
    except OSError:
        return ReaderProbe(False, "unreachable (could not start probe)", None)
    if done.rc == UNREACHABLE:
        return ReaderProbe(False, f"unreachable (exit {done.rc})", None)
    if done.rc == 124:
        return ReaderProbe(True, f"reader probe timed out (exit {done.rc})", None)
    if done.rc:
        return ReaderProbe(True, f"reader probe failed (exit {done.rc})", None)
    match _record(done.stdout):
        case [bool(accepted), str(endpoint), int(status), str(reply)] if endpoint and type(status) is int:
            pass
        case _:
            return ReaderProbe(True, "unrecognized reader reply", None)
    reader = f"reader {'accepts' if accepted else 'rejects'} lease fleet"
    anchor = f"anchor {shlex.quote(endpoint)}"
    if status in (UNREACHABLE, 124):
        return ReaderProbe(True, f"{reader}, {anchor} unreachable (exit {status})", None)
    if status == 2:
        return ReaderProbe(True, f"{reader}, {anchor} differs from the fleet registry pin", None)
    if status == 3:
        return ReaderProbe(True, f"{reader}, {anchor} state path must be absolute after expanding $HOME", None)
    if status == 4 or not _BOX.fullmatch(endpoint):
        return ReaderProbe(True, f"{reader}, {anchor} must be a plain fleet name", None)
    if status:
        return ReaderProbe(True, f"{reader}, {anchor} directory probe failed (exit {status})", None)
    match _record(reply):
        case [str(host), str(path), int(device), int(inode)] if (
            host and path.startswith("/") and type(device) is int and type(inode) is int and device >= 0 and inode >= 0
        ):
            report = f"{reader}, {anchor} host={shlex.quote(host)} path={shlex.quote(path)} device={device} inode={inode}"
            return ReaderProbe(True, report, Anchor(endpoint, host, device, inode) if accepted else None)
        case _:
            return ReaderProbe(True, f"{reader}, {anchor} returned an unrecognized directory reply", None)


def _probe_merges(cfg: Config, box: str, cross_timeout: int) -> MergeScan:
    argv = far_argv(cfg, box, [])
    try:
        done = proc.run_tool(argv[0], argv[1:], stdin=_PROCESS_PROBE, timeout=cross_timeout)
    except OSError:
        return MergeScan(False, "process probe unreachable (could not start probe)")
    if done.rc in (UNREACHABLE, 124):
        return MergeScan(False, f"process probe unreachable (exit {done.rc})")
    if done.rc:
        return MergeScan(False, f"process probe failed (exit {done.rc})")
    merges = parse_merge_processes(done.stdout)
    if merges is None:
        return MergeScan(False, "unrecognized process listing")
    if not merges:
        return MergeScan(True, "in-flight merges: none")
    return MergeScan(True, f"in-flight merges: {len(merges)}", tuple(merges))


def run(args: list[str]) -> int:
    usage = "usage: pr-review.sh lease-preflight <owner/repo> [--boxes <box> ...]"
    if not args or parse_ref(f"{args[0]}#1") is None:
        die(usage)
    repo, *options = args
    if options and (options[0] != "--boxes" or len(options) < 2):
        die(usage)
    cfg = load_config(str(fleet_worker_path()), os.environ)
    boxes = options[1:] if options else roster_words(cfg.boxes)
    if not boxes or not all(_BOX.fullmatch(box) for box in boxes):
        die(usage)
    cross_timeout = _cross_timeout(cfg)
    targets = dict.fromkeys(fleet_name(cfg, box) for box in boxes)
    identities: set[Anchor] = set()
    incomplete = False
    in_flight = False
    for box in targets:
        quoted = shlex.quote(box)
        reader = _probe_reader(cfg, box, cross_timeout)
        if not reader.reachable:
            cli.say(f"{quoted}: {reader.report}")
            incomplete = True
            continue
        merges = _probe_merges(cfg, box, cross_timeout)
        cli.say(f"{quoted}: {reader.report}; {merges.summary}")
        for item in merges.processes:
            cli.say(f"  {quoted} pid={item.pid}: {item.command}")
        if reader.anchor is not None:
            identities.add(reader.anchor)
        if reader.anchor is None or not merges.ok:
            incomplete = True
        if merges.processes:
            in_flight = True
    cli.say(SNAPSHOT_LIMIT)
    subject = shlex.quote(repo)
    reasons: list[str] = []
    if len(identities) > 1:
        reasons.append("boxes resolve different anchor directories")
    if in_flight:
        reasons.append("one or more recognizable ship-pr merge processes are in flight")
    if incomplete:
        reasons.append("one or more boxes could not verify all prerequisites")
    if reasons:
        fail(1, f"{subject}: merge lease preflight refused: {'; '.join(reasons)}.")
    cli.say(
        f"{subject}: all {len(targets)} checked box(es) accept lease fleet, resolve the same anchor directory,"
        " and reported no recognizable in-flight ship-pr merges."
    )
    return 0
