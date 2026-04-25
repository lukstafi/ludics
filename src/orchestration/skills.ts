import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { assertRepoRelativeProposalPath } from "../adapters/task-launch.ts";
import { readFrontmatterField } from "../tasks/markdown.ts";
import { findProjectConfig, harnessDir as defaultHarnessDir, ludicsRoot } from "../config.ts";
import { taskFilePath } from "./paths.ts";
import { safeSyncOutput } from "../spawn.ts";
import { defaultRunGit, detectDefaultBranches } from "../git-runner.ts";
import type { Phase } from "./phases.ts";
import { planFilePath, mergedPlanFilePath } from "./plan-files.ts";
import { parseReviewFilename, reviewFilePath } from "./review-files.ts";
import type { AgentConfig, OrchestrationState } from "./state.ts";
import { readMergeVotes } from "./merge.ts";
import { mergeVoteFilePath } from "./merge-vote-files.ts";
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
  const r = safeSyncOutput(["git", ...args], { cwd });
  return r.ok && r.stdout ? r.stdout : null;
}

const PROPOSAL_FRESHNESS_THRESHOLD = 10;

/** Count commits on the remote default branch (`origin/<default>`) since the
 *  proposal file was last modified, and return a warning when the count exceeds
 *  PROPOSAL_FRESHNESS_THRESHOLD. Returns "" on any failure (bad path, untracked
 *  file, non-git dir, no `origin` default branch, proposal commit not an
 *  ancestor of `origin/<default>`, parse failure) — must never block
 *  orchestration. The count reflects upstream drift on the default branch, not
 *  feature-branch churn, so orchestration worktrees checked out on
 *  `ludics/.../root` branches still report the intended signal. Freshness of
 *  `refs/remotes/origin/<default>` is delegated to callers that run
 *  `git fetch origin` ahead of orchestration rounds. */
function proposalFreshnessWarning(projectDir: string, proposalPath: string): string {
  if (!proposalPath || proposalPath === "inline") return "";
  try {
    assertRepoRelativeProposalPath(proposalPath);
  } catch {
    return "";
  }
  const hash = gitOutput(projectDir, ["log", "-1", "--format=%H", "--", proposalPath]);
  if (!hash) return "";
  const { origin } = detectDefaultBranches(projectDir, defaultRunGit);
  if (!origin) return "";
  const ref = `refs/remotes/origin/${origin}`;
  const isAncestor = safeSyncOutput(["git", "merge-base", "--is-ancestor", hash, ref], { cwd: projectDir });
  if (isAncestor.exitCode !== 0) return "";
  const countStr = gitOutput(projectDir, ["rev-list", "--count", `${hash}..${ref}`]);
  if (!countStr) return "";
  const count = Number.parseInt(countStr, 10);
  if (Number.isNaN(count)) return "";
  if (count <= PROPOSAL_FRESHNESS_THRESHOLD) return "";
  return `\n\n> **Freshness warning**: ${count} commits have landed in this repo since the proposal file was last updated. The codebase may have drifted — when applying the Code-Proposal Alignment Checklist, re-verify every file path, symbol, and behaviour claim against the current source rather than trusting the proposal text.`;
}

export function doneStatusForPhase(phase: Phase): string {
  if (phase === "work") return "done";
  if (phase === "review") return "review-done";
  return `${phase}-done`;
}

function ghIssueBody(repo: string, issue: string): string | null {
  const r = safeSyncOutput(
    ["gh", "issue", "view", issue, "--repo", repo, "--json", "body", "-q", ".body"],
  );
  return r.ok && r.stdout ? r.stdout : null;
}

/** Resolve a proposal frontmatter value to an absolute filesystem path.
 *  Requires repo-relative input; throws on absolute/home-relative/traversal paths. */
function resolveProposalAbsPath(projectDir: string, rawPath: string): string {
  assertRepoRelativeProposalPath(rawPath);
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
  const path = taskFilePath(taskId, state.harnessDir ?? defaultHarnessDir());
  const content = readFileIfExists(path);
  const proposalValue = (content ? readFrontmatterField(content, "proposal") : null) ?? "";
  const proposalRef =
    proposalValue && proposalValue !== "inline" // deprecated sentinel — kept for backward compat
      ? proposalValue
      : "";
  const proposalLine = proposalRef
    ? `\nProposal file: \`${proposalRef}\` — re-read if you need to verify scope or acceptance criteria.`
    : "";
  return `**Task** ${taskId}: ${title}${proposalLine}\n(Full task spec was provided in round 1 — refer to earlier context.)`;
}

/** Append GitHub issue body to content if a `url:` frontmatter field points to a GH issue. */
function appendGhIssueBody(content: string): string {
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

function taskSpecText(state: OrchestrationState): string {
  const taskId = state.taskId?.trim();
  if (!taskId) {
    return state.slotTitle?.trim() || state.taskId;
  }
  const path = taskFilePath(taskId, state.harnessDir ?? defaultHarnessDir());
  const content = readFileIfExists(path);
  if (!content) return taskId;

  // When proposal is a file path, append a pointer + summary rather than inlining content.
  const proposalValue = readFrontmatterField(content, "proposal");
  if (proposalValue) {
    // Deprecated sentinel — kept for backward compat; skip file resolution for inline proposals.
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

        return appendGhIssueBody(contentWithPointer);
      }
    }
  }

  // Legacy (proposal: inline) or no proposal: return full content as-is.
  return appendGhIssueBody(content);
}

/** Extract the body under `## Acceptance Criteria` from tasks/{taskId}.md.
 *  Returns "" when the task file, the section, or the non-placeholder body
 *  is missing. Stops at the next `##` heading or EOF. */
function extractAcceptanceCriteria(
  taskId: string | undefined,
  harnessDir: string = defaultHarnessDir(),
): string {
  if (!taskId) return "";
  const path = taskFilePath(taskId, harnessDir);
  const content = readFileIfExists(path);
  if (!content) return "";
  const headingMatch = content.match(/^##\s+Acceptance Criteria\s*$/m);
  if (!headingMatch || headingMatch.index == null) return "";
  const afterHeading = content.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = afterHeading.match(/\n##\s+/);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  const body = section.trim();
  if (!body) return "";
  // Filter the `- [ ] TBD` placeholder that the task template seeds; if
  // nothing else remains, treat the section as empty so templates can gate
  // cleanly with `{{#IF TASK_AC}}`.
  const leftover = body
    .split("\n")
    .filter((line) => !/^-\s*\[ \]\s*TBD\s*$/i.test(line))
    .join("\n")
    .trim();
  return leftover;
}

function templateRoot(): string {
  return join(ludicsRoot(), "skills", "orchestration");
}

export function resolveTemplatePath(
  phase: Phase,
  mode: "duo" | "pair" | "solo",
  role?: "coder" | "reviewer",
  hasUpstream?: boolean,
): string {
  const root = templateRoot();
  // Solo resolution: solo-<phase>.md > pair-coder-<phase>.md > <phase>.md
  //
  // Solo intentionally ignores `hasUpstream`. The upstream-* templates assume
  // the forward-pr workflow (writing `*.upstream-pr`, `*.forwarded` markers,
  // `*.upstream-merged` etc.) which solo's phase graph never enters —
  // evaluateTransitionSolo does not visit `forward-pr` and does not consult
  // state.upstreamRepo. Picking upstream-final-merge.md here would run the
  // wrong workflow and stall the solo slot.
  if (mode === "solo") {
    const soloPath = join(root, `solo-${phase}.md`);
    if (existsSync(soloPath)) return soloPath;
    const pairCoderPath = join(root, `pair-coder-${phase}.md`);
    if (existsSync(pairCoderPath)) return pairCoderPath;
    const genericPath = join(root, `${phase}.md`);
    if (existsSync(genericPath)) return genericPath;
    throw new Error(`missing orchestration template for solo:${phase}`);
  }
  // Upstream-aware resolution: check upstream-specific templates first when upstream is configured.
  // Priority: pair-<role>-upstream-<phase>.md > upstream-<phase>.md > pair-<role>-<phase>.md > <phase>.md
  if (hasUpstream) {
    if (mode === "pair" && role) {
      const upstreamRolePath = join(root, `pair-${role}-upstream-${phase}.md`);
      if (existsSync(upstreamRolePath)) return upstreamRolePath;
    }
    const upstreamPath = join(root, `upstream-${phase}.md`);
    if (existsSync(upstreamPath)) return upstreamPath;
  }
  if (mode === "pair" && role) {
    const rolePath = join(root, `pair-${role}-${phase}.md`);
    if (existsSync(rolePath)) return rolePath;
  }
  const genericPath = join(root, `${phase}.md`);
  if (existsSync(genericPath)) return genericPath;
  throw new Error(`missing orchestration template for ${mode}:${role ?? "agent"}:${phase}`);
}

/**
 * Keys in `buildSkillContext`'s `result` literal that are guaranteed
 * non-empty at template-substitution time. Templates may use these
 * variables freely inside shell contexts without `{{#IF VAR}}` guards.
 *
 * CI-drift-pair — see `scripts/lint-template-safety.test.ts`
 * "ALWAYS_POPULATED_KEYS drift" describe block: a bidirectional invariant
 * test parses the `result` object literal below and asserts every
 * non-empty-default assignment is in this set, and every key in this set
 * has such an assignment. Maintainers adding a new always-populated key
 * touch only this file (this set + the `result` literal). Empty-default
 * assignments must surface a `?? ""`, `: ""`, or `|| ""` marker on the
 * assignment line so the drift test can classify them correctly.
 */
export const ALWAYS_POPULATED_KEYS: ReadonlySet<string> = new Set([
  "PHASE",
  "ROUND",
  "MODE",
  "TASK_ID",
  "AGENT_NAME",
  "AGENT_PROVIDER",
  "AGENT_ROLE",
  "PEER_NAME",
  "PEER_PROVIDER",
  "TASK_SPEC",
  "TASK_SPEC_BRIEF",
  "PEER_REVIEW",
  "PEER_STATUS",
  "PEER_PLAN",
  "GIT_DIFF_STAT",
  "PREVIOUS_ROUND_SUMMARY",
  "MERGE_VOTES",
  "WORKTREE_PATH",
  "PEER_WORKTREE_PATH",
  "STATUS_FILE",
  "PLAN_FILE",
  "MERGED_PLAN_FILE",
  "PLAN_MERGE_ROUND",
  "REVIEW_FILE",
  "PR_FILE",
  "INTERRUPT_FILE",
  "MERGE_VOTE_FILE",
  "SUGGEST_REFACTOR_FILE",
  "WORKFLOW_FEEDBACK_FILE",
  "MERGE_REVIEW_DECISION_FILE",
  "MERGED_MARKER_FILE",
  "PEER_SYNC_DIR",
  "DONE_STATUS",
]);

export function buildSkillContext(
  state: OrchestrationState,
  agent: AgentConfig,
): Record<string, string> {
  const peer = state.agents.find((candidate) => candidate.name !== agent.name) ?? null;
  const planFile = planFilePath(state.peerSyncDir, state.round, agent.name);
  const planMergeRound = state.planMergeRound ?? 0;
  // Key the merged plan file by planMergeRound so each retry iteration writes a fresh file,
  // preventing a stale merged plan from satisfying the artifact gate in later iterations.
  const mergedPlanFile = mergedPlanFilePath(state.peerSyncDir, state.round, planMergeRound);

  // plan-review uses per-iteration review files to avoid stale verdicts from a prior loop.
  const reviewFile = state.phase === "plan-review"
    ? reviewFilePath(state.peerSyncDir, "plan-review", planMergeRound, agent.name)
    : reviewFilePath(state.peerSyncDir, "review", state.round, agent.name);

  // In plan-review the reviewer reads the merged plan produced by the coder in plan-merge.
  const peerPlan = state.phase === "plan-review"
    ? readFileIfExists(mergedPlanFile)
    : peer
      ? readFileIfExists(planFilePath(state.peerSyncDir, state.round, peer.name))
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
  // Upstream forwarding is suppressed for hierarchical-duo slots (duoPeerSlot set) because the
  // cross-slot winner-selection flow doesn't compose with upstream forwarding.
  const upstreamRepo = state.duoPeerSlot == null ? (_projectEntry?.upstream_repo ?? null) : null;

  // Extract proposal path from task frontmatter for templates that need just a reference
  const stateHarnessDir = state.harnessDir ?? defaultHarnessDir();
  const _taskPath = state.taskId ? taskFilePath(state.taskId, stateHarnessDir) : null;
  const _taskContent = _taskPath ? readFileIfExists(_taskPath) : null;
  const _proposalPath = (_taskContent ? readFrontmatterField(_taskContent, "proposal") : null) ?? "";
  const proposalPath = _proposalPath && _proposalPath !== "inline" // deprecated sentinel — kept for backward compat
    ? _proposalPath : "";
  const proposalFreshnessWarningText = proposalPath
    ? proposalFreshnessWarning(state.projectDir, proposalPath)
    : "";
  const proposalInstruction = proposalPath
    ? `**Step 0**: Read the proposal file at \`${proposalPath}\` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.${proposalFreshnessWarningText}`
    : "";

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
    PROPOSAL_PATH: proposalPath || "",
    PROPOSAL_INSTRUCTION: proposalInstruction || "",
    PROPOSAL_FRESHNESS_WARNING: proposalFreshnessWarningText || "",
    TASK_AC: extractAcceptanceCriteria(state.taskId, stateHarnessDir) || "",
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
    MERGE_VOTE_FILE: mergeVoteFilePath(state.peerSyncDir, state.mergeRound, agent.name),
    SUGGEST_REFACTOR_FILE: join(state.peerSyncDir, `suggest-refactor-${agent.name}.md`),
    WORKFLOW_FEEDBACK_FILE: join(state.peerSyncDir, `workflow-feedback-${agent.name}.md`),
    MERGE_REVIEW_DECISION_FILE: join(state.peerSyncDir, "merge-review-approval.txt"),
    MERGED_MARKER_FILE: join(state.peerSyncDir, `${agent.name}.merged`),
    PEER_SYNC_DIR: state.peerSyncDir,
    DONE_STATUS: doneStatusForPhase(state.phase),
    VERIFICATION_CONTEXT: state.phaseRetryContext
      ? `> **RETRY — Previous attempt failed**: ${state.phaseRetryContext}\n> This is attempt ${
          (state.phase === "pr-create"
            ? (state.prCreateVerifyAttempts ?? 0)
            : (state.finalMergeVerifyAttempts ?? 0)) + 1
        } of 3.\n`
      : "",
    UPSTREAM_REPO: upstreamRepo ?? "",
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
  // Phase 1b: process conditional blocks {{#UNLESS VAR}}...{{/UNLESS}}
  const leafUnless = /\{\{#UNLESS\s+([A-Z0-9_]+)\}\}((?:(?!\{\{#UNLESS\s)[\s\S])*?)\{\{\/UNLESS\}\}/g;
  while (leafUnless.test(result)) {
    result = result.replace(leafUnless, (_match, key: string, body: string) => {
      return (values[key] ?? "") === "" ? body : "";
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
  // `UPSTREAM_REPO` in the context is the config-sourced truth (already duo-suppressed
  // in buildSkillContext). Reading from context avoids a second findProjectConfig call
  // and keeps the hasUpstream flag in lockstep with what templates actually see.
  const hasUpstream = !!context.UPSTREAM_REPO;
  const templatePath = templateOverride
    ?? resolveTemplatePath(state.phase, state.mode, agent.role, hasUpstream);
  const template = readFileSync(templatePath, "utf-8");
  let message = substituteTemplate(template, context);
  if (state.config.useMagTailoring) {
    message = await magTailorSkill(message);
  }
  return message;
}
