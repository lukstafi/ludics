"""Production runs ``pr-review.sh checks`` and ``merge`` end to end: through
``scripts/py -m ludics.prreview`` and through the shell script's ``main`` (which execs the Python),
with a gh BINARY on PATH that answers by route (tests/fake.py's ``When``) -- no shell
function, no bridge.

The fixture suites (test-pr-review-checks-absent.sh, test-pr-review-merge.sh,
test-pr-review-base-drift.sh) pin the behaviour through the sourced stubs and the shell bridge;
these pin that the forward carries the arguments, the constants and the exits the same way when
gh is whatever is on PATH.

RetryGates exercises the retry exit codes and post-write confirmation paths in-process by
substituting gate, build, lease and API outcomes.
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import unittest
from collections.abc import Sequence
from pathlib import Path
from unittest import mock

from ludics import cli, proc
from ludics.prreview import merge as merge_mod, mergelease
from ludics.prreview.budget import Budget
from ludics.prreview.checkpoint import Post, headed, heading, hold_of, parse_verdict, post_of
from ludics.prreview.clock import FuncClock
from ludics.prreview.core import Config, GhFailed, GhOk, GhSession, GhUnanswered
from ludics.prreview.drift import Drift
from ludics.prreview.gate import load_gate_config
from ludics.prreview.merge import Merge, Options
from ludics.prreview.mergebuild import BuildConfig, BuildVerdict
from ludics.tests.fake import Answer, FakeTool, When

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PY = os.path.join(ROOT, "scripts", "py")
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")

COMPARE = json.dumps({"behind_by": 0, "ahead_by": 1, "merge_base_commit": {"sha": "mb"}, "files": []})
THREADS = json.dumps({"totalCount": 0, "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []})

# A route's matcher: a ``When``, or text needles (``When(text=...)``) that all appear in the call.
Route = tuple[When | list[str], int, str, str]
# The merge call itself, by argv prefix: a read whose arguments merely hold the substrings "pr"
# and "merge" (the merge-build config's path, .github/ship-pr-merge-build) never matches it.
MERGE = When(prefix=("pr", "merge"))

# The reads of one green, clean merge, most specific first (the first route that holds for the
# call answers it): the output each would have printed after its --jq.
GREEN: list[Route] = [
    (MERGE, 0, "", ""),
    # The branch-tip read (branchtip.py, #960): the PR, then the refs API on its head repository.
    ([".head.repo.full_name"], 0, "open\theadsha\ttopic\to/r\n", ""),
    (["repos/o/r/git/ref/heads/topic"], 0, "headsha\n", ""),
    # A --wait's conflict preflight (ludics-lite#729), before the drift read its projection shares
    # a field with.
    (["\\(.mergeable)"], 0, "true\tclean\tmain\n", ""),
    (["mergeable_state"], 0, "main\theadsha\tclean\n", ""),
    (["merged=\\(.merged)"], 0, "merged=true state=closed\theadsha\n", ""),
    ([".updated_at"], 0, "headsha\t2026-09-01T00:00:00Z\tbasesha\ttopic\n", ""),
    (['.base.ref // ""'], 0, "main\n", ""),
    ([".default_branch"], 0, "main\n", ""),
    ([".body"], 0, "Nothing to close.\n", ""),
    ([".commits|tostring"], 0, "1\theadsha\n", ""),
    (["pulls/7/commits"], 0, "headsha\tA commit.\n", ""),
    # No merge-build config: a --wait from a directory that is no clone of o/r reads it (#944).
    (["ship-pr-merge-build"], 1, "", "gh: Not Found (HTTP 404)\n"),
    (["ship-pr-advisory-checks"], 1, "", "gh: Not Found (HTTP 404)\n"),
    (["contents/.github"], 0, "1\nworkflows\n", ""),
    (["check-runs"], 0, "ci\tsuccess\thttps://u\t1\n", ""),
    (["actions/runs?head_sha=headsha"], 0, "2026-09-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tsuccess\t1\n", ""),
    (["(.head.sha", "(.base.sha", "(.head.ref"], 0, "headsha\tbasesha\ttopic\n", ""),
    (["commits/main"], 0, "tipsha\n", ""),
    (["compare/"], 0, COMPARE + "\n", ""),
    (["reviewThreads"], 0, THREADS + "\n", ""),
    # The review checkpoint's posts (checkpoint.py, #1242): none.
    (["issues/7/comments?per_page=100"], 0, "[]\n", ""),
]


class RetryGates(unittest.TestCase):
    def setUp(self) -> None:
        self.session = GhSession(Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0,
                                        api_attempts=1, api_backoff=0))
        self.merge = Merge(self.session, "o/r", "7", load_gate_config({}), FuncClock(), Options("7"))

    def test_a_regate_before_the_first_write_does_not_probe_for_a_landing(self) -> None:
        refusal = cli.Exit(1, "a thread still needs resolution")
        with (
            mock.patch.object(self.merge, "pre_merge_reads", side_effect=[(False, None), refusal]),
            mock.patch.object(self.session, "retry") as retry,
            self.assertRaises(cli.Exit) as caught,
        ):
            self.merge.merge_call(None, None)
        self.assertIs(caught.exception, refusal)
        retry.assert_not_called()

    def test_the_outer_retry_keeps_the_gate_diagnostic_when_rest_cannot_confirm_a_landing(self) -> None:
        for gate_rc, probe, expected_rc in (
            (1, GhOk("false"), 1), (4, GhOk("false"), 4), (5, GhOk("false"), 5),
            (1, GhUnanswered(), 3), (1, GhOk("null"), 3),
        ):
            refusal = cli.Exit(gate_rc, "the retry gate refused")
            with self.subTest(gate_rc=gate_rc, probe=probe):
                with (
                    mock.patch.object(self.merge, "pre_merge_reads", side_effect=[(True, None), refusal]),
                    mock.patch.object(self.session, "retry", side_effect=[GhFailed(), GhOk("true"), probe]) as retry,
                    mock.patch.object(self.session, "err_line", side_effect=[
                        "GraphQL: Pull Request has merge conflicts (mergePullRequest)", "HTTP 503",
                    ]),
                    self.assertRaises(cli.Exit) as caught,
                ):
                    self.merge.merge_call(None, None)
                self.assertEqual(caught.exception.rc, expected_rc)
                self.assertIn(refusal.message, caught.exception.message)
                self.assertEqual(retry.call_count, 3)
                retry.assert_called_with("read", ["api", "repos/o/r/pulls/7", "--jq", ".merged"])
                if expected_rc == gate_rc:
                    self.assertIs(caught.exception, refusal)
                else:
                    self.assertIn("Read the PR's state before re-running merge.", caught.exception.message)

    def _run_merge_in_process(
        self,
        merge: Merge,
        *,
        build: BuildVerdict | None = None,
        judged_head: str = "head-sha",
    ) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()

        def settle_gate() -> None:
            merge.gate.check_sha = judged_head

        with (
            mock.patch.object(merge, "check_checkout"),
            mock.patch.object(merge.multi, "warn"),
            mock.patch.object(merge.gate, "advisory_policy", return_value=0),
            mock.patch.object(merge, "branch_tip_gate"),
            mock.patch.object(merge, "judge", side_effect=settle_gate),
            mock.patch.object(merge, "drift", return_value=Drift(0, "main", judged_head, "b1" * 20)),
            mock.patch.object(merge_mod, "merge_build", return_value=build),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            rc = merge.run()
        return rc, out.getvalue(), err.getvalue()

    def _build_verdict(self, *, fleet_lease: bool = False) -> BuildVerdict:
        cfg = BuildConfig("true", (), trigger="always", fleet_lease=fleet_lease)
        return BuildVerdict("head-sha", "main", "b1" * 20, cfg)

    def test_failed_build_refresh_after_write_confirms_or_keeps_refusal(self) -> None:
        base_moved = "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)"
        build = self._build_verdict()
        next_tip = "b2" * 20
        for rc in (1, 4, 5):
            refusal = cli.Exit(rc, f"refresh build failed ({rc})")
            for mode in ("judged", "unjudged", "unmerged", "unknown"):
                with self.subTest(rc=rc, mode=mode):
                    merge = Merge(self.session, "o/r", "7", load_gate_config({}), FuncClock(), Options("7"))
                    probe = {
                        "judged": GhOk("true"), "unjudged": GhOk("true"),
                        "unmerged": GhOk("false"), "unknown": GhUnanswered(),
                    }[mode]
                    confirm_head = "head-sha" if mode == "judged" else "landed-sha"
                    retry_answers = [GhFailed(), GhOk("head-sha"), probe]
                    if mode in ("judged", "unjudged"):
                        retry_answers.append(GhOk(f"merged=true state=MERGED\t{confirm_head}"))
                    with (
                        mock.patch.object(merge, "pre_merge_reads", side_effect=[(True, None), (True, next_tip)]),
                        mock.patch.object(merge_mod, "refresh_build", side_effect=refusal),
                        mock.patch.object(self.session, "retry", side_effect=retry_answers) as retry,
                        mock.patch.object(self.session, "err_line", side_effect=[base_moved, "HTTP 503"]),
                    ):
                        if mode == "judged":
                            got_rc, stdout, _ = self._run_merge_in_process(merge, build=build)
                            self.assertEqual(got_rc, 0)
                            self.assertIn("o/r#7 merged=true state=MERGED", stdout)
                        else:
                            with self.assertRaises(cli.Exit) as caught:
                                self._run_merge_in_process(merge, build=build)
                            if mode == "unjudged":
                                self.assertEqual(caught.exception.rc, 1)
                                self.assertIn("MERGED at an UNJUDGED head", caught.exception.message)
                            elif mode == "unmerged":
                                self.assertIs(caught.exception, refusal)
                            else:
                                self.assertEqual(caught.exception.rc, 3)
                                self.assertIn("UNKNOWN whether o/r#7 merged", caught.exception.message)
                                self.assertIn(refusal.message, caught.exception.message)
                    merge_calls = [c for c in retry.call_args_list if c.args[1][:2] == ["pr", "merge"]]
                    probe_calls = [c for c in retry.call_args_list if c.args[1][-2:] == ["--jq", ".merged"]]
                    self.assertEqual(len(merge_calls), 1)
                    self.assertEqual(len(probe_calls), 1)

        # Refresh limit after a first write confirms or keeps its refusal too.
        refreshed = [
            BuildVerdict("head-sha", "main", "b2" * 20, build.config),
            BuildVerdict("head-sha", "main", "b3" * 20, build.config),
        ]
        for mode in ("judged", "unmerged"):
            with self.subTest(case="refresh-limit", mode=mode):
                merge = Merge(self.session, "o/r", "7", load_gate_config({}), FuncClock(), Options("7"))
                reads = [(True, "b2" * 20), (True, "b3" * 20), (True, None), (True, "b4" * 20)]
                retry_answers = [GhFailed(), GhOk("head-sha"), GhOk("true" if mode == "judged" else "false")]
                if mode == "judged":
                    retry_answers.append(GhOk("merged=true state=MERGED\thead-sha"))
                with (
                    mock.patch.object(merge, "pre_merge_reads", side_effect=reads),
                    mock.patch.object(merge_mod, "refresh_build", side_effect=refreshed),
                    mock.patch.object(self.session, "retry", side_effect=retry_answers) as retry,
                    mock.patch.object(self.session, "err_line", return_value=base_moved),
                ):
                    if mode == "judged":
                        got_rc, stdout, _ = self._run_merge_in_process(merge, build=build)
                        self.assertEqual(got_rc, 0)
                        self.assertIn("o/r#7 merged=true state=MERGED", stdout)
                    else:
                        with self.assertRaises(cli.Exit) as caught:
                            self._run_merge_in_process(merge, build=build)
                        self.assertEqual(caught.exception.rc, 1)
                        self.assertIn("refresh limit", caught.exception.message)
                probe_calls = [c for c in retry.call_args_list if c.args[1][-2:] == ["--jq", ".merged"]]
                self.assertEqual(len(probe_calls), 1)

        # Negative controls: before any write, or rc 2 (config/clone error) after a write, never probes REST.
        for case, reads, retry_side, refusal in (
            ("before-write", [(True, next_tip)], [], cli.Exit(1, "initial refresh failed")),
            ("rc-2-after-write", [(True, None), (True, next_tip)], [GhFailed(), GhOk("head-sha")], cli.Exit(2, "shallow clone")),
        ):
            with self.subTest(control=case):
                merge = Merge(self.session, "o/r", "7", load_gate_config({}), FuncClock(), Options("7"))
                with (
                    mock.patch.object(merge, "pre_merge_reads", side_effect=reads),
                    mock.patch.object(merge_mod, "refresh_build", side_effect=refusal),
                    mock.patch.object(self.session, "retry", side_effect=retry_side) as retry,
                    mock.patch.object(self.session, "err_line", return_value=base_moved),
                    self.assertRaises(cli.Exit) as caught,
                ):
                    self._run_merge_in_process(merge, build=build)
                self.assertIs(caught.exception, refusal)
                probe_calls = [c for c in retry.call_args_list if c.args[1][-2:] == ["--jq", ".merged"]]
                self.assertEqual(probe_calls, [])

    def test_dispatch_time_lease_refusal_after_write_confirms_or_keeps_refusal(self) -> None:
        base_moved = "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)\n"
        gateway_503 = "gh: HTTP 503: Service Unavailable\n"
        build = self._build_verdict(fleet_lease=True)

        def run_lease_race(
            *,
            site: str,
            mode: str,
            forwarded: bool = False,
        ) -> tuple[int | None, cli.Exit | None, str, list[list[str]], list[object]]:
            clock = mock.Mock(return_value=10.0)
            budget = mock.Mock(spec=Budget)
            write_gates = 0

            def gate(kind: str) -> None:
                nonlocal write_gates
                if kind == "write":
                    write_gates += 1
                    if site == "before-write-dispatch" and write_gates == 1:
                        clock.return_value = 10.0 + mergelease.TTL
                    elif site in ("outer-dispatch", "resend-dispatch") and write_gates == 2:
                        clock.return_value = 10.0 + mergelease.TTL

            budget.gate.side_effect = gate
            gh_calls: list[list[str]] = []

            def run_gh(name: str, args: Sequence[str]) -> proc.Completed:
                self.assertEqual(name, "gh")
                argv = list(args)
                gh_calls.append(argv)
                if argv[:2] == ["pr", "merge"]:
                    return proc.Completed(1, "", gateway_503 if site == "resend-dispatch" else base_moved)
                if argv[-2:] == ["--jq", '.head.sha // "-"']:
                    return proc.Completed(0, "head-sha\n", "")
                if argv[-2:] == ["--jq", ".merged"]:
                    if mode == "unknown":
                        return proc.Completed(1, "", gateway_503)
                    return proc.Completed(0, "true\n" if mode in ("judged", "unjudged") else "false\n", "")
                if argv[-2] == "--jq" and "merged=" in argv[-1]:
                    head = "head-sha" if mode == "judged" else "landed-sha"
                    return proc.Completed(0, f"merged=true state=MERGED\t{head}\n", "")
                raise AssertionError(f"unexpected gh call: {argv}")

            cfg = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0,
                         api_attempts=2 if site == "resend-dispatch" else 1, api_backoff=0)
            session = GhSession(cfg, run=run_gh, sleep=lambda _s: None, budget=budget)
            opts = Options("7", gh_args=["--merge"], forwarded=forwarded)
            merge = Merge(session, "o/r", "7", load_gate_config({}), FuncClock(), opts)
            pre_reads = 0

            def fake_pre_reads(
                active_build: BuildVerdict | None, active_lease: mergelease.MergeLease | None, *, resend: bool,
            ) -> tuple[bool, str | None]:
                nonlocal pre_reads
                pre_reads += 1
                self.assertIsNotNone(active_build)
                assert active_lease is not None
                active_lease.verify()
                if site == "before-write-call" and pre_reads == 1:
                    clock.return_value = 10.0 + mergelease.TTL
                elif site == "outer-call" and pre_reads == 2 and not resend:
                    clock.return_value = 10.0 + mergelease.TTL
                return True, None

            lease_replies = ["taken\n", "renewed\n", "renewed\n", "released\n"]
            if site.startswith("before-write"):
                lease_replies = ["taken\n", "renewed\n", "released\n"]
            with (
                mock.patch.dict(os.environ, {"FLEET_ANCHOR": "local"}),
                mock.patch.object(mergelease, "_lease_time", clock),
                mock.patch.object(mergelease.MergeLease, "_call", side_effect=lease_replies) as lease_call,
                mock.patch.object(merge, "pre_merge_reads", side_effect=fake_pre_reads),
            ):
                os.environ.pop("FLEET_REGISTRY_PIN", None)
                try:
                    rc, stdout, _ = self._run_merge_in_process(merge, build=build)
                except cli.Exit as exc:
                    return None, exc, "", gh_calls, list(lease_call.call_args_list)
                return rc, None, stdout, gh_calls, list(lease_call.call_args_list)

        for site in ("outer-call", "outer-dispatch", "resend-dispatch"):
            forwarded_cases = (False, True) if site.endswith("dispatch") else (False,)
            for forwarded in forwarded_cases:
                for mode in ("judged", "unjudged", "unmerged", "unknown"):
                    with self.subTest(site=site, forwarded=forwarded, mode=mode):
                        rc, exc, stdout, calls, lease_calls = run_lease_race(site=site, mode=mode, forwarded=forwarded)
                        self.assertEqual(len([c for c in calls if c[:2] == ["pr", "merge"]]), 1)
                        probes = [c for c in calls if c[-2:] == ["--jq", ".merged"]]
                        self.assertEqual(len(probes), 2 if (site == "resend-dispatch" and mode == "unknown") else 1)
                        self.assertEqual(lease_calls[-1], mock.call("release"))
                        if mode == "judged":
                            self.assertEqual((rc, exc), (0, None))
                            self.assertIn("o/r#7 merged=true state=MERGED", stdout)
                        else:
                            assert exc is not None
                            if mode == "unjudged":
                                self.assertEqual(exc.rc, 1)
                                self.assertIn("MERGED at an UNJUDGED head", exc.message)
                            elif mode == "unmerged":
                                self.assertEqual(exc.rc, 3)
                                self.assertIn("merge lease ownership expired or was lost", exc.message)
                                self.assertNotIn("UNKNOWN whether", exc.message)
                            else:
                                self.assertEqual(exc.rc, 3)
                                self.assertIn("UNKNOWN whether o/r#7 merged", exc.message)
                                expected_action = (
                                    "the resend of a merge request the gateway refused"
                                    if site == "resend-dispatch"
                                    else "the retry of a refused merge request"
                                )
                                self.assertIn(expected_action, exc.message)
                                self.assertIn("merge lease ownership expired or was lost", exc.message)

        # Negative controls: dispatch-time lease refusal before the first merge write never probes REST.
        for site in ("before-write-call", "before-write-dispatch"):
            with self.subTest(control=site):
                rc, exc, _, calls, lease_calls = run_lease_race(site=site, mode="judged")
                self.assertIsNone(rc)
                assert exc is not None
                self.assertEqual(exc.rc, 3)
                self.assertIn("merge lease ownership expired or was lost", exc.message)
                self.assertEqual(calls, [])
                self.assertEqual(lease_calls[-1], mock.call("release"))

    def test_absent_retry_limit_after_write_confirms_or_keeps_refusal(self) -> None:
        conflict = "GraphQL: Pull Request has merge conflicts (mergePullRequest)"
        for mode in ("judged", "unjudged", "unmerged", "unknown"):
            with self.subTest(mode=mode):
                merge = Merge(self.session, "o/r", "7", load_gate_config({}), FuncClock(), Options("7"))
                probe = {
                    "judged": GhOk("true"), "unjudged": GhOk("true"),
                    "unmerged": GhOk("false"), "unknown": GhUnanswered(),
                }[mode]
                confirm_head = "head-sha" if mode == "judged" else "landed-sha"
                retry_answers = [GhFailed(), GhOk("true"), probe]
                if mode in ("judged", "unjudged"):
                    retry_answers.append(GhOk(f"merged=true state=MERGED\t{confirm_head}"))
                with (
                    mock.patch.object(merge, "pre_merge_reads", side_effect=[(True, None), (False, None), (False, None)]),
                    mock.patch.object(self.session, "retry", side_effect=retry_answers) as retry,
                    mock.patch.object(self.session, "err_line", side_effect=[conflict, "HTTP 503"]),
                ):
                    if mode == "judged":
                        got_rc, stdout, _ = self._run_merge_in_process(merge)
                        self.assertEqual(got_rc, 0)
                        self.assertIn("o/r#7 merged=true state=MERGED", stdout)
                    else:
                        with self.assertRaises(cli.Exit) as caught:
                            self._run_merge_in_process(merge)
                        if mode == "unjudged":
                            self.assertEqual(caught.exception.rc, 1)
                            self.assertIn("MERGED at an UNJUDGED head", caught.exception.message)
                        elif mode == "unmerged":
                            self.assertEqual(caught.exception.rc, 1)
                            self.assertIn("base kept moving under its ABSENT verdict (3 gate reads)", caught.exception.message)
                        else:
                            self.assertEqual(caught.exception.rc, 3)
                            self.assertIn("UNKNOWN whether o/r#7 merged", caught.exception.message)
                            self.assertIn("base kept moving under its ABSENT verdict (3 gate reads)", caught.exception.message)
                merge_calls = [c for c in retry.call_args_list if c.args[1][:2] == ["pr", "merge"]]
                probe_calls = [c for c in retry.call_args_list if c.args[1][-2:] == ["--jq", ".merged"]]
                self.assertEqual(len(merge_calls), 1)
                self.assertEqual(len(probe_calls), 1)

        # Negative control: hitting the ABSENT retry limit before any merge write never probes REST.
        merge = Merge(self.session, "o/r", "7", load_gate_config({}), FuncClock(), Options("7"))
        with (
            mock.patch.object(merge, "pre_merge_reads", side_effect=[(False, None), (False, None), (False, None)]),
            mock.patch.object(self.session, "retry") as retry,
            self.assertRaises(cli.Exit) as caught,
        ):
            self._run_merge_in_process(merge)
        self.assertEqual(caught.exception.rc, 1)
        self.assertIn("base kept moving under its ABSENT verdict (3 gate reads)", caught.exception.message)
        retry.assert_not_called()


class Production(unittest.TestCase):
    def setUp(self) -> None:
        self.gh = FakeTool("gh")
        self.gh.route()  # until a test routes, every call is refused
        self.dir = self.gh.dir

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def route(self, routes: Sequence[Route]) -> None:
        self.gh.route(*((w if isinstance(w, When) else When(text=tuple(w)), Answer(rc, out, err))
                        for w, rc, out, err in routes))

    def calls(self) -> list[list[str]]:
        return self.gh.calls()

    def run_cmd(self, entry: list[str], *args: str, cwd: str | None = None, **env: str) -> subprocess.CompletedProcess[str]:
        environ = {k: v for k, v in os.environ.items() if not k.startswith(("SHIP_PR_", "LUDICS_"))}
        environ.update({"PATH": self.dir + os.pathsep + os.environ.get("PATH", ""), "REPO": "",
                        "SHIP_PR_API_ATTEMPTS": "1", "SHIP_PR_API_BACKOFF": "0",
                        "SHIP_PR_STATE_DIR": os.path.join(self.dir, "state"), **env})
        return subprocess.run([*entry, *args], capture_output=True, text=True, env=environ, cwd=cwd or self.dir, check=False)

    def entries(self) -> list[list[str]]:
        return [[PY, "-m", "ludics.prreview"], [PR_REVIEW]]

    def test_a_green_head_merges_bound_to_the_gated_head(self) -> None:
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertIn("build signal o/r#7 @headsha: green — 1 build checks passed", done.stdout)
                self.assertIn("base-drift file overlap o/r#7: none", done.stdout)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)
                merges = [c for c in self.calls() if c[:2] == ["pr", "merge"]]
                self.assertEqual(merges, [["pr", "merge", "7", "--repo", "o/r", "--match-head-commit", "headsha", "--merge"]])

    def test_a_forwarded_gateway_resend_rechecks_before_sending_the_same_arguments(self) -> None:
        self.route([(MERGE, 1, "", "gh: HTTP 503: Service Unavailable\n"), *GREEN])
        done = self.run_cmd(self.entries()[0], "merge", "o/r#7", "--", "--merge", SHIP_PR_API_ATTEMPTS="2")
        self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
        calls = self.calls()
        first, second = [i for i, args in enumerate(calls) if args[:2] == ["pr", "merge"]]
        self.assertEqual(calls[first], calls[second])
        rereads = calls[first + 1 : second]
        self.assertTrue(any("reviewThreads" in arg for args in rereads for arg in args), rereads)
        self.assertEqual(rereads[-1][1], "repos/o/r/git/ref/heads/topic")
        self.assertEqual(rereads, calls[first - len(rereads) : first])

    def test_a_blocking_checkpoint_holds_the_merge_and_an_override_posts_first(self) -> None:
        hexed: list[Route] = [(w if isinstance(w, When) else [n.replace("headsha", H) for n in w], rc, out.replace("headsha", H), err)
                              for w, rc, out, err in GREEN]
        comments = (["issues/7/comments?per_page=100"], 0, json.dumps([posted("at-open", "aaaaaaaa", BLOCKING)]) + "\n", "")
        post = (When(prefix=("api", "-X", "POST")), 0, "https://github.com/o/r/pull/7#issuecomment-9\n", "")
        for entry in self.entries():
            with self.subTest(entry=entry[0], case="held"):
                self.route([comments, *hexed])
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn(f"REFUSING to merge o/r#7 at {H[:8]}: the review checkpoint holds it", done.stderr)
                self.assertIn(f"CONFIRM_REQUEST 7 {H}", done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], case="over"):
                self.route([post, comments, *hexed])
                done = self.run_cmd(entry, "merge", "o/r#7", "--over-checkpoint", "the maintainer cleared it")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                writes = [i for i, c in enumerate(self.calls()) if c[:3] == ["api", "-X", "POST"] or c[:2] == ["pr", "merge"]]
                self.assertEqual([self.calls()[i][:2] for i in writes], [["api", "-X"], ["pr", "merge"]], "the post, then the merge")
                body = [a for a in self.calls()[writes[0]] if a.startswith("body=")][0]
                self.assertIn("the maintainer cleared it", body)
            with self.subTest(entry=entry[0], case="cleared"):
                cleared = json.dumps([posted("at-open", "aaaaaaaa", BLOCKING), posted("confirm", H, "VERDICT: clean")])
                self.route([(["issues/7/comments?per_page=100"], 0, cleared + "\n", ""), *hexed])
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def _tip_answers(self, rc: int, out: str, err: str = "") -> list[Route]:
        """GREEN with the refs read answering otherwise."""
        return [(["repos/o/r/git/ref/heads/topic"], rc, out, err), *GREEN]

    def test_a_head_that_is_not_the_branchs_is_never_merged(self) -> None:
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(self._tip_answers(0, "pushedsha\n"))
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("headsha is NOT its branch's tip", done.stderr)
                self.assertIn("topic on o/r stands at pushedsha", done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])

    def test_an_unread_tip_never_merges_and_a_deleted_branch_is_a_fact(self) -> None:
        for rc, err, want in ((1, "gh: 503 No server is currently available to service your request\n", 3),
                              (1, "gh: Not Found (HTTP 404)\n", 1)):
            with self.subTest(want=want):
                self.route(self._tip_answers(rc, "", err))
                done = self.run_cmd([PY, "-m", "ludics.prreview"], "merge", "o/r#7")
                self.assertEqual(done.returncode, want, done.stdout + done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])

    def test_a_tip_read_of_an_unknown_shape_is_not_agreement(self) -> None:
        self.route([([".head.repo.full_name"], 0, "open\theadsha\ttopic\tno-such-shape\n", ""), *GREEN])
        done = self.run_cmd([PY, "-m", "ludics.prreview"], "merge", "o/r#7")
        self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
        self.assertIn("UNREAD", done.stderr)

    def test_a_branch_that_prefixes_another_is_read_exactly(self) -> None:
        self.route(GREEN)
        done = self.run_cmd([PY, "-m", "ludics.prreview"], "merge", "o/r#7")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        reads = [c for c in self.calls() if any("git/ref" in a for a in c)]
        self.assertTrue(reads)
        self.assertTrue(all("repos/o/r/git/ref/heads/topic" in c for c in reads), reads)
        self.assertFalse(any("matching-refs" in a for c in self.calls() for a in c))

    def test_a_pr_merged_at_another_head_is_not_this_merge(self) -> None:
        """ludics#823: gh finds the PR already merged, makes no merge request and exits 0 with its
        warning on stderr (gh v2.101.0); the merged head decides, not gh's exit."""
        merged_elsewhere = [(MERGE, 0, "", "! Pull request o/r#7 was already merged\n"), *GREEN]
        at_another = [(["merged=\\(.merged)"], 0, "merged=true state=closed\tlandedsha\n", ""), *merged_elsewhere]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(at_another)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("o/r#7 is MERGED at an UNJUDGED head landedsh (the gate judged headsha)", done.stderr)
                self.route(merged_elsewhere)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)

    def test_a_timed_out_merge_call_is_ambiguous_and_never_re_sent(self) -> None:
        """#708: a 504 is the gateway giving up on a backend that may have merged the PR."""
        timed_out = [(MERGE, 1, "", "HTTP 504 (https://api.github.com/graphql)\n"), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(timed_out)
                done = self.run_cmd(entry, "merge", "o/r#7", SHIP_PR_API_ATTEMPTS="3")
                self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
                self.assertIn("gh pr merge failed AMBIGUOUSLY: HTTP 504", done.stderr)
                self.assertIn("It may have LANDED", done.stderr)
                self.assertEqual(len([c for c in self.calls() if c[:2] == ["pr", "merge"]]), 1)

    def test_graphqls_merge_conflicts_answer_is_a_conflict(self) -> None:
        """#1244: GitHub's GraphQL answer to merging a conflicting PR says no merge happened, so it
        takes the mergeable-field re-read (false: bring the base in), never the ambiguous exit 3."""
        conflict = [
            (MERGE, 1, "", "GraphQL: Pull Request has merge conflicts (mergePullRequest)\n"),
            ([".mergeable | tostring"], 0, "false\n", ""),
            *GREEN,
        ]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(conflict)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("really does not merge cleanly (mergeable=false after the recompute)", done.stderr)
                self.assertNotIn("AMBIGUOUSLY", done.stderr)
                self.assertEqual(len([c for c in self.calls() if c[:2] == ["pr", "merge"]]), 1)

    def test_merge_refusals_read_only_the_whole_first_stderr_line(self) -> None:
        conflict = "GraphQL: Pull Request has merge conflicts (mergePullRequest)\n"
        unknown = "GraphQL: Could not read the head commit. (mergePullRequest)\n"
        for out, err in ((conflict, unknown), ("", unknown + conflict)):
            with self.subTest(out=out, err=err):
                self.route([(MERGE, 1, out, err), *GREEN])
                done = self.run_cmd(self.entries()[0], "merge", "o/r#7")
                self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
                self.assertIn(f"gh pr merge failed AMBIGUOUSLY: {unknown.strip()}", done.stderr)
                self.assertEqual(self.calls()[-1][:2], ["pr", "merge"])
                self.assertEqual(len([c for c in self.calls() if c[:2] == ["pr", "merge"]]), 1)

    def test_merge_requests_plain_gh_output_even_when_color_is_forced(self) -> None:
        gh = Path(self.dir, "gh")
        plain = gh.rename(gh.with_name("gh-plain"))
        refusal = "X Pull request o/r#7 is not mergeable: the merge commit cannot be cleanly created.\n"
        coloured = "\x1b[31mX\x1b[0m" + refusal[1:]
        gh.write_text(
            f"#!{sys.executable}\n"
            "import os, sys\n"
            'if sys.argv[1:3] == ["pr", "merge"] and not os.getenv("NO_COLOR"):\n'
            f"    sys.stderr.write({coloured!r})\n"
            "    sys.exit(1)\n"
            f"os.execv(sys.executable, [sys.executable, {str(plain)!r}, *sys.argv[1:]])\n",
            encoding="utf-8",
        )
        gh.chmod(0o755)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route([(MERGE, 1, "", refusal), ([".mergeable | tostring"], 0, "false\n", ""), *GREEN])
                done = self.run_cmd(entry, "merge", "o/r#7", CLICOLOR_FORCE="1", NO_COLOR="")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("really does not merge cleanly", done.stderr)

    def test_checks_ends_with_its_trailer_and_a_red_is_one(self) -> None:
        red = [(["check-runs"], 0, "ci\tfailure\thttps://u\t1\n", ""), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(GREEN)
                done = self.run_cmd(entry, "checks", "o/r#7")
                self.assertEqual((done.returncode, done.stdout.splitlines()[-1]), (0, "checks: verdict=green branch=current"))
                self.route(red)
                done = self.run_cmd(entry, "checks", "o/r#7")
                self.assertEqual((done.returncode, done.stdout.splitlines()[-1]), (1, "checks: verdict=red branch=current"))
                self.assertIn("  RED      ci (failure)  https://u", done.stdout)

    def test_the_variable_list_is_the_callers_and_skips_the_file(self) -> None:
        red_claude = [(["check-runs"], 0, "claude\tfailure\tu\t1\nci\tsuccess\tu\t1\n", ""), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(red_claude)
                done = self.run_cmd(entry, "checks", "o/r#7", SHIP_PR_ADVISORY_CHECKS="^macos$")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertFalse(any("ship-pr-advisory-checks" in " ".join(c) for c in self.calls()))

    def test_usage_errors(self) -> None:
        self.route(GREEN)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                done = self.run_cmd(entry, "merge", "o/r#7", "--override", "yes")
                self.assertEqual(done.returncode, 2)
                self.assertIn("--override takes a REASON in words, not 'yes'", done.stderr)
                done = self.run_cmd(entry, "checks", "o/r#7", "--wait=soon")
                self.assertEqual(done.returncode, 2)
                done = self.run_cmd(entry, "merge", "7")
                self.assertEqual(done.returncode, 2, "a bare number with no repo is refused")
                self.assertEqual(self.calls(), [], "and nothing is read")
                # --rerun-failed-once (#1065): waited for, and never beside an override or an unread merge.
                for extra, says in (
                    ([], "needs a --wait of more than 0 seconds"),
                    (["--wait=0"], "needs a --wait of more than 0 seconds"),
                    (["--wait", "--override", "the red is the base's own"], "cannot be combined with --override"),
                    (["--wait", "--allow-no-verdict"], "cannot be combined with --allow-no-verdict"),
                ):
                    done = self.run_cmd(entry, "merge", "o/r#7", "--rerun-failed-once", *extra)
                    self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                    self.assertIn(says, done.stderr)
                    self.assertEqual(self.calls(), [], "and nothing is read")

    def test_a_checkout_is_checked_before_anything_is_read(self) -> None:
        """``merge -C <dir>`` (ludics-lite#730): the merge build's clone, read first -- a directory
        inside a git checkout with a remote naming the PR's repository, or exit 2 with nothing read."""
        remote = os.path.join(self.dir, "remotes", "o", "r.git")
        other = os.path.join(self.dir, "remotes", "o", "other.git")
        for bare in (remote, other):
            subprocess.run(["git", "init", "-q", "-b", "main", "--bare", bare], check=True)
        clone = os.path.join(self.dir, "clone")
        stranger = os.path.join(self.dir, "stranger")
        subprocess.run(["git", "clone", "-q", remote, clone], check=True, capture_output=True)
        subprocess.run(["git", "clone", "-q", other, stranger], check=True, capture_output=True)
        plain = os.path.join(self.dir, "plain")
        os.mkdir(plain)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                for where, says in (
                    (os.path.join(self.dir, "missing"), "is not a directory inside a git checkout"),
                    (plain, "is not a directory inside a git checkout"),
                    (stranger, "has no remote naming o/r"),
                ):
                    self.route(GREEN)
                    done = self.run_cmd(entry, "merge", "o/r#7", "-C", where, "--wait=60")
                    self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                    self.assertIn(says, done.stderr)
                    self.assertEqual(self.calls(), [], "nothing was read")
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7", "-C")
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("-C needs a directory", done.stderr)
                done = self.run_cmd(entry, "merge", "o/r#7", "-C", os.path.join(clone, "."))
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)
                # -C before the PR, as `git -C` takes it (wave-20261031 post-1-task-16): the same
                # reading, the stranger refused before anything is read and the clone merged.
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "-C", stranger, "o/r#7", "--wait=60")
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("has no remote naming o/r", done.stderr)
                self.assertEqual(self.calls(), [], "nothing was read, -C first")
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "-C", os.path.join(clone, "."), "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)
                done = self.run_cmd(entry, "merge", "-C", clone)
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("usage: merge <pr>", done.stdout + done.stderr)

    def test_an_empty_wait_is_no_wait(self) -> None:
        # The shell's `--wait=` set wait_for to '' and its arithmetic read that as 0.
        self.route(GREEN)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                done = self.run_cmd(entry, "checks", "o/r#7", "--wait=")
                self.assertEqual((done.returncode, done.stdout.splitlines()[-1]), (0, "checks: verdict=green branch=current"))

    def test_an_override_is_announced_only_before_the_merge_call(self) -> None:
        # ludics-lite#684's negative control: "OVERRIDE: merging" printed at the verdict stood above
        # the refusals that followed it. Each refusal after the gate says nothing of merging over it.
        why = "base red, not this PR: ci, test t, red at basesha; owned by o/r#1"
        red_run = (["actions/runs?head_sha=headsha"], 0,
                   "2026-09-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tfailure\t1\n", "")
        # A close-out's reads of the merge queue: the base, and no queue on it.
        no_queue = [(["mergeQueue"], 0, "\n", ""), (["--jq .base.ref"], 0, "main\n", "")]
        beside_green = [(["check-runs"], 0, "ci\tfailure\tu\t1\nlint\tsuccess\tu\t1\n", ""), red_run, *no_queue, *GREEN]
        red_alone = [(["check-runs"], 0, "ci\tfailure\tu\t1\n", ""), red_run, *no_queue, *GREEN]
        threads_unread = [(["reviewThreads"], 1, "", "gh: Bad Gateway (HTTP 502)\n"), *beside_green]
        for entry in self.entries():
            with self.subTest(entry=entry[0], refusal="require-green"):
                self.route(red_alone)
                done = self.run_cmd(entry, "merge", "o/r#7", "--require-green", "--override", why)
                self.assertEqual(done.returncode, 4, done.stdout + done.stderr)
                self.assertIn("beside the red --override waived", done.stderr)
                self.assertNotIn("OVERRIDE: merging", done.stdout + done.stderr)
            with self.subTest(entry=entry[0], refusal="threads"):
                self.route(threads_unread)
                done = self.run_cmd(entry, "merge", "o/r#7", "--override", why)
                self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
                self.assertIn("whether review threads are still open is UNKNOWN", done.stderr)
                self.assertNotIn("OVERRIDE: merging", done.stdout + done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], refusal="none"):
                self.route(beside_green)
                done = self.run_cmd(entry, "merge", "o/r#7", "--require-green", "--override", why)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                lines = done.stdout.splitlines()
                said = lines.index(f"OVERRIDE: merging o/r#7 over a RED build signal — {why}")
                self.assertLess(lines.index("base-drift file overlap o/r#7: none"), said, done.stdout)
                self.assertEqual(lines[said + 1:], ["o/r#7 merged=true state=closed"], "said once, then merged")
                self.assertEqual(done.stderr.count("OVERRIDE: merging o/r#7 over "), 1, done.stderr)

    def test_a_wait_refuses_a_conflict_before_reading_the_build(self) -> None:
        # ludics-lite#729: a conflicting PR is refused at the start of `merge --wait`, exit 1, with
        # the rebase hint; a clean one is read once and merges; a merge with no wait reads nothing.
        conflict = [(["\\(.mergeable)"], 0, "false\tdirty\tmain\n", ""), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0], pr="conflicting"):
                self.route(conflict)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("REFUSING to merge o/r#7 before the wait: it CONFLICTS with its base", done.stderr)
                self.assertIn("Merge or rebase origin/main in", done.stderr)
                self.assertFalse(any("check-runs" in " ".join(c) for c in self.calls()), "the gate read nothing")
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], pr="no wait"):
                self.route(conflict)
                self.run_cmd(entry, "merge", "o/r#7")
                self.assertFalse(any("\\(.mergeable)" in " ".join(c) for c in self.calls()))
            with self.subTest(entry=entry[0], pr="clean"):
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertEqual(sum("\\(.mergeable)" in " ".join(c) for c in self.calls()), 1)

    def test_a_wait_from_no_clone_refuses_before_the_wait_when_the_repository_builds(self) -> None:
        """#944: ``merge --wait`` without ``-C``, run where no checkout has a remote naming o/r, while
        o/r's default branch has a merge-build config: exit 2 before the gate reads anything, naming
        ``-C``. No config (a 404) waits and merges as before; a clone of o/r as the working directory
        reads no config before the gate; no --wait reads nothing early. After the gate the build
        step reads the config on every merge (its trigger may be ``always``), so an unread one is
        then exit 3, and a config whose trigger does not hold builds nothing and needs no clone."""
        # The preflight does not read the body's grammar: this one has a line the build step refuses.
        config = [(["ship-pr-merge-build"], 0, "command sh ./build.sh\ninputs *.ml\n", ""), *GREEN]
        valid = [(["ship-pr-merge-build"], 0, "command sh ./build.sh\ninput *.ml\n", ""), *GREEN]
        unread = [(["ship-pr-merge-build"], 1, "", "gh: Service Unavailable (HTTP 503)\n"), *GREEN]
        remote = os.path.join(self.dir, "remotes", "o", "r.git")
        subprocess.run(["git", "init", "-q", "-b", "main", "--bare", remote], check=True)
        clone = os.path.join(self.dir, "clone")
        subprocess.run(["git", "clone", "-q", remote, clone], check=True, capture_output=True)

        def gated(calls: list[list[str]]) -> bool:
            return any("check-runs" in " ".join(c) for c in calls)

        def config_reads(calls: list[list[str]]) -> list[int]:
            return [i for i, c in enumerate(calls) if "ship-pr-merge-build" in " ".join(c)]

        def gate_read(calls: list[list[str]]) -> int:
            return next(i for i, c in enumerate(calls) if "check-runs" in " ".join(c))

        for entry in self.entries():
            with self.subTest(entry=entry[0], config="present"):
                self.route(config)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("REFUSING to merge o/r#7 before the wait: o/r's .github/ship-pr-merge-build", done.stderr)
                self.assertIn("does not run inside a git checkout", done.stderr)
                self.assertIn("name one with -C <clone>", done.stderr)
                self.assertFalse(gated(self.calls()), "the gate read nothing")
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], config="present, from a clone"):
                self.route(valid)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30", cwd=clone)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                reads = config_reads(self.calls())
                self.assertEqual(len(reads), 1, "the build step's read alone")
                self.assertGreater(reads[0], gate_read(self.calls()), "after the gate, never before the wait")
                self.assertIn("changed no path since their merge base, so no build is possible", done.stdout)
            if entry != self.entries()[0]:
                continue  # The rest is the Python's alone; the forward is pinned by the two above.
            with self.subTest(entry=entry[0], config="absent"):
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertEqual(len(config_reads(self.calls())), 2, "before the wait, and at the build step")
            with self.subTest(entry=entry[0], config="unread"):
                self.route(unread)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
                self.assertIn("could not be read before the wait", done.stderr)
                self.assertIn("Whether the merge needs a build is UNKNOWN", done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], config="present, no wait"):
                self.route(valid)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                reads = config_reads(self.calls())
                self.assertEqual(len(reads), 1, "the build step's read alone")
                self.assertGreater(reads[0], gate_read(self.calls()), "nothing is read early")
            with self.subTest(entry=entry[0], config="unparseable, no wait"):
                self.route(config)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("is not a merge-build config", done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])


H = "1f230a8f" + "5" * 32  # a hex head: a checkpoint heading names its sha8


def posted(kind: str, head: str, verdict: str, label: str = "Claude Opus 5.5 review checkpoint") -> dict[str, str]:
    """A checkpoint post as ``wave review`` writes it (checkpoint.py's THE POSTED FORM)."""
    return {"html_url": f"https://github.com/o/r/pull/7#{kind}-{head[:8]}",
            "body": f"{heading(kind, head)}\n\nA finding.\n\n{verdict}\n\n(Posted by the wave coordinator, {label})"}


BLOCKING = "VERDICT: blocking (1 blocking, 0 suggestions)"


class Checkpoint(unittest.TestCase):
    """checkpoint.py's boundary and hold, on posts alone (ludics#1242)."""

    def posts(self, *comments: dict[str, str]) -> list[Post]:
        return [p for c in comments if (p := post_of(c["html_url"], c["body"])) is not None]

    def test_the_posted_form_reads_and_nothing_else_is_a_post(self) -> None:
        post = post_of("u", posted("at-open", H, BLOCKING)["body"])
        assert post is not None
        self.assertEqual((post.kind, post.head, post.verdict.blocking), ("at-open", H[:8], 1))
        self.assertIsNone(post_of("u", "### Review checkpoint (at-open): head 1f230a8f\n\n" + BLOCKING
                                  + "\n\n(Posted by the wave coordinator, Claude Opus 5.5)"), "another coordinator post")
        self.assertIsNone(post_of("u", heading("at-open", H) + "\n\n" + BLOCKING), "no footer")
        self.assertIsNone(post_of("u", ""), "an empty body")
        odd = post_of("u", posted("at open", H, "VERDICT: clean")["body"])
        assert odd is not None
        self.assertEqual((odd.kind, odd.at_open, odd.blocks), ("", True, True), "an unreadable heading is a blocking at-open")
        self.assertTrue(self.posts(posted("at-open", H, "VERDICT: fine"))[0].verdict.blocks, "an unreadable verdict blocks")
        self.assertEqual(parse_verdict("x\nVERDICT: clean\n").word, "clean", "wavereview's grammar, shared")

    def test_wave_review_writes_the_heading_and_counts_are_bounded(self) -> None:
        mine = heading("confirm", H)
        self.assertEqual(headed("confirm", H, f"\n{mine}\n\nOK.\n\nVERDICT: clean\n"), f"{mine}\n\nOK.\n\nVERDICT: clean\n")
        wrong = headed("confirm", H, "### Review checkpoint (at-open): head aaaaaaaa\n\nVERDICT: clean\n")
        post = post_of("u", wrong + "\n(Posted by the wave coordinator, Claude Opus 5.5 review checkpoint)")
        assert post is not None
        self.assertEqual((post.kind, post.head), ("confirm", H[:8]), "the reviewed kind and head, not the reviewer's typing")
        self.assertEqual(parse_verdict("VERDICT: blocking (999999999 blocking, 0 suggestions)").blocking, 999999999)
        for count in ("1" * 10, "1" * 5000):
            with self.subTest(digits=len(count)):
                self.assertEqual(parse_verdict(f"VERDICT: blocking ({count} blocking, 0 suggestions)").word, "unreadable")

    def test_the_hold(self) -> None:
        at_open, older = posted("at-open", "aaaaaaaa", BLOCKING), "0123abcd" + "0" * 32
        cases: list[tuple[str, list[dict[str, str]], bool]] = [
            ("no post", [], False),
            ("a non-blocking at-open", [posted("at-open", "aaaaaaaa", "VERDICT: suggestions (0 blocking, 1 suggestions)")], False),
            ("blocking, no confirm", [at_open], True),
            ("a clearing confirm for this head", [at_open, posted("confirm", H, "VERDICT: clean")], False),
            ("a clearing confirm for an older head", [at_open, posted("confirm", older, "VERDICT: clean")], True),
            ("a blocking confirm for this head", [at_open, posted("confirm", H, BLOCKING)], True),
            ("a clearing confirm, then a blocking one", [at_open, posted("confirm", H, "VERDICT: clean"),
                                                         posted("confirm", H, BLOCKING)], True),
            ("a blocking confirm, then a clearing one", [at_open, posted("confirm", H, BLOCKING),
                                                         posted("confirm", H, "VERDICT: clean")], False),
            ("a confirm before the newest at-open", [posted("confirm", H, "VERDICT: clean"), at_open], True),
            ("a newer non-blocking at-open", [at_open, posted("at-open", H, "VERDICT: clean")], False),
        ]
        for name, comments, holds in cases:
            with self.subTest(name):
                self.assertEqual(hold_of(self.posts(*comments), H) is not None, holds)


if __name__ == "__main__":
    unittest.main()
