"""``execution slot --holders`` (ludics-lite#639): who holds THIS box's run-time slots and GPU tokens
now, one JSON line per held slot, read from the slot files' flocks -- the read OCANNL's sweep made
itself from ``/proc/locks``, owned here in one format beside the GPU co-tenant records
(``cotenants.py``), whose field names it shares where they overlap (``box``, ``event``, ``at``,
``pid``, ``user``, ``command``).

One line per held slot file, its fields:

- ``box``: this box's fleet name; ``at``: UTC, ISO 8601, when the slots were read; ``event``:
  ``held``, or ``untested`` for a slot file whose lock could not be tested (it cannot be opened)
  and that no lock-table line names -- said, never read as a free slot, with ``held`` among its
  ``unknown`` fields;
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

Then one line per batch WAITING here (ludics-lite#719), from its ``waiting.<pid>`` record
(slot.py's ``WaitingRecord``): ``box``, ``at``, ``event`` ``waiting``, ``phase`` (``window`` while
it waits out a measurement, ``slot`` while it waits for a free slot), ``kind`` (the slot it asks
for), ``pid``, ``command``, ``since`` (when it began to wait), ``source`` ``waiting-record``, and
``unknown`` as above for a record whose text does not parse. Its order is the records' ``since``.

WHAT IT READS, AND WHAT IT DOES NOT (the boundary). It reads the slot directory's ``slot.<n>``
files (``<n>`` decimal) and ``waiting.<pid>`` records, and nothing else there. A waiting record
is listed only while its flock is held (the same test as a slot's), so a waiter that died is not
listed; what it says is what the waiter wrote, not read off ``ps``. A batch waiting on another
machine for this box (``execution leg --wait-window`` on its agent host) has no record here: the
anchor's heartbeat is its trace (registry.py's THE WAITERS). Not read: ``measurement.lock`` (a
live ``execution hold --request`` shows as the holder of every slot it drained), the co-tenant
records, the registry. A slot is listed when a non-blocking exclusive flock on a new read-only descriptor of it
fails NOW -- the test ``execution slot`` itself makes of a nested marker -- or when the lock table
names a holder of it; the test takes the lock for an instant when it is free, so a batch taking a
slot in that instant tries its next one. Who holds it is read, on
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

import fcntl
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

from ludics.fleetworker import cotenants

PROC_LOCKS = "/proc/locks"
PROC = "/proc"
# A /proc/locks holder line: `<n>: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> <start> <end>`.
# A blocked waiter's line carries `->` after the index and is not a holder, so it never matches.
LOCK_LINE = re.compile(r"[0-9]+: FLOCK +[A-Z]+ +[A-Z]+ +(-?[0-9]+) +([0-9a-f]+):([0-9a-f]+):([0-9]+) ")
SLOT_FILE = re.compile(r"slot\.([0-9]+)")
WAITING_FILE = re.compile(r"waiting\.([0-9]+)")


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


def held_now(path: str) -> bool | str:
    """Whether some process holds the flock on ``path`` now: a non-blocking exclusive lock on a new
    READ-ONLY descriptor (flock needs no write access, so another user's 0644 slot is tested too)
    fails even for a descendant of the holder. Why not, when the file cannot be opened."""
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError as exc:
        return f"{path}: cannot open it to test its lock: {exc.strerror or exc}"
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return True
    finally:
        os.close(descriptor)
    return False


def table_pids(table: list[Holder], path: str) -> list[int]:
    """The holders the lock table names for ``path``, by its device and inode."""
    try:
        status = os.stat(path)
    except OSError:
        return []
    device = (os.major(status.st_dev), os.minor(status.st_dev))
    return [h.pid for h in table if h.inode == status.st_ino and (h.major, h.minor) == device]


def holders(box: str, directory: str, cap: int, tokens: int, run: cotenants.Runner = cotenants.run_bounded,
            locks: str = PROC_LOCKS, proc: str = PROC, platform: str = "") -> list[dict[str, Any]]:
    """The held slots of ``directory``, one line each (the module's fields)."""
    table = read_lock_table(locks)
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    held: list[tuple[int, list[int], str]] = []
    for index in slot_files(directory):
        path = os.path.join(directory, f"slot.{index}")
        tested = held_now(path)
        pids = table_pids(table, path) if table is not None and tested is not False else []
        if tested is True or pids:
            held.append((index, pids, ""))
        elif isinstance(tested, str):
            held.append((index, [], tested))
    names = cotenants.describe([pid for _, pids, _ in held for pid in pids if pid > 0], run)
    lines: list[dict[str, Any]] = []
    for index, pids, untested in held:
        base: dict[str, Any] = {"box": box, "event": "held", "at": at, "slot": index, "slots": cap,
                                "kind": kind_of(index, tokens)}
        if untested:
            # Neither the test nor the table says it is held: said, never read as a free slot.
            lines.append({**base, "event": "untested", "pid": None, "user": None, "command": None, "cwd": None,
                          "source": "proc-locks" if table is not None else "flock-test",
                          "unknown": {name: untested for name in ("held", "pid", "user", "command", "cwd")}})
            continue
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


def waiters(box: str, directory: str) -> list[dict[str, Any]]:
    """The batches waiting here: one line per ``waiting.<pid>`` record whose flock is held now."""
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines: list[dict[str, Any]] = []
    for name in names:
        match = WAITING_FILE.fullmatch(name)
        path = os.path.join(directory, name)
        if not match or not match.group(1).isascii() or held_now(path) is not True:
            continue
        line: dict[str, Any] = {"box": box, "at": at, "event": "waiting", "phase": None, "kind": None,
                                "pid": int(match.group(1)), "command": None, "since": None,
                                "source": "waiting-record", "unknown": {}}
        try:
            with open(path, encoding="utf-8") as record:
                data: Any = json.loads(record.read())
        except (OSError, ValueError) as exc:
            why = f"{path}: {getattr(exc, 'strerror', None) or exc}"
            line["unknown"] = {key: why for key in ("phase", "kind", "command", "since")}
            lines.append(line)
            continue
        fields = cast(dict[str, Any], data) if isinstance(data, dict) else {}
        for key in ("phase", "kind", "command", "since"):
            value = fields.get(key)
            if isinstance(value, str):
                # An argument's undecodable bytes come back as lone surrogates: shown escaped.
                line[key] = value.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace")
            else:
                line["unknown"][key] = f"{path}: no {key} recorded"
        lines.append(line)
    return sorted(lines, key=lambda line: (line["since"] or "", line["pid"]))


def render(lines: list[dict[str, Any]]) -> str:
    return "".join(json.dumps(line, separators=(",", ":"), ensure_ascii=False) + "\n" for line in lines)
