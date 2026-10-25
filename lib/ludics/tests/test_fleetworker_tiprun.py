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
            self.assertIn("execution tip-run <json-file> [--tip <branch>] --checkout <dir>", self.refused(args), args)


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


    def test_a_remote_box_whose_refresh_fails_starts_nothing(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="h")
        with tempfile.TemporaryDirectory() as tmp:
            payload = os.path.join(tmp, "req.json")
            with open(payload, "w", encoding="utf-8") as f:
                json.dump(request(), f)
            calls: list[tuple[list[str], dict[str, Any] | None]] = []

            def listing(_cfg: object) -> Done:
                return Done(0, json.dumps([outstanding("w-gpu-rog-1")]) if calls else "[]")

            def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None) -> int:
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
        self.assertEqual([c[0] for c in calls], [["execution", "run", payload], ["execution", "conclude"]])
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

        def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None) -> int:
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
        self.assertEqual(calls, [(["execution", "run"], {**request(), "requested_revision": SHA})])
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

        def worker(_cfg: object, args: list[str], body: dict[str, Any] | None = None) -> int:
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
        self.assertEqual(calls, [(["execution", "run"], {**bare, "request_id": "w-gpu-rog-4"})])
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


def running(**fields: object) -> dict[str, Any]:
    record: dict[str, Any] = {"request_id": "w-gpu-rog-1", "state": "running", "observed_sha": SHA,
                              "handle": "bg-run:rog-nv-linux:/s/tip-runs/run-3", "request": {"execution_host": "rog-nv-linux"}}
    record.update(fields)
    return record


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

        def worker(_cfg: object, argv: list[str], body: dict[str, Any] | None = None) -> int:
            worker_calls.append(argv)
            return conclude_rc

        def listing(_cfg: object) -> Done:
            return Done(0, json.dumps(next(reads)))

        out = io.StringIO()
        with mock.patch.object(tiprun, "listing", side_effect=listing), \
                mock.patch.object(tiprun, "run_on", side_effect=far_side), \
                mock.patch.object(tiprun, "fleet_worker", side_effect=worker), \
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
        for far in (Done(5, "DIED: pid 4 gone\n"), Done(4, "STARTING after 0 s\n"), Done(255, ""), Done(0, "RUNNING\n"),
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


if __name__ == "__main__":
    unittest.main()
