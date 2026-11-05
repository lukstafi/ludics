"""Units of images.py (ludics#959): a red check's runner image against the base's last green run
of that job, read from the jobs' log heads, and the gate's ``NEW IMAGE`` line."""

import contextlib
import io
import shlex
import unittest

from ludics.prreview.core import Config, GhFailed, GhSession
from ludics.prreview.images import image_of_log, job_of_url, report_lines, RedJob
from ludics.tests.test_prreview_gate import FakeClock, FakeGh, make_gate


def log_head(image: str, version: str = "20261101.186.1") -> str:
    """A job log's setup header as GitHub serves it (BOM, stamps), cut mid-line after it."""
    lines = [
        "﻿2026-11-05T12:04:24.2835729Z Current runner version: '2.338.2'",
        "2026-11-05T12:04:24.2872043Z ##[group]Operating System",
        "2026-11-05T12:04:24.2872844Z Ubuntu",
        "2026-11-05T12:04:24.2875490Z ##[endgroup]",
        "2026-11-05T12:04:24.2876145Z ##[group]Runner Image",
        f"2026-11-05T12:04:24.2876831Z Image: {image}",
        f"2026-11-05T12:04:24.2877543Z Version: {version}",
        "2026-11-05T12:04:24.2882244Z ##[endgroup]",
        "2026-11-05T12:04:24.2883530Z ##[group]GITHUB_TOKEN Permis",
    ]
    return "\n".join(lines)


URL = "https://github.com/o/r/actions/runs/100/job/555"


class LogHead(unittest.TestCase):
    def test_the_image_of_the_runner_image_group(self) -> None:
        self.assertEqual(image_of_log(log_head("ubuntu-26.04")), "ubuntu-26.04")
        self.assertEqual(image_of_log(log_head("macos-15-arm64").replace("\n", "\r\n")), "macos-15-arm64")

    def test_a_line_the_range_cut_is_not_read(self) -> None:
        cut = log_head("ubuntu-26.04").split("Image: ubuntu-26.04")[0] + "Image: ubuntu-2"
        self.assertIsNone(image_of_log(cut))

    def test_an_image_line_outside_the_group_is_not_read(self) -> None:
        text = "2026-11-05T12:04:24Z ##[group]Operating System\n2026-11-05T12:04:24Z Image: ubuntu-26.04\nx\n"
        self.assertIsNone(image_of_log(text))
        self.assertIsNone(image_of_log("2026-11-05T12:04:24Z ##[group]Runner Image\n2026-11-05T12:04:24Z ##[endgroup]\n"
                                       "2026-11-05T12:04:24Z Image: ubuntu-26.04\nx\n"))

    def test_a_name_outside_the_allowlist_is_not_known(self) -> None:
        self.assertIsNone(image_of_log(log_head("ubuntu 26.04")))
        self.assertIsNone(image_of_log(log_head("$(rm -rf x)")))
        self.assertIsNone(image_of_log(""))

    def test_a_job_url(self) -> None:
        self.assertEqual(job_of_url("o/r", URL), ("100", "555"))
        self.assertEqual(job_of_url("O/R", URL), ("100", "555"))
        self.assertIsNone(job_of_url("o/other", URL))
        self.assertIsNone(job_of_url("o/r", URL + "/x"))
        self.assertIsNone(job_of_url("o/r", "https://github.com/o/r/runs/555"))
        self.assertIsNone(job_of_url("o/r", "u"))


def red_world(gh: FakeGh, red_image: str, base_image: str, url: str = URL) -> None:
    """PR 7's head h1 with one red Actions job ``ci`` in run 100 of workflow 9; the base branch
    ``main``'s newest runs of workflow 9: run 300 (``ci`` red), a fork's pull request run 299 off a
    branch named main (``ci`` green, never read), and run 298 (``ci`` green, job 777)."""
    gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
    gh.on("pulls/7", ".base.ref", out="main")
    gh.on("pulls/7", out="h1\tb1\ttopic")
    gh.on("check-runs", out=f"ci\tfailure\t{url}\t1\tcompleted")
    gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t9\tpull_request\tci\tcompleted\tfailure\t1")
    gh.on("actions/jobs/555/logs", "Range: bytes=0-4095", out=log_head(red_image))
    gh.on("actions/jobs/777/logs", "Range: bytes=0-4095", out=log_head(base_image))
    gh.on(
        "actions/workflows/9/runs?branch=main&status=completed&per_page=10",
        out="2025-12-30T00:00:00Z\t298\tpush\tmain\n2025-12-31T00:00:00Z\t300\tpush\tmain\n"
        "2025-12-30T12:00:00Z\t299\tpull_request\tmain",
    )
    gh.on("actions/runs/300/jobs", out="776\tci\tfailure\n775\tlint\tsuccess")
    gh.on("actions/runs/298/jobs", out="777\tci\tsuccess")


class GateReport(unittest.TestCase):
    def setUp(self) -> None:
        self.out = io.StringIO()
        self.err = io.StringIO()
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        stack.enter_context(contextlib.redirect_stderr(self.err))
        self.addCleanup(stack.close)

    def gate(self, gh: FakeGh, images_on: bool = True) -> int:
        gate = make_gate(gh, FakeClock())
        gate.images_on = images_on
        rc = gate.check("7", 0)
        self.assertEqual((rc, gate.verdict, gate.check_red), (1, "red", 1), "the line changes no verdict")
        return rc

    def test_a_red_on_a_new_image_names_both(self) -> None:
        gh = FakeGh()
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        self.gate(gh)
        self.assertEqual(
            self.out.getvalue().splitlines()[1:],
            [
                f"  RED      ci (failure)  {URL}",
                "  NEW IMAGE  ci ran on ubuntu-26.04; its last green run on main (run 298) ran on ubuntu-24.04",
            ],
        )
        joined = [" ".join(c) for c in gh.calls]
        self.assertFalse(any("runs/299/jobs" in c for c in joined), "a fork's pull request run is not the base's")

    def test_a_same_image_red_prints_nothing_new(self) -> None:
        gh = FakeGh()
        red_world(gh, "ubuntu-26.04", "ubuntu-26.04")
        self.gate(gh)
        self.assertEqual(self.out.getvalue().splitlines()[1:], [f"  RED      ci (failure)  {URL}"])
        self.assertNotIn("IMAGE", self.err.getvalue())

    def test_an_unreadable_red_log_reads_nothing_of_the_base(self) -> None:
        gh = FakeGh()
        gh.on("actions/jobs/555/logs", rc=1, err="HTTP 410: Gone")
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        self.gate(gh)
        self.assertEqual(self.out.getvalue().splitlines()[1:], [f"  RED      ci (failure)  {URL}"])
        joined = [" ".join(c) for c in gh.calls]
        self.assertFalse(any("workflows/9" in c or "777" in c or ".base.ref" in c for c in joined))

    def test_a_withheld_base_log_prints_nothing(self) -> None:
        gh = FakeGh()
        gh.on(
            "actions/jobs/777/logs",
            rc=1,
            err="the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway",
        )
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        self.gate(gh)
        self.assertEqual(self.out.getvalue().splitlines()[1:], [f"  RED      ci (failure)  {URL}"])

    def test_a_withheld_own_read_fails_at_once(self) -> None:
        gh = FakeGh()
        gh.on("logs", rc=1, err="the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway")
        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0, api_attempts=4, api_backoff=0)
        result = GhSession(config, run=gh, sleep=lambda _s: None).retry("read", ["api", "repos/o/r/actions/jobs/1/logs"])
        self.assertIsInstance(result, GhFailed)
        self.assertEqual(len(gh.calls), 1, "re-sending gets it withheld again")

    def test_an_unread_newer_base_run_is_not_skipped(self) -> None:
        gh = FakeGh()
        gh.on("actions/runs/300/jobs", rc=1, err="HTTP 404: Not Found")
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        self.gate(gh)
        self.assertEqual(self.out.getvalue().splitlines()[1:], [f"  RED      ci (failure)  {URL}"])
        self.assertFalse(any("runs/298/jobs" in " ".join(c) for c in gh.calls))

    def test_a_job_never_green_on_the_base_prints_nothing(self) -> None:
        gh = FakeGh()
        gh.on("actions/runs/298/jobs", out="777\tci\tskipped")
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        self.gate(gh)
        self.assertEqual(self.out.getvalue().splitlines()[1:], [f"  RED      ci (failure)  {URL}"])

    def test_a_check_that_is_not_an_actions_job_is_read_no_further(self) -> None:
        gh = FakeGh()
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04", url="https://example.com/checks/1")
        self.gate(gh)
        self.assertFalse(any("logs" in " ".join(c) for c in gh.calls))

    def test_off_reads_nothing(self) -> None:
        gh = FakeGh()
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        self.gate(gh, images_on=False)
        self.assertFalse(any("logs" in " ".join(c) for c in gh.calls))
        self.assertNotIn("NEW IMAGE", self.out.getvalue())

    def test_a_branch_name_is_encoded_and_quoted(self) -> None:
        gh = FakeGh()
        gh.on("pulls/7", ".base.ref", out="rel/1 x")
        gh.on("actions/workflows/9/runs?branch=rel%2F1%20x&status=completed", out="2025-12-30T00:00:00Z\t298\tpush\trel/1 x")
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        self.gate(gh)
        self.assertIn(
            f"its last green run on {shlex.quote('rel/1 x')} (run 298) ran on ubuntu-24.04", self.out.getvalue()
        )

    def test_the_workflow_of_a_run_the_round_did_not_read(self) -> None:
        gh = FakeGh()
        gh.on("actions/runs/100", "workflow_id", out="9")
        red_world(gh, "ubuntu-26.04", "ubuntu-24.04")
        gate = make_gate(gh, FakeClock())
        lines = report_lines(gate.session, "o/r", "7", [RedJob("ci", URL)], [], shlex.quote)
        self.assertIn("NEW IMAGE  ci ran on ubuntu-26.04", lines)


if __name__ == "__main__":
    unittest.main()
