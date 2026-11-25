#!/usr/bin/env python3
"""Pin module coverage, shard headroom, and refusals without executing the package tests.

Boundary: reads python-unit's literal part list, PYTHON_TEST_CUTS scalar, and
LUDICS_TEST_WATCHDOG scalar in skill-scripts.yml, test_*.py paths under lib/, and
MODULE_TIMINGS in scripts/run-python-tests.py. This checks that workflow shape and
recorded-timing headroom, not general YAML, live CI logs, or application test source.
Synthetic lists exercise additions, bad cuts, and headroom refusals (including the
pre-#1336 4-shard plan); a fake clock exercises timing, load order and failure
semantics. A temporary copy of this checker and runner probes bytecode-free importing.
"""

from collections import Counter
import contextlib
import importlib.util
import io
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

# Preflight also runs on the served checkout, whose freshness check includes ignored
# files: importing the runner must not create scripts/__pycache__ there.
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("shards", ROOT / "scripts/run-python-tests.py")
assert spec and spec.loader
shards = importlib.util.module_from_spec(spec)
sys.modules["shards"] = shards
spec.loader.exec_module(shards)


def _workflow_python_unit() -> tuple[list[int], list[str], float]:
    workflow = (ROOT / ".github/workflows/skill-scripts.yml").read_text(encoding="utf-8")
    job = workflow.split("\n  python-unit:\n", 1)[1].split("\n  # ----", 1)[0]
    parts = re.search(r"^        part: \[([0-9, ]+)\]$", job, re.M)
    cuts = re.search(r"^      PYTHON_TEST_CUTS: (\S+)$", job, re.M)
    watchdog = re.search(r"^          LUDICS_TEST_WATCHDOG:\s*'?([0-9]+(?:\.[0-9]+)?)'?$", job, re.M)
    if parts is None or cuts is None or watchdog is None:
        raise AssertionError("could not parse part, PYTHON_TEST_CUTS, and LUDICS_TEST_WATCHDOG from python-unit")
    rows = [int(x) for x in parts[1].split(",")]
    return rows, cuts[1].split("|"), float(watchdog[1])


class Shards(unittest.TestCase):
    def test_workflow_covers_every_module_once(self):
        rows, cuts, _watchdog = _workflow_python_unit()
        self.assertEqual(rows, list(range(len(rows))))
        all_modules = shards.modules(ROOT / "lib")
        selected = [module for i in rows for module in shards.select(
            all_modules, cuts, f"{i}/{len(rows)}")]
        expected = [".".join(p.relative_to(ROOT / "lib").with_suffix("").parts)
                    for p in (ROOT / "lib").rglob("test_*.py")]
        self.assertEqual(Counter(selected), Counter(expected))
        self.assertTrue(all(count == 1 for count in Counter(selected).values()))

    def test_workflow_shards_have_headroom(self):
        rows, cuts, watchdog = _workflow_python_unit()
        all_modules = shards.modules(ROOT / "lib")
        plans = shards.check_headroom(all_modules, cuts, watchdog)
        self.assertEqual(len(plans), len(rows))
        for plan in plans:
            self.assertGreaterEqual(plan.headroom + 1e-9, shards.MIN_HEADROOM_SECONDS)

    def test_headroom_boundary_and_refusal(self):
        # Exact boundary passes (100.0 * 1.7 = 170.0 -> 30.0s headroom).
        plans = shards.check_headroom(
            ["a", "b"],
            ["b"],
            200.0,
            {"a": 100.0, "b": 100.0},
            slow_scale=1.7,
            min_headroom=30.0,
        )
        self.assertEqual(len(plans), 2)
        self.assertAlmostEqual(plans[0].headroom, 30.0)

        # Exceeding by 0.1s scaled refuses and names the shard and heaviest module.
        with self.assertRaises(ValueError) as error:
            shards.check_headroom(
                ["a", "b", "c"],
                ["c"],
                200.0,
                {"a": 10.0, "b": 112.0, "c": 50.0},
                slow_scale=1.4,
                min_headroom=30.0,
            )
        message = str(error.exception)
        self.assertIn("shard 0/2", message)
        self.assertIn("b=112.0s", message)
        self.assertIn("headroom 29.2s < 30.0s", message)

    def test_old_four_shard_plan_fails_headroom(self):
        # Negative control: the pre-#1336 4-shard cut list puts both prompt-CLI halves in shard 0.
        all_modules = shards.modules(ROOT / "lib")
        old_cuts = [
            "ludics.tests.test_fleetworker_execution",
            "ludics.tests.test_fleetworker_wave",
            "ludics.tests.test_prreview_gate",
        ]
        with self.assertRaises(ValueError) as error:
            shards.check_headroom(all_modules, old_cuts, 200.0)
        message = str(error.exception)
        self.assertIn("shard 0/4", message)
        self.assertIn("ludics.tests.test_checkprompts_cli", message)

        # Even isolated alone, a single 164.1s module breaks the 200s watchdog on a 1.4x runner.
        with self.assertRaises(ValueError) as single_error:
            shards.check_headroom(
                ["ludics.tests.test_checkprompts_cli", "ludics.tests.test_other"],
                ["ludics.tests.test_other"],
                200.0,
                {"ludics.tests.test_checkprompts_cli": 164.1, "ludics.tests.test_other": 10.0},
            )
        self.assertIn("shard 0/2", str(single_error.exception))

    def test_headroom_charges_unrecorded_module_default(self):
        plans = shards.check_headroom(
            ["a", "new_mod"],
            [],
            200.0,
            {"a": 100.0},
            slow_scale=1.4,
            min_headroom=30.0,
            unrecorded_seconds=5.0,
        )
        self.assertAlmostEqual(plans[0].planned, 105.0)
        self.assertEqual(plans[0].unrecorded, ("new_mod",))

        with self.assertRaises(ValueError) as error:
            shards.check_headroom(
                ["a", "new_1", "new_2", "new_3"],
                [],
                200.0,
                {"a": 110.0},
                slow_scale=1.4,
                min_headroom=30.0,
                unrecorded_seconds=5.0,
            )
        self.assertIn("shard 0/1", str(error.exception))

    def test_headroom_refuses_stale_or_invalid_inputs(self):
        with self.assertRaises(ValueError) as stale:
            shards.check_headroom(["a"], [], 200.0, {"a": 1.0, "gone'x": 2.0})
        self.assertIn(shlex.quote("gone'x"), str(stale.exception))

        for bad_value in (-1.0, math.nan, math.inf, True):
            with self.subTest(bad_value=bad_value), self.assertRaises(ValueError):
                shards.check_headroom(["a"], [], 200.0, {"a": bad_value})

        for kwargs in (
            {"watchdog": 0.0},
            {"watchdog": math.inf},
            {"watchdog": True},
            {"watchdog": 200.0, "slow_scale": 0.0},
            {"watchdog": 200.0, "slow_scale": True},
            {"watchdog": 200.0, "min_headroom": -1.0},
            {"watchdog": 200.0, "min_headroom": 200.0},
            {"watchdog": 200.0, "min_headroom": False},
            {"watchdog": 200.0, "unrecorded_seconds": -0.5},
            {"watchdog": 200.0, "unrecorded_seconds": False},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                shards.check_headroom(["a"], [], timings={"a": 1.0}, **kwargs)

    def test_cli_check_headroom_exit_codes(self):
        _rows, cuts, watchdog = _workflow_python_unit()
        env = {"PYTHON_TEST_CUTS": "|".join(cuts), "LUDICS_TEST_WATCHDOG": str(int(watchdog))}
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            rc = shards.main(["--check-headroom"])
        self.assertEqual(rc, 0, stderr.getvalue())
        self.assertIn("shard 0/5:", stdout.getvalue())

        bad_env = {
            "PYTHON_TEST_CUTS": "ludics.tests.test_fleetworker_execution|ludics.tests.test_fleetworker_wave|ludics.tests.test_prreview_gate",
            "LUDICS_TEST_WATCHDOG": "200",
        }
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, bad_env, clear=False), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            rc = shards.main(["--check-headroom"])
        self.assertEqual(rc, 1)
        self.assertIn("insufficient shard headroom", stderr.getvalue())

    def test_runner_import_leaves_no_bytecode(self):
        with tempfile.TemporaryDirectory(prefix="python-shards-") as temporary:
            scripts = Path(temporary) / "scripts"
            scripts.mkdir()
            for name in ("run-python-tests.py", "test-python-shards.py"):
                shutil.copyfile(ROOT / "scripts" / name, scripts / name)
            environment = os.environ.copy()
            environment.pop("PYTHONDONTWRITEBYTECODE", None)
            child = subprocess.run(
                [sys.executable, str(scripts / "test-python-shards.py"),
                 "Shards.test_single_shard"],
                env=environment, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(child.returncode, 0, child.stderr)
            self.assertEqual(list(scripts.rglob("*.pyc")), [])

    def test_refusal_shell_quotes_module_path(self):
        with tempfile.TemporaryDirectory(prefix="python-shards-quote-") as temporary:
            path = Path(temporary) / "test_$(echo bad)'x.py"
            path.touch()
            with self.assertRaises(ValueError) as error:
                shards.modules(Path(temporary))
            self.assertIn(shlex.quote(str(path)), str(error.exception))

    def test_new_module_lands_automatically(self):
        modules = ["a", "b", "c", "d", "new"]
        self.assertEqual(shards.select(modules, ["c"], "0/2"), ["a", "b"])
        self.assertEqual(shards.select(modules, ["c"], "1/2"), ["c", "d", "new"])

    def test_lost_matrix_row_refuses(self):
        with self.assertRaises(ValueError):
            shards.select(["a", "b", "c"], ["b", "c"], "0/2")

    def test_bad_cuts_refuse(self):
        for cuts in (["absent"], ["a"], ["c", "b"], ["b", "b"]):
            with self.subTest(cuts=cuts), self.assertRaises(ValueError):
                shards.select(["a", "b", "c"], cuts, f"0/{len(cuts) + 1}")

    def test_bad_shards_refuse(self):
        for shard in ("-1/2", "1/1", "0/0", "x/2", "0/2/3"):
            with self.subTest(shard=shard), self.assertRaises(ValueError):
                shards.select(["a", "b"], [], shard)

    def test_elapsed_preserves_loading_order_and_failure_semantics(self):
        events = []

        class Case(unittest.TestCase):
            def test_run(self):
                events.append("run")

        class FixtureCase(unittest.TestCase):
            @classmethod
            def setUpClass(cls):
                events.append("class setup")

            @classmethod
            def tearDownClass(cls):
                events.append("class teardown")

            def test_one(self):
                events.append("one")

            def test_two(self):
                events.append("two")

        class Loader(unittest.TestLoader):
            def loadTestsFromName(self, name, module=None):
                events.append("load " + name)
                if name == "fixtures":
                    return self.loadTestsFromTestCase(FixtureCase)
                if name == "missing":
                    return super().loadTestsFromName("absent_shard_fixture_module")
                return self.loadTestsFromTestCase(Case)

        output = io.StringIO()
        # Module 1 succeeds, module 2 is an import error, module 3 still runs.
        with mock.patch.object(shards.unittest, "TestLoader", Loader), \
                mock.patch.object(shards.time, "monotonic",
                                  side_effect=[10, 11.25, 20, 22.5, 30, 30.125]), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            result = shards.run_modules(["fixtures", "missing", "last"])
        self.assertEqual(events, ["load fixtures", "load missing", "load last",
                                  "class setup", "one", "two", "class teardown", "run"])
        self.assertEqual(result.testsRun, 4)
        self.assertEqual(len(result.errors), 1)
        self.assertFalse(result.wasSuccessful())
        self.assertEqual(output.getvalue().splitlines(), [
            "--- 1.250s: fixtures", "--- 2.500s: missing", "--- 0.125s: last"])

        # A successful shard still reports success through the same shared result.
        with mock.patch.object(shards.unittest, "TestLoader", Loader), \
                mock.patch.object(shards.time, "monotonic", side_effect=[1, 1.5]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(shards.run_modules(["last"]).wasSuccessful())

    def test_single_shard(self):
        self.assertEqual(shards.select(["a", "b"], [], "0/1"), ["a", "b"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
