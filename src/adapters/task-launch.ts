import { existsSync, readFileSync } from "fs";
import { join, normalize, resolve } from "path";

function normalizeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function readFrontmatterField(content: string, field: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fmMatch[1]!.match(new RegExp(`^\\s*${escapedField}:\\s*(.+)$`, "m"));
  if (!match) return null;

  const value = normalizeYamlScalar(match[1]!);
  if (!value || value.toLowerCase() === "null") return null;
  return value;
}

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
  const proposalValue = readFrontmatterField(taskContent, "proposal");
  if (!proposalValue) return null;

  // Legacy inline proposals have no associated file; treat as no file-based proposal.
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
