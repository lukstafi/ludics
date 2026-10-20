"""ludics.peerplan: paired planning's second planner, end to end through the real bg-run.sh.

A fake ``gh`` answers the issue read and a fake ``codex`` records its argv, cwd and stdin, writes
its ``-o`` file and prints a ``thread.started`` event, so each test drives the entry point as the
coordinator does: ``start``, ``bg-run.sh wait``, ``critique``, ``wait``, ``clean``.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass
from typing import cast

from ludics.tests.fake import Answer, FakeTool

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
ENTRY = os.path.join(ROOT, "issue-wave", "scripts", "peer-plan.sh")
BG_RUN = os.path.join(ROOT, "issue-wave", "scripts", "bg-run.sh")
ISSUE: dict[str, object] = {"number": 7, "title": "t", "body": "has a ``` fence\n````\n", "comments": []}

FAKE_CODEX = """\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "stdin": sys.stdin.read()}) + "\\n")
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
if mode == "fail":
    sys.stderr.write("model at capacity\\n")
    sys.exit(5)
print(json.dumps({"type": "thread.started", "thread_id": "tid-1"}))
if mode != "silent":
    out = argv[argv.index("-o") + 1]
    with open(out, "w", encoding="utf-8") as f:
        f.write("resume" if "resume" in argv else "plan")
"""


@dataclass(frozen=True)
class Call:
    argv: list[str]
    cwd: str
    stdin: str


def git(*args: str) -> str:
    done = subprocess.run(["git", *args], capture_output=True, text=True, check=True)
    return done.stdout.strip()


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
        self.gh.script(Answer(stdout=json.dumps(ISSUE)))
        self.gh.__enter__()
        self.addCleanup(self.gh.__exit__, None, None, None)
        self.codex = FakeTool("codex")
        with open(os.path.join(self.codex.dir, "codex"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{FAKE_CODEX}")
        self.codex.__enter__()
        self.addCleanup(self.codex.__exit__, None, None, None)
        os.environ.pop("FAKE_CODEX_MODE", None)
        self.dir = os.path.join(self.tmp, "plans", "w-7")

    def entry(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([ENTRY, *args], capture_output=True, text=True, check=False)

    def wait(self, run: str) -> str:
        done = subprocess.run([BG_RUN, "wait", run, "--within", "60"], capture_output=True, text=True, check=False)
        return done.stdout.strip()

    def codex_calls(self) -> list[Call]:
        path = os.path.join(self.codex.dir, "calls.jsonl")
        with open(path, encoding="utf-8") as f:
            rows = [cast(dict[str, object], json.loads(line)) for line in f if line.strip()]
        return [Call(cast(list[str], r["argv"]), str(r["cwd"]), str(r["stdin"])) for r in rows]

    def start(self) -> str:
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def test_plan_critique_clean(self) -> None:
        run = self.start()
        self.assertEqual(self.wait(run), "rc=0")
        wt = os.path.join(self.dir, "worktree")
        with open(os.path.join(self.dir, "astra-plan.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "plan")
        with open(os.path.join(self.dir, "thread"), encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), "tid-1")
        self.assertEqual(self.gh.calls(), [["issue", "view", "7", "--repo", "o/r", "--json", "number,title,body,comments"]])
        first = self.codex_calls()[0]
        argv = first.argv
        self.assertEqual(argv[:2], ["exec", "--json"])
        self.assertIn("read-only", argv)
        self.assertEqual(argv[argv.index("-C") + 1], wt)
        self.assertEqual(argv[-1], "-")
        self.assertIn("one of two planners", first.stdin)
        # The issue body's own fences sit inside a longer one.
        self.assertIn("`````json\n", first.stdin)

        mine = os.path.join(self.tmp, "claude-plan.md")
        with open(mine, "w", encoding="utf-8") as f:
            f.write("my plan\n")
        done = self.entry("critique", self.dir, "--plan", mine)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")
        with open(os.path.join(self.dir, "critique.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "resume")
        second = self.codex_calls()[1]
        argv = second.argv
        self.assertEqual(argv[:3], ["exec", "resume", "tid-1"])
        self.assertIn('sandbox_mode="read-only"', argv)
        self.assertEqual(os.path.realpath(second.cwd), os.path.realpath(wt))
        self.assertIn("my plan", second.stdin)

        again = self.entry("critique", self.dir, "--plan", mine)
        self.assertEqual(again.returncode, 1)
        self.assertIn("one per plan", again.stderr)

        done = self.entry("clean", self.dir)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse(os.path.exists(wt))
        self.assertNotIn(wt, git("-C", self.repo, "worktree", "list"))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "astra-plan.md")))

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
        self.gh.script(Answer(rc=1, stderr="HTTP 404\n"))
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 1)
        self.assertIn("HTTP 404", done.stderr)

    def test_a_failed_plan_is_the_runs_verdict_and_blocks_the_critique(self) -> None:
        os.environ["FAKE_CODEX_MODE"] = "fail"
        self.assertEqual(self.wait(self.start()), "rc=5")
        mine = os.path.join(self.tmp, "p.md")
        with open(mine, "w", encoding="utf-8") as f:
            f.write("x")
        done = self.entry("critique", self.dir, "--plan", mine)
        self.assertEqual(done.returncode, 1)
        self.assertIn("no plan", done.stderr)

    def test_an_empty_plan_fails_the_run(self) -> None:
        os.environ["FAKE_CODEX_MODE"] = "silent"
        self.assertEqual(self.wait(self.start()), "rc=1")

    def test_usage(self) -> None:
        self.assertEqual(self.entry("start", self.dir).returncode, 2)
        self.assertEqual(self.entry("frobnicate", self.dir).returncode, 2)
        self.assertEqual(self.entry("start", self.dir, "--issue", "bad", "--checkout", ".", "--base", "x").returncode, 2)


if __name__ == "__main__":
    unittest.main()
