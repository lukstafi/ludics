import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { nowEpoch } from "./util.ts";

export type Phase =
  | "setup"
  | "gather"
  | "clarify"
  | "pushback"
  | "plan"
  | "plan-review"
  | "work"
  | "review"
  | "update-docs"
  | "pr-create"
  | "pr-comments"
  | "merge-vote"
  | "merge-debate"
  | "merge-execute"
  | "merge-review"
  | "merge-amend"
  | "suggest-refactor"
  | "final-merge"
  | "done";

export type PhaseCategory = "pre-work" | "main-loop" | "pr" | "merge" | "post-merge" | "terminal";

export interface TransitionRule {
  from: Phase;
  to: Phase;
  condition: (state: OrchestrationState) => boolean;
}

export const PHASE_CATEGORIES: Record<Phase, PhaseCategory> = {
  setup: "pre-work",
  gather: "pre-work",
  clarify: "pre-work",
  pushback: "pre-work",
  plan: "pre-work",
  "plan-review": "pre-work",
  work: "main-loop",
  review: "main-loop",
  "update-docs": "main-loop",
  "pr-create": "pr",
  "pr-comments": "pr",
  "merge-vote": "merge",
  "merge-debate": "merge",
  "merge-execute": "merge",
  "merge-review": "merge",
  "merge-amend": "merge",
  "suggest-refactor": "post-merge",
  "final-merge": "post-merge",
  done: "terminal",
};

const DONE_STATUSES = new Set([
  "done",
  "review-done",
  "plan-done",
  "plan-review-done",
  "clarify-done",
  "pushback-done",
  "gather-done",
  "update-docs-done",
  "pr-create-done",
  "pr-comments-done",
  "merge-vote-done",
  "merge-debate-done",
  "merge-execute-done",
  "merge-review-done",
  "merge-amend-done",
  "suggest-refactor-done",
  "final-merge-done",
  "turn-complete",
  "completed",
]);

export function phaseTimeoutExpired(state: OrchestrationState): boolean {
  const timeout = state.config.timeouts[state.phase] ?? 600;
  return nowEpoch() >= state.phaseStartedAt + timeout;
}

export function agentParticipatesInPhase(
  state: OrchestrationState,
  agent: AgentConfig,
): boolean {
  if (state.phase === "setup" || state.phase === "done") return false;
  if (state.mode === "duo") return true;
  // Pair mode: strict role separation
  switch (state.phase) {
    case "gather":
    case "review":
    case "plan-review":
    case "pushback":
      return agent.role === "reviewer";
    case "work":
    case "pr-create":
    case "final-merge":
      return agent.role === "coder";
    case "update-docs":
    case "pr-comments":
    case "suggest-refactor":
      return agent.role === "coder";
    // Merge phases are duo-only; should never be reached in pair mode
    case "merge-vote":
    case "merge-debate":
    case "merge-execute":
    case "merge-amend":
    case "merge-review":
      return false;
    default:
      return true;
  }
}

export function isAgentDone(state: OrchestrationState, agent: AgentConfig): boolean {
  const runtime = state.agentStates[agent.name];
  if (!runtime) return false;
  if (runtime.interrupted) return true;
  if (DONE_STATUSES.has(runtime.status)) return true;
  if (runtime.latestTurnState === "completed") return true;
  return false;
}

export function allAgentsDone(state: OrchestrationState): boolean {
  const participants = state.agents.filter((agent) => agentParticipatesInPhase(state, agent));
  if (participants.length === 0) return true;
  return participants.every((agent) => isAgentDone(state, agent));
}

function hasAnyPr(state: OrchestrationState): boolean {
  return state.agents.some((agent) => !!state.agentStates[agent.name]?.prUrl);
}

function hasTwoPrs(state: OrchestrationState): boolean {
  return state.agents.filter((agent) => !!state.agentStates[agent.name]?.prUrl).length >= 2;
}

function isMerged(state: OrchestrationState): boolean {
  return state.agents.some((agent) => state.agentStates[agent.name]?.status === "merged");
}

/** Read the latest reviewer verdict (APPROVE or REQUEST_CHANGES) from the review file. */
function pairReviewVerdict(state: OrchestrationState): "approve" | "request_changes" | null {
  const reviewer = state.agents.find((a) => a.role === "reviewer");
  if (!reviewer) return null;
  const reviewFile = join(state.peerSyncDir, "reviews", `round-${state.round}-${reviewer.name}.md`);
  if (!existsSync(reviewFile)) return null;
  const content = readFileSync(reviewFile, "utf-8").toUpperCase();
  if (/\bAPPROVE\b/.test(content) && !/\bREQUEST_CHANGES\b/.test(content)) return "approve";
  if (/\bREQUEST_CHANGES\b/.test(content)) return "request_changes";
  return null;
}

function nextAfterPrework(state: OrchestrationState): Phase {
  if (state.mode === "pair" && state.config.enableGather && state.phase === "setup") return "gather";
  if (state.config.enableClarify && (state.phase === "setup" || state.phase === "gather")) return "clarify";
  if (
    state.config.enablePushback
    && (state.phase === "setup" || state.phase === "gather" || state.phase === "clarify")
  ) {
    return "pushback";
  }
  if (
    state.config.enablePlan
    && (
      state.phase === "setup"
      || state.phase === "gather"
      || state.phase === "clarify"
      || state.phase === "pushback"
    )
  ) {
    return "plan";
  }
  return "work";
}

export function evaluateTransition(state: OrchestrationState): Phase | null {
  switch (state.phase) {
    case "setup":
      return nextAfterPrework(state);

    case "gather":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return nextAfterPrework(state);
      return null;

    case "clarify":
      if (allAgentsDone(state) || phaseTimeoutExpired(state) || state.confirmedPhase === "clarify") {
        if (state.config.enablePushback) return "pushback";
        if (state.config.enablePlan) return "plan";
        return "work";
      }
      return null;

    case "pushback":
      if (allAgentsDone(state) || phaseTimeoutExpired(state) || state.confirmedPhase === "pushback") {
        if (state.config.enablePlan) return "plan";
        return "work";
      }
      return null;

    case "plan":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "plan-review";
      return null;

    case "plan-review":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "work";
      return null;

    case "work":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "review";
      return null;

    case "review":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (state.mode === "pair") {
        const verdict = pairReviewVerdict(state);
        if (verdict === "request_changes") return "work";
        // APPROVE or timeout: proceed to update-docs
      }
      return "update-docs";

    case "update-docs":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (hasAnyPr(state)) return "pr-comments";
      if (state.mode === "pair") return "pr-create";
      return "work";

    case "pr-create":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "pr-comments";
      return null;

    case "pr-comments":
      if (isMerged(state)) return "suggest-refactor";
      if (state.mode === "duo" && hasTwoPrs(state)) return "merge-vote";
      // Pair mode: stay in pr-comments until merged externally
      return null;

    case "merge-vote":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      return "merge-execute";

    case "merge-debate":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      return "merge-execute";

    case "merge-execute":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "merge-review";
      return null;

    case "merge-review":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      return state.mergeRound >= 3 ? "pr-comments" : "merge-amend";

    case "merge-amend":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "merge-review";
      return null;

    case "suggest-refactor":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      return state.config.autoFinish ? "final-merge" : "done";

    case "final-merge":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "done";
      return null;

    case "done":
      return "done";
  }
}
