"""``pr-review.sh base``: the pieces that decide a verdict, in process, and the production path
end to end (``scripts/py`` and the shell script's ``main``) with a fake gh BINARY on PATH.

The fixture suites (ship-pr/scripts/test-pr-review-base-*.sh) pin the command through the sourced
function and the shell bridge; what is here pins what they cannot reach: the readers' boundaries
one input at a time, the wait loop on a fake clock (no real sleeping), and the source-(a) gate
(gate.Gate) reading through the gh on PATH, which is how production runs it.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Sequence
from contextlib import redirect_stderr, redirect_stdout

from ludics import cli, proc
from ludics.prreview import base
from ludics.prreview.ere import Matcher
from ludics.prreview.workflow_yaml import glob_ere, paths_ignore_covers, workflow_filter, workflow_keys
from ludics.prreview.checkruns import newest_first
from ludics.prreview.shtext import encode_ref, tab_fields
from ludics.prreview.clock import FuncClock
from ludics.prreview.budget import Budget
from ludics.prreview.core import Config, GhRefusedOwn, GhSession

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PY = os.path.join(ROOT, "scripts", "py")
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")

C = "c" * 40
B = "b" * 40
A = "a" * 40
H = "e" * 40

DOCS_IGNORED = """name: ci
on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "**.md"
jobs:
  build:
    runs-on: ubuntu-latest
"""

PUSHLESS = """name: ci
on:
  pull_request:
    paths-ignore:
      - "docs/**"
  # Sunday and Wednesday.
  schedule:
    - cron: "0 3 * * 0,3"
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
"""


class Readers(unittest.TestCase):
    def test_encode_ref_keeps_the_unreserved_set_and_slashes(self) -> None:
        self.assertEqual(encode_ref("claude/topic-1.x_~"), "claude/topic-1.x_~")
        self.assertEqual(encode_ref("rel#1&x"), "rel%231%26x")
        self.assertEqual(encode_ref("a b+é"), "a%20b%2B%C3%A9")

    def test_the_filter_reader_reads_both_sequence_forms_and_refuses_the_rest(self) -> None:
        self.assertEqual(workflow_filter(DOCS_IGNORED, "push", "paths-ignore"), ["docs/**", "**.md"])
        flow = "on:\n  push:\n    paths-ignore: ['docs/**', \"*.md\"]\n"
        self.assertEqual(workflow_filter(flow, "push", "paths-ignore"), ["docs/**", "*.md"])
        refused = {
            "a tab in the block": DOCS_IGNORED.replace("      - \"**.md\"", "\t- \"**.md\""),
            "a tab before on:": "# a\tcomment\n" + DOCS_IGNORED,
            "an alias": "on:\n  push:\n    paths-ignore: *docs\n",
            "an include filter only": "on:\n  push:\n    paths:\n      - src/**\n",
            "no such event": "on:\n  pull_request:\n    paths-ignore:\n      - docs/**\n",
            "an empty flow": "on:\n  push:\n    paths-ignore: []\n",
            "an empty item": "on:\n  push:\n    paths-ignore:\n      - \"\"\n",
            "a scalar on": "on: push\n",
        }
        for why, text in refused.items():
            with self.subTest(why):
                self.assertIsNone(workflow_filter(text, "push", "paths-ignore"))

    def test_a_tab_is_refused_only_on_a_line_the_readers_reach(self) -> None:
        # awk's `/\t/ { bad = 1; exit }` runs per record, and both programs `exit` once they leave
        # what they read, so a tab under jobs: (a <<-EOF heredoc) is never seen. Refusing it would
        # read a retired workflow as a push one (the #401 false green).
        tail = "    steps:\n      - run: |\n          cat <<-EOF\n\t\tx\n\t\tEOF\n"
        self.assertEqual(workflow_filter(DOCS_IGNORED + tail, "push", "paths-ignore"),
                         ["docs/**", "**.md"])
        self.assertEqual(workflow_keys(DOCS_IGNORED + tail), ["push"])
        self.assertEqual(workflow_keys(DOCS_IGNORED + tail, "push"), ["branches", "paths-ignore"])
        self.assertEqual(workflow_keys(PUSHLESS + tail), ["pull_request", "schedule", "workflow_dispatch"])
        self.assertIsNone(workflow_keys(PUSHLESS.replace("  workflow_dispatch", "\tworkflow_dispatch")))
        self.assertIsNone(workflow_keys("on:\n  push:\n# a\ttab\n  pull_request:\n"),
                          "a tab on a comment line inside the block is still reached")

    def test_the_keys_reader_reads_three_forms_and_tells_absent_from_unread(self) -> None:
        self.assertEqual(workflow_keys(PUSHLESS), ["pull_request", "schedule", "workflow_dispatch"])
        self.assertEqual(workflow_keys(DOCS_IGNORED), ["push"])
        self.assertEqual(workflow_keys(DOCS_IGNORED, "push"), ["branches", "paths-ignore"])
        self.assertEqual(workflow_keys("on: push\n"), ["push"])
        self.assertEqual(workflow_keys("on: [push, 'pull_request']\n"), ["push", "pull_request"])
        self.assertEqual(workflow_keys("on: [push]\n", "push"), [], "declared with no keys is an answer")
        self.assertIsNone(workflow_keys(PUSHLESS, "push"), "a mapping that never reached it is not")
        self.assertIsNone(workflow_keys("on: []\n"), "no trigger at all is a misread")
        self.assertIsNone(workflow_keys("on:\n  - push\n"), "a sequence under on: is refused")
        self.assertIsNone(workflow_keys("name: x\njobs: {}\n"), "no on: at all")

    def test_glob_translation_carries_two_stars_and_refuses_the_rest(self) -> None:
        self.assertEqual(glob_ere("docs/**"), "^docs/.*$")
        self.assertEqual(glob_ere("*.md"), "^[^/]*\\.md$")
        for pattern in ("", "!docs/**", "docs/?.md", "[ab].md", "docs/+"):
            self.assertIsNone(glob_ere(pattern), pattern)
        self.assertTrue(paths_ignore_covers(["docs/**", "**.md"], ["docs/a/b.txt", "src/README.md"]))
        self.assertFalse(paths_ignore_covers(["docs/**"], ["docs/a", "src/main.ml"]))
        self.assertFalse(paths_ignore_covers(["**", "[x]"], ["a"]),
                         "an untranslatable pattern fails the whole question, even beside a match")

    def test_the_advisory_ere_reads_posix_classes(self) -> None:
        adv = Matcher("^(claude|Claude Code|github pages docs)$")
        self.assertTrue(adv("Claude Code"))
        self.assertFalse(adv("ci"))
        self.assertTrue(Matcher("^[[:alpha:]]+ docs$")("pages docs"))
        self.assertFalse(Matcher("(unclosed")("anything"), "an ERE grep refuses matches nothing")

    def test_the_advisory_ere_reads_grep_word_anchors(self) -> None:
        # grep -E (BSD and GNU) reads \< and \> as word anchors; Python's re reads literal < and >.
        self.assertTrue(Matcher("\\<claude\\>")("claude review"))
        self.assertTrue(Matcher("^claude\\>")("claude"))
        self.assertFalse(Matcher("\\<claude\\>")("xclaude review"))
        self.assertFalse(Matcher("^claude\\>")("claudex"))


def row(wid: str, concl: str, sha: str, rid: str, created: str = "2026-09-10T00:00:00Z",
        status: str = "completed") -> base.RunRow:
    return base.RunRow(wid, "ci", status, concl, sha, created, f"https://x/{rid}", rid)


class Folding(unittest.TestCase):
    def test_newest_first_breaks_a_same_second_tie_on_the_higher_id(self) -> None:
        rows = [row("1", "success", C, "71"), row("1", "failure", C, "72"),
                row("1", "success", A, "70", "2026-09-09T00:00:00Z")]
        ordered = newest_first(rows, lambda r: r.created_at, lambda r: r.run_id, lambda r: r.line())
        self.assertEqual([r.run_id for r in ordered], ["72", "71", "70"])

    def test_the_fold_keeps_newest_completed_and_newest_judged_apart(self) -> None:
        rows = [row("1", "pending", C, "3", status="in_progress"), row("1", "cancelled", B, "2"),
                row("1", "failure", A, "1"), row("2", "success", C, "9")]
        f1, f2 = base.fold(rows)
        self.assertEqual((f1.status, f1.sha, f1.concl, f1.csha, f1.vconcl, f1.vsha),
                         ("in_progress", C, "cancelled", B, "failure", A))
        self.assertEqual((f2.wfid, f2.vconcl), ("2", "success"))

    def test_records_are_read_as_bash_read_them(self) -> None:
        self.assertEqual(tab_fields("\ta\t\tb\tc\td\te\t", 4), ["a", "b", "c", "d\te"])
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".tsv") as f:
            f.write(f"\n{C}\tpass\tw-1\t2026-09-26T09:00:00Z\n\n{C}\tfail\tw-2\t2026-09-26T10:00:00Z")
        try:
            self.assertEqual([r.rid for r in base.load_records(f.name)], ["w-1", "w-2"])
        finally:
            os.remove(f.name)


# --- in process: the gh calls answered by endpoint, on a fake clock ----------------------------


type Answer = str | tuple[int, str] | list[str]


class Endpoints:
    """A gh stand-in for GhSession: answers by the endpoint (the first argument after ``api`` that
    is not an option or an option's value), applies a ``--jq`` filter with jq as gh does, and
    records every endpoint asked. A list answers its items one call at a time, its last from then on:
    a feed that changes between rounds."""

    def __init__(self, answers: dict[str, Answer]) -> None:
        self.answers = answers
        self.asked: list[str] = []

    def __call__(self, name: str, args: Sequence[str]) -> proc.Completed:
        assert name == "gh" and args[0] == "api", args
        endpoint = ""
        jq = ""
        skip = False
        for i, arg in enumerate(args[1:], 1):
            if skip:
                skip = False
                continue
            if arg in ("-H", "--jq", "-X"):
                if arg == "--jq":
                    jq = args[i + 1]
                skip = True
                continue
            if arg.startswith("-") or endpoint:
                continue
            endpoint = arg
        self.asked.append(endpoint)
        answer = self.answers.get(endpoint)
        if isinstance(answer, list):
            answer = answer[min(self.asked.count(endpoint), len(answer)) - 1]
        if answer is None:
            return proc.Completed(1, "", f"gh: no fixture for {endpoint} (HTTP 404)\n")
        if isinstance(answer, str):
            if jq:
                done = subprocess.run(["jq", "-r", jq], input=answer, capture_output=True, text=True,
                                      check=False)
                return proc.Completed(done.returncode, done.stdout, done.stderr)
            return proc.Completed(0, answer + "\n", "")
        rc, err = answer
        return proc.Completed(rc, "", err)


class FakeClock(FuncClock):
    def __init__(self, start: float = 1_800_000_000.0) -> None:
        self.t = start
        self.slept: list[float] = []
        super().__init__(time=lambda: self.t, sleep=self._sleep)

    def _sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.t += seconds


class _AsClock:
    """A FakeClock as the budget's Clock protocol takes one."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock

    def time(self) -> float:
        return self.clock.time()

    def now(self) -> int:
        return self.clock.now()

    def sleep(self, seconds: float, /) -> None:
        self.clock.sleep(seconds)


def runs(*items: dict[str, object]) -> str:
    out: list[dict[str, object]] = []
    for i, item in enumerate(items):
        r: dict[str, object] = {"workflow_id": 1, "id": 1000 + i, "name": "ci", "status": "completed",
                                "head_sha": "0" * 40,
                                "created_at": f"2026-09-10T00:{59 - i:02d}:00Z",
                                "html_url": f"https://x/{1000 + i}"}
        r.update(item)
        out.append(r)
    return json.dumps({"workflow_runs": out})


def config(repo: str = "o/r") -> Config:
    return Config(repo=repo, reviewer="x", round_threshold=None, round_gap=0, api_attempts=1,
                  api_backoff=0)


KNOBS = {"SHIP_PR_BASE_ABSENT_GRACE": "300", "SHIP_PR_CHECKS_INTERVAL": "60",
         "SHIP_PR_CHECKS_WAIT": "7200", "SHIP_PR_CHECKS_HEARTBEAT": "600"}


def base_run(answers: dict[str, Answer], args: list[str], *, clock: FakeClock | None = None,
             gate: base.GateRunner | None = None,
             knobs: dict[str, str] | None = None,
             state: str = "") -> tuple[int, str, str, Endpoints]:
    gh = Endpoints(answers)
    clock = clock or FakeClock()
    session = GhSession(config(), run=gh, sleep=lambda _s: None,
                        budget=Budget(state, _AsClock(clock)) if state else None)
    out, err = io.StringIO(), io.StringIO()
    env = dict(KNOBS, **(knobs or {}))
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main_guard("pr-review.sh", lambda a: base.run(session, a, clock=clock,
                                                                gate=gate, env=env), args)
    return rc, out.getvalue(), err.getvalue(), gh


def world(tip: str, runs_page: str, **more: Answer) -> dict[str, Answer]:
    answers: dict[str, Answer] = {
        "repos/o/r/commits/main": json.dumps({"sha": tip}),
        "repos/o/r/actions/workflows?per_page=100": json.dumps({"workflows": [{"id": 1, "name": "ci"}]}),
        "repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10": runs_page,
        "repos/o/r/actions/workflows/1": json.dumps({"path": ".github/workflows/ci.yml"}),
        f"repos/o/r/contents/.github/workflows/ci.yml?ref={tip}": DOCS_IGNORED,
    }
    answers.update(more)
    return answers


class WaitLoop(unittest.TestCase):
    def test_a_covered_tip_is_green_on_the_first_round(self) -> None:
        rc, out, _, gh = base_run(world(C, runs({"conclusion": "success", "head_sha": C})), ["main"])
        self.assertEqual(rc, 0)
        self.assertEqual(out, f"o/r main: green (tip {C[:8]})\n  green    ci — success at {C[:8]}\n")
        self.assertNotIn("repos/o/r/actions/workflows/1", gh.asked, "a covered tip reads no file")

    def test_the_absence_grace_settles_on_the_clock_and_not_before(self) -> None:
        answers = world(C, runs({"conclusion": "success", "head_sha": A}),
                        **{f"repos/o/r/compare/{A}...{C}?per_page=20": json.dumps(
                            {"total_commits": 1, "behind_by": 0,
                             "commits": [{"sha": C, "parents": [{"sha": A}]}]}),
                           f"repos/o/r/commits/{C}?per_page=100": json.dumps(
                               {"files": [{"filename": "src/main.ml"}]})})
        clock = FakeClock()
        rc, out, _, _ = base_run(answers, ["main", "--wait=900"], clock=clock,
                                 knobs={"SHIP_PR_BASE_ABSENT_GRACE": "120", "SHIP_PR_CHECKS_INTERVAL": "30"})
        self.assertEqual(rc, 0, out)
        self.assertIn("(waited 2 min: no run for the tip appeared", out)
        self.assertEqual(clock.slept, [30, 30, 30, 30], "four rounds of thirty seconds spend the grace")

    def test_a_docs_only_tip_settles_without_the_clock(self) -> None:
        answers = world(C, runs({"conclusion": "success", "head_sha": A}),
                        **{f"repos/o/r/compare/{A}...{C}?per_page=20": json.dumps(
                            {"total_commits": 1, "behind_by": 0,
                             "commits": [{"sha": C, "parents": [{"sha": A}]}]}),
                           f"repos/o/r/commits/{C}?per_page=100": json.dumps(
                               {"files": [{"filename": "docs/notes.md"}]})})
        clock = FakeClock()
        rc, out, _, _ = base_run(answers, ["main", "--wait=900"], clock=clock)
        self.assertEqual(rc, 0, out)
        self.assertIn("paths-ignore of ci, so no run for it is coming", out)
        self.assertEqual(clock.slept, [])

    def test_the_ceiling_caps_the_last_sleep(self) -> None:
        clock = FakeClock()
        page = runs({"status": "in_progress", "conclusion": None, "head_sha": C})
        rc, out, _, _ = base_run(world(C, page), ["main", "--wait=70"], clock=clock)
        self.assertEqual(rc, 4)
        self.assertIn("NO VERDICT for the tip", out)
        self.assertEqual(clock.slept, [60, 10], "the last sleep is what is left of the ceiling")

    def test_a_stale_page_between_rounds_is_read_again(self) -> None:
        """ludics-lite#550: round one sees the tip's run in flight, round two's page holds only a
        weeks-old green, round three the tip's own green. Round two is not settled on."""
        def at(sha: str, rid: int, created: str, **more: object) -> dict[str, object]:
            return {"conclusion": "success", "head_sha": sha, "id": rid, "created_at": created, **more}
        fly = at(C, 9, "2026-10-05T10:30:00Z", status="in_progress", conclusion=None)
        prev = at(B, 8, "2026-10-05T10:00:00Z")
        stale = at(A, 4, "2026-09-24T09:00:00Z")
        answers = world(C, "", **{
            f"repos/o/r/compare/{A}...{C}?per_page=20": json.dumps(
                {"total_commits": 1, "behind_by": 0, "commits": [{"sha": C, "parents": [{"sha": A}]}]}),
            f"repos/o/r/commits/{C}?per_page=100": json.dumps({"files": [{"filename": "src/x.ml"}]})})
        answers["repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10"] = [
            runs(fly, prev), runs(stale), runs(at(C, 9, "2026-10-05T10:30:00Z"), prev)]
        clock = FakeClock()
        rc, out, _, _ = base_run(answers, ["main", "--wait=900"], clock=clock,
                                 knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertEqual(rc, 0, out)
        self.assertEqual(out, f"o/r main: green (tip {C[:8]})\n  green    ci — success at {C[:8]}\n")
        self.assertEqual(len(clock.slept), 2, "three rounds")

    def test_a_judged_run_older_than_an_earlier_rounds_contradicts_it(self) -> None:
        def at(sha: str, rid: int, created: str, **more: object) -> dict[str, object]:
            return {"conclusion": "success", "head_sha": sha, "id": rid, "created_at": created, **more}
        answers = world(C, "")
        answers["repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10"] = [
            runs(at(B, 9, "2026-10-05T10:30:00Z", status="queued", conclusion=None),
                 at(A, 8, "2026-10-05T10:00:00Z")),
            runs(at(H, 4, "2026-09-24T09:00:00Z"))]
        rc, out, _, _ = base_run(answers, ["main", "--wait=200"], knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertEqual(rc, 4, out)
        self.assertIn("(this round's runs page contradicts an earlier round's: ci's newest judged run is"
                      f" run 4 at {H[:8]}, older than run 8 at {A[:8]}, which an earlier round judged by"
                      " — a stale read", out)
        # The same rows, at the same instant, re-read: the same judged run, and no contradiction.
        answers["repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10"] = [
            runs(at(B, 9, "2026-10-05T10:30:00Z", status="queued", conclusion=None),
                 at(A, 8, "2026-10-05T10:00:00Z"))]
        rc, out, _, _ = base_run(answers, ["main", "--wait=200"], knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertNotIn("contradicts", out)

    def test_a_tip_run_gone_from_the_page_alone_contradicts_it(self) -> None:
        """ludics-lite#550, the tip-run half on its own: round two's page drops only the tip's run
        in flight while its newest judged run stays the same, so only the lost run tells the stale
        page apart. Settled on, round two would be an absence green trailing the tip."""
        def at(sha: str, rid: int, created: str, **more: object) -> dict[str, object]:
            return {"conclusion": "success", "head_sha": sha, "id": rid, "created_at": created, **more}
        fly = at(C, 9, "2026-10-05T10:30:00Z", status="in_progress", conclusion=None)
        prev = at(B, 8, "2026-10-05T10:00:00Z")
        answers = world(C, "", **{
            f"repos/o/r/compare/{B}...{C}?per_page=20": json.dumps(
                {"total_commits": 1, "behind_by": 0, "commits": [{"sha": C, "parents": [{"sha": B}]}]}),
            f"repos/o/r/commits/{C}?per_page=100": json.dumps({"files": [{"filename": "src/x.ml"}]})})
        answers["repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10"] = [
            runs(fly, prev), runs(prev), runs(at(C, 9, "2026-10-05T10:30:00Z"), prev)]
        clock = FakeClock()
        rc, out, _, _ = base_run(answers, ["main", "--wait=900"], clock=clock,
                                 knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertEqual(rc, 0, out)
        self.assertEqual(out, f"o/r main: green (tip {C[:8]})\n  green    ci — success at {C[:8]}\n")
        self.assertEqual(len(clock.slept), 2, "three rounds")

    def test_a_page_with_no_judged_run_where_one_was_contradicts_it(self) -> None:
        """ludics-lite#550, the empty half: a second workflow's page comes back empty after a round
        that judged on it. Settled on as that workflow's absence, it would be a green that never
        names it; its run in flight is a red."""
        def at(sha: str, rid: int, created: str, **more: object) -> dict[str, object]:
            return {"conclusion": "success", "head_sha": sha, "id": rid, "created_at": created, **more}

        def lint(*items: dict[str, object]) -> str:
            return runs(*[dict(i, workflow_id=2, name="lint") for i in items])
        answers = world(C, runs(at(C, 20, "2026-10-05T11:00:00Z")), **{
            "repos/o/r/actions/workflows?per_page=100": json.dumps(
                {"workflows": [{"id": 1, "name": "ci"}, {"id": 2, "name": "lint"}]}),
            "repos/o/r/actions/workflows/2": json.dumps({"path": ".github/workflows/lint.yml"}),
            f"repos/o/r/contents/.github/workflows/lint.yml?ref={C}": DOCS_IGNORED.replace(
                "name: ci", "name: lint")})
        answers["repos/o/r/actions/workflows/2/runs?branch=main&event=push&per_page=10"] = [
            lint(at(B, 9, "2026-10-05T10:30:00Z", status="queued", conclusion=None),
                 at(A, 8, "2026-10-05T10:00:00Z")),
            lint(),
            lint(at(B, 9, "2026-10-05T10:30:00Z", conclusion="failure"), at(A, 8, "2026-10-05T10:00:00Z"))]
        clock = FakeClock()
        rc, out, _, _ = base_run(answers, ["main", "--wait=900"], clock=clock,
                                 knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertEqual(rc, 1, out)
        self.assertIn(f"RED      lint — failure at {B[:8]}", out)
        self.assertEqual(len(clock.slept), 2, "three rounds")

    def test_a_rerun_of_a_judged_run_is_not_a_stale_page(self) -> None:
        """A run an earlier round judged by, re-run (its ``run_attempt`` up) and the re-run
        cancelled, leaves an older run the newest judged one. That is the branch's history moving,
        not a stale page: the docs-only tip settles through paths-ignore as it would have on a
        first read, rather than waiting out its ceiling. The re-run seen at its OLD attempt is
        still a contradiction."""
        def at(sha: str, rid: int, created: str, **more: object) -> dict[str, object]:
            return {"conclusion": "success", "head_sha": sha, "id": rid, "created_at": created, **more}

        def lint(*items: dict[str, object]) -> str:
            return runs(*[dict(i, workflow_id=2, name="lint") for i in items])
        judged = at(B, 9, "2026-10-05T10:30:00Z", run_attempt=1)
        rerun = at(B, 9, "2026-10-05T10:30:00Z", run_attempt=2, conclusion="cancelled")
        prev = at(A, 8, "2026-10-05T10:00:00Z", run_attempt=1)
        answers = world(C, "", **{
            "repos/o/r/actions/workflows?per_page=100": json.dumps(
                {"workflows": [{"id": 1, "name": "ci"}, {"id": 2, "name": "lint"}]}),
            "repos/o/r/actions/workflows/2": json.dumps({"path": ".github/workflows/lint.yml"}),
            f"repos/o/r/contents/.github/workflows/lint.yml?ref={C}": DOCS_IGNORED.replace(
                "name: ci", "name: lint"),
            "repos/o/r/actions/workflows/2/runs?branch=main&event=push&per_page=10": [
                lint(at(C, 20, "2026-10-05T11:00:00Z", status="in_progress", conclusion=None)),
                lint(at(C, 20, "2026-10-05T11:00:00Z"))],
            f"repos/o/r/compare/{A}...{C}?per_page=20": json.dumps(
                {"total_commits": 1, "behind_by": 0, "commits": [{"sha": C, "parents": [{"sha": A}]}]}),
            f"repos/o/r/commits/{C}?per_page=100": json.dumps({"files": [{"filename": "docs/x.md"}]})})
        page = "repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10"
        answers[page] = [runs(judged, prev), runs(rerun, prev)]
        clock = FakeClock()
        rc, out, _, _ = base_run(answers, ["main", "--wait=900"], clock=clock)
        self.assertEqual(rc, 0, out)
        self.assertNotIn("contradicts", out)
        self.assertIn(f"green    ci — success at {A[:8]}", out)
        self.assertIn("paths-ignore of ci, so no run for it is coming", out)
        self.assertEqual(len(clock.slept), 1, "two rounds")
        # The same run at its earlier attempt, after its re-run was seen in flight: a stale page,
        # which would otherwise settle on the absence grace.
        running = dict(rerun, status="in_progress", conclusion=None)
        answers[page] = [runs(judged, prev), runs(running, prev), runs(judged, prev)]
        answers["repos/o/r/actions/workflows/2/runs?branch=main&event=push&per_page=10"] = [
            lint(at(C, 20, "2026-10-05T11:00:00Z", status="in_progress", conclusion=None)),
            lint(at(C, 20, "2026-10-05T11:00:00Z"))]
        rc, out, _, _ = base_run(answers, ["main", "--wait=200"], knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertEqual(rc, 4, out)
        self.assertIn(f"ci's run 9 at {B[:8]} reads at attempt 1, where an earlier round read attempt 2", out)

    def test_a_deeper_page_staler_than_the_page_of_ten_keeps_the_ten(self) -> None:
        """A full page of ten with no green row is read a hundred deep. When the deeper read is
        the staler one (the tip's red run missing from it, an older green below), the page of ten
        stands: its red is not traded for the green, and the round says it is a stale read."""
        red: list[dict[str, object]] = [{"conclusion": "failure", "head_sha": C if i == 0 else A}
                                        for i in range(10)]
        older: list[dict[str, object]] = [{"conclusion": "failure", "head_sha": A} for _ in range(11)]
        ten = runs(*red)
        deeper = json.loads(runs(*older, {"conclusion": "success", "head_sha": B}))
        for row in deeper["workflow_runs"]:
            row["id"] += 1
        answers = world(C, ten, **{
            "repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=100": json.dumps(deeper)})
        rc, out, _, _ = base_run(answers, ["main"])
        self.assertEqual(rc, 1, out)
        self.assertIn(f"RED      ci — failure at {C[:8]}", out)
        self.assertIn("ci's run 1000 on the page of ten is not on the deeper page", out)
        # A deeper page holding every run of the ten reads as before: deeper.
        fresh = json.loads(ten)
        fresh["workflow_runs"] += deeper["workflow_runs"][10:]
        answers["repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=100"] = json.dumps(fresh)
        rc, out, _, _ = base_run(answers, ["main"])
        self.assertEqual(rc, 1, out)
        self.assertNotIn("deeper page", out)

    def test_a_round_that_waited_a_quota_hold_out_is_read_again(self) -> None:
        """A quota hold waited out between a round's reads makes its pages older than its end: a
        red read before the hold, re-run green during it, is not the verdict. The round is read
        again whole, as the checks gate reads its own."""
        state = os.path.realpath(tempfile.mkdtemp(prefix="ludics-base-state."))
        self.addCleanup(shutil.rmtree, state, True)
        page = "repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10"
        answers = world(C, "")
        answers[page] = [runs({"conclusion": "failure", "head_sha": C, "id": 9, "run_attempt": 1}),
                         runs({"conclusion": "success", "head_sha": C, "id": 9, "run_attempt": 2})]
        gh = Endpoints(answers)
        clock = FakeClock()
        budget = Budget(state, _AsClock(clock))

        def run(name: str, args: Sequence[str]) -> proc.Completed:
            done = gh(name, args)
            if page in args and gh.asked.count(page) == 1:
                budget.waited = True  # the hold this read waited out
            return done
        session = GhSession(config(), run=run, sleep=lambda _s: None, budget=budget)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cli.main_guard("pr-review.sh", lambda a: base.run(session, a, clock=clock, env=dict(KNOBS)),
                                ["main", "--wait=900"])
        self.assertEqual(rc, 0, out.getvalue() + err.getvalue())
        self.assertEqual(out.getvalue(), f"o/r main: green (tip {C[:8]})\n  green    ci — success at {C[:8]}\n")
        self.assertIn("a quota hold was waited out inside this round's reads; reading the round again",
                      err.getvalue())
        self.assertEqual(gh.asked.count(page), 2)

    def test_a_settle_on_absence_keeps_its_pages_and_only_the_newest(self) -> None:
        state = os.path.realpath(tempfile.mkdtemp(prefix="ludics-base-state."))
        self.addCleanup(shutil.rmtree, state, True)
        pages = os.path.join(state, "base-pages")
        os.makedirs(pages)
        for i in range(base.KEPT_PAGES + 3):
            with open(os.path.join(pages, f"{1_700_000_000 + i}.1.o~r.txt"), "w", encoding="utf-8") as f:
                f.write("old\n")
        with open(os.path.join(pages, "notes"), "w", encoding="utf-8") as f:
            f.write("not ours\n")
        page = runs({"conclusion": "success", "head_sha": A, "id": 77})
        answers = world(C, page, **{
            f"repos/o/r/compare/{A}...{C}?per_page=20": json.dumps(
                {"total_commits": 1, "behind_by": 0, "commits": [{"sha": C, "parents": [{"sha": A}]}]}),
            f"repos/o/r/commits/{C}?per_page=100": json.dumps({"files": [{"filename": "src/x.ml"}]})})
        rc, out, err, _ = base_run(answers, ["main", "--wait=900"], state=state,
                                   knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertEqual(rc, 0, out + err)
        kept = sorted(n for n in os.listdir(pages) if n.endswith(".txt"))
        self.assertEqual(len(kept), base.KEPT_PAGES, "the newest are kept")
        self.assertIn("notes", os.listdir(pages), "a file not of this shape is left alone")
        newest = os.path.join(pages, kept[-1])
        self.assertIn(f"kept the runs pages it read in {newest} (ludics-lite#550)", err)
        with open(newest, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("## repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10\n" + page, text)
        self.assertIn(f"tip {C}", text)

    def test_an_unknown_read_is_exit_three_with_the_reason(self) -> None:
        answers = world(C, runs())
        answers["repos/o/r/actions/workflows?per_page=100"] = (1, "gh: Server Error (HTTP 500)\n")
        rc, _, err, _ = base_run(answers, ["main"])
        self.assertEqual(rc, 3)
        self.assertIn("could not read o/r's workflow list (gh: Server Error (HTTP 500));", err)

    def test_a_red_names_its_floor_commit_as_the_span_to_attribute(self) -> None:
        # ludics-lite#597: a push group keeping only the newest pending run cancels the runs of the
        # merges in between, so the green floor's commit is where attribution starts. Named only:
        # the feed's order is creation, not ancestry.
        jobs = json.dumps({"jobs": [{"name": "bash 3.2 suites (macos)", "conclusion": "failure"}]})
        page = runs({"conclusion": "failure", "head_sha": C}, {"conclusion": "cancelled", "head_sha": B},
                    {"conclusion": "success", "head_sha": A})
        rc, out, _, _ = base_run(world(C, page, **{"repos/o/r/actions/runs/1000/jobs?per_page=100": jobs}),
                                 ["main"])
        self.assertEqual(rc, 1)
        self.assertIn(f"red since {C[:8]} (run created 2026-09-10T00:59:00Z), 1 run(s) back; the judged run"
                      f" before it was not red (success at {A[:8]})\n", out)


PULL = json.dumps([{"number": 7, "merged_at": "2026-09-26T08:00:53Z", "merge_commit_sha": C,
                    "head": {"sha": H, "ref": "claude/topic"}, "base": {"ref": "main"}}])
MERGE = json.dumps({"parents": [{"sha": B}, {"sha": H}],
                    "commit": {"committer": {"email": "noreply@github.com"},
                               "verification": {"verified": True}}})


def pushless_world() -> dict[str, Answer]:
    return world(C, runs({"conclusion": "success", "head_sha": A}), **{
        f"repos/o/r/contents/.github/workflows/ci.yml?ref={C}": PUSHLESS,
        f"repos/o/r/commits/{C}": MERGE,
        f"repos/o/r/commits/{C}/pulls?per_page=100": PULL,
        f"repos/o/r/actions/runs?head_sha={H}&per_page=100": json.dumps({"workflow_runs": [
            {"created_at": "2026-09-26T07:41:00Z", "id": 8001, "workflow_id": 1, "status": "completed",
             "conclusion": "success"}]}),
        "repos/o/r/actions/runs/8001/jobs?per_page=100": json.dumps(
            {"jobs": [{"name": "build", "conclusion": "success"}]}),
    })


def gate_stub(verdict: str, line: str, *, refuse: str = "") -> base.GateRunner:
    """Source (a)'s gate, answered: its VERDICT and build-signal line, or a refusal of its own gh
    call (which ends the command, as it ends the gate)."""
    def gate(_num: str) -> base.GateSignal | None:
        if refuse:
            raise GhRefusedOwn(refuse)
        return base.GateSignal(verdict, line)
    return gate


class NamedSources(unittest.TestCase):
    def test_a_clean_merge_of_a_green_head_judges_a_retired_workflow(self) -> None:
        rc, out, _, _ = base_run(pushless_world(), ["main"],
                                 gate=gate_stub("green", "o/r#7 @eeeeeeee: green — 1 build checks passed"))
        self.assertEqual(rc, 0, out)
        self.assertIn(f"o/r main: green (tip {C[:8]}; ci judged by PR #7's head run (roll-forward rule))", out)
        self.assertIn("(roll-forward rule): o/r#7 @eeeeeeee: green — 1 build checks passed", out)

    def test_no_interim_green_on_a_round_that_contradicts_an_earlier_one(self) -> None:
        """ludics-lite#550 under --interim (the gate's ``base --wait --interim``): round one reads an
        older red beside the tip's run in flight, round two a stale page (and a stale deeper read)
        that drops the red, round three the tip's own red. The interim is not taken on round two."""
        def at(sha: str, rid: int, created: str, **more: object) -> dict[str, object]:
            return {"conclusion": "success", "head_sha": sha, "id": rid, "created_at": created, **more}
        fly = at(C, 10, "2026-10-05T10:30:00Z", status="in_progress", conclusion=None)
        red = at(B, 9, "2026-10-05T10:20:00Z", conclusion="failure")
        prev = at(A, 8, "2026-10-05T10:00:00Z")
        answers = pushless_world()
        answers.update({
            f"repos/o/r/contents/.github/workflows/ci.yml?ref={C}": DOCS_IGNORED,
            "repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=10": [
                runs(fly, red, prev), runs(fly, prev),
                runs(at(C, 10, "2026-10-05T10:30:00Z", conclusion="failure"), red, prev)],
            "repos/o/r/actions/workflows/1/runs?branch=main&event=push&per_page=100": runs(fly, prev),
            "repos/o/r/actions/runs/10": json.dumps({"status": "in_progress"}),
        })
        clock = FakeClock()
        rc, out, _, _ = base_run(answers, ["main", "--wait=900", "--interim"], clock=clock,
                                 gate=gate_stub("green", "o/r#7 @eeeeeeee: green — 1 build checks passed"),
                                 knobs={"SHIP_PR_BASE_ABSENT_GRACE": "0"})
        self.assertEqual(rc, 1, out)
        self.assertNotIn("interim (tip", out)
        self.assertIn(f"RED      ci — failure at {C[:8]}", out)
        self.assertEqual(len(clock.slept), 2, "three rounds")

    def test_a_gate_verdict_outside_the_vocabulary_is_unknown(self) -> None:
        rc, _, err, _ = base_run(pushless_world(), ["main"], gate=gate_stub("superseded", "x"))
        self.assertEqual(rc, 3)
        self.assertIn("could not read a verdict source for o/r main's tip", err)

    def test_a_refusal_inside_the_gate_ends_the_command_with_two(self) -> None:
        message = "pr-review.sh: the installed gh refused this script's own call"
        with self.assertRaises(GhRefusedOwn):
            gh = Endpoints(pushless_world())
            b = base.Base(GhSession(config(), run=gh), base.load_knobs(KNOBS), "o/r",
                          gate=gate_stub("green", "x", refuse=message))
            b.tip_pr_head_verdict("main", C, [])
        rc, _, err, _ = base_run(pushless_world(), ["main"], gate=gate_stub("green", "x", refuse=message))
        self.assertEqual((rc, err), (2, message + "\n"))


# --- end to end: a fake gh binary that answers by endpoint and applies --jq ----------------------

_FAKE_GH = r'''
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, "calls.log"), "a", encoding="utf-8") as log:
    log.write(" ".join(args) + "\n")
endpoint, jq, i = "", "", 1
while i < len(args):
    a = args[i]
    if a in ("-H", "-X", "--jq"):
        if a == "--jq":
            jq = args[i + 1]
        i += 2
        continue
    if not a.startswith("-") and not endpoint:
        endpoint = a
    i += 1
with open(os.path.join(here, "answers.json"), encoding="utf-8") as f:
    answers = json.load(f)
if args[:1] != ["api"] or endpoint not in answers:
    sys.stderr.write(f"gh: no fixture for {endpoint} (HTTP 404)\n")
    sys.exit(1)
body = answers[endpoint]
if jq:
    done = subprocess.run(["jq", "-r", jq], input=body, capture_output=True, text=True)
    sys.stdout.write(done.stdout)
    sys.stderr.write(done.stderr)
    sys.exit(done.returncode)
sys.stdout.write(body + "\n")
'''


class EndToEnd(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-base-test."))
        with open(os.path.join(self.dir, "gh"), "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{_FAKE_GH}")
        os.chmod(os.path.join(self.dir, "gh"), 0o755)

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def answer(self, answers: dict[str, Answer]) -> None:
        plain = {k: v for k, v in answers.items() if isinstance(v, str)}
        with open(os.path.join(self.dir, "answers.json"), "w", encoding="utf-8") as f:
            json.dump(plain, f)

    def run_cmd(self, entry: list[str], *args: str) -> subprocess.CompletedProcess[str]:
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("LUDICS_BRIDGE", "SHIP_PR_"))}
        env.update({"PATH": self.dir + os.pathsep + env.get("PATH", ""), "REPO": "o/r",
                    "SHIP_PR_API_ATTEMPTS": "1", "SHIP_PR_API_BACKOFF": "0",
                    "SHIP_PR_STATE_DIR": os.path.join(self.dir, "state")})
        return subprocess.run([*entry, "base", *args], capture_output=True, text=True, env=env,
                              cwd=self.dir, check=False)

    def entries(self) -> list[list[str]]:
        return [[PY, "-m", "ludics.prreview"], [PR_REVIEW]]

    def test_a_green_tip_through_both_entries(self) -> None:
        self.answer(world(C, runs({"conclusion": "success", "head_sha": C})))
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                done = self.run_cmd(entry, "main")
                self.assertEqual((done.returncode, done.stderr), (0, ""))
                self.assertEqual(done.stdout.splitlines()[0], f"o/r main: green (tip {C[:8]})")

    def test_source_a_runs_the_checks_gate_through_the_gh_on_path(self) -> None:
        answers = pushless_world()
        answers.update({
            "repos/o/r/pulls/7": json.dumps({"head": {"sha": H, "ref": "claude/topic"},
                                             "base": {"sha": B}, "updated_at": "2026-09-26T07:40:00Z"}),
            f"repos/o/r/commits/{H}/check-runs?filter=latest&per_page=100": json.dumps(
                {"check_runs": [{"name": "build", "conclusion": "success",
                                 "html_url": "https://x/check/1", "check_suite": {"id": 5}}]}),
            f"repos/o/r/actions/runs?head_sha={H}&per_page=100": json.dumps({"workflow_runs": [
                {"created_at": "2026-09-26T07:41:00Z", "id": 8001, "workflow_id": 1,
                 "event": "pull_request", "name": "ci", "status": "completed",
                 "conclusion": "success", "check_suite_id": 5}]}),
        })
        self.answer(answers)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                done = self.run_cmd(entry, "main")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertIn(f"o/r main: green (tip {C[:8]}; ci judged by PR #7's head run"
                              " (roll-forward rule))", done.stdout)
                with open(os.path.join(self.dir, "calls.log"), encoding="utf-8") as log:
                    self.assertIn(f"repos/o/r/commits/{H}/check-runs", log.read(),
                                  "the gate read the head's checks through the gh on PATH")
                self.assertIn(f"(roll-forward rule): o/r#7 @{H[:8]}: green", done.stdout)


if __name__ == "__main__":
    unittest.main()
