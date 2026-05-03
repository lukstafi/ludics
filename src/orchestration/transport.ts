// Orchestration transport interface — abstracts the backend (t3code vs tmux)
// used by the orchestration runner for agent dispatch, state observation, and interrupts.

import type { AgentConfig, OrchestrationState } from "./state.ts";

/**
 * Transport interface for orchestration backends.
 *
 * The orchestration runner uses this interface to dispatch turns,
 * observe agent state, and interrupt agents. Peer-sync reading
 * is handled separately by shared code in the runner.
 */
export interface OrchestrationTransport {
  /**
   * Dispatch a turn message to an agent.
   * Returns a correlation commandId for lifecycle tracking.
   */
  sendTurn(
    state: OrchestrationState,
    agent: AgentConfig,
    message: string,
  ): Promise<string>;

  /**
   * Update turn lifecycle for all agents from transport-specific backend data.
   * Called on each poll cycle. Peer-sync status reading is handled separately
   * by the runner's shared code — this method handles only the transport-specific
   * portion (e.g., t3code snapshot or tmux process state).
   */
  refreshAgentTransportState(state: OrchestrationState): Promise<void>;

  /**
   * Send just an Enter keystroke to an agent's session.
   * Used as a lightweight nudge when the prompt may already be in the input
   * buffer but the submit key didn't fire.
   */
  sendEnter(
    state: OrchestrationState,
    agent: AgentConfig,
  ): Promise<void>;

  /**
   * Interrupt an agent's current turn via the transport backend.
   * The runner also writes the peer-sync interrupt marker separately.
   */
  interruptAgent(
    state: OrchestrationState,
    agent: AgentConfig,
  ): Promise<void>;

  /**
   * Hung-agent recovery primitive (task-a670cdbf): exactly one C-c (NOT two —
   * we want to break the agent's stream back to the prompt without exiting
   * the session), wait, then re-dispatch a fresh prompt. Tmux-only;
   * t3code transport omits this method and the substantive-diff detector
   * skips t3code agents entirely.
   *
   * Distinct from `interruptAgent` which is force-settle (C-c × 2 + SIGTERM).
   */
  breakAndPrompt?(
    state: OrchestrationState,
    agent: AgentConfig,
    message: string,
  ): Promise<void>;

  /**
   * Subscribe to transport events for early poll wakeup (optional optimization).
   * Returns an unsubscribe function, or null if event subscription is not supported.
   * The callback is invoked when a relevant transport event occurs (e.g., turn completed).
   */
  subscribeEvents?(callback: () => void): Promise<(() => void) | null>;
}
