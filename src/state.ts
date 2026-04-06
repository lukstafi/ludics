// State repository git operations (git via Bun.$)

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { stateRepoDir } from "./config.ts";

function run(cmd: string[], cwd: string): { success: boolean; stdout: string } {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    success: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
  };
}

function dirtyFlagPath(): string {
  // Place outside git tree, scoped to this state repo to avoid cross-workspace interference.
  const repoDir = stateRepoDir();
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(repoDir);
  const suffix = hasher.digest("hex").slice(0, 8);
  return join(process.env.HOME ?? "/tmp", `.ludics-state-dirty-${suffix}`);
}

/** Mark state as dirty (has uncommitted file writes). Cheap no-op if already dirty. */
export function stateMarkDirty(): void {
  const flag = dirtyFlagPath();
  if (!existsSync(flag)) {
    writeFileSync(flag, String(Math.floor(Date.now() / 1000)));
  }
}

export function stateIsDirty(): boolean {
  return existsSync(dirtyFlagPath());
}

function clearDirtyFlag(): void {
  const flag = dirtyFlagPath();
  if (existsSync(flag)) {
    try { unlinkSync(flag); } catch { /* ignore */ }
  }
}

/**
 * Commit accumulated changes immediately (git add + commit, no push).
 * Used by CLI slot/task mutations to ensure state is persisted before
 * the command returns. Push happens at the next checkpoint.
 */
export function stateCommit(message: string): void {
  const repoDir = stateRepoDir();
  const { success: hasDiff } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  const { success: hasCached } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  if (!hasDiff && !hasCached) return;

  run(["git", "add", "-A"], repoDir);
  const result = run(["git", "commit", "-m", message], repoDir);
  if (result.success) {
    console.error(`ludics: committed: ${message}`);
  }
  clearDirtyFlag();
}

/** Immediately commit and push. For critical moments like controller handoff. */
export function stateCommitImmediate(message: string): void {
  const repoDir = stateRepoDir();
  const { success: hasDiff } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  const { success: hasCached } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  if (!hasDiff && !hasCached) {
    clearDirtyFlag();
    return;
  }

  run(["git", "add", "-A"], repoDir);
  const result = run(["git", "commit", "-m", message], repoDir);
  if (result.success) {
    console.error(`ludics: committed: ${message}`);
  }
  clearDirtyFlag();
}

/**
 * Batch checkpoint: commit accumulated changes and optionally push.
 * No-op if nothing is dirty and no git diff exists.
 */
export function stateCheckpoint(
  message: string,
  opts: { push?: boolean } = {},
): void {
  const repoDir = stateRepoDir();
  const push = opts.push ?? true;

  // Check both dirty flag and actual git diff
  const hasDirtyFlag = stateIsDirty();
  const { success: hasDiff } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  if (!hasDirtyFlag && !hasDiff) return;

  run(["git", "add", "-A"], repoDir);
  const result = run(["git", "commit", "-m", `checkpoint: ${message}`], repoDir);
  if (result.success) {
    console.error(`ludics: checkpoint committed: ${message}`);
  }
  clearDirtyFlag();

  if (push) {
    statePush();
  }
}

export function statePull(opts?: { autoCommit?: boolean }): boolean {
  const repoDir = stateRepoDir();
  const autoCommit = opts?.autoCommit ?? true;

  // Abort any stuck rebase before pulling
  const rebaseDir = join(repoDir, ".git", "rebase-merge");
  const rebaseApply = join(repoDir, ".git", "rebase-apply");
  if (existsSync(rebaseDir) || existsSync(rebaseApply)) {
    run(["git", "rebase", "--abort"], repoDir);
    console.error("ludics: aborted stuck rebase before pull");
  }

  // Commit uncommitted changes before pulling (controller-only writes, simple commit)
  if (autoCommit) {
    const diffResult = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    if (diffResult.exitCode !== 0) {
      Bun.spawnSync(["git", "add", "-A"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync(["git", "commit", "-m", "auto-commit before pull"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    }
  }

  const pullResult = run(["git", "pull", "--rebase"], repoDir);
  if (pullResult.success) {
    console.error("ludics: pulled latest from remote");
    return true;
  }

  // Abort any rebase conflict and keep local state
  if (existsSync(rebaseDir) || existsSync(rebaseApply)) {
    run(["git", "rebase", "--abort"], repoDir);
    console.error("ludics: pull rebase conflicted — aborted, keeping local state");
  } else {
    console.error("ludics: pull failed (may need manual intervention)");
  }
  return false;
}

export function statePush(): void {
  const repoDir = stateRepoDir();

  // Controller-only push — simple pull-rebase then push.
  // No multi-writer conflict resolution, squash, or stash needed.
  const pullResult = run(["git", "pull", "--rebase"], repoDir);
  if (!pullResult.success) {
    // Abort any stuck rebase and retry
    const rebaseDir = join(repoDir, ".git", "rebase-merge");
    const rebaseApply = join(repoDir, ".git", "rebase-apply");
    if (existsSync(rebaseDir) || existsSync(rebaseApply)) {
      run(["git", "rebase", "--abort"], repoDir);
      console.error("ludics: aborted stuck rebase, retrying pull");
      const retry = run(["git", "pull", "--rebase"], repoDir);
      if (!retry.success) {
        console.error("ludics: pull failed after retry — pushing anyway");
      }
    } else {
      console.error("ludics: pull failed — pushing anyway");
    }
  }

  const pushResult = run(["git", "push"], repoDir);
  if (pushResult.success) {
    console.error("ludics: pushed to remote");
  } else {
    // Retry once
    console.error("ludics: push rejected, retrying...");
    run(["git", "pull", "--rebase"], repoDir);
    const retry = run(["git", "push"], repoDir);
    if (retry.success) {
      console.error("ludics: pushed to remote (retry)");
    } else {
      console.error("ludics: push failed after retry (will retry next checkpoint)");
    }
  }
}

export interface SlotSections {
  terminals: string;
  runtime: string;
  git: string;
}

/** Extract content of Terminals/Runtime/Git sections from a slot block. */
export function extractSections(block: string): SlotSections {
  let terminals = "";
  let runtime = "";
  let git = "";
  let currentSection = "";

  for (const line of block.split("\n")) {
    if (line === "**Terminals:**") { currentSection = "terminals"; continue; }
    if (line === "**Runtime:**") { currentSection = "runtime"; continue; }
    if (line === "**Git:**") { currentSection = "git"; continue; }
    if (/^\*\*[^*]+:\*\*/.test(line)) { currentSection = ""; continue; }

    switch (currentSection) {
      case "terminals": terminals += line + "\n"; break;
      case "runtime": runtime += line + "\n"; break;
      case "git": git += line + "\n"; break;
    }
  }

  return { terminals: terminals.trimEnd(), runtime: runtime.trimEnd(), git: git.trimEnd() };
}

/** Replace Terminals/Runtime/Git sections in a block with provided content. */
export function replaceSections(block: string, sections: SlotSections): string {
  const output: string[] = [];
  let skipUntilNext = false;

  for (const line of block.split("\n")) {
    if (line === "**Terminals:**") {
      output.push("**Terminals:**");
      if (sections.terminals) output.push(sections.terminals);
      skipUntilNext = true;
      continue;
    }
    if (line === "**Runtime:**") {
      output.push("**Runtime:**");
      if (sections.runtime) output.push(sections.runtime);
      skipUntilNext = true;
      continue;
    }
    if (line === "**Git:**") {
      output.push("**Git:**");
      if (sections.git) output.push(sections.git);
      skipUntilNext = true;
      continue;
    }
    if (/^\*\*/.test(line)) {
      skipUntilNext = false;
    }
    if (!skipUntilNext) {
      output.push(line);
    }
  }

  return output.join("\n");
}

/**
 * Ensure the state repo's .gitignore excludes coordination artifacts
 * (slot-intents, worker-signals) so they never propagate via git.
 * Called during init and health-check. Idempotent.
 */
export function ensureCoordinationGitignore(): void {
  const repoDir = stateRepoDir();
  const gitignorePath = join(repoDir, ".gitignore");

  const entries = [
    "# Coordination artifacts — local-only, delivered via HTTP not git",
    "harness/federation/slot-intents/",
    "harness/worker-signals/",
  ];

  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, "utf-8");
  }

  const linesToAdd = entries.filter((e) => !existing.includes(e));
  if (linesToAdd.length === 0) return;

  const suffix = existing.endsWith("\n") || !existing ? "" : "\n";
  writeFileSync(gitignorePath, existing + suffix + linesToAdd.join("\n") + "\n");
  console.error("ludics: updated .gitignore to exclude coordination artifacts");
}

export function stateSync(message: string): void {
  stateCommitImmediate(message);
  statePush();
}

export function stateFullSync(): void {
  statePull();
  stateCommitImmediate("sync");
  statePush();
}
