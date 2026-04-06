// Remote utilities — machine identity checks

import { federationCurrentMachineName } from "./federation.ts";

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
