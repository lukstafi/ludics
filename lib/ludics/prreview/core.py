"""The shared core of pr-review.sh, ported from its prelude (everything above ``cmd_poll``).

What is here, and the shell function each piece ports (the shell's comments carry the incident
history; read them there before changing a rule here):

  fail / die / warn               ``fail``, ``die``, ``warn``: exit codes 1 = the fact does not
                                  hold, 2 = the caller or the environment is wrong, 3 = the API
                                  never answered, so nothing is known (4 and 5 belong to the
                                  commands that define them)
  Config / load_config            the source-time constants and their validation
  GhSession.retry / retry_caller  ``gh_retry`` and its classification: ``gateway_failure``,
                                  ``api_rejection``, ``graphql_fixed_answer``,
                                  ``graphql_not_found`` (ludics-lite#663),
                                  ``gh_unreadable_answer`` and ``split_included`` (an answer
                                  gh could not read, classified by the status line
                                  ``--include`` keeps: ludics-lite#612),
                                  ``gh_client_refusal``, ``transient_failure``, ``gh_err_line``,
                                  ``gh_refused_own`` (an exception here, not a USR2 trap and a
                                  marker file: #471's stop is one ``GhRefusedOwn`` reaching main)
  gh_api_only_command             ``gh_api_only_command`` (the allowlist for a CALLER's args)
  parse_ref / pr_arg / resolve_repo / repo_from_cwd
                                  the repository rules (ludics-lite#92: never from the cwd for a
                                  PR; ``repo_from_cwd`` survives for ``base`` alone)
  api_list / mark_of              ``api_list`` (a feed that is whole or absent) and ``mark_of``

Not here: the jq line-ending probe (``jq_eol_probe``: Python reads JSON itself, so no jq), the
per-attempt stderr temp files and their sweep (captured in memory here), and the round snapshot
(``snapshot_*``: it existed because a command substitution's variables die with its subshell;
a Python watch keeps its round in an object -- the watch porter's to design).

Every gh call goes through ``proc.run_tool``: the gh BINARY on PATH, or the suites' fixture
function through the shell bridge (see ``ludics.proc``).
"""

import json
import os
import re
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING, Literal, NoReturn

from ludics import cli, proc

if TYPE_CHECKING:
    # budget.py imports this module; the session holds one at run time, typed here only.
    from ludics.prreview.budget import Budget

PROG = "pr-review.sh"


def fail(rc: int, *parts: str) -> NoReturn:
    """``fail <rc> <message...>``: end the command with ``rc``, the parts joined by spaces."""
    cli.exit_with(rc, *parts)


def die(*parts: str) -> NoReturn:
    """``die``: a usage or configuration error, exit 2."""
    fail(2, *parts)


def warn(*parts: str) -> None:
    """``warn``: ``pr-review.sh: <message>`` on stderr, the command goes on."""
    cli.note(PROG, " ".join(parts))


# --- configuration ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Config:
    """The source-time constants of pr-review.sh's prelude.

    ``round_threshold`` is None for ``off``. Constants the later sections define (GRACE, the
    checks intervals, ...) are added by the porter of the subcommand that reads them, together
    with their line in the shell forwarder's ``PY_FORWARD_VARS``.
    """

    repo: str
    reviewer: str
    round_threshold: int | None
    round_gap: int
    api_attempts: int
    api_backoff: int


def _env(env: Mapping[str, str], name: str, default: str) -> str:
    """``${NAME:-default}``: unset and empty both take the default."""
    value = env.get(name, "")
    return value if value else default


_NATURAL = re.compile(r"0|[1-9][0-9]*")


def load_config(env: Mapping[str, str]) -> Config:
    threshold_text = _env(env, "SHIP_PR_ROUND_THRESHOLD", "12")
    # A typo ("12x") must not read as `off`: anything but a number or the literal `off` is a
    # usage error. The shell's pattern admits `0` and numbers without a leading zero.
    if threshold_text == "off":
        threshold: int | None = None
    elif _NATURAL.fullmatch(threshold_text):
        threshold = int(threshold_text)
    else:
        die(f"SHIP_PR_ROUND_THRESHOLD must be a number of rounds or 'off', got '{threshold_text}'")
    gap_text = _env(env, "SHIP_PR_ROUND_GAP", "900")
    if not _NATURAL.fullmatch(gap_text):
        die(f"SHIP_PR_ROUND_GAP must be a nonnegative number of seconds, got '{gap_text}'")
    # The shell compared these with `[ -ge ]` unvalidated, so a non-number failed obscurely
    # mid-retry; here it is the configuration error it always was.
    attempts_text = _env(env, "SHIP_PR_API_ATTEMPTS", "4")
    if not re.fullmatch(r"[0-9]+", attempts_text):
        die(f"SHIP_PR_API_ATTEMPTS must be a whole number of attempts, got '{attempts_text}'")
    backoff_text = _env(env, "SHIP_PR_API_BACKOFF", "5")
    if not re.fullmatch(r"[0-9]+", backoff_text):
        die(f"SHIP_PR_API_BACKOFF must be a whole number of seconds, got '{backoff_text}'")
    return Config(
        repo=env.get("REPO", ""),
        reviewer=_env(env, "REVIEWER", "chatgpt-codex-connector"),
        round_threshold=threshold,
        round_gap=int(gap_text),
        api_attempts=int(attempts_text),
        api_backoff=int(backoff_text),
    )


# --- classifying a failed gh call ---------------------------------------------------------------


def gateway_failure(text: str) -> bool:
    """``gateway_failure``: refused before a backend ran it, so even a write may be repeated."""
    return any(
        marker in text
        for marker in (
            "No server is currently available",
            "HTTP 502",
            "HTTP 503",
            "HTTP 504",
            "Bad gateway",
            "Service Unavailable",
            "Gateway Timeout",
        )
    )


_HTTP_4XX = re.compile(r"HTTP 4[0-9][0-9]")

# The quota reader's fail-closed allowlist (budget.py's BOUNDARY states it).
_QUOTA_MARKERS = (
    "API rate limit exceeded",
    "API rate limit already exceeded",
    "secondary rate limit",
    "(HTTP 429)",
)


# gh's own commands (`pr merge`, `pr view`, ...) ride go-gh's client, which prints an error status
# whose body it could not read as `HTTP <n> (<url>)` and nothing else (go-gh 2.16.1's
# HTTPError.Error with no message). A 429 is a rate limit by definition; a 403 GitHub refuses for
# any other reason (a permission, a protected branch) carries a message, so a BODILESS 403 is read
# as the quota's too (ludics-lite#612). Matched as the whole first line.
_BODILESS_QUOTA = re.compile(r"HTTP 4(03|29) \(https?://[^\s()]+\)")


def quota_failure(text: str) -> bool:
    """``quota_failure``: does this text say GitHub's quota refused the call? Then it is no answer
    about what was asked (the polling budget, budget.py)."""
    return any(marker in text for marker in _QUOTA_MARKERS) or (
        _BODILESS_QUOTA.fullmatch(text) is not None
    )


def api_rejection(text: str) -> bool:
    """``api_rejection``: an explicit 4xx, i.e. the API ANSWERED the request. A quota refusal (a
    403 or 429) is not an answer about the request either."""
    if quota_failure(text):
        return False
    return _HTTP_4XX.search(text) is not None


# Did GraphQL answer with an error whose answer is FIXED, one that re-sending the same query can
# never change? Retried as transport, a query-cost rejection (ludics-lite#422) and a lookup of an
# issue that does not exist (ludics-lite#663) each spent four attempts and ~35s and then reported
# "the API never answered" -- which it had.
#
# The boundary. Both readers below read ONE line, the first line of gh's stderr, where gh prints a
# GraphQL error's message after `gh: ` (`gh api graphql`) or `GraphQL: ` (every other gh command).
# Each is a fail-closed ALLOWLIST of whole-line shapes, copied from real failing calls (gh 2.101.0).
# graphql_fixed_answer, a query GraphQL refused to validate, so it ran nothing:
#   the node limit    By the time this query traverses to the <c> connection, it is requesting up
#                     to <n> possible nodes which exceeds the maximum limit of <n>.
#   the page limit    Requesting <n> records on the `<c>` connection exceeds the `first|last`
#                     limit of <n> records.
#   an unknown field  Field '<f>' doesn't exist on type '<T>'
#   a parse error     Expected <tokens>, actual: <TOKEN> ("<text>") at [<line>, <column>]
# graphql_not_found, GraphQL's NOT_FOUND: an issue, PR, repository, user or node id that does not
# exist. Under `GraphQL: ` gh appends the error's ` (<path>)`, which this shape alone takes, and
# requires, since every NOT_FOUND carries a path:
#   not found         Could not resolve to a|an <Type> with the <key> <n>|'<text>'.
# A NOT_FOUND is the answer of a document that RAN: no retry creates the object, so it is never
# retried, but another field of the same mutation may have landed (a caller's `retry` can send
# several), so it is no evidence that a write did nothing -- a write reads it as ambiguous, and only
# a read takes it as the fact (exit 1). The machine type (`errors[].type`) is not read: only `gh
# api graphql` prints the error document, on stdout, while gh's own commands (`pr view`, `issue
# view`) print only the message, so the message is the one reading that serves both. Neither reader
# reads stdout (a read's data can quote any of these sentences), the lines after the first, a
# ` (<path>)` suffix on any shape but not found, several errors gh joined onto one line, gh's own
# client-side refusals (`Unknown JSON field`), or any other GraphQL message. Those keep the
# classification they had, and that direction is the point: a fixed shape this misses costs only
# the retries it always cost, while a transient failure read as fixed would turn an unanswered read
# into a false fact (exit 1).
_GRAPHQL_FIXED = tuple(
    re.compile(p)
    for p in (
        r"By the time this query traverses to the [A-Za-z0-9_]+ connection, it is requesting up"
        r" to [0-9,]+ possible nodes which exceeds the maximum limit of [0-9,]+\.",
        r"Requesting [0-9,]+ records on the `[A-Za-z0-9_]+` connection exceeds the"
        r" `(first|last)` limit of [0-9,]+ records\.",
        r"Field '[A-Za-z0-9_]+' doesn't exist on type '[A-Za-z0-9_]+'",
        r'Expected [A-Za-z_ ,]+, actual: ([A-Z_]+|\(none\)) \(".*"\) at \[[0-9]+, [0-9]+\]',
    )
)
_GRAPHQL_NOT_FOUND = r"Could not resolve to an? [A-Za-z ]+ with the [A-Za-z ]+ ([0-9]+|'[^']*')\."
_GRAPHQL_NOT_FOUND_BARE = re.compile(_GRAPHQL_NOT_FOUND)
_GRAPHQL_NOT_FOUND_PATHED = re.compile(_GRAPHQL_NOT_FOUND + r" \([A-Za-z0-9_.]+\)")


def graphql_fixed_answer(first_line: str) -> bool:
    """``graphql_fixed_answer``: GraphQL refused to validate the query, so re-sending it can never
    change the answer, and it ran nothing. Reads the first stderr line only, behind gh's
    ``gh: ``/``GraphQL: `` (the boundary above)."""
    if first_line.startswith("gh: "):
        msg = first_line[len("gh: ") :]
    elif first_line.startswith("GraphQL: "):
        msg = first_line[len("GraphQL: ") :]
    else:
        return False
    return any(p.fullmatch(msg) for p in _GRAPHQL_FIXED)


def graphql_not_found(first_line: str) -> bool:
    """GraphQL's NOT_FOUND (ludics-lite#663): what the document names does not exist, so re-sending
    it can never change the answer -- though, unlike ``graphql_fixed_answer``, the document ran.
    The first stderr line only, as ``gh api graphql`` (``gh: <message>``) or gh's own commands
    (``GraphQL: <message> (<path>)``) print it (the boundary above)."""
    if first_line.startswith("gh: "):
        return _GRAPHQL_NOT_FOUND_BARE.fullmatch(first_line[len("gh: ") :]) is not None
    if first_line.startswith("GraphQL: "):
        return _GRAPHQL_NOT_FOUND_PATHED.fullmatch(first_line[len("GraphQL: ") :]) is not None
    return False


_SPACE = r" \t\n\r\f\v"  # [[:space:]] in the C locale, which is what the shell's lists mean
_CLIENT_REFUSALS = tuple(
    re.compile(p)
    for p in (
        r'Unknown JSON field: "[^"]+"',
        r"Specify one or more comma-separated fields for `--json`:",
        rf"unknown flag: --[^{_SPACE}=]+",
        rf"unknown shorthand flag: '[^'{_SPACE}]' in -[^{_SPACE}]+",
        r"flag needs an argument: (--[A-Za-z0-9][A-Za-z0-9-]*|'[A-Za-z0-9]' in -[A-Za-z0-9])",
        r'invalid argument ".*" for "(-[A-Za-z0-9], )?--[A-Za-z0-9][A-Za-z0-9-]*" flag: .+',
        r"accepts (at most )?[0-9]+ arg\(s\), received [0-9]+",
        r"requires at least [0-9]+ arg\(s\), only received [0-9]+",
        rf"bad flag syntax: --[-=][^{_SPACE}]*",
        r'unknown command "[^"]+" for "gh( [a-z][a-z-]*)+"',
    )
)


def gh_client_refusal(first_line: str) -> bool:
    """``gh_client_refusal``: gh refused the ARGUMENTS itself and sent nothing (ludics-lite#452).
    A fail-closed allowlist of whole first lines; see the shell comment for the boundary."""
    return any(p.fullmatch(first_line) for p in _CLIENT_REFUSALS)


# gh 2.101.0's refusal to PRINT an answer it got: a plain-text body holding terminal escape
# sequences (an Actions job's log, ANSI colour and all) is withheld unless the call passes
# --allow-escape-sequences, whether or not stdout is a terminal, and gh exits 1. The request
# reached GitHub and was answered, so this is not transport, and re-sending it prints the same
# refusal. A JSON answer is not withheld (its strings carry the escape as text), nor is a --jq
# projection that decodes one, so the script's own calls, which all read JSON, never meet it.
# Matched as the whole first line, fail-closed like the refusals above.
_ESCAPE_REFUSAL = (
    "the response contains terminal escape sequences;"
    " pass --allow-escape-sequences to output it anyway"
)


def gh_withheld_escapes(first_line: str) -> bool:
    """Did gh withhold an answer for the terminal escape sequences in it (post-wave-3 task 8)?"""
    return first_line == _ESCAPE_REFUSAL


# --- an answer gh could not read (ludics-lite#612) ------------------------------------------------
#
# When GitHub's answer to `gh api` has an empty, cut-off or non-JSON body, gh prints its JSON
# decoder's complaint ALONE -- no `gh: `, no HTTP status -- for a 200, a 403 or a 502 alike: an
# error status with a JSON content type goes through gh's error-body parse, which fails before the
# `gh: ... (HTTP <n>)` line is formed, and a gateway's HTML page under `--jq` fails in the filter
# (gh 2.101.0, pkg/cmd/api/api.go processResponse). So a write cannot tell "no backend ran it" from
# "it may have landed", and a quota refusal never reaches the hold. `gh api --include` prints the
# status line and the headers on stdout BEFORE the body is parsed, so they survive the failure;
# the own writes that are `gh api` calls (``retry(..., include=True)``) send it.
#
# The boundary, fail-closed both ways. The status line is read ONLY when the first stderr line is
# one of the decoder complaints below, matched whole (Go's encoding/json, which both gh's
# error-body parse and its --jq filter use): with any other first line gh read the answer and said
# what it was, and that line stays the classification. The header block is read only in gh's own
# shape: a first line ``HTTP/<version> <three digits>[ <reason>]``, header lines, and a blank line
# (``\r\n`` endings, a bare ``\n`` taken too); stdout of any other shape is the body, whole, and the
# status stays unknown -- the classification a call without --include had. The status found is
# appended to the complaint as gh's own ``(HTTP <n>)``, so the readers above classify it as the line
# gh prints when it can read the body: a 502/503/504 is a gateway refusal (``gateway_failure``),
# any other 4xx the API's rejection (``api_rejection``), a 429 the quota's (``quota_failure``). A
# BODILESS 403 is the quota's too (``bodiless_quota``): GitHub words every other 403. A 2xx, a 500,
# or any other status keeps the write ambiguous: the backend ran it, or may have.
_DECODER_COMPLAINTS = (
    re.compile(r"unexpected end of JSON input"),
    re.compile(r"invalid character '(\\.|[^\\'\n]|\\x[0-9a-f]{2}|\\u[0-9a-f]{4})' [a-z][a-z :'()\\-]*"),
)
_STATUS_LINE = re.compile(r"HTTP/[0-9.]+ ([0-9]{3})(?: [^\r\n]*)?")
# The headers named on stderr when a status is recovered, for the evidence #612's second proposal
# asks for (is an empty answer a secondary rate limit?): the quota's and the request's own, nothing
# else of the response.
_EVIDENCE_HEADERS = (
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "x-github-request-id",
    "content-type",
    "content-length",
)


def gh_unreadable_answer(first_line: str) -> bool:
    """Is this first stderr line gh's JSON decoder complaining about GitHub's answer (the boundary
    above)?"""
    return any(p.fullmatch(first_line) for p in _DECODER_COMPLAINTS)


@dataclass(frozen=True)
class Included:
    """What ``gh api --include`` printed: the status, the headers (names lowercased, in gh's
    order), and the body after them."""

    status: int
    headers: tuple[tuple[str, str], ...]
    body: str


def split_included(stdout: str) -> Included | None:
    """The header block gh's ``--include`` prints ahead of the body; None when stdout does not
    start with one (the boundary above)."""
    lines = stdout.split("\n")
    m = _STATUS_LINE.fullmatch(lines[0].removesuffix("\r"))
    if m is None:
        return None
    headers: list[tuple[str, str]] = []
    # The last element is what follows the last newline: never a whole line, so never the blank.
    for i in range(1, len(lines) - 1):
        line = lines[i].removesuffix("\r")
        if line == "":
            return Included(int(m.group(1)), tuple(headers), "\n".join(lines[i + 1 :]))
        name, sep, value = line.partition(":")
        if not sep:
            return None
        headers.append((name.strip().lower(), value.strip()))
    return None


def _unreadable_evidence(args: Sequence[str], complaint: str, included: Included) -> str:
    """The stderr note for an answer gh could not read: its status and the evidence headers, so a
    wave's logs show whether such answers are a secondary rate limit (ludics-lite#612)."""
    named = " ".join(
        f"{name}={value}" for name, value in included.headers if name in _EVIDENCE_HEADERS
    )
    command = args[0] if args else "api"
    return (
        f"gh {command} got an answer gh could not read ({complaint}): HTTP {included.status};"
        f" headers: {named or '(none of the quota or request headers)'}"
    )


def bodiless_quota(status: int) -> bool:
    """A status gh could not read a body for, read as a quota refusal: a 429, or a 403 (the boundary
    above)."""
    return status in (403, 429)


_API_ONLY_WHOLE = frozenset(
    "api status search org project label cache ruleset secret variable ssh-key gpg-key".split()
)
_API_ONLY_SUB = frozenset(
    {
        *(
            f"pr {s}"
            for s in "list status checks comment edit lock ready reopen review unlock"
            " update-branch view".split()
        ),
        *(
            f"issue {s}"
            for s in "create list status close comment delete edit lock pin reopen transfer"
            " unlock unpin view".split()
        ),
        *(f"run {s}" for s in "cancel delete list rerun view".split()),
        *(f"workflow {s}" for s in "disable enable list run view".split()),
        *(
            f"repo {s}"
            for s in "list archive autolink delete deploy-key edit gitignore license read-dir"
            " read-file unarchive view".split()
        ),
        *(
            f"release {s}"
            for s in "list delete delete-asset edit upload verify verify-asset view".split()
        ),
        *(f"gist {s}" for s in "create delete list view".split()),
    }
)


def gh_api_only_command(args: Sequence[str]) -> bool:
    """``gh_api_only_command``: is the whole run of this gh command gh's own parse and API calls,
    so its stderr is gh's? A fail-closed allowlist read off gh 2.101.0 (see the shell comment)."""
    first = args[0] if args else ""
    second = args[1] if len(args) > 1 else ""
    return first in _API_ONLY_WHOLE or f"{first} {second}" in _API_ONLY_SUB


def transient_failure(text: str) -> bool:
    """``transient_failure``, the READ policy: everything but an explicit 4xx is retried."""
    if gateway_failure(text):
        return True
    return not api_rejection(text)


# --- bash's printf %q, for the one message that quotes a call -------------------------------------

_Q_SPECIAL = frozenset(" \t\n'\"\\|&;()<>!{}*[]?^$`,")


def shell_quote(word: str) -> str:
    """bash's ``printf '%q'``, for a refused call's message and the paths of the open threads the
    `unresolved` state names (which the shell's merge gate names with printf %q too). ASCII is
    quoted here: ``''`` for empty, ``$'...'`` when a control character is in it, otherwise
    backslashes before the characters bash quotes. A word with non-ASCII in it is quoted by bash
    itself: what printf %q makes of it depends on the locale and the platform's C library (under
    a UTF-8 locale on macOS ``naïve`` stays as is and ``€`` turns the word into ``$'...'``), which
    no table here would track. The bash is the one the forwarding shell ran (the bridge's), else
    the one on PATH, as pr-review.sh's ``#!/usr/bin/env bash`` finds it; without one, the C
    locale's form below."""
    if word == "":
        return "''"
    if any(ord(c) >= 128 for c in word):
        quoted = _bash_printf_q(word)
        if quoted is not None:
            return quoted
    if any(ord(c) < 32 or ord(c) >= 127 for c in word):
        out: list[str] = []
        named = {"\n": "\\n", "\t": "\\t", "\r": "\\r", "\a": "\\a", "\b": "\\b", "\f": "\\f",
                 "\v": "\\v", "\x1b": "\\E", "'": "\\'", "\\": "\\\\"}
        for c in word:
            if c in named:
                out.append(named[c])
            elif 32 <= ord(c) < 127:
                out.append(c)
            else:
                out.extend(f"\\{b:03o}" for b in c.encode("utf-8", "surrogateescape"))
        return "$'" + "".join(out) + "'"
    quoted = "".join("\\" + c if c in _Q_SPECIAL else c for c in word)
    return "\\" + quoted if quoted.startswith("#") else quoted


def _bash_printf_q(word: str) -> str | None:
    bash = os.environ.get(proc.BRIDGE_SHELL, "") or "bash"
    try:
        done = proc.run_tool(bash, ["-c", 'printf %q "$1"', "bash", word])
    except (OSError, ValueError):  # ValueError: a NUL, which no argv (and no bash word) holds
        return None
    return done.stdout if done.rc == 0 and done.stdout else None


# --- the gh call ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class GhOk:
    """The call succeeded. ``stdout`` is what ``$(gh ...)`` kept: trailing newlines dropped."""

    stdout: str


@dataclass(frozen=True)
class GhFailed:
    """gh_retry's 1: the failure was the API's answer (a 4xx), or a failure the policy does not
    retry -- for a WRITE that includes an ambiguous one (a 500): tell those apart with
    ``api_rejection(session.err_line())``, as every shell caller does."""


@dataclass(frozen=True)
class GhUnanswered:
    """gh_retry's 3: a retryable failure outlived the attempts. Nothing was learned."""


@dataclass(frozen=True)
class GhArgsRefused:
    """gh_retry's 2 for a CALLER's arguments on an allowlisted command: gh refused them and sent
    nothing. Only ``retry_caller(..., listed=True)`` returns it."""


@dataclass(frozen=True)
class GhOutputWithheld:
    """gh got GitHub's answer and refused to print it: it holds terminal escape sequences and the
    call did not pass ``--allow-escape-sequences`` (``gh_withheld_escapes``). Not transport, and
    not an answer about the request; unlike ``GhArgsRefused`` the request WAS sent. Only
    ``retry_caller(..., listed=True)`` returns it."""


type GhResult = GhOk | GhFailed | GhUnanswered
type GhCallerResult = GhOk | GhFailed | GhUnanswered | GhArgsRefused | GhOutputWithheld
type Mode = Literal["read", "write"]


class GhRefusedOwn(cli.Exit):
    """gh refused an argument THIS script sent (ludics-lite#471): a version mismatch with the
    installed gh. It ends the whole command with exit 2, from whatever depth the call was made,
    and the message is printed once, by main. Nothing after it runs, so no verdict about the PR
    is printed over it -- the property the shell needed a USR2 trap and a marker file for."""

    def __init__(self, message: str) -> None:
        super().__init__(2, message, raw=True)


def refused_own_message(args: Sequence[str], err_line: str) -> str:
    """``gh_refused_own``'s message. A field's VALUE is payload, not the call's shape (a reply's
    text, a body file's path): it prints as ``name=...``. A long call is cut at 240 chars."""
    call = ""
    prev = ""
    for arg in args:
        if prev in ("-f", "-F", "--field", "--raw-field"):
            call += " " + shell_quote(arg.split("=", 1)[0]) + "=..."
        else:
            call += " " + shell_quote(arg)
        prev = arg
    if len(call) > 240:
        call = call[:240] + "..."
    return (
        f"{PROG}: the installed gh refused this script's own call, which sent nothing: gh{call}"
        f" -> {err_line}. That is a version mismatch between pr-review.sh and the installed gh"
        " (`gh --version`), not transport and not GitHub's answer: re-running prints the same"
        " refusal, so do not re-arm or retry; update gh or this script. The command stopped at"
        " this call, and anything it did before the call stands."
    )


def _first_line(text: str) -> str:
    return text.split("\n", 1)[0]


class GhSession:
    """One command's gh calls: the retry policy, and the last error for messages.

    ``err_line()`` is ``gh_err_line``: the first stderr line of the last FAILED attempt, empty
    once a later call succeeded -- "a later message must not quote an error this call outlived".
    ``sleep`` is injectable so the unit tests run the backoff without waiting.
    """

    def __init__(
        self,
        config: Config,
        *,
        run: Callable[[str, Sequence[str]], proc.Completed] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        budget: "Budget | None" = None,
    ) -> None:
        self.config = config
        self._run: Callable[[str, Sequence[str]], proc.Completed] = (
            run if run is not None else proc.run_tool
        )
        self._sleep = sleep
        self._err_line = ""
        self._unclear_attempts = 0
        self._status: int | None = None
        self._quota = False
        # The polling budget (budget.py): every own call passes its hold's gate. None in the unit
        # tests that drive the retry policy alone.
        self.budget = budget

    def err_line(self) -> str:
        return self._err_line

    def unclear_attempts(self) -> int:
        """How many attempts of the last call failed in a way that says nothing about whether the
        request reached a backend: neither a gateway refusal, nor a quota refusal, nor a 4xx, nor a
        refusal of the arguments. A mutation any of them carried may have landed. It is for a
        mutation sent under the READ policy because it is idempotent (``resolve``'s, ``body``'s
        PATCH), which an ambiguous failure does not stop: its message, once the attempts are spent,
        must not say nothing changed if one of them may have. The last call's count; each call
        starts it again."""
        return self._unclear_attempts

    def quota_stopped(self) -> bool:
        """The last call's ``GhUnanswered`` was the polling budget's (a quota hold that stood, a
        quota refusal, or a hold the state directory could not record), not transport: no call, or
        no further call, was made, so reading again at once changes nothing (ludics-lite#795)."""
        return self._quota

    def recovered_status(self) -> int | None:
        """The HTTP status of the last FAILED attempt's answer when gh could not read its body and
        the status line could be read instead (``include``; ludics-lite#612); None otherwise."""
        return self._status

    def retry(self, mode: Mode, args: Sequence[str], *, include: bool = False) -> GhResult:
        """``gh_retry <mode> <args>`` for THIS script's own arguments. gh refusing one of them
        raises ``GhRefusedOwn`` (exit 2 for the whole command).

        ``include``: the call is a ``gh api`` call that prints its answer (no --paginate, --silent
        or --verbose); ``--include`` is appended, the header block is taken off stdout, and an
        answer gh could not read is classified by its status (the boundary at
        ``gh_unreadable_answer``)."""
        if include:
            args = [*args, "--include"]
        result = self._retry(mode, args, "own", budgeted=True, include=include)
        match result:
            case GhArgsRefused() | GhOutputWithheld():
                raise AssertionError("an own call's refusal raises, it is never returned")
            case GhOk() | GhFailed() | GhUnanswered():
                return result

    def retry_caller(
        self, mode: Mode, args: Sequence[str], *, listed: bool, budgeted: bool = False
    ) -> GhCallerResult:
        """``gh_retry`` with ``GH_RETRY_CALLER_ARGS`` set: a CALLER's arguments (``cmd_retry``).
        ``listed`` (the command passed ``gh_api_only_command``): a refusal of the arguments
        returns ``GhArgsRefused`` on the first attempt. Unlisted: stderr is not read as gh's.
        ``budgeted``: the call is still this script's own (merge's, with a caller's ``gh pr merge``
        flags forwarded), so it passes the polling budget; a ``retry`` caller's is outside it."""
        return self._retry(mode, args, "listed" if listed else "unlisted", budgeted=budgeted)

    def _retry(
        self,
        mode: Mode,
        args: Sequence[str],
        whose: Literal["own", "listed", "unlisted"],
        *,
        budgeted: bool,
        include: bool = False,
    ) -> GhCallerResult:
        self._unclear_attempts = 0
        self._status = None
        self._quota = False
        attempts = self.config.api_attempts
        delay = self.config.api_backoff
        attempt = 1
        quota_unheld = 0
        budget = self.budget if budgeted else None
        while True:
            # The polling budget: an own call goes to github.com or not at all, and no call while a
            # hold stands.
            if budget is not None:
                budget.require_github()
                held = budget.gate(mode)
                if held is not None:
                    self._err_line = held
                    self._quota = True
                    return GhUnanswered()
            done = self._run("gh", args)
            err = proc.substitution(done.stderr)
            included = split_included(done.stdout) if include else None
            out = proc.substitution(included.body if included is not None else done.stdout)
            self._status = None
            if done.rc == 0:
                self._err_line = ""
                return GhOk(out)
            first = _first_line(err)
            if included is not None and gh_unreadable_answer(first):
                self._status = included.status
                warn(_unreadable_evidence(args, first, included))
                # gh's own shape for an error it can read, so every reader below classifies it.
                recovered = f"{first} (HTTP {included.status})"
                err = recovered + err[len(first) :]
                first = recovered
            self._err_line = first
            # A refusal of the arguments sent nothing, so under either policy there is nothing to
            # retry and, for a write, nothing that could have landed.
            if whose != "unlisted" and gh_client_refusal(first):
                if whose == "listed":
                    return GhArgsRefused()
                raise GhRefusedOwn(refused_own_message(args, first))
            # An answer gh withheld was still an answer: re-sending gets it withheld again. Read
            # for a caller's listed path only; an own call reads JSON, which gh never withholds.
            if whose == "listed" and gh_withheld_escapes(first):
                return GhOutputWithheld()
            # A quota refusal is no answer about what was asked, so it is 3 under both policies, and
            # it is not retried on the backoff below: it sets the hold instead. An observer's read
            # waits that hold out at the gate above and repeats; a read the probe found no hold for
            # gets one more try, and a write is never repeated.
            if quota_failure(first) or (self._status is not None and bodiless_quota(self._status)):
                # Set on the returns alone: a hold waited out above and a later attempt that fails
                # on transport is transport (``quota_stopped``).
                if budget is not None:
                    unrecorded = budget.quota_hit(args)
                    if unrecorded is not None:
                        self._err_line = unrecorded
                        self._quota = True
                        return GhUnanswered()
                    if mode == "read" and budget.waiting():
                        if budget.hold_read() is not None:
                            continue
                        quota_unheld += 1
                        if quota_unheld < 2:
                            continue
                self._quota = True
                return GhUnanswered()
            # A fixed GraphQL answer is read FIRST, under both policies: the substring scans
            # below would match a marker the message only quotes. A NOT_FOUND is as fixed, but
            # its document ran, so it is not one of the answers that rule a landing out below.
            if graphql_fixed_answer(first) or graphql_not_found(first):
                retryable = False
            elif mode == "write":
                retryable = gateway_failure(f"{err} {out}")
            else:
                retryable = transient_failure(f"{err} {out}")
            # What a failure that is none of the answers above leaves open: whether it landed.
            if not (
                gateway_failure(f"{err} {out}") or api_rejection(first) or graphql_fixed_answer(first)
            ):
                self._unclear_attempts += 1
            if not retryable:
                return GhFailed()
            if attempt >= attempts:
                return GhUnanswered()
            command = args[0] if args else "api"
            warn(
                f"gh {command} failed (attempt {attempt}/{attempts}), retrying in {delay}s:"
                f" {self.err_line()}"
            )
            self._sleep(delay)
            if delay < 20:
                delay *= 2
            attempt += 1


# --- repository and PR arguments ------------------------------------------------------------------


@dataclass(frozen=True)
class Ref:
    """``parse_ref``'s REF_REPO and REF_NUM: ``repo`` is EMPTY when the argument named none, so a
    caller can tell "no repo named" from "this repo"; ``num`` is the digits as given."""

    repo: str
    num: str


_DIGITS = re.compile(r"[0-9]+")
_REPO_CHARS = re.compile(r"[A-Za-z0-9._/-]+")


def parse_ref(arg: str) -> Ref | None:
    """``parse_ref``: a bare number, or exactly ``owner/name#number`` -- the WHOLE argument is
    validated, so ``owner/repo#111#222`` and ``junk#123`` are refused, never read as 222 or 123.
    None on anything else; the caller words the refusal."""
    if "#" in arg:
        repo, num = arg.split("#", 1)
        if "#" in num:
            return None
        if repo.count("/") != 1 or repo.startswith("/") or repo.endswith("/"):
            return None
        if not _REPO_CHARS.fullmatch(repo):
            return None
    else:
        repo, num = "", arg
    if not _DIGITS.fullmatch(num):
        return None
    return Ref(repo, num)


@dataclass(frozen=True)
class PrTarget:
    repo: str
    num: str


# A PR is addressed by a repository and a number, and the number alone names one PR in every
# repository there is. So the repository is either SPELLED OUT in the invocation — an
# owner/name#<n> argument, --repo, REPO= — or the call is refused. Resolution happens after the PR
# argument is parsed, because that argument may carry the repo itself.
#
# Two other sources stood here and both are gone (ludics-lite#92). The cwd was trusted outright,
# and cached: a bare `reply 7` typed from a shell sitting in another project's worktree posted into
# whatever PR 7 is over there. The per-PR cache remembered a repo by NUMBER, across checkouts and
# across sessions, so a `reply 7` meant for repo B resolved to the repo A that some earlier call
# had named for 7.
#
# Both were verified against `repos/<repo>/pulls/<n>` before use, or could have been, and this is
# the half worth writing down because verification is the fix that looks right: that read answers
# "this repository has a seventh PR", not "this is the PR you meant". Every active repository has a
# PR 7. So on exactly the invocations these guesses fail on — a worktree of another project, a
# stale entry from yesterday's PR — the check passes and the write lands on a stranger's review
# thread, now with a verification behind it. A claim that cannot fail, standing in for a
# safeguard, is worse than no safeguard. Nor can any other read stand in: what both sources are
# guesses about is INTENT, and the API has nothing to say about that.
#
# So there is no inference left, as ludics-lite#74 (PR #79) left none for `retry run watch` after a
# background shell in a sibling worktree turned a wrong-target read into a failed-run verdict. The
# cost is one `owner/name#<n>` per call, which is what the skill's instructions have always told
# callers to write. What it buys is an invariant with no exception to remember: no command
# addresses a repository that its invocation did not name. `repo_from_cwd` survives for `base`
# alone, which resolves a repo and a BRANCH — a name the API can actually be asked about — rather
# than a bare number every repository answers to.
def resolve_repo(num: str, repo: str) -> None:
    """``resolve_repo``: a PR number with no repository named anywhere is refused (#92)."""
    if repo:
        return
    die(
        f"PR {num} was given with no repository, and a PR number alone names one PR in every",
        f"repository there is. Pass it as owner/name#{num} (or --repo owner/name, or REPO=owner/name).",
        "Nothing was read or written anywhere. It is NOT taken from the working directory and there",
        "is no per-number memory of an earlier call: either would resolve the wrong checkout, or",
        f"yesterday's PR {num}, to a real PR of that number rather than to an error — a write onto a",
        "stranger's review thread (ludics-lite#92). A BACKGROUND invocation is where that bit",
        "hardest, since background shells do not start in the checkout, and the skill's documented",
        "`watch` call is a backgrounded one.",
    )


def pr_arg(arg: str, repo: str) -> PrTarget:
    """``pr_arg``: the PR an argument names. A repo in the argument wins over ``repo`` (from
    --repo or REPO=); with neither, the call is refused."""
    ref = parse_ref(arg)
    if ref is None:
        die(f"PR must be a number or owner/name#number, got '{arg}'")
    target = ref.repo or repo
    resolve_repo(ref.num, target)
    return PrTarget(target, ref.num)


def repo_from_cwd(
    run: Callable[[str, Sequence[str]], proc.Completed] = proc.run_tool,
    budget: "Budget | None" = None,
) -> str | None:
    """``repo_from_cwd``, for ``base`` alone: ``gh repo view`` (it honours gh-resolved), then the
    origin remote, which answers locally when GraphQL is down. None when neither names one.

    ``gh repo view`` is not the session's call, so it passes the polling budget's gate itself. A
    hold, or a quota refusal of the view, is exit 3 and never a reason to fall back to the remote,
    which in a fork names the fork and not the repository gh resolved.

    One divergence, on purpose: the shell's ``gh ... | grep .`` under pipefail printed gh's
    nonempty lines even when gh then FAILED, and fell through to git as well; here a failed gh
    contributes nothing."""
    if budget is not None:
        budget.require_github()
        held = budget.gate("read")
        if held is not None:
            fail(3, f"could not resolve the repository from the checkout: {held}.",
                 "Pass it as owner/name, or wait for the hold.")
    done = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    if done.rc == 0:
        lines = [line for line in done.stdout.split("\n") if line]
        if lines:
            return "\n".join(lines)
    # Refused on quota, it is a hold like any other call's, and still no reason for the remote.
    if quota_failure(_first_line(done.stderr)):
        unrecorded = budget.quota_hit(["repo", "view"]) if budget is not None else None
        if unrecorded is not None:
            fail(3, f"could not resolve the repository from the checkout: {unrecorded}.")
        fail(3, "could not resolve the repository from the checkout: gh repo view was refused on quota.",
             "Pass it as owner/name, or wait for the hold.")
    done = run("git", ["remote", "get-url", "origin"])
    if done.rc != 0:
        return None
    url = proc.substitution(done.stdout)
    if url.endswith(".git"):
        url = url[: -len(".git")]
    if not re.search(r"github\.com[:/]", url):
        return None
    url = url.split("github.com", 1)[1]
    if url[:1] in (":", "/"):
        url = url[1:]
    return url if "/" in url else None


# --- feeds ----------------------------------------------------------------------------------------

type Json = None | bool | int | float | str | list[Json] | dict[str, Json]


@dataclass(frozen=True)
class ListOk:
    items: list[Json]


@dataclass(frozen=True)
class ListUnparsed:
    """api_list's 4: the call answered with something that is not a stream of JSON documents."""


type ListResult = ListOk | GhFailed | GhUnanswered | ListUnparsed


_SURROGATE = re.compile("[\ud800-\udfff]")
_HIGH_SURROGATE = re.compile("[\ud800-\udbff]")
_REPLACEMENT_CHARACTER = chr(0xFFFD)
# Where a stream can hold a surrogate after decoding: an escape of one, or one already in the text.
_SURROGATE_SOURCE = re.compile(r"\\u[dD][89a-fA-F]|[\ud800-\udfff]")


class _Unparsed(Exception):
    pass


def _jq_string(s: str) -> str:
    """A decoded string as jq 1.8 reads the same literal. Python's decoder joins a ``\\uD8xx\\uDCxx``
    escape pair as jq does, but keeps a lone surrogate as a code point, where jq refuses a high one
    ("Invalid \\uXXXX\\uXXXX surrogate pair escape", the feed unparsed) and reads a low one as
    U+FFFD. A high surrogate here can only be an escape: the stream was decoded with
    surrogateescape, which yields low ones alone (U+DC80..U+DCFF, for bytes that are not UTF-8,
    which jq also reads as U+FFFD)."""
    if not _SURROGATE.search(s):
        return s
    if _HIGH_SURROGATE.search(s):
        raise _Unparsed
    return _SURROGATE.sub(_REPLACEMENT_CHARACTER, s)


def _jq_doc(doc: Json) -> Json:
    match doc:
        case str():
            return _jq_string(doc)
        case list():
            return [_jq_doc(item) for item in doc]
        case dict():
            return {_jq_string(k): _jq_doc(v) for k, v in doc.items()}
        case _:
            return doc


class JqLiteral(float):
    """A number read with ``literals=True``: its value, and the text jq 1.8 prints for it while no
    arithmetic has touched it -- the payload's own literal in decNumber's canonical spelling, which
    is ``str(Decimal(...))`` exactly (``1E+2`` stays ``1E+2``, ``3.50`` keeps its zero, ``-0`` its
    sign, ``1.5e3`` reads ``1.5E+3``). Arithmetic on one yields a plain float, as jq's yields a
    double. ``jqsem.number_text`` and ``jqsem.tojson`` print the text."""

    __slots__ = ("text",)
    text: str

    def __new__(cls, literal: str) -> "JqLiteral":
        self = super().__new__(cls, literal)
        self.text = str(Decimal(literal))
        return self


def _literal_int(literal: str) -> int | float:
    # An integer literal prints as Python prints the int, save -0, whose sign jq keeps.
    return JqLiteral(literal) if literal == "-0" else int(literal)


class JsonStreamError(ValueError):
    """json_docs: the stream stops parsing here; the documents before were yielded."""


def json_docs(text: str, *, literals: bool = False) -> Iterator[Json]:
    """The documents of a concatenated JSON stream one by one, as jq reads them: each is yielded
    before the next is parsed, and a part that does not parse (a lone high-surrogate escape
    included, see _jq_string) raises JsonStreamError there, so a caller can act on the documents
    before the cut as ``jq`` does. With ``literals``, every non-integer number (and -0) is a
    JqLiteral, printed as the payload spelled it."""
    decoder = (
        json.JSONDecoder(parse_float=JqLiteral, parse_int=_literal_int) if literals else json.JSONDecoder()
    )
    pos = 0
    length = len(text)
    surrogates = _SURROGATE_SOURCE.search(text) is not None
    while True:
        while pos < length and text[pos] in " \t\n\r":
            pos += 1
        if pos >= length:
            return
        try:
            doc, pos = decoder.raw_decode(text, pos)
        except ValueError as e:
            raise JsonStreamError(str(e)) from e
        if surrogates:
            try:
                doc = _jq_doc(doc)
            except _Unparsed as e:
                raise JsonStreamError("a lone high surrogate") from e
        yield doc


def json_stream(text: str) -> list[Json] | None:
    """The documents of a concatenated JSON stream (what ``gh --paginate`` prints, one per page),
    as ``jq -s`` reads them; None when any of it does not parse, a lone high-surrogate escape
    included (see _jq_string)."""
    try:
        return list(json_docs(text))
    except JsonStreamError:
        return None


def api_list(session: GhSession, path: str, repo: str) -> ListResult:
    """``api_list``: a paginated GET of ``repos/<repo>/<path>`` as ONE flat list, every page's
    array spliced in and anything else (an API error object) dropped. A failed read is never an
    empty feed: it is the call's failure, or ``ListUnparsed``."""
    result = session.retry("read", ["api", "--paginate", f"repos/{repo}/{path}"])
    match result:
        case GhFailed() | GhUnanswered():
            return result
        case GhOk(stdout=raw):
            docs = json_stream(raw)
            if docs is None:
                return ListUnparsed()
            items: list[Json] = []
            for doc in docs:
                if isinstance(doc, list):
                    items.extend(doc)
            return ListOk(items)


def mark_of(watermark: str, field: int) -> int:
    """``mark_of``: field ``field`` (1-based) of a comma-joined watermark; 0 when absent or not a
    plain number. One watermark per feed, because the feeds' ids are not comparable."""
    # `cut -d, -f<n>` prints a line with no comma WHOLE, whatever <n> is.
    parts = watermark.split(",")
    if len(parts) == 1:
        value = watermark
    else:
        value = parts[field - 1] if 0 < field <= len(parts) else ""
    return int(value) if _DIGITS.fullmatch(value) else 0
