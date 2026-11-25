#!/usr/bin/env python3
"""Run contiguous shards of the package unit modules (0-based --shard I/N).

Boundary: reads only test_*.py paths beneath lib/, PYTHON_TEST_CUTS (pipe-separated
fully qualified module names, each the first module of the next shard), and the
recorded Ubuntu baseline timings in MODULE_TIMINGS. It does not parse test source,
balance individual cases, or read live CI logs. Package paths must be importable;
invalid/missing/unordered cuts, empty parts and a matrix size unequal to cuts + 1
refuse before loading tests. New modules automatically belong to one range.

Headroom check (check_headroom / --check-headroom): sums each shard's recorded
Ubuntu baseline seconds, scales by SLOW_RUNNER_SCALE (1.4, from the slow Ubuntu
runner ratio measured in #1336), and refuses when any shard leaves less than
MIN_HEADROOM_SECONDS (30.0 s) below the watchdog. Stale or invalid keys in
MODULE_TIMINGS refuse fail-closed; a newly added module not yet recorded in
MODULE_TIMINGS is charged UNRECORDED_MODULE_SECONDS (5.0 s) so new modules still
land automatically while consuming headroom. Updating MODULE_TIMINGS when an
existing module grows remains an explicit edit from the elapsed rows below.

Elapsed lines measure each loaded module suite with a monotonic clock, including
fixture transitions performed there by unittest. A module's final class/module
teardown is counted in the next module's line, and the last module's in none.
Imports/load_tests are not timed.
"""

import argparse
from collections.abc import Mapping
from dataclasses import dataclass
import math
import os
from pathlib import Path
import re
import shlex
import sys
import time
import unittest

SLOW_RUNNER_SCALE = 1.4
MIN_HEADROOM_SECONDS = 30.0
UNRECORDED_MODULE_SECONDS = 5.0

# Recorded Ubuntu baseline seconds per module: medians over six green main-branch
# runs (45213233000, 45215827456, 45220631341, 45224703994, 45233765095,
# 45367321537; recent five for test_peerplan after its wave-20261123 growth).
# test_checkprompts_cli (164.1s median unsplit) is split 54.3% / 45.7% into
# test_checkprompts_cli (89.1s) and test_checkprompts_cli_checks (75.0s) from
# per-class subprocess profiling (#1336).
MODULE_TIMINGS: dict[str, float] = {
    "ludics.tests.test_bash_fragments": 0.8,
    "ludics.tests.test_bgrun": 1.3,
    "ludics.tests.test_checkprompts": 0.0,
    "ludics.tests.test_checkprompts_cli": 89.1,
    "ludics.tests.test_checkprompts_cli_checks": 75.0,
    "ludics.tests.test_claude": 0.3,
    "ludics.tests.test_fake": 0.4,
    "ludics.tests.test_fleetworker_assign": 0.6,
    "ludics.tests.test_fleetworker_board": 0.8,
    "ludics.tests.test_fleetworker_closeout": 0.0,
    "ludics.tests.test_fleetworker_config": 0.0,
    "ludics.tests.test_fleetworker_cotenants": 0.2,
    "ludics.tests.test_fleetworker_execution": 3.5,
    "ludics.tests.test_fleetworker_farsideclose": 11.6,
    "ludics.tests.test_fleetworker_gate": 0.0,
    "ludics.tests.test_fleetworker_graces": 0.7,
    "ludics.tests.test_fleetworker_group": 14.1,
    "ludics.tests.test_fleetworker_holders": 0.9,
    "ludics.tests.test_fleetworker_leg": 14.0,
    "ludics.tests.test_fleetworker_registry": 6.3,
    "ludics.tests.test_fleetworker_siblingscan": 0.4,
    "ludics.tests.test_fleetworker_slot": 17.6,
    "ludics.tests.test_fleetworker_status": 3.8,
    "ludics.tests.test_fleetworker_suitecalls": 0.0,
    "ludics.tests.test_fleetworker_supervision": 1.9,
    "ludics.tests.test_fleetworker_takeover": 3.9,
    "ludics.tests.test_fleetworker_tiprun": 3.4,
    "ludics.tests.test_fleetworker_tokenfile": 0.1,
    "ludics.tests.test_fleetworker_transport": 1.1,
    "ludics.tests.test_fleetworker_wave": 32.6,
    "ludics.tests.test_fleetworker_waveab": 1.4,
    "ludics.tests.test_fleetworker_winwitness": 0.1,
    "ludics.tests.test_fleetworker_winwitness_staging": 0.5,
    "ludics.tests.test_fleetworker_workers": 4.2,
    "ludics.tests.test_peerplan": 63.9,
    "ludics.tests.test_postmergecleanup": 5.5,
    "ludics.tests.test_proc": 0.1,
    "ludics.tests.test_prreview_base": 4.3,
    "ludics.tests.test_prreview_body": 5.8,
    "ludics.tests.test_prreview_budget": 0.0,
    "ludics.tests.test_prreview_buildhistory": 0.0,
    "ludics.tests.test_prreview_commentonly": 0.0,
    "ludics.tests.test_prreview_core": 2.0,
    "ludics.tests.test_prreview_gate": 0.6,
    "ludics.tests.test_prreview_images": 0.0,
    "ludics.tests.test_prreview_jobsteps": 0.0,
    "ludics.tests.test_prreview_localreview": 1.3,
    "ludics.tests.test_prreview_merge": 56.4,
    "ludics.tests.test_prreview_mergebuild": 44.8,
    "ludics.tests.test_prreview_mergelease": 1.1,
    "ludics.tests.test_prreview_pathargs": 1.3,
    "ludics.tests.test_prreview_readers": 0.1,
    "ludics.tests.test_prreview_rerun": 0.0,
    "ludics.tests.test_prreview_runners": 0.3,
    "ludics.tests.test_prreview_watch": 3.8,
    "ludics.tests.test_prreview_writers": 1.2,
}


@dataclass(frozen=True)
class ShardPlan:
    index: int
    total: int
    modules: tuple[str, ...]
    planned: float
    scaled: float
    headroom: float
    unrecorded: tuple[str, ...]


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


def check_headroom(
    all_modules: list[str],
    cuts: list[str],
    watchdog: float,
    timings: Mapping[str, float] | None = None,
    *,
    slow_scale: float = SLOW_RUNNER_SCALE,
    min_headroom: float = MIN_HEADROOM_SECONDS,
    unrecorded_seconds: float = UNRECORDED_MODULE_SECONDS,
) -> list[ShardPlan]:
    if isinstance(watchdog, bool) or not math.isfinite(watchdog) or watchdog <= 0:
        raise ValueError(f"watchdog must be a positive finite number, got {watchdog!r}")
    if isinstance(slow_scale, bool) or not math.isfinite(slow_scale) or slow_scale <= 0:
        raise ValueError(f"slow_scale must be a positive finite number, got {slow_scale!r}")
    if isinstance(min_headroom, bool) or not math.isfinite(min_headroom) or min_headroom < 0 or min_headroom >= watchdog:
        raise ValueError(
            f"min_headroom must be finite and in [0, watchdog), got {min_headroom!r} for watchdog {watchdog!r}"
        )
    if isinstance(unrecorded_seconds, bool) or not math.isfinite(unrecorded_seconds) or unrecorded_seconds < 0:
        raise ValueError(f"unrecorded_seconds must be finite and >= 0, got {unrecorded_seconds!r}")

    table = MODULE_TIMINGS if timings is None else timings
    known = set(all_modules)
    for name, seconds in sorted(table.items()):
        if name not in known:
            raise ValueError(f"timing entry names no module: {shlex.quote(name)}")
        if isinstance(seconds, bool) or not math.isfinite(seconds) or seconds < 0:
            raise ValueError(f"invalid timing for {shlex.quote(name)}: {seconds!r}")

    total = len(cuts) + 1
    plans: list[ShardPlan] = []
    violations: list[str] = []
    for index in range(total):
        selected = select(all_modules, cuts, f"{index}/{total}")
        weights: list[tuple[float, str]] = []
        unrecorded: list[str] = []
        for module in selected:
            if module in table:
                weight = float(table[module])
            else:
                weight = float(unrecorded_seconds)
                unrecorded.append(module)
            weights.append((weight, module))
        planned = sum(weight for weight, _ in weights)
        scaled = planned * slow_scale
        headroom = watchdog - scaled
        plans.append(
            ShardPlan(
                index=index,
                total=total,
                modules=tuple(selected),
                planned=planned,
                scaled=scaled,
                headroom=headroom,
                unrecorded=tuple(unrecorded),
            )
        )
        # Allow a tiny floating-point tolerance so exact boundary equality passes.
        if headroom + 1e-9 < min_headroom:
            heaviest = ", ".join(
                f"{shlex.quote(mod)}={weight:.1f}s"
                for weight, mod in sorted(weights, key=lambda item: (-item[0], item[1]))[:3]
            )
            violations.append(
                f"shard {index}/{total}: planned {planned:.1f}s, scaled x{slow_scale:g} = {scaled:.1f}s, "
                f"headroom {headroom:.1f}s < {min_headroom:.1f}s under {watchdog:g}s watchdog "
                f"(heaviest: {heaviest})"
            )
    if violations:
        raise ValueError("insufficient shard headroom:\n  " + "\n  ".join(violations))
    return plans


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


def _parse_cuts() -> list[str]:
    raw = os.environ.get("PYTHON_TEST_CUTS", "")
    return raw.split("|") if raw else []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--shard", help="0-based I/N shard to list or run")
    mode.add_argument(
        "--check-headroom",
        action="store_true",
        help="validate PYTHON_TEST_CUTS headroom against MODULE_TIMINGS and exit",
    )
    parser.add_argument("--list", action="store_true", help="list modules without importing them")
    parser.add_argument(
        "--watchdog",
        type=float,
        help="watchdog seconds for --check-headroom (defaults to LUDICS_TEST_WATCHDOG)",
    )
    args = parser.parse_args(argv)
    if args.list and not args.shard:
        parser.error("--list requires --shard")
    if args.watchdog is not None and not args.check_headroom:
        parser.error("--watchdog requires --check-headroom")

    root = Path(__file__).resolve().parent.parent / "lib"
    cuts = _parse_cuts()
    if args.check_headroom:
        watchdog = args.watchdog
        if watchdog is None:
            env_watchdog = os.environ.get("LUDICS_TEST_WATCHDOG", "").strip()
            if not env_watchdog:
                parser.error("--check-headroom requires --watchdog or LUDICS_TEST_WATCHDOG")
            try:
                watchdog = float(env_watchdog)
            except ValueError:
                parser.error(f"invalid LUDICS_TEST_WATCHDOG: {env_watchdog!r}")
        try:
            plans = check_headroom(modules(root), cuts, watchdog)
        except ValueError as error:
            print(f"run-python-tests.py: {error}", file=sys.stderr)
            return 1
        for plan in plans:
            extra = f" ({len(plan.unrecorded)} unrecorded)" if plan.unrecorded else ""
            print(
                f"shard {plan.index}/{plan.total}: {len(plan.modules)} modules{extra}, "
                f"planned {plan.planned:.1f}s, scaled x{SLOW_RUNNER_SCALE:g} = {plan.scaled:.1f}s, "
                f"headroom {plan.headroom:.1f}s (min {MIN_HEADROOM_SECONDS:.1f}s)"
            )
        return 0

    try:
        selected = select(modules(root), cuts, args.shard)
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
