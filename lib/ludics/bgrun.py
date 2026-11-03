"""``bg-run.sh wait``'s verdict line, read in one place (ludics-lite#826).

The grammar is bg-run.sh's header (issue-wave/scripts/bg-run.sh, the ``wait`` verdicts): wait prints
one line on stdout and exits with its code, and the verdict is the line's FIRST WORD -- anything
after it is for the reader, never the grammar:

    rc=<n>    exit 0   the command finished with status <n>; ``rc=<n> (finished earlier, at <time>)``
                       when the rc was already there at the wait's first read (ludics-lite#816)
    RUNNING   exit 3   ``RUNNING after <e> s of --within <w>``
    STARTING  exit 4   ``STARTING after <e> s of --within <w>``
    DIED      exit 5
    STOPPED   exit 7   ``STOPPED by bg-run.sh stop before the command returned``

``parse`` reads a line into a ``Verdict``: the word, rc's status, and whether rc carries the
finished-earlier marker. Given wait's exit status as well, a line whose word is not that status's is
no verdict, so a line and an exit that disagree (an older or broken bg-run.sh, a line that is
someone else's output) are refused rather than believed on either half. The first word is
everything before the first blank, as the shell's ``${line%% *}`` cuts it; rc's status is
``[0-9]+``; the marker is the rest of the line opening ``(finished earlier``.

``parse`` is the line's one reader in this package: a far side that waits on a directory
(``execution conclude --from-bg-run``, ``tip-run --wait``) prints the line and wait's exit, and the
near side reads them here, so no second form of the grammar is left to drift (ludics-lite#713
retired the shell form ``--from-bg-run``'s far side ran). A reader that compares the WHOLE line instead (a test against the
bare ``rc=0``, a ``grep -x``) is what check-prompts' ``verdicts`` scanner refuses: the next marker
breaks it.
"""

import re
from dataclasses import dataclass
from enum import StrEnum


class Word(StrEnum):
    RC = "rc"
    RUNNING = "RUNNING"
    STARTING = "STARTING"
    DIED = "DIED"
    STOPPED = "STOPPED"


# Each verdict word and the exit status wait gives it (bg-run.sh's header).
EXIT_OF: dict[Word, int] = {
    Word.RC: 0,
    Word.RUNNING: 3,
    Word.STARTING: 4,
    Word.DIED: 5,
    Word.STOPPED: 7,
}

MARKER = "(finished earlier"
STATUS = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class Verdict:
    word: Word
    status: int | None  # rc's exit status; None for every other word
    earlier: bool  # rc's finished-earlier marker
    line: str  # the line as wait printed it, for the reader


def parse(line: str, exit_status: int | None = None) -> Verdict | None:
    """The verdict ``line`` states, or None when it states none -- or, with ``exit_status``, when
    its word is not the one wait gives that status."""
    first, _, rest = line.partition(" ")
    status: int | None = None
    if first.startswith("rc="):
        digits = first[len("rc="):]
        if not STATUS.fullmatch(digits):
            return None
        word, status = Word.RC, int(digits)
    else:
        try:
            word = Word(first)
        except ValueError:
            return None
        if word is Word.RC:
            return None  # a bare `rc` is no verdict: the word is spelled `rc=<n>`
    if exit_status is not None and EXIT_OF[word] != exit_status:
        return None
    return Verdict(word, status, word is Word.RC and rest.startswith(MARKER), line)

