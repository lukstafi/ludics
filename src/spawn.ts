// All production Bun.spawnSync calls must go through safeSyncOutput.
// Exception: inherited-stdio terminal-attach in mag.ts (see comment there).

export interface SyncResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command synchronously. Never throws.
 *  Returns { ok: false, exitCode: -1 } on ENOENT or missing cwd.
 *  stdout/stderr are trimmed by default; pass { trim: false } to preserve raw output.
 */
export function safeSyncOutput(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; trim?: boolean; timeout?: number },
): SyncResult {
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
