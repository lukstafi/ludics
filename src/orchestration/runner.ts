import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { emitEvent } from "../events.ts";
import { T3CodeClient } from "../t3code/client.ts";
import { readServerRecord } from "../t3code/server.ts";
import { toWireProvider } from "../t3code/types.ts";
import type { T3CodeServerRecord, T3Snapshot } from "../t3code/types.ts";
import { DONE_STATUSES, allAgentsDone, agentParticipatesInPhase, evaluateTransition, isAgentDone } from "./phases.ts";
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
import { fetchNewPrCommentCount, isPrMerged, validateAndFixPrFile } from "./github.ts";
import { updateFrontmatterField } from "../tasks/markdown.ts";
import { harnessDir } from "../config.ts";

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

function refreshAgentStatuses(state: OrchestrationState, snapshot: T3Snapshot | null): void {
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

    // Keep deprecated fields populated for any code that still reads them.
    runtime.latestTurnCompletedAt = latestTurn?.completedAt ?? null;
    if (sessionStatus === "running" && activeTurnId) {
      runtime.latestTurnState = "running";
    } else {
      runtime.latestTurnState = latestTurn?.state ?? "missing";
    }

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
function updateTurnLifecycle(
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
      } else if (
        // Agent completed so fast we missed the running state entirely:
        // latestTurn shows a NEW completed turn (different from any we saw before dispatch).
        latestTurn
        && latestTurn.state === "completed"
        && latestTurn.completedAt
        && !activeTurnId
        && lc.observedTurnId === null
        // Heuristic: the completed turn must be newer than our dispatch.
        && Date.parse(latestTurn.completedAt) >= Date.parse(lc.dispatchedAt)
      ) {
        lc.observedTurnId = latestTurn.turnId;
        lc.state = "settled";
        lc.turnCompletedAt = latestTurn.completedAt;
        lc.completionSource = "snapshot";
      }
      break;
    }
    case "running": {
      // Turn is active — check if it settled.
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
    // Don't overwrite if agent already has a meaningful status for this phase
    if (runtime.status.endsWith("-done") || runtime.status === "done" || runtime.status === "merged") {
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
 * Translate a provider-agnostic effort level to the correct wire protocol fields.
 * - For claudeAgent: sends `effort` field (supports low/medium/high/max)
 * - For codex: sends `reasoningEffort` field (supports low/medium/high; max → high)
 * - Legacy numeric values (e.g. 32768) are mapped to named levels before dispatch.
 */
function effortFields(
  effort: string | undefined,
  wireProvider: ReturnType<typeof toWireProvider>,
): { effort?: string } | { reasoningEffort?: string } | Record<string, never> {
  if (!effort) return {};
  const level = normaliseEffortLevel(effort);
  if (wireProvider === "claudeAgent") {
    return { effort: level };
  }
  // Codex: max is not supported, map to high
  const codexLevel = level === "max" ? "high" : level;
  return { reasoningEffort: codexLevel };
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

  const wireProvider = toWireProvider(agent.provider);
  const providerEffort = effortFields(agent.thinkingEffort, wireProvider);
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
      provider: wireProvider,
      model: agent.model,
      ...providerEffort,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: isoNow(),
    });
  });

  return commandId;
}

async function enterPhase(state: OrchestrationState): Promise<void> {
  if (state.phaseDispatched) return;
  writePeerSync(state);
  markActiveAgents(state);
  state.phaseDispatched = true;
  // Reset pr-comments tracking state on phase entry.
  if (state.phase === "pr-comments") {
    state.prCommentsLastCheckAt = undefined;
    state.prCommentsQuietSince = undefined;
  }
  if (state.phase === "setup") return;

  // Record dispatch timestamp (kept for backward compat; lifecycle is authoritative).
  state.phaseDispatchedAt = isoNow();

  // Read the phase token written by writePeerSync above — used to scope stop hooks.
  const phaseToken = readPhaseToken(state.peerSyncDir) ?? makeId("phase");

  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
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
  }

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
    }
  }

  // Only re-dispatch once all participating agents have finished their current turn.
  // Do NOT advance prCommentsLastCheckAt here — we have not polled GitHub yet, so
  // advancing the checkpoint would cause comments that arrive while agents are active
  // to fall outside the next poll's "since" window and be silently skipped.
  const participants = state.agents.filter((a) => agentParticipatesInPhase(state, a));
  const allDone = participants.every((a) => isAgentDone(state, a));
  if (!allDone) return;

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
 */
function validateAgentPrFiles(state: OrchestrationState): void {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    if (!isAgentDone(state, agent)) continue;
    const prFile = join(state.peerSyncDir, `${agent.name}.pr`);
    const fixedUrl = validateAndFixPrFile(prFile, agent.worktreePath, agent.branch);
    if (fixedUrl && !state.agentStates[agent.name]!.prUrl) {
      state.agentStates[agent.name]!.prUrl = fixedUrl;
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
  if (state.phase === "clarify" || state.phase === "pushback" || state.phase === "plan") {
    return;
  }
  if (
    state.phase === "work"
    || state.phase === "review"
    || state.phase === "pr-comments"
    || state.phase === "final-merge"
  ) {
    for (const agent of state.agents) {
      if (!agentParticipatesInPhase(state, agent)) continue;
      const runtime = state.agentStates[agent.name]!;
      if (runtime.interrupted || runtime.status === "done" || runtime.status === "review-done") continue;
      await interruptAgent(state, agent);
    }
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
      unsubscribe = eventClient.onDomainEvent(() => {
        // Any domain event (turn started/completed, session set) wakes the poll loop.
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
  if (state.phase === "update-docs" && next === "pr-comments") {
    state.lastLearningAt = nowEpoch();
    state.lastLearningRound = state.round;
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
    const evaluated = evaluateTransition(state);
    const next = maybeOverrideTransition(state, evaluated);

    if (!next) {
      await sleep(state.config.pollInterval * 1000);
      continue;
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

    state.phase = next;
    state.phaseStartedAt = nowEpoch();
    state.confirmedPhase = null;
    state.phaseDispatched = false;
    state.phaseDispatchedAt = null;
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
  state.phaseDispatchedAt = null;
  persistState(state, harnessDir);
  return state;
}
