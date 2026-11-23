"""Readiness check for enabling a fleet merge lease.

Reads each box's served ship-pr parser with a fixed synthetic config, then stats only the
configured state directory on the anchor reached by that box. The wire allowlist is one JSON
reader record containing an anchor reply, itself one JSON host/path/device/inode record.
The repository argument labels the report. This checks compatibility and directory identity.
It reads no repository config, PR, running merges, registry or lease records, runs no build,
tests no writes, and acquires nothing. Drain in-flight merges separately before enabling the lease.
"""

import json
import os
import re
import shlex
from dataclasses import dataclass

from ludics import cli, proc
from ludics.fleetworker.config import Config, load_config, roster_words
from ludics.fleetworker.farside import FLEET_PYTHON
from ludics.fleetworker.transport import UNREACHABLE, far_argv, fleet_name
from ludics.prreview.core import die, fail, parse_ref
from ludics.prreview.mergebuild import fleet_worker_path

_BOX = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_TIMEOUT = 40
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
if pin_refusal(cfg):
    print(json.dumps([accepted, endpoint, 2, ""]))
elif not all(re.fullmatch(sys.argv[3], name) for name in (cfg.anchor, endpoint)):
    print(json.dumps([accepted, endpoint, 4, ""]))
else:
    argv = far_argv(cfg, cfg.anchor, [])
    script = emit_var("ANCHOR_STATE", cfg.anchor_state) + sys.argv[2]
    try:
        done = proc.run_tool(argv[0], argv[1:], stdin=script.encode(), timeout=20)
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


def _record(text: str) -> object:
    try:
        return json.loads(text)
    except ValueError:
        return None


def _probe(cfg: Config, box: str) -> tuple[str, Anchor | None]:
    argv = far_argv(cfg, box, [_ANCHOR, _BOX.pattern])
    try:
        done = proc.run_tool(argv[0], argv[1:], stdin=_READER, timeout=_TIMEOUT)
    except OSError:
        return "unreachable (could not start probe)", None
    if done.rc in (UNREACHABLE, 124):
        return f"unreachable (exit {done.rc})", None
    if done.rc:
        return f"reader probe failed (exit {done.rc})", None
    match _record(done.stdout):
        case [bool(accepted), str(endpoint), int(status), str(reply)] if endpoint and type(status) is int:
            pass
        case _:
            return "unrecognized reader reply", None
    reader = f"reader {'accepts' if accepted else 'rejects'} lease fleet"
    anchor = f"anchor {shlex.quote(endpoint)}"
    if status in (UNREACHABLE, 124):
        return f"{reader}, {anchor} unreachable (exit {status})", None
    if status == 2:
        return f"{reader}, {anchor} differs from the fleet registry pin", None
    if status == 3:
        return f"{reader}, {anchor} state path must be absolute after expanding $HOME", None
    if status == 4 or not _BOX.fullmatch(endpoint):
        return f"{reader}, {anchor} must be a plain fleet name", None
    if status:
        return f"{reader}, {anchor} directory probe failed (exit {status})", None
    match _record(reply):
        case [str(host), str(path), int(device), int(inode)] if (
            host and path.startswith("/") and type(device) is int and type(inode) is int and device >= 0 and inode >= 0
        ):
            report = f"{reader}, {anchor} host={shlex.quote(host)} path={shlex.quote(path)} device={device} inode={inode}"
            return report, Anchor(endpoint, host, device, inode) if accepted else None
        case _:
            return f"{reader}, {anchor} returned an unrecognized directory reply", None


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
    targets = dict.fromkeys(fleet_name(cfg, box) for box in boxes)
    identities: set[Anchor] = set()
    incomplete = False
    for box in targets:
        report, anchor = _probe(cfg, box)
        cli.say(f"{shlex.quote(box)}: {report}")
        if anchor is None:
            incomplete = True
        else:
            identities.add(anchor)
    subject = shlex.quote(repo)
    if len(identities) > 1:
        fail(1, f"{subject}: merge lease preflight refused: boxes resolve different anchor directories.")
    if incomplete:
        fail(1, f"{subject}: merge lease preflight refused: one or more boxes could not verify both prerequisites.")
    cli.say(f"{subject}: all {len(targets)} checked box(es) accept lease fleet and resolve the same anchor directory.")
    return 0
