import { existsSync, readFileSync } from "fs";
import { join, normalize, resolve } from "path";
import { parseTaskFrontmatter } from "../tasks/markdown.ts";

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
