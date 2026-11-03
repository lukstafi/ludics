"""The fleet roster the prompts state in prose, held to ``DEFAULT_BOXES`` (#853).

73f57dcb added ``macbook-pro`` to the worker's default roster, and the two prompts that list the
roster by name stayed as they were: the daily planner had no box name to place an issue on the
MacBook, and nothing failed. The prompts need the names in prose, so the lists are pinned rather
than derived: every box of the default roster appears in each list, and nothing else does.

The boundary is a fail-closed allowlist. What this reads, and nothing else:

- the roster: the ONE line of ``ROSTER_SOURCE`` that is exactly ``DEFAULT_BOXES = "<words>"`` at
  column zero, a plain double-quoted literal (no quote or backslash inside), its blank-separated
  words the boxes. No such line, two of them, or an empty value is a refusal, not a pass.
- the two anchors in ``ROSTER_LISTS``, each of which must occur exactly once in its file: the
  planner's ``home-box field on every item: exactly one of`` (its words may wrap across lines), and
  issue-wave's bullet opening ``- **The fleet**:`` at column zero. A file that is missing, or an
  anchor that is absent or repeated, is a refusal.
- after each anchor, the rest of its SENTENCE: up to the first ``.`` outside parentheses and code
  spans that is followed by a blank or ends the file, or up to a blank line, whichever is first.
- in that sentence, the single-backtick code spans at parenthesis depth zero: each one's whole text
  is a box name. A span inside parentheses (issue-wave's `gfx1151`) is a description, not a box.

What it deliberately does not read: any other mention of a box, in these files or elsewhere; the
roster's other restatements (``fleet-worker.sh``'s ``DEFAULT_BOXES``, ``install-linux.sh``'s
``site_boxes``); a site's ``FLEET_BOXES``; ``-wsl`` aliases; Markdown block structure (a fence or
a comment inside the sentence is read as text). A sentence this reader cannot walk -- an unclosed
code span or parenthesis, a stray ``)`` -- is refused rather than read loosely. Names compare as
sets: order and repetition are the prose's own.
"""

import re
from dataclasses import dataclass

from ludics.checkprompts.bytes_view import WS, WS_CLASS, records, ws_split
from ludics.checkprompts.tree import Report, Tree

ROSTER_SOURCE = "lib/ludics/fleetworker/config.py"
ROSTER_LINE = re.compile(r'DEFAULT_BOXES = "([^"\\]*)"' + WS_CLASS + "*")
_W = WS_CLASS + "+"


@dataclass(frozen=True)
class RosterList:
    file: str
    label: str
    anchor: re.Pattern[str]
    shown: str  # the anchor as a refusal names it


ROSTER_LISTS = (
    RosterList(
        "routines/daily-issue-planning/SKILL.md",
        "the home-box sentence",
        re.compile(_W.join(("home-box", "field", "on", "every", "item:", "exactly", "one", "of"))),
        "home-box field on every item: exactly one of",
    ),
    RosterList(
        "issue-wave/SKILL.md",
        "the fleet bullet",
        re.compile(r"^- \*\*The fleet\*\*:", re.M),
        "- **The fleet**:",
    ),
)


def roster_of(text: str) -> list[str] | None:
    """The boxes of the one ``DEFAULT_BOXES = "..."`` line, or None when there is not exactly one
    such line or its value names no box."""
    found = [m.group(1) for line in records(text) if (m := ROSTER_LINE.fullmatch(line)) is not None]
    if len(found) != 1:
        return None
    boxes = [w for w in ws_split(found[0]) if w]
    return boxes or None


def _blank_line_at(text: str, i: int) -> bool:
    """Whether the LF at ``i`` ends a paragraph: only blanks stand between it and the next LF (or
    the end of the text)."""
    j = i + 1
    while j < len(text) and text[j] != "\n":
        if text[j] not in WS:
            return False
        j += 1
    return True


def stated_boxes(text: str, start: int) -> list[str] | str:
    """The code spans at parenthesis depth zero in the sentence that runs from ``start``, or the
    reason the sentence cannot be read."""
    names: list[str] = []
    depth = 0
    code = -1  # where the open code span's text starts, or -1 outside one
    i = start
    while i < len(text):
        c = text[i]
        if c == "\n" and _blank_line_at(text, i):
            break
        if code >= 0:
            if c == "`":
                if depth == 0:
                    names.append(text[code:i])
                code = -1
        elif c == "`":
            code = i + 1
        elif c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                return "a ')' with no '(' before it"
            depth -= 1
        elif c == "." and depth == 0 and (i + 1 == len(text) or text[i + 1] in WS):
            break
        i += 1
    if code >= 0:
        return "a code span that never closes"
    if depth:
        return "a '(' that never closes"
    return names


def check_roster(report: Report, tree: Tree) -> None:
    # A root without the worker's configuration has no default roster, so it carries no obligation.
    if not tree.is_file(ROSTER_SOURCE):
        return
    roster = roster_of(tree.read(ROSTER_SOURCE) or "")
    if roster is None:
        report.ko(ROSTER_SOURCE, 'has no one line DEFAULT_BOXES = "<boxes>" to read the roster from')
        return
    want = set(roster)
    shown = " ".join(roster)
    bad = False
    for lst in ROSTER_LISTS:
        text = tree.read(lst.file) if tree.is_file(lst.file) else None
        if text is None:
            report.ko(lst.file, f"is missing; it states the fleet roster in {lst.label}")
            bad = True
            continue
        hits = list(lst.anchor.finditer(text))
        if len(hits) != 1:
            how = "has no" if not hits else f"has {len(hits)} of"
            report.ko(lst.file, f"{how} '{lst.shown}' to read {lst.label} from (#853)")
            bad = True
            continue
        stated = stated_boxes(text, hits[0].end())
        if isinstance(stated, str):
            report.ko(lst.file, f"{lst.label} cannot be read: {stated}")
            bad = True
            continue
        got = set(stated)
        for box in sorted(got - want):
            report.ko(
                lst.file, f"{lst.label} names `{box}`, which {ROSTER_SOURCE}'s DEFAULT_BOXES ({shown}) does not"
            )
            bad = True
        for box in sorted(want - got):
            report.ko(lst.file, f"{lst.label} leaves out `{box}`, which {ROSTER_SOURCE}'s DEFAULT_BOXES lists")
            bad = True
    if not bad:
        report.ok(f"the planner's home-box list and issue-wave's fleet list name DEFAULT_BOXES: {shown}")
