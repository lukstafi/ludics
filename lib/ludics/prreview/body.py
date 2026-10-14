"""``pr-review.sh body <pr> <file>``: replace the PR's description with the file's content, over REST.

Ported from the shell's ``cmd_body`` (ludics-lite#403's first forwarded subcommand).

Why REST: ``gh pr edit --body-file`` rides GraphQL, and on lukstafi/ocannl-staging it fails
outright with the classic Projects deprecation error whatever is being edited (2026-09: a worker's
PR bodies went through a hand-typed ``gh api -X PATCH`` instead). The REST endpoint touches nothing
but the fields sent. A FILE and not an argument, because a body is multi-paragraph Markdown full of
backticks; and not stdin, because gh reads ``@-`` once, so a gateway retry would send the spent
remainder as the new body. No agent marker: the body is the PR's own text, not a reply.

A PATCH SETS the body rather than adding to anything, so repeating it cannot post anything twice,
and it is sent under the READ policy, as ``resolve``'s idempotent mutation is: an ambiguous failure
is retried on the backoff, where the write policy stops at it because a repeated POST posts twice. The case that called for it
(wave 2026-10-14): GitHub answered the PATCH with an empty body, gh printed only its JSON decoder's
``unexpected end of JSON input`` -- no ``gh:``, no HTTP status -- and two runs eight seconds
apart both stopped at exit 3, landing nothing, while the same PATCH by hand went through nine
seconds after the second. The payload
was never the cause: gh reads the file itself (``-F body=@file``), byte for byte.

Stdout: the PR's URL, and nothing else. Exit: 0 done; 1 the API rejected it (a 4xx); 2 usage;
3 not done (a gateway or quota refusal on every attempt) or ambiguous (an attempt failed in a way
that does not say whether it landed, and none confirmed it).
"""

import os
from typing import assert_never

from ludics import cli
from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhUnanswered,
    GhSession,
    api_rejection,
    die,
    fail,
    pr_arg,
)

_SPACE_BYTES = frozenset(b" \t\n\r\f\v")

# gh's JSON decoder, on an answer whose body is empty, cut off or not JSON: gh prints the decoder's
# error alone, without the HTTP status it prints for an answer it can read.
_DECODER_COMPLAINTS = ("unexpected end of JSON input", "invalid character ")


def _why(err_line: str) -> str:
    """The last failure, and what it means when gh could not read GitHub's answer at all."""
    if any(err_line.startswith(c) for c in _DECODER_COMPLAINTS):
        return (
            f"{err_line} -- gh's JSON decoder: GitHub sent no readable answer, so its HTTP status"
            " is unknown"
        )
    return err_line


def _has_content(path: str) -> bool:
    """``grep -q '[^[:space:]]' <file>``: a byte that is not whitespace. Unreadable reads as
    empty, as grep's failure did."""
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        return False
    return any(byte not in _SPACE_BYTES for byte in data)


def run(session: GhSession, args: list[str]) -> int:
    if len(args) != 2:
        die(
            f"usage: body <pr> <file> — got {len(args)} argument(s). The new body is read from",
            "the file, whole; write it there first.",
        )
    pr, path = args
    if path == "-":
        die(
            "body: '-' (stdin) is refused — a retry after a gateway refusal would",
            "read stdin again and find it spent. Write the body to a file.",
        )
    if not (os.path.isfile(path) and os.access(path, os.R_OK)):
        die(f"body: '{path}' is not a readable file")
    if not _has_content(path):
        die(f"body: '{path}' is empty; a PR body is not cleared through this command")
    target = pr_arg(pr, session.config.repo)
    repo, num = target.repo, target.num
    result = session.retry(
        "read",
        ["api", "-X", "PATCH", f"repos/{repo}/pulls/{num}", "-F", f"body=@{path}", "--jq", ".html_url"],
    )
    match result:
        case GhOk(stdout=url):
            cli.emit(url)
            return 0
        case GhUnanswered():
            if session.unclear_attempts() > 0:
                fail(
                    3,
                    f"body of PR {repo}#{num} failed AMBIGUOUSLY on all {session.config.api_attempts}"
                    f" attempts (last: {_why(session.err_line())}). The edit may or may not have landed;",
                    "it sets the body whole, so repeating the same command is safe.",
                )
            fail(
                3,
                f"body of PR {repo}#{num} was not updated — the API refused it at the gateway on all",
                f"{session.config.api_attempts} attempts ({session.err_line()}). Nothing was changed, so retry.",
            )
        case GhFailed():
            if api_rejection(session.err_line()):
                fail(
                    1,
                    f"body of PR {repo}#{num} was REJECTED, not dropped: {session.err_line()}.",
                    "Retrying prints the same thing — check the PR number, the repo and the token's access.",
                )
            fail(
                3,
                f"body of PR {repo}#{num} failed AMBIGUOUSLY: {_why(session.err_line())}. The edit may or may not",
                "have landed; it sets the body whole, so repeating the same command is safe.",
            )
        case _:
            assert_never(result)
