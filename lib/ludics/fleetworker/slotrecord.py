"""THE HOLDER RECORD (ludics-lite#668): the one-line JSON record whoever takes a slot writes into
the slot's own lock file (``record_holder``), and its reader (``read_holder``), which slot.py's
drain names a holder from and holders.py's listing confirms (THE CONFIRMATION there). slot.py's
THE HOLDER RECORD comment says why the record exists and what the drain says of it; this module is
the record's shape and nothing else, so holders.py imports it without importing slot.py (which
imports holders.py)."""

import json
import math
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast

# The boundary of the reader (``read_holder``), as a fail-closed allowlist: it reads at most
# HOLDER_READ bytes of a slot file, as one JSON object, and takes from it exactly five fields --
# ``pid`` (an integer from 1 to PID_MAX, the range of every pid_t this package runs on),
# ``command`` (a non-empty list of strings), ``started`` (a finite number, the epoch second the
# slot was taken), ``deadline`` (null, or the positive whole ``--deadline`` seconds) and
# ``expires`` (absent or null until the command starts, then a finite ``time.monotonic()`` reading
# at which that deadline ends it). Any other key is not read. A file that is empty, longer, not
# that shape, or not readable is no record ("left no record"), never a partial one.

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
