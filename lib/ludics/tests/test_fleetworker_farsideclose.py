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
              env: dict[str, str] | None = None) -> tuple[str, str]:
        head = f"STATE={shlex.quote(str(self.state))}\nSKILLS_REPO={shlex.quote(str(ROOT))}\nBOX=box\n"
        done = subprocess.run([BASH, "-s", "--", str(path), remote, "30", "1" if dry else "0", *regenerable],
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
                    record("x", worker="z", checkout="/h/wts/w1/sub")):
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
                     ["w", "--regenerable", "a/b"], ["w", "--regenerable", ".."], ["w", "--regenerable", "."],
                     ["w", "--regenerable", "-x"], ["w", "--regenerable", ".git"], ["w", "--regenerable", ""]):
            with self.subTest(args=args), self.assertRaises(cli.Exit) as raised:
                farsideclose.parse(args)
            self.assertEqual(raised.exception.rc, 2)
        self.assertEqual(farsideclose.parse(["w", "--regenerable", "_build", "--regenerable", ".cache", "--remote", "up", "--dry-run"]),
                         ("w", [], ["_build", ".cache"], "up", True))


if __name__ == "__main__":
    unittest.main()
