// Shared tmux operation wrappers — used by adapters and mag.ts

import { safeSyncOutput } from "../spawn.ts";

// trim: false — callers do their own .trim() or split on raw newlines (tmuxCapture, tmuxFindSessions)
function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = safeSyncOutput(["tmux", ...args], { trim: false });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/** Check if tmux is installed and available on PATH. */
export function tmuxAvailable(): boolean {
  return safeSyncOutput(["which", "tmux"]).ok;
}

/** Check if a specific tmux session exists. */
export function tmuxHasSession(name: string): boolean {
  return run(["has-session", "-t", name]).exitCode === 0;
}

/** Find sessions whose names match a pattern (case-insensitive substring). */
export function tmuxFindSessions(pattern: string): string[] {
  const { exitCode, stdout } = run(["list-sessions", "-F", "#{session_name}"]);
  if (exitCode !== 0) return [];
  const lower = pattern.toLowerCase();
  return stdout
    .trim()
    .split("\n")
    .filter((name) => name.toLowerCase().includes(lower));
}

/** Create a new detached tmux session. */
export function tmuxNewSession(name: string, cwd?: string): void {
  const args = ["new-session", "-d", "-s", name];
  if (cwd) args.push("-c", cwd);
  const { exitCode, stderr } = run(args);
  if (exitCode !== 0) {
    throw new Error(`tmux new-session failed: ${stderr.trim()}`);
  }
}

/** Kill a tmux session by name. */
export function tmuxKillSession(name: string): void {
  run(["kill-session", "-t", name]);
}

/**
 * Send keys to a tmux session.
 * When literal is true, uses -l to send keys literally (no special key lookup).
 */
export function tmuxSendKeys(session: string, keys: string, literal: boolean = false): boolean {
  const args = ["send-keys", "-t", session];
  if (literal) args.push("-l");
  args.push(keys);
  const { exitCode } = run(args);
  return exitCode === 0;
}

/** Send a command to a tmux session (literal text + Enter). */
export function tmuxSendCommand(session: string, command: string): boolean {
  const { exitCode } = run(["send-keys", "-t", session, command, "C-m"]);
  return exitCode === 0;
}

/** Capture pane content from a tmux session. Returns null if capture fails. */
export function tmuxCapture(session: string, lines: number = 100): string | null {
  const { exitCode, stdout } = run(["capture-pane", "-t", session, "-p", "-S", `-${lines}`]);
  if (exitCode !== 0) return null;
  return stdout;
}

/** Get the current working directory of the active pane in a session. */
export function tmuxPaneCwd(session: string): string | null {
  const { exitCode, stdout } = run([
    "display-message", "-t", session, "-p", "#{pane_current_path}",
  ]);
  if (exitCode !== 0) return null;
  const cwd = stdout.trim();
  return cwd || null;
}

/** Get the PID of the active pane process in a session. */
export function tmuxPanePid(session: string): number | null {
  const { exitCode, stdout } = run([
    "display-message", "-t", session, "-p", "#{pane_pid}",
  ]);
  if (exitCode !== 0) return null;
  const parsed = parseInt(stdout.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Check whether the active pane is currently in copy-mode. */
export function tmuxPaneInMode(session: string): boolean {
  const { exitCode, stdout } = run([
    "display-message", "-t", session, "-p", "#{pane_in_mode}",
  ]);
  if (exitCode !== 0) return false;
  return stdout.trim() === "1";
}

/** Cancel copy-mode in the active pane (best-effort). */
export function tmuxCancelMode(session: string): boolean {
  const { exitCode } = run(["send-keys", "-t", session, "-X", "cancel"]);
  return exitCode === 0;
}

/** Switch the active tmux client to another session (when already inside tmux). */
export function tmuxSwitchClient(session: string): boolean {
  const { exitCode } = run(["switch-client", "-t", session]);
  return exitCode === 0;
}

/**
 * Run a shell command inside a tmux session.
 * When background is true (default), runs asynchronously with -b flag.
 */
export function tmuxRunShell(session: string, shellCmd: string, background: boolean = true): void {
  const args = ["run-shell"];
  if (background) args.push("-b");
  args.push("-t", session, shellCmd);
  run(args);
}
