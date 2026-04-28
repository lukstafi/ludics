import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { emitEvent } from "../events.ts";
import { atomicWriteFileSync } from "../json.ts";
import { writeStatusFile } from "../adapters/base.ts";
import { mergedPlanFilePath } from "./plan-files.ts";
import { DONE_STATUSES, PHASE_CATEGORIES, allAgentsDone, agentParticipatesInPhase, escalatingAgents, evaluateTransition, findPlanFiles, isAgentDone, isBailedOut, isEscalated, pairReviewVerdict, phaseTimeoutExpired, requiredArtifactPath } from "./phases.ts";
import {
  clearInterrupt, readAgentStatus, readMarker, readPhaseToken, readPrUrl,
  statusFileFingerprint, touchStatusFile, writeInterrupt, writePeerSync,
} from "./peer-sync.ts";
import { determineWinner, hasConsensus, readMergeVotes } from "./merge.ts";
import { shouldRunUpdateDocs } from "./learning.ts";
import { composeSkillMessage, doneStatusForPhase } from "./skills.ts";
import {
  persistState, readOrchestrationState,
  type AgentConfig, type OrchestrationState,
} from "./state.ts";
import { isoNow, makeId, nowEpoch, sleepMs } from "./util.ts";
import { fetchNewPrCommentCount, getPrVerification, hasCodexPostedComment, hasCodexSubmittedReview, isPrMerged, isPrUrl, postCodexReviewComment, postPrDriftComment, validateAndFixPrFile, type PrVerification } from "./github.ts";
import { updateFrontmatterField, addFrontmatterField, appendToSection } from "../tasks/markdown.ts";
import { findProjectConfig, globalAdapter, harnessDir as defaultHarnessDir, ludicsRoot } from "../config.ts";
import { taskFilePath } from "./paths.ts";
import { notifyAgents, notifyOutgoing } from "../notify.ts";
import { readSlotJson, writeSlotJson } from "../slots/json.ts";
import { setSlotLivenessOnData } from "../slots/index.ts";
// workerReportStatus replaced by clusterReportWorkerSignal (lazy import)
import { clusterRole } from "../cluster.ts";
import { autoCommitWorktree, countCommitsAhead, defaultMainBranch, pushBranch } from "./worktrees.ts";
import type { OrchestrationTransport } from "./transport.ts";
import { agentPortRole, readTmuxSlotState, startTtyd, writeTmuxSlotState } from "../adapters/tmux-adapter.ts";
import { readSlotState, processAlive } from "../t3code/server.ts";

// --- Hung agent detection constants ---
// A "hung agent" appears to be working (lifecycle running/dispatched) but the
// terminal output is static — the agent is frozen or finished without signaling.
// Rare in tmux, more common in t3code (process liveness bug).
/** Seconds of static pane output before a running agent is considered hung.
 *  Lower than agent-duo timeouts because this only fires when terminal is static
 *  (no evidence of work), not when the agent is actively producing output. */
const HUNG_RUNNING_THRESHOLD_S = 180;
/** Seconds of static pane output before a dispatched (never-started) agent is considered hung.
 *  Short because a failed dispatch should be detected quickly. */
const HUNG_DISPATCH_THRESHOLD_S = 90;
/** Seconds of static pane output before a running agent that never wrote a done
 *  status is considered hung.  Covers prompt-injection failures (agent alive but
 *  never received its task) and incoherent agents that stop producing output. */
const HUNG_IDLE_RUNNING_THRESHOLD_S = 180;
/** Minimum seconds between nudge attempts for hung agents. */
const HUNG_NUDGE_COOLDOWN_S = 90;
/** Seconds between ttyd liveness checks in the poll loop. */
const TTYD_HEALTH_CHECK_INTERVAL_S = 30;

// --- Verification gate constants and types ---
type VerificationDecision = "advance" | "redispatch" | "hold" | "skip";
export const MAX_VERIFY_ATTEMPTS = 3;

import type { Phase } from "./phases.ts";

/** Snapshot of pre-mutation phase context for artifact validation.
 *  Captured before applyPhaseSideEffects() which mutates round/planMergeRound. */
export interface PreviousPhaseContext {
  phase: Phase;
  round: number;
  planMergeRound: number;
}

/**
 * Log warnings for missing artifacts from the phase that just completed.
 * Diagnostic only — does not block the transition.
 *
 * Uses PreviousPhaseContext (captured before applyPhaseSideEffects) to construct
 * a state snapshot with the correct phase/round/planMergeRound for artifact lookup.
 */
export function validatePreviousPhaseArtifacts(
  state: OrchestrationState,
  ctx: PreviousPhaseContext,
): void {
  const prevState = {
    ...state,
    phase: ctx.phase,
    round: ctx.round,
    planMergeRound: ctx.planMergeRound,
  } as OrchestrationState;
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(prevState, agent)) continue;
    const artifactPath = requiredArtifactPath(prevState, agent);
    if (!artifactPath) continue;
    if (!existsSync(artifactPath)) {
      emitEvent({
        event_type: "orchestration_warning",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        message: `Missing artifact from ${ctx.phase}: ${artifactPath.split("/").pop()} (${agent.name})`,
      });
      continue;
    }
    // For pr-create, also warn on malformed content (present but invalid).
    if (ctx.phase === "pr-create") {
      try {
        const content = readFileSync(artifactPath, "utf-8").trim();
        if (content && !isPrUrl(content)) {
          emitEvent({
            event_type: "orchestration_warning",
            source: "orchestration",
            scope: "slot",
            slot: state.slot,
            task: state.taskId,
            message: `Invalid artifact from ${ctx.phase}: ${artifactPath.split("/").pop()} contains non-URL content (${agent.name})`,
          });
        }
      } catch { /* read error — skip */ }
    }
  }
}

/**
 * Item B: after `plan-merge` completes (i.e., on entry to `plan-review`), warn
 * when the merged plan file lacks a `## Regression Tests` section. The reviewer
 * template (`pair-reviewer-plan-review.md`) already REQUEST_CHANGES when the
 * section is absent; this warning fires earlier, giving the coder a chance to
 * add it before implementing.
 *
 * Advisory only — silent on any read/regex error. Opt-out via
 * `LUDICS_WARN_MISSING_TESTS_SECTION=0` (or `false`, case-insensitive).
 */
export function warnMissingRegressionTestsSection(
  state: OrchestrationState,
  ctx: PreviousPhaseContext,
): void {
  if (ctx.phase !== "plan-merge") return;
  const envVal = process.env.LUDICS_WARN_MISSING_TESTS_SECTION;
  if (envVal === "0" || (envVal && envVal.toLowerCase() === "false")) return;
  try {
    const path = mergedPlanFilePath(state.peerSyncDir, ctx.round, ctx.planMergeRound);
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf-8");
    if (/^## Regression Tests$/m.test(content)) return;
    emitEvent({
      event_type: "orchestration_warning",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      message: `Merged plan ${path.split("/").pop()} has no '## Regression Tests' section; reviewer backstop (pair-reviewer-plan-review.md) will catch this, but you may want to add one before implementing.`,
    });
  } catch { /* swallow — advisory only */ }
}

/**
 * Item A: stale-base warning. Before the coder starts planning or working,
 * refresh `origin/<main>` and count the commits landed on it since the
 * worktree's merge-base. If the count meets the threshold (default 5, tunable
 * via `LUDICS_WARN_BASE_STALENESS_THRESHOLD`; `<=0` disables), emit a nudge
 * toward `git rebase`.
 *
 * Dedup memo (`state.staleBaseLastWarnedRound`/`...Count`) rewarns only when
 * the count grows within the same round; reset on round change.
 * Advisory only — any git failure silently skips.
 */
export function warnStaleBase(state: OrchestrationState): void {
  const raw = process.env.LUDICS_WARN_BASE_STALENESS_THRESHOLD;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  const threshold = Number.isFinite(parsed) ? parsed : 5;
  if (threshold <= 0) return;
  try {
    const coder = state.agents.find((a) => a.role === "coder");
    if (!coder) return;
    const worktree = coder.worktreePath;
    if (!worktree || !existsSync(worktree)) return;
    const baseBranch = defaultMainBranch(state.projectDir);
    if (!baseBranch) return;

    // Refresh origin/<main>. If fetch fails (offline, bad remote URL, no
    // network, timeout, credential prompt) we must not fall through and
    // measure against a stale cached `origin/<main>` — the whole point of the
    // warning is that the local ref matches GitHub. Treat any non-zero exit
    // (or timeout-induced kill) as "skip this check."
    //
    // `GIT_TERMINAL_PROMPT=0` disables interactive credential prompts that
    // would otherwise hang phase entry on private-repo misconfigurations.
    // `timeout` (ms) bounds the wall-clock cost: default 10s, overridable via
    // LUDICS_WARN_FETCH_TIMEOUT_MS for exotic network setups.
    const timeoutRaw = process.env.LUDICS_WARN_FETCH_TIMEOUT_MS;
    const timeoutParsed = timeoutRaw !== undefined ? parseInt(timeoutRaw, 10) : NaN;
    const fetchTimeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed > 0
      ? timeoutParsed
      : 10_000;
    const fetched = Bun.spawnSync(
      ["git", "fetch", "origin", baseBranch],
      {
        cwd: worktree,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: fetchTimeoutMs,
      },
    );
    if (fetched.exitCode !== 0) return;

    const mb = Bun.spawnSync(
      ["git", "merge-base", "HEAD", `origin/${baseBranch}`],
      { cwd: worktree },
    );
    if (mb.exitCode !== 0) return;
    const mergeBase = String(mb.stdout).trim();
    if (!mergeBase) return;

    const rev = Bun.spawnSync(
      ["git", "rev-list", "--count", `${mergeBase}..origin/${baseBranch}`],
      { cwd: worktree },
    );
    if (rev.exitCode !== 0) return;
    const countParsed = parseInt(String(rev.stdout).trim(), 10);
    if (!Number.isFinite(countParsed)) return;
    const count = countParsed;

    // Reset dedup memo on round change.
    if (state.staleBaseLastWarnedRound !== state.round) {
      state.staleBaseLastWarnedRound = state.round;
      state.staleBaseLastWarnedCount = 0;
    }
    // Re-arm dedup when staleness decreases (coder rebased mid-round): a
    // subsequent drift back above threshold should fire again, even if its
    // count is below the previously-warned peak. Without this reset, the
    // "newly needing rebase" warning would be suppressed in exactly the
    // workflow (rebase then drift) it is meant to protect.
    const lastCount = state.staleBaseLastWarnedCount ?? 0;
    if (count < lastCount) {
      state.staleBaseLastWarnedCount = 0;
    }
    const effectiveLastCount = state.staleBaseLastWarnedCount ?? 0;
    if (count < threshold) return;
    if (count <= effectiveLastCount) return;

    state.staleBaseLastWarnedCount = count;
    state.staleBaseLastWarnedRound = state.round;
    emitEvent({
      event_type: "orchestration_warning",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      message: `Base is ${count} commit(s) stale against origin/${baseBranch} in ${worktree}; consider 'git rebase origin/${baseBranch}' before continuing.`,
    });
  } catch { /* swallow — advisory only */ }
}

interface VerificationGateConfig {
  phase: Phase;
  gate: "prCreate" | "finalMerge";
  successEvent: string;
  checkSuccess: (v: PrVerification) => boolean;
  formatSuccess: (prUrl: string, v: PrVerification) => string;
  formatFailure: (prUrl: string, v: PrVerification) => string;
}

const PR_CREATE_GATE: VerificationGateConfig = {
  phase: "pr-create",
  gate: "prCreate",
  successEvent: "pr_verified",
  checkSuccess: (v) => v.exists,
  formatSuccess: (prUrl, v) => `PR verified (${v.state}): ${prUrl}`,
  formatFailure: (prUrl, v) => `${v.reason}: ${prUrl}`,
};

const FINAL_MERGE_GATE: VerificationGateConfig = {
  phase: "final-merge",
  gate: "finalMerge",
  successEvent: "merge_verified",
  checkSuccess: (v) => v.exists && v.merged === true,
  formatSuccess: (prUrl) => `PR merge verified: ${prUrl}`,
  formatFailure: (prUrl, v) => {
    let detail = v.reason;
    if (v.exists && !v.merged) {
      detail = `PR is ${v.state} but not merged`;
      if (v.mergeableState && v.mergeableState !== "clean") {
        detail += ` (mergeable_state: ${v.mergeableState})`;
      }
    }
    return `${detail}: ${prUrl}`;
  },
};

/**
 * Unified verification gate: after agents are done, verify the expected outcome
 * on GitHub. Returns a decision: advance (verified), redispatch (retry),
 * hold (max retries), skip (not applicable).
 */
export { PR_CREATE_GATE, FINAL_MERGE_GATE };
export function verifyPhaseOutcome(state: OrchestrationState, config: VerificationGateConfig): VerificationDecision {
  if (state.phase !== config.phase) return "skip";
  if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return "skip";

  const prUrl = getFirstPrUrl(state);
  if (!prUrl) {
    const suffix = config.gate === "prCreate" ? " in agent state or .pr artifact" : "";
    return handleVerifyFailure(state, config.gate, `No PR URL found${suffix}`);
  }

  const v = getPrVerification(prUrl);
  if (config.checkSuccess(v)) {
    emitEvent({
      event_type: config.successEvent,
      source: "orchestration", scope: "slot",
      slot: state.slot, task: state.taskId,
      action: `${config.phase} verification`, status: "success",
      message: config.formatSuccess(prUrl, v),
    });
    state.phaseRetryContext = null;
    return "advance";
  }

  return handleVerifyFailure(state, config.gate, config.formatFailure(prUrl, v));
}

export function handleVerifyFailure(
  state: OrchestrationState,
  gate: "prCreate" | "finalMerge",
  reason: string,
): VerificationDecision {
  const attemptsKey = gate === "prCreate" ? "prCreateVerifyAttempts" : "finalMergeVerifyAttempts";
  const eventType = gate === "prCreate" ? "pr_missing" : "merge_failed";
  const phaseLabel = gate === "prCreate" ? "pr-create" : "final-merge";

  // Already at max retries — hold silently without re-emitting events/notifications.
  if ((state[attemptsKey] ?? 0) >= MAX_VERIFY_ATTEMPTS) {
    return "hold";
  }

  state[attemptsKey] = (state[attemptsKey] ?? 0) + 1;
  const attempts = state[attemptsKey]!;

  emitEvent({
    event_type: eventType,
    source: "orchestration", scope: "slot",
    slot: state.slot, task: state.taskId,
    action: `${phaseLabel} verification`, status: "failed",
    message: `${reason} (attempt ${attempts}/${MAX_VERIFY_ATTEMPTS})`,
  });

  if (attempts >= MAX_VERIFY_ATTEMPTS) {
    emitEvent({
      event_type: "manual_intervention_required",
      source: "orchestration", scope: "slot",
      slot: state.slot, task: state.taskId,
      action: `${phaseLabel} verification exhausted`, status: "blocked",
      message: `${phaseLabel} failed after ${MAX_VERIFY_ATTEMPTS} attempts — manual intervention needed`,
    });
    notifyAgents(
      `Slot ${state.slot} [${state.taskId}]: ${phaseLabel} verification failed ${MAX_VERIFY_ATTEMPTS} times — needs human`,
      3,
      `Slot ${state.slot}: manual intervention`,
    );
    // Surface in dashboard via has_questions tile.
    // Use cluster forwarding when running as a worker so the controller's task file is updated.
    const questionLine = `- **Manual intervention required (slot ${state.slot})**: ${phaseLabel} failed after ${MAX_VERIFY_ATTEMPTS} attempts`;
    surfaceManualIntervention(state.taskId, questionLine, state.harnessDir ?? defaultHarnessDir());
    return "hold";
  }

  // Prepare for re-dispatch
  state.phaseRetryContext = reason;
  preparePhaseRedispatch(state);
  return "redispatch";
}

/** Set has_questions on the task and append the reason to ## Questions, cluster-safe. */
export function surfaceManualIntervention(
  taskId: string,
  questionLine: string,
  harnessDir: string = defaultHarnessDir(),
): void {
  // Always write locally first so the data is persisted even if cluster forwarding fails.
  const taskFile = taskFilePath(taskId, harnessDir);
  if (existsSync(taskFile)) {
    addFrontmatterField(taskFile, "has_questions", "true");
    appendToSection(taskFile, "Questions", questionLine);
  }
  // On worker machines, also forward to the controller so the dashboard sees it.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- circular-dep chain: cluster.ts imports emitEvent from events.ts
    const { clusterIsController, clusterCurrentMachineName } = require("../cluster.ts") as typeof import("../cluster.ts");
    if (clusterCurrentMachineName() && !clusterIsController()) {
      // Fire-and-forget: handleVerifyFailure is synchronous, so we cannot await.
      import("../cluster-http.ts").then(({ clusterPostTaskUpdate, clusterPostTaskSectionAppend }) => {
        clusterPostTaskUpdate(taskId, "has_questions", "true").catch(() => {});
        clusterPostTaskSectionAppend(taskId, "Questions", questionLine).catch(() => {});
      }).catch(() => {});
    }
  } catch { /* standalone mode */ }
}

/** Get the first available PR URL from agent runtime state, falling back to peer-sync artifact. */
export function getFirstPrUrl(state: OrchestrationState): string | null {
  for (const agent of state.agents) {
    const url = state.agentStates[agent.name]?.prUrl;
    if (url) return url;
  }
  // Fallback: read directly from .pr file (runtime.prUrl may be null if refresh didn't run)
  for (const agent of state.agents) {
    const url = readPrUrl(state.peerSyncDir, agent.name);
    if (url && isPrUrl(url)) return url;
  }
  return null;
}

/**
 * Reset participating agents' done status so the main loop re-enters the phase
 * and re-dispatches them with retry context.
 */
export function preparePhaseRedispatch(state: OrchestrationState): void {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name];
    if (!runtime) continue;
    runtime.turnLifecycle = null;
    runtime.status = "idle";
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = "verification failed — retry pending";
    runtime.interrupted = false;
  }
  state.phaseDispatched = false;
  state.currentPhaseToken = undefined;
  state.phaseStartedAt = nowEpoch(); // Reset timer so retries get a fresh timeout window
}
/** Force-settle a hung agent after this many failed nudges.
 *  Escalation: Enter → "Continue." → full re-dispatch → force-settle. */
const HUNG_MAX_NUDGE_ATTEMPTS = 3;

// --- Interrupted agent constants ---
// An "interrupted agent" had its turn settle (stop hook fired) but never wrote
// a done status — cut short by provider error, capacity limit, etc.
// Detection is immediate; recovery is a "Continue." nudge.
/** Minimum seconds between "Continue." nudges for interrupted agents. */
const INTERRUPTED_NUDGE_COOLDOWN_S = 300;

function phaseActiveStatus(phase: OrchestrationState["phase"]): string {
  return `${phase}-active`;
}

/**
 * Refresh agent statuses from peer-sync (shared) and transport-specific backend.
 * The transport's refreshAgentTransportState() handles turn lifecycle updates
 * from the backend (t3code snapshot, tmux process state, etc.).
 */
export async function refreshAgentStatuses(state: OrchestrationState, transport: OrchestrationTransport): Promise<void> {
  // --- 1. Read peer-sync status (shared across all transports) ---
  for (const agent of state.agents) {
    const peerStatus = readAgentStatus(state.peerSyncDir, agent.name);
    const runtime = state.agentStates[agent.name]!;
    runtime.status = peerStatus.status;
    runtime.statusEpoch = peerStatus.epoch;
    runtime.statusMessage = peerStatus.message;
    runtime.prUrl = readPrUrl(state.peerSyncDir, agent.name) ?? runtime.prUrl;

    if (readMarker(state.peerSyncDir, `${agent.name}.merged`) !== null) {
      runtime.status = "merged";
      runtime.statusMessage = "merged";
    }
  }

  // --- 2. Transport-specific state refresh (turn lifecycle, process state) ---
  await transport.refreshAgentTransportState(state);

  // --- 3. Detect inconsistencies ---
  for (const agent of state.agents) {
    detectAgentInconsistencies(state, agent, state.agentStates[agent.name]!);
  }
}

/** Emit warning events for peer-sync / snapshot inconsistencies. */
function detectAgentInconsistencies(
  state: OrchestrationState,
  agent: AgentConfig,
  runtime: OrchestrationState["agentStates"][string],
): void {
  if (!agentParticipatesInPhase(state, agent)) return;
  const lc = runtime.turnLifecycle;
  if (!lc) return;

  // Inconsistency: peer-sync says done but turn still running.
  if (DONE_STATUSES.has(runtime.status) && (lc.state === "running" || lc.state === "dispatched")) {
    emitEvent({
      event_type: "orchestration_warning",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      message: `${agent.name}: peer-sync says "${runtime.status}" but turn lifecycle is "${lc.state}"`,
    });
  }
}

/**
 * Detect hung agents and send nudge messages.
 * A "hung agent" appears to be working (lifecycle running/dispatched) but its
 * terminal output is static — the agent is frozen or finished without signaling.
 *
 * Hung conditions (only reached if snapshot reconciliation didn't resolve it):
 * 1. Running hung: DONE_STATUSES + lc.state === "running" + pane static > HUNG_RUNNING_THRESHOLD_S
 * 2. Dispatch hung: lc.state === "dispatched" + pane static > HUNG_DISPATCH_THRESHOLD_S
 * 3. Idle running hung: lc.state === "running" + NOT done + pane static > HUNG_IDLE_RUNNING_THRESHOLD_S
 *    (prompt injection failed or agent went incoherent and stopped producing output)
 *
 * Recovery progression: detect → nudge (up to HUNG_MAX_NUDGE_ATTEMPTS) → force-settle
 */
export async function detectAndNudgeHungAgents(
  state: OrchestrationState,
  transport: OrchestrationTransport,
): Promise<void> {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name]!;
    const lc = runtime.turnLifecycle;
    if (!lc || lc.state === "settled" || lc.state === "error") continue;
    if (runtime.interrupted) continue;

    const now = nowEpoch();
    let isHung = false;
    let hungType: "running" | "dispatch" | null = null;

    // Running stall: peer-sync done + turn still running + pane output static.
    // If pane output is still changing, the agent is actively working — not stalled.
    if (DONE_STATUSES.has(runtime.status) && lc.state === "running" && lc.turnStartedAt) {
      const paneStaticSince = lc.lastPaneChangeAt
        ? now - Math.floor(new Date(lc.lastPaneChangeAt).getTime() / 1000)
        : now - Math.floor(new Date(lc.turnStartedAt).getTime() / 1000);
      if (paneStaticSince > HUNG_RUNNING_THRESHOLD_S) {
        isHung = true;
        hungType = "running";
      }
    }
    // Dispatch stall: turn never started + pane output static.
    else if (lc.state === "dispatched") {
      const paneStaticSince = lc.lastPaneChangeAt
        ? now - Math.floor(new Date(lc.lastPaneChangeAt).getTime() / 1000)
        : now - Math.floor(new Date(lc.dispatchedAt).getTime() / 1000);
      if (paneStaticSince > HUNG_DISPATCH_THRESHOLD_S) {
        isHung = true;
        hungType = "dispatch";
      }
    }
    // Idle-running stall: agent process is alive (state === "running") but
    // never wrote a done status and pane output has gone static.  Catches
    // prompt-injection failures (agent alive but idle) and incoherent agents
    // that stopped producing output without signaling completion.
    else if (!DONE_STATUSES.has(runtime.status) && lc.state === "running" && lc.turnStartedAt) {
      const paneStaticSince = lc.lastPaneChangeAt
        ? now - Math.floor(new Date(lc.lastPaneChangeAt).getTime() / 1000)
        : now - Math.floor(new Date(lc.turnStartedAt).getTime() / 1000);
      if (paneStaticSince > HUNG_IDLE_RUNNING_THRESHOLD_S) {
        isHung = true;
        hungType = "running";
      }
    }

    if (!isHung) continue;

    // --- First detection ---
    if (!(lc.stallDetectedAt ?? null)) {
      lc.stallDetectedAt = isoNow();
      emitEvent({
        event_type: "orchestration_hung_detected",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        agent: agent.name,
        phase: state.phase,
        hungType,
        message: `${agent.name}: hung agent detected (${hungType}), lc.state=${lc.state}, status=${runtime.status}`,
      });
    }

    const attempts = lc.nudgeAttempts ?? 0;

    // --- Force-settle after HUNG_MAX_NUDGE_ATTEMPTS ---
    if (attempts >= HUNG_MAX_NUDGE_ATTEMPTS) {
      emitEvent({
        event_type: "orchestration_hung_force_settle",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        agent: agent.name,
        phase: state.phase,
        attempts,
        message: `${agent.name}: force-settling hung agent after ${attempts} nudge attempts`,
      });
      await interruptAgent(state, agent, transport);
      continue;
    }

    // --- Nudge cooldown ---
    const lastNudge = lc.lastNudgeAt
      ? Math.floor(new Date(lc.lastNudgeAt).getTime() / 1000)
      : 0;
    if (now - lastNudge < HUNG_NUDGE_COOLDOWN_S) continue;

    // --- Send phase-aware nudge with escalation ---
    // Idle agents: Enter → "Continue." → full re-dispatch → force-settle
    // Done agents: "stop" message → force-settle
    // Dispatch stuck: "are you there?" → force-settle
    try {
      if (runtime.status === "idle" && attempts === 0) {
        // Nudge #1: prompt may be buffered but Enter didn't fire
        await transport.sendEnter(state, agent);
      } else if (runtime.status === "idle" && attempts === 1) {
        // Nudge #2: lightweight poke — agent may be alive but waiting for input
        await transport.sendTurn(state, agent, "Continue.");
      } else {
        let nudgeMessage: string;
        if (runtime.status === "idle") {
          // Nudge #3: full re-dispatch — prompt injection likely failed entirely
          nudgeMessage = await composeSkillMessage(state, agent);
        } else if (hungType === "dispatch") {
          nudgeMessage = `Your session appears stuck. Please respond to confirm you are working on the ${state.phase} phase.`;
        } else {
          nudgeMessage = `Your work for the ${state.phase} phase is complete. Stop and wait for further instructions.`;
        }
        await transport.sendTurn(state, agent, nudgeMessage);
      }
      lc.nudgeAttempts = attempts + 1;
      lc.lastNudgeAt = isoNow();
      emitEvent({
        event_type: "orchestration_nudge_sent",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        agent: agent.name,
        phase: state.phase,
        attempt: attempts + 1,
        hungType,
        message: `${agent.name}: hung nudge #${attempts + 1} sent (${hungType})`,
      });
    } catch (err) {
      // Nudge dispatch failed — log, don't throw. Next cycle retries.
      emitEvent({
        event_type: "orchestration_nudge_failed",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        agent: agent.name,
        message: `${agent.name}: nudge dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      // Do NOT increment nudgeAttempts on failure — the next poll cycle will retry.
    }
  }
}

// ---------------------------------------------------------------------------
// ttyd health check — restart dead ttyd processes so dashboard terminals stay live
// ---------------------------------------------------------------------------

let lastTtydCheckAt = 0;

async function ensureTtydAlive(state: OrchestrationState): Promise<void> {
  if (state.backend !== "tmux") return;
  const now = nowEpoch();
  if (now - lastTtydCheckAt < TTYD_HEALTH_CHECK_INTERVAL_S) return;
  lastTtydCheckAt = now;

  const dir = state.harnessDir ?? defaultHarnessDir();
  const tmuxState = readTmuxSlotState(state.slot, dir);
  if (!tmuxState) return;

  let changed = false;
  for (let i = 0; i < state.agents.length; i++) {
    const agent = state.agents[i]!;
    const pid = tmuxState.ttydPids[agent.name];

    // Check if PID is alive
    const alive = pid ? processAlive(pid) : false;
    if (alive) continue;

    // Dead or missing — restart
    const role = agentPortRole(agent, i);
    const newPid = startTtyd(state.slot, agent.name, role, state.taskId);
    tmuxState.ttydPids[agent.name] = newPid;
    changed = true;
    emitEvent({
      event_type: "ttyd_restarted",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      agent: agent.name,
      pid: newPid,
      message: `${agent.name}: ttyd died (was pid ${pid ?? "none"}), restarted as pid ${newPid}`,
    });
  }
  if (changed) writeTmuxSlotState(tmuxState, dir);
}

function markActiveAgents(state: OrchestrationState): void {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name]!;
    // Always clear stale interrupt state on phase entry, even for terminal statuses
    runtime.interrupted = false;
    clearInterrupt(state.peerSyncDir, agent.name);
    // Don't overwrite if agent already has a meaningful status for THIS phase
    const currentPhaseDone = `${state.phase}-done`;
    if (runtime.status === currentPhaseDone || runtime.status === "done" || runtime.status === "merged") {
      continue;
    }
    runtime.status = phaseActiveStatus(state.phase);
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = `entered ${state.phase}`;
  }
}

// ---------------------------------------------------------------------------
// Reset all pr-comments tracking fields to their canonical initial values.
// Called on phase entry (enterPhase) and phase transition (applyPhaseSideEffects)
// so that adding a new field only requires a change in one place.
// Does NOT reset prCodexReviewDeferredSince — it has an independent lifecycle.
// ---------------------------------------------------------------------------
export function resetPrCommentsState(state: OrchestrationState): void {
  state.prCommentsLastCheckAt = state.phaseStartedAt - 600;
  state.prCommentsQuietSince = undefined;
  state.prCommentsCoderDispatched = false;
  state.prMergeableStates = {};
  state.prCodexReviewFallbackPosted = undefined;
}

async function enterPhase(
  state: OrchestrationState,
  transport: OrchestrationTransport,
): Promise<void> {
  if (state.phaseDispatched) return;

  // Generate or reuse the phase token for this phase.
  // On fresh entry: generate new token, persist it, write peer-sync.
  // On crash re-entry: reuse the persisted token so already-dispatched agents are deduped.
  let phaseToken: string;
  if (state.currentPhaseToken) {
    // Re-entry after crash — reuse the token already persisted
    phaseToken = state.currentPhaseToken;
  } else {
    // Fresh entry — generate and persist immediately
    phaseToken = makeId("phase");
    state.currentPhaseToken = phaseToken;
  }

  writePeerSync(state, phaseToken);

  // Validate artifacts from the previous phase (AC2).
  // Uses pre-mutation context persisted on state before applyPhaseSideEffects().
  // Survives crash/resume because it's part of the persisted OrchestrationState.
  if (state.previousPhaseCtx) {
    validatePreviousPhaseArtifacts(state, state.previousPhaseCtx);
    // Item B: content-level check on the merged plan (gated on ctx.phase === "plan-merge").
    warnMissingRegressionTestsSection(state, state.previousPhaseCtx);
    state.previousPhaseCtx = undefined; // consumed
  }

  // Item A: stale-base warning on entry to `plan` (primary hook) and `work`
  // (covers plan-skip modes and staleness that lands mid-plan). Dedup is
  // "newly needing rebase" per round — see warnStaleBase().
  if (state.phase === "plan" || state.phase === "work") {
    warnStaleBase(state);
  }

  markActiveAgents(state);

  // Reset pr-comments tracking state on phase entry.
  // Don't dispatch agents yet — wait for actual comments/reviews to arrive.
  // checkAndRedispatchPrComments will handle the first dispatch when needed.
  if (state.phase === "pr-comments") {
    resetPrCommentsState(state);
    // pr-comments doesn't dispatch agents — it needs them to appear "done" so
    // checkAndRedispatchPrComments can poll GitHub and redispatch when comments
    // arrive. Write a fresh done status and clear lifecycle/fingerprint so
    // isAgentDone accepts it.
    for (const agent of state.agents) {
      if (!agentParticipatesInPhase(state, agent)) continue;
      const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
      writeStatusFile(statusPath, "pr-comments-done", "awaiting-comments");
      const rt = state.agentStates[agent.name];
      if (rt) {
        rt.status = "pr-comments-done";
        rt.statusEpoch = nowEpoch();
        rt.statusMessage = "awaiting-comments";
        rt.turnLifecycle = null;
        rt.dispatchStatusFingerprint = undefined;
      }
    }
    state.phaseDispatched = true;
    state.currentPhaseToken = undefined;
    return;
  }
  if (state.phase === "setup") {
    state.phaseDispatched = true;
    state.currentPhaseToken = undefined;
    return;
  }

  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;

    // Skip agents already dispatched for this phase token (crash recovery dedup)
    const existing = state.agentStates[agent.name]?.turnLifecycle;
    if (existing && existing.state === "dispatched" && existing.phaseToken === phaseToken) {
      continue;
    }

    // Skip agents whose peer-sync status already shows done for THIS phase
    // (resume after crash — agent finished but orchestrator didn't see it).
    // Only match the current phase's done status — a leftover "pr-comments-done"
    // must not prevent dispatch in "final-merge".
    {
      const rt = state.agentStates[agent.name]!;
      const agentStatus = rt.status;
      const currentPhaseDone = `${state.phase}-done`;

      // "merged" is driven by the <agent>.merged marker, not .status — always skip.
      if (agentStatus === "merged") continue;

      if (agentStatus === currentPhaseDone || agentStatus === "done") {
        // On resume or skipToPhase(), .status may be stale from a previous phase.
        // isAgentDone()'s null-lifecycle branch has a fingerprint gate, but the
        // settled branch does not — so we must guard here against stale settled
        // lifecycles that survived skipToPhase() (which doesn't clear turnLifecycle).
        const baseline = rt.dispatchStatusFingerprint;
        const isStale = baseline != null
          && statusFileFingerprint(state.peerSyncDir, agent.name) === baseline;
        if (!isStale && isAgentDone(state, agent)) {
          continue; // genuinely done — skip dispatch
        }
        // Stale status or missing artifact — fall through to dispatch
      }
    }

    // Reset .status file to known initial state before dispatch (AC1).
    // Placed AFTER the dedup checks above so that on crash re-entry we don't
    // clobber a real <phase>-done written by an agent that completed while the
    // orchestrator was down.
    const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
    writeStatusFile(statusPath, `${state.phase}-pending`, "awaiting");

    // Capture fingerprint from the reset .status file written above.
    const dispatchFp = statusFileFingerprint(state.peerSyncDir, agent.name);

    const runtime = state.agentStates[agent.name]!;
    runtime.dispatchStatusFingerprint = dispatchFp;

    const skillMessage = await composeSkillMessage(state, agent);
    const commandId = await transport.sendTurn(state, agent, skillMessage);

    // Initialize per-agent turn lifecycle for this phase.
    runtime.turnLifecycle = {
      dispatchCommandId: commandId,
      dispatchedAt: isoNow(),
      phaseToken,
      observedTurnId: null,
      state: "dispatched",
      turnStartedAt: null,
      turnCompletedAt: null,
      completionSource: null,
      statusFileFingerprint: dispatchFp,
      lastStopHookAt: null,
      stallDetectedAt: null,
      nudgeAttempts: 0,
      lastNudgeAt: null,
      preNudgeAssistantMessageId: null,
    };

    // Persist after each agent dispatch — crash recovery will have lifecycle data
    persistState(state, state.harnessDir ?? defaultHarnessDir());
  }

  state.phaseDispatched = true;
  state.currentPhaseToken = undefined;
  // No wait-for-running loop needed.  The lifecycle model tracks "dispatched"
  // as a distinct state — pollUntilDone won't consider the agent done until the
  // lifecycle advances to "settled" or "error".
}

/** Send a fresh turn message to each participating agent without changing phaseDispatched. */
async function redispatchForPrComments(state: OrchestrationState, transport: OrchestrationTransport): Promise<void> {
  const phaseToken = readPhaseToken(state.peerSyncDir) ?? makeId("phase");
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name]!;
    // Clear any latched interrupt state from a previous timeout so the new turn
    // isn't immediately treated as done by isAgentDone().
    runtime.interrupted = false;
    clearInterrupt(state.peerSyncDir, agent.name);
    runtime.status = "pr-comments-active";
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = "re-dispatched for new PR comments";
    // Touch + capture baseline BEFORE sendTurn.
    touchStatusFile(state.peerSyncDir, agent.name);
    const dispatchFp = statusFileFingerprint(state.peerSyncDir, agent.name);
    runtime.dispatchStatusFingerprint = dispatchFp;
    const skillMessage = await composeSkillMessage(state, agent);
    const commandId = await transport.sendTurn(state, agent, skillMessage);
    if (agent.role === "coder") state.prCommentsCoderDispatched = true;
    // Reset lifecycle for the re-dispatched turn.
    runtime.turnLifecycle = {
      dispatchCommandId: commandId,
      dispatchedAt: isoNow(),
      phaseToken,
      observedTurnId: null,
      state: "dispatched",
      turnStartedAt: null,
      turnCompletedAt: null,
      completionSource: null,
      statusFileFingerprint: dispatchFp,
      lastStopHookAt: null,
      stallDetectedAt: null,
      nudgeAttempts: 0,
      lastNudgeAt: null,
      preNudgeAssistantMessageId: null,
    };
  }
}

/** Re-dispatch specific agents to resolve PR merge conflicts. */
async function redispatchForConflict(
  state: OrchestrationState,
  transport: OrchestrationTransport,
  conflictAgents: AgentConfig[],
): Promise<void> {
  const templatePath = join(ludicsRoot(), "skills", "orchestration", "pr-conflict-resolve.md");
  const phaseToken = readPhaseToken(state.peerSyncDir) ?? makeId("phase");

  for (const agent of conflictAgents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name]!;
    runtime.interrupted = false;
    clearInterrupt(state.peerSyncDir, agent.name);
    runtime.status = "pr-comments-active";
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = "re-dispatched for PR conflict resolution";
    touchStatusFile(state.peerSyncDir, agent.name);
    const dispatchFp = statusFileFingerprint(state.peerSyncDir, agent.name);
    runtime.dispatchStatusFingerprint = dispatchFp;

    const skillMessage = await composeSkillMessage(state, agent, templatePath);
    const commandId = await transport.sendTurn(state, agent, skillMessage);
    runtime.turnLifecycle = {
      dispatchCommandId: commandId,
      dispatchedAt: isoNow(),
      phaseToken,
      observedTurnId: null,
      state: "dispatched",
      turnStartedAt: null,
      turnCompletedAt: null,
      completionSource: null,
      statusFileFingerprint: dispatchFp,
      lastStopHookAt: null,
      stallDetectedAt: null,
      nudgeAttempts: 0,
      lastNudgeAt: null,
      preNudgeAssistantMessageId: null,
    };

    emitEvent({
      event_type: "pr_conflict_detected",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      message: `PR conflict detected for ${agent.name}, dispatching conflict resolution`,
    });
  }
}

/**
 * Poll GitHub for new PR comments during the pr-comments phase.
 * Re-dispatches agents when new comments are found; updates prCommentsQuietSince otherwise.
 */
export async function checkAndRedispatchPrComments(state: OrchestrationState, transport: OrchestrationTransport): Promise<void> {
  const now = nowEpoch();
  const checkInterval = state.config.prCommentsCheckInterval;
  const lastCheck = state.prCommentsLastCheckAt ?? state.phaseStartedAt;

  if (now - lastCheck < checkInterval) return;

  const agentsWithPr = state.agents.filter((a) => !!state.agentStates[a.name]?.prUrl);

  if (agentsWithPr.length === 0) {
    state.prCommentsLastCheckAt = now;
    if (!state.prCommentsQuietSince) state.prCommentsQuietSince = now;
    return;
  }

  // Check if any PR has been merged externally — create the merged marker so
  // evaluateTransition can advance past pr-comments.
  for (const agent of agentsWithPr) {
    const prUrl = state.agentStates[agent.name]!.prUrl!;
    const markerFile = join(state.peerSyncDir, `${agent.name}.merged`);

    if (!existsSync(markerFile) && isPrMerged(prUrl)) {
      // Uniform post-merge handling: the working-repo (staging) PR merge IS the
      // completion signal. Upstream-specific marker/event paths were removed — the
      // upstream repo is now only used for issue tracking and briefing lag reporting.
      atomicWriteFileSync(markerFile, "merged\n");
      state.agentStates[agent.name]!.status = "merged";
      state.agentStates[agent.name]!.statusMessage = "PR merged externally";
      emitEvent({
        event_type: "pr_merged",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        message: `PR merged: ${prUrl}`,
      });
      const mergedTaskLabel = state.taskId;
      notifyAgents(
        `Slot ${state.slot} [${mergedTaskLabel}]: PR merged: ${prUrl}`,
        3,
        `Slot ${state.slot}: PR merged`,
      );
    }
  }

  // --- PR body drift annotation ---
  // Edge-triggered: on the first poll after the branch's commit count diverges
  // from the baseline captured at pr-create, post a notice comment to the PR
  // and advance the baseline. Fail-safe: missing baseline or git errors skip
  // silently (no false positives).
  checkAndAnnotatePrBodyDrift(state);

  // Only re-dispatch once all participating agents have finished their current turn.
  // Do NOT advance prCommentsLastCheckAt here — we have not polled GitHub yet, so
  // advancing the checkpoint would cause comments that arrive while agents are active
  // to fall outside the next poll's "since" window and be silently skipped.
  const participants = state.agents.filter((a) => agentParticipatesInPhase(state, a));
  const allDone = participants.every((a) => isAgentDone(state, a));
  if (!allDone) return;

  // --- Conflict detection: edge-triggered on non-dirty → dirty transition ---
  if (!state.prMergeableStates) state.prMergeableStates = {};
  const conflictAgents: AgentConfig[] = [];
  for (const agent of agentsWithPr) {
    const runtime = state.agentStates[agent.name]!;
    const prUrl = runtime.prUrl!;
    const verification = getPrVerification(prUrl);
    const current = verification.mergeableState ?? null;
    const previous = state.prMergeableStates[agent.name] ?? null;

    // Only update tracked state for non-unknown values
    if (current && current !== "unknown") {
      state.prMergeableStates[agent.name] = current;
    }

    // Edge trigger: fire only on transition TO dirty
    if (current === "dirty" && previous !== "dirty") {
      conflictAgents.push(agent);
    }
  }
  if (conflictAgents.length > 0) {
    await redispatchForConflict(state, transport, conflictAgents);
    state.prCommentsQuietSince = 0; // Reset quiet period
    // Do NOT advance prCommentsLastCheckAt — preserve pending comments for next poll.
    // Caller (pollUntilDone) persists state after this function returns.
    return;
  }

  // --- Deferred Codex review request (per-PR resolution) ---
  if (state.prCodexReviewDeferredSince) {
    const deferralTimeout = Math.min(600, Math.floor(state.config.prCommentsTimeout / 2));
    const elapsed = now - state.prCodexReviewDeferredSince;
    const deadlineReached = elapsed >= deferralTimeout;

    // Collect unique PR URLs
    const uniquePrUrls = new Set<string>();
    for (const agent of agentsWithPr) {
      uniquePrUrls.add(state.agentStates[agent.name]!.prUrl!);
    }

    // Partition: which PRs already have a review, which don't
    const urlsMissingReview: string[] = [];
    for (const prUrl of uniquePrUrls) {
      if (!hasCodexSubmittedReview(prUrl) && !hasCodexPostedComment(prUrl, state.prCodexReviewDeferredSince!)) {
        urlsMissingReview.push(prUrl);
      }
    }

    if (urlsMissingReview.length === 0) {
      // All PRs have submitted reviews — unblock shortcut transition
      state.prCodexReviewDeferredSince = undefined;
      state.prCodexReviewFallbackPosted = undefined;
    } else if (deadlineReached && !state.prCodexReviewFallbackPosted) {
      // Post fallback only for PRs that still lack a submitted review.
      // Keep prCodexReviewDeferredSince set — it blocks the shortcut transition
      // until the review actually arrives (urlsMissingReview.length === 0 above).
      const projectEntry = findProjectConfig(state.projectDir);
      const customPrompt = projectEntry?.codex_review_prompt ?? undefined;
      for (const prUrl of urlsMissingReview) {
        postCodexReviewComment(prUrl, customPrompt);
      }
      state.prCodexReviewFallbackPosted = true;
    }
    // else: within window, some PRs still missing review — keep waiting
  }

  // Count new comments since the last check.
  let totalNewComments = 0;
  for (const agent of agentsWithPr) {
    totalNewComments += fetchNewPrCommentCount(state.agentStates[agent.name]!.prUrl!, lastCheck);
  }

  state.prCommentsLastCheckAt = now;

  if (totalNewComments > 0) {
    state.prCommentsQuietSince = 0; // Reset quiet period.
    await redispatchForPrComments(state, transport);
  } else if (!state.prCommentsQuietSince) {
    state.prCommentsQuietSince = now;
  }
}

/**
 * Detect and annotate PR-body drift during `pr-comments`.
 *
 * For each agent with a PR and a captured baseline, compare the current
 * `origin/<base>..HEAD` commit count against `prBodyBaselineCommits`. On
 * mismatch, post a short notice comment via `postPrDriftComment` and advance
 * both the baseline and the annotation-dedup marker, so a subsequent push
 * that lands on a new count will re-fire and a same-count re-poll won't.
 *
 * Skip rules (fail-safe / no false positives):
 *  - No baseline captured yet (pre-pr-create or git error at capture time).
 *  - PR already merged (body is archival once merged).
 *  - `countCommitsAhead` returns null (git error — cannot compare).
 *  - Current count equals baseline (no drift).
 *  - Current count matches `prBodyDriftAnnotatedAtCommits` (debounce).
 */
export function checkAndAnnotatePrBodyDrift(state: OrchestrationState): void {
  const agentsWithPr = state.agents.filter((a) => !!state.agentStates[a.name]?.prUrl);
  for (const agent of agentsWithPr) {
    const runtime = state.agentStates[agent.name]!;
    const prUrl = runtime.prUrl!;
    // Skip merged PRs before any git/capture work — body is archival.
    if (isPrMerged(prUrl)) continue;
    // Lazy capture: covers flows that skipped pr-create (e.g. update-docs ->
    // pr-comments when a PR already exists) and PR-URL-change recapture.
    // On the first tick baseline === current, so no annotation fires.
    capturePrBodyBaseline(state, agent, runtime);
    const baseline = runtime.prBodyBaselineCommits;
    if (baseline === undefined) continue;
    const current = countCommitsAhead(agent.worktreePath, state.projectDir);
    if (current === null) continue;
    if (current === baseline) continue;
    if (runtime.prBodyDriftAnnotatedAtCommits === current) continue;

    const baselineAt = runtime.prBodyBaselineAt ?? "";
    const posted = postPrDriftComment(prUrl, baseline, current, baselineAt);
    if (!posted) continue;

    runtime.prBodyDriftAnnotatedAtCommits = current;
    runtime.prBodyBaselineCommits = current;
    runtime.prBodyBaselineAt = isoNow();
    runtime.prBodyBaselineUrl = prUrl;
    emitEvent({
      event_type: "pr_body_drift_annotated",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      message: `PR body drift annotation posted on ${prUrl} (${baseline} -> ${current} commits)`,
    });
  }
}

/**
 * After agents complete a phase that creates PRs, validate the pr files.
 * If a file contains markdown text instead of a URL, auto-create the PR and rewrite the file.
 *
 * Eager repair (AC3): if a .pr file exists but fails isPrUrl(), attempt repair
 * immediately on each poll cycle — don't wait for the turn to settle.
 * Settled-mode repair: existing behavior for when .pr doesn't exist yet.
 */
export function validateAgentPrFiles(state: OrchestrationState): void {
  const projectRepo = findProjectConfig(state.projectDir)?.repo;
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name];
    if (!runtime) continue;
    const prFile = join(state.peerSyncDir, `${agent.name}.pr`);

    // Eager repair: if .pr file exists but isn't a valid URL, attempt fix immediately.
    // Don't wait for the turn to settle — the file is already known-bad.
    if (existsSync(prFile)) {
      try {
        const content = readFileSync(prFile, "utf-8").trim();
        if (content && !isPrUrl(content)) {
          const fixedUrl = validateAndFixPrFile(prFile, agent.worktreePath, agent.branch, projectRepo);
          if (fixedUrl && !runtime.prUrl) {
            runtime.prUrl = fixedUrl;
            notifyAgents(
              `Slot ${state.slot} [${state.taskId}]: PR created by ${agent.name}: ${fixedUrl}`,
              3,
              `Slot ${state.slot}: PR created`,
            );
          }
          capturePrBodyBaseline(state, agent, runtime);
          continue; // Attempted repair — skip settled-mode path for this agent
        }
      } catch {
        // File read error — fall through to settled-mode check
      }
    }

    // Settled-mode: existing behavior for when .pr doesn't exist yet or is valid.
    const lc = runtime.turnLifecycle;
    const turnSettled = lc && (lc.state === "settled" || lc.state === "error");
    const statusDone = DONE_STATUSES.has(runtime.status);
    if (!turnSettled && !statusDone && !runtime.interrupted) continue;
    const fixedUrl = validateAndFixPrFile(prFile, agent.worktreePath, agent.branch, projectRepo);
    if (fixedUrl && !runtime.prUrl) {
      runtime.prUrl = fixedUrl;
      notifyAgents(
        `Slot ${state.slot} [${state.taskId}]: PR created by ${agent.name}: ${fixedUrl}`,
        3,
        `Slot ${state.slot}: PR created`,
      );
    }
    capturePrBodyBaseline(state, agent, runtime);
  }
}

/**
 * Baseline capture for the drift-annotation tick.
 *
 * Captures the current `origin/<base>..HEAD` commit count on the first poll
 * where `runtime.prUrl` is non-null AND no baseline exists for that URL yet.
 * Subsequent calls for the same PR are no-ops (baseline preserved across
 * ticks and merge-loop re-entry to pr-create).
 *
 * If `runtime.prUrl` has been replaced since the tracked `prBodyBaselineUrl`
 * (an agent replaced the PR mid-flow), the stale baseline + dedup marker are
 * cleared and recapture runs against the new URL — otherwise drift comments
 * could quote a commit history that belongs to a different PR.
 *
 * Callable from both pr-create (via `validateAgentPrFiles`) and pr-comments
 * (via `checkAndAnnotatePrBodyDrift`) so flows that transition directly from
 * `update-docs` (or any other phase) to `pr-comments` still get a sync point
 * — lazy capture on the first drift tick is explicitly sanctioned by the
 * proposal's "Baseline never captured" edge case.
 *
 * A git failure leaves the baseline undefined, causing the drift check to
 * skip fail-safe.
 */
function capturePrBodyBaseline(
  state: OrchestrationState,
  agent: AgentConfig,
  runtime: OrchestrationState["agentStates"][string],
): void {
  if (!runtime.prUrl) return;
  // Invalidate baseline if the tracked PR URL changed (agent replaced the PR).
  if (runtime.prBodyBaselineUrl && runtime.prBodyBaselineUrl !== runtime.prUrl) {
    runtime.prBodyBaselineCommits = undefined;
    runtime.prBodyBaselineAt = undefined;
    runtime.prBodyDriftAnnotatedAtCommits = null;
    runtime.prBodyBaselineUrl = undefined;
  }
  if (runtime.prBodyBaselineCommits !== undefined) return;
  const n = countCommitsAhead(agent.worktreePath, state.projectDir);
  if (n === null) return;
  runtime.prBodyBaselineCommits = n;
  runtime.prBodyBaselineAt = isoNow();
  runtime.prBodyBaselineUrl = runtime.prUrl;
  runtime.prBodyDriftAnnotatedAtCommits = null;
}

export async function interruptAgent(
  state: OrchestrationState,
  agent: AgentConfig,
  transport: OrchestrationTransport,
): Promise<void> {
  writeInterrupt(state.peerSyncDir, agent.name);
  await transport.interruptAgent(state, agent);
  state.agentStates[agent.name]!.interrupted = true;
  state.agentStates[agent.name]!.status = "interrupted";
  state.agentStates[agent.name]!.statusEpoch = nowEpoch();
}

async function handleTimeout(state: OrchestrationState, transport: OrchestrationTransport): Promise<void> {
  const category = PHASE_CATEGORIES[state.phase];
  if (category === "pre-plan" || category === "planning" || category === "terminal") return;

  // Note: for forwarded pr-comments (upstream monitoring), timeout interrupts are NOT
  // suppressed. If redispatchForPrComments dispatched a turn that hangs, it should be
  // interrupted normally. The interrupted state is cleared by redispatchForPrComments
  // when new comments trigger a fresh dispatch, preventing the latch from blocking
  // subsequent turns.

  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name]!;
    if (runtime.interrupted || runtime.status === "done" || runtime.status === "review-done") continue;
    await interruptAgent(state, agent, transport);
  }
}

// ---------------------------------------------------------------------------
// Auto-commit helpers
// ---------------------------------------------------------------------------

/**
 * Auto-commit any uncommitted changes for an agent and optionally push.
 * Logs events for commits, warnings for failures. No-op on clean worktree.
 */
export function autoCommitAgent(
  state: OrchestrationState,
  agent: AgentConfig,
  push: boolean = false,
): void {
  const runtime = state.agentStates[agent.name];
  if (!runtime) return;

  // Build commit message: "[round N] <status message, slot title, or WIP>"
  const statusMsg = runtime.statusMessage?.replace(/\s+/g, " ").trim()
    || state.slotTitle?.trim()
    || "WIP";
  const commitMessage = `[round ${state.round}] ${statusMsg}`;

  const result = autoCommitWorktree(agent.worktreePath, commitMessage);

  if (result.committed) {
    emitEvent({
      event_type: "auto_commit",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      message: `auto-committed ${result.commitSha ?? ""} in ${agent.worktreePath}: ${commitMessage}`,
    });
  } else if (result.error) {
    emitEvent({
      event_type: "orchestration_warning",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      message: `auto-commit failed for ${agent.name}: ${result.error}`,
    });
  }
  // dirty===false && !error → clean tree, silent no-op

  if (result.committed && push) {
    try {
      pushBranch(agent.worktreePath, agent.branch);
    } catch (err) {
      // Best-effort push — warn but don't block phase transition
      emitEvent({
        event_type: "orchestration_warning",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        message: `auto-commit push failed for ${agent.name}: ${err}`,
      });
    }
  }
}

/**
 * Auto-commit all agents, deduplicating by worktreePath (pair mode: both
 * agents share rootWorktree). Attributes the commit to the agent with
 * the newest statusEpoch for deterministic pair-mode attribution.
 */
export function autoCommitAllAgents(
  state: OrchestrationState,
  agents: AgentConfig[],
  push: boolean,
): void {
  // Deduplicate by worktreePath → pick the agent with the newest status.
  const byPath = new Map<string, AgentConfig>();
  for (const agent of agents) {
    const existing = byPath.get(agent.worktreePath);
    if (!existing) {
      byPath.set(agent.worktreePath, agent);
    } else {
      const existingEpoch = state.agentStates[existing.name]?.statusEpoch ?? 0;
      const candidateEpoch = state.agentStates[agent.name]?.statusEpoch ?? 0;
      if (candidateEpoch > existingEpoch) {
        byPath.set(agent.worktreePath, agent);
      }
    }
  }
  for (const agent of byPath.values()) {
    autoCommitAgent(state, agent, push);
  }
}

async function pollUntilDone(state: OrchestrationState, transport: OrchestrationTransport): Promise<void> {
  const timeout = state.config.timeouts[state.phase] ?? 600;
  const deadline = state.phaseStartedAt + timeout;
  const interval = state.config.pollInterval * 1000;

  // Subscribe to transport events for early wakeup (optional; falls back to pure polling).
  let wakeResolve: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  if (transport.subscribeEvents) {
    try {
      unsubscribe = await transport.subscribeEvents(() => {
        if (wakeResolve) {
          wakeResolve();
          wakeResolve = null;
        }
      });
    } catch {
      // Event subscription failed — pure polling fallback.
    }
  }

  try {
    while (true) {
      await refreshAgentStatuses(state, transport);

      // Agent-initiated resumable halt — exit the poll loop immediately so
      // runOrchestration's caller-side handler can persist state, emit the
      // event + priority-5 notification, and flip slot liveness without any
      // intervening phase-advance work (nudge, auto-commit, verification gate).
      if (checkEscalationHalt(state)) return;

      // Detect hung agents (static terminal) and send nudges / force-settle.
      await detectAndNudgeHungAgents(state, transport);

      // Restart dead ttyd processes so dashboard terminals stay live.
      await ensureTtydAlive(state);

      // Validate pr files when coder finishes pr-create (auto-create PR from markdown if needed).
      if (state.phase === "pr-create") {
        validateAgentPrFiles(state);
      }

      // For pr-comments: poll GitHub and re-dispatch before the allAgentsDone short-circuit,
      // so the quiet-period tracking and re-dispatch logic run on the tick when agents finish.
      if (state.phase === "pr-comments") {
        await checkAndRedispatchPrComments(state, transport);
        persistState(state, state.harnessDir ?? defaultHarnessDir());
        // Return to the main loop so evaluateTransition can check quiet-period expiry.
        if (evaluateTransition(state) !== null) return;
      }

      persistState(state, state.harnessDir ?? defaultHarnessDir());

      if (allAgentsDone(state)) return;

      // Nudge interrupted agents: turn settled (stop hook fired) but no done
      // status — cut short by provider error, capacity limit, etc.
      for (const agent of state.agents) {
        if (!agentParticipatesInPhase(state, agent)) continue;
        const rt = state.agentStates[agent.name]!;
        const alc = rt.turnLifecycle;
        if (!alc || alc.state !== "settled") continue;
        if (DONE_STATUSES.has(rt.status)) continue; // actually done
        if (rt.interrupted) continue;

        // Settled but not done — nudge with "Continue."
        const nudgeCooldown = alc.lastNudgeAt
          ? nowEpoch() - Math.floor(new Date(alc.lastNudgeAt).getTime() / 1000)
          : Infinity;
        if (nudgeCooldown < INTERRUPTED_NUDGE_COOLDOWN_S) continue;

        // Reset lifecycle so transport can re-dispatch
        alc.state = "dispatched";
        alc.dispatchCommandId = makeId("nudge");
        alc.dispatchedAt = isoNow();
        alc.turnStartedAt = null;
        alc.turnCompletedAt = null;
        alc.completionSource = null;
        alc.lastNudgeAt = isoNow();
        alc.nudgeAttempts = (alc.nudgeAttempts ?? 0) + 1;
        alc.stallDetectedAt = null;

        const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
        const doneStatus = doneStatusForPhase(state.phase);
        const nudgeMsg = `Continue. Once done, signal completion:\n\`\`\`sh\nprintf '%s|%s|${agent.name} ${state.phase} done\\n' '${doneStatus}' "$(date +%s)" > "${statusPath}"\n\`\`\``;
        await transport.sendTurn(state, agent, nudgeMsg);
        alc.state = "running";
        alc.turnStartedAt = isoNow();
        alc.observedTurnId = makeId("tmux-turn");

        emitEvent({
          event_type: "orchestration_nudge_sent",
          source: "orchestration",
          scope: "slot",
          slot: state.slot,
          task: state.taskId,
          agent: agent.name,
          phase: state.phase,
          attempt: alc.nudgeAttempts,
          stallType: "interrupted",
          message: `${agent.name}: nudged with status-write instruction (turn settled without done status)`,
        });
        persistState(state, state.harnessDir ?? defaultHarnessDir());
      }

      if (nowEpoch() >= deadline) {
        await handleTimeout(state, transport);
        return;
      }

      // Sleep with early wakeup from transport events.
      await Promise.race([
        sleepMs(interval),
        new Promise<void>((resolve) => { wakeResolve = resolve; }),
      ]);
      wakeResolve = null;
    }
  } finally {
    unsubscribe?.();
  }
}

export function applyPhaseSideEffects(state: OrchestrationState, next: OrchestrationState["phase"]): void {
  // Reset verification retry counters when entering the relevant phase fresh.
  if (next === "pr-create") {
    state.prCreateVerifyAttempts = 0;
    state.phaseRetryContext = null;
  }
  if (next === "final-merge") {
    state.finalMergeVerifyAttempts = 0;
    state.phaseRetryContext = null;
  }
  if (next === "pr-comments") {
    resetPrCommentsState(state);
  }
  // Learning-gate bookkeeping: solo skips the review phase, so the gate fires on
  // work → update-docs instead of review → update-docs.
  if (
    next === "update-docs"
    && (state.phase === "review" || (state.mode === "solo" && state.phase === "work"))
    && !shouldRunUpdateDocs(state)
  ) {
    state.lastLearningAt = state.lastLearningAt ?? 0;
  }
  if ((state.phase === "update-docs" || state.phase === "review") && next === "work") {
    state.round += 1;
  }
  // When plan-merge is skipped (plan → plan-review directly), copy the solo plan file
  // to the merged plan path so plan-review skill templates read it via the same path.
  if (state.phase === "plan" && next === "plan-review" && state.mode === "pair") {
    const plansDir = join(state.peerSyncDir, "plans");
    const mergedPath = mergedPlanFilePath(state.peerSyncDir, state.round, 0);
    const { files } = findPlanFiles(state.peerSyncDir, state.round, undefined);
    if (files.length > 0) {
      try {
        copyFileSync(join(plansDir, files[0]), mergedPath);
      } catch {
        // plans dir missing — plan-review will handle gracefully
      }
    }
  }
  // When planning is skipped entirely (pre-plan → work), create a stub merged plan
  // so the reviewer template finds a baseline section and doesn't block on pre-existing failures.
  // Only from pre-plan phases (setup/gather/clarify/pushback) — not from plan/plan-merge/plan-review,
  // which indicate planning was attempted but failed, a different situation.
  if (next === "work" && PHASE_CATEGORIES[state.phase] === "pre-plan") {
    const mergedPath = mergedPlanFilePath(state.peerSyncDir, state.round, 0);
    if (!existsSync(mergedPath)) {
      mkdirSync(join(state.peerSyncDir, "plans"), { recursive: true });
      atomicWriteFileSync(mergedPath, [
        "# Stub Plan (planning phase skipped)",
        "",
        "## Pre-existing test failures (baseline)",
        "",
        "(not recorded -- planning was skipped)",
        "",
      ].join("\n"));
    }
  }
  // Track plan-merge iterations: increment planMergeRound each time we loop back.
  // Only increment if the plan-review phase actually dispatched and ran (phaseDispatched is true).
  // On resume, a stale plan-review → plan-merge transition can fire without the phase
  // having run, which would desync planMergeRound from the artifact filenames.
  if (state.phase === "plan-review" && next === "plan-merge" && state.phaseDispatched) {
    state.planMergeRound = (state.planMergeRound ?? 0) + 1;
  }
  if (state.phase === "merge-vote") {
    const votes = readMergeVotes(state.peerSyncDir, state.mergeRound);
    if (hasConsensus(votes)) {
      state.mergeWinner = determineWinner(votes, state.mergeRound);
    } else if (state.mergeRound >= 2) {
      state.mergeWinner = determineWinner(votes, state.mergeRound);
    } else if (next === "merge-debate") {
      state.mergeRound += 1;
    }
  }
  if (state.phase === "merge-debate" && next === "merge-execute") {
    const votes = readMergeVotes(state.peerSyncDir, state.mergeRound);
    state.mergeWinner = determineWinner(votes, state.mergeRound);
  }
  if (state.phase === "merge-review" && next === "merge-amend") {
    state.mergeRound += 1;
  }
  // Clear stale deferral timer when leaving pr-comments (e.g. pr-comments → merge-vote
  // in hierarchical duo), so merge-loop re-entries don't see an expired timer and post
  // spurious fallback comments.
  if (state.phase === "pr-comments" && state.prCodexReviewDeferredSince) {
    state.prCodexReviewDeferredSince = undefined;
    state.prCodexReviewFallbackPosted = undefined;
  }
  if (state.phase === "update-docs" && next === "pr-comments") {
    state.lastLearningAt = nowEpoch();
    state.lastLearningRound = state.round;
  }
  maybePostCodexReviewRequests(state, state.phase, next);
}

/**
 * Arm deferred Codex review request on initial entry to pr-comments.
 * Instead of posting `@codex review` immediately, sets
 * `prCodexReviewDeferredSince` so that `checkAndRedispatchPrComments()`
 * can check for an auto-triggered review first and only post the
 * explicit request as a fallback after `min(10m, quiet_period/2)`.
 *
 * Only fires on initial pr-comments entry paths (pr-create, update-docs,
 * review), NOT on merge-loop re-entries (merge-review -> pr-comments).
 */
export function maybePostCodexReviewRequests(
  state: OrchestrationState,
  from: OrchestrationState["phase"],
  next: OrchestrationState["phase"],
): void {
  const initialPrCommentsPaths: OrchestrationState["phase"][] = ["pr-create", "update-docs", "review"];
  if (next !== "pr-comments" || !initialPrCommentsPaths.includes(from)) return;

  const hasCodexReviewer = state.agents.some(
    (a) => a.role === "reviewer" && a.provider === "codex",
  );
  if (!hasCodexReviewer) return;

  const hasAnyPrUrl = state.agents.some((a) => !!state.agentStates[a.name]?.prUrl);
  if (!hasAnyPrUrl) return;

  // Arm deferral — use nowEpoch() because phaseStartedAt hasn't been updated yet
  state.prCodexReviewDeferredSince = nowEpoch();
}

function maybeOverrideTransition(state: OrchestrationState, next: OrchestrationState["phase"] | null) {
  // Solo skips review: the work→update-docs override mirrors pair's review→update-docs.
  if (
    next === "update-docs"
    && (state.phase === "review" || (state.mode === "solo" && state.phase === "work"))
    && !shouldRunUpdateDocs(state)
  ) {
    return state.agents.some((agent) => !!state.agentStates[agent.name]?.prUrl)
      ? "pr-comments"
      : "pr-create";
  }
  if (state.phase === "merge-vote" && next === "merge-execute") {
    const votes = readMergeVotes(state.peerSyncDir, state.mergeRound);
    if (!hasConsensus(votes) && state.mergeRound < 2) return "merge-debate";
  }
  if (state.phase === "merge-review" && next === "merge-amend") {
    const approval = readFileIfExists(join(state.peerSyncDir, "merge-review-approval.txt")) ?? "";
    if (approval.toUpperCase().includes("APPROVE")) return "pr-comments";
  }
  return next;
}

function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf-8").trim();
  return value || null;
}

/**
 * Check whether a worktree has zero meaningful changes:
 * no uncommitted diffs AND zero commits ahead of the base branch.
 * Resolves base branch from projectDir (has correct remote refs)
 * to avoid the stale origin/HEAD problem in worktrees.
 */
export function isWorktreeNoOp(worktreePath: string, projectDir: string): boolean {
  try {
    // Step 1: Check for uncommitted diffs (staged + unstaged).
    // Orchestration paths (.peer-sync/ etc.) are in .git/info/exclude,
    // so git status --porcelain won't include them.
    const statusResult = Bun.spawnSync(
      ["git", "status", "--porcelain"],
      { cwd: worktreePath },
    );
    if (statusResult.exitCode !== 0) return false;
    if (String(statusResult.stdout).trim().length > 0) return false;

    // Step 2: Resolve base branch from projectDir (shared remote refs).
    const baseBranch = defaultMainBranch(projectDir);
    const revList = Bun.spawnSync(
      ["git", "rev-list", "--count", `origin/${baseBranch}..HEAD`],
      { cwd: worktreePath },
    );
    if (revList.exitCode !== 0) return false;
    return parseInt(String(revList.stdout).trim(), 10) === 0;
  } catch {
    return false; // Fail closed on any error (e.g., nonexistent path)
  }
}

/**
 * Trigger the coder bail-out protocol: mutate runtime status, write the
 * `.status` file, emit a `bail_out` event, and persist state. Idempotent —
 * if the coder runtime is already `"bail-out"`, skip the status-file write
 * and event emission (but still persist).
 */
export function triggerCoderBailOut(
  state: OrchestrationState,
  coder: AgentConfig,
  action: string,
  message: string,
  statusMessage: string = "no-op: zero commits ahead of base, no uncommitted diffs",
  eventStatus: string = "bail-out",
): void {
  const runtime = state.agentStates[coder.name];
  if (runtime && runtime.status !== "bail-out") {
    runtime.status = "bail-out";
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = statusMessage;
    // Pass runtime.statusEpoch through so the on-disk timestamp stays
    // byte-identical with the in-memory runtime field — verification tests
    // assert this equality, and a second-boundary crossing between
    // nowEpoch() above and writeStatusFile's internal Date.now() would
    // otherwise produce divergent bail-out timestamps for the same event.
    writeStatusFile(
      join(state.peerSyncDir, `${coder.name}.status`),
      "bail-out",
      runtime.statusMessage,
      runtime.statusEpoch,
    );
    emitEvent({
      event_type: "bail_out",
      source: "orchestration", scope: "slot",
      slot: state.slot, task: state.taskId,
      action, status: eventStatus, message,
    });
  }
  persistState(state, state.harnessDir ?? defaultHarnessDir());
}

/**
 * 0-commits-ahead auto-bail-out: if pr-create phase and the coder worktree has no commits
 * ahead of the base branch, skip PR creation and transition directly to done.
 * Returns true if bail-out was triggered (caller should break the loop).
 */
/**
 * Agent-initiated resumable halt.  Called when `isEscalated(state)` is true
 * after a status refresh.  Emits one `escalation_requested` event per raising
 * agent, fires a priority-5 `ludics notify outgoing` summarizing all raises,
 * flips slot liveness to "escalated", and persists state twice (before and
 * after the slot-json flip) so a mid-halt crash leaves a consistent record.
 *
 * Does NOT advance phase — the runner's outer loop must `return` after this
 * runs, not `break` (breaking would fall through to persistState with an
 * unchanged non-"done" phase).  This is the runtime analogue of a user-asked
 * pause: resumption is via `ludics slot N resume`.
 */
export function handleEscalation(state: OrchestrationState): void {
  const raisers = escalatingAgents(state);
  if (raisers.length === 0) return; // defensive: caller should have gated

  persistState(state, state.harnessDir ?? defaultHarnessDir());

  const reasonFor = (name: string): { reason: string; warned: boolean } => {
    const raw = (state.agentStates[name]?.statusMessage ?? "").trim();
    if (raw === "") return { reason: "(no reason provided)", warned: true };
    return { reason: raw, warned: false };
  };

  const parts: string[] = [];
  for (const agent of raisers) {
    const { reason, warned } = reasonFor(agent.name);
    emitEvent({
      event_type: "escalation_requested",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      phase: state.phase,
      agent: agent.name,
      reason,
      reason_provided: !warned,
      message: `${agent.name} escalated at phase ${state.phase}: ${reason}`,
    });
    if (warned) {
      console.error(`ludics: slot ${state.slot} ${agent.name}: escalate status written with empty reason`);
    }
    parts.push(`${agent.name}: ${reason}`);
  }

  const message = raisers.length === 1
    ? `Slot ${state.slot} agent ${raisers[0]!.name} escalated on task ${state.taskId} at phase ${state.phase}: ${reasonFor(raisers[0]!.name).reason}`
    : `Slot ${state.slot} agents escalated on task ${state.taskId} at phase ${state.phase} — ${parts.join(" | ")}`;
  const title = `slot ${state.slot} escalation`;
  try {
    notifyOutgoing(message, 5, title);
  } catch (err) {
    // notify is best-effort; still halt the runner even if the notification
    // pipe is broken. The event log is the authoritative record.
    console.error(`ludics: notifyOutgoing failed for slot ${state.slot} escalation: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const data = readSlotJson(state.slot);
    setSlotLivenessOnData(data, "escalated");
    writeSlotJson(state.slot, data);
  } catch (err) {
    console.error(`ludics: failed to set slot ${state.slot} liveness=escalated: ${err instanceof Error ? err.message : String(err)}`);
  }

  persistState(state, state.harnessDir ?? defaultHarnessDir());
}

/**
 * Named guard for the escalation halt point in `pollUntilDone`. Mirrors the
 * shape of `checkZeroCommitsAutoBailOut`: returns `true` when the caller
 * should stop. Persists state before halting so a mid-halt crash leaves the
 * runner with the latest agent statuses on disk. Caller uses `return` (not
 * `break`) — see `pollUntilDone`.
 */
export function checkEscalationHalt(state: OrchestrationState): boolean {
  if (!isEscalated(state)) return false;
  persistState(state, state.harnessDir ?? defaultHarnessDir());
  return true;
}

export function checkZeroCommitsAutoBailOut(state: OrchestrationState): boolean {
  if (state.phase !== "pr-create") return false;
  const coder = state.agents.find(a => a.role === "coder");
  if (!coder) return false;

  // Fast path: bail-out already confirmed — pair contract (coder+reviewer) or
  // solo contract (lone coder). Skip PR creation and transition directly to done.
  if (isBailedOut(state)) {
    state.phase = "done";
    persistState(state, state.harnessDir ?? defaultHarnessDir());
    return true;
  }

  // Robust no-op detection (replaces fragile origin/HEAD..HEAD).
  if (!isWorktreeNoOp(coder.worktreePath, state.projectDir)) return false;

  triggerCoderBailOut(
    state, coder,
    "pr-create auto-bail-out",
    "0 commits ahead of base branch — no PR possible, skipping to done",
    undefined,
    "skipped",
  );

  // Safety-net: go directly to done. Reviewer cannot participate in pr-create
  // (agentParticipatesInPhase returns false for reviewer), so waiting for
  // bail-out-confirmed would deadlock.
  state.phase = "done";
  persistState(state, state.harnessDir ?? defaultHarnessDir());
  return true;
}

export async function runOrchestration(
  state: OrchestrationState,
  transport?: OrchestrationTransport,
): Promise<void> {
  if (!transport) {
    transport = await createTransport(state);
  }
  // Ensure every downstream persistState preserves the caller-selected harness.
  state.harnessDir ??= defaultHarnessDir();
  persistState(state, state.harnessDir ?? defaultHarnessDir());

  // Startup grace for the sibling-state self-guard. The adapter writes
  // tmux-slot-<N>.json / t3code/slot-<N>.json only AFTER
  // startOrchestrationProcess returns (~500ms wait), so the child runner can
  // reach its first guard check before the parent has finished bookkeeping.
  // Only the "file missing" branch gets a grace; a PID mismatch is always a
  // real conflict (the parent always writes our own pid) and exits immediately.
  const runnerStartMs = Date.now();
  const startupGraceMs = Number(process.env.LUDICS_RUNNER_STARTUP_GRACE_MS ?? "5000");

  while (state.phase !== "done") {
    // Self-guard: belt-and-braces defense against ownership-bookkeeping loss.
    // If slotClear/slotAssign already reaped our sibling state (or another code
    // path deleted it without signaling us), exit cleanly instead of continuing
    // to corrupt orchestration/slot-<N>.json on the next persistState tick.
    {
      const dir = state.harnessDir ?? defaultHarnessDir();
      const sibling = state.backend === "t3code"
        ? readSlotState(state.slot, dir)
        : readTmuxSlotState(state.slot, dir);
      if (!sibling) {
        if (Date.now() - runnerStartMs < startupGraceMs) {
          // Parent adapter hasn't written sibling state yet — re-check.
          await sleepMs(200);
          continue;
        }
        console.error(
          `ludics: runner slot ${state.slot}: sibling state missing after ${startupGraceMs}ms grace — exiting`,
        );
        return;
      }
      if (sibling.orchestration?.pid !== process.pid) {
        console.error(
          `ludics: runner slot ${state.slot}: sibling PID mismatch (expected ${process.pid}, got ${sibling.orchestration?.pid}) — exiting`,
        );
        return;
      }
    }

    await enterPhase(state, transport);
    persistState(state, state.harnessDir ?? defaultHarnessDir());

    await pollUntilDone(state, transport);

    // Escalation halt — checked before any phase-advance work so we don't
    // auto-commit, verify, or transition while the human is being flagged in.
    // handleEscalation persists state, flips slot liveness, and emits the
    // event + priority-5 notification. We return (not break) to preserve the
    // non-"done" phase so `ludics slot N resume` can pick up exactly where
    // the agent raised its hand.
    if (isEscalated(state)) {
      handleEscalation(state);
      return;
    }

    // Auto-commit any uncommitted work after agents finish their turn.
    // Push=false here; push happens before PR-related phases below.
    const participating = state.agents.filter(a => agentParticipatesInPhase(state, a));
    autoCommitAllAgents(state, participating, /* push */ false);

    // Early no-op detection: if coder's work phase produced nothing, trigger bail-out
    // so the reviewer can confirm during the upcoming review phase (satisfies AC2).
    if (state.phase === "work") {
      const coder = state.agents.find(a => a.role === "coder");
      if (coder && isWorktreeNoOp(coder.worktreePath, state.projectDir)) {
        triggerCoderBailOut(
          state, coder,
          "work-phase no-op detection",
          "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol",
        );
      }
    }

    // Capture tmux pane output for retrospective (only runs when backend === "tmux")
    if (state.backend === "tmux") {
      const { captureTmuxAgentOutputs } = await import("./tmux-capture.ts");
      captureTmuxAgentOutputs(state);
    }

    if (checkZeroCommitsAutoBailOut(state)) break;

    // --- Verification gates: confirm actual outcome before allowing transition ---
    const prCreateDecision = verifyPhaseOutcome(state, PR_CREATE_GATE);
    const finalMergeDecision = verifyPhaseOutcome(state, FINAL_MERGE_GATE);
    const gateDecision = [prCreateDecision, finalMergeDecision].find(d => d !== "skip") ?? "skip";

    if (gateDecision === "redispatch" || gateDecision === "hold") {
      persistState(state, state.harnessDir ?? defaultHarnessDir());
      await sleepMs(state.config.pollInterval * 1000);
      continue; // re-enter loop: redispatch runs enterPhase, hold waits for timeout/human
    }
    // gateDecision === "advance" or "skip" → proceed to evaluateTransition normally

    const evaluated = evaluateTransition(state);
    const next = maybeOverrideTransition(state, evaluated);

    if (!next) {
      persistState(state, state.harnessDir ?? defaultHarnessDir());
      await sleepMs(state.config.pollInterval * 1000);
      continue;
    }

    // Before phases that require committed+pushed code, ensure nothing is lost.
    // Iterate ALL agents: non-participating agents may have leftover uncommitted
    // work from a previous phase that needs to be pushed before PR creation.
    const pushBeforePhases = new Set([
      "pr-create", "final-merge",
      "merge-execute", "merge-review",
    ]);
    if (pushBeforePhases.has(next)) {
      autoCommitAllAgents(state, state.agents, /* push */ true);
    }

    // Capture previous phase context BEFORE applyPhaseSideEffects mutates
    // state.round and state.planMergeRound. Persisted on state so crash recovery
    // doesn't skip artifact validation. Consumed by enterPhase() on next iteration.
    state.previousPhaseCtx = {
      phase: state.phase,
      round: state.round,
      planMergeRound: state.planMergeRound ?? 0,
    };

    // Capture verdict and round BEFORE applyPhaseSideEffects mutates state.round.
    const preTransitionRound = state.round;
    const preTransitionVerdict = (state.phase === "review" || state.phase === "plan-review") && state.mode === "pair"
      ? pairReviewVerdict(state)
      : null;

    applyPhaseSideEffects(state, next);

    // Reset all agent statuses and lifecycles on every phase transition.
    // Stale done-statuses from the previous phase must not prevent dispatch
    // in the next phase (e.g., plan-done blocking plan-merge dispatch).
    for (const agent of state.agents) {
      const runtime = state.agentStates[agent.name];
      if (!runtime) continue;
      runtime.status = "idle";
      runtime.statusEpoch = nowEpoch();
      runtime.statusMessage = `entering ${next}`;
      runtime.turnLifecycle = null;
    }

    emitEvent({
      event_type: "phase_transition",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      action: `${state.phase} → ${next}`,
      status: next,
      message: `round ${preTransitionRound}`,
    });

    {
      const taskLabel = state.taskId;
      const slotLabel = `Slot ${state.slot} [${taskLabel}]`;
      if (state.phase === "review" && state.mode === "pair") {
        const verdictLabel = preTransitionVerdict === "approve" ? "APPROVE"
          : preTransitionVerdict === "request_changes" ? "REQUEST_CHANGES"
          : "timeout";
        notifyAgents(
          `${slotLabel}: review verdict: ${verdictLabel} → ${next} (round ${preTransitionRound})`,
          3,
          `${slotLabel}: review verdict`,
        );
      } else if (state.phase === "plan-review" && state.mode === "pair") {
        const verdictLabel = preTransitionVerdict === "approve" ? "APPROVE"
          : preTransitionVerdict === "request_changes" ? "REQUEST_CHANGES"
          : "timeout";
        notifyAgents(
          `${slotLabel}: plan-review verdict: ${verdictLabel} → ${next} (plan-merge round ${state.planMergeRound ?? 0})`,
          3,
          `${slotLabel}: plan-review verdict`,
        );
      } else {
        notifyAgents(
          `${slotLabel}: ${state.phase} → ${next} (round ${preTransitionRound})`,
          1,
          `${slotLabel}: phase`,
        );
      }
    }

    state.phase = next;
    state.phaseStartedAt = nowEpoch();
    state.confirmedPhase = null;
    state.phaseDispatched = false;
    state.currentPhaseToken = undefined;
    persistState(state, state.harnessDir ?? defaultHarnessDir());
  }

  // Orchestration complete — mark the task as done so maybeClearDoneSlots()
  // auto-clears the slot on the next keepalive tick.
  if (state.taskId) {
    let taskUpdated = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- circular-dep chain: cluster.ts imports emitEvent from events.ts
      const { clusterIsController, clusterCurrentMachineName } = require("../cluster.ts") as typeof import("../cluster.ts");
      if (clusterCurrentMachineName() && !clusterIsController()) {
        const { clusterPostTaskUpdate } = await import("../cluster-http.ts");
        await clusterPostTaskUpdate(state.taskId, "status", "done");
        await clusterPostTaskUpdate(state.taskId, "completed", isoNow());
        taskUpdated = true;
      }
    } catch { /* standalone mode */ }
    if (!taskUpdated) {
      const taskFile = taskFilePath(state.taskId, state.harnessDir ?? defaultHarnessDir());
      if (existsSync(taskFile)) {
        updateFrontmatterField(taskFile, "status", "done");
        updateFrontmatterField(taskFile, "completed", isoNow());
      }
    }
    emitEvent({
        event_type: "task_completed",
        source: "orchestration",
        scope: "task",
        slot: state.slot,
        task: state.taskId,
        status: "done",
        message: `orchestration completed for ${state.taskId}`,
      });
      notifyAgents(
        `Slot ${state.slot} [${state.taskId}]: orchestration complete`,
        3,
        `Slot ${state.slot}: task done`,
      );

      // On worker machines, report status via HTTP to controller so it discovers
      // completion immediately instead of waiting for health-check sync.
      if (clusterRole() === "worker") {
        try {
          const { clusterReportWorkerSignal } = await import("../cluster-http.ts");
          await clusterReportWorkerSignal(state.slot, state.taskId, "done",
            `orchestration completed for ${state.taskId}`);
        } catch (err) {
          console.error(`ludics: worker signal write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Collect retrospective data before threads are cleaned up
      try {
        const { collectAndWriteRetrospective } = await import("../retrospective.ts");
        await collectAndWriteRetrospective(state);
      } catch (err) {
        console.error(`ludics: retrospective collection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
  }
}

/**
 * Create the appropriate transport for a persisted orchestration state.
 * Uses the backend field from state (single source of truth).  For legacy
 * states created before the backend field existed, infer the backend from
 * state data: populated threadIds indicate t3code; otherwise fall back to
 * the current globalAdapter() setting.
 */
async function createTransport(state: OrchestrationState): Promise<OrchestrationTransport> {
  let backend = state.backend;
  if (!backend) {
    // Legacy state: t3code states have non-empty threadIds; tmux does not.
    const hasThreadIds = Object.values(state.threadIds ?? {}).some(v => !!v);
    backend = hasThreadIds ? "t3code" : globalAdapter();
  }
  if (backend === "tmux") {
    const { TmuxTransport } = await import("./transport-tmux.ts");
    return new TmuxTransport();
  }
  const { T3CodeTransport } = await import("./transport-t3code.ts");
  return new T3CodeTransport();
}

export async function runOrchestrationForSlot(slot: number, harnessDir?: string): Promise<void> {
  const state = readOrchestrationState(slot, harnessDir);
  if (!state) throw new Error(`orchestration state not found for slot ${slot}`);
  const transport = await createTransport(state);
  await runOrchestration(state, transport);
}

export function confirmPhase(slot: number, harnessDir?: string): OrchestrationState {
  const state = readOrchestrationState(slot, harnessDir);
  if (!state) throw new Error(`orchestration state not found for slot ${slot}`);
  state.confirmedPhase = state.phase;
  persistState(state, harnessDir);
  return state;
}

export async function interruptCurrentPhase(slot: number, harnessDir?: string): Promise<OrchestrationState> {
  const state = readOrchestrationState(slot, harnessDir);
  if (!state) throw new Error(`orchestration state not found for slot ${slot}`);
  const transport = await createTransport(state);
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    await interruptAgent(state, agent, transport);
  }
  persistState(state, harnessDir);
  return state;
}

export function skipToPhase(
  slot: number,
  phase: OrchestrationState["phase"],
  harnessDir?: string,
): OrchestrationState {
  const state = readOrchestrationState(slot, harnessDir);
  if (!state) throw new Error(`orchestration state not found for slot ${slot}`);
  state.phase = phase;
  state.phaseStartedAt = nowEpoch();
  state.phaseDispatched = false;

  // Reset all agent statuses and lifecycles — same invariants as enterPhase().
  for (const agent of state.agents) {
    const runtime = state.agentStates[agent.name];
    if (!runtime) continue;
    runtime.status = "idle";
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = `skip to ${phase}`;
    runtime.turnLifecycle = null;
    runtime.dispatchStatusFingerprint = undefined;
  }

  persistState(state, harnessDir);
  return state;
}
