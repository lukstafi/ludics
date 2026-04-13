import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slotAssign, slotResume, slotStart, slotSetMode, slotStop, runSlot, markSlotSetupFailed } from "./index.ts";
import { persistState, defaultOrchestrationConfig, initAgentRuntimeState, readOrchestrationState, type OrchestrationState } from "../orchestration/state.ts";
import { tmuxKillSession, tmuxHasSession } from "../adapters/tmux.ts";
import { existsSync } from "fs";
import { getIntentForDashboard, clearIntent } from "../cluster-http.ts";
import { heartbeatsDir as getHeartbeatsDir } from "../cluster.ts";
import { writeSlotJson, readSlotJson, emptySlotData } from "./json.ts";

setDefaultTimeout(15_000);

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
let TMP = "";

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`);
  return configPath;
}

function writeTask(tasksDir: string, id: string, title: string): void {
  writeFileSync(join(tasksDir, `${id}.md`), `---
id: ${id}
title: "${title}"
project: demo
status: ready
priority: B
deadline: null
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
effort: medium
context: demo
uses_browser: false
slot: null
adapter: null
created: 2026-03-07
started: null
completed: null
modified: null
source: local
---
`);
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-slots-index-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }

  if (ORIGINAL_CONFIG === undefined) {
    delete process.env.LUDICS_CONFIG;
  } else {
    process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  }

  rmSync(TMP, { recursive: true, force: true });
});

describe("slotAssign", () => {
  test("treats existing watch task files as task IDs", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "watch-streams-cleanup", "Watch streams cleanup");

    slotAssign(1, "watch-streams-cleanup", "manual");

    const data = readSlotJson(1, harness);
    expect(data.process).toBe("Watch streams cleanup");
    expect(data.task).toBe("watch-streams-cleanup");

    const task = readFileSync(join(tasksDir, "watch-streams-cleanup.md"), "utf-8");
    expect(task).toContain("status: in-progress");
    expect(task).toContain("slot: 1");
    expect(task).toContain("adapter: manual");
  });

  test("keeps free-text descriptions as non-task assignments", () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);

    slotAssign(2, "Investigate slot detection", "manual");

    const data = readSlotJson(2, harness);
    expect(data.process).toBe("Investigate slot detection");
    expect(data.task).toBeNull();
  });
});

describe("slotResume guards", () => {
  test("rejects non-t3code mode slots", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-1", "Resume test");
    slotAssign(1, "task-resume-1", "manual");

    await expect(slotResume(1)).rejects.toThrow("resume only supports t3code");
  });

  test("rejects slots with no persisted t3code state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-2", "Resume test 2");
    slotAssign(1, "task-resume-2", "t3code");

    await expect(slotResume(1)).rejects.toThrow("slot start");
  });

  test("rejects slots with no persisted orchestration state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-3", "Resume test 3");
    slotAssign(1, "task-resume-3", "t3code");

    // Write t3code slot state but no orchestration state
    const t3codeDir = join(harness, "t3code");
    mkdirSync(t3codeDir, { recursive: true });
    writeFileSync(join(t3codeDir, "slot-1.json"), JSON.stringify({
      slot: 1,
      threads: [{ threadId: "t-1", projectId: "p-1", worktreePath: "/tmp/x", title: "test", model: "gpt-5.4", runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-03-25", updatedAt: "2026-03-25" }],
    }));

    await expect(slotResume(1)).rejects.toThrow("orchestrated sessions");
  });
});

describe("slotStart guard", () => {
  test("refuses when recoverable orchestration state exists for same task", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-guard-1", "Guard test");
    slotAssign(1, "task-guard-1", "t3code", "", "", "--pair --coder claude-code");

    // Write orchestration state for the same task (not done)
    const orchDir = join(harness, "orchestration");
    mkdirSync(orchDir, { recursive: true });
    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-guard-1",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/project",
      rootWorktree: "/tmp/root",
      peerSyncDir: "/tmp/peersync",
      threadIds: {},
    };
    persistState(orchState, harness);

    await expect(slotStart(1)).rejects.toThrow("resume");
  });
});

describe("slot assign — direct orchestration flags", () => {
  function readAdapterArgs(): string {
    const harness = join(TMP, "ludics-state", "harness");
    const data = readSlotJson(1, harness);
    return data.adapterArgs ?? "";
  }

  test("builds adapter args from --pair --coder --reviewer --plan", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--pair", "--coder", "claude-code", "--reviewer", "codex", "--plan"]);
    expect(readAdapterArgs()).toBe("--pair --coder claude-code --reviewer codex --plan");
  });

  test("auto-prepends --pair when --coder/--reviewer given without it", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--coder", "foo", "--reviewer", "bar"]);
    expect(readAdapterArgs()).toBe("--pair --coder foo --reviewer bar");
  });

  test("auto-prepends --pair when --plan given without a mode flag", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--plan"]);
    expect(readAdapterArgs()).toBe("--pair --plan");
  });

  test("inserts --pair before first shorthand when -A fragment precedes it", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "-A", "--gather", "--coder", "foo"]);
    expect(readAdapterArgs()).toBe("--gather --pair --coder foo");
  });

  test("inserts --pair before --plan when -A fragment precedes it", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "-A", "--gather", "--plan"]);
    expect(readAdapterArgs()).toBe("--gather --pair --plan");
  });

  test("does not auto-prepend --pair when --pair is already present", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--pair", "--plan"]);
    expect(readAdapterArgs()).toBe("--pair --plan");
  });

  test("preserves -A fragment appended after direct flags", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--pair", "--coder", "foo", "-A", "--gather"]);
    expect(readAdapterArgs()).toBe("--pair --coder foo --gather");
  });

  test("errors when --coder value is missing", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await expect(runSlot(["1", "assign", "My task", "-a", "t3code", "--coder"])).rejects.toThrow("requires a provider value");
  });

  test("errors when --reviewer value is missing", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await expect(runSlot(["1", "assign", "My task", "-a", "t3code", "--reviewer"])).rejects.toThrow("requires a provider value");
  });

  test("errors when shorthand orch flag used with non-t3code adapter", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await expect(runSlot(["1", "assign", "My task", "-a", "manual", "--pair"])).rejects.toThrow('require adapter "t3code"');
  });

  test("does NOT error when only -A is used with non-t3code adapter", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await expect(runSlot(["1", "assign", "My task", "-a", "manual", "-A", "--pair --coder foo"])).resolves.toBeUndefined();
    expect(readAdapterArgs()).toBe("--pair --coder foo");
  });

  test("--duo in -A triggers hierarchical duo expansion into two pair-mode slots", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "-A", "--duo", "--plan"]);
    // --duo expands into two pair slots with swapped coder/reviewer and --duo-peer-slot
    const args = readAdapterArgs();
    expect(args).toContain("--pair");
    expect(args).toContain("--duo-peer-slot=");
    expect(args).toContain("--plan");
  });

  test("direct --duo shorthand triggers hierarchical duo expansion", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--duo", "--plan"]);
    const args = readAdapterArgs();
    expect(args).toContain("--pair");
    expect(args).toContain("--duo-peer-slot=");
    expect(args).toContain("--plan");
  });

  test("does not inject --pair when -A already contains --pair", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "-A", "--pair --coder existing", "--plan"]);
    expect(readAdapterArgs()).toBe("--pair --coder existing --plan");
  });

  test("errors when --coder value looks like a flag", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await expect(runSlot(["1", "assign", "My task", "-a", "t3code", "--coder", "--reviewer"])).rejects.toThrow("got a flag instead");
  });

  test("errors when --reviewer value looks like a flag", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await expect(runSlot(["1", "assign", "My task", "-a", "t3code", "--reviewer", "--plan"])).rejects.toThrow("got a flag instead");
  });
});

describe("slotStart — t3code empty-args auto-fill", () => {
  function readAdapterArgsFromSlots(): string {
    const harness = join(TMP, "ludics-state", "harness");
    const data = readSlotJson(1, harness);
    return data.adapterArgs ?? "";
  }

  test("auto-fills orchestration flags when t3code slot has empty adapterArgs", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-empty-args-1", "Empty args test");
    // slotAssign with no adapterArgs stores "null" which makeAdapterContext converts to ""
    slotAssign(1, "task-empty-args-1", "t3code");
    // slotStart auto-fills flags then proceeds to adapter start (which fails in test env)
    try { await slotStart(1); } catch { /* adapter startup fails in test env */ }
    // Verify auto-filled flags were written back to slot block
    const args = readAdapterArgsFromSlots();
    expect(args).toContain("--pair");
    expect(args).toContain("--coder");
    expect(args).toContain("--reviewer");
  }, 15_000);

  test("auto-fills orchestration flags when adapterArgs is whitespace-only", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-whitespace-args-1", "Whitespace args test");
    // Assign with whitespace adapterArgs — stored as-is since "   " is truthy
    slotAssign(1, "task-whitespace-args-1", "t3code", "", "", "   ");
    // slotStart auto-fills flags then proceeds to adapter start (which fails in test env)
    try { await slotStart(1); } catch { /* adapter startup fails in test env */ }
    // Verify auto-filled flags were written back to slot block
    const args = readAdapterArgsFromSlots();
    expect(args).toContain("--pair");
    expect(args).toContain("--coder");
    expect(args).toContain("--reviewer");
  }, 15_000);

  test("throws when no task is assigned and adapterArgs is empty", async () => {
    // Assign with no task — slotAssign requires a task, so use slotSetMode instead
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    slotAssign(1, "null", "t3code");
    await expect(slotStart(1)).rejects.toThrow("no task is assigned");
  });
});

describe("markSlotSetupFailed", () => {
  test("marks slot as interrupted without clearing it", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-setup-fail-1", "Setup fail test");

    slotAssign(1, "task-setup-fail-1", "tmux");

    // Task should be in-progress after assign
    const taskBefore = readFileSync(join(tasksDir, "task-setup-fail-1.md"), "utf-8");
    expect(taskBefore).toContain("status: in-progress");

    markSlotSetupFailed(1, "tmux session creation failed");

    // Slot should NOT be empty — process should still be set
    const data = readSlotJson(1, harness);
    expect(data.process).toBe("Setup fail test");
    expect(data.liveness).toBe("interrupted");

    // Task status should be reset to ready (not orphaned in-progress)
    const taskAfter = readFileSync(join(tasksDir, "task-setup-fail-1.md"), "utf-8");
    expect(taskAfter).toContain("status: ready");
  });

  test("does not reset task status if not in-progress", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    // Write a task with "ready" status explicitly
    writeFileSync(join(tasksDir, "task-setup-fail-2.md"), `---
id: task-setup-fail-2
title: "Already ready"
project: demo
status: ready
priority: B
slot: 1
---
`);

    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    slotAssign(1, "task-setup-fail-2", "tmux");
    markSlotSetupFailed(1, "worktree creation failed");

    const data = readSlotJson(1, harness);
    expect(data.liveness).toBe("interrupted");
  });
});

describe("slotResume — interrupted fallback to fresh start", () => {
  // Track tmux sessions created during tests so we can clean them up.
  // slotResume/slotStart may create real tmux sessions as a side effect.
  const createdTmuxSessions: string[] = [];
  afterEach(() => {
    for (const session of createdTmuxSessions) {
      try { if (tmuxHasSession(session)) tmuxKillSession(session); } catch { /* ignore */ }
    }
    createdTmuxSessions.length = 0;
  });

  test("falls back to slotStart when interrupted slot has no orchestration state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-fallback-1", "Resume fallback test");

    // Assign and mark as interrupted (simulating pre-persistState failure)
    slotAssign(1, "task-resume-fallback-1", "tmux", "", "", "--pair --coder claude --reviewer claude");
    markSlotSetupFailed(1, "worktree creation failed");

    // slotResume should fall back to slotStart, which will fail because tmux
    // isn't available in test — but it should NOT throw the "no persisted
    // orchestration state" error.
    // Register possible tmux sessions for cleanup (slotStart may create these)
    createdTmuxSessions.push(
      "s1_coder_task-resume-fallback-1", "s1_reviewer_task-resume-fallback-1",
    );
    try {
      await slotResume(1, { startTtyd: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Should NOT be the old "no persisted orchestration state" error
      expect(msg).not.toContain("no persisted orchestration state");
      // Instead it should be a slotStart error (adapter-level failure is expected in test)
    }
  });

  test("cleans stale orch state when interrupted slot has orch state but incomplete setup", async () => {
    // Regression test for: setup fails after persistState() but before
    // writeSlotState()/writeTmuxSlotState(). Resume should clean up stale
    // orch state and fall back to slotStart, not loop into "use resume" error.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    const orchDir = join(harness, "orchestration");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(orchDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-fallback-2", "Post-persistState failure");

    // Use tmux mode (fails fast in test, unlike t3code which hangs on ensureServer)
    slotAssign(1, "task-resume-fallback-2", "tmux", "", "", "--pair --coder claude --reviewer claude");
    markSlotSetupFailed(1, "runner start failed after persistState");

    // Simulate: orchestration state was persisted before the failure,
    // but tmux slot state was NOT written (the failure point).
    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-resume-fallback-2",
      mode: "pair",
      phase: "setup",
      round: 1,
      mergeRound: 0,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "sonnet", branch: "test-coder", worktreePath: "/tmp/wt-coder" },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "sonnet", branch: "test-reviewer", worktreePath: "/tmp/wt-reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      config: defaultOrchestrationConfig({}),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/fake-project",
      rootWorktree: "/tmp/fake-root",
      peerSyncDir: "/tmp/fake-peersync",
      threadIds: {},
      backend: "tmux",
      slotTitle: "test",
    };
    persistState(orchState, harness);

    // Verify the stale orch state file exists before resume
    const { existsSync } = await import("fs");
    const orchFile = join(orchDir, "slot-1.json");
    expect(existsSync(orchFile)).toBe(true);

    // slotResume sees orch state exists → passes orch-state guard → but
    // tmux slot state is missing. For tmux it reaches the resume logic.
    // The key assertion: it should NOT throw "has recoverable orchestration state"
    // (which was the loop bug when falling back to slotStart with stale orch).
    // Register possible tmux sessions for cleanup
    createdTmuxSessions.push(
      "s1_coder_task-resume-fallback-2", "s1_reviewer_task-resume-fallback-2",
    );
    try {
      await slotResume(1, { startTtyd: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("has recoverable orchestration state");
    }
  });
});

describe("slotSetMode — preserve state on mode toggle", () => {
  function makeOrchState(harness: string, slot: number, taskId: string): OrchestrationState {
    const orchDir = join(harness, "orchestration");
    mkdirSync(orchDir, { recursive: true });
    const orchState: OrchestrationState = {
      slot,
      taskId,
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/project",
      rootWorktree: "/tmp/root",
      peerSyncDir: "/tmp/peersync",
      threadIds: {},
      backend: "tmux",
    };
    persistState(orchState, harness);
    return orchState;
  }

  function stampSessionStarted(harness: string, slot: number = 1): void {
    const data = readSlotJson(slot, harness);
    data.sessionStarted = "2026-04-03T20:00Z";
    writeSlotJson(slot, data, harness);
  }

  test("toggling active tmux slot to manual preserves orchestration state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-toggle-1", "Toggle test");
    slotAssign(1, "task-toggle-1", "tmux");

    makeOrchState(harness, 1, "task-toggle-1");
    stampSessionStarted(harness);

    await slotSetMode(1, "manual");

    // Mode should be updated
    const data = readSlotJson(1, harness);
    expect(data.mode).toBe("manual");

    // Session Started should be cleared
    expect(data.sessionStarted).toBeNull();

    // Orchestration state should still exist (preserved)
    const orchState = readOrchestrationState(1, harness);
    expect(orchState).not.toBeNull();
    expect(orchState!.taskId).toBe("task-toggle-1");

    // Task frontmatter adapter field should be updated
    const task = readFileSync(join(tasksDir, "task-toggle-1.md"), "utf-8");
    expect(task).toContain("adapter: manual");
  });

  test("toggling active t3code slot to manual preserves orchestration state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-toggle-2", "Toggle test t3code");
    slotAssign(1, "task-toggle-2", "t3code");

    makeOrchState(harness, 1, "task-toggle-2");
    stampSessionStarted(harness);

    await slotSetMode(1, "manual");

    const data = readSlotJson(1, harness);
    expect(data.mode).toBe("manual");
    expect(data.sessionStarted).toBeNull();

    const orchState = readOrchestrationState(1, harness);
    expect(orchState).not.toBeNull();
  });

  test("toggling from manual to automated with active session is still rejected", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-toggle-3", "Toggle reject test");
    slotAssign(1, "task-toggle-3", "manual");
    stampSessionStarted(harness);

    await expect(slotSetMode(1, "t3code")).rejects.toThrow("has an active session");
  });

  test("runSlot mode subcommand awaits slotSetMode correctly", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-toggle-4", "CLI toggle test");
    slotAssign(1, "task-toggle-4", "tmux");

    makeOrchState(harness, 1, "task-toggle-4");
    stampSessionStarted(harness);

    await runSlot(["1", "mode", "manual"]);

    const data = readSlotJson(1, harness);
    expect(data.mode).toBe("manual");
  });
});

describe("slotStop — preserve-state flag", () => {
  test("slotStop with preserveState clears Session Started but keeps orch state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-preserve-1", "Preserve stop test");
    slotAssign(1, "task-preserve-1", "tmux");

    // Write orchestration state
    const orchDir = join(harness, "orchestration");
    mkdirSync(orchDir, { recursive: true });
    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-preserve-1",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/project",
      rootWorktree: "/tmp/root",
      peerSyncDir: "/tmp/peersync",
      threadIds: {},
      backend: "tmux",
    };
    persistState(orchState, harness);

    // Stamp session started
    const slotData = readSlotJson(1, harness);
    slotData.sessionStarted = "2026-04-03T20:00Z";
    writeSlotJson(1, slotData, harness);

    await slotStop(1, false, true);

    // Session Started should be cleared
    const data = readSlotJson(1, harness);
    expect(data.sessionStarted).toBeNull();

    // Orchestration state should still exist
    expect(readOrchestrationState(1, harness)).not.toBeNull();
  });

  test("CLI --preserve-state flag is parsed", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-preserve-2", "CLI preserve test");
    slotAssign(1, "task-preserve-2", "tmux");

    // Write orch state
    const orchDir = join(harness, "orchestration");
    mkdirSync(orchDir, { recursive: true });
    persistState({
      slot: 1,
      taskId: "task-preserve-2",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/project",
      rootWorktree: "/tmp/root",
      peerSyncDir: "/tmp/peersync",
      threadIds: {},
      backend: "tmux",
    } satisfies OrchestrationState, harness);

    await runSlot(["1", "stop", "--preserve-state"]);

    // Orchestration state should still exist
    expect(readOrchestrationState(1, harness)).not.toBeNull();
  });
});

describe("remote slot dispatch via HTTP", () => {
  // In test env without cluster config, isRemoteMachine("worker-a") returns true
  // because clusterCurrentMachineName() returns null (fail-closed).
  // clusterMachine("worker-a") returns undefined (no config) → fail-fast.

  test("remote slotStart fails fast when no cluster config for machine", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-1", "Remote start test");

    // Create a fresh heartbeat so heartbeatIsFresh("worker-a") returns true
    const hbDir = getHeartbeatsDir();
    mkdirSync(hbDir, { recursive: true });
    writeFileSync(join(hbDir, "worker-a.json"), JSON.stringify({ epoch: Math.floor(Date.now() / 1000) }));

    slotAssign(1, "task-remote-1", "tmux", "", "", "", "worker-a");

    // Should throw — no cluster config for "worker-a"
    await expect(slotStart(1)).rejects.toThrow("no cluster config for machine worker-a");

    // Session Started should NOT be stamped on controller side
    const data = readSlotJson(1, harness);
    expect(data.sessionStarted).toBeNull();
  });

  test("remote slotStart fails fast when machine is offline", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-1b", "Remote start offline test");

    slotAssign(1, "task-remote-1b", "tmux", "", "", "", "worker-a");

    // No heartbeat → machine offline
    await expect(slotStart(1)).rejects.toThrow("offline — cannot start");
  });

  test("remote slotStop (non-force) writes a stop intent and returns early", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-2", "Remote stop test");

    // Create a fresh heartbeat so heartbeatIsFresh("worker-a") returns true
    const hbDir = getHeartbeatsDir();
    mkdirSync(hbDir, { recursive: true });
    writeFileSync(join(hbDir, "worker-a.json"), JSON.stringify({ epoch: Math.floor(Date.now() / 1000) }));

    slotAssign(1, "task-remote-2", "tmux", "", "", "", "worker-a");

    // Stamp Session Started to simulate an active session
    const slotData = readSlotJson(1, harness);
    slotData.sessionStarted = "2026-04-04T20:00Z";
    writeSlotJson(1, slotData, harness);

    await slotStop(1, false, false);

    // Intent should be recorded in memory (pure pull model)
    const intent = getIntentForDashboard(1);
    expect(intent).not.toBeNull();
    expect(intent!.action).toBe("stop");
    expect(intent!.machine).toBe("worker-a");

    // Session Started should NOT be cleared (early return before cleanup)
    const data = readSlotJson(1, harness);
    expect(data.sessionStarted).toBe("2026-04-04T20:00Z");

    clearIntent(1);
  });

  test("remote slotStop with --force does not write intent, clears state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-3", "Remote force stop test");

    slotAssign(1, "task-remote-3", "tmux", "", "", "", "worker-a");

    await slotStop(1, true, false);

    // No intent recorded — force stop skips remote dispatch
    const intent = getIntentForDashboard(1);
    expect(intent).toBeNull();

    // Session Started should be cleared (force path runs cleanup)
    const data = readSlotJson(1, harness);
    expect(data.sessionStarted).toBeNull();
  });

  test("remote slotStop (non-force) fails fast when machine is offline", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-stop-offline", "Remote stop offline test");

    slotAssign(1, "task-remote-stop-offline", "tmux", "", "", "", "worker-a");

    // No heartbeat → machine offline
    await expect(slotStop(1, false, false)).rejects.toThrow("offline — cannot stop");
  });

  test("remote slotResume fails fast when machine is offline", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-4", "Remote resume test");

    slotAssign(1, "task-remote-4", "tmux", "", "", "", "worker-a");

    // No heartbeat → machine offline → should throw
    await expect(slotResume(1)).rejects.toThrow("offline — cannot resume");
  });

  test("remote slotResume fails fast when no cluster config for machine", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-4b", "Remote resume config test");

    // Create a fresh heartbeat
    const hbDir = getHeartbeatsDir();
    mkdirSync(hbDir, { recursive: true });
    writeFileSync(join(hbDir, "worker-a.json"), JSON.stringify({ epoch: Math.floor(Date.now() / 1000) }));

    slotAssign(1, "task-remote-4b", "tmux", "", "", "", "worker-a");

    // Heartbeat is fresh but no cluster config → should throw
    await expect(slotResume(1)).rejects.toThrow("no cluster config for machine worker-a");
  });
});
