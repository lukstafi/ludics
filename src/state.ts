// State repository git operations (git via Bun.$)

import { stateRepoDir } from "./config.ts";

function run(cmd: string[], cwd: string): { success: boolean; stdout: string } {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    success: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
  };
}

export function stateCommit(message: string): void {
  const repoDir = stateRepoDir();
  const { success: hasDiff } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 }; // exitCode 1 means there ARE diffs
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
  stateCommit(message);
  statePush();
}

export function stateFullSync(): void {
  statePull();
  stateCommit("sync");
  statePush();
}
