"""The conformance suite of scripts/check-prompts.sh: its command line, run over scratch trees.

Every case runs the checker the way the skills, CI and the preflight run it -- the shell entry
point, as a subprocess, against a scratch tree -- and asserts its exit status and a substring of its
output. A well-formed layout passes, and each defect the checker exists for is refused with the
message that names it, with a passing tree as the control, since a scan that cannot fail would prove
nothing (ludics-lite#55). It ends by running the checker on this checkout, which is the same verdict
CI's prompt hygiene step reads. test_checkprompts.py pins the readers one function at a time; this
file never calls into them.

Ported from scripts/test-check-prompts.sh (ludics-lite#403), case for case: a case's label is the
shell suite's, so a failure names the probe it was there. What the port changed:
- A mutation that matches nothing RAISES (``FixtureMissed``, a failure of the case that asked for
  it), and so does one that leaves the file as it was. The shell helpers each carried that guard by
  hand, and nothing probed the guards (ludics-lite#107); here they are one mechanism, and
  ``MutationGuardTest`` probes it.
- A passing scratch tree is asserted with a verdict DERIVED from the tree (``clean``), not a typed
  "6 passed" (ludics-lite#96).
- The slot probes rewrite the count word wherever the checker reads it, the word standing before
  ``on mac-studio``, rather than a parenthesized phrase the prose happens to use (ludics-lite#263).

Run it with ``scripts/py -m unittest ludics.tests.test_checkprompts_cli`` (CI's `prompts` and
macOS jobs do, and the preflight's prompt-fixtures guard); ``unittest discover`` reaches it too.
"""

import functools
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
SRC = os.path.dirname(LIB)
WINDOWS = sys.platform == "win32"
# In forward slashes, which Git Bash's bash takes as a script path as given (the same string elsewhere).
CP = pathlib.PurePath(SRC, "scripts", "check-prompts.sh").as_posix()
# The bash on PATH: a bare "bash" handed to CreateProcess would find System32's WSL launcher first.
BASH = shutil.which("bash") or "bash"
# A native Windows interpreter cannot exec a shell script; everywhere else the script runs as the
# skills run it, by its own shebang.
RUNNER: tuple[str, ...] = (BASH,) if WINDOWS else ()
NO_SYMLINKS = "a symbolic link here needs privileges Git Bash's native Windows Python does not hold"
NO_NAMES = "Windows file names cannot carry a backslash or a tab"

# This suite runs IN GitHub Actions as a step of the prompts job, so GITHUB_ACTIONS is ambient there
# and absent at a prompt. The checker reads that variable to pick the refusal's form (a sentence,
# or a ::error annotation), so a control that lets it through passes locally and goes red only in
# CI (PR #303 closed the same class in test-preflight.sh). Dropped for every run: the annotation
# form is asserted only where a case sets the variable itself.
ENV = {k: v for k, v in os.environ.items() if k != "GITHUB_ACTIONS"}

scratch: list[str] = []  # the suite's scratch root, once setUpModule has made it


def setUpModule() -> None:
    # Physical path: the checker resolves its root, and on macOS $TMPDIR is under /var, a symlink
    # to /private/var. Unresolved, every assertion comparing the checker's output against a
    # scratch path stops matching in silence (ludics-lite#208).
    scratch.append(os.path.realpath(tempfile.mkdtemp(prefix="check-prompts-test.")))


def tearDownModule() -> None:
    def unlock(func: Callable[[str], object], path: str, _exc: BaseException) -> None:
        os.chmod(os.path.dirname(path), stat.S_IRWXU)
        os.chmod(path, stat.S_IRWXU)
        func(path)

    shutil.rmtree(scratch[0], onexc=unlock)


# --- the files ---------------------------------------------------------------------------------
# Text is read and written as Latin-1, one character per byte, so a mutation round-trips every byte
# it does not touch -- NULs, invalid UTF-8 and the real prompts' em dashes alike.


class FixtureMissed(AssertionError):
    """A mutation that changed nothing: the case would assert a verdict over an unmutated tree,
    which is a probe that cannot fail (ludics-lite#107). An AssertionError, so the case fails."""


def read(path: str) -> str:
    with open(path, encoding="latin-1", newline="") as f:
        return f.read()


def write(path: str, data: str | bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data.encode("latin-1") if isinstance(data, str) else data)


def append(path: str, data: str | bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "ab") as f:
        f.write(data.encode("latin-1") if isinstance(data, str) else data)


type Repl = str | Callable[[re.Match[str]], str]


def rewrite(root: str, rel: str, *, pattern: str, repl: Repl, count: int = 1, lines: bool = True) -> None:
    """``sed 's/pattern/repl/'`` on ``root/rel``: with ``lines`` (the default) per line, ``count``
    substitutions on each (0: every one, sed's ``g``); without, over the whole text, where ``\\s``
    crosses a line end. Raises FixtureMissed when nothing matched or nothing changed."""
    path = os.path.join(root, rel)
    before = read(path)
    rx = re.compile(pattern, re.M)
    if lines:
        hits = 0
        out: list[str] = []
        for line in before.split("\n"):
            new, n = rx.subn(repl, line, count=count)
            hits += n
            out.append(new)
        after = "\n".join(out)
    else:
        after, hits = rx.subn(repl, before, count=count)
    if hits == 0:
        raise FixtureMissed(f"{rel}: /{pattern}/ matched nothing")
    if after == before:
        raise FixtureMissed(f"{rel}: /{pattern}/ -> {repl!r} changed nothing")
    write(path, after)


def edit_line(root: str, rel: str, *, at: int, pattern: str, repl: str) -> None:
    """``sed '<at>s/pattern/repl/'``: one substitution on line ``at`` (1-based) of ``root/rel``."""
    path = os.path.join(root, rel)
    text = read(path).split("\n")
    if not 1 <= at <= len(text):
        raise FixtureMissed(f"{rel}: no line {at}")
    new, n = re.subn(pattern, repl, text[at - 1], count=1)
    if n == 0 or new == text[at - 1]:
        raise FixtureMissed(f"{rel}:{at}: /{pattern}/ changed nothing in {text[at - 1]!r}")
    text[at - 1] = new
    write(path, "\n".join(text))


def delete_lines(root: str, rel: str, *, pattern: str) -> None:
    """``sed '/pattern/d'`` on ``root/rel``."""
    path = os.path.join(root, rel)
    text = read(path).split("\n")
    kept = [line for line in text if not re.search(pattern, line)]
    if len(kept) == len(text):
        raise FixtureMissed(f"{rel}: /{pattern}/ matched no line to delete")
    write(path, "\n".join(kept))


def map_lines(root: str, rel: str, *, edit: Callable[[str], list[str] | None]) -> None:
    """An awk pass over ``root/rel``: ``edit`` returns the lines a line becomes, or None to keep it.
    Raises FixtureMissed when it kept every line."""
    path = os.path.join(root, rel)
    text = read(path)
    body, end = (text[:-1], "\n") if text.endswith("\n") else (text, "")
    out: list[str] = []
    hit = False
    for line in body.split("\n"):
        new = edit(line)
        if new is None:
            out.append(line)
        else:
            hit = True
            out.extend(new)
    if not hit:
        raise FixtureMissed(f"{rel}: no line was rewritten")
    write(path, "\n".join(out) + end)


def nul_edit(root: str, rel: str, *, containing: str, where: Literal["prefix", "suffix"]) -> None:
    """Puts a NUL before (prefix) or after (suffix) each line of ``root/rel`` containing the text,
    headings left alone."""

    def edit(line: str) -> list[str] | None:
        if line.startswith("#") or containing not in line:
            return None
        return [f"x\0 {line}" if where == "prefix" else f"{line}\0junk"]

    map_lines(root, rel, edit=edit)


# --- running the checker -----------------------------------------------------------------------


@dataclass(frozen=True)
class Run:
    rc: int
    out: str


def run(*argv: str, env: Mapping[str, str] | None = None, cwd: str | None = None, stdin: bytes = b"") -> Run:
    p = subprocess.run(
        [*RUNNER, *argv],
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={**ENV, **(env or {})},
        cwd=cwd,
        check=False,
    )
    return Run(p.returncode, p.stdout.decode("utf-8", "surrogateescape"))


def skill_files(root: str) -> list[str]:
    found: list[str] = []
    for parent in (root, os.path.join(root, "routines")):
        if os.path.isdir(parent):
            for name in sorted(os.listdir(parent)):
                f = os.path.join(parent, name, "SKILL.md")
                if os.path.isfile(f) and not os.path.islink(f):
                    found.append(f)
    return found


def clean(root: str) -> str:
    """The verdict of a scratch tree built from ``fresh`` that passes: one line for each SKILL.md
    the checker reads and one for each of the two indexes, derived from the tree rather than typed
    per case (ludics-lite#96), so a case that adds a directory states no new total."""
    return f"{len(skill_files(root)) + 2} passed, 0 failed"


class Case(unittest.TestCase):
    root: str

    def setUp(self) -> None:
        self.base = tempfile.mkdtemp(dir=scratch[0])
        self.root = os.path.join(self.base, "tree")

    def check(self, label: str, rc: int, result: Run, *wants: str) -> None:
        missing = [w for w in wants if w not in result.out]
        if result.rc != rc or missing:
            self.fail(f"{label} (rc={result.rc} want {rc}; want {missing}) -- {result.out}")

    def expect(
        self,
        label: str,
        rc: int,
        want: str,
        *argv: str,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        stdin: bytes = b"",
    ) -> Run:
        """The shell suite's ``expect``: the checker (or ``argv``) exits ``rc`` and prints
        ``want``. Inside a loop, wrap it in ``subTest`` so one iteration's failure names itself."""
        result = run(*(argv or (CP, self.root)), env=env, cwd=cwd, stdin=stdin)
        self.check(label, rc, result, want)
        return result

    def lacks(self, label: str, needle: str, result: Run) -> None:
        if needle in result.out:
            self.fail(f"{label}: '{needle}' in -- {result.out}")


# --- the scratch tree: two skills, two routines, both index tables -----------------------------


def skill(root: str, name: str, *front: str) -> None:
    """``<root>/<name>/SKILL.md`` with the given frontmatter lines."""
    write(os.path.join(root, name, "SKILL.md"), "---\n" + "".join(f"{x}\n" for x in front) + f"---\n\n# {name}\n")


README = """\
# scratch

| Skill | What it does |
| --- | --- |
| `alpha` | The first. |
| `beta` | The second. |

| Variable | Meaning |
| --- | --- |
| `NOT_A_SKILL` | A table with backticks that is not the skill table. |
"""

ROUTINES_README = """\
# Routines

| Routine | Kind | Fires |
| --- | --- | --- |
| `nightly` | local | daily |
| `weekly` | local | weekly |
"""


def fresh(root: str) -> None:
    """A passing layout from scratch."""
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(os.path.join(root, "routines"))
    os.makedirs(os.path.join(root, "scripts"))
    skill(root, "alpha", "name: alpha", "description: The first skill.")
    skill(root, "beta", "name: beta", "description: The second skill.", "allowed-tools: Bash")
    skill(os.path.join(root, "routines"), "nightly", "name: nightly", "description: A nightly routine.")
    skill(os.path.join(root, "routines"), "weekly", "name: weekly", "description: A weekly routine.")
    write(os.path.join(root, "README.md"), README)
    write(os.path.join(root, "routines", "README.md"), ROUTINES_README)


def row_after_beta(root: str, *, row: str) -> None:
    """Inserts a row into the scratch README's skill table, after `beta`."""
    rewrite(root, "README.md", pattern=r"^(\| `beta` \|.*)$", repl=lambda m: f"{m.group(1)}\n{row}")


def beta_row(root: str, *, row: str) -> None:
    """Replaces the scratch README's `beta` row."""
    rewrite(root, "README.md", pattern=r"^\| `beta` \| The second\. \|$", repl=lambda _: row)


class MutationGuardTest(unittest.TestCase):
    """The guard every mutation stands behind, probed (ludics-lite#107): a mutation that matched
    nothing, or changed nothing, fails the case that asked for it instead of handing it a tree the
    case then asserts a verdict over."""

    def setUp(self) -> None:
        self.root = os.path.join(tempfile.mkdtemp(dir=scratch[0]), "tree")
        fresh(self.root)

    def test_a_pattern_that_matches_nothing_raises(self) -> None:
        with self.assertRaisesRegex(FixtureMissed, "matched nothing"):
            rewrite(self.root, "README.md", pattern=r"^\| `gamma` \|", repl="x")
        with self.assertRaises(FixtureMissed):
            rewrite(self.root, "routines/README.md", pattern=r"^\| `beta` \| The second\. \|$", repl="x")

    def test_a_replacement_that_changes_nothing_raises(self) -> None:
        with self.assertRaisesRegex(FixtureMissed, "changed nothing"):
            rewrite(self.root, "README.md", pattern="beta", repl="beta")

    def test_the_line_helpers_raise_too(self) -> None:
        with self.assertRaises(FixtureMissed):
            edit_line(self.root, "README.md", at=1, pattern="nothing here", repl="x")
        with self.assertRaises(FixtureMissed):
            delete_lines(self.root, "README.md", pattern="^nothing here$")
        with self.assertRaises(FixtureMissed):
            nul_edit(self.root, "README.md", containing="nothing here", where="prefix")

    def test_the_readme_helpers_raise_when_the_beta_row_is_gone(self) -> None:
        rewrite(self.root, "README.md", pattern="`beta`", repl="`gamma`")
        with self.assertRaises(FixtureMissed):
            row_after_beta(self.root, row="| `x` | y |")
        with self.assertRaises(FixtureMissed):
            beta_row(self.root, row="| `x` | y |")

    def test_a_raised_guard_fails_the_case(self) -> None:
        # Run apart from this suite's own result, so the deliberate trip is counted only here.
        root = self.root

        class Probe(unittest.TestCase):
            def test_probe(self) -> None:
                rewrite(root, "README.md", pattern="^nothing here$", repl="x")

        result = unittest.TestResult()
        Probe("test_probe").run(result)
        self.assertEqual((len(result.failures), len(result.errors)), (1, 0))


# --- the command line --------------------------------------------------------------------------


class CommandLineTest(Case):
    def test_a_well_formed_tree_passes(self) -> None:
        fresh(self.root)
        self.expect("a well-formed tree passes", 0, clean(self.root))

    def test_a_missing_root_is_refused(self) -> None:
        self.expect(
            "a missing root is refused, not passed", 2, "no such directory", CP, os.path.join(self.base, "nowhere")
        )

    def test_a_root_with_no_prompt(self) -> None:
        # A root carrying no prompt at all is a verdict, not a pass over nothing.
        empty = os.path.join(self.base, "empty")
        os.makedirs(empty)
        self.expect(
            "a root with no prompt at all is refused, not passed",
            1,
            f"FAIL: .: no */SKILL.md or routines/*/SKILL.md under {empty}",
            CP,
            empty,
        )

    def test_help_and_unknown_options(self) -> None:
        self.expect(
            "--help prints the usage and succeeds", 0, "usage: check-prompts.sh [root] | --one <dir>", CP, "--help"
        )
        self.expect("an unknown option is a usage error", 2, "check-prompts: unknown option: --bogus", CP, "--bogus")

    # Single-directory mode shares the grammar but has no repository layout requirements.
    def test_one(self) -> None:
        fresh(self.root)
        R = self.root
        self.expect("one prompt needs no README", 0, "1 passed, 0 failed", CP, "--one", f"{R}/alpha")
        os.rename(f"{R}/alpha", f"{R}/installed task")
        self.expect(
            "installed IDs may differ from prompt names, including paths with spaces",
            0,
            "1 passed, 0 failed",
            CP,
            "--one",
            f"{R}/installed task/",
        )
        self.expect("missing single prompt", 1, "missing regular SKILL.md", CP, "--one", f"{R}/scripts")
        self.expect("one requires a directory argument", 2, "usage:", CP, "--one")
        self.expect("one rejects extra arguments", 2, "usage:", CP, "--one", R, "extra")
        self.expect("root rejects extra arguments", 2, "usage:", CP, R, "extra")

    def test_one_shares_the_grammar(self) -> None:
        for field in ("description: null", "description: [", "allowed-tools: ["):
            with self.subTest(field=field):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", "description: valid", field)
                self.expect(
                    f"one refuses {field} with the shared grammar",
                    1,
                    "FAIL: SKILL.md:",
                    CP,
                    "--one",
                    f"{self.root}/alpha",
                )
        fresh(self.root)
        skill(self.root, "alpha", "name: alpha", "description: valid")
        append(f"{self.root}/alpha/SKILL.md", b"\0")
        self.expect("one retains byte validation", 1, "NUL or invalid UTF-8", CP, "--one", f"{self.root}/alpha")


# --- frontmatter defects -----------------------------------------------------------------------


class FrontmatterTest(Case):
    def test_fences(self) -> None:
        R = self.root
        fresh(R)
        path = f"{R}/alpha/SKILL.md"
        write(path, read(path).split("\n", 1)[1])  # the first line, dropped unconditionally
        self.expect("no opening fence", 1, "alpha/SKILL.md: no YAML frontmatter")
        fresh(R)
        write(f"{R}/beta/SKILL.md", "---\nname: beta\ndescription: unclosed\n\n# beta\n")
        self.expect("no closing fence", 1, "beta/SKILL.md: no YAML frontmatter")
        # The opening fence is the line `---` exactly: a CRLF line end or a trailing blank is not it.
        fresh(R)
        write(f"{R}/alpha/SKILL.md", "---\r\nname: alpha\r\ndescription: CRLF throughout\r\n---\r\n")
        self.expect("a CRLF opening fence is no fence", 1, "alpha/SKILL.md: no YAML frontmatter")
        fresh(R)
        write(f"{R}/alpha/SKILL.md", "--- \nname: alpha\ndescription: a blank after the fence\n---\n")
        self.expect("...nor is one with a trailing blank", 1, "alpha/SKILL.md: no YAML frontmatter")

    def test_required_keys(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "description: nameless")
        self.expect("missing name", 1, "alpha/SKILL.md: frontmatter has no 'name:' line")
        fresh(R)
        skill(f"{R}/routines", "weekly", "name: weekly", "description:")
        self.expect("empty description", 1, "weekly/SKILL.md: frontmatter 'description:' has no value")
        fresh(R)
        skill(R, "beta", "name: beta", "name: beta", "description: twice named")
        self.expect("duplicate name", 1, "beta/SKILL.md: frontmatter has 2 'name:' lines")
        # Declarations are counted as keys, not as non-empty values: a blank `name:` beside a
        # populated one is two declarations, and neither the blank one nor the mismatch it could
        # hide gets through.
        fresh(R)
        skill(R, "beta", "name:", "name: alpha", "description: blank beside populated")
        self.expect("a blank duplicate key still counts", 1, "beta/SKILL.md: frontmatter has 2 'name:' lines")

    # Values resolve the way YAML resolves a one-line scalar: the quoted, null and comment-only
    # spellings of empty are empty, and quotes and a trailing comment around real text are not text.
    def test_empty_spellings(self) -> None:
        empties = (
            'description: ""',
            "description: ''",
            "description: null",
            "description: ~",
            "description: # only a comment",
            "description:    ",
        )
        for empty in empties:
            with self.subTest(empty=empty):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", empty)
                self.expect(f"'{empty}' is empty", 1, "alpha/SKILL.md: frontmatter 'description:' has no value")

    def test_quoted_values(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: 'alpha'", 'description: "Quoted, with a # inside." # and a trailing note')
        self.expect("quoted and commented values resolve to their text", 0, clean(R))
        fresh(R)
        skill(R, "alpha", 'name: "beta"', "description: quoted mismatch")
        self.expect(
            "...so a quoted name is still compared to the directory",
            1,
            "name 'beta' does not match its directory 'alpha'",
        )

    # The value grammar is a subset of YAML: whatever it accepts a loader reads as the same string,
    # and whatever a loader might read otherwise -- or reject -- is refused, with the reason. One
    # probe per refusal reason, then the plain-text shapes that must stay accepted.
    REFUSED = (
        ('"unterminated', "a double-quoted value must close"),
        ('"closed" then more', "a double-quoted value must close"),
        ("'unterminated", "a single-quoted value must close"),
        ("'closed' then more", "a single-quoted value must close"),
        ("[]", "starts with the YAML indicator '['"),
        ("{}", "starts with the YAML indicator '{'"),
        ("[a, b]", "starts with the YAML indicator '['"),
        ("&anchor text", "starts with the YAML indicator '&'"),
        ("*alias", "starts with the YAML indicator '*'"),
        ("!!str text", "starts with the YAML indicator '!'"),
        ("`backticked`", "starts with the YAML indicator '`'"),
        ("- a list item", "starts with '- '"),
        ("? a key", "starts with '? '"),
        (": a value", "starts with ': '"),
        ("Runs checks: quickly", "contains ': ' or ends with ':'"),
        ("Ends with a colon:", "contains ': ' or ends with ':'"),
        ("42", "'42' does not start with a letter"),
        ("1e3", "'1e3' does not start with a letter"),
        (".inf", "'.inf' does not start with a letter"),
        ("2001-12-15", "'2001-12-15' does not start with a letter"),
        ("0b1010", "'0b1010' does not start with a letter"),
        ("12:34", "'12:34' does not start with a letter"),
        ("+1_000", "'+1_000' does not start with a letter"),
        ("<< merge", "'<< merge' does not start with a letter"),
        (
            "-x is plain to YAML but outside the grammar",
            "'-x is plain to YAML but outside the grammar' does not start with a letter",
        ),
        ("true", "'true' is a boolean or null"),
        ("Yes", "'Yes' is a boolean or null"),
        ("n", "'n' is a boolean or null"),
    )
    ACCEPTED = (
        "Runs checks:quickly, no space after the colon",
        "v1.2 of 3 things, 100% plain",
        "Text - with - dashes and a trailing note # here",
        "Nothing is 2001-12-15 once a letter leads",
        '"Runs checks: quickly, quoted"',
        "'It''s quoted, with: a colon'",
        "Yes it is text, not a boolean",
        '"2001-12-15, quoted, is text"',
    )

    def test_the_value_grammar(self) -> None:
        for value, reason in self.REFUSED:
            with self.subTest(value=value):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", f"description: {value}")
                self.expect(
                    f"'description: {value}' is refused ({reason})",
                    1,
                    f"outside the grammar this check accepts: '{value}' ({reason}",
                )
        for value in self.ACCEPTED:
            with self.subTest(value=value):
                fresh(self.root)
                skill(self.root, "alpha", "name: alpha", f"description: {value}")
                self.expect(f"'description: {value}' is accepted", 0, clean(self.root))

    def test_name_must_match_the_directory(self) -> None:
        fresh(self.root)
        skill(self.root, "alpha", "name: alpah", "description: misspelt")
        self.expect("name must match the directory", 1, "name 'alpah' does not match its directory 'alpha'")

    # A block scalar is refused by its header, whatever indicators or comment follow the `|`/`>`;
    # and its body, like any continued, nested or listed value, is refused as a non-key line, so a
    # value cannot span lines whichever way it is spelled.
    def test_one_line_values(self) -> None:
        R = self.root
        for header in ("description: |", "description: |2-", "description: >+", "description: > # folded"):
            with self.subTest(header=header):
                fresh(R)
                skill(R, "alpha", "name: alpha", header)
                self.expect(f"block scalar header '{header}'", 1, "description is a block scalar")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: |", "  A block scalar body.")
        self.expect("a block scalar body is a non-key line", 1, "not a top-level 'key: value'")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: The first line", "  continued on a second.")
        self.expect("a plain scalar continued on the next line", 1, "not a top-level 'key: value'")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: listed", "allowed-tools:", "  - Bash")
        self.expect("a nested list", 1, "not a top-level 'key: value'")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: commented", "# a comment line", "", "model: sonnet")
        self.expect("blank and comment lines between keys are fine", 0, clean(R))

    # Double-quoted values admit only `\"` and `\\`: a backslash a loader would reject (`\q`) and one
    # it would turn into a second line (`\n`) are refused alike, and the two admitted ones decode.
    def test_escapes(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpha", r'description: "bad \q escape"')
        self.expect("an escape YAML rejects", 1, r"may escape only \" and \\")
        fresh(R)
        skill(R, "alpha", "name: alpha", r'description: "first\nsecond"')
        self.expect("an escape that would make a second line", 1, r"may escape only \" and \\")
        fresh(R)
        skill(R, "alpha", r'name: "al\"pha"', r'description: "a \"quoted\" word and a \\ backslash"')
        self.expect(
            "the admitted escapes decode before the directory comparison",
            1,
            "name 'al\"pha' does not match its directory 'alpha'",
        )
        fresh(R)
        skill(R, "alpha", "name: alpha", r'description: "a \"quoted\" word and a \\ backslash"')
        self.expect("...and pass where the text is fine", 0, clean(R))

    # A control character anywhere in the frontmatter is refused whole: the tab YAML reads as a
    # separator after `:`, and the carriage return a loader would fold into the value.
    def test_control_characters(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: Runs:\tquickly")
        self.expect("a tab in a value", 1, "frontmatter carries a control character")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: CRLF line\r")
        self.expect("a carriage return", 1, "frontmatter carries a control character")
        # ...found however large the frontmatter.
        fresh(R)
        write(
            f"{R}/alpha/SKILL.md",
            "---\nname: alpha\n# an early tab\there\n" + "# filler\n" * 20000 + "description: late\n---\n",
        )
        self.expect("a tab early in a large frontmatter", 1, "frontmatter carries a control character")

    # A NUL byte never reached a shell variable, and invalid UTF-8 is a loader error: both are
    # refused on the raw file, first.
    def test_bytes(self) -> None:
        R = self.root
        cases = (
            ("a NUL byte", b"---\nname: alpha\ndescription: a NUL \0 inside\n---\n"),
            ("invalid UTF-8", b"---\nname: alpha\ndescription: bad \xff byte\n---\n"),
            # ...and the characters YAML's printable set excludes, by the spec's definition: the C1
            # controls and the two non-characters. Everything else valid UTF-8 encodes is content.
            ("a C1 control (U+0085)", b"---\nname: alpha\ndescription: a C1 control \xc2\x85 inside\n---\n"),
            ("U+FFFE", b"---\nname: alpha\ndescription: a\xef\xbf\xbe non-character\n---\n"),
            (
                "U+2028, a line break to YAML 1.1",
                b"---\nname: alpha\ndescription: a\xe2\x80\xa8b, split by a line separator\n---\n",
            ),
            # ...and read to the end: an early forbidden character in a large frontmatter is found.
            (
                "U+FFFE early in a large frontmatter",
                b"---\nname: alpha\ndescription: a\xef\xbf\xbe early non-character\n" + b"# filler\n" * 5000 + b"---\n",
            ),
        )
        for label, data in cases:
            with self.subTest(label):
                fresh(R)
                write(f"{R}/alpha/SKILL.md", data)
                self.expect(label, 1, "a byte sequence no loader accepts")
        fresh(R)
        write(
            f"{R}/alpha/SKILL.md",
            b"---\nname: alpha\ndescription: fine\n---\n\nA body line\xe2\x80\xa8split by a separator, which is not YAML.\n",
        )
        self.expect("...but only in the frontmatter: the Markdown body is not YAML", 0, clean(R))
        fresh(R)
        write(
            f"{R}/alpha/SKILL.md",
            b"---\nname: alpha\ndescription: fine \xc3\xbcber text \xe2\x80\x94 with a dash\n---\n",
        )
        self.expect("...while valid UTF-8 content passes", 0, clean(R))
        # A Unicode space is content, not whitespace, to YAML and to this check: appended to a name
        # it stays in the name, which then does not match its directory.
        fresh(R)
        write(f"{R}/alpha/SKILL.md", b"---\nname: alpha\xe2\x80\x82\ndescription: en space after the name\n---\n")
        self.expect("a Unicode space is kept in the name", 1, "does not match its directory 'alpha'")

    # Optional keys are held to the same grammar: a loader rejects the whole file on any of them.
    def test_optional_keys(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: fine", "allowed-tools: [")
        self.expect("a malformed optional key", 1, "frontmatter 'allowed-tools:' value is outside the grammar")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: fine", "model:")
        self.expect("an empty optional key", 1, "frontmatter 'model:' has no value")
        fresh(R)
        skill(R, "alpha", "name: alpha", "description: fine", "model: sonnet", "model: opus")
        self.expect("a duplicated optional key", 1, "frontmatter has 2 'model:' lines")


# --- index lookup defects ----------------------------------------------------------------------
# The claim is one lookup per directory: the README that indexes it carries a row whose first cell
# is that directory's name in backticks. Every probe below is at that granularity -- the
# table-syntax probes went with the scanner they exercised (ludics-lite#75).


class IndexTest(Case):
    def test_unindexed_directories(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "gamma", "name: gamma", "description: Unindexed.")
        self.expect("a skill missing from the README", 1, "skill 'gamma' is not indexed")
        fresh(R)
        skill(f"{R}/routines", "monthly", "name: monthly", "description: Unindexed.")
        self.expect("a routine missing from routines/README.md", 1, "routine 'monthly' is not indexed")

    # A row is a row by its FIRST cell, and the name is backticked there: the three ways a README can
    # name a directory and still not index it each fail.
    def test_what_a_row_is(self) -> None:
        rows = (
            ("a row naming the skill without backticks", "| beta | The second, unbackticked. |"),
            (
                "the name backticked in a later cell is not the first cell",
                "| `other` | Backticked in a later cell: `beta`. |",
            ),
            ("a backticked mention that is not a row", "The `beta` skill, described in prose instead of indexed."),
            # The name is matched as text and in full: a longer name containing it is a different
            # directory.
            (
                "a row naming a longer name does not index the directory",
                "| `betas` | A longer name that contains this one. |",
            ),
        )
        for label, row in rows:
            with self.subTest(label):
                fresh(self.root)
                beta_row(self.root, row=row)
                self.expect(label, 1, "skill 'beta' is not indexed")
        # GFM renders a body row without its leading pipe, so one counts here too.
        fresh(self.root)
        beta_row(self.root, row="`beta` | The second, pipeless.")
        self.expect("a pipeless row is a row", 0, clean(self.root))

    # ...and a regex metacharacter in a name is that character.
    def test_a_dot_is_a_dot(self) -> None:
        R = self.root
        fresh(R)
        skill(R, "v1.2", "name: v1.2", "description: A dotted name.")
        row_after_beta(R, row="| `v1x2` | A row the dot must not match. |")
        self.expect("a '.' in a directory name is not a wildcard", 1, "skill 'v1.2' is not indexed")
        fresh(R)
        skill(R, "v1.2", "name: v1.2", "description: A dotted name.")
        row_after_beta(R, row="| `v1.2` | A dotted name, indexed exactly. |")
        self.expect("...while the exact dotted name indexes it", 0, clean(R))

    # A backslash in a name is a backslash, not escape-processed on the way in. Both directions are
    # pinned: an escape-processing lookup would refuse the exactly-indexed name and accept the
    # decoded spelling of a different one.
    @unittest.skipIf(WINDOWS, NO_NAMES)
    def test_a_backslash_is_a_backslash(self) -> None:
        R = self.root
        fresh(R)
        skill(R, r"a\n", r'name: "a\\n"', "description: A literal backslash in the name.")
        append(f"{R}/README.md", "| `a\\n` | A name carrying a backslash. |\n")
        self.expect("a backslash in a directory name is matched literally", 0, clean(R))
        fresh(R)
        skill(R, r"a\tb", r'name: "a\\tb"', "description: A backslash-t in the name.")
        append(f"{R}/README.md", "| `a\tb` | The decoded spelling, which names something else. |\n")
        self.expect("...and what that backslash would decode to is a different name", 1, r"skill 'a\tb' is not indexed")

    def test_index_files(self) -> None:
        R = self.root
        fresh(R)
        os.remove(f"{R}/routines/README.md")
        self.expect("a missing index file", 1, "routines/README.md: missing")
        # With nothing to look up, the README is not thereby judged: the line says so rather than
        # reading as a check that passed.
        fresh(R)
        shutil.rmtree(f"{R}/routines/nightly")
        shutil.rmtree(f"{R}/routines/weekly")
        self.expect(
            "no directories to index says so, instead of passing silently",
            0,
            "no routines/ SKILL.md directory to index",
        )

    # The boundary of the shrunken claim, pinned from the other side so that what the lookup gave up
    # is a decision on record rather than a hole nobody meant (ludics-lite#75). It models no table,
    # so it reads neither a row that outlived its directory nor whether the row renders at all.
    def test_the_lookups_boundary(self) -> None:
        R = self.root
        fresh(R)
        shutil.rmtree(f"{R}/beta")
        self.expect("a row that outlives its directory is no longer read", 0, clean(R))
        fresh(R)
        write(f"{R}/README.md", "```\n" + read(f"{R}/README.md") + "```\n")
        self.expect("...and a fenced README still satisfies the lookup", 0, clean(R))

    def test_every_defect_is_reported(self) -> None:
        # Two defects in one run are both reported: the per-file loop does not stop at the first.
        R = self.root
        fresh(R)
        skill(R, "alpha", "description: nameless")
        skill(f"{R}/routines", "weekly", "name: weekly")
        result = run(CP, R)
        self.check(
            "every defective file is reported, not only the first",
            1,
            result,
            "alpha/SKILL.md: frontmatter has no 'name:' line",
            "weekly/SKILL.md: frontmatter has no 'description:' line",
        )

    def test_annotations(self) -> None:
        # Under Actions each failure is also an annotation on the file.
        R = self.root
        fresh(R)
        skill(R, "alpha", "name: alpah", "description: x")
        self.expect(
            "GitHub annotations name the file", 1, "::error file=alpha/SKILL.md::", env={"GITHUB_ACTIONS": "true"}
        )
        # The bare run reads the suite-wide removal of GITHUB_ACTIONS (ENV).
        self.lacks("...and only under Actions", "::error", run(CP, R))


# --- fixture command membership ----------------------------------------------------------------

FIXTURE_SUITES = (
    "alpha/scripts/test-shell.sh",
    "alpha/scripts/test-python.py",
    "alpha/hooks/test-hook.py",
    "scripts/test-workflow-reporters.py",
    "ship-pr/scripts/test-pr-review-hostile.py",
    "issue-wave/scripts/test-windows-driver.ps1",
    "ship-pr/scripts/test-shell.sh",
)
FIXTURE_README = """\
## Tests

alpha/scripts/test-shell.sh
python3 alpha/scripts/test-python.py
python3 alpha/hooks/test-hook.py
python3 scripts/test-workflow-reporters.py
python3 ship-pr/scripts/test-pr-review-hostile.py
./issue-wave/scripts/test-windows-driver.ps1
ship-pr/scripts/test-shell.sh
"""
FIXTURE_WORKFLOW = """\
jobs:
  unix:
    runs-on: ubuntu-latest
    steps:
      - run: alpha/scripts/test-shell.sh
      - run: python3 alpha/scripts/test-python.py
      - run: python3 alpha/hooks/test-hook.py
      - run: python3 scripts/test-workflow-reporters.py
      - run: python3 ship-pr/scripts/test-pr-review-hostile.py
      - run: ship-pr/scripts/test-shell.sh
  macos:
    runs-on: macos-latest
    steps:
      - run: alpha/scripts/test-shell.sh || { echo failed; exit 1; }
      - run: python3 alpha/scripts/test-python.py
      - run: python3 alpha/hooks/test-hook.py
      - run: ship-pr/scripts/test-shell.sh || { echo failed; exit 1; }
  windows:
    runs-on: windows-latest
    steps:
      - run: ./issue-wave/scripts/test-windows-driver.ps1
"""
GIT_BASH_WORKFLOW = """\
jobs:
  git-bash:
    runs-on: windows-latest
    defaults:
      run:
        shell: bash
    steps:
      - run: ship-pr/scripts/test-shell.sh || { echo '::error title=Git Bash suite failed::test-shell.sh'; exit 1; }
"""
SKILL_SCRIPTS = ".github/workflows/skill-scripts.yml"
GIT_BASH = ".github/workflows/windows-git-bash.yml"


def fixture_tree(root: str) -> None:
    fresh(root)
    for suite in FIXTURE_SUITES:
        write(os.path.join(root, suite), "")
    append(os.path.join(root, "README.md"), FIXTURE_README)
    write(os.path.join(root, SKILL_SCRIPTS), FIXTURE_WORKFLOW)
    write(os.path.join(root, GIT_BASH), GIT_BASH_WORKFLOW)


def unregister(root: str, *, suite: str) -> None:
    """Takes the suite's command out of the README's register, keeping prose and a longer filename
    in its place: neither substitutes for a registered command."""
    map_lines(root, "README.md", edit=lambda line: [f"Mention: {line}", f"{line}.extra"] if suite in line else None)


def unrun(root: str, *, workflow: str, platform: str, suite: str) -> None:
    """Takes the suite's run line out of the jobs on ``platform`` (a runner, less ``-latest``; the
    job keyed git-bash is ``git-bash``), leaving a comment, a name, an echo and a longer filename."""
    job = os_ = ""

    def edit(line: str) -> list[str] | None:
        nonlocal job, os_
        if re.match(r"  [A-Za-z0-9_-]+:", line):
            job = line.split()[0].removesuffix(":")
        if "runs-on:" in line:
            os_ = line.split()[1].removesuffix("-latest")
            if job == "git-bash":
                os_ = "git-bash"
        if os_ == platform and suite in line:
            return [
                f"      # run: {suite}",
                f"      - name: {suite}",
                f"      - run: echo {suite}",
                f"      - run: {suite}.extra",
            ]
        return None

    map_lines(root, workflow, edit=edit)


class FixtureRegisterTest(Case):
    def test_the_register_passes(self) -> None:
        fixture_tree(self.root)
        self.expect("shell, Python, hook and platform-specific register passes", 0, "required CI platforms agree")

    def test_each_suite_owes_a_readme_line(self) -> None:
        for suite in (s for s in FIXTURE_SUITES if s != "ship-pr/scripts/test-pr-review-hostile.py"):
            with self.subTest(suite=suite):
                fixture_tree(self.root)
                unregister(self.root, suite=suite)
                self.expect(f"README refuses missing {suite} command", 1, f"fixture '{suite}' has no command line")

    # ship-pr's shell suites owe a Git Bash leg on Windows as well (ludics-lite#318); the other
    # shell suites do not, which the passing tree above already shows for alpha/scripts/test-shell.sh.
    def test_each_suite_owes_its_platforms(self) -> None:
        for platform in ("ubuntu", "macos", "git-bash"):
            suites = ["ship-pr/scripts/test-shell.sh"]
            if platform != "git-bash":
                suites = [
                    "alpha/scripts/test-shell.sh",
                    "alpha/scripts/test-python.py",
                    "alpha/hooks/test-hook.py",
                    *suites,
                ]
            workflow = GIT_BASH if platform == "git-bash" else SKILL_SCRIPTS
            for suite in suites:
                with self.subTest(platform=platform, suite=suite):
                    fixture_tree(self.root)
                    unrun(self.root, workflow=workflow, platform=platform, suite=suite)
                    self.expect(
                        f"{platform} refuses missing {suite} execution",
                        1,
                        f"fixture '{suite}' has no inline run command on {platform}",
                    )

    # The Git Bash leg is windows-git-bash.yml's git-bash JOB, not any Windows runner: the same run
    # line moved into the PowerShell windows-driver job shares the runner and is still refused (PR
    # #321, review round 2), and so is a job keyed git-bash that runs somewhere other than Windows,
    # or one back in skill-scripts.yml, the per-push file it moved out of (ludics-lite#339).
    def test_the_git_bash_leg_is_a_job(self) -> None:
        R = self.root
        want = "fixture 'ship-pr/scripts/test-shell.sh' has no inline run command on git-bash"
        fixture_tree(R)
        write(f"{R}/{GIT_BASH}", "")
        rewrite(
            R,
            SKILL_SCRIPTS,
            pattern=r"^(      - run: \./issue-wave/scripts/test-windows-driver\.ps1)$",
            repl=r"\1" + "\n      - run: ship-pr/scripts/test-shell.sh",
        )
        self.expect("a ship-pr suite run by another Windows job is no Git Bash leg", 1, want)
        fixture_tree(R)
        rewrite(R, GIT_BASH, pattern=r"windows-latest", repl="ubuntu-latest")
        self.expect("...nor is a job keyed git-bash on another runner", 1, want)
        fixture_tree(R)
        append(f"{R}/{SKILL_SCRIPTS}", read(f"{R}/{GIT_BASH}").split("\n", 1)[1])
        os.remove(f"{R}/{GIT_BASH}")
        self.expect("...nor is the git-bash job back in skill-scripts.yml", 1, f"windows-git-bash.yml: {want}")

    def test_platform_specific_suites(self) -> None:
        for suite in (
            "scripts/test-workflow-reporters.py",
            "ship-pr/scripts/test-pr-review-hostile.py",
            "issue-wave/scripts/test-windows-driver.ps1",
        ):
            with self.subTest(suite=suite):
                fixture_tree(self.root)
                delete_lines(self.root, SKILL_SCRIPTS, pattern=re.escape(suite))
                self.expect(
                    f"platform-specific {suite} still requires its CI command",
                    1,
                    f"fixture '{suite}' has no inline run command",
                )

    def test_the_registers_reach(self) -> None:
        R = self.root
        fixture_tree(R)
        os.remove(f"{R}/{SKILL_SCRIPTS}")
        self.expect("fixtures require a workflow", 1, "no inline run command on ubuntu")
        fixture_tree(R)
        os.remove(f"{R}/alpha/scripts/test-python.py")
        # The lookup is one-way, as the prompt register is: stale commands require no table model.
        self.expect("a removed fixture leaves no membership obligation", 0, "0 failed")
        # A suite is a .sh, .py or .ps1 file: another `test-*` file is data, and owes no register line.
        fixture_tree(R)
        write(f"{R}/alpha/scripts/test-data.json", "")
        self.expect("a test-* file that is not a suite carries no obligation", 0, "required CI platforms agree")
        # The README's register is its `## Tests` section: the same command line under another
        # heading registers nothing.
        fixture_tree(R)
        rewrite(R, "README.md", pattern=r"^## Tests$", repl="## Notes")
        self.expect(
            "a command line outside the README's Tests section is not in the register",
            1,
            "fixture 'alpha/scripts/test-shell.sh' has no command line",
        )


# --- the real files ------------------------------------------------------------------------------
# The slot, drift, cleanup and real-link probes copy this checkout's own files, for the reason each
# section gives: a probe over invented prose would keep passing while the checker's spellings
# drifted away from the ones the prompts use. Every mutation rewrites a copy; nothing in the
# checkout is touched. What each section reads off the real files is derived here, independently
# of the checker -- a probe that computed its expectation with the code under test would prove
# nothing -- and a reading that finds nothing fails every case that needs it, saying what it needs.

WORKER = "issue-wave/scripts/fleet-worker.sh"
# The Markdown that README.md, issue-wave/SKILL.md and each other reach by relative link -- the
# wave's reference files, shipping prompt, hook README and the Linux bootstrap's notes. The
# real-file trees carry them because the link check reads every such link in the prompts they copy,
# and a tree holding a linking file without its target would fail on a defect its probes are not
# about. Listed rather than discovered: discovering them means running the extraction under test,
# and copying every Markdown file instead multiplies the runtime, since each rebuild is then
# re-scanned in full. A link added to a copied prompt whose target is not named here fails LOUDLY --
# on every probe of that tree at once, with the path it could not resolve in the message.
LINK_TARGETS = (
    "issue-wave/references/cli-claude.md",
    "issue-wave/references/executions.md",
    "issue-wave/references/native-claude.md",
    "issue-wave/references/native-codex.md",
    "issue-wave/references/native-workers.md",
    "issue-wave/references/separate-codex.md",
    "issue-wave/references/app-claude.md",
    "issue-wave/references/post-wave.md",
    "issue-wave/references/paired-planning.md",
    "issue-wave/references/linux-boxes.md",
    "issue-wave/references/wsl-boxes.md",
    "ship-pr/SKILL.md",
    "ship-pr/hooks/README.md",
    "scripts/install-linux.md",
)


def copy_prompts(root: str, *files: str) -> None:
    """Each named file of this checkout, at the path it lives in."""
    for f in files:
        os.makedirs(os.path.join(root, os.path.dirname(f)), exist_ok=True)
        shutil.copy(os.path.join(SRC, f), os.path.join(root, f))


def src_lines(rel: str) -> list[str]:
    return read(os.path.join(SRC, rel)).split("\n")


NUMBER_WORDS = "zero one two three four five six seven eight nine ten eleven twelve".split()


@dataclass(frozen=True)
class Slots:
    want: int  # the default as the worker reads it
    other: int  # a number that is not it
    word: str  # the default spelled as the prose spells it
    # Spellings used as the STALE ones must not be the default's own, or the mutation would replace
    # a word with itself. Both move out of the way if the default ever becomes the number they
    # spell -- which is the very change this whole check exists for.
    stale: str
    stale_hyphen: str


@functools.cache
def slots() -> Slots:
    # The LAST such assignment, as the shell and the checker both take it, and refused outright if
    # it is not one plain number. Base ten: a default spelled `08` is eight.
    found = [m.group(1) for line in src_lines(WORKER) if (m := re.match(r"SLOTS=.*mac-studio=([0-9]+)", line))]
    if not found:
        raise AssertionError(f"the slot probes need one numeric mac-studio default in {WORKER}")
    want = int(found[-1], 10)
    if want >= len(NUMBER_WORDS):
        raise AssertionError(f"the slot probes spell the default {want} as a word, and know words up to twelve")
    return Slots(
        want=want,
        other=want + 1,
        word=NUMBER_WORDS[want],
        stale="twelve" if want == 11 else "eleven",
        stale_hyphen="twenty-seven" if want == 26 else "twenty-six",
    )


def slots_tree(root: str) -> None:
    shutil.rmtree(root, ignore_errors=True)
    copy_prompts(root, "README.md", "routines/README.md", "issue-wave/SKILL.md", *LINK_TARGETS, WORKER)


def count_word(root: str, rel: str, *, to: str, box: str = "mac-studio") -> None:
    """Rewrites the count word stated for the default -- the numeral standing before ``on
    mac-studio``, however the sentence around it is phrased and wherever the line wraps -- to
    ``to``, and the box name after it to ``box`` (ludics-lite#263)."""
    w = slots().word
    rewrite(
        root,
        rel,
        pattern=rf"(?<![A-Za-z0-9_-]){w}(\s+on\s+)mac-studio(?![a-z0-9_.-])",
        repl=lambda m: f"{to}{m.group(1)}{box}",
        count=0,
        lines=False,
    )


def slots_assignment(root: str, *, old: str, new: str) -> None:
    """Rewrites ``old`` inside the worker's last ``SLOTS=`` assignment, its default roster."""
    path = os.path.join(root, WORKER)
    text = read(path).split("\n")
    at = max((i for i, line in enumerate(text) if line.startswith("SLOTS=")), default=-1)
    if at < 0:
        raise FixtureMissed(f"{WORKER}: no SLOTS= assignment")
    edit_line(root, WORKER, at=at + 1, pattern=rf"(?<![A-Za-z0-9_.-]){re.escape(old)}(?![0-9])", repl=new)


class SlotCountTest(Case):
    """The mac-studio correctness-slot count the prompts quote, held to the one line of
    fleet-worker.sh it lives in (ludics-lite#160). The tree is the real files, copied, and it is a
    valid root on its own: the real README indexes more skills than it holds, which the index
    lookup allows; its links all have their targets (LINK_TARGETS); and it carries no fixture, so
    no membership obligation comes with it. `native-claude.md` is in it as a file the slot scan
    DISCOVERS rather than requires: it states the count and is held for it."""

    AGREE = "mac-studio correctness slots agree"

    def setUp(self) -> None:
        super().setUp()
        self.s = slots()
        slots_tree(self.root)

    def test_the_prompts_and_the_worker_agree(self) -> None:
        self.expect("the prompts and fleet-worker.sh state one mac-studio slot count", 0, self.AGREE)

    # The script moves and the prose does not: one edit at the source, every file that states the
    # count refused -- the discovered `native-claude.md` among them, not just the required three.
    def test_a_new_default_in_the_script_alone(self) -> None:
        s = self.s
        rewrite(self.root, WORKER, pattern=f"mac-studio={s.want}", repl=f"mac-studio={s.other}", count=0)
        files = (
            "README.md",
            "issue-wave/SKILL.md",
            "issue-wave/references/executions.md",
            "issue-wave/references/native-claude.md",
        )
        self.check(
            "a new default in the script alone leaves every file that states the count refused",
            1,
            run(CP, self.root),
            *(f"FAIL: {f}: " for f in files),
        )

    # ...and each file moving alone, in each spelling the prose uses: `mac-studio=<n>`, and the
    # numeral phrase before `on mac-studio`.
    def test_one_file_moving_alone(self) -> None:
        R, s = self.root, self.s
        rewrite(R, "issue-wave/references/executions.md", pattern=f"mac-studio={s.want}", repl=f"mac-studio={s.other}")
        self.expect("a rewritten mac-studio=<n> is refused", 1, f"states 'mac-studio={s.other}'")
        slots_tree(R)
        count_word(R, "README.md", to=s.stale)
        self.expect(
            "a rewritten count word is refused, wrapped across a line",
            1,
            f"README.md: spells the mac-studio slot count '{s.stale}'",
        )
        slots_tree(R)
        count_word(R, "issue-wave/SKILL.md", to=s.stale)
        self.expect(
            "a rewritten count word is refused in the skill",
            1,
            f"SKILL.md: spells the mac-studio slot count '{s.stale}'",
        )
        # A file nobody listed: the scan holds whatever states the count, which is what keeps a list
        # from going stale behind a new quotation of the number.
        slots_tree(R)
        count_word(R, "issue-wave/references/native-claude.md", to=s.stale)
        self.expect(
            "a discovered reference is held to the count too",
            1,
            f"native-claude.md: spells the mac-studio slot count '{s.stale}'",
        )
        # The whole token, not its prefix: a value the worker would reject must not read as
        # agreement because it starts with the right digit.
        slots_tree(R)
        rewrite(
            R, "issue-wave/references/executions.md", pattern=f"mac-studio={s.want}", repl=f"mac-studio={s.want}oops"
        )
        self.expect("a malformed mac-studio=<n> is not agreement", 1, f"states 'mac-studio={s.want}oops'")

    # The word before `on mac-studio` is read WHOLE and then asked whether it is a count at all. A
    # suffix rule reads `twenty-six` as the `six` it ends with, while a bare vocabulary rule lets
    # `thirteen` state a number no spelling is checked against.
    def test_numeral_phrases(self) -> None:
        R, s = self.root, self.s
        count_word(R, "issue-wave/SKILL.md", to=s.stale_hyphen)
        self.expect(
            "a compound numeral is read whole, not by its suffix",
            1,
            f"SKILL.md: spells the mac-studio slot count '{s.stale_hyphen}'",
        )
        prefix = s.stale_hyphen.split("-")[0]
        slots_tree(R)
        count_word(R, "issue-wave/references/native-claude.md", to=prefix)
        self.expect(
            "a numeral past the default's own spellings is still a count",
            1,
            f"native-claude.md: spells the mac-studio slot count '{prefix}'",
        )
        for to, label in (
            ("twenty six", "a numeral phrase is read whole, spaces and all"),
            # The scale words English joins with `and` are numerals too.
            ("one thousand and six", "a scale word is part of the numeral, not a stop"),
            ("one hundred and six", "a numeral phrase joined by 'and' is read whole"),
        ):
            with self.subTest(label):
                slots_tree(R)
                count_word(R, "issue-wave/references/native-claude.md", to=to)
                self.expect(label, 1, f"native-claude.md: spells the mac-studio slot count '{to}'")
        # `and` joins a numeral phrase only between two numerals: a bare `and` before it leaves the
        # run where it was.
        slots_tree(R)
        count_word(R, "issue-wave/references/native-claude.md", to=f"a slot and {s.word}")
        self.expect("...while a bare 'and' before it joins nothing", 0, self.AGREE)
        # A word carrying punctuation ends the phrase rather than joining it: the `one.` closing a
        # sentence is not part of the `Six` opening the next.
        slots_tree(R)
        count_word(R, "issue-wave/SKILL.md", to=f"the WSL boxes have one. {s.word.capitalize()}")
        self.expect("a numeral across a sentence boundary does not join the phrase", 0, self.AGREE)

    # ...and the justification shape stays scoped to slot prose: an ordinary sentence of that shape
    # states no slot count.
    def test_ordinary_prose(self) -> None:
        R = self.root
        for sentence in ("The cleanup is done on mac-studio.", "Someone on mac-studio noticed."):
            with self.subTest(sentence=sentence):
                slots_tree(R)
                append(f"{R}/README.md", f"\n{sentence}\n")
                self.expect(
                    f"ordinary prose ending in a number word states no count: {sentence.split()[0]}...", 0, self.AGREE
                )
        # The `<N>, not <m>` justification is deliberately not a form this check reads
        # (ludics-lite#202): a window wide enough to catch the real ones reads ordinary comparisons
        # beside the slot paragraph as counts. Both of these are ordinary prose, written right
        # after the README's own count.
        for sentence in ("Choose one, not two modes.", "Eleven, not three, since nothing."):
            with self.subTest(sentence=sentence):
                slots_tree(R)
                w = self.s.word
                rewrite(
                    R,
                    "README.md",
                    pattern=rf"(?<![A-Za-z0-9_-]){w}\s+on\s+mac-studio\S*",
                    repl=lambda m: f"{m.group(0)} {sentence}",
                    lines=False,
                )
                self.expect(
                    f"a numeral comparison beside the slot paragraph states no count: {sentence.split()[0]}...",
                    0,
                    self.AGREE,
                )

    # Punctuation that closes a mention is punctuation, wherever Markdown puts it -- a correct count
    # inside brackets or braces states the default, and only a non-punctuation suffix is malformed.
    def test_punctuation(self) -> None:
        R, s = self.root, self.s
        for wrap in ("[mac-studio=%s]", "{mac-studio=%s}:", '"mac-studio=%s".'):
            with self.subTest(wrap=wrap):
                slots_tree(R)
                append(f"{R}/README.md", f"\nRoster {wrap % s.want} here.\n")
                self.expect(f"a count closed by Markdown punctuation is the count: {wrap}", 0, self.AGREE)
        slots_tree(R)
        append(f"{R}/README.md", f"\nRoster [mac-studio={s.other}] here.\n")
        self.expect("...and a stale one inside brackets is still refused", 1, f"states 'mac-studio={s.other}'")
        slots_tree(R)
        append(f"{R}/README.md", f"\nRoster mac-studio={s.want}oops here.\n")
        self.expect(
            "...while a suffix that is not punctuation is still malformed", 1, f"states 'mac-studio={s.want}oops'"
        )

    # The box name at a token boundary: another box's name ending in it is another box, and a roster
    # that names no mac-studio has no mac-studio default to check the prompts against. A box name
    # may hold `_` and `.` as well as `-`.
    def test_the_box_name_in_the_default(self) -> None:
        R, s = self.root, self.s
        nodefault = f"{WORKER}: SLOTS assignment states no 'mac-studio=<n>' default"
        slots_assignment(R, old=f"mac-studio={s.want}", new=f"not-mac-studio={s.want}")
        self.expect("a box whose name merely ends in mac-studio is another box", 1, nodefault)
        slots_tree(R)
        slots_assignment(R, old=f"mac-studio={s.want}", new=f"not_mac-studio={s.want}")
        self.expect("a box name ending in mac-studio after an underscore is another box", 1, nodefault)

    # The box name ends at a token boundary in the prose too: each of these states a count about
    # another box.
    def test_the_box_name_in_the_prose(self) -> None:
        R = self.root
        count_word(R, "README.md", to="six", box="mac-studio-pro")
        self.expect(
            "a count about a box whose name starts with mac-studio is not this one's",
            1,
            "README.md: states no mac-studio slot count",
        )
        slots_tree(R)
        count_word(R, "README.md", to="six", box="mac-studio_backup")
        self.expect(
            "a count about mac-studio_backup is not this box's either", 1, "README.md: states no mac-studio slot count"
        )

    def test_where_a_mention_is_read(self) -> None:
        R, s = self.root, self.s
        # The box name's far boundary may be the end of the text itself.
        append(f"{R}/README.md", f"\n{s.stale} on mac-studio")
        self.expect(
            "a count phrase ending the file is still read",
            1,
            f"README.md: spells the mac-studio slot count '{s.stale}'",
        )
        # A NUL anywhere makes grep call a file binary, and the greps disagreed about what that
        # prints: the NUL stands BEFORE the mention, in a file nothing requires to state a count.
        slots_tree(R)
        write(f"{R}/notes-with-a-nul.md", f"a stray \0 byte, and then:\n\n{s.stale} on mac-studio, this note says.\n")
        self.expect(
            "a stale count in a file carrying a NUL is still refused",
            1,
            f"notes-with-a-nul.md: spells the mac-studio slot count '{s.stale}'",
        )
        # The box name is matched in lowercase, so a mention that shouts is the same mention.
        slots_tree(R)
        append(f"{R}/README.md", f"\nThe roster sets MAC-STUDIO={s.want} for the Mac.\n")
        self.expect("a mention in capitals is the same statement", 0, self.AGREE)
        slots_tree(R)
        append(f"{R}/README.md", f"\nThe roster sets MAC-STUDIO={s.other} for the Mac.\n")
        self.expect(
            "...and a stale one in capitals is refused as written", 1, f"README.md: states 'MAC-STUDIO={s.other}'"
        )
        # A path with a space in it is scanned, not split.
        slots_tree(R)
        write(f"{R}/issue-wave/references/old notes.md", f"notes\n\nmac-studio={s.other} slots.\n")
        self.expect(
            "a discovered path with a space is scanned, not split", 1, f"old notes.md: states 'mac-studio={s.other}'"
        )
        # The root is read the same spelled with a trailing slash.
        slots_tree(R)
        self.expect("a root spelled with a trailing slash reads the same", 0, self.AGREE, CP, f"{R}/")
        # A prompt that stops stating the count is how the agreement would quietly stop being checked.
        slots_tree(R)
        count_word(R, "README.md", to="as configured")
        self.expect("a prompt that drops the count is refused", 1, "README.md: states no mac-studio slot count")

    def default_moves(self, label: str, *, tail: str) -> None:
        """Appends ``tail`` to the worker, which assigns the other count: the default moves."""
        append(f"{self.root}/{WORKER}", tail)
        self.check(label, 1, run(CP, self.root), f"defaults to mac-studio={self.s.other}")

    def default_stays(self, label: str, *, tail: str, rel: str = WORKER) -> None:
        append(f"{self.root}/{rel}", tail)
        self.expect(label, 0, self.AGREE)

    # Which assignment is the default is read as the shell reads the script: the LAST one at top
    # level that the shell would execute, before a separator or alone on its line.
    def test_which_assignment_is_the_default(self) -> None:
        o = self.s.other
        moves: tuple[tuple[str, str], ...] = (
            ("a later SLOTS assignment is the default the prompts are held to", f"SLOTS=mac-studio={o}\n"),
            # A heredoc-like operator inside quotes, or named in a comment, opens no body.
            (
                "a heredoc-like string in quotes hides nothing after it",
                f"printf %s '<<IGNORED'\nSLOTS=mac-studio={o}\n",
            ),
            ("an assignment before a separator is still the default", f"SLOTS=mac-studio={o} ; export SLOTS\n"),
            (
                "a heredoc named in a comment hides nothing after it",
                f"# example: cat <<IGNORED\nSLOTS=mac-studio={o}\n",
            ),
            # A here-STRING is not a heredoc.
            (
                "...and a here-string opens no body for the next line to hide in",
                f'read -r -a pairs <<<"$SLOTS"\nSLOTS=mac-studio={o}\n',
            ),
            # Past a function body, the script is top level again.
            ("...and one after the body closes is", f"unused_helper() {{\nx=1\n}}\nSLOTS=mac-studio={o}\n"),
            # Once a heredoc body ends, the script is code again.
            ("...and an assignment after the terminator is executed again", f"cat <<A\nx\nA\nSLOTS=mac-studio={o}\n"),
        )
        for label, tail in moves:
            with self.subTest(label):
                slots_tree(self.root)
                self.default_moves(label, tail=tail)
        stays: tuple[tuple[str, str], ...] = (
            # A heredoc body is data the script writes, not code it runs.
            ("a SLOTS line inside a heredoc assigns nothing", f": <<'HD'\nSLOTS=mac-studio={o}\nHD\n"),
            # A blank the shell does not split on does not end the assignment word.
            (
                "an override whose blank is escaped states no default",
                "export FLEET_BOX_CORRECTNESS_SLOTS=testbox=2\\ mac-studio=2\n",
            ),
            # An assignment in front of a command is scoped to that command.
            ("a command-prefix assignment sets no default", f"SLOTS=mac-studio={o} true\n"),
            # A heredoc delimiter is a word, not a shell identifier.
            ("a heredoc delimited by digits is still a heredoc", f": <<123\nSLOTS=mac-studio={o}\n123\n"),
            # Defining a function is not running it.
            (
                "an assignment inside a function body is not the default",
                f"unused_helper() {{\nSLOTS=mac-studio={o}\n}}\n",
            ),
            # A heredoc delimiter may be quoted with a backslash as well as with quotes.
            ("...however the heredoc delimiter is quoted", f"cat <<\\HD\nSLOTS=mac-studio={o}\nHD\n"),
            # One command may declare several heredocs, and their bodies follow in order.
            (
                "a body behind a second delimiter on one line is still a body",
                f"cat <<A <<B\nfirst\nA\nSLOTS=mac-studio={o}\nB\n",
            ),
            # An assignment of the variable is an input, not a claim about the default.
            (
                "an override in front of a command states no default",
                f"FLEET_BOX_CORRECTNESS_SLOTS=mac-studio=2 {WORKER} execution slot -- true\n",
            ),
            ("...and a quoted override states none either", 'export FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=2"\n'),
            # What makes a mention an assignment is standing inside the assignment word, not what
            # the characters before it happen to spell.
            (
                "...and one behind another box's pair states none either",
                'export FLEET_BOX_CORRECTNESS_SLOTS="testbox=2 mac-studio=2"\n',
            ),
        )
        for label, tail in stays:
            with self.subTest(label):
                slots_tree(self.root)
                self.default_stays(label, tail=tail)

    # An example command in a document is an input too, quoted and continued however it is.
    def test_overrides_in_documents(self) -> None:
        execs = "issue-wave/references/executions.md"
        example = '\n    FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-wsl=3 mac-studio=2" fleet-worker.sh ls\n'
        for label in (
            "a quoted override is still an input, not a statement",
            "...and so does one in a document's example command",
        ):
            with self.subTest(label):
                slots_tree(self.root)
                self.default_stays(label, tail=example, rel=execs)
        slots_tree(self.root)
        self.default_stays(
            "an override continued onto the next line is still one assignment",
            tail='\n    FLEET_BOX_CORRECTNESS_SLOTS="rog-nv-wsl=3 \\\n      mac-studio=2" fleet-worker.sh ls\n',
            rel=execs,
        )
        # Positionally, though: prose after an assignment on the same line is still prose.
        slots_tree(self.root)
        o = self.s.other
        append(
            f"{self.root}/README.md",
            f'\nRun FLEET_BOX_CORRECTNESS_SLOTS="mac-studio=2" to halve it; mac-studio={o} is not the default.\n',
        )
        self.expect(
            "a count beside an assignment on one line is still judged", 1, f"README.md: states 'mac-studio={o}'"
        )

    # Prose written in the SHAPE of an assignment, inside a comment, is still prose -- and
    # fleet-worker.sh's header is one of the declarations this check exists to hold in sync.
    def test_comments_are_statements(self) -> None:
        R, s = self.root, self.s
        rewrite(
            R,
            WORKER,
            pattern=rf"^(#.*?)[\"']?mac-studio={s.want}[\"']?",
            repl=rf"\g<1>FLEET_BOX_CORRECTNESS_SLOTS=mac-studio={s.other}",
            lines=False,
        )
        want = f"{WORKER}: states 'mac-studio={s.other}'"
        self.expect("a count in a comment is held even when it is spelled as an assignment", 1, want)
        slots_tree(R)
        append(f"{R}/{WORKER}", f"# was: SLOTS=mac-studio={s.other}\n")
        self.expect("...and a commented-out assignment is a statement, not a setting", 1, want)

    # The default is the assignment's VALUE, read as the worker reads it.
    def test_the_defaults_value(self) -> None:
        R, s = self.root, self.s
        # Prose on the line cannot stand in for a default the script no longer has.
        rewrite(
            R, WORKER, pattern=r"^SLOTS=.*", repl=lambda _: 'SLOTS="${FLEET_BOX_CORRECTNESS_SLOTS-}" # old mac-studio=6'
        )
        self.expect(
            "a default left only in a trailing comment is no default",
            1,
            f"{WORKER}: SLOTS assignment states no 'mac-studio=<n>' default",
        )
        cases: tuple[tuple[str, int, str, Callable[[], None]], ...] = (
            (
                "a malformed default is no default",
                1,
                f"{WORKER}: SLOTS assignment states 'mac-studio={s.want}oops'",
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new=f"mac-studio={s.want}oops"),
            ),
            (
                "a default behind another box's pair is still the default",
                0,
                self.AGREE,
                lambda: self.set_slots(f'SLOTS="${{FLEET_BOX_CORRECTNESS_SLOTS-testbox=2 mac-studio={s.want}}}"'),
            ),
            # The positivity rule judges the VALUE, so it sees through a leading zero.
            (
                "a zero written with a leading zero is still zero",
                1,
                f"{WORKER}: SLOTS assignment states mac-studio=0",
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new="mac-studio=00"),
            ),
            # The positive-count rule is the worker's, and it applies to every pair it reads.
            (
                "a zero count for another box refuses the spec too",
                1,
                f"{WORKER}: SLOTS assignment states 'rog-nv-wsl=0'",
                lambda: self.set_slots('SLOTS="rog-nv-wsl=0 mac-studio=6"'),
            ),
            # The count is a NUMBER: `06` is the six the worker reads, on either side.
            (
                "a default written with a leading zero still spells its number",
                0,
                self.AGREE,
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new=f"mac-studio=0{s.want}"),
            ),
            (
                "...and so does a prompt that writes one",
                0,
                self.AGREE,
                lambda: rewrite(
                    R,
                    "issue-wave/references/executions.md",
                    pattern=f"mac-studio={s.want}",
                    repl=f"mac-studio=0{s.want}",
                ),
            ),
            # A LITERAL pair list is what the worker splits and validates in order, so a malformed
            # pair anywhere in one refuses the spec.
            (
                "another box's malformed pair refuses the whole spec",
                1,
                f"{WORKER}: SLOTS assignment states 'rog-nv-wsl=oops'",
                lambda: self.set_slots('SLOTS="rog-nv-wsl=oops mac-studio=6"'),
            ),
            (
                "...while a list whose pairs are all valid still defaults",
                0,
                self.AGREE,
                lambda: self.set_slots(f'SLOTS="rog-nv-wsl=1 mac-studio={s.want}"'),
            ),
            # Every mac-studio pair in the value is validated, not just the last recognizable one.
            (
                "a malformed pair is refused even with a valid one behind it",
                1,
                f"{WORKER}: SLOTS assignment states 'mac-studio=oops'",
                lambda: self.set_slots('SLOTS="mac-studio=oops mac-studio=6"'),
            ),
            # ...and where every pair is valid, the last one for the box is the default.
            (
                "a box named twice takes its last count",
                0,
                self.AGREE,
                lambda: self.set_slots(f'SLOTS="mac-studio={s.other} mac-studio={s.want}"'),
            ),
            # `box_correctness_slots` refuses a count below one.
            (
                "a zero default is refused, not agreed with",
                1,
                f"{WORKER}: SLOTS assignment states mac-studio=0",
                lambda: slots_assignment(R, old=f"mac-studio={s.want}", new="mac-studio=0"),
            ),
        )
        for label, rc, want, mutate in cases:
            with self.subTest(label):
                slots_tree(R)
                mutate()
                self.expect(label, rc, want)

    def set_slots(self, line: str) -> None:
        rewrite(self.root, WORKER, pattern=r"^SLOTS=.*", repl=lambda _: line)

    # The obligation comes from the script, as the fixtures' comes from a fixture.
    def test_no_worker_no_obligation(self) -> None:
        fresh(self.root)
        self.lacks(f"...and a root without {WORKER} carries no slot obligation", "mac-studio", run(CP, self.root))


# --- the installed-routine drift guard -----------------------------------------------------------
# ludics-lite#199: each routine sync-routines.sh installs opens by running it and reading its own
# drift, and nothing but this check stops that step being edited away. Both READMEs come along
# because the index lookup wants them and LINK_TARGETS because the link check does; no fixture and
# no fleet-worker.sh, so neither of those two agreements applies.


@dataclass(frozen=True)
class Drift:
    routines: tuple[str, ...]
    one: str
    want: str  # the refusal, naming the path the prompts must invoke


@functools.cache
def drift() -> Drift:
    routines = [
        m.group(1)
        for line in src_lines("scripts/sync-routines.sh")
        if (m := re.fullmatch(r'LOCAL_ROUTINES="([^"]*)"\s*', line))
    ]
    if not routines or not routines[0].split():
        raise AssertionError('the drift probes need a one-line LOCAL_ROUTINES="..." in scripts/sync-routines.sh')
    # The path the prompts must invoke, read off the README's clone command -- independently, so a
    # probe states no literal path and moving the checkout moves both.
    homes = [
        m.group(1)
        for line in src_lines("README.md")
        if (m := re.fullmatch(r"git clone \S*ludics\.git (~/\S*)\s*", line))
    ]
    if not homes:
        raise AssertionError("the drift probes need a 'git clone ... ~/<dir>' line in README.md")
    names = tuple(routines[0].split())
    return Drift(routines=names, one=names[0], want=f"runs no {homes[0]}/scripts/sync-routines.sh")


def drift_tree(root: str) -> None:
    shutil.rmtree(root, ignore_errors=True)
    copy_prompts(root, "README.md", "routines/README.md", *LINK_TARGETS, "scripts/sync-routines.sh")
    copy_prompts(root, *(f"routines/{r}/SKILL.md" for r in drift().routines))


# The invocation line, as the prompts write it: indented, the path alone.
INVOCATION = r"^( *)([^ `]*sync-routines\.sh)$"


class DriftGuardTest(Case):
    OK = "runs it to read its own drift"

    def setUp(self) -> None:
        super().setUp()
        self.d = drift()
        self.prompt = f"routines/{self.d.one}/SKILL.md"
        self.refused = f"{self.prompt}: {self.d.want}"
        drift_tree(self.root)

    def test_every_installed_routine_runs_the_drift_check(self) -> None:
        self.expect("every installed routine's prompt runs the drift check", 0, self.OK)

    def test_edited_away(self) -> None:
        R = self.root
        # The step edited out of a prompt is the drift this check exists for.
        rewrite(R, self.prompt, pattern=r"sync-routines\.sh", repl="the-sync-script", count=0)
        self.expect("a routine that stops naming the sync script is refused", 1, self.refused)
        # The mutation that matters, and the one a filename match would pass: delete the COMMAND and
        # leave every mention of it standing.
        drift_tree(R)
        delete_lines(R, self.prompt, pattern=r"^ {4,}[^`]*sync-routines\.sh\s*$")
        self.expect("a routine that keeps the prose and drops the command is refused", 1, self.refused)
        # A write is not the read: `push` and `pull` install and recover.
        drift_tree(R)
        rewrite(R, self.prompt, pattern=r"^( *[^ `]*sync-routines\.sh)$", repl=r"\1 push")
        self.expect("an invocation that writes instead of reading is refused", 1, self.refused)
        # ...and prose quoting the command is prose, however it is indented.
        drift_tree(R)
        rewrite(R, self.prompt, pattern=INVOCATION, repl=r"\1run `\2`")
        self.expect("an indented line quoting the command is not the command", 1, self.refused)

    # The ways a line can hold the path without running it -- the comment especially, which is how
    # a guard is disabled rather than deleted.
    def test_the_path_not_run(self) -> None:
        shapes = (
            ("a commented-out invocation", r"\1# \2"),
            ("an invocation commented out with no space", r"\1#\2"),
            ("the path as another command's argument", r"\1echo \2"),
            ("...and as cat's", r"\1cat \2"),
            ("the path assigned to a variable", r"\1DRIFT_COMMAND=\2"),
            ("...and assigned with export", r"\1export DRIFT_COMMAND=\2"),
            ("some other file of the same name", r"\1/tmp/sync-routines.sh"),
            ("...and one under a same-named directory elsewhere", r"\1/tmp/scripts/sync-routines.sh"),
        )
        for label, repl in shapes:
            with self.subTest(label):
                drift_tree(self.root)
                rewrite(self.root, self.prompt, pattern=INVOCATION, repl=repl)
                self.expect(f"{label} is not the command", 1, self.refused)

    # `$HOME` names the same path `~` does; and an indented command line is four blanks or more.
    def test_spelling_and_indentation(self) -> None:
        R = self.root
        rewrite(R, self.prompt, pattern=r"^( *)~/([^ `]*sync-routines\.sh)$", repl=r"\1$HOME/\2")
        self.expect("the invocation spelled through $HOME is the same command", 0, self.OK)
        drift_tree(R)
        rewrite(R, self.prompt, pattern=r"^ *([^ `]*sync-routines\.sh)$", repl=r"   \1")
        self.expect("an invocation indented less than four blanks is not the command", 1, self.refused)

    # The path is the README's to state, and the checker reads it from there rather than restating
    # it.
    def test_the_path_comes_from_the_readme(self) -> None:
        R = self.root
        rewrite(
            R,
            "README.md",
            pattern=r"^git clone .*ludics\.git ~/.*$",
            repl="git clone https://example.invalid/x.git",
        )
        self.expect("a README with no clone destination is refused, not passed", 1, "no ")
        drift_tree(R)
        rewrite(R, "README.md", pattern=r"^(git clone .*ludics\.git )~/ludics$", repl=r"\1~/elsewhere")
        self.expect(
            "the checkout path comes from the README, so moving it refuses the old invocation",
            1,
            "~/elsewhere/scripts/sync-routines.sh",
        )

    # Which prompts are held is read off the script, so a name added to LOCAL_ROUTINES arrives
    # obliged -- and one it installs with nothing to install from is refused rather than skipped.
    def test_the_routines_come_from_the_script(self) -> None:
        R = self.root
        shutil.rmtree(f"{R}/routines/{self.d.one}")
        self.expect(
            "a routine the script installs with no prompt here is refused",
            1,
            f"installs '{self.d.one}', but this checkout has no routines/{self.d.one}/SKILL.md",
        )
        drift_tree(R)
        rewrite(
            R,
            "scripts/sync-routines.sh",
            pattern=r"^LOCAL_ROUTINES=.*",
            repl='LOCAL_ROUTINES="a b" # not the one-line shape',
        )
        self.expect(
            "a LOCAL_ROUTINES this reader cannot see is refused, not passed", 1, "has no one-line LOCAL_ROUTINES"
        )

    # The obligation comes from the installer, as the fixtures' comes from a fixture.
    def test_no_installer_no_obligation(self) -> None:
        fresh(self.root)
        self.lacks("...and a root without the sync script carries no drift obligation", "drift", run(CP, self.root))


# --- the post-merge-cleanup option register ------------------------------------------------------
# ludics-lite#276 added `--regenerable` to post-merge-cleanup.sh's usage() and to ship-pr/SKILL.md
# by hand, in the PR that found the prompt's prose about the base-owner gate had been false for two
# PRs already. Both READMEs come along for the index lookup and LINK_TARGETS for the link check;
# no fixture, no worker, no sync script.

CLEANUP_HELPER = "ship-pr/scripts/post-merge-cleanup.sh"
CLEANUP_PROMPT = "ship-pr/SKILL.md"
CLEANUP_AGREE = f"{CLEANUP_PROMPT} and {CLEANUP_HELPER}'s usage() agree"


@dataclass(frozen=True)
class Cleanup:
    usage: str
    rc: int
    line: int  # the prompt's `  --base <b> --regenerable <d>` continuation line, 1-based


@functools.cache
def cleanup() -> Cleanup:
    # The helper in the tree is a STAND-IN that prints what the real helper prints: check-prompts
    # reads the helper's printed usage text and nothing else of it, and since the v2 rewrite
    # (ludics-lite#403) that text comes from a Python package the helper forwards to, which a copy
    # of the one file would not find. So the real helper is run once, here, as check-prompts runs
    # it, and the stand-in replays its stderr and exit status. The probes that mutate the helper
    # mutate that TEXT, which is the whole of what the checker sees, whatever renders it.
    p = subprocess.run(
        [BASH, os.path.join(SRC, CLEANUP_HELPER)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=ENV,
        check=False,
    )
    usage = p.stderr.decode("latin-1").rstrip("\n")
    if p.returncode != 2:
        raise AssertionError(f"the real {CLEANUP_HELPER} run with no arguments exited {p.returncode}, not 2: {usage}")
    # The one invocation line the mutations rewrite, read off the prompt rather than restated, so a
    # probe goes stale at the edit that moves it instead of asserting over a line no longer there.
    at = [
        i + 1
        for i, line in enumerate(src_lines(CLEANUP_PROMPT))
        if re.fullmatch(r"  --base \S* --regenerable \S*", line)
    ]
    if not at:
        raise AssertionError(
            f"the cleanup probes need a '  --base <b> --regenerable <d>' continuation line in {CLEANUP_PROMPT}"
        )
    return Cleanup(usage=usage, rc=p.returncode, line=at[0])


def cleanup_tree(root: str) -> None:
    shutil.rmtree(root, ignore_errors=True)
    copy_prompts(root, "README.md", "routines/README.md", CLEANUP_PROMPT, *LINK_TARGETS)
    c = cleanup()
    helper = os.path.join(root, CLEANUP_HELPER)
    write(helper, f"#!/usr/bin/env bash\ncat >&2 <<'CLEANUP_USAGE_TEXT'\n{c.usage}\nCLEANUP_USAGE_TEXT\nexit {c.rc}\n")
    os.chmod(helper, 0o755)


def helper_prelude(root: str, *, lines: str) -> None:
    """Puts shell lines into the stand-in helper, right after its shebang."""
    rewrite(root, CLEANUP_HELPER, pattern=r"\A(#![^\n]*\n)", repl=lambda m: m.group(1) + lines, lines=False)


class CleanupOptionsTest(Case):
    def setUp(self) -> None:
        super().setUp()
        self.c = cleanup()
        cleanup_tree(self.root)

    def fence(self, *lines: str) -> None:
        """Appends a fenced bash block to the prompt."""
        append(f"{self.root}/{CLEANUP_PROMPT}", "\n```bash\n" + "".join(f"{x}\n" for x in lines) + "```\n")

    def add_dry_run(self) -> None:
        """Lists a `--dry-run` flag in the helper's usage text, ahead of `--base`, as the option
        table renders a row with no placeholder -- the one row shape the real table does not carry."""
        rewrite(
            self.root,
            CLEANUP_HELPER,
            pattern=r"^  --base ",
            repl="  --dry-run             Report what cleanup would do and change nothing\n  --base ",
        )

    def test_the_prompt_and_the_helper_agree(self) -> None:
        self.expect("the real prompt and the helper's usage() list the same options", 0, CLEANUP_AGREE)

    def test_drift_both_ways(self) -> None:
        R = self.root
        # The drift ludics-lite#276 was: an option the helper gains that the prompt never names.
        self.add_dry_run()
        self.expect(
            "an option usage() lists that the prompt never names is refused",
            1,
            f"{CLEANUP_PROMPT}: names no '--dry-run'",
        )
        # ...and the other direction, on a CONTINUATION line, which is where the real prompt keeps
        # its options, so this also proves the backslash is followed.
        cleanup_tree(R)
        edit_line(R, CLEANUP_PROMPT, at=self.c.line, pattern="$", repl=" --keep-branch")
        self.expect(
            "an option the prompt passes that usage() does not list is refused",
            1,
            f"{CLEANUP_PROMPT}: passes '--keep-branch' to {CLEANUP_HELPER}",
        )
        # A renamed option fails both ways at once.
        cleanup_tree(R)
        rewrite(R, CLEANUP_PROMPT, pattern="--force-integrated", repl="--force-merged", count=0)
        result = self.expect("a renamed option is refused as missing", 1, "names no '--force-integrated'")
        self.check("...and as passed unlisted", 1, result, "passes '--force-merged'")
        # The token whole: the prompt naming `--base-branch` does not name `--base`.
        cleanup_tree(R)
        rewrite(R, CLEANUP_PROMPT, pattern=r"--base([^-])", repl=r"--base-branch\1", count=0)
        self.expect("a longer option carrying the listed one as a prefix does not name it", 1, "names no '--base'")

    # What is attributed to the helper is its own command line, in a fence. The same `--flag` on
    # another command's line, or in prose, is not, so the register does not grow to cover every tool
    # the prompt mentions.
    def test_what_is_the_helpers(self) -> None:
        R = self.root
        prompt = f"{R}/{CLEANUP_PROMPT}"
        append(prompt, "\n```bash\ngh pr merge --delete-branch --squash\n```\n\nOr pass `--no-such-flag` to nothing.\n")
        self.expect("an option on another command's fenced line, or in prose, is nobody's", 0, CLEANUP_AGREE)
        cleanup_tree(R)
        self.fence("~/.claude/skills/ship-pr/scripts/test-post-merge-cleanup.sh --list")
        self.expect("...and the test runner, whose name ends in the helper's, is another command", 0, CLEANUP_AGREE)
        cleanup_tree(R)
        append(prompt, "\nSome run `post-merge-cleanup.sh a b c --keep-branch` and regret it.\n")
        self.expect("an invocation quoted in prose is not a command line", 0, CLEANUP_AGREE)
        # ...and a continuation is a trailing backslash: without it the next line is its own.
        cleanup_tree(R)
        edit_line(R, CLEANUP_PROMPT, at=self.c.line - 1, pattern=r" \\$", repl="")
        edit_line(R, CLEANUP_PROMPT, at=self.c.line, pattern="$", repl=" --keep-branch")
        self.expect("a line the backslash no longer continues passes nothing", 0, CLEANUP_AGREE)

    # The shell's word boundaries, as far as the reader models them (review rounds 1-4, P2 each).
    # Each is a shape that let an unlisted option through, or refused a valid helper.
    def test_the_word_model(self) -> None:
        refused: tuple[tuple[str, tuple[str, ...]], ...] = (
            (
                "an invocation chained AFTER another command is still read",
                ("gh pr view; ~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --keep-branch",),
            ),
            (
                "...and a second invocation of the helper on one line",
                ("~/x/post-merge-cleanup.sh a b c --base main && ~/x/post-merge-cleanup.sh a b c --keep-branch",),
            ),
            (
                "an option after a redirection is still the helper's",
                ("~/x/post-merge-cleanup.sh a b c 2>&1 --keep-branch",),
            ),
            (
                "a quoted helper path is still the helper",
                ('"$HOME/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh" a b c --keep-branch',),
            ),
            ("a quoted option word is the option", ('~/x/post-merge-cleanup.sh a b c "--keep-branch"',)),
            (
                "a bare invocation after a shell operator is the helper",
                ("(post-merge-cleanup.sh a b c --keep-branch)",),
            ),
            ("...and one inside a command substitution", ("out=$(~/x/post-merge-cleanup.sh a b c --keep-branch)",)),
            # A separator inside a quoted or escaped value ends nothing.
            (
                "a separator inside a double-quoted value ends nothing",
                ('~/x/post-merge-cleanup.sh a b c --force-integrated "confirmed; by GitHub" --keep-branch',),
            ),
            (
                "...nor inside a single-quoted one",
                ("~/x/post-merge-cleanup.sh a b c --force-integrated 'a | b' --keep-branch",),
            ),
            (
                "...nor an escaped one",
                ("~/x/post-merge-cleanup.sh a b c --force-integrated confirmed\\; --keep-branch",),
            ),
            (
                "...while a # inside a quoted value is text",
                ('~/x/post-merge-cleanup.sh a b c --force-integrated "not # a comment" --keep-branch',),
            ),
        )
        for label, lines in refused:
            with self.subTest(label):
                cleanup_tree(self.root)
                self.fence(*lines)
                self.expect(label, 1, "passes '--keep-branch'")
        agreed: tuple[tuple[str, tuple[str, ...]], ...] = (
            # The helper's command ends at the first shell separator.
            (
                "an option of a command chained after the helper on its line is that command's",
                (
                    "git fetch origin && ~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --base main; gh pr view --json number",
                ),
            ),
            (
                "...and a continuation past a separator is not the helper's either",
                (
                    "~/.claude/skills/ship-pr/scripts/post-merge-cleanup.sh a b c --base main | tee log.txt \\",
                    "  --keep-branch",
                ),
            ),
            # The word after a valued option is its value, whatever it looks like.
            (
                "a valued option's value is its value, however it is spelled",
                ("~/x/post-merge-cleanup.sh a b c --force-integrated --confirmed-by-GitHub --regenerable --cache",),
            ),
            ("...across a continuation too", ("~/x/post-merge-cleanup.sh a b c --base \\", "  --keep-branch")),
            # An unquoted `#` starts a comment the shell passes nothing from.
            (
                "a trailing shell comment passes nothing",
                ("~/x/post-merge-cleanup.sh a b c --base main # never pass --keep-branch here",),
            ),
        )
        for label, lines in agreed:
            with self.subTest(label):
                cleanup_tree(self.root)
                self.fence(*lines)
                self.expect(label, 0, CLEANUP_AGREE)

    def test_fences(self) -> None:
        R = self.root
        prompt = f"{R}/{CLEANUP_PROMPT}"
        # A fence indented up to three blanks is a fence.
        append(prompt, "\n   ```bash\n   ~/x/post-merge-cleanup.sh a b c --keep-branch\n   ```\n")
        self.expect("an indented fence is a fence", 1, "passes '--keep-branch'")
        # A fence closes only on a run as long as its opener.
        cleanup_tree(R)
        append(prompt, "\n````bash\ncat <<X\n```\nX\n~/x/post-merge-cleanup.sh a b c --keep-branch\n````\n")
        self.expect("a three-backtick line inside a four-backtick fence does not close it", 1, "passes '--keep-branch'")

    # The token is the whole word: a suffix the helper's parser refuses is not the listed prefix.
    def test_misspellings(self) -> None:
        R, at = self.root, self.c.line
        edit_line(R, CLEANUP_PROMPT, at=at, pattern="--base main", repl="--base_branch main")
        self.expect(
            "a misspelled option is reported whole, not truncated to its listed prefix", 1, "passes '--base_branch'"
        )
        cleanup_tree(R)
        edit_line(R, CLEANUP_PROMPT, at=at, pattern="--base main", repl="--base=main")
        self.expect("...and so is the = spelling, which the helper does not take", 1, "passes '--base=main'")
        # The listing side uses the same token grammar as the invocation side.
        cleanup_tree(R)
        rewrite(R, CLEANUP_PROMPT, pattern=r"--base([^-A-Za-z0-9_])", repl=r"--base_branch\1", count=0)
        self.expect("a misspelling in prose does not name the listed option", 1, "names no '--base'")

    # ...while an option usage() lists with no <value> placeholder consumes nothing.
    def test_a_flag_consumes_nothing(self) -> None:
        self.add_dry_run()
        append(
            f"{self.root}/{CLEANUP_PROMPT}",
            "\nPass `--dry-run` to rehearse.\n\n```bash\n~/x/post-merge-cleanup.sh a b c --dry-run --keep-branch\n```\n",
        )
        self.expect("a flag option consumes no value, so the word after it is read", 1, "passes '--keep-branch'")

    # The listing side is a mention, verbatim, anywhere in the prompt: the option's command lines
    # deleted and its prose kept still names it. That is the residue this check states rather than
    # hides -- a name present says nothing about whether the prose around it is true.
    def test_a_name_in_prose_names_it(self) -> None:
        delete_lines(self.root, CLEANUP_PROMPT, pattern=r"^  --base \S* --regenerable ")
        self.expect("an option named only in prose is still named", 0, CLEANUP_AGREE)

    # The register is read off the helper's printed usage text, which it renders from the option
    # table its parse loop reads (ludics-lite#332).
    def test_the_usage_text(self) -> None:
        R = self.root
        # A text this reader sees no options in is refused rather than holding the prompt to nothing.
        delete_lines(R, CLEANUP_HELPER, pattern="^  ")
        self.expect(
            "a usage() listing no options is refused, not passed", 1, f"{CLEANUP_HELPER}: usage() lists no options"
        )
        # ...and a run that is not the usage error is no listing at all.
        cleanup_tree(R)
        rewrite(R, CLEANUP_HELPER, pattern="^exit 2$", repl="exit 1")
        self.expect(
            "a helper whose usage error does not exit 2 is refused",
            1,
            f"{CLEANUP_HELPER}: run with no arguments, it printed no usage text",
        )
        # A row's placeholder is both what the text prints and what the parser consumes, so a flag
        # row is listed bare -- and the word after it is read as the next option.
        cleanup_tree(R)
        rewrite(R, CLEANUP_HELPER, pattern=r"^  --regenerable <name>  ", repl="  --regenerable         ")
        self.fence("~/x/post-merge-cleanup.sh a b c --regenerable --keep-branch")
        self.expect(
            "a flag row in the table is listed bare, so the word after it is an option", 1, "passes '--keep-branch'"
        )

    # A helper with no prompt to document it is refused; a root with no helper carries no
    # obligation, as with the sync script and the worker.
    def test_obligations(self) -> None:
        os.remove(f"{self.root}/{CLEANUP_PROMPT}")
        self.expect("a helper without its prompt is refused", 1, f"has no {CLEANUP_PROMPT}")
        fresh(self.root)
        self.lacks(
            "...and a root without the helper carries no option obligation", "post-merge-cleanup", run(CP, self.root)
        )

    # The helper runs with no input, and its usage text is a command substitution's, which drops a
    # NUL (the shell checker's readings, kept by the port).
    def test_how_the_helper_is_run(self) -> None:
        R = self.root
        helper_prelude(R, lines='if [ "$#" -eq 0 ] && read -r _; then echo "usage: stdin was read" >&2; exit 2; fi\n')
        self.expect("the cleanup helper is run with no input", 0, CLEANUP_AGREE, stdin=b"x\n")
        cleanup_tree(R)
        helper_prelude(R, lines="if [ \"$#\" -eq 0 ]; then printf 'usage: x\\n  --base\\000x <b>\\n' >&2; exit 2; fi\n")
        self.expect("a NUL in the usage text is dropped, joining the name around it", 1, "names no '--basex'")


# --- relative links and anchors ------------------------------------------------------------------
# ludics-lite#260 cut the wave prompt and its references into sections addressed by anchor, and
# every one of those links was verified by hand, once; this is what re-verifies them. Two trees, for
# the two things there are to pin. A scratch one for the READING -- what counts as a link, which
# directory a path is read from, what a heading slugs to -- where each probe is one defect against
# the well-formed control. Then the REAL prompts, copied, for the claim that today's links resolve
# and that a moved heading or a renamed file is caught.

NOTES = "alpha/references/notes.md"
NOTES_MD = """\
# Notes

## Close-out

The first one.

## Supervision, recovery and evidence

Punctuation to drop, blanks to hyphenate.

## Close-out

The second one, which GitHub numbers.

## Notes-1

An explicit suffix, standing where a repeat would want to land.

## Notes

A third collision, which has to step over the explicit one.

"""


def links_tree(root: str) -> None:
    """A passing layout, plus a reference file for the prompts to link into."""
    fresh(root)
    # An em dash, the non-ASCII punctuation this prose is written with and GitHub drops, written as
    # its UTF-8 bytes.
    write(os.path.join(root, NOTES), NOTES_MD.encode() + b"## Close \xe2\x80\x94 out\n\nPunctuation GitHub drops.\n\n")
    write(os.path.join(root, "alpha/references/a_(b).md"), "A parenthesized filename.\n")


def links_body(root: str, rel: str, *lines: str) -> None:
    """Appends Markdown lines to a file in the scratch tree."""
    append(os.path.join(root, rel), "".join(f"{x}\n" for x in lines))


def links_nonascii(root: str, rel: str) -> None:
    """Appends a heading carrying a letter GitHub keeps, whose anchor this check will not guess at."""
    append(os.path.join(root, rel), b"\n## Caf\xc3\xa9\n\nA letter GitHub keeps.\n")


def links_unspellable(root: str, rel: str) -> None:
    """Appends a heading GitHub slugs by its RENDERED text (`foo`), which is not its source. On the
    END of a file on purpose -- it suppresses the numbering after it -- so probes about ordinary
    headings add it only when they mean to."""
    append(os.path.join(root, rel), "\n## [Foo](https://example.invalid)\n\nInline link syntax.\n")


GONE = "resolves to no file: alpha/references/gone.md"
UNSPELLABLE = "will not spell an anchor for"


def no_slug(anchor: str) -> str:
    return f"GitHub slug is '{anchor}'"


class LinksTest(Case):
    def setUp(self) -> None:
        super().setUp()
        links_tree(self.root)

    def heading_case(self, label: str, rc: int, want: str, *, heading: str | bytes, link: str) -> None:
        """A fresh links tree with ``heading`` appended to the notes and ``link`` to the skill."""
        links_tree(self.root)
        append(f"{self.root}/{NOTES}", heading)
        links_body(self.root, "alpha/SKILL.md", link)
        self.expect(label, rc, want)

    def link_case(self, label: str, rc: int, want: str, *lines: str) -> None:
        """A fresh links tree with ``lines`` appended to the skill."""
        links_tree(self.root)
        links_body(self.root, "alpha/SKILL.md", *lines)
        self.expect(label, rc, want)

    def test_resolving_and_broken(self) -> None:
        self.link_case(
            "a resolving link, with an anchor and without",
            0,
            "(2 checked)",
            "See [one section](references/notes.md#close-out) and [all of it](references/notes.md).",
        )
        self.link_case(
            "a link to a file that is not there",
            1,
            "alpha/SKILL.md: link to references/gone.md resolves to no file: alpha/references/gone.md",
            "See [what moved](references/gone.md).",
        )
        self.link_case(
            "an anchor no heading slugs to",
            1,
            "link to references/notes.md#launch names no heading: alpha/references/notes.md has none whose GitHub slug is 'launch'",
            "See [what was retitled](references/notes.md#launch).",
        )

    # The slug is GitHub's: blanks become hyphens, a hyphen already there stays, and the punctuation
    # between them goes; a repeated heading takes GitHub's numbering; the anchor is compared as TEXT
    # and in full.
    def test_slugs(self) -> None:
        cases = (
            ("punctuation is dropped and blanks become hyphens", 0, "(1 checked)", "supervision-recovery-and-evidence"),
            (
                "...while a hyphen in the heading is kept, not dropped with the punctuation",
                1,
                no_slug("closeout"),
                "closeout",
            ),
            ("a repeated heading takes GitHub's -1 suffix", 0, "(1 checked)", "close-out-1"),
            ("...and only as many of them as the file writes", 1, no_slug("close-out-2"), "close-out-2"),
            ("an anchor that is a prefix of a slug is not that slug", 1, no_slug("close"), "close"),
            ("a '.' in an anchor is that character, not a wildcard", 1, no_slug("close.out"), "close.out"),
            # GitHub numbers a repeat by taking the next FREE name, so an explicit `## Notes-1`
            # standing between two `## Notes` pushes the second repeat to `notes-2` (round 1, P2).
            ("a repeat steps over a heading that already holds its suffix", 0, "(1 checked)", "notes-2"),
            ("...and that heading keeps its own name", 0, "(1 checked)", "notes-1"),
            ("...and no further name is handed out", 1, no_slug("notes-3"), "notes-3"),
            # Beyond ASCII the slug is knowable for General Punctuation, which GitHub drops.
            ("the punctuation GitHub drops is dropped here too", 0, "(1 checked)", "close--out"),
        )
        for label, rc, want, anchor in cases:
            with self.subTest(label):
                self.link_case(label, rc, want, f"See [it](references/notes.md#{anchor}).")

    # ...and is not knowable for a byte that may be a letter GitHub keeps: the heading contributes
    # no slug and the link is refused with the reason (round 1, P2).
    def test_a_letter_past_ascii(self) -> None:
        links_nonascii(self.root, NOTES)
        links_body(self.root, "alpha/SKILL.md", "See [the ASCII residue](references/notes.md#caf).")
        self.expect(
            "a heading carrying a letter past ASCII spells no anchor, so its residue answers for none", 1, UNSPELLABLE
        )

    # A path is read from the LINKING file's directory. Both directions: the root-relative spelling
    # of a target that resolves is a different file, and `..` climbs out of a reference directory.
    def test_paths(self) -> None:
        R = self.root
        self.link_case(
            "a path is read from the linking file's directory, not from the root",
            1,
            "resolves to no file: alpha/alpha/references/notes.md",
            "See [the root-relative spelling](alpha/references/notes.md).",
        )
        links_tree(R)
        links_body(R, NOTES, "Back to [the prompt](../SKILL.md).")
        self.expect("a reference file is a linking file too, and '..' climbs from it", 0, "(1 checked)")
        # A path that climbed out of the checkout is refused on the PATH, and never probed on the
        # filesystem: the probe plants exactly that file beside the tree, which under a filesystem
        # test would make the link read as resolving.
        links_tree(R)
        write(f"{self.base}/outside.md", "Outside the checkout.\n")
        links_body(R, NOTES, "Out of [the checkout](../../../outside.md).")
        self.expect(
            "a path that climbs past the root is refused, even where that file exists",
            1,
            "resolves outside the checkout: ../outside.md",
        )

    # Every file the scan reads links in is one, not just the skill prompts.
    def test_linking_files(self) -> None:
        R = self.root
        for label, rel, target in (
            ("README.md is a linking file", "README.md", "missing.md"),
            ("...and routines/README.md", "routines/README.md", "routines/missing.md"),
            ("...and a routine prompt", "routines/nightly/SKILL.md", "routines/nightly/missing.md"),
        ):
            with self.subTest(label):
                links_tree(R)
                links_body(R, rel, "See [nothing](missing.md).")
                self.expect(label, 1, f"FAIL: {rel}: link to missing.md resolves to no file: {target}")
        # A routine keeps its reference files under `routines/<name>/references/`, and the second
        # hop out of one was where a missing target passed (round 5, P2).
        links_tree(R)
        write(f"{R}/routines/nightly/references/guide.md", "# Guide\n\nSee [the second hop](gone.md).\n")
        self.expect(
            "a routine reference file is a linking file too",
            1,
            "routines/nightly/references/guide.md: link to gone.md resolves to no file",
        )
        # A reference file whose name begins with a dot is a reference file (round 12, P2).
        links_tree(R)
        write(f"{R}/alpha/references/.guide.md", "# Guide\n\nSee [the second hop](gone.md).\n")
        self.expect(
            "a dotted reference file is a linking file too",
            1,
            "alpha/references/.guide.md: link to gone.md resolves to no file",
        )

    # What falls outside the one shape this reads is NOT CHECKED rather than guessed at. Each target
    # names something that is not there, so a probe that passes is a probe reporting the gap it is
    # meant to report -- and each gap reports nothing rather than reporting wrongly.
    def test_outside_the_shape(self) -> None:
        shapes = (
            ("an http(s) URL", "[released](https://example.invalid/missing.md)"),
            ("another URI scheme", "[write in](mailto:nobody@example.invalid)"),
            ("a link carrying a title", '[titled](references/gone.md "Not read")'),
            ("a site-absolute path", "[absolute](/references/gone.md)"),
            ("a same-file anchor, which names no file", "[here](#close-out)"),
            ("a target that is not Markdown", "[the licence](LICENSE)"),
        )
        for label, link in shapes:
            with self.subTest(label):
                self.link_case(f"outside the shape, so not read: {label}", 0, "0 failed", f"See {link}.")
        self.link_case(
            "outside the shape, so not read: a link split across two lines",
            0,
            "0 failed",
            "See [a target on the next line](",
            "references/gone.md).",
        )
        # The target must be SPELLED as a path in this checkout: a percent escape is a reading this
        # scan does not do (round 2, P2). The DECODED file is planted, so neither a literal probe
        # nor a decoding one could pass here by accident.
        links_tree(self.root)
        write(f"{self.root}/alpha/references/my notes.md", "A name needing an escape.\n")
        links_body(self.root, "alpha/SKILL.md", "See [an escaped name](references/my%20notes.md).")
        self.expect("outside the shape, so not read: a percent-escaped destination", 0, "0 failed")
        self.link_case(
            "outside the shape, so not read: a destination in angle brackets",
            0,
            "0 failed",
            "See [an angle-bracket destination](<references/gone.md>).",
        )

    # There is no fenced-code scope, which is the reading's one gap that cuts both ways -- pinned
    # from both sides, so it is a decision on record rather than a hole nobody meant.
    def test_no_fence_scope(self) -> None:
        R = self.root
        links_body(R, NOTES, "```sh", "# Improvised heading", "```")
        links_body(R, "alpha/SKILL.md", "See [a comment in a fence](references/notes.md#improvised-heading).")
        self.expect("a '#' comment inside a fence reads as a heading", 0, "(1 checked)")
        self.link_case(
            "...and a link inside a fence is read like any other",
            1,
            "link to references/gone.md resolves to no file",
            "```",
            "See [an example](references/gone.md).",
            "```",
        )
        # The same on one line, which is the form documentation actually reaches for.
        self.link_case(
            "...and one quoted between backticks is read as the link it spells",
            1,
            "link to references/gone.md resolves to no file",
            "The shape read is `[label](references/gone.md)`, quoted here in prose.",
        )
        # A heading inside an HTML comment contributes an anchor, as one inside a fence does: that
        # can ACCEPT a link GitHub would not resolve, and refuses none (round 4, P2, rebutted).
        self.heading_case(
            "a heading inside an HTML comment contributes an anchor, as one inside a fence does",
            0,
            "(1 checked)",
            heading="\n<!--\n## Hidden\n-->\n",
            link="See [a heading inside a comment](references/notes.md#hidden).",
        )

    # A Markdown destination may carry balanced parentheses, so the target ends at the paren that
    # closes the link and not at the first one (round 1, P2).
    def test_parentheses(self) -> None:
        self.link_case(
            "a destination carrying balanced parentheses is read whole",
            0,
            "(1 checked)",
            "See [a parenthesized name](references/a_(b).md).",
        )
        self.link_case(
            "...so a missing one is reported, not skipped",
            1,
            "resolves to no file: alpha/references/a_(c).md",
            "See [a parenthesized name](references/a_(c).md).",
        )
        self.link_case(
            "...while an aside after a link is not part of its target",
            0,
            "(1 checked)",
            "Prose [linking](references/notes.md) and then (an aside in parentheses).",
        )

    # A false `](` -- the token written in prose, or a bracket pair that opens no link -- does not
    # abandon or swallow the rest of the LINE (rounds 2 and 3, P2).
    def test_false_candidates(self) -> None:
        cases = (
            (
                "a false ]( does not abandon the link after it",
                "The token ]( is documented; see [the guide](references/gone.md).",
            ),
            (
                "...nor does a destination whose parens never close",
                "[Mismatched](references/notes.md and then [a real one](references/gone.md).",
            ),
            (
                "a rejected candidate does not swallow the link nested inside it",
                "Token ]( prose [the guide](references/gone.md).)",
            ),
            (
                "...and neither does a title, which is rejected for a different reason",
                'A [titled one](references/notes.md "T") then [a real one](references/gone.md).',
            ),
            (
                "...while the labelled one on the same line is still read",
                "The token ](references/gone.md) is documented; [and here](references/gone.md) it is.",
            ),
            ("...while the one that does close at it opens a link", "A [note] then [a real one](references/gone.md)."),
            (
                "...while two backslashes escape each other and leave a real opener",
                "Prose with \\\\[note](references/gone.md), where the backslash is the escaped one.",
            ),
        )
        for label, line in cases:
            with self.subTest(label):
                self.link_case(label, 1, GONE, line)
        # A `+` is one of the path characters the shape admits.
        self.link_case(
            "a '+' is a path character, so its target is read",
            1,
            "resolves to no file: alpha/references/c++.md",
            "See [a plus in the name](references/c++.md).",
        )
        # A link opens with a LABEL: the label is the bracket THIS `]` closes, read with backslash
        # parity, so a token, a bracket already closed or an escaped bracket opens nothing.
        not_links = (
            (
                "a target with no opening label is not a link, so its file is not required",
                "The token ](references/gone.md) is documented, and is not a link.",
            ),
            (
                "a bracket already closed is not this link's label",
                "A [note] then ](references/gone.md) as a token, not a link.",
            ),
            (
                "an escaped bracket opens no label",
                "Prose with \\[note](references/gone.md) escaped, which renders as text.",
            ),
            (
                "an escaped closing bracket closes no label",
                "Prose [with an escaped closer\\](references/gone.md) renders as text.",
            ),
        )
        for label, line in not_links:
            with self.subTest(label):
                self.link_case(label, 0, "0 failed", line)

    # GitHub slugs a heading by its RENDERED text; this reads the source. Where the two differ the
    # heading spells no anchor at all (round 2 onwards, P2) -- tested narrowly, so the far commoner
    # literal readings, where both sides agree, keep working.
    def test_rendered_versus_source(self) -> None:
        R = self.root
        links_unspellable(R, NOTES)
        links_body(R, "alpha/SKILL.md", "See [the source reading](references/notes.md#foohttpsexampleinvalid).")
        self.expect("a heading carrying inline link syntax accepts no anchor from its source", 1, UNSPELLABLE)
        links_tree(R)
        links_unspellable(R, NOTES)
        links_body(R, "alpha/SKILL.md", "See [the rendered reading](references/notes.md#foo).")
        self.expect("...and says so rather than answering for the rendered one either", 1, UNSPELLABLE)
        cases: tuple[tuple[str, int, str, str, str], ...] = (
            (
                "...while literal brackets render as their source and still slug",
                0,
                "(1 checked)",
                "## Notes [draft]\n\nLiteral brackets, which render as themselves.\n",
                "notes-draft",
            ),
            (
                "a heading carrying an HTML tag spells no anchor from its source",
                1,
                UNSPELLABLE,
                "\n## <em>Foo</em>\n\nAn HTML tag.\n",
                "emfooem",
            ),
            (
                "...and neither does one carrying a character entity",
                1,
                UNSPELLABLE,
                "\n## A &amp; B\n\nAn entity.\n",
                "a-amp-b",
            ),
            (
                "...while a bare < or & is text to both readings and still slugs",
                0,
                "(1 checked)",
                "\n## A < B and Launch & supervise\n\nLiteral, on both sides.\n",
                "a--b-and-launch--supervise",
            ),
            # Underscore emphasis: the slugger keeps `_` as a word character (round 4, P2).
            (
                "a heading carrying underscore emphasis spells no anchor from its source",
                1,
                UNSPELLABLE,
                "\n## _Foo_\n\nUnderscore emphasis.\n",
                "_foo_",
            ),
            (
                "...while an intraword underscore is text to both readings and keeps its anchor",
                0,
                "(1 checked)",
                "\n## FLEET_BOX_CORRECTNESS_SLOTS\n\nIntraword, so literal on both sides.\n",
                "fleet_box_correctness_slots",
            ),
            # A code span's CONTENT is literal text: padding stripped as CommonMark strips it, its
            # content slugged as the text it is, and the markup tests not reading into it (round 5).
            (
                "a padded code span renders without its padding",
                0,
                "(1 checked)",
                "\n## ` padded `\n\nA span whose content is padded.\n",
                "padded",
            ),
            (
                "...so the source reading, spaces and all, names no heading",
                1,
                no_slug("-padded-"),
                "\n## ` padded `\n\nA span whose content is padded.\n",
                "-padded-",
            ),
            (
                "underscores inside a code span are literal, not emphasis",
                0,
                "(1 checked)",
                "\n## `_foo_`\n\nEmphasis markers inside a span are literal.\n",
                "_foo_",
            ),
            (
                "...and so are a tag and an entity, which the markup tests must not read into",
                0,
                "(1 checked)",
                "\n## `<T>` and `&amp;`\n\nMarkup inside a span is literal too.\n",
                "t-and-amp",
            ),
            (
                "...while a backtick run with no closing match is just a backtick",
                0,
                "(1 checked)",
                "\n## unclosed `run\n\nA backtick run with no match is literal.\n",
                "unclosed-run",
            ),
            # A backslash makes the next ASCII punctuation literal, before any delimiter test
            # (round 6, P2).
            (
                "an escaped underscore is literal, so its heading keeps its anchor",
                0,
                "(1 checked)",
                "\n## \\_Foo\\_\n\nEscaped underscores, which render as themselves.\n",
                "_foo_",
            ),
            (
                "...and an escaped angle bracket opens no tag",
                0,
                "(1 checked)",
                "\n## \\<em\\> literal\n\nAn escaped angle bracket is not a tag.\n",
                "em-literal",
            ),
            (
                "...while an escaped backtick opens no span, so what it held is read as emphasis",
                1,
                UNSPELLABLE,
                "\n## \\`_foo_\\`\n\nEscaped backticks open no span, so the underscores are emphasis.\n",
                "_foo_",
            ),
            # One-sided code-span padding is preserved (round 9, P2).
            (
                "a space a code span preserves is not trimmed away after rendering",
                0,
                "(1 checked)",
                "\n## ` foo`\n\nOne-sided padding, which survives.\n",
                "-foo",
            ),
            (
                "...so the trimmed reading names no heading",
                1,
                no_slug("foo"),
                "\n## ` foo`\n\nOne-sided padding, which survives.\n",
                "foo",
            ),
            # A backslash does not escape INSIDE a code span, so the span walk and the escape
            # reading are one walk, left to right (round 10, P2).
            (
                "a backslash inside a code span escapes nothing, so what follows is not span content",
                1,
                UNSPELLABLE,
                "\n## `\\`_foo_`\n\nA backslash inside a span, which escapes nothing.\n",
                "_foo_",
            ),
            (
                "...while the one walk keeps both readings a span is owed",
                0,
                "(1 checked)",
                "\n## `_lit_` and ` padded `\n\nSpan contents, still literal.\n",
                "_lit_-and-padded",
            ),
            # A `<` is markup only once the construct CLOSES (round 10, P2).
            (
                "an incomplete HTML construct is not HTML, so its heading keeps its anchor",
                0,
                "(1 checked)",
                "\n## Use <Type\n\nAn opening bracket that closes nothing.\n",
                "use-type",
            ),
            (
                "...while a complete one still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## Use <em>tags</em>\n\nA tag spelled whole.\n",
                "use-emtagsem",
            ),
            (
                "...while a bare < among them is still text on both sides",
                0,
                "(1 checked)",
                "\n## A < B still text\n\nAn opening bracket that is not markup.\n",
                "a--b-still-text",
            ),
            # The heading guard applies the same label test the link reader does (round 12, P2).
            (
                "a heading carrying a link-shaped token with no label keeps its anchor",
                0,
                "(1 checked)",
                "\n## Token ](literal)\n\nA token, not a link.\n",
                "token-literal",
            ),
            (
                "...while one carrying a real label still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## [Real](https://example.invalid) link\n\nA link, which renders.\n",
                "reallinkhttpsexampleinvalid-link",
            ),
            # A comment refuses the heading only once it CLOSES (round 12, P2).
            (
                "an unclosed comment opener is text, so its heading keeps its anchor",
                0,
                "(1 checked)",
                "\n## Use <!-- literal\n\nAn opener that closes nothing.\n",
                "use----literal",
            ),
            (
                "...while a closed one still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## Hidden <!-- gone --> here\n\nA comment spelled whole.\n",
                "hidden---gone----here",
            ),
            # A character reference renders as markup only when it DECODES (round 12, P2).
            (
                "a character reference HTML does not define is text, and keeps its anchor",
                0,
                "(1 checked)",
                "\n## Rock &bogus; Roll\n\nA name HTML does not define.\n",
                "rock-bogus-roll",
            ),
            (
                "...while one that decodes still spells no anchor",
                1,
                UNSPELLABLE,
                "\n## Rock &amp; Roll\n\nA name HTML defines.\n",
                "rock-amp-roll",
            ),
            (
                "...and so does a numeric one, which always decodes",
                1,
                UNSPELLABLE,
                "\n## Rock &#38; Roll\n\nA numeric reference, which always decodes.\n",
                "rock-38-roll",
            ),
            # The raw-HTML forms beyond tags and comments render as markup (round 11, P2).
            (
                "a heading that is raw HTML spells no anchor: a processing instruction",
                1,
                UNSPELLABLE,
                "\n## <?target?>\n\nRaw HTML, which renders as markup.\n",
                "target",
            ),
            (
                "a heading that is raw HTML spells no anchor: a declaration",
                1,
                UNSPELLABLE,
                "\n## <!DOCTYPE html>\n\nRaw HTML, which renders as markup.\n",
                "doctype-html",
            ),
            (
                "a heading that is raw HTML spells no anchor: a CDATA section",
                1,
                UNSPELLABLE,
                "\n## <![CDATA[x]]>\n\nRaw HTML, which renders as markup.\n",
                "cdatax",
            ),
        )
        for label, rc, want, heading, anchor in cases:
            with self.subTest(label):
                self.heading_case(label, rc, want, heading=heading, link=f"See [it](references/notes.md#{anchor}).")

    # The block structure the heading reader models: blockquotes, list items, indentation, tabs,
    # line ends and hash runs.
    def test_heading_lines(self) -> None:
        cases: tuple[tuple[str, int, str, str | bytes, str], ...] = (
            # A tab inside a heading is a control character GitHub REMOVES (round 3, P2).
            (
                "an internal tab is removed, not turned into a hyphen",
                0,
                "(1 checked)",
                "\n## Foo\tBar\n\nAn internal tab.\n",
                "foobar",
            ),
            (
                "...so the hyphenated reading names no heading",
                1,
                no_slug("foo-bar"),
                "\n## Foo\tBar\n\nAn internal tab.\n",
                "foo-bar",
            ),
            # A heading inside a blockquote is a heading; one inside a list item is refused rather
            # than guessed at (round 3, P2).
            (
                "an ATX heading inside a blockquote is a heading",
                0,
                "(1 checked)",
                "\n> ## Quoted heading\n>\n> In a blockquote.\n",
                "quoted-heading",
            ),
            (
                "...while one inside a list item is refused rather than guessed at",
                1,
                no_slug("listed-heading"),
                "\n- ## Listed heading\n\n  In a list item.\n",
                "listed-heading",
            ),
            # GFM's indentation limits travel with the blockquote strip (round 4, P2).
            (
                "four spaces before a blockquote marker is code, not a heading",
                1,
                no_slug("indented-quote"),
                "\n    > ## Indented quote\n\nFour spaces: code, not a container.\n",
                "indented-quote",
            ),
            (
                "...and so is content indented four spaces inside one",
                1,
                no_slug("indented-content"),
                "\n>     ## Indented content\n\nCode inside the quote.\n",
                "indented-content",
            ),
            (
                "...while three spaces is still a blockquote, and its heading still a heading",
                0,
                "(1 checked)",
                "\n   > ## Barely quoted\n>\n> Three spaces is still a quote.\n",
                "barely-quoted",
            ),
            # The one space a blockquote marker takes may be a tab, expanded to the next stop
            # (round 7, P2); the columns it leaves over are indentation (round 10, P2).
            (
                "a tab may stand for the space a blockquote marker takes",
                0,
                "(1 checked)",
                "\n>\t## Tabbed quote\n>\n> A tab where the space would be.\n",
                "tabbed-quote",
            ),
            (
                "the columns a tab leaves after a blockquote marker are indentation",
                1,
                no_slug("hidden-by-indentation"),
                "\n>\t  ## Hidden by indentation\n",
                "hidden-by-indentation",
            ),
            # A carriage return is the other half of a CRLF line ending, not content (round 7, P2).
            (
                "a CRLF line ending does not join the closing hashes to the heading",
                0,
                "(1 checked)",
                "\n## Closed off ##\r\n",
                "closed-off",
            ),
            (
                "...so the reading that keeps it names no heading",
                1,
                no_slug("closed-off-"),
                "\n## Closed off ##\r\n",
                "closed-off-",
            ),
            # An empty slug is still an OCCUPANT, and numbers its repeats (round 8, P2).
            ("...and stops where the file does", 1, no_slug("-2"), "\n## !!!\n\n## !!!\n", "-2"),
            # A heading may END at its hash run (round 9, P2).
            (
                "a heading that ends at its hash run is a heading, and occupies its slug",
                0,
                "(1 checked)",
                "\n#\n\n## !!!\n",
                "-1",
            ),
            # An ATX heading is one to six hashes followed by a blank or the line end.
            ("seven hashes open no heading", 1, no_slug("seven-hashes"), "\n####### Seven hashes\n", "seven-hashes"),
            ("...nor does a hash run glued to its text", 1, no_slug("tagline"), "\n#tagline\n", "tagline"),
        )
        for label, rc, want, heading, anchor in cases:
            with self.subTest(label):
                self.heading_case(label, rc, want, heading=heading, link=f"See [it](references/notes.md#{anchor}).")
        self.heading_case(
            "an empty slug numbers its repeats, which are anchors that work",
            0,
            "(2 checked)",
            heading="\n## !!!\n\n## !!!\n\n## !!!\n",
            link="See [the first repeat](references/notes.md#-1) and [the second](references/notes.md#-2).",
        )

    # A heading this check will not spell still OCCUPIES a slug on GitHub, and the numbering is
    # occupancy-based. What that costs is bounded, and the bound is the point: every slug this emits
    # is one GitHub HAS, so an anchor accepted here resolves there, and only the `-<n>` spelling goes
    # unconfirmed (round 3, P2; the suppression tried instead was taken out in round 9).
    def test_unspellable_headings_occupy_slugs(self) -> None:
        R = self.root
        foo = "\n## Foo\n\nThe heading GitHub numbers past the refused one.\n"
        links_unspellable(R, NOTES)
        append(f"{R}/{NOTES}", foo)
        links_body(R, "alpha/SKILL.md", "See [the name GitHub has](references/notes.md#foo).")
        self.expect("an anchor an unspellable heading holds on GitHub still resolves here", 0, "(1 checked)")
        links_tree(R)
        links_unspellable(R, NOTES)
        append(f"{R}/{NOTES}", foo)
        links_body(R, "alpha/SKILL.md", "See [the numbered reading](references/notes.md#foo-1).")
        self.expect(
            "...while the -<n> spelling goes unconfirmed, and the message names what did it",
            1,
            "leave a numbered repeat unconfirmed",
        )
        links_tree(R)
        links_unspellable(R, NOTES)
        links_body(R, "alpha/SKILL.md", "See [a heading standing before it](references/notes.md#close-out).")
        self.expect("...and a heading BEFORE it keeps its name, which nothing later can move", 0, "(1 checked)")
        # A heading-shaped line inside a FENCE that the slug reader will not spell must not take the
        # real headings after it down with it (round 9, P2).
        self.heading_case(
            "an unspellable heading inside a fence refuses no anchor after it",
            0,
            "(1 checked)",
            heading="\n```\n## [Example](https://example.invalid)\n```\n\n## After the fence\n",
            link="See [past a phantom heading](references/notes.md#after-the-fence).",
        )

    # A byte-order mark opens a FILE, not a line, and GFM removes it before parsing (round 6, P2).
    def test_a_byte_order_mark(self) -> None:
        write(f"{self.root}/alpha/references/marked.md", b"\xef\xbb\xbf# Marked\n\n## Close-out\n")
        links_body(self.root, "alpha/SKILL.md", "See [past a byte-order mark](references/marked.md#marked).")
        self.expect("a byte-order mark does not hide the first heading of a file", 0, "(1 checked)")

    # A case-insensitive filesystem -- the macOS default -- answers yes for a link whose spelling the
    # checkout does not have, while GitHub serves that link as a 404 (round 7, P2). On a
    # case-sensitive box the path does not exist at all, so the refusal is asserted by the half of
    # the message both share. A hidden path component is spelled as the checkout spells it too
    # (round 8, P2).
    def test_spelling_the_checkout_has(self) -> None:
        R = self.root
        self.link_case(
            "a link the checkout spells differently is refused, however the filesystem answers",
            1,
            "alpha/SKILL.md: link to references/Notes.md",
            "See [a mis-cased path](references/Notes.md).",
        )
        self.link_case(
            "...while the spelling the checkout has resolves",
            0,
            "(1 checked)",
            "See [the spelling it has](references/notes.md).",
        )
        links_tree(R)
        write(f"{R}/alpha/.refs/notes.md", "# Hidden\n\n## A section\n")
        links_body(R, "alpha/SKILL.md", "See [a hidden directory](.refs/notes.md#a-section).")
        self.expect("a hidden path component is spelled as the checkout spells it", 0, "(1 checked)")
        links_tree(R)
        write(f"{R}/alpha/.refs/notes.md", "# Hidden\n")
        links_body(R, "alpha/SKILL.md", "See [a mis-cased hidden directory](.Refs/notes.md).")
        self.expect("...and a mis-cased one is still refused", 1, "alpha/SKILL.md: link to .Refs/notes.md")

    # The lexical `..` guard stops a path SPELLING its way out of the checkout; a symbolic link walks
    # out without spelling anything. Refused on the path, at any component, before the target is
    # TOUCHED -- the probes plant a real file with a real heading at each destination, so a reader
    # that still followed the link would turn the refusal into a pass (rounds 2-4, P2).
    @unittest.skipIf(WINDOWS, NO_SYMLINKS)
    def test_symbolic_links(self) -> None:
        R, outside = self.root, f"{self.base}/outside.md"
        write(outside, "# Outside\n\n## Planted\n")
        os.symlink(outside, f"{R}/alpha/references/linked.md")
        links_body(R, "alpha/SKILL.md", "See [a link out](references/linked.md#planted).")
        self.expect(
            "a target that is a symbolic link is refused, not followed",
            1,
            "reached through a symbolic link: alpha/references/linked.md",
        )
        links_tree(R)
        write(f"{self.base}/elsewhere/notes.md", "# Outside\n")
        os.symlink(f"{self.base}/elsewhere", f"{R}/alpha/linked")
        links_body(R, "alpha/SKILL.md", "See [a link out of a parent](linked/notes.md).")
        self.expect(
            "...and so is one reached through a symlinked parent",
            1,
            "reached through a symbolic link: alpha/linked/notes.md",
        )
        links_tree(R)
        os.symlink(outside, f"{R}/alpha/references/linked.md")
        links_body(R, "alpha/SKILL.md", "See [an anchored link out](references/linked.md#planted).")
        self.expect(
            "an anchored symlinked target is refused before its headings are read",
            1,
            "reached through a symbolic link: alpha/references/linked.md",
        )
        links_tree(R)
        links_body(R, NOTES, "See [an anchored climb out](../../../outside.md#planted).")
        self.expect(
            "...and so is an anchored target that climbs past the root",
            1,
            "resolves outside the checkout: ../outside.md",
        )
        # The guard on the READING side: a prompt file that is a symlink out of the checkout is
        # reported rather than read, or skipped in silence (round 4, P2).
        links_tree(R)
        write(outside, "# Outside\n\nSee [a host link](gone.md).\n")
        os.symlink(outside, f"{R}/alpha/references/extra.md")
        self.expect(
            "a linking file reached through a symbolic link is not read",
            1,
            "alpha/references/extra.md: is reached through a symbolic link",
        )

    # The obligation comes from a link, as the fixtures' comes from a fixture.
    def test_no_link_no_obligation(self) -> None:
        fresh(self.root)
        self.lacks(
            "...and a tree carrying no such link takes no link obligation", "relative Markdown link", run(CP, self.root)
        )

    def test_annotations(self) -> None:
        # Under Actions the failure is an annotation on the LINKING file, which is the file to edit.
        links_body(self.root, "alpha/SKILL.md", "See [what moved](references/gone.md).")
        self.expect(
            "GitHub annotations name the linking file",
            1,
            "::error file=alpha/SKILL.md::link to references/gone.md",
            env={"GITHUB_ACTIONS": "true"},
        )


# The real prompts. The link probed is read OFF the wave prompt rather than restated: the anchors
# ludics-lite#260 created are exactly what moves next time the sections do.


@functools.cache
def real_link() -> str:
    for line in src_lines("issue-wave/SKILL.md"):
        found = re.findall(r"\((references/[A-Za-z0-9_.-]*\.md#[A-Za-z0-9_-]+)\)", line)
        if found:
            target = found[-1]
            if os.path.isfile(os.path.join(SRC, "issue-wave", target.split("#")[0])):
                return target
            break
    raise AssertionError("the link probes need an anchored references/....md#... link in issue-wave/SKILL.md")


def links_real(root: str) -> None:
    """The one tree that takes EVERY Markdown file, because the real link graph is its subject."""
    shutil.rmtree(root, ignore_errors=True)
    found: list[str] = []
    for top, dirs, files in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        found.extend(os.path.relpath(os.path.join(top, f), SRC) for f in files if f.endswith(".md"))
    copy_prompts(root, *sorted(found))


class LinksRealTest(Case):
    def setUp(self) -> None:
        super().setUp()
        self.target = real_link()
        self.file = self.target.split("#")[0]
        links_real(self.root)

    def test_the_real_links_resolve(self) -> None:
        self.expect("every relative link in the real prompts resolves, anchors included", 0, "anchors included")

    # The two drifts this check exists for, each made at the source: a section retitled, and the
    # file holding it renamed. Both look exactly like a working link until somebody clicks one.
    def test_a_retitled_heading(self) -> None:
        rewrite(self.root, f"issue-wave/{self.file}", pattern="^## ", repl="## Renamed ")
        self.expect(
            "a retitled heading is caught in the prompt that anchors into it",
            1,
            f"issue-wave/SKILL.md: link to {self.target} names no heading",
        )

    def test_a_renamed_file(self) -> None:
        old = f"{self.root}/issue-wave/{self.file}"
        os.rename(old, old.removesuffix(".md") + "-renamed.md")
        self.expect("a renamed reference file is caught the same way", 1, f"issue-wave/SKILL.md: link to {self.file}")


# --- the shell checker's byte and path readings ----------------------------------------------------
# The checker was a shell script until ludics-lite#403, run on macOS under the platform's own awk,
# sed and find, and its verdicts are what the port keeps. Each probe below is a reading those tools
# made that no other probe holds, found by the parity review of the port.


class ShellReadingsTest(Case):
    # A NUL ends an awk record's text: whatever follows a NUL on its line is not there to the index,
    # register, slot, link and heading readers.
    def test_a_nul_ends_a_line(self) -> None:
        R, s = self.root, slots()
        none = "FAIL: issue-wave/references/executions.md: states no mac-studio slot count"
        slots_tree(R)
        nul_edit(R, "issue-wave/references/executions.md", containing="mac-studio", where="prefix")
        self.expect("a slot count stated only after a NUL is no statement", 1, none)
        slots_tree(R)
        append(f"{R}/issue-wave/references/executions.md", f"note \0 mac-studio={s.other}\n")
        self.expect("a wrong slot count after a NUL is not read", 0, "mac-studio correctness slots agree")
        links_tree(R)
        append(f"{R}/{NOTES}", "\n## Sec\0tail\n\nCut short.\n")
        links_body(R, "alpha/SKILL.md", "See [it](references/notes.md#sec).")
        self.expect("a heading's slug stops at a NUL", 0, "(1 checked)")
        links_tree(R)
        append(f"{R}/{NOTES}", "x\0 [gone](missing.md)\n")
        links_body(R, "alpha/SKILL.md", "See [it](references/notes.md).")
        self.expect("a link after a NUL is not read", 0, "(1 checked)")
        fixture_tree(R)
        nul_edit(R, "README.md", containing="alpha/scripts/test-shell.sh", where="suffix")
        self.expect("a register line reads up to a NUL", 0, "fixture command register and required CI platforms agree")
        # A sed reading keeps the NUL, and the command substitution around it then drops it: the
        # routine names read off LOCAL_ROUTINES are the ones with the NUL taken out.
        drift_tree(R)
        rewrite(R, "scripts/sync-routines.sh", pattern='^LOCAL_ROUTINES="', repl='LOCAL_ROUTINES="\0')
        self.expect("a NUL in LOCAL_ROUTINES is dropped from the names", 0, "runs it to read its own drift")

    # A count is bash arithmetic's, which wraps at 64 bits: 2^64 + n is n, and 2^64 is zero.
    def test_counts_wrap_at_64_bits(self) -> None:
        R, s = self.root, slots()
        slots_tree(R)
        rewrite(R, WORKER, pattern=f"mac-studio={s.want}", repl=f"mac-studio={2**64 + s.want}", count=0)
        self.expect("a default past 64 bits wraps as bash arithmetic does", 0, f"count say {s.want}")
        slots_tree(R)
        rewrite(R, WORKER, pattern=f"mac-studio={s.want}", repl=f"mac-studio={2**64}", count=0)
        self.expect("a default of 2^64 is zero", 1, "SLOTS assignment states mac-studio=0; the worker requires")

    # The slot scan walked the root with `find` and cut the root back off each path with an awk `-v`
    # assignment, which is escape-processed: a backslash in the root's path matched no file, so the
    # scan found no statement at all.
    @unittest.skipIf(WINDOWS, NO_NAMES)
    def test_a_backslash_in_the_root(self) -> None:
        slots_tree(self.root)
        odd = f"{self.base}/b\\nroot"
        shutil.copytree(self.root, odd)
        self.expect(
            "a root whose path holds a backslash finds no slot statement",
            1,
            "FAIL: issue-wave/references/executions.md: states no mac-studio slot count",
            CP,
            odd,
        )

    # ...and `find` does not descend into a root that is itself a symbolic link. The default root is
    # `$HERE/..` named logically, so this checkout reached through a link is one.
    @unittest.skipIf(WINDOWS, NO_SYMLINKS)
    def test_a_root_through_a_symbolic_link(self) -> None:
        none = "FAIL: issue-wave/references/executions.md: states no mac-studio slot count"
        slots_tree(self.root)
        os.symlink(self.root, f"{self.base}/linked-root")
        self.expect("a root that is a symbolic link finds no slot statement", 1, none, CP, f"{self.base}/linked-root")
        os.symlink(SRC, f"{self.base}/checkout-link")
        self.expect(
            "this checkout through a symbolic link finds no slot statement",
            1,
            none,
            f"{self.base}/checkout-link/scripts/check-prompts.sh",
        )

    # The root is entered with `cd "$ROOT" && pwd`: the logical path when it is a directory, and the
    # physical one when it is not -- `lnk/../root` through a symbolic link lands where the kernel does.
    @unittest.skipIf(WINDOWS, NO_SYMLINKS)
    def test_dot_dot_through_a_symbolic_link(self) -> None:
        d = f"{self.base}/dotdot"
        os.makedirs(f"{d}/real/x")
        fresh(f"{d}/real/root")
        os.symlink("real/x", f"{d}/lnk")
        self.expect(
            "a '..' through a symbolic link falls back to the physical directory",
            0,
            clean(f"{d}/real/root"),
            BASH,
            "-c",
            'cd "$1" && exec "$2" lnk/../root',
            "_",
            d,
            CP,
        )
        self.expect(
            "...and so does --one",
            0,
            "1 passed, 0 failed",
            BASH,
            "-c",
            'cd "$1" && exec "$2" --one ../root/alpha',
            "_",
            f"{d}/lnk",
            CP,
        )

    # An index that is a regular file but cannot be read is there, and indexes nothing.
    @unittest.skipIf(WINDOWS or os.name == "posix" and os.geteuid() == 0, "a mode of 000 does not stop this reader")
    def test_an_unreadable_index(self) -> None:
        R = self.root
        fresh(R)
        shutil.rmtree(f"{R}/routines/nightly")
        shutil.rmtree(f"{R}/routines/weekly")
        os.chmod(f"{R}/routines/README.md", 0)
        self.addCleanup(os.chmod, f"{R}/routines/README.md", 0o644)
        self.expect(
            "an unreadable index with nothing to index is not missing",
            0,
            "ok: routines/README.md: no routines/ SKILL.md directory to index",
        )


# --- whole-line reads of bg-run.sh wait's verdict line (ludics-lite#826) -------------------------
# Each form the verdicts module's boundary lists, in each kind of file it sweeps, is refused; the
# first-word reads beside them pass, as do the four files it names as excluded and a root without
# the writer.

VERDICT_FORMS = (
    ("scripts/a.sh", 'if [ "$said" = "rc=0" ]; then', "a test = comparison"),
    ("scripts/a.sh", "[ \"$(head -n1 log)\" = 'rc=0' ] && echo ok", "a test = comparison"),
    ("scripts/a.sh", '[ "$v" != DIED ] || exit 1', "an ==/!= comparison"),
    ("scripts/a.sh", 'test "$v" = "rc=$want"', "a test = comparison"),
    ("scripts/a.sh", '[ "rc=0" = "$said" ]', "a test = comparison"),
    ("scripts/a.sh", '[[ $said == "RUNNING" ]] && continue', "an ==/!= comparison"),
    ("scripts/a.sh", "[[ rc=0 == $said ]]", "an ==/!= comparison"),
    ("scripts/a.sh", "grep -x 'rc=0' out", "a grep -x match"),
    ("scripts/a.sh", 'printf "%s\\n" "$v" | grep -qxF STOPPED', "a grep -x match"),
    ("scripts/a.sh", "grep --line-regexp -e 'rc=0' out", "a grep -x match"),
    ("scripts/a.sh", "grep -q '^rc=0$' out", "an anchored grep match"),
    ("scripts/a.sh", 'case "$said" in rc=0) ok ;; esac', "a case arm"),
    ("scripts/a.sh", "  STARTING|RUNNING) again ;;", "a case arm"),
    ("alpha/SKILL.md", '    [ "$(bg-run.sh wait "$d")" = "rc=0" ] && echo passed', "a test = comparison"),
    ("alpha/references/x.md", "- `grep -x STOPPED` on the wait's output", "a grep -x match"),
    ("lib/ludics/x/y.py", '    if said == "rc=0":', "an ==/!= comparison"),
    ("lib/ludics/x/y.py", "    ok = line != 'DIED'", "an ==/!= comparison"),
    ("issue-wave/scripts/other.sh", "case $v in (DIED) x ;; esac", "a case arm"),
)

VERDICT_CONTROLS = (
    'case "$said" in rc=*) ;; *) refuse ;; esac',
    '[[ $said == rc=* ]] && done=1',
    'case "${said%% *}" in STOPPED*) stopped ;; esac',
    "grep -q '^rc=' out",
    "grep -x 'rc=0 (finished earlier' out",
    '[ "$wrc" -eq 0 ] || exit 1',
    'if said.startswith("rc="):',
    'state = "RUNNING"',
    "if len(names) == RUNNING_SHOWN:",
    "A wait prints `rc=0` and exits 0; `RUNNING` (3) means re-issue it.",
    "  3) refuse \"bg-run.sh wait: RUNNING -- live\" ;;",
)


class VerdictReadsTest(Case):
    OK = "ok: no whole-line read of bg-run.sh wait's verdict line in"

    def setUp(self) -> None:
        super().setUp()
        fresh(self.root)
        write(os.path.join(self.root, "issue-wave", "scripts", "bg-run.sh"), "#!/bin/sh\n")

    def test_a_tree_of_first_word_reads_passes(self) -> None:
        write(os.path.join(self.root, "scripts", "a.sh"), "".join(f"{line}\n" for line in VERDICT_CONTROLS))
        write(os.path.join(self.root, "lib", "ludics", "x", "y.py"), "".join(f"{line}\n" for line in VERDICT_CONTROLS))
        append(os.path.join(self.root, "alpha", "SKILL.md"), "".join(f"    {line}\n" for line in VERDICT_CONTROLS))
        self.expect("first-word reads of the verdict line pass", 0, self.OK)

    def test_each_whole_line_read_is_refused(self) -> None:
        for rel, line, form in VERDICT_FORMS:
            with self.subTest(line=line):
                fresh(self.root)
                write(os.path.join(self.root, "issue-wave", "scripts", "bg-run.sh"), "#!/bin/sh\n")
                path = os.path.join(self.root, rel)
                if os.path.exists(path):
                    append(path, f"{line}\n")
                    n = len(read(path).split("\n")) - 1
                else:
                    write(path, f"#!/bin/sh\n{line}\n")
                    n = 2
                result = self.expect(f"{line!r} is refused", 1, f"FAIL: {rel}: line {n}: {form} reads bg-run.sh wait's whole")
                self.lacks(f"{line!r}", self.OK, result)

    def test_the_excluded_files_and_only_they_are_not_read(self) -> None:
        bad = '[ "$said" = "rc=0" ]\n'
        excluded = ("issue-wave/scripts/bg-run.sh", "issue-wave/scripts/test-bg-run.sh",
                    "lib/ludics/checkprompts/verdicts.py", "lib/ludics/tests/test_checkprompts_cli.py")
        for rel in excluded:
            write(os.path.join(self.root, rel), bad)
        # The tree's own suite file draws the fixture register's refusals, which are not this check's.
        result = run(CP, self.root)
        self.check("the writer, its suite, the scanner and its fixtures are not read", 1, result, self.OK)
        self.lacks("an excluded file", "reads bg-run.sh wait's whole", result)
        write(os.path.join(self.root, "issue-wave", "scripts", "test-bg-run-2.sh"), bad)
        self.expect("a name beside an excluded one is read", 1,
                    "FAIL: issue-wave/scripts/test-bg-run-2.sh: line 1: a test = comparison")

    def test_no_writer_no_obligation(self) -> None:
        os.remove(os.path.join(self.root, "issue-wave", "scripts", "bg-run.sh"))
        write(os.path.join(self.root, "scripts", "a.sh"), '[ "$said" = "rc=0" ]\n')
        result = self.expect("a root without bg-run.sh carries no obligation", 0, clean(self.root))
        self.lacks("no writer", "verdict line", result)


# --- this checkout -------------------------------------------------------------------------------


class ThisCheckoutTest(Case):
    def test_this_checkouts_prompts_pass(self) -> None:
        self.expect("this checkout's prompts pass", 0, "0 failed", CP)


if __name__ == "__main__":
    unittest.main()
