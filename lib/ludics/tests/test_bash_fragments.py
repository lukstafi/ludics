"""Every shell fragment the package ships to a box parses, under the shells that run it.

The far side of fleet-worker.sh is bash held in Python string constants (farside.py's ``LAUNCH_START``,
``UNSTICK`` ...), composed with a prelude and run on a box over ``bash -s``. A fragment that does not
parse fails only there, at run time: on 2026-11-21 an apostrophe inside ``"${why:-...agy's...}"``
(bash 3.2 reads a ``'`` in a double-quoted ``${...}`` default as an opening quote) broke four of them,
and only a hand-run ``bash -n`` caught it. ``scripts/check-parse-guards.sh`` parses the ``.sh``
files, not these. macOS boxes run ``/bin/bash`` 3.2, so a run there checks what Linux CI's bash 5
cannot.

THE BOUNDARY, a fail-closed allowlist of modules: every module of ``ludics.fleetworker`` and the
modules in ``EXTRA_MODULES``. In them:
- every constant a module ASSIGNS at its top level (read from its source, so an imported constant
  is checked once, under the module that defines it), whose name is ALL-CAPS (a leading underscore
  allowed) and whose value is a str containing ``$``, is a fragment, run by ``bash`` and
  ``/bin/bash``, unless ``SH`` names it (run by ``sh``) or ``NOT_SHELL`` does (not shell at all: a
  new such constant fails here by name until it is named, so a fragment is never skipped silently);
- every quoted heredoc inside a fragment (``<<'TAG'`` or ``<<"TAG"``, its body data to the outer
  ``bash -n``) is a fragment of its own, ``<fragment> <<TAG``: those shipped today are bash a box
  runs later (GHPROBE's probe, LEG's results script); one that is not would be named in
  ``NOT_SHELL`` the same way. An unquoted heredoc's body is the outer script's expansion and is not
  read.
Out of the boundary: shell built at run time (f-strings, joins), lowercase names, and the other
packages (checkprompts' regexes, prreview's GraphQL), which ship no shell to a box. The check is
``-n``: each fragment's syntax alone, not its behaviour or its composition with a prelude.
"""

import ast
import importlib
import inspect
import os
import pkgutil
import re
import shutil
import subprocess
import unittest
from types import ModuleType
from unittest import mock

import ludics.fleetworker

EXTRA_MODULES = ("ludics.prreview.mergebuild", "ludics.prreview.mergelease")
# Run as `sh -c`, so held to sh's grammar (dash on Ubuntu), not bash's.
SH = frozenset({"ludics.prreview.mergebuild._WRAPPER", "ludics.prreview.mergebuild._PLAN_WRAPPER"})
# Constants with a `$` that are not shell: GraphQL queries the supervision read sends.
NOT_SHELL = frozenset({"ludics.fleetworker.supervision.XREF_QUERY", "ludics.fleetworker.supervision.CLOSING_QUERY"})
BASHES = tuple(dict.fromkeys(s for s in ("bash", "/bin/bash") if shutil.which(s) or os.path.exists(s)))
HEREDOC = re.compile(r"<<-?[ \t]*(['\"])([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n(.*?)\n[ \t]*\2[ \t]*$", re.M | re.S)


def modules() -> list[ModuleType]:
    names = [m.name for m in pkgutil.walk_packages(ludics.fleetworker.__path__, "ludics.fleetworker.")]
    return [importlib.import_module(name) for name in [*names, *EXTRA_MODULES]]


def assigned(module: ModuleType) -> set[str]:
    """The names a module's own source assigns at its top level."""
    names: set[str] = set()
    for node in ast.parse(inspect.getsource(module)).body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        names.update(t.id for t in targets if isinstance(t, ast.Name))
    return names


def with_heredocs(found: dict[str, str]) -> dict[str, str]:
    """``found`` and, for each quoted heredoc in a fragment, its body as ``<key> <<TAG``."""
    out = dict(found)
    for key, text in found.items():
        for _quote, tag, body in HEREDOC.findall(text):
            out[f"{key} <<{tag}"] = body
    return out


def fragments() -> dict[str, str]:
    """``<module>.<NAME>`` (and ``<module>.<NAME> <<TAG``) -> the fragment, THE BOUNDARY's."""
    found: dict[str, str] = {}
    for module in modules():
        own = assigned(module)
        for name, value in vars(module).items():
            if name in own and isinstance(value, str) and "$" in value and name.lstrip("_").isupper():
                found[f"{module.__name__}.{name}"] = value
    return with_heredocs(found)


def shells(key: str) -> tuple[str, ...]:
    return ("sh",) if key in SH else BASHES


def problems(found: dict[str, str]) -> list[str]:
    """Each fragment that does not parse, with its shell: the one check the tests make."""
    out: list[str] = []
    for key, text in sorted(found.items()):
        if key in NOT_SHELL:
            continue
        for shell in shells(key):
            done = subprocess.run([shell, "-n", "-c", text], capture_output=True, text=True, check=False)
            if done.returncode != 0:
                out.append(f"{key} does not parse under {shell}: {done.stderr.strip()[:300]} (not shell? name it in NOT_SHELL)")
    return out


class ShellFragments(unittest.TestCase):
    def test_every_fragment_parses_under_its_shells(self) -> None:
        found = fragments()
        self.assertGreater(len(found), 50, "the boundary finds the far side's fragments at all")
        for key in ("ludics.fleetworker.farside.UNSTICK", "ludics.fleetworker.farside.FLEET_PYTHON",
                    "ludics.fleetworker.farside.GHPROBE <<PROBE", "ludics.fleetworker.leg.LEG <<FLEET_LEG_RUNS"):
            self.assertIn(key, found, "a fragment is named by the module that defines it, a heredoc by its tag")
        self.assertNotIn("ludics.fleetworker.board.FLEET_PYTHON", found, "an imported constant is not checked again")
        self.assertTrue(BASHES, "no bash to parse with")
        self.assertEqual(problems(found), [])

    def test_the_exemptions_name_fragments_that_exist(self) -> None:
        found = fragments()
        self.assertEqual(sorted((NOT_SHELL | SH) - found.keys()), [], "an exemption names nothing in the boundary")

    def test_a_broken_fragment_is_reported_by_name_through_the_same_check(self) -> None:
        """The negative controls go through ``problems``: a fragment that does not parse is named
        with each shell; the 2026-11-21 shape under every bash 3.2 (a later one may report it too,
        as 5.2 does, or not: the test requires only the 3.2s); a broken body inside a quoted heredoc; and, where sh is a POSIX sh,
        a bash-only construct in a fragment ``SH`` names."""
        broken = {"x.BROKEN": 'if [ -n "$x" ]; then\n  echo x\n'}
        self.assertEqual([p.split(":")[0] for p in problems(broken)], [f"x.BROKEN does not parse under {s}" for s in BASHES])
        heredoc = 'cat > "$f" <<\'BODY\'\nif [ -n "$y" ]; then\n  echo y\nBODY\nbash "$f"\n'
        self.assertEqual(problems({"x.OUTER": heredoc}), [], "the outer script reads the body as data")
        self.assertEqual({p.split(" does not")[0] for p in problems(with_heredocs({"x.OUTER": heredoc}))}, {"x.OUTER <<BODY"})
        apostrophe = 'x=1 || echo "${why:-cannot write agy\'s line}"\nfor i in 1; do\n  s=$(echo a | cut -c1)\ndone\n'
        old = [s for s in BASHES if subprocess.run([s, "-c", "echo ${BASH_VERSINFO[0]}"], capture_output=True,
                                                   text=True, check=False).stdout.strip() == "3"]
        reported = {p.split(" does not parse under ")[1].split(":")[0] for p in problems({"x.APOSTROPHE": apostrophe})}
        self.assertLessEqual(set(old), reported, "every bash 3.2 reports it (a later one may too: bash 5.2 does)")
        # Where sh is a POSIX sh (dash, Ubuntu's): macOS's sh is bash and reads a bash array.
        if subprocess.run(["sh", "-n", "-c", "a=(1 2)"], capture_output=True, check=False).returncode != 0:
            with mock.patch(f"{__name__}.SH", frozenset({"x.SH"})):
                self.assertTrue(problems({"x.SH": 'a=(1 2); echo "${a[0]}$x"\n'}), "sh refuses a bash array")


if __name__ == "__main__":
    unittest.main()
