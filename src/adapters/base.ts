// Shared adapter utilities — state dir, key=value I/O, status files, git worktree
//
// Replaces repeated Bash patterns: macOS/Linux sed branching, grep/cut parsing,
// eval injection. All key=value updates use Map + atomic write.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join, dirname } from "path";
import { harnessDir } from "../config.ts";
import { PEER_SYNC_DIRNAME } from "../orchestration/peer-sync.ts";
import type { AgentStatus } from "./types.ts";

// ---------------------------------------------------------------------------
// Session / thread naming — single convention for tmux sessions and t3code threads
// ---------------------------------------------------------------------------

/**
 * Canonical name for a slot session or thread.
 *
 * With role:    s<slot>_<role>_<suffix>   (per-agent session)
 * Without role: s<slot>_<suffix>          (slot-level title)
 *
 * Suffix is taskId when present, otherwise the provided fallback (or role).
 */
export function slotSessionName(slot: number, role?: string, taskId?: string, fallback?: string): string {
  const suffix = taskId && taskId !== "null" ? taskId : (fallback ?? role ?? "unknown");
  return role ? `s${slot}_${role}_${suffix}` : `s${slot}_${suffix}`;
}

// ---------------------------------------------------------------------------
// State directory
// ---------------------------------------------------------------------------

/** Get the state directory for a named adapter (e.g. "manual", "claude-ai"). */
export function adapterStateDir(name: string): string {
  return join(harnessDir(), name);
}

/** Ensure the adapter state directory exists, creating it if needed. */
export function ensureAdapterStateDir(name: string): string {
  const dir = adapterStateDir(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Key=value file I/O
// ---------------------------------------------------------------------------

/** Read a key=value file into a Map. Lines starting with # are skipped. */
export function readStateFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return map;
}

/** Read a single key from a key=value file. */
export function readStateKey(path: string, key: string): string | undefined {
  return readStateFile(path).get(key);
}

/** Write a Map as a key=value file (atomic via rename). */
export function writeStateFile(path: string, data: Map<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (const [k, v] of data) {
    lines.push(`${k}=${v}`);
  }
  const tmp = path + ".tmp";
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, path);
}

/** Update a single key in a key=value file (read-modify-write, atomic). */
export function updateStateKey(path: string, key: string, value: string): void {
  const data = readStateFile(path);
  data.set(key, value);
  writeStateFile(path, data);
}

/** Remove a key from a key=value file (read-modify-write, atomic). */
export function removeStateKey(path: string, key: string): void {
  const data = readStateFile(path);
  if (!data.has(key)) return;
  data.delete(key);
  writeStateFile(path, data);
}

// ---------------------------------------------------------------------------
// Status files (pipe-delimited: status|epoch|message)
// ---------------------------------------------------------------------------

/** Read a pipe-delimited status file. Returns null if missing or empty. */
export function readStatusFile(path: string): AgentStatus | null {
  if (!existsSync(path)) return null;
  const line = readFileSync(path, "utf-8").trim();
  if (!line) return null;
  const parts = line.split("|");
  return {
    status: parts[0] ?? "",
    epoch: parseInt(parts[1] ?? "0", 10),
    message: parts.slice(2).join("|"),
  };
}

/** Write a pipe-delimited status file (atomic). */
export function writeStatusFile(path: string, status: string, message: string = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  const epoch = Math.floor(Date.now() / 1000);
  const tmp = path + ".tmp";
  writeFileSync(tmp, `${status}|${epoch}|${message}\n`);
  renameSync(tmp, path);
}

/** Format an AgentStatus for display: "status - message" or just "status". */
export function formatAgentStatus(s: AgentStatus): string {
  if (s.message) return `${s.status} - ${s.message}`;
  return s.status;
}

/** Human-readable relative time string from a unix epoch. */
export function timeAgo(epoch: number): string {
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Check if a directory is a git worktree (has a .git file, not directory). */
export function isGitWorktree(dir: string): boolean {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath)) return false;
  return statSync(gitPath).isFile();
}

/** Get the main repo path from a worktree's .git file. */
export function getMainRepoFromWorktree(dir: string): string | null {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath) || !statSync(gitPath).isFile()) return null;
  const content = readFileSync(gitPath, "utf-8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  // gitdir points to .git/worktrees/<name> — go up to main .git, then its parent
  const mainGit = dirname(dirname(match[1]!));
  return dirname(mainGit);
}

/** Get the current git branch of a directory. */
export function getGitBranch(dir: string): string | null {
  const result = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const branch = result.stdout.toString().trim();
  return branch || null;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Read a single file as a trimmed string. Returns null if missing. */
export function readSingleFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").trim() || null;
}

/** Current UTC timestamp in ISO 8601 format without milliseconds. */
export function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Return ISO timestamp of the most recently modified file among the given paths. */
export function latestMtime(paths: string[]): string | null {
  let latest = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const mt = statSync(p).mtimeMs;
      if (mt > latest) latest = mt;
    } catch { /* skip */ }
  }
  if (latest === 0) return null;
  return new Date(latest).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Project directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the project directory for an adapter context.
 * Checks ~/session, ~/repos/session, and optionally .peer-sync subdirectories.
 * @param session - session name from AdapterContext
 * @param checkPeerSync - also check for .peer-sync subdirectories (duo/pair)
 */
export function resolveProjectDir(session: string, checkPeerSync: boolean = false): string {
  if (session && session !== "null") {
    const home = process.env.HOME;
    if (home) {
      if (existsSync(`${home}/${session}`)) return `${home}/${session}`;
      if (existsSync(`${home}/repos/${session}`)) return `${home}/repos/${session}`;
      if (checkPeerSync) {
        if (existsSync(`${home}/${session}/${PEER_SYNC_DIRNAME}`)) return `${home}/${session}`;
        if (existsSync(`${home}/repos/${session}/${PEER_SYNC_DIRNAME}`)) return `${home}/repos/${session}`;
      }
    }
  }
  if (checkPeerSync && existsSync(`${process.cwd()}/${PEER_SYNC_DIRNAME}`)) return process.cwd();
  return process.cwd();
}
