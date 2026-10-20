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
- ``unknown``: ``{<field>: <why>}`` for each of ``pid``, ``user``, ``command``, ``cwd`` (and
  ``record``) left ``null``; empty when every field is known;
- ``record`` (ludics-lite#712): the holder record the slot's taker wrote into the file (slot.py's
  THE HOLDER RECORD) and whether this box confirms it is the holder's (THE CONFIRMATION, below),
  ``null`` when the file holds no record: ``verdict`` (``confirmed``, ``unconfirmed`` or
  ``unknown``), ``by`` (``proc-locks``, ``proc-fd`` or ``lsof``: what the verdict was read from),
  ``pid`` (the recorded pid), ``pids`` (what ``by`` names for the file: the lock table's holders,
  or the processes that have it open, this reader excluded; ``null`` when ``unknown``), ``why``
  (the verdict's reason, in words), and, only when ``confirmed`` (an unconfirmed record may be an
  earlier taker's), ``command`` (the recorded command, shell-quoted), ``taken`` (UTC, ISO 8601,
  when the slot was taken), ``deadline`` (the recorded ``--deadline`` seconds, ``null`` for none)
  and ``left`` (whole seconds of that cap left, on the clock it is enforced on; ``null`` for no
  ``--deadline``); each of those four is ``null`` otherwise.

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

THE CONFIRMATION (ludics-lite#712): whether a held slot's holder record is its holder's, for this
listing's ``record`` and the drain's ``recorded holder, <verdict>`` line (slot.py). A record can be
stale -- a batch started by a fleet-worker older than #668 writes none, and the file keeps an
earlier taker's -- and a guess at the recorded pid's liveness from ``ps`` is not evidence (a reused
pid, a zombie), so the verdict rests on what the kernel reports about THIS file, read in this
order, the first that answers deciding:

1. ``proc-locks``: the lock table's FLOCK holders of the file (above), where it names one with a
   pid above 0. Confirmed when the recorded pid is among them, unconfirmed when not: the table
   names the process that took the lock, so a record of another pid is not this lock's.
2. ``proc-fd`` (a system with ``/proc/self/fd``): the processes one of whose ``/proc/<pid>/fd``
   links reads as the file's real path.
3. ``lsof`` (elsewhere: macOS, the BSDs): ``lsof -t -- <slot file>``, run bounded the way the
   co-tenant probes run ``ps`` (``cotenants.run_bounded``); its exit 1 with nothing listed is its
   answer for a file no process has open.

For 2 and 3 the boundary: "has it open" is a SUPERSET of "holds the lock". The take
(slot.py's ``take_slot``) closes a busy slot's descriptor at once, and only the taker keeps it
open, marked inheritable, so the taker's tree has it open too; the rest are instantaneous testers
(this listing's own ``held_now``, the nested-slot judgement) and a draining hold, blocked in its
flock, whose pid is the reader's own and is excluded. So a recorded pid in the set is the holder or
a tester that is the holder itself: confirmed. A set that lacks it is unconfirmed, and its pids are
reported as the file's openers, never as the lock's holder (which one holds it is not read). The
negative read needs the recorded pid's descriptors to be visible here, which only the signal-0
permission test says (``os.kill(pid, 0)``; it gates the negative, it never confirms): a pid that
is another user's process is ``unknown`` (neither /proc nor a non-root ``lsof`` shows its
descriptors), and a pid no process has is unconfirmed (nothing has it open). ``unknown`` is also a
reader that cannot answer: ``lsof`` not found, timed out, or failed (each said); it is never read
as confirmed. Not read: ``ps``, the record's ``started`` against any process's start time, any
file but the slot file.
"""

import fcntl
import json
import os
import re
import shlex
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol, cast

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


# --- THE CONFIRMATION -----------------------------------------------------------------------------


class Recorded(Protocol):
    """A slot's holder record, as slot.py's ``read_holder`` reads it (THE HOLDER RECORD there)."""

    @property
    def pid(self) -> int: ...
    @property
    def command(self) -> tuple[str, ...]: ...
    @property
    def started(self) -> float: ...
    @property
    def deadline(self) -> int | None: ...
    @property
    def expires(self) -> float | None: ...


@dataclass(frozen=True)
class Confirmation:
    """THE CONFIRMATION's verdict on one record: ``confirmed``, ``unconfirmed`` or ``unknown``; what
    it was read from; the pids that names for the file (None when unknown); and why, in words."""

    verdict: str
    by: str
    pids: tuple[int, ...] | None
    why: str


def visibility(pid: int) -> str:
    """``mine`` (its descriptors are visible here), ``foreign`` (another user's: they are not) or
    ``gone`` (no process has the pid): the signal-0 permission test, which gates a negative read
    and never confirms."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "gone"
    except PermissionError:
        return "foreign"
    return "mine"


def proc_openers(path: str, proc: str) -> set[int]:
    """The pids one of whose ``<proc>/<pid>/fd`` links reads as ``path``'s real path: a readlink,
    which never touches the target (a stat of a link to a hung mount would hang). A process whose
    descriptors are not readable here, or that sees the file under another path (another mount
    namespace), is not among them."""
    target = os.path.realpath(path)
    found: set[int] = set()
    try:
        names = os.listdir(proc)
    except OSError:
        return found
    for name in names:
        if not (name.isdecimal() and name.isascii()):
            continue
        directory = os.path.join(proc, name, "fd")
        try:
            descriptors = os.listdir(directory)
        except OSError:  # another user's, or gone
            continue
        for descriptor in descriptors:
            try:
                if os.readlink(os.path.join(directory, descriptor)) == target:
                    found.add(int(name))
                    break
            except OSError:
                continue
    return found


def lsof_openers(path: str, run: cotenants.Runner) -> set[int] | str:
    """The pids ``lsof`` lists as having ``path`` open, or why it cannot say."""
    binary = shutil.which("lsof") or "/usr/sbin/lsof"  # macOS keeps it in /usr/sbin, off some PATHs
    rc, out = run([binary, "-t", "--", path])
    if rc == 127:
        return "lsof is not installed here (or could not be started)"
    if rc == 124:
        return f"lsof did not answer within {cotenants.PROBE_TIMEOUT}s"
    words = out.split()
    if rc not in (0, 1) or not all(word.isdecimal() and word.isascii() for word in words):
        return f"lsof failed (exit {rc})" if rc not in (0, 1) else "lsof's answer is not a list of pids"
    if rc == 1 and words:
        return "lsof failed (exit 1)"
    return {int(word) for word in words}  # exit 1 with nothing listed: no process has it open


def confirm(path: str, pid: int, table: list[Holder] | None, run: cotenants.Runner, proc: str, me: int,
            locks: str = PROC_LOCKS, seen: Callable[[int], str] = visibility) -> Confirmation:
    """THE CONFIRMATION of a record of ``pid`` on the slot file ``path``; ``me``, the reader's own
    pid (a draining hold's, blocked on the file), is never among the pids read."""
    if table is not None:
        named = tuple(sorted({p for p in table_pids(table, path) if p > 0 and p != me}))
        if named:
            if pid in named:
                return Confirmation("confirmed", "proc-locks", named, f"{locks} names pid {pid} as the lock's holder")
            return Confirmation("unconfirmed", "proc-locks", named,
                                f"{locks} names pid {', '.join(map(str, named))} as the lock's holder, not the recorded pid {pid}")
    if os.path.isdir(os.path.join(proc, "self", "fd")):
        by: str = "proc-fd"
        found: set[int] | str = proc_openers(path, proc)
    else:
        by, found = "lsof", lsof_openers(path, run)
    if isinstance(found, str):
        return Confirmation("unknown", by, None, found)
    found.discard(me)
    pids = tuple(sorted(found))
    if pid in found:
        return Confirmation("confirmed", by, pids, f"pid {pid} has the slot file open ({by})")
    visible = seen(pid)
    if visible == "foreign":
        return Confirmation("unknown", by, None, f"pid {pid} is another user's process, whose descriptors {by} cannot see here")
    opened = (f"open by pid {', '.join(map(str, pids))}, which may hold the lock or test it" if pids
              else "no other process seen here has it open")
    return Confirmation("unconfirmed", by, pids,
                        f"pid {pid} " + ("is not running" if visible == "gone" else "does not have the slot file open")
                        + f" ({by}); {opened}")


def record_field(holder: Recorded, confirmation: Confirmation, clock: float) -> dict[str, Any]:
    """The listing's ``record`` object: the verdict, and the record's own fields only when confirmed."""
    field: dict[str, Any] = {"verdict": confirmation.verdict, "by": confirmation.by, "pid": holder.pid,
                             "pids": None if confirmation.pids is None else list(confirmation.pids),
                             "why": confirmation.why, "command": None, "taken": None, "deadline": None, "left": None}
    if confirmation.verdict == "confirmed":
        left = None
        if holder.deadline is not None:
            # Before its command starts the deadline has not begun to count: all of it is ahead.
            left = max(int(holder.deadline if holder.expires is None else holder.expires - clock), 0)
        try:
            taken = datetime.fromtimestamp(holder.started, timezone.utc).isoformat(timespec="seconds")
        except (OverflowError, ValueError, OSError):  # a finite epoch second past a datetime's range
            taken = None
        field |= {"command": shlex.join(holder.command), "deadline": holder.deadline, "left": left, "taken": taken}
    return field


def holders(box: str, directory: str, cap: int, tokens: int, run: cotenants.Runner = cotenants.run_bounded,
            locks: str = PROC_LOCKS, proc: str = PROC, platform: str = "",
            read_record: Callable[[str], Recorded | None] | None = None,
            seen: Callable[[int], str] = visibility) -> list[dict[str, Any]]:
    """The held slots of ``directory``, one line each (the module's fields). ``read_record`` reads a
    slot file's holder record: slot.py's ``read_holder`` when not given."""
    if read_record is None:
        from ludics.fleetworker.slot import read_holder as read_record  # slot.py imports this module
    table = read_lock_table(locks)
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    me = os.getpid()

    def with_record(line: dict[str, Any], path: str) -> dict[str, Any]:
        """``line`` with its ``record`` (THE CONFIRMATION), read now."""
        assert read_record is not None
        holder = read_record(path)
        if holder is None:
            line["record"] = None
            line["unknown"]["record"] = (f"{path} holds no holder record (a batch started by a fleet-worker older than"
                                         " ludics-lite#668, or one whose record could not be written)")
            return line
        confirmation = confirm(path, holder.pid, table, run, proc, me, locks, seen)
        line["record"] = record_field(holder, confirmation, time.monotonic())
        return line

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
                          "unknown": {name: untested for name in ("held", "pid", "user", "command", "cwd", "record")},
                          "record": None})
            continue
        path = os.path.join(directory, f"slot.{index}")
        if table is None:
            why = f"no {locks} on this system ({platform or os.uname().sysname}): a flock's holder is not recorded"
            lines.append(with_record({**base, "pid": None, "user": None, "command": None, "cwd": None, "source": "flock-test",
                                      "unknown": {name: why for name in ("pid", "user", "command", "cwd")}}, path))
            continue
        if not pids:
            why = f"no FLOCK line of {locks} names this slot file's device and inode"
            lines.append(with_record({**base, "pid": None, "user": None, "command": None, "cwd": None, "source": "proc-locks",
                                      "unknown": {name: why for name in ("pid", "user", "command", "cwd")}}, path))
            continue
        for pid in pids:
            unknown: dict[str, str] = {}
            if pid <= 0:
                why = f"{locks} names pid {pid}: a holder outside this pid namespace"
                lines.append(with_record({**base, "pid": None, "user": None, "command": None, "cwd": None,
                                          "source": "proc-locks",
                                          "unknown": {name: why for name in ("pid", "user", "command", "cwd")}}, path))
                continue
            user, command = names.get(pid, (None, None))
            if user is None:
                unknown["user"] = unknown["command"] = f"ps does not list pid {pid} (gone -- a wrapper killed while its batch kept the lock -- or ps could not answer)"
            cwd, why = read_cwd(proc, pid)
            if cwd is None:
                unknown["cwd"] = why
            lines.append(with_record({**base, "pid": pid, "user": user, "command": command, "cwd": cwd,
                                      "source": "proc-locks", "unknown": unknown}, path))
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
