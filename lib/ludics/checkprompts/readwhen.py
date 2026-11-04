"""ship-pr's staged reading list, held to ship-pr/SKILL.md's own headings.

ship-pr/SKILL.md is about 1600 lines, and a worker reads it in stages: the sections its preamble's
"What to read when" paragraph names, each where it acts. That list used to live only in
issue-wave's brief text, and renaming a ship-pr heading broke it in silence (t948's worker checked
the six names by hand, ludics#949). This pins that each section the list names, and each one
issue-wave's Landing bullet names beside its pointer to the list, is a heading of the file.

The boundary is a fail-closed allowlist. What this reads, and nothing else:

- in ``READ_WHEN_FILE``, the ONE paragraph whose first line opens, at column zero, with
  ``**What to read when.**``, from that line up to the first blank line (or the end of the file).
  No such line, or two of them, is a refusal. The paragraph must name at least one section: an
  emptied list is a refusal, not a pass.
- in ``POINTER_FILE``, when that file exists, the ONE bullet whose first line opens, at column
  zero, with ``- Landing:``: that line and each following line that opens with a blank and is not
  blank itself, up to the first line that is not. No such line, or two of them, is a refusal. A
  bullet that names no section passes: the pointer need not name any.
- in those two spans, the italic spans: a single ``*`` that is not part of a run of two or more
  ``*`` opens one, and the next such single ``*`` closes it. A run of two or more ``*`` (bold) is
  a delimiter this does not read as italic. Inside a single-backtick code span no ``*`` counts,
  and a code span inside an italic span is part of its text. Every italic span is a section name:
  each blank run in it (a line break and the next line's indentation included) reads as one space,
  and the result must equal the text of a heading exactly.
- the headings of ``READ_WHEN_FILE``: each line outside a backtick fence (a line opening with up to
  three blanks and three or more backticks opens one, and the next such line closes it) that opens
  at column zero with one to six ``#`` and then one or more blanks. The heading's text is the rest
  of the line, trailing blanks dropped; a closing ``#`` sequence is part of it, and the file
  writes none.

What it deliberately does not read: any other citation of a ship-pr section, in these files or
elsewhere (prose naming a section in quotes, a section cited in another paragraph); ``_italic_``
spans; italic used for emphasis inside the two spans (it is read as a section name and refused);
whether a named section is the right one to read at that stage, which stays the review question.
A span this reader cannot walk -- an italic or code span that never closes -- is refused rather
than read loosely.
"""

import re

from ludics.checkprompts.bytes_view import WS, WS_CLASS, records
from ludics.checkprompts.tree import Report, Tree

READ_WHEN_FILE = "ship-pr/SKILL.md"
READ_WHEN_LEAD = "**What to read when.**"
POINTER_FILE = "issue-wave/SKILL.md"
POINTER_LEAD = "- Landing:"

HEADING = re.compile(r"#{1,6}" + WS_CLASS + "+(.*)")
FENCE = re.compile(r" {0,3}`{3,}")
BLANK_RUN = re.compile(WS_CLASS + "+")
TRAILING_BLANKS = re.compile(WS_CLASS + r"+\Z")


def headings(text: str) -> set[str]:
    """The text of every ATX heading outside a backtick fence, trailing blanks dropped."""
    found: set[str] = set()
    fenced = False
    for line in records(text):
        if FENCE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        m = HEADING.fullmatch(line)
        if m is not None:
            found.add(TRAILING_BLANKS.sub("", m.group(1)))
    return found


def blank(line: str) -> bool:
    return all(c in WS for c in line)


def paragraph(lines: list[str], at: int) -> str:
    """The lines from ``at`` up to the first blank one."""
    end = at + 1
    while end < len(lines) and not blank(lines[end]):
        end += 1
    return "\n".join(lines[at:end])


def bullet(lines: list[str], at: int) -> str:
    """The line at ``at`` and each following one that opens with a blank and is not blank."""
    end = at + 1
    while end < len(lines) and lines[end][:1] in (" ", "\t") and not blank(lines[end]):
        end += 1
    return "\n".join(lines[at:end])


def italic_spans(text: str) -> list[str] | str:
    """Each italic span's text, blank runs read as one space, or the reason the text cannot be
    walked."""
    names: list[str] = []
    italic = -1  # where the open italic span's text starts, or -1 outside one
    code = False
    i = 0
    while i < len(text):
        c = text[i]
        if code:
            code = c != "`"
            i += 1
            continue
        if c == "`":
            code = True
            i += 1
            continue
        if c == "*":
            j = i
            while j < len(text) and text[j] == "*":
                j += 1
            if j - i == 1:
                if italic < 0:
                    italic = j
                else:
                    names.append(BLANK_RUN.sub(" ", text[italic:i]))
                    italic = -1
            i = j
            continue
        i += 1
    if code:
        return "a code span that never closes"
    if italic >= 0:
        return "an italic span that never closes"
    return names


def lead_line(lines: list[str], lead: str) -> int | str:
    """The index of the one line opening with ``lead``, or the reason there is not exactly one."""
    hits = [i for i, line in enumerate(lines) if line.startswith(lead)]
    if len(hits) == 1:
        return hits[0]
    return f"has no line opening with '{lead}'" if not hits else f"has {len(hits)} lines opening with '{lead}'"


def check_reading_list(report: Report, tree: Tree) -> None:
    # A root without ship-pr's SKILL.md has no reading list, so it carries no obligation.
    if not tree.is_file(READ_WHEN_FILE):
        return
    text = tree.read(READ_WHEN_FILE) or ""
    lines = records(text)
    at = lead_line(lines, READ_WHEN_LEAD)
    if isinstance(at, str):
        report.ko(READ_WHEN_FILE, f"{at} to read its staged reading list from")
        return
    spans: list[tuple[str, str, str]] = [(READ_WHEN_FILE, "the What to read when paragraph", paragraph(lines, at))]
    bad = False
    if tree.is_file(POINTER_FILE):
        plines = records(tree.read(POINTER_FILE) or "")
        pat = lead_line(plines, POINTER_LEAD)
        if isinstance(pat, str):
            report.ko(POINTER_FILE, f"{pat} to read its pointer to ship-pr's reading list from")
            bad = True
        else:
            spans.append((POINTER_FILE, "the Landing bullet", bullet(plines, pat)))
    known = headings(text)
    named = 0
    for file, label, span in spans:
        found = italic_spans(span)
        if isinstance(found, str):
            report.ko(file, f"{label} cannot be read: {found}")
            bad = True
            continue
        if file == READ_WHEN_FILE and not found:
            report.ko(file, f"{label} names no *section*: the staged reading list is empty")
            bad = True
        for name in found:
            named += 1
            if name not in known:
                report.ko(
                    file,
                    f"{label} names *{name}*, which is no heading of {READ_WHEN_FILE}"
                    " (every italic span there is a section name)",
                )
                bad = True
    if not bad:
        report.ok(f"the {named} ship-pr sections the reading list and its pointer name are headings of {READ_WHEN_FILE}")
