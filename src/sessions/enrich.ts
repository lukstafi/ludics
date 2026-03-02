// .peer-sync enrichment
// Walk up from each session's cwd to find orchestration context

import { existsSync } from "fs";
import { join, dirname } from "path";
import type { DiscoveredSession, Orchestration } from "../types.ts";

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

export async function enrichWithPeerSync(
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

export function findOrchestrationForCwd(
  cwd: string,
  orchestrations: Map<string, Orchestration>,
): Orchestration | null {
  const peerSyncDir = findPeerSyncDir(cwd);
  if (!peerSyncDir) return null;
  return orchestrations.get(peerSyncDir) ?? null;
}
