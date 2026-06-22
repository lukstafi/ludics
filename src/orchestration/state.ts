import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { harnessDir as defaultHarnessDir, globalAdapter } from "../config.ts";
import type { T3ProviderKind } from "../t3code/types.ts";
import { nowEpoch, readJsonFile, writeJsonFile } from "./util.ts";
import type { Phase } from "./phases.ts";

export interface OrchestrationRef {
  stateFile: string;
  mode: "duo" | "pair" | "solo" | "pilot";
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
  // --- Settled-no-signal detection & nudge fields ---
  // (renamed from stallDetectedAt / nudgeAttempts / lastNudgeAt;
  //  see migrateState read-forward shim)
  /** ISO timestamp when settled-no-signal was first detected (null = none active). */
  settledNoSignalDetectedAt?: string | null;
  /** Number of nudge messages sent during this settled-no-signal episode. */
  settledNoSignalNudgeAttempts?: number;
  /** ISO timestamp of the most recent settled-no-signal nudge dispatch. */
  lastSettledNoSignalNudgeAt?: string | null;
  /** assistantMessageId from the thread's latestTurn at the moment a nudge was sent.
   *  Used to classify post-nudge outcome: if it changes after settlement,
   *  the agent was alive; if unchanged, the session was dead. */
  preNudgeAssistantMessageId?: string | null;
  /** Hash of last tmux pane capture — used to detect static (stuck) terminals. */
  lastPaneHash?: string | null;
  /** ISO timestamp when pane output last changed. */
  lastPaneChangeAt?: string | null;
  // --- Hung-agent detection (substantive-diff trigger) ---
  /** Raw 50-line tmux pane capture from the previous tick (~2KB). Used by
   *  the substantive-diff hung detector. Null on first observation. */
  lastPaneRaw?: string | null;
  /** ISO timestamp when the first under-threshold diff in a stall run was
   *  observed; cleared on the first substantive diff after detection. */
  substantiveStallSince?: string | null;
  /** Cumulative residual-diff char count from `substantiveStallSince` onward;
   *  reported in the `agent_hung_detected` event payload as
   *  `diffCharsAccumulated`. Cleared alongside `substantiveStallSince`. */
  substantiveStallChars?: number;
  /** ISO timestamp when the hung detector first fired for this episode. */
  hungDetectedAt?: string | null;
  /** Number of breakAndPrompt + force-settle attempts in this hung episode.
   *  0 = no detection yet; 1 = breakAndPrompt sent; 2 = force-settled. */
  hungNudgeAttempts?: number;
  // --- Wrong-filename recovery counters (split from settled-no-signal) ---
  /** Number of wrong-filename nudges sent. */
  wrongFilenameNudgeAttempts?: number;
  /** ISO timestamp of the most recent wrong-filename nudge dispatch. */
  lastWrongFilenameNudgeAt?: string | null;
  // --- Wrong-filename recovery dedup (per-(round, planMergeRound) tuple) ---
  /** state.round at which the most recent wrong-filename nudge fired. */
  wrongFilenameNudgeRound?: number;
  /** state.planMergeRound (??-1) at which the most recent wrong-filename nudge fired.
   *  Distinguishes plan-merge / plan-review iterations within a single outer round. */
  wrongFilenameNudgePlanMergeRound?: number | null;
  // --- Interrupted-agent nudge counters (split from settled-no-signal) ---
  /** Number of "Continue." nudges sent for an interrupted-but-not-done agent. */
  interruptedNudgeAttempts?: number;
  /** ISO timestamp of the most recent interrupted-agent nudge dispatch. */
  lastInterruptedNudgeAt?: string | null;
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
  /** Seconds since the last redispatch after which a quiet pr-comments phase with an
   *  unaddressed review on the PR triggers a one-shot orchestration_warning. Default 600. */
  prCommentsStuckThreshold: number;
  /** Gates the wrong-filename auto-cp branch only. When false, whitelisted suspects
   *  fall through to the targeted-nudge branch instead of being auto-copied. */
  autoRecoverWrongFilename: boolean;
  /** Substantive-diff hung-detector knobs. See
   *  `mag.orchestration.substantive_stall.*` in templates/config.reference.yaml. */
  substantiveStall: SubstantiveStallConfig;
}

/** Tunables for the substantive-diff hung detector
 *  (see `detectAndNudgeHungAgents` in runner.ts). */
export interface SubstantiveStallConfig {
  /** Sustained-low-diff window before hung is declared (default: 1200, 20 min). */
  thresholdSeconds: number;
  /** Pane diff floor for "substantive" output (default: 30 chars). */
  minChars: number;
  /** Pane diff percent floor (default: 0.05). */
  minPct: number;
  /** Cooldown between breakAndPrompt and force-settle escalation
   *  (default: 180, 3 min). */
  nudgeCooldownSeconds: number;
  /** 1 breakAndPrompt + 1 force-settle (default: 2). */
  maxNudgeAttempts: number;
}

export const DEFAULT_SUBSTANTIVE_STALL_CONFIG: SubstantiveStallConfig = {
  thresholdSeconds: 1200,
  minChars: 30,
  minPct: 0.05,
  nudgeCooldownSeconds: 180,
  maxNudgeAttempts: 2,
};

/**
 * Parse `mag.orchestration.substantive_stall.*` YAML keys into a
 * `Partial<SubstantiveStallConfig>` for `defaultOrchestrationConfig`.
 * YAML uses snake_case; the runtime config is camelCase. Each leaf is
 * validated as `typeof === "number"` (per
 * `feedback_narrowing_needs_boundary_validators`); invalid values are
 * dropped silently so a hand-edited config.yaml typo can't crash slot
 * init — the leaf falls through to its default in
 * `defaultOrchestrationConfig`.
 */
export function parseSubstantiveStallOverrides(
  raw: unknown,
): Partial<SubstantiveStallConfig> {
  if (!raw || typeof raw !== "object") return {};
  const yaml = raw as Record<string, unknown>;
  const out: Partial<SubstantiveStallConfig> = {};
  if (typeof yaml.threshold_seconds === "number") {
    out.thresholdSeconds = yaml.threshold_seconds;
  }
  if (typeof yaml.min_chars === "number") {
    out.minChars = yaml.min_chars;
  }
  if (typeof yaml.min_pct === "number") {
    out.minPct = yaml.min_pct;
  }
  if (typeof yaml.nudge_cooldown_seconds === "number") {
    out.nudgeCooldownSeconds = yaml.nudge_cooldown_seconds;
  }
  if (typeof yaml.max_nudge_attempts === "number") {
    out.maxNudgeAttempts = yaml.max_nudge_attempts;
  }
  return out;
}

export interface OrchestrationState {
  slot: number;
  taskId: string;
  mode: "duo" | "pair" | "solo" | "pilot";
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
  /** True while the coder is currently dispatched in pr-comments and not-yet-settled
   *  for the latest review; false otherwise. Cleared on coder-settle (via isAgentDone()
   *  in refreshAgentStatuses), on every redispatchForPrComments re-arm boundary, and
   *  on fresh pr-comments phase entry. The shortcut to final-merge requires
   *  !prCommentsCoderActive AND prCommentsRedispatchCount >= 1 — i.e. the coder has
   *  settled after at least one review-driven redispatch. */
  prCommentsCoderActive?: boolean;
  /** Number of redispatchForPrComments() invocations since fresh pr-comments phase
   *  entry. The shortcut requires >= 1 so first-entry quiet state cannot bypass review
   *  handling. Reset to undefined by resetPrCommentsState. */
  prCommentsRedispatchCount?: number;
  /** Epoch of the most recent redispatchForPrComments invocation in this pr-comments
   *  phase. Used by the stuck-phase warning to compute (now - lastRedispatchAt) and
   *  to rebase fetchNewPrCommentCount for the unaddressed-review probe. Reset by
   *  resetPrCommentsState. */
  prCommentsLastRedispatchAt?: number;
  /** Epoch of the last pr-comments-stuck warning emission. Edge-triggered dedup:
   *  cleared on next successful redispatch and on fresh phase entry. */
  prCommentsStuckWarnedAt?: number;
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
  /** Per-(round, phase-category) dedup memo for the stale-base warning
   *  (gh-ludics-409). Coder-category covers `plan`/`work`; reviewer-category
   *  covers `plan-review`/`review`. A warning that fired in one category in
   *  round N does not suppress a warning in the other category in the same
   *  round. Reads tolerate undefined entries (treated as "no prior warning");
   *  persisted state from before this field existed is backfilled by
   *  migrateState() from the legacy scalar fields
   *  `staleBaseLastWarnedRound` / `...Count`. */
  staleBaseLastWarned?: {
    coder?: { round: number; count: number };
    reviewer?: { round: number; count: number };
  };
  /** Caller-selected harness directory; populated at orchestration init and
   *  backfilled from the readOrchestrationState() harnessDir arg for legacy
   *  state files. Consumers should read via `state.harnessDir ?? defaultHarnessDir()`. */
  harnessDir?: string;
  /** gh-ludics-584 resume circuit-breaker: how many consecutive keepalive
   *  auto-resume detections found the orchestrator dead in the SAME (taskId,
   *  phase) with no advance. Reset when the phase advances or the task changes.
   *  Persisted (worker cache survives oneshot ticks) so the count accumulates
   *  across the separate per-tick worker keepalive processes. Single-line by
   *  design so the lint:state-migration field extractor records one field. */
  autoResumeNoProgress?: { taskId: string; phase: Phase; consecutiveTicks: number };
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
export const DEFAULT_PR_COMMENTS_STUCK_THRESHOLD = 600; // 10 min quiet-after-redispatch before stuck warning

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
    prCommentsStuckThreshold:
      overrides.prCommentsStuckThreshold ?? DEFAULT_PR_COMMENTS_STUCK_THRESHOLD,
    autoRecoverWrongFilename: overrides.autoRecoverWrongFilename ?? true,
    substantiveStall: {
      thresholdSeconds:
        overrides.substantiveStall?.thresholdSeconds ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.thresholdSeconds,
      minChars:
        overrides.substantiveStall?.minChars ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.minChars,
      minPct:
        overrides.substantiveStall?.minPct ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.minPct,
      nudgeCooldownSeconds:
        overrides.substantiveStall?.nudgeCooldownSeconds ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.nudgeCooldownSeconds,
      maxNudgeAttempts:
        overrides.substantiveStall?.maxNudgeAttempts ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.maxNudgeAttempts,
    },
  };
}

export function orchestrationDir(harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "orchestration");
}

export function stateFilePath(slot: number, harnessDir: string = defaultHarnessDir()): string {
  return join(orchestrationDir(harnessDir), `slot-${slot}.json`);
}

// Non-harness local cache root for worker-side orchestration + adapter state.
// Exported so the t3code/tmux per-slot state readers/writers can place their
// own (disambiguated) cache files under the same root — see gh-ludics-580.
export function workerCacheDir(): string {
  return join(process.env.HOME ?? "/tmp", ".ludics-orch-cache");
}

function workerCacheFilePath(slot: number): string {
  return join(workerCacheDir(), `slot-${slot}.json`);
}

// Exported so adapters (t3code/server.ts, tmux-adapter.ts) share a single
// worker-context detector instead of duplicating it (gh-ludics-580 AC6).
export function isWorkerContext(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- circular-dep chain: cluster → events → journal → state
    const { clusterIsController, clusterCurrentMachineName } = require("../cluster.ts") as typeof import("../cluster.ts");
    return !!(clusterCurrentMachineName() && !clusterIsController());
  } catch {
    return false;
  }
}

/**
 * File-local validator for narrow string unions read off disk
 * (gh-ludics-411 AC 3). `migrateState` is the single read-boundary for every
 * `OrchestrationState` deserialization, so per-field whitelist checks here
 * cover both the controller `readJsonFile<OrchestrationState>` site and the
 * worker cache equivalent. Policy is per-field, per the proposal:
 *  - "throw" — invariant fields whose corruption should halt the read
 *    (caller has its own catch-and-fall-through path).
 *  - "coerce" — fields with a meaningful safe default; emit a console.error
 *    and substitute `fallback`.
 *  - "drop" — optional fields whose absence is already a documented state;
 *    invalid values are removed by the caller (`delete state.foo`).
 */
function validateAndCoerce<T extends string>(
  value: unknown,
  allowed: readonly T[],
  policy: "throw" | "coerce" | "drop",
  fallback: T | null,
  fieldPath: string,
  slot: number,
): T | null {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  if (policy === "throw") {
    throw new Error(`ludics: slot ${slot} corrupt OrchestrationState.${fieldPath}: ${JSON.stringify(value)}`);
  }
  if (policy === "drop") {
    console.error(`ludics: slot ${slot} dropping invalid OrchestrationState.${fieldPath}: ${JSON.stringify(value)}`);
    return null;
  }
  // policy === "coerce"
  console.error(`ludics: slot ${slot} coercing invalid OrchestrationState.${fieldPath}: ${JSON.stringify(value)} → ${JSON.stringify(fallback)}`);
  return fallback;
}

export function migrateState(state: OrchestrationState, slot: number): OrchestrationState {
  if (!state.taskId && (state as unknown as Record<string, unknown>).feature) {
    state.taskId = String((state as unknown as Record<string, unknown>).feature);
  }

  // --- AC 3 boundary validators (string unions read from disk JSON) -------
  state.mode = validateAndCoerce(
    state.mode, ["duo", "pair", "solo", "pilot"] as const, "throw", null, "mode", slot,
  ) as "duo" | "pair" | "solo" | "pilot";

  if (state.backend !== undefined) {
    const validated = validateAndCoerce(
      state.backend, ["t3code", "tmux"] as const, "coerce", globalAdapter(), "backend", slot,
    );
    state.backend = validated as "t3code" | "tmux";
  }

  if (state.agents) {
    for (const agent of state.agents) {
      agent.provider = validateAndCoerce(
        agent.provider, ["codex", "claude-code"] as const, "throw", null,
        "agents[].provider", slot,
      ) as T3ProviderKind;

      if (agent.role !== undefined) {
        const validated = validateAndCoerce(
          agent.role, ["coder", "reviewer"] as const, "drop", null,
          "agents[].role", slot,
        );
        if (validated === null) delete agent.role;
        else agent.role = validated;
      }
    }
  }

  if (state.agentStates) {
    for (const runtime of Object.values(state.agentStates)) {
      const lc = runtime.turnLifecycle;
      if (lc != null) {
        // --- task-a670cdbf legacy field rename (read-forward) ---
        // Loud per-key migration so persisted slots upgrade cleanly without
        // dual-reads at write time. Negative-control AC requires the legacy
        // keys to be absent in-memory after load.
        const legacy = lc as unknown as Record<string, unknown>;
        if ("stallDetectedAt" in legacy) {
          if (lc.settledNoSignalDetectedAt === undefined) {
            lc.settledNoSignalDetectedAt = legacy.stallDetectedAt as string | null;
          }
          delete legacy.stallDetectedAt;
        }
        if ("nudgeAttempts" in legacy) {
          if (lc.settledNoSignalNudgeAttempts === undefined) {
            lc.settledNoSignalNudgeAttempts = legacy.nudgeAttempts as number;
          }
          delete legacy.nudgeAttempts;
        }
        if ("lastNudgeAt" in legacy) {
          if (lc.lastSettledNoSignalNudgeAt === undefined) {
            lc.lastSettledNoSignalNudgeAt = legacy.lastNudgeAt as string | null;
          }
          delete legacy.lastNudgeAt;
        }
        // Default-fill the new optional fields so consumers don't need
        // scattered ?? guards. ??= preserves a persisted null (sentinel).
        lc.lastPaneRaw ??= null;
        lc.substantiveStallSince ??= null;
        lc.substantiveStallChars ??= 0;
        lc.hungDetectedAt ??= null;
        lc.hungNudgeAttempts ??= 0;
        lc.wrongFilenameNudgeAttempts ??= 0;
        lc.lastWrongFilenameNudgeAt ??= null;
        lc.interruptedNudgeAttempts ??= 0;
        lc.lastInterruptedNudgeAt ??= null;

        lc.state = validateAndCoerce(
          lc.state,
          ["dispatched", "starting", "running", "settled", "error"] as const,
          "coerce", "error", "turnLifecycle.state", slot,
        ) as "dispatched" | "starting" | "running" | "settled" | "error";

        // Sentinel-null fast-path: `null` is a valid value here (means
        // "completion source unknown"), not an "absent" marker. Skip the
        // validator on null/undefined to avoid spurious console.error logs
        // on every healthy state-file read.
        if (lc.completionSource !== null && lc.completionSource !== undefined) {
          const validated = validateAndCoerce(
            lc.completionSource,
            ["snapshot", "stop-hook", "timeout"] as const,
            "coerce", null, "turnLifecycle.completionSource", slot,
          );
          lc.completionSource = validated as "snapshot" | "stop-hook" | "timeout" | null;
        }
      }
    }
  }
  // ------------------------------------------------------------------------

  if (state.mode === "duo" && state.duoPeerSlot == null) {
    console.error(`ludics: slot ${slot} has legacy mode="duo" without duoPeerSlot — should be cleared and re-assigned`);
  }
  if (state.mode === "solo" || state.mode === "pilot") {
    if (state.duoPeerSlot != null) {
      console.error(`ludics: slot ${slot} has mode="${state.mode}" with duoPeerSlot=${state.duoPeerSlot} — invariant violation (${state.mode} must be single-slot)`);
    }
    if (state.agents && state.agents.length !== 1) {
      console.error(`ludics: slot ${slot} has mode="${state.mode}" with ${state.agents.length} agents — invariant violation (${state.mode} must have exactly one agent)`);
    }
  }
  // Fill in fields added after the on-disk schema was first written so reads
  // of legacy slot-N.json don't surface `undefined` to downstream consumers.
  if (state.config && state.config.autoRecoverWrongFilename === undefined) {
    state.config.autoRecoverWrongFilename = true;
  }
  // gh-ludics-409: migrate legacy scalar memo fields into the per-category
  // record. Persisted state from gh-ludics-374's shipped build carries
  // `staleBaseLastWarnedRound` / `...Count`; map them into
  // `staleBaseLastWarned.coder` (the only category the legacy warning ever
  // populated) so dedup state survives the upgrade. Strip the legacy keys
  // unconditionally so persistState() doesn't write them back out.
  const legacy = state as unknown as {
    staleBaseLastWarnedRound?: number;
    staleBaseLastWarnedCount?: number;
    prCommentsCoderDispatched?: boolean;
  };
  if (
    state.staleBaseLastWarned === undefined
    && (legacy.staleBaseLastWarnedRound !== undefined
        || legacy.staleBaseLastWarnedCount !== undefined)
  ) {
    state.staleBaseLastWarned = {
      coder: {
        round: legacy.staleBaseLastWarnedRound ?? 0,
        count: legacy.staleBaseLastWarnedCount ?? 0,
      },
    };
  }
  delete legacy.staleBaseLastWarnedRound;
  delete legacy.staleBaseLastWarnedCount;
  // gh-bce80781: rename prCommentsCoderDispatched → prCommentsCoderActive.
  // Copy the legacy value into the new field if absent, then strip the legacy
  // key unconditionally so persistState never round-trips it.
  //
  // The legacy semantics ("we have dispatched at some point") implied
  // prCommentsRedispatchCount >= 1 once the flag had ever been set true.
  // The new prCommentsReadyForFinalMerge shortcut requires
  // (prCommentsRedispatchCount ?? 0) >= 1, so for legacy slots mid-phase that
  // had already redispatched (legacy flag === true), backfill the count to 1
  // — otherwise the upgraded slot would wait the full quiet-period timeout
  // before advancing instead of taking the shortcut. (Codex review on PR #492.)
  if (state.prCommentsCoderActive === undefined && legacy.prCommentsCoderDispatched !== undefined) {
    state.prCommentsCoderActive = legacy.prCommentsCoderDispatched;
    if (legacy.prCommentsCoderDispatched === true && state.prCommentsRedispatchCount === undefined) {
      state.prCommentsRedispatchCount = 1;
    }
  }
  delete legacy.prCommentsCoderDispatched;
  // gh-bce80781: backfill new config field for legacy state files.
  if (state.config && state.config.prCommentsStuckThreshold === undefined) {
    state.config.prCommentsStuckThreshold = DEFAULT_PR_COMMENTS_STUCK_THRESHOLD;
  }
  // task-a670cdbf: backfill substantive-stall config for legacy state files.
  // Per-leaf so a partial override doesn't drop the missing leaves.
  if (state.config) {
    const ss = (state.config.substantiveStall ?? {}) as Partial<SubstantiveStallConfig>;
    state.config.substantiveStall = {
      thresholdSeconds: ss.thresholdSeconds ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.thresholdSeconds,
      minChars: ss.minChars ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.minChars,
      minPct: ss.minPct ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.minPct,
      nudgeCooldownSeconds: ss.nudgeCooldownSeconds ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.nudgeCooldownSeconds,
      maxNudgeAttempts: ss.maxNudgeAttempts ?? DEFAULT_SUBSTANTIVE_STALL_CONFIG.maxNudgeAttempts,
    };
  }
  // gh-ludics-584: normalize the resume circuit-breaker record read from disk.
  // Absent → stays undefined (new-field default). Present-but-corrupt → drop the
  // whole record when taskId/phase are not strings (a malformed key can't drive
  // the same-phase comparison), else clamp a bad/negative consecutiveTicks to 0
  // so the breaker counts forward from a sane floor rather than tripping/looping
  // on garbage. (lint:state-migration read-boundary coercion for the new field.)
  if (state.autoResumeNoProgress !== undefined) {
    const arp = state.autoResumeNoProgress as unknown as {
      taskId?: unknown; phase?: unknown; consecutiveTicks?: unknown;
    };
    if (typeof arp.taskId !== "string" || typeof arp.phase !== "string") {
      delete state.autoResumeNoProgress;
    } else {
      const ticks = arp.consecutiveTicks;
      if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) {
        state.autoResumeNoProgress.consecutiveTicks = 0;
      }
    }
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
