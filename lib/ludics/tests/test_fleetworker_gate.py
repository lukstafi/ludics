"""``fleet-worker.sh gate``: the reader of the checker's ``--advisory-red`` file (ludics-lite#651).

The gate's whole flow -- the checker's call, the file staged for it, the ADVISORY-RED lines and
every refusal -- is pinned end to end in issue-wave/scripts/test-fleet-worker.sh's "base gate"
section; what is here is the reader's allowlist one input at a time, the verdict line a ``--wait``
that ran out names, and the wait's deadline against a clock the suite cannot move (#872).
"""

import types
import os
import subprocess
import tempfile
import unittest
from typing import cast
from unittest import mock

from ludics import cli
from ludics.fleetworker import gate, lease
from ludics.fleetworker.config import Config
from ludics.fleetworker.gate import Read, advisory_red_jobs, verdict_line

SHA = "0123456789abcdef0123456789abcdef01234567"


class HaltUnread(unittest.TestCase):
    def test_dangling_halt_refuses_all_three_readers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ludics-halt.") as tmp:
            marker = os.path.join(tmp, "HALT")
            os.symlink("missing", marker)
            with open(os.path.join(tmp, "COORDINATOR"), "w", encoding="utf-8") as f:
                f.write("token=mine\nhost=test\nsince=now\n")
            for script, args in (
                (lease.HALTED, []),
                (lease.ANCHOR_GATE, ["LAUNCH", "test", "0", "mine"]),
                (lease.HALT, ["reason", "id"]),
            ):
                with self.subTest(script=script):
                    done = subprocess.run(["/bin/bash", "-c", script, "bash", *args],
                                          env={**os.environ, "ANCHOR_STATE": tmp, "BOX": "test"},
                                          capture_output=True, text=True, check=False)
                    self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                    self.assertIn("cannot read", done.stdout)
                    self.assertTrue(os.path.islink(marker))
                    self.assertFalse(os.path.exists(os.path.join(tmp, "missing")))


class AdvisoryRedFile(unittest.TestCase):
    def test_the_jobs_and_their_commits_in_the_checkers_order(self) -> None:
        text = (
            '[{"workflow":"skill scripts","sha":"%s","run":"7","job":"bash 3.2 suites, a (macos)","conclusion":"failure"},'
            ' {"job":"bash 3.2 suites, b (macos)","sha":"%s"}]\n' % (SHA, SHA)
        )
        self.assertEqual(
            advisory_red_jobs(text), [("bash 3.2 suites, a (macos)", SHA), ("bash 3.2 suites, b (macos)", SHA)]
        )

    def test_none_is_an_empty_array(self) -> None:
        self.assertEqual(advisory_red_jobs("[]\n"), [])

    def test_anything_else_refuses(self) -> None:
        for text in (
            "",
            "\n",
            "not json",
            "{}",
            "null",
            '["x"]',
            '[{"job":"x"}]',
            '[{"sha":"%s"}]' % SHA,
            '[{"job":"","sha":"%s"}]' % SHA,
            '[{"job":7,"sha":"%s"}]' % SHA,
            '[{"job":"x","sha":"%s"}]' % SHA.upper(),
            '[{"job":"x","sha":"%s"}]' % SHA[:8],
            '[{"job":"x","sha":"%s"}, 1]' % SHA,
        ):
            with self.subTest(text=text):
                self.assertIsNone(advisory_red_jobs(text))


class VerdictLine(unittest.TestCase):
    """The reason a ``gate --wait`` that ran out names (#872): shown, never classified by."""

    def test_the_first_line_that_begins_with_the_target(self) -> None:
        report = (
            "(--wait ceiling of 6 min reached with a run still unfinished or the tip unjudged)\n"
            "o/r master: NO VERDICT for the tip abcdef12 — pending\n"
            "  ci-env  in flight\n"
            "o/r master: a later line\n"
        )
        self.assertEqual(verdict_line(report, "o/r"), "o/r master: NO VERDICT for the tip abcdef12 — pending")

    def test_none_is_empty(self) -> None:
        for report in ("", "o/rr master: another repository\n", "  o/r master: indented\n"):
            with self.subTest(report=report):
                self.assertEqual(verdict_line(report, "o/r"), "")


class SingleRead(unittest.TestCase):
    def test_no_wait_reaches_the_checker_without_a_polling_wait(self) -> None:
        cfg = cast(Config, types.SimpleNamespace(checkout=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")), env={}))
        for no_wait, result in ((True, 4), (True, 0), (False, 0), (False, 4)):
            with (self.subTest(no_wait=no_wait, result=result),
                  mock.patch.object(gate, "anchor_gate", return_value=0) as anchor,
                  mock.patch.object(gate, "integration_records", return_value=""),
                  mock.patch.object(gate, "_read", return_value="[]"),
                  mock.patch.object(gate, "base_checker", return_value=(result, "NO VERDICT YET")) as checker):
                args = ["--target-repo", "o/r"] + (["--no-wait"] if no_wait else [])
                self.assertEqual(gate.cmd_gate(cfg, args), (4 if no_wait else 1) if result else 0)
                self.assertEqual(checker.call_count, 1)
                self.assertIn("--wait=0" if no_wait else "--wait=360", checker.call_args.args[1])
                self.assertEqual("--snapshot" in checker.call_args.args[1], no_wait)
                self.assertEqual(anchor.call_count, 1 if result else 2, "green still rechecks the lease and halt")

    def test_launch_reads_a_fresh_snapshot_and_confirms_its_fetched_sha(self) -> None:
        cfg = cast(Config, types.SimpleNamespace(checkout=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")), env={}))
        for verdict, tip, expected in ((0, SHA, 0), (0, "a" * 40, 1), (0, None, 1), (3, SHA, 1), (4, SHA, 1)):
            with (self.subTest(verdict=verdict, tip=tip),
                  mock.patch.object(gate, "integration_records", return_value=""),
                  mock.patch.object(gate, "_read", return_value="[]"),
                  mock.patch.object(gate, "base_checker", return_value=(verdict, "fresh verdict")) as checker,
                  mock.patch.object(gate, "base_checker_read", return_value=tip) as confirm):
                self.assertEqual(gate.base_gate(cfg, "o/r", "main", False, "", SHA), expected)
                self.assertEqual(checker.call_count, 1)
                self.assertIn("--snapshot", checker.call_args.args[1])
                self.assertIn("--wait=0", checker.call_args.args[1])
                self.assertEqual(confirm.call_count, 0 if verdict else 1)

    def test_no_wait_cannot_start_an_outer_polling_loop(self) -> None:
        cfg = cast(Config, types.SimpleNamespace(env={}))
        for args in (["--no-wait", "--wait", "2"], ["--wait", "2", "--no-wait"]):
            with self.subTest(args=args), self.assertRaises(cli.Exit) as caught:
                gate.cmd_gate(cfg, list(args))
            self.assertEqual(caught.exception.message, "gate: --no-wait cannot be combined with --wait")


class WaitDeadline(unittest.TestCase):
    """``gate --wait``'s deadline bounds when a re-read may start (#872, THE WAIT): the clock is read
    again after the pause, so a late wake (a suspended host, a busy scheduler) refuses rather than
    starting a read past the deadline, and the shell suite cannot delay a sleep to show it."""

    def gate(self, clock: list[float], reads: list[Read]) -> tuple[int, int, list[str]]:
        cfg = cast(Config, types.SimpleNamespace(env={"FLEET_GATE_REREAD_INTERVAL": "1"}))
        lines: list[str] = []
        with mock.patch.object(gate, "anchor_gate", return_value=0), \
                mock.patch.object(gate, "base_read", side_effect=reads) as read, \
                mock.patch.object(gate.time, "monotonic", side_effect=clock), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(gate, "err", side_effect=lines.append):
            rc = gate.cmd_gate(cfg, ["--target-repo", "o/r", "--wait", "2"])
        return rc, read.call_count, lines

    def test_a_late_wake_starts_no_read(self) -> None:
        rc, made, lines = self.gate([0.0, 0.5, 3.0], [Read(1, True, "o/r master: NO VERDICT YET"), Read(0)])
        self.assertEqual((rc, made), (1, 1))
        self.assertEqual(
            lines[-1],
            "GATE REFUSED native-worker: o/r default branch: --wait 2s ran out after 1 read(s);"
            " the last refused: o/r master: NO VERDICT YET",
        )

    def test_a_wake_in_time_reads_again(self) -> None:
        rc, made, _ = self.gate([0.0, 0.5, 1.5], [Read(1, True, "pending"), Read(0)])
        self.assertEqual((rc, made), (0, 2))


if __name__ == "__main__":
    unittest.main()
