"""``merge``'s build of the would-be merge commit (ludics-lite#611): when the base has moved since
the head's CI run AND the config's trigger holds (by default, a path both sides changed is a build
input), build the PR merged with the current base locally, before the merge call, and refuse the
merge when that build fails.

Why. On 2026-10-15 lukstafi/ocannl-staging#1142 and #1139 merged minutes apart, each on its own
green head, five paths changed on both sides "all in DISJOINT hunks": the merge was textually clean
and did not compile (#1139's new test used a hook as a ref that #1142 had just made a per-domain
``Seam``). GitHub's verdict is for the head, so a semantic conflict between two greens was
invisible until master's run. This does not undermine the roll-forward policy (ahrefs/ocannl#861):
the merge still waits only on the PR's own head verdict, never on the base tip's CI; the added
check is one bounded LOCAL build of the merge commit, made only where the repository asks for it.

THE CONFIG. ``.github/ship-pr-merge-build`` on the repository's DEFAULT branch, read the way the
advisory list ``.github/ship-pr-advisory-checks`` is (gate.py): a raw Contents read; a 404 counts as
no file only when the ``.github`` listing confirms it (a token without Contents access to a private
repository also reads 404); a read that did not answer is exit 3, a refused or unconfirmed one exit
2. A repository WITHOUT the file keeps today's behaviour exactly: nothing is built. The file's
grammar is a fail-closed allowlist of line shapes -- any other line refuses the merge with exit 2,
naming it:

    # a comment (first non-blank character `#`), and blank lines, are ignored
    command <shell command>    exactly one: run by `sh -c` at the root of the merged tree
    input <glob>               one or more: the BUILD INPUTS (below)
    comments <glob>            any number: a build input a side changed in comments only does
                               not count for that side (COMMENTS ONLY, below)
    timeout <seconds>          at most one, 1 to 86400 (default 1200): the build's bound
    trigger same-input         at most one trigger line, default same-input: WHEN IT BUILDS
    trigger any-input

BUILD INPUTS -- the boundary. A path is a build input when one ``input`` glob matches the WHOLE
repository-relative path (``/``-separated) under Python's ``fnmatch.fnmatchcase``: case-sensitive,
and ``*``, ``?`` and ``[...]`` match ``/`` too, so ``*.ml`` matches an ``.ml`` file at any depth,
``dune`` only the root ``dune``, and ``*/dune`` every nested one. Nothing else counts: no path is a
build input by its contents, by being generated, or by a default list.

WHEN IT BUILDS. Only when the merge's own base-drift read (drift.py) leaves a build possible. It
reads two sides: the paths the PR changed and the paths the base's advance changed since their
merge base (old names of renames included; a path a rename on either side touched counts by its
other name too, since git carries an edit of the old name into the new). When either side is
empty, no build is possible and the config is not even read. Otherwise the trigger decides:
``same-input`` (the default) builds when a path BOTH sides changed is a build input;
``any-input`` builds when EACH side changed some build input, the same one or not, which also
catches a clash across paths only one side changed (the PR calls, in ``b.ml``, a name the base
renamed in ``a.ml``). ``any-input`` builds more often -- replaying a month of OCANNL's merges, 17
builds against 5 (ludics-lite#635) -- so it suits a cheap command. Sides that are UNKNOWN (a compare
call that did not answer, GitHub's 300-file cap) are never "none" and build under either trigger.
"The base moved since the head's CI run" is read as "the base's tip is not in the head's history",
the drift read's own anchor: a ``pull_request`` run that already built the merge with this very tip
makes the build redundant, never wrong. Under ``same-input``, a semantic conflict across paths only
ONE side changed is outside this boundary, and stays the integration loop's to catch on the merged
tip.

COMMENTS ONLY (#861). A doc-comment edit to an ``.mli`` on one side cost a 30-minute slot wait
and a 434 s build: a change of comments alone cannot clash with the other side's code, unless the
command reads comments. Whether it does is the repository's to say, so this is an opt-in per
path: each ``comments`` glob (matched as an ``input`` glob is) names build inputs whose comments
the command does not read -- no doc build over them, no output that names their line positions.
When the config has such a line and both sides are known, the trigger is read again once the
objects are fetched and the merge is textually clean, BEFORE the slot is taken: a build input
that matches a ``comments`` glob counts as changed on a side only when git's diff of that side
from the merge base (``git merge-base --all``, which must name exactly one commit) changes it in
code -- its old and new blobs, both regular files of one mode, differ by more than comments and
blanks as commentonly.py reads its language. ``same-input`` then builds only when a build input
both sides changed was changed in code on BOTH sides; ``any-input`` only when EACH side changed
some build input in code. A path both sides changed, one of them in comments only, counts as code
on that side too unless the merge's own code there (the blob in ``git merge-tree``'s tree) is the
other side's: a side can move comment delimiters over duplicated code, its own code reading
unchanged, so that the clean merge drops the other side's edit. Otherwise: no build, saying why,
and the merge proceeds. The boundary,
failing closed to a build: a path no ``comments`` glob matches, one a rename touched, one added,
deleted or changed in type or mode on that side, one past ``COMMENT_PATHS`` paths a side, a blob
over ``COMMENT_BYTES``, a language commentonly.py does not read (its own boundary: OCaml and
dune) and any git call that does not answer each count as changed in code. Sides that are UNKNOWN
are not read again: they build, as above.

HOW IT BUILDS. From a local clone of the repository: the git checkout the merge runs in, or the one
``merge -C <dir>`` names (ludics-lite#730; checked before anything is read, so a wait never ends on
it; without ``-C``, a ``--wait`` checks the working directory before the wait, #944's
``clone_preflight``), whose remote (``origin`` first) has a URL ending in the repository's ``owner/name`` (``.git`` optional,
case ignored), so an SSH host alias serves as well as github.com. No such clone is exit 2 (the refusal names
``-C``), and so is a SHALLOW clone, which may lack the merge base (run from a full clone, or ``git fetch
--unshallow``). The clone fetches ``refs/pull/<n>/head`` and the base branch as OBJECTS only -- no
destination ref, ``--refmap=`` (no remote-tracking ref moves), no FETCH_HEAD -- and the remote's
``refs/pull/<n>/head``, read back with ``ls-remote``, must be the gated head (else exit 5:
superseded), and the clone must hold it and the base tip the drift read (else exit 3). Then
everything happens in a scratch directory: a repository of its own (``git init --template=``)
that borrows the clone's objects through ``objects/info/alternates``, read only, and has its own
config, refs, index and no hooks -- so the clone's sparse-checkout, hooks and worktree list are not
the build's, and nothing is registered in the clone. There the merge commit is made (``git
merge-tree --write-tree``, ``commit-tree``; a textual conflict is exit 1) and checked out in full,
and the command runs at its root, its output to a log beside it, inside this box's run-time slot
when it has slots (``fleet-worker.sh execution slot --probe`` answers the PROBE line; ``--cpu``,
waiting up to 30 min for a slot and, for a measurement, THE WINDOW WAIT below, under ``--deadline``
= the timeout) and bare otherwise, bounded either way. The scratch directory is the whole of the build's state:
it is removed whatever the outcome, and one a SIGKILLed merge leaves is in pr-review's swept
temporary family (``pr-review-build.<pid>.*``). What the clone keeps is the fetched objects, which
nothing names, as after any fetch. So the revision a build tested outlives it only in the output
(#1024): before the command runs, one line names the merge commit and its two parents, the base's
tip first and the gated head second, each in full 40 hex, beside the abbreviated build-start line.

THE WINDOW WAIT (ludics-lite#764). A measurement holding the box (a window) is waited for by the
slot (``--wait-window=<n>``, fleetworker/slot.py), never by this module, for ``n`` =
``SLOT_WAIT`` (30 min) without ``--wait``, and under ``--wait`` what is left of its ceiling when the
build starts -- the gate's own deadline, a recovery's extension included -- but never less than
``SLOT_WAIT``, so a merge whose CI wait used its ceiling up waits as long as before. The ceiling
bounds that wait only: the free-slot wait (30 min) and the build's timeout stay their own, so it is
no deadline for the whole command. The slot names each measurement it waits for (its request id,
coordinator, worker and issue) the moment it finds it: the wrapper's two streams are this
process's stderr, not captured, so those lines reach the caller as said, not after the wait. Nothing
is parsed from them; the verdict is the status file's, as below.

THE CONFIG NOTE (ludics-lite#730). The config is the DEFAULT BRANCH's copy, so a PR that adds or
changes it is never judged by its own copy (#738 added the file and printed no merge-build line at
all). When the drift read's PR side names ``CONFIG_FILE`` (by either name of a rename), merge says
so in one ``NOTE`` line naming the copy that judged it -- absent there, read below, or not read
because one side changed nothing -- and the dry run (below) that shows the PR's own copy judging
the same pair. The boundary is that PR side: an UNKNOWN one (a compare that did not answer,
GitHub's 300-file cap) says nothing, and no read is made for the note.

THE DRY RUN (ludics-lite#751, ``pr-review.sh merge-build``, prreview/mergedry.py): this build
alone, for a base and a head revision in a local checkout, under a config file given or the default
branch's. It reads no PR and fetches nothing; its two sides are git's diff from their merge base
(mergedry.py states how that stands in for the drift read), and the trigger, the scratch build and
the verdicts are this module's. Its exit is the one merge's build step would make: 0 the merge
would proceed (PASSED, or no build), 1 refused, 2, 3 and 4 as below.

THE COMMAND'S CONTRACT. The command runs with its cwd at the root of the merged tree, which is the
work tree of a git repository whose ``HEAD`` is the merge commit, detached. Its FIRST parent is the
base's tip and its SECOND the PR's gated head, and the environment names both:
``SHIP_PR_MERGE_BASE_SHA`` (the base's tip, as the drift read it) and ``SHIP_PR_MERGE_HEAD_SHA``
(the gated head), each a full SHA in that repository, so ``git merge-base "$SHIP_PR_MERGE_BASE_SHA"
"$SHIP_PR_MERGE_HEAD_SHA"`` and a diff of either side against it work there. A command that picks
its own tiers by what each side changed reads these, not its guess of the parent order. Its stdin
is ``/dev/null``; its stdout and stderr are the build's log. Git's repository-selection variables
are cleared (below); the rest of merge's environment is inherited.

HOSTS AND CLONES -- the boundary. The merge build runs on POSIX hosts (the fleet's macOS and Linux
boxes); under Windows a merge that needs one is refused (exit 2), so nothing below has a Windows
branch. It needs a FULL clone: a shallow one may lack the merge base, and a partial one (a promisor
remote) holds objects only as promises the build's repository cannot redeem, so both are refused
(exit 2) rather than deepened or materialized here. Deepening is declined, not deferred: it would
rewrite the caller's clone (its ``shallow`` file, or its promisor packs) as a side effect of a merge,
the one lasting change to the clone this build otherwise never makes; ``git fetch --unshallow`` is
the caller's to run. Git's repository-selection variables (``GIT_DIR``, ``GIT_WORK_TREE``, ...) are
cleared for every git call and for the build, so an inherited one aims nothing at the caller's
repository.

INTERRUPTS -- the recovery boundary. From before the scratch is made to the moment it is gone,
SIGTERM and SIGHUP to merge (and SIGINT while it has Python's default handler, so not when merge was
started with it ignored) end whatever child is running -- a setup git call, the slot probe, or the
build -- by its process group (SIGTERM, then SIGKILL five seconds later), then remove the scratch,
and end merge with 128+n (SIGINT: a KeyboardInterrupt), nothing merged. Every child runs in a
session of its own, so this is the only way a signal reaches it. A signal that lands while a child
is being spawned or its group ended, or while the scratch is being made or removed, is held until
that step ends and acted on at the next spawn or at the end, so neither a child nor a scratch
escapes between two steps. Outside the boundary: SIGKILL (a running git call is left to finish on
its own bound-less, and the scratch to ``watch``'s sweeper), a process that leaves the group
(``setsid``, a daemon git starts for itself, such as ``gc --auto``), and a signal before the build's
decision or after the scratch is gone, which is merge's own default handling.

TRUST. The command is the repository's own configuration, read from its default branch: it is
trusted as a developer's build is, and the scratch repository is a place to build, not a sandbox.
A git write the command makes lands in the scratch repository; a command no exec can take (a
NUL in it, past the argument limit) is a config error (exit 2); anything else it does (a write
outside its tree, a network call, a process it detaches with ``setsid``) is the command's
business, as it would be from a developer's shell.

VERDICTS. Passed: the merge proceeds. Failed (any nonzero status): exit 1, refused, with the build
output (its first and last lines when long, each line and each end bounded in bytes). Not finished
within the bound: exit 4, saying how far it got (the size of its output and its last lines) and what
buildhistory.py has of the command on this box, which says whether a re-run is likely to repeat the
overrun (#982). Could not run (the slot refused, a fetch or git step failed): exit 3.
After the command ends, however it ends, its process group is ended too, so a process it left
behind does not outlive the merge; interrupted, see INTERRUPTS. The build judges the base tip the drift read;
a base that moves again between the build and the merge call is not rebuilt (that, again, is the
integration loop's). One flag reaches a failed build, and only as THE BASE ALONE says.

THE BASE ALONE (#860). A red the base's tip already has (a scan the command runs, failing on
master) fails every merge build that triggers, so without this no PR could merge over it, cited
``--override`` or not, until the base's fix landed. So when the merge's build FAILS, the same
command runs once more, in a fresh repository at the same absolute path (the merge's tree is
renamed aside), on a commit whose tree is the base tip's alone and whose parents and environment
are the merge's (THE COMMAND'S CONTRACT), so a command that picks its tiers by what each side
changed picks the same ones. Its verdict:

  passed                    the failure is the merge's own: refused (exit 1), as before.
  failed the same way       the same exit status, and every line of the merge's log (counted:
                            a line twice in it must be twice in the base's) is in the base's:
                            the failure is the base's. Without ``--override`` refused (exit 1),
                            saying so and naming the flag; with it, the merge proceeds, and merge
                            announces what it went over with the gate's override, before the call.
  failed otherwise          another status, a line of the merge's log the base's lacks (shown,
                            up to NAMED_LINES), or a log over COMPARED_BYTES or unreadable (never
                            compared, so never the same): refused (exit 1), override or not.
  no verdict                (its setup failed, the slot refused, its timeout): refused, exit 1
                            without ``--override``; with it, 4 past the timeout and 3 otherwise,
                            since what decides the merge was not read.

The boundary: "the same way" is what the command says, line for line, and nothing else. A command
that prints nothing on failure tells nothing apart, so two failures of one status read as the
same; a line that differs only by a timing or a count (a test runner's tally) reads as an extra
failure, a false refusal that leaves the merge waiting for the base's fix. Which failure the
override was meant for is not checked against its reason: a reason is words (merge.py), and the
log is the evidence. The dry run (THE DRY RUN) takes no override, so a shared failure is its exit 1.
"""

import contextlib
import fnmatch
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Generator, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Literal, NoReturn, assert_never

from ludics import cli, proc
from ludics.prreview import buildhistory, commentonly
from ludics.prreview.clock import Clock
from ludics.prreview.core import GhFailed, GhOk, GhSession, GhUnanswered, fail, warn
from ludics.prreview.drift import Drift
from ludics.prreview.gate import github_file_absent

CONFIG_LEAF = "ship-pr-merge-build"
CONFIG_FILE = f".github/{CONFIG_LEAF}"
DEFAULT_TIMEOUT = 1200
MAX_TIMEOUT = 86400  # a day: a larger `timeout` is a config error, refused before anything is built
SLOT_WAIT = 1800  # seconds a slot is waited for, and the least a measurement holding the box is (WINDOW WAIT)
FETCH_TIMEOUT = 600
GIT_TIMEOUT = 300
PROBE_TIMEOUT = 60
SHOWN_HEAD = 100  # a long build log is shown as its first and last lines
SHOWN_TAIL = 100
SHOWN_BYTES = 64 * 1024  # at most this much is read from each end of a long log
LINE_CHARS = 1000  # a longer line is shown cut
NAMED = 10  # a side's build inputs are named up to this many in the build's reason
OVERRUN_LINES = 20  # an overrun's last lines shown: how far it got
NAMED_LINES = 20  # THE BASE ALONE: the merge's lines the base's log lacks, shown up to this many
COMPARED_BYTES = 16 * 1024 * 1024  # THE BASE ALONE: a log over this is never read as "the same"
COMMENT_PATHS = 200  # COMMENTS ONLY: a side's paths past this many are read as changed in code
COMMENT_BYTES = 4 * 1024 * 1024  # COMMENTS ONLY: a blob over this is read as changed in code
TRIGGERS = ("same-input", "any-input")
BASE_SHA_VAR = "SHIP_PR_MERGE_BASE_SHA"  # THE COMMAND'S CONTRACT: the merge commit's first parent
HEAD_SHA_VAR = "SHIP_PR_MERGE_HEAD_SHA"  # and its second

_LINE = re.compile(r"([a-z]+)(?:[ \t]+(.*))?")
_SHA = re.compile(r"[0-9a-f]{40}([0-9a-f]{24})?")
# Run by `sh -c`: a marker that the command is starting (its mtime is where the build's own time
# starts, a slot's and a window's waits left behind), the command, its output to the log, and its
# status to a file -- the status file is what tells the command's own failure from the slot
# wrapper's refusal or deadline. A word after the status path names the PR in the slot's holder
# record (`build_of`); the script does not read it.
_WRAPPER = ': >"$3.started"; sh -c "$1" >"$2" 2>&1 </dev/null; rc=$?; printf "%s\\n" "$rc" >"$3"; exit "$rc"'
_WRAPPER_NAME = "merge-build"
_BUILD_OF = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*")


type Trigger = Literal["same-input", "any-input"]


@dataclass(frozen=True)
class BuildConfig:
    command: str
    inputs: tuple[str, ...]
    timeout: int = DEFAULT_TIMEOUT
    trigger: Trigger = "same-input"
    comments: tuple[str, ...] = ()  # COMMENTS ONLY's globs


def build_of(command: Sequence[str]) -> str | None:
    """The ``owner/name#n`` a slot's holder record names as the PR whose merge build holds the slot,
    or None: a command of ``_run``'s exact shape, and nothing else (a dry run names no PR)."""
    if len(command) != 8 or command[0] != "sh" or command[3] != _WRAPPER_NAME:
        return None
    return command[7] if _BUILD_OF.fullmatch(command[7]) else None


def parse_config(text: str, where: str) -> BuildConfig | None:
    """The config's lines (the module docstring's grammar), or None -- having said why -- for a
    file that is not one."""
    command: str | None = None
    inputs: list[str] = []
    comments: list[str] = []
    timeout: int | None = None
    trigger: Trigger | None = None
    for raw in text.split("\n"):
        line = (raw[:-1] if raw.endswith("\r") else raw).strip(" \t")
        if not line or line.startswith("#"):
            continue
        m = _LINE.fullmatch(line)
        key = m.group(1) if m else ""
        value = (m.group(2) or "").strip(" \t") if m else ""
        if key == "command" and value:
            if command is not None:
                warn(f"{where} names a second command line; a merge build runs one command: {line}")
                return None
            command = value
        elif key == "input" and value:
            inputs.append(value)
        elif key == "comments" and value:
            comments.append(value)
        elif key == "timeout" and value:
            if timeout is not None:
                warn(f"{where} names a second timeout line: {line}")
                return None
            # The length first: a few thousand digits is a ValueError in int() itself.
            if not value.isascii() or not value.isdigit() or len(value) > 6 or not 1 <= int(value) <= MAX_TIMEOUT:
                warn(f"{where}'s timeout is not a whole number of seconds from 1 to {MAX_TIMEOUT}: {line}")
                return None
            timeout = int(value)
        elif key == "trigger" and value:
            if trigger is not None:
                warn(f"{where} names a second trigger line: {line}")
                return None
            if value == "same-input":
                trigger = "same-input"
            elif value == "any-input":
                trigger = "any-input"
            else:
                warn(f"{where}'s trigger is neither `same-input` nor `any-input`: {line}")
                return None
        else:
            warn(
                f"{where} holds a line that is none of `command <shell command>`, `input <glob>`,",
                f"`comments <glob>`, `timeout <seconds>`, `trigger same-input|any-input`, a # comment or a",
                f"blank line: {line}",
            )
            return None
    if command is None or not inputs:
        warn(f"{where} needs one `command` line and at least one `input` line; it has", f"{'a' if command else 'no'} command and {len(inputs)} input(s).")
        return None
    return BuildConfig(
        command, tuple(inputs), DEFAULT_TIMEOUT if timeout is None else timeout, trigger or "same-input", tuple(comments)
    )


def build_inputs(paths: list[str], globs: tuple[str, ...], renamed: dict[str, list[str]] | None = None) -> list[str]:
    """The paths one glob matches whole (the module docstring's boundary) -- by any of their
    names: a path a rename on either side touched counts when its other name matches, since git
    carries an edit of the old name into the new one."""
    names = renamed or {}
    return [p for p in paths if any(fnmatch.fnmatchcase(n, g) for n in (p, *names.get(p, [])) for g in globs)]


def _named(paths: list[str]) -> str:
    shown = " ".join(paths[:NAMED])
    return shown if len(paths) <= NAMED else f"{shown} (and {len(paths) - NAMED} more)"


def build_reason(drift: Drift, config: BuildConfig) -> tuple[str | None, str]:
    """Whether the config's trigger holds on the drift read (the module docstring's WHEN IT
    BUILDS): ``(why, "")`` to build, or ``(None, why not)``. Called only once both sides are known
    to be nonempty, or unknown."""
    if drift.overlap is None or drift.pr_paths is None or drift.base_paths is None:
        return "the paths each side changed are UNKNOWN (above), which is never none", ""
    if config.trigger == "same-input":
        inputs = build_inputs(drift.overlap, config.inputs, drift.renamed)
        if inputs:
            return f"{len(inputs)} build input(s) changed on both sides: {_named(inputs)}", ""
        if not drift.overlap:
            return None, "no path changed on both sides (trigger same-input)"
        return None, f"none of the {len(drift.overlap)} path(s) changed on both sides is a build input ({' '.join(config.inputs)})"
    mine = build_inputs(drift.pr_paths, config.inputs, drift.renamed)
    theirs = build_inputs(drift.base_paths, config.inputs, drift.renamed)
    if mine and theirs:
        return f"build inputs changed on each side (trigger any-input): the PR's {_named(mine)}; the base's {_named(theirs)}", ""
    return None, (
        f"trigger any-input, and {'the PR' if not mine else 'the base'} changed no build input"
        f" ({' '.join(config.inputs)})"
    )


@dataclass(frozen=True)
class Candidates:
    """COMMENTS ONLY's reading of the trigger: the build inputs whose change decided it --
    ``shared`` under ``same-input`` (both sides changed them), ``mine`` (the PR's) and ``theirs``
    (the base's) under ``any-input`` -- and every name a rename on either side touched."""

    shared: tuple[str, ...]
    mine: tuple[str, ...]
    theirs: tuple[str, ...]
    renamed: frozenset[str]


def comment_candidates(drift: Drift, config: BuildConfig) -> Candidates | None:
    """What COMMENTS ONLY reads again once the objects are fetched; None when the config has no
    ``comments`` line or a side is UNKNOWN (nothing is read again: the build stands)."""
    if not config.comments or drift.overlap is None or drift.pr_paths is None or drift.base_paths is None:
        return None
    if config.trigger == "same-input":
        return Candidates(tuple(build_inputs(drift.overlap, config.inputs, drift.renamed)), (), (), frozenset(drift.renamed))
    return Candidates(
        (),
        tuple(build_inputs(drift.pr_paths, config.inputs, drift.renamed)),
        tuple(build_inputs(drift.base_paths, config.inputs, drift.renamed)),
        frozenset(drift.renamed),
    )


def read_config(session: GhSession, repo: str, cap: int, stop: str = "NOT merging") -> BuildConfig | None:
    """The repository's config from its default branch, None when it has none; refuses (2 or 3)
    as ``advisory_policy`` does for the advisory list, each refusal led by ``stop``."""
    where = f"{repo}'s {CONFIG_FILE}"
    result = session.retry(
        "read", ["api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{CONFIG_FILE}"]
    )
    match result:
        case GhOk(stdout=body):
            parsed = parse_config(body, where)
            if parsed is None:
                fail(2, f"{stop}: {where} is not a merge-build config (above); fix the file on the default branch.")
            return parsed
        case GhFailed():
            if "HTTP 404" in session.err_line():
                absent = github_file_absent(session, repo, CONFIG_LEAF, cap)
                if absent == 0:
                    return None
                if absent == 3:
                    fail(
                        3,
                        f"{stop}: {where} read as 404, and the listing that would establish its absence",
                        f"did not answer ({session.err_line()}). Whether the merge needs a build is UNKNOWN. Retry.",
                    )
                fail(
                    2,
                    f"{stop}: {where} read as 404, and its absence could not be established from the",
                    "directory listing (a 404 is also how GitHub answers a token without Contents access to a",
                    "private repository). Give the token Contents read access.",
                )
            fail(
                2,
                f"{stop}: could not read {where} on its default branch ({session.err_line()});",
                "the API refused the read, so whether the merge needs a build is unknown.",
            )
        case GhUnanswered():
            fail(
                3,
                f"{stop}: could not read {where} on its default branch ({session.err_line()}).",
                "Whether the merge needs a build is UNKNOWN. Retry.",
            )
        case _:
            assert_never(result)


# The variables that point git at a repository other than the one its cwd is in: an inherited one
# (merge run from a hook or a wrapper) would aim every call here, and the build's own git writes,
# at the caller's repository. Every git call and the build run without them.
_GIT_REPO_VARS = frozenset({
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
})


def _clean_env(base: dict[str, str] | None = None) -> dict[str, str]:
    return {k: v for k, v in (os.environ if base is None else base).items() if k not in _GIT_REPO_VARS}


def _git(args: list[str], cwd: str, *, timeout: float = GIT_TIMEOUT, env: dict[str, str] | None = None) -> proc.Completed:
    """A bounded git call, supervised (INTERRUPTS): a signal to merge ends it."""
    return _supervised(["git", *args], cwd, timeout, _clean_env(env))


def _first_line(done: proc.Completed) -> str:
    for text in (done.stderr, done.stdout):
        for line in text.splitlines():
            if line.strip():
                return line.strip()
    return f"exit {done.rc}"


def _remote_matches(url: str, repo: str) -> bool:
    """A remote URL naming ``owner/name`` as its last two path components (module docstring)."""
    path = url.strip().rstrip("/")
    if path.lower().endswith(".git"):
        path = path[:-4]
    parts = re.split(r"[/:\\]", path)
    return len(parts) >= 2 and "/".join(parts[-2:]).lower() == repo.lower()


def clone_of(repo: str, where: str, hooks: str | None = None) -> tuple[str | None, str | None]:
    """The git checkout ``where`` is in (None: not a directory inside one) and its remote naming
    ``repo`` (None: no such remote) -- ``origin`` first, else the first by name."""
    if not os.path.isdir(where):
        return None, None
    top = _git(["rev-parse", "--show-toplevel"], where)
    if top.rc != 0 or not top.stdout.strip():
        return None, None
    root = top.stdout.strip()
    quiet = ["-c", f"core.hooksPath={hooks}"] if hooks else []
    listed = _git([*quiet, "config", "--get-regexp", r"^remote\..*\.url$"], root)
    remotes: list[str] = []
    for line in listed.stdout.splitlines():
        key, _, url = line.partition(" ")
        name = key[len("remote.") : -len(".url")]
        if name and _remote_matches(url, repo):
            remotes.append(name)
    if not remotes:
        return root, None
    return root, ("origin" if "origin" in remotes else sorted(remotes)[0])


def find_clone(repo: str, where: str, hooks: str, stop: str = "NOT merging") -> tuple[str, str]:
    """The checkout ``where`` is in and its remote naming ``repo``; exit 2 when there is none."""
    root, remote = clone_of(repo, where, hooks)
    if root is None:
        fail(
            2,
            f"{stop}: {repo}'s {CONFIG_FILE} asks for a build of the merge commit, and this merge",
            f"does not run inside a git checkout ({where}). Run merge from a clone of {repo}, or name one",
            "with -C <clone>.",
        )
    if remote is None:
        fail(
            2,
            f"{stop}: {repo}'s {CONFIG_FILE} asks for a build of the merge commit, and the checkout",
            f"this merge runs in ({root}) has no remote naming {repo}. Run merge from a clone of it, or",
            "name one with -C <clone>.",
        )
    return root, remote


def clone_preflight(session: GhSession, repo: str, pr: str, where: str) -> None:
    """A ``merge --wait`` without ``-C``, before the wait (#944): the clone the build would use is
    the checkout ``where`` (the working directory) is in, and when it is no clone of ``repo`` while
    the repository asks for builds, the wait would end in ``find_clone``'s refusal -- 30 minutes
    late on lukstafi/ocannl-staging#1673, from ``~/ludics``. So that is refused now, exit 2,
    naming ``-C``; the clone to name is the caller's to say (#174: a guessed worktree is not the
    caller's intent), so none is inferred.

    The boundary, as an allowlist of what refuses: the checkout has no remote naming ``repo`` (or
    ``where`` is in no checkout) AND the default branch's ``CONFIG_FILE`` read answered with a
    body. The remotes are read first, locally, so a clone reads nothing here. Not read: whether
    this drift triggers a build, known only after the wait -- a config is the request for a
    clone, so a PR whose build would not have run is refused too, and ``-C`` answers it; nor
    the body's grammar, a shallow or partial clone, or the host, all the build step's own -- on a
    non-POSIX host nothing is read here, so its host refusal comes first there, as before. Any
    other answer of the config read (a 404, a refusal, no answer) is no refusal here: the build
    step reads the config again after the wait and decides as before. A non-answer says so on
    stderr."""
    if os.name == "nt":
        return
    root, remote = clone_of(repo, where)
    if remote is not None:
        return
    result = session.retry(
        "read", ["api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{CONFIG_FILE}"]
    )
    match result:
        case GhOk():
            pass
        case GhFailed() if "HTTP 404" in session.err_line():
            return
        case GhFailed() | GhUnanswered():
            warn(
                f"{repo}'s {CONFIG_FILE} could not be read before the wait ({session.err_line()}), so whether",
                f"this merge needs a clone of {repo} is unknown until its build step; waiting for the build signal.",
            )
            return
        case _:
            assert_never(result)
    here = f"the checkout this merge runs in ({root}) has no remote naming {repo}" if root else (
        f"this merge does not run inside a git checkout ({where})"
    )
    fail(
        2,
        f"REFUSING to merge {repo}#{pr} before the wait: {repo}'s {CONFIG_FILE} asks for a build of the",
        f"merge commit, and {here}. Run merge from a clone of {repo}, or name one with -C <clone>",
        "(the PR's own worktree, say). Nothing was waited for.",
    )


def _slot_runner() -> str | None:
    """fleet-worker.sh beside this package, when this box has run-time slots (its probe answers the
    PROBE line); None to run bare (issue-wave/references/executions.md: any other answer)."""
    here = Path(__file__).resolve().parents[3] / "issue-wave" / "scripts" / "fleet-worker.sh"
    if not here.is_file():
        return None
    probe = _supervised(["bash", str(here), "execution", "slot", "--probe"], os.getcwd(), PROBE_TIMEOUT, dict(os.environ))
    if probe.rc == 0 and probe.stdout.startswith("EXECUTION SLOT PROBE "):
        return str(here)
    return None


def _shown(log: str) -> list[str]:
    """The build log as shown: whole when short; otherwise its first ``SHOWN_HEAD`` and last
    ``SHOWN_TAIL`` lines, read from at most ``SHOWN_BYTES`` at each end, so a log of any size (or
    one endless line) costs a bounded read. Every line is cut at ``LINE_CHARS``."""

    def cut(line: str) -> str:
        return line if len(line) <= LINE_CHARS else line[:LINE_CHARS] + f"… ({len(line) - LINE_CHARS} more chars)"

    try:
        with open(log, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            if size <= 2 * SHOWN_BYTES:
                lines = proc.decode(handle.read()).splitlines()
                if len(lines) <= SHOWN_HEAD + SHOWN_TAIL:
                    return [cut(line) for line in lines]
                left = len(lines) - SHOWN_HEAD - SHOWN_TAIL
                return [*map(cut, lines[:SHOWN_HEAD]), f"... ({left} line(s) of {len(lines)} left out) ...",
                        *map(cut, lines[-SHOWN_TAIL:])]
            first = proc.decode(handle.read(SHOWN_BYTES)).splitlines()[:SHOWN_HEAD]
            handle.seek(size - SHOWN_BYTES)
            last = proc.decode(handle.read(SHOWN_BYTES)).splitlines()[1:][-SHOWN_TAIL:]
    except OSError as exc:
        return [f"(the build log could not be read: {exc.strerror})"]
    return [*map(cut, first), f"... (the log is {size} bytes; its middle is left out) ...", *map(cut, last)]


class _Interrupts:
    """The module docstring's INTERRUPTS: while ``installed()`` holds, SIGTERM and SIGHUP (and
    SIGINT, unless it was ignored) raise out of whatever the build is waiting on, so the running
    child's group is ended and the scratch removed on the way out -- except inside ``held()``,
    where the first one waits until the block ends."""

    def __init__(self) -> None:
        self.holding = False
        self.pending: int | None = None

    @staticmethod
    def _raise(signum: int) -> None:
        if signum == signal.SIGINT:
            raise KeyboardInterrupt
        raise cli.Exit(128 + signum, f"the merge build was interrupted by signal {signum}; it was stopped and its scratch removed, nothing merged")

    def _handler(self, signum: int, _frame: FrameType | None) -> None:
        if self.holding:
            if self.pending is None:
                self.pending = signum
            return
        self._raise(signum)

    def check(self) -> None:
        """Act on a signal held by a ``held()`` block that has ended."""
        if self.pending is not None:
            signum, self.pending = self.pending, None
            self._raise(signum)

    @contextlib.contextmanager
    def held(self) -> Generator[None]:
        """A step no signal may cut in two (a spawn, ending a group, making or removing the
        scratch). The caller calls ``check`` once what the step made is in hand."""
        was, self.holding = self.holding, True
        try:
            yield
        finally:
            self.holding = was

    @contextlib.contextmanager
    def installed(self) -> Generator[None]:
        self.pending = None
        sigs = [signal.SIGTERM, signal.SIGHUP]
        if signal.getsignal(signal.SIGINT) is signal.default_int_handler:
            sigs.append(signal.SIGINT)
        previous = {sig: signal.signal(sig, self._handler) for sig in sigs}
        try:
            yield
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            self.pending = None


_INTERRUPTS = _Interrupts()


def _end_group(child: subprocess.Popen[bytes]) -> None:
    """End the child's process group, and wait for its leader: SIGTERM first (an `execution slot`
    wrapper ends its own command's group on it, git removes its lock files), SIGKILL to what is
    left five seconds later. Run after a build that ENDED too, since a command may leave a process
    running behind it (`cmd &`): the group outlives its leader. POSIX only, as the whole build is
    (HOSTS AND CLONES). Held (INTERRUPTS): a second signal does not cut the ending short."""
    with _INTERRUPTS.held():
        _end_group_held(child)


def _end_group_held(child: subprocess.Popen[bytes]) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        # EPERM is "nothing left this process may signal": macOS answers it for a group whose
        # last members are zombies awaiting their reaper.
        try:
            os.killpg(child.pid, sig)
        except (ProcessLookupError, PermissionError):
            break
        gone = False
        deadline = time.monotonic() + 5
        while not gone and time.monotonic() < deadline:
            child.poll()
            try:
                os.killpg(child.pid, 0)
                time.sleep(0.05)
            except (ProcessLookupError, PermissionError):
                gone = True
        if gone:
            break
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _supervised(
    argv: list[str], cwd: str, bound: float, env: dict[str, str], *, merged: bool = False, end_group: bool = False,
    forward: bool = False,
) -> proc.Completed:
    """``argv`` in a session of its own under ``bound`` (124 past it, as ``proc.run_tool`` reports
    a timeout), stdin ``/dev/null``, its output captured (stderr into stdout when ``merged``) -- or,
    when ``forward``, not captured at all: both its streams are this process's stderr descriptor,
    so what it says reaches the caller as it says it (THE WINDOW WAIT), and the result's output is
    empty but for this function's own timeout line. Its
    group is ended when the wait for it ends any way but its own exit -- the bound, an exception,
    an INTERRUPT -- and after its own exit too when ``end_group`` (the build: a process it left
    behind). A child that cannot be spawned raises the ``OSError``/``ValueError`` to the caller.
    A tool the caller's shell bridges (a sourcing suite's fake ``git``) runs through the bridge, as
    under ``proc.run_tool``."""
    full = proc.bridge_argv(argv[0], argv[1:], env)
    if full is None:
        prefix = proc.command_argv(argv[0], env)
        if prefix is None:
            return proc.Completed(127, "", f"{argv[0]}: command not found\n")
        full = [*prefix, *argv[1:]]
    child: subprocess.Popen[bytes] | None = None
    if forward:
        # What this process said before goes first: the child writes past these buffers.
        sys.stdout.flush()
        sys.stderr.flush()
    try:
        with _INTERRUPTS.held():
            child = subprocess.Popen(
                full,
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=2 if forward else subprocess.PIPE,
                stderr=subprocess.STDOUT if merged or forward else subprocess.PIPE,
                start_new_session=True,
            )
        _INTERRUPTS.check()
        try:
            out, err = child.communicate(timeout=bound)
        except subprocess.TimeoutExpired:
            _end_group(child)
            try:
                out, err = child.communicate(timeout=5)
            except (subprocess.TimeoutExpired, ValueError):
                out, err = b"", b""
            return proc.Completed(
                124, proc.decode(out or b""), proc.decode(err or b"") + f"{argv[0]}: no answer in {bound:g}s\n"
            )
        if end_group:
            _end_group(child)
        return proc.Completed(child.returncode, proc.decode(out or b""), proc.decode(err or b""))
    except BaseException:
        # The hold first, before any call: CPython runs a signal handler only at a call or a
        # backward jump, so no second signal cuts in between the exception and the hold.
        was, _INTERRUPTS.holding = _INTERRUPTS.holding, True
        try:
            if child is not None:
                _end_group(child)
        finally:
            _INTERRUPTS.holding = was
        raise


@dataclass(frozen=True)
class Ceiling:
    """``merge --wait``'s deadline on its clock: the gate's own, a recovery's extension included
    (gate.py's ``Gate.deadline``). THE WINDOW WAIT runs within what is left of it."""

    clock: Clock
    deadline: int


def window_bound(ceiling: Ceiling | None) -> int:
    """THE WINDOW WAIT's bound: ``SLOT_WAIT`` without a ceiling (a merge with no --wait, a dry
    run), else what is left of the ceiling, never less than ``SLOT_WAIT``."""
    if ceiling is None:
        return SLOT_WAIT
    return max(SLOT_WAIT, ceiling.deadline - ceiling.clock.now())


def config_touched(drift: Drift) -> bool:
    """THE CONFIG NOTE's reading: the drift read's PR side holds ``CONFIG_FILE`` by either name of
    a rename. An UNKNOWN side is False: the note is never guessed."""
    if drift.pr_paths is None:
        return False
    return any(n == CONFIG_FILE for p in drift.pr_paths for n in (p, *drift.renamed.get(p, [])))


def merge_build(
    session: GhSession, repo: str, pr: str, gated: str, drift: Drift, cap: int, *,
    checkout: str | None = None, ceiling: Ceiling | None = None, override: str = "",
) -> str | None:
    """Build the would-be merge commit when the config and the drift read ask for it (the module
    docstring); return to merge, or end the command with its refusal. ``checkout`` is ``merge
    -C``'s clone (None: the working directory); ``override`` is ``--override``'s reason. Returns
    what the override goes over (THE BASE ALONE: a failure the base shares), for merge to
    announce; None when the merge goes over nothing here."""
    touched = config_touched(drift)

    def note(state: str) -> None:
        if touched:
            cli.say(
                f"merge build {repo}#{pr}: NOTE this PR changes {CONFIG_FILE}; this merge is judged by the copy on"
                f" {repo}'s default branch, never the PR's own ({state}). To see the PR's copy judge this pair:"
                f" pr-review.sh --repo {repo} merge-build --base {drift.base_sha or '<the base tip>'} --head {gated}"
                f" --config <the PR's copy of {CONFIG_FILE}>"
            )

    if drift.pr_paths is not None and drift.base_paths is not None and not (drift.pr_paths and drift.base_paths):
        # A side that changed nothing: no build is possible under either trigger, and the config is not read.
        note("not read: one side changed nothing, so no build is possible")
        return None
    config = read_config(session, repo, cap)
    if config is None:
        note("absent there: nothing is built")
        return None
    note("read below")
    why, why_not = build_reason(drift, config)
    if why is None:
        cli.say(f"merge build {repo}#{pr}: no build — {why_not}")
        return None
    if os.name == "nt":
        fail(
            2,
            f"NOT merging {repo}#{pr}: {why}, and the merge build runs on POSIX hosts only (the fleet's",
            "macOS and Linux boxes). Run this merge from one of them.",
        )
    if not drift.base_ref:
        fail(
            3,
            f"NOT merging {repo}#{pr}: {why}, and the PR's base branch could not be read (above),",
            "so the merge commit cannot be built. Retry.",
        )
    if not drift.base_sha:
        fail(
            3,
            f"NOT merging {repo}#{pr}: {why}, and the tip of {drift.base_ref} could not be read (above),",
            "so the merge commit cannot be built. Retry.",
        )
    return _build(
        repo, pr, gated, drift.base_ref, drift.base_sha, config, why, checkout=checkout, ceiling=ceiling, override=override,
        candidates=comment_candidates(drift, config),
    )


@dataclass(frozen=True)
class _Subject:
    """Whose build it is, in its lines: ``label`` after ``merge build``, ``stop`` leading a
    refusal before a verdict, ``refuse`` leading a failed build's; ``pr`` is the PR whose head is
    fetched, and empty for a dry run (THE DRY RUN), which fetches nothing; ``repo`` is the
    repository whose build history (buildhistory.py) the run goes into."""

    label: str
    stop: str
    refuse: str
    pr: str
    repo: str


def _build(
    repo: str, pr: str, gated: str, base_ref: str, tip: str, config: BuildConfig, why: str, *,
    checkout: str | None = None, ceiling: Ceiling | None = None, dry: bool = False, override: str = "",
    candidates: Candidates | None = None,
) -> str | None:
    """The build under the INTERRUPTS boundary (module docstring). ``dry``: THE DRY RUN's, in the
    clone ``checkout`` names as it is, with nothing fetched. Returns what an ``override`` goes over
    (THE BASE ALONE: a failure the base shares), else None. ``candidates``: what COMMENTS ONLY
    reads again before the slot is taken (None: nothing; the build stands)."""
    if dry:
        what = f"{gated[:8]} into {base_ref}"
        subject = _Subject(f"{what} (dry run)", f"merge-build {what}: NOT built", f"merge-build {what}: merge would REFUSE it", "", repo)
    else:
        subject = _Subject(f"{repo}#{pr}", f"NOT merging {repo}#{pr}", f"REFUSING to merge {repo}#{pr}", pr, repo)
    with _INTERRUPTS.installed():
        return _build_in_scratch(
            subject, repo, gated, base_ref, tip, config, why, checkout or os.getcwd(), ceiling, override, candidates
        )


def _build_in_scratch(
    subject: _Subject, repo: str, gated: str, base_ref: str, tip: str, config: BuildConfig, why: str,
    where: str, ceiling: Ceiling | None, override: str, candidates: Candidates | None,
) -> str | None:
    stop, pr = subject.stop, subject.pr
    # pr-review's own temporary family, keyed by the owning pid, so a SIGKILLed merge's leftover
    # (a whole build tree, and the repository it is in) is swept by the next `watch`
    # (watch.tmp_sweep_stale): nothing of the build lives anywhere else. It is made and removed
    # with signals held, so no signal leaves it behind.
    scratch: str | None = None
    try:
        with _INTERRUPTS.held():
            scratch = os.path.realpath(tempfile.mkdtemp(prefix=f"pr-review-build.{proc.own_pid()}."))
        _INTERRUPTS.check()
        hooks = os.path.join(scratch, "no-hooks")
        os.mkdir(hooks)
        tree = os.path.join(scratch, "tree")
        quiet = ["-c", f"core.hooksPath={hooks}"]
        if pr:
            root, remote = find_clone(repo, where, hooks)
        else:
            root, _ = clone_of(repo, where, hooks)
            if root is None:
                fail(2, f"{stop}: {where} is not inside a git checkout.")
            remote = ""
        shallow = _git([*quiet, "rev-parse", "--is-shallow-repository"], root)
        if shallow.stdout.strip() != "false":
            fail(
                2,
                f"{stop}: {why}, and the clone this merge runs in ({root}) is shallow",
                f"(or its depth could not be read: {_first_line(shallow)}): the merge build needs the merge base.",
                "Run merge from a full clone, or `git fetch --unshallow` this one first.",
            )
        partial = _git([*quiet, "config", "--get-regexp", r"^(extensions\.partialclone|remote\..*\.promisor)$"], root)
        if partial.stdout.strip():
            fail(
                2,
                f"{stop}: {why}, and the clone this merge runs in ({root}) is a partial clone",
                "(a promisor remote), whose missing objects the build's repository cannot fetch. Run merge",
                "from a full clone.",
            )
        if pr:
            _fetch_gated(subject, root, remote, quiet, gated, base_ref, why)
        for sha, what in ((gated, "its gated head"), (tip, f"{base_ref}'s tip as the drift read it")):
            if _git([*quiet, "cat-file", "-e", f"{sha}^{{commit}}"], root).rc != 0:
                fail(
                    3,
                    f"{stop}: {what}, {sha[:8]}, is not in {root} after the fetch",
                    "(a force-push may have moved it); re-run merge to read it again.",
                )
        common = _git([*quiet, "rev-parse", "--path-format=absolute", "--git-common-dir"], root).stdout.strip()
        objects = os.path.join(common, "objects")
        if not common or not os.path.isdir(objects):
            fail(3, f"{stop}: the object store of {root} could not be found ({common or 'no answer'}).")
        made = _new_repo(scratch, tree, objects)
        if made:
            fail(3, f"{stop}: the build's repository could not be made ({made}).")
        merged = _git([*quiet, "merge-tree", "--write-tree", "--no-messages", tip, gated], tree)
        if merged.rc == 1:
            fail(
                1,
                f"{stop}: {gated[:8]} does not merge cleanly with {base_ref} at {tip[:8]}:",
                f"merge or rebase {base_ref} in, resolve, push, then merge again.",
            )
        written = merged.stdout.split("\n", 1)[0].strip()
        if merged.rc != 0 or not _SHA.fullmatch(written):
            fail(
                3,
                f"{stop}: {why}, and git could not compute the merge of {gated[:8]} into",
                f"{base_ref} at {tip[:8]} ({_first_line(merged)}; `git merge-tree --write-tree` needs git >= 2.38).",
            )
        if candidates is not None:
            # COMMENTS ONLY: read again before the checkout and the slot.
            why_not = _comments_only(subject, quiet, tree, tip, gated, written, config, candidates)
            if why_not:
                cli.say(f"merge build {subject.label}: no build — {why_not}")
                return None
        merge_sha, err = _commit_out(quiet, tree, written, tip, gated, f"ship-pr merge build of {subject.label}", "the merge commit")
        if err:
            fail(3, f"{stop}: {err}.")
        # PROVENANCE (#1024): the scratch goes with the build, so the output is what names it.
        cli.say(
            f"merge build {subject.label}: merge commit {merge_sha}, parents {base_ref} at {tip}"
            f" and the gated head {gated}"
        )
        runner = _slot_runner()
        ran = _run(
            subject, config, runner, ceiling, tree, scratch, "build", tip, gated,
            f"{why}; building {gated[:8]} merged with {base_ref} at {tip[:8]} ({merge_sha[:8]})",
        )
        if ran.status == "0":
            cli.say(f"merge build {subject.label}: PASSED in {ran.took}s ({config.command})")
            return None
        if ran.status:
            cli.say(f"merge build {subject.label}: FAILED (exit {ran.status}) after {ran.took}s; its output:")
            for line in _shown(ran.log):
                cli.say(f"  | {line}")
            return _against_base(subject, config, runner, ceiling, scratch, tree, objects, quiet, base_ref, tip, gated, ran, override)
        _no_verdict(subject.label, stop, config, ran, "the build of its merge commit")
    finally:
        # Held from its first instruction (as in _supervised), so no signal skips the removal.
        was, _INTERRUPTS.holding = _INTERRUPTS.holding, True
        try:
            if scratch is not None:
                shutil.rmtree(scratch, ignore_errors=True)
        finally:
            _INTERRUPTS.holding = was
        _INTERRUPTS.check()


def _new_repo(scratch: str, tree: str, objects: str) -> str:
    """The build's own repository at ``tree``: it borrows the clone's objects (alternates, read
    only) and has its own config, refs and index, so the clone's sparse-checkout, hooks and refs
    are not the build's, and a git write the build makes lands here and goes with the scratch.
    Returns what went wrong, or ""."""
    made = _git(["init", "--quiet", "--template=", tree], scratch)
    if made.rc != 0:
        return _first_line(made)
    info = os.path.join(tree, ".git", "objects", "info")
    os.makedirs(info, exist_ok=True)
    with open(os.path.join(info, "alternates"), "w", encoding="utf-8") as handle:
        handle.write(objects + "\n")
    return ""


class _CodeReader:
    """COMMENTS ONLY on one side: whether it changed a path in code since ``base``. git's raw diff
    of ``paths`` (the ones a ``comments`` glob matches and no rename touched, up to
    ``COMMENT_PATHS``) is read once, at the first question; every other path, and every path when
    that diff does not answer, is changed in code."""

    def __init__(
        self, quiet: list[str], tree: str, base: str, side: str, paths: tuple[str, ...], config: BuildConfig,
        renamed: frozenset[str],
    ) -> None:
        self.quiet, self.tree, self.base, self.side = quiet, tree, base, side
        eligible = [
            p for p in dict.fromkeys(paths)
            if p not in renamed and any(fnmatch.fnmatchcase(p, g) for g in config.comments)
            and commentonly.language(p) is not None
        ]
        self.eligible = frozenset(eligible[:COMMENT_PATHS])
        self.raw: dict[str, tuple[str, str, str, str, str]] | None = None
        self.failed = ""

    def _read(self) -> dict[str, tuple[str, str, str, str, str]]:
        if self.raw is None:
            self.raw = {}
            done = _git(
                [*self.quiet, "--literal-pathspecs", "diff", "--raw", "-z", "--no-renames", "--no-abbrev",
                 "--no-color", "--no-ext-diff", self.base, self.side, "--", *sorted(self.eligible)],
                self.tree,
            )
            fields = done.stdout.split("\0")
            if fields and fields[-1] == "":
                fields.pop()
            if done.rc != 0 or len(fields) % 2:
                self.failed = f"git diff {self.base[:8]} {self.side[:8]} did not answer ({_first_line(done)})"
                return self.raw
            for meta, path in zip(fields[0::2], fields[1::2], strict=True):
                parts = meta.lstrip(":").split(" ")
                if len(parts) != 5:
                    self.failed = f"git diff {self.base[:8]} {self.side[:8]} said {meta!r}"
                    self.raw = {}
                    return self.raw
                self.raw[path] = (parts[0], parts[1], parts[2], parts[3], parts[4])
        return self.raw

    def code(self, path: str) -> bool:
        """True unless this side's change of ``path`` is in comments and blanks only (or none)."""
        if path not in self.eligible:
            return True
        raw = self._read()
        if self.failed:
            return True
        if path not in raw:
            return False  # git sees no change of it on this side
        old_mode, new_mode, old_sha, new_sha, status = raw[path]
        if status != "M" or old_mode != new_mode or old_mode not in ("100644", "100755"):
            return True
        old, new = _blob(self.quiet, self.tree, old_sha), _blob(self.quiet, self.tree, new_sha)
        return old is None or new is None or not commentonly.same_code(path, old, new)


def _blob(quiet: list[str], tree: str, spec: str) -> str | None:
    """The blob ``spec`` names (an id, or ``<tree-ish>:<path>``) as text, None when git cannot
    read it or it is over ``COMMENT_BYTES``."""
    size = _git([*quiet, "cat-file", "-s", spec], tree).stdout.strip()
    if not size.isascii() or not size.isdigit() or len(size) > 12 or int(size) > COMMENT_BYTES:
        return None
    done = _git([*quiet, "cat-file", "blob", spec], tree)
    return done.stdout if done.rc == 0 else None


def _merged_keeps(quiet: list[str], tree: str, written: str, other: str, path: str) -> bool:
    """COMMENTS ONLY's last check on a path one side changed in comments only: the merge's code
    there is the other side's (``other``). Without it, a side that moves comment delimiters over
    duplicated code reads as comments only, and the merge can drop the other side's edit."""
    merged, theirs = _blob(quiet, tree, f"{written}:{path}"), _blob(quiet, tree, f"{other}:{path}")
    if merged is None or theirs is None:
        return False
    code = commentonly.code_of(path, merged)
    return code is not None and code == commentonly.code_of(path, theirs)


def _comments_only(
    subject: _Subject, quiet: list[str], tree: str, tip: str, gated: str, written: str, config: BuildConfig,
    cand: Candidates,
) -> str:
    """COMMENTS ONLY (module docstring): why there is no build after all, or "" to build."""
    bases = _git([*quiet, "merge-base", "--all", tip, gated], tree)
    found = bases.stdout.split()
    if bases.rc != 0 or len(found) != 1 or not _SHA.fullmatch(found[0]):
        cli.say(
            f"merge build {subject.label}: comments not compared: the merge base is not one commit"
            f" ({_first_line(bases) if bases.rc else f'{len(found)} found'}); building"
        )
        return ""
    base = found[0]
    globs = " ".join(config.comments)
    if config.trigger == "same-input":
        tip_side = _CodeReader(quiet, tree, base, tip, cand.shared, config, cand.renamed)
        head_side = _CodeReader(quiet, tree, base, gated, cand.shared, config, cand.renamed)
        code: list[str] = []
        moved: list[str] = []
        for p in cand.shared:
            in_tip, in_head = tip_side.code(p), head_side.code(p)
            if in_tip and in_head:
                code.append(p)
            elif not _merged_keeps(quiet, tree, written, tip if in_tip else gated, p):
                moved.append(p)
        failed = tip_side.failed or head_side.failed
        if failed:
            cli.say(f"merge build {subject.label}: comments not fully compared: {failed}")
        if code:
            cli.say(f"merge build {subject.label}: changed in code on both sides: {_named(code)}")
        if moved:
            cli.say(f"merge build {subject.label}: merged into code that is not the code-changing side's: {_named(moved)}")
        if code or moved:
            return ""
        return (
            f"each of the {len(cand.shared)} build input(s) changed on both sides ({_named(list(cand.shared))})"
            f" changed in comments only on one side (comments {globs})"
        )
    mine = _CodeReader(quiet, tree, base, gated, cand.mine, config, cand.renamed)
    theirs = _CodeReader(quiet, tree, base, tip, cand.theirs, config, cand.renamed)
    # Paths no reader reads first: any() stops at the first changed in code, before a git call.
    pr_code = any(mine.code(p) for p in sorted(cand.mine, key=lambda p: p in mine.eligible))
    shared = [p for p in cand.mine if p in set(cand.theirs)]
    # A side read as comments only counts as code where the merge's code of a path both changed
    # is not the other side's (_merged_keeps).
    pr_code = pr_code or not all(_merged_keeps(quiet, tree, written, tip, p) for p in shared)
    base_code = pr_code and any(theirs.code(p) for p in sorted(cand.theirs, key=lambda p: p in theirs.eligible))
    base_code = base_code or (pr_code and not all(_merged_keeps(quiet, tree, written, gated, p) for p in shared))
    failed = mine.failed or theirs.failed
    if failed:
        cli.say(f"merge build {subject.label}: comments not fully compared: {failed}")
    if pr_code and base_code:
        return ""
    side, paths = ("the PR", cand.mine) if not pr_code else ("the base", cand.theirs)
    return (
        f"trigger any-input, and {side} changed its build input(s) in comments only"
        f" ({_named(list(paths))}; comments {globs})"
    )


def _commit_out(
    quiet: list[str], tree: str, written: str, tip: str, gated: str, message: str, what: str
) -> tuple[str, str]:
    """A commit of the tree ``written`` with the merge's two parents (THE COMMAND'S CONTRACT),
    checked out in full at ``tree``: ``(its sha, "")``, or ``("", what went wrong)``."""
    ident = dict(os.environ)
    for role in ("AUTHOR", "COMMITTER"):
        ident[f"GIT_{role}_NAME"] = "ship-pr merge build"
        ident[f"GIT_{role}_EMAIL"] = "ship-pr@localhost"
    commit = _git([*quiet, "commit-tree", written, "-p", tip, "-p", gated, "-m", message], tree, env=ident)
    sha = commit.stdout.strip()
    if commit.rc != 0 or not _SHA.fullmatch(sha):
        return "", f"{what} could not be written ({_first_line(commit)})"
    out = _git([*quiet, "-c", "core.sparseCheckout=false", "checkout", "--quiet", "--detach", sha], tree)
    if out.rc != 0:
        return "", f"{what} could not be checked out ({_first_line(out)})"
    return sha, ""


@dataclass(frozen=True)
class _Ran:
    """One run of the command: ``status`` is the status file's text ("" when the command never
    ended on its own: the wrapper's refusal, the deadline), ``done`` the wrapper's own result,
    ``took`` the seconds the command ran (with no sign of its start, the whole wait for the
    wrapper) and ``started`` whether it did start; ``earlier`` the build history as this run found it."""

    status: str
    done: proc.Completed
    took: int
    log: str
    started: bool = True
    earlier: tuple[buildhistory.Row, ...] = ()


def _run(
    subject: _Subject, config: BuildConfig, runner: str | None, ceiling: Ceiling | None, tree: str,
    scratch: str, name: str, tip: str, gated: str, what: str,
) -> _Ran:
    """The command at the root of ``tree``, its output to ``<scratch>/<name>.log``, inside the
    box's slot when it has slots, bounded either way (HOW IT BUILDS)."""
    log = os.path.join(scratch, f"{name}.log")
    status = os.path.join(scratch, f"{name}.status")
    wrapped = ["sh", "-c", _WRAPPER, _WRAPPER_NAME, config.command, log, status]
    if subject.pr:
        wrapped.append(f"{subject.repo}#{subject.pr}")
    bound = float(config.timeout)
    if runner:
        # THE WINDOW WAIT: its bound read now, after the setup, from what is left of the ceiling.
        window = window_bound(ceiling)
        where_run = f"in a run-time slot (a measurement on this box waited for up to {window}s)"
        wrapped = ["bash", runner, "execution", "slot", "--cpu", "--wait", str(SLOT_WAIT),
                   f"--wait-window={window}", "--deadline", str(config.timeout), "--", *wrapped]
        bound += SLOT_WAIT + window + 120
    else:
        where_run = "bare (this box has no run-time slots)"
    cli.say(f"merge build {subject.label}: {what} {where_run}, bound {config.timeout}s: {config.command}")
    # THE COMMAND'S CONTRACT: the merge commit's parents, by name.
    env = {**_clean_env(), BASE_SHA_VAR: tip, HEAD_SHA_VAR: gated}
    started = time.monotonic()
    try:
        # Forwarded, not captured: the slot's lines (the measurement it waits for, by request id)
        # reach the caller as the slot says them (THE WINDOW WAIT); the command's own output
        # goes to the log.
        done = _supervised(wrapped, tree, bound, env, end_group=True, forward=True)
    except (ValueError, OSError) as exc:
        # A command no exec can take (a NUL in it, past the argument limit): the config's fault.
        where_fix = "the file on the default branch" if subject.pr else "the config"
        fail(2, f"{subject.stop}: {CONFIG_FILE}'s command cannot be run ({exc}); fix {where_fix}.")
    took = int(time.monotonic() - started)
    try:
        with open(status, encoding="utf-8") as handle:
            rc_text = handle.read().strip()
    except OSError:
        rc_text = ""
    ran_for = _ran_for(status, rc_text != "")
    earlier = buildhistory.read(subject.repo, config.command)
    if ran_for is not None:
        if rc_text == "0":
            buildhistory.record(subject.repo, config.command, "passed", ran_for, config.timeout)
        elif not rc_text and done.rc == 124:
            buildhistory.record(subject.repo, config.command, "overran", ran_for, config.timeout)
    return _Ran(rc_text, done, took if ran_for is None else ran_for, log, ran_for is not None, tuple(earlier))


def _ran_for(status: str, ended: bool) -> int | None:
    """The seconds the command ran, from ``_WRAPPER``'s marker to its status file, or to now when
    it ``ended`` not by itself; None when it never started."""
    try:
        began = os.stat(f"{status}.started").st_mtime
        return max(int((os.stat(status).st_mtime if ended else time.time()) - began), 0)
    except OSError:
        return None


def _say_progress(label: str, took: int, bound: int, log: str) -> None:
    """How far an overrun's build got: its time, the size of its output, then its last lines."""
    try:
        size = os.stat(log).st_size
    except OSError:
        size = 0
    if not size:
        cli.say(f"merge build {label}: stopped {took}s in, bound {bound}s, having written no output")
        return
    cli.say(f"merge build {label}: stopped {took}s in, bound {bound}s, having written {size} byte(s); its last lines:")
    for line in _shown(log)[-OVERRUN_LINES:]:
        cli.say(f"  | {line}")


def _no_verdict(label: str, stop: str, config: BuildConfig, ran: _Ran, what: str) -> NoReturn:
    """A run with no status of its own: what the wrapper said, then exit 4 (past the bound) or 3."""
    done = ran.done
    for line in (done.stdout + done.stderr).splitlines():
        cli.say(f"  | {line}")
    if done.rc == 124:
        if not ran.started:
            fail(
                4,
                f"{stop}: {what} never started within its waits (bound {config.timeout}s, slot and",
                "window waits apart); no verdict. Re-run merge.",
            )
        _say_progress(label, ran.took, config.timeout, ran.log)
        fail(
            4,
            f"{stop}: {what} did not finish within",
            f"{config.timeout}s ({CONFIG_FILE}'s timeout); no verdict.",
            *buildhistory.overrun_advice(list(ran.earlier), config.timeout, CONFIG_FILE),
        )
    fail(
        3,
        f"{stop}: {what} could not run (the wrapper exited",
        f"{done.rc} before the command did; what it said is above, on stderr). Retry.",
    )


def _log_lines(log: str) -> Counter[str] | None:
    """The log's lines, counted (THE BASE ALONE), or None when it is over ``COMPARED_BYTES`` or
    cannot be read: a log not read whole is never "the same"."""
    try:
        with open(log, "rb") as handle:
            data = handle.read(COMPARED_BYTES + 1)
    except OSError:
        return None
    if len(data) > COMPARED_BYTES:
        return None
    return Counter(proc.decode(data).splitlines())


def _against_base(
    subject: _Subject, config: BuildConfig, runner: str | None, ceiling: Ceiling | None, scratch: str,
    tree: str, objects: str, quiet: list[str], base_ref: str, tip: str, gated: str, merged: _Ran, override: str,
) -> str | None:
    """THE BASE ALONE (module docstring): after the merge's build FAILED, the same command on the
    base tip's tree with the merge's parents, and the verdict: a refusal, or -- under ``override``,
    for a failure the base shares -- what the override goes over."""
    stop, label = subject.stop, subject.label
    head8, tip8, rc = gated[:8], tip[:8], merged.status
    plain = (
        f"{subject.refuse}: {head8} merged with {base_ref} at {tip8} does not build",
        f"({config.command}: exit {rc}, output above),",
    )
    # The merge's tree moves aside (a rename, whatever its files' modes; the scratch's removal
    # takes it), so the base's is built at the same absolute path and a path the command prints
    # reads the same in both logs.
    try:
        os.rename(tree, os.path.join(scratch, "merged"))
        err = _new_repo(scratch, tree, objects)
    except OSError as exc:
        err = f"the merge's tree could not be moved aside ({exc.strerror})"
    sha = ""
    if not err:
        sha, err = _commit_out(
            quiet, tree, f"{tip}^{{tree}}", tip, gated, f"ship-pr merge build: {base_ref} alone, for {label}",
            f"the commit of {base_ref} alone",
        )
    if err:
        cli.say(f"merge build {label}: {base_ref} alone could not be built to compare: {err}")
        if override:
            fail(3, f"{stop}: its merge build FAILED (above), and {base_ref} alone could not be built to tell",
                 f"whether the base shares that failure ({err}); --override goes over only one it shares. Retry.")
        fail(1, *plain, f"and {base_ref} alone could not be built to compare ({err}). Merge {base_ref} in, fix the",
             "clash, push, and merge again.")
    base = _run(
        subject, config, runner, ceiling, tree, scratch, "base", tip, gated,
        f"does the base share the failure? building {base_ref} at {tip8} alone ({sha[:8]}: its tree, the merge's two parents)",
    )
    if not base.status:
        if override:
            _no_verdict(label, stop, config, base, f"its merge build FAILED (above), and the build of {base_ref} alone, which tells whether the base shares that failure,")
        for line in (base.done.stdout + base.done.stderr).splitlines():
            cli.say(f"  | {line}")
        fail(1, *plain, f"and the build of {base_ref} alone gave no verdict to compare. Merge {base_ref} in, fix the",
             "clash, push, and merge again.")
    if base.status == "0":
        cli.say(f"merge build {label}: {base_ref} alone PASSED in {base.took}s: the failure is the merge's own")
        fail(1, *plain, f"though each side is green on its own. Merge {base_ref} in, fix the clash, push, and merge again.")
    mine, theirs = _log_lines(merged.log), _log_lines(base.log)
    if base.status != rc:
        differs = f"{base_ref} alone exits {base.status}, the merge {rc}"
        extra: list[str] = []
    elif mine is None or theirs is None:
        differs = f"a log is over {COMPARED_BYTES} bytes or could not be read, so the two were not compared"
        extra = []
    else:
        extra = list((mine - theirs).elements())
        differs = f"{len(extra)} line(s) of the merge's output are not in {base_ref}'s" if extra else ""
    if differs:
        cli.say(f"merge build {label}: {base_ref} alone FAILED (exit {base.status}) after {base.took}s, not the same way: {differs}")
        for line in extra[:NAMED_LINES]:
            cli.say(f"  + {line[:LINE_CHARS]}")
        if len(extra) > NAMED_LINES:
            cli.say(f"  + ... ({len(extra) - NAMED_LINES} more)")
        fail(
            1, *plain,
            f"and its failure is not only {base_ref}'s ({differs}). Merge {base_ref} in, fix what is the merge's,",
            "push, and merge again" + ("; --override goes over only a failure the base alone shares." if override else "."),
        )
    cli.say(
        f"merge build {label}: {base_ref} alone FAILED the same way (exit {rc}, every line of the merge's output in"
        f" its own) after {base.took}s: the failure is the base's"
    )
    shared = f"a merge-build failure {base_ref} at {tip8} alone shares ({config.command}: exit {rc})"
    if override:
        return shared
    fail(
        1, *plain,
        f"and {base_ref} at {tip8} alone fails the same way: the failure is the base's, not the merge's. Only",
        "where that red is established (ship-pr's *The override*) re-run merge with --override '<the red, the",
        "base sha, its owner>', which goes over exactly a failure the base shares; otherwise this merge waits",
        "for the base's fix.",
    )


def _fetch_gated(subject: _Subject, root: str, remote: str, quiet: list[str], gated: str, base_ref: str, why: str) -> None:
    """Merge's fetch of the PR's head and its base, objects only, and the remote's head read back:
    the gated head, or SUPERSEDED (5). A dry run makes none of it."""
    stop, pr = subject.stop, subject.pr
    # Objects only: no destination, --refmap= (so no remote-tracking ref of the caller's moves
    # opportunistically) and no FETCH_HEAD. Nothing in the clone names what was fetched; the
    # two commits are named by the SHAs the gate and the drift read already hold.
    fetched = _git(
        [*quiet, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", remote,
         f"refs/pull/{pr}/head", f"refs/heads/{base_ref}"],
        root,
        timeout=FETCH_TIMEOUT,
    )
    if fetched.rc != 0:
        fail(
            3,
            f"{stop}: {why}, and fetching its head and {base_ref} from {remote} in",
            f"{root} failed ({_first_line(fetched)}), so the merge commit was not built. Retry.",
        )
    # The remote's head now, not the object's presence: a clone that already holds the gated
    # commit would pass a presence check after a force-push replaced it.
    listed = _git([*quiet, "ls-remote", "--quiet", remote, f"refs/pull/{pr}/head"], root, timeout=FETCH_TIMEOUT)
    now = listed.stdout.split()[0] if listed.rc == 0 and listed.stdout.split() else ""
    if not _SHA.fullmatch(now):
        fail(
            3,
            f"{stop}: its head on {remote} could not be read back after the fetch",
            f"({_first_line(listed)}). Retry.",
        )
    if now != gated:
        fail(
            5,
            f"{stop}: its head on {remote} is {now[:8]}, not {gated[:8]}, the commit the",
            "build signal was read for: SUPERSEDED. Re-run merge to judge the new head.",
        )


def dry_build(
    repo: str, head: str, base_ref: str, base: str, config: BuildConfig, why: str, checkout: str,
    candidates: Candidates | None = None,
) -> None:
    """THE DRY RUN's build (mergedry.py): ``head`` merged into ``base`` in ``checkout`` as it is,
    ``candidates`` read again as merge's are (COMMENTS ONLY)."""
    _build(repo, "", head, base_ref, base, config, why, checkout=checkout, dry=True, candidates=candidates)


def run_git(args: list[str], cwd: str) -> proc.Completed:
    """A bounded, supervised git call, with git's repository-selection variables cleared."""
    return _git(args, cwd)


def first_line(done: proc.Completed) -> str:
    """The first nonblank line a call said (stderr first), or its exit status."""
    return _first_line(done)
