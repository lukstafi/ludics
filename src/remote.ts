// Remote utilities — hostname resolution, reachability checks, machine identity

import { federationMachine, federationCurrentMachineName } from "./federation.ts";

const SSH_CONNECT_TIMEOUT = "5";

function resolveHostname(machineName: string): string {
  const machine = federationMachine(machineName);
  if (machine?.host) return machine.host;
  throw new Error(`federation: unknown machine "${machineName}" — not found in federation.machines`);
}

function sshArgs(hostname: string): string[] {
  return [
    "ssh",
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT}`,
    "-o", "BatchMode=yes",   // never prompt for password
    hostname,
  ];
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
