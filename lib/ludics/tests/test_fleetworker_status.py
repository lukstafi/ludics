"""ludics.fleetworker.status (``status --json``, ludics#1165), the board store's ``scan``, lease.py's
``ANCHOR_FACTS`` and takeover's THE PHASE. End to end on this box: the anchor ``local`` over a scratch
state root."""

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import __main__ as entry
from ludics.fleetworker import boardstore, lease, status, takeover, transport
from ludics.fleetworker.config import load_config
from ludics.fleetworker.transport import UNREACHABLE, Done

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SCRIPT = os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh")
TOKEN = "SEKRIT-6f1c2e9a-token"
TASK_KEYS = ["task", "updated_at", "state", "state_word", "phase", "issue", "repository", "pr", "merge", "branch",
             "worker", "agent", "agent_host", "exec_hosts", "worktree", "kind", "model", "transport"]


class Phase(unittest.TestCase):
    """THE PHASE (takeover's header): a row's state word, and nothing else of the row."""

    def test_live_words_are_active_and_done_words_are_themselves(self) -> None:
        for word in takeover.LIVE_STATES:
            self.assertEqual(takeover.phase_of({"state": f"{word.upper()}; round 2"}), "active", word)
        for word in takeover.DONE_STATES:
            self.assertEqual(takeover.phase_of({"state": f"{word.capitalize()}."}), word, word)
        self.assertEqual(takeover.phase_of({"state": "MERGED 37a9539b; issue closed;"}), "merged")
        self.assertEqual(takeover.phase_of({"state": "merged #1137 at 9d68"}), "merged")
        self.assertEqual(takeover.PHASES, ("active", "merged", "done", "closed", "dropped", "unknown"))

    def test_anything_else_is_unknown_never_a_guess(self) -> None:
        for fields in ({"state": "done-merged"}, {"state": "not launched (cutoff)"}, {"state": ""},
                       {"state": "dropped…"}, {"pr": "4"}, {},
                       {"state": "done-merged", "merge": "afff7322" * 5}):  # a merge SHA moves nothing
            self.assertEqual(takeover.phase_of(fields), "unknown", fields)

    def test_status_is_read_only_on_a_row_with_no_state(self) -> None:
        self.assertEqual(takeover.phase_of({"status": "done"}), "done")
        self.assertEqual(takeover.phase_of({"state": "reviewing", "status": "merged"}), "active")
        self.assertEqual(takeover.phase_of({"state": "", "status": "merged"}), "unknown")


class Anchor(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-status-test."))
        self.env = {"FLEET_ANCHOR": "local", "FLEET_ANCHOR_STATE": self.root, "FLEET_SKILLS_REPO": CHECKOUT,
                    "FLEET_BOXES": "local", "PATH": os.environ.get("PATH", ""), "HOME": self.root}
        self.cfg = load_config(SCRIPT, self.env, host="testbox")

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def row(self, wave: str, task: str, **fields: str) -> None:
        payload = {"wave": wave, "create": True, "new_row": True, "task": task,
                   "fields": [[k, v] for k, v in fields.items()]}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(boardstore.run(["-", self.root, "set", "coord", json.dumps(payload)]), 0)

    def stamp(self, wave: str, at: str) -> None:
        path = os.path.join(self.root, "boards", f"{wave}.json")
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        doc["updated_at"] = at
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f)

    def write(self, name: str, text: str) -> None:
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def status(self, *args: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):  # HOME is the scratch root: no coordinator identity
            try:
                rc = status.cmd_status_json(self.cfg, ["--json", *args])
            except cli.Exit as exc:
                rc = exc.rc
        return rc, out.getvalue()

    def document(self, *args: str, rc: int = 0) -> dict[str, Any]:
        got, out = self.status(*args)
        self.assertEqual(got, rc, out)
        return json.loads(out)

    def scan(self, payload: dict[str, Any]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = boardstore.run(["-", self.root, "scan", "x", json.dumps(payload)])
        return rc, out.getvalue(), err.getvalue()


class Scan(Anchor):
    """The board store's ``scan`` action (boardstore's header)."""

    def test_every_board_in_name_order_and_a_corrupt_one_is_refused_not_fatal(self) -> None:
        self.row("w2", "t", state="merged")
        self.row("w1", "t", status="done")  # a legacy row
        self.write("boards/bad.json", "{")
        self.write("boards/.board-tmp123", "{")         # a writer's temporary
        self.write("boards/notes.txt", "x")
        self.write("boards/-x.json", "{}")               # outside the wave grammar
        os.mkfifo(os.path.join(self.root, "boards", "fifo.json"))  # read, it would block the scan
        os.symlink("w1.json", os.path.join(self.root, "boards", "link.json"))  # a link to a board is read
        rc, out, err = self.scan({"since_hours": None})
        self.assertEqual((rc, err), (0, ""))
        got = json.loads(out)
        self.assertEqual([b["wave"] for b in got["boards"]], ["w1", "w2"])
        self.assertEqual([r["wave"] for r in got["refused"]], ["bad", "fifo", "link"])
        self.assertIn("is not a valid board", got["refused"][0]["why"])
        self.assertIn("fifo.json is no regular file", got["refused"][1]["why"])
        self.assertIn("not board version 1 of wave link", got["refused"][2]["why"])  # its wave names the file
        self.assertEqual(out.count("\n"), 1)

    def test_the_window_is_inclusive_against_the_anchors_clock(self) -> None:
        for wave, at in (("before", "2026-11-17T09:59:59Z"), ("at", "2026-11-17T10:00:00Z"), ("after", "2026-11-17T10:00:01Z")):
            self.row(wave, "t", state="launched")
            self.stamp(wave, at)
        now = datetime(2026, 11, 17, 12, 0, 0, tzinfo=timezone.utc)
        with mock.patch.object(boardstore, "now_utc", return_value=now):
            got = json.loads(self.scan({"since_hours": 2})[1])
            self.assertEqual([b["wave"] for b in got["boards"]], ["after", "at"])
            got = json.loads(self.scan({"since_hours": 2.0 + 1 / 3600})[1])  # fractional hours
            self.assertEqual([b["wave"] for b in got["boards"]], ["after", "at", "before"])
            self.assertEqual(len(json.loads(self.scan({"since_hours": 1e300})[1])["boards"]), 3)
            self.stamp("at", "yesterday")
            got = json.loads(self.scan({"since_hours": 2})[1])
            self.assertEqual([b["wave"] for b in got["boards"]], ["after"])
            self.assertEqual([r["wave"] for r in got["refused"]], ["at"])
            self.assertIn("no %Y-%m-%dT%H:%M:%SZ stamp", got["refused"][0]["why"])
            got = json.loads(self.scan({"since_hours": None})[1])  # no window reads no stamp
            self.assertEqual(len(got["boards"]), 3)

    def test_no_boards_is_none_and_a_root_or_boards_that_is_no_directory_refuses(self) -> None:
        self.assertEqual(self.scan({"since_hours": None})[:2], (0, '{"boards": [], "refused": []}\n'))
        self.write("boards", "a file")
        self.assertEqual(self.scan({"since_hours": None})[0], 1)
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            rc = boardstore.run(["-", os.path.join(self.root, "boards"), "scan", "x", '{"since_hours": null}'])
        self.assertEqual(rc, 1, "a root that is a file")
        self.assertIn("is not a directory", err.getvalue())

    def test_the_window_must_be_a_positive_finite_number(self) -> None:
        for since in (0, -1, True, "2", float("inf"), [1]):
            rc, _, err = self.scan({"since_hours": since})
            self.assertEqual(rc, 1, since)
            self.assertIn("since_hours must be a positive finite number", err)


class Document(Anchor):
    """THE DOCUMENT (status.py's header) end to end."""

    def fixture(self) -> None:
        self.row("wave-old", "#603", status="merged #12")  # a board before #810
        self.row("wave-new", "t1", state="implementing", issue="o/r#1", repository="o/r", pr="5", branch="b",
                 worker="w1", agent="a1", agent_host="mac-studio", exec_hosts="mac-studio, rog none", worktree="/w",
                 kind="claude", model="opus", transport="native", standing="x", brief="/b")
        self.row("wave-new", "t2", state="done-merged", merge="0123abc")
        self.write("COORDINATOR", f"host=box/session-1\ntoken={TOKEN}\nsince=2026-11-17T09:48:55Z\n")

    def test_the_documents_shape(self) -> None:
        self.fixture()
        doc = self.document()
        self.assertEqual(list(doc), ["version", "anchor", "generated_at", "since_hours", "coordinator", "halt",
                                     "waves", "executions", "errors"])
        self.assertEqual((doc["version"], doc["anchor"], doc["since_hours"]), (1, "local", None))
        self.assertEqual(doc["coordinator"], {"host": "box/session-1", "since": "2026-11-17T09:48:55Z"})
        self.assertEqual((doc["halt"], doc["executions"], doc["errors"]), (None, [], []))
        self.assertEqual([w["wave"] for w in doc["waves"]], ["wave-new", "wave-old"])
        new = doc["waves"][0]
        self.assertEqual(list(new), ["wave", "created_at", "created_by", "updated_at", "notes", "tasks"])
        self.assertEqual(new["created_by"], "coord")
        t1, t2 = new["tasks"]
        self.assertEqual(list(t1), TASK_KEYS)
        self.assertEqual({k: t1[k] for k in ("state", "state_word", "phase", "exec_hosts", "agent", "pr")},
                         {"state": "implementing", "state_word": "implementing", "phase": "active",
                          "exec_hosts": ["mac-studio", "rog"], "agent": "a1", "pr": "5"})
        self.assertNotIn("standing", t1)  # a closed projection
        self.assertEqual({k: t2[k] for k in ("state", "state_word", "phase", "merge", "issue", "exec_hosts")},
                         {"state": "done-merged", "state_word": None, "phase": "unknown", "merge": "0123abc",
                          "issue": None, "exec_hosts": []})
        old = doc["waves"][1]["tasks"][0]
        self.assertEqual((old["state"], old["state_word"], old["phase"]), ("merged #12", "merged", "merged"))

    def test_since_selects_boards(self) -> None:
        self.fixture()
        self.stamp("wave-old", "2026-01-01T00:00:00Z")
        doc = self.document("--since", "24")
        self.assertEqual((doc["since_hours"], [w["wave"] for w in doc["waves"]]), (24.0, ["wave-new"]))

    def test_halt_absent_empty_text_and_unread(self) -> None:
        self.assertIsNone(self.document()["halt"])
        self.assertIsNone(self.document()["coordinator"])  # no lease file
        self.write("HALT", "")
        self.assertEqual(self.document()["halt"], "")
        legacy = "2026-11-01T00:00:00Z regressed: x | y $(z)\nupdate 2026-11-02T00:00:00Z more\n"
        self.write("HALT", legacy)
        self.assertEqual(self.document()["halt"], legacy.rstrip("\n"))  # $(cat)'s text, verbatim
        os.unlink(os.path.join(self.root, "HALT"))
        os.makedirs(os.path.join(self.root, "HALT"))
        doc = self.document(rc=3)
        self.assertIsNone(doc["halt"])
        self.assertEqual([e["source"] for e in doc["errors"]], ["halt"])

    def test_an_unreadable_lease_and_a_corrupt_board_are_errors_and_exit_3(self) -> None:
        self.fixture()
        os.makedirs(os.path.join(self.root, "boards", "dir.json"))
        os.unlink(os.path.join(self.root, "COORDINATOR"))
        os.makedirs(os.path.join(self.root, "COORDINATOR"))
        doc = self.document(rc=3)
        self.assertIsNone(doc["coordinator"])
        self.assertEqual([(e["source"], e.get("wave")) for e in doc["errors"]], [("lease", None), ("board", "dir")])
        self.assertEqual(len(doc["waves"]), 2, "the scan went on past the refused board")

    def test_executions_are_the_compact_active_listing_and_carry_no_token(self) -> None:
        record = {"request_id": "r1", "state": "running", "lease_token": TOKEN, "history": [{"t": TOKEN}],
                  "request": {"wave": "w", "execution_host": "rog"}}
        with mock.patch.object(status, "listing", return_value=Done(0, json.dumps([record]))) as listed:
            doc = self.document()
        listed.assert_called_once_with(self.cfg, options={"active": True, "compact": True})
        self.assertEqual(doc["executions"], [{"request_id": "r1", "state": "running",
                                              "request": {"wave": "w", "execution_host": "rog"}}])
        with mock.patch.object(status, "listing", return_value=Done(1, "")):
            doc = self.document(rc=3)
        self.assertIsNone(doc["executions"])
        self.assertEqual(doc["errors"], [{"source": "executions", "why": "the registry listing exited 1"}])

    def test_the_real_registry_listing_is_read(self) -> None:
        self.assertEqual(self.document()["executions"], [])
        self.assertTrue(os.path.isdir(self.root))

    def test_three_anchor_calls_whatever_the_number_of_boards(self) -> None:
        def calls() -> int:
            with mock.patch.object(transport, "run", wraps=transport.run) as run:
                self.document()
            return run.call_count

        self.row("w0", "t", state="merged")
        self.assertEqual(calls(), 3)
        for n in range(1, 6):
            self.row(f"w{n}", "t", state="merged")
        self.assertEqual(calls(), 3)

    def test_an_anchor_that_does_not_answer_prints_nothing_and_exits_4(self) -> None:
        err = io.StringIO()
        with mock.patch.object(transport, "run", return_value=Done(UNREACHABLE, "")), contextlib.redirect_stderr(err):
            rc, out = self.status()
        self.assertEqual((rc, out, err.getvalue()), (4, "", "STATUS UNREACHABLE local\n"))

    def test_the_token_appears_nowhere_end_to_end(self) -> None:
        """Through fleet-worker.sh's own entry (scripts/py -m ludics.fleetworker), stdout and stderr."""
        self.fixture()
        self.write("HALT", "halted\n")
        done = subprocess.run([os.path.join(CHECKOUT, "scripts", "py"), "-m", "ludics.fleetworker", SCRIPT,
                               "status", "--json"], env=self.env, capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["coordinator"]["host"], "box/session-1")
        self.assertNotIn(TOKEN, done.stdout + done.stderr)
        self.assertNotIn("token", done.stdout)


class AnchorFacts(unittest.TestCase):
    """lease.py's ``ANCHOR_FACTS`` protocol, read fail-closed."""

    def test_the_protocol(self) -> None:
        parse = lease.parse_anchor_facts
        self.assertEqual(parse("lease=absent\nhalt=absent\n"), lease.AnchorFacts("absent", halt="absent"))
        got = parse("lease=present\nhost=h/s\nsince=\nhalt=present\nline 1\nhalt=absent\n")
        self.assertEqual((got.lease, got.host, got.since, got.halt, got.halt_text),
                         ("present", "h/s", None, "present", "line 1\nhalt=absent\n"))
        self.assertEqual(parse("lease=unread\nhalt=unread\n").lease, "unread")
        for off in ("", "lease=present\nhalt=absent\n", "lease=absent\n", "lease=absent\nhalt=absent\nmore",
                    "token=x\nhalt=absent\n", "lease=absent\nhalt=maybe\n"):
            got = parse(off)
            self.assertEqual((got.lease, got.halt), ("unread", "unread"), off)
            self.assertIn("not the lease/halt protocol", got.why)


class CommandLine(unittest.TestCase):
    def refused(self, *args: str) -> str:
        with self.assertRaises(cli.Exit) as caught:
            status.since_of(list(args))
        self.assertEqual(caught.exception.rc, 2)
        return caught.exception.message

    def test_the_window(self) -> None:
        self.assertIsNone(status.since_of(["--json"]))
        self.assertEqual(status.since_of(["--json", "--since", "0.5"]), 0.5)
        for bad in ("0", "-1", "nan", "inf", "1e3", "abc", "", "0.0"):
            self.assertIn("--since takes a positive number of hours", self.refused("--json", "--since", bad), bad)
        for args in (["--json", "--since"], ["--json", "--bogus"], ["--json", "--since", "1", "--since", "2"],
                     ["--json", "rog"]):
            self.assertIn("expected [--since <hours>]", self.refused(*args), args)

    def test_dispatch_keeps_status_box_name(self) -> None:
        cfg = load_config(SCRIPT, {"PATH": os.environ.get("PATH", ""), "HOME": "/nonexistent"}, host="testbox")
        with mock.patch.object(status, "cmd_status_json", return_value=0) as observed, \
                mock.patch("ludics.fleetworker.workers.cmd_status", return_value=0) as worker:
            entry.run_verb(cfg, "status", ["--json", "--since", "2"])
            entry.run_verb(cfg, "status", ["rog", "w1"])
        observed.assert_called_once_with(cfg, ["--json", "--since", "2"])
        worker.assert_called_once_with(cfg, ["rog", "w1"])


if __name__ == "__main__":
    unittest.main()
