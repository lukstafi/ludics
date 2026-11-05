"""Two lookups: the README index of the prompt directories, and the test-fixture register.

The index (``check_index``). Every directory carrying a SKILL.md is named in a row of its README
whose FIRST cell is the backticked name -- the whole claim, and a lookup rather than a parse. A
line is a row when, after an optional leading pipe, it opens with the backticked name and the next
non-blank character is a pipe (GFM renders a body row without its leading pipe, so both count).
The name is matched as TEXT, so a ``.`` is that character, a backslash is a backslash, and
``beta`` is not found in ``betas``. What it deliberately does NOT claim, after ludics-lite#75: that
the row renders. There is no table model -- no header, delimiter row, fence or comment scope -- so
a row-shaped line inside a code fence satisfies the lookup; and a row that outlives its directory
is not read, since that needs the same model.

The fixture register (``check_fixtures``). Every test file has a command line in the README's
``## Tests`` section and an inline run command on each CI platform it needs. A required platform
is a runner (``ubuntu``, ``macos``, ``windows``: the job's ``runs-on``, less ``-latest``) in
skill-scripts.yml, or ``git-bash``: a run line in the job keyed ``git-bash`` on a windows runner in
windows-git-bash.yml (ludics-lite#339), so a ship-pr suite run by another Windows job, whose steps
are PowerShell, is not its Git Bash leg (PR #321). The scan reads the workflow's literal shape --
``runs-on`` and ``run`` lines -- not YAML; comments, names, ``echo`` arguments and longer
filenames cannot stand in for a command.
"""

import re

from ludics.checkprompts.bytes_view import WS, WS_CLASS, awk_records, ws_split
from ludics.checkprompts.tree import Report, Tree

ROW_LEAD = re.compile(WS_CLASS + r"*\|?" + WS_CLASS + "*")


def indexed(lines: list[str], name: str) -> bool:
    """Whether a line is a row whose first cell is the backticked ``name``."""
    want = f"`{name}`"
    for line in lines:
        rest = ROW_LEAD.sub("", line, count=1)
        if rest.startswith(want) and rest[len(want) :].lstrip(WS)[:1] == "|":
            return True
    return False


def check_index(report: Report, tree: Tree, readme: str, prefix: str, what: str) -> None:
    if not tree.is_file(readme):
        report.ko(readme, f"missing: it indexes the {what} directories")
        return
    # A regular file that cannot be read is there, and indexes nothing: awk failed on it.
    lines = awk_records(tree.read(readme) or "")
    dirs = sorted(rel[len(prefix) : -len("/SKILL.md")] for rel in tree.files(prefix + "*/SKILL.md"))
    bad = False
    for d in dirs:
        if not indexed(lines, d):
            report.ko(
                readme,
                f"{what} '{d}' is not indexed: no row whose first cell is the backticked name '`{d}`'",
            )
            bad = True
    if not dirs:
        # Nothing to look up is not a verdict on the index: say that, rather than passing.
        report.ok(f"{readme}: no {prefix or 'top-level'} SKILL.md directory to index")
    elif not bad:
        report.ok(f"{readme}: all {len(dirs)} {what} directories are named in backticked rows")


JOB_KEY = re.compile(r"  [A-Za-z0-9_-]+:")
RUNS_ON = re.compile(WS_CLASS + "*runs-on: ")
RUN_LINE = re.compile(r"(?:- )?run: ")
PYTHON3 = re.compile(r"python3" + WS_CLASS + "+")


def awk_fields(line: str) -> list[str]:
    """awk's default field split: runs of blanks, leading and trailing ones ignored."""
    return [f for f in ws_split(line) if f != ""]


def fixture_command(lines: list[str], want: str, required: str = "") -> bool:
    """Whether ``want`` is the command of a register line: with no ``required`` platform, a line
    of the README's ``## Tests`` section; with one, a ``run:`` line of a job on that platform."""
    tests = False
    platform = ""
    job = ""
    for raw in lines:
        if raw.startswith("## "):
            tests = raw == "## Tests"
        if JOB_KEY.match(raw):
            platform = ""
            fields = awk_fields(raw)
            job = fields[0] if fields else ""
            job = job[:-1] if job.endswith(":") else job
        if RUNS_ON.match(raw):
            fields = awk_fields(raw)
            platform = fields[1] if len(fields) > 1 else ""
            platform = platform[: -len("-latest")] if platform.endswith("-latest") else platform
        if required == "" and not tests:
            continue
        line = raw.lstrip(WS)
        if required != "":
            if required == "git-bash":
                if job != "git-bash" or platform != "windows":
                    continue
            elif platform != required:
                continue
            m = RUN_LINE.match(line)
            if m is None:
                continue
            line = line[m.end() :]
        line = PYTHON3.sub("", line, count=1) if PYTHON3.match(line) else line
        line = line[2:] if line.startswith("./") else line
        words = ws_split(line)
        if (words[0] if words else "") == want:
            return True
    return False


SKILL_SCRIPTS = ".github/workflows/skill-scripts.yml"
GIT_BASH = ".github/workflows/windows-git-bash.yml"
# The macOS suites run weekly, not per push (ludics#974), so their run lines are read from that
# workflow alone: a macOS job left in skill-scripts.yml does not satisfy the register.
MACOS_WEEKLY = ".github/workflows/macos-weekly.yml"


def workflow_of(platform: str) -> str:
    """The workflow file whose jobs on ``platform`` the register reads."""
    if platform == "git-bash":
        return GIT_BASH
    if platform == "macos":
        return MACOS_WEEKLY
    return SKILL_SCRIPTS
UBUNTU_ONLY = ("scripts/test-workflow-reporters.py", "ship-pr/scripts/test-pr-review-hostile.py")


def platforms_of(suite: str) -> tuple[str, ...]:
    if suite.endswith(".ps1"):
        return ("windows",)
    # These probe Ubuntu production reporters and the Ubuntu-only hostile runner.
    if suite in UBUNTU_ONLY:
        return ("ubuntu",)
    # ship-pr's shell suites run under Git Bash too (ludics-lite#318).
    if suite.startswith("ship-pr/scripts/test-") and suite.endswith(".sh"):
        return ("ubuntu", "macos", "git-bash")
    return ("ubuntu", "macos")


def check_fixtures(report: Report, tree: Tree) -> None:
    cache: dict[str, list[str] | None] = {}

    def lines_of(rel: str) -> list[str] | None:
        if rel not in cache:
            text = tree.read(rel) if tree.is_file(rel) else None
            cache[rel] = None if text is None else awk_records(text)
        return cache[rel]

    bad = False
    count = 0
    # Root scripts, skill scripts and hook fixtures; PowerShell belongs to Windows.
    for suite in tree.files("scripts/test-*", "*/scripts/test-*", "*/hooks/test-*"):
        if not suite.endswith((".sh", ".py", ".ps1")):
            continue
        count += 1
        readme = lines_of("README.md")
        if readme is None or not fixture_command(readme, suite):
            report.ko("README.md", f"fixture '{suite}' has no command line in the test register")
            bad = True
        for platform in platforms_of(suite):
            workflow = workflow_of(platform)
            lines = lines_of(workflow)
            if lines is None or not fixture_command(lines, suite, platform):
                report.ko(workflow, f"fixture '{suite}' has no inline run command on {platform}")
                bad = True
    # A prompt-only root needs no workflow; a fixture creates the membership obligation.
    if count and not bad:
        report.ok("fixture command register and required CI platforms agree")
