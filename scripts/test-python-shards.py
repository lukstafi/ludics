#!/usr/bin/env python3
"""Pin module coverage and shard refusals without executing the package tests.

Boundary: reads python-unit's literal part list and PYTHON_TEST_CUTS scalar in
skill-scripts.yml, and test_*.py paths under lib/. This checks that workflow shape,
not general YAML or test source. Synthetic lists exercise additions and bad cuts.
"""

from collections import Counter
import importlib.util
from pathlib import Path
import re
import unittest

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

    def test_single_shard(self):
        self.assertEqual(shards.select(["a", "b"], [], "0/1"), ["a", "b"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
