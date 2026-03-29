// Tmux transport — implements OrchestrationTransport using tmux+ttyd.
// Agents run as CLI processes in tmux panes; ttyd exposes them via HTTP.
// Turn detection relies on stop hooks and process exit, not streaming APIs.

import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import {
  tmuxAvailable, tmuxHasSession, tmuxNewSession, tmuxKillSession,
  tmuxSendKeys, tmuxSendCommand, tmuxPanePid, tmuxCapture,
} from "../adapters/tmux.ts";
import { agentParticipatesInPhase } from "./phases.ts";
import { readStopHookRecord } from "./peer-sync.ts";
import type { OrchestrationTransport } from "./transport.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { isoNow, makeId, nowEpoch } from "./util.ts";

const TMUX_SESSION = "ludics";
const PORT_BASE = 7681; // port 7680 reserved

/** Deterministic tmux target: session:window */
function tmuxTarget(slot: number, agentName: string): string {
  return `${TMUX_SESSION}:slot-${slot}-${agentName}`;
}

/** Deterministic tmux window name */
function tmuxWindowName(slot: number, agentName: string): string {
  return `slot-${slot}-${agentName}`;
}

/** Fixed ttyd port for a slot/role combination */
export function ttydPort(slot: number, role: "coder" | "reviewer"): number {
  const roleIndex = role === "reviewer" ? 1 : 0;
  return PORT_BASE + (slot - 1) * 2 + roleIndex;
}

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

/** Check if an agent CLI process (claude/codex) is alive in the given pane */
function isAgentCliAlive(slot: number, agentName: string): boolean {
  const target = tmuxTarget(slot, agentName);
  const panePid = tmuxPanePid(target);
  if (!panePid) return false;
  const children = childPids(panePid);
  if (children.length === 0) return false;
  // Check if any child is a claude or codex process
  for (const pid of children) {
    const check = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], {
      stdout: "pipe", stderr: "pipe",
    });
    const comm = check.stdout.toString().trim().toLowerCase();
    if (comm.includes("claude") || comm.includes("codex") || comm.includes("node") || comm.includes("bun")) {
      return true;
    }
  }
  return false;
}

export class TmuxTransport implements OrchestrationTransport {
  async sendTurn(
    state: OrchestrationState,
    agent: AgentConfig,
    message: string,
  ): Promise<string> {
    const target = tmuxTarget(state.slot, agent.name);
    const commandId = makeId("cmd");

    // Update environment variables for the current phase token (stop hook needs it)
    const envUpdateCmd = `export LUDICS_PHASE_TOKEN="${state.currentPhaseToken ?? ""}"`;
    tmuxSendCommand(target, envUpdateCmd);
    await Bun.sleep(100);

    // Check if the agent CLI is already running in the pane (persistent session).
    // If not, reboot it — this handles crash recovery and first-turn-after-resume.
    const alive = isAgentCliAlive(state.slot, agent.name);
    if (!alive) {
      // Agent CLI not running — boot a fresh persistent session
      let cliCmd: string;
      if (agent.provider === "claude-code") {
        cliCmd = "claude --dangerously-skip-permissions";
      } else {
        cliCmd = "codex --full-auto";
      }
      tmuxSendCommand(target, cliCmd);
      // Wait for the CLI to boot and show its prompt
      await Bun.sleep(3000);
    }

    // Inject prompt into the live interactive agent CLI session.
    // Write to temp file to avoid shell escaping / tmux send-keys length limits.
    const promptFile = `/tmp/ludics-prompt-${state.slot}-${agent.name}-${Date.now()}.txt`;
    writeFileSync(promptFile, message);

    if (agent.provider === "claude-code") {
      // Claude Code interactive: pipe the prompt file content
      // Use Escape first to clear any partial input, then send the prompt
      tmuxSendKeys(target, "Escape");
      await Bun.sleep(50);
      // Send the prompt content: read from file and type it in
      const sendCmd = `cat ${promptFile}`;
      tmuxSendKeys(target, `$(${sendCmd})`, true);
      await Bun.sleep(50);
      tmuxSendKeys(target, "Enter");
    } else {
      // Codex interactive: same approach
      tmuxSendKeys(target, "Escape");
      await Bun.sleep(50);
      tmuxSendKeys(target, `$(cat ${promptFile})`, true);
      await Bun.sleep(50);
      tmuxSendKeys(target, "Enter");
    }

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

      // Check process state as secondary signal
      const alive = isAgentCliAlive(state.slot, agent.name);

      switch (lc.state) {
        case "dispatched": {
          if (alive) {
            // Process started — transition to running
            lc.state = "running";
            lc.turnStartedAt = isoNow();
            lc.observedTurnId = makeId("tmux-turn");
          }
          break;
        }
        case "running": {
          if (!alive) {
            // Process exited without stop hook — likely error or crash
            lc.state = "settled";
            lc.turnCompletedAt = isoNow();
            lc.completionSource = "snapshot"; // reuse existing label
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
    const target = tmuxTarget(state.slot, agent.name);

    // Send C-c to interrupt
    tmuxSendKeys(target, "C-c");

    // Wait and check if process stopped
    await Bun.sleep(2000);
    if (isAgentCliAlive(state.slot, agent.name)) {
      // Send C-c again
      tmuxSendKeys(target, "C-c");
      await Bun.sleep(2000);

      // If still alive, kill the child process
      if (isAgentCliAlive(state.slot, agent.name)) {
        const panePid = tmuxPanePid(target);
        if (panePid) {
          const children = childPids(panePid);
          for (const pid of children) {
            try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
          }
        }
      }
    }
  }

  // tmux transport does not support event subscription — pure polling only
}
