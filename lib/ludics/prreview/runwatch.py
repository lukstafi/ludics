"""``pr-review.sh retry [--read] run watch <owner/name#run-id> [-R owner/name] [-i seconds]``: a quiet
await of ONE workflow run, which is never forwarded to ``gh run watch``.

Ported from the shell's ``cmd_run_watch`` (ludics-lite#403); ``retry`` hands it everything after
``run watch``.

Why not gh's: its nonzero exit on a run that concluded FAILURE carries no HTTP status, so the retry
policy read a workflow VERDICT as transport -- four attempts re-watching a run that had already
completed, then "the API never answered" -- and in a non-TTY shell its progress redraws accumulate
(~168k tokens in one session; the 2026-08-29 wave, self-improve#8). So this polls ``gh run view`` on
the checks cadence, prints a heartbeat line on stderr instead of redraws, and ends with ONE verdict.

The run is addressed the way a PR is -- owner/name#<run-id>, through the same ``parse_ref`` -- and
the repo is NEVER inferred from the cwd (ludics-lite#74: a background shell started in another
project's worktree turned a wrong-target 404 into a FAILED-run verdict). A bare id needs -R or
REPO=; an argument repo and an -R that disagree are refused, not resolved either way. Every flag
outside the ones below is refused too: a catch-all that discarded an argument turned a mistyped repo
flag into a watch of whatever REPO named. The sleep is capped at what is left of the deadline (an
-i past it slept the await far beyond its ceiling), and the interval is at least a second (0
busy-looped the API).

Exit codes, matching ``checks``: 0 the run succeeded; 1 it concluded failure -- a VERDICT, so do not
retry the watch, read the run; 2 the invocation is wrong (no repo named, a malformed argument or
flag, or a run/repo pair the API rejects); 3 the API did not answer, so the run's state is UNKNOWN;
4 no verdict -- still running at the deadline, or stopped without being judged.
"""

import os
import re
import shlex
from collections.abc import Mapping
from typing import assert_never

from ludics import cli
from ludics.prreview import knobs
from ludics.prreview.budget import next_poll, pause
from ludics.prreview.checkruns import conclusion_class
from ludics.prreview.clock import Clock, clock_from_env
from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhSession,
    GhUnanswered,
    api_rejection,
    die,
    fail,
    parse_ref,
    warn,
)

_WHOLE = re.compile(r"[0-9]+")
_INTMAX = knobs.INTMAX
Timing = knobs.Timing


def load_timing(env: Mapping[str, str]) -> Timing:
    """CHECKS_INTERVAL, CHECKS_WAIT, CHECKS_HEARTBEAT (knobs.checks_timing)."""
    return knobs.checks_timing(env)


def _tsv_pair(line: str) -> tuple[str, str]:
    """``IFS=$'\\t' read -r status concl``: the first line, tab runs as one separator, the second
    field taking the rest."""
    first = line.split("\n", 1)[0].strip("\t")
    parts = re.split(r"\t+", first, maxsplit=1)
    return parts[0], parts[1] if len(parts) > 1 else ""


def _value(args: list[str], i: int, flag: str, what: str) -> str:
    # A flag missing its value is an invocation error, exit 2 (the shell's `${2:?}` exited 1, the
    # code this await keeps for a FAILED run, until the port pinned it).
    if i + 1 >= len(args) or not args[i + 1]:
        die(f"run watch: {flag} needs {what}")
    return args[i + 1]


def run(
    session: GhSession,
    args: list[str],
    *,
    env: Mapping[str, str] | None = None,
    clock: Clock | None = None,
) -> int:
    e = os.environ if env is None else env
    timing = load_timing(e)
    # SHIP_PR_TEST_CLOCK's file when it is named, as the shell's clock_now/clock_sleep read it.
    clk = clock_from_env(e) if clock is None else clock
    run_ref = ""
    flag_repo = ""
    interval_text = str(timing.interval)
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-R", "--repo"):
            flag_repo = _value(args, i, arg, "owner/name")
            i += 1
        elif arg.startswith(("-R=", "--repo=")):
            flag_repo = arg.split("=", 1)[1]
        elif arg in ("-i", "--interval"):
            interval_text = _value(args, i, arg, "seconds")
            i += 1
        elif arg.startswith(("-i=", "--interval=")):
            interval_text = arg.split("=", 1)[1]
        elif arg in ("--exit-status", "--compact"):
            # The two native flags whose meaning this await subsumes, accepted so a pasted
            # `gh run watch` line keeps working.
            pass
        elif arg.startswith("-"):
            die(
                f"run watch: unsupported flag '{arg}' — the quiet await takes owner/name#<run-id>,",
                "-R/--repo, -i/--interval, --exit-status, --compact",
            )
        else:
            if run_ref:
                die(f"run watch: got two run arguments ('{run_ref}' and '{arg}') —", "name exactly one")
            run_ref = arg
        i += 1
    if not run_ref:
        die(
            "retry run watch: name the run as owner/name#<run-id> — the quiet",
            "await polls `gh run view <id> --repo <owner/name>`. For a PR's checks, prefer",
            "`checks <pr> --wait`.",
        )
    ref = parse_ref(run_ref)
    if ref is None:
        die(
            "run watch: the run must be owner/name#<run-id> (or a bare run id",
            f"with -R owner/name), got '{run_ref}'",
        )
    run_id = ref.num
    if not _WHOLE.fullmatch(interval_text):
        die(f"run watch: the interval must be seconds, got '{interval_text}'")
    interval = int(interval_text)
    # `[ "$interval" -gt 0 ]` was false past bash's integer, as it is for 0.
    if not 0 < interval <= _INTMAX:
        die(f"run watch: the interval must be at least 1 second, got '{interval_text}'")
    # REPO= is a session default rather than a second target, so an argument overrides it.
    repo = ref.repo
    if repo and flag_repo and repo != flag_repo:
        die(
            f"run watch: the run names {repo} and -R/--repo names {flag_repo} — two explicit targets",
            "that disagree; name the repo once.",
        )
    repo = repo or flag_repo or session.config.repo
    if not repo:
        die(
            f"run watch: name the repo — owner/name#{run_id} (preferred), or a bare",
            "run id with -R owner/name or REPO=owner/name. A bare id alone is refused and NOT resolved",
            "from the cwd: this await is a background call by construction, a background shell does not",
            "start in the checkout, and guessing turned a wrong-target read into a FAILED run",
            "(ludics-lite#74).",
        )
    started = clk.now()
    deadline = started + timing.wait
    beat = started
    # An observer of the run, which may wait a quota hold out within its ceiling. A repository named
    # as HOST/OWNER/REPO (gh run view's -R form) names its host, which GH_HOST then does not.
    budget = session.budget
    if budget is not None:
        budget.wait_until = deadline
        if repo.count("/") >= 2:
            budget.host = repo.split("/", 1)[0]
    cap = budget.build_cap if budget is not None else interval
    last_status: str | None = None
    last_pause: int | None = None
    while True:
        result = session.retry(
            "read",
            [
                "run",
                "view",
                run_id,
                "--repo",
                repo,
                "--json",
                "status,conclusion",
                "--jq",
                '[.status, (.conclusion // "pending")] | @tsv',
            ],
        )
        match result:
            case GhOk(stdout=line):
                pass
            case GhFailed() | GhUnanswered():
                err = session.err_line()
                # A 4xx is the API saying THIS PAIR does not exist (or is not visible): a fact about
                # the invocation, never the 1 that reads as a failed run (ludics-lite#74's second half).
                if api_rejection(err):
                    die(
                        f"run watch: {repo} has no run {run_id} readable here: {err}. That is the",
                        "API answering about the id and the repo you named — nothing about the run's outcome,",
                        "so it is not a failure. Check both, then re-run the await.",
                    )
                fail(
                    3,
                    f"could not read run {run_id} in {repo} after {session.config.api_attempts} attempts ({err});",
                    "the run's state is UNKNOWN — not failed, not passed. Retry rather than concluding.",
                )
            case _:
                assert_never(result)
        status, conclusion = _tsv_pair(line)
        if status == "completed":
            break
        now = clk.now()
        if now >= deadline:
            fail(
                4,
                f"run {run_id} in {repo} has NO VERDICT after",
                f"{timing.wait // 60} min (status: {status or 'unknown'}) — that is still not a failure;",
                f"re-arm the await, or read it with: gh run view {run_id} --repo {repo}",
            )
        if now - beat >= timing.heartbeat:
            warn(
                f"still waiting on run {run_id} in {repo}: {status or 'unknown'} after",
                f"{(now - started) // 60} min",
            )
            beat = now
        # The polling budget's pause: the interval while the run's status moves, doubling toward
        # the build cap while it does not. Capped at the remaining deadline: -i is a documented
        # pass-through, and an interval past what is left would sleep far beyond the ceiling.
        sleep_for = pause(interval, cap, last_pause, status != last_status)
        last_status = status
        last_pause = sleep_for
        nap = min(sleep_for, deadline - now)
        if sleep_for > interval and nap > 0:
            warn(f"run {shlex.quote(run_id)} in {shlex.quote(repo)}: "
                 f"{next_poll(now + nap, 'polling backoff while the run is unfinished')}")
        clk.sleep(nap)
    verdict = conclusion_class(conclusion)
    match verdict:
        case "green":
            cli.say(f"run {run_id} in {repo}: {conclusion}")
            return 0
        case "red":
            fail(
                1,
                f"run {run_id} in {repo} concluded {conclusion} — the run FAILED. That is the workflow's",
                "verdict, not transport: do not retry the watch; read the failure with:",
                f"gh run view {run_id} --repo {repo} --log-failed",
            )
        case "pending" | "nogo":
            fail(
                4,
                f"run {run_id} in {repo} concluded {conclusion} — stopped, not judged (a superseding push or",
                "a manual cancel); re-run the workflow to turn it into an answer",
            )
        case _:
            assert_never(verdict)
