"""Jobs that never got a runner (``prreview/runners.py``, ludics-lite#560/#728): the projection
over the jobs API's real shapes, the two classes and their negative controls through the gate, and
``merge --wait``'s one recovery (``merge.Recovery``) driven round by round through an in-process gh
and an injected clock."""

import contextlib
import io
import json
import shutil
import subprocess
import unittest

from ludics.prreview import runners
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
            created: str = "2025-12-31T23:00:00Z", name: str = "ci") -> str:
    return f"{created}\t{rid}\t1\tpull_request\t{name}\t{status}\t{concl}\t1"


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


class MergeRecovery(Quiet):
    """The recovery as ``merge --wait`` installs it, round by round."""

    def run_gate(self, gh: FakeGh, wait: int, clock: FakeClock | None = None) -> tuple[int, Recovery, FakeClock]:
        clock = clock or FakeClock()
        gate = make_gate(gh, clock)
        gate.orphans_on = True
        recovery = Recovery(gate.session, "o/r", "7", gate, gate.clock, wait)
        gate.recover = recovery
        return gate.check("7", wait), recovery, clock

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
        self.assertEqual(recovery.commands, ["gh run rerun 100 --failed --repo o/r"])


if __name__ == "__main__":
    unittest.main()
