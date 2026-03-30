import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { slugify } from "./util.ts";

export interface WorktreeSetup {
  rootWorktree: string;
  peerSyncDir: string;
  agentWorktrees: Record<string, string>;
  branches: Record<string, string>;
}

export function runGit(projectDir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString().trim();
}

function maybeGit(projectDir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  if (result.exitCode !== 0) return "";
  return result.stdout.toString().trim();
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
  const branchExists = Bun.spawnSync(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    {
      cwd: projectDir,
      stdout: "ignore",
      stderr: "ignore",
      env: process.env as Record<string, string>,
    },
  ).exitCode === 0;
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
  feature: string,
  agents: Array<{ name: string }>,
  mainBranch: string = defaultMainBranch(projectDir),
  slot?: number,
  mode: "duo" | "pair" = "duo",
): WorktreeSetup {
  const featureSlug = slugify(feature);
  const slotSuffix = slot ? `-s${slot}` : "";
  const parentDir = dirname(resolve(projectDir));
  const repoName = basename(resolve(projectDir));
  const stem = `${repoName}-${featureSlug}${slotSuffix}`;
  const rootWorktree = join(parentDir, stem);
  const peerSyncDir = join(rootWorktree, ".peer-sync");
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
    const linkPath = join(worktreePath, ".peer-sync");
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
  feature: string,
  agents: Array<{ name: string }>,
  slot?: number,
  mode: "duo" | "pair" = "duo",
): void {
  const featureSlug = slugify(feature);
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

/** Paths that the orchestrator writes into worktrees but must never be committed. */
const ORCHESTRATION_EXCLUDES = [
  ":!.peer-sync",
  ":!.ludics-orchestration.json",
  ":!.claude",
];

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
 * orchestration-internal paths (.peer-sync, .ludics-orchestration.json, .claude).
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
