import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { PEER_SYNC_DIRNAME, peerSyncPath } from "./peer-sync.ts";
import { slugify } from "./util.ts";
import { safeSyncOutput } from "../spawn.ts";

export interface WorktreeSetup {
  rootWorktree: string;
  peerSyncDir: string;
  agentWorktrees: Record<string, string>;
  branches: Record<string, string>;
}

export function runGit(projectDir: string, args: string[]): string {
  const r = safeSyncOutput(["git", ...args], { cwd: projectDir });
  if (!r.ok) throw new Error(r.stderr || `git ${args.join(" ")} failed`);
  return r.stdout;
}

function maybeGit(projectDir: string, args: string[]): string {
  return safeSyncOutput(["git", ...args], { cwd: projectDir }).stdout;
}

/** Paths that the orchestrator manages inside worktrees and must never be committed. */
export const GIT_EXCLUDE_ENTRIES = [
  PEER_SYNC_DIRNAME,
  ".ludics-orchestration.json",
  ".claude",
  ".agents",
  ".agent-sessions",
  "node_modules",
];

/**
 * Ensure that all {@link GIT_EXCLUDE_ENTRIES} are present in the local
 * `.git/info/exclude` for the given repo or worktree path.
 * Uses `--git-common-dir` so that worktrees write to the shared exclude
 * file that git actually reads (not the per-worktree git dir).
 * Idempotent: only appends entries that are not already present.
 * Throws on failure — this is required setup, not best-effort.
 */
export function ensureGitExcludes(repoPath: string): void {
  const commonDir = runGit(repoPath, ["rev-parse", "--git-common-dir"]);
  const resolvedGitDir = resolve(repoPath, commonDir);
  const infoDir = join(resolvedGitDir, "info");
  const excludePath = join(infoDir, "exclude");

  mkdirSync(infoDir, { recursive: true });

  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf-8");
  } catch {
    // File doesn't exist yet — will be created.
  }

  const existingLines = new Set(existing.split("\n"));
  const missing = GIT_EXCLUDE_ENTRIES.filter((e) => !existingLines.has(e));
  if (missing.length === 0) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(excludePath, existing + prefix + missing.join("\n") + "\n");
}

function worktreeExists(projectDir: string, path: string): boolean {
  const list = maybeGit(projectDir, ["worktree", "list", "--porcelain"]);
  return list.split("\n").some((line) => line === `worktree ${path}`);
}

function removeIfRegistered(projectDir: string, path: string): void {
  if (worktreeExists(projectDir, path)) {
    maybeGit(projectDir, ["worktree", "remove", "--force", path]);
  }
}

function addWorktree(projectDir: string, path: string, branch: string, base: string): void {
  removeIfRegistered(projectDir, path);
  if (existsSync(path)) {
    throw new Error(`refusing to reuse non-worktree path: ${path}`);
  }
  const branchExists = safeSyncOutput(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: projectDir },
  ).ok;
  if (branchExists) {
    runGit(projectDir, ["worktree", "add", path, branch]);
  } else {
    runGit(projectDir, ["worktree", "add", "-b", branch, path, base]);
  }
}

function defaultMainBranch(projectDir: string): string {
  const remoteHead = maybeGit(projectDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  const local = maybeGit(projectDir, ["branch", "--show-current"]);
  return local || "main";
}

export function createWorktrees(
  projectDir: string,
  taskId: string,
  agents: Array<{ name: string }>,
  mainBranch: string = defaultMainBranch(projectDir),
  slot?: number,
  mode: "duo" | "pair" = "duo",
): WorktreeSetup {
  const featureSlug = slugify(taskId);
  const slotSuffix = slot ? `-s${slot}` : "";
  const parentDir = dirname(resolve(projectDir));
  const repoName = basename(resolve(projectDir));
  const stem = `${repoName}-${featureSlug}${slotSuffix}`;
  const rootWorktree = join(parentDir, stem);
  const peerSyncDir = peerSyncPath(rootWorktree);
  const branches: Record<string, string> = {
    root: `ludics/${featureSlug}${slotSuffix}/root`,
  };
  addWorktree(projectDir, rootWorktree, branches.root, mainBranch);

  const agentWorktrees: Record<string, string> = {};
  if (mode === "pair") {
    // Pair mode: both agents share the root worktree and branch
    for (const agent of agents) {
      branches[agent.name] = branches.root;
      agentWorktrees[agent.name] = rootWorktree;
    }
  } else {
    // Duo mode: each agent gets its own worktree and branch
    for (const agent of agents) {
      const path = join(parentDir, `${stem}-${slugify(agent.name)}`);
      const branch = `ludics/${featureSlug}${slotSuffix}/${slugify(agent.name)}`;
      branches[agent.name] = branch;
      addWorktree(projectDir, path, branch, mainBranch);
      agentWorktrees[agent.name] = path;
    }
  }

  // Symlink node_modules from the project dir into worktrees so that
  // typecheck, tests, and tooling work without a separate install.
  const projectNodeModules = join(resolve(projectDir), "node_modules");
  if (existsSync(projectNodeModules)) {
    const uniquePaths = new Set([rootWorktree, ...Object.values(agentWorktrees)]);
    for (const wt of uniquePaths) {
      const target = join(wt, "node_modules");
      if (!existsSync(target)) {
        try { symlinkSync(projectNodeModules, target); } catch { /* ignore */ }
      }
    }
  }

  // Write .git/info/exclude so orchestration files are never committed,
  // even if agents run their own git add / git commit -a.
  ensureGitExcludes(resolve(projectDir));
  const allWorktrees = new Set([rootWorktree, ...Object.values(agentWorktrees)]);
  for (const wt of allWorktrees) {
    ensureGitExcludes(wt);
  }

  return { rootWorktree, peerSyncDir, agentWorktrees, branches };
}

export function symlinkPeerSync(
  peerSyncDir: string,
  agentWorktrees: Record<string, string>,
): void {
  // Deduplicate: in pair mode all agents share the root worktree
  const uniquePaths = new Set(Object.values(agentWorktrees));
  for (const worktreePath of uniquePaths) {
    mkdirSync(worktreePath, { recursive: true });
    const linkPath = join(worktreePath, PEER_SYNC_DIRNAME);
    // If peerSyncDir is already inside this worktree, skip symlinking
    if (resolve(peerSyncDir).startsWith(resolve(worktreePath))) continue;
    try {
      if (existsSync(linkPath)) {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink() && readlinkSync(linkPath) === peerSyncDir) continue;
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      rmSync(linkPath, { recursive: true, force: true });
    }
    symlinkSync(peerSyncDir, linkPath);
  }
}

export function cleanupWorktrees(
  projectDir: string,
  taskId: string,
  agents: Array<{ name: string }>,
  slot?: number,
  mode: "duo" | "pair" = "duo",
): void {
  const featureSlug = slugify(taskId);
  const slotSuffix = slot ? `-s${slot}` : "";
  const parentDir = dirname(resolve(projectDir));
  const repoName = basename(resolve(projectDir));
  const stem = `${repoName}-${featureSlug}${slotSuffix}`;
  const rootWorktree = join(parentDir, stem);
  removeIfRegistered(projectDir, rootWorktree);
  if (mode === "duo") {
    for (const agent of agents) {
      removeIfRegistered(projectDir, join(parentDir, `${stem}-${slugify(agent.name)}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-commit helpers
// ---------------------------------------------------------------------------

/** Pathspec exclusions derived from {@link GIT_EXCLUDE_ENTRIES} for autoCommitWorktree. */
const ORCHESTRATION_EXCLUDES = GIT_EXCLUDE_ENTRIES.map((e) => `:!${e}`);

export interface AutoCommitResult {
  /** Whether the worktree had eligible uncommitted changes. */
  dirty: boolean;
  /** Whether a commit was created. */
  committed: boolean;
  /** SHA of the created commit, if any. */
  commitSha?: string;
  /** Error message if something went wrong. */
  error?: string;
}

/**
 * Auto-commit any uncommitted changes in the given directory, excluding
 * orchestration-internal paths listed in {@link GIT_EXCLUDE_ENTRIES}.
 * Returns a structured result. Safe to call on clean worktrees (no-op).
 */
export function autoCommitWorktree(
  worktreePath: string,
  commitMessage: string,
): AutoCommitResult {
  // Use runGit (throws on failure) in try/catch so we can distinguish
  // "clean tree" from "git command failed". maybeGit collapses both to "".
  let status: string;
  try {
    status = runGit(worktreePath, [
      "status", "--porcelain", "--", ".", ...ORCHESTRATION_EXCLUDES,
    ]);
  } catch (err) {
    return { dirty: false, committed: false, error: `status check failed: ${err}` };
  }

  if (!status) return { dirty: false, committed: false }; // clean tree

  try {
    runGit(worktreePath, ["add", "-A", "--", ".", ...ORCHESTRATION_EXCLUDES]);
    runGit(worktreePath, ["commit", "-m", commitMessage]);
    const sha = maybeGit(worktreePath, ["rev-parse", "--short", "HEAD"]);
    return { dirty: true, committed: true, commitSha: sha || undefined };
  } catch (err) {
    return { dirty: true, committed: false, error: String(err) };
  }
}

/**
 * Push the current branch, setting upstream tracking if needed.
 * Freshly-created worktree branches may not have an upstream, so
 * we use `git push -u origin <branch>`.
 */
export function pushBranch(worktreePath: string, branch: string): void {
  runGit(worktreePath, ["push", "-u", "origin", branch]);
}
