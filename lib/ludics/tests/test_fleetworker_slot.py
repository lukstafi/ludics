"""ludics.fleetworker.slot: the markers of an enclosing slot or measurement hold are judged against
the locks held NOW, never trusted (THE NESTED SLOT, THE MEASUREMENT'S OWN RUN)."""

import contextlib
import fcntl
import io
import os
import shutil
import tempfile
import unittest

from ludics import cli
from ludics.fleetworker.slot import (
    Covered,
    Inside,
    Refused,
    Take,
    Uncovered,
    judge_measurement,
    judge_nested,
    parse_slot,
)


class Locks(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-slot-test."))
        self.held: list[int] = []

    def tearDown(self) -> None:
        for descriptor in self.held:
            os.close(descriptor)
        shutil.rmtree(self.dir)

    def hold(self, name: str, mode: int = fcntl.LOCK_EX) -> None:
        descriptor = os.open(os.path.join(self.dir, name), os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(descriptor, mode | fcntl.LOCK_NB)
        self.held.append(descriptor)

    def touch(self, name: str) -> None:
        with open(os.path.join(self.dir, name), "w"):
            pass

    def nested(self, marker: str, cap: int = 1, tokens: int = 0, cpu: bool = False) -> object:
        with contextlib.redirect_stderr(io.StringIO()):
            return judge_nested("testbox", self.dir, cap, tokens, cpu, marker, ["echo", "x"])


class NestedSlot(Locks):
    def test_a_held_slot_on_this_box_covers_the_batch(self) -> None:
        self.hold("slot.1")
        self.assertEqual(self.nested("testbox 1 1 gpu"), Inside())

    def test_a_marker_that_names_nothing_held_is_said_and_ignored(self) -> None:
        self.touch("slot.1")
        for marker in ("testbox 1 1 gpu", "other 1 1 gpu", "garbage", "testbox 2 1 gpu", "testbox x 1 gpu"):
            self.assertEqual(self.nested(marker), Take(), marker)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            judge_nested("testbox", self.dir, 1, 0, False, "testbox 1 1 gpu", ["echo"])
        self.assertIn("FLEET_SLOT_HELD='testbox 1 1 gpu' does not cover this batch (slot 1 is not held); taking a slot", err.getvalue())

    def test_a_live_measurement_hold_makes_a_held_slot_prove_nothing(self) -> None:
        self.hold("slot.1")
        self.hold("measurement.lock", fcntl.LOCK_SH)
        self.assertEqual(self.nested("testbox 1 1 gpu"), Take())

    def test_a_gpu_batch_inside_a_cpu_slot_is_refused(self) -> None:
        self.hold("slot.3")
        verdict = self.nested("testbox 3 3 cpu", cap=3, tokens=1)
        self.assertIsInstance(verdict, Refused)
        self.assertEqual(self.nested("testbox 3 3 cpu", cap=3, tokens=1, cpu=True), Inside())


class MeasurementHold(Locks):
    def test_the_one_outstanding_measurement_under_a_live_hold_covers_the_batch(self) -> None:
        self.hold("measurement.lock", fcntl.LOCK_SH)
        self.assertEqual(judge_measurement("testbox", self.dir, "testbox m1", "m1"), Covered("m1", ""))
        # The probe reads no registry: the lock alone.
        self.assertEqual(judge_measurement("testbox", self.dir, "testbox m1", None), Covered("m1", ""))
        # Nothing outstanding: the hold still holds the box's slots, so the batch runs under it.
        covered = judge_measurement("testbox", self.dir, "testbox m1", "")
        self.assertEqual(covered, Covered("m1", "the registry has no outstanding measurement m1 on testbox"))

    def test_every_unconfirmed_marker_is_uncovered_with_its_reason(self) -> None:
        self.assertEqual(judge_measurement("testbox", self.dir, "testbox m1", "m1"),
                         Uncovered("no `execution hold --request` has run on testbox"))
        self.touch("measurement.lock")
        self.assertEqual(judge_measurement("testbox", self.dir, "testbox m1", "m1"),
                         Uncovered("no `execution hold --request` is live on testbox"))
        self.hold("measurement.lock", fcntl.LOCK_SH)
        for marker, measuring, reason in (
            ("testbox", "m1", "malformed"),
            ("other m1", "m1", "another box's"),
            ("testbox m1", "m2", "the registry has no outstanding measurement m1 on testbox"),
            ("testbox m1", "m1, m2", "other measurements are outstanding on testbox too: m1, m2"),
        ):
            self.assertEqual(judge_measurement("testbox", self.dir, marker, measuring), Uncovered(reason), marker)


class SlotArguments(unittest.TestCase):
    def refused(self, args: list[str]) -> str:
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(cli.Exit) as caught:
            parse_slot(args)
        self.assertEqual(caught.exception.rc, 2)
        return caught.exception.message

    def test_usage(self) -> None:
        parsed = parse_slot(["--wait", "0", "--cpu", "--cpu", "--", "echo", "--wait"])
        self.assertEqual((parsed.wait, parsed.kind, parsed.command), (0, "--cpu", ["echo", "--wait"]))
        self.assertEqual(parse_slot(["--probe"]).probe, True)
        self.assertIn("--cpu and --gpu are exclusive", self.refused(["--gpu", "--cpu", "--", "true"]))
        self.assertIn("whole number of seconds", self.refused(["--wait", "soon", "--", "true"]))
        self.assertIn("--probe takes no --bg", self.refused(["--probe", "--bg", "/x"]))
        self.assertIn("a command to hold the slot around is required", self.refused(["--"]))
        self.assertIn("execution slot [--bg <parent>]", self.refused(["--box", "other", "--", "true"]))

    def test_deadline(self) -> None:
        self.assertEqual(parse_slot(["--deadline", "5", "--", "true"]).deadline, 5)
        self.assertIsNone(parse_slot(["--", "true"]).deadline)
        for value in ("0", "00", "-1", "5s", ""):
            self.assertIn("--deadline takes a positive whole number of seconds",
                          self.refused(["--deadline", value, "--", "true"]), value)
        self.assertIn("--deadline takes a positive whole number of seconds", self.refused(["--deadline"]))
        self.assertIn("--probe takes no --deadline", self.refused(["--probe", "--deadline", "5"]))


if __name__ == "__main__":
    unittest.main()
