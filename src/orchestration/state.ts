import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { harnessDir as defaultHarnessDir } from "../config.ts";
import type { T3ProviderKind } from "../t3code/types.ts";
import { nowEpoch, readJsonFile, writeJsonFile } from "./util.ts";
import type { Phase } from "./phases.ts";

export interface OrchestrationRef {
  stateFile: string;
  mode: "duo" | "pair";
  pid?: number;
}

export interface AgentConfig {
  name: string;
  provider: T3ProviderKind;
  role?: "coder" | "reviewer";
  model: string;
  branch: string;
  worktreePath: string;
  /**
   * Provider-agnostic effort level: "low" | "medium" | "high" | "max".
   * Defaults to "high" when not explicitly configured.
   * Translated to provider-specific wire fields: `effort` for claudeAgent, `reasoningEffort` for codex.
   * Codex does not support "max"; it is mapped to "high" at dispatch time.
   */
  thinkingEffort?: string;
}

/**
 * Per-agent turn lifecycle tracking for the current phase.
 * Replaces timestamp-based freshness heuristics with identity-based tracking.
 * See docs/orchestration-phase-transitions.md for the full design.
 */
export interface AgentTurnLifecycle {
  /** Command ID from the dispatch (for correlation). */
  dispatchCommandId: string;
  /** ISO timestamp when the turn was dispatched by the runner. */
  dispatchedAt: string;
  /** Phase token at dispatch time — used to reject stale stop hooks. */
  phaseToken: string;
  /** Turn ID observed from snapshot after dispatch (null until first observation). */
  observedTurnId: string | null;
  /** Lifecycle state derived from snapshot. */
  state: "dispatched" | "starting" | "running" | "settled" | "error";
  /** ISO timestamp when turn was first observed running. */
  turnStartedAt: string | null;
  /** ISO timestamp when turn was observed settled. */
  turnCompletedAt: string | null;
  /** Source that first reported completion. */
  completionSource: "snapshot" | "stop-hook" | "timeout" | null;
  /** Fingerprint of the agent's .status file content at dispatch time (stale detection). */
  statusFileFingerprint: string | null;
  /** ISO timestamp of the most recent stop hook for this agent. */
  lastStopHookAt: string | null;
  // --- Stall detection & nudge fields ---
  /** ISO timestamp when stall was first detected (null = no active stall). */
  stallDetectedAt?: string | null;
  /** Number of nudge messages sent during this stall episode. */
  nudgeAttempts?: number;
  /** ISO timestamp of the most recent nudge dispatch. */
  lastNudgeAt?: string | null;
  /** assistantMessageId from the thread's latestTurn at the moment a nudge was sent.
   *  Used to classify post-nudge outcome: if it changes after settlement,
   *  the agent was alive; if unchanged, the session was dead. */
  preNudgeAssistantMessageId?: string | null;
  /** Hash of last tmux pane capture — used to detect static (stuck) terminals. */
  lastPaneHash?: string | null;
  /** ISO timestamp when pane output last changed. */
  lastPaneChangeAt?: string | null;
}

export interface AgentRuntimeState {
  status: string;
  statusEpoch: number;
  statusMessage: string;
  prUrl: string | null;
  interrupted: boolean;
  /** Current phase's turn lifecycle tracking.  Null for phases that don't dispatch turns (e.g. setup). */
  turnLifecycle?: AgentTurnLifecycle | null;
}

export interface OrchestrationConfig {
  timeouts: Record<string, number>;
  pollInterval: number;
  enableClarify: boolean;
  enablePushback: boolean;
  enablePlan: boolean;
  enableGather: boolean;
  autoFinish: boolean;
  autoFinishTimeout: number;
  learningInterval: number;
  learningProductiveRoundsGap: number;
  useMagTailoring: boolean;
  /** Seconds of no new PR comments/reviews before auto-transitioning to final-merge. */
  prCommentsTimeout: number;
  /** How often (seconds) to poll GitHub for new PR comments during pr-comments phase. */
  prCommentsCheckInterval: number;
}

export interface OrchestrationState {
  slot: number;
  taskId: string;
  mode: "duo" | "pair";
  phase: Phase;
  round: number;
  mergeRound: number;
  agents: AgentConfig[];
  agentStates: Record<string, AgentRuntimeState>;
  config: OrchestrationConfig;
  phaseStartedAt: number;
  startedAt: string;
  projectDir: string;
  rootWorktree: string;
  peerSyncDir: string;
  threadIds: Record<string, string>;
  mergeWinner?: string;
  /** Tracks how many plan-merge → plan-review iterations have completed (pair mode only). */
  planMergeRound?: number;
  /** @deprecated Alias for taskId — kept for backward compat with persisted state */
  feature?: string;
  slotTitle?: string;
  /** Staging fork repo slug (e.g. "lukstafi/ocannl-staging"). Set from project config at init. */
  stagingRepo?: string;
  lastLearningAt?: number;
  lastLearningRound?: number;
  confirmedPhase?: Phase | null;
  phaseDispatched?: boolean;
  /** Epoch of the last GitHub comment poll during pr-comments phase. */
  prCommentsLastCheckAt?: number;
  /**
   * Epoch since which no new PR comments have been observed (quiet period start).
   * Set to 0 to indicate quiet period was reset due to new comments.
   */
  prCommentsQuietSince?: number;
  /** Epoch (seconds) when Codex review deferral was armed; set on initial pr-comments entry.
   *  Cleared once all unique PRs have been resolved (review found or fallback posted). */
  prCodexReviewDeferredSince?: number;
  /** Number of verification failures for pr-create. Reset on fresh phase entry. */
  prCreateVerifyAttempts?: number;
  /** Number of verification failures for final-merge. Reset on fresh phase entry. */
  finalMergeVerifyAttempts?: number;
  /** Context string from the last verification failure, passed to the agent on re-dispatch. */
  phaseRetryContext?: string | null;
  /** Phase token for the current phase — persisted for crash-recovery dedup. */
  currentPhaseToken?: string;
  /** Which orchestration backend was used to create this state ("t3code" or "tmux").
   *  The runner reads this to select the correct transport, preventing split-brain
   *  when the global config differs from the slot's original backend.  */
  backend?: "t3code" | "tmux";
}

export const DEFAULT_TIMEOUTS: Record<string, number> = {
  work: 7200,
  review: 3600,
  gather: 1200,
  clarify: 1200,
  pushback: 1200,
  plan: 1200,
  "plan-merge": 1200,
  "plan-review": 1200,
  "update-docs": 1200,
  "pr-create": 1200,
  "pr-comments": 7200, // hard cap; quiet-period timeout governs normal exit
  "merge-vote": 1200,
  "merge-debate": 1200,
  "merge-execute": 3600,
  "merge-review": 1200,
  "merge-amend": 1200,
  "suggest-refactor": 1200,
  "forward-pr": 3600,
  "final-merge": 3600,
};

export const DEFAULT_PR_COMMENTS_TIMEOUT = 1200; // 20 min quiet before auto-merging
export const DEFAULT_PR_COMMENTS_CHECK_INTERVAL = 60; // poll GitHub every 60 s

export const DEFAULT_POLL_INTERVAL = 10;
export const DEFAULT_LEARNING_INTERVAL = 3600;
export const DEFAULT_LEARNING_PRODUCTIVE_ROUNDS_GAP = 3;
export const DEFAULT_AUTO_FINISH_TIMEOUT = 1800;

export function defaultOrchestrationConfig(
  overrides: Partial<OrchestrationConfig> = {},
): OrchestrationConfig {
  return {
    timeouts: { ...DEFAULT_TIMEOUTS, ...(overrides.timeouts ?? {}) },
    pollInterval: overrides.pollInterval ?? DEFAULT_POLL_INTERVAL,
    enableClarify: overrides.enableClarify ?? false,
    enablePushback: overrides.enablePushback ?? false,
    enablePlan: overrides.enablePlan ?? false,
    enableGather: overrides.enableGather ?? false,
    autoFinish: overrides.autoFinish ?? false,
    autoFinishTimeout: overrides.autoFinishTimeout ?? DEFAULT_AUTO_FINISH_TIMEOUT,
    learningInterval: overrides.learningInterval ?? DEFAULT_LEARNING_INTERVAL,
    learningProductiveRoundsGap:
      overrides.learningProductiveRoundsGap ?? DEFAULT_LEARNING_PRODUCTIVE_ROUNDS_GAP,
    useMagTailoring: overrides.useMagTailoring ?? false,
    prCommentsTimeout: overrides.prCommentsTimeout ?? DEFAULT_PR_COMMENTS_TIMEOUT,
    prCommentsCheckInterval:
      overrides.prCommentsCheckInterval ?? DEFAULT_PR_COMMENTS_CHECK_INTERVAL,
  };
}

export function orchestrationDir(harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "orchestration");
}

export function stateFilePath(slot: number, harnessDir: string = defaultHarnessDir()): string {
  return join(orchestrationDir(harnessDir), `slot-${slot}.json`);
}

export function readOrchestrationState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): OrchestrationState | null {
  const state = readJsonFile<OrchestrationState>(stateFilePath(slot, harnessDir));
  if (!state) return null;
  // Migrate legacy state: feature → taskId
  if (!state.taskId && (state as unknown as Record<string, unknown>).feature) {
    state.taskId = String((state as unknown as Record<string, unknown>).feature);
  }
  return state;
}

export function persistState(
  state: OrchestrationState,
  harnessDir: string = defaultHarnessDir(),
): void {
  writeJsonFile(stateFilePath(state.slot, harnessDir), state);
}

export function removeOrchestrationState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): void {
  const path = stateFilePath(slot, harnessDir);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function initAgentRuntimeState(names: string[]): Record<string, AgentRuntimeState> {
  const out: Record<string, AgentRuntimeState> = {};
  for (const name of names) {
    out[name] = {
      status: "idle",
      statusEpoch: nowEpoch(),
      statusMessage: "",
      prUrl: null,
      interrupted: false,
      turnLifecycle: null,
    };
  }
  return out;
}
