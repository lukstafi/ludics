"""``execution slot --holders`` (ludics-lite#639): who holds THIS box's run-time slots and GPU tokens
now, one JSON line per held slot, read from the slot files' flocks -- the read OCANNL's sweep made
itself from ``/proc/locks``, owned here in one format beside the GPU co-tenant records
(``cotenants.py``), whose field names it shares where they overlap (``box``, ``event``, ``at``,
``pid``, ``user``, ``command``).

One line per held slot file, its fields:

- ``box``: this box's fleet name; ``event``: ``held``; ``at``: UTC, ISO 8601, when the slot was read;
- ``slot``, ``slots``: the slot file's index, and the box's slot count under the current spec (a
  ``slot.<n>`` file past it, left by a wider spec, is listed when held, with its own index);
- ``kind``: ``gpu`` or ``cpu``, the slot's kind under the current token spec, as
  ``FLEET_SLOT_HELD``'s last word says it: ``gpu`` for a GPU token (and for every slot of a box
  whose tokens do not bind, where any slot may hold the GPU), ``cpu`` past the tokens. It is the
  slot's kind, not the batch's declaration: a ``--cpu`` batch that fell back into a token slot is
  listed ``gpu``, which is what it holds;
- ``pid``, ``user``, ``command``, ``cwd``: the lock's holder, its user and ``ps``'s ``args`` (cut to
  300 characters, as the co-tenant records cut them), and its working directory; ``null`` where not
  known, and then named in ``unknown``;
- ``source``: ``proc-locks`` (the holder read from ``/proc/locks``) or ``flock-test`` (no lock table
  here: the slot is known to be held, its holder is not);
- ``unknown``: ``{<field>: <why>}`` for each of ``pid``, ``user``, ``command``, ``cwd`` left
  ``null``; empty when every field is known.

WHAT IT READS, AND WHAT IT DOES NOT (the boundary). It reads the slot directory's ``slot.<n>``
files (``<n>`` decimal) and nothing else there: not ``measurement.lock`` (a live ``execution hold
--request`` shows as the holder of every slot it drained), not the co-tenant records, not the
registry. A slot is listed when a non-blocking exclusive flock on it fails NOW -- the test
``execution slot`` itself makes of a nested marker -- which takes the lock for an instant when it
is free, so a batch taking a slot in that instant tries its next one. Who holds it is read, on
a system that has it, from ``/proc/locks``: a ``FLOCK`` line (not a ``->`` waiter) whose
``<major>:<minor>:<inode>`` is the slot file's own ``st_dev`` and ``st_ino``, its pid the process
that took the lock (the slot's wrapper; a holder the kernel shows as pid 0, outside this pid
namespace, is unknown). A fail-closed allowlist: a held slot no such line matches -- no
``/proc/locks`` (macOS, every BSD: their lock tables name no flock holder), a filesystem whose
``stat`` device is not the one the lock table prints (a btrfs subvolume), a holder that took the
lock between the two reads -- is listed with its holder unknown, never matched another way. The
user and command come from ``ps`` (a pid it no longer finds, a wrapper killed while its batch
kept the inherited lock, leaves both unknown), the cwd from ``/proc/<pid>/cwd`` (another user's
is unreadable, and said so). Everything is read once, so a slot taken or freed while it runs may
show as either.
"""

import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ludics.fleetworker import cotenants

PROC_LOCKS = "/proc/locks"
PROC = "/proc"
# A /proc/locks holder line: `<n>: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> <start> <end>`.
# A blocked waiter's line carries `->` after the index and is not a holder, so it never matches.
LOCK_LINE = re.compile(r"[0-9]+: FLOCK +[A-Z]+ +[A-Z]+ +(-?[0-9]+) +([0-9a-f]+):([0-9a-f]+):([0-9]+) ")
SLOT_FILE = re.compile(r"slot\.([0-9]+)")


@dataclass(frozen=True)
class Holder:
    """One /proc/locks FLOCK holder: its pid and the file it locks."""

    pid: int
    major: int
    minor: int
    inode: int


def read_lock_table(path: str) -> list[Holder] | None:
    """Every FLOCK holder line of ``path``, or None when there is no such table to read."""
    try:
        with open(path, encoding="ascii", errors="replace") as table:
            text = table.read()
    except OSError:
        return None
    holders: list[Holder] = []
    for line in text.splitlines():
        match = LOCK_LINE.match(line)
        if match:
            pid, major, minor, inode = match.groups()
            holders.append(Holder(int(pid), int(major, 16), int(minor, 16), int(inode)))
    return holders


def slot_files(directory: str) -> list[int]:
    """The indices of the directory's ``slot.<n>`` files, in order; none for a missing directory."""
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    indices: list[int] = []
    for name in names:
        match = SLOT_FILE.fullmatch(name)
        if match and match.group(1).isascii():
            indices.append(int(match.group(1)))
    return sorted(set(indices))


def kind_of(index: int, tokens: int) -> str:
    """``FLEET_SLOT_HELD``'s last word for that slot: tokens are 0 where they do not bind."""
    return "gpu" if not tokens or index <= tokens else "cpu"


def read_cwd(proc: str, pid: int) -> tuple[str | None, str]:
    try:
        return os.readlink(os.path.join(proc, str(pid), "cwd")), ""
    except PermissionError:
        return None, "another user's process: its cwd is not readable here"
    except OSError as exc:
        return None, f"{os.path.join(proc, str(pid), 'cwd')}: {exc.strerror or exc}"


def holders(box: str, directory: str, cap: int, tokens: int, is_held: Callable[[str], bool | None],
            run: cotenants.Runner = cotenants.run_bounded, locks: str = PROC_LOCKS, proc: str = PROC,
            platform: str = "") -> list[dict[str, Any]]:
    """The held slots of ``directory``, one line each (the module's fields)."""
    table = read_lock_table(locks)
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    held: list[tuple[int, list[int]]] = []
    for index in slot_files(directory):
        path = os.path.join(directory, f"slot.{index}")
        if is_held(path) is not True:
            continue
        pids: list[int] = []
        if table is not None:
            try:
                status = os.stat(path)
            except OSError:
                status = None
            if status is not None:
                pids = [h.pid for h in table
                        if h.inode == status.st_ino and (h.major, h.minor) == (os.major(status.st_dev), os.minor(status.st_dev))]
        held.append((index, pids))
    names = cotenants.describe([pid for _, pids in held for pid in pids if pid > 0], run)
    lines: list[dict[str, Any]] = []
    for index, pids in held:
        base: dict[str, Any] = {"box": box, "event": "held", "at": at, "slot": index, "slots": cap,
                                "kind": kind_of(index, tokens)}
        if table is None:
            why = f"no {locks} on this system ({platform or os.uname().sysname}): a flock's holder is not recorded"
            lines.append({**base, "pid": None, "user": None, "command": None, "cwd": None, "source": "flock-test",
                          "unknown": {name: why for name in ("pid", "user", "command", "cwd")}})
            continue
        if not pids:
            why = f"no FLOCK line of {locks} names this slot file's device and inode"
            lines.append({**base, "pid": None, "user": None, "command": None, "cwd": None, "source": "proc-locks",
                          "unknown": {name: why for name in ("pid", "user", "command", "cwd")}})
            continue
        for pid in pids:
            unknown: dict[str, str] = {}
            if pid <= 0:
                why = f"{locks} names pid {pid}: a holder outside this pid namespace"
                lines.append({**base, "pid": None, "user": None, "command": None, "cwd": None, "source": "proc-locks",
                              "unknown": {name: why for name in ("pid", "user", "command", "cwd")}})
                continue
            user, command = names.get(pid, (None, None))
            if user is None:
                unknown["user"] = unknown["command"] = f"ps does not list pid {pid} (gone -- a wrapper killed while its batch kept the lock -- or ps could not answer)"
            cwd, why = read_cwd(proc, pid)
            if cwd is None:
                unknown["cwd"] = why
            lines.append({**base, "pid": pid, "user": user, "command": command, "cwd": cwd, "source": "proc-locks",
                          "unknown": unknown})
    return lines


def render(lines: list[dict[str, Any]]) -> str:
    return "".join(json.dumps(line, separators=(",", ":"), ensure_ascii=False) + "\n" for line in lines)
