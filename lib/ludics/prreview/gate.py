"""The build gate that ``checks`` and ``merge`` share: is the PR head's build signal green?

Ported from pr-review.sh's ``gate_checks`` and everything it reads through (ludics-lite#403):
the advisory list and the repository's own advisory file (``advisory_policy``, #530), the
override's waiver (``apply_waiver``/``is_waived``, #392), the check fold (``build_checks``,
``summarize_checks``), and the run list that overrules it (``run_signal`` with its job reads,
#24/#38/#500) -- whose run-less head, inside the grace, asks the paths-ignore recognition
(``workflows.head_within_paths_ignore``, #176). On a round with no verdict, ``checks`` and
``merge`` also look for jobs that never got a runner (runners.py, #560/#728): named in the report,
they end the wait, unless ``merge --wait``'s one recovery keeps it.

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
from ludics.prreview.clock import Clock, FuncClock, age_of, fmt_age, freshest_age, newest
from ludics.prreview.runners import HeadRun, Idle, Orphan, Recover, Stop, Wait, report_line, scan
from ludics.prreview.shtext import herestring_lines, is_digits, placeholder, tab_fields
from ludics.prreview.workflows import RecognitionLimits, Reads, head_within_paths_ignore

DEFAULT_ADVISORY = knobs.DEFAULT_ADVISORY
ADVISORY_FILE = ".github/ship-pr-advisory-checks"


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
    "superseded", "unknown",
]


@dataclass
class RunSignal:
    """``run_signal``'s answer: its status (0 the fold stands, 1 red at the run level, 3 unread,
    4 no verdict yet), the run-level red count, the runs the waiver took out of it (one
    "<run id> <run|job> <name>" per line), and the reason line. ``stopped``: the 4 is a run that
    stopped without a verdict, with nothing in flight -- no new check run comes of it unless
    someone re-runs it, which ``checks --check`` reads as final (#569)."""

    rc: int
    red: int
    waived_runs: str
    reason: str
    stopped: bool = False


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
    check_waived: int = 0
    run_waived: int = 0
    check_passed: int = 0
    check_pending: int = 0
    check_total: int = 0
    check_green: int = 0
    # The pending checks with no runner yet: a pending row whose status is not ``in_progress``
    # (ludics-lite#740). Zero on a pending round is the wait the pause reads faster.
    check_queued: int = 0
    check_lines: str = ""
    # The names of the checks the fold left running, for the wait's progress line (#569).
    pending_names: list[str] = field(default_factory=lambda: list[str]())
    # ``checks --check <ERE>`` (#569): judge only the check runs whose name the ERE matches, grep
    # reading it as it reads the advisory list. Empty is the whole head. See ``check``.
    select: str = ""
    # The round's workflow runs, "<id> <status> <conclusion>" each, what the budget's pause keys
    # on beside the check counts (ludics-lite#551): a run moves before any check row exists.
    run_state: str = ""
    waive_mode: Literal["", "record", "apply"] = ""
    waived: set[str] = field(default_factory=lambda: set[str]())
    # Jobs that never got a runner (runners.py, ludics-lite#560/#728): looked for only when
    # ``orphans_on`` (``checks`` and ``merge``; ``base`` reads a merged head and leaves it off), on
    # a round with no verdict. ``orphans`` is the last such round's finding. ``recover`` is
    # ``merge --wait``'s one recovery (merge.py), given the round's orphans and runs: Stop ends the
    # wait, Wait keeps it (to a later deadline, after a rerun), Idle leaves the round as it is.
    # Without it, a round that finds one ends the wait: nothing it waits for moves until someone
    # reruns the run.
    orphans_on: bool = False
    orphans: list[Orphan] = field(default_factory=lambda: list[Orphan]())
    recover: Recover | None = None
    # The last ``check``'s wait deadline on ``clock``, as the wait left it: its start plus the wait,
    # moved later by a recovery's Wait (ludics-lite#764: ``merge``'s build waits behind a
    # measurement window within what is left of it). None before a check.
    deadline: int | None = None
    # The head reads of the last ``check`` that gave no SHA and were read past within its wait
    # (ludics-lite#795), each the failure's line: the report names them, as merge's final line does.
    head_unread: list[str] = field(default_factory=lambda: list[str]())
    _round_runs: list[HeadRun] | None = None
    # The round's run read as ``read_runs`` returned it, so the check fold's workflow lookup and
    # ``run_signal`` ask the API once a round.
    _round_raw: str | None = None
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
        ``run_signal`` then reads it again and says so. Under a selection nothing is advisory, and
        the run read is not made."""
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
        recording read -- and only while their key names exactly ONE row."""
        keys: list[str] = []
        for row in rows:
            cls, name, _concl, _url, suite, _status = tab_fields(row, 6)
            if cls:
                keys.append(f"check:{suite}/{name}")
        out: list[str] = []
        for row in rows:
            cls, name, concl, url, suite, status = tab_fields(row, 6)
            if not cls:
                continue
            key = f"check:{suite}/{name}"
            if cls == "red" and keys.count(key) == 1:
                if self.waive_mode == "record":
                    self.waived.add(key)
                if key in self.waived:
                    cls = "waived"
            out.append(f"{cls}\t{name}\t{concl}\t{url}\t{suite}\t{status}")
        return out

    def summarize(self, rows: list[str]) -> None:
        """``summarize_checks``: the per-check classes folded into ``verdict`` and the report lines."""
        red = waived = pending = queued = nogo = green = passed = 0
        lines: list[str] = []
        running: list[str] = []
        for row in rows:
            cls, name, concl, url, _suite, status = tab_fields(row, 6)
            if not cls:
                continue
            match cls:
                case "red":
                    red += 1
                    lines.append(f"  RED      {name} ({concl})  {url}\n")
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
        self.pending_names = running
        self.check_red = red
        self.check_waived = waived
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
        """``run_jobs``: "name\\tconclusion\\tcreated_at\\tcompleted_at" per job of the run."""
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
        return result.stdout if isinstance(result, GhOk) else None

    def run_red_is_advisory_only(self, run_id: str, suite: str) -> int:
        """``run_red_is_advisory_only``: 0 advisory jobs alone explain the run's red; 2 explained,
        but a job the override waived is part of it; 1 not explained (or the jobs are unread)."""
        raw = self.run_jobs(run_id)
        if raw is None:
            return 1
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

    def run_inflight_is_advisory_only(self, run_id: str) -> bool:
        """``run_inflight_is_advisory_only``: every unfinished job advisory, every finished
        non-advisory job green, and the job list still for ADVISORY_SETTLE seconds."""
        raw = self.run_jobs(run_id)
        if raw is None:
            return False
        unfinished = 0
        last = ""
        for line in herestring_lines(raw):
            jname, jconcl, jcreated, jdone = tab_fields(line, 4)
            if not jname:
                continue
            if (jcreated or "-") == "-":
                return False
            last = newest(last, jcreated)
            if conclusion_class(jconcl) == "pending":
                if not self.is_advisory(jname):
                    return False
                unfinished += 1
                continue
            if (jdone or "-") == "-":
                return False
            last = newest(last, jdone)
            if self.is_advisory(jname):
                continue
            if conclusion_class(jconcl) != "green":
                return False
        if unfinished == 0:
            return False
        age = age_of(last, self.clock.time())
        return age is not None and age >= self.config.advisory_settle

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
        no verdict; the run list is this round's when ``run_signal`` read it, else read here."""
        if self._round_runs is None and self.read_runs(sha) is None:
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
        raw = self._round_raw if self._round_raw is not None else self.read_runs(sha)
        if raw is None:
            return RunSignal(
                3, 0, waived_runs, f"the workflow runs for this head could not be read ({self.session.err_line()})"
            )
        self.run_state = " ".join(
            f"{f[1]}:{f[5]}:{f[6]}" for f in (tab_fields(line, 8) for line in herestring_lines(raw)) if f[1]
        )
        seen: set[str] = set()
        red_rows: list[str] = []
        inflight_ids: list[str] = []
        runs = nogo = 0
        for line in herestring_lines(raw):
            _created, rid, wid, event, name, status, concl, suite = tab_fields(line, 8)
            if not rid:
                continue
            if self.is_advisory(name):
                continue
            if status != "completed" or conclusion_class(concl) == "pending":
                runs += 1
                inflight_ids.append(rid)
                continue
            key = f"{wid}/{event}"
            if key in seen:
                continue
            seen.add(key)
            runs += 1
            cls = conclusion_class(concl)
            match cls:
                case "red":
                    red_rows.append(f"{rid}\t{name}\t{concl}\t{suite or '-'}")
                case "nogo":
                    nogo += 1
                case "green" | "pending":
                    pass
                case _:
                    assert_never(cls)
        red = 0
        red_note = ""
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
            red += 1
            red_note = red_note or f"{rname} ({rconcl})"
        if red > 0:
            return RunSignal(
                1,
                red,
                waived_runs,
                f"{red} workflow run(s) for this head concluded red with no build check"
                f" to show for it — {red_note}; a run that fails before its jobs start leaves nothing in the"
                " check list",
            )
        inflight = released = 0
        for rid in inflight_ids:
            if self.run_inflight_is_advisory_only(rid):
                released += 1
            else:
                inflight += 1
        if inflight > 0:
            return RunSignal(
                4,
                0,
                waived_runs,
                f"{inflight} workflow run(s) for this head have no conclusion yet (queued,"
                " running, or completed with none recorded) — their check runs may not exist yet",
            )
        if nogo > 0:
            return RunSignal(
                4,
                0,
                waived_runs,
                f"{nogo} workflow run(s) for this head completed stopped-not-judged (cancelled,"
                " stale or action_required) with no build check behind them — stopped is not absence and"
                " not a verdict: re-run the workflow",
                stopped=True,
            )
        if checks > 0 and runs > 0:
            if released > 0:
                reason = (
                    f"{runs} workflow run(s) for this head are judged — {released} of them"
                    " still running, but only advisory jobs (SHIP_PR_ADVISORY_CHECKS)"
                )
            else:
                reason = f"{runs} workflow run(s) for this head are finished and judged"
            return RunSignal(0, 0, waived_runs, reason)
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
                )
        if age < grace:
            return RunSignal(
                4,
                0,
                waived_runs,
                f"{seen_text}, and the head has been in place at most {fmt_age(age)} — inside the"
                f" {fmt_age(grace)} run-creation grace (SHIP_PR_BASE_ABSENT_GRACE), so a run"
                " may still appear",
            )
        return RunSignal(
            0,
            0,
            waived_runs,
            f"{seen_text} in the {fmt_age(age)} since it appeared — past the {fmt_age(grace)} run-creation grace",
        )

    # --- the gate -------------------------------------------------------------------------------------

    def _pr_fields(self, pr: str, with_updated: bool) -> tuple[Literal["ok", "refused", "unanswered"], list[str]]:
        """The head read: ``ok`` with its fields; ``refused`` when GitHub answered it with a refusal no
        retry changes (the READ policy's ``GhFailed``: a 4xx, a fixed GraphQL answer); ``unanswered``
        when the session's attempts ran out (or a quota hold stood)."""
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
            case GhFailed():
                return "refused", fields
            case GhUnanswered():
                return "unanswered", fields

    def _head_unread(self, pr: str, kind: str, deadline: int, again: bool) -> bool:
        """A head read that gave no SHA (ludics-lite#795). Under a wait with budget left, and unless
        GitHub refused the read outright, it is one failed poll, not the end of the wait: recorded,
        warned, and True -- pause and read again. Otherwise False, the verdict ``unknown`` and the
        warning naming every failure: the caller's 3.

        BOUNDARY, a fail-closed allowlist: what rides out is the gate's OWN head reads -- the first
        one and each round's re-read -- and only an unanswered read (the session's attempts spent, a
        quota hold past the wait) or one that answered without a SHA. Not ridden out: a refused read
        (a 4xx, which no retry changes), a round's check-run and workflow-run reads (3 at once, as
        before), and merge's own head reads beside a write (the recovery's before its rerun, the
        re-read after a call lost a race to the base), which fail closed because a write follows."""
        repo = self.repo
        verb = "re-read" if again else "read"
        failure = self.session.err_line() or "it answered no SHA"
        self.head_unread.append(failure)
        now = self.clock.now()
        if kind != "refused" and now < deadline:
            warn(
                f"could not {verb} {repo}#{pr}'s head SHA ({failure}); failed head read"
                f" {len(self.head_unread)} of this wait, reading it again within the wait"
                f" ({fmt_age(deadline - now)} left). Nothing is judged from this round.",
            )
            return True
        self.verdict = "unknown"
        if kind == "refused":
            why = "GitHub refused the read, which no retry changes"
        elif len(self.head_unread) > 1:
            why = f"{len(self.head_unread)} head reads failed during this wait, and its budget is spent"
        else:
            why = "with no wait left to read it again in"
        warn(
            f"could not {verb} {repo}#{pr}'s head SHA ({failure}); {why}. The build signal is UNKNOWN,",
            "which is NOT 'nothing is red'.",
        )
        return False

    def head_unread_note(self) -> str:
        """The failed head reads the last wait read past, for a report's last word; "" for none."""
        n = len(self.head_unread)
        if n == 0:
            return ""
        return (
            f"{self.repo}: {n} head read(s) failed during this wait and were read again within it"
            f" (last: {self.head_unread[-1]})"
        )

    def _pause(self, deadline: int, last_pause: int | None, changed: bool) -> int:
        """Sleep the budget's next pause (``pause``), clipped at the deadline; the pause taken."""
        budget = self.session.budget
        cap = budget.build_cap if budget is not None else self.config.checks_interval
        if self.verdict == "pending" and self.check_queued == 0:
            cap = min(cap, 2 * self.config.checks_interval)
        sleep_for = pause(self.config.checks_interval, cap, last_pause, changed)
        self.clock.sleep(min(sleep_for, max(0, deadline - int(self.clock.now()))))
        return sleep_for

    def check(self, pr: str, wait_for: int, waive: bool = False) -> int:
        """``gate_checks <pr> <wait> [waive]``: read the head and judge its build signal, printing the
        report. 0 green or a confirmed absence; 1 red (a check, a checkless run, or every red
        waived); 3 unread; 4 no verdict yet; 5 the head was superseded. Under ``select`` (``checks
        --check``, #569) the fold is over the matching checks alone, and 2 is a selection that
        matches no check run while none can still appear."""
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
        self.waive_mode = "record" if waive else ""
        self.head_unread = []
        last_pause: int | None = None
        while True:
            kind, (sha, pr_at, base_sha, head_ref) = self._pr_fields(pr, with_updated=True)
            if kind == "ok" and sha:
                break
            if not self._head_unread(pr, kind, deadline, again=False):
                return 3
            last_pause = self._pause(deadline, last_pause, False)
        self.check_sha = sha
        beat = started
        run_why = ""
        last_sig = ""
        while True:
            if budget is not None:
                budget.waited = False
            self.run_state = ""
            self._round_runs = None
            self._round_raw = None
            rows = self.build_checks(sha)
            if rows is None:
                self.verdict = "unknown"
                warn(
                    f"could not read the checks of {repo}#{pr} @{sha[:8]} ({self.session.err_line()});",
                    "the build signal is UNKNOWN, which is NOT 'nothing is red'.",
                )
                return 3
            rows = self.drop_advisory_workflows(sha, rows)
            if self.waive_mode:
                rows = self.apply_waiver(rows)
            if self.select:
                rows = [row for row in rows if self.selects(tab_fields(row, 6)[1])]
            self.summarize(rows)
            self.run_waived = 0
            self.gate_base = base_sha
            nomatch = ""
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
                match sig.rc:
                    case 3:
                        self.verdict = "unknown"
                        warn(
                            f"could not read the workflow runs of {repo}#{pr} @{sha[:8]} ({sig.reason}); whether a",
                            "check matching --check can still appear is UNKNOWN.",
                        )
                        return 3
                    case 4 if not sig.stopped:
                        self.verdict = "unjudged"
                        run_why = f"no check run matches --check {shlex.quote(self.select)} yet — {sig.reason}"
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
                    case 3:
                        self.verdict = "unknown"
                        warn(
                            f"could not read the workflow runs of {repo}#{pr} @{sha[:8]} ({run_why}); the checks",
                            "alone are not the build signal, so this is UNKNOWN, which is NOT 'nothing is red'.",
                        )
                        return 3
                    case 4:
                        if self.verdict != "pending":
                            self.verdict = "unjudged"
                    case _:
                        if self.run_waived and self.verdict in ("green", "absent"):
                            self.verdict = "waived"
                        if "only advisory jobs" in run_why:
                            self.check_lines += f"  running  {run_why} — not waited for\n"
            if self.waive_mode == "record":
                self.waive_mode = "apply"
            kind, (current, reread_base, reread_ref) = self._pr_fields(pr, with_updated=False)
            if kind != "ok" or not current or current == "null":
                # A round whose head could not be confirmed judges nothing: under a wait with budget
                # left it is one failed poll (ludics-lite#795), and the whole round is read again,
                # against the base and ref the last read that answered gave.
                if not self._head_unread(pr, kind, deadline, again=True):
                    return 3
                last_pause = self._pause(deadline, last_pause, False)
                continue
            base_sha, head_ref = reread_base, reread_ref
            if current != sha:
                self.verdict = "superseded"
                cli.say(
                    f"build signal {repo}#{pr}: SUPERSEDED — observed {sha}, current {current};"
                    " re-run for the new head"
                )
                return 5
            # A round that waited a quota hold out between its reads is two moments, not one: a
            # check read green before the wait may have been re-run since. Read the round again.
            if budget is not None and budget.waited:
                warn("a quota hold was waited out inside this round's reads; reading the round again")
                continue
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
            keep = False
            self.orphans = []
            if self.orphans_on and self.verdict in ("pending", "unjudged", "mixed"):
                self.orphans = self.find_orphans(sha)
                for orphan in self.orphans:
                    self.check_lines += report_line(orphan, repo, shlex.quote)
                if self.recover is not None:
                    step = self.recover(self.orphans, self._round_runs or [])
                    match step:
                        case Stop():
                            break
                        case Wait(until=until):
                            keep = True
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
            if self.verdict not in ("pending", "unjudged") and not keep:
                break
            if now >= deadline:
                break
            if now - beat >= self.config.checks_heartbeat:
                note = (
                    run_why if self.verdict == "unjudged"
                    else f"{self.check_pending} check(s) running: {running_list(self.pending_names)}"
                )
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
                cli.say(f"{head}: RED — {self.check_red} of {self.check_total} build checks failed")
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
            case "green":
                cli.say(f"{head}: green — {self.check_green} build checks passed")
            case "" | "superseded" | "unknown":
                pass
            case _:
                assert_never(self.verdict)
        if self.check_lines:
            sys.stdout.write(self.check_lines)
        if self.head_unread:
            warn(self.head_unread_note())
        match self.verdict:
            case "red" | "runred" | "waived":
                return 1
            case "pending" | "mixed" | "unjudged":
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
