"""``pr-review.sh rounds <pr>``: how many review rounds carried findings, against the threshold.

Ported from the shell's ``rounds_line``, ``count_token`` and ``cmd_rounds`` (ludics-lite#403); the
count itself is ``state.review_rounds``, the one port of ``review_rounds``. A round is a burst of the reviewer's
COMMENTED (or CHANGES_REQUESTED) reviews on one head, or a comment-only round, in submission
order: a new round starts on a different head (a prefix of the other counts as the same) or more
than SHIP_PR_ROUND_GAP seconds after the previous item. Not rounds: pending reviews, the author's
own replies, the round-started placeholder, a no-findings verdict, an initialization failure
(either shape), and an empty envelope holding nothing but the connector's fixed reply.

Stdout: the count line, then the trailer ``rounds: n=<count|unknown> threshold=<n|off>
first=<k|unknown>``, ``first`` being round 1's inline findings (``state.first_round_findings``,
ludics-lite#650: ``fleet-worker.sh prs`` flags a large round 1 at round 3).
Exit: 0 at or under the threshold (or none set), 1 past it, 3 the count could not be read; an
unread ``first`` alone leaves the exit to the count.
"""

from ludics import cli
from ludics.prreview.core import GhSession, pr_arg
from ludics.prreview.knobs import is_digits
from ludics.prreview.feeds import Ctx, outside_watch
from ludics.prreview.state import Rounds, review_rounds


def as_result(rounds: Rounds) -> str:
    """``review_rounds`` (state's port, which ``watch`` counts its rounds with) as the
    shell's ``<count>|<detail>``, the count ``unknown`` when a read failed."""
    return f"{rounds.token()}|{rounds.detail}"


def rounds_result(ctx: Ctx, pr: str) -> str:
    return as_result(review_rounds(ctx, pr, ctx.session.config.round_gap))


def threshold_text(threshold: int | None) -> str:
    return "off" if threshold is None else str(threshold)


def rounds_line(result: str, threshold: int | None) -> tuple[str, int]:
    """``rounds_line``: the line, and 0 at or under the threshold, 1 past it, 3 unread."""
    count, _, detail = result.partition("|")
    if "|" not in result:
        detail = result
    if count == "unknown":
        return f"review rounds: UNKNOWN — {detail}; this is NOT 'no rounds yet', retry", 3
    if threshold is None:
        return f"review rounds with findings: {count} ({detail}); no threshold set", 0
    n = int(count)
    if n > threshold:
        return (
            f"review rounds with findings: {count}, PAST the {threshold}-round threshold —"
            " blocking-only from here: use ship-pr's narrow criteria — consequential defects"
            " introduced or materially worsened by the PR, invalidated central claims or evidence,"
            " or failed build-relevant checks (all non-advisory checks). Merely exposing a severe"
            " pre-existing defect does not block. Defer the rest to ONE follow-up issue, and merge"
            f" on the first round with nothing to push ({detail})",
            1,
        )
    if n == threshold:
        return (
            f"review rounds with findings: {count} of {threshold} — the last round addressed in"
            f" full; from the next, only blocking findings are fixed ({detail})",
            0,
        )
    return f"review rounds with findings: {count} of {threshold} ({detail})", 0


def count_token(result: str) -> str:
    count = result.split("|", 1)[0]
    return count if is_digits(count) else "unknown"


def run(session: GhSession, args: list[str]) -> int:
    if not args or not args[0]:
        cli.exit_with(1, "1: usage: rounds <pr>")
    target = pr_arg(args[0], session.config.repo)
    ctx = outside_watch(session, target.repo)
    rounds = review_rounds(ctx, target.num, session.config.round_gap, first=True)
    result = as_result(rounds)
    line, rc = rounds_line(result, session.config.round_threshold)
    cli.say(line)
    cli.say(
        f"rounds: n={count_token(result)} threshold={threshold_text(session.config.round_threshold)}"
        f" first={rounds.first_token()}"
    )
    return rc
