"""One poll of a PR's three feeds, as ``pr-review.sh poll`` prints it, for the watch to classify.

Ported from ``cmd_poll`` and its ``POLL_ITEM_DEFS`` jq prelude (the shell's comments there carry
the incident history of each rule: the fold of duplicated threads, the anchor fields, the stamp
read from the footer, the "About Codex in GitHub" block). The rendering is byte for byte what
poll printed, because a watch's acting exit IS that round on stdout.

The watch reads two machine lines of it, the LAST ``items:`` and ``watermark:`` lines, and never
the rendered headers -- a reviewer body can quote a header -- so ``Poll`` carries both as they
were printed, beside the whole text.
"""

import json
import sys
from dataclasses import dataclass
from typing import Literal

from ludics import cli
from ludics.prreview.core import GhSession, Json, mark_of, pr_arg, warn
from ludics.prreview.feeds import Ctx, ReadFailed, feed, outside_watch, review_comments
from ludics.prreview.jqsem import (
    JqError,
    alt,
    as_list,
    body_of,
    capture_all,
    gt,
    idx,
    jmax,
    jstr,
    login_is,
    member,
    onig,
    path,
    string,
    tojson,
    type_name,
)

REVIEWED_COMMIT_RE = onig("Reviewed commit[^0-9a-fA-F]*(?<s>[0-9a-f]{7,40})")
_SUMMARY_TAG = "codex-pull-request-review-summary"
CODEX_ABOUT_OPEN = "<details> <summary>ℹ️ About Codex in GitHub</summary>"
CODEX_ABOUT_FOLDED = '[Codex "About Codex in GitHub" boilerplate folded]'
_NON_SPACE = onig("[^[:space:]]")


@dataclass(frozen=True)
class Poll:
    """``rc``: 0 a round, 3 a feed did not answer, 4 a feed did not parse. ``text``: stdout as
    printed (every line newline-terminated). ``items``/``watermark``: the two machine lines' values
    on a round that answered, empty otherwise."""

    rc: Literal[0, 3, 4]
    text: str
    items: str
    watermark: str


# --- POLL_ITEM_DEFS ---------------------------------------------------------------------------------


def short(value: Json) -> str:
    """``def short: if (. // "") == "" then "-" else .[0:7] end``."""
    v = alt(value, "")
    if v == "":
        return "-"
    if isinstance(v, str):
        return v[:7]
    if isinstance(v, list):
        return jstr(v[:7])
    raise JqError(f"cannot slice {type_name(v)}")


def item_stamp(item: Json) -> str:
    """The LAST "Reviewed commit:" stamp of the body, short, or ``-``."""
    found = capture_all(body_of(item), REVIEWED_COMMIT_RE)
    return short(found[-1]["s"] if found else None)


def inline_commit(item: Json) -> str:
    return short(alt(idx(item, "original_commit_id"), idx(item, "commit_id")))


def review_commit(item: Json) -> str:
    return short(idx(item, "commit_id"))


def item_path(item: Json) -> str:
    return jstr(alt(idx(item, "path"), "?"))


def anchor(start: Json, line: Json) -> str:
    return f"{jstr(start)}-{jstr(line)}" if start is not None else jstr(line)


def item_line(item: Json) -> str:
    line = alt(idx(item, "line"), idx(item, "original_line"))
    if line is not None:
        return anchor(alt(idx(item, "start_line"), idx(item, "original_start_line")), line)
    pos = alt(idx(item, "position"), idx(item, "original_position"))
    return f"@{jstr(pos)}" if pos is not None else "?"


def item_side(item: Json) -> str:
    out = " side=LEFT" if alt(idx(item, "side"), "") == "LEFT" else ""
    start_side = idx(item, "start_side")
    if start_side is not None and start_side != alt(idx(item, "side"), "RIGHT"):
        out += f" start_side={jstr(start_side)}"
    return out


def item_was(item: Json) -> str:
    line = alt(idx(item, "line"), idx(item, "original_line"))
    if line is not None:
        start = alt(idx(item, "start_line"), idx(item, "original_start_line"))
        oline = idx(item, "original_line")
        ostart = idx(item, "original_start_line")
        if (oline is not None and oline != line) or (ostart is not None and ostart != start):
            return f" was={anchor(ostart, alt(oline, line))}"
        return ""
    pos = alt(idx(item, "position"), idx(item, "original_position"))
    opos = idx(item, "original_position")
    if pos is not None and opos is not None and opos != pos:
        return f" was=@{jstr(opos)}"
    return ""


_FOLD_DROPPED = (
    "id", "node_id", "url", "html_url", "pull_request_url", "pull_request_review_id",
    "created_at", "updated_at", "reactions", "_links", "body",
)


def fold_key(item: Json) -> str:
    if not isinstance(item, dict):
        raise JqError(f"cannot delete fields from {type_name(item)}")
    return tojson({k: v for k, v in item.items() if k not in _FOLD_DROPPED})


@dataclass(frozen=True)
class Entry:
    """An inline entry after the fold: its first thread's row, every thread id (anchor first), and
    each distinct body under the id of the thread carrying it."""

    row: Json
    thread_ids: list[Json]
    thread_bodies: list[tuple[Json, Json]]


def fold_inline(items: list[Json]) -> list[Entry]:
    """``fold_inline``: threads at one anchor (identical in every field but the deny-list) are one
    entry, in the order the first of them arrived."""
    groups: dict[str, list[Json]] = {}
    for item in items:
        groups.setdefault(fold_key(item), []).append(item)
    out: list[Entry] = []
    for members in groups.values():
        bodies: list[tuple[Json, Json]] = []
        for m in members:
            body = alt(idx(m, "body"), "")
            if not member([b for _, b in bodies], body):
                bodies.append((idx(m, "id"), body))
        out.append(Entry(members[0], [idx(m, "id") for m in members], bodies))
    return out


def thread_list(entry: Entry) -> str:
    return "+".join(jstr(i) for i in entry.thread_ids)


def body_block(entry: Entry) -> str:
    if len(entry.thread_bodies) <= 1:
        return jstr(entry.thread_bodies[0][1])
    return "\n".join(f"[thread {jstr(i)}]\n{jstr(b)}" for i, b in entry.thread_bodies)


def dupe_note(entry: Entry) -> str:
    n = len(entry.thread_ids)
    k = len(entry.thread_bodies)
    if n <= 1:
        return ""
    if k <= 1:
        return f" ({n} identical threads, one reply answers all)"
    return f" ({n} threads at one location, {k} findings as written; one reply answers all)"


def fold_codex_about(body: Json) -> str:
    """The connector's trailing "About Codex in GitHub" block, folded to one line when -- and only
    when -- it is exactly the allowlisted shape (see the shell's comment on ``fold_codex_about``)."""
    text = string(alt(body, ""))
    parts = text.split(CODEX_ABOUT_OPEN)
    if len(parts) < 2:
        return text
    tail = parts[-1].split("</details>")
    if len(tail) == 2 and _NON_SPACE.search(tail[1]) is None:
        return CODEX_ABOUT_OPEN.join(parts[:-1]) + CODEX_ABOUT_FOLDED
    return text


def _login(item: Json) -> str:
    return jstr(path(item, "user", "login"))


def _new(items: list[Json], reviewer: str, since: int) -> list[Json]:
    return [i for i in items if login_is(i, reviewer) and gt(idx(i, "id"), since)]


def _mark(items: list[Json], previous: int) -> str:
    """``jq -s '[.[][].id // 0, $m] | max'``, printed as that prints it: JSON, and without ``-c``,
    so an array or object maximum spans several lines (no GitHub id is one, but the line is what a
    watch reads back)."""
    top = jmax([*(alt(idx(i, "id"), 0) for i in items), previous])
    if isinstance(top, (list, dict)) and top:
        return json.dumps(top, ensure_ascii=False, indent=2)
    return tojson(top)


def poll(ctx: Ctx, pr: str, mark: str) -> Poll:
    """``cmd_poll <pr> <watermark>`` for a resolved PR number; its warnings go to stderr as they
    happen, its stdout is returned."""
    m_inline, m_issue, m_review = (mark_of(mark, n) for n in (1, 2, 3))
    bad = ""
    inline: list[Json] = []
    issue: list[Json] = []
    reviews: list[Json] = []
    try:
        inline = feed(ctx, f"pulls/{pr}/comments?per_page=100")
    except ReadFailed:
        bad += " inline"
    try:
        issue = feed(ctx, f"issues/{pr}/comments?per_page=100")
    except ReadFailed:
        bad += " summary"
    try:
        reviews = feed(ctx, f"pulls/{pr}/reviews?per_page=100")
    except ReadFailed:
        bad += " reviews"
    if bad:
        warn(
            f"API error reading PR {pr} feed(s):{bad} after {ctx.session.config.api_attempts}"
            f" attempts each ({ctx.session.err_line()}) — this round is UNKNOWN, not quiet"
        )
        return Poll(3, "", "", "")
    ctx.snap.put_feeds(pr, issue, reviews)

    try:
        new_review_ids = [jstr(idx(r, "id")) for r in _new(reviews, ctx.reviewer, m_review)]
    except JqError:
        warn(f"could not read which reviews on PR {pr} are new — this round is UNKNOWN, not quiet")
        return Poll(3, "", "", "")
    extra: list[Json] = []
    for rid in " ".join(new_review_ids).split():
        try:
            extra = extra + review_comments(ctx, pr, rid)
        except ReadFailed:
            warn(
                f"API error reading review {rid}'s comments on PR {pr} after"
                f" {ctx.session.config.api_attempts} attempts ({ctx.session.err_line()}) — this"
                " round is UNKNOWN, not quiet"
            )
            return Poll(3, "", "", "")

    out: list[str] = []
    try:
        have = [idx(i, "id") for i in inline]
        inline = inline + [i for i in extra if not member(have, idx(i, "id"))]
        new_inline = fold_inline(_new(inline, ctx.reviewer, m_inline))
        new_issue = [
            i
            for i in _new(issue, ctx.reviewer, m_issue)
            if _SUMMARY_TAG not in body_of(i)
        ]
        new_reviews = _new(reviews, ctx.reviewer, m_review)

        if not new_inline:
            out.append("(no new inline comments)")
        for e in new_inline:
            row = e.row
            out.append(
                f"--- inline id={thread_list(e)} {item_path(row)}:{item_line(row)}{item_side(row)}"
                f"{item_was(row)} commit={inline_commit(row)} by {_login(row)}{dupe_note(e)}\n"
                f"{body_block(e)}"
            )
        for i in new_issue:
            out.append(
                f"--- summary id={jstr(idx(i, 'id'))} commit={item_stamp(i)} by {_login(i)}\n"
                f"{fold_codex_about(idx(i, 'body'))}"
            )
        for r in new_reviews:
            out.append(
                f"--- review id={jstr(idx(r, 'id'))} state={jstr(idx(r, 'state'))}"
                f" commit={review_commit(r)} by {_login(r)}\n{fold_codex_about(idx(r, 'body'))}"
            )
        items_inline = " ".join(
            f"inline:{thread_list(e)}:{inline_commit(e.row)}:{_login(e.row)}:-" for e in new_inline
        )
        items_issue = " ".join(
            f"summary:{jstr(idx(i, 'id'))}:{item_stamp(i)}:{_login(i)}:-" for i in new_issue
        )
        items_review = " ".join(
            f"review:{jstr(idx(r, 'id'))}:{review_commit(r)}:{_login(r)}"
            f":{jstr(alt(idx(r, 'state'), '-'))}"
            for r in new_reviews
        )
        # Each field was a command substitution in the shell, which drops a NUL byte.
        items = f"{items_inline} {items_issue} {items_review}".replace("\0", "")
        out.append(f"items: {items}")
        watermark = (
            f"{_mark(as_list(inline), m_inline)},{_mark(as_list(issue), m_issue)},"
            f"{_mark(as_list(reviews), m_review)}"
        )
        out.append(f"watermark: {watermark}")
    except JqError:
        # The rendering that could not run leaves what it printed before it; the round is refused.
        return Poll(4, "".join(f"{line}\n" for line in out), "", "")
    return Poll(0, "".join(f"{line}\n" for line in out), items, watermark)


def emit(result: Poll) -> None:
    """Print a poll's stdout as the command does."""
    sys.stdout.write(result.text)


def run(session: GhSession, args: list[str]) -> int:
    """``pr-review.sh poll <pr> [watermark]``: one poll, printed, and its status (0 a round, 3 a
    feed did not answer, 4 a feed did not parse)."""
    if not args or not args[0]:
        cli.exit_with(1, "1: usage: poll <pr> [watermark]")
    target = pr_arg(args[0], session.config.repo, session)
    result = poll(outside_watch(session, target.repo), target.num, args[1] if len(args) > 1 else "")
    emit(result)
    return result.rc
