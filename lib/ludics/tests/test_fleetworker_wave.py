"""ludics.fleetworker.wave, wavebrief, waveprep, waveloop: the coordinator kit (ludics#1047). The
shell suite's "wave kit" section drives the verbs end to end through fleet-worker.sh."""

import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from collections.abc import Generator
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import revision, takeover, wave, waveloop, waveprep
from ludics.fleetworker.boardstore import NO_BOARD_EXIT
from ludics.fleetworker.config import load_config
from ludics.fleetworker.transport import UNREACHABLE, Done
from ludics.fleetworker.wavebrief import Part, cmd_render, render
from ludics.tests.fake import Answer, FakeTool, When

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "issue-wave", "scripts", "fleet-worker.sh")
A, B, C = "a" * 40, "b" * 40, "c" * 40


def captured(fn: Any, *args: Any) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            rc = fn(*args)
        except cli.Exit as exc:
            rc = exc.rc
            err.write(exc.message)
    return rc, out.getvalue(), err.getvalue()


class Render(unittest.TestCase):
    def test_every_part_is_substituted_literally_in_one_pass(self) -> None:
        got = render([Part("a", "x @@T@@ in @@WT@@\n\n"), Part("b", "task @@T@@ `$(rm)` @@ -1 +1 @@ @@x@@\n")],
                     {"T": "t1", "WT": "/w|t & \\1"})
        self.assertEqual(got, "x t1 in /w|t & \\1\n\ntask t1 `$(rm)` @@ -1 +1 @@ @@x@@\n")

    def test_an_unrendered_placeholder_refuses_naming_its_part_and_line(self) -> None:
        got = render([Part("common.md", "ok\nsee @@WT@@ and @@MISSING@@\n")], {"WT": "/w"})
        self.assertEqual(got, ["common.md:2: @@MISSING@@ is not rendered (no value for MISSING)"])

    def test_a_value_holding_a_placeholder_refuses(self) -> None:
        got = render([Part("p", "@@A@@")], {"A": "@@B@@", "B": "x"})
        self.assertIsInstance(got, list)
        self.assertIn("holds the placeholder @@B@@", " ".join(got))

    def test_the_verb_writes_nothing_on_a_refusal(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            part, out = os.path.join(d, "p.md"), os.path.join(d, "brief.md")
            with open(part, "w") as f:
                f.write("hello @@WHO@@ @@WHERE@@\n")
            rc, _, err = captured(cmd_render, ["--set", "WHO=you", "--out", out, part])
            self.assertEqual(rc, 1)
            self.assertIn("WAVE RENDER REFUSED: " + part + ":1: @@WHERE@@ is not rendered", err)
            self.assertFalse(os.path.exists(out))
            rc, said, _ = captured(cmd_render, ["--set", "WHO=you", "--set", "WHERE=here", "--out", out, part])
            self.assertEqual(rc, 0, said)
            with open(out) as f:
                self.assertEqual(f.read(), "hello you here\n")
            rc, _, err = captured(cmd_render, ["--set", "WHO=a", "--set", "WHO=b", part])
            self.assertEqual(rc, 1)
            self.assertIn("WHO is given twice", err)


def wave_data(d: str, **more: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "wave": "wv", "repository": "o/staging", "issue_repository": "o/up", "checkout": os.path.join(d, "repo"),
        "worker_prefix": "w1", "agent_host": "mac", "transport": "subagent", "kind": "claude",
        "standing_purpose": "standing iteration for @@T@@",
        "vars": {"COORD": "session-1"},
        "legs": {"gpu-box": {"checkout": "/home/u/repo", "suffix": "gpu", "purpose": "GPU @@BACKEND@@ for @@T@@",
                             "vars": {"BACKEND": "cuda"}}},
        "loops": {"cc": {"box": "rog", "purpose": "cc integration loop", "checkout": "/home/u/integ", "tip": "master",
                         "command": ["tools/run", "all"], "cpu": True, "integration": True, "poll": 5}},
    }
    data.update(more)
    return data


class WaveFile(unittest.TestCase):
    def test_the_file_is_a_fail_closed_allowlist(self) -> None:
        good = wave_data("/tmp/x")
        parsed = wave.parse_wave("/tmp/x/wave.json", good)
        self.assertEqual((parsed.directory, parsed.issue_repository, parsed.loops["cc"].poll), ("/tmp/x", "o/up", 5))
        cases: list[tuple[dict[str, Any], str]] = [({**good, "extra": 1}, "unknown key"), ({k: v for k, v in good.items() if k != "kind"}, "lacks kind"),
                             ({**good, "kind": "gpt"}, "claude or codex"), ({**good, "vars": {"WT": "x"}}, "gives itself"),
                             ({**good, "checkout": "rel"}, "absolute"), ({**good, "legs": {"b": {"checkout": "/c"}}}, "lacks"),
                             ({**good, "loops": {"cc": {**good["loops"]["cc"], "command": []}}}, "argv words"),
                             ({**good, "loops": {"cc": {**good["loops"]["cc"], "poll": True}}}, "poll")]
        for broken, word in cases:
            with self.subTest(word):
                with self.assertRaises(ValueError) as caught:
                    wave.parse_wave("/tmp/x/wave.json", broken)
                self.assertIn(word, str(caught.exception))


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


class Prep(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        d = self.dir = os.path.realpath(self.tmp.name)
        repo = os.path.join(d, "repo")
        git("init", "-q", "--bare", os.path.join(d, "origin.git"))
        git("init", "-q", "-b", "main", repo)
        git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
        git("-C", repo, "remote", "add", "origin", os.path.join(d, "origin.git"))
        git("-C", repo, "push", "-q", "origin", "main")
        self.base = git("-C", repo, "rev-parse", "HEAD")
        self.wavedir = os.path.join(d, "state", "wv")
        os.makedirs(os.path.join(self.wavedir, "tasks"))
        self.path = os.path.join(self.wavedir, "wave.json")
        with open(self.path, "w") as f:
            json.dump(wave_data(d), f)
        self.write("common.md", "Worker @@WORKER@@ of @@WAVE@@ (@@COORD@@): @@WT@@ on @@BR@@ at @@BASE@@, scratch @@SCR@@\n")
        self.write("tasks/t42.md", "# Task @@T@@: @@ISSUE@@\n")
        self.write("tasks/p8.md", "# Post task @@T@@ from @@SOURCE@@\n")
        self.write("legs.md", "## Legs\n@@LEGLINES@@\n")
        self.write("leg.md", "- @@LEG@@ (@@BACKEND@@): @@LEG_ID@@ at @@LEG_WT@@ from @@LEG_CHECKOUT@@\n")
        self.write("planning-paired+critique.md", "Plan first (@@MODE@@).\n")
        self.cfg = load_config(SCRIPT, {"HOME": d, "ISSUE_WAVE_STATE": os.path.join(d, "state")})
        self.shim_calls: list[list[str]] = []
        self.shim_rc: dict[str, int] = {}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, name: str, text: str) -> None:
        with open(os.path.join(self.wavedir, name), "w") as f:
            f.write(text)

    def fake_run(self, argv: list[str], **_: Any) -> Done:
        self.shim_calls.append(argv[1:])
        return Done(self.shim_rc.get(" ".join(argv[1:3]), 0), "")

    @contextlib.contextmanager
    def world(self, prs: list[dict[str, Any]] | None = None, records: list[dict[str, Any]] | None = None,
              board: Any = NO_BOARD_EXIT, head_prs: list[dict[str, Any]] | None = None) -> Generator[FakeTool]:
        with (FakeTool("gh") as gh,
              mock.patch.object(waveprep, "anchor_gate", return_value=0),
              mock.patch.object(waveprep, "listing", return_value=Done(0, json.dumps(records or []))),
              mock.patch.object(waveprep, "board_status", return_value=board),
              mock.patch.object(waveprep, "run", side_effect=self.fake_run)):
            gh.route((When(prefix=("pr", "list"), has=("--head",)), Answer(stdout=json.dumps(head_prs or []))),
                     (When(prefix=("pr", "list")), Answer(stdout=json.dumps(prs or []))))
            yield gh

    def prep(self, *args: str) -> tuple[int, str, str]:
        return captured(waveprep.cmd_prep, self.cfg, [self.path, *args])

    def test_a_ready_prep_makes_each_piece_in_order(self) -> None:
        with self.world() as gh:
            rc, out, err = self.prep("t42", "--base", "main", "--mode", "paired+critique", "--legs", "gpu-box")
            pr_calls = gh.calls()
        self.assertEqual(rc, 0, out + err)
        wt = os.path.join(self.dir, "repo-worktrees", "w1-42")
        self.assertIn(f"WAVE PREP t42: ready: brief {self.wavedir}/briefs/brief-t42.md worktree {wt} branch claude/w1-42", out)
        self.assertEqual(git("-C", wt, "rev-parse", "HEAD"), self.base)
        self.assertEqual(git("-C", wt, "branch", "--show-current"), "claude/w1-42")
        self.assertEqual([c[6:8] for c in pr_calls], [["--head", "claude/w1-42"], ["--search", "42"]])
        verbs = [c[:2] for c in self.shim_calls]
        self.assertEqual(verbs, [["execution", "run"], ["execution", "run"], ["board", "set"]])
        with open(self.shim_calls[0][2]) as f:
            own = json.load(f)
        with open(self.shim_calls[1][2]) as f:
            leg = json.load(f)
        self.assertEqual((own["request_id"], own["execution_host"], own["checkout"], own["standing"], own["issue"],
                          own["purpose"], own["requested_revision"]),
                         ("wv-t42-mac-iterate", "mac", wt, True, "o/up#42", "standing iteration for t42", self.base))
        self.assertEqual((leg["request_id"], leg["execution_host"], leg["checkout"], leg["purpose"]),
                         ("wv-t42-gpu-box-iterate", "gpu-box", "/home/u/repo-worktrees/w1-42-gpu", "GPU cuda for t42"))
        board = self.shim_calls[2]
        self.assertEqual(board[2:5], ["--create", "wv", "t42"])
        for want in ("issue=o/up#42", f"worktree={wt}", "exec_hosts=mac,gpu-box", "state=pending", "requests=none",
                     "standing=wv-t42-mac-iterate wv-t42-gpu-box-iterate", "planning=paired+critique",
                     f"plan_dir={self.dir}/state/plans/wv-42", "farside=gpu-box:/home/u/repo-worktrees/w1-42-gpu"):
            self.assertIn(want, board)
        self.assertFalse(any(f.startswith("agent=") for f in board), "prep never names the agent")
        with open(os.path.join(self.wavedir, "briefs", "brief-t42.md")) as f:
            brief = f.read()
        self.assertIn(f"Worker w1-42 of wv (session-1): {wt} on claude/w1-42 at {self.base}, scratch {self.wavedir}/scratch/t42", brief)
        self.assertIn("# Task t42: o/up#42", brief)
        self.assertIn("- gpu-box (cuda): wv-t42-gpu-box-iterate at /home/u/repo-worktrees/w1-42-gpu from /home/u/repo", brief)
        self.assertTrue(brief.endswith("Plan first (paired+critique).\n"))
        with open(os.path.join(self.wavedir, "reserve", "t42-base.json")) as f:
            self.assertEqual(json.load(f), {"wave": "wv", "worker": "w1-42", "transport": "subagent", "agent_host": "mac",
                                            "repository": "o/staging", "issue": "o/up#42"})
        self.assertTrue(os.path.isdir(os.path.join(self.wavedir, "scratch", "t42", "runs")))

    def assert_made_nothing(self, out: str) -> None:
        self.assertEqual(self.shim_calls, [], out)
        self.assertFalse(os.path.lexists(os.path.join(self.dir, "repo-worktrees", "w1-42")), out)
        self.assertFalse(os.path.exists(os.path.join(self.wavedir, "prep", "t42.json")), out)

    def test_an_existing_worktree_refuses_before_anything_is_made(self) -> None:
        os.makedirs(os.path.join(self.dir, "repo-worktrees", "w1-42"))
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn("WAVE PREP REFUSED t42: the worktree path", out)
        self.assertEqual(self.shim_calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.wavedir, "prep", "t42.json")))

    def test_each_other_existing_identity_refuses_making_nothing(self) -> None:
        repo = os.path.join(self.dir, "repo")
        git("-C", repo, "branch", "claude/w1-42")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn("branch claude/w1-42 exists in", out)
        self.assert_made_nothing(out)
        git("-C", repo, "push", "-q", "origin", "claude/w1-42")
        git("-C", repo, "branch", "-D", "claude/w1-42")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertIn("exists on origin", out)
        self.assert_made_nothing(out)
        git("-C", repo, "push", "-q", "origin", "--delete", "claude/w1-42")
        cases: list[tuple[dict[str, Any], str]] = [
            ({"records": [{"request_id": "WV-t42-mac-iterate"}]}, "the registry holds wv-t42-mac-iterate"),
            ({"board": {"tasks": [{"task": "t42", "fields": {}}]}}, "has a row for t42"),
            ({"prs": [{"number": 7, "title": "Fix o/up#42 at last", "body": "", "headRefName": "x"}]}, "open rival PR(s) #7"),
            ({"head_prs": [{"number": 8, "title": "t", "body": "", "headRefName": "claude/w1-42"}]}, "open rival PR(s) #8"),
            ({"board": 4}, "WAVE PREP UNKNOWN t42: the board"),
            ({"board": 1}, "it is not a wave with no board yet"),
        ]
        for world, word in cases:
            with self.subTest(word), self.world(**world):
                rc, out, _ = self.prep("t42", "--base", "main")
                self.assertIn(word, out)
                self.assertNotEqual(rc, 0)
                self.assert_made_nothing(out)

    def test_only_the_stores_no_board_exit_is_no_board(self) -> None:
        """board_status reads the store's exit, never its text: the no-board line under exit 1 is a
        refusal, and no text under exit 5 is needed (#1047's follow-up)."""
        for rc, said, want in ((NO_BOARD_EXIT, "", NO_BOARD_EXIT),
                               (1, "BOARD REFUSED: no board for wave wv on the anchor\n", 1),
                               (1, "BOARD REFUSED: the board of wv is not JSON\n", 1),
                               (UNREACHABLE, "", 4),
                               (0, '{"wave": "wv", "tasks": []}', {"wave": "wv", "tasks": []})):
            with self.subTest(rc=rc, said=said), mock.patch.object(takeover, "run_on", return_value=Done(rc, said)), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(takeover.board_status(self.cfg, "wv"), want)
                self.assertEqual(takeover.board_document(self.cfg, "wv"), 1 if want == NO_BOARD_EXIT else want,
                                 "board_document's callers keep exit 1 for no board")

    def test_a_listed_pr_the_coordinator_passes_is_no_rival_and_near_numbers_are_none(self) -> None:
        prs = [{"number": 7, "title": "Fix #42", "body": "", "headRefName": "x"},
               {"number": 9, "title": "Fix #420 and o/up#4200", "body": "&#42;", "headRefName": "y"}]
        with self.world(prs=prs):
            rc, out, err = self.prep("t42", "--base", "main", "--allow-rival", "7")
        self.assertEqual(rc, 0, out + err)

    def test_an_unrendered_placeholder_refuses_before_the_worktree(self) -> None:
        self.write("tasks/t42.md", "# Task @@T@@ needs @@NOPE@@\n")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn("@@NOPE@@ is not rendered", out)
        self.assert_made_nothing(out)

    def test_a_source_task_has_no_issue_and_an_issue_template_refuses(self) -> None:
        with self.world() as gh:
            rc, out, err = self.prep("p8", "--source", "1910", "--base", "main", "--mode", "paired+critique")
            pr_calls = gh.calls()
        self.assertEqual(rc, 0, out + err)
        self.assertIn(["--head", "claude/w1-p8"], [c[6:8] for c in pr_calls])
        board = self.shim_calls[-1]
        self.assertIn("source=o/up#1910", board)
        self.assertIn(f"plan_dir={self.dir}/state/plans/wv-p8", board)
        self.assertFalse(any(f.startswith("issue=") for f in board))
        with open(self.shim_calls[0][2]) as f:
            self.assertNotIn("issue", json.load(f), "a no-issue task's records name no issue")
        with open(os.path.join(self.wavedir, "reserve", "p8-base.json")) as f:
            self.assertNotIn("issue", json.load(f))
        self.write("tasks/p9.md", "Closes @@ISSUE@@\n")
        with self.world():
            rc, out, _ = self.prep("p9", "--source", "1911", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn("@@ISSUE@@ is not rendered", out)

    def test_a_failed_reservation_reports_what_was_made_and_writes_no_row(self) -> None:
        self.shim_rc["execution run"] = 4
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 4)
        self.assertIn("WAVE PREP UNKNOWN t42 at reservation: execution run", out)
        self.assertIn("WAVE PREP MADE t42: worktree ", out)
        self.assertIn("WAVE PREP MADE t42: the manifest ", out)
        self.assertNotIn(["board", "set"], [c[:2] for c in self.shim_calls])
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn("the worktree path", out)


def rec(n: int, state: str, verdict: str | None = None, sha: str = A, handle: str | None = None) -> dict[str, Any]:
    r: dict[str, Any] = {"request_id": f"wv-cc-{n}", "state": state, "observed_sha": sha,
                         "request": {"execution_host": "rog", "repository": "o/staging"}}
    if verdict:
        r["verdict"] = verdict
    if handle:
        r["handle"] = handle
    return r


class Loop(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.path = os.path.join(self.dir, "wave.json")
        with open(self.path, "w") as f:
            json.dump(wave_data(self.dir), f)
        self.cfg = load_config(SCRIPT, {"HOME": self.dir})
        self.calls: list[list[str]] = []
        self.answers: list[Done] = []
        self.tips: list[Any] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def fake_run(self, argv: list[str], **_: Any) -> Done:
        self.calls.append(argv[1:])
        return self.answers.pop(0)

    def stop(self, _: float) -> None:
        open(os.path.join(self.dir, "loops.stop"), "w").close()

    def drive(self, records: list[dict[str, Any]], *extra: str) -> tuple[int, str]:
        tips = iter(self.tips)

        def head(*_args: object) -> Any:
            return next(tips)

        with (mock.patch.object(waveloop, "listing", return_value=Done(0, json.dumps(records))),
              mock.patch.object(waveloop, "run", side_effect=self.fake_run),
              mock.patch.object(revision, "branch_head", side_effect=head),
              mock.patch.object(waveloop, "sleep", side_effect=self.stop)):
            rc, out, err = captured(waveloop.cmd_loop, self.cfg, [self.path, "cc", *extra])
        return rc, out + err

    def starts(self) -> list[list[str]]:
        return [c for c in self.calls if c[:2] == ["execution", "tip-run"] and c[2] != "--wait"]

    def test_a_restart_waits_on_its_running_run_and_starts_nothing(self) -> None:
        running = rec(3, "running", handle="bg-run:rog:/runs/x")
        self.answers = [Done(3, "TIP-RUN RUNNING wv-cc-3 rog /runs/x: RUNNING"),
                        Done(0, f"TIP-RUN CONCLUDED wv-cc-3 pass rog {A} /runs/x\n")]
        self.tips = [A]
        rc, out = self.drive([rec(1, "concluded", "pass", B), rec(2, "concluded", "not-launched", A), running])
        self.assertEqual(rc, 0, out)
        self.assertIn("RESUME wv-cc-3", out)
        self.assertEqual(self.starts(), [], "a restart must never start a second run")
        self.assertEqual([c[:4] for c in self.calls], [["execution", "tip-run", "--wait", "wv-cc-3"]] * 2)
        self.assertIn("STOPPED", out)

    def test_an_outstanding_record_of_any_other_shape_is_unknown(self) -> None:
        for records in ([rec(1, "launching")], [rec(1, "uncertain")], [rec(1, "running")],
                        [rec(1, "running", handle="bg-run:rog:/a"), rec(2, "reserved")]):
            with self.subTest(records):
                rc, out = self.drive(records)
                self.assertEqual(rc, 4, out)
                self.assertIn("UNKNOWN: outstanding", out)
                self.assertEqual(self.calls, [])

    def test_a_recorded_red_blocks_a_restart_until_resume_after_names_it(self) -> None:
        records = [rec(1, "concluded", "pass", B), rec(2, "concluded", "fail", A), rec(3, "concluded", "not-launched", C)]
        rc, out = self.drive(records)
        self.assertEqual(rc, 1)
        self.assertIn("RED wv-cc-2 (recorded, fail at", out)
        self.assertEqual(self.calls, [])
        self.tips = [A]  # the red's own commit: past it, the loop waits for the tip to move
        rc, out = self.drive(records, "--resume-after", "wv-cc-2")
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.starts(), [])
        os.unlink(os.path.join(self.dir, "loops.stop"))
        rc, out = self.drive([rec(1, "concluded", "cancelled", A)])
        self.assertEqual(rc, 1)
        self.assertIn("CANCELLED wv-cc-1", out)

    def test_a_not_launched_tip_is_run_again_and_a_pass_goes_on(self) -> None:
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-3 rog {A} /runs/a b\n"),
                        Done(0, f"TIP-RUN CONCLUDED wv-cc-3 pass rog {A} /runs/a b\n")]
        self.tips = [A, A]
        rc, out = self.drive([rec(1, "concluded", "pass", B), rec(2, "concluded", "not-launched", A)])
        self.assertEqual(rc, 0, out)
        start = self.starts()[0]
        self.assertEqual(start[3:], ["--tip", "master", "--id-prefix", "wv-cc", "--checkout", "/home/u/integ", "--cpu",
                                     "--", "tools/run", "all"])
        with open(start[2]) as f:
            self.assertEqual(json.load(f)["integration"], True)
        self.assertIn(f"PASS wv-cc-3 at {A}", out)

    def test_red_unknown_and_unread_tip_end_distinctly(self) -> None:
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-1 rog {A} /r\n"), Done(0, f"TIP-RUN CONCLUDED wv-cc-1 fail rog {A} /r\n")]
        self.tips = [A]
        rc, out = self.drive([])
        self.assertEqual(rc, 1)
        self.assertIn("RED wv-cc-1 (fail at", out)
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-1 rog {A} /r\n"), Done(4, "TIP-RUN UNKNOWN wv-cc-1: x\n")]
        self.tips = [A]
        rc, out = self.drive([])
        self.assertEqual(rc, 4)
        self.assertIn("UNKNOWN: tip-run --wait wv-cc-1 exited 4", out)
        self.calls = []
        self.tips = [("gh: down", 1)]
        rc, out = self.drive([])
        self.assertEqual(rc, 0)
        self.assertIn("NOTE the tip of master is unread", out)
        self.assertEqual(self.calls, [], "an unread tip is never taken as moved")

    def test_a_second_driver_is_refused(self) -> None:
        import fcntl

        logs = os.path.join(self.dir, "logs")
        os.makedirs(logs)
        with open(os.path.join(logs, "loop-cc.lock"), "a") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            rc, out = self.drive([])
        self.assertEqual(rc, 1)
        self.assertIn("another driver holds", out)


class Heartbeat(unittest.TestCase):
    def test_reads_print_whole_with_their_exits_and_the_time_last(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "wave.json")
            with open(path, "w") as f:
                json.dump(wave_data(d), f)
            os.makedirs(os.path.join(d, "logs"))
            with open(os.path.join(d, "logs", "loop-cc.log"), "w") as f:
                f.write("one\nlast line\n\n")
            cfg = load_config(SCRIPT, {"HOME": d})

            def fake(argv: list[str], **_: Any) -> Done:
                if argv[1] == "prs":
                    print("\n".join(f"#{n} PR line" for n in range(30)))
                    return Done(0, "")
                return Done(3, "")

            with mock.patch.object(wave, "run", side_effect=fake):
                rc, out, _ = captured(wave.cmd_heartbeat, cfg, [path, "--sleep", "0"])
        self.assertEqual(rc, 0)
        lines = out.rstrip("\n").split("\n")
        self.assertEqual(len([l for l in lines if l.endswith("PR line")]), 30)
        self.assertIn("HEARTBEAT prs exit=0", lines)
        self.assertIn("HEARTBEAT halted exit=3", lines)
        self.assertIn("HEARTBEAT loop cc: last line", lines)
        self.assertRegex(lines[-1], r"^HEARTBEAT wv \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")


if __name__ == "__main__":
    unittest.main()
