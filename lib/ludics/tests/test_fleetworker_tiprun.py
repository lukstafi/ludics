"""ludics.fleetworker.tiprun: the readers behind ``execution tip-run`` (the shell suite's "execution
tip-run" section drives the verb end to end, far side included)."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import tiprun
from ludics.fleetworker.config import load_config
from ludics.fleetworker.tiprun import far_facts, parse, request_problem, yielding_to
from ludics.fleetworker.transport import Done

SHA = "a" * 40


def request(**fields: object) -> dict[str, Any]:
    base: dict[str, Any] = {"request_id": "w-gpu-rog-1", "execution_host": "rog-nv-linux", "repository": "o/r",
                            "kind": "correctness", "transport": "coordinator", "requested_revision": SHA}
    base.update(fields)
    return base


def outstanding(request_id: str, state: str = "launching", host: str = "rog-nv-linux", **req: object) -> dict[str, Any]:
    return {"request_id": request_id, "state": state, "request": {"execution_host": host, **req}}


class Parse(unittest.TestCase):
    def refused(self, args: list[str]) -> str:
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(cli.Exit) as caught:
            parse(args)
        self.assertEqual(caught.exception.rc, 2)
        return caught.exception.message

    def test_the_whole_command_line(self) -> None:
        got = parse(["/p.json", "--checkout", "/co", "--runs", "/r", "--cpu", "--", "tools/test-run.sh", "run", "--cpu"])
        self.assertEqual((got.payload, got.checkout, got.runs, got.cpu), ("/p.json", "/co", "/r", True))
        self.assertEqual(got.command, ["tools/test-run.sh", "run", "--cpu"], "words after -- are the command's, flags included")

    def test_defaults_a_gpu_run_under_the_default_runs_parent(self) -> None:
        got = parse(["/p.json", "--checkout", "/co", "--", "true"])
        self.assertEqual((got.runs, got.cpu), ("", False))

    def test_refusals(self) -> None:
        self.assertIn("--checkout must be absolute", self.refused(["/p.json", "--checkout", "co", "--", "true"]))
        self.assertIn("--runs must be absolute", self.refused(["/p.json", "--checkout", "/co", "--runs", "r", "--", "true"]))
        self.assertIn("a command to run is required", self.refused(["/p.json", "--checkout", "/co", "--"]))
        for args in (["/p.json", "--", "true"], ["--checkout", "/co", "--", "true"], ["/p.json", "--checkout", "/co", "true"],
                     ["/p.json", "--checkout", "/co", "--oops", "--", "true"], ["/p.json", "/q.json", "--checkout", "/co", "--", "true"]):
            self.assertIn("execution tip-run <json-file> --checkout <dir>", self.refused(args), args)


class RequestShape(unittest.TestCase):
    def test_a_loop_request_passes(self) -> None:
        self.assertIsNone(request_problem(request()))
        self.assertIsNone(request_problem(request(integration=True)), "the cc loop's request is a loop request too")
        self.assertIsNone(request_problem(request(triage_reason="rerun of a red")), "a halt's rerun is one too")

    def test_what_a_loop_run_is_not(self) -> None:
        cases: list[tuple[Any, str]] = [
            ([], "not a JSON object"),
            (request(kind="measurement"), "kind must be correctness"),
            (request(transport="subagent"), "transport must be coordinator"),
            (request(standing=True), "never standing"),
            (request(requested_revision=SHA[:12]), "exactly one full 40-hex"),
            (request(requested_revision=f"{SHA} plus working diff"), "exactly one full 40-hex"),
            (request(requested_revision="origin/main"), "exactly one full 40-hex"),
            (request(requested_revision=SHA.upper()), "exactly one full 40-hex"),
            (request(execution_host=""), "execution_host must be a nonempty string"),
            (request(request_id=None), "request_id must be a nonempty string"),
        ]
        for value, want in cases:
            problem = request_problem(value)
            self.assertIsNotNone(problem, value)
            self.assertIn(want, problem or "", value)


class Yield(unittest.TestCase):
    def test_only_standing_reservations_and_its_own_record_are_passed_over(self) -> None:
        records = [
            outstanding("iterate", standing=True),
            outstanding("leg"),
            outstanding("measure", state="reserved", kind="measurement"),
            outstanding("suspended-iterate", state="suspended", standing=True),
            outstanding("done", state="concluded"),
            outstanding("elsewhere", host="minix-amd-linux"),
            outstanding("w-gpu-rog-1"),
        ]
        self.assertEqual(yielding_to(records, "rog-nv-linux", "w-gpu-rog-1"), ["leg (launching)", "measure (reserved)"])
        self.assertEqual(yielding_to(records, "tuf-amd-linux", "w-gpu-rog-1"), [])


class FarFacts(unittest.TestCase):
    def test_the_first_of_each_known_key(self) -> None:
        text = "dir=/r/run-1\nslot=ended\nsaid=EXECUTION SLOT REFUSED x: a=b\nslot=held\nother=1\nnoise"
        self.assertEqual(far_facts(text), {"dir": "/r/run-1", "slot": "ended", "said": "EXECUTION SLOT REFUSED x: a=b"})


class Race(unittest.TestCase):
    """The yield is read again once the reservation is published: a leg (or a second loop run)
    reserved between the first read and ours turns the run away, concluded not-launched, before
    anything touches the box (the local review's finding: two concurrent runs both started)."""

    def test_a_record_reserved_beside_the_run_turns_it_away(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="h")
        with tempfile.TemporaryDirectory() as tmp:
            payload = os.path.join(tmp, "req.json")
            with open(payload, "w", encoding="utf-8") as f:
                json.dump(request(), f)
            ours = outstanding("w-gpu-rog-1")
            reads = iter([json.dumps([]), json.dumps([ours, outstanding("w-gpu-rog-2")])])
            calls: list[tuple[list[str], dict[str, Any] | None]] = []

            def listing(_cfg: object) -> Done:
                return Done(0, next(reads))

            def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None) -> int:
                calls.append((args, body))
                return 0

            out = io.StringIO()
            with mock.patch.object(tiprun, "listing", side_effect=listing), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
                    mock.patch.object(tiprun, "run_on", side_effect=AssertionError("the box was touched")), \
                    contextlib.redirect_stdout(out):
                rc = tiprun.cmd_tip_run(cfg, [payload, "--checkout", "/co", "--", "true"])
        self.assertEqual(rc, 1)
        self.assertEqual([c[0] for c in calls], [["execution", "run", payload], ["execution", "conclude"]])
        conclusion = calls[1][1] or {}
        self.assertEqual(conclusion.get("verdict"), "not-launched")
        self.assertIn("w-gpu-rog-2 (launching) outstanding, reserved beside this run", conclusion.get("evidence", ""))
        self.assertIn("TIP-RUN NOT STARTED w-gpu-rog-1: rog-nv-linux has w-gpu-rog-2 (launching) outstanding", out.getvalue())


if __name__ == "__main__":
    unittest.main()
