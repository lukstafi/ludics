"""ludics.postmergecleanup: the pieces the conformance suite reaches only through whole cleanups.

ship-pr/scripts/test-post-merge-cleanup.sh drives the helper end to end in scratch repositories;
these pin the logic underneath it one rule at a time -- bash's ``printf '%q'``, the option table,
the shell's file primitives, the drive-letter classification of #147, the interactive ref
transaction, the finishing command's credential stripping -- and the entry point's own contract.
"""

import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr

from ludics.postmergecleanup import system
from ludics.postmergecleanup.cleanup import Cleanup, path_has_no_link_component
from ludics.postmergecleanup.options import Options as DefaultOptions
from ludics.postmergecleanup.options import Parsed, UsageError, parse_options, usage_text
from ludics.postmergecleanup.shellquote import bash_q, utf8_locale
from ludics.postmergecleanup.transaction import RefTransaction

LIB = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
ROOT = os.path.dirname(LIB)
HELPER = os.path.join(ROOT, "ship-pr", "scripts", "post-merge-cleanup.sh")


def bash5() -> str | None:
    """A bash whose ``printf '%q'`` is bash 5's (3.2 does not escape a leading ``~``)."""
    for candidate in ("/opt/homebrew/bin/bash", "/usr/local/bin/bash", shutil.which("bash")):
        if candidate and os.path.exists(candidate):
            done = subprocess.run(
                [candidate, "-c", "echo ${BASH_VERSINFO[0]}"], capture_output=True, text=True, check=False
            )
            if done.stdout.strip().isdigit() and int(done.stdout.strip()) >= 5:
                return candidate
    return None


class ShellQuote(unittest.TestCase):
    CASES = {
        "": "''",
        "plain/path-1.2_x": "plain/path-1.2_x",
        "a b": "a\\ b",
        "nes\nted": "$'nes\\nted'",
        "\x1b[31mred": "$'\\E[31mred'",
        "tab\there": "$'tab\\there'",
        "it's": "it\\'s",
        "$(rm -rf)": "\\$\\(rm\\ -rf\\)",
        "#comment": "\\#comment",
        "a#b": "a#b",
        "~home": "\\~home",
        "a=~b": "a=\\~b",
        "bell\x07and'quote": "$'bell\\aand\\'quote'",
        "del\x7f": "$'del\\177'",
        "x,y;z|w&v": "x\\,y\\;z\\|w\\&v",
    }

    def test_the_renderings_bash_5_prints(self) -> None:
        for text, quoted in self.CASES.items():
            self.assertEqual(bash_q(text, utf8=False), quoted, repr(text))

    def test_agrees_with_this_hosts_bash(self) -> None:
        bash = bash5()
        if bash is None:
            self.skipTest("no bash 5 on this host")
        for text in self.CASES:
            done = subprocess.run(
                [bash, "-c", 'printf "%q" "$1"', "q", text],
                capture_output=True,
                env={**os.environ, "LC_ALL": "C"},
                check=False,
            )
            self.assertEqual(bash_q(text, utf8=False), system.decode(done.stdout), repr(text))

    def test_non_ascii_follows_the_locale(self) -> None:
        self.assertEqual(bash_q("coné", utf8=True), "coné")
        self.assertEqual(bash_q("co né", utf8=True), "co\\ né")
        self.assertEqual(bash_q("coné", utf8=False), "$'con\\303\\251'")
        # An invalid byte is unprintable under any locale.
        self.assertEqual(bash_q("a\udcffb", utf8=True), "$'a\\377b'")

    def test_the_locale_is_read_as_bash_reads_it(self) -> None:
        self.assertTrue(utf8_locale({"LANG": "en_US.UTF-8"}))
        self.assertFalse(utf8_locale({"LC_ALL": "C", "LANG": "en_US.UTF-8"}))
        self.assertTrue(utf8_locale({"LC_CTYPE": "C.utf8"}))
        self.assertFalse(utf8_locale({}))


class Options(unittest.TestCase):
    def test_the_listing_is_rendered_from_the_table(self) -> None:
        text = usage_text()
        self.assertTrue(text.startswith("usage: post-merge-cleanup.sh <main-checkout> "))
        self.assertIn("\n  --base <branch>       Base branch to refresh", text)
        # A name and placeholder longer than the field take a line of their own.
        self.assertIn(
            "\n  --force-integrated <reason>\n                        Why this squash", text
        )
        self.assertIn("\n                        Repeatable, no default;", text)

    def test_no_options_are_the_defaults(self) -> None:
        self.assertEqual(parse_options([]), Parsed(DefaultOptions()))

    def test_values_last_wins_and_repeatable_appends(self) -> None:
        result = parse_options(
            ["--base", "a", "--regenerable", "_build", "--base", "main", "--regenerable", "node_modules"]
        )
        match result:
            case Parsed(options):
                self.assertEqual(options.base, "main")
                self.assertEqual(options.regenerable, ("_build", "node_modules"))
                self.assertEqual(options.force_reason, "")
            case UsageError():
                self.fail("a well-formed command line was refused")

    def test_a_valued_option_takes_the_next_word_whatever_it_is(self) -> None:
        match parse_options(["--force-integrated", "--base"]):
            case Parsed(options):
                self.assertEqual(options.force_reason, "--base")
            case UsageError():
                self.fail("an option-shaped value was refused")

    def test_usage_errors(self) -> None:
        for args in (
            ["--keep-branch"],
            ["--base=main"],
            ["--base"],
            ["--base", ""],
            ["--force-integrated"],
            ["stray"],
        ):
            self.assertEqual(parse_options(args), UsageError(), args)


class Paths(unittest.TestCase):
    def test_drive_rooted_paths_are_absolute(self) -> None:
        for path in ("/x", "//server/share", "C:/Users/x", "c:\\Users\\x", "z:/"):
            self.assertTrue(system.git_path_is_absolute(path), path)
        for path in (".git", "AB:/x", "C:", "1:/x", "é:/x", ""):
            self.assertFalse(system.git_path_is_absolute(path), path)

    def test_dirname_and_basename_are_posix(self) -> None:
        cases = {
            "/a/b": ("/a", "b"),
            "/a/b/": ("/a", "b"),
            "a": (".", "a"),
            "/a": ("/", "a"),
            "/": ("/", "/"),
            "a//b": ("a", "b"),
            "C:/x/y": ("C:/x", "y"),
        }
        for path, (directory, base) in cases.items():
            self.assertEqual(system.posix_dirname(path), directory, path)
            self.assertEqual(system.posix_basename(path), base, path)

    def test_fields_and_tokens_read_as_the_shell_reads_them(self) -> None:
        self.assertEqual(system.read_fields("  a b  c d ", 3), ["a", "b", "c d"])
        self.assertEqual(system.read_fields("a", 3), ["a", "", ""])
        self.assertEqual(system.first_token("abc\t\tbranch 'x'"), "abc")
        self.assertEqual(system.first_token(" lead"), "")
        self.assertEqual(system.nul_records("a\0b\0tail"), ["a", "b"])
        self.assertEqual(system.first_nul_record("only"), "only")
        self.assertFalse(system.has_nonzero("0000"))
        self.assertFalse(system.has_nonzero(""))
        self.assertTrue(system.has_nonzero("00a0"))


class WindowsSpawning(unittest.TestCase):
    def test_every_word_is_quoted_by_the_c_runtime_rules(self) -> None:
        self.assertEqual(
            system.windows_command_line(["bash", "abc^{object}", "a b", ""]),
            '"bash" "abc^{object}" "a b" ""',
        )
        self.assertEqual(system.windows_command_line(['q"t', "end\\"]), '"q\\"t" "end\\\\"')

    def test_names_are_untouched_outside_git_bash(self) -> None:
        if os.name == "nt":
            self.skipTest("POSIX only")
        self.assertEqual(system.msys_name("nes\uf00ated"), "nes\uf00ated")


class Files(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-pmc-test."))

    def tearDown(self) -> None:
        for root, dirs, _ in os.walk(self.dir):
            for name in dirs:
                os.chmod(os.path.join(root, name), 0o755)
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, *parts: str) -> str:
        return "/".join((self.dir, *parts))

    def test_noclobber_refuses_anything_already_at_the_path(self) -> None:
        self.assertTrue(system.noclobber_create(self.path("lock"), "1\n"))
        self.assertFalse(system.noclobber_create(self.path("lock"), "2\n"))
        os.symlink(self.path("nowhere"), self.path("dangling"))
        self.assertFalse(system.noclobber_create(self.path("dangling"), "3\n"))
        self.assertFalse(os.path.exists(self.path("nowhere")))
        self.assertEqual(system.first_line(self.path("lock")), "1")

    def test_rename_replaces_an_empty_directory_and_refuses_a_nonempty_one(self) -> None:
        os.mkdir(self.path("source"))
        os.mkdir(self.path("empty"))
        self.assertIsNone(system.atomic_rename(self.path("source"), self.path("empty")))
        os.mkdir(self.path("source"))
        os.mkdir(self.path("full"))
        with open(self.path("full", "blocker"), "w", encoding="utf-8") as f:
            f.write("attacker\n")
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertIsNotNone(system.atomic_rename(self.path("source"), self.path("full")))
        self.assertTrue(os.path.isdir(self.path("source")))
        self.assertFalse(os.path.exists(self.path("full", "source")))
        self.assertRegex(err.getvalue(), r"source -> .*full: ")

    def test_mktemp_fills_the_template(self) -> None:
        made = system.mktemp_dir(self.path(".session.ship-pr-recovery.XXXXXX"))
        assert made is not None
        self.assertRegex(os.path.basename(made), r"^\.session\.ship-pr-recovery\.[A-Za-z0-9]{6}$")
        self.assertEqual(os.stat(made).st_mode & 0o777, 0o700)
        made_file = system.mktemp_file(self.path("snapshot.XXXXXX"))
        assert made_file is not None
        self.assertEqual(os.stat(made_file).st_mode & 0o777, 0o600)
        self.assertIsNone(system.mktemp_dir(self.path("missing", "x.XXXXXX")))

    def test_the_walk_lists_links_and_clears_nothing_it_could_not_read(self) -> None:
        os.makedirs(self.path("tree", "sub"))
        with open(self.path("tree", "sub", "file"), "w", encoding="utf-8") as f:
            f.write("x")
        os.symlink(self.path("tree", "sub"), self.path("tree", "link"))
        walked = system.walk_non_directories(self.path("tree"))
        assert walked is not None
        self.assertEqual(sorted(walked), [self.path("tree", "link"), self.path("tree", "sub", "file")])
        os.chmod(self.path("tree", "sub"), 0)
        if os.access(self.path("tree", "sub"), os.R_OK):
            self.skipTest("this account reads a directory whose mode is 000")
        self.assertIsNone(system.walk_non_directories(self.path("tree")))

    def test_no_component_may_be_a_link(self) -> None:
        os.makedirs(self.path("root", "real"))
        with open(self.path("root", "real", "f"), "w", encoding="utf-8") as f:
            f.write("x")
        os.symlink(self.path("root", "real"), self.path("root", "alias"))
        self.assertTrue(path_has_no_link_component(self.path("root"), "real/f"))
        self.assertFalse(path_has_no_link_component(self.path("root"), "alias/f"))
        self.assertFalse(path_has_no_link_component(self.path("root"), "real/../real/f"))
        self.assertFalse(path_has_no_link_component(self.path("root"), "real/absent"))

    def test_physical_directory_resolves_links(self) -> None:
        os.mkdir(self.path("real"))
        os.symlink(self.path("real"), self.path("alias"))
        self.assertEqual(system.physical_directory(self.path("alias")), self.path("real"))
        self.assertIsNone(system.physical_directory(self.path("absent")))


class Transaction(unittest.TestCase):
    """The interactive update-ref transaction against a real repository."""

    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-pmc-tx."))
        self.repo = f"{self.dir}/repo"
        self.git("init", "-q", self.repo)
        self.git("-C", self.repo, "-c", "user.name=t", "-c", "user.email=t@e.invalid",
                 "commit", "-q", "--allow-empty", "-m", "base")
        self.oid = self.git("-C", self.repo, "rev-parse", "HEAD").strip()
        self.git("-C", self.repo, "update-ref", "refs/heads/doomed", self.oid)

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout

    def test_prepare_holds_the_lock_until_commit(self) -> None:
        tx = RefTransaction(self.repo, "test")
        self.assertIsNone(tx.open(self.dir))
        self.assertTrue(tx.send(f"start\noption no-deref\ndelete refs/heads/doomed {self.oid}\nprepare\n"))
        self.assertEqual(tx.response(), (True, "start: ok"))
        self.assertEqual(tx.response(), (True, "prepare: ok"))
        self.assertTrue(os.path.exists(f"{self.repo}/.git/refs/heads/doomed.lock"))
        self.assertTrue(tx.send("commit\n"))
        self.assertEqual(tx.response(), (True, "commit: ok"))
        self.assertIsNone(tx.finish())
        self.assertFalse(os.path.exists(tx.directory))
        refs = self.git("-C", self.repo, "for-each-ref", "refs/heads/doomed")
        self.assertEqual(refs, "")

    def test_closing_the_input_aborts_and_releases_the_lock(self) -> None:
        tx = RefTransaction(self.repo, "test")
        self.assertIsNone(tx.open(self.dir))
        tx.send(f"start\ndelete refs/heads/doomed {self.oid}\nprepare\n")
        self.assertEqual(tx.response(), (True, "start: ok"))
        self.assertEqual(tx.response(), (True, "prepare: ok"))
        tx.discard()
        self.assertFalse(os.path.exists(f"{self.repo}/.git/refs/heads/doomed.lock"))
        self.assertEqual(self.git("-C", self.repo, "rev-parse", "refs/heads/doomed").strip(), self.oid)
        self.assertFalse(os.path.exists(tx.directory))

    def test_a_refused_prepare_is_a_response_not_a_hang(self) -> None:
        tx = RefTransaction(self.repo, "test")
        stale = "1" * len(self.oid)
        # Git's own refusal goes to the stderr it inherits, the operator's: keep it out of the run.
        saved = os.dup(2)
        try:
            with open(os.devnull, "wb") as devnull:
                os.dup2(devnull.fileno(), 2)
            self.assertIsNone(tx.open(self.dir))
            tx.send(f"start\ndelete refs/heads/doomed {stale}\nprepare\n")
            self.assertEqual(tx.response(), (True, "start: ok"))
            ok, _ = tx.response()
            tx.discard()
        finally:
            os.dup2(saved, 2)
            os.close(saved)
        self.assertFalse(ok)


class FinishingCommand(unittest.TestCase):
    def command(self, url: str) -> str:
        cleanup = Cleanup()
        cleanup.main = "/repo/main dir"
        cleanup.branch = "topic"
        cleanup.origin_push_url = url
        return cleanup.finish_remote_deletion("abc123")

    def test_http_userinfo_is_removed_and_nothing_else(self) -> None:
        self.assertEqual(
            self.command("https://user:s3cret@example.invalid/a@b/repo.git"),
            "finish with: git -C /repo/main\\ dir push --force-with-lease=refs/heads/topic:abc123 "
            "https://example.invalid/a@b/repo.git :refs/heads/topic",
        )
        self.assertIn(" http://example.invalid/r.git ", self.command("http://u@example.invalid/r.git"))
        # Only the http(s) authority is rewritten: an ssh spelling names the account it pushes as.
        self.assertIn(" git@example.invalid:r.git ", self.command("git@example.invalid:r.git"))


class EntryPoint(unittest.TestCase):
    def test_usage_is_exit_2_on_stderr_through_the_shell_entry_point(self) -> None:
        done = subprocess.run(["bash", HELPER], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 2)
        self.assertEqual(done.stdout, "")
        self.assertEqual(done.stderr, usage_text() + "\n")

    def test_repository_selection_environment_is_cleared(self) -> None:
        program = (
            "import os, sys\n"
            "from ludics.postmergecleanup.__main__ import scrub_git_environment\n"
            "assert scrub_git_environment()\n"
            "print(os.environ.get('GIT_DIR', '-'), os.environ.get('GIT_NO_REPLACE_OBJECTS'))\n"
        )
        done = subprocess.run(
            [sys.executable, "-c", program],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": LIB, "GIT_DIR": "/nowhere", "GIT_NO_REPLACE_OBJECTS": "0"},
            check=False,
        )
        self.assertEqual(done.stdout.strip(), "- 1", done.stderr)

    def test_children_inherit_the_callers_locale_untouched(self) -> None:
        # Python coerces a C locale (PEP 538) by exporting LC_CTYPE=C.UTF-8; the shell helper
        # never did, so neither Git nor its hooks saw it, and %q escaped non-ASCII bytes.
        if os.name == "nt":
            self.skipTest("PEP 538 coercion is POSIX-only")
        scratch = os.path.realpath(tempfile.mkdtemp(prefix="ludics-pmc-locale."))
        try:
            record = f"{scratch}/lc_ctype"
            fake = f"{scratch}/git"
            with open(fake, "w", encoding="utf-8") as f:
                f.write(
                    "#!/bin/sh\n"
                    f'printf "%s\\n" "${{LC_CTYPE-unset}}" >"{record}"\n'
                    "exit 1\n"
                )
            os.chmod(fake, 0o755)
            base = {k: v for k, v in os.environ.items() if not k.startswith(("LC_", "LANG"))}
            base["PATH"] = f"{scratch}{os.pathsep}{base['PATH']}"
            for setting, seen in ((None, "unset"), ("C", "C"), ("en_US.UTF-8", "en_US.UTF-8")):
                env = dict(base) if setting is None else {**base, "LC_CTYPE": setting}
                done = subprocess.run(
                    ["bash", HELPER, "a", "b", "c"], capture_output=True, text=True, env=env, check=False
                )
                self.assertEqual(done.returncode, 1, done.stderr)
                with open(record, encoding="utf-8") as f:
                    self.assertEqual(f.read(), seen + "\n", setting)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def test_a_missing_runner_refuses_without_touching_anything(self) -> None:
        scratch = os.path.realpath(tempfile.mkdtemp(prefix="ludics-pmc-copy."))
        try:
            copy = f"{scratch}/post-merge-cleanup.sh"
            shutil.copy(HELPER, copy)
            done = subprocess.run(["bash", copy], capture_output=True, text=True, check=False)
            self.assertEqual(done.returncode, 1)
            self.assertTrue(re.search(r"runner .*scripts/py is missing", done.stderr), done.stderr)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


class Interrupted(unittest.TestCase):
    """A run stopped by SIGTERM releases what it reserved, as the shell's EXIT trap did."""

    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix="ludics-pmc-term."))
        # A cleanup, not tearDown: it runs when setUp skips the case too.
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.main = f"{self.dir}/main"
        self.session = f"{self.dir}/session"
        remote = f"{self.dir}/remote.git"
        ident = ["-c", "user.name=t", "-c", "user.email=t@e.invalid"]
        self.git("init", "-q", "--bare", remote)
        self.git("init", "-q", "-b", "master", self.main)
        self.git("-C", self.main, *ident, "commit", "-q", "--allow-empty", "-m", "base")
        self.git("-C", self.main, "remote", "add", "origin", remote)
        self.git("-C", self.main, "push", "-q", "origin", "master")
        self.git("-C", self.main, "worktree", "add", "-q", "-b", "topic", self.session)
        self.git("-C", self.session, *ident, "commit", "-q", "--allow-empty", "-m", "topic")
        self.git("-C", self.main, "checkout", "-q", "--detach")
        self.require_symref_transactions()
        self.bin = f"{self.dir}/bin"
        os.mkdir(self.bin)
        with open(f"{self.bin}/git", "w", encoding="utf-8") as f:
            f.write(
                "#!/bin/sh\n"
                'case " $* " in *" fetch --no-tags origin "*)\n'
                '  kill -TERM "$PPID"; sleep 2; : >"$0.finished" ;;\n'
                'esac\n'
                f'exec {shutil.which("git")} "$@"\n'
            )
        os.chmod(f"{self.bin}/git", 0o755)

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout

    def require_symref_transactions(self) -> None:
        """Skip on a Git the helper refuses before the base fetch these cases interrupt: it probes
        `update-ref --stdin`'s symref-update (Git 2.46) before that fetch, after reading
        `rev-parse --show-ref-format` (2.45), so an older Git ends the run with exit 1, not the
        TERM. The probe is the helper's own, in this case's repository, so it skips exactly where
        the helper would refuse (ludics-lite#721: the unit tests are the repository's merge build,
        which runs on whatever Git the merging box has)."""
        probe = "refs/test-capability-probe"
        self.git("-C", self.main, "symbolic-ref", probe, "refs/heads/master")
        try:
            done = subprocess.run(
                ["git", "-C", self.main, "update-ref", "--stdin"],
                input=f"option no-deref\nsymref-update {probe} refs/heads/master ref refs/heads/master\n",
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            self.git("-C", self.main, "symbolic-ref", "--delete", probe)
        if done.returncode != 0:
            self.skipTest("this Git lacks update-ref symref transactions (Git >= 2.46), which the helper requires")

    def terminated(self) -> None:
        """Run the helper to the TERM its base fetch sends it; it dies of the signal."""
        if os.name == "nt":
            self.skipTest("POSIX signals")
        done = subprocess.run(
            ["bash", HELPER, self.main, self.session, "topic"],
            capture_output=True,
            text=True,
            env={**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "TMPDIR": self.dir},
            check=False,
        )
        self.assertEqual(done.returncode, -15, done.stderr)

    def test_sigterm_lets_the_running_git_finish(self) -> None:
        # The shell's EXIT trap never signalled a child: a Git killed mid-update would leave its
        # ref lock behind in the caller's repository. The fake's descendants hold the captured
        # streams, so the run above returns only once the fake has finished, or been killed.
        self.terminated()
        self.assertTrue(os.path.exists(f"{self.bin}/git.finished"), "the running git was killed")

    def test_sigterm_releases_every_reservation(self) -> None:
        self.terminated()
        self.assertEqual(self.git("-C", self.main, "for-each-ref", "refs/ship-pr"), "")
        self.assertEqual([n for n in os.listdir(self.dir) if "ship-pr" in n], [])
        self.assertNotIn("\nlocked", self.git("-C", self.main, "worktree", "list", "--porcelain"))
        self.assertTrue(os.path.isdir(self.session))


if __name__ == "__main__":
    unittest.main()
