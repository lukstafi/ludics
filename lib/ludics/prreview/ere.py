"""The advisory EREs (and ``checks --check``'s selection), read by ``grep -E`` itself, as the shell
read them.

The list is configuration whose contract is grep's: "one ERE per line, in SHIP_PR_ADVISORY_CHECKS's
own sense", validated by "does grep compile it". What grep accepts and how it reads it depends on
which grep (GNU on Linux, BSD 2.6 on macOS: ``\\b``, ``\\d``, an unmatched ``)``), on the caller's
locale (in a UTF-8 locale BSD grep refuses a range such as ``[+-.]`` that the C locale accepts), and
on newlines in the pattern (each line is a pattern of its own, OR-ed). An earlier port translated
the ERE to ``re`` inside an allowlist and read anything outside it as matching nothing; a parity
review showed that is not the stricter gate -- an advisory check missed counts as a build check, so
a head the shell read as ABSENT read as green. So grep is asked, per name, with the caller's
environment, exactly as ``is_advisory`` and ``ere_valid`` asked it; grep is resolved on PATH like
every other tool (``proc.run_tool``).
"""

from ludics import proc


def matches(pattern: str, name: str) -> bool:
    """``is_advisory``'s question: ``printf '%s' "$name" | grep -Eq -- "$pattern"``. Anything but a
    match (no match, a pattern grep refuses, no grep) is False, as the shell's ``if`` read it. The
    ``--`` keeps a pattern starting with ``-`` a pattern (GNU grep's ``--help`` exits 0)."""
    done = proc.run_tool("grep", ["-Eq", "--", pattern], stdin=name.encode("utf-8", "surrogateescape"))
    return done.rc == 0


def valid(pattern: str) -> bool:
    """``ere_valid``: does grep compile it -- anything but grep's status 2 for an empty input."""
    done = proc.run_tool("grep", ["-Eq", "--", pattern], stdin=b"")
    return done.rc != 2


class Matcher:
    """One ERE asked of grep per name (``matches``), one process's answers kept: a wait loop asks
    the same names every round, and grep's answer for a pattern, a name and an environment is
    fixed. The one implementation of ``is_advisory`` (a name the advisory list says carries no
    build verdict) for ``checks``, ``merge`` and ``base``, and of ``Gate.selects`` (``checks
    --check``'s selection)."""

    def __init__(self, pattern: str) -> None:
        self.pattern = pattern
        self._seen: dict[str, bool] = {}

    def __call__(self, name: str) -> bool:
        if name not in self._seen:
            self._seen[name] = matches(self.pattern, name)
        return self._seen[name]
