import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startOrchestrationProcess } from "./process.ts";

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
    // gh-ludics-584: the returned pid must be the runner's own pid (setsid/perl
    // exec in place). The mocked spawn returns 4242 as that pid.
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
