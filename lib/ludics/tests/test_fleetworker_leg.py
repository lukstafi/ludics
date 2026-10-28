"""ludics.fleetworker.leg: the near side's reading of a leg's far side (the shell suite's `execution
leg` section drives the whole verb against a fake remote)."""

import contextlib
import io
import os
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from ludics.fleetworker import farside, leg, slot
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
        for worktree in ["/h/wts/other", "/h/wts/w1/..", "~/wts/w1", "/h/wts/w1\\"]:
            with self.subTest(worktree=worktree):
                rc, said, streamed = self.run_leg(worktree, "/h/wts/w1")
                self.assertEqual(rc, 1)
                self.assertEqual(said, f"EXECUTION LEG REFUSED: --worktree {worktree} is not it's recorded checkout /h/wts/w1"
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
                          ("1", ["env", "OCANNL_BACKEND=", "OCANNL_BACKEND=hip", "tools/t.sh"])]:
            with self.subTest(gpu=gpu, argv=argv):
                self.assertEqual(self.pin(self.PINS, gpu, *argv), (0, ""))

    def test_an_unpinned_gpu_leg_is_refused_naming_the_pins(self) -> None:
        for argv in [["tools/t.sh", "run"], ["tools/t.sh", "run", "--expect-backend"],
                     ["tools/t.sh", "run", "--expect-backend="], ["tools/t.sh", "--", "--expect-backend", "cuda"],
                     ["tools/t.sh", "OCANNL_BACKEND=cuda"], ["env", "OCANNL_BACKEND=", "tools/t.sh"],
                     ["sh", "-c", "OCANNL_BACKEND=cuda tools/t.sh run --expect-backend cuda"],
                     ["env", "tools/t.sh", "OCANNL_BACKEND=cuda"],
                     ["env", "OCANNL_BACKEND=cuda", "OCANNL_BACKEND=", "tools/t.sh"],
                     ["env", "OCANNL_BACKEND=cuda"], ["env", "X=1", "OCANNL_BACKEND=cuda"],
                     ["env", "OCANNL_BACKEND=cuda", "1=x"], ["env", "OCANNL_BACKEND=cuda", "a-b=c", "=d"]]:
            with self.subTest(argv=argv):
                rc, why = self.pin(self.PINS, "1", *argv)
                self.assertEqual(rc, 1)
                self.assertEqual(why, "this leg may hold the GPU (no --cpu), but its runner pins no backend, and"
                                      " .github/fleet-leg asks for one of: --expect-backend <backend>,"
                                      " env OCANNL_BACKEND=<backend>; pin it (as words of the runner's own argv),"
                                      " or declare --cpu for a leg that holds no GPU")

    def test_a_file_with_no_pin_asks_for_none(self) -> None:
        self.assertEqual(self.pin("# nothing yet\n", "1", "tools/t.sh"), (0, ""))
        self.assertEqual(self.pin("", "1", "tools/t.sh"), (0, ""))

    def test_a_line_the_leg_cannot_read_refuses_even_a_cpu_leg(self) -> None:
        for line in ["pin-flagg --x", "pin-flag", "pin-flag x", "pin-flag --", "pin-flag --x=y", "pin-flag --x # c",
                     "pin-env 9X", "pin-env A-B", "pin-env"]:
            with self.subTest(line=line):
                rc, why = self.pin(f"# ok\n{line}", "0", "tools/t.sh")
                self.assertEqual(rc, 1)
                self.assertTrue(why.startswith(f".github/fleet-leg line 2 is not one this leg reads ({line})"), why)


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
        self.assertTrue(why.startswith(".github/fleet-leg line 1 is not one this leg reads (pin-env 9X)"), why)



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
        self.assertIn("no measurement holds testbox after 0s; running the leg", err)

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
        result, out, _, _ = self.wait([[window("w1", "concluded")]], ["--wait-window=30"])
        self.assertEqual(result, 1)
        self.assertIn("EXECUTION LEG REFUSED: unknown request_id it after waiting for window w1", out)

    def test_the_bound_is_the_last_wait_window_given(self) -> None:
        self.assertIsNone(leg.window_bound(["--cpu", "--wait", "5"]))
        # A bare flag is the window's own deadline (ludics-lite#737), never a fixed hour.
        self.assertEqual(leg.window_bound(["--wait-window"]), slot.BY_DEADLINE)
        self.assertEqual(leg.window_bound(["--wait-window=90", "--wait-window=7"]), 7)
        self.assertEqual(leg.window_bound(["--wait-window=7", "--wait-window"]), slot.BY_DEADLINE)
        self.assertEqual(leg.window_bound(["--wait-window", "--wait-window=3600"]), 3600)


HINT = ": a ~ expanded by the caller's shell? spell far-side paths absolutely, or quote '~/...'"


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
                [self.bash, "-s", "/home/leg669/ludics", "/home/leg669/wt", "origin", "main", "", "", "req", "5",
                 "t0k", "0", "0", "true"],
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


if __name__ == "__main__":
    unittest.main()
