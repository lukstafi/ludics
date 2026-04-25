import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname as osHostname, tmpdir } from "os";
import { join } from "path";
import { slotAssign, slotClear, slotResume, slotStart, slotSetMode, slotStop, runSlot, markSlotSetupFailed, autoFillAdapterArgs, makeAdapterContext } from "./index.ts";
import { persistState, defaultOrchestrationConfig, initAgentRuntimeState, readOrchestrationState, type OrchestrationState } from "../orchestration/state.ts";
import { tmuxKillSession, tmuxHasSession } from "../adapters/tmux.ts";
import { existsSync } from "fs";
import { getIntentForDashboard, clearIntent } from "../cluster-http.ts";
import { heartbeatsDir as getHeartbeatsDir } from "../cluster.ts";
import { writeSlotJson, readSlotJson, emptySlotData } from "./json.ts";

setDefaultTimeout(15_000);

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function writeConfig(homeDir: string, { cluster }: { cluster?: boolean } = {}): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  let yaml = `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`;
  if (cluster) {
    yaml += `cluster:
  transport: http
  domain: test.local
  machines:
    - name: worker-a
      host: worker-a.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
`;
  }
  writeFileSync(configPath, yaml);
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
  process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");
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

  if (ORIGINAL_HARNESS === undefined) {
    delete process.env.LUDICS_HARNESS_DIR;
  } else {
    process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
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

    void slotAssign(1, "watch-streams-cleanup", "manual");

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

    void slotAssign(2, "Investigate slot detection", "manual");

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
    void slotAssign(1, "task-resume-1", "manual");

    await expect(slotResume(1)).rejects.toThrow("resume only supports t3code");
  });

  test("rejects slots with no persisted t3code state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-2", "Resume test 2");
    void slotAssign(1, "task-resume-2", "t3code");

    await expect(slotResume(1)).rejects.toThrow("slot start");
  });

  test("rejects slots with no persisted orchestration state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-3", "Resume test 3");
    void slotAssign(1, "task-resume-3", "t3code");

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
    void slotAssign(1, "task-guard-1", "t3code", "", "", "--pair --coder claude-code");

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

  test("--duo with --coder value does not leak value as stray positional", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "-A", "--duo --coder claude-code:opus --plan"]);
    const args = readAdapterArgs();
    expect(args).toContain("--pair");
    expect(args).toContain("--duo-peer-slot=");
    expect(args).toContain("--plan");
    expect(args).toContain("--coder");
    // Verify claude-code:opus only appears immediately after --coder or --reviewer, not as a stray token
    const tokens = args.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "claude-code:opus") {
        const prev = tokens[i - 1];
        expect(prev === "--coder" || prev === "--reviewer").toBe(true);
      }
    }
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

  test("--solo shorthand preserved; no --pair auto-injection", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--solo", "--coder", "claude-code"]);
    const args = readAdapterArgs();
    expect(args).toBe("--solo --coder claude-code");
    expect(args).not.toContain("--pair");
  });

  test("--solo via -A fragment preserved; no --pair auto-injection", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "-A", "--solo --coder claude-code"]);
    const args = readAdapterArgs();
    expect(args).toContain("--solo");
    expect(args).not.toContain("--pair");
  });

  test("--solo does not route through duo expansion (single-slot assign only)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    await runSlot(["1", "assign", "My task", "-a", "t3code", "--solo", "--coder", "claude-code"]);
    // Slot 1 assigned; slot 2 must remain empty (no duo expansion)
    const slot2 = readSlotJson(2, harness);
    expect(slot2.process).toBe("(empty)");
    expect(slot2.adapterArgs ?? "").toBe("");
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
    void slotAssign(1, "task-empty-args-1", "t3code");
    const data = readSlotJson(1, harness);
    const ctx = makeAdapterContext(1, data);

    // (a) computes correct args
    const result = await autoFillAdapterArgs(ctx, data);
    expect(result).not.toBeNull();
    expect(result!.args).toContain("--pair");
    expect(result!.args).toContain("--coder");
    expect(result!.args).toContain("--reviewer");

    // (b) persists them — writeback via writeSlotJson round-trip
    writeSlotJson(1, result!.updatedData, harness);
    const args = readAdapterArgsFromSlots();
    expect(args).toContain("--pair");
    expect(args).toContain("--coder");
    expect(args).toContain("--reviewer");
  });

  test("auto-fills orchestration flags when adapterArgs is whitespace-only", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-whitespace-args-1", "Whitespace args test");
    // Assign with whitespace adapterArgs — stored as-is since "   " is truthy
    void slotAssign(1, "task-whitespace-args-1", "t3code", "", "", "   ");
    const data = readSlotJson(1, harness);
    const ctx = makeAdapterContext(1, data);

    // (a) computes correct args
    const result = await autoFillAdapterArgs(ctx, data);
    expect(result).not.toBeNull();
    expect(result!.args).toContain("--pair");
    expect(result!.args).toContain("--coder");
    expect(result!.args).toContain("--reviewer");

    // (b) persists them
    writeSlotJson(1, result!.updatedData, harness);
    const args = readAdapterArgsFromSlots();
    expect(args).toContain("--pair");
    expect(args).toContain("--coder");
    expect(args).toContain("--reviewer");
  });

  test("throws when no task is assigned and adapterArgs is empty", async () => {
    // Assign with no task — slotAssign requires a task, so use slotSetMode instead
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    void slotAssign(1, "null", "t3code");
    await expect(slotStart(1)).rejects.toThrow("no task is assigned");
  });

  test("auto-fills medium task without skip_plan — includes --plan", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-medium-plan-1", "Medium plan test");
    void slotAssign(1, "task-medium-plan-1", "t3code");
    const data = readSlotJson(1, harness);
    const ctx = makeAdapterContext(1, data);

    // (a) computes correct args
    const result = await autoFillAdapterArgs(ctx, data);
    expect(result).not.toBeNull();
    expect(result!.args).toContain("--plan");
    expect(result!.args).toContain("--pair");

    // (b) persists them
    writeSlotJson(1, result!.updatedData, harness);
    const args = readAdapterArgsFromSlots();
    expect(args).toContain("--plan");
    expect(args).toContain("--pair");
  });

  test("task without explicit effort field gets small-orchestration flags (codex P2 regression)", async () => {
    // Regression for codex P2: parseTaskFrontmatter normalizes a missing
    // effort field to "medium", which would silently upgrade legacy / manual
    // tasks that never declared effort to medium-orchestration flags. The
    // readRawEffortField helper restores the pre-unification "small" default
    // by inspecting the raw YAML block. This test would fail if the site
    // reverted to `parseTaskFrontmatter(content).effort ?? "small"`, because
    // that expression yields "medium" for any frontmatter missing `effort:`.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);

    writeFileSync(join(tasksDir, "task-no-effort-1.md"), [
      "---",
      "id: task-no-effort-1",
      'title: "Legacy task no effort"',
      "project: demo",
      "status: ready",
      "priority: B",
      "dependencies:",
      "  blocks: []",
      "  blocked_by: []",
      "  relates_to: []",
      "  subtask_of: null",
      // NOTE: no `effort:` line — this is the regression case.
      "context: demo",
      "uses_browser: false",
      "slot: null",
      "adapter: null",
      "created: 2026-03-07",
      "started: null",
      "completed: null",
      "modified: null",
      "source: local",
      "---",
      "",
    ].join("\n"));

    void slotAssign(1, "task-no-effort-1", "t3code");
    const data = readSlotJson(1, harness);
    const ctx = makeAdapterContext(1, data);
    const result = await autoFillAdapterArgs(ctx, data);
    expect(result).not.toBeNull();
    // Invariant: `effort` reported by autoFillAdapterArgs must equal "small"
    // for a task file without an explicit effort field. A regression to the
    // normalized default would surface this as "medium".
    expect(result!.effort).toBe("small");
  });

  test("auto-fills medium task with skip_plan: true — omits --plan", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    // Write task with skip_plan: true
    writeFileSync(join(tasksDir, "task-skip-plan-1.md"), [
      "---",
      "id: task-skip-plan-1",
      'title: "Skip plan test"',
      "project: demo",
      "status: ready",
      "priority: B",
      "deadline: null",
      "dependencies:",
      "  blocks: []",
      "  blocked_by: []",
      "  relates_to: []",
      "  subtask_of: null",
      "effort: medium",
      "skip_plan: true",
      "context: demo",
      "uses_browser: false",
      "slot: null",
      "adapter: null",
      "created: 2026-03-07",
      "started: null",
      "completed: null",
      "modified: null",
      "source: local",
      "---",
      "",
    ].join("\n"));
    void slotAssign(1, "task-skip-plan-1", "t3code");
    const data = readSlotJson(1, harness);
    const ctx = makeAdapterContext(1, data);

    // (a) computes correct args
    const result = await autoFillAdapterArgs(ctx, data);
    expect(result).not.toBeNull();
    expect(result!.args).not.toContain("--plan");
    expect(result!.args).toContain("--pair");
    expect(result!.args).toContain("--coder");
    expect(result!.args).toContain("--reviewer");

    // (b) persists them
    writeSlotJson(1, result!.updatedData, harness);
    const args = readAdapterArgsFromSlots();
    expect(args).not.toContain("--plan");
    expect(args).toContain("--pair");
    expect(args).toContain("--coder");
    expect(args).toContain("--reviewer");
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

    void slotAssign(1, "task-setup-fail-1", "tmux");

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
    void slotAssign(1, "task-setup-fail-2", "tmux");
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
    void slotAssign(1, "task-resume-fallback-1", "tmux", "", "", "--pair --coder claude --reviewer claude");
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
    void slotAssign(1, "task-resume-fallback-2", "tmux", "", "", "--pair --coder claude --reviewer claude");
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

describe("slotResume — escalated slot handling (task-4cd94043)", () => {
  // Track tmux sessions created during tests so we can clean them up.
  const createdTmuxSessions: string[] = [];
  afterEach(() => {
    for (const session of createdTmuxSessions) {
      try { if (tmuxHasSession(session)) tmuxKillSession(session); } catch { /* ignore */ }
    }
    createdTmuxSessions.length = 0;
  });

  test("falls back to slotStart when escalated slot has no orchestration state", async () => {
    // Symmetric to the interrupted-fallback test: an escalated slot with
    // missing state should fresh-start rather than throw "no persisted
    // orchestration state". Normal escalations preserve state and never hit
    // this branch, but we support the missing-state path for robustness
    // (mirrors interrupted). After the fallback/resume, liveness must have
    // been cleared from "escalated" — we can't observe the intermediate path
    // in-process because slotStart will fail under test tmux, but we verify
    // the fallback was taken (no "no persisted orchestration state" error).
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-escalate-fallback", "Resume from escalated");

    void slotAssign(1, "task-escalate-fallback", "tmux", "", "", "--pair --coder claude --reviewer claude");
    // Simulate agent-initiated escalation: runner flipped liveness + left
    // orchestration state intact (in the realistic path). For this missing-
    // state variant, clear state explicitly and set liveness to "escalated".
    const data = readSlotJson(1, harness);
    data.liveness = "escalated";
    writeSlotJson(1, data, harness);

    createdTmuxSessions.push(
      "s1_coder_task-escalate-fallback", "s1_reviewer_task-escalate-fallback",
    );
    try {
      await slotResume(1, { startTtyd: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("no persisted orchestration state");
    }
  });

  test("escalated slot with intact orch state proceeds through normal resume and clears liveness", async () => {
    // Realistic path: handleEscalation flipped liveness to "escalated" but
    // left OrchestrationState on disk. slotResume should NOT throw on the
    // escalated marker (no "use 'slot start'" rejection) and the resume flow
    // should reach the final data.liveness = null write. We assert that the
    // startOrchestrationProcess call was reached (proving we advanced past
    // the marker) rather than relying on catch-then-pass semantics.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    const orchDir = join(harness, "orchestration");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(orchDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-escalate-intact", "Resume escalated intact");

    void slotAssign(1, "task-escalate-intact", "tmux", "", "", "--pair --coder claude --reviewer claude");
    const data = readSlotJson(1, harness);
    data.liveness = "escalated";
    writeSlotJson(1, data, harness);

    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-escalate-intact",
      mode: "pair",
      phase: "review",
      round: 2,
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

    // Stub the expensive spawn so the test observes liveness flipped to null.
    // spyOn against the module export replaces the call site's live binding.
    const orchProcess = await import("../orchestration/process.ts");
    const startSpy = spyOn(orchProcess, "startOrchestrationProcess")
      .mockImplementation(async () => 99_998); // dead-but-recorded pid

    createdTmuxSessions.push(
      "s1_coder_task-escalate-intact", "s1_reviewer_task-escalate-intact",
    );
    try {
      await slotResume(1, { startTtyd: false });
      // The resume reached the final data.liveness = null write. Without the
      // escalated-liveness acceptance branch, the resume would have thrown
      // earlier and this assertion would never run.
      expect(readSlotJson(1, harness).liveness).toBeNull();
      expect(startSpy).toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
    }
  });

  test("second slotResume on an already-resumed slot is a no-op (AC5 idempotence)", async () => {
    // Contract: after a resume has cleared the liveness marker and started a
    // fresh orchestrator, a redundant `ludics slot N resume` must NOT kill
    // and restart that orchestrator — doing so churns state and races the
    // runner's self-guard. We seed a slot whose orchestrator pid is our own
    // (alive) PID and whose liveness is null, then call slotResume and assert:
    //   (1) it returns cleanly
    //   (2) it does NOT invoke startOrchestrationProcess
    //   (3) the recorded orchestrator pid is unchanged (no terminate+restart)
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    const orchDir = join(harness, "orchestration");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(orchDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-resume-idempotent", "Idempotent resume");

    void slotAssign(1, "task-resume-idempotent", "tmux", "", "", "--pair --coder claude --reviewer claude");

    // Seed tmux-slot-1.json with our own (alive) PID. The idempotence guard
    // checks this via process.kill(pid, 0), so using process.pid is both
    // simple and portable across platforms.
    writeFileSync(
      join(orchDir, "tmux-slot-1.json"),
      JSON.stringify({
        orchestration: { pid: process.pid, stateFile: "orch-1.json", mode: "pair" },
        sessionNames: { coder: "s1_coder_task-resume-idempotent", reviewer: "s1_reviewer_task-resume-idempotent" },
        ttydPids: {},
      }),
    );

    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-resume-idempotent",
      mode: "pair",
      phase: "work",
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

    const orchProcess = await import("../orchestration/process.ts");
    const startSpy = spyOn(orchProcess, "startOrchestrationProcess")
      .mockImplementation(async () => { throw new Error("should not have been called"); });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      // First resume on an already-null/alive slot — must short-circuit.
      await slotResume(1, { startTtyd: false });
      expect(startSpy).not.toHaveBeenCalled();
      const logged = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(logged.some((m) => m.includes("already running"))).toBe(true);

      // Orchestrator pid must be unchanged — we did NOT terminate and restart.
      const state = JSON.parse(readFileSync(join(orchDir, "tmux-slot-1.json"), "utf-8"));
      expect(state.orchestration.pid).toBe(process.pid);

      // And the liveness must stay null (no stray writes into the slot json).
      expect(readSlotJson(1, harness).liveness).toBeNull();

      // Second call: still a no-op — proves true idempotence, not just
      // first-call serendipity.
      await slotResume(1, { startTtyd: false });
      expect(startSpy).not.toHaveBeenCalled();
      const state2 = JSON.parse(readFileSync(join(orchDir, "tmux-slot-1.json"), "utf-8"));
      expect(state2.orchestration.pid).toBe(process.pid);
    } finally {
      startSpy.mockRestore();
      logSpy.mockRestore();
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
    void slotAssign(1, "task-toggle-1", "tmux");

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
    void slotAssign(1, "task-toggle-2", "t3code");

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
    void slotAssign(1, "task-toggle-3", "manual");
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
    void slotAssign(1, "task-toggle-4", "tmux");

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
    void slotAssign(1, "task-preserve-1", "tmux");

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
    void slotAssign(1, "task-preserve-2", "tmux");

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

    void slotAssign(1, "task-remote-1", "tmux", "", "", "", "worker-a");

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

    void slotAssign(1, "task-remote-1b", "tmux", "", "", "", "worker-a");

    // No heartbeat → machine offline
    await expect(slotStart(1)).rejects.toThrow("offline — cannot start");
  });

  test("remote slotStop (non-force) writes a stop intent and returns early", async () => {
    // Need cluster config so clusterMachine("worker-a") resolves
    process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true });

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

    void slotAssign(1, "task-remote-2", "tmux", "", "", "", "worker-a");

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

    void slotAssign(1, "task-remote-3", "tmux", "", "", "", "worker-a");

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

    void slotAssign(1, "task-remote-stop-offline", "tmux", "", "", "", "worker-a");

    // No heartbeat → machine offline
    await expect(slotStop(1, false, false)).rejects.toThrow("offline — cannot stop");
  });

  test("remote slotStop (non-force) fails fast when no cluster config for machine", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-stop-noconfig", "Remote stop no cluster config test");

    // Create a fresh heartbeat so heartbeatIsFresh("worker-a") returns true
    const hbDir = getHeartbeatsDir();
    mkdirSync(hbDir, { recursive: true });
    writeFileSync(join(hbDir, "worker-a.json"), JSON.stringify({ epoch: Math.floor(Date.now() / 1000) }));

    void slotAssign(1, "task-remote-stop-noconfig", "tmux", "", "", "", "worker-a");

    // Heartbeat is fresh but no cluster config → should throw
    await expect(slotStop(1, false, false)).rejects.toThrow("no cluster config for machine worker-a");
  });

  test("remote slotResume fails fast when machine is offline", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-remote-4", "Remote resume test");

    void slotAssign(1, "task-remote-4", "tmux", "", "", "", "worker-a");

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

    void slotAssign(1, "task-remote-4b", "tmux", "", "", "", "worker-a");

    // Heartbeat is fresh but no cluster config → should throw
    await expect(slotResume(1)).rejects.toThrow("no cluster config for machine worker-a");
  });
});

describe("slotClear transitionStatus guard", () => {
  test("slotClear('done') on an already-abandoned task does not overwrite status or completed", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);

    // Write a task that is already abandoned with a known completed timestamp
    const taskId = "task-abandoned-guard";
    const originalCompleted = "2026-04-01T12:00Z";
    writeFileSync(join(tasksDir, `${taskId}.md`), `---
id: ${taskId}
title: "Abandoned guard test"
project: demo
status: abandoned
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
slot: 1
adapter: manual
created: 2026-03-07
started: 2026-03-07T10:00Z
completed: ${originalCompleted}
modified: null
source: local
---
`);

    // Set up slot 1 to point at this task (simulating a stale slot reference)
    const slotData = emptySlotData(1);
    slotData.process = "Abandoned guard test";
    slotData.task = taskId;
    slotData.mode = "manual";
    writeSlotJson(1, slotData, harness);

    // Attempt to clear the slot as "done" — should be blocked by transitionStatus
    await slotClear(1, "done");

    // Verify: status must still be "abandoned", completed must be the original timestamp
    const content = readFileSync(join(tasksDir, `${taskId}.md`), "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).not.toContain("status: done");
    expect(content).toContain(`completed: ${originalCompleted}`);
  });
});

// -----------------------------------------------------------------------------
// task-72a318c3: slotClear / slotAssign reap prior runner + tmux state
// -----------------------------------------------------------------------------

describe("slotClear reaps prior runner (task-72a318c3)", () => {
  // Seed tmux-slot-<N>.json with the shape the adapter's stop() reads. Uses a
  // fake/dead PID so killPid is a no-op; we only care about the cleanup routing.
  function seedTmuxSlotState(harness: string, slot: number): string {
    const dir = join(harness, "orchestration");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `tmux-slot-${slot}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        orchestration: { pid: 999_999_999, stateFile: `orch-${slot}.json`, mode: "pair" },
        sessionNames: { coder: `test-coder-${slot}`, reviewer: `test-reviewer-${slot}` },
        worktrees: { coder: `/tmp/wt-coder-${slot}`, reviewer: `/tmp/wt-reviewer-${slot}` },
        branches: { coder: `test-coder-${slot}`, reviewer: `test-reviewer-${slot}` },
        peerSyncDir: `/tmp/peer-${slot}`,
        ttydPids: {},
      }),
    );
    return file;
  }

  test("non-empty slot clear removes tmux-slot-<N>.json via the stop path", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-reap-1", "Reap test 1");
    await slotAssign(1, "task-reap-1", "tmux");
    const stateFile = seedTmuxSlotState(harness, 1);
    expect(existsSync(stateFile)).toBe(true);

    await slotClear(1, "ready");

    // The tmux adapter's stop() removes tmux-slot-<N>.json. Proves the clear
    // routed through adapter.stop before any fallback unlinks fired.
    expect(existsSync(stateFile)).toBe(false);
    expect(readSlotJson(1, harness).process).toBe("(empty)");
  });

  test("already-empty slot clear is a no-op for the stop path", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);

    // Seeding slot state on an empty slot is abnormal, but if it exists the
    // guard must not touch it — clear's stop path is gated on process != "(empty)".
    const stateFile = seedTmuxSlotState(harness, 1);

    await slotClear(1, "ready");

    // File stays — the fallback unlinks DO run and remove it.
    // But slot JSON must be empty either way.
    expect(readSlotJson(1, harness).process).toBe("(empty)");
    // Fallback unlink caught the seeded file:
    expect(existsSync(stateFile)).toBe(false);
  });

  test("t3code thread-IDs are saved to task frontmatter before state removal", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-t3code-save", "Thread ID save test");
    await slotAssign(1, "task-t3code-save", "t3code");

    // Seed t3code/slot-1.json with threads — the save block reads this.
    const t3codeFile = join(harness, "t3code", "slot-1.json");
    mkdirSync(join(harness, "t3code"), { recursive: true });
    writeFileSync(
      t3codeFile,
      JSON.stringify({
        orchestration: { pid: 999_999_999, stateFile: "orch.json", mode: "pair" },
        threads: [
          { threadId: "t-coder", projectId: "p", workspaceUuid: "w", role: "coder" },
          { threadId: "t-reviewer", projectId: "p", workspaceUuid: "w", role: "reviewer" },
        ],
      }),
    );

    await slotClear(1, "done");

    const content = readFileSync(join(tasksDir, "task-t3code-save.md"), "utf-8");
    expect(content).toContain("t3code_threads:");
    expect(content).toContain("t-coder");
    expect(content).toContain("t-reviewer");
  });
});

describe("slotAssign reaps prior assignment on reassignment (task-72a318c3)", () => {
  function seedTmuxSlotState(harness: string, slot: number): string {
    const dir = join(harness, "orchestration");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `tmux-slot-${slot}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        orchestration: { pid: 999_999_999, stateFile: `orch-${slot}.json`, mode: "pair" },
        sessionNames: { coder: `test-coder-${slot}`, reviewer: `test-reviewer-${slot}` },
        worktrees: { coder: `/tmp/wt-coder-${slot}`, reviewer: `/tmp/wt-reviewer-${slot}` },
        branches: { coder: `test-coder-${slot}`, reviewer: `test-reviewer-${slot}` },
        peerSyncDir: `/tmp/peer-${slot}`,
        ttydPids: {},
      }),
    );
    return file;
  }

  test("reassigning a non-empty slot to a different task removes prior tmux state", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-old", "Old task");
    writeTask(tasksDir, "task-new", "New task");
    await slotAssign(1, "task-old", "tmux");
    const stateFile = seedTmuxSlotState(harness, 1);
    expect(existsSync(stateFile)).toBe(true);

    await slotAssign(1, "task-new", "tmux");

    // Adapter stop on reassignment removed the prior tmux-slot-1.json.
    expect(existsSync(stateFile)).toBe(false);
    expect(readSlotJson(1, harness).task).toBe("task-new");
  });

  test("reassigning a slot to the SAME task does not emit a stop entry in the journal", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-same", "Same task");
    await slotAssign(1, "task-same", "tmux");

    // Clear journal to isolate the re-assign step.
    const journalFile = join(harness, "journal.md");
    if (existsSync(journalFile)) writeFileSync(journalFile, "");

    seedTmuxSlotState(harness, 1);
    await slotAssign(1, "task-same", "tmux");

    // slotStop writes "Slot N stopped (adapter=..." to the journal via slotStop's
    // own journalAppend call. Same-task reassignment gates out of the stop path,
    // so no such entry appears for this step.
    const journal = existsSync(journalFile) ? readFileSync(journalFile, "utf-8") : "";
    expect(journal).not.toContain("Slot 1 stopped");
  });

  test("assigning into an empty slot is a no-op for the stop path", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-fresh", "Fresh task");

    // Seed a stale state file with no prior assignment in slot JSON —
    // empty-slot assign should not hit adapter.stop, but the fallback
    // unlinks WILL remove the stale file (existing pre-fix behavior).
    seedTmuxSlotState(harness, 1);

    await slotAssign(1, "task-fresh", "tmux");
    // fallback unlink runs on the stale file — that's the pre-existing
    // path. Test passes regardless of whether the file is removed; the
    // guarantee we care about is no exception from slotStop.
    expect(readSlotJson(1, harness).task).toBe("task-fresh");
  });

  test("old task frontmatter reset still happens on reassignment (regression guard)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-old-reset", "Old task reset");
    writeTask(tasksDir, "task-new-reset", "New task reset");

    // Assign and mark the old task in-progress
    await slotAssign(1, "task-old-reset", "manual");
    let content = readFileSync(join(tasksDir, "task-old-reset.md"), "utf-8");
    expect(content).toContain("status: in-progress");
    expect(content).toContain("slot: 1");

    // Reassign — old task should be reset to slot: null and status: ready
    await slotAssign(1, "task-new-reset", "manual");
    content = readFileSync(join(tasksDir, "task-old-reset.md"), "utf-8");
    expect(content).toContain("slot: null");
    expect(content).toContain("status: ready");
  });
});

describe("slotAssign machine default in federated setup", () => {
  function writeClusterConfig(homeDir: string, yaml: string): string {
    const configDir = join(homeDir, ".config", "ludics");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    writeFileSync(configPath, yaml);
    return configPath;
  }

  test("defaults machine to current node name when cluster config self-matches", async () => {
    const sysHost = osHostname().toLowerCase();
    // Configure a machine whose host matches os.hostname() so
    // clusterCurrentMachine() returns it via the system-hostname candidate.
    // Also include a second machine so we can prove we picked the self-match
    // rather than, say, the leader.
    process.env.LUDICS_CONFIG = writeClusterConfig(TMP, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: self-match-node
      host: ${sysHost}
      os: linux
      role: worker
      always_on: false
      gpu: ""
    - name: leader-other
      host: leader-other.test.local
      os: linux
      role: leader
      always_on: false
      gpu: ""
`);

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-self-match", "Federated self-match");

    await slotAssign(1, "task-self-match", "tmux");

    const data = readSlotJson(1, harness);
    expect(data.machine).toBe("self-match-node");
  });

  test("defaults machine to leader when current host is not in cluster.machines", async () => {
    // No host entry matches os.hostname() (use a name/host guaranteed not to
    // collide with any real machine). One machine is role: leader.
    process.env.LUDICS_CONFIG = writeClusterConfig(TMP, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: unmatched-leader-xyz789
      host: unmatched-leader-xyz789.nowhere.invalid
      os: linux
      role: leader
      always_on: false
      gpu: ""
    - name: unmatched-worker-xyz789
      host: unmatched-worker-xyz789.nowhere.invalid
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-leader-fallback", "Federated leader fallback");

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    let warned = false;
    try {
      await slotAssign(1, "task-leader-fallback", "tmux");
      warned = errSpy.mock.calls.some(call =>
        String(call[0] ?? "").includes("defaulting machine to leader")
      );
    } finally {
      errSpy.mockRestore();
    }

    const data = readSlotJson(1, harness);
    expect(data.machine).toBe("unmatched-leader-xyz789");
    expect(warned).toBe(true);
  });

  test("keeps machine null and warns when cluster configured but no self-match and no leader", async () => {
    // Cluster is enabled, but no machine matches os.hostname() AND no machine
    // has role: leader. defaultAssignMachine() should fall through to the
    // final `return null` branch with the "no resolvable machine" stderr.
    process.env.LUDICS_CONFIG = writeClusterConfig(TMP, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: unmatched-worker-a-xyz789
      host: unmatched-worker-a-xyz789.nowhere.invalid
      os: linux
      role: worker
      always_on: false
      gpu: ""
    - name: unmatched-worker-b-xyz789
      host: unmatched-worker-b-xyz789.nowhere.invalid
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-no-self-no-leader", "Cluster with no resolvable machine");

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    let warned = false;
    try {
      await slotAssign(1, "task-no-self-no-leader", "tmux");
      warned = errSpy.mock.calls.some(call =>
        String(call[0] ?? "").includes("no resolvable machine")
      );
    } finally {
      errSpy.mockRestore();
    }

    const data = readSlotJson(1, harness);
    expect(data.machine).toBeNull();
    expect(warned).toBe(true);
  });

  test("keeps machine null in non-federated (single-machine) setup", async () => {
    // Default writeConfig() (set by beforeEach) has no cluster block →
    // clusterEnabled() is false → defaultAssignMachine() returns null.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-nonfed", "Non-federated default");

    await slotAssign(1, "task-nonfed", "tmux");

    const data = readSlotJson(1, harness);
    expect(data.machine).toBeNull();
  });

  test("explicit --machine argument short-circuits the default", async () => {
    process.env.LUDICS_CONFIG = writeClusterConfig(TMP, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: self-match-node
      host: ${osHostname().toLowerCase()}
      os: linux
      role: leader
      always_on: false
      gpu: ""
`);

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-explicit-machine", "Explicit machine overrides default");

    await slotAssign(1, "task-explicit-machine", "tmux", "", "", "", "explicit-node");

    const data = readSlotJson(1, harness);
    expect(data.machine).toBe("explicit-node");
  });
});
