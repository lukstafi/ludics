import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { findProjectConfig, harnessDir, ludicsRoot } from "../config.ts";
import type { Phase } from "./phases.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { readMergeVotes } from "./merge.ts";

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

/** Resolve a proposal frontmatter value to an absolute filesystem path.
 *  Handles ~/..., absolute paths, and project-relative paths. */
function resolveProposalAbsPath(projectDir: string, rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return join(process.env.HOME ?? "~", rawPath.slice(2));
  }
  if (rawPath.startsWith("/")) return rawPath;
  return join(projectDir, rawPath);
}

/** Extract the first paragraph under ## Motivation from a proposal file.
 *  Falls back to the first non-empty non-heading paragraph in the file.
 *  Returns null if the file can't be read or yields no usable text. */
function extractProposalSummary(proposalFile: string): string | null {
  const text = readFileIfExists(proposalFile);
  if (!text) return null;
  const motivIdx = text.search(/^## Motivation/m);
  const src = motivIdx >= 0 ? text.slice(motivIdx + "## Motivation".length) : text;
  const para = src.split(/\n\n+/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
  return para ? para.replace(/\n/g, " ").slice(0, 300) : null;
}

function taskSpecBriefText(state: OrchestrationState): string {
  const taskId = state.taskId?.trim();
  if (!taskId) return state.slotTitle?.trim() || state.feature;
  const title = state.slotTitle?.trim() || state.feature;
  const path = join(harnessDir(), "tasks", `${taskId}.md`);
  const content = readFileIfExists(path);
  const proposalMatch = content?.match(/^proposal:\s*(.+)$/m);
  const proposalValue = proposalMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const proposalRef =
    proposalValue && proposalValue !== "inline" && proposalValue.toLowerCase() !== "null"
      ? proposalValue
      : "";
  const proposalLine = proposalRef
    ? `\nProposal file: \`${proposalRef}\` (already read in round 1)`
    : "";
  return `**Task** ${taskId}: ${title}${proposalLine}\n(Full task spec was provided in round 1 — refer to earlier context.)`;
}

function taskSpecText(state: OrchestrationState): string {
  const taskId = state.taskId?.trim();
  if (!taskId) {
    return state.slotTitle?.trim() || state.feature;
  }
  const path = join(harnessDir(), "tasks", `${taskId}.md`);
  const content = readFileIfExists(path);
  if (!content) return taskId;

  // When proposal is a file path, append a pointer + summary rather than inlining content.
  const proposalMatch = content.match(/^proposal:\s*(.+)$/m);
  if (proposalMatch) {
    const proposalValue = proposalMatch[1]!.trim().replace(/^["']|["']$/g, "");
    if (proposalValue && proposalValue !== "inline" && proposalValue.toLowerCase() !== "null") {
      const proposalFile = resolveProposalAbsPath(state.projectDir, proposalValue);
      // Only read proposal file contents if it is inside the project tree, to avoid
      // exposing arbitrary local file content through the Proposal summary line.
      const projectRoot = state.projectDir.endsWith("/") ? state.projectDir : `${state.projectDir}/`;
      const isInProjectTree = proposalFile.startsWith(projectRoot);
      const summary = isInProjectTree ? extractProposalSummary(proposalFile) : null;
      const summaryLine = summary ? `Proposal summary: ${summary}\n` : "";
      const contentWithPointer =
        `${content}\n\n---\n${summaryLine}Read the full proposal at \`${proposalValue}\` in the project repo.\n`;

      const urlMatch = contentWithPointer.match(
        /^url:\s*"?https:\/\/github\.com\/([^/\s"]+\/[^/\s"]+)\/issues\/(\d+)"?/m,
      );
      if (urlMatch) {
        const issueBody = ghIssueBody(urlMatch[1]!, urlMatch[2]!);
        if (issueBody) {
          return `${contentWithPointer}\n\n---\n## GitHub Issue Body\n\n${issueBody}`;
        }
      }
      return contentWithPointer;
    }
  }

  // Legacy (proposal: inline) or no proposal: return full content as-is.
  const urlMatch = content.match(
    /^url:\s*"?https:\/\/github\.com\/([^/\s"]+\/[^/\s"]+)\/issues\/(\d+)"?/m,
  );
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
): Record<string, string> {
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
  const _projectEntry = findProjectConfig(state.projectDir);
  const stagingRepo = _projectEntry?.staging_repo ?? null;

  // Extract proposal path from task frontmatter for templates that need just a reference
  const _taskPath = state.taskId ? join(harnessDir(), "tasks", `${state.taskId}.md`) : null;
  const _taskContent = _taskPath ? readFileIfExists(_taskPath) : null;
  const _proposalMatch = _taskContent?.match(/^proposal:\s*(.+)$/m);
  const _proposalPath = _proposalMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const proposalPath = _proposalPath && _proposalPath !== "inline" && _proposalPath.toLowerCase() !== "null"
    ? _proposalPath : "";

  const result: Record<string, string> = {
    PHASE: state.phase,
    ROUND: String(state.round),
    MODE: state.mode,
    FEATURE: state.feature,
    AGENT_NAME: agent.name,
    AGENT_PROVIDER: agent.provider,
    AGENT_ROLE: agent.role ?? "agent",
    PEER_NAME: peer?.name ?? "none",
    PEER_PROVIDER: peer?.provider ?? "none",
    TASK_SPEC: state.round <= 1 ? taskSpecText(state) : taskSpecBriefText(state),
    TASK_SPEC_BRIEF: taskSpecBriefText(state),
    PROPOSAL_PATH: proposalPath,
    PEER_REVIEW: peerReview ?? "(no review yet)",
    PEER_STATUS: peer ? (state.agentStates[peer.name]?.status ?? "unknown") : "unknown",
    PEER_PLAN: peerPlan ?? "(no plan yet)",
    GIT_DIFF_STAT: gitOutput(agent.worktreePath, ["diff", "--stat"]) ?? "(no changes yet)",
    PREVIOUS_ROUND_SUMMARY: (state.round > 1 && peer
      ? readFileIfExists(join(state.peerSyncDir, "reviews", `round-${state.round - 1}-${peer.name}.md`))
      : null) ?? "(no previous round summary)",
    MERGE_VOTES: mergeVotes || "(no merge votes yet)",
    WORKTREE_PATH: agent.worktreePath,
    PEER_WORKTREE_PATH: peer?.worktreePath ?? "(no peer worktree)",
    STATUS_FILE: join(state.peerSyncDir, `${agent.name}.status`),
    PLAN_FILE: planFile,
    MERGED_PLAN_FILE: mergedPlanFile,
    PLAN_MERGE_ROUND: String(planMergeRound),
    REVIEW_FILE: reviewFile,
    PR_FILE: join(state.peerSyncDir, `${agent.name}.pr`),
    INTERRUPT_FILE: join(state.peerSyncDir, `${agent.name}.interrupt`),
    MERGE_VOTE_FILE: join(
      state.peerSyncDir, "merge-votes", `round-${state.mergeRound}-${agent.name}.txt`,
    ),
    SUGGEST_REFACTOR_FILE: join(state.peerSyncDir, `suggest-refactor-${agent.name}.md`),
    WORKFLOW_FEEDBACK_FILE: join(state.peerSyncDir, `workflow-feedback-${agent.name}.md`),
    MERGE_REVIEW_DECISION_FILE: join(state.peerSyncDir, "merge-review-approval.txt"),
    MERGED_MARKER_FILE: join(state.peerSyncDir, `${agent.name}.merged`),
    PEER_SYNC_DIR: state.peerSyncDir,
    DONE_STATUS: doneStatusForPhase(state.phase),
    STAGING_REPO: stagingRepo ?? "",
    STAGING_REPO_NOTE: stagingRepo
      ? `\n> **Staging fork**: This project uses a staging fork (\`${stagingRepo}\`). Create the PR against the staging fork, not the upstream repo.\n`
      : "",
  };

  // Auto-inject project config string fields as PROJECT_<FIELD> variables.
  // Non-string fields (booleans, objects) are skipped to avoid "[object Object]" in templates.
  if (_projectEntry) {
    for (const [key, val] of Object.entries(_projectEntry)) {
      if (typeof val === "string" && val) {
        result[`PROJECT_${key.toUpperCase()}`] = val;
      }
    }
  }

  return result;
}

export function substituteTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    if (!(key in values)) {
      if (process.env.LUDICS_DEV || process.env.DEBUG) {
        console.error(`ludics: template warning: unknown variable {{${key}}}`);
      }
    }
    return values[key] ?? "";
  });
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
