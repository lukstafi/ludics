import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { emitEvent } from "../events.ts";
import { T3CodeClient } from "../t3code/client.ts";
import { readServerRecord } from "../t3code/server.ts";
import { toWireProvider } from "../t3code/types.ts";
import type { T3CodeServerRecord, T3Snapshot } from "../t3code/types.ts";
import { allAgentsDone, agentParticipatesInPhase, evaluateTransition, phaseTimeoutExpired } from "./phases.ts";
import { clearInterrupt, readAgentStatus, readMarker, readPrUrl, writeInterrupt, writePeerSync } from "./peer-sync.ts";
import { determineWinner, hasConsensus, readMergeVotes } from "./merge.ts";
import { shouldRunUpdateDocs } from "./learning.ts";
import { composeSkillMessage } from "./skills.ts";
import { persistState, readOrchestrationState, type AgentConfig, type OrchestrationState } from "./state.ts";
import { isoNow, makeId, nowEpoch, sleep } from "./util.ts";

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

    if (
      (runtime.status === "unknown" || runtime.status === "idle")
      && runtime.latestTurnState === "completed"
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
    runtime.status = phaseActiveStatus(state.phase);
    runtime.statusEpoch = nowEpoch();
    runtime.statusMessage = `entered ${state.phase}`;
    runtime.interrupted = false;
    clearInterrupt(state.peerSyncDir, agent.name);
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
  if (state.phase === "setup") return;

  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    const skillMessage = await composeSkillMessage(state, agent);
    await sendTurnMessage(state, agent, skillMessage);
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
  if (state.phase === "work" || state.phase === "review") {
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
    persistState(state);

    if (allAgentsDone(state)) return;
    if (state.phase === "pr-comments") return;
    if (nowEpoch() >= deadline) {
      await handleTimeout(state);
      return;
    }
    await sleep(interval);
  }
}

function mergedViaMarker(state: OrchestrationState): boolean {
  return state.agents.some((agent) => readMarker(state.peerSyncDir, `${agent.name}.merged`) !== null);
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
  if (state.phase === "pr-comments" && mergedViaMarker(state)) {
    return "suggest-refactor";
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
  persistState(state, harnessDir);
  return state;
}
