"""ludics.fleetworker.wave, wavebrief, waveprep, waveloop: the coordinator kit (ludics#1047). The
shell suite's "wave kit" section drives the verbs end to end through fleet-worker.sh."""

import contextlib
import fcntl
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Generator
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import revision, takeover, wave, wavelaunch, waveloop, waveprep, wavereview
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
        self.assertIn("gh issue view <N> --repo o/up --json number,title,body,comments", brief)
        self.assertIn("pr-review.sh merge o/staging#<pr> --wait", brief)
        self.assertNotIn("@@", brief)

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

    def test_a_part_neither_the_wave_nor_the_repository_has_refuses(self) -> None:
        os.unlink(os.path.join(self.wavedir, "common.md"))
        self.rewave(kind="codex")
        with self.world():
            rc, out, _ = self.prep("t42", "--base", "main")
        self.assertEqual(rc, 1)
        self.assertIn(f"the template part {self.wavedir}/common.md does not exist, nor the shipped "
                      f"{waveprep.shipped_dir('codex')}/common.md", out)
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
                                     "farside=gpu-box:/home/u/repo-worktrees/w1-42-gpu"])
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
            self.assertIn("farside=none", self.shim_calls[-1])
            self.assertEqual(self.manifest()["done"][-1], "launched far/w1-42", "the worker runs: the launch is recorded")

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
            self.assertIn("farside=gpu-box:/home/u/repo-worktrees/w1-42-gpu", board)
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


class ShippedTemplate(unittest.TestCase):
    """The shipped template renders for a minimal ludics wave file with this checkout's project
    part, for an issue task in each planning mode and for a --source task: no placeholder left."""

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
