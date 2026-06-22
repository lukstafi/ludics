// Shared orchestration process management — spawns the detached runner subprocess.
// Transport-agnostic: the runner itself selects the transport based on globalAdapter().

import { openSync, readFileSync } from "fs";
import { join } from "path";
import { ludicsSelfCommand, setsidWrap } from "./util.ts";

/**
 * Build the argv that launches the detached orchestration runner so it
 * outlives the process that spawned it.
 *
 * On a federation **worker** the keepalive is a `Type=oneshot`
 * `ludics-mag.service` whose default `KillMode=control-group` reaps the entire
 * cgroup — including a `setsid`-detached, `unref()`'d runner — the moment the
 * oneshot's main process exits (gh-ludics-584). `setsid` escapes the
 * controlling tty but NOT the systemd cgroup. On Linux with a user systemd
 * instance we therefore launch the runner via
 * `systemd-run --user --scope --collect`, which runs it in its own transient
 * *scope* unit (its own cgroup, created by the caller — so the runner stays its
 * own main process and `Bun.spawn`'s pid/exit semantics are preserved). The
 * `--collect` flag garbage-collects the scope when the runner exits.
 *
 * Everywhere else (macOS, or Linux without `systemd-run`/a user session) we
 * keep the existing `setsidWrap` behavior unchanged. Inputs default from the
 * environment but are overridable so tests can drive each branch without
 * touching the real OS — mirroring `setsidWrap(cmd, resolvedSetsid?)`.
 */
export function runnerLaunchCommand(
  command: string[],
  opts: {
    platform?: NodeJS.Platform;
    systemdRunPath?: string | null;
    hasUserSystemd?: boolean;
    resolvedSetsid?: string | null;
  } = {},
): string[] {
  const platform = opts.platform ?? process.platform;
  const systemdRunPath = opts.systemdRunPath !== undefined
    ? opts.systemdRunPath
    : (platform === "linux" ? (Bun.which("systemd-run") ?? null) : null);
  // A user systemd instance is required for `--user`; gate on a user-session
  // signal rather than probing (cheap, no subprocess). Conservative: when this
  // is uncertain we fall through to setsidWrap.
  const hasUserSystemd = opts.hasUserSystemd !== undefined
    ? opts.hasUserSystemd
    : !!(process.env.XDG_RUNTIME_DIR || process.env.DBUS_SESSION_BUS_ADDRESS);

  if (platform === "linux" && systemdRunPath && hasUserSystemd) {
    return [systemdRunPath, "--user", "--scope", "--collect", ...command];
  }
  return setsidWrap(command, opts.resolvedSetsid);
}

/**
 * Spawn the orchestration runner as a detached background process for a slot.
 * Returns the PID of the spawned process. Throws if the process exits immediately.
 */
export async function startOrchestrationProcess(slot: number, harnessDir: string, taskId: string): Promise<number> {
  const logPath = join(harnessDir, "orchestration", `slot-${slot}-${taskId}.log`);
  const logFd = openSync(logPath, "a");
  const proc = Bun.spawn(runnerLaunchCommand(ludicsSelfCommand(["orch", "run-internal", String(slot)])), {
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
