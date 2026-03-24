import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { harnessDir, ludicsRoot } from "../config.ts";
import type { Phase } from "./phases.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { readMergeVotes } from "./merge.ts";

export interface SkillContext {
  phase: Phase;
  round: number;
  mode: "duo" | "pair";
  feature: string;
  agent: AgentConfig;
  peer: AgentConfig | null;
  taskSpec: string;
  peerReview: string | null;
  peerStatus: string | null;
  peerPlan: string | null;
  gitDiffStat: string | null;
  previousRoundSummary: string | null;
  mergeVotes: string | null;
  worktreePath: string;
  peerWorktreePath: string | null;
  statusFile: string;
  planFile: string;
  reviewFile: string;
  prFile: string;
  interruptFile: string;
  mergeVoteFile: string;
  suggestRefactorFile: string;
  workflowFeedbackFile: string;
  mergeReviewDecisionFile: string;
  mergedMarkerFile: string;
  mergedPlanFile: string;
  planMergeRound: number;
  peerSyncDir: string;
  doneStatus: string;
}

function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").trim() || null;
}

/** Scan reviews/ for the highest-numbered review file from a given peer.
 *  Handles crash restarts where the round counter was reset but old files persist. */
function findLatestReview(peerSyncDir: string, peerName: string): string | null {
  const reviewsDir = join(peerSyncDir, "reviews");
  if (!existsSync(reviewsDir)) return null;
  const pattern = new RegExp(`^round-(\\d+)-${peerName}\\.md$`);
  let maxRound = -1;
  let maxFile: string | null = null;
  for (const entry of readdirSync(reviewsDir)) {
    const m = entry.match(pattern);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > maxRound) { maxRound = n; maxFile = join(reviewsDir, entry); }
    }
  }
  return maxFile ? readFileIfExists(maxFile) : null;
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      env: process.env as Record<string, string>,
    });
    if (result.exitCode !== 0) return null;
    const out = result.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function doneStatusForPhase(phase: Phase): string {
  if (phase === "work") return "done";
  if (phase === "review") return "review-done";
  return `${phase}-done`;
}

function ghIssueBody(repo: string, issue: string): string | null {
  try {
    const result = Bun.spawnSync(
      ["gh", "issue", "view", issue, "--repo", repo, "--json", "body", "-q", ".body"],
      { stdout: "pipe", stderr: "ignore", env: process.env as Record<string, string> },
    );
    if (result.exitCode !== 0) return null;
    const body = result.stdout.toString().trim();
    return body || null;
  } catch {
    return null;
  }
}

function taskSpecText(state: OrchestrationState): string {
  const taskId = state.taskId?.trim();
  if (!taskId) {
    return state.slotTitle?.trim() || state.feature;
  }
  const path = join(harnessDir(), "tasks", `${taskId}.md`);
  const content = readFileIfExists(path);
  if (!content) return taskId;

  // Try to extract and append GitHub issue body
  const urlMatch = content.match(/^url:\s*"?https:\/\/github\.com\/([^/\s"]+\/[^/\s"]+)\/issues\/(\d+)"?/m);
  if (urlMatch) {
    const issueBody = ghIssueBody(urlMatch[1]!, urlMatch[2]!);
    if (issueBody) {
      return `${content}\n\n---\n## GitHub Issue Body\n\n${issueBody}`;
    }
  }
  return content;
}

function templateRoot(): string {
  return join(ludicsRoot(), "skills", "orchestration");
}

export function resolveTemplatePath(
  phase: Phase,
  mode: "duo" | "pair",
  role?: "coder" | "reviewer",
): string {
  const root = templateRoot();
  if (mode === "pair" && role) {
    const rolePath = join(root, `pair-${role}-${phase}.md`);
    if (existsSync(rolePath)) return rolePath;
  }
  const genericPath = join(root, `${phase}.md`);
  if (existsSync(genericPath)) return genericPath;
  throw new Error(`missing orchestration template for ${mode}:${role ?? "agent"}:${phase}`);
}

export function buildSkillContext(
  state: OrchestrationState,
  agent: AgentConfig,
): SkillContext {
  const peer = state.agents.find((candidate) => candidate.name !== agent.name) ?? null;
  const planFile = join(state.peerSyncDir, "plans", `round-${state.round}-${agent.name}.md`);
  const planMergeRound = state.planMergeRound ?? 0;
  // Key the merged plan file by planMergeRound so each retry iteration writes a fresh file,
  // preventing a stale merged plan from satisfying the artifact gate in later iterations.
  const mergedPlanFile = join(state.peerSyncDir, "plans", `round-${state.round}-merged-${planMergeRound}.md`);

  // plan-review uses per-iteration review files to avoid stale verdicts from a prior loop.
  const reviewFile = state.phase === "plan-review"
    ? join(state.peerSyncDir, "reviews", `plan-merge-${planMergeRound}-${agent.name}.md`)
    : join(state.peerSyncDir, "reviews", `round-${state.round}-${agent.name}.md`);

  // In pair plan-review the reviewer reads the merged plan produced by the coder in plan-merge.
  // In duo plan-review (no plan-merge phase) each agent reviews the other's independent plan.
  const peerPlan = state.phase === "plan-review" && state.mode === "pair"
    ? readFileIfExists(mergedPlanFile)
    : peer
      ? readFileIfExists(join(state.peerSyncDir, "plans", `round-${state.round}-${peer.name}.md`))
      : null;

  // In plan-merge (iteration > 0) the coder reads the reviewer's feedback from the previous round.
  // For other phases, use the previous round's review with findLatestReview fallback for crash restarts.
  const peerReview = (() => {
    if (!peer) return null;
    if (state.phase === "plan-merge") {
      if (planMergeRound === 0) return null; // first iteration: no prior review
      return readFileIfExists(
        join(state.peerSyncDir, "reviews", `plan-merge-${planMergeRound - 1}-${peer.name}.md`),
      );
    }
    return (state.round > 1
        ? readFileIfExists(join(state.peerSyncDir, "reviews", `round-${state.round - 1}-${peer.name}.md`))
        : null)
      ?? readFileIfExists(join(state.peerSyncDir, "reviews", `round-${state.round}-${peer.name}.md`))
      ?? findLatestReview(state.peerSyncDir, peer.name);
  })();
  const mergeVotes = Object.entries(readMergeVotes(state.peerSyncDir, state.mergeRound))
    .map(([name, vote]) => `${name}: ${vote}`)
    .join("\n");
  return {
    phase: state.phase,
    round: state.round,
    mode: state.mode,
    feature: state.feature,
    agent,
    peer,
    taskSpec: taskSpecText(state),
    peerReview,
    peerStatus: peer ? state.agentStates[peer.name]?.status ?? null : null,
    peerPlan,
    gitDiffStat: gitOutput(agent.worktreePath, ["diff", "--stat"]),
    previousRoundSummary: state.round > 1 && peer
      ? readFileIfExists(join(state.peerSyncDir, "reviews", `round-${state.round - 1}-${peer.name}.md`))
      : null,
    mergeVotes: mergeVotes || null,
    worktreePath: agent.worktreePath,
    peerWorktreePath: peer?.worktreePath ?? null,
    statusFile: join(state.peerSyncDir, `${agent.name}.status`),
    planFile,
    mergedPlanFile,
    planMergeRound,
    reviewFile,
    prFile: join(state.peerSyncDir, `${agent.name}.pr`),
    interruptFile: join(state.peerSyncDir, `${agent.name}.interrupt`),
    mergeVoteFile: join(state.peerSyncDir, "merge-votes", `round-${state.mergeRound}-${agent.name}.txt`),
    suggestRefactorFile: join(state.peerSyncDir, `suggest-refactor-${agent.name}.md`),
    workflowFeedbackFile: join(state.peerSyncDir, `workflow-feedback-${agent.name}.md`),
    mergeReviewDecisionFile: join(state.peerSyncDir, "merge-review-approval.txt"),
    mergedMarkerFile: join(state.peerSyncDir, `${agent.name}.merged`),
    peerSyncDir: state.peerSyncDir,
    doneStatus: doneStatusForPhase(state.phase),
  };
}

export function substituteTemplate(template: string, ctx: SkillContext): string {
  const values: Record<string, string> = {
    PHASE: ctx.phase,
    ROUND: String(ctx.round),
    MODE: ctx.mode,
    FEATURE: ctx.feature,
    AGENT_NAME: ctx.agent.name,
    AGENT_PROVIDER: ctx.agent.provider,
    AGENT_ROLE: ctx.agent.role ?? "agent",
    PEER_NAME: ctx.peer?.name ?? "none",
    PEER_PROVIDER: ctx.peer?.provider ?? "none",
    TASK_SPEC: ctx.taskSpec,
    PEER_REVIEW: ctx.peerReview ?? "(no review yet)",
    PEER_STATUS: ctx.peerStatus ?? "unknown",
    PEER_PLAN: ctx.peerPlan ?? "(no plan yet)",
    GIT_DIFF_STAT: ctx.gitDiffStat ?? "(no changes yet)",
    PREVIOUS_ROUND_SUMMARY: ctx.previousRoundSummary ?? "(no previous round summary)",
    MERGE_VOTES: ctx.mergeVotes ?? "(no merge votes yet)",
    WORKTREE_PATH: ctx.worktreePath,
    PEER_WORKTREE_PATH: ctx.peerWorktreePath ?? "(no peer worktree)",
    STATUS_FILE: ctx.statusFile,
    PLAN_FILE: ctx.planFile,
    MERGED_PLAN_FILE: ctx.mergedPlanFile,
    PLAN_MERGE_ROUND: String(ctx.planMergeRound),
    REVIEW_FILE: ctx.reviewFile,
    PR_FILE: ctx.prFile,
    INTERRUPT_FILE: ctx.interruptFile,
    MERGE_VOTE_FILE: ctx.mergeVoteFile,
    SUGGEST_REFACTOR_FILE: ctx.suggestRefactorFile,
    WORKFLOW_FEEDBACK_FILE: ctx.workflowFeedbackFile,
    MERGE_REVIEW_DECISION_FILE: ctx.mergeReviewDecisionFile,
    MERGED_MARKER_FILE: ctx.mergedMarkerFile,
    PEER_SYNC_DIR: ctx.peerSyncDir,
    DONE_STATUS: ctx.doneStatus,
  };
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}

async function magTailorSkill(message: string): Promise<string> {
  return message;
}

export async function composeSkillMessage(
  state: OrchestrationState,
  agent: AgentConfig,
): Promise<string> {
  const context = buildSkillContext(state, agent);
  const templatePath = resolveTemplatePath(state.phase, state.mode, agent.role);
  const template = readFileSync(templatePath, "utf-8");
  let message = substituteTemplate(template, context);
  if (state.config.useMagTailoring) {
    message = await magTailorSkill(message);
  }
  return message;
}
