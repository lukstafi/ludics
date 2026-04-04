import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { assertRepoRelativeProposalPath, readFrontmatterField } from "../adapters/task-launch.ts";
import { findProjectConfig, harnessDir, ludicsRoot } from "../config.ts";
import type { Phase } from "./phases.ts";
import { parseReviewFilename, reviewFilePath } from "./review-files.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { readMergeVotes } from "./merge.ts";
import { readDuoPeerState } from "./cross-slot.ts";

function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").trim() || null;
}

/** Scan reviews/ for the highest-numbered review file from a given peer.
 *  Handles crash restarts where the round counter was reset but old files persist. */
function findLatestReview(peerSyncDir: string, peerName: string): string | null {
  const reviewsDir = join(peerSyncDir, "reviews");
  if (!existsSync(reviewsDir)) return null;
  let maxRound = -1;
  let maxFile: string | null = null;
  for (const entry of readdirSync(reviewsDir)) {
    const parsed = parseReviewFilename(entry);
    if (parsed && parsed.type === "review" && parsed.agentName === peerName) {
      if (parsed.round > maxRound) { maxRound = parsed.round; maxFile = join(reviewsDir, entry); }
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
 *  Requires repo-relative input; throws on absolute/home-relative/traversal paths. */
function resolveProposalAbsPath(projectDir: string, rawPath: string): string {
  assertRepoRelativeProposalPath(rawPath);
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
  if (!taskId) return state.slotTitle?.trim() || state.taskId;
  const title = state.slotTitle?.trim() || state.taskId;
  const path = join(harnessDir(), "tasks", `${taskId}.md`);
  const content = readFileIfExists(path);
  const proposalValue = (content ? readFrontmatterField(content, "proposal") : null) ?? "";
  const proposalRef =
    proposalValue && proposalValue !== "inline"
      ? proposalValue
      : "";
  const proposalLine = proposalRef
    ? `\nProposal file: \`${proposalRef}\` — re-read if you need to verify scope or acceptance criteria.`
    : "";
  return `**Task** ${taskId}: ${title}${proposalLine}\n(Full task spec was provided in round 1 — refer to earlier context.)`;
}

function taskSpecText(state: OrchestrationState): string {
  const taskId = state.taskId?.trim();
  if (!taskId) {
    return state.slotTitle?.trim() || state.taskId;
  }
  const path = join(harnessDir(), "tasks", `${taskId}.md`);
  const content = readFileIfExists(path);
  if (!content) return taskId;

  // When proposal is a file path, append a pointer + summary rather than inlining content.
  const proposalValue = readFrontmatterField(content, "proposal");
  if (proposalValue) {
    if (proposalValue !== "inline") {
      let proposalFile: string;
      try {
        proposalFile = resolveProposalAbsPath(state.projectDir, proposalValue);
      } catch (err) {
        console.error(`ludics: taskSpecText: ignoring bad proposal path: ${(err as Error).message}`);
        // Fall through to legacy/inline path below.
        proposalFile = "";
      }
      if (proposalFile) {
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
  staging?: boolean,
): string {
  const root = templateRoot();
  // Staging-aware resolution: check staging-specific templates first when staging is active.
  // Priority: pair-<role>-staging-<phase>.md > staging-<phase>.md > pair-<role>-<phase>.md > <phase>.md
  if (staging) {
    if (mode === "pair" && role) {
      const stagingRolePath = join(root, `pair-${role}-staging-${phase}.md`);
      if (existsSync(stagingRolePath)) return stagingRolePath;
    }
    const stagingPath = join(root, `staging-${phase}.md`);
    if (existsSync(stagingPath)) return stagingPath;
  }
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
    ? reviewFilePath(state.peerSyncDir, "plan-review", planMergeRound, agent.name)
    : reviewFilePath(state.peerSyncDir, "review", state.round, agent.name);

  // In plan-review the reviewer reads the merged plan produced by the coder in plan-merge.
  const peerPlan = state.phase === "plan-review"
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
        reviewFilePath(state.peerSyncDir, "plan-review", planMergeRound - 1, peer.name),
      );
    }
    return (state.round > 1
        ? readFileIfExists(reviewFilePath(state.peerSyncDir, "review", state.round - 1, peer.name))
        : null)
      ?? readFileIfExists(reviewFilePath(state.peerSyncDir, "review", state.round, peer.name))
      ?? findLatestReview(state.peerSyncDir, peer.name);
  })();
  const mergeVotes = Object.entries(readMergeVotes(state.peerSyncDir, state.mergeRound))
    .map(([name, vote]) => `${name}: ${vote}`)
    .join("\n");
  const _projectEntry = findProjectConfig(state.projectDir);
  // Staging is suppressed for hierarchical-duo slots (duoPeerSlot set) because the
  // cross-slot winner-selection flow doesn't compose with staging→upstream forwarding.
  const stagingRepo = state.duoPeerSlot == null ? (_projectEntry?.staging_repo ?? null) : null;

  // Extract proposal path from task frontmatter for templates that need just a reference
  const _taskPath = state.taskId ? join(harnessDir(), "tasks", `${state.taskId}.md`) : null;
  const _taskContent = _taskPath ? readFileIfExists(_taskPath) : null;
  const _proposalPath = (_taskContent ? readFrontmatterField(_taskContent, "proposal") : null) ?? "";
  const proposalPath = _proposalPath && _proposalPath !== "inline"
    ? _proposalPath : "";

  const result: Record<string, string> = {
    PHASE: state.phase,
    ROUND: String(state.round),
    MODE: state.mode,
    TASK_ID: state.taskId,
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
      ? readFileIfExists(reviewFilePath(state.peerSyncDir, "review", state.round - 1, peer.name))
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
    STAGING_PR_FILE: join(state.peerSyncDir, `${agent.name}.staging-pr`),
    UPSTREAM_MERGED_MARKER_FILE: join(state.peerSyncDir, `${agent.name}.upstream-merged`),
    FORWARDED_MARKER_FILE: join(state.peerSyncDir, `${agent.name}.forwarded`),
    PEER_SYNC_DIR: state.peerSyncDir,
    DONE_STATUS: doneStatusForPhase(state.phase),
    VERIFICATION_CONTEXT: state.phaseRetryContext
      ? `> **RETRY — Previous attempt failed**: ${state.phaseRetryContext}\n> This is attempt ${
          (state.phase === "pr-create"
            ? (state.prCreateVerifyAttempts ?? 0)
            : (state.finalMergeVerifyAttempts ?? 0)) + 1
        } of 3.\n`
      : "",
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

  // Cross-slot context for hierarchical-duo merge phases
  if (state.duoPeerSlot != null) {
    const peerState = readDuoPeerState(state);
    result.PEER_SLOT = String(state.duoPeerSlot);
    result.PEER_PR_URL = peerState?.peerPrUrl ?? "";
    result.PEER_BRANCH = peerState?.peerBranch ?? "";
    result.PEER_PEER_SYNC_DIR = peerState?.peerPeerSyncDir ?? "";
  }

  return result;
}

export function substituteTemplate(template: string, values: Record<string, string>): string {
  // Phase 1: process conditional blocks {{#IF VAR}}...{{/IF}}
  // Process innermost (leaf) blocks first, repeat until no more conditionals remain.
  // The body must not contain another {{#IF to ensure inside-out evaluation.
  let result = template;
  const leafIf = /\{\{#IF\s+([A-Z0-9_]+)\}\}((?:(?!\{\{#IF\s)[\s\S])*?)\{\{\/IF\}\}/g;
  while (leafIf.test(result)) {
    result = result.replace(leafIf, (_match, key: string, body: string) => {
      return (values[key] ?? "") !== "" ? body : "";
    });
  }
  // Phase 2: substitute variables
  result = result.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    if (!(key in values)) {
      if (process.env.LUDICS_DEV || process.env.DEBUG) {
        console.error(`ludics: template warning: unknown variable {{${key}}}`);
      }
    }
    return values[key] ?? "";
  });
  return result;
}

async function magTailorSkill(message: string): Promise<string> {
  return message;
}

export async function composeSkillMessage(
  state: OrchestrationState,
  agent: AgentConfig,
  templateOverride?: string,
): Promise<string> {
  const context = buildSkillContext(state, agent);
  const isStaging = !!state.stagingRepo && state.duoPeerSlot == null;
  const templatePath = templateOverride
    ?? resolveTemplatePath(state.phase, state.mode, agent.role, isStaging);
  const template = readFileSync(templatePath, "utf-8");
  let message = substituteTemplate(template, context);
  if (state.config.useMagTailoring) {
    message = await magTailorSkill(message);
  }
  return message;
}
