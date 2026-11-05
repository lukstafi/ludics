"""A red build check that ran on a different runner image from the base's last green run of that
job (ludics#959): one ``NEW IMAGE`` line under the gate's red report (checks, merge).

When GitHub moves a label under a job (``ubuntu-latest`` to ``ubuntu-26.04`` on 2026-11-04), the
job's labels and runner name stay what they were; only the job's log says which image it ran on,
in its setup header (``##[group]Runner Image`` / ``Image: ubuntu-26.04``). So for each red check
of an Actions job, this reads that job's image, finds the base branch's newest green run of the
same job, reads its image, and names both when they differ.

Boundary -- what this reads, and what it does not. A fail-closed allowlist: anything outside it
is an image not known, and an image not known prints nothing, ever. The line is a note: it changes
no verdict, exit code or other report line, and a read that fails is not retried past the
session's own attempts or reported.

- Only a red check whose ``html_url`` is exactly ``https://github.com/<this repo>/actions/runs/<run
  id>/job/<job id>`` (the repository compared case-blind) is an Actions job; any other URL (another
  app's check, a fixture's) is read no further. At most ``CHECKS`` red checks are looked at.
- The image is read from the job's log, ``repos/R/actions/jobs/{id}/logs``, and only from its first
  ``LOG_BYTES`` bytes (an HTTP ``Range`` request; the header ends within about 1.6 KiB, a whole
  log can be megabytes, and the first step's coloured echo -- at 7 KiB into a Windows job's log on
  2026-11-04 -- makes gh withhold the answer). Within them, only the complete lines (a range ends mid-line, so the text after its
  last newline is dropped) inside the ``##[group]Runner Image`` group, and only the first
  ``Image: <name>`` line there, with ``<name>`` matching ``IMAGE_NAME``. A log without that group
  (a self-hosted runner), a log gh withholds for its escape sequences (``core.gh_withheld_escapes``:
  the call does not pass ``--allow-escape-sequences``, which a gh before 2.101 refuses as a flag),
  an expired or unreadable log, or a malformed line: the image is not known. Version lines are
  not read: an image's weekly version moves under every job, and naming it would make a
  same-image red print.
- "The base's last green run of that job" is that job NAME's newest ``success`` (not ``skipped``
  or ``neutral``: a job that did not run has no image) in the workflow of the red job's run, on
  the PR's base branch (``.base.ref``, read once), among the newest ``RUNS_BACK`` completed runs
  of that workflow on that branch (one page, ``status=completed``, ordered by ``newest_first``)
  whose event is ``push``, ``schedule`` or ``workflow_dispatch`` -- the base branch's own runs, not
  a pull request from a fork's branch of the same name. Those runs' jobs are read newest first,
  each run at most once per report, until every red job's name is found green; a name not green in
  any of them has no base image, and prints nothing.
- The workflow of the red job's run is the round's run read (``HeadRun.wid``) when it holds that
  run, else one read of ``repos/R/actions/runs/{id}``.
It writes nothing.
"""

import re
import urllib.parse
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from ludics.prreview.checkruns import newest_first
from ludics.prreview.core import GhOk, GhSession
from ludics.prreview.runners import HeadRun
from ludics.prreview.shtext import herestring_lines, is_digits, tab_fields

CHECKS = 5
RUNS_BACK = 10
LOG_BYTES = 4096
BASE_EVENTS = ("push", "schedule", "workflow_dispatch")
IMAGE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_JOB_URL = re.compile(r"https://github\.com/([^/]+/[^/]+)/actions/runs/([0-9]+)/job/([0-9]+)")
_STAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ")


@dataclass(frozen=True)
class RedJob:
    """A red check the report names, as the fold read it."""

    name: str
    url: str


def job_of_url(repo: str, url: str) -> tuple[str, str] | None:
    """``(run id, job id)`` of an Actions job's check-run URL in ``repo``; None for any other URL."""
    m = _JOB_URL.fullmatch(url)
    if m is None or m.group(1).casefold() != repo.casefold():
        return None
    return m.group(2), m.group(3)


def image_of_log(text: str) -> str | None:
    """The ``Image:`` name of a job log's head, inside its ``Runner Image`` group; None when the
    head's complete lines hold no such line (the boundary above)."""
    complete = text.rsplit("\n", 1)[0] if "\n" in text else ""
    inside = False
    for raw in complete.split("\n"):
        line = raw.removesuffix("\r").removeprefix("﻿")
        stamp = _STAMP.match(line)
        if stamp is None:
            continue
        body = line[stamp.end() :]
        if body == "##[group]Runner Image":
            inside = True
        elif body.startswith("##["):
            if inside:
                return None
        elif inside and body.startswith("Image: "):
            name = body[len("Image: ") :]
            return name if IMAGE_NAME.fullmatch(name) else None
    return None


@dataclass
class Images:
    """One report's reads: each log, run and base-run job list read at most once."""

    session: GhSession
    repo: str
    pr: str
    _base: str | None = None
    _base_read: bool = False
    _logs: dict[str, str | None] = field(default_factory=lambda: dict[str, str | None]())
    _base_runs: dict[str, list[str] | None] = field(default_factory=lambda: dict[str, list[str] | None]())
    _jobs: dict[str, list[tuple[str, str, str]] | None] = field(
        default_factory=lambda: dict[str, list[tuple[str, str, str]] | None]()
    )

    def base_ref(self) -> str | None:
        if not self._base_read:
            self._base_read = True
            result = self.session.retry("read", ["api", f"repos/{self.repo}/pulls/{self.pr}", "--jq", '.base.ref // ""'])
            ref = result.stdout.strip() if isinstance(result, GhOk) else ""
            self._base = ref or None
        return self._base

    def image(self, job: str) -> str | None:
        if job not in self._logs:
            result = self.session.retry(
                "read", ["api", "-H", f"Range: bytes=0-{LOG_BYTES - 1}", f"repos/{self.repo}/actions/jobs/{job}/logs"]
            )
            self._logs[job] = image_of_log(result.stdout) if isinstance(result, GhOk) else None
        return self._logs[job]

    def workflow_of(self, run: str, runs: Sequence[HeadRun]) -> str | None:
        for head_run in runs:
            if head_run.rid == run:
                return head_run.wid if is_digits(head_run.wid) and head_run.wid != "0" else None
        result = self.session.retry(
            "read", ["api", f"repos/{self.repo}/actions/runs/{run}", "--jq", '(.workflow_id // "") | tostring']
        )
        wid = result.stdout.strip() if isinstance(result, GhOk) else ""
        return wid if is_digits(wid) and wid != "0" else None

    def base_runs(self, wid: str, branch: str) -> list[str] | None:
        """The newest ``RUNS_BACK`` completed base-branch runs of the workflow, ids newest first."""
        if wid not in self._base_runs:
            result = self.session.retry(
                "read",
                [
                    "api",
                    f"repos/{self.repo}/actions/workflows/{wid}/runs?branch={urllib.parse.quote(branch, safe='')}"
                    "&status=completed"
                    f"&per_page={RUNS_BACK}",
                    "--jq",
                    '.workflow_runs[] | [(.created_at // "-"), ((.id // 0) | tostring), (.event // "-"),'
                    ' (.head_branch // "-")] | @tsv',
                ],
            )
            if not isinstance(result, GhOk):
                self._base_runs[wid] = None
            else:
                rows = [tab_fields(line, 4) for line in herestring_lines(result.stdout) if line]
                rows = [r for r in rows if is_digits(r[1]) and r[2] in BASE_EVENTS and r[3] == branch]
                ordered = newest_first(rows, lambda r: r[0], lambda r: r[1], lambda r: "\t".join(r))
                self._base_runs[wid] = [r[1] for r in ordered[:RUNS_BACK]]
        return self._base_runs[wid]

    def jobs(self, run: str) -> list[tuple[str, str, str]] | None:
        """``(job id, name, conclusion)`` per job of a base run."""
        if run not in self._jobs:
            result = self.session.retry(
                "read",
                [
                    "api",
                    "--paginate",
                    f"repos/{self.repo}/actions/runs/{run}/jobs?per_page=100",
                    "--jq",
                    '.jobs[] | [((.id // 0) | tostring), (.name // "-"), (.conclusion // "-")] | @tsv',
                ],
            )
            if not isinstance(result, GhOk):
                self._jobs[run] = None
            else:
                rows = [tab_fields(line, 3) for line in herestring_lines(result.stdout) if line]
                self._jobs[run] = [(r[0], r[1], r[2]) for r in rows if is_digits(r[0])]
        return self._jobs[run]

    def last_green(self, wid: str, branch: str, name: str) -> tuple[str, str] | None:
        """``(run id, job id)`` of the job name's newest success on the base branch, or None."""
        for run in self.base_runs(wid, branch) or []:
            for jid, jname, concl in self.jobs(run) or []:
                if jname == name and concl == "success":
                    return run, jid
        return None


def report_lines(
    session: GhSession, repo: str, pr: str, reds: Sequence[RedJob], runs: Sequence[HeadRun],
    quote: Callable[[str], str],
) -> str:
    """The ``NEW IMAGE`` lines for the report's red checks: one per red job whose image and its base
    green run's image are both known and differ; empty otherwise."""
    reads = Images(session, repo, pr)
    out: list[str] = []
    for red in reds[:CHECKS]:
        ids = job_of_url(repo, red.url)
        if ids is None:
            continue
        run, job = ids
        image = reads.image(job)
        if image is None:
            continue
        branch = reads.base_ref()
        wid = reads.workflow_of(run, runs) if branch is not None else None
        if branch is None or wid is None:
            continue
        green = reads.last_green(wid, branch, red.name)
        if green is None:
            continue
        base_image = reads.image(green[1])
        if base_image is None or base_image == image:
            continue
        out.append(
            f"  NEW IMAGE  {quote(red.name)} ran on {image}; its last green run on {quote(branch)}"
            f" (run {green[0]}) ran on {base_image}\n"
        )
    return "".join(out)
