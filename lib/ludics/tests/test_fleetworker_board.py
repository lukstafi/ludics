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
from ludics.fleetworker import board, boardstore

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

    def set(self, task: str, *pairs: tuple[str, str], create: bool = True) -> tuple[int, str, str]:
        return self.call("set", {"wave": "w", "create": create, "task": task, "fields": [list(p) for p in pairs]})


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
        for text in ("{not json", json.dumps({"board": 1, "wave": "other"}), json.dumps(valid)):
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

    def test_the_first_write_syncs_the_state_root_that_gained_the_boards_directory(self) -> None:
        synced: list[str] = []
        real = boardstore.sync_directory

        def recording(path: Any) -> None:
            synced.append(str(path))
            real(path)

        with mock.patch.object(boardstore, "sync_directory", recording):
            self.set("t", ("k", "v"))
        self.assertEqual(synced, [self.root, os.path.join(self.root, "boards")])

    def test_show_of_an_unknown_wave_refuses(self) -> None:
        self.assertEqual(self.call("show", {"wave": "nope"})[:2], (1, ""))


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
            ("set", {"wave": "w", "create": True, "task": "ll#1", "fields": [["state", "a=b"], ["pr", ""]]}),
        )

    def test_create_is_read_only_right_after_the_action(self) -> None:
        self.assertEqual(self.payload("log", "w", "--create", "x")[1], {"wave": "w", "text": "--create x"})
        self.assertIn("board log: takes no --create", self.refused("log", "--create", "w", "x"))
        self.assertIn("expected <key>=<value>, got \"--create\"", self.refused("set", "w", "t", "k=v", "--create"))

    def test_usage_refusals(self) -> None:
        self.assertIn("expected set, note, log or show", self.refused())
        self.assertIn("board show: expected <wave> [--json]", self.refused("show"))
        self.assertIn("board show: expected <wave> [--json]", self.refused("show", "w", "--md"))
        self.assertIn("board set: expected <task>", self.refused("set", "w"))
        self.assertIn("board set: give at least one", self.refused("set", "w", "t"))
        self.assertIn("board note: give at least one", self.refused("note", "--create", "w"))
        self.assertIn("board log: expected the line's text", self.refused("log", "w"))
        self.assertEqual(self.payload("show", "w", "--json"), ("show", {"wave": "w", "json": True}))


if __name__ == "__main__":
    unittest.main()
