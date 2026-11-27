"""ludics.peerplan: paired planning's second planner, end to end through the real bg-run.sh.

A fake ``gh`` (tests/fake.py, routed by argv) answers the issue read and ``api user``, and a fake
``codex`` records its argv, cwd and stdin, writes its ``-o`` file and prints a ``thread.started``
event, so each test drives the entry point as the coordinator does: ``start``, ``bg-run.sh wait``,
``critique``, ``wait``, ``clean``.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from dataclasses import dataclass
from typing import cast

from ludics import cli
from ludics.peerplan import plan
from ludics.tests.fake import Answer, FakeTool, When

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
ENTRY = os.path.join(ROOT, "issue-wave", "scripts", "peer-plan.sh")
BG_RUN = os.path.join(ROOT, "issue-wave", "scripts", "bg-run.sh")
FLEET = os.path.join(ROOT, "issue-wave", "scripts", "fleet-worker.sh")
ISSUE: dict[str, object] = {"number": 7, "title": "t", "body": "has a ``` fence\n````\n", "comments": []}

# The codex fake is this suite's own program, over FakeTool's: it records its stdin and cwd beside
# its argv, and its hang mode sleeps until bg-run.sh stop kills it, which an Answer cannot do.
FAKE_CODEX = """\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
stdin = sys.stdin.read()
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "stdin": stdin, "pre": os.path.exists("agy-scratch.txt")}) + "\\n")
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
if mode == "write-then-hang":  # codex writes its -o file before its turn ends
    with open(argv[argv.index("-o") + 1], "w", encoding="utf-8") as f:
        f.write("plan")
    mode = "hang"
if mode == "hang":
    with open(os.path.join(here, "pid"), "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    import time
    time.sleep(600)
if mode == "fail":
    sys.stderr.write("model at capacity\\n")
    sys.exit(5)
print(json.dumps({"type": "thread.started", "thread_id": "tid-1"}))
if mode != "silent":
    out = argv[argv.index("-o") + 1]
    with open(out, "w", encoding="utf-8") as f:
        f.write("critique" if "reviewing an implementation plan" in stdin else "plan")
"""

# The claude fake: one JSON result on stdout, as `claude -p --output-format json` prints it.
FAKE_CLAUDE = """\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
stdin = sys.stdin.read()
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "stdin": stdin}) + "\\n")
error = os.environ.get("FAKE_CLAUDE_MODE") == "error"
said = "critique" if "reviewing an implementation plan" in stdin else "plan"
print(json.dumps({"type": "result", "is_error": error, "session_id": "sid-1",
                  "result": "Credit balance is too low" if error else said}))
"""

FAKE_AGY = """\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
stdin = sys.stdin.read()
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "stdin": stdin, "pre": os.path.exists("agy-scratch.txt")}) + "\\n")
mode = os.environ.get("FAKE_AGY_MODE", "ok")
with open("agy-scratch.txt", "w") as f:  # a write of its own, in the directory it runs in
    f.write("x")
said = "critique" if "reviewing an implementation plan" in stdin else "plan"
result = {"conversation_id": "conv-1", "status": "ERROR" if mode == "error" else "SUCCESS",
          "response": "" if mode == "error" else said}
print(json.dumps({"event": "init", "conversation_id": "conv-1", "init": {}}))
print(json.dumps({"event": "result", "result": result}))
"""


@dataclass(frozen=True)
class Call:
    argv: list[str]
    cwd: str
    stdin: str


def running(pid: int) -> bool:
    """Whether ``pid`` names a process that can still run: a zombie no PID 1 reaps (a container's,
    say) still answers ``kill -0``, and has stopped all the same."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False)
    return not stat.stdout.strip().startswith("Z") and stat.stdout.strip() != ""


def git(*args: str) -> str:
    done = subprocess.run(["git", *args], capture_output=True, text=True, check=True)
    return done.stdout.strip()


class CleanUnread(unittest.TestCase):
    def test_dangling_runs_never_removes_worktree(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ludics-clean.") as tmp:
            os.symlink("missing", os.path.join(tmp, "runs"))
            meta = plan.Meta("o/r#7", tmp, "main", tmp, "m", "high")
            with (
                mock.patch.object(plan, "load_meta", return_value=meta),
                mock.patch.object(plan.proc, "run_tool") as git_call,
                self.assertRaises(cli.Exit) as refused,
            ):
                plan.clean([tmp])
            self.assertEqual(refused.exception.rc, 1)
            git_call.assert_not_called()


class PeerPlan(unittest.TestCase):
    def setUp(self) -> None:
        if shutil.which("perl") is None or os.name == "nt":
            self.skipTest("bg-run.sh spawn needs perl and POSIX sessions")
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="ludics-peerplan."))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = os.path.join(self.tmp, "repo")
        git("init", "-q", "-b", "main", self.repo)
        git("-C", self.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base")
        self.gh = FakeTool("gh")
        self.answer_gh()
        self.gh.__enter__()
        self.addCleanup(self.gh.__exit__, None, None, None)
        self.codex = FakeTool("codex")
        with open(os.path.join(self.codex.dir, "codex"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{FAKE_CODEX}")
        self.codex.__enter__()
        self.addCleanup(self.codex.__exit__, None, None, None)
        os.environ.pop("FAKE_CODEX_MODE", None)
        self.claude = FakeTool("claude")
        with open(os.path.join(self.claude.dir, "claude"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{FAKE_CLAUDE}")
        self.claude.__enter__()
        self.addCleanup(self.claude.__exit__, None, None, None)
        os.environ.pop("FAKE_CLAUDE_MODE", None)
        self.agy = FakeTool("agy")
        with open(os.path.join(self.agy.dir, "agy"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{FAKE_AGY}")
        self.agy.__enter__()
        self.addCleanup(self.agy.__exit__, None, None, None)
        os.environ.pop("FAKE_AGY_MODE", None)
        self.dir = os.path.join(self.tmp, "plans", "w-7")

    def answer_gh(self, login: str = "maint", issue: Answer = Answer(stdout=json.dumps(ISSUE))) -> None:
        """The issue read and ``api user``, each answered by its own arguments: ``start`` makes both."""
        self.gh.route((When(prefix=("issue", "view")), issue), (When(prefix=("api", "user")), Answer(stdout=login + "\n")))

    def entry(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([ENTRY, *args], capture_output=True, text=True, check=False)

    def fleet(self, *args: str) -> str:
        done = subprocess.run([FLEET, *args], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, (done.stdout, done.stderr))
        return done.stdout

    def paired_board(self, mode: str) -> None:
        state = os.path.join(self.tmp, "fleet")
        env = mock.patch.dict(os.environ, {
            "FLEET_ANCHOR": "local", "FLEET_ANCHOR_STATE": state, "ISSUE_WAVE_STATE": state,
            "FLEET_LOCAL_BOX": "testbox", "FLEET_BOXES": "testbox", "FLEET_SKILLS_REPO": ROOT,
            "FLEET_COORDINATOR": "peerplan-test",
        })
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("FLEET_REGISTRY_PIN", None)
        self.fleet("claim")
        self.fleet("board", "set", "--create", "--new-row", "w", "t7",
                   f"planning={mode}", f"plan_dir={self.dir}", "model=worker/high")
        self.fleet("board", "set", "--new-row", "w", "t8", "state=pending")

    def board_fields(self) -> dict[str, dict[str, str]]:
        return {row["task"]: row["fields"] for row in json.loads(self.fleet("board", "show", "w", "--json"))["tasks"]}

    def start_on_board(self, task: str, *args: str) -> str:
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main",
                          "--wave", "w", "--task", task, *args)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def assert_start_refused(self, diagnostic: str, *args: str, status: int = 2) -> None:
        worktrees = git("-C", self.repo, "worktree", "list", "--porcelain")
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main",
                          "--managed", *args)
        self.assertEqual((done.returncode, done.stdout, os.path.lexists(os.path.dirname(self.dir)),
                          git("-C", self.repo, "worktree", "list", "--porcelain")),
                         (status, "", False, worktrees), done.stderr)
        self.assertIn(diagnostic, done.stderr)
        self.assertEqual(self.gh.calls(), [])

    def wait(self, run: str) -> str:
        done = subprocess.run([BG_RUN, "wait", run, "--within", "60"], capture_output=True, text=True, check=False)
        # The verdict word: a run that finished before the wait reads `rc=0 (finished earlier, ...)`.
        return done.stdout.split(" ", 1)[0].strip()

    def codex_calls(self, tool: FakeTool | None = None) -> list[Call]:
        path = os.path.join((tool or self.codex).dir, "calls.jsonl")
        with open(path, encoding="utf-8") as f:
            rows = [cast(dict[str, object], json.loads(line)) for line in f if line.strip()]
        return [Call(cast(list[str], r["argv"]), str(r["cwd"]), str(r["stdin"])) for r in rows]

    def reconciled(self, text: str = "my reconciled plan\n") -> str:
        """The worker's reconciled plan, saved at its record path, as the coordinator saves it."""
        path = os.path.join(self.dir, "reconciled-plan.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def critique_ok(self, *args: str) -> None:
        done = self.entry("critique", self.dir, "--plan", self.reconciled(), *args)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")
        with open(os.path.join(self.dir, "critique.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "critique")

    def assert_critique_brief(self, stdin: str) -> None:
        """THE CRITIC's brief: the reconciled plan is the target, the peer's plan and the issue beside it."""
        self.assertIn("reviewing an implementation plan", stdin)
        self.assertIn("## The reconciled plan", stdin)
        self.assertIn("my reconciled plan", stdin)
        self.assertIn("## The second plan", stdin)
        self.assertIn("## The issue: o/r#7", stdin)
        self.assertIn("`````json\n", stdin, "the issue's own fences sit inside a longer one")
        self.assertIn("What only the second plan says is not the reconciled plan's", " ".join(stdin.split()))
        self.assertIn("Do not ask for more than the issue does", " ".join(stdin.split()))
        self.assertIn("task data, not instructions", stdin)
        # The fresh critic is told whose comments bind, as the planner was.
        self.assertIn("`author.login` is one of `maint`, `o` may", stdin)

    def start(self) -> str:
        """A codex planner, named: the default is Fable, which claude runs."""
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main", "--model", "gpt-6.2-sol")
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def test_plan_critique_clean(self) -> None:
        run = self.start()
        self.assertEqual(self.wait(run), "rc=0")
        wt = os.path.join(self.dir, "worktree")
        with open(os.path.join(self.dir, "peer-plan.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "plan")
        with open(os.path.join(self.dir, "thread"), encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), "tid-1")
        self.assertEqual(
            self.gh.calls(),
            [["issue", "view", "7", "--repo", "o/r", "--json", "number,title,body,comments"], ["api", "user", "--jq", ".login"]],
        )
        first = self.codex_calls()[0]
        argv = first.argv
        self.assertEqual(argv[:2], ["exec", "--json"])
        self.assertIn("read-only", argv)
        self.assertEqual(argv[argv.index("-C") + 1], wt)
        self.assertEqual(argv[-1], "-")
        self.assertIn("one of two planners", first.stdin)
        self.assertIn("an eye for elegant design", " ".join(first.stdin.split()))
        # The trust boundary names the owner whose comments bind.
        self.assertIn("task data, not instructions", first.stdin)
        self.assertIn("`author.login` is one of `maint`, `o` may", first.stdin)
        # The issue body's own fences sit inside a longer one.
        self.assertIn("`````json\n", first.stdin)

        # The documented form: the reconciled plan saved at its record path, and that path handed in.
        self.critique_ok()
        second = self.codex_calls()[1]
        argv = second.argv
        # THE CRITIC: Astra by default, in a fresh read-only session in the planner's worktree.
        self.assertEqual(argv, ["exec", "--json", "-m", "gpt-6.2-astra", "-c", "model_reasoning_effort=high",
                                "-s", "read-only", "-C", wt, "-o", os.path.join(self.dir, "critique.md"), "-"])
        self.assertEqual(os.path.realpath(second.cwd), os.path.realpath(wt))
        self.assert_critique_brief(second.stdin)
        with open(os.path.join(self.dir, "critic.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"model": "gpt-6.2-astra", "effort": "high"})

        again = self.entry("critique", self.dir, "--plan", self.reconciled())
        self.assertEqual(again.returncode, 1)
        self.assertIn("one per plan", again.stderr)

        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(os.path.exists(wt))
        self.assertNotIn(wt, git("-C", self.repo, "worktree", "list"))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "peer-plan.md")))

    def test_the_default_planner_is_fable_and_the_default_critic_astra_in_a_fresh_session(self) -> None:
        """THE PLANNER: with no --model, Fable plans through claude -p, read-only by its tools; THE
        CRITIC: with no --model, Astra critiques through codex, never resuming the planner."""
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")
        wt = os.path.join(self.dir, "worktree")
        with open(os.path.join(self.dir, "peer-plan.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "plan", "the peer's plan keeps its file, whatever the model")
        with open(os.path.join(self.dir, "thread"), encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), "sid-1")
        self.assertFalse(os.path.exists(os.path.join(self.codex.dir, "calls.jsonl")), "no codex run")
        first = self.codex_calls(self.claude)[0]
        self.assertEqual(first.argv, ["-p", "--model", "fable", "--effort", "high", "--output-format", "json",
                                      "--strict-mcp-config", "--tools", "Read,Grep,Glob"])
        self.assertNotIn("--mcp-config", first.argv)
        self.assertEqual(os.path.realpath(first.cwd), os.path.realpath(wt))
        self.assertIn("one of two planners", first.stdin)
        self.critique_ok()
        self.assertEqual(len(self.codex_calls(self.claude)), 1, "the planner's session is not resumed")
        critic, = self.codex_calls()
        self.assertEqual(critic.argv[:4], ["exec", "--json", "-m", "gpt-6.2-astra"])
        self.assertEqual(os.path.realpath(critic.cwd), os.path.realpath(wt))
        self.assert_critique_brief(critic.stdin)
        # The peer plan reaches the critic labelled as the second plan.
        self.assertIn("## The second plan\n\n```markdown\nplan\n```", critic.stdin)

    def test_the_paired_row_records_the_default_planner_and_an_unpaired_row_has_none(self) -> None:
        self.paired_board("paired")
        self.assertEqual(self.wait(self.start_on_board("t7")), "rc=0")
        rows = self.board_fields()
        self.assertEqual((rows["t7"]["planner"], rows["t7"]["planner_effort"], rows["t7"]["model"]),
                         ("fable", "high", "worker/high"))
        self.assertNotIn("planner", rows["t8"])
        self.assertNotIn("planner_effort", rows["t8"])

    def test_an_unpaired_row_refuses_before_allocation(self) -> None:
        self.paired_board("paired")
        self.assert_start_refused("planner fields require a paired planning mode", "--wave", "w", "--task", "t8")
        self.assertNotIn("planner", self.board_fields()["t8"])

    def test_a_mistyped_task_refuses_before_allocation(self) -> None:
        self.paired_board("paired")
        self.assert_start_refused('no task "t77" on the board of w', "--wave", "w", "--task", "t77")

    def test_a_missing_board_refuses_before_allocation(self) -> None:
        self.paired_board("paired")
        self.assert_start_refused("no board for wave other", "--wave", "other", "--task", "t7")

    def test_an_unreadable_board_fails_before_allocation(self) -> None:
        self.paired_board("paired")
        with open(os.path.join(self.tmp, "fleet", "boards", "w.json"), "w", encoding="utf-8") as f:
            f.write("invalid JSON\n")
        self.assert_start_refused("cannot read the board of w", "--wave", "w", "--task", "t7", status=1)

    def test_a_mismatched_plan_dir_refuses_before_allocation(self) -> None:
        self.paired_board("paired")
        self.fleet("board", "set", "w", "t8", "planning=paired", f"plan_dir={self.dir}-other")
        before = self.board_fields()
        self.assert_start_refused('planner fields require the recorded plan_dir on "t8"', "--wave", "w", "--task", "t8")
        self.assertEqual(self.board_fields(), before)

    def test_a_plan_dir_changed_after_allocation_refuses_before_dispatch(self) -> None:
        self.paired_board("paired")
        run = self.start_on_board("t7", "--managed")
        self.fleet("board", "set", "w", "t7", f"plan_dir={self.dir}-other")
        before = self.board_fields()
        subprocess.run([BG_RUN, "start", run, "--", ENTRY, "_run", "plan", self.dir],
                       capture_output=True, text=True, check=False)
        self.assertEqual(self.wait(run), "rc=1")
        with open(os.path.join(run, "log"), encoding="utf-8") as f:
            self.assertIn('planner fields require the recorded plan_dir on "t7"', f.read())
        self.assertEqual(self.board_fields(), before)
        self.assertFalse(os.path.exists(os.path.join(self.claude.dir, "calls.jsonl")))

    def test_a_stdout_only_board_lease_refusal_is_in_the_run_log(self) -> None:
        self.paired_board("paired")
        self.fleet("release")
        run = self.start_on_board("t7")
        self.assertEqual(self.wait(run), "rc=1")
        with open(os.path.join(run, "log"), encoding="utf-8") as f:
            self.assertIn("coordinator lease held by nobody", f.read())
        self.assertFalse(os.path.exists(os.path.join(self.claude.dir, "calls.jsonl")))

    def test_a_claude_critic_runs_fresh_with_read_only_tools_and_needs_no_session_id(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        os.remove(os.path.join(self.dir, "thread"))
        self.critique_ok("--model", "opus", "--effort", "medium")
        critic, = self.codex_calls(self.claude)
        self.assertEqual(critic.argv, ["-p", "--model", "opus", "--effort", "medium", "--output-format", "json",
                                       "--strict-mcp-config", "--tools", "Read,Grep,Glob"])
        self.assertEqual(os.path.realpath(critic.cwd), os.path.realpath(os.path.join(self.dir, "worktree")))
        self.assert_critique_brief(critic.stdin)
        with open(os.path.join(self.dir, "critic.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"model": "opus", "effort": "medium"})

    def test_a_gemini_critic_is_refused_in_a_worktree_of_the_checkout(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        done = self.entry("critique", self.dir, "--plan", self.reconciled(), "--model", "gemini-4-neon-high")
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("a gemini critic runs only in a gemini planner's clone", done.stderr)
        self.assertFalse(os.path.lexists(os.path.join(self.dir, "critique-brief.md")), "a refusal leaves no critique marker")
        self.assertFalse(os.path.exists(os.path.join(self.agy.dir, "calls.jsonl")))

    def test_a_bad_critic_model_or_effort_is_a_usage_error(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        for option, value in (("--model", "-x"), ("--effort", "-high")):
            with self.subTest(option=option):
                done = self.entry("critique", self.dir, "--plan", self.reconciled(), option, value)
                self.assertEqual(done.returncode, 2, done.stdout)
                self.assertIn(f"{option} must match", done.stderr)
        self.assertFalse(os.path.lexists(os.path.join(self.dir, "critique-brief.md")))

    def test_bad_model_or_effort_refuses_before_allocation(self) -> None:
        cases = (("--effort", "-high"), ("--model", "-x"), ("--model", ""), ("--effort", "a\nb"))
        for index, (option, value) in enumerate(cases):
            with self.subTest(option=option, value=value):
                self.dir = os.path.join(self.tmp, f"plans-{index}", "w-7")
                self.assert_start_refused(f"{option} must match", option, value)

    def test_a_gemini_planner_runs_agy_in_a_clone_and_a_gemini_critic_runs_fresh_there(self) -> None:
        """THE PLANNER: a gemini-... model plans through agy with every tool approved, in a clone with no
        remote: its own write stays in the clone, and the checkout gains no worktree."""
        self.paired_board("paired")
        run = self.start_on_board("t7", "--model", "gemini-4-neon-high", "--effort", "low")
        self.assertEqual(self.wait(run), "rc=0")
        fields = self.board_fields()["t7"]
        self.assertEqual((fields["planner"], fields["planner_effort"]), ("gemini-4-neon-high", ""))
        wt = os.path.join(self.dir, "worktree")
        with open(os.path.join(self.dir, "peer-plan.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "plan")
        with open(os.path.join(self.dir, "thread"), encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), "conv-1")
        first = self.codex_calls(self.agy)[0]
        self.assertEqual(first.argv, ["--model", "gemini-4-neon-high", "--input-format", "stream-json", "--output-format",
                                      "stream-json", "--dangerously-skip-permissions"])
        self.assertEqual(os.path.realpath(first.cwd), os.path.realpath(wt))
        self.assertIn("one of two planners", json.loads(first.stdin)["message"]["content"])
        self.assertTrue(os.path.isdir(os.path.join(wt, ".git")), "a clone, not a worktree")
        self.assertEqual(git("-C", wt, "remote"), "", "the clone has no remote")
        self.assertEqual(git("-C", wt, "rev-parse", "HEAD"), git("-C", self.repo, "rev-parse", "main"))
        self.assertNotIn(os.path.realpath(wt), git("-C", self.repo, "worktree", "list"))
        self.assertFalse(os.path.exists(os.path.join(self.repo, "agy-scratch.txt")))
        self.critique_ok("--model", "gemini-4-neon-high")
        second = self.codex_calls(self.agy)[1]
        self.assertEqual(second.argv, first.argv, "a fresh turn: no --conversation")
        with open(os.path.join(self.agy.dir, "calls.jsonl"), encoding="utf-8") as f:
            pres = [json.loads(line)["pre"] for line in f if line.strip()]
        self.assertEqual(pres, [False, False], "the critique runs in the clone restored to the base, the plan's write gone")
        self.assertEqual(os.path.realpath(second.cwd), os.path.realpath(wt))
        self.assert_critique_brief(json.loads(second.stdin)["message"]["content"])
        with open(os.path.join(self.dir, "critic.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"model": "gemini-4-neon-high", "effort": ""}, "the slug carries the effort")
        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(os.path.exists(wt), "clean removes the clone")
        self.assertTrue(os.path.exists(os.path.join(self.dir, "peer-plan.md")), "and keeps the record")

    def test_a_gemini_planners_clone_is_restored_for_any_critic_and_only_when_it_is_this_plans(self) -> None:
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main",
                          "--model", "gemini-4-neon-high")
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")
        wt = os.path.join(self.dir, "worktree")
        self.assertTrue(os.path.exists(os.path.join(wt, "agy-scratch.txt")), "the planner wrote in its clone")
        mark = os.path.join(wt, ".git", "ludics-clone")
        os.rename(mark, mark + ".kept")
        done = self.entry("critique", self.dir, "--plan", self.reconciled())
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("a clone this plan directory did not make", done.stderr)
        self.assertTrue(os.path.exists(os.path.join(wt, "agy-scratch.txt")), "a refused critique restores nothing")
        os.rename(mark + ".kept", mark)
        self.critique_ok()
        critic, = self.codex_calls()
        self.assertEqual(os.path.realpath(critic.cwd), os.path.realpath(wt))
        with open(os.path.join(self.codex.dir, "calls.jsonl"), encoding="utf-8") as f:
            self.assertFalse(json.loads(f.readline())["pre"], "the codex critic reads the clone restored to the base")

    def test_clean_keeps_a_clone_without_this_plans_mark(self) -> None:
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main",
                          "--model", "gemini-4-neon-high")
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")
        wt = os.path.join(self.dir, "worktree")
        os.remove(os.path.join(wt, ".git", "ludics-clone"))
        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("is a clone this plan directory did not make; it is kept", done.stdout + done.stderr)
        self.assertTrue(os.path.isdir(wt))

    def test_a_gemini_planner_error_result_is_no_plan(self) -> None:
        os.environ["FAKE_AGY_MODE"] = "error"
        self.addCleanup(os.environ.pop, "FAKE_AGY_MODE", None)
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main",
                          "--model", "gemini-4-neon-high")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=1")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "peer-plan.md")))

    def test_an_opus_planner_error_result_is_no_plan(self) -> None:
        os.environ["FAKE_CLAUDE_MODE"] = "error"
        self.addCleanup(os.environ.pop, "FAKE_CLAUDE_MODE", None)
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main", "--model", "opus")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=1")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "peer-plan.md")), "an error result is never written as a plan")

    def test_managed_runs_start_in_the_callers_session(self) -> None:
        self.paired_board("paired+critique")
        run = self.start_on_board("t7", "--model", "gpt-6.2-sol", "--effort", "medium", "--managed")
        self.assertFalse(os.path.exists(os.path.join(self.codex.dir, "calls.jsonl")), "nothing started")
        self.assertNotIn("planner", self.board_fields()["t7"])
        with open(os.path.join(self.dir, "plan-run"), encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), run)
        # The coordinator's own foreground start, as a managed command session holds it.
        subprocess.run([BG_RUN, "start", run, "--", ENTRY, "_run", "plan", self.dir], check=True)
        self.assertEqual(self.wait(run), "rc=0")
        fields = self.board_fields()["t7"]
        self.assertEqual((fields["planner"], fields["planner_effort"]), ("gpt-6.2-sol", "medium"))
        first = self.codex_calls()[0]
        self.assertIn("gpt-6.2-sol", first.argv)
        self.assertIn("model_reasoning_effort=medium", first.argv)
        done = self.entry("critique", self.dir, "--plan", self.reconciled(), "--managed")
        self.assertEqual(done.returncode, 0, done.stderr)
        run = done.stdout.strip()
        self.assertEqual(len(self.codex_calls()), 1, "nothing started")
        subprocess.run([BG_RUN, "start", run, "--", ENTRY, "_run", "critique", self.dir], check=True)
        self.assertEqual(self.wait(run), "rc=0")
        second = self.codex_calls()[1]
        self.assertEqual(second.argv[:4], ["exec", "--json", "-m", "gpt-6.2-astra"])
        # The plans are data to the critique, as the issue was to the plan.
        self.assert_critique_brief(second.stdin)

    def test_a_plan_from_elsewhere_is_copied_to_the_record(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        mine = os.path.join(self.tmp, "elsewhere.md")
        with open(mine, "w", encoding="utf-8") as f:
            f.write("from elsewhere\n")
        done = self.entry("critique", self.dir, "--plan", mine)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")
        with open(os.path.join(self.dir, "reconciled-plan.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "from elsewhere\n")

    def test_a_failed_critique_launch_can_be_retried(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        mine = os.path.join(self.dir, "claude-plan.md")
        with open(mine, "w", encoding="utf-8") as f:
            f.write("my plan\n")
        # A file where the runs directory was: bg-run.sh new cannot allocate in it, root or not.
        runs = os.path.join(self.dir, "runs")
        os.rename(runs, runs + ".kept")
        with open(runs, "w", encoding="utf-8") as f:
            f.write("")
        try:
            done = self.entry("critique", self.dir, "--plan", mine)
        finally:
            os.remove(runs)
            os.rename(runs + ".kept", runs)
        self.assertEqual(done.returncode, 1)
        self.assertIn("bg-run.sh spawn failed", done.stderr)
        done = self.entry("critique", self.dir, "--plan", mine)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")

    def test_bg_run_stop_ends_codex_too(self) -> None:
        os.environ["FAKE_CODEX_MODE"] = "hang"
        run = self.start()
        pidfile = os.path.join(self.codex.dir, "pid")
        for _ in range(100):
            if os.path.exists(pidfile) and os.path.getsize(pidfile) > 0:
                break
            time.sleep(0.1)
        with open(pidfile, encoding="utf-8") as f:
            pid = int(f.read())
        stop = subprocess.run([BG_RUN, "stop", run], capture_output=True, text=True, check=False)
        self.assertEqual(stop.returncode, 0, stop.stderr)
        self.assertTrue(self.wait(run).startswith("STOPPED"))
        for _ in range(100):
            if not running(pid):
                break
            time.sleep(0.1)
        else:
            os.kill(pid, 9)
            self.fail("codex outlived bg-run.sh stop")
        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_failed_start_leaves_nothing_behind(self) -> None:
        real = shutil.which("git")
        assert real is not None
        fake = FakeTool("git")
        # The real git, but for one injected failure.
        fake.route((When(has=("worktree", "add")), Answer(rc=128, stderr="fatal: injected worktree add failure\n")),
                   through=real)
        with fake:
            done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 1)
        self.assertIn("injected worktree add failure", done.stderr)
        self.assertFalse(os.path.exists(self.dir))
        # So the same path takes a fresh start.
        self.assertEqual(self.wait(self.start()), "rc=0")

    def test_clean_refuses_a_live_run_and_passes_a_failed_launch(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        # Runs under <dir>/runs that no marker names, as an interrupted spawn leaves them.
        parent = os.path.join(self.dir, "runs")
        live = subprocess.run([BG_RUN, "spawn", parent, "--", "sleep", "30"], capture_output=True, text=True, check=True)
        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 1)
        self.assertIn("still live", done.stderr)
        subprocess.run([BG_RUN, "stop", live.stdout.strip()], capture_output=True, check=False)
        # A run whose start publishes its pid only after clean's first look: STARTING, then live.
        late = subprocess.run([BG_RUN, "new", parent], capture_output=True, text=True, check=True).stdout.strip()
        starter = subprocess.Popen(
            ["sh", "-c", 'sleep 3; exec "$0" start "$1" -- sleep 30', BG_RUN, late],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            done = self.entry("clean", self.dir)
            self.assertEqual(done.returncode, 1, done.stdout)
            self.assertIn("still live", done.stderr)
        finally:
            # The start and its command, which outlives a killed start.
            os.killpg(starter.pid, signal.SIGKILL)
            starter.wait()
        self.assertTrue(self.wait(late).startswith("DIED"))
        # A run directory no start ever claimed: STARTING past the grace, a launch that failed.
        subprocess.run([BG_RUN, "new", parent], capture_output=True, text=True, check=True)
        os.environ["BG_RUN_START_GRACE"] = "2"
        self.addCleanup(os.environ.pop, "BG_RUN_START_GRACE", None)
        began = time.monotonic()
        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertGreater(time.monotonic() - began, 2)

    def test_start_refuses_without_a_gh_account(self) -> None:
        self.answer_gh(login="not a login")
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 1)
        self.assertIn("gh account", done.stderr)
        self.assertFalse(os.path.exists(self.dir))

    def test_clean_refuses_when_the_run_cannot_be_read(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        os.environ["BG_RUN_POLL"] = "x"  # every wait then exits 2, with no verdict
        self.addCleanup(os.environ.pop, "BG_RUN_POLL", None)
        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 1)
        self.assertIn("cannot read the run", done.stderr)
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "worktree")))

    def test_start_refuses_a_used_directory(self) -> None:
        os.makedirs(self.dir)
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 1)
        self.assertIn("fresh directory", done.stderr)

    def test_start_refuses_an_unknown_base(self) -> None:
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "nope")
        self.assertEqual(done.returncode, 1)
        self.assertIn("is not a commit", done.stderr)
        self.assertFalse(os.path.exists(self.dir))

    def test_start_refuses_an_unreadable_issue(self) -> None:
        self.answer_gh(issue=Answer(rc=1, stderr="HTTP 404\n"))
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 1)
        self.assertIn("HTTP 404", done.stderr)

    def test_a_failed_plan_is_the_runs_verdict_and_the_critic_reads_the_reconciled_plan_alone(self) -> None:
        """PEER_PLAN_UNAVAILABLE still gets a critique: the run has ended, and the brief says so."""
        os.environ["FAKE_CODEX_MODE"] = "fail"
        self.assertEqual(self.wait(self.start()), "rc=5")
        del os.environ["FAKE_CODEX_MODE"]
        self.critique_ok()
        critic = self.codex_calls()[1]
        self.assertIn("## The second plan\n\nUnavailable: the second planner's run gave the implementer no plan (rc=5", critic.stdin)
        self.assertIn("my reconciled plan", critic.stdin)

    def test_a_stopped_planners_partial_file_is_not_given_to_the_critic(self) -> None:
        """The worker got PEER_PLAN_UNAVAILABLE for a stopped run: the critic must not read the file it left."""
        os.environ["FAKE_CODEX_MODE"] = "write-then-hang"
        self.addCleanup(os.environ.pop, "FAKE_CODEX_MODE", None)
        run = self.start()
        pidfile = os.path.join(self.codex.dir, "pid")
        for _ in range(100):
            if os.path.exists(pidfile):
                break
            time.sleep(0.1)
        subprocess.run([BG_RUN, "stop", run], capture_output=True, check=False)
        self.assertEqual(self.wait(run), "STOPPED")
        self.assertTrue(os.path.exists(os.path.join(self.dir, "peer-plan.md")), "the stopped planner left a file")
        del os.environ["FAKE_CODEX_MODE"]
        self.critique_ok()
        critic = self.codex_calls()[1]
        self.assertIn("## The second plan\n\nUnavailable: the second planner's run gave the implementer no plan (STOPPED",
                      critic.stdin)
        self.assertNotIn("```markdown\nplan\n```", critic.stdin)

    def test_a_live_planning_run_holds_the_critique_even_once_its_plan_file_exists(self) -> None:
        for mode in ("hang", "write-then-hang"):
            with self.subTest(mode=mode):
                self.dir = os.path.join(self.tmp, f"plans-{mode}", "w-7")
                os.environ["FAKE_CODEX_MODE"] = mode
                self.addCleanup(os.environ.pop, "FAKE_CODEX_MODE", None)
                pidfile = os.path.join(self.codex.dir, "pid")
                if os.path.exists(pidfile):
                    os.remove(pidfile)
                run = self.start()
                for _ in range(100):
                    if os.path.exists(pidfile):
                        break
                    time.sleep(0.1)
                self.assertEqual(os.path.exists(os.path.join(self.dir, "peer-plan.md")), mode == "write-then-hang")
                done = self.entry("critique", self.dir, "--plan", self.reconciled(), "--managed")
                subprocess.run([BG_RUN, "stop", run], capture_output=True, check=False)
                self.assertEqual(done.returncode, 1, done.stdout)
                self.assertIn("is still live", done.stderr)
                self.assertFalse(os.path.lexists(os.path.join(self.dir, "critique-brief.md")))

    def test_an_empty_plan_fails_the_run(self) -> None:
        os.environ["FAKE_CODEX_MODE"] = "silent"
        self.assertEqual(self.wait(self.start()), "rc=1")

    def test_usage(self) -> None:
        self.assertEqual(self.entry("start", self.dir).returncode, 2)
        self.assertEqual(self.entry("frobnicate", self.dir).returncode, 2)
        self.assertEqual(self.entry("start", self.dir, "--issue", "bad", "--checkout", ".", "--base", "x").returncode, 2)


def assistant(*blocks: dict[str, object], mid: str = "msg_1", **extra: object) -> dict[str, object]:
    """One transcript line of an assistant message, in Claude Code's shape: one content block."""
    message: dict[str, object] = {"id": mid, "type": "message", "role": "assistant", "content": list(blocks)}
    return {"type": "assistant", "isSidechain": True, "message": message, **extra}


def text(body: str) -> dict[str, object]:
    return {"type": "text", "text": body}


def user(content: object) -> dict[str, object]:
    return {"type": "user", "isSidechain": True, "message": {"role": "user", "content": content}}


def tool_result(body: str) -> dict[str, object]:
    return user([{"type": "tool_result", "tool_use_id": "toolu_1", "content": body}])


BRIEF = user("End your turn with the plan:\nPLAN_READY\n<the plan, Markdown>\nEND_PLAN_READY\n")


class SavePlan(unittest.TestCase):
    """``save-plan``: the worker's last PLAN_READY block, from its transcript, to claude-plan.md."""

    def setUp(self) -> None:
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="ludics-peerplan."))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.dir = os.path.join(self.tmp, "plans", "w-7")
        os.makedirs(self.dir)
        meta = {k: "x" for k in ("issue", "checkout", "base", "worktree", "model", "effort")}
        with open(os.path.join(self.dir, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f)
        self.record = os.path.join(self.dir, "claude-plan.md")
        self.transcript = os.path.join(self.tmp, "agent-a1.jsonl")

    def save(self, *records: dict[str, object], raw: str = "") -> subprocess.CompletedProcess[str]:
        with open(self.transcript, "w", encoding="utf-8") as f:
            f.write("".join(json.dumps(r) + "\n" for r in records) + raw)
        return subprocess.run(
            [ENTRY, "save-plan", self.dir, "--from-transcript", self.transcript],
            capture_output=True,
            text=True,
            check=False,
        )

    def saved(self) -> str:
        with open(self.record, encoding="utf-8") as f:
            return f.read()

    def refused(self, done: subprocess.CompletedProcess[str], why: str) -> None:
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn(why, done.stderr)
        self.assertFalse(os.path.lexists(self.record))
        self.assertEqual(sorted(os.listdir(self.dir)), ["meta.json"])

    def test_one_block_is_saved(self) -> None:
        plan = "PLAN_READY\n## Approach\n\nDo it.\n  PLAN_READY quoted, indented\nEND_PLAN_READY"
        done = self.save(BRIEF, assistant({"type": "thinking", "thinking": ""}), assistant(text(plan)))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, f"SAVED {self.record}\n")
        self.assertEqual(self.saved(), "## Approach\n\nDo it.\n  PLAN_READY quoted, indented\n")

    def test_the_output_file_symlink_is_followed(self) -> None:
        link = os.path.join(self.tmp, "a1.output")
        self.save(assistant(text("PLAN_READY\nlinked\nEND_PLAN_READY")))
        os.symlink(self.transcript, link)
        done = subprocess.run([ENTRY, "save-plan", self.dir, "--from-transcript", link], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.saved(), "linked\n")

    def test_the_last_message_with_a_block_wins(self) -> None:
        done = self.save(
            assistant(text("PLAN_READY\nfirst\nEND_PLAN_READY"), mid="msg_1"),
            user("PEER_PLAN /p/peer-plan.md"),
            assistant(text("PLAN_READY\nsecond\nEND_PLAN_READY\n\nPLAN_READY\nthird\nEND_PLAN_READY"), mid="msg_2"),
            assistant(text("Reconciled; posting the comment."), mid="msg_3"),
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.saved(), "third\n")

    def test_a_save_replaces_an_earlier_one(self) -> None:
        with open(self.record, "w", encoding="utf-8") as f:
            f.write("old\n")
        self.assertEqual(self.save(assistant(text("PLAN_READY\nnew\nEND_PLAN_READY"))).returncode, 0)
        self.assertEqual(self.saved(), "new\n")
        self.assertEqual(sorted(os.listdir(self.dir)), ["claude-plan.from", "claude-plan.md", "meta.json"])

    def test_no_block_is_refused(self) -> None:
        self.refused(self.save(BRIEF, assistant(text("I have a question first."))), "no PLAN_READY block")

    def test_an_unterminated_block_is_refused(self) -> None:
        done = self.save(
            assistant(text("PLAN_READY\nearlier\nEND_PLAN_READY"), mid="msg_1"),
            assistant(text("PLAN_READY\n## Approach\ncut off here"), mid="msg_2"),
        )
        self.refused(done, "unterminated")

    def test_a_malformed_last_block_is_refused(self) -> None:
        self.refused(self.save(assistant(text("PLAN_READY\na\nPLAN_READY\nb\nEND_PLAN_READY"))), "opens again")
        self.refused(self.save(assistant(text("done\nEND_PLAN_READY"))), "no PLAN_READY before it")
        self.refused(self.save(assistant(text("PLAN_READY\n\n  \nEND_PLAN_READY"))), "is empty")

    def test_blocks_outside_the_workers_text_are_not_taken(self) -> None:
        quoted = "PLAN_READY\nquoted\nEND_PLAN_READY"
        others: list[dict[str, object]] = [
            BRIEF,
            tool_result(quoted),
            user([{"type": "tool_result", "tool_use_id": "t", "content": [text(quoted)]}]),
            {"type": "api-request-blob", "message": {"role": "user", "content": [text(quoted)]}},
            {"type": "attachment", "attachment": {"type": "environment"}, "rendered": quoted},
            assistant({"type": "thinking", "thinking": quoted}),
            assistant({"type": "tool_use", "id": "t", "name": "Write", "input": {"content": quoted}}),
            assistant(text(quoted), isApiErrorMessage=True),
            {"type": "assistant", "message": {"role": "assistant", "content": quoted}},
        ]
        self.refused(self.save(*others), "no PLAN_READY block")
        done = self.save(assistant(text("PLAN_READY\nmine\nEND_PLAN_READY")), *others)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.saved(), "mine\n")

    def test_a_file_that_is_not_a_transcript_is_refused(self) -> None:
        self.refused(self.save(raw="PLAN_READY\nplain text\nEND_PLAN_READY\n"), "line 1 is not JSON")
        block = assistant(text("PLAN_READY\nmine\nEND_PLAN_READY"))
        self.refused(self.save(block, raw='{"type": "assistant", "mess'), "line 2 is not JSON")
        self.refused(self.save(block, raw="[1]\n"), "line 2 is not a JSON object")

    def test_refusals_of_the_directory_and_the_file(self) -> None:
        missing = subprocess.run(
            [ENTRY, "save-plan", self.dir, "--from-transcript", os.path.join(self.tmp, "nope")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.refused(missing, "cannot read the transcript")
        block = assistant(text("PLAN_READY\nmine\nEND_PLAN_READY"))
        with open(self.transcript, "wb") as f:
            f.write(b"\xff\n")
        bad = subprocess.run([ENTRY, "save-plan", self.dir, "--from-transcript", self.transcript], capture_output=True, text=True, check=False)
        self.refused(bad, "cannot read the transcript")
        open(os.path.join(self.dir, "critique-brief.md"), "w", encoding="utf-8").close()
        done = self.save(block)
        self.assertEqual(done.returncode, 1)
        self.assertIn("already has a critique", done.stderr)
        self.assertFalse(os.path.lexists(self.record))
        os.remove(os.path.join(self.dir, "meta.json"))
        self.assertIn("is not a plan directory", self.save(block).stderr)

    def test_the_reconciled_plan_has_its_own_record_from_a_later_block(self) -> None:
        """``--reconciled``: the worker's next PLAN_READY block, once resumed with the peer plan, and
        never the first plan's block again."""
        def reconciled(path: str | None = None) -> subprocess.CompletedProcess[str]:
            return subprocess.run([ENTRY, "save-plan", self.dir, "--from-transcript", path or self.transcript, "--reconciled"],
                                  capture_output=True, text=True, check=False)
        first = assistant(text("PLAN_READY\nfirst\nEND_PLAN_READY"), mid="msg_1")
        self.save(first)
        os.remove(self.record)
        os.remove(os.path.join(self.dir, "claude-plan.from"))
        self.refused(reconciled(), "save the worker's first PLAN_READY block before its reconciled one")
        self.assertEqual(self.save(first).returncode, 0)
        done = reconciled()
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("has not handed back its reconciled plan yet", done.stderr)
        target = os.path.join(self.dir, "reconciled-plan.md")
        self.assertFalse(os.path.lexists(target))
        # The worker resumed and handed back its reconciled plan: the same transcript, grown.
        with open(self.transcript, "a", encoding="utf-8") as f:
            f.write(json.dumps(user("PEER_PLAN /p/peer-plan.md")) + "\n")
            f.write(json.dumps(assistant(text("PLAN_READY\nreconciled\nEND_PLAN_READY"), mid="msg_2")) + "\n")
        other = os.path.join(self.tmp, "other.jsonl")
        shutil.copyfile(self.transcript, other)
        self.assertIn("is not the transcript the first plan came from", reconciled(other).stderr)
        done = reconciled()
        self.assertEqual((done.returncode, done.stdout), (0, f"SAVED {target}\n"), done.stderr)
        with open(target, encoding="utf-8") as f:
            self.assertEqual(f.read(), "reconciled\n")
        self.assertEqual(self.saved(), "first\n", "the first plan's record stays as it was")
        open(os.path.join(self.dir, "critique-brief.md"), "w", encoding="utf-8").close()
        self.assertIn("already has a critique", reconciled().stderr)

    def test_usage(self) -> None:
        self.assertEqual(subprocess.run([ENTRY, "save-plan", self.dir], capture_output=True, check=False).returncode, 2)
        done = subprocess.run([ENTRY, "save-plan", self.dir, "--plan", "x"], capture_output=True, check=False)
        self.assertEqual(done.returncode, 2)


if __name__ == "__main__":
    unittest.main()
