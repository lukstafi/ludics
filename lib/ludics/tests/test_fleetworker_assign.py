"""ludics.fleetworker.assign: ``execution assign``'s readers and its outcomes (the shell suite's
"execution assign" section drives the verb end to end, against the registry)."""

import contextlib
import errno
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Sequence
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import assign, execution, boardstore
from ludics.fleetworker.assign import (StepResult, assigned_revision, base_problem, block_problem, cmd_assign, fleet_worker_word,
                                       leg_command, parse, payload_of, read_blocks)
from ludics.fleetworker.config import Config, load_config
from ludics.fleetworker.registry import ASSIGN_ACTION_REQUIRED
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

    def test_runner_words_with_slot_flags_require_a_full_command(self) -> None:
        for runner, flag in (("tools/check.sh '--cpu'", "--cpu"), (["tools/check.sh", "--gpu"], "--gpu")):
            with self.subTest(runner=runner):
                problem = block_problem(block("a", runner=runner, clone="/c", checkout="/w")) or ""
                self.assertIn(f"runner contains {flag}", problem)
                self.assertIn("--wait-window [--cpu|--gpu] -- <runner-executable>", problem)
                self.assertIn("Keep runner-owned flags after --", problem)
        problem = block_problem(block("a", kind="measurement", runner=["bench", "--gpu"], clone="/c",
                                      checkout="/w", requested_revision="head-of:topic"))
        self.assertIn("--worktree <checkout> -- <runner-executable>", problem or "")
        self.assertIn("Pin the same full SHA in the command and requested_revision", problem or "")

    def test_runner_reading_checks_complete_words_without_expanding_shell_syntax(self) -> None:
        for runner in ("tools/check.sh '--cpu label'", ["tools/check.sh", "--gpu label"], 'tools/check.sh "$FLAGS"'):
            with self.subTest(runner=runner):
                self.assertIsNone(block_problem(block("a", runner=runner, clone="/c", checkout="/w")))
        self.assertIn("complete shell words",
                      block_problem(block("a", runner="tools/check.sh '", clone="/c", checkout="/w")) or "")
        for runner in ("tools/check.sh --cpu>/tmp/log", "tools/check.sh # --cpu", "tools/check.sh\ntrue"):
            with self.subTest(runner=runner):
                problem = block_problem(block("a", runner=runner, clone="/c", checkout="/w"))
                self.assertIn('a full leg in "command" for shell syntax', problem or "")

    def test_the_base_allowlist(self) -> None:
        self.assertIsNone(base_problem(BASE))
        self.assertIn("takes only", base_problem({**BASE, "standing": True}) or "")
        self.assertIn("must give transport", base_problem({k: v for k, v in BASE.items() if k != "transport"}) or "")
        self.assertIn("not one JSON object", base_problem([BASE]) or "")

    def test_parse(self) -> None:
        got = parse(["--request", "a", "/b.json", "-", "--request", "a", "--no-gap", "--deadline", "60", "--status", "/s"])
        self.assertEqual((got.base, got.requests, got.only, got.no_gap, got.deadline, got.status),
                         ("/b.json", "-", ["a"], True, "60", "/s"))
        err = io.StringIO()
        for args in (["/b.json"], ["/b.json", "/r", "--oops"], ["/b.json", "/r", "--deadline", "0"],
                     ["/b.json", "/r", "--unstick", "box", "w"],
                     # THE STATUS never replaces the message a resend sends, nor what assign reads (ludics#1234).
                     ["/b.json", "/r", "--message", "/m", "--status", "/m"], ["/b.json", "/r", "--status", "/b.json"],
                     ["/b.json", "/r", "--status", "/r"], ["/b.json", "/r", "--status", ""]):
            with contextlib.redirect_stderr(err), self.assertRaises(cli.Exit) as caught:
                parse(args)
            self.assertEqual(caught.exception.rc, 2, args)


class Composition(unittest.TestCase):
    def test_assignment_names_the_form_per_kind_and_leaves_legs_wrapped_once(self) -> None:
        for kind, form in (("correctness", "execution slot --wait-window --cpu -- <command>"),
                           ("measurement", "execution hold --request a -- <command>")):
            with self.subTest(kind=kind):
                text = assign.assignment_text(block("a", kind=kind), "true", SHA)
                self.assertIn(form, text)
                leg = block("a", kind=kind, runner="true", clone="/c", checkout="/w")
                text = assign.assignment_text(leg, leg_command("fw", leg, SHA), SHA)
                self.assertIn("run it as: the command above already uses execution leg", text)
                self.assertNotIn("-- <command>", text)

    def test_manually_wrapped_legs_are_run_as_written_for_both_kinds(self) -> None:
        for kind in ("correctness", "measurement"):
            request = block("a", kind=kind, execution_host="other", command="fw execution leg --request a -- true")
            text = assign.assignment_text(request, request["command"], SHA)
            self.assertIn("run it as: an execution leg command runs as written; for a bare batch on other,", text)
            self.assertIn("command: fw execution leg --request a -- true", text)

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

    def assign(self, args: list[str], answers: dict[str, StepResult], records: Sequence[dict[str, Any]] = (),
               unstick_rc: int = 0, unstick_err: str = "", step_err: str = "") -> tuple[int, str, str]:
        def call(_cfg: Config, verb: Sequence[str], payload: dict[str, Any]) -> StepResult:
            self.calls.append([*verb, payload["request_id"]])
            sys.stderr.write(step_err)  # what step() relays of a child's stderr
            return answers[payload["request_id"]]

        def resend(_cfg: Config, box: str, name: str, file: str) -> Done:
            self.unsticks.append((box, name, file))
            return Done(unstick_rc, unstick_err)

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
        rc, out, err = self.assign([self.base, requests, "--deadline", "600"], {"a": StepResult(0, "{}"), "m": StepResult(1, "")})
        self.assertEqual(rc, 1)
        self.assertIn("EXECUTION_ASSIGNED a\n", out)
        self.assertNotIn("EXECUTION_ASSIGNED m", out)
        self.assertIn(f"ASSIGN ASSIGNED a correctness rog {SHA}", err)
        self.assertIn("ASSIGN REFUSED m: the window exited 1", err)
        self.assertEqual(self.calls, [["execution", "run", "a"], ["execution", "window", "--deadline", "600", "tuf", "m"]])

    def test_a_step_that_cannot_start_reports_the_executable(self) -> None:
        missing = os.path.join(self.dir, "missing fleet-worker.sh")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            answer = assign.step(load_config(missing, {"HOME": "/nowhere"}), ["execution", "run"], block("a"))
        self.assertEqual((answer.rc, answer.out), (127, ""))
        self.assertIn(f"{shlex.quote(missing)}: No such file or directory", err.getvalue())

    def test_a_step_that_cannot_stage_its_payload_asks_nothing(self) -> None:
        problem = OSError(errno.ENOSPC, "fixture: no space for payload")
        err = io.StringIO()
        with (mock.patch.object(tempfile, "mkstemp", side_effect=problem),
              mock.patch.object(assign.subprocess, "Popen") as launch,
              contextlib.redirect_stderr(err)):
            answer = assign.step(self.cfg, ["execution", "run"], block("a"))
        launch.assert_not_called()
        self.assertEqual((answer.rc, answer.out), (1, ""))
        self.assertIn("cannot stage the payload: fixture: no space for payload; nothing asked", err.getvalue())

    def test_post_start_io_errors_require_reconciliation(self) -> None:
        script = self.write("fleet-worker.sh", "#!/bin/sh\nprintf '%s\\n' started >&2\nprintf '%s\\n' '{}'\n")
        os.chmod(script, 0o755)
        cfg = load_config(script, {"HOME": "/nowhere"})
        requests = self.write("r.txt", message(block("a", checkout="/wt")))

        for fault in ("relay", "seek", "read", "persistent relay"):
            with self.subTest(fault=fault), tempfile.TemporaryFile() as captured:
                problem = OSError(errno.EIO, f"fixture: {fault}")
                err, out = io.StringIO(), io.StringIO()
                spool = mock.MagicMock(wraps=captured)
                spool.__enter__.return_value = spool
                if fault in ("seek", "read"):
                    getattr(spool, fault).side_effect = problem

                def write_stderr(text: str) -> int:
                    if fault == "persistent relay" or (fault == "relay" and text == "started\n"):
                        raise problem
                    return err.write(text)

                stream = mock.Mock(wraps=err)
                stream.write.side_effect = write_stderr
                msg = os.path.join(self.dir, "assignment.txt")
                resend = mock.Mock(return_value=0)
                with (mock.patch.object(tempfile, "TemporaryFile", return_value=spool),
                      mock.patch.object(execution, "listing", return_value=Done(0, "[]")),
                      mock.patch.object(assign, "record_placement") as placement,
                      contextlib.redirect_stdout(out), contextlib.redirect_stderr(stream)):
                    rc = cmd_assign(cfg, [self.base, requests, "--message", msg, "--unstick", "box", "w"], resend=resend)
                stream.write.assert_any_call("started\n")
                self.assertEqual((rc, out.getvalue()), (4, ""))
                placement.assert_not_called()
                resend.assert_not_called()
                self.assertFalse(os.path.exists(msg))
                self.assertNotIn("nothing asked", err.getvalue())
                if fault != "persistent relay":
                    self.assertIn("ASSIGN UNKNOWN a: the run's outcome is unknown", err.getvalue())
                    self.assertIn(f"fixture: {fault}", err.getvalue())
                    self.assertIn("reconcile it, never retry it blind", err.getvalue())

    def test_persistent_stderr_failure_preserves_exit_4_at_shutdown(self) -> None:
        script = self.write("fleet-worker.sh", "#!/bin/sh\nprintf '%s\\n' started >&2\n")
        os.chmod(script, 0o755)
        requests = self.write("r.txt", message(block("a")))
        run = subprocess.run([sys.executable, "-c", """
import os
import sys
from unittest.mock import patch
from ludics import cli
from ludics.fleetworker import assign, execution
from ludics.fleetworker.config import load_config
from ludics.fleetworker.transport import Done

reader, writer = os.pipe()
os.close(reader)
sys.stderr = os.fdopen(writer, "w", buffering=4096)
cfg = load_config(sys.argv[1], {"HOME": "/nowhere"})
with patch.object(execution, "listing", return_value=Done(0, "[]")):
    rc = cli.main_guard("fleet-worker.sh", lambda args: assign.cmd_assign(cfg, args), sys.argv[2:])
sys.exit(rc)
""", script, self.base, requests], capture_output=True, text=True, timeout=10)
        self.assertEqual((run.returncode, run.stdout), (4, ""), run.stderr)

    def test_a_steps_progress_reaches_the_reader_while_the_step_is_still_waiting(self) -> None:
        progress = "waiting for the window gap"
        release = os.path.join(self.dir, "saw-progress")
        script = self.write("fleet-worker.sh", "#!/bin/sh\n"
                            f"printf '%s\\n' {shlex.quote(progress)} >&2\n"
                            "for attempt in 1 2 3 4 5 6 7 8 9 10; do\n"
                            f"  if [ -f {shlex.quote(release)} ]; then printf '%s\\n' pending; exit 3; fi\n"
                            "  sleep 0.1\n"
                            "done\n"
                            "exit 9\n")
        os.chmod(script, 0o755)

        class Reader(io.StringIO):
            def write(self, text: str, /) -> int:
                if progress in text:
                    with open(release, "w"):
                        pass
                return super().write(text)

        with contextlib.redirect_stderr(Reader()):
            answer = assign.step(load_config(script, {"HOME": "/nowhere"}), ["execution", "window"], block("m"))
        self.assertEqual((answer.rc, answer.out), (3, "pending\n"))

    def test_action_required_survives_other_refusals_and_assignments_unless_the_outcome_is_unknown(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("b"), block("c")))
        answers = {"a": StepResult(5, "", "push the branch"), "b": StepResult(1, ""), "c": StepResult(0, "{}")}
        rc, out, err = self.assign([self.base, requests], answers)
        self.assertEqual(rc, 5)
        self.assertEqual([line for line in out.splitlines() if line.startswith("EXECUTION_ASSIGNED")],
                         ["EXECUTION_ASSIGNED c"])
        self.assertEqual(err.splitlines()[-1], "ASSIGN ACTION REQUIRED a: push the branch")
        rc, _, err = self.assign([self.base, requests], {**answers, "b": StepResult(4, "")})
        self.assertEqual(rc, 4)
        self.assertNotIn("ASSIGN ACTION REQUIRED", err)

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
        self.assertEqual(self.assign(args, {"a": StepResult(0, "{}"), "b": StepResult(0, "{}")} )[0], 0)
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
        rc, out, err = self.assign([self.base, requests], {"a": StepResult(0, "{}")})
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
        def call(_cfg: Config, _verb: Sequence[str], _payload: dict[str, Any]) -> StepResult:
            return StepResult(0, "{}")

        out, err = io.StringIO(), io.StringIO()
        with (mock.patch.object(execution, "listing", return_value=Done(0, json.dumps(records))),
              mock.patch.object(assign, "record_placement", side_effect=[cli.Exit(2, "no coordinator identity"), 0]),
              contextlib.redirect_stdout(out), contextlib.redirect_stderr(err)):
            rc = cmd_assign(self.cfg, [self.base, requests], call=call)
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
        self.assign([self.base, requests], {"a": StepResult(1, ""), "b": StepResult(4, ""), "c": StepResult(0, "{}")})
        self.assertEqual(self.placements, [])

    def test_a_refused_window_alone_prints_nothing(self) -> None:
        requests = self.write("r.txt", message(block("m", kind="measurement")))
        msg = os.path.join(self.dir, "msg.txt")
        rc, out, _ = self.assign([self.base, requests, "--message", msg, "--unstick", "box", "w"], {"m": StepResult(1, "")})
        self.assertEqual((rc, out), (1, ""))
        self.assertFalse(os.path.exists(msg), "a call that assigns nothing writes no message")
        self.assertEqual(self.unsticks, [], "and unsticks nothing")

    def test_a_retry_assigns_nothing_twice(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("b", host="tuf")))
        records = [{"request_id": "a", "state": "launching"}, {"request_id": "b", "state": "reserved"}]
        rc, out, err = self.assign([self.base, requests], {"b": StepResult(0, "{}")}, records)
        self.assertEqual(rc, 0)
        self.assertIn("ASSIGN ALREADY a: the registry holds it launching", err)
        self.assertNotIn("EXECUTION_ASSIGNED a", out)
        self.assertIn("EXECUTION_ASSIGNED b", out, "a record still reserved is dispatched like a new one")
        self.assertEqual(self.calls, [["execution", "run", "b"]])

    def test_an_unknown_outcome_is_exit_4(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("h", requested_revision="head-of:x")))
        rc, out, err = self.assign([self.base, requests], {"a": StepResult(4, ""), "h": StepResult(0, "{}")})
        self.assertEqual(rc, 4)
        self.assertEqual(out, "")
        self.assertIn("ASSIGN UNKNOWN a: the run's outcome is unknown", err)
        self.assertIn("ASSIGN UNKNOWN h: dispatched, but no resolved_revision", err)

    def test_selection_and_the_cli_worker_unstick(self) -> None:
        requests = self.write("r.txt", message(block("a"), block("b", host="tuf")))
        msg = os.path.join(self.dir, "msg.txt")
        rc, out, _ = self.assign([self.base, requests, "--request", "b", "--message", msg, "--unstick", "box", "w"],
                                 {"b": StepResult(0, "{}")})
        self.assertEqual(rc, 0)
        self.assertEqual(self.calls, [["execution", "run", "b"]])
        with open(msg, encoding="utf-8") as f:
            self.assertEqual(f.read(), out)
        self.assertEqual(self.unsticks, [("box", "w", msg)])
        self.assertTrue(out.rstrip().endswith("Run only the 1 assignment above, and end your turn with one EXECUTION_RESULT line for each."))

    def test_a_failed_unstick_is_exit_4_naming_the_resend(self) -> None:
        requests = self.write("r.txt", message(block("a")))
        msg = os.path.join(self.dir, "msg.txt")
        rc, _, err = self.assign([self.base, requests, "--message", msg, "--unstick", "box", "w"], {"a": StepResult(0, "{}")},
                                 unstick_rc=1)
        self.assertEqual(rc, 4)
        self.assertIn(f"resend with: fleet-worker.sh unstick box w --message {msg} -- never assign again", err)

    def status(self, path: str) -> dict[str, Any]:
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_the_status_carries_the_unsticks_outcome_and_its_own_tally_lines_alone(self) -> None:
        """ludics#1234: a step's echoed BOARD TALLY line is relayed and never the status's; the unstick's are."""
        requests = self.write("r.txt", message(block("a")))
        msg, status = os.path.join(self.dir, "msg.txt"), os.path.join(self.dir, "status.json")
        echoed = "BOARD TALLY WARNING far/w: printed by the step\n"
        warning = "BOARD TALLY WARNING box/w: the unstick reached the worker, and its turn was not counted (board exit 1)"
        rc, _, err = self.assign([self.base, requests, "--message", msg, "--unstick", "box", "w", "--status", status], {"a": StepResult(0, "{}")},
                                 unstick_err=f"UNSTICKED box/w\n{warning}\n", step_err=echoed)
        self.assertEqual(rc, 0)
        self.assertIn("printed by the step", err)
        self.assertEqual(self.status(status), {"exit": 0, "unstick": "landed", "tally": [warning], "lease_lost": ""})
        rc, _, _ = self.assign([self.base, requests, "--message", msg, "--unstick", "box", "w", "--status", status],
                               {"a": StepResult(0, "{}")}, unstick_rc=1)
        self.assertEqual((rc, self.status(status)["unstick"]), (4, "failed"))
        rc, _, _ = self.assign([self.base, requests, "--message", msg, "--unstick", "box", "w", "--status", status],
                               {"a": StepResult(1, "")})
        self.assertEqual(self.status(status), {"exit": 1, "unstick": "nothing-assigned", "tally": [], "lease_lost": ""})
        rc, _, _ = self.assign([self.base, requests, "--message", os.path.join(self.dir, "no", "msg.txt"), "--unstick", "box", "w",
                                "--status", status], {"a": StepResult(0, "{}")})
        self.assertEqual((rc, self.status(status)["unstick"]), (4, "message-unwritten"))
        rc, _, _ = self.assign([self.base, requests, "--status", status], {"a": StepResult(0, "{}")})
        self.assertEqual(self.status(status), {"exit": 0, "unstick": "not-asked", "tally": [], "lease_lost": ""})

    def test_an_unwritable_status_is_a_note_above_the_action_required_summary(self) -> None:
        requests = self.write("r.txt", message(block("a")))
        status = os.path.join(self.dir, "no", "status.json")
        rc, _, err = self.assign([self.base, requests, "--status", status], {"a": StepResult(ASSIGN_ACTION_REQUIRED, "", "bad id")})
        self.assertEqual(rc, ASSIGN_ACTION_REQUIRED)
        self.assertIn("ASSIGN STATUS NOTE: the status could not be written to", err)
        self.assertTrue(err.rstrip("\n").rpartition("\n")[2].startswith("ASSIGN ACTION REQUIRED a: bad id"), err)

    def test_a_lost_lease_is_its_own_exit_from_a_step_a_placement_or_the_unstick(self) -> None:
        """ludics#1234: LEASE_LOST_STATUS from any gated call is assign's exit, over every other outcome, and the status
        names the call; a lost lease sends the worker nothing."""
        lost = 6  # lease.LEASE_LOST_STATUS, spelled out so the base fails on the outcome rather than the name
        self.assertEqual(assign.LEASE_LOST_STATUS, lost)
        requests = self.write("r.txt", message(block("a"), block("b", host="tuf"), block("c", checkout="/w/c")))
        msg, status = os.path.join(self.dir, "msg.txt"), os.path.join(self.dir, "status.json")
        args = [self.base, requests, "--message", msg, "--unstick", "box", "w", "--status", status]
        rc, out, err = self.assign(args, {"a": StepResult(0, "{}"), "b": StepResult(lost, ""), "c": StepResult(4, "")})
        self.assertEqual(rc, lost)
        self.assertIn("EXECUTION_ASSIGNED a\n", out)
        self.assertIn("ASSIGN LEASE LOST b: the run was refused on the lease (above); nothing assigned", err)
        self.assertIn("ASSIGN UNSTICK SKIPPED: the lease was lost (the run of b)", err)
        self.assertEqual(self.unsticks, [])
        self.assertEqual(self.status(status), {"exit": lost, "unstick": "lease-lost", "tally": [], "lease_lost": "the run of b"})
        self.placement_rc = lost
        rc, _, err = self.assign(args, {"a": StepResult(0, "{}"), "b": StepResult(0, "{}"), "c": StepResult(0, "{}")})
        self.assertEqual((rc, self.status(status)["lease_lost"]), (lost, "the placement of c"))
        self.assertIn("ASSIGN LEASE LOST c: its placement write was refused on the lease (above)", err)
        self.placement_rc = 0
        rc, _, _ = self.assign(args, {"a": StepResult(0, "{}"), "b": StepResult(0, "{}"), "c": StepResult(0, "{}")}, unstick_rc=lost)
        self.assertEqual(rc, lost)
        self.assertEqual(self.status(status), {"exit": lost, "unstick": "failed", "tally": [], "lease_lost": "the unstick of box/w"})
        # An exit 1 or 5 whose diagnostic quotes a lease refusal is that exit: assign reads statuses, never words.
        quoted = StepResult(ASSIGN_ACTION_REQUIRED, "EXECUTION REFUSED fleet: coordinator lease held by other -- not you\n")
        rc, _, _ = self.assign([self.base, requests, "--status", status], {"a": quoted, "b": StepResult(1, ""), "c": StepResult(0, "{}")})
        self.assertEqual((rc, self.status(status)["lease_lost"]), (ASSIGN_ACTION_REQUIRED, ""))

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

        def call(_cfg: Config, _verb: Sequence[str], _payload: dict[str, Any]) -> StepResult:
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
