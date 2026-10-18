"""``pr-review.sh checks`` and ``merge``, end to end on the production path: through
``scripts/py -m ludics.prreview`` and through the shell script's ``main`` (which execs the Python),
with a gh BINARY on PATH that answers by route -- no shell function, no bridge.

The fixture suites (test-pr-review-checks-absent.sh, test-pr-review-merge.sh,
test-pr-review-base-drift.sh) pin the behaviour through the sourced stubs and the shell bridge;
these pin that the forward carries the arguments, the constants and the exits the same way when
gh is whatever is on PATH.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PY = os.path.join(ROOT, "scripts", "py")
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")

_PROGRAM = """\
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
joined = " ".join(args)
with open(os.path.join(here, "routes.json"), encoding="utf-8") as f:
    routes = json.load(f)
for needles, rc, out, err in routes:
    if all(n in joined for n in needles):
        sys.stdout.write(out)
        sys.stderr.write(err)
        sys.exit(rc)
sys.stderr.write("routed gh: no route for: " + joined + "\\n")
sys.exit(99)
"""

COMPARE = json.dumps({"behind_by": 0, "ahead_by": 1, "merge_base_commit": {"sha": "mb"}, "files": []})
THREADS = json.dumps({"totalCount": 0, "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []})

# The reads of one green, clean merge, most specific first (the first route whose needles all
# appear in the call answers it): the output each would have printed after its --jq.
GREEN: list[tuple[list[str], int, str, str]] = [
    (["pr", "merge"], 0, "", ""),
    (["mergeable_state"], 0, "main\theadsha\tclean\n", ""),
    (["merged=\\(.merged)"], 0, "merged=true state=closed\n", ""),
    ([".updated_at"], 0, "headsha\t2026-09-01T00:00:00Z\tbasesha\ttopic\n", ""),
    (['.base.ref // ""'], 0, "main\n", ""),
    ([".default_branch"], 0, "main\n", ""),
    ([".body"], 0, "Nothing to close.\n", ""),
    ([".commits|tostring"], 0, "1\theadsha\n", ""),
    (["pulls/7/commits"], 0, "headsha\tA commit.\n", ""),
    (["ship-pr-advisory-checks"], 1, "", "gh: Not Found (HTTP 404)\n"),
    (["contents/.github"], 0, "1\nworkflows\n", ""),
    (["check-runs"], 0, "ci\tsuccess\thttps://u\t1\n", ""),
    (["actions/runs?head_sha=headsha"], 0, "2026-09-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tsuccess\t1\n", ""),
    (["(.head.sha", "(.base.sha", "(.head.ref"], 0, "headsha\tbasesha\ttopic\n", ""),
    (["commits/main"], 0, "tipsha\n", ""),
    (["compare/"], 0, COMPARE + "\n", ""),
    (["reviewThreads"], 0, THREADS + "\n", ""),
]


class Production(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-merge-test."))
        gh = os.path.join(self.dir, "gh")
        with open(gh, "w", encoding="utf-8") as f:
            f.write(f"#!{sys.executable}\n{_PROGRAM}")
        os.chmod(gh, 0o755)

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def route(self, routes: list[tuple[list[str], int, str, str]]) -> None:
        with open(os.path.join(self.dir, "routes.json"), "w", encoding="utf-8") as f:
            json.dump(routes, f)
        log = os.path.join(self.dir, "calls.jsonl")
        if os.path.exists(log):
            os.remove(log)

    def calls(self) -> list[list[str]]:
        log = os.path.join(self.dir, "calls.jsonl")
        if not os.path.exists(log):
            return []
        with open(log, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def run_cmd(self, entry: list[str], *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        environ = {k: v for k, v in os.environ.items() if not k.startswith(("SHIP_PR_", "LUDICS_"))}
        environ.update({"PATH": self.dir + os.pathsep + os.environ.get("PATH", ""), "REPO": "",
                        "SHIP_PR_API_ATTEMPTS": "1", "SHIP_PR_API_BACKOFF": "0",
                        "SHIP_PR_STATE_DIR": os.path.join(self.dir, "state"), **env})
        return subprocess.run([*entry, *args], capture_output=True, text=True, env=environ, cwd=self.dir, check=False)

    def entries(self) -> list[list[str]]:
        return [[PY, "-m", "ludics.prreview"], [PR_REVIEW]]

    def test_a_green_head_merges_bound_to_the_gated_head(self) -> None:
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertIn("build signal o/r#7 @headsha: green — 1 build checks passed", done.stdout)
                self.assertIn("base-drift file overlap o/r#7: none", done.stdout)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)
                merges = [c for c in self.calls() if c[:2] == ["pr", "merge"]]
                self.assertEqual(merges, [["pr", "merge", "7", "--repo", "o/r", "--match-head-commit", "headsha", "--merge"]])

    def test_checks_ends_with_its_trailer_and_a_red_is_one(self) -> None:
        red = [(["check-runs"], 0, "ci\tfailure\thttps://u\t1\n", ""), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(GREEN)
                done = self.run_cmd(entry, "checks", "o/r#7")
                self.assertEqual((done.returncode, done.stdout.splitlines()[-1]), (0, "checks: verdict=green"))
                self.route(red)
                done = self.run_cmd(entry, "checks", "o/r#7")
                self.assertEqual((done.returncode, done.stdout.splitlines()[-1]), (1, "checks: verdict=red"))
                self.assertIn("  RED      ci (failure)  https://u", done.stdout)

    def test_the_variable_list_is_the_callers_and_skips_the_file(self) -> None:
        red_claude = [(["check-runs"], 0, "claude\tfailure\tu\t1\nci\tsuccess\tu\t1\n", ""), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(red_claude)
                done = self.run_cmd(entry, "checks", "o/r#7", SHIP_PR_ADVISORY_CHECKS="^macos$")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertFalse(any("ship-pr-advisory-checks" in " ".join(c) for c in self.calls()))

    def test_usage_errors(self) -> None:
        self.route(GREEN)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                done = self.run_cmd(entry, "merge", "o/r#7", "--override", "yes")
                self.assertEqual(done.returncode, 2)
                self.assertIn("--override takes a REASON in words, not 'yes'", done.stderr)
                done = self.run_cmd(entry, "checks", "o/r#7", "--wait=soon")
                self.assertEqual(done.returncode, 2)
                done = self.run_cmd(entry, "merge", "7")
                self.assertEqual(done.returncode, 2, "a bare number with no repo is refused")
                self.assertEqual(self.calls(), [], "and nothing is read")

    def test_an_empty_wait_is_no_wait(self) -> None:
        # The shell's `--wait=` set wait_for to '' and its arithmetic read that as 0.
        self.route(GREEN)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                done = self.run_cmd(entry, "checks", "o/r#7", "--wait=")
                self.assertEqual((done.returncode, done.stdout.splitlines()[-1]), (0, "checks: verdict=green"))

    def test_an_override_is_announced_only_before_the_merge_call(self) -> None:
        # ludics-lite#684's negative control: "OVERRIDE: merging" printed at the verdict stood above
        # the refusals that followed it. Each refusal after the gate says nothing of merging over it.
        why = "base red, not this PR: ci, test t, red at basesha; owned by o/r#1"
        red_run = (["actions/runs?head_sha=headsha"], 0,
                   "2026-09-01T00:00:00Z\t100\t1\tpull_request\tci\tcompleted\tfailure\t1\n", "")
        # A close-out's reads of the merge queue: the base, and no queue on it.
        no_queue = [(["mergeQueue"], 0, "\n", ""), (["--jq .base.ref"], 0, "main\n", "")]
        beside_green = [(["check-runs"], 0, "ci\tfailure\tu\t1\nlint\tsuccess\tu\t1\n", ""), red_run, *no_queue, *GREEN]
        red_alone = [(["check-runs"], 0, "ci\tfailure\tu\t1\n", ""), red_run, *no_queue, *GREEN]
        threads_unread = [(["reviewThreads"], 1, "", "gh: Bad Gateway (HTTP 502)\n"), *beside_green]
        for entry in self.entries():
            with self.subTest(entry=entry[0], refusal="require-green"):
                self.route(red_alone)
                done = self.run_cmd(entry, "merge", "o/r#7", "--require-green", "--override", why)
                self.assertEqual(done.returncode, 4, done.stdout + done.stderr)
                self.assertIn("beside the red --override waived", done.stderr)
                self.assertNotIn("OVERRIDE: merging", done.stdout + done.stderr)
            with self.subTest(entry=entry[0], refusal="threads"):
                self.route(threads_unread)
                done = self.run_cmd(entry, "merge", "o/r#7", "--override", why)
                self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
                self.assertIn("whether review threads are still open is UNKNOWN", done.stderr)
                self.assertNotIn("OVERRIDE: merging", done.stdout + done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], refusal="none"):
                self.route(beside_green)
                done = self.run_cmd(entry, "merge", "o/r#7", "--require-green", "--override", why)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                lines = done.stdout.splitlines()
                said = lines.index(f"OVERRIDE: merging o/r#7 over a RED build signal — {why}")
                self.assertLess(lines.index("base-drift file overlap o/r#7: none"), said, done.stdout)
                self.assertEqual(lines[said + 1:], ["o/r#7 merged=true state=closed"], "said once, then merged")
                self.assertEqual(done.stderr.count("OVERRIDE: merging o/r#7 over "), 1, done.stderr)


if __name__ == "__main__":
    unittest.main()
