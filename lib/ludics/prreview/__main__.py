"""``scripts/py -m ludics.prreview [--repo owner/name] <subcommand> <args...>``

What pr-review.sh's forward runs for every subcommand, with the same arguments and the shell's
resolved constants in the environment (``PY_FORWARD_VARS``). The shell has already taken its own
``--repo`` off; it is accepted here too so the module can be run directly.

Adding a subcommand: a module ``ludics/prreview/<name>.py`` with ``run(session, args) -> int``,
a ``case "<name>":`` below and its name in ``PORTED``, and in pr-review.sh its name in ``main``'s
case with a ``cmd_<name>`` stub (lib/ludics/README.md).
"""

import os
import sys

from ludics import cli
from ludics.prreview import budget
from ludics.prreview.clock import clock_from_env, plain_sleep
from ludics.prreview.core import PROG, GhSession, die, load_config

PORTED = (
    "body", "reply", "resolve", "comment", "retry", "poll", "status", "rounds", "checks", "merge",
    "base", "watch", "merge-build", "local-review",
)
# Entry points for the suites, which pr-review.sh's command line does not route to (see status.py).
INTERNAL = ("status-state", "status-line")


def dispatch(argv: list[str]) -> int:
    env = dict(os.environ)
    args = list(argv)
    if args and args[0] == "--repo":
        if len(args) < 2 or not args[1]:
            die("--repo owner/name")
        env["REPO"] = args[1]
        args = args[2:]
    elif args and args[0].startswith("--repo="):
        env["REPO"] = args[0][len("--repo=") :]
        args = args[1:]
    config = load_config(env)
    # The polling budget every subcommand's own calls share (its knobs validated here, for every
    # subcommand, as the shell validated them when it was sourced). The observer lock a command
    # takes is released however it ends.
    shared = budget.from_env(env, clock_from_env(env))
    session = GhSession(config, sleep=plain_sleep(env), budget=shared)
    try:
        return _run(session, args, env)
    finally:
        shared.release()


def _run(session: GhSession, args: list[str], env: dict[str, str]) -> int:
    sub = args[0] if args else ""
    rest = args[1:]
    match sub:
        case "body":
            from ludics.prreview import body

            return body.run(session, rest)
        case "reply":
            from ludics.prreview import reply

            return reply.run(session, rest)
        case "resolve":
            from ludics.prreview import resolve

            return resolve.run(session, rest)
        case "comment":
            from ludics.prreview import comment

            return comment.run(session, rest)
        case "retry":
            from ludics.prreview import retry

            return retry.run(session, rest)
        case "poll":
            from ludics.prreview import poll

            return poll.run(session, rest)
        case "status":
            from ludics.prreview import status

            return status.run(session, rest)
        case "rounds":
            from ludics.prreview import rounds

            return rounds.run(session, rest)
        case "status-state":
            from ludics.prreview import status

            return status.run_state(session, rest)
        case "status-line":
            from ludics.prreview import status

            return status.run_line(session, rest)
        case "checks":
            from ludics.prreview import checks

            return checks.run(session, rest)
        case "merge":
            from ludics.prreview import merge

            return merge.run(session, rest)
        case "merge-build":
            from ludics.prreview import mergedry

            return mergedry.run(session, rest)
        case "local-review":
            from ludics.prreview import localreview

            return localreview.run(rest)
        case "base":
            from ludics.prreview import base

            return base.run(session, rest)
        case "watch":
            from ludics.prreview import watch

            return watch.run(session, rest, env)
        case _:
            die(
                f"'{sub}' is not a subcommand ported to Python (ported: {' '.join(PORTED)});",
                "run it through pr-review.sh, which serves every subcommand.",
            )


def main() -> int:
    return cli.main(PROG, dispatch)


if __name__ == "__main__":
    sys.exit(main())
