"""``pr-review.sh base [owner/name] [branch] [--wait[=s]] [--interim] [--integration-records f]``

Is the base branch's CI green? Ported from the shell's ``cmd_base`` and the helpers only it uses
(ludics-lite#403): ``base_red_detail``, ``base_page_judged``, ``base_push_trigger``, the
paths-ignore settle (``range_files``, ``commit_files``, ``commits_ignored``,
``tip_within_paths_ignore``), and the two named sources of a tip no push run judges
(``tip_pr_head_verdict``, ``tip_named_source``). The shell's comments carry the incident history
of every rule here; this file keeps the load-bearing ones, and the shell region they came from
(``cmd_base`` and the helpers above it, in ship-pr/scripts/pr-review.sh at c856bb0, the v2 branch
point) is where to read the rest. The helpers ``base`` shares with ``checks``/``merge`` -- the
workflow-file readers, ``range_files`` and ``commit_files`` (workflows.Reads), the advisory list
(ere.Matcher) and the gate itself (gate.Gate) -- are ported once, there.

WHY ``base`` EXISTS, and why ``--wait``. The other half of ahrefs/ocannl#694: the confusion lands
on whoever branches off a broken master, so the base's own CI is read before work starts, not
only before merging. ``--wait`` is for the other end of a branch's life, the roll-forward
policy's complement: "after a merge, read the base's CI on what you just landed" -- and a plain
``base`` seconds after a merge answers with the PREVIOUS tip's green, because the merge's own run
is queued or not created yet. So ``--wait`` re-reads until nothing non-advisory is mid-flight and
every non-advisory workflow's newest judged run is about the CURRENT tip -- or, with nothing in
flight and NO run for the tip at all, until the workflow's own paths-ignore says none can be
created for this tip (a docs-only push never gets one), or failing that until a grace expires
(SHIP_PR_BASE_ABSENT_GRACE, all that separates "never coming" from "not yet"). Then it settles
for the verdicts in hand, saying which commit each is about. Two absences it will not settle: a
run that EXISTS for the tip and has not judged it (only that run can answer), and a run in flight
anywhere on the branch (it judges a tree the tip contains). A red at the tip breaks the wait at
once: it is a verdict.

Stdout: the verdict line, then one line per workflow (and its notes). Exit: 0 green (an interim
green under --interim included); 1 red; 2 usage or configuration; 3 UNKNOWN (a read the verdict
rests on failed); 4 no verdict (nothing ran, nothing judged the tip, or --wait ran out).

The merged PR head's build signal (source (a)) is ``gate_checks``, the ``checks`` subcommand's
gate (gate.Gate), run as ``tip_pr_head_verdict`` ran it: no wait, under this command's advisory
list, its report captured and its stderr dropped.
"""

import contextlib
import io
import math
import os
import re
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, assert_never

from ludics import cli, proc
from ludics.prreview import jqsem
from ludics.prreview import knobs
from ludics.prreview.ere import Matcher
from ludics.prreview.gate import GateConfig, Gate, load_gate_config
from ludics.prreview.workflows import Reads
from ludics.prreview.checkruns import conclusion_class, newest_first
from ludics.prreview.budget import pause
from ludics.prreview.clock import Clock, FuncClock, age_of, clock_from_env
from ludics.prreview.shtext import encode_ref, tab_fields
from ludics.prreview.workflow_yaml import paths_ignore_covers, workflow_filter, workflow_keys
from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhRefusedOwn,
    GhResult,
    GhSession,
    GhUnanswered,
    Json,
    die,
    fail,
    json_stream,
    repo_from_cwd,
    shell_quote,
    warn,
)

# --- configuration --------------------------------------------------------------------------------

_DEFAULT_ADVISORY = "^(claude|Claude Code|github pages docs)$"
_DIGITS = re.compile(r"[0-9]+")
_HEX = re.compile(r"[0-9a-f]+")


@dataclass(frozen=True)
class Knobs:
    """The source-time constants ``base`` reads beyond the core's: the absence grace and the
    poll's interval, ceiling and heartbeat (whole seconds), and the advisory list as the shell
    resolved it (``BUILD_ADVISORY``: ``base`` never reads a repository's advisory file)."""

    absent_grace: int
    checks_interval: int
    checks_wait: int
    checks_heartbeat: int
    advisory: str


def load_knobs(env: Mapping[str, str]) -> Knobs:
    """The shell's source-time constants ``base`` reads (knobs.py), in the shell's order."""
    grace = knobs.absent_grace(env)
    timing = knobs.checks_timing(env)
    return Knobs(grace, timing.interval, timing.wait, timing.heartbeat, knobs.build_advisory(env))


# --- jq's renderings, which the shell's projections fixed -------------------------------------------


def jq_raw(value: Json) -> str:
    """What ``jq -r`` prints for a scalar (and ``tostring`` returns): a string as itself, null as
    ``null``, a boolean or number as its JSON text."""
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 1e17 else repr(value)
    return _json_text(value)


def _json_text(value: Json) -> str:
    import json

    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def tsv(value: Json) -> str:
    """One ``@tsv`` field: null empty, a string with its tab, newline, CR and backslash escaped."""
    if value is None:
        return ""
    if isinstance(value, str):
        return (
            value.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")
        )
    return jq_raw(value)


def alt(value: Json, default: Json) -> Json:
    """jq's ``value // default``: null and false take the default."""
    return default if value is None or value is False else value


def get(value: Json, *path: str | int) -> Json:
    """``.a.b[0]`` over parsed JSON; anything missing on the way is null."""
    for key in path:
        if isinstance(key, int):
            if not isinstance(value, list) or not -len(value) <= key < len(value):
                return None
            value = value[key]
        else:
            if not isinstance(value, dict):
                return None
            value = value.get(key)
    return value


def _items(value: Json) -> list[Json] | None:
    return value if isinstance(value, list) else None


# The conclusions that are a verdict (conclusion_class red or green).
_JUDGED = frozenset(("failure", "timed_out", "startup_failure", "success", "skipped", "neutral"))


def iso_seconds(text: str) -> float | None:
    """jq's ``fromdateiso8601`` (jqsem's), as epoch seconds, else None."""
    try:
        return float(jqsem.fromdateiso8601(text))
    except jqsem.JqError:
        return None


# --- the rows ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RunRow:
    """One push run as ``BASE_RUN_ROWS`` projected it: every field the text the TSV carried."""

    wid: str
    name: str
    status: str
    conclusion: str
    head_sha: str
    created_at: str
    url: str
    run_id: str
    # ``run_attempt``, 0 when unread: what tells a re-run of a judged run from a stale page
    # (ludics-lite#550). Not one of BASE_RUN_ROWS's fields, so not in ``line``.
    attempt: int = 0

    def line(self) -> str:
        return "\t".join((self.wid, self.name, self.status, self.conclusion, self.head_sha,
                          self.created_at, self.url, self.run_id))


def _run_row(run: Json) -> RunRow:
    return RunRow(
        wid=jq_raw(get(run, "workflow_id")),
        name=tsv(get(run, "name")),
        status=tsv(get(run, "status")),
        conclusion=tsv(alt(get(run, "conclusion"), "pending")),
        head_sha=tsv(get(run, "head_sha")),
        created_at=tsv(get(run, "created_at")),
        url=tsv(alt(get(run, "html_url"), "-")),
        run_id=jq_raw(get(run, "id")),
        attempt=_attempt(get(run, "run_attempt")),
    )


def _attempt(value: Json) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def page_judged(rows: Sequence[RunRow]) -> bool:
    """``base_page_judged``: a row that JUDGED the branch -- completed, red or green."""
    return any(r.status == "completed" and r.conclusion in _JUDGED for r in rows)


def _deeper_stale(first: Sequence[RunRow], deeper: Sequence[RunRow]) -> list[str]:
    """Where a workflow's hundred-deep page is OLDER than the page of ten read just before it: a
    run of the first page that the deeper one lacks, reads at an earlier ``run_attempt``, or reads
    unfinished or with another conclusion at the same attempt. Runs only accumulate, and a hundred
    rows hold the newest ten, so a fresh deeper read has every one of them, as new or newer."""
    by_id = {r.run_id: r for r in deeper}
    stale: list[str] = []
    for r in first:
        d = by_id.get(r.run_id)
        if d is None:
            stale.append(f"run {r.run_id} on the page of ten is not on the deeper page")
        elif d.attempt < r.attempt:
            stale.append(f"run {r.run_id} reads at attempt {d.attempt} on the deeper page, {r.attempt}"
                         " on the page of ten")
        elif (d.attempt == r.attempt and r.status == "completed"
              and (d.status != "completed" or d.conclusion != r.conclusion)):
            stale.append(f"run {r.run_id} reads {d.status}/{d.conclusion} on the deeper page,"
                         f" {r.status}/{r.conclusion} on the page of ten")
    return stale


def page_green(rows: Sequence[RunRow]) -> bool:
    """A row that judged the branch GREEN: what bounds a red streak from below. A full page without
    one is read deeper, a page that judged nothing included."""
    return any(r.status == "completed" and conclusion_class(r.conclusion) == "green" for r in rows)


@dataclass(frozen=True)
class Folded:
    """One workflow of the fold: its newest run at all, newest COMPLETED run, and newest JUDGED
    run ("-" or "pending" where it has none), keyed by the workflow id."""

    name: str
    status: str
    sha: str
    concl: str
    csha: str
    cwhen: str
    curl: str
    vconcl: str
    vsha: str
    vwhen: str
    vurl: str
    wfid: str


def fold(rows: Sequence[RunRow]) -> list[Folded]:
    """The awk fold over the assembled rows, grouped by workflow id in order of first sight."""
    order: list[str] = []
    first: dict[str, RunRow] = {}
    done: dict[str, RunRow] = {}
    judged: dict[str, RunRow] = {}
    for r in rows:
        if r.wid == "":
            continue
        if r.wid not in first:
            first[r.wid] = r
            order.append(r.wid)
        if r.status == "completed" and r.wid not in done:
            done[r.wid] = r
        if r.status == "completed" and r.wid not in judged and r.conclusion in _JUDGED:
            judged[r.wid] = r
    out: list[Folded] = []
    for k in order:
        f, c, v = first[k], done.get(k), judged.get(k)
        out.append(Folded(
            name=f.name, status=f.status, sha=f.head_sha,
            concl=c.conclusion if c else "pending", csha=c.head_sha if c else "-",
            cwhen=c.created_at if c else "-", curl=c.url if c else "-",
            vconcl=v.conclusion if v else "-", vsha=v.head_sha if v else "-",
            vwhen=v.created_at if v else "-", vurl=v.url if v else "-", wfid=k,
        ))
    return out


@dataclass(frozen=True)
class Record:
    """One integration record ``fleet-worker.sh gate`` handed in."""

    sha: str
    verdict: str
    rid: str
    when: str

    def line(self) -> str:
        return "\t".join((self.sha, self.verdict, self.rid, self.when))


_RECORD_SHA = re.compile(r"[0-9a-f]{40}")
_RECORD_RID = re.compile(r"[A-Za-z0-9._-]+")
_RECORD_WHEN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]+")


def load_records(path: str) -> list[Record]:
    """The ``--integration-records`` file, every row validated before any is believed: a row this
    cannot read is refused WHOLE (exit 2), never skipped -- a skipped red would leave an older
    source to answer for the tip."""
    if not (os.path.isfile(path) and os.access(path, os.R_OK)):
        die(f"base: --integration-records: cannot read '{path}'")
    try:
        with open(path, "rb") as handle:
            text = proc.decode(handle.read())
    except OSError:
        die(f"base: --integration-records: cannot read '{path}'")
    lines = text.split("\n")
    records: list[Record] = []
    for index, line in enumerate(lines):
        last = index == len(lines) - 1
        sha, verdict, rid, when = tab_fields(line, 4)
        # `read || [ -n "$rsha" ]`: an unterminated last line is a row when it has a first field.
        if last and not sha:
            continue
        if not (sha + verdict + rid + when):
            continue
        if not (_RECORD_SHA.fullmatch(sha) and verdict in ("pass", "fail")
                and _RECORD_RID.fullmatch(rid) and _RECORD_WHEN.fullmatch(when)):
            die("base: --integration-records: a row is not <sha> <pass|fail> <request id> <concluded at>,"
                f" tab-separated: {shell_quote(sha + chr(9) + verdict + chr(9) + rid + chr(9) + when)}")
        records.append(Record(sha, verdict, rid, when))
    return records


# --- the named sources ------------------------------------------------------------------------------
# A default branch without push CI (ludics-lite#401). A workflow that used to run on pushes to this
# branch and whose file at the tip no longer declares `push` leaves its push runs standing
# forever: `event=push` pages never age out, so the fold would keep presenting the last push run's
# verdict -- days or months old -- as the base's. A stale green is worse than none. So such a
# workflow's push rows are not read as a verdict at all, and the tip's verdict for it comes only
# from a source this file can NAME, in this order:
#
#   (b) an INTEGRATION RECORD: a wave coordinator's own run concluded at exactly the tip, handed in
#       by `fleet-worker.sh gate` as `--integration-records <file>`. About the tip's own tree, so
#       it goes first, and a failed one is RED.
#   (a) the MERGED PR'S HEAD RUN under the roll-forward rule: the tip is GitHub's own merge commit
#       of one merged pull request into this branch, its second parent is that PR's head, and the
#       head's build signal -- the one `merge` gated on -- is green (or red).
#
# Anything else is "no verdict", never an older green. Source (c), the latest daily sweep record
# at or after the tip, has no machine-readable form on this side and is not read (#414).
#
# "Clean merge" is established from the commit, not assumed: exactly two parents, committed by
# GitHub itself (`noreply@github.com`) with a signature GitHub verified. GitHub makes a merge
# commit only for a PR it can merge without conflict, so its own merge carries nothing the head did
# not; a merge made elsewhere can carry a resolution the head's run never saw, and a squash or a
# rebase keeps no head in the history at all. The workflows the verdict is FOR must each have a run
# of their own at the head that concluded `success` with a non-advisory job that succeeded: the
# head's build signal is an aggregate, and on a docs-only PR the retired `ci` is filtered out by
# its `pull_request` paths-ignore while another workflow passes (review rounds 1 and 2).

type SourceVerdict = Literal["green", "red", "pending", "none"]


@dataclass(frozen=True)
class TipPr:
    """``tip_pr_head_verdict``'s TIP_PR_*: the verdict, the sentence naming its source or why there
    is none, and the PR and head when one was found."""

    verdict: SourceVerdict
    why: str
    num: str = ""
    head: str = ""


@dataclass(frozen=True)
class Source:
    """``tip_named_source``'s SRC_*: the verdict, the sentence, the source in a few words."""

    verdict: SourceVerdict
    why: str
    name: str


@dataclass(frozen=True)
class Trigger:
    """``base_push_trigger``'s answer: whether the workflow's file AT THE TIP declares ``push``
    (``pushless``: read, parsed, and names no push; ``unparsed``: read and refused by the narrow
    reader; ``absent``: established not to be at the tip), and the file's text."""

    kind: Literal["push", "pushless", "unparsed", "absent"]
    body: str


@dataclass(frozen=True)
class GateSignal:
    """What ``gate_checks`` leaves for ``tip_pr_head_verdict``: its VERDICT and its ``build
    signal`` line."""

    verdict: str
    line: str


# ``gate_checks <pr> 0`` for source (a); None when it ended without a verdict. Injectable for the
# unit tests, which judge the named sources without fixturing a whole gate.
type GateRunner = Callable[[str], GateSignal | None]
type Want = tuple[str, str]  # (workflow id, display name)


# --- the clock --------------------------------------------------------------------------------------


# --- one `base` invocation --------------------------------------------------------------------------


@dataclass
class _Round:
    """What one round of the wait read and folded: the counts its breaks read, each workflow's
    rows as read (``by_wid``, a workflow read with no rows included), the pages as gh answered
    them (``pages``), and why the round contradicts an earlier one (``inconsistent``,
    ludics-lite#550), which no settle accepts."""

    out: str = ""
    red: int = 0
    pend: int = 0
    inflight: int = 0
    uncovered: int = 0
    red_at_tip: int = 0
    nogo_at_tip: int = 0
    norun: int = 0
    tip_unjudged: int = 0
    unrun: list[tuple[str, str, str]] = field(default_factory=lambda: [])
    pushless: list[Want] = field(default_factory=lambda: [])
    src_pending: bool = False
    src_none: bool = False
    tipfly: list[Want] = field(default_factory=lambda: [])
    uncov_nofly: int = 0
    pend_fly: int = 0
    norun_ids: list[Want] = field(default_factory=lambda: [])
    exhausted_wids: set[str] = field(default_factory=lambda: set())
    exhausted: list[str] = field(default_factory=lambda: [])
    folded: list[Folded] = field(default_factory=lambda: [])
    by_wid: dict[str, list[RunRow]] = field(default_factory=lambda: {})
    names: dict[str, str] = field(default_factory=lambda: {})
    pages: list[tuple[str, str]] = field(default_factory=lambda: [])
    inconsistent: list[str] = field(default_factory=lambda: [])

    @property
    def pushless_names(self) -> str:
        return ", ".join(name for _, name in self.pushless)

    @property
    def tipfly_names(self) -> str:
        return ", ".join(name for _, name in self.tipfly)


class Base:
    """The reads ``base`` makes, and what it remembers across the rounds of one ``--wait``: the
    red runs' job lines, the workflows' push triggers at a tip, and the paths-ignore answers."""

    def __init__(
        self,
        session: GhSession,
        knobs: Knobs,
        repo: str,
        *,
        clock: Clock | FuncClock | None = None,
        gate_config: GateConfig | None = None,
        gate: GateRunner | None = None,
        records: Sequence[Record] = (),
    ) -> None:
        self.session = session
        self.knobs = knobs
        self.repo = repo
        self.clock: Clock | FuncClock = clock if clock is not None else clock_from_env(os.environ)
        self.gate_config = gate_config if gate_config is not None else load_gate_config(os.environ)
        self._gate: GateRunner = gate if gate is not None else self._gate_checks
        self.records = list(records)
        self.is_advisory = Matcher(knobs.advisory)
        # The workflow-file readers and the paths-ignore walk, shared with checks/merge.
        self.reads = Reads(session, repo, self.gate_config.limits, self.is_advisory)
        self._jobs_cache: dict[str, str] = {}
        self._trigger_cache: dict[str, Trigger] = {}
        self._ignore_cache: dict[str, bool] = {}

    # --- gh ---

    def gh(self, args: Sequence[str]) -> GhResult:
        """A READ through the session's retry policy."""
        return self.session.retry("read", args)

    def err_line(self) -> str:
        """``gh_err_line``: the last failed read's first stderr line (the gate's reads included)."""
        return self.session.err_line()

    def gh_json(self, args: Sequence[str]) -> Json | GhFailed | GhUnanswered:
        """A read answered with one JSON document. A body that does not parse is a failure
        (``--jq`` erroring made gh fail in the shell)."""
        result = self.gh(args)
        match result:
            case GhFailed() | GhUnanswered():
                return result
            case GhOk(stdout=out):
                docs = json_stream(out)
                if docs is None or len(docs) != 1:
                    return GhFailed()
                return docs[0]
            case _:
                assert_never(result)

    def gh_pages(self, args: Sequence[str]) -> list[Json] | GhFailed | GhUnanswered:
        """A ``--paginate`` read: one JSON document per page."""
        result = self.gh(args)
        match result:
            case GhFailed() | GhUnanswered():
                return result
            case GhOk(stdout=out):
                docs = json_stream(out)
                return GhFailed() if docs is None else docs
            case _:
                assert_never(result)

    def tip_sha(self, ebranch: str) -> str:
        """The branch tip, or "" when it could not be read."""
        doc = self.gh_json(["api", f"repos/{self.repo}/commits/{ebranch}"])
        if isinstance(doc, (GhFailed, GhUnanswered)):
            return ""
        return jq_raw(get(doc, "sha")) if isinstance(doc, dict) else ""

    def workflow_list(self) -> list[Want] | None:
        doc = self.gh_json(["api", f"repos/{self.repo}/actions/workflows?per_page=100"])
        if isinstance(doc, (GhFailed, GhUnanswered)):
            return None
        items = _items(get(doc, "workflows"))
        if items is None:
            return None
        return [(jq_raw(get(w, "id")), tsv(get(w, "name"))) for w in items]

    def runs_page(self, wid: str, ebranch: str, per_page: int,
                  keep: list[tuple[str, str]] | None = None) -> list[RunRow] | None:
        """One workflow's push runs on the branch, a page of ``per_page``; the endpoint and the
        page as gh answered it are appended to ``keep`` (the round's evidence, ludics-lite#550)."""
        endpoint = (f"repos/{self.repo}/actions/workflows/{wid}/runs"
                    f"?branch={ebranch}&event=push&per_page={per_page}")
        result = self.gh(["api", endpoint])
        match result:
            case GhFailed() | GhUnanswered():
                return None
            case GhOk(stdout=out):
                pass
            case _:
                assert_never(result)
        if keep is not None:
            keep.append((endpoint, out))
        docs = json_stream(out)
        if docs is None or len(docs) != 1:
            return None
        runs = _items(get(docs[0], "workflow_runs"))
        if runs is None:
            return None
        return [_run_row(r) for r in runs]

    # --- the red report ---

    def red_detail(self, wfid: str, rows: Sequence[RunRow]) -> str:
        """``base_red_detail``: WHICH job failed and WHERE the red started, as indented notes for
        the RED line (ludics-lite#73). Decoration on a verdict already reached: a failed jobs read
        prints UNKNOWN and leaves the red standing, and is not remembered."""
        indent = "           "
        run_id = first_sha = first_when = ""
        floor: RunRow | None = None
        reds = 0
        for r in rows:
            if r.wid != wfid or r.status != "completed":
                continue
            klass = conclusion_class(r.conclusion)
            if klass == "red":
                reds += 1
                run_id = run_id or r.run_id
                first_sha, first_when = r.head_sha, r.created_at
            elif klass == "green":
                floor = r
                break
        if reds == 0:
            return ""
        if floor is not None:
            # The floor's commit is the lower end of the span to attribute (ludics-lite#597): the
            # merges between it and the first red run judged nothing of their own (a push group
            # that keeps only the newest pending run cancels theirs). Named, never asserted as a
            # range: the feed orders runs by creation, not by ancestry, and a branch that was
            # force-pushed or recreated can put the floor on another history (review round 1).
            detail = (f"{indent}red since {first_sha[:8]} (run created {first_when}), {reds} run(s)"
                      f" back; the judged run before it was not red ({floor.conclusion} at"
                      f" {floor.head_sha[:8]})\n")
        else:
            detail = (f"{indent}red for all {reds} judged run(s) in the window, back to"
                      f" {first_sha[:8]} (run created {first_when}) — the window holds no\n"
                      f"{indent}green under it, so the red may start further back\n")
        if not _DIGITS.fullmatch(run_id):
            return detail
        cached = self._jobs_cache.get(run_id)
        if cached is not None:
            return detail + cached + "\n"
        pages = self.gh_pages(["api", "--paginate",
                               f"repos/{self.repo}/actions/runs/{run_id}/jobs?per_page=100"])
        if isinstance(pages, (GhFailed, GhUnanswered)):
            return (detail + f"{indent}which job failed is UNKNOWN ({self.err_line()}) — the red above"
                    " stands; open the run\n")
        failed: list[str] = []
        for page in pages:
            for job in _items(get(page, "jobs")) or []:
                name = tsv(get(job, "name"))
                concl = tsv(alt(get(job, "conclusion"), "pending"))
                if name and conclusion_class(concl) == "red":
                    failed.append(f"{name} ({concl})")
        if failed:
            line = f"{indent}failed job(s): {', '.join(failed)}"
        else:
            line = f"{indent}no job in that run concluded red — a startup or workflow-level failure"
        self._jobs_cache[run_id] = line
        return detail + line + "\n"

    # --- the workflow file ---

    def push_trigger(self, wid: str, tip: str) -> Trigger | None:
        """``base_push_trigger``: does this workflow's file AT THE TIP declare ``push`` at all
        (ludics-lite#401)? None is UNKNOWN (exit 3 at the caller), not remembered: a transport
        failure, and any refusal of the API's (403, 401, or a 404 the directory listing does not
        confirm), since a token that may read Actions but not the file would otherwise pass for a
        file with no trigger to read.

        BOUNDARY, as a fail-closed allowlist: ``pushless`` is claimed only for a file that was read
        whole and whose ``on:`` block the narrow reader parsed and found without ``push`` in any of
        its three forms (mapping, scalar, flow). ``unparsed`` and ``absent`` are read as a push
        workflow, exactly as before #401, and so is a ``push`` whose ``branches:`` filter does not
        reach this branch, which this does not evaluate (#176: what a push filter reaches is not
        answerable from these feeds). An ABSENT file is claimed only when the directory at the tip
        was read and does not hold it: a workflow the tip deleted (or a dynamic one, like Pages'
        ``dynamic/pages/...``, which has no file) keeps the reading it had before #401."""
        key = f"{wid}/{tip}"
        hit = self._trigger_cache.get(key)
        if hit is not None:
            return hit
        kind: Literal["push", "pushless", "unparsed", "absent"] = "unparsed"
        path = self.reads.workflow_path(wid)
        if path is None:
            return None
        body = self.reads.workflow_body(path, tip)
        if body is None:
            # The last read's own error: one that SUCCEEDED with an empty body cleared it.
            if "HTTP 404" not in self.session.err_line():
                return None
            files = self.reads.workflow_files_at(tip)
            if files is None or path in files:
                return None
            kind, body = "absent", ""
        else:
            events = workflow_keys(body)
            if events is not None:
                kind = "push" if "push" in events else "pushless"
        trigger = Trigger(kind, body)
        self._trigger_cache[key] = trigger
        return trigger

    # --- the paths-ignore settle ---

    def tip_within_paths_ignore(self, unrun: Sequence[tuple[str, str, str]], tip: str) -> str | None:
        """``tip_within_paths_ignore``: every workflow trailing the tip with no run at it is
        explained by its OWN push filter. The workflows' names joined (PATHS_IGNORE_WHY), or None."""
        if not unrun:
            return None
        why: list[str] = []
        for wfid, name, vsha in unrun:
            if vsha in ("", "-"):
                return None
            key = f"{wfid}/{vsha}/{tip}"
            hit = self._ignore_cache.get(key)
            if hit is None:
                hit = False
                pats: list[str] = []
                trigger = self.push_trigger(wfid, tip)
                if trigger is not None and trigger.body:
                    pats = workflow_filter(trigger.body, "push", "paths-ignore") or []
                if pats:
                    files = self.reads.range_files(vsha, tip)
                    hit = files is not None and paths_ignore_covers(pats, files)
                self._ignore_cache[key] = hit
            if not hit:
                return None
            why.append(name)
        return ", ".join(why)

    # --- the named sources ---

    def _gate_checks(self, num: str) -> GateSignal | None:
        """``gate_checks <num> 0``, as ``tip_pr_head_verdict`` ran it: no wait, under this
        command's advisory list (BUILD_ADVISORY -- ``base`` never reads a repository's advisory
        file), its report captured and its stderr dropped. None where the shell's subshell ended
        without its trailer: the gate ended the command (a usage or configuration exit). A refusal
        of the gate's own gh call (GhRefusedOwn) ends this command too, as it did."""
        gate = Gate(self.session, self.repo, self.gate_config, clock=self.clock, advisory=self.knobs.advisory)
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                gate.check(num, 0)
        except GhRefusedOwn:
            raise
        except cli.Exit:
            return None
        line = next((ln[len("build signal "):] for ln in out.getvalue().split("\n")
                     if ln.startswith("build signal ")), "")
        return GateSignal(gate.verdict, line)

    def tip_pr_head_verdict(self, branch: str, sha: str, wants: Sequence[Want]) -> TipPr | None:
        """``tip_pr_head_verdict``, source (a): the tip is GitHub's own clean merge of one merged
        PR into this branch, and that PR head's build signal (and, for each workflow the verdict is
        FOR, a successful run of it that built something) speaks for it. None is UNKNOWN."""
        if not sha or not _HEX.fullmatch(sha):
            return TipPr("none", "there is no tip SHA to judge")
        doc = self.gh_json(["api", f"repos/{self.repo}/commits/{sha}"])
        if isinstance(doc, (GhFailed, GhUnanswered)):
            return None
        parents = alt(get(doc, "parents"), [])
        n = str(len(parents)) if isinstance(parents, (list, dict, str)) else "0"
        p1 = _field(alt(get(doc, "parents", 1, "sha"), "-"))
        email = _field(alt(get(doc, "commit", "committer", "email"), "-"))
        verified = _field(jq_raw(alt(get(doc, "commit", "verification", "verified"), False)))
        s8 = sha[:8]
        if n != "2":
            return TipPr("none", f"the tip {s8} is not a merge commit ({n} parent(s)), so no PR head's"
                         " run speaks for it")
        if email != "noreply@github.com" or verified != "true":
            return TipPr("none", f"the tip {s8} is a merge commit GitHub did not make (committer {email},"
                         f" verified {verified}), so it may carry a resolution no PR head's run saw")
        pulls = self.gh_json(["api", f"repos/{self.repo}/commits/{sha}/pulls?per_page=100"])
        if isinstance(pulls, (GhFailed, GhUnanswered)) or not isinstance(pulls, list):
            return None
        prs = [(_field(jq_raw(get(p, "number"))), _field(alt(get(p, "head", "sha"), "-")),
                _field(alt(get(p, "base", "ref"), "-")))
               for p in pulls
               if get(p, "merged_at") is not None and get(p, "merge_commit_sha") == sha]
        if len(prs) != 1:
            return TipPr("none", f"no single merged pull request has the tip {s8} as its merge commit")
        num, head, bref = prs[0]
        if not _DIGITS.fullmatch(num):
            return None
        if head != p1 or bref != branch:
            return TipPr("none", f"PR #{num} merged as the tip {s8}, but its head {head[:8]} is not the"
                         f" merge's second parent or it was merged into '{bref}', not '{branch}'")
        signal = self._gate(num)
        if signal is None:
            return None
        verdict: SourceVerdict
        match signal.verdict:
            case "green":
                verdict = "green"
            case "red" | "runred":
                verdict = "red"
            case "pending" | "unjudged":
                verdict = "pending"
            case "mixed" | "absent":
                verdict = "none"
            case _:
                return None
        h8 = head[:8]
        why = (f"PR #{num}'s head {h8}, which GitHub merged cleanly as the tip {s8} (roll-forward rule):"
               f" {signal.line}")
        if verdict != "green" or not wants:
            return TipPr(verdict, why, num, head)
        pages = self.gh_pages(["api", "--paginate",
                               f"repos/{self.repo}/actions/runs?head_sha={head}&per_page=100"])
        if isinstance(pages, (GhFailed, GhUnanswered)):
            return None
        runs = [
            (tsv(alt(get(r, "created_at"), "-")), jq_raw(alt(get(r, "id"), 0)),
             jq_raw(alt(get(r, "workflow_id"), 0)), tsv(alt(get(r, "status"), "-")),
             tsv(alt(get(r, "conclusion"), "pending")))
            for page in pages for r in _items(get(page, "workflow_runs")) or []
        ]
        runs = newest_first(runs, lambda r: r[0], lambda r: r[1], lambda r: "\t".join(r))
        unbuilt: list[str] = []
        rerun: list[str] = []
        for wid, wname in wants:
            row = next((r for r in runs if r[2] == wid), None)
            if row is not None and row[3] != "completed":
                rerun.append(wname)
                continue
            concl = row[4] if row is not None else ""
            if concl != "success" or row is None:
                unbuilt.append(f"{wname} ({concl or 'no run'})")
                continue
            jobs = self.gh_pages(["api", "--paginate",
                                  f"repos/{self.repo}/actions/runs/{row[1]}/jobs?per_page=100"])
            if isinstance(jobs, (GhFailed, GhUnanswered)):
                return None
            built = False
            for page in jobs:
                for job in _items(get(page, "jobs")) or []:
                    jname = tsv(alt(get(job, "name"), "-"))
                    jconcl = tsv(alt(get(job, "conclusion"), "pending"))
                    if not jname or self.is_advisory(jname):
                        continue
                    if jconcl == "success":
                        built = True
            if not built:
                unbuilt.append(f"{wname} (no job succeeded)")
        if unbuilt:
            return TipPr("none", f"PR #{num}'s head {h8}, which GitHub merged cleanly as the tip {s8},"
                         f" has no successful run of {', '.join(unbuilt)}: its green is about other"
                         " workflows", num, head)
        if rerun:
            return TipPr("pending", f"PR #{num}'s head {h8}, which GitHub merged cleanly as the tip {s8},"
                         f" is being re-run by {', '.join(rerun)}", num, head)
        return TipPr(verdict, why, num, head)

    def named_source(self, branch: str, sha: str, wants: Sequence[Want]) -> Source | None:
        """``tip_named_source``: (b) the newest integration record at the tip, by its conclusion
        time, else (a). Nothing is remembered between rounds: a PR head's runs can be re-run."""
        at_tip = [r for r in self.records if r.sha == sha]
        if at_tip:
            at_tip.sort(key=lambda r: r.line().encode("utf-8", "surrogateescape"))
            at_tip.sort(key=lambda r: r.when.encode("utf-8", "surrogateescape"), reverse=True)
            rec = at_tip[0]
            return Source(
                "green" if rec.verdict == "pass" else "red",
                f"source (b): integration record {rec.rid} ran the tip {rec.sha[:8]} and concluded"
                f" {rec.verdict} ({rec.when})",
                f"integration record {rec.rid}",
            )
        tp = self.tip_pr_head_verdict(branch, sha, wants)
        if tp is None:
            return None
        name = f"PR #{tp.num}'s head run (roll-forward rule)"
        if tp.verdict == "none":
            return Source(tp.verdict, f"no integration record ran the tip {sha[:8]}, and {tp.why}", name)
        return Source(tp.verdict, f"source (a): {tp.why}", name)

    # --- the interim's deeper read ---

    def older_runs(self, wid: str, ebranch: str, tip: str) -> tuple[int, str] | None:
        """The hundred-deep read before an interim (ludics-lite#533): how many runs at another
        commit have not completed, and the newest JUDGED conclusion among them ("none")."""
        doc = self.gh_json(["api", f"repos/{self.repo}/actions/workflows/{wid}/runs"
                            f"?branch={ebranch}&event=push&per_page=100"])
        if isinstance(doc, (GhFailed, GhUnanswered)):
            return None
        runs = _items(get(doc, "workflow_runs"))
        if runs is None:
            return None
        others = [r for r in runs if get(r, "head_sha") != tip]
        # `sort_by(.created_at, .id) | reverse`: a stable ascending sort, then the whole list
        # reversed -- ties come out in the reverse of the feed's order, as jq's do.
        others.sort(key=lambda r: (_jq_order(get(r, "created_at")), _jq_order(get(r, "id"))))
        others.reverse()
        unfinished = sum(1 for r in others if get(r, "status") != "completed")
        newest = next((jq_raw(get(r, "conclusion")) for r in others
                       if get(r, "status") == "completed" and get(r, "conclusion") in _JUDGED), "none")
        return unfinished, newest


@dataclass(frozen=True)
class _Seen:
    """A workflow's newest judged run as an earlier round of the wait read it: its order key
    (creation time, then id) and what names it in a note."""

    key: tuple[float, int]
    run_id: str
    sha: str
    attempt: int


def _row_key(r: RunRow) -> tuple[float, int] | None:
    """A run's place in the branch's history: its creation time, a same-second tie to the higher
    id. None when the time does not parse, which no comparison is made on."""
    at = iso_seconds(r.created_at)
    if at is None:
        return None
    return (at, int(r.run_id) if _DIGITS.fullmatch(r.run_id) else 0)


# How many settles' pages the state directory keeps (ludics-lite#550): the newest, by their time.
KEPT_PAGES = 20
_KEPT_NAME = re.compile(r"([0-9]+)\.[0-9]+\..*\.txt")


def _field(value: Json) -> str:
    """The shell's ``map(if type == "string" and length > 0 then . else "-" end) | @tsv``."""
    return tsv(value) if isinstance(value, str) and value else "-"


def _jq_order(value: Json) -> tuple[int, float | str]:
    """jq's sort order: null < false < true < numbers < strings < arrays < objects."""
    if value is None:
        return (0, 0)
    if isinstance(value, bool):
        return (2 if value else 1, 0)
    if isinstance(value, (int, float)):
        return (3, float(value))
    if isinstance(value, str):
        return (4, value)
    return (5 if isinstance(value, list) else 6, _json_text(value))


# --- the command ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Args:
    repo: str
    branch: str
    wait_for: int
    interim: bool
    records: str


def parse_args(args: Sequence[str], repo: str, knobs: Knobs) -> Args:
    """The shell's parse, in its case order: the first SLASHED argument is the repo unless one is
    already named -- branches carry slashes too (``claude/...``)."""
    interim = False
    records = ""
    branch = ""
    wait_text = "0"
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--interim":
            interim = True
        elif arg == "--integration-records":
            if i + 1 >= len(args):
                die("base: --integration-records takes a file")
            records = args[i + 1]
            i += 1
        elif arg.startswith("--integration-records="):
            records = arg[len("--integration-records="):]
        elif "/" in arg:
            if not repo:
                repo = arg
            else:
                branch = arg
        elif arg == "--wait":
            wait_text = str(knobs.checks_wait)
        elif arg.startswith("--wait="):
            wait_text = arg[len("--wait="):]
        elif arg.startswith("-"):
            die(f"base: unknown option '{arg}'")
        else:
            branch = arg
        i += 1
    if not _DIGITS.fullmatch(wait_text):
        die(f"base: --wait takes seconds, got '{wait_text}'")
    return Args(repo, branch, int(wait_text), interim, records)


def run(session: GhSession, args: list[str], *, clock: Clock | FuncClock | None = None,
        gate: GateRunner | None = None, env: Mapping[str, str] | None = None) -> int:
    environ = os.environ if env is None else env
    knobs = load_knobs(environ)
    parsed = parse_args(args, session.config.repo, knobs)
    records = load_records(parsed.records) if parsed.records else []
    grace, interval = knobs.absent_grace, knobs.checks_interval
    wait_for = parsed.wait_for
    # A --wait sized to outlive the grace but not by a whole round gets ONE chance at the settle,
    # and a warning says so (ludics-lite#175). Not a refusal: the last round is scheduled at the
    # ceiling and does reach the settle, when the tip has not moved.
    if grace > 0 and grace < wait_for < grace + interval:
        warn(f"base: --wait={wait_for} is inside the {grace}s absence grace's own round",
             f"(SHIP_PR_BASE_ABSENT_GRACE={grace}, SHIP_PR_CHECKS_INTERVAL={interval}).",
             "It reaches the settle only on the single round scheduled at the ceiling, and only if the",
             "tip has not moved — a tip that moves restamps the grace and no ceiling this close can then",
             "reach it. Size it from the two knobs instead:",
             f"--wait={grace + interval} or more (ludics-lite#175).")
    # A standing quota hold is exit 3 from the resolution itself (repo_from_cwd), never a guess.
    repo = parsed.repo or repo_from_cwd(budget=session.budget) or ""
    if not repo:
        die("base: name the repo — `base owner/name [branch]`, --repo, or REPO=.",
            "cwd inference only works from a checkout, and not from a background shell.")
    base = Base(session, knobs, repo, clock=clock, gate_config=load_gate_config(environ), gate=gate,
                records=records)
    return Wait(base, parsed, records).run()


class Wait:
    """``cmd_base``'s loop: one round per tip read, until a break or, without --wait, once."""

    def __init__(self, base: Base, args: Args, records: Sequence[Record]) -> None:
        self.b = base
        self.args = args
        self.records = list(records)
        self.repo = base.repo
        self.branch = args.branch
        self.ebranch = ""
        self.wf: list[Want] | None = None
        self.last_tip = ""
        self.allruns: list[RunRow] = []
        self.rerounds = 0
        self.interim_name = ""
        self.interim_why = ""
        self.pushless_name = ""
        # What the earlier rounds of this wait saw (ludics-lite#550): each workflow's newest judged
        # run, and the runs each workflow had at a tip.
        self.judged_seen: dict[str, _Seen] = {}
        self.tip_seen: dict[tuple[str, str], set[str]] = {}
        self.attempts_seen: dict[tuple[str, str], int] = {}

    def tip_read(self) -> str:
        return self.b.tip_sha(self.ebranch)

    def run(self) -> int:
        b, repo = self.b, self.repo
        knobs = b.knobs
        grace, wait_for = knobs.absent_grace, self.args.wait_for
        started = b.clock.now()
        # A --wait is the branch's observer in the polling budget (ludics-lite#551): it waits a
        # quota hold out within its ceiling from its first read (the default branch's, when none is
        # named), and it is one per branch, refused before it reads the runs.
        budget = b.session.budget
        if wait_for > 0 and budget is not None:
            budget.wait_from = started
            budget.wait_until = started + wait_for
        if not self.branch:
            doc = b.gh_json(["api", f"repos/{repo}"])
            branch = "" if isinstance(doc, (GhFailed, GhUnanswered)) else jq_raw(get(doc, "default_branch"))
            if not branch:
                fail(3, f"could not read {repo}'s default branch", f"({b.err_line()}) — the base's health"
                     " is UNKNOWN, which is not 'fine'.")
            self.branch = branch
        branch = self.branch
        self.ebranch = encode_ref(branch)
        if wait_for > 0 and budget is not None:
            budget.base_claim(repo, branch)
        cap = budget.build_cap if budget is not None else knobs.checks_interval
        last_sig = ""
        last_pause: int | None = None
        beat = grace_from = started
        waited_note = ""
        no_tip_verdict = False
        interim_green = False
        rnd = _Round()
        tip = ""
        while True:
            rnd = _Round()
            # A round that waits a quota hold out between its reads is two moments, not one: what it
            # read before the hold may have moved by its end. No verdict is taken from such a round;
            # it is read again whole (``held_over``), as the checks gate does.
            if budget is not None:
                budget.waited = False
            # Re-read every round: a push during the wait moves the goal with it.
            tip = self.tip_read()
            if not tip and wait_for != 0:
                fail(3, f"could not read {repo} {branch}'s tip ({b.err_line()}) — base --wait cannot know",
                     "which commit needs the verdict. This is UNKNOWN, not green: retry.")
            # The workflow list is re-read whenever the observed tip moves: a sibling merge can ADD
            # a workflow, and a stale list would never query it.
            if tip != self.last_tip or not self.wf:
                self.wf = b.workflow_list()
                if self.wf is None:
                    fail(3, f"could not read {repo}'s workflow list ({b.err_line()});",
                         "the base's health is UNKNOWN, which is NOT 'green'.")
            # The clock the interim's newcomer hold ages the tip on: taken BEFORE the reads, so an
            # age measured on it can only come out short, which holds longer, never less.
            snap_at = b.clock.now()
            raw = self.read_runs(rnd)
            self.consistency(rnd, tip)
            if not raw:
                rnd.uncovered = 1
            else:
                self.allruns = raw
                self.judge(rnd, tip, raw)
            if rnd.inconsistent:
                rnd.out += ("           (this round's runs page contradicts an earlier round's: "
                            + "; ".join(rnd.inconsistent)
                            + " — a stale read, so nothing is settled on it; read again, ludics-lite#550)\n")
            # An interim green rests on the page as much as a settle does: none on a stale one.
            if self.args.interim and not rnd.inconsistent:
                outcome = self.interim(rnd, tip, snap_at)
                if outcome == "green":
                    interim_green = True
                elif outcome == "reround":
                    self.rerounds += 1
                    if tip != self.last_tip:
                        if self.last_tip:
                            grace_from = b.clock.now()
                        self.last_tip = tip
                    continue
            if interim_green:
                if self.held_over():
                    interim_green = False
                    continue
                break
            if wait_for <= 0:
                break
            # Only a red AT THE TIP ends the wait early, and only once the tip is confirmed.
            if rnd.red_at_tip > 0 and self.tip_read() == tip:
                if self.held_over():
                    continue
                break
            now = b.clock.now()
            # The grace runs from the last time the tip MOVED; the first observation does not
            # restamp it (ludics-lite#156).
            if tip != self.last_tip:
                if self.last_tip:
                    grace_from = now
                self.last_tip = tip
            if rnd.inconsistent:
                # Only a red AT THE TIP (above) and the ceiling (below) end a wait on a round whose
                # page contradicts an earlier one: a stale page can hide the tip's run, and every
                # settle here reads what the page does NOT hold as an answer (ludics-lite#550).
                pass
            elif rnd.inflight == 0 and rnd.uncovered == 0 and not rnd.src_pending:
                # A listed workflow with no push run on the branch: dispatch-only, or one the tip
                # just added -- held until the tip has had that newcomer's creation window.
                hold = False
                if rnd.norun > 0:
                    seen = ""
                    for f in rnd.folded:
                        if f.csha == tip and f.cwhen > seen:
                            seen = f.cwhen
                    age = age_of(seen, b.clock.time())
                    if age is not None and age < grace:
                        hold = True
                if not hold and self.tip_read() == tip:
                    if self.held_over():
                        continue
                    if rnd.norun > 0:
                        # Settled over a workflow's ABSENCE from the branch: its empty page is
                        # evidence the way an uncovered tip's is (ludics-lite#550).
                        self.keep_pages(rnd, tip, f"(settled with no push run on {branch} for"
                                        f" {', '.join(n for _, n in rnd.norun_ids)})")
                    break
            elif (rnd.uncovered > 0 and rnd.tip_unjudged == 0 and rnd.inflight == 0
                  and not rnd.src_pending):
                settle_why = ""
                why = b.tip_within_paths_ignore(rnd.unrun, tip) if rnd.norun == 0 else None
                if why is not None:
                    settle_why = (
                        "(every commit on the first-parent path from the judged commit up to the tip"
                        f" changes only paths within the paths-ignore of {why}, so no run for it is"
                        " coming — the verdicts above are about the commit each line names)")
                elif now - grace_from >= grace:
                    settle_why = (f"(waited {(now - started) // 60} min: no run for the tip appeared and"
                                  " none is in flight for it — the verdicts above may trail it)")
                # The settle accepts verdicts about an OLDER commit: confirm the tip first.
                if settle_why and self.tip_read() == tip:
                    if self.held_over():
                        continue
                    waited_note = settle_why
                    self.keep_pages(rnd, tip, settle_why)
                    break
            elif rnd.inflight == 0 and rnd.nogo_at_tip > 0 and now - grace_from >= grace:
                waited_note = ("(the tip's newest run completed stopped-not-judged and no replacement"
                               " appeared within the grace — NOT absence and NOT a verdict: re-run the"
                               " workflow)")
                no_tip_verdict = True
                break
            if not now - started < wait_for:
                waited_note = (f"(--wait ceiling of {wait_for // 60} min reached with a run still"
                               " unfinished or the tip unjudged — NOT a verdict for the tip)")
                no_tip_verdict = True
                break
            if now - beat >= knobs.checks_heartbeat:
                warn(f"still waiting on {repo} {branch}: {rnd.inflight} run(s) in flight,"
                     f" {rnd.uncovered} workflow(s)",
                     f"not yet judged at the tip, after {(now - started) // 60} min")
                beat = now
            # The budget's pause: the interval after a round that saw the branch move (its tip, its
            # runs, what the round made of them), doubling toward the build cap while it sits still,
            # and capped at what is left of the ceiling.
            sig = "|".join((
                tip, str(rnd.red), str(rnd.pend), str(rnd.inflight), str(rnd.uncovered),
                str(rnd.red_at_tip), str(rnd.nogo_at_tip), str(rnd.norun), str(rnd.tip_unjudged),
                " ".join(f"{r.run_id}:{r.status}:{r.conclusion}" for r in raw),
            ))
            sleep_for = pause(knobs.checks_interval, cap, last_pause, sig != last_sig)
            last_sig = sig
            last_pause = sleep_for
            remaining = started + wait_for - now
            b.clock.sleep(min(sleep_for, remaining))
        return self.report(rnd, tip, waited_note, no_tip_verdict, interim_green)

    def held_over(self) -> bool:
        """Whether a read of this round waited a quota hold out (``Budget.waited``): its pages
        are then older than its end, and the round is read again rather than settled on."""
        budget = self.b.session.budget
        if budget is None or not budget.waited:
            return False
        warn("a quota hold was waited out inside this round's reads; reading the round again")
        return True

    def read_runs(self, rnd: _Round) -> list[RunRow]:
        """Each listed non-advisory workflow's push runs on the branch, a page of ten, each ordered
        newest first. A full page with no GREEN row is read a hundred deep: one that judged nothing
        (ludics-lite#535), whose verdict is below it, and one red to its end, whose streak's floor
        is (#403's port-time item from #546), so ``red_detail`` can say where the red starts."""
        b, repo, branch = self.b, self.repo, self.branch
        raw: list[RunRow] = []
        for wid, wname in self.wf or []:
            if not wid or b.is_advisory(wname):
                continue
            rows = b.runs_page(wid, self.ebranch, 10, rnd.pages)
            if rows is None:
                fail(3, f"could not read {repo}'s '{wname}' runs on {branch}",
                     f"({b.err_line()}); the base's health is UNKNOWN, which is NOT 'green'.")
            if len(rows) >= 10 and not page_green(rows):
                deeper = b.runs_page(wid, self.ebranch, 100, rnd.pages)
                stale = _deeper_stale(rows, deeper) if deeper is not None else []
                if stale:
                    # The deeper read is a second moment, and it can be the staler one: a run the
                    # first page holds is missing from it, or reads there at an earlier attempt or
                    # unfinished. Keep the first page's verdicts and settle nothing on this round.
                    rnd.inconsistent.extend(f"{wname}'s {why}" for why in stale)
                elif deeper is not None:
                    rows = deeper
                elif not page_judged(rows):
                    fail(3, f"could not read {repo}'s '{wname}' runs on {branch} past its newest ten,",
                         f"none of which judged it ({b.err_line()}); the base's health is UNKNOWN,"
                         " which is NOT 'green'.")
                # A page that judged it red keeps its red when the floor's read fails: the floor is
                # decoration on a verdict already reached, and the streak walk then says the red
                # may start further back.
                if len(rows) >= 100 and not page_judged(rows):
                    rnd.exhausted_wids.add(wid)
            ordered = newest_first(rows, lambda r: r.created_at, lambda r: r.run_id, lambda r: r.line())
            rnd.by_wid[wid] = ordered
            rnd.names[wid] = wname
            if rows:
                raw.extend(ordered)
            else:
                # Listed, with no push run here yet: still unjudged at the tip (the newcomer).
                rnd.norun += 1
                rnd.norun_ids.append((wid, wname))
        return raw

    def consistency(self, rnd: _Round, tip: str) -> None:
        """ludics-lite#550: GitHub's run listing can serve a stale page while a run changes status,
        and a round that read one settled green on a weeks-old verdict with the tip's own run in
        flight. Within one wait, this round contradicts an earlier one when a workflow's newest
        judged run is OLDER than the newest an earlier round judged (or it has none), or when a run
        an earlier round saw at this tip is not on the page, or when a run reads at an earlier
        ``run_attempt`` than an earlier round read it at. Runs only accumulate on a branch: none of
        these happens to a fresh read short of a deleted run or a tip forced back, and either of
        those leaves the wait to its ceiling, no verdict, rather than to a settle on a stale page.
        The one way history does step back is a re-run of the judged run (its attempt up), which
        un-judges it: that lowers what is remembered for the workflow to what this page judges.
        The reasons go in ``rnd.inconsistent``; what was seen is otherwise never lowered."""
        for wid, rows in rnd.by_wid.items():
            name = rnd.names.get(wid, wid)
            newest = next((r for r in rows if r.status == "completed" and r.conclusion in _JUDGED), None)
            key = _row_key(newest) if newest is not None else None
            seen = self.judged_seen.get(wid)
            for r in rows:
                had_attempt = self.attempts_seen.get((wid, r.run_id), 0)
                if r.attempt and r.attempt < had_attempt:
                    rnd.inconsistent.append(f"{name}'s run {r.run_id} at {r.head_sha[:8]} reads at attempt"
                                            f" {r.attempt}, where an earlier round read attempt {had_attempt}")
                self.attempts_seen[(wid, r.run_id)] = max(had_attempt, r.attempt)
            again = next((r for r in rows if seen is not None and r.run_id == seen.run_id), None)
            if seen is not None and again is not None and seen.attempt and again.attempt > seen.attempt:
                # The run an earlier round judged by was re-run since: what it judged no longer
                # stands, and an older run newest-judged is the branch's history, not a stale page.
                del self.judged_seen[wid]
                seen = None
            if seen is not None:
                if newest is None:
                    rnd.inconsistent.append(f"{name} has no judged run on it, where an earlier round's"
                                            f" newest was run {seen.run_id} at {seen.sha[:8]}")
                elif key is not None and key < seen.key:
                    rnd.inconsistent.append(f"{name}'s newest judged run is run {newest.run_id} at"
                                            f" {newest.head_sha[:8]}, older than run {seen.run_id} at"
                                            f" {seen.sha[:8]}, which an earlier round judged by")
            if newest is not None and key is not None and (seen is None or key > seen.key):
                self.judged_seen[wid] = _Seen(key, newest.run_id, newest.head_sha, newest.attempt)
            if tip:
                had = self.tip_seen.setdefault((tip, wid), set())
                lost = sorted(had - {r.run_id for r in rows})
                if lost:
                    rnd.inconsistent.append(f"{name}'s run {', '.join(lost)} at the tip {tip[:8]}, which"
                                            " an earlier round saw, is not on it")
                had.update(r.run_id for r in rows if r.head_sha == tip)

    def keep_pages(self, rnd: _Round, tip: str, why: str) -> None:
        """Keep the raw runs pages of a round that settled on ABSENCE, under the state directory
        (``base-pages/``, the newest KEPT_PAGES), and name the file on stderr: the settle reads
        what a page does NOT hold, so the next stale page that gets past ``consistency`` carries
        its own record (ludics-lite#550). A debug path: no state directory keeps nothing, and a
        failed write is said and changes no verdict."""
        budget = self.b.session.budget
        directory = budget.dir if budget is not None else ""
        if not directory:
            return
        # Joined with "/", as the state directory itself is spelled (a native Windows one by
        # ``cygpath -m``): the path named on stderr is one the caller's shell can open as printed.
        pages_dir = f"{directory.rstrip('/')}/base-pages"
        now = self.b.clock.now()
        path = f"{pages_dir}/{now}.{os.getpid()}.{self.repo.replace('/', '~')}.txt"
        lines = [
            "# pr-review.sh base: the runs pages of a round that settled on absence (ludics-lite#550)",
            f"# repo {self.repo} branch {self.branch} tip {tip}"
            f" at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now))} pid {os.getpid()}",
            f"# {why}",
        ]
        for endpoint, body in rnd.pages:
            lines.append(f"## {endpoint}")
            lines.append(body.rstrip("\n"))
        try:
            os.makedirs(pages_dir, exist_ok=True)
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as handle:
                handle.write("\n".join(lines) + "\n")
            kept = sorted((int(m.group(1)), n) for n in os.listdir(pages_dir)
                          if (m := _KEPT_NAME.fullmatch(n)))
            for _, n in kept[:-KEPT_PAGES]:
                with contextlib.suppress(OSError):
                    os.remove(os.path.join(pages_dir, n))
        except OSError as e:
            warn(f"base: could not keep this settle's runs pages in {pages_dir} ({e.strerror})")
            return
        warn(f"base: this settle on absence kept the runs pages it read in {path} (ludics-lite#550)")

    def judge(self, rnd: _Round, tip: str, raw: list[RunRow]) -> None:
        """The fold's verdict per workflow, the report's lines, and the round's counts."""
        b, repo, branch = self.b, self.repo, self.branch
        rnd.folded = fold(raw)
        out: list[str] = []
        for f in rnd.folded:
            name, status, sha = f.name, f.status, f.sha
            concl, csha, cwhen, curl = f.concl, f.csha, f.cwhen, f.curl
            if not name or b.is_advisory(name):
                continue
            trig_note = ""
            # A workflow whose newest judged run is not the tip's is asked whether its file at the
            # tip still runs on push (ludics-lite#401); one that does not is set aside, and the
            # tip's verdict for it comes from a named source below.
            if not tip or f.vsha != tip:
                trigger = b.push_trigger(f.wfid, tip or self.ebranch)
                if trigger is None:
                    fail(3, f"could not read {repo}'s '{name}' workflow file at the tip"
                         f" {tip or 'of ' + branch}",
                         f"({b.err_line()}): whether it still runs on push is UNKNOWN, which is NOT 'green'.")
                if trigger.kind == "pushless" and not tip:
                    fail(3, f"could not read {repo} {branch}'s tip, and '{name}' no longer runs on push:"
                         " only a", "source about the tip can judge it, so the base's verdict is UNKNOWN,"
                         " which is NOT 'green'.")
                match trigger.kind:
                    case "pushless":
                        rnd.pushless.append((f.wfid, name))
                        out.append(f"  retired  {name} — no push trigger at the tip, so its newest judged"
                                   f" push run ({f.vconcl} at {f.vsha[:8]}) is history, not the tip's"
                                   " verdict\n")
                        continue
                    case "unparsed":
                        trig_note = (f"           ({name}'s file at the tip could not be parsed for its"
                                     " triggers, so it is read as a push workflow)\n")
                    case "absent":
                        trig_note = (f"           ({name}'s file is not at the tip, so its standing"
                                     " verdict is read as it was before ludics-lite#401)\n")
                    case "push":
                        pass
                    case _:
                        assert_never(trigger.kind)
            if status != "completed":
                rnd.inflight += 1
            # The tip's OWN run in flight: what a merge burst leaves on every tip (#308).
            fly = status != "completed" and bool(tip) and sha == tip
            if fly:
                rnd.tipfly.append((f.wfid, name))
            if not (tip and f.vsha == tip):
                rnd.uncovered += 1
                if not fly:
                    rnd.uncov_nofly += 1
                # WHICH absence: a run for the tip EXISTS and has not judged it (only it can
                # answer), or none exists (the not-created-yet window, or a filtered push).
                if any(r.wid == f.wfid and r.head_sha == tip for r in self.allruns):
                    rnd.tip_unjudged += 1
                else:
                    rnd.unrun.append((f.wfid, name, f.vsha))
            if conclusion_class(concl) == "nogo" and tip and csha == tip:
                rnd.nogo_at_tip += 1
            # The newest JUDGED run carries the verdict; a stopped run over it is context.
            stopped_note = ""
            if conclusion_class(concl) == "nogo" and f.vsha != "-":
                stopped_note = (f"           (newest completed run: {concl} at {csha[:8]}, stopped not"
                                " judged — verdict above is the newest judged run)\n")
                concl, csha, cwhen, curl = f.vconcl, f.vsha, f.vwhen, f.vurl
            klass = conclusion_class(concl)
            match klass:
                case "red":
                    rnd.red += 1
                    if tip and csha == tip:
                        rnd.red_at_tip += 1
                    out.append(f"  RED      {name} — {concl} at {csha[:8]} ({cwhen})  {curl}\n")
                    out.append(b.red_detail(f.wfid, self.allruns))
                case "green":
                    out.append(f"  green    {name} — {concl} at {csha[:8]}\n")
                case "pending":
                    rnd.pend += 1
                    if status != "completed":
                        rnd.pend_fly += 1
                        out.append(f"  pending  {name} — no run of it has finished on {branch} yet, and"
                                   " one is in flight\n")
                    else:
                        out.append(f"  no verdict  {name} — has never completed on {branch}\n")
                case "nogo":
                    rnd.pend += 1
                    if status != "completed":
                        rnd.pend_fly += 1
                        out.append(f"  pending  {name} — {concl} at {csha[:8]} (stopped, not judged; no"
                                   " earlier judged run in the window), and a later run is in flight"
                                   f"  {curl}\n")
                    else:
                        out.append(f"  no verdict  {name} — {concl} at {csha[:8]} (stopped, not judged;"
                                   f" no earlier judged run in the window)  {curl}\n")
                case _:
                    assert_never(klass)
            out.append(stopped_note + trig_note)
            if f.wfid in rnd.exhausted_wids:
                rnd.exhausted.append(name)
                out.append(f"           ({name}: none of its newest 100 push runs on {branch} judged it,"
                           " and this read stops there — a judged run further back, a red included, is"
                           " not seen: no verdict, never green)\n")
            if csha == "-":
                csha = ""
            if status != "completed":
                out.append(f"           ({name} is running now at {sha[:8]})\n")
            elif tip and csha and csha != tip:
                out.append(f"           (that verdict is about {csha[:8]}, not the tip {tip[:8]})\n")
        # The retired workflows get the tip's verdict from a NAMED source, once for all of them.
        if rnd.pushless:
            names = rnd.pushless_names
            src = b.named_source(branch, tip, rnd.pushless)
            if src is None:
                fail(3, f"could not read a verdict source for {repo} {branch}'s tip {tip[:8]}",
                     f"({b.err_line()}): the tip's verdict is UNKNOWN, which is NOT 'green'.")
            match src.verdict:
                case "green":
                    out.append(f"  green    {names} — {src.why}\n")
                case "red":
                    rnd.red += 1
                    rnd.red_at_tip += 1
                    out.append(f"  RED      {names} — {src.why}\n")
                case "pending":
                    rnd.pend += 1
                    rnd.src_pending = True
                    out.append(f"  no verdict  {names} — not yet: {src.why}\n")
                case "none":
                    rnd.pend += 1
                    rnd.src_none = True
                    out.append(f"  no verdict  {names} — no named source judges the tip: {src.why}\n")
                case _:
                    assert_never(src.verdict)
            self.pushless_name = src.name
        rnd.out += "".join(out)

    def interim(self, rnd: _Round, tip: str, snap_at: int) -> Literal["green", "reround", "no"]:
        """The INTERIM verdict (ludics-lite#308), under --interim only: nothing red, every workflow
        still owed a verdict at the tip has the tip's own run in flight, and nothing else is in
        flight on the branch -- then a named source's green for exactly those workflows is an
        interim green. A failed integration record at the tip is the tip's red, read first."""
        b, repo, branch = self.b, self.repo, self.branch
        if not rnd.tipfly:
            return "no"
        names = rnd.tipfly_names
        if any(r.sha == tip for r in self.records):
            src = b.named_source(branch, tip, rnd.tipfly)
            if src is not None and src.verdict == "red":
                rnd.red += 1
                rnd.red_at_tip += 1
                rnd.out += f"  RED      {names} — its push run is still in flight, but {src.why}\n"
        pushless_wids = {wid for wid, _ in rnd.pushless}
        # EVERY row read, not the fold's newest per workflow: an older run beside the tip's.
        older_fly = sum(1 for r in self.allruns if r.wid != "" and r.status != "completed"
                        and r.head_sha != tip and r.wid not in pushless_wids)
        if older_fly == 0 and rnd.exhausted:
            older_fly = 1
            rnd.out += (f"           (no interim verdict: none of the newest 100 push runs of"
                        f" {', '.join(rnd.exhausted)} judged the branch, and nothing past them was read)\n")
        if older_fly == 0:
            # The burst a page of ten cannot hold (#533): each tip workflow read a hundred deep.
            for wid, wname in rnd.tipfly:
                older = b.older_runs(wid, self.ebranch, tip)
                if older is None:
                    older_fly = 1
                    rnd.out += (f"           (no interim verdict for {wname}: its push runs could not be"
                                f" read past the first page ({b.err_line()}))\n")
                    break
                n_open, newest = older
                older_fly += n_open
                if conclusion_class(newest) == "red":
                    older_fly += 1
                    rnd.out += (f"           (no interim verdict for {wname}: its newest judged push run"
                                f" at an older commit is {newest} — the burst's verdict, not the PR"
                                " head's)\n")
        if not (rnd.red == 0 and not rnd.src_pending and not rnd.src_none
                and rnd.inflight == len(rnd.tipfly) and rnd.uncov_nofly == 0 and older_fly == 0
                and (self.args.wait_for > 0 or rnd.pend > 0)):
            return "no"
        src = b.named_source(branch, tip, rnd.tipfly)
        if src is None:
            rnd.out += (f"           (no interim verdict for {names}: a verdict source could not be read"
                        f" ({b.err_line()}))\n")
            return "no"
        if src.verdict != "green":
            rnd.out += f"           (no interim verdict for {names}: {src.why})\n"
            return "no"
        self.interim_name, self.interim_why = src.name, src.why
        hold_why = ""
        moved = False
        grace = b.knobs.absent_grace
        for wid, wname in rnd.norun_ids:
            trigger = b.push_trigger(wid, tip)
            if trigger is None:
                hold_why = (f"whether {wname}, which has no push run on {branch}, runs on push could not"
                            f" be read ({b.err_line()})")
                break
            if trigger.kind == "pushless":
                continue
            seen = ""
            for r in self.allruns:
                if r.head_sha == tip and r.created_at > seen:
                    seen = r.created_at
            at = iso_seconds(seen)
            if at is None:
                hold_why = (f"{wname} may run on push and has no run on {branch}, and the tip's age could"
                            " not be read")
                break
            age = max(0, math.floor(snap_at - at))
            if age < grace:
                hold_why = (f"{wname} may run on push and has no run on {branch} yet, and the tip is"
                            f" {age}s old, inside the {grace}s window its first run may still appear in")
                break
        if not hold_why:
            # The tip's runs read again, by id: one that finished meanwhile is the tip's verdict.
            for wid, wname in rnd.tipfly:
                rid = next((r.run_id for r in self.allruns if r.wid == wid), "")
                status = ""
                if _DIGITS.fullmatch(rid):
                    doc = b.gh_json(["api", f"repos/{repo}/actions/runs/{rid}"])
                    if not isinstance(doc, (GhFailed, GhUnanswered)):
                        status = tsv(alt(get(doc, "status"), "-"))
                if not status:
                    hold_why = (f"the tip's run of {wname} could not be read again after the source"
                                f" ({b.err_line()})")
                    break
                if status == "completed":
                    hold_why = (f"the tip's run of {wname} finished while the source was read, so it is"
                                " the tip's verdict")
                    moved = True
                    break
        if not hold_why and self.tip_read() != tip:
            hold_why = "the tip moved while the source was read"
            moved = True
        if not hold_why:
            return "green"
        if moved and self.rerounds < 2:
            return "reround"
        rnd.out += f"           (no interim verdict for {names}: {hold_why})\n"
        return "no"

    def report(self, rnd: _Round, tip: str, waited_note: str, no_tip_verdict: bool,
               interim_green: bool) -> int:
        repo, branch, out = self.repo, self.branch, rnd.out
        t8 = tip[:8]
        at_tip = f" (tip {t8})" if tip else ""
        if waited_note:
            cli.say(waited_note)
        # A wait that ended WITHOUT the tip's verdict says so before the red branch: an older
        # tip's red is not the tip's.
        if no_tip_verdict:
            if rnd.tipfly:
                cli.say(f"{repo} {branch}: NO VERDICT for the tip {t8} — pending: its own run of"
                        f" {rnd.tipfly_names} is still in flight; not green, not red (see above)")
            else:
                cli.say(f"{repo} {branch}: NO VERDICT for the tip{' ' + t8 if tip else ''} — not green,"
                        " not red (see above)")
            sys.stdout.write(out)
            return 4
        if interim_green:
            judged = f"; {rnd.pushless_names} judged by {self.pushless_name}" if rnd.pushless else ""
            cli.say(f"{repo} {branch}: green, interim (tip {t8}; {rnd.tipfly_names} still running at"
                    f" the tip, judged meanwhile by {self.interim_name}{judged})")
            sys.stdout.write(out + f"  interim  {rnd.tipfly_names} — the tip's own run is in flight;"
                             f" {self.interim_why}\n")
            return 0
        if rnd.red > 0:
            cli.say(f"!!! {repo} {branch} is RED — {rnd.red} workflow(s) failed on the tip you are about"
                    " to branch from")
            sys.stdout.write(out)
            cli.say("!!! Branching off a red base makes every later 'is this my change?' question"
                    " expensive.")
            cli.say("!!! Read the run above first: if it is already broken, say so before starting, and"
                    " do not")
            cli.say("!!! spend the session bisecting someone else's break.")
            return 1
        if not out:
            cli.say(f"{repo} {branch}: no build workflow has run on it (nothing to read, not a green"
                    " light)")
            return 4
        if rnd.exhausted:
            cli.say(f"{repo} {branch}: NO VERDICT{at_tip} — none of the newest 100 push runs of"
                    f" {', '.join(rnd.exhausted)} judged the branch, and the read stops there; a red"
                    " further back is not seen; not green, not red")
            sys.stdout.write(out)
            return 4
        if rnd.src_none or rnd.src_pending:
            cli.say(f"{repo} {branch}: NO VERDICT (tip {t8}) — {rnd.pushless_names} no longer run(s) on"
                    " push, and no named source has judged the tip; an older verdict is not the tip's"
                    " (see below)")
            sys.stdout.write(out)
            return 4
        if rnd.pend > 0 and rnd.pend_fly == rnd.pend:
            cli.say(f"{repo} {branch}: NO VERDICT YET{at_tip} — pending: a run is in flight, and no"
                    " finished run in the window judged the branch; not green, not red")
            sys.stdout.write(out)
            return 4
        if rnd.pend > 0:
            cli.say(f"{repo} {branch}: NO VERDICT{at_tip} — some workflow was never judged here; not"
                    " green, not red")
            sys.stdout.write(out)
            return 4
        if rnd.pushless:
            cli.say(f"{repo} {branch}: green (tip {t8}; {rnd.pushless_names} judged by"
                    f" {self.pushless_name})")
        else:
            cli.say(f"{repo} {branch}: green{at_tip}")
        sys.stdout.write(out)
        return 0
