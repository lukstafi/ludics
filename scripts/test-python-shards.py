#!/usr/bin/env python3
"""Pin module coverage and shard refusals without executing the package tests.

Boundary: reads python-unit's literal part list and PYTHON_TEST_CUTS scalar in
skill-scripts.yml, and test_*.py paths under lib/. This checks that workflow shape,
not general YAML or application test source. Synthetic lists exercise additions and
bad cuts; a fake clock exercises timing, load order and failure semantics. A temporary
copy of this checker and runner probes bytecode-free importing.
"""

from collections import Counter
import importlib.util
import contextlib
import io
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
spec.loader.exec_module(shards)


class Shards(unittest.TestCase):
    def test_workflow_covers_every_module_once(self):
        workflow = (ROOT / ".github/workflows/skill-scripts.yml").read_text()
        job = workflow.split("\n  python-unit:\n", 1)[1].split("\n  # ----", 1)[0]
        parts = re.search(r"^        part: \[([0-9, ]+)\]$", job, re.M)
        cuts = re.search(r"^      PYTHON_TEST_CUTS: (\S+)$", job, re.M)
        self.assertIsNotNone(parts)
        self.assertIsNotNone(cuts)
        rows = [int(x) for x in parts[1].split(",")]
        self.assertEqual(rows, list(range(len(rows))))
        all_modules = shards.modules(ROOT / "lib")
        selected = [module for i in rows for module in shards.select(
            all_modules, cuts[1].split("|"), f"{i}/{len(rows)}")]
        expected = [".".join(p.relative_to(ROOT / "lib").with_suffix("").parts)
                    for p in (ROOT / "lib").rglob("test_*.py")]
        self.assertEqual(Counter(selected), Counter(expected))
        self.assertTrue(all(count == 1 for count in Counter(selected).values()))

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
