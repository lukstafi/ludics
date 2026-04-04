// T3Code transport — implements OrchestrationTransport using t3code WebSocket protocol.
// Extracted from runner.ts to allow pluggable transport backends.

import { T3CodeClient } from "../t3code/client.ts";
import { readServerRecord } from "../t3code/server.ts";
import { toWireProvider } from "../t3code/types.ts";
import type { T3CodeServerRecord, T3Snapshot } from "../t3code/types.ts";
import { emitEvent } from "../events.ts";
import { agentParticipatesInPhase } from "./phases.ts";
import { readStopHookRecord } from "./peer-sync.ts";
import type { OrchestrationTransport } from "./transport.ts";
import type { AgentConfig, AgentTurnLifecycle, OrchestrationState } from "./state.ts";
import { isoNow, makeId } from "./util.ts";

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

async function fetchSnapshot(record: T3CodeServerRecord | null): Promise<T3Snapshot | null> {
  if (!record) return null;
  try {
    return await withClient(record, (client) => client.getSnapshot());
  } catch {
    return null;
  }
}

function threadSnapshot(snapshot: T3Snapshot | null, threadId: string) {
  return snapshot?.threads.find((thread) => thread.id === threadId) ?? null;
}

/**
 * Normalise a raw effort value to a named level string.
 * Legacy numeric token-budget values are mapped to the closest named level.
 */
function normaliseEffortLevel(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower === "low" || lower === "medium" || lower === "high" || lower === "max") return lower;
  const n = parseInt(raw, 10);
  if (!isNaN(n)) {
    if (n <= 1024) return "low";
    if (n <= 8192) return "medium";
    return "high";
  }
  return "high";
}

/**
 * Build modelSelection options with effort/reasoning settings.
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
  const codexLevel = level === "max" ? "high" : level;
  return { provider: wireProvider, model: agent.model, options: { reasoningEffort: codexLevel } };
}

/**
 * Advance the per-agent turn lifecycle state machine based on t3code snapshot data.
 */
export function updateTurnLifecycle(
  lc: AgentTurnLifecycle,
  sessionStatus: string | null,
  activeTurnId: string | null,
  latestTurn: { turnId: string; state: string; completedAt?: string | null; startedAt?: string | null } | null,
): void {
  switch (lc.state) {
    case "dispatched": {
      if (sessionStatus === "running" && activeTurnId) {
        lc.observedTurnId = activeTurnId;
        lc.state = "running";
        lc.turnStartedAt = isoNow();
      }
      break;
    }
    case "running": {
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
  }
}

export class T3CodeTransport implements OrchestrationTransport {
  async sendTurn(
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

  async sendEnter(_state: OrchestrationState, _agent: AgentConfig): Promise<void> {
    // No-op for t3code — turns are dispatched via WebSocket, not terminal input.
  }

  async refreshAgentTransportState(state: OrchestrationState): Promise<void> {
    const record = readServerRecord();
    const snapshot = await fetchSnapshot(record);

    for (const agent of state.agents) {
      if (!agentParticipatesInPhase(state, agent)) continue;

      const thread = threadSnapshot(snapshot, state.threadIds[agent.name]);
      const sessionStatus = thread?.session?.status;
      const activeTurnId = thread?.session?.activeTurnId ?? null;
      const latestTurn = thread?.latestTurn ?? null;

      const runtime = state.agentStates[agent.name]!;
      const lc = runtime.turnLifecycle;
      if (lc) {
        updateTurnLifecycle(lc, sessionStatus ?? null, activeTurnId, latestTurn);

        // Check stop-hook records for fast-complete detection
        const stopRecord = readStopHookRecord(state.peerSyncDir, agent.name);
        if (stopRecord && stopRecord.phaseToken === lc.phaseToken) {
          lc.lastStopHookAt = stopRecord.observedAt;
          if (lc.state === "dispatched" && latestTurn?.state === "completed" && !activeTurnId) {
            lc.observedTurnId = latestTurn.turnId;
            lc.state = "settled";
            lc.turnCompletedAt = latestTurn.completedAt ?? isoNow();
            lc.completionSource = "stop-hook";
          }
        }

        // Snapshot reconciliation for stuck dispatched lifecycles:
        // If lifecycle is still "dispatched", no stop-hook arrived, but the snapshot
        // shows a terminal latestTurn requested AFTER our dispatch, settle the lifecycle.
        if (lc.state === "dispatched" && !activeTurnId && latestTurn
            && (latestTurn.state === "completed" || latestTurn.state === "error")
            && sessionStatus !== null && sessionStatus !== undefined) {
          const turnRequested = latestTurn.requestedAt
            ? new Date(latestTurn.requestedAt).getTime()
            : 0;
          const dispatched = new Date(lc.dispatchedAt).getTime();
          if (turnRequested >= dispatched) {
            lc.observedTurnId = latestTurn.turnId;
            lc.state = latestTurn.state === "error" ? "error" : "settled";
            lc.turnCompletedAt = latestTurn.completedAt ?? isoNow();
            lc.completionSource = "snapshot";
            emitEvent({
              event_type: "orchestration_snapshot_reconcile",
              source: "orchestration",
              scope: "slot",
              slot: state.slot,
              task: state.taskId,
              agent: agent.name,
              message: `${agent.name}: reconciled stuck dispatched lifecycle via snapshot (latestTurn.requestedAt >= dispatchedAt)`,
            });
          }
        }

        // Post-nudge outcome classification
        if ((lc.stallDetectedAt ?? null) !== null && lc.state === "settled") {
          const nudgeAttempts = lc.nudgeAttempts ?? 0;
          if (nudgeAttempts > 0) {
            const currentAMId = latestTurn?.assistantMessageId ?? null;
            const preAMId = lc.preNudgeAssistantMessageId ?? null;
            const agentResponded = currentAMId !== null && currentAMId !== preAMId;
            emitEvent({
              event_type: agentResponded
                ? "orchestration_nudge_settled_alive"
                : "orchestration_nudge_settled_dead",
              source: "orchestration",
              scope: "slot",
              slot: state.slot,
              task: state.taskId,
              agent: agent.name,
              nudgeAttempts,
              message: `${agent.name}: stall resolved (${agentResponded ? "alive" : "dead"}) after ${nudgeAttempts} nudge(s)`,
            });
          }
          // Clear stall bookkeeping
          lc.stallDetectedAt = null;
          lc.nudgeAttempts = 0;
          lc.lastNudgeAt = null;
          lc.preNudgeAssistantMessageId = null;
        }
      }
    }
  }

  async interruptAgent(
    state: OrchestrationState,
    agent: AgentConfig,
  ): Promise<void> {
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
  }

  async subscribeEvents(callback: () => void): Promise<(() => void) | null> {
    const record = readServerRecord();
    if (!record) return null;

    try {
      const client = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
      await client.connect();
      const unsubscribe = client.onDomainEvent((event) => {
        if (event.type !== "thread.session.set" && event.type !== "thread.turn-diff-completed") return;
        callback();
      });
      return () => {
        unsubscribe();
        client.close();
      };
    } catch {
      return null;
    }
  }
}
