"""``fleet-worker.sh sibling-scan``: run a new scan on every open sibling PR's head merged with the
scan's branch (lukstafi/ludics#1041, #1034).

A merge that adds a scan (a scanner, a lint, a text guard) can turn master red under a sibling that
was green on its own base: lukstafi/ocannl-staging#1611 added a compare, #1614 the scan refusing it,
and master was red until #1626. issue-wave SKILL.md, *Gate later waves*, has the scan-adding worker
check every open sibling first. Workers did it by hand (gh-ocannl-2122's sibling-scan.sh), and the
hand procedure kept meeting corners (#1025: a sibling's branch deleted on merge mid-loop). This is
that procedure as a verb.

BOUNDARY, a fail-closed allowlist. What is read: the open-PR selection ``prs`` makes
(``supervision.open_prs``: every open PR, or with --wave the wave's, under its own boundaries), each
selected PR's head fetched from the remote by its PR ref ``refs/pull/<N>/head`` -- never its branch
name, which a merge deletes -- and the scan command's exit status. What runs: in ONE scratch
worktree of the caller's repository, detached, reused head after head so a project's build cache
stays warm, each head checked out, the scan revision merged into it (the cherry-pick of the scan
branch's own changes -- its tree against its fork point from --base, squashed into one commit --
when the merge conflicts), and the scan command, argv as given, in that worktree. The scan's own
PR -- its head branch is --branch, in the listed repository itself (``isCrossRepository`` exactly
false: a fork's branch of the same name is a sibling) -- is skipped by name, and said. What a head comes to, each on its line: CLEAN (the scan exited 0), HIT (it exited non-zero:
the head and the scan branch cannot land in either order without the hit), or UNCHECKED -- a
conflict the cherry-pick could not get past either, or no base to cherry-pick from. A failed fetch,
a fetched ref that names no commit, and a scratch worktree git cannot reset or check out STOP the
check with git's error: every head after it is said NOT CHECKED, never skipped. Nothing reads the
scan's output beyond keeping it in a log per head (a hit's last lines are shown); the project's
scan decides what a hit is. Not done: pushing, commenting on a sibling, deleting a branch, touching
the caller's own worktree (only ``git worktree add`` and the scratch worktree's own state change),
and reusing a directory sibling-scan did not create (its git dir carries MARKER).

Exit: 0 every selected head was checked and none hit | 1 every one was checked and some hit |
4 some head was not checked, or the selection itself is incomplete (a read did not answer or was
refused, the list reached its cap) -- the hits found are printed either way | 2 usage. An unchecked
head is never reported as clean: exit 0 means every head the selection named was scanned.
"""

import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field

from ludics import cli, proc
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.supervision import open_prs

USAGE = ("sibling-scan <owner/repo> [--wave <id>] [--branch <scan branch>] [--remote <name>] [--base <rev>]"
         " [--worktree <dir>] [--logs <dir>] -- <scan command> [arg...]")
LABEL = "SIBLING-SCAN"
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
POSITIVE = re.compile(r"[1-9][0-9]*")
MARKER = "ludics-sibling-scan"
TAIL = 10
FETCH_TIMEOUT = 900
# Commits made in the scratch worktree carry no one's identity, sign nothing and run no hook of the
# project's: the merge exists only to be scanned.
GIT_SCRATCH = ["-c", "user.name=sibling-scan", "-c", "user.email=sibling-scan@invalid", "-c", "commit.gpgsign=false",
               "-c", f"core.hooksPath={os.devnull}", "-c", "advice.detachedHead=false"]  # fmt: skip


@dataclass
class Options:
    repo: str = ""
    wave: str = ""
    branch: str = ""
    remote: str = "origin"
    base: str = ""
    worktree: str = ""
    logs: str = ""
    command: list[str] = field(default_factory=lambda: [])


def parse_args(args: Sequence[str]) -> Options:
    opts = Options()
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            opts.command = list(args[i + 1:])
            break
        if arg in ("--wave", "--branch", "--remote", "--base", "--worktree", "--logs"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"sibling-scan: expected value for {arg}")
            setattr(opts, arg[2:], args[i + 1])
            i += 2
            continue
        if arg.startswith("-"):
            die(USAGE)
        if opts.repo:
            die("sibling-scan: one <owner/repo>")
        opts.repo = arg
        i += 1
    if not REPO.fullmatch(opts.repo):
        die("sibling-scan: <owner/repo> required;", USAGE)
    if not opts.command:
        die("sibling-scan: the scan command goes after --;", USAGE)
    return opts


def git(args: Sequence[str], cwd: str, env: dict[str, str], timeout: float | None = None) -> proc.Completed:
    return proc.run_tool("git", list(args), cwd=cwd, env=env, stdin=subprocess.DEVNULL, timeout=timeout)


def out_of(done: proc.Completed) -> str:
    return done.stdout.strip()


def why(done: proc.Completed) -> str:
    """git's own error, on one line: its stderr's last non-empty lines, or its status."""
    lines = [line.strip() for line in done.stderr.splitlines() if line.strip()]
    return " / ".join(lines[-3:]) if lines else f"git exited {done.rc}"


def commit_of(rev: str, cwd: str, env: dict[str, str]) -> str:
    done = git(["rev-parse", "-q", "--verify", f"{rev}^{{commit}}"], cwd, env)
    return out_of(done) if done.rc == 0 else ""


def tree_of(rev: str, cwd: str, env: dict[str, str]) -> str:
    done = git(["rev-parse", "-q", "--verify", f"{rev}^{{tree}}"], cwd, env)
    return out_of(done) if done.rc == 0 else ""


def absolute_git_path(what: str, cwd: str, env: dict[str, str]) -> str:
    done = git(["rev-parse", "--path-format=absolute", what], cwd, env)
    return os.path.realpath(out_of(done)) if done.rc == 0 and out_of(done) else ""


def conflicted(cwd: str, env: dict[str, str]) -> list[str]:
    done = git(["diff", "--name-only", "--diff-filter=U", "-z"], cwd, env)
    return [p for p in done.stdout.split("\0") if p] if done.rc == 0 else []


@dataclass(frozen=True)
class Scratch:
    worktree: str
    remove: str  # the temporary directory to remove at the end, or "" for a kept --worktree


def scratch_worktree(opts: Options, here: str, common: str, scan: str, env: dict[str, str], top: str) -> Scratch | str:
    """The worktree the heads are checked out in, or the refusal. A --worktree that exists is
    reused only when sibling-scan made it (MARKER in its git dir) for this repository; one that
    does not exist is made and kept. Without --worktree, one is made under ``top`` and removed."""
    target = opts.worktree or os.path.join(top, "worktree")
    if os.path.lexists(target):
        if not os.path.isdir(target):
            return f"--worktree {target} exists and is not a directory"
        if os.path.realpath(absolute_git_path("--show-toplevel", target, env) or "/nonexistent") != os.path.realpath(target):
            return f"--worktree {target} exists and is not the top of a git worktree"
        if absolute_git_path("--git-common-dir", target, env) != common:
            return f"--worktree {target} is a worktree of another repository"
        gitdir = absolute_git_path("--git-dir", target, env)
        if not os.path.isfile(os.path.join(gitdir, MARKER)):
            return (f"--worktree {target} was not made by sibling-scan (no {MARKER} in its git dir), and"
                    " a reused worktree is reset hard and cleaned: name a path that does not exist yet")
        return Scratch(os.path.realpath(target), "")
    made = git(["worktree", "add", "--detach", "-q", target, scan], here, env)
    if made.rc != 0:
        return f"git worktree add {target} failed: {why(made)}"
    gitdir = absolute_git_path("--git-dir", target, env)
    try:
        with open(os.path.join(gitdir, MARKER), "w", encoding="utf-8") as f:
            f.write("a sibling-scan scratch worktree: reset hard and cleaned on every reuse\n")
    except OSError as exc:
        return f"could not mark {target}'s git dir {gitdir}: {exc.strerror}"
    return Scratch(os.path.realpath(target), "" if opts.worktree else top)


@dataclass(frozen=True)
class Head:
    number: str
    listed: str
    branch: str
    title: str


@dataclass
class Tally:
    clean: list[str] = field(default_factory=lambda: [])
    hit: list[str] = field(default_factory=lambda: [])
    unchecked: list[str] = field(default_factory=lambda: [])
    skipped: list[str] = field(default_factory=lambda: [])


def reset(wt: str, env: dict[str, str]) -> proc.Completed:
    """Leave no merge or pick in progress, and no tracked change: a reused worktree, or one the
    last head left mid-conflict."""
    for args in (["cherry-pick", "--quit"], ["merge", "--abort"]):
        git(args, wt, env)
    return git(["reset", "-q", "--hard"], wt, env)


def combine(wt: str, scan: str, base_sha: str, env: dict[str, str]) -> tuple[str, str]:
    """Bring the scan revision onto the checked-out head: ``("merge"|"cherry-pick", "")`` or
    ``("", <why it could not>)``."""
    merged = git([*GIT_SCRATCH, "merge", "--no-edit", "-q", scan], wt, env)
    if merged.rc == 0:
        return "merge", ""
    paths = conflicted(wt, env)
    merge_why = f"merge conflicts in {' '.join(paths)}" if paths else f"merge failed: {why(merged)}"
    git(["merge", "--abort"], wt, env)
    reset(wt, env)
    if not base_sha:
        return "", f"{merge_why}, and no --base to cherry-pick the scan branch's own changes from"
    # The scan branch's own changes are its tree against its fork point from --base, squashed into
    # one commit: a merge on the branch (a resolution that edited the scan) is in that diff, where
    # a pick of its non-merge commits would leave it out and scan with an older scanner.
    fork = git(["merge-base", base_sha, scan], wt, env)
    tree = tree_of(scan, wt, env) if fork.rc == 0 else ""
    if fork.rc != 0 or not tree or tree_of(out_of(fork), wt, env) == tree:
        return "", f"{merge_why}, and the scan branch changes nothing past --base to cherry-pick"
    squashed = git([*GIT_SCRATCH, "commit-tree", tree, "-p", out_of(fork), "-m", "sibling-scan: the scan branch past --base"],
                   wt, env)  # fmt: skip
    if squashed.rc != 0:
        return "", f"{merge_why}, and its changes past --base could not be squashed: {why(squashed)}"
    picked = git([*GIT_SCRATCH, "cherry-pick", "--keep-redundant-commits", out_of(squashed)], wt, env)
    if picked.rc == 0:
        return "cherry-pick", ""
    paths = conflicted(wt, env)
    pick_why = f"conflicts in {' '.join(paths)}" if paths else why(picked)
    git(["cherry-pick", "--abort"], wt, env)
    return "", f"{merge_why}, and the cherry-pick of its changes past --base too: {pick_why}"


def run_scan(command: list[str], wt: str, log: str, env: dict[str, str]) -> int:
    with open(log, "wb") as out:
        try:
            return subprocess.run(command, cwd=wt, env=env, stdin=subprocess.DEVNULL, stdout=out,
                                  stderr=subprocess.STDOUT, check=False).returncode
        except OSError as exc:
            out.write(f"sibling-scan: {command[0]}: {exc.strerror}\n".encode("utf-8", "surrogateescape"))
            return 127


def tail_of(log: str) -> list[str]:
    try:
        with open(log, encoding="utf-8", errors="surrogateescape") as f:
            return f.read().splitlines()[-TAIL:]
    except OSError:
        return []


def scan_heads(opts: Options, heads: list[Head], wt: str, scan: str, base_sha: str, logs: str,
               env: dict[str, str]) -> Tally:
    """Check each head in turn (see the boundary above); a stop says every head after it."""
    tally = Tally()
    name = opts.repo
    for k, head in enumerate(heads):
        pr = f"{name}#{head.number}"
        stop = ""
        prepared = reset(wt, env)
        if prepared.rc != 0:
            stop = f"{LABEL} STOPPED {pr}: the scratch worktree {wt} would not reset: {why(prepared)}"
        else:
            fetched = git(["fetch", "--no-tags", "-q", opts.remote, f"refs/pull/{head.number}/head"], wt, env,
                          timeout=FETCH_TIMEOUT)  # fmt: skip
            sha = commit_of("FETCH_HEAD", wt, env) if fetched.rc == 0 else ""
            if fetched.rc != 0:
                stop = f"{LABEL} FETCH FAILED {pr}: git fetch {opts.remote} refs/pull/{head.number}/head: {why(fetched)}"
            elif not sha:
                stop = f"{LABEL} FETCH FAILED {pr}: refs/pull/{head.number}/head names no commit"
            else:
                moved = "" if sha == head.listed else f" (listed {head.listed}: it moved since the list)"
                checked_out = git(["checkout", "-q", "-f", "--detach", sha], wt, env)
                cleaned = git(["clean", "-fdq"], wt, env) if checked_out.rc == 0 else checked_out
                if cleaned.rc != 0:
                    stop = f"{LABEL} STOPPED {pr}: the scratch worktree {wt} would not check out {sha}: {why(cleaned)}"
                else:
                    via, refusal = combine(wt, scan, base_sha, env)
                    if not via:
                        cli.say(f"{LABEL} UNCHECKED {pr} head={sha}{moved}: {refusal} -- branch {head.branch}: {head.title}")
                        tally.unchecked.append(pr)
                        continue
                    merged = commit_of("HEAD", wt, env)
                    log = os.path.join(logs, f"pr-{head.number}.log")
                    scan_env = {**env, "SIBLING_SCAN_PR": head.number, "SIBLING_SCAN_HEAD": sha,
                                "SIBLING_SCAN_MERGED": merged}  # fmt: skip
                    rc = run_scan(opts.command, wt, log, scan_env)
                    facts = f"head={sha}{moved} merged={merged} via={via} log={log}"
                    if rc == 0:
                        cli.say(f"{LABEL} CLEAN {pr} {facts}")
                        tally.clean.append(pr)
                    else:
                        cli.say(f"{LABEL} HIT {pr} exit={rc} {facts} -- branch {head.branch}: {head.title}")
                        for line in tail_of(log):
                            cli.say(f"  {line}")
                        tally.hit.append(pr)
                    continue
        cli.say(stop)
        tally.unchecked.append(pr)
        for rest in heads[k + 1:]:
            cli.say(f"{LABEL} NOT CHECKED {name}#{rest.number}: the check stopped at {pr}")
            tally.unchecked.append(f"{name}#{rest.number}")
        break
    return tally


def cmd_sibling_scan(cfg: Config, args: list[str]) -> int:
    """``sibling-scan <owner/repo> [--wave <id>] [--branch <b>] ... -- <scan command>``: see the
    module's docstring for what it reads, runs and refuses, and its exit statuses."""
    opts = parse_args(args)
    env = dict(cfg.env)
    limit = env.get("FLEET_PRS_LIMIT") or "1000"
    if not POSITIVE.fullmatch(limit):
        die("sibling-scan: FLEET_PRS_LIMIT must be a positive number of PRs")
    here = os.getcwd()
    common = absolute_git_path("--git-common-dir", here, env)
    if not common:
        die(f"sibling-scan: run it in a checkout of {opts.repo}: {here} is not in a git repository")
    if not opts.branch:
        current = git(["symbolic-ref", "-q", "--short", "HEAD"], here, env)
        if current.rc != 0 or not out_of(current):
            die("sibling-scan: HEAD is detached here: name the scan branch with --branch")
        opts.branch = out_of(current)
    scan = commit_of(f"refs/heads/{opts.branch}", here, env) or commit_of(f"refs/remotes/{opts.remote}/{opts.branch}", here, env)
    if not scan:
        die(f"sibling-scan: no branch {opts.branch} here, nor {opts.remote}/{opts.branch}")
    base = opts.base or f"refs/remotes/{opts.remote}/HEAD"
    base_sha = commit_of(base, here, env)
    if opts.base and not base_sha:
        die(f"sibling-scan: --base {opts.base} names no commit here")
    helper = os.path.join(cfg.checkout, "ship-pr", "scripts", "pr-review.sh")
    if not (os.path.isfile(helper) and os.access(helper, os.X_OK)):
        cli.say(f"{LABEL} UNCHECKED: ship-pr's pr-review.sh missing, so no PR was listed: {helper}")
        return 4
    worst, rows = open_prs(cfg, LABEL, opts.repo, opts.wave, helper, limit)
    if rows is None:
        cli.say(f"{LABEL} UNCHECKED {opts.repo}: no PR was listed, so no head was checked")
        return 4
    heads: list[Head] = []
    skipped: list[str] = []
    for row in rows:
        if row.branch == opts.branch and row.same_repo:
            cli.say(f"{LABEL} SKIPPED {opts.repo}#{row.number}: the scan branch's own PR ({row.branch})")
            skipped.append(f"{opts.repo}#{row.number}")
        else:
            heads.append(Head(row.number, row.sha, row.branch, row.title))
    if not heads:
        of_wave = f" of wave {opts.wave}" if opts.wave else ""
        cli.say(f"{LABEL} {opts.repo}: no open sibling PRs{of_wave} to check")
        return 4 if worst else 0
    top = os.path.realpath(tempfile.mkdtemp(prefix="sibling-scan."))
    logs = opts.logs or os.path.join(top, "logs")
    try:
        os.makedirs(logs, exist_ok=True)
    except OSError as exc:
        cli.say(f"{LABEL} UNCHECKED: the log directory {logs}: {exc.strerror}")
        return 4
    scratch = scratch_worktree(opts, here, common, scan, env, top)
    if isinstance(scratch, str):
        cli.say(f"{LABEL} UNCHECKED: {scratch}")
        shutil.rmtree(top, ignore_errors=True)  # nothing was logged yet
        return 4
    cli.say(f"{LABEL} {opts.repo} scan={scan} branch={opts.branch} base={base_sha or '-'} heads={len(heads)}"
            f" worktree={scratch.worktree} logs={logs}")
    try:
        tally = scan_heads(opts, heads, scratch.worktree, scan, base_sha, logs, env)
    finally:
        if scratch.remove:
            git(["worktree", "remove", "--force", scratch.worktree], here, env)
            shutil.rmtree(scratch.worktree, ignore_errors=True)
            git(["worktree", "prune"], here, env)
        if opts.logs:
            shutil.rmtree(top, ignore_errors=True)  # it held at most the removed worktree
    words = [f"{key}={','.join(prs) or '-'}" for key, prs in
             (("clean", tally.clean), ("hit", tally.hit), ("unchecked", tally.unchecked), ("skipped", skipped))]
    incomplete = bool(tally.unchecked) or worst != 0
    if worst != 0:
        words.append("selection=incomplete")
    cli.say(f"{LABEL} DONE {opts.repo} {' '.join(words)}")
    return 4 if incomplete else 1 if tally.hit else 0
