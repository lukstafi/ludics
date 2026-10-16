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


class StandingHandback(unittest.TestCase):
    """``conclude --standing-handback`` (#605 item 3): FROM_RUN's refusals become evidence."""

    RUN = "/runs/20261016T101010Z-1"

    @staticmethod
    def facts(**over: str) -> str:
        base = {"exit": "0", "wt": "/w t", "gone": "0", "record": "launch", "head": "b" * 40, "dirty": "0", "rel": "same"}
        base.update(over)
        return "\n".join(f"{k}={v}" for k, v in base.items())

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
        _, text = self.clause(dirty="3", rel="outside", gone="1")
        self.assertIn("over 3 uncommitted path(s) its dirty lists", text)
        self.assertIn("not in observed_sha's history (rewritten by a rebase, or never pushed)", text)
        self.assertIn("its recorded worktree /w t is gone", text)
        self.assertIn("an ancestor of observed_sha", self.clause(rel="ancestor")[1])

    def test_a_record_naming_no_revision_says_so(self) -> None:
        _, text = self.clause(record="none", head="", dirty="0", rel="")
        self.assertIn("its record naming no launch revision", text)

    def test_unreadable_facts_are_refused(self) -> None:
        for over in ({"exit": ""}, {"exit": "x"}, {"gone": "2"}, {"record": "odd"}, {"rel": "near"}, {"dirty": "-1"}, {"wt": ""}):
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
