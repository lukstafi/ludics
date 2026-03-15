// Deduplication by normalized cwd
// When multiple sources report the same directory,
// t3code ranks highest, then agent stores (codex, claude-code)

import type { AgentType, DiscoveredSession, MergedSession, Orchestration } from "../types.ts";
import { findOrchestrationForCwd } from "./enrich.ts";

function sourcePriority(agentType: AgentType): number {
  switch (agentType) {
    case "t3code":
      return 3;
    case "codex":
    case "claude-code":
      return 2;
    default:
      return 0;
  }
}

export function deduplicateAndMerge(
  sessions: DiscoveredSession[],
  orchestrations: Map<string, Orchestration>,
  staleThreshold: number,
): MergedSession[] {
  const now = Math.floor(Date.now() / 1000);

  // Group by normalized cwd
  const groups = new Map<string, DiscoveredSession[]>();
  for (const session of sessions) {
    const key = session.cwdNormalized;
    const existing = groups.get(key) ?? [];
    existing.push(session);
    groups.set(key, existing);
  }

  const merged: MergedSession[] = [];

  for (const [cwdNorm, group] of groups) {
    // Sort by priority (highest first), then by lastActivityEpoch (most recent first)
    group.sort((a, b) => {
      const prioDiff = sourcePriority(b.agentType) - sourcePriority(a.agentType);
      if (prioDiff !== 0) return prioDiff;
      return b.lastActivityEpoch - a.lastActivityEpoch;
    });

    const primary = group[0];
    const lastActivityEpoch = Math.max(...group.map((s) => s.lastActivityEpoch));
    const agents = [...new Set(group.map((s) => s.agentType))];
    const ids = [...new Set(group.map((s) => s.sessionId))];

    const orch = findOrchestrationForCwd(primary.cwd, orchestrations);

    merged.push({
      cwd: primary.cwd,
      cwdNormalized: cwdNorm,
      sources: group,
      agents,
      ids,
      lastActivityEpoch,
      lastActivity: new Date(lastActivityEpoch * 1000).toISOString(),
      stale: now - lastActivityEpoch > staleThreshold,
      slot: null,
      slotPath: null,
      orchestration: orch,
    });
  }

  return merged;
}
