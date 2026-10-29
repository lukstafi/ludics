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

import json
import os
import re
from dataclasses import dataclass
from typing import Literal, assert_never, cast

from ludics.prreview import knobs
from ludics.prreview.core import GhFailed, GhOk, GhUnanswered, Json
from ludics.prreview.clock import age_of, age_text, fmt_age, freshest_age, newest
from ludics.prreview.threads import (
    OpenThreads,
    Unresolved,
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
    review_comments,
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
from ludics.prreview.poll import CODEX_ABOUT_OPEN, REVIEWED_COMMIT_RE

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
# A Completed row whose Commit cell is an em dash (ludics-lite#787): a round the app closed with no
# commit, no review and no 👍 (staging#1347's first round, its state record's commit_sha null).
SUMMARY_COMMITLESS_ROW_RE = (
    '^\\|[^|]*Code Review[^|]*\\| *\u2705 \\*\\*Completed\\*\\* <relative-time datetime="(?<at>[^"]+)">'
    "[^<|]*</relative-time> *\\| *\u2014 *\\|"
)
_SUMMARY_COMPLETED_ROW = onig(SUMMARY_COMPLETED_ROW_RE)
_SUMMARY_COMMITLESS_ROW = onig(SUMMARY_COMMITLESS_ROW_RE)
_SUMMARY_FAILED_ROW = onig(SUMMARY_FAILED_ROW_RE)
_SUMMARY_ROW_STAMP = onig(SUMMARY_ROW_STAMP_RE)
# A Code Review row's last cell, its Review trigger, and the words the gate knows there: "Manual
# request" and "PR opened" each name the request a commit-less receipt answers (_receipt_binding),
# "New commits" a push whose head the row does not record. pr-review-api-contract.sh asks for both
# verbatim and pins every live row's cell against the tuple (ludics#825).
SUMMARY_TRIGGER_CELL_RE = r"\|[ \t]*(?<t>[^|]*?)[ \t]*\|[ \t]*$"
REVIEW_TRIGGER_MANUAL = "Manual request"
REVIEW_TRIGGER_OPENED = "PR opened"
REVIEW_TRIGGERS = (REVIEW_TRIGGER_MANUAL, REVIEW_TRIGGER_OPENED, "New commits")
_TRIGGER_CELL = onig(SUMMARY_TRIGGER_CELL_RE)
# A no-findings receipt that names no commit (ludics#815): the reviewer's WHOLE comment body, as a
# fail-closed allowlist of the two shapes seen (ocannl-staging#1424's, 2026-10-26, under the
# receipt marker; and five from 2026-04..06 without it): the optional marker and a blank line, the
# verdict line -- "Codex Review: Didn't find any major issues." and an optional flourish
# (":+1:", "Swish!", "Chef's kiss.") -- a blank line, the connector's "About Codex in GitHub"
# block opened by its exact tag, and nothing after that block's one closing tag but whitespace.
# Nowhere a "Reviewed commit" (a stamped receipt is a verdict for its commit, read elsewhere).
# Not read: the block's prose (the connector's boilerplate, which poll folds the same way).
COMMITLESS_RECEIPT_RE = (
    r"\A(?![\s\S]*[Rr]eviewed commit)(?:<!-- codex-review-receipt:v1 -->\n\n)?"
    r"Codex Review: Didn['’]t find any major issues\.(?: [^\n]{1,80})?\n\n"
    + re.escape(CODEX_ABOUT_OPEN)
    + r"\n(?:(?!</details>|<details)[\s\S])*</details>[ \t\n]*\z"
)
_COMMITLESS_RECEIPT = onig(COMMITLESS_RECEIPT_RE)
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
# A GitHub timestamp, the only shape a request's time is compared in.
_ISO_STAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z")


def instant(at: Json) -> str:
    """``SUMMARY_ROW_INSTANT_DEF``: a row's datetime padded to nine fractional digits, so the
    string order is the time order."""
    s = sub_once(at, _TRAILING_Z, "")
    s = s if "." in s else s + "."
    return (s + "000000000")[:29]


def _commit_read(ctx: Ctx, sha: str) -> str:
    """The head commit's committer date, or "" when the read failed. A read that answered is
    kept on the context by SHA (a commit's date never changes); a failed one is read again."""
    if sha in ctx.commit_dates:
        return ctx.commit_dates[sha]
    result = ctx.session.retry(
        "read", ["api", f"repos/{ctx.repo}/commits/{sha}", "--jq", ".commit.committer.date"]
    )
    match result:
        case GhOk(stdout=out):
            ctx.commit_dates[sha] = out
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


def _newest_row(body: str) -> tuple[str, str, str] | None:
    """A summary body's newest Code Review row by its stamp's instant: (the row's line, the commit
    it names, its stamp with the fraction cut). None when the body has no Code Review row, or has
    one whose stamp does not read: then no row can be called the newest."""
    rows: list[tuple[str, dict[str, str | None]]] = []
    for line in body.split("\n"):
        if not _CODE_REVIEW_ROW.search(line):
            continue
        stamp = capture_first(line, _SUMMARY_ROW_STAMP)
        if stamp is None:
            return None
        rows.append((line, stamp))
    best = max_by(rows, lambda r: instant(r[1]["at"]))
    if best is None:
        return None
    return best[0], jstr(best[1]["sha"]), sub_once(best[1]["at"], _FRACTION_Z, "Z")


def _head_running_row(comments: list[Json], rev: str, head_sha: str) -> tuple[bool, str]:
    """The one read of a round in flight off the summary (ludics-lite#586, #752): (a Running row
    could not be read, the stamp of a Running row for this head). Every arm takes its Running
    evidence from here: ``status_state``'s own arm, and the 👍 path and ``nudge_read`` through
    ``_evidence``.

    Boundary, fail-closed: read only the reviewer's NEWEST summary comment (``_newest_summary``'s
    choice, the one ``_done_row`` and ``summary_state`` read), and in it only its newest Code
    Review row (``_newest_row``'s choice). That row counts only when it passes the ``_RUNNING_ROW``
    test, names a prefix of the head's SHA, and its stamp is a GitHub timestamp; it is then this
    head's round, running since that stamp. A row of the newest summary passing the Running test
    whose stamp does not read (or a newest one whose stamp does not read as a GitHub timestamp) is
    the first field: it may be this head's round. Any other row, a newest row that is not Running,
    a row for another head, or no summary is (False, ""): the reactions decide, as before the row
    was read. Not read: older summaries (a Running row there is a round the reviewer has since
    written past, ludics-lite#752), the state record, the row's trigger cell, the comment's own
    timestamps."""
    newest = _newest_summary(comments, rev)
    if newest is None:
        return False, ""
    body = body_of(newest)
    for line in body.split("\n"):
        if _RUNNING_ROW.search(line) and capture_first(line, _SUMMARY_ROW_STAMP) is None:
            return True, ""
    row = _newest_row(body)
    if row is None or not _RUNNING_ROW.search(row[0]):
        return False, ""
    _line, sha, at = row
    if not _ISO_STAMP.fullmatch(at):
        return True, ""
    if not head_sha or not head_sha.startswith(sha):
        return False, ""
    return False, at


@dataclass(frozen=True)
class SummaryState:
    """The ``code_review`` half of the ``codex-review-state:v1`` record on the reviewer's newest
    summary comment: the commit it is about (40 hex), its ``status`` as written ("running",
    "completed", ...), ``has_unresolved_findings`` (None while it runs), and when that state began
    -- the stamp of the same summary's newest Code Review row, which names the same commit
    (Completed at, Running since), with its fraction cut. Never the comment's ``updated_at``:
    any edit of the shared summary (its security-review row) moves that without a new verdict."""

    sha: str
    status: str
    unresolved: bool | None
    at: str


_STATE_MARK = "<!-- codex-review-state:v1 "
_STATE_RECORD = re.compile(r"<!-- codex-review-state:v1 ([^\n]*?) -->")
_FULL_SHA = re.compile(r"[0-9a-f]{40}")


class _Duplicate(ValueError):
    pass


def _no_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    out: dict[str, object] = {}
    for k, v in pairs:
        if k in out:
            raise _Duplicate(k)
        out[k] = v
    return out


def summary_state(comments: list[Json], rev: str) -> SummaryState | None:
    """The newest summary's ``codex-review-state:v1`` record (ludics-lite#702), or None.

    Boundary, as a fail-closed allowlist. Read: only the reviewer's NEWEST summary comment (the
    one ``_done_row`` and ``_head_running_row`` read), and in it only the one hidden record, which must
    occur exactly once, on one line, as ``<!-- codex-review-state:v1 <JSON> -->``. The JSON is
    parsed whole -- never fished for fields -- and must be an object with no duplicate key whose
    ``code_review`` is an object holding ``commit_sha`` (40 lowercase hex), ``status`` (a
    non-empty string) and ``has_unresolved_findings`` (a boolean, or null). The record is dated by
    the summary's newest Code Review row (``_newest_row``'s choice): every Code Review row's stamp
    must read, and the newest must name a prefix of ``commit_sha`` and carry a GitHub timestamp.
    Any other shape, a second record, a record that does not parse, a row that disagrees or does
    not read, or no summary at all is None: no reading, which is what every caller had before the
    record was read. Not read: ``security_review``, ``has_any_findings`` (true on a clean head
    whose earlier heads drew findings, lukstafi/ludics-lite#690), the row's status cell
    (``_done_row`` reads it), the comment's own timestamps, and any key beyond the three -- an
    added key changes nothing here."""
    newest_summary = _newest_summary(comments, rev)
    if newest_summary is None:
        return None
    body = body_of(newest_summary)
    fields = _code_review_record(body)
    if fields is None or "has_unresolved_findings" not in fields:
        return None
    sha = fields.get("commit_sha")
    status = fields.get("status")
    unresolved = fields["has_unresolved_findings"]
    if not (isinstance(sha, str) and _FULL_SHA.fullmatch(sha)):
        return None
    if not (isinstance(status, str) and status):
        return None
    if not (unresolved is None or isinstance(unresolved, bool)):
        return None
    row = _newest_row(body)
    if row is None or not sha.startswith(row[1]):
        return None
    at = row[2]
    if not _ISO_STAMP.fullmatch(at):
        return None
    return SummaryState(sha, status, unresolved, at)


def _code_review_record(body: str) -> dict[str, object] | None:
    """The ``code_review`` object of a summary body's one ``codex-review-state:v1`` record (the
    record ``summary_state`` and ``_commitless_done`` read), or None: no record, a second one, one
    that does not parse whole, a duplicate key, or no ``code_review`` object."""
    if body.count(_STATE_MARK) != 1:
        return None
    m = _STATE_RECORD.search(body)
    if m is None:
        return None
    try:
        record = json.loads(m.group(1), object_pairs_hook=_no_duplicates)
    except (ValueError, RecursionError):  # JSONDecodeError and _Duplicate are ValueErrors
        return None
    if not isinstance(record, dict):
        return None
    code = cast(dict[str, object], record).get("code_review")
    if not isinstance(code, dict):
        return None
    return cast(dict[str, object], code)


def _commitless_done(comments: list[Json], rev: str) -> tuple[str, str]:
    """When the reviewer's newest summary marks its newest Code Review row Completed naming no
    commit (ludics-lite#787): that row's stamp with its fraction cut, and its Review trigger cell
    as written ("" when the row has none); else ("", "").

    Boundary, as a fail-closed allowlist. Read: only the reviewer's NEWEST summary comment, and in
    it every Code Review row, each of which must read either as ``SUMMARY_ROW_STAMP_RE`` (a row
    naming a commit) or as ``SUMMARY_COMMITLESS_ROW_RE``; the newest of them by its stamp's instant
    must be the commit-less one, stamped as a GitHub timestamp, and the summary's one state record
    (``_code_review_record``) must say the same: ``commit_sha`` present and null, ``status``
    "completed". A row that reads neither way, a tie between rows, a record that disagrees or does
    not read, or no summary is ("", ""). The trigger is read only for the commit-less receipt
    (ludics#815), which names the request kind by it. Not read: the record's other keys, the
    comment's own timestamps. Which head the row is about is not in it: ``status_state`` bounds it
    by the head's arrival."""
    newest_summary = _newest_summary(comments, rev)
    if newest_summary is None:
        return "", ""
    body = body_of(newest_summary)
    rows: list[tuple[str, bool, str]] = []
    for line in body.split("\n"):
        if not _CODE_REVIEW_ROW.search(line):
            continue
        stamp = capture_first(line, _SUMMARY_ROW_STAMP)
        bare = capture_first(line, _SUMMARY_COMMITLESS_ROW)
        if stamp is not None:
            rows.append((jstr(stamp["at"]), False, ""))
        elif bare is not None:
            trigger = capture_first(line, _TRIGGER_CELL)
            rows.append((jstr(bare["at"]), True, jstr(alt(trigger["t"] if trigger else None, ""))))
        else:
            return "", ""
    best = max_by(rows, lambda r: instant(r[0]))
    if best is None or not best[1] or sum(instant(r[0]) == instant(best[0]) for r in rows) != 1:
        return "", ""
    at = sub_once(best[0], _FRACTION_Z, "Z")
    if not _ISO_STAMP.fullmatch(at):
        return "", ""
    fields = _code_review_record(body)
    if fields is None or "commit_sha" not in fields or fields["commit_sha"] is not None:
        return "", ""
    if fields.get("status") != "completed":
        return "", ""
    return at, best[2]


def _commitless_receipt(comments: list[Json], rev: str) -> str:
    """When the reviewer's newest word -- its newest comment that is not the summary, by
    ``created_at`` -- is a no-findings receipt naming no commit (``COMMITLESS_RECEIPT_RE``, the whole
    body), that comment's ``created_at``, a GitHub timestamp; else "". An older receipt under a
    newer word of the reviewer's is history, and is not read."""
    words = sort_by(
        [c for c in comments if login_is(c, rev) and not _is_summary(c)],
        lambda c: idx(c, "created_at"),
    )
    if not words or not _COMMITLESS_RECEIPT.search(body_of(words[-1])):
        return ""
    at = idx(words[-1], "created_at")
    return at if isinstance(at, str) and _ISO_STAMP.fullmatch(at) else ""


type ReceiptBinding = Literal["approves", "unbound", ""]


def _receipt_binding(
    ctx: Ctx, comments: list[Json], rev: str, head: Head, head_at: str, receipt_at: str,
    bare_at: str, trigger: str,
) -> tuple[ReceiptBinding, str]:
    """Which head a no-findings receipt naming no commit (ludics#815) is a verdict for: the head
    that was current when the review it answers was REQUESTED, and only that head.

    Boundary, fail-closed. The request is what the summary's newest Code Review row -- Completed
    naming no commit (``_commitless_done``), stamped at or after the receipt -- names in its
    trigger cell: "Manual request" is the newest '@codex review' comment before the receipt
    (``_requests``), "PR opened" is the PR's creation when no such comment precedes the receipt.
    The head at that request is the current head when its arrival (``_arrival_floor``, with the
    commit date read) is at or before the request: then no other head stood from the request to
    now. That reading APPROVES the head. "approves" is never given for a head that arrived after
    the request, nor without that row. A request since the receipt, or a receipt older than the
    head's arrival (an earlier head's verdict), is "": no reading here. Any other case -- the
    commit date unread, a request time that does not read, the head arriving between the request
    and the receipt (which head the round reviewed is not in the feeds), no summary row, another
    trigger ("New commits": which push is not recorded), a row older than the receipt -- is
    "unbound": a verdict for an unknown head, neither approval nor a failed run. Not read: the 👀
    (a level an earlier round can leave up, so it dates no request), the receipt's prose beyond
    its allowlisted shape. Residual, stated: the arrival is the commit date or the PR's creation,
    so a commit dated before the request but pushed after it reads as the request's head (the
    ludics-lite#787 boundary); and a round asked for on an earlier head that answers only after a
    later '@codex review' on this head reads as the later request's."""
    short = _short(head.sha)
    now = ctx.clock.time()
    asked = _requests(comments, rev)
    if any(not isinstance(a, str) or not _ISO_STAMP.fullmatch(a) for a in asked):
        return "unbound", "a '@codex review' request on the PR has no readable time"
    if any(ge(a, receipt_at) for a in asked):
        return "", ""
    if age_of(head_at, now) is None:
        return "unbound", f"head {short}'s commit date does not read"
    floor = _arrival_floor(ctx, head_at, head.created)
    if lt(receipt_at, floor):
        return "", ""
    before = [a for a in asked if lt(a, receipt_at)]
    if before:
        req, kind = jstr(jmax(before)), REVIEW_TRIGGER_MANUAL
    elif head.created and age_of(head.created, now) is not None and lt(head.created, receipt_at):
        req, kind = head.created, REVIEW_TRIGGER_OPENED
    else:
        return "unbound", "no request before it reads"
    what = "the '@codex review' request" if kind == REVIEW_TRIGGER_MANUAL else "the PR's opening"
    if gt(floor, req):
        return "unbound", (
            f"head {short} arrived at {floor}, after {what} at {req} it may answer, so which head"
            " it reviewed is not recorded"
        )
    if not bare_at or trigger != kind or lt(bare_at, receipt_at):
        return "unbound", (
            f"{rev}'s summary does not mark the round Completed naming no commit at or after it,"
            f" triggered by '{kind}' ({what} at {req})"
        )
    return "approves", f"answering {what} at {req}, after head {short} arrived at {floor}"


def head_summary_state(comments: list[Json], rev: str, head_sha: str) -> SummaryState | None:
    """``summary_state`` when its record is about exactly this head (the full SHA), else None."""
    st = summary_state(comments, rev)
    if st is None or not head_sha or st.sha != head_sha:
        return None
    return st


def _head_findings(comments: list[Json], reviews: list[Json], rev: str, head_sha: str) -> bool:
    """Has the reviewer posted findings about this exact head: a (substantive) review of it, or a
    comment stamped with it that is not a no-findings verdict?"""
    if _review_of_head_at(reviews, rev, head_sha):
        return True
    for c in comments:
        if not login_is(c, rev) or _is_summary(c) or _NO_FINDINGS.search(body_of(c)):
            continue
        stamps = capture_all(body_of(c), REVIEWED_COMMIT_RE)
        sha = jstr(alt(stamps[-1]["s"] if stamps else None, ""))
        if sha and startswith(head_sha, sha):
            return True
    return False


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

    # ludics-lite#586: a 👀 is a level, and one left up by an older head's stuck round is no measure
    # of this head's round. The summary's newest Code Review row, Running on this head, newer than
    # the reviewer's last word and than any 👀, is the round in flight -- whether that 👀 is live
    # or spent (review of #747, round 1: a same-head rerun after findings) -- aged from the row,
    # and it stalls by the row's age. A Running row that does not read may be that round. It is
    # read before any verdict, as the 👍 path's newer current-head Running row outranks the 👍:
    # a no-findings verdict on the head is a word of the reviewer's, so a row newer than it is a
    # rerun that may yet post findings (review of #747, round 2). The summary's Completed, Failed
    # and record arms below need the newest row to be theirs, so a Running newest row is none of
    # them.
    try:
        running_unread, running_at = _head_running_row(comments, rev, head_sha)
    except JqError:
        return unknown(mstate, "the summary's Code Review rows did not parse")
    if running_unread:
        return unknown(
            mstate,
            f"a {rev} Code Review row matched the Running test but not the"
            " SUMMARY_ROW_STAMP_RE, so the running round could not be read",
        )
    if (
        running_at and running_at > last_spoke and (not eyes_at or running_at > eyes_at)
        and _after_nudge(running_at, nudge_at)
    ):
        age = age_of(running_at, ctx.clock.time())
        eyes = f" and its 👀 ({eyes_at})" if eyes_at else ""
        spoke = f" ({last_spoke})" if last_spoke else ""
        detail = (
            f"{rev} Code Review Running for head {_short(head_sha)} since {running_at}, newer than its"
            f" last word{spoke}{eyes}"
        )
        if age is not None and age >= grace_stall:
            return State("stalled", age, mstate, detail)
        return State("reviewing", age, mstate, detail)

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

    # The hidden state record (ludics-lite#702): a round the app records as completed on exactly
    # this head with no unresolved findings, when it put up no 👍 and left no 👀 to bound the
    # round (the Completed-row arm above needs one). The record and the row must agree (the row's
    # allowlisted Completed shape, dated by the row). A findings round submits its review seconds
    # BEFORE the record is written (#683: 16:20:15 then 16:20:18), so "nothing since the record"
    # cannot exclude it alone: the record's own has_unresolved_findings does, and so does any
    # finding the reviewer posted about this head, at any time.
    try:
        head_state = head_summary_state(comments, rev, head_sha)
    except JqError:
        return unknown(mstate, "the summary's review-state record did not parse")
    if (
        head_state is not None and head_state.status == "completed" and head_state.unresolved is False
        and done_kind == "completed" and done_at == head_state.at
        and (not eyes_at or eyes_at < head_state.at)
        and (not last_spoke or last_spoke < head_state.at)
        and _after_nudge(head_state.at, nudge_at)
    ):
        try:
            head_findings = _head_findings(comments, reviews, rev, head_sha)
        except JqError:
            return unknown(mstate, "the reviewer's findings for the head did not parse")
        if not head_findings:
            return State(
                "approved", None, mstate,
                f"{rev}'s summary records head {_short(head_sha)}'s Code Review completed with no"
                f" unresolved findings, Completed at {head_state.at}, with nothing posted since (no 👍 was"
                " given)",
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

    # A no-findings receipt naming no commit (ludics#815; ocannl-staging#1424, where the arm below
    # read it as a failed run and advised a new head): the reviewer's newest word, with no 👀 and
    # no request since, is a verdict for the head current at the request it answers
    # (``_receipt_binding`` states the boundary), and for no other head. Where that head does not
    # read, it is a verdict for an unknown head: neither approval nor the failed run below, and a
    # round for this head is due.
    try:
        receipt_at = _commitless_receipt(comments, rev)
        bare_at, bare_trigger = _commitless_done(comments, rev)
    except JqError:
        return unknown(mstate, "the reviewer's comments or the summary's Code Review rows did not parse")
    if (
        receipt_at and head_sha and _after_nudge(receipt_at, nudge_at)
        and (not eyes_at or eyes_at < receipt_at) and (not last_spoke or last_spoke <= receipt_at)
    ):
        if not head_at_read:
            head_at = _commit_read(ctx, head_sha)
            head_at_read = True
        try:
            binding, why = _receipt_binding(
                ctx, comments, rev, head, head_at, receipt_at, bare_at, bare_trigger
            )
        except JqError:
            return unknown(mstate, "the review-request comments feed did not parse")
        receipt = f"{rev} posted a no-findings receipt naming no commit at {receipt_at}"
        if binding == "approves":
            return State("approved", None, mstate, f"{receipt}, {why}")
        if binding == "unbound":
            return State(
                "expected", freshest_age(head_at, head.created, receipt_at, now=ctx.clock.time()), mstate,
                f"no 👀 in flight and no review naming head {_short(head_sha)}: {receipt}, and {why} —"
                " a verdict for an unknown head, neither an approval of this one nor a failed run",
            )

    # A round the summary closed with no commit named (ludics-lite#787): the app's Completed row
    # carries an em dash for the commit and its record a null commit_sha, with nothing posted and
    # no 👍 -- a run that ended without a verdict, re-requested as a Failed one is (`watch` posts
    # its one '@codex review' per head). The row names no head, so it counts only when it is
    # newer than this head's arrival -- the commit's date, which must read (the PR's creation
    # alone would hand an earlier head's row to every later push), or the creation where that is
    # newer -- and the reviewer has posted nothing about the head. BOUNDARY: a commit dated before
    # the row but pushed after it reads the row as its own; what that costs is one request for a
    # head the reviewer had not reached, never a cleared 👍 (none may be up).
    if (
        bare_at and head_sha and not plus and _after_nudge(bare_at, nudge_at)
        and (not eyes_at or eyes_at < bare_at) and (not last_spoke or last_spoke < bare_at)
    ):
        if not head_at_read:
            head_at = _commit_read(ctx, head_sha)
            head_at_read = True
        floor = _arrival_floor(ctx, head_at, head.created) if age_of(head_at, ctx.clock.time()) is not None else ""
        try:
            head_findings = _head_findings(comments, reviews, rev, head_sha)
            asked = _requests(comments, rev)
        except JqError:
            return unknown(mstate, "the reviewer's findings or the requests for the head did not parse")
        if floor and floor < bare_at and not head_findings and not any(ge(a, bare_at) for a in asked):
            req_before = jstr(alt(jmax([a for a in asked if ge(a, floor) and lt(a, bare_at)]), ""))
            age = age_of(bare_at, ctx.clock.time())
            marks = (
                f"{rev}'s summary marks a Code Review Completed at {bare_at} naming no commit (its"
                f" state record's commit_sha is null), after head {_short(head_sha)} arrived at {floor},"
                " with no review of it and no 👍"
            )
            if req_before:
                return State(
                    "failed", age, mstate,
                    f"{_short(head_sha)}|run-again|{marks}, after the '@codex review' request at"
                    f" {req_before} on this head",
                )
            return State(
                "failed", age, mstate,
                f"{_short(head_sha)}|run|{marks}, and no '@codex review' on it since it arrived",
            )

    if eyes_at and eyes_at > last_spoke:
        age = age_of(eyes_at, ctx.clock.time())
        if age is not None and age >= grace_stall:
            # A 👀 is a level: one an earlier head's hung round left up stands over a fresh push,
            # and the reviewer cannot put up another for the new head's round (#770's head 1af99c3
            # read STALLED for 81m seconds after its push). So a 👀 older than the head's arrival
            # is read as that head's pickup while the head is younger than the pickup margin
            # (knobs.PICKUP, the clock watch holds its nudges on), and as the stall it is, aged
            # from its own date, after that. An arrival that does not read leaves the stall.
            if head_sha and not head_at_read:
                head_at = _commit_read(ctx, head_sha)
                head_at_read = True
            arrival = _arrival_floor(ctx, head_at, head.created) if head_sha else ""
            arrived = age_of(arrival, ctx.clock.time()) if arrival else None
            if arrived is not None and eyes_at < arrival and arrived < ctx.pickup:
                return State(
                    "reviewing", arrived, mstate,
                    f"👀 from {rev} at {eyes_at} predates head {_short(head_sha)}'s arrival at"
                    f" {arrival}, so it is no measure of this head's round until the head's pickup"
                    f" ({fmt_age(ctx.pickup)}) is over",
                )
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
            # ludics-lite#792: split as the Failed row is. A request at or after the failure
            # answers it (the round it asks for is due, as `run` reads it); one on this head before
            # it makes this a failure AGAIN (`env-again`, `git-again`), which `watch` hands back
            # rather than re-requesting; neither is a first failure (`env`, `git`), which it posts
            # its one request over.
            if not head_at_read:
                head_at = _commit_read(ctx, head_sha)
                head_at_read = True
            floor = _arrival_floor(ctx, head_at, head.created)
            try:
                asked = _requests(comments, rev)
                req_after = any(ge(a, fail_at) for a in asked)
                req_before = jstr(alt(jmax([a for a in asked if ge(a, floor) and lt(a, fail_at)]), ""))
            except JqError:
                return unknown(mstate, "the review-request comments feed did not parse")
            if not req_after:
                again = (
                    f"-again|{rev} reported an initialization failure at {fail_at} {fail_head}, after"
                    f" the '@codex review' request at {req_before} on this head"
                ) if req_before else (
                    f"|{rev} reported an initialization failure at {fail_at} {fail_head}, with no"
                    " '@codex review' on this head before it"
                )
                return State(
                    "failed", age_of(fail_at, ctx.clock.time()), mstate,
                    f"{_short(head_sha)}|{fail_kind}{again}",
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
    the reviewer's evidence for the head that ``_evidence`` reads (the newest summary's newest
    row Running on the head, a review, a comment stamped with the head, verdict or findings); any
    Code Review row of the newest summary
    that names the head, whatever its status, or whose stamp does not read; and a '@codex review'
    request by anyone (a request whose time does not read included), at or after the head's
    arrival (``_arrival_floor``), whatever the watch's watermark. That last one is the record that
    makes the nudge once per head across processes (a re-armed watch, another host) and that
    counts a hand nudge too, as the failed run's re-request counts its own (#453). Not read: the
    reactions (the state read just judged them), a request older than the head's arrival (an
    earlier head's), the request's wording beyond the summon itself, and older summaries (a Running
    row there is a round since written past, ludics-lite#752)."""
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
    try:
        rows = _stamp_rows(body_of(_newest_summary(comments, rev)))
    except JqError:
        return NudgeBarred("the reviewer's summary did not parse")
    if any(r is None for r in rows):
        # Review of #583, round 5: a row whose stamp does not read may be this head's, terminal.
        return NudgeBarred(f"a {rev} Code Review row could not be read")
    if any(r is not None and head.sha.startswith(jstr(r["sha"])) for r in rows):
        return NudgeBarred(f"{rev}'s summary has a Code Review row naming head {short}")
    return _request_record(ctx, asked, head)


def stall_nudge_read(ctx: Ctx, pr: str) -> NudgeRead:
    """May ``watch`` post its one '@codex review' over a STALLED round on the head
    (ludics-lite#760)? Asked only after a fresh state read said ``stalled``: a 👀 or a Running row
    up longer than a round takes, newer than the reviewer's last word. ``nudge_read`` cannot answer
    it, since the stalled round's own Running row is evidence for the head there. Asked too after a
    fresh read said ``failed`` with a first initialization failure (``env``, ``git``; ludics-lite#792),
    whose request it gates the same way.

    Boundary, fail-closed: CLEAR only when every read below answered and none of these is there --
    a 👍 from the reviewer on the PR, whatever head it is for (a request clears it); a no-findings
    verdict comment from the reviewer stamped with the head, or carrying no stamp to say which
    head it is for; the newest summary's NEWEST Code Review row naming the head as Completed (an
    older Completed row under a newer Running one is a finished round, not the one that stalled),
    or any of its rows whose stamp does not read; and a '@codex review' request by anyone at or after the head's
    arrival (``_arrival_floor``), a request whose time does not read included -- the once-per-head
    record across processes, as ``nudge_read`` and the failed run's (#453) keep it. Not read: the
    👀 and the Running row (they are the stall), findings reviews (no approval for a request to
    clear), the summary's state record (written with the Completed row read here), and a request
    older than the head's arrival (an earlier head's)."""
    rev = ctx.reviewer
    try:
        reactions = feed(ctx, f"issues/{pr}/reactions?per_page=100")
    except ReadFailed:
        return NudgeBarred(f"the reactions API did not answer ({ctx.session.err_line()})")
    try:
        comments = state_comments(ctx, pr)
    except ReadFailed:
        return NudgeBarred(f"the comments API did not answer ({ctx.session.err_line()})")
    head = state_head_read(ctx, pr)
    if not head.sha:
        return NudgeBarred(f"the pulls API did not answer for the head SHA ({head.err})")
    short = _short(head.sha)
    try:
        if any(login_is(r, rev) and idx(r, "content") == "+1" for r in reactions):
            return NudgeBarred(f"a 👍 from {rev} is on the PR, and a request would clear it")
        for c in comments:
            if not login_is(c, rev) or not _NO_FINDINGS.search(body_of(c)):
                continue
            stamps = capture_all(body_of(c), REVIEWED_COMMIT_RE)
            sha = jstr(alt(stamps[-1]["s"] if stamps else None, ""))
            if not sha or startswith(head.sha, sha):
                return NudgeBarred(f"{rev} posted a no-findings verdict for head {short} (or for no named head)")
        if any(r is None for r in _stamp_rows(body_of(_newest_summary(comments, rev)))):
            return NudgeBarred(f"a {rev} Code Review row could not be read")
        done_kind, _done_at, done_sha = _done_row(comments, rev)
        if done_kind == "completed" and done_sha and head.sha.startswith(done_sha):
            return NudgeBarred(f"{rev}'s summary marks head {short}'s Code Review Completed")
        asked = _requests(comments, rev)
    except JqError:
        return NudgeBarred("the reviewer's verdicts for the head did not parse")
    return _request_record(ctx, asked, head)


def _request_record(ctx: Ctx, asked: list[Json], head: Head) -> NudgeRead:
    """The once-per-head record both automatic requests keep in the feed: barred by a
    '@codex review' request at or after the head's arrival, CLEAR otherwise."""
    short = _short(head.sha)
    if any(not isinstance(a, str) or not _ISO_STAMP.fullmatch(a) for a in asked):
        # A request whose time does not read is a request: it may be this head's (review of #583,
        # rounds 4 and 6), and the string order would put it below any floor.
        return NudgeBarred(f"a '@codex review' request on the PR has no readable time (head {short})", "-")
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
    """The 👍 path's read of the current head's newest evidence: (kind, at, 1 when the newest
    summary has a Running row the stamp pattern could not read else 0, the commit of the newest
    summary's newest Code Review row).

    Its Running evidence is ``_head_running_row``'s and its row is ``_newest_row``'s, the readers
    every arm shares (ludics-lite#752): at most one Running candidate, the newest summary's newest
    row. A Running row in an older summary, or below a newer row of the newest one, is a round that
    already moved on, never evidence against a 👍."""
    mine = [c for c in comments if login_is(c, rev)]
    running_unread, running_at = _head_running_row(comments, rev, head_sha)
    newest_summary = _newest_summary(comments, rev)
    row = None if newest_summary is None else _newest_row(body_of(newest_summary))
    row_sha = "" if row is None else row[1]
    candidates: list[tuple[Json, Json, str]] = []
    if running_at:
        candidates.append((head_sha, running_at, "running"))
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
    unread = int(running_unread)
    if best_ev is None:
        return "", "", unread, row_sha
    return best_ev[1], best_ev[0], unread, row_sha


def _done_row(comments: list[Json], rev: str) -> tuple[str, str, str]:
    """The newest summary's newest Code Review row (``_newest_row``'s choice), when it is the
    allowlisted Completed or Failed shape: (kind, at with its fraction cut, sha), or empty fields."""
    newest_summary = _newest_summary(comments, rev)
    if newest_summary is None:
        return "", "", ""
    row = _newest_row(body_of(newest_summary))
    if row is None:
        return "", "", ""
    done = capture_first(row[0], _SUMMARY_COMPLETED_ROW)
    if done is not None:
        return "completed", sub_once(done["at"], _FRACTION_Z, "Z"), jstr(done["sha"])
    failed = capture_first(row[0], _SUMMARY_FAILED_ROW)
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
                f"STALLED — {detail} for {age}, longer than a round takes. `watch` nudges it"
                " itself, once per head, when no 👍, verdict or request stands for the head, and"
                " keeps watching. Outside a watch, FIRST read the PR feed yourself (retry --read pr"
                " view <pr> --comments): a verdict may have landed as a comment or a 👍 this state"
                " machine missed. If the feed holds nothing for the current head, nudge once"
                f" (pr-review.sh comment {repo}#{p} '@codex review'); never while a 👍 may stand,"
                f" since a re-request CLEARS it{c}"
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
                case "env" | "env-again":
                    env = (
                        'the connector answered "To use Codex here, create an environment for this'
                        ' repo"'
                    )
                    maintainer = (
                        "the environment is the maintainer's to set up"
                        " (https://chatgpt.com/codex/cloud/settings/environments) — no push of yours"
                        " fixes it"
                    )
                    if fkind == "env-again":
                        return (
                            f"reviewer FAILED at initialization AGAIN on head {fsha} after a"
                            f" '@codex review' request on it — not re-requested a second time: {env},"
                            f" and {maintainer}; hand it over. This is not a round — {frest},"
                            f" standing for {age}{c}"
                        )
                    return (
                        f"reviewer FAILED at initialization on head {fsha} — nudge it once with a"
                        f" '@codex review' comment (`watch` posts it itself, once per head, when no"
                        " 👍 stands, and keeps watching; outside a watch, pr-review.sh comment"
                        f" {repo}#{p} '@codex review'); {env}, which has cleared on one nudge before."
                        f" If the nudge draws the same answer, {maintainer}. This is not a round —"
                        f" {frest}, standing for {age}{c}"
                    )
                case _:
                    behind = (
                        " (an amend suffices: git commit --amend --no-edit && git push"
                        " --force-with-lease), since the reviewer's clone is behind, not your push —"
                        " the ref it could not fetch is one the PR and git ls-remote both serve"
                    )
                    if fkind == "git-again":
                        return (
                            f"reviewer FAILED at initialization AGAIN on head {fsha} after a"
                            f" '@codex review' request on it — not re-requested a second time:"
                            f" push a new head{behind}. This is not a round — {frest}, standing for"
                            f" {age}{c}"
                        )
                    return (
                        f"reviewer FAILED at initialization on head {fsha} — nudge it once with a"
                        f" '@codex review' comment (`watch` posts it itself, once per head, when no"
                        " 👍 stands, and keeps watching; outside a watch, pr-review.sh comment"
                        f" {repo}#{p} '@codex review'); if the SAME head fails again, push a new head"
                        f" instead{behind}. This is not a round — {frest}, standing for {age}{c}"
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


def state_threads(ctx: Ctx, pr: str) -> Unresolved:
    """The PR's open review threads, walked once per watch round: a walk that answered whole is
    kept on the armed round snapshot, so the approval gate and the exit's thread count
    (``threads_line``) share one walk. Outside a watch (never armed) every call walks; ``status``
    walks once and hands the read to the gate."""
    snap = ctx.snap
    if snap.armed and snap.threads is not None and snap.threads_pr == pr:
        return snap.threads
    read = unresolved_threads(ctx.session, ctx.repo, pr, threads_page_cap())
    if snap.armed and isinstance(read, OpenThreads):
        snap.threads, snap.threads_pr = read, pr
    return read


def approval_gate(ctx: Ctx, pr: str, state: State, threads: Unresolved | None = None) -> State:
    """``approval_gate``: an ``approved`` state checked for open review threads (threads.py), on
    ``threads`` when the caller already walked them."""
    if state.tok != "approved":
        return state
    read = threads if threads is not None else state_threads(ctx, pr)
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
    """``review_rounds``'s "count|detail": ``count`` is None for unknown. ``first`` is round 1's
    inline findings when the caller asked for them (``first_round_findings``), None for unknown or
    not asked."""

    count: int | None
    detail: str
    first: int | None = None

    def token(self) -> str:
        """``count_token``."""
        return "unknown" if self.count is None else str(self.count)

    def first_token(self) -> str:
        return "unknown" if self.count is None or self.first is None else str(self.first)


def first_round_findings(ctx: Ctx, pr: str, review_ids: list[Json]) -> int | None:
    """Round 1's size for the convergence note's early trigger (ludics-lite#650): the top-level
    inline comments (no ``in_reply_to_id``) of the reviewer's reviews in round 1, one read of each
    review's own comments endpoint. Boundary, as a fail-closed allowlist: only those comments are
    counted, so a finding stated in a review's body or in a comment-only round is not, and the
    count is a lower bound -- it can miss the early trigger (the round-5 one still stands), never
    raise it. None (unknown) when a review id is not a number or a read did not answer or parse."""
    n = 0
    for rid in review_ids:
        if not isinstance(rid, int) or isinstance(rid, bool) or rid < 0:
            return None
        try:
            comments = review_comments(ctx, pr, str(rid))
        except ReadFailed:
            return None
        try:
            n += len([c for c in as_list(comments) if idx(c, "in_reply_to_id") is None])
        except JqError:
            return None
    return n


def review_rounds(
    ctx: Ctx, pr: str, round_gap: int, icap: int | None = None, rcap: int | None = None,
    first: bool = False,
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
        # (head, when, ("review", its id) or None for a comment): round 1's reviews, for `first`
        events: list[tuple[Json, int, tuple[str, Json] | None]] = []
        for r in raw:
            if not login_is(r, rev):
                continue
            if rcap is not None and not ge(rcap, alt(idx(r, "id"), 0)):
                continue
            if idx(r, "submitted_at") is None:
                continue
            if idx(r, "state") not in ("COMMENTED", "CHANGES_REQUESTED"):
                continue
            events.append((alt(idx(r, "commit_id"), ""), fromdateiso8601(idx(r, "submitted_at")), ("review", idx(r, "id"))))
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
            events.append((sha, fromdateiso8601(idx(c, "created_at")), None))
        n = 0
        cur: Json = None
        t = 0
        round1: list[Json] = []
        for sha, when, rid in sort_by(events, lambda e: e[1]):
            if not _same_head(sha, cur) or when - t > round_gap:
                n += 1
                cur = sha
            t = when
            if n == 1 and rid is not None:
                round1.append(rid[1])
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
    size = first_round_findings(ctx, pr, round1) if first else None
    return Rounds(n, f"{n} round(s) of {rev} findings over {head_count} head(s)", size)


def _same_head(a: Json, b: Json) -> bool:
    if cmp(a, b) == 0:
        return True
    if a is None or b is None or a == "" or b == "":
        return False
    return startswith(a, b) or startswith(b, a)

