"""The reads a watch round shares with the state beside it: the round snapshot, the head read, a
review's own comments, and the substantive-review filter.

Ported from pr-review.sh's "round snapshot" section (``snapshot_*``, ``state_comments``,
``state_reviews``, ``state_head_read``, ``review_comments``), ``pr_head_read`` and
``substantive_reviews``. The shell kept the snapshot in FILES because every reader ran inside a
command substitution; here it is the ``Snapshot`` object the watch holds, with the same three
rules: it is armed only inside a watch round; a part is served only when it is about the PR asked
for; and only a read that answered is published, a failed round dropping what it had.

One shell detail is kept on purpose: dropping a round (``snapshot_drop``) empties it but leaves it
ARMED, so a review's comments read after the drop are still cached for the rest of that round.
"""

import os
from dataclasses import dataclass, field
from typing import assert_never

from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhSession,
    GhUnanswered,
    Json,
    ListOk,
    ListUnparsed,
    api_list,
)
from ludics.prreview import knobs
from ludics.prreview.clock import Clock, clock_from_env
from ludics.prreview.shtext import tab_fields
from ludics.prreview.threads import OpenThreads
from ludics.prreview.jqsem import (
    JqError,
    as_list,
    body_of,
    idx,
    jstr,
    login_is,
    onig,
    sub_once,
    test,
    type_name,
)


@dataclass(frozen=True)
class Head:
    """``pr_head_read``'s four variables: the head SHA ("" when the read failed), the
    mergeability ("unread" when it failed, "-" when the PR carried none), the PR's creation ("" when
    absent), and the error line of a failed read."""

    sha: str
    mstate: str
    created: str
    err: str


@dataclass
class Snapshot:
    armed: bool = False
    feeds_pr: str = ""
    comments: list[Json] = field(default_factory=lambda: list[Json]())
    reviews: list[Json] = field(default_factory=lambda: list[Json]())
    head_pr: str = ""
    head: Head | None = None
    review_cache: dict[str, list[Json]] = field(default_factory=lambda: dict[str, list[Json]]())
    # The round's review-threads walk, once one answered whole (state.state_threads): the approval
    # gate and the exit's thread count share it.
    threads_pr: str = ""
    threads: OpenThreads | None = None

    def clear(self) -> None:
        self.feeds_pr = ""
        self.comments = []
        self.reviews = []
        self.head_pr = ""
        self.head = None
        self.review_cache = {}
        self.threads_pr = ""
        self.threads = None

    def arm(self) -> None:
        """``snapshot_arm``: a new round, nothing observed before it readable as part of it."""
        self.clear()
        self.armed = True

    def drop(self) -> None:
        """``snapshot_drop``: the round ended without an observation worth sharing."""
        self.clear()

    def off(self) -> None:
        """``snapshot_off``: the watch is over."""
        self.armed = False
        self.clear()

    def put_feeds(self, pr: str, comments: list[Json], reviews: list[Json]) -> None:
        if not self.armed:
            return
        self.comments = comments
        self.reviews = reviews
        self.feeds_pr = pr

    def put_head(self, pr: str, head: Head) -> None:
        if not self.armed:
            return
        self.head = head
        self.head_pr = pr

    def has_feeds(self, pr: str) -> bool:
        return self.armed and self.feeds_pr == pr

    def has_head(self, pr: str) -> bool:
        return self.armed and self.head is not None and self.head_pr == pr


@dataclass
class Ctx:
    """What every read of one watch shares: the gh session, the repository and the reviewer, the
    clock, how long a live 👀 may run before it is stalled (STALL), the round snapshot, and -- inside a watch only -- the issue-comment watermark the watch
    started from, which the state reads its pending request against (``watch_nudge_after``, a
    watch_loop local the shell's status_state reached by dynamic scoping)."""

    session: GhSession
    repo: str
    reviewer: str
    clock: Clock
    stall: int
    snap: Snapshot = field(default_factory=Snapshot)
    nudge_after: int | None = None
    # The pickup margin (knobs.pickup): how long a head is new enough that a 👀 older than it is
    # not yet read as its stall.
    pickup: int = knobs.PICKUP
    # Head commits' committer dates as they answered, by SHA: a commit's date never changes, so a
    # watch reads each head's once (state._commit_read).
    commit_dates: dict[str, str] = field(default_factory=lambda: dict[str, str]())
    # The head the state was last read against (state_head_read), for ``status``'s thread count.
    head_seen: Head | None = None


class ReadFailed(Exception):
    """A feed read failed: ``api_list``'s nonzero status. The caller words what it means."""


def outside_watch(session: GhSession, repo: str, nudge_after: int | None = None) -> Ctx:
    """The reads' context for ``status``, ``rounds`` and ``poll``: no round snapshot (never
    armed), the clock SHIP_PR_TEST_CLOCK names, STALL as the shell resolved it."""
    env = os.environ
    grace, stall = knobs.review_clocks(env)
    return Ctx(session, repo, session.config.reviewer, clock_from_env(env), stall,
               nudge_after=nudge_after, pickup=knobs.pickup(grace))


def feed(ctx: Ctx, path: str) -> list[Json]:
    """``api_list``: the whole feed, or ``ReadFailed``."""
    result = api_list(ctx.session, path, ctx.repo)
    match result:
        case ListOk(items=items):
            return items
        case GhFailed() | GhUnanswered() | ListUnparsed():
            raise ReadFailed()
        case _:
            assert_never(result)


def state_comments(ctx: Ctx, pr: str) -> list[Json]:
    if ctx.snap.has_feeds(pr):
        return ctx.snap.comments
    return feed(ctx, f"issues/{pr}/comments?per_page=100")


def state_reviews(ctx: Ctx, pr: str) -> list[Json]:
    if ctx.snap.has_feeds(pr):
        return ctx.snap.reviews
    return feed(ctx, f"pulls/{pr}/reviews?per_page=100")


# pr_head_read's projection: the head, the mergeability and the PR's creation, one read.
HEAD_JQ = '[(.head.sha // "-"), (.mergeable_state // "-"), (.created_at // "-")] | @tsv'


def pr_head_read(ctx: Ctx, pr: str) -> Head:
    result = ctx.session.retry("read", ["api", f"repos/{ctx.repo}/pulls/{pr}", "--jq", HEAD_JQ])
    match result:
        case GhOk(stdout=line):
            sha, mstate, created = tab_fields(line, 3)
            return Head(
                sha="" if sha == "-" else sha,
                mstate=mstate or "-",
                created="" if (created or "-") == "-" else created,
                err="",
            )
        case GhFailed() | GhUnanswered():
            return Head(sha="", mstate="unread", created="", err=ctx.session.err_line())
        case _:
            assert_never(result)


def state_head_read(ctx: Ctx, pr: str) -> Head:
    if ctx.snap.has_head(pr) and ctx.snap.head is not None:
        h = ctx.snap.head
        head = Head(h.sha, h.mstate or "-", h.created, h.err)
    else:
        head = pr_head_read(ctx, pr)
    ctx.head_seen = head
    return head


def review_comments(ctx: Ctx, pr: str, review_id: str) -> list[Json]:
    """A review's own comments endpoint, read at most once per round for a given review: only a
    read that answered is cached, so a failure is never served as a review with no findings."""
    path = f"pulls/{pr}/reviews/{review_id}/comments?per_page=100"
    if not review_id.isdigit() or not review_id.isascii():
        return feed(ctx, path)
    if ctx.snap.armed and review_id in ctx.snap.review_cache:
        return ctx.snap.review_cache[review_id]
    out = feed(ctx, path)
    if ctx.snap.armed:
        ctx.snap.review_cache[review_id] = out
    return out


# The connector's FIXED replies (ludics-lite#472): an envelope whose comments are all such replies
# is no review with findings either (substantive_reviews). A mention of '@codex' in a review thread
# draws the connector's answer INTO that thread, and GitHub files a thread reply as an
# empty-bodied COMMENTED review on the head, so the envelope test once passed it as findings: on PR #465 one quoted '@codex review' drew inline comment 4138519259, and
# `watch` reported "opened round 5 of 12" over a round that never ran. Both the count and the
# state read through here, so for both it is not a review of that head.
#
# Boundary, as a fail-closed allowlist: CONNECTOR_FIXED_REPLIES holds the verbatim bodies of the
# replies seen, and a comment matches only when it IS a thread reply (a numeric `in_reply_to_id`,
# which the review's own comments endpoint serves) and its body, trailing whitespace aside, EQUALS
# one of them. A top-level comment carrying that text is a finding, not this reply (review of #488,
# round 1). One body today, taken from comment 4138519259 and the same answer the connector gave six
# times in threads of PR #82 (every connector thread reply on this repository and
# ocannl-staging, read 2026-10-01). Not read: the comment's author (a review's comments are its
# author's), any other wording, a body that quotes or extends one of these, and an envelope
# mixing one with anything else, all of which stay findings. A new fixed reply counts as a round
# until its body is added here, loudly; a finding swallowed by a looser match would not be seen.
CONNECTOR_FIXED_REPLIES = (
    "To use Codex here, [create an environment for this repo]"
    "(https://chatgpt.com/codex/cloud/settings/environments).",
)
_NON_SPACE = onig("[^[:space:]]")
_TRAILING_SPACE = onig("[[:space:]]+\\z")


class NotSubstantive(Exception):
    """``substantive_reviews`` returned 1: the review comments could not establish which reviews
    carry findings."""


def _fixed_reply(comment: Json) -> bool:
    in_reply = idx(comment, "in_reply_to_id")
    if not isinstance(in_reply, (int, float)) or isinstance(in_reply, bool):
        return False
    body = idx(comment, "body")
    if not isinstance(body, str):
        return False
    return sub_once(body, _TRAILING_SPACE, "") in CONNECTOR_FIXED_REPLIES


def substantive_reviews(ctx: Ctx, pr: str, raw: list[Json]) -> list[Json]:
    """The reviews feed minus the empty-bodied COMMENTED envelopes whose own comments carry no
    finding: none at all (#88), or only the connector's fixed thread replies (#472)."""
    try:
        ids: list[str] = []
        for r in raw:
            if not login_is(r, ctx.reviewer):
                continue
            if not (idx(r, "state") == "COMMENTED" and idx(r, "submitted_at") is not None):
                continue
            if test(body_of(r), _NON_SPACE):
                continue
            ids.append(jstr(idx(r, "id")))
    except JqError:
        raise NotSubstantive() from None
    for line in "\n".join(ids).split("\n"):
        rid = line
        if not rid:
            continue
        if not (rid.isdigit() and rid.isascii()):
            raise NotSubstantive()
        try:
            inline = review_comments(ctx, pr, rid)
        except ReadFailed:
            raise NotSubstantive() from None
        try:
            fixed = all(_fixed_reply(c) for c in as_list(inline))
        except JqError:
            fixed = False
        if fixed:
            num = int(rid)
            kept: list[Json] = []
            for r in raw:
                try:
                    rid_value = idx(r, "id")
                except JqError:
                    raise NotSubstantive() from None
                if not (type_name(rid_value) == "number" and rid_value == num):
                    kept.append(r)
            raw = kept
    return raw

