import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { emitEvent } from "../events.ts";
import { isPrUrl } from "./github.ts";
import { statusFileFingerprint } from "./peer-sync.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { nowEpoch } from "./util.ts";

export type Phase =
  | "setup"
  | "gather"
  | "clarify"
  | "pushback"
  | "plan"
  | "plan-merge"
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
  | "forward-pr"
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
  "plan-merge": "pre-work",
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
  "forward-pr": "pr",
  "final-merge": "post-merge",
  done: "terminal",
};

/** Grace period (seconds) after a turn settles before treating as done without status update. */
const SETTLED_GRACE_PERIOD_S = 30;

/**
 * Return the path of the required artifact for this phase/agent, or null if
 * the phase has no required file artifact.  When a non-null path is returned,
 * `isAgentDone()` will NOT treat the agent as done until the file exists.
 */
function requiredArtifactPath(state: OrchestrationState, agent: AgentConfig): string | null {
  const dir = state.peerSyncDir;
  switch (state.phase) {
    case "plan":
      return join(dir, "plans", `round-${state.round}-${agent.name}.md`);
    case "plan-merge":
      // Only coder participates; writes a merged plan file keyed by planMergeRound so that
      // each retry iteration requires a fresh file and can't be satisfied by a stale one.
      return join(dir, "plans", `round-${state.round}-merged-${state.planMergeRound ?? 0}.md`);
    case "plan-review":
      // Uses planMergeRound to give each iteration its own review file so the
      // artifact gate isn't bypassed by a stale file from a previous iteration.
      return join(dir, "reviews", `plan-merge-${state.planMergeRound ?? 0}-${agent.name}.md`);
    case "review":
      return join(dir, "reviews", `round-${state.round}-${agent.name}.md`);
    case "pr-create":
      return join(dir, `${agent.name}.pr`);
    default:
      return null;
  }
}

/**
 * Check whether the required phase artifact exists and is valid for the agent.
 * Returns true when no artifact is required or when the artifact is present and valid.
 *
 * For `pr-create`, mere file existence is insufficient — the file must contain
 * a valid GitHub PR URL.  A malformed PR body that `validateAndFixPrFile()`
 * has not yet converted keeps the agent not-done so the runner has a chance to
 * auto-fix it on the next poll cycle.
 */
function hasRequiredArtifact(state: OrchestrationState, agent: AgentConfig): boolean {
  const path = requiredArtifactPath(state, agent);
  if (!path) return true;
  if (!existsSync(path)) return false;

  // For pr-create, validate that the file contains a valid PR URL.
  if (state.phase === "pr-create") {
    try {
      const content = readFileSync(path, "utf-8").trim();
      return !!content && isPrUrl(content);
    } catch {
      return false;
    }
  }

  return true;
}

export const DONE_STATUSES = new Set([
  "done",
  "review-done",
  "plan-done",
  "plan-merge-done",
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
  "forward-pr-done",
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
    case "plan-merge":
      // Coder reads both independent plans and produces the merged plan.
      return agent.role === "coder";
    case "work":
    case "pr-create":
    case "forward-pr":
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

/**
 * Determine if an agent has finished its work for the current phase.
 *
 * Uses the dispatch-scoped AgentTurnLifecycle for identity-based tracking
 * instead of timestamp freshness heuristics.  See
 * docs/orchestration-phase-transitions.md §5–6 for the full rationale.
 *
 * Signal precedence:
 *  1. If lifecycle says "running" or "dispatched" → NOT done (turn in progress).
 *  2. If lifecycle says "settled" + peer-sync done status → done.
 *  3. If lifecycle says "settled" + no status update + grace period elapsed → done (with warning).
 *  4. If lifecycle says "error" → done (error is terminal).
 *  5. No lifecycle (setup phase or legacy state) → trust peer-sync.
 */
export function isAgentDone(state: OrchestrationState, agent: AgentConfig): boolean {
  const runtime = state.agentStates[agent.name];
  if (!runtime) return false;
  if (runtime.interrupted) return true;
  if (runtime.status === "merged") return true;

  const lc = runtime.turnLifecycle;

  // No lifecycle → pre-existing / setup state, or resume after crash.
  // Apply dispatch-scoped freshness gate + artifact validation.
  if (!lc) {
    if (!DONE_STATUSES.has(runtime.status)) return false;

    // Dispatch-scoped freshness gate: reject status files that haven't changed
    // since the last dispatch. On resume, slotResume() clears turnLifecycle but
    // phaseDispatched=false triggers re-dispatch which touches the .status file
    // and captures a new dispatchStatusFingerprint. The agent must write AFTER
    // that touch for the fingerprint to differ.
    const baseline = runtime.dispatchStatusFingerprint;
    if (baseline !== undefined && baseline !== null) {
      const currentFp = statusFileFingerprint(state.peerSyncDir, agent.name);
      if (currentFp === baseline) {
        emitEvent({
          event_type: "orchestration_warning",
          source: "orchestration",
          scope: "slot",
          slot: state.slot,
          task: state.taskId,
          message: `${agent.name}: status "${runtime.status}" is stale (fingerprint unchanged since dispatch)`,
        });
        return false;
      }
    }

    // Artifact validation (same gate as the settled branch).
    if (!hasRequiredArtifact(state, agent)) {
      emitEvent({
        event_type: "orchestration_warning",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        message: `${agent.name}: status is "${runtime.status}" but required artifact missing: ${requiredArtifactPath(state, agent)}`,
      });
      return false;
    }

    return true;
  }

  switch (lc.state) {
    case "dispatched":
    case "starting":
    case "running":
      // Turn not yet settled — never done regardless of peer-sync.
      return false;

    case "settled": {
      // Turn settled — check for a done status from peer-sync.
      if (DONE_STATUSES.has(runtime.status)) {
        // Validate required phase artifact before treating as done.
        if (!hasRequiredArtifact(state, agent)) {
          emitEvent({
            event_type: "orchestration_warning",
            source: "orchestration",
            scope: "slot",
            slot: state.slot,
            task: state.taskId,
            message: `${agent.name}: status is "${runtime.status}" but required artifact missing: ${requiredArtifactPath(state, agent)}`,
          });
          return false;
        }
        return true;
      }

      // Status file may not have been updated yet. Check fingerprint.
      const currentFp = statusFileFingerprint(state.peerSyncDir, agent.name);
      if (currentFp !== lc.statusFileFingerprint) {
        // Status file changed since dispatch but isn't a done status — keep waiting.
        return false;
      }

      // Status file unchanged since dispatch AND not a done status.
      // The agent was likely interrupted (e.g. model capacity error, crash)
      // without completing its work. The runner's interrupted-agent nudge
      // loop will send "Continue." to resume the agent.
      return false;
    }

    case "error":
      // Error is a terminal state — treat as done.
      return true;
  }
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

/**
 * Check if PR forwarding to upstream has completed successfully.
 * Uses the ${agent}.forwarded marker (written only after upstream PR creation succeeds
 * and PR_FILE is overwritten), NOT the ${agent}.staging-pr file (written early for
 * URL preservation). This prevents a failed/timed-out forward from being misclassified.
 */
function hasForwardedPr(state: OrchestrationState): boolean {
  return state.agents.some((agent) =>
    existsSync(join(state.peerSyncDir, `${agent.name}.forwarded`))
  );
}

/** Check if upstream PR has been detected as merged. */
function hasUpstreamMergedMarker(state: OrchestrationState): boolean {
  return state.agents.some((agent) =>
    existsSync(join(state.peerSyncDir, `${agent.name}.upstream-merged`))
  );
}

/** Read the latest reviewer verdict (APPROVE or REQUEST_CHANGES) from the review file. */
export function pairReviewVerdict(state: OrchestrationState): "approve" | "request_changes" | null {
  const reviewer = state.agents.find((a) => a.role === "reviewer");
  if (!reviewer) return null;
  // plan-review uses per-iteration files keyed by planMergeRound to avoid stale verdicts.
  const reviewFile = state.phase === "plan-review"
    ? join(state.peerSyncDir, "reviews", `plan-merge-${state.planMergeRound ?? 0}-${reviewer.name}.md`)
    : join(state.peerSyncDir, "reviews", `round-${state.round}-${reviewer.name}.md`);
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
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) {
        // Pair mode: both agents wrote independent plans — move to plan-merge so the
        // coder can combine them before the reviewer does a formal review.
        // Duo mode: go straight to plan-review (original behaviour).
        return state.mode === "pair" ? "plan-merge" : "plan-review";
      }
      return null;

    case "plan-merge":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "plan-review";
      return null;

    case "plan-review": {
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      // In pair mode, honour the reviewer's verdict and loop back to plan-merge on
      // REQUEST_CHANGES (up to 3 iterations total before forcing forward to work).
      if (state.mode === "pair") {
        const verdict = pairReviewVerdict(state);
        if (verdict === "request_changes" && (state.planMergeRound ?? 0) < 3) {
          return "plan-merge";
        }
      }
      return "work";
    }

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
      // NOTE: Runner verifies PR exists on GitHub before agents reach done state here.
      // See verifyPrCreateOutcome() in runner.ts.
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "pr-comments";
      return null;

    case "pr-comments": {
      if (isMerged(state)) return "suggest-refactor";
      if (state.mode === "duo" && hasTwoPrs(state)) return "merge-vote";

      // Staging forwarding is pair-mode only. In duo mode, stagingRepo is ignored
      // because the two-agent winner-selection flow doesn't compose with the
      // single-PR staging→upstream forwarding model.
      const isStaging = !!state.stagingRepo && state.mode === "pair";
      const forwarded = isStaging && hasForwardedPr(state);

      if (isStaging && !forwarded) {
        // Monitoring staging PR — transition to forward-pr on quiet period
        const quietPeriodStaging = state.config.prCommentsTimeout;
        if (
          hasAnyPr(state)
          && state.prCommentsQuietSince
          && nowEpoch() - state.prCommentsQuietSince >= quietPeriodStaging
        ) {
          return "forward-pr";
        }
        if (phaseTimeoutExpired(state) && hasAnyPr(state)) return "forward-pr";
        return null;
      }

      if (forwarded) {
        // Monitoring upstream PR — ONLY transition on actual upstream merge.
        // No quiet-period, no Codex approval, no phase timeout.
        // The upstream PR may take days to merge; the automation must not
        // run cleanup on a non-merged PR. If the PR sits idle indefinitely,
        // the human intervenes (merge or cancel the task).
        if (hasUpstreamMergedMarker(state)) return "final-merge";
        return null;
      }

      // Non-staging (or duo with staging_repo — treated as non-staging):
      // quiet period is the sole advancement mechanism
      const quietPeriod = state.config.prCommentsTimeout;
      if (
        hasAnyPr(state)
        && state.prCommentsQuietSince
        && nowEpoch() - state.prCommentsQuietSince >= quietPeriod
      ) {
        return "final-merge";
      }
      if (phaseTimeoutExpired(state) && hasAnyPr(state)) return "final-merge";
      return null;
    }

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
      // final-merge now precedes suggest-refactor in the automated path; always finish here.
      return "done";

    case "forward-pr":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "pr-comments";
      return null;

    case "final-merge":
      // NOTE: Runner verifies PR is merged on GitHub before agents reach done state here.
      // See verifyFinalMergeOutcome() in runner.ts.
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "suggest-refactor";
      return null;

    case "done":
      return "done";
  }
}
