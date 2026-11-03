"""``pr-review.sh resolve <pr> <comment-id>[+<comment-id>...]``: close every review thread the token
names, each answered on its own line.

Ported from the shell's ``cmd_resolve``, ``resolve_one``, ``find_thread``, ``thread_page`` and the
walk they read through, ``threads_walk`` (ludics-lite#403). The token is ``reply``'s, so a folded
entry is closed by one invocation too. Unlike a reply, this is safe to repeat whole: the mutation is
idempotent and an already-resolved thread costs no write.

Threads are addressed by node id, which is only reachable by matching a thread's FIRST comment, by
the id the open-thread gate names it by (``fullDatabaseId``, the BigInt string, ahead of
``databaseId``, a 32-bit Int while review comment ids already run past 2^31; review of #370). The
lookup reads the same connection as the gate, through the same walk, to the same page cap, so
every thread the gate can name is one ``resolve`` can reach (round 1 of #370's review: the two once
paged to different caps). "Not found" is concluded only when EVERY page came back and the rows add
up to the PR's totalCount: a short read is a hole the id could be hiding in (9197c23: a 503'd page
announced "no review thread starts at comment N" for three threads that all existed).

Stdout: ``true`` for one id; ``<id> true`` per id for several; ``true (already resolved)`` for a
thread already closed. Exit: 0 every thread is closed; 1 no thread starts at that comment, or the
API rejected the mutation; 2 usage, or GraphQL rejected the lookup (about the query, not the id);
3 the lookup or the mutation did not complete. Every refusal past the first id names the ids
already closed by this invocation.
"""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import assert_never

from ludics import cli
from ludics.prreview import knobs
from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhSession,
    GhUnanswered,
    Json,
    die,
    fail,
    pr_arg,
)
from ludics.prreview.reply import split_ids
from ludics.prreview.jqsem import JqError, idx, jstr
from ludics.prreview.threads import (
    PageVerdict,
    WalkDone,
    WalkRejected,
    WalkUnread,
    thread_id,
    threads_walk,
)

# --- the review-threads walk (shared with the open-thread gate) -------------------------------------

# THREADS_PAGE_CAP, as the forward hands it over (knobs.threads_page_cap).
PAGE_CAP_ENV = knobs.ENV_THREADS_PAGE_CAP


def page_cap(env: Mapping[str, str]) -> int:
    return knobs.threads_page_cap(env)


# --- resolve ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Found:
    """``find_thread``'s 0: the thread starting at the comment, as ``<node id> <isResolved>``."""

    node: str
    resolved: str


@dataclass(frozen=True)
class Missing:
    """``find_thread``'s 1: every page was read and no thread begins at the comment."""


type Lookup = Found | Missing | WalkRejected | WalkUnread


def find_thread(session: GhSession, repo: str, pr: str, comment_id: str, *, cap: int) -> Lookup:
    """``find_thread`` and its page reader ``thread_page``: the thread whose first comment is
    ``comment_id``, matched as the string GitHub serves (the token admits leading zeros)."""
    wanted = re.sub(r"^0+(?=.)", "", comment_id)
    hit: list[Found] = []

    def page(conn: dict[str, Json]) -> PageVerdict:
        nodes = conn.get("nodes")
        assert isinstance(nodes, list)
        # jq reads every node before the walk sees its output, so a node that does not parse
        # spoils the page even after a hit.
        try:
            names = [(node, thread_id(node)) for node in nodes]
            hits = [
                Found(jstr(idx(node, "id")), jstr(idx(node, "isResolved")))
                for node, name in names
                if name == wanted
            ]
        except JqError:
            return "unparsed"
        if hits:
            hit.append(hits[0])
            return "stop"
        return "more"

    walked = threads_walk(session, repo, pr, page, cap=cap)
    match walked:
        case WalkDone():
            return hit[0] if hit else Missing()
        case WalkRejected() | WalkUnread():
            return walked
        case _:
            assert_never(walked)


_MUTATION = (
    "mutation {{\n      resolveReviewThread(input:{{threadId:\"{node}\"}}) {{\n"
    "      thread {{ isResolved }} }} }}"
)


def resolve_one(
    session: GhSession,
    repo: str,
    pr: str,
    comment_id: str,
    *,
    label: bool,
    done_ids: list[str],
    cap: int,
) -> None:
    """``resolve_one``: one thread, closed. With ``label`` (several ids in the token) each answer is
    prefixed with the id it is about; ``done_ids`` are named in every refusal, so a caller knows
    where it stopped."""
    progress = ""
    if done_ids:
        progress = (
            f" Already resolved in this invocation: {' '.join(done_ids)} — resolving is\n"
            "idempotent, so the whole token is safe to repeat."
        )
    on = f"PR {repo}#{pr}"
    lookup = find_thread(session, repo, pr, comment_id, cap=cap)
    match lookup:
        case Found():
            pass
        case WalkUnread(line=why):
            fail(
                3,
                f"the thread lookup on {on} did not complete: {why} — thread resolution has no",
                "REST equivalent, so this is a RETRY, not a missing thread: the threads are probably all",
                "there, and the reply (REST) may well have gone through. Do NOT read this as someone else",
                f"having resolved it or as a wrong comment id.{progress}",
            )
        case WalkRejected():
            fail(
                2,
                f"GraphQL REJECTED the thread lookup for {on}: {session.err_line()}.",
                f"The search never ran, so this says nothing about comment {comment_id} — check the repo, the PR",
                f"number and `gh auth status` rather than the comment id.{progress}",
            )
        case Missing():
            fail(
                1,
                f"no review thread starts at comment {comment_id} — every page of {on} was read and",
                f"none of them begins there (this is a real answer, not a dropped request){progress}",
            )
        case _:
            assert_never(lookup)
    prefix = f"{comment_id} " if label else ""
    # Already-resolved is the goal state, not a no-op worth an API write.
    if lookup.resolved == "true":
        cli.say(f"{prefix}true (already resolved)")
        return
    # The mutation is idempotent -- resolving a resolved thread just answers true -- so it is
    # retried like a read, on anything short of the API rejecting it.
    result = session.retry(
        "read",
        [
            "api",
            "graphql",
            "-f",
            "query=" + _MUTATION.format(node=lookup.node.split(" ", 1)[0]),
            "--jq",
            ".data.resolveReviewThread.thread.isResolved",
        ],
    )
    match result:
        case GhOk(stdout=out):
            cli.say(f"{prefix}{out}")
        case GhUnanswered():
            fail(
                3,
                f"resolveReviewThread did not answer for the thread at comment {comment_id} on {on}",
                f"after {session.config.api_attempts} attempts ({session.err_line()}); the thread was FOUND, so this is transport",
                f"only — retry when the API recovers, and the mutation is safe to repeat.{progress}",
            )
        case GhFailed():
            fail(
                1,
                f"resolveReviewThread was rejected for the thread at comment {comment_id} on {on}:",
                f"{session.err_line()}{progress}",
            )
        case _:
            assert_never(result)


def run(session: GhSession, args: list[str], *, env: Mapping[str, str] | None = None) -> int:
    if len(args) != 2:
        die(f"usage: resolve <pr> <comment-id>[+<comment-id>...] — got {len(args)} argument(s)")
    target = pr_arg(args[0], session.config.repo, session)
    ids = split_ids(args[1], "resolve")
    cap = page_cap(os.environ if env is None else env)
    label = len(ids) > 1
    resolved: list[str] = []
    for comment_id in ids:
        resolve_one(
            session, target.repo, target.num, comment_id, label=label, done_ids=resolved, cap=cap
        )
        resolved.append(comment_id)
    return 0
