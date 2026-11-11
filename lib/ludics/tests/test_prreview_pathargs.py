"""pr-review.sh's ``py_native_args`` (ludics#756): the options its hand-kept table converts to native
paths for Git Bash are exactly the options the Python takes a path for. Leaving one out passes every
macOS and Linux check and breaks only on Git Bash (post-1-task-2's ``--body-file``, PR #757).

THE SCAN, and its boundary, as a fail-closed allowlist. It reads the AST of every module of
``lib/ludics/prreview`` and takes an option-shaped string literal (``-x``, ``--name``, either with a
trailing ``=``) from exactly two places: an operand of a comparison (``arg == "--out"``,
``a in ("-R", "--repo")``) and an argument of a ``.startswith`` call (``arg.startswith("--out=")``,
a tuple of them too). Every literal it finds must be classified below, as a path option (``PATHS``,
with the pr-review.sh subcommands that reach it) or not (``NOT_PATHS``), and nothing classified may
be missing from the scan: a new option fails this suite until a reader says which it is. Not read:
an option spelled any other way (a table, a regex, argparse); a positional path (``body``'s file,
the table's ``body:`` rows); and where an option's value flows -- whether the Python opens it is the
classification's, made by whoever adds the option.

THE TABLE is read from ``py_native_args``'s body in pr-review.sh: each ``case`` pattern
``<sub>:<option>`` or ``<sub>:<option>=*``, ``|``-joined. A path option must be there for each of its
subcommands, and its ``=*`` form exactly when the Python accepts ``<option>=``; nothing else but the
``body:`` rows may be.
"""

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PRREVIEW = ROOT / "lib" / "ludics" / "prreview"
PR_REVIEW_SH = ROOT / "ship-pr" / "scripts" / "pr-review.sh"
OPTION = re.compile(r"--?[A-Za-z][A-Za-z0-9-]*=?")

# (module, option) -> the pr-review.sh subcommands whose path it is.
PATHS: dict[tuple[str, str], tuple[str, ...]] = {
    ("base.py", "--integration-records"): ("base",),
    ("base.py", "--advisory-red"): ("base",),
    ("reply.py", "--body-file"): ("reply", "comment"),  # comment.py parses it with reply.body_file_arg
    ("merge.py", "-C"): ("merge",),
    ("mergedry.py", "--config"): ("merge-build",),
    ("mergedry.py", "-C"): ("merge-build",),
    ("localreview.py", "--out"): ("local-review",),
    ("localreview.py", "-C"): ("local-review",),
}

NOT_PATHS: frozenset[tuple[str, str]] = frozenset({
    ("__main__.py", "--repo"), ("__main__.py", "--repo="),
    ("base.py", "--greens"), ("base.py", "--greens="), ("base.py", "--interim"),
    ("base.py", "--last-green"), ("base.py", "--last-green="), ("base.py", "--wait"), ("base.py", "--wait="),
    ("budget.py", "--job"), ("budget.py", "--job="), ("budget.py", "--repo"), ("budget.py", "--repo="),
    ("budget.py", "-R"), ("budget.py", "-j"),
    ("checks.py", "--check"), ("checks.py", "--check="), ("checks.py", "--settle"), ("checks.py", "--wait"),
    ("checks.py", "--wait="),
    ("comment.py", "--allow-mention"),
    ("comment.py", "--coordinator"),
    ("comment.py", "--coordinator="),
    ("core.py", "--field"), ("core.py", "--raw-field"), ("core.py", "-F"), ("core.py", "-f"),  # gh's, read back
    ("merge.py", "--allow-no-verdict"), ("merge.py", "--auto"), ("merge.py", "--auto="),
    ("merge.py", "--check"), ("merge.py", "--check="), ("merge.py", "--match-head-commit"),
    ("merge.py", "--match-head-commit="), ("merge.py", "--override"), ("merge.py", "--override="),
    ("merge.py", "--require-green"), ("merge.py", "--rerun-failed-once"), ("merge.py", "--wait"), ("merge.py", "--wait="),
    ("mergedry.py", "--base"), ("mergedry.py", "--base="), ("mergedry.py", "--head"), ("mergedry.py", "--head="),
    ("reply.py", "--allow-mention"), ("reply.py", "--anchor"), ("reply.py", "--anchor="),
    ("retry.py", "--read"), ("retry.py", "--write"),
    ("runwatch.py", "--compact"), ("runwatch.py", "--exit-status"), ("runwatch.py", "--interval"),
    ("runwatch.py", "--interval="), ("runwatch.py", "--repo"), ("runwatch.py", "--repo="),
    ("runwatch.py", "-R"), ("runwatch.py", "-R="), ("runwatch.py", "-i"), ("runwatch.py", "-i="),
    ("watch.py", "--no-nudge"),
})


def literals(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return [text for element in node.elts for text in literals(element)]
    return []


def scanned() -> set[tuple[str, str]]:
    """THE SCAN (the header): every (module, option-shaped literal) of the prreview package."""
    found: set[tuple[str, str]] = set()
    for path in sorted(PRREVIEW.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), str(path))):
            operands: list[ast.expr] = []
            if isinstance(node, ast.Compare):
                operands = [node.left, *node.comparators]
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "startswith":
                operands = list(node.args)
            found |= {(path.name, text) for operand in operands for text in literals(operand) if OPTION.fullmatch(text)}
    return found


def table() -> set[tuple[str, str]]:
    """THE TABLE (the header): ``py_native_args``'s case patterns, as (subcommand, option[=*])."""
    text = PR_REVIEW_SH.read_text(encoding="utf-8")
    body = re.search(r"^py_native_args\(\) \{\n(.*?)^\}\n", text, re.S | re.M)
    assert body, "no py_native_args() in pr-review.sh"
    rows: set[tuple[str, str]] = set()
    for line in body.group(1).splitlines():
        head = re.match(r"\s*([a-z-]+:[^ )|]+(?:\s*\|\s*[a-z-]+:[^ )|]+)*)\)", line)
        if head:
            for pattern in head.group(1).split("|"):
                sub, _, option = pattern.strip().partition(":")
                rows.add((sub, option))
    return rows


class PathOptions(unittest.TestCase):
    def test_every_option_the_python_takes_is_classified(self) -> None:
        found = scanned()
        classified = NOT_PATHS | set(PATHS) | {(m, o + "=") for m, o in PATHS if (m, o + "=") in found}
        self.assertEqual(sorted(found - classified), [], "an option nobody has said is a path or not")
        self.assertEqual(sorted(classified - found), [], "a classified option the Python no longer takes")

    def test_the_shell_table_converts_exactly_the_path_options(self) -> None:
        found = scanned()
        want = {(sub, option) for (_, option), subs in PATHS.items() for sub in subs}
        want |= {(sub, option + "=*") for (module, option), subs in PATHS.items() for sub in subs
                 if (module, option + "=") in found}
        have = {(sub, option) for sub, option in table() if sub != "body"}
        self.assertEqual(sorted(want - have), [], "a path option py_native_args leaves unconverted")
        self.assertEqual(sorted(have - want), [], "a py_native_args row for no path option")

    def test_the_readers_see_what_they_must(self) -> None:
        """Negative controls: the scan finds both literal places, the table both pattern forms."""
        self.assertIn(("reply.py", "--body-file="), scanned())  # a startswith argument
        self.assertIn(("mergedry.py", "--config="), scanned())  # inside a startswith tuple
        self.assertIn(("runwatch.py", "-R"), scanned())  # inside an `in` tuple
        self.assertIn(("comment", "--body-file=*"), table())  # the second of a |-joined pair
        self.assertIn(("body", "-"), table())


if __name__ == "__main__":
    unittest.main()
