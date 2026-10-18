"""``pr-review.sh comment <pr> <body> [--allow-mention]``: a plain PR comment, over REST.

Ported from the shell's ``cmd_comment`` (ludics-lite#403).

Not every finding has a thread to answer in: a review's SUMMARY body carries no comment ids, so its
answer is a plain PR comment -- and so is the '@codex review' nudge the watch verdicts recommend.
``gh pr comment`` does not take the owner/name#number form this script standardizes on (during
lukstafi/ocannl-staging#475's release prep the workaround was hand-building the PR's URL), so the
comment is POSTed to the REST issues endpoint, through the same write policy as every other write.
issues/<n>/comments and not pulls/<n>/comments: on GitHub a PR *is* an issue, and the pulls endpoint
posts INLINE review comments, which need a commit and a path. Same marker as ``reply``. The POST
carries ``--include`` (ludics-lite#612), so an answer gh could not read is classified by its status
line (``core.gh_unreadable_answer``): a gateway's 502/503 posted nothing and is re-sent, a 403/429
is the quota's, and a 2xx or a 500 stays ambiguous.

A body mentioning '@codex' is refused before any request unless ``--allow-mention``; the bare nudge
is the one body that passes without it (``reply.mention_refusal``).

Stdout: the comment's html_url. Exit: 0 posted; 1 the API rejected it (a 4xx); 2 usage; 3 a gateway
refusal on every attempt (nothing was posted), or an ambiguous failure (it may have been: a POST
adds a comment, so this script will not send it twice).
"""

from typing import assert_never

from ludics import cli
from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhSession,
    GhUnanswered,
    api_rejection,
    die,
    fail,
    pr_arg,
)
from ludics.prreview.reply import MARKER, blank, mention_refusal


def run(session: GhSession, args: list[str]) -> int:
    allow_mention = False
    rest: list[str] = []
    for arg in args:
        if arg == "--allow-mention":
            allow_mention = True
        else:
            rest.append(arg)
    # Exactly two, checked: an unquoted body arrives as several arguments, and posting its first
    # word reads as a posted comment.
    if len(rest) != 2:
        die(
            f"usage: comment <pr> <body> [--allow-mention] — got {len(rest)} argument(s).",
            "The body is ONE argument: quote it, including a multi-line one.",
        )
    pr_ref, body = rest
    if blank(body):
        die("comment: the body is empty; there is nothing to post")
    if not allow_mention:
        mention_refusal("comment", body)
    target = pr_arg(pr_ref, session.config.repo)
    on = f"PR {target.repo}#{target.num}"
    result = session.retry(
        "write",
        [
            "api",
            "-X",
            "POST",
            f"repos/{target.repo}/issues/{target.num}/comments",
            "-f",
            f"body={body}{MARKER}",
            "--jq",
            ".html_url",
        ],
        include=True,
    )
    match result:
        case GhOk(stdout=url):
            cli.emit(url)
            return 0
        case GhUnanswered():
            fail(
                3,
                f"comment on {on} did not go through — the API refused it at the gateway on",
                f"all {session.config.api_attempts} attempts ({session.err_line()}). Nothing was posted, so retry.",
            )
        case GhFailed():
            if api_rejection(session.err_line()):
                fail(
                    1,
                    f"comment on {on} was REJECTED, not dropped: {session.err_line()}.",
                    "Retrying prints the same thing — check the PR number and the repo.",
                )
            fail(
                3,
                f"comment on {on} failed AMBIGUOUSLY: {session.err_line()}.",
                "That is not a gateway refusal, so the comment may or may not have landed and this script",
                "will not post it twice — read the PR, then retry only if it is not there.",
            )
        case _:
            assert_never(result)
