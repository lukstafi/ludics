import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { harnessDir as defaultHarnessDir } from "../config.ts";
import type { T3ProviderKind } from "../t3code/types.ts";
import { nowEpoch, readJsonFile, writeJsonFile } from "./util.ts";
import type { Phase } from "./phases.ts";

export interface OrchestrationRef {
  stateFile: string;
  mode: "duo" | "pair" | "solo";
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
  // --- Wrong-filename recovery dedup (per-(round, planMergeRound) tuple) ---
  /** state.round at which the most recent wrong-filename nudge fired. */
  wrongFilenameNudgeRound?: number;
  /** state.planMergeRound (??-1) at which the most recent wrong-filename nudge fired.
   *  Distinguishes plan-merge / plan-review iterations within a single outer round. */
  wrongFilenameNudgePlanMergeRound?: number | null;
}

export interface AgentRuntimeState {
  status: string;
  statusEpoch: number;
  statusMessage: string;
  prUrl: string | null;
  interrupted: boolean;
  /** Current phase's turn lifecycle tracking.  Null for phases that don't dispatch turns (e.g. setup). */
  turnLifecycle?: AgentTurnLifecycle | null;
  /** Status file fingerprint captured at dispatch time.
   *  Persisted on AgentRuntimeState (not turnLifecycle) so it survives
   *  slotResume() clearing turnLifecycle. Used by isAgentDone() to detect
   *  stale status files after crash/resume. */
  dispatchStatusFingerprint?: string | null;
  /** Commit count ahead of the base branch at the moment the agent's PR body
   *  was written (captured on `prUrl` transition from null to a URL).
   *  Used by the drift-annotation tick during `pr-comments` to detect that
   *  the branch has changed since the body was composed. */
  prBodyBaselineCommits?: number;
  /** ISO timestamp of the `prBodyBaselineCommits` capture. */
  prBodyBaselineAt?: string;
  /** Commit count at which the most recent drift annotation was posted.
   *  Edge-triggered dedup: subsequent polls at the same count skip; a new
   *  distinct count re-fires. `null` = no annotation posted yet at the
   *  current baseline. */
  prBodyDriftAnnotatedAtCommits?: number | null;
  /** PR URL the current `prBodyBaseline*` values describe. Invalidates the
   *  baseline (triggering recapture) when `runtime.prUrl` is replaced mid-flow
   *  so drift comments for a new PR don't quote the old PR's history. */
  prBodyBaselineUrl?: string;
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
  /** Gates the wrong-filename auto-cp branch only. When false, whitelisted suspects
   *  fall through to the targeted-nudge branch instead of being auto-copied. */
  autoRecoverWrongFilename: boolean;
}

export interface OrchestrationState {
  slot: number;
  taskId: string;
  mode: "duo" | "pair" | "solo";
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
   *  Cleared once all unique PRs have a submitted review (not just when fallback is posted). */
  prCodexReviewDeferredSince?: number;
  /** True after the explicit `@codex review` fallback comment has been posted.
   *  Prevents re-posting on subsequent poll cycles while still waiting for the review. */
  prCodexReviewFallbackPosted?: boolean;
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
  /** Set when the coder is re-dispatched in pr-comments phase (new comments to address).
   *  Cleared on fresh pr-comments entry. Used to shortcut to final-merge once all agents
   *  are done — avoids the full quiet-period wait after the coder has responded. */
  prCommentsCoderDispatched?: boolean;
  /** Last non-unknown mergeable_state observed per agent PR during pr-comments.
   *  Persisted so crash/resume doesn't re-trigger the same conflict dispatch.
   *  Keyed by agent name. Reset on fresh transition into pr-comments via
   *  applyPhaseSideEffects(), NOT on resume re-entry. */
  prMergeableStates?: Record<string, string | null>;
  /** For hierarchical-duo: the peer slot number running the same task. null for plain pair mode. */
  duoPeerSlot?: number | null;
  /** For hierarchical-duo: true when this slot has a PR and is waiting for the peer slot. */
  duoAwaitingPeer?: boolean;
  /** Concrete branch names from createWorktrees(), keyed by agent name (plus "root").
   *  Populated at init so downstream consumers (e.g. buildCleanupEntry) avoid re-deriving. */
  branches?: Record<string, string>;
  /** Previous phase context for artifact validation — persisted so crash recovery
   *  doesn't skip validation. Captured before applyPhaseSideEffects() mutates round/planMergeRound.
   *  Consumed and cleared by enterPhase() on the next iteration. */
  previousPhaseCtx?: { phase: Phase; round: number; planMergeRound: number };
  /** Round number at which the stale-base warning last fired (Item A dedup memo).
   *  When state.round changes, the remembered count resets. */
  staleBaseLastWarnedRound?: number;
  /** Commit count at which the stale-base warning last fired within
   *  staleBaseLastWarnedRound. Re-fire only when a new count exceeds this. */
  staleBaseLastWarnedCount?: number;
  /** Caller-selected harness directory; populated at orchestration init and
   *  backfilled from the readOrchestrationState() harnessDir arg for legacy
   *  state files. Consumers should read via `state.harnessDir ?? defaultHarnessDir()`. */
  harnessDir?: string;
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
  "final-merge": 3600,
};

export const DEFAULT_PR_COMMENTS_TIMEOUT = 1800; // 30 min quiet before auto-merging
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
    autoRecoverWrongFilename: overrides.autoRecoverWrongFilename ?? true,
  };
}

export function orchestrationDir(harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "orchestration");
}

export function stateFilePath(slot: number, harnessDir: string = defaultHarnessDir()): string {
  return join(orchestrationDir(harnessDir), `slot-${slot}.json`);
}

// Non-harness local cache for worker-side orchestration state
function workerCacheDir(): string {
  return join(process.env.HOME ?? "/tmp", ".ludics-orch-cache");
}

function workerCacheFilePath(slot: number): string {
  return join(workerCacheDir(), `slot-${slot}.json`);
}

function isWorkerContext(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- circular-dep chain: cluster → events → journal → state
    const { clusterIsController, clusterCurrentMachineName } = require("../cluster.ts") as typeof import("../cluster.ts");
    return !!(clusterCurrentMachineName() && !clusterIsController());
  } catch {
    return false;
  }
}

export function migrateState(state: OrchestrationState, slot: number): OrchestrationState {
  if (!state.taskId && (state as unknown as Record<string, unknown>).feature) {
    state.taskId = String((state as unknown as Record<string, unknown>).feature);
  }
  if (state.mode === "duo" && state.duoPeerSlot == null) {
    console.error(`ludics: slot ${slot} has legacy mode="duo" without duoPeerSlot — should be cleared and re-assigned`);
  }
  if (state.mode === "solo") {
    if (state.duoPeerSlot != null) {
      console.error(`ludics: slot ${slot} has mode="solo" with duoPeerSlot=${state.duoPeerSlot} — invariant violation (solo must be single-slot)`);
    }
    if (state.agents && state.agents.length !== 1) {
      console.error(`ludics: slot ${slot} has mode="solo" with ${state.agents.length} agents — invariant violation (solo must have exactly one agent)`);
    }
  }
  // Fill in fields added after the on-disk schema was first written so reads
  // of legacy slot-N.json don't surface `undefined` to downstream consumers.
  if (state.config && state.config.autoRecoverWrongFilename === undefined) {
    state.config.autoRecoverWrongFilename = true;
  }
  return state;
}

export function readOrchestrationState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): OrchestrationState | null {
  // Worker: read from non-harness cache
  if (isWorkerContext()) {
    const state = readJsonFile<OrchestrationState>(workerCacheFilePath(slot));
    if (!state) return null;
    const migrated = migrateState(state, slot);
    migrated.harnessDir ??= harnessDir;
    return migrated;
  }
  // Controller/standalone: read from harness
  const state = readJsonFile<OrchestrationState>(stateFilePath(slot, harnessDir));
  if (!state) return null;
  const migrated = migrateState(state, slot);
  migrated.harnessDir ??= harnessDir;
  return migrated;
}

export function persistState(
  state: OrchestrationState,
  harnessDir: string = defaultHarnessDir(),
): void {
  // Worker: write to non-harness cache + POST to controller
  if (isWorkerContext()) {
    mkdirSync(workerCacheDir(), { recursive: true });
    writeJsonFile(workerCacheFilePath(state.slot), state);
    import("../cluster-http.ts").then(({ clusterPostOrchestrationState }) => {
      clusterPostOrchestrationState(state.slot, state).catch(() => {});
    }).catch(() => {});
    return;
  }
  writeJsonFile(stateFilePath(state.slot, harnessDir), state);
}

export function removeOrchestrationState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): void {
  // Worker: remove from non-harness cache (controller handles its own removal via slotClear)
  if (isWorkerContext()) {
    const cachePath = workerCacheFilePath(slot);
    if (existsSync(cachePath)) unlinkSync(cachePath);
    return;
  }
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
      dispatchStatusFingerprint: null,
    };
  }
  return out;
}
