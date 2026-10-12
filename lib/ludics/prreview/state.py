"""The reviewer's state as `status` and every `watch` exit report it.

Ported from pr-review.sh's ``status_state`` (the state machine over the reactions, the reviews,
the comments and the head), ``status_line`` and ``conflict_note`` (its rendering), the open-thread
check an approval passes through (``threads_walk``, ``unresolved_threads``, ``threads_named``,
``approval_gate``, ``gated_state``) and ``review_rounds``/``count_token``. The shell's comments on
each carry the incidents behind every comparison; the order of the reads and of the arms below is
theirs, and it is load-bearing (the head is read AFTER the feeds; the comments BEFORE the reviews).

A state line was ``token|age|mergeability|detail``. Here it is ``State``; ``detail`` keeps the
shell's string, with the leading ``|`` fields the ``failed``, ``nudged`` and ``unresolved`` tokens
carry.
"""

import os
from dataclasses import dataclass
from typing import Literal, assert_never

from ludics.prreview import knobs
from ludics.prreview.core import GhFailed, GhOk, GhUnanswered, Json
from ludics.prreview.clock import age_of, age_text, fmt_age, freshest_age, newest
from ludics.prreview.threads import (
    OpenThreads,
    WalkRejected,
    WalkUnread,
    threads_advice,
    threads_named,
    unresolved_threads,
)
from ludics.prreview.feeds import (
    Ctx,
    Head,
    NotSubstantive,
    ReadFailed,
    feed,
    state_comments,
    state_head_read,
    state_reviews,
    substantive_reviews,
)
from ludics.prreview.jqsem import (
    JqError,
    alt,
    as_list,
    body_of,
    capture_all,
    capture_first,
    cmp,
    fromdateiso8601,
    ge,
    gt,
    idx,
    jmax,
    jstr,
    login_is,
    lt,
    max_by,
    onig,
    sort_by,
    startswith,
    string,
    sub_once,
    unique,
)
from ludics.prreview.poll import REVIEWED_COMMIT_RE

type Token = Literal[
    "approved", "unresolved", "reviewing", "stalled", "failed", "expected", "idle", "nudged",
    "unknown",
]


@dataclass(frozen=True)
class State:
    tok: Token
    age: int | None
    merge: str
    detail: str

    def line(self) -> str:
        return f"{self.tok}|{age_text(self.age)}|{self.merge}|{self.detail}"


def unknown(merge: str, detail: str) -> State:
    return State("unknown", None, merge, detail)


# --- the patterns (pr-review.sh's "reviewer state" constants) ----------------------------------------

INIT_FAILURE_GIT_RE = (
    r"\A[ \t]*Codex Review:[ \t]*Something went wrong\.[ \t]*Try again later by commenting"
    r"[^\n]{0,4}@codex review"
)
INIT_FAILURE_ENV_RE = (
    r"\A[ \t]*To use Codex here,[ \t]*\[?create an environment for this repo"
    r"(?:\]\([^)[:space:]]*\))?\.?[[:space:]]*\z"
)
_INIT_FAILURE = onig(f"(?:{INIT_FAILURE_GIT_RE})|(?:{INIT_FAILURE_ENV_RE})")
_INIT_FAILURE_ENV = onig(INIT_FAILURE_ENV_RE)
_INIT_FAILURE_REF = onig(r"Provided git ref[^0-9a-f]*(?<s>[0-9a-f]{7,40})")
# The summary comment's Code Review row, in jq's regex dialect: compiled here (onig), and asked for
# verbatim by pr-review-api-contract.sh, which pins the live rows against the gate's own patterns.
# The emoji are literal characters, which both dialects read the same.
SUMMARY_COMPLETED_ROW_RE = (
    '^\\|[^|]*Code Review[^|]*\\| *\u2705 \\*\\*Completed\\*\\* <relative-time datetime="(?<at>[^"]+)">'
    "[^<|]*</relative-time> *\\| *`(?<sha>[0-9a-f]{7,40})` *\\|"
)
SUMMARY_FAILED_ROW_RE = (
    '^\\|[^|]*Code Review[^|]*\\| *\u26a0\ufe0f \\*\\*Failed\\*\\* <relative-time datetime="(?<at>[^"]+)">'
    "[^<|]*</relative-time> *\\| *`(?<sha>[0-9a-f]{7,40})` *\\|"
)
SUMMARY_ROW_STAMP_RE = 'datetime="(?<at>[^"]+)"[^|]*\\| *`(?<sha>[0-9a-f]{7,40})` *\\|'
_SUMMARY_COMPLETED_ROW = onig(SUMMARY_COMPLETED_ROW_RE)
_SUMMARY_FAILED_ROW = onig(SUMMARY_FAILED_ROW_RE)
_SUMMARY_ROW_STAMP = onig(SUMMARY_ROW_STAMP_RE)
_CODE_REVIEW_ROW = onig(r"^\|[^|]*Code Review[^|]*\|")
_RUNNING_ROW = onig(r"^\|[^|]*Code Review[^|]*\|[^|]*Running")
_NO_FINDINGS = onig("[Dd]idn.t find any major issues")
_NUDGE = onig(
    "^@codex review[ \t\r\n]*(_\U0001f916 Addressed by an automated coding agent_)?[ \t\r\n]*$"
)
_REQUEST = onig("@codex[[:space:]]+review", 2)  # re.IGNORECASE
_FRACTION_Z = onig(r"\.[0-9]+Z$")
_TRAILING_Z = onig("Z$")
_SUMMARY_TAG = "codex-pull-request-review-summary"


def instant(at: Json) -> str:
    """``SUMMARY_ROW_INSTANT_DEF``: a row's datetime padded to nine fractional digits, so the
    string order is the time order."""
    s = sub_once(at, _TRAILING_Z, "")
    s = s if "." in s else s + "."
    return (s + "000000000")[:29]


def _commit_read(ctx: Ctx, sha: str) -> str:
    """The head commit's committer date, or "" when the read failed."""
    result = ctx.session.retry(
        "read", ["api", f"repos/{ctx.repo}/commits/{sha}", "--jq", ".commit.committer.date"]
    )
    match result:
        case GhOk(stdout=out):
            return out
        case GhFailed() | GhUnanswered():
            return ""
        case _:
            assert_never(result)


def _after_nudge(event: str, nudge: str) -> bool:
    """``review_after_nudge``: no request pending, or the event is newer than it."""
    return not nudge or event > nudge


def _is_summary(item: Json) -> bool:
    return _SUMMARY_TAG in body_of(item)


def _stamp_rows(body: str) -> list[dict[str, str | None] | None]:
    return [
        capture_first(row, _SUMMARY_ROW_STAMP)
        for row in body.split("\n")
        if _CODE_REVIEW_ROW.search(row)
    ]


def _newest_summary(comments: list[Json], reviewer: str) -> Json:
    summaries = [c for c in comments if login_is(c, reviewer) and _is_summary(c)]
    return max_by(summaries, lambda c: alt(idx(c, "updated_at"), idx(c, "created_at")))


def _short(sha: str) -> str:
    return sha[:7]


def _review_of_head_at(reviews: list[Json], reviewer: str, sha: str) -> str:
    """The newest submitted review of exactly this head, or ""."""
    ats = [
        idx(r, "submitted_at")
        for r in reviews
        if login_is(r, reviewer)
        and idx(r, "submitted_at") is not None
        and alt(idx(r, "commit_id"), "") == sha
    ]
    return jstr(alt(jmax(ats), ""))


def status_state(ctx: Ctx, pr: str) -> State:
    """``status_state <pr>``: one ``State``, never an exception for anything the API did -- an
    unanswered read is the ``unknown`` token, which is NOT a state of the PR."""
    session = ctx.session
    rev = ctx.reviewer
    grace_stall = ctx.stall
    try:
        reactions = feed(ctx, f"issues/{pr}/reactions?per_page=100")
    except ReadFailed:
        return unknown("-", f"the reactions API did not answer ({session.err_line()})")
    try:
        mine = [r for r in reactions if login_is(r, rev)]
        plus = any(idx(r, "content") == "+1" for r in mine)
        # `"|" + (max // "")`: a newest stamp that is not a string fails the program.
        eyes_at = string(alt(jmax([idx(r, "created_at") for r in mine if idx(r, "content") == "eyes"]), ""))
        plus_at = string(alt(jmax([idx(r, "created_at") for r in mine if idx(r, "content") == "+1"]), ""))
    except JqError:
        return unknown("-", "the reactions feed did not parse")

    mstate = "-"
    comments: list[Json] = []
    comments_loaded = False
    reviews: list[Json] = []
    reviews_loaded = False
    head: Head | None = None
    head_at = ""
    head_at_read = False
    nudge_at = ""
    nudge_id = ""
    stale_plus_at = ""
    stale_note = ""

    if ctx.nudge_after is not None:
        try:
            comments = state_comments(ctx, pr)
        except ReadFailed:
            return unknown("-", f"the comments API did not answer ({session.err_line()})")
        comments_loaded = True
        try:
            requests: list[tuple[Json, Json]] = []
            for c in comments:
                if gt(idx(c, "id"), ctx.nudge_after) and _NUDGE.search(body_of(c)):
                    requests.append((idx(c, "id"), idx(c, "created_at")))
            latest = max_by(requests, lambda r: r[1])
        except JqError:
            return unknown("-", "the pending-request comments feed did not parse")
        if latest is not None:
            nudge_id, nudge_at = jstr(latest[0]), jstr(latest[1])
        if age_of(nudge_at, ctx.clock.time()) is None:
            nudge_at = ""

    if plus and _after_nudge(plus_at, nudge_at):
        if not comments_loaded:
            try:
                comments = state_comments(ctx, pr)
                comments_loaded = True
            except ReadFailed:
                comments = []
        try:
            reviews = state_reviews(ctx, pr)
            reviews_loaded = True
        except ReadFailed:
            reviews = []
        try:
            reviews = substantive_reviews(ctx, pr, reviews)
        except NotSubstantive:
            return unknown(mstate, "the review comments API did not establish substantive reviews")
        head = state_head_read(ctx, pr)
        mstate = head.mstate
        try:
            kind, ev_at, running_unread, row_sha = _evidence(comments, reviews, rev, head.sha)
        except JqError:
            return unknown(mstate, "the current-head review evidence did not parse")
        if running_unread != 0:
            return unknown(
                mstate,
                f"a {rev} Code Review row matched the Running test but not the"
                " SUMMARY_ROW_STAMP_RE, so the running round could not be read",
            )
        if ev_at and ev_at > plus_at:
            if kind == "running":
                age = age_of(ev_at, ctx.clock.time())
                detail = f"{rev} Code Review Running for head {_short(head.sha)} at {ev_at}"
                if age is not None and age >= grace_stall:
                    return State("stalled", age, mstate, detail)
                return State("reviewing", age, mstate, detail)
            if kind == "findings":
                return State(
                    "idle", age_of(ev_at, ctx.clock.time()), mstate,
                    f"{rev} posted findings for head {_short(head.sha)} at {ev_at}",
                )
        if head.sha:
            if row_sha:
                if not head.sha.startswith(row_sha):
                    stale_note = f"the 👍 at {plus_at} is for {_short(row_sha)}, per {rev}'s summary"
            else:
                head_at = _commit_read(ctx, head.sha)
                head_at_read = True
                if age_of(head_at, ctx.clock.time()) is not None and plus_at < head_at:
                    stale_note = (
                        f"the 👍 at {plus_at} predates head {_short(head.sha)}'s commit date {head_at}"
                    )
        if not stale_note:
            return State("approved", None, mstate, f"👍 from {rev}")
        stale_plus_at = plus_at

    if not comments_loaded:
        try:
            comments = state_comments(ctx, pr)
        except ReadFailed:
            return unknown(mstate, f"the comments API did not answer ({session.err_line()})")
        comments_loaded = True
        reviews_loaded = False

    if not reviews_loaded:
        try:
            reviews = state_reviews(ctx, pr)
        except ReadFailed:
            return unknown(mstate, f"the reviews API did not answer ({session.err_line()})")
        try:
            reviews = substantive_reviews(ctx, pr, reviews)
        except NotSubstantive:
            return unknown(mstate, "the review comments API did not establish substantive reviews")

    try:
        submitted = sort_by(
            [r for r in reviews if login_is(r, rev) and idx(r, "submitted_at") is not None],
            lambda r: idx(r, "submitted_at"),
        )
        last_review = submitted[-1] if submitted else None
        rev_at = jstr(idx(last_review, "submitted_at")) if last_review is not None else ""
        rev_sha = jstr(alt(idx(last_review, "commit_id"), "")) if last_review is not None else ""
    except JqError:
        return unknown(mstate, "the reviews feed did not parse")

    try:
        com_at = jstr(alt(jmax([
            idx(c, "created_at") for c in comments if login_is(c, rev) and not _is_summary(c)
        ]), ""))
    except JqError:
        return unknown(mstate, "the comments feed did not parse")

    try:
        verdicts = [
            (alt(idx(c, "updated_at"), idx(c, "created_at")), _first_stamp(c))
            for c in comments
            if login_is(c, rev) and _NO_FINDINGS.search(body_of(c))
        ]
        verdict = sort_by(verdicts, lambda v: v[0])
        verd_at = jstr(verdict[-1][0]) if verdict else ""
        verd_sha = jstr(verdict[-1][1]) if verdict else ""
    except JqError:
        return unknown(mstate, "the verdict comments feed did not parse")

    try:
        done_kind, done_at, done_sha = _done_row(comments, rev)
    except JqError:
        return unknown(mstate, "the summary comments feed did not parse")

    try:
        fail_at, fail_ref, fail_kind = _init_failure(comments, rev)
    except JqError:
        return unknown(mstate, "the initialization-failure comments feed did not parse")

    if not _after_nudge(eyes_at, nudge_at):
        eyes_at = ""
    if not _after_nudge(rev_at, nudge_at):
        rev_at, rev_sha = "", ""
    if not _after_nudge(com_at, nudge_at):
        com_at = ""
    if not _after_nudge(verd_at, nudge_at):
        verd_at, verd_sha = "", ""
    if not _after_nudge(fail_at, nudge_at):
        fail_at, fail_ref, fail_kind = "", "", ""
    last_spoke = newest(rev_at, com_at, stale_plus_at)

    if head is None:
        head = state_head_read(ctx, pr)
        mstate = head.mstate
    head_sha = head.sha

    if verd_sha and head_sha and (not eyes_at or verd_at > eyes_at) and head_sha.startswith(verd_sha):
        return State(
            "approved", None, mstate,
            f"{rev} posted a no-findings verdict for head {_short(head_sha)} at {verd_at}",
        )

    if (
        done_kind == "completed" and done_sha and head_sha and eyes_at and done_at > eyes_at
        and (not last_spoke or last_spoke < eyes_at) and head_sha.startswith(done_sha)
    ):
        return State(
            "approved", None, mstate,
            f"{rev}'s summary marks head {_short(head_sha)}'s Code Review Completed at {done_at},"
            f" with nothing posted since its 👀 at {eyes_at} (no 👍 was given)",
        )

    if (
        done_kind == "failed" and done_sha and head_sha and not plus
        and age_of(done_at, ctx.clock.time()) is not None
        and _after_nudge(done_at, nudge_at) and (not eyes_at or eyes_at < done_at)
    ):
        if head_sha.startswith(done_sha):
            if eyes_at:
                if not (not last_spoke or last_spoke < eyes_at):
                    done_kind = ""
            else:
                if not (not last_spoke or last_spoke < done_at):
                    done_kind = ""
                try:
                    rev_head_at = _review_of_head_at(reviews, rev, head_sha)
                except JqError:
                    return unknown(mstate, "the reviews feed did not parse for the failed run's head")
                if rev_head_at:
                    done_kind = ""
        else:
            done_kind = ""
    else:
        done_kind = ""
    if done_kind == "failed":
        if not head_at_read:
            head_at = _commit_read(ctx, head_sha)
            head_at_read = True
        floor = _arrival_floor(ctx, head_at, head.created)
        try:
            asked = _requests(comments, rev)
            req_after = any(ge(a, done_at) for a in asked)
            req_before = jstr(alt(jmax([a for a in asked if ge(a, floor) and lt(a, done_at)]), ""))
        except JqError:
            return unknown(mstate, "the review-request comments feed did not parse")
        if not req_after:
            age = age_of(done_at, ctx.clock.time())
            if req_before:
                return State(
                    "failed", age, mstate,
                    f"{_short(head_sha)}|run-again|{rev}'s summary marks head {_short(head_sha)}'s"
                    f" Code Review Failed at {done_at}, after the '@codex review' request at"
                    f" {req_before} on this head, with no review of it and no 👍",
                )
            return State(
                "failed", age, mstate,
                f"{_short(head_sha)}|run|{rev}'s summary marks head {_short(head_sha)}'s Code Review"
                f" Failed at {done_at}, with no review of it, no 👍, and no '@codex review' on it"
                " since it arrived",
            )

    if eyes_at and eyes_at > last_spoke:
        age = age_of(eyes_at, ctx.clock.time())
        if age is not None and age >= grace_stall:
            return State("stalled", age, mstate, f"👀 from {rev} at {eyes_at} with nothing posted since")
        since = f" ({last_spoke})" if last_spoke else ""
        return State("reviewing", age, mstate, f"👀 from {rev} at {eyes_at}, newer than its last word{since}")

    if not head_sha:
        return unknown("unread", f"the pulls API did not answer for the head SHA ({head.err})")

    fail_head = ""
    if fail_at and fail_ref:
        if head_sha.startswith(fail_ref):
            fail_head = f"for ref {_short(fail_ref)}"
    elif fail_at and fail_kind == "env":
        if not head_at_read:
            head_at = _commit_read(ctx, head_sha)
            head_at_read = True
        if (
            age_of(head_at, ctx.clock.time()) is not None and fail_at > head_at
            and (not head.created or (age_of(head.created, ctx.clock.time()) is not None and fail_at > head.created))
        ):
            fail_head = f"after head {_short(head_sha)}'s commit date {head_at}"
    if fail_head:
        try:
            rev_head_at = _review_of_head_at(reviews, rev, head_sha)
        except JqError:
            return unknown(mstate, "the reviews feed did not parse for the failed head")
        if not rev_head_at or fail_at > rev_head_at:
            return State(
                "failed", age_of(fail_at, ctx.clock.time()), mstate,
                f"{_short(head_sha)}|{fail_kind}|{rev} reported an initialization failure at"
                f" {fail_at} {fail_head}",
            )

    if verd_sha and not verd_at < last_spoke and head_sha.startswith(verd_sha):
        return State(
            "approved", None, mstate,
            f"{rev} posted a no-findings verdict for head {_short(head_sha)} at {verd_at}",
        )

    if rev_sha == head_sha:
        return State(
            "idle", age_of(last_spoke, ctx.clock.time()), mstate, f"{rev} reviewed head {_short(head_sha)} at {rev_at}"
        )

    if not head_at_read:
        head_at = _commit_read(ctx, head_sha)
    if nudge_at:
        return State(
            "nudged", freshest_age(nudge_at, head_at, head.created, now=ctx.clock.time()), mstate,
            f"{nudge_id}|fresh review nudge; waiting for pickup",
        )
    last = f"; {rev} last reviewed {_short(rev_sha)} at {rev_at}" if rev_sha else ""
    stale = f"; {stale_note}" if stale_note else ""
    return State(
        "expected", freshest_age(head_at, head.created, last_spoke, eyes_at, nudge_at, now=ctx.clock.time()), mstate,
        f"no 👀 in flight and no review of head {_short(head_sha)}{last}{stale}",
    )


def _arrival_floor(ctx: Ctx, head_at: str, created: str) -> str:
    """The earliest a request can be about the head: the newest of its commit's date and the PR's
    creation that the clock can read, or "" when neither reads, which counts every request -- the
    clock can only suppress a request, never license one."""
    floor = head_at if age_of(head_at, ctx.clock.time()) is not None else ""
    if created and age_of(created, ctx.clock.time()) is not None:
        floor = newest(floor, created)
    return floor


def _requests(comments: list[Json], rev: str) -> list[Json]:
    """When each '@codex review' request on the PR was made: anyone's comment but the reviewer's
    that carries one, quoted or not, since the connector reads it either way."""
    return [
        alt(idx(c, "created_at"), "")
        for c in comments
        if not login_is(c, rev) and _REQUEST.search(body_of(c))
    ]


@dataclass(frozen=True)
class NudgeClear:
    """Nothing stands for the head: the watch may post its one automatic request."""

    head: str


@dataclass(frozen=True)
class NudgeBarred:
    """Something stands for the head, or could not be read. ``asked`` is the time of the newest
    request already made on it when that is what stands ("" otherwise): the move after one is to
    wait out its grace, and then a new head, never a second request."""

    why: str
    asked: str = ""


type NudgeRead = NudgeClear | NudgeBarred


def nudge_read(ctx: Ctx, pr: str) -> NudgeRead:
    """May ``watch`` post its automatic '@codex review' for the head (ludics-lite#570)? Asked only
    after a fresh state read said ``expected`` -- no 👀 in flight, no review of the head, no
    no-findings verdict for it, no 👍 that approves it, no request pending in the watch -- and read
    from the same round's snapshot as that state.

    Boundary, fail-closed: CLEAR only when every read below answered and none of these is there --
    the reviewer's evidence for the head that ``_evidence`` reads (a Running row, a review, a
    comment stamped with the head, verdict or findings); the newest summary's Completed or Failed
    Code Review row naming the head; and a '@codex review' request by anyone, at or after the head's
    arrival (``_arrival_floor``), whatever the watch's watermark. That last one is the record that
    makes the nudge once per head across processes (a re-armed watch, another host) and that
    counts a hand nudge too, as the failed run's re-request counts its own (#453). Not read: the
    reactions (the state read just judged them), a request older than the head's arrival (an
    earlier head's), and the request's wording beyond the summon itself."""
    rev = ctx.reviewer
    try:
        comments = state_comments(ctx, pr)
    except ReadFailed:
        return NudgeBarred(f"the comments API did not answer ({ctx.session.err_line()})")
    try:
        reviews = substantive_reviews(ctx, pr, state_reviews(ctx, pr))
    except ReadFailed:
        return NudgeBarred(f"the reviews API did not answer ({ctx.session.err_line()})")
    except NotSubstantive:
        return NudgeBarred("the review comments API did not establish substantive reviews")
    head = state_head_read(ctx, pr)
    if not head.sha:
        return NudgeBarred(f"the pulls API did not answer for the head SHA ({head.err})")
    short = _short(head.sha)
    try:
        kind, ev_at, unread, _row = _evidence(comments, reviews, rev, head.sha)
        done_kind, done_at, done_sha = _done_row(comments, rev)
        asked = _requests(comments, rev)
    except JqError:
        return NudgeBarred("the reviewer's evidence for the head did not parse")
    if unread:
        return NudgeBarred(f"a {rev} Code Review Running row could not be read")
    if kind:
        return NudgeBarred(f"{rev} left {kind} evidence for head {short} at {ev_at}")
    if done_sha and head.sha.startswith(done_sha):
        return NudgeBarred(f"{rev}'s summary marks head {short}'s Code Review {done_kind} at {done_at}")
    floor = _arrival_floor(ctx, _commit_read(ctx, head.sha), head.created)
    try:
        since = [a for a in asked if ge(a, floor)]
        standing = jstr(alt(jmax(since), ""))
    except JqError:
        return NudgeBarred("the review-request comments feed did not parse")
    if since:
        return NudgeBarred(
            f"a '@codex review' request at {standing or 'an unread time'} already stands on head {short}",
            standing or "-",
        )
    return NudgeClear(head.sha)


def _first_stamp(c: Json) -> str:
    """``[(.body // "") | capture($rc).s] | first // ""``."""
    m = capture_first(body_of(c), REVIEWED_COMMIT_RE)
    return jstr(alt(m["s"] if m is not None else None, ""))


def _evidence(
    comments: list[Json], reviews: list[Json], rev: str, head_sha: str
) -> tuple[str, str, int, str]:
    """The 👍 path's read of the current head's newest evidence: (kind, at, the Running rows the
    stamp pattern could not read, the commit of the newest summary's newest Code Review row)."""
    mine = [c for c in comments if login_is(c, rev)]
    summaries = [c for c in mine if _SUMMARY_TAG in body_of(c)]
    running: list[dict[str, str | None] | None] = []
    for c in summaries:
        for row in body_of(c).split("\n"):
            if _RUNNING_ROW.search(row):
                running.append(capture_first(row, _SUMMARY_ROW_STAMP))
    newest_summary = max_by(summaries, lambda c: alt(idx(c, "updated_at"), idx(c, "created_at")))
    rows = [] if newest_summary is None else _stamp_rows(body_of(newest_summary))
    row_sha = ""
    if rows and all(r is not None for r in rows):
        best = max_by([r for r in rows if r is not None], lambda r: instant(r["at"]))
        row_sha = jstr(best["sha"]) if best is not None else ""
    candidates: list[tuple[Json, Json, str]] = []
    for r in running:
        if r is not None:
            candidates.append((r["sha"], r["at"], "running"))
    for r in reviews:
        if login_is(r, rev) and idx(r, "submitted_at") is not None:
            candidates.append((alt(idx(r, "commit_id"), ""), idx(r, "submitted_at"), "findings"))
    for c in mine:
        stamps = capture_all(body_of(c), REVIEWED_COMMIT_RE)
        sha: Json = alt(stamps[-1]["s"] if stamps else None, "")
        kind = "verdict" if _NO_FINDINGS.search(body_of(c)) else "findings"
        candidates.append((sha, alt(idx(c, "updated_at"), idx(c, "created_at")), kind))
    current: list[tuple[str, str]] = []
    for sha, at, kind in candidates:
        if sha != "" and head_sha != "" and startswith(head_sha, sha):
            current.append((sub_once(at, _FRACTION_Z, "Z"), kind))
    best_ev = max_by(current, lambda e: e[0])
    unread = sum(1 for r in running if r is None)
    if best_ev is None:
        return "", "", unread, row_sha
    return best_ev[1], best_ev[0], unread, row_sha


def _done_row(comments: list[Json], rev: str) -> tuple[str, str, str]:
    """The newest summary's newest Code Review row, when it is the allowlisted Completed or Failed
    shape: (kind, at with its fraction cut, sha), or empty fields."""
    newest_summary = _newest_summary(comments, rev)
    if newest_summary is None:
        return "", "", ""
    rows: list[tuple[str, str] | None] = []
    for row in body_of(newest_summary).split("\n"):
        if not _CODE_REVIEW_ROW.search(row):
            continue
        stamp = capture_first(row, _SUMMARY_ROW_STAMP)
        rows.append(None if stamp is None else (jstr(stamp["at"]), row))
    if not rows or any(r is None for r in rows):
        return "", "", ""
    best = max_by([r for r in rows if r is not None], lambda r: instant(r[0]))
    assert best is not None
    done = capture_first(best[1], _SUMMARY_COMPLETED_ROW)
    if done is not None:
        return "completed", sub_once(done["at"], _FRACTION_Z, "Z"), jstr(done["sha"])
    failed = capture_first(best[1], _SUMMARY_FAILED_ROW)
    if failed is not None:
        return "failed", sub_once(failed["at"], _FRACTION_Z, "Z"), jstr(failed["sha"])
    return "", "", ""


def _init_failure(comments: list[Json], rev: str) -> tuple[str, str, str]:
    """The reviewer's newest non-placeholder comment, when it is the initialization failure:
    (created_at, the ref it names or "", "env" | "git")."""
    words = sort_by(
        [c for c in comments if login_is(c, rev) and not _is_summary(c)],
        lambda c: idx(c, "created_at"),
    )
    if not words:
        return "", "", ""
    last = words[-1]
    body = body_of(last)
    if not _INIT_FAILURE.search(body):
        return "", "", ""
    ref = capture_first(body, _INIT_FAILURE_REF)
    kind = "env" if _INIT_FAILURE_ENV.search(body) else "git"
    return jstr(idx(last, "created_at")), jstr(alt(ref["s"] if ref is not None else None, "")), kind


# --- the rendering ----------------------------------------------------------------------------------


def conflict_note(merge: str, repo: str, pr: str) -> str:
    match merge:
        case "dirty":
            return (
                "CONFLICTS with the base (mergeable_state=dirty): GitHub cannot build this head"
                " merged with the current base, so no pull_request run tests that merge and the"
                " rounds' fixes go untested against it — merge the base in, resolve, and push"
                " before the next round"
            )
        case "unread":
            return (
                "mergeability UNREAD (the PR read did not answer): whether this PR conflicts with"
                " its base is unknown, which is not 'no' — retry status before acting on this line"
            )
        case "unknown":
            return (
                "mergeability NOT YET COMPUTED (mergeable_state=unknown, GitHub recomputes it"
                " after every push): a conflict this push caused would not show yet — re-read"
                " status in a minute"
            )
        case "draft":
            return (
                "DRAFT (mergeable_state=draft): a draft cannot be merged and no reviewer action"
                f" lands it — mark it ready (gh pr ready {pr or '<pr>'} --repo {repo}) when it is;"
                " the review rounds still count"
            )
        case _:
            return ""


def status_line(state: State, repo: str, pr: str) -> str:
    detail = state.detail
    if state.tok == "nudged":
        detail = detail.split("|", 1)[1] if "|" in detail else detail
    conflict = conflict_note(state.merge, repo, pr)
    c = f"; {conflict}" if conflict else ""
    p = pr or "<pr>"
    age = fmt_age(state.age)
    match state.tok:
        case "approved":
            return f"approved ({detail}){c}"
        case "unresolved":
            count, _, frest = detail.partition("|")
            approval, _, names = frest.partition("|") if "|" in frest else (frest, "", frest)
            return (
                f"approved ({approval}) BUT {count} review thread(s) still UNRESOLVED — NOT a"
                f" clean approval, and `merge` refuses it: {names}. {threads_advice(repo, pr)}{c}"
            )
        case "reviewing":
            return f"reviewing — {detail}, running {age} — wait it out{c}"
        case "stalled":
            return (
                f"STALLED — {detail} for {age}, longer than a round takes. FIRST read the PR feed"
                " yourself (retry --read pr view <pr> --comments): a verdict may have landed as a"
                " comment or a 👍 this state machine missed. Only if the feed truly has nothing for"
                " the current head, nudge with a '@codex review' comment — knowing a re-request"
                f" CLEARS the reviewer's existing 👍{c}"
            )
        case "failed":
            fsha, _, frest = detail.partition("|") if "|" in detail else (detail, "", detail)
            fkind, _, frest = frest.partition("|") if "|" in frest else (frest, "", frest)
            match fkind:
                case "run":
                    return (
                        f"reviewer's run FAILED on head {fsha} — no review and no 👍, so a"
                        " '@codex review' re-request clears nothing: `watch` posts it itself, once"
                        " per head, and keeps watching; outside a watch, post it (pr-review.sh"
                        f" comment {repo}#{p} '@codex review'). This is not a round — {frest},"
                        f" standing for {age}{c}"
                    )
                case "run-again":
                    return (
                        f"reviewer's run FAILED AGAIN on head {fsha} after a '@codex review'"
                        " request on it — not re-requested a second time: read the PR feed (retry"
                        " --read pr view <pr> --comments) for anything the reviewer said, then"
                        " push a new head (an amend suffices: git commit --amend --no-edit && git"
                        " push --force-with-lease) or hand it to the maintainer. This is not a"
                        f" round — {frest}, standing for {age}{c}"
                    )
                case "env":
                    return (
                        f"reviewer FAILED at initialization on head {fsha} — nudge it once with a"
                        f" '@codex review' comment (pr-review.sh comment {repo}#{p} '@codex"
                        ' review\'); the connector answered "To use Codex here, create an'
                        ' environment for this repo", which has cleared on one nudge before. If'
                        " the nudge draws the same answer, the environment is the maintainer's to"
                        " set up (https://chatgpt.com/codex/cloud/settings/environments) — no push"
                        f" of yours fixes it. This is not a round — {frest}, standing for {age}{c}"
                    )
                case _:
                    return (
                        f"reviewer FAILED at initialization on head {fsha} — nudge it once with a"
                        f" '@codex review' comment (pr-review.sh comment {repo}#{p} '@codex"
                        " review'); if the SAME head fails again, push a new head instead (an"
                        " amend suffices: git commit --amend --no-edit && git push"
                        " --force-with-lease), since the reviewer's clone is behind, not your push"
                        " — the ref it could not fetch is one the PR and git ls-remote both serve."
                        f" This is not a round — {frest}, standing for {age}{c}"
                    )
        case "expected" | "nudged":
            return f"review EXPECTED but not started — {detail}; due for {age}{c}"
        case "idle":
            if state.merge in ("dirty", "draft"):
                return f"nothing in flight — {detail}, and no 👍; {conflict}"
            return f"nothing in flight — {detail}, and no 👍; the next move is yours{c}"
        case "unknown":
            return f"UNKNOWN — {detail}; this is NOT 'not approved', retry{c}"
        case _:
            assert_never(state.tok)


# --- open review threads under an approval (ludics-lite#289) -----------------------------------------

def threads_page_cap() -> int:
    """THREADS_PAGE_CAP (knobs.threads_page_cap)."""
    return knobs.threads_page_cap(os.environ)


def approval_gate(ctx: Ctx, pr: str, state: State) -> State:
    """``approval_gate``: an ``approved`` state checked for open review threads (threads.py)."""
    if state.tok != "approved":
        return state
    read = unresolved_threads(ctx.session, ctx.repo, pr, threads_page_cap())
    match read:
        case WalkRejected(line=reason) | WalkUnread(line=reason):
            return unknown(
                state.merge,
                f"{reason}, so whether open review threads stand under this approval"
                f" ({state.detail}) is unknown",
            )
        case OpenThreads(rows=rows):
            if not rows:
                return state
            n, shown = threads_named(rows)
            return State("unresolved", None, state.merge, f"{n}|{state.detail}|{shown}")
        case _:
            assert_never(read)


def gated_state(ctx: Ctx, pr: str) -> State:
    return approval_gate(ctx, pr, status_state(ctx, pr))


# --- review rounds ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Rounds:
    """``review_rounds``'s "count|detail": ``count`` is None for unknown."""

    count: int | None
    detail: str

    def token(self) -> str:
        """``count_token``."""
        return "unknown" if self.count is None else str(self.count)


def review_rounds(
    ctx: Ctx, pr: str, round_gap: int, icap: int | None = None, rcap: int | None = None
) -> Rounds:
    rev = ctx.reviewer
    try:
        raw = state_reviews(ctx, pr)
    except ReadFailed:
        return Rounds(None, f"the reviews API did not answer ({ctx.session.err_line()})")
    try:
        raw = substantive_reviews(ctx, pr, raw)
    except NotSubstantive:
        return Rounds(None, "the review comments API did not establish substantive reviews")
    try:
        comments = state_comments(ctx, pr)
    except ReadFailed:
        return Rounds(None, f"the comments API did not answer ({ctx.session.err_line()})")
    try:
        events: list[tuple[Json, int]] = []
        for r in raw:
            if not login_is(r, rev):
                continue
            if rcap is not None and not ge(rcap, alt(idx(r, "id"), 0)):
                continue
            if idx(r, "submitted_at") is None:
                continue
            if idx(r, "state") not in ("COMMENTED", "CHANGES_REQUESTED"):
                continue
            events.append((alt(idx(r, "commit_id"), ""), fromdateiso8601(idx(r, "submitted_at"))))
        for c in as_list(comments):
            if not login_is(c, rev):
                continue
            if icap is not None and not ge(icap, alt(idx(c, "id"), 0)):
                continue
            body = body_of(c)
            if _SUMMARY_TAG in body or _NO_FINDINGS.search(body) or _INIT_FAILURE.search(body):
                continue
            stamp = capture_first(body, REVIEWED_COMMIT_RE)
            sha: Json = alt(stamp["s"] if stamp is not None else None, "comment")
            events.append((sha, fromdateiso8601(idx(c, "created_at"))))
        n = 0
        cur: Json = None
        t = 0
        for sha, when in sort_by(events, lambda e: e[1]):
            if not _same_head(sha, cur) or when - t > round_gap:
                n += 1
                cur = sha
            t = when
    except JqError:
        return Rounds(None, "the reviews feed did not parse")
    try:
        heads: list[Json] = [
            alt(idx(r, "commit_id"), "")
            for r in raw
            if login_is(r, rev)
            and idx(r, "submitted_at") is not None
            and idx(r, "state") in ("COMMENTED", "CHANGES_REQUESTED")
        ]
        head_count = str(len([h for h in unique(heads) if h != ""]))
    except JqError:
        head_count = "?"
    return Rounds(n, f"{n} round(s) of {rev} findings over {head_count} head(s)")


def _same_head(a: Json, b: Json) -> bool:
    if cmp(a, b) == 0:
        return True
    if a is None or b is None or a == "" or b == "":
        return False
    return startswith(a, b) or startswith(b, a)

