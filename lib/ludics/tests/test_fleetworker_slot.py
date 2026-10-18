"""ludics.fleetworker.slot: the markers of an enclosing slot or measurement hold are judged against
the locks held NOW, never trusted (THE NESTED SLOT, THE MEASUREMENT'S OWN RUN)."""

import contextlib
import fcntl
import io
import os
import json
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import slot
from ludics.fleetworker.config import load_config
from ludics.fleetworker.slot import (
    Covered,
    Holder,
    Inside,
    Refused,
    Take,
    Uncovered,
    Unread,
    await_measurements,
    drain_slot,
    holder_line,
    judge_measurement,
    judge_nested,
    parse_slot,
    read_holder,
    read_registry,
    record_holder,
    unreachable_lines,
)
from ludics.fleetworker.transport import UNREACHABLE, Done


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


def ended_pid() -> int:
    done = subprocess.run(["sh", "-c", "echo $$"], capture_output=True, text=True, check=True)
    return int(done.stdout)


class HolderRecord(Locks):
    """THE HOLDER RECORD (ludics-lite#668): what a slot's taker writes, and the drain's naming of it."""

    def path(self) -> str:
        return os.path.join(self.dir, "slot.1")

    def locked(self) -> bool:
        descriptor = os.open(self.path(), os.O_RDWR)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        finally:
            os.close(descriptor)
        return False

    def write(self, text: str) -> None:
        with open(self.path(), "w") as stream:
            stream.write(text)

    def test_a_take_records_its_pid_command_and_deadline_over_an_earlier_record(self) -> None:
        self.write(json.dumps({"pid": 1, "command": ["an", "earlier", "taker's", "much longer", "record"] * 50,
                               "started": 0, "deadline": None}))
        descriptor = os.open(self.path(), os.O_RDWR)
        self.held.append(descriptor)
        before = time.time()
        record_holder(descriptor, ["sleep", "30"], 6000)
        holder = read_holder(self.path())
        assert holder is not None
        self.assertEqual((holder.pid, holder.command, holder.deadline), (os.getpid(), ("sleep", "30"), 6000))
        self.assertGreaterEqual(holder.started, before)
        record_holder(descriptor, ["true"], None)  # shorter than the record it replaces: nothing of that is left
        again = read_holder(self.path())
        self.assertEqual((again.command, again.deadline) if again else None, (("true",), None))

    def test_the_reader_takes_the_allowlisted_shape_or_nothing(self) -> None:
        good: dict[str, object] = {"pid": 7, "command": ["x"], "started": 1.5, "deadline": 60, "other": [1]}
        self.write(json.dumps(good))
        self.assertEqual(read_holder(self.path()), Holder(7, ("x",), 1.5, 60))
        bads: list[dict[str, object]] = [
            {"pid": True}, {"pid": 0}, {"pid": "7"}, {"command": []}, {"command": "x"}, {"command": ["x", 1]},
            {"started": "1"}, {"started": False}, {"deadline": 0}, {"deadline": 1.5}, {"deadline": True},
        ]
        for bad in bads:
            self.write(json.dumps(good | bad))
            self.assertIsNone(read_holder(self.path()), bad)
        for text in ("", "not json", "[]", '{"pid": 7, "command": ["x"], "started": NaN, "deadline": null}',
                     json.dumps(good | {"pad": "x" * slot.HOLDER_READ})):
            self.write(text)
            self.assertIsNone(read_holder(self.path()), text[:40])
        self.assertIsNone(read_holder(os.path.join(self.dir, "slot.9")))

    def test_the_line_names_a_holder_that_may_hold_the_slot_long(self) -> None:
        now = 10_000.0
        unbounded = holder_line("testbox", "m1", 2, Holder(os.getpid(), ("sleep", "a b"), now - 125, None), now, None)
        self.assertEqual(unbounded, f"EXECUTION HOLD testbox: measurement m1 waits on slot 2: held by pid {os.getpid()}"
                         f" for 2m so far, and no --deadline bounds it; stopping pid {os.getpid()} ends that batch and"
                         " starts the measurement, for: sleep 'a b'")
        capped = holder_line("testbox", "m1", 2, Holder(os.getpid(), ("tune",), now - 600, 6000), now, 310)
        self.assertIsNotNone(capped)
        self.assertIn("measurement m1 still waits for slot 2 after 5m: held by pid", str(capped))
        self.assertIn("for 10m so far, and its --deadline 6000s ends it in about 1h30m;", str(capped))
        # A --deadline that ends the batch within LONG_HOLDER is not worth a decision.
        self.assertIsNone(holder_line("testbox", "m1", 2, Holder(os.getpid(), ("x",), now, slot.LONG_HOLDER), now, None))
        self.assertIsNotNone(holder_line("testbox", "m1", 2, Holder(os.getpid(), ("x",), now, slot.LONG_HOLDER + 60), now, None))

    def test_no_record_or_a_stale_one_is_said_without_a_command_or_a_cap(self) -> None:
        none = str(holder_line("testbox", "m1", 1, None, 0.0, None))
        self.assertIn("measurement m1 waits on slot 1: its holder left no record of its command or --deadline", none)
        pid = ended_pid()
        stale = str(holder_line("testbox", "m1", 1, Holder(pid, ("secret",), 0.0, None), 0.0, None))
        self.assertIn(f"its recorded holder, pid {pid}, has ended", stale)
        self.assertNotIn("secret", stale)

    def test_a_recorded_command_is_quoted_on_one_line(self) -> None:
        line = str(holder_line("testbox", "m1", 1, Holder(os.getpid(), ("sh", "-c", "a\nb\x1b"), 0.0, None), 0.0, None))
        self.assertTrue(line.endswith("for: sh -c 'a\\nb\\x1b'"), line)
        self.assertNotIn("\n", line)

    def drain(self, repeat: float, release_after: float | None) -> tuple[str, float]:
        descriptor = os.open(self.path(), os.O_CREAT | os.O_RDWR, 0o644)
        self.held.append(descriptor)
        err = io.StringIO()
        start = time.monotonic()
        if release_after is not None:
            holder = self.held.pop(0)
            threading.Timer(release_after, os.close, [holder]).start()
        with contextlib.redirect_stderr(err):
            drain_slot("testbox", "m1", self.path(), descriptor, 1, repeat)
        return err.getvalue(), time.monotonic() - start

    def test_a_free_slot_is_taken_saying_nothing(self) -> None:
        out, _ = self.drain(0.1, None)
        self.assertEqual(out, "")
        self.assertTrue(self.locked())

    def test_the_drain_keeps_its_line_then_names_the_holder_at_once_and_again(self) -> None:
        self.hold("slot.1")
        record_holder(self.held[0], ["tune", "--cold"], None)
        out, took = self.drain(0.3, 1.2)
        lines = out.splitlines()
        self.assertEqual(lines[0], "EXECUTION HOLD testbox: measurement m1 waits for the batch in slot 1 to end")
        self.assertRegex(lines[1], r"^EXECUTION HOLD testbox: measurement m1 waits on slot 1: held by pid [0-9]+ for 0s"
                         r" so far, and no --deadline bounds it; .* for: tune --cold$")
        self.assertGreaterEqual(len(lines), 3, out)
        self.assertTrue(all("still waits for slot 1 after" in line for line in lines[2:]), out)
        self.assertLess(took, 5)
        self.assertTrue(self.locked())

    def test_a_holder_its_deadline_ends_soon_gets_only_the_line_it_had(self) -> None:
        self.hold("slot.1")
        record_holder(self.held[0], ["quick"], 60)
        out, _ = self.drain(0.2, 0.8)
        self.assertEqual(out, "EXECUTION HOLD testbox: measurement m1 waits for the batch in slot 1 to end\n")

    def test_a_draining_hold_records_its_slots_unbounded_until_its_command_starts(self) -> None:
        self.hold("slot.2")
        record_holder(self.held[0], ["batch"], None)
        during: list[Holder | None] = []

        def release() -> None:
            during.append(read_holder(self.path()))
            os.close(self.held.pop(0))

        class Started(Exception):
            pass

        threading.Timer(0.6, release).start()
        lock = os.path.join(self.dir, "measurement.lock")
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(slot, "run_command", side_effect=Started), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(Started):
            os.environ.pop("FLEET_MEASUREMENT_HELD", None)
            slot.hold("testbox", "", "why", lock, "testbox m1", 2, ["measure"], 900, 0.2)
        self.assertEqual([(h.command, h.deadline) if h else None for h in during], [(("measure",), None)])
        after = read_holder(self.path())
        self.assertEqual((after.command, after.deadline) if after else None, (("measure",), 900))


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

    def test_wait_window(self) -> None:
        self.assertIsNone(parse_slot(["--", "true"]).window_wait)
        self.assertEqual(parse_slot(["--wait-window", "--", "true"]).window_wait, slot.WINDOW_WAIT)
        parsed = parse_slot(["--wait-window=90", "--wait", "5", "--", "true"])
        self.assertEqual((parsed.window_wait, parsed.wait), (90, 5))
        # The bound only after `=`: a bare flag never takes the next word for one.
        self.assertIn("execution slot [--bg <parent>]", self.refused(["--wait-window", "90", "--", "true"]))
        for bad in ("--wait-window=", "--wait-window=soon", "--wait-window=-1"):
            self.assertIn("--wait-window takes a whole number of seconds", self.refused([bad, "--", "true"]), bad)


def measurement(identity: str, box: str = "testbox", state: str = "launching", window: bool = True) -> dict[str, Any]:
    record: dict[str, Any] = {
        "request_id": identity, "coordinator": "coord", "state": state, "created_at": "2026-10-12T00:00:00+00:00",
        "request": {"execution_host": box, "kind": "measurement", "worker": "w", "issue": "o/r#1"},
    }
    if window:
        record["window"] = True
    return record


class WindowWait(unittest.TestCase):
    """``--wait-window`` (ludics-lite#557), the registry re-reads stubbed in order."""

    def wait(self, first: list[dict[str, Any]], reads: list[Any], bound: int = 30) -> tuple[object, str, str]:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "0.01"}, host="testbox")
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(slot, "read_registry", side_effect=reads), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = await_measurements(cfg, "testbox", first, bound, ["echo", "x"])
        return result, out.getvalue(), err.getvalue()

    def test_a_window_that_opens_then_closes_lets_the_batch_take_a_slot(self) -> None:
        concluded = [measurement("win", state="concluded")]
        result, out, err = self.wait([measurement("win")], [[measurement("win")], concluded])
        self.assertEqual((result, out), (concluded, ""))
        self.assertEqual(err.count("measurement window win holds testbox (coordinator coord; w for o/r#1;"), 1)
        self.assertIn("waiting up to 30s (--wait-window) for it to conclude, then for a slot, for: echo x", err)
        self.assertIn("no measurement holds testbox after", err)

    def test_a_window_on_another_box_does_not_block(self) -> None:
        records = [measurement("elsewhere", box="other")]
        result, out, err = self.wait(records, [])
        self.assertEqual((result, out, err), (records, "", ""))

    def test_the_next_window_of_a_batch_is_named_too(self) -> None:
        result, _, err = self.wait([measurement("a")], [[measurement("b")], []])
        self.assertEqual(result, [])
        self.assertIn("measurement window a holds", err)
        self.assertIn("measurement window b holds", err)

    def test_a_window_still_open_at_the_bound_is_refused(self) -> None:
        with mock.patch.object(slot, "WINDOW_PROGRESS", 0):
            result, out, err = self.wait([measurement("win", window=False)], [], bound=0)
        self.assertEqual(result, 1)
        self.assertEqual(out, "EXECUTION SLOT REFUSED testbox: measurement win still holds testbox after 0s"
                         " (--wait-window); no slot taken\n")
        self.assertIn("measurement win holds testbox", err)

    def test_no_read_is_made_past_the_bound(self) -> None:
        # A read past the bound could admit the batch after it: the one stubbed read must stay unused.
        result, out, _ = self.wait([measurement("win")], [[]], bound=0)
        self.assertEqual((result, out), (1, "EXECUTION SLOT REFUSED testbox: measurement win still holds testbox"
                                            " after 0s (--wait-window); no slot taken\n"))
        reads = mock.Mock(return_value=[measurement("win")])
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "0.3"}, host="testbox")
        with mock.patch.object(slot, "read_registry", reads), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await_measurements(cfg, "testbox", [measurement("win")], 1, ["echo"]), 1)
        self.assertLessEqual(reads.call_count, 3)  # reads at 0.3, 0.6 and 0.9 s, none at 1.0

    def test_a_failed_read_mid_wait_is_asked_again_and_refused_as_itself_at_the_bound(self) -> None:
        unread = Unread(4, ("EXECUTION SLOT UNREACHABLE anchor: registry unread, no slot taken",))
        result, _, err = self.wait([measurement("win")], [unread, []])
        self.assertEqual(result, [])
        self.assertIn("the registry could not be read while waiting", err)
        result, out, _ = self.wait([measurement("win")], [unread] * 10000, bound=1)
        self.assertEqual((result, out), (4, "EXECUTION SLOT UNREACHABLE anchor: registry unread, no slot taken\n"))


class RegistryUnread(unittest.TestCase):
    """An anchor that does not answer refuses at once, and says why a fresh wake may need a retry
    (ludics-lite#617): the box's sshd answers before its own ssh to the anchor does."""

    def test_an_unreachable_anchor_refuses_at_once_naming_the_wake_leg(self) -> None:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_ANCHOR": "far-anchor"}, host="testbox")
        reads = mock.Mock(return_value=Done(UNREACHABLE, ""))
        with mock.patch.object(slot, "listing", reads):
            unread = read_registry(cfg, "testbox")
        self.assertEqual(reads.call_count, 1)  # no retry inside the slot: the caller decides
        assert isinstance(unread, Unread)
        self.assertEqual(unread.rc, 4)
        self.assertEqual(unread.lines[0], "EXECUTION SLOT UNREACHABLE far-anchor: registry unread, no slot taken")
        self.assertEqual(len(unread.lines), 2)
        self.assertTrue(unread.lines[1].startswith("EXECUTION SLOT UNREACHABLE far-anchor: a box woken in the"
                                                   " last few minutes may only need its ssh to far-anchor"))
        self.assertIn("retry", unread.lines[1])
        self.assertIn("wake-lab.sh --wait", unread.lines[1])
        # ...qualified: wake-lab asks a native-Linux box's leg and never a WSL guest's.
        self.assertIn("on a native-Linux box", unread.lines[1])
        # ...and naming this anchor, since wake-lab's own default would ask a different one.
        self.assertIn("WAKE_LAB_ANCHOR=far-anchor wake-lab.sh --wait <box>", unread.lines[1])

    def test_the_wake_command_is_offered_only_for_an_anchor_wake_lab_accepts(self) -> None:
        for anchor in ("mac-studio", "me@hub.lan", "192.0.2.1"):
            self.assertIn(f"WAKE_LAB_ANCHOR={anchor} wake-lab.sh --wait", unreachable_lines(anchor)[1])
        for anchor in ("2001:db8::1", "fe80::1%eth0", "-oProxyCommand=x", "a b"):
            retry = unreachable_lines(anchor)[1]
            self.assertNotIn("wake-lab", retry)
            self.assertIn("retry in a minute, once its route to the anchor is up", retry)
            self.assertEqual(unreachable_lines(anchor)[0],
                             f"EXECUTION SLOT UNREACHABLE {anchor}: registry unread, no slot taken")

    def test_a_far_side_failure_is_not_given_the_wake_hint(self) -> None:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_ANCHOR": "far-anchor"}, host="testbox")
        with mock.patch.object(slot, "listing", mock.Mock(return_value=Done(1, ""))):
            unread = read_registry(cfg, "testbox")
        assert isinstance(unread, Unread)
        self.assertEqual(unread.rc, 1)
        self.assertNotIn("woken", " ".join(unread.lines))


if __name__ == "__main__":
    unittest.main()
