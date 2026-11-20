"""Merge lease mutations on the fleet anchor, shipped by prreview/mergelease.py.

One stable flock serializes each repository's short transactions. The record is a single line
of token, PR number and anchor-clock expiry, separated by tabs. Only its current, unexpired token
can renew it. Expiry allows a new owner to take over atomically. Keep the flock file across release
so a waiter and its successor always lock the same inode.
"""

import fcntl
import os
import re
import stat
import sys
import tempfile
import time
from pathlib import Path

_RECORD = re.compile(rb"([a-f0-9]{32})\t([0-9]{1,12})\t([0-9]{1,12})\n")
_REPO = re.compile(r"([a-z0-9_.-]+)/([a-z0-9_.-]+)")


def _read(path: Path) -> tuple[str, str, int] | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError("lease record is not a regular file")
        record = _RECORD.fullmatch(file.read(80))
    if record is None:
        raise ValueError("lease record is malformed")
    return record[1].decode(), record[2].decode(), int(record[3])


def _publish(record: Path, token: str, pr: str, expires: int) -> None:
    fd, staged = tempfile.mkstemp(dir=record.parent, prefix=".lease-")
    try:
        with os.fdopen(fd, "w", encoding="ascii") as file:
            file.write(f"{token}\t{pr}\t{expires}\n")
        os.replace(staged, record)
    finally:
        Path(staged).unlink(missing_ok=True)


def change(state: Path, action: str, repo: str, token: str, pr: str, ttl: int) -> str:
    """One transaction. Answers are exact action-specific words with a PR on held or takeover."""
    name = _REPO.fullmatch(repo.lower())
    if name is None or not _RECORD.fullmatch(f"{token}\t{pr}\t{ttl}\n".encode()) or ttl < 1:
        raise ValueError("invalid merge lease identity or expiry")
    directory = state / "merge-leases" / f"owner-{name[1]}"
    directory.mkdir(parents=True, exist_ok=True)
    record = directory / f"{name[2]}.lease"
    fd = os.open(directory / f"{name[2]}.lock", os.O_CREAT | os.O_RDONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "rb") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("lease lock is not a regular file")
        fcntl.flock(lock, fcntl.LOCK_EX)
        held = _read(record)
        now = int(time.time())
        ours = held is not None and held[0] == token
        if action == "release":
            if ours:
                record.unlink()
            return "released"
        if action == "renew":
            if held is None or not ours or held[2] <= now:
                return "lost"
            _publish(record, token, pr, now + ttl)
            return "renewed"
        if action != "take":
            raise ValueError("unknown merge lease action")
        if held is not None and held[2] > now and not ours:
            return f"held\t{held[1]}"
        _publish(record, token, pr, now + ttl)
        return f"taken\t{held[1]}" if held is not None and not ours else "taken"


if __name__ == "__main__":
    state, action, repo, token, pr, ttl = sys.argv[1:]
    try:
        print(change(Path(state), action, repo, token, pr, int(ttl)))
    except (OSError, ValueError) as exc:
        print(f"merge lease anchor: {exc}", file=sys.stderr)
        sys.exit(1)
