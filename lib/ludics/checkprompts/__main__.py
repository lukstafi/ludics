"""``scripts/py -m ludics.checkprompts [root] | --one <dir>``: what scripts/check-prompts.sh runs."""

import os
import sys
from dataclasses import dataclass
from typing import assert_never

from ludics import cli
from ludics.checkprompts.bytes_view import lat
from ludics.checkprompts.cleanup import check_cleanup_options
from ludics.checkprompts.drift import check_drift_guard
from ludics.checkprompts.frontmatter import check_skill_file
from ludics.checkprompts.links import check_links
from ludics.checkprompts.registers import check_fixtures, check_index
from ludics.checkprompts.slots import check_slots
from ludics.checkprompts.tree import Report, Tree
from ludics.checkprompts.verdicts import check_verdict_reads

PROG = "check-prompts"
USAGE = "usage: check-prompts.sh [root] | --one <dir>"


@dataclass(frozen=True)
class Help:
    pass


@dataclass(frozen=True)
class One:
    root: str


@dataclass(frozen=True)
class Whole:
    root: str  # empty: this checkout


type Mode = Help | One | Whole


def parse(argv: list[str]) -> Mode:
    first = argv[0] if argv else ""
    if first == "--one":
        if len(argv) != 2:
            raise cli.Exit(2, "usage: check-prompts.sh --one <dir>", raw=True)
        return One(argv[1])
    if first in ("-h", "--help"):
        return Help()
    if first.startswith("-"):
        raise cli.Exit(2, f"unknown option: {first}")
    if len(argv) > 1:
        raise cli.Exit(2, USAGE, raw=True)
    return Whole(first)


HERE_ENV = "LUDICS_CHECK_PROMPTS_HERE"


def this_checkout() -> str:
    """The checkout check-prompts.sh lives in: ``$HERE/..``, where the forwarder names ``HERE``
    as the shell checker did (``cd "$(dirname "$0")" && pwd``, logical, so a checkout reached
    through a symbolic link is named by it). Without it, the checkout this package lives in:
    lib/ludics/checkprompts/ is three levels below it."""
    here = os.environ.get(HERE_ENV, "")
    if here:
        return os.path.join(here, "..")
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(os.path.dirname(here)))


def logical_cwd() -> str:
    """The working directory as the shell names it: ``$PWD`` when it is this directory (it keeps
    the symbolic links the caller went through), the physical one otherwise."""
    pwd = os.environ.get("PWD", "")
    try:
        if os.path.isabs(pwd) and os.path.samefile(pwd, "."):
            return pwd
    except OSError:
        pass
    return os.getcwd()


def canonical(root: str) -> str:
    """``cd "$ROOT" && pwd``: absolute and without a trailing slash, so every root-relative path
    reads the same whether the caller wrote ``<dir>`` or ``<dir>/``. Logical when that names a
    directory to enter; when it does not (``lnk/../root`` through a symbolic link whose parent
    holds no ``root``), bash's ``cd`` enters the path as given and ``pwd`` names it physically."""
    if not os.path.isdir(root):
        raise cli.Exit(2, f"no such directory: {root}")
    if not os.access(root, os.X_OK):
        raise cli.Exit(2, f"cannot enter: {root}")
    logical = os.path.normpath(os.path.join(logical_cwd(), root))
    if os.path.isdir(logical) and os.access(logical, os.X_OK):
        return logical
    return os.path.realpath(root)


def run(argv: list[str]) -> int:
    report = Report(actions=os.environ.get("GITHUB_ACTIONS") == "true")
    match parse(argv):
        case Help():
            cli.say(USAGE)
            return 0
        case One(given):
            tree = Tree(canonical(given))
            if tree.is_file("SKILL.md"):
                check_skill_file(report, tree, "SKILL.md", one=True)
            else:
                report.ko("SKILL.md", f"missing regular SKILL.md in {lat(tree.root)}")
            cli.say(f"{PROG}: {report.passed} passed, {report.failed} failed")
            return 0 if report.failed == 0 else 1
        case Whole(given):
            tree = Tree(canonical(given or this_checkout()))
        case _ as unreachable:
            assert_never(unreachable)
    files = tree.files("*/SKILL.md", "routines/*/SKILL.md")
    if not files:
        report.ko(".", f"no */SKILL.md or routines/*/SKILL.md under {lat(tree.root)}")
    for rel in files:
        check_skill_file(report, tree, rel, one=False)
    check_index(report, tree, "README.md", "", "skill")
    check_index(report, tree, "routines/README.md", "routines/", "routine")
    check_fixtures(report, tree)
    check_slots(report, tree)
    check_drift_guard(report, tree)
    check_cleanup_options(report, tree)
    check_links(report, tree)
    check_verdict_reads(report, tree)
    cli.say("")
    cli.say(f"{PROG}: {report.passed} passed, {report.failed} failed")
    return 0 if report.failed == 0 else 1


def main() -> int:
    return cli.main(PROG, run)


if __name__ == "__main__":
    sys.exit(main())
