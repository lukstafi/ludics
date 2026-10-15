"""ludics.fleetworker.cotenants: a measurement hold's record of the box's GPU co-tenants
(ludics-lite#566, part 2) -- each probe's reading of its source, the hold's own tree left out, and
the summary a conclusion's evidence carries."""

import os
import tempfile
import threading
import unittest
from unittest import mock
from collections.abc import Sequence
from typing import Any

from ludics.fleetworker import cotenants


class FakeRun:
    """A runner answering by the command's basename; anything unlisted cannot be started."""

    def __init__(self, answers: dict[str, tuple[int, str]]) -> None:
        self.answers = answers
        self.calls: list[list[str]] = []

    def __call__(self, argv: Sequence[str]) -> tuple[int, str]:
        self.calls.append(list(argv))
        return self.answers.get(os.path.basename(argv[0]), (127, ""))


class Nvidia(unittest.TestCase):
    def test_compute_apps_are_read_by_pid_and_memory(self) -> None:
        run = FakeRun({"sh": (0, "4242, /usr/bin/python3, 812\n77, bench, [N/A]\nNo running processes\n"
                                 "4242, /usr/bin/python3, 100\n")})  # the same process on a second GPU
        found = cotenants.probe_nvidia("sh", run)
        self.assertEqual(found.status, "ran")
        self.assertEqual(found.processes, ((77, {}), (4242, {"gpu_memory_mib": 912})))
        self.assertIn("skipped 1 unreadable line", found.detail)
        self.assertIn("--query-compute-apps=pid,process_name,used_memory", run.calls[0])

    def test_a_missing_binary_is_absent_and_a_failing_one_failed(self) -> None:
        self.assertEqual(cotenants.probe_nvidia("/nonexistent/nvidia-smi", FakeRun({})).status, "absent")
        failed = cotenants.probe_nvidia("sh", FakeRun({"sh": (9, "NVIDIA-SMI has failed\n")}))
        self.assertEqual((failed.status, failed.detail), ("failed", "exit 9: NVIDIA-SMI has failed"))


class Drm(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def client(self, pid: int, fd: int, target: str, info: str) -> None:
        os.makedirs(os.path.join(self.root, str(pid), "fd"), exist_ok=True)
        os.makedirs(os.path.join(self.root, str(pid), "fdinfo"), exist_ok=True)
        os.symlink(target, os.path.join(self.root, str(pid), "fd", str(fd)))
        with open(os.path.join(self.root, str(pid), "fdinfo", str(fd)), "w") as f:
            f.write(info)

    def test_a_dri_descriptor_makes_a_client_and_its_engines_its_time(self) -> None:
        info = "pos:\t0\ndrm-driver:\tamdgpu\ndrm-client-id:\t12\ndrm-engine-gfx:\t1500000000 ns\ndrm-engine-compute:\t500 ns\n"
        self.client(300, 5, "/dev/dri/renderD128", info)
        self.client(300, 6, "/dev/dri/renderD128", info)  # the same client twice counts once
        self.client(301, 3, "/dev/dri/card1", "pos:\t0\n")  # no drm-* keys: listed without a time
        # Client id 12 again, on another device: a client of its own.
        self.client(303, 4, "/dev/dri/renderD128", "drm-pdev:\t0000:03:00.0\ndrm-client-id:\t12\ndrm-engine-gfx:\t7 ns\n")
        self.client(303, 5, "/dev/dri/renderD129", "drm-pdev:\t0000:c4:00.0\ndrm-client-id:\t12\ndrm-engine-gfx:\t5 ns\n")
        self.client(302, 3, "/dev/null", "drm-driver:\tamdgpu\n")  # not a DRM descriptor
        os.makedirs(os.path.join(self.root, "self"))
        found = cotenants.probe_drm(self.root)
        self.assertEqual(found.status, "ran")
        self.assertEqual(found.processes, ((300, {"driver": "amdgpu", "gpu_time_ns": 1500000500}), (301, {}),
                                           (303, {"gpu_time_ns": 12})))

    def test_no_proc_is_absent(self) -> None:
        self.assertEqual(cotenants.probe_drm(os.path.join(self.root, "none")).status, "absent")

    def test_a_scan_that_blocks_is_given_up_on_as_failed(self) -> None:
        release = threading.Event()

        def blocked(root: str) -> cotenants.Found:
            release.wait(10)
            return cotenants.Found("drm-fdinfo", "ran", "")

        with mock.patch.object(cotenants, "probe_drm", blocked):
            found = cotenants.bounded_drm(self.root, 0.2)
        release.set()
        self.assertEqual((found.status, found.detail), ("failed", "no answer after 0.2s"))


IOREG = """+-o AGXDeviceUserClient  <class AGXDeviceUserClient, id 0x1>
    {
      "AppUsage" = ()
      "IOUserClientCreator" = "pid 453, runningboardd"
    }
+-o AGXDeviceUserClient  <class AGXDeviceUserClient, id 0x2>
    {
      "AppUsage" = ({"API"="Metal","lastSubmittedTime"=1,"accumulatedGPUTime"=2000},{"API"="Metal","accumulatedGPUTime"=3})
      "IOUserClientCreator" = "pid 432, WindowServer"
    }
+-o AGXDeviceUserClient  <class AGXDeviceUserClient, id 0x3>
    {
      "AppUsage" = ({"API"="Metal","accumulatedGPUTime"=5})
      "IOUserClientCreator" = "pid 432, WindowServer"
    }
"""


class Ioreg(unittest.TestCase):
    def test_each_client_names_its_pid_and_its_gpu_time_is_summed(self) -> None:
        run = FakeRun({"sh": (0, IOREG)})
        found = cotenants.probe_ioreg("sh", run)
        self.assertEqual(found.processes, ((432, {"gpu_time_ns": 2008}), (453, {})))
        self.assertEqual(run.calls[0][1:], ["-r", "-c", "IOGPUDeviceUserClient", "-l", "-w0"])


class Snapshot(unittest.TestCase):
    def test_the_hold_its_descendants_and_the_command_group_are_left_out(self) -> None:
        # 10 the hold's caller, 20 the hold, 21 its child, 30 the command's group (leader gone),
        # 31 a reparented leftover in that group, 40 a co-tenant.
        table = {10: (1, 10), 20: (10, 10), 21: (20, 10), 31: (1, 30), 40: (1, 40)}
        self.assertEqual(cotenants.own_tree(table, 20, 30), {20, 21, 30, 31})
        self.assertEqual(cotenants.own_tree(table, 20, None), {20, 21})
        # A nested hold leaves out its enclosing measurement's group, its own (10 here).
        self.assertEqual(cotenants.own_tree(table, 20, None, 10), {10, 20, 21})

    def test_a_snapshot_lists_the_co_tenant_with_its_name_and_counts_the_own(self) -> None:
        ps_table = "10 1 10\n20 10 10\n31 1 30\n40 1 40\n"
        smi = "40, python3, 512\n31, leftover, 64\n20, hold, 1\n10, caller, 2\n"
        answers = {"sh": (0, smi), "ps": (0, ps_table)}

        def run(argv: Sequence[str]) -> tuple[int, str]:
            if argv[0] == "ps" and "-p" in argv:
                self.assertEqual(argv[-1], "10,40")
                return 0, ("   10 lukstafi Thu Oct 15 17:00:49 2026 claude\n"
                           "   40 alice Thu Oct 15 16:59:01 2026 python3 train.py --big\n")
            return FakeRun(answers)(argv)

        env = {"FLEET_NVIDIA_SMI": "sh", "FLEET_DRM_PROC": "/nonexistent", "FLEET_IOREG": "/nonexistent/ioreg"}
        line = cotenants.snapshot(env, "closed", "m-1", "minix", 20, 30, run)
        self.assertEqual([p["pid"] for p in line["gpu_processes"]], [10, 40])
        self.assertEqual(line["gpu_processes"][1], {"pid": 40, "started": "Thu Oct 15 16:59:01 2026", "user": "alice",
                                                    "command": "python3 train.py --big", "probe": "nvidia-smi",
                                                    "gpu_memory_mib": 512})
        self.assertEqual(line["own_tree_gpu_processes"], 2)
        self.assertEqual((line["request_id"], line["box"], line["hold_pid"], line["event"]), ("m-1", "minix", 20, "closed"))
        self.assertEqual([p["status"] for p in line["probes"]], ["ran", "absent", "absent"])


def proc(pid: int, probe: str, **fields: Any) -> dict[str, Any]:
    return {"pid": pid, "user": "u", "command": f"cmd{pid}", "probe": probe, **fields}


def line(event: str, processes: list[dict[str, Any]], hold: int = 7) -> dict[str, Any]:
    return {"hold_pid": hold, "event": event, "at": f"T-{event}", "gpu_processes": processes,
            "probes": [{"probe": "ioreg", "status": "ran", "detail": ""}, {"probe": "nvidia-smi", "status": "absent", "detail": ""}]}


class Summary(unittest.TestCase):
    def test_the_busy_co_tenant_is_named_with_its_time_in_the_hold(self) -> None:
        opened = line("opened", [proc(1, "ioreg", gpu_time_ns=5_000_000_000), proc(2, "ioreg", gpu_time_ns=10)])
        closed = line("closed", [proc(1, "ioreg", gpu_time_ns=6_500_000_000), proc(2, "ioreg", gpu_time_ns=10),
                                 proc(3, "ioreg", gpu_time_ns=250_000_000)])
        text = cotenants.summary([opened, closed])
        self.assertIn("hold 7 opened T-opened: 2 [pid 1 u cmd1 (ioreg, 5.00 s GPU time so far)", text)
        self.assertIn("GPU time used during it by: pid 1 u cmd1 +1.50 s (ioreg); pid 3 u cmd3 +0.25 s (ioreg);", text)
        self.assertIn("closed T-closed: 3 [", text)
        self.assertIn("(ioreg ran)", text)

    def test_a_reused_pid_is_a_new_process(self) -> None:
        opened = line("opened", [proc(1, "ioreg", gpu_time_ns=5_000_000_000, started="A")])
        closed = line("closed", [proc(1, "ioreg", gpu_time_ns=2_000_000_000, started="B")])
        self.assertEqual(cotenants.busy_during(opened, closed), ["pid 1 u cmd1 +2.00 s (ioreg)"])

    def test_a_hold_with_no_close_and_an_empty_box_say_so(self) -> None:
        text = cotenants.summary([line("opened", [])])
        self.assertEqual(text, "hold 7 opened T-opened: none (ioreg ran); no closed snapshot (the hold did not end normally)")
        self.assertEqual(cotenants.summary(cotenants.read_lines("not json\n")), "no snapshot in it")

    def test_two_holds_are_two_clauses_and_long_lists_are_cut(self) -> None:
        many = [proc(i, "nvidia-smi", gpu_memory_mib=i) for i in range(1, 12)]
        text = cotenants.summary([line("opened", many, 1), line("closed", [], 1), line("opened", [], 2), line("closed", [], 2)])
        self.assertEqual(text.count(" | "), 1)
        self.assertIn("pid 11 u cmd11 (nvidia-smi, 11 MiB)", text)
        self.assertIn("+3 more", text)

    def test_the_record_round_trips_through_its_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = cotenants.record_path(tmp, "m-1")
            cotenants.append(path, line("opened", [proc(1, "drm-fdinfo")]))
            cotenants.append(path, line("closed", []))
            with open(path, encoding="utf-8") as f:
                self.assertEqual([entry["event"] for entry in cotenants.read_lines(f.read())], ["opened", "closed"])
            self.assertTrue(path.endswith("/measurement.m-1.gpu.jsonl"))

    def test_a_short_write_is_an_error_not_a_torn_line_said_nowhere(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(cotenants.os, "write", return_value=3):
            with self.assertRaisesRegex(OSError, "short write: 3 of"):
                cotenants.append(cotenants.record_path(tmp, "m-1"), line("opened", []))


if __name__ == "__main__":
    unittest.main()
