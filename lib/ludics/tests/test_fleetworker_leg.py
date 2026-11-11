"""ludics.fleetworker.leg: the near side's reading of a leg's far side (the shell suite's `execution
leg` section drives the whole verb against a fake remote)."""

import contextlib
import fcntl
import io
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import execution, farside, leg, slot
from ludics.fleetworker.config import load_config
from ludics.fleetworker.transport import UNREACHABLE, Done


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
            rc = leg.stream([bash, "-s"], script, "box", "t0k", local=local)
        return rc, out.getvalue().decode(), said.getvalue() + err.getvalue()

    def test_the_sentinel_is_the_status_and_every_line_passes_through(self) -> None:
        rc, out, _ = self.run_far("echo one\nprintf 'execution-leg t0k: exit: 125\\n'\nexit 0\n", local=False)
        self.assertEqual((rc, out), (125, "one\nexecution-leg: exit: 125\n"))

    def test_a_sentinel_after_output_with_no_newline_gets_a_line_of_its_own(self) -> None:
        rc, out, _ = self.run_far("printf partial; printf 'execution-leg t0k: exit: 255\\n'; exit 255\n", local=False)
        self.assertEqual((rc, out), (255, "partial\nexecution-leg: exit: 255\n"))

    def test_output_with_no_newline_passes_through_as_it_comes(self) -> None:
        rc, out, _ = self.run_far("head -c 300000 /dev/zero | tr '\\0' 'z'; echo 'execution-leg t0k: exit: 3'\n", local=True)
        self.assertEqual(rc, 3)
        self.assertEqual(out, "z" * 300000 + "\nexecution-leg: exit: 3\n")

    def test_only_the_far_sides_own_token_reports_a_status(self) -> None:
        # A nested leg's line, or a runner's, is output: with the connection gone before the far
        # side reported, the leg is UNREACHABLE, not the status a runner line named.
        rc, out, err = self.run_far("echo 'execution-leg: exit: 0'; echo 'execution-leg f00: exit: 0'; exit 255\n", local=False)
        self.assertEqual(rc, 4)
        self.assertEqual(out, "execution-leg: exit: 0\nexecution-leg f00: exit: 0\n")
        self.assertIn("EXECUTION LEG UNREACHABLE box:", err)

    def test_no_sentinel_is_the_far_sides_own_status_or_unreachable(self) -> None:
        self.assertEqual(self.run_far("exit 1\n", local=False)[0], 1)
        self.assertEqual(self.run_far("exit 255\n", local=True)[0], 255)
        rc, _, err = self.run_far("exit 255\n", local=False)
        self.assertEqual(rc, 4)
        self.assertIn("EXECUTION LEG UNREACHABLE box:", err)

    def test_a_script_longer_than_a_pipe_is_fed_while_the_far_side_writes(self) -> None:
        filler = "".join(f": {'x' * 70}\n" for _ in range(2000))  # ~150 KB of no-ops after the output
        script = "head -c 200000 /dev/zero | tr '\\0' 'y'; echo\n" + filler + "echo 'execution-leg t0k: exit: 0'\n"
        self.assertEqual(self.run_far(script, local=True)[0], 0)

    def test_the_far_sides_pid_line_is_consumed(self) -> None:
        # THE STOP (ludics-lite#767): kept by the leg, never output; another token's is output.
        rc, out, _ = self.run_far("echo 'execution-leg t0k: far: 4242'\necho 'execution-leg f00: far: 1'\n"
                                  "echo 'execution-leg t0k: exit: 0'\n", local=True)
        self.assertEqual((rc, out), (0, "execution-leg f00: far: 1\nexecution-leg: exit: 0\n"))


class Stop(unittest.TestCase):
    """THE STOP (ludics-lite#767): a signal to the leg while it streams ends the far side through the
    far stop, for the pid the far side reported, and the leg then raises LegStopped."""

    bash = shutil.which("bash") or "/bin/bash"

    def stream(self, script: str) -> tuple[int | None, list[str], str]:
        asked: list[str] = []

        def stop(pid: str) -> tuple[list[str], str]:
            asked.append(pid)
            return [self.bash, "-s"], "echo 'far stop ran' >&2\n"

        said, err = io.StringIO(), io.StringIO()

        class Out:
            buffer = io.BytesIO()

            def write(self, text: str) -> int:
                return said.write(text)

            def flush(self) -> None:
                pass

        before = signal.getsignal(signal.SIGTERM)
        got: int | None = None
        with contextlib.redirect_stderr(err), mock.patch.object(leg.sys, "stdout", Out()):
            try:
                leg.stream([self.bash, "-s"], script, "box", "t0k", local=True, stop=stop)
            except leg.LegStopped as why:
                got = why.signum
        self.assertEqual(signal.getsignal(signal.SIGTERM), before, "the leg's handler outlived the stream")
        return got, asked, said.getvalue() + err.getvalue()

    def test_a_term_while_streaming_runs_the_far_stop_for_the_reported_pid(self) -> None:
        got, asked, said = self.stream("echo 'execution-leg t0k: far: 4242'\nsleep 0.5\nkill -TERM $PPID\nsleep 2\n")
        self.assertEqual((got, asked), (signal.SIGTERM, ["4242"]))
        self.assertIn("EXECUTION LEG STOPPING box: SIGTERM; ending the far side (pid 4242)", said)

    def test_a_signal_before_the_pid_came_is_said_and_stops_nothing(self) -> None:
        got, asked, said = self.stream("sleep 0.5\nkill -INT $PPID\nsleep 2\n")
        self.assertEqual((got, asked), (signal.SIGINT, []))
        self.assertIn("EXECUTION LEG STOPPED box: SIGINT before the far side reported its pid", said)

    def test_a_signal_while_the_far_side_starts_is_caught(self) -> None:
        # The handlers are in before the far side is spawned: a TERM in that instant is the leg's to
        # handle, never the default disposition's. It is raised once the child is held and before
        # the script is fed, so the child is killed having run nothing.
        real = subprocess.Popen

        def popen(*args: Any, **kwargs: Any) -> Any:
            os.kill(os.getpid(), signal.SIGTERM)
            return real(*args, **kwargs)

        with mock.patch.object(leg.subprocess, "Popen", popen):
            got, asked, said = self.stream("echo 'execution-leg t0k: far: 4242'\nsleep 2\n")
        self.assertEqual((got, asked), (signal.SIGTERM, []))
        self.assertIn("EXECUTION LEG STOPPED box: SIGTERM before the far side reported its pid", said)

    def test_a_signal_inside_popen_after_the_spawn_ends_the_unfed_child(self) -> None:
        # The child exists, Popen has not returned: the signal is noted, raised once the leg holds the
        # child, before its script is fed, and the child is killed, never left to run the leg.
        real = subprocess.Popen
        spawned: list[Any] = []

        def popen(*args: Any, **kwargs: Any) -> Any:
            child = real(*args, **kwargs)
            spawned.append(child)
            os.kill(os.getpid(), signal.SIGTERM)
            return child

        with mock.patch.object(leg.subprocess, "Popen", popen):
            got, asked, _ = self.stream("echo 'execution-leg t0k: far: 4242'\nsleep 2\n")
        self.assertEqual((got, asked), (signal.SIGTERM, []))
        self.assertEqual(spawned[0].wait(timeout=10), -signal.SIGKILL)

    def test_a_pid_line_still_in_the_pipe_is_read_before_the_stop(self) -> None:
        # The far side has written its pid and gone on, but the leg has not read the line yet when
        # the signal lands: the stop still names that pid, never kills the far shell alone.
        real = threading.Thread
        fired: list[bool] = []

        class Thread(real):
            def start(self) -> None:
                super().start()
                if not fired:
                    fired.append(True)
                    time.sleep(0.5)
                    os.kill(os.getpid(), signal.SIGTERM)

        with mock.patch.object(leg.threading, "Thread", Thread):
            got, asked, said = self.stream("echo 'execution-leg t0k: far: 4242'\nsleep 2\n")
        self.assertEqual((got, asked), (signal.SIGTERM, ["4242"]))
        self.assertIn("ending the far side (pid 4242)", said)

    def far_stop(self, pid: int, token: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([self.bash, "-s", str(pid), token, "10"], input="BOX=box\n" + leg.STOP,
                              capture_output=True, text=True, timeout=60)

    def test_the_far_stop_ends_the_wrapper_and_the_far_shell_winds_down(self) -> None:
        # A far shell as LEG runs it: TERM deferred by its trap while its `execution slot` child runs.
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            far = ("trap 's=1' TERM\n"
                   "bash -c 'trap \"exit 143\" TERM; while :; do sleep 0.1; done' wrapper execution slot\n"
                   'echo "wrapper=$? s=$s" > "$1"\n')
            proc = subprocess.Popen([self.bash, "-c", far, "far", out, "t0kfar"])
            try:
                time.sleep(0.5)
                done = self.far_stop(proc.pid, "t0kfar")
                proc.wait(timeout=30)
            finally:
                if proc.poll() is None:
                    subprocess.run(["pkill", "-P", str(proc.pid)], check=False)
                    proc.kill()
                    proc.wait()
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("SIGTERM to the leg's wrapper", done.stderr)
            self.assertIn(f"the leg (pid {proc.pid}) has ended", done.stderr)
            self.assertEqual(Path(out).read_text(), "wrapper=143 s=1\n")

    def test_the_far_stop_ends_what_left_the_wrappers_group(self) -> None:
        # THE ESCAPED (ludics-lite#816): the runner's child in a group of its own, as test-run.sh
        # runs dune, survives the wrapper's end; the far stop ends it once the far shell has ended.
        with tempfile.TemporaryDirectory() as tmp:
            esc = os.path.join(tmp, "esc")
            wrapper = ("perl -e 'setpgrp(0, 0); exec qw(sleep 120)' & echo $! > \"$0\"; "
                       "trap 'exit 143' TERM; while :; do sleep 0.1; done")
            far = ("trap 's=1' TERM\n"
                   f"bash -c {shlex.quote(wrapper)} {shlex.quote(esc)} execution slot\n"
                   "echo \"wrapper=$?\"\n")
            proc = subprocess.Popen([self.bash, "-c", far, "far", "t0kesc"])
            pid = 0
            try:
                for _ in range(100):
                    if os.path.exists(esc) and os.path.getsize(esc):
                        break
                    time.sleep(0.1)
                pid = int(Path(esc).read_text())
                time.sleep(0.3)
                done = self.far_stop(proc.pid, "t0kesc")
                proc.wait(timeout=30)
                gone = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertIn(f"its run left process(es) {pid} running, which the wrapper's group kill did not reach",
                              done.stderr)
                self.assertIn(f"the leg's run has ended: process(es) {pid} too (TERM)", done.stderr)
                self.assertFalse(gone.stdout.strip() and not gone.stdout.strip().startswith("Z"),
                                 f"the escaped {pid} still runs: {done.stderr}")
            finally:
                if proc.poll() is None:
                    subprocess.run(["pkill", "-P", str(proc.pid)], check=False)
                    proc.kill()
                    proc.wait()
                if pid:
                    with contextlib.suppress(OSError):
                        os.kill(pid, signal.SIGKILL)

    def test_a_pid_that_no_longer_carries_the_token_is_left_alone(self) -> None:
        proc = subprocess.Popen(["sleep", "5"])
        try:
            done = self.far_stop(proc.pid, "t0kfar")
            self.assertEqual(done.returncode, 0)
            self.assertIn("nothing was signalled", done.stderr)
            self.assertIsNone(proc.poll())
        finally:
            proc.kill()
            proc.wait()


class RecordCheckout(unittest.TestCase):
    """THE RECORD'S CHECKOUT (ludics-lite#749): a record that names a checkout refuses another
    --worktree, lexically, before anything reaches the box."""

    def run_leg(self, worktree: str, checkout: str | None) -> tuple[int, str, mock.Mock]:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh", {"FLEET_LOCAL_BOX": "agent"}, host="agent")
        record = standing(state="launching")
        if checkout is not None:
            record["checkout"] = checkout
        out = io.StringIO()
        streamed = mock.Mock(return_value=0)
        with mock.patch.object(leg, "stream", streamed), contextlib.redirect_stdout(out):
            rc = leg.run_leg(cfg, "it", record, [], ["tools/check.sh"], "testbox", "/h/co", worktree, "origin", "main", "", "300")
        return rc, out.getvalue(), streamed

    def test_another_worktree_is_refused_naming_the_recorded_one(self) -> None:
        # THE PATHS (execution.py): the path is printed as one shell word, quoted where it needs it.
        for worktree, shown in [("/h/wts/other", "/h/wts/other"), ("/h/wts/w1/..", "/h/wts/w1/.."),
                                ("~/wts/w1", "'~/wts/w1'"), ("/h/wts/w1\\", "'/h/wts/w1\\'"),
                                ("/h/wts/w 1", "'/h/wts/w 1'")]:
            with self.subTest(worktree=worktree):
                rc, said, streamed = self.run_leg(worktree, "/h/wts/w1")
                self.assertEqual(rc, 1)
                self.assertEqual(said, f"EXECUTION LEG REFUSED: --worktree {shown} is not it's recorded checkout /h/wts/w1"
                                       " on testbox (ludics-lite#749: a leg moves only its own record's worktree); nothing ran\n")
                streamed.assert_not_called()

    def test_the_recorded_one_or_no_record_checkout_runs(self) -> None:
        for worktree, checkout in [("/h/wts/w1", "/h/wts/w1"), ("/h/wts/w1/", "/h/wts/w1"), ("/h/wts/w1", "/h/wts/w1//"),
                                   ("/anywhere", None)]:
            with self.subTest(worktree=worktree, checkout=checkout):
                rc, _, streamed = self.run_leg(worktree, checkout)
                self.assertEqual(rc, 0)
                streamed.assert_called_once()


class BackendPin(unittest.TestCase):
    """THE BACKEND PIN (ludics-lite#766): .github/fleet-leg's grammar, and which argv pins."""

    bash = shutil.which("bash") or "/bin/bash"
    PINS = "# pins\n\npin-flag --expect-backend\npin-env OCANNL_BACKEND\n"

    def pin(self, text: str, gpu: str, *argv: str) -> tuple[int, str]:
        done = subprocess.run([self.bash, "-c", leg.PIN + 'backend_pin "$@"', "x", text, gpu, *argv],
                              capture_output=True, text=True)
        return done.returncode, done.stdout

    def test_a_pinned_or_cpu_leg_runs(self) -> None:
        for gpu, argv in [("0", ["tools/t.sh", "run"]),
                          ("1", ["tools/t.sh", "run", "--expect-backend", "cuda"]),
                          ("1", ["tools/t.sh", "run", "--expect-backend=hip", "@runtest"]),
                          ("1", ["env", "OCANNL_BACKEND=cuda", "tools/t.sh", "bisect", "a", "b"]),
                          ("1", ["env", "X=1", "OCANNL_BACKEND=metal", "tools/t.sh"]),
                          ("1", ["env", "OTHER=", "OCANNL_BACKEND=cuda", "tools/t.sh"]),
                          ("1", ["env", "OCANNL_BACKEND=", "OCANNL_BACKEND=hip", "tools/t.sh"]),
                          # ludics#864: a leading env pin carries a shell composite.
                          ("1", ["env", "OCANNL_BACKEND=cuda", "bash", "-c", "tools/t.sh run $(cat list)"])]:
            with self.subTest(gpu=gpu, argv=argv):
                self.assertEqual(self.pin(self.PINS, gpu, *argv), (0, ""))

    def test_an_unpinned_gpu_leg_is_refused_naming_the_pins(self) -> None:
        for argv in [["tools/t.sh", "run"], ["tools/t.sh", "run", "--expect-backend"],
                     ["tools/t.sh", "run", "--expect-backend="], ["tools/t.sh", "--", "--expect-backend", "cuda"],
                     ["tools/t.sh", "OCANNL_BACKEND=cuda"], ["env", "OCANNL_BACKEND=", "tools/t.sh"],
                     ["env", "tools/t.sh", "OCANNL_BACKEND=cuda"],
                     ["env", "OCANNL_BACKEND=cuda", "OCANNL_BACKEND=", "tools/t.sh"],
                     ["env", "OCANNL_BACKEND=cuda"], ["env", "X=1", "OCANNL_BACKEND=cuda"],
                     ["env", "OCANNL_BACKEND=cuda", "1=x"], ["env", "OCANNL_BACKEND=cuda", "a-b=c", "=d"]]:
            with self.subTest(argv=argv):
                rc, why = self.pin(self.PINS, "1", *argv)
                self.assertEqual(rc, 1)
                self.assertEqual(why, "this leg may hold the GPU (no --cpu), but its runner pins no backend, and"
                                      " .github/fleet-leg asks for one of: --expect-backend <backend>,"
                                      " env OCANNL_BACKEND=<backend>; pin it (as words of the runner's own argv);"
                                      " or declare --cpu for a leg that holds no GPU, or --reads-no-config for a runner that"
                                      " reads none of the project's configuration")

    def test_a_shell_composite_is_refused_naming_the_form_that_carries_its_pin(self) -> None:
        # ludics#864 (gh-ocannl-1687): the pin inside the -c string is one word to the reader.
        for argv, shell in [(["bash", "-c", "OCANNL_BACKEND=cuda tools/t.sh run --expect-backend cuda"], "bash"),
                            (["/bin/sh", "-ec", "tools/t.sh run --expect-backend cuda"], "sh"),
                            (["zsh", "-c", "tools/t.sh"], "zsh")]:
            with self.subTest(argv=argv):
                rc, why = self.pin(self.PINS, "1", *argv)
                self.assertEqual(rc, 1)
                self.assertIn(f"; pin it (as words of the runner's own argv); a pin inside a {shell} -c string is no"
                              f" word of the argv: lead with it, env OCANNL_BACKEND=<backend> {shell} -c '...', or give"
                              " the runner a long list as a file, --file <local file> and the runner word {file}; or"
                              " declare --cpu", why)
        rc, why = self.pin("pin-flag --expect-backend\n", "1", "bash", "-c", "tools/t.sh --expect-backend cuda")
        self.assertEqual(rc, 1)
        self.assertIn("a pin inside a bash -c string is no word of the argv: run the runner itself, its pin among its"
                      " words, and give it a long list as a file", why)
        # A shell given a script file, or a long option, is no -c composite: the plain refusal.
        for argv in [["bash", "tools/t.sh"], ["bash", "--norc", "tools/t.sh"]]:
            with self.subTest(argv=argv):
                self.assertNotIn(" -c string", self.pin(self.PINS, "1", *argv)[1])

    def test_a_file_with_no_pin_asks_for_none(self) -> None:
        self.assertEqual(self.pin("# nothing yet\n", "1", "tools/t.sh"), (0, ""))
        self.assertEqual(self.pin("", "1", "tools/t.sh"), (0, ""))

    def test_a_slot_plan_line_is_read_and_asks_for_no_pin(self) -> None:
        for line in ["slot-plan tools/fleet-slot-plan.sh", "slot-plan plan", "slot-plan a.b/c-d_e/f"]:
            with self.subTest(line=line):
                self.assertEqual(self.pin(f"{line}\n", "1", "tools/t.sh"), (0, ""))
                self.assertEqual(self.pin(f"{self.PINS}{line}\n", "0", "tools/t.sh"), (0, ""))
        done = subprocess.run([self.bash, "-c", leg.PIN + 'pin_grammar "$1" && printf "[%s]" "$pin_plan"', "x",
                               f"{self.PINS}slot-plan tools/p.sh\n"], capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stdout), (0, "[tools/p.sh]"))

    def test_a_run_report_line_is_read_and_asks_for_no_pin(self) -> None:
        """ludics#829: THE RUN REPORT's path, by the slot plan's grammar, at most one."""
        self.assertEqual(self.pin("run-report tools/report.sh\n", "1", "tools/t.sh"), (0, ""))
        done = subprocess.run([self.bash, "-c", leg.PIN + 'pin_grammar "$1" && printf "[%s][%s]" "$pin_plan" "$pin_report"', "x",
                               f"{self.PINS}slot-plan tools/p.sh\nrun-report tools/r.sh\n"], capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stdout), (0, "[tools/p.sh][tools/r.sh]"))
        for line in ["run-report", "run-report /abs/r", "run-report ../r", "run-report a/./r", "run-report -r",
                     "run-report a b", "run-report a$b"]:
            with self.subTest(line=line):
                rc, why = self.pin(f"# ok\n{line}", "0", "tools/t.sh")
                self.assertEqual(rc, 1)
                self.assertTrue(why.startswith(f".github/fleet-leg line 2 is not one the fleet reads ({line})"), why)
        rc, why = self.pin("run-report p\nrun-report q\n", "0", "tools/t.sh")
        self.assertEqual(rc, 1)
        self.assertIn("line 2 is not one the fleet reads (run-report q)", why)

    def test_a_fail_lines_line_is_one_command_as_written(self) -> None:
        """ludics#1040: THE FAILING LINES' command, the rest of its line, at most one."""
        def read(text: str) -> tuple[int, str]:
            done = subprocess.run([self.bash, "-c", leg.PIN + 'pin_grammar "$1" && printf "[%s]" "$pin_fail"', "x", text],
                                  capture_output=True, text=True)
            return done.returncode, done.stdout
        cmd = """grep -E 'FAIL:|: false'  "$(tools/t.sh paths run last)/log" # its   own"""
        for line in [f"fail-lines {cmd}", f"  fail-lines \t {cmd} \t ", f"fail-lines\t{cmd}"]:
            with self.subTest(line=line):
                self.assertEqual(read(f"{self.PINS}{line}\nrun-report tools/r.sh\n"), (0, f"[{cmd}]"))
                self.assertEqual(self.pin(f"{line}\n", "1", "tools/t.sh"), (0, ""))
        self.assertEqual(read(self.PINS), (0, "[]"))
        # (A CR comes back as a newline: the output is read in text mode.)
        for text, bad in [("fail-lines\n", "(fail-lines): "), ("fail-lines   \n", "(fail-lines): "),
                          ("fail-lines a\nfail-lines b\n", "line 2 is not one the fleet reads (fail-lines b): "),
                          ("fail-lines grep x log\r\n", "(fail-lines grep x log\n): "), ("fail-linesx y\n", "(fail-linesx y): ")]:
            with self.subTest(text=text):
                rc, why = self.pin(text, "0", "tools/t.sh")
                self.assertEqual(rc, 1)
                self.assertIn(bad, why)

    def test_project_floor_is_whole_unique_and_parsed_even_for_cpu(self) -> None:
        for value in ["0", "30", "00030", "999999999999999999999999"]:
            self.assertEqual(self.pin(f"min-free-gib {value}\n", "0", "true"), (0, ""))
        for line in ["min-free-gib", "min-free-gib -1", "min-free-gib 1.5", "min-free-gib lots",
                     "min-free-gib 30 extra", "min-free-gib 30 # comment", "min-free-gib 0\nmin-free-gib 30"]:
            with self.subTest(line=line):
                rc, why = self.pin(line, "0", "true")
                self.assertEqual(rc, 1)
                self.assertIn("not one the fleet reads", why)

    def test_a_line_the_leg_cannot_read_refuses_even_a_cpu_leg(self) -> None:
        for line in ["pin-flagg --x", "pin-flag", "pin-flag x", "pin-flag --", "pin-flag --x=y", "pin-flag --x # c",
                     "pin-env 9X", "pin-env A-B", "pin-env", "slot-plan", "slot-plan /abs/p", "slot-plan ../p",
                     "slot-plan a/../p", "slot-plan ./p", "slot-plan a/./p", "slot-plan a//p", "slot-plan a/",
                     "slot-plan -p", "slot-plan a b", "slot-plan a$b", "slot-plan ..", "slot-plan a/.."]:
            with self.subTest(line=line):
                rc, why = self.pin(f"# ok\n{line}", "0", "tools/t.sh")
                self.assertEqual(rc, 1)
                self.assertTrue(why.startswith(f".github/fleet-leg line 2 is not one the fleet reads ({line})"), why)
        rc, why = self.pin("slot-plan p\nslot-plan q\n", "0", "tools/t.sh")
        self.assertEqual(rc, 1)
        self.assertEqual(why, ".github/fleet-leg line 2 is not one the fleet reads (slot-plan q): pin-flag <option>,"
                              " pin-env <NAME>, one slot-plan <path in the worktree>, one run-report <path in the worktree>, one fail-lines <shell command>, one min-free-gib <GiB>, a # comment"
                              " or a blank line")


class FailingLines(unittest.TestCase):
    """THE FAILING LINES (ludics#1040): the far side's runs script copies a failed run's fail-lines
    output back, bounded by bytes and lines; a passing run, and a project that declares none, copy
    nothing. The script is LEG's own, cut out of it, with an `execution slot` that runs its command."""

    bash = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash") or "bash"  # 3.2 on macOS

    def runs(self, fail: str, *runner: str) -> tuple[int, str]:
        script = leg.LEG.split("<<'FLEET_LEG_RUNS'", 1)[1].split("\n", 1)[1].split("\nFLEET_LEG_RUNS\n", 1)[0]
        with tempfile.TemporaryDirectory() as d:
            fw = Path(d, "fw")
            # The nested slot, for this test: its own words dropped through `--`, the command exec'd.
            fw.write_text('#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n')
            fw.chmod(0o755)
            wt = Path(d, "wt")
            wt.mkdir()
            Path(wt, "log").write_text("ok: true\nFAIL: claim one\nnoise\nx: false\n")
            results = Path(d, "results")
            results.write_text("")
            done = subprocess.run([self.bash, "-c", script, "x", str(wt), "", str(results), "testbox", str(fw), "h", "",
                                   fail, "2", "--deadline", "30", *runner], capture_output=True, text=True)
            self.assertEqual(sorted(p.name for p in Path(d).iterdir()), ["fw", "results", "wt"])
            return done.returncode, done.stderr

    def block(self, err: str) -> list[str]:
        lines = err.splitlines()
        start = [i for i, x in enumerate(lines) if x.startswith("EXECUTION LEG testbox: failing lines ")]
        end = [i for i, x in enumerate(lines) if x.startswith("EXECUTION LEG testbox: end of the failing lines ")]
        self.assertEqual((len(start), len(end)), (1, 1), err)
        return lines[start[0]:end[0] + 1]

    def test_a_failed_run_copies_back_its_declared_lines(self) -> None:
        rc, err = self.runs("""grep -E 'FAIL:|: false' log; printf 'argv:'; printf ' [%s]' "$@"; echo; echo to-stderr >&2""",
                            "sh", "-c", "exit 3", "a b")
        self.assertEqual(rc, 3)
        self.assertEqual(self.block(err), [
            "EXECUTION LEG testbox: failing lines (fail-lines in .github/fleet-leg) after the main run (exit 3),"
            " their command exit 0, 4 line(s):",
            "FAIL: claim one", "x: false", "argv: [sh] [-c] [exit 3] [a b]", "to-stderr",
            "EXECUTION LEG testbox: end of the failing lines (main run)"])

    def test_its_command_status_is_said_and_the_runs_stands(self) -> None:
        rc, err = self.runs("grep -E 'no such claim' log", "false")
        self.assertEqual(rc, 1)
        self.assertIn("after the main run (exit 1), their command exit 1, 0 line(s):", err)

    def test_a_passing_run_or_no_declaration_copies_nothing(self) -> None:
        for fail, runner in [("grep FAIL log", ["true"]), ("", ["false"]), ("", ["true"])]:
            with self.subTest(fail=fail, runner=runner):
                rc, err = self.runs(fail, *runner)
                self.assertEqual(rc, 0 if runner == ["true"] else 1)
                self.assertNotIn("failing lines", err)

    def test_a_runner_that_never_started_copies_nothing(self) -> None:
        rc, err = self.runs("grep FAIL log", "no-such-runner-1040")
        self.assertEqual(rc, 127)
        self.assertNotIn("failing lines", err)

    def test_the_copy_is_bounded_by_lines_and_bytes_and_says_so(self) -> None:
        rc, err = self.runs("i=0; while [ $i -lt 250 ]; do i=$((i + 1)); echo \"FAIL: claim $i\"; done", "false")
        self.assertEqual(rc, 1)
        got = self.block(err)
        total = sum(len(f"FAIL: claim {i}\n") for i in range(1, 251))
        shown = sum(len(f"FAIL: claim {i}\n") for i in range(1, 101))
        self.assertEqual(got[0], "EXECUTION LEG testbox: failing lines (fail-lines in .github/fleet-leg) after the main"
                                 f" run (exit 1), their command exit 0, TRUNCATED to the first 100 of its 250 line(s),"
                                 f" {shown} of its {total} bytes:")
        self.assertEqual(got[1:-1], [f"FAIL: claim {i}" for i in range(1, 101)])
        self.assertEqual(got[-1], f"EXECUTION LEG testbox: end of the failing lines (main run; TRUNCATED: {total - shown}"
                                  " byte(s) not copied)")
        # One line past the byte bound is cut there, and the closing line still stands on its own.
        rc, err = self.runs("printf 'FAIL: %s\\n' \"$(head -c 20000 /dev/zero | tr '\\0' x)\"; echo 'FAIL: after'", "false")
        got = self.block(err)
        self.assertEqual(got[0].rsplit(", ", 2)[1:], ["TRUNCATED to the first 1 of its 2 line(s)", "16384 of its 20019 bytes:"])
        self.assertEqual(got[1:-1], ["FAIL: " + "x" * (16384 - 6)])
        self.assertEqual(got[-1], "EXECUTION LEG testbox: end of the failing lines (main run; TRUNCATED: 3635 byte(s) not copied)")


class BackendPinTo(unittest.TestCase):
    """backend_pin_to (ludics-lite#793, tip-run's GPU-loop check): the same file and argv reading as
    backend_pin, but the command must pin the named backend and nothing else."""

    bash = shutil.which("bash") or "/bin/bash"
    PINS = BackendPin.PINS

    def pin(self, text: str, backend: str, *argv: str) -> tuple[int, str]:
        done = subprocess.run([self.bash, "-c", leg.PIN + 'backend_pin_to "$@"', "x", text, backend, *argv],
                              capture_output=True, text=True)
        return done.returncode, done.stdout

    def test_a_command_pinning_the_backend_runs(self) -> None:
        for argv in [["env", "OCANNL_BACKEND=cuda", "tools/t.sh", "run", "build", "@runtest"],
                     ["tools/t.sh", "run", "--expect-backend", "cuda"],
                     ["tools/t.sh", "run", "--expect-backend=cuda"],
                     ["env", "OCANNL_BACKEND=cuda", "tools/t.sh", "run", "--expect-backend", "cuda"],
                     ["env", "OCANNL_BACKEND=hip", "OCANNL_BACKEND=cuda", "tools/t.sh"],
                     ["tools/t.sh", "--expect-backend", "cuda", "--", "--expect-backend", "hip"]]:
            with self.subTest(argv=argv):
                self.assertEqual(self.pin(self.PINS, "cuda", *argv), (0, ""))

    def test_an_unpinned_command_is_refused_naming_the_pins(self) -> None:
        for argv in [["tools/t.sh", "run", "--test-cap", "0", "build", "@runtest", "@train"],
                     ["sh", "-c", "OCANNL_BACKEND=cuda tools/t.sh"], ["env", "OCANNL_BACKEND=cuda"],
                     ["env", "OCANNL_BACKEND=cuda", "OCANNL_BACKEND=", "tools/t.sh"]]:
            with self.subTest(argv=argv):
                self.assertEqual(self.pin(self.PINS, "cuda", *argv),
                                 (1, "this run is the cuda backend's, but its command pins no backend, and .github/fleet-leg"
                                     " asks for one of: --expect-backend <backend>, env OCANNL_BACKEND=<backend>; pin cuda"
                                     " (as words of the command's own argv)"))

    def test_a_command_pinning_another_backend_is_refused_naming_it(self) -> None:
        for argv, how in [(["env", "OCANNL_BACKEND=hip", "tools/t.sh"], "OCANNL_BACKEND=hip"),
                          (["env", "OCANNL_BACKEND=cc", "tools/t.sh"], "OCANNL_BACKEND=cc"),
                          (["env", "OCANNL_BACKEND=CUDA", "tools/t.sh"], "OCANNL_BACKEND=CUDA"),
                          (["tools/t.sh", "--expect-backend", "hip"], "--expect-backend hip"),
                          (["env", "OCANNL_BACKEND=cuda", "tools/t.sh", "--expect-backend=hip"], "--expect-backend=hip"),
                          (["tools/t.sh", "--expect-backend", "cuda", "--expect-backend", "cc"], "--expect-backend cc")]:
            with self.subTest(argv=argv):
                self.assertEqual(self.pin(self.PINS, "cuda", *argv),
                                 (1, f"this run is the cuda backend's, but its command pins another ({how})"))

    def test_a_file_with_no_pin_cannot_check_it(self) -> None:
        for text in ["", "# nothing yet\n"]:
            with self.subTest(text=text):
                rc, why = self.pin(text, "hip", "env", "OCANNL_BACKEND=hip", "tools/t.sh")
                self.assertEqual(rc, 1)
                self.assertIn("names no pin-flag or pin-env, so whether its command selects hip cannot be checked", why)

    def test_a_line_it_cannot_read_refuses(self) -> None:
        rc, why = self.pin("pin-env 9X", "cuda", "env", "OCANNL_BACKEND=cuda", "tools/t.sh")
        self.assertEqual(rc, 1)
        self.assertTrue(why.startswith(".github/fleet-leg line 1 is not one the fleet reads (pin-env 9X)"), why)



def standing(state: str = "suspended", by: str = "w1") -> dict[str, Any]:
    record: dict[str, Any] = {
        "request_id": "it", "coordinator": "coord", "state": state, "created_at": "2026-10-18T00:00:00+00:00",
        "request": {"execution_host": "testbox", "kind": "correctness", "standing": True, "worker": "w", "issue": "o/r#1"},
    }
    if state == "suspended":
        record.update(suspended_by=by, suspended_from="launching")
    return record


def window(identity: str, state: str = "launching") -> dict[str, Any]:
    return {"request_id": identity, "coordinator": "coord", "state": state, "window": True,
            "created_at": "2026-10-18T00:00:00+00:00",
            "request": {"execution_host": "testbox", "kind": "measurement", "worker": "m", "issue": "o/r#2"}}


class WindowWait(unittest.TestCase):
    """THE WINDOW WAIT (ludics-lite#666): a leg whose standing record a window suspended waits for it
    under --wait-window in the slot's own wait, the registry re-reads stubbed in order."""

    def wait(self, reads: list[Any], flags: list[str], first: list[dict[str, Any]] | None = None
             ) -> tuple[dict[str, Any] | int, str, str, int]:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "agent", "FLEET_SLOT_WINDOW_POLL": "0.01"}, host="agent")
        records = first if first is not None else [standing(), window("w1")]
        out, err = io.StringIO(), io.StringIO()
        reader = mock.Mock(side_effect=reads)
        with mock.patch.object(slot, "read_registry", reader), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = leg.await_window(cfg, "it", records[0], records, flags, ["tools/check.sh"])
        return result, out.getvalue(), err.getvalue(), reader.call_count

    def test_without_wait_window_it_is_refused_at_once_naming_the_window(self) -> None:
        result, out, _, reads = self.wait([], ["--cpu"])
        self.assertEqual((result, reads), (1, 0))
        self.assertEqual(out, "EXECUTION LEG REFUSED: it is suspended by measurement window w1; run the leg once that"
                              " window concludes, or give it --wait-window, which waits for it\n")

    def test_a_window_that_closes_inside_the_bound_lets_the_leg_run(self) -> None:
        restored = [standing("launching"), window("w1", "concluded")]
        result, out, err, _ = self.wait([[standing(), window("w1")], restored], ["--cpu", "--wait-window=30", "--wait", "0"])
        assert isinstance(result, dict)
        self.assertEqual((result["state"], out), ("launching", ""))
        self.assertIn("EXECUTION LEG testbox: measurement window w1 holds testbox (coordinator coord; m for o/r#2;", err)
        self.assertIn("EXECUTION LEG testbox: waiting up to 30s (--wait-window) for it to conclude, then for a slot,"
                      " for: tools/check.sh", err)
        self.assertIn("EXECUTION LEG testbox: no measurement holds testbox after 0s; running the leg", err)

    def test_a_window_opened_mid_wait_is_waited_for_too(self) -> None:
        # The coordinator's back-to-back windows: w1 concludes and w2 suspends the record again
        # between two reads, so the leg never sees it restored until w2 concludes.
        second = [standing(by="w2"), window("w1", "concluded"), window("w2")]
        restored = [standing("launching"), window("w1", "concluded"), window("w2", "concluded")]
        result, out, err, reads = self.wait([[standing(), window("w1")], second, second, restored], ["--wait-window"])
        assert isinstance(result, dict)
        self.assertEqual((result["state"], out, reads), ("launching", "", 4))
        self.assertIn("measurement window w1 holds testbox", err)
        self.assertIn("measurement window w2 holds testbox", err)

    def test_a_window_that_outlasts_the_bound_is_refused_as_the_slot_refuses_naming_it(self) -> None:
        result, out, err, reads = self.wait([[standing(), window("w1")]], ["--wait-window=0"])
        self.assertEqual((result, reads), (1, 0))
        self.assertEqual(out, "EXECUTION LEG REFUSED testbox: measurement w1 still holds testbox after 0s"
                              " (--wait-window); nothing ran\n")
        self.assertIn("measurement window w1 holds testbox", err)

    def test_a_read_torn_by_the_conclusion_is_waited_past(self) -> None:
        # The conclusion restores the record, then concludes the window, file by file: a listing
        # between the two shows the window concluded beside the record still suspended.
        torn = [standing(), window("w1", "concluded")]
        restored = [standing("launching"), window("w1", "concluded")]
        result, out, err, reads = self.wait([torn, restored], ["--wait-window=30"])
        assert isinstance(result, dict)
        self.assertEqual((result["state"], out, reads), ("launching", "", 2))
        self.assertEqual(err.count("measurement window w1 holds testbox"), 1)

    def test_a_record_the_registry_never_restores_is_refused_at_the_bound_naming_its_window(self) -> None:
        stuck = [standing(), window("w1", "concluded")]
        result, out, _, _ = self.wait([stuck] * 10000, ["--wait-window=1"])
        self.assertEqual(result, 1)
        self.assertEqual(out, "EXECUTION LEG REFUSED testbox: measurement w1 still holds testbox after 1s"
                              " (--wait-window); nothing ran\n")

    def test_a_suspending_window_absent_from_a_read_is_waited_for_by_its_id(self) -> None:
        # The opening's torn read: the record already suspended, the window not yet listed.
        unlisted = [standing(by="w2"), window("w1", "concluded")]
        restored = [standing("launching"), window("w1", "concluded"), window("w2", "concluded")]
        result, out, err, reads = self.wait([unlisted, [standing(by="w2"), window("w2")], restored],
                                            ["--wait-window=30"], first=unlisted)
        assert isinstance(result, dict)
        self.assertEqual((result["state"], out, reads), ("launching", "", 3))
        self.assertIn("EXECUTION LEG testbox: measurement window w2 holds testbox (its record is not in this read of"
                      " the registry)", err)

    def test_a_suspension_the_registry_never_ends_is_refused_at_the_bound_naming_its_window(self) -> None:
        orphan = [standing(by="w9"), window("w1", "concluded")]
        result, out, _, _ = self.wait([orphan] * 10000, ["--wait-window=1"], first=orphan)
        self.assertEqual(result, 1)
        self.assertEqual(out, "EXECUTION LEG REFUSED testbox: measurement w9 still holds testbox after 1s"
                              " (--wait-window); nothing ran\n")

    def test_a_reservation_concluded_mid_window_ends_the_wait_at_once(self) -> None:
        # A worker handing back mid-window: the window is still open, but nothing will restore
        # the record, so the wait ends and the leg refuses it as not dispatched.
        handed_back = [standing("concluded"), window("w1")]
        result, out, err, reads = self.wait([handed_back], ["--wait-window=30"])
        assert isinstance(result, dict)
        self.assertEqual((result["state"], out, reads), ("concluded", "", 1))
        # ludics#710: the window still holds the box and the leg will not run, so the wait never
        # says the box is free and the leg runs.
        self.assertIn("measurement window w1 holds testbox", err)
        self.assertNotIn("no measurement holds", err)
        self.assertNotIn("running the leg", err)

    def test_a_concluded_reservation_is_refused_by_the_leg_after_the_wait(self) -> None:
        # The whole verb, from the read that finds the record suspended to its refusal (ludics#710).
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "testbox", "FLEET_SLOT_WINDOW_POLL": "0.01"}, host="testbox")
        first = json.dumps([standing(), window("w1")])
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(execution, "listing", mock.Mock(return_value=Done(0, first))), \
                mock.patch.object(slot, "read_registry", mock.Mock(side_effect=[[standing("concluded"), window("w1")]])), \
                mock.patch.object(slot, "release_waiter"), mock.patch.object(leg, "run_leg", wraps=leg.run_leg) as ran, \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = leg.leg_command(cfg, ["--request", "it", "--rev", "main", "--checkout", "/c", "--worktree", "/w",
                                       "--wait-window=30", "--", "tools/check.sh"])
        self.assertEqual((rc, out.getvalue()), (1, "EXECUTION LEG REFUSED: it is concluded, not dispatched (launching,"
                                                   " running or uncertain); nothing ran\n"))
        self.assertEqual(ran.call_count, 1)
        self.assertNotIn("running the leg", err.getvalue())

    def test_an_unreachable_anchor_is_said_in_the_legs_voice(self) -> None:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh",
                          {"FLEET_LOCAL_BOX": "agent", "FLEET_ANCHOR": "far-anchor"}, host="agent")
        with mock.patch.object(slot, "listing", mock.Mock(return_value=Done(UNREACHABLE, ""))):
            unread = slot.read_registry(cfg, "testbox", leg.LEG_VOICE)
        assert isinstance(unread, slot.Unread)
        self.assertEqual(unread.rc, 4)
        self.assertEqual(unread.lines[0], "EXECUTION LEG UNREACHABLE far-anchor: registry unread, nothing ran")
        self.assertTrue(unread.lines[1].startswith("EXECUTION LEG UNREACHABLE far-anchor: a box woken"))

    def test_a_record_gone_from_the_registry_after_the_wait_is_refused(self) -> None:
        result, out, err, _ = self.wait([[window("w1", "concluded")]], ["--wait-window=30"])
        self.assertEqual(result, 1)
        self.assertIn("EXECUTION LEG REFUSED: unknown request_id it after waiting for window w1", out)
        self.assertNotIn("running the leg", err)  # ludics#710

    def test_the_bound_is_the_last_wait_window_given(self) -> None:
        self.assertIsNone(leg.window_bound(["--cpu", "--wait", "5"]))
        # A bare flag is the window's own deadline (ludics-lite#737), never a fixed hour.
        self.assertEqual(leg.window_bound(["--wait-window"]), slot.BY_DEADLINE)
        self.assertEqual(leg.window_bound(["--wait-window=90", "--wait-window=7"]), 7)
        self.assertEqual(leg.window_bound(["--wait-window=7", "--wait-window"]), slot.BY_DEADLINE)
        self.assertEqual(leg.window_bound(["--wait-window", "--wait-window=3600"]), 3600)


HINT = ": a ~ expanded by the caller's shell? spell far-side paths absolutely, or quote '~/...'"


def leg_args(co: str, wt: str, *, remote: str = "origin", rev: str = "main", want: str = "", pname: str = "",
             request: str = "req", fetch_timeout: str = "5", token: str = "t0k", fname: str = "", no_config: str = "0",
             min_free: str = "0", base: str = "", wrap: tuple[str, ...] = (), nest: tuple[str, ...] = (),
             runner: tuple[str, ...] = ("true",)) -> list[str]:
    """The far side's positional arguments, in ``leg.LEG``'s order (the list ``run_leg`` sends), with
    a test's defaults: the next argument it takes is added here, not in every test that runs it."""
    return [co, wt, remote, rev, want, pname, request, fetch_timeout, token, fname, no_config, min_free, base,
            str(len(wrap)), *wrap, str(len(nest)), *nest, *runner]


class ForeignHome(unittest.TestCase):
    """A far-side path under a home directory that is not the box's (ludics-lite#669): the trace of
    a `~` the caller's shell expanded on another box, which the refusal names as such."""

    bash = shutil.which("bash") or "/bin/bash"

    def hint(self, home: str, path: str) -> str:
        script = "BOX=box\n" + leg.NOT_HOME + 'not_home "$1"\n'
        done = subprocess.run([self.bash, "-c", script, "x", path], env={**os.environ, "HOME": home},
                              capture_output=True, text=True, check=True)
        return done.stdout

    def test_a_checkout_under_another_boxs_home_is_refused_saying_why(self) -> None:
        # The whole far side, to its first refusal: rog's /home/<user> reaching a box whose home is
        # /Users/<user>. The refusal's first words are unchanged; the hint follows them.
        root = Path(leg.__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as state:
            script = f"STATE={shlex.quote(state)}\nSKILLS_REPO={shlex.quote(str(root))}\nBOX=box\n" + farside.HELPERS + leg.LEG
            done = subprocess.run(
                [self.bash, "-s", *leg_args("/home/leg669/ludics", "/home/leg669/wt")],
                input=script, env={**os.environ, "HOME": "/Users/leg669"}, capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(done.stderr, "EXECUTION LEG REFUSED box: --checkout /home/leg669/ludics is not a git checkout"
                                      " on box; /home/leg669 is not box's home directory (/Users/leg669)" + HINT + "\n")

    def test_another_boxs_home_either_way_round_gets_the_hint(self) -> None:
        self.assertEqual(self.hint("/Users/u", "/home/u/ludics"), "; /home/u is not box's home directory (/Users/u)" + HINT)
        self.assertEqual(self.hint("/home/u", "/Users/u/wts/w 1"), "; /Users/u is not box's home directory (/home/u)" + HINT)
        self.assertEqual(self.hint("/home/u", "/home/v"), "; /home/v is not box's home directory (/home/u)" + HINT)

    def test_a_path_under_the_boxs_own_home_or_outside_any_home_gets_none(self) -> None:
        for home, path in [("/home/u", "/home/u/ludics"), ("/home/u/", "/home/u"), ("/Users/u/deep", "/Users/u/deep/x"),
                           ("/home/u", "/opt/ludics"), ("/home/u", "/home/"), ("", "/home/u/x")]:
            with self.subTest(home=home, path=path):
                self.assertEqual(self.hint(home, path), "")

    def test_a_home_reached_through_a_symlink_is_the_boxs_own(self) -> None:
        real = os.path.expanduser("~")
        if not real.startswith(("/home/", "/Users/")) or real.count("/") != 2 or not os.path.isdir(real):
            self.skipTest(f"this account's home {real} is under neither /home nor /Users")
        with tempfile.TemporaryDirectory() as tmp:
            link = os.path.join(tmp, "home")
            os.symlink(real, link)
            self.assertEqual(self.hint(link, os.path.join(real, "ludics-lite")), "")


class Base(unittest.TestCase):
    """THE BASE (ludics#1042): the far side's refresh of the base branch's remote-tracking ref in a
    checkout whose ``origin/main`` lags the remote by a commit. The leg's line, its refusal and their
    place before the worktree moves are the shell suite's."""

    bash = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash") or "bash"  # 3.2 on macOS

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout.strip()

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        src, self.remote, self.co = self.tmp / "src", self.tmp / "remote.git", self.tmp / "co"
        self.git("init", "-q", "-b", "main", str(src))
        for args in (["config", "user.email", "t@example.com"], ["config", "user.name", "t"],
                     ["commit", "-q", "--allow-empty", "-m", "A"]):
            self.git("-C", str(src), *args)
        self.git("init", "-q", "--bare", "-b", "main", str(self.remote))
        self.git("-C", str(src), "push", "-q", str(self.remote), "main")
        self.git("clone", "-q", str(self.remote), str(self.co))
        self.stale = self.git("-C", str(self.co), "rev-parse", "origin/main")
        # The remote moves on, by a commit on main and a branch the checkout never fetched.
        self.git("-C", str(src), "commit", "-q", "--allow-empty", "-m", "B")
        self.git("-C", str(src), "push", "-q", str(self.remote), "main", "main:dev")
        self.tip = self.git("-C", str(src), "rev-parse", "HEAD")

    def refresh(self, base: str = "") -> tuple[int, str, str]:
        script = (f"STATE={shlex.quote(str(self.tmp / 'state'))}\nBOX=box\n" + farside.HELPERS + leg.BASE
                  + 'refresh_base "$@"\n')
        done = subprocess.run([self.bash, "-c", script, "x", str(self.co), "origin", base, "30"],
                              capture_output=True, text=True)
        return done.returncode, done.stdout, done.stderr

    def test_a_stale_default_branch_is_fetched_to_the_remotes_tip(self) -> None:
        self.assertNotEqual(self.stale, self.tip)
        rc, out, err = self.refresh()
        self.assertEqual((rc, out), (0, f"main origin/HEAD {self.stale} {self.tip}\n"), err)
        self.assertEqual(self.git("-C", str(self.co), "rev-parse", "origin/main"), self.tip)
        # The checkout itself never moves: its branch and HEAD are the clone's.
        self.assertEqual(self.git("-C", str(self.co), "rev-parse", "HEAD"), self.stale)
        self.assertEqual(self.git("-C", str(self.co), "symbolic-ref", "HEAD"), "refs/heads/main")

    def test_a_named_base_is_fetched_even_when_the_checkout_never_had_it(self) -> None:
        rc, out, err = self.refresh("dev")
        self.assertEqual((rc, out), (0, f"dev --base unset {self.tip}\n"), err)
        self.assertEqual(self.git("-C", str(self.co), "rev-parse", "origin/dev"), self.tip)
        self.assertEqual(self.git("-C", str(self.co), "rev-parse", "origin/main"), self.stale)

    def test_no_remote_head_and_no_named_base_fetches_nothing(self) -> None:
        self.git("-C", str(self.co), "remote", "set-head", "origin", "--delete")
        rc, out, _ = self.refresh()
        self.assertEqual((rc, out), (3, ""))
        self.assertEqual(self.git("-C", str(self.co), "rev-parse", "origin/main"), self.stale)

    def test_a_failed_fetch_is_retried_once_and_lands_nothing(self) -> None:
        rc, out, err = self.refresh("no-such-1042")
        self.assertNotIn(rc, (0, 3, 124))
        self.assertEqual(out, "no-such-1042 --base unset -\n")
        self.assertEqual(err.count("no-such-1042"), 2, err)
        self.assertEqual(self.git("-C", str(self.co), "rev-parse", "origin/main"), self.stale)


class FreeSpaceFloor(unittest.TestCase):
    """THE FREE-SPACE FLOOR (ludics#981): the far side's reading of a filesystem. The refusal, its
    place before the leg's first write and the failed read's note are the shell suite's."""

    def read(self, floor: int, *paths: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, "-I", "-c", leg.FLOOR_PY, str(floor), *paths], capture_output=True, text=True)

    def test_a_filesystem_over_the_floor_passes_and_one_under_it_exits_3_naming_the_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            free = shutil.disk_usage(tmp).free / 2**30
            self.assertEqual(self.read(0, tmp).returncode, 0)
            done = self.read(int(free) + 1000, tmp)
            self.assertEqual(done.returncode, 3)
            gib, where = done.stdout.rstrip("\n").split(" ", 1)
            self.assertAlmostEqual(float(gib), free, delta=2)
            self.assertEqual(where, tmp)

    def test_a_worktree_not_made_yet_is_read_at_its_nearest_existing_ancestor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            done = self.read(0, os.path.join(tmp, "not", "yet"))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertTrue(done.stdout.rstrip("\n").endswith(os.path.join(tmp, "not", "yet")))

    def test_a_path_with_a_space_survives_the_reading(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a b")
            os.mkdir(path)
            self.assertEqual(self.read(0, path).stdout.rstrip("\n").split(" ", 1)[1], path)

    def test_a_path_that_cannot_be_read_exits_1_with_nothing_printed(self) -> None:
        done = self.read(0, "relative/nowhere/at/all")
        self.assertEqual((done.returncode, done.stdout), (1, ""))

    def test_a_floor_that_is_no_whole_number_is_a_usage_error_before_anything_is_read(self) -> None:
        cfg = load_config("/x/issue-wave/scripts/fleet-worker.sh", {"FLEET_LOCAL_BOX": "agent", "FLEET_LEG_MIN_FREE_GIB": "lots"}, host="agent")
        with mock.patch.object(execution, "listing") as listing, self.assertRaises(cli.Exit) as raised:
            leg.cmd_leg(cfg, ["--request", "r", "--rev", "main", "--checkout", "/c", "--worktree", "/w", "--", "true"])
        self.assertEqual(raised.exception.rc, 2)
        self.assertIn("FLEET_LEG_MIN_FREE_GIB must be a whole number", str(raised.exception))
        listing.assert_not_called()


class Sweep(unittest.TestCase):
    """THE SWEEP (ludics#715): what earlier legs left on the box -- a staged file over the grace no
    process holds, a private ref whose far shell is gone -- is removed; a claimed, young or foreign
    file and a live leg's ref are kept; a claim that finds its own file swept is refused (3)."""

    bash = shutil.which("bash") or "/bin/bash"
    root = Path(leg.__file__).resolve().parents[3]
    OLD = time.time() - leg.STAGED_GRACE - 60

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name, "state")
        self.co = Path(tmp.name, "co")
        for sub in ("leg-control", "leg-files"):
            (self.state / sub).mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.co)], check=True)
        subprocess.run(["git", "-C", str(self.co), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                        "--allow-empty", "-m", "c"], check=True)

    def staged(self, sub: str, name: str, *, old: bool = True) -> Path:
        path = self.state / sub / name
        path.write_text("patch\n")
        if old:
            os.utime(path, (self.OLD, self.OLD))
        return path

    def ref(self, name: str) -> str:
        ref = f"refs/fleet-leg/{name}"
        subprocess.run(["git", "-C", str(self.co), "update-ref", ref, "HEAD"], check=True)
        return ref

    def refs(self) -> list[str]:
        out = subprocess.run(["git", "-C", str(self.co), "for-each-ref", "--format=%(refname)", "refs/fleet-leg/"],
                             capture_output=True, text=True, check=True).stdout
        return out.split()

    def sweep(self, body: str = 'sweep_staged "$@"', *args: str, pass_fds: tuple[int, ...] = ()) -> tuple[int, str]:
        script = (f"STATE={shlex.quote(str(self.state))}\nSKILLS_REPO={shlex.quote(str(self.root))}\n"
                  + leg.SWEEP + body + "\n")
        done = subprocess.run([self.bash, "-c", script, "x", str(self.co), *args], capture_output=True, text=True,
                              pass_fds=pass_fds)
        return done.returncode, done.stdout

    def dead_pid(self) -> int:
        child = subprocess.Popen(["true"])
        child.wait()
        return child.pid

    def test_a_stale_file_and_a_gone_shells_ref_are_swept(self) -> None:
        patch = self.staged("leg-control", "w-1.0123456789abcdef.patch")
        shipped = self.staged("leg-files", "w-1.0123456789abcdef.targets.txt")
        gone = self.ref(str(self.dead_pid()))
        rc, out = self.sweep()
        self.assertEqual(rc, 0)
        self.assertEqual(out.splitlines(), [str(patch), str(shipped), gone])
        self.assertFalse(patch.exists() or shipped.exists())
        self.assertEqual(self.refs(), [])

    def test_a_young_a_held_or_a_foreign_file_and_a_live_ref_are_kept(self) -> None:
        young = self.staged("leg-control", "w-1.0123456789abcdef.patch", old=False)
        held = self.staged("leg-control", "w-2.0123456789abcdef.patch")
        foreign = self.staged("leg-control", "notes.txt")
        untokened = self.staged("leg-files", "w-3.0123.patch")
        link = self.state / "leg-files" / "w-4.0123456789abcdef.patch"
        link.symlink_to(foreign)
        live, odd = self.ref(str(os.getpid())), self.ref("x12")
        with open(held, "rb") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_SH)
            rc, out = self.sweep()
        self.assertEqual((rc, out), (0, ""))
        for path in (young, held, foreign, untokened, link):
            self.assertTrue(os.path.lexists(path), path)
        self.assertEqual(sorted(self.refs()), sorted([live, odd]))

    def test_a_claimed_file_outlives_the_grace_in_a_later_sweep(self) -> None:
        mine = self.staged("leg-control", "w-1.0123456789abcdef.patch", old=False)
        old = f"touch -t 200001010000 {shlex.quote(str(mine))}"
        rc, out = self.sweep(f'exec 7<"$2"; sweep_staged "$1" 7 "$2" || exit; {old}; sweep_staged "$1"', str(mine))
        self.assertEqual((rc, out), (0, ""))
        self.assertTrue(mine.exists())

    def test_a_claim_whose_file_was_swept_first_is_refused(self) -> None:
        mine = self.staged("leg-control", "w-1.0123456789abcdef.patch")
        with open(mine, "rb") as f:
            os.unlink(mine)
            rc, _ = self.sweep(f'sweep_staged "$1" {f.fileno()} "$2"', str(mine), pass_fds=(f.fileno(),))
        self.assertEqual(rc, 3)

    def test_the_far_shell_s_own_ref_is_kept(self) -> None:
        rc, out = self.sweep('git -C "$1" update-ref "refs/fleet-leg/$$" HEAD; sweep_staged "$1"; git -C "$1" for-each-ref refs/fleet-leg/ | wc -l')
        self.assertEqual((rc, out.split()), (0, ["1"]))


class WorktreeReading(unittest.TestCase):
    """``common`` and ``gitdir`` (leg.WORKTREE) under the /bin/bash a Mac's far side has. Bash 3.2's
    ``cd ""`` succeeds and stays put, so a ``git rev-parse`` that failed must never reach the ``cd``:
    a plain directory would read as its own git directory, and the leg's ``--checkout ... is not a
    git checkout`` refusal, on a Mac, would never fire. Bash 5 fails that ``cd``, so only a macOS run
    of these cases can catch the shape coming back."""

    bash = "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash") or "bash"  # 3.2 on macOS

    def setUp(self) -> None:
        made = tempfile.TemporaryDirectory()
        self.addCleanup(made.cleanup)
        self.tmp = Path(made.name).resolve()
        self.plain = self.tmp / "plain"
        self.plain.mkdir()
        self.co = self.tmp / "co"
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", str(self.co)]
        subprocess.run(["git", "init", "-q", str(self.co)], capture_output=True, check=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "a"], capture_output=True, check=True)
        self.wt = self.tmp / "wt"
        subprocess.run([*git, "worktree", "add", "-q", str(self.wt), "-b", "topic"], capture_output=True, check=True)

    def read(self, function: str, path: Path) -> str:
        done = subprocess.run([self.bash, "-c", leg.WORKTREE + f'{function} "$1"\n', "x", str(path)],
                              capture_output=True, text=True, cwd="/")
        return done.stdout.rstrip("\n")

    def test_a_plain_directory_reads_empty(self) -> None:
        self.assertEqual((self.read("common", self.plain), self.read("gitdir", self.plain)), ("", ""))

    def test_a_main_checkout_reads_absolute_though_git_prints_it_relative(self) -> None:
        sub = self.co / "sub"
        sub.mkdir()
        dotgit = str(self.co / ".git")
        self.assertEqual((self.read("common", self.co), self.read("gitdir", self.co)), (dotgit, dotgit))
        self.assertEqual(self.read("common", sub), dotgit)

    def test_a_linked_worktree_reads_the_checkouts_common_and_its_own_gitdir(self) -> None:
        self.assertEqual(self.read("common", self.wt), str(self.co / ".git"))
        self.assertEqual(self.read("gitdir", self.wt), str(self.co / ".git" / "worktrees" / "wt"))

    def test_a_plain_directory_as_checkout_is_the_legs_first_refusal(self) -> None:
        # The whole far side, as ForeignHome runs it. Past this line it would go on to the fetch.
        root = Path(leg.__file__).resolve().parents[3]
        script = f"STATE={shlex.quote(str(self.tmp / 'state'))}\nSKILLS_REPO={shlex.quote(str(root))}\nBOX=box\n" + farside.HELPERS + leg.LEG
        done = subprocess.run(
            [self.bash, "-s", *leg_args(str(self.plain), str(self.tmp / "new"))],
            input=script, env={**os.environ, "HOME": str(self.tmp)}, capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(done.stderr, f"EXECUTION LEG REFUSED box: --checkout {self.plain} is not a git checkout on box\n")


if __name__ == "__main__":
    unittest.main()
