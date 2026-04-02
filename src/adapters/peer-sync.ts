// .peer-sync/ and .agent-sessions/ reader — replaces adapters/helpers.sh
//
// Eliminates python3 dependency (uses JSON.parse for state.json fallback).
// Reads both the old .peer-sync/ individual-file format and the newer
// .agent-sessions/<prefix>-<task>.session key=value files.

import { existsSync, readFileSync, readdirSync, readlinkSync, lstatSync, statSync } from "fs";
import { join, basename, dirname } from "path";
import { readSingleFile } from "./base.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionInfo {
  taskId: string;
  rootWorktree: string;
  peerSyncPath: string;
}

export interface BasicState {
  phase: string;
  round: string;
  session: string;
  taskId: string;
  mode: string;
}

export interface AgentSessionInfo {
  agent: string;
  task: string;
  tmux: string;
  mode: string;
  workdir: string;
  worktree: string;
  ttydPort: string;
  ttydPid: string;
  started: string;
  [key: string]: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Session discovery via .agent-sessions/ registry
// ---------------------------------------------------------------------------

/**
 * Find a session file in .agent-sessions/ matching a task ID or name prefix.
 * Prefers exact taskId match over prefix match.
 */
export function findSessionByPrefixOrTask(
  projectDir: string,
  taskId: string,
  prefixes: string[],
): string | null {
  const sessionsDir = join(projectDir, ".agent-sessions");
  if (!existsSync(sessionsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return null;
  }

  const sessionEntries = entries.filter((e) => e.endsWith(".session"));

  // First pass: prefer task ID match
  if (taskId) {
    for (const entry of sessionEntries) {
      if (entry.includes(taskId)) {
        return join(sessionsDir, entry);
      }
    }
  }

  // Second pass: fall back to prefix match
  for (const entry of sessionEntries) {
    if (prefixes.some((p) => entry.startsWith(p))) {
      return join(sessionsDir, entry);
    }
  }

  return null;
}

/** List all active sessions for a project via .agent-sessions/ symlinks. */
export function listSessions(projectDir: string): SessionInfo[] {
  const sessionsDir = join(projectDir, ".agent-sessions");
  if (!existsSync(sessionsDir)) return [];

  const results: SessionInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".session")) continue;
    const linkPath = join(sessionsDir, entry);

    // Must be a symlink
    try {
      if (!lstatSync(linkPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }

    let peerSyncPath: string;
    try {
      peerSyncPath = readlinkSync(linkPath);
    } catch {
      continue;
    }

    // Validate target exists
    if (!existsSync(peerSyncPath)) continue;

    const taskId = basename(entry, ".session");
    const rootWorktree = dirname(peerSyncPath);
    results.push({ taskId, rootWorktree, peerSyncPath });
  }

  return results;
}

/** Get session count, optionally filtered by mode. */
export function sessionCount(projectDir: string, modeFilter?: string): number {
  const sessions = listSessions(projectDir);
  if (!modeFilter) return sessions.length;
  return sessions.filter((s) => {
    const mode = readSingleFile(join(s.peerSyncPath, "mode"));
    return mode === modeFilter;
  }).length;
}

// ---------------------------------------------------------------------------
// State reading
// ---------------------------------------------------------------------------

/** Read basic state from a .peer-sync directory. Falls back to state.json. */
export function readBasicState(syncDir: string): BasicState {
  const state: BasicState = { phase: "", round: "", session: "", taskId: "", mode: "" };

  // Primary: individual files
  state.phase = readSingleFile(join(syncDir, "phase")) ?? "";
  state.round = readSingleFile(join(syncDir, "round")) ?? "";
  state.session = readSingleFile(join(syncDir, "session")) ?? "";
  state.taskId = readSingleFile(join(syncDir, "task-id")) ?? readSingleFile(join(syncDir, "feature")) ?? "";
  state.mode = readSingleFile(join(syncDir, "mode")) ?? "";

  // Fallback to JSON state file if individual files are empty
  if (!state.phase && !state.session) {
    const stateFile = join(syncDir, "state.json");
    if (existsSync(stateFile)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf-8"));
        if (isRecord(parsed)) {
          state.phase = typeof parsed.phase === "string" ? parsed.phase : "";
          state.round = String(parsed.round ?? "");
          state.session = typeof parsed.session === "string" ? parsed.session : "";
          state.taskId = typeof parsed.feature === "string" ? parsed.feature : "";
          state.mode = typeof parsed.mode === "string" ? parsed.mode : "";
        }
      } catch {
        // Invalid JSON — leave defaults
      }
    }
  }

  return state;
}

/** Read ports file (key=value) from a sync directory. */
export function readPorts(syncDir: string): Map<string, string> {
  const portsFile = join(syncDir, "ports");
  if (!existsSync(portsFile)) return new Map();
  const map = new Map<string, string>();
  const content = readFileSync(portsFile, "utf-8");
  for (const line of content.split("\n")) {
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return map;
}

/** Read worktrees JSON from sync directory. */
export function readWorktrees(syncDir: string): Record<string, string> {
  const worktreesFile = join(syncDir, "worktrees.json");
  if (!existsSync(worktreesFile)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(worktreesFile, "utf-8"));
    if (!isRecord(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Get aggregated status across all sessions in a project. */
export function aggregatedStatus(projectDir: string, modeFilter?: string): string {
  const sessions = listSessions(projectDir);
  let total = 0;
  let workCount = 0;
  let reviewCount = 0;

  for (const s of sessions) {
    if (modeFilter) {
      const mode = readSingleFile(join(s.peerSyncPath, "mode"));
      if (mode !== modeFilter) continue;
    }
    total++;
    const phase = readSingleFile(join(s.peerSyncPath, "phase")) ?? "";
    if (phase === "work") workCount++;
    else if (phase === "review" || phase === "pr-comments") reviewCount++;
  }

  if (total === 0) return "inactive";
  if (workCount > 0) return `working (${workCount} of ${total})`;
  if (reviewCount > 0) return `reviewing (${reviewCount} of ${total})`;
  return `active (${total} sessions)`;
}

/** Get phase/round status string: "phase (round N)" or "phase" or "active". */
export function getPhaseStatus(syncDir: string): string {
  const state = readBasicState(syncDir);
  if (state.phase && state.round) return `${state.phase} (round ${state.round})`;
  if (state.phase) return state.phase;
  return "active";
}

// ---------------------------------------------------------------------------
// .agent-sessions/ key=value session files (agent-launch format)
// ---------------------------------------------------------------------------

/** Read an .agent-sessions/*.session key=value file. Returns null if missing or if path is a directory (symlink to .peer-sync). */
export function readAgentSessionFile(path: string): AgentSessionInfo | null {
  if (!existsSync(path)) return null;
  // Guard: symlinked .session entries may point to directories (.peer-sync/)
  try {
    if (statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  const content = readFileSync(path, "utf-8");
  const info: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    info[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return {
    agent: info.agent ?? "",
    task: info.task ?? "",
    tmux: info.tmux ?? "",
    mode: info.mode ?? "",
    workdir: info.workdir ?? "",
    worktree: info.worktree ?? "",
    ttydPort: info.ttyd_port ?? "",
    ttydPid: info.ttyd_pid ?? "",
    started: info.started ?? "",
    ...info,
  };
}
