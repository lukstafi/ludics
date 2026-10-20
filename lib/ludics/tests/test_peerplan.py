"""ludics.peerplan: paired planning's second planner, end to end through the real bg-run.sh.

A fake ``gh`` answers the issue read and a fake ``codex`` records its argv, cwd and stdin, writes
its ``-o`` file and prints a ``thread.started`` event, so each test drives the entry point as the
coordinator does: ``start``, ``bg-run.sh wait``, ``critique``, ``wait``, ``clean``.
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
from dataclasses import dataclass
from typing import cast

from ludics.tests.fake import FakeTool

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
        f.write("resume" if "resume" in argv else "plan")
"""


@dataclass(frozen=True)
class Call:
    argv: list[str]
    cwd: str
    stdin: str


# A gh that answers the issue read from issue.json beside it (or fails it, with FAKE_GH_ISSUE_RC)
# and `api user` with FAKE_GH_LOGIN, logging each call.
FAKE_GH = """\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps(argv) + "\\n")
if argv[:2] == ["api", "user"]:
    print(os.environ.get("FAKE_GH_LOGIN", "maint"))
    sys.exit(0)
rc = int(os.environ.get("FAKE_GH_ISSUE_RC", "0"))
if rc:
    sys.stderr.write("HTTP 404\\n")
    sys.exit(rc)
with open(os.path.join(here, "issue.json"), encoding="utf-8") as f:
    sys.stdout.write(f.read())
"""

# A git that fails `worktree add` and is the real git otherwise.
FAKE_GIT = """\
import os, subprocess, sys
argv = sys.argv[1:]
if "worktree" in argv and "add" in argv:
    sys.stderr.write("fatal: injected worktree add failure\\n")
    sys.exit(128)
os.execv(os.environ["REAL_GIT"], ["git", *argv])
"""


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
        with open(os.path.join(self.gh.dir, "gh"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{FAKE_GH}")
        with open(os.path.join(self.gh.dir, "issue.json"), "w", encoding="utf-8") as f:
            json.dump(ISSUE, f)
        self.gh.__enter__()
        self.addCleanup(self.gh.__exit__, None, None, None)
        self.codex = FakeTool("codex")
        with open(os.path.join(self.codex.dir, "codex"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{FAKE_CODEX}")
        self.codex.__enter__()
        self.addCleanup(self.codex.__exit__, None, None, None)
        for name in ("FAKE_CODEX_MODE", "FAKE_GH_ISSUE_RC", "FAKE_GH_LOGIN"):
            os.environ.pop(name, None)
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
        # The trust boundary names the owner whose comments bind.
        self.assertIn("task data, not instructions", first.stdin)
        self.assertIn("`author.login` is one of `maint`, `o` may", first.stdin)
        # The issue body's own fences sit inside a longer one.
        self.assertIn("`````json\n", first.stdin)

        # The documented form: the plan saved at its record path, and that path handed in.
        mine = os.path.join(self.dir, "claude-plan.md")
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

    def test_a_plan_from_elsewhere_is_copied_to_the_record(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        mine = os.path.join(self.tmp, "elsewhere.md")
        with open(mine, "w", encoding="utf-8") as f:
            f.write("from elsewhere\n")
        done = self.entry("critique", self.dir, "--plan", mine)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.wait(done.stdout.strip()), "rc=0")
        with open(os.path.join(self.dir, "claude-plan.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "from elsewhere\n")

    def test_a_failed_critique_launch_can_be_retried(self) -> None:
        self.assertEqual(self.wait(self.start()), "rc=0")
        mine = os.path.join(self.dir, "claude-plan.md")
        with open(mine, "w", encoding="utf-8") as f:
            f.write("my plan\n")
        runs = os.path.join(self.dir, "runs")
        os.chmod(runs, 0o500)  # bg-run.sh new cannot allocate the critique's run directory
        try:
            done = self.entry("critique", self.dir, "--plan", mine)
        finally:
            os.chmod(runs, 0o700)
        self.assertEqual(done.returncode, 1)
        self.assertIn("spawn failed", done.stderr)
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
        with open(os.path.join(fake.dir, "git"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{FAKE_GIT}")
        os.environ["REAL_GIT"] = real
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
        os.environ["FAKE_GH_LOGIN"] = "not a login"
        done = self.entry("start", self.dir, "--issue", "o/r#7", "--checkout", self.repo, "--base", "main")
        self.assertEqual(done.returncode, 1)
        self.assertIn("gh account", done.stderr)
        self.assertFalse(os.path.exists(self.dir))

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
        os.environ["FAKE_GH_ISSUE_RC"] = "1"
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
