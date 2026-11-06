"""Units of ``merge``'s build of the would-be merge commit (ludics-lite#611, prreview/mergebuild.py):
the config's grammar, the build-input boundary and the trigger, the clone's remote, and the build
itself in a real scratch repository -- refused with its output, passed, refused on a textual
conflict, superseded on a moved head, its command's contract, an interrupt during its setup
(ludics-lite#635) -- each leaving the clone as it was.

test-pr-review-merge.sh runs the same build end to end through `merge`; these pin the rules a
regression would bend first.
"""

import contextlib
import io
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from ludics import cli
from ludics.prreview import buildhistory, drift, mergebuild
from ludics.prreview.core import Json
from ludics.prreview.mergebuild import BuildConfig, build_inputs, build_reason, parse_config


def parsed(text: str) -> tuple[BuildConfig | None, str]:
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        result = parse_config(text, "the config")
    return result, err.getvalue()


class Grammar(unittest.TestCase):
    def test_the_three_line_shapes_comments_and_blanks(self) -> None:
        config, err = parsed("# header\n\ncommand dune build @check\ninput *.ml\n  input\t*.mli  \ntimeout 600\r\n")
        self.assertEqual(config, BuildConfig("dune build @check", ("*.ml", "*.mli"), 600))
        self.assertEqual(err, "")

    def test_comments_lines_name_globs(self) -> None:
        config, err = parsed("command make\ninput *.ml\ncomments *.mli\ncomments  lib/*.ml \n")
        self.assertEqual(config and config.comments, ("*.mli", "lib/*.ml"))
        self.assertEqual(err, "")
        config, err = parsed("command make\ninput *.ml\ncomments\n")
        self.assertIsNone(config, "a comments line names a glob")
        self.assertIn("`comments <glob>`", err)

    def test_the_timeout_defaults(self) -> None:
        config, _ = parsed("command make\ninput *.c\n")
        self.assertEqual(config, BuildConfig("make", ("*.c",), mergebuild.DEFAULT_TIMEOUT))

    def test_the_trigger_defaults_to_same_input(self) -> None:
        config, _ = parsed("command make\ninput *.c\n")
        self.assertEqual(config and config.trigger, "same-input")
        values: tuple[mergebuild.Trigger, ...] = ("same-input", "any-input")
        for value in values:
            with self.subTest(value=value):
                config, err = parsed(f"command make\ninput *.c\ntrigger {value}\n")
                self.assertEqual(config, BuildConfig("make", ("*.c",), mergebuild.DEFAULT_TIMEOUT, value))
                self.assertEqual(err, "")

    def test_every_other_line_refuses_naming_it(self) -> None:
        for text, named in (
            ("command make\ninput *.c\ntrigger both-sides\n", "trigger both-sides"),
            ("command make\ninput *.c\ntrigger Any-Input\n", "trigger Any-Input"),
            ("command make\ninput *.c\ntrigger\n", "trigger"),
            ("command make\ninput *.c\ntrigger any-input\ntrigger same-input\n", "trigger same-input"),
            ("command make\ninputs *.c\n", "inputs *.c"),
            ("command make\ninput *.c\nCommand make\n", "Command make"),
            ("command make\ninput\n", "input"),
            ("command make\ninput *.c\ntimeout 0\n", "timeout 0"),
            ("command make\ninput *.c\ntimeout 1.5\n", "timeout 1.5"),
            ("command make\ninput *.c\ntimeout ６\n", "timeout ６"),
            ("command make\ncommand cc\ninput *.c\n", "command cc"),
            ("command make\ninput *.c\ntimeout 5\ntimeout 6\n", "timeout 6"),
            ("command make\ninput *.c\ntimeout 86401\n", "timeout 86401"),
            ("command make\ninput *.c\ntimeout " + "9" * 309 + "\n", "9" * 309),
            ("command make\ninput *.c\ntimeout " + "9" * 4301 + "\n", "9" * 4301),
        ):
            with self.subTest(text=text):
                config, err = parsed(text)
                self.assertIsNone(config)
                self.assertIn(named, err)

    def test_a_command_and_an_input_are_required(self) -> None:
        for text in ("input *.c\n", "command make\n", "# nothing\n", ""):
            with self.subTest(text=text):
                config, err = parsed(text)
                self.assertIsNone(config)
                self.assertIn("needs one `command` line and at least one `input` line", err)


class Inputs(unittest.TestCase):
    def test_a_glob_matches_the_whole_path_and_star_crosses_slashes(self) -> None:
        paths = ["dune", "lib/dune", "lib/a.ml", "a.ml", "README.md", "test/x.mli", "lib/A.ML"]
        self.assertEqual(build_inputs(paths, ("*.ml",)), ["lib/a.ml", "a.ml"])
        self.assertEqual(build_inputs(paths, ("dune",)), ["dune"])
        self.assertEqual(build_inputs(paths, ("*/dune",)), ["lib/dune"])
        self.assertEqual(build_inputs(paths, ("*.ml", "*.mli")), ["lib/a.ml", "a.ml", "test/x.mli"])
        self.assertEqual(build_inputs(paths, ("lib",)), [])

    def test_a_renamed_path_counts_by_its_other_name(self) -> None:
        # The base renamed docs/api.txt to src/api.ml; the PR edited docs/api.txt: git carries
        # the edit into src/api.ml, so the shared path is a build input.
        renamed = {"docs/api.txt": ["src/api.ml"], "src/api.ml": ["docs/api.txt"]}
        self.assertEqual(build_inputs(["docs/api.txt"], ("*.ml",), renamed), ["docs/api.txt"])
        self.assertEqual(build_inputs(["docs/api.txt"], ("*.ml",)), [])

    def test_the_trigger_decides_on_the_two_sides(self) -> None:
        same = BuildConfig("make", ("*.ml",))
        anyi = BuildConfig("make", ("*.ml",), trigger="any-input")

        def reason(config: BuildConfig, pr: list[str] | None, base: list[str] | None) -> tuple[str | None, str]:
            overlap = None if pr is None or base is None else sorted(set(pr) & set(base))
            return build_reason(drift.Drift(0, "main", "h", "t", overlap, {}, pr, base), config)

        # The single-side clash: the base renamed a name in a.ml, the PR calls it from b.ml.
        self.assertEqual(reason(same, ["b.ml"], ["a.ml"]), (None, "no path changed on both sides (trigger same-input)"))
        why, _ = reason(anyi, ["b.ml"], ["a.ml"])
        self.assertEqual(why, "build inputs changed on each side (trigger any-input): the PR's b.ml; the base's a.ml")
        # any-input needs a build input on EACH side.
        self.assertEqual(reason(anyi, ["b.ml"], ["notes.md"]), (None, "trigger any-input, and the base changed no build input (*.ml)"))
        self.assertEqual(reason(anyi, ["notes.md"], ["a.ml"]), (None, "trigger any-input, and the PR changed no build input (*.ml)"))
        # same-input is today's rule, unchanged.
        why, _ = reason(same, ["a.ml", "x"], ["a.ml", "x"])
        self.assertEqual(why, "1 build input(s) changed on both sides: a.ml")
        self.assertEqual(reason(same, ["x"], ["x"]), (None, "none of the 1 path(s) changed on both sides is a build input (*.ml)"))
        # Unknown sides build under either trigger.
        for config in (same, anyi):
            with self.subTest(trigger=config.trigger):
                why, _ = reason(config, None, None)
                self.assertIn("UNKNOWN", why or "")
        # A long side is named in part.
        why, _ = reason(anyi, [f"m{i}.ml" for i in range(25)], ["a.ml"])
        self.assertIn("(and 15 more)", why or "")

    def test_the_drift_maps_renames_on_both_sides(self) -> None:
        forward: Json = {"files": [{"filename": "a.ml", "previous_filename": "a.txt"}, {"filename": "x"}]}
        reverse: Json = {"files": [{"filename": "a.ml", "previous_filename": "b.ml"}]}
        got = drift._renames(forward, reverse)  # pyright: ignore[reportPrivateUsage]
        self.assertEqual(got, {"a.ml": ["a.txt", "b.ml"], "a.txt": ["a.ml"], "b.ml": ["a.ml"]})

    def test_a_remote_names_the_repository_by_its_last_two_components(self) -> None:
        for url in (
            "https://github.com/Owner/Repo.git",
            "git@github.com:owner/repo.git",
            "git@github-work:owner/repo",
            "/tmp/x/remotes/owner/repo.git/",
            "C:\\x\\owner\\repo.git",
        ):
            with self.subTest(url=url):
                self.assertTrue(mergebuild._remote_matches(url, "owner/repo"))  # pyright: ignore[reportPrivateUsage]
        for url in ("https://github.com/owner/repo2.git", "https://github.com/other/repo", "repo"):
            with self.subTest(url=url):
                self.assertFalse(mergebuild._remote_matches(url, "owner/repo"))  # pyright: ignore[reportPrivateUsage]


class Log(unittest.TestCase):
    def shown(self, data: bytes) -> list[str]:
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
        try:
            return mergebuild._shown(f.name)  # pyright: ignore[reportPrivateUsage]
        finally:
            os.unlink(f.name)

    def test_a_short_log_is_shown_whole(self) -> None:
        self.assertEqual(self.shown(b"a\nb\n"), ["a", "b"])

    def test_a_long_log_is_its_two_ends(self) -> None:
        lines = self.shown(b"".join(b"line %d\n" % i for i in range(1000)))
        self.assertEqual(len(lines), mergebuild.SHOWN_HEAD + mergebuild.SHOWN_TAIL + 1)
        self.assertEqual((lines[0], lines[-1]), ("line 0", "line 999"))

    def test_a_huge_log_and_an_endless_line_are_read_bounded(self) -> None:
        lines = self.shown(b"start\n" + b"x" * (5 * 1024 * 1024) + b"\nend\n")
        self.assertEqual(lines[0], "start")
        self.assertEqual(lines[-1], "end")
        self.assertTrue(all(len(line) < mergebuild.LINE_CHARS + 40 for line in lines))
        self.assertIn("its middle is left out", "\n".join(lines))


def git(cwd: str, *args: str) -> str:
    done = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, *args],
        capture_output=True, text=True, check=True,
    )
    return done.stdout.strip()


API = ["hook() { :; }", "# one", "# two", "# three", "keep() { :; }", "# four", "# five", "# six"]


class Repo(unittest.TestCase):
    """A clone of a scratch remote whose path ends in owner/repo, and its helpers (no cases)."""

    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-mergebuild-test."))
        self.remote = os.path.join(self.dir, "remotes", "owner", "repo.git")
        os.makedirs(self.remote)
        git(self.remote, "init", "-q", "--bare")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.work = os.path.join(self.dir, "work")
        os.makedirs(self.work)
        git(self.work, "init", "-q")
        self.write(API)
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "base")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")
        self.clone = os.path.join(self.dir, "clone")
        git(self.dir, "clone", "-q", self.remote, self.clone)
        self.cwd = os.getcwd()
        os.environ["FLEET_LOCAL_BOX"] = "not-a-fleet-box"
        # The build history (buildhistory.py) goes here, never in the box's own state.
        self.state_dir = os.environ.get("SHIP_PR_STATE_DIR")
        os.environ["SHIP_PR_STATE_DIR"] = os.path.join(self.dir, "state")

    def tearDown(self) -> None:
        os.chdir(self.cwd)
        os.environ.pop("FLEET_LOCAL_BOX", None)
        if self.state_dir is None:
            os.environ.pop("SHIP_PR_STATE_DIR", None)
        else:
            os.environ["SHIP_PR_STATE_DIR"] = self.state_dir
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, lines: list[str]) -> None:
        with open(os.path.join(self.work, "api.sh"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def sides(self, pr_line: str, base_first: str) -> tuple[str, str]:
        """The PR appends ``pr_line``; the base rewrites the first line. Returns (head, tip)."""
        self.write([*API, pr_line])
        git(self.work, "commit", "-q", "-a", "-m", "pr")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/pull/7/head")
        head = git(self.work, "rev-parse", "HEAD")
        git(self.work, "checkout", "-q", "--detach", "HEAD~1")
        self.write([base_first, *API[1:]])
        git(self.work, "commit", "-q", "-a", "-m", "base")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")
        self.tip = git(self.work, "rev-parse", "HEAD")
        return head, self.tip

    def refs(self) -> str:
        return git(self.clone, "for-each-ref", "--format=%(refname) %(objectname)")

    def assert_untouched(self, refs: str) -> None:
        """The clone as it was: its working tree, its one worktree, and every ref -- its
        remote-tracking ones included, which a fetch's configured refmap would move."""
        self.assertEqual(git(self.clone, "status", "--porcelain"), "")
        self.assertEqual(git(self.clone, "worktree", "list", "--porcelain").count("worktree "), 1)
        self.assertEqual(self.refs(), refs)

    def build(self, gated: str, command: str = "sh ./api.sh", override: str = "") -> tuple[int, str]:
        rc, out, _ = self.build_over(gated, command, override)
        return rc, out

    def build_over(self, gated: str, command: str, override: str) -> tuple[int, str, str | None]:
        """``build``, with what an override went over (THE BASE ALONE) as its third member."""
        refs = self.refs()
        os.chdir(self.clone)
        out = io.StringIO()
        rc = 0
        shared: str | None = None
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            try:
                shared = mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                    "owner/repo", "7", gated, "main", self.tip, BuildConfig(command, ("*.sh",), 60), "test",
                    override=override,
                )
            except cli.Exit as exc:
                rc = exc.rc
                out.write(exc.message + "\n")
        self.assert_untouched(refs)
        return rc, out.getvalue(), shared



class Build(Repo):
    """``_build`` in a clone of a scratch remote whose path ends in owner/repo."""

    def test_a_clash_is_refused_with_the_build_output(self) -> None:
        head, _ = self.sides("hook", "seam() { :; }")
        rc, out = self.build(head)
        self.assertEqual(rc, 1, out)
        self.assertIn("FAILED", out)
        self.assertIn("  | ", out)
        self.assertIn("hook", out)
        self.assertIn("does not build", out)
        self.assertIn("main alone PASSED", out, "the base alone was built, and the failure is the merge's")
        self.assertIn("though each side is green on its own", out)

    def test_a_merge_that_builds_passes(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        rc, out = self.build(head)
        self.assertEqual(rc, 0, out)
        self.assertIn("PASSED", out)
        self.assertIn("bare (this box has no run-time slots)", out)

    def test_a_process_the_build_leaves_behind_is_ended(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        survived = os.path.join(self.dir, "survived")
        os.chdir(self.clone)
        out = io.StringIO()
        command = f"(sleep 2; echo survived > {survived}) & sh ./api.sh"
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                "owner/repo", "7", head, "main", self.tip, BuildConfig(command, ("*.sh",), 60), "test"
            )
        self.assertIn("PASSED", out.getvalue())
        time.sleep(3)
        self.assertFalse(os.path.exists(survived), "the group was ended after its leader exited")

    def test_the_command_is_told_both_sides_and_the_parent_order(self) -> None:
        """THE COMMAND'S CONTRACT (ludics-lite#635): HEAD's first parent is the base's tip, its
        second the gated head, and the environment names both."""
        head, tip = self.sides("keep", "seam() { :; }")
        command = (
            f'test "$SHIP_PR_MERGE_BASE_SHA" = {tip} && test "$SHIP_PR_MERGE_HEAD_SHA" = {head}'
            ' && test "$(git rev-parse HEAD^1)" = "$SHIP_PR_MERGE_BASE_SHA"'
            ' && test "$(git rev-parse HEAD^2)" = "$SHIP_PR_MERGE_HEAD_SHA"'
            ' && git merge-base "$SHIP_PR_MERGE_BASE_SHA" "$SHIP_PR_MERGE_HEAD_SHA" && sh ./api.sh'
        )
        os.environ[mergebuild.BASE_SHA_VAR] = "inherited"
        try:
            rc, out = self.build(head, command)
        finally:
            del os.environ[mergebuild.BASE_SHA_VAR]
        self.assertEqual(rc, 0, out)
        self.assertIn("PASSED", out)

    def test_the_builds_git_writes_stay_in_its_own_repository(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        rc, out = self.build(head, "git tag built && git branch built2 && git update-ref refs/remotes/origin/main HEAD && sh ./api.sh")
        self.assertEqual(rc, 0, out)
        self.assertIn("PASSED", out)

    def test_a_sparse_clone_still_builds_the_whole_merge(self) -> None:
        head, _ = self.sides("hook", "seam() { :; }")
        git(self.clone, "sparse-checkout", "set", "--no-cone", "/nothing-here")
        self.assertFalse(os.path.exists(os.path.join(self.clone, "api.sh")))
        rc, out = self.build(head)
        self.assertEqual(rc, 1, out)
        self.assertIn("hook", out)

    def test_a_shallow_clone_is_refused(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        shutil.rmtree(self.clone)
        git(self.dir, "clone", "-q", "--depth", "1", "file://" + self.remote, self.clone)
        rc, out = self.build(head)
        self.assertEqual(rc, 2, out)
        self.assertIn("is shallow", out)

    def test_a_textual_conflict_is_refused(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        # A second PR head that rewrites the first line too: the merge cannot be made.
        git(self.work, "checkout", "-q", "--detach", head)
        self.write(["other() { :; }", *API[1:], "keep"])
        git(self.work, "commit", "-q", "-a", "-m", "pr2")
        git(self.work, "push", "-q", "-f", self.remote, "HEAD:refs/pull/7/head")
        rc, out = self.build(git(self.work, "rev-parse", "HEAD"))
        self.assertEqual(rc, 1, out)
        self.assertIn("does not merge cleanly", out)

    def test_a_moved_head_is_superseded(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        rc, out = self.build("0" * 40)
        self.assertEqual(rc, 5, out)
        self.assertIn(f"its head on origin is {head[:8]}, not 00000000", out)

    def test_a_force_push_over_a_head_the_clone_holds_is_superseded(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        git(self.clone, "fetch", "-q", "origin", "refs/pull/7/head")  # the clone holds the gated head
        git(self.work, "checkout", "-q", "--detach", head)
        self.write([*API, "keep", "# amended"])
        git(self.work, "commit", "-q", "-a", "-m", "amended")
        git(self.work, "push", "-q", "-f", self.remote, "HEAD:refs/pull/7/head")
        rc, out = self.build(head)
        self.assertEqual(rc, 5, out)
        self.assertIn("SUPERSEDED", out)

    def test_an_inherited_git_dir_aims_nothing_at_the_clone(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        os.environ["GIT_DIR"] = os.path.join(self.clone, ".git")
        try:
            rc, out = self.build(head, "git tag built && sh ./api.sh")
        finally:
            del os.environ["GIT_DIR"]
        self.assertEqual(rc, 0, out)

    def test_a_partial_clone_is_refused(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        git(self.remote, "config", "uploadpack.allowFilter", "true")
        shutil.rmtree(self.clone)
        git(self.dir, "clone", "-q", "--filter=blob:none", "file://" + self.remote, self.clone)
        rc, out = self.build(head)
        self.assertEqual(rc, 2, out)
        self.assertIn("partial clone", out)

    def test_a_command_no_exec_takes_is_a_config_error(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        rc, out = self.build(head, "sh ./api.sh\0oops")
        self.assertEqual(rc, 2, out)
        self.assertIn("cannot be run", out)

    def test_a_timeout_is_no_verdict(self) -> None:
        head, _ = self.sides("sleep 30", "seam() { :; }")
        os.chdir(self.clone)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            with self.assertRaises(cli.Exit) as caught:
                mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                    "owner/repo", "7", head, "main", self.tip, BuildConfig("sh ./api.sh", ("*.sh",), 2), "test"
                )
        self.assertEqual(caught.exception.rc, 4, out.getvalue())
        self.assertIn("did not finish within", caught.exception.message)

    def overrun(self, head: str, bound: int) -> tuple[str, str]:
        """An overrunning build under ``bound``: (what it said, the refusal)."""
        os.chdir(self.clone)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            with self.assertRaises(cli.Exit) as caught:
                mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                    "owner/repo", "7", head, "main", self.tip, BuildConfig("sh ./api.sh", ("*.sh",), bound), "test"
                )
        self.assertEqual(caught.exception.rc, 4, out.getvalue())
        return out.getvalue(), caught.exception.message

    def test_an_overrun_says_how_far_it_got_and_what_a_re_run_would_do(self) -> None:
        """#982: ahrefs/ocannl#1735's worker re-ran an overrun the refusal told it to re-run. The
        first overrun has nothing to compare; the second knows a re-run repeats."""
        head, _ = self.sides("echo the-shell-tier-started; sleep 30", "seam() { :; }")
        said, refusal = self.overrun(head, 1)
        self.assertIn("having written", said)
        self.assertIn("| the-shell-tier-started", said)
        self.assertNotIn("Re-run merge", refusal)
        self.assertIn("No earlier build of this command is on record", refusal)
        self.assertEqual([r.outcome for r in buildhistory.read("owner/repo", "sh ./api.sh")], ["overran"])
        _, refusal = self.overrun(head, 1)
        self.assertIn("A re-run will likely repeat this overrun (1 earlier overrun(s))", refusal)
        self.assertIn("raise `timeout` in .github/ship-pr-merge-build", refusal)

    def test_an_overrun_past_tight_passes_says_a_re_run_likely_repeats_it(self) -> None:
        """A pass within the bound's last fifth is the #1994 case: the bound was already tight."""
        head, _ = self.sides("sleep 30", "seam() { :; }")
        buildhistory.record("owner/repo", "sh ./api.sh", "passed", 1, 1)
        _, refusal = self.overrun(head, 1)
        self.assertIn("A re-run will likely repeat this overrun (the slowest pass took 100% of the bound)", refusal)

    def test_an_overrun_out_of_line_with_its_passes_says_so(self) -> None:
        head, _ = self.sides("sleep 30", "seam() { :; }")
        buildhistory.record("owner/repo", "sh ./api.sh", "passed", 0, 2)
        _, refusal = self.overrun(head, 2)
        self.assertIn("out of line for the command", refusal)
        self.assertNotIn("will likely repeat", refusal)

    def test_a_pass_goes_into_the_history_and_a_failure_does_not(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        rc, out = self.build(head)
        self.assertEqual(rc, 0, out)
        self.assertEqual([r.outcome for r in buildhistory.read("owner/repo", "sh ./api.sh")], ["passed"])
        rc, out = self.build(head, "sh -c 'exit 3'")
        self.assertEqual(rc, 1, out)
        self.assertEqual(buildhistory.read("owner/repo", "sh -c 'exit 3'"), [])

    def test_the_slot_record_names_the_pr_a_dry_run_none(self) -> None:
        """What `prs` reads (supervision.merge_builds): only `_run`'s own shape names a PR."""
        wrapper = ["sh", "-c", "x", "merge-build", "cmd", "log", "status"]
        self.assertEqual(mergebuild.build_of([*wrapper, "owner/repo#7"]), "owner/repo#7")
        for command in (wrapper, [*wrapper, "not a pr"], [*wrapper, "owner/repo#0"], [*wrapper, "owner/repo#7", "x"],
                        ["sh", "-c", "x", "other", "cmd", "log", "status", "owner/repo#7"],
                        ["bash", "-c", "x", "merge-build", "cmd", "log", "status", "owner/repo#7"]):
            self.assertIsNone(mergebuild.build_of(command), command)

    @unittest.skipIf(os.name == "nt", "POSIX signals")
    def test_an_interrupted_merge_stops_its_build(self) -> None:
        """A SIGTERM or Ctrl-C to merge mid-build ends the build's process group before the
        worktree goes, so no build outlives the merge (local review of #611)."""
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(sig=sig):
                if sig == signal.SIGTERM:
                    head, _ = self.sides("keep", "seam() { :; }")
                else:
                    head = git(self.remote, "rev-parse", "refs/pull/7/head")
                refs = self.refs()
                marker = os.path.join(self.dir, f"started-{sig}")
                survived = os.path.join(self.dir, f"survived-{sig}")
                command = f"echo started > {marker}; sleep 3; echo survived > {survived}"
                # SIGINT's Python handler is put back first: a parent that runs detached (bg-run.sh)
                # can hand its children SIGINT ignored, and Python then installs none.
                code = (
                    "import os, signal\n"
                    "signal.signal(signal.SIGINT, signal.default_int_handler)\n"
                    "from ludics.prreview.mergebuild import _build, BuildConfig\n"
                    "from ludics import cli\n"
                    f"os.chdir({self.clone!r})\n"
                    "try:\n"
                    f"    _build('owner/repo', '7', {head!r}, 'main', {self.tip!r}, BuildConfig({command!r}, ('*.sh',), 60), 'test')\n"
                    "except cli.Exit as exc:\n"
                    "    raise SystemExit(exc.rc)\n"
                )
                lib = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
                child = subprocess.Popen(
                    [sys.executable, "-B", "-c", code],
                    env={**os.environ, "PYTHONPATH": lib},
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                try:
                    for _ in range(200):
                        if os.path.exists(marker):
                            break
                        time.sleep(0.05)
                    self.assertTrue(os.path.exists(marker), "the build started")
                    child.send_signal(sig)
                    rc = child.wait(timeout=20)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                self.assertNotEqual(rc, 0)
                time.sleep(4)
                self.assertFalse(os.path.exists(survived), "the build was stopped with the merge")
                self.assert_untouched(refs)

    @unittest.skipIf(os.name == "nt", "POSIX signals")
    def test_an_interrupt_during_the_setup_stops_its_git_call(self) -> None:
        """A SIGTERM or SIGHUP to merge while the setup's fetch runs ends that git call and removes
        the scratch (INTERRUPTS, ludics-lite#635): each child runs in a session of its own, so the
        signal reaches it only through merge."""
        head, _ = self.sides("keep", "seam() { :; }")
        real_git = shutil.which("git")
        assert real_git is not None
        bin_dir = os.path.join(self.dir, "bin")
        os.makedirs(bin_dir)
        fake = os.path.join(bin_dir, "git")
        with open(fake, "w", encoding="utf-8") as f:
            f.write(
                "#!/bin/sh\n"
                f'case " $* " in *" fetch "*) echo $$ > "{self.dir}/fetch.pid"; exec sleep 30 ;; esac\n'
                f'exec "{real_git}" "$@"\n'
            )
        os.chmod(fake, 0o755)
        lib = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with self.subTest(sig=sig):
                pidfile = os.path.join(self.dir, "fetch.pid")
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(pidfile)
                tmp = os.path.join(self.dir, f"tmp-{sig}")
                os.makedirs(tmp)
                code = (
                    "import os\n"
                    "from ludics.prreview.mergebuild import _build, BuildConfig\n"
                    "from ludics import cli\n"
                    f"os.chdir({self.clone!r})\n"
                    "try:\n"
                    f"    _build('owner/repo', '7', {head!r}, 'main', {self.tip!r}, BuildConfig('sh ./api.sh', ('*.sh',), 60), 'test')\n"
                    "except cli.Exit as exc:\n"
                    "    raise SystemExit(exc.rc)\n"
                )
                child = subprocess.Popen(
                    [sys.executable, "-B", "-c", code],
                    env={**os.environ, "PYTHONPATH": lib, "TMPDIR": tmp, "PATH": bin_dir + os.pathsep + os.environ["PATH"]},
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                try:
                    text = ""
                    for _ in range(400):
                        with contextlib.suppress(FileNotFoundError), open(pidfile, encoding="utf-8") as f:
                            text = f.read().strip()
                        if text:
                            break
                        time.sleep(0.05)
                    fetch = int(text)
                    self.assertTrue(any(n.startswith("pr-review-build.") for n in os.listdir(tmp)), "the scratch was made")
                    child.send_signal(sig)
                    rc = child.wait(timeout=20)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                self.assertEqual(rc, 128 + sig)
                gone = False
                for _ in range(100):
                    try:
                        os.kill(fetch, 0)
                    except ProcessLookupError:
                        gone = True
                        break
                    time.sleep(0.05)
                self.assertTrue(gone, "the setup's git call was stopped with the merge")
                self.assertEqual(os.listdir(tmp), [], "the scratch was removed")


class Interrupts(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX signals")
    def test_a_signal_during_a_held_step_waits_for_it_to_end(self) -> None:
        guard = mergebuild._Interrupts()  # pyright: ignore[reportPrivateUsage]
        before = signal.getsignal(signal.SIGTERM)
        with guard.installed():
            with guard.held():
                os.kill(os.getpid(), signal.SIGTERM)
                time.sleep(0.1)  # the handler has run, and held it
            with self.assertRaises(cli.Exit) as caught:
                guard.check()
            self.assertEqual(caught.exception.rc, 128 + signal.SIGTERM)
            guard.check()  # acted on once
            with self.assertRaises(cli.Exit):
                os.kill(os.getpid(), signal.SIGHUP)
                time.sleep(1)
        self.assertEqual(signal.getsignal(signal.SIGTERM), before, "the handlers are put back")


class _Clock:
    def __init__(self, now: int) -> None:
        self.at = now

    def time(self) -> float:
        return float(self.at)

    def now(self) -> int:
        return self.at

    def sleep(self, seconds: float, /) -> None:
        self.at += int(seconds)


class WindowAndNote(unittest.TestCase):
    """THE WINDOW WAIT's bound (ludics-lite#764) and THE CONFIG NOTE's reading (#730)."""

    def test_the_window_bound_is_what_is_left_of_the_ceiling_never_under_the_slot_wait(self) -> None:
        bound = mergebuild.window_bound
        self.assertEqual(bound(None), mergebuild.SLOT_WAIT, "no --wait: as before")
        clock = _Clock(1000)
        self.assertEqual(bound(mergebuild.Ceiling(clock, 1000 + 7200)), 7200)
        clock.sleep(2000)  # the gate's wait used some of it
        self.assertEqual(bound(mergebuild.Ceiling(clock, 1000 + 7200)), 5200)
        self.assertEqual(bound(mergebuild.Ceiling(clock, 1000 + 7200 + 600)), 5800, "a recovery's extension counts")
        clock.sleep(5000)
        self.assertEqual(bound(mergebuild.Ceiling(clock, 1000 + 7200)), mergebuild.SLOT_WAIT, "the floor")
        clock.sleep(5000)
        self.assertEqual(bound(mergebuild.Ceiling(clock, 1000 + 7200)), mergebuild.SLOT_WAIT, "past the ceiling too")

    def test_merge_hands_the_gates_own_deadline_to_the_build(self) -> None:
        """``Merge.ceiling``: the gate's deadline as it left it (a recovery's extension included),
        under --wait only."""
        from ludics.prreview import merge
        from ludics.prreview.core import GhSession, load_config
        from ludics.prreview.gate import load_gate_config

        env = {k: v for k, v in os.environ.items() if not k.startswith("SHIP_PR_")}
        clock = _Clock(1000)
        for wait, expected in ((0, None), (7200, 9000)):
            opts = merge.Options(pr="7", wait_for=wait)
            m = merge.Merge(GhSession(load_config(env)), "o/r", "7", load_gate_config(env), clock, opts)
            m.gate.deadline = 9000
            ceiling = m.ceiling()
            self.assertEqual(None if ceiling is None else ceiling.deadline, expected)

    def test_the_note_reads_the_pr_side_by_either_name(self) -> None:
        touched = mergebuild.config_touched
        cfg = mergebuild.CONFIG_FILE
        self.assertTrue(touched(drift.Drift(0, pr_paths=["a.ml", cfg], base_paths=[])))
        self.assertTrue(touched(drift.Drift(0, pr_paths=["ci/build.cfg"], base_paths=[], renamed={"ci/build.cfg": [cfg]})))
        self.assertFalse(touched(drift.Drift(0, pr_paths=["a.ml"], base_paths=[cfg])), "the base's change is not the PR's")
        self.assertFalse(touched(drift.Drift(0)), "an UNKNOWN side says nothing")


# A stand-in for `fleet-worker.sh execution slot`: it records its arguments, names a measurement the
# way the slot's window wait does, and holds until the test releases it (or refuses, with REFUSE).
_FAKE_SLOT = """#!/bin/bash
printf '%s\n' "$@" >"$FAKE_DIR/argv"
printf '%s\n' "EXECUTION SLOT box: measurement window wave-x-m1 holds box (coordinator c; w for #1; reserved t)" >&2
printf '%s\n' "EXECUTION SLOT box: waiting up to 9s (--wait-window) for it to conclude, then for a slot" >&2
if [ -n "${REFUSE:-}" ]; then
  printf '%s\n' "EXECUTION SLOT REFUSED box: measurement wave-x-m1 still holds box after 9s (--wait-window)"
  exit 1
fi
for _ in $(seq 1 200); do [ -e "$FAKE_DIR/release" ] && break; sleep 0.05; done
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
"""


class Forwarded(Repo):
    """The slot's lines reach the caller while it waits, not after (#764)."""

    def run_build(self, head: str, ceiling: str, refuse: bool = False) -> tuple[subprocess.Popen[bytes], str, str]:
        fake = os.path.join(self.dir, "fake-slot.sh")
        with open(fake, "w", encoding="utf-8") as f:
            f.write(_FAKE_SLOT)
        err = os.path.join(self.dir, "stderr")
        out = os.path.join(self.dir, "stdout")
        code = (
            "import sys\n"
            "from ludics.prreview import mergebuild\n"
            "from ludics import cli\n"
            f"mergebuild._slot_runner = lambda: {fake!r}\n"
            "class C:\n"
            "    def now(self): return 1000\n"
            "    def sleep(self, s): pass\n"
            f"ceiling = {ceiling}\n"
            "try:\n"
            f"    mergebuild._build('owner/repo', '7', {head!r}, 'main', {self.tip!r}, mergebuild.BuildConfig('sh ./api.sh', ('*.sh',), 60), 'test', ceiling=ceiling)\n"
            "except cli.Exit as exc:\n"
            "    sys.stdout.write(exc.message + '\\n')\n"
            "    raise SystemExit(exc.rc)\n"
        )
        lib = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
        env = {**os.environ, "PYTHONPATH": lib, "FAKE_DIR": self.dir}
        if refuse:
            env["REFUSE"] = "1"
        with open(out, "wb") as o, open(err, "wb") as e:
            child = subprocess.Popen([sys.executable, "-B", "-c", code], cwd=self.clone, env=env, stdout=o, stderr=e)
        return child, out, err

    def read(self, path: str) -> str:
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_the_hold_is_named_before_the_build_runs(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        child, out, err = self.run_build(head, "mergebuild.Ceiling(C(), 1000 + 5000)")
        try:
            named = False
            for _ in range(200):
                if "measurement window wave-x-m1 holds box" in self.read(err):
                    named = True
                    break
                time.sleep(0.05)
            self.assertTrue(named, "the hold is named while the slot still waits")
            self.assertIsNone(child.poll(), "and the build has not run yet")
            open(os.path.join(self.dir, "release"), "w").close()
            rc = child.wait(timeout=60)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
        self.assertEqual(rc, 0, self.read(out) + self.read(err))
        self.assertIn("PASSED", self.read(out))
        self.assertIn("waited for up to 5000s", self.read(out))
        argv = self.read(os.path.join(self.dir, "argv")).split("\n")
        self.assertIn("--wait-window=5000", argv, "the rest of the ceiling")
        self.assertIn("--wait", argv)
        self.assertEqual(argv[argv.index("--wait") + 1], "1800", "the free-slot wait is unchanged")

    def test_no_wait_keeps_the_slot_wait_and_a_refusal_is_said_once(self) -> None:
        head, _ = self.sides("keep", "seam() { :; }")
        child, out, err = self.run_build(head, "None", refuse=True)
        rc = child.wait(timeout=60)
        self.assertEqual(rc, 3, self.read(out) + self.read(err))
        argv = self.read(os.path.join(self.dir, "argv")).split("\n")
        self.assertIn("--wait-window=1800", argv, "no --wait: as before")
        both = self.read(out) + self.read(err)
        self.assertEqual(both.count("still holds box after 9s"), 1, both)
        self.assertIn("could not run", self.read(out))



# THE BASE ALONE (#860): the base's first line marks a red (`red=1`) that the command reports
# after api.sh runs, failing with status 1 whatever api.sh did; `pwd` first, so the two builds
# compare as the same only when they ran at the same absolute path.
RED = "hook() { :; }; red=1"
RED_CHECK = 'pwd; sh ./api.sh; rc=$?; if grep -q red=1 api.sh; then echo "red: the scan fails"; exit 1; fi; exit $rc'
WHY = "base red, not this PR: the scan, red at the base's tip; owned by owner/repo#1"


class BaseAlone(Repo):
    """A failed merge build is compared with the same command on the base alone (THE BASE ALONE)."""

    def test_a_failure_the_base_shares_is_refused_naming_the_override(self) -> None:
        head, _ = self.sides("keep", RED)
        rc, out = self.build(head, RED_CHECK)
        self.assertEqual(rc, 1, out)
        self.assertIn("merge build owner/repo#7: FAILED (exit 1)", out)
        self.assertIn("does the base share the failure? building main at", out)
        self.assertIn("main alone FAILED the same way (exit 1, every line of the merge's output in its own)", out)
        self.assertIn("the failure is the base's, not the merge's", out)
        self.assertIn("--override", out)

    def test_under_override_a_shared_failure_is_gone_over(self) -> None:
        head, tip = self.sides("keep", RED)
        rc, out, shared = self.build_over(head, RED_CHECK, WHY)
        self.assertEqual(rc, 0, out)
        self.assertEqual(shared, f"a merge-build failure main at {tip[:8]} alone shares ({RED_CHECK}: exit 1)")
        self.assertIn("FAILED the same way", out)

    def test_an_extra_failure_is_refused_under_override(self) -> None:
        head, _ = self.sides("seam", RED)
        rc, out, shared = self.build_over(head, RED_CHECK, WHY)
        self.assertEqual(rc, 1, out)
        self.assertIsNone(shared)
        self.assertIn("not the same way: 1 line(s) of the merge's output are not in main's", out)
        # bash says `./api.sh: line 9: seam: command not found`, dash `./api.sh: 9: seam: not found`.
        self.assertRegex(out, r"\n  \+ \./api\.sh: (line )?9: seam: ", "the merge's own failure is shown")
        self.assertIn("its failure is not only main's", out)
        self.assertIn("--override goes over only a failure the base alone shares", out)

    def test_another_status_is_refused_under_override(self) -> None:
        """No line differs (the PR's `false` prints nothing), only the status: not the same way."""
        head, _ = self.sides("false", RED)
        command = "sh ./api.sh; rc=$?; grep -q red=1 api.sh && exit $((rc + 5)); exit $rc"
        rc, out, shared = self.build_over(head, command, WHY)
        self.assertEqual(rc, 1, out)
        self.assertIsNone(shared)
        self.assertIn("main alone exits 5, the merge 6", out)

    def test_the_base_alone_has_the_merges_parents_and_environment(self) -> None:
        """THE COMMAND'S CONTRACT holds for the base's build too: the same two parents and
        variables, the base tip's tree. Its log records them, and only the shared red fails."""
        head, tip = self.sides("keep", RED)
        command = (
            f'test "$SHIP_PR_MERGE_BASE_SHA" = {tip} && test "$SHIP_PR_MERGE_HEAD_SHA" = {head}'
            ' && test "$(git rev-parse HEAD^1)" = "$SHIP_PR_MERGE_BASE_SHA"'
            ' && test "$(git rev-parse HEAD^2)" = "$SHIP_PR_MERGE_HEAD_SHA" || exit 9;'
            ' if git diff --quiet HEAD^1 HEAD; then echo base; else echo merge; fi; ' + RED_CHECK
        )
        rc, out = self.build(head, command)
        self.assertEqual(rc, 1, out)
        # The merge's log says `merge`, the base's `base`: one line the base's lacks.
        self.assertIn("  + merge", out)

    def test_a_base_alone_with_no_verdict_under_override_is_no_verdict(self) -> None:
        """The base's build past the timeout: what decides the merge was not read (exit 4); without
        the override the merge's own failure refuses it (exit 1)."""
        head, _ = self.sides("keep", RED)
        command = 'if git diff --quiet HEAD^1 HEAD; then sleep 30; fi; ' + RED_CHECK
        os.chdir(self.clone)
        for override, want in ((WHY, 4), ("", 1)):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                with self.assertRaises(cli.Exit) as caught:
                    mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                        "owner/repo", "7", head, "main", self.tip, BuildConfig(command, ("*.sh",), 3), "test",
                        override=override,
                    )
            self.assertEqual(caught.exception.rc, want, out.getvalue() + caught.exception.message)
            self.assertIn("main alone", caught.exception.message)


ML = ["(* The library. *)", "let a = 1", "", "", "", "", "", "", "let b = 2 (* two *)", ""]
RAN = "echo the build ran; exit 1"  # a build that runs is refused, so a merge that proceeds built nothing


class CommentsOnly(Repo):
    """COMMENTS ONLY (#861): a build input one side changed in comments alone does not count for
    that side, where a ``comments`` glob names it."""

    def setUp(self) -> None:
        super().setUp()
        with open(os.path.join(self.work, "lib.ml"), "w", encoding="utf-8") as f:
            f.write("\n".join(ML))
        git(self.work, "add", "lib.ml")
        git(self.work, "commit", "-q", "-m", "lib.ml")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")

    def ml(self, path: str, first: str, last: str) -> None:
        with open(os.path.join(self.work, path), "w", encoding="utf-8") as f:
            f.write("\n".join([first, *ML[1:-2], last, ""]))

    def ml_sides(self, pr_last: str, base_first: str, *, rename: bool = False) -> str:
        """The PR rewrites lib.ml's last line, the base its first (renaming it to lib2.ml when
        ``rename``): disjoint hunks. Returns the PR's head; sets ``self.tip``."""
        self.ml("lib.ml", ML[0], pr_last)
        git(self.work, "commit", "-q", "-a", "-m", "pr")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/pull/7/head")
        head = git(self.work, "rev-parse", "HEAD")
        git(self.work, "checkout", "-q", "--detach", "HEAD~1")
        self.ml("lib.ml", base_first, ML[-2])
        if rename:
            git(self.work, "mv", "lib.ml", "lib2.ml")
        git(self.work, "commit", "-q", "-a", "-m", "base")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")
        self.tip = git(self.work, "rev-parse", "HEAD")
        return head

    def run_build(
        self, head: str, config: BuildConfig, cand: mergebuild.Candidates | None
    ) -> tuple[int, str]:
        refs = self.refs()
        os.chdir(self.clone)
        out = io.StringIO()
        rc = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            try:
                mergebuild._build(  # pyright: ignore[reportPrivateUsage]
                    "owner/repo", "7", head, "main", self.tip, config, "test", candidates=cand,
                )
            except cli.Exit as exc:
                rc = exc.rc
                out.write(exc.message + "\n")
        self.assert_untouched(refs)
        return rc, out.getvalue()

    SAME = BuildConfig(RAN, ("*.ml",), 60, comments=("*.ml",))
    SHARED = mergebuild.Candidates(("lib.ml",), (), (), frozenset())

    def test_a_comment_only_side_merges_without_a_build(self) -> None:
        head = self.ml_sides("let b = 3 (* two *)", "(* The library, reworded\n   over two lines. *)")
        rc, out = self.run_build(head, self.SAME, self.SHARED)
        self.assertEqual(rc, 0, out)
        self.assertIn(
            "no build — each of the 1 build input(s) changed on both sides (lib.ml) changed in comments only"
            " on one side (comments *.ml)", out,
        )
        self.assertNotIn("the build ran", out)
        self.assertNotIn("building", out)

    def test_code_on_both_sides_still_builds(self) -> None:
        head = self.ml_sides("let b = 3 (* two *)", "let z = 0")
        rc, out = self.run_build(head, self.SAME, self.SHARED)
        self.assertEqual(rc, 1, out)
        self.assertIn("changed in code on both sides: lib.ml", out)
        self.assertIn("the build ran", out)

    def test_without_a_comments_glob_on_the_path_it_builds(self) -> None:
        head = self.ml_sides("let b = 3 (* two *)", "(* Reworded. *)")
        rc, out = self.run_build(head, BuildConfig(RAN, ("*.ml",), 60, comments=("*.mli",)), self.SHARED)
        self.assertEqual(rc, 1, out)
        self.assertIn("the build ran", out)
        # The control: a glob that matches it, and the language is read.
        rc, out = self.run_build(head, BuildConfig(RAN, ("*.ml",), 60, comments=("*",)), self.SHARED)
        self.assertEqual(rc, 0, out)
        # No comments line at all: nothing is read again.
        rc, out = self.run_build(head, BuildConfig(RAN, ("*.ml",), 60), None)
        self.assertEqual(rc, 1, out)

    def test_a_language_it_does_not_read_builds(self) -> None:
        head, _ = self.sides("keep", "# a comment, in shell")
        config = BuildConfig(RAN, ("*.sh",), 60, comments=("*",))
        rc, out = self.run_build(head, config, mergebuild.Candidates(("api.sh",), (), (), frozenset()))
        self.assertEqual(rc, 1, out)
        self.assertIn("the build ran", out)

    def test_a_renamed_path_builds(self) -> None:
        head = self.ml_sides("let b = 3 (* two *)", "(* Reworded. *)", rename=True)
        cand = mergebuild.Candidates(("lib.ml",), (), (), frozenset({"lib.ml", "lib2.ml"}))
        rc, out = self.run_build(head, self.SAME, cand)
        self.assertEqual(rc, 1, out)
        self.assertIn("the build ran", out)

    def test_comment_delimiters_moved_over_duplicated_code_still_build(self) -> None:
        """The base moves comment delimiters so the commented-out copy of a binding is the live one
        (its code reads unchanged), while the PR edits the first copy: a clean merge whose code is
        neither side's, the PR's edit gone. The merge's code is checked, so it builds."""
        fill = ["(* f2 *)", "(* f3 *)", "(* f4 *)"]
        after = ["(* f6 *)", "(* f7 *)", "(* f8 *)"]

        def text(first: str, live: str, opener: str, last: str) -> str:
            return "\n".join([first, *fill, live, *after, opener, "let x = 1", last, ""])

        with open(os.path.join(self.work, "lib.ml"), "w", encoding="utf-8") as f:
            f.write(text("(* head *)", "let x = 1", "(*", "*)"))
        git(self.work, "commit", "-q", "-a", "-m", "merge base")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")
        with open(os.path.join(self.work, "lib.ml"), "w", encoding="utf-8") as f:
            f.write(text("(* head *)", "let x = 2", "(*", "*)"))
        git(self.work, "commit", "-q", "-a", "-m", "pr")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/pull/7/head")
        head = git(self.work, "rev-parse", "HEAD")
        git(self.work, "checkout", "-q", "--detach", "HEAD~1")
        with open(os.path.join(self.work, "lib.ml"), "w", encoding="utf-8") as f:
            f.write(text("(*", "let x = 1", "*)", "(* tail *)"))
        git(self.work, "commit", "-q", "-a", "-m", "base")
        git(self.work, "push", "-q", self.remote, "HEAD:refs/heads/main")
        self.tip = git(self.work, "rev-parse", "HEAD")
        rc, out = self.run_build(head, self.SAME, self.SHARED)
        self.assertEqual(rc, 1, out)
        self.assertIn("merged into code that is not the code-changing side's: lib.ml", out)
        self.assertIn("the build ran", out)
        anyi = BuildConfig(RAN, ("*.ml",), 60, "any-input", ("*.ml",))
        rc, out = self.run_build(head, anyi, mergebuild.Candidates((), ("lib.ml",), ("lib.ml",), frozenset()))
        self.assertEqual(rc, 1, out)
        self.assertIn("the build ran", out)

    def test_any_input_needs_code_on_each_side(self) -> None:
        anyi = BuildConfig(RAN, ("*.ml",), 60, "any-input", ("*.ml",))
        both = mergebuild.Candidates((), ("lib.ml",), ("lib.ml",), frozenset())
        head = self.ml_sides("let b = 3 (* two *)", "(* Reworded. *)")
        rc, out = self.run_build(head, anyi, both)
        self.assertEqual(rc, 0, out)
        self.assertIn("trigger any-input, and the base changed its build input(s) in comments only (lib.ml; comments *.ml)", out)

    def test_the_candidates_are_read_off_the_drift(self) -> None:
        d = drift.Drift(0, "main", "h", "t", ["a.ml", "x"], {"a.ml": ["b.ml"]}, ["a.ml", "c.ml", "x"], ["a.ml", "x"])
        self.assertIsNone(mergebuild.comment_candidates(d, BuildConfig("make", ("*.ml",))), "no comments line")
        unknown = drift.Drift(0, "main", "h", "t", None, {}, None, None)
        self.assertIsNone(mergebuild.comment_candidates(unknown, self.SAME), "an UNKNOWN side is not read again")
        self.assertEqual(
            mergebuild.comment_candidates(d, self.SAME),
            mergebuild.Candidates(("a.ml",), (), (), frozenset({"a.ml"})),
        )
        anyi = BuildConfig("make", ("*.ml",), trigger="any-input", comments=("*.ml",))
        self.assertEqual(
            mergebuild.comment_candidates(d, anyi),
            mergebuild.Candidates((), ("a.ml", "c.ml"), ("a.ml",), frozenset({"a.ml"})),
        )


_GH_FAIL = """#!/bin/sh
printf '%s\n' "$*" >>"$(dirname "$0")/gh-calls"
echo "gh: no network in this test" >&2
exit 1
"""


class DryRun(Repo):
    """``merge-build`` (#751): the build alone, for two revisions in a checkout."""

    def dry(self, *args: str, repo: str = "", cwd: str | None = None) -> subprocess.CompletedProcess[str]:
        bindir = os.path.join(self.dir, "bin")
        os.makedirs(bindir, exist_ok=True)
        gh = os.path.join(bindir, "gh")
        with open(gh, "w", encoding="utf-8") as f:
            f.write(_GH_FAIL)
        os.chmod(gh, 0o755)
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))))
        env = {k: v for k, v in os.environ.items() if not k.startswith(("SHIP_PR_", "LUDICS_"))}
        env.update({"PATH": bindir + os.pathsep + os.environ.get("PATH", ""), "REPO": repo,
                    "SHIP_PR_API_ATTEMPTS": "1", "SHIP_PR_API_BACKOFF": "0",
                    "SHIP_PR_STATE_DIR": os.path.join(self.dir, "state")})
        return subprocess.run([os.path.join(root, "ship-pr", "scripts", "pr-review.sh"), "merge-build", *args],
                              capture_output=True, text=True, env=env, cwd=cwd or self.clone, check=False)

    def gh_calls(self) -> str:
        path = os.path.join(self.dir, "bin", "gh-calls")
        return self.read(path) if os.path.exists(path) else ""

    def read(self, path: str) -> str:
        with open(path, encoding="utf-8") as f:
            return f.read()

    def config(self, text: str) -> str:
        path = os.path.join(self.dir, "merge-build.cfg")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def fetched(self) -> None:
        git(self.clone, "fetch", "-q", "origin", "refs/pull/7/head:refs/remotes/origin/pr7", "main:refs/remotes/origin/main")

    def test_a_clash_is_refused_and_a_compatible_pair_passes(self) -> None:
        head, tip = self.sides("hook", "seam() { :; }")
        self.fetched()
        cfg = self.config("command sh ./api.sh\ninput *.sh\ntimeout 60\n")
        refs = self.refs()
        done = self.dry("--base", "origin/main", "--head", head, "--config", cfg)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn(f"base origin/main = {tip}", done.stdout)
        self.assertIn("1 build input(s) changed on both sides: api.sh", done.stdout)
        self.assertIn("FAILED", done.stdout)
        self.assertIn("merge would REFUSE it", done.stderr)
        self.assertEqual(self.gh_calls(), "", "no gh call: no PR, no config read")
        self.assert_untouched(refs)
        compatible = self.config("command true\ninput *.sh\n")
        done = self.dry("--base", tip, "--head", head, "--config", compatible)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("PASSED", done.stdout)

    def test_no_build_when_the_trigger_does_not_hold(self) -> None:
        head, tip = self.sides("hook", "seam() { :; }")
        self.fetched()
        cfg = self.config("command false\ninput *.ml\n")
        done = self.dry("--base", tip, "--head", head, "--config", cfg)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("no build — none of the 1 path(s) changed on both sides is a build input (*.ml)", done.stdout)
        done = self.dry("--base", tip, "--head", tip, "--config", cfg)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("no build — the head changed no path since their merge base", done.stdout)

    def test_a_rename_counts_by_its_other_name(self) -> None:
        git(self.work, "mv", "api.sh", "lib.sh")
        git(self.work, "commit", "-q", "-m", "rename")
        renamed = git(self.work, "rev-parse", "HEAD")
        sides = mergedry_sides(self.work, git(self.work, "rev-parse", "HEAD~1"), renamed)
        assert sides is not None
        self.assertEqual(sides[0], ["api.sh", "lib.sh"])
        self.assertEqual(sides[1], {"lib.sh": ["api.sh"], "api.sh": ["lib.sh"]})

    def test_refusals_before_anything_is_built(self) -> None:
        head, tip = self.sides("hook", "seam() { :; }")
        self.fetched()
        done = self.dry("--base", tip, "--head", head)
        self.assertEqual(done.returncode, 2, "no config and no repository")
        self.assertIn("Pass --config <file>", done.stderr)
        cfg = self.config("command true\ninput *\n")
        done = self.dry("--base", "no-such-rev", "--head", head, "--config", cfg)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("is not a commit", done.stderr)
        done = self.dry("--base", tip, "--head", head, "--config", cfg, repo="other/name")
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("has no remote naming other/name", done.stderr)
        done = self.dry("--base", tip, "--config", cfg)
        self.assertEqual(done.returncode, 2, done.stderr)
        done = self.dry("--base", tip, "--head", head, "--config", cfg, "-C", self.dir)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("not a directory inside a git checkout", done.stderr)
        self.assertEqual(self.gh_calls(), "")
        git(self.clone, "config", "remote.origin.promisor", "true")
        done = self.dry("--base", tip, "--head", head, "--config", cfg)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("is a shallow or partial clone", done.stderr)
        git(self.clone, "config", "--unset", "remote.origin.promisor")

    def test_a_side_that_changed_nothing_reads_no_config(self) -> None:
        _, tip = self.sides("hook", "seam() { :; }")
        self.fetched()
        done = self.dry("--base", tip, "--head", tip, repo="owner/repo")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("no build — the head changed no path since their merge base", done.stdout)
        self.assertEqual(self.gh_calls(), "", "as merge: no config is read")

    def test_the_default_branch_copy_is_read_when_no_config_is_given(self) -> None:
        head, tip = self.sides("hook", "seam() { :; }")
        self.fetched()
        done = self.dry("--base", tip, "--head", head, repo="owner/repo")
        self.assertIn(done.returncode, (2, 3), done.stdout + done.stderr)
        self.assertIn("contents/.github/ship-pr-merge-build", self.gh_calls())
        self.assertIn("merge-build: could not read owner/repo's .github/ship-pr-merge-build", done.stderr)



def mergedry_sides(root: str, base: str, side: str) -> tuple[list[str], dict[str, list[str]]] | None:
    from ludics.prreview import mergedry

    return mergedry.local_sides(root, base, side)


if __name__ == "__main__":
    unittest.main()
