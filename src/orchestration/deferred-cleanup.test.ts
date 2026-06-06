import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { cleanupDelayHours } from "../config.ts";
import * as config from "../config.ts";
import * as t3codeServer from "../t3code/server.ts";
import * as spawn from "../spawn.ts";

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
  isBenignTmuxKillStderr,
  loadDeferredCleanups,
  processDeferredCleanups,
  recordDeferredCleanup,
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

// task-703d0553: drain resilience. The old all-or-nothing `failed` flag re-queued
// an entire entry whenever ANY sub-step failed — overwhelmingly the t3code arm,
// which set failed=true on every tick while t3code integration is paused (server
// down by design, gh-ludics-539). Now an entry is retained ONLY when a genuinely
// retryable step failed; the paused-t3code arm is a skip, and benign no-ops drain.
describe("processDeferredCleanups drain resilience (task-703d0553)", () => {
  test("AC(a): paused-t3code entry drains, does NOT call serverStatus, and still reaps peer-sync", async () => {
    // Harness condition: integration PAUSED + an entry whose only un-completable
    // step is t3code thread deletion, carrying a real reapable peer-sync link.
    const enabledSpy = spyOn(config, "t3codeIntegrationEnabled").mockReturnValue(false);
    let serverStatusCalls = 0;
    const serverStatusSpy = spyOn(t3codeServer, "serverStatus").mockImplementation(async () => {
      serverStatusCalls++;
      return { running: false, record: null, snapshot: null, reason: "should-not-be-called" };
    });

    // Concrete reapable resource: a real file at peerSyncLink. removePeerSyncLink
    // unlinks it — its disappearance proves reapable cleanup actually ran (guards
    // against an implementation that skips ALL cleanup when t3code is paused).
    const peerSyncLink = join(tmpDir, ".agent-sessions", "test-task-drain-s1.session");
    mkdirSync(dirname(peerSyncLink), { recursive: true });
    writeFileSync(peerSyncLink, "session-link\n");
    expect(existsSync(peerSyncLink)).toBe(true);

    try {
      recordDeferredCleanup(makeEntry({
        taskId: "test-task-drain",
        timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
        worktreePaths: [], branches: [], tmuxSessionNames: [],
        peerSyncLink,
        t3codeThreadIds: ["t-1"],
      }));

      await processDeferredCleanups(25);

      // (i) entry drained — not held hostage by the paused t3code arm.
      expect(loadDeferredCleanups()).toHaveLength(0);
      // (ii) the gate short-circuited BEFORE any server probe.
      expect(serverStatusCalls).toBe(0);
      // (iii) reapable work actually happened — the peer-sync link is gone.
      expect(existsSync(peerSyncLink)).toBe(false);
    } finally {
      enabledSpy.mockRestore();
      serverStatusSpy.mockRestore();
    }
  });

  test("AC(b): t3code ENABLED + server unreachable retains the entry for a future tick", async () => {
    // Positive control for AC(a): the SAME not-running server is a genuinely
    // retryable failure when integration is enabled, so the entry must stay.
    const enabledSpy = spyOn(config, "t3codeIntegrationEnabled").mockReturnValue(true);
    const serverStatusSpy = spyOn(t3codeServer, "serverStatus").mockResolvedValue(
      { running: false, record: null, snapshot: null, reason: "transiently-down" },
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      recordDeferredCleanup(makeEntry({
        taskId: "test-task-enabled-down",
        timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
        worktreePaths: [], branches: [], tmuxSessionNames: [], peerSyncLink: null,
        t3codeThreadIds: ["t-1"],
      }));

      await processDeferredCleanups(25);

      const remaining = loadDeferredCleanups();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.t3codeThreadIds).toEqual(["t-1"]);
    } finally {
      enabledSpy.mockRestore();
      serverStatusSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("benign worktree/branch/tmux no-ops do not pin an otherwise-complete entry", async () => {
    if (!Bun.which("git")) return;
    // Real repo; entry names a ludics/-branch that was never created (deleteBranches
    // is a safeSyncOutput no-op), an already-absent orchestration worktree path
    // (removeWorktreeByPath no-ops), and a tmux session name (no server running).
    // None of these throw → none are retryable → the entry must drain.
    const projectDir = join(tmpDir, "proj-benign-noop");
    mkdirSync(projectDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: projectDir });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: projectDir });
    Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: projectDir });
    writeFileSync(join(projectDir, "README.md"), "init\n");
    Bun.spawnSync(["git", "add", "README.md"], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: projectDir });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      recordDeferredCleanup(makeEntry({
        taskId: "task-benign-noop",
        timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
        projectDir,
        worktreePaths: [join(dirname(projectDir), "proj-benign-noop-task-benign-noop-s1")],
        branches: ["ludics/task-benign-noop-s1/root"],
        tmuxSessionNames: ["ludics-task-benign-noop-s1"],
        peerSyncLink: null,
        t3codeThreadIds: [],
      }));

      await processDeferredCleanups(25);

      expect(loadDeferredCleanups()).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("AC(d) negative control: within-grace entry with t3codeThreadIds is NOT reaped early", async () => {
    // The cutoff partition must run BEFORE any cleanup/gate work: a fresh entry
    // (timestamp=now) is retained untouched and never probes the server.
    let serverStatusCalls = 0;
    const serverStatusSpy = spyOn(t3codeServer, "serverStatus").mockImplementation(async () => {
      serverStatusCalls++;
      return { running: true, record: null, snapshot: null, reason: "should-not-be-called" };
    });
    // Spy the gate too — a within-grace entry must not even reach the t3code arm.
    const enabledSpy = spyOn(config, "t3codeIntegrationEnabled").mockReturnValue(true);
    try {
      recordDeferredCleanup(makeEntry({
        taskId: "test-task-within-grace",
        timestamp: new Date().toISOString(), // now → within grace
        worktreePaths: [], branches: [], tmuxSessionNames: ["ludics-fresh-s1"],
        peerSyncLink: null,
        t3codeThreadIds: ["t-1"],
      }));

      await processDeferredCleanups(25);

      const remaining = loadDeferredCleanups();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.taskId).toBe("test-task-within-grace");
      // No reapable work was attempted early.
      expect(serverStatusCalls).toBe(0);
    } finally {
      serverStatusSpy.mockRestore();
      enabledSpy.mockRestore();
    }
  });

  test("a NON-benign tmux kill failure retains the entry for a future tick", async () => {
    // Positive control for the benign-no-op drain: the tmux step must still
    // pin an entry when the kill fails for a reason that is NOT "session
    // already gone" (e.g. a permission error). Forcing safeSyncOutput to a
    // non-benign stderr is the only way to instantiate this deterministically
    // — a real `tmux kill-session` against a host can only produce the benign
    // shapes. Without this control, isBenignTmuxKillStderr could be loosened
    // to a blanket pass and every drain test would still go green.
    const killSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: false, exitCode: 1, stdout: "", stderr: "some other tmux error", timedOut: false,
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      recordDeferredCleanup(makeEntry({
        taskId: "task-nonbenign-tmux",
        timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
        worktreePaths: [], branches: [], peerSyncLink: null,
        tmuxSessionNames: ["ludics-task-nonbenign-tmux-s1"],
        t3codeThreadIds: [],
      }));

      await processDeferredCleanups(25);

      const remaining = loadDeferredCleanups();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.taskId).toBe("task-nonbenign-tmux");
    } finally {
      killSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("explicit harnessDir flows into serverStatus({ harnessDir }) when t3code is enabled", async () => {
    // Guards the harness-dir threading: processDeferredCleanups(thresholdHours,
    // harnessDir) must hand the SAME harnessDir to the t3code server probe, not
    // fall back to the default. If the threading regressed, serverStatus would
    // receive the process-default dir and this assertion would fail.
    const customHarness = join(tmpDir, "custom-harness");
    mkdirSync(join(customHarness, "mag"), { recursive: true });

    const enabledSpy = spyOn(config, "t3codeIntegrationEnabled").mockReturnValue(true);
    let observedHarnessDir: string | undefined;
    const serverStatusSpy = spyOn(t3codeServer, "serverStatus").mockImplementation(async (opts) => {
      observedHarnessDir = opts?.harnessDir;
      // Return not-running so no real client is constructed; entry is retained.
      return { running: false, record: null, snapshot: null, reason: "probe-only" };
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      recordDeferredCleanup(makeEntry({
        taskId: "task-harnessdir-thread",
        timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
        worktreePaths: [], branches: [], tmuxSessionNames: [], peerSyncLink: null,
        t3codeThreadIds: ["t-1"],
      }), customHarness);

      await processDeferredCleanups(25, customHarness);

      expect(observedHarnessDir).toBe(customHarness);
    } finally {
      enabledSpy.mockRestore();
      serverStatusSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("isBenignTmuxKillStderr", () => {
  test("tolerates all three 'session already gone' shapes", () => {
    expect(isBenignTmuxKillStderr("no server running on /tmp/tmux-501/default")).toBe(true);
    expect(isBenignTmuxKillStderr("session not found: ludics-task-x-s1")).toBe(true);
    // The dev-box-with-live-server shape that previously pinned entries forever.
    expect(isBenignTmuxKillStderr("can't find session: ludics-task-x-s1")).toBe(true);
  });

  test("does NOT tolerate non-benign failures or empty stderr", () => {
    expect(isBenignTmuxKillStderr("permission denied")).toBe(false);
    expect(isBenignTmuxKillStderr("some other tmux error")).toBe(false);
    expect(isBenignTmuxKillStderr("")).toBe(false);
    expect(isBenignTmuxKillStderr(undefined)).toBe(false);
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
        { name: "coder", provider: "claude-code", model: "opus", branch: "ludics/test-task-1-s1/root", worktreePath: "/tmp/proj-test-task-1-s1" },
        { name: "reviewer", provider: "codex", model: "o3", branch: "ludics/test-task-1-s1/root", worktreePath: "/tmp/proj-test-task-1-s1" },
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
    // Root branch derived from naming convention; agent branches match root in pair mode
    expect(entry.branches).toEqual(["ludics/test-task-1-s1/root"]);
    expect(entry.tmuxSessionNames).toEqual(["s1_coder_test-task-1"]);
    expect(entry.peerSyncLink).toBe("/tmp/test-project/.agent-sessions/test-task-1-s1.session");
    expect(entry.timestamp).toBeDefined();
  });

  test("duo mode includes root + agent worktrees and branches", () => {
    const orchState = makeOrchState({
      mode: "duo",
      taskId: "duo-task",
      rootWorktree: "/tmp/proj-duo-s2",
      agents: [
        { name: "coder", provider: "claude-code", model: "opus", branch: "ludics/duo-task-s2/coder", worktreePath: "/tmp/proj-duo-s2-coder" },
        { name: "reviewer", provider: "codex", model: "o3", branch: "ludics/duo-task-s2/reviewer", worktreePath: "/tmp/proj-duo-s2-reviewer" },
      ] as AgentConfig[],
    });
    const entry = buildCleanupEntry(orchState, 2);
    expect(entry.worktreePaths).toEqual([
      "/tmp/proj-duo-s2",
      "/tmp/proj-duo-s2-coder",
      "/tmp/proj-duo-s2-reviewer",
    ]);
    // Root branch derived from naming convention: ludics/<slug>-s<slot>/root
    expect(entry.branches).toContain("ludics/duo-task-s2/root");
    expect(entry.branches).toContain("ludics/duo-task-s2/coder");
    expect(entry.branches).toContain("ludics/duo-task-s2/reviewer");
    expect(entry.branches).toHaveLength(3);
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

  test("uses persisted orchState.branches instead of deriving from convention", () => {
    // Use branch names that intentionally differ from the naming convention
    // to prove buildCleanupEntry reads them from state, not re-derives them.
    const orchState = makeOrchState({
      branches: {
        root: "ludics/custom-root-branch",
        coder: "ludics/custom-coder-branch",
        reviewer: "ludics/custom-coder-branch", // duplicate to test dedup
      },
    });
    const entry = buildCleanupEntry(orchState, 1);
    // Should use the persisted values, deduplicated
    expect(entry.branches).toContain("ludics/custom-root-branch");
    expect(entry.branches).toContain("ludics/custom-coder-branch");
    expect(entry.branches).toHaveLength(2);
    // Should NOT contain the convention-derived name
    expect(entry.branches).not.toContain("ludics/test-task-1-s1/root");
  });

  test("falls back to naming convention when orchState.branches is missing", () => {
    const orchState = makeOrchState(); // no branches field
    const entry = buildCleanupEntry(orchState, 1);
    // Convention-derived root branch
    expect(entry.branches).toContain("ludics/test-task-1-s1/root");
  });
});

// task-d2a16a60: cleanup-side hardening — when the worktree path still exists
// after `removeWorktreeByPath` (because git lost the registration but the
// scaffolding sat on disk), processDeferredCleanups must purge the allow-list
// entries directly so the next slot start does not need the addWorktree
// recovery branch.
describe("processDeferredCleanups orphan-dir hardening (task-d2a16a60)", () => {
  function initBareRepo(repo: string): void {
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "init\n");
    Bun.spawnSync(["git", "add", "README.md"], { cwd: repo });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repo });
  }

  test("purges an orphan worktree directory whose contents match the allow-list", async () => {
    if (!Bun.which("git")) return;
    // Real project + an orphan worktree dir at the canonical orchestration name.
    // The dir contains allow-list scaffolding only, with no git registration.
    const projectDir = join(tmpDir, "proj-orphan-cleanup");
    initBareRepo(projectDir);
    const repoName = "proj-orphan-cleanup";
    const slug = "task-orphan-cleanup";
    const orphanPath = join(dirname(projectDir), `${repoName}-${slug}-s1`);
    mkdirSync(join(orphanPath, ".peer-sync"), { recursive: true });
    writeFileSync(join(orphanPath, ".peer-sync", "coder.status"), "stale\n");
    mkdirSync(join(orphanPath, ".claude"), { recursive: true });
    writeFileSync(join(orphanPath, ".claude", "settings.local.json"), "{}\n");
    writeFileSync(join(orphanPath, ".ludics-orchestration.json"), '{"agentName":"coder"}\n');

    // Sanity: git does NOT know this path as a worktree (orphan condition).
    const list = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: projectDir }).stdout.toString();
    expect(list).not.toContain(`worktree ${orphanPath}`);

    recordDeferredCleanup(makeEntry({
      timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
      projectDir,
      taskId: slug,
      slot: 1,
      worktreePaths: [orphanPath],
      branches: [],
      tmuxSessionNames: [],
      peerSyncLink: null,
    }));

    await processDeferredCleanups(25);

    // Orphan dir is gone — the next slot start does not need addWorktree's recovery branch.
    expect(existsSync(orphanPath)).toBe(false);
    // Manifest was cleared (cleanup succeeded).
    expect(loadDeferredCleanups()).toHaveLength(0);
  });

  // Regression for P1 reviewer comment on PR #435: a corrupted cleanup manifest
  // could list a path whose basename is NOT the canonical orchestration shape but
  // whose contents happen to be allow-list-only (e.g. a stray
  // ~/Code/some-project/node_modules left in a manifest). Both `removeWorktreeByPath`
  // and `purgeOrphanDirIfRecoverable` apply the same orchestration-name guard, so
  // neither path can wipe the directory.
  test("refuses to purge a manifest path whose basename does not match orchestration naming", async () => {
    if (!Bun.which("git")) return;
    const projectDir = join(tmpDir, "proj-orphan-corrupt");
    initBareRepo(projectDir);
    // Sibling path with allow-list-only contents but basename "user-data" — not a
    // canonical {repoName}-{taskSlug}(-s{N})? shape.
    const strayPath = join(dirname(projectDir), "user-data");
    mkdirSync(join(strayPath, ".peer-sync"), { recursive: true });
    writeFileSync(join(strayPath, ".peer-sync", "x"), "user content\n");
    writeFileSync(join(strayPath, ".ludics-orchestration.json"), '{"agentName":"coder"}\n');

    recordDeferredCleanup(makeEntry({
      timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
      projectDir,
      taskId: "task-corrupt",
      slot: 1,
      worktreePaths: [strayPath],
      branches: [],
      tmuxSessionNames: [],
      peerSyncLink: null,
    }));

    const origErr = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => { captured.push(args.map((a) => String(a)).join(" ")); };
    try {
      await processDeferredCleanups(25);
    } finally {
      console.error = origErr;
    }

    // Stray dir contents preserved — neither removal path touched them.
    expect(existsSync(join(strayPath, ".peer-sync", "x"))).toBe(true);
    expect(existsSync(join(strayPath, ".ludics-orchestration.json"))).toBe(true);
    // Both guard layers logged a refusal: removeWorktreeByPath ("refusing to remove worktree")
    // and purgeOrphanDirIfRecoverable ("refusing to purge orphan dir").
    expect(captured.some((w) => w.includes("refusing to remove worktree") && w.includes("user-data"))).toBe(true);
    expect(captured.some((w) => w.includes("refusing to purge orphan dir") && w.includes("user-data"))).toBe(true);
  });

  test("leaves dir intact and logs when contents are unrecognised; does NOT keep entry in manifest (best-effort)", async () => {
    if (!Bun.which("git")) return;
    const projectDir = join(tmpDir, "proj-orphan-stray");
    initBareRepo(projectDir);
    const repoName = "proj-orphan-stray";
    const slug = "task-orphan-stray";
    const orphanPath = join(dirname(projectDir), `${repoName}-${slug}-s1`);
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, "user-WIP.txt"), "important\n");

    recordDeferredCleanup(makeEntry({
      timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
      projectDir,
      taskId: slug,
      slot: 1,
      worktreePaths: [orphanPath],
      branches: [],
      tmuxSessionNames: [],
      peerSyncLink: null,
    }));

    // Silence expected console.error about the deferred cleanup completing.
    const origErr = console.error;
    console.error = () => {};
    try {
      await processDeferredCleanups(25);
    } finally {
      console.error = origErr;
    }

    // Stray file is preserved — the purge fallback declined to touch it.
    expect(existsSync(join(orphanPath, "user-WIP.txt"))).toBe(true);
    // Best-effort: the entry is NOT pushed back into `remaining` because the
    // purge fallback's classify-only failure does not flip `failed`.
    expect(loadDeferredCleanups()).toHaveLength(0);
  });
});

describe("config cleanupDelayHours", () => {
  test("returns 25 by default (no config file)", () => {
    expect(cleanupDelayHours()).toBe(25);
  });
});

// task-f60547cd: explicit harnessDir argument must isolate cleanup manifests from
// the process-global LUDICS_HARNESS_DIR. The env-var-based tests above only prove
// backward compatibility via default-arg fallback; these tests prove the bypass
// is actually closed for callers who pass an explicit harnessDir.
describe("explicit harnessDir argument (isolation)", () => {
  let ISO = "";
  beforeEach(() => {
    ISO = join(tmpDir, "iso");
    mkdirSync(join(ISO, "mag"), { recursive: true });
  });

  test("recordDeferredCleanup writes manifest under explicit harnessDir, not the env-var decoy", () => {
    const entry = makeEntry({ taskId: "task-iso" });
    // tmpDir is the env-var harness (the decoy here). ISO is the explicit target.
    recordDeferredCleanup(entry, ISO);

    const isoFile = join(ISO, "mag", "cleanup-pending.json");
    const envFile = join(tmpDir, "mag", "cleanup-pending.json");
    expect(existsSync(isoFile)).toBe(true);
    expect(existsSync(envFile)).toBe(false);

    // cleanupPendingPath reports the correct path for the explicit arg.
    expect(cleanupPendingPath(ISO)).toBe(isoFile);
  });

  test("loadDeferredCleanups(ISO) ignores manifests under the env-var harness", () => {
    // Seed the env-var harness with an entry — loading with the explicit arg must not see it.
    recordDeferredCleanup(makeEntry({ taskId: "env-task" })); // default arg → env-var harness
    recordDeferredCleanup(makeEntry({ taskId: "iso-task" }), ISO); // explicit → ISO

    const envEntries = loadDeferredCleanups(); // default arg → env-var harness
    const isoEntries = loadDeferredCleanups(ISO);

    expect(envEntries.map((e) => e.taskId)).toEqual(["env-task"]);
    expect(isoEntries.map((e) => e.taskId)).toEqual(["iso-task"]);
  });

  test("cancelDeferredCleanup(taskId, slot, ISO) only affects the explicit-harness manifest", () => {
    recordDeferredCleanup(makeEntry({ taskId: "shared", slot: 1 })); // env-var harness
    recordDeferredCleanup(makeEntry({ taskId: "shared", slot: 1 }), ISO);
    cancelDeferredCleanup("shared", 1, ISO);
    expect(loadDeferredCleanups().map((e) => e.taskId)).toEqual(["shared"]); // env-var unchanged
    expect(loadDeferredCleanups(ISO)).toEqual([]); // ISO cleared
  });

  test("processDeferredCleanups(_, ISO) reads and clears the explicit-harness manifest", async () => {
    // Old-enough entry (30h ago) with no worktrees/branches so cleanup is a no-op.
    const entry = makeEntry({
      timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
      worktreePaths: [], branches: [], tmuxSessionNames: [], peerSyncLink: null,
    });
    recordDeferredCleanup(entry, ISO);
    await processDeferredCleanups(25, ISO);
    expect(loadDeferredCleanups(ISO)).toEqual([]);
  });

  // Reviewer AC7 blocking item: prove the t3codeThreadIds branch passes the
  // explicit harnessDir arg through to serverStatus({ harnessDir }).
  // Uses the spyOn() pattern (see docs/testing-patterns.md) so the
  // replacement does not leak across test files in the Bun runner.
  test("processDeferredCleanups(_, ISO) passes ISO to serverStatus({ harnessDir }) in the t3codeThreadIds branch", async () => {
    // task-703d0553: under the paused-skip gate, serverStatus is only reached when
    // integration is ENABLED. Enable it so this test exercises the harnessDir
    // threading + retain-on-not-running path it was written to cover.
    const enabledSpy = spyOn(config, "t3codeIntegrationEnabled").mockReturnValue(true);
    const capturedHarnessDirs: string[] = [];
    const serverStatusSpy = spyOn(t3codeServer, "serverStatus").mockImplementation(
      async (options: { harnessDir?: string } = {}) => {
        capturedHarnessDirs.push(options.harnessDir ?? "<default>");
        // Return "not running" to short-circuit before any T3CodeClient construction.
        return { running: false, record: null, snapshot: null, reason: "stubbed" };
      },
    );

    try {
      // Entry must be old enough to process AND carry t3codeThreadIds to enter the branch.
      // Empty worktreePaths/branches/sessions so the other cleanup steps are no-ops.
      const entry = makeEntry({
        timestamp: new Date(Date.now() - 30 * 3600000).toISOString(),
        worktreePaths: [], branches: [], tmuxSessionNames: [], peerSyncLink: null,
        t3codeThreadIds: ["thread-abc", "thread-def"],
      });
      recordDeferredCleanup(entry, ISO);

      await processDeferredCleanups(25, ISO);

      // serverStatus was invoked exactly once, with ISO — not the env-var decoy (tmpDir).
      expect(capturedHarnessDirs).toHaveLength(1);
      expect(capturedHarnessDirs[0]).toBe(ISO);
      expect(capturedHarnessDirs[0]).not.toBe(tmpDir);

      // Because the stub returned {running: false} with integration enabled, the
      // branch marks retryableFailure=true and the entry remains in the ISO manifest
      // (proves the path-handling also threaded ISO).
      const remaining = loadDeferredCleanups(ISO);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.t3codeThreadIds).toEqual(["thread-abc", "thread-def"]);
    } finally {
      serverStatusSpy.mockRestore();
      enabledSpy.mockRestore();
    }
  });
});
