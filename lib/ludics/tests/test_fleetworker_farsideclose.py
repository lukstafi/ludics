"""ludics.fleetworker.farsideclose: the sweep's gates, far side first, against real git repositories
(the shell suite's `execution leg` section drives the whole verb through a real registry and board)."""

import contextlib
import fcntl
import io
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import farsideclose, leg
from ludics.fleetworker.config import load_config
from ludics.fleetworker.farside import HELPERS
from ludics.fleetworker.transport import UNREACHABLE, Done

BASH = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash") or "bash"  # 3.2 on macOS
ROOT = Path(leg.__file__).resolve().parents[3]
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}


class Fixture(unittest.TestCase):
    """A bare remote, a checkout of it (main: `.gitignore` for `_build/` and `*.log`), worktrees of it."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.state = self.tmp / "state"
        self.remote, self.co = self.tmp / "r.git", self.tmp / "co"
        self.git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.remote))
        self.git(self.tmp, "init", "-q", "-b", "main", str(self.co))
        self.git(self.co, "remote", "add", "origin", str(self.remote))
        (self.co / ".gitignore").write_text("_build/\n*.log\n")
        self.git(self.co, "add", "-A")
        self.git(self.co, "commit", "-q", "-m", "a")
        self.git(self.co, "push", "-q", "origin", "main")

    def git(self, where: Path, *args: str) -> str:
        return subprocess.run(["git", "-C", str(where), *args], check=True, env=ENV, capture_output=True, text=True).stdout

    def worktree(self, name: str, *, build: bool = True) -> Path:
        path = self.tmp / name
        self.git(self.co, "worktree", "add", "-q", "--detach", str(path), "main")
        if build:
            (path / "_build" / "default").mkdir(parents=True)
            (path / "_build" / "default" / "o").write_text("x\n")
        return path

    def commit_in(self, path: Path) -> None:
        (path / "mine").write_text("mine\n")
        self.git(path, "add", "mine")
        self.git(path, "commit", "-q", "-m", "mine")

    def close(self, path: Path | str, *regenerable: str, dry: bool = False, remote: str = "origin",
              env: dict[str, str] | None = None, observed: str = "") -> tuple[str, str]:
        head = f"STATE={shlex.quote(str(self.state))}\nSKILLS_REPO={shlex.quote(str(ROOT))}\nBOX=box\n"
        done = subprocess.run([BASH, "-s", "--", str(path), remote, "30", "1" if dry else "0", "t0k", observed, *regenerable],
                              input=head + HELPERS + farsideclose.CLOSE, text=True, capture_output=True, cwd="/",
                              env={**ENV, **(env or {})})
        self.assertEqual(done.returncode, 0, done.stderr)
        verdict, _, why = done.stdout.rstrip("\n").partition("\t")
        return verdict, why


class Far(Fixture):
    """Every gate that fails keeps the worktree whole: the sweep's silent defect is deleting too much."""

    def test_a_clean_worktree_with_head_on_the_remote_goes_build_and_all(self) -> None:
        wt = self.worktree("w")
        self.assertEqual(self.close(wt, "_build")[0], "REMOVED")
        self.assertFalse(wt.exists())
        self.assertNotIn(str(wt), self.git(self.co, "worktree", "list"))

    def test_recorded_old_tip_after_rebase_is_removed_but_new_commit_is_kept(self) -> None:
        wt = self.worktree("old", build=False)
        self.commit_in(wt)
        sha = self.git(wt, "rev-parse", "HEAD").strip()
        self.git(wt, "push", "-q", "origin", "HEAD:refs/heads/worker")
        self.git(self.co, "push", "-q", "origin", ":worker")
        self.assertEqual(self.close(wt, observed=sha, dry=True)[0], "WOULD-REMOVE")
        (wt / "private.log").write_text("data")
        self.assertEqual(self.close(wt, observed=sha)[0], "KEPT")
        (wt / "private.log").unlink()
        (wt / "mine").write_text("dirty")
        self.assertEqual(self.close(wt, observed=sha)[0], "KEPT")
        self.git(wt, "checkout", "--", "mine")
        self.assertEqual(self.close(wt, observed=sha)[0], "REMOVED")
        wt = self.worktree("new", build=False)
        self.commit_in(wt)
        self.assertEqual(self.close(wt, observed=self.git(self.co, "rev-parse", "HEAD").strip())[0], "KEPT")

    def test_a_dry_run_runs_the_gates_and_removes_nothing(self) -> None:
        wt, mine = self.worktree("w"), self.worktree("m")
        self.commit_in(mine)
        self.assertEqual(self.close(wt, "_build", dry=True)[0], "WOULD-REMOVE")
        self.assertEqual(self.close(mine, "_build", dry=True)[0], "WOULD-TRIM")
        self.assertTrue((wt / "_build" / "default" / "o").exists())
        self.assertTrue((mine / "_build").exists())

    def test_a_head_the_remote_lacks_keeps_the_worktree_and_gives_up_only_the_regenerable(self) -> None:
        wt = self.worktree("w")
        self.commit_in(wt)
        verdict, why = self.close(wt, "_build")
        self.assertEqual(verdict, "TRIMMED")
        self.assertIn("on no branch of origin", why)
        self.assertFalse((wt / "_build").exists())
        self.assertTrue((wt / "mine").exists())
        self.assertIn(str(wt), self.git(self.co, "worktree", "list"))

    def test_with_no_regenerable_named_that_head_keeps_everything(self) -> None:
        wt = self.worktree("w", build=False)
        self.commit_in(wt)
        self.assertEqual(self.close(wt, "_build")[0], "KEPT")
        self.assertTrue((wt / "mine").exists())

    def test_a_stale_tracking_ref_is_not_the_remote(self) -> None:
        # HEAD on origin/gone here, and on no branch of the remote any more: only a fresh look says so.
        wt = self.worktree("w", build=False)
        self.commit_in(wt)
        self.git(wt, "push", "-q", "origin", "HEAD:refs/heads/gone")
        self.git(self.co, "fetch", "-q", "origin")
        self.assertIn("origin/gone", self.git(self.co, "branch", "-r"))
        self.git(self.tmp, "--git-dir", str(self.remote), "update-ref", "-d", "refs/heads/gone")
        self.assertEqual(self.close(wt)[0], "KEPT")
        self.assertTrue(wt.exists())

    def test_a_remote_that_cannot_be_asked_reads_as_not_holding_head(self) -> None:
        wt = self.worktree("w")
        verdict, why = self.close(wt, remote="nosuchremote")
        self.assertEqual(verdict, "KEPT")
        self.assertIn("ignored data", why)  # no --regenerable: the build tree alone keeps it, first
        verdict, why = self.close(wt, "_build", remote="nosuchremote")
        self.assertEqual(verdict, "TRIMMED")
        self.assertIn("cannot ask nosuchremote", why)
        self.assertTrue(wt.exists())

    def test_the_close_leaves_no_private_ref_and_moves_no_ref_of_the_checkout(self) -> None:
        self.git(self.tmp, "--git-dir", str(self.remote), "branch", "other", "main")
        wt = self.worktree("w")
        before = self.git(self.co, "for-each-ref")
        self.assertEqual(self.close(wt, "_build")[0], "REMOVED")
        self.assertEqual(self.git(self.co, "for-each-ref"), before)

    def test_changed_or_untracked_paths_keep_it(self) -> None:
        for name, touch in (("changed", ".gitignore"), ("untracked", "new")):
            with self.subTest(name):
                wt = self.worktree(name)
                (wt / touch).write_text("data\n")
                verdict, why = self.close(wt, "_build")
                self.assertEqual(verdict, "KEPT")
                self.assertIn("uncommitted", why)
                self.assertTrue((wt / "_build").exists())

    def test_ignored_data_the_flag_does_not_name_keeps_it_build_included(self) -> None:
        wt = self.worktree("w")
        (wt / "run.log").write_text("the only copy\n")
        verdict, why = self.close(wt, "_build")
        self.assertEqual(verdict, "KEPT")
        self.assertIn("run.log", why)
        self.assertTrue((wt / "_build").exists())

    def test_a_build_tree_nobody_named_is_ignored_data_like_any_other(self) -> None:
        wt = self.worktree("w")
        self.assertEqual(self.close(wt), ("KEPT", "ignored data that --regenerable does not name: _build/"))
        self.assertTrue((wt / "_build").exists())

    def test_a_regenerable_name_that_is_a_symlink_or_holds_a_tracked_file_is_not_regenerable(self) -> None:
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "precious").write_text("x\n")
        wt = self.worktree("w", build=False)
        (wt / "_build").symlink_to(outside)
        verdict, _ = self.close(wt, "_build")
        self.assertEqual(verdict, "KEPT")
        self.assertTrue((outside / "precious").exists())
        (self.co / "keep").mkdir()
        (self.co / "keep" / "tracked").write_text("t\n")
        (self.co / ".gitignore").write_text("_build/\n*.log\nkeep/o\n")
        self.git(self.co, "add", "-A")
        self.git(self.co, "commit", "-q", "-m", "keep")
        self.git(self.co, "push", "-q", "origin", "main")
        mixed = self.worktree("mixed", build=False)
        (mixed / "keep" / "o").write_text("built\n")
        self.assertEqual(self.close(mixed, "keep")[0], "KEPT")
        self.assertTrue((mixed / "keep" / "tracked").exists())

    def nested(self, name: str) -> Path:
        """A worktree of a main whose tests write ``log_files/`` at three depths (ludics#1049)."""
        if not (self.co / "deep").exists():
            for tracked in ("deep/test/t.ml", "conf/c", "keep/log_files/tracked"):
                (self.co / tracked).parent.mkdir(parents=True, exist_ok=True)
                (self.co / tracked).write_text("t\n")
            (self.co / ".gitignore").write_text("_build/\n*.log\nlog_files/\n")
            self.git(self.co, "add", "-A")
            self.git(self.co, "add", "-f", "keep/log_files/tracked")
            self.git(self.co, "commit", "-q", "-m", "nested")
            self.git(self.co, "push", "-q", "origin", "main")
        wt = self.worktree(name)
        for logs in ("log_files", "deep/test/log_files", "conf/log_files"):
            (wt / logs).mkdir()
            (wt / logs / "run").write_text("regenerable\n")
        return wt

    def test_nested_ignored_directories_named_at_any_depth_go_with_the_tree(self) -> None:
        wt = self.nested("w")
        verdict, why = self.close(wt, "_build")
        self.assertEqual(verdict, "KEPT")
        for logs in ("conf/log_files/", "deep/test/log_files/", "log_files/"):
            self.assertIn(logs, why)
        self.assertEqual(self.close(wt, "_build", "**/log_files", dry=True)[0], "WOULD-REMOVE")
        self.assertEqual(self.close(wt, "_build", "**/log_files")[0], "REMOVED")
        self.assertFalse(wt.exists())

    def test_an_exact_nested_path_names_that_directory_alone(self) -> None:
        wt = self.nested("w")
        verdict, why = self.close(wt, "_build", "conf/log_files", "log_files")
        self.assertEqual(verdict, "KEPT")
        self.assertEqual(why, "ignored data that --regenerable does not name: deep/test/log_files/")
        self.assertEqual(self.close(wt, "_build", "**/test/log_files", "conf/log_files", "log_files")[0], "REMOVED")

    def test_an_ignored_path_a_nested_value_does_not_match_keeps_it_and_is_named(self) -> None:
        wt = self.nested("w")
        (wt / "deep" / "test" / "run.log").write_text("the only copy\n")
        (wt / "deep" / "test" / "log_files_old").mkdir()
        (wt / "deep" / "test" / "log_files_old" / "x.log").write_text("the only copy\n")
        verdict, why = self.close(wt, "_build", "**/log_files")
        self.assertEqual(verdict, "KEPT")
        self.assertIn("deep/test/run.log", why)
        self.assertIn("deep/test/log_files_old/", why)
        self.assertTrue((wt / "deep" / "test" / "log_files" / "run").exists())

    def test_a_matched_name_holding_tracked_or_untracked_files_is_not_regenerable(self) -> None:
        wt = self.nested("w")
        (wt / "keep" / "log_files" / "built").write_text("ignored, beside a tracked file\n")
        verdict, why = self.close(wt, "_build", "**/log_files")
        self.assertEqual(verdict, "KEPT")
        self.assertEqual(why, "ignored data that --regenerable does not name: keep/log_files/built")
        self.assertTrue((wt / "keep" / "log_files" / "tracked").exists())
        # A name whose directory holds a file the ignore rules let through is untracked data, not
        # regenerable: the clean-tree gate keeps it first.
        (self.co / ".gitignore").write_text("_build/\n*.log\nlog_files/\ncache/*\n!cache/notes\n")
        self.git(self.co, "commit", "-q", "-am", "cache")
        self.git(self.co, "push", "-q", "origin", "main")
        loose = self.nested("loose")
        (loose / "cache").mkdir()
        (loose / "cache" / "built").write_text("ignored\n")
        (loose / "cache" / "notes").write_text("untracked, not ignored\n")
        verdict, why = self.close(loose, "_build", "**/log_files", "**/cache")
        self.assertEqual(verdict, "KEPT")
        self.assertIn("uncommitted", why)
        self.assertTrue((loose / "cache" / "notes").exists())

    def test_a_trimmed_worktree_loses_its_nested_regenerable_directories_only(self) -> None:
        wt = self.nested("w")
        self.commit_in(wt)
        verdict, why = self.close(wt, "_build", "**/log_files")
        self.assertEqual(verdict, "TRIMMED")
        self.assertIn("removed _build conf/log_files deep/test/log_files log_files, kept the worktree", why)
        self.assertFalse((wt / "deep" / "test" / "log_files").exists())
        self.assertTrue((wt / "deep" / "test" / "t.ml").exists())
        self.assertTrue((wt / "mine").exists())

    def test_a_status_that_fails_on_the_ignored_listing_does_not_read_as_none(self) -> None:
        shim = self.tmp / "bin"
        shim.mkdir()
        real = shutil.which("git")
        (shim / "git").write_text(f'#!/bin/sh\ncase " $* " in *--ignored=*) exit 128 ;; esac\nexec {real} "$@"\n')
        (shim / "git").chmod(0o755)
        wt = self.worktree("w")
        (wt / "run.log").write_text("the only copy\n")
        verdict, why = self.close(wt, "_build", env={"PATH": f"{shim}:{os.environ['PATH']}"})
        self.assertEqual((verdict, why), ("KEPT", "cannot list its ignored paths (git status exit 128)"))
        self.assertTrue((wt / "run.log").exists())

    def test_a_git_operation_under_way_keeps_it_autostash_and_all(self) -> None:
        wt = self.worktree("w", build=False)
        (wt / ".gitignore").write_text("changed\n")
        script = wt.parent / "editor"
        script.write_text("#!/bin/sh\nprintf 'break\\n' > \"$1\"\n")
        script.chmod(0o755)
        self.git(wt, "-c", f"sequence.editor={script}", "rebase", "-i", "--autostash", "HEAD")
        self.assertEqual(self.git(wt, "status", "--porcelain"), "")
        verdict, why = self.close(wt)
        self.assertEqual((verdict, why), ("KEPT", "a Git operation is under way or left behind in it: rebase-merge"))
        self.git(wt, "rebase", "--abort")
        self.assertEqual((wt / ".gitignore").read_text(), "changed\n")

    def test_an_edit_hidden_behind_an_index_flag_keeps_it(self) -> None:
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                wt = self.worktree(flag.strip("-"), build=False)
                self.git(wt, "update-index", flag, ".gitignore")
                (wt / ".gitignore").write_text("the only copy\n")
                self.assertEqual(self.git(wt, "status", "--porcelain"), "")
                verdict, why = self.close(wt)
                self.assertEqual(verdict, "KEPT")
                self.assertIn("hidden from status by an index flag", why)
                self.assertEqual((wt / ".gitignore").read_text(), "the only copy\n")

    def test_a_private_ref_keeps_it(self) -> None:
        wt = self.worktree("w", build=False)
        self.git(wt, "update-ref", "refs/worktree/mine", "HEAD")
        self.assertEqual(self.close(wt), ("KEPT", "it holds a private ref: refs/worktree/mine"))

    def test_an_index_lock_keeps_it(self) -> None:
        wt = self.worktree("w", build=False)
        admin = Path(self.git(wt, "rev-parse", "--absolute-git-dir").strip())
        (admin / "index.lock").write_text("")
        self.assertEqual(self.close(wt)[0], "KEPT")
        self.assertTrue(wt.exists())
        (admin / "index.lock").unlink()

    def test_an_interrupted_runs_refs_do_not_answer_for_this_one(self) -> None:
        wt = self.worktree("w", build=False)
        self.commit_in(wt)
        self.git(self.co, "update-ref", "refs/fleet-close/old/gone", self.git(wt, "rev-parse", "HEAD").strip())
        self.assertEqual(self.close(wt)[0], "KEPT")
        self.assertTrue(wt.exists())

    def test_a_trailing_slash_does_not_hide_a_symlink(self) -> None:
        wt = self.worktree("w", build=False)
        link = self.tmp / "alias"
        link.symlink_to(wt)
        for spelled in (f"{link}/", f"{link}//"):
            with self.subTest(spelled=spelled):
                self.assertEqual(self.close(spelled), ("KEPT", "not a directory"))
        self.assertTrue(wt.exists())

    def test_what_is_no_linked_worktree_top_is_kept(self) -> None:
        wt = self.worktree("w", build=False)
        (wt / "sub").mkdir()
        (wt / "sub" / "f").write_text("f\n")
        self.git(wt, "add", "sub")
        self.git(wt, "commit", "-q", "-m", "sub")
        plain = self.tmp / "plain"
        plain.mkdir()
        link = self.tmp / "link"
        link.symlink_to(wt)
        afile = self.tmp / "afile"
        afile.write_text("x\n")
        for path, words in ((self.co, "main checkout"), (wt / "sub", "not the top of a worktree"), (plain, "not the top of a worktree"),
                            (link, "not a directory"), (afile, "not a directory")):
            with self.subTest(path=path.name):
                verdict, why = self.close(path)
                self.assertEqual(verdict, "KEPT")
                self.assertIn(words, why)
        self.assertTrue((self.co / ".git").exists() and (plain).exists() and link.is_symlink() and afile.exists())

    def test_a_git_locked_worktree_is_gits_to_refuse_and_force_is_never_passed(self) -> None:
        wt = self.worktree("w")
        self.git(self.co, "worktree", "lock", str(wt))
        verdict, why = self.close(wt, "_build")
        self.assertEqual(verdict, "KEPT")
        self.assertIn("git worktree remove failed", why)
        self.assertTrue((wt / "_build").exists())

    def test_a_path_already_gone_is_gone_so_a_re_run_is_safe(self) -> None:
        wt = self.worktree("w")
        self.assertEqual(self.close(wt, "_build")[0], "REMOVED")
        self.assertEqual(self.close(wt, "_build")[0], "GONE")

    def test_a_held_leg_lock_keeps_it(self) -> None:
        # The lock a leg takes, by the leg's own text: its file named by the shared function.
        wt = self.worktree("w")
        script = (f"STATE={shlex.quote(str(self.state))}\n" + leg.WORKTREE
                  + f'wkey=$(canon {shlex.quote(str(wt))}); leg_lock_file "$wkey"\n')
        lock = subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=True).stdout
        (self.state / "leg-locks").mkdir(parents=True)
        with open(lock, "a", encoding="utf-8") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            verdict, why = self.close(wt, "_build")
        self.assertEqual(verdict, "KEPT")
        self.assertIn("another leg is using it", why)
        self.assertTrue((wt / "_build").exists())
        self.assertEqual(self.close(wt, "_build")[0], "REMOVED")

    def set_origin_head(self, branch: str = "main") -> None:
        self.git(self.co, "symbolic-ref", "refs/remotes/origin/HEAD", f"refs/remotes/origin/{branch}")

    def write_project_regen(self, text: str) -> None:
        p = self.co / ".github" / "fleet-regenerable"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text.encode("utf-8"))
        self.git(self.co, "add", ".github/fleet-regenerable")
        self.git(self.co, "commit", "-q", "-m", "regen")
        self.git(self.co, "push", "-q", "origin", "main")
        self.set_origin_head("main")

    def test_project_fleet_regenerable_from_origin_head_allows_removal_and_combines_with_cli(self) -> None:
        self.write_project_regen("# comment\n\n  _build  \n\t**/log_files\t\n")
        (self.co / "sub").mkdir(exist_ok=True)
        (self.co / "sub" / "t").write_text("t\n")
        (self.co / ".gitignore").write_text("_build/\nlog_files/\nextra/\n*.log\n")
        self.git(self.co, "add", "-A")
        self.git(self.co, "commit", "-q", "-m", "ignore")
        self.git(self.co, "push", "-q", "origin", "main")
        wt = self.worktree("w")
        (wt / "sub" / "log_files").mkdir(parents=True)
        (wt / "sub" / "log_files" / "a").write_text("x\n")
        before = self.git(self.co, "for-each-ref")
        verdict, why = self.close(wt)
        self.assertEqual(verdict, "REMOVED", why)
        self.assertFalse(wt.exists())
        self.assertEqual(self.git(self.co, "for-each-ref"), before)
        # CLI --regenerable adds to .github/fleet-regenerable; unlisted ignored file still keeps it.
        wt2 = self.worktree("w2")
        (wt2 / "extra").mkdir()
        (wt2 / "extra" / "b").write_text("x\n")
        verdict, why = self.close(wt2)
        self.assertEqual((verdict, why), ("KEPT", "ignored data that --regenerable does not name: extra/"))
        self.assertTrue((wt2 / "_build").exists())
        verdict, why = self.close(wt2, "extra")
        self.assertEqual(verdict, "REMOVED", why)
        self.assertFalse(wt2.exists())

    def test_project_fleet_regenerable_never_reads_worktree_head_or_non_remote_symref(self) -> None:
        # Worktree's own unmerged branch adds .github/fleet-regenerable: origin/main lacks it, so KEPT.
        self.set_origin_head("main")
        wt = self.worktree("w")
        (wt / ".github").mkdir(exist_ok=True)
        (wt / ".github" / "fleet-regenerable").write_text("_build\n")
        self.git(wt, "add", ".github/fleet-regenerable")
        self.git(wt, "commit", "-q", "-m", "self-vouch")
        self.git(wt, "push", "-q", "origin", "HEAD:refs/heads/topic")
        verdict, why = self.close(wt)
        self.assertEqual((verdict, why), ("KEPT", "ignored data that --regenerable does not name: _build/"))
        # A symbolic refs/remotes/origin/HEAD pointing outside refs/remotes/origin/ is never read.
        self.git(self.co, "branch", "local-topic", self.git(wt, "rev-parse", "HEAD").strip())
        self.git(self.co, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/local-topic")
        verdict, why = self.close(wt)
        self.assertEqual((verdict, why), ("KEPT", "ignored data that --regenerable does not name: _build/"))
        self.assertTrue(wt.exists())

    def test_project_fleet_regenerable_reads_fresh_remote_policy_and_ignores_replacements(self) -> None:
        # Local origin/main still lists _build, while remote main has revoked _build: must KEEP.
        self.write_project_regen("_build\n")
        wt = self.worktree("revoked")
        # Push a revocation from a second clone so self.co's local refs/remotes/origin/main stays stale.
        other = self.tmp / "other"
        self.git(self.tmp, "clone", "-q", str(self.remote), str(other))
        (other / ".github" / "fleet-regenerable").write_text("# revoked\n")
        self.git(other, "commit", "-q", "-am", "revoke")
        self.git(other, "push", "-q", "origin", "main")
        before = self.git(self.co, "for-each-ref")
        verdict, why = self.close(wt)
        self.assertEqual((verdict, why), ("KEPT", "ignored data that --regenerable does not name: _build/"))
        self.assertTrue((wt / "_build").exists())
        self.assertEqual(self.git(self.co, "for-each-ref"), before)
        # Local refs/replace/* spoofing .github/fleet-regenerable blob is ignored.
        remote_head = self.git(other, "rev-parse", "HEAD").strip()
        real_blob = self.git(other, "rev-parse", f"{remote_head}:.github/fleet-regenerable").strip()
        self.git(self.co, "fetch", "-q", "origin", "main")
        fake_file = self.tmp / "fake-regen"
        fake_file.write_text("_build\n")
        fake_blob = self.git(self.co, "hash-object", "-w", str(fake_file)).strip()
        self.git(self.co, "replace", real_blob, fake_blob)
        verdict, why = self.close(wt)
        self.assertEqual((verdict, why), ("KEPT", "ignored data that --regenerable does not name: _build/"))
        self.assertTrue((wt / "_build").exists())
        # Unreachable remote does not fall back to stale local tracking ref.
        self.git(self.co, "replace", "-d", real_blob)
        self.git(self.co, "update-ref", "refs/remotes/origin/main", "HEAD")
        wt2 = self.worktree("offline")
        self.git(self.co, "remote", "set-url", "origin", str(self.tmp / "missing.git"))
        verdict, why = self.close(wt2)
        self.assertEqual((verdict, why), ("KEPT", "ignored data that --regenerable does not name: _build/"))
        self.assertTrue((wt2 / "_build").exists())

    def test_project_fleet_regenerable_malformed_cr_nul_or_non_regular_fails_closed(self) -> None:
        bad_contents = [
            ("escape", "../escape\n"),
            ("glob", "*\n"),
            ("inline-comment", "_build # comment\n"),
            ("dotgit", ".GIT\n"),
            ("non-ascii", "café\n"),
            ("cr", "_build\r\n"),
            ("nul", "_build\x00\n"),
        ]
        for name, content in bad_contents:
            with self.subTest(name=name):
                self.write_project_regen(content)
                wt = self.worktree(f"bad-{name}", build=False)
                verdict, why = self.close(wt)
                self.assertEqual(verdict, "KEPT", why)
                self.assertIn(".github/fleet-regenerable", why)
                self.assertTrue(wt.exists())
        # Symlink at .github/fleet-regenerable (mode 120000) is refused.
        p = self.co / ".github" / "fleet-regenerable"
        p.unlink()
        (self.co / "target").write_text("_build\n")
        p.symlink_to("../target")
        self.git(self.co, "add", "-A")
        self.git(self.co, "commit", "-q", "-m", "symlink")
        self.git(self.co, "push", "-q", "origin", "main")
        wt = self.worktree("bad-symlink")
        verdict, why = self.close(wt)
        self.assertEqual(verdict, "KEPT")
        self.assertIn("not a regular file (mode 120000)", why)
        self.assertTrue((wt / "_build").exists())

    def test_repo_own_fleet_regenerable_parses_cleanly(self) -> None:
        own = ROOT / ".github" / "fleet-regenerable"
        self.assertTrue(own.is_file(), f"missing {own}")
        raw = own.read_bytes()
        self.assertNotIn(b"\x00", raw)
        self.assertNotIn(b"\r", raw)
        entries = [line.strip(" \t") for line in raw.decode("utf-8").splitlines()
                   if line.strip(" \t") and not line.strip(" \t").startswith("#")]
        self.assertIn("**/__pycache__", entries)
        for entry in entries:
            self.assertTrue(farsideclose.regenerable_value(entry), entry)

    def test_python_and_shell_regenerable_validators_agree_on_every_shape(self) -> None:
        samples = [
            "_build", ".cache", ".cache/x", "arrayjit/test/log_files", "**/log_files", "**/__pycache__",
            "**/a/b", ".a", "_a", "._a", ".gitignore",
            "", "/abs", "/", "../x", "a/../b", "a/./b", "a//b", "a/", "./a", "**", "**/", "*",
            "*/log_files", "**/**/x", "a/**/b", "a/**", "log_*", "lo?", "[l]og", ".git", ".GIT",
            "**/.git", "x/.git", "x/.GIT", "a/-x", "-x", "..x", ".-x", "a\\b", "a b", "**/..", "**/.","café",
        ]
        script = farsideclose.VALID_REGEN + 'for v in "$@"; do if valid_regen "$v"; then echo 1; else echo 0; fi; done\n'
        done = subprocess.run([BASH, "-c", script, "--", *samples], capture_output=True, text=True, check=True)
        shell_verdicts = [line == "1" for line in done.stdout.splitlines()]
        py_verdicts = [farsideclose.regenerable_value(s) for s in samples]
        self.assertEqual(shell_verdicts, py_verdicts, list(zip(samples, shell_verdicts, py_verdicts)))


def record(rid: str, *, state: str = "running", host: str = "rog", wave: str = "w", worker: str = "wk", checkout: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {"request_id": rid, "state": state, "request": {"execution_host": host, "wave": wave, "worker": worker}}
    if checkout:
        out["checkout"] = checkout
    return out


class Near(unittest.TestCase):
    """What the near side keeps without asking a box, and the verb's statuses."""

    def setUp(self) -> None:
        self.cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                               {"HOME": "/h", "FLEET_BOXES": "rog mac", "FLEET_LOCAL_BOX": "mac", "FLEET_ANCHOR": "mac",
                                "FLEET_COORDINATOR": "c"}, host="mac")

    def row(self, task: str = "t1", **fields: str) -> tuple[str, dict[str, str]]:
        return task, {"state": "merged", "farside": "rog:/h/wts/w1", **fields}

    def held(self, rows: list[tuple[str, dict[str, str]]], records: list[dict[str, Any]] | None = None) -> list[str]:
        return [w.held for w in farsideclose.plan(self.cfg, "w", rows, [], records or [])]

    def test_observations_require_exact_identity_checkout_and_observed_object_id(self) -> None:
        sha = "a" * 40
        rec = record("leg", state="concluded", checkout="/h/wts/w1/")
        rec["observed_sha"] = sha
        row = self.row(worker="wk")
        def read(r: dict[str, Any]) -> tuple[str, ...]:
            return farsideclose.plan(self.cfg, "w", [row], [], [r])[0].observed
        self.assertEqual(read(rec), (sha,))
        for key, value in (("state", "running"), ("checkout", "/h/wts/w1/sub"),
                           ("checkout", "/h/wts/./w1"), ("observed_sha", "a" * 39),
                           ("observed_sha", None)):
            with self.subTest(key=key, value=value):
                self.assertEqual(read({**rec, key: value}), ())
        for key in ("worker", "wave", "execution_host"):
            self.assertEqual(read({**rec, "request": {**rec["request"], key: "other"}}), ())
        self.assertEqual(read({**rec, "observed_sha": None, "resolved_revision": sha}), ())
        self.assertEqual(farsideclose.plan(self.cfg, "w", [self.row()], [], [rec])[0].observed, ())

    def test_only_a_word_of_the_grammar_reaches_a_box(self) -> None:
        for word, why in (("nobox", "not <box>:<path>"), (":/x", "not <box>:<path>"), ("rog:", "not <box>:<path>"),
                          ("elsewhere:/h/w", "no box of this fleet"), ("rog:relative/w", "not an absolute path"),
                          ("rog:/", "not an absolute path"), ("rog:/h/../etc", "not an absolute path"),
                          ("rog:/h/./w", "not an absolute path"), ("rog:~/w", "not an absolute path"),
                          ("rog:/h//w", "not an absolute path")):
            with self.subTest(word=word):
                self.assertIn(why, farsideclose.parse_word(self.cfg, word)[2])
        self.assertEqual(farsideclose.parse_word(self.cfg, "rog:/h/w:1"), ("rog", "/h/w:1", ""))
        self.assertEqual(farsideclose.parse_word(self.cfg, "local:/h/w/"), ("mac", "/h/w/", ""))

    def test_a_live_row_or_a_state_that_is_no_done_word_keeps_its_words(self) -> None:
        for state in ("reviewing", "launched", "whatever", ""):
            with self.subTest(state=state):
                self.assertIn("not a done word", self.held([self.row(state=state)])[0])
        self.assertEqual(self.held([self.row(state="merged; PR #1")]), [""])

    def test_a_word_a_not_done_row_also_names_is_kept(self) -> None:
        got = self.held([self.row("t1"), self.row("t2", state="reviewing", farside="rog:/h/wts/w1 rog:/h/wts/w2")])
        self.assertEqual(got[0], "a row that is not done names it too")
        got = self.held([self.row("t1"), self.row("t2", state="reviewing", farside="rog:/h/wts/w1/")])
        self.assertEqual(got[0], "a row that is not done names it too")
        got = self.held([self.row("t1", farside="local:/h/wts/w1"), self.row("t2", state="reviewing", farside="mac:/h/wts/w1")])
        self.assertEqual(got[0], "a row that is not done names it too")

    def test_an_outstanding_record_keeps_it_by_each_way_it_can_refer_to_it(self) -> None:
        row = self.row(standing="s1", requests="r1", worker="wk")
        for rec in (record("s1", worker="z", wave="z"), record("r1", worker="z", wave="z", host="mac"),
                    record("x", host="mac"), record("x", worker="z", checkout="/h/wts/w1/"),
                    record("x", worker="z", checkout="/h/wts/w1/sub"), record("x", worker="z", checkout="/h/wts//w1"),
                    record("x", worker="z", checkout="/h/wts/./w1"), record("x", worker="z", checkout="//h/wts/w1"),
                    record("x", worker="z", checkout="/h/other/../wts/w1")):
            with self.subTest(rec=rec):
                self.assertIn("outstanding reservation", self.held([row], [rec])[0])
        here = self.row(farside="local:/h/wts/w1", worker="wk")
        for rec in (record("x", worker="z", host="mac", checkout="/h/wts/w1"), record("x", worker="z", host="local", checkout="/h/wts/w1")):
            with self.subTest(rec=rec):
                self.assertIn("outstanding reservation", self.held([here], [rec])[0])

    def test_a_concluded_record_or_anothers_on_another_box_keeps_nothing(self) -> None:
        row = self.row(standing="s1", worker="wk")
        for rec in (record("s1", state="concluded"), record("x", worker="z", host="mac", checkout="/h/wts/w1"),
                    record("x", worker="z", checkout="/h/wts/w10"), record("x", worker="wk", wave="other")):
            with self.subTest(rec=rec):
                self.assertEqual(self.held([row], [rec]), [""])

    def run_verb(self, args: list[str], doc: Any, *, reg: Done | None = None, far: list[Done] | None = None,
                 gate: int = 0) -> tuple[int, str, mock.Mock, mock.Mock]:
        out = io.StringIO()
        records = '[]'
        with mock.patch.object(farsideclose, "anchor_gate", return_value=gate) as lease, \
                mock.patch.object(farsideclose, "board_document", return_value=doc), \
                mock.patch.object(farsideclose, "listing", return_value=reg or Done(0, records)), \
                mock.patch.object(farsideclose, "run_on", side_effect=far or []) as boxes, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            rc = farsideclose.cmd_farside_close(self.cfg, args)
        return rc, out.getvalue(), lease, boxes

    def board(self, *rows: tuple[str, dict[str, str]]) -> dict[str, Any]:
        return {"tasks": [{"task": task, "fields": fields} for task, fields in rows]}

    def test_the_status_says_whether_anything_stayed(self) -> None:
        doc = self.board(self.row(farside="rog:/h/a rog:/h/b"))
        ok, gone, kept, trimmed = Done(0, "REMOVED\twhy\n"), Done(0, "GONE\twhy\n"), Done(0, "KEPT\twhy\n"), Done(0, "TRIMMED\twhy\n")
        self.assertEqual(self.run_verb(["w"], doc, far=[ok, gone])[0], 0)
        self.assertEqual(self.run_verb(["w"], doc, far=[ok, kept])[0], 3)
        self.assertEqual(self.run_verb(["w"], doc, far=[ok, trimmed])[0], 3)
        rc, said, _, _ = self.run_verb(["w"], doc, far=[Done(UNREACHABLE, ""), kept])
        self.assertEqual(rc, 4)
        self.assertIn("FARSIDE UNREACHABLE rog:/h/a (t1): rog did not answer", said)
        self.assertIn("FARSIDE CLOSE w: 1 kept, 1 unreachable", said)

    def test_a_far_side_that_gave_no_verdict_is_kept_never_counted_removed(self) -> None:
        doc = self.board(self.row())
        for far in (Done(1, ""), Done(0, "REMOVED but no tab\n"), Done(0, "ERASED\twhy\n"), Done(1, "REMOVED\twhy\n")):
            with self.subTest(far=far):
                rc, said, _, _ = self.run_verb(["w"], doc, far=[far])
                self.assertEqual(rc, 3)
                self.assertIn("gave no verdict", said)

    def test_a_board_with_no_words_is_done(self) -> None:
        rc, said, _, boxes = self.run_verb(["w"], self.board(self.row(farside="none")))
        self.assertEqual((rc, boxes.call_count), (0, 0))
        self.assertIn("no far-side worktrees", said)

    def test_a_registry_that_cannot_be_read_touches_no_box(self) -> None:
        doc = self.board(self.row())
        for reg, want in ((Done(UNREACHABLE, ""), 4), (Done(1, ""), 1), (Done(0, "not json"), 1)):
            with self.subTest(reg=reg):
                rc, said, _, boxes = self.run_verb(["w"], doc, reg=reg)
                self.assertEqual((rc, boxes.call_count), (want, 0))
                self.assertIn("nothing removed", said)

    def test_the_lease_is_asked_of_a_removal_not_of_a_dry_run(self) -> None:
        doc = self.board(self.row())
        rc, _, lease, boxes = self.run_verb(["w"], doc, gate=1)
        self.assertEqual((rc, lease.call_count, boxes.call_count), (1, 1, 0))
        rc, _, lease, boxes = self.run_verb(["w", "--dry-run"], doc, gate=1, far=[Done(0, "WOULD-REMOVE\twhy\n")])
        self.assertEqual((rc, lease.call_count, boxes.call_count), (0, 0, 1))
        self.assertEqual(boxes.call_args.args[3][3], "1")

    def test_task_narrows_the_rows_and_an_unknown_one_touches_no_box(self) -> None:
        doc = self.board(self.row("t1", farside="rog:/h/a"), self.row("t2", farside="rog:/h/b"))
        rc, said, _, boxes = self.run_verb(["w", "--task", "t2"], doc, far=[Done(0, "REMOVED\twhy\n")])
        self.assertEqual((rc, boxes.call_count), (0, 1))
        self.assertIn("rog:/h/b", said)
        rc, said, _, boxes = self.run_verb(["w", "--task", "t9"], doc)
        self.assertEqual((rc, boxes.call_count), (1, 0))

    def test_usage(self) -> None:
        for args in ([], ["--dry-run"], ["w", "x"], ["w", "--bogus"], ["w", "--task"], ["w", "--remote", "a b"], ["w", "--remote", "--upload-pack=x"],
                     ["w", "--regenerable", ".."], ["w", "--regenerable", "."],
                     ["w", "--regenerable", "-x"], ["w", "--regenerable", ".git"], ["w", "--regenerable", ""]):
            with self.subTest(args=args), self.assertRaises(cli.Exit) as raised:
                farsideclose.parse(args)
            self.assertEqual(raised.exception.rc, 2)
        self.assertEqual(farsideclose.parse(["w", "--regenerable", "_build", "--regenerable", ".cache", "--remote", "up", "--dry-run"]),
                         ("w", [], ["_build", ".cache"], "up", True))

    def test_a_regenerable_value_is_a_path_inside_the_worktree_or_that_path_at_any_depth(self) -> None:
        # ludics#1049: nested names and `**/` are new; nothing escapes the tree or matches everything.
        for value in ("/abs", "/", "../x", "a/../b", "a/./b", "a//b", "a/", "./a", "**", "**/", "*", "*/log_files",
                      "**/**/x", "a/**/b", "a/**", "log_*", "lo?", "[l]og", "**/.git", "x/.git", "x/.GIT", "a/-x",
                      "a\\b", "a b", "**/..", "**/."):
            with self.subTest(value=value), self.assertRaises(cli.Exit) as raised:
                farsideclose.parse(["w", "--regenerable", value])
            self.assertEqual(raised.exception.rc, 2)
        values = ["arrayjit/test/log_files", "**/log_files", "**/a/b", ".cache/x"]
        self.assertEqual(farsideclose.parse(["w", *[w for v in values for w in ("--regenerable", v)]])[2], values)


class RowDone(unittest.TestCase):
    def test_row_done_is_the_phase_board_check_reads(self) -> None:
        """#1210's item: row_done reads the state as ``takeover.phase_of`` does, with the same verdicts the old
        ``state``-else-``status`` read gave on every shape of row."""
        from ludics.fleetworker.takeover import DONE_STATES, state_word
        rows: list[dict[str, str]] = [{"state": "merged #1"}, {"status": "done"}, {"state": "Closed.", "status": "launched"},
                                      {"state": "reviewing", "status": "merged"}, {"state": "done-merged"}, {"pr": "4"},
                                      {"state": ""}, {"status": "dropped (scope)"}, {"state": "pending"}]
        for fields in rows:
            old = state_word(fields.get("state", fields.get("status", ""))) in DONE_STATES
            self.assertEqual(farsideclose.row_done(fields), old, fields)
        self.assertEqual([farsideclose.row_done(f) for f in rows], [True, True, True, False, False, False, False, True, False])


if __name__ == "__main__":
    unittest.main()
