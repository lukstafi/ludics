import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { emitEvent } from "../events.ts";
import { T3CodeClient } from "../t3code/client.ts";
import { readServerRecord } from "../t3code/server.ts";
import { toWireProvider } from "../t3code/types.ts";
import type { T3CodeServerRecord, T3Snapshot } from "../t3code/types.ts";
import { DONE_STATUSES, allAgentsDone, agentParticipatesInPhase, evaluateTransition, isAgentDone, pairReviewVerdict } from "./phases.ts";
import {
  clearInterrupt, readAgentStatus, readMarker, readPhaseToken, readPrUrl,
  readStopHookRecord, statusFileFingerprint, writeInterrupt, writePeerSync,
} from "./peer-sync.ts";
import { determineWinner, hasConsensus, readMergeVotes } from "./merge.ts";
import { shouldRunUpdateDocs } from "./learning.ts";
import { composeSkillMessage } from "./skills.ts";
import {
  persistState, readOrchestrationState,
  type AgentConfig, type AgentTurnLifecycle, type OrchestrationState,
} from "./state.ts";
import { isoNow, makeId, nowEpoch, sleep } from "./util.ts";
import { fetchNewPrCommentCount, hasPrApprovalReaction, isPrMerged, postCodexReviewComment, validateAndFixPrFile } from "./github.ts";
import { updateFrontmatterField } from "../tasks/markdown.ts";
import { findProjectConfig, harnessDir } from "../config.ts";
import { notifyAgents } from "../notify.ts";
import { autoCommitWorktree, pushBranch } from "./worktrees.ts";

async function withClient<T>(
  record: T3CodeServerRecord,
  fn: (client: T3CodeClient) => Promise<T>,
): Promise<T> {
  const client = new T3CodeClient({
    url: record.wsUrl,
    token: record.authToken,
  });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function phaseActiveStatus(phase: OrchestrationState["phase"]): string {
  return `${phase}-active`;
}

function threadSnapshot(snapshot: T3Snapshot | null, threadId: string) {
  return snapshot?.threads.find((thread) => thread.id === threadId) ?? null;
}

async function fetchSnapshot(record: T3CodeServerRecord | null): Promise<T3Snapshot | null> {
  if (!record) return null;
  try {
    return await withClient(record, (client) => client.getSnapshot());
  } catch {
    return null;
  }
}

export function refreshAgentStatuses(state: OrchestrationState, snapshot: T3Snapshot | null): void {
  for (const agent of state.agents) {
    // --- 1. Read peer-sync status ---
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

    // --- 2. Read snapshot thread state ---
    const thread = threadSnapshot(snapshot, state.threadIds[agent.name]);
    const sessionStatus = thread?.session?.status;
    const activeTurnId = thread?.session?.activeTurnId ?? null;
    const latestTurn = thread?.latestTurn ?? null;

    // --- 3. Update turn lifecycle (identity-based tracking) ---
    const lc = runtime.turnLifecycle;
    if (lc) {
      updateTurnLifecycle(lc, sessionStatus ?? null, activeTurnId, latestTurn);

      // --- 3b. Check stop-hook records ---
      const stopRecord = readStopHookRecord(state.peerSyncDir, agent.name);
      if (stopRecord && stopRecord.phaseToken === lc.phaseToken) {
        lc.lastStopHookAt = stopRecord.observedAt;
        // Stop hook arrived for this phase — if lifecycle still shows dispatched
        // and snapshot doesn't yet show running, the turn likely completed very fast.
        if (lc.state === "dispatched" && latestTurn?.state === "completed" && !activeTurnId) {
          lc.observedTurnId = latestTurn.turnId;
          lc.state = "settled";
          lc.turnCompletedAt = latestTurn.completedAt ?? isoNow();
          lc.completionSource = "stop-hook";
        }
      }
    }

    // --- 4. Detect inconsistencies ---
    detectAgentInconsistencies(state, agent, runtime);
  }
}

/**
 * Advance the per-agent turn lifecycle state machine based on snapshot data.
 * See docs/orchestration-phase-transitions.md §6 for the state diagram.
 */
export function updateTurnLifecycle(
  lc: AgentTurnLifecycle,
  sessionStatus: string | null,
  activeTurnId: string | null,
  latestTurn: { turnId: string; state: string; completedAt?: string | null; startedAt?: string | null } | null,
): void {
  switch (lc.state) {
    case "dispatched": {
      // Waiting for the provider to start the turn.
      if (sessionStatus === "running" && activeTurnId) {
        // Turn started — bind to the observed turn ID.
        lc.observedTurnId = activeTurnId;
        lc.state = "running";
        lc.turnStartedAt = isoNow();
      }
      // NOTE: No snapshot-only fast-complete path. Without a turnId returned
      // from dispatch, we cannot prove a completed turn in the snapshot belongs
      // to *this* dispatch rather than a prior turn.  Fast completion is handled
      // by the stop-hook path (which provides phaseToken proof) in
      // refreshAgentStatuses().  If no stop-hook arrives and activeTurnId is
      // never observed, the lifecycle stays "dispatched" until timeout.
      break;
    }
    case "running": {
      // Turn is active — check if it settled.
      // Guard: if sessionStatus is null (snapshot fetch failed), do NOT transition.
      // A transient RPC failure must not permanently misclassify an active turn as settled.
      if (sessionStatus === null) break;
      if (!activeTurnId || sessionStatus !== "running") {
        if (sessionStatus === "error") {
          lc.state = "error";
          lc.turnCompletedAt = latestTurn?.completedAt ?? isoNow();
          lc.completionSource = "snapshot";
        } else {
          lc.state = "settled";
          lc.turnCompletedAt = latestTurn?.completedAt ?? isoNow();
          lc.completionSource = "snapshot";
        }
      }
      break;
    }
    // settled and error are terminal states for the lifecycle — no further transitions.
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
      task: state.feature,
      message: `${agent.name}: peer-sync says "${runtime.status}" but turn lifecycle is "${lc.state}"`,
    });
  }
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

/**
 * Normalise a raw effort value to a named level string.
 * Legacy numeric token-budget values (e.g. 32768 from old coder_thinking_effort configs)
 * are mapped to the closest named level so they remain valid on the wire.
 */
function normaliseEffortLevel(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // Already a named level — return as-is.
  if (lower === "low" || lower === "medium" || lower === "high" || lower === "max") return lower;
  // Legacy numeric token budget — map to the closest named level.
  const n = parseInt(raw, 10);
  if (!isNaN(n)) {
    if (n <= 1024) return "low";
    if (n <= 8192) return "medium";
    return "high";
  }
  // Unrecognised value — fall back to high.
  return "high";
}

/**
 * Build modelSelection options with effort/reasoning settings.
 * - For claudeAgent: sets `options.effort` (supports low/medium/high/max)
 * - For codex: sets `options.reasoningEffort` (supports low/medium/high; max -> high)
 * - Legacy numeric values (e.g. 32768) are mapped to named levels before dispatch.
 */
function buildModelSelection(
  agent: AgentConfig,
): { provider: "codex" | "claudeAgent"; model: string; options?: Record<string, unknown> } {
  const wireProvider = toWireProvider(agent.provider);
  const effort = agent.thinkingEffort;
  if (!effort) return { provider: wireProvider, model: agent.model };

  const level = normaliseEffortLevel(effort);
  if (wireProvider === "claudeAgent") {
    return { provider: wireProvider, model: agent.model, options: { effort: level } };
  }
  // Codex: max is not supported, map to high
  const codexLevel = level === "max" ? "high" : level;
  return { provider: wireProvider, model: agent.model, options: { reasoningEffort: codexLevel } };
}

/** Dispatch a turn message and return the commandId used for correlation. */
async function sendTurnMessage(
  state: OrchestrationState,
  agent: AgentConfig,
  message: string,
): Promise<string> {
  const threadId = state.threadIds[agent.name];
  const record = readServerRecord();
  if (!record || !threadId) throw new Error(`no t3code thread for agent ${agent.name}`);

  const modelSelection = buildModelSelection(agent);
  const commandId = makeId("cmd");

  await withClient(record, async (client) => {
    await client.dispatchCommand({
      type: "thread.turn.start",
      commandId,
      threadId,
      message: {
        messageId: makeId("msg"),
        role: "user",
        text: message,
        attachments: [],
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: isoNow(),
    });
  });

  return commandId;
}

async function enterPhase(state: OrchestrationState): Promise<void> {
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
  markActiveAgents(state);

  // Reset pr-comments tracking state on phase entry.
  // Don't dispatch agents yet — wait for actual comments/reviews to arrive.
  // checkAndRedispatchPrComments will handle the first dispatch when needed.
  // Look back 10 minutes to catch comments posted during preceding phases
  // (e.g., Codex review posted during update-docs or pr-create).
  if (state.phase === "pr-comments") {
    state.prCommentsLastCheckAt = state.phaseStartedAt - 600;
    state.prCommentsQuietSince = undefined;
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
      const agentStatus = state.agentStates[agent.name]!.status;
      const currentPhaseDone = `${state.phase}-done`;
      if (agentStatus === currentPhaseDone || agentStatus === "done" || agentStatus === "merged") {
        continue;
      }
    }

    const skillMessage = await composeSkillMessage(state, agent);
    const commandId = await sendTurnMessage(state, agent, skillMessage);

    // Initialize per-agent turn lifecycle for this phase.
    const runtime = state.agentStates[agent.name]!;
    runtime.turnLifecycle = {
      dispatchCommandId: commandId,
      dispatchedAt: isoNow(),
      phaseToken,
      observedTurnId: null,
      state: "dispatched",
      turnStartedAt: null,
      turnCompletedAt: null,
      completionSource: null,
      statusFileFingerprint: statusFileFingerprint(state.peerSyncDir, agent.name),
      lastStopHookAt: null,
    };

    // Persist after each agent dispatch — crash recovery will have lifecycle data
    persistState(state);
  }

  state.phaseDispatched = true;
  state.currentPhaseToken = undefined;
  // No wait-for-running loop needed.  The lifecycle model tracks "dispatched"
  // as a distinct state — pollUntilDone won't consider the agent done until the
  // lifecycle advances to "settled" or "error".
}

/** Send a fresh turn message to each participating agent without changing phaseDispatched. */
async function redispatchForPrComments(state: OrchestrationState): Promise<void> {
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
    const skillMessage = await composeSkillMessage(state, agent);
    const commandId = await sendTurnMessage(state, agent, skillMessage);
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
      statusFileFingerprint: statusFileFingerprint(state.peerSyncDir, agent.name),
      lastStopHookAt: null,
    };
  }
}

/**
 * Poll GitHub for new PR comments during the pr-comments phase.
 * Re-dispatches agents when new comments are found; updates prCommentsQuietSince otherwise.
 */
async function checkAndRedispatchPrComments(state: OrchestrationState): Promise<void> {
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
      const isStaging = !!state.stagingRepo && state.mode === "pair";
      const forwarded = state.agents.some((a) =>
        existsSync(join(state.peerSyncDir, `${a.name}.forwarded`))
      );

      if (isStaging && forwarded) {
        // Upstream PR merged — write upstream-merged marker (NOT .merged)
        const upstreamMarkerFile = join(state.peerSyncDir, `${agent.name}.upstream-merged`);
        if (!existsSync(upstreamMarkerFile)) {
          writeFileSync(upstreamMarkerFile, "upstream-merged\n");
          emitEvent({
            event_type: "upstream_pr_merged",
            source: "orchestration",
            scope: "slot",
            slot: state.slot,
            task: state.feature,
            message: `Upstream PR merged: ${prUrl}`,
          });
          const mergedTaskLabel = state.taskId ?? state.feature;
          notifyAgents(
            `Slot ${state.slot} [${mergedTaskLabel}]: upstream PR merged: ${prUrl}`,
            3,
            `Slot ${state.slot}: upstream PR merged`,
          );
        }
      } else if (isStaging && !forwarded) {
        // Staging PR merged before forwarding — do NOT write .merged marker.
        // Writing .merged would cause isMerged() → suggest-refactor, skipping the
        // entire staging→upstream forwarding flow. The workflow should still proceed
        // to forward-pr to create the upstream PR. Emit a warning.
        emitEvent({
          event_type: "orchestration_warning",
          source: "orchestration",
          scope: "slot",
          slot: state.slot,
          task: state.feature,
          message: `Staging PR merged before forwarding: ${prUrl} — will still forward to upstream`,
        });
      } else {
        // Non-staging: existing behavior
        writeFileSync(markerFile, "merged\n");
        state.agentStates[agent.name]!.status = "merged";
        state.agentStates[agent.name]!.statusMessage = "PR merged externally";
        emitEvent({
          event_type: "pr_merged",
          source: "orchestration",
          scope: "slot",
          slot: state.slot,
          task: state.feature,
          message: `PR merged: ${prUrl}`,
        });
        const mergedTaskLabel = state.taskId ?? state.feature;
        notifyAgents(
          `Slot ${state.slot} [${mergedTaskLabel}]: PR merged: ${prUrl}`,
          3,
          `Slot ${state.slot}: PR merged`,
        );
      }
    }
  }

  // Only re-dispatch once all participating agents have finished their current turn.
  // Do NOT advance prCommentsLastCheckAt here — we have not polled GitHub yet, so
  // advancing the checkpoint would cause comments that arrive while agents are active
  // to fall outside the next poll's "since" window and be silently skipped.
  const participants = state.agents.filter((a) => agentParticipatesInPhase(state, a));
  const allDone = participants.every((a) => isAgentDone(state, a));
  if (!allDone) return;

  // Check for Codex thumbs-up approval reaction — triggers immediate transition to final-merge.
  if (!state.prCodexApproved) {
    for (const agent of agentsWithPr) {
      const prUrl = state.agentStates[agent.name]!.prUrl!;
      if (hasPrApprovalReaction(prUrl)) {
        state.prCodexApproved = true;
        emitEvent({
          event_type: "pr_codex_approved",
          source: "orchestration",
          scope: "slot",
          slot: state.slot,
          task: state.feature,
          message: `Codex +1 approval reaction detected on PR: ${prUrl} — bypassing quiet period`,
        });
        break;
      }
    }
  }

  // Count new comments since the last check.
  let totalNewComments = 0;
  for (const agent of agentsWithPr) {
    totalNewComments += fetchNewPrCommentCount(state.agentStates[agent.name]!.prUrl!, lastCheck);
  }

  state.prCommentsLastCheckAt = now;

  if (totalNewComments > 0) {
    state.prCommentsQuietSince = 0; // Reset quiet period.
    await redispatchForPrComments(state);
  } else if (!state.prCommentsQuietSince) {
    state.prCommentsQuietSince = now;
  }
}

/**
 * After agents complete a phase that creates PRs, validate the pr files.
 * If a file contains markdown text instead of a URL, auto-create the PR and rewrite the file.
 *
 * NOTE: We gate on the turn lifecycle being settled (or a done status present)
 * rather than isAgentDone(), because isAgentDone() itself requires a valid PR URL
 * artifact — creating a deadlock when the agent writes markdown that
 * validateAndFixPrFile() is designed to repair.
 */
function validateAgentPrFiles(state: OrchestrationState): void {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name];
    if (!runtime) continue;
    // Allow fix to run once the turn has settled or agent reported done,
    // even if artifact validation hasn't passed yet.
    const lc = runtime.turnLifecycle;
    const turnSettled = lc && (lc.state === "settled" || lc.state === "error");
    const statusDone = DONE_STATUSES.has(runtime.status);
    if (!turnSettled && !statusDone && !runtime.interrupted) continue;
    const prFile = join(state.peerSyncDir, `${agent.name}.pr`);
    const fixedUrl = validateAndFixPrFile(prFile, agent.worktreePath, agent.branch);
    if (fixedUrl && !runtime.prUrl) {
      runtime.prUrl = fixedUrl;
      const prTaskLabel = state.taskId ?? state.feature;
      notifyAgents(
        `Slot ${state.slot} [${prTaskLabel}]: PR created by ${agent.name}: ${fixedUrl}`,
        3,
        `Slot ${state.slot}: PR created`,
      );
    }
  }
}

export async function interruptAgent(
  state: OrchestrationState,
  agent: AgentConfig,
): Promise<void> {
  writeInterrupt(state.peerSyncDir, agent.name);
  const threadId = state.threadIds[agent.name];
  const record = readServerRecord();
  if (record && threadId) {
    await withClient(record, async (client) => {
      try {
        await client.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: makeId("cmd"),
          threadId,
          createdAt: isoNow(),
        });
      } catch {
        // ignore
      }
    });
  }
  state.agentStates[agent.name]!.interrupted = true;
  state.agentStates[agent.name]!.status = "interrupted";
  state.agentStates[agent.name]!.statusEpoch = nowEpoch();
}

async function handleTimeout(state: OrchestrationState): Promise<void> {
  if (
    state.phase === "clarify"
    || state.phase === "pushback"
    || state.phase === "plan"
    || state.phase === "plan-merge"
    || state.phase === "plan-review"
  ) {
    return;
  }

  // Note: for forwarded pr-comments (upstream monitoring), timeout interrupts are NOT
  // suppressed. If redispatchForPrComments dispatched a turn that hangs, it should be
  // interrupted normally. The interrupted state is cleared by redispatchForPrComments
  // when new comments trigger a fresh dispatch, preventing the latch from blocking
  // subsequent turns.

  if (
    state.phase === "work"
    || state.phase === "review"
    || state.phase === "pr-comments"
    || state.phase === "final-merge"
    || state.phase === "forward-pr"
  ) {
    for (const agent of state.agents) {
      if (!agentParticipatesInPhase(state, agent)) continue;
      const runtime = state.agentStates[agent.name]!;
      if (runtime.interrupted || runtime.status === "done" || runtime.status === "review-done") continue;
      await interruptAgent(state, agent);
    }
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

  // Build commit message: "<agent> <phase>: <status message or WIP>"
  const statusMsg = runtime.statusMessage?.replace(/\s+/g, " ").trim() || "WIP";
  const commitMessage = `${agent.name} ${state.phase}: ${statusMsg}`;

  const result = autoCommitWorktree(agent.worktreePath, commitMessage);

  if (result.committed) {
    emitEvent({
      event_type: "auto_commit",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.feature,
      message: `auto-committed ${result.commitSha ?? ""} in ${agent.worktreePath}: ${commitMessage}`,
    });
  } else if (result.error) {
    emitEvent({
      event_type: "orchestration_warning",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.feature,
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
        task: state.feature,
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

async function pollUntilDone(state: OrchestrationState): Promise<void> {
  const timeout = state.config.timeouts[state.phase] ?? 600;
  const deadline = state.phaseStartedAt + timeout;
  const interval = state.config.pollInterval * 1000;
  const record = readServerRecord();

  // Subscribe to domain events for early wakeup (falls back to pure polling).
  let wakeResolve: (() => void) | null = null;
  let eventClient: T3CodeClient | null = null;
  let unsubscribe: (() => void) | null = null;

  if (record) {
    try {
      eventClient = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
      await eventClient.connect();
      unsubscribe = eventClient.onDomainEvent((event) => {
        // Only wake for turn/session lifecycle events — ignore unrelated domain events
        // (e.g. message-sent, activity) to reduce unnecessary poll cycles.
        // See docs/orchestration-phase-transitions.md §4 for the documented event model.
        if (event.type !== "thread.session.set" && event.type !== "thread.turn-diff-completed") return;
        if (wakeResolve) {
          wakeResolve();
          wakeResolve = null;
        }
      });
    } catch {
      // Event subscription failed — pure polling fallback.
      eventClient?.close();
      eventClient = null;
    }
  }

  try {
    while (true) {
      const snapshot = await fetchSnapshot(record);
      refreshAgentStatuses(state, snapshot);

      // Validate pr files when coder finishes pr-create (auto-create PR from markdown if needed).
      if (state.phase === "pr-create") {
        validateAgentPrFiles(state);
      }

      // For pr-comments: poll GitHub and re-dispatch before the allAgentsDone short-circuit,
      // so the quiet-period tracking and re-dispatch logic run on the tick when agents finish.
      if (state.phase === "pr-comments") {
        await checkAndRedispatchPrComments(state);
        persistState(state);
        // Return to the main loop so evaluateTransition can check quiet-period expiry.
        if (evaluateTransition(state) !== null) return;
      }

      persistState(state);

      if (allAgentsDone(state)) return;

      if (nowEpoch() >= deadline) {
        await handleTimeout(state);
        return;
      }

      // Sleep with early wakeup from domain events.
      await Promise.race([
        sleep(interval),
        new Promise<void>((resolve) => { wakeResolve = resolve; }),
      ]);
      wakeResolve = null;
    }
  } finally {
    unsubscribe?.();
    eventClient?.close();
  }
}

function applyPhaseSideEffects(state: OrchestrationState, next: OrchestrationState["phase"]): void {
  if (state.phase === "review" && next === "update-docs" && !shouldRunUpdateDocs(state)) {
    state.lastLearningAt = state.lastLearningAt ?? 0;
  }
  if ((state.phase === "update-docs" || state.phase === "review") && next === "work") {
    state.round += 1;
  }
  // Track plan-merge iterations: increment planMergeRound each time we loop back.
  if (state.phase === "plan-review" && next === "plan-merge") {
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
  // Reset pr-comments approval state when re-entering after forward-pr,
  // so Codex +1 from the staging PR doesn't auto-transition the upstream monitoring.
  if (state.phase === "forward-pr" && next === "pr-comments") {
    state.prCodexApproved = false;
  }
  if (state.phase === "update-docs" && next === "pr-comments") {
    state.lastLearningAt = nowEpoch();
    state.lastLearningRound = state.round;
  }
  maybePostCodexReviewRequests(state, state.phase, next);
}

/**
 * Post @codex review on each unique PR when first entering pr-comments
 * after PR creation.  Only fires on the initial pr-comments entry paths
 * (pr-create, update-docs, review), NOT on merge-loop re-entries
 * (merge-review -> pr-comments).
 */
export function maybePostCodexReviewRequests(
  state: OrchestrationState,
  from: OrchestrationState["phase"],
  next: OrchestrationState["phase"],
): void {
  // Only on initial entry to pr-comments (not merge-loop re-entries).
  const initialPrCommentsPaths: OrchestrationState["phase"][] = ["pr-create", "update-docs", "review"];
  if (next !== "pr-comments" || !initialPrCommentsPaths.includes(from)) return;

  // Only when the reviewer agent is Codex — matches the acceptance criterion
  // "when reviewer is Codex".  Avoids noise in non-Codex setups and in setups
  // where only the coder is Codex.
  const hasCodexReviewer = state.agents.some(
    (a) => a.role === "reviewer" && a.provider === "codex",
  );
  if (!hasCodexReviewer) return;

  const projectEntry = findProjectConfig(state.projectDir);
  const customPrompt = projectEntry?.codex_review_prompt ?? undefined;

  // De-duplicate PR URLs (pair mode: both agents may point to same PR after merge).
  const seen = new Set<string>();
  for (const agent of state.agents) {
    const prUrl = state.agentStates[agent.name]?.prUrl;
    if (prUrl && !seen.has(prUrl)) {
      seen.add(prUrl);
      postCodexReviewComment(prUrl, customPrompt);
    }
  }
}

function maybeOverrideTransition(state: OrchestrationState, next: OrchestrationState["phase"] | null) {
  if (state.phase === "review" && next === "update-docs" && !shouldRunUpdateDocs(state)) {
    return state.agents.some((agent) => !!state.agentStates[agent.name]?.prUrl)
      ? "pr-comments"
      : "work";
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

export async function runOrchestration(
  state: OrchestrationState,
): Promise<void> {
  persistState(state);

  while (state.phase !== "done") {
    await enterPhase(state);
    persistState(state);

    await pollUntilDone(state);

    // Auto-commit any uncommitted work after agents finish their turn.
    // Push=false here; push happens before PR-related phases below.
    const participating = state.agents.filter(a => agentParticipatesInPhase(state, a));
    autoCommitAllAgents(state, participating, /* push */ false);

    const evaluated = evaluateTransition(state);
    const next = maybeOverrideTransition(state, evaluated);

    if (!next) {
      await sleep(state.config.pollInterval * 1000);
      continue;
    }

    // Before phases that require committed+pushed code, ensure nothing is lost.
    // Iterate ALL agents: non-participating agents may have leftover uncommitted
    // work from a previous phase that needs to be pushed before PR creation.
    const pushBeforePhases = new Set([
      "pr-create", "forward-pr", "final-merge",
      "merge-execute", "merge-review",
    ]);
    if (pushBeforePhases.has(next)) {
      autoCommitAllAgents(state, state.agents, /* push */ true);
    }

    applyPhaseSideEffects(state, next);

    emitEvent({
      event_type: "phase_transition",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.feature,
      action: `${state.phase} → ${next}`,
      status: next,
      message: `round ${state.round}`,
    });

    {
      const taskLabel = state.taskId ?? state.feature;
      const slotLabel = `Slot ${state.slot} [${taskLabel}]`;
      if (state.phase === "review" && state.mode === "pair") {
        // Use the parsed verdict from the review file. Falls back to "timeout" when
        // no verdict file exists (review phase expired without an explicit verdict).
        const parsed = pairReviewVerdict(state);
        const verdictLabel = parsed === "approve" ? "APPROVE"
          : parsed === "request_changes" ? "REQUEST_CHANGES"
          : "timeout";
        notifyAgents(
          `${slotLabel}: review verdict: ${verdictLabel} → ${next} (round ${state.round})`,
          3,
          `${slotLabel}: review verdict`,
        );
      } else if (state.phase === "plan-review" && state.mode === "pair") {
        const parsed = pairReviewVerdict(state);
        const verdictLabel = parsed === "approve" ? "APPROVE"
          : parsed === "request_changes" ? "REQUEST_CHANGES"
          : "timeout";
        notifyAgents(
          `${slotLabel}: plan-review verdict: ${verdictLabel} → ${next} (plan-merge round ${state.planMergeRound ?? 0})`,
          3,
          `${slotLabel}: plan-review verdict`,
        );
      } else {
        notifyAgents(
          `${slotLabel}: ${state.phase} → ${next} (round ${state.round})`,
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
    persistState(state);
  }

  // Orchestration complete — mark the task as done so maybeClearDoneSlots()
  // auto-clears the slot on the next keepalive tick.
  if (state.taskId) {
    const taskFile = join(harnessDir(), "tasks", `${state.taskId}.md`);
    if (existsSync(taskFile)) {
      updateFrontmatterField(taskFile, "status", "done");
      updateFrontmatterField(taskFile, "completed", isoNow());
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

      // Collect retrospective data before threads are cleaned up
      try {
        const { collectAndWriteRetrospective } = await import("../retrospective.ts");
        await collectAndWriteRetrospective(state);
      } catch (err) {
        console.error(`ludics: retrospective collection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export async function runOrchestrationForSlot(slot: number, harnessDir?: string): Promise<void> {
  const state = readOrchestrationState(slot, harnessDir);
  if (!state) throw new Error(`orchestration state not found for slot ${slot}`);
  await runOrchestration(state);
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
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    await interruptAgent(state, agent);
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
  persistState(state, harnessDir);
  return state;
}
