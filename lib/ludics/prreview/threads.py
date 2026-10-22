"""The PR's review threads: the walk every reader of the connection pages through, and the
open-thread gate (ludics-lite#289) ``status``, ``watch`` and ``merge`` apply under an approval.

Ported once from pr-review.sh's ``THREADS_QUERY``, ``THREAD_ID_JQ``, ``threads_walk``,
``unresolved_threads``/``unresolved_page``, ``threads_named``, ``threads_advice`` and
``merge_threads_gate``; ``resolve``'s lookup (``find_thread``) reads the same connection through the
same walk, to the same page cap, so every thread the gate can name is one ``resolve`` can reach.
Boundary, as the shell states it: a thread is closed only when ``isResolved`` is literally true; the
first comment's id (``fullDatabaseId`` before ``databaseId``), author and path NAME a thread and
never judge it. The connection is read whole -- the rows reaching the ``totalCount`` its last page
states -- or the read is refused as unread, never taken for "none are open".

Which head a thread is about (ludics-lite#587) rides the same page: the first comment's
``originalCommit`` (the commit the reviewer wrote it against) and ``commit`` (where GitHub has
since moved it: forward to the newest head whose lines still hold it). Boundary of that read
(``threads_by_head``), a fail-closed allowlist: a thread is ON the head only when its
``originalCommit.oid`` is exactly the head's SHA; every other open thread is an EARLIER head's,
one whose origin does not read included, so the doubt lands on the side a worker reads before
pushing. ``commit.oid`` equal to the head only counts which earlier threads still sit on lines the
head has; it never puts a thread on the head. Neither field judges whether a thread is open.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, assert_never

from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhSession,
    GhUnanswered,
    Json,
    fail,
    json_stream,
    shell_quote,
)
from ludics.prreview.jqsem import JqError, alt, idx, jstr
from ludics.prreview.jqsem import path as jpath
from ludics.prreview.shtext import tab_fields

THREADS_QUERY = """query($owner:String!, $name:String!, $pr:Int!, $after:String) {
  repository(owner:$owner, name:$name) { pullRequest(number:$pr) {
    reviewThreads(first:100, after:$after) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { id isResolved path
        comments(first:1) { nodes { fullDatabaseId databaseId author { login }
          commit { oid } originalCommit { oid } } } } } } } }"""

@dataclass(frozen=True)
class WalkDone:
    """The page reader stopped the walk (it has what it wanted), or the whole connection was read:
    the rows reached the totalCount the last page states."""


@dataclass(frozen=True)
class WalkRejected:
    """GraphQL rejected the query (threads_walk's 4): nothing about any thread is known."""

    line: str


@dataclass(frozen=True)
class WalkUnread:
    """The read did not complete (threads_walk's 3): no answer, a malformed or short answer, or the
    page cap. None of it is evidence about any thread."""

    line: str


type WalkResult = WalkDone | WalkRejected | WalkUnread
type PageVerdict = Literal["more", "stop", "unparsed"]


def thread_id(node: Json) -> str:
    """THREAD_ID_JQ, ``((.comments.nodes[0] | .fullDatabaseId // .databaseId // "-") | tostring)``:
    a thread's name, its first comment's id, full width first. Raises ``JqError`` where jq erred."""
    first = jpath(node, "comments", "nodes", 0)
    return jstr(alt(alt(idx(first, "fullDatabaseId"), idx(first, "databaseId")), "-"))


@dataclass(frozen=True)
class _Meta:
    total: int
    n: int
    has_next: bool
    cursor: str


def _connection(resp: str) -> tuple[dict[str, Json], _Meta] | None:
    """The page's connection and what the walk reads off it, or None when the answer is not a
    connection: an object with a nodes array, a numeric totalCount and a boolean hasNextPage (a
    ``pullRequest`` of null, GraphQL's way of erroring inside a 200, is refused with the rest)."""
    docs = json_stream(resp)
    if not docs:
        return None
    conn = docs[0]
    if not isinstance(conn, dict):
        return None
    nodes = conn.get("nodes")
    total = conn.get("totalCount")
    try:
        has_next = idx(conn.get("pageInfo"), "hasNextPage")
        cursor = alt(idx(conn.get("pageInfo"), "endCursor"), "")
    except JqError:
        return None
    if not isinstance(nodes, list) or not isinstance(has_next, bool):
        return None
    # "\(.totalCount)" must be digits alone: a bool is no number, and a float prints with a point.
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        return None
    return conn, _Meta(total, len(nodes), has_next, jstr(cursor))


def threads_walk(
    session: GhSession,
    repo: str,
    pr: str,
    on_page: Callable[[dict[str, Json]], PageVerdict],
    *,
    cap: int,
) -> WalkResult:
    """``threads_walk``: page PR ``pr``'s reviewThreads with THREADS_QUERY, the cursor passed as a
    variable, handing each page's connection to ``on_page`` -- ``more`` to read on, ``stop`` when
    it has what it wanted, ``unparsed`` when the page's threads did not parse. The read is whole
    only when the rows read reach the totalCount the last page states; one still paging at ``cap``
    pages is refused as unread rather than judged on its prefix."""
    owner = repo.split("/", 1)[0]
    name = repo.rsplit("/", 1)[-1]
    cursor = ""
    read_n = 0
    for page in range(1, cap + 1):
        args = [
            "api",
            "graphql",
            "-f",
            f"query={THREADS_QUERY}",
            "-F",
            f"owner={owner}",
            "-F",
            f"name={name}",
            "-F",
            f"pr={pr}",
        ]
        if cursor:
            args += ["-f", f"after={cursor}"]
        args += ["--jq", ".data.repository.pullRequest.reviewThreads"]
        result = session.retry("read", args)
        match result:
            case GhOk(stdout=resp):
                pass
            case GhFailed():
                return WalkRejected(f"GraphQL REJECTED the review-threads read ({session.err_line()})")
            case GhUnanswered():
                return WalkUnread(
                    "GraphQL did not answer the review-threads read after"
                    f" {session.config.api_attempts} attempts ({session.err_line()})"
                )
            case _:
                assert_never(result)
        parsed = _connection(resp)
        if parsed is None:
            return WalkUnread(f"the review-threads read answered page {page} without a thread connection")
        conn, meta = parsed
        verdict = on_page(conn)
        match verdict:
            case "more":
                pass
            case "stop":
                return WalkDone()
            case "unparsed":
                return WalkUnread(
                    f"the review-threads read answered page {page} with threads that did not parse"
                )
            case _:
                assert_never(verdict)
        read_n += meta.n
        if not meta.has_next:
            if read_n < meta.total:
                return WalkUnread(
                    f"the review-threads read ended at {read_n} thread(s) while the PR states {meta.total}"
                )
            return WalkDone()
        cursor = meta.cursor
        if not cursor:
            return WalkUnread(
                f"the review-threads read said page {page} has a successor and gave no cursor to it"
            )
    return WalkUnread(
        f"the review-threads read was still paging after {cap} pages of 100, so it is refused"
        f" rather than judged on its first {read_n} thread(s)"
    )


# --- the open-thread gate ---------------------------------------------------------------------------


def _tsv_field(value: str) -> str:
    """One field of jq's ``@tsv``."""
    return value.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


_OID = re.compile(r"[0-9a-f]{40}")


def _oid(commit: Json) -> str:
    """A commit object's ``oid`` when it is 40 lowercase hex, else "-" (never empty: the row is
    read back with ``tab_fields``, which folds a run of tabs into one). Raises ``JqError`` where jq
    would err indexing it."""
    oid = idx(commit, "oid")
    return oid if isinstance(oid, str) and _OID.fullmatch(oid) else "-"


def open_rows(conn: dict[str, Json]) -> list[str]:
    """``unresolved_page``: ``<first comment id>\\t<author>\\t<path>\\t<original commit>\\t<commit>``
    per thread of the page whose isResolved is not literally true, a commit that does not read as
    "-". Raises ``JqError`` where jq erred on a node."""
    nodes = conn.get("nodes")
    assert isinstance(nodes, list)
    rows: list[str] = []
    for node in nodes:
        if idx(node, "isResolved") is True:
            continue
        first = jpath(node, "comments", "nodes", 0)
        author = jstr(alt(idx(idx(first, "author"), "login"), "-"))
        path = jstr(alt(idx(node, "path"), "-"))
        original = _oid(idx(first, "originalCommit"))
        current = _oid(idx(first, "commit"))
        rows.append("\t".join(_tsv_field(v) for v in (thread_id(node), author, path, original, current)))
    return rows


@dataclass(frozen=True)
class OpenThreads:
    """The connection was read whole: the open threads' rows (none is an answer)."""

    rows: list[str]


type Unresolved = OpenThreads | WalkRejected | WalkUnread


def unresolved_threads(session: GhSession, repo: str, pr: str, cap: int) -> Unresolved:
    """``unresolved_threads``: ``threads_walk`` with ``unresolved_page`` -- every open thread, or
    why the connection is unread."""
    rows: list[str] = []

    def page(conn: dict[str, Json]) -> PageVerdict:
        try:
            rows.extend(open_rows(conn))
        except JqError:
            return "unparsed"
        return "more"

    walked = threads_walk(session, repo, pr, page, cap=cap)
    match walked:
        case WalkDone():
            return OpenThreads(rows)
        case WalkRejected() | WalkUnread():
            return walked
        case _:
            assert_never(walked)


def threads_named(rows: list[str]) -> tuple[int, str]:
    """``threads_named``: the count, and the first ten named ("<id> by <author> on <path>", the
    path shell-quoted)."""
    n = 0
    shown = ""
    for row in rows:
        ident, login, path, _original, _current = tab_fields(row, 5)
        if not ident:
            continue
        n += 1
        if n > 10:
            continue
        shown += (", " if shown else "") + f"{ident} by {login} on {shell_quote(path)}"
    if n > 10:
        shown += f", and {n - 10} more"
    return n, shown


@dataclass(frozen=True)
class HeadSplit:
    """``threads_by_head``: how many open threads were written on the head, and the rows of those
    written on earlier heads, with how many of those still sit on lines the head has."""

    on_head: int
    earlier: list[str]
    on_lines: int


def threads_by_head(rows: list[str], head: str) -> HeadSplit:
    """The open threads split by the head they were written on (the boundary is the module's)."""
    on_head = 0
    earlier: list[str] = []
    on_lines = 0
    for row in rows:
        ident, _login, _path, original, current = tab_fields(row, 5)
        if not ident:
            continue
        if head and original == head:
            on_head += 1
            continue
        earlier.append(row)
        if head and current == head:
            on_lines += 1
    return HeadSplit(on_head, earlier, on_lines)


def threads_line(read: Unresolved, head: str) -> str:
    """The ``review threads:`` line ``status`` and every ``watch`` exit print (ludics-lite#587):
    the open threads on the head and on earlier heads, the earlier ones named, so a finding on the
    head about to be replaced is seen before the push past it. An unread walk is UNREAD, never
    "none"."""
    match read:
        case WalkRejected(line=why) | WalkUnread(line=why):
            return f"review threads: UNREAD — {why}; this is not 'none open'"
        case OpenThreads(rows=rows):
            n, named = threads_named(rows)
            if n == 0:
                return "review threads: none open"
            if not head:
                return f"review threads: {n} open (the head did not read, so they are not split by head): {named}"
            split = threads_by_head(rows, head)
            line = (
                f"review threads: {split.on_head} open on head {head[:7]},"
                f" {len(split.earlier)} on earlier heads"
            )
            if split.earlier:
                _, earlier_named = threads_named(split.earlier)
                lines = f" ({split.on_lines} of them on lines head {head[:7]} still has)" if split.on_lines else ""
                line += f"{lines}: {earlier_named} — answer and resolve these before pushing past them"
            return line
        case _:
            assert_never(read)


def threads_advice(repo: str, num: str) -> str:
    """``threads_advice``: what clears an open thread."""
    pr = num or "<pr>"
    return (
        "An open thread is a finding nobody closed, whatever head it cites: one written against an"
        " earlier head is live if this head did not change its lines, and `watch` prints such"
        " findings as NOT about head and moves past them (ludics-lite#289). Read each one, answer"
        f" it with a fix or a rebuttal (pr-review.sh reply {repo}#{pr} <id> '<answer>'), then close"
        f" it (pr-review.sh resolve {repo}#{pr} <id>); clearing this needs no push"
    )


def merge_threads_gate(session: GhSession, repo: str, pr: str, page_cap: int) -> None:
    """``merge_threads_gate``: open threads refuse the merge (1); an unread connection refuses as
    transport (3) -- neither is "none are open"."""
    found = unresolved_threads(session, repo, pr, page_cap)
    match found:
        case WalkRejected(line=why) | WalkUnread(line=why):
            fail(
                3,
                f"NOT merging {repo}#{pr}: {why} — whether review threads are still open is UNKNOWN, which",
                "is not 'none are'; retry.",
            )
        case OpenThreads(rows=rows):
            if not rows:
                return
            count, named = threads_named(rows)
            fail(
                1,
                f"REFUSING to merge {repo}#{pr}: {count} review thread(s) still UNRESOLVED —",
                f"{named}. {threads_advice(repo, pr)}.",
            )
        case _:
            assert_never(found)
