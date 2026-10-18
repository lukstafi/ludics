"""ludics.fleetworker.execution and gate: the near side's reading of the registry and of a run."""

import contextlib
import io
import json
import os
import tempfile
import time
import unittest
from typing import Any
from unittest import mock

from ludics import cli, proc
from ludics.fleetworker import execution, revision
from ludics.fleetworker.config import load_config
from ludics.fleetworker.execution import (
    Payload,
    Refusal,
    Unreadable,
    basename,
    facts_of,
    records_of,
    refresh_host,
    run_verdict,
    window_payload,
)
from ludics.fleetworker.gate import integration_rows
from ludics.fleetworker.transport import PAYLOAD_ON_FD
from ludics.tests.fake import Answer, FakeTool

SHA = "a" * 40


def record(request_id: str, request: dict[str, object] | None = None, **fields: object) -> dict[str, Any]:
    req: dict[str, object] = {"request_id": request_id, "repository": "example/project", "transport": "coordinator",
                              "kind": "correctness", "integration": True, "execution_host": "testbox"}
    req.update(request or {})
    base: dict[str, Any] = {"request_id": request_id, "state": "concluded", "verdict": "pass",
                            "observed_sha": SHA, "updated_at": "2026-10-05T00:00:00+00:00", "request": req}
    base.update(fields)
    return base


class DispatchedRecord(unittest.TestCase):
    """The refresh after a dispatch reads the execution host off the dispatched record; a record
    it cannot read is a loud REFRESH FAILED line, the dispatch standing (moved here from the shell
    suite, whose case broke the reader by putting a failing jq first on PATH)."""

    def test_an_unreadable_record_is_a_loud_refresh_failure_not_a_silent_skip(self) -> None:
        for text in ("not json", "", '{"request": {}}', '{"request": {"execution_host": ""}}'):
            host = refresh_host(text)
            self.assertIsInstance(host, Unreadable, text)
            assert isinstance(host, Unreadable)
            self.assertTrue(host.line.startswith("REFRESH FAILED: cannot read the execution host from the dispatched record ("))
            self.assertTrue(host.line.endswith("); run fleet-worker.sh refresh <host> by hand"))

    def test_execution_refresh_prints_the_failure_on_stderr_and_runs_nothing(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="h")
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            execution.execution_refresh(cfg, "not json")
        self.assertIn("REFRESH FAILED: cannot read the execution host", err.getvalue())
        self.assertEqual(out.getvalue(), "")

    def test_a_record_queued_behind_a_window_defers_the_refresh(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="h")
        text = json.dumps({"state": "suspended", "suspended_by": "win-1", "request": {"execution_host": "rog"}})
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            execution.execution_refresh(cfg, text)
        self.assertEqual(
            err.getvalue(),
            "REFRESH DEFERRED rog: measurement window win-1 is measuring there; run fleet-worker.sh refresh rog once it concludes\n",
        )


class Conclusions(unittest.TestCase):
    def test_test_run_exit_vocabulary(self) -> None:
        for code, want in (("0", "pass"), ("142", "timeout"), ("124", "fail"), ("130", "cancelled"), ("143", "cancelled"), ("1", "fail"), ("00", "fail")):
            self.assertEqual(run_verdict(code, timeout_codes=("142",)), want, code)
        self.assertEqual(run_verdict("124", timeout_codes=("124", "142")), "timeout")

    def test_a_stopped_bg_run_concludes_cancelled_and_nothing_else_does(self) -> None:
        """#638: the far side's ``status=stopped`` (bg-run.sh wait's STOPPED) is cancelled, with no
        status read; any other fact beside it is unreadable, not a conclusion."""
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="testbox")
        with tempfile.NamedTemporaryFile("w", suffix=".sh") as bgrun:
            def conclude(out: str) -> execution.Conclusion:
                with mock.patch.object(execution, "run_on", return_value=execution.Done(0, out)):
                    return execution.conclude_from_bg_run(
                        cfg, "/runs/run-3", "req-1", "testbox", "testbox", SHA, "", "", bgrun.name)
            done = conclude("status=stopped\n")
            assert isinstance(done, Payload), done
            payload = json.loads(done.json)
            self.assertEqual(payload["verdict"], "cancelled")
            self.assertIn("/runs/run-3 on testbox: STOPPED by bg-run.sh stop before the command returned", payload["evidence"])
            self.assertEqual(payload["handle"], "bg-run:testbox:/runs/run-3")
            for out in ("status=stopped\nrc=0\nsentinel=", "status=STOPPED", "status=stopped\nstatus=rc"):
                refused = conclude(out)
                assert isinstance(refused, Refusal), (out, refused)
                self.assertIn("FROM-BG-RUN REFUSED: unreadable run facts", refused.text)

    def test_facts_are_read_by_key_as_sed_reads_them(self) -> None:
        facts = "exit=0\nwt=/w t\nhead=" + SHA + "\nrecord=none"
        self.assertEqual((facts_of(facts, "exit"), facts_of(facts, "wt"), facts_of(facts, "record")), ("0", "/w t", "none"))
        self.assertEqual(facts_of(facts, "nope"), "")

    def test_the_handle_names_the_run_directory_trailing_slash_or_not(self) -> None:
        self.assertEqual(basename("/runs/20260915T201414Z-1"), "20260915T201414Z-1")
        self.assertEqual(basename("/runs/x/"), "x")

    def test_a_refusal_prints_its_text_and_exits_with_its_status(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(execution.cli.Exit) as caught:
            execution.concluded(Refusal("FROM-RUN UNREACHABLE far: nothing concluded", 4))
        self.assertEqual((caught.exception.rc, out.getvalue()), (4, "FROM-RUN UNREACHABLE far: nothing concluded\n"))
        self.assertEqual(execution.concluded(Payload('{"a":1}')), '{"a":1}')

    def test_a_listing_must_be_an_array_of_objects(self) -> None:
        self.assertEqual(records_of("[]"), [])
        for text in ("{}", "[1]", "nope", ""):
            self.assertIsNone(records_of(text), text)


def run_text(**over: str) -> str:
    """FROM_RUN's output for a finished record launched clean at ``"b" * 40``, ``over`` replacing facts."""
    base = {"exit": "0", "wt": "/w t", "gone": "0", "runner": "0", "alive": "", "pair": "both", "dirty": "0",
            "rel": "same", "whead": "b" * 40, "known": "1", "launched": "b" * 40}
    base.update(over)
    return "dir=1\n" + "\n".join(f"{k}={v}" for k, v in base.items())


def run_record(**over: str) -> dict[str, str]:
    facts = execution.run_facts(run_text(**over))
    assert facts is not None, over
    return facts


class RunFacts(unittest.TestCase):
    """#657: FROM_RUN prints a test-run.sh record's facts and refuses nothing; the reading is fail-closed."""

    def test_a_record_reads_key_by_key(self) -> None:
        facts = run_record()
        self.assertEqual((facts["dir"], facts["exit"], facts["wt"], facts["pair"], facts["launched"]),
                         ("1", "0", "/w t", "both", "b" * 40))
        self.assertEqual(execution.run_facts("dir=0"), {"dir": "0"})
        self.assertEqual(execution.run_facts("dir=1\nmissing=exit"), {"dir": "1", "missing": "exit"})

    def test_anything_but_its_own_shape_is_unreadable(self) -> None:
        full = run_text()
        for text in ("", "dir=2", "dir=1\nmissing=pid", "dir=1\nmissing=exit\nexit=0", "dir=0\nexit=0",
                     full.replace("gone=0\nrunner", "runner"), full.replace("\nwt=", "\nwt=x\nwt="),
                     full.replace("exit=0\nwt", "wt=/w t\nexit=0\nwt"), "junk\n" + full):
            self.assertIsNone(execution.run_facts(text), text)
        for over in ({"gone": "2"}, {"runner": "x"}, {"alive": "1 2"}, {"pair": "odd"}, {"dirty": "-1"},
                     {"rel": "near"}, {"known": "yes"}, {"rel": ""}, {"pair": "none"}, {"launched": "B" * 40}):
            self.assertIsNone(execution.run_facts(run_text(**over)), over)

    def test_launched_is_last_and_whole_so_a_head_file_injects_no_fact(self) -> None:
        facts = execution.run_facts(run_text(rel="", launched="b" * 40 + "\nexit=1\nknown=0"))
        assert facts is not None
        self.assertEqual((facts["exit"], facts["known"]), ("0", "1"))
        refused = execution.run_unfinished(facts, "/r", "box")
        assert refused is not None
        self.assertIn("/r/head holds 'bbbb", refused.text)
        self.assertIn("not one commit ID: a malformed record", refused.text)


class FromRunForms(unittest.TestCase):
    """#657's negative controls: on the one far side's facts, each form refuses what it refused
    before -- ``run_unfinished`` for both, ``from_run_refusal`` for --from-run alone."""

    SHA = "b" * 40
    UNFINISHED = (
        ({"dir": "0"}, "no run directory /r on box"),
        ({"dir": "1", "missing": "exit"}, "/r has no exit (the run is unfinished"),
        (run_record(exit="x"), "/r/exit holds 'x', not a status"),
        (run_record(exit=""), "/r/exit holds '', not a status"),
        (run_record(wt="", gone="1", runner="none", whead=""), "/r/wt names no worktree"),
        (run_record(runner="3"), "tools/test-run.sh status /r exit 3: not a finished run"),
        (run_record(runner="none", alive="42"), "supervisor pid 42 of /r is still alive"),
        (run_record(pair="irregular", rel="", launched=""), "/r/head or /r/dirty is not a regular file"),
        (run_record(pair="head", rel="", launched=""), "/r has a head but no dirty"),
        (run_record(pair="dirty", rel="", launched=""), "/r has a dirty but no head"),
        (run_record(launched="b" * 39, rel="same"), "/r/head holds '" + "b" * 39 + "', not one commit ID"),
        (run_record(launched="not-a-sha", rel=""), "/r/head holds 'not-a-sha', not one commit ID"),
    )

    def test_both_forms_refuse_a_record_with_no_verdict_or_a_malformed_one(self) -> None:
        for facts, want in self.UNFINISHED:
            for refused in (execution.from_run_refusal(facts, "/r", "box", self.SHA),
                            execution.standing_run_clause(facts, "/r", "box")):
                assert isinstance(refused, Refusal), (facts, refused)
                self.assertEqual(refused.rc, 1)
                self.assertTrue(refused.text.startswith("FROM-RUN REFUSED: "), refused.text)
                self.assertIn(want, refused.text)

    def test_from_run_refuses_what_is_no_evidence_for_one_commit_and_standing_records_it(self) -> None:
        other = "c" * 40
        for over, want in (
            ({"gone": "1", "runner": "none", "whead": ""}, "recorded worktree /w t is gone"),
            ({"launched": other, "rel": "outside"}, f"/r/head records {other} as the revision launched, but the reported revision is {self.SHA}"),
            ({"launched": other, "rel": "ancestor"}, f"this run is evidence for {other}, not {self.SHA}"),
            ({"dirty": "2"}, "/r/dirty lists 2 uncommitted path(s) at launch"),
            ({"whead": ""}, "cannot read HEAD of /w t"),
            ({"known": "0"}, f"/w t does not contain the reported revision {self.SHA}"),
        ):
            refused = execution.from_run_refusal(run_record(**over), "/r", "box", self.SHA)
            assert refused is not None, over
            self.assertIn(want, refused.text)
            self.assertNotIsInstance(execution.standing_run_clause(run_record(**over), "/r", "box"), Refusal)
        self.assertIsNone(execution.from_run_refusal(run_record(), "/r", "box", self.SHA))
        self.assertIsNone(execution.from_run_refusal(run_record(pair="none", rel="", launched=""), "/r", "box", self.SHA))

    def test_from_run_concludes_a_clean_record_as_before(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="testbox")
        moved = "d" * 40
        with mock.patch.object(execution, "run_on", return_value=execution.Done(0, run_text(whead=moved) + "\n")) as ran:
            done = execution.conclude_from_run(cfg, "/runs/r-1", "req", "testbox", self.SHA, "")
        self.assertEqual(ran.call_args.args[3], ["/runs/r-1", self.SHA, ""])
        assert isinstance(done, Payload), done
        data = json.loads(done.json)
        self.assertEqual((data["verdict"], data["observed_sha"], data["remote_checkout"], data["handle"], data["execution_host"]),
                         ("pass", self.SHA, "/w t", "test-run:r-1", "testbox"))
        self.assertEqual(data["evidence"], f"test-run.sh record /runs/r-1 on testbox: exit 0 published, no process remains;"
                         f" launched at {self.SHA} on a clean tree (the record's head and dirty); checkout head is now {moved}")
        for out, rc in (("dir=1\nexit=0", 0), ("", 1)):
            with mock.patch.object(execution, "run_on", return_value=execution.Done(rc, out)):
                refused = execution.conclude_from_run(cfg, "/runs/r-1", "req", "testbox", self.SHA, "")
            assert isinstance(refused, Refusal), out
            self.assertIn("FROM-RUN REFUSED: unreadable record facts from testbox", refused.text)


class StandingHandback(unittest.TestCase):
    """``conclude --standing-handback`` (#605 item 3): what --from-run refuses becomes evidence."""

    RUN = "/runs/20261016T101010Z-1"

    @staticmethod
    def facts(**over: str) -> dict[str, str]:
        return run_record(**over)

    def clause(self, **over: str) -> tuple[str, str]:
        read = execution.standing_run_clause(self.facts(**over), self.RUN, "testbox")
        assert not isinstance(read, Refusal), read
        return read

    def test_the_verdict_is_the_records_exit(self) -> None:
        for code, want in (("0", "pass"), ("1", "fail"), ("142", "timeout"), ("143", "cancelled")):
            self.assertEqual(self.clause(exit=code)[0], want, code)

    def test_a_clean_run_at_observed_sha_says_so(self) -> None:
        self.assertEqual(self.clause()[1], f"last batch: test-run.sh record {self.RUN} on testbox, exit 0 (pass),"
                         f" launched at {'b' * 40}, observed_sha itself on a clean tree")

    def test_what_from_run_refuses_is_recorded(self) -> None:
        _, text = self.clause(dirty="3", rel="outside", gone="1", runner="none", whead="")
        self.assertIn("over 3 uncommitted path(s) its dirty lists", text)
        self.assertIn("not in observed_sha's history (rewritten by a rebase, or never pushed)", text)
        self.assertIn("its recorded worktree /w t is gone", text)
        self.assertIn("an ancestor of observed_sha", self.clause(rel="ancestor")[1])

    def test_a_record_naming_no_revision_says_so(self) -> None:
        _, text = self.clause(pair="none", launched="", dirty="0", rel="")
        self.assertIn("its record naming no launch revision", text)

    def test_a_malformed_record_is_refused(self) -> None:
        for over in ({"exit": ""}, {"exit": "x"}, {"wt": ""}, {"launched": "b" * 39}, {"launched": "b" * 41}):
            read = execution.standing_run_clause(self.facts(**over), self.RUN, "testbox")
            self.assertIsInstance(read, Refusal, over)

    def test_the_payload_without_a_run_carries_the_hand_backs_verdict(self) -> None:
        data = json.loads(execution.standing_handback("r-iterate", "testbox", "/w t", SHA, "all green", "fail", None))
        self.assertEqual((data["verdict"], data["observed_sha"], data["remote_checkout"], data["execution_host"]),
                         ("fail", SHA, "/w t", "testbox"))
        self.assertEqual(data["handle"], "standing-handback:r-iterate")
        self.assertTrue(data["log"])
        self.assertEqual(data["evidence"], "all green; standing hand-back, observed_sha read as HEAD of /w t on testbox;"
                         " verdict fail as the worker's hand-back reports it, no run record named")

    def test_the_payload_with_a_run_names_its_record(self) -> None:
        verdict, text = self.clause()
        data = json.loads(execution.standing_handback("r", "testbox", "/w t", SHA, "ok", verdict, (self.RUN, text)))
        self.assertEqual((data["handle"], data["log"]), ("test-run:20261016T101010Z-1", self.RUN + "/log"))
        self.assertTrue(data["evidence"].endswith("; " + text))

    def test_a_retry_reuses_the_recorded_conclusion_however_the_box_changed(self) -> None:
        verdict, text = self.clause()
        landed: dict[str, Any] = json.loads(execution.standing_handback("r", "testbox", "/w t", SHA, "ok", verdict, (self.RUN, text)))
        del landed["execution_host"]  # the registry checks it and records the rest
        rec = {"state": "concluded", "history": [{"action": "conclude", "data": landed}]}
        again = execution.recorded_handback(rec, "r", "/w t", "testbox", "ok", self.RUN, "")
        self.assertEqual(json.loads(again or "{}"), landed)
        self.assertIsNotNone(execution.recorded_handback(rec, "r", "/w t", "testbox", "ok", self.RUN, "pass"))
        for call in (("r", "/w t", "testbox", "other words", self.RUN, ""), ("r", "/w t", "testbox", "ok", "/runs/other", ""),
                     ("r", "/w u", "testbox", "ok", self.RUN, ""), ("r", "/w t", "testbox", "ok", self.RUN, "fail"),
                     ("r", "/w t", "testbox", "ok", "", "pass")):
            self.assertIsNone(execution.recorded_handback(rec, *call), call)
        self.assertIsNone(execution.recorded_handback({**rec, "state": "running"}, "r", "/w t", "testbox", "ok", self.RUN, ""))


class Revisions(unittest.TestCase):
    """ludics-lite#561: a commit a payload names must exist in the request's repository on GitHub.
    No commit (422) and no repository (404) refuse (1); anything else is UNVERIFIED (4)."""

    GOOD = "c" * 40
    TYPO = "c" * 39 + "d"

    def test_a_commit_github_has_passes_and_the_call_names_the_repository(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(stdout=self.GOOD + "\n"))
            self.assertIsNone(revision.commit_refusal("o/r", "observed_sha", self.GOOD))
            self.assertEqual(gh.calls(), [["api", "--hostname", "github.com", f"repos/o/r/commits/{self.GOOD}", "-q", ".sha"]])

    def test_no_commit_refuses_naming_the_sha_and_where_it_was_checked(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(1, '{"status":"422"}', f"gh: No commit found for SHA: {self.TYPO} (HTTP 422)\n"))
            text, rc = revision.commit_refusal("o/r", "observed_sha", self.TYPO) or ("", 0)
        self.assertEqual(rc, 1)
        self.assertTrue(text.startswith(f"EXECUTION REFUSED: observed_sha {self.TYPO} is no commit of o/r (checked on GitHub: gh: No commit found"), text)

    def test_a_404_and_no_answer_are_unverified(self) -> None:
        with FakeTool("gh") as gh:
            # GitHub answers 404 for a private repository the token cannot see, too.
            gh.script(Answer(1, '{"status":"404"}', "gh: Not Found (HTTP 404)\n"))
            text, rc = revision.commit_refusal("o/r", "observed_sha", self.GOOD) or ("", 0)
            self.assertEqual(rc, 4)
            self.assertIn("(gh: Not Found (HTTP 404): no repository o/r, or one this box's gh token cannot see)", text)
            for answer in (Answer(1, "", "error connecting to api.github.com\ncheck your internet connection\n"),
                           Answer(1, "", "gh: Server Error (HTTP 502)\n"), Answer(1, "", "gh: Bad credentials (HTTP 401)\n"),
                           Answer(1, "", "unexpected end of JSON input\n"), Answer(4, "", "")):
                gh.script(answer)
                text, rc = revision.commit_refusal("o/r", "observed_sha", self.GOOD) or ("", 0)
                self.assertEqual(rc, 4, answer)
                self.assertTrue(text.startswith(f"EXECUTION UNVERIFIED github.com: observed_sha {self.GOOD} could not be checked in o/r ("), text)

    def test_a_422_that_is_not_no_commit_is_unverified(self) -> None:
        # GitHub's Get-a-commit also answers 422 for an endpoint it calls spammed.
        with FakeTool("gh") as gh:
            gh.script(Answer(1, "", "gh: Validation Failed: endpoint has been spammed (HTTP 422)\n"))
            _, rc = revision.commit_refusal("o/r", "observed_sha", self.GOOD) or ("", 0)
            self.assertEqual(rc, 4)
            gh.script(Answer(1, "", f"gh: No commit found for SHA: {self.TYPO} (HTTP 422)\n"))
            _, rc = revision.commit_refusal("o/r", "observed_sha", self.GOOD) or ("", 0)
            self.assertEqual(rc, 4, "a no-commit answer about another SHA proves nothing about this one")

    @unittest.skipIf(os.name == "nt", "the process-group kill is POSIX's")
    def test_a_call_that_never_returns_is_cut_at_the_bound_child_and_all(self) -> None:
        with FakeTool("gh") as gh:
            with open(os.path.join(gh.dir, "gh"), "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\nsleep 30\n")
            started = time.monotonic()
            text, rc = revision.commit_refusal("o/r", "observed_sha", self.GOOD, timeout=1) or ("", 0)
            self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(rc, 4)
        self.assertIn("(gh: no answer in 1s)", text)

    def test_another_commit_answered_is_refused(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(stdout=self.TYPO + "\n"))
            text, rc = revision.commit_refusal("o/r", "observed_sha", self.GOOD) or ("", 0)
        self.assertEqual(rc, 1)
        self.assertIn(f"to {self.TYPO}, not that commit", text)

    def test_what_github_cannot_answer_is_refused_without_asking(self) -> None:
        with FakeTool("gh") as gh:
            for repo, sha, want in (("not a repo", self.GOOD, "is not <owner>/<name>"), ("o/r", "e" * 64, "SHA-256")):
                text, rc = revision.commit_refusal(repo, "observed_sha", sha) or ("", 0)
                self.assertEqual(rc, 1)
                self.assertIn(want, text)
            self.assertEqual(gh.calls(), [])

    def test_requested_revision_reads_only_hex_words(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(stdout=self.GOOD + "\n"))
            for rev in ("origin/main", "master", "origin/claude/issue-1034-x", f"origin/{self.GOOD}", f"{self.GOOD}^"):
                self.assertIsNone(revision.request_refusal({"repository": "o/r", "requested_revision": rev}), rev)
            self.assertEqual(gh.calls(), [])
            self.assertIsNone(revision.request_refusal({"repository": "o/r", "requested_revision": f"{self.GOOD} plus working diff"}))
            self.assertEqual(gh.calls(), [["api", "--hostname", "github.com", f"repos/o/r/commits/{self.GOOD}", "-q", ".sha"]])
            gh.script(Answer(stdout=self.GOOD + "\n"))
            for rev in ("f8e0721f0", self.GOOD.upper(), self.GOOD + "c"):
                text, rc = revision.request_refusal({"repository": "o/r", "requested_revision": rev}) or ("", 0)
                self.assertEqual(rc, 1, rev)
                self.assertIn("is not a full commit ID", text)
            self.assertEqual(gh.calls(), [])
            for request in (None, "x", {"repository": "o/r"}, {"repository": 1, "requested_revision": self.GOOD}):
                self.assertIsNone(revision.request_refusal(request))
            # A request id the registry already holds is the registry's to judge: nothing is asked.
            asked: list[str] = []
            held = {"request_id": "r-1", "repository": "o/r", "requested_revision": "f8e0721f0"}
            self.assertIsNone(revision.request_refusal(held, exists=lambda rid: asked.append(rid) is None))
            self.assertEqual((asked, gh.calls()), (["r-1"], []))
            self.assertIsNone(revision.request_refusal({"repository": "o/r", "requested_revision": "main"}, exists=lambda rid: asked.append(rid) is None))
            self.assertEqual(asked, ["r-1"], "a revision with no commit claim reads no record")


class BranchHead(unittest.TestCase):
    """ludics-lite#558: a head-of request's branch, read off GitHub at assignment."""

    GOOD = "c" * 40

    def test_the_branch_head_is_asked_of_the_exact_ref(self) -> None:
        with FakeTool("gh") as gh:
            gh.script(Answer(stdout=self.GOOD + "\n"))
            self.assertEqual(revision.branch_head("o/r", "claude/w1015-558"), self.GOOD)
            self.assertEqual(gh.calls(), [["api", "--hostname", "github.com", "repos/o/r/git/ref/heads/claude/w1015-558", "-q", ".object.sha"]])

    def test_what_github_answers_otherwise(self) -> None:
        with FakeTool("gh") as gh:
            for answer, rc, want in (
                (Answer(rc=1, stdout='{"message":"Not Found"}', stderr="gh: Not Found (HTTP 404)\n"), 1, "GitHub has no branch topic in o/r"),
                (Answer(stdout="[]\n"), 1, "not one commit"),
                (Answer(rc=1, stderr="error connecting to api.github.com\n"), 4, "EXECUTION UNVERIFIED github.com: head-of:topic could not be resolved"),
            ):
                gh.script(answer)
                result = revision.branch_head("o/r", "topic")
                self.assertIsInstance(result, tuple)
                assert isinstance(result, tuple)
                self.assertEqual(result[1], rc, want)
                self.assertIn(want, result[0])
            gh.script(Answer(stdout=self.GOOD + "\n"))
            self.assertEqual(revision.branch_head("not a repo", "topic"), (
                "EXECUTION REFUSED: head-of:topic cannot be resolved: the request's repository 'not a repo' is not"
                " <owner>/<name> on GitHub; nothing recorded", 1))

    def test_git_is_asked_whether_a_branch_name_is_one(self) -> None:
        self.assertTrue(revision.git_branch_ok("claude/w1015-558"))
        for bad in ("HEAD", "a..b", "a/.b", "x.lock"):
            self.assertFalse(revision.git_branch_ok(bad), bad)

    def test_only_a_well_formed_head_of_request_follows_a_branch(self) -> None:
        self.assertEqual(revision.head_of({"requested_revision": "head-of:main"}), "main")
        for request in (None, {}, {"requested_revision": "origin/main"}, {"requested_revision": "head-of:a..b"}, {"requested_revision": 3}):
            self.assertIsNone(revision.head_of(request), request)


class IntegrationRecords(unittest.TestCase):
    """ludics-lite#401: only a coordinator's concluded, marked, non-standing correctness run at an
    exact SHA, for the repository compared without case, is a verdict source for the gate."""

    def test_only_marked_integration_runs_of_the_target_are_sources(self) -> None:
        records = [
            record("int-a", request={"repository": "Example/Project"}),
            record("int-b", request={"integration": False}),
            record("int-c", request={"repository": "o/r"}),
            record("int-d", verdict="timeout"),
            record("int-e", state="launching"),
            record("int-f", request={"transport": "subagent"}),
            record("int-g", request={"standing": True}),
            record("int-h", observed_sha="b" * 64),
            record("int-i", verdict="fail"),
        ]
        rows = integration_rows(records, "example/project")
        self.assertEqual(
            rows.split("\n"),
            [f"{SHA}\tpass\tint-a\t2026-10-05T00:00:00+00:00", f"{SHA}\tfail\tint-i\t2026-10-05T00:00:00+00:00"],
        )
        self.assertEqual(integration_rows([], "example/project"), "")


class WindowPayload(unittest.TestCase):
    """jq's ``{box: $box, request: .}`` over a stream: one line per value, nothing for none, and
    only text that does not parse is the command line's refusal."""

    def payload(self, text: str) -> str:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write(text)
        try:
            return window_payload(["window", "tbox", f.name])
        finally:
            os.unlink(f.name)

    def test_each_value_is_one_wrapped_line(self) -> None:
        self.assertEqual(self.payload('{"a":1}'), '{"box":"tbox","request":{"a":1}}')
        self.assertEqual(self.payload('{"a":1}\n{"b":2}\n'),
                         '{"box":"tbox","request":{"a":1}}\n{"box":"tbox","request":{"b":2}}')
        self.assertEqual(self.payload(' \n\t'), "")

    def test_text_that_does_not_parse_is_a_usage_refusal(self) -> None:
        for text in ("not json", '{"a":1} trailing', '{"a":'):
            with self.assertRaises(cli.Exit) as caught:
                self.payload(text)
            self.assertEqual(caught.exception.rc, 2, text)


class WindowGap(unittest.TestCase):
    """ludics-lite#667: ``execution window`` asks for FLEET_WINDOW_GAP (or none with ``--no-gap``),
    and waits out the registry's gap answer (exit 3) with no lock held before asking again."""

    def setUp(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write('{"request_id":"w2"}')
        self.file = f.name

    def tearDown(self) -> None:
        os.unlink(self.file)

    def cfg(self, **env: str) -> Any:
        return load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", env, host="testbox")

    def test_the_gap_is_the_knob_or_none_with_no_gap_right_after_window(self) -> None:
        cfg = self.cfg()
        self.assertEqual(execution.window_gap(cfg, ["window", "b", "f"]), (["window", "b", "f"], 60))
        self.assertEqual(execution.window_gap(self.cfg(FLEET_WINDOW_GAP=""), ["window", "b", "f"])[1], 60)
        self.assertEqual(execution.window_gap(self.cfg(FLEET_WINDOW_GAP="0"), ["window", "b", "f"])[1], 0)
        self.assertEqual(execution.window_gap(cfg, ["window", "--no-gap", "b", "f"]), (["window", "b", "f"], 0))
        self.assertEqual(execution.window_gap(cfg, ["window", "b", "--no-gap", "f"])[0], ["window", "b", "--no-gap", "f"],
                         "anywhere else it is a word window_payload refuses")
        for bad in ("soon", "-1", "1.5"):
            with self.assertRaises(cli.Exit) as caught, contextlib.redirect_stderr(io.StringIO()):
                execution.window_gap(self.cfg(FLEET_WINDOW_GAP=bad), ["window", "b", "f"])
            self.assertEqual(caught.exception.rc, 2, bad)

    def test_the_payload_carries_a_gap_only_when_there_is_one(self) -> None:
        self.assertEqual(window_payload(["window", "tbox", self.file], 60), '{"box":"tbox","request":{"request_id":"w2"},"gap":60}')
        self.assertEqual(window_payload(["window", "tbox", self.file], 0), '{"box":"tbox","request":{"request_id":"w2"}}')

    def test_only_the_registrys_gap_answer_is_waited_out(self) -> None:
        answer = '{"gap":{"box":"b","after":"w1","ago":3,"gap":60,"wait":57,"standing":["s"]}}'
        self.assertEqual(execution.gap_wait(execution.Done(3, answer)), 57)
        for done in (execution.Done(0, answer), execution.Done(1, answer), execution.Done(3, "nope"),
                     execution.Done(3, '{"gap":{"wait":0}}'), execution.Done(3, '{"gap":{"wait":true}}'),
                     execution.Done(3, '{"gap":{"wait":"5"}}'), execution.Done(3, "[]")):
            self.assertIsNone(execution.gap_wait(done), done)

    def run_window(self, answers: list[Any], words: list[str] | None = None, **env: str) -> tuple[int, str, str, list[Any], list[float]]:
        calls: list[Any] = []
        slept: list[float] = []

        def unresolved(cfg: Any, payload: str, action: str) -> tuple[str, str]:
            return payload, ""

        def run_on(cfg: Any, box: str, script: str, argv: list[str], capture: bool = False) -> Any:
            # The payload is the script's fd-3 line, argv only says so (ludics-lite#636).
            self.assertEqual(argv[6], PAYLOAD_ON_FD)
            framed = script.split("3<<'FLEET_EXECUTION_PY_PAYLOAD' <<'FLEET_EXECUTION_PY'\n", 1)[1].split("\n", 1)[0]
            calls.append(json.loads(json.loads(framed)))
            return answers.pop(0)

        out, err = io.StringIO(), io.StringIO()
        with (mock.patch.object(execution, "check_identity"), mock.patch.object(execution, "checked_request"),
              mock.patch.object(execution, "with_resolution", side_effect=unresolved),
              mock.patch.object(execution, "endpoint_map", return_value=""),
              mock.patch.object(execution, "my_token", return_value="tok"),
              mock.patch.object(execution, "coordinator_id", return_value="coord"),
              mock.patch.object(execution, "execution_refresh"),
              mock.patch.object(execution, "run_on", side_effect=run_on),
              mock.patch.object(execution.time, "sleep", side_effect=slept.append),
              contextlib.redirect_stdout(out), contextlib.redirect_stderr(err)):
            rc = execution.cmd_execution(self.cfg(**env), ["window", *(words or []), "testbox", self.file])
        return rc, out.getvalue(), err.getvalue(), calls, slept

    def test_a_gap_answer_is_waited_then_asked_again_and_the_record_printed_once(self) -> None:
        gap = execution.Done(3, '{"gap":{"box":"testbox","after":"w1","ago":50,"gap":60,"wait":10,"standing":["s"]}}')
        opened = execution.Done(0, '{"request_id":"w2"}')
        rc, out, err, calls, slept = self.run_window([gap, opened])
        self.assertEqual((rc, out, slept), (0, '{"request_id":"w2"}\n', [10]))
        self.assertEqual([c.get("gap") for c in calls], [60, 50])
        self.assertEqual(err, "EXECUTION WINDOW testbox: waiting 10s, then opening the window (FLEET_WINDOW_GAP=60;"
                              " --no-gap opens it at once)\n")
        rc, _, _, calls, slept = self.run_window([opened], ["--no-gap"])
        self.assertEqual((rc, slept, "gap" in calls[0]), (0, [], False))
        rc, _, _, calls, slept = self.run_window([gap, gap, opened])
        self.assertEqual((rc, slept, [c.get("gap") for c in calls]), (0, [10, 10], [60, 50, 40]),
                         "each retry asks for the gap less what was waited")
        future = execution.Done(3, '{"gap":{"box":"testbox","after":"w1","ago":0,"gap":60,"wait":60,"standing":["s"]}}')
        rc, _, _, calls, slept = self.run_window([future, opened])
        self.assertEqual((rc, slept, "gap" in calls[1]), (0, [60], False), "a whole gap waited asks for none")
        rc, out, _, calls, slept = self.run_window([execution.Done(3, '{"gap":{"wait":70}}'), future])
        self.assertEqual((rc, slept, len(calls)), (3, [60], 2), "never more than the gap, whatever is answered")
        self.assertIn('"wait":60', out)
        rc, out, _, _, slept = self.run_window([execution.Done(1, "")])
        self.assertEqual((rc, out, slept), (1, "", []), "a refusal is no gap")


class CallerPythonpath(unittest.TestCase):
    """scripts/py's notes put the caller's PYTHONPATH and PYTHONCOERCECLOCALE back for every child
    of an entry point."""

    def test_the_note_restores_set_empty_and_unset(self) -> None:
        env = {"PYTHONPATH": "/checkout/lib", "LUDICS_CALLER_PYTHONPATH": "=/mine"}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {"PYTHONPATH": "/mine"})
        env = {"PYTHONPATH": "/checkout/lib", "LUDICS_CALLER_PYTHONPATH": "="}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {"PYTHONPATH": ""})
        env = {"PYTHONPATH": "/checkout/lib", "LUDICS_CALLER_PYTHONPATH": ""}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {})
        env = {"PYTHONPATH": "/checkout/lib"}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {"PYTHONPATH": "/checkout/lib"})

    def test_the_locale_coercion_switch_is_put_back_too(self) -> None:
        # scripts/py exports PYTHONCOERCECLOCALE=0 for its own interpreter; a local far side, a
        # batch, a hook must see the caller's value -- here none at all -- as under the bash.
        env = {"PYTHONCOERCECLOCALE": "0", "LUDICS_CALLER_PYTHONCOERCECLOCALE": ""}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {})
        env = {"PYTHONCOERCECLOCALE": "0", "LUDICS_CALLER_PYTHONCOERCECLOCALE": "=warn"}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {"PYTHONCOERCECLOCALE": "warn"})
        env = {"PYTHONCOERCECLOCALE": "0"}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {"PYTHONCOERCECLOCALE": "0"})

    def test_the_forwards_arg_conversion_switch_is_the_callers_again(self) -> None:
        # pr-review.sh's Git Bash forward turns MSYS's argument rewriting off for this interpreter
        # only; the bridge's bash must rewrite its own native children's arguments as before.
        env = {"MSYS2_ARG_CONV_EXCL": "*", "LUDICS_CALLER_ARG_CONV_EXCL": ""}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {})
        env = {"MSYS2_ARG_CONV_EXCL": "*", "LUDICS_CALLER_ARG_CONV_EXCL": "=--foo"}
        cli.restore_caller_environment(env)
        self.assertEqual(env, {"MSYS2_ARG_CONV_EXCL": "--foo"})

    def test_the_git_bash_pid_is_this_interpreters_alone(self) -> None:
        # scripts/py's $$ names this interpreter: it is kept for own_pid, and a child never sees it.
        env = {"LUDICS_SHELL_PID": "2380"}
        with mock.patch.object(proc, "_shell_pid", None):
            cli.restore_caller_environment(env)
            self.assertEqual((env, proc.own_pid()), ({}, 2380))
        with mock.patch.object(proc, "_shell_pid", None):
            cli.restore_caller_environment({})
            self.assertEqual(proc.own_pid(), os.getpid())



class RetryRule(unittest.TestCase):
    """#657: THE RETRY RULE, one helper for every conclude form -- a concluded record plus a call
    that matches what landed returns the landed payload; anything else composes afresh."""

    LANDED: dict[str, Any] = {"request_id": "r", "evidence": "ok; GPU co-tenants on rog (rog:/p): x", "observed_sha": SHA,
                              "remote_checkout": "/w", "handle": "h", "log": "l", "verdict": "pass"}

    def rec(self, **over: Any) -> dict[str, Any]:
        base: dict[str, Any] = {"request_id": "r", "state": "concluded", "observed_sha": SHA,
                                "request": {"kind": "measurement", "execution_host": "rog"},
                                "history": [{"action": "dispatch", "data": {}}, {"action": "conclude", "data": dict(self.LANDED)}]}
        base.update(over)
        return base

    def test_a_matching_call_gets_the_landed_payload(self) -> None:
        self.assertEqual(execution.retried(self.rec()), self.LANDED)
        self.assertEqual(execution.retried(self.rec(), {"handle": "h", "verdict": "pass"}, lambda said: said.startswith("ok; ")), self.LANDED)

    def test_anything_else_composes_afresh(self) -> None:
        for record, fields in ((self.rec(state="running"), {}), (self.rec(history=[]), {}), (self.rec(history="x"), {}),
                               (self.rec(history=[{"data": "x"}]), {}), (self.rec(), {"handle": "other"}),
                               (self.rec(), {"absent": "x"})):
            self.assertIsNone(execution.retried(record, fields), (record, fields))
        self.assertIsNone(execution.retried(self.rec(), evidence=lambda said: said.startswith("other")))
        landed = {**self.LANDED, "evidence": 7}
        self.assertIsNone(execution.retried(self.rec(history=[{"data": landed}]), evidence=lambda said: True))
        self.assertEqual(execution.retried(self.rec(history=[{"data": landed}])), landed)

    def test_observed_from_keeps_the_landed_sha_and_reads_otherwise(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="testbox")
        with mock.patch.object(execution, "observed_head", return_value="c" * 40) as read:
            self.assertEqual(execution.observed_sha_of(cfg, self.rec(), "rog", "/w"), SHA)
            read.assert_not_called()
            self.assertEqual(execution.observed_sha_of(cfg, self.rec(state="running"), "rog", "/w"), "c" * 40)
            no_sha = {k: v for k, v in self.LANDED.items() if k != "observed_sha"}
            self.assertEqual(execution.observed_sha_of(cfg, self.rec(history=[{"data": no_sha}]), "rog", "/w"), "c" * 40)

    def test_a_measurements_retry_reuses_its_recorded_clause_and_nothing_else_does(self) -> None:
        cfg = load_config("/nonexistent/issue-wave/scripts/fleet-worker.sh", {}, host="testbox")
        def gpu(record: dict[str, Any], evidence: str) -> dict[str, Any]:
            listing = execution.Done(0, json.dumps([record]))
            payload = json.dumps({"request_id": "r", "evidence": evidence, "verdict": "pass"})
            with mock.patch.object(execution, "listing", return_value=listing), \
                    mock.patch.object(execution, "gpu_record_evidence", return_value="GPU co-tenants on rog (rog:/q): fresh") as fresh:
                out = json.loads(execution.with_gpu_record(cfg, payload))
            out["fresh"] = fresh.called
            return out
        self.assertEqual(gpu(self.rec(), "ok")["evidence"], self.LANDED["evidence"])
        self.assertEqual(gpu(self.rec(), "ok")["fresh"], False)
        self.assertEqual(gpu(self.rec(), "other")["evidence"], "other")  # the registry's to refuse
        running = gpu(self.rec(state="running"), "ok")
        self.assertEqual((running["evidence"], running["fresh"]), ("ok; GPU co-tenants on rog (rog:/q): fresh", True))


class GpuClause(unittest.TestCase):
    """THE CO-TENANT EVIDENCE's retry: the recorded evidence is the caller's own, exactly, then the
    clause (ludics-lite#566)."""

    def test_the_exact_evidence_then_a_clause_is_a_retry(self) -> None:
        for clause in ("GPU co-tenants on rog (rog:/p): x", "no GPU co-tenant record on rog (/p): y",
                       "GPU co-tenant record unread: rog did not answer"):
            self.assertTrue(execution.gpu_clause("a; b", f"a; b; {clause}", "rog"), clause)

    def test_a_shorter_evidence_is_not(self) -> None:
        self.assertFalse(execution.gpu_clause("a", "a; b; GPU co-tenants on rog (rog:/p): x", "rog"))
        self.assertFalse(execution.gpu_clause("a", "a; GPU co-tenants on minix (minix:/p): x", "rog"))
        self.assertFalse(execution.gpu_clause("a", "a", "rog"))


class ReservedSince(unittest.TestCase):
    def test_a_snapshot_older_than_the_reservation_is_left_out_counted(self) -> None:
        lines: list[dict[str, Any]] = [{"at": "2026-10-15T10:00:00+00:00"}, {"at": "2026-10-15T11:55:00+00:00"},
                                       {"at": "2026-10-15T12:30:00+00:00"}, {"at": "unparsed"}, {}]
        kept, older = execution.reserved_since(lines, "2026-10-15T12:00:00.123456+00:00")
        self.assertEqual((kept, older), (lines[1:], 1))
        self.assertEqual(execution.reserved_since(lines, "null"), (lines, 0))


if __name__ == "__main__":
    unittest.main()
