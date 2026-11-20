"""Run the Windows witness staging scripts with local Bash and Git.

The first-checkout case also runs under Git for Windows in the Git Bash lane.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from ludics.fleetworker.winwitness_staging import Site, site_entry, staged_sha, staging_script


class StagedScripts(unittest.TestCase):
    """Run the generated staging script and witness.sh with local Bash and Git."""

    def setUp(self) -> None:
        self.dir = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
               "-c", "core.autocrlf=false"]
        origin = self.dir / "origin"
        subprocess.run([*git, "init", "-q", origin], check=True)
        (origin / "README").write_bytes(b"x\n")
        subprocess.run([*git, "-C", origin, "add", "README"], check=True)
        subprocess.run([*git, "-C", origin, "commit", "-q", "-m", "one"], check=True)
        self.sha = subprocess.run(["git", "-C", origin, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run([*git, "-C", origin, "commit", "-q", "--allow-empty", "-m", "two"], check=True)
        self.later = subprocess.run(["git", "-C", origin, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        # GitHub serves any reachable commit by its SHA; a local origin does once it is told to.
        subprocess.run(["git", "-C", origin, "config", "uploadpack.allowAnySHA1InWant", "true"], check=True)
        self.url = origin.as_uri()
        self.git = git
        # Resolve on the Git Bash PATH before Windows can search System32 for bash.exe.
        bash = shutil.which("bash") if os.name == "nt" else "/bin/bash"
        self.assertIsNotNone(bash, "Git Bash must be on PATH on Windows")
        assert bash is not None
        self.site = Site("win", (self.dir / "root").as_posix(), bash, 60, 60, "/w")

    def stage(self, revision: str, script: bytes = b"printf 'from the worker\\n'\n", request: str = "r1") -> subprocess.CompletedProcess[str]:
        text = staging_script(self.site, request, revision, self.url, script, b"# the driver\n")
        # Give Bash the exact wire bytes. Windows text-mode subprocess input would add CRs.
        with tempfile.TemporaryFile() as stdin:
            stdin.write(text.encode("utf-8"))
            stdin.seek(0)
            return subprocess.run([self.site.bash, "--noprofile", "--norc", "-s"], stdin=stdin,
                                  capture_output=True, text=True)

    def witness(self, request: str = "r1") -> subprocess.CompletedProcess[str]:
        path = os.path.join(self.site.root, request, "witness.sh")
        return subprocess.run([self.site.bash, "--noprofile", "--norc", "--", path], capture_output=True, text=True)

    def test_a_staged_revision_runs_the_script_from_its_checkout(self) -> None:
        done = self.stage(self.later, b"pwd -P\nprintf 'rev=%s\\n' \"$WITNESS_REVISION\"\n")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue(staged_sha(done.returncode, done.stdout, self.later), done.stdout)
        directory = os.path.join(self.site.root, "r1")
        with open(os.path.join(directory, "windows-driver.ps1")) as f:
            self.assertEqual(f.read(), "# the driver\n")
        run = self.witness()
        lines = run.stdout.splitlines()
        self.assertEqual(lines[-1], "exit: 0", run.stdout + run.stderr)
        self.assertIn(f"observed_sha: {self.later}", lines)
        self.assertIn(os.path.join(directory, "checkout"), lines)
        self.assertIn(f"rev={self.later}", lines)
        self.assertTrue(any(line.startswith("git --version: git version") for line in lines))

    def test_staging_line_endings_on_the_first_checkout(self) -> None:
        origin = self.dir / "origin"
        (origin / ".gitattributes").write_bytes(b"source.sh text\n")
        (origin / "source.sh").write_bytes(b"x\n")
        subprocess.run([*self.git, "-C", origin, "add", ".gitattributes", "source.sh"], check=True)
        subprocess.run([*self.git, "-C", origin, "commit", "-q", "-m", "Mark a file as text"], check=True)
        revision = subprocess.check_output(["git", "-C", origin, "rev-parse", "HEAD"], text=True).strip()
        config = self.dir / "global.gitconfig"
        attributes = self.dir / "empty.attributes"
        attributes.touch()
        # Pin the inherited Git for Windows setting regardless of runner configuration.
        config.write_text(f'[core]\n\tautocrlf = true\n\teol = crlf\n\tattributesFile = "{attributes.as_posix()}"\n',
                          encoding="utf-8")
        env = {"GIT_CONFIG_GLOBAL": config.as_posix(), "GIT_CONFIG_NOSYSTEM": "1", "GIT_ATTR_NOSYSTEM": "1"}
        host = "linux"
        defaults = {"windows_host": "win", "root": "C:/witness"}
        for request, fields, expected in (("inherit", defaults, b"x\r\n"),
                                          ("lf", {**defaults, "staging_line_endings": "lf"}, b"x\n")):
            with self.subTest(policy=request):
                site = site_entry({host: fields}, host, str(self.dir / "wake"))
                self.assertIsInstance(site, Site, site)
                assert isinstance(site, Site)
                self.site = replace(site, root=self.site.root, bash=self.site.bash)
                with mock.patch.dict(os.environ, env):
                    done = self.stage(revision, request=request)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                for name in ("source.sh", "README"):
                    with open(os.path.join(self.site.root, request, "checkout", name), "rb") as f:
                        self.assertEqual(f.read(), expected, name)

    def test_the_scripts_status_is_the_last_line(self) -> None:
        self.assertEqual(self.stage(self.sha, b"printf 'exit: 0\\n'\nexit 3\n").returncode, 0)
        run = self.witness()
        self.assertEqual((run.returncode, run.stdout.splitlines()[-1]), (3, "exit: 3"))

    def test_the_verdict_is_its_own_line_after_unterminated_output(self) -> None:
        self.assertEqual(self.stage(self.sha, b"printf 'no final newline'\n").returncode, 0)
        run = self.witness()
        self.assertEqual((run.returncode, run.stdout.splitlines()[-2:]), (0, ["no final newline", "exit: 0"]))

    def test_a_moved_checkout_is_refused_before_the_script(self) -> None:
        self.assertEqual(self.stage(self.later, b"printf 'RAN\\n'\n").returncode, 0)
        subprocess.run([*self.git, "-C", os.path.join(self.site.root, "r1", "checkout"), "commit", "-q", "--allow-empty", "-m", "moved"], check=True)
        run = self.witness()
        self.assertEqual((run.returncode, run.stdout.splitlines()[-1]), (2, "exit: 2"))
        self.assertNotIn("RAN", run.stdout)

    def test_staging_refusals(self) -> None:
        self.assertEqual(self.stage(self.sha).returncode, 0)
        again = self.stage(self.sha)
        self.assertEqual(again.returncode, 1)
        self.assertIn("exists: a request id is staged once", again.stdout)
        missing = self.stage("c" * 40, request="r2")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("WITNESS STAGE FAILED: cannot fetch", missing.stdout)
        self.assertFalse(staged_sha(missing.returncode, missing.stdout, "c" * 40))
