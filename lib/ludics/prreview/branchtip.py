"""Does a PR's head agree with its branch's tip (#960)?

During GitHub's 2026-11-04 incident a push reached ``claude/w1104-944`` while #952's head stayed on
the old commit for over 17 minutes: ``watch`` reported approved and ``merge`` the old run's red,
both for a head that was no longer the branch's, and nothing said so. Everything else in this
package reads the PR's ``.head.sha``, so this is the one read that looks past it.

THE READ. Two REST reads, in this order, each fresh (no round snapshot): ``repos/<repo>/pulls/<n>``
for the PR's state, head SHA, head branch and head repository, then the refs API in the HEAD
repository, ``repos/<head repo>/git/ref/heads/<branch>``, for ``.object.sha``. The head repository,
not the base: a fork PR's branch lives on the fork. The refs API rather than ``git ls-remote``
because it needs no clone and no git credential, and rides the session's retry and polling budget
like every other read here. ``git/ref`` is an exact match (``git/matching-refs`` is the prefix one),
so a branch that is a prefix of another does not read the longer one's tip.

BOUNDARY (a fail-closed allowlist). ``Clear`` is exactly: the PR read answered and is not ``open``
(a merged PR's head is frozen and its branch may be gone or reused, so nothing is compared and
Clear carries no SHA; merge's ``confirm`` judges what landed), or it answered ``open`` and both
reads answered the same SHA (carried in Clear.head).
``Lags`` is both reads answering, with different SHAs. ``Gone`` is an open PR whose head repository
reads null, or whose ref read answers 404, which is also what a fork this token cannot see answers,
so its text says both. Anything else -- a read that failed, a 4xx other than that 404, a 200 of a
shape outside these fields (a jq error on it included), a head repository that is no ``owner/name``
-- is ``Unread``, and never ``Clear``: unknown does not read as agreement.

What each command does with it: ``status`` and ``watch`` warn and go on, and a ``Lags``, ``Gone`` or
``Unread`` puts its mark in front of an ``approved`` line, so an approval of a head that is not the
branch's never stands unqualified. ``merge`` refuses (``merge.py``'s ``branch_tip_gate``).

WHERE THE GUARANTEE STOPS. This compares two reads at one moment, and says nothing of the moment
after. A push landing after the read is ``merge``'s existing head pin to catch
(``--match-head-commit``), which GitHub checks against the PR's head: it refuses a push the PR has
picked up, and cannot refuse one the PR is lagging behind. So a push that lands between this read
and the merge call AND lags stays unseen; the window is that of one call, and no read here can close
it. Nor does anything here wake a stuck PR: an amend and a force-push is what has.
"""

import re
from dataclasses import dataclass

from ludics.prreview.core import GhFailed, GhOk, GhSession, GhUnanswered
from ludics.prreview.shtext import encode_ref, tab_fields
from ludics.prreview.state import State

# The state, the head, its branch and its repository, one read. `-` for a field the PR lacks.
PR_JQ = '[(.state // "-"), (.head.sha // "-"), (.head.ref // "-"), (.head.repo.full_name // "-")] | @tsv'
REF_JQ = '.object.sha // "-"'
_OWNER_NAME = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


@dataclass(frozen=True)
class Clear:
    """Agreement at ``head``, or a closed PR (empty head: no comparison occurred)."""

    head: str = ""


@dataclass(frozen=True)
class Lags:
    head: str
    tip: str
    branch: str
    head_repo: str


@dataclass(frozen=True)
class Gone:
    head: str
    branch: str
    head_repo: str  # "-" when the PR's head repository reads null


@dataclass(frozen=True)
class Unread:
    why: str


type Tip = Clear | Lags | Gone | Unread


def read_tip(session: GhSession, repo: str, pr: str) -> Tip:
    pull = session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", PR_JQ])
    if not isinstance(pull, GhOk):
        return Unread(f"the PR read failed: {session.err_line()}")
    state, head, branch, head_repo = tab_fields(pull.stdout, 4)
    if state == "closed":
        return Clear()
    if state != "open" or head in ("", "-") or branch in ("", "-"):
        return Unread(f"the PR read answered state={state or '-'} head={head or '-'} branch={branch or '-'}")
    if head_repo == "-":
        return Gone(head, branch, head_repo)
    if not _OWNER_NAME.fullmatch(head_repo):
        return Unread(f"the PR read answered no head repository ({head_repo or '-'})")
    ref = session.retry(
        "read", ["api", f"repos/{head_repo}/git/ref/heads/{encode_ref(branch)}", "--jq", REF_JQ]
    )
    match ref:
        case GhOk(stdout=tip):
            if tip in ("", "-") or len(tip.split()) != 1:
                return Unread(f"the refs API answered no SHA for {branch} on {head_repo}")
            return Clear(head) if tip == head else Lags(head, tip, branch, head_repo)
        case GhFailed() if "HTTP 404" in session.err_line():
            return Gone(head, branch, head_repo)
        case GhFailed() | GhUnanswered():
            return Unread(f"the refs read failed: {session.err_line()}")


def mark(tip: Tip) -> str:
    """The short mark in front of an approval; empty when there is nothing to qualify."""
    match tip:
        case Clear():
            return ""
        case Lags():
            return f"HEAD IS NOT THE BRANCH'S (PR head {tip.head}, branch tip {tip.tip})"
        case Gone():
            return f"BRANCH GONE (PR head {tip.head}, no tip to compare it with)"
        case Unread():
            return "BRANCH TIP UNREAD (so this head is not known to be the branch's)"


def warning(tip: Tip, repo: str, pr: str) -> str:
    """The warning, naming both SHAs where there are two; empty on ``Clear``. It says what is known,
    and each caller says what it does about it."""
    where = f"{repo}#{pr}"
    match tip:
        case Clear():
            return ""
        case Lags():
            return (
                f"{where}'s head {tip.head} is NOT its branch's tip: {tip.branch} on {tip.head_repo}"
                f" stands at {tip.tip}. GitHub has not moved the PR to that push, or it landed just"
                " now, so anything read for this PR is about a head that is no longer the branch's."
                " Read it again in a minute; a lag that stands has been cleared by a new push (git"
                " commit --amend --no-edit && git push --force-with-lease)."
            )
        case Gone():
            what = (
                f"its branch {tip.branch} is gone from {tip.head_repo}, or that repository is not"
                " visible to this token"
                if tip.head_repo != "-" else "its head repository is gone"
            )
            return f"{where}'s head {tip.head} has no branch tip to agree with: {what}."
        case Unread():
            return f"whether {where}'s head is its branch's tip is UNREAD ({tip.why}), which is not agreement."


def qualified(state: State, line: str, tip: Tip) -> str:
    """A state line as an exit reports it: an approval carries ``tip``'s mark in front, where a reader
    of the first word cannot take it for a plain one."""
    if state.tok not in ("approved", "unresolved") or not mark(tip):
        return line
    return f"{mark(tip)}: {line}"
