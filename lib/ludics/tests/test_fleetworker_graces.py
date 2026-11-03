"""ludics.fleetworker.graces: THE GRACES (ludics#827), each stopping layer's TERM-to-KILL strictly
longer than the one inside it, from one input -- the ladder, its readers in the slot, the leg and
the transport, and bg-run.sh's shell spelling of its rung, run here and pinned to the module's."""

import contextlib
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from ludics import cli
from ludics.fleetworker import graces, group, leg, slot
from ludics.fleetworker.config import load_config
from ludics.fleetworker.transport import forwarded

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
BG_RUN = os.path.join(ROOT, "issue-wave", "scripts", "bg-run.sh")
SCRIPT = os.path.join(ROOT, "issue-wave", "scripts", "fleet-worker.sh")
BASH = shutil.which("bash") or "bash"


class Ladder(unittest.TestCase):
    def test_the_input_defaults_to_the_old_grace_and_reads_whole_seconds(self) -> None:
        self.assertEqual(graces.runner({}), 10)
        self.assertEqual(graces.runner({graces.ENV: ""}), 10)
        self.assertEqual(graces.runner({graces.ENV: "35"}), 35)
        self.assertEqual(graces.runner({graces.ENV: "0"}), 0)
        self.assertEqual(graces.runner({graces.ENV: "010"}), 10)

    def test_anything_but_a_whole_number_is_refused(self) -> None:
        for value in ("x", "-1", "1.5", " 5", "5s", "٣"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "FLEET_RUNNER_GRACE must be a whole number"):
                graces.runner({graces.ENV: value})

    def test_each_rung_is_strictly_longer_than_the_one_inside_it(self) -> None:
        for env in ({}, {graces.ENV: "0"}, {graces.ENV: "35"}):
            ladder = [graces.runner(env)] + [graces.seconds(rung, env) for rung in
                                             (graces.NESTED, graces.WRAPPER, graces.FAR_SHELL, graces.LEG, graces.BG_RUN)]
            with self.subTest(env=env):
                self.assertTrue(all(inner < outer for inner, outer in zip(ladder, ladder[1:])), ladder)
        self.assertEqual(graces.seconds(graces.WRAPPER, {graces.ENV: "35"}), 45)


class SlotGrace(unittest.TestCase):
    """The slot's wrapper hands group.run its rung's grace: WRAPPER's, or NESTED's for a nested batch."""

    def grace_of(self, nested: bool, env: dict[str, str]) -> float:
        seen: list[float] = []

        def run(*args: object, **kwargs: object) -> group.Outcome:
            grace = kwargs.get("grace")
            assert isinstance(grace, (int, float))
            seen.append(grace)
            return group.Exited(0)

        with mock.patch.dict(os.environ, env), mock.patch.object(slot.group, "run", run), \
                self.assertRaises(cli.Exit):
            slot.run_command("EXECUTION SLOT", "box", ["true"], None, "", 60, nested=nested)
        return seen[0]

    def test_a_top_level_wrapper_takes_the_wrapper_rung(self) -> None:
        self.assertEqual(self.grace_of(False, {graces.ENV: "35"}), 45)

    def test_a_nested_deadline_batch_takes_the_rung_inside_it(self) -> None:
        self.assertEqual(self.grace_of(True, {graces.ENV: "35"}), 40)

    def test_a_bad_input_is_refused_before_the_slot_takes_anything(self) -> None:
        cfg = load_config(SCRIPT, {"FLEET_LOCAL_BOX": "testbox", graces.ENV: "soon"}, host="h")
        with mock.patch.object(slot, "registry_source", side_effect=AssertionError("reached the registry")), \
                self.assertRaises(cli.Exit) as raised:
            slot.cmd_slot(cfg, ["--", "true"])
        self.assertEqual(raised.exception.rc, 2)
        self.assertIn("execution slot: FLEET_RUNNER_GRACE must be a whole number", str(raised.exception))
        with self.assertRaises(cli.Exit) as raised:
            slot.cmd_hold(cfg, ["--", "true"])
        self.assertEqual(raised.exception.rc, 2)


class LegGrace(unittest.TestCase):
    def test_a_bad_input_is_refused_before_anything_reaches_the_box(self) -> None:
        cfg = load_config(SCRIPT, {"FLEET_LOCAL_BOX": "hub", graces.ENV: "soon"}, host="h")
        with mock.patch.object(leg.subprocess, "Popen", side_effect=AssertionError("started something")), \
                mock.patch.object(leg.subprocess, "run", side_effect=AssertionError("ran something")), \
                self.assertRaises(cli.Exit) as raised:
            leg.cmd_leg(cfg, ["--request", "r", "--rev", "HEAD", "--checkout", "/c", "--worktree", "/w", "--", "true"])
        self.assertEqual(raised.exception.rc, 2)
        self.assertIn("execution leg: FLEET_RUNNER_GRACE must be a whole number", str(raised.exception))

    def test_the_far_side_reads_the_callers_input(self) -> None:
        for value in ("35", ""):
            cfg = load_config(SCRIPT, {"FLEET_LOCAL_BOX": "hub", "FLEET_BOXES": "hub far", graces.ENV: value}, host="h")
            with self.subTest(value=value):
                self.assertIn((graces.ENV, value), forwarded(cfg, "far"))


class BgRunRung(unittest.TestCase):
    """bg-run.sh spells BG_RUN's rung in shell: what its start records is what the module derives."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def bg(self, env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
        full = {k: v for k, v in os.environ.items() if k != graces.ENV} | env | {"BG_RUN_POLL": "1"}
        return subprocess.run([BASH, BG_RUN, *args], env=full, capture_output=True, text=True, timeout=60)

    def test_the_recorded_stop_grace_is_the_modules_bg_run_rung(self) -> None:
        for env in ({}, {graces.ENV: "0"}, {graces.ENV: "37"}):
            with self.subTest(env=env):
                spawned = self.bg(env, "spawn", os.path.join(self.tmp, "runs"), "--", "true")
                self.assertEqual(spawned.returncode, 0, spawned.stderr)
                run = spawned.stdout.strip()
                self.assertTrue(self.bg({}, "wait", run, "--within", "30").stdout.startswith("rc=0"))
                with open(os.path.join(run, "pid"), encoding="utf-8") as pid:
                    lines = pid.read().split("\n")
                self.assertEqual(lines[2], str(graces.seconds(graces.BG_RUN, env)))

    def test_a_bad_input_is_refused_by_spawn_with_nothing_allocated(self) -> None:
        parent = os.path.join(self.tmp, "bad")
        done = self.bg({graces.ENV: "soon"}, "spawn", parent, "--", "true")
        self.assertEqual(done.returncode, 2)
        self.assertIn("FLEET_RUNNER_GRACE must be a whole number", done.stderr)
        self.assertFalse(os.path.exists(parent))


if __name__ == "__main__":
    unittest.main()
