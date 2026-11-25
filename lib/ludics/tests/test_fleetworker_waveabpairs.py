"""ludics.fleetworker.waveabpairs (``wave ab-pairs``, ludics#1274): blinded area-matched pair export.

Exercises area-matched pairing, closed-list scrubbing, balanced seeded side randomisation, key
separation, ``--from-json`` consumption, GraphQL/REST fallback, and error handling against real
``boardstore`` boards under a scratch anchor and faked ``gh`` responses.
"""

import base64
import contextlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from fractions import Fraction
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import boardstore, wave, waveabpairs
from ludics.fleetworker.config import load_config
from ludics.tests.fake import FakeTool

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SCRIPT = os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh")

SOL_ARM = ("cli", "codex", "gpt-6.2-sol/high")
NEON_ARM = ("cli", "gemini", "gemini-4-neon-high")
OPUS_ARM = ("subagent", "claude", "claude-opus-5-5")

_FAKE_GH = """\
import json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "fixture.json"), encoding="utf-8") as f:
    fx = json.load(f)

if argv[:2] == ["api", "graphql"]:
    query = ""
    for i, arg in enumerate(argv):
        if arg == "-f" and i + 1 < len(argv) and argv[i + 1].startswith("query="):
            query = argv[i + 1][len("query="):]
    alias_re = re.compile(r'(p\\d+):\\s*repository\\(owner:\\s*"([^"]+)",\\s*name:\\s*"([^"]+)"\\)\\s*\\{\\s*pullRequest\\(number:\\s*(\\d+)\\)')
    prs = fx.get("prs", {})
    fail_prs = set(fx.get("fail_graphql", []))
    data = {}
    for m in alias_re.finditer(query):
        alias, owner, name, num_s = m.groups()
        key = f"{owner}/{name}#{num_s}"
        if key in fail_prs:
            sys.stderr.write(f"gh: Could not resolve to a PullRequest with the number {num_s}.\\n")
            sys.exit(1)
        data[alias] = {"pullRequest": prs.get(key)}
    sys.stdout.write(json.dumps({"data": data}))
    sys.exit(0)

if argv[:2] == ["api", "--paginate"] and len(argv) == 3:
    rest = fx.get("rest_files", {})
    if argv[2] in rest:
        sys.stdout.write(rest[argv[2]])
        sys.exit(0)
    sys.stderr.write("gh: Not Found (HTTP 404)\\n")
    sys.exit(1)

if argv[:2] == ["issue", "view"]:
    num = argv[2]
    repo = argv[argv.index("--repo") + 1]
    key = f"{repo}#{num}"
    issues = fx.get("issues", {})
    if key in issues:
        sys.stdout.write(json.dumps(issues[key]))
        sys.exit(0)
    sys.stderr.write(f"GraphQL: Could not resolve to an issue with the number {num}. (repository.issue)\\n")
    sys.exit(1)

if argv[:2] == ["pr", "diff"]:
    import base64
    num = argv[2]
    repo = argv[argv.index("--repo") + 1]
    key = f"{repo}#{num}"
    diffs_b64 = fx.get("diffs_b64", {})
    if key in diffs_b64:
        sys.stdout.buffer.write(base64.b64decode(diffs_b64[key]))
        sys.exit(0)
    diffs = fx.get("diffs", {})
    if key in diffs:
        sys.stdout.write(diffs[key])
        sys.exit(0)
    sys.stderr.write(f"gh: HTTP 404: diff not found for {key}\\n")
    sys.exit(1)

sys.stderr.write(f"unexpected gh argv: {argv!r}\\n")
sys.exit(2)
"""


def _install_gh_fake(gh: FakeTool, fixture: dict[str, Any]) -> None:
    with open(os.path.join(gh.dir, "fixture.json"), "w", encoding="utf-8") as f:
        json.dump(fixture, f)
    tool_path = os.path.join(gh.dir, "gh")
    with open(tool_path, "w", encoding="utf-8") as f:
        f.write(f"#!{sys.executable}\n{_FAKE_GH}")
    os.chmod(tool_path, 0o755)


def _pr_files_node(
    number: int,
    files: list[tuple[str, int, int]],
    *,
    title: str = "Fix area",
    state: str = "MERGED",
    created_at: str = "2026-11-24T11:00:00Z",
    merged_at: str = "2026-11-24T12:00:00Z",
    merge_oid: str | None = None,
    has_next: bool = False,
) -> dict[str, Any]:
    return {
        "number": number,
        "state": state,
        "title": title,
        "createdAt": created_at,
        "mergedAt": merged_at,
        "mergeCommit": {"oid": merge_oid or f"{number:040x}"},
        "files": {
            "pageInfo": {"hasNextPage": has_next},
            "nodes": [{"path": p, "additions": a, "deletions": d} for p, a, d in files],
        },
    }


class BaseWaveAbPairs(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-waveabpairs-test."))
        self.env = {
            "FLEET_ANCHOR": "local",
            "FLEET_ANCHOR_STATE": self.root,
            "FLEET_SKILLS_REPO": CHECKOUT,
            "FLEET_BOXES": "local",
            "PATH": os.environ.get("PATH", ""),
            "HOME": self.root,
            "SHIP_PR_BUDGET_DIR": os.path.join(self.root, "budget"),
            "SHIP_PR_API_ATTEMPTS": "1",
            "SHIP_PR_API_BACKOFF": "0",
        }
        self.cfg = load_config(SCRIPT, self.env, host="testbox")

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def make_wave(
        self,
        name: str,
        *,
        repository: str = "fork/proj",
        issue_repository: str = "upstream/proj",
        profiles: dict[str, dict[str, str]] | None = None,
    ) -> str:
        wdir = os.path.join(self.root, name)
        os.makedirs(wdir, exist_ok=True)
        payload: dict[str, Any] = {
            "wave": name,
            "repository": repository,
            "issue_repository": issue_repository,
            "checkout": os.path.join(self.root, "checkout"),
            "worker_prefix": "w1",
            "agent_host": "mac-studio",
            "transport": "cli",
            "kind": "codex",
            "standing_purpose": "standing for @@T@@",
            "split": "issue-number",
            "vars": {"MAIN": "main"},
        }
        if profiles:
            payload["profiles"] = profiles
        path = os.path.join(wdir, "wave.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return path

    def write_board(self, wave_name: str, rows: list[tuple[str, dict[str, str]]]) -> None:
        for task, fields in rows:
            payload = {
                "wave": wave_name,
                "create": True,
                "new_row": True,
                "task": task,
                "fields": [[k, v] for k, v in fields.items()],
            }
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(boardstore.run(["-", self.root, "set", "coord", json.dumps(payload)]), 0)

    def run_cmd(self, args: list[str], *, gh_dir: str | None = None) -> tuple[int, str, str]:
        env = dict(self.env)
        if gh_dir is not None:
            env["PATH"] = f"{gh_dir}{os.pathsep}{env['PATH']}"
        cfg = load_config(SCRIPT, env, host="testbox")
        out_buf, err_buf = io.StringIO(), io.StringIO()
        with (
            mock.patch.dict(os.environ, env, clear=False),
            contextlib.redirect_stdout(out_buf),
            contextlib.redirect_stderr(err_buf),
        ):
            try:
                rc = wave.cmd_wave(cfg, args)
            except cli.Exit as exc:
                if exc.message:
                    err_buf.write(exc.message + "\n")
                rc = exc.rc
            except SystemExit as exc:
                rc = exc.code if isinstance(exc.code, int) else 1
        return rc, out_buf.getvalue(), err_buf.getvalue()

    def merged_row(
        self,
        task: str,
        pr: int,
        issue_num: int,
        arm: tuple[str, str, str],
        *,
        tier: str = "D2",
        host: str = "mac-studio",
        repo: str = "fork/proj",
        issue_repo: str = "upstream/proj",
        launched_at: str = "2026-11-24T10:00:00Z",
        state: str = "merged",
        use_source: bool = False,
        extra: dict[str, str] | None = None,
    ) -> tuple[str, dict[str, str]]:
        fields: dict[str, str] = {
            "state": state,
            "tier": tier,
            "transport": arm[0],
            "kind": arm[1],
            "model": arm[2],
            "agent_host": host,
            "repository": repo,
            "pr": str(pr),
            "merge": f"{pr:040x}",
            "launched_at": launched_at,
        }
        if use_source:
            fields["source"] = f"{issue_repo}#{issue_num}"
        else:
            fields["issue"] = f"{issue_repo}#{issue_num}"
        if extra:
            fields.update(extra)
        return task, fields


class TestScrubAndSides(unittest.TestCase):
    def test_scrub_closed_list_and_boundaries(self) -> None:
        raw = (
            "Task filed for gpt-6.2-sol/high vs gemini-4-neon-high and Claude Opus 5.5.\n"
            "Sol runs on Codex; Neon runs on Gemini via agy (Antigravity / Google DeepMind).\n"
            "Astra, Fable, OpenAI, Anthropic, Sonnet 4.6, Haiku 4.5, custom-arm-v9, profalpha.\n"
            "Branch gemini/w1125-1274 or codex/w1125-999.\n"
            "Co-Authored-By: Gemini 4 Neon <noreply@example.com>\n"
            "Keep solution, console, resolve, neonatal, codexed untouched.\n"
        )
        forbidden = (
            "gpt-6.2-sol", "gemini-4-neon-high", "Claude", "Opus", "5.5",
            "Sol", "Codex", "Neon", "Gemini", "agy", "Antigravity", "DeepMind",
            "Astra", "Fable", "OpenAI", "Anthropic", "Sonnet", "Haiku",
            "custom-arm-v9", "profalpha", "gemini/w1125-1274", "codex/w1125-999",
        )
        # Non-vacuity: every forbidden token appears in the raw text.
        for tok in forbidden:
            self.assertIn(tok, raw)

        scrubbed, hits = waveabpairs.scrub_text(raw, ("custom-arm-v9", "profalpha"))
        self.assertGreater(hits, 15)
        for tok in forbidden:
            self.assertIsNone(
                re.search(rf"(?i)(?<![A-Za-z0-9_]){re.escape(tok)}(?![A-Za-z0-9_])", scrubbed),
                f"token {tok!r} leaked in:\n{scrubbed}",
            )
        self.assertIn("Branch [branch] or [branch].", scrubbed)
        self.assertIn("Co-Authored-By: [agent]", scrubbed)
        # Adjacent [agent] tokens collapse cleanly (e.g. "Claude Opus 5.5" -> "[agent]").
        self.assertNotIn("[agent] [agent]", scrubbed)
        # Non-word boundary preservation: ordinary words stay intact.
        self.assertIn("Keep solution, console, resolve, neonatal, codexed untouched.", scrubbed)

    def test_self_ref_redaction_runs_before_model_scrub_for_vendor_repo_names(self) -> None:
        from ludics.prreview import core as prcore

        cand = waveabpairs.Candidate(
            wave="w-1",
            task="t101",
            tier="D2",
            group="D2",
            arm_label="cli/codex gpt-6.2-sol/high",
            arm_kind="codex",
            arm_model="gpt-6.2-sol/high",
            agent_host="mac-studio",
            repository="openai/codex",
            pr=202,
            merge=None,
            issue_ref="openai/codex#101",
            issue_repo="openai/codex",
            issue_number=101,
            launched_at="2026-11-24T10:00:00Z",
            task_dict={},
        )
        meta = waveabpairs.PrMeta("MERGED", "Fix", "2026-11-24T11:00:00Z", "2026-11-24T12:00:00Z", None, ())
        fixture: dict[str, Any] = {
            "issues": {
                "openai/codex#101": {
                    "title": "Fix https://github.com/openai/codex/issues/101#issuecomment-12345",
                    "body": (
                        "PR https://github.com/openai/codex/pull/202/files and codex#101,"
                        " unrelated https://github.com/openai/codex/issues/999."
                    ),
                    "comments": [],
                }
            },
            "diffs": {"openai/codex#202": "diff --git a/a b/a\n+x = 1\n"},
        }
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            env = {
                **os.environ,
                "PATH": f"{gh.dir}{os.pathsep}{os.environ.get('PATH', '')}",
                "SHIP_PR_API_ATTEMPTS": "1",
                "SHIP_PR_API_BACKOFF": "0",
            }
            with mock.patch.dict(os.environ, env, clear=False):
                session = prcore.GhSession(prcore.load_config(env))
                notes: list[str] = []
                errors: list[dict[str, str]] = []
                payload = waveabpairs.fetch_side(session, cand, meta, ("gpt-6.2-sol/high", "gpt-6.2-sol"), notes, errors)
        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertEqual(errors, [])
        self.assertNotIn("101", payload.task_md)
        self.assertNotIn("202", payload.task_md)
        self.assertIn("[this-issue]", payload.task_md)
        self.assertIn("[this-pr]", payload.task_md)
        self.assertIn("/999", payload.task_md)

    def test_balanced_sides_and_seed_determinism(self) -> None:
        o1, f1 = waveabpairs.assign_sides(15, 20261125)
        o2, f2 = waveabpairs.assign_sides(15, 20261125)
        self.assertEqual((o1, f1), (o2, f2))
        for seed in range(20):
            order_even, flags_even = waveabpairs.assign_sides(14, seed)
            self.assertEqual(sorted(order_even), list(range(14)))
            self.assertEqual(sum(flags_even), 7)
            order_odd, flags_odd = waveabpairs.assign_sides(15, seed)
            self.assertEqual(sorted(order_odd), list(range(15)))
            self.assertIn(sum(flags_odd), (7, 8))
        # Different seeds vary assignments.
        distinct = {tuple(waveabpairs.assign_sides(14, s)[1]) for s in range(10)}
        self.assertGreater(len(distinct), 1)


class TestFixtureWaveExport(BaseWaveAbPairs):
    def _build_fixture(self) -> tuple[str, dict[str, Any]]:
        wpath = self.make_wave(
            "w-ab",
            profiles={
                "sol": {"transport": "cli", "kind": "codex", "model": "gpt-6.2-sol", "effort": "high"},
                "neon": {"transport": "cli", "kind": "gemini", "model": "gemini-4-neon-high"},
                "canaryprof": {"transport": "cli", "kind": "codex", "model": "gpt-6.2-sol"},
            },
        )
        self.write_board("w-ab", [
            # Pair 1 (D2, shared dir pkg/alpha despite heavy shared tests/ churn)
            self.merged_row("t101", 201, 101, SOL_ARM, tier="D2"),
            self.merged_row("t102", 202, 102, NEON_ARM, tier="D2"),
            # Pair 2 (D2, exact same file pkg/beta/core.py with 10x size difference)
            self.merged_row("t103", 203, 103, SOL_ARM, tier="D2"),
            self.merged_row("t104", 204, 104, NEON_ARM, tier="D2"),
            # Unpaired (D2, disjoint directories)
            self.merged_row("t105", 205, 105, SOL_ARM, tier="D2"),
            self.merged_row("t106", 206, 106, NEON_ARM, tier="D2"),
            # Excluded rows (must never pair)
            self.merged_row("t107", 207, 107, SOL_ARM, tier="D2", extra={"reassignment_reason": "user choice"}),
            self.merged_row("t108", 208, 108, NEON_ARM, tier="D2", use_source=True),
            self.merged_row("t109", 209, 109, SOL_ARM, tier="D2", state="active"),
            self.merged_row("t110", 210, 110, NEON_ARM, tier=""),
            self.merged_row("t111", 211, 111, ("cli", "codex", ""), tier="D2"),
            # Different tier group touching pkg/alpha/foo.py (must not cross-pair with D2)
            self.merged_row("t112", 212, 112, NEON_ARM, tier="D1"),
        ])

        prs = {
            "fork/proj#201": _pr_files_node(
                201, [("pkg/alpha/foo.py", 80, 20), ("tests/test_shared.py", 400, 100)], title="Alpha foo"
            ),
            "fork/proj#202": _pr_files_node(
                202, [("pkg/alpha/bar.py", 25, 5), ("tests/test_shared.py", 450, 50)], title="Alpha bar"
            ),
            "fork/proj#203": _pr_files_node(203, [("pkg/beta/core.py", 15, 5)], title="Beta small"),
            "fork/proj#204": _pr_files_node(204, [("pkg/beta/core.py", 150, 50)], title="Beta large"),
            "fork/proj#205": _pr_files_node(205, [("pkg/gamma/x.py", 40, 10)], title="Gamma"),
            "fork/proj#206": _pr_files_node(206, [("pkg/delta/y.py", 40, 10)], title="Delta"),
            "fork/proj#212": _pr_files_node(212, [("pkg/alpha/foo.py", 10, 5)], title="D1 alpha"),
        }

        issues: dict[str, Any] = {
            "upstream/proj#101": {
                "title": "Fix Alpha foo for Sol (gpt-6.2-sol/high)",
                "body": "Codex and canaryprof and custombot need a clean solution in console.\n"
                        "Branch codex/w1-101.\nCo-Authored-By: Sol <sol@example.com>",
                "comments": [
                    {
                        "createdAt": "2026-11-24T09:00:00Z",
                        "body": "Decision before launch: keep scope tight.\n(Posted by the wave coordinator, Claude Opus 5.5)",
                    },
                    {
                        "createdAt": "2026-11-24T10:30:00Z",
                        "body": "## Reconciled plan\nPOST_LAUNCH_SECRET_MARKER should be excluded.",
                    },
                ],
            },
            "upstream/proj#102": {
                "title": "Fix Alpha bar for Neon (gemini-4-neon-high)",
                "body": "Gemini via agy on gemini/w1-102 should resolve this cleanly.",
                "comments": [],
            },
            "upstream/proj#103": {
                "title": "Beta core invariant",
                "body": "Check Fable and OpenAI wording; keep solution clear.",
                "comments": [],
            },
            "upstream/proj#104": {
                "title": "Beta core edge case",
                "body": "Check Anthropic and Google DeepMind wording.",
                "comments": [],
            },
        }

        diffs = {
            "fork/proj#201": "diff --git a/pkg/alpha/foo.py b/pkg/alpha/foo.py\n+sol = solve()\n",
            "fork/proj#202": "diff --git a/pkg/alpha/bar.py b/pkg/alpha/bar.py\n+claude_mode = True\n",
            "fork/proj#203": "diff --git a/pkg/beta/core.py b/pkg/beta/core.py\n+x = 1\n",
            "fork/proj#204": "diff --git a/pkg/beta/core.py b/pkg/beta/core.py\n+y = 2",
        }
        return wpath, {"prs": prs, "issues": issues, "diffs": diffs}

    def test_fixture_wave_pairing_scrub_and_blinding(self) -> None:
        wpath, fixture = self._build_fixture()
        # Non-vacuity: confirm the raw fixture issue text contains all leak tokens before export.
        raw_joined = json.dumps(fixture["issues"])
        leak_tokens = (
            "gpt-6.2-sol", "gemini-4-neon-high", "Claude", "Opus", "Codex", "Gemini",
            "Sol", "Neon", "agy", "Fable", "OpenAI", "Anthropic", "DeepMind",
            "canaryprof", "custombot", "codex/w1-101", "gemini/w1-102",
        )
        for tok in leak_tokens:
            self.assertIn(tok, raw_joined)

        out_dir = os.path.join(self.root, "export", "pairs")
        key_path = os.path.join(self.root, "export", "key.json")

        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, stdout, stderr = self.run_cmd(
                ["ab-pairs", wpath, "--out", out_dir, "--key", key_path, "--seed", "987654", "--scrub", "custombot"],
                gh_dir=gh.dir,
            )

        self.assertEqual(rc, 0, stderr)
        self.assertIn("WAVE AB-PAIRS: exported 2 pair(s)", stdout)
        # Stdout must not unblind (no seed, arm names, PR numbers, issue numbers, or task IDs).
        for secret in ("987654", "seed:", "gpt-6.2-sol", "gemini-4-neon-high", "201", "202", "203", "204", "t101", "t102"):
            self.assertNotIn(secret, stdout)

        with open(os.path.join(out_dir, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(manifest["version"], 1)
        self.assertEqual([p["pair"] for p in manifest["pairs"]], ["P01", "P02"])
        self.assertNotIn("seed", manifest)

        with open(key_path, encoding="utf-8") as f:
            key = json.load(f)
        self.assertEqual(key["version"], 1)
        self.assertEqual(key["seed"], 987654)
        self.assertEqual(len(key["pairs"]), 2)
        # Balanced A/B sides: 1 each for arm1 and arm2.
        a_arms = [p["A"]["arm"] for p in key["pairs"]]
        self.assertEqual(sorted(a_arms), sorted(key["arms"]))

        # Verify exact matched tasks and scores.
        task_pairs = {frozenset((p["A"]["task"], p["B"]["task"])): p for p in key["pairs"]}
        self.assertIn(frozenset(("t101", "t102")), task_pairs)
        self.assertIn(frozenset(("t103", "t104")), task_pairs)
        alpha_p = task_pairs[frozenset(("t101", "t102"))]
        beta_p = task_pairs[frozenset(("t103", "t104"))]
        self.assertEqual(alpha_p["shared_dirs"], ["pkg/alpha"])
        self.assertEqual(alpha_p["file_score"], 0.0)
        self.assertEqual(alpha_p["dir_score"], 1.0)
        self.assertEqual(beta_p["shared_files"], ["pkg/beta/core.py"])
        self.assertEqual(beta_p["file_score"], 1.0)
        self.assertEqual(beta_p["dir_score"], 1.0)

        # Unpaired & skipped accurately recorded.
        unpaired_tasks = {u["task"] for u in key["unpaired"]}
        self.assertEqual(unpaired_tasks, {"t105", "t106", "t112"})
        skipped_by_task = {s["task"]: s["why"] for s in key["skipped"]}
        self.assertIn("reassigned", skipped_by_task["t107"])
        self.assertIn("--source", skipped_by_task["t108"])
        self.assertIn("untiered", skipped_by_task["t110"])
        self.assertIn("incomplete arm", skipped_by_task["t111"])
        self.assertNotIn("t109", skipped_by_task)  # active, not merged

        # Verify scrubbed task files and unmodified diffs.
        all_tasks_text = ""
        all_diffs_text = ""
        for p in manifest["pairs"]:
            pdir = os.path.join(out_dir, p["dir"])
            for side in ("A", "B"):
                with open(os.path.join(pdir, f"{side}-task.md"), encoding="utf-8") as f:
                    ttext = f.read()
                with open(os.path.join(pdir, f"{side}.diff"), encoding="utf-8") as f:
                    dtext = f.read()
                self.assertTrue(dtext.endswith("\n"))
                all_tasks_text += ttext
                all_diffs_text += dtext
                for tok in leak_tokens:
                    self.assertIsNone(
                        re.search(rf"(?i)(?<![A-Za-z0-9_]){re.escape(tok)}(?![A-Za-z0-9_])", ttext),
                        f"leak {tok!r} in {p['pair']}/{side}-task.md:\n{ttext}",
                    )
                self.assertNotIn("POST_LAUNCH_SECRET_MARKER", ttext)

        self.assertIn("Decision before launch: keep scope tight.", all_tasks_text)
        self.assertIn("solution in console", all_tasks_text)
        self.assertIn("resolve this cleanly", all_tasks_text)
        self.assertIn("Co-Authored-By: [agent]", all_tasks_text)
        self.assertIn("[branch]", all_tasks_text)
        # Diffs remain intact (no corruption of code identifiers).
        self.assertIn("+sol = solve()", all_diffs_text)
        self.assertIn("+claude_mode = True", all_diffs_text)

    def test_from_json_matches_wave_export_and_legacy_fallback(self) -> None:
        wpath, fixture = self._build_fixture()
        rc, ab_json_text, stderr = self.run_cmd(["ab", wpath, "--no-github", "--json"])
        self.assertEqual(rc, 0, stderr)
        ab_json_path = os.path.join(self.root, "ab.json")
        with open(ab_json_path, "w", encoding="utf-8") as f:
            f.write(ab_json_text)

        out_dir = os.path.join(self.root, "fromjson", "pairs")
        key_path = os.path.join(self.root, "fromjson", "key.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                [
                    "ab-pairs", "--from-json", ab_json_path,
                    "--out", out_dir, "--key", key_path,
                    "--seed", "20261125", "--scrub", "canaryprof", "--scrub", "custombot",
                ],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 0, stderr)
        with open(key_path, encoding="utf-8") as f:
            key = json.load(f)
        self.assertEqual(len(key["pairs"]), 2)
        issues_used = {p["A"]["issue"] for p in key["pairs"]} | {p["B"]["issue"] for p in key["pairs"]}
        self.assertEqual(issues_used, {"upstream/proj#101", "upstream/proj#102", "upstream/proj#103", "upstream/proj#104"})

        # Legacy v1 wave ab --json lacking the additive "issue" field skips those tasks rather than
        # guessing the issue repository (which is wrong on cross-repository waves).
        legacy_doc = json.loads(ab_json_text)
        for t in legacy_doc["tasks"]:
            t.pop("issue", None)
        legacy_path = os.path.join(self.root, "legacy.json")
        with open(legacy_path, "w", encoding="utf-8") as f:
            json.dump(legacy_doc, f)
        out2 = os.path.join(self.root, "legacy", "pairs")
        key2 = os.path.join(self.root, "legacy", "key.json")
        rc, _, stderr = self.run_cmd(
            ["ab-pairs", "--from-json", legacy_path, "--out", out2, "--key", key2, "--seed", "7"],
        )
        self.assertEqual(rc, 1)
        self.assertIn("need two eligible complete arms", stderr)
        self.assertFalse(os.path.exists(out2))
        self.assertFalse(os.path.exists(key2))


class TestRefusalsAndEdgeCases(BaseWaveAbPairs):
    def test_key_separation_and_existing_targets_refused(self) -> None:
        wpath = self.make_wave("w-sep")
        out_dir = os.path.join(self.root, "pairs")

        # Key inside --out -> exit 2 before any board read.
        rc, _, stderr = self.run_cmd(["ab-pairs", wpath, "--out", out_dir, "--key", os.path.join(out_dir, "key.json")])
        self.assertEqual(rc, 2)
        self.assertIn("must live outside --out", stderr)

        # Key reaching inside --out through a symlink -> exit 2.
        os.makedirs(out_dir)
        link_dir = os.path.join(self.root, "alias")
        os.symlink(out_dir, link_dir)
        rc, _, stderr = self.run_cmd(["ab-pairs", wpath, "--out", out_dir, "--key", os.path.join(link_dir, "k.json")])
        self.assertEqual(rc, 2)
        self.assertIn("must live outside --out", stderr)

        # Non-empty --out -> exit 1.
        with open(os.path.join(out_dir, "keep.txt"), "w", encoding="utf-8") as f:
            f.write("existing\n")
        rc, _, stderr = self.run_cmd(["ab-pairs", wpath, "--out", out_dir, "--key", os.path.join(self.root, "k.json")])
        self.assertEqual(rc, 1)
        self.assertIn("output directory is not empty", stderr)

        # Existing --key -> exit 1.
        existing_key = os.path.join(self.root, "existing-key.json")
        with open(existing_key, "w", encoding="utf-8") as f:
            f.write("{}\n")
        rc, _, stderr = self.run_cmd(["ab-pairs", wpath, "--out", os.path.join(self.root, "fresh"), "--key", existing_key])
        self.assertEqual(rc, 1)
        self.assertIn("key path already exists", stderr)

        # Case-insensitive filesystem key-separation refusal (when supported by the host volume).
        if waveabpairs.dir_is_case_insensitive(self.root):
            rc, _, stderr = self.run_cmd([
                "ab-pairs", wpath,
                "--out", os.path.join(self.root, "casepairs"),
                "--key", os.path.join(self.root, "CasePairs", "key.json"),
            ])
            self.assertEqual(rc, 2)
            self.assertIn("must live outside --out", stderr)

    def test_unmerged_pr_missing_launched_at_self_ref_staging_and_non_utf8_diff(self) -> None:
        wpath = self.make_wave("w-guard")
        self.write_board("w-guard", [
            # Valid pair; t1 lacks launched_at -> comments omitted (never falls back to PR createdAt)
            self.merged_row("t1", 10, 10, SOL_ARM, tier="D2", launched_at=""),
            self.merged_row("t2", 20, 20, NEON_ARM, tier="D2"),
            # Board says merged, GitHub says OPEN -> must be excluded
            self.merged_row("t3", 30, 30, SOL_ARM, tier="D2"),
        ])
        raw_non_utf8 = b"diff --git a/pkg/m.py b/pkg/m.py\n+latin1=\xff\r\n"
        fixture: dict[str, Any] = {
            "prs": {
                "fork/proj#10": _pr_files_node(10, [("pkg/m.py", 10, 0)]),
                "fork/proj#20": _pr_files_node(20, [("pkg/m.py", 10, 0)]),
                "fork/proj#30": _pr_files_node(30, [("pkg/m.py", 10, 0)], state="OPEN", merge_oid=None),
            },
            "issues": {
                "upstream/proj#10": {
                    "title": "Fix upstream/proj#10 (proj#10) in w-guard (t1)",
                    "body": (
                        "See #10, fork/proj#10, https://github.com/upstream/proj/issues/10#issuecomment-12345,"
                        " and https://github.com/fork/proj/pull/10/files; unrelated #999 and"
                        " https://github.com/upstream/proj/issues/999 stay."
                    ),
                    "comments": [
                        {"createdAt": "2026-11-24T09:00:00Z", "body": "OMITTED_WHEN_NO_LAUNCHED_AT"},
                    ],
                },
                "upstream/proj#20": {"title": "Fix sibling", "body": "Ref #20, proj#20, and #888.", "comments": []},
            },
            "diffs": {
                "fork/proj#10": (
                    "diff --git a/pkg/m.py b/pkg/m.py\n"
                    "+# fix proj#10 (https://github.com/upstream/proj/issues/10) ref #999\n"
                    "+a = 1\n"
                ),
            },
            "diffs_b64": {
                "fork/proj#20": base64.b64encode(raw_non_utf8).decode("ascii"),
            },
        }
        # Unwritable key parent (regular file where key parent dir would be) -> exit 1, --out not left behind.
        blocker = os.path.join(self.root, "not-a-dir")
        with open(blocker, "w", encoding="utf-8") as f:
            f.write("file\n")
        bad_out = os.path.join(self.root, "staged-fail")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", wpath, "--out", bad_out, "--key", os.path.join(blocker, "key.json"), "--seed", "3"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 1)
        self.assertIn("failed to write export", stderr)
        self.assertFalse(os.path.exists(bad_out))

        # Good run: OPEN PR skipped, missing launched_at omits comments, self-refs redacted, non-UTF-8 diff preserved.
        out_dir = os.path.join(self.root, "guard-out")
        key_path = os.path.join(self.root, "guard-key.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", wpath, "--out", out_dir, "--key", key_path, "--seed", "3"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 0, stderr)
        with open(key_path, encoding="utf-8") as f:
            kd = json.load(f)
        self.assertEqual(len(kd["pairs"]), 1)
        self.assertTrue(any(s["task"] == "t3" and "not MERGED" in s["why"] for s in kd["skipped"]))
        self.assertTrue(any("no parseable launched_at" in n for n in kd["notes"]))
        all_tasks = ""
        diff_blobs: list[bytes] = []
        for side in ("A", "B"):
            with open(os.path.join(out_dir, "P01", f"{side}-task.md"), encoding="utf-8") as f:
                all_tasks += f.read()
            with open(os.path.join(out_dir, "P01", f"{side}.diff"), "rb") as f:
                diff_blobs.append(f.read())
        self.assertNotIn("OMITTED_WHEN_NO_LAUNCHED_AT", all_tasks)
        self.assertNotIn("upstream/proj#10", all_tasks)
        self.assertNotIn("proj#10", all_tasks)
        self.assertNotIn("issues/10", all_tasks)
        self.assertNotIn("pull/10", all_tasks)
        self.assertNotIn("proj#20", all_tasks)
        self.assertNotIn("w-guard", all_tasks)
        self.assertIn("[this-issue]", all_tasks)
        self.assertIn("[this-pr]", all_tasks)
        self.assertIn("#999", all_tasks)
        self.assertIn("https://github.com/upstream/proj/issues/999", all_tasks)
        self.assertIn("#888", all_tasks)
        self.assertIn(raw_non_utf8, diff_blobs)
        # Diff self-references (short form and URL) are redacted too while unrelated #999 stays.
        decoded_diffs = "".join(b.decode("utf-8", "surrogateescape") for b in diff_blobs)
        self.assertNotIn("proj#10", decoded_diffs)
        self.assertNotIn("issues/10", decoded_diffs)
        self.assertIn("[this-issue]", decoded_diffs)
        self.assertIn("#999", decoded_diffs)
        self.assertGreater(kd["pairs"][0]["A"]["diff_scrub_hits"] + kd["pairs"][0]["B"]["diff_scrub_hits"], 0)

    def test_duplicate_pr_mismatch_excluded_and_partial_rename_rolls_back(self) -> None:
        w1 = self.make_wave("w-dup1")
        w2 = self.make_wave("w-dup2")
        # Both w-dup1/t1 (mismatched merge SHA) and w-dup2/t1b (matching SHA) point to fork/proj#10.
        self.write_board("w-dup1", [
            self.merged_row("t1", 10, 10, SOL_ARM, tier="D2", extra={"merge": "f" * 40}),
            self.merged_row("t2", 20, 20, NEON_ARM, tier="D2"),
        ])
        self.write_board("w-dup2", [
            self.merged_row("t1b", 10, 10, SOL_ARM, tier="D2"),
            self.merged_row("t3", 30, 30, SOL_ARM, tier="D2"),
            self.merged_row("t4", 40, 40, NEON_ARM, tier="D2"),
        ])
        fixture: dict[str, Any] = {
            "prs": {
                "fork/proj#10": _pr_files_node(10, [("pkg/a.py", 10, 0)]),
                "fork/proj#20": _pr_files_node(20, [("pkg/a.py", 10, 0)]),
                "fork/proj#30": _pr_files_node(30, [("pkg/b.py", 10, 0)]),
                "fork/proj#40": _pr_files_node(40, [("pkg/b.py", 10, 0)]),
            },
            "issues": {
                f"upstream/proj#{n}": {"title": f"T{n}", "body": "Spec", "comments": []}
                for n in (10, 20, 30, 40)
            },
            "diffs": {
                f"fork/proj#{n}": f"diff --git a/pkg/f b/pkg/f\n+{n}\n" for n in (10, 20, 30, 40)
            },
        }
        out_dir = os.path.join(self.root, "dup-out")
        key_path = os.path.join(self.root, "dup-key.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", w1, w2, "--out", out_dir, "--key", key_path, "--seed", "9"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 0, stderr)
        with open(key_path, encoding="utf-8") as f:
            kd = json.load(f)
        paired_tasks = {
            (p["A"]["wave"], p["A"]["task"]) for p in kd["pairs"]
        } | {
            (p["B"]["wave"], p["B"]["task"]) for p in kd["pairs"]
        }
        # w-dup1/t1 had a merge-commit mismatch and must appear ONLY in skipped, never in pairs.
        self.assertNotIn(("w-dup1", "t1"), paired_tasks)
        self.assertIn(("w-dup2", "t1b"), paired_tasks)
        self.assertTrue(any(s["wave"] == "w-dup1" and s["task"] == "t1" and "mismatch" in s["why"] for s in kd["skipped"]))

        # Existing empty --out: inject OSError on the second os.rename -> rolls back first entry and key.
        empty_out = os.path.join(self.root, "empty-rollback")
        os.makedirs(empty_out)
        rb_key = os.path.join(self.root, "rollback-key.json")
        real_rename = os.rename
        calls = {"n": 0}

        def failing_rename(src: str, dst: str) -> None:
            if dst.startswith(empty_out + os.sep):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise OSError("simulated ENOSPC")
            real_rename(src, dst)

        with FakeTool("gh") as gh, mock.patch.object(os, "rename", side_effect=failing_rename):
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", w1, w2, "--out", empty_out, "--key", rb_key, "--seed", "9"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 1)
        self.assertIn("simulated ENOSPC", stderr)
        self.assertEqual(os.listdir(empty_out), [])
        self.assertFalse(os.path.exists(rb_key))

    def test_one_to_one_by_pr_identity_and_conflicting_arm_rejection(self) -> None:
        w1 = self.make_wave("w-pr1")
        w2 = self.make_wave("w-pr2")
        # Both w-pr1/t1 and w-pr2/t1dup are valid Sol rows for PR #10 -> must pair PR #10 at most once.
        # w-pr1/t9 (Sol) and w-pr2/t9conflict (Neon) disagree on arm for PR #90 -> both excluded.
        self.write_board("w-pr1", [
            self.merged_row("t1", 10, 10, SOL_ARM, tier="D2"),
            self.merged_row("t2", 20, 20, NEON_ARM, tier="D2"),
            self.merged_row("t9", 90, 90, SOL_ARM, tier="D2"),
        ])
        self.write_board("w-pr2", [
            self.merged_row("t1dup", 10, 10, SOL_ARM, tier="D2"),
            self.merged_row("t3", 30, 30, NEON_ARM, tier="D2"),
            self.merged_row("t9conflict", 90, 90, NEON_ARM, tier="D2"),
        ])
        fixture: dict[str, Any] = {
            "prs": {
                "fork/proj#10": _pr_files_node(10, [("pkg/a.py", 10, 0)]),
                "fork/proj#20": _pr_files_node(20, [("pkg/a.py", 10, 0)]),
                "fork/proj#30": _pr_files_node(30, [("pkg/a.py", 10, 0)]),
                "fork/proj#90": _pr_files_node(90, [("pkg/z.py", 10, 0)]),
            },
            "issues": {
                f"upstream/proj#{n}": {"title": f"T{n}", "body": "Spec", "comments": []}
                for n in (10, 20, 30, 90)
            },
            "diffs": {
                f"fork/proj#{n}": f"diff --git a/pkg/f b/pkg/f\n+{n}\n" for n in (10, 20, 30, 90)
            },
        }
        out_dir = os.path.join(self.root, "prid-out")
        key_path = os.path.join(self.root, "prid-key.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", w1, w2, "--out", out_dir, "--key", key_path, "--seed", "5"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 0, stderr)
        with open(key_path, encoding="utf-8") as f:
            kd = json.load(f)
        # Only 1 pair (PR #10 paired once, never double-counted with both #20 and #30).
        self.assertEqual(len(kd["pairs"]), 1)
        paired_prs = {kd["pairs"][0]["A"]["pr"], kd["pairs"][0]["B"]["pr"]}
        self.assertIn("10", paired_prs)
        self.assertNotIn("90", paired_prs)
        skipped_by_wt = {(s["wave"], s["task"]): s["why"] for s in kd["skipped"]}
        self.assertIn("duplicate PR", skipped_by_wt[("w-pr2", "t1dup")])
        self.assertIn("conflicting", skipped_by_wt[("w-pr1", "t9")])
        self.assertIn("conflicting", skipped_by_wt[("w-pr2", "t9conflict")])

    def test_arms_group_max_pairs_and_zero_matches(self) -> None:
        wpath = self.make_wave("w-multi")
        self.write_board("w-multi", [
            self.merged_row("t1", 1, 1, SOL_ARM, tier="D2"),
            self.merged_row("t2", 2, 2, NEON_ARM, tier="D2"),
            self.merged_row("t3", 3, 3, OPUS_ARM, tier="D2"),
            self.merged_row("t4", 4, 4, SOL_ARM, tier="D1"),
            self.merged_row("t5", 5, 5, NEON_ARM, tier="D1"),
        ])
        fixture: dict[str, Any] = {
            "prs": {
                "fork/proj#1": _pr_files_node(1, [("a/x.py", 10, 0)]),
                "fork/proj#2": _pr_files_node(2, [("a/x.py", 10, 0)]),
                "fork/proj#3": _pr_files_node(3, [("a/x.py", 10, 0)]),
                "fork/proj#4": _pr_files_node(4, [("b/y.py", 10, 0)]),
                "fork/proj#5": _pr_files_node(5, [("b/z.py", 10, 0)]),
            },
            "issues": {
                f"upstream/proj#{n}": {"title": f"Issue {n}", "body": "Body", "comments": []}
                for n in range(1, 6)
            },
            "diffs": {
                f"fork/proj#{n}": f"diff --git a/f b/f\n+{n}\n" for n in range(1, 6)
            },
        }
        # 3 complete arms without --arms -> exit 2.
        rc, _, stderr = self.run_cmd(
            ["ab-pairs", wpath, "--out", os.path.join(self.root, "o1"), "--key", os.path.join(self.root, "k1.json")]
        )
        self.assertEqual(rc, 2)
        self.assertIn("found 3 complete arms", stderr)

        # With --arms and --max-pairs 1 -> keeps highest-scoring pair (exact file a/x.py in D2), caps D1 pair.
        out2, key2 = os.path.join(self.root, "o2"), os.path.join(self.root, "k2.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                [
                    "ab-pairs", wpath, "--out", out2, "--key", key2,
                    "--arms", "cli/codex gpt-6.2-sol/high", "cli/gemini gemini-4-neon-high",
                    "--max-pairs", "1", "--seed", "1",
                ],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 0, stderr)
        with open(key2, encoding="utf-8") as f:
            kd = json.load(f)
        self.assertEqual(len(kd["pairs"]), 1)
        self.assertEqual(kd["pairs"][0]["group"], "D2")
        self.assertTrue(any("--max-pairs" in u["why"] for u in kd["unpaired"]))

        # --group D1+D1/D2 with only 2 arms present in D1 -> auto-selects without --arms!
        out3, key3 = os.path.join(self.root, "o3"), os.path.join(self.root, "k3.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", wpath, "--out", out3, "--key", key3, "--group", "D1+D1/D2", "--seed", "1"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 0, stderr)
        with open(key3, encoding="utf-8") as f:
            kd3 = json.load(f)
        self.assertEqual(len(kd3["pairs"]), 1)
        self.assertEqual(kd3["pairs"][0]["group"], "D1+D1/D2")

        # Zero area-matched pairs -> exit 1, nothing created.
        disjoint_fx: dict[str, Any] = {
            **fixture,
            "prs": {
                "fork/proj#4": _pr_files_node(4, [("left/a.py", 10, 0)]),
                "fork/proj#5": _pr_files_node(5, [("right/b.py", 10, 0)]),
            },
        }
        out4, key4 = os.path.join(self.root, "o4"), os.path.join(self.root, "k4.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, disjoint_fx)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", wpath, "--out", out4, "--key", key4, "--group", "D1+D1/D2"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 1)
        self.assertIn("no area-matched pairs found", stderr)
        self.assertFalse(os.path.exists(out4))
        self.assertFalse(os.path.exists(key4))

    def test_github_fallback_mismatch_and_partial_errors(self) -> None:
        wpath = self.make_wave("w-err")
        self.write_board("w-err", [
            # Pair 1: PR 1 uses REST --paginate fallback (files hasNextPage=True)
            self.merged_row("t1", 1, 1, SOL_ARM, tier="D2"),
            self.merged_row("t2", 2, 2, NEON_ARM, tier="D2"),
            # Pair 2: diff fetch fails for PR 4 -> pair dropped -> exit 3
            self.merged_row("t3", 3, 3, SOL_ARM, tier="D2"),
            self.merged_row("t4", 4, 4, NEON_ARM, tier="D2"),
            # Mismatched merge commit -> skipped with note
            self.merged_row("t5", 5, 5, SOL_ARM, tier="D2"),
            # GraphQL alias failure -> subdivided so sibling PRs still read
            self.merged_row("t6", 6, 6, NEON_ARM, tier="D2"),
        ])
        fixture: dict[str, Any] = {
            "prs": {
                "fork/proj#1": _pr_files_node(1, [], has_next=True),
                "fork/proj#2": _pr_files_node(2, [("mod_a/x.py", 10, 0)]),
                "fork/proj#3": _pr_files_node(3, [("mod_b/y.py", 10, 0)]),
                "fork/proj#4": _pr_files_node(4, [("mod_b/y.py", 10, 0)]),
                "fork/proj#5": _pr_files_node(5, [("mod_c/z.py", 10, 0)], merge_oid="f" * 40),
            },
            "fail_graphql": ["fork/proj#6"],
            "rest_files": {
                "repos/fork/proj/pulls/1/files": (
                    '[{"filename":"mod_a/x.py","additions":12,"deletions":3}]'
                    '[{"filename":"tests/test_x.py","additions":50,"deletions":0}]'
                ),
            },
            "issues": {
                f"upstream/proj#{n}": {"title": f"T{n}", "body": "Spec", "comments": []}
                for n in (1, 2, 3, 4)
            },
            "diffs": {
                "fork/proj#1": "diff --git a/mod_a/x.py b/mod_a/x.py\n+1\n",
                "fork/proj#2": "diff --git a/mod_a/x.py b/mod_a/x.py\n+2\n",
                "fork/proj#3": "diff --git a/mod_b/y.py b/mod_b/y.py\n+3\n",
                # fork/proj#4 intentionally missing -> diff 404
            },
        }
        out_dir = os.path.join(self.root, "partial", "pairs")
        key_path = os.path.join(self.root, "partial", "key.json")
        with FakeTool("gh") as gh:
            _install_gh_fake(gh, fixture)
            rc, _, stderr = self.run_cmd(
                ["ab-pairs", wpath, "--out", out_dir, "--key", key_path, "--seed", "42"],
                gh_dir=gh.dir,
            )
        self.assertEqual(rc, 3, stderr)
        with open(key_path, encoding="utf-8") as f:
            kd = json.load(f)
        self.assertEqual(len(kd["pairs"]), 1)
        self.assertEqual({kd["pairs"][0]["A"]["task"], kd["pairs"][0]["B"]["task"]}, {"t1", "t2"})
        self.assertEqual(kd["pairs"][0]["file_score"], 1.0)
        self.assertTrue(any("disagrees with GitHub" in n for n in kd["notes"]))
        self.assertTrue(any(e.get("pr") == "fork/proj#4" for e in kd["errors"]))
        self.assertTrue(any(e.get("pr") == "fork/proj#6" for e in kd["errors"]))

    def test_area_profile_exact_fraction_and_fallback_to_non_src(self) -> None:
        # Pure docs PR falls back to all changed files when no src files exist.
        files = (
            waveabpairs.FileChange("issue-wave/SKILL.md", 10, 5),
            waveabpairs.FileChange("issue-wave/references/ab-judging.md", 30, 0),
        )
        f_shares, d_shares = waveabpairs.area_profile(files)
        self.assertEqual(f_shares["issue-wave/SKILL.md"], Fraction(15, 45))
        self.assertEqual(f_shares["issue-wave/references/ab-judging.md"], Fraction(30, 45))
        self.assertEqual(d_shares["issue-wave"], Fraction(1, 3))
        self.assertEqual(d_shares["issue-wave/references"], Fraction(2, 3))


if __name__ == "__main__":
    unittest.main()
