"""Units of ``pr-review.sh rerun`` (ludics#1111, prreview/rerun.py): the listing, the boundary of
what it re-runs, and how each failure of its three calls exits, through an in-process gh.

test-pr-review-budget.sh runs it under the polling budget's hold; these pin the rules a regression
would bend first.
"""

import contextlib
import io
import unittest
from collections.abc import Sequence
from dataclasses import dataclass, field

from ludics import cli, proc
from ludics.prreview import rerun
from ludics.prreview.core import Config, GhSession

HEAD = "0123456789abcdef0123456789abcdef01234567"


def row(rid: str, status: str = "completed", conclusion: str = "failure", attempt: str = "1",
        created: str = "2026-11-11T20:00:00Z", name: str = "ci") -> str:
    return f"{created}\t{rid}\t{name}\tpull_request\t{status}\t{conclusion}\t{attempt}"


@dataclass
class Gh:
    """An in-process gh: the head read, the run list, and the re-run write, each answered as set."""

    jobs: str = '{"id":201,"name":"build","status":"completed","conclusion":"failure"}\n{"id":202,"name":"docs","status":"completed","conclusion":"success"}'
    runs: str = ""
    head: proc.Completed = field(default_factory=lambda: proc.Completed(0, HEAD + "\n", ""))
    listed: proc.Completed | None = None
    writes: dict[str, proc.Completed] = field(default_factory=lambda: dict[str, proc.Completed]())
    calls: list[list[str]] = field(default_factory=lambda: list[list[str]]())

    def __call__(self, name: str, args: Sequence[str]) -> proc.Completed:
        self.calls.append(list(args))
        if args[:2] == ["run", "rerun"]:
            return self.writes.get(args[2], proc.Completed(0, "", ""))
        joined = " ".join(args)
        if "actions/jobs/201/logs" in joined or "actions/jobs/98765432100/logs" in joined:
            return proc.Completed(0, "first\nlast\n", "")
        if "actions/runs/101/jobs?" in joined:
            return proc.Completed(0, self.jobs, "")
        if f"actions/runs?head_sha={HEAD}" in joined:
            return self.listed or proc.Completed(0, self.runs + "\n" if self.runs else "", "")
        if "pulls/7" in joined and ".head.sha" in joined:
            return self.head
        raise AssertionError(f"no answer for gh {joined}")

    def sent(self) -> list[list[str]]:
        return [c for c in self.calls if c[:2] == ["run", "rerun"]]


def rerun_with(gh: Gh, *args: str) -> tuple[int, str, str]:
    config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0, api_attempts=1, api_backoff=0)
    session = GhSession(config, run=gh, sleep=lambda _s: None)
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            rc = rerun.run(session, list(args))
        except cli.Exit as exc:
            rc = exc.rc
            err.write(exc.message + "\n")
    return rc, out.getvalue(), err.getvalue()


class Rerun(unittest.TestCase):
    def test_recovery_readers(self) -> None:
        for verb, extra, wanted in (("jobs", [], "job 202 docs"),
                                    ("failed-jobs", [], "job 201 build"),
                                    ("job-log", ["201", "1"], "last\n")):
            gh = Gh(runs=row("101"))
            rc, out, err = rerun_with(gh, "7", verb, "101", *extra)
            self.assertEqual(rc, 0, err)
            self.assertIn(wanted, out)
            if verb == "failed-jobs":
                self.assertNotIn("202", out)
            self.assertEqual(gh.sent(), [])

    def test_job_ids_are_not_limited_to_signed_32_bit(self) -> None:
        gh = Gh(runs=row("101"), jobs='{"id":98765432100,"name":"build","status":"completed","conclusion":"failure"}')
        rc, out, err = rerun_with(gh, "7", "job-log", "101", "98765432100", "1")
        self.assertEqual(rc, 0, err)
        self.assertEqual(out, "last\n")

    def test_recovery_refuses_wrong_run_or_nonfailed_job(self) -> None:
        for args in (("jobs", "999"), ("job-log", "101", "202")):
            gh = Gh(runs=row("101"))
            rc, _, _ = rerun_with(gh, "7", *args)
            self.assertEqual(rc, 1)
            self.assertFalse(any("/logs" in " ".join(c) for c in gh.calls))

    def test_recovery_zero_run_ids_are_usage_errors(self) -> None:
        for rid in ("0", "00", "000"):
            gh = Gh(runs=row("101"))
            rc, _, _ = rerun_with(gh, "7", "jobs", rid)
            self.assertEqual(rc, 2)
            self.assertEqual(gh.calls, [])

    def test_wait_completion_is_not_a_green_verdict(self) -> None:
        for conclusion in ("failure", "success", "cancelled"):
            rc, out, err = rerun_with(Gh(runs=row("101", conclusion=conclusion)), "7", "wait", "101", "1")
            self.assertEqual(rc, 0, err)
            self.assertIn("completed/" + conclusion, out)

    def test_no_run_id_lists_the_heads_runs_and_writes_nothing(self) -> None:
        gh = Gh(runs="\n".join([
            row("101"),
            row("102", "in_progress", "pending", created="2026-11-11T20:05:00Z", name="docs"),
            row("103", conclusion="success", attempt="2", created="2026-11-11T20:10:00Z"),
        ]))
        rc, out, _ = rerun_with(gh, "7")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.splitlines(), [
            "rerun o/r#7 @01234567: 3 workflow run(s) on the head; none re-run (name run ids to re-run)",
            "  run 103  ci  (pull_request)  completed/success  attempt 2  not re-run",
            "  run 102  docs  (pull_request)  in_progress  attempt 1  not re-run",
            "  run 101  ci  (pull_request)  completed/failure  attempt 1  re-runnable",
            f"rerun: head={HEAD} sent=0",
        ], "newest first, the trailer last")
        self.assertEqual(gh.sent(), [])

    def test_a_named_failed_run_of_the_head_is_rerun_with_merges_own_call(self) -> None:
        for conclusion in ("failure", "timed_out", "startup_failure", "cancelled"):
            gh = Gh(runs=row("101", conclusion=conclusion))
            rc, out, err = rerun_with(gh, "o/r#7", "101")
            with self.subTest(conclusion=conclusion):
                self.assertEqual(rc, 0, out + err)
                self.assertEqual(gh.sent(), [["run", "rerun", "101", "--failed", "--repo", "o/r"]])
                self.assertIn(f"run 101 (ci, {conclusion}, attempt 1): its failed jobs re-run —"
                              " gh run rerun 101 --failed --repo o/r", out)
                self.assertEqual(out.splitlines()[-1], f"rerun: head={HEAD} sent=1")

    def test_what_is_not_rerun_refuses_and_sends_nothing(self) -> None:
        # The boundary: a run that is not the head's, one in flight, a green one, and the stopped
        # states an approval answers. One refused id among good ones sends none of them.
        cases = (
            (row("101"), ["999"], "run 999 is not a workflow run of o/r#7's head 01234567"),
            (row("101", "in_progress", "pending"), ["101"], "it is in_progress, and GitHub re-runs the failed jobs of a finished run only"),
            (row("101", "queued", "pending"), ["101"], "it is queued, and GitHub re-runs"),
            (row("101", conclusion="success"), ["101"], "it concluded success, so no job of it failed"),
            (row("101", conclusion="skipped"), ["101"], "it concluded skipped, so no job of it failed"),
            (row("101", conclusion="action_required"), ["101"], "it concluded action_required, which a re-run of failed jobs does not answer"),
            (row("101", conclusion="stale"), ["101"], "it concluded stale, which a re-run"),
            (row("101") + "\n" + row("102", conclusion="success"), ["101", "102"], "run 102 (ci): it concluded success"),
        )
        for runs, ids, why in cases:
            gh = Gh(runs=runs)
            rc, out, err = rerun_with(gh, "7", *ids)
            with self.subTest(runs=runs, ids=ids):
                self.assertEqual(rc, 1, out + err)
                self.assertIn("REFUSING, nothing was re-run", err)
                self.assertIn(why, err)
                self.assertEqual(gh.sent(), [], "no write")

    def test_usage_errors_read_nothing(self) -> None:
        for args in ((), ("7", "abc"), ("7", "101", "101"), ("7", "--failed")):
            gh = Gh(runs=row("101"))
            rc, _, err = rerun_with(gh, *args)
            with self.subTest(args=args):
                self.assertEqual(rc, 2, err)
                self.assertEqual(gh.calls, [])

    def test_an_unread_head_or_run_list_is_three_and_sends_nothing(self) -> None:
        unanswered = proc.Completed(1, "", "gh: HTTP 503")
        for gh, what in (
            (Gh(runs=row("101"), head=unanswered), "could not read o/r#7's head"),
            (Gh(runs=row("101"), head=proc.Completed(0, "-\n", "")), "could not read o/r#7's head"),
            (Gh(runs=row("101"), listed=unanswered), "could not read the workflow runs of o/r#7 @01234567"),
            (Gh(runs=row("101"), listed=proc.Completed(1, "", "gh: Not Found (HTTP 404)")), "could not read the workflow runs"),
        ):
            rc, out, err = rerun_with(gh, "7", "101")
            with self.subTest(what=what):
                self.assertEqual(rc, 3, out + err)
                self.assertIn(what, err)
                self.assertIn("nothing was re-run", err)
                self.assertEqual(gh.sent(), [])

    def test_a_write_that_fails_is_told_apart(self) -> None:
        runs = row("101") + "\n" + row("102")
        rejected = proc.Completed(1, "", "gh: This workflow run cannot be retried (HTTP 403)")
        unclear = proc.Completed(1, "", "gh: Internal Server Error (HTTP 500)")
        gh = Gh(runs=runs, writes={"101": rejected})
        rc, _, err = rerun_with(gh, "7", "101", "102")
        self.assertEqual(rc, 1, err)
        self.assertIn("`gh run rerun 101 --failed --repo o/r` was rejected", err)
        self.assertEqual(len(gh.sent()), 1, "the first failure ends it")
        gh = Gh(runs=runs, writes={"102": unclear})
        rc, out, err = rerun_with(gh, "7", "101", "102")
        self.assertEqual(rc, 3, err)
        self.assertIn("`gh run rerun 102 --failed --repo o/r` failed", err)
        self.assertIn("may have landed. 1 re-run(s) were sent before it.", err)
        self.assertIn("run 101 (ci, failure, attempt 1): its failed jobs re-run", out)
        self.assertNotIn("rerun: head=", out, "no trailer claims a count it does not know")


if __name__ == "__main__":
    unittest.main()
