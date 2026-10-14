"""ludics.prreview.core: the pr-review.sh prelude, driven through a fake gh on PATH."""

import contextlib
import io
import os
import unittest
from collections.abc import Sequence

from ludics import cli, proc
from ludics.prreview import core
from ludics.prreview.core import (
    Config,
    GhArgsRefused,
    GhFailed,
    GhOk,
    GhRefusedOwn,
    GhSession,
    GhUnanswered,
    ListOk,
    ListUnparsed,
    Ref,
)
from ludics.tests.fake import Answer, FakeTool

GATEWAY = Answer(1, "", "gh: HTTP 503: No server is currently available to service your request\n")
NOT_FOUND = Answer(1, "", "gh: Not Found (HTTP 404)\n")
SERVER_ERROR = Answer(1, "", "gh: Internal Server Error (HTTP 500)\n")


def config(**overrides: str) -> Config:
    env = {"SHIP_PR_API_ATTEMPTS": "4", "SHIP_PR_API_BACKOFF": "5", "REPO": "o/r"}
    env.update(overrides)
    return core.load_config(env)


class Session:
    """A GhSession whose sleeps are recorded, not slept, and whose warnings are captured."""

    def __init__(self, **overrides: str) -> None:
        self.sleeps: list[float] = []
        self.session = GhSession(config(**overrides), sleep=self.sleeps.append)
        self.stderr = io.StringIO()

    def retry(self, mode: core.Mode, args: Sequence[str]) -> core.GhResult:
        with contextlib.redirect_stderr(self.stderr):
            return self.session.retry(mode, args)


class LoadConfig(unittest.TestCase):
    def test_defaults(self) -> None:
        c = core.load_config({})
        self.assertEqual(
            c, Config("", "chatgpt-codex-connector", 12, 900, 4, 5)
        )

    def test_empty_is_unset_and_off_is_none(self) -> None:
        c = core.load_config({"SHIP_PR_ROUND_THRESHOLD": "off", "SHIP_PR_ROUND_GAP": "",
                              "REPO": "a/b"})
        self.assertEqual((c.round_threshold, c.round_gap, c.repo), (None, 900, "a/b"))
        self.assertEqual(core.load_config({"SHIP_PR_ROUND_THRESHOLD": "0"}).round_threshold, 0)

    def test_a_typo_is_a_usage_error_not_off(self) -> None:
        for name, value, want in (
            ("SHIP_PR_ROUND_THRESHOLD", "12x", "must be a number of rounds or 'off', got '12x'"),
            ("SHIP_PR_ROUND_THRESHOLD", "012", "got '012'"),
            ("SHIP_PR_ROUND_GAP", "true", "must be a nonnegative number of seconds, got 'true'"),
            ("SHIP_PR_API_ATTEMPTS", "x", "SHIP_PR_API_ATTEMPTS must be a whole number"),
            ("SHIP_PR_API_BACKOFF", "-1", "SHIP_PR_API_BACKOFF must be a whole number"),
        ):
            with self.subTest(name=name, value=value):
                with self.assertRaises(cli.Exit) as caught:
                    core.load_config({name: value})
                self.assertEqual(caught.exception.rc, 2)
                self.assertIn(want, caught.exception.message)


class Classification(unittest.TestCase):
    def test_gateway_and_rejection(self) -> None:
        self.assertTrue(core.gateway_failure("gh: HTTP 502: Bad gateway (https://x)"))
        self.assertTrue(core.gateway_failure("503 No server is currently available"))
        self.assertFalse(core.gateway_failure("gh: Internal Server Error (HTTP 500)"))
        self.assertTrue(core.api_rejection("gh: Not Found (HTTP 404)"))
        self.assertFalse(core.api_rejection("gh: HTTP 4xx"))
        self.assertTrue(core.transient_failure("gh: Internal Server Error (HTTP 500)"))
        self.assertTrue(core.transient_failure("connection reset"))
        self.assertFalse(core.transient_failure("gh: Not Found (HTTP 404)"))
        self.assertTrue(core.transient_failure("gh: Bad gateway (HTTP 404)"))

    def test_graphql_fixed_answers_verbatim(self) -> None:
        # The bodies test-pr-review-retry.sh pins, under both prefixes.
        for line in (
            "GraphQL: By the time this query traverses to the authors connection, it is requesting"
            " up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000.",
            "gh: Requesting 101 records on the `repositories` connection exceeds the `first`"
            " limit of 100 records.",
            "gh: Field 'nosuchfield' doesn't exist on type 'User'",
            'gh: Expected NAME, actual: (none) ("") at [1, 12]',
            'gh: Expected NAME, actual: STRING ("Bad gateway") at [1, 18]',
        ):
            self.assertTrue(core.graphql_fixed_answer(line), line)
        for line in (
            "gh: proxy: By the time this query traverses to the comments connection, it is"
            " requesting up to 1,000,000 possible nodes which exceeds the maximum limit of 500,000.",
            "GraphQL: Field 'nosuchfield' doesn't exist on type 'User' (query.viewer.nosuchfield)",
            "Field 'nosuchfield' doesn't exist on type 'User'",
        ):
            self.assertFalse(core.graphql_fixed_answer(line), line)

    def test_client_refusals_verbatim(self) -> None:
        for line in (
            'Unknown JSON field: "a b"',
            "Specify one or more comma-separated fields for `--json`:",
            "unknown flag: --foo.bar",
            "unknown shorthand flag: '_' in -_",
            "flag needs an argument: 'X' in -X",
            'invalid argument "abc" for "-L, --limit" flag: strconv.ParseInt: parsing "abc"',
            "accepts at most 1 arg(s), received 2",
            "requires at least 2 arg(s), only received 0",
            "bad flag syntax: ---x",
            'unknown command "nosuchcmd" for "gh pr"',
        ):
            self.assertTrue(core.gh_client_refusal(line), line)
        for line in (
            "gh: unknown flag: --x",
            "unknown flag: --a b",
            "flags required when not running interactively",
            "accepts between 1 and 2 arg(s), received 3",
        ):
            self.assertFalse(core.gh_client_refusal(line), line)

    def test_api_only_commands(self) -> None:
        self.assertTrue(core.gh_api_only_command(["api", "x"]))
        self.assertTrue(core.gh_api_only_command(["pr", "view", "1"]))
        self.assertFalse(core.gh_api_only_command(["pr", "merge", "1"]))
        self.assertFalse(core.gh_api_only_command(["discussion", "list"]))
        self.assertFalse(core.gh_api_only_command([]))


class Retry(unittest.TestCase):
    def test_success_returns_stdout_as_a_substitution_keeps_it(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(0, "https://x\n\n"))
            s = Session()
            self.assertEqual(s.retry("read", ["api", "x"]), GhOk("https://x"))
            self.assertEqual(s.session.err_line(), "")

    def test_a_gateway_failure_is_retried_with_doubling_backoff_capped_at_20(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(GATEWAY, GATEWAY, GATEWAY, GATEWAY, Answer(0, "ok\n"))
            s = Session(SHIP_PR_API_ATTEMPTS="5")
            self.assertEqual(s.retry("write", ["api", "-X", "POST", "x"]), GhOk("ok"))
            self.assertEqual(len(gh.calls()), 5)
            self.assertEqual(s.sleeps, [5, 10, 20, 20])
            self.assertIn(
                "pr-review.sh: gh api failed (attempt 1/5), retrying in 5s: gh: HTTP 503",
                s.stderr.getvalue(),
            )

    def test_exhausted_retries_are_unanswered(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(SERVER_ERROR)
            s = Session(SHIP_PR_API_ATTEMPTS="2")
            self.assertEqual(s.retry("read", ["api", "x"]), GhUnanswered())
            self.assertEqual(len(gh.calls()), 2)
            self.assertEqual(s.session.err_line(), "gh: Internal Server Error (HTTP 500)")

    def test_a_4xx_is_the_api_answering_and_is_not_retried(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(NOT_FOUND)
            s = Session()
            self.assertEqual(s.retry("read", ["api", "x"]), GhFailed())
            self.assertEqual(len(gh.calls()), 1)
            self.assertTrue(core.api_rejection(s.session.err_line()))

    def test_a_write_stops_on_an_ambiguous_failure(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(SERVER_ERROR)
            s = Session()
            self.assertEqual(s.retry("write", ["api", "-X", "POST", "x"]), GhFailed())
            self.assertEqual(len(gh.calls()), 1)
            self.assertFalse(core.api_rejection(s.session.err_line()))

    def test_unclear_attempts_count_the_failures_that_leave_landing_open(self) -> None:
        # gh's own line when GitHub's answer has no readable body: no `gh:`, no HTTP status.
        unreadable = Answer(1, "", "unexpected end of JSON input\n")
        patch = ["api", "-X", "PATCH", "x"]
        with FakeTool("gh") as gh:
            # Under the read policy (an idempotent mutation's) every one of them is repeated.
            gh.script(unreadable)
            s = Session(SHIP_PR_API_ATTEMPTS="3")
            self.assertEqual(s.retry("read", patch), GhUnanswered())
            self.assertEqual(len(gh.calls()), 3)
            self.assertEqual(s.session.unclear_attempts(), 3)
            self.assertEqual(s.session.err_line(), "unexpected end of JSON input")
            # A gateway refusal never reached a backend; a 500 may have.
            gh.script(GATEWAY, GATEWAY)
            s = Session(SHIP_PR_API_ATTEMPTS="2")
            self.assertEqual(s.retry("read", patch), GhUnanswered())
            self.assertEqual(s.session.unclear_attempts(), 0)
            gh.script(SERVER_ERROR, GATEWAY)
            self.assertEqual(s.retry("read", patch), GhUnanswered())
            self.assertEqual(s.session.unclear_attempts(), 1)
            # A 4xx is the API answering, and the write policy's stop is counted as what it is.
            gh.script(NOT_FOUND)
            self.assertEqual(s.retry("read", patch), GhFailed())
            self.assertEqual(s.session.unclear_attempts(), 0)
            gh.script(unreadable)
            self.assertEqual(s.retry("write", patch), GhFailed())
            self.assertEqual(s.session.unclear_attempts(), 1)
            # Each call starts the count again.
            gh.script(Answer(0, "ok\n"))
            self.assertEqual(s.retry("write", patch), GhOk("ok"))
            self.assertEqual(s.session.unclear_attempts(), 0)

    def test_a_fixed_graphql_answer_is_not_retried_under_either_policy(self) -> None:
        for mode in ("read", "write"):
            with FakeTool("gh") as gh:
                gh.script(Answer(1, "{}", 'gh: Expected NAME, actual: STRING ("Bad gateway") at [1, 18]\n'))
                s = Session()
                self.assertEqual(s.retry(mode, ["api", "graphql"]), GhFailed())
                self.assertEqual(len(gh.calls()), 1)

    def test_a_later_success_clears_the_error_line(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(NOT_FOUND, Answer(0, ""))
            s = Session()
            s.retry("read", ["api", "x"])
            self.assertNotEqual(s.session.err_line(), "")
            s.retry("read", ["api", "x"])
            self.assertEqual(s.session.err_line(), "")

    def test_gh_refusing_our_own_call_ends_the_command_with_2(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(1, "", "unknown flag: --nosuch\n\nUsage: ...\n"))
            s = Session()
            with self.assertRaises(GhRefusedOwn) as caught:
                s.retry("write", ["api", "--nosuch", "-f", "body=a secret reply", "-F", "x=@f"])
            self.assertEqual(len(gh.calls()), 1)
            end = caught.exception
            self.assertEqual(end.rc, 2)
            self.assertTrue(end.raw)
            self.assertIn(
                "pr-review.sh: the installed gh refused this script's own call, which sent nothing:"
                " gh api --nosuch -f body=... -F x=... -> unknown flag: --nosuch. That is a version"
                " mismatch between pr-review.sh and the installed gh",
                end.message,
            )
            self.assertNotIn("secret", end.message)

    def test_main_prints_an_own_refusal_once_and_exits_2(self) -> None:
        def run(_argv: list[str]) -> int:
            raise GhRefusedOwn("pr-review.sh: the installed gh refused ...")

        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = cli.main_guard(core.PROG, run, [])
        self.assertEqual(rc, 2)
        self.assertEqual(err.getvalue(), "pr-review.sh: the installed gh refused ...\n")

    def test_a_callers_refused_arguments_return_2_when_listed(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(1, "", 'Unknown JSON field: "x"\nAvailable fields:\n'))
            s = Session(SHIP_PR_API_ATTEMPTS="3")
            self.assertEqual(
                s.session.retry_caller("read", ["pr", "view", "1"], listed=True), GhArgsRefused()
            )
            self.assertEqual(len(gh.calls()), 1)
            # Unlisted: the stderr is not read as gh's, so the read policy retries it.
            gh.script(Answer(1, "", 'Unknown JSON field: "x"\n'))
            with contextlib.redirect_stderr(io.StringIO()):
                result = s.session.retry_caller("read", ["ext", "x"], listed=False)
            self.assertEqual(result, GhUnanswered())
            self.assertEqual(len(gh.calls()), 3)


class ShellQuote(unittest.TestCase):
    def test_like_printf_q(self) -> None:
        for word, want in (
            ("", "''"),
            ("plain-word_1.2/x:y=z@%", "plain-word_1.2/x:y=z@%"),
            ("a b", "a\\ b"),
            ("x,y", "x\\,y"),
            ("#c", "\\#c"),
            ("d#", "d#"),
            ("e\nf", "$'e\\nf'"),
            ("$(x)'\"", "\\$\\(x\\)\\'\\\""),
        ):
            self.assertEqual(core.shell_quote(word), want, word)

    def test_non_ascii_is_bash_s_own_under_every_locale(self) -> None:
        # printf %q of non-ASCII depends on the locale and the C library: under a UTF-8 locale
        # macOS's bash leaves "naïve" alone, which a fixed $'...' table quoted (#403 review).
        words = ("docs/naïve.md", "a b/ï.md", "#ï", "x$y€", "tab\tï", "é'q", "é")
        saved = os.environ.get("LC_ALL")
        try:
            for locale in ("C", "en_US.UTF-8", "C.UTF-8"):
                os.environ["LC_ALL"] = locale
                for word in words:
                    want = proc.run_tool("bash", ["-c", 'printf %q "$1"', "bash", word]).stdout
                    self.assertEqual(core.shell_quote(word), want, f"{locale}: {word}")
        finally:
            if saved is None:
                os.environ.pop("LC_ALL", None)
            else:
                os.environ["LC_ALL"] = saved


class Refs(unittest.TestCase):
    def test_parse_ref_accepts_exactly_two_shapes(self) -> None:
        self.assertEqual(core.parse_ref("7"), Ref("", "7"))
        self.assertEqual(core.parse_ref("007"), Ref("", "007"))
        self.assertEqual(core.parse_ref("o.x/r-y_z#12"), Ref("o.x/r-y_z", "12"))
        for bad in ("", "#7", "o/r#", "o/r#7#8", "junk#123", "a/b/c#1", "/r#1", "o/#1",
                    "o r/x#1", "7a", "o/r#-1", "o/r#١"):
            self.assertIsNone(core.parse_ref(bad), bad)

    def test_pr_arg_takes_the_repo_from_the_argument_first(self) -> None:
        self.assertEqual(core.pr_arg("a/b#7", "o/r"), core.PrTarget("a/b", "7"))
        self.assertEqual(core.pr_arg("7", "o/r"), core.PrTarget("o/r", "7"))

    def test_a_bare_number_with_no_repo_is_refused(self) -> None:
        with self.assertRaises(cli.Exit) as caught:
            core.pr_arg("7", "")
        self.assertEqual(caught.exception.rc, 2)
        self.assertIn("Pass it as owner/name#7 (or --repo owner/name", caught.exception.message)
        with self.assertRaises(cli.Exit) as caught:
            core.pr_arg("o/r#x", "o/r")
        self.assertEqual(caught.exception.message, "PR must be a number or owner/name#number, got 'o/r#x'")

    def test_repo_from_cwd(self) -> None:
        def runner(gh: proc.Completed, git: proc.Completed):
            def run(name: str, args: Sequence[str]) -> proc.Completed:
                return gh if name == "gh" else git
            return run

        ok = proc.Completed(0, "", "")
        failed = proc.Completed(1, "", "boom")
        self.assertEqual(core.repo_from_cwd(runner(proc.Completed(0, "a/b\n", ""), failed)), "a/b")
        for url, want in (
            ("https://github.com/o/r.git\n", "o/r"),
            ("git@github.com:o/r\n", "o/r"),
            ("https://gitlab.com/o/r.git\n", None),
            ("https://github.com/o\n", None),
        ):
            got = core.repo_from_cwd(runner(failed, proc.Completed(0, url, "")))
            self.assertEqual(got, want, url)
        self.assertIsNone(core.repo_from_cwd(runner(ok, failed)))


class Feeds(unittest.TestCase):
    def test_api_list_splices_every_pages_array_and_drops_the_rest(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(0, '[{"id":1},{"id":2}]\n[{"id":3}]{"message":"x"}\n[]\n'))
            s = Session()
            got = core.api_list(s.session, "issues/7/comments?per_page=100", "o/r")
            self.assertEqual(got, ListOk([{"id": 1}, {"id": 2}, {"id": 3}]))
            self.assertEqual(gh.calls(), [["api", "--paginate", "repos/o/r/issues/7/comments?per_page=100"]])

    def test_a_failed_read_is_never_an_empty_feed(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(0, "<html>oops</html>"))
            self.assertEqual(core.api_list(Session().session, "x", "o/r"), ListUnparsed())
            gh.script(NOT_FOUND)
            self.assertEqual(core.api_list(Session().session, "x", "o/r"), GhFailed())
            gh.script(Answer(0, ""))
            self.assertEqual(core.api_list(Session().session, "x", "o/r"), ListOk([]))

    def test_mark_of_reads_one_feeds_watermark(self) -> None:
        self.assertEqual(core.mark_of("10,20,30", 2), 20)
        self.assertEqual(core.mark_of("10,20,30", 4), 0)
        self.assertEqual(core.mark_of("10,x,30", 2), 0)
        self.assertEqual(core.mark_of("", 1), 0)
        # cut -d, prints a line with no comma whole, for any field.
        self.assertEqual(core.mark_of("55", 3), 55)


if __name__ == "__main__":
    unittest.main()
