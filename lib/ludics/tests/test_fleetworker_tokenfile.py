"""Run PREFLIGHT's token-file block under bash, with controlled numeric ls metadata.

Boundary: the block checks the file before sourcing it; GitHub probes and checkout freshness
are outside this fixture and remain covered by test-fleet-worker.sh's preflight section.
"""

import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

from ludics.fleetworker.farside import PREFLIGHT

TOKEN_CHECK = 'tokf="' + PREFLIGHT.split('tokf="', 1)[1].split('gh_bound=$gh_timeout', 1)[0]


class TokenFile(unittest.TestCase):
    def check_mode(self, mode: str, *, owned: bool = True, acl: str = "") -> tuple[str, bool]:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            token = home / ".config/fleet/gh-token.sh"
            token.parent.mkdir(parents=True)
            sourced = home / "sourced"
            token.write_text(f"touch {shlex.quote(str(sourced))}\nexport GH_TOKEN=fixture\n")
            token.chmod(0o600)
            uid = os.getuid() if owned else os.getuid() + 1
            listing = f"{mode} 1 {uid} 0 0 Jan 1 00:00 {token}"
            script = f"""set -eu
BOX=testbox BOX_IS_LOCAL=1
note() {{ printf '%s\\n' "$*"; }}
ls() {{
  [ "$1" != -lnde ] || [ {shlex.quote(acl)} != unreadable ] || return 1
  printf '%s\\n' {shlex.quote(listing)}
  if [ "$1" = -lnde ] && [ {shlex.quote(acl)} = present ]; then
    printf '%s\\n' ' 0: group:everyone allow read'
  fi
}}
""" + TOKEN_CHECK + '\nprintf "tokbad=%s\\n" "$tokbad"\n'
            result = subprocess.run(["/bin/bash", "-c", script], text=True, capture_output=True,
                                    env={**os.environ, "HOME": str(home), "GH_TOKEN": "fixture"})
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout, sourced.exists()

    def test_private_modes_allow_optional_xattr(self) -> None:
        for mode in ("-rw-------", "-r--------"):
            for marker in ("", "@"):
                with self.subTest(mode=mode, marker=marker):
                    output, sourced = self.check_mode(mode + marker)
                    self.assertIn("tokbad=\n", output)
                    self.assertTrue(sourced)

    def test_acl_is_named_and_never_sourced(self) -> None:
        for mode in ("-rw-------+", "-r--------+"):
            with self.subTest(mode=mode):
                output, sourced = self.check_mode(mode)
                self.assertIn("ACL", output)
                self.assertIn("repair: replace it here with a regular 0600 file", output)
                self.assertIn("tokbad=1\n", output)
                self.assertFalse(sourced)

    def test_other_metadata_remains_refused_before_sourcing(self) -> None:
        for mode, owned in (("-rw-r--r--@", True), ("lrw-------@", True),
                            ("-rw-------@+", True), ("-rw-------.", True),
                            ("-rw-------@", False)):
            with self.subTest(mode=mode, owned=owned):
                output, sourced = self.check_mode(mode, owned=owned)
                self.assertIn("tokbad=1\n", output)
                self.assertFalse(sourced)

    def test_xattr_cannot_hide_an_acl_or_failed_inspection(self) -> None:
        for mode in ("-rw-------@", "-r--------@"):
            for acl in ("present", "unreadable"):
                with self.subTest(mode=mode, acl=acl):
                    output, sourced = self.check_mode(mode, acl=acl)
                    self.assertIn("ACL", output)
                    self.assertIn("tokbad=1\n", output)
                    self.assertFalse(sourced)
