"""``pr-review.sh retry [--read|--write] [gh] <gh args...>``: any other gh call, under this script's
retry policy, instead of a hand-rolled loop.

Ported from the shell's ``cmd_retry`` (ludics-lite#403). The 2026-08-17 outage had a session
hand-rolling ``for i in 1 2 3`` around ``gh pr comment`` and ``gh pr merge`` five separate times.
The default is the WRITE policy (gateway refusals only, so a merge or a comment cannot be sent twice
from an ambiguous error); ``--read`` opts into the broader one for a plain GET. A leading ``gh``,
as a caller pastes it, is tolerated. ``run watch`` is never forwarded to gh: it is the quiet await
in ``runwatch``.

The caller's arguments are classified as a CALLER's (``GhSession.retry_caller``): gh refusing them
on a command path that runs nothing but gh's own parse and API calls (``gh_api_only_command``,
ludics-lite#452) sent nothing, so it is a usage error on the first attempt; on any other path (an
alias, an extension, a subcommand that runs git) the same line is not read as gh's.

A listed path's answer gh WITHHOLDS for the terminal escape sequences in it (a job's log read
without ``--allow-escape-sequences``) is the caller's call to fix too, though the request did reach
GitHub: it was read as transport, retried four times and reported UNKNOWN (post-wave-3 task 8).

Stdout: gh's own, on success. Exit: 0 done; 1 the API rejected it (a 4xx, or a GraphQL error no
retry can change, ludics-lite#422, or under --read a NOT_FOUND, ludics-lite#663); 2 usage, or gh
refused the arguments and sent nothing, or gh withheld the answer for want of
``--allow-escape-sequences``; 3 the API never answered, or a write failed ambiguously, a NOT_FOUND
included (another field of it may have landed) -- the outcome is UNKNOWN, never a failure of the
command's job.
"""

from typing import assert_never

from ludics import cli
from ludics.prreview import runwatch
from ludics.prreview.core import (
    GhArgsRefused,
    GhFailed,
    GhOk,
    GhOutputWithheld,
    GhSession,
    GhUnanswered,
    Mode,
    api_rejection,
    die,
    fail,
    gh_api_only_command,
    graphql_fixed_answer,
    graphql_not_found,
)


def run(session: GhSession, args: list[str]) -> int:
    mode: Mode = "write"
    rest = list(args)
    if rest[:1] == ["--read"]:
        mode = "read"
        rest = rest[1:]
    elif rest[:1] == ["--write"]:
        rest = rest[1:]
    if rest[:1] == ["gh"]:
        rest = rest[1:]
    if not rest:
        die("usage: retry [--read] <gh args...>")
    if rest[:2] == ["run", "watch"]:
        return runwatch.run(session, rest[2:])
    result = session.retry_caller(mode, rest, listed=gh_api_only_command(rest))
    command = rest[0]
    err = session.err_line()
    match result:
        case GhOk(stdout=out):
            cli.emit(out)
            return 0
        case GhArgsRefused():
            die(
                f"gh {command} refused its own arguments and sent nothing: {err}. That is a usage",
                "error in the command, not an API answer and not transport — re-sending it prints the same",
                "refusal, and nothing reached GitHub, so fix the arguments and run it again.",
            )
        case GhOutputWithheld():
            die(
                f"gh {command} withheld GitHub's answer: {err}. Not transport and not GitHub's answer",
                "about the request: re-sending it prints the same refusal. The request was sent and",
                "answered, so a write it carried is not to be repeated; for a read (a job's log), re-run",
                "it with --allow-escape-sequences and keep the raw output in a file rather than on a",
                "terminal.",
            )
        case GhUnanswered():
            fail(
                3,
                f"gh {command} did not go through after {session.config.api_attempts} attempts ({err});",
                "the API never answered, so the outcome is UNKNOWN — confirm the state before retrying a",
                "write, and never report the command as having failed to do its job.",
            )
        case GhFailed():
            # A NOT_FOUND is the fact only for a read: a write's other fields may have landed.
            not_found = mode == "read" and graphql_not_found(err)
            if api_rejection(err) or graphql_fixed_answer(err) or not_found:
                fail(1, f"gh {command} was rejected: {err}")
            fail(
                3,
                f"gh {command} failed AMBIGUOUSLY: {err}. Not a gateway refusal, so a write may have",
                "landed and this did not repeat it — confirm the state (over REST) before retrying.",
            )
        case _:
            assert_never(result)
