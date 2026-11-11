"""ludics.fleetworker.tiprun: the readers behind ``execution tip-run`` (the shell suite's "execution
tip-run" section drives the verb end to end, far side included)."""

import contextlib
import dataclasses
import io
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import farside, leg, tiprun
from ludics.fleetworker.config import load_config
from ludics.fleetworker.tiprun import (concluded_line, far_facts, loop_backend, next_id, parse, parse_wait, request_problem,
                                       started_run, yielding_to)
from ludics.fleetworker.transport import Done

SHA = "a" * 40
# The repository's own fleet-worker.sh, so --wait finds the bg-run.sh beside it.
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "issue-wave", "scripts", "fleet-worker.sh")


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
            self.assertIn("execution tip-run <json-file> [--tip <branch>] [--base <branch>] --checkout <dir>", self.refused(args), args)


class ParseTipAndWait(unittest.TestCase):
    def refused(self, call: Any, args: list[str]) -> str:
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(cli.Exit) as caught:
            call(args)
        self.assertEqual(caught.exception.rc, 2)
        return caught.exception.message

    def test_tip_names_the_branch(self) -> None:
        self.assertEqual(parse(["/p.json", "--tip", "main", "--checkout", "/co", "--", "true"]).tip, "main")
        self.assertEqual(parse(["/p.json", "--checkout", "/co", "--", "true"]).tip, "")
        for args in (["/p.json", "--tip", "--checkout", "/co", "--", "true"], ["/p.json", "--checkout", "/co", "--tip"]):
            self.assertIn("expected a branch for --tip", self.refused(parse, args), args)

    def test_base_names_the_branch_and_the_base_is_a_branch_name(self) -> None:
        got = parse(["/p.json", "--base", "dev", "--tip", "main", "--checkout", "/co", "--", "true"])
        self.assertEqual((got.base, got.tip), ("dev", "main"))
        self.assertEqual(parse(["/p.json", "--checkout", "/co", "--", "true"]).base, "")
        self.assertIn("expected a branch for --base", self.refused(parse, ["/p.json", "--base", "--checkout", "/co", "--", "true"]))
        # THE BASE: --tip names the base too when --base does not, so either must be a branch name.
        for flag in ("--base", "--tip"):
            for bad in ("a..b", "HEAD", "a b"):
                with self.subTest(flag=flag, bad=bad):
                    self.assertIn(f"{flag} names the base, so it must be a branch name of origin",
                                  self.refused(parse, ["/p.json", flag, bad, "--checkout", "/co", "--", "true"]))

    def test_id_prefix_names_the_ids_leading_part(self) -> None:
        self.assertEqual(parse(["/p.json", "--id-prefix", "w-gpu-rog", "--checkout", "/co", "--", "true"]).id_prefix, "w-gpu-rog")
        self.assertEqual(parse(["/p.json", "--checkout", "/co", "--", "true"]).id_prefix, "")
        for args in (["/p.json", "--id-prefix", "--checkout", "/co", "--", "true"], ["/p.json", "--checkout", "/co", "--id-prefix"],
                     ["/p.json", "--id-prefix", "", "--checkout", "/co", "--", "true"],
                     ["/p.json", "--id-prefix", "w gpu", "--checkout", "/co", "--", "true"],
                     ["/p.json", "--id-prefix", "-w", "--checkout", "/co", "--", "true"]):
            self.assertIn("--id-prefix takes a request id's leading part", self.refused(parse, args), args)

    def test_wait_takes_the_id_and_a_bound(self) -> None:
        self.assertEqual(parse_wait(["--wait", "w-gpu-rog-1"]), tiprun.WaitArgs("w-gpu-rog-1", tiprun.WITHIN))
        self.assertEqual(parse_wait(["--wait", "w-gpu-rog-1", "--within", "0"]), tiprun.WaitArgs("w-gpu-rog-1", 0))
        self.assertEqual(parse_wait(["--wait", "w-gpu-rog-1", "--tip", "main", "--within", "9"]), tiprun.WaitArgs("w-gpu-rog-1", 9, "main"))
        self.assertLess(tiprun.WITHIN, 600, "one --wait fits a foreground tool call")
        for args in (["--wait"], ["--wait", "--within", "5"], ["--wait", "x", "--within"], ["--wait", "x", "--within", "-1"],
                     ["--wait", "x", "--within", "5s"], ["--wait", "x", "y"], ["--wait", "x", "--within", "5", "--cpu"],
                     ["--wait", "x", "--tip"], ["--wait", "x", "--tip", "--within"]):
            self.refused(parse_wait, args)


class RequestShape(unittest.TestCase):
    def test_a_loop_request_passes(self) -> None:
        self.assertIsNone(request_problem(request()))
        self.assertIsNone(request_problem(request(integration=True)), "the cc loop's request is a loop request too")
        self.assertIsNone(request_problem(request(triage_reason="rerun of a red")), "a triage-owner run is one too")

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


    def test_tip_reads_the_revision_so_the_payload_names_none(self) -> None:
        bare = request()
        del bare["requested_revision"]
        self.assertIsNone(request_problem(bare, tip=True))
        self.assertIn("names no requested_revision", request_problem(request(), tip=True) or "")
        self.assertIn("names no requested_revision", request_problem(request(requested_revision=None), tip=True) or "")
        self.assertIn("transport must be coordinator", request_problem({**bare, "transport": "cli"}, tip=True) or "",
                      "the rest of the shape is checked as without --tip")
        self.assertIn("or --tip <branch>", request_problem(bare) or "", "without --tip a revision is required")

    def test_id_prefix_allocates_the_id_so_the_payload_names_none(self) -> None:
        bare = request()
        del bare["request_id"]
        self.assertIsNone(request_problem(bare, allocate=True))
        self.assertIn("names no request_id", request_problem(request(), allocate=True) or "")
        self.assertIn("names no request_id", request_problem(request(request_id=None), allocate=True) or "")
        self.assertIn("request_id must be a nonempty string", request_problem(bare) or "", "without --id-prefix an id is required")

    def test_a_gpu_loop_purpose_names_its_backend(self) -> None:
        self.assertEqual(loop_backend(request(purpose="GPU integration loop, cuda: tip of main")), "cuda")
        self.assertEqual(loop_backend(request(purpose="GPU integration loop, hip: rerun")), "hip")
        for purpose in ("o/r integration, GPU integration loop, cuda: x", "cc integration loop", None, 7):
            self.assertEqual(loop_backend(request(purpose=purpose)), "", purpose)
            self.assertIsNone(request_problem(request(purpose=purpose)), purpose)
        for purpose in ("GPU integration loop: cuda", "GPU integration loop, cuda tip", "GPU integration loop,cuda:",
                        "GPU integration loop, : x", "GPU integration loops, cuda: x"):
            self.assertIn("names its backend, as 'GPU integration loop, <backend>: ...'", request_problem(request(purpose=purpose)) or "", purpose)


class NextId(unittest.TestCase):
    """--id-prefix (ludics-lite#714): one past the highest number the registry holds under the prefix."""

    def ids(self, *ids: str) -> list[dict[str, Any]]:
        return [outstanding(i, "concluded") for i in ids]

    def test_the_first_is_one(self) -> None:
        self.assertEqual(next_id([], "w-gpu-rog"), "w-gpu-rog-1")
        self.assertEqual(next_id(self.ids("w-gpu-tuf-4", "w-gpu-rog-nv-2", "w-gpu-rog-x", "w-gpu-rog-", "xw-gpu-rog-5"), "w-gpu-rog"),
                         "w-gpu-rog-1", "only <prefix>-<digits> counts")

    def test_one_past_the_highest_held_never_a_gap(self) -> None:
        self.assertEqual(next_id(self.ids("w-gpu-rog-1", "w-gpu-rog-3"), "w-gpu-rog"), "w-gpu-rog-4")
        self.assertEqual(next_id(self.ids("w-gpu-rog-10", "w-gpu-rog-9"), "w-gpu-rog"), "w-gpu-rog-11", "numbers, not strings")
        self.assertEqual(next_id(self.ids("w-gpu-rog-007"), "w-gpu-rog"), "w-gpu-rog-8")

    def test_an_id_held_by_another_case_is_held(self) -> None:
        self.assertEqual(next_id(self.ids("W-GPU-ROG-2"), "w-gpu-rog"), "w-gpu-rog-3")

    def test_the_prefix_is_literal(self) -> None:
        self.assertEqual(next_id(self.ids("w.gpu.rog-5", "wxgpu-rog-6"), "w.gpu.rog"), "w.gpu.rog-6")


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
        text = "base=origin/main at x (--tip)\ndir=/r/run-1\nslot=ended\nsaid=EXECUTION SLOT REFUSED x: a=b\nslot=held\nother=1\nnoise"
        self.assertEqual(far_facts(text), {"base": "origin/main at x (--tip)", "dir": "/r/run-1", "slot": "ended",
                                           "said": "EXECUTION SLOT REFUSED x: a=b"})


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

            def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None, *, verb: str = "TIP-RUN") -> int:
                calls.append((args, body))
                return 0

            out = io.StringIO()
            with mock.patch.object(tiprun, "listing", side_effect=listing), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
                    mock.patch.object(tiprun, "run_on", side_effect=AssertionError("the box was touched")), \
                    contextlib.redirect_stdout(out):
                rc = tiprun.cmd_tip_run(cfg, [payload, "--checkout", "/co", "--", "true"])
        self.assertEqual(rc, 1)
        self.assertEqual([c[0] for c in calls], [["execution", "run"], ["execution", "conclude"]])
        self.assertEqual(calls[0][1], {**request(), "tip_run": True},
                         "the payload's request, marked beside it as tip-run's (registry.py, THE LOOP RUN UNDER A HALT)")
        conclusion = calls[1][1] or {}
        self.assertEqual(conclusion.get("verdict"), "not-launched")
        self.assertIn("w-gpu-rog-2 (launching) outstanding, reserved beside this run", conclusion.get("evidence", ""))
        self.assertIn("TIP-RUN NOT STARTED w-gpu-rog-1: rog-nv-linux has w-gpu-rog-2 (launching) outstanding", out.getvalue())


    def test_a_remote_box_whose_refresh_fails_starts_nothing(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="h")
        with tempfile.TemporaryDirectory() as tmp:
            payload = os.path.join(tmp, "req.json")
            with open(payload, "w", encoding="utf-8") as f:
                json.dump(request(), f)
            calls: list[tuple[list[str], dict[str, Any] | None]] = []

            def listing(_cfg: object) -> Done:
                return Done(0, json.dumps([outstanding("w-gpu-rog-1")]) if calls else "[]")

            def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None, *, verb: str = "TIP-RUN") -> int:
                calls.append((args, body))
                return 0

            def refresh(_cfg: object, box: str, *, to_stderr: bool = False) -> int:
                self.assertEqual((box, to_stderr), ("rog-nv-linux", True))
                return 1

            out = io.StringIO()
            with mock.patch.object(tiprun, "listing", side_effect=listing), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
                    mock.patch.object(tiprun, "refresh_box", side_effect=refresh), \
                    mock.patch.object(tiprun, "run_on", side_effect=AssertionError("the box was touched")), \
                    contextlib.redirect_stdout(out):
                rc = tiprun.cmd_tip_run(cfg, [payload, "--checkout", "/co", "--", "true"])
        self.assertEqual(rc, 1)
        self.assertEqual([c[0] for c in calls], [["execution", "run"], ["execution", "conclude"]])
        self.assertEqual((calls[1][1] or {}).get("verdict"), "not-launched")
        self.assertIn("the skills checkout on rog-nv-linux was not refreshed", out.getvalue())


class Tip(unittest.TestCase):
    """--tip: the branch's head on GitHub becomes the request's one SHA before anything is reserved."""

    def payload(self, tmp: str) -> str:
        bare = request()
        del bare["requested_revision"]
        path = os.path.join(tmp, "req.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(bare, f)
        return path

    def test_the_resolved_request_is_the_one_reserved(self) -> None:
        cfg = load_config(SCRIPT, {}, host="h")
        calls: list[tuple[list[str], dict[str, Any] | None]] = []

        def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None, *, verb: str = "TIP-RUN") -> int:
            calls.append((args, body))
            return 1  # refused: the test stops at the reservation

        with tempfile.TemporaryDirectory() as tmp:
            payload = self.payload(tmp)
            with mock.patch.object(tiprun.revision, "branch_head", return_value=SHA) as head, \
                    mock.patch.object(tiprun, "listing", return_value=Done(0, "[]")), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
                rc = tiprun.cmd_tip_run(cfg, [payload, "--tip", "main", "--checkout", "/co", "--", "true"])
        self.assertEqual(rc, 1)
        self.assertEqual(head.call_args.args[:2], ("o/r", "main"))
        self.assertEqual(calls, [(["execution", "run"], {**request(), "requested_revision": SHA, "tip_run": True})])
        self.assertIn(f"TIP-RUN TIP w-gpu-rog-1: main is {SHA} in o/r on GitHub now", err.getvalue())

    def test_an_unread_tip_reserves_nothing(self) -> None:
        cfg = load_config(SCRIPT, {}, host="h")
        with tempfile.TemporaryDirectory() as tmp:
            payload = self.payload(tmp)
            out = io.StringIO()
            with mock.patch.object(tiprun.revision, "branch_head", return_value=("EXECUTION UNVERIFIED github.com: x", 4)), \
                    mock.patch.object(tiprun, "listing", side_effect=AssertionError("the anchor was asked")), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=AssertionError("something was reserved")), \
                    contextlib.redirect_stdout(out):
                rc = tiprun.cmd_tip_run(cfg, [payload, "--tip", "main", "--checkout", "/co", "--", "true"])
        self.assertEqual(rc, 1, "nothing was reserved, so nothing is left to reconcile")
        self.assertIn("EXECUTION UNVERIFIED github.com: x", out.getvalue())
        self.assertIn("TIP-RUN NOT STARTED w-gpu-rog-1: the tip of main in o/r could not be read (above); nothing reserved", out.getvalue())


class Allocate(unittest.TestCase):
    """--id-prefix through cmd_tip_run: the allocated id is the one reserved, chosen off the registry read."""

    def test_the_allocated_id_is_the_one_reserved(self) -> None:
        cfg = load_config(SCRIPT, {}, host="h")
        calls: list[tuple[list[str], dict[str, Any] | None]] = []

        def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None, *, verb: str = "TIP-RUN") -> int:
            calls.append((args, body))
            return 1  # refused: the test stops at the reservation

        held = [outstanding("w-gpu-rog-1", "concluded"), outstanding("w-gpu-rog-3", "concluded")]
        with tempfile.TemporaryDirectory() as tmp:
            bare = request()
            del bare["request_id"]
            payload = os.path.join(tmp, "req.json")
            with open(payload, "w", encoding="utf-8") as f:
                json.dump(bare, f)
            out = io.StringIO()
            with mock.patch.object(tiprun, "listing", return_value=Done(0, json.dumps(held))), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()) as err:
                rc = tiprun.cmd_tip_run(cfg, [payload, "--id-prefix", "w-gpu-rog", "--checkout", "/co", "--", "true"])
        self.assertEqual(rc, 1)
        self.assertEqual(calls, [(["execution", "run"], {**bare, "request_id": "w-gpu-rog-4", "tip_run": True})])
        self.assertIn("TIP-RUN ID w-gpu-rog-4: allocated under w-gpu-rog-", err.getvalue())
        self.assertIn("TIP-RUN NOT STARTED w-gpu-rog-4: the reservation was refused", out.getvalue())

    def test_before_the_allocation_the_run_is_prefix_question_mark(self) -> None:
        cfg = load_config(SCRIPT, {}, host="h")
        with tempfile.TemporaryDirectory() as tmp:
            bare = request()
            del bare["request_id"]
            payload = os.path.join(tmp, "req.json")
            with open(payload, "w", encoding="utf-8") as f:
                json.dump(bare, f)
            out = io.StringIO()
            with mock.patch.object(tiprun, "listing", return_value=Done(1, "")), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=AssertionError("something was reserved")), \
                    contextlib.redirect_stdout(out):
                rc = tiprun.cmd_tip_run(cfg, [payload, "--id-prefix", "w-gpu-rog", "--checkout", "/co", "--", "true"])
        self.assertEqual(rc, 4)
        self.assertIn("TIP-RUN UNKNOWN w-gpu-rog-?: the anchor's registry could not be read", out.getvalue())


class Starting(unittest.TestCase):
    """A run started with a far side's canned answer; the reservation and the record are mocks."""

    def start(self, req: dict[str, Any], far: str, env: dict[str, str] | None = None,
              flags: list[str] | None = None) -> tuple[int, list[tuple[list[str], dict[str, Any] | None]], list[str]]:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", env or {}, host="h")
        calls: list[tuple[list[str], dict[str, Any] | None]] = []
        far_args: list[str] = []

        def listing(_cfg: object) -> Done:
            return Done(0, json.dumps([outstanding(req["request_id"])]) if calls else "[]")

        def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None, *, verb: str = "TIP-RUN") -> int:
            calls.append((args, body))
            return 0

        def on_box(_cfg: object, _box: str, _script: str, args: list[str], capture: bool = False) -> Done:
            far_args.extend(args)
            return Done(1 if far.startswith("TIP-RUN REFUSED") else 0, far)

        with tempfile.TemporaryDirectory() as tmp:
            payload = os.path.join(tmp, "req.json")
            with open(payload, "w", encoding="utf-8") as f:
                json.dump(req, f)
            with mock.patch.object(tiprun, "listing", side_effect=listing), \
                    mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
                    mock.patch.object(tiprun, "refresh_box", return_value=0), \
                    mock.patch.object(tiprun, "run_on", side_effect=on_box), \
                    mock.patch.object(tiprun.revision, "branch_head", return_value=SHA), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = tiprun.cmd_tip_run(cfg, [payload, *(flags or []), "--checkout", "/co", "--", "env", "OCANNL_BACKEND=hip", "true"])
        return rc, calls, far_args


class Mark(Starting):
    """THE BACKEND PIN's mark: a started GPU-loop run's running record carries ``pinned_backend``,
    the backend the far side checked; no other record does, and nothing not started is marked."""

    def test_a_started_gpu_loop_run_is_marked_with_the_backend_the_far_side_checked(self) -> None:
        rc, calls, far = self.start(request(purpose="GPU integration loop, hip: tip"), "dir=/s/run-1\nslot=held\n")
        self.assertEqual(rc, 0)
        self.assertEqual(far[6], "hip", "the far side checks the pin of the backend the mark names")
        self.assertEqual([c[0] for c in calls], [["execution", "run"], ["execution", "record"]])
        self.assertEqual((calls[1][1] or {}).get("pinned_backend"), "hip")

    def test_a_cc_loop_run_is_not_marked(self) -> None:
        rc, calls, far = self.start(request(purpose="integration loop, cc: tip", integration=True), "dir=/s/run-1\nslot=held\n")
        self.assertEqual(rc, 0)
        self.assertEqual(far[6], "", "nothing is checked")
        self.assertNotIn("pinned_backend", calls[1][1] or {})

    def test_a_run_refused_on_its_pin_is_concluded_unmarked(self) -> None:
        rc, calls, _ = self.start(request(purpose="GPU integration loop, hip: tip"),
                                  "TIP-RUN REFUSED: this run is the hip backend's, but its command pins no backend\n")
        self.assertEqual(rc, 1)
        self.assertEqual([c[0] for c in calls][1:], [["execution", "conclude"]])
        self.assertEqual((calls[1][1] or {}).get("verdict"), "not-launched")
        self.assertNotIn("pinned_backend", calls[1][1] or {})


def running(**fields: object) -> dict[str, Any]:
    record: dict[str, Any] = {"request_id": "w-gpu-rog-1", "state": "running", "observed_sha": SHA,
                              "handle": "bg-run:rog-nv-linux:/s/tip-runs/run-3", "request": {"execution_host": "rog-nv-linux"}}
    record.update(fields)
    return record


class Floor(Starting):
    """THE FREE-SPACE FLOOR: the knob reaches the far side as its argument, a value that is no whole
    number is a usage refusal before anything is asked, and a far-side refusal is concluded as any
    other. The reading itself is ``test_fleetworker_leg``'s, and the far side's order the shell suite's."""

    def test_the_far_side_takes_the_leg_s_floor_and_its_default(self) -> None:
        for env, floor in (({}, ""), ({"FLEET_LEG_MIN_FREE_GIB": "7"}, "7"), ({"FLEET_LEG_MIN_FREE_GIB": "0"}, "0")):
            with self.subTest(env=env):
                rc, _, far = self.start(request(), "dir=/s/run-1\nslot=held\n", env)
                self.assertEqual(rc, 0)
                self.assertEqual(far[7:], [floor, "", "", "300", "env", "OCANNL_BACKEND=hip", "true"],
                                 "the floor, the base, the fetch bound, then the command")

    def test_the_far_side_carries_the_one_floor_program(self) -> None:
        self.assertIn(leg.FLOOR, tiprun.FAR)

    def test_a_refusal_under_the_floor_is_concluded_not_launched(self) -> None:
        why = "only 3.00 GiB free on the filesystem of /co on rog-nv-linux, under the floor of 20 GiB (FLEET_LEG_MIN_FREE_GIB); nothing ran"
        rc, calls, _ = self.start(request(), f"TIP-RUN REFUSED: {why}\n")
        self.assertEqual(rc, 1)
        conclusion = calls[-1]
        self.assertEqual(conclusion[0], ["execution", "conclude"])
        self.assertEqual((conclusion[1] or {}).get("verdict"), "not-launched")
        self.assertEqual((conclusion[1] or {}).get("evidence"), f"tip-run: {why}")

    def test_a_floor_that_is_no_whole_number_is_a_usage_error_before_anything_is_asked(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {"FLEET_LEG_MIN_FREE_GIB": "lots"}, host="h")
        with tempfile.TemporaryDirectory() as tmp:
            payload = os.path.join(tmp, "req.json")
            with open(payload, "w", encoding="utf-8") as f:
                json.dump(request(), f)
            with mock.patch.object(tiprun, "listing", side_effect=AssertionError("the anchor was asked")), \
                    self.assertRaises(cli.Exit) as raised:
                tiprun.cmd_tip_run(cfg, [payload, "--checkout", "/co", "--", "true"])
        self.assertEqual(raised.exception.rc, 2)
        self.assertIn("FLEET_LEG_MIN_FREE_GIB must be a whole number", str(raised.exception))


class FetchBound(Starting):
    """THE FETCH BOUND: FLEET_FETCH_TIMEOUT reaches the far side as its argument, 300 by default, and a
    value that is no positive whole number of seconds is a usage refusal before GitHub or the anchor is
    asked. The far side's use of it is ``FarBase``'s."""

    def test_the_far_side_takes_the_knob_and_its_default(self) -> None:
        for env, bound in (({}, "300"), ({"FLEET_FETCH_TIMEOUT": "45"}, "45")):
            with self.subTest(env=env):
                rc, _, far = self.start(request(), "dir=/s/run-1\nslot=held\n", env)
                self.assertEqual(rc, 0)
                self.assertEqual(far[10:], [bound, "env", "OCANNL_BACKEND=hip", "true"], "the fetch bound, then the command")

    def test_a_bound_that_is_no_whole_number_of_seconds_is_a_usage_error_before_anything_is_asked(self) -> None:
        tip = {k: v for k, v in request().items() if k != "requested_revision"}
        for value in ("soon", "0", "-5", "1.5", " 30"):
            with self.subTest(value=value):
                cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {"FLEET_FETCH_TIMEOUT": value}, host="h")
                with tempfile.TemporaryDirectory() as tmp:
                    payload = os.path.join(tmp, "req.json")
                    with open(payload, "w", encoding="utf-8") as f:
                        json.dump(tip, f)
                    with mock.patch.object(tiprun.revision, "branch_head", side_effect=AssertionError("GitHub was asked")), \
                            mock.patch.object(tiprun, "listing", side_effect=AssertionError("the anchor was asked")), \
                            self.assertRaises(cli.Exit) as raised:
                        tiprun.cmd_tip_run(cfg, [payload, "--tip", "main", "--checkout", "/co", "--", "true"])
                self.assertEqual(raised.exception.rc, 2)
                self.assertIn("FLEET_FETCH_TIMEOUT must be a positive whole number of seconds", str(raised.exception))


class BaseNamed(Starting):
    """THE BASE, near side: which branch the far side fetches and why, the started record's evidence
    naming the base it saw, and a far-side base refusal concluded as any other. The far side's own
    fetch is ``FarBase``'s."""

    def test_the_base_is_base_s_branch_else_tip_s_else_none(self) -> None:
        tip = {k: v for k, v in request().items() if k != "requested_revision"}
        for req, flags, named in ((request(), [], ["", ""]), (tip, ["--tip", "main"], ["main", "--tip"]),
                                  (tip, ["--tip", "main", "--base", "dev"], ["dev", "--base"]),
                                  (request(), ["--base", "dev"], ["dev", "--base"])):
            with self.subTest(flags=flags):
                rc, _, far = self.start(req, "dir=/s/run-1\nslot=held\n", flags=flags)
                self.assertEqual(rc, 0)
                self.assertEqual(far[8:10], named)

    def test_a_started_run_s_evidence_names_the_base_it_saw(self) -> None:
        said = f"origin/main at {SHA} (--tip), fetched from origin before the run; was unset"
        rc, calls, _ = self.start(request(), f"base={said}\ndir=/s/run-1\nslot=held\n")
        self.assertEqual(rc, 0)
        self.assertEqual(calls[-1][0], ["execution", "record"])
        self.assertTrue(str((calls[-1][1] or {}).get("evidence")).endswith(f"; base {said}"), calls[-1][1])

    def test_a_base_fetch_refused_on_the_box_is_concluded_not_launched_and_nothing_recorded_running(self) -> None:
        why = "git fetch origin main (the base, --tip) in /co on rog-nv-linux failed (above), retried once: ..."
        rc, calls, _ = self.start(request(), f"TIP-RUN REFUSED: {why}\n")
        self.assertEqual(rc, 1)
        self.assertEqual([c[0] for c in calls], [["execution", "run"], ["execution", "conclude"]])
        self.assertEqual((calls[-1][1] or {}).get("verdict"), "not-launched")
        self.assertEqual((calls[-1][1] or {}).get("evidence"), f"tip-run: {why}")


class FarBase(unittest.TestCase):
    """THE BASE (ludics#1067), the far side itself, under bash, in a checkout that holds the commit
    under test and whose ``origin/main`` lags the remote by a commit (the trap: a commit already there
    fetched nothing before). A stand-in fleet-worker.sh plays the slot and notes what ``origin/main``
    read when the command would start. The helper's own cases are ``test_fleetworker_leg``'s."""

    bash = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash") or "bash"  # 3.2 on macOS

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout.strip()

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        src, remote, self.co = self.tmp / "src", self.tmp / "remote.git", self.tmp / "co"
        self.git("init", "-q", "-b", "main", str(src))
        for args in (["config", "user.email", "t@example.com"], ["config", "user.name", "t"],
                     ["commit", "-q", "--allow-empty", "-m", "A"]):
            self.git("-C", str(src), *args)
        self.git("init", "-q", "--bare", "-b", "main", str(remote))
        self.git("-C", str(src), "push", "-q", str(remote), "main")
        self.git("clone", "-q", str(remote), str(self.co))
        self.sha = self.stale = self.git("-C", str(self.co), "rev-parse", "origin/main")
        self.git("-C", str(src), "commit", "-q", "--allow-empty", "-m", "B")
        self.git("-C", str(src), "push", "-q", str(remote), "main")
        self.tip = self.git("-C", str(src), "rev-parse", "HEAD")
        self.seen = self.tmp / "seen"
        self.fw = self.tmp / "fleet-worker.sh"
        # `execution slot --bg <runs> --wait 0 [--cpu] -- <command...>`, run in the checkout.
        self.fw.write_text("#!/bin/sh\n"
                           f"git rev-parse origin/main > {shlex.quote(str(self.seen))}\n"
                           'd="$4/run-1"; mkdir -p "$d"\n'
                           "printf 'EXECUTION SLOT box: slot 1 of 1 held for: x\\n' > \"$d/log\"\n"
                           'printf \'%s\\n\' "$d"\n', encoding="utf-8")
        self.fw.chmod(0o755)

    def far(self, base: str = "", how: str = "", bound: str = "300", stub: str = "") -> subprocess.CompletedProcess[str]:
        script = (f"STATE={shlex.quote(str(self.tmp / 'state'))}\nBOX=box\n" + farside.HELPERS + stub
                  + 'fleet_worker() { "$@"; }\n' + tiprun.FAR)
        args = [str(self.co), self.sha, str(self.tmp / "runs"), str(self.fw), "cpu", "5", "", "0", base, how, bound, "true"]
        return subprocess.run([self.bash, "-c", script, "x", *args], capture_output=True, text=True, stdin=subprocess.DEVNULL)

    def test_a_stale_base_is_fetched_before_the_run_starts(self) -> None:
        self.assertNotEqual(self.stale, self.tip)
        done = self.far("main", "--tip")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.seen.read_text(encoding="utf-8").strip(), self.tip, "the command reads the remote's base")
        said = f"origin/main at {self.tip} (--tip), fetched from origin before the run; was {self.stale}"
        self.assertEqual(far_facts(done.stdout).get("base"), said)
        self.assertIn(f"TIP-RUN BASE box: {said}", done.stderr)
        self.assertEqual(far_facts(done.stdout).get("slot"), "held")
        self.assertEqual(self.git("-C", str(self.co), "rev-parse", "HEAD"), self.sha)

    def test_with_no_base_named_origin_head_s_branch_is_fetched(self) -> None:
        done = self.far()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(far_facts(done.stdout).get("base"),
                         f"origin/main at {self.tip} (origin/HEAD), fetched from origin before the run; was {self.stale}")
        self.assertEqual(self.seen.read_text(encoding="utf-8").strip(), self.tip)

    def test_no_origin_head_and_no_base_named_warns_and_runs(self) -> None:
        self.git("-C", str(self.co), "remote", "set-head", "origin", "--delete")
        done = self.far()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue(far_facts(done.stdout).get("base", "").startswith("WARNING: no base fetched: "), done.stdout)
        self.assertEqual(self.seen.read_text(encoding="utf-8").strip(), self.stale)

    def test_a_failed_base_fetch_refuses_before_anything_runs(self) -> None:
        self.git("-C", str(self.co), "checkout", "-q", "-b", "other")  # HEAD stays a branch: no checkout moved it
        for base in ("no-such-1067", "main"):
            with self.subTest(base=base):
                if base == "main":
                    self.git("-C", str(self.co), "remote", "set-url", "origin", str(self.tmp / "gone.git"))
                done = self.far(base, "--base")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                refused = [line for line in done.stdout.split("\n") if line.startswith("TIP-RUN REFUSED: ")]
                self.assertEqual(len(refused), 1, done.stdout)
                self.assertIn(f"git fetch origin {base} (the base, --base) in {self.co} on box failed", refused[0])
                self.assertNotIn("dir=", done.stdout)
                self.assertFalse(self.seen.exists(), "the slot was never asked")
                self.assertFalse((self.tmp / "runs").exists())
                self.assertEqual(self.git("-C", str(self.co), "symbolic-ref", "HEAD"), "refs/heads/other")
                self.assertEqual(self.git("-C", str(self.co), "rev-parse", "origin/main"), self.stale)


    def test_both_fetches_are_bounded_by_the_knob_and_a_cut_one_names_it(self) -> None:
        bounds = self.tmp / "bounds"
        # `bounded`, recording its bound: the commit is not in the checkout yet, so both fetches run.
        record = f'bounded() {{ printf \'%s\\n\' "$1" >> {shlex.quote(str(bounds))}; shift; "$@"; }}\n'
        cut = 'bounded() { return 124; }\n'  # every fetch reaches its bound
        for sha, words in ((self.tip, f"git fetch origin in {self.co} on box did not finish in 7s (FLEET_FETCH_TIMEOUT)"),
                           (self.stale, f"git fetch origin main (the base, --tip) in {self.co} on box did not finish in 7s"
                                        " (FLEET_FETCH_TIMEOUT)")):
            with self.subTest(sha=sha):
                self.sha = sha
                done = self.far("main", "--tip", "7", cut)
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn(f"TIP-RUN REFUSED: {words}", done.stdout)
                self.assertFalse(self.seen.exists(), "the slot was never asked")
        self.sha = self.tip
        done = self.far("main", "--tip", "7", record)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(bounds.read_text(encoding="utf-8").split(), ["7", "7"], "the commit's fetch, then the base's")
        self.assertEqual(self.seen.read_text(encoding="utf-8").strip(), self.tip)


class Wait(unittest.TestCase):
    """--wait <id>: the run's box, directory and SHA come off the record, never from the caller."""

    def test_only_the_record_a_start_writes_is_a_run_to_wait_on(self) -> None:
        self.assertEqual(started_run(running()), ("rog-nv-linux", "/s/tip-runs/run-3", SHA))
        for record, want in [
            (running(handle="bg-run:minix-amd-linux:/s/run-3"), "not bg-run:rog-nv-linux:<dir>"),
            (running(handle="bg-run:rog-nv-linux:s/run-3"), "not bg-run:rog-nv-linux:<dir>"),
            (running(handle="test-run:run-3"), "not bg-run:rog-nv-linux:<dir>"),
            (running(handle=None), "null"),
            (running(observed_sha=SHA[:12]), "not one full SHA"),
        ]:
            self.assertIn(want, str(started_run(record)), record)

    def test_the_concluded_line(self) -> None:
        self.assertEqual(concluded_line(running(state="concluded", verdict="fail")),
                         f"TIP-RUN CONCLUDED w-gpu-rog-1 fail rog-nv-linux {SHA} /s/tip-runs/run-3")
        bare = {"request_id": "w-gpu-rog-2", "state": "concluded", "verdict": "not-launched", "request": {"execution_host": "h"}}
        self.assertEqual(concluded_line(bare), "TIP-RUN CONCLUDED w-gpu-rog-2 not-launched h - -")

    def wait(self, records: list[list[dict[str, Any]]], far: Done | None, conclude_rc: int = 0,
             args: tuple[str, ...] = ()) -> tuple[int, str, list[list[str]], list[list[str]]]:
        cfg = load_config(SCRIPT, {}, host="h")
        reads = iter(records)
        far_calls: list[list[str]] = []
        worker_calls: list[list[str]] = []

        def far_side(_cfg: object, box: str, script: str, argv: list[str], *, capture: bool = False) -> Done:
            self.assertEqual(box, "rog-nv-linux")
            self.assertIn("bash -s -- wait", script)
            far_calls.append(argv)
            assert far is not None, "the box was read"
            return far

        def worker(_cfg: object, argv: list[str], body: dict[str, Any] | None = None, *, verb: str = "TIP-RUN") -> int:
            worker_calls.append(argv)
            return conclude_rc

        def listing(_cfg: object) -> Done:
            return Done(0, json.dumps(next(reads)))

        out = io.StringIO()
        with mock.patch.object(tiprun, "listing", side_effect=listing), \
                mock.patch.object(tiprun, "run_on", side_effect=far_side), \
                mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
                mock.patch.object(tiprun, "read_halt", return_value=None), \
                contextlib.redirect_stdout(out):
            rc = tiprun.cmd_tip_run(cfg, ["--wait", "w-gpu-rog-1", *args])
        return rc, out.getvalue(), far_calls, worker_calls

    def test_a_finished_run_is_concluded_from_its_record(self) -> None:
        rc, out, far, worker = self.wait([[running()], [running(state="concluded", verdict="pass")]], Done(0, "rc=0\n"),
                                         args=("--within", "30"))
        self.assertEqual(rc, 0)
        self.assertEqual(far, [["/s/tip-runs/run-3", "30"]])
        self.assertEqual(worker, [["execution", "conclude", "--from-bg-run", "/s/tip-runs/run-3", "--request", "w-gpu-rog-1",
                                   "--sha", SHA, "--box", "rog-nv-linux"]])
        self.assertEqual(out, f"TIP-RUN CONCLUDED w-gpu-rog-1 pass rog-nv-linux {SHA} /s/tip-runs/run-3\n")

    def test_a_run_that_finished_earlier_is_concluded_too(self) -> None:
        # A re-issued wait on a run long done says so after the word (ludics-lite#816); the word decides.
        rc, out, _, worker = self.wait([[running()], [running(state="concluded", verdict="pass")]],
                                       Done(0, "rc=0 (finished earlier, at 2026-10-28T15:04:05Z)\n"))
        self.assertEqual((rc, len(worker)), (0, 1))
        self.assertIn("TIP-RUN CONCLUDED w-gpu-rog-1 pass", out)

    def test_a_stopped_run_is_concluded_too(self) -> None:
        rc, out, _, worker = self.wait([[running()], [running(state="concluded", verdict="cancelled")]],
                                       Done(7, "STOPPED /s/tip-runs/run-3\n"))
        self.assertEqual((rc, len(worker)), (0, 1))
        self.assertIn("TIP-RUN CONCLUDED w-gpu-rog-1 cancelled", out)

    def test_a_running_run_is_reissued_and_concludes_nothing(self) -> None:
        rc, out, far, worker = self.wait([[running()]], Done(3, "RUNNING after 480 s of --within 480\n"))
        self.assertEqual((rc, worker), (3, []))
        self.assertEqual(far, [["/s/tip-runs/run-3", str(tiprun.WITHIN)]])
        self.assertEqual(out, "TIP-RUN RUNNING w-gpu-rog-1 rog-nv-linux /s/tip-runs/run-3: RUNNING after 480 s of --within 480\n")

    def test_any_other_answer_concludes_nothing(self) -> None:
        # A line whose first word is no verdict, or not the exit's, is read by ludics.bgrun as none
        # (ludics-lite#826): an `rc=` with no status, a word that only starts like one.
        for far in (Done(5, "DIED: pid 4 gone\n"), Done(4, "STARTING after 0 s\n"), Done(255, ""), Done(0, "RUNNING\n"),
                    Done(0, "rc=x\n"), Done(0, "rc=\n"), Done(3, "RUNNING: after 1 s\n"), Done(7, "STOPPEDX\n"),
                    Done(1, "TIP-RUN REFUSED: no run directory /s/tip-runs/run-3 on rog-nv-linux\n")):
            rc, out, _, worker = self.wait([[running()]], far)
            self.assertEqual((rc, worker), (4, []), far)
            self.assertIn("TIP-RUN UNKNOWN w-gpu-rog-1: ", out, far)

    def test_a_conclusion_that_did_not_land_is_unknown(self) -> None:
        rc, out, _, worker = self.wait([[running()]], Done(0, "rc=1\n"), conclude_rc=4)
        self.assertEqual((rc, len(worker)), (4, 1))
        self.assertIn("the conclusion did not land (above); re-issue the wait", out)

    def test_a_concluded_record_is_read_again_and_no_box_is(self) -> None:
        rc, out, far, worker = self.wait([[running(state="concluded", verdict="fail")]], None)
        self.assertEqual((rc, far, worker), (0, [], []))
        self.assertIn("TIP-RUN CONCLUDED w-gpu-rog-1 fail", out)

    def test_tip_adds_the_loops_next_move(self) -> None:
        done = running(state="concluded", verdict="pass", request={"execution_host": "rog-nv-linux", "repository": "o/r"})
        other = "b" * 40
        for head, want in [(other, f"TIP-RUN TIP main {other} moved"), (SHA, f"TIP-RUN TIP main {SHA} current"),
                           (("EXECUTION UNVERIFIED github.com: x", 4), "TIP-RUN TIP main - unread: EXECUTION UNVERIFIED github.com: x")]:
            with mock.patch.object(tiprun.revision, "branch_head", return_value=head) as read:
                rc, out, far, _ = self.wait([[done]], None, args=("--tip", "main"))
            self.assertEqual((rc, far), (0, []), head)
            self.assertEqual(read.call_args.args[:2], ("o/r", "main"))
            self.assertEqual(out.splitlines()[-1], want)
        with mock.patch.object(tiprun.revision, "branch_head", side_effect=AssertionError("GitHub was asked")):
            rc, out, _, _ = self.wait([[running()]], Done(3, "RUNNING after 1 s of --within 1\n"), args=("--tip", "main"))
        self.assertEqual(rc, 3, "a run still going has no next move")

    def test_records_no_start_wrote_are_refused(self) -> None:
        for records, want in [
            ([], "the registry holds no such request"),
            ([running(state="uncertain")], "it is uncertain, not a run tip-run started"),
            ([running(handle="bg-run:minix-amd-linux:/s/run-3")], "not bg-run:rog-nv-linux:<dir>"),
        ]:
            rc, out, far, worker = self.wait([records], None)
            self.assertEqual((rc, far, worker), (1, [], []), records)
            self.assertIn(want, out, records)


class HaltNote(unittest.TestCase):
    """THE HALT NOTE (ludics#1064): a red --wait concludes under a halt says how it matches the halt's
    reason, and nothing else changes; what is not read notes nothing."""

    OTHER = "b" * 40
    reads = 0  # how many times the last wait read the halt

    def red(self, verdict: str = "fail") -> dict[str, Any]:
        return running(state="concluded", verdict=verdict,
                       request={"execution_host": "rog-nv-linux", "repository": "o/r"})

    def wait(self, record: dict[str, Any], halt: Any, named: Any = frozenset(), compare: Any = (0, "diverged"),
             args: tuple[str, ...] = ()) -> tuple[int, str, str, list[list[str]], list[list[str]]]:
        """--wait on a concluded record: the halt read, the log read and GitHub's compare stand in."""
        cfg = load_config(SCRIPT, {}, host="h")
        logs: list[list[str]] = []
        gh: list[list[str]] = []

        def log_names(_cfg: object, box: str, run_dir: str, names: list[str]) -> Any:
            logs.append([box, run_dir, *names])
            return set(named) if not isinstance(named, str) else named

        def run_tool(name: str, argv: list[str], **_: object) -> Any:
            self.assertEqual(name, "gh")
            gh.append(argv)
            rc, said = compare
            return tiprun.proc.Completed(rc, said + "\n" if rc == 0 else "", "" if rc == 0 else said + "\n")

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(tiprun, "listing", return_value=Done(0, json.dumps([record]))), \
                mock.patch.object(tiprun, "run_on", side_effect=AssertionError("a box was read")), \
                mock.patch.object(tiprun, "read_halt", return_value=halt) as read, \
                mock.patch.object(tiprun, "log_names", side_effect=log_names), \
                mock.patch.object(tiprun.proc, "run_tool", side_effect=run_tool), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = tiprun.cmd_tip_run(cfg, ["--wait", "w-gpu-rog-1", *args])
        self.reads = read.call_count
        return rc, out.getvalue(), err.getvalue(), logs, gh

    def test_the_reason_s_two_shapes_and_no_other_words(self) -> None:
        reason = ("cc red at 67203021, rerun pending; test=golden_einsum stale (owned by t1904),"
                  " (test=test/ops/foo.ml. xtest=no test=golden_einsum origin/abcdef12 deadbeefcafe0123x 1234567")
        self.assertEqual(tiprun.halt_shapes(reason),
                         (["67203021", "abcdef12", "1234567"], ["golden_einsum", "test/ops/foo.ml"]))
        self.assertEqual(tiprun.halt_shapes("ABCDEF12 abcdef1 " + "a" * 41 + " test= test=."), (["abcdef1"], []))

    def test_a_red_whose_log_names_the_halt_s_test_is_noted(self) -> None:
        reason = f"cuda red at {self.OTHER[:8]}, test=golden_einsum stale, owned by t1904"
        rc, out, _, logs, gh = self.wait(self.red(), reason, named={"golden_einsum"})
        self.assertEqual(rc, 0, "a note changes no exit status")
        self.assertEqual(logs, [["rog-nv-linux", "/s/tip-runs/run-3", "golden_einsum"]], "the log is read on the run's box")
        self.assertEqual(gh, [["api", "--hostname", "github.com", f"repos/o/r/compare/{self.OTHER[:8]}...{SHA}", "-q", ".status"]])
        self.assertEqual(out.splitlines(), [
            f"TIP-RUN CONCLUDED w-gpu-rog-1 fail rog-nv-linux {SHA} /s/tip-runs/run-3",
            "TIP-RUN HALT w-gpu-rog-1 matches the standing halt: its log names test=golden_einsum, which the reason names;"
            f" the halt's reason: {reason}"])

    def test_a_red_at_or_past_the_halt_s_commit_is_noted(self) -> None:
        rc, out, _, _, gh = self.wait(self.red("timeout"), f"red at {SHA[:8]}, rerun pending")
        self.assertEqual((rc, gh), (0, []), "a red at the commit asks GitHub nothing")
        self.assertIn(f"matches the standing halt: its commit {SHA} is {SHA[:8]}, which the reason names; the halt's", out)
        rc, out, _, _, _ = self.wait(self.red(), f"red at {self.OTHER[:8]}, test=gold", named=set(), compare=(0, "ahead"))
        self.assertEqual(out.splitlines()[-1],
                         f"TIP-RUN HALT w-gpu-rog-1 matches the standing halt: its commit {SHA} descends from {self.OTHER[:8]},"
                         " which the reason names (inside the halt's span); its log does not name test=gold;"
                         f" the halt's reason: red at {self.OTHER[:8]}, test=gold")

    def test_a_red_outside_the_halt_s_match_is_not_noted(self) -> None:
        for compare in ((0, "diverged"), (0, "behind")):
            rc, out, err, logs, _ = self.wait(self.red(), f"red at {self.OTHER[:8]}, test=golden_einsum", compare=compare)
            self.assertEqual(rc, 0)
            self.assertEqual(len(logs), 1)
            self.assertNotIn("TIP-RUN HALT", out, compare)
            self.assertEqual(err, "", compare)
        rc, out, _, _, _ = self.wait(self.red(), "a red with no commit and no test=")
        self.assertNotIn("TIP-RUN HALT", out)

    def test_a_green_is_never_noted(self) -> None:
        for verdict in ("pass", "cancelled", "not-launched"):
            record = {**self.red(), "verdict": verdict}
            rc, out, _, logs, gh = self.wait(record, f"red at {SHA[:8]}, test=golden_einsum", named={"golden_einsum"})
            self.assertEqual((rc, logs, gh, self.reads), (0, [], [], 0), verdict)
            self.assertNotIn("TIP-RUN HALT", out, verdict)

    def test_no_halt_or_an_unreadable_one_gives_no_note(self) -> None:
        rc, out, err, logs, _ = self.wait(self.red(), None)
        self.assertEqual((rc, logs, err), (0, [], ""))
        self.assertNotIn("TIP-RUN HALT", out)
        rc, out, err, logs, _ = self.wait(self.red(), ("the anchor mac-studio did not answer",))
        self.assertEqual((rc, logs), (0, []))
        self.assertNotIn("TIP-RUN HALT", out)
        self.assertIn("TIP-RUN NOTE w-gpu-rog-1: the halt could not be read (the anchor mac-studio did not answer)", err)

    def test_what_is_not_read_notes_nothing_of_that_shape(self) -> None:
        reason = f"red at {self.OTHER[:8]}, test=golden_einsum"
        rc, out, err, _, _ = self.wait(self.red(), reason, named="rog-nv-linux did not answer", compare=(1, "HTTP 502"))
        self.assertEqual(rc, 0)
        self.assertNotIn("TIP-RUN HALT", out)
        self.assertIn(f"whether {SHA} descends from {self.OTHER[:8]} (the halt's reason names it) is unread: GitHub's compare"
                      " answered 'HTTP 502'", err)
        self.assertIn("whether its log names test=golden_einsum (the halt's reason does) is unread: rog-nv-linux did not answer", err)
        rc, out, _, _, _ = self.wait(self.red(), reason, named={"golden_einsum"}, compare=(1, "HTTP 502"))
        self.assertIn("matches the standing halt: its log names test=golden_einsum", out, "the other shape still matches")
        rc, out, err, logs, _ = self.wait({**self.red(), "handle": "test-run:x"}, reason, named={"golden_einsum"})
        self.assertEqual(logs, [])
        self.assertNotIn("TIP-RUN HALT", out)
        self.assertIn('is unread: its handle is "test-run:x", not bg-run:<box>:<dir>', err)
        rc, out, err, _, gh = self.wait({**self.red(), "observed_sha": None}, f"red at {SHA[:8]}")
        self.assertEqual((rc, gh), (0, []))
        self.assertNotIn("TIP-RUN HALT", out)
        self.assertIn("its observed_sha is null, not one full SHA", err)

    def test_the_note_precedes_the_loop_s_next_move(self) -> None:
        with mock.patch.object(tiprun.revision, "branch_head", return_value=SHA):
            rc, out, _, _, _ = self.wait(self.red(), f"red at {SHA[:8]}", args=("--tip", "main"))
        self.assertEqual(rc, 0)
        self.assertEqual([line.split(" ")[1] for line in out.splitlines()], ["CONCLUDED", "HALT", "TIP"])

    def test_the_halt_is_read_as_the_registry_reads_its_marker(self) -> None:
        cfg = dataclasses.replace(load_config(SCRIPT, {}, host="h"), anchor="mac-studio")
        for done, want in [
            (Done(0, "halt=0\n"), None),
            (Done(0, "halt=1\n2026-11-11T00:00:00Z id=g1 cc red at 67203021, rerun pending\n"), "cc red at 67203021, rerun pending"),
            (Done(0, "halt=1\nlegacy first line\nupdate 2026-11-11T00:00:00Z test=x owned\n"), "test=x owned"),
            (Done(255, ""), ("the anchor mac-studio did not answer",)),
            (Done(0, "halt=1\n\n"), ("the marker on the anchor mac-studio states no halt the registry would read",)),
            (Done(0, "halt=unread\n"), ("the marker on the anchor mac-studio is there but cannot be read",)),
            (Done(2, "halt=0\n"), ("an unreadable answer from the anchor mac-studio (exit 2)",)),
            (Done(0, "launches open\n"), ("an unreadable answer from the anchor mac-studio (exit 0)",)),
        ]:
            with mock.patch.object(tiprun, "run_on", return_value=done) as far:
                got = tiprun.read_halt(cfg)
            self.assertEqual(got, want, done)
            self.assertEqual(far.call_args.args[1], "mac-studio")
            self.assertIn(tiprun.HALT_READ, far.call_args.args[2])

    def test_the_anchor_s_marker_is_absent_only_when_nothing_is_there(self) -> None:
        # The registry's `absent` (#1076): a link that dangles or loops, or a file that cannot be
        # read, is a halt not read, never no halt.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state = Path(tmp.name)
        bash = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash") or "bash"

        def far() -> str:
            return subprocess.run([bash, "-c", f"ANCHOR_STATE={shlex.quote(str(state))}\n" + tiprun.HALT_READ],
                                  capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout

        self.assertEqual(far(), "halt=0\n")
        halt = state / "HALT"
        halt.write_text("2026-11-11T00:00:00Z id=g1 red at 67203021\n", encoding="utf-8")
        self.assertEqual(far(), "halt=1\n2026-11-11T00:00:00Z id=g1 red at 67203021\n")
        halt.unlink()
        for target in ("nowhere", "HALT"):
            halt.symlink_to(target)
            self.assertEqual(far(), "halt=unread\n", target)
            halt.unlink()
        if os.geteuid() != 0:  # root reads a mode-000 file
            halt.write_text("x id=g y\n", encoding="utf-8")
            halt.chmod(0)
            self.addCleanup(halt.chmod, 0o644)
            self.assertEqual(far(), "halt=unread\n")

    def test_the_log_is_read_for_whole_names(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        log = Path(tmp.name) / "log"
        log.write_text("EXECUTION SLOT box: slot 1 of 1 held for: x\nFAILED golden_einsum (diff in test/ops/foo.ml)\n"
                       "ok golden_einsum2\nexit: 1\n", encoding="utf-8")
        bash = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash") or "bash"
        names = ["golden_einsum", "test/ops/foo.ml", "golden_einsum2x", "einsum", "golden"]
        done = subprocess.run([bash, "-c", tiprun.LOG_NAMES, "x", str(log), *names], capture_output=True, text=True,
                              stdin=subprocess.DEVNULL)
        self.assertEqual(done.stdout.splitlines(), ["log=1", "named=golden_einsum", "named=test/ops/foo.ml"])
        done = subprocess.run([bash, "-c", tiprun.LOG_NAMES, "x", str(log) + ".gone", "golden_einsum"], capture_output=True,
                              text=True, stdin=subprocess.DEVNULL)
        self.assertEqual(done.stdout, "log=0\n")


if __name__ == "__main__":
    unittest.main()
