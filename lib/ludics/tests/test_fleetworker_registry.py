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


class WindowGap(RegistryCase):
    """ludics-lite#667: a new window inside the gap after its box's last measurement, while standing
    records are outstanding there, is answered exit 3 with the seconds to wait, and nothing written."""

    def window(self, identity: str, gap: int | None = 60, boxes: str = "mac") -> tuple[int, Any, str]:
        payload: dict[str, object] = {"box": "mac", "request": request(identity, kind="measurement")}
        if gap is not None:
            payload["gap"] = gap
        return self.call("window", payload, boxes=boxes)

    def conclude(self, identity: str) -> None:
        self.assertEqual(self.call("conclude", {"request_id": identity, "verdict": "not-launched", "log": "/dev/null",
                                                "evidence": "unit"})[0], 0)

    def age(self, identity: str, at: str) -> None:
        path = os.path.join(self.root, "executions", f"{identity}.json")
        with open(path) as f:
            data = json.load(f)
        data["updated_at"] = at
        with open(path, "w") as f:
            json.dump(data, f)

    def test_the_first_window_opens_and_the_next_one_waits_out_the_gap(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.assertEqual(self.window("w1")[0], 0, "no measurement concluded on the box: no gap")
        self.conclude("w1")
        rc, out, err = self.window("w2")
        self.assertEqual(rc, 3)
        gap = out["gap"]
        self.assertEqual((gap["box"], gap["after"], gap["gap"], gap["standing"]), ("mac", "w1", 60, ["s"]))
        self.assertTrue(0 < gap["wait"] <= 60 and gap["ago"] >= 0, gap)
        self.assertRegex(err, r"\AEXECUTION WINDOW mac: measurement w1 concluded on mac [0-9]+s ago, and standing"
                              r" reservations are outstanding there \(s\), whose batches may be waiting: they get 60s"
                              r" to take its slots before the next window \(ludics-lite#667\); [0-9]+s to go\n\Z")
        self.assertFalse(os.path.exists(os.path.join(self.root, "executions", "w2.json")), "nothing written")
        self.assertEqual(self.call("list", {"active": True})[1][0]["state"], "launching", "s is not suspended")

    def test_no_gap_asked_no_standing_record_or_a_gap_already_past_opens_at_once(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
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
        self.conclude("w4")
        self.conclude("s")
        self.assertEqual(self.call("run", request("plain", kind="measurement"))[0], 0)
        self.conclude("plain")
        self.assertEqual(self.call("run", request("s2", standing=True, execution_host="rog"), boxes="mac rog")[0], 0)
        self.assertEqual(self.window("w5", boxes="mac rog")[0], 0, "no standing record on this box: nobody to wait for")

    def test_any_measurement_on_the_box_starts_the_gap_and_another_boxs_does_not(self) -> None:
        self.assertEqual(self.call("run", request("plain", kind="measurement"))[0], 0)
        self.conclude("plain")
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        rc, out, _ = self.window("w1")
        self.assertEqual((rc, out["gap"]["after"]), (3, "plain"))
        self.age("plain", "2026-01-01T00:00:00+00:00")
        self.assertEqual(self.call("run", request("r", kind="measurement", execution_host="rog"), boxes="mac rog")[0], 0)
        self.conclude("r")
        self.assertEqual(self.window("w2", boxes="mac rog")[0], 0)

    def test_a_retried_window_never_waits(self) -> None:
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
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
        self.assertEqual((rc, err), (1, "EXECUTION REFUSED: window payload must be {box, request} or {box, request, gap}\n"))
        self.assertEqual(self.call("run", request("s", standing=True))[0], 0)
        self.window("w1", gap=0)
        self.conclude("w1")
        self.age("w1", "yesterday")
        rc, _, err = self.window("w2")
        self.assertEqual(rc, 1)
        self.assertIn("w1: updated_at 'yesterday' is no ISO 8601 time, so the gap after it cannot be measured", err)


if __name__ == "__main__":
    unittest.main()
