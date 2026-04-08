import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { cleanupDelayHours } from "../config.ts";

// Redirect harnessDir() to a temp directory via env var
const tmpDir = join(import.meta.dir, ".test-tmp-deferred-cleanup");
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

beforeEach(() => {
  process.env.LUDICS_HARNESS_DIR = tmpDir;
  mkdirSync(join(tmpDir, "mag"), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Import AFTER env setup (but bun resolves eagerly — harnessDir() reads env at call time, so this is fine)
import {
  type CleanupEntry,
  buildCleanupEntry,
  cancelDeferredCleanup,
  cleanupPendingPath,
  loadDeferredCleanups,
  processDeferredCleanups,
  recordDeferredCleanup,
  saveDeferredCleanups,
} from "./deferred-cleanup.ts";
import type { OrchestrationState, AgentConfig } from "./state.ts";

function makeEntry(overrides?: Partial<CleanupEntry>): CleanupEntry {
  return {
    timestamp: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30h ago
    projectDir: "/tmp/test-project",
    taskId: "test-task-1",
    slot: 1,
    agents: [{ name: "coder" }, { name: "reviewer" }],
    mode: "pair",
    branches: ["ludics/test-task-s1/root"],
    worktreePaths: ["/tmp/test-project-test-task-1-s1"],
    tmuxSessionNames: [],
    peerSyncLink: "/tmp/test-project/.agent-sessions/test-task-1-s1.session",
    ...overrides,
  };
}

describe("recordDeferredCleanup", () => {
  test("creates manifest and appends entries", () => {
    recordDeferredCleanup(makeEntry({ taskId: "task-a" }));
    recordDeferredCleanup(makeEntry({ taskId: "task-b" }));
    const entries = loadDeferredCleanups();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.taskId).toBe("task-a");
    expect(entries[1]!.taskId).toBe("task-b");
  });

  test("creates mag directory if missing", () => {
    rmSync(join(tmpDir, "mag"), { recursive: true, force: true });
    recordDeferredCleanup(makeEntry());
    expect(existsSync(cleanupPendingPath())).toBe(true);
  });
});

describe("loadDeferredCleanups", () => {
  test("returns [] when no manifest exists", () => {
    expect(loadDeferredCleanups()).toEqual([]);
  });

  test("returns [] on corrupt JSON", () => {
    const { writeFileSync } = require("fs");
    writeFileSync(cleanupPendingPath(), "not-json");
    expect(loadDeferredCleanups()).toEqual([]);
  });
});

describe("cancelDeferredCleanup", () => {
  test("removes entries matching taskId+slot", () => {
    recordDeferredCleanup(makeEntry({ taskId: "task-a", slot: 1 }));
    recordDeferredCleanup(makeEntry({ taskId: "task-b", slot: 2 }));
    recordDeferredCleanup(makeEntry({ taskId: "task-a", slot: 3 }));
    cancelDeferredCleanup("task-a", 1);
    const entries = loadDeferredCleanups();
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.taskId === "task-a" && e.slot === 1)).toBe(false);
    expect(entries.some((e) => e.taskId === "task-b" && e.slot === 2)).toBe(true);
    expect(entries.some((e) => e.taskId === "task-a" && e.slot === 3)).toBe(true);
  });

  test("no-op when no match", () => {
    recordDeferredCleanup(makeEntry({ taskId: "task-a", slot: 1 }));
    cancelDeferredCleanup("task-z", 9);
    expect(loadDeferredCleanups()).toHaveLength(1);
  });

  test("no-op on empty manifest", () => {
    cancelDeferredCleanup("anything", 1);
    // Should not throw, manifest remains absent
    expect(loadDeferredCleanups()).toEqual([]);
  });
});

describe("processDeferredCleanups", () => {
  test("processes entries older than threshold and removes them", async () => {
    // Entry is 30h old, threshold is 25h → should be processed
    recordDeferredCleanup(makeEntry({
      timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
      worktreePaths: [],   // empty so cleanup helpers are no-ops
      branches: [],
      tmuxSessionNames: [],
      peerSyncLink: null,
    }));
    await processDeferredCleanups(25);
    expect(loadDeferredCleanups()).toHaveLength(0);
  });

  test("skips entries newer than threshold", async () => {
    recordDeferredCleanup(makeEntry({
      timestamp: new Date().toISOString(), // now
    }));
    await processDeferredCleanups(25);
    expect(loadDeferredCleanups()).toHaveLength(1);
  });

  test("partitions correctly: old processed, new kept", async () => {
    recordDeferredCleanup(makeEntry({
      taskId: "old",
      timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
      worktreePaths: [], branches: [], tmuxSessionNames: [], peerSyncLink: null,
    }));
    recordDeferredCleanup(makeEntry({
      taskId: "new",
      timestamp: new Date().toISOString(),
    }));
    await processDeferredCleanups(25);
    const remaining = loadDeferredCleanups();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.taskId).toBe("new");
  });

  test("handles empty manifest", async () => {
    await processDeferredCleanups(25);
    // No error, manifest stays empty
    expect(loadDeferredCleanups()).toEqual([]);
  });
});

describe("buildCleanupEntry", () => {
  function makeOrchState(overrides?: Partial<OrchestrationState>): OrchestrationState {
    return {
      slot: 1,
      taskId: "test-task-1",
      mode: "pair",
      phase: "setup",
      round: 1,
      mergeRound: 0,
      agents: [
        { name: "coder", provider: "claude-code", model: "opus", branch: "ludics/test-task-s1/root", worktreePath: "/tmp/proj-test-task-1-s1" },
        { name: "reviewer", provider: "codex", model: "o3", branch: "ludics/test-task-s1/root", worktreePath: "/tmp/proj-test-task-1-s1" },
      ] as AgentConfig[],
      agentStates: {},
      config: {} as OrchestrationState["config"],
      phaseStartedAt: Date.now(),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/test-project",
      rootWorktree: "/tmp/proj-test-task-1-s1",
      peerSyncDir: "/tmp/proj-test-task-1-s1/.peer-sync",
      threadIds: {},
      ...overrides,
    };
  }

  test("captures concrete values from orchState (pair mode)", () => {
    const entry = buildCleanupEntry(makeOrchState(), 1, {
      tmuxSessionNames: ["s1_coder_test-task-1"],
    });
    expect(entry.projectDir).toBe("/tmp/test-project");
    expect(entry.taskId).toBe("test-task-1");
    expect(entry.slot).toBe(1);
    expect(entry.mode).toBe("pair");
    expect(entry.worktreePaths).toEqual(["/tmp/proj-test-task-1-s1"]);
    expect(entry.tmuxSessionNames).toEqual(["s1_coder_test-task-1"]);
    expect(entry.peerSyncLink).toBe("/tmp/test-project/.agent-sessions/test-task-1-s1.session");
    expect(entry.timestamp).toBeDefined();
  });

  test("duo mode includes root + agent worktrees and branches", () => {
    const orchState = makeOrchState({
      mode: "duo",
      rootWorktree: "/tmp/proj-duo-s2",
      agents: [
        { name: "coder", provider: "claude-code", model: "opus", branch: "ludics/duo-s2/coder", worktreePath: "/tmp/proj-duo-s2-coder" },
        { name: "reviewer", provider: "codex", model: "o3", branch: "ludics/duo-s2/reviewer", worktreePath: "/tmp/proj-duo-s2-reviewer" },
      ] as AgentConfig[],
    });
    const entry = buildCleanupEntry(orchState, 2);
    expect(entry.worktreePaths).toEqual([
      "/tmp/proj-duo-s2",
      "/tmp/proj-duo-s2-coder",
      "/tmp/proj-duo-s2-reviewer",
    ]);
    // Root branch captured via maybeGit (returns "" since worktree doesn't exist)
    // Agent branches are distinct from root, so they're included
    expect(entry.branches).toContain("ludics/duo-s2/coder");
    expect(entry.branches).toContain("ludics/duo-s2/reviewer");
  });

  test("pair mode deduplicates: agents sharing root worktree → single path", () => {
    const orchState = makeOrchState(); // pair mode, all agents share rootWorktree
    const entry = buildCleanupEntry(orchState, 1);
    // Only root worktree appears (pair mode doesn't enter duo branch)
    expect(entry.worktreePaths).toEqual(["/tmp/proj-test-task-1-s1"]);
  });

  test("includes t3codeThreadIds when provided", () => {
    const entry = buildCleanupEntry(makeOrchState(), 1, {
      t3codeThreadIds: ["th-1", "th-2"],
    });
    expect(entry.t3codeThreadIds).toEqual(["th-1", "th-2"]);
  });

  test("defaults tmuxSessionNames to [] and t3codeThreadIds to undefined", () => {
    const entry = buildCleanupEntry(makeOrchState(), 1);
    expect(entry.tmuxSessionNames).toEqual([]);
    expect(entry.t3codeThreadIds).toBeUndefined();
  });
});

describe("config cleanupDelayHours", () => {
  test("returns 25 by default (no config file)", () => {
    expect(cleanupDelayHours()).toBe(25);
  });
});
