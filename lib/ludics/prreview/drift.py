"""How far a PR's branch has drifted from its base: the read ``merge`` prints right before its call.

Ported from pr-review.sh's ``warn_base_drift`` with ``compare_hunks`` and ``compare_file_set``
(ludics-lite#44, #54, #63, #84, and the ahrefs/ocannl#861 roll-forward decision that made it a
WARNING). The base's tip is read from the branch, never from the PR's ``base.sha`` snapshot; both
compares are anchored on that one tip; an overlapping path is split by whether the two sides' hunks
meet, and a patch that cannot be read hunk by hunk is UNREAD, never disjoint. A read that could not
be completed prints UNKNOWN and is never "not behind" or "none".

``watch`` reads the same thing at the end of a round (``watch_drift_note``), all of it on stderr
there; this module is the one port of the function both call. ``read_base_drift`` is it with what
it established handed back (``Drift``), which ``merge``'s build of the would-be merge commit is
decided on (mergebuild.py, ludics-lite#611).
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import cast

from ludics import cli
from ludics.prreview.core import PROG, GhOk, GhSession, Json
from ludics.prreview.core import warn as core_warn
from ludics.prreview.shtext import JqError, encode_ref, is_number, jq_compact, jq_get, tab_fields

_HUNK = re.compile(r"^@@ -(?P<s>[0-9]+)(,(?P<n>[0-9]+))? \+[0-9]+(,(?P<m>[0-9]+))? @@")

type Ranges = list[tuple[int, int]]


def _ranges(entry: Json) -> Ranges | None:
    """``compare_hunks``' ``ranges``: the old-side ranges of one file's patch, or None (unread)."""
    if not isinstance(entry, dict):
        return None
    patch = entry.get("patch")
    additions = entry.get("additions")
    deletions = entry.get("deletions")
    if not isinstance(patch, str) or not is_number(additions) or not is_number(deletions):
        return None
    lines = patch.split("\n")
    if sum(1 for line in lines if line.startswith("+")) != additions:
        return None
    if sum(1 for line in lines if line.startswith("-")) != deletions:
        return None
    ranges: Ranges = []
    cur: list[int] | None = None
    ok = True
    for line in lines:
        m = _HUNK.match(line)
        if m is not None:
            if cur is not None and (cur[0] != 0 or cur[1] != 0):
                ok = False
            s = int(m.group("s"))
            n = 1 if m.group("n") is None else int(m.group("n"))
            mm = 1 if m.group("m") is None else int(m.group("m"))
            ranges.append((s, s + 1) if n == 0 else (s, s + n - 1))
            cur = [n, mm]
        elif cur is None:
            continue
        elif line.startswith("-"):
            cur[0] -= 1
        elif line.startswith("+"):
            cur[1] -= 1
        elif line.startswith(" "):
            cur[0] -= 1
            cur[1] -= 1
    if ok and ranges and cur is not None and cur[0] == 0 and cur[1] == 0:
        return ranges
    return None


def compare_hunks(doc: Json) -> dict[str, Ranges | None] | None:
    """``compare_hunks``: each file's ranges by path (None for a file whose hunks are unread); None
    when the response has no file list to read."""
    files = jq_get(doc, "files") if isinstance(doc, (dict, type(None))) else None
    if not isinstance(files, list):
        return None
    out: dict[str, Ranges | None] = {}
    for entry in files:
        if not isinstance(entry, dict):
            return None
        name = entry.get("filename")
        out[name if isinstance(name, str) else jq_compact(name)] = _ranges(entry)
    return out


def compare_file_set(doc: Json) -> tuple[int, list[str]] | None:
    """``compare_file_set``: the file count and every path (old names of renames included), or
    None for a missing or malformed file list."""
    if not isinstance(doc, dict):
        return None
    files = doc.get("files")
    if not isinstance(files, list):
        return None
    paths: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict):
            return None
        name = entry.get("filename")
        if not isinstance(name, str) or not name:
            return None
        if "previous_filename" in entry:
            prev = entry["previous_filename"]
            if prev is not None and (not isinstance(prev, str) or not prev):
                return None
            if isinstance(prev, str):
                paths.add(prev)
        paths.add(name)
    return len(files), sorted(paths)


def _count(doc: Json, key: str) -> int | None:
    """``.<key> | numbers | select(. >= 0 and floor == .)``: a whole, nonnegative count."""
    value = doc.get(key) if isinstance(doc, dict) else None
    if not is_number(value):
        return None
    number = cast(float, value)
    if number < 0 or not float(number).is_integer():
        return None
    return int(number)


def _merge_base(doc: Json) -> str | None:
    try:
        value = jq_get(doc, "merge_base_commit", "sha")
    except JqError:
        return None
    return value if isinstance(value, str) and value else None


def _meets(a: Ranges, b: Ranges) -> bool:
    return any(lo <= xhi + 1 and xlo <= hi + 1 for (xlo, xhi) in a for (lo, hi) in b)


@dataclass(frozen=True)
class Drift:
    """What one drift read established, for ``merge``'s build of the would-be merge commit
    (mergebuild.py): ``rc`` is ``warn_base_drift``'s status; ``base_ref``, ``head_sha`` and
    ``base_sha`` are None where they were not read; ``overlap`` is the exact intersection of the
    paths the PR and the base's advance changed (old names of renames included), or None for
    UNKNOWN -- never "none"; ``renamed`` maps each name a rename on either side touched to the
    other name of that rename, so a path in the overlap can be judged by where its content went;
    ``pr_paths`` and ``base_paths`` are the two sides the overlap intersects (the PR's changes and
    the base's advance since their merge base, old names of renames included), None exactly when
    ``overlap`` is (a build's ``trigger any-input`` reads them)."""

    rc: int
    base_ref: str | None = None
    head_sha: str | None = None
    base_sha: str | None = None
    overlap: list[str] | None = None
    renamed: dict[str, list[str]] = field(default_factory=lambda: dict[str, list[str]]())
    pr_paths: list[str] | None = None
    base_paths: list[str] | None = None


def warn_base_drift(
    session: GhSession,
    repo: str,
    pr: str,
    stale_base: int | None,
    *,
    say: Callable[[str], None] = cli.say,
    err: Callable[[str], None] | None = None,
) -> int:
    """``warn_base_drift``: ``read_base_drift``'s status."""
    return read_base_drift(session, repo, pr, stale_base, say=say, err=err).rc


def read_base_drift(
    session: GhSession,
    repo: str,
    pr: str,
    stale_base: int | None,
    *,
    say: Callable[[str], None] = cli.say,
    err: Callable[[str], None] | None = None,
) -> Drift:
    """``warn_base_drift``: the count and the overlap, said on stdout (and loudly on stderr where it
    is to be acted on). Status 0 nothing to act on; 1 a warning (stale, conflicted, or an overlap
    whose hunks meet or are unread); 3 the count or the overlap is UNKNOWN. Never a gate.

    ``say`` takes what the shell printed on stdout and ``err`` (``warn`` by default) its stderr
    lines, ``pr-review.sh: `` included: a ``watch`` round passes one stderr writer for both, so
    the round's stdout stays poll's."""

    def warn(*parts: str) -> None:
        if err is None:
            core_warn(*parts)
        else:
            err(f"{PROG}: {' '.join(parts)}")

    fields = session.retry(
        "read",
        [
            "api",
            f"repos/{repo}/pulls/{pr}",
            "--jq",
            '[(.base.ref // "-"), (.head.sha // "-"), (.mergeable_state // "-")] | @tsv',
        ],
    )
    base, head_sha, mstate = tab_fields(fields.stdout if isinstance(fields, GhOk) else "", 3)
    if not isinstance(fields, GhOk) or base in ("", "-") or head_sha in ("", "-"):
        warn(
            f"how far {repo}#{pr} is behind its base: UNKNOWN — the PR could not be read",
            f"({session.err_line()}). This is not 'not behind': check it by hand before merging",
            "and do not assume the base-drift file overlap is empty.",
        )
        say(f"base-drift file overlap {repo}#{pr}: UNKNOWN — the PR snapshot could not be read")
        return Drift(3)
    tip = session.retry("read", ["api", f"repos/{repo}/commits/{encode_ref(base)}", "--jq", ".sha"])
    if not isinstance(tip, GhOk) or not tip.stdout:
        warn(
            f"how far {repo}#{pr} is behind {base}: UNKNOWN — the tip of {base} could not be read",
            f"({session.err_line()}). This is not 'not behind': check it by hand before merging",
            "and do not assume the base-drift file overlap is empty.",
        )
        say(f"base-drift file overlap {repo}#{pr}: UNKNOWN — the tip of {base} could not be read")
        return Drift(3, base, head_sha)
    base_sha = tip.stdout
    dirty_warn = mstate == "dirty"
    if dirty_warn:
        say(f"!!! {repo}#{pr} CONFLICTS with {base} (mergeable_state=dirty): GitHub cannot build head")
        say(f"!!! {head_sha[:7]} merged with the current {base}, so no pull_request run tests that merge")
        say(f"!!! and the merge will be refused. Merge {base} in, resolve, push, and let the checks run")
        say("!!! on the resolution.")
    forward_r = session.retry("read", ["api", f"repos/{repo}/compare/{base_sha}...{head_sha}?per_page=1"])
    if not isinstance(forward_r, GhOk):
        warn(
            f"how far {repo}#{pr} is behind {base}: UNKNOWN — the compare call did not answer",
            f"({session.err_line()}). The base-drift file overlap is UNKNOWN too, not none; retry before",
            "merging.",
        )
        say(f"base-drift file overlap {repo}#{pr}: UNKNOWN — the forward compare call did not answer")
        return Drift(3, base, head_sha, base_sha)
    forward = _parse(forward_r.stdout)
    count_unknown = False
    overlap_unknown = False
    overlap_reason = ""
    behind = _count(forward, "behind_by")
    if behind is None:
        count_unknown = True
    ahead_n = _count(forward, "ahead_by")
    ahead = "?" if ahead_n is None else str(ahead_n)
    forward_base = _merge_base(forward)
    if forward_base is None:
        overlap_unknown = True
    forward_set = compare_file_set(forward)
    if forward_set is None:
        overlap_unknown = True
    reverse: Json = None
    reverse_base: str | None = None
    reverse_set: tuple[int, list[str]] | None = None
    reverse_r = session.retry("read", ["api", f"repos/{repo}/compare/{head_sha}...{base_sha}?per_page=1"])
    if not isinstance(reverse_r, GhOk):
        overlap_unknown = True
        overlap_reason = f"the reverse compare call did not answer ({session.err_line()})"
    else:
        reverse = _parse(reverse_r.stdout)
        reverse_base = _merge_base(reverse)
        if reverse_base is None:
            overlap_unknown = True
        reverse_set = compare_file_set(reverse)
        if reverse_set is None:
            overlap_unknown = True
    if not overlap_unknown and forward_base != reverse_base:
        overlap_unknown = True
        overlap_reason = "the two compare calls reported different merge bases"
    overlap: list[str] = []
    if not overlap_unknown and forward_set is not None and reverse_set is not None:
        if forward_set[0] >= 300 or reverse_set[0] >= 300:
            overlap_unknown = True
            overlap_reason = "a compare file list reached GitHub's 300-file cap and may be truncated"
        else:
            base_paths = set(reverse_set[1])
            overlap = sorted({p for p in forward_set[1] if p in base_paths})
    meet: list[str] = []
    unread: list[str] = []
    disjoint: list[str] = []
    if not overlap_unknown and overlap:
        pr_hunks = compare_hunks(forward) or {}
        base_hunks = compare_hunks(reverse) or {}
        for path in overlap:
            a = pr_hunks.get(path)
            b = base_hunks.get(path)
            if a is None or b is None:
                unread.append(path)
            elif _meets(a, b):
                meet.append(path)
            else:
                disjoint.append(path)
    meeting = meet + unread
    count_warn = False
    if count_unknown:
        warn(
            f"how far {repo}#{pr} is behind {base}: UNKNOWN — the compare response did not contain a",
            "valid behind_by count. This is not 'not behind'.",
        )
    elif stale_base is None:
        pass
    elif behind is not None and behind < stale_base:
        say(f"base freshness {repo}#{pr}: {behind} commit(s) behind {base}, {ahead} ahead (warns at {stale_base})")
    else:
        count_warn = True
        say(f"!!! {repo}#{pr} is {behind} COMMITS BEHIND its base ({base}).")
        say("!!! The review that approved this branch, and the checks that went green on it, both judged")
        say(f"!!! it against a base that has since moved {behind} commits. Under the roll-forward policy")
        say("!!! (ahrefs/ocannl#861) this does NOT block a clean merge — the post-merge integration loop")
        say("!!! re-runs the full suites on merged master — but a clean 'mergeable' says only that the")
        say("!!! two texts do not collide. Read the base-drift file intersection printed below.")
    if overlap_unknown:
        reason = overlap_reason or "a compare response was incomplete or invalid"
        say(f"base-drift file overlap {repo}#{pr}: UNKNOWN — {reason}")
        warn(f"BASE-DRIFT FILE OVERLAP UNKNOWN for {repo}#{pr} — this is not 'none'; retry the merge", "read.")
    elif not overlap:
        say(f"base-drift file overlap {repo}#{pr}: none")
    elif not meeting:
        say(
            f"base-drift file overlap {repo}#{pr}: {len(overlap)} path(s) changed on both sides, all in"
            " DISJOINT hunks (the base's lines and this PR's do not meet, which git merges by"
            f" construction): {_json_list(disjoint)}"
        )
    else:
        say(
            "!!! BASE-DRIFT FILE OVERLAP: the base's advance touched the SAME REGIONS of"
            f" {len(meeting)} path(s) changed by"
        )
        say(f"!!! {repo}#{pr}: {_json_list(meeting)}")
        if unread:
            say(
                f"!!! (hunks unread for {len(unread)} of them — patch missing or unreadable in the compare response,"
                f" so counted as meeting: {_json_list(unread)})"
            )
        if disjoint:
            say(f"!!! and {len(disjoint)} more path(s) in disjoint hunks only: {_json_list(disjoint)}")
        say("!!! Merging under the roll-forward policy (ahrefs/ocannl#861): a clean merge proceeds on")
        say(f"!!! the run that went green, and the post-merge integration loop verifies merged {base}.")
        say("!!! Read those files for semantic drift. The overlap is not a reason to rebase: rebase")
        say(f"!!! (or merge {base} in) only to resolve a conflict.")
        warn(
            f"BASE-DRIFT FILE OVERLAP for {repo}#{pr} in the same regions: {_json_list(meeting)} — noted"
            " even below SHIP_PR_STALE_BASE; it does not block the merge under the roll-forward policy."
        )
    if count_warn:
        warn(
            f"MERGING A STALE BRANCH: {repo}#{pr} is {behind} commits behind {base} (warns at {stale_base},",
            "SHIP_PR_STALE_BASE) — a clean merge is the policy (roll-forward, ahrefs/ocannl#861).",
        )
    if dirty_warn:
        warn(
            f"{repo}#{pr} CONFLICTS with {base} (mergeable_state=dirty): nothing tests this head merged",
            f"with the current {base} while GitHub cannot build that merge — merge {base} in first.",
        )
    known = None if overlap_unknown else overlap
    renamed = _renames(forward, reverse) if not overlap_unknown else {}
    sides = (forward_set[1], reverse_set[1]) if not overlap_unknown and forward_set and reverse_set else (None, None)
    rc = 3 if count_unknown or overlap_unknown else 1 if count_warn or dirty_warn or meeting else 0
    return Drift(rc, base, head_sha, base_sha, known, renamed, *sides)


def _renames(*docs: Json) -> dict[str, list[str]]:
    """Each name a rename entry of the compare responses touched, mapped to its other names."""
    out: dict[str, list[str]] = {}
    entries: list[Json] = []
    for doc in docs:
        files = doc.get("files") if isinstance(doc, dict) else None
        entries.extend(files if isinstance(files, list) else [])
    for entry in entries:
        if isinstance(entry, dict):
            name, prev = entry.get("filename"), entry.get("previous_filename")
            if isinstance(name, str) and isinstance(prev, str) and name and prev:
                out.setdefault(name, []).append(prev)
                out.setdefault(prev, []).append(name)
    return out


def _parse(text: str) -> Json:
    try:
        return cast(Json, json.loads(text))
    except ValueError:
        return None


def _json_list(paths: list[str]) -> str:
    return jq_compact(cast(Json, paths))
