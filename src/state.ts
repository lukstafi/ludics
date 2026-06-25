// State repository git operations (git via Bun.$)

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { stateRepoDir } from "./config.ts";
import { safeSyncOutput } from "./spawn.ts";

function run(cmd: string[], cwd: string): { success: boolean; stdout: string } {
  const r = safeSyncOutput(cmd, { cwd });
  return { success: r.ok, stdout: r.stdout };
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
  const hasDiff = !safeSyncOutput(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir }).ok;
  const hasCached = !safeSyncOutput(["git", "diff", "--cached", "--quiet"], { cwd: repoDir }).ok;

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
  const hasDiff = !safeSyncOutput(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir }).ok;
  const hasCached = !safeSyncOutput(["git", "diff", "--cached", "--quiet"], { cwd: repoDir }).ok;

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
  const hasDiff = !safeSyncOutput(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir }).ok;

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

/** Pull remote state, overwriting local. Used during controller handoff
 *  (becoming controller) to adopt the previous controller's state.
 *  NOT used during normal operation — the controller's local state is authoritative. */
export function statePull(): boolean {
  const repoDir = stateRepoDir();

  // Abort any stuck rebase from previous logic
  const rebaseDir = join(repoDir, ".git", "rebase-merge");
  const rebaseApply = join(repoDir, ".git", "rebase-apply");
  if (existsSync(rebaseDir) || existsSync(rebaseApply)) {
    run(["git", "rebase", "--abort"], repoDir);
    console.error("ludics: aborted stuck rebase before pull");
  }

  // Fetch and reset to remote — remote is authoritative during handoff
  const fetchResult = run(["git", "fetch", "origin"], repoDir);
  if (!fetchResult.success) {
    console.error("ludics: fetch failed during pull");
    return false;
  }

  run(["git", "reset", "--hard", "origin/main"], repoDir);
  console.error("ludics: pulled latest from remote (hard reset)");
  return true;
}

/**
 * Worker-side dispatch-time freshness gate (gh-ludics-609 (c)/AC5).
 *
 * Refresh the local state repo from origin, then verify the controller-supplied
 * task introducing-commit is an ancestor of the worker's harness HEAD. Returns
 * true if the harness is fresh enough to launch, false to refuse.
 *
 * Fetch-before-ancestry is load-bearing: a 0-behind `HEAD..origin/main` lies if
 * the worker has not fetched, and pre-fetch the worker may not even hold the
 * commit object — `merge-base --is-ancestor` would then report "not an ancestor"
 * for a commit that IS reachable post-fetch (the worker-deploy stale-ref trap).
 * So we always `statePull()` (fetch + reset --hard origin/main) first. The reset
 * is safe because worker runs no longer dirty the harness (gh-ludics-609 write-leak
 * closure) — a clean checkout always fast-forwards.
 *
 * An empty `introCommit` means the controller had no fingerprint (legacy/local
 * dispatch); callers treat that as "no gate" and should not call this.
 */
export function ensureHarnessFreshForCommit(introCommit: string): boolean {
  if (!introCommit) return true; // no fingerprint supplied → nothing to gate on
  if (!statePull()) {
    console.error("ludics: harness freshness gate: fetch/reset failed — refusing start");
    return false;
  }
  const repoDir = stateRepoDir();
  const r = run(["git", "merge-base", "--is-ancestor", introCommit, "HEAD"], repoDir);
  if (!r.success) {
    console.error(
      `ludics: harness freshness gate: task intro-commit ${introCommit} is not an ancestor ` +
      `of harness HEAD after fetch — refusing start (stale worker harness)`,
    );
  }
  return r.success;
}

export function statePush(): void {
  const repoDir = stateRepoDir();

  // Controller owns the state repo — force-push to overwrite remote.
  // No pull/rebase: the controller's local state is always authoritative.
  // Remote divergence can only come from a previous controller's writes
  // (stale) or manual edits (should not happen).
  const rebaseDir = join(repoDir, ".git", "rebase-merge");
  const rebaseApply = join(repoDir, ".git", "rebase-apply");

  // Clean up any stuck rebase from previous (now-removed) pull-rebase logic
  if (existsSync(rebaseDir) || existsSync(rebaseApply)) {
    run(["git", "rebase", "--abort"], repoDir);
    console.error("ludics: aborted stuck rebase before push");
  }

  const pushResult = run(["git", "push", "--force"], repoDir);
  if (pushResult.success) {
    console.error("ludics: pushed to remote");
  } else {
    console.error("ludics: push --force failed (will retry next checkpoint)");
  }
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
    "harness/cluster/slot-intents/",
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

/** Full sync: commit local state and force-push to remote.
 *  Does NOT pull — the controller's local state is authoritative. */
export function stateFullSync(): void {
  stateCommitImmediate("sync");
  statePush();
}
