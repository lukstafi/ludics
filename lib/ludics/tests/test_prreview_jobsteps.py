"""The heartbeat evidence's read boundary; the shell budget suite pins the verdict and jq."""

import unittest
from unittest import mock

from ludics.prreview.core import Config, GhOk, GhSession, GhUnanswered
from ludics.prreview.jobsteps import diagnostic


class JobSteps(unittest.TestCase):
    def session(self) -> GhSession:
        return GhSession(Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0,
                                api_attempts=1, api_backoff=0))

    def test_unique_job_only_and_quoted_name(self) -> None:
        session = self.session()
        url = "https://github.com/o/r/actions/runs/12/job/34"
        with mock.patch.object(session, "retry", return_value=GhOk("2026-11-13T12:34:56Z\n")) as read:
            note = diagnostic(session, "o/r", [("$(build)", url), ("duplicate", url)])
        self.assertIn("'$(build)': steps finished successfully at 2026-11-13T12:34:56Z", note)
        read.assert_called_once()
        self.assertEqual(read.call_args.args[0], "read")
        self.assertIn("repos/o/r/actions/jobs/34", read.call_args.args[1])

    def test_repository_case_does_not_hide_evidence(self) -> None:
        session = self.session()
        with mock.patch.object(session, "retry", return_value=GhOk("2026-11-13T12:34:56Z")):
            note = diagnostic(session, "O/R", [("build", "https://github.com/o/r/actions/runs/12/job/34")])
        self.assertIn("steps finished successfully", note)

    def test_external_or_malformed_urls_never_read(self) -> None:
        session = self.session()
        urls = ["https://github.com/other/r/actions/runs/12/job/34",
                "https://github.com/o/r/actions/runs/12/job/34?x=1",
                "https://evil.example/o/r/actions/runs/12/job/34",
                "https://github.com/o/r/actions/runs/12/job/nope", ""]
        with mock.patch.object(session, "retry") as read:
            self.assertEqual(diagnostic(session, "o/r", [("build", url) for url in urls]), "")
        read.assert_not_called()

    def test_missing_ambiguous_or_failed_evidence_is_silent(self) -> None:
        session = self.session()
        url = "https://github.com/o/r/actions/runs/12/job/34"
        for result in (GhUnanswered(), GhOk(""), GhOk("null"), GhOk("yesterday"),
                       GhOk("2026-11-13T12:34:56Z\n2026-11-13T12:34:57Z")):
            with self.subTest(result=result), mock.patch.object(session, "retry", return_value=result):
                self.assertEqual(diagnostic(session, "o/r", [("build", url)]), "")
