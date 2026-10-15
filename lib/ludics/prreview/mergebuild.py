"""``merge``'s build of the would-be merge commit (ludics-lite#611): when the base has moved since
the head's CI run AND a path both sides changed is a build input, build the PR merged with the
current base locally, before the merge call, and refuse the merge when that build fails.

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
    timeout <seconds>          at most one, 1 to 86400 (default 1200): the build's bound

BUILD INPUTS -- the boundary. A path is a build input when one ``input`` glob matches the WHOLE
repository-relative path (``/``-separated) under Python's ``fnmatch.fnmatchcase``: case-sensitive,
and ``*``, ``?`` and ``[...]`` match ``/`` too, so ``*.ml`` matches an ``.ml`` file at any depth,
``dune`` only the root ``dune``, and ``*/dune`` every nested one. Nothing else counts: no path is a
build input by its contents, by being generated, or by a default list.

WHEN IT BUILDS. Only when the merge's own base-drift read (drift.py) leaves a build possible: the
intersection of the paths the PR changed and the paths the base's advance changed since their merge
base (old names of renames included) holds a build input -- or that intersection is UNKNOWN (a
compare call that did not answer, GitHub's 300-file cap), which is never "none" and so builds. An
empty intersection means the base has not moved since the PR's merge base on any path the PR
touched, and then the config is not even read. "The base moved since the head's CI run" is read as
"the base's tip is not in the head's history", the drift read's own anchor: a ``pull_request`` run
that already built the merge with this very tip makes the build redundant, never wrong. A semantic
conflict across paths only ONE side changed (the PR uses a name the base renamed in another file) is
outside this boundary, and stays the integration loop's to catch on the merged tip.

HOW IT BUILDS. From a local clone of the repository: the git checkout the merge runs in, whose
remote (``origin`` first) has a URL ending in the repository's ``owner/name`` (``.git`` optional,
case ignored), so an SSH host alias serves as well as github.com. No such clone is exit 2, and so
is a SHALLOW clone, which may lack the merge base (run from a full clone, or ``git fetch
--unshallow``). The clone fetches ``refs/pull/<n>/head`` and the base branch as OBJECTS only -- no
destination ref, ``--refmap=`` (no remote-tracking ref moves), no FETCH_HEAD -- and must then hold
the gated head (else exit 5: a push moved it) and the base tip the drift read (else exit 3). Then
everything happens in a scratch directory: a repository of its own (``git init --template=``)
that borrows the clone's objects through ``objects/info/alternates``, read only, and has its own
config, refs, index and no hooks -- so the clone's sparse-checkout, hooks and worktree list are not
the build's, and nothing is registered in the clone. There the merge commit is made (``git
merge-tree --write-tree``, ``commit-tree``; a textual conflict is exit 1) and checked out in full,
and the command runs at its root, its output to a log beside it, inside this box's run-time slot
when it has slots (``fleet-worker.sh execution slot --probe`` answers the PROBE line; ``--cpu``,
waiting up to 30 min for a slot and 30 min for a measurement, under ``--deadline`` = the timeout)
and bare otherwise, bounded either way. The scratch directory is the whole of the build's state:
it is removed whatever the outcome, and one a SIGKILLed merge leaves is in pr-review's swept
temporary family (``pr-review-build.<pid>.*``). What the clone keeps is the fetched objects, which
nothing names, as after any fetch.

TRUST. The command is the repository's own configuration, read from its default branch: it is
trusted as a developer's build is, and the scratch repository is a place to build, not a sandbox.
A git write the command makes lands in the scratch repository; anything else it does (a write
outside its tree, a network call, a process it detaches with ``setsid``) is the command's
business, as it would be from a developer's shell.

VERDICTS. Passed: the merge proceeds. Failed (any nonzero status): exit 1, refused, with the build
output (its first and last lines when long, each line and each end bounded in bytes). Not finished
within the bound: exit 4. Could not run (the slot refused, a fetch or git step failed): exit 3.
After the command ends, however it ends, its process group is ended too, so a process it left
behind does not outlive the merge; interrupted (Ctrl-C, SIGTERM, SIGHUP), the group is ended
before the scratch goes, and the command exits 128+n. The build judges the base tip the drift read;
a base that moves again between the build and the merge call is not rebuilt (that, again, is the
integration loop's). No flag waives a failed build.
"""

import fnmatch
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import assert_never

from ludics import cli, proc
from ludics.prreview.core import GhFailed, GhOk, GhSession, GhUnanswered, fail, warn
from ludics.prreview.drift import Drift
from ludics.prreview.gate import github_file_absent

CONFIG_LEAF = "ship-pr-merge-build"
CONFIG_FILE = f".github/{CONFIG_LEAF}"
DEFAULT_TIMEOUT = 1200
MAX_TIMEOUT = 86400  # a day: a larger `timeout` is a config error, refused before anything is built
SLOT_WAIT = 1800  # seconds a slot is waited for, and (separately) a measurement holding the box
FETCH_TIMEOUT = 600
GIT_TIMEOUT = 300
PROBE_TIMEOUT = 60
SHOWN_HEAD = 100  # a long build log is shown as its first and last lines
SHOWN_TAIL = 100
SHOWN_BYTES = 64 * 1024  # at most this much is read from each end of a long log
LINE_CHARS = 1000  # a longer line is shown cut

_LINE = re.compile(r"([a-z]+)(?:[ \t]+(.*))?")
_SHA = re.compile(r"[0-9a-f]{40}([0-9a-f]{24})?")
# Run by `sh -c`: the command, its output to the log, and its status to a file -- the status file is
# what tells the command's own failure from the slot wrapper's refusal or deadline.
_WRAPPER = 'sh -c "$1" >"$2" 2>&1 </dev/null; rc=$?; printf "%s\\n" "$rc" >"$3"; exit "$rc"'


@dataclass(frozen=True)
class BuildConfig:
    command: str
    inputs: tuple[str, ...]
    timeout: int = DEFAULT_TIMEOUT


def parse_config(text: str, where: str) -> BuildConfig | None:
    """The config's lines (the module docstring's grammar), or None -- having said why -- for a
    file that is not one."""
    command: str | None = None
    inputs: list[str] = []
    timeout: int | None = None
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
        elif key == "timeout" and value:
            if timeout is not None:
                warn(f"{where} names a second timeout line: {line}")
                return None
            # The length first: a few thousand digits is a ValueError in int() itself.
            if not value.isascii() or not value.isdigit() or len(value) > 6 or not 1 <= int(value) <= MAX_TIMEOUT:
                warn(f"{where}'s timeout is not a whole number of seconds from 1 to {MAX_TIMEOUT}: {line}")
                return None
            timeout = int(value)
        else:
            warn(
                f"{where} holds a line that is none of `command <shell command>`, `input <glob>`,",
                f"`timeout <seconds>`, a # comment or a blank line: {line}",
            )
            return None
    if command is None or not inputs:
        warn(f"{where} needs one `command` line and at least one `input` line; it has", f"{'a' if command else 'no'} command and {len(inputs)} input(s).")
        return None
    return BuildConfig(command, tuple(inputs), DEFAULT_TIMEOUT if timeout is None else timeout)


def build_inputs(paths: list[str], globs: tuple[str, ...]) -> list[str]:
    """The paths one glob matches whole (the module docstring's boundary)."""
    return [p for p in paths if any(fnmatch.fnmatchcase(p, g) for g in globs)]


def read_config(session: GhSession, repo: str, cap: int) -> BuildConfig | None:
    """The repository's config from its default branch, None when it has none; refuses (2 or 3)
    as ``advisory_policy`` does for the advisory list."""
    where = f"{repo}'s {CONFIG_FILE}"
    result = session.retry(
        "read", ["api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{CONFIG_FILE}"]
    )
    match result:
        case GhOk(stdout=body):
            parsed = parse_config(body, where)
            if parsed is None:
                fail(2, f"NOT merging: {where} is not a merge-build config (above); fix the file on the default branch.")
            return parsed
        case GhFailed():
            if "HTTP 404" in session.err_line():
                absent = github_file_absent(session, repo, CONFIG_LEAF, cap)
                if absent == 0:
                    return None
                if absent == 3:
                    fail(
                        3,
                        f"NOT merging: {where} read as 404, and the listing that would establish its absence",
                        f"did not answer ({session.err_line()}). Whether the merge needs a build is UNKNOWN. Retry.",
                    )
                fail(
                    2,
                    f"NOT merging: {where} read as 404, and its absence could not be established from the",
                    "directory listing (a 404 is also how GitHub answers a token without Contents access to a",
                    "private repository). Give the token Contents read access.",
                )
            fail(
                2,
                f"NOT merging: could not read {where} on its default branch ({session.err_line()});",
                "the API refused the read, so whether the merge needs a build is unknown.",
            )
        case GhUnanswered():
            fail(
                3,
                f"NOT merging: could not read {where} on its default branch ({session.err_line()}).",
                "Whether the merge needs a build is UNKNOWN. Retry.",
            )
        case _:
            assert_never(result)


def _git(args: list[str], cwd: str, *, timeout: float = GIT_TIMEOUT, env: dict[str, str] | None = None) -> proc.Completed:
    return proc.run_tool("git", args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, timeout=timeout)


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


def find_clone(repo: str, cwd: str, hooks: str) -> tuple[str, str]:
    """The checkout ``cwd`` is in and its remote naming ``repo``; exit 2 when there is none."""
    top = _git(["rev-parse", "--show-toplevel"], cwd)
    if top.rc != 0 or not top.stdout.strip():
        fail(
            2,
            f"NOT merging: {repo}'s {CONFIG_FILE} asks for a build of the merge commit, and this merge",
            f"does not run inside a git checkout ({cwd}). Run merge from a clone of {repo}.",
        )
    root = top.stdout.strip()
    listed = _git(["-c", f"core.hooksPath={hooks}", "config", "--get-regexp", r"^remote\..*\.url$"], root)
    remotes: list[str] = []
    for line in listed.stdout.splitlines():
        key, _, url = line.partition(" ")
        name = key[len("remote.") : -len(".url")]
        if name and _remote_matches(url, repo):
            remotes.append(name)
    if not remotes:
        fail(
            2,
            f"NOT merging: {repo}'s {CONFIG_FILE} asks for a build of the merge commit, and the checkout",
            f"this merge runs in ({root}) has no remote naming {repo}. Run merge from a clone of it.",
        )
    return root, ("origin" if "origin" in remotes else sorted(remotes)[0])


def _slot_runner() -> str | None:
    """fleet-worker.sh beside this package, when this box has run-time slots (its probe answers the
    PROBE line); None to run bare (issue-wave/references/executions.md: any other answer)."""
    here = Path(__file__).resolve().parents[3] / "issue-wave" / "scripts" / "fleet-worker.sh"
    if not here.is_file():
        return None
    probe = proc.run_tool("bash", [str(here), "execution", "slot", "--probe"], stdin=subprocess.DEVNULL, timeout=PROBE_TIMEOUT)
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


def _end_group(child: subprocess.Popen[bytes]) -> None:
    """End the build's process group, and wait for its leader: SIGTERM first (an `execution slot`
    wrapper ends its own command's group on it), SIGKILL to what is left five seconds later. Run
    after a build that ENDED too, since a command may leave a process running behind it (`cmd &`):
    the group outlives its leader. Under Windows, the leader's process tree."""
    if os.name == "nt":
        if child.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(child.pid)], stdin=subprocess.DEVNULL, capture_output=True, check=False)
            child.kill()
    else:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                break
            gone = False
            deadline = time.monotonic() + 5
            while not gone and time.monotonic() < deadline:
                child.poll()
                try:
                    os.killpg(child.pid, 0)
                    time.sleep(0.05)
                except ProcessLookupError:
                    gone = True
            if gone:
                break
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _run_build(argv: list[str], cwd: str, bound: float) -> proc.Completed:
    """The wrapped build in a process group of its own, under ``bound`` (124 past it, as
    ``proc.run_tool`` reports a timeout). The group is ended however the wait for it ends -- the
    build's own exit (a process it left behind), the bound, an exception, Ctrl-C, or a SIGTERM or
    SIGHUP to merge, which end the command (exit 128+n) only after the build is stopped and its
    scratch removed -- so nothing in the group outlives the merge that started it. A process
    that leaves the group (``setsid``, a daemon) is outside this boundary, as it is for
    ``execution slot`` (fleetworker/group.py)."""
    prefix = proc.command_argv(argv[0])
    if prefix is None:
        return proc.Completed(127, "", f"{argv[0]}: command not found\n")
    full = [*prefix, *argv[1:]]
    posix = os.name != "nt"
    child = subprocess.Popen(
        full if posix else proc.windows_command_line(full),
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=posix,
    )

    def interrupted(signum: int, _frame: object) -> None:
        raise cli.Exit(128 + signum, f"the merge build was interrupted by signal {signum}; it was stopped, nothing merged")

    previous: dict[int, object] = {}
    if posix:
        for sig in (signal.SIGTERM, signal.SIGHUP):
            previous[sig] = signal.signal(sig, interrupted)
    try:
        try:
            out, _ = child.communicate(timeout=bound)
        except subprocess.TimeoutExpired:
            _end_group(child)
            try:
                out, _ = child.communicate(timeout=5)
            except (subprocess.TimeoutExpired, ValueError):
                out = b""
            return proc.Completed(124, proc.decode(out), f"no answer in {bound:g}s\n")
        except BaseException:
            _end_group(child)
            raise
        _end_group(child)
        return proc.Completed(child.returncode, proc.decode(out), "")
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)  # pyright: ignore[reportArgumentType]


def _posix(path: str) -> str:
    """A path as the ``sh`` the wrapper runs under reads it: forward slashes (Git Bash's sh takes
    ``C:/...``, not ``C:\\...``)."""
    return path.replace("\\", "/")


def merge_build(session: GhSession, repo: str, pr: str, gated: str, drift: Drift, cap: int) -> None:
    """Build the would-be merge commit when the config and the drift read ask for it (the module
    docstring); return to merge, or end the command with its refusal."""
    if drift.overlap is not None and not drift.overlap:
        return  # nothing both sides changed: no build is possible, and the config is not read
    config = read_config(session, repo, cap)
    if config is None:
        return
    if drift.overlap is None:
        why = "the paths both sides changed are UNKNOWN (above), which is never none"
    else:
        inputs = build_inputs(drift.overlap, config.inputs)
        if not inputs:
            cli.say(
                f"merge build {repo}#{pr}: no build — none of the {len(drift.overlap)} path(s) changed on both sides"
                f" is a build input ({' '.join(config.inputs)})"
            )
            return
        why = f"{len(inputs)} build input(s) changed on both sides: {' '.join(inputs)}"
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
    _build(repo, pr, gated, drift.base_ref, drift.base_sha, config, why)


def _build(repo: str, pr: str, gated: str, base_ref: str, tip: str, config: BuildConfig, why: str) -> None:
    # pr-review's own temporary family, keyed by the owning pid, so a SIGKILLed merge's leftover
    # (a whole build tree, and the repository it is in) is swept by the next `watch`
    # (watch.tmp_sweep_stale): nothing of the build lives anywhere else.
    scratch = os.path.realpath(tempfile.mkdtemp(prefix=f"pr-review-build.{proc.own_pid()}."))
    hooks = os.path.join(scratch, "no-hooks")
    os.mkdir(hooks)
    tree = os.path.join(scratch, "tree")
    quiet = ["-c", f"core.hooksPath={hooks}"]
    try:
        root, remote = find_clone(repo, os.getcwd(), hooks)
        shallow = _git([*quiet, "rev-parse", "--is-shallow-repository"], root)
        if shallow.stdout.strip() != "false":
            fail(
                2,
                f"NOT merging {repo}#{pr}: {why}, and the clone this merge runs in ({root}) is shallow",
                f"(or its depth could not be read: {_first_line(shallow)}): the merge build needs the merge base.",
                "Run merge from a full clone, or `git fetch --unshallow` this one first.",
            )
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
                f"NOT merging {repo}#{pr}: {why}, and fetching its head and {base_ref} from {remote} in",
                f"{root} failed ({_first_line(fetched)}), so the merge commit was not built. Retry.",
            )
        for sha, what in ((gated, "its gated head"), (tip, f"{base_ref}'s tip as the drift read it")):
            if _git([*quiet, "cat-file", "-e", f"{sha}^{{commit}}"], root).rc != 0:
                fail(
                    5 if sha == gated else 3,
                    f"NOT merging {repo}#{pr}: {what}, {sha[:8]}, is not on {remote} after the fetch",
                    "(a push or a force-push moved it); re-run merge to read it again.",
                )
        common = _git([*quiet, "rev-parse", "--path-format=absolute", "--git-common-dir"], root).stdout.strip()
        objects = os.path.join(common, "objects")
        if not common or not os.path.isdir(objects):
            fail(3, f"NOT merging {repo}#{pr}: the object store of {root} could not be found ({common or 'no answer'}).")
        # The build's own repository: it borrows the clone's objects (alternates, read only) and
        # has its own config, refs and index, so the clone's sparse-checkout, hooks and refs are
        # not the build's, and a git write the build makes lands here and goes with the scratch.
        made = _git(["init", "--quiet", "--template=", tree], scratch)
        if made.rc != 0:
            fail(3, f"NOT merging {repo}#{pr}: the build's repository could not be made ({_first_line(made)}).")
        info = os.path.join(tree, ".git", "objects", "info")
        os.makedirs(info, exist_ok=True)
        with open(os.path.join(info, "alternates"), "w", encoding="utf-8") as handle:
            handle.write(objects + "\n")
        merged = _git([*quiet, "merge-tree", "--write-tree", "--no-messages", tip, gated], tree)
        if merged.rc == 1:
            fail(
                1,
                f"NOT merging {repo}#{pr}: {gated[:8]} does not merge cleanly with {base_ref} at {tip[:8]}:",
                f"merge or rebase {base_ref} in, resolve, push, then merge again.",
            )
        written = merged.stdout.split("\n", 1)[0].strip()
        if merged.rc != 0 or not _SHA.fullmatch(written):
            fail(
                3,
                f"NOT merging {repo}#{pr}: {why}, and git could not compute the merge of {gated[:8]} into",
                f"{base_ref} at {tip[:8]} ({_first_line(merged)}; `git merge-tree --write-tree` needs git >= 2.38).",
            )
        ident = dict(os.environ)
        for role in ("AUTHOR", "COMMITTER"):
            ident[f"GIT_{role}_NAME"] = "ship-pr merge build"
            ident[f"GIT_{role}_EMAIL"] = "ship-pr@localhost"
        commit = _git(
            [*quiet, "commit-tree", written, "-p", tip, "-p", gated, "-m", f"ship-pr merge build of {repo}#{pr}"],
            tree,
            env=ident,
        )
        merge_sha = commit.stdout.strip()
        if commit.rc != 0 or not _SHA.fullmatch(merge_sha):
            fail(3, f"NOT merging {repo}#{pr}: the merge commit could not be written ({_first_line(commit)}).")
        out = _git([*quiet, "-c", "core.sparseCheckout=false", "checkout", "--quiet", "--detach", merge_sha], tree)
        if out.rc != 0:
            fail(3, f"NOT merging {repo}#{pr}: the merge commit could not be checked out ({_first_line(out)}).")
        head = gated
        runner = _slot_runner()
        where = "in a run-time slot" if runner else "bare (this box has no run-time slots)"
        cli.say(
            f"merge build {repo}#{pr}: {why}; building {head[:8]} merged with {base_ref} at {tip[:8]}"
            f" ({merge_sha[:8]}) {where}, bound {config.timeout}s: {config.command}"
        )
        log = os.path.join(scratch, "build.log")
        status = os.path.join(scratch, "build.status")
        wrapped = ["sh", "-c", _WRAPPER, "merge-build", config.command, _posix(log), _posix(status)]
        bound = float(config.timeout)
        if runner:
            wrapped = ["bash", runner, "execution", "slot", "--cpu", "--wait", str(SLOT_WAIT),
                       f"--wait-window={SLOT_WAIT}", "--deadline", str(config.timeout), "--", *wrapped]
            bound += 2 * SLOT_WAIT + 120
        started = time.monotonic()
        done = _run_build(wrapped, tree, bound)
        took = int(time.monotonic() - started)
        try:
            with open(status, encoding="utf-8") as handle:
                rc_text = handle.read().strip()
        except OSError:
            rc_text = ""
        if rc_text == "0":
            cli.say(f"merge build {repo}#{pr}: PASSED in {took}s ({config.command})")
            return
        if rc_text:
            cli.say(f"merge build {repo}#{pr}: FAILED (exit {rc_text}) after {took}s; its output:")
            for line in _shown(log):
                cli.say(f"  | {line}")
            fail(
                1,
                f"REFUSING to merge {repo}#{pr}: {head[:8]} merged with {base_ref} at {tip[:8]} does not build",
                f"({config.command}: exit {rc_text}, output above), though each side is green on its own. Merge",
                f"{base_ref} in, fix the clash, push, and merge again.",
            )
        for line in (done.stdout + done.stderr).splitlines():
            cli.say(f"  | {line}")
        if done.rc == 124:
            fail(
                4,
                f"NOT merging {repo}#{pr}: the build of its merge commit did not finish within",
                f"{config.timeout}s ({CONFIG_FILE}'s timeout); no verdict. Re-run merge, or raise the timeout.",
            )
        fail(
            3,
            f"NOT merging {repo}#{pr}: the build of its merge commit could not run (the wrapper exited",
            f"{done.rc} before the command did, output above). Retry.",
        )
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
