// State repository git operations (git via Bun.$)

import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { stateRepoDir } from "./config.ts";

/** Lazy check to avoid circular import (federation.ts imports state.ts). */
function isController(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { federationIsController } = require("./federation.ts");
    return federationIsController();
  } catch {
    return true; // if federation module unavailable, allow push
  }
}

function run(cmd: string[], cwd: string): { success: boolean; stdout: string } {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    success: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
  };
}

function dirtyFlagPath(): string {
  // Place outside git tree to avoid committing the flag itself
  return join(process.env.HOME ?? "/tmp", ".ludics-state-dirty");
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
 * Mark state dirty. Replaces the old immediate-commit behavior so that
 * existing callers accumulate changes until the next checkpoint.
 */
export function stateCommit(message: string): void {
  void message; // message is informational only — actual commit happens at checkpoint
  stateMarkDirty();
}

/** Immediately commit and optionally push. For critical moments like controller handoff. */
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

  // Only the controller should push to the shared state repo
  if (push && isController()) {
    statePush();
  }
}

export function statePull(): boolean {
  const repoDir = stateRepoDir();

  // Check for uncommitted changes
  const diffResult = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  const hasChanges = diffResult.exitCode !== 0;

  if (hasChanges) {
    run(["git", "stash", "push", "-m", "ludics auto-stash before pull"], repoDir);
  }

  const pullResult = run(["git", "pull", "--rebase"], repoDir);
  if (pullResult.success) {
    console.error("ludics: pulled latest from remote");
  } else {
    console.error("ludics: pull failed (may need manual intervention)");
    if (hasChanges) {
      run(["git", "stash", "pop"], repoDir);
    }
    return false;
  }

  if (hasChanges) {
    const popResult = run(["git", "stash", "pop"], repoDir);
    if (popResult.success) {
      console.error("ludics: restored local changes");
    } else {
      console.error("ludics: conflict restoring local changes (check git stash)");
    }
  }

  return true;
}

export function statePush(): void {
  const repoDir = stateRepoDir();
  const result = run(["git", "push"], repoDir);
  if (result.success) {
    console.error("ludics: pushed to remote");
  } else {
    console.error("ludics: push failed (will retry later)");
  }
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
