"""ludics.fleetworker.leg: the near side's reading of a leg's far side (the shell suite's `execution
leg` section drives the whole verb against a fake remote)."""

import contextlib
import io
import shutil
import unittest
from typing import Any
from unittest import mock

from ludics.fleetworker import leg, slot
from ludics.fleetworker.config import load_config


class Stream(unittest.TestCase):
    """The leg's status is the sentinel's when it came, else the far side's own, and ssh's 255 with
    no sentinel is UNREACHABLE (4), since a runner's 255 always comes with one."""

    def run_far(self, script: str, *, local: bool) -> tuple[int, str, str]:
        out, said, err = io.BytesIO(), io.StringIO(), io.StringIO()

        class Out:
            """The leg's stdout: the far side's bytes through ``buffer``, its own lines through ``write``."""

            buffer = out

            def write(self, text: str) -> int:
                return said.write(text)

            def flush(self) -> None:
                pass

        bash = shutil.which("bash") or "/bin/bash"
        with contextlib.redirect_stderr(err), mock.patch.object(leg.sys, "stdout", Out()):
            rc = leg.stream([bash, "-s"], script, "box", "t0k", local=local)
        return rc, out.getvalue().decode(), said.getvalue() + err.getvalue()

    def test_the_sentinel_is_the_status_and_every_line_passes_through(self) -> None:
        rc, out, _ = self.run_far("echo one\nprintf 'execution-leg t0k: exit: 125\\n'\nexit 0\n", local=False)
        self.assertEqual((rc, out), (125, "one\nexecution-leg: exit: 125\n"))

    def test_a_sentinel_after_output_with_no_newline_gets_a_line_of_its_own(self) -> None:
        rc, out, _ = self.run_far("printf partial; printf 'execution-leg t0k: exit: 255\\n'; exit 255\n", local=False)
        self.assertEqual((rc, out), (255, "partial\nexecution-leg: exit: 255\n"))

    def test_output_with_no_newline_passes_through_as_it_comes(self) -> None:
        rc, out, _ = self.run_far("head -c 300000 /dev/zero | tr '\\0' 'z'; echo 'execution-leg t0k: exit: 3'\n", local=True)
        self.assertEqual(rc, 3)
        self.assertEqual(out, "z" * 300000 + "\nexecution-leg: exit: 3\n")

    def test_only_the_far_sides_own_token_reports_a_status(self) -> None:
        # A nested leg's line, or a runner's, is output: with the connection gone before the far
        # side reported, the leg is UNREACHABLE, not the status a runner line named.
        rc, out, err = self.run_far("echo 'execution-leg: exit: 0'; echo 'execution-leg f00: exit: 0'; exit 255\n", local=False)
        self.assertEqual(rc, 4)
        self.assertEqual(out, "execution-leg: exit: 0\nexecution-leg f00: exit: 0\n")
        self.assertIn("EXECUTION LEG UNREACHABLE box:", err)

    def test_no_sentinel_is_the_far_sides_own_status_or_unreachable(self) -> None:
        self.assertEqual(self.run_far("exit 1\n", local=False)[0], 1)
        self.assertEqual(self.run_far("exit 255\n", local=True)[0], 255)
        rc, _, err = self.run_far("exit 255\n", local=False)
        self.assertEqual(rc, 4)
        self.assertIn("EXECUTION LEG UNREACHABLE box:", err)

    def test_a_script_longer_than_a_pipe_is_fed_while_the_far_side_writes(self) -> None:
        filler = "".join(f": {'x' * 70}\n" for _ in range(2000))  # ~150 KB of no-ops after the output
        script = "head -c 200000 /dev/zero | tr '\\0' 'y'; echo\n" + filler + "echo 'execution-leg t0k: exit: 0'\n"
        self.assertEqual(self.run_far(script, local=True)[0], 0)


if __name__ == "__main__":
    unittest.main()


def standing(state: str = "suspended", by: str = "w1") -> dict[str, Any]:
    record: dict[str, Any] = {
        "request_id": "it", "coordinator": "coord", "state": state, "created_at": "2026-10-18T00:00:00+00:00",
        "request": {"execution_host": "testbox", "kind": "correctness", "standing": True, "worker": "w", "issue": "o/r#1"},
    }
    if state == "suspended":
        record.update(suspended_by=by, suspended_from="launching")
    return record


def window(identity: str, state: str = "launching") -> dict[str, Any]:
    return {"request_id": identity, "coordinator": "coord", "state": state, "window": True,
            "created_at": "2026-10-18T00:00:00+00:00",
            "request": {"execution_host": "testbox", "kind": "measurement", "worker": "m", "issue": "o/r#2"}}


class WindowWait(unittest.TestCase):
    """THE WINDOW WAIT (ludics-lite#666): a leg whose standing record a window suspended waits for it
    under --wait-window in the slot's own wait, the registry re-reads stubbed in order."""

    def wait(self, reads: list[Any], flags: list[str], first: list[dict[str, Any]] | None = None
             ) -> tuple[object, str, str, int]:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "agent", "FLEET_SLOT_WINDOW_POLL": "0.01"}, host="agent")
        records = first if first is not None else [standing(), window("w1")]
        out, err = io.StringIO(), io.StringIO()
        reader = mock.Mock(side_effect=reads)
        with mock.patch.object(slot, "read_registry", reader), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = leg.await_window(cfg, "it", records[0], records, flags, ["tools/check.sh"])
        return result, out.getvalue(), err.getvalue(), reader.call_count

    def test_without_wait_window_it_is_refused_at_once_naming_the_window(self) -> None:
        result, out, _, reads = self.wait([], ["--cpu"])
        self.assertEqual((result, reads), (1, 0))
        self.assertEqual(out, "EXECUTION LEG REFUSED: it is suspended by measurement window w1; run the leg once that"
                              " window concludes, or give it --wait-window, which waits for it\n")

    def test_a_window_that_closes_inside_the_bound_lets_the_leg_run_with_the_rest_of_it(self) -> None:
        restored = [standing("launching"), window("w1", "concluded")]
        result, out, err, _ = self.wait([[standing(), window("w1")], restored], ["--cpu", "--wait-window=30", "--wait", "0"])
        assert isinstance(result, tuple)
        record, flags = result
        self.assertEqual((record["state"], out), ("launching", ""))
        # The far side's slot gets what is left of the one bound (a started second spent), the
        # other flags as they were.
        self.assertEqual(flags[:3], ["--cpu", "--wait", "0"])
        self.assertIn(flags[3], [f"--wait-window={n}" for n in range(25, 30)])
        self.assertIn("EXECUTION LEG testbox: measurement window w1 holds testbox (coordinator coord; m for o/r#2;", err)
        self.assertIn("EXECUTION LEG testbox: waiting up to 30s (--wait-window) for it to conclude, then for a slot,"
                      " for: tools/check.sh", err)
        self.assertIn("EXECUTION LEG testbox: no measurement holds testbox after 0s; running the leg", err)

    def test_a_window_opened_mid_wait_is_waited_for_too(self) -> None:
        # The coordinator's back-to-back windows: w1 concludes and w2 suspends the record again
        # between two reads, so the leg never sees it restored until w2 concludes.
        second = [standing(by="w2"), window("w1", "concluded"), window("w2")]
        restored = [standing("launching"), window("w1", "concluded"), window("w2", "concluded")]
        result, out, err, reads = self.wait([[standing(), window("w1")], second, second, restored], ["--wait-window"])
        assert isinstance(result, tuple)
        self.assertEqual((result[0]["state"], out, reads), ("launching", "", 4))
        self.assertIn(result[1], [[f"--wait-window={slot.WINDOW_WAIT - n}"] for n in range(1, 6)])
        self.assertIn("measurement window w1 holds testbox", err)
        self.assertIn("measurement window w2 holds testbox", err)

    def test_a_window_that_outlasts_the_bound_is_refused_as_the_slot_refuses_naming_it(self) -> None:
        result, out, err, reads = self.wait([[standing(), window("w1")]], ["--wait-window=0"])
        self.assertEqual((result, reads), (1, 0))
        self.assertEqual(out, "EXECUTION LEG REFUSED testbox: measurement w1 still holds testbox after 0s"
                              " (--wait-window); nothing ran\n")
        self.assertIn("measurement window w1 holds testbox", err)

    def test_a_record_still_suspended_once_nothing_holds_the_box_is_refused(self) -> None:
        stuck = [standing(), window("w1", "concluded")]
        result, out, _, _ = self.wait([stuck], ["--wait-window=30"])
        self.assertEqual(result, 1)
        self.assertEqual(out, "EXECUTION LEG REFUSED: it is still suspended by w1, though no measurement holds testbox;"
                              " nothing ran\n")

    def test_a_record_gone_from_the_registry_after_the_wait_is_refused(self) -> None:
        result, out, _, _ = self.wait([[window("w1", "concluded")]], ["--wait-window=30"])
        self.assertEqual(result, 1)
        self.assertIn("EXECUTION LEG REFUSED: unknown request_id it after waiting for window w1", out)

    def test_the_bound_is_the_last_wait_window_given(self) -> None:
        self.assertIsNone(leg.window_bound(["--cpu", "--wait", "5"]))
        self.assertEqual(leg.window_bound(["--wait-window"]), slot.WINDOW_WAIT)
        self.assertEqual(leg.window_bound(["--wait-window=90", "--wait-window=7"]), 7)
        self.assertEqual(leg.window_bound(["--wait-window=7", "--wait-window"]), slot.WINDOW_WAIT)
