// Remote utilities — machine identity checks + synchronous remote command exec

import { clusterCurrentMachineName, type ClusterMachine } from "./cluster.ts";
import { safeSyncOutput, type SyncResult } from "./spawn.ts";

/**
 * Check if the given machine name refers to a remote machine (not this one).
 * When a machine name is explicitly set but we can't determine our own identity,
 * treat it as remote (fail closed) to avoid running local adapter actions on the
 * wrong host.
 */
export function isRemoteMachine(machineName: string): boolean {
  if (!machineName || machineName === "null" || machineName === "local") return false;
  const currentName = clusterCurrentMachineName();
  if (!currentName) return true; // can't determine our identity — treat as remote (fail closed)
  return machineName !== currentName;
}

// --- Synchronous remote command execution (gh-ludics-578, Option A) ---

/** Outcome of a remote command attempt.
 *  - `ran`: ssh connected and the remote command produced a real exit status
 *    (the suite actually executed) — `ok` reflects the test command's success.
 *  - `transport-error`: ssh/connectivity failure — the suite never ran. The
 *    caller MUST degrade to skip-not-fail, never to a fix-task. */
export type RemoteRunResult =
  | { kind: "ran"; ok: boolean; stdout: string; stderr: string; timedOut: boolean }
  | { kind: "transport-error"; detail: string };

/**
 * Classify a raw ssh `SyncResult` into ran-vs-transport-error.
 *
 * ssh exit 255 = connection/auth/transport failure; `exitCode === -1` =
 * spawn/ENOENT or a local timeout (`safeSyncOutput` maps a killed process to
 * `-1` + `timedOut`); `timedOut` = the attempt never completed. All three are
 * transport failures → skip-not-fail. A remote *test* command that actually ran
 * and failed exits 1..254 → `ran` with `ok: false` → the caller files a fix-task.
 *
 * Conservative split (AC5): a remote timeout is treated as transport, NOT a
 * suite failure, so a hung/unreachable worker can never produce a false-positive
 * "Fix broken test suite" task.
 */
export function classifyRemoteResult(r: SyncResult): RemoteRunResult {
  if (r.exitCode === 255 || r.exitCode === -1 || r.timedOut) {
    return { kind: "transport-error", detail: r.stderr.slice(-300) || `ssh exit ${r.exitCode}` };
  }
  return { kind: "ran", ok: r.ok, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
}

/**
 * Build the remote shell script: change into the checkout, then run the command.
 *
 * The `|| exit 255` is load-bearing for the skip-not-fail invariant: a missing or
 * invalid remote checkout makes `cd` fail *before the suite runs*, which is a
 * setup/connectivity failure, NOT a test failure. Without the guard the failed
 * `cd` would exit with the shell's normal non-zero status (e.g. 1), ssh would
 * relay it, and `classifyRemoteResult` would mark it `ran`/`ok:false` → a
 * false-positive fix-task. Forcing the exit to ssh's transport sentinel (255)
 * routes a setup failure through the transport-error branch → skip.
 */
export function buildRemoteScript(cwd: string, cmd: string): string {
  return `cd ${cwd} || exit 255; ${cmd}`;
}

/**
 * Run `cmd` in `cwd` on `machine` over SSH, synchronously, returning a
 * classified result. `BatchMode=yes` fails fast on auth instead of prompting;
 * `ConnectTimeout` bounds the connect attempt for a nightly probe. A missing
 * remote checkout is mapped to a transport-error skip via `buildRemoteScript`.
 *
 * Remote env parity (e.g. `eval $(opam env)`) relies on the worker's login-shell
 * profile sourcing on the SSH command channel; deeper hardening is out of scope.
 * This file is the sole vetted ssh chokepoint in src/; it is allowlisted in
 * `scripts/lint-src-command-safety.ts` (`SRC_COMMAND_SAFETY_ALLOWLIST`), which
 * enforces that no other src/ file constructs an ssh/scp/rsync argv directly.
 */
export function runRemoteCommand(
  machine: ClusterMachine,
  cmd: string,
  opts: { cwd: string; timeout?: number },
): RemoteRunResult {
  const res = safeSyncOutput(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", machine.host, buildRemoteScript(opts.cwd, cmd)],
    { timeout: opts.timeout, trim: false },
  );
  return classifyRemoteResult(res);
}
