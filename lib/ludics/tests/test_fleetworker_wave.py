"""ludics.fleetworker.wave, wavebrief, waveprep, waveloop: the coordinator kit (ludics#1047). The
shell suite's "wave kit" section drives the verbs end to end through fleet-worker.sh."""

import contextlib
import fcntl
import glob
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from collections.abc import Generator
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import revision, takeover, wave, wavedecide, wavedrive, wavelaunch, waveloop, waveprep, wavereview, waveunprep
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
        self.assertEqual(wave.parse_wave("/tmp/x/wave.json", {**good, "project_part": ".github/wave-brief.md"}).project_part,
                         ".github/wave-brief.md")
        cases: list[tuple[dict[str, Any], str]] = [({**good, "extra": 1}, "unknown key"), ({k: v for k, v in good.items() if k != "kind"}, "lacks kind"),
                             ({**good, "kind": "gpt"}, "claude or codex"), ({**good, "vars": {"WT": "x"}}, "gives itself"),
                             ({**good, "checkout": "rel"}, "absolute"), ({**good, "legs": {"b": {"checkout": "/c"}}}, "lacks"),
                             ({**good, "loops": {"cc": {**good["loops"]["cc"], "command": []}}}, "argv words"),
                             ({**good, "legs": {**good["legs"], "other-box": {**good["legs"]["gpu-box"], "checkout": "/o"}}},
                              'legs.other-box.suffix "gpu" is another leg\'s, or the reserved name base'),
                             ({**good, "legs": {"gpu-box": {**good["legs"]["gpu-box"], "suffix": "base"}}}, "the reserved name base"),
                             ({**good, "loops": {"cc": {**good["loops"]["cc"], "poll": True}}}, "poll"),
                             ({**good, "vars": {"CHECKOUT": "x"}}, "gives itself"),
                             ({**good, "project_part": "/abs/brief.md"}, "relative to the checkout"),
                             ({**good, "project_part": "docs/../../brief.md"}, "no .. component")]
        for broken, word in cases:
            with self.subTest(word):
                with self.assertRaises(ValueError) as caught:
                    wave.parse_wave("/tmp/x/wave.json", broken)
                self.assertIn(word, str(caught.exception))


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


class WaveDirCase(unittest.TestCase):
    """A scratch project checkout with its origin, a wave directory and its wave file."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        d = self.dir = os.path.realpath(self.tmp.name)
        repo = os.path.join(d, "repo")
        git("init", "-q", "-b", "main", "--bare", os.path.join(d, "origin.git"))
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


class Prep(WaveDirCase):
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
        self.assertEqual(board[2:6], ["--create", "--new-row", "wv", "t42"])
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
        cases: list[tuple[int, str, dict[str, Any] | int]] = [
            (NO_BOARD_EXIT, "", NO_BOARD_EXIT),
            (1, "BOARD REFUSED: no board for wave wv on the anchor\n", 1),
            (1, "BOARD REFUSED: the board of wv is not JSON\n", 1),
            (UNREACHABLE, "", 4),
            (0, '{"wave": "wv", "tasks": []}', {"wave": "wv", "tasks": []})]
        for rc, said, want in cases:
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

    # --- THE PARTS and THE PROJECT PART (ludics#1072) ---------------------------------------------

    def rewave(self, **more: Any) -> None:
        with open(self.path, "w") as f:
            json.dump(wave_data(self.dir, **more), f)

    def commit(self, rel: str, text: str) -> str:
        repo = os.path.join(self.dir, "repo")
        os.makedirs(os.path.dirname(os.path.join(repo, rel)), exist_ok=True)
        with open(os.path.join(repo, rel), "w") as f:
            f.write(text)
        git("-C", repo, "add", rel)
        git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "project part")
        return git("-C", repo, "rev-parse", "HEAD")

    def brief(self) -> str:
        with open(os.path.join(self.wavedir, "briefs", "brief-t42.md")) as f:
            return f.read()

    def test_a_part_the_wave_lacks_is_the_shipped_one_and_the_wave_part_wins(self) -> None:
        # The wave's common.md wins; planning-paired.md, which the wave directory lacks, is the
        # shipped one, rendered with the task's issue.
        with self.world():
            rc, out, err = self.prep("t42", "--base", "main", "--mode", "paired")
        self.assertEqual(rc, 0, out + err)
        brief = self.brief()
        self.assertTrue(brief.startswith("Worker w1-42 of wv (session-1)"), brief[:200])
        self.assertIn("## Paired planning (mode: paired)", brief)
        self.assertIn("one comment on o/up#42 (`gh issue comment 42 --repo\n  o/up --body-file <file>`)", brief)
        with open(os.path.join(waveprep.shipped_dir("claude"), "planning-paired.md")) as f:
            self.assertIn("@@ISSUE@@", f.read(), "the fixture reads the shipped part, not a copy")

    def test_native_codex_without_wave_common_parts_renders(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        self.write("project.md", "## This project\nUse the project tests.\n")
        self.rewave(kind="codex", vars={"COORDINATOR": "local_c", "MAIN": "main"})
        with self.world():
            rc, out, err = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 0, out + err)
        brief = self.brief()
        self.assertNotIn("@@", brief)
        self.assertIn("You are a native Codex worker", brief)
        self.assertIn("`send_message`", brief)
        self.assertIn("`write_stdin`", brief)
        self.assertIn("Only the final hand-back ends your lifecycle", brief)
        self.assertIn("## This project", brief)
        self.assertNotIn("Claude Code", brief)
        self.assertNotIn("bg-run.sh spawn", brief)

    def test_the_shipped_common_part_renders_with_the_project_part_at_the_base(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        base = self.commit("docs/brief.md", "## This project\n\nWork in @@WT@@ of @@CHECKOUT@@.\n")
        self.commit("docs/brief.md", "## A later edit, past the base\n")
        self.rewave(vars={"COORDINATOR": "local_1", "MAIN": "trunk"}, project_part="docs/brief.md")
        with self.world():
            rc, out, err = self.prep("t42", "--base", base)
        self.assertEqual(rc, 0, out + err)
        brief, wt = self.brief(), os.path.join(self.dir, "repo-worktrees", "w1-42")
        self.assertIn("coordinator session `local_1` on `mac`", brief)
        self.assertIn(f"## This project\n\nWork in {wt} of {self.dir}/repo.\n\n## Running tests", brief)
        self.assertNotIn("A later edit", brief)
        self.assertIn(f"project part docs/brief.md at {base} (base)", out)
        self.assertIn(f"created from base `{base}` (explicit revision {base} at prep)", brief)
        self.assertIn("gh issue view <N> --repo o/up --json number,title,body,comments", brief)
        self.assertIn("pr-review.sh merge o/staging#<pr> --wait", brief)
        self.assertNotIn("@@", brief)

    def test_project_part_falls_back_to_default_tip_on_a_stacked_base(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        tip = self.commit("docs/brief.md", "## Default tip project for @@T@@\n")
        repo = os.path.join(self.dir, "repo")
        git("-C", repo, "update-ref", "refs/remotes/origin/main", tip)
        self.commit("docs/brief.md", "## Unpushed checkout text\n")
        self.rewave(vars={"COORDINATOR": "local_1", "MAIN": "main"}, project_part="docs/brief.md")
        with self.world():
            rc, out, err = self.prep("t42", "--base", self.base)
        self.assertEqual(rc, 0, out + err)
        self.assertIn("## Default tip project for t42", self.brief())
        self.assertNotIn("Unpushed checkout text", self.brief())
        self.assertIn(f"project part docs/brief.md at {tip} (origin/main fallback)", out)
        self.assertIn(f"created from base `{self.base}` (explicit revision {self.base} at prep)", self.brief())
        self.assertNotIn("(origin/main at prep)", self.brief())
        self.assertEqual(git("-C", os.path.join(self.dir, "repo-worktrees", "w1-42"), "rev-parse", "HEAD"), self.base)

    def test_project_fallback_uses_the_tip_resolved_with_the_base(self) -> None:
        self.write("common.md", "@@PROJECT@@\n")
        tip = self.commit("docs/brief.md", "## Resolved tip\n")
        repo = os.path.join(self.dir, "repo")
        git("-C", repo, "update-ref", "refs/remotes/origin/main", tip)
        self.rewave(vars={"MAIN": "main"}, project_part="docs/brief.md")
        path, task, opts = waveprep.parse([self.path, "t42", "--base", self.base])
        prep = waveprep.build(self.cfg, path, task, opts)
        waveprep.resolve_base(prep)
        later = self.commit("docs/brief.md", "## Later tip\n")
        git("-C", repo, "update-ref", "refs/remotes/origin/main", later)
        text = waveprep.brief_text(prep)
        self.assertIn("## Resolved tip", text)
        self.assertNotIn("## Later tip", text)

    def test_project_part_missing_at_both_revisions_refuses_before_writes(self) -> None:
        self.write("common.md", "@@PROJECT@@\n")
        tip = self.commit("other.txt", "tip\n")
        git("-C", os.path.join(self.dir, "repo"), "update-ref", "refs/remotes/origin/main", tip)
        self.rewave(vars={"MAIN": "main"}, project_part="docs/absent.md")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", self.base)
        self.assertEqual(rc, 1, out)
        self.assertIn(f"at base {self.base} or origin/main fallback {tip}", out)
        self.assert_made_nothing(out)

    def test_project_fallback_requires_a_known_default_tip(self) -> None:
        self.write("common.md", "@@PROJECT@@\n")
        self.rewave(vars={"MAIN": "absent"}, project_part="docs/absent.md")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", self.base)
        self.assertEqual(rc, 1, out)
        self.assertIn("fallback needs vars.MAIN and its origin remote-tracking commit", out)
        self.assert_made_nothing(out)

    def test_origin_line_distinguishes_default_tip_from_a_stacked_branch(self) -> None:
        self.write("common.md", "@@BASE@@ (@@BASE_ORIGIN@@)\n")
        self.rewave(vars={"MAIN": "main"})
        with self.world():
            rc, out, err = self.prep("t42", "--base", "origin/main")
        self.assertEqual(rc, 0, out + err)
        self.assertTrue(self.brief().startswith(f"{self.base} (origin/main at prep)\n"), self.brief())
        stacked = self.commit("stack.txt", "stack\n")
        git("-C", os.path.join(self.dir, "repo"), "branch", "sibling", stacked)
        with self.world():
            rc, out, err = self.prep("p8", "--source", "42", "--base", "sibling")
        self.assertEqual(rc, 0, out + err)
        with open(os.path.join(self.wavedir, "briefs", "brief-p8.md")) as f:
            self.assertTrue(f.read().startswith(f"{stacked} (explicit revision sibling at prep)\n"))

    def test_the_wave_directorys_project_part_wins_and_a_missing_one_refuses(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        self.rewave(vars={"COORDINATOR": "local_1", "MAIN": "main"})
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn("a part names @@PROJECT@@, and neither", out)
        self.assert_made_nothing(out)
        self.rewave(vars={"COORDINATOR": "local_1", "MAIN": "main"}, project_part="docs/absent.md")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn("the project part docs/absent.md cannot be read in", out)
        self.assert_made_nothing(out)
        self.write("project.md", "## The wave's own project part, @@T@@\n")
        with self.world():
            rc, out, err = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 0, out + err)
        self.assertIn("## The wave's own project part, t42\n", self.brief())

    def test_a_kind_with_no_shipped_directory_takes_its_own_parts_from_the_wave(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        # A kind with no shipped directory takes its own parts from the wave directory, one by one,
        # and the shared ones from the repository; a wave directory's part wins over a shipped one.
        os.makedirs(os.path.join(self.wavedir, "common"))
        for name in waveprep.OWN:
            self.write(f"common/{name}", f"## The wave's own {name} for @@WORKER@@\n")
        self.write("common/startup.md", "## Startup, as this wave words it\n")
        self.rewave(kind="claude", transport="cli", vars={"COORDINATOR": "local_1", "MAIN": "main"},
                    project_part="docs/absent.md")
        self.write("project.md", "## The project\n")
        with self.world():
            rc, out, err = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 0, out + err)
        brief = self.brief()
        self.assertTrue(brief.startswith("## The wave's own who.md for w1-42\n\n- Repository: `o/staging`"), brief[:120])
        self.assertIn("## Startup, as this wave words it\n\n## The task\n", brief)
        self.assertNotIn("## Startup (first thing", brief)
        self.assertIn("## The wave's own blocking.md for w1-42\n\n## The wave's own context.md for w1-42\n\n## Landing: ship-pr\n", brief)
        self.assertNotIn("## The review checkpoint", brief, "a wave file with no review asks for none")

    def test_a_part_neither_the_wave_nor_the_repository_has_refuses(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        self.rewave(kind="claude", transport="cli")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn(f"WAVE PREP REFUSED t42: the common part who.md exists nowhere: not {self.wavedir}/common.md (the whole of"
                      f" them), nor {self.wavedir}/common/who.md, nor {waveprep.shipped_dir('claude', True)}/who.md, nor"
                      f" {waveprep.TEMPLATES}/shared/who.md", out)
        self.assert_made_nothing(out)
        self.write("common.md", "C\n")
        os.unlink(os.path.join(self.wavedir, "legs.md"))
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main", "--legs", "gpu-box")
        self.assertEqual(rc, 1)
        self.assertIn(f"the template part {self.wavedir}/legs.md does not exist", out)
        self.assertNotIn("nor the shipped", out, "the repository ships no legs part")
        self.assert_made_nothing(out)


MIXED = {"profiles": {"sol": {"transport": "cli", "kind": "codex", "model": "gpt-6.1-sol", "effort": "medium"},
                      "opus": {"transport": "subagent", "kind": "claude"}},
         "hosts": {"far": {"checkout": "/home/u/repo", "scratch": "/home/u/wave-scratch"}}}


class MixedWave(WaveDirCase):
    """A mixed wave: a task takes a profile and a host, and a CLI task is prepared, then launched."""

    def setUp(self) -> None:
        super().setUp()
        with open(self.path, "w") as f:
            json.dump(wave_data(self.dir, vars={"COORD": "session-1", "MAIN": "main"}, **MIXED), f)
        self.write("tasks/t43.md", "# Task @@T@@: @@ISSUE@@\n")
        self.launch = Done(0, "preflight ok\nLAUNCHED far/w1-42 kind=codex session= model=gpt-6.1-sol cwd=/home/u/repo-worktrees/w1-42 stream=/s\n")
        self.far_calls: list[list[str]] = []
        self.far_state = Done(0, "worktree=absent\n")

    def launch_run(self, argv: list[str], **_: Any) -> Done:
        self.shim_calls.append(argv[1:])
        return self.launch if argv[1] == "launch" else Done(self.shim_rc.get(" ".join(argv[1:3]), 0), "")

    def far_run(self, _cfg: Any, box: str, script: str, args: list[str], **_: Any) -> Done:
        if "worktree=" in script:  # wave launch's read of the worktree path on the host
            return self.far_state
        self.far_calls.append([box, *args])
        return Done(0, "")

    @contextlib.contextmanager
    def world(self, prs: list[dict[str, Any]] | None = None) -> Generator[FakeTool]:
        with (FakeTool("gh") as gh,
              mock.patch.object(waveprep, "anchor_gate", return_value=0),
              mock.patch.object(waveprep, "listing", return_value=Done(0, "[]")),
              mock.patch.object(waveprep, "board_status", return_value=NO_BOARD_EXIT),
              mock.patch.object(waveprep, "run", side_effect=self.fake_run),
              mock.patch.object(wavelaunch, "run", side_effect=self.launch_run),
              mock.patch.object(wavelaunch, "run_on", side_effect=self.far_run)):
            gh.route((When(prefix=("pr", "list")), Answer(stdout=json.dumps(prs or []))))
            yield gh

    def prep(self, *args: str) -> tuple[int, str, str]:
        return captured(waveprep.cmd_prep, self.cfg, [self.path, *args])

    def start(self, task: str = "t42") -> tuple[int, str, str]:
        return captured(wavelaunch.cmd_launch, self.cfg, [self.path, task])

    def manifest(self, task: str = "t42") -> dict[str, Any]:
        with open(os.path.join(self.wavedir, "prep", f"{task}.json")) as f:
            return json.load(f)

    def test_the_wave_file_takes_profiles_and_hosts_fail_closed(self) -> None:
        good = wave_data("/tmp/x", **MIXED)
        parsed = wave.parse_wave("/tmp/x/wave.json", good)
        self.assertEqual(parsed.profiles["sol"], wave.Profile("cli", "codex", "gpt-6.1-sol", "medium"))
        self.assertEqual((parsed.profiles["opus"].model, parsed.hosts["far"].scratch), ("", "/home/u/wave-scratch"))
        for more, word in (({"profiles": {"x": {"transport": "app", "kind": "codex"}}}, "a transport of subagent or cli"),
                           ({"profiles": {"x": {"transport": "cli", "kind": "gpt"}}}, "a kind of claude or codex"),
                           ({"profiles": {"x": {"transport": "cli"}}}, "profiles.x lacks kind"),
                           ({"profiles": {"x": {"transport": "cli", "kind": "codex", "args": ["-m"]}}}, "unknown key"),
                           ({"profiles": {"x": {"transport": "cli", "kind": "codex", "model": "a;b"}}}, "does not match"),
                           ({"hosts": {"far": {"checkout": "/c"}}}, "hosts.far lacks scratch"),
                           ({"hosts": {"far": {"checkout": "rel", "scratch": "/s"}}}, "absolute"),
                           ({"hosts": {"far": {"checkout": "/c", "scratch": "/s", "home": "/h"}}}, "unknown key")):
            with self.assertRaises(ValueError) as caught:
                wave.parse_wave("/tmp/x/wave.json", {**good, **more})
            self.assertIn(word, str(caught.exception))

    def test_a_cli_task_on_another_box_is_prepared_and_nothing_is_made_or_reserved(self) -> None:
        with self.world():
            rc, out, err = self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")
        self.assertEqual(rc, 0, out + err)
        self.assertIn("worktree /home/u/repo-worktrees/w1-42 branch codex/w1-42", out)
        self.assertIn("standing wv-t42-far-iterate wv-t42-gpu-box-iterate (a CLI worker on far, nothing made or reserved yet: wave launch starts it)", out)
        self.assertEqual([c[:2] for c in self.shim_calls], [["board", "set"]], "no execution run: launch reserves")
        self.assertFalse(os.path.lexists(os.path.join(self.dir, "repo-worktrees")), "no worktree is made here")
        self.assertFalse(os.path.lexists(os.path.join(self.wavedir, "scratch")), "the scratch is the box's")
        with open(os.path.join(self.wavedir, "reserve", "t42.json")) as f:
            own = json.load(f)
        self.assertEqual((own["request_id"], own["transport"], own["agent_host"], own["execution_host"], "checkout" in own),
                         ("wv-t42-far-iterate", "cli", "far", "far", False))
        with open(os.path.join(self.wavedir, "reserve", "t42-gpu.json")) as f:
            leg = json.load(f)
        self.assertEqual((leg["agent_host"], leg["execution_host"], leg["checkout"]), ("far", "gpu-box", "/home/u/repo-worktrees/w1-42-gpu"))
        with open(os.path.join(self.wavedir, "reserve", "t42-base.json")) as f:
            self.assertEqual(json.load(f), {"wave": "wv", "worker": "w1-42", "transport": "cli", "agent_host": "far",
                                            "repository": "o/staging", "issue": "o/up#42"})
        board = self.shim_calls[0]
        for want in ("transport=cli", "kind=codex", "agent_host=far", "exec_hosts=far,gpu-box", "brief_host=mac", "model=gpt-6.1-sol/medium",
                     "worktree=/home/u/repo-worktrees/w1-42", "runs=/home/u/wave-scratch/wv/t42/runs", "state=pending"):
            self.assertIn(want, board)
        with open(os.path.join(self.wavedir, "briefs", "brief-t42.md")) as f:
            self.assertIn("/home/u/repo-worktrees/w1-42 on codex/w1-42", f.read())
        launch = self.manifest()["launch"]
        self.assertEqual({k: launch[k] for k in ("wave", "repository", "main", "transport", "kind", "model", "effort", "host", "remote",
                                                 "host_checkout", "scratch", "worker", "branch", "base", "number", "issue_ref", "standing")},
                         {"wave": "wv", "repository": "o/staging", "main": "main", "transport": "cli", "kind": "codex", "model": "gpt-6.1-sol",
                          "effort": "medium", "host": "far", "remote": True, "host_checkout": "/home/u/repo",
                          "scratch": "/home/u/wave-scratch/wv/t42", "worker": "w1-42", "branch": "codex/w1-42", "base": self.base,
                          "number": "42", "issue_ref": "o/up#42", "standing": "wv-t42-far-iterate"})
        self.assertEqual(launch["legs"], [{"box": "gpu-box", "suffix": "gpu", "worktree": "/home/u/repo-worktrees/w1-42-gpu",
                                           "standing": "wv-t42-gpu-box-iterate"}])

    def test_a_cli_task_on_the_agent_host_keeps_the_local_reads_and_a_native_profile_is_made_as_ever(self) -> None:
        os.makedirs(os.path.join(self.dir, "repo-worktrees", "w1-42"))
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main", "--profile", "sol")
            self.assertEqual(rc, 1)
            self.assertIn("the worktree path", out)
            os.rmdir(os.path.join(self.dir, "repo-worktrees", "w1-42"))
            rc, out, _ = self.prep("t42", "--base", "main", "--profile", "sol")
            self.assertEqual(rc, 0, out)
            self.assertTrue(os.path.isdir(os.path.join(self.wavedir, "scratch", "t42", "runs")), "a local host's scratch is made")
            self.assertFalse(os.path.lexists(os.path.join(self.dir, "repo-worktrees", "w1-42")))
            self.shim_calls.clear()
            rc, out, _ = self.prep("t43", "--base", "main", "--profile", "opus")
            self.assertEqual(rc, 0, out)
            self.assertEqual([c[:2] for c in self.shim_calls], [["execution", "run"], ["board", "set"]])
            self.assertEqual(git("-C", os.path.join(self.dir, "repo-worktrees", "w1-43"), "branch", "--show-current"), "claude/w1-43")

    def test_a_file_another_task_wrote_is_never_overwritten(self) -> None:
        """A task id that ends in a leg's suffix, or in -base, names another task's payload file."""
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")[0], 0)
            with open(os.path.join(self.wavedir, "reserve", "t42-gpu.json")) as f:
                leg = f.read()
            for task, name in (("t42-gpu", "reserve/t42-gpu.json"), ("t42-base", "reserve/t42-base.json")):
                self.shim_calls.clear()
                rc, out, _ = self.prep(task, "--source", "42", "--base", "main", "--profile", "sol")
                self.assertEqual((rc, self.shim_calls), (1, []), out)
                self.assertIn(f"WAVE PREP REFUSED {task}: {self.wavedir}/{name} exists, a file this prep would write", out)
                self.assertFalse(os.path.exists(os.path.join(self.wavedir, "prep", f"{task}.json")))
            with open(os.path.join(self.wavedir, "reserve", "t42-gpu.json")) as f:
                self.assertEqual(f.read(), leg, "t42's leg payload is the one its launch reserves")

    def test_a_cli_task_with_no_common_part_of_the_waves_gets_the_shipped_cli_brief(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        with open(self.path, "w") as f:
            json.dump(wave_data(self.dir, vars={"COORDINATOR": "session-1", "MAIN": "main"}, **MIXED), f)
        self.write("project.md", "## The project\n\nIts clone is @@CHECKOUT@@.\n")
        with self.world():
            rc, out, err = self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")
        self.assertEqual(rc, 0, out + err)
        with open(os.path.join(self.wavedir, "briefs", "brief-t42.md")) as f:
            brief = f.read()
        self.assertTrue(brief.startswith("## Who you are and where you work\n\nYou are a Codex CLI worker of wave `wv`, task `t42`"), brief[:120])
        self.assertIn("Its clone is /home/u/repo.", brief, "CHECKOUT is the clone on the worker's host")
        self.assertIn('cd "/home/u/repo-worktrees/w1-42" && ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot', brief)
        self.assertIn("`wv-t42-far-iterate`", brief)
        self.assertNotIn("@@", brief)

    def test_scratch_parent_is_shared_on_the_workers_host(self) -> None:
        w = wave.load_wave(self.path, "prep")
        for host, parent in (("mac", os.path.join(self.wavedir, "scratch")),
                             ("far", "/home/u/wave-scratch/wv")):
            for task in ("t42", "t43"):
                with self.subTest(host=host, task=task):
                    prep = waveprep.Prep(w, task, task[1:], f"o/up#{task[1:]}", "", self.base,
                                         "none", [], set(), self.cfg.path(self.cfg.state), "sol", host)
                    text = waveprep.rendered(prep, [Part("lock", "@@SCR_PARENT@@/test-wake-lab.lock")],
                                             waveprep.values_of(prep))
                    self.assertEqual(text, parent + "/test-wake-lab.lock\n")
                    self.assertEqual(os.path.dirname(prep.scratch), parent)

    def test_wave_dir_is_refused_only_for_a_remote_workers_rendered_parts(self) -> None:
        w = wave.load_wave(self.path, "prep")
        for host in ("mac", "far"):
            prep = waveprep.Prep(w, "t42", "42", "o/up#42", "", self.base, "none", [], set(),
                                 self.cfg.path(self.cfg.state), "sol", host)
            unsafe = Part("project.md", "@@WAVE_DIR@@/scratch/lock")
            with self.subTest(host=host):
                if host == "mac":
                    self.assertEqual(waveprep.rendered(prep, [unsafe], waveprep.values_of(prep)),
                                     self.wavedir + "/scratch/lock\n")
                else:
                    with self.assertRaises(waveprep.Stop) as caught:
                        waveprep.rendered(prep, [unsafe], waveprep.values_of(prep))
                    self.assertIn("project.md names @@WAVE_DIR@@", caught.exception.line)
                    self.assertIn("far", caught.exception.line)
                    self.assertIn("mac", caught.exception.line)
                    self.assertEqual(waveprep.rendered(prep, [Part("safe", "literal /elsewhere/lock")],
                                                      waveprep.values_of(prep)), "literal /elsewhere/lock\n")

    def test_profile_and_host_usage(self) -> None:
        for args, why in ((["--profile", "astra"], "--profile names 'astra', which the wave file's profiles do not (it has: sol, opus)"),
                          (["--host", "far"], "--host far needs a cli transport: a subagent worker runs on the agent host, mac"),
                          (["--profile", "opus", "--host", "far"], "--host far needs a cli transport"),
                          (["--profile", "sol", "--host", "rog"], "--host names 'rog', which the wave file's hosts do not (it has: far)"),
                          (["--profile", "sol", "--host", "gpu-box", "--legs", "gpu-box"], "--host names 'gpu-box'")):
            rc, _, err = self.prep("t42", "--base", "main", *args)
            self.assertEqual(rc, 2, args)
            self.assertIn(why, err)

    def test_launch_starts_the_worker_reserves_its_legs_and_sets_the_row(self) -> None:
        with self.world() as gh:
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")[0], 0)
            self.shim_calls.clear()
            rc, out, err = self.start()
            self.assertEqual(rc, 0, out + err)
            self.assertEqual([c[4:6] for c in gh.calls()[-2:]], [["--state", "open"]] * 2, "the rivals are read again")
            self.assertEqual(self.far_calls, [["far", "/home/u/wave-scratch/wv/t42/runs"]])
            launch, leg, board = self.shim_calls
            self.assertEqual(launch, ["launch", "far", "w1-42", "--target-repo", "o/staging", "--kind", "codex", "--brief",
                                      f"{self.wavedir}/briefs/brief-t42.md", "--repo", "/home/u/repo", "--branch", "codex/w1-42",
                                      "--base", self.base, "--base-branch", "main", "--standing", f"{self.wavedir}/reserve/t42.json",
                                      "--", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=medium"])
            self.assertEqual(leg, ["execution", "run", f"{self.wavedir}/reserve/t42-gpu.json"])
            self.assertEqual(board, ["board", "set", "wv", "t42", "worktree=/home/u/repo-worktrees/w1-42", "state=launched",
                                     "standing=wv-t42-far-iterate wv-t42-gpu-box-iterate", "exec_hosts=far,gpu-box",
                                     "farside=far:/home/u/repo-worktrees/w1-42 gpu-box:/home/u/repo-worktrees/w1-42-gpu"])
            self.assertTrue(out.endswith("WAVE LAUNCH t42: launched far/w1-42 worktree /home/u/repo-worktrees/w1-42"
                                         " standing wv-t42-far-iterate wv-t42-gpu-box-iterate\n"), out)
            self.assertIn("LAUNCHED far/w1-42", out)
            self.assertEqual(self.manifest()["done"][-2:], ["ready", "launched far/w1-42"])
            self.shim_calls.clear()
            rc, out, _ = self.start()
            self.assertEqual((rc, self.shim_calls), (1, []))
            self.assertIn("records a launch already", out)

    def test_launch_refuses_a_prep_that_did_not_finish(self) -> None:
        with self.world():
            self.shim_rc = {"board set": 1}
            rc, out, _ = self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")
            self.assertEqual(rc, 1, out)
            self.assertIn("WAVE PREP FAILED t42 at board", out)
            self.shim_calls.clear()
            rc, out, _ = self.start()
            self.assertEqual((rc, self.shim_calls, self.far_calls), (1, [], []), out)
            self.assertIn("WAVE LAUNCH REFUSED t42: its prep did not finish", out)
            self.assertIn("not 'ready'", out)

    def test_a_launch_that_is_refused_makes_nothing_and_a_leg_or_row_that_fails_is_a_note(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")[0], 0)
            self.shim_calls.clear()
            self.launch = Done(1, "LAUNCH REFUSED far/w1-42: base red\n")
            rc, out, _ = self.start()
            self.assertEqual((rc, [c[0] for c in self.shim_calls]), (1, ["launch"]), out)
            self.assertIn("LAUNCH REFUSED far/w1-42: base red", out)
            self.assertNotIn("launched", " ".join(self.manifest()["done"]))
            self.launch = Done(0, "LAUNCHED far/w1-42 kind=codex\n")
            rc, out, _ = self.start()
            self.assertEqual(rc, 4)
            self.assertIn("WAVE LAUNCH UNKNOWN t42: launch exited 0 and printed no LAUNCHED line with its cwd", out)
            self.launch = Done(0, "LAUNCHED far/w1-42 kind=codex cwd=/home/u/repo-worktrees/w1-42 stream=/s\n")
            self.shim_rc = {"execution run": 1, "board set": 4}
            self.shim_calls.clear()
            rc, out, _ = self.start()
            self.assertEqual(rc, 3, out)
            self.assertIn("WAVE LAUNCH NOTE t42: the standing leg on gpu-box is not reserved (execution run exit 1)", out)
            self.assertIn("WAVE LAUNCH NOTE t42: the row is not set (board set exit 4): worktree=/home/u/repo-worktrees/w1-42"
                          " state=launched standing=wv-t42-far-iterate", out)
            self.assertIn("exec_hosts=far", self.shim_calls[-1])
            self.assertIn("farside=far:/home/u/repo-worktrees/w1-42", self.shim_calls[-1])
            self.assertEqual(self.manifest()["done"][-1], "launched far/w1-42", "the worker runs: the launch is recorded")

    def test_launch_row_reads_the_worker_placement_from_the_launched_line(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 0)
            self.launch = Done(0, "LAUNCHED far/w1-42 kind=codex cwd=/actual/wt stream=/s\n")
            self.assertEqual(self.start()[0], 0)
        board = self.shim_calls[-1]
        self.assertIn("worktree=/actual/wt", board)
        self.assertIn("farside=far:/actual/wt", board)

    def test_ambiguous_launch_output_never_publishes_a_cleanup_prefix(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 0)
            for path in ("/actual/wt stream=old/w1-42", "/actual/wt cwd=old/w1-42",
                         "/actual/wt\u2028LAUNCHED far/w1-42 kind=codex cwd=/prefix stream=/forged\u2028tail"):
                self.launch = Done(0, f"LAUNCHED far/w1-42 kind=codex cwd={path} stream=/state/stream.jsonl\n")
                self.shim_calls.clear()
                rc, out, _ = self.start()
                self.assertEqual(rc, 4)
                self.assertIn("ambiguous LAUNCHED", out)
                self.assertEqual([call[0] for call in self.shim_calls], ["launch"])
                self.assertEqual(self.manifest()["done"][-1], "ready")

    def test_launch_never_publishes_a_whitespace_path_as_a_cleanup_prefix(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")[0], 0)
            self.launch = Done(0, "LAUNCHED far/w1-42 kind=codex cwd=/actual/wt old stream=/s\n")
            rc, out, _ = self.start()
        self.assertEqual(rc, 3)
        self.assertIn("cannot record farside placement", out)
        self.assertIn("worktree=/actual/wt old", self.shim_calls[-1])
        self.assertIn("farside=gpu-box:/home/u/repo-worktrees/w1-42-gpu", self.shim_calls[-1])
        self.assertEqual(self.manifest()["done"][-1], "launched far/w1-42")

    def test_launch_refuses_a_worktree_on_the_host_that_is_not_preps(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 0)
            self.shim_calls.clear()
            wt = "/home/u/repo-worktrees/w1-42"
            for state, why in ((Done(0, f"worktree={C} dirty=0\n"), f"{wt} exists on far at {C} with 0 uncommitted path(s)"),
                               (Done(0, f"worktree={self.base} dirty=2\n"), "with 2 uncommitted path(s), not a clean worktree at prep's base"),
                               (Done(0, "worktree=unreadable dirty=unreadable\n"), "exists on far at unreadable")):
                self.far_state = state
                rc, out, _ = self.start()
                self.assertEqual((rc, self.shim_calls, self.far_calls), (1, [], []), out)
                self.assertIn(why, out)
            for state in (Done(UNREACHABLE, ""), Done(0, "garbage\n"), Done(1, "worktree=absent\n"), Done(0, "")):
                self.far_state = state
                rc, out, _ = self.start()
                self.assertEqual((rc, self.shim_calls), (4, []), out)
                self.assertIn(f"WAVE LAUNCH UNKNOWN t42: the worktree path {wt} on far could not be read", out)
            self.far_state = Done(0, f"worktree={self.base} dirty=0\n")
            rc, out, _ = self.start()
            self.assertEqual(rc, 0, "a clean worktree at prep's base is an earlier launch's: the retry goes on\n" + out)

    def test_the_manifest_is_the_task_whatever_the_wave_file_says_later(self) -> None:
        """A profile, a host or a leg edited after the prep changes nothing a launch does."""
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")[0], 0)
            with open(self.path) as f:
                data = json.load(f)
            data["hosts"]["far"] = {"checkout": "/srv/repo", "scratch": "/srv/scratch"}
            data["profiles"]["sol"] = {"transport": "cli", "kind": "claude", "model": "opus"}
            data["legs"]["gpu-box"].update(checkout="/srv/gpu", suffix="g2")
            data["repository"], data["vars"]["MAIN"] = "o/elsewhere", "trunk"
            with open(self.path, "w") as f:
                json.dump(data, f)
            self.shim_calls.clear()
            rc, out, _ = self.start()
            self.assertEqual(rc, 0, out)
            launch, leg, board = self.shim_calls
            self.assertEqual(launch[launch.index("--target-repo") + 1:launch.index("--brief")], ["o/staging", "--kind", "codex"])
            self.assertEqual(launch[launch.index("--repo"):], ["--repo", "/home/u/repo", "--branch", "codex/w1-42", "--base", self.base,
                                                              "--base-branch", "main", "--standing", f"{self.wavedir}/reserve/t42.json",
                                                              "--", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=medium"])
            self.assertEqual(leg, ["execution", "run", f"{self.wavedir}/reserve/t42-gpu.json"])
            self.assertIn("farside=far:/home/u/repo-worktrees/w1-42 gpu-box:/home/u/repo-worktrees/w1-42-gpu", board)
            self.assertEqual(self.far_calls, [["far", "/home/u/wave-scratch/wv/t42/runs"]])

    def test_launch_refuses_another_waves_manifest_one_with_no_record_and_one_with_no_base_branch(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol")[0], 0)
            with open(self.path) as f:
                data = json.load(f)
            with open(self.path, "w") as f:
                json.dump({**data, "wave": "wv2"}, f)
            self.shim_calls.clear()
            rc, out, _ = self.start()
            self.assertEqual((rc, self.shim_calls), (1, []), out)
            self.assertIn("was prepared for wave wv, and", out)
            self.assertIn("names wv2; its reservations and row are wv's", out)
            with open(self.path, "w") as f:
                json.dump(data, f)
            path = os.path.join(self.wavedir, "prep", "t42.json")
            kept = self.manifest()
            for damage, why in (({**kept, "launch": {**kept["launch"], "main": ""}}, "its prep recorded no base branch"),
                                ({k: v for k, v in kept.items() if k != "launch"}, "holds no launch record wave prep wrote"),
                                ({**kept, "launch": {**kept["launch"], "extra": 1}}, "holds no launch record"),
                                ({**kept, "launch": {**kept["launch"], "remote": "no"}}, "holds no launch record"),
                                ({**kept, "launch": {**kept["launch"], "legs": [{"box": "gpu-box"}]}}, "holds no launch record"),
                                ({**kept, "launch": {k: v for k, v in kept["launch"].items() if k != "worktree"}}, "holds no launch record")):
                with open(path, "w") as f:
                    json.dump(damage, f)
                rc, out, _ = self.start()
                self.assertEqual((rc, self.shim_calls), (1, []), out)
                self.assertIn(why, out)

    def test_the_far_side_reads_the_worktree_path_as_it_is(self) -> None:
        def state(path: str) -> str:
            return subprocess.run(["bash", "-c", wavelaunch.WORKTREE_STATE, "state", path], capture_output=True, text=True, check=True).stdout

        repo = os.path.join(self.dir, "repo")
        self.assertEqual(state(os.path.join(self.dir, "nothing here")), "worktree=absent\n")
        self.assertEqual(state(repo), f"worktree={self.base} dirty=0\n")
        with open(os.path.join(repo, "left.txt"), "w") as f:
            f.write("x")
        self.assertEqual(state(repo), f"worktree={self.base} dirty=1\n")
        os.makedirs(os.path.join(self.dir, "plain dir"))
        self.assertEqual(state(os.path.join(self.dir, "plain dir")), "worktree=unreadable dirty=unreadable\n")
        os.symlink(os.path.join(self.dir, "nowhere"), os.path.join(self.dir, "dangling"))
        self.assertEqual(state(os.path.join(self.dir, "dangling")), "worktree=unreadable dirty=unreadable\n", "a dangling link is something there")
        for said in ("worktree=absent", f"worktree={self.base} dirty=0", "worktree=unreadable dirty=unreadable"):
            self.assertTrue(said == "worktree=absent" or wavelaunch.STATE.fullmatch(said), said)

    def test_launch_refuses_what_is_not_a_prepared_cli_task(self) -> None:
        with self.world(prs=[]) as gh:
            rc, out, _ = self.start()
            self.assertEqual(rc, 1)
            self.assertIn("no prep manifest", out)
            self.assertEqual(self.prep("t43", "--base", "main")[0], 0)
            rc, out, _ = self.start("t43")
            self.assertEqual(rc, 1)
            self.assertIn("a subagent worker is spawned by its coordinator's runtime", out)
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol")[0], 0)
            gh.route((When(prefix=("pr", "list")), Answer(stdout=json.dumps([{"number": 9, "title": "Fix #42", "body": "", "headRefName": "x"}]))))
            self.shim_calls.clear()
            rc, out, _ = self.start()
            self.assertEqual((rc, self.shim_calls), (1, []), out)
            self.assertIn("WAVE LAUNCH REFUSED t42: open rival PR(s) #9 Fix #42", out)
        rc, _, err = captured(wavelaunch.cmd_launch, self.cfg, [self.path])
        self.assertEqual(rc, 2)
        self.assertIn("name the wave file and the task", err)


class Unprep(MixedWave):
    """wave unprep: a prepared, never-launched CLI task taken back, so it is prepared again under its own id."""

    def setUp(self) -> None:
        super().setUp()
        self.rows: list[dict[str, Any]] = []
        self.records: list[dict[str, Any]] = []
        self.listing_rc = 0
        self.board_rc: int | None = None
        self.forget_calls: list[tuple[str, str, str]] = []
        self.forget_rc: list[int] = []

    def board_run(self, argv: list[str], **_: Any) -> Done:
        """The shim, with ``board set --new-row`` kept as the row the board reads back."""
        self.shim_calls.append(argv[1:])
        rc = self.shim_rc.get(" ".join(argv[1:3]), 0)
        if rc == 0 and argv[1:3] == ["board", "set"] and "--new-row" in argv:
            task = argv[argv.index("--new-row") + 2]
            fields = dict(word.split("=", 1) for word in argv[argv.index("--new-row") + 3:])
            self.rows = [r for r in self.rows if r["task"] != task] + [{"task": task, "fields": fields}]
        return Done(rc, "")

    def board(self, _cfg: Any, _wave: str) -> dict[str, Any] | int:
        return self.board_rc if self.board_rc is not None else ({"tasks": self.rows} if self.rows else NO_BOARD_EXIT)

    def forget(self, _cfg: Any, _wave: str, task: str, worker: str, state: str = "pending") -> int:
        self.forget_calls.append((task, worker, state))
        rc = self.forget_rc.pop(0) if self.forget_rc else 0
        if rc in (0, 4):  # 4: the removal landed and its acknowledgement was lost
            self.rows = [r for r in self.rows if not (r["task"] == task and r["fields"].get("worker") == worker
                                                       and r["fields"].get("state") == state)]
        return rc

    @contextlib.contextmanager
    def world(self, prs: list[dict[str, Any]] | None = None) -> Generator[FakeTool]:
        def listed(_cfg: Any) -> Done:
            return Done(self.listing_rc, json.dumps(self.records))
        with (FakeTool("gh") as gh,
              mock.patch.object(waveprep, "anchor_gate", return_value=0),
              mock.patch.object(waveprep, "listing", side_effect=listed),
              mock.patch.object(waveprep, "board_status", side_effect=self.board),
              mock.patch.object(waveprep, "run", side_effect=self.board_run),
              mock.patch.object(wavelaunch, "run", side_effect=self.launch_run),
              mock.patch.object(wavelaunch, "run_on", side_effect=self.far_run),
              mock.patch.object(waveunprep, "anchor_gate", return_value=0),
              mock.patch.object(waveunprep, "listing", side_effect=listed),
              mock.patch.object(waveunprep, "board_status", side_effect=self.board),
              mock.patch.object(waveunprep, "forget_row", side_effect=self.forget),
              mock.patch.object(waveunprep, "run", side_effect=self.board_run),
              mock.patch.object(waveunprep, "run_on", side_effect=self.far_run)):
            gh.route((When(prefix=("pr", "list")), Answer(stdout=json.dumps(prs or []))))
            yield gh

    def unprep(self, task: str = "t42") -> tuple[int, str, str]:
        return captured(waveunprep.cmd_unprep, self.cfg, [self.path, task])

    def files(self, task: str = "t42") -> list[str]:
        return [p for p in (os.path.join(self.wavedir, "reserve", n) for n in (f"{task}.json", f"{task}-gpu.json", f"{task}-base.json"))
                if os.path.lexists(p)] + [p for p in (os.path.join(self.wavedir, "briefs", f"brief-{task}.md"),) if os.path.lexists(p)]

    def tombs(self, task: str = "t42") -> list[str]:
        return glob.glob(os.path.join(self.wavedir, "prep", f"{task}.unprepared-*.json"))

    def advance(self) -> str:
        repo = os.path.join(self.dir, "repo")
        git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "moved")
        git("-C", repo, "push", "-q", "origin", "main")
        return git("-C", repo, "rev-parse", "HEAD")

    def test_a_stale_prep_is_taken_back_and_prepared_again_under_its_own_id(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")[0], 0)
            self.assertEqual(len(self.files()), 4)
            tip = self.advance()
            with open(self.path) as f:
                edited = json.load(f)
            edited["legs"], edited["profiles"]["sol"]["model"] = {}, "gpt-7"  # edited since: the manifest still names what was made
            with open(self.path, "w") as f:
                json.dump(edited, f)
            rc, out, _ = self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")
            self.assertEqual(rc, 1, "without the verb the task can only be prepared under a new id")
            self.assertIn("a prep manifest", out)
            self.shim_calls.clear()
            rc, out, err = self.unprep()
            self.assertEqual(rc, 0, out + err)
            self.assertIn("WAVE UNPREP t42: unprepared: ", out)
            self.assertEqual(self.files(), [], "every file prep wrote, the leg's payload the edited wave file no longer names included")
            self.assertEqual(self.rows, [])
            self.assertEqual(self.forget_calls, [("t42", "w1-42", "pending")])
            self.assertEqual(self.far_calls, [], "a remote task's worktree path is read, and nothing is made or removed there")
            [tomb] = self.tombs()
            with open(tomb) as f:
                self.assertEqual(json.load(f)["done"][-2:], ["ready", "unprepare"])
            self.assertEqual([c[:2] for c in self.shim_calls], [["board", "log"]])
            rc, out, _ = self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")
            self.assertEqual(rc, 0, out)
            self.assertEqual(self.manifest()["base"], tip, "prepared again at the moved tip, under its own id")
            self.assertEqual(self.unprep()[0], 0, "and it can be taken back again")

    def test_a_local_scratch_is_removed_when_empty_and_left_when_not(self) -> None:
        scratch = os.path.join(self.wavedir, "scratch", "t42")
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol")[0], 0)
            self.assertTrue(os.path.isdir(os.path.join(scratch, "runs")))
            self.assertEqual(self.unprep()[0], 0)
            self.assertFalse(os.path.lexists(scratch))
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol")[0], 0)
            with open(os.path.join(scratch, "notes"), "w") as f:
                f.write("kept\n")
            rc, out, _ = self.unprep()
            self.assertEqual(rc, 0, out)
            self.assertIn(f"WAVE UNPREP NOTE t42: {scratch} is left", out)
            self.assertTrue(os.path.exists(os.path.join(scratch, "notes")) and not os.path.lexists(os.path.join(scratch, "runs")))
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol")[0], 0, "prep takes a scratch left as it is")

    def test_a_prep_that_failed_part_way_is_taken_back(self) -> None:
        with self.world():
            self.shim_rc = {"board set": 1}
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 1)
            self.shim_rc = {}
            self.assertEqual(self.manifest()["done"][-1][:6], "brief ")
            rc, out, _ = self.unprep()
            self.assertEqual(rc, 0, out)
            self.assertEqual(self.files(), [])
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 0)

    def test_a_run_twice_and_an_interrupted_run_end_unprepared(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 0)
            self.forget_rc = [4]
            rc, out, _ = self.unprep()
            self.assertEqual(rc, 4, out)
            self.assertIn("WAVE UNPREP UNKNOWN t42 at row:", out)
            self.assertIn("a re-run goes on from here", out)
            self.assertEqual(self.manifest()["done"][-1], "unprepare", "the fence: wave launch refuses the task now")
            rc, out, _ = self.start()
            self.assertEqual(rc, 1)
            self.assertIn("its prep did not finish", out)
            brief = os.path.join(self.wavedir, "briefs", "brief-t42.md")
            real_remove = os.remove

            def remove(path: str) -> None:
                if path == brief:
                    raise PermissionError(13, "Permission denied")
                real_remove(path)
            with mock.patch.object(waveunprep.os, "remove", side_effect=remove):
                rc, out, _ = self.unprep()
            self.assertEqual(rc, 1, out)
            self.assertIn("WAVE UNPREP FAILED t42 at files: cannot remove", out)
            self.assertIn("WAVE UNPREP REMOVED t42: ", out)
            self.assertTrue(os.path.exists(brief))
            rc, out, _ = self.unprep()
            self.assertEqual(rc, 0, out)
            self.assertEqual((self.files(), len(self.tombs())), ([], 1))
            self.assertEqual(self.unprep()[1], f"WAVE UNPREP t42: nothing recorded to undo (no prep manifest {self.wavedir}/prep/t42.json)\n")

    def assert_refused(self, why: str, rc: int = 1) -> None:
        before = self.manifest()
        got, out, _ = self.unprep()
        self.assertEqual(got, rc, out)
        self.assertIn(why, out)
        self.assertIn("nothing removed", out)
        self.assertEqual(self.manifest(), before, "no fence")
        self.assertEqual((len(self.files()), self.forget_calls, self.tombs()), (3, [], []))

    def test_what_may_have_launched_or_is_not_this_preps_refuses_removing_nothing(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 0)
            mine = dict(self.rows[0]["fields"])
            os.makedirs(os.path.join(self.wavedir, "logs"), exist_ok=True)
            ledger = os.path.join(self.wavedir, "logs", "drive.jsonl")
            with open(ledger, "w") as f:
                f.write(json.dumps({"task": "t42", "worker": "", "session": "", "turn": -1, "status": "launching", "holds": "far"}) + "\n")
            self.assert_refused("the driver's last launch line for the task (launching) holds a slot on far")
            with open(ledger, "a") as f:
                f.write(json.dumps({"task": "t42", "worker": "", "session": "", "turn": -1, "status": "retry"}) + "\n")
            self.records = [{"request_id": "wv-t42-far-iterate", "state": "concluded"}]
            self.assert_refused("the registry holds wv-t42-far-iterate (concluded): a launch reserved it")
            self.records = []
            for fields, word in (({**mine, "state": "launched"}, "state='launched'"), ({**mine, "worker": "w1-99"}, "worker='w1-99'")):
                self.rows = [{"task": "t42", "fields": fields}]
                self.assert_refused(f"the board's row for t42 is {word}" if word.startswith("state") else word)
            self.rows = [{"task": "t42", "fields": mine}]
            self.far_state = Done(0, f"worktree={self.base} dirty=0\n")
            self.assert_refused("exists on far (worktree=")
            self.far_state = Done(UNREACHABLE, "")
            self.assert_refused("WAVE UNPREP UNKNOWN t42: the worktree path", 4)
            self.far_state = Done(0, "worktree=absent\n")
            self.listing_rc = 1
            self.assert_refused("WAVE UNPREP UNKNOWN t42: the anchor's registry could not be read", 4)
            self.listing_rc, self.board_rc = 0, 4
            self.assert_refused("the board of wv could not be read", 4)
            self.board_rc = None
            repo = os.path.join(self.dir, "repo")
            git("-C", repo, "push", "-q", "origin", "main:refs/heads/codex/w1-42")
            self.assert_refused("branch codex/w1-42 exists on origin")
            git("-C", repo, "push", "-q", "origin", ":refs/heads/codex/w1-42")
            brief = os.path.join(self.wavedir, "briefs", "brief-t42.md")
            os.rename(brief, brief + ".kept")
            os.mkdir(brief)
            self.assert_refused("is no regular file")
            os.rmdir(brief)
            os.rename(brief + ".kept", brief)
            manifest = self.manifest()
            with open(os.path.join(self.wavedir, "prep", "t42.json"), "w") as f:
                json.dump({**manifest, "done": [*manifest["done"], "worktree /x on branch b at c"]}, f)
            self.assert_refused("records a step no CLI prep writes ('worktree /x")
            with open(os.path.join(self.wavedir, "prep", "t42.json"), "w") as f:
                json.dump({**manifest, "done": [*manifest["done"], "launched far/w1-42"]}, f)
            self.assert_refused("records a launch")

    def test_a_file_of_the_same_name_another_task_wrote_is_never_removed(self) -> None:
        """A prep that stopped before its leg payload; then task t42-gpu's own payload takes that name."""
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far", "--legs", "gpu-box")[0], 0)
            other = os.path.join(self.wavedir, "reserve", "t42-gpu.json")
            with open(other, "w") as f:
                json.dump({"request_id": "wv-t42-gpu-far-iterate", "worker": "w1-t42-gpu"}, f)
            before = self.manifest()
            rc, out, _ = self.unprep()
            self.assertEqual(rc, 1, out)
            self.assertIn(f"WAVE UNPREP REFUSED t42: {other} does not name request_id wv-t42-gpu-box-iterate, as this prep's does", out)
            self.assertEqual((self.manifest(), len(self.files()), self.forget_calls), (before, 4, []))
            with open(os.path.join(self.wavedir, "reserve", "t42-base.json"), "w") as f:
                json.dump({"worker": "w1-t42-base"}, f)
            os.remove(other)
            rc, out, _ = self.unprep()
            self.assertEqual(rc, 1, out)
            self.assertIn("t42-base.json does not name worker w1-42", out)

    def test_a_native_task_is_refused_loudly(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t43", "--base", "main", "--profile", "opus")[0], 0)
            rc, out, _ = self.unprep("t43")
        self.assertEqual(rc, 1, out)
        self.assertIn("WAVE UNPREP REFUSED t43: a subagent task: its prep took a worktree, a branch and standing reservations", out)
        self.assertIn("prepare it again under a new task id; nothing removed", out)
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "repo-worktrees", "w1-43")))
        self.assertEqual(self.forget_calls, [])

    def test_the_task_lock_keeps_prep_launch_and_unprep_apart(self) -> None:
        with self.world():
            self.assertEqual(self.prep("t42", "--base", "main", "--profile", "sol", "--host", "far")[0], 0)
            with open(os.path.join(self.wavedir, "prep", "t42.lock"), "a") as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                for verb, call in (("UNPREP", self.unprep), ("LAUNCH", self.start)):
                    rc, out, _ = call()
                    self.assertEqual(rc, 1, out)
                    self.assertIn(f"WAVE {verb} REFUSED t42: another wave prep, launch or unprep of the task holds", out)
                rc, out, _ = self.prep("t44", "--issue", "42", "--base", "main", "--profile", "sol")
                self.assertNotIn("holds", out, "another task's lock is its own")
            self.assertEqual((self.forget_calls, len(self.files())), ([], 3))
            self.assertEqual(self.unprep()[0], 0)


class Verdict(unittest.TestCase):
    """#1108: the verdict line parsed whole, never matched; anything else is unreadable, which blocks."""

    def read(self, last: str, body: str = "### Review checkpoint (at-open): head 12345678\n\nA finding.\n\n") -> tuple[str, int, int, bool]:
        got = wavereview.parse_verdict(body + last)
        return got.word, got.blocking, got.suggestions, got.blocks

    def test_the_line_is_read_whole_and_only_the_blocking_count_decides(self) -> None:
        cases = {
            "VERDICT: blocking (1 blocking, 2 suggestions)": ("blocking", 1, 2, True),  # the line a pattern read as "suggestions"
            "VERDICT: blocking (0 blocking, 3 suggestions)": ("blocking", 0, 3, False),
            "VERDICT: suggestions (0 blocking, 3 suggestions)": ("suggestions", 0, 3, False),
            "VERDICT: suggestions": ("suggestions", 0, 0, False),
            "VERDICT: clean": ("clean", 0, 0, False),
            "VERDICT: clean (0 blocking, 0 suggestions)": ("clean", 0, 0, False),
            "VERDICT: clean  \n\n": ("clean", 0, 0, False),
        }
        for last, want in cases.items():
            self.assertEqual(self.read(last), want, last)

    def test_anything_else_is_unreadable_and_blocks(self) -> None:
        for last in ("", "VERDICT: blocking", "VERDICT: blocking (1 blocking", "VERDICT: block", "verdict: clean",
                     "`VERDICT: clean`", " VERDICT: clean", "VERDICT: clean.", "VERDICT: clean (1 blocking, 0 suggestions)",
                     "VERDICT: suggestions (2 blocking, 1 suggestions)", "VERDICT: blocking (01 blocking, 2 suggestions)",
                     "VERDICT: blocking (-1 blocking, 2 suggestions)", "VERDICT: clean\nThanks.",
                     "VERDICT: blocking (1 blocking, 2 suggestions) or clean", "Overall: VERDICT: clean"):
            self.assertEqual(self.read(last), ("unreadable", 0, 0, True), repr(last))
        self.assertEqual(wavereview.parse_verdict("").word, "unreadable")

    def test_the_decision_table(self) -> None:
        clean, blocking = wavereview.parse_verdict("VERDICT: clean"), wavereview.parse_verdict("VERDICT: blocking (2 blocking, 0 suggestions)")
        table = {("at-open", clean): "merge", ("at-open", blocking): "confirm", ("confirm", clean): "cleared",
                 ("confirm", blocking): "findings", ("at-open", wavereview.UNREADABLE): "unreadable",
                 ("confirm", wavereview.UNREADABLE): "unreadable"}
        for (kind, verdict), want in table.items():
            self.assertEqual(wavereview.decision_of(kind, verdict), want, (kind, verdict.word))


REVIEW_TEXT = "### Review checkpoint (at-open): head {sha8}\n\n**A claim that cannot fail** (blocking), `a.ml:3`: ...\n\n{verdict}"
COMMENT = "https://github.com/o/staging/pull/7#issuecomment-1"


class Review(WaveDirCase):
    def setUp(self) -> None:
        super().setUp()
        with open(self.path, "w") as f:
            json.dump(wave_data(self.dir, vars={"COORD": "session-1", "MAIN": "main"},
                                review={"kind": "claude", "model": "opus", "label": "Claude Opus 5.5"}), f)
        self.comment_rc = 0

    def helper_run(self, argv: list[str], **_: Any) -> Done:
        """The verb's two outside writes: pr-review.sh comment (its stdout the URL) and board set."""
        self.shim_calls.append([os.path.basename(argv[0]), *argv[1:]])
        if argv[1] == "comment":
            return Done(self.comment_rc, COMMENT + "\n" if self.comment_rc == 0 else "")
        return Done(self.shim_rc.get(" ".join(argv[1:3]), 0), "")

    @contextlib.contextmanager
    def world(self, verdict: str = "VERDICT: blocking (1 blocking, 2 suggestions)", head: str = "", state: str = "OPEN",
              reviewer: Answer | None = None, gate: int = 0) -> Generator[tuple[FakeTool, mock.Mock]]:
        said = REVIEW_TEXT.format(sha8=self.base[:8], verdict=verdict)
        with (FakeTool("gh") as gh, FakeTool("claude") as claude,
              mock.patch.object(wavereview, "anchor_gate", return_value=gate) as gated,
              mock.patch.object(wavereview, "run", side_effect=self.helper_run)):
            gh.route((When(prefix=("pr", "view")), Answer(stdout=json.dumps({"state": state, "headRefOid": head or self.base}))))
            claude.script(reviewer or Answer(stdout=json.dumps({"type": "result", "is_error": False, "result": said})))
            self.claude = claude
            yield gh, gated

    def review(self, *args: str, task: str = "t42", kind: str = "at-open", sha: str = "") -> tuple[int, str, str]:
        return captured(wavereview.cmd_review, self.cfg, [self.path, task, "7", sha or self.base, "--kind", kind, *args])

    def stem(self, kind: str = "at-open") -> str:
        return os.path.join(self.wavedir, "reviews", f"7-{kind}-{self.base[:12]}")

    def read(self, path: str) -> str:
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_a_blocking_at_open_review_is_posted_and_asks_for_a_confirm(self) -> None:
        with self.world() as (gh, gated):
            rc, out, err = self.review()
            asked, ran = gh.calls(), self.claude.calls()
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(out, f"WAVE REVIEW t42: o/staging#7 at-open at {self.base[:8]}: verdict=blocking blocking=1 suggestions=2"
                              f" decision=confirm comment={COMMENT} message={self.stem()}.message.md\n")
        gated.assert_called_once_with(self.cfg, "WAVE REVIEW", "t42", True)
        self.assertEqual(asked, [["pr", "view", "7", "--repo", "o/staging", "--json", "state,headRefOid"]] * 2,
                         "the PR is read before the reviewer runs and again before its review is posted")
        self.assertEqual(len(ran), 1)
        self.assertEqual(ran[0][:5], ["-p", "--model", "opus", "--output-format", "json"])
        allowed = ran[0][ran[0].index("--allowedTools") + 1:ran[0].index("--disallowedTools")]
        self.assertEqual(ran[0][ran[0].index("--disallowedTools") + 1:], ["Edit", "Write", "NotebookEdit"])
        repo = os.path.join(self.dir, "repo")
        self.assertIn(f"Bash(git -C {repo} show:*)", allowed)
        self.assertIn("Bash(gh pr diff:*)", allowed)
        # READ-ONLY is the tool list: no bare git or gh, and no verb that moves a checkout or writes to GitHub.
        for entry in allowed:
            self.assertNotIn(entry, ("Bash(git:*)", "Bash(gh:*)", "Bash", "Bash(*)"))
            for verb in (" checkout", " reset", " push", " commit", " stash", " fetch", "pr comment", "pr merge", "gh api", "pr review"):
                self.assertNotIn(verb, entry)
        prompt = self.read(self.stem() + ".prompt.md")
        for want in (f"o/staging#7, head `{self.base}`", "delegation wave wv", "The PR is for issue o/up#42",
                     "`gh issue view 42 --repo o/up --json number,title,body,comments`", f"show origin/main:<path>",
                     f"### Review checkpoint (at-open): head {self.base[:8]}", "VERDICT: blocking (<n> blocking, <m> suggestions)"):
            self.assertIn(want, prompt)
        self.assertNotIn("confirm review", prompt)
        self.assertNotIn("@@", prompt)
        self.assertEqual(self.shim_calls, [
            ["pr-review.sh", "comment", "o/staging#7", "--body-file", self.stem() + ".md", "--coordinator", "Claude Opus 5.5 review checkpoint"],
            ["fleet-worker.sh", "board", "set", "wv", "t42", f"review=blocking@{self.base[:8]}"]])
        self.assertTrue(self.read(self.stem() + ".md").endswith("VERDICT: blocking (1 blocking, 2 suggestions)\n"))
        message = self.read(self.stem() + ".message.md")
        self.assertTrue(message.startswith(f"REVIEW_POSTED 7 {self.base}\nVERDICT: blocking (1 blocking, 2 suggestions)\n"))
        self.assertIn("end your turn with `CONFIRM_REQUEST 7 <head sha>`", message)
        self.assertIn(COMMENT, message)
        record = json.loads(self.read(self.stem() + ".json"))
        self.assertEqual((record["decision"], record["comment"], record["dry_run"], record["verdict"]["blocking"]),
                         ("confirm", COMMENT, False, 1))

    def test_a_verdict_that_does_not_block_says_merge_and_an_unreadable_one_never_does(self) -> None:
        for verdict, word, decision, said in (
                ("VERDICT: suggestions (0 blocking, 2 suggestions)", "suggestions", "merge", "with no CONFIRM_REQUEST"),
                ("VERDICT: clean", "clean", "merge", "with no CONFIRM_REQUEST"),
                ("Looks fine overall, VERDICT: clean I think", "unreadable", "unreadable", "no readable verdict line, so it is taken as blocking")):
            with self.subTest(verdict):
                shutil.rmtree(os.path.join(self.wavedir, "reviews"), ignore_errors=True)
                with self.world(verdict=verdict):
                    rc, out, _ = self.review()
                self.assertEqual(rc, 0, out)
                self.assertIn(f"verdict={word} ", out)
                self.assertIn(f"decision={decision} ", out)
                message = self.read(self.stem() + ".message.md")
                self.assertIn(said, message)
                self.assertEqual("CONFIRM_REQUEST 7 <head sha>" in message, decision == "unreadable")

    def test_a_review_made_is_never_bought_twice(self) -> None:
        with self.world():
            self.assertEqual(self.review()[0], 0)
            self.shim_calls.clear()
            rc, out, _ = self.review()
            self.assertEqual((rc, len(self.claude.calls()), self.shim_calls), (0, 1, []))
            self.assertTrue(out.endswith(" (already reviewed; --again starts a new round on this head)\n") and f"comment={COMMENT}" in out, out)

    def test_a_post_that_failed_is_posted_by_the_rerun_without_another_review(self) -> None:
        with self.world() as (gh, _):
            self.comment_rc = 1
            rc, out, _ = self.review()
            self.assertEqual(rc, 1)
            self.assertIn("pr-review.sh comment exit 1: the review is not posted", out)
            self.assertEqual(json.loads(self.read(self.stem() + ".json"))["comment"], "")
            self.assertFalse(os.path.exists(self.stem() + ".message.md"), "no message tells a worker of a review nobody can read")
            self.comment_rc = 0
            rc, out, _ = self.review()
            self.assertEqual((rc, len(self.claude.calls()), len(gh.calls())), (0, 1, 3), out)
            self.assertIn(f"decision=confirm comment={COMMENT}", out)

    def test_a_recorded_review_is_not_posted_on_a_pr_that_moved_or_closed(self) -> None:
        with self.world():
            self.assertEqual(self.review("--dry-run")[0], 0)
        for head, state, why in ((C, "OPEN", f"the PR's head is {C}, not {self.base}"), ("", "CLOSED", "the PR is CLOSED, not open")):
            with self.world(head=head, state=state):
                rc, out, _ = self.review()
                self.assertEqual((rc, self.claude.calls(), self.shim_calls), (1, [], []), out)
                self.assertIn(why, out)
                self.assertIn("not posted (a dry run)", self.read(self.stem() + ".message.md"), "the dry run's message stands")

    def test_a_second_call_on_the_same_head_is_refused_while_the_first_holds_it(self) -> None:
        os.makedirs(os.path.join(self.wavedir, "reviews"))
        with open(self.stem() + ".lock", "a") as held, self.world():
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            rc, out, _ = self.review()
            self.assertEqual((rc, self.claude.calls(), self.shim_calls), (1, [], []), out)
            self.assertIn("another call is reviewing this head", out)
            self.assertEqual(self.review(kind="confirm")[0], 1, "the lock is the kind's too: a confirm is its own call")
        with self.world():
            self.assertEqual(self.review()[0], 0, "a lock nobody holds refuses nothing")

    def test_an_ambiguous_post_is_no_verdict_and_posted_records_the_comment_found(self) -> None:
        with self.world():
            self.comment_rc = 3
            rc, out, _ = self.review()
            self.assertEqual(rc, 4)
            self.assertIn("WAVE REVIEW NO VERDICT t42: o/staging#7 at-open", out)
            self.assertIn("re-run with --posted <its URL>", out)
            self.shim_calls.clear()
            rc, out, _ = self.review("--posted", "https://github.com/o/staging/pull/7#issuecomment-9")
            self.assertEqual(rc, 0, out)
            self.assertIn("comment=https://github.com/o/staging/pull/7#issuecomment-9", out)
            rc, out, _ = self.review("--posted", "https://github.com/o/staging/pull/7#issuecomment-9", kind="confirm")
            self.assertEqual((rc, len(self.claude.calls())), (1, 1), "--posted reviews nothing")
            self.assertIn("--posted names a comment, and no review of this head is recorded", out)
            self.assertEqual([c[:3] for c in self.shim_calls], [["fleet-worker.sh", "board", "set"]], "nothing is posted again")

    def test_a_head_the_pr_left_or_a_closed_pr_is_refused_before_the_reviewer(self) -> None:
        for head, state, why in ((C, "OPEN", f"the PR's head is {C}, not {self.base}"), ("", "MERGED", "the PR is MERGED, not open")):
            with self.world(head=head, state=state):
                rc, out, _ = self.review()
                self.assertEqual((rc, self.claude.calls(), self.shim_calls), (1, [], []), out)
                self.assertIn(f"WAVE REVIEW REFUSED t42: o/staging#7 at-open at {self.base[:8]}: {why}", out)
        with self.world(gate=1):
            self.assertEqual((self.review()[0], self.claude.calls()), (1, []), "without the lease nothing is reviewed")
        rc, _, err = self.review(sha="abc")
        self.assertEqual(rc, 2)
        self.assertIn("the head is a full commit SHA", err)

    def test_a_head_that_is_no_commit_of_the_checkout_is_fetched_and_else_refused(self) -> None:
        with self.world(head=C):
            rc, out, _ = self.review(sha=C)
            self.assertEqual((rc, self.claude.calls()), (4, []), out)
            self.assertIn("refs/pull/7/head could not be fetched", out)

    def test_a_dry_run_reviews_and_writes_but_posts_nothing_and_a_real_call_posts_its_review(self) -> None:
        with self.world(state="MERGED") as (_, gated):
            rc, out, _ = self.review("--dry-run")
            self.assertEqual(rc, 0, out)
            self.assertIn("WAVE REVIEW NOTE t42: the PR is MERGED, not open (--dry-run goes on)", out)
            self.assertIn("decision=confirm comment=- message=", out)
            gated.assert_not_called()
            self.assertEqual(self.shim_calls, [])
            self.assertIn("not posted (a dry run)", self.read(self.stem() + ".message.md"))
            self.assertTrue(json.loads(self.read(self.stem() + ".json"))["dry_run"])
        with self.world():
            rc, out, _ = self.review()
            self.assertEqual((rc, self.claude.calls()), (0, []), out)
            self.assertIn(f"comment={COMMENT}", out)

    def test_a_reviewer_that_does_not_answer_is_no_verdict(self) -> None:
        for reviewer, why in ((Answer(rc=1, stderr="authentication_failed"), "the reviewer (claude) exited 1 (authentication_failed)"),
                              (Answer(stdout=json.dumps({"is_error": True, "result": "x"})), "ended with no final message"),
                              (Answer(stdout=json.dumps({"is_error": False, "result": "  "})), "ended with no final message"),
                              (Answer(stdout="not json"), "ended with no final message")):
            with self.world(reviewer=reviewer):
                rc, out, _ = self.review()
                self.assertEqual((rc, self.shim_calls), (4, []), out)
                self.assertIn(why, out)
                self.assertFalse(os.path.exists(self.stem() + ".json"))

    def test_a_confirm_reads_the_at_open_review_and_clears_or_holds_the_merge(self) -> None:
        with self.world():
            rc, out, _ = self.review(kind="confirm")
            self.assertEqual((rc, self.claude.calls()), (1, []))
            self.assertIn("no at-open review of #7 is recorded", out)
            self.assertEqual(self.review()[0], 0)
        git("-C", os.path.join(self.dir, "repo"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "fix")
        fixed = git("-C", os.path.join(self.dir, "repo"), "rev-parse", "HEAD")
        stem = os.path.join(self.wavedir, "reviews", f"7-confirm-{fixed[:12]}")
        with self.world(verdict="VERDICT: clean", head=fixed):
            self.shim_calls.clear()
            rc, out, _ = self.review(kind="confirm", sha=fixed)
            self.assertEqual(rc, 0, out)
            self.assertIn("verdict=clean blocking=0 suggestions=0 decision=cleared", out)
            prompt = self.read(stem + ".prompt.md")
            for want in ("This is a confirm review, not a first review", f"at head `{self.base}`", f"`{self.stem()}.md`",
                         f"diff {self.base} {fixed}", f"### Review checkpoint (confirm): head {fixed[:8]}"):
                self.assertIn(want, prompt)
            self.assertTrue(self.read(stem + ".message.md").startswith(f"MERGE CLEARED 7 {fixed}\nVERDICT: clean\n"))
            self.assertEqual(self.shim_calls[-1], ["fleet-worker.sh", "board", "set", "wv", "t42", f"confirm=clean@{fixed[:8]}"])
        os.remove(stem + ".json")
        with self.world(verdict="VERDICT: blocking (1 blocking, 0 suggestions)", head=fixed):
            rc, out, _ = self.review(kind="confirm", sha=fixed)
            self.assertIn("decision=findings", out)
            message = self.read(stem + ".message.md")
            self.assertTrue(message.startswith(f"MERGE NOT CLEARED 7 {fixed}\n"))
            self.assertIn("CONFIRM_REQUEST 7 <head sha>", message)

    def test_a_new_round_on_the_same_head_is_asked_for_and_never_inferred(self) -> None:
        """A rebuttal moves no head: the worker's next confirm request names the SHA already reviewed."""
        with self.world():
            self.assertEqual(self.review()[0], 0)
        with self.world(verdict="VERDICT: blocking (1 blocking, 0 suggestions)"):
            rc, out, _ = self.review(kind="confirm")
            self.assertIn("decision=findings", out)
        with self.world(verdict="VERDICT: clean"):
            rc, out, _ = self.review(kind="confirm")
            self.assertEqual((rc, self.claude.calls()), (0, []), "the same call replays: a lost line buys no review")
            self.assertIn("decision=findings", out)
            self.shim_calls.clear()
            rc, out, _ = self.review("--again", kind="confirm")
            self.assertEqual((rc, len(self.claude.calls())), (0, 1), out)
            self.assertIn("verdict=clean blocking=0 suggestions=0 decision=cleared", out)
            self.assertEqual(self.shim_calls[0][:2], ["pr-review.sh", "comment"], "the new round is posted")
            self.assertTrue(self.read(self.stem("confirm") + ".message.md").startswith(f"MERGE CLEARED 7 {self.base}\n"))
            earlier = json.loads(self.read(self.stem("confirm") + ".r1.json"))
            self.assertEqual((earlier["decision"], earlier["comment"]), ("findings", COMMENT), "the earlier round is kept, set aside")
            self.assertTrue(os.path.exists(self.stem("confirm") + ".r1.md") and os.path.exists(self.stem("confirm") + ".r1.prompt.md"))
            rc, out, _ = self.review("--again", kind="confirm")
            self.assertEqual((rc, len(self.claude.calls())), (0, 2), "each --again is a round")
            self.assertTrue(os.path.exists(self.stem("confirm") + ".r2.json"))
        os.remove(self.stem() + ".json")
        with self.world():
            rc, out, _ = self.review("--again")
            self.assertEqual((rc, self.claude.calls()), (1, []))
            self.assertIn("--again starts a new round after a posted review, and this head has none posted", out)
        for args in (["--again", "--dry-run"], ["--again", "--posted", "https://x"]):
            rc, _, err = self.review(*args)
            self.assertEqual(rc, 2)
            self.assertIn("--again starts a new round, to be reviewed and posted", err)

    def test_a_confirm_after_a_review_that_did_not_block_clears_without_a_reviewer(self) -> None:
        with self.world(verdict="VERDICT: suggestions (0 blocking, 1 suggestions)"):
            self.assertEqual(self.review()[0], 0)
            rc, out, _ = self.review(kind="confirm")
            self.assertEqual((rc, len(self.claude.calls())), (0, 1), out)
            self.assertIn("decision=cleared", out)
            self.assertIn("was not blocking, so there is nothing to confirm", self.read(self.stem("confirm") + ".md"))

    def test_a_source_task_is_judged_against_its_brief(self) -> None:
        with self.world():
            rc, out, _ = self.review("--source", "1910", task="p8")
            self.assertEqual((rc, self.claude.calls()), (1, []))
            self.assertIn(f"a --source task is judged against its brief, and {self.wavedir}/briefs/brief-p8.md is no file", out)
            os.makedirs(os.path.join(self.wavedir, "briefs"))
            self.write("briefs/brief-p8.md", "## The task\n")
            rc, out, _ = self.review("--source", "1910", task="p8")
            self.assertEqual(rc, 0, out)
            prompt = self.read(self.stem() + ".prompt.md")
            self.assertIn("proposed by the work on\no/up#1910", prompt)
            self.assertIn(f"`{self.wavedir}/briefs/brief-p8.md`", prompt)
            self.assertNotIn("gh issue view", prompt)

    def test_the_project_part_is_the_waves_or_the_bases_copy(self) -> None:
        repo = os.path.join(self.dir, "repo")
        os.makedirs(os.path.join(repo, ".github"))
        with open(os.path.join(repo, ".github", "review.md"), "w") as f:
            f.write("## This project\n\nHold @@REPO@@ to its goldens.\n")
        git("-C", repo, "add", ".github/review.md")
        git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "review part")
        data = wave_data(self.dir, vars={"COORD": "s", "MAIN": "main"},
                         review={"kind": "claude", "model": "opus", "project_part": ".github/review.md"})
        with open(self.path, "w") as f:
            json.dump(data, f)
        with self.world():
            rc, out, _ = self.review("--dry-run")
            self.assertEqual(rc, 1, out)
            self.assertIn("the project's review part .github/review.md cannot be read", out)
            git("-C", repo, "push", "-q", "origin", "main")
            rc, out, _ = self.review("--dry-run")
            self.assertEqual(rc, 0, out)
            self.assertIn("Hold o/staging to its goldens.", self.read(self.stem() + ".prompt.md"))
            os.remove(self.stem() + ".json")
            os.makedirs(os.path.join(self.wavedir, "review"))
            self.write("review/project.md", "## This wave\n\nOnly the scans.\n")
            self.write("review/issue.md", "## The task\n\nIssue @@ISSUE@@, this wave's wording.\n")
            rc, out, _ = self.review("--dry-run")
            prompt = self.read(self.stem() + ".prompt.md")
            self.assertIn("Only the scans.", prompt)
            self.assertNotIn("goldens", prompt)
            self.assertIn("Issue o/up#42, this wave's wording.", prompt)
            self.write("review/project.md", "@@WT@@\n")
            os.remove(self.stem() + ".json")
            rc, out, _ = self.review("--dry-run")
            self.assertEqual(rc, 1)
            self.assertIn("the prompt does not render", out)

    def test_the_wave_file_names_the_reviewer_or_the_verb_refuses(self) -> None:
        good = wave_data("/tmp/x", review={"kind": "claude", "model": "opus"})
        parsed = wave.parse_wave("/tmp/x/wave.json", good).review
        assert parsed is not None
        self.assertEqual((parsed.label, parsed.timeout, parsed.project_part), ("opus", 1800, ""))
        for review, word in (({"kind": "codex", "model": "x"}, "review.kind must be one of claude"), ({"kind": "claude"}, "review lacks model"),
                             ({"kind": "claude", "model": "opus", "extra": 1}, "unknown key"),
                             ({"kind": "claude", "model": "opus (best)"}, "does not match"),
                             ({"kind": "claude", "model": "opus", "timeout": 0}, "positive whole number"),
                             ({"kind": "claude", "model": "opus", "project_part": "/abs.md"}, "relative to the checkout"), ("opus", "must be an object")):
            with self.assertRaises(ValueError) as caught:
                wave.parse_wave("/tmp/x/wave.json", {**good, "review": review})
            self.assertIn(word, str(caught.exception))
        for data, why in ((wave_data(self.dir, vars={"MAIN": "main"}), "names no reviewer"),
                          (wave_data(self.dir, review={"kind": "claude", "model": "opus"}), "names no vars.MAIN")):
            with open(self.path, "w") as f:
                json.dump(data, f)
            rc, _, err = self.review()
            self.assertEqual(rc, 2)
            self.assertIn(why, err)

    def test_usage(self) -> None:
        for args, why in ((["--kind", "final"], "--kind is one of at-open, confirm"), ([], "--kind is one of"), (["--kind"], "--kind needs a value"),
                          (["--kind", "at-open", "--force"], "unknown option --force"),
                          (["--kind", "at-open", "--dry-run", "--posted", "https://x"], "--posted records a comment a real call left"),
                          (["--kind", "at-open", "--issue", "1", "--source", "2"], "--issue and --source exclude each other")):
            rc, _, err = captured(wavereview.cmd_review, self.cfg, [self.path, "t42", "7", self.base, *args])
            self.assertEqual(rc, 2, args)
            self.assertIn(why, err)
        rc, _, err = captured(wavereview.cmd_review, self.cfg, [self.path, "t42", "7"])
        self.assertIn("name the wave file, the task, the PR and its head", err)
        rc, _, err = captured(wavereview.cmd_review, self.cfg, [self.path, "t42", "seven", self.base, "--kind", "at-open"])
        self.assertIn("a PR is its number", err)


HEADINGS = ("## Who you are and where you work", "## Startup (first thing, before reading the issue)", "## The task",
            "## Running tests", "## Requests: anything beyond your standing reservations",
            "## Blocking rule (the one that costs the most when broken)", "## Keeping your context lean (this is a regular-mode wave)",
            "## Landing: ship-pr", "## The review checkpoint", "## After the merge")


class ShippedTemplate(unittest.TestCase):
    """The shipped template renders for a minimal ludics wave file with this checkout's project
    part, for an issue task in each planning mode and for a --source task: no placeholder left."""

    def test_each_shipped_kind_renders_whole_with_every_section_in_order(self) -> None:
        """Native Claude and Codex briefs and a Codex CLI worker's: the kind's own parts and the shared
        ones, an issue task and a --source task, with the review checkpoint and without."""
        root = os.path.dirname(os.path.dirname(waveprep.TEMPLATES))
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "tasks"))
            with open(os.path.join(root, ".github", "wave-brief.md")) as f, open(os.path.join(d, "project.md"), "w") as g:
                g.write(f.read())
            for task in ("t7", "p8"):
                with open(os.path.join(d, "tasks", f"{task}.md"), "w") as f:
                    f.write("# Task @@T@@\n")
            data: dict[str, Any] = {
                "wave": "wave-x-ludics", "repository": "lukstafi/ludics", "checkout": "/home/u/ludics",
                "worker_prefix": "wx", "agent_host": "mac-studio", "transport": "subagent", "kind": "claude",
                "standing_purpose": "standing iteration for @@T@@", "vars": {"COORDINATOR": "local_c", "MAIN": "main"},
                "profiles": {"sol": {"transport": "cli", "kind": "codex"},
                             "native": {"transport": "subagent", "kind": "codex"}},
                "hosts": {"rog": {"checkout": "/srv/ludics", "scratch": "/srv/scratch"}}}
            for review in (False, True):
                w = wave.parse_wave(os.path.join(d, "wave.json"), {**data, **({"review": {"kind": "claude", "model": "opus"}} if review else {})})
                for profile, host in (("", ""), ("sol", "rog"), ("native", "")):
                    for task, number, issue, source in (("t7", "7", "lukstafi/ludics#7", ""), ("p8", "9", "", "lukstafi/ludics#9")):
                        with self.subTest(review=review, profile=profile, task=task):
                            prep = waveprep.Prep(w, task, number, issue, source, A, "none", [], set(), "/state", profile, host)
                            brief = waveprep.brief_text(prep)
                            self.assertNotIn("@@", brief)
                            found = [line for line in brief.split("\n") if line.startswith("## ") and line in HEADINGS]
                            self.assertEqual(found, [h for h in HEADINGS if review or h != "## The review checkpoint"])
                            self.assertEqual(brief.count("REVIEW_REQUEST <PR number> <head sha>"), 1 if review else 0)
                            self.assertIn(f"`HANDBACK {task}`", brief)
                            self.assertIn('"purpose":"<what the run is for, in one line>"', brief)
                            self.assertIn("never borrow, copy or export a credential from another box, file or account", brief)
                            self.assertIn("fails on authentication or", brief)
                            self.assertIn("Any other failed push is not that gate.", brief)
                            self.assertIn("`pr-review.sh rerun lukstafi/ludics#<pr> <run id>...`", brief)
                            self.assertEqual(brief.count("- Credentials:"), 1, "a rule both transports follow is stated once")
                            if profile == "native":
                                self.assertIn("You are a native Codex worker", brief)
                                self.assertIn("`send_message`", brief)
                                self.assertIn("`write_stdin`", brief)
                                own = brief.split("## Running tests")[1].split("## Landing: ship-pr")[0]
                                self.assertNotIn("bg-run.sh spawn", own)
                                self.assertNotIn("Claude Code", own)
                            elif profile:
                                self.assertIn("You are a Codex CLI worker of wave `wave-x-ludics`, task `" + task + "`", brief)
                                self.assertIn("tmux session on `rog`", brief)
                                self.assertIn("Never edit `/srv/ludics` (the project's main checkout", brief)
                                self.assertIn(f'> "/srv/scratch/wave-x-ludics/{task}/runs/<label>.log" 2>&1; echo "exit=$?"', brief)
                                self.assertIn("run in the\nforeground of your turn", brief)
                                own = brief.split("## Startup")[0] + brief.split("## Running tests")[1].split("## Requests")[0]
                                for word in ("bg-run.sh", "Claude Code", "subagent"):
                                    self.assertNotIn(word, own, "a Codex CLI worker's own parts speak of its own runtime")
                            else:
                                self.assertIn("You are a native worker (a Claude Code subagent)", brief)
                                self.assertIn("Never edit `/home/u/ludics` (the project's main checkout", brief)
                                self.assertIn('bg-run.sh spawn "' + os.path.join(d, "scratch", task) + '/runs" -- <cmd> [arg...]', brief)
                                self.assertNotIn("Codex", brief.split("## Landing: ship-pr")[0])

    def test_the_parts_are_split_as_the_code_says_and_no_kind_restates_a_shared_one(self) -> None:
        listed = {name: sorted(os.listdir(os.path.join(waveprep.TEMPLATES, name))) for name in ("shared", "native-claude", "native-codex", "cli-codex")}
        self.assertEqual(listed["shared"], sorted(waveprep.SHARED))
        self.assertEqual(listed["native-claude"], sorted(waveprep.OWN + waveprep.PLANNING))
        self.assertEqual(listed["cli-codex"], sorted(waveprep.OWN))
        self.assertEqual(listed["native-codex"], sorted(waveprep.OWN))
        self.assertEqual(set(waveprep.OWN) | set(waveprep.SHARED), set(waveprep.COMMON))
        # The shared parts name neither transport's mechanism for holding a run: that is each kind's blocking.md.
        for name in waveprep.SHARED:
            with open(os.path.join(waveprep.TEMPLATES, "shared", name)) as f:
                text = f.read()
            for word in ("bg-run.sh spawn", "bg-run.sh wait", "subagent", "codex exec"):
                self.assertNotIn(word, text, name)

    def test_a_minimal_ludics_wave_renders_every_shipped_part(self) -> None:
        root = os.path.dirname(os.path.dirname(waveprep.TEMPLATES))
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "tasks"))
            with open(os.path.join(root, ".github", "wave-brief.md")) as f, open(os.path.join(d, "project.md"), "w") as g:
                g.write(f.read())
            for task in ("t7", "p8"):
                with open(os.path.join(d, "tasks", f"{task}.md"), "w") as f:
                    f.write("# Task @@T@@\n")
            w = wave.parse_wave(os.path.join(d, "wave.json"), {
                "wave": "wave-x-ludics", "repository": "lukstafi/ludics", "checkout": "/home/u/ludics",
                "worker_prefix": "wx", "agent_host": "mac-studio", "transport": "subagent", "kind": "claude",
                "standing_purpose": "standing iteration for @@T@@", "project_part": ".github/wave-brief.md",
                "vars": {"COORDINATOR": "local_c", "MAIN": "main"}})
            cases = [("t7", "7", "lukstafi/ludics#7", "", mode) for mode in waveprep.MODES]
            cases.append(("p8", "9", "", "lukstafi/ludics#9", "none"))
            for task, number, issue, source, mode in cases:
                with self.subTest(task=task, mode=mode):
                    prep = waveprep.Prep(w, task, number, issue, source, A, mode, [], set(), "/state")
                    brief = waveprep.brief_text(prep)
                    self.assertNotIn("@@", brief)
                    self.assertIn("## Project conventions (read before editing)", brief)
                    self.assertIn("`wave-x-ludics-" + task + "-mac-studio-iterate`", brief)
                    self.assertEqual("## Paired planning" in brief, mode != "none")
                    self.assertEqual("PEER_CRITIQUE" in brief, mode == "paired+critique")


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
        self.tips = [A, A]  # explicit recovery judges even the red commit again
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-4 rog {A} /r\n"),
                        Done(0, f"TIP-RUN CONCLUDED wv-cc-4 pass rog {A} /r\n")]
        rc, out = self.drive(records, "--resume-after", "wv-cc-2")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(self.starts()), 1)
        os.unlink(os.path.join(self.dir, "loops.stop"))
        rc, out = self.drive([rec(1, "concluded", "cancelled", A)])
        self.assertEqual(rc, 1)
        self.assertIn("CANCELLED wv-cc-1", out)

    def test_resume_after_a_targeted_pass_still_judges_the_red_sha(self) -> None:
        rerun = rec(1, "concluded", "pass", A)
        rerun["request_id"] = "wv-cc-rerun-1"
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-3 rog {A} /r\n"),
                        Done(0, f"TIP-RUN CONCLUDED wv-cc-3 pass rog {A} /r\n")]
        self.tips = [A, A]
        rc, out = self.drive([rec(2, "concluded", "fail", A), rerun], "--resume-after", "wv-cc-2")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(self.starts()), 1)
        self.assertIn("--tip", self.starts()[0])

    def test_rerun_derives_a_non_integration_payload_and_separate_prefix(self) -> None:
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-rerun-1 rog {A} /r\n")]
        rc, out = self.drive([rec(2, "concluded", "fail", A)], "--rerun", "wv-cc-2", "--", "tools/repeat", "failed")
        self.assertEqual(rc, 0, out)
        start = self.starts()[0]
        self.assertEqual(start[3:], ["--id-prefix", "wv-cc-rerun", "--checkout", "/home/u/integ", "--cpu",
                                     "--", "tools/repeat", "failed"])
        with open(start[2]) as f:
            payload = json.load(f)
        self.assertNotIn("integration", payload, "a targeted pass must never replace the integration fail")
        self.assertEqual(payload["requested_revision"], A)
        self.assertEqual(payload["execution_host"], "rog")
        self.assertIn("TIP-RUN STARTED", out)

    def test_targeted_gpu_rerun_refuses_before_it_can_become_backend_evidence(self) -> None:
        data = wave_data(self.dir)
        data["loops"]["cc"]["purpose"] = "GPU integration loop, hip: tests"
        with open(self.path, "w") as f:
            json.dump(data, f)
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-rerun-1 rog {A} /r\n")]
        rc, out = self.drive([rec(2, "concluded", "fail", A)], "--rerun", "wv-cc-2", "--", "tools/repeat")
        self.assertEqual(rc, 2, out)
        self.assertIn("GPU", out)
        self.assertEqual(self.calls, [], "a targeted pass must not gain pinned_backend evidence")

    def test_rerun_refuses_a_missing_non_red_or_unreadable_revision(self) -> None:
        for records in ([], [rec(2, "concluded", "pass", A)], [rec(2, "running", "fail", A)],
                        [rec(2, "concluded", "fail", "bad")]):
            with self.subTest(records=records):
                rc, out = self.drive(records, "--rerun", "wv-cc-2", "--", "tools/repeat")
                self.assertEqual(rc, 2, out)
                self.assertEqual(self.calls, [])

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

    def test_a_stop_file_that_is_a_dangling_or_looping_link_stops_the_loop(self) -> None:
        # #1076: os.path.exists() follows the link and reads either as no stop file.
        for name, target in (("loops.stop", "nowhere"), ("loop-cc.stop", "loop-cc.stop")):
            with self.subTest(name):
                link = os.path.join(self.dir, name)
                os.symlink(target, link)
                self.answers, self.tips, self.calls = [Done(0, f"TIP-RUN STARTED wv-cc-1 rog {A} /r\n")], [A], []
                rc, out = self.drive([])
                os.unlink(link)
                self.assertEqual(rc, 0, out)
                self.assertIn("STOPPED (stop file)", out)
                self.assertEqual(self.starts(), [], "a stopped loop starts nothing")

    def test_a_red_carries_tip_run_s_halt_note_and_ends_as_any_red(self) -> None:
        note = f"matches the standing halt: its commit {A} is {A[:8]}, which the reason names; the halt's reason: red at {A[:8]}"
        self.answers = [Done(0, f"TIP-RUN STARTED wv-cc-1 rog {A} /r\n"),
                        Done(0, f"TIP-RUN CONCLUDED wv-cc-1 fail rog {A} /r\nTIP-RUN HALT wv-cc-9 other run\n"
                                f"TIP-RUN HALT wv-cc-1 {note}\n")]
        self.tips = [A]
        rc, out = self.drive([])
        self.assertEqual(rc, 1)
        self.assertIn(f"RED wv-cc-1 (fail at {A}, log /r): the coordinator's *On a red at the tip* (SKILL.md), then restart"
                      f" with --resume-after wv-cc-1 -- {note}\n", out)
        self.assertNotIn("other run", out, "only the line naming this run is carried")

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


class Decide(WaveDirCase):
    """wave decide: a decision posted under the right heading, labelled, and recorded for the ledger."""

    URL = "https://github.com/o/up/issues/2154#issuecomment-7"

    def setUp(self) -> None:
        super().setUp()
        self.comment = Done(0, self.URL + "\n")
        self.body = os.path.join(self.dir, "body.md")

    def helper(self, argv: list[str], **_: Any) -> Done:
        self.shim_calls.append([os.path.basename(argv[0]), *argv[1:]])
        return self.comment

    @contextlib.contextmanager
    def world(self, label_rc: int = 0, gate: int = 0) -> Generator[FakeTool]:
        with (FakeTool("gh") as gh, mock.patch.object(wavedecide, "anchor_gate", return_value=gate),
              mock.patch.object(wavedecide, "run", side_effect=self.helper)):
            gh.route((When(prefix=("issue", "edit")), Answer(rc=label_rc, stderr="label not found" if label_rc else "")))
            yield gh

    def decide(self, text: str, *args: str, tier: str = "mid-wave", call: str = "part 2 may add a bounded replay") -> tuple[int, str, str]:
        with open(self.body, "w") as f:
            f.write(text)
        return captured(wavedecide.cmd_decide, self.cfg, [self.path, "2154", "--tier", tier, "--call", call, "--body-file", self.body,
                                                          "--by", "Claude Fable 5.2", *args])

    def records(self) -> list[dict[str, Any]]:
        with open(os.path.join(self.wavedir, "decisions.jsonl")) as f:
            return [json.loads(line) for line in f]

    def test_a_mid_wave_call_is_posted_as_the_waves_own_labelled_and_recorded_unreviewed(self) -> None:
        with self.world() as gh:
            rc, out, err = self.decide("**Coordinator decision (wv)**: part 2 may add a bounded replay.\n", "--task", "t2154")
            self.assertEqual(rc, 0, out + err)
            self.assertEqual(self.shim_calls, [["pr-review.sh", "comment", "o/up#2154", "--body-file", self.body, "--coordinator", "Claude Fable 5.2"]])
            self.assertEqual(gh.calls(), [["issue", "edit", "2154", "--repo", "o/up", "--add-label", "design-joint"]])
            self.assertEqual(out, f"WAVE DECIDE o/up#2154: tier mid-wave recorded as unreviewed: part 2 may add a bounded replay ({self.URL})\n")
            got = self.records()[0]
            self.assertEqual({k: got[k] for k in ("issue", "tier", "task", "call", "who", "url", "status")},
                             {"issue": "o/up#2154", "tier": "mid-wave", "task": "t2154", "call": "part 2 may add a bounded replay",
                              "who": "coordinator of wv (Claude Fable 5.2)", "url": self.URL, "status": "unreviewed"})
            self.shim_calls.clear()
            rc, out, _ = self.decide("**Coordinator decision (wv)**: again.\n")
            self.assertEqual((rc, self.shim_calls, len(self.records())), (0, [], 1), "the same issue and call is the decision already made")
            self.assertIn("already recorded", out)
            rc, out, _ = self.decide("## Recommendation\n\nx\n", tier="2")
            self.assertEqual((rc, self.shim_calls, len(self.records())), (0, [], 1), "the wave's call under its other tier is the same decision")

    def test_a_retry_that_overlaps_the_first_calls_post_waits_and_reads_its_record(self) -> None:
        """The check, the post and the record are one locked step: a second call made while the first is posting cannot read an
        empty ledger. The overlapping call here is made from inside the first one's post, so it must wait, and it is seen to."""
        import fcntl
        probes: list[bool] = []

        def posting(argv: list[str], **_: Any) -> Done:
            self.shim_calls.append([os.path.basename(argv[0]), *argv[1:]])
            with open(os.path.join(self.wavedir, "decisions.lock"), "a") as other:
                try:
                    fcntl.flock(other.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    probes.append(False)
                except OSError:
                    probes.append(True)
            return self.comment

        with self.world(), mock.patch.object(wavedecide, "run", side_effect=posting):
            rc, out, _ = self.decide("**Coordinator decision (wv)**: x.\n")
            self.assertEqual((rc, probes), (0, [True]), out + ": the lock is held across the post")
            rc, out, _ = self.decide("**Coordinator decision (wv)**: x.\n")
            self.assertEqual((rc, len(self.shim_calls), len(self.records())), (0, 1, 1), "the retry, once it has the lock, finds the record")

    def test_the_maintainers_answer_to_a_call_the_wave_recorded_is_posted_and_is_the_ledgers_row(self) -> None:
        heading = "## Decision update (maintainer, via the wave coordinator)"
        with self.world():
            self.decide("## Recommendation (wv decision gate, veto-able)\n\nx\n", tier="2")
            self.shim_calls.clear()
            rc, out, _ = self.decide(f"{heading}\n\nYes.\n", tier="3")
            self.assertEqual(rc, 0, out)
            self.assertEqual(len(self.shim_calls), 1, "the maintainer's approval is no retry of the wave's recommendation")
            self.assertEqual([(e["tier"], e["status"]) for e in self.records()], [("2", "unreviewed"), ("3", "ok")])
            self.shim_calls.clear()
            self.assertEqual((self.decide(f"{heading}\n\nYes.\n", tier="3")[0], self.shim_calls, len(self.records())), (0, [], 2))
            self.decide("**Coordinator decision (wv)**: y.\n", call="another call")
        _, out, _ = captured(wavedecide.cmd_decisions, self.cfg, [self.path])
        rows = out.splitlines()[2:]
        self.assertEqual([r.split(" | ")[2:4] for r in rows], [["another call", "coordinator of wv (Claude Fable 5.2)"],
                                                              ["part 2 may add a bounded replay", "maintainer"]],
                         "the wave's row that the maintainer answered is not printed beside the maintainer's")

    def test_the_tier_and_the_heading_must_agree_on_whose_decision_it_is(self) -> None:
        heading = "## Decision update (maintainer, via the wave coordinator)"
        with self.world():
            rc, out, _ = self.decide(f"{heading}\n\nDefine all three specs.\n", tier="3", call="define all three specs")
            self.assertEqual(rc, 0, out)
            self.assertEqual(self.shim_calls[0][1:], ["comment", "o/up#2154", "--body-file", self.body], "the maintainer's answer carries no wave footer")
            self.assertEqual((self.records()[0]["who"], self.records()[0]["status"]), ("maintainer", "ok"))
            self.shim_calls.clear()
            for text, tier, why in (("## Recommendation\n\nx\n", "3", "a tier-3 body starts with the line"),
                                    (f"{heading}\n\nx\n", "2", "which reads as the maintainer's decision"),
                                    ("## Decision: refuse\n", "mid-wave", "which reads as the maintainer's decision"),
                                    ("\n\n### Decision\nx", "2", "which reads as the maintainer's decision")):
                rc, out, _ = self.decide(text, tier=tier, call="another call")
                self.assertEqual((rc, self.shim_calls), (1, []), text)
                self.assertIn(why, out)
            self.assertEqual(len(self.records()), 1)

    def test_a_post_that_fails_records_nothing_and_a_missing_label_is_a_note(self) -> None:
        with self.world(label_rc=1):
            self.comment = Done(1, "")
            rc, out, _ = self.decide("## Recommendation (wv decision gate, veto-able)\n\nx\n", tier="2")
            self.assertEqual(rc, 1)
            self.assertIn("pr-review.sh comment exit 1: nothing posted, nothing recorded", out)
            self.assertFalse(os.path.exists(os.path.join(self.wavedir, "decisions.jsonl")))
            self.comment = Done(3, "")
            rc, out, _ = self.decide("## Recommendation\n\nx\n", tier="2")
            self.assertEqual(rc, 4)
            self.assertIn("re-run with --posted <its URL>", out)
            self.shim_calls.clear()
            rc, out, _ = self.decide("## Recommendation\n\nx\n", "--posted", self.URL, tier="2")
            self.assertEqual((rc, self.shim_calls), (0, []), out)
            self.assertIn("WAVE DECIDE NOTE o/up#2154: the label design-joint was not added (gh exit 1: label not found)", out)
            self.assertEqual(self.records()[0]["url"], self.URL)
        with self.world(gate=1):
            self.assertEqual((self.decide("## Recommendation\n", tier="2", call="a third call")[0], self.shim_calls), (1, []))

    def test_decisions_prints_the_ledgers_rows_newest_first(self) -> None:
        rc, out, _ = captured(wavedecide.cmd_decisions, self.cfg, [self.path])
        self.assertEqual((rc, out), (0, "WAVE DECISIONS wv: none recorded\n"))
        with open(os.path.join(self.wavedir, "decisions.jsonl"), "w") as f:
            f.write(json.dumps({"at": "2026-11-11T16:00:00Z", "issue": "o/up#2134", "call": "a multiple | a floor", "who": "coordinator of wv (M)",
                                "url": "https://x/1", "status": "unreviewed"}) + "\nnot json\n")
            f.write(json.dumps({"at": "2026-11-11T22:40:00Z", "issue": "o/up#2154", "call": "bounded replay", "who": "maintainer",
                                "url": "https://x/2", "status": "ok"}) + "\n")
        rc, out, _ = captured(wavedecide.cmd_decisions, self.cfg, [self.path])
        self.assertEqual(out, wavedecide.HEADER + "\n| 2026-11-11 | o/up#2154 | bounded replay | maintainer | [comment](https://x/2) | ok |\n"
                              "| 2026-11-11 | o/up#2134 | a multiple \\| a floor | coordinator of wv (M) | [comment](https://x/1) | unreviewed |\n")

    def test_usage(self) -> None:
        with open(self.body, "w") as f:
            f.write("x\n")
        good = [self.path, "2154", "--tier", "2", "--call", "c", "--body-file", self.body, "--by", "M"]
        for args, why in (([self.path], "name the wave file and the issue's number"), ([self.path, "t42"], "name the wave file and the issue's number"),
                          ([*good[:2], "--tier", "1", *good[4:]], "--tier is one of 2, mid-wave, 3"),
                          ([*good[:4], "--call", "  ", *good[6:]], "--call takes the decision in one line"),
                          ([*good[:8], "--by", "Opus (5.5)"], "--by takes the coordinator's model"),
                          ([*good, "--task", "7x"], "--task '7x' does not match"),
                          ([*good[:6], "--body-file", "/nonexistent/body.md", *good[8:]], "cannot be read"),
                          ([*good, "--task"], "--task needs a value"), ([*good, "--force", "1"], "unknown option --force")):
            rc, _, err = captured(wavedecide.cmd_decide, self.cfg, args)
            self.assertEqual(rc, 2, args)
            self.assertIn(why, err)
        rc, _, err = captured(wavedecide.cmd_decisions, self.cfg, [])
        self.assertIn("name the wave file", err)


def row(task: str, **fields: str) -> dict[str, Any]:
    base = {"transport": "cli", "kind": "codex", "worker": f"w1-{task[1:]}", "agent_host": "far", "state": "launched",
            "issue": f"o/up#{task[1:]}"}
    return {"task": task, "fields": {**base, **fields}}


class Markers(unittest.TestCase):
    def test_exactly_one_marker_names_a_turn(self) -> None:
        request = "I need a leg.\n\nEXECUTION_REQUEST\n{\"request_id\":\"x\"}\nEND_EXECUTION_REQUEST\n"
        result = 'Done.\nEXECUTION_RESULT {"request_id":"x","run":"/r","exit":0,"observed_sha":"' + A + '"}\n'
        for message, want in ((request, "request"), (result, "result"), (f"PR open.\n\nREVIEW_REQUEST 7 {A}\n", "review"),
                              (f"Fixed.\nCONFIRM_REQUEST #7 {A}  \n\n", "confirm"),
                              ("HANDBACK t42\nPR https://github.com/o/staging/pull/7 merged at abc.\n", "handback")):
            self.assertEqual(wavedrive.classify(message).kind, want, message)
        self.assertEqual(wavedrive.classify(result + result).results.__len__(), 2)
        got = wavedrive.classify(f"REVIEW_REQUEST 7 {A}")
        self.assertEqual((got.pr, got.sha), ("7", A))
        self.assertEqual(wavedrive.classify("HANDBACK t42\nsee o/staging/pull/19 and /pull/20").pr, "19")

    def test_anything_else_is_other_and_says_what_it_saw(self) -> None:
        for message, why in (("", "an empty final message"), ("NEEDS_DESIGN the solver\n", "the last line starts 'NEEDS_DESIGN'"),
                             (f"REVIEW_REQUEST 7 {A[:39]}", "the last line starts 'REVIEW_REQUEST'"),
                             (f"REVIEW_REQUEST 7 {A}\nThanks!", "the last line starts 'Thanks!'"),
                             (f"I will send REVIEW_REQUEST 7 {A} soon", "the last line starts 'I'"),
                             ("Result: EXECUTION_RESULT {}", "the last line starts 'Result:'"),
                             ('EXECUTION_RESULT {"request_id":"a"}\nEXECUTION_RESULT {"request_id":"b"', "an EXECUTION_RESULT line that is not"),
                             ('EXECUTION_RESULT\n{"request_id":"a"}', "an EXECUTION_RESULT line that is not"),
                             (f'EXECUTION_RESULT {{}} done\nREVIEW_REQUEST 7 {A}', "an EXECUTION_RESULT line that is not"),
                             ("The HANDBACK follows\nPR 7", "the last line starts 'PR'"),
                             (f"HANDBACK t42\n...\nREVIEW_REQUEST 7 {A}", "more than one marker: review, handback"),
                             (f"EXECUTION_REQUEST\n{{}}\nEND_EXECUTION_REQUEST\nEXECUTION_RESULT {{}}", "more than one marker: request, result")):
            got = wavedrive.classify(message)
            self.assertEqual(got.kind, "other", message)
            self.assertIn(why, got.why)

    def test_only_live_cli_rows_past_pending_are_served(self) -> None:
        doc = {"tasks": [row("t1"), row("t2", state="pending"), row("t3", state="merged #7 at abc"), row("t4", transport="subagent"),
                         row("t5", state="reviewing round 2"), row("t6", worker=""), row("t7", state="spawned"), "x", {"task": "t8"},
                         row("t9", kind="claude")]}
        self.assertEqual([w.task for w in wavedrive.workers_of(doc)], ["t1", "t5", "t9"])
        self.assertEqual(wavedrive.workers_of(doc)[0], wavedrive.Worker("t1", "w1-1", "far", row("t1")["fields"]))
        self.assertEqual(wavedrive.workers_of(doc)[2].count, "results", "a Claude worker's turns are its results")


class DriveCase(WaveDirCase):
    """One scripted world for the driver: a board, a worker's status and final message, each verb's answer."""

    def setUp(self) -> None:
        super().setUp()
        self.rows = [row("t42")]
        self.state, self.resumes, self.session = "EXITED(0)", 0, "0199-a"
        self.message = ""
        self.rc: dict[str, int] = {}
        self.out: dict[str, str] = {}
        self.calls: list[list[str]] = []
        self.clock = 1000.0
        self.attach_waits: list[float | None] = []
        self.runs = os.path.join(self.wavedir, "logs", "drive-runs", "run-1")
        self.results: int | str | None = None  # a Claude worker's results= (None: a Codex worker's status line)
        self.unread = 0
        self.statuses: list[str] = []  # status lines answered first, one a read, before the scripted one
        self.status_reads = 0

    def execute(self, argv: list[str], timeout: float | None = None) -> tuple[int, str, str]:
        tool, args = os.path.basename(argv[0]), list(argv[1:])
        if tool == "git":
            return self.rc.get(f"git {args[2]}", 0), self.out.get(f"git {args[2]}", B + "\n" if args[2] == "rev-parse" else ""), ""
        key = f"{tool} {args[0]}" if tool == "bg-run.sh" else " ".join(
            args[:3] if args[:2] == ["execution", "conclude"] else args[:2] if args[0] in ("execution", "board", "wave") else args[:1])
        if key == "attach":
            self.attach_waits.append(timeout)
            return self.rc.get(key, 0), self.out.get(key, "DONE far/w1-42 exit=0 turn.completed | x\n"), ""
        if key != "status":
            self.calls.append([tool, *args] if tool == "bg-run.sh" else args)
        rc = self.rc.get(key, 0)
        if key == "status":
            self.status_reads += 1
            if self.statuses:
                return rc, self.statuses.pop(0), ""
            return rc, self.out.get(key, self.status_line()), ""
        if key == "log":
            return rc, self.message if rc == 0 else "NO RESULT far/w1-42: latest turn ended turn.failed\n", ""
        if key == "bg-run.sh spawn":
            return rc, self.runs + "\n", ""
        if key == "bg-run.sh wait":
            return rc, self.out.get(key, "rc=0\n"), ""
        return rc, self.out.get(key, ""), self.out.get(key + " stderr", "")

    def status_line(self, state: str = "", results: int | str | None = None) -> str:
        """status's line as farside.STATUS prints it: a Claude worker's with its stream fields and results=."""
        state, results = state or self.state, self.results if results is None else results
        if results is None:
            return f"{state} far/w1-42 kind=codex session={self.session} stream: 9 events, 3s quiet, last=x | head=abc | resumes={self.resumes} stderr=0B\n"
        return (f"{state} far/w1-42 kind=claude session={self.session} stream: 9 events, 3s quiet, last=result | turn=ended"
                f" background_tasks=0 unread={self.unread} | head=abc dirty=0 branch=b | resumes={self.resumes} results={results} stderr=0B\n")

    @contextlib.contextmanager
    def world(self) -> Generator[None]:
        with (mock.patch.object(wavedrive, "execute", side_effect=self.execute),
              mock.patch.object(wavedrive, "board_document", side_effect=lambda _cfg, _wave: {"tasks": self.rows}),  # pyright: ignore[reportUnknownLambdaType]
              mock.patch.object(wavedrive, "now", side_effect=lambda: self.clock)):
            yield

    def once(self) -> tuple[int, str]:
        self.calls.clear()
        rc, out, _ = captured(wavedrive.cmd_drive, self.cfg, [self.path, "--once"])
        return rc, out

    def ledger(self) -> list[tuple[int, str, str]]:
        with open(os.path.join(self.wavedir, "logs", "drive.jsonl")) as f:
            return [(e["turn"], e["kind"], e["status"]) for e in map(json.loads, f)]

    def attention(self) -> list[str]:
        try:
            with open(os.path.join(self.wavedir, "logs", "attention.jsonl")) as f:
                found: list[str] = []
                for line in f:
                    try:
                        found.append(json.loads(line)["why"])
                    except (ValueError, KeyError):
                        pass  # a torn line, as every reader skips it
                return found
        except FileNotFoundError:
            return []


class Drive(DriveCase):
    """wave drive: each returned turn answered once, by its marker, and everything else handed up."""

    def test_a_request_is_assigned_and_resumed_in_one_call_and_never_twice(self) -> None:
        self.message = "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
        self.out["execution assign"] = "EXECUTION_ASSIGNED x\ncommand: true\n"
        with self.world():
            rc, out = self.once()
            self.assertEqual(rc, 0, out)
            msg = f"{self.wavedir}/msgs/t42.w1-42.0199-a.0.md"
            self.assertEqual(self.calls, [["log", "far", "w1-42", "--last-result"],
                                          ["execution", "assign", f"{self.wavedir}/reserve/t42-base.json", msg, "--message",
                                           f"{self.wavedir}/msgs/t42.w1-42.0199-a.0.assigned.md", "--unstick", "far", "w1-42"]])
            with open(msg) as f:
                self.assertEqual(f.read(), self.message)
            self.assertIn("DRIVE t42 turn 0: request answered: assigned and resumed", out)
            self.assertEqual((self.once()[0], self.calls), (0, []), "a final turn is not read again")
            self.state = "RUNNING"
            self.resumes = 1
            self.assertEqual((self.once()[0], self.calls), (0, []), "a running worker is left alone")
            self.state = "EXITED(0)"
            self.assertEqual((self.once()[0], [c[0] for c in self.calls]), (0, ["log", "execution"]), "the next turn is a new turn")
        self.assertEqual(self.ledger(), [(0, "request", "answered"), (1, "request", "answered")])

    def test_a_worker_launched_in_a_tasks_place_does_not_inherit_its_predecessors_turns(self) -> None:
        self.message = "NEEDS_DESIGN x\n"
        with self.world():
            self.assertIn("DRIVE ATTENTION t42 turn 0", self.once()[1])
            self.assertEqual((self.once()[1], self.calls), ("", []))
            self.session = "0199-b"  # launch --replace: the same name, a new session, counting from 0 again
            self.assertIn("DRIVE ATTENTION t42 turn 0", self.once()[1], "the replacement's turn 0 is its own")
            self.rows = [row("t42", worker="w1-42b")]  # a finisher under another name, its session reused by chance
            self.assertIn("DRIVE ATTENTION t42 turn 0", self.once()[1])
            self.assertEqual((self.once()[1], self.calls), ("", []))
            # A confirm the predecessor was answered at turn 0 is another turn than the replacement's turn 0: a new round.
            self.rows, self.session, self.message = [row("t42")], "0199-c", f"CONFIRM_REQUEST 7 {A}\n"
            self.once()
            self.assertNotIn("--again", self.calls[1])
            self.review_log("findings", "confirm")
            self.assertIn("confirm answered", self.once()[1])
            self.session = "0199-d"
            self.once()
            self.assertEqual(self.calls[1][-1], "--again", "the replacement's request at the same head and count is a new round")
        with open(os.path.join(self.wavedir, "logs", "drive.jsonl")) as f:
            self.assertEqual([(e["worker"], e["session"], e["turn"]) for e in map(json.loads, f)][:3],
                             [("w1-42", "0199-a", 0), ("w1-42", "0199-b", 0), ("w1-42b", "0199-b", 0)])

    def test_an_assignment_that_mixes_an_earlier_dispatch_with_a_new_one_is_handed_up(self) -> None:
        self.message = "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
        self.out["execution assign"] = "EXECUTION_ASSIGNED b\n"
        self.out["execution assign stderr"] = ("ASSIGN ALREADY a: the registry holds it launching; an earlier call dispatched it\n"
                                               "ASSIGN ASSIGNED b correctness far abc\n")
        with self.world():
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t42 turn 0: the worker was resumed with part of its assignments", out)
            self.assertIn("an earlier call had dispatched a and its message is not in this one", out)
        self.assertEqual(self.ledger(), [(0, "request", "attention")])

    def test_a_workers_own_words_are_never_a_lease_refusal(self) -> None:
        refusal = "EXECUTION REFUSED fleet: coordinator lease held by session-other -- not you (adopted since your gate?)"
        self.message = f"NEEDS_DESIGN my unstick printed:\n{refusal}\n"
        self.out["attach"] = f"DONE far/w1-42 exit=0 turn.completed | {refusal}\n"
        with self.world():
            rc, out = self.once()
            self.assertEqual(rc, 0, out)
            self.assertIn("DRIVE ATTENTION t42 turn 0: no marker this driver answers", out)
            # The same line from a lease-gated verb that failed is the refusal; from one that succeeded, or mid-line, it is text.
            self.resumes, self.message = 1, f"REVIEW_REQUEST 7 {A}\n"
            self.out = {"execution assign": f"quoted: {refusal}\n"}
            self.assertEqual(self.once()[0], 0)
            # assign's stdout is the assignment message, built from the worker's request: its words too.
            self.resumes, self.message = 2, "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
            self.rc["execution assign"], self.out["execution assign"] = 1, f"EXECUTION_ASSIGNED x\ncommand: echo '{refusal}'\n"
            rc, out = self.once()
            self.assertEqual(rc, 0, out)
            self.assertIn("refused some of the turn's blocks", out)
            self.resumes, self.out = 3, {"execution assign stderr": refusal + "\n"}
            rc, out = self.once()
            self.assertEqual(rc, 1)
            self.assertIn("DRIVE STOPPED wv: the lease is another coordinator's", out)

    def test_the_coordinator_is_told_before_a_turn_is_made_final(self) -> None:
        self.message = "NEEDS_DESIGN x\n"
        real = wavedrive.append_line
        died: list[str] = []

        def dying(path: str, record: dict[str, Any]) -> None:
            if path.endswith("drive.jsonl") and not died:
                died.append(path)
                raise KeyboardInterrupt  # the driver is killed between the notification and the ledger line
            real(path, record)

        with self.world(), mock.patch.object(wavedrive, "append_line", side_effect=dying):
            with self.assertRaises(KeyboardInterrupt):
                self.once()
            self.assertEqual(len(self.attention()), 1, "the notification is written first")
            self.assertFalse(os.path.exists(os.path.join(self.wavedir, "logs", "drive.jsonl")))
            self.assertIn("DRIVE ATTENTION t42 turn 0", self.once()[1], "the restart reads the turn again and tells again")
            self.assertEqual((self.once()[1], self.calls), ("", []))
        self.assertEqual((len(self.attention()), self.ledger()), (2, [(0, "turn", "attention")]))

    def test_a_ledger_line_cut_short_never_swallows_the_record_after_it(self) -> None:
        self.message = "NEEDS_DESIGN x\n"
        os.makedirs(os.path.join(self.wavedir, "logs"))
        for name in ("drive.jsonl", "attention.jsonl"):
            with open(os.path.join(self.wavedir, "logs", name), "w") as f:
                f.write('{"task": "t1", "turn": 0, "status": "answered"}\n{"task": "t42", "tu')  # killed mid-line
        with self.world():
            self.assertIn("DRIVE ATTENTION t42 turn 0", self.once()[1])
            self.assertEqual((self.once()[1], self.calls), ("", []), "the record written after the torn line is read back")
        with open(os.path.join(self.wavedir, "logs", "drive.jsonl")) as f:
            lines = f.read().split("\n")
        self.assertEqual((lines[1], json.loads(lines[2])["status"], lines[3]), ('{"task": "t42", "tu', "attention", ""))
        self.assertEqual(self.attention(), ["no marker this driver answers; the last line starts 'NEEDS_DESIGN'"])

    def test_a_replacement_is_never_resumed_with_its_predecessors_saved_assignment(self) -> None:
        self.message = "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
        os.makedirs(os.path.join(self.wavedir, "msgs"))
        with open(f"{self.wavedir}/msgs/t42.w1-42.0199-a.0.assigned.md", "w") as f:
            f.write("EXECUTION_ASSIGNED old-request\n")
        self.session = "0199-b"  # the task's worker was replaced; its turn 0 asks for something else
        with self.world():
            out = self.once()[1]  # assign: exit 0, nothing printed (dispatched earlier, no message saved for THIS turn)
            self.assertNotIn("unstick", [c[0] for c in self.calls])
            self.assertIn("no assignment message was saved", out)

    def test_only_a_turn_that_completed_is_read_and_never_the_turn_before_it(self) -> None:
        """log --last-result skips a turn that never completed and prints the one before: a resumed
        worker that died at startup must not be answered with its previous handoff again."""
        self.message = f"REVIEW_REQUEST 7 {A}\n"
        with self.world():
            self.rc["attach"], self.out["attach"] = 1, "FAILED far/w1-42 exit=137 no terminal event in the stream killed\n"
            out = self.once()[1]
            self.assertEqual(self.calls, [], "neither the message is read nor anything answered")
            self.assertIn("DRIVE ATTENTION t42 turn 0: the turn did not complete: FAILED far/w1-42 exit=137 no terminal event", out)
            self.assertEqual(self.attach_waits, [wavedrive.ATTACH_WAIT], "attach is bounded: a worker running again is next tick's")
            self.resumes = 1
            for rc in (4, 124):
                self.rc["attach"] = rc
                self.assertEqual((self.once()[1], self.calls), ("", []), rc)
            self.rc["attach"], self.out["attach"] = 3, "VANISHED far/w1-42: no exit record\n"
            self.assertIn("the turn did not complete: VANISHED far/w1-42", self.once()[1])
            self.resumes, self.rc, self.out = 2, {}, {}
            self.assertEqual([c[0] for c in (self.once(), self.calls)[1]], ["log", "bg-run.sh"], "a DONE turn is read and answered")
        self.assertEqual([e[:2] for e in self.ledger()], [(0, "turn"), (1, "turn"), (2, "review")])

    def test_an_assignment_dispatched_earlier_and_never_resumed_is_resumed_with_its_saved_message(self) -> None:
        self.message = "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
        saved = f"{self.wavedir}/msgs/t42.w1-42.0199-a.0.assigned.md"
        with self.world():
            # assign exits 0 and prints nothing: every block ALREADY, its unstick skipped.
            out = self.once()[1]
            self.assertIn("every block was dispatched by an earlier call, the worker was not resumed, and no assignment message was saved", out)
            self.resumes = 1
            os.makedirs(os.path.dirname(saved), exist_ok=True)
            with open(saved.replace(".0.assigned", ".1.assigned"), "w") as f:
                f.write("EXECUTION_ASSIGNED x\n")
            out = self.once()[1]
            self.assertEqual(self.calls[-1], ["unstick", "far", "w1-42", "--message", saved.replace(".0.assigned", ".1.assigned")])
            self.assertIn("request answered: dispatched by an earlier call; resumed with its saved message", out)

    def test_a_refused_assignment_is_tried_again_then_handed_up_and_exit_4_at_once(self) -> None:
        self.message = "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
        self.rc["execution assign"] = 1
        with self.world():
            self.assertIn("request retry: execution assign refused a block (try 1 of 6)", self.once()[1])
            self.assertEqual(self.once()[1], "", "not before its retry time")
            self.assertEqual(self.calls, [])
            for attempt in range(2, 6):
                self.clock += wavedrive.RETRY
                self.assertIn(f"(try {attempt} of 6)", self.once()[1])
            self.clock += wavedrive.RETRY
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t42 turn 0: execution assign exit 1 after 6 tries", out)
            self.assertEqual((self.once()[1], self.calls), ("", []))
            self.resumes, self.rc["execution assign"] = 1, 4
            self.assertIn("DRIVE ATTENTION t42 turn 1: execution assign exit 4: read its lines before anything else", self.once()[1])
            # Some blocks assigned (assign prints its message) and some refused: the worker is resumed, so the turn is over.
            self.resumes, self.rc["execution assign"], self.out["execution assign"] = 2, 1, "EXECUTION_ASSIGNED x\n"
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t42 turn 2: execution assign refused some of the turn's blocks and resumed the worker with the rest", out)
            self.assertEqual((self.once()[1], self.calls), ("", []), "a partly assigned turn is final: its worker runs a new one")
        self.assertEqual(len(self.attention()), 3)

    def test_a_result_is_concluded_off_its_run_and_the_worker_told_the_verdict(self) -> None:
        line = 'EXECUTION_RESULT {"request_id":"wv-t42-rog-1","run":"/runs/7","exit":0,"observed_sha":"' + A + '"}'
        self.message = f"The leg passed.\n{line}\n"
        self.out["execution conclude --from-run"] = '{\n "request_id": "wv-t42-rog-1",\n "verdict": "pass"\n}\n'
        with self.world():
            out = self.once()[1]
            self.assertEqual(self.calls[1:], [["execution", "conclude", "--from-run", "/runs/7", "--request", "wv-t42-rog-1", "--sha", A],
                                              ["unstick", "far", "w1-42", "--message", f"{self.wavedir}/msgs/t42.w1-42.0199-a.0.concluded.md"]])
            with open(f"{self.wavedir}/msgs/t42.w1-42.0199-a.0.concluded.md") as f:
                self.assertEqual(f.read(), "EXECUTION_CONCLUDED wv-t42-rog-1 pass\n\nContinue with your task.\n")
            # A bg-run directory is no test-run record: the first read refuses, the second concludes.
            self.resumes = 1
            self.rc["execution conclude --from-run"] = 1
            self.out["execution conclude --from-bg-run"] = '{"verdict": "fail"}'
            out = self.once()[1]
            self.assertEqual([c[2] for c in self.calls if c[:2] == ["execution", "conclude"]], ["--from-run", "--from-bg-run"])
            self.assertIn("result answered: EXECUTION_CONCLUDED wv-t42-rog-1 fail", out)
            self.resumes = 2
            self.rc["execution conclude --from-bg-run"] = 1
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t42 turn 2: wv-t42-rog-1 could not be concluded off /runs/7", out)
            self.assertNotIn("unstick", [c[0] for c in self.calls], "an unconcluded result resumes nobody")
            self.resumes = 3
            self.message = 'EXECUTION_RESULT {"request_id":"x","run":"runs/7","observed_sha":"abc"}\n'
            self.assertIn("names no request_id, absolute run and 40-hex observed_sha", self.once()[1])
            self.resumes, self.rc = 4, {"unstick": 1}
            self.message = f"{line}\n"
            self.assertIn("and the worker was NOT resumed (unstick exit 1", self.once()[1])

    def review_log(self, decision: str, kind: str = "at-open") -> str:
        message = f"{self.wavedir}/reviews/7-{kind}-{A[:12]}.message.md"
        os.makedirs(self.runs, exist_ok=True)
        with open(os.path.join(self.runs, "log"), "w") as f:
            f.write(f"note\nWAVE REVIEW t42: o/staging#7 {kind} at {A[:8]}: verdict=x blocking=1 suggestions=0 decision={decision}"
                    f" comment=https://x/1 message={message}\n")
        return message

    def test_a_review_runs_beside_the_driver_and_its_message_resumes_the_worker(self) -> None:
        self.message = f"The PR is open.\n\nREVIEW_REQUEST 7 {A}\n"
        with self.world():
            out = self.once()[1]
            self.assertEqual(self.calls[1], ["bg-run.sh", "spawn", f"{self.wavedir}/logs/drive-runs", "--", wavedrive.shim(self.cfg),
                                             "wave", "review", self.path, "t42", "7", A, "--kind", "at-open", "--issue", "42"])
            self.assertIn(f"review reviewing: wave review at-open of #7 at {A[:8]} started in {self.runs}", out)
            self.out["bg-run.sh wait"], self.rc["bg-run.sh wait"] = "RUNNING after 1 s of --within 1\n", 3
            self.assertEqual((self.once()[1], self.calls), ("", [["bg-run.sh", "wait", self.runs, "--within", "1"]]))
            message = self.review_log("confirm")
            self.out["bg-run.sh wait"], self.rc["bg-run.sh wait"] = "rc=0 (finished earlier, at 12:00)\n", 0
            out = self.once()[1]
            self.assertEqual(self.calls[-1], ["unstick", "far", "w1-42", "--message", message])
            self.assertIn("review answered: decision=confirm, resumed with", out)
            self.assertEqual((self.once()[1], self.calls), ("", []))
            # The worker rebuts and asks for a confirm at the same head, twice: the second is a new round.
            self.message = f"Rebutted.\nCONFIRM_REQUEST 7 {A}\n"
            for turn, again in ((1, False), (2, True)):
                self.resumes = turn
                self.once()
                self.assertEqual(self.calls[1][-1] == "--again", again, self.calls[1])
                self.assertIn("confirm", self.calls[1])
                self.review_log("findings", "confirm")
                self.assertIn("confirm answered: decision=findings", self.once()[1])
        self.assertEqual(self.attention(), [])

    def test_a_review_that_ends_unreadable_or_not_at_all_is_handed_up(self) -> None:
        self.message = f"REVIEW_REQUEST 7 {A}\n"
        with self.world():
            self.once()
            message = self.review_log("unreadable")
            out = self.once()[1]
            self.assertEqual(self.calls[-1], ["unstick", "far", "w1-42", "--message", message], "the worker is resumed, confirm-first")
            self.assertIn("DRIVE ATTENTION t42 turn 0: the review ended on no verdict line", out)
            for turn, line, status in ((1, "rc=4\n", 0), (2, "DIED\n", 5), (3, "rc=0\n", 0)):
                self.resumes = turn
                self.out["bg-run.sh wait"], self.rc["bg-run.sh wait"] = "rc=0\n", 0
                self.once()
                self.out["bg-run.sh wait"], self.rc["bg-run.sh wait"] = line, status
                if turn == 3:
                    os.remove(os.path.join(self.runs, "log"))  # exit 0 and no line of its own
                out = self.once()[1]
                self.assertIn(f"DRIVE ATTENTION t42 turn {turn}: the review did not end with a verdict", out)
                self.assertNotIn("unstick", [c[0] for c in self.calls])
            self.resumes, self.rc["bg-run.sh spawn"] = 4, 1
            self.assertIn("the review could not be started (bg-run.sh spawn exit 1)", self.once()[1])
            # A review refused on the lease is a takeover: the driver ends, and the turn is not made final.
            self.resumes, self.rc = 5, {}
            self.out["bg-run.sh wait"] = "rc=0\n"
            self.once()
            with open(os.path.join(self.runs, "log"), "w") as f:
                f.write("WAVE REVIEW REFUSED fleet: coordinator lease held by session-other\n")
            self.out["bg-run.sh wait"] = "rc=1\n"
            rc, out = self.once()
            self.assertEqual(rc, 1)
            self.assertIn("DRIVE STOPPED wv: the lease is another coordinator's (WAVE REVIEW REFUSED fleet: coordinator lease held by session-other)", out)
            self.assertEqual(self.ledger()[-1], (5, "review", "reviewing"))

    def test_no_pr_handback_uses_only_absolute_run_lines(self) -> None:
        with self.world():
            self.message = "HANDBACK t42\nRUN /absolute/run with spaces\nRUN /second\n"
            self.out["board close"] = "BOARD CLOSE done, no PR\n"
            self.assertIn("handback answered", self.once()[1])
            kept = f"{self.wavedir}/handbacks/t42.md"
            self.assertEqual(self.calls[1], ["board", "close", "wv", "t42", "--no-pr", "--run", "/absolute/run with spaces",
                                             "--run", "/second", "--evidence", f"hand-back {kept}"])
            for turn, text in enumerate(("No run", "RUN relative/path", "text RUN /path"), 1):
                self.resumes, self.message = turn, f"HANDBACK t42\n{text}\n"
                self.assertIn("the hand-back names no PR", self.once()[1])
                self.assertFalse(any(c[:2] == ["board", "close"] for c in self.calls))

    def test_a_hand_back_closes_the_task_and_an_unconfirmed_blocking_review_is_said(self) -> None:
        self.message = "HANDBACK t42\nMerged https://github.com/o/staging/pull/7 at abc. Proposals: ...\n"
        self.out["board close"] = 'BOARD CLOSE wv: "t42" merged o/staging#7 at aaaaaaaaaaaa; 1 standing concluded, 0 already; row set\n'
        with self.world():
            out = self.once()[1]
            kept = f"{self.wavedir}/handbacks/t42.md"
            self.assertEqual(self.calls[1], ["board", "close", "wv", "t42", "--pr", "7", "--evidence", f"hand-back {kept}"])
            with open(kept) as f:
                self.assertEqual(f.read(), self.message)
            self.assertIn('handback answered: BOARD CLOSE wv: "t42" merged o/staging#7', out)
            # A lease refusal that board close wraps in its own line is the takeover it is.
            self.resumes = 1
            self.rc["board close"] = 1
            self.out["board close"] = ('BOARD CLOSE REFUSED wv: "t42": board log exit 1 (BOARD REFUSED fleet: coordinator lease held by'
                                       " session-other -- not you (adopted since your gate?)); the row is not set; a re-run resumes\n")
            rc, out = self.once()
            self.assertEqual(rc, 1)
            self.assertIn("DRIVE STOPPED wv: the lease is another coordinator's (BOARD REFUSED fleet: coordinator lease held by session-other", out)
            self.assertEqual([e[0] for e in self.ledger()], [0], "a takeover is no verdict on the turn")
            self.rows = [row("t42", pr="9")]
            self.rc["board close"], self.out["board close"] = 1, "BOARD CLOSE REFUSED wv: \"t42\": o/staging#9 is OPEN, not merged; nothing closed\n"
            out = self.once()[1]
            self.assertEqual(self.calls[1][4:6], ["--pr", "9"], "the row's PR is read before the message's")
            self.assertIn("DRIVE ATTENTION t42 turn 1: board close refused: BOARD CLOSE REFUSED", out)
            self.rc, self.rows = {}, [row("t42")]
            self.out["board close"] = "BOARD CLOSE wv: closed\n"
            os.makedirs(os.path.join(self.wavedir, "reviews"))

            def record(kind: str, sha: str, decision: str, at: str, comment: str = "https://x/c") -> None:
                with open(os.path.join(self.wavedir, "reviews", f"7-{kind}-{sha[:12]}.json"), "w") as f:
                    json.dump({"decision": decision, "at": at, "sha": sha, "comment": comment}, f)

            def closed(turn: int) -> str:
                self.resumes = turn
                return self.once()[1]

            said = "the hand-back reports #7 merged, with a blocking review and no cleared confirm of the merged head on record"
            record("at-open", A, "confirm", "2026-11-11T10:00:00Z", comment="")
            self.assertIn("handback answered", closed(2), "a dry run's review is no review")
            record("at-open", A, "confirm", "2026-11-11T10:00:00Z")
            out = closed(3)
            self.assertIn(said, out)
            self.assertEqual([c[:2] for c in self.calls if c[0] in ("board", "pr")][-1], ["board", "close"],
                             "the coordinator is told, then the row is closed: a closed row is served no more")
            # A driver killed after the close has told already: the notification does not depend on the ledger.
            self.assertEqual(self.attention()[-1][:len(said)], said)
            self.out["pr"] = B + "\n"
            for turn, (at, comment, sha) in enumerate((("2026-11-11T09:00:00Z", "https://x/c", B),   # cleared before the blocking review
                                                       ("2026-11-11T11:00:00Z", "", B),              # a dry run's clearance
                                                       ("2026-11-11T11:00:00Z", "https://x/c", C)),  # cleared at another head than merged
                                                      start=4):
                for path in glob.glob(os.path.join(self.wavedir, "reviews", "7-confirm-*.json")):
                    os.remove(path)
                record("confirm", sha, "cleared", at, comment)
                self.assertIn(said, closed(turn), (at, comment, sha))
            os.remove(os.path.join(self.wavedir, "reviews", f"7-confirm-{C[:12]}.json"))
            record("confirm", B, "cleared", "2026-11-11T11:00:00Z")
            self.rc["pr"] = 1
            self.assertIn(said, closed(7), "a head GitHub does not answer for is not covered")
            self.rc = {}
            out = closed(8)
            self.assertIn("handback answered", out)
            self.assertIn(["pr", "view", "7", "--repo", "o/staging", "--json"], [c[:6] for c in self.calls])
            record("at-open", C, "merge", "2026-11-11T12:00:00Z")
            self.out["pr"] = "unrelated\n"
            self.assertIn("handback answered", closed(9), "the newest at-open review does not block: nothing to confirm")
            # A blocking round --again set aside is still on the PR: a new round that never posted does not hide it.
            reviews = os.path.join(self.wavedir, "reviews")
            for path in glob.glob(os.path.join(reviews, "7-*.json")):
                os.remove(path)
            with open(os.path.join(reviews, f"7-at-open-{A[:12]}.r1.json"), "w") as f:
                json.dump({"decision": "confirm", "at": "2026-11-11T13:00:00Z", "sha": A, "comment": "https://x/c"}, f)
            record("at-open", A, "merge", "2026-11-11T14:00:00Z", comment="")
            self.assertIn(said, closed(10), "the archived blocking round is the newest posted one")
            # A later confirm round takes an earlier clearance back, at the same head too.
            self.out["pr"] = B + "\n"
            with open(os.path.join(reviews, f"7-confirm-{B[:12]}.r1.json"), "w") as f:
                json.dump({"decision": "cleared", "at": "2026-11-11T15:00:00Z", "sha": B, "comment": "https://x/c"}, f)
            self.assertIn("handback answered", closed(11))
            record("confirm", B, "findings", "2026-11-11T16:00:00Z")
            self.assertIn(said, closed(12), "the newest confirm withholds the clearance")
            self.resumes, self.message = 13, "HANDBACK t42\nNo PR: a measurement task.\n"
            self.assertIn("the hand-back names no PR", self.once()[1])

    def test_what_no_marker_answers_is_attention_and_what_is_not_a_state_is_read_again(self) -> None:
        with self.world():
            self.message = "NEEDS_DESIGN the solver needs a replay search; options A, B, C\n"
            out = self.once()[1]
            self.assertIn(f"DRIVE ATTENTION t42 turn 0: no marker this driver answers; the last line starts 'NEEDS_DESIGN'"
                          f" ({self.wavedir}/msgs/t42.w1-42.0199-a.0.md)", out)
            self.assertEqual([c[0] for c in self.calls], ["log"], "nothing is answered")
            self.resumes, self.rc["log"] = 1, 1
            self.assertIn("the turn ended with no final message (NO RESULT far/w1-42", self.once()[1])
            self.resumes, self.rc, self.state = 2, {}, "ORPHANED"
            self.assertIn("DRIVE ATTENTION t42 turn 2: the worker is ORPHANED on far, no returned turn", self.once()[1])
            self.resumes = 3
            transients: list[tuple[dict[str, int], dict[str, str]]] = [({"status": 4}, {}), ({}, {"status": "ssh: connection reset\n"}),
                                                                       ({}, {"status": ""}), ({"log": 4}, {})]
            for codes, said in transients:
                self.rc, self.out, self.state = dict(codes), dict(said), "EXITED(0)"
                self.assertEqual(self.once(), (0, ""), (codes, said))
        self.assertEqual([e[0] for e in self.ledger()], [0, 1, 2], "a transient read records nothing")

    def test_a_lost_lease_ends_the_driver_and_a_stop_file_or_a_second_driver_too(self) -> None:
        self.message = "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
        self.rc["execution assign"] = 1
        self.out["execution assign stderr"] = "EXECUTION REFUSED fleet: coordinator lease held by session-other\n"
        with self.world():
            rc, out = self.once()
            self.assertEqual(rc, 1)
            self.assertIn("DRIVE STOPPED wv: the lease is another coordinator's (EXECUTION REFUSED fleet: coordinator lease held by session-other)", out)
            self.assertFalse(os.path.exists(os.path.join(self.wavedir, "logs", "drive.jsonl")), "a takeover is no turn's verdict")
            self.rc, self.out = {}, {"execution assign": "EXECUTION_ASSIGNED x\n"}
            naps: list[float] = []

            def nap(seconds: float) -> None:
                naps.append(seconds)
                open(os.path.join(self.wavedir, "drive.stop"), "w").close()

            with mock.patch.object(wavedrive, "sleep", side_effect=nap):
                rc, out, _ = captured(wavedrive.cmd_drive, self.cfg, [self.path, "--poll", "7"])
            self.assertEqual((rc, naps), (0, [7]))
            self.assertTrue(out.endswith(f"DRIVE STOPPED wv: stop file {self.wavedir}/drive.stop\n"), out)
            os.remove(os.path.join(self.wavedir, "drive.stop"))
            with open(os.path.join(self.wavedir, "logs", "drive.lock"), "a") as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX)
                for verb, args in ((wavedrive.cmd_drive, [self.path, "--once"]), (wavedrive.cmd_turn, [self.path, "t42"])):
                    rc, out, _ = captured(verb, self.cfg, args)
                    self.assertEqual(rc, 1)
                    self.assertIn("DRIVE REFUSED wv: another driver holds", out)
            self.resumes = 1
            rc, out, _ = captured(wavedrive.cmd_turn, self.cfg, [self.path, "t42"])
            self.assertEqual(rc, 0, out)
            self.assertIn("DRIVE t42 turn 1: request answered", out)
            rc, out, _ = captured(wavedrive.cmd_turn, self.cfg, [self.path, "t9"])
            self.assertEqual(rc, 1)
            self.assertIn("DRIVE REFUSED wv: t9 is no live CLI worker's task on the board", out)
        for verb, args, why in ((wavedrive.cmd_drive, [self.path, "--poll", "0"], "takes --poll <whole seconds> and --once"),
                                (wavedrive.cmd_drive, [], "name the wave file"), (wavedrive.cmd_turn, [self.path], "name the wave file and the task")):
            rc, _, err = captured(verb, self.cfg, args)
            self.assertEqual(rc, 2)
            self.assertIn(why, err)

class DriveClaude(DriveCase):
    """wave drive and a Claude CLI worker: one process, many turns, each named by its results= count."""

    REQUEST = "EXECUTION_REQUEST\n{}\nEND_EXECUTION_REQUEST\n"
    IDLE = "IDLE far/w1-42 success is_error=false turns=3 x | awaiting input: `unstick --message` continues it\n"

    def setUp(self) -> None:
        super().setUp()
        self.rows = [row("t42", kind="claude")]
        self.state, self.results, self.message = "IDLE", 1, self.REQUEST
        self.out = {"attach": self.IDLE, "execution assign": "EXECUTION_ASSIGNED x\n"}

    def tagged(self) -> list[tuple[int, str, str, str]]:
        with open(os.path.join(self.wavedir, "logs", "drive.jsonl")) as f:
            return [(e["turn"], e.get("count", "-"), e["kind"], e["status"]) for e in map(json.loads, f)]

    def test_two_turns_of_one_process_are_each_answered_once(self) -> None:
        with self.world():
            rc, out = self.once()
            self.assertEqual(rc, 0, out)
            self.assertEqual(self.calls, [["log", "far", "w1-42", "--last-result"],
                                          ["execution", "assign", f"{self.wavedir}/reserve/t42-base.json", f"{self.wavedir}/msgs/t42.w1-42.0199-a.1.md",
                                           "--message", f"{self.wavedir}/msgs/t42.w1-42.0199-a.1.assigned.md", "--unstick", "far", "w1-42"]])
            self.assertIn("DRIVE t42 turn 1: request answered", out)
            self.assertEqual(self.status_reads, 2, "the status is read again around the message")
            self.assertEqual((self.once()[1], self.calls), ("", []), "an idle worker whose turn was answered is not read again")
            self.state = "RUNNING"  # the answer was appended: the same process works, resumes and results unmoved
            self.assertEqual((self.once()[1], self.calls), ("", []))
            self.state, self.results, self.message = "IDLE", 2, f"REVIEW_REQUEST 7 {A}\n"
            out = self.once()[1]
            self.assertIn("DRIVE t42 turn 2: review reviewing", out)
            self.assertEqual(self.calls[0], ["log", "far", "w1-42", "--last-result"])
            self.rc["bg-run.sh wait"], self.out["bg-run.sh wait"] = 3, "RUNNING after 1 s of --within 1\n"
            self.assertEqual((self.once()[1], [c[0] for c in self.calls]), ("", ["bg-run.sh"]), "the review is collected, not read again")
        self.assertEqual(self.resumes, 0)
        self.assertEqual(self.tagged()[:2], [(1, "results", "request", "answered"), (2, "results", "review", "reviewing")])

    def test_what_the_status_line_does_not_show_is_the_next_ticks(self) -> None:
        with self.world():
            for results, unread, why in (("?", 0, "an unreadable count"), (1, 1, "a message not echoed yet")):
                self.results, self.unread = results, unread
                self.assertEqual((self.once()[1], self.calls), ("", []), why)
            self.unread, self.out["status"] = 0, self.status_line().replace(" results=1", "")
            self.assertEqual((self.once()[1], self.calls), ("", []), "a Claude line with no results= names no turn")
            del self.out["status"]
            self.assertIn("DRIVE t42 turn 1: request answered", self.once()[1])
        self.assertFalse(self.attention())

    def test_a_reading_the_re_read_does_not_confirm_is_the_next_ticks(self) -> None:
        with self.world():
            for second, why in ((self.status_line(results=2), "a turn ended between the reads"),
                                (self.status_line(state="RUNNING"), "the worker began a turn of its own between the reads"),
                                (self.status_line().replace("unread=0", "unread=1"), "a message arrived between the reads")):
                self.statuses = [self.status_line(), second]
                self.once()
                self.assertEqual([c[0] for c in self.calls], ["log"], why)
                self.assertFalse(os.path.exists(f"{self.wavedir}/msgs/t42.w1-42.0199-a.1.md"), "no message is kept for an unconfirmed turn")
            self.results = 2
            self.assertIn("DRIVE t42 turn 2: request answered", self.once()[1])
            self.assertEqual((self.once()[1], self.calls), ("", []))
        self.assertEqual(self.tagged(), [(2, "results", "request", "answered")])

    def test_a_turn_that_died_with_no_result_is_attention_once(self) -> None:
        with self.world():
            self.assertIn("DRIVE t42 turn 1: request answered", self.once()[1])
            for state in ("EXITED(1)", "VANISHED"):
                self.state = state
                out = self.once()[1]
                if state == "EXITED(1)":
                    self.assertIn(f"DRIVE ATTENTION t42 turn 1: the worker is {state} on far after turn 1 was answered", out)
                else:
                    self.assertEqual(out, "", "told once")
                self.assertEqual(self.calls, [])
            # A worker that died at startup has written no result: its turn 0, read and handed up as any failed turn.
            self.session, self.results, self.state = "0199-b", 0, "EXITED(1)"
            self.rc["attach"], self.out["attach"] = 1, "FAILED far/w1-42 exit=1 no terminal event in the stream\n"
            self.assertIn("DRIVE ATTENTION t42 turn 0: the turn did not complete", self.once()[1])
        self.assertEqual(self.tagged(), [(1, "results", "request", "answered"), (1, "results", "state", "attention"),
                                         (0, "results", "turn", "attention")])
        self.assertEqual(len(self.attention()), 2)

    def test_a_relaunch_counts_from_zero_and_a_codex_line_is_no_claude_turn(self) -> None:
        os.makedirs(os.path.join(self.wavedir, "logs"))
        with open(os.path.join(self.wavedir, "logs", "drive.jsonl"), "w") as f:  # a Codex turn 1 of the same task, worker, session
            f.write(json.dumps({"task": "t42", "worker": "w1-42", "session": "0199-a", "turn": 1, "kind": "request", "status": "answered"}) + "\n")
        with self.world():
            self.assertIn("DRIVE t42 turn 1: request answered", self.once()[1], "the untagged line is a Codex turn's")
            self.session = "0199-b"  # launch --replace: a new session, its stream emptied
            self.assertIn("DRIVE t42 turn 1: request answered", self.once()[1], "the replacement's turn 1 is its own")
            self.assertEqual((self.once()[1], self.calls), ("", []))

    def test_a_restarted_driver_answers_nothing_twice(self) -> None:
        real = wavedrive.append_line

        def dying(path: str, record: dict[str, Any]) -> None:
            if path.endswith("drive.jsonl"):
                raise KeyboardInterrupt  # killed after the answer was appended, before its ledger line
            real(path, record)

        with self.world():
            with mock.patch.object(wavedrive, "append_line", side_effect=dying), self.assertRaises(KeyboardInterrupt):
                self.once()
            self.unread = 1  # the answer is on the worker's input, not echoed yet
            self.assertEqual((self.once()[1], self.calls), ("", []))
            self.state, self.unread = "RUNNING", 0
            self.assertEqual((self.once()[1], self.calls), ("", []))
            self.state, self.results = "IDLE", 2
            self.assertIn("DRIVE t42 turn 2: request answered", self.once()[1])
        self.assertEqual(self.tagged(), [(2, "results", "request", "answered")])


class Queue(DriveCase):
    """wave drive launches what the coordinator queued: the first due task, one a tick."""

    def setUp(self) -> None:
        super().setUp()
        with open(self.path, "w") as f:
            json.dump(wave_data(self.dir, vars={"COORD": "s", "MAIN": "main"}, **MIXED), f)
        self.rows = []
        self.out["wave launch"] = "LAUNCHED far/w1-50 kind=codex\nWAVE LAUNCH t50: launched far/w1-50 worktree /w standing wv-t50-far-iterate\n"

    def queue(self, *tasks: dict[str, Any], capacity: dict[str, int] | None = None) -> None:
        with open(os.path.join(self.wavedir, "queue.json"), "w") as f:
            json.dump({"capacity": capacity or {"far": 2, "mac": 1}, "tasks": list(tasks)}, f)

    def launched(self) -> list[list[str]]:
        return [c for c in self.calls if c[0] == "wave"]

    def manifest(self, task: str, host: str, base: str) -> None:
        """What wave prep left for a CLI task: its launch record, the host and the base being what a launch reads."""
        record: dict[str, Any] = {**{key: "x" for key in wavelaunch.TEXTS}, "host": host, "base": base, "remote": True, "allow_rival": [], "legs": []}
        os.makedirs(os.path.join(self.wavedir, "prep"), exist_ok=True)
        with open(os.path.join(self.wavedir, "prep", f"{task}.json"), "w") as f:
            json.dump({"launch": record, "done": ["ready"]}, f)

    def test_the_first_due_task_is_prepared_at_the_fetched_tip_and_launched(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far", "legs": ["gpu-box"], "mode": "paired"},
                   {"task": "t51", "profile": "sol", "host": "mac", "issue": "777"})
        with self.world():
            rc, out = self.once()
            self.assertEqual(rc, 0, out)
            self.assertEqual(self.launched(), [
                ["wave", "prep", self.path, "t50", "--base", B, "--profile", "sol", "--host", "far", "--legs", "gpu-box", "--mode", "paired"],
                ["wave", "launch", self.path, "t50"]])
            self.assertEqual(self.calls[0], ["halted"])
            self.assertIn("DRIVE t50 launch: launch answered: WAVE LAUNCH t50: launched far/w1-50", out)
            self.rows = [row("t50")]  # launched: its row is live
            self.once()
            self.assertEqual(self.launched(), [["wave", "prep", self.path, "t51", "--base", B, "--profile", "sol", "--issue", "777"],
                                               ["wave", "launch", self.path, "t51"]], "one launch a tick, in file order; the agent host takes no --host")
            self.rows = [row("t50"), row("t51", agent_host="mac")]
            self.state = "RUNNING"
            self.assertEqual((self.once()[1], self.launched()), ("", []), "a task with a row is not started again")

    def test_a_task_waits_for_its_prerequisites_its_hosts_capacity_and_a_halt(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far", "after": ["t42", "t43"]}, capacity={"far": 1})
        self.state = "RUNNING"
        with self.world():
            for rows in ([], [row("t42", state="merged #7 at abc")], [row("t42", state="merged #7"), row("t43", state="reviewing")]):
                self.rows = rows
                out = self.once()[1]
                self.assertEqual(self.launched(), [], rows)
                self.assertEqual("no row or queue entry" in out, len(rows) < 2, rows)
            self.rows = [row("t42", state="merged #7"), row("t43", state="done: measured"), row("t44")]
            self.assertEqual(self.launched() if self.once() else [], [], "far has one worker live, and capacity for one")
            for other in (row("t45", kind="claude"), row("t46", kind="claude", state="no state word"), row("t47", worker="")):
                self.rows = [*self.rows[:2], other]
                self.assertEqual(self.launched() if self.once() else [], [], f"a CLI row holds a slot, served or not: {other}")
            self.rows = [*self.rows[:2], row("t48", transport="subagent"), row("t49", state="pending"), row("t40", agent_host="mac")]
            self.rc["halted"] = 1
            self.assertEqual((self.once()[1], self.launched()), ("", []), "a halt is waited out, silently")
            self.rc = {}
            self.once()
            self.assertEqual([c[1] for c in self.launched()], ["prep", "launch"], "a native row, a pending one and another host's hold no slot here")
            os.remove(os.path.join(self.wavedir, "logs", "drive.jsonl"))
            self.rows = self.rows[:2]
            self.rc["halted"] = 1
            self.assertEqual((self.once()[1], self.launched()), ("", []), "a halt is waited out, silently")
            self.rc["halted"] = 4
            self.assertEqual(self.launched() if self.once() else [], [])
            self.rc = {}
            self.once()
            self.assertEqual([c[1] for c in self.launched()], ["prep", "launch"])

    def test_missing_after_is_told_once_per_list_and_is_not_final(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far", "after": ["t43", "t42"]})
        os.makedirs(os.path.join(self.wavedir, "logs"), exist_ok=True)
        driver = wavedrive.Driver(self.cfg, wave.load_wave(self.path, "drive"))
        self.state = "RUNNING"
        with self.world():
            out = captured(lambda: driver.round())[1]
            self.assertIn("DRIVE ATTENTION t50 launch: the queued task waits only on after tasks with no row or queue entry: t42, t43;", out)
            self.assertEqual(self.launched(), [])
            self.assertEqual(driver.ledger, [], "the notice does not finalize the launch")
            self.calls.clear()
            self.assertEqual(captured(lambda: driver.round())[1], "", "the same missing list is told once")
            self.assertEqual(self.calls, [], "an already-reported missing list needs no more potentially blocking gate reads")
            self.rows = [row("t42", state="merged #7")]
            self.assertIn("no row or queue entry: t43;", captured(lambda: driver.round())[1])
            self.assertEqual(captured(lambda: driver.round())[1], "")
            self.rows.append(row("t43", state="done: measured"))
            captured(lambda: driver.round())
            self.assertEqual([c[1] for c in self.launched()], ["prep", "launch"], "the task still starts after its prerequisites appear and land")
        self.assertEqual(len(self.attention()), 2, "only the two distinct missing lists were told")
        self.assertEqual(self.ledger(), [(-1, "launch", "launching"), (-1, "launch", "answered")])

    def test_missing_after_is_told_again_after_the_list_clears(self) -> None:
        task: dict[str, Any] = {"task": "t50", "profile": "sol", "host": "far", "after": ["t42"]}
        os.makedirs(os.path.join(self.wavedir, "logs"), exist_ok=True)
        self.state = "RUNNING"
        with self.world():
            for presence in ("row", "queue"):
                with self.subTest(presence=presence):
                    self.rows = []
                    self.queue(task)
                    driver = wavedrive.Driver(self.cfg, wave.load_wave(self.path, "drive"))
                    self.assertIn("no row or queue entry: t42;", captured(lambda: driver.round())[1])
                    if presence == "row":
                        self.rows = [row("t42", state="reviewing", transport="subagent")]
                    else:
                        self.rows = [row("t44", transport="subagent")]
                        self.queue({"task": "t42", "profile": "sol", "host": "far", "after": ["t44"]}, task)
                    self.assertEqual(captured(lambda: driver.round())[1], "", "a known prerequisite clears the missing list and waits silently")
                    self.rows = []
                    self.queue(task)
                    self.assertIn("no row or queue entry: t42;", captured(lambda: driver.round())[1], "the same names are told again after the list clears")
                    self.assertEqual(captured(lambda: driver.round())[1], "", "the renewed notice is still once per unchanged list")
                    self.assertEqual(driver.ledger, [])

    def test_missing_after_stays_silent_when_not_otherwise_due(self) -> None:
        task: dict[str, Any] = {"task": "t50", "profile": "sol", "host": "far", "after": ["t42", "t43"]}
        self.state = "RUNNING"
        cases: list[tuple[str, list[dict[str, Any]], dict[str, int], list[dict[str, Any]]]] = [
            ("capacity", [row("t44")], {}, [task]),
            ("halt", [], {"halted": 1}, [task]),
            ("unreachable halt", [], {"halted": 4}, [task]),
            ("gate", [], {"gate": 1}, [task]),
            ("unreachable gate", [], {"gate": 4}, [task]),
            ("prerequisite with a row", [row("t42", state="reviewing", transport="subagent")], {}, [task]),
            ("queued prerequisite", [], {}, [{"task": "t42", "profile": "sol", "host": "far", "after": ["t43"]}, task]),
            # A native row: a CLI row past pending would hold far's one slot (slots_held), and the
            # capacity skip would then hide whether the row-not-pending guard skipped the task.
            ("already launched", [row("t50", transport="subagent")], {}, [task]),
        ]
        with self.world():
            for why, rows, rc, tasks in cases:
                with self.subTest(why=why):
                    self.rows, self.rc = rows, rc
                    self.queue(*tasks, capacity={"far": 1})
                    out = self.once()[1]
                    self.assertNotIn("DRIVE ATTENTION t50 launch: the queued task waits only", out)
                    self.assertEqual(self.launched(), [])

    def test_missing_after_does_not_hold_up_another_due_task(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far", "after": ["t42"]},
                   {"task": "t51", "profile": "sol", "host": "far", "after": ["t43"]},
                   {"task": "t52", "profile": "sol", "host": "far"})
        with self.world():
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t50 launch: the queued task waits only", out)
            self.assertIn("DRIVE ATTENTION t51 launch: the queued task waits only", out)
            self.assertEqual([c[3] for c in self.launched()], ["t52", "t52"])

    def test_nothing_is_prepared_while_the_launch_gate_refuses_and_the_coordinator_is_told_once(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far"})
        red = "BASE REFUSED: o/staging main: red at abc (base checker exit 1); dispatch blocked\n"
        os.makedirs(os.path.join(self.wavedir, "logs"), exist_ok=True)
        driver = wavedrive.Driver(self.cfg, wave.load_wave(self.path, "drive"))

        def tick() -> str:
            self.calls.clear()
            return captured(lambda: driver.round())[1]

        with self.world():
            self.rc, self.out = {"gate": 1}, {"gate stderr": "reading\n" + red}
            out = tick()
            self.assertEqual(self.calls, [["halted"], ["gate", "--target-repo", "o/staging", "--base-branch", "main"]], "the gate, and nothing prepared")
            self.assertIn("DRIVE ATTENTION t50 launch: the launch gate refuses, so no queued task is prepared or launched until it passes"
                          " (read again every 300 s): BASE REFUSED: o/staging main: red at abc", out)
            self.assertEqual((tick(), self.calls), ("", [["halted"]]), "not read again before its time: one base read each RETRY")
            self.clock += wavedrive.RETRY
            self.assertEqual((tick(), [c[0] for c in self.calls]), ("", ["halted", "gate"]), "the same refusal is told once")
            self.clock += wavedrive.RETRY
            self.out["gate stderr"] = "BASE REFUSED: o/staging main: red at def (base checker exit 1); dispatch blocked\n"
            self.assertIn("red at def", tick(), "another refusal is told")
            self.rc = {"gate": 4}
            self.clock += wavedrive.RETRY
            self.assertEqual((tick(), self.launched()), ("", []), "an anchor that does not answer is the next tick's")
            self.rc = {}
            tick()
            self.assertEqual([c[1] for c in self.launched()], ["prep", "launch"], "the gate passed: prepared at the tip as it is now, and launched")
        self.assertEqual(len(self.attention()), 2)
        self.assertEqual(self.ledger(), [(-1, "launch", "launching"), (-1, "launch", "answered")],
                         "a closed gate is no line of the task's: nothing of it was made")

    def test_a_prepared_task_is_launched_by_its_own_record_or_left_to_the_coordinator(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "mac"}, {"task": "t51", "profile": "sol", "host": "far"},
                   {"task": "t52", "profile": "sol", "host": "far"}, capacity={"far": 1, "mac": 1})
        self.rows = [row("t50", state="pending"), row("t51", state="pending"), row("t52", state="pending"), row("t44")]
        self.state = "RUNNING"
        self.manifest("t50", "far", B)
        self.manifest("t51", "far", A)
        self.manifest("t52", "far", B)
        with self.world():
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t50 launch: the task is prepared on far, and the queue names mac for it: a prepared task launches"
                          " where it was prepared; launch it by hand", out)
            self.assertEqual(self.launched(), [], "far is full, and mac's free slot is not the one this task would take")
            self.rows = self.rows[:3]
            out = self.once()[1]
            self.assertIn(f"DRIVE ATTENTION t51 launch: main moved since the task was prepared at {A[:12]} (now {B[:12]}): un-prepared,"
                          " to be prepared again at the tip under its own id", out)
            self.assertEqual(self.launched(), [["wave", "unprep", self.path, "t51"]], "a stale base is un-prepared, never sent to a launch that can only refuse it")
            self.assertEqual(self.ledger()[-1], (wavedrive.LAUNCH, "launch", "unprepared"), "a non-final line: the task can come due again")
            self.rows = [self.rows[0], self.rows[2]]  # what wave unprep removed: t51's row and manifest
            os.remove(os.path.join(self.wavedir, "prep", "t51.json"))
            self.once()
            self.assertEqual(self.launched(), [["wave", "prep", self.path, "t51", "--base", B, "--profile", "sol", "--host", "far"],
                                               ["wave", "launch", self.path, "t51"]], "...prepared again at the tip under its own id")
            self.assertIn(["refresh", "mac"], self.calls, "the agent host's served checkout is refreshed before the prep")
            self.rows.append(row("t51", state="merged #9"))
            self.once()
            self.assertEqual(self.launched(), [["wave", "launch", self.path, "t52"]], "a task prepared at the tip is launched, not prepared again")
        self.assertEqual(len(self.attention()), 2)

    def test_a_stale_prepared_task_whose_unprep_refuses_is_final_and_an_unknown_one_is_the_next_ticks(self) -> None:
        self.queue({"task": "t51", "profile": "sol", "host": "far"})
        self.rows = [row("t51", state="pending")]
        self.manifest("t51", "far", A)
        with self.world():
            self.rc["wave unprep"], self.out["wave unprep"] = 4, "WAVE UNPREP UNKNOWN t51: the anchor's registry could not be read; nothing removed\n"
            self.assertEqual(self.once()[1], "", "an unknown un-prepare is said nowhere")
            self.assertEqual(self.launched(), [["wave", "unprep", self.path, "t51"]])
            self.assertFalse(os.path.exists(os.path.join(self.wavedir, "logs", "drive.jsonl")), "and leaves no ledger line")
            self.rc["wave unprep"] = 1
            self.out["wave unprep"] = "WAVE UNPREP REFUSED t51: the registry holds wv-t51-far-iterate (concluded): a launch reserved it\n"
            out = self.once()[1]
            self.assertIn("its un-prepare refused: WAVE UNPREP REFUSED t51: the registry holds wv-t51-far-iterate (concluded)", out)
            self.assertEqual(self.ledger(), [(wavedrive.LAUNCH, "launch", "attention")])
            self.assertEqual((self.once()[1], self.launched()), ("", []), "final: said once, nothing called again")

    def test_an_unprep_that_stopped_past_the_row_is_finished_before_any_prep(self) -> None:
        """The row's removal landed and its acknowledgement was lost: no row, and a fenced manifest."""
        self.queue({"task": "t51", "profile": "sol", "host": "far"})
        self.manifest("t51", "far", A)
        path = os.path.join(self.wavedir, "prep", "t51.json")
        with open(path) as f:
            fenced = json.load(f)
        with open(path, "w") as f:
            json.dump({**fenced, "done": ["ready", "unprepare"]}, f)
        with self.world():
            out = self.once()[1]
            self.assertEqual(self.launched(), [["wave", "unprep", self.path, "t51"]], "never a prep that would refuse on the manifest")
            self.assertIn("DRIVE ATTENTION t51 launch: an un-prepare of the task stopped before it ended", out)
            self.assertEqual(self.ledger()[-1], (wavedrive.LAUNCH, "launch", "unprepared"))
            os.remove(path)
            self.once()
            self.assertEqual([c[:2] for c in self.launched()], [["wave", "prep"], ["wave", "launch"]])

    def test_a_fenced_manifest_with_its_pending_row_is_un_prepared_never_launched(self) -> None:
        """A hand unprep wrote its fence and stopped at the row: the row is still pending, the base still the tip."""
        self.queue({"task": "t51", "profile": "sol", "host": "far"})
        self.rows = [row("t51", state="pending")]
        self.manifest("t51", "far", B)
        path = os.path.join(self.wavedir, "prep", "t51.json")
        with open(path) as f:
            fenced = json.load(f)
        with open(path, "w") as f:
            json.dump({**fenced, "done": ["ready", "unprepare"]}, f)
        with self.world():
            out = self.once()[1]
        self.assertEqual(self.launched(), [["wave", "unprep", self.path, "t51"]], "never a launch that would refuse on the fence")
        self.assertIn("DRIVE ATTENTION t51 launch: an un-prepare of the task stopped before it ended", out)

    def test_unprep_reads_the_drivers_launch_turn(self) -> None:
        self.assertEqual(waveunprep.LAUNCH_TURN, wavedrive.LAUNCH)

    def test_a_refresh_that_fails_never_stops_a_prep_and_is_beside_a_prep_that_refuses(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far"}, {"task": "t51", "profile": "sol", "host": "far"})
        with self.world():
            self.rc["refresh"], self.out["refresh"] = 1, "REFRESH REFUSED mac: the skills checkout has diverged from origin/main\n"
            self.once()
            self.assertEqual([c[:2] for c in self.calls if c[0] in ("refresh", "wave")],
                             [["refresh", "mac"], ["wave", "prep"], ["wave", "launch"]], "the prep goes on")
            self.rows = [row("t50")]
            self.rc["wave prep"], self.out["wave prep"] = 1, "WAVE PREP REFUSED t51: the template part tasks/t51.md does not exist\n"
            out = self.once()[1]
            self.assertIn("launch it by hand (the refresh of mac's skills checkout before it: REFRESH REFUSED mac: the skills checkout"
                          " has diverged from origin/main)", out)

    def test_a_task_whose_prerequisite_ended_without_a_merge_is_told_once_and_the_next_is_served(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far", "after": ["t42", "t43"]}, {"task": "t51", "profile": "sol", "host": "far"})
        self.rows = [row("t42", state="closed: superseded"), row("t43", state="dropped")]
        with self.world():
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t50 launch: the queued task cannot come due: t42, t43, which it comes after, ended without a"
                          " merge (closed); launch it by hand, or take it off the queue", out)
            self.assertEqual([c[3] for c in self.launched()], ["t51", "t51"], "a task that cannot come due does not hold the queue")
            self.rows.append(row("t51"))
            self.state = "RUNNING"
            self.assertEqual((self.once()[1], self.launched()), ("", []), "final: said once")
        self.assertEqual(len(self.attention()), 1)

    def test_a_refused_prep_is_final_a_refused_launch_is_told_once_and_retried(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far"}, {"task": "t51", "profile": "sol", "host": "far"})
        with self.world():
            self.rc["wave prep"], self.out["wave prep"] = 1, "WAVE PREP REFUSED t50: open rival PR(s) #9 Fix #50\n"
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t50 launch: the queued task was not prepared: WAVE PREP REFUSED t50: open rival PR(s) #9", out)
            self.assertEqual([c[1] for c in self.launched()], ["prep"])
            self.rc, self.out = {"wave launch": 1}, {"wave launch": "LAUNCH REFUSED far/w1-51: base red at abc\n"}
            out = self.once()[1]
            self.assertEqual([c[3] for c in self.launched()], ["t51", "t51"], "t50 is final: the next task is the first due")
            self.assertIn("DRIVE ATTENTION t51 launch: the queued launch was refused and is tried again every 300 s: LAUNCH REFUSED far/w1-51: base red", out)
            self.rows = [row("t51", state="pending")]
            self.assertEqual((self.once()[1], self.launched()), ("", []), "not before its retry time")
            self.clock += wavedrive.RETRY
            self.out = {"wave launch stderr": "fetching\nBASE REFUSED: o/up main: red at abc (base checker exit 1); dispatch blocked\n"}
            out = self.once()[1]
            self.assertEqual([c[1] for c in self.launched()], ["launch"], "a prepared task is launched, not prepared again")
            self.assertNotIn("ATTENTION", out, "told once")
            self.assertEqual(self.ledger()[-1], (-1, "launch", "retry"), "the base gate's refusal is on stderr, and is retried like the launch's own")
            with open(os.path.join(self.wavedir, "logs", "drive.jsonl")) as f:
                self.assertIn("BASE REFUSED: o/up main: red at abc", f.read().splitlines()[-1])
            self.clock += wavedrive.RETRY
            self.rc, self.out["wave launch"] = {}, "WAVE LAUNCH t51: launched far/w1-51 worktree /w standing x\n"
            self.assertIn("launch answered", self.once()[1])
        self.assertEqual(len(self.attention()), 2)

    def test_any_other_end_of_a_launch_is_final_and_transient_reads_are_the_next_ticks(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far"}, {"task": "t51", "profile": "sol", "host": "far"},
                   {"task": "t52", "profile": "sol", "host": "far"}, capacity={"far": 9})
        with self.world():
            for transient in ({"git fetch": 1}, {"git rev-parse": 1}, {"wave prep": 4}):
                self.rc = dict(transient)
                self.assertEqual(self.once()[1], "", transient)
            self.assertFalse(os.path.exists(os.path.join(self.wavedir, "logs", "drive.jsonl")))
            for task, rc, said, why in (("t50", 3, "WAVE LAUNCH t50: launched far/w1-50 worktree /w standing x\n", "wave launch exit 3"),
                                        ("t51", 4, "LAUNCH UNKNOWN far/w1-51: reservation remains dispatched\n", "wave launch exit 4"),
                                        ("t52", 1, "WAVE LAUNCH REFUSED t52: its prep did not finish\n", "wave launch exit 1: WAVE LAUNCH REFUSED t52")):
                self.rc, self.out["wave launch"] = {"wave launch": rc}, said
                out = self.once()[1]
                self.assertIn(f"DRIVE ATTENTION {task} launch: {why}", out)
            self.assertEqual((self.once()[1], self.launched()), ("", []))
            self.rc, self.out = {"wave prep": 1}, {"wave prep stderr": "WAVE PREP REFUSED fleet: coordinator lease held by session-other\n"}
            os.remove(os.path.join(self.wavedir, "logs", "drive.jsonl"))
            rc, out = self.once()
            self.assertEqual(rc, 1)
            self.assertIn("DRIVE STOPPED wv: the lease is another coordinator's", out)

    def test_a_launch_that_may_have_started_a_worker_holds_its_hosts_slot_until_its_row_says(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far"}, {"task": "t51", "profile": "sol", "host": "far"},
                   {"task": "t52", "profile": "sol", "host": "far"}, capacity={"far": 1})
        with self.world():
            self.rc, self.out = {"wave launch": 3}, {"wave launch": "WAVE LAUNCH NOTE t50: the row is not set (board set exit 1)\n"
                                                                    "WAVE LAUNCH t50: launched far/w1-50 worktree /w standing x\n"}
            self.assertIn("DRIVE ATTENTION t50 launch: wave launch exit 3", self.once()[1])
            self.rc, self.out = {}, {}
            for rows in ([], [row("t50", state="pending")]):
                self.rows = rows
                self.assertEqual((self.once()[1], self.launched()), ("", []), f"t50's worker may be running, and its row does not say so: {rows}")
            self.rows = [row("t50", state="launched")]
            self.state = "RUNNING"
            self.assertEqual((self.once()[1], self.launched()), ("", []), "the coordinator set the row: it holds the slot itself, once")
            self.rows = [row("t50", state="merged #9")]
            self.rc, self.out = {"wave launch": 1}, {"wave launch": "WAVE LAUNCH REFUSED t51: its prep did not finish\n"}
            self.assertIn("DRIVE ATTENTION t51 launch: wave launch exit 1: WAVE LAUNCH REFUSED t51", self.once()[1])
            self.rc, self.out = {}, {}
            self.once()
            self.assertEqual([c[3] for c in self.launched()], ["t52", "t52"], "the verb's own refusal started nothing, and holds no slot")

    def test_a_launch_a_stopped_driver_left_unfinished_is_told_and_holds_its_slot(self) -> None:
        self.queue({"task": "t50", "profile": "sol", "host": "far"}, {"task": "t51", "profile": "sol", "host": "far"}, capacity={"far": 1})

        def dies(argv: list[str], timeout: float | None = None) -> tuple[int, str, str]:
            if argv[1:3] == ["wave", "launch"]:
                raise KeyboardInterrupt
            return self.execute(argv, timeout)

        with self.world(), mock.patch.object(wavedrive, "execute", side_effect=dies), self.assertRaises(KeyboardInterrupt):
            self.once()
        self.assertEqual(self.ledger(), [(-1, "launch", "launching")], "the launch is on record before it is made")
        self.rows = [row("t50", state="pending")]
        with self.world():
            out = self.once()[1]
            self.assertIn("DRIVE ATTENTION t50 launch: a launch of the task was begun and its end was not recorded (the driver stopped"
                          " meanwhile): read its worker's status on far; the task is yours from here", out)
            self.assertEqual(self.launched(), [], "not launched again, and its slot is held: t51 waits")
            self.assertEqual((self.once()[1], self.launched()), ("", []))
            self.rows = [row("t50", state="dropped")]
            self.once()
            self.assertEqual([c[3] for c in self.launched()], ["t51", "t51"])

    def test_the_queue_file_is_a_fail_closed_allowlist_said_once(self) -> None:
        good = {"task": "t50", "profile": "sol", "host": "far"}
        with self.world():
            self.assertEqual(self.once()[1], "", "no queue file: nothing is launched")
            for tasks, capacity, why in (([{**good, "extra": 1}], None, "takes task, profile, host and optionally"),
                                         ([{"task": "t50", "profile": "sol"}], None, "takes task, profile, host"),
                                         ([good, good], None, "is queued twice"), ([{**good, "task": "5x"}], None, "is no task id"),
                                         ([{**good, "profile": "opus"}], None, "is no cli profile of the wave file"),
                                         ([{**good, "profile": "astra"}], None, "is no cli profile of the wave file"),
                                         ([{**good, "host": "rog"}], None, "host 'rog' has no capacity"),
                                         ([{**good, "issue": "1", "source": "2"}], None, "names both an issue and a source"),
                                         ([{**good, "after": "t42"}], None, "legs and after lists of text"),
                                         ([{**good, "after": ["42"]}], None, "after takes task ids"),
                                         ([{**good, "after": ["t50"]}], None, "comes after itself"),
                                         ([{**good, "task": "t49", "after": ["t50"]}, good], None, "is queued after a task that waits on it"),
                                         ([good], {"far": 0}, "capacity.far must be a whole number of workers, at least 1")):
                self.queue(*tasks, capacity=capacity)
                driver = wavedrive.Driver(self.cfg, wave.load_wave(self.path, "drive"))
                os.makedirs(os.path.join(self.wavedir, "logs"), exist_ok=True)
                self.calls.clear()
                _, out, _ = captured(lambda d=driver: d.round() + d.round() + d.round())
                self.assertEqual(out.count("DRIVE QUEUE REFUSED wv: "), 1, "a driver says a refused queue once")
                self.assertIn(why, out)
                self.assertEqual(self.launched(), [], "and launches nothing")
            with open(os.path.join(self.wavedir, "queue.json"), "w") as f:
                f.write('{"tasks": [], "queue": 1}')
            self.assertIn("is one object with the keys capacity, tasks and no other", self.once()[1])
            self.queue(good)
            with open(self.path, "w") as f:
                json.dump(wave_data(self.dir, vars={"COORD": "s"}, **MIXED), f)
            self.calls.clear()
            self.assertIn("names no vars.MAIN, the branch a queued task is prepared at", self.once()[1])
            self.assertEqual(self.launched(), [])
            with open(self.path, "w") as f:
                json.dump(wave_data(self.dir, vars={"COORD": "s", "MAIN": "main"}, **MIXED), f)
            self.queue(good)
            self.once()
            self.assertEqual([c[1] for c in self.launched()], ["prep", "launch"], "a queue that reads again is served")


class Heartbeat(unittest.TestCase):
    def test_the_drivers_state_and_each_new_attention_line_are_printed_once(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "wave.json")
            with open(path, "w") as f:
                json.dump(wave_data(d, loops={}), f)
            cfg = load_config(SCRIPT, {"HOME": d})
            with mock.patch.object(wave, "run", return_value=Done(0, "")):
                _, out, _ = captured(wave.cmd_heartbeat, cfg, [path, "--sleep", "0"])
                self.assertNotIn("HEARTBEAT drive", out, "a wave no driver served prints no driver line")
                os.makedirs(os.path.join(d, "logs"))
                attention = os.path.join(d, "logs", "attention.jsonl")
                with open(os.path.join(d, "logs", "drive.log"), "w") as f:
                    f.write("2026-11-13T12:00:00Z DRIVE t42 turn 0: request answered: assigned\n")
                with open(attention, "w") as f:
                    f.write(json.dumps({"task": "t42", "turn": 1, "why": "no marker", "file": "/m/t42-1.md"}) + "\n")
                with open(os.path.join(d, "logs", "drive.lock"), "a") as held:
                    fcntl.flock(held.fileno(), fcntl.LOCK_EX)
                    _, out, _ = captured(wave.cmd_heartbeat, cfg, [path, "--sleep", "0"])
                self.assertIn("HEARTBEAT drive: running; 2026-11-13T12:00:00Z DRIVE t42 turn 0: request answered: assigned\n", out)
                self.assertIn("HEARTBEAT attention t42 turn 1: no marker (/m/t42-1.md)\n", out)
                _, out, _ = captured(wave.cmd_heartbeat, cfg, [path, "--sleep", "0"])
                self.assertIn("HEARTBEAT drive: NOT RUNNING; ", out)
                self.assertNotIn("HEARTBEAT attention", out, "a line is printed by one heartbeat")
                with open(attention, "a") as f:
                    f.write(json.dumps({"task": "t43", "turn": 0, "why": "ORPHANED"}) + "\n")
                started = time.monotonic()
                _, out, _ = captured(wave.cmd_heartbeat, cfg, [path, "--sleep", "600"])
                self.assertLess(time.monotonic() - started, 5, "a new attention line ends the sleep")
                self.assertIn("HEARTBEAT attention t43 turn 0: ORPHANED\n", out)
                self.assertRegex(out.rstrip("\n").split("\n")[-1], r"^HEARTBEAT wv ")

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
