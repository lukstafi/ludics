"""ludics.fleetworker.leg: the near side's reading of a leg's far side (the shell suite's `execution
leg` section drives the whole verb against a fake remote)."""

import contextlib
import io
import shutil
import unittest
from unittest import mock

from ludics.fleetworker import leg


class Stream(unittest.TestCase):
    """The leg's status is the sentinel's when it came, else the far side's own, and ssh's 255 with
    no sentinel is UNREACHABLE (4), since a runner's 255 always comes with one."""

    def run_far(self, script: str, *, local: bool) -> tuple[int, str, str]:
        out, said, err = io.BytesIO(), io.StringIO(), io.StringIO()

        class Out:
            """The leg's stdout: the far side's bytes through ``buffer``, its own lines through ``write``."""

            buffer = out

            def write(self, text: str) -> int:
                return said.write(text)

            def flush(self) -> None:
                pass

        bash = shutil.which("bash") or "/bin/bash"
        with contextlib.redirect_stderr(err), mock.patch.object(leg.sys, "stdout", Out()):
            rc = leg.stream([bash, "-s"], script, "box", local=local)
        return rc, out.getvalue().decode(), said.getvalue() + err.getvalue()

    def test_the_sentinel_is_the_status_and_every_line_passes_through(self) -> None:
        rc, out, _ = self.run_far("echo one\nprintf 'execution-leg: exit: 125\\n'\nexit 0\n", local=False)
        self.assertEqual((rc, out), (125, "one\nexecution-leg: exit: 125\n"))

    def test_a_sentinel_after_output_with_no_newline_gets_a_line_of_its_own(self) -> None:
        rc, out, _ = self.run_far("printf partial; printf 'execution-leg: exit: 255\\n'; exit 255\n", local=False)
        self.assertEqual((rc, out), (255, "partial\nexecution-leg: exit: 255\n"))

    def test_the_last_sentinel_wins(self) -> None:
        rc, _, _ = self.run_far("echo 'execution-leg: exit: 3'\necho 'execution-leg: exit: 0'\n", local=True)
        self.assertEqual(rc, 0)

    def test_no_sentinel_is_the_far_sides_own_status_or_unreachable(self) -> None:
        self.assertEqual(self.run_far("exit 1\n", local=False)[0], 1)
        self.assertEqual(self.run_far("exit 255\n", local=True)[0], 255)
        rc, _, err = self.run_far("exit 255\n", local=False)
        self.assertEqual(rc, 4)
        self.assertIn("EXECUTION LEG UNREACHABLE box:", err)

    def test_a_script_longer_than_a_pipe_is_fed_while_the_far_side_writes(self) -> None:
        filler = "".join(f": {'x' * 70}\n" for _ in range(2000))  # ~150 KB of no-ops after the output
        script = "head -c 200000 /dev/zero | tr '\\0' 'y'; echo\n" + filler + "echo 'execution-leg: exit: 0'\n"
        self.assertEqual(self.run_far(script, local=True)[0], 0)


if __name__ == "__main__":
    unittest.main()
