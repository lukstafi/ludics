"""Shared scratch-tree harness and fixtures for the check-prompts.sh CLI conformance suites.

Split out of test_checkprompts_cli.py so the conformance suite runs as two unittest modules
(test_checkprompts_cli.py and test_checkprompts_cli_checks.py) that can be sharded across
separate Ubuntu CI runners with headroom under LUDICS_TEST_WATCHDOG (#1336).
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
    scratch.clear()
    scratch.append(os.path.realpath(tempfile.mkdtemp(prefix="check-prompts-test.")))


def tearDownModule() -> None:
    def unlock(func: Callable[[str], object], path: str, _exc: BaseException) -> None:
        os.chmod(os.path.dirname(path), stat.S_IRWXU)
        os.chmod(path, stat.S_IRWXU)
        func(path)

    if scratch:
        shutil.rmtree(scratch.pop(), onexc=unlock)


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
  windows:
    runs-on: windows-latest
    steps:
      - run: ./issue-wave/scripts/test-windows-driver.ps1
"""
MACOS_WORKFLOW = """\
jobs:
  macos:
    runs-on: macos-latest
    steps:
      - run: alpha/scripts/test-shell.sh || { echo failed; exit 1; }
      - run: python3 alpha/scripts/test-python.py
      - run: python3 alpha/hooks/test-hook.py
      - run: ship-pr/scripts/test-shell.sh || { echo failed; exit 1; }
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
MACOS_WEEKLY = ".github/workflows/macos-weekly.yml"
WORKFLOW_OF = {"ubuntu": SKILL_SCRIPTS, "macos": MACOS_WEEKLY, "git-bash": GIT_BASH}


def fixture_tree(root: str) -> None:
    fresh(root)
    for suite in FIXTURE_SUITES:
        write(os.path.join(root, suite), "")
    append(os.path.join(root, "README.md"), FIXTURE_README)
    write(os.path.join(root, SKILL_SCRIPTS), FIXTURE_WORKFLOW)
    write(os.path.join(root, GIT_BASH), GIT_BASH_WORKFLOW)
    write(os.path.join(root, MACOS_WEEKLY), MACOS_WORKFLOW)



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
    "issue-wave/SKILL.md",
    "issue-wave/references/cli-claude.md",
    "issue-wave/references/cli-codex.md",
    "issue-wave/references/executions.md",
    "issue-wave/references/native-claude.md",
    "issue-wave/references/native-codex.md",
    "issue-wave/references/native-workers.md",
    "issue-wave/references/separate-codex.md",
    "issue-wave/references/app-claude.md",
    "issue-wave/references/post-wave.md",
    "issue-wave/references/paired-planning.md",
    "issue-wave/references/coordinator-kit.md",
    "issue-wave/references/ab-judging.md",
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
    copy_prompts(root, "README.md", "routines/README.md", *LINK_TARGETS, WORKER)



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

