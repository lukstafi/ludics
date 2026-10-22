"""pr-review.sh's source-time constants beyond the core's, each resolved and validated once.

The shell resolved these when it was sourced, in one place each, and died on a bad value before any
subcommand ran; a forwarded call has therefore passed the shell's check already, and these are what a
direct ``scripts/py -m ludics.prreview`` run gets. Every subcommand reads a constant through the one
function here, so the default, the validation and the message are the shell's once.

Some constants are no environment knob in the shell (THREADS_PAGE_CAP, ADVISORY_SETTLE, ...), and
one is read as "the caller SET this" (SHIP_PR_ADVISORY_CHECKS): the forwarder hands those over under
a private ``LUDICS_`` name (pr-review.sh's PY_FORWARD_VARS), so a suite's ``retune`` reaches the
Python and a default is never read as a caller's choice.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass

from ludics.prreview.core import die

_DIGITS = re.compile(r"[0-9]+")
# The largest integer bash's `test` reads; one digit more is an error there, not a number.
INTMAX = 2**63 - 1

DEFAULT_ADVISORY = "^(claude|Claude Code|github pages docs)$"

# The forward's private names (PY_FORWARD_VARS in pr-review.sh).
ENV_BUILD_ADVISORY = "LUDICS_BUILD_ADVISORY"
ENV_ADVISORY_FROM_ENV = "LUDICS_PR_ADVISORY_FROM_ENV"
ENV_ADVISORY_SETTLE = "LUDICS_PR_ADVISORY_SETTLE"
ENV_CONTENTS_DIR_CAP = "LUDICS_PR_CONTENTS_DIR_CAP"
ENV_IGNORE_MAX_COMMITS = "LUDICS_PR_IGNORE_MAX_COMMITS"
ENV_THREADS_PAGE_CAP = "LUDICS_THREADS_PAGE_CAP"

THREADS_PAGE_CAP = 50
ADVISORY_SETTLE = 60
CONTENTS_DIR_CAP = 1000
IGNORE_MAX_COMMITS = 20


def is_digits(text: str) -> bool:
    return _DIGITS.fullmatch(text) is not None


def _set_or(env: Mapping[str, str], name: str, default: str) -> str:
    """``${NAME:-default}``: an empty value takes the default too."""
    return env.get(name, "") or default


def _whole(env: Mapping[str, str], name: str, default: str, what: str) -> int:
    """``case "$X" in '' | *[!0-9]*) die ...``."""
    text = _set_or(env, name, default)
    if not is_digits(text):
        die(f"{name} must be {what}, got '{text}'")
    return int(text)


def private_int(env: Mapping[str, str], name: str, default: int) -> int:
    """A shell constant no environment configures, as the forward handed it over (digits), else
    its default."""
    value = env.get(name, "")
    return int(value) if is_digits(value) else default


@dataclass(frozen=True)
class Timing:
    """The checks cadence: the poll interval, the deadline and the heartbeat, in whole seconds."""

    interval: int
    wait: int
    heartbeat: int


def absent_grace(env: Mapping[str, str]) -> int:
    """ABSENT_GRACE (SHIP_PR_BASE_ABSENT_GRACE, 300): how long a push may go without a run."""
    return _whole(env, "SHIP_PR_BASE_ABSENT_GRACE", "300", "a number of seconds")


def checks_timing(env: Mapping[str, str]) -> Timing:
    """CHECKS_INTERVAL, CHECKS_WAIT, CHECKS_HEARTBEAT: whole seconds, fed to deadlines and sleep
    caps, where a fraction does not degrade gracefully; a zero interval would busy-loop, and one
    past bash's integer fails its ``-gt 0`` as 0 does."""
    interval = _whole(env, "SHIP_PR_CHECKS_INTERVAL", "60", "whole seconds")
    if not 0 < interval <= INTMAX:
        die(f"SHIP_PR_CHECKS_INTERVAL must be at least 1 second, got '{_set_or(env, 'SHIP_PR_CHECKS_INTERVAL', '60')}'")
    wait = _whole(env, "SHIP_PR_CHECKS_WAIT", "7200", "whole seconds")
    heartbeat = _whole(env, "SHIP_PR_CHECKS_HEARTBEAT", "600", "whole seconds")
    return Timing(interval, wait, heartbeat)


# How long a head must have been up, with nothing started on it, before its round is judged: the
# evidence a commit's date cannot give that the push is not simply too new for the reviewer's own
# automatic review. That 👀 lands seconds after a push (on ludics-lite#583, 18s to the connector's
# first answer, 12s from a request to its 👀); five minutes is the margin, capped by the grace for
# a grace set shorter (``pickup``). ``watch`` holds its automatic nudges for it from a head's first
# sight, and the state reads a 👀 left up from before a head's arrival as that head's pickup for it
# (ludics-lite#752's fold-in), one clock for both.
PICKUP = 300


def pickup(grace: int) -> int:
    """The pickup margin under a grace of ``grace`` seconds: ``PICKUP``, capped by the grace."""
    return min(PICKUP, grace)


def review_clocks(env: Mapping[str, str]) -> tuple[int, int]:
    """GRACE (SHIP_PR_REVIEW_GRACE, 1200) and STALL (SHIP_PR_REVIEW_STALL, one and a half times
    the grace: 30 minutes by default). A round on this repository's last 25 merged PRs drew its
    review within 17 minutes of its commit, the hung ones (#759, ahrefs/ocannl#1406, #1429, #1453)
    sat 35 minutes to over an hour, and since ludics-lite#760 a stall is what ``watch`` nudges on,
    so it is read at half again the grace rather than at twice it (ludics-lite#769)."""
    grace = _whole(env, "SHIP_PR_REVIEW_GRACE", "1200", "a number of seconds")
    stall = _whole(env, "SHIP_PR_REVIEW_STALL", str(grace * 3 // 2), "a number of seconds")
    return grace, stall


def stale_base(env: Mapping[str, str]) -> int | None:
    """STALE_BASE (SHIP_PR_STALE_BASE, 20): commits behind the base at which ``merge`` warns
    loudly; None for ``off``."""
    text = _set_or(env, "SHIP_PR_STALE_BASE", "20")
    if text == "off":
        return None
    if not is_digits(text):
        die(f"SHIP_PR_STALE_BASE must be a number of commits or 'off', got '{text}'")
    return int(text)


def never_started(env: Mapping[str, str]) -> int | None:
    """NEVER_STARTED (SHIP_PR_NEVER_STARTED, 1200): seconds a build job may sit queued before,
    with a newer run's job on the same labels started, it reads as NEVER STARTED (runners.py);
    None for ``off``."""
    text = _set_or(env, "SHIP_PR_NEVER_STARTED", "1200")
    if text == "off":
        return None
    if not is_digits(text):
        die(f"SHIP_PR_NEVER_STARTED must be whole seconds or 'off', got '{text}'")
    return int(text)


def build_advisory(env: Mapping[str, str]) -> str:
    """BUILD_ADVISORY as the shell resolved it: the forward's value when there is one (which may
    have come from the repository's advisory file), else SHIP_PR_ADVISORY_CHECKS or the default."""
    if ENV_BUILD_ADVISORY in env:
        return env[ENV_BUILD_ADVISORY]
    return _set_or(env, "SHIP_PR_ADVISORY_CHECKS", DEFAULT_ADVISORY)


def advisory_from_env(env: Mapping[str, str]) -> bool:
    """ADVISORY_FROM_ENV: whether the caller SET SHIP_PR_ADVISORY_CHECKS."""
    if ENV_ADVISORY_FROM_ENV in env:
        return bool(env[ENV_ADVISORY_FROM_ENV])
    return bool(env.get("SHIP_PR_ADVISORY_CHECKS", ""))


def threads_page_cap(env: Mapping[str, str]) -> int:
    """THREADS_PAGE_CAP: how many 100-thread pages a thread walk reads before it stops."""
    return private_int(env, ENV_THREADS_PAGE_CAP, THREADS_PAGE_CAP)


def poll_caps(env: Mapping[str, str]) -> tuple[int, int]:
    """REVIEW_POLL_CAP (SHIP_PR_REVIEW_POLL_CAP, 300) and BUILD_POLL_CAP (SHIP_PR_BUILD_POLL_CAP,
    600): the seconds the polling budget's pause doubles up to (budget.py)."""
    return (
        _whole(env, "SHIP_PR_REVIEW_POLL_CAP", "300", "whole seconds"),
        _whole(env, "SHIP_PR_BUILD_POLL_CAP", "600", "whole seconds"),
    )
