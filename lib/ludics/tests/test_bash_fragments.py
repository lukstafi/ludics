"""Every bash fragment the package ships to a box parses, under ``bash`` and ``/bin/bash``.

The far side of fleet-worker.sh is bash held in Python string constants (farside.py's ``LAUNCH_START``,
``UNSTICK`` ...), composed with a prelude and run on a box over ``bash -s``. A fragment that does not
parse fails only there, at run time: on 2026-11-21 an apostrophe inside ``"${why:-...agy's...}"``
(bash reads a ``'`` in a double-quoted ``${...}`` default as an opening quote) broke four of them,
and only a hand-run ``bash -n`` caught it. ``scripts/check-parse-guards.sh`` parses the ``.sh``
files, not these.

THE BOUNDARY, a fail-closed allowlist of modules: every module of ``ludics.fleetworker`` and the
modules in ``EXTRA_MODULES``. In them, every module-level constant whose name is ALL-CAPS (a
leading underscore allowed) and whose value is a str containing ``$`` is read as a bash fragment,
except the constants ``NOT_BASH`` names. A new non-bash constant with a ``$`` in it fails this test
by name, to be added to ``NOT_BASH``, so a bash fragment is never skipped silently. A constant
imported from another module is checked once, where it is defined. Out of the boundary: bash built
at run time (f-strings, joins), lowercase names, and the other packages (checkprompts' regexes,
prreview's GraphQL), which ship no bash to a box. The check is ``bash -n``: the fragment's syntax,
alone, not its behaviour or its composition with the prelude.
"""

import importlib
import os
import pkgutil
import shutil
import subprocess
import unittest
from types import ModuleType

import ludics.fleetworker

EXTRA_MODULES = ("ludics.prreview.mergebuild", "ludics.prreview.mergelease")
# Constants with a `$` that are not bash: GraphQL queries the supervision read sends.
NOT_BASH = frozenset({"ludics.fleetworker.supervision.XREF_QUERY", "ludics.fleetworker.supervision.CLOSING_QUERY"})
SHELLS = tuple(dict.fromkeys(s for s in ("bash", "/bin/bash") if shutil.which(s) or os.path.exists(s)))


def modules() -> list[ModuleType]:
    names = [m.name for m in pkgutil.walk_packages(ludics.fleetworker.__path__, "ludics.fleetworker.")]
    return [importlib.import_module(name) for name in [*names, *EXTRA_MODULES]]


def fragments() -> dict[str, str]:
    """``<module>.<NAME>`` -> the fragment, for every constant in THE BOUNDARY. A value several
    modules hold (one imports it from another) is keyed by the first of them by name."""
    found: dict[str, str] = {}
    seen: set[int] = set()
    for module in sorted(modules(), key=lambda m: m.__name__):
        for name, value in vars(module).items():
            if isinstance(value, str) and "$" in value and name.lstrip("_").isupper() and id(value) not in seen:
                seen.add(id(value))
                found[f"{module.__name__}.{name}"] = value
    return found


class BashFragments(unittest.TestCase):
    def test_every_fragment_parses_under_each_bash(self) -> None:
        found = fragments()
        self.assertGreater(len(found), 50, "the boundary finds the far side's fragments at all")
        self.assertIn("ludics.fleetworker.farside.UNSTICK", found)
        self.assertTrue(SHELLS, "no bash to parse with")
        for key, text in sorted(found.items()):
            if key in NOT_BASH:
                continue
            for shell in SHELLS:
                with self.subTest(fragment=key, shell=shell):
                    done = subprocess.run([shell, "-n", "-c", text], capture_output=True, text=True, check=False)
                    self.assertEqual(done.returncode, 0, f"{key} does not parse under {shell}: {done.stderr.strip()[:300]}"
                                     f" (not bash? name it in NOT_BASH)")

    def test_not_bash_names_constants_that_exist(self) -> None:
        found = fragments()
        self.assertEqual(sorted(NOT_BASH - found.keys()), [], "a NOT_BASH entry names no constant in the boundary")

    def test_a_broken_fragment_is_caught(self) -> None:
        """The negative control: a fragment that does not parse is refused under each shell; and the
        2026-11-21 shape, an apostrophe in a double-quoted ``${...:-}`` default, wherever the shell's
        bash reads it so (3.2 does; a later bash may not, which the far side cannot count on)."""
        for shell in SHELLS:
            with self.subTest(shell=shell):
                done = subprocess.run([shell, "-n", "-c", "if true; then\n  echo x\n"], capture_output=True, check=False)
                self.assertNotEqual(done.returncode, 0)
        apostrophe = 'x=1 || echo "${why:-cannot write agy\'s line}"\nfor i in 1; do\n  s=$(echo a | cut -c1)\ndone\n'
        for shell in SHELLS:
            version = subprocess.run([shell, "-c", "echo ${BASH_VERSINFO[0]}"], capture_output=True, text=True, check=False).stdout
            if version.strip() == "3":
                with self.subTest(shell=shell, case="apostrophe"):
                    self.assertNotEqual(subprocess.run([shell, "-n", "-c", apostrophe], capture_output=True, check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
