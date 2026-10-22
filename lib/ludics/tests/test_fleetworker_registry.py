"""ludics.fleetworker.registry: the shipped registry, imported (main does not run on import)."""

import contextlib
import fcntl
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from typing import Any
from unittest import mock

from ludics.fleetworker import registry


def request(identity: str, **extra: object) -> dict[str, object]:
    base: dict[str, object] = dict(
        request_id=identity, wave="w", worker=identity, transport="subagent", issue="o/r#1",
        purpose="unit", agent_host="mac", execution_host="mac", repository="o/r",
        requested_revision="origin/main", kind="correctness",
    )
    if extra.get("standing"):
        base["checkout"] = f"/wt/{identity}"  # THE CHECKOUT, which a new standing request must name
    base.update(extra)
    if base.get("checkout") is None:
        base.pop("checkout", None)  # checkout=None: a payload naming none
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
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = registry.run(argv)
        finally:
            # A program holds waiters/.lock until it exits; in process, this call is its exit.
            while registry.WAITER_LOCKS:
                os.close(registry.WAITER_LOCKS.pop())
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
                    "head-of:a b", "head-of:a~1", "head-of:a^", "head-of:a:b", "main", "head-of:release.lock/topic",
                    "head-of:a/.hidden/b", "head-of:a./b", "head-of:HEAD"):
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

    def test_an_unresolved_head_of_record_is_never_made_active_by_reconcile(self) -> None:
        self.call("reserve", request("h", requested_revision="head-of:topic"))
        rc, _, err = self.call("reconcile", {"request_id": "h", "state": "running", "evidence": "recovered"})
        self.assertEqual(rc, 1)
        self.assertIn("head-of:topic was never resolved (no dispatch)", err)
        self.assertEqual(self.call("reconcile", {"request_id": "h", "state": "reserved", "evidence": "nothing ran"})[0], 0)

    def test_evidence_of_a_resolved_record_is_about_the_assigned_commit(self) -> None:
        self.call("run", request("h", requested_revision="head-of:topic", resolved_revision=self.SHA))
        other = "d" * 40
        rc, _, err = self.call("record", {"request_id": "h", "state": "running", "evidence": "x", "observed_sha": other})
        self.assertEqual(rc, 1)
        self.assertIn(f"observed_sha {other} is not {self.SHA}, the commit head-of:topic was resolved to", err)
        done = {"request_id": "h", "verdict": "pass", "log": "/l", "evidence": "x", "handle": "h", "remote_checkout": "/w"}
        self.assertEqual(self.call("conclude", {**done, "observed_sha": other})[0], 1)
        self.assertEqual(self.call("conclude", {**done, "observed_sha": self.SHA})[0], 0)

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

    def test_an_issue_is_one_owner_name_number_or_absent_on_a_new_request(self) -> None:
        # ludics-lite#664: a post-wave placeholder named no issue, so `prs --wave` could not find its PR.
        no_issue = request("bare")
        del no_issue["issue"]
        self.assertEqual(self.call("reserve", no_issue, slots="mac=9")[0], 0)
        self.assertEqual(self.call("run", request("ok", issue="a.b/c_d-e#10"), slots="mac=9")[0], 0)
        for i, bad in enumerate(("lukstafi/ludics-lite#post-1", "o/r integration", "o/r#0", "#7", "o/r#7 x", "o/r#1,#2")):
            for action in ("reserve", "run"):
                rc, out, err = self.call(action, request(f"bad{i}{action}", issue=bad), slots="mac=9")
                self.assertEqual((rc, out), (1, None), bad)
                self.assertIn(f"EXECUTION REFUSED: issue {bad!r} is not one issue spelled owner/name#N", err)
        self.assertEqual(self.call("reserve", request("empty", issue=""))[0], 1)
        self.assertEqual(sorted(r["request_id"] for r in self.call("list", {})[1]), ["bare", "ok"])

    def test_a_free_text_issue_already_in_the_ledger_still_validates_and_retries(self) -> None:
        legacy = request("old", issue="o/r#1", standing=True)
        self.call("reserve", legacy)
        path = os.path.join(self.root, "executions", "old.json")
        with open(path) as f:
            data = json.load(f)
        data["request"]["issue"] = legacy["issue"] = "o/r integration"
        with open(path, "w") as f:
            json.dump(data, f)
        self.assertEqual(self.call("list", {})[0], 0)
        rc, out, _ = self.call("reserve", legacy)
        self.assertEqual((rc, out["request"]["issue"]), (0, "o/r integration"), "the retry answers with the record")

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


class Binding(RegistryCase):
    """ludics-lite#634: a non-standing request for exactly one commit is concluded only at it."""

    SHA, OTHER = "a" * 40, "b" * 40
    DONE = {"verdict": "pass", "log": "/l", "evidence": "x", "handle": "h", "remote_checkout": "/w"}

    def test_what_binds_is_fail_closed(self) -> None:
        def bound(**extra: object) -> str | None:
            return registry.bound_commit({"request_id": "r", "request": request("r", **extra)})

        self.assertEqual(bound(requested_revision=self.SHA), self.SHA)
        self.assertEqual(bound(requested_revision="e" * 64), "e" * 64)
        for free in (f"{self.SHA} plus working diff", f" {self.SHA}", f"{self.SHA}\n", self.SHA.upper(),
                     self.SHA[:39], "origin/main", f"origin/{self.SHA}", f"{self.SHA}^"):
            self.assertIsNone(bound(requested_revision=free), repr(free))
        self.assertIsNone(bound(requested_revision=self.SHA, standing=True), "a standing record is exempt")
        resolved = {"request_id": "h", "resolved_revision": self.OTHER,
                    "request": request("h", requested_revision="head-of:topic", standing=True)}
        self.assertEqual(registry.bound_commit(resolved), self.OTHER, "a resolution binds whatever the record")
        self.assertIsNone(registry.bound_commit({"request": "not an object"}))

    def test_every_payload_naming_another_commit_is_refused_and_the_reserved_one_passes(self) -> None:
        self.call("reserve", request("e", requested_revision=self.SHA))
        payloads = [
            ("dispatch", {"request_id": "e", "evidence": "go", "observed_sha": self.OTHER}),
            ("reconcile", {"request_id": "e", "state": "running", "evidence": "x", "observed_sha": self.OTHER}),
        ]
        for action, payload in payloads:
            rc, _, err = self.call(action, payload)
            self.assertEqual(rc, 1, action)
            self.assertIn(f"observed_sha {self.OTHER} is not {self.SHA}, the exact commit non-standing request e"
                          " reserved (ludics-lite#634)", err)
            self.assertIn("reserve that run under a new request id (a deliberate re-pin)", err)
        self.assertEqual(self.call("dispatch", {"request_id": "e", "evidence": "go", "observed_sha": self.SHA})[0], 0)
        rc, _, err = self.call("record", {"request_id": "e", "state": "running", "evidence": "x", "observed_sha": self.OTHER})
        self.assertEqual(rc, 1)
        self.assertIn("is not " + self.SHA, err)
        rc, _, err = self.call("conclude", {"request_id": "e", **self.DONE, "observed_sha": self.OTHER})
        self.assertEqual(rc, 1)
        self.assertEqual(self.call("list", {})[1][0]["state"], "launching", "a refusal changes nothing")
        rc, rec, _ = self.call("conclude", {"request_id": "e", **self.DONE, "observed_sha": self.SHA})
        self.assertEqual((rc, rec["verdict"], rec["observed_sha"]), (0, "pass", self.SHA))

    def test_an_inherited_observed_sha_is_bound_and_not_launched_names_none(self) -> None:
        self.call("run", request("e", requested_revision=self.SHA))
        path = os.path.join(self.root, "executions", "e.json")
        with open(path) as f:
            data = json.load(f)
        data["observed_sha"] = self.OTHER  # recorded before the binding existed
        with open(path, "w") as f:
            json.dump(data, f)
        rc, _, err = self.call("conclude", {"request_id": "e", **self.DONE})
        self.assertEqual(rc, 1)
        self.assertIn(f"the recorded observed_sha {self.OTHER}, which this conclusion inherits, is not {self.SHA}", err)
        rc, rec, _ = self.call("conclude", {"request_id": "e", "verdict": "not-launched", "log": "/l", "evidence": "x"})
        self.assertEqual((rc, rec["verdict"]), (0, "not-launched"))

    def test_standing_free_text_and_concluded_retries_are_not_bound(self) -> None:
        self.call("run", request("s", requested_revision=self.SHA, standing=True))
        self.assertEqual(self.call("conclude", {"request_id": "s", **self.DONE, "observed_sha": self.OTHER})[0], 0)
        self.call("run", request("f", requested_revision=f"{self.SHA} plus working diff"))
        self.assertEqual(self.call("conclude", {"request_id": "f", **self.DONE, "observed_sha": self.OTHER})[0], 0)
        # A record concluded at another commit before the binding existed answers its identical retry.
        self.call("run", request("old", requested_revision=self.SHA))
        done = {"request_id": "old", **self.DONE, "observed_sha": self.SHA}
        self.assertEqual(self.call("conclude", done)[0], 0)
        path = os.path.join(self.root, "executions", "old.json")
        with open(path) as f:
            data = json.load(f)
        data["observed_sha"] = data["history"][-1]["data"]["observed_sha"] = self.OTHER
        with open(path, "w") as f:
            json.dump(data, f)
        rc, rec, _ = self.call("conclude", {**done, "observed_sha": self.OTHER})
        self.assertEqual((rc, rec["observed_sha"]), (0, self.OTHER))

    def test_a_resolved_head_of_conclusion_inheriting_another_commit_is_refused(self) -> None:
        self.call("run", request("h", requested_revision="head-of:topic", resolved_revision=self.SHA))
        self.call("record", {"request_id": "h", "state": "running", "evidence": "x", "observed_sha": self.SHA})
        self.call("reconcile", {"request_id": "h", "state": "reserved", "evidence": "nothing ran"})
        self.call("dispatch", {"request_id": "h", "evidence": "go", "resolved_revision": self.OTHER})
        rc, _, err = self.call("conclude", {"request_id": "h", **self.DONE})
        self.assertEqual(rc, 1)
        self.assertIn(f"the recorded observed_sha {self.SHA}, which this conclusion inherits, is not {self.OTHER},"
                      " the commit head-of:topic was resolved to at assignment", err)


class Checkout(RegistryCase):
    """ludics-lite#731: THE CHECKOUT -- beside the request, fixed at reserve, required of a new
    standing request."""

    def test_a_new_standing_request_must_name_an_absolute_checkout(self) -> None:
        for action in ("reserve", "run"):
            rc, out, err = self.call(action, request(f"s{action}", standing=True, checkout=None))
            self.assertEqual((rc, out), (1, None))
            self.assertIn("EXECUTION REFUSED: a standing reservation must name its checkout", err)
            for bad in ("wt/r", "", "  ", 7, "~/wt"):
                rc, _, err = self.call(action, request(f"b{action}", standing=True, checkout=bad))
                self.assertEqual(rc, 1, bad)
                self.assertIn("must be an absolute path on the execution host", err)
        self.assertEqual(self.call("list", {})[1], [])
        self.assertEqual(self.call("run", request("ok", standing=True, checkout="C:\\wt\\ok"))[0], 0)
        self.assertEqual(self.call("run", request("plain"), slots="mac=9")[0], 0, "a non-standing request may name none")

    def test_the_checkout_is_a_top_level_field_never_a_request_field(self) -> None:
        rc, rec, _ = self.call("run", request("s", standing=True, evidence="go"))
        self.assertEqual((rc, rec["checkout"]), (0, "/wt/s"))
        # What an older registry, which refuses an unknown request field, reads of this record.
        self.assertNotIn("checkout", rec["request"])
        self.assertLessEqual(set(rec["request"]), registry.REQUEST_FIELDS | registry.OPTIONAL_FIELDS)
        self.assertEqual(rec["history"][0]["data"]["checkout"], "/wt/s")
        self.assertEqual(rec["history"][-1]["data"]["evidence"], "go")
        rc, rec, _ = self.call("reserve", request("n", checkout="/wt/n"), slots="mac=9")
        self.assertEqual((rc, rec["checkout"], "checkout" in rec["request"]), (0, "/wt/n", False))

    def test_a_retry_names_the_same_checkout_or_is_refused(self) -> None:
        self.assertEqual(self.call("reserve", request("s", standing=True))[0], 0)
        self.assertEqual(self.call("reserve", request("s", standing=True))[0], 0, "the identical retry")
        rc, _, err = self.call("reserve", request("s", standing=True, checkout="/wt/other"))
        self.assertEqual(rc, 1)
        self.assertIn('request_id already names a different checkout ("/wt/s")', err)
        self.assertEqual(self.call("reserve", request("n"), slots="mac=9")[0], 0)
        rc, _, err = self.call("reserve", request("n", checkout="/wt/n"), slots="mac=9")
        self.assertEqual(rc, 1)
        self.assertIn("request_id already names a different checkout (null)", err)

    def test_an_older_record_naming_none_still_validates_and_concludes(self) -> None:
        self.assertEqual(self.call("run", request("old", standing=True))[0], 0)
        path = os.path.join(self.root, "executions", "old.json")
        with open(path) as f:
            data = json.load(f)
        del data["checkout"]
        del data["history"][0]["data"]["checkout"]
        with open(path, "w") as f:
            json.dump(data, f)
        self.assertEqual(self.call("list", {})[0], 0)
        done = {"request_id": "old", "verdict": "pass", "log": "/l", "evidence": "x", "handle": "h",
                "remote_checkout": "/w", "observed_sha": "a" * 40}
        self.assertEqual(self.call("conclude", done)[0], 0)

    def test_a_malformed_checkout_in_the_ledger_is_refused(self) -> None:
        self.call("run", request("s", standing=True))
        path = os.path.join(self.root, "executions", "s.json")
        with open(path) as f:
            data = json.load(f)
        data["checkout"] = "relative"
        with open(path, "w") as f:
            json.dump(data, f)
        rc, _, err = self.call("list", {})
        self.assertEqual(rc, 1)
        self.assertIn("invalid checkout", err)

    def test_an_evidence_payload_cannot_carry_one(self) -> None:
        self.call("run", request("s", standing=True))
        rc, _, err = self.call("record", {"request_id": "s", "state": "running", "evidence": "x", "checkout": "/wt/x"})
        self.assertEqual(rc, 1)
        self.assertIn("unknown evidence fields", err)


class WindowGap(RegistryCase):
    """ludics-lite#667, #719: a new window inside the gap after its box's last measurement, while a
    batch is waiting for the box, is answered exit 3 with the seconds to wait, and nothing written."""

    def window(self, identity: str, gap: int | None = 60, boxes: str = "mac") -> tuple[int, Any, str]:
        payload: dict[str, object] = {"box": "mac", "request": request(identity, kind="measurement")}
        if gap is not None:
            payload["gap"] = gap
        return self.call("window", payload, boxes=boxes)

    def beat(self, identity: str = "rog-7", box: str = "mac", ttl: int = 60, boxes: str = "mac") -> tuple[int, Any, str]:
        return self.call("wait", {"waiter": {"box": box, "id": identity, "command": "make test", "ttl": ttl}},
                         boxes=boxes)

    def conclude(self, identity: str) -> None:
        self.assertEqual(self.call("conclude", {"request_id": identity, "verdict": "not-launched", "log": "/dev/null",
                                                "evidence": "unit"})[0], 0)

    def age(self, identity: str, at: str, kind: str = "executions", key: str = "updated_at") -> None:
        path = os.path.join(self.root, kind, f"{identity}.json")
        with open(path) as f:
            data = json.load(f)
        data[key] = at
        with open(path, "w") as f:
            json.dump(data, f)

    def test_the_first_window_opens_and_the_next_one_waits_out_the_gap_while_a_batch_waits(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.assertEqual(self.window("w1")[0], 0, "no measurement concluded on the box: no gap")
        self.assertEqual(self.beat()[0], 0)
        self.conclude("w1")
        rc, out, err = self.window("w2")
        self.assertEqual(rc, 3)
        gap = out["gap"]
        self.assertEqual((gap["box"], gap["after"], gap["gap"], gap["waiting"]), ("mac", "w1", 60, ["rog-7"]))
        self.assertTrue(0 < gap["wait"] <= 60 and gap["ago"] >= 0, gap)
        self.assertRegex(err, r"\AEXECUTION WINDOW mac: measurement w1 concluded on mac [0-9]+s ago, and batches are"
                              r" waiting for mac \(rog-7\): they get 60s to take its slots before the next window"
                              r" \(ludics-lite#667, #719\); [0-9]+s to go\n\Z")
        self.assertFalse(os.path.exists(os.path.join(self.root, "executions", "w2.json")), "nothing written")
        self.assertEqual(self.call("list", {"active": True})[1][0]["state"], "launching", "s is not suspended")

    def test_nobody_waiting_opens_at_once_whatever_is_standing(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.window("w1", gap=None)
        self.conclude("w1")
        self.assertEqual(self.window("w2")[0], 0, "a standing record is no waiter (#719)")
        self.conclude("w2")
        self.beat()
        self.age("rog-7", "2026-01-01T00:00:00+00:00", kind="waiters", key="expires")
        self.assertEqual(self.window("w3")[0], 0, "an expired heartbeat is no waiter")
        self.conclude("w3")
        self.assertEqual(self.beat(box="rog", boxes="mac rog")[0], 0)
        self.assertEqual(self.window("w4", boxes="mac rog")[0], 0, "a waiter on another box is not this one's")

    def test_no_gap_asked_or_a_gap_already_past_opens_at_once(self) -> None:
        self.beat(ttl=3600)
        self.window("w1", gap=None)
        self.conclude("w1")
        self.assertEqual(self.window("w2", gap=0)[0], 0, "--no-gap")
        self.conclude("w2")
        self.assertEqual(self.window("w3", gap=None)[0], 0, "an old client's payload: no gap")
        self.conclude("w3")
        self.age("w3", "2026-01-01T00:00:00+00:00")
        self.age("w2", "2026-01-01T00:00:01")  # naive, as UTC
        self.age("w1", "2026-01-01T00:00:00+00:00")
        self.assertEqual(self.window("w4")[0], 0, "the last measurement concluded long ago")

    def test_any_measurement_on_the_box_starts_the_gap_and_another_boxs_does_not(self) -> None:
        self.assertEqual(self.call("run", request("plain", kind="measurement"))[0], 0)
        self.conclude("plain")
        self.beat()
        rc, out, _ = self.window("w1")
        self.assertEqual((rc, out["gap"]["after"]), (3, "plain"))
        self.age("plain", "2026-01-01T00:00:00+00:00")
        self.assertEqual(self.call("run", request("r", kind="measurement", execution_host="rog"), boxes="mac rog")[0], 0)
        self.conclude("r")
        self.assertEqual(self.window("w2", boxes="mac rog")[0], 0)

    def test_a_waiter_file_that_does_not_parse_counts_as_waiting_on_every_box(self) -> None:
        self.window("w1", gap=0)
        self.conclude("w1")
        os.makedirs(os.path.join(self.root, "waiters"), exist_ok=True)
        with open(os.path.join(self.root, "waiters", "torn.json"), "w") as f:
            f.write("{")
        rc, out, _ = self.window("w2")
        self.assertEqual((rc, out["gap"]["waiting"]), (3, ["torn.json (unreadable)"]))
        self.assertEqual(self.beat()[0], 0)
        self.assertTrue(os.path.exists(os.path.join(self.root, "waiters", "torn.json")), "a heartbeat leaves it")

    def test_every_other_admission_check_comes_before_the_gap(self) -> None:
        self.beat()
        self.window("w1")
        self.conclude("w1")
        with open(os.path.join(self.root, "HALT"), "w") as f:
            f.write("2026-10-18T00:00:00Z id=h1 unit\n")
        rc, _, err = self.window("w2")
        self.assertEqual(rc, 1)
        self.assertIn("fleet halted", err)

    def test_a_conclusion_is_stamped_after_the_records_it_restores(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.window("w1")
        self.conclude("w1")
        records = {r["request_id"]: r for r in self.call("list", {})[1]}
        concluded, restored = records["w1"], records["s"]
        self.assertGreaterEqual(concluded["updated_at"], restored["updated_at"])
        self.assertEqual(concluded["history"][-1]["at"], concluded["updated_at"])

    def test_a_retried_window_never_waits(self) -> None:
        self.beat()
        self.window("w1")
        self.conclude("w1")
        self.assertEqual(self.window("w2", gap=0)[0], 0)
        rc, out, _ = self.window("w2")
        self.assertEqual((rc, out["request_id"], out["state"]), (0, "w2", "launching"))

    def test_a_gap_is_a_whole_number_and_a_corrupt_conclusion_time_refuses(self) -> None:
        for bad in (True, -1, "60", 1.5):
            rc, _, err = self.window("w", gap=bad)  # type: ignore[arg-type]
            self.assertEqual((rc, err), (1, "EXECUTION REFUSED: a window's gap must be a whole number of seconds\n"), bad)
        rc, _, err = self.call("window", {"box": "mac", "request": request("w", kind="measurement"), "wait": 1})
        self.assertEqual((rc, err), (1, "EXECUTION REFUSED: window payload must be {box, request}, with an optional gap"
                                        " and deadline\n"))
        self.beat()
        self.window("w1", gap=0)
        self.conclude("w1")
        self.age("w1", "yesterday")
        rc, _, err = self.window("w2")
        self.assertEqual(rc, 1)
        self.assertIn("w1: updated_at 'yesterday' is no ISO 8601 time, so the gap after it cannot be measured", err)


class Waiters(RegistryCase):
    """ludics-lite#719: ``wait`` records a heartbeat outside the executions and answers as ``list``."""

    def waiter(self, **change: object) -> dict[str, object]:
        base: dict[str, object] = {"box": "mac", "id": "rog-7", "command": "make test", "ttl": 45}
        base.update(change)
        return base

    def read(self, identity: str = "rog-7") -> dict[str, Any]:
        with open(os.path.join(self.root, "waiters", f"{identity}.json")) as f:
            return json.load(f)

    def test_a_heartbeat_answers_with_the_listing_and_records_the_waiter_until_its_expiry(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        rc, out, err = self.call("wait", {"waiter": self.waiter(), "active": True, "compact": True})
        self.assertEqual((rc, err, [r["request_id"] for r in out]), (0, "", ["s"]))
        self.assertNotIn("history", out[0], "the list options apply")
        data = self.read()
        self.assertEqual((data["box"], data["id"], data["command"]), ("mac", "rog-7", "make test"))
        seen, expires = (datetime.fromisoformat(data[key]) for key in ("seen", "expires"))
        self.assertEqual((expires - seen).total_seconds(), 45)
        self.assertEqual(os.listdir(os.path.join(self.root, "executions")), ["s.json"], "no record written")

    def test_a_heartbeat_removes_the_expired_waiters_and_keeps_the_rest(self) -> None:
        self.call("wait", {"waiter": self.waiter(id="old")})
        self.call("wait", {"waiter": self.waiter(id="live", ttl=3600)})
        path = os.path.join(self.root, "waiters", "old.json")
        with open(path) as f:
            data = json.load(f)
        data["expires"] = "2026-01-01T00:00:00+00:00"
        with open(path, "w") as f:
            json.dump(data, f)
        self.assertEqual(self.call("wait", {"waiter": self.waiter()})[0], 0)
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "waiters"))), [".lock", "live.json", "rog-7.json"])

    def test_a_waiter_is_validated_whole(self) -> None:
        cases: list[tuple[object, str]] = [
            ({}, "a wait payload is {waiter, ...list options}"),
            ({"waiter": self.waiter(extra=1)}, "a waiter is {box or request, id, command, ttl}"),
            ({"waiter": self.waiter(request="s")}, "a waiter is {box or request, id, command, ttl}"),
            ({"waiter": {"id": "x", "command": "c", "ttl": 9}}, "a waiter is {box or request, id, command, ttl}"),
            ({"waiter": self.waiter(id="../x")}, "invalid waiter id"),
            ({"waiter": self.waiter(command=" ")}, "command must be a nonempty string"),
            ({"waiter": self.waiter(ttl=0)}, "a waiter's ttl must be a whole number of seconds from 1 to 3600"),
            ({"waiter": self.waiter(ttl=True)}, "a waiter's ttl must be a whole number of seconds from 1 to 3600"),
            ({"waiter": self.waiter(box="rgo")}, "waiter box rgo: no FLEET_BOXES entry (mac) is that box"),
            ({"waiter": self.waiter(), "verbose": True}, "list options must be active/compact booleans and a host"),
        ]
        for payload, why in cases:
            rc, _, err = self.call("wait", payload)
            self.assertEqual(rc, 1, payload)
            self.assertIn(why, err, payload)
        self.assertEqual(self.call("wait", {"waiter": self.waiter(box="MAC")})[0], 0, "a roster entry by case")

    def test_removal_and_renewal_are_serialized_under_the_waiters_lock(self) -> None:
        # Local review of #719: a removal racing a renewal could delete the renewed heartbeat.
        os.makedirs(os.path.join(self.root, "waiters"))
        lock = os.open(os.path.join(self.root, "waiters", ".lock"), os.O_CREAT | os.O_RDWR, 0o644)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX)
        results: list[int] = []
        thread = threading.Thread(target=lambda: results.append(self.call("wait", {"waiter": self.waiter()})[0]))
        thread.start()
        thread.join(0.5)
        self.assertEqual((results, os.listdir(os.path.join(self.root, "waiters"))), ([], [".lock"]), "it waits")
        fcntl.flock(lock, fcntl.LOCK_UN)
        thread.join(10)
        self.assertEqual(results, [0])
        self.assertTrue(os.path.exists(os.path.join(self.root, "waiters", "rog-7.json")))

    def test_a_leg_names_its_request_and_waits_for_that_records_box(self) -> None:
        # Round 1 of #736: a leg learns its box from the read that finds its record suspended.
        self.assertEqual(self.call("run", request("s", standing=True, execution_host="rog"), boxes="mac rog")[0], 0)
        waiter = {"request": "s", "id": "agent-9", "command": "tools/check.sh", "ttl": 45}
        rc, out, _ = self.call("wait", {"waiter": waiter}, boxes="mac rog")
        self.assertEqual((rc, [r["request_id"] for r in out]), (0, ["s"]))
        self.assertEqual(self.read("agent-9")["box"], "rog")
        rc, out, _ = self.call("wait", {"waiter": {**waiter, "request": "nobody", "id": "agent-10"}}, boxes="mac rog")
        self.assertEqual(rc, 0, "an unknown request is the leg's to refuse, on the listing")
        self.assertFalse(os.path.exists(os.path.join(self.root, "waiters", "agent-10.json")), "and nobody waits")

    def test_a_waiter_that_is_done_removes_its_heartbeat(self) -> None:
        # Round 2 of #736: a batch that holds its slot, or was refused, no longer needs the gap.
        self.call("wait", {"waiter": self.waiter()})
        self.call("wait", {"waiter": self.waiter(id="other")})
        rc, out, _ = self.call("wait", {"waiter": {"id": "rog-7", "done": True}})
        self.assertEqual((rc, out), (0, []))
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "waiters"))), [".lock", "other.json"])
        self.assertEqual(self.call("wait", {"waiter": {"id": "rog-7", "done": True}})[0], 0, "a repeat is no error")
        for bad in ({"id": "rog-7", "done": False}, {"id": "../x", "done": True}, {"id": 7, "done": True}):
            rc, _, err = self.call("wait", {"waiter": bad})
            self.assertEqual((rc, err), (1, "EXECUTION REFUSED: a waiter that is done is {id, done: true}\n"), bad)

    def test_a_fresh_anchor_with_no_state_root_answers_a_heartbeat(self) -> None:
        # Round 5 of #736: `wait` takes no lease, so nothing has created the state root yet.
        shutil.rmtree(self.root)
        rc, out, _ = self.call("wait", {"waiter": self.waiter()})
        self.assertEqual((rc, out), (0, []))
        self.assertEqual(self.read()["id"], "rog-7")
        shutil.rmtree(self.root)
        self.assertEqual(self.call("wait", {"waiter": {"id": "rog-7", "done": True}})[0], 0)
        os.makedirs(self.root, exist_ok=True)

    def test_a_waiter_file_gone_mid_scan_is_nobody_waiting(self) -> None:
        # Round 5 of #736: a release between the listing and the read is not an unreadable file.
        self.call("wait", {"waiter": self.waiter()})
        directory = registry.Path(self.root) / "waiters"
        real = registry.Path.read_text

        def vanishing(path: registry.Path, *args: Any, **kwargs: Any) -> str:
            if path.name == "rog-7.json":
                path.unlink()
            return real(path, *args, **kwargs)

        with mock.patch.object(registry.Path, "read_text", vanishing):
            self.assertEqual(registry.fresh_waiters(directory, "mac", "", datetime.now(timezone.utc)), [])

    def test_a_heartbeat_and_a_windows_admission_cannot_pass_each_other(self) -> None:
        # Round 6 of #736: both take waiters/.lock -- the window from its waiter check through its
        # publication, the heartbeat through the listing it answers with, read after it.
        self.assertEqual(self.call("run", request("m", kind="measurement"))[0], 0)
        self.assertEqual(self.call("conclude", {"request_id": "m", "verdict": "not-launched", "log": "/dev/null",
                                                "evidence": "unit"})[0], 0)
        os.makedirs(os.path.join(self.root, "waiters"), exist_ok=True)
        lock = os.open(os.path.join(self.root, "waiters", ".lock"), os.O_CREAT | os.O_RDWR, 0o644)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX)
        answers: list[tuple[int, Any, str]] = []
        window = threading.Thread(target=lambda: answers.append(self.call(
            "window", {"box": "mac", "request": request("w", kind="measurement"), "gap": 60})))
        window.start()
        window.join(0.5)
        self.assertEqual(answers, [], "the window waits for the lock before it reads the waiters")
        fcntl.flock(lock, fcntl.LOCK_UN)
        window.join(10)
        self.assertEqual(answers[0][0], 0, "nobody was waiting: it opened")
        rc, out, _ = self.call("wait", {"waiter": self.waiter(), "active": True})
        self.assertEqual((rc, [r["request_id"] for r in out]), (0, ["w"]), "the heartbeat's listing sees the window")

    def test_a_long_command_is_cut_to_300_characters(self) -> None:
        self.call("wait", {"waiter": self.waiter(command="x" * 400)})
        self.assertEqual(len(self.read()["command"]), 300)


class WindowDeadline(RegistryCase):
    """THE WINDOW'S DEADLINE (ludics-lite#737): a window's payload may carry the seconds by which it will
    be concluded; the record keeps them and the moment they end, fixed for its life."""

    def window(self, identity: str = "w", extra: dict[str, object] | None = None) -> tuple[int, Any, str]:
        return self.call("window", {"box": "mac", "request": request(identity, kind="measurement"), **(extra or {})})

    def test_the_window_records_its_deadline_from_its_opening(self) -> None:
        before = datetime.now(timezone.utc)
        rc, out, _ = self.window(extra={"deadline": 7200})
        self.assertEqual((rc, out["deadline"]), (0, 7200))
        due = datetime.fromisoformat(out["deadline_at"])
        self.assertLessEqual(abs((due - before).total_seconds() - 7200), 5)
        self.assertNotIn("deadline", out["request"], "beside the request, never in it")
        rc, listed, _ = self.call("list", {"active": True, "compact": True})
        self.assertEqual((rc, listed[0]["deadline_at"]), (0, out["deadline_at"]))
        # The listing gives the time left by the anchor's clock (round 1 of #771); the record keeps none.
        self.assertTrue(7190 <= listed[0]["deadline_left"] <= 7200, listed[0]["deadline_left"])
        self.assertNotIn("deadline_left", out)
        with open(os.path.join(self.root, "executions", "w.json")) as f:
            self.assertNotIn("deadline_left", json.load(f))
        rc, waited, _ = self.call("wait", {"waiter": {"box": "mac", "id": "r-1", "command": "x", "ttl": 30}})
        self.assertTrue(7190 <= waited[0]["deadline_left"] <= 7200)
        # A window without one records neither field.
        self.assertEqual(self.call("conclude", {"request_id": "w", "verdict": "not-launched", "log": "/dev/null",
                                                "evidence": "unit"})[0], 0)
        rc, out, _ = self.window("w2")
        self.assertEqual((rc, {"deadline", "deadline_at"} & set(out)), (0, set()))

    def test_a_retry_names_the_same_deadline_and_never_moves_it(self) -> None:
        _, first, _ = self.window(extra={"deadline": 600})
        rc, again, _ = self.window(extra={"deadline": 600})
        self.assertEqual((rc, again["deadline_at"]), (0, first["deadline_at"]))
        others: tuple[dict[str, object], ...] = ({"deadline": 900}, {})
        for other in others:
            rc, _, err = self.window(extra=other)
            self.assertEqual(rc, 1, other)
            self.assertIn("request_id already names a window with a different deadline (600)", err)
        self.assertEqual(self.window("w2")[0], 1, "one window per box, as ever")

    def test_a_deadline_is_a_positive_whole_number_and_only_a_windows(self) -> None:
        # A week at most (round 1 of #771): a larger one overflowed the datetime, a traceback.
        for bad in (True, 0, -1, "60", 1.5, None, 7 * 24 * 3600 + 1, 10**12):
            rc, _, err = self.window(extra={"deadline": bad})
            self.assertEqual(rc, 1, bad)
            self.assertRegex(err, r"\AEXECUTION REFUSED: a window's deadline must be a whole number of seconds from 1"
                                  r" to 604800, not \S+\n\Z")
        rc, _, err = self.call("run", {**request("m", kind="measurement"), "deadline": 60})
        self.assertEqual(rc, 1)
        self.assertEqual(err, "EXECUTION REFUSED: unknown reservation fields or invalid request\n", "only a window's")
        self.assertEqual(self.window(extra={"deadline": 7 * 24 * 3600})[0], 0)

    def test_a_corrupt_deadline_blocks_the_ledger(self) -> None:
        self.window(extra={"deadline": 60})
        path = os.path.join(self.root, "executions", "w.json")
        # Round 2 of #771: deadline_at is exactly created_at + deadline, so no ledger edit lists past the cap.
        for corrupt in ({"deadline_at": "soon"}, {"deadline_at": "2099-01-01T00:00:00"}, {"deadline": 0},
                        {"deadline": None}, {"deadline_at": "9999-12-31T23:59:59+00:00"}, {"deadline": 61}):
            with open(path) as f:
                data = json.load(f)
            good = dict(data)
            data.update(corrupt)
            data = {key: value for key, value in data.items() if value is not None}
            with open(path, "w") as f:
                json.dump(data, f)
            rc, _, err = self.call("list", {})
            self.assertEqual(rc, 1, corrupt)
            self.assertIn("invalid window deadline", err)
            with open(path, "w") as f:
                json.dump(good, f)
        self.assertEqual(self.call("list", {})[0], 0)


READER = """import runpy, sys
print("started", flush=True)
path, root = sys.argv[1], sys.argv[2]
sys.argv = ["registry", root, "list", "x", "x", '{"compact": true}', "mac"]
runpy.run_path(path)
"""


class Snapshot(RegistryCase):
    """THE SNAPSHOT (ludics-lite#711): a listing never sees a window's opening or conclusion half done.
    The writer runs here, in process, and pauses after the first record it publishes; a reader
    PROGRAM started there gets two seconds to answer. Without the lock it answers mid-write, and its
    listing shows the window open beside the standing record not suspended."""

    def write_and_read_between(self, action: str, payload: object) -> list[dict[str, Any]]:
        readers: list[subprocess.Popen[str]] = []
        real = os.replace

        program = os.path.abspath(registry.__file__ or "")

        def replace(source: str, target: str) -> None:
            real(source, target)
            if readers or os.path.basename(os.path.dirname(str(target))) != "executions":
                return
            reader = subprocess.Popen([sys.executable, "-c", READER, program, self.root],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            readers.append(reader)
            assert reader.stdout is not None
            self.assertEqual(reader.stdout.readline(), "started\n")
            with contextlib.suppress(subprocess.TimeoutExpired):
                reader.wait(2)   # the torn moment: a reader that does not wait for the write answers now

        with mock.patch("os.replace", side_effect=replace):
            self.assertEqual(self.call(action, payload)[0], 0)
        self.assertEqual(len(readers), 1, "the write published a record")
        out, err = readers[0].communicate(timeout=60)
        self.assertEqual(readers[0].returncode, 0, err)
        return json.loads(out)

    def assert_whole(self, listed: list[dict[str, Any]]) -> None:
        records = {record["request_id"]: record for record in listed}
        window_open = records["w"]["state"] != "concluded"
        suspended = records["s"]["state"] == "suspended" and records["s"].get("suspended_by") == "w"
        self.assertEqual(window_open, suspended,
                         f"a torn listing: window w {records['w']['state']}, standing record s {records['s']['state']}")

    def test_a_listing_never_sees_a_window_half_open(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.assert_whole(self.write_and_read_between(
            "window", {"box": "mac", "request": request("w", kind="measurement")}))

    def test_a_listing_never_sees_a_window_half_concluded(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.assertEqual(self.call("window", {"box": "mac", "request": request("w", kind="measurement")})[0], 0)
        self.assert_whole(self.write_and_read_between(
            "conclude", {"request_id": "w", "verdict": "not-launched", "log": "/dev/null", "evidence": "unit"}))

    def hold(self, mode: int) -> None:
        descriptor = os.open(os.path.join(self.root, "executions.lock"), os.O_CREAT | os.O_RDWR, 0o644)
        self.addCleanup(os.close, descriptor)
        fcntl.flock(descriptor, mode)

    def test_readers_share_it_and_a_writer_waits_for_them_boundedly(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.hold(fcntl.LOCK_SH)
        with mock.patch.object(registry, "LOCK_WAIT", 0.2):
            self.assertEqual(self.call("list", {})[0], 0, "a listing shares it with another")
            self.assertEqual(self.call("wait", {"waiter": {"box": "mac", "id": "r-1", "command": "x", "ttl": 30}})[0], 0)
            rc, _, err = self.call("run", request("t", standing=True))
        self.assertEqual(rc, 1)
        self.assertRegex(err, r"\AEXECUTION REFUSED: the registry is busy: another action has held \S+executions.lock"
                              r" for 0.2s \(ludics-lite#711\)")
        self.assertFalse(os.path.exists(os.path.join(self.root, "executions", "t.json")), "nothing written")

    def test_a_writer_keeps_readers_out_and_releases_on_every_outcome(self) -> None:
        self.hold(fcntl.LOCK_EX)
        with mock.patch.object(registry, "LOCK_WAIT", 0.2):
            rc, _, err = self.call("list", {})
        self.assertEqual(rc, 1)
        self.assertIn("the registry is busy", err)
        self.assertEqual(registry.SNAPSHOT_LOCKS, [])

    def test_the_time_left_rounds_up_until_the_deadline_passes(self) -> None:
        # Round 3 of #771: truncation let a waiter give up up to a second before the deadline.
        now = datetime(2026, 10, 22, 12, 0, 0, tzinfo=timezone.utc)
        for at, left in (("2026-10-22T12:00:00.100000+00:00", 1), ("2026-10-22T12:00:01+00:00", 1),
                         ("2026-10-22T12:00:01.000001+00:00", 2), ("2026-10-22T12:00:00+00:00", 0),
                         ("2026-10-22T11:59:00+00:00", 0)):
            self.assertEqual(registry.time_left(at, now), left, at)

    def test_nothing_is_said_while_the_lock_is_held(self) -> None:
        # Round 2 of #771: a caller that stops reading its pipe must stall only its own action, so
        # every line -- a listing, a written record, a refusal -- is written once the lock is free.
        held_at_write: list[bool] = []

        class Watching(io.StringIO):
            def write(self, text: str) -> int:
                # Round 3 of #771: the heartbeat's waiters/.lock is released before anything is said too.
                held_at_write.append(bool(registry.SNAPSHOT_LOCKS) or bool(registry.WAITER_LOCKS))
                return super().write(text)

        argv = ["-", self.root, "", "owner", "token", "", "mac", "", ""]
        for action, payload in (("run", request("s", standing=True)), ("list", {}),
                                ("wait", {"waiter": {"box": "mac", "id": "r-1", "command": "x", "ttl": 30}}),
                                ("window", {"box": "mac", "request": request("w", kind="measurement"), "gap": 60}),
                                ("reserve", request("bad", kind="other"))):
            argv[2], argv[5] = action, json.dumps(payload)
            with contextlib.redirect_stdout(Watching()), contextlib.redirect_stderr(Watching()):
                registry.run(argv)
        self.assertTrue(held_at_write, "something was said")
        self.assertNotIn(True, held_at_write)

    def test_the_lock_is_released_after_a_refusal(self) -> None:
        self.assertEqual(self.call("reserve", request("bad", kind="other"))[0], 1)
        self.assertEqual(registry.SNAPSHOT_LOCKS, [])
        probe = os.open(os.path.join(self.root, "executions.lock"), os.O_RDWR)
        self.addCleanup(os.close, probe)
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)   # raises if anything still held it
        fcntl.flock(probe, fcntl.LOCK_UN)

    def test_the_snapshot_is_taken_before_the_waiters_lock(self) -> None:
        # The lock order (the header): `wait` and a window with a gap both take executions.lock first.
        order: list[str] = []
        snapshot, waiters = registry.lock_snapshot, registry.lock_waiters

        def take_snapshot(root: Any, shared: bool) -> None:
            order.append("snapshot shared" if shared else "snapshot exclusive")
            snapshot(root, shared)

        def take_waiters(directory: Any) -> None:
            order.append("waiters")
            waiters(directory)

        with mock.patch.object(registry, "lock_snapshot", take_snapshot), \
                mock.patch.object(registry, "lock_waiters", take_waiters):
            self.call("wait", {"waiter": {"box": "mac", "id": "r-1", "command": "x", "ttl": 30}})
            self.call("window", {"box": "mac", "request": request("w", kind="measurement"), "gap": 60})
        self.assertEqual(order, ["snapshot shared", "waiters", "snapshot exclusive", "waiters"])


if __name__ == "__main__":
    unittest.main()
