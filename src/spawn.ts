// All production Bun.spawnSync calls must go through safeSyncOutput.
// Exception: inherited-stdio terminal-attach in mag.ts (see comment there).

export interface SyncResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Service-manager binaries that address the user's launchd/systemd domain by
 *  uid and therefore ESCAPE the HOME sandbox tests rely on. Running them for
 *  real during a test would mutate the live machine's actual jobs (e.g.
 *  bootout the controller's com.ludics.dashboard). They are skipped under
 *  LUDICS_TEST_MODE (set by src/test-setup.ts). */
const TEST_BLOCKED_BINARIES = new Set(["launchctl", "systemctl"]);

/** Run a command synchronously. Never throws.
 *  Returns { ok: false, exitCode: -1 } on ENOENT or missing cwd.
 *  stdout/stderr are trimmed by default; pass { trim: false } to preserve raw output.
 */
export function safeSyncOutput(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; trim?: boolean; timeout?: number },
): SyncResult {
  // In test runs, never execute real service-manager commands against the live
  // host — they ignore HOME and hit the user's actual launchd/systemd domain.
  // Return the same benign "not available" shape callers already tolerate on a
  // platform without the binary (every launchctl/systemctl call site treats it
  // as best-effort), so the trigger functions' file-level effects still run and
  // their tests stay green while the live domain is left untouched.
  if (process.env.LUDICS_TEST_MODE && TEST_BLOCKED_BINARIES.has(cmd[0])) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "skipped under LUDICS_TEST_MODE", timedOut: false };
  }
  try {
    const result = Bun.spawnSync(cmd, {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: opts?.env ?? (process.env as Record<string, string>),
      timeout: opts?.timeout,
    });
    const trim = opts?.trim !== false;
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    if (result.exitCode === null) {
      return {
        ok: false,
        exitCode: -1,
        timedOut: true,
        stdout: trim ? out.trim() : out,
        stderr: trim ? err.trim() : err,
      };
    }
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: trim ? out.trim() : out,
      stderr: trim ? err.trim() : err,
      timedOut: false,
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }
}
