import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { emitEvent } from "../events.ts";
import { isPrUrl } from "./github.ts";
import { statusFileFingerprint } from "./peer-sync.ts";
import { planFilePath, mergedPlanFilePath, parsePlanFilename } from "./plan-files.ts";
import { reviewFilePath } from "./review-files.ts";
import type { AgentConfig, AgentRuntimeState, OrchestrationState } from "./state.ts";
import { readDuoPeerState, bothSlotsReadyForMerge, isMergeCoordinator } from "./cross-slot.ts";
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
      return planFilePath(dir, state.round, agent.name);
    case "plan-merge":
      // Only coder participates; writes a merged plan file keyed by planMergeRound so that
      // each retry iteration requires a fresh file and can't be satisfied by a stale one.
      return mergedPlanFilePath(dir, state.round, state.planMergeRound ?? 0);
    case "plan-review":
      // Uses planMergeRound to give each iteration its own review file so the
      // artifact gate isn't bypassed by a stale file from a previous iteration.
      return reviewFilePath(dir, "plan-review", state.planMergeRound ?? 0, agent.name);
    case "review":
      return reviewFilePath(dir, "review", state.round, agent.name);
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
  "bail-out",
  "bail-out-confirmed",
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
  // Strict role separation for all slots (pair and hierarchical-duo)
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
    // Merge phases: only active in hierarchical-duo slots (duoPeerSlot set)
    case "merge-vote":
    case "merge-debate":
      return state.duoPeerSlot != null;
    case "merge-execute":
    case "merge-amend":
      return state.duoPeerSlot != null && agent.role === "coder";
    case "merge-review":
      return state.duoPeerSlot != null && agent.role === "reviewer";
    default:
      return true;
  }
}

/** Check done-status + required artifact. Shared by both lifecycle branches of isAgentDone. */
function validateDoneStatus(state: OrchestrationState, agent: AgentConfig, runtime: AgentRuntimeState): boolean {
  if (!DONE_STATUSES.has(runtime.status)) return false;
  // Bail-out statuses bypass artifact validation — no review file or PR file expected.
  if (runtime.status === "bail-out" || runtime.status === "bail-out-confirmed") return true;
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

/**
 * Check whether the status file has changed since dispatch.
 * Returns `true` if the status is fresh (fingerprint differs from baseline)
 * or if there is no baseline to compare against.
 * Returns `false` and emits a warning if the fingerprint is unchanged (stale).
 */
function isStatusFresh(
  state: OrchestrationState,
  agent: AgentConfig,
  runtime: AgentRuntimeState,
): boolean {
  const baseline = runtime.dispatchStatusFingerprint;
  if (baseline === undefined || baseline === null) return true;
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
  return true;
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
    if (!isStatusFresh(state, agent, runtime)) return false;

    return validateDoneStatus(state, agent, runtime);
  }

  switch (lc.state) {
    case "dispatched":
    case "starting":
    case "running":
      // Turn not yet settled — never done regardless of peer-sync.
      return false;

    case "settled": {
      // Fingerprint freshness gate: reject stale status from before dispatch.
      if (!isStatusFresh(state, agent, runtime)) {
        // Status file is stale, but if the agent produced the required artifact
        // and has been nudged multiple times without updating status, treat as
        // done.  The agent likely completed its work but skipped the status
        // write (e.g. didn't execute the printf command in the template).
        if ((lc.nudgeAttempts ?? 0) >= 2
            && requiredArtifactPath(state, agent) !== null
            && hasRequiredArtifact(state, agent)) {
          emitEvent({
            event_type: "orchestration_warning",
            source: "orchestration",
            scope: "slot",
            slot: state.slot,
            task: state.taskId,
            message: `${agent.name}: status stale but artifact present after ${lc.nudgeAttempts} nudges — treating as done`,
          });
          return true;
        }
        return false;
      }

      // Turn settled — check for a done status from peer-sync.
      if (validateDoneStatus(state, agent, runtime)) return true;

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

/** True when both agents have signaled bail-out: coder wrote "bail-out", reviewer confirmed with "bail-out-confirmed". */
export function isPairBailedOut(state: OrchestrationState): boolean {
  const coder = state.agents.find(a => a.role === "coder");
  const reviewer = state.agents.find(a => a.role === "reviewer");
  if (!coder || !reviewer) return false;
  const cs = state.agentStates[coder.name]?.status ?? "";
  const rs = state.agentStates[reviewer.name]?.status ?? "";
  return cs === "bail-out" && rs === "bail-out-confirmed";
}

function hasAnyPr(state: OrchestrationState): boolean {
  return state.agents.some((agent) => {
    const url = state.agentStates[agent.name]?.prUrl;
    return typeof url === "string" && url.startsWith("https://");
  });
}

function isMerged(state: OrchestrationState): boolean {
  return state.agents.some((agent) => state.agentStates[agent.name]?.status === "merged");
}

/**
 * Check if PR forwarding to upstream has completed successfully.
 * Uses the ${agent}.forwarded marker (written only after upstream PR creation succeeds
 * and PR_FILE is overwritten), NOT the ${agent}.upstream-pr file (written early for
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
    ? reviewFilePath(state.peerSyncDir, "plan-review", state.planMergeRound ?? 0, reviewer.name)
    : reviewFilePath(state.peerSyncDir, "review", state.round, reviewer.name);
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

/**
 * Scan the plans directory for individual plan files for a given round
 * (excluding merged files).  Returns the list of filenames and whether
 * the coder's plan is among them.
 */
export function findPlanFiles(
  peerSyncDir: string,
  round: number,
  coderName: string | undefined,
): { files: string[]; coderPlanExists: boolean } {
  const plansDir = join(peerSyncDir, "plans");
  const files: string[] = [];
  let coderPlanExists = false;
  try {
    for (const f of readdirSync(plansDir)) {
      const parsed = parsePlanFilename(f);
      if (parsed && parsed.type === "plan" && parsed.round === round) {
        files.push(f);
        if (coderName && parsed.agentName === coderName) coderPlanExists = true;
      }
    }
  } catch {
    // plans dir may not exist yet
  }
  return { files, coderPlanExists };
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
        // Skip plan-merge when only the coder plan exists (reviewer didn't
        // produce a plan).  If only the reviewer's plan exists we must still enter
        // plan-merge so the coder gets a chance to process it — skipping would have the
        // reviewer effectively review their own plan.
        const coder = state.agents.find((a) => a.role === "coder");
        const { files: planFiles, coderPlanExists } = findPlanFiles(
          state.peerSyncDir, state.round, coder?.name,
        );
        // Only skip plan-merge when there's exactly one plan and it's the coder's.
        if (planFiles.length < 2 && coderPlanExists) return "plan-review";
        return "plan-merge";
      }
      return null;

    case "plan-merge":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "plan-review";
      return null;

    case "plan-review": {
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      // Honour the reviewer's verdict and loop back to plan-merge on
      // REQUEST_CHANGES (up to 3 iterations total before forcing forward to work).
      const planVerdict = pairReviewVerdict(state);
      if (planVerdict === "request_changes" && (state.planMergeRound ?? 0) < 3) {
        return "plan-merge";
      }
      return "work";
    }

    case "work":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) {
        if (isPairBailedOut(state)) return "done";
        return "review";
      }
      return null;

    case "review":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (isPairBailedOut(state)) return "done";
      {
        const reviewVerdict = pairReviewVerdict(state);
        if (reviewVerdict === "request_changes") return "work";
      }
      return "update-docs";

    case "update-docs":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (isPairBailedOut(state)) return "done";
      if (hasAnyPr(state)) return "pr-comments";
      return "pr-create";

    case "pr-create":
      // NOTE: Runner verifies PR exists on GitHub before agents reach done state here.
      // See verifyPhaseOutcome() in runner.ts.
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (!hasAnyPr(state)) return null; // Block advancement without a PR URL (defense in depth)
      return "pr-comments";

    case "pr-comments": {
      if (isMerged(state)) return "suggest-refactor";

      // Hierarchical duo: cross-slot merge coordination.
      // Lower-numbered slot (coordinator) triggers merge after both slots have PRs.
      // Higher-numbered slot waits until coordinator reaches done.
      if (state.duoPeerSlot != null) {
        if (isMergeCoordinator(state) && bothSlotsReadyForMerge(state)) {
          return "merge-vote";
        }
        const peer = readDuoPeerState(state);
        if (peer?.peerDone) return "done";
        return null;
      }

      // Upstream forwarding is pair-mode only. Suppressed for hierarchical-duo slots
      // (duoPeerSlot != null) because cross-slot merge doesn't compose with upstream forwarding.
      const hasUpstream = !!state.upstreamRepo && state.duoPeerSlot == null;
      const forwarded = hasUpstream && hasForwardedPr(state);

      if (hasUpstream && !forwarded) {
        // Monitoring working repo PR — transition to forward-pr on quiet period
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
        if (hasUpstreamMergedMarker(state)) return "final-merge";
        return null;
      }

      // Shortcut: coder has responded to PR comments — skip quiet period wait.
      // Gated on prCommentsQuietSince (a fresh poll found no new comments after
      // the last redispatch) so late reviewer comments are not skipped.
      // Also blocked while Codex review deferral is unresolved.
      if (
        state.prCommentsCoderDispatched
        && hasAnyPr(state)
        && allAgentsDone(state)
        && state.prCommentsQuietSince
        && !state.prCodexReviewDeferredSince
      ) {
        return "final-merge";
      }

      // No upstream: quiet period is the fallback advancement mechanism
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
      // See verifyPhaseOutcome() in runner.ts.
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "suggest-refactor";
      return null;

    case "done":
      return "done";
  }
}
