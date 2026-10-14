"""``pr-review.sh body``, end to end: through ``scripts/py -m ludics.prreview`` and through the shell
script's own ``main``, which execs the Python, with a fake gh BINARY on PATH.

The fixture suite (ship-pr/scripts/test-pr-review-reply.sh) pins the command's behaviour through
the sourced function and the shell bridge; these pin the production path, where no function
exists and gh is whatever is on PATH.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

from ludics.tests.fake import Answer, FakeTool

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PY = os.path.join(ROOT, "scripts", "py")
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")


class Body(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-body-test."))
        self.file = os.path.join(self.dir, "body.md")
        with open(self.file, "w", encoding="utf-8") as f:
            f.write("## Summary\n\n`ticks`, $dollars — and UTF-8.\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_cmd(self, entry: list[str], *args: str, repo: str = "") -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        env.update({"REPO": repo, "SHIP_PR_API_ATTEMPTS": "2", "SHIP_PR_API_BACKOFF": "0",
                    "SHIP_PR_STATE_DIR": os.path.join(self.dir, "state")})
        return subprocess.run(
            [*entry, "body", *args], capture_output=True, text=True, env=env, cwd=self.dir,
            check=False,
        )

    def entries(self) -> list[list[str]]:
        return [[PY, "-m", "ludics.prreview"], [PR_REVIEW]]

    def test_the_pr_is_patched_from_the_file_and_its_url_is_stdout(self) -> None:
        for entry in self.entries():
            with self.subTest(entry=entry[0]), FakeTool("gh") as gh:
                gh.script(Answer(0, "https://github.com/o/r/pull/7\n"))
                done = self.run_cmd(entry, "o/r#7", self.file)
                self.assertEqual((done.returncode, done.stdout, done.stderr),
                                 (0, "https://github.com/o/r/pull/7\n", ""))
                self.assertEqual(
                    gh.calls(),
                    [["api", "-X", "PATCH", "repos/o/r/pulls/7", "-F", f"body=@{self.file}",
                      "--jq", ".html_url"]],
                )

    def test_the_exits_stay_apart(self) -> None:
        cases = (
            (Answer(1, "", "gh: Not Found (HTTP 404)\n"), 1, "was REJECTED, not dropped", 1),
            (Answer(1, "", "gh: HTTP 503: Service Unavailable\n"), 3, "Nothing was changed, so retry", 2),
            # Ambiguous: repeated, since the PATCH sets the body whole, and still 3 once spent.
            (Answer(1, "", "gh: Internal Server Error (HTTP 500)\n"), 3, "repeating the same command is safe", 2),
            (Answer(1, "", "unexpected end of JSON input\n"), 3, "GitHub sent no readable answer", 2),
        )
        for entry in self.entries():
            for answer, rc, says, calls in cases:
                with self.subTest(entry=entry[0], rc=rc, says=says), FakeTool("gh") as gh:
                    gh.script(answer)
                    done = self.run_cmd(entry, "o/r#7", self.file)
                    self.assertEqual(done.returncode, rc, done.stderr)
                    self.assertIn(says, done.stderr)
                    self.assertEqual(done.stdout, "")
                    self.assertEqual(len(gh.calls()), calls)

    def test_an_unreadable_answer_is_repeated_until_one_lands(self) -> None:
        # The wave of 2026-10-14: GitHub answered the PATCH with no readable body, gh printed only
        # its decoder's complaint, and the edit had not landed. The repeat is what lands it.
        for entry in self.entries():
            with self.subTest(entry=entry[0]), FakeTool("gh") as gh:
                gh.script(Answer(1, "", "unexpected end of JSON input\n"),
                          Answer(0, "https://github.com/o/r/pull/7\n"))
                done = self.run_cmd(entry, "o/r#7", self.file)
                self.assertEqual((done.returncode, done.stdout), (0, "https://github.com/o/r/pull/7\n"))
                self.assertIn("retrying", done.stderr)
                self.assertEqual(len(gh.calls()), 2)

    def test_a_rejection_after_an_unclear_attempt_stays_ambiguous(self) -> None:
        # The first PATCH may have landed; the 403 answers only the second.
        for entry in self.entries():
            with self.subTest(entry=entry[0]), FakeTool("gh") as gh:
                gh.script(Answer(1, "", "unexpected end of JSON input\n"),
                          Answer(1, "", "gh: Resource not accessible by integration (HTTP 403)\n"))
                done = self.run_cmd(entry, "o/r#7", self.file)
                self.assertEqual(done.returncode, 3, done.stderr)
                self.assertIn("may or may not have landed", done.stderr)
                self.assertNotIn("REJECTED", done.stderr)
                self.assertEqual(len(gh.calls()), 2)

    def test_invocation_errors_send_nothing(self) -> None:
        blank = os.path.join(self.dir, "blank.md")
        with open(blank, "w", encoding="utf-8") as f:
            f.write(" \n\t\n")
        cases = (
            ((), "", "got 0 argument(s)"),
            (("o/r#7", "-"), "", "stdin"),
            (("o/r#7", os.path.join(self.dir, "missing")), "", "is not a readable file"),
            (("o/r#7", blank), "", "is empty"),
            (("o/r#7", self.file, "extra"), "", "got 3 argument(s)"),
            (("7", self.file), "", "Pass it as owner/name#7"),
            (("o/r#x", self.file), "o/r", "PR must be a number or owner/name#number"),
        )
        for entry in self.entries():
            for args, repo, says in cases:
                with self.subTest(entry=entry[0], args=args), FakeTool("gh") as gh:
                    done = self.run_cmd(entry, *args, repo=repo)
                    self.assertEqual(done.returncode, 2, done.stderr)
                    self.assertIn(says, done.stderr)
                    self.assertEqual(gh.calls(), [])

    def test_the_skills_symlink_reaches_the_checkouts_python(self) -> None:
        # How the skills call it: ~/.claude/skills/ship-pr is a symlink to <checkout>/ship-pr.
        skills = os.path.join(self.dir, "skills")
        os.mkdir(skills)
        os.symlink(os.path.join(ROOT, "ship-pr"), os.path.join(skills, "ship-pr"))
        linked = os.path.join(skills, "ship-pr", "scripts", "pr-review.sh")
        with FakeTool("gh") as gh:
            gh.script(Answer(0, "https://github.com/o/r/pull/7\n"))
            done = self.run_cmd([linked], "o/r#7", self.file)
            self.assertEqual((done.returncode, done.stderr), (0, ""))
            self.assertEqual(len(gh.calls()), 1)

    def test_the_repo_comes_from_the_argument_before_the_environment(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(0, "u\n"))
            done = self.run_cmd([PR_REVIEW], "a/b#8", self.file, repo="o/r")
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(gh.calls()[0][3], "repos/a/b/pulls/8")
            done = self.run_cmd([PR_REVIEW, "--repo", "c/d"], "9", self.file)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(gh.calls()[1][3], "repos/c/d/pulls/9")


if __name__ == "__main__":
    unittest.main()
