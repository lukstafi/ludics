"""``pr-review.sh checks`` and ``merge``, end to end on the production path: through
``scripts/py -m ludics.prreview`` and through the shell script's ``main`` (which execs the Python),
with a gh BINARY on PATH that answers by route (tests/fake.py's ``When``) -- no shell
function, no bridge.

The fixture suites (test-pr-review-checks-absent.sh, test-pr-review-merge.sh,
test-pr-review-base-drift.sh) pin the behaviour through the sourced stubs and the shell bridge;
these pin that the forward carries the arguments, the constants and the exits the same way when
gh is whatever is on PATH.
"""

import json
import os
import shutil
import subprocess
import unittest
from collections.abc import Sequence

from ludics.tests.fake import Answer, FakeTool, When

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
PY = os.path.join(ROOT, "scripts", "py")
PR_REVIEW = os.path.join(ROOT, "ship-pr", "scripts", "pr-review.sh")

COMPARE = json.dumps({"behind_by": 0, "ahead_by": 1, "merge_base_commit": {"sha": "mb"}, "files": []})
THREADS = json.dumps({"totalCount": 0, "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []})

# A route's matcher: a ``When``, or text needles (``When(text=...)``) that all appear in the call.
Route = tuple[When | list[str], int, str, str]
# The merge call itself, by argv prefix: a read whose arguments merely hold the substrings "pr"
# and "merge" (the merge-build config's path, .github/ship-pr-merge-build) never matches it.
MERGE = When(prefix=("pr", "merge"))

# The reads of one green, clean merge, most specific first (the first route that holds for the
# call answers it): the output each would have printed after its --jq.
GREEN: list[Route] = [
    (MERGE, 0, "", ""),
    # The branch-tip read (branchtip.py, #960): the PR, then the refs API on its head repository.
    ([".head.repo.full_name"], 0, "open\theadsha\ttopic\to/r\n", ""),
    (["repos/o/r/git/ref/heads/topic"], 0, "headsha\n", ""),
    # A --wait's conflict preflight (ludics-lite#729), before the drift read its projection shares
    # a field with.
    (["\\(.mergeable)"], 0, "true\tclean\tmain\n", ""),
    (["mergeable_state"], 0, "main\theadsha\tclean\n", ""),
    (["merged=\\(.merged)"], 0, "merged=true state=closed\theadsha\n", ""),
    ([".updated_at"], 0, "headsha\t2026-09-01T00:00:00Z\tbasesha\ttopic\n", ""),
    (['.base.ref // ""'], 0, "main\n", ""),
    ([".default_branch"], 0, "main\n", ""),
    ([".body"], 0, "Nothing to close.\n", ""),
    ([".commits|tostring"], 0, "1\theadsha\n", ""),
    (["pulls/7/commits"], 0, "headsha\tA commit.\n", ""),
    # No merge-build config: a --wait from a directory that is no clone of o/r reads it (#944).
    (["ship-pr-merge-build"], 1, "", "gh: Not Found (HTTP 404)\n"),
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
        self.gh = FakeTool("gh")
        self.gh.route()  # until a test routes, every call is refused
        self.dir = self.gh.dir

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def route(self, routes: Sequence[Route]) -> None:
        self.gh.route(*((w if isinstance(w, When) else When(text=tuple(w)), Answer(rc, out, err))
                        for w, rc, out, err in routes))

    def calls(self) -> list[list[str]]:
        return self.gh.calls()

    def run_cmd(self, entry: list[str], *args: str, cwd: str | None = None, **env: str) -> subprocess.CompletedProcess[str]:
        environ = {k: v for k, v in os.environ.items() if not k.startswith(("SHIP_PR_", "LUDICS_"))}
        environ.update({"PATH": self.dir + os.pathsep + os.environ.get("PATH", ""), "REPO": "",
                        "SHIP_PR_API_ATTEMPTS": "1", "SHIP_PR_API_BACKOFF": "0",
                        "SHIP_PR_STATE_DIR": os.path.join(self.dir, "state"), **env})
        return subprocess.run([*entry, *args], capture_output=True, text=True, env=environ, cwd=cwd or self.dir, check=False)

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

    def _tip_answers(self, rc: int, out: str, err: str = "") -> list[Route]:
        """GREEN with the refs read answering otherwise."""
        return [(["repos/o/r/git/ref/heads/topic"], rc, out, err), *GREEN]

    def test_a_head_that_is_not_the_branchs_is_never_merged(self) -> None:
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(self._tip_answers(0, "pushedsha\n"))
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("headsha is NOT its branch's tip", done.stderr)
                self.assertIn("topic on o/r stands at pushedsha", done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])

    def test_an_unread_tip_never_merges_and_a_deleted_branch_is_a_fact(self) -> None:
        for rc, err, want in ((1, "gh: 503 No server is currently available to service your request\n", 3),
                              (1, "gh: Not Found (HTTP 404)\n", 1)):
            with self.subTest(want=want):
                self.route(self._tip_answers(rc, "", err))
                done = self.run_cmd([PY, "-m", "ludics.prreview"], "merge", "o/r#7")
                self.assertEqual(done.returncode, want, done.stdout + done.stderr)
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])

    def test_a_tip_read_of_an_unknown_shape_is_not_agreement(self) -> None:
        self.route([([".head.repo.full_name"], 0, "open\theadsha\ttopic\tno-such-shape\n", ""), *GREEN])
        done = self.run_cmd([PY, "-m", "ludics.prreview"], "merge", "o/r#7")
        self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
        self.assertIn("UNREAD", done.stderr)

    def test_a_branch_that_prefixes_another_is_read_exactly(self) -> None:
        self.route(GREEN)
        done = self.run_cmd([PY, "-m", "ludics.prreview"], "merge", "o/r#7")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        reads = [c for c in self.calls() if any("git/ref" in a for a in c)]
        self.assertTrue(reads)
        self.assertTrue(all("repos/o/r/git/ref/heads/topic" in c for c in reads), reads)
        self.assertFalse(any("matching-refs" in a for c in self.calls() for a in c))

    def test_a_pr_merged_at_another_head_is_not_this_merge(self) -> None:
        """ludics#823: gh finds the PR already merged, makes no merge request and exits 0 with its
        warning on stderr (gh v2.101.0); the merged head decides, not gh's exit."""
        merged_elsewhere = [(MERGE, 0, "", "! Pull request o/r#7 was already merged\n"), *GREEN]
        at_another = [(["merged=\\(.merged)"], 0, "merged=true state=closed\tlandedsha\n", ""), *merged_elsewhere]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(at_another)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("o/r#7 is MERGED at an UNJUDGED head landedsh (the gate judged headsha)", done.stderr)
                self.route(merged_elsewhere)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)

    def test_a_timed_out_merge_call_is_ambiguous_and_never_re_sent(self) -> None:
        """#708: a 504 is the gateway giving up on a backend that may have merged the PR."""
        timed_out = [(MERGE, 1, "", "HTTP 504 (https://api.github.com/graphql)\n"), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                self.route(timed_out)
                done = self.run_cmd(entry, "merge", "o/r#7", SHIP_PR_API_ATTEMPTS="3")
                self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
                self.assertIn("gh pr merge failed AMBIGUOUSLY: HTTP 504", done.stderr)
                self.assertIn("It may have LANDED", done.stderr)
                self.assertEqual(len([c for c in self.calls() if c[:2] == ["pr", "merge"]]), 1)

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

    def test_a_checkout_is_checked_before_anything_is_read(self) -> None:
        """``merge -C <dir>`` (ludics-lite#730): the merge build's clone, read first -- a directory
        inside a git checkout with a remote naming the PR's repository, or exit 2 with nothing read."""
        remote = os.path.join(self.dir, "remotes", "o", "r.git")
        other = os.path.join(self.dir, "remotes", "o", "other.git")
        for bare in (remote, other):
            subprocess.run(["git", "init", "-q", "--bare", bare], check=True)
        clone = os.path.join(self.dir, "clone")
        stranger = os.path.join(self.dir, "stranger")
        subprocess.run(["git", "clone", "-q", remote, clone], check=True, capture_output=True)
        subprocess.run(["git", "clone", "-q", other, stranger], check=True, capture_output=True)
        plain = os.path.join(self.dir, "plain")
        os.mkdir(plain)
        for entry in self.entries():
            with self.subTest(entry=entry[0]):
                for where, says in (
                    (os.path.join(self.dir, "missing"), "is not a directory inside a git checkout"),
                    (plain, "is not a directory inside a git checkout"),
                    (stranger, "has no remote naming o/r"),
                ):
                    self.route(GREEN)
                    done = self.run_cmd(entry, "merge", "o/r#7", "-C", where, "--wait=60")
                    self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                    self.assertIn(says, done.stderr)
                    self.assertEqual(self.calls(), [], "nothing was read")
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7", "-C")
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("-C needs a directory", done.stderr)
                done = self.run_cmd(entry, "merge", "o/r#7", "-C", os.path.join(clone, "."))
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)
                # -C before the PR, as `git -C` takes it (wave-20261031 post-1-task-16): the same
                # reading, the stranger refused before anything is read and the clone merged.
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "-C", stranger, "o/r#7", "--wait=60")
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("has no remote naming o/r", done.stderr)
                self.assertEqual(self.calls(), [], "nothing was read, -C first")
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "-C", os.path.join(clone, "."), "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertTrue(done.stdout.endswith("o/r#7 merged=true state=closed\n"), done.stdout)
                done = self.run_cmd(entry, "merge", "-C", clone)
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("usage: merge <pr>", done.stdout + done.stderr)

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

    def test_a_wait_refuses_a_conflict_before_reading_the_build(self) -> None:
        # ludics-lite#729: a conflicting PR is refused at the start of `merge --wait`, exit 1, with
        # the rebase hint; a clean one is read once and merges; a merge with no wait reads nothing.
        conflict = [(["\\(.mergeable)"], 0, "false\tdirty\tmain\n", ""), *GREEN]
        for entry in self.entries():
            with self.subTest(entry=entry[0], pr="conflicting"):
                self.route(conflict)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                self.assertIn("REFUSING to merge o/r#7 before the wait: it CONFLICTS with its base", done.stderr)
                self.assertIn("Merge or rebase origin/main in", done.stderr)
                self.assertFalse(any("check-runs" in " ".join(c) for c in self.calls()), "the gate read nothing")
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], pr="no wait"):
                self.route(conflict)
                self.run_cmd(entry, "merge", "o/r#7")
                self.assertFalse(any("\\(.mergeable)" in " ".join(c) for c in self.calls()))
            with self.subTest(entry=entry[0], pr="clean"):
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertEqual(sum("\\(.mergeable)" in " ".join(c) for c in self.calls()), 1)

    def test_a_wait_from_no_clone_refuses_before_the_wait_when_the_repository_builds(self) -> None:
        """#944: ``merge --wait`` without ``-C``, run where no checkout has a remote naming o/r, while
        o/r's default branch has a merge-build config: exit 2 before the gate reads anything, naming
        ``-C``. No config (a 404) or an unread one waits and merges as before; a clone of o/r as the
        working directory reads no config before the gate; no --wait reads nothing early."""
        config = [(["ship-pr-merge-build"], 0, "command sh ./build.sh\ninputs *.ml\n", ""), *GREEN]
        unread = [(["ship-pr-merge-build"], 1, "", "gh: Service Unavailable (HTTP 503)\n"), *GREEN]
        remote = os.path.join(self.dir, "remotes", "o", "r.git")
        subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
        clone = os.path.join(self.dir, "clone")
        subprocess.run(["git", "clone", "-q", remote, clone], check=True, capture_output=True)

        def gated(calls: list[list[str]]) -> bool:
            return any("check-runs" in " ".join(c) for c in calls)

        for entry in self.entries():
            with self.subTest(entry=entry[0], config="present"):
                self.route(config)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("REFUSING to merge o/r#7 before the wait: o/r's .github/ship-pr-merge-build", done.stderr)
                self.assertIn("does not run inside a git checkout", done.stderr)
                self.assertIn("name one with -C <clone>", done.stderr)
                self.assertFalse(gated(self.calls()), "the gate read nothing")
                self.assertEqual([c for c in self.calls() if c[:2] == ["pr", "merge"]], [])
            with self.subTest(entry=entry[0], config="present, from a clone"):
                self.route(config)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30", cwd=clone)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertFalse(any("ship-pr-merge-build" in " ".join(c) for c in self.calls()), "no config read")
            if entry != self.entries()[0]:
                continue  # The rest is the Python's alone; the forward is pinned by the two above.
            with self.subTest(entry=entry[0], config="absent"):
                self.route(GREEN)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertEqual(sum("ship-pr-merge-build" in " ".join(c) for c in self.calls()), 1, "read once")
            with self.subTest(entry=entry[0], config="unread"):
                self.route(unread)
                done = self.run_cmd(entry, "merge", "o/r#7", "--wait=30")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertIn("could not be read before the wait", done.stderr)
            with self.subTest(entry=entry[0], config="present, no wait"):
                self.route(config)
                done = self.run_cmd(entry, "merge", "o/r#7")
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertFalse(any("ship-pr-merge-build" in " ".join(c) for c in self.calls()), "no config read")


if __name__ == "__main__":
    unittest.main()
