"""``pr-review.sh [--repo owner/name] merge-build --base <rev> --head <rev> [--config <file>]
[-C <dir>]``: the merge build alone, as a dry run (ludics-lite#751; mergebuild.py's THE DRY RUN).

Why. A merge-build config is judged only by the default branch's copy (mergebuild.py's THE CONFIG
NOTE), so a PR that adds or changes one cannot show it working through ``merge``; #738's worker
proved its config refuses a known clash with a Python driver swapping ``read_config`` and a scratch
bare remote whose path ended in ``owner/name``. This verb is that negative control: merge the two
revisions as merge would (base first, head second), apply the config's trigger, and run its
command in the same scratch build. It never merges, never reads or touches a PR, and fetches
nothing.

WHAT IT READS -- the boundary. A local checkout (``-C <dir>``, else the working directory): the two
revisions resolve there to commits (``rev-parse --verify <rev>^{commit}``), or the run is refused,
exit 2 (fetch them first). The config is ``--config <file>`` (the merge-build grammar, mergebuild.py)
or, without it, the copy on the default branch of the repository ``--repo``/``REPO`` names, read
exactly as merge reads it; with neither, exit 2. When a repository is named, the checkout must have
a remote naming it, as merge's clone must; with ``--config`` alone any checkout serves. It must be a
FULL clone (neither shallow nor partial), checked before any diff: rename detection in a partial
clone would fetch the blobs it lacks. As in merge, a side that changed nothing is ``no build``
before any config is read.

THE TWO SIDES stand in for merge's drift read: ``git diff --name-status -M`` from the two
revisions' merge base to the head (the PR's side) and to the base (the base's advance), each with
the old names of renames, and every rename mapped both ways, as drift.py maps GitHub's compare.
What differs from merge: git's own rename detection (default similarity) pairs files, where merge
takes GitHub's pairing, which may differ on a near-threshold rename; and nothing here is UNKNOWN --
a diff that fails is exit 3, never an empty side.

Exit: what merge's build step would make of the pair. 0 the merge would proceed (PASSED, or a ``no
build`` line saying why); 1 refused (the build failed, or the two do not merge cleanly); 2 usage,
the config, the checkout or a revision; 3 could not run; 4 the build's timeout passed.
"""

import os

from ludics import cli
from ludics.prreview.core import GhSession, die, fail
from ludics.prreview.drift import Drift
from ludics.prreview.gate import load_gate_config
from ludics.prreview.mergebuild import (
    CONFIG_FILE,
    BuildConfig,
    build_reason,
    clone_of,
    dry_build,
    first_line,
    parse_config,
    read_config,
    run_git,
)

USAGE = "usage: merge-build --base <rev> --head <rev> [--config <file>] [-C <dir>]"


def local_sides(root: str, merge_base: str, side: str) -> tuple[list[str], dict[str, list[str]]] | None:
    """The paths ``side`` changed since ``merge_base`` (old names of renames included) and its
    renames, each name mapped to the other; None when git could not say."""
    done = run_git(["diff", "-z", "--no-ext-diff", "--no-textconv", "--name-status", "-M", merge_base, side, "--"], root)
    if done.rc != 0:
        return None
    fields = done.stdout.split("\0")
    if fields and fields[-1] == "":
        fields.pop()
    paths: set[str] = set()
    renamed: dict[str, list[str]] = {}
    i = 0
    while i < len(fields):
        status = fields[i]
        if status[:1] in ("R", "C"):
            if i + 2 >= len(fields):
                return None
            old, new = fields[i + 1], fields[i + 2]
            paths.update((old, new))
            if status[:1] == "R":
                renamed.setdefault(new, []).append(old)
                renamed.setdefault(old, []).append(new)
            i += 3
        elif status and i + 1 < len(fields):
            paths.add(fields[i + 1])
            i += 2
        else:
            return None
    return sorted(paths), renamed


def local_drift(root: str, base: str, head: str, merge_base: str, base_ref: str) -> Drift:
    """The drift read's ``Drift`` for ``base`` and ``head`` from git alone (THE TWO SIDES)."""
    mine = local_sides(root, merge_base, head)
    theirs = local_sides(root, merge_base, base)
    if mine is None or theirs is None:
        fail(3, f"merge-build: git could not list the paths each side changed since {merge_base[:8]} in {root}.")
    renamed: dict[str, list[str]] = {}
    for side in (mine[1], theirs[1]):
        for name, others in side.items():
            renamed.setdefault(name, []).extend(others)
    overlap = sorted(set(mine[0]) & set(theirs[0]))
    return Drift(0, base_ref, head, base, overlap, renamed, mine[0], theirs[0])


def _take(rest: list[str], flag: str) -> tuple[str, list[str]]:
    if len(rest) < 2 or not rest[1]:
        die(f"merge-build: {flag} needs a value; {USAGE}")
    return rest[1], rest[2:]


def run(session: GhSession, args: list[str]) -> int:
    base_arg = head_arg = config_file = checkout = None
    rest = list(args)
    while rest:
        arg = rest[0]
        if arg == "--base":
            base_arg, rest = _take(rest, arg)
        elif arg == "--head":
            head_arg, rest = _take(rest, arg)
        elif arg == "--config":
            config_file, rest = _take(rest, arg)
        elif arg == "-C":
            checkout, rest = _take(rest, arg)
        elif arg.startswith(("--base=", "--head=", "--config=")):
            flag, _, value = arg.partition("=")
            if not value:
                die(f"merge-build: {flag} needs a value; {USAGE}")
            if flag == "--base":
                base_arg = value
            elif flag == "--head":
                head_arg = value
            else:
                config_file = value
            rest = rest[1:]
        else:
            die(f"merge-build: unknown argument '{arg}'; {USAGE}")
    if base_arg is None or head_arg is None:
        die(f"merge-build: --base and --head are both required; {USAGE}")
    repo = session.config.repo
    if config_file is None and not repo:
        die(
            "merge-build: no config to judge the pair by. Pass --config <file>, or name the repository",
            f"(--repo owner/name or REPO=) whose default branch's {CONFIG_FILE} merge would read.",
        )
    where = checkout if checkout is not None else os.getcwd()
    root, remote = clone_of(repo, where)
    if root is None:
        die(f"merge-build: {where} is not a directory inside a git checkout; run it in one, or pass -C <dir>.")
    if repo and remote is None:
        die(
            f"merge-build: the checkout {root} has no remote naming {repo}, so it is not the clone merge would",
            "build in. Run it in a clone of that repository (or pass --config and no repository).",
        )
    # A full clone first, as the build needs one: before any diff, since rename detection in a
    # partial clone would fetch the blobs it lacks -- a network call this run never makes.
    shallow = run_git(["rev-parse", "--is-shallow-repository"], root)
    partial = run_git(["config", "--get-regexp", r"^(extensions\.partialclone|remote\..*\.promisor)$"], root)
    if shallow.stdout.strip() != "false" or partial.stdout.strip():
        die(
            f"merge-build: {root} is a shallow or partial clone (or its depth could not be read), and the",
            "merge build needs a full one, holding the merge base and every object. Run it in a full clone.",
        )
    shas: list[str] = []
    for flag, rev in (("--base", base_arg), ("--head", head_arg)):
        done = run_git(["rev-parse", "--verify", "--quiet", "--end-of-options", f"{rev}^{{commit}}"], root)
        sha = done.stdout.strip()
        if done.rc != 0 or not sha:
            die(f"merge-build: {flag} {rev} is not a commit in {root}; fetch it first.")
        shas.append(sha)
    base, head = shas
    found = run_git(["merge-base", base, head], root)
    merge_base = found.stdout.strip()
    if found.rc != 0 or not merge_base:
        die(f"merge-build: {base[:8]} and {head[:8]} have no merge base in {root} ({first_line(found)}).")
    drift = local_drift(root, base, head, merge_base, base_arg)
    assert drift.pr_paths is not None and drift.base_paths is not None
    label = f"{head[:8]} into {base_arg} (dry run)"
    cli.say(
        f"merge build {label}: base {base_arg} = {base}, head {head_arg} = {head}, merge base {merge_base[:8]};"
        f" the head changed {len(drift.pr_paths)} path(s), the base {len(drift.base_paths)}, both {len(drift.overlap or [])}"
    )
    if not (drift.pr_paths and drift.base_paths):
        # As merge: a side that changed nothing builds under no trigger, and no config is read.
        side = "the head" if not drift.pr_paths else "the base"
        cli.say(f"merge build {label}: no build — {side} changed no path since their merge base")
        return 0
    if os.name == "nt":
        fail(2, "merge-build: the merge build runs on POSIX hosts only (the fleet's macOS and Linux boxes).")
    config: BuildConfig | None
    if config_file is not None:
        try:
            with open(config_file, encoding="utf-8", errors="surrogateescape") as handle:
                text = handle.read()
        except OSError as exc:
            die(f"merge-build: --config {config_file} could not be read ({exc.strerror}).")
        config = parse_config(text, config_file)
        if config is None:
            die(f"merge-build: {config_file} is not a merge-build config (above).")
        source = config_file
    else:
        config = read_config(session, repo, load_gate_config(os.environ).limits.contents_dir_cap, stop="merge-build")
        if config is None:
            cli.say(f"merge build {label}: no build — {repo}'s default branch has no {CONFIG_FILE}")
            return 0
        source = f"{repo}'s default branch's {CONFIG_FILE}"
    why, why_not = build_reason(drift, config)
    if why is None:
        cli.say(f"merge build {label}: no build — {why_not} ({source})")
        return 0
    dry_build(repo, head, base_arg, base, config, f"{why} ({source})", root)
    return 0
