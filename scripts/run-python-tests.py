#!/usr/bin/env python3
"""Run contiguous shards of the package unit modules (0-based --shard I/N).

Boundary: reads only test_*.py paths beneath lib/ and PYTHON_TEST_CUTS (pipe-separated
fully qualified module names, each the first module of the next shard). It does not
parse test source or balance individual cases. Package paths must be importable;
invalid/missing/unordered cuts, empty parts and a matrix size unequal to cuts + 1
refuse before loading tests. New modules automatically belong to one range.
Elapsed lines measure each loaded module suite with a monotonic clock, including
fixture transitions performed there by unittest. A module's final class/module
teardown is counted in the next module's line, and the last module's in none.
Imports/load_tests are not timed.
"""

import argparse
import os
from pathlib import Path
import re
import shlex
import sys
import time
import unittest


def modules(root: Path) -> list[str]:
    result = []
    for path in sorted(root.rglob("test_*.py")):
        relative = path.relative_to(root).with_suffix("")
        if not all(p.isidentifier() for p in relative.parts) or not all(
            (parent / "__init__.py").is_file()
            for parent in path.parents if parent != root and root in parent.parents
        ):
            raise ValueError(f"non-importable test module: {shlex.quote(str(path))}")
        result.append(".".join(relative.parts))
    if not result:
        raise ValueError("no test modules beneath lib/")
    return result


def select(all_modules: list[str], cuts: list[str], shard: str) -> list[str]:
    if not re.fullmatch(r"[0-9]+/[0-9]+", shard):
        raise ValueError(f"want 0-based I/N, got {shard!r}")
    index, total = map(int, shard.split("/"))
    if total != len(cuts) + 1 or not 0 <= index < total:
        raise ValueError(f"shard {shard!r} does not match {len(cuts)} cuts")
    positions = [0]
    for cut in cuts:
        if cut not in all_modules:
            raise ValueError(f"cut names no module: {shlex.quote(cut)}")
        position = all_modules.index(cut)
        if position <= positions[-1]:
            raise ValueError(f"cut leaves an empty/unordered part: {shlex.quote(cut)}")
        positions.append(position)
    positions.append(len(all_modules))
    return all_modules[positions[index]:positions[index + 1]]


class TimedModule(unittest.TestSuite):
    """Time one loaded module suite without changing unittest's shared result."""

    def __init__(self, name: str, suite: unittest.TestSuite):
        super().__init__([suite])
        self.name = name

    def run(self, result, debug=False):
        started = time.monotonic()
        try:
            return super().run(result, debug)
        finally:
            print(f"--- {time.monotonic() - started:.3f}s: {self.name}", flush=True)


def run_modules(selected: list[str]):
    loader = unittest.TestLoader()
    # Load every module before running any, just as loadTestsFromNames did before
    # timing. Keep one outer suite/result so module/class fixtures and errors retain
    # unittest's ordering and failure semantics (including failed imports).
    loaded = loader.loadTestsFromNames(selected)
    suite = unittest.TestSuite(
        TimedModule(name, tests) for name, tests in zip(selected, loaded, strict=True)
    )
    return unittest.TextTestRunner(verbosity=2).run(suite)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", required=True)
    parser.add_argument("--list", action="store_true", help="list modules without importing them")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent / "lib"
    try:
        cuts = os.environ.get("PYTHON_TEST_CUTS", "").split("|")
        selected = select(modules(root), cuts if cuts != [""] else [], args.shard)
    except ValueError as error:
        parser.error(str(error))
    if args.list:
        print("\n".join(selected))
        return 0
    print(f"Python shard {args.shard}: {len(selected)} modules", flush=True)
    sys.path.insert(0, str(root))
    return 0 if run_modules(selected).wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
