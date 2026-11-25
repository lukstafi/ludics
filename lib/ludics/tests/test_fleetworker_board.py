"""ludics.fleetworker.boardstore (the shipped store, imported: main does not run on import) and
ludics.fleetworker.board's command-line reading."""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import assign, board, boardstore, takeover, tally, wavereview
from ludics.fleetworker.config import load_config
from ludics.fleetworker.transport import Done

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# The cell texts that broke `sed` on the OCANNL wave-20261014 board, and the rest of the shell's and
# markdown's metacharacters.
HOSTILE = "a|b (c) #d /e `f` $(g) 'q' \"dq\" s/x/y/g \\ & * [x](y) <br> ü"


ZERO = {"interventions": "0", "routine_answers": "0", "relaunches": "0"}  # THE COUNTERS START AT ZERO (boardstore.py's header)


class StoreCase(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-board-test."))

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def call(self, action: str, payload: dict[str, Any]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = boardstore.run(["-", self.root, action, "coord", json.dumps(payload)])
        return rc, out.getvalue(), err.getvalue()

    def doc(self, wave: str = "w") -> dict[str, Any]:
        rc, out, err = self.call("show", {"wave": wave, "json": True})
        self.assertEqual(rc, 0, err)
        return json.loads(out)

    def set(self, task: str, *pairs: tuple[str, str], create: bool = True, new_row: bool = True) -> tuple[int, str, str]:
        return self.call("set", {"wave": "w", "create": create, "new_row": new_row, "task": task,
                                 "fields": [list(p) for p in pairs]})

    def spawned(self, task: str, agent: str, transport: str, **extra: str) -> tuple[int, str, str]:
        return self.call("spawned", {"wave": "w", "task": task, "agent": agent, "transport": transport, **extra})


class Store(StoreCase):
    def test_a_writer_refuses_an_unknown_wave_unless_create(self) -> None:
        rc, out, err = self.set("t", ("k", "v"), create=False)
        self.assertEqual((rc, out), (1, ""))
        self.assertEqual(err, "BOARD REFUSED: no board for wave w on the anchor (start it with set or note --create)\n")
        self.assertFalse(os.path.exists(os.path.join(self.root, "boards")))
        self.assertEqual(self.set("t", ("k", "v"))[0], 0)
        self.assertEqual(self.set("t", ("k", "w"))[0], 0, "create on an existing board is no refusal")
        self.assertEqual(self.doc()["tasks"][0]["fields"], {"k": "w", **ZERO})
        self.assertEqual(self.call("log", {"wave": "w", "text": " "})[2], "BOARD REFUSED: a log line must not be empty\n")

    def test_a_task_with_no_row_is_refused_unless_new_row(self) -> None:
        """#1114: `2032` typed for `t2032` made an empty second row each time."""
        self.set("t2032", ("state", "launched"))
        self.set("t2040", ("state", "launched"))
        before = self.doc()
        rc, out, err = self.set("2032", ("state", "merged"), new_row=False)
        self.assertEqual((rc, out), (1, ""))
        self.assertEqual(err, 'BOARD REFUSED: no task "2032" on the board of w; the nearest is "t2032"'
                              " (a new row takes set --new-row)\n")
        rc, _, err = self.set("zz", ("state", "merged"), new_row=False)
        self.assertEqual((rc, err), (1, 'BOARD REFUSED: no task "zz" on the board of w (a new row takes set --new-row)\n'))
        self.assertEqual(self.call("set", {"wave": "w", "create": False, "task": "2032", "fields": [["k", "v"]]})[0], 1,
                         "a payload that does not say new_row does not add one")
        self.assertEqual(self.doc(), before, "a refusal writes nothing")
        self.assertEqual(self.set("t2032", ("state", "merged"), new_row=False)[0], 0, "a row that exists needs no flag")
        self.assertEqual(self.set("t2032", ("pr", "7"))[0], 0, "new_row on a row that exists is no refusal")
        self.assertEqual(self.set("2032", ("state", "dropped"))[0], 0)
        self.assertEqual([row["task"] for row in self.doc()["tasks"]], ["t2032", "t2040", "2032"])

    def test_placement_is_an_idempotent_union_and_missing_rows_are_not_created(self) -> None:
        payload = {"wave": "w", "worker": "wk", "host": "gpu", "checkout": "/leg"}
        self.assertEqual(self.call("placement", payload)[0], 0)
        self.assertFalse(os.path.exists(os.path.join(self.root, "boards")))
        self.set("t1", ("worker", "wk"), ("exec_hosts", "mac,mac"), ("farside", "none"), ("state", "launched"))
        for _ in range(2):
            self.assertEqual(self.call("placement", payload)[0], 0)
        fields = self.doc()["tasks"][0]["fields"]
        self.assertEqual({k: v for k, v in fields.items() if k != "launched_at"},
                         {"worker": "wk", "exec_hosts": "mac,gpu", "farside": "gpu:/leg", "state": "launched", **ZERO})
        before = self.doc()
        self.assertEqual(self.call("placement", {**payload, "worker": "absent"})[0], 0)
        self.assertEqual(self.doc(), before)
        self.set("t2", ("worker", "wk"))
        before = self.doc()
        self.assertEqual(self.call("placement", payload)[0], 1)
        self.assertEqual(self.doc(), before, "an ambiguous identity writes nothing")

    def test_placement_rejects_word_splitting_without_publishing_a_prefix(self) -> None:
        self.set("t1", ("worker", "wk"), ("exec_hosts", "mac"), ("farside", "mac:/worker"))
        before = self.doc()
        for host, checkout in (("gpu", "/tmp/project old"), ("gpu", "/tmp/project\told"),
                               ("gpu", "/tmp/project\u2003old"), ("gpu:other", "/tmp/project")):
            rc, _, err = self.call("placement", {"wave": "w", "worker": "wk", "host": host, "checkout": checkout})
            self.assertEqual(rc, 1)
            self.assertIn("cannot fit one", err)
            self.assertEqual(self.doc(), before, "even a valid prefix must never reach the cleanup board")

    def test_forget_removes_only_the_named_workers_pending_row(self) -> None:
        payload = {"wave": "w", "task": "t2", "worker": "wk", "state": "pending"}
        rc, out, _ = self.call("forget", payload)
        self.assertEqual((rc, out), (0, 'BOARD FORGET w: "t2" has no row; nothing written\n'), "no board: a retried removal")
        self.assertFalse(os.path.exists(os.path.join(self.root, "boards")), "and no board is started")
        self.set("t1", ("worker", "w1"), ("state", "launched"))
        self.set("t2", ("worker", "wk"), ("state", "pending"))
        self.call("note", {"wave": "w", "fields": [["scope", "s"]]})
        self.call("log", {"wave": "w", "text": "a line"})
        for other in ({"state": "launched"}, {"worker": "w9"}):
            before = self.doc()
            rc, _, err = self.call("forget", {**payload, **other})
            self.assertEqual(rc, 1)
            self.assertIn('BOARD REFUSED: the row of "t2" is state="pending" worker="wk"', err)
            self.assertEqual(self.doc(), before, "a row that is not the named one is never removed")
        before = self.doc()
        self.assertEqual(self.call("forget", payload), (0, 'BOARD FORGET w: "t2"\n', ""))
        after = self.doc()
        self.assertEqual([row["task"] for row in after["tasks"]], ["t1"])
        self.assertEqual((after["notes"], after["log"], after["tasks"][0]), (before["notes"], before["log"], before["tasks"][0]))
        self.assertEqual(self.call("forget", payload)[:2], (0, 'BOARD FORGET w: "t2" has no row; nothing written\n'), "a re-run")

    def test_hostile_text_round_trips_in_every_field(self) -> None:
        self.assertEqual(self.set(HOSTILE, ("state", HOSTILE), ("multi", "one\ntwo"))[0], 0)
        self.assertEqual(self.call("note", {"wave": "w", "fields": [["scope", HOSTILE]]})[0], 0)
        self.assertEqual(self.call("log", {"wave": "w", "text": HOSTILE})[0], 0)
        doc = self.doc()
        self.assertEqual(doc["tasks"][0]["task"], HOSTILE)
        self.assertEqual(doc["tasks"][0]["fields"], {"state": HOSTILE, "multi": "one\ntwo", **ZERO})
        self.assertEqual(doc["notes"], {"scope": HOSTILE})
        self.assertEqual([(line["by"], line["text"]) for line in doc["log"]], [("coord", HOSTILE)])

    def test_rows_and_keys_keep_their_order_and_a_set_changes_only_its_keys(self) -> None:
        self.set("b", ("state", "implementing"), ("pr", ""))
        self.set("a", ("pr", "12"), ("host", "mac"))
        self.set("b", ("state", "merged"))
        doc = self.doc()
        self.assertEqual([row["task"] for row in doc["tasks"]], ["b", "a"])
        self.assertEqual(doc["tasks"][0]["fields"], {"state": "merged", "pr": "", **ZERO})

    def test_changing_a_paired_rows_plan_clears_its_planner_fields(self) -> None:
        for task, update in (("t1", ("planning", "none")), ("t2", ("plan_dir", "/plans/next"))):
            with self.subTest(update=update):
                fields = {"planning": "paired", "plan_dir": f"/plans/{task}"}
                self.assertEqual(self.set(task, *fields.items())[0], 0)
                self.assertEqual(self.set(task, ("plan_dir", fields["plan_dir"]), ("planner", "fable"),
                                          ("planner_effort", "high"))[0], 0)
                self.assertEqual(self.set(task, update)[0], 0)
                fields[update[0]] = update[1]
                self.assertEqual(self.doc()["tasks"][-1]["fields"], {**fields, **ZERO})

    def test_a_launch_is_stamped_once_by_the_stores_clock(self) -> None:
        """THE LAUNCH STAMP: ``state=launched`` (wave launch's, or a native coordinator's by hand)
        writes ``launched_at`` beside it, so every launch is timed with no step of its own."""
        clock = iter(["2026-11-17T10:00:00Z", "2026-11-17T10:05:00Z", "2026-11-17T11:00:00Z", "2026-11-17T12:00:00Z",
                      "2026-11-17T13:00:00Z", "2026-11-17T14:00:00Z"])

        class Stamp:
            def strftime(self, _fmt: str) -> str:
                return next(clock)

        class Clock:
            @staticmethod
            def now(_tz: Any) -> Stamp:
                return Stamp()

        with mock.patch.object(boardstore, "datetime", Clock):
            self.set("t1", ("state", "pending"), ("tier", "D2"))
            self.set("t1", ("agent", "a1"), ("state", "launched"))
            self.set("t1", ("state", "Launched; again, a finisher"))
            self.set("t2", ("state", "launched: by hand"), ("launched_at", "2026-11-16T09:00:00Z"))
            self.set("t3", ("state", "launchedx"))
            self.set("t3", ("state", "merged #4"))
        rows = {row["task"]: row["fields"] for row in self.doc()["tasks"]}
        self.assertEqual(rows["t1"], {"state": "Launched; again, a finisher", "tier": "D2", **ZERO, "agent": "a1",
                                      "launched_at": "2026-11-17T10:05:00Z"},
                         "stamped at the row's end by the set that launched it, and a relaunch keeps the first stamp")
        self.assertEqual(rows["t2"]["launched_at"], "2026-11-16T09:00:00Z", "a set that names launched_at writes its own")
        self.assertNotIn("launched_at", rows["t3"], "only the state word launched stamps: no other word, no prefix")

    def test_the_view_escapes_only_the_pipe_and_line_breaks(self) -> None:
        self.set("ll#1", ("state", "a|b"), ("note", "x\ny"))
        self.set("ll#2", ("pr", "`#3`"))
        self.call("note", {"wave": "w", "fields": [["base", "abc\ndef"]]})
        self.call("log", {"wave": "w", "text": "one | two"})
        rc, out, _ = self.call("show", {"wave": "w"})
        self.assertEqual(rc, 0)
        lines = out.split("\n")
        self.assertEqual(lines[:5], ["# Board: w", "", "- base: abc<br>def", "",
                                     "| task | state | note | interventions | routine_answers | relaunches | pr |"])
        self.assertEqual(lines[5:8], ["| --- | --- | --- | --- | --- | --- | --- |", "| ll#1 | a\\|b | x<br>y | 0 | 0 | 0 |  |",
                                      "| ll#2 |  |  | 0 | 0 | 0 | `#3` |"])
        self.assertEqual(lines[9], "## Log")
        self.assertRegex(lines[10], r"^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ one \| two$")

    def test_no_text_ends_a_row_and_no_backslash_unescapes_a_pipe(self) -> None:
        self.set("t", ("a", "x\\|y"), ("b", "one\u2028two\x85three\u2029four\vfive"), ("c", "bell\x07\ttab\x1f"))
        self.call("log", {"wave": "w", "text": "x\u2028y"})
        rc, out, _ = self.call("show", {"wave": "w"})
        self.assertEqual(rc, 0)
        lines = out.split("\n")
        self.assertEqual(lines[4], "| t | x\\\\\\|y | one<br>two<br>three<br>four<br>five | bell\ufffd\ttab\ufffd | 0 | 0 | 0 |")
        self.assertTrue(lines[7].endswith(" x<br>y"), lines)
        self.assertEqual(len(out.splitlines()), len(lines) - 1, "no line break but the view's own")
        self.assertEqual(self.doc()["tasks"][0]["fields"]["a"], "x\\|y", "the document keeps the text as given")

    def test_the_grammar_is_fail_closed(self) -> None:
        cases: list[tuple[dict[str, Any], str]] = [
            ({"wave": "../x", "create": True, "task": "t", "fields": [["k", "v"]]}, "a wave must be"),
            ({"wave": "w", "create": True, "task": "t", "fields": [["bad key", "v"]]}, "a key must be"),
            ({"wave": "w", "create": True, "task": "t", "fields": []}, "fields must be a nonempty list"),
            ({"wave": "w", "create": True, "task": "-t", "fields": [["k", "v"]]}, "a task must be"),
            ({"wave": "w", "create": True, "task": "a\nb", "fields": [["k", "v"]]}, "a task must be"),
            ({"wave": "w", "create": True, "task": "a\u0085b", "fields": [["k", "v"]]}, "a task must be"),
            ({"wave": "w", "create": True, "task": "a\u2028b", "fields": [["k", "v"]]}, "a task must be"),
            ({"wave": "w", "create": True, "task": "t", "fields": [["k", "\udcff"]]}, "not valid UTF-8"),
        ]
        for payload, why in cases:
            rc, _, err = self.call("set", payload)
            self.assertEqual(rc, 1, payload)
            self.assertIn(why, err)
        self.assertEqual(self.call("log", {"wave": "w", "text": "x"})[2],
                         "BOARD REFUSED: no board for wave w on the anchor (start it with set or note --create)\n")
        self.assertEqual(self.call("log", {"wave": "w", "create": True, "text": "x"})[0], 1, "log never starts a board")
        self.assertFalse(os.path.exists(os.path.join(self.root, "boards")), "no refusal wrote anything")

    def test_a_corrupt_board_is_refused_and_never_overwritten(self) -> None:
        path = os.path.join(self.root, "boards", "w.json")
        self.set("t", ("k", "v"))
        with open(path) as f:
            valid = json.load(f)
        del valid["created_by"]
        for text in ("{not json", json.dumps({"board": 1, "wave": "other"}), json.dumps(valid),
                     json.dumps({**valid, "created_by": "c", "board": True})):
            with open(path, "w") as f:
                f.write(text)
            rc, _, err = self.set("t", ("k", "v"))
            self.assertEqual(rc, 1)
            self.assertIn("is not a valid board", err)
            with open(path) as f:
                self.assertEqual(f.read(), text)
            self.assertEqual(self.call("show", {"wave": "w"})[0], 1)

    def test_every_write_is_one_replace_of_the_whole_document(self) -> None:
        self.set("t", ("k", "v"))
        real = os.replace
        calls: list[str] = []

        def counting(src: str, dst: str) -> None:
            calls.append(str(dst))
            real(src, dst)

        with mock.patch.object(boardstore.os, "replace", counting):
            self.set("t", ("k", "w"), ("j", "x"))
            self.call("log", {"wave": "w", "text": "x"})
        self.assertEqual(calls, [os.path.join(self.root, "boards", "w.json")] * 2)
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "boards"))), ["w.json"], "no temporary left")

    def test_a_failed_replace_leaves_the_board_whole(self) -> None:
        self.set("t", ("k", "v"))
        path = os.path.join(self.root, "boards", "w.json")
        with open(path) as f:
            before = f.read()

        def failing(src: str, dst: str) -> None:
            raise OSError("no space left")

        with mock.patch.object(boardstore.os, "replace", failing):
            rc, _, err = self.call("log", {"wave": "w", "text": "x"})
        self.assertEqual((rc, err), (1, "BOARD REFUSED: no space left\n"))
        with open(path) as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(os.listdir(os.path.join(self.root, "boards")), ["w.json"], "no temporary left")

    def test_the_acknowledgement_is_ascii_whatever_the_task_holds(self) -> None:
        rc, out, _ = self.set("\u00fc #1", ("k", "\u00fc"))
        self.assertEqual((rc, out), (0, 'BOARD SET w: "\\u00fc #1" k\n'))
        self.assertTrue(out.isascii())

    def test_show_of_an_unknown_wave_refuses(self) -> None:
        self.assertEqual(self.call("show", {"wave": "nope"}),
                         (boardstore.NO_BOARD_EXIT, "", "BOARD REFUSED: no board for wave nope on the anchor\n"))

    def test_no_board_is_its_own_exit_and_nothing_else_is(self) -> None:
        """Exit 5 (NO_BOARD_EXIT) means the root is a directory and the board path is absent; a present
        board shows, and every other failure to read one stays exit 1 (the header's boundary)."""
        self.assertEqual(boardstore.NO_BOARD_EXIT, 5)
        self.assertEqual(self.call("show", {"wave": "w"})[0], boardstore.NO_BOARD_EXIT, "missing board, no boards dir")
        self.set("t", ("k", "v"))
        self.assertEqual(self.call("show", {"wave": "w"})[0], 0, "present board")
        self.assertEqual(self.call("show", {"wave": "other"})[0], boardstore.NO_BOARD_EXIT, "missing board, boards dir")
        os.symlink(os.path.join(self.root, "gone.json"), os.path.join(self.root, "boards", "dangling.json"))
        self.assertEqual(self.call("show", {"wave": "dangling"})[:2], (1, ""), "a dangling link is no absence")
        with open(os.path.join(self.root, "boards", "w.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(self.call("show", {"wave": "w"})[0], 1, "a corrupt board is a refusal")
        for root, why in ((os.path.join(self.root, "absent"), "is not a directory"),
                          (os.path.join(self.root, "boards", "w.json"), "Not a directory")):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = boardstore.run(["-", root, "show", "coord", json.dumps({"wave": "w"})])
            self.assertEqual(rc, 1, root)
            self.assertIn(why, err.getvalue())
        shutil.rmtree(os.path.join(self.root, "boards"))
        with open(os.path.join(self.root, "boards"), "w") as f:
            f.write("a file where the boards directory goes")
        self.assertEqual(self.call("show", {"wave": "w"})[0], 1, "a boards that is a file is no absence")
        self.assertEqual(self.set("t", ("k", "v"), create=False)[0], 1)
        self.assertEqual(self.call("log", {"wave": "w", "text": "x"})[0], 1)

    @unittest.skipIf(os.geteuid() == 0, "root reads past permissions")
    def test_an_unreadable_boards_directory_is_no_absence(self) -> None:
        self.set("t", ("k", "v"))
        boards = os.path.join(self.root, "boards")
        os.chmod(boards, 0)
        try:
            rc, _, err = self.call("show", {"wave": "other"})
        finally:
            os.chmod(boards, 0o700)
        self.assertEqual(rc, 1, err)
        self.assertIn("Permission denied", err)

    def test_a_writer_keeps_exit_1_for_no_board(self) -> None:
        self.assertEqual(self.set("t", ("k", "v"), create=False)[0], 1)
        self.assertEqual(self.call("log", {"wave": "w", "text": "x"})[0], 1)


class Tally(StoreCase):
    """boardstore's ``tally`` (ludics#1214): a row's counter one more, under the lock, in one publish."""

    def tally(self, counter: str, why: str = "x", **where: Any) -> tuple[int, str, str]:
        return self.call("tally", {"counter": counter, "why": why, **where})

    def fields(self, task: str, wave: str = "w") -> dict[str, str]:
        return next(row["fields"] for row in self.doc(wave)["tasks"] if row["task"] == task)

    def test_a_new_row_starts_at_zero_and_a_set_keeps_the_counts(self) -> None:
        self.set("t1", ("state", "pending"))
        self.set("t2", ("state", "pending"), ("interventions", "3"))
        self.assertEqual(self.fields("t1"), {"state": "pending", **ZERO})
        self.assertEqual(self.fields("t2"), {"state": "pending", "interventions": "3", "routine_answers": "0", "relaunches": "0"},
                         "a set that names a counter writes its own")
        self.assertEqual(self.tally("interventions", wave="w", task="t1")[0], 0)
        self.set("t1", ("state", "launched"))  # --new-row again, as a retried first write or a relaunch sends it
        self.assertEqual(self.fields("t1")["interventions"], "1", "a set on a row that exists keeps its counts")

    def test_a_tally_by_task_counts_once_and_logs_an_intervention_only(self) -> None:
        self.set("t1", ("state", "launched"))
        self.set("t2", ("state", "launched"))
        rc, out, err = self.tally("interventions", "unstick --kill (\"x\")", wave="w", task="t1")
        self.assertEqual((rc, out, err), (0, 'BOARD TALLY w: "t1" interventions=1\n', ""))
        self.assertEqual(self.tally("routine_answers", "\"REVIEW_POSTED 1\"", wave="w", task="t1")[0], 0)
        self.assertEqual(self.tally("interventions", "message \"why?\"", wave="w", task="t1")[0], 0)
        self.assertEqual(self.fields("t1"), {"state": "launched", "interventions": "2", "routine_answers": "1",
                                             "relaunches": "0", "launched_at": self.fields("t1")["launched_at"]})
        self.assertEqual(self.fields("t2"), {"state": "launched", **ZERO, "launched_at": self.fields("t2")["launched_at"]},
                         "a sibling row is not touched")
        self.assertEqual([line["text"] for line in self.doc()["log"]],
                         ['t1 interventions=1: unstick --kill ("x")', 't1 interventions=2: message "why?"'])

    def test_a_tally_refuses_what_it_cannot_count_and_writes_nothing(self) -> None:
        self.set("t2032", ("state", "launched"), ("routine_answers", "07"))
        before = self.doc()
        refusals = {
            "a counter of no list": self.tally("rounds", wave="w", task="t2032"),
            "a task with no row": self.tally("interventions", wave="w", task="2032"),
            "a value that is no count": self.tally("routine_answers", wave="w", task="t2032"),
            "no board": self.tally("interventions", wave="none", task="t1"),
        }
        for what, (rc, out, _) in refusals.items():
            self.assertEqual((rc, out), (1, ""), what)
        self.assertIn('the nearest is "t2032"; nothing counted', refusals["a task with no row"][2])
        self.assertIn('holds routine_answers="07", no count', refusals["a value that is no count"][2])
        self.assertEqual(self.doc(), before, "a refusal writes nothing")

    def test_a_tally_by_worker_counts_the_one_row_not_done_on_any_board(self) -> None:
        """``unstick`` knows a box and a worker: the row is the one not done whose worker and agent_host match."""
        def row(wave: str, task: str, **fields: str) -> None:
            self.call("set", {"wave": wave, "create": True, "new_row": True, "task": task,
                              "fields": [[k, v] for k, v in fields.items()]})
        done = list(takeover.DONE_STATES)
        row("a", "t1", worker="w1-42", agent_host="mac", state="merged")              # an earlier wave's, done
        row("b", "t1", worker="w1-42", agent_host="mac", state="Implementing; round 2")
        row("b", "t2", worker="w1-42", agent_host="rog", state="launched")            # another box's
        row("b", "t3", worker="w1-43", agent_host="mac", status="launched")          # status only: before #810
        rc, out, _ = self.tally("interventions", worker="w1-42", hosts=["mac"], done=done)
        self.assertEqual((rc, out), (0, 'BOARD TALLY b: "t1" interventions=1\n'))
        self.assertEqual(self.tally("routine_answers", worker="w1-43", hosts=["mac"], done=done)[1],
                         'BOARD TALLY b: "t3" routine_answers=1\n')
        self.assertEqual((self.fields("t1", "a")["interventions"], self.fields("t2", "b")["interventions"]), ("0", "0"))
        rc, out, _ = self.tally("interventions", worker="w9", hosts=["mac"], done=done)
        self.assertEqual((rc, out), (0, 'BOARD TALLY NOTE: no row of worker "w9" on "mac" that is not done, on any board;'
                                        " nothing counted\n"), "a worker outside any wave is no refusal")
        row("c", "t9", worker="w1-42", agent_host="mac", state="reviewing")
        before = (self.doc("b"), self.doc("c"))
        rc, out, _ = self.tally("interventions", worker="w1-42", hosts=["mac"], done=done)
        self.assertEqual((rc, out), (0, 'BOARD TALLY NOTE: worker "w1-42" on "mac" names 2 rows that are not done'
                                        " (b/t1, c/t9); nothing counted\n"), "an ambiguous worker is counted nowhere")
        self.assertEqual((self.doc("b"), self.doc("c")), before)
        with open(os.path.join(self.root, "boards", "d.json"), "w") as f:
            f.write("{not a board")
        self.assertEqual(self.tally("routine_answers", worker="w1-43", hosts=["mac"], done=done)[1],
                         'BOARD TALLY b: "t3" routine_answers=2\n', "a board that does not load is skipped")
        self.assertEqual(self.tally("interventions", worker="w1-43", hosts=["mac"], done="merged")[0], 1)
        row("e", "t1", worker="w1-44", agent_host="mac", state="launched", transport="subagent")
        self.assertIn("BOARD TALLY NOTE: no row", self.tally("interventions", worker="w1-44", hosts=["mac"], done=done)[1],
                      "an unstick reaches only a CLI worker: a native row of that name is never charged")
        shutil.rmtree(os.path.join(self.root, "boards"))
        with open(os.path.join(self.root, "boards"), "w") as f:
            f.write("")
        for refused in (self.tally("interventions", worker="w1-43", hosts=["mac"], done=done),
                        self.call("scan", {"since_hours": None})):
            self.assertEqual(refused[:2], (1, ""), "a boards that is no directory: scan's refusal, by its one listing")
            self.assertIn("boards is not a directory", refused[2])

    def test_a_row_made_before_the_counters_says_its_counts_are_partial(self) -> None:
        self.set("t1", ("state", "launched"))
        doc = self.doc()
        doc["tasks"][0]["fields"] = {"state": "launched"}  # a row an older store made
        with open(os.path.join(self.root, "boards", "w.json"), "w") as f:
            json.dump(doc, f)
        self.assertEqual(self.tally("routine_answers", wave="w", task="t1")[0], 0)
        self.assertEqual(self.tally("interventions", wave="w", task="t1")[0], 0)
        fields = self.fields("t1")
        self.assertEqual((fields["routine_answers"], fields["interventions"]), ("1", "1"))
        self.assertRegex(fields["counted_from"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.set("t2", ("state", "launched"))
        self.tally("interventions", wave="w", task="t2")
        self.assertNotIn("counted_from", self.fields("t2"), "a row counted from its creation needs no mark")

    def test_first_spawn_records_the_runtime_facts_without_counting_a_relaunch(self) -> None:
        self.set("t1", ("state", "pending"), ("model", "planned"))
        rc, out, err = self.spawned("t1", "a1", "subagent", model="actual/high")
        self.assertEqual((rc, out, err), (0, 'BOARD SPAWNED w: "t1"\n', ""))
        fields = self.fields("t1")
        self.assertRegex(fields.pop("launched_at"), r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(fields, {"state": "launched", "model": "actual/high", "agent": "a1",
                                  "transport": "subagent", **ZERO})
        self.assertEqual(self.doc()["log"], [])

    def test_second_spawn_counts_even_when_the_transport_is_unchanged(self) -> None:
        for transport in ("cli", "subagent"):
            with self.subTest(transport=transport):
                self.set(transport, ("transport", transport), ("agent", "a1"), ("model", "planned"),
                         ("state", "launched"), ("launched_at", "2000-01-01T00:00:00Z"))
                rc, out, err = self.spawned(transport, "a2", transport)
                self.assertEqual((rc, out, err),
                                 (0, f'BOARD SPAWNED w: "{transport}"\nBOARD TALLY w: "{transport}" relaunches=1\n', ""))
                fields = self.fields(transport)
                self.assertEqual((fields["agent"], fields["transport"], fields["model"], fields["launched_at"],
                                  fields["relaunches"], fields["interventions"]),
                                 ("a2", transport, "planned", "2000-01-01T00:00:00Z", "1", "0"))
                self.assertEqual(self.doc()["log"][-1]["text"],
                                 f'{transport} relaunches=1: board spawned agent="a2" on a row launched at 2000-01-01T00:00:00Z')
        self.assertEqual(len(self.doc()["log"]), 2)

    def test_cli_to_native_finisher_counts_once_on_the_original_row(self) -> None:
        self.set("t1", ("worker", "w1-1"), ("transport", "cli"), ("state", "launched"))
        stamp = self.fields("t1")["launched_at"]
        self.set("t1", ("state", "implementing"), ("pr", "7"))
        rc, out, err = self.spawned("t1", "finisher", "subagent", model="new")
        self.assertEqual((rc, out, err), (0, 'BOARD SPAWNED w: "t1"\nBOARD TALLY w: "t1" relaunches=1\n', ""))
        fields = self.fields("t1")
        self.assertEqual(fields, {**ZERO, "worker": "w1-1", "transport": "subagent", "state": "launched",
                                  "launched_at": stamp, "pr": "7", "agent": "finisher", "model": "new", "relaunches": "1"})
        self.assertEqual(len(self.doc()["log"]), 1)
        self.assertEqual(len(self.doc()["tasks"]), 1)

    def test_spawn_refusals_publish_nothing(self) -> None:
        self.set("t1", ("state", "launched"), ("relaunches", "bad"))
        before = self.doc()
        for task, transport, reason in (("t2", "subagent", 'no task "t2"'),
                                        ("t1", "", "transport must not be blank"),
                                        ("t1", "subagent", 'holds relaunches="bad"')):
            with self.subTest(task=task, transport=transport):
                rc, out, err = self.spawned(task, "a2", transport)
                self.assertEqual((rc, out), (1, ""))
                self.assertIn(reason, err)
                self.assertEqual(self.doc(), before)

    def test_spawned_with_launch_id_replays_as_noop_and_new_id_same_agent_counts(self) -> None:
        """THE LAUNCH-ATTEMPT IDENTITY (ludics#1294): replaying a recorded ID with matching facts
        does not write or move relaunches and answers as the first call did; a new ID under the
        same agent name still counts one."""
        self.set("t1", ("state", "pending"), ("model", "planned"))
        rc, out, err = self.spawned("t1", "a1", "subagent", model="actual/high", launch_id="w-t1-1")
        self.assertEqual((rc, out, err), (0, 'BOARD SPAWNED w: "t1"\n', ""))
        fields = self.fields("t1")
        self.assertEqual((fields["launch_id"], fields["relaunches"], fields["agent"], fields["model"]),
                         ("w-t1-1", "0", "a1", "actual/high"))
        self.set("t1", ("state", "implementing"))
        before_replay = self.doc()
        with mock.patch.object(boardstore.os, "replace", side_effect=AssertionError("replay must not write")):
            rc, out, err = self.spawned("t1", "a1", "subagent", model="actual/high", launch_id="w-t1-1")
        self.assertEqual((rc, out, err), (0, 'BOARD SPAWNED w: "t1"\n', ""))
        self.assertEqual(self.doc(), before_replay, "replay preserves later state and updated_at")
        rc, out, err = self.spawned("t1", "a1", "subagent", model="actual/high", launch_id="w-t1-2")
        want_relaunch = 'BOARD SPAWNED w: "t1"\nBOARD TALLY w: "t1" relaunches=1\n'
        self.assertEqual((rc, out, err), (0, want_relaunch, ""))
        self.assertEqual((self.fields("t1")["launch_id"], self.fields("t1")["relaunches"]), ("w-t1-2", "1"))
        self.assertIn('board spawned agent="a1" launch_id=w-t1-2 on a row launched at', self.doc()["log"][-1]["text"])
        before_relaunch_replay = self.doc()
        with mock.patch.object(boardstore.os, "replace", side_effect=AssertionError("replay must not write")):
            rc, out, err = self.spawned("t1", "a1", "subagent", model="actual/high", launch_id="w-t1-2")
            self.assertEqual((rc, out, err), (0, want_relaunch, ""), "replaying a relaunch answers as the first did")
            rc2, out2, err2 = self.spawned("t1", "a1", "subagent", model="actual/high", launch_id="w-t1-1")
            self.assertEqual((rc2, out2, err2), (0, 'BOARD SPAWNED w: "t1"\n', ""), "a late replay of an earlier ID is also a no-op")
        self.assertEqual(self.doc(), before_relaunch_replay)

    def test_spawned_replay_conflicts_and_invalid_launch_ids_refuse(self) -> None:
        self.set("t1", ("state", "pending"), ("model", "planned"))
        self.assertEqual(self.spawned("t1", "a1", "subagent", model="m1", launch_id="w-t1-1")[0], 0)
        self.assertEqual(self.spawned("t1", "a1", "subagent", launch_id="w-t1-2")[0], 0)
        before = self.doc()
        conflicts: list[tuple[str, str, dict[str, str]]] = [
            ("a2", "subagent", {"model": "m1", "launch_id": "w-t1-1"}),
            ("a1", "cli", {"model": "m1", "launch_id": "w-t1-1"}),
            ("a1", "subagent", {"model": "m2", "launch_id": "w-t1-1"}),
            ("a1", "subagent", {"launch_id": "w-t1-1"}),
            ("a1", "subagent", {"model": "m1", "launch_id": "w-t1-2"}),
        ]
        for agent, transport, extra in conflicts:
            with self.subTest(agent=agent, transport=transport, extra=extra):
                rc, out, err = self.spawned("t1", agent, transport, **extra)
                self.assertEqual((rc, out), (1, ""))
                self.assertIn("with different spawn facts", err)
                self.assertEqual(self.doc(), before)
        for bad in ("", " ", "-bad", "a/b", "a b", None, 7):
            with self.subTest(launch_id=bad):
                rc, out, err = self.call("spawned", {"wave": "w", "task": "t1", "agent": "a1",
                                                     "transport": "subagent", "launch_id": bad})
                self.assertEqual((rc, out), (1, ""))
                self.assertIn("a launch_id must be", err)
                self.assertEqual(self.doc(), before)
        rc, out, err = self.set("t1", ("launch_id", "w-t1-3"), ("state", "launched"))
        self.assertEqual((rc, out), (1, ""))
        self.assertIn("launch_id is recorded by board spawned, not board set", err)
        self.assertEqual(self.doc(), before)

    def test_unkeyed_spawn_after_keyed_clears_launch_id_and_keeps_replay_history(self) -> None:
        self.set("t1", ("state", "pending"))
        self.assertEqual(self.spawned("t1", "a1", "subagent", launch_id="w-t1-1")[0], 0)
        rc, out, _ = self.spawned("t1", "a2", "subagent")
        self.assertEqual((rc, out), (0, 'BOARD SPAWNED w: "t1"\nBOARD TALLY w: "t1" relaunches=1\n'))
        self.assertNotIn("launch_id", self.fields("t1"))
        self.assertEqual(self.fields("t1")["agent"], "a2")
        before = self.doc()
        rc, out, _ = self.spawned("t1", "a1", "subagent", launch_id="w-t1-1")
        self.assertEqual((rc, out), (0, 'BOARD SPAWNED w: "t1"\n'))
        self.assertEqual(self.doc(), before, "late replay of w-t1-1 does not overwrite a2 or count again")
        self.assertEqual(self.spawned("t1", "a3", "subagent", launch_id="w-t1-2")[0], 0)
        self.assertEqual(self.fields("t1")["launch_id"], "w-t1-2")
        rc, out, _ = self.set("t1", ("agent", "a4"), ("state", "launched"))
        self.assertEqual((rc, out), (0, 'BOARD SET w: "t1" agent state\nBOARD TALLY w: "t1" relaunches=3\n'))
        self.assertNotIn("launch_id", self.fields("t1"), "a legacy set relaunch clears the previous launch_id")
        before_legacy_replay = self.doc()
        rc, out, _ = self.spawned("t1", "a3", "subagent", launch_id="w-t1-2")
        self.assertEqual((rc, out), (0, 'BOARD SPAWNED w: "t1"\nBOARD TALLY w: "t1" relaunches=2\n'))
        self.assertEqual(self.doc(), before_legacy_replay, "earlier keyed spawn still replays as a no-op after a legacy relaunch")

    def test_corrupt_spawns_record_refuses_without_overwriting(self) -> None:
        path = os.path.join(self.root, "boards", "w.json")
        self.set("t1", ("state", "pending"))
        self.assertEqual(self.spawned("t1", "a1", "subagent", launch_id="w-t1-1")[0], 0)
        with open(path, encoding="utf-8") as f:
            valid = json.load(f)
        bad_spawns: list[Any] = [
            [],
            {"-bad": {"agent": "a1", "transport": "subagent", "said": "ok"}},
            {"ok": "not-a-dict"},
            {"ok": {"agent": "a1", "transport": "subagent"}},
            {"ok": {"agent": "a1", "transport": "subagent", "said": "ok", "extra": "x"}},
            {"ok": {"agent": " ", "transport": "subagent", "said": "ok"}},
            {"ok": {"agent": "a1", "transport": "subagent", "said": ""}},
        ]
        for bad in bad_spawns:
            with self.subTest(spawns=bad):
                broken = json.loads(json.dumps(valid))
                broken["tasks"][0]["spawns"] = bad
                text = json.dumps(broken)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                rc, _, err = self.spawned("t1", "a1", "subagent", launch_id="w-t1-1")
                self.assertEqual(rc, 1)
                self.assertIn("is not a valid board", err)
                with open(path, encoding="utf-8") as f:
                    self.assertEqual(f.read(), text)

    def test_a_second_launch_counts_one_relaunch_and_a_first_launch_none(self) -> None:
        """THE RELAUNCH COUNT (ludics#1236's decision): a native respawn or a finisher is a second
        ``state=launched`` on a row the first launch stamped, one ``relaunches`` each, logged."""
        self.set("t1", ("state", "pending"), ("transport", "subagent"))
        rc, out, _ = self.set("t1", ("agent", "a1"), ("state", "launched"))
        self.assertEqual((rc, out), (0, 'BOARD SET w: "t1" agent state\n'), "a first launch counts nothing")
        self.set("t1", ("state", "implementing"), ("pr", "7"))
        self.set("t1", ("pr", "8"))
        self.assertEqual(self.fields("t1")["relaunches"], "0", "a set that names no launched state counts nothing")
        stamp = self.fields("t1")["launched_at"]
        rc, out, _ = self.set("t1", ("agent", "a2"), ("state", "Launched; a finisher from board takeover"))
        self.assertEqual((rc, out), (0, 'BOARD SET w: "t1" agent state\nBOARD TALLY w: "t1" relaunches=1\n'))
        rc, out, _ = self.set("t1", ("agent", "a3"), ("state", "launched"))
        self.assertEqual(out.splitlines()[-1], 'BOARD TALLY w: "t1" relaunches=2', "a respawn of a row still launched counts")
        fields = self.fields("t1")
        self.assertEqual((fields["relaunches"], fields["interventions"], fields["launched_at"]), ("2", "0", stamp),
                         "never an intervention, and the row keeps its first stamp")
        self.assertEqual([line["text"] for line in self.doc()["log"]],
                         [f't1 relaunches=1: state="Launched; a finisher from board takeover" on a row launched at {stamp}',
                          f't1 relaunches=2: state="launched" on a row launched at {stamp}'])
        self.set("t1", ("state", "launched"), ("relaunches", "5"))
        self.assertEqual(self.fields("t1")["relaunches"], "5", "a set that names relaunches writes its own, counting nothing")
        self.set("t2", ("transport", "subagent"), ("state", "launched"))
        self.assertEqual(self.fields("t2")["relaunches"], "0", "a row created launched is a first launch")

    def test_the_same_cli_workers_relaunch_is_the_launchs_to_count(self) -> None:
        """A CLI name launches again only through ``launch --replace``, which counts its own; any
        other change of worker or transport is a relaunch the board sees."""
        self.set("c1", ("worker", "w1-1"), ("transport", "cli"), ("state", "launched"))
        self.set("c1", ("state", "launched; replaced"))
        self.set("c2", ("worker", "w1-2"), ("state", "launched"))  # no transport: a CLI row, as a tally by worker reads it
        self.set("c2", ("state", "launched"))
        self.assertEqual((self.fields("c1")["relaunches"], self.fields("c2")["relaunches"]), ("0", "0"))
        _, out, _ = self.set("c1", ("worker", "w1-1b"), ("state", "launched"))
        self.assertEqual(out.splitlines()[-1], 'BOARD TALLY w: "c1" relaunches=1', "a CLI relaunch under a new name")
        _, out, _ = self.set("c2", ("transport", "subagent"), ("agent", "f1"), ("state", "launched"))
        self.assertEqual(out.splitlines()[-1], 'BOARD TALLY w: "c2" relaunches=1', "a native finisher of a CLI worker")
        self.set("c2", ("state", "implementing"))
        _, out, _ = self.set("c2", ("transport", "cli"), ("worker", "w1-2"), ("state", "launched"))
        self.assertEqual(out.splitlines()[-1], 'BOARD TALLY w: "c2" relaunches=2', "a row native before the set is no same CLI worker")
        self.set("c3", ("worker", "w1-3"), ("agent_host", "mac"), ("transport", "cli"), ("state", "launched"))
        self.set("c3", ("agent", "f1"), ("state", "launched"))
        self.assertEqual(self.fields("c3")["relaunches"], "0", "a native finisher that leaves the transport cli is not seen")
        _, out, _ = self.set("c3", ("agent_host", "rog"), ("state", "launched"))
        self.assertEqual(out.splitlines()[-1], 'BOARD TALLY w: "c3" relaunches=1', "the same name on another box")

    def test_a_relaunch_on_an_older_row_says_its_count_is_partial_or_refuses(self) -> None:
        self.set("t1", ("transport", "subagent"), ("state", "launched"))
        doc = self.doc()
        fields = doc["tasks"][0]["fields"]
        del fields["relaunches"]  # a row made after ludics#1214 and before ludics#1236
        with open(os.path.join(self.root, "boards", "w.json"), "w") as f:
            json.dump(doc, f)
        self.set("t1", ("state", "launched"))
        fields = self.fields("t1")
        self.assertEqual(fields["relaunches"], "1")
        self.assertRegex(fields["relaunches_from"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertNotIn("counted_from", fields, "its other counts were measured from its start")
        self.set("t1", ("relaunches", "x"))
        before = self.doc()
        rc, out, err = self.set("t1", ("state", "launched"))
        self.assertEqual((rc, out), (1, ""))
        self.assertIn('holds relaunches="x", no count; nothing counted', err)
        self.assertEqual(self.doc(), before, "a set whose count refuses writes nothing")

    def test_a_tally_by_worker_counts_a_relaunch_on_the_cli_row(self) -> None:
        done = list(takeover.DONE_STATES)
        self.set("t1", ("worker", "w1-42"), ("agent_host", "mac"), ("state", "reviewing"))
        rc, out, _ = self.tally("relaunches", "launch --replace mac/w1-42", worker="w1-42", hosts=["mac"], done=done)
        self.assertEqual((rc, out), (0, 'BOARD TALLY w: "t1" relaunches=1\n'))
        self.assertEqual(self.doc()["log"][-1]["text"], "t1 relaunches=1: launch --replace mac/w1-42")
        self.assertEqual(self.fields("t1")["interventions"], "0")

    def test_tally_with_turn_id_replays_as_noop_and_new_id_counts(self) -> None:
        """THE TURN IDENTITY (ludics#1342): replaying a recorded turn_id with matching facts writes
        nothing, leaves counters/log/updated_at untouched, and answers as the first call did; a new
        turn_id or unkeyed call counts one."""
        self.set("t1", ("state", "launched"))
        real_replace = os.replace
        replaces: list[str] = []

        def counting(src: str, dst: str) -> None:
            replaces.append(str(dst))
            real_replace(src, dst)

        with mock.patch.object(boardstore.os, "replace", counting):
            rc, out, err = self.tally("interventions", 'message "fix line 1"', wave="w", task="t1", turn_id="w-t1-1")
        self.assertEqual((rc, out, err), (0, 'BOARD TALLY w: "t1" interventions=1\n', ""))
        self.assertEqual(len(replaces), 1, "counter, log, and turn_id record publish atomically in one replace")
        self.set("t1", ("state", "implementing"))
        before_replay = self.doc()
        with mock.patch.object(boardstore.os, "replace", side_effect=AssertionError("replay must not write")):
            rc, out, err = self.tally("interventions", 'message "fix line 1"', wave="w", task="t1", turn_id="w-t1-1")
        self.assertEqual((rc, out, err), (0, 'BOARD TALLY w: "t1" interventions=1\n', ""))
        self.assertEqual(self.doc(), before_replay, "replay preserves later state, log, counter and updated_at")
        rc, out, err = self.tally("interventions", 'message "fix line 1"', wave="w", task="t1", turn_id="w-t1-2")
        self.assertEqual((rc, out, err), (0, 'BOARD TALLY w: "t1" interventions=2\n', ""))
        rc, out, err = self.tally("routine_answers", 'message "REVIEW_POSTED 1"', wave="w", task="t1", turn_id="w-t1-3")
        self.assertEqual((rc, out, err), (0, 'BOARD TALLY w: "t1" routine_answers=1\n', ""))
        self.assertEqual(len(self.doc()["log"]), 2, "routine_answers still logs nothing")
        before_late = self.doc()
        with mock.patch.object(boardstore.os, "replace", side_effect=AssertionError("replay must not write")):
            self.assertEqual(self.tally("routine_answers", 'message "REVIEW_POSTED 1"', wave="w", task="t1", turn_id="w-t1-3"),
                             (0, 'BOARD TALLY w: "t1" routine_answers=1\n', ""))
            self.assertEqual(self.tally("interventions", 'message "fix line 1"', wave="w", task="t1", turn_id="w-t1-1"),
                             (0, 'BOARD TALLY w: "t1" interventions=1\n', ""), "late replay of an earlier turn_id is a no-op")
        self.assertEqual(self.doc(), before_late)
        self.assertEqual(self.tally("interventions", 'message "unkeyed"', wave="w", task="t1"),
                         (0, 'BOARD TALLY w: "t1" interventions=3\n', ""), "unkeyed tally counts one as before")
        before_after_unkeyed = self.doc()
        with mock.patch.object(boardstore.os, "replace", side_effect=AssertionError("replay must not write")):
            self.assertEqual(self.tally("interventions", 'message "fix line 1"', wave="w", task="t1", turn_id="w-t1-2"),
                             (0, 'BOARD TALLY w: "t1" interventions=2\n', ""), "unkeyed tally retains replay history")
        self.assertEqual(self.doc(), before_after_unkeyed)

    def test_tally_replay_conflicts_and_invalid_turn_ids_refuse(self) -> None:
        self.set("t1", ("state", "launched"))
        digest_a, digest_b = "a" * 64, "b" * 64
        self.assertEqual(self.tally("interventions", 'message "a"', wave="w", task="t1", turn_id="w-t1-1",
                                    message_sha256=digest_a)[0], 0)
        self.assertEqual(self.tally("routine_answers", 'message "b"', wave="w", task="t1", turn_id="w-t1-2")[0], 0)
        before = self.doc()
        conflicts: list[tuple[str, str, dict[str, Any]]] = [
            ("routine_answers", 'message "a"', {"turn_id": "w-t1-1", "message_sha256": digest_a}),
            ("interventions", 'message "other"', {"turn_id": "w-t1-1", "message_sha256": digest_a}),
            ("interventions", 'message "a"', {"turn_id": "w-t1-1", "message_sha256": digest_b}),
            ("interventions", 'message "a"', {"turn_id": "w-t1-1"}),
            ("routine_answers", 'message "b"', {"turn_id": "w-t1-2", "message_sha256": digest_a}),
            ("interventions", 'message "b"', {"turn_id": "w-t1-2"}),
        ]
        for counter, why, extra in conflicts:
            with self.subTest(counter=counter, why=why, extra=extra):
                rc, out, err = self.tally(counter, why, wave="w", task="t1", **extra)
                self.assertEqual((rc, out), (1, ""))
                self.assertIn("with different tally facts; nothing written", err)
                self.assertEqual(self.doc(), before)
        for bad in ("", " ", "-bad", "a/b", "a b", None, 7):
            with self.subTest(turn_id=bad):
                rc, out, err = self.tally("interventions", "x", wave="w", task="t1", turn_id=bad)
                self.assertEqual((rc, out), (1, ""))
                self.assertIn("a turn_id must be", err)
                self.assertEqual(self.doc(), before)
        for bad_sha in ("", "abc", "A" * 64, "g" * 64, None, 7):
            with self.subTest(message_sha256=bad_sha):
                rc, out, err = self.tally("interventions", "x", wave="w", task="t1", turn_id="w-t1-3",
                                          message_sha256=bad_sha)
                self.assertEqual((rc, out), (1, ""))
                self.assertIn("must be 64 lowercase hex digits", err)
                self.assertEqual(self.doc(), before)
        rc, out, err = self.tally("interventions", "x", wave="w", task="t1", message_sha256=digest_a)
        self.assertEqual((rc, out), (1, ""))
        self.assertIn("message_sha256 requires turn_id", err)
        self.assertEqual(self.doc(), before)
        self.set("t1", ("interventions", "bad"))
        before_bad = self.doc()
        rc, out, err = self.tally("interventions", "x", wave="w", task="t1", turn_id="w-t1-4")
        self.assertEqual((rc, out), (1, ""))
        self.assertIn('holds interventions="bad", no count', err)
        self.assertEqual(self.doc(), before_bad, "a failed counter bump never records turn_id")

    def test_corrupt_tallies_record_refuses_without_overwriting(self) -> None:
        path = os.path.join(self.root, "boards", "w.json")
        self.set("t1", ("state", "launched"))
        self.assertEqual(self.tally("interventions", "x", wave="w", task="t1", turn_id="w-t1-1")[0], 0)
        with open(path, encoding="utf-8") as f:
            valid = json.load(f)
        bad_tallies: list[Any] = [
            [],
            {"-bad": {"counter": "interventions", "why": "x", "said": "ok"}},
            {"ok": "not-a-dict"},
            {"ok": {"counter": "interventions", "why": "x"}},
            {"ok": {"counter": "interventions", "why": "x", "said": "ok", "extra": "y"}},
            {"ok": {"counter": "rounds", "why": "x", "said": "ok"}},
            {"ok": {"counter": "interventions", "why": 7, "said": "ok"}},
            {"ok": {"counter": "interventions", "why": "x", "said": " "}},
            {"ok": {"counter": "interventions", "why": "x", "said": "ok", "message_sha256": "short"}},
        ]
        for bad in bad_tallies:
            with self.subTest(tallies=bad):
                broken = json.loads(json.dumps(valid))
                broken["tasks"][0]["tallies"] = bad
                text = json.dumps(broken)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                rc, _, err = self.tally("interventions", "x", wave="w", task="t1", turn_id="w-t1-1")
                self.assertEqual(rc, 1)
                self.assertIn("is not a valid board", err)
                with open(path, encoding="utf-8") as f:
                    self.assertEqual(f.read(), text)

    def test_tally_by_worker_refuses_turn_id_and_message_sha256(self) -> None:
        done = list(takeover.DONE_STATES)
        self.set("t1", ("worker", "w1-42"), ("agent_host", "mac"), ("state", "launched"))
        before = self.doc()
        for extra in ({"turn_id": "w-t1-1"}, {"message_sha256": "a" * 64},
                      {"turn_id": "w-t1-1", "message_sha256": "a" * 64}):
            with self.subTest(extra=extra):
                rc, out, err = self.tally("interventions", "x", worker="w1-42", hosts=["mac"], done=done, **extra)
                self.assertEqual((rc, out), (1, ""))
                self.assertIn("turn_id requires an explicit wave and task", err)
                self.assertEqual(self.doc(), before)


class Classify(unittest.TestCase):
    """tally.py's closed list: the message classifies itself, by its first non-blank line's leading words."""

    def test_every_recognised_form_is_routine_and_anything_else_an_intervention(self) -> None:
        for marker in tally.ROUTINE:
            self.assertEqual(tally.classify(f"\n  \n{marker} 12 abc\nprose\n")[0], "routine_answers", marker)
            self.assertEqual(tally.classify(f"{marker}\n")[0], "routine_answers", marker)
        for text in ("", "\n \n", "REVIEW_POSTEDX 1 a", "review_posted 1 a", "`REVIEW_POSTED 1 a`", "MERGE 1 a",
                     "MERGE NOT 1", "Answer to your PLAN_ESCALATION: do A", "continue\nREVIEW_POSTED 1 a",
                     "EXECUTION_REQUEST", "PLAN_READY", "EXECUTION_RESULT {}"):
            self.assertEqual(tally.classify(text)[0], "interventions", repr(text))

    def test_a_windows_witness_result_is_a_routine_answer(self) -> None:
        self.assertEqual(tally.classify("WINDOWS_WITNESS_RESULT w-t-windows-1\npass\ntranscript")[0], "routine_answers")
        for text in ("WINDOWS_WITNESS_REQUEST", "WINDOWS_WITNESS_RESULTX", "continue\nWINDOWS_WITNESS_RESULT"):
            self.assertEqual(tally.classify(text)[0], "interventions", repr(text))

    def test_kill_and_interrupt_are_interventions_whatever_the_message(self) -> None:
        self.assertEqual(tally.classify("REVIEW_POSTED 1 a", kill=True), ("interventions", 'unstick --kill ("REVIEW_POSTED 1 a")'))
        self.assertEqual(tally.classify("", interrupt=True), ("interventions", "unstick --interrupt (no message)"))
        self.assertEqual(tally.classify("x" * 200)[1], json.dumps("x" * tally.SHOWN + "..."))

    def test_every_message_the_driver_sends_is_routine(self) -> None:
        """The driver's resumes all go through unstick, so its answers are counted only if each message it can
        send classifies as routine: built here by the very code that writes them."""
        call = mock.Mock(kind="at-open", pr=7, sha="a" * 40, wave=mock.Mock(repository="o/r"))
        messages: list[str] = []
        for kind, blocks in (("at-open", True), ("at-open", False), ("confirm", True), ("confirm", False)):
            call.kind = kind
            messages.append(wavereview.message_of(call, mock.Mock(line="VERDICT: x", blocks=blocks), "https://x"))
        block = {"request_id": "r-1", "kind": "correctness", "execution_host": "mac", "checkout": "/w"}
        messages.append(assign.assignment_text(block, "true", "b" * 40) + "\n\n" + assign.assignment_text(block, "true", "c" * 40))
        self.assertEqual([m.split()[0] for m in messages][:4], ["REVIEW_POSTED", "REVIEW_POSTED", "MERGE", "MERGE"])
        for message in messages:
            self.assertEqual(tally.classify(message)[0], "routine_answers", message[:60])
        # The result answer is the driver's own concluded.md, classified where it is written: test_fleetworker_wave's
        # conclude case.

    def test_said_keeps_only_the_tallys_own_lines(self) -> None:
        self.assertEqual(tally.said("RESUMED x\nBOARD TALLY w: \"t\" routine_answers=1\n"), "")
        self.assertEqual(tally.said("x\n BOARD TALLY NOTE: no row\nBOARD TALLY WARNING h/w: y\n"),
                         "; BOARD TALLY NOTE: no row; BOARD TALLY WARNING h/w: y")


class TallyVerbs(StoreCase):
    """``board tally`` and unstick's own tally, their anchor call run through the store here."""

    def setUp(self) -> None:
        super().setUp()
        self.cfg = load_config(os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh"), {
            "FLEET_ANCHOR": "local", "FLEET_ANCHOR_STATE": self.root, "FLEET_SKILLS_REPO": CHECKOUT,
            "FLEET_BOXES": "local", "PATH": os.environ.get("PATH", ""), "HOME": self.root,
        }, host="testbox")
        self.set("t1", ("worker", "w1-42"), ("agent_host", "testbox"), ("state", "launched"))
        self.message = os.path.join(self.root, "msg.md")
        self.payloads: list[dict[str, Any]] = []

    def mutate(self, _cfg: Any, action: str, raw: str, *, stdout_to_stderr: bool = False) -> Done:
        self.payloads.append(json.loads(raw))
        rc, out, err = self.call(action, json.loads(raw))
        if stdout_to_stderr:
            sys.stderr.write(out + err)
        else:
            sys.stdout.write(out)
            sys.stderr.write(err)
        return Done(rc, "")

    def run_verb(self, fn: Any, *args: Any, **kw: Any) -> tuple[Any, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(tally, "mutate", self.mutate), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = fn(*args, **kw)
            except cli.Exit as exc:
                rc = exc.rc
        return rc, out.getvalue(), err.getvalue()

    def write(self, text: str) -> None:
        with open(self.message, "w") as f:
            f.write(text)

    def test_board_tally_classifies_the_native_message(self) -> None:
        self.write("REVIEW_POSTED 7 " + "a" * 40 + "\n...")
        self.assertEqual(self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--message", self.message])[:2],
                         (0, 'BOARD TALLY w: "t1" routine_answers=1\n'))
        self.write("Your plan's step 3 is wrong: read #1210 first.\n")
        self.assertEqual(self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--message", self.message])[:2],
                         (0, 'BOARD TALLY w: "t1" interventions=1\n'))
        self.assertEqual(self.doc()["log"][-1]["text"], 't1 interventions=1: message "Your plan\'s step 3 is wrong: read #1210 first."')
        for args in (["tally", "w", "t1"], ["tally", "w", "t1", "--message", self.root], ["tally", "w", "t1", "-m", self.message]):
            self.assertEqual(self.run_verb(board.cmd_board, self.cfg, args)[0], 2, args)

    def test_board_tally_with_turn_id_replays_as_noop_and_refuses_conflicts(self) -> None:
        self.write("REVIEW_POSTED 7 " + "a" * 40 + "\nVerdict: ok\n")
        self.assertEqual(
            self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--message", self.message, "--turn-id", "w-t1-1"])[:2],
            (0, 'BOARD TALLY w: "t1" routine_answers=1\n'),
        )
        before = self.doc()
        with mock.patch.object(boardstore.os, "replace", side_effect=AssertionError("replay must not write")):
            self.assertEqual(
                self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--turn-id", "w-t1-1", "--message", self.message])[:2],
                (0, 'BOARD TALLY w: "t1" routine_answers=1\n'),
                "reversed option order and identical message bytes replay as a no-op",
            )
        self.assertEqual(self.doc(), before)
        self.write("Continue\nStep A\n")
        self.assertEqual(
            self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--message", self.message, "--turn-id", "w-t1-2"])[:2],
            (0, 'BOARD TALLY w: "t1" interventions=1\n'),
        )
        before_conflict = self.doc()
        self.write("Continue\nStep B\n")
        rc, out, err = self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--message", self.message, "--turn-id", "w-t1-2"])
        self.assertEqual((rc, out), (1, ""))
        self.assertIn("with different tally facts; nothing written", err, "same first line with different body still conflicts")
        self.assertEqual(self.doc(), before_conflict)
        self.assertEqual(
            self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--message", self.message, "--turn-id", "w-t1-3"])[:2],
            (0, 'BOARD TALLY w: "t1" interventions=2\n'),
            "a distinct turn_id counts one more",
        )
        self.assertEqual(
            self.run_verb(board.cmd_board, self.cfg, ["tally", "w", "t1", "--message", self.message])[:2],
            (0, 'BOARD TALLY w: "t1" interventions=3\n'),
            "omitting --turn-id behaves as before",
        )
        self.assertNotIn("turn_id", self.payloads[-1])
        self.assertNotIn("message_sha256", self.payloads[-1])
        bad_cli = (
            ["tally", "w", "t1", "--turn-id", "w-t1-9"],
            ["tally", "w", "t1", "--message", self.message, "--turn-id"],
            ["tally", "w", "t1", "--message", self.message, "--turn-id", "w-t1-9", "--turn-id", "w-t1-10"],
            ["tally", "w", "t1", "--message", self.message, "--message", self.message],
            ["tally", "w", "t1", "--message", self.message, "--turn-id", "-bad"],
            ["tally", "w", "t1", "--message", self.message, "--turn-id", "a/b"],
            ["tally", "w", "t1", "--message", self.message, "--turn-id", "a b"],
            ["tally", "w", "t1", "--message", self.message, "--turn-id", ""],
            ["tally", "w", "t1", "--message", self.message, "--extra", "x"],
        )
        for args in bad_cli:
            with self.subTest(args=args):
                self.assertEqual(self.run_verb(board.cmd_board, self.cfg, args)[0], 2)

    def test_unstick_counts_by_worker_on_stderr_and_a_failure_is_a_warning(self) -> None:
        self.write("PEER_PLAN /x/peer-plan.md\n")
        rc, out, err = self.run_verb(tally.after_unstick, self.cfg, "testbox", "w1-42", self.message, kill=False, interrupt=False)
        self.assertEqual((rc, out, err), (None, "", 'BOARD TALLY w: "t1" routine_answers=1\n'))
        with mock.patch.object(tally, "spellings", return_value=["local", "testbox"]) as named:
            self.run_verb(tally.after_unstick, self.cfg, "local", "w1-42", self.message, kill=False, interrupt=False)
        named.assert_called_once_with(self.cfg, "local")
        self.assertEqual(self.payloads[-1]["hosts"], ["local", "testbox"], "the row is found by every spelling of the box")
        self.run_verb(tally.after_unstick, self.cfg, "testbox", "w1-42", "", kill=False, interrupt=True)
        self.assertEqual((self.fields_of()["interventions"], self.fields_of()["routine_answers"]), ("1", "2"))
        with mock.patch.object(tally, "mutate", return_value=Done(1, "")), contextlib.redirect_stderr(io.StringIO()) as err2:
            tally.after_unstick(self.cfg, "testbox", "w1-42", self.message, kill=False, interrupt=False)
        self.assertIn("BOARD TALLY WARNING testbox/w1-42: the unstick reached the worker, and its turn was not counted (board"
                      " exit 1)", err2.getvalue())
        with mock.patch.object(tally, "mutate", side_effect=SystemExit(2)), contextlib.redirect_stderr(io.StringIO()) as err3:
            tally.after_unstick(self.cfg, "testbox", "w1-42", self.message, kill=False, interrupt=False)
        self.assertIn("BOARD TALLY WARNING testbox/w1-42", err3.getvalue(), "an identity refusal never ends the unstick")

    def test_the_box_is_looked_up_by_every_spelling_a_row_may_give_it(self) -> None:
        """A wave file may name its agent host ``local`` or by its fleet name, and prep writes it as given."""
        here, bare = mock.Mock(local_box="mac-studio"), mock.Mock(local_box="")
        self.assertEqual(tally.spellings(here, "local"), ["local", "mac-studio"])
        self.assertEqual(tally.spellings(here, "mac-studio"), ["mac-studio", "local"])
        self.assertEqual(tally.spellings(here, "rog"), ["rog"])
        self.assertEqual(tally.spellings(bare, "local"), ["local"])
        self.set("t2", ("worker", "w1-77"), ("agent_host", "local"), ("state", "launched"))
        cfg = load_config(os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh"), {
            "FLEET_ANCHOR": "local", "FLEET_ANCHOR_STATE": self.root, "FLEET_SKILLS_REPO": CHECKOUT,
            "FLEET_BOXES": "local", "FLEET_LOCAL_BOX": "testbox", "PATH": os.environ.get("PATH", ""), "HOME": self.root,
        }, host="testbox")
        _, _, err = self.run_verb(tally.after_unstick, cfg, "testbox", "w1-77", "", kill=True, interrupt=False)
        self.assertEqual(err, 'BOARD TALLY w: "t2" interventions=1\n', "a row prep wrote as agent_host=local is this box's")

    def test_launch_replace_counts_a_relaunch_only_when_it_replaced_a_record(self) -> None:
        """``launch --replace`` (ludics#1236): one ``relaunches`` on the CLI row when the far side
        archived a record under the launch's stamp, nothing for a --replace that found none."""
        cfg = load_config(os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh"), {
            "FLEET_ANCHOR": "local", "FLEET_ANCHOR_STATE": self.root, "FLEET_SKILLS_REPO": CHECKOUT,
            "FLEET_BOXES": "local", "PATH": os.environ.get("PATH", ""), "HOME": self.root,
            "ISSUE_WAVE_STATE": os.path.join(self.root, "state"),
        }, host="testbox")
        self.set("t2", ("worker", "w1-77"), ("agent_host", "local"), ("state", "implementing"))
        replaced = os.path.join(self.root, "state", "replaced")
        os.makedirs(os.path.join(replaced, "w1-77-20261119T100000Z-1"))
        self.assertEqual(self.run_verb(tally.after_replace, cfg, "local", "w1-77", "20261119T100000Z-2"), (None, "", ""),
                         "no record archived under this launch's stamp: a first launch, counted nowhere")
        rc, out, err = self.run_verb(tally.after_replace, cfg, "local", "w1-77", "20261119T100000Z-1")
        self.assertEqual((rc, out, err), (None, "", 'BOARD TALLY w: "t2" relaunches=1\n'))
        self.assertEqual(self.doc()["log"][-1]["text"], "t2 relaunches=1: launch --replace local/w1-77")
        with open(os.path.join(replaced, "w1-77-odd"), "w") as f:
            f.write("")
        _, _, err = self.run_verb(tally.after_replace, cfg, "local", "w1-77", "odd")
        self.assertIn("BOARD TALLY WARNING local/w1-77: the launch exited 0, and whether it replaced a record could not be"
                      " read (exit 2)", err)
        with mock.patch.object(tally, "run_on", return_value=Done(255, "")):
            _, _, err = self.run_verb(tally.after_replace, cfg, "local", "w1-77", "20261119T100000Z-1")
        self.assertIn("could not be read (exit 255)", err, "a box that does not answer is no first launch")
        with mock.patch.object(tally, "run_on", return_value=Done(0, "")), mock.patch.object(tally, "mutate", return_value=Done(1, "")), \
                contextlib.redirect_stderr(io.StringIO()) as err2:
            tally.after_replace(cfg, "local", "w1-77", "x")
        self.assertIn("BOARD TALLY WARNING local/w1-77: the launch replaced a record, and its relaunch was not counted (board"
                      " exit 1)", err2.getvalue())
        self.assertEqual(self.doc()["tasks"][1]["fields"]["relaunches"], "1")

    def fields_of(self) -> dict[str, str]:
        return self.doc()["tasks"][0]["fields"]


class CommandLine(unittest.TestCase):
    def payload(self, *args: str) -> tuple[str, dict[str, object]]:
        return board.payload_of(list(args))

    def refused(self, *args: str) -> str:
        with self.assertRaises(cli.Exit) as caught:
            board.payload_of(list(args))
        self.assertEqual(caught.exception.rc, 2)
        return caught.exception.message

    def test_a_field_splits_at_its_first_equals_sign(self) -> None:
        self.assertEqual(
            self.payload("set", "--create", "w", "ll#1", "state=a=b", "pr="),
            ("set", {"wave": "w", "create": True, "new_row": False, "task": "ll#1", "fields": [["state", "a=b"], ["pr", ""]]}),
        )

    def test_spawned_takes_named_runtime_facts(self) -> None:
        self.assertEqual(
            self.payload("spawned", "w", "ll#1", "--model", "model/high", "--transport", "subagent", "--agent", "a=b"),
            ("spawned", {"wave": "w", "task": "ll#1", "model": "model/high", "transport": "subagent", "agent": "a=b"}),
        )
        self.assertEqual(
            self.payload("spawned", "w", "ll#1", "--agent", "a1", "--transport", "subagent", "--launch-id", "w-ll.1_a"),
            ("spawned", {"wave": "w", "task": "ll#1", "agent": "a1", "transport": "subagent", "launch_id": "w-ll.1_a"}),
        )

    def test_spawned_refuses_missing_and_repeated_options(self) -> None:
        for options in ((), ("--agent", "a"), ("--transport", "subagent"), ("--agent", "--transport", "subagent"),
                        ("--agent", "a", "--transport", "subagent", "--agent", "b"),
                        ("--agent", "a", "--transport", "subagent", "--model"),
                        ("--agent", "a", "--transport", "subagent", "--launch-id"),
                        ("--agent", "a", "--transport", "subagent", "--launch-id", "x", "--launch-id", "y"),
                        ("--agent", "a", "--transport", "subagent", "--launch-id", " "),
                        ("--agent", "a", "--transport", "subagent", "--new-row")):
            with self.subTest(options=options):
                self.assertIn("board spawned: expected", self.refused("spawned", "w", "t", *options))
        for bad in ("-bad", "a/b", "a b", "a:b"):
            with self.subTest(launch_id=bad):
                self.assertIn("board spawned: --launch-id must be",
                              self.refused("spawned", "w", "t", "--agent", "a", "--transport", "subagent", "--launch-id", bad))

    def test_new_row_is_sets_alone_and_read_with_create_in_either_order(self) -> None:
        for flags in (["--create", "--new-row"], ["--new-row", "--create"]):
            got = self.payload("set", *flags, "w", "t", "k=v")[1]
            self.assertEqual((got["create"], got["new_row"]), (True, True), flags)
        self.assertEqual(self.payload("set", "--new-row", "w", "t", "k=v")[1],
                         {"wave": "w", "create": False, "new_row": True, "task": "t", "fields": [["k", "v"]]})
        self.assertIn("board note: takes no --new-row", self.refused("note", "--new-row", "w", "k=v"))
        self.assertIn("board log: takes no --new-row", self.refused("log", "--new-row", "w", "x"))
        self.assertEqual(self.payload("set", "--new-row", "--new-row", "t", "k=v")[1]["wave"], "--new-row",
                         "a flag is read once; a second is the wave, which the store's grammar refuses")
        self.assertIn('expected <key>=<value>, got "--new-row"', self.refused("set", "w", "t", "k=v", "--new-row"))

    def test_create_is_read_only_right_after_the_action(self) -> None:
        self.assertEqual(self.payload("log", "w", "--create", "x")[1], {"wave": "w", "text": "--create x"})
        self.assertIn("board log: takes no --create", self.refused("log", "--create", "w", "x"))
        self.assertIn("expected <key>=<value>, got \"--create\"", self.refused("set", "w", "t", "k=v", "--create"))

    def test_usage_refusals(self) -> None:
        self.assertIn("expected set, spawned, note, log, show, check, takeover, close or tally", self.refused())
        self.assertIn("board show: expected <wave> [--json]", self.refused("show"))
        self.assertIn("board show: expected <wave> [--json]", self.refused("show", "w", "--md"))
        self.assertIn("board set: expected <task>", self.refused("set", "w"))
        self.assertIn("board set: give at least one", self.refused("set", "w", "t"))
        self.assertIn("board note: give at least one", self.refused("note", "--create", "w"))
        self.assertIn("board log: expected the line's text", self.refused("log", "w"))
        self.assertEqual(self.payload("show", "w", "--json"), ("show", {"wave": "w", "json": True}))


class StateGrammar(unittest.TestCase):
    """THE STATE WORDS (takeover's header, ludics#810): set's warnings and the close-out check."""

    def test_a_state_word_is_the_first_word_without_case_or_trailing_punctuation(self) -> None:
        for value, word in (("merged", "merged"), ("MERGED #812 at abc", "merged"), ("done; handed back", "done"),
                            ("Launched.", "launched"), ("reviewing round 3", "reviewing")):
            self.assertEqual(takeover.state_word(value), word, value)
        for value in ("", "  ", "done-merged", "not launched", "spawned", "#812 merged", "merged!"):
            self.assertIsNone(takeover.state_word(value), value)
        self.assertFalse(set(takeover.LIVE_STATES) & set(takeover.DONE_STATES))

    def test_set_warns_on_status_and_on_a_state_with_no_state_word(self) -> None:
        self.assertEqual(board.warnings_of("t", [["state", "merged #9"], ["pr", "9"]]), [])
        got = board.warnings_of("ll#1", [["status", "merged"], ["state", "spawned\nx"], ["state", "launched"]])
        self.assertEqual(len(got), 2, got)
        self.assertEqual(got[0], 'BOARD WARNING: task "ll#1": a row\'s state is its state key, not status; written as given')
        self.assertTrue(got[1].startswith('BOARD WARNING: task "ll#1": state="spawned\\nx" starts with no state word'
                                          " (live pending, launched,"), got[1])
        self.assertTrue(got[1].endswith("done merged, done, closed, dropped); written as given"), got[1])


class Check(unittest.TestCase):
    """``board check`` end to end on this box: the anchor ``local`` over a scratch state root."""

    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-board-check-test."))
        self.cfg = load_config(os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh"), {
            "FLEET_ANCHOR": "local", "FLEET_ANCHOR_STATE": self.root, "FLEET_SKILLS_REPO": CHECKOUT,
            "FLEET_BOXES": "local", "PATH": os.environ.get("PATH", ""), "HOME": self.root,
        }, host="testbox")

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def row(self, task: str, **fields: str) -> None:
        payload = {"wave": "w", "create": True, "new_row": True, "task": task, "fields": [[k, v] for k, v in fields.items()]}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(boardstore.run(["-", self.root, "set", "coord", json.dumps(payload)]), 0)

    def check(self, wave: str = "w") -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("ludics.fleetworker.board.check_identity") as identity, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = board.cmd_board(self.cfg, ["check", wave])
            except cli.Exit as exc:
                rc = exc.rc
        identity.assert_not_called()  # a read: no lease, no identity
        return rc, out.getvalue(), err.getvalue()

    def test_every_row_done_exits_0(self) -> None:
        self.row("a", state="merged #1")
        self.row("b", status="done")              # a board before #810: status read on a row with no state
        self.row("c", state="Closed.", status="launched")  # state wins over status
        self.row("d", state="dropped (out of scope)")
        rc, out, err = self.check()
        self.assertEqual((rc, out, err), (0, "BOARD CHECK w: 4 rows, 4 done, 0 not done\n", ""))

    def test_a_row_not_done_is_listed_and_exits_3(self) -> None:
        self.row("a", state="merged")
        self.row("b", status="launched")          # the rows wave-20261021's close-out left
        self.row("c", state="done-merged")        # no state word: an allowlist, so not done
        self.row("d", pr="4")                     # no state at all
        self.row("e", state="reviewing", status="merged")
        rc, out, _ = self.check()
        self.assertEqual(rc, 3)
        lines = out.splitlines()
        self.assertEqual(lines[0], "BOARD CHECK w: 5 rows, 1 done, 4 not done")
        self.assertEqual(lines[1], '- "b": status="launched" (live)')
        self.assertTrue(lines[2].startswith('- "c": state="done-merged" (no state word: live pending,'), lines[2])
        self.assertEqual(lines[3:], ['- "d": no state', '- "e": state="reviewing" (live)'])

    def test_check_reads_done_as_the_phase_status_json_prints(self) -> None:
        """THE PHASE is check's source (takeover's header, ludics#1165): every row check calls done is
        one whose phase is a done word, and no other."""
        rows = {"a": {"state": "MERGED 37a9539b; issue closed;"}, "b": {"status": "done"}, "c": {"state": "closed"},
                "d": {"state": "dropped (scope)"}, "e": {"state": "done-merged", "merge": "0123abcd"},
                "f": {"state": "pending"}, "g": {"pr": "4"}, "h": {"state": ""}, "i": {"state": "blocked", "status": "merged"}}
        for task, fields in rows.items():
            self.row(task, **fields)
        rc, out, _ = self.check()
        left = {line.split('"')[1] for line in out.splitlines()[1:]}
        self.assertEqual(rc, 3)
        self.assertEqual(left, {t for t, f in rows.items() if takeover.phase_of(f) not in takeover.DONE_STATES})
        self.assertEqual(left, {"e", "f", "g", "h", "i"})

    def test_an_empty_board_is_done_and_no_board_refuses(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(boardstore.run(["-", self.root, "note", "coord", json.dumps(
                {"wave": "w", "create": True, "fields": [["scope", "x"]]})]), 0)
        self.assertEqual(self.check()[:2], (0, "BOARD CHECK w: 0 rows, 0 done, 0 not done\n"))
        self.assertEqual(self.check("none")[:2], (1, ""))  # the store's refusal is the far side's stderr
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(board.cmd_board(self.cfg, ["show", "none"]), boardstore.NO_BOARD_EXIT,
                             "show end to end: the store's exit is the verb's")
            self.assertEqual(board.cmd_board(self.cfg, ["show", "w"]), 0)

    def test_usage(self) -> None:
        with self.assertRaises(cli.Exit) as caught:
            board.cmd_board(self.cfg, ["check"])
        self.assertEqual(caught.exception.rc, 2)
        self.assertIn("board check: expected <wave>", caught.exception.message)


if __name__ == "__main__":
    unittest.main()
