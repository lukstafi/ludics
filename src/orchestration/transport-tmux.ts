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
import { tmuxCapture } from "../adapters/tmux.ts";
import { substantiveDiff } from "./runner.ts";
import { loadOrchestrationConfig } from "../config.ts";

// Re-export for backwards compatibility (used by tests)
export { ttydPort };
import { agentParticipatesInPhase, DONE_STATUSES } from "./phases.ts";
import { readStopHookRecord } from "./peer-sync.ts";
import type { OrchestrationTransport } from "./transport.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { isoNow, makeId, nowEpoch } from "./util.ts";
import { safeSyncOutput } from "../spawn.ts";

/** Get child PIDs of a given parent PID */
function childPids(parentPid: number): number[] {
  const result = safeSyncOutput(["pgrep", "-P", String(parentPid)]);
  if (!result.ok) return [];
  return result.stdout.split("\n")
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

    // Phase token is read from peer-sync/phase-token file by orchOnStop —
    // no need to inject env vars into the agent CLI session.

    // Check if the agent CLI is already running in the pane (persistent session).
    // If not, reboot it — this handles crash recovery and first-turn-after-resume.
    if (!isAgentAlive(state.slot, agent.name, state.taskId)) {
      tmuxSendCommand(target, agentCliCommand(agent, loadOrchestrationConfig()));
      // Wait for the CLI to boot, then verify it's alive before pasting.
      // Codex can take longer to start than Claude Code.
      for (let wait = 0; wait < 15; wait++) {
        await Bun.sleep(1000);
        if (isAgentAlive(state.slot, agent.name, state.taskId)) break;
      }
      if (!isAgentAlive(state.slot, agent.name, state.taskId)) {
        console.error(`ludics: agent ${agent.name} CLI failed to start in slot ${state.slot} — skipping prompt`);
        return commandId;
      }
    }

    // Inject prompt via shared helper (handles copy-mode, paste-buffer, provider-specific Enter)
    await sendPromptToAgent(target, message, agent.provider);

    return commandId;
  }

  async sendEnter(state: OrchestrationState, agent: AgentConfig): Promise<void> {
    const target = tmuxSessionName(state.slot, agent.name, state.taskId);
    safeSyncOutput(["tmux", "send-keys", "-t", target, "C-m"]);
    await Bun.sleep(500);
    safeSyncOutput(["tmux", "send-keys", "-t", target, "C-m"]);
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

      // Track pane output changes for stall-detection and completion detection.
      // One tmuxCapture call feeds both the existing pane-hash (settled-no-signal
      // detector) and the new substantive-diff hung detector (task-a670cdbf).
      const target = tmuxSessionName(state.slot, agent.name, state.taskId);
      const rawCapture = tmuxCapture(target, 50);
      if (rawCapture) {
        const hasher = new Bun.CryptoHasher("md5");
        hasher.update(rawCapture);
        const paneHash = hasher.digest("hex");
        if (paneHash !== lc.lastPaneHash) {
          lc.lastPaneHash = paneHash;
          lc.lastPaneChangeAt = isoNow();
        }
        // Substantive-diff feed for the hung detector.
        const cfg = state.config.substantiveStall;
        if (lc.lastPaneRaw == null) {
          // First observation — seed only.
          lc.lastPaneRaw = rawCapture;
        } else if (rawCapture !== lc.lastPaneRaw) {
          const { chars, pct } = substantiveDiff(lc.lastPaneRaw, rawCapture);
          if (chars > cfg.minChars || pct > cfg.minPct) {
            // Substantive — clear stall window AND any in-flight hung-recovery
            // bookkeeping (proposal AC17).
            lc.substantiveStallSince = null;
            lc.substantiveStallChars = 0;
            lc.hungDetectedAt = null;
            lc.hungNudgeAttempts = 0;
            lc.lastPaneRaw = rawCapture;
          } else {
            // Under-threshold — start the stall window if absent; refresh raw
            // so a slow-but-genuine diff doesn't accrue forever.
            lc.substantiveStallSince ??= isoNow();
            lc.substantiveStallChars = (lc.substantiveStallChars ?? 0) + chars;
            lc.lastPaneRaw = rawCapture;
          }
        }
      }

      // Check process state
      const alive = isAgentAlive(state.slot, agent.name, state.taskId);

      // Peer-sync status done + pane static or process dead → settle.
      // The agent skill writes the status file before the turn ends (while still
      // writing artifacts). Only settle when pane output has stopped changing,
      // confirming the agent truly finished.
      if (DONE_STATUSES.has(runtime.status) && (lc.state === "dispatched" || lc.state === "running")) {
        const paneStatic = lc.lastPaneChangeAt
          ? (nowEpoch() - Math.floor(new Date(lc.lastPaneChangeAt).getTime() / 1000)) > 30
          : false;
        if (!alive || paneStatic) {
          lc.state = "settled";
          lc.turnCompletedAt = isoNow();
          lc.completionSource = "snapshot";
          continue;
        }
        // Agent wrote done status but pane is still active — wait for stop hook or pane to settle
      }

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

  /**
   * Hung-agent recovery (task-a670cdbf): exactly one C-c (NOT two — we want
   * to break the agent's stream back to the prompt without exiting the
   * session), 2 s sleep to let the TUI return to prompt, then re-dispatch
   * a fresh prompt via sendTurn.
   *
   * Distinct from `interruptAgent` which is force-settle (C-c × 2 + SIGTERM).
   */
  async breakAndPrompt(
    state: OrchestrationState,
    agent: AgentConfig,
    message: string,
  ): Promise<void> {
    const target = tmuxSessionName(state.slot, agent.name, state.taskId);
    tmuxSendKeys(target, "C-c");
    await Bun.sleep(2000);
    await this.sendTurn(state, agent, message);
  }

  // tmux transport does not support event subscription — pure polling only
}
