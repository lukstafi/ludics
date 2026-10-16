"""The coordinator's read-only views: ``load`` (what each machine is doing, from the flotilla
dashboard) and ``prs`` (the open PRs with their review rounds, CI and head age) -- fleet-worker.sh's
``cmd_load`` and ``cmd_prs``.

Neither takes the lease or changes anything. Their jq programs are ported to plain Python with
jq's semantics (``ludics.prreview.jqsem``): what an interpolated value prints as, ``//`` taking
only null and false as missing, and a shape a program would have errored on being an error here
too, which each verb turns into the refusal the shell printed when its jq failed.
"""

import math
import os
import re
import time
from typing import cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import listing
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import run, substitution
from ludics.prreview.core import JqLiteral, Json, JsonStreamError, json_docs, json_stream
from ludics.prreview.jqsem import JqError, alt, fromdateiso8601, idx, jstr, path, sort_by, truthy, type_name, unique

# --- jq's iteration and length -------------------------------------------------------------------


def each(value: Json) -> list[Json]:
    """``.[]``: an array's items or an object's values; an error on anything else."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return list(value.values())
    raise JqError(f"cannot iterate over {type_name(value)}")


def length(value: Json) -> int | float:
    """jq's ``length``: items, keys, characters, a number's absolute value, 0 for null. A literal
    stays one, its sign dropped (jq 1.8: ``-3.50 | length`` is ``3.50``, ``-0`` is ``0``)."""
    match value:
        case None:
            return 0
        case bool():
            raise JqError("boolean has no length")
        case JqLiteral():
            return JqLiteral(value.text[1:]) if value.text.startswith("-") else value
        case int() | float():
            return abs(value)
        case str() | list() | dict():
            return len(value)


def to_entries(value: Json) -> list[tuple[Json, Json]]:
    """``to_entries[]`` as (key, value) pairs: an object's members, or an array's indexed items."""
    if isinstance(value, dict):
        return list(value.items())
    if isinstance(value, list):
        return list(enumerate(cast(list[Json], value)))
    raise JqError(f"{type_name(value)} has no keys")


# --- load ----------------------------------------------------------------------------------------


def load_line(machine: Json, key: Json, endpoint: Json) -> str:
    v = endpoint
    m5 = path(v, "avg", "m5")
    data = idx(v, "data")
    fields = [
        jstr(idx(machine, "name")),
        jstr(alt(idx(v, "host"), key)),
        "ok=" + jstr(idx(v, "ok")),
        "cpu5=" + jstr(alt(idx(m5, "cpu_pct"), "?")) + "%",
        "gpu5=" + jstr(alt(idx(m5, "gpu_util_pct"), "-")) + "%",
        "dune=" + jstr(alt(path(data, "counts", "dune"), "?")),
        "claude=" + jstr(length(alt(path(data, "sessions", "claude"), []))),
        "codex=" + jstr(length(alt(path(data, "sessions", "codex"), []))),
        "gpu=" + jstr(alt(path(data, "gpu", "name"), "-")),
    ]
    return "\t".join(fields)


def cmd_load(cfg: Config, args: list[str]) -> int:
    """Placement input: one line per unix endpoint of each machine the dashboard reports."""
    del args  # the shell's load took no options and ignored any it was given
    flotilla = cfg.env.get("FLEET_FLOTILLA") or "http://mac-studio:7799"
    done = run(["curl", "-s", "-m", "10", f"{flotilla}/api/fleet"], capture=True)
    if done.rc != 0:
        cli.say(f"LOAD UNREACHABLE {flotilla}")
        return 4
    # jq's reading, document by document: the rows of each print before the next is parsed, so a
    # payload cut short prints what came before the cut, then the refusal; and a number prints as
    # the payload spelled it (literals=True), as jq 1.8 prints one it did not compute with.
    try:
        for doc in json_docs(done.out, literals=True):
            for machine in each(idx(doc, "machines")):
                for key, endpoint in to_entries(idx(machine, "endpoints")):
                    if idx(endpoint, "kind") == "unix":
                        cli.say(load_line(machine, key, endpoint))
    except (JqError, JsonStreamError):
        cli.say(f"LOAD: unexpected payload from {flotilla}/api/fleet")
        return 1
    return 0


# --- prs -----------------------------------------------------------------------------------------

_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_POSITIVE = re.compile(r"[1-9][0-9]*")
_ROUNDS = re.compile(r"rounds: n=([0-9]+) threshold=off first=([0-9]+|unknown)")
# The convergence note's early trigger (issue-wave SKILL.md, *Converge long reviews*; ludics-lite#650):
# a round 1 of LARGE_FIRST or more inline findings is flagged from round EARLY_ROUND, ahead of --flag-at.
EARLY_ROUND = 3
LARGE_FIRST = 5
_VERDICT = re.compile(r"checks: verdict=([a-z]+)")
_YEAR = re.compile(r"[0-9]{4}-")

# The verdicts each exit status of `pr-review.sh checks` can carry, and what prs prints for them
# (ludics-lite#423): anything else -- a missing trailer, a malformed one, one at odds with the
# status -- is ci=unknown and exit 4, never green.
CI_OF = {
    ("0", "green"): "green",
    ("0", "absent"): "absent",
    ("1", "red"): "red",
    ("1", "runred"): "red",
    ("1", "waived"): "red",
    ("4", "pending"): "pending",
    ("4", "mixed"): "pending",
    ("4", "unjudged"): "pending",
    ("5", "superseded"): "moved",
}


def last_line(text: str) -> str:
    """``tail -n 1 <<<"$text"``."""
    return text.split("\n")[-1]


def wave_issues(records: Json, wave: str) -> list[Json]:
    """``[.[] | select(.request.wave == $w) | .request.issue] | unique``."""
    return unique(path(r, "request", "issue") for r in each(records) if path(r, "request", "wave") == wave)


def pr_rows(listing_doc: Json, issues: list[Json] | None) -> list[list[str]]:
    """The open PRs in number order, kept when they close an issue of ``issues`` (all of them when
    None), as the fields the lines print: number, head sha, creation, draft, branch, title."""
    if not isinstance(listing_doc, list):
        raise JqError(f"cannot sort {type_name(listing_doc)}")
    rows: list[list[str]] = []
    for pr in sort_by(listing_doc, lambda p: idx(p, "number")):
        refs: list[Json] = []
        closing = idx(pr, "closingIssuesReferences")
        if isinstance(closing, (list, dict)):  # `[]?`: anything else is no references
            for ref in each(closing):
                owner = jstr(path(ref, "repository", "owner", "login"))
                refs.append(f"{owner}/{jstr(path(ref, 'repository', 'name'))}#{jstr(idx(ref, 'number'))}")
        if issues is not None and not any(r == i for r in refs for i in issues):
            continue
        fields: list[Json] = [
            idx(pr, "number"),
            idx(pr, "headRefOid"),
            idx(pr, "createdAt"),
            "draft" if truthy(idx(pr, "isDraft")) else "-",
            idx(pr, "headRefName"),
            idx(pr, "title"),
        ]
        rows.append([tsv_field(jstr(f) or "-") for f in fields])
    return rows


def tsv_field(text: str) -> str:
    """One ``@tsv`` field: backslash, tab, newline and carriage return escaped."""
    return text.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


def head_age(date: str, created: str, now: float) -> str:
    """The head's age from the newer of the commit's committer date and the PR's creation (the
    push time is not an API field): ``?`` when neither reads as a date."""
    try:
        stamps = [fromdateiso8601(s) for s in (date, created) if _YEAR.match(s)]
    except JqError:
        return "?"
    if not stamps:
        return "?"
    age = math.floor(now - max(stamps))
    if age < 0:
        return "?"
    if age < 3600:
        return f"{age // 60}m"
    if age < 172800:
        return f"{age // 3600}h{age % 3600 // 60}m"
    return f"{age // 86400}d{age % 86400 // 3600}h"


def converge_note(rounds: str, first: str, flag: str) -> str:
    """The CONVERGE note of one PR's line, or "": at ``flag`` rounds or more, or at EARLY_ROUND or
    more after a round 1 of LARGE_FIRST or more inline findings. An unread count ("?") or round-1
    size ("unknown") raises no note here; ``cmd_prs`` reads either as exit 4."""
    if rounds == "?":
        return ""
    if int(rounds) >= int(flag):
        return f" -- CONVERGE: {rounds} review rounds with findings (flag at {flag}): send the convergence policy"
    if first != "unknown" and int(rounds) >= EARLY_ROUND and int(first) >= LARGE_FIRST:
        return (f" -- CONVERGE: {rounds} review rounds with findings after a round 1 of {first}"
                f" (flag at {EARLY_ROUND} after {LARGE_FIRST} or more): send the convergence policy")
    return ""


def helper_read(argv: list[str], env: dict[str, str] | None = None) -> tuple[int, str]:
    """``$("$helper" ... 2>/dev/null)``: the status and the output, its trailing newlines dropped."""
    done = run(argv, capture=True, stderr_null=True, env=env)
    return done.rc, substitution(done.out)


def cmd_prs(cfg: Config, args: list[str]) -> int:
    """``prs <owner/repo> [--wave <id>] [--flag-at <n>]``: the coordinator's supervision read of open
    PRs (ludics-lite#405). The skill sends the convergence policy "after ~5 rounds", but no view
    showed the count: staging#783 reached round 10 before the coordinator noticed, and ended at 14.
    One line per open PR -- ``pr-review.sh rounds`` (review rounds with findings), ``pr-review.sh
    checks`` (the build signal on the head, never waited for) and the head's age -- and a CONVERGE
    note on a PR at --flag-at rounds or more, or at EARLY_ROUND or more when round 1 had LARGE_FIRST
    or more inline findings (the rounds trailer's ``first``, ludics-lite#650). Of the helper's text
    only the machine-readable trailer each command ends with is read (ludics-lite#423), never the
    prose above it. --wave keeps the PRs
    that close an issue some execution record of that wave names. Exit: 0 read | 1 a PR is at the
    flag, or refused | 4 some read did not answer (a flag wins)."""
    repo = wave = ""
    flag = "5"
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--wave", "--flag-at"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"prs: expected value for {arg}")
            if arg == "--wave":
                wave = args[i + 1]
            else:
                flag = args[i + 1]
            i += 1
        elif arg.startswith("-"):
            die("prs <owner/repo> [--wave <id>] [--flag-at <n>]")
        else:
            if repo:
                die("prs: one <owner/repo>")
            repo = arg
        i += 1
    if not _REPO.fullmatch(repo):
        die("prs: <owner/repo> required")
    if not _POSITIVE.fullmatch(flag):
        die("prs: --flag-at takes a positive number of rounds")
    limit = cfg.env.get("FLEET_PRS_LIMIT") or "1000"
    if not _POSITIVE.fullmatch(limit):
        die("prs: FLEET_PRS_LIMIT must be a positive number of PRs")
    helper = os.path.join(cfg.checkout, "ship-pr", "scripts", "pr-review.sh")
    if not (os.path.isfile(helper) and os.access(helper, os.X_OK)):
        cli.say(f"PRS REFUSED: ship-pr's pr-review.sh missing: {helper}")
        return 1
    issues: list[Json] | None = None
    if wave:
        done = listing(cfg)
        if done.unreachable:
            cli.say(f"PRS UNREACHABLE {cfg.anchor}: the registry naming wave {wave}'s issues did not answer")
            return 4
        if done.rc != 0:
            cli.say(substitution(done.out))
            cli.say("PRS REFUSED: the anchor's registry could not be read")
            return 1
        docs = json_stream(done.out)
        try:
            if docs is None or len(docs) != 1:
                raise JqError("not one registry listing")
            issues = wave_issues(docs[0], wave)
        except JqError:
            cli.say("PRS REFUSED: the anchor's registry did not parse")
            return 1
        if not issues:
            cli.say(f"PRS REFUSED: no execution record names wave {wave}, so its issues are unknown")
            return 1
    # `--limit` is a cap on what gh fetches, not a page size (it pages internally up to it), so a
    # list that reaches it may have lost PRs past it: said on its own line and read as exit 4.
    listed = run(
        [helper, "retry", "--read", "pr", "list", "--repo", repo, "--state", "open", "--limit", limit,
         "--json", "number,title,headRefName,headRefOid,createdAt,isDraft,closingIssuesReferences"],
        capture=True,
    )  # fmt: skip
    if listed.rc == 3:
        cli.say(f"PRS UNREACHABLE: the open PRs of {repo} did not answer")
        return 4
    if listed.rc != 0:
        cli.say(f"PRS REFUSED: the open-PR list of {repo} was refused (pr-review.sh exit {listed.rc})")
        return 1
    worst = 0
    docs = json_stream(listed.out)
    try:
        if docs is None:
            raise JqError("the list does not parse")
        counts = [length(doc) for doc in docs]
        if len(counts) == 1 and isinstance(counts[0], int) and counts[0] >= int(limit):
            cli.say(f"PRS INCOMPLETE {repo}: the list reached its cap of {limit} open PRs (FLEET_PRS_LIMIT), so PRs past it are not shown")
            worst = 4
        rows = [row for doc in docs for row in pr_rows(doc, issues)]
    except JqError:
        cli.say(f"PRS REFUSED: the open-PR list of {repo} did not parse")
        return 1
    rounds_env = {**cfg.env, "SHIP_PR_ROUND_THRESHOLD": "off"}
    for n, sha, created, draft, branch, title in rows:
        _, rounds_out = helper_read([helper, "rounds", f"{repo}#{n}"], env=rounds_env)
        found = _ROUNDS.fullmatch(last_line(rounds_out))
        rounds = found.group(1) if found else "?"
        first = found.group(2) if found else "unknown"
        if (rounds == "?" or first == "unknown") and worst != 1:
            worst = 4
        checks_rc, checks_out = helper_read([helper, "checks", f"{repo}#{n}"])
        verdict = _VERDICT.fullmatch(last_line(checks_out))
        ci = CI_OF.get((str(checks_rc), verdict.group(1) if verdict else ""), "unknown")
        if ci == "unknown" and worst != 1:
            worst = 4
        date_rc, date = helper_read([helper, "retry", "--read", "api", f"repos/{repo}/commits/{sha}", "--jq", ".commit.committer.date"])
        age = head_age(date if date_rc == 0 else "", created, time.time())
        note = converge_note(rounds, first, flag)
        if note:
            worst = 1
        mark = "draft " if draft == "draft" else ""
        cli.say(f"{repo}#{n} rounds={rounds} ci={ci} head={age} {mark}{branch}: {title}{note}")
    if not rows:
        cli.say(f"PRS {repo}: no open PRs" + (f" closing an issue of wave {wave}" if wave else ""))
    return worst
