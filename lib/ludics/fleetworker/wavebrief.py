"""``wave render``: a brief rendered from template parts, refusing an unrendered placeholder (ludics#1047).

Every wave's coordinator rendered its briefs with a ``sed -e "s|@@X@@|$val|g"`` chain: a value
holding ``|`` or ``&`` broke it, the check for a leftover placeholder ran after the worktree and the
reservations already existed, and a post-wave variant rewrote the issue language with regexes and
hoped nothing survived. This is that renderer, once, and ``wave prep`` (waveprep.py) renders
through it before it makes anything.

THE GRAMMAR, a fail-closed allowlist: a placeholder is ``@@NAME@@`` with NAME ``[A-Z][A-Z0-9_]*``,
and nothing else is one. Any other ``@@`` (``@@ -1,4 +1,5 @@`` in a diff, ``@@x@@``) is text and
passes through untouched. The parts are joined in the order given, each stripped of trailing
newlines and separated by one blank line, the result ending in one newline. Substitution is one
literal pass over the parts: a value is inserted as text, never read as a pattern, a shell word or
a template, so backticks, ``$()``, ``|``, ``&``, ``\\1`` and newlines arrive as written.

What refuses (exit 1, and nothing is written):
  - a placeholder left in the result, named by its part and line: the part names a NAME no value
    was given for;
  - a value that itself holds a placeholder, since a single pass would leave it in the result
    unrendered (a deliberate choice: the result never holds the grammar, so the leftover check is
    exact);
  - a NAME given twice, and a NAME outside the grammar.

The boundary: the renderer reads the parts' placeholders and nothing else of them. It does not
read the prose, check that every given NAME is used, or know what any NAME means; the values are
the caller's (``wave prep`` names its own in waveprep.py's header).
"""

import os
import re
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ludics import cli
from ludics.fleetworker.identity import die

NAME = re.compile(r"[A-Z][A-Z0-9_]*")
PLACEHOLDER = re.compile(r"@@([A-Z][A-Z0-9_]*)@@")
USAGE = "wave render [--set NAME=VALUE]... [--set-file NAME=<path>]... [--out <file>] <part>..."


@dataclass(frozen=True)
class Part:
    name: str  # how a refusal names it: its path
    text: str


def value_problems(values: Mapping[str, str]) -> list[str]:
    problems: list[str] = []
    for name, value in values.items():
        if not NAME.fullmatch(name):
            problems.append(f"{name!r} is no placeholder name ([A-Z][A-Z0-9_]*)")
        found = PLACEHOLDER.search(value)
        if found:
            problems.append(f"the value of {name} holds the placeholder {found.group(0)}; a value is inserted as text,"
                            " never rendered, so it would reach the brief unrendered")
    return problems


def substitute(values: Mapping[str, str], found: re.Match[str]) -> str:
    return values.get(found.group(1), found.group(0))


def render(parts: Sequence[Part], values: Mapping[str, str]) -> str | list[str]:
    """The rendered text, or every reason it refuses."""
    problems = value_problems(values)
    if problems:
        return problems
    rendered: list[str] = []

    def fill(found: re.Match[str]) -> str:
        return substitute(values, found)

    for part in parts:
        for number, line in enumerate(part.text.split("\n"), 1):
            for found in PLACEHOLDER.finditer(line):
                if found.group(1) not in values:
                    problems.append(f"{part.name}:{number}: {found.group(0)} is not rendered (no value for {found.group(1)})")
        rendered.append(PLACEHOLDER.sub(fill, part.text).rstrip("\n"))
    if problems:
        return problems
    return "\n\n".join(rendered) + "\n"


def read_part(path: str) -> Part:
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return Part(path, f.read())
    except OSError as exc:
        die(f"wave render: cannot read {path} ({exc.strerror})")


def write_atomically(path: str, text: str) -> None:
    """``path`` replaced whole, or left as it was: a temporary file beside it, renamed over it."""
    directory = os.path.dirname(os.path.abspath(path))
    descriptor, temporary = tempfile.mkstemp(prefix=".wave-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", errors="surrogateescape") as f:
            f.write(text)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def refuse(verb: str, problems: Sequence[str]) -> int:
    for problem in problems:
        sys.stderr.write(f"{verb} REFUSED: {problem}\n")
    return 1


def cmd_render(args: list[str]) -> int:
    values: dict[str, str] = {}
    out = ""
    parts: list[str] = []
    i = 0
    while i < len(args):
        word = args[i]
        if word in ("--set", "--set-file", "--out"):
            if i + 1 >= len(args):
                die(f"wave render: {word} needs a value; usage: {USAGE}")
            given = args[i + 1]
            i += 2
            if word == "--out":
                out = given
                continue
            name, sep, value = given.partition("=")
            if not sep:
                die(f"wave render: {word} takes NAME={'<path>' if word == '--set-file' else 'VALUE'}, not {given!r}")
            if name in values:
                return refuse("WAVE RENDER", [f"{name} is given twice"])
            if word == "--set-file":
                value = read_part(value).text.rstrip("\n")
            values[name] = value
            continue
        if word.startswith("--"):
            die(f"wave render: unknown option {word}; usage: {USAGE}")
        parts.append(word)
        i += 1
    if not parts:
        die(f"wave render: name at least one part; usage: {USAGE}")
    result = render([read_part(p) for p in parts], values)
    if isinstance(result, list):
        return refuse("WAVE RENDER", result)
    if out:
        try:
            write_atomically(out, result)
        except OSError as exc:
            die(f"wave render: cannot write {out} ({exc.strerror})")
        cli.say(f"WAVE RENDER {out}: {len(parts)} part(s), {len(values)} value(s)")
    else:
        sys.stdout.write(result)
    return 0
