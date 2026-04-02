// Shared orchestration process management — spawns the detached runner subprocess.
// Transport-agnostic: the runner itself selects the transport based on globalAdapter().

import { openSync, readFileSync } from "fs";
import { join } from "path";
import { ludicsSelfCommand } from "./util.ts";

/**
 * Spawn the orchestration runner as a detached background process for a slot.
 * Returns the PID of the spawned process. Throws if the process exits immediately.
 */
export async function startOrchestrationProcess(slot: number, harnessDir: string, taskId: string): Promise<number> {
  const logPath = join(harnessDir, "orchestration", `slot-${slot}-${taskId}.log`);
  const logFd = openSync(logPath, "a");
  const proc = Bun.spawn(ludicsSelfCommand(["orch", "run-internal", String(slot)]), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: logFd,
    env: {
      ...(process.env as Record<string, string>),
      LUDICS_HARNESS_DIR: harnessDir,
    },
  });
  if (typeof (proc as { unref?: () => void }).unref === "function") {
    (proc as { unref: () => void }).unref();
  }

  await Bun.sleep(500);
  if (proc.exitCode !== null) {
    const log = readFileSync(logPath, "utf-8").slice(-2000);
    throw new Error(`Orchestration runner exited immediately (code ${proc.exitCode}):\n${log}`);
  }

  return proc.pid;
}
