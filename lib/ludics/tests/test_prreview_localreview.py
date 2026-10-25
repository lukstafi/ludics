"""``local-review`` (lib/ludics/prreview/localreview.py), driven through a fake ``codex`` binary.

Each case builds a scratch checkout whose ``refs/remotes/origin/main`` is set by hand (nothing is
fetched, as the verb fetches nothing). The refusals pin that nothing was launched: the fake's call
log stays empty. The last class runs the production path, pr-review.sh's main exec'ing the Python.
"""

import io
import os
import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Callable
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from ludics import cli, proc
from ludics.prreview import localreview
from ludics.tests.fake import Answer, FakeTool

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")
VERDICT_TEXT = "1. [P2] a finding\n"


def git(cwd: str, *args: str) -> str:
    done = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
         "-C", cwd, *args],
        capture_output=True, text=True, check=True,
    )
    return done.stdout.strip()


def invoke(fn: Callable[[], int]) -> tuple[int, str, str]:
    """Run a command as main_guard would: (status, stdout, stderr)."""
    out, errs = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(errs):
        try:
            rc = fn()
        except cli.Exit as end:
            rc = end.rc
            if end.message:
                errs.write(f"pr-review.sh: {end.message}\n")
    return rc, out.getvalue(), errs.getvalue()


class Checkout(unittest.TestCase):
    """A checkout with one base commit (origin/main) and one branch commit on top (no cases)."""

    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-localreview-test."))
        self.work = os.path.join(self.dir, "work")
        self.out = os.path.join(self.dir, "out")
        os.makedirs(self.work)
        git(self.work, "init", "-q", "-b", "main")
        self.commit("a.txt", "base\n")
        self.base = git(self.work, "rev-parse", "HEAD")
        git(self.work, "update-ref", "refs/remotes/origin/main", self.base)
        git(self.work, "checkout", "-q", "-b", "topic")
        self.commit("a.txt", "change\n")
        self.head = git(self.work, "rev-parse", "HEAD")

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def commit(self, name: str, text: str) -> None:
        with open(os.path.join(self.work, name), "w", encoding="utf-8") as f:
            f.write(text)
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", f"edit {name}")

    def review(self, *args: str) -> tuple[int, str, str]:
        return invoke(lambda: localreview.run(["main", "-C", self.work, "--out", self.out, *args]))

    def verdict_answer(self, rc: int = 0, text: str = VERDICT_TEXT) -> Answer:
        return Answer(rc, "transcript out\n", "transcript err\n", file_flag="-o", file_text=text)


class Refusals(Checkout):
    """Each refusal exits 2, says so, and starts no codex."""

    def assert_refused(self, done: tuple[int, str, str], codex: FakeTool, says: str) -> None:
        rc, _, errs = done
        self.assertEqual(rc, 2, errs)
        self.assertIn(says, errs)
        self.assertIn("Nothing launched.", errs)
        self.assertEqual(codex.calls(), [])

    def test_no_merge_base_is_refused(self) -> None:
        git(self.work, "checkout", "-q", "--orphan", "other")
        self.commit("b.txt", "unrelated\n")
        git(self.work, "update-ref", "refs/remotes/origin/main", git(self.work, "rev-parse", "HEAD"))
        git(self.work, "checkout", "-q", "topic")
        with FakeTool("codex") as codex:
            codex.script(self.verdict_answer())
            self.assert_refused(self.review(), codex, "have no merge base")
        self.assertFalse(os.path.exists(os.path.join(self.out, localreview.LOG)))

    def test_a_base_with_no_remote_tracking_ref_is_refused(self) -> None:
        with FakeTool("codex") as codex:
            done = invoke(lambda: localreview.run(["nope", "-C", self.work, "--out", self.out]))
            self.assert_refused(done, codex, "origin/nope is not a commit")
            self.assertIn("git fetch origin nope", done[2])

    def test_head_at_the_merge_base_is_refused(self) -> None:
        git(self.work, "update-ref", "refs/remotes/origin/main", self.head)
        with FakeTool("codex") as codex:
            self.assert_refused(self.review(), codex, "nothing to review")

    def test_an_uncommitted_tracked_change_is_refused(self) -> None:
        with open(os.path.join(self.work, "a.txt"), "w", encoding="utf-8") as f:
            f.write("dirty\n")
        with FakeTool("codex") as codex:
            self.assert_refused(self.review(), codex, "uncommitted changes")

    def test_an_untracked_file_is_not_read(self) -> None:
        with open(os.path.join(self.work, "scratch.txt"), "w", encoding="utf-8") as f:
            f.write("untracked\n")
        with FakeTool("codex") as codex:
            codex.script(self.verdict_answer())
            self.assertEqual(self.review()[0], 0)

    def test_usage(self) -> None:
        with FakeTool("codex") as codex:
            for args in ([], ["main", "extra"], ["main", "--out"], ["--bogus", "main"]):
                with self.subTest(args=args):
                    done = invoke(lambda: localreview.run([*args, "-C", self.work]))
                    self.assert_refused(done, codex, "local-review")

    def test_not_a_checkout(self) -> None:
        with FakeTool("codex") as codex:
            done = invoke(lambda: localreview.run(["main", "-C", self.out]))
            self.assert_refused(done, codex, "not a directory inside a git checkout")

    def test_codex_missing_is_127(self) -> None:
        real = proc.command_argv

        def without_codex(name: str, env: object = None) -> list[str] | None:
            return None if name == "codex" else real(name)

        with mock.patch.object(proc, "command_argv", without_codex):
            rc, _, errs = self.review()
        self.assertEqual(rc, 127)
        self.assertIn("codex is not on PATH", errs)
        self.assertIn("Nothing launched.", errs)


class Launch(Checkout):
    def test_the_prompt_names_the_merge_base_and_forbids_tests(self) -> None:
        with FakeTool("codex") as codex:
            codex.script(self.verdict_answer())
            rc, out, errs = self.review()
            calls = codex.calls()
        self.assertEqual(rc, 0, errs)
        verdict = os.path.join(self.out, localreview.VERDICT)
        log = os.path.join(self.out, localreview.LOG)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:4], ["exec", "review", "-o", verdict])
        self.assertEqual(len(calls[0]), 5)
        prompt = calls[0][4]
        self.assertEqual(prompt, localreview.prompt_text("origin/main", self.base, self.head))
        self.assertIn(localreview.NO_TESTS, prompt)
        self.assertIn(f"git diff {self.base} {self.head}", prompt)
        self.assertNotIn("--base", calls[0])
        with open(verdict, encoding="utf-8") as f:
            self.assertEqual(f.read(), VERDICT_TEXT)
        with open(log, encoding="utf-8") as f:
            transcript = f.read()
        self.assertIn("transcript out", transcript)
        self.assertIn("transcript err", transcript)
        self.assertIn(f"verdict {verdict}, transcript {log}", out)
        self.assertIn("1 commit(s)", out)

    def test_origin_prefix_is_dropped_once(self) -> None:
        with FakeTool("codex") as codex:
            codex.script(self.verdict_answer())
            done = invoke(lambda: localreview.run(["origin/main", "-C", self.work, "--out", self.out]))
            self.assertEqual(done[0], 0, done[2])
            self.assertIn("against the base branch origin/main,", codex.calls()[0][4])

    def test_a_nonzero_codex_exit_is_propagated(self) -> None:
        with FakeTool("codex") as codex:
            codex.script(self.verdict_answer(rc=7, text=""))
            rc, _, errs = self.review()
        self.assertEqual(rc, 7)
        self.assertIn("codex exited 7", errs)
        self.assertIn(os.path.join(self.out, localreview.LOG), errs)

    def test_no_verdict_is_a_failure(self) -> None:
        with FakeTool("codex") as codex:
            codex.script(Answer(0, "ran\n"))
            rc, _, errs = self.review()
        self.assertEqual(rc, 1)
        self.assertIn("wrote no verdict", errs)

    def test_an_earlier_verdict_does_not_survive_a_run(self) -> None:
        os.makedirs(self.out)
        with open(os.path.join(self.out, localreview.VERDICT), "w", encoding="utf-8") as f:
            f.write("stale verdict\n")
        with FakeTool("codex") as codex:
            codex.script(Answer(0, "ran\n"))
            self.assertEqual(self.review()[0], 1)
        self.assertFalse(os.path.exists(os.path.join(self.out, localreview.VERDICT)))

    def test_without_out_a_fresh_directory(self) -> None:
        with FakeTool("codex") as codex:
            codex.script(self.verdict_answer())
            rc, out, errs = invoke(lambda: localreview.run(["main", "-C", self.work]))
            verdict = codex.calls()[0][3]
        try:
            self.assertEqual(rc, 0, errs)
            self.assertEqual(os.path.basename(verdict), localreview.VERDICT)
            self.assertTrue(os.path.basename(os.path.dirname(verdict)).startswith("local-review."))
            self.assertIn(f"verdict {verdict}", out)
        finally:
            shutil.rmtree(os.path.dirname(verdict), ignore_errors=True)


class ProductionPath(Checkout):
    """pr-review.sh's main exec's the Python, with codex the binary on PATH."""

    def test_the_shim_runs_the_verb(self) -> None:
        for rc in (0, 3):
            with self.subTest(rc=rc), FakeTool("codex") as codex:
                codex.script(self.verdict_answer(rc=rc))
                done = subprocess.run(
                    [PR_REVIEW, "local-review", "main", "--out", self.out], capture_output=True, text=True,
                    cwd=self.work, check=False,
                )
                self.assertEqual(done.returncode, rc, done.stderr)
                calls = codex.calls()
                self.assertEqual(len(calls), 1)
                self.assertIn(localreview.NO_TESTS, calls[0][4])


if __name__ == "__main__":
    unittest.main()
