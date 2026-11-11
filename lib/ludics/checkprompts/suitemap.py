"""The suite map: which suites drive each module of lib/ludics (#718).

A suite outside a module's own unit tests can pin what the module prints -- a usage line, a
refusal's wording -- and go red only in CI when nobody knew it drove that verb (#667's `[--no-gap]`
in test-fleet-execution.py, #811's new verb in the "execution run and conclude --from-run"
section). So lib/ludics/README.md keeps a map, and this pins its SHAPE: every module has a line,
and every suite and section the line names exists.

WHAT IT READS, as a fail-closed allowlist. The obligation exists when ``lib/ludics/__init__.py`` is
a file. The map is the first fenced block (a line that is exactly three backticks, to the next such
line) after the line ``## Which suites drive each module`` and before the next ``## `` line. In
that block every line is one of:
- blank (empty, or blanks only), which ends a group;
- a MODULE line: no leading blank, and blank-separated words, each a module's path relative to
  lib/ludics, ``[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*\\.py``, or a PART of a module, that path, ``:`` and
  a name ``[A-Za-z_][A-Za-z0-9_]*`` the module binds at its top level (#1035). The top-level names
  are read by ``ast`` from the module file's bytes, as Python reads source (its encoding rules
  applied), and only these bind one: ``def``, ``async def``, ``class``, and an assignment or
  annotated assignment whose target is a plain name (``X = ...``, ``X = Y = ...``, ``X: T = ...``).
  A name bound any other way (a tuple target, an import, a
  ``for``, a name under an ``if``) is no part, and a module whose source does not parse has none;
- a SUITE line: exactly four spaces, then words as POSIX ``shlex`` splits
  them. The first is a suite's path from the checkout root, or a glob (``*``, ``?``, ``[``; read
  by ``fnmatch``, whose ``*`` also crosses a ``/``) matching at least one. A suite is a
  ``scripts/test-*``, ``*/scripts/test-*`` or ``*/hooks/test-*`` file ending ``.sh``, ``.py`` or
  ``.ps1`` (the fixture register's own set) or a ``lib/ludics/tests/test_*.py``. Any further word
  is a section argument, allowed only after a suite path (not a glob) whose file declares
  ``SECTIONS=(`` -- a line exactly that, then lines each a plain double-quoted name (no ``"``,
  ``$``, backtick or backslash inside), then a line exactly ``)`` -- and it must be a substring of
  one of those names, as the suite's own selection reads it, and not start with ``-`` (the
  suite's own option, which its selection never reads as a section).
A group is a paragraph: one or more module lines, then one or more suite lines, each suite line
driving every module of its group. Anything else in the block is refused: a suite line with no
module line above it in its group, a module line after a suite line, a group with no suite line, a
module or part named twice, a module word naming no file, a part naming a module that is not
there or a name the module does not bind at its top level, and a module with no line of its own
(a part's line does not stand for its module's). The modules are every regular
``*.py`` file below lib/ludics but each ``__init__.py`` and everything under ``lib/ludics/tests/``
(and ``__pycache__``).

What it deliberately does NOT claim: that a line is COMPLETE, or that a part's line is narrower
than its module's or confined to what the part reaches. Whether a suite not named drives a
module is a reading of call paths and fixtures that no line-shape scan can make; the map's author
makes it, and this check keeps that claim from naming a module, suite or section that is not there.
"""

import ast
import fnmatch
import os
import re
import shlex

from ludics.checkprompts.bytes_view import WS, lat, records
from ludics.checkprompts.tree import Report, Tree

PACKAGE = "lib/ludics"
README = "lib/ludics/README.md"
HEADING = "## Which suites drive each module"
FENCE = "```"
MODULE = re.compile(r"[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)*\.py")
PART = re.compile(r"([A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)*\.py):([A-Za-z_][A-Za-z0-9_]*)")
SECTION_NAME = re.compile(r'"([^"$`\\]*)"')
GLOB_CHARS = ("*", "?", "[")


def modules(tree: Tree) -> list[str]:
    """Every module path relative to lib/ludics, sorted: regular ``*.py`` files but ``__init__.py``,
    outside ``tests/`` and ``__pycache__``."""
    top = tree.path(PACKAGE)
    found: list[str] = []
    for here, dirs, files in os.walk(top):
        rel_dir = os.path.relpath(here, top)
        rel_dir = "" if rel_dir == "." else rel_dir
        dirs[:] = [d for d in dirs if d != "__pycache__" and not (rel_dir == "" and d == "tests")]
        for name in files:
            if name.endswith(".py") and name != "__init__.py":
                rel = os.path.join(rel_dir, name) if rel_dir else name
                if os.path.isfile(os.path.join(here, name)):
                    found.append(lat(rel.replace(os.sep, "/")))
    return sorted(found)


def top_names(source: bytes) -> set[str] | str:
    """The names a module's source binds at its top level, as the docstring's allowlist reads
    them, or why there are none (it does not parse). The source goes in as BYTES, so Python's own
    encoding rules (a BOM, a coding line, UTF-8) read it, not the checker's Latin-1 view."""
    try:
        body = ast.parse(source).body
    except (SyntaxError, ValueError) as e:
        return f"it does not parse as Python ({e})"
    names: set[str] = set()
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def suites(tree: Tree) -> list[str]:
    shell = [
        s
        for s in tree.files("scripts/test-*", "*/scripts/test-*", "*/hooks/test-*")
        if s.endswith((".sh", ".py", ".ps1"))
    ]
    return sorted(set(shell + tree.files(PACKAGE + "/tests/test_*.py")))


def map_block(lines: list[str]) -> tuple[int, list[str]] | str:
    """The map's lines and the README line number before the first, or why there is none."""
    try:
        start = lines.index(HEADING)
    except ValueError:
        return f"no '{HEADING}' line: the map of the suites that drive each module is missing"
    i = start + 1
    while i < len(lines) and lines[i] != FENCE:
        if lines[i].startswith("## "):
            return f"line {start + 1}: '{HEADING}' has no fenced block before the next heading"
        i += 1
    if i == len(lines):
        return f"line {start + 1}: '{HEADING}' has no fenced block"
    try:
        end = lines.index(FENCE, i + 1)
    except ValueError:
        return f"line {i + 1}: the map's fence is never closed"
    return i + 1, lines[i + 1 : end]


def sections(tree: Tree, suite: str) -> list[str] | str | None:
    """The suite's ``SECTIONS=(`` names; None when it declares none, a reason when it is malformed."""
    lines = records(tree.read(suite) or "")
    try:
        start = lines.index("SECTIONS=(")
    except ValueError:
        return None
    names: list[str] = []
    for n in range(start + 1, len(lines)):
        if lines[n] == ")":
            return names
        m = SECTION_NAME.fullmatch(lines[n].strip(WS))
        if m is None:
            return f"line {n + 1} of its SECTIONS=( array is not a plain double-quoted name"
        names.append(m.group(1))
    return f"its SECTIONS=( array (line {start + 1}) is never closed by a ')' line"


def check_suite_map(report: Report, tree: Tree) -> None:
    # A root without the package has no modules to map.
    if not tree.is_file(PACKAGE + "/__init__.py"):
        return
    if not tree.is_file(README):
        report.ko(README, "missing: it maps the suites that drive each module of lib/ludics")
        return
    block = map_block(records(tree.read(README) or ""))
    if isinstance(block, str):
        report.ko(README, block)
        return
    first, lines = block
    known_modules = set(modules(tree))
    known_suites = suites(tree)
    section_cache: dict[str, list[str] | str | None] = {}
    part_cache: dict[str, set[str] | str] = {}
    named: dict[str, int] = {}
    bad = False

    def ko(n: int, message: str, file: str = README) -> None:
        nonlocal bad
        report.ko(file, f"line {first + n + 1}: {message}" if file == README else message)
        bad = True

    # A group is a paragraph of the block: its module lines, then its suite lines. ``head`` is the
    # group's first module line while no suite line has served it yet; ``group`` whether the
    # paragraph has a module line at all.
    head: int | None = None
    group = False
    for n, line in enumerate(lines):
        if line.strip(WS) == "":
            if head is not None:
                ko(head, "a module line with no suite line under it")
            head, group = None, False
            continue
        if line[:1] not in WS:
            if group and head is None:
                ko(n, "a module line under suite lines: a blank line separates the groups")
            if head is None:
                head = n
            group = True
            for word in line.split():
                part = PART.fullmatch(word)
                if part is not None:
                    module, name = part.groups()
                    if module not in known_modules:
                        ko(n, f"names the part '{word}' of '{module}', which is no module of lib/ludics")
                        continue
                    if module not in part_cache:
                        part_cache[module] = top_names(tree.read_bytes(f"{PACKAGE}/{module}") or b"")
                    names_of = part_cache[module]
                    if isinstance(names_of, str):
                        ko(n, f"names the part '{word}', but '{module}' has no top-level names: {names_of}")
                    elif name not in names_of:
                        ko(n, f"names the part '{word}', but '{module}' binds no '{name}' at its top level (a def, a class or a plain-name assignment)")
                    elif word in named:
                        ko(n, f"names '{word}' again (first on line {first + named[word] + 1})")
                    else:
                        named[word] = n
                elif MODULE.fullmatch(word) is None:
                    ko(n, f"'{word}' is not a module path relative to lib/ludics, nor a part of one (<module>.py:<name>)")
                elif word not in known_modules:
                    ko(n, f"names '{word}', which is no module of lib/ludics")
                elif word in named:
                    ko(n, f"names '{word}' again (first on line {first + named[word] + 1})")
                else:
                    named[word] = n
            continue
        if not line.startswith("    ") or line[4:5] in WS:
            ko(n, "neither a module line (no indent) nor a suite line (four spaces, then the suite)")
            continue
        if not group:
            ko(n, "a suite line with no module line above it in its group")
            continue
        head = None
        try:
            words = shlex.split(line)
        except ValueError as e:
            ko(n, f"its words do not split as the shell's: {e}")
            continue
        path, args = words[0], words[1:]
        if any(c in path for c in GLOB_CHARS):
            if not any(fnmatch.fnmatchcase(s, path) for s in known_suites):
                ko(n, f"the glob '{path}' matches no suite")
            if args:
                ko(n, f"the glob '{path}' takes no section arguments")
            continue
        if path not in known_suites:
            ko(n, f"'{path}' is not a suite: no such scripts/test-*, */scripts/test-*, */hooks/test-* or {PACKAGE}/tests/test_*.py file")
            continue
        if not args:
            continue
        if path not in section_cache:
            section_cache[path] = sections(tree, path)
        names = section_cache[path]
        if names is None:
            ko(n, f"'{path}' declares no SECTIONS=( array, so it takes no section arguments")
        elif isinstance(names, str):
            ko(n, f"cannot read the sections of '{path}': {names}", file=path)
        else:
            for arg in args:
                if arg.startswith("-"):
                    ko(n, f"'{arg}' starts with '-': {path} reads it as an option, not a section")
                elif not any(arg in name for name in names):
                    ko(n, f"'{arg}' selects no section of {path}")
    if head is not None:
        ko(head, "a module line with no suite line under it")
    for module in sorted(known_modules - set(named)):
        report.ko(README, f"module '{module}' has no line in the map of the suites that drive it")
        bad = True
    if not bad:
        report.ok(f"{README}: every one of the {len(known_modules)} modules names the suites that drive it")
