"""``pr-review.sh reply``: answer a review thread, or a whole folded entry, from one invocation.

    reply <pr> <comment-id>[+<comment-id>...] <body> [--allow-mention]
    reply <pr> <comment-id>[+<comment-id>...] --anchor <comment-id>

Ported from the shell's ``cmd_reply`` and its helpers (``split_ids``, ``ids_from``, ``ids_token``,
``thread_url``, ``post_reply``, ``reply_failed``, ``mention_refusal``); ludics-lite#403. The
incident history these rules come from is in the shell's comments at the commit before the port
and in ship-pr/scripts/test-pr-review-reply.sh, which pins every one of them.

- The comment-id argument is the token poll RENDERS: ``900`` for one thread, ``900+901+902`` for a
  folded entry (ludics-lite#76). The body goes to the ANCHOR (the first id), and each duplicate
  gets a one-line pointer to the anchor's reply, so a duplicate costs no composed answer of its
  own. The WHOLE token is matched against its grammar before anything is split off it (round 1 of
  #86: a split that word-split or globbed turned "900 901" or "*" into comment ids).
- ``--anchor <id>``: the answer already stands in that thread, so no body is taken and every id in
  the token is pointed at it. It is the retry a batch that failed part-way hands back (round 3 of
  #86): handing back the plain remainder would promote its first id to anchor and post the
  composed answer a second time.
- A reply is the one write here that cannot be repeated safely, so a failure says what LANDED and
  what to retry with, and the progress turns on the classification as well as on how far the
  batch got: a gateway refusal and a rejection posted nothing for that id, an ambiguous failure
  (a 500, a dropped connection) may have, and is stated as the question it is, with both answers
  (round 2 of #86).
- A body mentioning '@codex' is refused before any request, unless ``--allow-mention``
  (ludics-lite#472); see ``mention_refusal``.

Stdout: each reply's html_url, one per line, in the order they were posted. Exit: 0 every reply
posted; 1 the API rejected one (a 4xx); 2 usage; 3 a gateway refusal on every attempt, or an
ambiguous failure.
"""

import re
from typing import NoReturn, assert_never

from ludics import cli
from ludics.prreview import space
from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhResult,
    GhSession,
    GhUnanswered,
    api_rejection,
    die,
    fail,
    pr_arg,
)

# Every reply and comment from this script carries it, so a human scanning a thread knows what
# wrote it. It follows the body after one blank line.
MARKER = "\n\n_🤖 Addressed by an automated coding agent_"

_TOKEN = re.compile(r"[0-9]+(?:\+[0-9]+)*")
_ID = re.compile(r"[0-9]+")
_MENTION = re.compile(r"@[Cc][Oo][Dd][Ee][Xx]")


def blank(body: str) -> bool:
    """``[ -n "${body//[[:space:]]/}" ]`` failing: nothing in the body but whitespace, as the
    caller's locale classes it (``space``: under en_US.UTF-8 a body of U+3000 is empty)."""
    return space.blank(body)


def split_ids(token: str, command: str) -> list[str]:
    """``split_ids``: the token's comment ids, anchor first, a repeat dropped (one finding either
    way, and a second write would point the anchor at itself). Digits and single ``+``, matched
    WHOLE before anything is split off it; anything else is refused (exit 2), since an id that
    stayed "900+901" would address no comment and come back as a 404 read as a missing thread."""
    if not _TOKEN.fullmatch(token):
        die(
            f"{command}: '{token}' is not a comment id — a comment id is digits, and several are"
            " joined by single",
            "'+' as poll renders a folded entry (900+901+902)",
        )
    ids: list[str] = []
    for piece in token.split("+"):
        if piece not in ids:
            ids.append(piece)
    return ids


def ids_token(ids: list[str]) -> str:
    """``ids_token``: a list of ids as the TOKEN this command takes, which a caller can paste back
    (round 3 of #86: the internal space-joined form cannot be)."""
    return "+".join(ids)


def mention_refusal(command: str, body: str) -> None:
    """``mention_refusal`` (ludics-lite#472): any '@codex' in a written body is an instruction to the
    connector -- on PR #465 a reply QUOTING the nudge summoned it, and its answer was counted as a
    round. Refused (exit 2) before any request.

    Boundary, as a fail-closed allowlist: the ONE body that passes with a mention in it is
    ``comment``'s bare nudge, exactly '@codex review' with trailing whitespace allowed (the shape
    status_state reads as a request; whitespace as the caller's locale classes it, as the shell's
    trim did). Every other body holding the characters '@codex', in any
    ASCII letter case, refuses: inside a code span or a fence, quoted, inside an email-like word, or
    as the prefix of a longer handle. Not read: Markdown structure, whether GitHub renders the
    mention as a link, or whether the connector would act on it. ``reply`` has no allowlisted body:
    the nudge goes to the PR conversation through ``comment``."""
    if not _MENTION.search(body):
        return
    if command == "comment" and space.rstrip(body) == "@codex review":
        return
    if command == "comment":
        nudge = "the bare nudge is the one body that may mention it"
    else:
        nudge = "a nudge goes through `comment <pr> '@codex review'`, never a thread"
    die(
        f"{command}: the body mentions '@codex', and any mention is an instruction to the connector —",
        "a quoted '@codex review' summoned it on PR #465 and drew a reply counted as a round. Rephrase",
        'without the at-sign ("the codex review nudge"), or pass --allow-mention if the mention is',
        f"meant; {nudge}. Nothing was posted.",
    )


def thread_url(repo: str, pr: str, comment_id: str) -> str:
    """``thread_url``: where a thread lives, from its first comment id alone -- the html_url shape
    GitHub serves for a review comment, so no read is spent on it."""
    return f"https://github.com/{repo}/pull/{pr}#discussion_r{comment_id}"


def post_reply(session: GhSession, repo: str, pr: str, comment_id: str, text: str) -> GhResult:
    """``post_reply``: one reply into one thread, under the WRITE policy (re-sent only after a
    gateway refusal, which no backend ran). With ``--include``, so an answer gh could not read is
    classified by its status line (ludics-lite#612, ``core.gh_unreadable_answer``)."""
    return session.retry(
        "write",
        [
            "api",
            "-X",
            "POST",
            f"repos/{repo}/pulls/{pr}/comments/{comment_id}/replies",
            "-f",
            f"body={text}{MARKER}",
            "--jq",
            ".html_url",
        ],
        include=True,
    )


def reply_failed(
    session: GhSession,
    result: GhFailed | GhUnanswered,
    repo: str,
    pr: str,
    comment_id: str,
    answered: list[str],
    rest: list[str],
    anchor: str,
) -> NoReturn:
    """``reply_failed``: what a failed reply says, with the batch's progress in it; always exits.

    ``rest`` is the ids not answered, ``comment_id`` first; ``anchor`` the thread that holds the
    answer, empty when none does yet. Once an answer stands in a thread, every retry keeps pointing
    at it with ``--anchor``.

    The ambiguous message's last two parts are the shell's ``${after:+...}`` and ``${after:-...}``
    as written, so the text is the shell's to the byte: when ids remain, the second appends their
    raw space-joined list after "if it is"; on the last id the first is empty, which leaves a
    double space before "there is nothing else outstanding"."""
    err = session.err_line()
    after = rest[1:]
    keep = f" --anchor {anchor}" if anchor else ""
    retry = ids_token(rest) + keep
    landed = (
        f"The replies to {' '.join(answered)} DID land, so do not repeat those. " if answered else ""
    )
    target = f"PR {repo}#{pr}"
    match result:
        case GhUnanswered():
            fail(
                3,
                f"reply to comment {comment_id} on {target} did not go through — the API refused it at the",
                f"gateway on all {session.config.api_attempts} attempts ({err}). {landed}Nothing was posted for",
                f"comment {comment_id}, so retry with: {retry}",
            )
        case GhFailed():
            if api_rejection(err):
                fail(
                    1,
                    f"reply to comment {comment_id} on {target} was REJECTED, not dropped: {err}.",
                    f"Retrying prints the same thing — check the comment id and the PR. {landed}Comment {comment_id} got",
                    f"nothing, so once the id is right, retry with: {retry}",
                )
            raw_after = "".join(f" {i}" for i in after)
            fail(
                3,
                f"reply to comment {comment_id} on {target} failed AMBIGUOUSLY: {err}.",
                "That is not a gateway refusal, so the reply MAY have landed and this script will not post it",
                f"twice. {landed}Read comment {comment_id}'s thread: retry with: {retry} if the reply is not there;",
                f"retry with: {ids_token(after)} --anchor {anchor or comment_id} if it is" if after else "",
                raw_after or "there is nothing else outstanding if it is",
            )
        case _:
            assert_never(result)


def run(session: GhSession, args: list[str]) -> int:
    anchor = ""
    allow_mention = False
    rest: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--allow-mention":
            allow_mention = True
        elif arg == "--anchor":
            if i + 1 >= len(args):
                die("reply: --anchor takes the comment id of the thread the answer is already in")
            i += 1
            anchor = args[i]
        elif arg.startswith("--anchor="):
            anchor = arg[len("--anchor=") :]
        else:
            rest.append(arg)
        i += 1
    # Exactly three (two with --anchor), checked rather than read loosely: a body is a sentence, and
    # an unquoted one arrives as several arguments -- posting its first word reads as a posted reply.
    # An empty --anchor is no anchor, as it was in the shell.
    body = ""
    if anchor:
        if len(rest) != 2:
            die(
                "usage: reply <pr> <comment-id>[+<comment-id>...] --anchor <comment-id> —",
                f"got {len(rest)} positional argument(s). With --anchor the answer already stands in that thread,",
                "so no body is taken: every id in the token is pointed at it.",
            )
        if not _ID.fullmatch(anchor):
            die(f"reply: --anchor takes one comment id, got '{anchor}'")
    else:
        if len(rest) != 3:
            die(
                "usage: reply <pr> <comment-id>[+<comment-id>...] <body> [--allow-mention] —"
                f" got {len(rest)} argument(s).",
                "The body is ONE argument: quote it, including a multi-line one.",
            )
        body = rest[2]
        if blank(body):
            die("reply: the body is empty; there is nothing to post")
        if not allow_mention:
            mention_refusal("reply", body)
    pr_ref, token = rest[0], rest[1]
    target = pr_arg(pr_ref, session.config.repo)
    repo, pr = target.repo, target.num
    ids = split_ids(token, "reply")
    anchor_url = ""
    if anchor:
        if anchor in ids:
            die(
                f"reply: --anchor {anchor} is also in the token '{token}' — a thread cannot be pointed at",
                "itself; name the threads that still need the pointer",
            )
        anchor_url = thread_url(repo, pr, anchor)
    answered: list[str] = []
    for n, comment_id in enumerate(ids):
        if anchor:
            where = anchor_url or f"comment {anchor}"
            text = f"Duplicate of the thread answered at {where} — see there."
        else:
            text = body
        result = post_reply(session, repo, pr, comment_id, text)
        match result:
            case GhOk(stdout=url):
                pass
            case GhFailed() | GhUnanswered():
                reply_failed(session, result, repo, pr, comment_id, answered, ids[n:], anchor)
            case _:
                assert_never(result)
        cli.emit(url)
        if not anchor:
            anchor = comment_id
            anchor_url = url
        answered.append(comment_id)
    return 0
