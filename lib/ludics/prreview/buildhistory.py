"""How long ``merge``'s builds of a repository's command have taken on this box (#982), and what an
overrun says from it.

Why. ahrefs/ocannl#1735's merge build hit its 1200 s bound, the refusal said ``Re-run merge, or raise
the timeout``, and the worker re-ran it until told not to: nothing said the bound was already tight,
though the wave had seen a 1145 s pass. The build's output says how far it got (mergebuild.py prints
the tail); this module is the other half, what the same command has taken before.

THE RECORD. One JSON line per build that ended with a duration worth keeping, appended to
``merge-builds/<owner>--<name>.jsonl`` under pr-review's state directory (``budget.budget_dir``), so
per box: a duration is this box's, under this box's load. Its fields: ``at`` (UTC, ISO 8601),
``command`` (a digest of the config's command), ``outcome``, ``seconds`` (the command's own run,
slot and window waits left out) and ``bound`` (the ``timeout`` it ran under). ``outcome`` is
``passed`` or ``overran``. A build that failed is not recorded: it stops at its failure, so its
duration says nothing of how long the command takes.

THE TIER -- the boundary. A repository's command is one opaque string, and which tiers it runs is
its own choice (mergebuild.py, THE COMMAND'S CONTRACT), so "what this tier took before" is read as
"what this command took before", on this box: a command whose cheap and dear tiers both pass shows
its dear tier as the slowest pass, and one whose dear tier has never passed here shows only its cheap
one. The advice says so, and the tail of the output names the tier where the command does. No tier
is read from the log: its wording is the project's.

THE READER, a fail-closed allowlist: the file's last ``READ_BYTES`` (the first line of a cut read is
dropped) and in them the lines that are one JSON object with the fields above, of their types, whose
``command`` is this command's. Any other line is skipped. A file that cannot be read is no history.
This all informs a message, so it is fail-open both ways: a write that fails is dropped, and neither
a read nor a write ever changes a merge's verdict. Nothing trims the file: a line is about 120
bytes, and only the tail is ever read.

THE ADVICE (``overrun_advice``). A re-run LIKELY REPEATS the overrun when an earlier run overran a
bound at least this high, or when the slowest pass took ``TIGHT`` or more of the bound: the bound is
then that close to the command's honest time, so load alone can put it over. Otherwise, with passes
on record, this overrun is out of line for the command; with none, nothing is known, and it says so.
It is advice in the refusal's words, never a gate: nothing refuses a re-run.
"""

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, cast

from ludics.prreview.budget import budget_dir

READ_BYTES = 64 * 1024
TIGHT = 0.8  # THE ADVICE: a slowest pass at this share of the bound or more leaves no room for load

type Outcome = Literal["passed", "overran"]


@dataclass(frozen=True)
class Row:
    outcome: Outcome
    seconds: int
    bound: int


def _path(repo: str) -> str | None:
    """The repository's file; None with no state directory (``budget_dir``: a fixture suite that
    named none) or no repository (a dry run under ``--config`` alone): no history, then."""
    state = budget_dir(os.environ)
    return os.path.join(state, "merge-builds", repo.replace("/", "--") + ".jsonl") if state and repo else None


def _digest(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8", "surrogateescape")).hexdigest()[:16]


def _row(line: str, digest: str) -> Row | None:
    """The line's row (the module's READER), or None."""
    try:
        decoded: Any = json.loads(line)
    except (ValueError, RecursionError):
        return None
    if not isinstance(decoded, dict):
        return None
    fields = cast(dict[str, Any], decoded)
    outcome, seconds, bound = fields.get("outcome"), fields.get("seconds"), fields.get("bound")
    if fields.get("command") != digest or not isinstance(fields.get("at"), str):
        return None
    if type(seconds) is not int or type(bound) is not int or seconds < 0 or bound < 1:
        return None
    if outcome == "passed":
        return Row("passed", seconds, bound)
    if outcome == "overran":
        return Row("overran", seconds, bound)
    return None


def read(repo: str, command: str) -> list[Row]:
    """This command's rows on this box, oldest first (the module's READER)."""
    path = _path(repo)
    if path is None:
        return []
    try:
        with open(path, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            handle.seek(max(size - READ_BYTES, 0))
            data = handle.read(READ_BYTES)
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").split("\n")
    digest = _digest(command)
    return [row for line in (lines[1:] if size > READ_BYTES else lines) if (row := _row(line, digest))]


def record(repo: str, command: str, outcome: Outcome, seconds: int, bound: int) -> None:
    """Append one row, in one write (the module's THE RECORD); a failure is dropped."""
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = json.dumps({"at": at, "command": _digest(command), "outcome": outcome, "seconds": seconds, "bound": bound})
    path = _path(repo)
    if path is None:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(descriptor, (line + "\n").encode("utf-8"))
        finally:
            os.close(descriptor)
    except OSError:
        pass


def overrun_advice(earlier: list[Row], bound: int, config_file: str) -> list[str]:
    """What the refusal says of an overrun of ``bound`` (the module's THE ADVICE): the record, then
    whether a re-run is likely to repeat it. ``earlier`` is the rows from before this overrun."""
    passes = [row.seconds for row in earlier if row.outcome == "passed"]
    overran = [row for row in earlier if row.outcome == "overran" and row.bound >= bound]
    raising = f"raise `timeout` in {config_file} on the default branch, to fit the slowest honest run"
    if not earlier:
        return [
            "No earlier build of this command is on record on this box, so whether a re-run repeats this overrun is",
            f"unknown. Read the output above before spending another {bound}s: if it was still working, {raising}.",
        ]
    slowest = max(passes, default=0)
    shown = f"{len(passes)} passed" + (f", slowest {slowest}s, last {passes[-1]}s" if passes else "")
    said = [f"Earlier builds of this command on this box: {shown}; {len(overran)} overran a bound of {bound}s or more."]
    if overran or slowest >= TIGHT * bound:
        why = [] if not overran else [f"{len(overran)} earlier overrun(s)"]
        why += [f"the slowest pass took {slowest * 100 // bound}% of the bound"] if slowest >= TIGHT * bound else []
        return [*said, f"A re-run will likely repeat this overrun ({' and '.join(why)}): do not re-run it as it stands;", f"{raising}."]
    if passes:
        return [
            *said,
            f"This overrun is out of line for the command (the slowest pass took {slowest * 100 // bound}% of the bound),",
            "unless it ran a heavier selection than those: the output above says how far it got. One re-run may pass;",
            f"a second overrun here will say to {raising}.",
        ]
    return [*said, "No pass is on record to compare it with, so whether a re-run repeats it is unknown."]
