"""ludics.prreview's readers: poll, rounds, status, and the jq semantics they read feeds with.

The shell suites (test-pr-review-status.sh, -rounds.sh, -watch.sh) are the conformance suite;
these pin the logic underneath them directly, with gh replaced by a table of answers. Since the
integration (ludics-lite#403) the readers and ``watch`` share one implementation (feeds.py,
state.py, poll.py, jqsem.py), so these pin what both read.
"""

import contextlib
import io
import json
import time
import unittest
from collections.abc import Callable, Sequence
from typing import Any
from unittest import mock

from ludics import proc
from ludics.prreview import jqsem as jq
from ludics.prreview import poll, rounds, state, status, threads
from ludics.prreview.clock import FuncClock
from ludics.prreview.core import GhSession, Json, json_stream, load_config
from ludics.prreview.feeds import HEAD_JQ, Ctx
from ludics.prreview.shtext import tab_fields

REV = "chatgpt-codex-connector"
BOT = REV + "[bot]"
HEAD = "a" * 40


def iso(seconds_ago: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds_ago))


def tsv(fields: Sequence[str]) -> str:
    """``@tsv`` over strings."""
    return "\t".join(
        f.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")
        for f in fields
    )


class FakeGh:
    """gh as a table: endpoint -> JSON (or a callable of the args), applying the few --jq filters
    the readers send the way gh would."""

    def __init__(self, answers: dict[str, Json | Callable[[Sequence[str]], Json]]) -> None:
        self.answers = answers
        self.calls: list[str] = []
        self.down: set[str] = set()

    def __call__(self, name: str, args: Sequence[str]) -> proc.Completed:
        assert name == "gh" and args[0] == "api"
        endpoint = next(a for a in args[1:] if not a.startswith("-") and "/" in a or a == "graphql")
        self.calls.append(endpoint)
        if endpoint in self.down:
            return proc.Completed(1, "", "gh: HTTP 503: No server is currently available\n")
        answer = self.answers.get(endpoint)
        if answer is None:
            return proc.Completed(1, "", "gh: Not Found (HTTP 404)\n")
        value = answer(args) if callable(answer) else answer
        if "--jq" in args:
            return proc.Completed(0, self._filter(args[args.index("--jq") + 1], value), "")
        return proc.Completed(0, json.dumps(value) + "\n", "")

    @staticmethod
    def _filter(expr: str, value: Json) -> str:
        if expr == HEAD_JQ:
            fields = [jq.jstr(jq.alt(jq.path(value, *p), "-")) for p in (("head", "sha"),
                      ("mergeable_state",), ("created_at",))]
            return tsv(fields) + "\n"
        if expr == ".commit.committer.date":
            return jq.jstr(jq.path(value, "commit", "committer", "date")) + "\n"
        if expr == ".data.repository.pullRequest.reviewThreads":
            return json.dumps(jq.path(value, "data", "repository", "pullRequest", "reviewThreads")) + "\n"
        raise AssertionError(f"unexpected --jq {expr}")


def session(gh: FakeGh, **env: str) -> GhSession:
    base = {"REPO": "o/r", "SHIP_PR_API_ATTEMPTS": "1", "SHIP_PR_API_BACKOFF": "0"}
    base.update(env)
    return GhSession(load_config(base), run=gh, sleep=lambda _s: None)


def ctx(gh: FakeGh, nudge_after: int | None = None, **env: str) -> Ctx:
    """The reads' context outside a watch, on the wall clock, STALL 2400."""
    s = session(gh, **env)
    return Ctx(s, "o/r", s.config.reviewer, FuncClock(), 2400, nudge_after=nudge_after)


def feeds(
    *,
    reactions: Sequence[Json] | None = None,
    comments: Sequence[Json] | None = None,
    reviews: Sequence[Json] | None = None,
    inline: Sequence[Json] | None = None,
    review_comments: Sequence[Json] | None = None,
    head: str = HEAD,
    mstate: str = "clean",
    created: str = "2026-09-01T00:00:00Z",
    head_at: str = "2026-09-01T00:00:00Z",
    threads: Sequence[Json] | None = None,
) -> FakeGh:
    answers: dict[str, Json | Callable[[Sequence[str]], Json]] = {
        "repos/o/r/issues/7/reactions?per_page=100": list(reactions or []),
        "repos/o/r/issues/7/comments?per_page=100": list(comments or []),
        "repos/o/r/pulls/7/reviews?per_page=100": list(reviews or []),
        "repos/o/r/pulls/7/comments?per_page=100": list(inline or []),
        "repos/o/r/pulls/7": {"head": {"sha": head}, "mergeable_state": mstate, "created_at": created},
        f"repos/o/r/commits/{head}": {"commit": {"committer": {"date": head_at}}},
        "graphql": {"data": {"repository": {"pullRequest": {"reviewThreads": {
            "totalCount": len(threads or []), "pageInfo": {"hasNextPage": False, "endCursor": "c"},
            "nodes": list(threads or [])}}}}},
    }
    gh = FakeGh(answers)
    for rid in range(1, 1000):
        gh.answers[f"repos/o/r/pulls/7/reviews/{rid}/comments?per_page=100"] = list(review_comments or [])
    return gh


def reaction(content: str, at: str) -> Json:
    return {"user": {"login": BOT}, "content": content, "created_at": at}


def review(
    rid: int, sha: str, at: str, body: str = "findings", st: str = "COMMENTED"
) -> dict[str, Json]:
    return {"id": rid, "user": {"login": BOT}, "state": st, "commit_id": sha,
            "submitted_at": at, "body": body}


def comment(cid: int, at: str, body: str, login: str = BOT) -> dict[str, Json]:
    return {"id": cid, "user": {"login": login}, "created_at": at, "updated_at": at, "body": body}


def run_state(gh: FakeGh, nudge_after: int | None = None) -> state.State:
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        return state.status_state(ctx(gh, nudge_after), "7")


def gated(gh: FakeGh, st: state.State) -> state.State:
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        return state.approval_gate(ctx(gh), "7", st)


# --- jq semantics ---------------------------------------------------------------------------------


class JqSemantics(unittest.TestCase):
    def test_a_stream_parses_as_jq_reads_it(self) -> None:
        self.assertEqual(json_stream('[1] [{"a":"b"}]\n'), [[1], [{"a": "b"}]])
        self.assertEqual(json_stream('["\\ud83d\\ude00"]'), [["\U0001f600"]])
        # A lone high-surrogate escape is jq's parse error, a lone low one its U+FFFD.
        self.assertIsNone(json_stream('[{"b":"\\ud83d"}]'))
        self.assertIsNone(json_stream('[{"\\uD83D":1}]'))
        self.assertIsNone(json_stream('[1] ["x\\ud83d\\u0041"]'))
        self.assertEqual(json_stream('[{"b":"a\\udc80"}]'), [[{"b": "a\ufffd"}]])
        self.assertEqual(json_stream('["\\\\ud83d"]'), [["\\ud83d"]])
        self.assertIsNone(json_stream("[1"))

    def test_order_is_jqs(self) -> None:
        values: list[Json] = [{"a": 1}, [1], "a", 2, True, False, None]
        self.assertEqual(jq.sort_by(values, lambda v: v), [None, False, True, 2, "a", [1], {"a": 1}])
        self.assertNotEqual(jq.cmp(1, True), 0)
        self.assertEqual(jq.cmp(1, 1.0), 0)
        self.assertTrue(jq.gt("1", 5))

    def test_max_by_keeps_the_last_of_equals_and_none_of_nothing(self) -> None:
        items: list[dict[str, Json]] = [{"k": 1, "n": "first"}, {"k": 1, "n": "last"}, {"k": 0, "n": "x"}]
        best = jq.max_by(items, lambda i: i["k"])
        self.assertEqual(best, {"k": 1, "n": "last"})
        nothing: list[Json] = []
        self.assertIsNone(jq.max_by(nothing, lambda i: i))

    def test_indexing_refuses_what_jq_refuses(self) -> None:
        self.assertIsNone(jq.idx(None, "a"))
        with self.assertRaises(jq.JqError):
            jq.idx("s", "a")
        with self.assertRaises(jq.JqError):
            jq.startswith(5, "x")
        with self.assertRaises(jq.JqError):
            jq.test(7, jq.onig("[^[:space:]]"))
        with self.assertRaises(jq.JqError):
            poll.short(7)
        self.assertEqual(poll.short("héllo wörld"), "héllo w")

    def test_fromdateiso8601_is_strptimes(self) -> None:
        self.assertEqual(jq.fromdateiso8601("2026-09-01T00:00:00Z"), 1788220800)
        self.assertEqual(jq.fromdateiso8601("2026-9-1T0:0:0Z"), 1788220800)
        for bad in ("2026-09-01T00:00:00.5Z", "2026-13-01T00:00:00Z", "2026-09-01 00:00:00Z", "x"):
            with self.assertRaises(jq.JqError, msg=bad):
                jq.fromdateiso8601(bad)
        with self.assertRaises(jq.JqError):
            jq.fromdateiso8601(5)

    def test_tab_fields(self) -> None:
        self.assertEqual(tab_fields("a\t\tb\tc d\t", 3), ["a", "b", "c d"])
        self.assertEqual(tab_fields("", 3), ["", "", ""])
        self.assertEqual(tab_fields("a\tb\nc\td", 2), ["a", "b"])

    def test_space_is_unicode_white_space_not_pythons(self) -> None:
        nonspace = jq.onig("[^[:space:]]")
        self.assertTrue(jq.test("\x1c", nonspace))
        self.assertFalse(jq.test("\xa0\u3000\u2028\t", nonspace))


# --- poll -----------------------------------------------------------------------------------------


class PollItems(unittest.TestCase):
    def test_threads_at_one_anchor_fold_with_every_distinct_body(self) -> None:
        a: Json = {"id": 900, "path": "x", "line": 3, "body": "one"}
        b: Json = {"id": 901, "path": "x", "line": 3, "body": "two"}
        c: Json = {"id": 902, "path": "x", "line": 3, "body": "one"}
        d: Json = {"id": 903, "path": "y", "line": 3, "body": "one"}
        folded = poll.fold_inline([a, d, b, c])
        self.assertEqual([poll.thread_list(f) for f in folded], ["900+901+902", "903"])
        self.assertEqual(poll.body_block(folded[0]), "[thread 900]\none\n[thread 901]\ntwo")
        self.assertEqual(poll.dupe_note(folded[0]),
                         " (3 threads at one location, 2 findings as written; one reply answers all)")
        self.assertEqual(poll.dupe_note(folded[1]), "")

    def test_the_anchor_line(self) -> None:
        self.assertEqual(poll.item_line({"line": 5, "start_line": 3}), "3-5")
        self.assertEqual(poll.item_line({"position": 12}), "@12")
        self.assertEqual(poll.item_line({}), "?")
        self.assertEqual(poll.item_side({"side": "LEFT", "start_side": "RIGHT"}),
                         " side=LEFT start_side=RIGHT")
        self.assertEqual(poll.item_was({"line": 7, "original_line": 3}), " was=3")
        self.assertEqual(poll.item_was({"position": 9, "original_position": 5}), " was=@5")
        self.assertEqual(poll.item_was({"position": 5, "original_position": 5}), "")

    def test_short_and_stamps(self) -> None:
        self.assertEqual(poll.short(None), "-")
        self.assertEqual(poll.short(""), "-")
        self.assertEqual(poll.short(HEAD), "aaaaaaa")
        body = "**Reviewed commit:** `ccccccc`\nlater **Reviewed commit:** `ddddddd1`"
        self.assertEqual(poll.item_stamp({"body": body}), "ddddddd")

    def test_the_about_codex_block_folds_only_as_the_body_s_end(self) -> None:
        block = poll.CODEX_ABOUT_OPEN + "\ninterior\n</details>\n  "
        self.assertEqual(poll.fold_codex_about("findings\n" + block),
                         "findings\n" + poll.CODEX_ABOUT_FOLDED)
        self.assertEqual(poll.fold_codex_about("x" + block + "more"), "x" + block + "more")
        self.assertEqual(poll.fold_codex_about(None), "")


class PollRound(unittest.TestCase):
    def run_poll(self, gh: FakeGh, mark: str = "") -> tuple[int, str, str]:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            result = poll.poll(ctx(gh), "7", mark)
        return result.rc, result.text, err.getvalue()

    def test_a_round(self) -> None:
        gh = feeds(
            inline=[{"id": 900, "path": "a.sh", "line": 3, "body": "a finding",
                     "user": {"login": BOT}, "original_commit_id": HEAD}],
            comments=[comment(700, "2026-09-01T00:00:00Z", "summary\n**Reviewed commit:** `aaaaaaa`"),
                      comment(701, "2026-09-01T00:00:00Z", "<!-- codex-pull-request-review-summary -->")],
            reviews=[review(800, HEAD, "2026-09-01T00:00:00Z")],
        )
        rc, out, _ = self.run_poll(gh)
        self.assertEqual(rc, 0)
        self.assertIn(f"--- inline id=900 a.sh:3 commit=aaaaaaa by {BOT}\na finding", out)
        self.assertIn(f"--- summary id=700 commit=aaaaaaa by {BOT}", out)
        self.assertNotIn("id=701", out)
        self.assertIn(f"items: inline:900:aaaaaaa:{BOT}:- summary:700:aaaaaaa:{BOT}:- "
                      f"review:800:aaaaaaa:{BOT}:COMMENTED", out)
        self.assertTrue(out.endswith("watermark: 900,701,800\n"))

    def test_a_shape_the_rendering_cannot_take_fails_after_what_was_printed(self) -> None:
        gh = feeds(
            inline=[{"id": 900, "body": "printed first", "user": {"login": BOT},
                     "original_commit_id": HEAD}],
            reviews=[{**review(800, HEAD, "2026-09-01T00:00:00Z"), "commit_id": 7}],
        )
        rc, out, _ = self.run_poll(gh)
        self.assertEqual(rc, 4)
        self.assertIn("printed first", out)
        self.assertNotIn("watermark:", out)

    def test_the_index_and_watermark_lines_are_what_the_shell_captured(self) -> None:
        # The watermark was `jq -s` without -c, so an array maximum spans lines; each items field
        # was a command substitution, which drops a NUL. Neither shape is GitHub's, but the lines
        # are what watch reads.
        gh = feeds(
            comments=[{**comment(0, "x", "a"), "id": "8\u00000"}, {**comment(0, "x", "b"), "id": [1]}],
        )
        rc, out, _ = self.run_poll(gh)
        self.assertEqual(rc, 0)
        self.assertIn(f"items:  summary:80:-:{BOT}:-", out)
        self.assertIn("--- summary id=8\u00000 ", out)
        self.assertTrue(out.endswith("watermark: 0,[\n  1\n],0\n"), out)

    def test_a_feed_that_did_not_answer_is_exit_3(self) -> None:
        gh = feeds()
        gh.down.add("repos/o/r/issues/7/comments?per_page=100")
        rc, out, err = self.run_poll(gh)
        self.assertEqual((rc, out), (3, ""))
        self.assertIn("feed(s): summary after 1 attempts each", err)


# --- rounds ---------------------------------------------------------------------------------------


class Rounds(unittest.TestCase):
    def count(self, reviews: Sequence[Json], comments: Sequence[Json] | None = None, gap: int = 900,
              icap: int | None = None, rcap: int | None = None) -> str:
        gh = feeds(reviews=reviews, comments=comments)
        got = state.review_rounds(ctx(gh), "7", gap, icap, rcap)
        return f"{got.token()}|{got.detail}"

    def test_bursts_by_head_and_gap(self) -> None:
        r = self.count([
            review(1, "aaaa", "2026-09-01T10:00:00Z"),
            review(2, "aaaa", "2026-09-01T10:00:03Z"),
            review(3, "aaaa", "2026-09-01T10:40:00Z"),
            review(4, "bbbb", "2026-09-01T11:00:00Z", st="CHANGES_REQUESTED"),
            review(5, "cccc", "2026-09-01T12:00:00Z", st="APPROVED"),
        ])
        self.assertEqual(r, f"3|3 round(s) of {REV} findings over 2 head(s)")

    def test_a_comment_quoting_a_truncated_sha_joins_its_burst(self) -> None:
        r = self.count([review(1, "aaaa1111", "2026-09-01T10:00:00Z")],
                       [comment(9, "2026-09-01T10:00:05Z", "**Reviewed commit:** `aaaa111`")])
        self.assertTrue(r.startswith("1|"))

    def test_caps_count_as_of_a_watermark(self) -> None:
        reviews = [review(1, "aaaa", "2026-09-01T10:00:00Z"), review(2, "bbbb", "2026-09-01T11:00:00Z")]
        self.assertTrue(self.count(reviews, rcap=1).startswith("1|"))
        self.assertTrue(self.count(reviews).startswith("2|"))

    def test_a_date_that_does_not_parse_is_unknown(self) -> None:
        self.assertEqual(self.count([review(1, "aaaa", "yesterday")]),
                         "unknown|the reviews feed did not parse")

    def test_an_unreadable_head_tally_is_a_question_mark_not_a_number(self) -> None:
        # The tally reads nothing the count did not read first, so no feed breaks it alone; the
        # shell suite broke the shell's program by name until the shell half was retired.
        reviews = [review(1, "aaaa", "2026-09-01T10:00:00Z"), review(2, "bbbb", "2026-09-01T11:00:00Z")]
        self.assertEqual(self.count(reviews), f"2|2 round(s) of {REV} findings over 2 head(s)")
        with mock.patch.object(state, "unique", side_effect=jq.JqError("broken on purpose")):
            self.assertEqual(self.count(reviews), f"2|2 round(s) of {REV} findings over ? head(s)")

    def test_round_1s_size_is_its_reviews_top_level_inline_comments(self) -> None:
        # ludics-lite#650: two reviews in round 1's burst, one with a thread reply that is no finding;
        # round 2's comments are not read.
        gh = feeds(reviews=[review(1, "aaaa", "2026-09-01T10:00:00Z"), review(2, "aaaa", "2026-09-01T10:00:03Z"),
                            review(3, "bbbb", "2026-09-01T11:00:00Z")])
        finding: Json = {"id": 50, "body": "P2"}
        reply: Json = {"id": 51, "body": "ok", "in_reply_to_id": 50}
        first: list[Json] = [finding, finding, reply]
        second: list[Json] = [finding] * 3
        later: list[Json] = [finding] * 40
        gh.answers["repos/o/r/pulls/7/reviews/1/comments?per_page=100"] = first
        gh.answers["repos/o/r/pulls/7/reviews/2/comments?per_page=100"] = second
        gh.answers["repos/o/r/pulls/7/reviews/3/comments?per_page=100"] = later
        got = state.review_rounds(ctx(gh), "7", 900, first=True)
        self.assertEqual((got.token(), got.first_token()), ("2", "5"))
        self.assertNotIn("repos/o/r/pulls/7/reviews/3/comments?per_page=100", gh.calls)
        self.assertIsNone(state.review_rounds(ctx(gh), "7", 900).first, "not read unless asked")

    def test_round_1s_size_is_unknown_when_unread_and_zero_with_no_rounds(self) -> None:
        gh = feeds(reviews=[review(1, "aaaa", "2026-09-01T10:00:00Z")])
        gh.down.add("repos/o/r/pulls/7/reviews/1/comments?per_page=100")
        got = state.review_rounds(ctx(gh), "7", 900, first=True)
        self.assertEqual((got.token(), got.first_token()), ("1", "unknown"))
        idless = {k: v for k, v in review(1, "aaaa", "2026-09-01T10:00:00Z").items() if k != "id"}
        got = state.review_rounds(ctx(feeds(reviews=[idless])), "7", 900, first=True)
        self.assertEqual(got.first_token(), "unknown", "a review with no numeric id is not counted as empty")
        self.assertEqual(state.review_rounds(ctx(feeds()), "7", 900, first=True).first_token(), "0")
        # A comment-only round 1 counts no inline findings: the size is a lower bound.
        only = feeds(comments=[comment(9, "2026-09-01T10:00:00Z", "**Reviewed commit:** `aaaa111`")])
        self.assertEqual(state.review_rounds(ctx(only), "7", 900, first=True).first_token(), "0")

    def test_rounds_line(self) -> None:
        self.assertEqual(rounds.rounds_line("2|d", 12), ("review rounds with findings: 2 of 12 (d)", 0))
        self.assertEqual(rounds.rounds_line("2|d", None)[1], 0)
        self.assertEqual(rounds.rounds_line("13|d", 12)[1], 1)
        self.assertEqual(rounds.rounds_line("unknown|why", 12)[1], 3)
        self.assertEqual(rounds.count_token("unknown|why"), "unknown")
        self.assertEqual(rounds.count_token("4|x"), "4")


# --- status ---------------------------------------------------------------------------------------


class StatusState(unittest.TestCase):
    def test_idle_on_a_review_of_the_head(self) -> None:
        st = run_state(feeds(reviews=[review(5, HEAD, "2026-09-01T00:00:00Z")]))
        self.assertEqual(st.tok, "idle", st.line())
        self.assertEqual(st.merge, "clean")

    def test_a_thumbs_up_is_an_approval_and_the_gate_reads_the_threads(self) -> None:
        gh = feeds(reactions=[reaction("+1", iso(30))], head_at=iso(3600),
                   threads=[{"isResolved": False, "path": "a b.sh",
                             "comments": {"nodes": [{"fullDatabaseId": "4095735704",
                                                     "author": {"login": "codex"}}]}}])
        st = run_state(gh)
        self.assertEqual(st.line(), f"approved|-|clean|👍 from {REV}")
        self.assertEqual(gated(gh, st).line(),
                         f"unresolved|-|clean|1|👍 from {REV}|4095735704 by codex on a\\ b.sh")

    def test_a_live_eyes_is_reviewing_and_an_old_one_stalled(self) -> None:
        self.assertEqual(run_state(feeds(reactions=[reaction("eyes", iso(60))])).tok, "reviewing")
        self.assertEqual(run_state(feeds(reactions=[reaction("eyes", iso(9999))])).tok, "stalled")

    def test_a_feed_that_did_not_answer_is_unknown(self) -> None:
        gh = feeds()
        gh.down.add("repos/o/r/issues/7/reactions?per_page=100")
        self.assertTrue(run_state(gh).line().startswith("unknown|-|-|the reactions API did not answer (gh: HTTP 503"))

    def test_a_shape_a_read_cannot_take_is_unknown(self) -> None:
        st = run_state(feeds(comments=[{**comment(1, "2026-09-01T00:00:00Z", "x"), "body": 7}]))
        # The head is read after the feeds, so no mergeability rides on this line yet.
        self.assertEqual(st.line(), "unknown|-|-|the comments feed did not parse")

    def test_a_pending_request_is_nudged(self) -> None:
        st = run_state(feeds(comments=[comment(9, iso(30), "@codex review", login="me")]), 1)
        self.assertEqual(st.tok, "nudged", st.line())
        self.assertEqual(state.status_line(st, "o/r", "7").split(" — ")[0], "review EXPECTED but not started")

    def test_the_initialization_failure_names_its_head(self) -> None:
        body = ("Codex Review: Something went wrong. Try again later by commenting “@codex review”.\n\n"
                f"```\nProvided git ref {HEAD} does not exist\n```")
        st = run_state(feeds(comments=[comment(1, "2026-09-01T01:00:00Z", body)]))
        self.assertEqual(st.tok, "failed", st.line())
        self.assertEqual(st.detail.split("|")[:2], ["aaaaaaa", "git"])


def run_nudge(gh: FakeGh) -> state.NudgeRead:
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        return state.nudge_read(ctx(gh), "7")


class NudgeRead(unittest.TestCase):
    """``nudge_read``: what bars the watch's automatic request on the head (ludics-lite#570)."""

    def test_nothing_standing_is_clear(self) -> None:
        self.assertEqual(run_nudge(feeds(reviews=[review(5, "b" * 40, iso(600))])), state.NudgeClear(HEAD),
                         "a review of another head stands for nothing here")

    def test_a_request_since_the_head_arrived_is_the_record(self) -> None:
        asked = comment(9, iso(30), "@codex review", login="me")
        read = run_nudge(feeds(comments=[asked], head_at=iso(600), created=iso(9000)))
        self.assertIsInstance(read, state.NudgeBarred)
        assert isinstance(read, state.NudgeBarred)
        self.assertTrue(read.asked, read.why)
        self.assertIn("already stands on head aaaaaaa", read.why)
        self.assertEqual(run_nudge(feeds(comments=[asked], head_at=iso(10), created=iso(9000))),
                         state.NudgeClear(HEAD), "a request older than the head's commit was an earlier head's")
        self.assertEqual(run_nudge(feeds(comments=[asked], head_at=iso(600), created=iso(10))),
                         state.NudgeClear(HEAD), "and so is one older than the PR")
        unread = run_nudge(feeds(comments=[asked], head_at="", created=""))
        self.assertIsInstance(unread, state.NudgeBarred, "with no readable arrival every request counts")
        quoted = comment(9, iso(30), "Thanks; @codex review was asked for earlier", login="me")
        self.assertIsInstance(run_nudge(feeds(comments=[quoted], head_at=iso(600))), state.NudgeBarred,
                              "a quoted summon is a summon to the connector")
        for at in (None, 7, "", "0broken", "2026-10-12 16:00:00"):
            undated = {**comment(9, iso(30), "@codex review", login="me"), "created_at": at}
            self.assertIsInstance(run_nudge(feeds(comments=[undated], head_at=iso(600))), state.NudgeBarred,
                                  f"a request with no readable time ({at!r}) is still a request")
        mine = comment(9, iso(30), "@codex review")
        self.assertEqual(run_nudge(feeds(comments=[mine], head_at=iso(600))), state.NudgeClear(HEAD),
                         "the reviewer's own words are not a request")

    def test_the_reviewers_word_on_the_head_bars_it(self) -> None:
        for name, gh in (
            ("review", feeds(reviews=[review(5, HEAD, iso(60))])),
            ("verdict", feeds(comments=[comment(5, iso(60), f"Didn't find any major issues.\n\n**Reviewed commit:** `{HEAD[:7]}`")])),
            ("unread row", feeds(comments=[comment(5, iso(60), (
                "<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Trigger |\n"
                "| 📝 **Code Review** | ✅ **Completed** at some point | aaaaaaa | New commits |"))])),
            ("row in another shape", feeds(comments=[comment(5, iso(60), (
                "<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Trigger |\n"
                f"| 📝 **Code Review** | ⏭️ **Skipped** <relative-time datetime=\"{iso(60)}\">x</relative-time> | `{HEAD[:7]}` | New commits |"))])),
            ("completed row", feeds(comments=[comment(5, iso(60), (
                "<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Trigger |\n"
                f"| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"{iso(60)}\">x</relative-time> | `{HEAD[:7]}` | New commits |"))])),
        ):
            with self.subTest(name):
                read = run_nudge(gh)
                self.assertIsInstance(read, state.NudgeBarred)
                assert isinstance(read, state.NudgeBarred)
                self.assertFalse(read.asked, read.why)
                if name != "unread row":
                    self.assertIn("aaaaaaa", read.why)

    def test_a_read_that_did_not_answer_bars_it(self) -> None:
        for endpoint in ("repos/o/r/issues/7/comments?per_page=100", "repos/o/r/pulls/7/reviews?per_page=100",
                         "repos/o/r/pulls/7"):
            with self.subTest(endpoint):
                gh = feeds()
                gh.down.add(endpoint)
                read = run_nudge(gh)
                self.assertIsInstance(read, state.NudgeBarred)
                assert isinstance(read, state.NudgeBarred)
                self.assertIn("did not answer", read.why)


def state_summary(cid: int, at: str, record: str, row_sha: str = HEAD[:7], edited: str = "") -> dict[str, Json]:
    """The reviewer's summary comment as the app writes it (lukstafi/ludics-lite#690's, 2026-10-18):
    the tag, the hidden state record, and the table with its Code Review row, Completed at ``at``.
    ``edited``: the comment's ``updated_at`` when an edit since (a security-review row) moved it."""
    c = comment(cid, at, (
        "<!-- codex-pull-request-review-summary -->\n"
        f"<!-- codex-review-state:v1 {record} -->\n\n## Codex Review Summary\n\n"
        "This comment shows the latest Codex review activity on this pull request.\n\n"
        "| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n"
        f"| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"{at[:-1]}.001490Z\">{at}</relative-time>"
        f" | `{row_sha}` | New commits |\n\n\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n</details>"))
    if edited:
        c["updated_at"] = edited
    return c


def state_record(sha: Json = HEAD, status: Json = "completed", unresolved: Json = False,
                 any_findings: Json = True) -> str:
    return json.dumps({
        "code_review": {"commit_sha": sha, "has_any_findings": any_findings,
                        "has_unresolved_findings": unresolved, "status": status},
        "security_review": {"commit_sha": None, "has_any_findings": None,
                            "has_unresolved_findings": None, "status": None}},
        separators=(",", ":"))


class SummaryStateRecord(unittest.TestCase):
    """The hidden ``codex-review-state:v1`` record as a clean round's verdict when the app put up no
    👍 and left no 👀 (ludics-lite#702: PRs #677 and #690 read EXPECTED and drew nudge advice)."""

    def test_the_record_is_read_whole(self) -> None:
        at = "2026-10-18T16:27:30Z"
        got = state.summary_state([state_summary(1, at, state_record())], REV)
        self.assertEqual(got, state.SummaryState(HEAD, "completed", False, at))
        running = state.summary_state([state_summary(1, at, state_record(status="running", unresolved=None))], REV)
        self.assertEqual(running, state.SummaryState(HEAD, "running", None, at), "a running record reads too (#586)")
        self.assertIsNone(state.head_summary_state([state_summary(1, at, state_record())], REV, "b" * 40))
        self.assertIsNone(state.head_summary_state([state_summary(1, at, state_record(sha=HEAD[:7]))], REV, HEAD))

    def test_any_other_shape_is_no_reading(self) -> None:
        at = "2026-10-18T16:27:30Z"
        good = state_record()
        for name, body_record in (
            ("not JSON", "{code_review: completed}"),
            ("truncated", good[:-1]),
            ("an array", "[" + good + "]"),
            # Last-wins would read the second, clean, half: a duplicate is no reading at all.
            ("a duplicate key", state_record(unresolved=True)[:-1] + ',"code_review":'
             + json.dumps(json.loads(good)["code_review"], separators=(",", ":")) + "}"),
            ("code_review not an object", '{"code_review":"completed"}'),
            ("no has_unresolved_findings", '{"code_review":{"commit_sha":"' + HEAD + '","status":"completed"}}'),
            ("a string flag", state_record(unresolved="false")),
            ("a number flag", state_record(unresolved=0)),
            ("a short sha", state_record(sha=HEAD[:7])),
            ("an upper-case sha", state_record(sha=HEAD.upper())),
            ("a null sha", state_record(sha=None)),
            ("an empty status", state_record(status="")),
            ("a null status", state_record(status=None)),
        ):
            with self.subTest(name):
                self.assertIsNone(state.summary_state([state_summary(1, at, body_record)], REV))
        twice = state_summary(1, at, good)
        twice["body"] = str(twice["body"]) + "\n<!-- codex-review-state:v1 " + good + " -->"
        self.assertIsNone(state.summary_state([twice], REV), "a second record is no reading")
        split = state_summary(1, at, good.replace(",", ",\n", 1))
        self.assertIsNone(state.summary_state([split], REV), "a record across lines is no reading")
        self.assertIsNone(state.summary_state([state_summary(1, at, good, row_sha="bbbbbbb")], REV),
                          "a row naming another commit disagrees with the record")
        undated = state_summary(1, at, good)
        undated["body"] = str(undated["body"]).replace('datetime="2026-10-18T16:27:30.001490Z"', "")
        self.assertIsNone(state.summary_state([undated], REV), "nor a record whose row does not date it")
        edited = state.summary_state([state_summary(1, at, good, edited="2026-10-18T16:31:00Z")], REV)
        self.assertEqual(edited, state.SummaryState(HEAD, "completed", False, at),
                         "the row dates the record, never the comment's edit time")
        stranger = state_summary(1, at, good)
        stranger["user"] = {"login": "me"}
        self.assertIsNone(state.summary_state([stranger], REV), "only the reviewer's summary is read")
        older = state_summary(1, "2026-10-18T16:00:00Z", good)
        newest = comment(2, at, "<!-- codex-pull-request-review-summary -->\n| Review | Status |")
        self.assertIsNone(state.summary_state([older, newest], REV), "only the NEWEST summary is read")

    def test_a_clean_record_for_the_head_is_an_approval(self) -> None:
        at = "2026-10-18T16:27:30Z"
        earlier = review(5, "b" * 40, "2026-10-18T16:17:01Z")
        st = run_state(feeds(comments=[state_summary(1, at, state_record())], reviews=[earlier]))
        self.assertEqual(st.tok, "approved", st.line())
        self.assertIn("completed with no unresolved findings, Completed at 2026-10-18T16:27:30Z", st.detail)
        self.assertEqual(run_state(feeds(reviews=[earlier])).tok, "expected", "control: no record, as before")

    def test_a_record_that_is_not_a_clean_verdict_for_the_head_stays_expected(self) -> None:
        at = "2026-10-18T16:27:30Z"
        earlier = review(5, "b" * 40, "2026-10-18T16:17:01Z")
        for name, record in (
            ("another head", state_record(sha="b" * 40)),
            ("unresolved findings", state_record(unresolved=True)),
            ("still running", state_record(status="running", unresolved=None)),
            ("failed", state_record(status="failed")),
        ):
            with self.subTest(name):
                st = run_state(feeds(comments=[state_summary(1, at, record)], reviews=[earlier]))
                self.assertEqual(st.tok, "expected", st.line())

    def test_anything_posted_since_or_about_the_head_outranks_the_record(self) -> None:
        at = "2026-10-18T16:27:30Z"
        rec = state_summary(1, at, state_record())
        # #683's order: the findings review three seconds before the record is written.
        st = run_state(feeds(comments=[rec], reviews=[review(5, HEAD, "2026-10-18T16:27:27Z")]))
        self.assertEqual(st.tok, "idle", st.line())
        later = review(5, "b" * 40, "2026-10-18T16:28:00Z")
        self.assertEqual(run_state(feeds(comments=[rec], reviews=[later])).tok, "expected",
                         "a review posted after the record, whatever its head")
        stamped = comment(2, "2026-10-18T16:20:00Z", f"A finding.\n\n**Reviewed commit:** `{HEAD[:10]}`")
        self.assertEqual(run_state(feeds(comments=[stamped, rec])).tok, "expected",
                         "a findings comment stamped with the head")
        eyes = reaction("eyes", "2026-10-18T16:30:00Z")
        self.assertEqual(run_state(feeds(comments=[rec], reactions=[eyes])).tok, "stalled",
                         "a 👀 newer than the record is a new round")
        # The local review of #702: an edit of the summary after a newer 👀 moves updated_at, not
        # the round's completion, so the old record still does not answer the 👀.
        edited = state_summary(1, at, state_record(), edited="2026-10-18T16:31:00Z")
        self.assertEqual(run_state(feeds(comments=[edited], reactions=[eyes])).tok, "stalled",
                         "a summary edited after a newer 👀 is not a newer verdict")
        unclean_row = state_summary(1, at, state_record())
        unclean_row["body"] = str(unclean_row["body"]).replace("✅ **Completed**", "⚠️ **Failed**")
        self.assertNotEqual(run_state(feeds(comments=[unclean_row])).tok, "approved",
                            "a record whose row is not the Completed shape is not a verdict")
        old_eyes = reaction("eyes", "2026-10-18T16:20:00Z")
        self.assertEqual(run_state(feeds(comments=[rec], reactions=[old_eyes])).tok, "approved",
                         "a 👀 older than the record is the round it records")
        nudge = comment(3, "2026-10-18T16:40:00Z", "@codex review", login="me")
        self.assertEqual(run_state(feeds(comments=[rec, nudge]), nudge_after=2).tok, "nudged",
                         "a record older than a pending request does not answer it")

    def test_the_approval_passes_the_thread_gate(self) -> None:
        rec = state_summary(1, "2026-10-18T16:27:30Z", state_record())
        thread: Json = {"isResolved": False, "path": "a.py",
                  "comments": {"nodes": [{"fullDatabaseId": "9", "author": {"login": "codex"}}]}}
        gh = feeds(comments=[rec], threads=[thread])
        st = run_state(gh)
        self.assertEqual(st.tok, "approved", st.line())
        self.assertEqual(gated(gh, st).tok, "unresolved", "an open thread under it is not a clean approval")


def running_summary(cid: int, at: str, row_sha: str = HEAD[:7], stamp: str = "") -> dict[str, Json]:
    """The reviewer's summary comment while a round runs: its Code Review row Running since ``at``
    on ``row_sha`` (lukstafi/ludics-lite#581's, 2026-10-12). ``stamp``: the row's datetime cell
    when it is not ``at``'s."""
    cell = stamp if stamp else f'<relative-time datetime="{at[:-1]}.484070Z">{at}</relative-time>'
    return comment(cid, at, (
        "<!-- codex-pull-request-review-summary -->\n"
        "| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n"
        f"| 📝 **Code Review** | 🔄 **Running** {cell} | `{row_sha}` | New commits |"))


class StaleEyesUnderARunningRow(unittest.TestCase):
    """ludics-lite#586: a 👀 left up by an older head's stuck round, past STALL with nothing said
    since, read the CURRENT head as stalled while the summary's newest Code Review row said that
    head's round was Running (#581: head fb80745, reviewed three minutes later)."""

    old_eyes = reaction("eyes", iso(9999))

    def test_a_running_row_for_the_head_after_the_eyes_is_reviewing(self) -> None:
        st = run_state(feeds(reactions=[self.old_eyes], comments=[running_summary(1, iso(60))]))
        self.assertEqual(st.tok, "reviewing", st.line())
        self.assertIsNotNone(st.age)
        self.assertLess(st.age or 0, 2400, "aged from the row, not from the 👀")
        self.assertIn("Code Review Running for head aaaaaaa since", st.detail)
        self.assertEqual(run_state(feeds(reactions=[self.old_eyes])).tok, "stalled", "control: no row, as before")

    def test_the_row_ages_into_a_stall_of_its_own(self) -> None:
        st = run_state(feeds(reactions=[self.old_eyes], comments=[running_summary(1, iso(5000))]))
        self.assertEqual(st.tok, "stalled", st.line())
        self.assertIn("Code Review Running for head aaaaaaa since", st.detail, "the row's stall, not the 👀's")

    def test_a_row_for_another_head_or_older_than_the_eyes_leaves_the_reactions_to_decide(self) -> None:
        older_head = running_summary(1, iso(60), row_sha="bbbbbbb")
        st = run_state(feeds(reactions=[self.old_eyes], comments=[older_head]))
        self.assertEqual((st.tok, st.detail.startswith("👀 from")), ("stalled", True), st.line())
        older_row = running_summary(1, iso(5000))
        st = run_state(feeds(reactions=[reaction("eyes", iso(3000))], comments=[older_row]))
        self.assertEqual((st.tok, st.detail.startswith("👀 from")), ("stalled", True), st.line())
        st = run_state(feeds(reactions=[reaction("eyes", iso(60))], comments=[older_row]))
        self.assertEqual((st.tok, st.detail.startswith("👀 from")), ("reviewing", True), st.line())
        completed = running_summary(1, iso(60))
        completed["body"] = str(completed["body"]).replace("🔄 **Running**", "✅ **Completed**")
        st = run_state(feeds(reactions=[self.old_eyes], comments=[completed, review(5, "b" * 40, iso(9000))]))
        self.assertNotEqual(st.tok, "reviewing", "only a Running row is a round in flight")
        older = running_summary(1, iso(120))
        newest = comment(2, iso(30), "<!-- codex-pull-request-review-summary -->\n| Review | Status |")
        st = run_state(feeds(reactions=[self.old_eyes], comments=[older, newest]))
        self.assertEqual(st.tok, "stalled", "only the NEWEST summary is read")

    def test_a_same_head_rerun_after_findings_is_reviewing(self) -> None:
        # Review of #747, round 1: findings on the head spend the old 👀, then a rerun on the same
        # head puts the row back to Running -- the round in flight, not `idle` on the old findings.
        findings = review(5, HEAD, iso(600))
        st = run_state(feeds(reactions=[self.old_eyes], reviews=[findings],
                             comments=[running_summary(1, iso(60))]))
        self.assertEqual(st.tok, "reviewing", st.line())
        st = run_state(feeds(reviews=[findings], comments=[running_summary(1, iso(60))]))
        self.assertEqual(st.tok, "reviewing", "with no 👀 at all, too")
        st = run_state(feeds(reactions=[self.old_eyes], reviews=[findings],
                             comments=[running_summary(1, iso(900))]))
        self.assertEqual(st.tok, "idle", "a row older than the reviewer's last word is that round's")
        st = run_state(feeds(reviews=[findings], comments=[running_summary(1, iso(60), row_sha="bbbbbbb")]))
        self.assertEqual(st.tok, "idle", "a row for another head is not this head's round")
        nudge = comment(9, iso(30), "@codex review", login="me")
        st = run_state(feeds(reviews=[findings], comments=[running_summary(1, iso(60)), nudge]), 2)
        self.assertEqual(st.tok, "nudged", "a row older than a pending request does not answer it")

    def test_a_same_head_rerun_after_a_clean_verdict_is_reviewing(self) -> None:
        # Review of #747, round 2: a verdict on the head approves it until a newer Running row says
        # a rerun of that head is under way, as a newer Running row outranks a 👍.
        verdict = comment(5, iso(600), f"Didn't find any major issues.\n\n**Reviewed commit:** `{HEAD[:7]}`")
        st = run_state(feeds(comments=[verdict, running_summary(1, iso(60))]))
        self.assertEqual(st.tok, "reviewing", st.line())
        st = run_state(feeds(comments=[verdict, running_summary(1, iso(900))]))
        self.assertEqual(st.tok, "approved", "a row older than the verdict is the round that gave it")

    def test_an_unreadable_running_row_is_unknown(self) -> None:
        for name, stamp in (("no datetime", "just now"),
                            ("not a timestamp", '<relative-time datetime="yesterday">x</relative-time>')):
            with self.subTest(name):
                st = run_state(feeds(reactions=[self.old_eyes], comments=[running_summary(1, iso(60), stamp=stamp)]))
                self.assertEqual(st.tok, "unknown", st.line())
                self.assertIn("matched the Running test", st.detail)
        unread = running_summary(1, iso(60), stamp="just now")
        self.assertEqual(run_state(feeds(comments=[unread])).tok, "unknown",
                         "nor with no 👀 at all: a readable one would decide there too")

    def test_the_read_refuses_when_it_fails(self) -> None:
        gh = feeds(reactions=[self.old_eyes], comments=[running_summary(1, iso(60))])
        def broken(*_a: Any) -> tuple[bool, str]:
            raise jq.JqError("broken on purpose")

        with mock.patch.object(state, "_head_running_row", broken):
            st = run_state(gh)
        self.assertEqual((st.tok, st.detail), ("unknown", "the summary's Code Review rows did not parse"))


def run_stall_nudge(gh: FakeGh) -> state.NudgeRead:
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        return state.stall_nudge_read(ctx(gh), "7")


class StallNudgeRead(unittest.TestCase):
    """``stall_nudge_read``: what bars the watch's one request over a STALLED round
    (ludics-lite#760). The stalled round's own Running row and 👀 bar nothing here, where
    ``nudge_read`` would read the row as the reviewer's evidence for the head."""

    hung = running_summary(1, iso(5000))

    def barred(self, gh: FakeGh) -> state.NudgeBarred:
        read = run_stall_nudge(gh)
        self.assertIsInstance(read, state.NudgeBarred)
        assert isinstance(read, state.NudgeBarred)
        return read

    def test_a_hung_round_with_nothing_standing_is_clear(self) -> None:
        gh = feeds(reactions=[reaction("eyes", iso(9999))], comments=[self.hung],
                   reviews=[review(5, HEAD, iso(9000))], head_at=iso(9500), created=iso(9500))
        self.assertEqual(run_state(gh).tok, "stalled", "control: the state is the stall")
        self.assertEqual(run_stall_nudge(gh), state.NudgeClear(HEAD),
                         "a findings review of the head is no approval for a request to clear")
        self.assertIsInstance(run_nudge(gh), state.NudgeBarred,
                              "where the expected nudge's read takes the Running row as evidence")

    def test_an_approval_that_may_stand_bars_it(self) -> None:
        stamped = f"Didn't find any major issues.\n\n**Reviewed commit:** `{HEAD[:7]}`"
        completed = running_summary(1, iso(6000))
        completed["body"] = str(completed["body"]).replace("🔄 **Running**", "✅ **Completed**")
        for name, gh, why in (
            ("thumb", feeds(reactions=[reaction("+1", iso(9000)), reaction("eyes", iso(9999))],
                            comments=[self.hung]), "a 👍 from"),
            ("verdict", feeds(comments=[comment(5, iso(6000), stamped), self.hung]), "no-findings verdict"),
            ("unstamped verdict", feeds(comments=[comment(5, iso(6000), "Didn't find any major issues."),
                                                 self.hung]), "no-findings verdict"),
            ("completed row", feeds(reactions=[reaction("eyes", iso(5000))], comments=[completed]),
             "Code Review Completed"),
        ):
            with self.subTest(name):
                read = self.barred(gh)
                self.assertIn(why, read.why)
                self.assertFalse(read.asked, "an approval is not a request")
        other = "Didn't find any major issues.\n\n**Reviewed commit:** `bbbbbbb`"
        self.assertEqual(run_stall_nudge(feeds(comments=[comment(5, iso(6000), other), self.hung])),
                         state.NudgeClear(HEAD), "a verdict for another head stands for nothing here")

    def test_a_request_since_the_head_arrived_is_the_once_per_head_record(self) -> None:
        asked = comment(9, iso(4000), "@codex review", login="me")
        read = self.barred(feeds(comments=[self.hung, asked], head_at=iso(6000), created=iso(9000)))
        self.assertTrue(read.asked, read.why)
        self.assertIn("already stands on head aaaaaaa", read.why)
        self.assertEqual(run_stall_nudge(feeds(comments=[self.hung, asked], head_at=iso(3000), created=iso(9000))),
                         state.NudgeClear(HEAD), "a request older than the head's commit was an earlier head's")

    def test_a_read_that_did_not_answer_or_a_row_that_does_not_read_bars_it(self) -> None:
        for endpoint in ("repos/o/r/issues/7/reactions?per_page=100", "repos/o/r/issues/7/comments?per_page=100",
                         "repos/o/r/pulls/7"):
            with self.subTest(endpoint):
                gh = feeds(comments=[self.hung])
                gh.down.add(endpoint)
                self.assertIn("did not answer", self.barred(gh).why)
        unread = running_summary(1, iso(5000), stamp="just now")
        self.assertIn("could not be read", self.barred(feeds(comments=[unread])).why)


class BrokenReads(unittest.TestCase):
    """A read of status_state that no feed can break on its own -- an earlier read of the same feed
    takes every shape it would -- still refuses rather than answers when it fails (ludics-lite#89):
    each is broken here, one at a time, beside a control run of the same fixture. The shell suite
    broke the shell's jq programs for these by name (test-pr-review-status.sh's with_broken_jq
    cases) until the shell half of pr-review.sh was retired; these are the sites that serve now."""

    def broken(self, gh: FakeGh, target: str, nth: int = 1) -> state.State:
        """status_state with ``state.<target>`` raising JqError on its nth call."""
        real = getattr(state, target)
        calls = 0

        def fail_once(*args: Any, **kwargs: Any) -> Any:
            nonlocal calls
            calls += 1
            if calls == nth:
                raise jq.JqError("broken on purpose")
            return real(*args, **kwargs)

        with mock.patch.object(state, target, fail_once):
            return run_state(gh)

    def assert_unknown(self, st: state.State, detail: str) -> None:
        self.assertEqual((st.tok, st.detail), ("unknown", detail), st.line())

    def test_the_reviews_the_verdicts_and_the_summary_rows_refuse(self) -> None:
        idle = feeds(reviews=[review(5, HEAD, "2026-09-01T00:00:00Z")])
        self.assertEqual(run_state(idle).tok, "idle", "control: the fixture reads idle")
        # sort_by's first call in status_state is the reviews read, its second the verdict scan.
        self.assert_unknown(self.broken(idle, "sort_by", 1), "the reviews feed did not parse")
        self.assert_unknown(self.broken(idle, "sort_by", 2), "the verdict comments feed did not parse")
        self.assert_unknown(self.broken(idle, "_init_failure"),
                            "the initialization-failure comments feed did not parse")
        self.assert_unknown(self.broken(idle, "_done_row"), "the summary comments feed did not parse")

    def test_the_failed_head_read_refuses(self) -> None:
        body = ("Codex Review: Something went wrong. Try again later by commenting “@codex review”.\n\n"
                f"```\nProvided git ref {HEAD} does not exist\n```")
        failed = feeds(comments=[comment(1, "2026-09-01T01:00:00Z", body)])
        self.assertEqual(run_state(failed).tok, "failed", "control: the fixture reaches the failed-head read")
        self.assert_unknown(self.broken(failed, "_review_of_head_at"),
                            "the reviews feed did not parse for the failed head")

    def test_the_completed_row_read_refuses(self) -> None:
        head = "fc6ff6a" + "0" * 33
        row = ("<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Review trigger |\n"
               "| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time"
               ' datetime="2026-09-27T01:10:51.510504Z">2026-09-27T01:10:51Z</relative-time> | `fc6ff6a` |'
               " New commits |")
        completed = feeds(head=head, head_at="2026-09-27T01:06:05Z",
                          reviews=[review(5, "b67e463" + "0" * 33, "2026-09-27T01:03:11Z")],
                          reactions=[reaction("eyes", "2026-09-27T01:06:53Z")],
                          comments=[comment(1, "2026-09-27T01:10:51Z", row)])
        self.assertEqual(run_state(completed).tok, "approved", "control: the fixture reaches the Completed row")
        self.assert_unknown(self.broken(completed, "_done_row"), "the summary comments feed did not parse")


class StatusLine(unittest.TestCase):
    def test_tokens(self) -> None:
        def line(tok: state.Token, age: int | None, merge: str, detail: str, pr: str = "7") -> str:
            return state.status_line(state.State(tok, age, merge, detail), "o/r", pr)

        self.assertEqual(line("approved", None, "dirty", "x"),
                         "approved (x); " + state.conflict_note("dirty", "o/r", "7"))
        self.assertIn("the next move is yours", line("idle", 5, "clean", "d"))
        self.assertNotIn("the next move is yours", line("idle", 5, "draft", "d"))
        self.assertIn("gh pr ready <pr> --repo o/r", line("idle", 5, "draft", "d", ""))
        self.assertIn("running 2m", line("reviewing", 125, "clean", "d"))

    def test_the_status_line_entry_keeps_pipes_in_the_detail_and_names_a_stranger(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status.run_line(session(feeds()), ["unknown|-|-|gh: 502 | Bad Gateway", "7"])
            status.run_line(session(feeds()), ["weird|-|-|", "7"])
        first, second = out.getvalue().splitlines()
        self.assertEqual(first, state.status_line(state.State("unknown", None, "-", "gh: 502 | Bad Gateway"), "o/r", "7"))
        self.assertEqual(second, "unrecognised state 'weird' — treat as unknown and retry")

    def test_threads_named_names_ten(self) -> None:
        rows = [tsv([str(i), "u", "p"]) for i in range(12)]
        n, shown = threads.threads_named(rows)
        self.assertEqual(n, 12)
        self.assertTrue(shown.endswith("9 by u on p, and 2 more"))


if __name__ == "__main__":
    unittest.main()
