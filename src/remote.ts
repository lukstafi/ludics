// Remote execution — SSH-based command dispatch to federation machines

import { federationMachine, federationCurrentMachineName } from "./federation.ts";

const SSH_CONNECT_TIMEOUT = "5";

function resolveHostname(machineName: string): string {
  const machine = federationMachine(machineName);
  if (machine?.host) return machine.host;
  throw new Error(`federation: unknown machine "${machineName}" — not found in federation.machines`);
}

function remoteLudicsPath(machineName: string): string {
  return federationMachine(machineName)?.ludics_path ?? "ludics";
}

function sshArgs(hostname: string): string[] {
  return [
    "ssh",
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    "-o", "BatchMode=yes",   // never prompt for password
    hostname,
  ];
}

/** Synchronous remote exec — blocks until command completes. */
export function remoteExec(
  machineName: string,
  args: string[],
): { success: boolean; stdout: string; stderr: string } {
  const hostname = resolveHostname(machineName);
  const ludicsPath = remoteLudicsPath(machineName);
  const cmd = [...sshArgs(hostname), ludicsPath, ...args];

  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    success: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/**
 * Fire-and-forget remote exec — starts command on remote machine, returns immediately.
 * Uses nohup on remote side so process survives SSH disconnection.
 */
export function remoteExecAsync(
  machineName: string,
  args: string[],
): void {
  const hostname = resolveHostname(machineName);
  const ludicsPath = remoteLudicsPath(machineName);
  // Use nohup to detach from SSH session on the remote side
  const remoteCmd = `nohup ${ludicsPath} ${args.join(" ")} </dev/null >/dev/null 2>&1 &`;
  const cmd = [...sshArgs(hostname), remoteCmd];

  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  proc.unref();
}

/** Check if a remote machine is reachable via SSH. */
export function remotePing(machineName: string): boolean {
  const hostname = resolveHostname(machineName);
  const result = Bun.spawnSync(
    [...sshArgs(hostname), "true"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return result.exitCode === 0;
}

/**
 * Check if the given machine name refers to a remote machine (not this one).
 * When a machine name is explicitly set but we can't determine our own identity,
 * treat it as remote (fail closed) to avoid running local adapter actions on the
 * wrong host.
 */
export function isRemoteMachine(machineName: string): boolean {
  if (!machineName || machineName === "null" || machineName === "local") return false;
  const currentName = federationCurrentMachineName();
  if (!currentName) return true; // can't determine our identity — treat as remote (fail closed)
  return machineName !== currentName;
}
