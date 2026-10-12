"""``pr-review.sh watch`` and ``retry run watch``: the pieces whose answers are jq's or bash's, and the
production path end to end (``scripts/py -m ludics.prreview`` and pr-review.sh's ``main``, which
execs it) with a fake gh BINARY that answers by endpoint.

The fixture suites (ship-pr/scripts/test-pr-review-watch.sh and the watch cases of
test-pr-review-status.sh) pin the command's behaviour through the shell bridge; these pin the
rules a port gets wrong silently -- jq's ordering and ``max_by`` ties, the regex dialect, the
fold of duplicated threads -- and the binary path, where no shell function exists.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from collections.abc import Sequence

from ludics import proc
from ludics.prreview.core import GhSession, Json, load_config
from ludics.prreview.watch import _cut_f12, item_about_head, tmp_sweep_stale  # pyright: ignore[reportPrivateUsage]
from ludics.prreview.clock import FileClock, age_of, fmt_age, freshest_age
from ludics.prreview.jqsem import (
    JqError,
    cmp,
    fromdateiso8601,
    jmax,
    jstr,
    max_by,
    onig,
    sort_by,
)
from ludics.prreview.feeds import Ctx
from ludics.prreview.poll import (
    fold_codex_about,
    fold_inline,
    item_line,
    item_side,
    item_was,
    poll,
    short,
)
from ludics.prreview.checkruns import conclusion_class

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PY = os.path.join(ROOT, "scripts", "py")
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")


class JqSemantics(unittest.TestCase):
    def test_the_order_is_jqs_across_types(self) -> None:
        values: list[Json] = [{"a": 1}, [1], "a", 2, True, False, None]
        self.assertEqual(sort_by(values, lambda v: v), [None, False, True, 2, "a", [1], {"a": 1}])
        self.assertGreater(cmp("2", 10), 0, "a string sorts above any number")

    def test_max_by_keeps_the_last_of_equal_maxima(self) -> None:
        rows: list[Json] = [{"a": 1, "i": 1}, {"a": 1, "i": 2}, {"a": 0, "i": 3}]
        self.assertEqual(max_by(rows, lambda r: r["a"] if isinstance(r, dict) else None), {"a": 1, "i": 2})
        self.assertIsNone(jmax([]))

    def test_interpolation_prints_like_jq(self) -> None:
        values: list[Json] = [None, True, 7, 1.5, "x", [1, "a"]]
        self.assertEqual([jstr(v) for v in values],
                         ["null", "true", "7", "1.5", "x", '[1,"a"]'])

    def test_the_regex_dialect(self) -> None:
        self.assertIsNotNone(onig("x\\z").search("ax"))
        self.assertIsNone(onig("x\\z").search("x\n"), "\\z is the very end")
        self.assertIsNotNone(onig("x$").search("x\n"), "$ is the end or before a final newline")
        self.assertIsNotNone(onig("[[:space:]]").search(" "), "White_Space includes NBSP")
        self.assertIsNone(onig("[[:space:]]").search("\x1c"), "but not the information separators")
        m = onig("ref (?<s>[0-9a-f]+)").search("ref 1e14b13")
        self.assertEqual(m.group("s") if m else None, "1e14b13")

    def test_fromdateiso8601_is_strptime_and_timegm(self) -> None:
        self.assertEqual(fromdateiso8601("2026-09-04T22:47:25Z"), 1788562045)
        with self.assertRaises(JqError):
            fromdateiso8601("2026-09-04T22:47:25.387018Z")
        self.assertEqual(fromdateiso8601("2026-02-30T22:47:25Z"), 1772491645, "Feb 30 is Mar 2")


class Clock(unittest.TestCase):
    def setUp(self) -> None:
        fd, self.path = tempfile.mkstemp(prefix="ludics-clock.")
        os.close(fd)
        with open(self.path, "w") as f:
            f.write("1788562045\n")
        self.clock = FileClock(self.path)

    def tearDown(self) -> None:
        os.remove(self.path)

    def test_a_sleep_advances_the_file_instead_of_waiting(self) -> None:
        self.clock.sleep(1200)
        self.assertEqual(self.clock.now(), 1788562045 + 1200)

    def test_an_age_is_none_rather_than_zero_when_there_is_nothing_to_measure(self) -> None:
        self.assertEqual(age_of("2026-09-04T22:46:25Z", self.clock.time()), 60)
        self.assertIsNone(age_of("2026-09-04T22:48:25Z", self.clock.time()), "the future has no age")
        self.assertIsNone(age_of("", self.clock.time()))
        self.assertIsNone(age_of("garbage", self.clock.time()))
        self.assertEqual(freshest_age("2099-01-01T00:00:00Z", "", "2026-09-04T22:37:25Z", now=self.clock.time()), 600,
                         "each clock is validated on its own before the freshest wins")
        self.assertEqual((fmt_age(None), fmt_age(59), fmt_age(1203)), ("an unknown time", "59s", "20m"))


def _row(id_: int, **extra: Json) -> dict[str, Json]:
    row: dict[str, Json] = {"id": id_, "path": "a.sh", "line": 3, "original_line": 3, "body": "a finding",
                            "original_commit_id": "abc", "commit_id": "abc", "user": {"login": "r[bot]"}}
    row.update(extra)
    return row


class PollRendering(unittest.TestCase):
    def test_threads_at_one_anchor_fold_whatever_their_text(self) -> None:
        entries = fold_inline([_row(900), _row(901, body="another", node_id="X", url="u"), _row(902, line=9)])
        self.assertEqual([e.thread_ids for e in entries], [[900, 901], [902]])
        self.assertEqual(entries[0].thread_bodies, [(900, "a finding"), (901, "another")])

    def test_a_field_nobody_enumerated_keeps_two_threads_apart(self) -> None:
        entries = fold_inline([_row(900, side="LEFT"), _row(901, side="RIGHT")])
        self.assertEqual(len(entries), 2)

    def test_the_anchor_renders_what_the_row_carries(self) -> None:
        self.assertEqual(item_line({"position": 12}), "@12")
        self.assertEqual(item_line({"line": None}), "?")
        self.assertEqual(item_line({"line": 40, "start_line": 36}), "36-40")
        self.assertEqual(item_was({"line": 40, "start_line": 36, "original_line": 34, "original_start_line": 30}),
                         " was=30-34")
        self.assertEqual(item_side({"side": "RIGHT", "start_side": "LEFT"}), " start_side=LEFT")
        self.assertEqual((short(None), short(""), short("1234567890")), ("-", "-", "1234567"))

    def test_only_the_exact_about_block_at_the_end_folds(self) -> None:
        opener = "<details> <summary>ℹ️ About Codex in GitHub</summary>"
        body = f"P1: x\n\n{opener}\ntext\n</details>\n  "
        self.assertEqual(fold_codex_about(body), 'P1: x\n\n[Codex "About Codex in GitHub" boilerplate folded]')
        self.assertEqual(fold_codex_about(body + "more"), body + "more", "text after the block")
        self.assertEqual(fold_codex_about(body.replace("️", "")), body.replace("️", ""))


    def test_a_round_that_fails_mid_rendering_keeps_its_text_but_no_machine_lines(self) -> None:
        """The premise of the watch suite's quoted-watermark case: a rendering that fails after a
        body quoting a "watermark:" line leaves that line in the partial output, as jq's stream
        did, and only the status and the empty machine fields say the round is not one."""
        feeds: dict[str, Json] = {
            "pulls/7/comments": [_row(900, body="a finding\nwatermark: 9000,9000,9000")],
            "issues/7/comments": [],
            "pulls/7/reviews": [{"id": 800, "user": {"login": "r[bot]"}, "state": "COMMENTED",
                                 "commit_id": 12345, "body": "findings"}],
            "pulls/7/reviews/800/comments": [],
        }

        def run(_tool: str, args: Sequence[str]) -> proc.Completed:
            endpoint = args[-1].removeprefix("repos/o/r/").split("?")[0]
            return proc.Completed(0, json.dumps(feeds[endpoint]), "")

        session = GhSession(load_config({"REPO": "o/r"}), run=run, sleep=lambda _s: None)
        ctx = Ctx(session, "o/r", "r", FileClock(os.devnull), 600)
        result = poll(ctx, "7", "5,5,5")
        self.assertEqual(result.rc, 4, "a commit_id the commit column cannot slice")
        self.assertIn("\nwatermark: 9000,9000,9000\n", result.text)
        self.assertEqual((result.items, result.watermark), ("", ""))


class Pieces(unittest.TestCase):
    def test_an_item_is_about_the_head_by_prefix_either_way(self) -> None:
        self.assertTrue(item_about_head("2222222", "2222222bbbb"))
        self.assertTrue(item_about_head("-", "2222222bbbb"), "no stamp is no evidence")
        self.assertTrue(item_about_head("1111111", ""), "an unread head holds nothing back")
        self.assertFalse(item_about_head("1111111", "2222222bbbb"))

    def test_cut_keeps_a_line_without_the_delimiter(self) -> None:
        self.assertEqual((_cut_f12("a|run|text|more"), _cut_f12("plain")), ("a|run", "plain"))

    def test_conclusion_classes(self) -> None:
        self.assertEqual([conclusion_class(c) for c in ("failure", "skipped", "", "cancelled")],
                         ["red", "green", "pending", "nogo"])

    def test_the_sweep_takes_only_what_a_dead_owner_left(self) -> None:
        root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-sweep."))
        try:
            dead = subprocess.Popen([sys.executable, "-c", "pass"])
            dead.wait()
            live = os.getpid()
            for name in (f"pr-review-snap.{dead.pid}.AAAA", f"pr-review-snap.{live}.BBBB"):
                os.mkdir(os.path.join(root, name))
            for name in (f"pr-review-err.{dead.pid}", f"pr-review-gh.{live}.X", "pr-review-gh.vswQwU"):
                open(os.path.join(root, name), "w").close()
            tmp_sweep_stale({"TMPDIR": root + "/"})
            self.assertEqual(sorted(os.listdir(root)),
                             sorted([f"pr-review-snap.{live}.BBBB", f"pr-review-gh.{live}.X", "pr-review-gh.vswQwU"]))
        finally:
            shutil.rmtree(root, ignore_errors=True)


# --- the production path ------------------------------------------------------------------------------

_FAKE_GH = """\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
with open(os.path.join(here, "answers.json"), encoding="utf-8") as f:
    answers = json.load(f)
endpoint = ""
skip = False
for i, a in enumerate(args[1:], 1):
    if skip:
        skip = False
        continue
    if a in ("-X", "-f", "-F", "--jq", "--repo", "--json"):
        skip = True
        continue
    if a.startswith("-"):
        continue
    endpoint = a
    break
key = " ".join(args[:2]) if args[0] == "run" else endpoint
a = answers.get(key)
if a is None:
    sys.stderr.write("fake gh: no answer for " + key + "\\n")
    sys.exit(1)
sys.stdout.write(a.get("stdout", ""))
sys.stderr.write(a.get("stderr", ""))
sys.exit(a.get("rc", 0))
"""


class EndToEnd(unittest.TestCase):
    """A fake gh first on PATH, answering by endpoint (already in the shape --jq would print)."""

    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-watch-test."))
        gh = os.path.join(self.dir, "gh")
        with open(gh, "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{_FAKE_GH}")
        os.chmod(gh, 0o755)
        self.clock = os.path.join(self.dir, "clock")
        with open(self.clock, "w") as f:
            f.write("1790000000\n")
        self.tmp = os.path.join(self.dir, "tmp")
        os.mkdir(self.tmp)

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def answer(self, answers: dict[str, dict[str, Json]]) -> None:
        with open(os.path.join(self.dir, "answers.json"), "w", encoding="utf-8") as f:
            json.dump(answers, f)

    def calls(self) -> list[list[str]]:
        try:
            with open(os.path.join(self.dir, "calls.jsonl"), encoding="utf-8") as f:
                return [json.loads(line) for line in f]
        except FileNotFoundError:
            return []

    def run_cmd(self, entry: list[str], *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        e = dict(os.environ)
        e.update({"PATH": f"{self.dir}{os.pathsep}{e.get('PATH', '')}", "TMPDIR": self.tmp,
                  "SHIP_PR_API_ATTEMPTS": "1", "SHIP_PR_API_BACKOFF": "0", "REPO": "",
                  "SHIP_PR_TEST_CLOCK": self.clock,
                  "SHIP_PR_STATE_DIR": os.path.join(self.tmp, "state")})
        e.update(env)
        return subprocess.run([*entry, *args], capture_output=True, text=True, env=e, cwd=self.dir,
                              check=False)

    def entries(self) -> list[list[str]]:
        return [[PY, "-m", "ludics.prreview"], [PR_REVIEW]]

    def quiet_pr(self) -> None:
        h2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        self.answer({
            "repos/o/r/issues/7/reactions?per_page=100": {"stdout": "[]\n"},
            "repos/o/r/issues/7/comments?per_page=100": {"stdout": "[]\n"},
            "repos/o/r/pulls/7/reviews?per_page=100": {"stdout": "[]\n"},
            "repos/o/r/pulls/7/comments?per_page=100": {"stdout": "[]\n"},
            "repos/o/r/pulls/7": {"stdout": f"{h2}\tclean\t2026-09-21T14:12:20Z\n"},
            f"repos/o/r/commits/{h2}": {"stdout": "2026-09-21T14:12:20Z\n"},
        })

    def test_a_quiet_window_runs_on_the_test_clock_and_ends_on_a_watermark(self) -> None:
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.quiet_pr()
                with open(self.clock, "w") as f:
                    f.write("1790000000\n")
                done = self.run_cmd(entry, "watch", "o/r#7", "5,6,7", WATCH_INTERVAL="30", WATCH_TIMEOUT="60")
                self.assertEqual(done.returncode, 1, done.stderr)
                lines = done.stdout.splitlines()
                self.assertEqual(lines[-1], "watermark: 5,6,7")
                self.assertTrue(lines[0].startswith("no reviewer activity about head 2222222 in 60s; status: review EXPECTED"),
                                lines[0])
                self.assertIn("watching PR o/r#7, every 30s for up to 60s; from:", done.stderr)
                with open(self.clock) as f:
                    self.assertEqual(int(f.read()), 1790000000 + 60, "two 30s pauses, on the file clock")

    def test_a_pr_without_a_repository_is_refused_before_any_read(self) -> None:
        self.quiet_pr()
        done = self.run_cmd([PR_REVIEW], "watch", "7")
        self.assertEqual(done.returncode, 2)
        self.assertIn("PR 7 was given with no repository", done.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_missing_pr_is_bashs_usage_exit(self) -> None:
        done = self.run_cmd([PY, "-m", "ludics.prreview"], "watch")
        self.assertEqual((done.returncode, done.stderr), (1, "pr-review.sh: 1: usage: watch <pr> [watermark] [--no-nudge]\n"))

    def test_the_run_await_through_retry(self) -> None:
        cases: tuple[tuple[dict[str, Json], int, str], ...] = (
            ({"stdout": "completed\tsuccess\n"}, 0, "run 5 in o/r: success"),
            ({"stdout": "completed\tfailure\n"}, 1, "the run FAILED"),
            ({"stdout": "completed\tcancelled\n"}, 4, "stopped, not judged"),
            ({"rc": 1, "stderr": "gh: Not Found (HTTP 404)\n"}, 2, "no run 5 readable here"),
            ({"rc": 1, "stderr": "gh: HTTP 503: Service Unavailable\n"}, 3, "UNKNOWN"),
        )
        for answer, rc, text in cases:
            with self.subTest(rc=rc):
                self.answer({"run view": answer})
                done = self.run_cmd([PR_REVIEW], "retry", "run", "watch", "o/r#5")
                self.assertEqual(done.returncode, rc, done.stderr)
                self.assertIn(text, done.stdout + done.stderr)

    def test_the_run_await_sleeps_on_the_test_clock_to_its_deadline(self) -> None:
        self.answer({"run view": {"stdout": "in_progress\tpending\n"}})
        # A build cap at the interval keeps the pause fixed (the polling budget doubles it from the
        # interval up to the cap; test-pr-review-budget.sh pins the backoff itself).
        done = self.run_cmd([PR_REVIEW], "retry", "run", "watch", "o/r#5", "-i", "100",
                            SHIP_PR_CHECKS_WAIT="250", SHIP_PR_CHECKS_HEARTBEAT="200",
                            SHIP_PR_BUILD_POLL_CAP="100")
        self.assertEqual(done.returncode, 4, done.stderr)
        self.assertIn("has NO VERDICT after 4 min (status: in_progress)", done.stderr)
        self.assertEqual(done.stderr.count("still waiting on run 5 in o/r: in_progress after 3 min"), 1)
        self.assertEqual(len(self.calls()), 4, "reads at 0, 100, 200 and the capped 250")


if __name__ == "__main__":
    unittest.main()
