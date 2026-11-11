"""Jobs that never got a runner (``prreview/runners.py``, ludics-lite#560/#728): the projection
over the jobs API's real shapes, the two classes and their negative controls through the gate, and
``merge --wait``'s one recovery (``merge.Recovery``) driven round by round through an in-process gh
and an injected clock."""

import contextlib
import io
import json
import shutil
import subprocess
import typing
import unittest

from ludics.prreview import checks, runners
from ludics.prreview.gate import Gate
from ludics.prreview.merge import Recovery
from ludics.tests.test_prreview_gate import FakeClock, FakeGh, make_gate

T0 = "2026-01-01T00:00:00Z"  # FakeClock's epoch

# A job GitHub cancelled before any runner took it (the 2026-10-05 outage's shape): no step, no
# runner, completed cancelled.
NOT_ACQUIRED: dict[str, object] = {
    "id": 501, "run_id": 100, "run_attempt": 1, "name": "build (macos-latest)", "status": "completed",
    "conclusion": "cancelled", "created_at": "2025-12-31T23:00:00Z", "started_at": "2025-12-31T23:00:00Z",
    "completed_at": "2025-12-31T23:20:00Z", "steps": [], "labels": ["macos-latest"], "runner_id": None,
    "runner_name": None, "runner_group_id": None, "runner_group_name": None,
}


def job_row(jid: int = 501, name: str = "build", status: str = "completed", concl: str = "cancelled",
            created: str = "2025-12-31T23:00:00Z", steps: str = "0", runner: str = "-",
            labels: str = "ubuntu-latest", attempt: str = "1") -> str:
    """One row of ``runners.JOBS_JQ``'s projection, as gh prints it after the --jq."""
    return "\t".join([str(jid), name, status, concl, created, steps, runner, labels, attempt])


QUEUED = job_row(status="queued", concl="-", created="2025-12-31T23:30:00Z", labels="macos-14")
STARTED_MAC = job_row(jid=601, status="in_progress", concl="-", created="2025-12-31T23:40:00Z",
                      steps="2", runner="GitHub Actions 7", labels="macos-14")


def run_row(rid: int = 100, status: str = "completed", concl: str = "cancelled",
            created: str = "2025-12-31T23:00:00Z", name: str = "ci", event: str = "pull_request") -> str:
    return f"{created}\t{rid}\t1\t{event}\t{name}\t{status}\t{concl}\t1"


def jobs(gh: FakeGh, rid: str, out: str | list[str] = "", rc: int = 0, err: str = "") -> None:
    """The jobs of run ``rid`` as runners.py reads them (its projection alone names run_attempt);
    the gate's own job read of the same run (run_jobs) answers with no job."""
    gh.on(f"actions/runs/{rid}/jobs", "run_attempt", out=out, rc=rc, err=err)
    gh.on(f"actions/runs/{rid}/jobs", out="")


class Quiet(unittest.TestCase):
    def setUp(self) -> None:
        self.out = io.StringIO()
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        stack.enter_context(contextlib.redirect_stderr(self.out))
        self.addCleanup(stack.close)

    def head(self, gh: FakeGh, moved: str = "") -> None:
        gh.on("pulls/7", "--jq .head.sha", out=moved or "h1")
        gh.on("pulls/7", ".updated_at", out=f"h1\t{T0}\tb1\ttopic")
        gh.on("pulls/7", out="h1\tb1\ttopic")


class Projection(unittest.TestCase):
    def jq(self, jobs: list[dict[str, object]]) -> list[runners.Job]:
        if shutil.which("jq") is None:
            self.skipTest("no jq on PATH")
        done = subprocess.run(["jq", "-r", runners.JOBS_JQ], input=json.dumps({"jobs": jobs}),
                              capture_output=True, text=True, check=True)
        return runners.parse_jobs(done.stdout.rstrip("\n"))

    def test_the_not_acquired_shape_is_no_runner(self) -> None:
        (job,) = self.jq([NOT_ACQUIRED])
        self.assertEqual((job.jid, job.steps, job.runner, job.labels, job.attempt), ("501", 0, "", ("macos-latest",), 1))
        self.assertTrue(runners.no_runner(job))

    def test_an_empty_runner_name_is_no_runner_and_a_named_one_is_a_runner(self) -> None:
        (empty,) = self.jq([{**NOT_ACQUIRED, "runner_name": ""}])
        self.assertTrue(runners.no_runner(empty))
        (named,) = self.jq([{**NOT_ACQUIRED, "runner_name": "GitHub Actions 3"}])
        self.assertFalse(runners.no_runner(named), "a runner took it: a cancel, not a starved queue")

    def test_absent_or_unreadable_steps_are_not_zero_steps(self) -> None:
        absent: dict[str, object] = {k: v for k, v in NOT_ACQUIRED.items() if k != "steps"}
        for job in (absent, {**NOT_ACQUIRED, "steps": None}, {**NOT_ACQUIRED, "steps": "none"}):
            with self.subTest(steps=job.get("steps", "absent")):
                (parsed,) = self.jq([job])
                self.assertIsNone(parsed.steps)
                self.assertFalse(runners.no_runner(parsed))

    def test_a_cancel_after_steps_ran_is_not_no_runner(self) -> None:
        (job,) = self.jq([{**NOT_ACQUIRED, "steps": [{"name": "Set up job", "status": "completed"}]}])
        self.assertFalse(runners.no_runner(job))

    def test_a_row_that_is_not_the_projection_is_dropped(self) -> None:
        self.assertEqual(runners.parse_jobs("build\tcancelled\t2026-01-01T00:00:00Z\t-"), [])
        self.assertEqual(runners.parse_jobs(""), [])


class Classes(Quiet):
    def gate(self, gh: FakeGh, **env: str) -> Gate:
        gate = make_gate(gh, FakeClock(), **env)
        gate.orphans_on = True
        return gate

    def test_no_runner_is_named_with_its_command_and_ends_the_wait(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=job_row())
        clock = FakeClock()
        gate = make_gate(gh, clock)
        gate.orphans_on = True
        self.assertEqual(gate.check("7", 3600), 4)
        self.assertEqual([o.kind for o in gate.orphans], ["no-runner"])
        self.assertEqual(clock.sleeps, [], "the first round that finds it ends the wait")
        out = self.out.getvalue()
        self.assertIn("NO RUNNER      build — run 100, attempt 1", out)
        self.assertIn("recover: gh run rerun 100 --failed --repo o/r", out)
        self.assertFalse(any(c[:2] in (["run", "rerun"], ["run", "cancel"]) for c in gh.calls), "checks never writes")

    def test_without_the_scan_the_wait_holds_as_before(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=job_row())
        clock = FakeClock()
        gate = make_gate(gh, clock)  # base's gate: orphans_on is off
        self.assertEqual(gate.check("7", 300), 4)
        self.assertEqual((gate.orphans, sum(clock.sleeps)), ([], 300))

    def test_cancelled_jobs_that_are_not_no_runner(self) -> None:
        for row in (job_row(steps="3"), job_row(steps="-"), job_row(runner="GitHub Actions 2"),
                    job_row(concl="failure")):
            gh = FakeGh()
            self.head(gh)
            gh.on("check-runs", out="build\tcancelled\tu\t1")
            gh.on("actions/runs?head_sha=h1", out=run_row())
            jobs(gh, "100", out=row)
            with self.subTest(row=row):
                gate = self.gate(gh)
                self.assertEqual((gate.check("7", 0), gate.orphans), (4, []))

    def test_an_advisory_job_is_not_classified(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="lint\tsuccess\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=job_row())
        gate = self.gate(gh, SHIP_PR_ADVISORY_CHECKS="^build$")
        gate.check("7", 0)
        self.assertEqual(gate.orphans, [])

    def test_an_unread_job_list_classifies_nothing(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", rc=1, err="gh: HTTP 404")
        gate = self.gate(gh)
        self.assertEqual((gate.check("7", 0), gate.orphans, gate.verdict), (4, [], "unjudged"))

    def never_started(self, newer: str, newer_jobs: str, job: str = QUEUED, newer_rc: int = 0) -> list[runners.Orphan]:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="build\tpending\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row(status="in_progress", concl="pending"))
        jobs(gh, "100", out=job)
        gh.on("actions/workflows/1/runs", out=newer, rc=newer_rc, err="gh: HTTP 503" if newer_rc else "")
        jobs(gh, "130", out=newer_jobs)
        gate = self.gate(gh)
        self.assertEqual(gate.check("7", 0), 4)
        return gate.orphans

    def test_never_started_needs_a_newer_same_label_job_that_started(self) -> None:
        newer = "130\tin_progress\t2025-12-31T23:40:00Z"
        (orphan,) = self.never_started(newer, STARTED_MAC)
        self.assertEqual((orphan.kind, orphan.rid, orphan.evidence, orphan.age), ("never-started", "100", "130", 1800))
        out = self.out.getvalue()
        self.assertIn("NEVER STARTED  build — run 100, attempt 1: queued 30m for macos-14 while run 130", out)
        self.assertIn("gh run cancel 100 --repo o/r, then once it completes gh run rerun 100 --failed --repo o/r", out)

    def test_never_started_negative_controls(self) -> None:
        newer = "130\tin_progress\t2025-12-31T23:40:00Z"
        cases = {
            "a deep queue: the newer same-label job is queued too": (
                newer, job_row(jid=601, status="queued", concl="-", steps="0", labels="macos-14"), QUEUED, 0),
            "a different label started": (
                newer, job_row(jid=601, status="in_progress", concl="-", steps="2", runner="r", labels="ubuntu-latest"),
                QUEUED, 0),
            "under the threshold": (
                newer, STARTED_MAC, job_row(status="queued", concl="-", created="2025-12-31T23:50:00Z", labels="macos-14"), 0),
            "waiting on an approval": (
                newer, STARTED_MAC, job_row(status="waiting", concl="-", created="2025-12-31T23:30:00Z", labels="macos-14"), 0),
            "no labels read": (
                newer, STARTED_MAC, job_row(status="queued", concl="-", created="2025-12-31T23:30:00Z", labels="-"), 0),
            "the newer run was created in the same second": (
                "130\tin_progress\t2025-12-31T23:30:00Z", STARTED_MAC, QUEUED, 0),
            "the newer run is still queued": ("130\tqueued\t2025-12-31T23:40:00Z", STARTED_MAC, QUEUED, 0),
            "the newer runs could not be read": (newer, STARTED_MAC, QUEUED, 1),
        }
        for what, (runs, jobs, job, rc) in cases.items():
            with self.subTest(what):
                self.assertEqual(self.never_started(runs, jobs, job, rc), [])

    def test_the_threshold_can_be_turned_off(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="build\tpending\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row(status="in_progress", concl="pending"))
        jobs(gh, "100", out=QUEUED)
        gate = self.gate(gh, SHIP_PR_NEVER_STARTED="off")
        gate.check("7", 0)
        self.assertEqual(gate.orphans, [])
        self.assertFalse(any("run_attempt" in " ".join(c) for c in gh.calls), "no run is old enough to read")


class Trailer(unittest.TestCase):
    """ludics#753: the kinds found ride in the trailer's own runners= field, the verdict's
    vocabulary unchanged, so ``fleet-worker.sh prs`` can show a starved head."""

    def test_the_kinds_are_written_in_order_on_a_no_verdict_exit_only(self) -> None:
        both = {"never-started", "no-runner"}
        self.assertEqual(checks.trailer(4, "unjudged", {"no-runner"}, "unread"), "checks: verdict=unjudged runners=no-runner branch=unread")
        self.assertEqual(checks.trailer(4, "pending", both, "unread"), "checks: verdict=pending runners=no-runner,never-started branch=unread")
        self.assertEqual(checks.trailer(4, "pending", set(), "unread"), "checks: verdict=pending branch=unread", "none found: no field")
        for rc, verdict in ((0, "green"), (1, "red"), (3, "unknown"), (5, "superseded")):
            with self.subTest(rc=rc):
                self.assertEqual(checks.trailer(rc, verdict, both, "unread"), f"checks: verdict={verdict} branch=unread")
        self.assertEqual(checks.RUNNER_KINDS, typing.get_args(runners.Kind.__value__), "the field's vocabulary is the scan's")


class MergeRecovery(Quiet):
    """The recovery as ``merge --wait`` installs it, round by round."""

    def run_gate(self, gh: FakeGh, wait: int, clock: FakeClock | None = None, waive: bool = False,
                 **env: str) -> tuple[int, Recovery, FakeClock]:
        clock = clock or FakeClock()
        gate = make_gate(gh, clock, **env)
        gate.orphans_on = True
        recovery = Recovery(gate.session, "o/r", "7", gate, gate.clock, wait)
        gate.recover = recovery
        self.gate = gate
        return gate.check("7", wait, waive=waive), recovery, clock

    @staticmethod
    def writes(gh: FakeGh) -> list[str]:
        return [" ".join(c) for c in gh.calls if c[:1] == ["run"]]

    def test_no_runner_reruns_once_and_a_second_occurrence_ends_the_wait(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", out="")
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=[job_row(attempt="1"), job_row(attempt="2")])
        rc, recovery, clock = self.run_gate(gh, 7200)
        self.assertEqual(rc, 4)
        self.assertEqual(self.writes(gh), ["run rerun 100 --failed --repo o/r"], "exactly one recovery")
        self.assertIn("got no runner again on its rerun (attempt 2)", recovery.why)
        self.assertIn("gh run rerun 100 --repo o/r", recovery.commands, "the full rerun is named for the next try")
        self.assertLess(sum(clock.sleeps), 600, "ended at the second occurrence, not at the deadline")

    def test_a_rerun_that_recovers_reaches_the_verdict(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", out="")
        gh.on("check-runs", out=["build\tcancelled\tu\t1", "build\tsuccess\tu\t1"])
        gh.on("actions/runs?head_sha=h1", out=[run_row(), run_row(concl="success")])
        jobs(gh, "100", out=[job_row(), job_row(concl="success", steps="5", runner="r", attempt="2")])
        rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.why), (0, ""))
        self.assertEqual(len(self.writes(gh)), 1)

    def test_old_attempt_data_is_not_a_second_occurrence_until_the_window_ends(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", out="")
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=job_row(attempt="1"))
        rc, recovery, clock = self.run_gate(gh, 7200)
        self.assertEqual(rc, 4)
        self.assertEqual(len(self.writes(gh)), 1, "the stale attempt is never rerun again")
        self.assertIn("which did not take", recovery.why)
        self.assertGreaterEqual(sum(clock.sleeps), Recovery.TRANSITION)
        self.assertLess(sum(clock.sleeps), Recovery.TRANSITION + 600)

    def test_a_rerun_extends_the_deadline(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", out="")
        # Running for two rounds, then the run stops with a job no runner took, then green.
        gh.on("check-runs", out=["build\tpending\tu\t1", "build\tpending\tu\t1", "build\tcancelled\tu\t1",
                                 "build\tpending\tu\t1", "build\tsuccess\tu\t1"])
        gh.on("actions/runs?head_sha=h1", out=[run_row(status="in_progress", concl="pending", created=T0)] * 2
              + [run_row(created=T0), run_row(status="in_progress", concl="pending", created=T0),
                 run_row(concl="success", created=T0)])
        jobs(gh, "100", out=[job_row(), job_row(concl="success", steps="5", runner="r", attempt="2")])
        rc, _recovery, clock = self.run_gate(gh, 120)
        self.assertEqual(rc, 0, "a wait of 120 s outlived by the rerun's own budget")
        self.assertGreater(sum(clock.sleeps), 120)

    def test_never_started_is_cancelled_then_rerun(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "cancel", out="")
        gh.on("run", "rerun", out="")
        gh.on("check-runs", out=["build\tpending\tu\t1", "build\tcancelled\tu\t1", "build\tsuccess\tu\t1"])
        gh.on("actions/runs?head_sha=h1", out=[run_row(status="in_progress", concl="pending"), run_row(),
                                               run_row(concl="success")])
        # The scan's read, the re-read just before the cancel, the cancelled job, the rerun's.
        jobs(gh, "100", out=[QUEUED, QUEUED, job_row(created="2025-12-31T23:30:00Z", labels="macos-14"),
                                            job_row(concl="success", steps="5", runner="r", attempt="2")])
        gh.on("actions/workflows/1/runs", out="130\tin_progress\t2025-12-31T23:40:00Z")
        jobs(gh, "130", out=STARTED_MAC)
        rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.why), (0, ""))
        self.assertEqual(self.writes(gh), ["run cancel 100 --repo o/r", "run rerun 100 --failed --repo o/r"])

    def test_a_cancel_near_the_deadline_still_gets_its_rerun(self) -> None:
        """Local Codex review: a NEVER STARTED found just before the deadline was cancelled, and the
        wait then ended at the old deadline -- the run left cancelled, the rerun never sent."""
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "cancel", out="")
        gh.on("run", "rerun", out="")
        # The cancel lands on the second round; the run is still in flight at the old deadline.
        gh.on("check-runs", out=["build\tpending\tu\t1"] * 3 + ["build\tcancelled\tu\t1", "build\tsuccess\tu\t1"])
        gh.on("actions/runs?head_sha=h1", out=[run_row(status="in_progress", concl="pending")] * 3
              + [run_row(), run_row(concl="success")])
        # Scan, scan, the re-read before the cancel, scan (still queued), the cancelled job, the rerun's.
        jobs(gh, "100", out=[QUEUED] * 4 + [job_row(created="2025-12-31T23:30:00Z", labels="macos-14"),
                                           job_row(concl="success", steps="5", runner="r", attempt="2")])
        gh.on("actions/workflows/1/runs", out="130\tin_progress\t2025-12-31T23:40:00Z")
        jobs(gh, "130", out=STARTED_MAC)
        clock = FakeClock()
        gate = make_gate(gh, clock, SHIP_PR_NEVER_STARTED="1860")  # past it on the second round
        gate.orphans_on = True
        recovery = Recovery(gate.session, "o/r", "7", gate, gate.clock, 100)
        gate.recover = recovery
        self.assertEqual((gate.check("7", 100), recovery.why), (0, ""))
        self.assertEqual(self.writes(gh), ["run cancel 100 --repo o/r", "run rerun 100 --failed --repo o/r"])

    def test_a_job_that_started_before_the_cancel_is_left_alone(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="build\tpending\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row(status="in_progress", concl="pending"))
        started = job_row(status="in_progress", concl="-", created="2025-12-31T23:30:00Z", steps="1", runner="r",
                          labels="macos-14")
        jobs(gh, "100", out=[QUEUED, started])
        gh.on("actions/workflows/1/runs", out="130\tin_progress\t2025-12-31T23:40:00Z")
        jobs(gh, "130", out=STARTED_MAC)
        rc, recovery, _clock = self.run_gate(gh, 300)
        self.assertEqual((rc, self.writes(gh), recovery.why), (4, [], ""))

    def test_a_moved_head_writes_nothing(self) -> None:
        gh = FakeGh()
        self.head(gh, moved="h2")
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=job_row())
        rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.superseded, self.writes(gh)), (4, "h2", []))

    def test_a_refused_rerun_ends_the_wait_with_its_command(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", rc=1, err="HTTP 403: Resource not accessible by integration")
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=job_row())
        rc, recovery, clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, clock.sleeps), (4, []))
        self.assertEqual(len(self.writes(gh)), 1, "a refused write is not sent again")
        self.assertIn("failed (HTTP 403", recovery.why)
        self.assertNotIn("may have landed", recovery.why)
        self.assertEqual(recovery.commands, ["gh run rerun 100 --failed --repo o/r"])

    def test_a_timed_out_rerun_is_not_re_sent_and_may_have_landed(self) -> None:
        # A 504 is the gateway giving up on a backend that may have run the rerun (#708).
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", rc=1, err="gh: HTTP 504: Gateway Timeout")
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=job_row())
        rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, len(self.writes(gh))), (4, 1))
        self.assertIn("failed (gh: HTTP 504: Gateway Timeout); it may have landed", recovery.why)


# A job its own ``timeout-minutes`` cap stopped (#928; ludics run 41831895619): steps ran on a named
# runner, and the job, its check run and its run all read ``cancelled`` -- no red, and no NO RUNNER.
CAPPED = job_row(steps="7", runner="GitHub Actions 1000059632")


def run_read(gh: FakeGh, rid: str, out: str | list[str] = "", rc: int = 0, err: str = "") -> None:
    """The recovery's re-read of one run: status, conclusion, attempt."""
    gh.on(f"actions/runs/{rid} --jq", out=out, rc=rc, err=err)


class CancelledRecovery(MergeRecovery):
    """#928: a head run cancelled with no red is rerun once; a second cancellation ends the wait."""

    def cancelled(self, gh: FakeGh, checks: list[str] | None = None, runs: list[str] | None = None) -> None:
        self.head(gh)
        gh.on("run", "rerun", out="")
        gh.on("check-runs", out=checks or ["build\tcancelled\tu\t1"])
        gh.on("actions/runs?head_sha=h1", out=runs or [run_row()])
        jobs(gh, "100", out=CAPPED)

    def test_a_run_its_cap_cancelled_is_rerun_once_and_reaches_the_verdict(self) -> None:
        gh = FakeGh()
        self.cancelled(gh, ["build\tcancelled\tu\t1", "build\tsuccess\tu\t1"], [run_row(), run_row(concl="success")])
        run_read(gh, "100", out="completed\tcancelled\t1")
        rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.why), (0, ""))
        self.assertEqual(self.writes(gh), ["run rerun 100 --failed --repo o/r"])
        self.assertIn("it was cancelled before its jobs were judged; recovering once", self.out.getvalue())

    def test_a_second_cancellation_ends_the_wait_with_its_own_code(self) -> None:
        gh = FakeGh()
        self.cancelled(gh)
        run_read(gh, "100", out=["completed\tcancelled\t1", "completed\tcancelled\t2"])
        rc, recovery, clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.code), (4, 7))
        self.assertEqual(self.writes(gh), ["run rerun 100 --failed --repo o/r"], "exactly one rerun")
        self.assertIn("run 100 was cancelled again on its rerun (attempt 2)", recovery.why)
        self.assertEqual(recovery.commands, ["gh run rerun 100 --failed --repo o/r", "gh run rerun 100 --repo o/r"])
        self.assertLess(sum(clock.sleeps), 600, "ended at the second cancellation, not at the deadline")

    def test_a_rerun_that_does_not_take_ends_after_the_window(self) -> None:
        gh = FakeGh()
        self.cancelled(gh)
        run_read(gh, "100", out="completed\tcancelled\t1")
        rc, recovery, clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.code, len(self.writes(gh))), (4, 7, 1))
        self.assertIn("still reads cancelled at attempt 1", recovery.why)
        self.assertGreaterEqual(sum(clock.sleeps), Recovery.TRANSITION)
        self.assertLess(sum(clock.sleeps), Recovery.TRANSITION + 600)

    def test_a_refused_rerun_ends_the_wait_with_its_own_code(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", rc=1, err="HTTP 403: Resource not accessible by integration")
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=CAPPED)
        run_read(gh, "100", out="completed\tcancelled\t1")
        rc, recovery, clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.code, clock.sleeps), (4, 7, []))
        self.assertEqual(recovery.commands, ["gh run rerun 100 --failed --repo o/r"])

    def test_what_is_not_rerun(self) -> None:
        """An unread run, an attempt that does not read, a run in flight on re-read, a newer run of
        the same workflow in flight, a stop a rerun does not answer, an advisory run: no write, and
        the wait holds as it did before #928."""
        newer = run_row(rid=101, status="in_progress", concl="pending", created="2025-12-31T23:30:00Z")
        cases: list[tuple[str, list[str], dict[str, typing.Any], dict[str, str]]] = [
            ("unread", [run_row()], {"rc": 1, "err": "gh: HTTP 502"}, {}),
            ("no attempt", [run_row()], {"out": "completed\tcancelled\t-"}, {}),
            ("in flight on re-read", [run_row()], {"out": "in_progress\t-\t2"}, {}),
            ("a newer run in flight", [newer + "\n" + run_row()], {"out": "completed\tcancelled\t1"}, {}),
            ("action_required", [run_row(concl="action_required")], {"out": "completed\taction_required\t1"}, {}),
            ("advisory", [run_row()], {"out": "completed\tcancelled\t1"}, {"SHIP_PR_ADVISORY_CHECKS": "^ci$"}),
        ]
        for name, runs, read, env in cases:
            with self.subTest(name):
                gh = FakeGh()
                self.cancelled(gh, runs=runs)
                jobs(gh, "101", out="")
                gh.on("commits/h1", out=T0)  # an advisory run's suite leaves no check: the head's age
                run_read(gh, "100", **read)
                clock = FakeClock()
                gate = make_gate(gh, clock, **env)
                gate.orphans_on = True
                recovery = Recovery(gate.session, "o/r", "7", gate, gate.clock, 300)
                gate.recover = recovery
                gate.check("7", 300)
                self.assertEqual((self.writes(gh), recovery.why), ([], ""))

    def test_a_run_cancelled_only_in_advisory_jobs_is_not_rerun(self) -> None:
        """ludics#958: the advisory macOS leg of a non-advisory workflow, cancelled at its cap
        beside passed jobs, holds nothing -- so the recovery, called on a round another run keeps
        unjudged, does not rerun it, and the head merges on that run's green. The control: the
        same run with its required job cancelled is rerun."""
        t = "2025-12-31T23:00:00Z"
        other = f"{t}\t101\t2\tpull_request\tdocs\tin_progress\tpending\t2"
        done = f"{t}\t101\t2\tpull_request\tdocs\tcompleted\tsuccess\t2"
        for jobs_out, want in (
            (f"build\tsuccess\t{t}\t{t}\nmacos\tcancelled\t{t}\t{t}", []),
            (f"build\tcancelled\t{t}\t{t}\nmacos\tcancelled\t{t}\t{t}", ["run rerun 100 --failed --repo o/r"]),
        ):
            with self.subTest(jobs=jobs_out):
                gh = FakeGh()
                self.head(gh)
                gh.on("run", "rerun", out="")
                gh.on("check-runs", out="build\tsuccess\tu\t1\nmacos\tcancelled\tm\t1")
                gh.on("actions/runs?head_sha=h1", out=[f"{other}\n{run_row()}", f"{done}\n{run_row()}"])
                gh.on("actions/runs/100/jobs", "run_attempt", out=CAPPED)
                gh.on("actions/runs/100/jobs", out=jobs_out)
                jobs(gh, "101", out="")
                run_read(gh, "100", out="completed\tcancelled\t1")
                rc, recovery, _clock = self.run_gate(gh, 7200, SHIP_PR_ADVISORY_CHECKS="^macos$")
                self.assertEqual(self.writes(gh), want)
                if not want:
                    self.assertEqual((rc, recovery.why), (0, ""))

    def test_a_rerun_cancelled_again_only_in_advisory_jobs_is_no_seven(self) -> None:
        """ludics#958: the one rerun's attempt cancelled again, but only in its advisory leg, is a
        release, not the second cancellation: the wait ends on the green, not with 7."""
        t = "2025-12-31T23:00:00Z"
        gh = FakeGh()
        self.cancelled(gh, ["build\tcancelled\tu\t1", "build\tsuccess\tu\t1\nmacos\tcancelled\tm\t1"])
        gh.routes = [r for r in gh.routes if r.needles != ("actions/runs/100/jobs",)]
        gh.on("actions/runs/100/jobs", out=[f"build\tcancelled\t{t}\t{t}"] * 2
              + [f"build\tsuccess\t{t}\t{t}\nmacos\tcancelled\t{t}\t{t}"])
        run_read(gh, "100", out=["completed\tcancelled\t1", "completed\tcancelled\t2"])
        rc, recovery, _clock = self.run_gate(gh, 7200, SHIP_PR_ADVISORY_CHECKS="^macos$")
        self.assertEqual((rc, recovery.why), (0, ""))
        self.assertEqual(self.writes(gh), ["run rerun 100 --failed --repo o/r"], "exactly one rerun")

    def test_a_no_runner_rerun_cancelled_again_is_the_one_recovery_spent(self) -> None:
        """One recovery per head run: a NO RUNNER rerun whose attempt is then cancelled is not
        rerun a second time."""
        gh = FakeGh()
        self.head(gh)
        gh.on("run", "rerun", out="")
        gh.on("check-runs", out="build\tcancelled\tu\t1")
        gh.on("actions/runs?head_sha=h1", out=run_row())
        jobs(gh, "100", out=[job_row(), job_row(steps="7", runner="r", attempt="2")])
        run_read(gh, "100", out="completed\tcancelled\t2")
        rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.code, len(self.writes(gh))), (4, 7, 1))
        self.assertIn("cancelled again on its rerun (attempt 2)", recovery.why)


    # #1036: a cancelled ``workflow_dispatch`` run is evidence, not the PR's build -- never rerun,
    # the wait ends at once with 7 -- and ``--override`` waives a check or run that reads cancelled
    # at the gate's first read, as it waives a red, but never a check still running.
    DISPATCH = run_row(event="workflow_dispatch", name="windows git bash")

    def test_a_cancelled_dispatch_run_is_not_rerun(self) -> None:
        gh = FakeGh()
        self.cancelled(gh, runs=[self.DISPATCH])
        run_read(gh, "100", out="completed\tcancelled\t1")
        rc, recovery, clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.code, recovery.dispatched), (4, 7, "100"))
        self.assertEqual(self.writes(gh), [], "nothing is rerun")
        self.assertIn("started by workflow_dispatch", recovery.why)
        self.assertEqual(recovery.commands, ["gh run rerun 100 --failed --repo o/r"], "the rerun by hand")
        self.assertEqual(clock.sleeps, [], "the wait ends on the first round, not at its deadline")

    def test_a_cancelled_pull_request_run_is_still_rerun_once(self) -> None:
        """The control: the same run under a ``pull_request`` event is #928's, rerun once."""
        gh = FakeGh()
        self.cancelled(gh)
        run_read(gh, "100", out="completed\tcancelled\t1")
        _rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual(self.writes(gh), ["run rerun 100 --failed --repo o/r"])
        self.assertNotIn("workflow_dispatch", recovery.why)

    def test_an_override_waives_a_cancel_read_at_the_first_read(self) -> None:
        for runs in ([self.DISPATCH], [run_row()]):
            with self.subTest(event=runs[0].split("\t")[3]):
                gh = FakeGh()
                self.cancelled(gh, runs=runs)
                run_read(gh, "100", out="completed\tcancelled\t1")
                rc, recovery, _clock = self.run_gate(gh, 7200, waive=True)
                gate = self.gate
                self.assertEqual((rc, gate.verdict, recovery.why), (1, "waived", ""))
                self.assertEqual(gate.waived, {"cancelled:1/build", "cancelled-run:100"})
                self.assertEqual((gate.check_waived, gate.run_waived, gate.waived_cancelled), (1, 1, 2))
                self.assertEqual(self.writes(gh), [], "a waived run is not rerun")
                self.assertIn("CANCELLED, WAIVED", self.out.getvalue())
                self.assertNotIn("RED, CANCELLED", self.out.getvalue(), "nothing red was waived")

    def test_an_override_does_not_waive_a_check_still_running(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="build\tpending\tu\t1\tin_progress")
        gh.on("actions/runs?head_sha=h1", out=run_row(status="in_progress", concl="pending"))
        jobs(gh, "100", out=job_row(status="in_progress", concl="-", steps="2", runner="GitHub Actions 3"))
        rc, _recovery, _clock = self.run_gate(gh, 300, waive=True)
        gate = self.gate
        self.assertEqual((rc, gate.verdict, gate.check_waived), (4, "pending", 0))
        self.assertEqual(gate.waived, set(), "a check with no verdict is never recorded")

    def test_a_cancel_waived_then_rerun_red_is_not_waived(self) -> None:
        """The cancel's key is its own: a re-run keeps its suite, and its red is no cancel."""
        gh = FakeGh()
        self.cancelled(gh, ["build\tcancelled\tu\t1", "build\tfailure\tu\t1"])
        rc, _recovery, _clock = self.run_gate(gh, 0, waive=True)
        self.assertEqual((rc, self.gate.verdict), (1, "waived"))
        gate = self.gate
        gate.waive_mode = "apply"
        rows = gate.apply_waiver(gate.build_checks("h1") or [])
        gate.summarize(rows)
        self.assertEqual((gate.verdict, gate.check_red), ("red", 1))

    def test_a_cancel_after_the_first_read_is_not_waived(self) -> None:
        """A run in flight at the first read and cancelled after it is no cancel the override read:
        it holds, and as a dispatch it ends the wait with 7."""
        gh = FakeGh()
        self.cancelled(gh, ["build\tpending\tu\t1\tin_progress", "build\tcancelled\tu\t1"],
                       [run_row(status="in_progress", concl="pending", event="workflow_dispatch"), self.DISPATCH])
        run_read(gh, "100", out="completed\tcancelled\t1")
        rc, recovery, _clock = self.run_gate(gh, 7200, waive=True)
        self.assertEqual((rc, recovery.code, recovery.dispatched), (4, 7, "100"))
        self.assertEqual(self.gate.waived, set())
        self.assertEqual(self.writes(gh), [])

    def test_a_dispatch_no_runner_took_is_not_rerun_either(self) -> None:
        """Local Codex review: a NO RUNNER job of a dispatch (completed cancelled, no step, no
        runner) went to the orphan recovery's rerun before the dispatch rule saw it."""
        gh = FakeGh()
        self.cancelled(gh, runs=[self.DISPATCH])
        gh.routes = [r for r in gh.routes if "actions/runs/100/jobs" not in r.needles]
        jobs(gh, "100", out=job_row())
        run_read(gh, "100", out="completed\tcancelled\t1")
        rc, recovery, _clock = self.run_gate(gh, 7200)
        self.assertEqual((rc, recovery.code, recovery.dispatched, self.writes(gh)), (4, 7, "100", []))

    def test_a_dispatch_rerun_by_hand_since_the_round_is_no_refusal(self) -> None:
        """Local Codex review: the round's run list reads it cancelled, its re-read in flight (a
        rerun by hand): nothing this round, and the wait goes on."""
        gh = FakeGh()
        self.cancelled(gh, runs=[self.DISPATCH])
        run_read(gh, "100", out="in_progress\t-\t2")
        rc, recovery, _clock = self.run_gate(gh, 300)
        self.assertEqual((rc, recovery.why, recovery.dispatched, self.writes(gh)), (4, "", "", []))

    def test_an_override_waived_run_gets_no_orphan_rerun(self) -> None:
        """Local Codex review: a run the override waived as cancelled, its job one no runner took,
        was rerun by the orphan recovery while another check kept the gate waiting."""
        gh = FakeGh()
        self.cancelled(gh, ["build\tcancelled\tu\t1\nlint\tpending\tl\t2\tin_progress"],
                       [run_row(rid=101, status="in_progress", concl="pending", name="lint") + "\n" + run_row()])
        gh.routes = [r for r in gh.routes if "actions/runs/100/jobs" not in r.needles]
        jobs(gh, "100", out=job_row())
        jobs(gh, "101", out=job_row(jid=601, name="lint", status="in_progress", concl="-", steps="2", runner="r"))
        rc, recovery, _clock = self.run_gate(gh, 300, waive=True)
        self.assertIn("cancelled-run:100", self.gate.waived)
        self.assertEqual((rc, recovery.why, self.writes(gh)), (4, "", []))


if __name__ == "__main__":
    unittest.main()
