import { existsSync, readFileSync } from "fs";
import { join, normalize, resolve } from "path";
import { parseTaskFrontmatter } from "../tasks/markdown.ts";
import { safeSyncOutput } from "../spawn.ts";

/** Throws if `rawPath` is not repo-relative (absolute, home-relative, or escapes tree). */
export function assertRepoRelativeProposalPath(rawPath: string): void {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("/"))
    throw new Error(`proposal path must be repo-relative, got absolute: "${rawPath}"`);
  if (trimmed.startsWith("~/"))
    throw new Error(`proposal path must be repo-relative, got home-relative: "${rawPath}"`);
  const normalized = normalize(trimmed);
  if (normalized.startsWith("../") || normalized === "..")
    throw new Error(`proposal path escapes project tree: "${rawPath}"`);
}

export function resolveTaskRelativePath(projectDir: string, rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return resolve(process.env.HOME ?? "~", rawPath.slice(2));
  }
  if (rawPath.startsWith("/")) return resolve(rawPath);
  return resolve(projectDir, rawPath);
}

export function proposalFeatureName(proposalPath: string): string {
  const trimmed = proposalPath.trim();
  const base = trimmed.split("/").pop() ?? "";
  const name = base.replace(/\.md$/i, "").trim();
  if (!name) throw new Error(`invalid proposal path "${proposalPath}"`);
  return name;
}

/**
 * The most-recent commit SHA that touched `tasks/<taskId>.md` in the harness repo,
 * or `""` if the file is absent / not git-tracked / git is unavailable.
 *
 * Used as the task-content freshness fingerprint for gh-ludics-609 (b)+(c):
 *  - the controller computes it at dispatch (`slotStart` remote branch) and threads
 *    it through the start intent (`PendingIntent.taskIntroCommit`);
 *  - the worker compares its local value against the controller's (content gate, AC2)
 *    and requires the SHA to be an ancestor of its harness HEAD (freshness gate, AC5).
 *
 * `log -1` is the latest commit touching the path — the right freshness semantics:
 * a worker whose checkout is missing later edits to the task file resolves an earlier
 * SHA (or `""`), so the comparison catches stale content, not just an absent file.
 */
export function taskFileIntroCommit(harnessDir: string, taskId: string): string {
  if (!taskId) return "";
  const r = safeSyncOutput(
    ["git", "log", "-1", "--format=%H", "--", join("tasks", `${taskId}.md`)],
    { cwd: harnessDir },
  );
  return r.ok ? r.stdout.trim() : "";
}

export interface TaskSetupContent {
  taskFilePath: string;
  taskContent: string;
  proposalPath: string;
}

/**
 * Resolve the assigned task file's content + proposal path at adapter setup,
 * failing loudly instead of silently degrading to an empty spec (gh-ludics-609 (b)).
 *
 * Replaces the former inline
 *   `taskContent_ = existsSync(p) ? readFileSync(p) : null; proposalPath_ = ...`
 * block in both adapters' `start(ctx)`. A missing file used to yield
 * `taskContent = null` → `proposalPath = ""`, which disarmed the
 * proposal-reachability guard (gated on `if (proposalPath)`) and launched the
 * agent against a bare task ID. This throws via the existing adapter
 * setup-failure surface (`slot_setup_failed`) instead.
 *
 * @param expectedIntroCommit Optional controller-supplied freshness fingerprint
 *   (the `taskFileIntroCommit` of the controller's authoritative checkout, threaded
 *   on the start intent). When present, a mismatch against the local file's
 *   `taskFileIntroCommit` throws (AC2 — catches present-but-stale content). When
 *   absent (legacy/local/standalone dispatch), only existence is checked (AC1).
 */
export function resolveTaskContentForSetup(
  harnessDir: string,
  taskId: string,
  expectedIntroCommit?: string,
): TaskSetupContent {
  const taskFilePath = join(harnessDir, "tasks", `${taskId}.md`);
  if (!existsSync(taskFilePath)) {
    throw new Error(
      `slot setup blocked: assigned task file not found at ${taskFilePath} ` +
      `(stale/missing harness checkout — refusing to launch against an empty task spec; gh-ludics-609)`,
    );
  }
  if (expectedIntroCommit) {
    const localIntro = taskFileIntroCommit(harnessDir, taskId);
    if (localIntro !== expectedIntroCommit) {
      throw new Error(
        `slot setup blocked: task file ${taskFilePath} is stale — expected intro-commit ` +
        `${expectedIntroCommit}, local checkout has ${localIntro || "none"} ` +
        `(harness behind controller; refusing to launch against divergent content; gh-ludics-609)`,
      );
    }
  }
  const taskContent = readFileSync(taskFilePath, "utf-8");
  const proposalPath = parseTaskFrontmatter(taskContent).proposal ?? "";
  return { taskFilePath, taskContent, proposalPath };
}

export interface ProposalLaunchMetadata {
  launchFeature: string;
  proposalFile: string;
}

export function readProposalLaunchMetadata(
  cliCommand: string,
  harnessDir: string,
  taskId: string,
  projectDir: string,
): ProposalLaunchMetadata | null {
  if (!taskId) return null;

  const taskFile = join(harnessDir, "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return null;

  const taskContent = readFileSync(taskFile, "utf-8");
  const proposalValue = parseTaskFrontmatter(taskContent).proposal;
  if (!proposalValue) return null;

  // Deprecated sentinel — kept for backward compat; no file-based proposal to resolve.
  if (proposalValue === "inline") return null;

  assertRepoRelativeProposalPath(proposalValue);
  const proposalFile = resolveTaskRelativePath(projectDir, proposalValue);
  if (!existsSync(proposalFile)) {
    throw new Error(
      `${cliCommand} start blocked: proposal for ${taskId} not found at ${proposalFile}`,
    );
  }

  return {
    launchFeature: proposalFeatureName(proposalValue),
    proposalFile,
  };
}
