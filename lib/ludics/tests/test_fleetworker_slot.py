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
        self.write(json.dumps(good | {"expires": 12.5}))
        self.assertEqual(read_holder(self.path()), Holder(7, ("x",), 1.5, 60, 12.5))
        bads: list[dict[str, object]] = [
            {"pid": True}, {"pid": 0}, {"pid": "7"}, {"command": []}, {"command": "x"}, {"command": ["x", 1]},
            {"started": "1"}, {"started": False}, {"deadline": 0}, {"deadline": 1.5}, {"deadline": True},
            {"pid": 2**31}, {"expires": "1"}, {"expires": True}, {"started": 10**400}, {"expires": 10**400},
        ]
        for bad in bads:
            self.write(json.dumps(good | bad))
            self.assertIsNone(read_holder(self.path()), bad)
        for text in ("", "not json", "[]", "[" * 60000, '{"pid": 7, "command": ["x"], "started": NaN, "deadline": null}',
                     json.dumps(good | {"pad": "x" * slot.HOLDER_READ})):
            self.write(text)
            self.assertIsNone(read_holder(self.path()), text[:40])
        self.assertIsNone(read_holder(os.path.join(self.dir, "slot.9")))

    def line(self, holder: Holder | None, now: float = 10_000.0, clock: float = 0.0,
             waited: float | None = None) -> str:
        return holder_line("testbox", "m1", 2, holder, now, clock, waited)

    def test_the_line_names_a_holder_that_may_hold_the_slot_long_as_recorded(self) -> None:
        now = 10_000.0
        unbounded = self.line(Holder(4242, ("sleep", "a b"), now - 125, None), now)
        self.assertEqual(unbounded, "EXECUTION HOLD testbox: measurement m1 waits on slot 2: recorded holder pid 4242,"
                         " slot taken 2m ago, no --deadline recorded; for: sleep 'a b'")
        # The cap left is read on the clock the deadline is enforced on: ``expires`` against
        # time.monotonic(), whatever the wall clock says.
        capped = self.line(Holder(4242, ("tune",), now - 600, 6000, 5400.0), now, 0.0, 310)
        self.assertEqual(capped, "EXECUTION HOLD testbox: measurement m1 still waits for slot 2 after 5m: recorded holder"
                         " pid 4242, slot taken 10m ago, recorded --deadline 6000s, about 1h30m left; for: tune")
        # Before its command starts, all of its deadline is ahead.
        self.assertIn("about 1h40m left;", str(self.line(Holder(4242, ("tune",), now - 600, 6000), now)))
        # A short or spent cap is reported too: the record may be an earlier taker's, so no
        # record of it may silence the line.
        self.assertIn("recorded --deadline 60s, about 30s left;", self.line(Holder(4242, ("x",), now, 60, 30.0), now))
        self.assertIn("recorded --deadline 60s, about 0s left;", self.line(Holder(4242, ("x",), now, 60, -5.0), now))

    def test_the_line_judges_nothing_about_the_pid_and_advises_nothing(self) -> None:
        # An ended pid is said as recorded too: the record is what the line reports.
        line = str(self.line(Holder(ended_pid(), ("x",), 0.0, None), 0.0))
        self.assertIn("recorded holder pid", line)
        self.assertNotIn("stop", line)

    def test_no_record_is_said(self) -> None:
        self.assertIn("measurement m1 waits on slot 2: its holder left no record of its command or --deadline",
                      str(self.line(None)))

    def test_a_recorded_command_is_quoted_on_one_line(self) -> None:
        line = str(self.line(Holder(4242, ("sh", "-c", "a\nb\x1b"), 0.0, None), 0.0))
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
        self.assertRegex(lines[1], r"^EXECUTION HOLD testbox: measurement m1 waits on slot 1: recorded holder pid [0-9]+,"
                         r" slot taken 0s ago, no --deadline recorded; for: tune --cold$")
        self.assertGreaterEqual(len(lines), 3, out)
        self.assertTrue(all("still waits for slot 1 after" in line for line in lines[2:]), out)
        self.assertLess(took, 5)
        self.assertTrue(self.locked())

    def test_a_holder_its_deadline_ends_soon_is_named_too(self) -> None:
        self.hold("slot.1")
        record_holder(self.held[0], ["quick"], 60)
        out, _ = self.drain(0.2, 0.8)
        self.assertIn("recorded --deadline 60s, about 1m left; for: quick", out)

    def test_nothing_the_naming_raises_stops_the_drain(self) -> None:
        self.hold("slot.1")
        with mock.patch.object(slot, "read_holder", side_effect=OverflowError("int too large")):
            out, took = self.drain(0.2, 0.8)
        self.assertIn("measurement m1 waits on slot 1: its record is unread (OverflowError('int too large'))", out)
        self.assertLess(took, 5)
        self.assertTrue(self.locked())

    def test_a_draining_hold_records_its_slots_unbounded_until_its_command_starts(self) -> None:
        self.hold("slot.2")
        record_holder(self.held[0], ["batch"], None)
        during: list[Holder | None] = []

        def release() -> None:
            during.append(read_holder(self.path()))
            os.close(self.held.pop(0))

        threading.Timer(0.6, release).start()
        lock = os.path.join(self.dir, "measurement.lock")
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(slot, "run_command", side_effect=started), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(Started):
            os.environ.pop("FLEET_MEASUREMENT_HELD", None)
            slot.hold("testbox", "", "why", lock, "testbox m1", 2, ["measure"], 900, 0.2)
        self.assertEqual([(h.command, h.deadline, h.expires) if h else None for h in during], [(("measure",), None, None)])
        after = read_holder(self.path())
        assert after is not None and during[0] is not None
        self.assertEqual((after.command, after.deadline, after.started), (("measure",), 900, during[0].started))
        # Its deadline's end, on the clock the deadline is enforced on, from the command's start.
        self.assertAlmostEqual(after.expires or 0.0, time.monotonic() + 900, delta=5)

    def test_a_batch_records_its_deadline_end_when_its_command_starts(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(slot, "run_command", side_effect=started), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(Started):
            slot.take_slot("testbox", self.dir, 1, 0, True, 0, "", ["suite"], 1200)
        after = read_holder(self.path())
        self.assertEqual((after.command, after.deadline, after.pid) if after else None, (("suite",), 1200, os.getpid()))
        self.assertAlmostEqual(after.expires if after and after.expires else 0.0, time.monotonic() + 1200, delta=5)


class Started(Exception):
    pass


def started(*args: object, **kwargs: object) -> None:
    """``run_command`` stubbed: the command starts (its ``on_start``), and nothing runs."""
    on_start = kwargs.get("on_start")
    if callable(on_start):
        on_start()
    raise Started

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


class Waiting(unittest.TestCase):
    """THE WAITING RECORD (ludics-lite#719): a ``waiting.<pid>`` file, flocked while the batch waits,
    removed and released before it runs or is refused."""

    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="ludics-waiting-test.")
        self.addCleanup(shutil.rmtree, self.dir)

    def held(self, name: str) -> bool:
        descriptor = os.open(os.path.join(self.dir, name), os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        finally:
            os.close(descriptor)
        return False

    def test_the_record_is_locked_while_it_waits_says_its_phase_and_is_gone_when_done(self) -> None:
        waiting = slot.WaitingRecord(self.dir, ["make", "test"], "window", "cpu")
        name = f"waiting.{os.getpid()}"
        self.assertEqual(os.listdir(self.dir), [name], "no temporary file is left beside it")
        self.assertTrue(self.held(name))
        with open(os.path.join(self.dir, name)) as f:
            data = json.load(f)
        self.assertEqual((data["pid"], data["command"], data["phase"], data["kind"]), (os.getpid(), "make test", "window", "cpu"))
        waiting.phase("slot")
        with open(os.path.join(self.dir, name)) as f:
            self.assertEqual(json.load(f)["phase"], "slot")
        waiting.done()
        waiting.done()
        self.assertEqual(os.listdir(self.dir), [])

    def test_a_record_its_owner_left_unlocked_is_removed_by_the_next_waiter_and_a_locked_one_is_kept(self) -> None:
        for name in ("waiting.1", "waiting.2"):
            with open(os.path.join(self.dir, name), "w") as f:
                f.write("{}")
        keeper = os.open(os.path.join(self.dir, "waiting.2"), os.O_RDONLY)
        self.addCleanup(os.close, keeper)
        fcntl.flock(keeper, fcntl.LOCK_EX)
        young = os.path.join(self.dir, ".waiting-young")
        open(young, "w").close()
        old = os.path.join(self.dir, ".waiting-old")
        open(old, "w").close()
        os.utime(old, (time.time() - 120, time.time() - 120))
        waiting = slot.WaitingRecord(self.dir, ["x"], "slot", "gpu")
        self.addCleanup(waiting.done)
        self.assertEqual(sorted(os.listdir(self.dir)), sorted([".waiting-young", "waiting.2", f"waiting.{os.getpid()}"]))

    def test_a_directory_it_cannot_write_says_so_and_waits_without_a_record(self) -> None:
        open(os.path.join(self.dir, "file"), "w").close()   # a file where its directory would go
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            waiting = slot.WaitingRecord(os.path.join(self.dir, "file", "sub"), ["x"], "slot", "gpu")
        self.assertIn("no waiting record in", err.getvalue())
        self.assertIsNone(waiting.descriptor)
        waiting.phase("slot")
        waiting.done()

    def test_an_argument_that_is_not_utf8_is_recorded_escaped(self) -> None:
        # Round 2 of #736: undecodable bytes reach Python as lone surrogates.
        argument = b"caf\xe9".decode("utf-8", "surrogateescape")
        waiting = slot.WaitingRecord(self.dir, ["echo", argument], "slot", "gpu")
        self.addCleanup(waiting.done)
        with open(os.path.join(self.dir, f"waiting.{os.getpid()}"), encoding="ascii") as f:
            self.assertEqual(json.load(f)["command"], f"echo {argument}")

    def test_the_heartbeat_is_released_once_the_slot_is_held_or_the_wait_refused(self) -> None:
        released: list[str] = []
        with mock.patch.object(slot, "run_command", mock.Mock(side_effect=cli.Exit(0))), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(cli.Exit):
            slot.take_slot("testbox", self.dir, 1, 0, False, 0, "", ["make"], None, release=lambda: released.append("held"))
        # The slot just taken stays locked on a descriptor this test cannot reach: a box of its own.
        busy = os.path.join(self.dir, "busy")
        os.mkdir(busy)
        blocker = os.open(os.path.join(busy, "slot.1"), os.O_CREAT | os.O_RDWR, 0o644)
        self.addCleanup(os.close, blocker)
        fcntl.flock(blocker, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(cli.Exit):
            slot.take_slot("testbox", busy, 1, 0, False, 0, "", ["make"], None, release=lambda: released.append("refused"))
        self.assertEqual(released, ["held", "refused"])

    def test_the_release_after_a_slot_is_taken_does_not_wait_and_holds_nothing_inherited(self) -> None:
        # Rounds 3 and 4 of #736: an anchor that stopped answering keeps nothing waiting, a held slot
        # nor a refusal past its bound.
        marker = os.path.join(self.dir, "released")

        def slow_listing(_cfg: object, waiter: Any = None) -> None:
            time.sleep(2)
            with open(marker + ".tmp", "w") as f:
                json.dump(waiter, f)
            os.replace(marker + ".tmp", marker)   # whole, so the poll below never reads it half-written

        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh", {"FLEET_LOCAL_BOX": "testbox"}, host="testbox")
        read, write = os.pipe()
        os.set_inheritable(write, True)
        started = time.monotonic()
        with mock.patch.object(slot, "listing", slow_listing):
            slot.release_waiter(cfg, {"id": "testbox-1", "box": "testbox", "command": "x", "ttl": 30})
        self.assertLess(time.monotonic() - started, 1.5, "it does not wait for the anchor")
        os.close(write)
        reader = threading.Thread(target=os.read, args=(read, 1))
        reader.start()
        reader.join(1.5)
        self.assertFalse(reader.is_alive(), "the release holds no inherited descriptor (EOF at once)")
        os.close(read)
        deadline = time.monotonic() + 10
        while not os.path.exists(marker) and time.monotonic() < deadline:
            time.sleep(0.1)
        with open(marker) as f:
            self.assertEqual(json.load(f), {"id": "testbox-1", "done": True})
        slot.release_waiter(cfg, None)

    def test_a_batch_queued_for_a_slot_is_recorded_and_runs_without_its_record(self) -> None:
        # A held slot 1 makes the batch wait; freed, the batch takes it, and its command sees no record.
        blocker = os.open(os.path.join(self.dir, "slot.1"), os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(blocker, fcntl.LOCK_EX)
        seen: list[list[str]] = []

        def release() -> None:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not any(n.startswith("waiting.") for n in os.listdir(self.dir)):
                time.sleep(0.05)
            seen.append(sorted(os.listdir(self.dir)))
            os.close(blocker)

        def run(*_: object, **__: object) -> None:
            seen.append(sorted(os.listdir(self.dir)))
            raise cli.Exit(0)

        thread = threading.Thread(target=release)
        thread.start()
        with mock.patch.object(slot, "run_command", run), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(cli.Exit):
                slot.take_slot("testbox", self.dir, 1, 0, False, 30, "", ["make"], None)
        thread.join()
        self.assertIn(f"waiting.{os.getpid()}", seen[0], "recorded while it waited")
        self.assertEqual(seen[1], ["slot.1"], "and gone once it held the slot")


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

    def test_a_measurement_without_an_issue_is_named_by_its_purpose(self) -> None:
        # ludics-lite#664: `issue` is optional; a post-wave task's record names none.
        record = measurement("win")
        del record["request"]["issue"]
        record["request"]["purpose"] = "post-1-task-2 timing"
        _, _, err = self.wait([record], [[record], [measurement("win", state="concluded")]])
        self.assertIn("(coordinator coord; w for post-1-task-2 timing;", err)

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
        self.assertLessEqual(reads.call_count, 4)  # reads at 0 (the first heartbeat), 0.3, 0.6 and 0.9 s, none at 1.0

    def test_a_read_that_returns_past_the_bound_does_not_admit_the_batch(self) -> None:
        # A slow transport: the read starts inside the bound and answers "closed" after it.
        def slow(*_: object) -> list[dict[str, Any]]:
            time.sleep(1.2)
            return []

        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "0.1"}, host="testbox")
        out = io.StringIO()
        with mock.patch.object(slot, "read_registry", side_effect=slow), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await_measurements(cfg, "testbox", [measurement("win")], 1, ["echo"]), 1)
        self.assertIn("still holds testbox after 1s (--wait-window); no slot taken", out.getvalue())

    def test_every_read_in_the_wait_is_a_heartbeat_and_the_first_is_at_once(self) -> None:
        # THE WAITERS (ludics-lite#719): the anchor hears of this waiter from the wait's start.
        reads = mock.Mock(side_effect=[[measurement("win")], []])
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "20"}, host="testbox")
        started = time.monotonic()
        with mock.patch.object(slot, "read_registry", reads), mock.patch.object(slot.time, "sleep"), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await_measurements(cfg, "testbox", [measurement("win")], 600, ["make", "test"]), [])
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(reads.call_count, 2)
        for call in reads.call_args_list:
            waiter = call.args[3]
            self.assertEqual((waiter["box"], waiter["command"], waiter["ttl"]), ("testbox", "make test", 60))
            self.assertRegex(waiter["id"], rf"\Atestbox-{os.getpid()}\Z")
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "0.01"}, host="testbox")
        reads = mock.Mock(return_value=[])
        with mock.patch.object(slot, "read_registry", reads), contextlib.redirect_stderr(io.StringIO()):
            await_measurements(cfg, "testbox", [measurement("win")], 600, ["x"])
        self.assertEqual(reads.call_args.args[3]["ttl"], 30, "a short poll still gets 30 s")

    def test_a_wait_whose_caller_registered_it_reads_first_after_a_poll(self) -> None:
        # Round 1 of #736: the caller's read that found the box held already carried the heartbeat.
        reads = mock.Mock(return_value=[])
        sleeps = mock.Mock()
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "20"}, host="testbox")
        with mock.patch.object(slot, "read_registry", reads), mock.patch.object(slot.time, "sleep", sleeps), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await_measurements(cfg, "testbox", [measurement("win")], 600, ["x"], registered=True), [])
        self.assertEqual((sleeps.call_count, reads.call_count), (1, 1))

    def test_the_read_that_may_find_a_window_registers_the_waiter(self) -> None:
        # cmd_slot with --wait-window: its first read is the heartbeat; without it, a plain list.
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_BOXES": "testbox",
                           "FLEET_SLOT_STATE": tempfile.mkdtemp(prefix="ludics-slot-state.")}, host="testbox")
        self.addCleanup(shutil.rmtree, cfg.env["FLEET_SLOT_STATE"])
        for flags, carried in ((["--wait-window=60"], True), ([], False)):
            reads = mock.Mock(return_value=slot.Unread(1, ("refused",)))
            with mock.patch.object(slot, "read_registry", reads), mock.patch.object(slot, "registry_source"), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(slot.cmd_slot(cfg, [*flags, "--", "make"]), 1)
            waiter = reads.call_args.kwargs.get("waiter")
            self.assertEqual(waiter is not None, carried, flags)
            if waiter is not None:
                self.assertEqual((waiter["box"], waiter["command"]), ("testbox", "make"))
        # A wait refused at its bound releases the heartbeat it registered.
        listings: list[Any] = []

        def release(_cfg: object, waiter: Any = None) -> None:
            listings.append(waiter)

        held = [{"request_id": "win", "state": "launching", "window": True,
                 "request": {"execution_host": "testbox", "kind": "measurement"}}]
        with mock.patch.object(slot, "read_registry", mock.Mock(return_value=held)), \
                mock.patch.object(slot, "registry_source"), \
                mock.patch.object(slot, "release_waiter", side_effect=release), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(slot.cmd_slot(cfg, ["--wait-window=0", "--", "make"]), 1)
        self.assertEqual(len(listings), 1)
        self.assertEqual((listings[0]["box"], listings[0]["command"]), ("testbox", "make"))
        self.assertRegex(listings[0]["id"], rf"\Atestbox-{os.getpid()}\Z")

    def test_a_late_read_that_answers_clears_an_earlier_failed_one(self) -> None:
        unread = Unread(4, ("EXECUTION SLOT UNREACHABLE anchor: registry unread, no slot taken",))
        answers: list[Any] = [unread]

        def reads(*_: object) -> Any:
            if answers:
                return answers.pop()
            time.sleep(1.2)  # answers, but past the bound
            return []

        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "0.1"}, host="testbox")
        out = io.StringIO()
        with mock.patch.object(slot, "read_registry", side_effect=reads), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await_measurements(cfg, "testbox", [measurement("win")], 1, ["echo"]), 1)
        self.assertEqual(out.getvalue(), "EXECUTION SLOT REFUSED testbox: measurement win still holds testbox after 1s"
                                         " (--wait-window); no slot taken\n")

    def test_a_late_read_that_fails_is_the_refusal(self) -> None:
        unread = Unread(4, ("EXECUTION SLOT UNREACHABLE anchor: registry unread, no slot taken",))

        def reads(*_: object) -> Any:
            time.sleep(1.2)  # fails, past the bound
            return unread

        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "0.1"}, host="testbox")
        out = io.StringIO()
        with mock.patch.object(slot, "read_registry", side_effect=reads), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(await_measurements(cfg, "testbox", [measurement("win")], 1, ["echo"]), 4)
        self.assertEqual(out.getvalue(), "EXECUTION SLOT UNREACHABLE anchor: registry unread, no slot taken\n")

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
