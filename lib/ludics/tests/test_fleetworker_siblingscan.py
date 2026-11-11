"""siblingscan.py (#1041, #1034), its parts one at a time on real git repositories. The verb's whole
flow -- the open-PR list, each head fetched by its PR ref, CLEAN/HIT/UNCHECKED, a failed fetch
stopping the check and the exit statuses -- is pinned end to end in
issue-wave/scripts/test-fleet-worker.sh's "sibling-scan" section."""

import os
import shutil
import subprocess
import tempfile
import unittest

from ludics import cli
from ludics.fleetworker import siblingscan

ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}  # fmt: skip


def sh(cwd: str, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout.strip()


def commit(cwd: str, name: str, text: str) -> str:
    with open(os.path.join(cwd, name), "w", encoding="utf-8") as f:
        f.write(text)
    sh(cwd, "add", name)
    sh(cwd, "commit", "-qm", f"{name}: {text.strip()}")
    return sh(cwd, "rev-parse", "HEAD")


class Repo(unittest.TestCase):
    def setUp(self) -> None:
        self.top = os.path.realpath(tempfile.mkdtemp(prefix="siblingscan-test."))
        self.addCleanup(shutil.rmtree, self.top, True)
        self.repo = os.path.join(self.top, "repo")
        os.makedirs(self.repo)
        sh(self.repo, "init", "-q")
        self.base = commit(self.repo, "a.txt", "base\n")


class Arguments(unittest.TestCase):
    def refuses(self, text: str, *args: str) -> None:
        with self.assertRaises(cli.Exit) as caught:
            siblingscan.parse_args(list(args))
        self.assertEqual(caught.exception.rc, 2)
        self.assertIn(text, caught.exception.message)

    def test_the_scan_command_is_everything_after_the_double_dash(self) -> None:
        opts = siblingscan.parse_args(["o/r", "--wave", "w1", "--branch", "b", "--", "dune", "build", "--", "@x"])
        self.assertEqual((opts.repo, opts.wave, opts.branch, opts.remote), ("o/r", "w1", "b", "origin"))
        self.assertEqual(opts.command, ["dune", "build", "--", "@x"])

    def test_a_missing_command_repository_or_value_is_usage(self) -> None:
        self.refuses("the scan command goes after --", "o/r")
        self.refuses("the scan command goes after --", "o/r", "--")
        self.refuses("<owner/repo> required", "--", "true")
        self.refuses("expected value for --worktree", "o/r", "--worktree")
        self.refuses("one <owner/repo>", "o/r", "o/s", "--", "true")
        self.refuses("sibling-scan <owner/repo>", "o/r", "--force", "--", "true")


class Combining(Repo):
    def conflicting_head(self) -> tuple[str, str]:
        """A head that changed a.txt's line, and a scan revision whose base changed it too."""
        sh(self.repo, "checkout", "-q", "-b", "head")
        head = commit(self.repo, "a.txt", "head\n")
        sh(self.repo, "checkout", "-q", "-b", "scan", self.base)
        commit(self.repo, "a.txt", "main2\n")
        scan = commit(self.repo, "scan.sh", "exit 0\n")
        sh(self.repo, "checkout", "-q", "--detach", head)
        return head, scan

    def test_a_conflicting_merge_without_a_base_is_a_named_refusal_and_leaves_no_merge_behind(self) -> None:
        _, scan = self.conflicting_head()
        via, refusal = siblingscan.combine(self.repo, scan, "", ENV)
        self.assertEqual(via, "")
        self.assertIn("merge conflicts in a.txt, and no --base", refusal)
        self.assertEqual(sh(self.repo, "status", "--porcelain"), "")

    def test_with_the_base_the_scan_branch_s_own_commits_are_cherry_picked(self) -> None:
        head, scan = self.conflicting_head()
        main2 = sh(self.repo, "rev-parse", f"{scan}~1")
        via, refusal = siblingscan.combine(self.repo, scan, main2, ENV)
        self.assertEqual((via, refusal), ("cherry-pick", ""))
        self.assertEqual(sh(self.repo, "rev-parse", "HEAD~1"), head)
        self.assertEqual(sh(self.repo, "show", "HEAD:a.txt"), "head")

    def test_a_base_past_which_the_scan_branch_has_nothing_is_said(self) -> None:
        _, scan = self.conflicting_head()
        via, refusal = siblingscan.combine(self.repo, scan, scan, ENV)
        self.assertEqual(via, "")
        self.assertIn("changes nothing past --base", refusal)

    def test_the_cherry_pick_carries_a_merge_on_the_scan_branch_and_what_its_resolution_changed(self) -> None:
        head, scan = self.conflicting_head()
        main2 = sh(self.repo, "rev-parse", f"{scan}~1")
        sh(self.repo, "checkout", "-q", "-b", "side", main2)
        commit(self.repo, "other.txt", "side\n")
        sh(self.repo, "checkout", "-q", "scan")
        sh(self.repo, "merge", "-q", "--no-commit", "side")
        with open(os.path.join(self.repo, "scan.sh"), "w", encoding="utf-8") as f:
            f.write("exit 3\n")  # the scanner as the merge left it, in no non-merge commit
        sh(self.repo, "commit", "-qam", "merge side, the scanner revised")
        scan = sh(self.repo, "rev-parse", "HEAD")
        sh(self.repo, "checkout", "-q", "--detach", head)
        via, refusal = siblingscan.combine(self.repo, scan, main2, ENV)
        self.assertEqual((via, refusal), ("cherry-pick", ""))
        self.assertEqual(sh(self.repo, "show", "HEAD:scan.sh"), "exit 3")
        self.assertEqual(sh(self.repo, "show", "HEAD:other.txt"), "side")


class TheScratchWorktree(Repo):
    def opts(self, worktree: str) -> siblingscan.Options:
        return siblingscan.parse_args(["o/r", "--worktree", worktree, "--", "true"])

    def common(self) -> str:
        return siblingscan.absolute_git_path("--git-common-dir", self.repo, ENV)

    def test_a_new_worktree_is_made_marked_and_then_reused(self) -> None:
        wt = os.path.join(self.top, "wt")
        made = siblingscan.scratch_worktree(self.opts(wt), self.repo, self.common(), self.base, ENV, self.top)
        self.assertEqual(made, siblingscan.Scratch(wt, ""))
        again = siblingscan.scratch_worktree(self.opts(wt), self.repo, self.common(), self.base, ENV, self.top)
        self.assertEqual(again, siblingscan.Scratch(wt, ""))

    def test_a_worktree_it_did_not_make_another_repository_s_or_a_file_is_refused(self) -> None:
        sh(self.repo, "worktree", "add", "-q", "--detach", os.path.join(self.top, "mine"), self.base)
        other = os.path.join(self.top, "other")
        os.makedirs(other)
        sh(other, "init", "-q")
        commit(other, "b.txt", "b\n")
        os.makedirs(os.path.join(other, "sub"))
        stray = os.path.join(self.top, "file")
        open(stray, "w", encoding="utf-8").close()
        for path, text in ((os.path.join(self.top, "mine"), "was not made by sibling-scan"),
                           (other, "a worktree of another repository"), (stray, "is not a directory"),
                           (os.path.join(other, "sub"), "is not the top of a git worktree")):
            refusal = siblingscan.scratch_worktree(self.opts(path), self.repo, self.common(), self.base, ENV, self.top)
            self.assertIsInstance(refusal, str, path)
            self.assertIn(text, str(refusal))

    def test_without_worktree_one_is_made_under_the_scratch_top_for_removal(self) -> None:
        opts = siblingscan.parse_args(["o/r", "--", "true"])
        made = siblingscan.scratch_worktree(opts, self.repo, self.common(), self.base, ENV, self.top)
        self.assertEqual(made, siblingscan.Scratch(os.path.join(self.top, "worktree"), self.top))


if __name__ == "__main__":
    unittest.main()
