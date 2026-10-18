"""The writers (``reply``, ``resolve``, ``comment``) and ``retry`` (with ``run watch``), in process.

The conformance suites (ship-pr/scripts/test-pr-review-reply.sh, test-pr-review-retry.sh) drive
these through the shell and its fixture gh; the cases here pin the logic those messages are made
of -- the token grammar, the mention allowlist, a batch's progress, jq's reading of a thread, the
walk's paging, the await's clock -- with a scripted gh handed to the session, so each runs in
milliseconds. The last class runs the production path: pr-review.sh's main exec'ing the Python,
with a fake gh BINARY on PATH.
"""

import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
from collections.abc import Callable, Sequence
from contextlib import redirect_stderr, redirect_stdout

from ludics import cli
from ludics.proc import Completed
from ludics.prreview import comment, reply, resolve, retry, runwatch, space
from ludics.prreview.clock import FuncClock
from ludics.prreview.core import Config, GhSession, Json
from ludics.tests.fake import Answer, FakeTool

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")

type Answerer = Callable[[list[str]], Completed]


class Gh:
    """A scripted gh for the session: each call is logged and answered by ``answer``."""

    def __init__(self, answer: Answerer) -> None:
        self.answer = answer
        self.calls: list[list[str]] = []

    def __call__(self, name: str, args: Sequence[str]) -> Completed:
        assert name == "gh", name
        call = list(args)
        self.calls.append(call)
        return self.answer(call)


def ok(stdout: str = "") -> Completed:
    return Completed(0, stdout, "")


def err(stderr: str) -> Completed:
    return Completed(1, "", stderr + "\n")


def session(gh: Gh, *, attempts: int = 2, repo: str = "o/r") -> GhSession:
    config = Config(
        repo=repo, reviewer="r", round_threshold=12, round_gap=900, api_attempts=attempts,
        api_backoff=0,
    )
    return GhSession(config, run=gh, sleep=lambda _s: None)


def invoke(fn: Callable[[], int]) -> tuple[int, str, str]:
    """Run a command as main_guard would: (status, stdout, stderr)."""
    out, errs = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(errs):
        try:
            rc = fn()
        except cli.Exit as end:
            rc = end.rc
            if end.message:
                errs.write(end.message + "\n" if end.raw else f"pr-review.sh: {end.message}\n")
    return rc, out.getvalue(), errs.getvalue()


def reply_url(call: list[str]) -> Completed:
    endpoint = call[3]
    cid = endpoint.split("/comments/")[1].split("/")[0]
    return ok(f"https://github.com/o/r/pull/7#discussion_r{cid}\n")


def field(call: list[str], name: str) -> str:
    for flag, value in zip(call, call[1:]):
        if flag in ("-f", "-F") and value.startswith(name + "="):
            return value[len(name) + 1 :]
    raise AssertionError(f"no field {name} in {call}")


class Token(unittest.TestCase):
    def test_the_grammar_is_matched_whole(self) -> None:
        self.assertEqual(reply.split_ids("900+901+900+0902", "reply"), ["900", "901", "0902"])
        for bad in ("", "+900", "900+", "900++901", "900 901", "*", "9a", "900,901", "９００"):
            with self.subTest(bad=bad):
                rc, _, errs = invoke(lambda bad=bad: len(reply.split_ids(bad, "resolve")))
                self.assertEqual(rc, 2)
                self.assertIn(f"resolve: '{bad}' is not a comment id", errs)

    def test_ids_token_is_pasteable(self) -> None:
        self.assertEqual(reply.ids_token(["901", "902"]), "901+902")


class Mention(unittest.TestCase):
    def test_only_comment_s_bare_nudge_passes(self) -> None:
        for body in ("@codex review", "@codex review\n \t"):
            reply.mention_refusal("comment", body)
        for command, body in (
            ("reply", "@codex review"),
            ("comment", "@codex review please"),
            ("comment", " @codex review"),
            ("comment", "@CODEX review"),
            ("reply", "mail ops@codex.example"),
            ("reply", "cc @codex-bot"),
        ):
            with self.subTest(command=command, body=body):
                rc, _, errs = invoke(lambda c=command, b=body: (reply.mention_refusal(c, b), 0)[1])
                self.assertEqual(rc, 2)
                self.assertIn("any mention is an instruction to the connector", errs)
        reply.mention_refusal("reply", "the codex review nudge")


class SpaceTable(unittest.TestCase):
    """The class a native Windows interpreter falls back to, read off the environment as Cygwin
    reads it (the C library's own class is what the reply suite pins, against this bash)."""

    def test_the_table_follows_the_locale_variables(self) -> None:
        for env, utf8 in (
            ({"LC_ALL": "en_US.UTF-8"}, True),
            ({"LC_ALL": "C"}, False),
            ({"LC_ALL": "", "LC_CTYPE": "", "LANG": "C"}, False),
            ({"LC_CTYPE": "C.utf8"}, True),
            ({}, True),
        ):
            with self.subTest(env=env), mock.patch.dict(os.environ, env, clear=True):
                table = space._table()  # pyright: ignore[reportPrivateUsage]
                self.assertEqual(table.utf8, utf8)
                self.assertEqual(table.wide(0x3000), utf8)
                self.assertEqual(table.wide(0x2003), utf8)
                # newlib's iswspace takes every Zs, the no-break ones included (Git Bash's bash
                # read U+00A0 as whitespace under en_US.UTF-8, windows git bash run 37377447173).
                for code in (0x00A0, 0x2007, 0x202F, 0x2028, 0x2029):
                    self.assertEqual(table.wide(code), utf8, hex(code))
                self.assertFalse(table.wide(0x200B), "a zero-width space is Cf, not a separator")
                self.assertFalse(table.wide(0x0085), "nor is NEL, a control")
                self.assertTrue(table.byte(ord("\t")))
                self.assertFalse(table.byte(0xA0))


class Reply(unittest.TestCase):
    def test_a_folded_entry_posts_the_answer_once_and_pointers_after_it(self) -> None:
        gh = Gh(reply_url)
        rc, out, errs = invoke(lambda: reply.run(session(gh), ["7", "900+901", "Fixed."]))
        self.assertEqual((rc, errs), (0, ""))
        self.assertEqual(out.splitlines(), [
            "https://github.com/o/r/pull/7#discussion_r900",
            "https://github.com/o/r/pull/7#discussion_r901",
        ])
        self.assertEqual(field(gh.calls[0], "body"), "Fixed." + reply.MARKER)
        self.assertEqual(
            field(gh.calls[1], "body"),
            "Duplicate of the thread answered at https://github.com/o/r/pull/7#discussion_r900"
            " — see there." + reply.MARKER,
        )

    def test_an_anchor_with_no_url_back_is_named_by_its_id(self) -> None:
        gh = Gh(lambda call: ok(""))
        rc, out, _ = invoke(lambda: reply.run(session(gh), ["7", "900+901", "Fixed."]))
        self.assertEqual((rc, out), (0, ""))
        self.assertTrue(field(gh.calls[1], "body").startswith(
            "Duplicate of the thread answered at comment 900 — see there."))

    def test_progress_turns_on_the_classification(self) -> None:
        def failing(message: str) -> Answerer:
            return lambda call: err(message) if "/901/" in call[3] else reply_url(call)

        cases = (
            ("gh: HTTP 503: Service Unavailable", 3,
             "The replies to 900 DID land, so do not repeat those. Nothing was posted for comment 901,"
             " so retry with: 901+902 --anchor 900"),
            ("gh: Not Found (HTTP 404)", 1,
             "Comment 901 got nothing, so once the id is right, retry with: 901+902 --anchor 900"),
            ("gh: Internal Server Error (HTTP 500)", 3,
             "Read comment 901's thread: retry with: 901+902 --anchor 900 if the reply is not there;"
             " retry with: 902 --anchor 900 if it is  902\n"),
        )
        for message, want_rc, says in cases:
            with self.subTest(message=message):
                gh = Gh(failing(message))
                rc, out, errs = invoke(lambda gh=gh: reply.run(session(gh), ["7", "900+901+902", "x"]))
                self.assertEqual(rc, want_rc)
                self.assertIn(says, errs)
                self.assertEqual(out, "https://github.com/o/r/pull/7#discussion_r900\n")
                self.assertFalse(any("/902/" in call[3] for call in gh.calls), "the batch stops")

    def test_an_ambiguous_last_write_has_nothing_outstanding(self) -> None:
        gh = Gh(lambda call: err("gh: HTTP 500") if "/901/" in call[3] else reply_url(call))
        _, _, errs = invoke(lambda: reply.run(session(gh), ["7", "900+901", "x"]))
        self.assertIn(
            "retry with: 901 --anchor 900 if the reply is not there;  there is nothing else"
            " outstanding if it is\n", errs)

    def test_usage_is_checked_before_anything_is_sent(self) -> None:
        for args, says in (
            (["7", "900"], "got 2 argument(s)"),
            (["7", "900", " \n\t"], "the body is empty"),
            (["7", "900", "--anchor"], "--anchor takes the comment id"),
            (["7", "901", "--anchor", "900", "body"], "no body is taken"),
            (["7", "900+901", "--anchor=900"], "is also in the token"),
            (["7", "901", "--anchor", "9x"], "--anchor takes one comment id, got '9x'"),
            (["7", "900", "ask @codex"], "--allow-mention"),
        ):
            with self.subTest(args=args):
                gh = Gh(reply_url)
                rc, _, errs = invoke(lambda args=args, gh=gh: reply.run(session(gh), args))
                self.assertEqual(rc, 2)
                self.assertIn(says, errs)
                self.assertEqual(gh.calls, [])


class Comment(unittest.TestCase):
    def test_the_issue_endpoint_and_the_exits(self) -> None:
        gh = Gh(lambda call: ok("https://github.com/a/b/pull/8#issuecomment-1\n"))
        rc, out, _ = invoke(lambda: comment.run(session(gh), ["a/b#8", "Done."]))
        self.assertEqual((rc, out), (0, "https://github.com/a/b/pull/8#issuecomment-1\n"))
        self.assertEqual(gh.calls[0][:4], ["api", "-X", "POST", "repos/a/b/issues/8/comments"])
        self.assertEqual(field(gh.calls[0], "body"), "Done." + reply.MARKER)
        for message, want_rc, says, calls in (
            ("gh: Not Found (HTTP 404)", 1, "was REJECTED, not dropped", 1),
            ("gh: HTTP 502: Bad gateway", 3, "Nothing was posted, so retry.", 2),
            ("gh: HTTP 500", 3, "will not post it twice", 1),
        ):
            with self.subTest(message=message):
                gh = Gh(lambda call, m=message: err(m))
                rc, _, errs = invoke(lambda gh=gh: comment.run(session(gh), ["a/b#8", "Done."]))
                self.assertEqual(rc, want_rc)
                self.assertIn(says, errs)
                self.assertEqual(len(gh.calls), calls)


def unreadable(status: str) -> Completed:
    """An answer gh could not read the body of, as ``gh api --include`` prints it (ludics-lite#612):
    the status line and a blank line on stdout, the decoder's complaint alone on stderr."""
    return Completed(1, f"{status}\r\n\r\n", "unexpected end of JSON input\n")


class UnreadableAnswers(unittest.TestCase):
    """ludics-lite#612: each own `gh api` write carries --include, and an answer gh could not read
    is told apart by its status line."""

    def test_comment_tells_the_statuses_apart(self) -> None:
        for status, want_rc, says, calls in (
            ("HTTP/2.0 502 Bad Gateway", 3, "Nothing was posted, so retry.", 2),
            ("HTTP/2.0 503 Service Unavailable", 3, "Nothing was posted, so retry.", 2),
            ("HTTP/2.0 200 OK", 3, "will not post it twice", 1),
            ("HTTP/2.0 422 Unprocessable Entity", 1, "was REJECTED, not dropped", 1),
            ("HTTP/2.0 429 Too Many Requests", 3, "Nothing was posted, so retry.", 1),
        ):
            with self.subTest(status=status):
                gh = Gh(lambda call, st=status: unreadable(st))
                rc, out, errs = invoke(lambda gh=gh: comment.run(session(gh), ["a/b#8", "Done."]))
                self.assertEqual((rc, out), (want_rc, ""))
                self.assertIn(says, errs)
                self.assertIn(f"(HTTP {status.split()[1]})", errs, "the status is named")
                self.assertEqual(len(gh.calls), calls)
                self.assertEqual(gh.calls[0][-1], "--include")
        # The gateway's refusal re-sent, and the second answer read past its header block.
        answers = [unreadable("HTTP/2.0 502 Bad Gateway"),
                   Completed(0, "HTTP/2.0 201 Created\r\n\r\nhttps://github.com/a/b/pull/8#issuecomment-1\n", "")]
        gh = Gh(lambda call: answers[min(len(gh.calls), 2) - 1])
        rc, out, _ = invoke(lambda: comment.run(session(gh), ["a/b#8", "Done."]))
        self.assertEqual((rc, out), (0, "https://github.com/a/b/pull/8#issuecomment-1\n"))

    def test_reply_says_nothing_was_posted_only_for_a_gateway_s_status(self) -> None:
        for status, want_rc, says in (
            ("HTTP/2.0 503 Service Unavailable", 3, "Nothing was posted for comment 900"),
            ("HTTP/2.0 201 Created", 3, "the reply MAY have landed"),
        ):
            with self.subTest(status=status):
                gh = Gh(lambda call, st=status: unreadable(st))
                rc, _, errs = invoke(lambda gh=gh: reply.run(session(gh), ["7", "900", "x"]))
                self.assertEqual(rc, want_rc)
                self.assertIn(says, errs)
                self.assertTrue(all(call[-1] == "--include" for call in gh.calls))


def thread(cid: int | None, resolved: bool = False, **extra: Json) -> dict[str, Json]:
    first: dict[str, Json] = {"fullDatabaseId": str(cid), "databaseId": cid}
    node: dict[str, Json] = {
        "id": f"T{cid}", "isResolved": resolved, "path": "a.sh",
        "comments": {"nodes": [first]},
    }
    node.update(extra)
    return node


def threads_answer(nodes: list[Json], *, size: int = 100, total: int | None = None) -> Answerer:
    """The reviewThreads connection the walk's --jq selects, paged ``size`` at a time."""

    def answer(call: list[str]) -> Completed:
        if any(arg.startswith("query=mutation") for arg in call):
            return ok("true\n")
        start = 0
        for arg in call:
            if arg.startswith("after=c"):
                start = int(arg[len("after=c") :])
        page = nodes[start : start + size]
        conn: dict[str, Json] = {
            "totalCount": len(nodes) if total is None else total,
            "pageInfo": {"hasNextPage": start + size < len(nodes), "endCursor": f"c{start + size}"},
            "nodes": page,
        }
        return ok(json.dumps(conn, indent=2) + "\n")

    return answer


class Threads(unittest.TestCase):
    def test_a_thread_is_named_full_width_first_as_jq_names_it(self) -> None:
        self.assertEqual(resolve.thread_id(thread(4095735684)), "4095735684")
        self.assertEqual(
            resolve.thread_id({"comments": {"nodes": [{"fullDatabaseId": None, "databaseId": 900}]}}),
            "900",
        )
        self.assertEqual(resolve.thread_id({"comments": {"nodes": []}}), "-")
        self.assertEqual(resolve.thread_id(None), "-")
        self.assertEqual(resolve.thread_id({"comments": {"nodes": [{"databaseId": 4.0}]}}), "4.0")
        bads: list[Json] = [5, {"comments": 5}, {"comments": {"nodes": {"a": 1}}},
                            {"comments": {"nodes": [7]}}]
        for bad in bads:
            with self.subTest(bad=bad), self.assertRaises(resolve.JqError):
                resolve.thread_id(bad)

    def test_resolve_finds_a_thread_on_a_later_page_and_matches_without_leading_zeros(self) -> None:
        gh = Gh(threads_answer([thread(900), thread(901), thread(902)], size=1))
        rc, out, errs = invoke(lambda: resolve.run(session(gh), ["7", "0902"], env={}))
        self.assertEqual((rc, out, errs), (0, "true\n", ""))
        self.assertEqual(sum(1 for c in gh.calls if "--jq" in c and c[-1].endswith("reviewThreads")), 3)
        self.assertIn('threadId:"T902"', gh.calls[-1][3])
        self.assertEqual(field(gh.calls[1], "after"), "c1")

    def test_labels_and_already_resolved(self) -> None:
        gh = Gh(threads_answer([thread(900), thread(903, True)]))
        rc, out, _ = invoke(lambda: resolve.run(session(gh), ["7", "903+900"], env={}))
        self.assertEqual((rc, out), (0, "903 true (already resolved)\n900 true\n"))
        mutations = [c for c in gh.calls if c[3].startswith("query=mutation")]
        self.assertEqual(len(mutations), 1)

    def test_the_walk_refuses_what_is_not_a_whole_read(self) -> None:
        nodes: list[Json] = [thread(900), thread(901)]
        cases: tuple[tuple[Answerer, dict[str, str], int, str], ...] = (
            (threads_answer(nodes, total=9), {}, 3, "ended at 2 thread(s) while the PR states 9"),
            (threads_answer(nodes, size=1), {resolve.PAGE_CAP_ENV: "1"}, 3,
             "still paging after 1 pages of 100"),
            (lambda call: ok("null\n"), {}, 3, "answered page 1 without a thread connection"),
            (lambda call: ok('{"totalCount":2.0,"pageInfo":{"hasNextPage":false},"nodes":[]}'), {},
             3, "without a thread connection"),
            (lambda call: ok('{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[5]}'), {},
             3, "with threads that did not parse"),
            (lambda call: ok('{"totalCount":2,"pageInfo":{"hasNextPage":true,"endCursor":null},'
                             '"nodes":[]}'), {}, 3, "gave no cursor to it"),
            (lambda call: err("gh: HTTP 401: Bad credentials"), {}, 2,
             "GraphQL REJECTED the thread lookup for PR o/r#7: gh: HTTP 401: Bad credentials."),
            (lambda call: err("gh: HTTP 503"), {}, 3,
             "did not complete: GraphQL did not answer the review-threads read after 2 attempts"),
        )
        for answer, env, want_rc, says in cases:
            with self.subTest(says=says):
                rc, _, errs = invoke(lambda a=answer, e=env: resolve.run(session(Gh(a)), ["7", "905"], env=e))
                self.assertEqual(rc, want_rc, errs)
                self.assertIn(says, errs)
                self.assertNotIn("no review thread starts", errs)

    def test_a_miss_after_a_whole_read_is_a_real_answer_with_progress(self) -> None:
        gh = Gh(threads_answer([thread(900), thread(901)]))
        rc, out, errs = invoke(lambda: resolve.run(session(gh), ["7", "900+999"], env={}))
        self.assertEqual(rc, 1)
        self.assertEqual(out, "900 true\n")
        self.assertIn("no review thread starts at comment 999", errs)
        self.assertIn(
            "Already resolved in this invocation: 900 — resolving is\nidempotent, so the whole token"
            " is safe to repeat.", errs)


class Clock:
    """A clock the await's sleeps move, so a two-hour deadline runs in no time."""

    def __init__(self) -> None:
        self.now = 1_000_000.5
        self.slept: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def run_view(status: str, conclusion: str = "") -> Answerer:
    return lambda call: ok(f"{status}\t{conclusion or 'pending'}\n")


class RunWatch(unittest.TestCase):
    def watch(
        self, args: list[str], answer: Answerer, env: dict[str, str] | None = None,
        clock: Clock | None = None, repo: str = "",
    ) -> tuple[int, str, str, Gh]:
        gh = Gh(answer)
        c = clock or Clock()
        result = invoke(lambda: runwatch.run(
            session(gh, repo=repo), args, env=env or {}, clock=FuncClock(time=c.time, sleep=c.sleep)))
        return (*result, gh)

    def test_the_sleep_is_capped_at_the_deadline_and_the_heartbeat_is_said(self) -> None:
        clock = Clock()
        env = {"SHIP_PR_CHECKS_WAIT": "100", "SHIP_PR_CHECKS_HEARTBEAT": "60"}
        rc, _, errs, gh = self.watch(["o/r#5", "-i", "45"], run_view("queued"), env, clock)
        self.assertEqual(rc, 4)
        self.assertEqual(clock.slept, [45, 45, 10])
        self.assertEqual(len(gh.calls), 4)
        self.assertEqual(errs.count("still waiting on run 5 in o/r: queued after"), 1)
        self.assertIn("still waiting on run 5 in o/r: queued after 1 min", errs)
        self.assertIn("has NO VERDICT after 1 min (status: queued)", errs)

    def test_each_conclusion_class(self) -> None:
        for conclusion, want in (("success", 0), ("neutral", 0), ("skipped", 0), ("failure", 1),
                                 ("timed_out", 1), ("startup_failure", 1), ("cancelled", 4),
                                 ("stale", 4), ("", 4)):
            with self.subTest(conclusion=conclusion):
                rc, out, errs, _ = self.watch(["o/r#5"], run_view("completed", conclusion))
                self.assertEqual(rc, want, errs)
                if want == 0:
                    self.assertEqual(out, f"run 5 in o/r: {conclusion}\n")

    def test_the_target_and_the_flags(self) -> None:
        completed = run_view("completed", "success")
        for args, repo in ((["-R", "a/b", "5"], ""), (["--repo=a/b", "5"], ""), (["5"], "a/b"),
                           (["a/b#5", "-R", "a/b"], "x/y"), (["a/b#5", "--compact", "-i=3"], "")):
            with self.subTest(args=args):
                rc, out, _, gh = self.watch(args, completed, repo=repo)
                self.assertEqual((rc, out), (0, "run 5 in a/b: success\n"))
                self.assertEqual(gh.calls[0][:5], ["run", "view", "5", "--repo", "a/b"])
        for args, says in ((["5"], "name the repo"), (["a/b#5", "-R", "c/d"], "two explicit targets"),
                           (["a/b#5", "-R"], "-R needs owner/name"), (["a/b#5", "-i", "0"], "at least 1"),
                           (["a/b#5", "-i=x"], "must be seconds"), (["a/b#5", "-q"], "unsupported flag"),
                           (["a/b#5", "a/b#6"], "name exactly one"), ([], "name the run"),
                           (["a/b#5#6"], "the run must be owner/name#<run-id>")):
            with self.subTest(args=args):
                rc, _, errs, gh = self.watch(args, completed)
                self.assertEqual(rc, 2)
                self.assertIn(says, errs)
                self.assertEqual(gh.calls, [])

    def test_a_rejected_pair_is_usage_and_an_outage_unknown(self) -> None:
        rc, _, errs, _ = self.watch(["o/r#5"], lambda call: err("gh: Not Found (HTTP 404)"))
        self.assertEqual(rc, 2)
        self.assertIn("o/r has no run 5 readable here", errs)
        rc, _, errs, _ = self.watch(["o/r#5"], lambda call: err("gh: HTTP 503"))
        self.assertEqual(rc, 3)
        self.assertIn("the run's state is UNKNOWN", errs)

    def test_the_timing_is_validated(self) -> None:
        for env, says in (({"SHIP_PR_CHECKS_INTERVAL": "0"}, "at least 1 second"),
                          ({"SHIP_PR_CHECKS_WAIT": "1.5"}, "SHIP_PR_CHECKS_WAIT must be whole"),
                          ({"SHIP_PR_CHECKS_HEARTBEAT": "x"}, "SHIP_PR_CHECKS_HEARTBEAT must be")):
            with self.subTest(env=env):
                rc, _, errs = invoke(lambda env=env: runwatch.load_timing(env).wait)
                self.assertEqual(rc, 2)
                self.assertIn(says, errs)
        self.assertEqual(runwatch.load_timing({"SHIP_PR_CHECKS_WAIT": ""}),
                         runwatch.Timing(60, 7200, 600))


class Retry(unittest.TestCase):
    def test_the_answer_passes_through_and_retry_s_own_words_are_dropped(self) -> None:
        for prefix in ([], ["--read"], ["--write"], ["gh"], ["--read", "gh"]):
            with self.subTest(prefix=prefix):
                gh = Gh(lambda call: ok("a\nb\n\n"))
                rc, out, _ = invoke(lambda gh=gh, p=prefix: retry.run(session(gh), [*p, "api", "x/y"]))
                self.assertEqual((rc, out), (0, "a\nb\n"))
                self.assertEqual(gh.calls, [["api", "x/y"]])
        gh = Gh(lambda call: ok(""))
        self.assertEqual(invoke(lambda: retry.run(session(gh), ["api", "x/y"]))[:2], (0, ""))
        for args in ([], ["--read"], ["gh"], ["--write", "gh"]):
            with self.subTest(args=args):
                rc, _, errs = invoke(lambda a=args: retry.run(session(Gh(ok_any)), a))
                self.assertEqual(rc, 2)
                self.assertIn("usage: retry [--read] <gh args...>", errs)

    def test_the_policies(self) -> None:
        cases = (
            (["api", "x/y"], "gh: HTTP 500", 3, "gh api failed AMBIGUOUSLY", 1),
            (["--read", "api", "x/y"], "gh: HTTP 500", 3, "gh api did not go through after 2", 2),
            (["api", "x/y"], "gh: HTTP 404", 1, "gh api was rejected: gh: HTTP 404", 1),
            (["api", "graphql"], "gh: Field 'x' doesn't exist on type 'User'", 1, "was rejected", 1),
            (["pr", "view", "1"], "unknown flag: --x", 2, "refused its own arguments", 1),
            (["pr", "merge", "1"], "unknown flag: --x", 3, "AMBIGUOUSLY", 1),
        )
        for args, message, want_rc, says, calls in cases:
            with self.subTest(args=args, message=message):
                gh = Gh(lambda call, m=message: err(m))
                rc, out, errs = invoke(lambda gh=gh, a=args: retry.run(session(gh), a))
                self.assertEqual((rc, out), (want_rc, ""))
                self.assertIn(says, errs)
                self.assertEqual(len(gh.calls), calls)


def ok_any(call: list[str]) -> Completed:
    return ok("")


class ProductionPath(unittest.TestCase):
    """pr-review.sh's main exec's the Python for each ported name, with gh the binary on PATH."""

    def run_cmd(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        cwd = os.path.realpath(tempfile.mkdtemp(prefix="ludics-writers-test."))
        env.update({"REPO": "", "SHIP_PR_API_ATTEMPTS": "2", "SHIP_PR_API_BACKOFF": "0",
                    "SHIP_PR_STATE_DIR": os.path.join(cwd, "state")})
        try:
            return subprocess.run([PR_REVIEW, *args], capture_output=True, text=True, env=env,
                                  cwd=cwd, check=False)
        finally:
            shutil.rmtree(cwd, ignore_errors=True)

    def test_each_writer_and_retry_reaches_the_binary(self) -> None:
        cases = (
            (("reply", "o/r#7", "900", "Fixed."), "u\n", "repos/o/r/pulls/7/comments/900/replies"),
            (("comment", "o/r#7", "Done."), "u\n", "repos/o/r/issues/7/comments"),
            (("--repo", "o/r", "retry", "--read", "api", "repos/o/r/pulls/7"), "u\n",
             "repos/o/r/pulls/7"),
        )
        for args, answer, endpoint in cases:
            with self.subTest(args=args), FakeTool("gh") as gh:
                gh.script(Answer(0, answer))
                done = self.run_cmd(*args)
                self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "u\n", ""))
                self.assertIn(endpoint, gh.calls()[0])

    def test_run_watch_and_resolve_reach_the_binary(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(0, "completed\tsuccess\n"))
            done = self.run_cmd("retry", "run", "watch", "o/r#42")
            self.assertEqual((done.returncode, done.stdout), (0, "run 42 in o/r: success\n"))
            conn = {"totalCount": 1, "pageInfo": {"hasNextPage": False, "endCursor": "c1"},
                    "nodes": [thread(900, True)]}
            gh.script(Answer(0, json.dumps(conn)))
            done = self.run_cmd("resolve", "o/r#7", "900")
            self.assertEqual((done.returncode, done.stdout), (0, "true (already resolved)\n"))

    def test_a_bare_number_is_refused_with_nothing_sent(self) -> None:
        for args in (("reply", "7", "900", "x"), ("resolve", "7", "900"), ("comment", "7", "x")):
            with self.subTest(args=args), FakeTool("gh") as gh:
                done = self.run_cmd(*args)
                self.assertEqual(done.returncode, 2)
                self.assertIn("Pass it as owner/name#7", done.stderr)
                self.assertEqual(gh.calls(), [])


if __name__ == "__main__":
    unittest.main()
