"""ludics.fleetworker.winwitness: ``execution windows-witness``'s readers, the scripts it stages on
Windows (run here with a local bash and git), and every failure path of its steps against fake
registry, wake-lab and ssh calls (the shell suite's "execution windows-witness" section drives the
verb end to end, against the registry)."""

import contextlib
import io
import json
import os
import signal
import subprocess
import tempfile
import unittest
from collections.abc import Generator
from typing import Any
from unittest import mock

from ludics import cli
from ludics.fleetworker import winwitness
from ludics.fleetworker.config import load_config
from ludics.fleetworker.winwitness import (Plan, Site, block_problem, endpoint_problem, execute, parse, plan_of,
                                           site_entry, staged_sha, staging_script)

A = "a" * 40
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "issue-wave", "scripts", "fleet-worker.sh")
BASE = {"wave": "w", "worker": "/root/w", "transport": "subagent", "agent_host": "mac", "repository": "o/r",
        "issue": "o/r#1206", "purpose": "base purpose"}
MAP = "rog rog-nv-linux rog-nv-win rog-nv-wsl rog-lan\nminix minix-amd-linux minix-amd-win\n"
SITE = {"rog-nv-linux": {"windows_host": "rog-nv-win", "root": "C:/witness/"}}


def block(**fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"request_id": "w-win-1", "linux_host": "rog-nv-linux", "windows_host": "rog-nv-win",
                           "requested_revision": A, "script": "/nonexistent/verify.sh", "cap_seconds": 120}
    out.update(fields)
    return {k: v for k, v in out.items() if v is not None}


def message(*blocks: dict[str, Any]) -> str:
    return "Please run:\n" + "".join(f"    WINDOWS_WITNESS_REQUEST\n{json.dumps(b)}\n    END_WINDOWS_WITNESS_REQUEST\n" for b in blocks)


def refusal(call: Any) -> str:
    """The message of the usage death ``call`` ends in (exit 2)."""
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            call()
        except cli.Exit as exc:
            assert exc.rc == 2, exc.rc
            return exc.message
    raise AssertionError("not refused")


def site_said(site: Any, host: str) -> str:
    """Why ``site_entry`` refuses the host's entry ('' when it is accepted)."""
    got = site_entry(site, host, "/w")
    return got if isinstance(got, str) else ""


class Readers(unittest.TestCase):
    def test_parse(self) -> None:
        got = parse(["/b", "-", "--site", "/s", "--transcript", "/t", "--script", "/x"])
        self.assertEqual((got.base, got.message, got.site, got.transcript, got.script), ("/b", "-", "/s", "/t", "/x"))
        for args in (["/b", "-", "--site", "/s", "--transcript", "/t"], ["/b", "--site", "/s", "--transcript", "/t", "--script", "/x"],
                     ["/b", "-", "--site", "/s", "--site", "/s", "--transcript", "/t"], ["/b", "-", "--oops"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(cli.Exit) as caught:
                parse(args)
            self.assertEqual(caught.exception.rc, 2, args)

    def test_the_block_allowlist(self) -> None:
        self.assertIsNone(block_problem(block()))
        self.assertIsNone(block_problem(block(checkout="C:/w", evidence="C:/e/x.log", purpose="p")))
        self.assertIn("names command", block_problem(block(command="x")) or "")
        self.assertIn("must give script", block_problem(block(script=None)) or "")
        self.assertIn("full 40-hex", block_problem(block(requested_revision="head-of:main")) or "")
        self.assertIn("cap_seconds must be", block_problem(block(cap_seconds=0)) or "")
        self.assertIn("cap_seconds must be", block_problem(block(cap_seconds=True)) or "")
        self.assertIn("cap_seconds must be", block_problem(block(cap_seconds="60")) or "")
        self.assertIn("request_id must match", block_problem(block(request_id="a b")) or "")
        self.assertIn("request_id must match", block_problem(block(request_id='a"&calc')) or "")
        self.assertIn("windows_host must match", block_problem(block(windows_host="-oProxyCommand=x")) or "")
        self.assertIn("not its linux_host", block_problem(block(windows_host="rog-nv-linux")) or "")
        self.assertIn("not one JSON object", block_problem([]) or "")

    def test_the_site_entry(self) -> None:
        got = site_entry(SITE, "rog-nv-linux", "/wake")
        assert isinstance(got, Site)
        self.assertEqual((got.root, got.bash, got.max_cap, got.stage_cap, got.wake),
                         ("C:/witness", winwitness.DEFAULT_BASH, 3600, 900, "/wake"))
        self.assertIn("no entry for minix", site_said(SITE, "minix-amd-linux"))
        for bad in ('C:/a"b', "C:/a%PATH%", "C:/a&b", "C:/a^b", "C:/a|b", "C:/a<b", "C:/a!b", "relative/x", "/posix", "C:/"):
            with self.subTest(bad=bad):
                self.assertIn("must be a Windows path", site_said({"h": {"windows_host": "w", "root": bad}}, "h"))
                self.assertIn("must be a Windows path", site_said({"h": {"windows_host": "w", "root": "C:/r", "bash": bad}}, "h"))
        # A trailing separator is dropped from a directory, which is always followed by /<name>, and
        # refused on the program, which a quote follows on the command line.
        stripped = site_entry({"h": {"windows_host": "w", "root": "C:/r\\/"}}, "h", "/w")
        assert isinstance(stripped, Site)
        self.assertEqual(stripped.root, "C:/r")
        self.assertIn("no trailing separator", site_said({"h": {"windows_host": "w", "root": "C:/r", "bash": "C:/b\\"}}, "h"))
        self.assertIsInstance(site_entry({"h": {"windows_host": "w", "root": "D:\\r", "bash": "C:/Program Files (x86)/Git/bin/bash.exe"}}, "h", "/w"), Site)
        self.assertIn("windows_host must be the box's native", site_said({"h": {"root": "C:/r"}}, "h"))
        self.assertIn("windows_host must be the box's native", site_said({"h": {"windows_host": "-oProxyCommand=x", "root": "C:/r"}}, "h"))
        self.assertIn("names clone", site_said({"h": {"windows_host": "w", "root": "C:/r", "clone": "C:/c"}}, "h"))
        self.assertIn("names ssh", site_said({"h": {"windows_host": "w", "root": "C:/r", "ssh": "x"}}, "h"))
        self.assertIn("max_cap_seconds must be", site_said({"h": {"windows_host": "w", "root": "C:/r", "max_cap_seconds": 0}}, "h"))
        self.assertIn("wake must be", site_said({"h": {"windows_host": "w", "root": "C:/r", "wake": "wake-lab.sh"}}, "h"))

    def test_the_endpoint_map(self) -> None:
        self.assertIsNone(endpoint_problem(MAP, "rog-nv-linux", "rog-nv-win"))
        self.assertIsNone(endpoint_problem(MAP, "rog-nv-linux", "rog-lan"))
        self.assertIn("not an alias of rog-nv-linux", endpoint_problem(MAP, "rog-nv-linux", "minix-amd-win") or "")
        self.assertIn("on no row", endpoint_problem(MAP, "tuf-amd-linux", "tuf-amd-win") or "")
        self.assertIn("on no row", endpoint_problem("", "rog-nv-linux", "rog-nv-win") or "")

    def test_staged_sha_needs_the_line_last_and_exit_zero(self) -> None:
        self.assertTrue(staged_sha(0, f"x\r\nobserved_sha: {A}\r\n", A))
        self.assertFalse(staged_sha(1, f"observed_sha: {A}\n", A))
        self.assertFalse(staged_sha(0, f"observed_sha: {A}\nlater\n", A))
        self.assertFalse(staged_sha(0, f"observed_sha: {'b' * 40}\n", A))
        self.assertFalse(staged_sha(0, "", A))


class Planning(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", self.dir], check=False))
        self.cfg = load_config(SCRIPT, {"HOME": "/nowhere"})
        self.script = self.write("verify.sh", "uname -a\n")
        self.base = self.write("base.json", json.dumps(BASE))
        self.site = self.write("site.json", json.dumps(SITE))
        self.transcript = os.path.join(self.dir, "t.log")

    def write(self, name: str, text: str) -> str:
        path = os.path.join(self.dir, name)
        with open(path, "w") as f:
            f.write(text)
        return path

    def plan(self, text: str, script: str = "", mapped: str | None = MAP) -> Plan:
        msg = self.write("msg.md", text)
        return plan_of(self.cfg, [self.base, msg, "--site", self.site, "--transcript", self.transcript,
                                  "--script", script or self.script], read_map=lambda wake: mapped)

    def test_the_reservation_is_the_coordinators_measurement_on_the_linux_side(self) -> None:
        plan = self.plan(message(block(purpose="witness #1206")))
        self.assertEqual(plan.reserve["transport"], "coordinator")
        self.assertEqual((plan.reserve["kind"], plan.reserve["execution_host"], plan.reserve["requested_revision"]),
                         ("measurement", "rog-nv-linux", A))
        self.assertEqual((plan.reserve["wave"], plan.reserve["worker"], plan.reserve["issue"], plan.reserve["purpose"]),
                         ("w", "/root/w", "o/r#1206", "witness #1206"))
        self.assertNotIn("checkout", plan.reserve)
        self.assertIn("script sha256 ", plan.reserve["evidence"])
        self.assertEqual((plan.directory, plan.checkout), ("C:/witness/w-win-1", "C:/witness/w-win-1/checkout"))
        self.assertEqual(plan.fleet, os.path.join(self.cfg.here, "fleet-worker.sh"))
        self.assertEqual(self.plan(message(block())).reserve["purpose"], "base purpose")
        self.assertIn("url=https://github.com/o/r.git sha=" + A, plan.stage_script)

    def test_the_windows_command_lines(self) -> None:
        plan = self.plan(message(block()))
        self.assertEqual(winwitness.stage_command(plan.site),
                         'cmd.exe /d /s /c ""C:/Program Files/Git/usr/bin/bash.exe" --noprofile --norc -s"')
        self.assertEqual(winwitness.run_command(plan),
                         'cmd.exe /d /s /c "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass'
                         ' -File "C:/witness/w-win-1/windows-driver.ps1" -ScriptPath "C:/witness/w-win-1/witness.sh"'
                         ' -LogPath "C:/witness/w-win-1/run.log" -ErrorPath "C:/witness/w-win-1/run.err" -CapSeconds 120'
                         ' -BashPath "C:/Program Files/Git/usr/bin/bash.exe""')

    def test_refusals_before_anything_is_asked(self) -> None:
        cases = [
            (message(block(), block(request_id="w-win-2")), "", "2 blocks"),
            ("no block here\n", "", "no WINDOWS_WITNESS_REQUEST ... END_WINDOWS_WITNESS_REQUEST block"),
            (message(block(cap_seconds=3601)), "", "past the site's max_cap_seconds 3600"),
            # The WSL alias is on the box's row too: only the site's native alias passes.
            (message(block(windows_host="rog-nv-wsl")), "", "windows_host rog-nv-wsl is not the site's native Windows alias"
             " for rog-nv-linux, rog-nv-win"),
            (message(block(linux_host="minix-amd-linux", windows_host="minix-amd-win")), "", "no entry for minix"),
            (message(block()), os.path.join(self.dir, "missing"), "cannot read the script"),
            (message(block()), self.write("empty.sh", "\n"), "is empty"),
        ]
        for text, script, said in cases:
            with self.subTest(said=said):
                self.assertIn(said, refusal(lambda: self.plan(text, script)))
        with open(self.site, "w") as f:
            json.dump({"rog-nv-linux": {"windows_host": "minix-amd-win", "root": "C:/w"}}, f)
        self.assertIn("windows_host minix-amd-win is not an alias of rog-nv-linux's box",
                      refusal(lambda: self.plan(message(block(windows_host="minix-amd-win")))))
        with open(self.site, "w") as f:
            json.dump(SITE, f)
        self.assertIn("endpoint-map failed", refusal(lambda: self.plan(message(block()), mapped=None)))
        with open(self.site, "w") as f:
            json.dump({"rog-nv-linux": {**SITE["rog-nv-linux"], "wake": self.write("wake", "#!/bin/bash\n")}}, f)
        self.assertIn("is not an executable file; the boots and status run it", refusal(lambda: self.plan(message(block()))))
        with open(self.site, "w") as f:
            json.dump(SITE, f)
        with open(self.base, "w") as f:
            json.dump({**BASE, "standing": True}, f)
        self.assertIn("the base names standing", refusal(lambda: self.plan(message(block()))))
        with open(self.base, "w") as f:
            json.dump({**BASE, "repository": "o/r;touch x"}, f)
        self.assertIn("must be <owner>/<name> on GitHub", refusal(lambda: self.plan(message(block()))))

    def test_an_existing_transcript_or_side_file_refuses(self) -> None:
        for suffix in ("", ".reserve.json", ".stage.sh", ".conclude.json"):
            with self.subTest(suffix=suffix):
                self.write("t.log" + suffix, "earlier attempt\n")
                self.assertIn("name a fresh transcript", refusal(lambda: self.plan(message(block()))))
                os.unlink(self.transcript + suffix)

    def test_the_staged_script_is_the_flags_never_the_blocks(self) -> None:
        worker = self.write("worker.sh", "rm -rf /\n")
        plan = self.plan(message(block(script=worker)))
        self.assertEqual(staged_text(plan), "uname -a\n")


def staged_text(plan: Plan) -> str:
    """The worker's script as the staging script carries it, decoded."""
    import base64
    for line in plan.stage_script.split("\n"):
        if line.endswith("> \"$dir\"/script.sh || fail 'cannot write script.sh'"):
            return base64.b64decode(line.split("'")[3]).decode()
    raise AssertionError("no script.sh line")


class StagedScripts(unittest.TestCase):
    """The staging script and witness.sh are bash: run them here, the site's paths POSIX ones."""

    def setUp(self) -> None:
        self.dir = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", self.dir], check=False))
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
        origin = os.path.join(self.dir, "origin")
        subprocess.run([*git, "init", "-q", origin], check=True)
        with open(os.path.join(origin, "README"), "w") as f:
            f.write("x\n")
        subprocess.run([*git, "-C", origin, "add", "README"], check=True)
        subprocess.run([*git, "-C", origin, "commit", "-q", "-m", "one"], check=True)
        self.sha = subprocess.run(["git", "-C", origin, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run([*git, "-C", origin, "commit", "-q", "--allow-empty", "-m", "two"], check=True)
        self.later = subprocess.run(["git", "-C", origin, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        # GitHub serves any reachable commit by its SHA; a local origin does once it is told to.
        subprocess.run(["git", "-C", origin, "config", "uploadpack.allowAnySHA1InWant", "true"], check=True)
        self.url = "file://" + origin
        self.git = git
        self.site = Site("win", os.path.join(self.dir, "root"), "/bin/bash", 60, 60, "/w")

    def stage(self, revision: str, script: bytes = b"printf 'from the worker\\n'\n", request: str = "r1") -> subprocess.CompletedProcess[str]:
        text = staging_script(self.site, request, revision, self.url, script, b"# the driver\n")
        return subprocess.run(["bash", "--noprofile", "--norc", "-s"], input=text, capture_output=True, text=True)

    def witness(self, request: str = "r1") -> subprocess.CompletedProcess[str]:
        path = os.path.join(self.site.root, request, "witness.sh")
        return subprocess.run(["bash", "--noprofile", "--norc", "--", path], capture_output=True, text=True)

    def test_a_staged_revision_runs_the_script_from_its_checkout(self) -> None:
        done = self.stage(self.later, b"pwd -P\nprintf 'rev=%s\\n' \"$WITNESS_REVISION\"\n")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertTrue(staged_sha(done.returncode, done.stdout, self.later), done.stdout)
        directory = os.path.join(self.site.root, "r1")
        with open(os.path.join(directory, "windows-driver.ps1")) as f:
            self.assertEqual(f.read(), "# the driver\n")
        run = self.witness()
        lines = run.stdout.splitlines()
        self.assertEqual(lines[-1], "exit: 0", run.stdout + run.stderr)
        self.assertIn(f"observed_sha: {self.later}", lines)
        self.assertIn(os.path.join(directory, "checkout"), lines)
        self.assertIn(f"rev={self.later}", lines)
        self.assertTrue(any(line.startswith("git --version: git version") for line in lines))

    def test_the_scripts_status_is_the_last_line(self) -> None:
        self.assertEqual(self.stage(self.sha, b"printf 'exit: 0\\n'\nexit 3\n").returncode, 0)
        run = self.witness()
        self.assertEqual((run.returncode, run.stdout.splitlines()[-1]), (3, "exit: 3"))

    def test_the_verdict_is_its_own_line_after_unterminated_output(self) -> None:
        self.assertEqual(self.stage(self.sha, b"printf 'no final newline'\n").returncode, 0)
        run = self.witness()
        self.assertEqual((run.returncode, run.stdout.splitlines()[-2:]), (0, ["no final newline", "exit: 0"]))

    def test_a_moved_checkout_is_refused_before_the_script(self) -> None:
        self.assertEqual(self.stage(self.later, b"printf 'RAN\\n'\n").returncode, 0)
        subprocess.run([*self.git, "-C", os.path.join(self.site.root, "r1", "checkout"), "commit", "-q", "--allow-empty", "-m", "moved"], check=True)
        run = self.witness()
        self.assertEqual((run.returncode, run.stdout.splitlines()[-1]), (2, "exit: 2"))
        self.assertNotIn("RAN", run.stdout)

    def test_staging_refusals(self) -> None:
        self.assertEqual(self.stage(self.sha).returncode, 0)
        again = self.stage(self.sha)
        self.assertEqual(again.returncode, 1)
        self.assertIn("exists: a request id is staged once", again.stdout)
        missing = self.stage("c" * 40, request="r2")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("WITNESS STAGE FAILED: cannot fetch", missing.stdout)
        self.assertFalse(staged_sha(missing.returncode, missing.stdout, "c" * 40))


# --- the steps, against fakes -------------------------------------------------------------------

FAILURES = ("none", "reserve", "reserve-published", "reserve-unlisted", "reserve-unreachable", "reserve-timeout", "windows",
            "windows-needs-person", "windows-signal", "stage",
            "stage-sha", "stage-timeout", "script", "script-timeout", "driver-timeout", "ssh-error", "interrupt",
            "boot-interrupt", "recovery-interrupt", "local-error", "linux", "linux-needs-person", "status",
            "conclude", "conclude-timeout", "conclude-file", "handler-interrupt", "handler-interrupt-linux")


def fake_plan(directory: str, fleet: str = "/fake/fleet", wake: str = "/fake/wake") -> Plan:
    site = Site("dual-win", "C:/witness", winwitness.DEFAULT_BASH, 3600, 30, wake)
    transcript = os.path.join(directory, "transcript.log")
    with open(transcript + ".reserve.json", "w") as f:
        json.dump({"request_id": "win-1"}, f)
    return Plan("win-1", "dual-linux", "dual-win", A, 17, site, fleet, {}, "staging script\n", transcript)


@contextlib.contextmanager
def transcript_of(plan: Plan) -> Generator[io.TextIOWrapper]:
    with open(plan.transcript, "x", encoding="utf-8") as f:
        yield f


class Steps(unittest.TestCase):
    """Each failure path of the header's closed list: what ran, the exit, the conclusion."""

    def test_every_failure_path(self) -> None:
        for failure in FAILURES:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                self.check(failure, directory)

    def check(self, failure: str, directory: str) -> None:
        plan = fake_plan(directory)
        calls: list[str] = []
        caps: dict[str, int | None] = {}
        dispositions: dict[int, Any] = {signal.SIGTERM: winwitness.interrupted, signal.SIGINT: signal.default_int_handler}

        def set_signal(signum: int, handler: Any) -> Any:
            previous = dispositions[signum]
            dispositions[signum] = handler
            return previous

        def run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
            if argv[0] == "/fake/fleet":
                name = argv[2]
            elif argv[0] == "/fake/wake":
                name = argv[1]
            else:
                name = "stage" if argv[-1].endswith('--noprofile --norc -s"') else "script"
            calls.append(name)
            caps[name] = kwargs["timeout"]
            out = kwargs["stdout"]
            text = "fake " + name + "\n"
            target = {"run": "reserve", "boot-windows": "windows", "boot-linux": "linux"}.get(name, name)
            if name == "conclude":
                with open(argv[3]) as f:
                    payload = json.load(f)
                if payload["verdict"] != "not-launched":
                    for key in ("observed_sha", "remote_checkout", "handle"):
                        self.assertTrue(payload.get(key), "the registry requires " + key)
            if name.startswith("boot-"):
                self.assertIsNone(kwargs["timeout"], "wake-lab must finish its own bounded cleanup")
                self.assertTrue(kwargs["start_new_session"], "a boot child is isolated from terminal signals")
                for signum in (signal.SIGINT, signal.SIGTERM):
                    self.assertEqual(getattr(dispositions[signum], "__name__", ""), "defer", "the parent defers cancellation")
                if failure == "boot-interrupt" and name == "boot-windows" or failure == "recovery-interrupt" and name == "boot-linux":
                    dispositions[signal.SIGTERM](signal.SIGTERM, None)
            elif failure == target + "-timeout":
                raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
            if name == "script":
                for signum in (signal.SIGINT, signal.SIGTERM):
                    self.assertNotEqual(getattr(dispositions[signum], "__name__", ""), "defer", "the run stays interruptible")
                if failure == "ssh-error":
                    raise OSError("ssh unavailable")
                if failure == "interrupt" or failure.startswith("handler-interrupt"):
                    raise KeyboardInterrupt()
                if failure == "local-error":
                    raise ValueError("local failure")
            if name == "stage":
                self.assertEqual(kwargs["input"], b"staging script\n")
                text += "observed_sha: " + ("b" * 40 if failure == "stage-sha" else A) + "\n"
            if name == "list":
                text = json.dumps([{"request_id": "win-1" if failure == "reserve-published" else "other"}])
                rc = 1 if failure == "reserve-unlisted" else 0
                return subprocess.CompletedProcess(argv, rc, text.encode())
            if name == "status":
                text += "rog  os=" + ("windows" if failure == "status" else "linux") + "  linux=UP\n"
            rc = (3 if failure == target + "-needs-person" else 130 if failure == "windows-signal" and name == "boot-windows"
                  else 4 if failure == "reserve-unreachable" and name == "run"
                  else 1 if failure == "handler-interrupt-linux" and name == "boot-linux"
                  else 1 if failure in ("reserve-published", "reserve-unlisted") and name == "run"
                  else 124 if failure == "driver-timeout" and name == "script" else 1 if failure == target else 0)
            if out is subprocess.PIPE:
                return subprocess.CompletedProcess(argv, rc, text.encode())
            out.write(text)
            out.flush()
            return subprocess.CompletedProcess(argv, rc)

        if failure == "conclude-file":  # the conclusion cannot be written: exclusive create meets a file
            with open(plan.transcript + ".conclude.json", "w") as f:
                f.write("not this run's\n")
        said_step = winwitness.step

        def step(name: str, text: str) -> None:
            if name == "interrupted" and failure.startswith("handler-interrupt"):
                # A second cancellation while the first is said: under the deferral it is recorded.
                dispositions[signal.SIGINT](signal.SIGINT, None)
            said_step(name, text)

        with (mock.patch("subprocess.run", side_effect=run), mock.patch("signal.signal", side_effect=set_signal),
              mock.patch.object(winwitness, "step", side_effect=step),
              contextlib.redirect_stderr(io.StringIO()) as said, transcript_of(plan) as f):
            rc = execute(plan, f)
        with open(plan.transcript) as f:
            transcript = f.read()
        conclusion = plan.transcript + ".conclude.json"
        if failure.startswith("reserve"):
            self.assertNotIn("boot-windows", calls, "a refused or uncertain dispatch never boots")
            self.assertEqual(calls, ["run", "list"] if failure in ("reserve", "reserve-published", "reserve-unlisted") else ["run"],
                             "only a refusal's exit is checked against the listing")
            self.assertEqual(rc, 2 if failure == "reserve" else 4)
            return
        self.assertEqual(calls[:2], ["run", "boot-windows"])
        self.assertIn("boot-linux", calls, "every boot attempt attempts Linux recovery")
        self.assertLess(calls.index("boot-windows"), calls.index("boot-linux"))
        if failure.startswith("windows") or failure == "boot-interrupt":
            self.assertNotIn("stage", calls)
        if failure.startswith("stage") or "stage" not in calls:
            self.assertNotIn("script", calls)
        if "script" in calls:
            self.assertEqual((caps["stage"], caps["script"]), (30, 77), "the site's staging cap; the driver's cap plus 60")
        held = failure.startswith("linux") or failure in ("status", "windows-needs-person", "windows-signal", "interrupt",
                                                          "boot-interrupt", "recovery-interrupt", "local-error", "conclude-file",
                                                          "handler-interrupt", "handler-interrupt-linux")
        if held:
            self.assertNotIn("conclude", calls, "an unconfirmed return or a cancellation keeps the reservation")
            self.assertEqual(os.path.exists(conclusion), failure == "conclude-file")
        else:
            self.assertEqual(calls[-3:], ["boot-linux", "status", "conclude"])
            with open(conclusion) as f:
                payload = json.load(f)
            self.assertEqual(payload["verdict"], "not-launched" if failure.startswith(("windows", "stage")) else
                             "pass" if failure in ("none", "conclude", "conclude-timeout") else
                             "timeout" if failure in ("script-timeout", "driver-timeout") else "fail")
            self.assertEqual(payload["log"], plan.transcript)
            if payload["verdict"] != "not-launched":
                self.assertEqual((payload["observed_sha"], payload["remote_checkout"]), (A, "C:/witness/win-1/checkout"))
        unconfirmed = failure.startswith("linux") or failure in ("status", "windows-needs-person", "windows-signal",
                                                                 "handler-interrupt-linux")
        self.assertEqual(rc, 0 if failure == "none" else 3 if unconfirmed else
                         4 if held or failure.startswith("conclude") else 1)
        self.assertIn("fake run", transcript)
        self.assertEqual("NEEDS A PERSON" in transcript, unconfirmed)
        self.assertEqual("NEEDS A PERSON" in said.getvalue(), unconfirmed)
        if failure.startswith("handler-interrupt"):
            self.assertIn("WITNESS interrupted: KeyboardInterrupt", said.getvalue(), "the handler finishes what it says")

    def test_real_boot_children_keep_their_traps_and_a_cancellation_waits_for_recovery(self) -> None:
        for cancel in (False, True):
            with self.subTest(cancel=cancel), tempfile.TemporaryDirectory() as directory:
                bin_dir = os.path.join(directory, "bin")
                os.mkdir(bin_dir)
                fleet, wake, ssh = (os.path.join(bin_dir, name) for name in ("fleet", "wake", "ssh"))
                for path, content in (
                        (fleet, "#!/bin/bash\nprintf '%s\\n' fake-registry\n"),
                        (ssh, "#!/bin/bash\ncase \"${*: -1}\" in *' -s\"') cat >/dev/null; printf 'observed_sha: %s\\n' "
                              + A + " ;; *) printf '%s\\n' fake-verifier ;; esac\n"),
                        (wake, "#!/bin/bash\n[ \"$1\" != status ] || { printf '%s\\n' 'dual  os=linux'; exit 0; }\n"
                               "trap \"printf '%s\\\\n' child-term-trap\" TERM\nkill -TERM \"$$\"\nprintf '%s\\n' \"$1\"\n"
                               + ('[ "$1" != boot-windows ] || kill -TERM "$PPID"\n' if cancel else ""))):
                    with open(path, "w") as f:
                        f.write(content)
                    os.chmod(path, 0o755)
                plan = fake_plan(directory, fleet, wake)
                term, intr = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
                try:
                    with (mock.patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ["PATH"]}),
                          contextlib.redirect_stderr(io.StringIO()), transcript_of(plan) as f):
                        self.assertEqual(execute(plan, f), 4 if cancel else 0)
                finally:
                    signal.signal(signal.SIGTERM, term)
                    signal.signal(signal.SIGINT, intr)
                with open(plan.transcript) as f:
                    transcript = f.read()
                self.assertEqual(transcript.count("child-term-trap"), 2, "both boot children install their TERM traps")
                self.assertIn("boot-linux", transcript)
                self.assertEqual("fake-verifier" in transcript, not cancel)
                self.assertEqual(os.path.exists(plan.transcript + ".conclude.json"), not cancel)


class FullTranscript(io.StringIO):
    """A transcript on a full disk: every write refused, its descriptor the null device's."""

    def __init__(self) -> None:
        super().__init__()
        self.null = open(os.devnull, "w")

    def write(self, s: str) -> int:
        raise OSError(28, "No space left on device")

    def fileno(self) -> int:
        return self.null.fileno()


class LostWrites(unittest.TestCase):
    def test_a_transcript_that_refuses_writes_never_stops_the_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            plan = fake_plan(directory)
            calls: list[str] = []

            def run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
                name = argv[2] if argv[0] == "/fake/fleet" else argv[1] if argv[0] == "/fake/wake" else \
                    "stage" if argv[-1].endswith('-s"') else "script"
                calls.append(name)
                out = {"stage": f"observed_sha: {A}\n", "status": "dual  os=linux\n"}.get(name, "")
                return subprocess.CompletedProcess(argv, 0, out.encode() if kwargs["stdout"] is subprocess.PIPE else None)

            f = FullTranscript()
            self.addCleanup(f.null.close)
            with mock.patch("subprocess.run", side_effect=run), contextlib.redirect_stderr(io.StringIO()) as said:
                self.assertEqual(execute(plan, f), 0)
            self.assertEqual(calls, ["run", "boot-windows", "stage", "script", "boot-linux", "status", "conclude"])
            self.assertEqual(said.getvalue().count("WITNESS transcript: a write failed"), 1, said.getvalue())
            with open(plan.transcript + ".conclude.json") as c:
                self.assertIn("the transcript is incomplete (a write failed: [Errno 28] No space left on device)",
                              json.load(c)["evidence"])


class Verb(unittest.TestCase):
    def test_the_side_files_are_written_and_the_steps_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cfg = load_config(SCRIPT, {"HOME": "/nowhere"})
            paths: dict[str, str] = {}
            for name, text in (("base.json", json.dumps(BASE)), ("site.json", json.dumps(SITE)), ("v.sh", "uname -a\n")):
                paths[name] = os.path.join(directory, name)
                with open(paths[name], "w") as f:
                    f.write(text)
            msg = os.path.join(directory, "msg.md")
            with open(msg, "w") as f:
                f.write(message(block()))
            transcript = os.path.join(directory, "t.log")
            seen: list[str] = []

            def fake_execute(plan: Plan, f: Any) -> int:
                seen.append(plan.request_id)
                with open(plan.transcript + ".reserve.json") as r:
                    self.assertEqual(json.load(r)["transport"], "coordinator")
                with open(plan.transcript + ".stage.sh") as s:
                    self.assertEqual(s.read(), plan.stage_script)
                return 1

            with (mock.patch.object(winwitness, "endpoint_map", return_value=MAP),
                  mock.patch.object(winwitness, "execute", side_effect=fake_execute)):
                rc = winwitness.cmd_windows_witness(cfg, [paths["base.json"], msg, "--site", paths["site.json"],
                                                          "--transcript", transcript, "--script", paths["v.sh"]])
            self.assertEqual((rc, seen), (1, ["w-win-1"]))
            self.assertTrue(os.path.exists(transcript))


if __name__ == "__main__":
    unittest.main()
