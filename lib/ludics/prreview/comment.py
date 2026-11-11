"""``pr-review.sh comment <pr> <body>|--body-file <path> [--allow-mention] [--coordinator <model>]``: a plain
PR (or issue) comment, over REST.

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
is the one body that passes without it (``reply.mention_refusal``). ``--body-file <path>`` is the
body read from a file instead of the positional one -- exactly one of the two -- held to what
``reply.read_body_file`` says, the mention guard reading its text as it reads an argument.

``--coordinator <model>`` (#1069) is a wave coordinator's post on an issue or a PR: the body ends
with the footer ``(Posted by the wave coordinator, <model>)`` on a line of its own, after one blank
line, in place of the marker, so the post ENDS with the footer issue-wave's Decision gate reads to
tell a wave's own post from a maintainer decision. The footer is the mechanism, not the caller's
typing. ``coordinator_footer`` and ``footer_refusal`` state what the model may be and which body is
refused as already carrying a footer.

Stdout: the comment's html_url. Exit: 0 posted; 1 the API rejected it (a 4xx); 2 usage; 3 a gateway
refusal on every attempt (nothing was posted), or an ambiguous failure (it may have been: a POST
adds a comment, so this script will not send it twice).
"""

import re
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
from ludics.prreview.reply import MARKER, blank, body_file_arg, mention_refusal, read_body_file

FOOTER_OPENING = "(Posted by the wave coordinator"
# The model a footer names, as a fail-closed allowlist: ASCII letters, digits, and the space and
# . _ + / - a model name is spelled with ("Claude Opus 5.5", "gpt-5.5-codex"), starting with a letter
# or digit and not ending in a space. Refused, then: an empty name, a newline (the footer is one
# line), a parenthesis (it would close the footer early), a comma-separated tail, and any other
# character. Not read: whether the name is a model's at all.
_MODEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._+/-]*[A-Za-z0-9._+/-])?")


def coordinator_footer(model: str) -> str:
    """The footer line for ``--coordinator <model>``; a model outside ``_MODEL`` is a usage error
    (exit 2), before any request."""
    if not _MODEL.fullmatch(model):
        die(
            "comment: --coordinator takes the model that posts, as letters, digits, spaces and . _ + / -",
            f"(e.g. 'Claude Opus 5.5'); got {model!r}. Nothing was posted.",
        )
    return f"{FOOTER_OPENING}, {model})"


def footer_refusal(body: str) -> None:
    """A body that already carries a footer is refused under ``--coordinator`` (exit 2, nothing
    posted): appending a second would post two, and the hand-typed one is the habit the flag
    replaces.

    Boundary: a footer is a LINE (as ``str.splitlines`` splits, so a lone CR or U+2028 ends one
    too) whose first characters, after any whitespace, are ``(Posted by the wave coordinator`` in
    any letter case (as ``str.lower`` folds it), wherever the line stands (inside a fence too:
    refused rather than parsed). The phrase anywhere else in a line passes -- after a quote's
    ``>``, inside a code span or a sentence -- as a quote of the rule, not a footer. Not read:
    Markdown structure, or the text after the opening."""
    opening = FOOTER_OPENING.lower()
    if any(line.lstrip().lower().startswith(opening) for line in body.splitlines()):
        die(
            f"comment: the body already carries a '{FOOTER_OPENING} ...)' line, and --coordinator adds",
            "the footer itself: delete that line from the body and post again. Nothing was posted.",
        )


def run(session: GhSession, args: list[str]) -> int:
    allow_mention = False
    body_file: str | None = None
    model: str | None = None
    rest: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--allow-mention":
            allow_mention = True
        elif (taken := body_file_arg("comment", args, i, body_file)) is not None:
            body_file, i = taken
        elif arg == "--coordinator" or arg.startswith("--coordinator="):
            if model is not None:
                die("comment: --coordinator is given twice; name the one model that posts")
            if arg == "--coordinator":
                if i + 1 >= len(args):
                    die("comment: --coordinator takes the model that posts (e.g. 'Claude Opus 5.5')")
                i += 1
                model = args[i]
            else:
                model = arg[len("--coordinator=") :]
        else:
            rest.append(arg)
        i += 1
    # Exactly two (one with --body-file), checked: an unquoted body arrives as several arguments,
    # and posting its first word reads as a posted comment.
    if body_file is not None:
        if len(rest) != 1:
            die(
                f"usage: comment <pr> --body-file <path> [--allow-mention] [--coordinator <model>] — got {len(rest)} positional",
                "argument(s). The body is the file's, so none is taken after the PR: give the body as",
                "an argument OR as --body-file, not both.",
            )
        pr_ref = rest[0]
        body = read_body_file("comment", body_file)
    else:
        if len(rest) != 2:
            die(
                f"usage: comment <pr> <body>|--body-file <path> [--allow-mention] [--coordinator <model>]"
                f" — got {len(rest)} argument(s).",
                "The body is ONE argument: quote it, including a multi-line one, or write it to a",
                "file and pass --body-file <path>.",
            )
        pr_ref, body = rest
        if blank(body):
            die("comment: the body is empty; there is nothing to post")
    if not allow_mention:
        mention_refusal("comment", body)
    if model is None:
        text = f"{body}{MARKER}"
    else:
        footer = coordinator_footer(model)
        footer_refusal(body)
        text = f"{body.rstrip()}\n\n{footer}"
    target = pr_arg(pr_ref, session.config.repo, session)
    on = f"{'PR' if model is None else 'issue or PR'} {target.repo}#{target.num}"
    result = session.retry(
        "write",
        [
            "api",
            "-X",
            "POST",
            f"repos/{target.repo}/issues/{target.num}/comments",
            "-f",
            f"body={text}",
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
