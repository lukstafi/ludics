"""``wave ab``: the read-only A/B comparison table across one or more waves (ludics#1274).

``issue-wave/SKILL.md`` (*Codex model choice*) compares worker profiles within three tier groups
(D1 with D1/D2, D2, D2/D3 with D3) once each arm has ten merged tasks in the group, reading
``agent_host`` before launch-to-merge, checkpoint verdicts, automated review rounds, coordinator
interventions, routine answers, and relaunches. Two retrospectives built the join of board rows,
``reviews/*.json`` records, and GitHub PRs by hand. This verb is that join and fold:

    fleet-worker.sh wave ab <wave.json>... [--json] [--no-github]

THE JOIN, AND WHAT IT READS (fail-closed allowlist):
  wave files    each named ``<wave.json>`` via ``wave.load_wave`` (``wave``, ``directory``,
                ``repository``, ``split``). Duplicate wave IDs across arguments refuse (exit 2).
  boards        each named wave's board on the anchor via ``takeover.board_status``, projected
                through ``status.wave_of`` (the ``status --json`` v1 task projection: ``phase``,
                ``tier``, ``transport``, ``kind``, ``model``, ``agent_host``, ``issue``, ``source``,
                ``repository``, ``pr``, ``merge``, ``launched_at``, ``reassignment_reason``, and
                ``interventions``, ``routine_answers``, ``relaunches`` with ``counted_from`` and
                ``<counter>_from``). No lock, no lease, no coordinator identity.
  reviews       files in ``<wave dir>/reviews/`` whose basename matches ``RECORD_NAME``
                (``<pr>-(at-open|confirm)-<sha12>[.r<n>].json``, including ``--again`` set-aside
                rounds, excluding ``.run.json``), read via ``wavereview.read_record`` and
                ``wavereview.verdict_of``. Only posted records (``dry_run`` not true and non-empty
                ``comment``) count as rounds. Joined by ``task`` when it matches a board row of that
                wave (noting any ``pr`` mismatch), else by ``pr``; unmatched records are noted.
  GitHub PRs    unless ``--no-github`` is passed, for each merged sample PR (valid ``repository``
                and decimal ``pr``), batched GraphQL (``BATCH_SIZE`` PRs per query, subdivided on
                alias-level failures so one bad PR does not drop valid siblings) through
                ``ludics.prreview.core.GhSession.retry("read", ...)`` reading ``state``,
                ``createdAt``, ``mergedAt``, ``mergeCommit.oid``, ``reviews(first: 100)`` and
                ``comments(first: 100)``. Automated review rounds follow ``prreview/state.py``'s
                ``review_rounds`` rules (respecting ``REVIEWER`` prefix matching and
                ``SHIP_PR_ROUND_GAP``, dropping non-substantive empty-bodied envelopes and
                connector fixed replies, and falling back to ``prreview.state.review_rounds`` for
                any PR whose GraphQL connection reports ``hasNextPage``). When both board ``merge``
                and GitHub ``mergeCommit.oid`` are present and disagree, PR metrics are withheld
                with a note.

WHAT IT DELIBERATELY DOES NOT READ:
  ``queue.json``, ``prep/*.json``, ``tasks/*.md``, ``handbacks/*.md``, ``sequencing_plan.md``, board
  logs, board ``review=``/``confirm=`` strings (history comes only from ``reviews/*.json``), legacy
  pre-#1275 reassignment keys (``reassigned``, ``reassigned_from``), execution registry records, PR
  diffs/commits, or worker tmux sessions. Nothing is written anywhere.

GROUPING, THRESHOLD, AND HONESTY RULES:
  - Arms are keyed on the row's stored ``(transport, kind, model)`` tuple (missing parts ``"-"``);
    no model or profile names are hard-coded and no spelling is normalised. An incomplete arm (any
    missing component) stays visible in the table but cannot establish readiness.
  - ``GROUPS`` partitions ``waveprep.TIERS`` into ``D1+D1/D2``, ``D2``, and ``D2/D3+D3``. Rows with
    no tier or a value outside ``TIERS`` land in ``untiered`` and never count toward a threshold.
  - Rows carrying a nonblank ``reassignment_reason`` (#1275) are set apart from the comparison
    sample and threshold counts and listed in their own section.
  - The comparison sample is non-reassigned rows with ``phase == "merged"`` (``takeover.phase_of``).
    A tier group reaches its reading when at least two complete arms each have ``>= READY`` (10)
    merged rows.
  - Host balance within a tier group compares merged arms using exact fractions: ``unknown`` when
    any compared arm lacks ``agent_host`` on one or more rows, else ``IMBALANCED`` when two arms
    differ in their host sets or by strictly more than ``IMBALANCE_SHARE`` (1/5, 20 percentage
    points) on any host, else ``balanced``.
  - Missing values are never guessed or zero-filled. Tally counters on rows with ``counted_from`` or
    ``<counter>_from`` are partial lower bounds: excluded from whole-count aggregates and counted
    explicitly alongside missing and invalid counts. Unreadable checkpoint verdicts are excluded
    from finding-count totals and coverage. Unparseable timestamps and negative durations are noted
    and excluded.

Exit: 0 printed, every source read; 1 a named wave has no board or its board was refused (nothing on
stdout); 2 usage; 3 printed with unread/malformed review or GitHub sources named in ``errors``;
4 the anchor did not answer.
"""

import collections
import json
import os
import re
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from fractions import Fraction
from typing import Any, assert_never, cast

from ludics import cli
from ludics.fleetworker.boardstore import COUNT, COUNTERS, NO_BOARD_EXIT
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.status import wave_of
from ludics.fleetworker.takeover import board_status
from ludics.fleetworker.transport import err
from ludics.fleetworker.wave import USAGE, Wave, load_wave
from ludics.fleetworker.waveprep import TIERS
from ludics.fleetworker.wavereview import read_record, verdict_of
from ludics.prreview import core as prcore
from ludics.prreview.feeds import CONNECTOR_FIXED_REPLIES, outside_watch
from ludics.prreview.jqsem import JqError, capture_first, fromdateiso8601, onig
from ludics.prreview.poll import REVIEWED_COMMIT_RE
from ludics.prreview.state import INIT_FAILURE_ENV_RE, INIT_FAILURE_GIT_RE, review_rounds as pr_review_rounds

VERSION = 1
READY = 10
IMBALANCE_SHARE = Fraction(1, 5)
BATCH_SIZE = 20

GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("D1+D1/D2", ("D1", "D1/D2")),
    ("D2", ("D2",)),
    ("D2/D3+D3", ("D2/D3", "D3")),
)
UNTIERED = "untiered"
GROUP_NAMES: tuple[str, ...] = tuple(name for name, _ in GROUPS)
TIER_TO_GROUP: dict[str, str] = {tier: name for name, tiers in GROUPS for tier in tiers}

RECORD_NAME = re.compile(r"([1-9][0-9]*)-(at-open|confirm)-[0-9a-f]{12}(?:\.r[1-9][0-9]*)?\.json")
ISSUE_REF = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#([1-9][0-9]*)")
PR_NUMBER = re.compile(r"[1-9][0-9]*")
REPO_NAME = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")

# Aligned with ludics.prreview.state (public init-failure regexes plus the summary/no-findings rules).
_SUMMARY_TAG = "codex-pull-request-review-summary"
_NO_FINDINGS = onig("[Dd]idn.t find any major issues")
_INIT_FAILURE = onig(f"(?:{INIT_FAILURE_GIT_RE})|(?:{INIT_FAILURE_ENV_RE})")


@dataclass(frozen=True)
class Arm:
    transport: str
    kind: str
    model: str

    @property
    def complete(self) -> bool:
        return "-" not in (self.transport, self.kind, self.model)

    @property
    def label(self) -> str:
        return f"{self.transport}/{self.kind} {self.model}"

    def as_dict(self) -> dict[str, Any]:
        return {"transport": self.transport, "kind": self.kind, "model": self.model,
                "label": self.label, "complete": self.complete}


@dataclass(frozen=True)
class ReviewRecord:
    wave: str
    file: str
    task: str
    pr: str
    kind: str  # "at-open" | "confirm"
    at: str
    word: str
    blocking: int
    suggestions: int
    blocks: bool


@dataclass(frozen=True)
class GithubFacts:
    state: str | None
    created_at: str | None
    merged_at: str | None
    merge_commit: str | None
    review_rounds: int | None


@dataclass(frozen=True)
class CounterReading:
    status: str  # "whole" | "partial" | "missing" | "invalid"
    value: int | None
    marker: str | None  # counted_from / <counter>_from value when partial

    def as_dict(self) -> dict[str, Any]:
        return {"status": self.status, "value": self.value, "marker": self.marker}


@dataclass(frozen=True)
class Task:
    wave: str
    task: str
    tier: str | None
    group: str
    arm: Arm
    phase: str
    agent_host: str | None
    issue_number: int | None
    issue_source: str | None  # "issue" | "source" | None
    repository: str | None
    pr: str | None
    merge: str | None
    launched_at: str | None
    reassignment_reason: str | None
    at_open_word: str | None
    at_open_blocking: int | None
    at_open_suggestions: int | None
    at_open_rounds: int
    confirm_rounds: int
    confirm_not_cleared: int
    github_status: str  # "read" | "skipped" | "unread" | "no-pr" | "not-sample"
    github_state: str | None
    review_rounds: int | None
    launch_to_merge_hours: float | None
    open_to_merge_hours: float | None
    counters: dict[str, CounterReading]

    @property
    def reassigned(self) -> bool:
        return self.reassignment_reason is not None

    @property
    def in_sample(self) -> bool:
        return self.phase == "merged" and not self.reassigned

    def as_dict(self) -> dict[str, Any]:
        return {
            "wave": self.wave,
            "task": self.task,
            "tier": self.tier,
            "group": self.group,
            "arm": self.arm.as_dict(),
            "phase": self.phase,
            "agent_host": self.agent_host,
            "issue_number": self.issue_number,
            "issue_source": self.issue_source,
            "repository": self.repository,
            "pr": self.pr,
            "merge": self.merge,
            "launched_at": self.launched_at,
            "reassignment_reason": self.reassignment_reason,
            "in_sample": self.in_sample,
            "at_open": {
                "word": self.at_open_word,
                "blocking": self.at_open_blocking,
                "suggestions": self.at_open_suggestions,
                "rounds": self.at_open_rounds,
            },
            "confirm": {
                "rounds": self.confirm_rounds,
                "not_cleared": self.confirm_not_cleared,
            },
            "github_status": self.github_status,
            "github_state": self.github_state,
            "review_rounds": self.review_rounds,
            "launch_to_merge_hours": round(self.launch_to_merge_hours, 4) if self.launch_to_merge_hours is not None else None,
            "open_to_merge_hours": round(self.open_to_merge_hours, 4) if self.open_to_merge_hours is not None else None,
            "counters": {name: reading.as_dict() for name, reading in self.counters.items()},
        }


# --- parsing and normalization --------------------------------------------------------------------

def parse_args(args: list[str]) -> tuple[list[str], bool, bool]:
    paths: list[str] = []
    as_json = False
    no_github = False
    for word in args:
        if word == "--json":
            as_json = True
        elif word == "--no-github":
            no_github = True
        elif word.startswith("-"):
            die(f"wave ab: unknown option {word}; usage: {USAGE}")
        else:
            paths.append(word)
    if not paths:
        die(f"wave ab: name at least one wave.json file; usage: {USAGE}")
    return paths, as_json, no_github


def load_waves(paths: list[str]) -> list[Wave]:
    waves: list[Wave] = []
    seen: set[str] = set()
    for path in paths:
        loaded = load_wave(path, "ab")
        if loaded.wave in seen:
            die(f"wave ab: wave {loaded.wave!r} is named more than once")
        seen.add(loaded.wave)
        waves.append(loaded)
    return waves


def arm_of(row: dict[str, Any]) -> Arm:
    def part(key: str) -> str:
        val = row.get(key)
        return val.strip() if isinstance(val, str) and val.strip() else "-"

    return Arm(part("transport"), part("kind"), part("model"))


def group_of(tier: str | None) -> str:
    if tier is None:
        return UNTIERED
    return TIER_TO_GROUP.get(tier, UNTIERED)


def issue_number_of(row: dict[str, Any]) -> tuple[int | None, str | None]:
    for key in ("issue", "source"):
        raw = row.get(key)
        if isinstance(raw, str):
            m = ISSUE_REF.fullmatch(raw.strip())
            if m is not None:
                return int(m.group(1)), key
    return None, None


def parse_iso(text: str | None) -> datetime | None:
    if not isinstance(text, str) or not text.strip():
        return None
    raw = text.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc)


def text_or_none(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def counter_of(row: dict[str, Any], counter: str, wave: str, task: str, notes: list[str]) -> CounterReading:
    counted_from = text_or_none(row.get("counted_from"))
    own_from = text_or_none(row.get(f"{counter}_from"))
    marker = own_from or counted_from
    raw = row.get(counter)
    if raw is None:
        return CounterReading("missing", None, marker)
    if not isinstance(raw, str) or not COUNT.fullmatch(raw):
        notes.append(f"{wave}/{task}: invalid {counter}={raw!r} (not a decimal count); excluded")
        return CounterReading("invalid", None, marker)
    value = int(raw)
    if marker is not None:
        return CounterReading("partial", value, marker)
    return CounterReading("whole", value, None)


# --- reviews/*.json reader ------------------------------------------------------------------------

def read_reviews(wave: Wave, errors: list[dict[str, str]]) -> list[ReviewRecord]:
    reviews_dir = os.path.join(wave.directory, "reviews")
    try:
        names = sorted(os.listdir(reviews_dir))
    except FileNotFoundError:
        return []
    except OSError as exc:
        errors.append({"source": "reviews", "wave": wave.wave, "path": reviews_dir, "why": str(exc)})
        return []
    records: list[ReviewRecord] = []
    for name in names:
        m = RECORD_NAME.fullmatch(name)
        if m is None:
            continue
        file_pr, file_kind = m.group(1), m.group(2)
        path = os.path.join(reviews_dir, name)
        try:
            raw = read_record(path)
        except ValueError as exc:
            errors.append({"source": "review", "wave": wave.wave, "path": path, "why": str(exc)})
            continue
        if raw is None:
            continue
        rec_kind = raw.get("kind")
        if rec_kind != file_kind:
            errors.append({"source": "review", "wave": wave.wave, "path": path,
                           "why": f"record kind {rec_kind!r} disagrees with filename kind {file_kind!r}"})
            continue
        rec_pr = raw.get("pr")
        pr_str = str(rec_pr) if isinstance(rec_pr, (str, int)) and not isinstance(rec_pr, bool) else file_pr
        if pr_str != file_pr:
            errors.append({"source": "review", "wave": wave.wave, "path": path,
                           "why": f"record pr {pr_str!r} disagrees with filename pr {file_pr!r}"})
            continue
        if raw.get("dry_run") is True:
            continue
        comment = raw.get("comment")
        if not isinstance(comment, str) or not comment.strip():
            continue
        verdict = verdict_of(raw)
        at_raw: Any = raw.get("at")
        at = at_raw if isinstance(at_raw, str) else ""
        task_raw: Any = raw.get("task")
        task = task_raw if isinstance(task_raw, str) else ""
        records.append(ReviewRecord(wave.wave, name, task, file_pr, file_kind, at, verdict.word,
                                    verdict.blocking, verdict.suggestions, verdict.blocks))
    return records


# --- GitHub batched GraphQL reader ----------------------------------------------------------------

def _same_head(a: str | None, b: str | None) -> bool:
    if a == b:
        return True
    if not a or not b:
        return False
    return a.startswith(b) or b.startswith(a)


def _login_matches(author: Any, reviewer: str) -> bool:
    if not isinstance(author, dict):
        return False
    login = cast(dict[str, Any], author).get("login")
    if not isinstance(login, str):
        return False
    if login.startswith(reviewer):
        return True
    # GraphQL omits the REST "[bot]" suffix on GitHub App logins.
    return reviewer.endswith("[bot]") and login == reviewer.removesuffix("[bot]")


def _graphql_review_rounds(pr_obj: dict[str, Any], reviewer: str, round_gap: int) -> int | None:
    """Compute automated review rounds from a GraphQL pullRequest node, matching
    ``prreview.state.review_rounds``. Returns None when any connection needs pagination
    (caller falls back to ``prreview.state.review_rounds``) or when timestamps do not parse."""
    reviews_conn: Any = pr_obj.get("reviews")
    comments_conn: Any = pr_obj.get("comments")
    if not isinstance(reviews_conn, dict) or not isinstance(comments_conn, dict):
        return None
    rev_dict = cast(dict[str, Any], reviews_conn)
    com_dict = cast(dict[str, Any], comments_conn)
    rev_page: Any = rev_dict.get("pageInfo")
    com_page: Any = com_dict.get("pageInfo")
    if not (isinstance(rev_page, dict) and cast(dict[str, Any], rev_page).get("hasNextPage") is False):
        return None
    if not (isinstance(com_page, dict) and cast(dict[str, Any], com_page).get("hasNextPage") is False):
        return None
    rev_nodes: Any = rev_dict.get("nodes")
    com_nodes: Any = com_dict.get("nodes")
    if not isinstance(rev_nodes, list) or not isinstance(com_nodes, list):
        return None

    events: list[tuple[str, int]] = []
    try:
        for item in cast(list[Any], rev_nodes):
            if not isinstance(item, dict):
                continue
            r = cast(dict[str, Any], item)
            if not _login_matches(r.get("author"), reviewer):
                continue
            submitted = r.get("submittedAt")
            state = r.get("state")
            if not isinstance(submitted, str) or state not in ("COMMENTED", "CHANGES_REQUESTED"):
                continue
            body_raw: Any = r.get("body")
            body = body_raw if isinstance(body_raw, str) else ""
            if state == "COMMENTED" and not body.strip():
                inline_conn: Any = r.get("comments")
                if not isinstance(inline_conn, dict):
                    return None
                inline_dict = cast(dict[str, Any], inline_conn)
                inline_page: Any = inline_dict.get("pageInfo")
                if not (isinstance(inline_page, dict) and cast(dict[str, Any], inline_page).get("hasNextPage") is False):
                    return None
                inline_nodes: Any = inline_dict.get("nodes")
                if not isinstance(inline_nodes, list):
                    return None
                all_fixed = True
                for raw_c in cast(list[Any], inline_nodes):
                    if not isinstance(raw_c, dict):
                        all_fixed = False
                        break
                    c = cast(dict[str, Any], raw_c)
                    reply_to = c.get("replyTo")
                    cbody = c.get("body")
                    if reply_to is None or not isinstance(cbody, str) or cbody.rstrip() not in CONNECTOR_FIXED_REPLIES:
                        all_fixed = False
                        break
                if all_fixed:
                    continue
            commit: Any = r.get("commit")
            oid = cast(dict[str, Any], commit).get("oid") if isinstance(commit, dict) else ""
            sha = oid if isinstance(oid, str) else ""
            events.append((sha, fromdateiso8601(submitted)))

        for item in cast(list[Any], com_nodes):
            if not isinstance(item, dict):
                continue
            c = cast(dict[str, Any], item)
            if not _login_matches(c.get("author"), reviewer):
                continue
            created = c.get("createdAt")
            if not isinstance(created, str):
                continue
            cbody_raw: Any = c.get("body")
            cbody = cbody_raw if isinstance(cbody_raw, str) else ""
            if _SUMMARY_TAG in cbody or _NO_FINDINGS.search(cbody) or _INIT_FAILURE.search(cbody):
                continue
            stamp = capture_first(cbody, REVIEWED_COMMIT_RE)
            sha = (stamp["s"] if stamp is not None and stamp.get("s") else None) or "comment"
            events.append((sha, fromdateiso8601(created)))
    except JqError:
        return None

    n = 0
    cur: str | None = None
    last_t = 0
    for sha, when in sorted(events, key=lambda e: e[1]):
        if not _same_head(sha, cur) or when - last_t > round_gap:
            n += 1
            cur = sha
        last_t = when
    return n


def _batch_query(chunk: list[tuple[str, int]]) -> str:
    parts: list[str] = []
    for idx, (repo, num) in enumerate(chunk):
        owner, name = repo.split("/", 1)
        parts.append(
            f"p{idx}: repository(owner: {json.dumps(owner)}, name: {json.dumps(name)}) {{"
            f" pullRequest(number: {num}) {{"
            " number state createdAt mergedAt mergeCommit { oid }"
            " reviews(first: 100) { pageInfo { hasNextPage } nodes {"
            " author { login } state submittedAt commit { oid } body"
            " comments(first: 100) { pageInfo { hasNextPage } nodes { replyTo { id } body } }"
            " } }"
            " comments(first: 100) { pageInfo { hasNextPage } nodes {"
            " author { login } createdAt body } }"
            " } }"
        )
    return "query { " + " ".join(parts) + " }"


def _fetch_chunk(
    session: prcore.GhSession,
    pr_cfg: prcore.Config,
    chunk: list[tuple[str, int]],
    out: dict[tuple[str, int], GithubFacts],
    errors: list[dict[str, str]],
) -> None:
    query = _batch_query(chunk)
    result = session.retry("read", ["api", "graphql", "-f", f"query={query}"])
    match result:
        case prcore.GhOk(stdout=stdout):
            try:
                decoded: Any = json.loads(stdout)
            except ValueError as exc:
                for repo, num in chunk:
                    errors.append({"source": "github", "pr": f"{repo}#{num}", "why": f"GraphQL response was not JSON ({exc})"})
                return
            if not isinstance(decoded, dict):
                for repo, num in chunk:
                    errors.append({"source": "github", "pr": f"{repo}#{num}", "why": "GraphQL response was not a JSON object"})
                return
            top = cast(dict[str, Any], decoded)
            data_raw: Any = top.get("data")
            data = cast(dict[str, Any], data_raw) if isinstance(data_raw, dict) else {}
            for idx, (repo, num) in enumerate(chunk):
                repo_node: Any = data.get(f"p{idx}")
                pr_raw: Any = cast(dict[str, Any], repo_node).get("pullRequest") if isinstance(repo_node, dict) else None
                if not isinstance(pr_raw, dict):
                    errors.append({"source": "github", "pr": f"{repo}#{num}", "why": "pullRequest absent in GraphQL response"})
                    continue
                pr_obj = cast(dict[str, Any], pr_raw)
                mc: Any = pr_obj.get("mergeCommit")
                merge_oid = text_or_none(cast(dict[str, Any], mc).get("oid")) if isinstance(mc, dict) else None
                rounds = _graphql_review_rounds(pr_obj, pr_cfg.reviewer, pr_cfg.round_gap)
                if rounds is None:
                    fallback = pr_review_rounds(outside_watch(session, repo), str(num), pr_cfg.round_gap)
                    if fallback.count is None:
                        errors.append({"source": "github", "pr": f"{repo}#{num}",
                                       "why": f"review rounds unread ({fallback.detail})"})
                    rounds = fallback.count
                out[(repo, num)] = GithubFacts(
                    state=text_or_none(pr_obj.get("state")),
                    created_at=text_or_none(pr_obj.get("createdAt")),
                    merged_at=text_or_none(pr_obj.get("mergedAt")),
                    merge_commit=merge_oid,
                    review_rounds=rounds,
                )
        case prcore.GhFailed():
            # One bad alias (stale PR or inaccessible repo) makes `gh api graphql` exit nonzero
            # even when sibling aliases succeeded: subdivide so valid PRs still read.
            if len(chunk) > 1:
                mid = len(chunk) // 2
                _fetch_chunk(session, pr_cfg, chunk[:mid], out, errors)
                _fetch_chunk(session, pr_cfg, chunk[mid:], out, errors)
                return
            why = session.err_line() or "GitHub GraphQL call failed"
            for repo, num in chunk:
                errors.append({"source": "github", "pr": f"{repo}#{num}", "why": why})
        case prcore.GhUnanswered():
            why = session.err_line() or "GitHub GraphQL call did not answer"
            for repo, num in chunk:
                errors.append({"source": "github", "pr": f"{repo}#{num}", "why": why})
        case _:
            assert_never(result)


def read_github_prs(
    cfg: Config, targets: list[tuple[str, int]], errors: list[dict[str, str]]
) -> dict[tuple[str, int], GithubFacts]:
    if not targets:
        return {}
    pr_cfg = prcore.load_config(cfg.env)
    session = prcore.GhSession(pr_cfg)
    out: dict[tuple[str, int], GithubFacts] = {}

    for start in range(0, len(targets), BATCH_SIZE):
        _fetch_chunk(session, pr_cfg, targets[start : start + BATCH_SIZE], out, errors)
    return out


# --- join and fold --------------------------------------------------------------------------------

def join_wave(
    wave: Wave,
    rows: list[dict[str, Any]],
    reviews: list[ReviewRecord],
    github: dict[tuple[str, int], GithubFacts],
    no_github: bool,
    notes: list[str],
) -> list[Task]:
    by_task_name: dict[str, dict[str, Any]] = {}
    pr_to_tasks: dict[str, list[str]] = collections.defaultdict(list)
    for row in rows:
        tname = text_or_none(row.get("task")) or ""
        if tname:
            by_task_name[tname] = row
        pr_str = text_or_none(row.get("pr"))
        if pr_str and PR_NUMBER.fullmatch(pr_str):
            pr_to_tasks[pr_str].append(tname)

    attached: dict[str, list[ReviewRecord]] = collections.defaultdict(list)
    for rec in reviews:
        if rec.task and rec.task in by_task_name:
            attached[rec.task].append(rec)
            row_pr = text_or_none(by_task_name[rec.task].get("pr"))
            if row_pr and row_pr != rec.pr:
                notes.append(f"{wave.wave}/{rec.task}: review record {rec.file} names PR #{rec.pr}, board row names #{row_pr}")
        elif len(pr_to_tasks.get(rec.pr, [])) == 1:
            attached[pr_to_tasks[rec.pr][0]].append(rec)
        else:
            notes.append(f"{wave.wave}: orphan review record {rec.file} (task={rec.task or '-'}, pr=#{rec.pr}) matches no board row")

    tasks: list[Task] = []
    for row in rows:
        tname = text_or_none(row.get("task")) or "<unnamed>"
        tier = text_or_none(row.get("tier"))
        group = group_of(tier)
        if tier is not None and tier not in TIER_TO_GROUP:
            notes.append(f"{wave.wave}/{tname}: unrecognized tier {tier!r}; placed in {UNTIERED}")
        arm = arm_of(row)
        phase = text_or_none(row.get("phase")) or "unknown"
        agent_host = text_or_none(row.get("agent_host"))
        issue_num, issue_src = issue_number_of(row)
        repo = text_or_none(row.get("repository"))
        pr_raw = text_or_none(row.get("pr"))
        pr = pr_raw if pr_raw and PR_NUMBER.fullmatch(pr_raw) else None
        if pr_raw is not None and pr is None:
            notes.append(f"{wave.wave}/{tname}: non-numeric pr={pr_raw!r}; ignored")
        merge = text_or_none(row.get("merge"))
        launched_at = text_or_none(row.get("launched_at"))
        reason = text_or_none(row.get("reassignment_reason"))
        in_sample = phase == "merged" and reason is None

        task_reviews = attached.get(tname, [])
        at_opens = sorted((r for r in task_reviews if r.kind == "at-open"), key=lambda r: (r.at, r.file))
        confirms = sorted((r for r in task_reviews if r.kind == "confirm"), key=lambda r: (r.at, r.file))
        if len(at_opens) > 1:
            notes.append(f"{wave.wave}/{tname}: {len(at_opens)} posted at-open review records; initial record used for verdict")
        first_ao = at_opens[0] if at_opens else None

        gh_status = "not-sample"
        gh_state: str | None = None
        rev_rounds: int | None = None
        l2m: float | None = None
        o2m: float | None = None

        if in_sample:
            if no_github:
                gh_status = "skipped"
            elif pr is None or repo is None or not REPO_NAME.fullmatch(repo):
                gh_status = "no-pr"
                notes.append(f"{wave.wave}/{tname}: merged row lacks valid repository/pr ({repo!r}/{pr_raw!r}); GitHub metrics absent")
            else:
                facts = github.get((repo, int(pr)))
                if facts is None:
                    gh_status = "unread"
                elif merge is not None and facts.merge_commit is not None and not (
                    len(merge) >= 7 and _same_head(merge.lower(), facts.merge_commit.lower())
                ):
                    gh_status = "mismatch"
                    gh_state = facts.state
                    notes.append(
                        f"{wave.wave}/{tname}: board merge {merge} disagrees with GitHub {repo}#{pr}"
                        f" mergeCommit {facts.merge_commit}; PR metrics withheld"
                    )
                else:
                    gh_status = "read"
                    gh_state = facts.state
                    rev_rounds = facts.review_rounds
                    if facts.state != "MERGED":
                        notes.append(f"{wave.wave}/{tname}: board phase is merged, but GitHub {repo}#{pr} state is {facts.state or 'unknown'}")
                    merged_dt = parse_iso(facts.merged_at)
                    created_dt = parse_iso(facts.created_at)
                    launched_dt = parse_iso(launched_at)
                    if launched_at is not None and launched_dt is None:
                        notes.append(f"{wave.wave}/{tname}: unparseable launched_at={launched_at!r}; excluded from launch->merge")
                    if facts.merged_at is not None and merged_dt is None:
                        notes.append(f"{wave.wave}/{tname}: unparseable GitHub mergedAt={facts.merged_at!r}; excluded from durations")
                    if facts.created_at is not None and created_dt is None:
                        notes.append(f"{wave.wave}/{tname}: unparseable GitHub createdAt={facts.created_at!r}; excluded from open->merge")
                    if launched_dt is not None and merged_dt is not None:
                        delta = (merged_dt - launched_dt).total_seconds() / 3600.0
                        if delta < 0:
                            notes.append(f"{wave.wave}/{tname}: negative launch->merge ({delta:.2f}h); excluded")
                        else:
                            l2m = delta
                    if created_dt is not None and merged_dt is not None:
                        delta = (merged_dt - created_dt).total_seconds() / 3600.0
                        if delta < 0:
                            notes.append(f"{wave.wave}/{tname}: negative open->merge ({delta:.2f}h); excluded")
                        else:
                            o2m = delta

        counters = {name: counter_of(row, name, wave.wave, tname, notes) for name in COUNTERS}
        tasks.append(Task(
            wave=wave.wave,
            task=tname,
            tier=tier,
            group=group,
            arm=arm,
            phase=phase,
            agent_host=agent_host,
            issue_number=issue_num,
            issue_source=issue_src,
            repository=repo,
            pr=pr,
            merge=merge,
            launched_at=launched_at,
            reassignment_reason=reason,
            at_open_word=first_ao.word if first_ao else None,
            at_open_blocking=first_ao.blocking if first_ao else None,
            at_open_suggestions=first_ao.suggestions if first_ao else None,
            at_open_rounds=len(at_opens),
            confirm_rounds=len(confirms),
            confirm_not_cleared=sum(1 for c in confirms if c.blocks),
            github_status=gh_status,
            github_state=gh_state,
            review_rounds=rev_rounds,
            launch_to_merge_hours=l2m,
            open_to_merge_hours=o2m,
            counters=counters,
        ))
    return tasks


def _host_counts(tasks: list[Task]) -> dict[str, int]:
    counts: collections.Counter[str] = collections.Counter(t.agent_host or "-" for t in tasks)
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))


def host_balance(arm_hosts: list[dict[str, int]]) -> str:
    nonempty = [h for h in arm_hosts if sum(h.values()) > 0]
    if len(nonempty) < 2:
        return "single-arm"
    if any("-" in h for h in nonempty):
        return "unknown"
    host_sets = [set(h.keys()) for h in nonempty]
    if any(s != host_sets[0] for s in host_sets[1:]):
        return "IMBALANCED"
    all_hosts = sorted(host_sets[0])
    shares = [{host: Fraction(h[host], sum(h.values())) for host in all_hosts} for h in nonempty]
    for host in all_hosts:
        vals = [s[host] for s in shares]
        if max(vals) - min(vals) > IMBALANCE_SHARE:
            return "IMBALANCED"
    return "balanced"


def _counter_summary(sample: list[Task], counter: str) -> dict[str, Any]:
    whole = [t.counters[counter].value for t in sample if t.counters[counter].status == "whole"]
    whole_ints = [v for v in whole if v is not None]
    partial = [t.counters[counter].value for t in sample if t.counters[counter].status == "partial"]
    partial_ints = [v for v in partial if v is not None]
    missing_n = sum(1 for t in sample if t.counters[counter].status == "missing")
    invalid_n = sum(1 for t in sample if t.counters[counter].status == "invalid")
    return {
        "n": len(whole_ints),
        "total": len(sample),
        "sum": sum(whole_ints) if whole_ints else None,
        "median": round(float(statistics.median(whole_ints)), 2) if whole_ints else None,
        "mean": round(float(statistics.mean(whole_ints)), 2) if whole_ints else None,
        "partial_n": len(partial_ints),
        "partial_sum": sum(partial_ints) if partial_ints else 0,
        "missing_n": missing_n,
        "invalid_n": invalid_n,
    }


def _duration_summary(values: list[float | None], total: int) -> dict[str, Any]:
    present = [v for v in values if v is not None]
    if not present:
        return {"n": 0, "total": total, "median": None, "min": None, "max": None}
    return {
        "n": len(present),
        "total": total,
        "median": round(float(statistics.median(present)), 2),
        "min": round(min(present), 2),
        "max": round(max(present), 2),
    }


def _rounds_summary(sample: list[Task]) -> dict[str, Any]:
    vals = [t.review_rounds for t in sample if t.review_rounds is not None]
    unread_n = sum(1 for t in sample if t.github_status == "unread" or (t.github_status == "read" and t.review_rounds is None))
    skipped_n = sum(1 for t in sample if t.github_status == "skipped")
    return {
        "n": len(vals),
        "total": len(sample),
        "median": round(float(statistics.median(vals)), 2) if vals else None,
        "mean": round(float(statistics.mean(vals)), 2) if vals else None,
        "unread_n": unread_n,
        "skipped_n": skipped_n,
    }


def build_document(
    waves: list[Wave],
    tasks: list[Task],
    no_github: bool,
    notes: list[str],
    errors: list[dict[str, str]],
) -> dict[str, Any]:
    by_wave: dict[str, list[Task]] = collections.defaultdict(list)
    for t in tasks:
        by_wave[t.wave].append(t)

    wave_summaries: list[dict[str, Any]] = []
    for w in waves:
        wtasks = by_wave[w.wave]
        non_reassigned = [t for t in wtasks if not t.reassigned]
        parity_by_arm: dict[str, dict[str, int]] = {}
        arms_here = sorted({t.arm for t in non_reassigned}, key=lambda a: (a.transport, a.kind, a.model))
        for arm in arms_here:
            arm_rows = [t for t in non_reassigned if t.arm == arm]
            parity_by_arm[arm.label] = {
                "odd": sum(1 for t in arm_rows if t.issue_number is not None and t.issue_number % 2 == 1),
                "even": sum(1 for t in arm_rows if t.issue_number is not None and t.issue_number % 2 == 0),
                "no_number": sum(1 for t in arm_rows if t.issue_number is None),
            }
        wave_summaries.append({
            "wave": w.wave,
            "path": w.path,
            "repository": w.repository,
            "split": w.split or None,
            "rows": len(wtasks),
            "merged": sum(1 for t in wtasks if t.in_sample),
            "reassigned": sum(1 for t in wtasks if t.reassigned),
            "parity": parity_by_arm,
        })

    non_reassigned_all = [t for t in tasks if not t.reassigned]
    reassigned_all = [t for t in tasks if t.reassigned]

    by_cell: dict[tuple[str, Arm], list[Task]] = collections.defaultdict(list)
    for t in non_reassigned_all:
        by_cell[(t.group, t.arm)].append(t)

    group_order = [*GROUP_NAMES, UNTIERED]
    cells: list[dict[str, Any]] = []
    host_sections: list[dict[str, Any]] = []
    readings: list[dict[str, Any]] = []

    for gname in group_order:
        arms_in_group = sorted({arm for grp, arm in by_cell if grp == gname}, key=lambda a: (a.transport, a.kind, a.model))
        group_arm_hosts: list[dict[str, int]] = []
        group_merged_by_arm: dict[str, int] = {}
        for arm in arms_in_group:
            rows_here = by_cell[(gname, arm)]
            sample = [t for t in rows_here if t.in_sample]
            hosts = _host_counts(sample)
            group_arm_hosts.append(hosts)
            group_merged_by_arm[arm.label] = len(sample)

            ao_counts = {
                "clean": sum(1 for t in sample if t.at_open_word == "clean"),
                "suggestions": sum(1 for t in sample if t.at_open_word == "suggestions"),
                "blocking": sum(1 for t in sample if t.at_open_word == "blocking"),
                "unreadable": sum(1 for t in sample if t.at_open_word == "unreadable"),
                "missing": sum(1 for t in sample if t.at_open_word is None),
            }
            ao_reviewed = [t for t in sample if t.at_open_word in ("clean", "suggestions", "blocking")]
            findings_blocking = sum(t.at_open_blocking or 0 for t in ao_reviewed)
            findings_suggestions = sum(t.at_open_suggestions or 0 for t in ao_reviewed)

            cells.append({
                "group": gname,
                "arm": arm.as_dict(),
                "rows": len(rows_here),
                "merged": len(sample),
                "at_open": ao_counts,
                "findings": {
                    "blocking": findings_blocking,
                    "suggestions": findings_suggestions,
                    "reviewed": len(ao_reviewed),
                    "total": len(sample),
                },
                "confirm": {
                    "rounds": sum(t.confirm_rounds for t in sample),
                    "not_cleared": sum(t.confirm_not_cleared for t in sample),
                    "tasks_with_confirm": sum(1 for t in sample if t.confirm_rounds > 0),
                },
                "review_rounds": _rounds_summary(sample),
                "counters": {name: _counter_summary(sample, name) for name in COUNTERS},
                "launch_to_merge_hours": _duration_summary([t.launch_to_merge_hours for t in sample], len(sample)),
                "open_to_merge_hours": _duration_summary([t.open_to_merge_hours for t in sample], len(sample)),
                "hosts": hosts,
            })

        if arms_in_group:
            balance = host_balance(group_arm_hosts)
            host_sections.append({
                "group": gname,
                "balance": balance,
                "arms": [{"arm": arm.label, "merged": group_merged_by_arm[arm.label], "hosts": h}
                         for arm, h in zip(arms_in_group, group_arm_hosts)],
            })

        if gname != UNTIERED:
            complete_by_label = {arm.label: arm.complete for arm in arms_in_group}
            at_ten = {k: v for k, v in group_merged_by_arm.items() if complete_by_label[k] and v >= READY}
            below_ten = {k: v for k, v in group_merged_by_arm.items() if complete_by_label[k] and v < READY}
            unidentified = {k: v for k, v in group_merged_by_arm.items() if not complete_by_label[k]}
            readings.append({
                "group": gname,
                "ready": len(at_ten) >= 2,
                "threshold": READY,
                "at_ten": at_ten,
                "below_ten": below_ten,
                "unidentified": unidentified,
            })

    untiered_rows = [t for t in non_reassigned_all if t.group == UNTIERED]
    untiered_summary = {
        "rows": len(untiered_rows),
        "merged": sum(1 for t in untiered_rows if t.in_sample),
    }

    return {
        "version": VERSION,
        "threshold": READY,
        "github_skipped": no_github,
        "waves": wave_summaries,
        "readings": readings,
        "untiered": untiered_summary,
        "host_distribution": host_sections,
        "cells": cells,
        "reassigned": [
            {
                "wave": t.wave,
                "task": t.task,
                "tier": t.tier,
                "group": t.group,
                "arm": t.arm.label,
                "phase": t.phase,
                "agent_host": t.agent_host,
                "pr": t.pr,
                "reason": t.reassignment_reason,
            }
            for t in reassigned_all
        ],
        "tasks": [t.as_dict() for t in tasks],
        "notes": notes,
        "errors": errors,
    }


# --- Markdown rendering ---------------------------------------------------------------------------

def _cell_text(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def _fmt_hosts(hosts: dict[str, int]) -> str:
    if not hosts:
        return "-"
    return ", ".join(f"{host}={count}" for host, count in hosts.items())


def _fmt_counter(info: dict[str, Any]) -> str:
    n, total = int(info["n"]), int(info["total"])
    partial_n = int(info["partial_n"])
    if total == 0:
        return "-"
    if n == 0:
        if partial_n:
            return f"0/{total} (+{partial_n}p)"
        return f"missing (0/{total})"
    base = f"{info['sum']} ({info['median']:g})"
    tags: list[str] = []
    if n < total:
        tags.append(f"{n}/{total}")
    if partial_n:
        tags.append(f"+{partial_n}p")
    return f"{base} [{', '.join(tags)}]" if tags else base


def _fmt_rounds(info: dict[str, Any], github_skipped: bool) -> str:
    total = int(info["total"])
    if total == 0:
        return "-"
    if github_skipped or int(info["skipped_n"]) == total:
        return "skipped"
    n = int(info["n"])
    if n == 0:
        return f"unread (0/{total})" if int(info["unread_n"]) else f"missing (0/{total})"
    base = f"{info['median']:g} ({info['mean']:g})"
    return f"{base} [{n}/{total}]" if n < total else base


def _fmt_duration(info: dict[str, Any], github_skipped: bool) -> str:
    total = int(info["total"])
    if total == 0:
        return "-"
    if github_skipped:
        return "skipped"
    n = int(info["n"])
    if n == 0:
        return f"missing (0/{total})"
    base = f"{info['median']:.2f} ({info['min']:.2f}-{info['max']:.2f})"
    return f"{base} [{n}/{total}]" if n < total else base


def render_markdown(doc: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    github_skipped = bool(doc["github_skipped"])

    lines.append("## Waves")
    lines.append("")
    lines.append("| wave | repository | split | rows | merged | reassigned | parity (odd/even/no-num) |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: | --- |")
    for w in cast(list[dict[str, Any]], doc["waves"]):
        split_label = str(w["split"]) if w["split"] else "not declared"
        parity_parts: list[str] = []
        for arm_label, counts in cast(dict[str, dict[str, int]], w["parity"]).items():
            extra = f"/{counts['no_number']}" if counts["no_number"] else ""
            parity_parts.append(f"{arm_label}: {counts['odd']}/{counts['even']}{extra}")
        parity_text = "; ".join(parity_parts) if parity_parts else "-"
        lines.append(
            f"| {_cell_text(str(w['wave']))} | {_cell_text(str(w['repository']))} | {_cell_text(split_label)} |"
            f" {w['rows']} | {w['merged']} | {w['reassigned']} | {_cell_text(parity_text)} |"
        )

    lines.extend(["", "## Readings (ten merged per arm)", ""])
    for r in cast(list[dict[str, Any]], doc["readings"]):
        at_ten = cast(dict[str, int], r["at_ten"])
        below_ten = cast(dict[str, int], r["below_ten"])
        unidentified = cast(dict[str, int], r.get("unidentified") or {})
        parts: list[str] = []
        if at_ten:
            parts.append("at ten: " + ", ".join(f"{k} {v}" for k, v in at_ten.items()))
        if below_ten:
            parts.append("below ten: " + ", ".join(f"{k} {v} of {r['threshold']}" for k, v in below_ten.items()))
        if unidentified:
            parts.append("unidentified (excluded): " + ", ".join(f"{k} {v}" for k, v in unidentified.items()))
        detail = "; ".join(parts) if parts else "no merged tasks"
        status_word = "at ten" if r["ready"] else "below ten (a description)"
        lines.append(f"READING {r['group']}: {status_word} — {detail}")
    untiered = cast(dict[str, int], doc["untiered"])
    if untiered["rows"]:
        lines.append(
            f"untiered: {untiered['merged']} merged ({untiered['rows']} rows) excluded from tier-group thresholds"
        )

    lines.extend(["", "## Agent host distribution (read before launch-to-merge)", ""])
    host_sections = cast(list[dict[str, Any]], doc["host_distribution"])
    if host_sections:
        lines.append("| group | balance | arm | merged | agent_host counts |")
        lines.append("| --- | --- | --- | ---: | --- |")
        for sec in host_sections:
            for item in cast(list[dict[str, Any]], sec["arms"]):
                lines.append(
                    f"| {_cell_text(str(sec['group']))} | {sec['balance']} | {_cell_text(str(item['arm']))} |"
                    f" {item['merged']} | {_cell_text(_fmt_hosts(cast(dict[str, int], item['hosts'])))} |"
                )
    else:
        lines.append("(no rows)")

    lines.extend(["", "## Comparison", ""])
    cells = cast(list[dict[str, Any]], doc["cells"])
    if cells:
        lines.append(
            "| group | arm | rows | merged | at-open c/s/b/u/- | findings b/s | confirm tot(blk) |"
            " rounds med(mean) | interv sum(med) | routine sum(med) | relaunch sum(med) |"
            " launch→merge h | open→merge h | hosts |"
        )
        lines.append("| --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for cell in cells:
            arm_label = str(cast(dict[str, Any], cell["arm"])["label"])
            ao = cast(dict[str, int], cell["at_open"])
            ao_str = f"{ao['clean']}/{ao['suggestions']}/{ao['blocking']}/{ao['unreadable']}/{ao['missing']}"
            fnd = cast(dict[str, int], cell["findings"])
            fnd_str = f"{fnd['blocking']}/{fnd['suggestions']}" if fnd["reviewed"] else "-"
            cf = cast(dict[str, int], cell["confirm"])
            cf_str = f"{cf['rounds']}({cf['not_cleared']})" if cf["rounds"] else "0"
            counters = cast(dict[str, dict[str, Any]], cell["counters"])
            lines.append(
                f"| {_cell_text(str(cell['group']))} | {_cell_text(arm_label)} | {cell['rows']} | {cell['merged']} |"
                f" {ao_str} | {fnd_str} | {cf_str} |"
                f" {_fmt_rounds(cast(dict[str, Any], cell['review_rounds']), github_skipped)} |"
                f" {_fmt_counter(counters['interventions'])} |"
                f" {_fmt_counter(counters['routine_answers'])} |"
                f" {_fmt_counter(counters['relaunches'])} |"
                f" {_fmt_duration(cast(dict[str, Any], cell['launch_to_merge_hours']), github_skipped)} |"
                f" {_fmt_duration(cast(dict[str, Any], cell['open_to_merge_hours']), github_skipped)} |"
                f" {_cell_text(_fmt_hosts(cast(dict[str, int], cell['hosts'])))} |"
            )
    else:
        lines.append("(no non-reassigned rows)")

    reassigned = cast(list[dict[str, Any]], doc["reassigned"])
    lines.extend(["", "## Reassigned rows", ""])
    if reassigned:
        lines.append("| wave | task | tier | arm | phase | agent_host | pr | reason |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for item in reassigned:
            lines.append(
                f"| {_cell_text(str(item['wave']))} | {_cell_text(str(item['task']))} |"
                f" {_cell_text(str(item['tier'] or '-'))} | {_cell_text(str(item['arm']))} |"
                f" {_cell_text(str(item['phase']))} | {_cell_text(str(item['agent_host'] or '-'))} |"
                f" {_cell_text(str(item['pr'] or '-'))} | {_cell_text(str(item['reason'] or '-'))} |"
            )
    else:
        lines.append("None.")

    notes = cast(list[str], doc["notes"])
    if notes:
        lines.extend(["", "## Notes", ""])
        for note in notes:
            lines.append(f"- {note}")

    errors = cast(list[dict[str, str]], doc["errors"])
    if errors:
        lines.extend(["", "## Errors", ""])
        for item in errors:
            where = item.get("pr") or item.get("path") or item.get("wave") or item.get("source", "?")
            lines.append(f"- [{item.get('source', '?')}] {where}: {item.get('why', '')}")

    return lines


# --- entry point ----------------------------------------------------------------------------------

def cmd_ab(cfg: Config, args: list[str]) -> int:
    paths, as_json, no_github = parse_args(args)
    waves = load_waves(paths)

    boards: list[tuple[Wave, list[dict[str, Any]]]] = []
    for w in waves:
        raw_doc = board_status(cfg, w.wave)
        if raw_doc == 4:
            return 4
        if raw_doc == NO_BOARD_EXIT:
            err(f"WAVE AB REFUSED: wave {w.wave} has no board on {cfg.anchor}")
            return 1
        if isinstance(raw_doc, int):
            err(f"WAVE AB REFUSED: board of wave {w.wave} could not be read")
            return 1
        projected = wave_of(raw_doc)
        boards.append((w, cast(list[dict[str, Any]], projected["tasks"])))

    errors: list[dict[str, str]] = []
    notes: list[str] = []
    if no_github:
        notes.append("GitHub PR reads skipped (--no-github); review rounds and merge durations are omitted")

    reviews_by_wave: dict[str, list[ReviewRecord]] = {w.wave: read_reviews(w, errors) for w, _ in boards}

    targets: list[tuple[str, int]] = []
    if not no_github:
        seen_targets: set[tuple[str, int]] = set()
        for _, rows in boards:
            for row in rows:
                phase = text_or_none(row.get("phase")) or "unknown"
                reason = text_or_none(row.get("reassignment_reason"))
                if phase != "merged" or reason is not None:
                    continue
                repo = text_or_none(row.get("repository"))
                pr_raw = text_or_none(row.get("pr"))
                if repo and pr_raw and REPO_NAME.fullmatch(repo) and PR_NUMBER.fullmatch(pr_raw):
                    key = (repo, int(pr_raw))
                    if key not in seen_targets:
                        seen_targets.add(key)
                        targets.append(key)
        targets.sort()

    github = read_github_prs(cfg, targets, errors) if not no_github else {}

    all_tasks: list[Task] = []
    for w, rows in boards:
        all_tasks.extend(join_wave(w, rows, reviews_by_wave[w.wave], github, no_github, notes))

    doc = build_document(waves, all_tasks, no_github, notes, errors)
    if as_json:
        cli.say(json.dumps(doc, ensure_ascii=False, indent=2))
    else:
        cli.say("\n".join(render_markdown(doc)))
    return 3 if errors else 0


# Sanity guard so module import keeps GROUPS aligned with waveprep.TIERS.
assert set(TIER_TO_GROUP) == set(TIERS), f"GROUPS must partition TIERS: {set(TIER_TO_GROUP)} != {set(TIERS)}"
