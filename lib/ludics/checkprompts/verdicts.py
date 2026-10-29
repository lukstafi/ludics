"""Whole-line reads of ``bg-run.sh wait``'s verdict line (ludics-lite#826).

The verdict is the line's FIRST WORD (bg-run.sh's header); the rest is for the reader and grows:
ludics-lite#816 added ``rc=<n> (finished earlier, at <time>)``, and a reader that compared the whole
line went red in CI. Python reads the line through ``ludics.bgrun``; this pins that no shell or
skill-text reader compares the whole line instead.

THE BOUNDARY, a fail-closed allowlist: these comparison forms, each with an operand that is EXACTLY
a verdict token -- ``rc=`` followed by no blank, quote, backtick, bracket, parenthesis, ``|``,
``;``, ``&``, ``*`` or ``?`` (so ``rc=0`` and ``rc=$n``, never the glob ``rc=*``), or one of
``RUNNING``, ``STARTING``, ``DIED``, ``STOPPED`` -- bare or in one pair of matching quotes, and
followed by the end of the line, a blank, ``]``, ``)``, ``;``, ``&``, ``|``, a backtick, ``:`` or
``,``:

  1. an ``==`` or ``!=`` with that operand on either side (shell ``[[ ]]`` and ``[ ]``, Python),
     blanks around the operator or none; a quoted operand may carry a Python string prefix
     (``f"rc={n}"``), and a bare one on the left must not end a longer word (``x.RUNNING``);
  2. a blank-surrounded ``=`` with that operand on either side, on a line where a ``[`` or
     ``test`` and a blank come before it with no ``]`` between (the ``test`` builtin's comparison,
     negated or within ``-a``/``-o`` too; a spaced Python assignment has neither);
  3. a ``grep`` that carries ``-x`` (alone or in a bundle of letters) or ``--line-regexp`` anywhere
     before the next ``|``, ``;`` or ``&`` (after its pattern too, as GNU grep takes it), with that
     operand; or any ``grep`` with a quoted ``^<token>$``;
  4. a ``case`` arm (after ``in`` or at a line's start, optionally opened by ``(``) one of whose
     ``|``-separated patterns is that operand, closed by ``)``.

A form is flagged whatever the other operand is, an already-cut first word (``${said%% *}``)
included: the scanner reads shapes, not values, so such a read is spelled as a prefix pattern
(``rc=*``) or through ``bg_verdict``.

Read on every line of every file in ``SWEEP``, with no notion of fences, comments, strings or
heredocs: a form inside any of them is flagged, which is why the four files in ``EXCLUDED`` --
named one path at a time, never by a glob a new file could fall under -- are not read. What is
deliberately NOT read: a comparison against a longer literal (``= "rc=0 (finished"``), a regex
anchored other than ``^...$`` in a quoted grep operand, ``awk``/``sed``/``expr`` and other tools'
matches, a comparison split across lines, a Python ``match``, prose saying "prints rc=0", and the
files outside ``SWEEP`` (the workflows among them). Those are follow-ups, not rounds of this one.
A root without ``issue-wave/scripts/bg-run.sh`` writes no verdict line and carries no obligation.
"""

import re

from ludics.checkprompts.bytes_view import records
from ludics.checkprompts.tree import Report, Tree

WRITER = "issue-wave/scripts/bg-run.sh"

SWEEP = (
    "*.md",
    "*/*.md",
    "*/references/*.md",
    "routines/*/*.md",
    "scripts/*.sh",
    "scripts/*.py",
    "*/scripts/*.sh",
    "*/scripts/*.py",
    "*/hooks/*.sh",
    "lib/ludics/*.py",
    "lib/ludics/*/*.py",
)

EXCLUDED = frozenset(
    {
        # The writer: its `case $V in RUNNING)` reads its own state word, not a line.
        WRITER,
        # The writer's suite, which pins that a fresh wait prints the BARE `rc=<n>`.
        "issue-wave/scripts/test-bg-run.sh",
        # This scanner and its fixtures, which spell the forms they are about.
        "lib/ludics/checkprompts/verdicts.py",
        "lib/ludics/tests/test_checkprompts_cli.py",
    }
)

_TOKEN = r"(?:rc=[^\s\"'`\[\]()|;&*?]*|RUNNING|STARTING|DIED|STOPPED)"
_PREFIX = r"(?:[bBfFrRuU]{1,2}(?=[\"']))?"  # a Python string's prefix letters, before its quote
_OPERAND = _PREFIX + r"(?P<q>[\"']?)" + _TOKEN + r"(?P=q)"
# On the left of the operator: a quoted operand wherever it stands, a bare one not inside a longer
# word (``x.RUNNING``, ``$RUNNING``, ``my-RUNNING``).
_LEFT = r"(?:" + _PREFIX + r"(?P<q>[\"'])" + _TOKEN + r"(?P=q)|(?<![\w$.\-])" + _TOKEN + r")"
_END = r"(?=$|[\s\]);&|`:,])"

FORMS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("an ==/!= comparison", re.compile(r"(?:==|!=)\s*" + _OPERAND + _END)),
    ("an ==/!= comparison", re.compile(_LEFT + r"\s*(?:==|!=)")),
    ("a test = comparison", re.compile(r"(?:\[|\btest)\s(?:[^\]]*?\s)?!?=\s+" + _OPERAND + _END)),
    ("a test = comparison", re.compile(r"(?:\[|\btest)\s(?:[^\]]*?\s)?" + _OPERAND + r"\s+!?=\s")),
    (
        "a grep -x match",
        re.compile(
            r"\bgrep\b(?=[^|;&]*\s(?:-[A-Za-z]*x[A-Za-z]*|--line-regexp)(?=$|[\s|;&)`]))[^|;&]*\s(?:-e\s+)?"
            + _OPERAND
            + _END
        ),
    ),
    ("an anchored grep match", re.compile(r"\bgrep\b[^|;&]*\s(?P<q>[\"'])\^" + _TOKEN + r"\$(?P=q)")),
    ("a case arm", re.compile(r"(?:\bin\s+\(?|^\s*\(?)(?:[^\s|()]+\s*\|\s*)*" + _OPERAND + r"\s*[|)]")),
)


def whole_line_reads(text: str) -> list[tuple[int, str]]:
    """Each (line number, form) of ``text`` that compares a whole verdict line: one per line."""
    found: list[tuple[int, str]] = []
    for n, line in enumerate(records(text), 1):
        for what, rx in FORMS:
            if rx.search(line):
                found.append((n, what))
                break
    return found


def check_verdict_reads(report: Report, tree: Tree) -> None:
    if not tree.is_file(WRITER):
        return
    files = [rel for rel in dict.fromkeys(tree.files(*SWEEP)) if rel not in EXCLUDED]
    bad = False
    for rel in files:
        for n, what in whole_line_reads(tree.read(rel) or ""):
            report.ko(
                rel,
                f"line {n}: {what} reads bg-run.sh wait's whole verdict line; its verdict is the first"
                " word (read it with ludics.bgrun, its shell form bg_verdict, or a prefix pattern such"
                " as rc=*), ludics-lite#826",
            )
            bad = True
    if not bad:
        report.ok(f"no whole-line read of bg-run.sh wait's verdict line in {len(files)} files")
