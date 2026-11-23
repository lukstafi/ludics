"""ludics.fleetworker.waveab (``wave ab``, ludics#1274): read-only A/B comparison across waves.

Exercises the pure join/fold and end-to-end command against real ``boardstore`` boards under a
scratch anchor, hand-written ``reviews/*.json`` records, and faked ``gh`` GraphQL/REST answers.
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import boardstore, transport, wave, waveab, waveprep
from ludics.fleetworker.config import load_config
from ludics.fleetworker.transport import UNREACHABLE, Done
from ludics.prreview.feeds import CONNECTOR_FIXED_REPLIES
from ludics.tests.fake import Answer, FakeTool

CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SCRIPT = os.path.join(CHECKOUT, "issue-wave", "scripts", "fleet-worker.sh")

SOL_ARM = ("cli", "codex", "gpt-6.2-sol/high")
NEON_ARM = ("cli", "gemini", "gemini-4-neon-high")
ASTRA_ARM = ("cli", "codex", "gpt-6.2-astra/high")
OPUS_ARM = ("subagent", "claude", "claude-opus-5-5")

_GRAPHQL_GH = """\
import json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "prs.json"), encoding="utf-8") as f:
    prs = json.load(f)
query = ""
for i, arg in enumerate(argv):
    if arg == "-f" and i + 1 < len(argv) and argv[i + 1].startswith("query="):
        query = argv[i + 1][len("query="):]
alias_re = re.compile(r'(p\\d+):\\s*repository\\(owner:\\s*"([^"]+)",\\s*name:\\s*"([^"]+)"\\)\\s*\\{\\s*pullRequest\\(number:\\s*(\\d+)\\)')
data = {}
for m in alias_re.finditer(query):
    alias, owner, name, num_s = m.groups()
    data[alias] = {"pullRequest": prs.get(f"{owner}/{name}#{num_s}")}
sys.stdout.write(json.dumps({"data": data}))
"""


def _install_graphql_fake(gh: FakeTool, prs: dict[tuple[str, int], dict[str, Any]]) -> None:
    with open(os.path.join(gh.dir, "prs.json"), "w", encoding="utf-8") as f:
        json.dump({f"{repo}#{num}": node for (repo, num), node in prs.items()}, f)
    tool_path = os.path.join(gh.dir, "gh")
    with open(tool_path, "w", encoding="utf-8") as f:
        f.write(f"#!{sys.executable}\n{_GRAPHQL_GH}")
    os.chmod(tool_path, 0o755)


def _pr_node(
    number: int,
    *,
    state: str = "MERGED",
    created_at: str = "2026-11-22T10:30:00Z",
    merged_at: str | None = "2026-11-22T12:00:00Z",
    reviews: list[dict[str, Any]] | None = None,
    comments: list[dict[str, Any]] | None = None,
    reviews_more: bool = False,
    comments_more: bool = False,
) -> dict[str, Any]:
    return {
        "number": number,
        "state": state,
        "createdAt": created_at,
        "mergedAt": merged_at,
        "mergeCommit": {"oid": f"{number:040x}"} if merged_at else None,
        "reviews": {"pageInfo": {"hasNextPage": reviews_more}, "nodes": reviews or []},
        "comments": {"pageInfo": {"hasNextPage": comments_more}, "nodes": comments or []},
    }


class BaseWaveAb(unittest.TestCase):
    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ludics-waveab-test."))
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

    def make_wave(self, name: str, *, repository: str = "o/repo", split: str = "") -> str:
        wdir = os.path.join(self.root, name)
        os.makedirs(wdir, exist_ok=True)
        payload: dict[str, Any] = {
            "wave": name,
            "repository": repository,
            "issue_repository": repository,
            "checkout": os.path.join(self.root, "checkout"),
            "worker_prefix": "w1",
            "agent_host": "mac-studio",
            "transport": "subagent",
            "kind": "claude",
            "standing_purpose": "standing for @@T@@",
            "vars": {"MAIN": "main"},
        }
        if split:
            payload["split"] = split
        path = os.path.join(wdir, "wave.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return path

    def add_row(self, wave_name: str, task: str, **fields: str) -> None:
        payload = {
            "wave": wave_name,
            "create": True,
            "new_row": True,
            "task": task,
            "fields": [[k, v] for k, v in fields.items()],
        }
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(boardstore.run(["-", self.root, "set", "coord", json.dumps(payload)]), 0)

    def write_board_raw(self, wave_name: str, tasks: list[dict[str, Any]]) -> None:
        at = "2026-11-22T10:00:00Z"
        path = os.path.join(self.root, "boards", f"{wave_name}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "board": 1,
                "wave": wave_name,
                "created_at": at,
                "created_by": "coord",
                "updated_at": at,
                "notes": {},
                "tasks": tasks,
                "log": [],
            }, f)

    def write_review(
        self,
        wave_name: str,
        filename: str,
        *,
        task: str,
        pr: str,
        kind: str,
        word: str,
        blocking: int = 0,
        suggestions: int = 0,
        at: str = "2026-11-22T11:00:00Z",
        comment: str = "https://github.com/o/repo/pull/1#issuecomment-1",
        dry_run: bool = False,
    ) -> str:
        rdir = os.path.join(self.root, wave_name, "reviews")
        os.makedirs(rdir, exist_ok=True)
        path = os.path.join(rdir, filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "task": task,
                "pr": pr,
                "kind": kind,
                "sha": "a" * 40,
                "at": at,
                "verdict": {"word": word, "blocking": blocking, "suggestions": suggestions, "line": f"VERDICT: {word}"},
                "decision": "confirm" if word == "blocking" else "merge",
                "comment": comment,
                "dry_run": dry_run,
            }, f)
        return path

    def run_ab(self, *args: str, cfg: Any = None) -> tuple[int, str, str]:
        out, err_buf = io.StringIO(), io.StringIO()
        use_cfg = cfg or self.cfg
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err_buf):
            try:
                rc = wave.cmd_wave(use_cfg, ["ab", *args])
            except cli.Exit as exc:
                rc = exc.rc
                err_buf.write(exc.message)
        return rc, out.getvalue(), err_buf.getvalue()


class GroupingAndThresholds(BaseWaveAb):
    """Fixture wave with known answers pinning tier groups, ten-per-arm, reassignments and host balance."""

    def test_groups_partition_waveprep_tiers(self) -> None:
        all_grouped = [t for _, tiers in waveab.GROUPS for t in tiers]
        self.assertEqual(len(all_grouped), len(set(all_grouped)))
        self.assertEqual(set(all_grouped), set(waveprep.TIERS))
        self.assertEqual(waveab.group_of("D1"), "D1+D1/D2")
        self.assertEqual(waveab.group_of("D1/D2"), "D1+D1/D2")
        self.assertEqual(waveab.group_of("D2"), "D2")
        self.assertEqual(waveab.group_of("D2/D3"), "D2/D3+D3")
        self.assertEqual(waveab.group_of("D3"), "D2/D3+D3")
        self.assertEqual(waveab.group_of(None), "untiered")
        self.assertEqual(waveab.group_of("D4"), "untiered")

    def test_known_answer_fixture_wave_pins_grouping_threshold_reassigned_and_hosts(self) -> None:
        wpath = self.make_wave("w-fix", split="issue-number")
        prs: dict[tuple[str, int], dict[str, Any]] = {}
        pr_num = 100

        def plant_task(
            task: str,
            arm: tuple[str, str, str],
            *,
            tier: str | None,
            host: str = "mac-studio",
            state: str = "merged",
            issue_num: int = 1,
            use_source: bool = False,
            reassignment_reason: str | None = None,
            interventions: str = "0",
            routine: str = "1",
            relaunches: str = "0",
            launched_at: str = "2026-11-22T10:00:00Z",
            merged_at: str = "2026-11-22T12:00:00Z",
            created_at: str = "2026-11-22T11:00:00Z",
            bot_reviews: list[dict[str, Any]] | None = None,
        ) -> int:
            nonlocal pr_num
            pr_num += 1
            fields: dict[str, str] = {
                "transport": arm[0],
                "kind": arm[1],
                "model": arm[2],
                "agent_host": host,
                "repository": "o/repo",
                "state": state,
                "launched_at": launched_at,
                "interventions": interventions,
                "routine_answers": routine,
                "relaunches": relaunches,
            }
            if tier is not None:
                fields["tier"] = tier
            if use_source:
                fields["source"] = f"o/repo#{issue_num}"
            else:
                fields["issue"] = f"o/repo#{issue_num}"
            if state == "merged":
                fields["pr"] = str(pr_num)
                fields["merge"] = f"{pr_num:040x}"
                prs[("o/repo", pr_num)] = _pr_node(pr_num, created_at=created_at, merged_at=merged_at, reviews=bot_reviews)
            if reassignment_reason is not None:
                fields["reassignment_reason"] = reassignment_reason
            self.add_row("w-fix", task, **fields)
            return pr_num

        # D1+D1/D2: Sol 9 D1 + 1 D1/D2 (=10 merged, balanced on mac-studio), Neon 10 D1 (=10 merged) -> READY
        for i in range(9):
            p = plant_task(f"t{101 + 2 * i}", SOL_ARM, tier="D1", issue_num=101 + 2 * i, interventions="1" if i == 0 else "0")
            self.write_review("w-fix", f"{p}-at-open-{'a'*12}.json", task=f"t{101 + 2 * i}", pr=str(p),
                              kind="at-open", word="clean", blocking=0, suggestions=0)
        p_d12 = plant_task("t199", SOL_ARM, tier="D1/D2", issue_num=199,
                           bot_reviews=[{"author": {"login": "chatgpt-codex-connector"}, "state": "COMMENTED",
                                         "submittedAt": "2026-11-22T11:10:00Z", "commit": {"oid": "1" * 40},
                                         "body": "finding 1", "comments": {"pageInfo": {"hasNextPage": False}, "nodes": []}}])
        self.write_review("w-fix", f"{p_d12}-at-open-{'a'*12}.json", task="t199", pr=str(p_d12),
                          kind="at-open", word="blocking", blocking=2, suggestions=1)
        self.write_review("w-fix", f"{p_d12}-confirm-{'b'*12}.r1.json", task="t199", pr=str(p_d12),
                          kind="confirm", word="blocking", blocking=1, suggestions=0, at="2026-11-22T11:30:00Z")
        self.write_review("w-fix", f"{p_d12}-confirm-{'b'*12}.json", task="t199", pr=str(p_d12),
                          kind="confirm", word="clean", blocking=0, suggestions=0, at="2026-11-22T11:45:00Z")
        # Dry-run and .run.json must be ignored
        self.write_review("w-fix", f"{p_d12}-confirm-{'c'*12}.json", task="t199", pr=str(p_d12),
                          kind="confirm", word="blocking", blocking=5, suggestions=0, dry_run=True)
        with open(os.path.join(self.root, "w-fix", "reviews", f"{p_d12}-at-open-{'a'*12}.run.json"), "w", encoding="utf-8") as f:
            f.write("{not a review record")

        for i in range(10):
            p = plant_task(f"t{200 + 2 * i}", NEON_ARM, tier="D1", issue_num=200 + 2 * i,
                           merged_at="2026-11-22T13:00:00Z")
            self.write_review("w-fix", f"{p}-at-open-{'a'*12}.json", task=f"t{200 + 2 * i}", pr=str(p),
                              kind="at-open", word="suggestions", blocking=0, suggestions=2)

        # D2: Sol 10 merged on mac-studio; Neon 9 merged on macbook-pro + 1 done + 1 merged REASSIGNED -> NOT READY, IMBALANCED
        for i in range(10):
            plant_task(f"t{301 + 2 * i}", SOL_ARM, tier="D2", host="mac-studio", issue_num=301 + 2 * i)
        for i in range(9):
            plant_task(f"t{400 + 2 * i}", NEON_ARM, tier="D2", host="macbook-pro", issue_num=400 + 2 * i)
        plant_task("t450", NEON_ARM, tier="D2", host="macbook-pro", state="done, no PR", issue_num=450)
        plant_task("t451", NEON_ARM, tier="D2", host="macbook-pro", state="merged", issue_num=451,
                   reassignment_reason="approved host test")

        # D2/D3+D3: Sol 1 D2/D3 + 1 D3 (=2), Neon 1 D2/D3 (=1, via --source), Astra 1 D3 (=1) -> NOT READY
        plant_task("t501", SOL_ARM, tier="D2/D3", issue_num=501)
        plant_task("t503", SOL_ARM, tier="D3", issue_num=503)
        plant_task("p502", NEON_ARM, tier="D2/D3", issue_num=502, use_source=True)
        plant_task("t505", ASTRA_ARM, tier="D3", issue_num=505)

        # Untiered: one with no tier, one with unknown tier D4
        plant_task("t601", SOL_ARM, tier=None, issue_num=601)
        plant_task("t602", NEON_ARM, tier="D4", issue_num=602)

        with FakeTool("gh") as gh:
            _install_graphql_fake(gh, prs)
            cfg = load_config(SCRIPT, {**self.env, "PATH": os.environ["PATH"]}, host="testbox")
            rc_j, out_j, err_j = self.run_ab(wpath, "--json", cfg=cfg)
            rc_m, out_m, err_m = self.run_ab(wpath, cfg=cfg)

        self.assertEqual((rc_j, err_j), (0, ""))
        self.assertEqual((rc_m, err_m), (0, ""))
        doc = json.loads(out_j)

        # Readings
        by_group = {r["group"]: r for r in doc["readings"]}
        self.assertTrue(by_group["D1+D1/D2"]["ready"])
        self.assertEqual(by_group["D1+D1/D2"]["at_ten"], {"cli/codex gpt-6.2-sol/high": 10, "cli/gemini gemini-4-neon-high": 10})
        self.assertFalse(by_group["D2"]["ready"])
        self.assertEqual(by_group["D2"]["at_ten"], {"cli/codex gpt-6.2-sol/high": 10})
        self.assertEqual(by_group["D2"]["below_ten"], {"cli/gemini gemini-4-neon-high": 9})
        self.assertFalse(by_group["D2/D3+D3"]["ready"])
        self.assertEqual(by_group["D2/D3+D3"]["below_ten"], {
            "cli/codex gpt-6.2-astra/high": 1,
            "cli/codex gpt-6.2-sol/high": 2,
            "cli/gemini gemini-4-neon-high": 1,
        })
        self.assertEqual(doc["untiered"], {"rows": 2, "merged": 2})

        # Reassigned set apart
        self.assertEqual(len(doc["reassigned"]), 1)
        self.assertEqual(doc["reassigned"][0]["task"], "t451")
        self.assertEqual(doc["reassigned"][0]["reason"], "approved host test")

        # Host distribution
        hosts_by_group = {h["group"]: h["balance"] for h in doc["host_distribution"]}
        self.assertEqual(hosts_by_group["D1+D1/D2"], "balanced")
        self.assertEqual(hosts_by_group["D2"], "IMBALANCED")

        # Cell metrics: D1+D1/D2 Sol has 9 clean + 1 blocking (2 blk, 1 sugg), 2 confirms (1 blocking via .r1.json), 1 intervention, 2h launch->merge
        cells = {(c["group"], c["arm"]["label"]): c for c in doc["cells"]}
        d1_sol = cells[("D1+D1/D2", "cli/codex gpt-6.2-sol/high")]
        self.assertEqual(d1_sol["at_open"], {"clean": 9, "suggestions": 0, "blocking": 1, "unreadable": 0, "missing": 0})
        self.assertEqual(d1_sol["findings"], {"blocking": 2, "suggestions": 1, "reviewed": 10, "total": 10})
        self.assertEqual(d1_sol["confirm"], {"rounds": 2, "not_cleared": 1, "tasks_with_confirm": 1})
        self.assertEqual(d1_sol["counters"]["interventions"]["sum"], 1)
        self.assertEqual(d1_sol["launch_to_merge_hours"]["median"], 2.0)
        self.assertEqual(d1_sol["open_to_merge_hours"]["median"], 1.0)
        self.assertEqual(d1_sol["review_rounds"]["mean"], 0.1)

        # D2 Neon has rows=10 (9 merged + 1 done), merged=9 (reassigned t451 excluded from both)
        d2_neon = cells[("D2", "cli/gemini gemini-4-neon-high")]
        self.assertEqual((d2_neon["rows"], d2_neon["merged"]), (10, 9))

        # Parity includes --source task p502 (even=502)
        wave_parity = doc["waves"][0]["parity"]
        self.assertEqual(wave_parity["cli/gemini gemini-4-neon-high"], {"odd": 0, "even": 22, "no_number": 0})
        self.assertEqual(wave_parity["cli/codex gpt-6.2-sol/high"], {"odd": 23, "even": 0, "no_number": 0})

        # Markdown renders readings, host section before comparison, and reassigned section
        self.assertIn("READING D1+D1/D2: at ten —", out_m)
        self.assertIn("READING D2: below ten (a description, not a reading) —", out_m)
        self.assertIn("IMBALANCED", out_m)
        self.assertLess(out_m.index("## Agent host distribution"), out_m.index("## Comparison"))
        self.assertIn("approved host test", out_m)

    def test_three_arm_group_with_two_at_ten_marks_partial_arm_count(self) -> None:
        wpath = self.make_wave("w-three")
        for i in range(10):
            self.add_row("w-three", f"ts{i}", state="merged", tier="D2", transport=SOL_ARM[0], kind=SOL_ARM[1],
                         model=SOL_ARM[2], agent_host="mac-studio", repository="o/repo", pr=str(10 + i))
            self.add_row("w-three", f"tn{i}", state="merged", tier="D2", transport=NEON_ARM[0], kind=NEON_ARM[1],
                         model=NEON_ARM[2], agent_host="mac-studio", repository="o/repo", pr=str(30 + i))
        self.add_row("w-three", "ta0", state="merged", tier="D2", transport=ASTRA_ARM[0], kind=ASTRA_ARM[1],
                     model=ASTRA_ARM[2], agent_host="mac-studio", repository="o/repo", pr="50")

        rc_j, out_j, _ = self.run_ab(wpath, "--no-github", "--json")
        rc_m, out_m, _ = self.run_ab(wpath, "--no-github")
        self.assertEqual((rc_j, rc_m), (0, 0))
        d2 = {r["group"]: r for r in json.loads(out_j)["readings"]}["D2"]
        self.assertTrue(d2["ready"])
        self.assertEqual(d2["below_ten"], {"cli/codex gpt-6.2-astra/high": 1})
        self.assertIn("READING D2: at ten (2 of 3 arms) —", out_m)
        self.assertIn("below ten: cli/codex gpt-6.2-astra/high 1 of 10", out_m)


class MissingPartialAndErrors(BaseWaveAb):
    def test_missing_counters_partial_markers_and_legacy_rows_are_never_guessed(self) -> None:
        wpath = self.make_wave("w-legacy")
        at = "2026-11-17T10:00:00Z"
        self.write_board_raw("w-legacy", [
            # Legacy row: status=merged, no counters, no launched_at, no model
            {"task": "t1", "updated_at": at, "fields": {
                "status": "merged", "tier": "D2", "transport": "subagent", "kind": "claude",
                "agent_host": "mac-studio", "repository": "o/repo", "pr": "1",
            }},
            # Partial counted_from row
            {"task": "t2", "updated_at": at, "fields": {
                "state": "merged", "tier": "D2", "transport": "subagent", "kind": "claude",
                "agent_host": "mac-studio", "repository": "o/repo", "pr": "2",
                "launched_at": "2026-11-17T10:00:00Z",
                "interventions": "2", "routine_answers": "3", "relaunches": "0",
                "counted_from": "2026-11-17T11:00:00Z",
            }},
            # Whole row with per-counter relaunches_from partial marker and negative launch->merge
            {"task": "t3", "updated_at": at, "fields": {
                "state": "merged", "tier": "D2", "transport": "subagent", "kind": "claude",
                "agent_host": "mac-studio", "repository": "o/repo", "pr": "3",
                "launched_at": "2026-11-17T15:00:00Z",
                "interventions": "1", "routine_answers": "4", "relaunches": "1",
                "relaunches_from": "2026-11-17T12:00:00Z",
            }},
        ])
        prs = {
            ("o/repo", 1): _pr_node(1, created_at="2026-11-17T10:00:00Z", merged_at="2026-11-17T11:00:00Z"),
            ("o/repo", 2): _pr_node(2, created_at="2026-11-17T11:00:00Z", merged_at="2026-11-17T12:00:00Z"),
            ("o/repo", 3): _pr_node(3, created_at="2026-11-17T12:00:00Z", merged_at="2026-11-17T13:00:00Z"),
        }
        with FakeTool("gh") as gh:
            _install_graphql_fake(gh, prs)
            cfg = load_config(SCRIPT, {**self.env, "PATH": os.environ["PATH"]}, host="testbox")
            rc, out, _ = self.run_ab(wpath, "--json", cfg=cfg)

        self.assertEqual(rc, 0)
        doc = json.loads(out)
        self.assertIsNone(doc["waves"][0]["split"])
        cell = doc["cells"][0]
        self.assertEqual(cell["arm"]["label"], "subagent/claude -")
        # interventions: t1 missing, t2 partial (counted_from), t3 whole (1)
        self.assertEqual(cell["counters"]["interventions"]["n"], 1)
        self.assertEqual(cell["counters"]["interventions"]["sum"], 1)
        self.assertEqual(cell["counters"]["interventions"]["partial_n"], 1)
        self.assertEqual(cell["counters"]["interventions"]["missing_n"], 1)
        # relaunches: t1 missing, t2 partial (counted_from), t3 partial (relaunches_from) -> 0 whole!
        self.assertEqual(cell["counters"]["relaunches"]["n"], 0)
        self.assertIsNone(cell["counters"]["relaunches"]["sum"])
        self.assertEqual(cell["counters"]["relaunches"]["partial_n"], 2)
        # launch->merge: t1 missing, t2=2.0h, t3 negative (-2h) excluded with note
        self.assertEqual(cell["launch_to_merge_hours"]["n"], 1)
        self.assertEqual(cell["launch_to_merge_hours"]["median"], 2.0)
        self.assertEqual(cell["open_to_merge_hours"]["n"], 3)
        self.assertTrue(any("negative launch->merge" in n for n in doc["notes"]))

    def test_graphql_rounds_filter_fixed_replies_and_fallback_on_pagination(self) -> None:
        wpath = self.make_wave("w-gh")
        self.add_row("w-gh", "t1", state="merged", tier="D1", transport="cli", kind="codex", model="sol",
                     agent_host="mac-studio", repository="o/repo", pr="11", launched_at="2026-11-22T10:00:00Z")
        self.add_row("w-gh", "t2", state="merged", tier="D1", transport="cli", kind="codex", model="sol",
                     agent_host="mac-studio", repository="o/repo", pr="12", launched_at="2026-11-22T10:00:00Z")
        fixed_body = CONNECTOR_FIXED_REPLIES[0]
        prs = {
            ("o/repo", 11): _pr_node(
                11,
                reviews=[
                    # Empty-bodied envelope with only fixed thread reply -> skipped
                    {"author": {"login": "chatgpt-codex-connector"}, "state": "COMMENTED",
                     "submittedAt": "2026-11-22T10:10:00Z", "commit": {"oid": "a" * 40}, "body": "",
                     "comments": {"pageInfo": {"hasNextPage": False},
                                  "nodes": [{"replyTo": {"id": "r1"}, "body": fixed_body}]}},
                    # Real round 1 on head a (two bursts within 900s -> 1 round)
                    {"author": {"login": "chatgpt-codex-connector"}, "state": "COMMENTED",
                     "submittedAt": "2026-11-22T10:15:00Z", "commit": {"oid": "a" * 40}, "body": "",
                     "comments": {"pageInfo": {"hasNextPage": False},
                                  "nodes": [{"replyTo": None, "body": "real finding"}]}},
                    {"author": {"login": "chatgpt-codex-connector"}, "state": "COMMENTED",
                     "submittedAt": "2026-11-22T10:20:00Z", "commit": {"oid": "a" * 40}, "body": "follow-up",
                     "comments": {"pageInfo": {"hasNextPage": False}, "nodes": []}},
                    # Real round 2 on head b
                    {"author": {"login": "chatgpt-codex-connector"}, "state": "COMMENTED",
                     "submittedAt": "2026-11-22T10:40:00Z", "commit": {"oid": "b" * 40}, "body": "round 2",
                     "comments": {"pageInfo": {"hasNextPage": False}, "nodes": []}},
                ],
                comments=[
                    # Summary and no-findings comments -> skipped
                    {"author": {"login": "chatgpt-codex-connector"}, "createdAt": "2026-11-22T10:05:00Z",
                     "body": "<!-- codex-pull-request-review-summary -->"},
                    {"author": {"login": "chatgpt-codex-connector"}, "createdAt": "2026-11-22T11:00:00Z",
                     "body": "Codex Review: Didn't find any major issues."},
                ],
            ),
            # PR 12 has hasNextPage=True -> triggers paginated fallback to prreview.state.review_rounds
            ("o/repo", 12): _pr_node(12, reviews_more=True),
        }
        from ludics.prreview.state import Rounds

        with FakeTool("gh") as gh, \
                mock.patch.object(waveab, "pr_review_rounds", return_value=Rounds(4, "4 rounds")) as fallback:
            _install_graphql_fake(gh, prs)
            cfg = load_config(SCRIPT, {**self.env, "PATH": os.environ["PATH"]}, host="testbox")
            rc, out, _ = self.run_ab(wpath, "--json", cfg=cfg)

        self.assertEqual(rc, 0)
        fallback.assert_called_once()
        doc = json.loads(out)
        by_task = {t["task"]: t["review_rounds"] for t in doc["tasks"]}
        self.assertEqual(by_task, {"t1": 2, "t2": 4})

    def test_exit_codes_for_missing_board_duplicate_wave_unread_sources_and_unreachable_anchor(self) -> None:
        w1 = self.make_wave("w-missing")
        # Exit 1 when a named wave has no board (nothing on stdout)
        rc, out, err_text = self.run_ab(w1, "--no-github")
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("has no board", err_text)

        # Exit 2 on duplicate wave id and missing args
        rc_dup, _, err_dup = self.run_ab(w1, w1, "--no-github")
        self.assertEqual(rc_dup, 2)
        self.assertIn("named more than once", err_dup)
        rc_empty, _, _ = self.run_ab()
        self.assertEqual(rc_empty, 2)

        # Exit 4 when anchor is unreachable
        with mock.patch.object(transport, "run", return_value=Done(UNREACHABLE, "")):
            rc_4, _, _ = self.run_ab(w1, "--no-github")
        self.assertEqual(rc_4, 4)

        # Exit 3 when review JSON is malformed or GitHub GraphQL fails; orphan review noted
        self.add_row("w-missing", "t1", state="merged", tier="D1", transport="cli", kind="codex", model="sol",
                     agent_host="mac-studio", repository="o/repo", pr="99", launched_at="2026-11-22T10:00:00Z")
        rdir = os.path.join(self.root, "w-missing", "reviews")
        os.makedirs(rdir, exist_ok=True)
        with open(os.path.join(rdir, f"99-at-open-{'a'*12}.json"), "w", encoding="utf-8") as f:
            f.write("{broken json")
        self.write_review("w-missing", f"777-at-open-{'b'*12}.json", task="t777", pr="777", kind="at-open", word="clean")

        with FakeTool("gh") as gh:
            gh.script(Answer(1, "", "HTTP 502"))
            cfg = load_config(SCRIPT, {**self.env, "PATH": os.environ["PATH"]}, host="testbox")
            rc_3, out_3, _ = self.run_ab(w1, "--json", cfg=cfg)
        self.assertEqual(rc_3, 3)
        doc = json.loads(out_3)
        self.assertEqual({e["source"] for e in doc["errors"]}, {"review", "github"})
        self.assertTrue(any("orphan review record" in n for n in doc["notes"]))

    def test_multi_wave_join_combines_heterogeneous_arms(self) -> None:
        w1 = self.make_wave("w-old", repository="o/repo")
        w2 = self.make_wave("w-new", repository="o/repo", split="issue-number")
        self.add_row("w-old", "t1", state="merged", tier="D2", transport=OPUS_ARM[0], kind=OPUS_ARM[1], model=OPUS_ARM[2],
                     agent_host="mac-studio", repository="o/repo", pr="1", issue="o/repo#1")
        self.add_row("w-old", "t2", state="merged", tier="D2", transport=SOL_ARM[0], kind=SOL_ARM[1], model=SOL_ARM[2],
                     agent_host="mac-studio", repository="o/repo", pr="2", issue="o/repo#2")
        self.add_row("w-new", "t3", state="merged", tier="D2", transport=SOL_ARM[0], kind=SOL_ARM[1], model=SOL_ARM[2],
                     agent_host="mac-studio", repository="o/repo", pr="3", issue="o/repo#3")
        self.add_row("w-new", "t4", state="merged", tier="D2", transport=NEON_ARM[0], kind=NEON_ARM[1], model=NEON_ARM[2],
                     agent_host="mac-studio", repository="o/repo", pr="4", issue="o/repo#4")

        rc, out, _ = self.run_ab(w1, w2, "--no-github", "--json")
        self.assertEqual(rc, 0)
        doc = json.loads(out)
        self.assertEqual([w["wave"] for w in doc["waves"]], ["w-old", "w-new"])
        self.assertEqual([w["split"] for w in doc["waves"]], [None, "issue-number"])
        merged_by_arm = {c["arm"]["label"]: c["merged"] for c in doc["cells"]}
        self.assertEqual(merged_by_arm, {
            "cli/codex gpt-6.2-sol/high": 2,
            "cli/gemini gemini-4-neon-high": 1,
            "subagent/claude claude-opus-5-5": 1,
        })

    def test_local_review_invariants_unidentified_zero_merge_host_balance_and_verdicts(self) -> None:
        wpath = self.make_wave("w-inv")
        # D1+D1/D2: 10 merged Sol + 10 merged unnamed-model arm -> NOT ready (unidentified arm excluded)
        for i in range(10):
            self.add_row("w-inv", f"ts{i}", state="merged", tier="D1", transport="cli", kind="codex", model="sol",
                         agent_host="mac-studio", repository="o/repo", pr=str(10 + i))
            self.add_row("w-inv", f"tu{i}", state="merged", tier="D1", transport="cli", kind="codex",
                         agent_host="mac-studio", repository="o/repo", pr=str(30 + i))
        # D2: 10 merged Sol + 1 active (0 merged) Neon -> NOT ready, Neon appears in below_ten with 0
        for i in range(10):
            self.add_row("w-inv", f"td{i}", state="merged", tier="D2", transport="cli", kind="codex", model="sol",
                         agent_host="mac-studio", repository="o/repo", pr=str(50 + i))
        self.add_row("w-inv", "td_neon", state="implementing", tier="D2", transport="cli", kind="gemini", model="neon",
                     agent_host="mac-studio", repository="o/repo")
        # D2/D3+D3: unreadable at-open excluded from findings; blocking(0 blocking, 1 sugg) confirm is cleared
        self.add_row("w-inv", "t300", state="merged", tier="D3", transport="cli", kind="codex", model="sol",
                     agent_host="mac-studio", repository="o/repo", pr="300")
        self.write_review("w-inv", f"300-at-open-{'a'*12}.json", task="t300", pr="300", kind="at-open",
                          word="unreadable", blocking=0, suggestions=0)
        self.write_review("w-inv", f"300-confirm-{'b'*12}.json", task="t300", pr="300", kind="confirm",
                          word="blocking", blocking=0, suggestions=1)

        rc, out, _ = self.run_ab(wpath, "--no-github", "--json")
        self.assertEqual(rc, 0)
        doc = json.loads(out)
        readings = {r["group"]: r for r in doc["readings"]}
        self.assertFalse(readings["D1+D1/D2"]["ready"])
        self.assertEqual(readings["D1+D1/D2"]["at_ten"], {"cli/codex sol": 10})
        self.assertEqual(readings["D1+D1/D2"]["unidentified"], {"cli/codex -": 10})
        self.assertFalse(readings["D2"]["ready"])
        self.assertEqual(readings["D2"]["below_ten"], {"cli/gemini neon": 0})
        cells = {(c["group"], c["arm"]["label"]): c for c in doc["cells"]}
        d3 = cells[("D2/D3+D3", "cli/codex sol")]
        self.assertEqual(d3["at_open"]["unreadable"], 1)
        self.assertEqual(d3["findings"], {"blocking": 0, "suggestions": 0, "reviewed": 0, "total": 1})
        self.assertEqual(d3["confirm"], {"rounds": 1, "not_cleared": 0, "tasks_with_confirm": 1})

        # Exact host balance cutoff (4/1 vs 3/2 -> 0.8 - 0.6 == 0.20 exactly -> balanced) and missing host -> unknown
        self.assertEqual(waveab.host_balance([{"a": 4, "b": 1}, {"a": 3, "b": 2}]), "balanced")
        self.assertEqual(waveab.host_balance([{"a": 5, "b": 1}, {"a": 3, "b": 3}]), "IMBALANCED")
        self.assertEqual(waveab.host_balance([{"-": 5}, {"-": 5}]), "unknown")
        self.assertEqual(waveab.host_balance([{"mac-studio": 5}, {"-": 5}]), "unknown")

    def test_graphql_subdivides_alias_failure_matches_reviewer_prefix_and_checks_merge_sha(self) -> None:
        wpath = self.make_wave("w-sub")
        self.add_row("w-sub", "t1", state="merged", tier="D1", transport="cli", kind="codex", model="sol",
                     agent_host="mac-studio", repository="o/repo", pr="1", merge=f"{1:040x}",
                     launched_at="2026-11-22T10:00:00Z")
        self.add_row("w-sub", "t2", state="merged", tier="D1", transport="cli", kind="codex", model="sol",
                     agent_host="mac-studio", repository="o/repo", pr="2", merge="f" * 40,
                     launched_at="2026-11-22T10:00:00Z")
        self.add_row("w-sub", "t3", state="merged", tier="D1", transport="cli", kind="codex", model="sol",
                     agent_host="mac-studio", repository="o/repo", pr="3",
                     launched_at="2026-11-22T10:00:00Z")
        # Fake gh fails any batch containing PR #3 (simulating GraphQL partial-error exit 1), succeeds for #1 and #2.
        sub_script = """\
import json, os, re, sys
argv = sys.argv[1:]
query = ""
for i, arg in enumerate(argv):
    if arg == "-f" and i + 1 < len(argv) and argv[i + 1].startswith("query="):
        query = argv[i + 1][len("query="):]
alias_re = re.compile(r'(p\\d+):\\s*repository\\(owner:\\s*"([^"]+)",\\s*name:\\s*"([^"]+)"\\)\\s*\\{\\s*pullRequest\\(number:\\s*(\\d+)\\)')
matches = list(alias_re.finditer(query))
if any(int(m.group(4)) == 3 for m in matches):
    sys.stderr.write("gh: Could not resolve to a PullRequest with the number of 3.\\n")
    sys.exit(1)
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "prs.json"), encoding="utf-8") as f:
    prs = json.load(f)
data = {m.group(1): {"pullRequest": prs.get(f"{m.group(2)}/{m.group(3)}#{m.group(4)}")} for m in matches}
sys.stdout.write(json.dumps({"data": data}))
"""
        prs = {
            ("o/repo", 1): _pr_node(1, reviews=[{
                "author": {"login": "chatgpt-codex-connector"}, "state": "COMMENTED",
                "submittedAt": "2026-11-22T11:00:00Z", "commit": {"oid": "a" * 40}, "body": "fix this",
                "comments": {"pageInfo": {"hasNextPage": False}, "nodes": []},
            }]),
            ("o/repo", 2): _pr_node(2),
        }
        with FakeTool("gh") as gh:
            with open(os.path.join(gh.dir, "prs.json"), "w", encoding="utf-8") as f:
                json.dump({f"{repo}#{num}": node for (repo, num), node in prs.items()}, f)
            tool_path = os.path.join(gh.dir, "gh")
            with open(tool_path, "w", encoding="utf-8") as f:
                f.write(f"#!{sys.executable}\n{sub_script}")
            os.chmod(tool_path, 0o755)
            cfg = load_config(SCRIPT, {**self.env, "PATH": os.environ["PATH"], "REVIEWER": "chatgpt-codex"}, host="testbox")
            rc, out, _ = self.run_ab(wpath, "--json", cfg=cfg)

        self.assertEqual(rc, 3)
        doc = json.loads(out)
        by_task = {t["task"]: t for t in doc["tasks"]}
        # t1 survived subdivision and matched REVIEWER=chatgpt-codex prefix
        self.assertEqual(by_task["t1"]["github_status"], "read")
        self.assertEqual(by_task["t1"]["review_rounds"], 1)
        # t2 had board merge fff... vs GitHub 000...2 -> metrics withheld
        self.assertEqual(by_task["t2"]["github_status"], "mismatch")
        self.assertIsNone(by_task["t2"]["review_rounds"])
        self.assertIsNone(by_task["t2"]["launch_to_merge_hours"])
        self.assertTrue(any("disagrees with GitHub" in n for n in doc["notes"]))
        # t3 isolated as the single failing PR in errors
        self.assertEqual([e["pr"] for e in doc["errors"]], ["o/repo#3"])


if __name__ == "__main__":
    unittest.main()
