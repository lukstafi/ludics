"""Fleet lease readiness, lease transactions and write-side ownership checks."""

import concurrent.futures
import contextlib
import io
import json
import os
import stat
import subprocess
import sys
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

    def ps_answer(self, *lines: str, rc: int = 0) -> proc.Completed:
        rows = lines or ("    1 Ss   /sbin/init",)
        return proc.Completed(rc, "\n".join(rows) + "\n", "")

    def report(
        self,
        *answers: proc.Completed,
        args: list[str] | None = None,
        boxes: str = "second first",
        env: dict[str, str] | None = None,
    ) -> tuple[int, str, str, mock.MagicMock]:
        out, err = io.StringIO(), io.StringIO()
        patch_env = {"FLEET_BOXES": boxes, "FLEET_LOCAL_BOX": "caller"}
        if env:
            patch_env.update(env)
        with (
            mock.patch.dict(os.environ, patch_env),
            mock.patch.object(proc, "run_tool", side_effect=answers) as calls,
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            rc = cli.main_guard("pr-review.sh", leasepreflight.run, ["owner/name"] if args is None else args)
        self.assertEqual(calls.call_count, len(answers))
        return rc, out.getvalue(), err.getvalue(), calls

    def test_agreeing_boxes_report_reader_directory_and_clean_processes(self) -> None:
        rc, out, err, calls = self.report(self.answer(), self.ps_answer(), self.answer(), self.ps_answer())
        self.assertEqual((rc, err), (0, ""))
        for call_args, box in zip(calls.call_args_list, ("first", "first", "second", "second"), strict=True):
            self.assertIn(box, call_args.args[1])
        for box in ("first", "second"):
            self.assertIn(f"{box}: reader accepts lease fleet", out)
            self.assertIn("in-flight merges: none", out)
        self.assertEqual(out.count("path='/var/fleet state' device=7 inode=42"), 2)
        self.assertIn(leasepreflight.SNAPSHOT_LIMIT, out)
        self.assertIn("all 2 checked box(es)", out)

    def test_reader_disagreement_refuses(self) -> None:
        rc, out, err, _ = self.report(self.answer(), self.ps_answer(), self.answer(accepted=False), self.ps_answer())
        self.assertEqual(rc, 1)
        self.assertIn("second: reader rejects lease fleet", out)
        self.assertIn("could not verify all prerequisites", err)

    def test_anchor_disagreement_refuses(self) -> None:
        for disagrees in (self.answer(inode=43), self.answer(endpoint="other-anchor")):
            with self.subTest(disagrees=disagrees):
                rc, out, err, _ = self.report(self.answer(), self.ps_answer(), disagrees, self.ps_answer())
                self.assertEqual(rc, 1)
                self.assertIn("second: reader accepts lease fleet", out)
                self.assertIn("boxes resolve different anchor directories", err)

    def test_unreachable_box_or_anchor_refuses(self) -> None:
        # Unreachable box skips the second (process) probe; unreachable anchor still scans processes.
        rc, out, err, _ = self.report(self.answer(), self.ps_answer(), proc.Completed(255, "", ""))
        self.assertEqual(rc, 1)
        self.assertIn("second: unreachable (exit 255)", out)
        self.assertIn("could not verify all prerequisites", err)

        rc, out, err, _ = self.report(self.answer(), self.ps_answer(), self.answer(anchor_rc=124), self.ps_answer())
        self.assertEqual(rc, 1)
        self.assertIn("second: reader accepts lease fleet, anchor anchor unreachable (exit 124); in-flight merges: none", out)
        self.assertIn("could not verify all prerequisites", err)

    def test_fake_boxes_report_in_flight_merge_and_unreachable_box_without_acquiring(self) -> None:
        from ludics.fleetworker import mergelease as anchor_lease

        busy_ps = self.ps_answer(
            "    1 Ss   /sbin/init",
            " 4201 S    /bin/bash /home/u/ludics/ship-pr/scripts/pr-review.sh merge owner/name#2305 --wait",
            " 4202 S    /usr/bin/python3 -B -X utf8 -P -m ludics.prreview merge owner/name#2305 --wait",
        )
        with (
            mock.patch.object(mergelease, "MergeLease", side_effect=AssertionError("lease must not be acquired")) as client_lease,
            mock.patch.object(anchor_lease, "change", side_effect=AssertionError("anchor lease must not be mutated")) as anchor_mut,
        ):
            rc, out, err, _ = self.report(
                self.answer(), busy_ps,
                self.answer(), self.ps_answer(),
                proc.Completed(255, "", ""),
                boxes="down-box busy-box clean-box",
            )
        self.assertEqual(rc, 1)
        self.assertEqual(client_lease.call_count, 0)
        self.assertEqual(anchor_mut.call_count, 0)
        self.assertIn("busy-box: reader accepts lease fleet", out)
        self.assertIn("in-flight merges: 2", out)
        self.assertIn("  busy-box pid=4201: /bin/bash /home/u/ludics/ship-pr/scripts/pr-review.sh merge owner/name#2305 --wait", out)
        self.assertIn("  busy-box pid=4202: /usr/bin/python3 -B -X utf8 -P -m ludics.prreview merge owner/name#2305 --wait", out)
        self.assertIn("clean-box: reader accepts lease fleet", out)
        self.assertIn("clean-box: reader accepts lease fleet, anchor anchor host=anchor.host path='/var/fleet state' device=7 inode=42; in-flight merges: none", out)
        self.assertIn("down-box: unreachable (exit 255)", out)
        self.assertIn(leasepreflight.SNAPSHOT_LIMIT, out)
        self.assertIn("one or more recognizable ship-pr merge processes are in flight", err)
        self.assertIn("one or more boxes could not verify all prerequisites", err)

    def test_broken_or_timed_out_reader_still_reports_in_flight_merges_on_reachable_box(self) -> None:
        busy_ps = self.ps_answer("  812 S    /home/u/.claude/skills/ship-pr/scripts/pr-review.sh merge owner/name#9")
        cases = (
            (proc.Completed(1, "", ""), "old-box: reader probe failed (exit 1); in-flight merges: 1"),
            (proc.Completed(124, "", ""), "old-box: reader probe timed out (exit 124); in-flight merges: 1"),
        )
        for reader_reply, expected in cases:
            with self.subTest(expected=expected):
                rc, out, err, _ = self.report(reader_reply, busy_ps, boxes="old-box")
                self.assertEqual(rc, 1)
                self.assertIn(expected, out)
                self.assertIn("  old-box pid=812: /home/u/.claude/skills/ship-pr/scripts/pr-review.sh merge owner/name#9", out)
                self.assertIn("one or more recognizable ship-pr merge processes are in flight", err)
                self.assertIn("one or more boxes could not verify all prerequisites", err)

    def test_anchor_mismatch_is_still_reported_when_one_process_probe_fails(self) -> None:
        rc, out, err, _ = self.report(
            self.answer(inode=42), self.ps_answer(),
            self.answer(inode=43), proc.Completed(1, "", ""),
        )
        self.assertEqual(rc, 1)
        self.assertIn("second: reader accepts lease fleet", out)
        self.assertIn("process probe failed (exit 1)", out)
        self.assertIn("boxes resolve different anchor directories", err)
        self.assertIn("one or more boxes could not verify all prerequisites", err)

    def test_env_assignments_are_omitted_from_reported_merge_command(self) -> None:
        secret_ps = self.ps_answer(
            "    1 Ss   /sbin/init",
            " 5100 S    env GH_TOKEN=ghp_supersecret123 REPO=owner/name /home/u/pr-review.sh merge 7 --wait",
        )
        rc, out, err, _ = self.report(self.answer(), secret_ps, boxes="first")
        self.assertEqual(rc, 1)
        self.assertIn("  first pid=5100: /home/u/pr-review.sh merge 7 --wait", out)
        self.assertNotIn("ghp_supersecret123", out)
        self.assertNotIn("GH_TOKEN", out)
        self.assertNotIn("ghp_supersecret123", err)

    def test_process_probe_failures_and_unreadable_listings_refuse_fail_closed(self) -> None:
        cases = (
            (proc.Completed(1, "", ""), "process probe failed (exit 1)"),
            (proc.Completed(124, "", ""), "process probe unreachable (exit 124)"),
            (proc.Completed(0, "", ""), "unrecognized process listing"),
            (proc.Completed(0, "not a ps row\n", ""), "unrecognized process listing"),
            (proc.Completed(0, " 4102 /usr/bin/python3 -m ludics.prreview merge owner/name#7\n", ""), "unrecognized process listing"),
            (proc.Completed(0, "    1 Ss\n    2 S\n", ""), "unrecognized process listing"),
            (proc.Completed(0, "  101 Z+   <defunct>\n", ""), "unrecognized process listing"),
        )
        for ps_reply, expected in cases:
            with self.subTest(expected=expected):
                rc, out, err, _ = self.report(self.answer(), ps_reply, boxes="first")
                self.assertEqual(rc, 1)
                self.assertIn(f"first: reader accepts lease fleet", out)
                self.assertIn(expected, out)
                self.assertIn("could not verify all prerequisites", err)

    def test_recognized_merge_argv_forms_and_near_misses(self) -> None:
        recognized = (
            "pr-review.sh merge owner/name#7",
            "/Users/u/.claude/skills/ship-pr/scripts/pr-review.sh merge owner/name#7 --wait",
            "/Users/u/ludics/ship-pr/scripts/pr-review.sh --repo owner/name merge 7",
            "/Users/u/ludics/ship-pr/scripts/pr-review.sh --repo=owner/name merge 7",
            "/Users/u/ludics/ship-pr/scripts/pr-review.sh --repo= merge owner/name#7",
            "/bin/bash /Users/u/ludics/ship-pr/scripts/pr-review.sh merge owner/name#7",
            "bash -euo pipefail /Users/u/ludics/ship-pr/scripts/pr-review.sh --repo owner/name merge 7",
            "/usr/bin/env bash /Users/u/ludics/ship-pr/scripts/pr-review.sh merge owner/name#7",
            "env REPO=owner/name -u DEBUG /Users/u/ludics/ship-pr/scripts/pr-review.sh merge 7",
            "/Users/u/ludics/scripts/py -m ludics.prreview merge owner/name#7 --wait",
            "/Users/u/ludics/scripts/py -m ludics.prreview --repo= merge owner/name#7 --wait",
            "bash /Users/u/ludics/scripts/py -m ludics.prreview --repo owner/name merge 7",
            "/opt/homebrew/Cellar/python@3.15/3.15.2/Frameworks/Python.framework/Versions/3.15/Resources/Python.app/Contents/MacOS/Python -B -X utf8 -P -m ludics.prreview merge owner/name#7 --wait",
            "/usr/bin/python3.12 -B -X utf8 -P -m ludics.prreview --repo=owner/name merge 7",
            "python3 -BPmludics.prreview merge 7",
            "env -i PATH=/usr/bin python3 -Xutf8 -Wignore -m ludics.prreview merge 7",
        )
        for cmd in recognized:
            with self.subTest(recognized=cmd):
                self.assertTrue(leasepreflight.is_merge_argv(cmd.split()))

        near_misses = (
            "pr-review.sh merge-build --base a --head b",
            "pr-review.sh lease-preflight owner/name",
            "pr-review.sh comment owner/name#1 pr-review.sh merge",
            "pr-review.sh --repo merge",
            "python3 -m ludics.prreview status owner/name#7",
            "python3 -m ludics.prreview merge-build --base a --head b",
            "python3 -c ludics.prreview merge",
            "python3 -X -m ludics.prreview merge 7",
            "bash -c pr-review.sh merge owner/name#7",
            "bash -s -- pr-review.sh merge owner/name#7",
            "env -u pr-review.sh merge owner/name#7",
            "grep pr-review.sh merge README.md",
            "/Users/u/ludics/scripts/other.py -m ludics.prreview merge 7",
        )
        for cmd in near_misses:
            with self.subTest(near_miss=cmd):
                self.assertFalse(leasepreflight.is_merge_argv(cmd.split()))

        # Zombies/dead are not in flight; Linux `P` (parked) and macOS transient `?`/`?+`/`?E` states are valid rows.
        parsed = leasepreflight.parse_merge_processes(
            "  101 Z+   /bin/bash /u/pr-review.sh merge owner/name#7\n"
            "  102 X\n"
            "  103 ?+   (bash)\n"
            "  104 ?E   (sh)\n"
            "  105 P    [cpuhp/1]\n"
            "  106 S    /sbin/init\n"
        )
        self.assertEqual(parsed, [])
        transient_merge = leasepreflight.parse_merge_processes(
            "  107 ?+   /bin/bash /u/pr-review.sh merge owner/name#8\n"
        )
        self.assertEqual(transient_merge, [leasepreflight.MergeProcess(107, "/bin/bash /u/pr-review.sh merge owner/name#8")])

    def test_cross_timeout_validation_and_forwarding(self) -> None:
        for bad in ("0", "-5", "abc"):
            with self.subTest(bad=bad):
                rc, _, err, _ = self.report(env={"FLEET_CROSS_TIMEOUT": bad}, boxes="first")
                self.assertEqual(rc, 2)
                self.assertIn("FLEET_CROSS_TIMEOUT", err)

        rc, _, _, calls = self.report(self.answer(), self.ps_answer(), boxes="first", env={"FLEET_CROSS_TIMEOUT": "7"})
        self.assertEqual(rc, 0)
        self.assertEqual(calls.call_args_list[0].kwargs["timeout"], 14)
        self.assertIn("7", calls.call_args_list[0].args[1][-1])
        self.assertEqual(calls.call_args_list[1].kwargs["timeout"], 7)

    def test_malformed_anchor_is_no_evidence(self) -> None:
        invalid = json.dumps([True, "anchor", 0, json.dumps(["anchor.host", "/state", True, 42])])
        rc, out, _, _ = self.report(self.answer(), self.ps_answer(), proc.Completed(0, invalid, ""), self.ps_answer())
        self.assertEqual(rc, 1)
        self.assertIn("unrecognized directory reply", out)

    def test_empty_box_override_refuses_before_transport(self) -> None:
        rc, _, err, _ = self.report(args=["owner/name", "--boxes"])
        self.assertEqual(rc, 2)
        self.assertIn("usage:", err)

    def local_report(
        self, home: Path, state_path: str, *, isolate_ps: bool = True, overrides: dict[str, str] | None = None,
    ) -> tuple[int, str, str]:
        skills = home / ".claude" / "skills"
        skills.mkdir(parents=True, exist_ok=True)
        checkout = Path(__file__).resolve().parents[3]
        link = skills / "ship-pr"
        if not link.exists():
            link.symlink_to(checkout / "ship-pr", target_is_directory=True)
        env = {
            "HOME": str(home), "FLEET_ANCHOR": "local", "FLEET_LOCAL_BOX": "caller",
            "FLEET_ANCHOR_STATE": state_path, "LUDICS_PY_CANDIDATES": sys.executable,
        }
        if isolate_ps:
            fake_bin = home / "fake-bin"
            fake_bin.mkdir(exist_ok=True)
            fake_ps = fake_bin / "ps"
            fake_ps.write_text("#!/bin/sh\nprintf '    1 Ss   /sbin/init\\n'\n", encoding="utf-8")
            fake_ps.chmod(stat.S_IRWXU)
            env["PATH"] = f"{fake_bin}:{os.environ.get('PATH', '')}"
        with (
            mock.patch.dict(os.environ, env),
            contextlib.redirect_stdout(io.StringIO()) as out,
            contextlib.redirect_stderr(io.StringIO()) as err,
        ):
            os.environ.pop("FLEET_REGISTRY_PIN", None)
            if overrides:
                os.environ.update(overrides)
            rc = cli.main_guard("pr-review.sh", leasepreflight.run, ["owner/name", "--boxes", "caller"])
        return rc, out.getvalue(), err.getvalue()

    @unittest.skipUnless(os.name == "posix", "the served lease reader is POSIX")
    def test_local_probe_runs_the_served_parser_and_only_reads_anchor_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / "fleet state"
            state.mkdir()
            alias = home / "alias"
            alias.symlink_to(state, target_is_directory=True)
            rc, out, _ = self.local_report(home, "$HOME/alias")
            self.assertEqual(rc, 0)
            info = state.stat()
            self.assertIn(f"path='{state.resolve()}' device={info.st_dev} inode={info.st_ino}", out)
            self.assertIn("in-flight merges: none", out)
            self.assertEqual(list(state.iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "the served lease reader is POSIX")
    def test_local_probe_detects_live_merge_process_with_real_ps(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / "state"
            state.mkdir()
            dummy = home / "pr-review.sh"
            dummy.write_text("#!/bin/sh\nread _\n", encoding="utf-8")
            dummy.chmod(stat.S_IRWXU)
            child = subprocess.Popen(
                ["/bin/sh", "./pr-review.sh", "merge", "owner/name#2305", "--wait"],
                cwd=home,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                rc, out, err = self.local_report(home, str(state), isolate_ps=False)
            finally:
                if child.stdin is not None:
                    child.stdin.close()
                child.terminate()
                child.wait(timeout=5)
            self.assertEqual(rc, 1)
            self.assertIn(f"caller pid={child.pid}:", out)
            self.assertIn("./pr-review.sh merge owner/name#2305 --wait", out)
            self.assertIn(leasepreflight.SNAPSHOT_LIMIT, out)
            self.assertIn("one or more recognizable ship-pr merge processes are in flight", err)
            self.assertEqual(list(state.iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "the served lease reader is POSIX")
    def test_relative_anchor_cannot_agree_from_the_current_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            rc, out, _ = self.local_report(Path(directory), ".")
            self.assertEqual(rc, 1)
            self.assertIn("state path must be absolute", out)

    @unittest.skipUnless(os.name == "posix", "the served lease reader is POSIX")
    def test_anchor_config_refusals_identify_the_pin_or_name(self) -> None:
        cases = (
            ({"FLEET_REGISTRY_PIN": '["other", "/other"]'}, "anchor caller differs from the fleet registry pin"),
            ({"FLEET_ANCHOR": "user@host"}, "anchor user@host must be a plain fleet name"),
        )
        for env, diagnostic in cases:
            with self.subTest(env=env), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                rc, out, _ = self.local_report(home, str(home), overrides=env)
                self.assertEqual(rc, 1)
                self.assertIn(f"reader accepts lease fleet, {diagnostic}", out)


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
            "pr-review.sh: owner/name#7: merge lease release acknowledged on local",
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
        self.assertNotIn("merge lease release acknowledged", log.getvalue())

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
