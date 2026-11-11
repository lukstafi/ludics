"""``fleet-worker.sh gate``: the reader of the checker's ``--advisory-red`` file (ludics-lite#651).

The gate's whole flow -- the checker's call, the file staged for it, the ADVISORY-RED lines and
every refusal -- is pinned end to end in issue-wave/scripts/test-fleet-worker.sh's "base gate"
section; what is here is the reader's allowlist one input at a time, the verdict line a ``--wait``
that ran out names, and the wait's deadline against a clock the suite cannot move (#872).
"""

import types
import unittest
from typing import cast
from unittest import mock

from ludics.fleetworker import gate
from ludics.fleetworker.config import Config
from ludics.fleetworker.gate import Read, advisory_red_jobs, verdict_line

SHA = "0123456789abcdef0123456789abcdef01234567"


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
