"""``pr-review.sh local-review <base> [--out <dir>] [-C <dir>]``: the local Codex review a branch
gets once, before the push that opens its PR (ship-pr's *Open*; ludics-lite#750).

Why a verb. The step was a pasted shell snippet, and the snippet kept breaking where no test could
see it: ``codex review --base origin/main "<prompt>"`` is refused by the codex CLI (``--base``
cannot be combined with ``[PROMPT]``, codex-cli 0.159.3 and still 0.163.0), which cost three
launches; the fix's own copy reviewed only the working tree when ``git merge-base`` printed nothing
(#746); and a review whose prompt lacked the do-not-run-tests line ran suites unasked, outside any
run-time slot, in 3 of 7 reviews (#742, #738, #745). This module owns each of those, and its unit
cases (lib/ludics/tests/test_prreview_localreview.py) drive it through a fake ``codex`` binary.

WHAT IT READS -- the boundary, a fail-closed allowlist. A local checkout (``-C <dir>``, else the
working directory) and, in it: ``HEAD`` as a commit; the remote-tracking ref
``refs/remotes/origin/<base>`` (``<base>`` a branch name; a leading ``origin/`` is dropped once),
never a local branch and never a fetch -- a ref that does not resolve is refused, fetch it first;
their merge base; and the tracked files' status. Any of these that git cannot answer is a refusal,
exit 2, with ``nothing launched`` in its message and no codex started: no merge base (a bare ``git
diff`` would review the working tree alone, #746), ``HEAD`` at the merge base (no commit to
review), and an uncommitted change to a tracked file (the review reads the commits; an uncommitted
edit is what the push would skip, or what the review would read as the branch). Untracked files
are not read. It reads no PR, no GitHub state and no repository name.

THE CALL. The codex CLI's argument shape lives in ``codex_argv`` alone: ``codex exec review -o
<verdict> <prompt>``, the merge base named in the prompt rather than through ``--base`` (refused
with a prompt, above). The prompt is ``prompt_text``: the base, the merge base and the head's full
SHA (a commit made while the review runs does not widen it), and the ``NO_TESTS`` line. codex runs
in the checkout's top level with stdin ``/dev/null`` and no time bound of its own -- it runs for
minutes, and the caller backgrounds it.

WHAT IT WRITES. ``<out>/run.log``, the whole transcript (codex's stdout and stderr), and
``<out>/verdict.md``, only the review's last message (codex's ``-o``). ``<out>`` is ``--out <dir>``
(made if missing) or a fresh ``mktemp -d`` directory, and an earlier ``verdict.md`` there is removed
before the launch, so a verdict read after the run is this run's. The two paths are printed before
the launch, and the verdict's again at the end.

Exit: 0 a verdict was written; 2 refused, nothing launched (usage, the checkout, the base, the
merge base, nothing to review, an uncommitted change, an unusable ``--out``); 127 codex is not on
PATH, nothing launched; 1 codex exited 0 and wrote no verdict; any other status is codex's own,
propagated (a status of 2 from codex is its own usage error, and its message is in ``run.log``).
"""

import os
import subprocess
import tempfile
from typing import NoReturn

from ludics import cli, proc
from ludics.prreview.core import die, fail
from ludics.prreview.mergebuild import first_line, run_git

USAGE = "usage: local-review <base> [--out <dir>] [-C <dir>]"
REMOTE = "origin"
VERDICT = "verdict.md"
LOG = "run.log"
NO_TESTS = (
    "Do not run tests, builds or suites: the author runs them, and a run in this sandbox proves nothing."
)
# The repository-selection variables git would obey over the checkout's own: cleared for codex as
# run_git clears them for every git call here, so both read the same repository.
_GIT_REPO_VARS = frozenset({
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
})


def prompt_text(base_ref: str, merge_base: str, head: str) -> str:
    """The review's instructions: what to read, and the line that keeps it from running suites."""
    return (
        f"Review the code changes on this branch against the base branch {base_ref}, merge base"
        f" {merge_base}, head {head}: inspect them with `git log {merge_base}..{head}` and `git diff"
        f" {merge_base} {head}`, and give prioritized, actionable findings. {NO_TESTS}"
    )


def codex_argv(verdict: str, prompt: str) -> list[str]:
    """The codex CLI's arguments, in this one place (THE CALL): ``--base`` refuses a prompt."""
    return ["exec", "review", "-o", verdict, prompt]


def _refuse(*parts: str) -> NoReturn:
    die("local-review:", *parts, "Nothing launched.")


def _take(rest: list[str], flag: str) -> tuple[str, list[str]]:
    if len(rest) < 2 or not rest[1]:
        _refuse(f"{flag} needs a value; {USAGE}.")
    return rest[1], rest[2:]


def _out_dir(out: str | None) -> str:
    try:
        if out is None:
            return os.path.realpath(tempfile.mkdtemp(prefix="local-review."))
        os.makedirs(out, exist_ok=True)
        verdict = os.path.join(out, VERDICT)
        if os.path.lexists(verdict):
            os.remove(verdict)
        return os.path.realpath(out)
    except OSError as exc:
        _refuse(f"the output directory {out or tempfile.gettempdir()} is not usable ({exc.strerror}).")


def run(args: list[str]) -> int:
    base: str | None = None
    out: str | None = None
    checkout: str | None = None
    rest = list(args)
    while rest:
        arg = rest[0]
        if arg == "--out":
            out, rest = _take(rest, arg)
        elif arg == "-C":
            checkout, rest = _take(rest, arg)
        elif arg.startswith("--out="):
            out = arg[len("--out=") :]
            if not out:
                _refuse(f"--out needs a value; {USAGE}.")
            rest = rest[1:]
        elif arg.startswith("-") or base is not None:
            _refuse(f"unknown argument '{arg}'; {USAGE}.")
        else:
            base, rest = arg, rest[1:]
    if not base:
        _refuse(f"the base branch is required; {USAGE}.")
    if base.startswith(f"{REMOTE}/"):
        base = base[len(REMOTE) + 1 :]
    where = checkout if checkout is not None else os.getcwd()
    top = run_git(["rev-parse", "--show-toplevel"], where) if os.path.isdir(where) else None
    root = top.stdout.strip() if top is not None and top.rc == 0 else ""
    if not root:
        _refuse(f"{where} is not a directory inside a git checkout; run it in one, or pass -C <dir>.")
    base_ref = f"{REMOTE}/{base}"
    shas: list[str] = []
    for name, rev in (("HEAD", "HEAD"), (base_ref, f"refs/remotes/{base_ref}")):
        done = run_git(["rev-parse", "--verify", "--quiet", "--end-of-options", f"{rev}^{{commit}}"], root)
        sha = done.stdout.strip()
        if done.rc != 0 or not sha:
            fetch = f"; fetch it first (git fetch {REMOTE} {base})" if name == base_ref else ""
            _refuse(f"{name} is not a commit in {root}{fetch}.")
        shas.append(sha)
    head, base_sha = shas
    found = run_git(["merge-base", head, base_sha], root)
    merge_base = found.stdout.strip()
    if found.rc != 0 or not merge_base:
        _refuse(
            f"HEAD {head[:8]} and {base_ref} {base_sha[:8]} have no merge base in {root} ({first_line(found)});",
            "a review against none would read the working tree alone.",
        )
    if merge_base == head:
        _refuse(f"HEAD {head[:8]} has no commit beyond {base_ref}'s merge base: there is nothing to review.")
    status = run_git(["status", "--porcelain", "--untracked-files=no"], root)
    if status.rc != 0:
        _refuse(f"git could not read the checkout's status in {root} ({first_line(status)}).")
    if status.stdout.strip():
        _refuse(
            f"{root} has uncommitted changes to tracked files; commit them first: the review reads",
            "the branch's commits, and the push carries only those.",
        )
    prefix = proc.command_argv("codex")
    if prefix is None:
        fail(127, "local-review: codex is not on PATH; skip the local review and say so in the PR body. Nothing launched.")
    directory = _out_dir(out)
    verdict = os.path.join(directory, VERDICT)
    log = os.path.join(directory, LOG)
    count = run_git(["rev-list", "--count", f"{merge_base}..{head}"], root).stdout.strip() or "?"
    cli.say(
        f"local review of HEAD {head[:8]} against {base_ref} (merge base {merge_base[:8]}, {count} commit(s)):"
        f" verdict {verdict}, transcript {log}"
    )
    argv = [*prefix, *codex_argv(verdict, prompt_text(base_ref, merge_base, head))]
    env = {k: v for k, v in os.environ.items() if k not in _GIT_REPO_VARS}
    spawn: list[str] | str = proc.windows_command_line(argv) if os.name == "nt" else argv
    try:
        with open(log, "wb") as transcript:
            child = subprocess.Popen(
                spawn, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=transcript, stderr=subprocess.STDOUT
            )
            try:
                rc = child.wait()
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait()
    except OSError as exc:
        fail(127, f"local-review: codex could not be started ({exc.strerror}); the transcript is {log}.")
    if rc < 0:
        rc = 128 - rc
    if rc != 0:
        fail(rc, f"local-review: codex exited {rc}; read the transcript {log}.")
    try:
        with open(verdict, encoding="utf-8", errors="surrogateescape") as handle:
            written = handle.read().strip()
    except OSError:
        written = ""
    if not written:
        fail(1, f"local-review: codex exited 0 and wrote no verdict to {verdict}; read the transcript {log}.")
    cli.say(f"local review: verdict {verdict}")
    return 0

