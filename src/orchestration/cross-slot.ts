/**
 * Cross-slot coordination for hierarchical duo mode.
 *
 * When two pair-mode slots run the same task (hierarchical duo), this module
 * provides helpers to discover the peer slot's state and coordinate merge phases.
 */

import type { OrchestrationState } from "./state.ts";
import { readOrchestrationState } from "./state.ts";
import type { Phase } from "./phases.ts";

export interface DuoPeerState {
  peerSlot: number;
  peerPhase: Phase;
  peerPrUrl: string | null;
  peerPeerSyncDir: string;
  peerBranch: string;
  peerDone: boolean;
}

/**
 * Read the peer slot's orchestration state to check progress.
 * Returns null if duoPeerSlot is not set or state file is unreadable.
 */
export function readDuoPeerState(state: OrchestrationState): DuoPeerState | null {
  if (state.duoPeerSlot == null) return null;
  const peerState = readOrchestrationState(state.duoPeerSlot);
  if (!peerState) return null;

  // Find the coder agent's PR URL in the peer slot
  const peerCoder = peerState.agents.find((a) => a.role === "coder");
  const peerPrUrl = peerCoder
    ? peerState.agentStates[peerCoder.name]?.prUrl ?? null
    : null;

  return {
    peerSlot: state.duoPeerSlot,
    peerPhase: peerState.phase,
    peerPrUrl,
    peerPeerSyncDir: peerState.peerSyncDir,
    peerBranch: peerState.rootWorktree ? peerState.agents.find((a) => a.role === "coder")?.branch ?? "" : "",
    peerDone: peerState.phase === "done",
  };
}

/**
 * True when both this slot and its peer have PRs and are in pr-comments or later.
 */
export function bothSlotsReadyForMerge(state: OrchestrationState): boolean {
  if (state.duoPeerSlot == null) return false;

  // This slot must have a PR
  const thisCoder = state.agents.find((a) => a.role === "coder");
  const thisPr = thisCoder ? state.agentStates[thisCoder.name]?.prUrl : null;
  if (!thisPr) return false;

  // Peer slot must have a PR
  const peer = readDuoPeerState(state);
  if (!peer?.peerPrUrl) return false;

  return true;
}

/**
 * True when this slot is the merge coordinator (lower slot number).
 * Only the coordinator enters merge phases; the other slot waits.
 */
export function isMergeCoordinator(state: OrchestrationState): boolean {
  if (state.duoPeerSlot == null) return false;
  return state.slot < state.duoPeerSlot;
}
