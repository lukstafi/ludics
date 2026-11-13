"""ludics.fleetworker.boardstore (the shipped store, imported: main does not run on import) and
ludics.fleetworker.board's command-line reading."""

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import board, boardstore, takeover
from ludics.fleetworker.config import load_config

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# The cell texts that broke `sed` on the OCANNL wave-20261014 board, and the rest of the shell's and
# markdown's metacharacters.
HOSTILE = "a|b (c) #d /e `f` $(g) 'q' \"dq\" s/x/y/g \\ & * [x](y) <br> ü"


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


class Store(StoreCase):
    def test_a_writer_refuses_an_unknown_wave_unless_create(self) -> None:
        rc, out, err = self.set("t", ("k", "v"), create=False)
        self.assertEqual((rc, out), (1, ""))
        self.assertEqual(err, "BOARD REFUSED: no board for wave w on the anchor (start it with set or note --create)\n")
        self.assertFalse(os.path.exists(os.path.join(self.root, "boards")))
        self.assertEqual(self.set("t", ("k", "v"))[0], 0)
        self.assertEqual(self.set("t", ("k", "w"))[0], 0, "create on an existing board is no refusal")
        self.assertEqual(self.doc()["tasks"][0]["fields"], {"k": "w"})
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
        self.assertEqual(fields, {"worker": "wk", "exec_hosts": "mac,gpu", "farside": "gpu:/leg", "state": "launched"})
        before = self.doc()
        self.assertEqual(self.call("placement", {**payload, "worker": "absent"})[0], 0)
        self.assertEqual(self.doc(), before)
        self.set("t2", ("worker", "wk"))
        before = self.doc()
        self.assertEqual(self.call("placement", payload)[0], 1)
        self.assertEqual(self.doc(), before, "an ambiguous identity writes nothing")

    def test_hostile_text_round_trips_in_every_field(self) -> None:
        self.assertEqual(self.set(HOSTILE, ("state", HOSTILE), ("multi", "one\ntwo"))[0], 0)
        self.assertEqual(self.call("note", {"wave": "w", "fields": [["scope", HOSTILE]]})[0], 0)
        self.assertEqual(self.call("log", {"wave": "w", "text": HOSTILE})[0], 0)
        doc = self.doc()
        self.assertEqual(doc["tasks"][0]["task"], HOSTILE)
        self.assertEqual(doc["tasks"][0]["fields"], {"state": HOSTILE, "multi": "one\ntwo"})
        self.assertEqual(doc["notes"], {"scope": HOSTILE})
        self.assertEqual([(line["by"], line["text"]) for line in doc["log"]], [("coord", HOSTILE)])

    def test_rows_and_keys_keep_their_order_and_a_set_changes_only_its_keys(self) -> None:
        self.set("b", ("state", "launched"), ("pr", ""))
        self.set("a", ("pr", "12"), ("host", "mac"))
        self.set("b", ("state", "merged"))
        doc = self.doc()
        self.assertEqual([row["task"] for row in doc["tasks"]], ["b", "a"])
        self.assertEqual(doc["tasks"][0]["fields"], {"state": "merged", "pr": ""})

    def test_the_view_escapes_only_the_pipe_and_line_breaks(self) -> None:
        self.set("ll#1", ("state", "a|b"), ("note", "x\ny"))
        self.set("ll#2", ("pr", "`#3`"))
        self.call("note", {"wave": "w", "fields": [["base", "abc\ndef"]]})
        self.call("log", {"wave": "w", "text": "one | two"})
        rc, out, _ = self.call("show", {"wave": "w"})
        self.assertEqual(rc, 0)
        lines = out.split("\n")
        self.assertEqual(lines[:5], ["# Board: w", "", "- base: abc<br>def", "", "| task | state | note | pr |"])
        self.assertEqual(lines[5:8], ["| --- | --- | --- | --- |", "| ll#1 | a\\|b | x<br>y |  |", "| ll#2 |  |  | `#3` |"])
        self.assertEqual(lines[9], "## Log")
        self.assertRegex(lines[10], r"^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ one \| two$")

    def test_no_text_ends_a_row_and_no_backslash_unescapes_a_pipe(self) -> None:
        self.set("t", ("a", "x\\|y"), ("b", "one\u2028two\x85three\u2029four\vfive"), ("c", "bell\x07\ttab\x1f"))
        self.call("log", {"wave": "w", "text": "x\u2028y"})
        rc, out, _ = self.call("show", {"wave": "w"})
        self.assertEqual(rc, 0)
        lines = out.split("\n")
        self.assertEqual(lines[4], "| t | x\\\\\\|y | one<br>two<br>three<br>four<br>five | bell\ufffd\ttab\ufffd |")
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
        self.assertIn("expected set, note, log, show, check, takeover or close", self.refused())
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
