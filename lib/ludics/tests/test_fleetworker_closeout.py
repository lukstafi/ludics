"""closeout.py (#982), its readers one input at a time. The verb's whole flow -- the steps, the one
line, the refusals before any write and a re-run resuming a partial close -- is pinned end to end
in issue-wave/scripts/test-fleet-worker.sh's "execution conclude --standing-handback" section."""

import contextlib
import io
import os
import unittest
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import closeout
from ludics.fleetworker.config import load_config

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CFG = load_config(os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh"), {"FLEET_ANCHOR": "local"}, host="testbox")
OID = "a" * 40


def record(identity: str, state: str = "running", standing: bool = True, worker: str = "w1", wave: str = "w",
           checkout: str | None = "/wt", repository: str = "o/r") -> dict[str, Any]:
    made: dict[str, Any] = {"request_id": identity, "state": state, "request": {
        "wave": wave, "worker": worker, "repository": repository, **({"standing": True} if standing else {})}}
    return {**made, "checkout": checkout} if checkout else made


class Refusing(unittest.TestCase):
    def refuses(self, rc: int, text: str, call: Any, *args: Any) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(cli.Exit) as caught:
            call(*args)
        self.assertEqual(caught.exception.rc, rc, out.getvalue())
        self.assertIn(text, out.getvalue())


class TheRecords(Refusing):
    def test_an_open_record_is_to_conclude_off_its_own_checkout_a_concluded_one_is_not(self) -> None:
        records = [record("a", checkout="/a"), record("b", checkout="/b"), record("c", state="concluded")]
        todo, others = closeout.to_conclude("w", "t", records, ["a", "b", "c"], "o/r", "w1")
        self.assertEqual((todo, others), ([("a", "/a"), ("b", "/b")], []))

    def test_each_refusal(self) -> None:
        self.refuses(1, "x, which the registry does not hold", closeout.to_conclude, "w", "t", [], ["x"], "o/r", "")
        self.refuses(1, "which is no standing reservation", closeout.to_conclude, "w", "t", [record("x", standing=False)], ["x"], "o/r", "")
        self.refuses(1, "x records no checkout", closeout.to_conclude, "w", "t", [record("x", checkout=None)], ["x"], "o/r", "")

    def test_a_named_record_of_another_task_is_refused(self) -> None:
        """A wrong id must not conclude another live worker's reservation as passing (the local
        review of the close-out)."""
        call = closeout.to_conclude
        self.refuses(1, "x, whose wave is other, not w", call, "w", "t", [record("x", wave="other")], ["x"], "o/r", "w1")
        self.refuses(1, "x, whose worker is w2, not w1", call, "w", "t", [record("x", worker="w2")], ["x"], "o/r", "w1")
        self.refuses(1, "x, whose repository is o/q, not o/r", call, "w", "t", [record("x", repository="o/q")], ["x"], "o/r", "w1")

    def test_a_repository_compares_without_case_and_a_row_with_no_worker_reads_none(self) -> None:
        records = [record("x", repository="O/R", worker="anyone")]
        self.assertEqual(closeout.to_conclude("w", "t", records, ["x"], "o/r", ""), ([("x", "/wt")], []))

    def test_the_rows_silence_is_no_licence(self) -> None:
        """An open standing record of the worker the row does not name: board and registry disagree."""
        self.refuses(1, "does not name: y", closeout.to_conclude, "w", "t", [record("x"), record("y")], ["x"], "o/r", "w1")

    def test_another_wave_or_worker_is_not_this_workers(self) -> None:
        records = [record("x"), record("y", worker="w2"), record("z", wave="other")]
        self.assertEqual(closeout.to_conclude("w", "t", records, ["x"], "o/r", "w1"), ([("x", "/wt")], []))

    def test_with_no_worker_on_the_row_only_the_named_are_read(self) -> None:
        self.assertEqual(closeout.to_conclude("w", "t", [record("x"), record("y")], ["x"], "o/r", ""), ([("x", "/wt")], []))

    def test_any_other_open_request_is_named_never_concluded(self) -> None:
        records = [record("x"), record("leg", standing=False), record("old", standing=False, state="concluded")]
        self.assertEqual(closeout.to_conclude("w", "t", records, ["x"], "o/r", "w1"), ([("x", "/wt")], ["leg"]))


class TheMerge(Refusing):
    def read(self, answer: Any, fields: dict[str, str] | None = None) -> str:
        with mock.patch.object(closeout, "gh_json", return_value=answer):
            return closeout.merged_sha(CFG, "w", "t", "o/r", "7", fields or {})

    def test_the_sha_is_githubs(self) -> None:
        self.assertEqual(self.read({"state": "MERGED", "mergeCommit": {"oid": OID}, "headRefName": "b"}, {"branch": "b"}), OID)

    def test_split_task_remedy_quotes_the_exact_command(self) -> None:
        self.refuses(1, "fleet-worker.sh board set w t 'branch=split;$x'", self.read,
                     {"state": "MERGED", "mergeCommit": {"oid": OID}, "headRefName": "split;$x"}, {"branch": "b"})
        self.assertEqual(self.read({"state": "MERGED", "mergeCommit": {"oid": OID}, "headRefName": "split;$x"},
                                  {"branch": "split;$x"}), OID)

    def test_each_refusal(self) -> None:
        self.refuses(4, "could not be read", self.read, "gh exit 1")
        self.refuses(1, "is OPEN, not merged", self.read, {"state": "OPEN"})
        self.refuses(1, "is None, not merged", self.read, [])
        self.refuses(1, "the row's branch b", self.read, {"state": "MERGED", "mergeCommit": {"oid": OID}, "headRefName": "x"}, {"branch": "b"})
        for merge in (None, {}, {"oid": "abc"}, {"oid": 7}, "x"):
            self.refuses(1, "names no merge commit", self.read, {"state": "MERGED", "mergeCommit": merge})


class TheFlags(unittest.TestCase):
    def test_the_flags(self) -> None:
        self.assertEqual(closeout.parsed(["w", "t"]), ("w", "t", {}))
        self.assertEqual(closeout.parsed(["w", "t", "--pr", "7", "--agent", "a", "--evidence", "e f"]),
                         ("w", "t", {"pr": "7", "agent": "a", "evidence": "e f"}))

    def test_a_usage_error(self) -> None:
        for args in ([], ["w"], ["w", "--pr"], ["w", "t", "--pr"], ["w", "t", "--pr", "x"], ["w", "t", "--pr", "0"],
                     ["w", "t", "--sha", "abc"], ["w", "t", "--agent", " "], ["w", "t", "extra"]):
            with self.subTest(args=args), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises((cli.Exit, SystemExit)):
                    closeout.parsed(args)


if __name__ == "__main__":
    unittest.main()


class NeverRan(unittest.TestCase):
    """#1109: a conclusion's output, the registry's record, says whether the leg ever ran."""

    def test_only_a_not_launched_record_reads_as_never_run(self) -> None:
        self.assertTrue(closeout.never_ran('{\n  "request_id": "l",\n  "verdict": "not-launched"\n}'))
        for out in ('{"verdict": "pass"}', '{"request_id": "l"}', '["not-launched"]', "", "EXECUTION REFUSED: not-launched",
                    'NOTE\n{"verdict": "not-launched"}'):
            self.assertFalse(closeout.never_ran(out), out)
