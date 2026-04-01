// Tmux transport — implements OrchestrationTransport using tmux+ttyd.
// Agents run as CLI processes in tmux panes; ttyd exposes them via HTTP.
// Turn detection relies on stop hooks and process exit, not streaming APIs.

import {
  tmuxSendKeys, tmuxSendCommand, tmuxPanePid,
} from "../adapters/tmux.ts";
import {
  tmuxSessionName, isAgentAlive, agentCliCommand, sendPromptToAgent,
  ttydPort,
} from "../adapters/tmux-adapter.ts";

// Re-export for backwards compatibility (used by tests)
export { ttydPort };
import { agentParticipatesInPhase, DONE_STATUSES } from "./phases.ts";
import { readStopHookRecord } from "./peer-sync.ts";
import type { OrchestrationTransport } from "./transport.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { isoNow, makeId, nowEpoch } from "./util.ts";

/** Get child PIDs of a given parent PID */
function childPids(parentPid: number): number[] {
  const result = Bun.spawnSync(["pgrep", "-P", String(parentPid)], {
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) return [];
  return result.stdout.toString().trim().split("\n")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
}

export class TmuxTransport implements OrchestrationTransport {
  async sendTurn(
    state: OrchestrationState,
    agent: AgentConfig,
    message: string,
  ): Promise<string> {
    const target = tmuxSessionName(state.slot, agent.name, state.taskId);
    const commandId = makeId("cmd");

    // Update environment variables for the current phase token (stop hook needs it)
    const envUpdateCmd = `export LUDICS_PHASE_TOKEN="${state.currentPhaseToken ?? ""}"`;
    tmuxSendCommand(target, envUpdateCmd);
    await Bun.sleep(100);

    // Check if the agent CLI is already running in the pane (persistent session).
    // If not, reboot it — this handles crash recovery and first-turn-after-resume.
    if (!isAgentAlive(state.slot, agent.name, state.taskId)) {
      tmuxSendCommand(target, agentCliCommand(agent.provider));
      // Wait for the CLI to boot and show its prompt
      await Bun.sleep(3000);
    }

    // Inject prompt via shared helper (handles copy-mode, paste-buffer, provider-specific Enter)
    await sendPromptToAgent(target, message, agent.provider);

    return commandId;
  }

  async refreshAgentTransportState(state: OrchestrationState): Promise<void> {
    for (const agent of state.agents) {
      if (!agentParticipatesInPhase(state, agent)) continue;

      const runtime = state.agentStates[agent.name]!;
      const lc = runtime.turnLifecycle;
      if (!lc) continue;

      // Check stop-hook records (authoritative completion signal)
      const stopRecord = readStopHookRecord(state.peerSyncDir, agent.name);
      if (stopRecord && stopRecord.phaseToken === lc.phaseToken) {
        lc.lastStopHookAt = stopRecord.observedAt;
        if (lc.state === "dispatched" || lc.state === "running") {
          lc.state = "settled";
          lc.turnCompletedAt = stopRecord.observedAt ?? isoNow();
          lc.completionSource = "stop-hook";
        }
        continue;
      }

      // Peer-sync status is authoritative: if agent wrote a done status,
      // settle immediately even if the process is still alive (TUI stuck).
      // This handles the t3code/Claude Code case where the TUI hangs after completion.
      if (DONE_STATUSES.has(runtime.status) && (lc.state === "dispatched" || lc.state === "running")) {
        lc.state = "settled";
        lc.turnCompletedAt = isoNow();
        lc.completionSource = "snapshot";
        continue;
      }

      // Check process state as secondary signal
      const alive = isAgentAlive(state.slot, agent.name, state.taskId);

      switch (lc.state) {
        case "dispatched": {
          if (alive) {
            lc.state = "running";
            lc.turnStartedAt = isoNow();
            lc.observedTurnId = makeId("tmux-turn");
          }
          break;
        }
        case "running": {
          if (!alive) {
            lc.state = "settled";
            lc.turnCompletedAt = isoNow();
            lc.completionSource = "snapshot";
          }
          break;
        }
        // settled and error are terminal states
      }
    }
  }

  async interruptAgent(
    state: OrchestrationState,
    agent: AgentConfig,
  ): Promise<void> {
    const target = tmuxSessionName(state.slot, agent.name, state.taskId);

    // Send C-c to interrupt
    tmuxSendKeys(target, "C-c");

    // Wait and check if process stopped
    await Bun.sleep(2000);
    if (isAgentAlive(state.slot, agent.name, state.taskId)) {
      tmuxSendKeys(target, "C-c");
      await Bun.sleep(2000);

      // If still alive, kill the child processes
      if (isAgentAlive(state.slot, agent.name, state.taskId)) {
        const panePid = tmuxPanePid(target);
        if (panePid) {
          for (const pid of childPids(panePid)) {
            try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
          }
        }
      }
    }
  }

  // tmux transport does not support event subscription — pure polling only
}
