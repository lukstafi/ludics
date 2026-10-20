"""ludics.fleetworker.takeover (ludics-lite#731): ``board takeover``, driven end to end on this box --
the anchor ``local`` over a scratch state root, the board and the registry written by their shipped
modules, the far sides run by bash -- with only GitHub faked."""

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from typing import Any
from unittest import mock

from ludics import cli, proc
from ludics.fleetworker import boardstore, registry, takeover
from ludics.fleetworker.config import load_config

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SHA = "a" * 40


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


class Takeover(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-takeover-test."))
        self.cfg = load_config(os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh"), {
            "FLEET_ANCHOR": "local", "FLEET_ANCHOR_STATE": self.root, "FLEET_SKILLS_REPO": CHECKOUT,
            "FLEET_BOXES": "local", "PATH": os.environ.get("PATH", ""), "HOME": self.root,
        }, host="testbox")
        self.wt = os.path.join(self.root, "wt")
        git("init", "-q", "-b", "claude/w-7", self.wt)
        git("-C", self.wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c")
        self.head = git("-C", self.wt, "rev-parse", "HEAD")
        self.brief = os.path.join(self.root, "brief-7.md")
        with open(self.brief, "w") as f:
            f.write("# Brief for #7\n\nDo the thing.\n")
        self.gh: list[list[str]] = []

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def board(self, task: str, **fields: str) -> None:
        payload = {"wave": "w", "create": True, "task": task, "fields": [[k, v] for k, v in fields.items()]}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(boardstore.run(["-", self.root, "set", "coord", json.dumps(payload)]), 0)

    def reserve(self, identity: str, worker: str, wave: str = "w", **extra: object) -> None:
        request: dict[str, object] = dict(request_id=identity, wave=wave, worker=worker, transport="subagent", purpose="unit",
                       agent_host="local", execution_host="local", repository="o/r", requested_revision="origin/main",
                       kind="correctness", standing=True, checkout=self.wt)
        request.update(extra)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(registry.run(["-", self.root, "run", "coord", "tok", json.dumps(request), "local"]), 0)

    def full(self, **over: str) -> dict[str, str]:
        fields = dict(worktree=self.wt, branch="claude/w-7", base=SHA[:8], agent="a1", transport="native",
                      agent_host="local", exec_hosts="local", brief=self.brief, brief_host="local", repository="o/r",
                      issue="o/r#7", worker="w-7", pr="42", runs=os.path.join(self.root, "runs"),
                      standing="w-7-iterate", requests="none", farside="rog:/home/u/wt", plan_dir="/plans/7")
        fields.update(over)
        return {k: v for k, v in fields.items() if v != "-"}

    def fake_gh(self, name: str, args: list[str], **_: Any) -> proc.Completed:
        self.assertEqual(name, "gh")
        self.gh.append(list(args))
        pr = {"number": 42, "state": "OPEN", "isDraft": False, "headRefName": "claude/w-7", "headRefOid": self.head,
              "mergeCommit": None, "reviewDecision": "", "url": "https://github.com/o/r/pull/42"}
        if args[:2] == ["pr", "view"]:
            return proc.Completed(0, json.dumps(pr), "")
        return proc.Completed(0, json.dumps([{**pr, "number": 43}]), "")

    def takeover(self, task: str = "t7") -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(proc, "run_tool", side_effect=self.fake_gh), \
                mock.patch("ludics.fleetworker.board.check_identity") as identity, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = takeover.cmd_takeover(self.cfg, ["w", task])
            except cli.Exit as exc:
                rc = exc.rc
        identity.assert_not_called()  # a read: no lease, no identity
        return rc, out.getvalue(), err.getvalue()

    def test_the_brief_comes_first_then_the_state_from_every_source(self) -> None:
        self.board("t7", **self.full())
        self.reserve("w-7-iterate", "w-7")
        runs = os.path.join(self.root, "runs")
        for n, rc in ((2, "0"), (10, "1")):
            os.makedirs(os.path.join(runs, f"run-{n}"))
            with open(os.path.join(runs, f"run-{n}", "rc"), "w") as f:
                f.write(rc + "\n")
        rc, out, err = self.takeover()
        self.assertEqual(rc, 0, err)
        self.assertTrue(out.startswith("# Brief for #7\n\nDo the thing.\n\n## State at takeover\n"), out)
        for want in (f"- brief: {self.brief} on local", f"- worktree: {self.wt}", "- requests: none",
                     f"- on local: HEAD {self.head}, branch claude/w-7, 0 uncommitted path(s)",
                     f"- #42 OPEN, head claude/w-7 at {self.head}, https://github.com/o/r/pull/42",
                     f"- w-7-iterate: launching, correctness, standing, on local, checkout {self.wt}; outstanding for"
                     " worker w-7, named on the row",
                     f"- {runs}/run-2: rc=0\n- {runs}/run-10: rc=1"):
            self.assertIn(want, out)
        self.assertNotIn("missing", out.split("### Board keys")[1].split("###")[0])
        self.assertNotIn("CONFLICT", out)
        self.assertEqual(self.gh, [["pr", "view", "42", "--repo", "o/r", "--json", takeover.PR_FIELDS]])

    def test_a_missing_key_is_printed_missing_and_nothing_is_guessed(self) -> None:
        self.board("t7", **self.full(pr="-", runs="-", worker="-", brief_host="-", requests="-"))
        rc, out, _ = self.takeover()
        self.assertEqual(rc, 0)
        for key in ("pr", "runs", "worker", "brief_host", "requests"):
            self.assertIn(f"- {key}: missing\n", out)
        self.assertIn("on this box (the row names no brief_host)", out)
        self.assertIn("- not read: the row lacks a valid runs or agent_host", out)
        self.assertIn("- not looked up by worker: the row lacks a valid worker key", out)
        # With no pr, a lookup by branch is made, and printed as one -- never as the row's.
        self.assertIn("- pr: missing; a lookup by head claude/w-7 lists:\n  - #43 OPEN", out)
        self.assertEqual(self.gh[0][:5], ["pr", "list", "--repo", "o/r", "--head"])

    def test_a_value_outside_its_grammar_is_invalid_and_unused(self) -> None:
        self.board("t7", **self.full(pr="#42", repository="o", worktree="rel/wt", standing="", state="spawned"))
        rc, out, _ = self.takeover()
        self.assertEqual(rc, 0)
        for want in ("- pr: invalid: #42 (not a PR number)", "- repository: invalid: o (not owner/name)",
                     "- worktree: invalid: rel/wt (not an absolute path)",
                     "- standing: invalid:  (empty (write none for no requests))",
                     "- state (another key of the row): spawned", "- not read: the row lacks a valid repository",
                     "- not read: the row lacks a valid worktree or agent_host"):
            self.assertIn(want, out)
        self.assertEqual(self.gh, [])

    def test_requests_are_this_waves_and_this_workers_with_the_rows_ids_beside(self) -> None:
        self.board("t7", **self.full(standing="w-7-iterate gone-id", requests="w-7-leg"))
        self.reserve("w-7-iterate", "w-7")
        self.reserve("w-8-iterate", "w-8")                     # another worker
        self.reserve("x-7-iterate", "w-7", wave="x")           # another wave
        self.reserve("w-7-extra", "w-7")                       # this worker's, not on the row
        self.reserve("w-7-leg", "w-7")
        done = {"request_id": "w-7-leg", "verdict": "pass", "log": "/l", "evidence": "x", "handle": "h",
                "remote_checkout": self.wt, "observed_sha": SHA}
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(registry.run(["-", self.root, "conclude", "coord", "tok", json.dumps(done), "local"]), 0)
        rc, out, _ = self.takeover()
        self.assertEqual(rc, 0)
        section = out.split("### Execution requests\n")[1].split("\n\n")[0]
        self.assertNotIn("w-8-iterate", section)
        self.assertNotIn("x-7-iterate", section)
        self.assertIn("- w-7-extra: launching, correctness, standing, on local", section)
        self.assertIn("outstanding for worker w-7, NOT named on the row", section)
        self.assertIn("- gone-id: named on the row, not in the registry", section)
        self.assertIn("- w-7-leg: concluded pass, correctness, standing, on local", section)

    def test_a_live_branch_that_disagrees_with_the_row_is_a_conflict(self) -> None:
        self.board("t7", **self.full(branch="claude/other"))
        rc, out, _ = self.takeover()
        self.assertEqual(rc, 0)
        self.assertIn("- CONFLICT: the row says branch claude/other, the worktree is on claude/w-7", out)
        self.assertIn("- CONFLICT: the row says branch claude/other, PR #42's head is claude/w-7", out)
        self.assertIn("- branch: claude/other\n", out, "the row's value stands")

    def test_an_unreadable_brief_still_prints_the_state_and_exits_3(self) -> None:
        os.unlink(self.brief)
        self.board("t7", **self.full())
        rc, out, _ = self.takeover()
        self.assertEqual(rc, 3)
        self.assertTrue(out.startswith("## State at takeover"), out)
        self.assertIn(f"- BRIEF UNREADABLE: no readable file {self.brief} on local (this is no takeover brief)", out)
        self.assertIn("### Worktree", out)
        self.board("t8", **self.full(brief="-"))
        rc, out, _ = self.takeover("t8")
        self.assertEqual(rc, 3)
        self.assertIn("- BRIEF UNREADABLE: the row names no brief", out)

    def test_a_gone_worktree_and_an_absent_runs_directory_say_so(self) -> None:
        shutil.rmtree(self.wt)
        self.board("t7", **self.full())
        rc, out, _ = self.takeover()
        self.assertEqual(rc, 0)
        self.assertIn(f"- {self.wt} is gone on local", out)
        self.assertIn(f"- no directory {self.root}/runs on local", out)

    def test_an_unknown_task_or_wave_is_refused(self) -> None:
        self.board("t7", **self.full())
        rc, out, err = self.takeover("t9")
        self.assertEqual((rc, out), (1, ""))
        self.assertIn('BOARD REFUSED: no task "t9" on the board of w', err)
        out_, err_ = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out_), contextlib.redirect_stderr(err_):
            self.assertEqual(takeover.cmd_takeover(self.cfg, ["nowave", "t7"]), 1)

    def test_usage(self) -> None:
        for args in ([], ["w"], ["w", "t", "x"], ["w", ""]):
            with self.assertRaises(cli.Exit) as caught, contextlib.redirect_stderr(io.StringIO()):
                takeover.cmd_takeover(self.cfg, args)
            self.assertEqual(caught.exception.rc, 2, args)


if __name__ == "__main__":
    unittest.main()
