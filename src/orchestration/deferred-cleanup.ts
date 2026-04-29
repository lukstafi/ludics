// Deferred cleanup — records artifact cleanup entries for post-mortem window.
// Entries are processed during briefing prep after a configurable delay.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { harnessDir as defaultHarnessDir, cleanupDelayHours } from "../config.ts";
import { safeSyncOutput } from "../spawn.ts";
import type { OrchestrationState } from "./state.ts";
import { removeWorktreeByPath, deleteBranches, orchBranchName, purgeOrphanDirIfRecoverable } from "./worktrees.ts";
import { removePeerSyncLink } from "./peer-sync.ts";

export interface CleanupEntry {
  timestamp: string;
  projectDir: string;
  taskId: string;
  slot: number;
  agents: Array<{ name: string }>;
  mode: "duo" | "pair" | "solo";
  branches: string[];
  worktreePaths: string[];
  tmuxSessionNames: string[];
  peerSyncLink: string | null;
  t3codeThreadIds?: string[];
}

export function cleanupPendingPath(harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "mag", "cleanup-pending.json");
}

export function loadDeferredCleanups(harnessDir: string = defaultHarnessDir()): CleanupEntry[] {
  const file = cleanupPendingPath(harnessDir);
  if (!existsSync(file)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw as CleanupEntry[];
  } catch {
    return [];
  }
}

export function saveDeferredCleanups(
  entries: CleanupEntry[],
  harnessDir: string = defaultHarnessDir(),
): void {
  try {
    const file = cleanupPendingPath(harnessDir);
    mkdirSync(join(harnessDir, "mag"), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (err: unknown) {
    // Tolerate permission errors (e.g., harness dir not writable in test/CI environments)
    // but re-throw other failures (ENOSPC, I/O errors) to avoid silently losing cleanup entries
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") {
      console.error(`ludics: failed to save deferred cleanups (EPERM): ${err.message}`);
      return;
    }
    throw err;
  }
}

/** Build a cleanup entry from concrete OrchestrationState values. */
export function buildCleanupEntry(
  orchState: OrchestrationState,
  slot: number,
  extra?: { tmuxSessionNames?: string[]; t3codeThreadIds?: string[] },
): CleanupEntry {
  // Concrete worktree paths from orchState
  const worktreePaths = [orchState.rootWorktree];
  if (orchState.mode === "duo") {
    for (const agent of orchState.agents) {
      if (agent.worktreePath !== orchState.rootWorktree) {
        worktreePaths.push(agent.worktreePath);
      }
    }
  }

  // Concrete branch names — prefer persisted branches from state (populated at init).
  // Fall back to naming-convention derivation for backward compat with old state files.
  let branches: string[];
  if (orchState.branches) {
    branches = [...new Set(Object.values(orchState.branches))];
  } else {
    const rootBranch = orchBranchName(orchState.taskId, slot, "root");
    branches = [rootBranch];
    for (const agent of orchState.agents) {
      if (agent.branch && agent.branch !== rootBranch) {
        branches.push(agent.branch);
      }
    }
  }

  // Concrete peer-sync session link path
  const peerSyncLink = join(orchState.projectDir, ".agent-sessions", `${orchState.taskId}-s${slot}.session`);

  return {
    timestamp: new Date().toISOString(),
    projectDir: orchState.projectDir,
    taskId: orchState.taskId,
    slot,
    agents: orchState.agents.map((a) => ({ name: a.name })),
    mode: orchState.mode,
    branches,
    worktreePaths,
    tmuxSessionNames: extra?.tmuxSessionNames ?? [],
    peerSyncLink,
    t3codeThreadIds: extra?.t3codeThreadIds,
  };
}

/** Append a deferred cleanup entry to the manifest. */
export function recordDeferredCleanup(
  entry: CleanupEntry,
  harnessDir: string = defaultHarnessDir(),
): void {
  const entries = loadDeferredCleanups(harnessDir);
  entries.push(entry);
  saveDeferredCleanups(entries, harnessDir);
}

/** Cancel pending cleanup entries matching taskId + slot (e.g., on resume). */
export function cancelDeferredCleanup(
  taskId: string,
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): void {
  const entries = loadDeferredCleanups(harnessDir);
  const filtered = entries.filter((e) => !(e.taskId === taskId && e.slot === slot));
  if (filtered.length !== entries.length) {
    saveDeferredCleanups(filtered, harnessDir);
  }
}

/** Process deferred cleanup entries older than threshold. */
export async function processDeferredCleanups(
  thresholdHours?: number,
  harnessDir: string = defaultHarnessDir(),
): Promise<void> {
  const entries = loadDeferredCleanups(harnessDir);
  if (entries.length === 0) return;

  const hours = thresholdHours ?? cleanupDelayHours();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const remaining: CleanupEntry[] = [];

  for (const entry of entries) {
    const entryTime = new Date(entry.timestamp).getTime();
    if (Number.isNaN(entryTime) || entryTime > cutoff) {
      remaining.push(entry);
      continue;
    }

    let failed = false;

    // 1. Remove worktrees
    for (const path of entry.worktreePaths) {
      try {
        removeWorktreeByPath(entry.projectDir, path);
      } catch (err) {
        console.error(`ludics: deferred worktree removal failed for ${path}:`, err);
        failed = true;
      }
      // Defense-in-depth: if `removeWorktreeByPath` no-op'd because git no longer
      // registered the path (e.g. a prior `git worktree prune` swept the admin
      // record but left scaffolding on disk), fall back to purging the orchestration
      // entries so the next slot start does not need the inline recovery branch.
      // Best-effort: failures are logged inside `purgeOrphanDirIfRecoverable` and
      // do NOT push the entry back into `remaining`.
      try {
        purgeOrphanDirIfRecoverable(path);
      } catch (err) {
        console.error(`ludics: orphan-dir purge fallback failed for ${path}:`, err);
      }
    }

    // 2. Delete branches (local + remote, deduplicated)
    try {
      deleteBranches(entry.projectDir, entry.branches);
    } catch (err) {
      console.error(`ludics: deferred branch deletion failed:`, err);
      failed = true;
    }

    // 3. Kill tmux sessions
    for (const name of entry.tmuxSessionNames) {
      const result = safeSyncOutput(["tmux", "kill-session", "-t", name]);
      if (!result.ok && !result.stderr?.includes("no server running") && !result.stderr?.includes("session not found")) {
        console.error(`ludics: deferred tmux kill-session failed for ${name}: ${result.stderr ?? "unknown"}`);
        failed = true;
      }
    }

    // 4. Remove peer-sync link
    if (entry.peerSyncLink) {
      try {
        removePeerSyncLink(entry.peerSyncLink);
      } catch (err) {
        console.error(`ludics: deferred peer-sync removal failed:`, err);
        failed = true;
      }
    }

    // 5. Delete t3code threads
    if (entry.t3codeThreadIds && entry.t3codeThreadIds.length > 0) {
      try {
        const { serverStatus } = await import("../t3code/server.ts");
        const { T3CodeClient } = await import("../t3code/client.ts");
        const { makeId, isoNow } = await import("./util.ts");
        const status = await serverStatus({ harnessDir });
        if (!status.running || !status.record) {
          console.error("ludics: deferred t3code cleanup: server not running, will retry");
          failed = true;
        } else {
          const client = new T3CodeClient({ url: status.record.wsUrl, token: status.record.authToken });
          try {
            for (const threadId of entry.t3codeThreadIds) {
              try {
                await client.dispatchCommand({
                  type: "thread.session.stop",
                  commandId: makeId("cmd"),
                  threadId,
                  createdAt: isoNow(),
                });
              } catch { /* session may already be stopped */ }
              try {
                await client.dispatchCommand({
                  type: "thread.delete",
                  commandId: makeId("cmd"),
                  threadId,
                });
              } catch (err) {
                console.error(`ludics: deferred t3code thread.delete failed for ${threadId}:`, err);
                failed = true;
              }
            }
          } finally {
            client.close();
          }
        }
      } catch (err) {
        console.error(`ludics: deferred t3code thread deletion failed:`, err);
        failed = true;
      }
    }

    if (failed) {
      remaining.push(entry);
    } else {
      console.error(`ludics: deferred cleanup completed for task ${entry.taskId} slot ${entry.slot}`);
    }
  }

  saveDeferredCleanups(remaining, harnessDir);
}
