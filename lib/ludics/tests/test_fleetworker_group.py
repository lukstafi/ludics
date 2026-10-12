"""ludics.fleetworker.group: the command of an ``execution slot`` or ``hold`` leads a process group
of its own, and a deadline, a signal to the wrapper, or the wrapper's death ends the whole group
(ludics-lite#566).

Every fixture's ``sleep`` carries an argument of this run's own (``600.566<pid><n>``), so a check
for leftovers cannot see a sibling's processes, nor another case's."""

import os
import signal
import subprocess
import time
import unittest
from collections.abc import Callable
from types import FrameType

from ludics.fleetworker import group

MARK = f"600.566{os.getpid()}"


def running(mark: str) -> bool:
    return subprocess.run(["pgrep", "-f", f"sleep {mark}"], capture_output=True, check=False).returncode == 0


def gone(mark: str, within: float = 5.0) -> bool:
    until = time.monotonic() + within
    while running(mark):
        if time.monotonic() > until:
            return False
        time.sleep(0.05)
    return True


class Group(unittest.TestCase):
    def setUp(self) -> None:
        self.lines: list[str] = []
        self.marks: list[str] = []

    def tearDown(self) -> None:
        for mark in self.marks:
            subprocess.run(["pkill", "-KILL", "-f", f"sleep {mark}"], capture_output=True, check=False)

    def mark(self) -> str:
        mark = f"{MARK}{len(self.marks) + 1}"
        self.marks.append(mark)
        return mark

    def run_group(self, script: str, deadline: int | None, grace: float = 2.0) -> group.Outcome:
        return group.run(["bash", "-c", script], deadline, "T", self.lines.append, grace)

    def test_a_deadline_ends_the_tree_at_the_bound_and_says_so(self) -> None:
        mark = self.mark()
        start = time.monotonic()
        self.assertEqual(self.run_group(f"sleep {mark} & wait", 1), group.Expired())
        self.assertLess(time.monotonic() - start, 5)
        self.assertTrue(gone(mark), "the deadline left the grandchild running")
        self.assertIn("T: --deadline 1s reached: ending the command's process group", self.lines[0])

    def test_a_deadline_reaches_an_orphan_in_the_group(self) -> None:
        # The #1192 shape: the process that started the worker is gone, and the worker, reparented
        # away from every wrapper, still runs. Only the group still names it.
        orphan, leader = self.mark(), self.mark()
        script = f"sh -c 'sleep {orphan} >/dev/null 2>&1 &'; exec sleep {leader}"
        self.assertEqual(self.run_group(script, 1), group.Expired())
        self.assertTrue(gone(orphan) and gone(leader), "the deadline missed the orphan")

    def test_a_group_that_ignores_sigterm_is_killed_after_the_grace(self) -> None:
        mark = self.mark()
        start = time.monotonic()
        self.assertEqual(self.run_group(f"trap '' TERM; sleep {mark} & wait", 1, grace=1), group.Expired())
        self.assertGreaterEqual(time.monotonic() - start, 1.9)
        self.assertTrue(gone(mark), "SIGKILL never followed the ignored SIGTERM")

    def test_the_command_status_is_its_own(self) -> None:
        self.assertEqual(self.run_group("exit 3", None), group.Exited(3))
        self.assertEqual(self.run_group("kill -TERM $$", 5), group.Killed(signal.SIGTERM))
        self.assertEqual(self.lines, [])

    def test_without_a_deadline_what_the_command_left_runs_on(self) -> None:
        mark = self.mark()
        self.assertEqual(self.run_group(f"sleep {mark} >/dev/null 2>&1 &", None), group.Exited(0))
        time.sleep(0.3)  # a guardian that killed it would have done so by now
        self.assertTrue(running(mark), "the leftover was ended though no deadline bounds it")

    def test_with_a_deadline_what_the_command_left_is_ended_with_it(self) -> None:
        mark = self.mark()
        start = time.monotonic()
        self.assertEqual(self.run_group(f"sleep {mark} >/dev/null 2>&1 &", 60), group.Exited(0))
        self.assertLess(time.monotonic() - start, 5)
        self.assertTrue(gone(mark), "the leftover outlived its command under a deadline")
        self.assertIn("still runs: ending it (--deadline)", self.lines[0])

    def test_a_signal_to_the_wrapper_ends_the_group(self) -> None:
        mark = self.mark()
        before = signal.getsignal(signal.SIGTERM)
        # From another process, not a thread: the wrapper forks its guardian, and a fork beside a
        # live thread is what Python warns of.
        sender = subprocess.Popen(["sh", "-c", f"sleep 1; kill -TERM {os.getpid()}"])
        try:
            self.assertEqual(self.run_group(f"sleep {mark} & wait", None), group.Interrupted(signal.SIGTERM))
        finally:
            sender.wait()
        self.assertTrue(gone(mark), "a signalled wrapper left its group running")
        self.assertIn("T: SIGTERM received: ending the command's process group", self.lines[0])
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)

    def test_a_signal_the_caller_ignores_stays_ignored_for_the_command(self) -> None:
        before = signal.signal(signal.SIGHUP, signal.SIG_IGN)
        try:
            self.assertEqual(self.run_group("kill -HUP $$; exit 7", None), group.Exited(7))
        finally:
            signal.signal(signal.SIGHUP, before)

    def test_the_guardian_ends_the_group_of_a_wrapper_killed_outright(self) -> None:
        mark = self.mark()
        child = os.fork()
        if child == 0:
            try:
                group.run(["bash", "-c", f"sleep {mark} & wait"], None, "T", lambda _: None)
            finally:
                os._exit(0)
        until = time.monotonic() + 10
        while not running(mark) and time.monotonic() < until:
            time.sleep(0.05)
        self.assertTrue(running(mark), "the fixture never started")
        os.kill(child, signal.SIGKILL)
        os.waitpid(child, 0)
        self.assertTrue(gone(mark), "a SIGKILLed wrapper left its group running")

    def test_a_command_that_cannot_start_raises_and_restores_the_handlers(self) -> None:
        before: list[Callable[[int, FrameType | None], object] | int | None] = [
            signal.getsignal(s) for s in group.FORWARDED
        ]
        with self.assertRaises(OSError):
            group.run(["/nonexistent/runner"], 5, "T", self.lines.append)
        self.assertEqual([signal.getsignal(s) for s in group.FORWARDED], before)


if __name__ == "__main__":
    unittest.main()
