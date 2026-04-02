import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { OrchestrationState } from "./state.ts";
import { makeId } from "./util.ts";

/** Canonical directory name for peer-sync state. */
export const PEER_SYNC_DIRNAME = ".peer-sync";

/** Build the peer-sync path for a given worktree root. */
export function peerSyncPath(rootWorktree: string): string {
  return join(rootWorktree, PEER_SYNC_DIRNAME);
}

/**
 * Resolve the peer-sync directory using a priority chain:
 *   CLI arg (if valid) > LUDICS_PEER_SYNC_DIR env var (if valid) > null.
 *
 * A directory is considered valid if it contains a `phase` file.
 * This mirrors the resolution order in `templates/hooks/ludics-on-stop.sh`.
 */
export function resolvePeerSyncDir(opts: { cliArg?: string }): string | null {
  // 1. CLI arg (if it has a phase file)
  if (opts.cliArg) {
    try {
      const content = readFileSync(join(opts.cliArg, "phase"), "utf-8").trim();
      if (content) return opts.cliArg;
    } catch {
      // not valid — fall through
    }
  }
  // 2. LUDICS_PEER_SYNC_DIR env var
  const envDir = process.env.LUDICS_PEER_SYNC_DIR;
  if (envDir) {
    try {
      const content = readFileSync(join(envDir, "phase"), "utf-8").trim();
      if (content) return envDir;
    } catch {
      // not valid — fall through
    }
  }
  return null;
}

export interface AgentStatusSnapshot {
  status: string;
  epoch: number;
  message: string;
}

function writeFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

export function initPeerSync(
  peerSyncDir: string,
  taskId: string,
  mode: "duo" | "pair",
  projectDir: string,
  agents: OrchestrationState["agents"],
  worktrees: Record<string, string>,
): void {
  mkdirSync(peerSyncDir, { recursive: true });
  mkdirSync(join(peerSyncDir, "reviews"), { recursive: true });
  mkdirSync(join(peerSyncDir, "plans"), { recursive: true });
  mkdirSync(join(peerSyncDir, "merge-votes"), { recursive: true });
  writeFile(join(peerSyncDir, "task-id"), taskId);
  writeFile(join(peerSyncDir, "mode"), mode);
  writeFile(join(peerSyncDir, "phase"), "setup");
  writeFile(join(peerSyncDir, "phase-token"), makeId("phase"));
  writeFile(join(peerSyncDir, "round"), "1");
  writeFile(join(peerSyncDir, "session"), taskId);
  writeFile(join(peerSyncDir, "state.json"), JSON.stringify({
    feature: taskId,
    mode,
    phase: "setup",
    round: 1,
    session: taskId,
  }, null, 2));
  writeFile(join(peerSyncDir, "worktrees.json"), JSON.stringify(worktrees, null, 2));

  const coder = agents.find((agent) => agent.role === "coder");
  const reviewer = agents.find((agent) => agent.role === "reviewer");
  if (coder) writeFile(join(peerSyncDir, "coder-agent"), coder.provider);
  if (reviewer) writeFile(join(peerSyncDir, "reviewer-agent"), reviewer.provider);

  for (const agent of agents) {
    writeFile(join(peerSyncDir, `${agent.name}.status`), `idle|0|awaiting-${agent.name}\n`);
  }

  const sessionsDir = join(projectDir, ".agent-sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionLink = join(sessionsDir, `${taskId}.session`);
  try {
    if (existsSync(sessionLink)) unlinkSync(sessionLink);
  } catch {
    // ignore
  }
  symlinkSync(peerSyncDir, sessionLink);
}

export function removePeerSyncSession(projectDir: string, taskId: string): void {
  const sessionLink = join(projectDir, ".agent-sessions", `${taskId}.session`);
  try {
    if (existsSync(sessionLink)) unlinkSync(sessionLink);
  } catch {
    // ignore
  }
}

export function writePeerSync(state: OrchestrationState, phaseToken?: string): void {
  const dir = state.peerSyncDir;
  mkdirSync(dir, { recursive: true });
  writeFile(join(dir, "phase"), state.phase);
  writeFile(join(dir, "phase-token"), phaseToken ?? makeId("phase"));
  writeFile(join(dir, "round"), String(state.round));
  writeFile(join(dir, "task-id"), state.taskId);
  writeFile(join(dir, "mode"), state.mode);
  writeFile(join(dir, "state.json"), JSON.stringify({
    feature: state.taskId,
    mode: state.mode,
    phase: state.phase,
    round: state.round,
    session: state.taskId,
  }, null, 2));
}

export function readAgentStatus(dir: string, agent: string): AgentStatusSnapshot {
  const path = join(dir, `${agent}.status`);
  if (!existsSync(path)) {
    return { status: "unknown", epoch: 0, message: "" };
  }
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return { status: "unknown", epoch: 0, message: "" };
  const [status, epochStr, ...messageParts] = content.split("|");
  return {
    status: status ?? "unknown",
    epoch: parseInt(epochStr ?? "0", 10) || 0,
    message: messageParts.join("|"),
  };
}

export function writeInterrupt(dir: string, agent: string): void {
  writeFile(join(dir, `${agent}.interrupt`), "");
}

export function clearInterrupt(dir: string, agent: string): void {
  const path = join(dir, `${agent}.interrupt`);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function readPrUrl(dir: string, agent: string): string | null {
  const path = join(dir, `${agent}.pr`);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf-8").trim();
  return value || null;
}

export function readMarker(dir: string, name: string): string | null {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf-8").trim();
  return value || null;
}

/**
 * Return a fingerprint of the agent's .status file for stale-detection.
 * Combines file content with mtime so that identical content written at a new
 * time still counts as a change.
 */
export function statusFileFingerprint(dir: string, agent: string): string | null {
  const path = join(dir, `${agent}.status`);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8").trim();
    const mtime = statSync(path).mtimeMs;
    return `${content}|${mtime}`;
  } catch {
    return null;
  }
}

/** Read the phase token currently written in .peer-sync. */
export function readPhaseToken(dir: string): string | null {
  const path = join(dir, "phase-token");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").trim() || null;
}

/** Stop-hook record written by `ludics orch on-stop`. */
export interface StopHookRecord {
  agent: string;
  provider: string;
  phase: string;
  phaseToken: string;
  observedAt: string;
  cwd: string;
  hookEventName: string;
}

/** Write a stop-hook record for an agent. */
export function writeStopHookRecord(peerSyncDir: string, record: StopHookRecord): void {
  writeFile(join(peerSyncDir, `${record.agent}.stop.json`), JSON.stringify(record, null, 2));
}

/** Read the most recent stop-hook record for an agent, or null. */
export function readStopHookRecord(peerSyncDir: string, agent: string): StopHookRecord | null {
  const path = join(peerSyncDir, `${agent}.stop.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StopHookRecord;
  } catch {
    return null;
  }
}

/**
 * Write a `.ludics-orchestration.json` marker file at each agent's worktree,
 * plus a project-level `.claude/settings.local.json` with a SessionStart hook
 * that injects `LUDICS_PEER_SYNC_DIR` and `LUDICS_AGENT_NAME` into the agent
 * session's environment via `$CLAUDE_ENV_FILE`.
 *
 * This satisfies the acceptance criterion of passing the peer-sync path via
 * env var at session startup — Claude Code's SessionStart hook fires when the
 * agent session initialises and the exported variables are available to all
 * subsequent hooks (including Stop).
 */
export function writeAgentMarkerFiles(
  peerSyncDir: string,
  agentWorktrees: Record<string, string>,
): void {
  for (const [name, worktreePath] of Object.entries(agentWorktrees)) {
    mkdirSync(worktreePath, { recursive: true });

    // 1. Marker file (read by the stop hook as a secondary fallback).
    const markerPath = join(worktreePath, ".ludics-orchestration.json");
    const marker = { agentName: name, peerSyncDir };
    writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n");

    // 2. Project-level Claude Code settings with SessionStart hook.
    //    This injects env vars into $CLAUDE_ENV_FILE at session start so they
    //    are available to the Stop hook without any marker-file discovery.
    const claudeDir = join(worktreePath, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.local.json");
    const escapedPeerSync = peerSyncDir.replace(/'/g, "'\\''");
    const escapedName = name.replace(/'/g, "'\\''");
    const envCommand =
      `echo 'export LUDICS_PEER_SYNC_DIR='"'"'${escapedPeerSync}'"'"'' >> "$CLAUDE_ENV_FILE" && ` +
      `echo 'export LUDICS_AGENT_NAME='"'"'${escapedName}'"'"'' >> "$CLAUDE_ENV_FILE"`;
    // Merge with existing settings to avoid clobbering project-level config.
    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      } catch {
        // Corrupted file — overwrite.
      }
    }
    const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
    const sessionStartHook = {
      matcher: "",
      hooks: [
        {
          type: "command" as const,
          command: envCommand,
        },
      ],
    };
    // Prepend our hook, preserving any existing SessionStart hooks.
    const existingSessionStart = Array.isArray(existingHooks.SessionStart)
      ? existingHooks.SessionStart
      : [];
    // Remove any previous ludics env hook (idempotent re-runs).
    const filtered = existingSessionStart.filter(
      (h: unknown) => {
        const hook = h as { hooks?: Array<{ command?: string }> };
        return !hook.hooks?.some((hh) => hh.command?.includes("LUDICS_PEER_SYNC_DIR"));
      },
    );
    const settings = {
      ...existing,
      hooks: {
        ...existingHooks,
        SessionStart: [sessionStartHook, ...filtered],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
}

/**
 * Read the agent marker file from a worktree path, if it exists.
 */
export function readAgentMarkerFile(
  worktreePath: string,
): { agentName: string; peerSyncDir: string } | null {
  const markerPath = join(worktreePath, ".ludics-orchestration.json");
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf-8")) as { agentName: string; peerSyncDir: string };
  } catch {
    return null;
  }
}

export function cleanupPeerSyncDir(dir: string): void {
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}
