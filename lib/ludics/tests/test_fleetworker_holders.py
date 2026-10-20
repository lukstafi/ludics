"""ludics.fleetworker.holders: ``execution slot --holders`` lists the held slots of a box with their
kinds, its holders read from a lock table's FLOCK lines by device and inode, and every field it
cannot know named in ``unknown`` (ludics-lite#639)."""

import contextlib
import fcntl
import io
import json
import os
import shutil
import tempfile
import time
import unittest
from collections.abc import Sequence
from typing import Any

from ludics import cli
from ludics.fleetworker import cotenants, holders
from ludics.tests import fake
from ludics.fleetworker.slot import parse_slot

FIELDS = ("pid", "user", "command", "cwd")


class FakePs:
    """``ps -o pid= -o user= -o args= -p <pids>`` answering for the pids it knows."""

    def __init__(self, known: dict[int, tuple[str, str]]) -> None:
        self.known = known
        self.calls: list[list[str]] = []

    def __call__(self, argv: Sequence[str]) -> tuple[int, str]:
        self.calls.append(list(argv))
        asked = [int(p) for p in argv[-1].split(",")]
        lines = [f"{p} {self.known[p][0]} {self.known[p][1]}" for p in asked if p in self.known]
        return (0 if len(lines) == len(asked) else 1), "".join(line + "\n" for line in lines)


class SlotDir(unittest.TestCase):
    """A box's slot directory, its flocks held by this process."""

    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-holders-test."))
        self.dir = os.path.join(self.root, "testbox")
        os.mkdir(self.dir)
        self.held: list[int] = []

    def tearDown(self) -> None:
        for descriptor in self.held:
            os.close(descriptor)
        shutil.rmtree(self.root)

    def hold(self, name: str) -> None:
        descriptor = os.open(os.path.join(self.dir, name), os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.held.append(descriptor)

    def touch(self, name: str) -> None:
        with open(os.path.join(self.dir, name), "w"):
            pass

    def table_line(self, name: str, pid: int, waiter: bool = False, kind: str = "FLOCK") -> str:
        status = os.stat(os.path.join(self.dir, name))
        arrow = "-> " if waiter else ""
        return (f"1: {arrow}{kind}  ADVISORY  WRITE {pid} {os.major(status.st_dev):02x}:"
                f"{os.minor(status.st_dev):02x}:{status.st_ino} 0 EOF")

    def write_table(self, lines: list[str]) -> str:
        path = os.path.join(self.root, "locks")
        with open(path, "w") as table:
            table.write("".join(line + "\n" for line in lines))
        return path


class Holders(SlotDir):
    def test_with_no_lock_table_held_slots_are_listed_with_their_kinds_and_the_holder_unknown(self) -> None:
        self.hold("slot.1")  # a GPU token (one token of three slots)
        self.touch("slot.2")  # free: not listed
        self.hold("slot.3")  # past the tokens: a cpu slot
        self.hold("measurement.lock")  # not a slot file
        self.touch("slot.x")
        lines = holders.holders("testbox", self.dir, 3, 1, run=FakePs({}),
                                locks=os.path.join(self.root, "no-locks"), platform="Darwin")
        self.assertEqual([(line["slot"], line["kind"]) for line in lines], [(1, "gpu"), (3, "cpu")])
        for line in lines:
            self.assertEqual((line["box"], line["event"], line["slots"], line["source"]), ("testbox", "held", 3, "flock-test"))
            self.assertEqual([line[name] for name in FIELDS], [None] * 4)
            # A bare flock wrote no holder record (#712): ``record`` null, and named.
            self.assertIsNone(line["record"])
            self.assertEqual(sorted(line["unknown"]), sorted(FIELDS + ("record",)))
            self.assertIn("holds no holder record", line["unknown"]["record"])
            self.assertIn("no " + os.path.join(self.root, "no-locks") + " on this system (Darwin)", line["unknown"]["pid"])
            self.assertRegex(line["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$")

    def test_a_box_whose_tokens_do_not_bind_lists_every_slot_as_gpu(self) -> None:
        self.hold("slot.6")
        lines = holders.holders("testbox", self.dir, 6, 0, run=FakePs({}), locks=os.path.join(self.root, "none"))
        self.assertEqual([(line["slot"], line["kind"]) for line in lines], [(6, "gpu")])

    def test_a_slot_file_past_the_count_is_listed_when_held(self) -> None:
        self.hold("slot.5")
        lines = holders.holders("testbox", self.dir, 3, 1, run=FakePs({}), locks=os.path.join(self.root, "none"))
        self.assertEqual([(line["slot"], line["slots"], line["kind"]) for line in lines], [(5, 3, "cpu")])

    def test_the_lock_table_names_the_holder_by_device_and_inode(self) -> None:
        self.hold("slot.1")
        self.hold("slot.2")
        self.hold("slot.3")
        self.touch("slot.4")
        proc = os.path.join(self.root, "proc")
        os.makedirs(os.path.join(proc, "4242"))
        os.symlink("/work/tree", os.path.join(proc, "4242", "cwd"))
        locks = self.write_table([
            self.table_line("slot.1", 4242),
            self.table_line("slot.3", 99, waiter=True),  # a waiter is not the holder
            self.table_line("slot.3", 98, kind="POSIX"),  # nor a POSIX lock
            self.table_line("slot.2", 777),  # ps no longer lists it
            self.table_line("slot.4", 55),  # listed, but the test finds it free: not held
            "garbage",
        ])
        run = FakePs({4242: ("alice", "python3 -m ludics.fleetworker fleet-worker.sh execution slot -- sleep 30")})
        lines = holders.holders("testbox", self.dir, 3, 1, run=run, locks=locks, proc=proc)
        by_slot = {line["slot"]: line for line in lines}
        self.assertEqual(sorted(by_slot), [1, 2, 3])
        one = by_slot[1]
        self.assertEqual((one["pid"], one["user"], one["command"], one["cwd"], one["source"], list(one["unknown"])),
                         (4242, "alice", "python3 -m ludics.fleetworker fleet-worker.sh execution slot -- sleep 30",
                          "/work/tree", "proc-locks", ["record"]))
        self.assertIsNone(one["record"])  # a bare flock: no holder record (#712)
        two = by_slot[2]
        self.assertEqual((two["pid"], two["user"], two["command"], two["cwd"]), (777, None, None, None))
        self.assertEqual(sorted(two["unknown"]), ["command", "cwd", "record", "user"])
        self.assertIn("ps does not list pid 777", two["unknown"]["user"])
        three = by_slot[3]
        self.assertEqual((three["pid"], three["source"]), (None, "proc-locks"))
        self.assertIn("no FLOCK line of " + locks + " names this slot file's device and inode", three["unknown"]["pid"])
        self.assertEqual(run.calls, [["ps", "-o", "pid=", "-o", "user=", "-o", "args=", "-p", "777,4242"]])

    def test_a_line_on_another_device_is_not_the_slot_s_holder(self) -> None:
        self.hold("slot.1")
        status = os.stat(os.path.join(self.dir, "slot.1"))
        other = (os.major(status.st_dev), os.minor(status.st_dev) + 1)
        locks = self.write_table([f"1: FLOCK  ADVISORY  WRITE 4242 {other[0]:02x}:{other[1]:02x}:{status.st_ino} 0 EOF"])
        [line] = holders.holders("testbox", self.dir, 1, 0, run=FakePs({}), locks=locks)
        self.assertEqual((line["pid"], line["source"]), (None, "proc-locks"))

    def test_a_holder_outside_this_pid_namespace_is_unknown(self) -> None:
        self.hold("slot.1")
        locks = self.write_table([self.table_line("slot.1", 0)])
        run = FakePs({})
        [line] = holders.holders("testbox", self.dir, 1, 0, run=run, locks=locks)
        self.assertIsNone(line["pid"])
        self.assertIn("names pid 0: a holder outside this pid namespace", line["unknown"]["pid"])
        self.assertEqual(run.calls, [])

    @unittest.skipIf(os.geteuid() == 0, "root opens a mode-000 file")
    def test_a_slot_whose_lock_cannot_be_tested_is_said_never_read_as_free(self) -> None:
        self.hold("slot.1")
        self.hold("slot.2")
        os.chmod(os.path.join(self.dir, "slot.1"), 0o444)  # another user's: readable, not writable
        os.chmod(os.path.join(self.dir, "slot.2"), 0o000)  # not even readable
        locks = os.path.join(self.root, "none")
        lines = holders.holders("testbox", self.dir, 2, 0, run=FakePs({}), locks=locks)
        self.assertEqual([(line["slot"], line["event"]) for line in lines], [(1, "held"), (2, "untested")])
        self.assertIn("cannot open it to test its lock", lines[1]["unknown"]["held"])
        self.assertIn("cannot open it to test its lock", lines[1]["unknown"]["record"])
        self.assertIsNone(lines[1]["record"])
        # The lock table names a holder the test could not reach: held.
        table = self.write_table([self.table_line("slot.2", 4242)])
        run = FakePs({4242: ("alice", "sleep 30")})
        lines = holders.holders("testbox", self.dir, 2, 0, run=run, locks=table, proc=os.path.join(self.root, "proc"))
        self.assertEqual([(line["slot"], line["event"], line["pid"]) for line in lines], [(1, "held", None), (2, "held", 4242)])

    def test_a_missing_slot_directory_lists_nothing(self) -> None:
        self.assertEqual(holders.holders("testbox", os.path.join(self.root, "absent"), 3, 1), [])

    def test_render_is_one_json_object_per_line(self) -> None:
        self.hold("slot.1")
        text = holders.render(holders.holders("testbox", self.dir, 1, 0, run=FakePs({}),
                                              locks=os.path.join(self.root, "none")))
        self.assertEqual([json.loads(line)["slot"] for line in text.splitlines()], [1])
        self.assertEqual(holders.render([]), "")


class FakeLsof:
    """``lsof -t -- <file>`` answering with a scripted status and output."""

    def __init__(self, rc: int, out: str) -> None:
        self.rc, self.out = rc, out
        self.calls: list[list[str]] = []

    def __call__(self, argv: Sequence[str]) -> tuple[int, str]:
        self.calls.append(list(argv))
        return self.rc, self.out


class Confirmation(SlotDir):
    """THE CONFIRMATION (ludics-lite#712): a held slot's record is confirmed, unconfirmed or unknown,
    from the lock table, /proc/<pid>/fd or lsof -- never from ps."""

    def record(self, name: str, pid: int, deadline: int | None = 600, expires: float | None = None) -> None:
        with open(os.path.join(self.dir, name), "w") as stream:
            stream.write(json.dumps({"pid": pid, "command": ["make", "a b"], "started": 1_800_000_000,
                                     "deadline": deadline, "expires": expires}))

    def fake_proc(self, openers: dict[int, str]) -> str:
        """A /proc with ``self/fd`` (so the proc-fd reader is chosen), each pid's fd 3 linked to its path."""
        proc = os.path.join(self.root, "proc")
        os.makedirs(os.path.join(proc, "self", "fd"))
        for pid, target in openers.items():
            os.makedirs(os.path.join(proc, str(pid), "fd"))
            os.symlink(target, os.path.join(proc, str(pid), "fd", "3"))
        return proc

    def one(self, run: cotenants.Runner | None = None, proc: str | None = None,
            locks: str | None = None, seen: str = "mine") -> dict[str, Any]:
        lines = holders.holders("testbox", self.dir, 1, 0, run=run or FakePs({}),
                                locks=locks or os.path.join(self.root, "none"),
                                proc=proc or os.path.join(self.root, "no-proc"), seen=lambda _: seen)
        [line] = lines
        record: dict[str, Any] = line["record"]
        self.assertNotIn("record", line["unknown"])
        return record

    def test_the_lock_table_confirms_the_recorded_pid_and_the_record_s_fields_are_shown(self) -> None:
        self.hold("slot.1")
        self.record("slot.1", 4242, 600)
        locks = self.write_table([self.table_line("slot.1", 4242)])
        record = self.one(FakePs({4242: ("alice", "python3 fleet-worker")}), locks=locks)
        self.assertEqual((record["verdict"], record["by"], record["pid"], record["pids"]), ("confirmed", "proc-locks", 4242, [4242]))
        self.assertEqual((record["command"], record["deadline"], record["left"], record["taken"]),
                         ("make 'a b'", 600, 600, "2027-01-15T08:00:00+00:00"))

    def test_a_record_of_another_pid_than_the_lock_table_s_is_unconfirmed_and_shows_nothing_of_itself(self) -> None:
        self.hold("slot.1")
        self.record("slot.1", 4242)
        locks = self.write_table([self.table_line("slot.1", 777)])
        record = self.one(locks=locks)
        self.assertEqual((record["verdict"], record["by"], record["pid"], record["pids"]), ("unconfirmed", "proc-locks", 4242, [777]))
        self.assertIn("names pid 777 as the lock's holder, not the recorded pid 4242", record["why"])
        self.assertEqual([record[k] for k in ("command", "taken", "deadline", "left")], [None] * 4)

    def test_with_no_holder_in_the_lock_table_the_open_descriptors_decide(self) -> None:
        self.hold("slot.1")
        slot_path = os.path.realpath(os.path.join(self.dir, "slot.1"))
        # pid 0 in the table: a holder outside this namespace; the proc-fd reader decides instead.
        locks = self.write_table([self.table_line("slot.1", 0)])
        self.record("slot.1", 4242, None)
        proc = self.fake_proc({4242: slot_path, 4243: slot_path, 555: "/elsewhere"})
        record = self.one(locks=locks, proc=proc)
        self.assertEqual((record["verdict"], record["by"], record["pids"], record["deadline"], record["left"]),
                         ("confirmed", "proc-fd", [4242, 4243], None, None))
        self.record("slot.1", 99)
        record = self.one(locks=locks, proc=proc)
        self.assertEqual((record["verdict"], record["by"], record["pids"], record["command"]), ("unconfirmed", "proc-fd", [4242, 4243], None))
        self.assertIn("pid 99 does not have the slot file open (proc-fd); open by pid 4242, 4243, which may hold the lock or test it",
                      record["why"])
        self.assertIn("pid 99 is not running", self.one(locks=locks, proc=proc, seen="gone")["why"])
        # Another user's process: its descriptors are not visible, so no negative read is made.
        record = self.one(locks=locks, proc=proc, seen="foreign")
        self.assertEqual((record["verdict"], record["pids"]), ("unknown", None))
        self.assertIn("pid 99 is another user's process", record["why"])

    @unittest.skipIf(os.geteuid() == 0, "root reads a mode-000 directory")
    def test_a_recorded_pid_whose_descriptors_cannot_be_read_is_unknown(self) -> None:
        # A non-dumpable process of this user's passes the signal-0 test, but its fds are unreadable.
        self.hold("slot.1")
        self.record("slot.1", 4242)
        proc = self.fake_proc({4243: os.path.realpath(os.path.join(self.dir, "slot.1"))})
        os.makedirs(os.path.join(proc, "4242", "fd"))
        os.chmod(os.path.join(proc, "4242", "fd"), 0o000)
        try:
            record = self.one(proc=proc, seen="mine")
        finally:
            os.chmod(os.path.join(proc, "4242", "fd"), 0o755)
        self.assertEqual((record["verdict"], record["by"], record["pids"]), ("unknown", "proc-fd", None))
        self.assertIn("pid 4242's descriptors are not readable here", record["why"])

    def test_the_reader_s_own_pid_is_never_an_opener(self) -> None:
        self.hold("slot.1")
        me = os.getpid()
        self.record("slot.1", me)
        proc = self.fake_proc({me: os.path.realpath(os.path.join(self.dir, "slot.1"))})
        record = self.one(proc=proc)
        self.assertEqual((record["verdict"], record["pids"]), ("unconfirmed", []))
        self.assertIn("no other process seen here has it open", record["why"])

    def test_without_proc_lsof_decides_and_cannot_answer_is_unknown(self) -> None:
        self.hold("slot.1")
        self.record("slot.1", 4242, 600, time.monotonic() + 120.6)
        lsof = FakeLsof(0, "4242\n5000\n")
        record = self.one(lsof)
        self.assertEqual((record["verdict"], record["by"], record["pids"]), ("confirmed", "lsof", [4242, 5000]))
        self.assertIn(record["left"], (119, 120))
        self.assertEqual(lsof.calls[0][1:], ["-t", "--", os.path.join(self.dir, "slot.1")])
        self.assertTrue(lsof.calls[0][0].endswith("lsof"))
        record = self.one(FakeLsof(1, ""))
        self.assertEqual((record["verdict"], record["by"], record["pids"]), ("unconfirmed", "lsof", []))
        for rc, out, why in ((127, "", "lsof is not installed here"), (124, "", "lsof did not answer within 15s"),
                             (2, "", "lsof failed (exit 2)"), (0, "4242 x\n", "lsof's answer is not a list of pids"),
                             (1, "4242\n", "lsof failed (exit 1)")):
            record = self.one(FakeLsof(rc, out))
            self.assertEqual((record["verdict"], record["by"], record["pids"], record["command"]), ("unknown", "lsof", None, None), why)
            self.assertIn(why, record["why"])

    def test_the_slots_are_confirmed_at_once_not_one_lsof_after_another(self) -> None:
        def slow(argv: Sequence[str]) -> tuple[int, str]:
            time.sleep(0.6)
            return 1, ""

        for index in (1, 2, 3, 4):
            self.hold(f"slot.{index}")
            self.record(f"slot.{index}", 4242)
        start = time.monotonic()
        lines = holders.holders("testbox", self.dir, 4, 0, run=slow, locks=os.path.join(self.root, "none"),
                                proc=os.path.join(self.root, "no-proc"), seen=lambda _: "mine")
        self.assertLess(time.monotonic() - start, 1.8)
        self.assertEqual([(line["slot"], line["record"]["verdict"]) for line in lines],
                         [(index, "unconfirmed") for index in (1, 2, 3, 4)])

    def test_a_real_held_slot_is_confirmed_and_a_stale_record_is_not(self) -> None:
        """Against this box's kernel: the lock table on Linux, lsof on macOS."""
        path = os.path.join(self.dir, "slot.1")
        holder = fake.SlotHolder(path)
        self.addCleanup(holder.close)
        [line] = holders.holders("testbox", self.dir, 1, 0)
        record = line["record"]
        self.assertEqual((record["verdict"], record["pid"], record["command"], record["deadline"]),
                         ("confirmed", holder.pid, "sleep 30", 600), line)
        self.assertIn(record["by"], ("proc-locks", "lsof"))
        self.assertTrue(0 < record["left"] <= 300, line)
        holder.close()
        # The negative control: a record of a live process of this user that does not hold it.
        stale = fake.SlotHolder(path, recorded=os.getppid())
        self.addCleanup(stale.close)
        [line] = holders.holders("testbox", self.dir, 1, 0)
        record = line["record"]
        self.assertEqual((record["verdict"], record["pid"], record["command"]), ("unconfirmed", os.getppid(), None), line)
        self.assertIn(stale.pid, record["pids"], line)


class Waiters(unittest.TestCase):
    """ludics-lite#719: ``--holders`` lists the batches waiting here from their ``waiting.<pid>``
    records, and only while each record's flock is held."""

    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="ludics-holders-waiters.")
        self.addCleanup(shutil.rmtree, self.dir)

    def record(self, pid: int, text: str, locked: bool = True) -> None:
        path = os.path.join(self.dir, f"waiting.{pid}")
        with open(path, "w") as f:
            f.write(text)
        if locked:
            descriptor = os.open(path, os.O_RDONLY)
            self.addCleanup(os.close, descriptor)
            fcntl.flock(descriptor, fcntl.LOCK_EX)

    def test_a_locked_record_is_listed_in_order_of_its_wait_and_an_unlocked_one_is_not(self) -> None:
        self.record(12, json.dumps({"pid": 12, "command": "make b", "since": "2026-10-20T10:00:05Z",
                                    "phase": "slot", "kind": "cpu"}))
        self.record(11, json.dumps({"pid": 11, "command": "make a", "since": "2026-10-20T10:00:01Z",
                                    "phase": "window", "kind": "gpu"}))
        self.record(13, "{}", locked=False)
        lines = holders.waiters("testbox", self.dir)
        self.assertEqual([(line["pid"], line["phase"], line["kind"], line["command"]) for line in lines],
                         [(11, "window", "gpu", "make a"), (12, "slot", "cpu", "make b")])
        self.assertEqual({(line["event"], line["source"], line["box"]) for line in lines},
                         {("waiting", "waiting-record", "testbox")})
        self.assertEqual([line["unknown"] for line in lines], [{}, {}])

    def test_a_record_that_does_not_parse_is_listed_with_its_fields_unknown(self) -> None:
        self.record(21, "{")
        self.record(22, json.dumps({"pid": 22, "since": "2026-10-20T10:00:00Z", "phase": "slot", "kind": "cpu"}))
        lines = {line["pid"]: line for line in holders.waiters("testbox", self.dir)}
        self.assertEqual(set(lines[21]["unknown"]), {"phase", "kind", "command", "since"})
        self.assertEqual(list(lines[22]["unknown"]), ["command"])
        self.assertIsNone(lines[22]["command"])

    def test_a_command_with_undecodable_bytes_is_shown_escaped(self) -> None:
        argument = b"caf\xe9".decode("utf-8", "surrogateescape")
        self.record(31, json.dumps({"pid": 31, "command": f"echo {argument}", "since": "s", "phase": "slot", "kind": "cpu"}))
        (line,) = holders.waiters("testbox", self.dir)
        self.assertEqual(line["command"], "echo caf\\xe9")
        holders.render([line]).encode("utf-8")

    def test_nothing_else_in_the_directory_is_a_waiter(self) -> None:
        for name in ("slot.1", "waiting.x", ".waiting-abc", "waiting.12.json"):
            open(os.path.join(self.dir, name), "w").close()
        self.assertEqual(holders.waiters("testbox", self.dir), [])
        self.assertEqual(holders.waiters("testbox", os.path.join(self.dir, "missing")), [])


class HoldersArguments(unittest.TestCase):
    def refused(self, args: list[str]) -> str:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(cli.Exit) as caught:
            parse_slot(args)
        self.assertEqual(caught.exception.rc, 2)
        return caught.exception.message

    def test_holders_takes_no_other_word(self) -> None:
        parsed = parse_slot(["--holders"])
        self.assertEqual((parsed.holders, parsed.probe, parsed.command), (True, False, []))
        for args in (["--holders", "--cpu"], ["--probe", "--holders"], ["--wait", "5", "--holders"],
                     ["--holders", "--", "true"]):
            self.assertIn("--holders takes no other word", self.refused(args), args)
        # After `--` it is the command's own word.
        self.assertEqual(parse_slot(["--", "echo", "--holders"]).command, ["echo", "--holders"])


if __name__ == "__main__":
    unittest.main()
