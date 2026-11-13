"""``pr-review.sh rerun <pr> [<run-id>...]``: the PR head's workflow runs, and the re-run of the
failed jobs of the ones named, inside the polling budget (ludics#1111).

Why. In the OCANNL wave of 2026-11-11 the fleet's one token reached 0 of 5000 core requests with
20 PRs open during an apt-mirror outage. The budget's hold worked for every ``pr-review.sh``
observer; what drained the quota beside them was workers' own ``gh run view`` and ``gh run rerun``
loops, which pass no budget (a ``retry`` caller's call is outside it too, budget.py). This verb is
those two calls as this script's OWN: gated by the hold, and setting it on a quota refusal.

RECOVERY READ BOUNDARY. `rerun <pr> jobs|failed-jobs <run-id>` reads only jobs of
that PR's current head run, latest attempt, paginated. Failed means a red conclusion, not
cancelled/skipped. `job-log <run-id> <job-id> [tail-lines]` reads a completed red job's
full text log and prints its last 80 lines by default; it does not inspect artifacts or
other attempts. `wait <run-id> [seconds]` is read-only: it reads the PR head and its run
list until the named run completes (any conclusion), disappears from the current head,
a read fails, or its ceiling (default 900 seconds) expires. It never reruns or cancels.
It claims the PR's build observer before reading, waits holds within its ceiling, and
backs off on unchanged status. Exit 0 means finished, not green; 4 means unfinished.
A second build observer is refused before any read. Non-wait reads exit 3 under a hold.

WHAT IT DOES. With no run id it lists the head's runs and writes nothing: one line a run, newest
first, with its status, conclusion and attempt, and which of them it would re-run. With run ids it
sends ``gh run rerun <id> --failed`` for each, the call ``merge --wait``'s recovery sends
(merge.py), and says so on one line a run. It waits for nothing: the verdict of a re-run is
``checks <pr> --wait``'s to read.

BOUNDARY -- what it re-runs, a fail-closed allowlist. A run id is re-run only when (a) the run
list of the PR's head, read by ``head_sha`` in this call, holds it: a run of another head, another
PR or another repository is refused; (b) it reads ``completed``: GitHub re-runs the failed jobs of
a finished run only, so a run in flight is refused rather than cancelled; and (c) its conclusion
is red (``failure``, ``timed_out``, ``startup_failure``) or ``cancelled``: a green run has no
failed job, and ``stale`` and ``action_required`` are answered by an approval, not a re-run.
Every id is checked before any write, so one refused id sends nothing. Not read: which jobs
failed, whether a job is advisory, and the run's attempt as a limit (it is printed; ``merge
--wait --rerun-failed-once`` is the path that re-runs once and stops).

THE BUDGET. All calls are own calls (``GhSession.retry``): the PR head, its runs,
jobs and logs (reads), and each re-run (a write). Except for the read-only ``wait`` observer
described above, under a hold no call is made and it exits 3 at once, saying when the hold ends; a write is never repeated on an
ambiguous failure (a 500, a 504), whose exit 3 says it may have landed.

Stdout: the lines above, then the trailer ``rerun: head=<sha> sent=<n>``, ``<n>`` being how many
re-runs were sent (0 for a listing). Exit: 0 listed, or every named run re-run; 1 a named run is
not one this re-runs (the boundary), with nothing sent, or GitHub rejected a re-run; 2 usage; 3 a
read did not answer, the hold stands, or a write failed without saying whether it landed.
"""

import json
import os
import shlex
from dataclasses import dataclass
from typing import NoReturn, assert_never, cast

from ludics import cli
from ludics.prreview.budget import pause
from ludics.prreview.clock import clock_from_env
from ludics.prreview.checkruns import conclusion_class, newest_first_lines
from ludics.prreview.core import GhFailed, GhOk, GhSession, GhUnanswered, api_rejection, die, fail, pr_arg
from ludics.prreview.knobs import checks_timing, is_digits
from ludics.prreview.runners import rerun_command
from ludics.prreview.shtext import herestring_lines, placeholder, tab_fields

USAGE = "usage: rerun <pr> [<run-id>...]"

RUNS_JQ = (
    '.workflow_runs[] | [(.created_at // "-"), ((.id // 0) | tostring), (.name // "-"), (.event // "-"),\n'
    '          (.status // "unknown"), (.conclusion // "pending"), ((.run_attempt // "-") | tostring)]\n'
    '          | map(if type == "string" and length > 0 then . else "-" end) | @tsv'
)


@dataclass(frozen=True)
class Run:
    """One of the head's workflow runs, as ``RUNS_JQ`` projects it."""

    rid: str
    name: str
    event: str
    status: str
    conclusion: str
    attempt: str

    def state(self) -> str:
        return f"{self.status}/{self.conclusion}" if self.status == "completed" else self.status

    def refusal(self) -> str:
        """Why this run is not re-run (the module docstring's boundary); "" when it is."""
        if self.status != "completed":
            return f"it is {self.status}, and GitHub re-runs the failed jobs of a finished run only"
        if conclusion_class(self.conclusion) == "red" or self.conclusion == "cancelled":
            return ""
        if conclusion_class(self.conclusion) == "green":
            return f"it concluded {self.conclusion}, so no job of it failed"
        return f"it concluded {self.conclusion}, which a re-run of failed jobs does not answer"


def parse_runs(raw: str) -> list[Run]:
    """The projection's rows, newest first; a row without a numeric id is dropped."""
    runs: list[Run] = []
    for line in herestring_lines(newest_first_lines(raw, 1, 2)):
        _created, rid, name, event, status, conclusion, attempt = tab_fields(line, 7)
        if is_digits(rid) and rid != "0":
            runs.append(Run(rid, placeholder(name), placeholder(event), status, conclusion, placeholder(attempt)))
    return runs


def _unread(session: GhSession, what: str) -> NoReturn:
    held = " The polling budget made no call: wait for its hold, do not repeat this sooner." if session.quota_stopped() else ""
    fail(3, f"rerun: could not read {what} ({session.err_line() or 'it did not answer'}); nothing was re-run.{held}")


def run(session: GhSession, args: list[str]) -> int:
    if not args or not args[0]:
        die(USAGE)
    if len(args) > 1 and args[1] in ("jobs", "failed-jobs", "job-log", "wait"):
        return recovery_read(session, args)
    ids = args[1:]
    for rid in ids:
        if not is_digits(rid):
            die(f"rerun: a run id is a number, got '{rid}'; {USAGE}")
    if len(set(ids)) != len(ids):
        die(f"rerun: a run id is named twice; {USAGE}")
    target = pr_arg(args[0], session.config.repo, session)
    repo, pr = target.repo, target.num
    head = session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", '.head.sha // "-"'])
    if not isinstance(head, GhOk) or head.stdout in ("", "-"):
        _unread(session, f"{repo}#{pr}'s head")
    sha = head.stdout
    listed = session.retry(
        "read", ["api", "--paginate", f"repos/{repo}/actions/runs?head_sha={sha}&per_page=100", "--jq", RUNS_JQ]
    )
    if not isinstance(listed, GhOk):
        _unread(session, f"the workflow runs of {repo}#{pr} @{sha[:8]}")
    runs = parse_runs(listed.stdout)
    by_id = {r.rid: r for r in runs}
    if not ids:
        cli.say(f"rerun {repo}#{pr} @{sha[:8]}: {len(runs)} workflow run(s) on the head; none re-run (name run ids to re-run)")
        for r in runs:
            why = r.refusal()
            mark = "re-runnable" if not why else "not re-run"
            cli.say(f"  run {r.rid}  {r.name}  ({r.event})  {r.state()}  attempt {r.attempt or '?'}  {mark}")
        cli.say(f"rerun: head={sha} sent=0")
        return 0
    refused: list[str] = []
    for rid in ids:
        found = by_id.get(rid)
        if found is None:
            refused.append(f"run {rid} is not a workflow run of {repo}#{pr}'s head {sha[:8]}")
        elif found.refusal():
            refused.append(f"run {rid} ({found.name}): {found.refusal()}")
    if refused:
        fail(
            1,
            f"rerun: REFUSING, nothing was re-run: {'; '.join(refused)}.",
            f"`pr-review.sh rerun {repo}#{pr}` lists the head's runs.",
        )
    sent = 0
    for rid in ids:
        found = by_id[rid]
        command = rerun_command(rid, repo)
        result = session.retry("write", ["run", "rerun", rid, "--failed", "--repo", repo])
        after = f" {sent} re-run(s) were sent before it." if sent else ""
        match result:
            case GhOk():
                sent += 1
                cli.say(
                    f"rerun {repo}#{pr} @{sha[:8]}: run {rid} ({found.name}, {found.conclusion}, attempt"
                    f" {found.attempt or '?'}): its failed jobs re-run — {command}"
                )
            case GhUnanswered() if session.quota_stopped():
                fail(
                    3,
                    f"rerun: `{command}` was not sent ({session.err_line()}): the polling budget made no call.{after}",
                    "Wait for its hold; do not repeat this sooner.",
                )
            case GhFailed() if api_rejection(session.err_line()) and session.unclear_attempts() == 0:
                fail(1, f"rerun: `{command}` was rejected: {session.err_line()}.{after}")
            case GhFailed() | GhUnanswered():
                fail(
                    3,
                    f"rerun: `{command}` failed ({session.err_line()}) and may have landed.{after}",
                    f"Read `pr-review.sh rerun {repo}#{pr}` (its attempt) before repeating it.",
                )
            case _:
                assert_never(result)
    cli.say(f"rerun {repo}#{pr}: await the verdict with: pr-review.sh checks {repo}#{pr} --wait")
    cli.say(f"rerun: head={sha} sent={sent}")
    return 0


def recovery_read(session: GhSession, args: list[str]) -> int:
    """Budgeted recovery reads; see the module header for the readiness boundary."""
    verb = args[1]
    expected = (4, 5) if verb == "job-log" else (3, 4) if verb == "wait" else (3,)
    if len(args) not in expected or not is_digits(args[2]) or args[2] == "0":
        die("usage: rerun <pr> jobs|failed-jobs <run-id>; job-log <run-id> <job-id> [tail-lines]; wait <run-id> [seconds]")
    extra = args[3:]
    # GitHub identifiers are not signed 32-bit counters; only sizes/durations are bounded.
    bounds = extra[1:] if verb == "job-log" else extra
    if verb == "job-log" and (not is_digits(extra[0]) or not extra[0].strip("0")):
        die("rerun: job id must be a positive integer")
    if any(not is_digits(x) or not 0 < int(x) <= 2147483647 for x in bounds):
        die("rerun: tail lines and wait seconds must be positive integers up to 2147483647")
    target = pr_arg(args[0], session.config.repo, session)
    repo, pr, rid = target.repo, target.num, args[2]
    clock = clock_from_env(os.environ)
    timing = checks_timing(os.environ)
    seconds = int(extra[0]) if verb == "wait" and extra else 900
    deadline = clock.now() + seconds
    if verb == "wait" and session.budget is not None:
        session.budget.observe("build", seconds, repo, pr)
    last: str | None = None
    delay: int | None = None
    while True:
        head = session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", '.head.sha // "-"'])
        if not isinstance(head, GhOk) or head.stdout in ("", "-"):
            _unread(session, "the PR head")
        listed = session.retry("read", ["api", "--paginate",
            f"repos/{repo}/actions/runs?head_sha={head.stdout}&per_page=100", "--jq", RUNS_JQ])
        if not isinstance(listed, GhOk):
            _unread(session, "the head's runs")
        found = next((r for r in parse_runs(listed.stdout) if r.rid == rid), None)
        if found is None:
            fail(1, f"rerun: run {rid} is not on {repo}#{pr}'s current head")
        if verb != "wait":
            break
        cli.say(f"rerun wait: run {rid} {found.state()}")
        if found.status == "completed":
            return 0
        if clock.now() >= deadline:
            fail(4, f"rerun wait: run {rid} still unfinished; wait spent")
        cap = session.budget.build_cap if session.budget is not None else timing.interval
        delay = pause(timing.interval, cap, delay, last != found.state())
        last = found.state()
        clock.sleep(min(delay, max(0, deadline - clock.now())))
    jobs = read_jobs(session, repo, rid)
    if verb == "job-log":
        jid = extra[0]
        job = next((j for j in jobs if str(j.get("id")) == jid), None)
        if job is None or job.get("status") != "completed" or conclusion_class(str(job.get("conclusion"))) != "red":
            fail(1, f"rerun: job {jid} is not a completed failed job of run {rid}")
        log = session.retry("read", ["api", f"repos/{repo}/actions/jobs/{jid}/logs"])
        if not isinstance(log, GhOk):
            _unread(session, f"job {jid}'s log")
        lines = int(extra[1]) if len(extra) > 1 else 80
        cli.say("\n".join(log.stdout.splitlines()[-lines:]))
    else:
        for job in jobs:
            if verb == "failed-jobs" and conclusion_class(str(job.get("conclusion"))) != "red":
                continue
            cli.say(f"job {job.get('id')} {shlex.quote(str(job.get('name')))} "
                    f"{job.get('status')}/{job.get('conclusion')}")
    return 0


def read_jobs(session: GhSession, repo: str, rid: str) -> list[dict[str, object]]:
    """Current attempt's jobs, paginated; reusable by other recovery readers."""
    result = session.retry("read", ["api", "--paginate",
        f"repos/{repo}/actions/runs/{rid}/jobs?filter=latest&per_page=100", "--jq", '.jobs[] | @json'])
    if not isinstance(result, GhOk):
        _unread(session, f"run {rid}'s jobs")
    jobs: list[dict[str, object]] = []
    try:
        for line in result.stdout.splitlines():
            value: object = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError("not a job object")
            job = cast(dict[str, object], value)
            if not isinstance(job.get("id"), int):
                raise ValueError("missing job id")
            jobs.append(job)
    except (ValueError, TypeError):
        fail(3, "rerun: unreadable jobs response")
    return jobs
