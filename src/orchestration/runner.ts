import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { emitEvent } from "../events.ts";
import { T3CodeClient } from "../t3code/client.ts";
import { readServerRecord } from "../t3code/server.ts";
import { toWireProvider } from "../t3code/types.ts";
import type { T3CodeServerRecord, T3Snapshot } from "../t3code/types.ts";
import { allAgentsDone, agentParticipatesInPhase, evaluateTransition, isAgentDone } from "./phases.ts";
import { clearInterrupt, readAgentStatus, readMarker, readPrUrl, writeInterrupt, writePeerSync } from "./peer-sync.ts";
import { determineWinner, hasConsensus, readMergeVotes } from "./merge.ts";
import { shouldRunUpdateDocs } from "./learning.ts";
import { composeSkillMessage } from "./skills.ts";
import { persistState, readOrchestrationState, type AgentConfig, type OrchestrationState } from "./state.ts";
import { isoNow, isTurnFresh, makeId, nowEpoch, sleep } from "./util.ts";
import { fetchNewPrCommentCount, validateAndFixPrFile } from "./github.ts";

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
    const status = readAgentStatus(state.peerSyncDir, agent.name);
    const runtime = state.agentStates[agent.name]!;
    runtime.status = status.status;
    runtime.statusEpoch = status.epoch;
    runtime.statusMessage = status.message;
    runtime.prUrl = readPrUrl(state.peerSyncDir, agent.name) ?? runtime.prUrl;

    if (readMarker(state.peerSyncDir, `${agent.name}.merged`) !== null) {
      runtime.status = "merged";
      runtime.statusMessage = "merged";
    }

    const thread = threadSnapshot(snapshot, state.threadIds[agent.name]);
    runtime.latestTurnState = thread?.latestTurn?.state ?? "missing";
    runtime.latestTurnCompletedAt = thread?.latestTurn?.completedAt ?? null;

    // Only treat the turn as a fresh completion if its completedAt is at or
    // after the timestamp when this phase's turns were dispatched.  This
    // prevents a stale "completed" state from the previous phase from
    // triggering a premature phase transition.
    const isFreshCompletion = isTurnFresh(state.phaseDispatchedAt, runtime.latestTurnCompletedAt);

    if (
      (runtime.status === "unknown" || runtime.status === "idle")
      && runtime.latestTurnState === "completed"
      && isFreshCompletion
    ) {
      runtime.status = "turn-complete";
      runtime.statusEpoch = nowEpoch();
      runtime.statusMessage = "thread completed without explicit status file";
    }
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

async function sendTurnMessage(
  state: OrchestrationState,
  agent: AgentConfig,
  message: string,
): Promise<void> {
  const threadId = state.threadIds[agent.name];
  const record = readServerRecord();
  if (!record || !threadId) throw new Error(`no t3code thread for agent ${agent.name}`);

  await withClient(record, async (client) => {
    await client.dispatchCommand({
      type: "thread.turn.start",
      commandId: makeId("cmd"),
      threadId,
      message: {
        messageId: makeId("msg"),
        role: "user",
        text: message,
        attachments: [],
      },
      provider: toWireProvider(agent.provider),
      model: agent.model,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: isoNow(),
    });
  });
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

  // Record the dispatch timestamp before sending turns so that any stale
  // completedAt from a prior phase is recognized as such during polling.
  state.phaseDispatchedAt = isoNow();

  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const skillMessage = await composeSkillMessage(state, agent);
    await sendTurnMessage(state, agent, skillMessage);
  }
}

/** Send a fresh turn message to each participating agent without changing phaseDispatched. */
async function redispatchForPrComments(state: OrchestrationState): Promise<void> {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const runtime = state.agentStates[agent.name]!;
    runtime.status = "pr-comments-active";
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = "re-dispatched for new PR comments";
    const skillMessage = await composeSkillMessage(state, agent);
    await sendTurnMessage(state, agent, skillMessage);
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
    await sleep(interval);
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
