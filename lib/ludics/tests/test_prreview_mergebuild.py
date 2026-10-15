"""Units of ``merge``'s build of the would-be merge commit (ludics-lite#611, prreview/mergebuild.py):
the config's grammar, the build-input boundary, the clone's remote, and the build itself in a real
scratch repository -- refused with its output, passed, refused on a textual conflict, superseded on
a moved head -- each leaving the clone as it was.

test-pr-review-merge.sh runs the same build end to end through `merge`; these pin the rules a
regression would bend first.
"""

import contextlib
import io
import os
import shutil
import subprocess
import tempfile
import unittest

from ludics import cli
from ludics.prreview import mergebuild
from ludics.prreview.mergebuild import BuildConfig, build_inputs, parse_config


def parsed(text: str) -> tuple[BuildConfig | None, str]:
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        result = parse_config(text, "the config")
    return result, err.getvalue()


class Grammar(unittest.TestCase):
    def test_the_three_line_shapes_comments_and_blanks(self) -> None:
        config, err = parsed("# header\n\ncommand dune build @check\ninput *.ml\n  input\t*.mli  \ntimeout 600\r\n")
        self.assertEqual(config, BuildConfig("dune build @check", ("*.ml", "*.mli"), 600))
        self.assertEqual(err, "")

    def test_the_timeout_defaults(self) -> None:
        config, _ = parsed("command make\ninput *.c\n")
        self.assertEqual(config, BuildConfig("make", ("*.c",), mergebuild.DEFAULT_TIMEOUT))

    def test_every_other_line_refuses_naming_it(self) -> None:
        for text, named in (
            ("command make\ninputs *.c\n", "inputs *.c"),
            ("command make\ninput *.c\nCommand make\n", "Command make"),
            ("command make\ninput\n", "input"),
            ("command make\ninput *.c\ntimeout 0\n", "timeout 0"),
            ("command make\ninput *.c\ntimeout 1.5\n", "timeout 1.5"),
            ("command make\ninput *.c\ntimeout ６\n", "timeout ６"),
            ("command make\ncommand cc\ninput *.c\n", "command cc"),
            ("command make\ninput *.c\ntimeout 5\ntimeout 6\n", "timeout 6"),
        ):
            with self.subTest(text=text):
                config, err = parsed(text)
                self.assertIsNone(config)
                self.assertIn(named, err)

    def test_a_command_and_an_input_are_required(self) -> None:
        for text in ("input *.c\n", "command make\n", "# nothing\n", ""):
            with self.subTest(text=text):
                config, err = parsed(text)
                self.assertIsNone(config)
                self.assertIn("needs one `command` line and at least one `input` line", err)


class Inputs(unittest.TestCase):
    def test_a_glob_matches_the_whole_path_and_star_crosses_slashes(self) -> None:
        paths = ["dune", "lib/dune", "lib/a.ml", "a.ml", "README.md", "test/x.mli", "lib/A.ML"]
        self.assertEqual(build_inputs(paths, ("*.ml",)), ["lib/a.ml", "a.ml"])
        self.assertEqual(build_inputs(paths, ("dune",)), ["dune"])
        self.assertEqual(build_inputs(paths, ("*/dune",)), ["lib/dune"])
        self.assertEqual(build_inputs(paths, ("*.ml", "*.mli")), ["lib/a.ml", "a.ml", "test/x.mli"])
        self.assertEqual(build_inputs(paths, ("lib",)), [])

    def test_a_remote_names_the_repository_by_its_last_two_components(self) -> None:
        for url in (
            "https://github.com/Owner/Repo.git",
            "git@github.com:owner/repo.git",
            "git@github-work:owner/repo",
            "/tmp/x/remotes/owner/repo.git/",
            "C:\\x\\owner\\repo.git",
        ):
            with self.subTest(url=url):
                self.assertTrue(mergebuild._remote_matches(url, "owner/repo"))  # pyright: ignore[reportPrivateUsage]
        for url in ("https://github.com/owner/repo2.git", "https://github.com/other/repo", "repo"):
            with self.subTest(url=url):
                self.assertFalse(mergebuild._remote_matches(url, "owner/repo"))  # pyright: ignore[reportPrivateUsage]


def git(cwd: str, *args: str) -> str:
    done = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, *args],
        capture_output=True, text=True, check=True,
    )
    return done.stdout.strip()


API = ["hook() { :; }", "# one", "# two", "# three", "keep() { :; }", "# four", "# five", "# six"]


class Build(unittest.TestCase):
    """``_build`` in a clone of a scratch remote whose path ends in owner/repo."""

    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-mergebuild-test."))
        self.remote = os.path.join(self.dir, "remotes", "owner", "repo.git")
        os.makedirs(self.remote)
        git(self.remote, "init", "-q", "--bare")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.work = os.path.join(self.dir, "work")
        os.makedirs(self.work)
        git(self.work, "init", "-q")
        self.write(API)
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "base")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")
        self.clone = os.path.join(self.dir, "clone")
        git(self.dir, "clone", "-q", self.remote, self.clone)
        self.cwd = os.getcwd()
        os.environ["FLEET_LOCAL_BOX"] = "not-a-fleet-box"

    def tearDown(self) -> None:
        os.chdir(self.cwd)
        os.environ.pop("FLEET_LOCAL_BOX", None)
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, lines: list[str]) -> None:
        with open(os.path.join(self.work, "api.sh"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def sides(self, pr_line: str, base_first: str) -> tuple[str, str]:
        """The PR appends ``pr_line``; the base rewrites the first line. Returns (head, tip)."""
        self.write([*API, pr_line])
        git(self.work, "commit", "-q", "-a", "-m", "pr")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/pull/7/head")
        head = git(self.work, "rev-parse", "HEAD")
        git(self.work, "checkout", "-q", "--detach", "HEAD~1")
        self.write([base_first, *API[1:]])
        git(self.work, "commit", "-q", "-a", "-m", "base")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")
        return head, git(self.work, "rev-parse", "HEAD")

    def build(self, gated: str) -> tuple[int, str]:
        os.chdir(self.clone)
        out = io.StringIO()
        rc = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            try:
                mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                    "owner/repo", "7", gated, "main", BuildConfig("sh ./api.sh", ("*.sh",), 60), "test"
                )
            except cli.Exit as exc:
                rc = exc.rc
                out.write(exc.message + "\n")
        self.assertEqual(git(self.clone, "status", "--porcelain"), "")
        self.assertEqual(git(self.clone, "worktree", "list", "--porcelain").count("worktree "), 1)
        self.assertEqual(git(self.clone, "for-each-ref", "refs/ship-pr/"), "")
        return rc, out.getvalue()

    def test_a_clash_is_refused_with_the_build_output(self) -> None:
        head, _ = self.sides("hook", "seam() { :; }")
        rc, out = self.build(head)
        self.assertEqual(rc, 1, out)
        self.assertIn("FAILED", out)
        self.assertIn("  | ", out)
        self.assertIn("hook", out)
        self.assertIn("does not build", out)

    def test_a_merge_that_builds_passes(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        rc, out = self.build(head)
        self.assertEqual(rc, 0, out)
        self.assertIn("PASSED", out)
        self.assertIn("bare (this box has no run-time slots)", out)

    def test_a_textual_conflict_is_refused(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        # A second PR head that rewrites the first line too: the merge cannot be made.
        git(self.work, "checkout", "-q", "--detach", head)
        self.write(["other() { :; }", *API[1:], "keep"])
        git(self.work, "commit", "-q", "-a", "-m", "pr2")
        git(self.work, "push", "-q", "-f", self.remote, "HEAD:refs/pull/7/head")
        rc, out = self.build(git(self.work, "rev-parse", "HEAD"))
        self.assertEqual(rc, 1, out)
        self.assertIn("does not merge cleanly", out)

    def test_a_moved_head_is_superseded(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        rc, out = self.build("0" * 40)
        self.assertEqual(rc, 5, out)
        self.assertIn(f"its head is {head[:8]}", out)

    def test_a_timeout_is_no_verdict(self) -> None:
        head, _ = self.sides("sleep 30", "seam() { :; }")
        os.chdir(self.clone)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            with self.assertRaises(cli.Exit) as caught:
                mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                    "owner/repo", "7", head, "main", BuildConfig("sh ./api.sh", ("*.sh",), 2), "test"
                )
        self.assertEqual(caught.exception.rc, 4, out.getvalue())
        self.assertIn("did not finish within", caught.exception.message)


if __name__ == "__main__":
    unittest.main()
