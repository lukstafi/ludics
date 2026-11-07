"""buildhistory.py (#982): the merge build's record and what an overrun says from it. The refusal
around it is in test_prreview_mergebuild.py."""

import json
import os
import shutil
import tempfile
import unittest

from ludics.prreview import budget, buildhistory
from ludics.prreview.buildhistory import Row, overrun_advice, read, record

FILE = ".github/ship-pr-merge-build"


class TheRecord(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="ludics-buildhistory-test.")
        self.was = os.environ.get("SHIP_PR_STATE_DIR")
        os.environ["SHIP_PR_STATE_DIR"] = self.dir
        self.path = os.path.join(self.dir, "merge-builds", "o--r.jsonl")

    def tearDown(self) -> None:
        if self.was is None:
            os.environ.pop("SHIP_PR_STATE_DIR", None)
        else:
            os.environ["SHIP_PR_STATE_DIR"] = self.was
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_rows_read_back_oldest_first_and_for_their_command_alone(self) -> None:
        record("o/r", "make", "passed", 7, 100)
        record("o/r", "make all", "passed", 8, 100)
        record("o/r", "make", "overran", 101, 100)
        self.assertEqual(read("o/r", "make"), [Row("passed", 7, 100), Row("overran", 101, 100)])
        self.assertEqual(read("o/other", "make"), [])

    def test_a_line_outside_the_allowlist_is_skipped(self) -> None:
        record("o/r", "make", "passed", 7, 100)
        with open(self.path, encoding="utf-8") as handle:
            row = json.loads(handle.read())
        bad = [
            "not json", "[]", "{}", "1",
            json.dumps({**row, "outcome": "failed"}),
            json.dumps({**row, "seconds": "7"}),
            json.dumps({**row, "seconds": True}),
            json.dumps({**row, "seconds": -1}),
            json.dumps({**row, "bound": 0}),
            json.dumps({**row, "at": 1}),
            "[" * 5000,
        ]
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(bad) + "\n")
        self.assertEqual(read("o/r", "make"), [Row("passed", 7, 100)])

    def test_only_the_tail_is_read_and_a_cut_line_is_dropped(self) -> None:
        for seconds in range(buildhistory.READ_BYTES // 100):
            record("o/r", "make", "passed", seconds, 100000)
        rows = read("o/r", "make")
        self.assertLess(len(rows), buildhistory.READ_BYTES // 100)
        self.assertEqual(rows[-1].seconds, buildhistory.READ_BYTES // 100 - 1)
        self.assertEqual([r.seconds for r in rows], list(range(rows[0].seconds, rows[-1].seconds + 1)))

    def test_a_directory_in_the_way_is_no_history_and_no_failure(self) -> None:
        os.makedirs(self.path)
        record("o/r", "make", "passed", 7, 100)
        self.assertEqual(read("o/r", "make"), [])

    def test_no_state_directory_and_no_repository_are_no_history(self) -> None:
        """Never a relative path: the suites' forward names no directory (budget.py), and a file
        would land in the clone the merge runs in."""
        cwd = os.getcwd()
        os.chdir(self.dir)
        try:
            os.environ[budget.ENV_BUDGET_DIR] = ""
            record("o/r", "make", "passed", 7, 100)
            self.assertEqual(read("o/r", "make"), [])
            del os.environ[budget.ENV_BUDGET_DIR]
            record("", "make", "passed", 7, 100)
            self.assertEqual(read("", "make"), [])
            self.assertEqual(os.listdir(self.dir), [])
        finally:
            os.environ.pop(budget.ENV_BUDGET_DIR, None)
            os.chdir(cwd)

    def test_no_file_is_no_history(self) -> None:
        self.assertEqual(read("o/r", "make"), [])


class TheAdvice(unittest.TestCase):
    def said(self, earlier: list[Row], bound: int = 1000) -> str:
        return " ".join(overrun_advice(earlier, bound, FILE))

    def test_nothing_on_record_says_so(self) -> None:
        said = self.said([])
        self.assertIn("is unknown", " ".join(said.split()))
        self.assertNotIn("likely repeat", said)

    def test_a_pass_at_the_tight_share_likely_repeats_and_just_under_does_not(self) -> None:
        self.assertIn("will likely repeat this overrun (the slowest pass took 80% of the bound)", self.said([Row("passed", 800, 1000)]))
        said = self.said([Row("passed", 799, 1000)])
        self.assertNotIn("likely repeat", said)
        self.assertIn("out of line", said)

    def test_the_issues_case(self) -> None:
        """ahrefs/ocannl#1994's 1145 s pass, then #1735's overrun of 1200."""
        said = self.said([Row("passed", 400, 1200), Row("passed", 1145, 1200)], 1200)
        self.assertIn("2 passed, slowest 1145s, last 1145s", said)
        self.assertIn("will likely repeat this overrun (the slowest pass took 95% of the bound)", said)
        self.assertIn("do not re-run it as it stands", said)
        self.assertIn(f"raise `timeout` in {FILE}", said)

    def test_an_earlier_overrun_counts_at_this_bound_or_a_higher_one(self) -> None:
        self.assertIn("(1 earlier overrun(s))", self.said([Row("overran", 1000, 1000)]))
        self.assertIn("(1 earlier overrun(s))", self.said([Row("overran", 2000, 2000)]))

    def test_an_overrun_of_a_lower_bound_says_nothing_of_this_one(self) -> None:
        said = self.said([Row("overran", 500, 500), Row("passed", 100, 1000)])
        self.assertNotIn("likely repeat", said)
        self.assertIn("0 overran a bound of 1000s or more", said)

    def test_both_reasons_are_named(self) -> None:
        said = self.said([Row("passed", 900, 1000), Row("overran", 1000, 1000)])
        self.assertIn("(1 earlier overrun(s) and the slowest pass took 90% of the bound)", said)

    def test_only_a_lower_bounds_overruns_leave_it_unknown(self) -> None:
        said = self.said([Row("overran", 500, 500)])
        self.assertIn("No pass is on record", said)
        self.assertNotIn("likely repeat", said)


if __name__ == "__main__":
    unittest.main()
