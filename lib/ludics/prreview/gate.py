"""The build gate that ``checks`` and ``merge`` share: is the PR head's build signal green?

Ported from pr-review.sh's ``gate_checks`` and everything it reads through (ludics-lite#403):
the advisory list and the repository's own advisory file (``advisory_policy``, #530), the
override's waiver (``apply_waiver``/``is_waived``, #392; a cancel read at the first read too, #1036), the check fold (``build_checks``,
``summarize_checks``), and the run list that overrules it (``run_signal`` with its job reads,
#24/#38/#500) -- whose run-less head, inside the grace, asks the paths-ignore recognition
(``workflows.head_within_paths_ignore``, #176). On a round with no verdict, ``checks`` and
``merge`` also look for jobs that never got a runner (runners.py, #560/#728): named in the report,
they end the wait, unless ``merge --wait``'s one recovery keeps it. Under a wait, a round's read
that did not answer -- the head's (ludics-lite#795), the check runs' or the workflow runs'
(ludics#808), a red run's jobs (ludics#929) -- is one failed poll, read again within the wait's
budget (``_unread``, which states what rides out and what does not). A wait also notices what no
wait resolves (``Gate.check``): a PR that conflicts with its base (``conflicting``, ludics#1110), a
run that never started beside a later one that completed (``run_signal``, ludics#1107), and under
``checks`` a stopped run nothing reruns (ludics#1097).

The shell's comments above each of those functions carry the incident history and every review
round's reason; read them there before changing a rule here. What changed in the port is the
mechanism only: the globals the shell threaded through command substitutions (VERDICT, CHECK_*,
GATE_WAIVE, WAIVED, GATE_BASE) are the attributes of one ``Gate``. The advisory EREs are still
grep's to read (``ere``: grep is asked, as the shell asked it). Every gh call is the shell's, argument for argument,
and its TSV is read the way the shell's ``IFS=$'\\t' read`` read it (``shtext.tab_fields``), since
the column-shifting that read does on an empty field is part of what the placeholders guard.
"""

import re
import shlex
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, assert_never

from ludics import cli
from ludics.prreview import ere
from ludics.prreview import knobs
from ludics.prreview.core import GhFailed, GhOk, GhSession, GhUnanswered, warn
from ludics.prreview.checkruns import conclusion_class, newest_first_lines
from ludics.prreview.budget import pause
from ludics.prreview.clock import Clock, FuncClock, age_of, fmt_age, freshest_age
from ludics.prreview.images import RedJob, report_lines as image_lines
from ludics.prreview.runners import HeadRun, Idle, Orphan, Recover, Stop, Wait, report_line, scan
from ludics.prreview.shtext import herestring_lines, is_digits, placeholder, tab_fields
from ludics.prreview.workflows import RecognitionLimits, Reads, head_within_paths_ignore

DEFAULT_ADVISORY = knobs.DEFAULT_ADVISORY
ADVISORY_FILE = ".github/ship-pr-advisory-checks"
# ``Gate.conflicting``'s projection: the one PR read that ends in this filter.
MERGEABLE_STATE_JQ = '.mergeable_state // "-"'


@dataclass(frozen=True)
class GateConfig:
    """The gate's and merge's source-time constants, validated as the shell validated them."""

    checks_interval: int
    checks_wait: int
    checks_heartbeat: int
    absent_grace: int
    advisory: str
    advisory_from_env: bool
    advisory_settle: int
    stale_base: int | None  # None: `off`
    threads_page_cap: int
    limits: RecognitionLimits
    never_started: int | None = 1200  # None: `off` (runners.py)


def load_gate_config(env: Mapping[str, str]) -> GateConfig:
    """The gate's and merge's source-time constants (knobs.py), in the shell's order."""
    grace = knobs.absent_grace(env)
    timing = knobs.checks_timing(env)
    stale = knobs.stale_base(env)
    return GateConfig(
        checks_interval=timing.interval,
        checks_wait=timing.wait,
        checks_heartbeat=timing.heartbeat,
        absent_grace=grace,
        advisory=knobs.build_advisory(env),
        advisory_from_env=knobs.advisory_from_env(env),
        advisory_settle=knobs.private_int(env, knobs.ENV_ADVISORY_SETTLE, knobs.ADVISORY_SETTLE),
        stale_base=stale,
        threads_page_cap=knobs.threads_page_cap(env),
        limits=RecognitionLimits(
            contents_dir_cap=knobs.private_int(env, knobs.ENV_CONTENTS_DIR_CAP, knobs.CONTENTS_DIR_CAP),
            ignore_max_commits=knobs.private_int(env, knobs.ENV_IGNORE_MAX_COMMITS, knobs.IGNORE_MAX_COMMITS),
        ),
        never_started=knobs.never_started(env),
    )


# --- small readings ---------------------------------------------------------------------------------

def _before_space(text: str) -> str:
    return text.split(" ", 1)[0]


def _after_space(text: str) -> str:
    parts = text.split(" ", 1)
    return parts[1] if len(parts) == 2 else text


# --- the build signal -------------------------------------------------------------------------------

type Verdict = Literal[
    "", "green", "absent", "red", "runred", "waived", "pending", "mixed", "unjudged",
    "superseded", "unknown", "conflict",
]

# How a read of the gate's failed (``_unread``): ``refused`` GitHub answered with a refusal no retry
# changes (a ``GhFailed``: a 4xx, a fixed GraphQL answer); ``held`` the polling budget stopped it
# (``GhSession.quota_stopped``); ``unanswered`` the session's attempts ran out on transport, or the
# head read answered no SHA; ``unusable`` the reads answered, and what they answered decides
# nothing (``run_signal``'s head with no usable clock), which reading again does not change.
type Unread = Literal["refused", "held", "unanswered", "unusable"]


@dataclass
class RunSignal:
    """``run_signal``'s answer: its status (0 the fold stands, 1 red at the run level, 3 unread,
    4 no verdict yet), the run-level red count, the runs the waiver took out of it (one
    "<run id> <run|job|cancelled> <name>" per line), and the reason line. ``stopped``: the 4 is a run that
    stopped without a verdict, with nothing in flight -- no new check run comes of it unless
    someone re-runs it, which ``checks --check`` reads as final (#569). ``unread``: on a 3, how the
    read failed (``Unread``). ``holds``: on a 4 for runs in flight, one report line per held run,
    naming the job that kept the advisory release from applying and why (``run_inflight_hold``,
    ludics#930). ``superseded``: whatever the status, one report line per run in flight the read
    did not wait for (``run_signal``'s never-started boundary, ludics#1107)."""

    rc: int
    red: int
    waived_runs: str
    reason: str
    stopped: bool = False
    # On a 3: how the read failed (``Unread``), which decides whether a wait reads it again.
    unread: Unread = "unanswered"
    # On a 3: the read that failed, as "<verb> <the thing read>"; "" the head's workflow runs.
    unread_what: str = ""
    holds: str = ""
    # On a 1: the ids of the red runs counted, in the run list's order (``Gate.red_runs``).
    red_ids: list[str] = field(default_factory=lambda: list[str]())
    superseded: str = ""


# `gate_checks` (with build_checks, summarize_checks, run_signal, apply_waiver), ported once: `checks`,
# `merge`, and `base`'s tip_pr_head_verdict (a merged PR's head) judge through this gate.
@dataclass
class Gate:
    """One command's build gate. The attributes are the shell's globals of the same name, which
    ``merge`` reads after a gate: ``verdict`` (VERDICT), ``check_sha`` (CHECK_SHA, what the verdict
    is ABOUT), ``gate_base`` (GATE_BASE, the base the round's run read was about), and the counts."""

    session: GhSession
    repo: str
    config: GateConfig
    clock: Clock = field(default_factory=FuncClock)
    advisory: str = ""
    verdict: Verdict = ""
    check_sha: str = ""
    gate_base: str = ""
    check_red: int = 0
    # Beside a red fold, the red runs with no build check behind them (``checkless_reds``, #1066).
    checkless_red: int = 0
    check_waived: int = 0
    run_waived: int = 0
    # How many of those waivers (``check_waived`` + ``run_waived``) are of a CANCELLED check or run
    # rather than a red one (#1036), for the report's wording.
    waived_cancelled: int = 0
    check_passed: int = 0
    check_pending: int = 0
    check_total: int = 0
    check_green: int = 0
    # The pending checks with no runner yet: a pending row whose status is not ``in_progress``
    # (ludics-lite#740). Zero on a pending round is the wait the pause reads faster.
    check_queued: int = 0
    check_lines: str = ""
    # The held lines the report carries (``RunSignal.holds``), for ``base``'s merged-head check.
    check_holds: str = ""
    # The names of the checks the fold left running, for the wait's progress line (#569).
    pending_names: list[str] = field(default_factory=lambda: list[str]())
    # ``checks --check <ERE>`` (#569): judge only the check runs whose name the ERE matches, grep
    # reading it as it reads the advisory list. Empty is the whole head. See ``check``.
    select: str = ""
    # ``checks --settle`` (#1039): a red does not end the wait while a check the fold judges is still
    # running, so every red of the head is reported at once. See ``settling``.
    settle: bool = False
    # The round's workflow runs, "<id> <status> <conclusion>" each, what the budget's pause keys
    # on beside the check counts (ludics-lite#551): a run moves before any check row exists.
    run_state: str = ""
    waive_mode: Literal["", "record", "apply"] = ""
    waived: set[str] = field(default_factory=lambda: set[str]())
    # Jobs that never got a runner (runners.py, ludics-lite#560/#728): looked for only when
    # ``orphans_on`` (``checks`` and ``merge``; ``base`` reads a merged head and leaves it off), on
    # a round with no verdict, or a red that ``settling`` holds. ``orphans`` is the last such round's
    # finding. ``recover`` is ``merge --wait``'s one recovery (merge.py), given the round's orphans
    # and runs: Stop ends the wait, Wait keeps it (to a later deadline, after a rerun; its ``why``
    # is the heartbeat's note on a round with no check left running), Idle leaves the round as it is.
    # Without it, a round that finds one ends the wait: nothing it waits for moves until someone
    # reruns the run.
    orphans_on: bool = False
    # A red check's runner image against the base's last green run of that job (images.py,
    # ludics#959): read only when ``images_on`` (``checks`` and ``merge``; ``base`` polls a merged
    # head and leaves it off), once, for the report of a ``red`` verdict. ``red_jobs`` is the
    # fold's red checks, in its order.
    images_on: bool = False
    # Whether a round with nothing to wait for asks if the PR conflicts with its base
    # (``conflicting``, ludics#1110): ``checks`` and ``merge``; ``base`` reads a merged head and
    # leaves it off.
    conflicts_on: bool = False
    red_jobs: list[RedJob] = field(default_factory=lambda: list[RedJob]())
    orphans: list[Orphan] = field(default_factory=lambda: list[Orphan]())
    recover: Recover | None = None
    # ``merge --wait --rerun-failed-once`` (#1065): a red round whose fold has no check left running
    # (a red ``settling`` no longer holds) is handed to ``recover`` too, with no orphan scan, so the
    # recovery may rerun its failed jobs once. ``red_runs``: the round's red runs no check shows
    # (``run_signal``'s on a ``runred``, ``checkless_reds``' beside a red fold), by id.
    recover_red: bool = False
    red_runs: list[str] = field(default_factory=lambda: list[str]())
    # The last ``check``'s wait deadline on ``clock``, as the wait left it: its start plus the wait,
    # moved later by a recovery's Wait (ludics-lite#764: ``merge``'s build waits behind a
    # measurement window within what is left of it). None before a check.
    deadline: int | None = None
    # The reads of the last ``check`` that failed and were read past within its wait (``_unread``:
    # ludics-lite#795's head reads, ludics#808's check-run and workflow-run reads), each "<what>:
    # <the failure's line>": the report names them, as merge's final line does.
    unread: list[str] = field(default_factory=lambda: list[str]())
    # How the last failed ``build_checks`` or ``read_runs`` failed, for ``_unread``.
    read_failure: Unread = "unanswered"
    _round_runs: list[HeadRun] | None = None
    # The round's run read as ``read_runs`` returned it, so the check fold's workflow lookup and
    # ``run_signal`` ask the API once a round.
    _round_raw: str | None = None
    # The round's run read that failed, as its failure line: ``run_signal`` reports it rather than
    # asking again, so one failed round is one failed read (ludics#929). None: not failed this round.
    _round_runs_failure: str | None = None
    _advisory_from_file: bool = False
    _advisory: ere.Matcher | None = None
    _selected: ere.Matcher | None = None

    def __post_init__(self) -> None:
        if not self.advisory:
            self.advisory = self.config.advisory

    # --- the advisory list ---------------------------------------------------------------------------

    def is_advisory(self, name: str) -> bool:
        """``is_advisory`` (ere.Matcher) under the list this gate holds now: ``advisory_policy``
        may replace it with the repository's own. Under a selection nothing is advisory: the ERE
        names the checks to wait for, and a check it names is waited for whatever the list says."""
        if self.select:
            return False
        if self._advisory is None or self._advisory.pattern != self.advisory:
            self._advisory = ere.Matcher(self.advisory)
        return self._advisory(name)

    def advisory_policy(self) -> int:
        """``advisory_policy``: the advisory list from the repository's ADVISORY_FILE on its default
        branch, when there is one and the variable is unset. 0 read (or not needed); 2 or 3, said
        on stderr, when the policy is refused or unknown -- returned, not raised, so ``checks`` can
        still end with its trailer."""
        if self.config.advisory_from_env:
            return 0
        repo = self.repo
        result = self.session.retry(
            "read", ["api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{ADVISORY_FILE}"]
        )
        match result:
            case GhOk(stdout=body):
                parsed = advisory_parse(body, f"{repo}'s {ADVISORY_FILE}")
                if parsed is None:
                    return 2
                self.advisory = parsed
                self._advisory_from_file = True
                warn(f"advisory checks, from {repo}'s {ADVISORY_FILE}: {self.advisory}")
                return 0
            case GhFailed():
                if "HTTP 404" in self.session.err_line():
                    absent = self.advisory_absent()
                    if absent == 0:
                        return 0
                    if absent == 3:
                        warn(
                            f"{repo}'s advisory list, {ADVISORY_FILE}, read as 404, and the listing that would",
                            f"establish its absence did not answer ({self.session.err_line()}). The gate's policy is",
                            "UNKNOWN; nothing was judged. Retry.",
                        )
                        return 3
                    warn(
                        f"{repo}'s advisory list, {ADVISORY_FILE}, read as 404, and its absence could not be",
                        "established from the directory listing: a 404 is also how GitHub answers a token",
                        "without Contents access to a private repository, so the default list is not a safe",
                        "stand-in. Give the token Contents read access.",
                    )
                    return 2
                warn(
                    f"could not read {repo}'s advisory list, {ADVISORY_FILE} on its default branch",
                    f"({self.session.err_line()}). The API refused the read, so the gate's policy is unknown, and the",
                    "default list is not a safe stand-in for it.",
                )
                return 2
            case GhUnanswered():
                warn(
                    f"could not read {repo}'s advisory list, {ADVISORY_FILE} on its default branch",
                    f"({self.session.err_line()}). The gate's policy is UNKNOWN; nothing was judged. Retry.",
                )
                return 3
            case _:
                assert_never(result)

    def advisory_absent(self) -> int:
        """``advisory_absent``: ``github_file_absent`` for the advisory list."""
        return github_file_absent(self.session, self.repo, "ship-pr-advisory-checks", self.config.limits.contents_dir_cap)

    # --- the check fold -------------------------------------------------------------------------------

    def selects(self, name: str) -> bool:
        """Does ``--check``'s ERE match this check name? grep's reading, as for the advisory list
        (ere.py), and one process's answers kept the same way."""
        if self._selected is None or self._selected.pattern != self.select:
            self._selected = ere.Matcher(self.select)
        return self._selected(name)

    def build_checks(self, sha: str) -> list[str] | None:
        """``build_checks``: one "class\\tname\\tconclusion\\turl\\tsuite\\tstatus" line per non-advisory
        check run of ``sha``; None when the read failed (an outage is not a commit with no checks).
        The status (queued, in_progress, ...) sets only the wait's pause (ludics-lite#740), never a
        verdict: the verdict is the conclusion's."""
        result = self.session.retry(
            "read",
            [
                "api",
                "--paginate",
                f"repos/{self.repo}/commits/{sha}/check-runs?filter=latest&per_page=100",
                "--jq",
                '.check_runs[] | [.name, (.conclusion // "pending"), (.html_url // "-"),\n'
                '          ((.check_suite.id // "-") | tostring), (.status // "-")] | @tsv',
            ],
        )
        if not isinstance(result, GhOk):
            self.read_failure = self._failure_of(result)
            return None
        rows: list[str] = []
        for line in herestring_lines(result.stdout):
            name, concl, url, suite, status = tab_fields(line, 5)
            if not name or self.is_advisory(name):
                continue
            rows.append(f"{conclusion_class(concl)}\t{name}\t{concl}\t{url}\t{suite or '-'}\t{status or '-'}")
        return rows

    def drop_advisory_workflows(self, sha: str, rows: list[str]) -> list[str]:
        """The fold's rows less those whose check suite is a run of an advisory WORKFLOW
        (ludics-lite#785): a check run is named for its job, not its workflow, so a list naming the
        workflow (OCANNL's ``github pages docs``, whose job is ``build``) matched only the run, and
        a cancelled job of it read as a stopped build check -- no verdict, the gate held. The
        suites come from the round's run read; an unread run list drops nothing, and
        ``run_signal`` then reports that read's failure without asking again (ludics#929). Under a
        selection nothing is advisory, and the run read is not made."""
        if self.select or not rows:
            return rows
        raw = self.read_runs(sha)
        if raw is None:
            return rows
        suites: set[str] = set()
        for line in herestring_lines(raw):
            _created, rid, _wid, _event, name, _status, _concl, suite = tab_fields(line, 8)
            if rid and suite and suite != "-" and self.is_advisory(name):
                suites.add(suite)
        return [row for row in rows if tab_fields(row, 6)[4] not in suites]

    def apply_waiver(self, rows: list[str]) -> list[str]:
        """``apply_waiver``: the red rows the waiver covers marked ``waived`` -- recorded first on the
        recording read -- and only while their key names exactly ONE row. A row that concluded
        ``cancelled`` is waived the same way under its own key, ``cancelled:<suite>/<name>`` (#1036):
        the waiver covers it while it reads cancelled, so a cancelled check re-run red (a re-run keeps
        its suite) is a red nobody gave the override for. Boundary, a fail-closed allowlist: red and
        ``cancelled`` alone; a check with no conclusion yet, ``stale`` and ``action_required`` are
        never waived."""
        keys: list[str] = []
        for row in rows:
            cls, name, _concl, _url, suite, _status = tab_fields(row, 6)
            if cls:
                keys.append(f"{suite}/{name}")
        out: list[str] = []
        for row in rows:
            cls, name, concl, url, suite, status = tab_fields(row, 6)
            if not cls:
                continue
            ident = f"{suite}/{name}"
            if cls == "red":
                key = f"check:{ident}"
            elif cls == "nogo" and concl == "cancelled":
                key = f"cancelled:{ident}"
            else:
                key = ""
            if key and keys.count(ident) == 1:
                if self.waive_mode == "record":
                    self.waived.add(key)
                if key in self.waived:
                    cls = "waived"
            out.append(f"{cls}\t{name}\t{concl}\t{url}\t{suite}\t{status}")
        return out

    def settling(self) -> bool:
        """``--settle``'s hold (#1039): the round read a red (a check, or a checkless run) while a
        check the fold judges -- every required one, or the ``--check`` selection -- has no
        conclusion yet. Off, a red ends the wait whatever is still running. Boundary: it reads the
        fold's check runs alone; a required job with no check run yet (a ``needs:`` dependent not
        yet queued) does not hold it, as ``--check``'s selection does not see one."""
        return self.settle and self.verdict in ("red", "runred") and self.check_pending > 0

    def summarize(self, rows: list[str]) -> None:
        """``summarize_checks``: the per-check classes folded into ``verdict`` and the report lines."""
        red = waived = cancelled = pending = queued = nogo = green = passed = 0
        lines: list[str] = []
        running: list[str] = []
        reds: list[RedJob] = []
        for row in rows:
            cls, name, concl, url, suite, status = tab_fields(row, 6)
            if not cls:
                continue
            match cls:
                case "red":
                    red += 1
                    lines.append(f"  RED      {name} ({concl})  {url}\n")
                    reds.append(RedJob(name, url, suite or "-"))
                case "waived" if concl == "cancelled":
                    waived += 1
                    cancelled += 1
                    lines.append(
                        f"  stopped  {name} (cancelled — WAIVED: cancelled when --override was given)  {url}\n"
                    )
                case "waived":
                    waived += 1
                    lines.append(f"  RED      {name} ({concl} — WAIVED: red when --override was given)  {url}\n")
                case "pending":
                    pending += 1
                    if status != "in_progress":
                        queued += 1
                    running.append(name)
                    lines.append(f"  running  {name} (no verdict yet)  {url}\n")
                case "nogo":
                    nogo += 1
                    lines.append(f"  no verdict  {name} ({concl} — stopped, not judged)  {url}\n")
                case _:
                    green += 1
                    if concl == "success":
                        passed += 1
        self.check_lines = "".join(lines)
        self.red_jobs = reds
        self.pending_names = running
        self.check_red = red
        self.check_waived = waived
        self.waived_cancelled = cancelled
        self.check_passed = passed
        self.check_pending = pending
        self.check_queued = queued
        self.check_total = red + waived + pending + nogo + green
        if red:
            self.verdict = "red"
        elif pending:
            self.verdict = "pending"
        elif nogo:
            self.verdict = "mixed"
        elif waived:
            self.verdict = "waived"
        elif not green:
            self.verdict = "absent"
        else:
            self.verdict = "green"
        self.check_green = green

    # --- the run list ---------------------------------------------------------------------------------

    def run_jobs(self, run_id: str) -> str | None:
        """``run_jobs``: "name\\tconclusion\\tcreated_at\\tcompleted_at" per job of the run; None
        when the read failed, how it failed in ``read_failure``."""
        result = self.session.retry(
            "read",
            [
                "api",
                "--paginate",
                f"repos/{self.repo}/actions/runs/{run_id}/jobs?per_page=100",
                "--jq",
                '.jobs[] | [(.name // "-"), (.conclusion // "pending"), (.created_at // "-"),\n'
                '          (.completed_at // "-")]\n'
                '          | map(if type == "string" and length > 0 then . else "-" end) | @tsv',
            ],
        )
        if not isinstance(result, GhOk):
            self.read_failure = self._failure_of(result)
            return None
        return result.stdout

    def run_red_is_advisory_only(self, run_id: str, suite: str) -> int:
        """``run_red_is_advisory_only``: 0 advisory jobs alone explain the run's red; 2 explained,
        but a job the override waived is part of it; 1 not explained; 3 the jobs are unread
        (``read_failure`` says how), which explains nothing either way (ludics#929: read as 1, one
        transient failure made a red only advisory jobs explain a refusal)."""
        raw = self.run_jobs(run_id)
        if raw is None:
            return 3
        names = [tab_fields(line, 3)[0] for line in herestring_lines(raw)]
        names = [n for n in names if n]
        jobs = hard = waived = 0
        for line in herestring_lines(raw):
            jname, jconcl, _times = tab_fields(line, 3)
            if not jname:
                continue
            jobs += 1
            if self.is_advisory(jname):
                continue
            if conclusion_class(jconcl) != "red":
                continue
            if names.count(jname) == 1 and f"check:{suite or '-'}/{jname}" in self.waived:
                waived += 1
                continue
            hard += 1
        if not (jobs > 0 and hard == 0):
            return 1
        return 2 if waived else 0

    def run_inflight_is_advisory_only(self, run_id: str, suite: str = "-") -> bool:
        """``run_inflight_is_advisory_only``: ``run_inflight_hold`` found nothing to hold the run."""
        return self.run_inflight_hold(run_id, suite) is None

    def run_inflight_hold(self, run_id: str, suite: str = "-") -> str | None:
        """``run_inflight_hold``: None when every unfinished job is advisory, every finished
        non-advisory job green -- or red (or cancelled, #1036) with its check WAIVED by ``--override`` (ludics#862), the
        key ``run_red_is_advisory_only`` reads, under the same one-job-of-that-name rule -- and the
        job list still for ADVISORY_SETTLE seconds; else why the release did not apply, naming the
        first job in the list's order that kept it (ludics#930: a hold that named no cause got
        ludics#862 filed against the wrong one). The waived red is already the verdict (the check
        fold's ``waived``); without this a waived red made the run's queued advisory leg a run in
        flight, and ``merge --override`` held to its deadline as no verdict (lukstafi/ocannl-staging
        #1612 and #1625: a master red shared by ``main 1/2`` beside a macOS leg queued 100 min).
        A jobs read that failed holds the run too, and says so: the run is in flight either way,
        so it stays a 4 rather than #929's 3, and the reason names the failed read."""
        return self._inflight_hold(self.run_jobs(run_id), suite)

    def _inflight_hold(self, raw: str | None, suite: str) -> str | None:
        """``run_inflight_hold`` over a job list already read (None: the read just failed)."""
        if raw is None:
            failure = self.session.err_line() or "it did not answer"
            return f"its job list could not be read ({failure}), so whether only advisory jobs are left is unknown"
        names = [n for n in (tab_fields(line, 4)[0] for line in herestring_lines(raw)) if n]
        unfinished = 0
        last = last_job = ""
        for line in herestring_lines(raw):
            jname, jconcl, jcreated, jdone = tab_fields(line, 4)
            if not jname:
                continue
            job = f"job {shlex.quote(jname)}"
            if (jcreated or "-") == "-":
                return f"{job} has no created_at, so the settle cannot place it (untimed)"
            if jcreated > last:
                last, last_job = jcreated, job
            if conclusion_class(jconcl) == "pending":
                if not self.is_advisory(jname):
                    return f"{job} is still running (or queued) and is not advisory"
                unfinished += 1
                continue
            if (jdone or "-") == "-":
                return f"{job} concluded {jconcl} with no completed_at, so the settle cannot place it (untimed)"
            if jdone > last:
                last, last_job = jdone, job
            if self.is_advisory(jname):
                continue
            klass = conclusion_class(jconcl)
            key = f"check:{suite or '-'}/{jname}"
            if klass == "red":
                if key not in self.waived:
                    return f"{job} concluded {jconcl}, red and not waived"
                if names.count(jname) != 1:
                    return (
                        f"{job} concluded {jconcl}, red, and the waiver cannot single it out:"
                        f" {names.count(jname)} jobs of the run share its name"
                    )
                continue
            if klass == "nogo" and jconcl == "cancelled" and f"cancelled:{suite or '-'}/{jname}" in self.waived:
                # A cancel --override waived (#1036), under the one-job-of-that-name rule as a red.
                if names.count(jname) != 1:
                    return (
                        f"{job} concluded cancelled, and the waiver cannot single it out:"
                        f" {names.count(jname)} jobs of the run share its name"
                    )
                continue
            if klass != "green":
                return f"{job} concluded {jconcl}, stopped and not judged"
        if not names:
            return "it lists no jobs yet"
        if unfinished == 0:
            return "none of its jobs is unfinished: it is between jobs or finishing, and its own conclusion settles it"
        settle = self.config.advisory_settle
        age = age_of(last, self.clock.time())
        if age is None:
            return f"its newest job stamp ({last_job}, {last}) is unreadable or in the future (untimed)"
        if age < settle:
            return (
                f"its job list last changed {fmt_age(age)} ago ({last_job}), inside the {fmt_age(settle)}"
                " settle a dependent job may still appear in"
            )
        return None

    def run_stopped_hold(self, run_id: str) -> tuple[str, bool] | None:
        """``run_stopped_hold``: None when advisory jobs alone explain a run's ``cancelled`` -- at
        least one advisory job stopped or left unfinished, every non-advisory job green (ludics#958:
        the advisory macOS jobs of the non-advisory ``skill scripts`` workflow, cancelled at their
        ``timeout-minutes`` cap, held the gate to its ceiling, and ``merge --wait`` reran the run
        and refused 7 over it). Else the reason the release did not apply, naming the first job in
        the list's order that kept it, and whether it is that the job list could not be read. No
        settle: the run is completed, so no job of it appears later. A non-advisory red, waived or
        not, keeps the hold -- the run's own conclusion is what this explains, and a cancel beside a
        red is not the advisory jobs' alone."""
        raw = self.run_jobs(run_id)
        if raw is None:
            failure = self.session.err_line() or "it did not answer"
            return f"its job list could not be read ({failure}), so whether only advisory jobs were stopped is unknown", True
        explained = False
        for line in herestring_lines(raw):
            jname, jconcl, _times = tab_fields(line, 3)
            if not jname:
                continue
            klass = conclusion_class(jconcl)
            if self.is_advisory(jname):
                explained = explained or klass in ("nogo", "pending")
                continue
            if klass != "green":
                return f"job {shlex.quote(jname)} concluded {jconcl} and is not advisory", False
        if not explained:
            return "no advisory job of it was stopped, so its cancel is not theirs", False
        return None

    def read_runs(self, sha: str) -> str | None:
        """The head's workflow runs, newest first, one projection row each; None when the read
        failed. Kept for the round (``_round_runs``) for the orphan scan."""
        result = self.session.retry(
            "read",
            [
                "api",
                "--paginate",
                f"repos/{self.repo}/actions/runs?head_sha={sha}&per_page=100",
                "--jq",
                '.workflow_runs[] | [(.created_at // "-"), ((.id // 0) | tostring),\n'
                "          ((.workflow_id // 0) | tostring),\n"
                '          (.event // "-"), (.name // "-"), (.status // "unknown"), (.conclusion // "pending"),\n'
                '          ((.check_suite_id // "-") | tostring)]\n'
                "          | @tsv",
            ],
        )
        if not isinstance(result, GhOk):
            self.read_failure = self._failure_of(result)
            self._round_runs_failure = self.session.err_line()
            return None
        raw = newest_first_lines(result.stdout, 1, 2)
        runs: list[HeadRun] = []
        for line in herestring_lines(raw):
            created, rid, wid, event, name, status, concl, _suite = tab_fields(line, 8)
            if rid:
                runs.append(HeadRun(rid, wid, event, name, status, concl, created))
        self._round_runs = runs
        self._round_raw = raw
        return raw

    def find_orphans(self, sha: str) -> list[Orphan]:
        """The jobs of the head's runs that never got a runner (runners.py), read on a round with
        no verdict (or a red ``settling`` holds); the run list is this round's when ``run_signal``
        read it, else read here."""
        if self._round_runs is None and (self._round_runs_failure is not None or self.read_runs(sha) is None):
            return []
        runs = self._round_runs or []

        def wanted(name: str) -> bool:
            return self.selects(name) if self.select else not self.is_advisory(name)

        return scan(
            self.session, self.repo, runs, self.clock.time(), self.config.never_started, self.is_advisory, wanted
        )

    def run_signal(self, sha: str, pr_at: str, checks: int, base_sha: str, head_ref: str, pr: str) -> RunSignal:
        """``run_signal``: the head's workflow runs, read whenever the check fold leaves nothing to
        wait for, and able to overrule it (see the shell's comment for every round)."""
        repo = self.repo
        waived_runs = ""
        # The round's run read, made once a round: a read the fold's workflow lookup already saw
        # fail is reported as it failed, not asked again (ludics#929).
        if self._round_raw is not None:
            raw = self._round_raw
        elif self._round_runs_failure is None:
            raw = self.read_runs(sha)
        else:
            raw = None
        if raw is None:
            return RunSignal(
                3,
                0,
                waived_runs,
                f"the workflow runs for this head could not be read ({self._round_runs_failure or ''})",
                unread=self.read_failure,
            )
        self.run_state = " ".join(
            f"{f[1]}:{f[5]}:{f[6]}" for f in (tab_fields(line, 8) for line in herestring_lines(raw)) if f[1]
        )
        # The newest completed run of each workflow and event, by id: the one the fold judges.
        seen: dict[str, str] = {}
        red_rows: list[str] = []
        # Each run in flight: its id, suite and name, and the id of a completed run of its workflow
        # and event listed above it (created after it) when it is a ``queued`` ``pull_request``
        # run, else "".
        inflight_ids: list[tuple[str, str, str, str]] = []
        cancelled_ids: list[str] = []
        runs = nogo = 0
        for line in herestring_lines(raw):
            _created, rid, wid, event, name, status, concl, suite = tab_fields(line, 8)
            if not rid:
                continue
            if self.is_advisory(name):
                continue
            key = f"{wid}/{event}"
            if status != "completed" or conclusion_class(concl) == "pending":
                later = seen.get(key, "") if status == "queued" and event == "pull_request" else ""
                inflight_ids.append((rid, suite or "-", name, later))
                continue
            if key in seen:
                continue
            seen[key] = rid
            runs += 1
            cls = conclusion_class(concl)
            match cls:
                case "red":
                    red_rows.append(f"{rid}\t{name}\t{concl}\t{suite or '-'}")
                case "nogo":
                    if concl == "cancelled":
                        cancelled_ids.append(f"{rid}\t{name}")
                        # --override's record of a run cancelled at the first read (#1036), made
                        # here so a run in flight beside it, which ends this read early, does not
                        # keep it from the record. Keyed by run id, apart from a red run's key:
                        # the waiver covers the run while it reads cancelled, never a red of it.
                        if self.waive_mode == "record":
                            self.waived.add(f"cancelled-run:{rid}")
                    else:
                        nogo += 1
                case "green" | "pending":
                    pass
                case _:
                    assert_never(cls)
        red = 0
        red_note = ""
        # Red runs whose job list did not answer (ludics#929): not explained, and not unexplained
        # either. A red the round did read decides it first; else the round is unread, a 3 that a
        # wait reads again (``_unread``), the first failure's line its reason, and the most final
        # kind among them how it failed (a refusal, or a budget stop, outranks a transport failure).
        unread_jobs = 0
        red_ids: list[str] = []
        unread_what = unread_line = ""
        unread_kind: Unread = "unanswered"
        for row in red_rows:
            rid, rname, rconcl, rsuite = tab_fields(row, 4)
            if not rid:
                continue
            explained = self.run_red_is_advisory_only(rid, rsuite)
            if explained == 0:
                continue
            if explained == 2:
                waived_runs += f"{rid} job {rname}\n"
                continue
            if self.waive_mode == "record" or (self.waive_mode == "apply" and f"run:{rid}" in self.waived):
                waived_runs += f"{rid} run {rname}\n"
                continue
            if explained == 3:
                unread_jobs += 1
                if not unread_what:
                    unread_what = f"read the jobs of workflow run {rid} ({rname}, {rconcl}) of {repo} @{sha[:8]}"
                    unread_line = self.session.err_line() or "it did not answer"
                if unread_kind == "unanswered":
                    unread_kind = self.read_failure
                continue
            red += 1
            red_ids.append(rid)
            red_note = red_note or f"{rname} ({rconcl})"
        if red > 0:
            return RunSignal(
                1,
                red,
                waived_runs,
                f"{red} workflow run(s) for this head concluded red with no build check"
                f" to show for it — {red_note}; a run that fails before its jobs start leaves nothing in the"
                " check list",
                red_ids=red_ids,
            )
        if unread_jobs > 0:
            return RunSignal(
                3,
                0,
                waived_runs,
                f"{unread_line}; the job list of {unread_jobs} red workflow run(s) for this head could"
                " not be read, so whether only advisory jobs explain the red is unknown",
                unread=unread_kind,
                unread_what=unread_what,
            )
        # A run that never started, beside a later run that completed (ludics#1107: in the Actions
        # outage of 2026-11-11 such runs sat queued for hours, refused cancel and rerun alike, and
        # held heads whose reopened PR had drawn fresh runs that passed). BOUNDARY, a fail-closed
        # allowlist: the run's event is ``pull_request`` and it reads exactly ``queued``; its job
        # list was READ this round and lists no job; and a ``pull_request`` run of the same
        # workflow on this head, created after it, has completed -- that run is the one judged,
        # whatever it concluded. Such a run is named and not waited for. Everything else in flight
        # keeps ``run_inflight_hold``: a run with any job (it started, so a later green run does
        # not hide what it ran), any other status, a job list that did not answer, a never-started
        # run with no later completed run, and every other event -- a second ``pull_request`` run
        # on one head is the same build asked for again (a reopen), while two ``workflow_dispatch``
        # or ``push`` runs are invocations of their own, and a queued one of those is superseded
        # by nothing.
        inflight = released = 0
        holds = superseded = ""
        for rid, rsuite, rname, later in inflight_ids:
            jobs = self.run_jobs(rid)
            if later and jobs is not None and not any(tab_fields(job, 4)[0] for job in herestring_lines(jobs)):
                superseded += (
                    f"  superseded  workflow run {rid} ({shlex.quote(rname)}): queued with no job, never"
                    f" started; run {later} of the same workflow and event completed on this head after it"
                    " — not waited for\n"
                )
                continue
            runs += 1
            hold = self._inflight_hold(jobs, rsuite)
            if hold is None:
                released += 1
            else:
                inflight += 1
                holds += f"  held     workflow run {rid} ({shlex.quote(rname)}): {hold}\n"
        if inflight > 0:
            return RunSignal(
                4,
                0,
                waived_runs,
                f"{inflight} workflow run(s) for this head have no conclusion yet (queued,"
                " running, or completed with none recorded) — their check runs may not exist yet",
                holds=holds,
                superseded=superseded,
            )
        # Cancelled runs are asked about their jobs only now, with nothing red or in flight left to
        # decide the round first (ludics#958). A held one is the stopped 4 it always was, with a
        # held line; an unread job list holds as well, the old reading, and says so. A held one
        # --override recorded at the first read (#1036) is waived instead: a "cancelled" entry.
        stopped_released = 0
        for entry in cancelled_ids:
            rid, rname = tab_fields(entry, 2)
            stopped_hold = self.run_stopped_hold(rid)
            if stopped_hold is None:
                stopped_released += 1
            elif f"cancelled-run:{rid}" in self.waived:
                waived_runs += f"{rid} cancelled {rname}\n"
            else:
                nogo += 1
                holds += f"  held     workflow run {rid} ({shlex.quote(rname)}): {stopped_hold[0]}\n"
        if nogo > 0:
            return RunSignal(
                4,
                0,
                waived_runs,
                f"{nogo} workflow run(s) for this head completed stopped-not-judged (cancelled,"
                " stale or action_required) with no build check behind them — stopped is not absence and"
                " not a verdict: re-run the workflow",
                stopped=True,
                holds=holds,
                superseded=superseded,
            )
        if checks > 0 and runs > 0:
            if released > 0 or stopped_released > 0:
                parts = [f"{released} of them still running, but only advisory jobs"] if released else []
                if stopped_released:
                    parts.append(f"{stopped_released} of them cancelled only in advisory jobs")
                source = ("SHIP_PR_ADVISORY_CHECKS" if self.config.advisory_from_env else
                          ADVISORY_FILE if self._advisory_from_file else "built-in defaults")
                reason = (
                    f"{runs} workflow run(s) for this head are judged — {'; '.join(parts)}"
                    f" ({source})"
                )
            else:
                reason = f"{runs} workflow run(s) for this head are finished and judged"
            return RunSignal(0, 0, waived_runs, reason, superseded=superseded)
        pushed = self.session.retry("read", ["api", f"repos/{repo}/commits/{sha}", "--jq", ".commit.committer.date"])
        pushed_at = pushed.stdout if isinstance(pushed, GhOk) else ""
        age = freshest_age(pushed_at, pr_at, now=self.clock.time())
        if age is None:
            return RunSignal(
                3,
                0,
                waived_runs,
                "no usable clock for this head: neither its commit date nor the PR's updated_at"
                f" could be read ({self.session.err_line()}), or both are in the future, so the run-creation window"
                " is unknown",
                # The PR's updated_at came from a head read that answered, so only a commit read
                # that failed can still change: an answered one decides nothing again (``unusable``).
                unread="unusable" if isinstance(pushed, GhOk) else self._failure_of(pushed),
                superseded=superseded,
            )
        if runs > 0:
            seen_text = f"{runs} workflow run(s) for this head finished and left no build check behind"
        else:
            seen_text = "no workflow run exists for this head"
        grace = self.config.absent_grace
        if runs == 0 and age < grace:
            reads = Reads(self.session, repo, self.config.limits, self.is_advisory)
            why = head_within_paths_ignore(reads, pr, sha, base_sha, head_ref)
            if why is not None:
                return RunSignal(
                    0,
                    0,
                    waived_runs,
                    "no workflow run exists for this head, and none can be created by"
                    f" {why}: every trigger of theirs that this change fires is either filtered"
                    " out by its own paths-ignore — every commit from the merge base up changes only ignored"
                    " paths — or cannot reach this branch at all",
                    superseded=superseded,
                )
        if age < grace:
            return RunSignal(
                4,
                0,
                waived_runs,
                f"{seen_text}, and the head has been in place at most {fmt_age(age)} — inside the"
                f" {fmt_age(grace)} run-creation grace (SHIP_PR_BASE_ABSENT_GRACE), so a run"
                " may still appear",
                superseded=superseded,
            )
        return RunSignal(
            0,
            0,
            waived_runs,
            f"{seen_text} in the {fmt_age(age)} since it appeared — past the {fmt_age(grace)} run-creation grace",
            superseded=superseded,
        )

    def checkless_reds(self, rows: list[str]) -> int:
        """The red runs a ``red`` fold would leave unreported (#1066): ``run_signal`` is not asked
        once a check is red, so a run that failed before it created any check (a
        ``startup_failure``) was named only after the next push. Reads the round's run read (made
        by ``drop_advisory_workflows``; an unread one is one note line and changes nothing) and
        writes one report line per red run that nothing above explains; returns how many.

        Boundary, fail-closed: a completed, non-advisory run, the newest of its workflow and event
        as ``run_signal`` keeps it, whose conclusion is red is reported unless (a) its check suite
        has a red or waived row in the fold -- the fold's own lines already name that red, which is
        what t1039's attempt counted twice -- (b) its job list says advisory jobs alone explain it
        (``run_red_is_advisory_only``), or (c) the override waives it, as ``run_signal`` waives a
        run. A job list that did not answer is a note line, never a 3: the verdict is red already.
        Runs in flight, stopped runs and green runs are not read here: a red verdict stands
        without them, and ``run_signal`` judges them when nothing is red. Under ``--check`` the
        run list is not read at all, as on every other verdict."""
        if self._round_raw is None:
            if self._round_runs_failure is not None:
                self.check_lines += (
                    f"  unread   the workflow runs for this head could not be read ({self._round_runs_failure}),"
                    " so a red run with no build check behind it would not be listed\n"
                )
            return 0
        explained_suites = {
            suite
            for cls, _name, _concl, _url, suite, _status in (tab_fields(row, 6) for row in rows)
            if cls in ("red", "waived") and suite and suite != "-"
        }
        seen: set[str] = set()
        red = 0
        for line in herestring_lines(self._round_raw):
            _created, rid, wid, event, name, status, concl, suite = tab_fields(line, 8)
            if not rid or self.is_advisory(name):
                continue
            if status != "completed" or conclusion_class(concl) == "pending":
                continue
            key = f"{wid}/{event}"
            if key in seen:
                continue
            seen.add(key)
            if conclusion_class(concl) != "red" or (suite or "-") in explained_suites:
                continue
            explained = self.run_red_is_advisory_only(rid, suite or "-")
            if explained in (0, 2):
                continue
            label = f"workflow run {rid} ({shlex.quote(name)}, {concl})"
            if self.waive_mode == "record" or (self.waive_mode == "apply" and f"run:{rid}" in self.waived):
                if self.waive_mode == "record":
                    self.waived.add(f"run:{rid}")
                self.run_waived += 1
                self.check_lines += (
                    f"  RED      {label} (no build check behind it — WAIVED: red when --override was given)\n"
                )
                continue
            if explained == 3:
                failure = self.session.err_line() or "it did not answer"
                self.check_lines += (
                    f"  unread   {label}: its job list could not be read ({failure}), so whether only advisory"
                    " jobs explain its red is unknown\n"
                )
                continue
            red += 1
            self.red_runs.append(rid)
            self.check_lines += (
                f"  RED      {label} — no build check behind it: a run that fails before its jobs start"
                " leaves nothing in the check list\n"
            )
        return red

    def failed_runs(self) -> tuple[list[tuple[str, str]], str]:
        """``merge --wait --rerun-failed-once``'s targets (#1065), for a red round: the workflow run
        of each red check of the fold, by its check suite in the round's run read, then the red runs
        no check shows (``red_runs``), each once, as "(run id, run name)". Every red must map to a
        run, or a rerun cannot clear the verdict: then no target, and the reason. Advisory checks
        and runs are no red here (the fold and ``run_signal`` left them out), so none is a target."""
        if self._round_raw is None:
            return [], "the head's workflow runs could not be read, so no red check maps to a run"
        by_suite: dict[str, tuple[str, str]] = {}
        names: dict[str, str] = {}
        for line in herestring_lines(self._round_raw):
            _created, rid, _wid, _event, name, _status, _concl, suite = tab_fields(line, 8)
            if not rid:
                continue
            names.setdefault(rid, name)
            if suite and suite != "-":
                by_suite.setdefault(suite, (rid, name))
        out: list[tuple[str, str]] = []
        for job in self.red_jobs:
            hit = by_suite.get(job.suite)
            if hit is None:
                return [], (
                    f"red check {shlex.quote(job.name)} is of no workflow run of this head (another app's"
                    " check, or a suite the run list does not show), so no rerun can clear it"
                )
            if hit not in out:
                out.append(hit)
        for rid in self.red_runs:
            hit = (rid, names.get(rid, "-"))
            if hit not in out:
                out.append(hit)
        return out, ""

    # --- the gate -------------------------------------------------------------------------------------

    def _failure_of(self, result: GhFailed | GhUnanswered) -> Unread:
        """How a read that did not answer failed: a ``GhFailed`` is GitHub's refusal, which no retry
        changes; a ``GhUnanswered`` is the polling budget's when ``quota_stopped``, else transport."""
        match result:
            case GhFailed():
                return "refused"
            case GhUnanswered():
                return "held" if self.session.quota_stopped() else "unanswered"

    def _pr_fields(self, pr: str, with_updated: bool) -> tuple[Literal["ok"] | Unread, list[str]]:
        """The head read: ``ok`` with its fields, or how it failed (``Unread``: ``refused``,
        ``held`` or ``unanswered``; ``unusable`` is never the head read's)."""
        if with_updated:
            jq = (
                '[(.head.sha // "-"), (.updated_at // "-"), (.base.sha // "-"), (.head.ref // "-")]\n'
                '          | map(if type == "string" and length > 0 then . else "-" end) | @tsv'
            )
        else:
            jq = (
                '[(.head.sha // "-"), (.base.sha // "-"), (.head.ref // "-")]\n'
                '            | map(if type == "string" and length > 0 then . else "-" end) | @tsv'
            )
        result = self.session.retry("read", ["api", f"repos/{self.repo}/pulls/{pr}", "--jq", jq])
        text = result.stdout if isinstance(result, GhOk) else ""
        fields = [placeholder(f) for f in tab_fields(text, 4 if with_updated else 3)]
        match result:
            case GhOk():
                return "ok", fields
            case GhFailed() | GhUnanswered():
                return self._failure_of(result), fields

    def _unread(self, kind: Unread, deadline: int, what: str, failure: str, then: str) -> bool:
        """A read of the gate's that did not answer: under a wait with budget left, one failed poll,
        not the end of the wait -- recorded, warned, and True: pause and read again (the head read
        from the start; a round's read, the whole round). Otherwise False, the verdict ``unknown``,
        and the warning naming every failure and ``then`` (what the unread signal is): the caller's
        3. ``what`` is "<verb> <the thing read>", as the warning says it.

        BOUNDARY, a fail-closed allowlist. What rides out, when the failure is ``unanswered`` (the
        session's attempts ran out on transport, or the head read answered without a SHA): the
        gate's OWN reads that decide a round -- the head's first read and each round's re-read
        (ludics-lite#795), the round's check-run read (``build_checks``) and its workflow-run read
        (``read_runs``, and ``run_signal``'s commit-date read behind a run-less head's clock;
        ludics#808), and the job list of a red run the round reads to see whether only advisory
        jobs explain it (``run_red_is_advisory_only``, ludics#929; a red the round did read decides
        the round first). Not ridden out: a refused read (a 4xx, which no retry changes); one the polling
        budget stopped (budget.py already waits a quota hold out within the wait, so what reaches
        here outlasts it, or is a state-directory error); answers that decide nothing however often
        they are read (``unusable``: a head with no usable clock); the reads whose failure is not a 3
        today (an unfinished run's job list, read as in flight: a 4 the wait already waits on; and
        the orphan scan's); and merge's own
        head reads beside a write (the recovery's before its rerun, the re-read after a call lost a
        race to the base), which fail closed because a write follows."""
        self.unread.append(f"{what}: {failure}")
        now = self.clock.now()
        if kind == "unanswered" and now < deadline:
            warn(
                f"could not {what} ({failure}); failed read {len(self.unread)} of this wait, reading it"
                f" again within the wait ({fmt_age(deadline - now)} left). Nothing is judged from this round.",
            )
            return True
        self.verdict = "unknown"
        match kind:
            case "refused":
                why = "GitHub refused the read, which no retry changes"
            case "held":
                why = "the polling budget made no call for it, which no read inside this wait changes"
            case "unusable":
                why = "what it answered decides nothing, which reading it again does not change"
            case "unanswered" if len(self.unread) > 1:
                why = f"{len(self.unread)} reads failed during this wait, and its budget is spent"
            case "unanswered":
                why = "with no wait left to read it again in"
        warn(f"could not {what} ({failure}); {why}. {then}")
        return False

    def unread_note(self) -> str:
        """The failed reads the last wait read past, for a report's last word; "" for none."""
        n = len(self.unread)
        if n == 0:
            return ""
        return (
            f"{self.repo}: {n} read(s) failed during this wait and were read again within it"
            f" (last: {self.unread[-1]})"
        )

    def _runs_unread(self, sig: RunSignal, pr: str, sha: str, deadline: int, then: str) -> bool:
        """``run_signal``'s 3 through ``_unread`` (ludics#808). The round's waiver recording, if this
        is the recording round, already took the check reds it read: the next round applies that
        record rather than recording again, so a check that turned red during the pause is never
        waived as red when --override was given -- and a run-level red the round never reached is
        not waived either (refused as red: fail closed)."""
        if self.waive_mode == "record":
            self.waive_mode = "apply"
        return self._unread(
            sig.unread,
            deadline,
            sig.unread_what or f"read the workflow runs of {self.repo}#{pr} @{sha[:8]}",
            sig.reason,
            then,
        )

    def _superseded(self, pr: str, sha: str, current: str) -> None:
        self.verdict = "superseded"
        cli.say(
            f"build signal {self.repo}#{pr}: SUPERSEDED — observed {sha}, current {current};"
            " re-run for the new head"
        )

    def _moved(self, pr: str, sha: str) -> bool:
        """After a round read the wait reads past (ludics#808): has the head moved? A round that
        failed skips the round's own head re-read, so without this a head pushed over a failing read
        is not seen until the wait is spent, and the wait ends 3 rather than 5. One read; when it
        does not answer, the round already counts as one failed poll and the next round reads it
        again, so it is neither recorded nor a failure of its own."""
        kind, (current, _base, _ref) = self._pr_fields(pr, with_updated=False)
        if kind == "ok" and current and current != "null" and current != sha:
            self._superseded(pr, sha, current)
            return True
        return False

    def conflicting(self, pr: str) -> bool:
        """Does the PR conflict with its base (ludics#1110)? GitHub creates no ``pull_request`` run
        for a head it cannot merge with its base, so such a head reads as one whose runs have not
        started, and no wait ends that: lukstafi/ocannl-staging#1955 waited over two hours for jobs
        that were never created.

        BOUNDARY, a fail-closed allowlist. One REST read of the PR's ``mergeable_state``, made by
        ``check`` only on a round with nothing to wait for. True for exactly ``dirty``. GitHub
        computes the field lazily, so ``unknown`` is "not computed yet" and never a conflict; it, any
        other state, and a read that did not answer are all False, and the next such round reads
        again. The read names neither the head nor the base: it follows the round's head re-read,
        and a head pushed between the two reads ``unknown`` while GitHub recomputes."""
        result = self.session.retry(
            "read", ["api", f"repos/{self.repo}/pulls/{pr}", "--jq", MERGEABLE_STATE_JQ]
        )
        return isinstance(result, GhOk) and result.stdout == "dirty"

    def _pause(self, deadline: int, last_pause: int | None, changed: bool) -> int:
        """Sleep the budget's next pause (``pause``), clipped at the deadline; the pause taken."""
        budget = self.session.budget
        cap = budget.build_cap if budget is not None else self.config.checks_interval
        if (self.verdict == "pending" or self.settling()) and self.check_queued == 0:
            cap = min(cap, 2 * self.config.checks_interval)
        sleep_for = pause(self.config.checks_interval, cap, last_pause, changed)
        self.clock.sleep(min(sleep_for, max(0, deadline - int(self.clock.now()))))
        return sleep_for

    def check(self, pr: str, wait_for: int, waive: bool = False) -> int:
        """``gate_checks <pr> <wait> [waive]``: read the head and judge its build signal, printing the
        report. 0 green or a confirmed absence; 1 red (a check, a checkless run, or every red
        waived); 3 unread; 4 no verdict yet; 5 the head was superseded. Under ``select`` (``checks
        --check``, #569) the fold is over the matching checks alone, and 2 is a selection that
        matches no check run while none can still appear.

        What no wait resolves ends it, still 4. A QUIET round is one whose verdict is ``unjudged``:
        no check of the fold is running, and the run list holds the head (a run with no job yet, a
        head with no run inside the creation grace, a stopped run). Once the rounds of this wait
        have been quiet for ABSENT_GRACE seconds on end:
        - under ``conflicts_on``, each quiet round asks ``conflicting``; a conflict is the verdict
          ``conflict`` (ludics#1110). A round that reads ``absent`` asks at once, grace or no: the
          creation grace has already passed for it, and a conflict is why no run exists.
        - with no ``recover`` (``checks``; ``merge --wait``'s recovery reruns a cancelled run
          itself), a round held by stopped runs alone, nothing in flight, ends the wait
          (ludics#1097) once the rounds have been held THAT way for the grace, counted apart from
          the quiet time before it: no check run comes of a stopped run until someone re-runs it,
          and the grace is what lets a re-run just sent show as a run in flight first."""
        repo = self.repo
        budget = self.session.budget
        # A wait is the PR's build observer (the polling budget, budget.py): one at a time, and it
        # may wait a quota hold out within its ceiling, the same ceiling as its own. Both run from
        # the command's start (``wait_from``, which `checks` and `merge` take before their own first
        # read), so neither a hold nor a preflight read extends the advertised wait. A single read
        # is neither.
        started = self.clock.now()
        if wait_for > 0 and budget is not None:
            budget.observe("build", wait_for, repo, pr)
            if budget.wait_from is not None:
                started = budget.wait_from
        deadline = started + wait_for
        self.deadline = deadline
        self.gate_base = ""
        self.orphans = []
        self.waived = set()
        self.run_waived = 0
        self.check_waived = 0
        self.waived_cancelled = 0
        self.waive_mode = "record" if waive else ""
        self.unread = []
        last_pause: int | None = None
        unknown = "The build signal is UNKNOWN, which is NOT 'nothing is red'."
        while True:
            kind, (sha, pr_at, base_sha, head_ref) = self._pr_fields(pr, with_updated=True)
            if kind == "ok" and sha:
                break
            failure = self.session.err_line() or "it answered no SHA"
            if not self._unread(
                "unanswered" if kind == "ok" else kind, deadline, f"read {repo}#{pr}'s head SHA", failure, unknown
            ):
                return 3
            last_pause = self._pause(deadline, last_pause, False)
        self.check_sha = sha
        beat = started
        run_why = ""
        last_sig = ""
        quiet_since: float | None = None
        stopped_since: float | None = None
        while True:
            if budget is not None:
                budget.waited = False
            stopped = False
            self.run_state = ""
            self._round_runs = None
            self._round_raw = None
            self._round_runs_failure = None
            rows = self.build_checks(sha)
            if rows is None:
                # A round whose check runs did not answer judges nothing: under a wait with budget
                # left it is one failed poll (ludics#808), and the round is read again. Nothing was
                # recorded for the waiver yet, so a recording round stays the recording round.
                if not self._unread(
                    self.read_failure,
                    deadline,
                    f"read the checks of {repo}#{pr} @{sha[:8]}",
                    self.session.err_line() or "it did not answer",
                    unknown,
                ):
                    return 3
                if self._moved(pr, sha):
                    return 5
                last_pause = self._pause(deadline, last_pause, False)
                continue
            rows = self.drop_advisory_workflows(sha, rows)
            if self.waive_mode:
                rows = self.apply_waiver(rows)
            if self.select:
                rows = [row for row in rows if self.selects(tab_fields(row, 6)[1])]
            self.summarize(rows)
            self.run_waived = 0
            self.checkless_red = 0
            self.red_runs = []
            self.gate_base = base_sha
            nomatch = ""
            run_holds = ""
            self.check_holds = ""
            if self.select and self.check_total == 0:
                # A selection that matches no check run yet asks the run list one question: can a
                # matching run still appear? A run in flight, or a run-less head inside the
                # creation grace, holds (rc 4). Anything else -- every run finished (stopped ones
                # included: only a re-run creates checks for them), or past the grace with none --
                # means it cannot, and a selection that matches nothing is a refusal, never green
                # and never ABSENT. The fold's count goes in as 1 so a
                # finished run list answers at once rather than waiting the grace out: the grace
                # is for a run not yet created, and finished runs have created their checks.
                sig = self.run_signal(sha, pr_at, 1, base_sha, head_ref, pr)
                if sig.rc == 3:
                    if not self._runs_unread(
                        sig, pr, sha, deadline, "Whether a check matching --check can still appear is UNKNOWN."
                    ):
                        return 3
                    if self._moved(pr, sha):
                        return 5
                    last_pause = self._pause(deadline, last_pause, False)
                    continue
                self.check_lines += sig.superseded
                match sig.rc:
                    case 4 if not sig.stopped:
                        self.verdict = "unjudged"
                        run_why = f"no check run matches --check {shlex.quote(self.select)} yet — {sig.reason}"
                        run_holds = sig.holds
                        self.check_lines += run_holds
                        self.check_holds = run_holds
                    case _:
                        self.verdict = "unknown"
                        nomatch = sig.reason
            elif self.select:
                # Checks match: their fold is the verdict. The run list speaks for the whole head
                # -- the slow run the selection exists to leave out among it -- so it is not read.
                pass
            elif self.verdict != "red":
                sig = self.run_signal(sha, pr_at, self.check_total, base_sha, head_ref, pr)
                run_why = sig.reason
                run_holds = sig.holds
                self.check_lines += sig.superseded
                for entry in herestring_lines(sig.waived_runs):
                    if not entry:
                        continue
                    self.run_waived += 1
                    rid = _before_space(entry)
                    rest = _after_space(entry)
                    if _before_space(rest) == "job":
                        self.check_lines += (
                            f"  RED      workflow run {_after_space(rest)} (red through a check above that is WAIVED)\n"
                        )
                    elif _before_space(rest) == "cancelled":
                        self.waived_cancelled += 1
                        self.check_lines += (
                            f"  stopped  workflow run {_after_space(rest)} (cancelled — WAIVED: cancelled when"
                            " --override was given)\n"
                        )
                    else:
                        if self.waive_mode == "record":
                            self.waived.add(f"run:{rid}")
                        self.check_lines += (
                            f"  RED      workflow run {_after_space(rest)} (no build check behind it — WAIVED:"
                            " red when --override was given)\n"
                        )
                match sig.rc:
                    case 1:
                        self.verdict = "runred"
                        self.check_red = sig.red
                        self.red_runs = list(sig.red_ids)
                    case 3:
                        if not self._runs_unread(
                            sig,
                            pr,
                            sha,
                            deadline,
                            "The checks alone are not the build signal, so this is UNKNOWN, which is NOT"
                            " 'nothing is red'.",
                        ):
                            return 3
                        if self._moved(pr, sha):
                            return 5
                        last_pause = self._pause(deadline, last_pause, False)
                        continue
                    case 4:
                        if self.verdict != "pending":
                            self.verdict = "unjudged"
                            self.check_lines += run_holds
                            self.check_holds = run_holds
                            stopped = sig.stopped
                    case _:
                        if self.run_waived and self.verdict in ("green", "absent"):
                            self.verdict = "waived"
                        if "still running, but only advisory jobs" in run_why:
                            self.check_lines += f"  running  {run_why} — not waited for\n"
                        elif "cancelled only in advisory jobs" in run_why:
                            self.check_lines += f"  stopped  {run_why} — not rerun\n"
            else:
                # A red fold is the verdict, and the run list cannot overrule it; it is read for the
                # report alone, so a red no check shows is named beside the checks' (#1066).
                self.checkless_red = self.checkless_reds(rows)
            if self.waive_mode == "record":
                self.waive_mode = "apply"
            kind, (current, reread_base, reread_ref) = self._pr_fields(pr, with_updated=False)
            if kind != "ok" or not current or current == "null":
                # A round whose head could not be confirmed judges nothing: under a wait with budget
                # left it is one failed poll (ludics-lite#795), and the whole round is read again,
                # against the base and ref the last read that answered gave.
                if not self._unread(
                    "unanswered" if kind == "ok" else kind,
                    deadline,
                    f"re-read {repo}#{pr}'s head SHA",
                    self.session.err_line() or "it answered no SHA",
                    unknown,
                ):
                    return 3
                last_pause = self._pause(deadline, last_pause, False)
                continue
            base_sha, head_ref = reread_base, reread_ref
            if current != sha:
                self._superseded(pr, sha, current)
                return 5
            # What no wait resolves (the docstring), asked before the hold check below so a hold
            # waited out inside the conflict read re-reads the round like any other.
            if self.verdict != "unjudged":
                quiet_since = None
            elif quiet_since is None:
                quiet_since = self.clock.now()
            quiet = quiet_since is not None and self.clock.now() - quiet_since >= self.config.absent_grace
            if not stopped:
                stopped_since = None
            elif stopped_since is None:
                stopped_since = self.clock.now()
            conflict = self.conflicts_on and (quiet or self.verdict == "absent") and self.conflicting(pr)
            # A round that waited a quota hold out between its reads is two moments, not one: a
            # check read green before the wait may have been re-run since. Read the round again.
            if budget is not None and budget.waited:
                warn("a quota hold was waited out inside this round's reads; reading the round again")
                continue
            if conflict:
                self.verdict = "conflict"
                break
            if nomatch:
                warn(
                    f"REFUSING: no check run of {repo}#{pr} @{sha[:8]} matches --check {shlex.quote(self.select)},",
                    f"and none can still appear ({nomatch}). A selection that matches nothing is not a",
                    "verdict; check the name against `gh pr checks` and the ERE.",
                )
                return 2
            # Jobs that never got a runner (runners.py): looked for after the head re-read above, so
            # a moved head is 5 before ``recover`` writes anything. A round that finds one ends the
            # wait, unless ``recover`` (merge --wait's one recovery) asks to keep waiting -- through
            # a verdict the fold has stopped at (``mixed``) too, since the rerun is what it awaits.
            # A red ``settling`` holds is looked through too: a pending check with no runner would
            # hold ``--settle`` to its bound for nothing (``checks`` has no ``recover``).
            keep = False
            held = ""
            self.orphans = []
            red_settled = self.recover_red and self.verdict in ("red", "runred") and self.check_pending == 0
            if self.orphans_on and (self.verdict in ("pending", "unjudged", "mixed") or self.settling() or red_settled):
                if not red_settled:
                    self.orphans = self.find_orphans(sha)
                for orphan in self.orphans:
                    self.check_lines += report_line(orphan, repo, shlex.quote)
                if self.recover is not None:
                    step = self.recover(self.orphans, self._round_runs or [])
                    match step:
                        case Stop():
                            break
                        case Wait(until=until, why=why):
                            keep = True
                            held = why
                            if until > deadline:
                                deadline = until
                                self.deadline = deadline
                                if budget is not None:
                                    budget.wait_until = until
                        case Idle():
                            pass
                        case _:
                            assert_never(step)
                elif self.orphans:
                    break
            now = self.clock.now()
            if self.verdict not in ("pending", "unjudged") and not keep and not self.settling():
                break
            if now >= deadline:
                break
            if stopped_since is not None and now - stopped_since >= self.config.absent_grace and self.recover is None:
                break
            if now - beat >= self.config.checks_heartbeat:
                # A recovery's Wait that names what it holds for (a settled red waiting on its run,
                # #1065) speaks for a round with no check left running, whose list would be empty.
                if self.verdict == "unjudged":
                    note = "; ".join([run_why, *(h.strip() for h in herestring_lines(run_holds) if h)])
                elif held and self.check_pending == 0:
                    note = held
                else:
                    note = f"{self.check_pending} check(s) running: {running_list(self.pending_names)}"
                warn(
                    f"still waiting on {repo}#{pr} @{sha[:8]}: no verdict after {(now - started) // 60} of",
                    f"{wait_for // 60} min ({note})",
                )
                beat = now
            # The budget's pause: back to the interval after a read that saw the signal move,
            # doubling toward the build cap while a queue sits still, and capped at the remaining
            # deadline. The signal's state alone, with its runs' (ludics-lite#551): run_why is prose
            # for a person, and it carries the head's age during the run-creation grace, which moves
            # on every read.
            #
            # While every check the round waits for has a runner (a ``pending`` fold with no row
            # short of ``in_progress``; ludics-lite#740), the cap is twice the interval: a running
            # job ends on its own, and its completion is then read within 2 x SHIP_PR_CHECKS_INTERVAL
            # of a read that saw it running, not up to a build cap late. ``in_progress`` is the one
            # status read as running: queued, waiting, a missing status or any other value, a mix
            # of them with running rows, and a round with no pending row (``unjudged``) keep the
            # build cap, which #543's queue without a runner needs. The pause already slept is not
            # cut short, and a lower build cap still bounds this one.
            sig = (
                f"{self.verdict}|{self.check_pending}|{self.check_green}|{self.check_total}"
                f"|{self.run_state}"
            )
            last_pause = self._pause(deadline, last_pause, sig != last_sig)
            last_sig = sig
        note = f" ({self.check_green} build check(s) have passed so far)" if self.check_green > 0 else ""
        head = f"build signal {repo}#{pr} @{sha[:8]}"
        if self.select:
            head += f" (--check {shlex.quote(self.select)})"
        match self.verdict:
            case "red":
                also = (
                    f", and {self.checkless_red} workflow run(s) concluded red with no build check to show for it"
                    if self.checkless_red
                    else ""
                )
                cli.say(f"{head}: RED — {self.check_red} of {self.check_total} build checks failed{also}")
            case "waived" if self.waived_cancelled:
                n = self.check_waived + self.run_waived
                cli.say(
                    f"{head}: {'RED, ' if n > self.waived_cancelled else ''}CANCELLED, WAIVED — every red or"
                    f" cancelled check or run ({n}, {self.waived_cancelled} of them cancelled) was so when"
                    " --override was given; everything else has a verdict and none is red"
                )
            case "waived":
                cli.say(
                    f"{head}: RED, WAIVED — every red ({self.check_waived + self.run_waived}) was red when"
                    " --override was given; everything else has a verdict and none is red"
                )
            case "pending":
                cli.say(
                    f"{head}: NO VERDICT YET — {self.check_pending} check(s) still running:"
                    f" {running_list(self.pending_names)}"
                )
            case "mixed":
                cli.say(f"{head}: INCOMPLETE — {self.check_green} passed, the rest were stopped without a verdict")
            case "runred":
                cli.say(f"{head}: RED — {run_why}")
            case "unjudged":
                cli.say(f"{head}: NO VERDICT YET — {run_why}{note}")
            case "absent":
                cli.say(f"{head}: ABSENT — no build check ran on this commit: {run_why}")
            case "conflict":
                cli.say(
                    f"{head}: CONFLICTS with its base (mergeable_state=dirty) — GitHub builds no"
                    f" pull_request run for a head it cannot merge with its base, so no verdict comes of"
                    f" waiting ({run_why}). Merge the base in, resolve, push, and judge the new head"
                )
            case "green":
                cli.say(f"{head}: green — {self.check_green} build checks passed")
            case "" | "superseded" | "unknown":
                pass
            case _:
                assert_never(self.verdict)
        if self.images_on and self.verdict == "red":
            self.check_lines += image_lines(self.session, repo, pr, self.red_jobs, self._round_runs or [], shlex.quote)
        if self.check_lines:
            sys.stdout.write(self.check_lines)
        if self.unread:
            warn(self.unread_note())
        match self.verdict:
            case "red" | "runred" | "waived":
                return 1
            case "pending" | "mixed" | "unjudged" | "conflict":
                return 4
            case _:
                return 0


RUNNING_SHOWN = 3
RUNNING_CHARS = 160


def running_list(names: list[str]) -> str:
    """The running checks for a progress line (#569): the first RUNNING_SHOWN names, cut at
    RUNNING_CHARS, and a count of the rest -- the report lines below a verdict name every one."""
    shown = ", ".join(names[:RUNNING_SHOWN])
    if len(shown) > RUNNING_CHARS:
        shown = shown[: RUNNING_CHARS - 1] + "…"
    more = len(names) - RUNNING_SHOWN
    return shown + (f" (+{more} more)" if more > 0 else "")


def github_file_absent(session: GhSession, repo: str, leaf: str, cap: int) -> int:
    """``advisory_absent``, for any file ``.github/<leaf>`` on the default branch whose raw read
    answered 404: 0 when a directory listing that answered leaves the file out; 2 when that is not
    established (a 404 is also how GitHub answers a token without Contents access to a private
    repository); 3 when a listing did not answer. The advisory list and the merge build's config
    (mergebuild.py) are read the same way."""
    for directory in (".github", ""):
        name = leaf if directory else ".github"
        path = f"repos/{repo}/contents" + (f"/{directory}" if directory else "")
        result = session.retry(
            "read",
            ["api", path, "--jq", 'if type == "array" then ((length | tostring), (.[].name)) else empty end'],
        )
        match result:
            case GhUnanswered():
                return 3
            case GhFailed():
                if not directory:
                    return 2
                if "HTTP 404" in session.err_line():
                    continue
                return 2
            case GhOk(stdout=raw):
                count = raw.split("\n", 1)[0]
                if not is_digits(count):
                    return 2
                if int(count) >= cap:
                    return 2
                if name in raw.split("\n"):
                    return 2
                return 0
            case _:
                assert_never(result)
    return 2


def advisory_parse(text: str, where: str) -> str | None:
    """``advisory_parse``: the file's ERE lines joined by ``|`` (blank lines, ``#`` comments and a
    trailing CR aside), or None -- having said why -- for a file that is not such a list: no ERE
    line, a backreference (or an escaped backslash before a digit), a line or a join grep
    refuses (``ere.valid``)."""
    joined = ""
    n = 0
    for raw in text.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if not re.search(r"[^ \t\n\r\f\v]", line):
            continue
        if line.lstrip(" \t\n\r\f\v").startswith("#"):
            continue
        if re.search(r"\\[1-9]", line):
            warn(f"{where} holds a line with a backreference, which a list cannot keep: {line}")
            return None
        if not ere.valid(line):
            warn(f"{where} holds a line that is not an ERE grep accepts: {line}")
            return None
        n += 1
        joined = f"{joined}|{line}" if joined else line
    if n == 0:
        warn(
            f"{where} holds no ERE line (blank lines and # comments aside). An empty list would match",
            "every name; fix the file.",
        )
        return None
    if not ere.valid(joined):
        warn(f"{where}'s lines do not join into an ERE grep accepts: {joined}")
        return None
    return joined
