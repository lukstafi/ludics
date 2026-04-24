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
  | "final-merge"
  | "done";

export type PhaseCategory = "pre-plan" | "planning" | "main-loop" | "pr" | "merge" | "post-merge" | "terminal";

export interface TransitionRule {
  from: Phase;
  to: Phase;
  condition: (state: OrchestrationState) => boolean;
}

export const PHASE_CATEGORIES: Record<Phase, PhaseCategory> = {
  setup: "pre-plan",
  gather: "pre-plan",
  clarify: "pre-plan",
  pushback: "pre-plan",
  plan: "planning",
  "plan-merge": "planning",
  "plan-review": "planning",
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

/**
 * Return the path of the required artifact for this phase/agent, or null if
 * the phase has no required file artifact.  When a non-null path is returned,
 * `isAgentDone()` will NOT treat the agent as done until the file exists.
 */
export function requiredArtifactPath(state: OrchestrationState, agent: AgentConfig): string | null {
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
  // Solo mode: only the coder participates, in every non-setup/done phase.
  // No reviewer agent exists; reviewer-keyed role checks must return false.
  if (state.mode === "solo") return agent.role === "coder";
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
  // Bail-out statuses bypass artifact validation when the bail-out contract is
  // satisfied for the current mode: pair requires coder=bail-out +
  // reviewer=bail-out-confirmed; solo requires a lone coder=bail-out. A lone
  // bail-out-confirmed without the coder side must not skip artifact checks.
  if ((runtime.status === "bail-out" || runtime.status === "bail-out-confirmed") && isBailedOut(state)) return true;
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

/** True when a solo-mode slot's coder has signaled bail-out. Solo has no reviewer,
 * so a lone "bail-out" is the terminal signal (no bail-out-confirmed partner). */
export function isSoloBailedOut(state: OrchestrationState): boolean {
  if (state.mode !== "solo") return false;
  const coder = state.agents.find(a => a.role === "coder");
  if (!coder) return false;
  return (state.agentStates[coder.name]?.status ?? "") === "bail-out";
}

/** Unified bail-out check covering both pair and solo contracts. Pair requires the
 * full two-agent handshake; solo treats a lone coder "bail-out" as terminal. */
export function isBailedOut(state: OrchestrationState): boolean {
  return isPairBailedOut(state) || isSoloBailedOut(state);
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

  // Line-1-wins (issue #346): reviewer templates prescribe the verdict token
  // on the first non-blank line. Trusting line 1 prevents prose further down
  // that happens to mention REQUEST_CHANGES (quoted template text, filenames,
  // consequence descriptions) from overriding an APPROVE verdict.
  const headerOnlyLine = /^\s*(?:#{1,6}\s*VERDICT\s*:?\s*|\*\*\s*VERDICT\s*\*\*\s*:?\s*)$/;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (headerOnlyLine.test(line)) continue;
    const stripped = line.replace(/^[`*\s]+/, "").replace(/[`*\s.:;,!?]+$/, "");
    const tokenMatch = stripped.match(/^(APPROVE|REQUEST_CHANGES)\b/);
    if (tokenMatch) {
      return tokenMatch[1] === "APPROVE" ? "approve" : "request_changes";
    }
    break; // first verdict-bearing line reached; fall through to safety-net regex
  }

  // Fallback (silent safety net) for unusual layouts where the verdict token
  // isn't on line 1. Vulnerable to prose contamination, so only consulted when
  // line-1 detection above did not recognize a token.
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

/**
 * Shared readiness check for `pr-comments → final-merge` in the non-upstream,
 * non-duo-peer path. Extracted so the pair/duo main switch and the solo
 * dispatcher cannot drift apart.
 */
export function prCommentsReadyForFinalMerge(state: OrchestrationState): boolean {
  if (!hasAnyPr(state)) return false;

  // Shortcut: coder has responded to PR comments — skip quiet period wait.
  if (
    state.prCommentsCoderDispatched
    && allAgentsDone(state)
    && state.prCommentsQuietSince
    && !state.prCodexReviewDeferredSince
  ) {
    return true;
  }

  // Quiet-period advancement.
  const quietPeriod = state.config.prCommentsTimeout;
  if (
    state.prCommentsQuietSince
    && nowEpoch() - state.prCommentsQuietSince >= quietPeriod
  ) {
    return true;
  }

  return phaseTimeoutExpired(state);
}

/**
 * Solo-mode transition dispatcher. Traverses a strict subset of `Phase`:
 * setup → work → [update-docs?] → pr-create → pr-comments → final-merge → done.
 * No reviewer participates; bail-out is the lone coder status signal.
 * Phases outside this subset are unreachable in solo mode.
 */
function evaluateTransitionSolo(state: OrchestrationState): Phase | null {
  // Bail-out short-circuits to done from any non-terminal solo phase.
  if (isBailedOut(state) && state.phase !== "done") return "done";

  switch (state.phase) {
    case "setup":
      return "work";

    case "work":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (hasAnyPr(state)) return "pr-comments";
      return "update-docs";

    case "update-docs":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (hasAnyPr(state)) return "pr-comments";
      return "pr-create";

    case "pr-create":
      if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
      if (!hasAnyPr(state)) return null; // defense-in-depth: need a PR URL
      return "pr-comments";

    case "pr-comments":
      // Solo skips suggest-refactor; a pre-merged agent goes straight to done.
      if (isMerged(state)) return "done";
      if (prCommentsReadyForFinalMerge(state)) return "final-merge";
      return null;

    case "final-merge":
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "done";
      return null;

    case "done":
      return "done";

    default:
      // Defensive: solo should never visit review/plan/merge/gather/etc.
      return null;
  }
}

/**
 * Phases that short-circuit to `"done"` when the pair bail-out handshake is
 * confirmed. Behaviour-preserving: this is the exact set that previously had
 * an inline `if (isBailedOut(state)) return "done";` check in its case
 * branch. Phases outside the set either run their own coordination logic
 * (pr-comments, merge-*, final-merge) or can't reach a bail-out handshake
 * (pre-work phases), so they must not short-circuit.
 */
const PAIR_BAIL_OUT_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "work", "review", "update-docs", "pr-create",
]);

export function evaluateTransition(state: OrchestrationState): Phase | null {
  if (state.mode === "solo") return evaluateTransitionSolo(state);

  // Cache readiness once. `phaseTimeoutExpired` reads `nowEpoch()`, so
  // evaluating it separately in the hoisted check and in each allowlisted
  // case branch can flip within a single `evaluateTransition` call — the
  // hoisted `"done"` path would be skipped while the branch still advanced,
  // regressing the pre-refactor single-check behaviour.
  const ready = allAgentsDone(state) || phaseTimeoutExpired(state);

  // Hoisted pair-mode bail-out short-circuit. Gated on the allowlist AND the
  // readiness guard: the coder may still be running when the reviewer
  // confirms, so we wait for allAgentsDone (or a phase timeout) before
  // advancing to done.
  if (PAIR_BAIL_OUT_PHASES.has(state.phase) && ready && isBailedOut(state)) {
    return "done";
  }

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
      // Bail-out short-circuit handled by hoisted check above.
      // Use cached `ready` so the hoist and this branch agree.
      if (ready) return "review";
      return null;

    case "review":
      // Bail-out short-circuit handled by hoisted check above.
      if (!ready) return null;
      {
        const reviewVerdict = pairReviewVerdict(state);
        if (reviewVerdict === "request_changes") return "work";
      }
      return "update-docs";

    case "update-docs":
      // Bail-out short-circuit handled by hoisted check above.
      if (!ready) return null;
      if (hasAnyPr(state)) return "pr-comments";
      return "pr-create";

    case "pr-create":
      // NOTE: Runner verifies PR exists on GitHub before agents reach done state here.
      // See verifyPhaseOutcome() in runner.ts.
      // Bail-out short-circuit handled by hoisted check above.
      if (!ready) return null;
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

      // Quiet period is the fallback advancement mechanism — applies uniformly
      // regardless of whether the project has `upstream_repo` configured.
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

    case "final-merge":
      // NOTE: Runner verifies PR is merged on GitHub before agents reach done state here.
      // See verifyPhaseOutcome() in runner.ts.
      if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "suggest-refactor";
      return null;

    case "done":
      return "done";
  }
}
