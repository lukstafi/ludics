"""ludics.fleetworker's worker, preflight and supervision near sides: the readings the shell made of
its own text (``${pf#*skills=* }``, the usage block, jq's @tsv and @uri), the slots report, and the
far side's Python probe in scripts/py's order."""

import calendar
import contextlib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

from ludics.fleetworker import farside
from ludics.fleetworker.__main__ import usage_text
from ludics.fleetworker.config import load_config
from ludics.fleetworker.gate import uri
from ludics.fleetworker.preflight import siblings_of, slots_report
from ludics.fleetworker.supervision import (
    ROUNDS_TRAILER,
    WAVE_ISSUE,
    converge_note,
    each,
    head_age,
    length,
    load_line,
    pr_rows,
    referencing_prs,
    wave_issues,
    wave_workers,
)
from ludics.fleetworker.workers import feeder_wait_ok, preflight_note, valid_name
from ludics.prreview.core import Json, JsonStreamError, json_docs, json_stream
from ludics.prreview.jqsem import JqError, jstr, tojson

SCRIPT = "/repo/issue-wave/scripts/fleet-worker.sh"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ROSTER = "mac-studio rog-nv-linux minix-amd-linux tuf-amd-linux"


class Names(unittest.TestCase):
    def test_a_worker_name_is_the_safe_set_without_a_leading_dot(self) -> None:
        for name in ("w1", "a.b", "claude-issue_7"):
            self.assertTrue(valid_name(name), name)
        for name in ("", ".", "..", ".triage", "a b", "../escape", "a/b", "é"):
            self.assertFalse(valid_name(name), name)

    def test_the_feeder_wait_is_a_positive_whole_number_without_a_leading_zero(self) -> None:
        for value, want in (("10", True), ("1", True), ("0", False), ("01", False), ("1s", False)):
            cfg = load_config(SCRIPT, {"FLEET_FEEDER_WAIT": value}, host="h")
            self.assertEqual(feeder_wait_ok(cfg), want, value)
        # `${FLEET_FEEDER_WAIT:-10}`: empty is the default.
        self.assertTrue(feeder_wait_ok(load_config(SCRIPT, {"FLEET_FEEDER_WAIT": ""}, host="h")))


class Readings(unittest.TestCase):
    def test_the_preflight_note_is_the_ok_line_past_its_skills_field(self) -> None:
        line = "PREFLIGHT OK rog skills=abcdef123 (cross-box unreachable, asleep or off the network: tuf)"
        self.assertEqual(preflight_note(line), "(cross-box unreachable, asleep or off the network: tuf)")
        self.assertEqual(preflight_note("no skills field here"), "no skills field here")
        self.assertEqual(preflight_note("PREFLIGHT OK rog skills=abc"), "PREFLIGHT OK rog skills=abc")

    def test_usage_is_the_header_block_from_usage_through_exit(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
            f.write("#!/usr/bin/env bash\n# intro\n# Usage:\n#   x.sh a\n#bare\n# Exit: 0 ok\n# after\nbody\n")
        try:
            self.assertEqual(usage_text(f.name), "Usage:\n  x.sh a\nbare\nExit: 0 ok\n")
        finally:
            os.unlink(f.name)
        self.assertEqual(usage_text("/nonexistent/fleet-worker.sh"), "")

    def test_uri_is_jqs(self) -> None:
        self.assertEqual(uri("claude/issue-7"), "claude%2Fissue-7")
        self.assertEqual(uri("a b~c_d.e-f"), "a%20b~c_d.e-f")
        self.assertEqual(uri("é"), "%C3%A9")

    def test_siblings_leave_out_the_box_and_every_spelling_of_this_one(self) -> None:
        cfg = load_config(SCRIPT, {"FLEET_BOXES": "mac-studio rog tuf", "FLEET_LOCAL_BOX": "mac-studio"}, host="h")
        self.assertEqual(siblings_of(cfg, "rog"), "mac-studio tuf")
        self.assertEqual(siblings_of(cfg, "local"), "rog tuf")
        self.assertEqual(siblings_of(cfg, "mac-studio"), "rog tuf")


def report(env: dict[str, str]) -> tuple[str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        slots_report(load_config(SCRIPT, env, host="h"))
    return out.getvalue(), err.getvalue()


class SlotsReport(unittest.TestCase):
    def test_the_site_default_is_printed_with_its_tokens_and_no_warning(self) -> None:
        out, err = report({"FLEET_BOXES": ROSTER})
        self.assertEqual(out, "PREFLIGHT SLOTS mac-studio=6 rog-nv-linux=4(gpu=2) minix-amd-linux=4 tuf-amd-linux=3 (site default)\n")
        self.assertEqual(err, "")

    def test_an_empty_spec_under_the_default_roster_warns_box_by_box(self) -> None:
        out, err = report({"FLEET_BOXES": ROSTER, "FLEET_BOX_CORRECTNESS_SLOTS": ""})
        self.assertTrue(out.endswith("(FLEET_BOX_CORRECTNESS_SLOTS)\n"), out)
        warned = [line.split(" does not name ")[1].split(",")[0] for line in err.splitlines()]
        self.assertEqual(warned, ROSTER.split())

    def test_the_spec_spelling_of_a_count_is_kept(self) -> None:
        out, _ = report({"FLEET_BOXES": "a b", "FLEET_BOX_CORRECTNESS_SLOTS": "a=007"})
        self.assertEqual(out, "PREFLIGHT SLOTS a=007 b=1 (FLEET_BOX_CORRECTNESS_SLOTS)\n")

    def test_a_malformed_spec_is_one_warning_and_no_slots_line(self) -> None:
        out, err = report({"FLEET_BOXES": "a b", "FLEET_BOX_GPU_TOKENS": "stale=1"})
        self.assertEqual(out, "")
        self.assertEqual(err, "PREFLIGHT SLOTS WARNING: FLEET_BOX_GPU_TOKENS names stale, which is not in FLEET_BOXES; every `execution slot` refuses\n")


class Prs(unittest.TestCase):
    def test_rows_are_in_number_order_with_placeholders_and_tsv_escapes(self) -> None:
        listing = json.loads(
            '[{"number": 12, "title": "a\\tb", "headRefName": "x", "headRefOid": "c12", "createdAt": "t", "isDraft": true},'
            ' {"number": 7, "title": "", "headRefName": "y", "headRefOid": "c7", "createdAt": "t", "isDraft": false}]'
        )
        self.assertEqual(
            pr_rows(listing, None),
            [["7", "c7", "t", "-", "y", "-"], ["12", "c12", "t", "draft", "x", "a\\tb"]],
        )

    def test_a_wave_keeps_the_prs_closing_one_of_its_issues(self) -> None:
        ref = {"number": 7, "repository": {"name": "r", "owner": {"login": "o"}}}
        listing = json.loads(json.dumps([{"number": 1, "closingIssuesReferences": [ref]}, {"number": 2, "closingIssuesReferences": None}]))
        self.assertEqual([row[0] for row in pr_rows(listing, ["o/r#7"])], ["1"])
        self.assertEqual([row[0] for row in pr_rows(listing, ["o/r#8"])], [])
        records = json.loads('[{"request": {"wave": "w", "issue": "o/r#7"}}, {"request": {"wave": "w", "issue": "o/r#7"}}, {"request": {"wave": "v", "issue": "x"}}]')
        self.assertEqual(wave_issues(records, "w"), ["o/r#7"])

    def test_a_wave_keeps_a_pr_that_only_references_one_of_its_issues(self) -> None:
        # A PR for one item of a multi-item issue says `Refs #N` and closes nothing (ludics-lite#655).
        listing = json.loads('[{"number": 1, "closingIssuesReferences": []}, {"number": 2}, {"number": 3}]')
        self.assertEqual([row[0] for row in pr_rows(listing, ["o/r#7"], frozenset({2}))], ["2"])
        self.assertEqual([row[0] for row in pr_rows(listing, None, frozenset({2}))], ["1", "2", "3"])

    def test_a_wave_keeps_a_pr_on_a_branch_of_one_of_its_workers(self) -> None:
        # ludics-lite#664: a post-wave task's records name no issue, and its PR may reference nothing.
        def rec(worker: str, transport: str = "subagent", wave: str = "w", repository: str = "o/r", **more: str) -> dict[str, object]:
            return {"request": {"wave": wave, "worker": worker, "transport": transport, "repository": repository, **more}}

        records = json.loads(json.dumps([
            rec("w1016-p1t2"), rec("w1016-605", "app", issue="o/r#605"), rec("cw", "cli", repository="O/R"),
            rec("coordinator", "coordinator", issue="o/r integration"), rec("/root/issue12"),
            rec("elsewhere", wave="v"), rec("other-repo", repository="o/other"), {"request": {"wave": "w", "worker": "norepo", "transport": "cli"}},
        ]))
        self.assertEqual(wave_workers(records, "w", "o/r"), ("cw", "w1016-605", "w1016-p1t2"))
        self.assertEqual(wave_workers(records, "w", "o/other"), ("other-repo",), "each worker to its own repository")
        self.assertEqual(wave_issues(records, "w"), ["o/r integration", "o/r#605"], "a record without an issue names none")
        listing = json.loads(json.dumps([
            {"number": 1, "headRefName": "claude/w1016-p1t2"}, {"number": 2, "headRefName": "w1016-605"},
            {"number": 3, "headRefName": "claude/xw1016-p1t2"}, {"number": 4, "headRefName": "claude/W1016-P1T2"},
            {"number": 5, "headRefName": "claude/w1016-p1t2/more"}, {"number": 6, "headRefName": "claude/coordinator"},
            {"number": 7, "headRefName": "claude/elsewhere"}, {"number": 8}, {"number": 9, "headRefName": "a/b/cw"},
            {"number": 10, "headRefName": "claude/other-repo"},
        ]))
        for pr in listing:
            pr["isCrossRepository"] = False
        listing += json.loads('[{"number": 11, "headRefName": "claude/w1016-p1t2", "isCrossRepository": true},'
                              ' {"number": 12, "headRefName": "claude/w1016-p1t2"}]')
        kept = [row[0] for row in pr_rows(listing, [], frozenset(), wave_workers(records, "w", "o/r"))]
        self.assertEqual(kept, ["1", "2", "9"], "the branch is the worker, or ends in / and the worker, exactly, never a fork's")

    def test_cross_references_count_the_prs_of_the_listed_repository_only(self) -> None:
        def page(nodes: list[object], more: bool = False) -> Json:
            items = {"pageInfo": {"hasNextPage": more, "endCursor": "c"}, "nodes": nodes}
            return json.loads(json.dumps({"data": {"repository": {"issue": {"timelineItems": items}}}}))

        def pr(number: object, repo: object) -> object:
            return {"source": {"__typename": "PullRequest", "number": number, "repository": {"nameWithOwner": repo}}}

        pages = [page([pr(5, "o/r"), {"source": {"__typename": "Issue"}}, pr(6, "o/other")], more=True), page([pr(8, "O/R")])]
        self.assertEqual(referencing_prs(pages, "o/r"), {5, 8}, "GitHub names compare case-insensitively")
        for bad in ([page([pr(5, "o/r")], more=True)], [page([pr("5", "o/r")])], [page([pr(5, None)])],
                    [json.loads('{"data": {"repository": {"issue": null}}}')]):
            with self.assertRaises(JqError):
                referencing_prs(bad, "o/r")

    def test_a_wave_issue_is_spelled_owner_name_number(self) -> None:
        for issue in ("o/r#7", "ahrefs/ocannl#1235", "a.b/c_d-e#10"):
            self.assertIsNotNone(WAVE_ISSUE.fullmatch(issue), issue)
        for issue in ("lukstafi/ludics-lite#post-1", "lukstafi/ocannl-staging integration", "o/r#0", "#7", "o/r#7 x"):
            self.assertIsNone(WAVE_ISSUE.fullmatch(issue), issue)

    def test_a_list_that_is_not_an_array_is_jqs_error(self) -> None:
        with self.assertRaises(JqError):
            pr_rows({"number": 1}, None)

    def test_the_flag_at_rounds_and_the_early_flag_after_a_large_round_1(self) -> None:
        # ludics-lite#650: round 3 after a round 1 of five or more, round 5 (--flag-at) otherwise.
        self.assertIn("CONVERGE: 5 review rounds with findings (flag at 5)", converge_note("5", "0", "5"))
        self.assertIn("CONVERGE: 5 review rounds", converge_note("5", "unknown", "5"))
        self.assertEqual(converge_note("4", "4", "5"), "")
        self.assertIn("after a round 1 of 5 (flag at 3 after 5 or more)", converge_note("3", "5", "5"))
        self.assertEqual(converge_note("2", "9", "5"), "", "round 2 is early even after a large round 1")
        self.assertEqual(converge_note("4", "unknown", "5"), "", "an unread round 1 raises no early flag")
        self.assertEqual(converge_note("?", "9", "1"), "")
        self.assertIn("(flag at 2)", converge_note("3", "9", "2"), "--flag-at wins where both apply")

    def test_the_rounds_trailer_must_carry_round_1(self) -> None:
        found = ROUNDS_TRAILER.fullmatch("rounds: n=3 threshold=off first=7")
        self.assertEqual(found.groups() if found else None, ("3", "7"))
        found = ROUNDS_TRAILER.fullmatch("rounds: n=3 threshold=off first=unknown")
        self.assertEqual(found.groups() if found else None, ("3", "unknown"))
        self.assertIsNone(ROUNDS_TRAILER.fullmatch("rounds: n=3 threshold=off"))
        self.assertIsNone(ROUNDS_TRAILER.fullmatch("rounds: n=3 threshold=12 first=7"))

    def test_head_age_reads_the_newer_date_and_formats_it_as_the_shell_did(self) -> None:
        epoch = calendar.timegm((2027, 1, 15, 8, 0, 0, 0, 0, 0)) + 0.5  # jq's `now`, a float
        self.assertEqual(head_age("2027-01-15T07:59:00Z", "", epoch), "1m")
        self.assertEqual(head_age("2027-01-15T06:58:00Z", "2027-01-15T05:00:00Z", epoch), "1h2m")
        self.assertEqual(head_age("not a date", "2027-01-12T05:00:00Z", epoch), "3d3h")
        self.assertEqual(head_age("", "", epoch), "?")
        # A date jq cannot read fails the whole program, and one in the future is no age.
        self.assertEqual(head_age("2027-13-01T00:00:00Z", "2027-01-15T07:59:00Z", epoch), "?")
        self.assertEqual(head_age("2028-01-01T00:00:00Z", "", epoch), "?")


class Load(unittest.TestCase):
    def test_a_line_prints_jqs_interpolations_and_defaults(self) -> None:
        endpoint = json.loads('{"kind": "unix", "ok": true, "avg": {"m5": {"cpu_pct": 12.5}}, "data": {"sessions": {"claude": [1, 2]}}}')
        self.assertEqual(
            load_line({"name": "mac"}, "studio", endpoint),
            "mac\tstudio\tok=true\tcpu5=12.5%\tgpu5=-%\tdune=?\tclaude=2\tcodex=0\tgpu=-",
        )

    def test_numbers_print_as_the_payload_spelled_them(self) -> None:
        # jq 1.8 prints a number it did not compute with as its literal, in decNumber's spelling.
        (doc,) = json_docs('[1E+2, 1e2, 3.50, -0, 1.5e3, 0.0000001, 1E1000, 12.0, 7, -0.0]', literals=True)
        self.assertEqual([jstr(n) for n in each(doc)], ["1E+2", "1E+2", "3.50", "-0", "1.5E+3", "1E-7", "1E+1000", "12.0", "7", "-0.0"])
        self.assertEqual(tojson(doc), "[1E+2,1E+2,3.50,-0,1.5E+3,1E-7,1E+1000,12.0,7,-0.0]")
        # length keeps a literal, its sign dropped, as jq 1.8's does; the default reading (every
        # other port's) is unchanged.
        (signed,) = json_docs("[-3.50, -0, -0.0, 1.10, -100000000000000000000001]", literals=True)
        self.assertEqual([jstr(length(n)) for n in each(signed)], ["3.50", "0", "0.0", "1.10", "100000000000000000000001"])
        self.assertEqual(jstr(next(json_docs("1E+2"))), "100.0")
        (nested,) = json_docs('{"a": [3.50, {"b": -0}], "c": "\u00e9"}', literals=True)
        self.assertEqual(tojson(nested), '{"a":[3.50,{"b":-0}],"c":"\u00e9"}')

    def test_documents_before_a_cut_are_read_before_it_refuses(self) -> None:
        docs = json_docs('{"a": 1} [2] {"b":', literals=True)
        self.assertEqual(next(docs), {"a": 1})
        self.assertEqual(next(docs), [2])
        with self.assertRaises(JsonStreamError):
            next(docs)
        self.assertIsNone(json_stream('{"a": 1} {"b":'))


@unittest.skipIf(shutil.which("bash") is None, "no bash")
class TmNew(unittest.TestCase):
    """farside.HELPERS' tm_new: new-session, tried again only while the server it reached was
    exiting (ludics-lite#658)."""

    def run_new(self, answers: list[str]) -> tuple[int, str, list[str]]:
        """tm_new against a tmux whose n-th call answers answers[n] on stderr (exit 1), or
        succeeds past the list; returns the status, stderr and each call's arguments."""
        with tempfile.TemporaryDirectory() as d:
            for i, answer in enumerate(answers):
                with open(os.path.join(d, f"answer{i}"), "w") as f:
                    f.write(answer + "\n")
            with open(os.path.join(d, "tmux"), "w") as f:
                f.write(
                    '#!/bin/sh\nn=0; [ ! -e "$0.calls" ] || n=$(($(wc -l < "$0.calls")))\n'
                    'echo "$*" >> "$0.calls"\n'
                    'if [ -e "$(dirname "$0")/answer$n" ]; then cat "$(dirname "$0")/answer$n" >&2; exit 1; fi\n'
                )
            os.chmod(os.path.join(d, "tmux"), 0o755)
            env = {**os.environ, "PATH": d + os.pathsep + os.environ["PATH"], "TMUX_SOCKET": "sock", "STATE": d}
            done = subprocess.run(
                ["bash", "-c", farside.HELPERS + 'tm_new -d -s fw-x "bash run.sh"'],
                env=env, capture_output=True, text=True, check=False,
            )
            with open(os.path.join(d, "tmux.calls")) as f:
                calls = f.read().splitlines()
        return done.returncode, done.stderr, calls

    def test_a_server_caught_exiting_is_tried_again(self) -> None:
        rc, err, calls = self.run_new(["server exited unexpectedly"] * 2)
        self.assertEqual((rc, err), (0, ""))
        self.assertEqual(calls, ["-L sock new-session -d -s fw-x bash run.sh"] * 3)

    def test_any_other_refusal_is_final_and_keeps_its_message(self) -> None:
        rc, err, calls = self.run_new(["duplicate session: fw-x", "server exited unexpectedly"])
        self.assertEqual((rc, err, len(calls)), (1, "duplicate session: fw-x\n", 1))

    def test_a_server_that_keeps_exiting_refuses_after_five_tries(self) -> None:
        rc, err, calls = self.run_new(["server exited unexpectedly"] * 9)
        self.assertEqual((rc, err, len(calls)), (1, "server exited unexpectedly\n", 5))


class FleetPython(unittest.TestCase):
    """farside.FLEET_PYTHON: the box's first Python >= 3.12 in scripts/py's order, or what each
    candidate was."""

    def probe(self, candidates: list[str]) -> tuple[int, str]:
        env = {**os.environ, "LUDICS_PY_CANDIDATES": "\n".join(candidates)}
        done = subprocess.run(
            ["bash", "-c", farside.FLEET_PYTHON + "fleet_python"], env=env, capture_output=True, text=True, check=False
        )
        return done.returncode, done.stdout

    def test_the_first_qualifying_candidate_wins_and_the_rest_is_named(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            old = os.path.join(d, "old")
            with open(old, "w") as f:
                f.write("#!/bin/sh\necho 3.9.6; exit 1\n")
            junk = os.path.join(d, "junk")
            with open(junk, "w") as f:
                f.write("#!/bin/sh\nexit 3\n")
            os.chmod(old, 0o755)
            os.chmod(junk, 0o755)
            missing = os.path.join(d, "missing")
            rc, out = self.probe([missing, old, junk, "no-such-python-on-path"])
            self.assertEqual(rc, 1)
            self.assertEqual(
                out,
                f"tried {missing}: absent, {old} ({old}): Python 3.9.6, older than 3.12,"
                f" {junk} ({junk}): did not run as Python (exit 3), no-such-python-on-path: not on PATH",
            )
            rc, out = self.probe([old, sys.executable])
            self.assertEqual((rc, out), (0, sys.executable))

    def test_the_default_order_is_scripts_pys_own(self) -> None:
        # The far side cannot run scripts/py's probe from the coordinator's checkout, so it holds the
        # order as data; this pins that data to scripts/py's text, the launcher fallback included.
        with open(os.path.join(ROOT, "scripts", "py"), encoding="utf-8") as f:
            text = f.read()
        loop = re.search(r"^  for candidate in (.*?); do$", text, re.MULTILINE | re.DOTALL)
        launcher = re.search(r"^    if try py (\S+) \|\| try py (\S+); then", text, re.MULTILINE)
        assert loop is not None and launcher is not None, "scripts/py's candidate loop moved"
        self.assertEqual(tuple(shlex.split(loop.group(1).replace("\\\n", " "))), farside.PY_CANDIDATES)
        self.assertEqual(launcher.groups(), farside.PY_LAUNCHER_ARGS)

    def test_under_git_bash_the_launcher_comes_last_and_names_its_interpreter(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            for name, body in (
                ("uname", "echo MINGW64_NT-10.0-19045"),
                # The launcher: no 3.12 here, a 3.13 for -3; asked for its executable, a Windows path.
                ("py", 'case "$1 $3" in "-3.12 "*) exit 103 ;; *executable*) printf "C:\\\\Py313\\\\python.exe\\r\\n" ;; *) echo 3.13.1 ;; esac'),
                ("cygpath", '[ "$1" = -u ] && echo "/c/Py313/python.exe"'),
            ):
                with open(os.path.join(d, name), "w") as f:
                    f.write(f"#!/bin/sh\n{body}\n")
                os.chmod(os.path.join(d, name), 0o755)
            # Every built-in candidate misses (this box has some of them), so the launcher is asked.
            script = (
                farside.FLEET_PYTHON
                + 'eval "orig_$(declare -f fleet_py_try)"\n'
                + 'fleet_py_try() { [ "$1" = py ] || { fleet_py_tried="$fleet_py_tried, $1: absent"; return 1; }; orig_fleet_py_try "$@"; }\n'
                + "fleet_python"
            )
            env = {k: v for k, v in os.environ.items() if k != "LUDICS_PY_CANDIDATES"}
            env["PATH"] = d + os.pathsep + "/usr/bin:/bin"
            done = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, check=False)
            self.assertEqual((done.returncode, done.stdout), (0, "/c/Py313/python.exe"))
            # A LUDICS_PY_CANDIDATES list replaces the order, the launcher included, as in scripts/py.
            env["LUDICS_PY_CANDIDATES"] = "python9"
            done = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, check=False)
            self.assertEqual((done.returncode, done.stdout), (1, "tried python9: absent"))
            del env["LUDICS_PY_CANDIDATES"]
            os.remove(os.path.join(d, "py"))
            done = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, check=False)
            self.assertEqual(done.returncode, 1)
            self.assertTrue(done.stdout.endswith(", py -3.12: not on PATH, py -3: not on PATH"), done.stdout)


if __name__ == "__main__":
    unittest.main()
