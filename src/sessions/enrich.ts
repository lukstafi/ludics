// Session enrichment — orchestration context discovery
//
// Reads orchestration data from t3code slot state files (T3CodeSlotState).

import type { DiscoveredSession, Orchestration } from "../types.ts";
import { readSlotState } from "../t3code/server.ts";
import { slotsCount } from "../config.ts";

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
    // Map t3code orchestration modes to Orchestration type
    const type = orch.mode === "pair" ? "t3code-pair" : "t3code-duo";

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
 * Enrich sessions with orchestration data from t3code slot state files.
 */
export async function enrichSessions(
  _sessions: DiscoveredSession[],
): Promise<Map<string, Orchestration>> {
  return enrichFromT3codeSlots();
}

export function findOrchestrationForCwd(
  cwd: string,
  orchestrations: Map<string, Orchestration>,
): Orchestration | null {
  // Direct match by cwd (t3code slot state keys)
  const normalizedCwd = cwd.replace(/\/+$/, "");
  return orchestrations.get(normalizedCwd) ?? null;
}
