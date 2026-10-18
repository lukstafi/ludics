"""The GPU co-tenants of a measurement (ludics-lite#566, part 2): which processes were on THIS box's
GPU, apart from the measurement's own tree, when an ``execution hold --request <id>`` opened and when
it closed.

In the 2026-10-05 wave a minix A/B was refused for its timing windows, and the likeliest cause -- a
VS Code server sharing the integrated GPU -- appeared nowhere in the window's record. So the hold
now records the box's GPU-using processes at its start and its end, appended as two JSON lines to
``<slot dir>/<box>/measurement.<request id>.gpu.jsonl``, and says what it found on stderr;
``execution conclude`` of that measurement reads the file on the execution host and appends a
summary to the conclusion's evidence (``execution.py``, THE CO-TENANT EVIDENCE). It records and
stops nothing: quiescing a co-tenant (the issue's ``measurement_quiesce``) is out of scope.

One line per snapshot, its fields:

- ``request_id``, ``box``: the registry's own names for the measurement and its execution host;
- ``hold_pid``: the hold's pid, which pairs a hold's ``opened`` line with its ``closed`` one (a box
  may run several holds of one measurement, one after another);
- ``event``: ``opened`` (taken after THE DRAIN, just before the command starts, and written once it
  has started, so a command that cannot be started records nothing) or ``closed`` (after the
  command's leader has ended, whatever ended it);
- ``at``: UTC, ISO 8601, as the registry's ``created_at``;
- ``probes``: one ``{probe, status, detail}`` per source below, ``status`` ``ran``, ``absent`` (no
  such source on this box) or ``failed``;
- ``gpu_processes``: one entry per (probe, pid): ``pid``, ``user`` and ``command`` (``ps``'s
  ``args``, cut to 300 characters; both empty for a pid ``ps`` no longer finds), ``probe``, and
  what that probe reports, as it reports it: ``gpu_memory_mib`` (nvidia-smi), ``gpu_time_ns`` (the
  client's cumulative GPU busy time as read: drm-fdinfo, ioreg), ``driver`` (drm-fdinfo);
- ``own_tree_gpu_processes``: how many GPU-using processes were left out as the hold's own tree.

WHAT IT RECORDS, AND WHAT IT DOES NOT (the boundary). PRESENCE: which processes outside the hold's
own tree the three probes below list at two instants per hold, with each probe's own fields as it
reports them (memory held, a client's cumulative GPU time as read), and nothing in between. It does
not attribute GPU usage to the hold's interval (no before/after arithmetic): a reader compares the
two snapshots. A co-tenant that starts and ends inside a hold is invisible to nvidia-smi and DRM
fdinfo, and shows in ioreg only if its client outlives the close. It sees another user's processes
only through nvidia-smi; DRM fdinfo counts them as unreadable. A GPU busy with something no probe
lists (a VM's passthrough, a kernel-side job) is not seen. Every ``execution hold --request``
records its own pair; a nested hold of the same measurement is recorded only while it lives within
its enclosing command, and one still live when the conclusion reads the record shows as a hold
whose close is not recorded (the conclusion does not wait for it). The hold's own tree is read
before and after the probes, by pid, so a pid reused within the seconds the probes run is not told
apart.

THE HOLD'S OWN TREE is this process, its descendants, and every member of the command's process
group (group.py: the command leads one), which is where its leftovers stay after the leader has
ended. A hold nested in a live hold of the same measurement also leaves out its own process group,
which is its enclosing hold's command group: the measurement itself. Its ancestors are not: the
hold's caller (a terminal, an agent's desktop app) shares the GPU like any other process. A process
that left the command's group into a session of its own -- a ``setsid`` daemon, the command of a
nested hold (group.py starts one per hold) -- and outlived what started it, so that it was
reparented away from the hold, counts as a co-tenant: it is no longer the hold's to end, and the
record lists it by its command line, so a reader sees what it was. The tree is read twice, before
and after the probes, so a member that ends or starts while they run is still the hold's own.

THE PROBES, a fail-closed allowlist: each reads exactly this, and nothing else counts as a GPU
process.

- ``nvidia-smi`` (``FLEET_NVIDIA_SMI``, default ``nvidia-smi`` on PATH): ``--query-compute-apps=
  pid,process_name,used_memory --format=csv,noheader,nounits``. A line is read only when its first
  field is a decimal pid; the memory is the last field when it is a decimal number (``[N/A]`` and
  the like give none); anything else is counted in ``detail`` and skipped. CUDA contexts only: a
  graphics-only client (Xorg, a compositor) is not a compute app and is not listed.
- ``drm-fdinfo`` (Linux; ``FLEET_DRM_PROC``, default ``/proc``): a process is a DRM client when
  ``<proc>/<pid>/fd/<n>`` links to a path under ``/dev/dri/``; its ``<proc>/<pid>/fdinfo/<n>``
  then gives ``drm-driver`` and, per ``drm-pdev`` and ``drm-client-id`` (counted once however many descriptors share
  it), the ``drm-engine-<name>: <n> ns`` lines, summed into ``gpu_time_ns``. A kernel or driver
  that writes no such lines leaves the client listed without a time. Only processes whose fd table
  this user may read are seen: another user's (root's, gdm's) are counted as unreadable in
  ``detail``, never listed. This is the AMD path (minix, tuf) and also lists the NVIDIA boxes'
  graphics clients.
- ``ioreg`` (``FLEET_IOREG``, default ``ioreg`` on PATH, which only macOS has): ``ioreg -r -c
  IOGPUDeviceUserClient -l -w0``, one block per GPU user client: its ``"IOUserClientCreator" = "pid
  <n>, <name>"`` line names the process, and every ``"accumulatedGPUTime"=<n>`` inside its
  ``"AppUsage"`` line is summed into ``gpu_time_ns`` (nanoseconds: its ``lastSubmittedTime`` is
  CLOCK_UPTIME_RAW's). Apple Silicon's AGX clients are such a class; a Mac whose GPU driver
  registers no ``IOGPUDeviceUserClient`` lists nothing, and says ``ran`` with no clients.

Every probe is bounded by ``PROBE_TIMEOUT`` (the file reads of drm-fdinfo too, in a thread of
their own), and a probe that cannot run is a ``failed`` entry,
never a refused measurement: the record is evidence, and its absence must not stop the run.
"""

import json
import os
import re
import shutil
import subprocess
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

PROBE_TIMEOUT = 15  # seconds per probe; nvidia-smi answers in about one
COMMAND_WIDTH = 300  # characters of a process's args kept in the record
SHOWN = 8  # processes a summary names before "+<n> more"
SUMMARY_WIDTH = 16000  # characters of a conclusion's clause: a readable record (no transport cap since ludics-lite#636)

type Runner = Callable[[Sequence[str]], tuple[int, str]]
"""Run a command with a bound: its status and stdout (127 when it cannot be started, 124 on time out)."""


def run_bounded(argv: Sequence[str]) -> tuple[int, str]:
    try:
        done = subprocess.run(list(argv), capture_output=True, timeout=PROBE_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        return 124, ""
    except OSError:
        return 127, ""
    return done.returncode, done.stdout.decode("utf-8", "replace")


@dataclass(frozen=True)
class Found:
    """One probe's answer: its outcome and the (pid, fields) it lists."""

    probe: str
    status: str  # ran | absent | failed
    detail: str
    processes: tuple[tuple[int, dict[str, Any]], ...] = ()


# --- the probes -----------------------------------------------------------------------------------


def probe_nvidia(binary: str, run: Runner) -> Found:
    name = "nvidia-smi"
    path = shutil.which(binary)
    if path is None:
        return Found(name, "absent", f"no {binary}")
    rc, out = run([path, "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"])
    if rc != 0:
        first = next((line.strip() for line in out.splitlines() if line.strip()), "")
        return Found(name, "failed", f"exit {rc}" + (f": {first[:200]}" if first else ""))
    found: dict[int, dict[str, Any]] = {}
    skipped = 0
    for line in out.splitlines():
        if not line.strip():
            continue
        fields = [part.strip() for part in line.split(",")]
        if not (fields[0].isdecimal() and fields[0].isascii()):
            skipped += 1
            continue
        # One row per process AND GPU: a process on two GPUs is one entry, its memory summed.
        entry = found.setdefault(int(fields[0]), {})
        if len(fields) >= 3 and fields[-1].isdecimal() and fields[-1].isascii():
            entry["gpu_memory_mib"] = entry.get("gpu_memory_mib", 0) + int(fields[-1])
    detail = f"skipped {skipped} unreadable line(s)" if skipped else ""
    return Found(name, "ran", detail, tuple(sorted(found.items())))


_ENGINE = re.compile(r"drm-engine-[A-Za-z0-9_-]+:\s*([0-9]+)\s*ns\s*$")


def probe_drm(root: str) -> Found:
    name = "drm-fdinfo"
    try:
        pids = [entry for entry in os.listdir(root) if entry.isdecimal() and entry.isascii()]
    except OSError:
        return Found(name, "absent", f"no {root}")
    found: list[tuple[int, dict[str, Any]]] = []
    unreadable = 0
    for pid in pids:
        directory = os.path.join(root, pid, "fd")
        try:
            descriptors = os.listdir(directory)
        except PermissionError:
            unreadable += 1
            continue
        except OSError:  # ended meanwhile, or a kernel thread
            continue
        drivers: set[str] = set()
        clients: dict[str, int] = {}
        client = False
        for fd in descriptors:
            try:
                target = os.readlink(os.path.join(directory, fd))
            except OSError:
                continue
            if not target.startswith("/dev/dri/"):
                continue
            client = True
            try:
                with open(os.path.join(root, pid, "fdinfo", fd), encoding="utf-8", errors="replace") as f:
                    lines = f.read().splitlines()
            except OSError:
                continue
            client_id, device, busy = f"fd {fd}", "", 0
            for line in lines:
                key, _, value = line.partition(":")
                if key == "drm-driver" and value.strip():
                    drivers.add(value.strip())
                elif key == "drm-client-id" and value.strip():
                    client_id = value.strip()
                elif key == "drm-pdev" and value.strip():
                    device = value.strip()
                matched = _ENGINE.match(line)
                if matched:
                    busy += int(matched.group(1))
            identity = f"{device} {client_id}"  # a client id is unique only within its device
            clients[identity] = max(clients.get(identity, 0), busy)
        if not client:
            continue
        entry: dict[str, Any] = {}
        if drivers:
            entry["driver"] = ",".join(sorted(drivers))
        if any(clients.values()):
            entry["gpu_time_ns"] = sum(clients.values())
        found.append((int(pid), entry))
    detail = f"fd tables of {unreadable} process(es) unreadable (another user's)" if unreadable else ""
    return Found(name, "ran", detail, tuple(sorted(found)))


_CREATOR = re.compile(r'"IOUserClientCreator" = "pid ([0-9]+), ')
_GPU_TIME = re.compile(r'"accumulatedGPUTime"=([0-9]+)')


def probe_ioreg(binary: str, run: Runner) -> Found:
    name = "ioreg"
    path = shutil.which(binary)
    if path is None:
        return Found(name, "absent", f"no {binary}")
    rc, out = run([path, "-r", "-c", "IOGPUDeviceUserClient", "-l", "-w0"])
    if rc != 0:
        return Found(name, "failed", f"exit {rc}")
    times: dict[int, int] = {}
    for block in out.split("+-o "):
        creator = _CREATOR.search(block)
        if creator is None:
            continue
        pid = int(creator.group(1))
        times[pid] = times.get(pid, 0) + sum(int(n) for n in _GPU_TIME.findall(block))
    found = tuple((pid, {"gpu_time_ns": busy} if busy else {}) for pid, busy in sorted(times.items()))
    return Found(name, "ran", "", found)


# --- the process table ----------------------------------------------------------------------------


def process_table(run: Runner) -> dict[int, tuple[int, int]]:
    """Every process's (ppid, pgid), from ``ps``; empty when ps cannot answer."""
    rc, out = run(["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="])
    table: dict[int, tuple[int, int]] = {}
    if rc != 0:
        return table
    for line in out.splitlines():
        fields = line.split()
        if len(fields) == 3 and all(f.isdecimal() and f.isascii() for f in fields):
            table[int(fields[0])] = (int(fields[1]), int(fields[2]))
    return table


def own_tree(table: Mapping[int, tuple[int, int]], me: int, pgid: int | None,
             enclosing: int | None = None) -> set[int]:
    """THE HOLD'S OWN TREE: ``me``, its descendants, the command's group, and a nested hold's
    enclosing measurement group."""
    own = {me}
    children: dict[int, list[int]] = {}
    for child, (parent, _) in table.items():
        children.setdefault(parent, []).append(child)
    stack = [me]
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in own:
                own.add(child)
                stack.append(child)
    for group_id in (pgid, enclosing):
        if group_id is not None:
            own.update(pid for pid, (_, group) in table.items() if group == group_id)
            own.add(group_id)
    return own


def describe(pids: Sequence[int], run: Runner) -> dict[int, tuple[str, str]]:
    """(user, args) per pid, from ``ps``; a pid it no longer finds is missing."""
    if not pids:
        return {}
    rc, out = run(["ps", "-o", "pid=", "-o", "user=", "-o", "args=", "-p", ",".join(str(p) for p in sorted(set(pids)))])
    named: dict[int, tuple[str, str]] = {}
    if rc not in (0, 1):  # 1: some pid was not found
        return named
    for line in out.splitlines():
        fields = line.split(None, 2)
        if len(fields) >= 2 and fields[0].isdecimal() and fields[0].isascii():
            named[int(fields[0])] = (fields[1], (fields[2] if len(fields) > 2 else "")[:COMMAND_WIDTH])
    return named


# --- a snapshot -----------------------------------------------------------------------------------


def bounded_drm(root: str, timeout: float) -> Found:
    """``probe_drm`` in a daemon thread, given up on after ``timeout`` seconds: it reads files, not a
    subprocess's pipe, and a read under /proc that blocks must not hold the measurement (the thread
    is left blocked, and ends with the process)."""
    answer: list[Found] = []
    thread = threading.Thread(target=lambda: answer.append(probe_drm(root)), daemon=True)
    thread.start()
    thread.join(timeout)
    return answer[0] if answer else Found("drm-fdinfo", "failed", f"no answer after {timeout:g}s")


def probes(env: Mapping[str, str], run: Runner) -> list[Found]:
    return [
        probe_nvidia(env.get("FLEET_NVIDIA_SMI") or "nvidia-smi", run),
        bounded_drm(env.get("FLEET_DRM_PROC") or "/proc", PROBE_TIMEOUT),
        probe_ioreg(env.get("FLEET_IOREG") or "ioreg", run),
    ]


def snapshot(env: Mapping[str, str], event: str, request: str, box: str, me: int, pgid: int | None,
             run: Runner = run_bounded, enclosing: int | None = None) -> dict[str, Any]:
    """One line of the record: the probes' answers less the hold's own tree."""
    # The table before AND after the probes: a member of the hold's tree that ends while they run,
    # or one started while they run, is still known as the hold's own.
    table = process_table(run)
    answers = probes(env, run)
    own = own_tree(table, me, pgid, enclosing) | own_tree(process_table(run), me, pgid, enclosing)
    listed = [(answer.probe, pid, fields) for answer in answers for pid, fields in answer.processes]
    names = describe([pid for _, pid, _ in listed if pid not in own], run)
    processes: list[dict[str, Any]] = []
    for probe, pid, fields in listed:
        if pid in own:
            continue
        user, command = names.get(pid, ("", ""))
        processes.append({"pid": pid, "user": user, "command": command, "probe": probe, **fields})
    return {
        "request_id": request,
        "box": box,
        "hold_pid": me,
        "event": event,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "probes": [{"probe": a.probe, "status": a.status, "detail": a.detail} for a in answers],
        "gpu_processes": processes,
        "own_tree_gpu_processes": len({pid for _, pid, _ in listed if pid in own}),
    }


def record_path(directory: str, request: str) -> str:
    return os.path.join(directory, f"measurement.{request}.gpu.jsonl")


def append(path: str, line: dict[str, Any]) -> None:
    """One JSON line, in one write on an O_APPEND descriptor, so two holds never interleave a line. A
    short write (a full disk, a quota) is an OSError, as a failed one is: the hold then warns."""
    data = (json.dumps(line, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8", "surrogateescape")
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        written = os.write(descriptor, data)
    finally:
        os.close(descriptor)
    if written != len(data):
        raise OSError(f"short write: {written} of {len(data)} bytes, so the line is torn")


# --- the summary ----------------------------------------------------------------------------------


def read_lines(text: str) -> list[dict[str, Any]]:
    """The record's lines that parse as JSON objects; a torn or foreign line is skipped."""
    lines: list[dict[str, Any]] = []
    for raw in text.splitlines():
        try:
            decoded: Any = json.loads(raw)
        except ValueError:
            continue
        if isinstance(decoded, dict):
            lines.append(cast(dict[str, Any], decoded))
    return lines


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _processes(line: dict[str, Any]) -> list[dict[str, Any]]:
    items: Any = line.get("gpu_processes")
    if not isinstance(items, list):
        return []
    return [cast(dict[str, Any], p) for p in cast(list[Any], items) if isinstance(p, dict)]


def _name(process: dict[str, Any]) -> str:
    command = process.get("command")
    text = command if isinstance(command, str) and command else "(gone)"
    # The program's own name, not its install path: what precedes the first option, from its last
    # slash (a path may hold spaces, so the first word is not the program). Display only.
    program, dash, options = text.partition(" -")
    text = program.rsplit("/", 1)[-1] + dash + options
    if len(text) > 60:
        text = text[:57] + "..."
    user = process.get("user")
    return f"pid {process.get('pid')}" + (f" {user}" if isinstance(user, str) and user else "") + f" {text}"


def _shown(items: list[str]) -> str:
    if not items:
        return "none"
    more = f"; +{len(items) - SHOWN} more" if len(items) > SHOWN else ""
    return "; ".join(items[:SHOWN]) + more


def _weight(process: dict[str, Any]) -> tuple[int, int]:
    return (_int(process.get("gpu_memory_mib")) or 0, _int(process.get("gpu_time_ns")) or 0)


def describe_snapshot(line: dict[str, Any]) -> str:
    """``<n> [<pid> <user> <command> (<probe>[, <measure>]); ...]``, nvidia's and the busiest first,
    or ``none``, with the probes that ran (or why none did)."""
    processes = sorted(_processes(line), key=_weight, reverse=True)
    items: list[str] = []
    for process in processes:
        measure = ""
        memory, busy = _int(process.get("gpu_memory_mib")), _int(process.get("gpu_time_ns"))
        if memory is not None:
            measure = f", {memory} MiB"
        elif busy is not None:
            measure = f", {busy / 1e9:.2f} s cumulative GPU time as read"
        items.append(f"{_name(process)} ({process.get('probe')}{measure})")
    ran: list[str] = []
    for probe in cast(list[Any], line.get("probes")) if isinstance(line.get("probes"), list) else []:
        if isinstance(probe, dict):
            entry = cast(dict[str, Any], probe)
            if entry.get("status") != "absent":
                detail = entry.get("detail")
                ran.append(f"{entry.get('probe')} {entry.get('status')}" + (f": {detail}" if detail else ""))
    sources = ", ".join(ran) if ran else "no GPU probe could run here"
    count = f"{len(processes)} [{_shown(items)}]" if processes else "none"
    return f"{count} ({sources})"


def summary(lines: list[dict[str, Any]]) -> str:
    """The record, one clause per hold in the order the holds opened: what was on the GPU at its
    open and its close, and who used it in between. A hold with no ``closed`` line ended abnormally
    (killed outright, or the box went down). Lines are in the order they were appended, so a
    ``closed`` line belongs to the latest ``opened`` one of its ``hold_pid``: a pid the system
    reuses for a later hold opens a hold of its own. Cut at ``SUMMARY_WIDTH`` characters, naming
    how many holds it left out, since the payload that carries it travels as one argument."""
    holds: list[tuple[Any, dict[str, dict[str, Any]]]] = []
    latest: dict[Any, dict[str, dict[str, Any]]] = {}
    for line in lines:
        event, pid = line.get("event"), line.get("hold_pid")
        if event == "opened" or (event == "closed" and (pid not in latest or "closed" in latest[pid])):
            latest[pid] = {}
            holds.append((pid, latest[pid]))
        if event in ("opened", "closed"):
            latest[pid][cast(str, event)] = line
    clauses: list[str] = []
    for pid, events in holds:
        opened, closed = events.get("opened"), events.get("closed")
        clause = f"hold {pid}"
        if opened is not None:
            clause += f" opened {opened.get('at')}: {describe_snapshot(opened)}"
        if closed is None:
            clause += ("; its close is not recorded (the hold was still live when this was read, or did not"
                       " end normally)")
            clauses.append(clause)
            continue
        clause += f"; closed {closed.get('at')}: {describe_snapshot(closed)}"
        clauses.append(clause)
    if not clauses:
        return "no snapshot in it"
    text = " | ".join(clauses)
    if len(text) <= SUMMARY_WIDTH:
        return text
    kept = text[:SUMMARY_WIDTH]
    shown = kept.count(" | ") + 1
    return f"{kept}... [cut at {SUMMARY_WIDTH} characters: {len(clauses) - shown} later hold(s) not shown; the record has them]"


def opened_line(line: dict[str, Any]) -> str:
    """What the hold says on stderr at its start."""
    return f"GPU co-tenants at open: {describe_snapshot(line)}"


def closed_line(line: dict[str, Any]) -> str:
    """What the hold says on stderr at its end."""
    return f"GPU co-tenants at close: {describe_snapshot(line)}"
