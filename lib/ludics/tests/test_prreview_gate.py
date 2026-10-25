"""Units of the ``checks``/``merge`` port: the advisory list as grep reads it, the shell readings,
the workflow-YAML readers, the glob, the drift's hunk reader, the closing-keyword filter, and the
gate's fold and wait loop driven through an in-process gh (``GhSession(run=...)``) and an injected
clock.

The fixture suites (test-pr-review-checks-absent.sh, -merge.sh, -base-drift.sh) are the
conformance suite; these pin the rules inside the port that a regression would bend first.
"""

import contextlib
import io
import os
import subprocess
import unittest
from unittest import mock
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace

from ludics import proc
from ludics.prreview import clock, closekw, shtext, workflow_yaml
from ludics.prreview.core import Config, GhSession, Json
from ludics.prreview.drift import compare_file_set, compare_hunks
from ludics.prreview.checkruns import conclusion_class, newest_first_lines
from ludics.prreview.budget import Budget
from ludics.prreview.clock import FuncClock
from ludics.prreview.gate import Gate, advisory_parse, load_gate_config, running_list


def grep_refuses_in(locale: str, pattern: str) -> bool:
    """Does this box's grep refuse ``pattern`` under ``locale``? (The oracle the shell asked.)"""
    env = {**os.environ, "LC_ALL": locale}
    done = subprocess.run(["grep", "-Eq", "--", pattern], input=b"", env=env, capture_output=True, check=False)
    return done.returncode == 2


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
                self.assertEqual(len(gate.head_unread), 5, "five failed reads, each recorded")
                self.assertIn("5 head read(s) failed during this wait", gate.head_unread_note())
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
                self.assertIn("head reads failed during this wait, and its budget is spent", self.out.getvalue())

    def test_a_refused_or_unwaited_head_read_is_three_at_once(self) -> None:
        # The negative controls: a 404 no retry changes, and a read with no wait to ride it out in.
        for err, wait, why in (("gh: Not Found (HTTP 404)", 3600, "GitHub refused the read"),
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
        self.assertEqual(gate.head_unread, ["it answered no SHA"])

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


if __name__ == "__main__":
    unittest.main()
