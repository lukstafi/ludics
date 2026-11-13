"""Units of the ``checks``/``merge`` port: the advisory list as grep reads it, the shell readings,
the workflow-YAML readers, the glob, the drift's hunk reader, the closing-keyword filter, and the
gate's fold and wait loop driven through an in-process gh (``GhSession(run=...)``) and an injected
clock.

The fixture suites (test-pr-review-checks-absent.sh, -merge.sh, -base-drift.sh) are the
conformance suite; these pin the rules inside the port that a regression would bend first.
"""

import ast
import contextlib
import inspect
import io
import os
import subprocess
import unittest
from unittest import mock
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

from ludics import cli, proc
from ludics.prreview import branchtip, checks, clock, closekw, shtext, workflow_yaml
from ludics.prreview.core import Config, GhOk, GhSession, GhUnanswered, Json
from ludics.prreview.drift import compare_file_set, compare_hunks
from ludics.prreview.checkruns import conclusion_class, newest_first_lines
from ludics.prreview.budget import Budget
from ludics.prreview.clock import FuncClock
from ludics.prreview import gate as gate_module, merge as merge_module
from ludics.prreview.gate import (
    Gate, RunKey, WaivedRun, advisory_parse, job_waiver, load_gate_config, run_waiver, running_list,
)
from ludics.prreview.runners import Idle


def grep_refuses_in(locale: str, pattern: str) -> bool:
    """Does this box's grep refuse ``pattern`` under ``locale``? (The oracle the shell asked.)"""
    env = {**os.environ, "LC_ALL": locale}
    done = subprocess.run(["grep", "-Eq", "--", pattern], input=b"", env=env, capture_output=True, check=False)
    return done.returncode == 2


class ChecksTipTrailer(unittest.TestCase):
    def test_tip_warning_preserves_build_exit_and_last_line(self) -> None:
        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0,
                        api_attempts=1, api_backoff=0)
        for tip, branch, expected in (
            (branchtip.Clear("old"), "current", ""),
            (branchtip.Clear(), "unread", ""),
            (branchtip.Lags("old", "new", "topic", "o/r"), "behind", "is NOT its branch's tip"),
            (branchtip.Gone("old", "topic", "o/r"), "unread", "has no branch tip"),
            (branchtip.Unread("offline"), "unread", "is UNREAD"),
        ):
            with self.subTest(tip=tip), mock.patch.object(checks, "Gate") as gate_type, \
                    mock.patch.object(branchtip, "read_tip", return_value=tip) as read:
                gate = gate_type.return_value
                gate.advisory_policy.return_value = 0
                gate.check.return_value = 0
                gate.verdict = "green"
                gate.check_sha = "old"
                gate.orphans = []
                out = io.StringIO()
                session = GhSession(config)
                with contextlib.redirect_stdout(out):
                    rc = checks.run(session, ["7", "--wait=30"])
                self.assertEqual(rc, 0)
                self.assertEqual(out.getvalue().splitlines()[-1], f"checks: verdict=green branch={branch}")
                if expected:
                    self.assertIn(expected, out.getvalue())
                else:
                    self.assertEqual(out.getvalue(), f"checks: verdict=green branch={branch}\n")
                read.assert_called_once_with(session, "o/r", "7")

    def test_failed_ref_read_reports_unread_beside_green(self) -> None:
        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0,
                        api_attempts=1, api_backoff=0)
        session = GhSession(config)
        with mock.patch.object(checks, "Gate") as gate_type, \
                mock.patch.object(session, "retry", side_effect=[
                    GhOk("open\thead\ttopic\to/r"), GhUnanswered(),
                ]) as read:
            gate = gate_type.return_value
            gate.advisory_policy.return_value = 0
            gate.check.return_value = 0
            gate.verdict = "green"
            gate.orphans = []
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(checks.run(session, ["7"]), 0)
            self.assertEqual(out.getvalue().splitlines()[-1], "checks: verdict=green branch=unread")
            self.assertIn("is UNREAD", out.getvalue())
            self.assertEqual(read.call_count, 2)
            self.assertIn("repos/o/r/git/ref/heads/topic", read.call_args.args[1])

    def test_agreement_uses_the_judged_sha_and_closed_prs_are_unread(self) -> None:
        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0,
                        api_attempts=1, api_backoff=0)
        for judged, state, head, tip, branch in (
            ("old", "open", "old", "old", "current"),
            ("old", "open", "new", "new", "behind"),
            ("old", "open", "new", "old", "behind"),
            ("old", "open", "new", "other", "behind"),
            ("", "open", "new", "new", "unread"),
            ("", "open", "new", "old", "unread"),
            ("old", "closed", "old", "", "unread"),
        ):
            for rc, verdict in ((0, "green"), (5, "superseded")):
                with self.subTest(judged=judged, state=state, head=head, tip=tip, rc=rc), \
                        mock.patch.object(checks, "Gate") as gate_type:
                    session = GhSession(config)
                    replies = [GhOk(f"{state}\t{head}\ttopic\to/r")]
                    if state == "open":
                        replies.append(GhOk(tip))
                    gate = gate_type.return_value
                    gate.advisory_policy.return_value = 0
                    gate.check.return_value = rc
                    gate.verdict = verdict
                    gate.check_sha = judged
                    gate.orphans = []
                    with mock.patch.object(session, "retry", side_effect=replies) as read, \
                            contextlib.redirect_stdout(io.StringIO()) as out:
                        self.assertEqual(checks.run(session, ["7"]), rc)
                    self.assertEqual(out.getvalue().splitlines()[-1], f"checks: verdict={verdict} branch={branch}")
                    self.assertEqual(read.call_count, len(replies))
                    if state == "open" and head != tip:
                        self.assertIn("is NOT its branch's tip", out.getvalue())
                        self.assertNotIn("branch=current", out.getvalue())
                    if state == "closed":
                        self.assertEqual(out.getvalue(), f"checks: verdict={verdict} branch=unread\n")

    def test_unread_build_or_policy_refusal_sends_no_tip_request(self) -> None:
        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0,
                        api_attempts=1, api_backoff=0)
        for policy in (0, 2, 3):
            with self.subTest(policy=policy), mock.patch.object(checks, "Gate") as gate_type, \
                    mock.patch.object(branchtip, "read_tip") as read:
                gate = gate_type.return_value
                gate.advisory_policy.return_value = policy
                gate.check.return_value = 3
                gate.verdict = "unknown"
                gate.orphans = []
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(checks.run(GhSession(config), ["7"]), policy or 3)
                self.assertIn("branch=unread", out.getvalue())
                read.assert_not_called()


class Advisory(unittest.TestCase):
    """The advisory list is grep's to read, as it was the shell's: these pin patterns a translation
    to ``re`` read differently from grep (parity review of the port)."""

    def advisory(self, pattern: str, name: str) -> bool:
        gate = make_gate(FakeGh(), FakeClock(), SHIP_PR_ADVISORY_CHECKS=pattern)
        return gate.is_advisory(name)

    def test_the_default_list(self) -> None:
        gate = make_gate(FakeGh(), FakeClock())
        self.assertEqual(
            [gate.is_advisory(n) for n in ("claude", "Claude Code", "github pages docs", "claude-nightly", "build")],
            [True, True, True, False, False],
        )

    def test_an_escape_both_greps_read_is_read(self) -> None:
        pattern = r"^(claude|Claude Code)$|\bdocs\b"
        self.assertTrue(self.advisory(pattern, "github pages docs"))
        self.assertFalse(self.advisory(pattern, "build"))

    def test_a_newline_separates_patterns(self) -> None:
        pattern = "^claude$\n^github pages docs$"
        self.assertTrue(self.advisory(pattern, "github pages docs"))
        self.assertTrue(self.advisory(pattern, "claude"))
        self.assertFalse(self.advisory(pattern, "build"))

    def test_an_option_shaped_pattern_is_a_pattern(self) -> None:
        self.assertFalse(self.advisory("--help", "build"))
        self.assertTrue(self.advisory("--help", "x--helpy"))

    def test_a_pattern_grep_refuses_matches_nothing(self) -> None:
        self.assertFalse(self.advisory("^(claude", "claude"))

    def test_the_callers_locale_is_greps(self) -> None:
        locale = "en_US.UTF-8"
        if not grep_refuses_in(locale, "[+-.]"):
            self.skipTest(f"this box's grep reads [+-.] in {locale}")
        with mock.patch.dict(os.environ, {"LC_ALL": locale}):
            self.assertFalse(self.advisory("^(claude|github pages docs)$|^[+-.]$", "github pages docs"))
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertIsNone(advisory_parse("^github pages docs$\n^[+-.]$", "f"))
        with mock.patch.dict(os.environ, {"LC_ALL": "C"}):
            self.assertTrue(self.advisory("^(claude|github pages docs)$|^[+-.]$", "github pages docs"))
            self.assertEqual(advisory_parse("^github pages docs$\n^[+-.]$", "f"), "^github pages docs$|^[+-.]$")

    def test_a_line_grep_refuses_refuses_the_file(self) -> None:
        for body in ("^claude$\n^(macos", "[a", "[z-a]", "^claude$\n^(macos)\\1$"):
            with self.subTest(body=body), contextlib.redirect_stderr(io.StringIO()):
                self.assertIsNone(advisory_parse(body, "f"))


class ShellReadings(unittest.TestCase):
    def test_tab_fields_collapses_a_run_of_tabs(self) -> None:
        self.assertEqual(shtext.tab_fields("a\tb\tc", 3), ["a", "b", "c"])
        self.assertEqual(shtext.tab_fields("a\t\tc\td", 3), ["a", "c", "d"])
        self.assertEqual(shtext.tab_fields("a\tb\tc\td", 2), ["a", "b\tc\td"])
        self.assertEqual(shtext.tab_fields("\ta", 2), ["a", ""])
        self.assertEqual(shtext.tab_fields("", 2), ["", ""])

    def test_the_parameter_expansions(self) -> None:
        self.assertEqual(shtext.head_line("a\nb"), "a")
        self.assertEqual(shtext.after_line("a\nb\nc"), "b\nc")
        self.assertEqual(shtext.after_line("alone"), "alone")
        self.assertEqual(shtext.count_nonempty("a\n\nb\n"), 2)

    def test_encode_ref(self) -> None:
        self.assertEqual(shtext.encode_ref("wip x"), "wip%20x")
        self.assertEqual(shtext.encode_ref("feat/a#1&b"), "feat/a%231%26b")
        self.assertEqual(shtext.encode_ref("é"), "%C3%A9")

    def test_clocks(self) -> None:
        def now() -> float:
            return 1767225600.0 + 90  # 2026-01-01T00:01:30Z

        self.assertEqual(clock.age_of("2026-01-01T00:00:00Z", now()), 90)
        self.assertIsNone(clock.age_of("2026-01-01T00:05:00Z", now()), "a future stamp is no age")
        self.assertIsNone(clock.age_of("yesterday", now()))
        self.assertEqual(clock.freshest_age("2026-01-01T00:05:00Z", "2026-01-01T00:00:30Z", now=now()), 60)
        self.assertEqual((clock.fmt_age(59), clock.fmt_age(61), clock.fmt_age(None)), ("59s", "1m", "an unknown time"))

    def test_jq_compact(self) -> None:
        self.assertEqual(shtext.jq_compact(["dir/a\tb.txt", "x\x01", "é"]), '["dir/a\\tb.txt","x\\u0001","é"]')


DOCS = """name: ci
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - '**.md'   # a comment
jobs:
  build:
\truns-on: ubuntu-latest
"""


class WorkflowYaml(unittest.TestCase):
    def test_the_block_sequence_is_read_and_a_tab_below_it_is_never_seen(self) -> None:
        # An item's trailing comment is NOT stripped (the awk read the item off the key, not the
        # comment-stripped rest), so it is not unquoted either -- and the glob then refuses it.
        self.assertEqual(
            workflow_yaml.workflow_filter(DOCS, "pull_request", "paths-ignore"), ["docs/**", "'**.md'   # a comment"]
        )
        self.assertIsNone(workflow_yaml.glob_ere("'**.md'   # a comment"))

    def test_a_tab_before_the_answer_refuses(self) -> None:
        text = "on:\n\tpull_request:\n"
        self.assertIsNone(workflow_yaml.workflow_filter(text, "pull_request", "paths-ignore"))
        self.assertIsNone(workflow_yaml.workflow_keys(text, ""))

    def test_the_flow_form_and_its_refusals(self) -> None:
        flow = 'on:\n  pull_request:\n    paths-ignore: ["docs/**", "**.md"]\n'
        self.assertEqual(workflow_yaml.workflow_filter(flow, "pull_request", "paths-ignore"), ["docs/**", "**.md"])
        self.assertIsNone(workflow_yaml.workflow_filter('on:\n  pull_request:\n    paths-ignore: []\n', "pull_request", "paths-ignore"))
        self.assertIsNone(workflow_yaml.workflow_filter("on:\n  pull_request:\n    paths-ignore: *docs\n", "pull_request", "paths-ignore"))
        self.assertIsNone(workflow_yaml.workflow_filter("on:\n  pull_request:\n    paths: [a]\n", "pull_request", "paths-ignore"))

    def test_the_events_in_every_form(self) -> None:
        self.assertEqual(workflow_yaml.workflow_keys(DOCS, ""), ["pull_request"])
        self.assertEqual(workflow_yaml.workflow_keys("on: push\n", ""), ["push"])
        self.assertEqual(workflow_yaml.workflow_keys("on: [push, pull_request]\n", ""), ["push", "pull_request"])
        self.assertEqual(workflow_yaml.workflow_keys(DOCS, "pull_request"), ["paths-ignore"])
        self.assertEqual(workflow_yaml.workflow_keys("on: push\n", "push"), [], "declared with no keys is an answer")
        self.assertIsNone(workflow_yaml.workflow_keys(DOCS, "push"), "a mapping that never reached the event")
        self.assertIsNone(workflow_yaml.workflow_keys("name: x\n", ""), "no trigger at all is a misread file")

    def test_the_glob(self) -> None:
        self.assertEqual(workflow_yaml.glob_ere("docs/**"), "^docs/.*$")
        self.assertEqual(workflow_yaml.glob_ere("*.md"), "^[^/]*\\.md$")
        self.assertIsNone(workflow_yaml.glob_ere("!docs/**"))
        self.assertIsNone(workflow_yaml.glob_ere("docs/?.md"))
        self.assertTrue(workflow_yaml.paths_ignore_covers(["docs/**", "**.md"], ["docs/a.txt", "x/README.md"]))
        self.assertFalse(workflow_yaml.paths_ignore_covers(["docs/**"], ["docs/a.txt", "src/a.ml"]))
        self.assertFalse(workflow_yaml.paths_ignore_covers(["docs/**", "[ab]"], ["docs/a.txt"]),
                         "one untranslatable pattern fails the whole filter")
        self.assertFalse(workflow_yaml.paths_ignore_covers(["*.md"], ["docs/a.md"]), "* stays in one segment")


class Drift(unittest.TestCase):
    def test_hunks_are_read_against_their_headers(self) -> None:
        doc: Json = {"files": [
            {"filename": "a", "patch": "@@ -5 +5,2 @@\n-x\n+y\n+z", "additions": 2, "deletions": 1},
            {"filename": "b", "patch": "@@ -10,3 +10,4 @@\n context", "additions": 0, "deletions": 0},
            {"filename": "c", "patch": "@@ -1,1 +1,1 @@\n-a\n+b", "additions": 3, "deletions": 1},
            {"filename": "d", "patch": "@@ -400,0 +401,2 @@\n+a\n+b", "additions": 2, "deletions": 0},
        ]}
        self.assertEqual(compare_hunks(doc), {"a": [(5, 5)], "b": None, "c": None, "d": [(400, 401)]})

    def test_the_file_set(self) -> None:
        doc: Json = {"files": [{"filename": "new", "previous_filename": "old"}, {"filename": "x"}]}
        self.assertEqual(compare_file_set(doc), (2, ["new", "old", "x"]))
        self.assertIsNone(compare_file_set({"files": [{}]}))
        self.assertIsNone(compare_file_set({"files": [{"filename": "a", "previous_filename": ""}]}))
        self.assertIsNone(compare_file_set({}))


class ClosingKeywords(unittest.TestCase):
    def found(self, text: str, plain: bool = False) -> list[tuple[str, int, str]]:
        return [(f.cls, f.count, f.refs) for f in closekw.scan(text, "example/repo", plain)]

    def test_a_sentence_binding_two_and_the_prescribed_shape(self) -> None:
        self.assertEqual(self.found("The scanner lands. Closes #401 and #402"), [("sentence", 2, "#401 #402")])
        self.assertEqual(self.found("Closes #404\nCloses #405"), [])

    def test_quotes_fences_and_indentation(self) -> None:
        body = "> Closes #205\n\n```\nFixes #206\n```\n\n    Closes #207 and #208\n\nCloses #403\n"
        self.assertEqual(self.found(body), [("quoted", 1, "#205"), ("quoted", 1, "#206")])
        self.assertEqual(self.found("    Resolves #194 and #205", plain=True), [("quoted", 2, "#194 #205")])
        self.assertEqual(self.found("````markdown\n```\nCloses #410\n```\n````\nCloses #411\n"),
                         [("quoted", 1, "#410")])

    def test_urls_dedupe_and_boundaries(self) -> None:
        self.assertEqual(self.found("Closes #606; see https://example.com/docs/#607 and www.example.com/page#608."), [])
        self.assertEqual(self.found("Closes #628 (example/repo#628)."), [])
        self.assertEqual(self.found("Closes Other/Tracker#638 and other/tracker#638"), [])
        self.assertEqual(self.found("Closes #675 after changing #123abc."), [])
        self.assertEqual(self.found("Issues #720 and #721 are now fixed."), [])
        self.assertEqual(self.found("Ceci fix\u00e9s #665 et #666."), [])
        self.assertEqual(self.found("Closes #650 and #651 in release 3.5 of the tool"), [("sentence", 2, "#650 #651")])

    def test_a_negated_mention_and_its_boundary(self) -> None:
        # ocannl-staging#1463's sentence, which closed ahrefs/ocannl#1647 (ludics#815).
        self.assertEqual(self.found("The PR does not close #1647: its items 1 and 2 remain open."),
                         [("negated", 1, "#1647")])
        self.assertEqual(self.found("Doesn't fix #5. NEVER resolves: #6. Cannot close other/x#7."),
                         [("negated", 1, "#5"), ("negated", 1, "#6"), ("negated", 1, "other/x#7")])
        self.assertEqual(self.found("It isn\u2019t closing #8 and won\u2019t close #9"), [("negated", 1, "#9")])
        # The keyword's own finding stands beside it.
        self.assertEqual(self.found("does not close #10 and #11"),
                         [("sentence", 2, "#10 #11"), ("negated", 1, "#10")])
        # Outside the allowlist: a word between, a line break, no reference at once, quoting.
        self.assertEqual(self.found("does not yet close #12. Not to close #13. Not\nclose #14"), [])
        self.assertEqual(self.found("does not close the #15 thread; does not close #16abc"), [])
        self.assertEqual(self.found("> does not close #17"), [("quoted", 1, "#17")])
        self.assertEqual(self.found("    does not close #18", plain=True), [("quoted", 1, "#18")])
        self.assertEqual(self.found("knot close #19. Cannotfix #20."), [])

    def test_control_bytes_are_shown_not_run(self) -> None:
        [finding] = closekw.scan("Closes #709 and #710\x1b[2K\rFORGED", "example/repo", False)
        self.assertEqual(finding.sentence, "Closes #709 and #710?[2K?FORGED")

    def test_a_tsv_message_is_restored(self) -> None:
        self.assertEqual(closekw.tsv_unescape("C:\\\\new\\ttab\\nline"), "C:\\new\ttab\nline")


class Fold(unittest.TestCase):
    def test_conclusion_classes(self) -> None:
        self.assertEqual(
            [conclusion_class(c) for c in ("failure", "skipped", "pending", "", "cancelled", "action_required")],
            ["red", "green", "pending", "pending", "nogo", "nogo"],
        )

    def test_newest_first_breaks_a_same_second_tie_on_the_id(self) -> None:
        rows = "2026-01-01T00:00:00Z\t5\ta\n2026-01-01T00:00:01Z\t3\tb\n2026-01-01T00:00:00Z\t12\tc\n-\t99\td"
        self.assertEqual([r.split("\t")[2] for r in newest_first_lines(rows, 1, 2).split("\n")], ["b", "c", "a", "d"])

    def test_the_advisory_file(self) -> None:
        self.assertEqual(advisory_parse("# c\n\n  # i\n^claude$\r\n^macos$\n", "f"), "^claude$|^macos$")


# --- the gate, in process ---------------------------------------------------------------------------


@dataclass
class Route:
    needles: tuple[str, ...]
    answers: list[proc.Completed]
    served: int = 0

    def next(self) -> proc.Completed:
        a = self.answers[min(self.served, len(self.answers) - 1)]
        self.served += 1
        return a


@dataclass
class FakeGh:
    routes: list[Route] = field(default_factory=lambda: list[Route]())
    calls: list[list[str]] = field(default_factory=lambda: list[list[str]]())

    def on(self, *needles: str, out: str | list[str] = "", rc: int = 0, err: str = "") -> None:
        outs = out if isinstance(out, list) else [out]
        self.routes.append(Route(needles, [proc.Completed(rc, o + "\n" if o else "", err) for o in outs]))

    def __call__(self, name: str, args: Sequence[str]) -> proc.Completed:
        self.calls.append(list(args))
        joined = " ".join(args)
        for route in self.routes:
            if all(n in joined for n in route.needles):
                return route.next()
        raise AssertionError(f"no route for gh {joined}")


@dataclass
class FakeClock:
    t: float = 1767225600.0
    sleeps: list[float] = field(default_factory=lambda: list[float]())

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


def make_gate(gh: FakeGh, clock: FakeClock, select: str = "", **env: str) -> Gate:
    config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0, api_attempts=1, api_backoff=0)
    session = GhSession(config, run=gh, sleep=lambda _s: None)
    gate_config = load_gate_config({"SHIP_PR_CHECKS_INTERVAL": "60", **env})
    gate = Gate(session, "o/r", gate_config, FuncClock(time=clock.now, sleep=clock.sleep))
    gate.select = select
    return gate


class GateLoop(unittest.TestCase):
    def setUp(self) -> None:
        # The gate prints its report; keep it out of the test runner's output.
        self.out = io.StringIO()
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        stack.enter_context(contextlib.redirect_stderr(self.out))
        self.addCleanup(stack.close)

    def test_a_wait_holds_a_running_check_and_ends_on_its_verdict(self) -> None:
        gh = FakeGh()
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        gh.on("pulls/7", out="h1\tb1\ttopic")
        gh.on("check-runs", out=["ci\tpending\tu\t1", "ci\tsuccess\tu\t1"])
        gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1")
        clock = FakeClock()
        gate = make_gate(gh, clock)
        rc = gate.check("7", 600)
        self.assertEqual((rc, gate.verdict, gate.check_sha, gate.gate_base), (0, "green", "h1", "b1"))
        self.assertEqual(clock.sleeps, [60], "one interval between the two reads")

    def test_a_superseded_head_is_five_and_an_unread_reread_is_three(self) -> None:
        for second, want in (("h2\tb1\ttopic", 5), ("", 3)):
            # The unread re-read under a wait (600) is read again until the wait is spent: 3.
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out=second, rc=0 if second else 1, err="" if second else "gh: HTTP 503")
            gh.on("check-runs", out="ci\tsuccess\tu\t1")
            gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1")
            with self.subTest(second=second):
                self.assertEqual(make_gate(gh, FakeClock()).check("7", 600), want)

    def test_a_wait_rides_out_failed_head_reads_and_merges_on_the_first_answer(self) -> None:
        # ludics-lite#795: each head read's four attempts spent, five times over (twenty calls),
        # then an answer -- the wait goes on, and the round after the answer is judged.
        for again in (False, True):
            gh = FakeGh()
            fail = proc.Completed(1, "", "gh: HTTP 503")
            first = proc.Completed(0, "h1\t2026-01-01T00:00:00Z\tb1\ttopic\n", "")
            reread = proc.Completed(0, "h1\tb1\ttopic\n", "")
            gh.routes.append(Route(("pulls/7", ".updated_at"), [fail] * 20 + [first] if not again else [first]))
            gh.routes.append(Route(("pulls/7",), [fail] * 20 + [reread] if again else [reread]))
            gh.on("check-runs", out="ci\tsuccess\tu\t1")
            gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1")
            clock = FakeClock()
            gate = make_gate(gh, clock)
            gate.session.config = replace(gate.session.config, api_attempts=4)
            with self.subTest(again=again):
                self.assertEqual((gate.check("7", 3600), gate.verdict, gate.gate_base), (0, "green", "b1"))
                self.assertEqual(len(gate.unread), 5, "five failed reads, each recorded")
                self.assertIn("5 read(s) failed during this wait", gate.unread_note())
                self.assertEqual(clock.sleeps, [60] * 5, "a pause between them (no budget: its cap is the interval)")

    def test_a_head_that_never_reads_is_three_once_the_budget_is_spent(self) -> None:
        for again in (False, True):
            gh = FakeGh()
            if again:
                gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", rc=1, err="gh: HTTP 503")
            gh.on("check-runs", out="ci\tsuccess\tu\t1")
            gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1")
            clock = FakeClock()
            gate = make_gate(gh, clock)
            with self.subTest(again=again):
                self.assertEqual((gate.check("7", 900), gate.verdict), (3, "unknown"))
                self.assertGreaterEqual(clock.t - FakeClock().t, 900, "only once the wait is spent")
                self.assertIn("reads failed during this wait, and its budget is spent", self.out.getvalue())

    def test_a_refused_or_unwaited_head_read_is_three_at_once(self) -> None:
        # The negative controls: a 404 no retry changes, and a read with no wait to ride it out in.
        # And a read the polling budget stopped (a quota refusal; with no budget, not waited out).
        for err, wait, why in (("gh: Not Found (HTTP 404)", 3600, "GitHub refused the read"),
                               ("gh: API rate limit exceeded for user", 3600, "the polling budget made no call"),
                               ("gh: HTTP 503", 0, "with no wait left to read it again in")):
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", rc=1, err=err)
            gh.on("check-runs", out="ci\tsuccess\tu\t1")
            gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1")
            clock = FakeClock()
            with self.subTest(err=err):
                self.assertEqual(make_gate(gh, clock).check("7", wait), 3)
                self.assertEqual((clock.sleeps, len(gh.routes[1].answers), gh.routes[1].served), ([], 1, 1))
                self.assertIn(why, self.out.getvalue())

    def test_an_answer_without_a_sha_is_read_again_and_a_moved_head_is_still_five(self) -> None:
        gh = FakeGh()
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        gh.on("pulls/7", out=["-\t-\t-", "h2\tb1\ttopic"])
        gh.on("check-runs", out="ci\tsuccess\tu\t1")
        gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1")
        gate = make_gate(gh, FakeClock())
        self.assertEqual((gate.check("7", 600), gate.verdict), (5, "superseded"))
        self.assertEqual(gate.unread, ["re-read o/r#7's head SHA: it answered no SHA"])

    def test_a_wait_rides_out_failed_check_and_run_reads(self) -> None:
        # ludics#808: a round's check-run read, or its workflow-run read, that did not answer is one
        # failed poll, as a head read is (#795): the round is read again, and the first round whose
        # reads answer is judged. A failed round of the run read asks once (ludics#929: the
        # advisory workflow lookup's failure is run_signal's too), its four attempts spent.
        ok_runs = "2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1"
        for route, fails in (("check-runs", 8), ("actions/runs?head_sha=h1", 8)):
            gh = FakeGh()
            fail = proc.Completed(1, "", "gh: HTTP 503")
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            answers = {"check-runs": "ci\tsuccess\tu\t1\n", "actions/runs?head_sha=h1": ok_runs + "\n"}
            for needle, out in answers.items():
                served = [fail] * fails + [proc.Completed(0, out, "")] if needle == route else [proc.Completed(0, out, "")]
                gh.routes.append(Route((needle,), served))
            clock = FakeClock()
            gate = make_gate(gh, clock)
            gate.session.config = replace(gate.session.config, api_attempts=4)
            with self.subTest(route=route):
                self.assertEqual((gate.check("7", 3600), gate.verdict), (0, "green"))
                self.assertEqual(len(gate.unread), 2, "two failed rounds, each recorded")
                self.assertIn("2 read(s) failed during this wait", gate.unread_note())
                self.assertIn("failed read 2 of this wait, reading it again", self.out.getvalue())
                self.assertEqual(clock.sleeps, [60] * 2, "a pause after each")
                reads = [c for c in gh.calls if any(route in a for a in c)]
                self.assertEqual(len(reads), fails + 1, "the third round's read answered, read once")

    def test_a_red_whose_jobs_do_not_answer_is_one_failed_poll(self) -> None:
        # ludics#929: a red run whose job list did not answer is neither explained nor unexplained.
        # Under a wait it is one failed poll, and the round that reads the jobs judges it: a red
        # only an advisory job explains is green, not a run-level RED. The controls: a red the round
        # did read decides it first; a refusal, or no wait, is 3 (UNKNOWN), never RED.
        old = "2025-12-31T23:00:00Z"
        fail = proc.Completed(1, "", "gh: HTTP 503")
        runs = "2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tfailure\t1"
        lint = "2026-01-01T00:00:00Z\t101\t2\tpush\tlint\tcompleted\tfailure\t2"
        advisory_red = f"ci\tsuccess\t{old}\t{old}\nmacos\tfailure\t{old}\t{old}\n"
        cases = (
            ([fail] * 4, runs, 3600, (0, "green"), "failed read 1 of this wait, reading it again"),
            ([fail] * 4, f"{runs}\n{lint}", 3600, (1, "runred"), "concluded red with no build check"),
            ([proc.Completed(1, "", "gh: Not Found (HTTP 404)")], runs, 3600, (3, "unknown"),
             "GitHub refused the read"),
            ([fail] * 4, runs, 0, (3, "unknown"), "with no wait left to read it again in"),
        )
        for failed, run_list, wait, want, said in cases:
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            gh.on("check-runs", out="ci\tsuccess\tu\t1\tcompleted")
            gh.on("actions/runs?head_sha=h1", out=run_list)
            gh.routes.append(Route(("actions/runs/100/jobs",), [*failed, proc.Completed(0, advisory_red, "")]))
            gh.on("actions/runs/101/jobs", out=f"lint\tfailure\t{old}\t{old}")
            clock = FakeClock()
            gate = make_gate(gh, clock, SHIP_PR_ADVISORY_CHECKS="^macos$")
            gate.session.config = replace(gate.session.config, api_attempts=4)
            self.out.truncate(0)
            self.out.seek(0)
            with self.subTest(want=want, said=said):
                self.assertEqual((gate.check("7", wait), gate.verdict), want)
                self.assertIn(said, self.out.getvalue())
                if want[1] == "unknown":
                    self.assertIn("could not read the jobs of workflow run 100 (ci, failure)", self.out.getvalue())
                    self.assertEqual(clock.sleeps, [], "no pause")

    def test_a_round_read_that_never_answers_is_three_once_the_budget_is_spent(self) -> None:
        # The run-less head's commit-date read is the run read's too: with no clock from it, the
        # round decides nothing, and a failed one is read again like the others.
        for route in ("check-runs", "actions/runs?head_sha=h1", "commits/h1"):
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2099-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            for needle in ("check-runs", "actions/runs?head_sha=h1", "commits/h1"):
                if needle == route:
                    gh.on(needle, rc=1, err="gh: HTTP 503")
                else:
                    gh.on(needle, out="")
            clock = FakeClock()
            gate = make_gate(gh, clock)
            with self.subTest(route=route):
                self.assertEqual((gate.check("7", 900), gate.verdict), (3, "unknown"))
                self.assertGreaterEqual(clock.t - FakeClock().t, 900, "only once the wait is spent")
                self.assertIn("reads failed during this wait, and its budget is spent", self.out.getvalue())
                self.assertIn("UNKNOWN, which is NOT 'nothing is red'", self.out.getvalue())

    def test_a_refused_held_unusable_or_unwaited_round_read_is_three_at_once(self) -> None:
        # The negative controls of #808, as for the head read: a 404, a read the polling budget
        # stopped, an answer that decides nothing however often it is read (a run-less head whose
        # only clocks are in the future), and any failure with no wait to ride it out in.
        cases = [
            (route, err, wait, why)
            for route in ("check-runs", "actions/runs?head_sha=h1")
            for err, wait, why in (
                ("gh: Not Found (HTTP 404)", 3600, "GitHub refused the read"),
                ("gh: API rate limit exceeded for user", 3600, "the polling budget made no call"),
                ("gh: HTTP 503", 0, "with no wait left to read it again in"),
            )
        ] + [("commits/h1", "", 3600, "what it answered decides nothing")]
        for route, err, wait, why in cases:
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2099-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            for needle in ("check-runs", "actions/runs?head_sha=h1"):
                if needle == route:
                    gh.on(needle, rc=1, err=err)
                else:
                    gh.on(needle, out="")
            gh.on("commits/h1", out="2099-01-01T00:00:00Z")
            clock = FakeClock()
            self.out.truncate(0)
            self.out.seek(0)
            with self.subTest(route=route, err=err, wait=wait):
                self.assertEqual(make_gate(gh, clock).check("7", wait), 3)
                self.assertEqual(clock.sleeps, [], "no pause")
                self.assertIn(why, self.out.getvalue())

    def test_a_head_that_moves_over_a_failing_round_read_is_five_at_once(self) -> None:
        # A failed round skips the round's own head re-read; the head is read after it instead, so
        # a push over a failing read is SUPERSEDED on that round, not 3 once the wait is spent.
        for route in ("check-runs", "actions/runs?head_sha=h1"):
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h2\tb1\ttopic")
            for needle in ("check-runs", "actions/runs?head_sha=h1"):
                if needle == route:
                    gh.on(needle, rc=1, err="gh: HTTP 503")
                else:
                    gh.on(needle, out="ci\tsuccess\tu\t1")
            clock = FakeClock()
            gate = make_gate(gh, clock)
            with self.subTest(route=route):
                self.assertEqual((gate.check("7", 3600), gate.verdict), (5, "superseded"))
                self.assertEqual((clock.sleeps, len(gate.unread)), ([], 1), "on the first failed round")

    def test_a_recording_round_whose_run_read_fails_keeps_its_record(self) -> None:
        # merge --override records the reds of its first round. A round whose run read failed had
        # recorded them already: the next round applies that record, so a check that turned red
        # during the pause is not waived as red when --override was given.
        gh = FakeGh()
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        gh.on("pulls/7", out="h1\tb1\ttopic")
        gh.on("check-runs", out=["ci\tfailure\tu\t1", "ci\tfailure\tu\t1\nlint\tfailure\tu\t1"])
        ok_runs = proc.Completed(0, "2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tfailure\t1\n", "")
        gh.routes.append(Route(("actions/runs?head_sha=h1",), [proc.Completed(1, "", "gh: HTTP 503")] * 2 + [ok_runs]))
        gh.on("actions/runs/100/jobs", out="ci\tfailure\t2026-01-01T00:00:00Z\t2026-01-01T00:01:00Z")
        clock = FakeClock()
        gate = make_gate(gh, clock)
        self.assertEqual((gate.check("7", 3600, waive=True), gate.verdict), (1, "red"))
        self.assertEqual(gate.waived, {"check:1/ci"}, "the first round's record, and only it")
        self.assertEqual((gate.check_waived, gate.check_red), (1, 1), "ci waived, lint red")

    def test_a_checkless_head_inside_the_grace_holds_and_past_it_is_absent(self) -> None:
        for commit, want, verdict in (("2026-01-01T00:00:00Z", 0, "absent"), ("2025-12-31T23:59:00Z", 4, "unjudged")):
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2025-01-01T00:00:00Z\t-\ttopic")
            gh.on("pulls/7", out="h1\t-\ttopic")
            gh.on("check-runs", out="")
            gh.on("actions/runs?head_sha=h1", out="")
            gh.on("commits/h1", out=commit)
            clock = FakeClock(t=1767225600.0 + 3600) if verdict == "absent" else FakeClock()
            with self.subTest(verdict=verdict):
                gate = make_gate(gh, clock)
                self.assertEqual((gate.check("7", 0), gate.verdict), (want, verdict))

    def test_a_cancelled_job_of_an_advisory_workflow_does_not_hold_the_gate(self) -> None:
        # ludics-lite#785: the check is named for its job (build), the list for its workflow; the
        # run's check suite (2) ties the two together. Without the workflow named, it holds.
        for env, want, verdict in (({}, 0, "green"), ({"SHIP_PR_ADVISORY_CHECKS": "^claude$"}, 4, "unjudged")):
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            gh.on("check-runs", out="ci\tsuccess\tu\t1\tcompleted\nbuild\tcancelled\tv\t2\tcompleted")
            gh.on("actions/runs?head_sha=h1", out=(
                "2026-01-01T00:00:00Z\t100\t1\tpush\tci\tcompleted\tsuccess\t1\n"
                "2026-01-01T00:00:00Z\t101\t2\tpull_request\tgithub pages docs\tcompleted\tcancelled\t2"))
            gh.on("actions/runs/101/jobs", out="build\tcancelled\t-\t-")
            with self.subTest(env=env):
                gate = make_gate(gh, FakeClock(), **env)
                self.assertEqual((gate.check("7", 0), gate.verdict), (want, verdict))
                runs = [c for c in gh.calls if any("actions/runs?head_sha" in a for a in c)]
                self.assertEqual(len(runs), 1, "the fold and the run signal share the round's run read")

    def test_the_waiver_records_the_first_read_only(self) -> None:
        gh = FakeGh()
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        gh.on("pulls/7", out="h1\tb1\ttopic")
        gh.on("check-runs", out=["ubuntu\tfailure\tu\t1\nmacos\tpending\tm\t1",
                                 "ubuntu\tfailure\tu\t1\nmacos\tfailure\tm\t1"])
        gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tin_progress\tpending\t1")
        gh.on("actions/runs/100/jobs", out="")
        gate = make_gate(gh, FakeClock())
        self.assertEqual(gate.check("7", 600, waive=True), 1)
        self.assertEqual((gate.verdict, gate.waived), ("red", {"check:1/ubuntu"}))

    def test_a_released_run_names_the_advisory_lists_source(self) -> None:
        old = "2025-12-31T23:00:00Z"
        for mode, source in (("env", "SHIP_PR_ADVISORY_CHECKS"),
                             ("file", ".github/ship-pr-advisory-checks"), ("default", "built-in defaults")):
            with self.subTest(mode=mode):
                gh = FakeGh()
                gh.on("actions/runs?head_sha=h1",
                      out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tin_progress\tpending\t1")
                gh.on("actions/runs/100/jobs", out=f"build\tsuccess\t{old}\t{old}\nclaude\tpending\t{old}\t-")
                env = {"SHIP_PR_ADVISORY_CHECKS": "^claude$"} if mode == "env" else {}
                gate = make_gate(gh, FakeClock(), **env)
                if mode == "file":
                    gh.on("contents/.github/ship-pr-advisory-checks", out="^claude$")
                elif mode == "default":
                    gh.on("contents/.github/ship-pr-advisory-checks", rc=1, err="gh: Not Found (HTTP 404)")
                    gh.on("contents/.github", out="0")
                self.assertEqual(gate.advisory_policy(), 0)
                signal = gate.run_signal("h1", "2026-01-01T00:00:00Z", 1, "b1", "topic", "7")
                self.assertEqual(signal.rc, 0)
                self.assertIn(f"only advisory jobs ({source})", signal.reason)

    def test_a_waived_red_releases_a_run_left_running_only_advisory_jobs(self) -> None:
        # ludics#862: a red the override waived is a verdict read, so beside a queued advisory leg
        # it releases the run as a green job would. The controls hold: no waiver (the plain red
        # verdict), the run in another suite, a second unwaived red, a waived name two jobs share.
        old = "2025-12-31T23:00:00Z"
        cases = (
            (True, "1", f"ubuntu\tfailure\t{old}\t{old}", (1, "waived")),
            (False, "1", f"ubuntu\tfailure\t{old}\t{old}", (1, "red")),
            (True, "2", f"ubuntu\tfailure\t{old}\t{old}", (4, "unjudged")),
            (True, "1", f"ubuntu\tfailure\t{old}\t{old}\ntest\tfailure\t{old}\t{old}", (4, "unjudged")),
            (True, "1", f"ubuntu\tfailure\t{old}\t{old}\nubuntu\tfailure\t{old}\t{old}", (4, "unjudged")),
        )
        for waive, suite, jobs, want in cases:
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            gh.on("check-runs", out="ubuntu\tfailure\tu\t1\tcompleted\nmacos\tpending\tm\t1\tqueued")
            gh.on("actions/runs?head_sha=h1",
                  out=f"2026-01-01T00:00:00Z\t100\t1\tpush\tci\tin_progress\tpending\t{suite}")
            gh.on("actions/runs/100/jobs", out=f"{jobs}\nmacos\tpending\t{old}\t-")
            with self.subTest(waive=waive, suite=suite, jobs=jobs):
                gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
                self.assertEqual((gate.check("7", 0, waive=waive), gate.verdict), want)

    def test_a_waived_cancel_releases_a_run_left_running_only_advisory_jobs(self) -> None:
        # #1036 (review round 1): a cancelled check the override waived releases the run beside a
        # queued advisory leg, as a waived red does (#862). The controls hold: no waiver, a waived
        # name two jobs share, and a non-advisory job still running.
        old = "2025-12-31T23:00:00Z"
        cases = (
            (True, f"ubuntu\tcancelled\t{old}\t{old}", (1, "waived")),
            (False, f"ubuntu\tcancelled\t{old}\t{old}", (4, "unjudged")),
            (True, f"ubuntu\tcancelled\t{old}\t{old}\nubuntu\tcancelled\t{old}\t{old}", (4, "unjudged")),
            (True, f"ubuntu\tcancelled\t{old}\t{old}\ntest\tpending\t{old}\t-", (4, "unjudged")),
        )
        for waive, jobs, want in cases:
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            gh.on("check-runs", out="ubuntu\tcancelled\tu\t1\tcompleted\nmacos\tpending\tm\t1\tqueued")
            gh.on("actions/runs?head_sha=h1",
                  out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tin_progress\tpending\t1")
            gh.on("actions/runs/100/jobs", out=f"{jobs}\nmacos\tpending\t{old}\t-")
            with self.subTest(waive=waive, jobs=jobs):
                gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
                self.assertEqual((gate.check("7", 0, waive=waive), gate.verdict), want)

    def test_an_inflight_hold_names_its_run_job_and_reason(self) -> None:
        # ludics#930: a hold that named no cause got #862 filed against the wrong one. Each way the
        # advisory release fails names the run, the first job in list order that kept it, and why;
        # a released run has no line. The waived cases read the waiver of a recorded red ``ubuntu``.
        old = "2025-12-31T23:00:00Z"
        new = "2025-12-31T23:59:55Z"
        leg = f"macos\tpending\t{old}\t-"
        cases = (
            (f"build\tsuccess\t{old}\t{old}\n{leg}", None, None),
            (f"build\tsuccess\t{old}\t{old}\ntest\tpending\t{old}\t-\n{leg}", None,
             "job test is still running (or queued) and is not advisory"),
            (f"build\tfailure\t{old}\t{old}\n{leg}", None, "job build concluded failure, red and not waived"),
            (f"ubuntu\tfailure\t{old}\t{old}\nubuntu\tfailure\t{old}\t{old}\n{leg}", {"check:1/ubuntu"},
             "job ubuntu concluded failure, red, and the waiver cannot single it out: 2 jobs of the run share its name"),
            (f"build\tcancelled\t{old}\t{old}\n{leg}", None, "job build concluded cancelled, stopped and not judged"),
            (f"build\tsuccess\t{old}\t{new}\n{leg}", None,
             "its job list last changed 5s ago (job build), inside the 1m settle"),
            (f"build\tsuccess\t{old}\t{old}\nmacos\tpending\t-\t-", None,
             "job macos has no created_at, so the settle cannot place it (untimed)"),
            (f"build\tsuccess\t{old}\t-\n{leg}", None,
             "job build concluded success with no completed_at, so the settle cannot place it (untimed)"),
            (f"build\tsuccess\t{old}\t{old}\nmacos\tsuccess\t{old}\t{old}", None,
             "none of its jobs is unfinished: it is between jobs or finishing"),
            ("", None, "it lists no jobs yet"),
            (f"build\tsuccess\t2026-01-01T01:00:00Z\t2026-01-01T01:00:00Z\n{leg}", None,
             "its newest job stamp (job build, 2026-01-01T01:00:00Z) is unreadable or in the future (untimed)"),
        )
        for jobs, waived, want in cases:
            gh = FakeGh()
            gh.on("actions/runs/100/jobs", out=jobs)
            gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
            gate.waived = waived or set()
            with self.subTest(jobs=jobs):
                hold = gate.run_inflight_hold("100", "1")
                if want is None:
                    self.assertIsNone(hold)
                else:
                    assert hold is not None
                    self.assertIn(want, hold)
                self.assertEqual(gate.run_inflight_is_advisory_only("100", "1"), want is None)
        gh = FakeGh()
        gh.on("actions/runs/100/jobs", rc=1, err="gh: HTTP 503")
        gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
        self.assertEqual(
            gate.run_inflight_hold("100", "1"),
            "its job list could not be read (gh: HTTP 503), so whether only advisory jobs are left is unknown",
        )
        # Through ``checks``: the line follows the NO VERDICT YET headline, named by run and workflow.
        gh = FakeGh()
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        gh.on("pulls/7", out="h1\tb1\ttopic")
        gh.on("check-runs", out="build\tsuccess\tu\t1\tcompleted")
        gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tmain 1/2\tin_progress\tpending\t1")
        gh.on("actions/runs/100/jobs", out=f"build\tsuccess\t{old}\t{old}\ntest\tpending\t{old}\t-\n{leg}")
        gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
        self.out.truncate(0)
        self.out.seek(0)
        self.assertEqual((gate.check("7", 0), gate.verdict), (4, "unjudged"))
        self.assertIn(
            "\n  held     workflow run 100 ('main 1/2'): job test is still running (or queued) and is not advisory\n",
            self.out.getvalue(),
        )

    def test_a_run_cancelled_only_in_advisory_jobs_releases_and_any_other_holds(self) -> None:
        # ludics#958: the advisory macOS legs of the non-advisory ``skill scripts`` workflow,
        # cancelled at their cap, held the gate as a stopped run. Released when an advisory job was
        # stopped (or left unfinished) and every other job passed; each other shape names its hold.
        t = "2025-12-31T23:00:00Z"
        cases = (
            (f"build\tsuccess\t{t}\t{t}\nmacos\tcancelled\t{t}\t{t}", None),
            (f"build\tskipped\t{t}\t{t}\nmacos\tpending\t{t}\t-", None),
            (f"build\tcancelled\t{t}\t{t}\nmacos\tcancelled\t{t}\t{t}", "job build concluded cancelled and is not advisory"),
            (f"build\tfailure\t{t}\t{t}\nmacos\tcancelled\t{t}\t{t}", "job build concluded failure and is not advisory"),
            (f"build\tpending\t{t}\t-\nmacos\tcancelled\t{t}\t{t}", "job build concluded pending and is not advisory"),
            (f"build\tsuccess\t{t}\t{t}\nmacos\tsuccess\t{t}\t{t}", "no advisory job of it was stopped"),
            ("", "no advisory job of it was stopped"),
        )
        for jobs, want in cases:
            gh = FakeGh()
            gh.on("actions/runs/100/jobs", out=jobs)
            gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
            with self.subTest(jobs=jobs):
                hold = gate.run_stopped_hold("100")
                if want is None:
                    self.assertIsNone(hold)
                else:
                    assert hold is not None
                    self.assertEqual(hold[1], False)
                    self.assertIn(want, hold[0])
        gh = FakeGh()
        gh.on("actions/runs/100/jobs", rc=1, err="gh: HTTP 503")
        gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
        self.assertEqual(
            gate.run_stopped_hold("100"),
            ("its job list could not be read (gh: HTTP 503), so whether only advisory jobs were stopped is unknown",
             True),
        )
        # Through ``checks``: released, the run is named as stopped and not rerun; held (and an
        # unread job list too), the stopped 4 it was, with its held line.
        for jobs, rc, want in (
            (f"build\tsuccess\t{t}\t{t}\nmacos\tcancelled\t{t}\t{t}", (0, "green"),
             "  stopped  1 workflow run(s) for this head are judged — 1 of them cancelled only in advisory jobs"),
            (f"build\tsuccess\t{t}\t{t}\ntest\tcancelled\t{t}\t{t}", (4, "unjudged"),
             "  held     workflow run 100 ('skill scripts'): job test concluded cancelled and is not advisory\n"),
            (None, (4, "unjudged"), "  held     workflow run 100 ('skill scripts'): its job list could not be read"),
        ):
            gh = FakeGh()
            gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
            gh.on("pulls/7", out="h1\tb1\ttopic")
            gh.on("check-runs", out="build\tsuccess\tu\t1\tcompleted\nmacos\tcancelled\tm\t1\tcompleted")
            gh.on("actions/runs?head_sha=h1",
                  out="2026-01-01T00:00:00Z\t100\t1\tpush\tskill scripts\tcompleted\tcancelled\t1")
            if jobs is None:
                gh.on("actions/runs/100/jobs", rc=1, err="gh: HTTP 503")
            else:
                gh.on("actions/runs/100/jobs", out=jobs)
            gate = make_gate(gh, FakeClock(), SHIP_PR_ADVISORY_CHECKS="^macos$")
            self.out.truncate(0)
            self.out.seek(0)
            with self.subTest(jobs=jobs):
                self.assertEqual((gate.check("7", 0), gate.verdict), rc)
                self.assertIn(want, self.out.getvalue())

    # --- what no wait resolves (ludics#1107, #1110, #1097) -------------------------------------------

    def quiet_head(self, gh: FakeGh, mergeable: str | None = "", checks: str | list[str] = "") -> None:
        """A head whose PR reads answer; ``mergeable``: what the conflict read answers (None: a
        503; "": it has no route of its own, so the plain head read answers it, which is no
        ``dirty``)."""
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        if mergeable is None:
            gh.on("pulls/7", ".mergeable_state", rc=1, err="gh: HTTP 503")
        elif mergeable:
            gh.on("pulls/7", ".mergeable_state", out=mergeable)
        gh.on("pulls/7", out="h1\tb1\ttopic")
        gh.on("check-runs", out=checks)

    def conflict_reads(self, gh: FakeGh) -> int:
        return len([c for c in gh.calls if any(".mergeable_state" in a for a in c)])

    def test_a_never_started_run_beside_a_later_completed_one_is_superseded(self) -> None:
        # ludics#1107: pull_request run 100 sat queued with no job while run 200, of the same
        # workflow and event on the same head and created after it, completed. The controls keep
        # today's hold: the run alone; one with a job (it started); one in progress; another
        # workflow's; another event's; a workflow_dispatch or push pair (invocations of their own);
        # one created after the completed run; one whose job list did not answer.
        def old(status: str = "queued", wid: str = "1", event: str = "pull_request", at: str = "00:00") -> str:
            return f"2026-01-01T00:{at}Z\t100\t{wid}\t{event}\tci\t{status}\tpending\t1"

        def later(conclusion: str = "success", event: str = "pull_request") -> str:
            return f"2026-01-01T00:05:00Z\t200\t1\t{event}\tci\tcompleted\t{conclusion}\t2"

        job = "build\tpending\t2026-01-01T00:00:00Z\t-"
        passed, failed = "ci\tsuccess\tu\t2\tcompleted", "ci\tfailure\tu\t2\tcompleted"
        cases: tuple[tuple[str, str | None, str, tuple[int, str], bool], ...] = (
            (f"{later()}\n{old()}", "", passed, (0, "green"), True),
            (f"{later('failure')}\n{old()}", "", failed, (1, "red"), False),
            (f"{later('failure')}\n{old()}", "", "", (1, "runred"), False),
            (old(), "", passed, (4, "unjudged"), False),
            (f"{later()}\n{old()}", job, passed, (4, "unjudged"), False),
            (f"{later()}\n{old(status='in_progress')}", "", passed, (4, "unjudged"), False),
            (f"{later()}\n{old(wid='2')}", "", passed, (4, "unjudged"), False),
            (f"{later()}\n{old(event='push')}", "", passed, (4, "unjudged"), False),
            (f"{later(event='push')}\n{old(event='push')}", "", passed, (4, "unjudged"), False),
            (f"{later(event='workflow_dispatch')}\n{old(event='workflow_dispatch')}", "", passed,
             (4, "unjudged"), False),
            (f"{later()}\n{old(at='09:00')}", "", passed, (4, "unjudged"), False),
            (f"{later()}\n{old()}", None, passed, (4, "unjudged"), False),
        )
        for runs, jobs, checks, want, named in cases:
            gh = FakeGh()
            self.quiet_head(gh, checks=checks)
            gh.on("actions/runs?head_sha=h1", out=runs)
            if jobs is None:
                gh.on("actions/runs/100/jobs", rc=1, err="gh: HTTP 503")
            else:
                gh.on("actions/runs/100/jobs", out=jobs)
            gh.on("actions/runs/200/jobs", out="build\tfailure\t2026-01-01T00:05:00Z\t2026-01-01T00:06:00Z")
            gate = make_gate(gh, FakeClock())
            self.out.truncate(0)
            self.out.seek(0)
            with self.subTest(runs=runs, jobs=jobs, checks=checks):
                self.assertEqual((gate.check("7", 0), gate.verdict), want)
                line = (
                    "\n  superseded  workflow run 100 (ci): queued with no job, never started; run 200 of the"
                    " same workflow and event completed on this head after it — not waited for\n"
                )
                (self.assertIn if named else self.assertNotIn)(line, self.out.getvalue())

    def test_a_quiet_wait_ends_on_a_conflict_and_only_on_one_that_was_read(self) -> None:
        # ludics#1110: the head's run has no job, wait or no. Past the grace (300s) each quiet round
        # reads the PR's mergeable_state: dirty is the conflict verdict; unknown, clean and a read
        # that did not answer keep the wait, and the next round reads again.
        queued = "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\tqueued\tpending\t1"
        for state, want, sleeps, reads in (
            ("dirty", (4, "conflict"), 5, 1),
            ("unknown", (4, "unjudged"), 20, 16),
            ("clean", (4, "unjudged"), 20, 16),
            (None, (4, "unjudged"), 20, 16),
        ):
            gh = FakeGh()
            self.quiet_head(gh, state)
            gh.on("actions/runs?head_sha=h1", out=queued)
            gh.on("actions/runs/100/jobs", out="")
            clock = FakeClock()
            gate = make_gate(gh, clock)
            gate.conflicts_on = True
            self.out.truncate(0)
            self.out.seek(0)
            with self.subTest(state=state):
                self.assertEqual((gate.check("7", 1200), gate.verdict), want)
                self.assertEqual(clock.sleeps, [60] * sleeps)
                self.assertEqual(self.conflict_reads(gh), reads, "none inside the grace, one a round after it")
                said = "CONFLICTS with its base (mergeable_state=dirty)"
                (self.assertIn if state == "dirty" else self.assertNotIn)(said, self.out.getvalue())
                if state == "dirty":
                    self.assertIn("Merge the base in, resolve, push", self.out.getvalue())

    def test_the_conflict_read_is_made_only_on_a_round_with_nothing_to_wait_for(self) -> None:
        # The controls: a check still running (its verdict comes), a single read (no grace has
        # passed), and a gate that does not ask (``base``'s, of a merged head).
        queued = "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\tqueued\tpending\t1"
        for checks, wait, on, want in (
            ("ci\tpending\tu\t1\tin_progress", 1200, True, (4, "pending")),
            ("", 0, True, (4, "unjudged")),
            ("", 1200, False, (4, "unjudged")),
        ):
            gh = FakeGh()
            self.quiet_head(gh, "dirty", checks)
            gh.on("actions/runs?head_sha=h1", out=queued)
            gh.on("actions/runs/100/jobs", out="")
            gate = make_gate(gh, FakeClock())
            gate.conflicts_on = on
            with self.subTest(checks=checks, wait=wait, on=on):
                self.assertEqual((gate.check("7", wait), gate.verdict), want)
                self.assertEqual(self.conflict_reads(gh), 0)

    def test_an_absent_head_that_conflicts_is_a_conflict_at_once(self) -> None:
        # A head GitHub cannot build has no run at all, which past the creation grace reads ABSENT:
        # that round asks before it answers, with no wait and no further grace.
        for state, want in (("dirty", (4, "conflict")), ("unknown", (0, "absent")), ("clean", (0, "absent")),
                            (None, (0, "absent"))):
            gh = FakeGh()
            self.quiet_head(gh, state)
            gh.on("actions/runs?head_sha=h1", out="")
            gh.on("commits/h1", out="2026-01-01T00:00:00Z")
            gate = make_gate(gh, FakeClock(t=1767225600.0 + 3600))
            gate.conflicts_on = True
            with self.subTest(state=state):
                self.assertEqual((gate.check("7", 0), gate.verdict), want)
                self.assertEqual(self.conflict_reads(gh), 1)

    def test_a_checks_wait_ends_on_a_stopped_run_nothing_reruns(self) -> None:
        # ludics#1097: a cancelled run with no build check behind it holds the head, and nothing
        # moves until someone re-runs it. With no recovery the wait ends once that has lasted the
        # grace; ``merge --wait``'s recovery (here one that has nothing to do) keeps its own wait.
        t = "2025-12-31T23:00:00Z"
        stopped = "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tcancelled\t1"
        for recovers, sleeps in ((False, 5), (True, 60)):
            gh = FakeGh()
            self.quiet_head(gh)
            gh.on("actions/runs?head_sha=h1", out=stopped)
            gh.on("actions/runs/100/jobs", out=f"build\tcancelled\t{t}\t{t}")
            clock = FakeClock()
            gate = make_gate(gh, clock)
            if recovers:
                gate.orphans_on = True
                gate.recover = lambda _orphans, _runs: Idle()
            self.out.truncate(0)
            self.out.seek(0)
            with self.subTest(recovers=recovers):
                self.assertEqual((gate.check("7", 3600), gate.verdict), (4, "unjudged"))
                self.assertEqual(clock.sleeps, [60] * sleeps)
                self.assertIn("completed stopped-not-judged", self.out.getvalue())

    def test_the_stopped_grace_is_counted_from_the_first_stopped_round(self) -> None:
        # A head quiet for longer than the grace on a run with no job, which is then cancelled: the
        # stopped rounds get a grace of their own, not what is left of the quiet one (the local
        # review's finding on this change). Six rounds queued (to 300 s), then cancelled for good.
        t = "2025-12-31T23:00:00Z"
        run = "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\t"
        gh = FakeGh()
        self.quiet_head(gh)
        gh.on("actions/runs?head_sha=h1", out=[f"{run}queued\tpending\t1"] * 6 + [f"{run}completed\tcancelled\t1"])
        gh.on("actions/runs/100/jobs", out=[""] * 6 + [f"build\tcancelled\t{t}\t{t}"])
        clock = FakeClock()
        gate = make_gate(gh, clock)
        self.assertEqual((gate.check("7", 3600), gate.verdict), (4, "unjudged"))
        self.assertEqual(clock.sleeps, [60] * 11, "six queued rounds, then five more before the stopped grace ends it")

    def test_a_stopped_run_rerun_inside_the_grace_is_waited_for(self) -> None:
        # The grace is what a re-run just sent needs: the run reads cancelled for four more rounds,
        # then in flight, then green. Ending on the first stopped round would have missed it.
        t = "2025-12-31T23:00:00Z"
        run = "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\t"
        gh = FakeGh()
        self.quiet_head(gh, checks=[""] * 5 + ["ci\tpending\tu\t1\tin_progress", "ci\tsuccess\tu\t1\tcompleted"])
        gh.on("actions/runs?head_sha=h1", out=[f"{run}completed\tcancelled\t1"] * 5
              + [f"{run}in_progress\tpending\t1", f"{run}completed\tsuccess\t1"])
        gh.on("actions/runs/100/jobs", out=[f"build\tcancelled\t{t}\t{t}"] * 5 + [f"build\tpending\t{t}\t-"])
        clock = FakeClock()
        gate = make_gate(gh, clock)
        self.assertEqual((gate.check("7", 3600), gate.verdict), (0, "green"))
        self.assertEqual(clock.sleeps, [60] * 6)


T0 = 1767225600


@dataclass
class TimedGh(FakeGh):
    """A FakeGh whose check-runs answer is the test clock's: ``checks(t)`` gives the projected
    rows at ``t`` seconds after T0, and every read time is kept."""

    clock: FakeClock = field(default_factory=FakeClock)
    checks: Callable[[int], str] = field(default=lambda _at: "")
    reads: list[int] = field(default_factory=lambda: list[int]())

    def __call__(self, name: str, args: Sequence[str]) -> proc.Completed:
        joined = " ".join(args)
        if "check-runs" in joined:
            self.calls.append(list(args))
            at = int(self.clock.t) - T0
            self.reads.append(at)
            rows = self.checks(at)
            return proc.Completed(0, rows + "\n" if rows else "", "")
        if "actions/runs?head_sha=" in joined:
            # The run is in flight while a selected-or-not check row of it is: its own state.
            rows = self.checks(int(self.clock.t) - T0)
            state = "in_progress\tpending" if "\tpending\t" in rows else "completed\tsuccess"
            return proc.Completed(0, f"2026-01-01T00:00:00Z\t100\t1\tpush\tci\t{state}\t1\n", "")
        return super().__call__(name, args)


class RunningPause(unittest.TestCase):
    """ludics-lite#740: while every pending check has a runner, a wait reads its completion within
    2 x SHIP_PR_CHECKS_INTERVAL; any check without one keeps #543's back-off to the build cap. On
    the test clock, with a real (directory-less) Budget, so the build cap is the one in force."""

    def setUp(self) -> None:
        self.out = io.StringIO()
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        stack.enter_context(contextlib.redirect_stderr(self.out))
        self.addCleanup(stack.close)

    def wait(self, checks: Callable[[int], str], select: str = "", build_cap: int = 600, wait_for: int = 1800,
             jobs: str = "", env: dict[str, str] | None = None) -> tuple[int, Gate, FakeClock, TimedGh]:
        clk = FakeClock()
        gh = TimedGh(clock=clk, checks=checks)
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        gh.on("pulls/7", out="h1\tb1\ttopic")
        gh.on("actions/runs/100/jobs", out=jobs)
        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0, api_attempts=1, api_backoff=0)
        fclock = FuncClock(time=clk.now, sleep=clk.sleep)
        session = GhSession(config, run=gh, sleep=lambda _s: None, budget=Budget("", fclock, build_cap=build_cap))
        gate = Gate(session, "o/r", load_gate_config({"SHIP_PR_CHECKS_INTERVAL": "60", **(env or {})}), fclock)
        gate.select = select
        return gate.check("7", wait_for), gate, clk, gh

    def test_a_running_check_is_read_within_two_intervals_of_its_completion(self) -> None:
        def checks(at: int) -> str:
            return "build\tpending\tu\t1\tin_progress" if at < 421 else "build\tsuccess\tu\t1\tcompleted"
        rc, gate, clk, gh = self.wait(checks)
        self.assertEqual((rc, gate.verdict), (0, "green"))
        self.assertEqual(clk.sleeps, [60, 120, 120, 120, 120], "the pause stops doubling at twice the interval")
        self.assertEqual(gh.reads[-1], 540, "the completion at 421 is read 119 s later, not at 900")
        self.assertLessEqual(gh.reads[-1] - 421, 2 * 60)

    def test_a_queued_check_still_backs_off_to_the_build_cap(self) -> None:
        for status in ("queued", "waiting", "-", ""):
            def checks(at: int, status: str = status) -> str:
                row = "build\tpending\tu\t1" + (f"\t{status}" if status else "")
                return row if at < 1500 else "build\tsuccess\tu\t1\tcompleted"
            with self.subTest(status=status or "no column"):
                rc, _gate, clk, _gh = self.wait(checks)
                self.assertEqual(rc, 0)
                self.assertEqual(clk.sleeps, [60, 120, 240, 480, 600], "#543's queue keeps its back-off")

    def test_one_queued_check_beside_running_ones_keeps_the_back_off(self) -> None:
        def checks(at: int) -> str:
            if at >= 1500:
                return "linux\tsuccess\tu\t1\tcompleted\nmacos\tsuccess\tm\t1\tcompleted"
            return "linux\tpending\tu\t1\tin_progress\nmacos\tpending\tm\t1\tqueued"
        rc, _gate, clk, _gh = self.wait(checks)
        self.assertEqual((rc, clk.sleeps), (0, [60, 120, 240, 480, 600]))

    def test_a_queue_that_gets_a_runner_is_read_at_the_lower_cap_from_then_on(self) -> None:
        def checks(at: int) -> str:
            if at < 500:
                return "build\tpending\tu\t1\tqueued"
            return "build\tpending\tu\t1\tin_progress" if at < 1000 else "build\tsuccess\tu\t1\tcompleted"
        rc, _gate, clk, gh = self.wait(checks)
        self.assertEqual(rc, 0)
        self.assertEqual(clk.sleeps[:4], [60, 120, 240, 480], "queued: the back-off")
        self.assertTrue(all(s <= 120 for s in clk.sleeps[5:]), clk.sleeps)
        self.assertLessEqual(gh.reads[-1] - 1000, 2 * 60, gh.reads)

    def test_an_advisory_or_unselected_queued_check_does_not_hold_the_cadence(self) -> None:
        def checks(at: int) -> str:
            build = "build\tpending\tu\t1\tin_progress" if at < 421 else "build\tsuccess\tu\t1\tcompleted"
            return build + "\nslow\tpending\tv\t1\tqueued"
        # The advisory job is the run's last one in flight, as the run's jobs show it once build ends.
        jobs = ("build\tsuccess\t2026-01-01T00:00:00Z\t2026-01-01T00:00:00Z\n"
                "slow\tpending\t2026-01-01T00:00:00Z\t-")
        cases: list[tuple[str, dict[str, str]]] = [("", {"SHIP_PR_ADVISORY_CHECKS": "^slow$"}), ("^build$", {})]
        for select, env in cases:
            with self.subTest(select=select, env=env):
                rc, _gate, clk, gh = self.wait(checks, select=select, jobs=jobs, env=env)
                self.assertEqual(rc, 0)
                self.assertEqual((clk.sleeps, gh.reads[-1]), ([60, 120, 120, 120, 120], 540))

    def test_a_build_cap_below_twice_the_interval_still_bounds_it(self) -> None:
        def checks(at: int) -> str:
            return "build\tpending\tu\t1\tin_progress" if at < 421 else "build\tsuccess\tu\t1\tcompleted"
        rc, _gate, clk, _gh = self.wait(checks, build_cap=90)
        self.assertEqual(rc, 0)
        self.assertEqual(set(clk.sleeps[1:]), {90})

    def test_the_last_pause_is_still_clipped_at_the_deadline(self) -> None:
        rc, _gate, clk, _gh = self.wait(lambda _at: "build\tpending\tu\t1\tin_progress", wait_for=250)
        self.assertEqual((rc, clk.sleeps), (4, [60, 120, 70]))

    def test_a_waived_row_keeps_its_status_and_its_key(self) -> None:
        gate = make_gate(FakeGh(), FakeClock())
        gate.waive_mode = "record"
        rows = gate.apply_waiver(["red\tubuntu\tfailure\tu\t1\tcompleted", "pending\tmacos\tpending\tm\t1\tin_progress"])
        self.assertEqual(gate.waived, {"check:1/ubuntu"})
        self.assertEqual(rows, ["waived\tubuntu\tfailure\tu\t1\tcompleted", "pending\tmacos\tpending\tm\t1\tin_progress"])
        gate.summarize(rows)
        self.assertEqual((gate.verdict, gate.check_pending, gate.check_queued), ("pending", 1, 0))


class WaiverKeys(unittest.TestCase):
    """#1098: the override's keys are typed. One classifier per subject maps a conclusion to a kind,
    the record keeps the spelling, and the red-run judgement both readers share keeps its order."""

    def test_each_conclusion_maps_to_one_kind_or_none(self) -> None:
        jobs = {c: job_waiver("1", "ci", c) for c in ("failure", "timed_out", "startup_failure", "cancelled",
                                                    "stale", "action_required", "pending", "", "success")}
        self.assertEqual({c: str(k) if k else None for c, k in jobs.items()}, {
            "failure": "check:1/ci", "timed_out": "check:1/ci", "startup_failure": "check:1/ci",
            "cancelled": "cancelled:1/ci", "stale": None, "action_required": None, "pending": None, "": None,
            "success": None,
        })
        self.assertEqual(str(job_waiver("", "ci", "failure")), "check:-/ci", "a missing suite reads as -")
        runs = {c: run_waiver("100", c) for c in ("failure", "cancelled", "stale", "pending", "success")}
        self.assertEqual({c: str(k) if k else None for c, k in runs.items()}, {
            "failure": "run:100", "cancelled": "cancelled-run:100", "stale": None, "pending": None, "success": None,
        })

    def test_a_cancel_recorded_does_not_cover_the_same_id_read_red(self) -> None:
        gate = make_gate(FakeGh(), FakeClock())
        gate.waive_mode = "record"
        for key in (run_waiver("100", "cancelled"), job_waiver("1", "ci", "cancelled")):
            assert key is not None
            gate._waive_record(key)  # pyright: ignore[reportPrivateUsage]
        self.assertEqual(gate.waived, {"cancelled-run:100", "cancelled:1/ci"})
        gate.waive_mode = "apply"
        for key in (run_waiver("100", "failure"), job_waiver("1", "ci", "failure")):
            assert key is not None
            self.assertFalse(gate.waives(key), key)
        self.assertTrue(gate.waives(RunKey("cancelled-run", "100")))

    def test_the_record_by_mode(self) -> None:
        gate = make_gate(FakeGh(), FakeClock())
        key = RunKey("run", "100")
        cases: list[tuple[Literal["", "record", "apply"], bool, set[str]]] = [
            ("", False, set()), ("record", True, {"run:100"}), ("apply", False, set())]
        for mode, eligible, recorded in cases:
            with self.subTest(mode=mode):
                gate.waive_mode = mode
                gate.waived = set()
                self.assertEqual(gate._waive_eligible(key), eligible)  # pyright: ignore[reportPrivateUsage]
                self.assertEqual(gate.waived, set[str](), "eligibility records nothing")
                gate._waive_record(key)  # pyright: ignore[reportPrivateUsage]
                self.assertEqual(gate.waived, recorded)
        gate.waive_mode = "apply"
        gate.waived = {"run:100"}
        self.assertTrue(gate._waive_eligible(key))  # pyright: ignore[reportPrivateUsage]

    def red_run_gate(self, rows: str) -> tuple[Gate, FakeGh]:
        """Run 101 (suite 2) concluded red and its job list does not answer, beside ``rows``."""
        gh = FakeGh()
        gh.on("actions/runs?head_sha=h1",
              out="2026-01-01T00:00:00Z\t101\t2\tpull_request\tsetup\tcompleted\tfailure\t2" + rows)
        gh.on("actions/runs/101/jobs", rc=1, err="HTTP 502: Bad Gateway")
        return make_gate(gh, FakeClock()), gh

    def test_run_signal_waives_a_red_run_before_its_unread_job_list(self) -> None:
        modes: list[tuple[Literal["", "record"], int]] = [("record", 0), ("", 3)]
        for mode, rc in modes:
            with self.subTest(mode=mode):
                gate, _gh = self.red_run_gate("")
                gate.waive_mode = mode
                sig = gate.run_signal("h1", "2026-01-01T00:00:00Z", 1, "b1", "topic", "7")
                self.assertEqual(sig.rc, rc, sig.reason)
                self.assertEqual(sig.waived_runs, [WaivedRun("run", "101", "setup")] if mode else [])
                self.assertEqual(gate.waived, set[str](), "check records it from the entry, not run_signal")

    def test_checkless_reds_waives_a_red_run_before_its_unread_job_list(self) -> None:
        gate, _gh = self.red_run_gate("")
        gate.waive_mode = "record"
        self.assertIsNotNone(gate.read_runs("h1"))
        self.assertEqual(gate.checkless_reds(["red\tlint\tfailure\tl\t1\tcompleted"]), 0)
        self.assertEqual((gate.waived, gate.run_waived), ({"run:101"}, 1))
        self.assertIn("RED      workflow run 101 (setup, failure) (no build check behind it — WAIVED", gate.check_lines)
        self.assertNotIn("unread", gate.check_lines)

    def test_both_readers_judge_the_newest_completed_run_of_a_workflow_and_event(self) -> None:
        newer = "\n2026-01-01T00:00:05Z\t102\t2\t{event}\tsetup\tcompleted\tsuccess\t3"
        for event, rc, checkless in (("pull_request", 0, ""), ("push", 3, "unread   workflow run 101")):
            with self.subTest(event=event):
                gate, gh = self.red_run_gate(newer.format(event=event))
                sig = gate.run_signal("h1", "2026-01-01T00:00:00Z", 1, "b1", "topic", "7")
                self.assertEqual(sig.rc, rc, sig.reason)
                gate.check_lines = ""
                self.assertEqual(gate.checkless_reds(["red\tlint\tfailure\tl\t1\tcompleted"]), 0)
                self.assertIn(checkless, gate.check_lines)
                if not checkless:
                    self.assertFalse([c for c in gh.calls if "actions/runs/101/jobs" in " ".join(c)], gh.calls)

    def test_checkless_reds_reads_no_job_list_of_a_suite_the_fold_shows(self) -> None:
        gate, gh = self.red_run_gate("")
        self.assertIsNotNone(gate.read_runs("h1"))
        self.assertEqual(gate.checkless_reds(["red\tsetup\tfailure\tl\t2\tcompleted"]), 0)
        self.assertFalse([c for c in gh.calls if "actions/runs/101/jobs" in " ".join(c)], gh.calls)
        self.assertEqual(gate.check_lines, "")

    def test_only_the_record_methods_touch_the_record(self) -> None:
        # The guard behind the type: in gate.py and merge.py, ``.waived`` is read or written only
        # by the record's methods, plus ``Gate.check``'s reset (a plain assignment to it, nothing
        # else in ``check``). Boundary: those two modules, by their syntax tree; another module
        # reaching the record is outside it.
        methods = {"_waive_record", "waives"}
        for module in (gate_module, merge_module):
            tree = ast.parse(inspect.getsource(module))
            resets: set[int] = set()
            if module is gate_module:
                for fn in ast.walk(tree):
                    if isinstance(fn, ast.FunctionDef) and fn.name == "check":
                        resets |= {id(t) for n in ast.walk(fn) if isinstance(n, ast.Assign) for t in n.targets}
            stray: set[str] = set()
            for fn in ast.walk(tree):
                if isinstance(fn, ast.FunctionDef) and fn.name not in methods:
                    for node in ast.walk(fn):
                        if isinstance(node, ast.Attribute) and node.attr == "waived" and id(node) not in resets:
                            stray.add(fn.name)
            with self.subTest(module=module.__name__):
                self.assertEqual(stray, set[str]())
                if module is gate_module:
                    self.assertTrue(resets, "check's reset is where the guard looks for it")
        self.assertIn("waives", {n.name for n in ast.walk(ast.parse(inspect.getsource(gate_module)))
                                 if isinstance(n, ast.FunctionDef)}, "the guard reads the right tree")


class Selection(unittest.TestCase):
    """``checks --check <ERE>`` (ludics-lite#569): the selected checks' fold is the verdict."""

    def setUp(self) -> None:
        self.out = io.StringIO()
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(self.out))
        stack.enter_context(contextlib.redirect_stderr(self.out))
        self.addCleanup(stack.close)

    def head(self, gh: FakeGh) -> None:
        gh.on("pulls/7", ".updated_at", out="h1\t2026-01-01T00:00:00Z\tb1\ttopic")
        gh.on("pulls/7", out="h1\tb1\ttopic")

    def test_a_selected_fast_check_settles_while_a_slow_one_runs(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out=["fast\tpending\tu\t1\nslow\tpending\tv\t1",
                                 "fast\tsuccess\tu\t1\nslow\tpending\tv\t1"])
        gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tin_progress\tpending\t1")
        gh.on("actions/runs/100/jobs", out="")
        clock = FakeClock()
        gate = make_gate(gh, clock, select="^fast$")
        self.assertEqual((gate.check("7", 600), gate.verdict, gate.check_total), (0, "green", 1))
        self.assertEqual(clock.sleeps, [60], "one interval, then the fast check's verdict")
        self.assertFalse(any("actions/runs" in " ".join(c) for c in gh.calls), "matched checks need no run read")
        self.assertNotIn("slow", self.out.getvalue())

    def test_the_heartbeat_names_the_running_checks(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out=["fast\tsuccess\tu\t1\nbuild (macos-latest)\tpending\tv\t1"])
        gh.on("actions/runs?head_sha=h1", out="2026-01-01T00:00:00Z\t100\t1\tpush\tci\tin_progress\tpending\t1")
        gh.on("actions/runs/100/jobs", out="")
        gate = make_gate(gh, FakeClock(), SHIP_PR_CHECKS_HEARTBEAT="0")
        self.assertEqual(gate.check("7", 120), 4)
        self.assertIn("(1 check(s) running: build (macos-latest))", self.out.getvalue())

    def test_matching_nothing_holds_while_a_run_is_in_flight_and_refuses_after(self) -> None:
        for status, concl, want, verdict in (("in_progress", "pending", 4, "unjudged"),
                                             ("completed", "success", 2, "unknown"),
                                             ("completed", "failure", 2, "unknown"),
                                             ("completed", "cancelled", 2, "unknown")):
            gh = FakeGh()
            self.head(gh)
            gh.on("check-runs", out="lint\tsuccess\tu\t1")
            gh.on("actions/runs?head_sha=h1", out=f"2026-01-01T00:00:00Z\t100\t1\tpush\tci\t{status}\t{concl}\t1")
            gh.on("actions/runs/100/jobs", out="lint\tfailure\t2026-01-01T00:00:00Z\t2026-01-01T00:01:00Z")
            with self.subTest(status=status, concl=concl):
                gate = make_gate(gh, FakeClock(), select="^torch")
                self.assertEqual((gate.check("7", 0), gate.verdict), (want, verdict))

    def test_nothing_is_advisory_under_a_selection(self) -> None:
        gh = FakeGh()
        self.head(gh)
        gh.on("check-runs", out="claude\tfailure\tu\t1\nlint\tsuccess\tu\t1")
        gate = make_gate(gh, FakeClock(), select="^claude$")
        self.assertEqual((gate.check("7", 0), gate.verdict), (1, "red"))

    def test_the_running_list_is_bounded(self) -> None:
        self.assertEqual(running_list(["a"]), "a")
        self.assertEqual(running_list(["a", "b", "c", "d", "e"]), "a, b, c (+2 more)")
        long = running_list(["x" * 400])
        self.assertEqual(len(long), 160)
        self.assertTrue(long.endswith("…"))



# The advisory list as lukstafi/ocannl-staging's .github/ship-pr-advisory-checks names its macOS leg,
# served from the default branch the way ``merge`` reads it (#1026).
ADVISORY_BODY = "# the macOS legs of ci\n^Build \\(macos-latest, .*\\)$"
MACOS = "Build (macos-latest, 5.5.x, main)"


@dataclass
class PhasedGh:
    """A gh whose answers change with the wait's round: ``rounds[i]`` maps a needle to the answer
    the i-th round reads (the clock's sleep count; the last round repeats). Every read inside a
    round sees one moment, however many times it is made."""

    clock: FakeClock
    rounds: list[dict[str, str]]
    calls: list[list[str]] = field(default_factory=lambda: list[list[str]]())

    def __call__(self, name: str, args: Sequence[str]) -> proc.Completed:
        self.calls.append(list(args))
        joined = " ".join(args)
        if "contents/.github/ship-pr-advisory-checks" in joined:
            return proc.Completed(0, ADVISORY_BODY + "\n", "")
        if "pulls/7" in joined:
            out = "h1\t2026-01-01T00:00:00Z\tb1\ttopic" if ".updated_at" in joined else "h1\tb1\ttopic"
            return proc.Completed(0, out + "\n", "")
        answers = self.rounds[min(len(self.clock.sleeps), len(self.rounds) - 1)]
        for needle, out in answers.items():
            if needle in joined:
                return proc.Completed(0, out + "\n" if out else "", "")
        raise AssertionError(f"no route for gh {joined}")


class ChecksWaitSettlesOnRequired(unittest.TestCase):
    """#1026: ``checks --wait`` with no ``--check`` settles on the checks ``merge``'s gate requires,
    the advisory list read from the repository's file as ``merge`` reads it, through ``checks.run``
    end to end. The witness shape is lukstafi/ocannl-staging's: a non-advisory ``ci`` workflow whose
    macOS job is advisory and still queued while its ubuntu jobs settle."""

    OLD = "2025-12-31T23:00:00Z"  # an hour before FakeClock's start

    def run_checks(self, rounds: list[dict[str, str]], *args: str, **env: str) -> tuple[int, str, FakeClock]:
        clock = FakeClock()
        gh = PhasedGh(clock, rounds)
        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0, api_attempts=1, api_backoff=0)
        session = GhSession(config, run=gh, sleep=lambda _s: None)
        out = io.StringIO()
        environ = {k: v for k, v in os.environ.items() if not k.startswith(("SHIP_PR_", "LUDICS_PR_"))}
        environ.update({"SHIP_PR_CHECKS_INTERVAL": "60", **env})
        with mock.patch.dict(os.environ, environ, clear=True), \
                mock.patch.object(checks, "clock_from_env", return_value=FuncClock(time=clock.now, sleep=clock.sleep)), \
                mock.patch.object(branchtip, "read_tip", return_value=branchtip.Clear("h1")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            rc = checks.run(session, ["7", *args])
        return rc, out.getvalue(), clock

    def ci(self, status: str, jobs: str, checkruns: str) -> dict[str, str]:
        return {
            "check-runs": checkruns,
            "actions/runs?head_sha=h1": f"2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\t{status}\tpending\t1",
            "actions/runs/100/jobs": jobs,
        }

    def test_green_once_every_required_check_is_green_with_the_advisory_job_queued(self) -> None:
        old = self.OLD
        macos_job = f"{MACOS}\tpending\t{old}\t-"
        macos_check = f"{MACOS}\tpending\tm\t1\tqueued"
        rounds = [
            self.ci("in_progress", f"ubuntu\tpending\t{old}\t-\n{macos_job}",
                    f"ubuntu\tpending\tu\t1\tin_progress\n{macos_check}"),
            self.ci("in_progress", f"ubuntu\tsuccess\t{old}\t{old}\n{macos_job}",
                    f"ubuntu\tsuccess\tu\t1\tcompleted\n{macos_check}"),
        ]
        rc, out, clock = self.run_checks(rounds, "--wait=3600")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.splitlines()[-1], "checks: verdict=green branch=current")
        self.assertIn("green — 1 build checks passed", out)
        self.assertIn("still running, but only advisory jobs (.github/ship-pr-advisory-checks) — not waited for", out)
        self.assertEqual(len(clock.sleeps), 1, "settled on the round the required check went green")
        self.assertNotIn("the wait is spent", out)

    def test_red_at_the_first_round_that_reads_a_required_red(self) -> None:
        # A required red ends the wait while another required job and the advisory one still run.
        old = self.OLD
        jobs = f"ubuntu 1/2\tfailure\t{old}\t{old}\nubuntu 2/2\tpending\t{old}\t-\n{MACOS}\tpending\t{old}\t-"
        checkruns = (f"ubuntu 1/2\tfailure\tu1\t1\tcompleted\nubuntu 2/2\tpending\tu2\t1\tin_progress\n"
                     f"{MACOS}\tpending\tm\t1\tin_progress")
        rc, out, clock = self.run_checks([self.ci("in_progress", jobs, checkruns)], "--wait=3600")
        self.assertEqual(rc, 1, out)
        self.assertEqual(out.splitlines()[-1], "checks: verdict=red branch=current")
        self.assertEqual(clock.sleeps, [], "no round after the red")
        # Control: the same red on the advisory job alone is not the verdict.
        jobs = f"ubuntu\tsuccess\t{old}\t{old}\n{MACOS}\tfailure\t{old}\t{old}"
        checkruns = f"ubuntu\tsuccess\tu\t1\tcompleted\n{MACOS}\tfailure\tm\t1\tcompleted"
        done = self.ci("completed", jobs, checkruns)
        done["actions/runs?head_sha=h1"] = "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tfailure\t1"
        rc, out, _clock = self.run_checks([done], "--wait=3600")
        self.assertEqual((rc, out.splitlines()[-1]), (0, "checks: verdict=green branch=current"), out)

    def test_a_required_dependent_not_yet_started_is_waited_for(self) -> None:
        # Round 1: ``build`` finished 5s ago and its ``needs:`` dependent ``test`` has no job and no
        # check run yet; only the advisory macOS job is unfinished. Inside the settle the run holds.
        # Round 2: ``test`` is queued. Round 3: green.
        old, recent = self.OLD, "2025-12-31T23:59:55Z"
        macos_job = f"{MACOS}\tpending\t{old}\t-"
        macos_check = f"{MACOS}\tpending\tm\t1\tqueued"
        rounds = [
            self.ci("in_progress", f"build\tsuccess\t{old}\t{recent}\n{macos_job}",
                    f"build\tsuccess\tb\t1\tcompleted\n{macos_check}"),
            self.ci("in_progress", f"build\tsuccess\t{old}\t{recent}\ntest\tpending\t{recent}\t-\n{macos_job}",
                    f"build\tsuccess\tb\t1\tcompleted\ntest\tpending\tt\t1\tqueued\n{macos_check}"),
            self.ci("in_progress", f"build\tsuccess\t{old}\t{recent}\ntest\tsuccess\t{recent}\t{recent}\n{macos_job}",
                    f"build\tsuccess\tb\t1\tcompleted\ntest\tsuccess\tt\t1\tcompleted\n{macos_check}"),
        ]
        rc, out, clock = self.run_checks(rounds, "--wait=3600")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.splitlines()[-1], "checks: verdict=green branch=current")
        self.assertIn("green — 2 build checks passed", out)
        self.assertEqual(len(clock.sleeps), 2, "held through the settle and the dependent's run")
        # Without a wait the first round is the answer: no verdict yet, the settle named.
        rc, out, _clock = self.run_checks(rounds[:1])
        self.assertEqual(rc, 4, out)
        self.assertIn("inside the 1m settle a dependent job may still appear in", out)
        self.assertEqual(out.splitlines()[-1], "checks: verdict=unjudged branch=current")

    def test_the_bound_is_reported_when_it_expires(self) -> None:
        old = self.OLD
        rounds = [self.ci("in_progress", f"ubuntu\tpending\t{old}\t-\n{MACOS}\tpending\t{old}\t-",
                          f"ubuntu\tpending\tu\t1\tin_progress\n{MACOS}\tpending\tm\t1\tqueued")]
        for args, env, source in (
            (("--wait=300",), {}, "--wait=300"),
            (("--wait",), {"SHIP_PR_CHECKS_WAIT": "300"}, "--wait, from SHIP_PR_CHECKS_WAIT"),
        ):
            with self.subTest(args=args):
                rc, out, clock = self.run_checks(rounds, *args, **env)
                self.assertEqual(rc, 4, out)
                lines = out.splitlines()
                self.assertEqual(lines[-1], "checks: verdict=pending branch=current", "the trailer is unchanged")
                self.assertEqual(
                    lines[-2], f"checks: the wait is spent: 5m ({source}) passed with no verdict;"
                    " exit 4 is no verdict yet, neither green nor red")
                self.assertGreaterEqual(clock.t - FakeClock().t, 300)
        # No wait, no bound to report.
        rc, out, _clock = self.run_checks(rounds)
        self.assertEqual(rc, 4, out)
        self.assertNotIn("the wait is spent", out)


class ChecksSettle(unittest.TestCase):
    """#1039: ``checks --wait --settle`` waits past a red while a check the fold judges still runs,
    so a worker sees every red of a push at once; without it the first red ends the wait."""

    OLD = ChecksWaitSettlesOnRequired.OLD
    run_checks = ChecksWaitSettlesOnRequired.run_checks
    ci = ChecksWaitSettlesOnRequired.ci

    def shards(self, second: str) -> dict[str, str]:
        """``lint`` red, ``ubuntu 2/2`` at ``second`` (a conclusion, or pending), the advisory macOS
        job queued throughout: the run stays in flight."""
        old = self.OLD
        done = "-" if second == "pending" else old
        status = "in_progress" if second == "pending" else "completed"
        jobs = f"lint\tfailure\t{old}\t{old}\nubuntu 2/2\t{second}\t{old}\t{done}\n{MACOS}\tpending\t{old}\t-"
        checkruns = (f"lint\tfailure\tl\t1\tcompleted\nubuntu 2/2\t{second}\tu2\t1\t{status}\n"
                     f"{MACOS}\tpending\tm\t1\tqueued")
        return self.ci("in_progress", jobs, checkruns)

    def test_a_red_beside_a_running_sibling_waits_for_it_and_reports_both(self) -> None:
        rounds = [self.shards("pending"), self.shards("pending"), self.shards("failure")]
        # The default is unchanged: the first red ends the wait, the sibling still running.
        rc, out, clock = self.run_checks(rounds, "--wait=3600")
        self.assertEqual((rc, out.splitlines()[-1]), (1, "checks: verdict=red branch=current"), out)
        self.assertEqual(clock.sleeps, [], "the default reads no round after the red")
        self.assertIn("running  ubuntu 2/2 (no verdict yet)", out)
        # --settle waits the sibling out and reports both reds, with the same exit and trailer.
        rc, out, clock = self.run_checks(rounds, "--wait=3600", "--settle")
        self.assertEqual((rc, out.splitlines()[-1]), (1, "checks: verdict=red branch=current"), out)
        self.assertEqual(len(clock.sleeps), 2, "held until the sibling concluded")
        self.assertIn("RED — 2 of 2 build checks failed", out)
        self.assertIn("RED      lint (failure)", out)
        self.assertIn("RED      ubuntu 2/2 (failure)", out)
        self.assertNotIn("--settle:", out, "nothing was left running")
        self.assertNotIn("the wait is spent", out)

    def test_a_red_whose_sibling_never_settles_names_it_at_the_bound(self) -> None:
        rc, out, clock = self.run_checks([self.shards("pending")], "--wait=300", "--settle")
        self.assertEqual(rc, 1, out)
        lines = out.splitlines()
        self.assertEqual(lines[-1], "checks: verdict=red branch=current", "the trailer is the red's")
        self.assertEqual(
            lines[-2], "checks: --settle: the wait is spent: 5m (--wait=300) passed with 1 check(s) still"
            " running: ubuntu 2/2; the reds above are those read so far")
        self.assertGreaterEqual(clock.t - FakeClock().t, 300)
        self.assertIn("RED — 1 of 2 build checks failed", out)

    def test_a_green_sibling_settles_red_and_all_green_is_unchanged(self) -> None:
        rc, out, clock = self.run_checks([self.shards("pending"), self.shards("success")], "--wait=3600", "--settle")
        self.assertEqual((rc, out.splitlines()[-1]), (1, "checks: verdict=red branch=current"), out)
        self.assertEqual(len(clock.sleeps), 1)
        self.assertIn("RED — 1 of 2 build checks failed", out)
        # A head with no red waits and answers exactly as without --settle.
        old = self.OLD
        macos_job = f"{MACOS}\tpending\t{old}\t-"
        macos_check = f"{MACOS}\tpending\tm\t1\tqueued"
        rounds = [
            self.ci("in_progress", f"ubuntu\tpending\t{old}\t-\n{macos_job}",
                    f"ubuntu\tpending\tu\t1\tin_progress\n{macos_check}"),
            self.ci("in_progress", f"ubuntu\tsuccess\t{old}\t{old}\n{macos_job}",
                    f"ubuntu\tsuccess\tu\t1\tcompleted\n{macos_check}"),
        ]
        plain = self.run_checks(rounds, "--wait=3600")
        settled = self.run_checks(rounds, "--wait=3600", "--settle")
        self.assertEqual(settled[0], 0, settled[1])
        self.assertEqual((settled[0], settled[1], settled[2].sleeps), (plain[0], plain[1], plain[2].sleeps))

    def test_a_checkless_red_run_beside_a_running_check_waits_for_it(self) -> None:
        # A workflow run that failed before its jobs started (runred) while a required check runs:
        # the default ends at once on the run's red, --settle waits the check out and reports both.
        old = self.OLD

        def round_(concl: str) -> dict[str, str]:
            done = "-" if concl == "pending" else old
            status = "in_progress" if concl == "pending" else "completed"
            answers = self.ci(status, f"ubuntu\t{concl}\t{old}\t{done}", f"ubuntu\t{concl}\tu\t1\t{status}")
            answers["actions/runs?head_sha=h1"] = (
                f"2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\t{status}\t{concl}\t1\n"
                "2026-01-01T00:00:00Z\t101\t2\tpull_request\tsetup\tcompleted\tstartup_failure\t2"
            )
            answers["actions/runs/101/jobs"] = ""
            return answers

        rounds = [round_("pending"), round_("failure")]
        rc, out, clock = self.run_checks(rounds, "--wait=3600")
        self.assertEqual((rc, out.splitlines()[-1]), (1, "checks: verdict=runred branch=current"), out)
        self.assertEqual(clock.sleeps, [])
        rc, out, clock = self.run_checks(rounds, "--wait=3600", "--settle")
        self.assertEqual(rc, 1, out)
        self.assertEqual(len(clock.sleeps), 1, "held until the running check concluded")
        self.assertIn("RED      ubuntu (failure)", out)
        self.assertEqual(out.splitlines()[-1], "checks: verdict=red branch=current", "the check's red is read last")
        # #1066: the run's red is reported beside the check's, not left for the next push.
        self.assertIn("RED      workflow run 101 (setup, startup_failure) — no build check behind it", out)
        self.assertIn(
            "RED — 1 of 1 build checks failed, and 1 workflow run(s) concluded red with no build check", out)

    def test_settle_needs_a_wait(self) -> None:
        for args in (("--settle",), ("--wait=0", "--settle"), ("--wait=", "--settle")):
            with self.subTest(args=args), self.assertRaises(cli.Exit) as raised:
                self.run_checks([self.shards("pending")], *args)
            self.assertEqual(raised.exception.rc, 2)
            self.assertIn("--settle needs a --wait of more than 0 seconds", raised.exception.message)

class ChecklessRedBesideRedCheck(unittest.TestCase):
    """#1066: a red check no longer hides a workflow run that concluded red with no check behind it;
    a run whose red the fold's own checks already name is not reported a second time."""

    OLD = ChecksWaitSettlesOnRequired.OLD
    run_checks = ChecksWaitSettlesOnRequired.run_checks

    def answers(self, runs: str, **jobs: str) -> dict[str, str]:
        """``ci`` (run 100, check suite 1) completed failure through its red ``lint`` check, beside
        ``runs``; ``jobs`` maps a run id to its job list."""
        old = self.OLD
        out = {
            "check-runs": "lint\tfailure\tl\t1\tcompleted\nubuntu\tsuccess\tu\t1\tcompleted",
            "actions/runs?head_sha=h1": "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tfailure\t1"
            + "".join(f"\n{row}" for row in runs.splitlines() if row),
            "actions/runs/100/jobs": f"lint\tfailure\t{old}\t{old}\nubuntu\tsuccess\t{old}\t{old}",
        }
        out.update({f"actions/runs/{rid}/jobs": body for rid, body in jobs.items()})
        return out

    def test_a_red_check_and_a_checkless_red_run_are_both_reported(self) -> None:
        setup = "2026-01-01T00:00:00Z\t101\t2\tpull_request\tsetup\tcompleted\tstartup_failure\t2"
        rc, out, _clock = self.run_checks([self.answers(setup, **{"101": ""})])
        self.assertEqual((rc, out.splitlines()[-1]), (1, "checks: verdict=red branch=current"), out)
        self.assertIn("RED      lint (failure)", out)
        self.assertIn("RED      workflow run 101 (setup, startup_failure) — no build check behind it", out)
        self.assertIn(
            "RED — 1 of 2 build checks failed, and 1 workflow run(s) concluded red with no build check", out)

    def test_a_red_check_whose_own_run_is_the_red_one_is_reported_once(self) -> None:
        rc, out, _clock = self.run_checks([self.answers("")])
        self.assertEqual((rc, out.splitlines()[-1]), (1, "checks: verdict=red branch=current"), out)
        self.assertIn("RED      lint (failure)", out)
        self.assertNotIn("workflow run", out)
        self.assertIn("RED — 1 of 2 build checks failed\n", out)
        # A run red through its advisory job alone is explained by its job list, and not listed.
        old = self.OLD
        docs = "2026-01-01T00:00:00Z\t102\t3\tpull_request\tdocs\tcompleted\tfailure\t3"
        rc, out, _clock = self.run_checks([self.answers(docs, **{"102": f"{MACOS}\tfailure\t{old}\t{old}"})])
        self.assertEqual(rc, 1, out)
        self.assertNotIn("workflow run", out)

    def test_an_unread_job_list_beside_a_red_check_is_a_note_not_a_3(self) -> None:
        clock = FakeClock()
        setup = "2026-01-01T00:00:00Z\t101\t2\tpull_request\tsetup\tcompleted\tstartup_failure\t2"
        rounds = [self.answers(setup)]

        def gh(name: str, args: Sequence[str]) -> proc.Completed:
            if "actions/runs/101/jobs" in " ".join(args):
                return proc.Completed(1, "", "HTTP 502: Bad Gateway")
            return PhasedGh(clock, rounds)(name, args)

        config = Config(repo="o/r", reviewer="r", round_threshold=None, round_gap=0, api_attempts=1, api_backoff=0)
        session = GhSession(config, run=gh, sleep=lambda _s: None)
        gate = Gate(session=session, repo="o/r", config=load_gate_config({}), clock=FuncClock(time=clock.now, sleep=clock.sleep))
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            rc = gate.check("7", 0)
        self.assertEqual((rc, gate.verdict, gate.checkless_red), (1, "red", 0), out.getvalue())
        self.assertIn("unread   workflow run 101 (setup, startup_failure): its job list could not be read",
                      out.getvalue())

    def test_no_red_check_reads_the_run_list_as_before(self) -> None:
        # A green fold with a checkless red run is still run_signal's runred, reported once.
        old = self.OLD
        answers = {
            "check-runs": "ubuntu\tsuccess\tu\t1\tcompleted",
            "actions/runs?head_sha=h1": "2026-01-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tsuccess\t1\n"
            "2026-01-01T00:00:00Z\t101\t2\tpull_request\tsetup\tcompleted\tstartup_failure\t2",
            "actions/runs/100/jobs": f"ubuntu\tsuccess\t{old}\t{old}",
            "actions/runs/101/jobs": "",
        }
        rc, out, _clock = self.run_checks([answers])
        self.assertEqual((rc, out.splitlines()[-1]), (1, "checks: verdict=runred branch=current"), out)
        self.assertIn("RED — 1 workflow run(s) for this head concluded red with no build check", out)
        self.assertNotIn("RED      workflow run", out)


if __name__ == "__main__":
    unittest.main()
