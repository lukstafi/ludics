"""The commits a registry payload names must exist (ludics-lite#561): ``execution`` checks them on
the near side before the payload reaches the anchor, because a registry record is immutable once
concluded, and a mistyped SHA there (the right prefix with a wrong tail, twice in the 2026-10-05
wave) can only be annotated, never fixed.

The checker is GitHub, asked by this box's ``gh`` (``gh api --hostname github.com
repos/<repository>/commits/<sha> -q .sha``), against the request's ``repository``. Not the execution
box's checkout, which may be asleep, removed by the time a conclusion is written, or named by a
placeholder (``remote_checkout`` is free text: ``(removed)``, ``not recorded``); and not the anchor,
which keeps no clone of the reservation's repository. A request names a pushed revision (the
worker's EXECUTION_REQUEST says so), and the evidence a conclusion cites is the revision a reviewer
reads on GitHub, so "GitHub has this commit in that repository" is the property worth holding.
``--observed-from <checkout>`` reads ``git rev-parse HEAD`` on the execution host instead of a SHA
copied by hand, which removes the typo; it is still asked of GitHub, since the checkout named may be
another repository's. ``conclude --from-run`` checks its ``--sha`` on GitHub too, for the same reason
(a box holds several repositories' runs), beside its far side's own checks: the run's checkout must
contain it (``git cat-file -e``), and a record's launch ``head`` must equal it.

Outcomes. A commit GitHub answers for is accepted. ``No commit found for SHA: <sha>`` (HTTP 422; a
422 without it is GitHub calling the endpoint spammed) refuses, exit 1, naming the SHA and the
repository it was checked in; so does a SHA-256 object ID, which GitHub cannot hold. Anything else
-- no answer within FLEET_GH_TIMEOUT (30 s), a 5xx, a rate limit, bad credentials, a 404 (no such
repository, or a private one the token cannot see: GitHub does not say which), no ``gh`` -- is
``EXECUTION UNVERIFIED``, exit 4: nothing is recorded, never a silent accept. A payload whose record
the registry already holds is not checked again where the registry's own retry rule decides it --
a conclusion of a concluded record, a reservation of an existing request id -- so a GitHub outage
cannot fail a retry whose first call landed with its answer lost. What GitHub resolves is its repository NETWORK: a commit
pushed only to a fork resolves through the parent's name, which this check accepts.

What is read, and nothing else (a fail-closed allowlist for what counts as a commit claim):
  - ``observed_sha`` of a dispatch, record, reconcile or conclude payload, ``--sha`` of ``conclude
    --from-run`` and ``--from-bg-run``, and the HEAD ``--observed-from`` reads, when shaped as the registry's exact
    object ID (40 or 64 lowercase hex); and the record's own ``observed_sha`` when a conclusion
    names none and so inherits it. Any other value is left to the registry, which refuses it on
    shape.
  - ``requested_revision`` of a reserve, run or window request, which is free text (a pushed ref,
    an exact SHA, or a SHA with a note: ``<sha> plus working diff``): each whitespace-separated WORD
    made only of hex digits, seven or more, is a commit claim, and must be the full 40-hex SHA and
    resolve. A ref (``origin/main``) and prose are not read. Neither is a SHA inside a longer word
    (``origin/<sha>``, ``<sha>^``, ``<sha>:path``), nor whether a named ref exists.
"""

import re
import subprocess
from collections.abc import Callable
from typing import Any, cast

from ludics import proc

SHA40 = re.compile(r"[0-9a-f]{40}")
SHA64 = re.compile(r"[0-9a-f]{64}")
OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
HEX_WORD = re.compile(r"[0-9A-Fa-f]{7,}")
RETRY = "copy it again from `git rev-parse`, or conclude with --observed-from <checkout>, which reads it"


def commit_refusal(repo: str, what: str, sha: str, timeout: float = 30) -> tuple[str, int] | None:
    """None when GitHub has the commit ``sha`` in ``repo``; else the line to print and its exit."""
    if not REPOSITORY.fullmatch(repo):
        return (
            f"EXECUTION REFUSED: {what} {sha} cannot be checked: the request's repository"
            f" {repo!r} is not <owner>/<name> on GitHub; nothing recorded",
            1,
        )
    if SHA64.fullmatch(sha):
        return (
            f"EXECUTION REFUSED: {what} {sha} is a SHA-256 object ID, which GitHub cannot hold, so it"
            f" cannot be checked in {repo}; nothing recorded",
            1,
        )
    done = proc.run_tool(
        "gh",
        ["api", "--hostname", "github.com", f"repos/{repo}/commits/{sha}", "-q", ".sha"],
        stdin=subprocess.DEVNULL,
        timeout=timeout,
    )
    lines = done.stderr.strip().splitlines()
    said = lines[-1].strip() if lines else f"gh exit {done.rc}, no message"
    if done.rc == 0:
        got = done.stdout.strip()
        if got == sha:
            return None
        return (
            f"EXECUTION REFUSED: GitHub resolved {what} {sha} in {repo} to {got or 'nothing'},"
            " not that commit; nothing recorded",
            1,
        )
    # 422 is also GitHub's answer to an endpoint it calls spammed: only its no-commit message refuses.
    if "(HTTP 422)" in done.stderr and f"No commit found for SHA: {sha}" in done.stderr:
        return (f"EXECUTION REFUSED: {what} {sha} is no commit of {repo} (checked on GitHub: {said}); nothing recorded -- {RETRY}", 1)
    if "(HTTP 404)" in done.stderr:
        # GitHub answers 404 for a private repository the token cannot see, too: not proof of absence.
        said += f": no repository {repo}, or one this box's gh token cannot see"
    return (
        f"EXECUTION UNVERIFIED github.com: {what} {sha} could not be checked in {repo} ({said});"
        " nothing recorded -- retry once GitHub answers",
        4,
    )


def request_refusal(
    request: Any, timeout: float = 30, exists: Callable[[str], bool] = lambda _: False
) -> tuple[str, int] | None:
    """The requested_revision check of a reservation (see the header); None when it passes, or
    when the request is not shaped for one (the registry refuses that itself). ``exists`` says
    whether the registry already holds the request id: a retry of a reservation that landed with
    its answer lost is the registry's to judge (the identical request is returned, any other
    refused), so it is not checked again and a GitHub outage cannot fail it."""
    if not isinstance(request, dict):
        return None
    fields = cast(dict[str, Any], request)
    repo, revision = fields.get("repository"), fields.get("requested_revision")
    if not (isinstance(repo, str) and isinstance(revision, str)):
        return None
    words = [word for word in revision.split() if HEX_WORD.fullmatch(word)]
    request_id = fields.get("request_id")
    if not words or (isinstance(request_id, str) and request_id and exists(request_id)):
        return None
    for word in words:
        if not SHA40.fullmatch(word):
            return (
                f"EXECUTION REFUSED: requested_revision names {word}, which is not a full commit ID:"
                " give the 40-hex lowercase SHA (`git rev-parse <it>`), or a ref; nothing recorded",
                1,
            )
        refusal = commit_refusal(repo, "requested_revision", word, timeout)
        if refusal is not None:
            return refusal
    return None
