#!/usr/bin/env python3
"""Exercise hostile-runner verdicts using only synthetic scratch suites.

Promotes the wave-20260913-ludics/120-controls.py probes into regression tests.
Requires the same non-C locale as run-pr-review-hostile.sh; accepts its
PR_REVIEW_HOSTILE_LOCALE override. Run with python3, outside the shell-suite glob.
"""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest


RUNNER = Path(__file__).resolve().with_name("run-pr-review-hostile.sh")


class HostileControls(unittest.TestCase):
    def test_verdicts(self):
        cases = [
            ("clean", "echo PROBE-PASS", 0o755, 0, None),
            ("stderr", "echo tool-error >&2", 0o755, 1, "tool-error"),
            ("hidden leak", 'touch "$TMPDIR/.leak"', 0o755, 1, ".leak"),
            ("dangling link", 'ln -s missing "$TMPDIR/dangling"',
             0o755, 1, "dangling"),
            ("nonzero exit", "exit 7", 0o755, 1, "exit=7"),
            ("lost executable mode", "echo PROBE-PASS", 0o644, 1, "exit=126"),
        ]
        for label, body, mode, expected, diagnostic in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(
                prefix="hostile controls "
            ) as directory:
                root = Path(directory)
                runner = root / RUNNER.name
                # Never copy the real fixture suites or invoke the repository runner.
                shutil.copy2(RUNNER, runner)
                suite = root / "test-pr-review-probe.sh"
                suite.write_text("#!/usr/bin/env bash\n" + body + "\n")
                suite.chmod(mode)
                tmp = root / "outer tmp with spaces"
                tmp.mkdir()
                result = subprocess.run(
                    [str(runner)], cwd=root,
                    env=dict(os.environ, TMPDIR=str(tmp)),
                    capture_output=True, text=True, timeout=30,
                )
                output = f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
                self.assertEqual(result.returncode, expected, output)
                self.assertIn("Hostile pass: test-pr-review-probe.sh", result.stdout, output)
                if diagnostic is None:
                    self.assertIn("PROBE-PASS", result.stdout, output)
                    self.assertEqual(result.stderr, "", output)
                else:
                    self.assertIn("FAIL: test-pr-review-probe.sh", result.stderr, output)
                    self.assertIn(diagnostic, result.stderr, output)
                self.assertEqual(list(tmp.iterdir()), [], output)


class ShardControls(unittest.TestCase):
    """``--shard I/N`` (ludics#974): CI's matrix rows each run one contiguous part of the suite
    list, cut at PR_REVIEW_HOSTILE_CUTS. The parts must be every suite once, and every cut list
    that could drop a suite or run an empty part must be refused before any suite runs."""

    NAMES = ["test-pr-review-a.sh", "test-pr-review-b.sh", "test-pr-review-c.sh"]

    def run_runner(self, args, cuts=None):
        with tempfile.TemporaryDirectory(prefix="hostile shards ") as directory:
            root = Path(directory)
            runner = root / RUNNER.name
            shutil.copy2(RUNNER, runner)
            # Written in reverse, so the order the parts come out in is the runner's sort.
            for name in reversed(self.NAMES):
                suite = root / name
                suite.write_text(f"#!/usr/bin/env bash\necho PROBE-RAN {name}\n")
                suite.chmod(0o755)
            tmp = root / "outer tmp with spaces"
            tmp.mkdir()
            env = dict(os.environ, TMPDIR=str(tmp))
            env.pop("PR_REVIEW_HOSTILE_CUTS", None)
            if cuts is not None:
                env["PR_REVIEW_HOSTILE_CUTS"] = cuts
            result = subprocess.run(
                [str(runner), *args], cwd=root, env=env,
                capture_output=True, text=True, timeout=30,
            )
            ran = [line.split(" ", 1)[1] for line in result.stdout.splitlines()
                   if line.startswith("PROBE-RAN ")]
            return result, ran

    def test_parts_are_every_suite_once(self):
        result, ran = self.run_runner([])
        self.assertEqual((result.returncode, ran), (0, self.NAMES), result.stderr)
        for cuts, parts in [
            ("test-pr-review-b.sh", [self.NAMES[:1], self.NAMES[1:]]),
            ("test-pr-review-b.sh|test-pr-review-c.sh", [[n] for n in self.NAMES]),
        ]:
            joined = []
            for i, want in enumerate(parts):
                with self.subTest(cuts=cuts, part=i):
                    result, ran = self.run_runner(["--shard", f"{i}/{len(parts)}"], cuts)
                    self.assertEqual((result.returncode, ran), (0, want), result.stdout + result.stderr)
                    joined += ran
            self.assertEqual(joined, self.NAMES)

    def test_refusals_run_nothing(self):
        cases = [
            ("a matrix that lost a row", ["--shard", "0/3"], "test-pr-review-b.sh",
             "3 parts need 2 cut(s)"),
            ("a cut list with no matrix", ["--shard", "0/1"], "test-pr-review-b.sh",
             "1 parts need 0 cut(s)"),
            ("a cut naming no suite", ["--shard", "0/2"], "test-pr-review-x.sh", "names no suite"),
            ("a cut at the first suite", ["--shard", "0/2"], "test-pr-review-a.sh",
             "leaves an empty part"),
            ("a repeated cut", ["--shard", "0/3"], "test-pr-review-b.sh|test-pr-review-b.sh",
             "leaves an empty part"),
            ("cuts out of order", ["--shard", "0/3"], "test-pr-review-c.sh|test-pr-review-b.sh",
             "leaves an empty part"),
            ("a part past the last", ["--shard", "2/2"], "test-pr-review-b.sh",
             "part 2 of 2 does not exist"),
            ("a part that is not I/N", ["--shard", "1"], "test-pr-review-b.sh", "want I/N"),
            ("--shard with nothing after it", ["--shard"], None, "want I/N after it"),
            ("an unknown argument", ["test-pr-review-a.sh"], None, "unknown argument"),
        ]
        for label, args, cuts, diagnostic in cases:
            with self.subTest(label=label):
                result, ran = self.run_runner(args, cuts)
                output = f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
                self.assertEqual(result.returncode, 2, output)
                self.assertIn(diagnostic, result.stderr, output)
                self.assertEqual(ran, [], output)
                self.assertNotIn("Hostile pass:", result.stdout, output)


if __name__ == "__main__":
    unittest.main()
