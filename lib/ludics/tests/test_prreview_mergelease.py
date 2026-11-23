"""Merge lease transactions and write-side ownership checks (#1269)."""

import concurrent.futures
import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from ludics import cli, proc
from ludics.prreview import leasepreflight, mergelease
from ludics.prreview.budget import Budget
from ludics.prreview.clock import FuncClock
from ludics.prreview.core import GhSession, load_config
from ludics.tests.fake import Answer, FakeTool


class LeasePreflight(unittest.TestCase):
    def answer(
        self, *, accepted: bool = True, endpoint: str = "anchor", inode: int = 42,
        anchor_rc: int = 0,
    ) -> proc.Completed:
        identity = json.dumps(["anchor.host", "/var/fleet state", 7, inode])
        return proc.Completed(0, json.dumps([accepted, endpoint, anchor_rc, identity]), "")

    def report(self, *answers: proc.Completed, args: list[str] | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.dict(os.environ, {"FLEET_BOXES": "second first", "FLEET_LOCAL_BOX": "caller"}),
            mock.patch.object(proc, "run_tool", side_effect=answers) as calls,
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            rc = cli.main_guard("pr-review.sh", leasepreflight.run, ["owner/name"] if args is None else args)
        self.assertEqual(calls.call_count, len(answers))
        for call_args, box in zip(calls.call_args_list, ("first", "second"), strict=False):
            self.assertIn(box, call_args.args[1])
        return rc, out.getvalue(), err.getvalue()

    def test_agreeing_boxes_report_reader_and_directory(self) -> None:
        rc, out, err = self.report(self.answer(), self.answer())
        self.assertEqual((rc, err), (0, ""))
        for box in ("first", "second"):
            self.assertIn(f"{box}: reader accepts lease fleet", out)
        self.assertEqual(out.count("path='/var/fleet state' device=7 inode=42"), 2)
        self.assertIn("all 2 checked box(es)", out)

    def test_reader_disagreement_refuses(self) -> None:
        rc, out, err = self.report(self.answer(), self.answer(accepted=False))
        self.assertEqual(rc, 1)
        self.assertIn("second: reader rejects lease fleet", out)
        self.assertIn("could not verify both prerequisites", err)

    def test_anchor_disagreement_refuses(self) -> None:
        for disagrees in (self.answer(inode=43), self.answer(endpoint="other-anchor")):
            with self.subTest(disagrees=disagrees):
                rc, out, err = self.report(self.answer(), disagrees)
                self.assertEqual(rc, 1)
                self.assertIn("second: reader accepts lease fleet", out)
                self.assertIn("boxes resolve different anchor directories", err)

    def test_unreachable_box_or_anchor_refuses(self) -> None:
        outcomes = (
            (proc.Completed(255, "", ""), "second: unreachable"),
            (self.answer(anchor_rc=124), "second: reader accepts lease fleet, anchor anchor unreachable"),
        )
        for answer, diagnostic in outcomes:
            with self.subTest(diagnostic=diagnostic):
                rc, out, err = self.report(self.answer(), answer)
                self.assertEqual(rc, 1)
                self.assertIn(diagnostic, out)
                self.assertIn("could not verify both prerequisites", err)

    def test_malformed_anchor_is_no_evidence(self) -> None:
        invalid = json.dumps([True, "anchor", 0, json.dumps(["anchor.host", "/state", True, 42])])
        rc, out, _ = self.report(self.answer(), proc.Completed(0, invalid, ""))
        self.assertEqual(rc, 1)
        self.assertIn("unrecognized directory reply", out)

    def test_empty_box_override_refuses_before_transport(self) -> None:
        rc, _, err = self.report(args=["owner/name", "--boxes"])
        self.assertEqual(rc, 2)
        self.assertIn("usage:", err)

    @unittest.skipUnless(os.name == "posix", "the served lease reader is POSIX")
    def test_local_probe_runs_the_served_parser_and_only_reads_anchor_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            skills = home / ".claude" / "skills"
            skills.mkdir(parents=True)
            checkout = Path(__file__).resolve().parents[3]
            (skills / "ship-pr").symlink_to(checkout / "ship-pr", target_is_directory=True)
            state = home / "fleet state"
            state.mkdir()
            alias = home / "alias"
            alias.symlink_to(state, target_is_directory=True)
            with (
                mock.patch.dict(os.environ, {
                    "HOME": str(home), "FLEET_ANCHOR": "local", "FLEET_LOCAL_BOX": "caller",
                    "FLEET_ANCHOR_STATE": "$HOME/alias",
                }),
                contextlib.redirect_stdout(io.StringIO()) as out,
            ):
                os.environ.pop("FLEET_REGISTRY_PIN", None)
                rc = leasepreflight.run(["owner/name", "--boxes", "caller"])
            self.assertEqual(rc, 0)
            info = state.stat()
            self.assertIn(f"path='{state.resolve()}' device={info.st_dev} inode={info.st_ino}", out.getvalue())
            self.assertEqual(list(state.iterdir()), [])


@unittest.skipUnless(os.name == "posix", "the lease anchor is POSIX")
class AnchorLease(unittest.TestCase):
    def test_expiry_allows_takeover_and_fences_the_previous_owner(self) -> None:
        from ludics.fleetworker import mergelease as anchor

        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old, new = "1" * 32, "2" * 32
            with mock.patch.object(anchor.time, "time", return_value=100):
                self.assertEqual(anchor.change(state, "take", "OWNER/name", old, "7", 120), "taken")
            with mock.patch.object(anchor.time, "time", return_value=219):
                self.assertEqual(anchor.change(state, "take", "owner/NAME", new, "8", 120), "held\t7")
            with mock.patch.object(anchor.time, "time", return_value=220):
                self.assertEqual(anchor.change(state, "renew", "owner/name", old, "7", 120), "lost")
                self.assertEqual(anchor.change(state, "take", "owner/name", new, "8", 120), "taken\t7")
                self.assertEqual(anchor.change(state, "release", "owner/name", old, "7", 120), "released")
                self.assertEqual(anchor.change(state, "take", "owner/name", old, "7", 120), "held\t8")
                self.assertEqual(anchor.change(state, "renew", "owner/name", new, "8", 120), "renewed")

    def test_contenders_serialize_for_one_repository(self) -> None:
        from ludics.fleetworker import mergelease as anchor

        with tempfile.TemporaryDirectory() as directory, concurrent.futures.ThreadPoolExecutor(2) as pool:
            start = threading.Barrier(2)

            def take(pr: str) -> str:
                start.wait(timeout=5)
                return anchor.change(Path(directory), "take", "owner/name", pr * 32, pr, 120)

            replies = list(pool.map(take, ("7", "8")))
            self.assertEqual(replies.count("taken"), 1)
            self.assertIn(replies, (["taken", "held\t7"], ["held\t8", "taken"]))
            self.assertEqual(anchor.change(Path(directory), "take", "owner/other", "1" * 32, "9", 120), "taken")


class ClientLease(unittest.TestCase):
    def setUp(self) -> None:
        self.enterContext(mock.patch.dict(os.environ, {"FLEET_ANCHOR": "local"}))
        os.environ.pop("FLEET_REGISTRY_PIN", None)

    def test_wait_exhaustion_refuses_before_entering_the_gate(self) -> None:
        elapsed = 0.0

        def advance(seconds: float) -> None:
            nonlocal elapsed
            elapsed += seconds

        clock = FuncClock(time=lambda: elapsed, sleep=advance)
        lease = mergelease.MergeLease("owner/name", "7")
        with (
            mock.patch.object(mergelease, "WAIT", 10),
            mock.patch.object(lease, "_call", return_value="held\t8\n") as call,
            self.assertRaises(cli.Exit) as refused,
            lease.held(clock),
        ):
            self.fail("the busy lease let a new holder in")
        self.assertEqual(refused.exception.rc, 1)
        self.assertIn("merge lease wait ran out after 10s", refused.exception.message)
        self.assertIn("held by owner/name#8", refused.exception.message)
        self.assertEqual(call.call_args_list, [mock.call("take", timeout=10), mock.call("take", timeout=5)])

    def test_a_bad_acquisition_reply_cannot_enter_the_gate(self) -> None:
        lease = mergelease.MergeLease("owner/name", "7")
        with (
            mock.patch.object(lease, "_call", return_value="taken\nunexpected\n"),
            self.assertRaises(cli.Exit) as refused,
            lease.held(FuncClock()),
        ):
            self.fail("an unrecognized lease answer let a holder in")
        self.assertEqual(refused.exception.rc, 3)
        self.assertIn("unrecognized answer", refused.exception.message)

    def test_a_lost_lease_refuses_a_new_write_and_releases_on_exit(self) -> None:
        lease = mergelease.MergeLease("owner/name", "7")
        with (
            mock.patch.object(lease, "_call", side_effect=["taken\n", "lost\n", "released\n"]) as call,
            contextlib.redirect_stderr(io.StringIO()) as log,
            self.assertRaises(cli.Exit) as refused,
            lease.held(FuncClock()),
        ):
            lease.verify()
            self.fail("the lost lease authorized a write")
        self.assertEqual(refused.exception.rc, 3)
        self.assertIn("merge lease ownership expired or was lost", refused.exception.message)
        self.assertEqual(call.call_args_list, [mock.call("take", timeout=20), mock.call("renew"), mock.call("release")])
        self.assertEqual(log.getvalue().splitlines(), [
            "pr-review.sh: owner/name#7: acquired merge lease on local",
            "pr-review.sh: owner/name#7: released merge lease on local",
        ])

    def test_an_unconfirmed_release_has_no_success_line(self) -> None:
        lease = mergelease.MergeLease("owner/name", "7")
        with (
            mock.patch.object(lease, "_call", side_effect=["taken\n", "unrecognized\n"]),
            contextlib.redirect_stderr(io.StringIO()) as log,
            lease.held(FuncClock()),
        ):
            pass
        self.assertIn("merge lease release was unconfirmed", log.getvalue())
        self.assertNotIn("released merge lease", log.getvalue())

    def test_an_unanswered_renewal_keeps_the_live_proof_and_can_recover(self) -> None:
        lease = mergelease.MergeLease("owner/name", "7")
        elapsed = mock.Mock(return_value=10.0)
        with (
            mock.patch.object(mergelease, "_lease_time", elapsed),
            mock.patch.object(lease, "_call", side_effect=[
                "taken\n", cli.Exit(3, "merge lease renew failed on local (exit 255)."), "renewed\n", "released\n",
            ]) as call,
            lease.held(FuncClock()),
        ):
            elapsed.return_value = 40.0
            lease.verify()
            elapsed.return_value = 70.0
            lease.verify()
            elapsed.return_value = 10.0 + mergelease.TTL
            lease.require_current()
        self.assertEqual(
            call.call_args_list, [mock.call("take", timeout=20), mock.call("renew"), mock.call("renew"), mock.call("release")],
        )

    def test_an_unanswered_renewal_after_expiry_names_the_anchor_failure(self) -> None:
        lease = mergelease.MergeLease("owner/name", "7")
        elapsed = mock.Mock(return_value=10.0)
        with (
            mock.patch.object(mergelease, "_lease_time", elapsed),
            mock.patch.object(lease, "_call", side_effect=[
                "taken\n", cli.Exit(3, "merge lease renew failed on local (exit 255)."), "released\n",
            ]),
            self.assertRaises(cli.Exit) as refused,
            lease.held(FuncClock()),
        ):
            elapsed.return_value = 10.0 + mergelease.TTL
            lease.verify()
        self.assertEqual(refused.exception.rc, 3)
        self.assertIn("Last renewal: merge lease renew failed on local (exit 255).", refused.exception.message)

    def test_a_lease_expiring_during_the_quota_gate_blocks_dispatch(self) -> None:
        args = ["pr", "merge", "7", "--repo", "owner/name"]
        for forwarded in (False, True):
            for resend in (False, True):
                with self.subTest(forwarded=forwarded, resend=resend), FakeTool("gh") as gh:
                    if resend:
                        gh.script(Answer(1, "", "gh: HTTP 503: No server is currently available to service your request\n"))
                    clock = mock.Mock(return_value=10.0)
                    lease = mergelease.MergeLease("owner/name", "7")
                    budget = mock.Mock(spec=Budget)

                    def quota_gate(_mode: str) -> None:
                        if not resend or budget.gate.call_count == 2:
                            clock.return_value = 10.0 + mergelease.TTL

                    budget.gate.side_effect = quota_gate
                    session = GhSession(load_config({}), sleep=lambda _seconds: None, budget=budget)
                    with (
                        mock.patch.object(mergelease, "_lease_time", clock),
                        mock.patch.object(lease, "_call", side_effect=["taken\n", "released\n"]),
                        self.assertRaises(cli.Exit) as refused,
                        lease.held(FuncClock()),
                    ):
                        lease.require_current()
                        if forwarded:
                            session.retry_caller("write", args, listed=False, budgeted=True, before_dispatch=lease.require_current)
                        else:
                            session.retry("write", args, before_dispatch=lease.require_current)
                    self.assertIn("merge lease ownership expired or was lost", refused.exception.message)
                    self.assertEqual(gh.calls(), [args] if resend else [])
