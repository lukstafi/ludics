"""ludics.fleetworker.assign: ``execution assign``'s readers and its outcomes (the shell suite's
"execution assign" section drives the verb end to end, against the registry)."""

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from collections.abc import Sequence
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import assign, execution, boardstore
from ludics.fleetworker.assign import (assigned_revision, base_problem, block_problem, cmd_assign, fleet_worker_word,
                                       leg_command, parse, payload_of, read_blocks)
from ludics.fleetworker.config import Config, load_config
from ludics.fleetworker.transport import Done

SHA = "b" * 40
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "issue-wave", "scripts", "fleet-worker.sh")
BASE = {"wave": "w", "worker": "/root/w", "transport": "subagent", "agent_host": "mac", "repository": "o/r",
        "issue": "o/r#869", "purpose": "fixture"}


def block(request_id: str, host: str = "rog", kind: str = "correctness", **fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"request_id": request_id, "execution_host": host, "kind": kind, "requested_revision": SHA}
    if "runner" not in fields and "command" not in fields:
        out["command"] = "tools/test-run.sh run"
    out.update(fields)
    return out


def message(*blocks: dict[str, Any]) -> str:
    return "prose\n" + "".join(f"    EXECUTION_REQUEST\n{json.dumps(b)}\n    END_EXECUTION_REQUEST\n" for b in blocks)


class Readers(unittest.TestCase):
    def test_blocks_are_read_between_their_marker_lines_alone(self) -> None:
        text = "EXECUTION_REQUEST is how I ask\n" + message(block("a"), block("b")) + "```\n"
        got = read_blocks(text)
        assert isinstance(got, list)
        self.assertEqual([b["request_id"] for b in got], ["a", "b"])

    def test_block_refusals(self) -> None:
        self.assertIn("no EXECUTION_REQUEST", read_blocks("nothing here"))
        self.assertIn("has no END_EXECUTION_REQUEST", read_blocks("EXECUTION_REQUEST\n{}\n"))
        self.assertIn("inside a block", read_blocks("EXECUTION_REQUEST\nEXECUTION_REQUEST\n"))
        self.assertIn("is not one JSON object", read_blocks("EXECUTION_REQUEST\n{oops\nEND_EXECUTION_REQUEST\n"))
        self.assertIn("with no EXECUTION_REQUEST", read_blocks("END_EXECUTION_REQUEST\n"))

    def test_the_block_allowlist(self) -> None:
        self.assertIsNone(block_problem(block("a")))
        self.assertIn("names standing", block_problem(block("a", command="x", standing=True)) or "")
        self.assertIn("names transport", block_problem(block("a", command="x", transport="native")) or "")
        self.assertIn("exactly one of command", block_problem(block("a", command="x", runner="y")) or "")
        self.assertIn("exactly one of command", block_problem({k: v for k, v in block("a").items() if k != "command"}) or "")
        self.assertIn("kind must be", block_problem(block("a", kind="bench")) or "")
        self.assertIn("checkout must be an absolute", block_problem(block("a", command="x", checkout="wt")) or "")
        self.assertIn("a runner needs clone", block_problem(block("a", runner="x", checkout="/wt")) or "")
        self.assertIn("a runner needs checkout", block_problem(block("a", runner="x", clone="/c")) or "")
        self.assertIn("full 40-hex SHA or head-of", block_problem(block("a", runner="x", clone="/c", checkout="/wt",
                                                                        requested_revision="origin/main")) or "")
        self.assertIsNone(block_problem(block("a", runner=["x", "y z"], clone="/c", checkout="/wt",
                                              requested_revision="head-of:claude/x")))
        self.assertIn("runner must be", block_problem(block("a", runner=[], clone="/c", checkout="/wt")) or "")

    def test_the_base_allowlist(self) -> None:
        self.assertIsNone(base_problem(BASE))
        self.assertIn("takes only", base_problem({**BASE, "standing": True}) or "")
        self.assertIn("must give transport", base_problem({k: v for k, v in BASE.items() if k != "transport"}) or "")
        self.assertIn("not one JSON object", base_problem([BASE]) or "")

    def test_parse(self) -> None:
        got = parse(["--request", "a", "/b.json", "-", "--request", "a", "--no-gap", "--deadline", "60"])
        self.assertEqual((got.base, got.requests, got.only, got.no_gap, got.deadline), ("/b.json", "-", ["a"], True, "60"))
        err = io.StringIO()
        for args in (["/b.json"], ["/b.json", "/r", "--oops"], ["/b.json", "/r", "--deadline", "0"],
                     ["/b.json", "/r", "--unstick", "box", "w"]):
            with contextlib.redirect_stderr(err), self.assertRaises(cli.Exit) as caught:
                parse(args)
            self.assertEqual(caught.exception.rc, 2, args)


class Composition(unittest.TestCase):
    def test_a_correctness_leg_waits_out_a_window_and_a_measurement_leg_does_not(self) -> None:
        leg = block("a", runner="tools/test-run.sh run --x", clone="/srv/p", checkout="/srv/wt")
        self.assertEqual(leg_command("fw", leg, SHA), f"fw execution leg --request a --rev {SHA} --checkout /srv/p"
                                                     " --worktree /srv/wt --wait-window -- tools/test-run.sh run --x")
        measured = {**leg, "kind": "measurement", "runner": ["bench", "a b"]}
        self.assertEqual(leg_command("fw", measured, SHA),
                         f"fw execution leg --request a --rev {SHA} --checkout /srv/p --worktree /srv/wt -- bench 'a b'")

    def test_the_fleet_worker_is_named_from_home(self) -> None:
        cfg = load_config("/home/u/.claude/skills/issue-wave/scripts/fleet-worker.sh", {"HOME": "/home/u"})
        self.assertEqual(fleet_worker_word(cfg), "~/.claude/skills/issue-wave/scripts/fleet-worker.sh")
        cfg = load_config("/opt/my fleet/fleet-worker.sh", {"HOME": "/home/u"})
        self.assertEqual(fleet_worker_word(cfg), "'/opt/my fleet/fleet-worker.sh'")

    def test_the_payload_is_the_base_and_the_request_with_its_checkout_beside(self) -> None:
        got = payload_of(BASE, block("a", command="x", checkout="/wt", log="/l", purpose="mine"))
        self.assertEqual(got["checkout"], "/wt")
        self.assertEqual(got["purpose"], "mine")
        self.assertNotIn("log", got)
        self.assertNotIn("command", got)
        self.assertIn("the worker asked: x", got["evidence"])

    def test_a_head_of_revision_is_read_off_the_record(self) -> None:
        moved = "c" * 40
        head = block("a", requested_revision="head-of:claude/x")
        self.assertEqual(assigned_revision(json.dumps({"resolved_revision": moved}, indent=2) + "\nREFRESH OK\n", head), moved)
        self.assertIsNone(assigned_revision("not json", head))
        self.assertIsNone(assigned_revision(json.dumps({"state": "launching"}), head))
        self.assertEqual(assigned_revision("", block("a")), SHA)


class Outcomes(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: [os.unlink(os.path.join(self.dir, f)) for f in os.listdir(self.dir)] and None)
        self.cfg = load_config(SCRIPT, {"HOME": "/nowhere"})
        self.base = self.write("base.json", json.dumps(BASE))
        self.placements: list[tuple[str, str, str, str]] = []
        self.placement_rc = 0
        self.calls: list[list[str]] = []
        self.unsticks: list[tuple[str, str, str]] = []

    def write(self, name: str, text: str) -> str:
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def assign(self, args: list[str], answers: dict[str, Done], records: Sequence[dict[str, Any]] = (),
               unstick_rc: int = 0) -> tuple[int, str, str]:
        def call(_cfg: Config, verb: Sequence[str], payload: dict[str, Any]) -> Done:
            self.calls.append([*verb, payload["request_id"]])
            return answers[payload["request_id"]]

        def resend(_cfg: Config, box: str, name: str, file: str) -> int:
            self.unsticks.append((box, name, file))
            return unstick_rc

        def placement(_cfg: Config, wave: str, worker: str, host: str, checkout: str) -> int:
            self.placements.append((wave, worker, host, checkout))
            if self.placement_rc:
                return self.placement_rc
            with contextlib.redirect_stdout(io.StringIO()):
                return boardstore.run(["-", self.dir, "placement", "coord", json.dumps(
                    {"wave": wave, "worker": worker, "host": host, "checkout": checkout})])

        out, err = io.StringIO(), io.StringIO()
        with (mock.patch.object(assign, "record_placement", side_effect=placement),
              mock.patch.object(execution, "listing", return_value=Done(0, json.dumps(list(records)))),
              contextlib.redirect_stdout(out), contextlib.redirect_stderr(err)):
            rc = cmd_assign(self.cfg, args, call=call, resend=resend)
        return rc, out.getvalue(), err.getvalue()

    def test_one_refused_among_two_leaves_the_other_assigned(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("m", host="tuf", kind="measurement")))
        rc, out, err = self.assign([self.base, requests, "--deadline", "600"], {"a": Done(0, "{}"), "m": Done(1, "")})
        self.assertEqual(rc, 1)
        self.assertIn("EXECUTION_ASSIGNED a\n", out)
        self.assertNotIn("EXECUTION_ASSIGNED m", out)
        self.assertIn(f"ASSIGN ASSIGNED a correctness rog {SHA}", err)
        self.assertIn("ASSIGN REFUSED m: the window exited 1", err)
        self.assertEqual(self.calls, [["execution", "run", "a"], ["execution", "window", "--deadline", "600", "tuf", "m"]])

    def test_assigned_legs_and_already_retry_preserve_each_placement_once(self) -> None:
        # The actual shipped store applies each write; no mock of the union logic.
        with contextlib.redirect_stdout(io.StringIO()):
            boardstore.main(["-", self.dir, "set", "coord", json.dumps({"wave": "w", "create": True,
                "new_row": True, "task": "t42", "fields": [["worker", BASE["worker"]],
                ["farside", "mac:/worker"], ["exec_hosts", "mac"]]})])
        self.addCleanup(lambda: shutil.rmtree(os.path.join(self.dir, "boards")))
        requests = self.write("r.txt", message(block("a", runner="check", clone="/repo", checkout="/wt"),
                                               block("b", host="tuf", runner="check", clone="/repo", checkout="/wt")))
        args = [self.base, requests]
        self.assertEqual(self.assign(args, {"a": Done(0, "{}"), "b": Done(0, "{}")} )[0], 0)
        records = [{"request_id": name, "state": state, "checkout": "/wt",
                    "request": {**BASE, "execution_host": host}}
                   for name, state, host in (("a", "launching", "rog"), ("b", "concluded", "tuf"))]
        # Simulate the interrupted write after an earlier dispatch; ALREADY repairs it.
        path = os.path.join(self.dir, "boards", "w.json")
        with open(path) as stream:
            doc = json.load(stream)
        doc["tasks"][0]["fields"]["farside"] = "mac:/worker rog:/wt"
        with open(path, "w") as stream:
            json.dump(doc, stream)
        for _ in range(2):
            rc, out, _ = self.assign(args, {}, records)
            self.assertEqual((rc, out), (0, ""))
        with open(path) as stream:
            fields = json.load(stream)["tasks"][0]["fields"]
        self.assertEqual(fields["farside"], "mac:/worker rog:/wt tuf:/wt")
        self.assertEqual(fields["exec_hosts"], "mac,rog,tuf")
        self.assertEqual(len(self.calls), 2, "ALREADY never dispatches again")
        self.assertEqual(len(self.placements), 6)

    def test_board_failure_keeps_assignment_and_retry_repairs_without_dispatch(self) -> None:
        requests = self.write("r.txt", message(block("a", checkout="/wt")))
        self.placement_rc = 4
        rc, out, err = self.assign([self.base, requests], {"a": Done(0, "{}")})
        self.assertEqual(rc, 1)
        self.assertIn("EXECUTION_ASSIGNED a", out)
        self.assertIn("ASSIGN BOARD NOTE", err)
        self.placement_rc = 0
        self.assertEqual(self.assign([self.base, requests], {}, [{"request_id": "a", "state": "launching",
            "checkout": "/wt", "request": {**BASE, "execution_host": "rog"}}])[0], 0)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.placements), 2)

    def test_missing_identity_is_a_board_note_and_remaining_requests_are_handled(self) -> None:
        requests = self.write("r.txt", message(block("a", checkout="/wt"), block("b", checkout="/other")))
        records = [{"request_id": "a", "state": "launching", "checkout": "/wt",
                    "request": {**BASE, "execution_host": "rog"}}]
        out, err = io.StringIO(), io.StringIO()
        with (mock.patch.object(execution, "listing", return_value=Done(0, json.dumps(records))),
              mock.patch.object(assign, "record_placement", side_effect=[cli.Exit(2, "no coordinator identity"), 0]),
              contextlib.redirect_stdout(out), contextlib.redirect_stderr(err)):
            rc = cmd_assign(self.cfg, [self.base, requests], call=lambda *_: Done(0, "{}"))
        self.assertEqual(rc, 1)
        self.assertIn("ASSIGN BOARD NOTE a: no coordinator identity", err.getvalue())
        self.assertIn("EXECUTION_ASSIGNED b", out.getvalue())

    def test_already_with_a_different_registry_checkout_records_nothing(self) -> None:
        requests = self.write("r.txt", message(block("a", checkout="/wrong")))
        record = {"request_id": "a", "state": "launching", "checkout": "/actual",
                  "request": {**BASE, "execution_host": "rog"}}
        rc, out, err = self.assign([self.base, requests], {}, [record])
        self.assertEqual((rc, out), (1, ""))
        self.assertIn("differs from this request", err)
        self.assertEqual(self.placements, [])
        self.assertEqual(self.calls, [])

    def test_refused_unknown_and_checkoutless_requests_add_no_placement(self) -> None:
        requests = self.write("r.txt", message(block("a", checkout="/wt"), block("b", checkout="/other"), block("c")))
        self.assign([self.base, requests], {"a": Done(1, ""), "b": Done(4, ""), "c": Done(0, "{}")})
        self.assertEqual(self.placements, [])

    def test_a_refused_window_alone_prints_nothing(self) -> None:
        requests = self.write("r.txt", message(block("m", kind="measurement")))
        msg = os.path.join(self.dir, "msg.txt")
        rc, out, _ = self.assign([self.base, requests, "--message", msg, "--unstick", "box", "w"], {"m": Done(1, "")})
        self.assertEqual((rc, out), (1, ""))
        self.assertFalse(os.path.exists(msg), "a call that assigns nothing writes no message")
        self.assertEqual(self.unsticks, [], "and unsticks nothing")

    def test_a_retry_assigns_nothing_twice(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("b", host="tuf")))
        records = [{"request_id": "a", "state": "launching"}, {"request_id": "b", "state": "reserved"}]
        rc, out, err = self.assign([self.base, requests], {"b": Done(0, "{}")}, records)
        self.assertEqual(rc, 0)
        self.assertIn("ASSIGN ALREADY a: the registry holds it launching", err)
        self.assertNotIn("EXECUTION_ASSIGNED a", out)
        self.assertIn("EXECUTION_ASSIGNED b", out, "a record still reserved is dispatched like a new one")
        self.assertEqual(self.calls, [["execution", "run", "b"]])

    def test_an_unknown_outcome_is_exit_4(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("h", requested_revision="head-of:x")))
        rc, out, err = self.assign([self.base, requests], {"a": Done(4, ""), "h": Done(0, "{}")})
        self.assertEqual(rc, 4)
        self.assertEqual(out, "")
        self.assertIn("ASSIGN UNKNOWN a: the run's outcome is unknown", err)
        self.assertIn("ASSIGN UNKNOWN h: dispatched, but no resolved_revision", err)

    def test_selection_and_the_cli_worker_unstick(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("b", host="tuf")))
        msg = os.path.join(self.dir, "msg.txt")
        rc, out, _ = self.assign([self.base, requests, "--request", "b", "--message", msg, "--unstick", "box", "w"],
                                 {"b": Done(0, "{}")})
        self.assertEqual(rc, 0)
        self.assertEqual(self.calls, [["execution", "run", "b"]])
        with open(msg, encoding="utf-8") as f:
            self.assertEqual(f.read(), out)
        self.assertEqual(self.unsticks, [("box", "w", msg)])
        self.assertTrue(out.rstrip().endswith("Run only the 1 assignment above, and end your turn with one EXECUTION_RESULT line for each."))

    def test_a_failed_unstick_is_exit_4_naming_the_resend(self) -> None:
        requests = self.write("r.txt", message(block("a")))
        msg = os.path.join(self.dir, "msg.txt")
        rc, _, err = self.assign([self.base, requests, "--message", msg, "--unstick", "box", "w"], {"a": Done(0, "{}")},
                                 unstick_rc=1)
        self.assertEqual(rc, 4)
        self.assertIn(f"resend with: fleet-worker.sh unstick box w --message {msg} -- never assign again", err)

    def test_shape_refusals_ask_nothing(self) -> None:
        for name, text in (("dup", message(block("a"), block("a"))), ("bad", message(block("a"), {"request_id": "z"}))):
            requests = self.write(f"{name}.txt", text)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(cli.Exit) as caught:
                self.assign([self.base, requests], {})
            self.assertEqual(caught.exception.rc, 2, name)
        requests = self.write("one.txt", message(block("a")))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(cli.Exit) as caught:
            self.assign([self.base, requests, "--request", "nope"], {})
        self.assertIn("--request nope names no block", caught.exception.message)
        aimless = self.write("aimless.json", json.dumps({k: v for k, v in BASE.items() if k != "purpose"}))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(cli.Exit) as caught:
            self.assign([aimless, requests], {})
        self.assertIn("a has no purpose, and the base gives none", caught.exception.message)
        self.assertEqual(self.calls, [])

    def test_an_unreadable_registry_asks_nothing(self) -> None:
        requests = self.write("r.txt", message(block("a")))
        out, said = io.StringIO(), io.StringIO()

        def call(_cfg: Config, _verb: Sequence[str], _payload: dict[str, Any]) -> Done:
            self.fail("the registry was asked")

        with (mock.patch.object(execution, "listing", return_value=Done(1, "EXECUTION REFUSED: busy")),
              contextlib.redirect_stdout(out), contextlib.redirect_stderr(said)):
            rc = cmd_assign(self.cfg, [self.base, requests], call=call)
        self.assertEqual((rc, out.getvalue()), (4, ""), "stdout is the message alone")
        self.assertIn("EXECUTION REFUSED: busy\nASSIGN UNKNOWN: the registry", said.getvalue())


class Wiring(unittest.TestCase):
    def test_execution_routes_assign(self) -> None:
        with mock.patch.object(assign, "cmd_assign", return_value=7) as called:
            self.assertEqual(execution.cmd_execution(load_config(SCRIPT, {}), ["assign", "x", "y"]), 7)
        called.assert_called_once()


if __name__ == "__main__":
    unittest.main()
