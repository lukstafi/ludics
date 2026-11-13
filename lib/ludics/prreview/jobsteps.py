"""Heartbeat-only evidence for #1112; never a build verdict.

Boundary: only pending checks retained by the gate's advisory/selection fold, with an exact
GitHub Actions job URL in this repository, are read. One budgeted job-endpoint read per unique
job per heartbeat, none between heartbeats. A still-pending job with an array of steps containing
a completed, successful ``Complete job`` and a UTC completion timestamp gets prose only,
provided every step is completed with conclusion success or skipped. Repository case is ignored.
Missing fields, failed reads, external checks, finished jobs and incomplete steps add nothing.
No run-job listing, logs, annotations, retries of other attempts, or verdict changes.
"""

import re
import shlex

from ludics.prreview.core import GhOk, GhSession
from ludics.prreview.images import job_of_url

FINISHED_JQ = (
    'select((.status == "queued" or .status == "pending" or .status == "in_progress") '
    'and .conclusion == null) | '
    'select((.steps | type) == "array") | '
    'select(all(.steps[]; .status == "completed" and (.conclusion == "success" or .conclusion == "skipped"))) | '
    '.steps[] | '
    'select(.name == "Complete job" and .status == "completed" and .conclusion == "success") | '
    '.completed_at // empty'
)
_STAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")


def diagnostic(session: GhSession, repo: str, jobs: list[tuple[str, str]]) -> str:
    """Return only heartbeat prose; the caller retains its counts, verdict and wait settings."""
    seen: set[str] = set()
    notes: list[str] = []
    for name, url in jobs:
        job = job_of_url(repo, url)
        if job is None or job[1] in seen:
            continue
        jid = job[1]
        seen.add(jid)
        result = session.retry("read", ["api", f"repos/{repo}/actions/jobs/{jid}", "--jq", FINISHED_JQ])
        if not isinstance(result, GhOk):
            continue
        stamps = result.stdout.splitlines()
        if len(stamps) == 1 and _STAMP.fullmatch(stamps[0]):
            notes.append(
                f"{shlex.quote(name)}: steps finished successfully at {stamps[0]}; "
                "conclusion has not been published; this is a GitHub-side delay"
            )
    return "; ".join(notes)
