"""ludics.fleetworker.registry: the shipped registry, imported (main does not run on import)."""

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from typing import Any

from ludics.fleetworker import registry


def request(identity: str, **extra: object) -> dict[str, object]:
    base: dict[str, object] = dict(
        request_id=identity, wave="w", worker=identity, transport="subagent", issue="o/r#1",
        purpose="unit", agent_host="mac", execution_host="mac", repository="o/r",
        requested_revision="origin/main", kind="correctness",
    )
    base.update(extra)
    return base


class RegistryCase(unittest.TestCase):
    """A scratch registry root and the call into it; no tests of its own."""

    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-registry-test."))

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def call(self, action: str, payload: object, boxes: str = "mac", slots: str = "",
             map_spec: str = "") -> tuple[int, Any, str]:
        out, err = io.StringIO(), io.StringIO()
        argv = ["-", self.root, action, "owner", "token", json.dumps(payload), boxes, slots, map_spec]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = registry.run(argv)
        return rc, json.loads(out.getvalue()) if out.getvalue() else None, err.getvalue()


class Registry(RegistryCase):
    def test_import_runs_nothing(self) -> None:
        self.assertEqual(registry.LANE_LOCKS, [])

    def test_a_correctness_slot_is_capped_and_a_standing_record_takes_none(self) -> None:
        self.assertEqual(self.call("run", request("a"))[0], 0)
        rc, _, err = self.call("run", request("b"))
        self.assertEqual(rc, 1)
        self.assertIn("EXECUTION REFUSED: box owned by a request=a coordinator=owner (correctness slots 1/1 on mac taken)", err)
        self.assertEqual(self.call("run", request("c", standing=True))[0], 0)
        self.assertEqual(self.call("run", request("b"), slots="mac=2")[0], 0)

    def test_a_refusal_is_one_line_on_stderr_and_exit_1(self) -> None:
        rc, out, err = self.call("reserve", request("bad", kind="other"))
        self.assertEqual((rc, out, err), (1, None, "EXECUTION REFUSED: kind must be correctness or measurement\n"))

    def test_list_validates_the_whole_ledger_before_filtering(self) -> None:
        self.call("reserve", request("a"))
        rc, listed, _ = self.call("list", {"active": True, "compact": True})
        self.assertEqual((rc, [r["request_id"] for r in listed]), (0, ["a"]))
        self.assertNotIn("history", listed[0])
        with open(os.path.join(self.root, "executions", "a.json"), "w") as f:
            f.write("{}")
        self.assertEqual(self.call("list", {"active": True, "compact": True})[0], 1)

    def test_list_host_selects_one_box_an_alias_its_roster_entry(self) -> None:
        roster, endpoints = "mac rog-nv-linux", "rog rog-nv-linux rog-nv-wsl\n"
        self.assertEqual(self.call("reserve", request("m", standing=True), boxes=roster)[0], 0)
        self.assertEqual(self.call("reserve", request("r", standing=True, execution_host="rog-nv-linux"),
                                   boxes=roster)[0], 0)

        def listed(host: str) -> tuple[int, list[str], str]:
            rc, out, err = self.call("list", {"active": True, "compact": True, "host": host}, boxes=roster,
                                     map_spec=endpoints)
            records: list[dict[str, Any]] = out or []
            return rc, [r["request_id"] for r in records], err

        self.assertEqual(listed("mac")[:2], (0, ["m"]))
        for alias in ("rog-nv-linux", "rog", "ROG", "rog-nv-wsl"):
            self.assertEqual(listed(alias)[:2], (0, ["r"]), alias)
        rc, _, err = listed("rgo")
        self.assertEqual(rc, 1)
        self.assertIn("list --host rgo: no FLEET_BOXES entry (mac rog-nv-linux) is that box", err)
        # Without a map an alias is its own name: refused, never an empty list read as an idle box.
        rc, _, _ = self.call("list", {"host": "rog"}, boxes=roster)
        self.assertEqual(rc, 1)
        for bad in ({"host": ""}, {"host": 3}, {"active": "yes"}, {"box": "mac"}):
            self.assertEqual(self.call("list", bad, boxes=roster)[0], 1, bad)


class HeadOf(RegistryCase):
    """ludics-lite#558: a head-of:<branch> request is resolved at its dispatch, never at reserve."""

    SHA = "c" * 40

    def test_the_branch_grammar_is_fail_closed(self) -> None:
        for good in ("main", "claude/w1015-558", "release-1.2", "a_b/c.d"):
            self.assertEqual(registry.head_of_branch("head-of:" + good), good, good)
        for bad in ("head-of:", "head-of:-x", "head-of:/x", "head-of:.x", "head-of:a..b", "head-of:a//b",
                    "head-of:a/.b", "head-of:a@{1}", "head-of:a/", "head-of:a.", "head-of:a.lock",
                    "head-of:a b", "head-of:a~1", "head-of:a^", "head-of:a:b", "main"):
            self.assertIsNone(registry.head_of_branch(bad), bad)
        rc, _, err = self.call("reserve", request("bad", requested_revision="head-of:main plus edits"))
        self.assertEqual(rc, 1)
        self.assertIn("is not head-of:<one branch name>", err)

    def test_reserve_records_no_commit_and_dispatch_requires_one(self) -> None:
        rc, rec, _ = self.call("reserve", request("h", requested_revision="head-of:topic"))
        self.assertEqual((rc, "resolved_revision" in rec), (0, False))
        rc, _, err = self.call("dispatch", {"request_id": "h", "evidence": "go"})
        self.assertEqual(rc, 1)
        self.assertIn("head-of:topic is resolved at assignment", err)
        for bad in ("C" * 40, "c" * 39, 7):
            self.assertEqual(self.call("dispatch", {"request_id": "h", "evidence": "go", "resolved_revision": bad})[0], 1)
        rc, rec, _ = self.call("dispatch", {"request_id": "h", "evidence": "go", "resolved_revision": self.SHA})
        self.assertEqual((rc, rec["state"], rec["resolved_revision"]), (0, "launching", self.SHA))
        self.assertEqual(rec["history"][-1]["data"]["resolved_revision"], self.SHA)

    def test_run_takes_the_resolution_beside_the_request_and_only_for_head_of(self) -> None:
        rc, rec, _ = self.call("run", request("h", requested_revision="head-of:topic", resolved_revision=self.SHA))
        self.assertEqual((rc, rec["resolved_revision"]), (0, self.SHA))
        self.assertNotIn("resolved_revision", rec["request"])
        self.assertEqual(rec["history"][-1]["data"]["resolved_revision"], self.SHA)
        rc, _, err = self.call("run", request("o", resolved_revision=self.SHA, standing=True))
        self.assertEqual(rc, 1)
        self.assertIn("resolved_revision is only for a head-of:<branch> request", err)
        self.assertEqual(self.call("reserve", request("r", requested_revision="head-of:topic", resolved_revision=self.SHA))[0], 1)
        rc, _, err = self.call("record", {"request_id": "h", "state": "running", "evidence": "x", "resolved_revision": self.SHA})
        self.assertEqual(rc, 1)
        self.assertIn("resolved_revision is only valid for dispatch", err)

    def test_a_record_holding_a_resolution_for_another_revision_is_invalid(self) -> None:
        self.call("run", request("h", requested_revision="head-of:topic", resolved_revision=self.SHA))
        path = os.path.join(self.root, "executions", "h.json")
        with open(path) as f:
            data = json.load(f)
        data["request"]["requested_revision"] = "origin/main"
        with open(path, "w") as f:
            json.dump(data, f)
        rc, _, err = self.call("list", {})
        self.assertEqual(rc, 1)
        self.assertIn("invalid resolved revision", err)


if __name__ == "__main__":
    unittest.main()
