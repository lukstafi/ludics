// Session enrichment — orchestration context discovery
//
// For t3code-sourced sessions: read orchestration from T3CodeSlotState files.
// For non-t3code sessions (tmux Mag, legacy fallback): walk .peer-sync/ directories.

import { existsSync } from "fs";
import { join, dirname } from "path";
import type { DiscoveredSession, Orchestration } from "../types.ts";
import { readSlotState } from "../t3code/server.ts";
import { slotsCount } from "../config.ts";

async function readFileText(path: string): Promise<string> {
  try {
    const text = await Bun.file(path).text();
    return text.trim();
  } catch {
    return "";
  }
}

function findPeerSyncDir(cwd: string): string | null {
  let dir = cwd;
  while (dir) {
    const candidate = join(dir, ".peer-sync");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readOrchestration(peerSyncDir: string): Promise<Orchestration> {
  const mode = await readFileText(join(peerSyncDir, "mode"));
  const feature = await readFileText(join(peerSyncDir, "feature"));
  const phase = await readFileText(join(peerSyncDir, "phase"));
  const round = await readFileText(join(peerSyncDir, "round"));
  const coderAgent = await readFileText(join(peerSyncDir, "coder-agent"));
  const reviewerAgent = await readFileText(join(peerSyncDir, "reviewer-agent"));

  let type: Orchestration["type"];
  if (mode === "pair") {
    if (coderAgent === "codex") type = "agent-pair-codex";
    else if (coderAgent === "claude") type = "agent-pair-claude";
    else if (reviewerAgent === "codex") type = "agent-pair-claude";
    else type = "agent-pair-codex";
  } else {
    type = "agent-duo";
  }

  return {
    type,
    mode,
    feature,
    phase,
    round,
    peerSyncPath: peerSyncDir,
  };
}

/**
 * Build orchestration map from t3code slot state files.
 * Returns a map keyed by normalized cwd (worktreePath or project root).
 */
function enrichFromT3codeSlots(): Map<string, Orchestration> {
  const orchestrations = new Map<string, Orchestration>();
  const count = slotsCount();

  for (let slot = 1; slot <= count; slot++) {
    const slotState = readSlotState(slot);
    if (!slotState?.orchestration) continue;

    const orch = slotState.orchestration;
    // Map t3code orchestration modes to existing Orchestration type
    const type: Orchestration["type"] = orch.mode === "pair"
      ? "agent-pair-codex"  // default; exact agent assignment not tracked here
      : "agent-duo";

    for (const thread of slotState.threads) {
      const cwd = (thread.workspaceRoot ?? "").replace(/\/+$/, "");
      if (!cwd) continue;

      orchestrations.set(cwd, {
        type,
        mode: orch.mode,
        feature: "",  // t3code slot state does not track feature name
        phase: "",
        round: "",
        peerSyncPath: orch.stateFile ?? "",
      });
    }
  }

  return orchestrations;
}

/**
 * Build orchestration map from .peer-sync directories.
 * Used as fallback for non-t3code sessions (tmux Mag session, legacy scanners).
 */
async function enrichFromPeerSync(
  sessions: DiscoveredSession[],
): Promise<Map<string, Orchestration>> {
  const orchestrations = new Map<string, Orchestration>();

  for (const session of sessions) {
    if (session.cwd === "unknown") continue;

    const peerSyncDir = findPeerSyncDir(session.cwd);
    if (!peerSyncDir) continue;

    // Cache by peerSyncDir to avoid re-reading for sessions in the same project
    if (!orchestrations.has(peerSyncDir)) {
      const orch = await readOrchestration(peerSyncDir);
      orchestrations.set(peerSyncDir, orch);
    }
  }

  return orchestrations;
}

/**
 * Unified enrichment: t3code slot state first, .peer-sync fallback for non-t3code sessions.
 */
export async function enrichSessions(
  sessions: DiscoveredSession[],
): Promise<Map<string, Orchestration>> {
  // Collect from t3code slot state
  const t3codeOrchestrations = enrichFromT3codeSlots();

  // Collect from .peer-sync for non-t3code sessions
  const nonT3codeSessions = sessions.filter((s) => s.agentType !== "t3code");
  const peerSyncOrchestrations = nonT3codeSessions.length > 0
    ? await enrichFromPeerSync(nonT3codeSessions)
    : new Map<string, Orchestration>();

  // Merge: t3code orchestrations take precedence (keyed by cwd),
  // peer-sync orchestrations are keyed by peerSyncDir
  const merged = new Map<string, Orchestration>();
  for (const [key, orch] of peerSyncOrchestrations) merged.set(key, orch);
  for (const [key, orch] of t3codeOrchestrations) merged.set(key, orch);

  return merged;
}

export function findOrchestrationForCwd(
  cwd: string,
  orchestrations: Map<string, Orchestration>,
): Orchestration | null {
  // Direct match by cwd (t3code slot state keys)
  const normalizedCwd = cwd.replace(/\/+$/, "");
  const directMatch = orchestrations.get(normalizedCwd);
  if (directMatch) return directMatch;

  // Fallback: find via .peer-sync directory walk (legacy keys)
  const peerSyncDir = findPeerSyncDir(cwd);
  if (!peerSyncDir) return null;
  return orchestrations.get(peerSyncDir) ?? null;
}
