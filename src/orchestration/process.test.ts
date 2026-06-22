import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runnerLaunchCommand, startOrchestrationProcess } from "./process.ts";

describe("runnerLaunchCommand", () => {
  const cmd = ["/path/to/ludics", "orch", "run-internal", "3"];

  test("Linux + systemd-run present + user systemd → systemd-run --user --scope --collect, original command at tail", () => {
    const argv = runnerLaunchCommand(cmd, {
      platform: "linux",
      systemdRunPath: "/usr/bin/systemd-run",
      hasUserSystemd: true,
    });
    // The cgroup-escape invariant: the runner is launched into its own transient
    // scope, NOT as a direct setsid child of the reaping cgroup.
    expect(argv.slice(0, 4)).toEqual(["/usr/bin/systemd-run", "--user", "--scope", "--collect"]);
    // The orch run-internal command must survive verbatim as the tail.
    expect(argv.slice(4)).toEqual(cmd);
  });

  test("Linux + systemd-run absent → falls back to setsidWrap shape (no systemd-run)", () => {
    const argv = runnerLaunchCommand(cmd, {
      platform: "linux",
      systemdRunPath: null,
      hasUserSystemd: true,
      resolvedSetsid: "/usr/bin/setsid",
    });
    expect(argv[0]).not.toBe("systemd-run");
    expect(argv).toEqual(["/usr/bin/setsid", ...cmd]);
  });

  test("Linux + systemd-run present but no user systemd → falls back to setsidWrap", () => {
    const argv = runnerLaunchCommand(cmd, {
      platform: "linux",
      systemdRunPath: "/usr/bin/systemd-run",
      hasUserSystemd: false,
      resolvedSetsid: "/usr/bin/setsid",
    });
    expect(argv).not.toContain("systemd-run");
    expect(argv).toEqual(["/usr/bin/setsid", ...cmd]);
  });

  test("macOS (darwin) → unchanged setsid/perl wrapper, never systemd-run", () => {
    const argv = runnerLaunchCommand(cmd, {
      platform: "darwin",
      // even if a (nonsensical) systemd-run path were resolved, darwin must not use it
      systemdRunPath: "/usr/bin/systemd-run",
      hasUserSystemd: true,
      resolvedSetsid: null, // force the perl POSIX fallback branch of setsidWrap
    });
    expect(argv).not.toContain("--scope");
    expect(argv[0]).toBe("perl");
    expect(argv.slice(-cmd.length)).toEqual(cmd);
  });
});

describe("startOrchestrationProcess stdio", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  test("directs both stdout and stderr to the per-slot log fd (stdout no longer discarded)", async () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "ludics-584-proc-"));
    mkdirSync(join(harnessDir, "orchestration"), { recursive: true });
    const captured: Array<Record<string, unknown>> = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
      captured.push(args[1] as Record<string, unknown>);
      // Pretend the runner is alive (exitCode null) so the immediate-exit check passes.
      return { pid: 4242, exitCode: null, unref() {} } as never;
    });
    spies.push(spawnSpy);
    const sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined as never);
    spies.push(sleepSpy);

    const pid = await startOrchestrationProcess(3, harnessDir, "task-abc");
    expect(pid).toBe(4242);

    expect(captured.length).toBe(1);
    const opts = captured[0]!;
    // Regression invariant: stdout must NOT be "ignore" (the gh-ludics-584 bug)
    // and must share the exact fd used for stderr.
    expect(opts.stdout).not.toBe("ignore");
    expect(typeof opts.stdout).toBe("number");
    expect(opts.stdout).toBe(opts.stderr);
    expect(opts.stdin).toBe("ignore");
  });
});
