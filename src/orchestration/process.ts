// Shared orchestration process management — spawns the detached runner subprocess.
// Transport-agnostic: the runner itself selects the transport based on globalAdapter().

import { openSync, readFileSync } from "fs";
import { join } from "path";
import { ludicsSelfCommand, setsidWrap } from "./util.ts";

/**
 * Spawn the orchestration runner as a detached background process for a slot.
 * Returns the PID of the spawned process. Throws if the process exits immediately.
 *
 * gh-ludics-584: on a federation **worker** the keepalive is a `Type=oneshot`
 * `ludics-mag.service` whose default `KillMode=control-group` reaps the entire
 * cgroup — including this `setsid`-detached, `unref()`'d runner — the moment the
 * oneshot's main process exits, so the runner never advances past `setup`. The
 * fix lives in the generated unit (`KillMode=process`, see `src/triggers.ts`):
 * once the keepalive's main process is the only thing killed on exit, the
 * detached descendant survives. We deliberately do NOT wrap the runner in
 * `systemd-run --user --scope` here: a scope runs the command under a
 * long-lived `systemd-run` supervisor, so `Bun.spawn`'s pid would be that
 * wrapper, not the runner — `slotResume` persists it as the sibling
 * orchestration pid and the runner's pid-based self-guard (`runner.ts`) then
 * exits on the live-pid mismatch (the gh-509 reclaim only triggers for a *dead*
 * recorded pid). `setsid`/`perl` exec the runner in place, so `proc.pid` is the
 * runner's real pid. See the gh-ludics-584 proposal AC 2 note.
 */
export async function startOrchestrationProcess(slot: number, harnessDir: string, taskId: string): Promise<number> {
  const logPath = join(harnessDir, "orchestration", `slot-${slot}-${taskId}.log`);
  const logFd = openSync(logPath, "a");
  const proc = Bun.spawn(setsidWrap(ludicsSelfCommand(["orch", "run-internal", String(slot)])), {
    stdin: "ignore",
    // gh-ludics-584: capture stdout too (merged into the same per-slot log fd as
    // stderr) so a silent runner death is diagnosable without guessing the sink.
    stdout: logFd,
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
