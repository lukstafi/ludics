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
ROUNDS_TRAILER = re.compile(r"rounds: n=([0-9]+) threshold=off first=([0-9]+|unknown)")
# The convergence note's early trigger (issue-wave SKILL.md, *Converge long reviews*; ludics-lite#650):
# a round 1 of LARGE_FIRST or more inline findings is flagged from round EARLY_ROUND, ahead of --flag-at.
EARLY_ROUND = 3
LARGE_FIRST = 5
# The checks trailer: its verdict, and the runners= field a head held by a job that never got a
# runner carries (ludics#753; prreview/checks.py writes it, its kinds in that order).
# Boundary: only this final-line grammar is read, never prose. The optional branch field
# follows runners; legacy trailers without it remain readable but imply branch=unread.
_VERDICT = re.compile(r"checks: verdict=([a-z]+)(?: runners=(no-runner|never-started|no-runner,never-started))?(?: branch=(current|behind|unread))?")
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


def parse_checks(checks_rc: int, checks_out: str) -> tuple[str, str]:
    """The head's build signal and independent branch agreement from one final-line parse.

    A runners field on a non-pending head makes CI unknown; a missing branch proves no agreement.
    """
    trailer = _VERDICT.fullmatch(last_line(checks_out))
    if trailer is None:
        return "unknown", "unread"
    ci = CI_OF.get((str(checks_rc), trailer.group(1)), "unknown")
    kinds = trailer.group(2)
    if kinds is not None:
        ci = f"pending({kinds})" if ci == "pending" else "unknown"
    return ci, trailer.group(3) or "unread"


def last_line(text: str) -> str:
    """``tail -n 1 <<<"$text"``."""
    return text.split("\n")[-1]


def wave_records(records: Json, wave: str) -> list[Json]:
    """``[.[] | select(.request.wave == $w)]``: the execution records of one wave."""
    return [r for r in each(records) if path(r, "request", "wave") == wave]


def wave_issues(records: Json, wave: str) -> list[Json]:
    """``[.[] | select(.request.wave == $w) | .request.issue // empty] | unique``: a record without
    an issue (ludics-lite#664) names none."""
    return unique(i for r in wave_records(records, wave) if (i := path(r, "request", "issue")) is not None)


def wave_workers(records: Json, wave: str, repo: str) -> tuple[str, ...]:
    """The worker names of one wave's records for ``repo`` that a PR branch can end in (see the
    boundary above WAVE_WORKER): a worker transport's (``subagent``, ``app``, ``cli``), spelled as one
    branch-name component."""
    return tuple(sorted({w for r in wave_records(records, wave)
                   if path(r, "request", "transport") in WORKER_TRANSPORTS
                   and isinstance(owner_name := path(r, "request", "repository"), str)
                   and owner_name.casefold() == repo.casefold()
                   and isinstance(w := path(r, "request", "worker"), str) and WAVE_WORKER.fullmatch(w)}))


def on_worker_branch(pr: Json, workers: tuple[str, ...]) -> bool:
    """Is the PR's head branch one of ``workers``, alone or as its last ``/`` component
    (``claude/w1016-p1t2`` for worker ``w1016-p1t2``), compared exactly, and a branch of the listed
    repository itself (``isCrossRepository`` exactly false: a fork's branch of the same name is not
    a worker's)."""
    branch = idx(pr, "headRefName")
    return (idx(pr, "isCrossRepository") is False and isinstance(branch, str)
            and any(branch == w or branch.endswith(f"/{w}") for w in workers))


def closes_one_of(pr: Json, issues: list[Json]) -> bool:
    """Does the PR close one of ``issues``: its closing references spelled ``owner/name#N``, compared
    as text (``closingIssuesReferences[]?``: a missing or scalar field is no references)."""
    refs: list[Json] = []
    closing = idx(pr, "closingIssuesReferences")
    if isinstance(closing, (list, dict)):
        for ref in each(closing):
            owner = jstr(path(ref, "repository", "owner", "login"))
            refs.append(f"{owner}/{jstr(path(ref, 'repository', 'name'))}#{jstr(idx(ref, 'number'))}")
    return any(r == i for r in refs for i in issues)


def sorted_prs(listing_doc: Json) -> list[Json]:
    """One page of the open-PR list in number order; jq's error on anything but an array."""
    if not isinstance(listing_doc, list):
        raise JqError(f"cannot sort {type_name(listing_doc)}")
    return sort_by(listing_doc, lambda p: idx(p, "number"))


def pr_rows(listing_doc: Json, issues: list[Json] | None, referencing: frozenset[int] = frozenset(),
            workers: tuple[str, ...] = ()) -> list[list[str]]:
    """The open PRs in number order, kept when they close an issue of ``issues``, their number is
    in ``referencing`` or their branch is one of ``workers``' (all of them when ``issues`` is None),
    as the fields the lines print: number, head sha, creation, draft, branch, title, and whether the
    branch is the repository's own (``same``: ``isCrossRepository`` exactly false; else ``fork``)."""
    rows: list[list[str]] = []
    for pr in sorted_prs(listing_doc):
        number = idx(pr, "number")
        if issues is not None and not (closes_one_of(pr, issues) or on_worker_branch(pr, workers)
                                       or (type(number) is int and number in referencing)):
            continue
        fields: list[Json] = [
            number,
            idx(pr, "headRefOid"),
            idx(pr, "createdAt"),
            "draft" if truthy(idx(pr, "isDraft")) else "-",
            idx(pr, "headRefName"),
            idx(pr, "title"),
            "same" if idx(pr, "isCrossRepository") is False else "fork",
        ]
        rows.append([tsv_field(jstr(f) or "-") for f in fields])
    return rows


# --- prs --wave: the PRs that reference a wave issue without closing it ----------------------------
# A wave PR for one item of a multi-item issue says `Refs #N`, so it closes nothing, and the closing
# filter alone dropped it (lukstafi/ludics-lite#655 for #605, wave-20261016). Boundary, a fail-closed
# allowlist: what is read is each wave issue's cross-reference timeline (GraphQL CROSS_REFERENCED_EVENT,
# GitHub's own record of a PR mentioning the issue), never PR or commit text; an issue is a record's
# `issue` spelled exactly `owner/name#N` (WAVE_ISSUE) -- any other spelling (`<repo> integration`, a
# post-wave task label, on a record `reserve` admitted before ludics-lite#664) names no issue and was
# never matched by the closing filter either; a source counts only when it is a PullRequest whose
# repository is the one listed (GitHub names compare case-insensitively), and only a PR the open list
# also holds is printed. One paged read per wave issue, made only when some open PR is not already
# kept by its closing references or its branch (the boundary below WAVE_ISSUE). A read that did
# not answer (exit 3) is PRS UNREACHABLE and exit 4; one refused or of a shape outside this query's is
# PRS REFUSED and exit 1. Either way the read goes on with the PRs it can name, and says so.
WAVE_ISSUE = re.compile(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([1-9][0-9]*)")

# --- prs --wave: the PRs on a wave worker's branch --------------------------------------------------
# A post-wave task has no issue of its own, so its records name none (ludics-lite#664; `reserve`
# refuses an `issue` not spelled `owner/name#N`), and a worker's PR that forgets its `Refs` line
# references nothing: neither read above finds it. Boundary, a fail-closed allowlist: what is read is
# each wave record's `worker`, `transport` and `repository`, never PR text; a worker counts only when
# its record's transport is a worker's (WORKER_TRANSPORTS -- a coordinator's own record names no worker
# PR), its record's `repository` is the one listed (GitHub names compare case-insensitively: a wave
# spanning two repositories keeps each worker to its own, as the records name the PR repository,
# lukstafi/ocannl-staging for an ahrefs/ocannl wave), and its name is one branch-name component (WAVE_WORKER: no `/`, so `/root/issue12` is not read); an open PR
# is kept when its `headRefName` is that name or ends in `/` and that name, compared exactly (git
# branch names are case-sensitive), and its `isCrossRepository` is exactly false -- a worker pushes to
# the repository itself, so a fork's branch of the same name, or a row without the field, is not one.
# Nothing is read beyond the open list prs already holds.
WORKER_TRANSPORTS = frozenset({"subagent", "app", "cli"})
WAVE_WORKER = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*")
XREF_QUERY = (
    "query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {"
    " repository(owner: $owner, name: $name) { issue(number: $number) {"
    " timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 100, after: $endCursor) {"
    " pageInfo { hasNextPage endCursor }"
    " nodes { ... on CrossReferencedEvent { source { __typename"
    " ... on PullRequest { number repository { nameWithOwner } } } } } } } } }"
)


def referencing_prs(pages: list[Json], repo: str) -> set[int]:
    """The numbers of the PRs of ``repo`` among the cross-reference sources of one issue's timeline
    pages (``XREF_QUERY``'s shape; anything else is a JqError)."""
    found: set[int] = set()
    for page in pages:
        items = path(page, "data", "repository", "issue", "timelineItems")
        nodes = idx(items, "nodes")
        if not isinstance(nodes, list):
            raise JqError("a cross-reference page without its nodes")
        if path(items, "pageInfo", "hasNextPage") is not False and page is pages[-1]:
            raise JqError("the last cross-reference page says more follow")
        for node in nodes:
            source = idx(node, "source")
            if idx(source, "__typename") != "PullRequest":
                continue
            number, owner_name = idx(source, "number"), path(source, "repository", "nameWithOwner")
            if type(number) is not int or not isinstance(owner_name, str):
                raise JqError("a PullRequest source without its number and repository")
            if owner_name.casefold() == repo.casefold():
                found.add(number)
    return found


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


def referencing_read(helper: str, repo: str, issue: Json, label: str = "PRS") -> set[int] | tuple[int, str]:
    """The open-list candidates one wave issue's cross-references name (see the boundary above
    WAVE_ISSUE), or (exit, line) when the read did not answer (4) or was refused (1). An issue
    spelled other than ``owner/name#N`` names no issue: nothing to read."""
    spelled = WAVE_ISSUE.fullmatch(issue) if isinstance(issue, str) else None
    if not spelled:
        return set()
    owner, name, number = spelled.groups()
    done = run(
        [helper, "retry", "--read", "api", "graphql", "--paginate", "-f", f"query={XREF_QUERY}",
         "-f", f"owner={owner}", "-f", f"name={name}", "-F", f"number={number}"],
        capture=True,
    )  # fmt: skip
    if done.rc == 3:
        return 4, (f"{label} UNREACHABLE: the cross-references of {issue} did not answer, so a PR of {repo}"
                   " that only references it is not shown")
    if done.rc != 0:
        return 1, (f"{label} REFUSED: the cross-references of {issue} were refused (pr-review.sh exit {done.rc}),"
                   f" so a PR of {repo} that only references it is not shown")
    try:
        pages = json_stream(done.out)
        if not pages:
            raise JqError("no cross-reference page")
        return referencing_prs(pages, repo)
    except JqError:
        return 1, (f"{label} REFUSED: the cross-references of {issue} did not parse, so a PR of {repo}"
                   " that only references it is not shown")


def merge_builds(cfg: Config, clock: float | None = None) -> dict[str, str]:
    """``{owner/name#n, casefolded: its "<elapsed>s/<bound>s" or "waiting(<phase>,<elapsed>s)"}``: the merge
    builds running now, and those queued for this box's slots. #1735's ran past 15 minutes while
    the coordinator's heartbeat listed it as open, and the maintainer noticed first; a slot wait can
    run longer than that. Boundary, a fail-closed allowlist: what is read is THIS box's slot
    directory. Running, through ``holders.held_records``, is a held slot whose confirmed record has
    the command ``mergebuild.build_of`` reads and a ``--deadline``, which is the bound. Queued,
    through ``holders.waiting_records`` (its boundary is what it leaves out), is a flocked waiting
    record whose ``argv`` ``build_of`` reads; its phase is ``window`` or ``slot``. Its wait age
    uses the wall-clock ``since`` timestamp; an unreadable timestamp leaves only the phase. The waiters are
    read first, so a build that takes its slot between the two reads shows as running, and a
    running build wins over a queued one of the same PR. So it does not show a build on another
    box (a CLI worker's), a bare one (a box with no slots), one in a slot its merge already held,
    or one whose wait left no record. Elapsed counts from the command's start, the clock the
    deadline runs on. Nothing is said for what it cannot read: this is a sighting, and an unread
    slot or record leaves the line as it was."""
    from ludics.fleetworker import holders
    from ludics.prreview.mergebuild import build_of

    if not cfg.local_box:
        return {}
    directory = os.path.join(cfg.path(cfg.slot_state), cfg.local_box)
    now = time.monotonic() if clock is None else clock
    found: dict[str, str] = {}
    for waiter in holders.waiting_records(directory):
        build = build_of(waiter.command)
        if build is not None:
            age = "" if waiter.since is None else f",{max(int(time.time() - waiter.since), 0)}s"
            found[build.casefold()] = f"waiting({waiter.phase}{age})"
    for holder in holders.held_records(directory, lambda h: build_of(h.command) is not None and h.deadline is not None):
        build, bound = build_of(holder.command), holder.deadline
        if build is not None and bound is not None:
            elapsed = 0 if holder.expires is None else max(int(bound - (holder.expires - now)), 0)
            found[build.casefold()] = f"{elapsed}s/{bound}s"
    return found


# --- prs: the closing tally -------------------------------------------------------------------------
# lukstafi/ocannl-staging#1877 looked dropped from a wave heartbeat (ludics#1050), but `prs` had
# printed it: it was the read's first PR line, and the coordinator read the heartbeat's output file
# through `tail -10`, which cut the timestamp and that line. PR lines go in number order, so a tail
# loses the oldest PRs, the ones most likely to be deep in review. A read that printed PRs therefore
# ends with one line naming every PR it printed (`listed_line`). That line is the last thing `prs`
# writes, so a tail that keeps any of the read keeps it, and a PR it names with no line above was
# cut by the reader. A read that printed no PRs ends with its `no open PRs` line, as before.
def listed_line(repo: str, numbers: list[str]) -> str:
    """``PRS <repo>: <n> open PR(s) listed above: #a #b ...``: the read's last line when it printed
    PR lines, naming each in the order printed (see the tally's header above)."""
    noun = "open PR" if len(numbers) == 1 else "open PRs"
    return f"PRS {repo}: {len(numbers)} {noun} listed above: " + " ".join(f"#{n}" for n in numbers)


def cmd_prs(cfg: Config, args: list[str]) -> int:
    """``prs <owner/repo> [--wave <id>] [--flag-at <n>]``: the coordinator's supervision read of open
    PRs (ludics-lite#405). The skill sends the convergence policy "after ~5 rounds", but no view
    showed the count: staging#783 reached round 10 before the coordinator noticed, and ended at 14.
    One line per open PR -- ``pr-review.sh rounds`` (review rounds with findings), ``pr-review.sh
    checks`` (the build signal on the head, never waited for; ``pending(<kinds>)`` when a build job
    never got a runner, ludics#753), branch agreement (branch=current|behind|unread), and the head's
    age, ``merge-build=<elapsed>s/<bound>s`` while
    its merge build runs or ``merge-build=waiting(<phase>)`` while it queues (``merge_builds``), --
    and a CONVERGE
    note on a PR at --flag-at rounds or more, or at EARLY_ROUND or more when round 1 had LARGE_FIRST
    or more inline findings (the rounds trailer's ``first``, ludics-lite#650). Of the helper's text
    only the machine-readable trailer each command ends with is read (ludics-lite#423), never the
    prose above it. --wave keeps the PRs that close an issue some execution record of that wave
    names, and those that only reference one (its cross-reference timeline, one paged read per wave
    issue: see the boundary above WAVE_ISSUE), and those on a branch of one of its workers (the
    boundary above WAVE_WORKER). The last line names every PR printed (``listed_line``, ludics#1050).
    Exit: 0 read | 1 a PR is at the flag, or refused |
    4 some read did not answer (a flag wins)."""
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
    worst, selected = open_prs(cfg, "PRS", repo, wave, helper, limit)
    if selected is None:
        return worst
    rows = selected
    rounds_env = {**cfg.env, "SHIP_PR_ROUND_THRESHOLD": "off"}
    building = merge_builds(cfg) if rows else {}
    for n, sha, created, draft, branch, title, _ in rows:
        _, rounds_out = helper_read([helper, "rounds", f"{repo}#{n}"], env=rounds_env)
        found = ROUNDS_TRAILER.fullmatch(last_line(rounds_out))
        rounds = found.group(1) if found else "?"
        first = found.group(2) if found else "unknown"
        if (rounds == "?" or first == "unknown") and worst != 1:
            worst = 4
        checks_rc, checks_out = helper_read([helper, "checks", f"{repo}#{n}"])
        ci, agreement = parse_checks(checks_rc, checks_out)
        if ci == "unknown" and worst != 1:
            worst = 4
        date_rc, date = helper_read([helper, "retry", "--read", "api", f"repos/{repo}/commits/{sha}", "--jq", ".commit.committer.date"])
        age = head_age(date if date_rc == 0 else "", created, time.time())
        note = converge_note(rounds, first, flag)
        if note:
            worst = 1
        mark = "draft " if draft == "draft" else ""
        build = building.get(f"{repo}#{n}".casefold())
        running = f"merge-build={build} " if build else ""
        cli.say(f"{repo}#{n} rounds={rounds} ci={ci} branch={agreement} head={age} {running}{mark}{branch}: {title}{note}")
    if rows:
        cli.say(listed_line(repo, [row[0] for row in rows]))
    else:
        cli.say(f"PRS {repo}: no open PRs" + (f" closing or referencing an issue of wave {wave}, or on a branch of its workers" if wave else ""))
    return worst


def open_prs(cfg: Config, label: str, repo: str, wave: str, helper: str, limit: str) -> tuple[int, list[list[str]] | None]:
    """The open PRs of ``repo`` a supervision read is about, as ``pr_rows`` gives them (number, head
    sha, creation, draft, branch, title): every one, or with ``wave`` the wave's (see cmd_prs and the
    boundaries above WAVE_ISSUE and WAVE_WORKER). Each line it says starts with ``label`` (``PRS``,
    ``SIBLING-SCAN``). With the rows, the worst status of the reads: 0 every read answered, 1 one was
    refused, 4 one did not answer or the list reached its cap. Rows of None, with that status: the
    selection itself could not be made (the registry or the list unread), which a line said."""
    issues: list[Json] | None = None
    workers: tuple[str, ...] = ()
    if wave:
        done = listing(cfg)
        if done.unreachable:
            cli.say(f"{label} UNREACHABLE {cfg.anchor}: the registry naming wave {wave}'s issues did not answer")
            return 4, None
        if done.rc != 0:
            cli.say(substitution(done.out))
            cli.say(f"{label} REFUSED: the anchor's registry could not be read")
            return 1, None
        docs = json_stream(done.out)
        try:
            if docs is None or len(docs) != 1:
                raise JqError("not one registry listing")
            known = bool(wave_records(docs[0], wave))
            issues, workers = wave_issues(docs[0], wave), wave_workers(docs[0], wave, repo)
        except JqError:
            cli.say(f"{label} REFUSED: the anchor's registry did not parse")
            return 1, None
        if not known:
            cli.say(f"{label} REFUSED: no execution record names wave {wave}, so its issues and workers are unknown")
            return 1, None
    # `--limit` is a cap on what gh fetches, not a page size (it pages internally up to it), so a
    # list that reaches it may have lost PRs past it: said on its own line and read as exit 4.
    listed = run(
        [helper, "retry", "--read", "pr", "list", "--repo", repo, "--state", "open", "--limit", limit,
         "--json", "number,title,headRefName,headRefOid,createdAt,isDraft,isCrossRepository,closingIssuesReferences"],
        capture=True,
    )  # fmt: skip
    if listed.rc == 3:
        cli.say(f"{label} UNREACHABLE: the open PRs of {repo} did not answer")
        return 4, None
    if listed.rc != 0:
        cli.say(f"{label} REFUSED: the open-PR list of {repo} was refused (pr-review.sh exit {listed.rc})")
        return 1, None
    worst = 0
    docs = json_stream(listed.out)
    try:
        if docs is None:
            raise JqError("the list does not parse")
        counts = [length(doc) for doc in docs]
        if len(counts) == 1 and isinstance(counts[0], int) and counts[0] >= int(limit):
            cli.say(f"{label} INCOMPLETE {repo}: the list reached its cap of {limit} open PRs (FLEET_PRS_LIMIT), so PRs past it are not shown")
            worst = 4
        pages = [sorted_prs(doc) for doc in docs]
        unkept = issues is not None and any(not (closes_one_of(pr, issues) or on_worker_branch(pr, workers))
                                            for page in pages for pr in page)
    except JqError:
        cli.say(f"{label} REFUSED: the open-PR list of {repo} did not parse")
        return 1, None
    referencing: set[int] = set()
    for issue in (issues or []) if unkept else []:
        read = referencing_read(helper, repo, issue, label)
        if isinstance(read, set):
            referencing |= read
        else:
            cli.say(read[1])
            if read[0] == 1:
                worst = 1
            elif worst != 1:
                worst = 4
    try:
        rows = [row for doc in docs for row in pr_rows(doc, issues, frozenset(referencing), workers)]
    except JqError:
        cli.say(f"{label} REFUSED: the open-PR list of {repo} did not parse")
        return 1, None
    return worst, rows
