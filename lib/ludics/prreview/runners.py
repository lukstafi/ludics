"""Build jobs that never got a runner (ludics-lite#560, #728): what ``checks`` names and what
``merge --wait`` recovers from once.

Two classes, over the PR head's own workflow runs:

- **NO RUNNER**: a job that completed ``cancelled`` with an empty ``steps`` array READ as such and
  no runner named -- the jobs API's shape of GitHub's "The job was not acquired by Runner of type
  hosted even after multiple attempts" (the 2026-10-05 outage, #560). Its run must have completed:
  ``gh run rerun --failed`` refuses a run in flight.
- **NEVER STARTED**: a job still ``queued`` for at least ``SHIP_PR_NEVER_STARTED`` seconds (from
  the JOB's ``created_at``) while a run of the same workflow created strictly after it has a job
  with the same runner labels that started -- a runner named, or a step ran. The labels are what
  tell an orphan from a deep queue for one label: a macOS queue can be deep while a newer run's
  Linux job starts at once (#728's evidence).

Boundary -- what this reads, and what it does not. It reads, and only on a round the gate has no
verdict for: ``repos/R/actions/runs/{id}/jobs`` for the head's runs (the newest completed run per
workflow and event that is not green, and the runs in flight at least the threshold old); and,
only for a queued job past the threshold, ``repos/R/actions/workflows/{wid}/runs?created=>…`` and
the jobs of at most ``EVIDENCE_RUNS`` of those newer runs. It is an allowlist, failing closed:
- A field the projection cannot read is ``-``, and ``-`` classifies nothing: an absent or
  non-array ``steps`` is not zero steps, a job without labels matches no newer job, a job without a
  creation stamp has no age.
- A read that fails classifies nothing either: it is never "no orphan" and never an orphan, and
  the gate's verdict and wait stay what they were without it.
- It does not read the "not acquired" annotation (``check-runs/{id}/annotations``): a job that ran
  no step on no runner was not acquired, whatever the annotation says, and an annotated job cannot
  have run a step.
- It does not classify advisory jobs (``SHIP_PR_ADVISORY_CHECKS``; #720 owns them), jobs that are
  ``waiting``, ``pending`` or ``requested`` (approvals and concurrency, not a starved runner), or
  any run but the PR head's.
It writes nothing: the one recovery is ``merge --wait``'s (merge.py, ``Recovery``).
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from ludics.prreview.checkruns import conclusion_class
from ludics.prreview.clock import age_of, fmt_age
from ludics.prreview.core import GhOk, GhSession
from ludics.prreview.shtext import herestring_lines, tab_fields

# How many runs of the same workflow, created after a queued job, are read for a started job.
EVIDENCE_RUNS = 3

_DIGITS = re.compile(r"[0-9]+")

JOBS_JQ = (
    '.jobs[] | [((.id // "-") | tostring), (.name // "-"), (.status // "-"), (.conclusion // "-"),\n'
    '          (.created_at // "-"),\n'
    '          (if (.steps | type) == "array" then (.steps | length | tostring) else "-" end),\n'
    '          (.runner_name // "-"),\n'
    '          (if (.labels | type) == "array" then (.labels | map(tostring) | join(",")) else "-" end),\n'
    '          ((.run_attempt // "-") | tostring)]\n'
    '          | map(if type == "string" and length > 0 then . else "-" end) | @tsv'
)

NEWER_RUNS_JQ = (
    '(.workflow_runs // [])[] | [((.id // "-") | tostring), (.status // "-"), (.created_at // "-")]\n'
    '          | map(if type == "string" and length > 0 then . else "-" end) | @tsv'
)


@dataclass(frozen=True)
class HeadRun:
    """One of the head's workflow runs, as ``run_signal``'s projection reads it."""

    rid: str
    wid: str
    event: str
    name: str
    status: str
    conclusion: str
    created: str


@dataclass(frozen=True)
class Job:
    """One job of a run. ``steps`` and ``attempt`` are None when the field could not be read."""

    jid: str
    name: str
    status: str
    conclusion: str
    created: str
    steps: int | None
    runner: str
    labels: tuple[str, ...]
    attempt: int | None

    def started(self) -> bool:
        """Did a runner take it? A runner named, or a step ran."""
        return bool(self.runner) or (self.steps is not None and self.steps > 0)


type Kind = Literal["no-runner", "never-started"]


@dataclass(frozen=True)
class Orphan:
    """A job of the head's run ``rid`` that never got a runner. ``evidence``: for NEVER STARTED,
    the newer run whose job with the same labels started; ``age``: how long it has been queued."""

    kind: Kind
    rid: str
    job: Job
    evidence: str = ""
    age: int | None = None


def _field(text: str) -> str:
    return "" if text in ("", "-") else text


def _int(text: str) -> int | None:
    return int(text) if _DIGITS.fullmatch(text) else None


def parse_jobs(raw: str) -> list[Job]:
    """The projection's rows; a row that is not one (a wrong field count, an id that is not a
    number) is dropped, so it can classify nothing."""
    jobs: list[Job] = []
    for line in herestring_lines(raw):
        fields = tab_fields(line, 9)
        if len(line.split("\t")) != 9 or not _DIGITS.fullmatch(fields[0]):
            continue
        jid, name, status, concl, created, steps, runner, labels, attempt = fields
        label_text = _field(labels)
        jobs.append(Job(
            jid=jid,
            name=_field(name),
            status=_field(status),
            conclusion=_field(concl),
            created=_field(created),
            steps=_int(steps),
            runner=_field(runner),
            labels=tuple(sorted(label_text.split(","))) if label_text else (),
            attempt=_int(attempt),
        ))
    return jobs


def read_jobs(session: GhSession, repo: str, rid: str) -> list[Job] | None:
    """The run's jobs (its latest attempt, the endpoint's default); None when the read failed."""
    result = session.retry(
        "read", ["api", "--paginate", f"repos/{repo}/actions/runs/{rid}/jobs?per_page=100", "--jq", JOBS_JQ]
    )
    return parse_jobs(result.stdout) if isinstance(result, GhOk) else None


def no_runner(job: Job) -> bool:
    return (
        job.status == "completed" and job.conclusion == "cancelled" and job.steps == 0 and not job.runner
    )


def scan_candidates(runs: list[HeadRun], now: float, threshold: int | None,
                    is_advisory: Callable[[str], bool]) -> list[HeadRun]:
    """The head's runs worth a jobs read: the newest completed run per workflow and event whose
    conclusion is not green (a superseded one is not the head's signal), and each run in flight
    old enough to hold a job queued past the threshold. Advisory runs are the gate's to skip."""
    seen: set[str] = set()
    out: list[HeadRun] = []
    for run in runs:
        if not run.rid or is_advisory(run.name):
            continue
        if run.status != "completed" or conclusion_class(run.conclusion) == "pending":
            age = age_of(run.created, now)
            if threshold is not None and age is not None and age >= threshold:
                out.append(run)
            continue
        key = f"{run.wid}/{run.event}"
        if key in seen:
            continue
        seen.add(key)
        if conclusion_class(run.conclusion) != "green":
            out.append(run)
    return out


def newer_started(session: GhSession, repo: str, run: HeadRun, job: Job) -> str | None:
    """The id of a run of ``run``'s workflow created strictly after ``job`` whose job with the
    same labels started; None when there is none, or when a read that would show one failed."""
    if not run.wid or not job.created or not job.labels:
        return None
    result = session.retry(
        "read",
        [
            "api",
            f"repos/{repo}/actions/workflows/{run.wid}/runs?created=%3E{job.created}&per_page=20",
            "--jq",
            NEWER_RUNS_JQ,
        ],
    )
    if not isinstance(result, GhOk):
        return None
    read = 0
    for line in herestring_lines(result.stdout):
        rid, status, created = (_field(f) for f in tab_fields(line, 3))
        if not _DIGITS.fullmatch(rid) or rid == run.rid:
            continue
        if not created or created <= job.created or status not in ("in_progress", "completed"):
            continue
        if read >= EVIDENCE_RUNS:
            break
        read += 1
        jobs = read_jobs(session, repo, rid)
        if jobs is None:
            continue
        if any(j.labels == job.labels and j.started() for j in jobs):
            return rid
    return None


def classify(session: GhSession, repo: str, run: HeadRun, jobs: list[Job], now: float,
             threshold: int | None, wanted: Callable[[str], bool]) -> list[Orphan]:
    """The orphans among one head run's jobs that ``wanted`` (not advisory; selected under
    ``--check``) keeps."""
    out: list[Orphan] = []
    completed = run.status == "completed"
    for job in jobs:
        if not job.name or not wanted(job.name):
            continue
        if completed and no_runner(job):
            out.append(Orphan("no-runner", run.rid, job))
            continue
        if job.status != "queued" or threshold is None:
            continue
        age = age_of(job.created, now)
        if age is None or age < threshold:
            continue
        evidence = newer_started(session, repo, run, job)
        if evidence is not None:
            out.append(Orphan("never-started", run.rid, job, evidence, age))
    return out


def scan(session: GhSession, repo: str, runs: list[HeadRun], now: float, threshold: int | None,
         is_advisory: Callable[[str], bool], wanted: Callable[[str], bool]) -> list[Orphan]:
    """Every orphan of the head's runs; a run whose jobs could not be read contributes none."""
    out: list[Orphan] = []
    for run in scan_candidates(runs, now, threshold, is_advisory):
        jobs = read_jobs(session, repo, run.rid)
        if jobs is None:
            continue
        out.extend(classify(session, repo, run, jobs, now, threshold, wanted))
    return out


@dataclass(frozen=True)
class Stop:
    """End the wait (the recovery is spent, refused, or could not be made)."""


@dataclass(frozen=True)
class Wait:
    """Keep waiting, until at least ``until`` (0: the deadline as it stands)."""

    until: int = 0


@dataclass(frozen=True)
class Idle:
    """Nothing to recover this round: the gate goes on as it would without a recovery."""


type Step = Stop | Wait | Idle
type Recover = Callable[[list[Orphan], list[HeadRun]], Step]


def rerun_command(rid: str, repo: str, failed: bool = True) -> str:
    return f"gh run rerun {rid}{' --failed' if failed else ''} --repo {repo}"


def cancel_command(rid: str, repo: str) -> str:
    return f"gh run cancel {rid} --repo {repo}"


def recovery_text(orphan: Orphan, repo: str) -> str:
    """The commands that recover the orphan's run by hand."""
    if orphan.kind == "no-runner":
        return rerun_command(orphan.rid, repo)
    return f"{cancel_command(orphan.rid, repo)}, then once it completes {rerun_command(orphan.rid, repo)}"


def report_line(orphan: Orphan, repo: str, quote: Callable[[str], str]) -> str:
    """The gate's report line for one orphan (``quote``: the job name is the repository's)."""
    job = orphan.job
    attempt = f", attempt {job.attempt}" if job.attempt is not None else ""
    if orphan.kind == "no-runner":
        return (
            f"  NO RUNNER      {quote(job.name)} — run {orphan.rid}{attempt}: cancelled before any runner"
            f" took it, no step ran; recover: {recovery_text(orphan, repo)}\n"
        )
    return (
        f"  NEVER STARTED  {quote(job.name)} — run {orphan.rid}{attempt}: queued {fmt_age(orphan.age)} for"
        f" {quote(','.join(job.labels))} while run {orphan.evidence} of the same workflow got a runner"
        f" for them; recover: {recovery_text(orphan, repo)}\n"
    )
