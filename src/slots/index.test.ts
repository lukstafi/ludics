import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname as osHostname, tmpdir } from "os";
import { join } from "path";
import { slotAssign, slotClear, slotResume, slotStart, slotSetMode, slotStop, runSlot, markSlotSetupFailed, autoFillAdapterArgs, makeAdapterContext, slotPreempt, slotReset, slotRestore, validateAssignAdapter, VALID_ASSIGN_ADAPTERS, reinitTtydPid, setWorkerSlotsOverride, persistSlotLiveness } from "./index.ts";
import * as tmuxAdapterMod from "../adapters/tmux-adapter.ts";
import * as t3codeServerMod from "../t3code/server.ts";
import * as spawnMod from "../spawn.ts";
import { hasStash, writeStash } from "./preempt.ts";
import { persistState, defaultOrchestrationConfig, initAgentRuntimeState, readOrchestrationState, stateFilePath, type OrchestrationState } from "../orchestration/state.ts";
import { tmuxKillSession, tmuxHasSession } from "../adapters/tmux.ts";
import { existsSync } from "fs";
import { getIntentForDashboard, clearIntent } from "../cluster-http.ts";
import { heartbeatsDir as getHeartbeatsDir } from "../cluster.ts";
import { writeSlotJson, readSlotJson, emptySlotData, slotJsonDir } from "./json.ts";

setDefaultTimeout(15_000);

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function writeConfig(
  homeDir: string,
  { cluster, includeSelf, t3codeEnabled = true }: {
    cluster?: boolean;
    includeSelf?: boolean;
    // gh-ludics-539: defaults true so existing -a t3code tests keep their
    // pre-gate behaviour. Flag-off tests pass `t3codeEnabled: false`.
    t3codeEnabled?: boolean;
  } = {},
): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  let yaml = `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`;
  if (t3codeEnabled) {
    // task-c48b7beb: selectOrchestrationFlags resolves the claude-code coder
    // model through mag.orchestration.model_classes and throws when a tracked
    // class is absent, so the auto-fill config must carry the table.
    yaml += `mag:
  t3code_integration_enabled: true
  orchestration:
    model_classes:
      codex: gpt-5.5
      claude-opus: claude-opus-4-8
      claude-sonnet: claude-sonnet-4-6
`;
  }
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
    if (includeSelf) {
      // Add a machine entry that matches the test runner's hostname so
      // clusterCurrentMachineName() resolves non-null. Used for "on-cluster
      // dispatch to a peer" tests; omit for off-cluster tests where we
      // want clusterCurrentMachineName() to return null.
      const self = osHostname();
      yaml += `    - name: self
      host: ${self}
      os: linux
      role: controller
      always_on: true
      gpu: ""
`;
    }
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

  test("rejects leaf:false container tasks before any slot mutation (AC5)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);

    // Harness condition: a real task file exists with `leaf: false`. The
    // existsSync(tf) branch fires; if the guard isn't there, slot mutation
    // proceeds and the byte-equality assertion below fails.
    writeFileSync(join(tasksDir, "task-container.md"), `---
id: task-container
title: "Container parent"
project: demo
status: ready
priority: B
leaf: false
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
created: 2026-04-29
started: null
completed: null
modified: null
source: local
---
`);

    const slotPath = join(harness, "slots", "slot-1.json");
    const slotBefore = readFileSync(slotPath, "utf-8");
    const taskPath = join(tasksDir, "task-container.md");
    const taskBefore = readFileSync(taskPath, "utf-8");

    // Invariant: the throw must happen before any write. Asserting the
    // error message also pins the actionable hint that names the parent.
    await expect(slotAssign(1, "task-container", "manual"))
      .rejects.toThrow(/container task task-container/);

    // Atomic-failure invariant: slot JSON byte-identical post-throw.
    expect(readFileSync(slotPath, "utf-8")).toBe(slotBefore);
    // Atomic-failure invariant: task frontmatter untouched (slot/status/started
    // would all change if the mutation path had been entered).
    expect(readFileSync(taskPath, "utf-8")).toBe(taskBefore);
  });

  test("free-form description assignment bypasses the leaf guard (no task file resolves)", () => {
    // Harness condition: NO task file at this path; existsSync(tf) is false,
    // so the leaf-check branch never runs. This codifies the AC5 carve-out.
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);

    void slotAssign(1, "task-container", "manual"); // looks like a task id but no file

    const data = readSlotJson(1, harness);
    expect(data.task).toBeNull(); // treated as free-form because no file
    expect(data.process).toBe("task-container");
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

  test("journal entry omits (task=...) parenthetical when no task resolves (task-138eb60b AC3)", () => {
    // Harness condition: pass a taskId-shaped string that does NOT resolve to
    // any task file ("null"). slotAssign normalizes the local taskId to JS
    // `null` (the existsSync(tf) branch is false), exercising the *absent*
    // arm of the journal-format conditional. This is the only branch the AC
    // guards; a regression that re-introduced a `task=null` placeholder, or
    // dropped the conditional entirely (`(task=undefined)`, etc.), would
    // surface here.
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(harness, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);

    void slotAssign(1, "null", "t3code");

    const today = new Date().toISOString().slice(0, 10);
    const journalPath = join(harness, "journal", `${today}.md`);
    const journal = readFileSync(journalPath, "utf-8");
    const assignLine = journal.split("\n").find((l) => l.includes("Slot 1 assigned"));
    expect(assignLine).toBeDefined();
    // Invariant: no `(task=...)` parenthetical at all when taskId is absent.
    expect(assignLine!).not.toMatch(/\(task=/);
    // Adapter parenthetical and processDesc are still present.
    expect(assignLine!).toContain("(adapter=t3code)");
  });

  test("journal entry includes (task=<id>) when a task resolves (task-138eb60b AC3 sibling)", () => {
    // Sibling/positive control for the AC3 conditional: when a task file
    // exists, `taskId` is set and the parenthetical must reappear with the
    // resolved id. Pins that the writer didn't drop the parenthetical
    // unconditionally.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-journal-id", "Journal id present");

    void slotAssign(1, "task-journal-id", "manual");

    const today = new Date().toISOString().slice(0, 10);
    const journalPath = join(harness, "journal", `${today}.md`);
    const journal = readFileSync(journalPath, "utf-8");
    const assignLine = journal.split("\n").find((l) => l.includes("Slot 1 assigned"));
    expect(assignLine).toBeDefined();
    expect(assignLine!).toContain("(task=task-journal-id)");
    expect(assignLine!).toContain("(adapter=manual)");
  });

  test("batches the three frontmatter field updates into a single atomic write (task-29bea074)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-tx-assign", "Transactional assign");

    const taskFile = join(tasksDir, "task-tx-assign.md");
    const jsonMod = await import("../json.ts");
    const writeSpy = spyOn(jsonMod, "atomicWriteFileSync");

    let writesToTaskFile: Array<[string, string]>;
    try {
      void slotAssign(1, "task-tx-assign", "manual");

      // Capture before mockRestore wipes call history.
      writesToTaskFile = writeSpy.mock.calls
        .filter((call) => call[0] === taskFile)
        .map((call) => [String(call[0]), String(call[1])] as [string, string]);
    } finally {
      writeSpy.mockRestore();
    }

    // Exactly two atomic writes hit the task file:
    //   1) transitionStatus flipping status: ready → in-progress
    //   2) the batched (slot, adapter, started) write
    // The pre-task-29bea074 behaviour did three separate per-field writes for
    // (2) — yielding 4 here — which left the file partially populated if the
    // process crashed mid-sequence (e.g. slot set, but adapter/started absent).
    expect(writesToTaskFile).toHaveLength(2);

    const batchedContent = writesToTaskFile[1]![1];
    expect(batchedContent).toContain("slot: 1");
    expect(batchedContent).toContain("adapter: manual");
    expect(batchedContent).toMatch(/started: 20\d\d-/);

    // Round-trip: persisted file matches the in-memory batched content for all 3 fields.
    const persisted = readFileSync(taskFile, "utf-8");
    expect(persisted).toContain("slot: 1");
    expect(persisted).toContain("adapter: manual");
    expect(persisted).toMatch(/started: 20\d\d-/);
  });

  test("slotClear single-field frontmatter updates remain atomic (task-29bea074 / AC11)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-tx-clear", "Transactional clear");
    void slotAssign(1, "task-tx-clear", "manual");

    const taskFile = join(tasksDir, "task-tx-clear.md");
    const jsonMod = await import("../json.ts");
    const writeSpy = spyOn(jsonMod, "atomicWriteFileSync");

    let writesToTaskFile: Array<[string, string]>;
    try {
      await slotClear(1, "done");
      writesToTaskFile = writeSpy.mock.calls
        .filter((call) => call[0] === taskFile)
        .map((call) => [String(call[0]), String(call[1])] as [string, string]);
    } finally {
      writeSpy.mockRestore();
    }

    // slotClear does: transitionStatus (status: in-progress → done),
    // then taskUpdateFrontmatter("slot","null"), then ("completed", ...).
    // After AC9, every write is atomic. Each is still a single-field update —
    // we don't batch slot+completed because a crash between them is benign
    // (slot=null is the load-bearing field for slot reuse; completed is metadata).
    expect(writesToTaskFile).toHaveLength(3);

    const persisted = readFileSync(taskFile, "utf-8");
    expect(persisted).toContain("status: done");
    expect(persisted).toContain("slot: null");
    expect(persisted).toMatch(/completed: 20\d\d-/);
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
    // slotAssign with no adapterArgs stores "null" which makeAdapterContext normalizes to undefined
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

describe("makeAdapterContext taskId normalization", () => {
  // These tests are the contract that lets every downstream `ctx.taskId`
  // consumer drop the legacy `taskId && taskId !== "null"` guard. If any of
  // these break, the scattered guards we removed need to come back.
  function buildSlotData(task: string | null): import("./types.ts").SlotData {
    return {
      slot: 1,
      process: "running",
      task,
      mode: "t3code",
      session: null,
      path: "/tmp/proj",
      started: null,
      adapterArgs: null,
      machine: null,
      sessionStarted: null,
      liveness: null,
      terminals: "",
      runtime: "",
      git: "",
    };
  }

  test("normalizes null SlotData.task to undefined", () => {
    const ctx = makeAdapterContext(1, buildSlotData(null));
    expect(ctx.taskId).toBeUndefined();
  });

  test("normalizes the legacy 'null' string sentinel to undefined", () => {
    // SlotData.task is typed `string | null` but the markdown/migration layer
    // can still surface the literal string "null" — normalization must catch
    // it at the single ingestion point.
    const ctx = makeAdapterContext(1, buildSlotData("null"));
    expect(ctx.taskId).toBeUndefined();
  });

  test("normalizes empty string to undefined", () => {
    const ctx = makeAdapterContext(1, buildSlotData(""));
    expect(ctx.taskId).toBeUndefined();
  });

  test("preserves a real task id", () => {
    const ctx = makeAdapterContext(1, buildSlotData("task-abc123"));
    expect(ctx.taskId).toBe("task-abc123");
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

describe("assign-time adapter validation (gh-ludics-524)", () => {
  test("validateAssignAdapter rejects a phantom adapter, naming the value and canonical set (AC1)", () => {
    // Invariant: a mode outside {tmux,t3code,manual} cannot reach slot state.
    // Would fail if the allow-list widened or the error dropped the set.
    expect(() => validateAssignAdapter("agent-pair-codex")).toThrow(
      "invalid adapter: agent-pair-codex (use: tmux, t3code, manual)",
    );
    expect(() => validateAssignAdapter("agent-claude")).toThrow("invalid adapter: agent-claude");
    expect(() => validateAssignAdapter("claude-ai")).toThrow("invalid adapter: claude-ai");
  });

  test("validateAssignAdapter accepts each canonical adapter (AC3)", () => {
    // Positive control for the AC1 guard: the three canonical modes must pass.
    expect(VALID_ASSIGN_ADAPTERS).toEqual(["tmux", "t3code", "manual"]);
    for (const adapter of VALID_ASSIGN_ADAPTERS) {
      expect(() => validateAssignAdapter(adapter)).not.toThrow();
    }
  });

  test("slotAssign rejects a phantom adapter before any slot write (AC1 + AC2)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-phantom-assign", "Phantom assign");

    const slotFile = join(slotJsonDir(harness), "slot-1.json");
    const taskFile = join(tasksDir, "task-phantom-assign.md");
    const slotBefore = readFileSync(slotFile, "utf-8");
    const taskBefore = readFileSync(taskFile, "utf-8");

    // Invariant: rejection is atomic — slot JSON and task frontmatter are
    // byte-identical afterwards (no mode write, no status flip).
    await expect(slotAssign(1, "task-phantom-assign", "agent-pair-codex")).rejects.toThrow(
      "invalid adapter: agent-pair-codex",
    );
    expect(readFileSync(slotFile, "utf-8")).toBe(slotBefore);
    expect(readFileSync(taskFile, "utf-8")).toBe(taskBefore);
  });

  test("slotAssign accepts each canonical adapter and writes the expected mode (AC3)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Positive control per canonical adapter, plus the no-`-a` default.
    for (const adapter of ["tmux", "t3code", "manual"] as const) {
      writeSlotJson(1, emptySlotData(1), harness);
      writeSlotJson(2, emptySlotData(2), harness);
      writeTask(tasksDir, `task-ok-${adapter}`, `OK ${adapter}`);
      await slotAssign(1, `task-ok-${adapter}`, adapter);
      expect(readSlotJson(1, harness).mode).toBe(adapter);
    }
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-ok-default", "OK default");
    await slotAssign(1, "task-ok-default"); // no adapter arg → "manual"
    expect(readSlotJson(1, harness).mode).toBe("manual");
  });

  test("runSlot assign rejects a phantom adapter — no interrupted marker created (AC1 end-to-end)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-phantom-cli", "Phantom CLI");

    await expect(runSlot(["1", "assign", "task-phantom-cli", "-a", "agent-claude"])).rejects.toThrow(
      "invalid adapter: agent-claude",
    );
    // Invariant: the slot stays empty — the failed assign never reached
    // slot start, so no `liveness: interrupted` marker can be left behind.
    const data = readSlotJson(1, harness);
    expect(data.process).toBe("(empty)");
    expect(data.liveness).toBeNull();
  });

  test("slotPreempt rejects a phantom adapter on a non-empty slot before any side effect (AC2)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-occupant", "Occupant");
    writeTask(tasksDir, "task-priority", "Priority");
    // Occupy slot 1 so slotPreempt takes the non-empty (stash) branch.
    await slotAssign(1, "task-occupant", "manual");

    const slotFile = join(slotJsonDir(harness), "slot-1.json");
    const occupantFile = join(tasksDir, "task-occupant.md");
    const slotBefore = readFileSync(slotFile, "utf-8");
    const occupantBefore = readFileSync(occupantFile, "utf-8");

    // Invariant: on a non-empty slot the validator must fire before
    // writeStash + the old task's `preempted` flip. If the guard were only
    // in slotAssign, the stash would already exist and the occupant's
    // frontmatter would already say `status: preempted`.
    await expect(slotPreempt(1, "task-priority", "agent-pair-codex")).rejects.toThrow(
      "invalid adapter: agent-pair-codex",
    );
    expect(hasStash(1)).toBe(false);
    expect(readFileSync(slotFile, "utf-8")).toBe(slotBefore);
    expect(readFileSync(occupantFile, "utf-8")).toBe(occupantBefore);
  });

  test("slotRestore coerces a legacy phantom previousMode to manual instead of hard-failing (gh-ludics-524 PR #527 P1)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    // A stash captured before assign-time validation existed, carrying a
    // now-invalid adapter mode. Without the slotRestore coercion this throws
    // "invalid adapter: agent-claude" and the stash is unrecoverable.
    writeStash({
      slotNum: 1,
      previousTask: "null",
      previousProcess: "Stranded work",
      previousMode: "agent-claude",
      previousSession: "null",
      previousPath: "null",
      previousStarted: "2026-05-14T06:57Z",
      previousAdapterArgs: "null",
      preemptedAt: "2026-05-14T07:00Z",
      preemptingTask: "task-priority",
    });

    // Invariant: a pre-validation stash with a phantom previousMode still
    // restores — the restore coerces it to "manual" rather than rejecting.
    // Would fail with "invalid adapter: agent-claude" if the coercion were absent.
    await slotRestore(1);
    const data = readSlotJson(1, harness);
    expect(data.process).toBe("Stranded work");
    expect(data.mode).toBe("manual");
    expect(hasStash(1)).toBe(false); // stash consumed
  });
});

describe("t3code integration gate (gh-ludics-539)", () => {
  // The default writeConfig() (beforeEach) writes the flag ON. Flag-off tests
  // rewrite the same config.yaml via writeConfig(TMP, { t3codeEnabled: false }).

  test("validateAssignAdapter('t3code') throws the exact paused message when flag off", () => {
    writeConfig(TMP, { t3codeEnabled: false });
    // Invariant: while paused, t3code cannot be assigned — the precise re-engagement
    // message must surface. Would fail if the gate were dropped or the wording drifted.
    expect(() => validateAssignAdapter("t3code")).toThrow(
      "t3code integration is currently paused; enable mag.t3code_integration_enabled in config.yaml to re-engage",
    );
  });

  test("validateAssignAdapter('tmux') and ('manual') are unaffected by the flag-off state", () => {
    writeConfig(TMP, { t3codeEnabled: false });
    // Mutation evidence: the gate keys on adapter === "t3code" only; a gate that
    // rejected all adapters while paused would break tmux/manual assignment.
    expect(() => validateAssignAdapter("tmux")).not.toThrow();
    expect(() => validateAssignAdapter("manual")).not.toThrow();
  });

  test("validateAssignAdapter('t3code') passes when flag on (positive control)", () => {
    // beforeEach already wrote the flag ON; re-engagement restores t3code assign.
    expect(() => validateAssignAdapter("t3code")).not.toThrow();
  });

  test("slotAssign(-a t3code) rejects with the paused message, leaving slot/task files unchanged", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeTask(tasksDir, "task-t3code-paused", "Paused assign");
    writeConfig(TMP, { t3codeEnabled: false });

    const slotFile = join(slotJsonDir(harness), "slot-1.json");
    const taskFile = join(tasksDir, "task-t3code-paused.md");
    const slotBefore = readFileSync(slotFile, "utf-8");
    const taskBefore = readFileSync(taskFile, "utf-8");

    // Invariant: rejection is atomic — validateAssignAdapter runs before any
    // slot write or status flip, so both files are byte-identical afterwards.
    await expect(slotAssign(1, "task-t3code-paused", "t3code")).rejects.toThrow(
      "t3code integration is currently paused",
    );
    expect(readFileSync(slotFile, "utf-8")).toBe(slotBefore);
    expect(readFileSync(taskFile, "utf-8")).toBe(taskBefore);
  });

  test("autoFillAdapterArgs returns null and logs 'auto-fill skipped' when flag off", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-autofill-paused", "Auto-fill paused");
    // Assign the t3code slot (empty adapterArgs) while the flag is still ON.
    void slotAssign(1, "task-autofill-paused", "t3code");
    const data = readSlotJson(1, harness);
    const ctx = makeAdapterContext(1, data);

    // Now pause the integration: a pre-existing t3code slot started after the
    // flip must surface a clear "skipped" log, not silently fall back.
    writeConfig(TMP, { t3codeEnabled: false });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await autoFillAdapterArgs(ctx, data);
      const calls = errSpy.mock.calls.map((c) => String(c[0]));
      // Invariant: the typed paused error is caught → slot treated as not
      // auto-fillable (null) with a single clear log line.
      expect(result).toBeNull();
      expect(calls.some((l) => l.includes("auto-fill skipped: t3code integration paused"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("slotRestore of a preempted t3code slot succeeds when flag off (option (c) — codex P1)", async () => {
    // Regression for codex review P1: slotRestore funnels through slotAssign;
    // without the allowPausedT3code exemption the paused gate would throw and
    // strand preempted t3code work. Option (c): recovery of existing slots must
    // keep working while only NEW assign/preempt is blocked.
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeStash({
      slotNum: 1,
      previousTask: "null",
      previousProcess: "Preempted t3code work",
      previousMode: "t3code",
      previousSession: "null",
      previousPath: "null",
      previousStarted: "2026-05-14T06:57Z",
      previousAdapterArgs: "--pair --coder claude-code",
      preemptedAt: "2026-05-14T07:00Z",
      preemptingTask: "task-priority",
    });
    writeConfig(TMP, { t3codeEnabled: false });

    // Invariant: restore completes — the slot is recovered with mode t3code and
    // the stash is consumed. Would throw the paused message without the exemption.
    await slotRestore(1);
    const data = readSlotJson(1, harness);
    expect(data.process).toBe("Preempted t3code work");
    expect(data.mode).toBe("t3code");
    expect(hasStash(1)).toBe(false);
  });

  test("slotClear(done) auto-restore of a preempted t3code slot succeeds when flag off (codex P1)", async () => {
    // The auto-restore path in slotClear() also routes through slotRestore →
    // slotAssign; the exemption must cover it too.
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeSlotJson(2, emptySlotData(2), harness);
    void slotAssign(1, "Urgent preempting work", "manual");
    writeStash({
      slotNum: 1,
      previousTask: "null",
      previousProcess: "Preempted t3code work",
      previousMode: "t3code",
      previousSession: "null",
      previousPath: "null",
      previousStarted: "2026-05-14T06:57Z",
      previousAdapterArgs: "--pair --coder claude-code",
      preemptedAt: "2026-05-14T07:00Z",
      preemptingTask: "task-priority",
    });
    writeConfig(TMP, { t3codeEnabled: false });

    await slotClear(1, "done");
    const data = readSlotJson(1, harness);
    expect(data.process).toBe("Preempted t3code work");
    expect(data.mode).toBe("t3code");
    expect(hasStash(1)).toBe(false);
  });

  test("slotSetMode rejects switching to t3code while paused, but allows tmux (codex P1)", async () => {
    // Regression for codex review P1: `slot mode <N> t3code` updates data.mode
    // directly, bypassing slotAssign — it must enforce the same paused gate.
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeSlotJson(2, emptySlotData(2), harness);
    void slotAssign(1, "Mode toggle work", "manual");
    writeConfig(TMP, { t3codeEnabled: false });

    // Invariant: the mode toggle cannot create a t3code slot while paused.
    await expect(slotSetMode(1, "t3code")).rejects.toThrow(
      "t3code integration is currently paused",
    );
    // tmux toggle is unaffected by the flag.
    await slotSetMode(1, "tmux");
    expect(readSlotJson(1, harness).mode).toBe("tmux");
  });

  test("slotSetMode allows switching to t3code when flag on (positive control)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeSlotJson(2, emptySlotData(2), harness);
    void slotAssign(1, "Mode toggle work", "manual");
    // beforeEach wrote the flag ON.
    await slotSetMode(1, "t3code");
    expect(readSlotJson(1, harness).mode).toBe("t3code");
  });
});

describe("slotReset — clear interrupted/escalated liveness (gh-ludics-524 AC7)", () => {
  test("clears interrupted liveness and sessionStarted, preserving task/process/mode", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-reset-1", "Reset test");
    void slotAssign(1, "task-reset-1", "tmux");
    markSlotSetupFailed(1, "tmux session creation failed");
    expect(readSlotJson(1, harness).liveness).toBe("interrupted");

    slotReset(1);

    // Invariant: liveness/sessionStarted are cleared while the assignment
    // (task/process/mode) is preserved — would fail if reset cleared the slot.
    const data = readSlotJson(1, harness);
    expect(data.liveness).toBeNull();
    expect(data.sessionStarted).toBeNull();
    expect(data.task).toBe("task-reset-1");
    expect(data.process).toBe("Reset test");
    expect(data.mode).toBe("tmux");
  });

  test("runSlot reset dispatches to slotReset", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-reset-cli", "Reset CLI");
    void slotAssign(1, "task-reset-cli", "tmux");
    markSlotSetupFailed(1, "boom");

    await runSlot(["1", "reset"]);
    expect(readSlotJson(1, harness).liveness).toBeNull();
  });

  test("clears escalated liveness and works for a stale phantom mode (no adapter dispatch)", () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeSlotJson(2, emptySlotData(2), harness);
    // Hand-built slot file with a phantom mode and escalated liveness — the
    // exact stranded state slotReset must recover without touching the
    // adapter registry (a registry lookup on "agent-pair-codex" would throw).
    const stranded = emptySlotData(1);
    stranded.process = "Stranded";
    stranded.task = "task-stranded";
    stranded.mode = "agent-pair-codex";
    stranded.liveness = "escalated";
    stranded.sessionStarted = "2026-05-14T06:57Z";
    writeSlotJson(1, stranded, harness);

    expect(() => slotReset(1)).not.toThrow();
    const data = readSlotJson(1, harness);
    expect(data.liveness).toBeNull();
    expect(data.sessionStarted).toBeNull();
    expect(data.mode).toBe("agent-pair-codex"); // mode is left as-is; only liveness is reset
  });

  test("is no-op-safe on an already-clean assigned slot", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-reset-clean", "Clean");
    void slotAssign(1, "task-reset-clean", "manual");

    expect(() => slotReset(1)).not.toThrow();
    const data = readSlotJson(1, harness);
    expect(data.liveness).toBeNull();
    expect(data.task).toBe("task-reset-clean");
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

  test("slotResume writes tmux-slot-N.json when absent, with live runner pid (gh-ludics-559 defect B)", async () => {
    // Invariant (AC1/AC2): post-tmux-server-restart, `tmux-slot-N.json` is gone.
    // After resume the sibling file MUST exist with orchestration.pid === the
    // pid startOrchestrationProcess returned, plus a full reconstructed shape
    // (mode + stateFile). Harness condition: NO tmux-slot-1.json is written
    // before resume — that absence is exactly the bug's trigger. Without the
    // unconditional write this assertion fails (file stays null → the runner
    // would exit on the sibling-state grace timeout).
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    const orchDir = join(harness, "orchestration");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(orchDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-absent-sibling", "Resume writes absent sibling");

    void slotAssign(1, "task-absent-sibling", "tmux", "", "", "--pair --coder claude --reviewer claude");

    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-absent-sibling",
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

    // Sanity: the sibling file is genuinely absent before resume (the bug state).
    expect(tmuxAdapterMod.readTmuxSlotState(1, harness)).toBeNull();

    const orchProcess = await import("../orchestration/process.ts");
    const startSpy = spyOn(orchProcess, "startOrchestrationProcess")
      .mockImplementation(async () => 99_998);

    createdTmuxSessions.push(
      "s1_coder_task-absent-sibling", "s1_reviewer_task-absent-sibling",
    );
    try {
      await slotResume(1, { startTtyd: false });
      const sibling = tmuxAdapterMod.readTmuxSlotState(1, harness);
      expect(sibling).not.toBeNull();
      expect(sibling!.orchestration?.pid).toBe(99_998);
      expect(sibling!.orchestration?.mode).toBe("pair");
      expect(sibling!.orchestration?.stateFile).toBe(stateFilePath(1, harness));
      expect(typeof sibling!.ttydPids).toBe("object");
      expect(startSpy).toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
    }
  });

  test("slotResume preserves unmanaged tmux-slot-N.json fields when present (gh-ludics-559 defect B / AC3)", async () => {
    // Invariant (AC3): when the sibling file already exists, resume patches it in
    // place — refreshing ttydPids and orchestration.pid — WITHOUT discarding
    // fields it does not own. ttydRestartCounts is the canary. Harness
    // condition: pre-write a sibling file carrying a non-trivial
    // ttydRestartCounts BEFORE resume; if the patch path clobbered the file
    // (e.g. by reconstructing instead of spreading), the counter would vanish.
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    const orchDir = join(harness, "orchestration");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(orchDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-present-sibling", "Resume preserves present sibling");

    void slotAssign(1, "task-present-sibling", "tmux", "", "", "--pair --coder claude --reviewer claude");

    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-present-sibling",
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

    // Pre-existing sibling file carrying an unmanaged field.
    tmuxAdapterMod.writeTmuxSlotState({
      slot: 1,
      ttydPids: { coder: 111, reviewer: 222 },
      ttydRestartCounts: { coder: { count: 3, firstRestartAt: 100, lastRestartAt: 200 } },
      orchestration: { stateFile: stateFilePath(1, harness), mode: "pair", pid: 12_345 },
    }, harness);

    const orchProcess = await import("../orchestration/process.ts");
    const startSpy = spyOn(orchProcess, "startOrchestrationProcess")
      .mockImplementation(async () => 77_777);

    createdTmuxSessions.push(
      "s1_coder_task-present-sibling", "s1_reviewer_task-present-sibling",
    );
    try {
      await slotResume(1, { startTtyd: false });
      const sibling = tmuxAdapterMod.readTmuxSlotState(1, harness);
      expect(sibling).not.toBeNull();
      // pid refreshed to the new runner pid
      expect(sibling!.orchestration?.pid).toBe(77_777);
      // unmanaged field survives the patch
      expect(sibling!.ttydRestartCounts?.coder?.count).toBe(3);
      expect(sibling!.ttydRestartCounts?.coder?.firstRestartAt).toBe(100);
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

describe("reinitTtydPid — re-init coherence (task-1373e911)", () => {
  // Observes the pid returned at the persisted seam — the value slotResume
  // assigns to newTtydPids[agent] and writes into tmux-slot-N.json. startTtyd
  // is spied so no real ttyd/bash spawns; processAlive is spied so the
  // prior-pid liveness branch is deterministic.
  let startTtydSpy: ReturnType<typeof spyOn>;
  let processAliveSpy: ReturnType<typeof spyOn>;
  const FRESH_PID = 424242;

  beforeEach(() => {
    startTtydSpy = spyOn(tmuxAdapterMod, "startTtyd").mockImplementation(() => FRESH_PID);
    processAliveSpy = spyOn(t3codeServerMod, "processAlive").mockImplementation(() => true);
  });
  afterEach(() => {
    startTtydSpy.mockRestore();
    processAliveSpy.mockRestore();
  });

  const base = { slot: 1, agentName: "coder", role: "coder" as const, taskId: "task-abc" };

  test("recreated session + port in use → restart unconditionally (orphan replaced), returns fresh pid [AC2-(a)]", () => {
    // Invariant: a recreated session means the port listener is an orphan
    // attached to the destroyed session — it MUST be replaced. Mutation:
    // reverting to the old "skip when portInUse" returns the stale prior pid
    // (7000) and calls startTtyd 0 times — both assertions catch it.
    const pid = reinitTtydPid({ ...base, sessionRecreated: true, portInUse: true, priorPid: 7000 });
    expect(pid).toBe(FRESH_PID);
    expect(startTtydSpy.mock.calls.length).toBe(1);
  });

  test("intact session + port in use + live prior pid → preserve prior pid, no startTtyd [AC3/AC4]", () => {
    const pid = reinitTtydPid({ ...base, sessionRecreated: false, portInUse: true, priorPid: 7000 });
    expect(pid).toBe(7000);
    expect(startTtydSpy.mock.calls.length).toBe(0);
  });

  test("intact session + free port → start ttyd, returns fresh pid", () => {
    const pid = reinitTtydPid({ ...base, sessionRecreated: false, portInUse: false, priorPid: 7000 });
    expect(pid).toBe(FRESH_PID);
    expect(startTtydSpy.mock.calls.length).toBe(1);
  });

  test("intact session + port in use + NO prior pid → restart (never persist undefined) [AC4 negative]", () => {
    // The bug AC4 forbids: persisting undefined/garbage for a busy port. With
    // no tracked pid we restart to record a real pid.
    const pid = reinitTtydPid({ ...base, sessionRecreated: false, portInUse: true, priorPid: undefined });
    expect(pid).toBe(FRESH_PID);
    expect(startTtydSpy.mock.calls.length).toBe(1);
    expect(pid).not.toBeUndefined();
  });

  test("intact session + port in use + DEAD prior pid → restart (don't preserve a stale tracked pid)", () => {
    processAliveSpy.mockImplementation(() => false);
    const pid = reinitTtydPid({ ...base, sessionRecreated: false, portInUse: true, priorPid: 7000 });
    expect(pid).toBe(FRESH_PID);
    expect(startTtydSpy.mock.calls.length).toBe(1);
  });
});

describe("slotResume — ttyd re-init persists fresh pid on session recreate (task-1373e911)", () => {
  // Behavioural end-to-end: drive slotResume with startTtyd enabled. The agent
  // tmux session does not exist → recreate branch → reinitTtydPid must restart
  // ttyd and persist the FRESH pid (not the stale seeded pid). Proves the helper
  // is wired into the resume path, not vacuous.
  const createdTmuxSessions: string[] = [];
  const FRESH_PID = 515151;
  const STALE_PID = 909090;

  afterEach(() => {
    for (const session of createdTmuxSessions) {
      try { if (tmuxHasSession(session)) tmuxKillSession(session); } catch { /* ignore */ }
    }
    createdTmuxSessions.length = 0;
  });

  test("recreated session + ttyd port ALREADY BUSY persists the fresh startTtyd pid, not the stale seeded pid", async () => {
    const startTtydSpy = spyOn(tmuxAdapterMod, "startTtyd").mockImplementation(() => FRESH_PID);
    // Instantiate the actual failing condition: the slot-1 coder ttyd port
    // (7681) is ALREADY occupied at re-init time (by the orphaned ttyd still
    // attached to the destroyed session). Force the `lsof -i :7681` probe to
    // report busy; delegate every other safeSyncOutput call (real tmux
    // session create / set-option / send) to the real implementation so the
    // recreate path runs normally. Without this, lsof returns not-busy and the
    // OLD `if (!portInUse) startTtyd(...)` would have started ttyd anyway,
    // making the fresh-pid assertion pass vacuously.
    const realSafeSync = spawnMod.safeSyncOutput;
    const safeSyncSpy = spyOn(spawnMod, "safeSyncOutput").mockImplementation((args, opts) => {
      if (Array.isArray(args) && args.includes("-i") && args.includes(":7681")) {
        return { ok: true, exitCode: 0, stdout: "ttyd 12345 user ...", stderr: "", timedOut: false };
      }
      return realSafeSync(args, opts);
    });
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    const orchDir = join(harness, "orchestration");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(orchDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-ttyd-recreate", "Recreate ttyd coherence");

    void slotAssign(1, "task-ttyd-recreate", "tmux", "", "", "--pair --coder claude --reviewer claude");

    // Seed tmux slot state with a STALE ttyd pid for the coder. The recreate
    // branch must overwrite it with the fresh startTtyd pid.
    writeFileSync(
      join(orchDir, "tmux-slot-1.json"),
      JSON.stringify({ slot: 1, ttydPids: { coder: STALE_PID }, orchestration: { stateFile: "orch-1.json", mode: "pair" } }),
    );

    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-ttyd-recreate",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "sonnet", branch: "test-coder", worktreePath: "/tmp/wt-coder" },
      ],
      agentStates: initAgentRuntimeState(["coder"]),
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

    // Stub the expensive runner spawn so resume reaches the ttyd-pid write.
    const orchProcess = await import("../orchestration/process.ts");
    const startOrchSpy = spyOn(orchProcess, "startOrchestrationProcess").mockImplementation(async () => 99_997);

    createdTmuxSessions.push("s1_coder_task-ttyd-recreate");

    try {
      await slotResume(1, { startTtyd: true });

      // Harness precondition actually fired: the lsof port-busy probe was hit
      // (so portInUse=true was in play). Without this the test could silently
      // regress to the not-busy path and the mutation below would no longer be
      // caught.
      const lsofProbed = safeSyncSpy.mock.calls.some(
        (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[]).includes("-i") && (c[0] as string[]).includes(":7681"),
      );
      expect(lsofProbed).toBe(true);

      // Invariant: with the port ALREADY busy, the recreate branch still
      // restarted ttyd in the SAME operation as the session recreation and
      // persisted the live pid. Mutation: reverting the call site to the old
      // `if (!portInUse) startTtyd(...)` skips the restart (port is busy) and
      // leaves ttydPids.coder == STALE_PID — failing both assertions below.
      expect(startTtydSpy).toHaveBeenCalled();
      const persisted = JSON.parse(readFileSync(join(orchDir, "tmux-slot-1.json"), "utf-8"));
      expect(persisted.ttydPids.coder).toBe(FRESH_PID);
      expect(persisted.ttydPids.coder).not.toBe(STALE_PID);
    } finally {
      safeSyncSpy.mockRestore();
      startTtydSpy.mockRestore();
      startOrchSpy.mockRestore();
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
    // Need cluster config so clusterMachine("worker-a") resolves; also need
    // a self entry so clusterCurrentMachineName() is non-null and the
    // off-cluster guard inside ensureRemoteMachineReachable does not fire.
    process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true, includeSelf: true });

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

describe("off-cluster guard (task-93b9bcb2)", () => {
  // cluster: true with NO self entry → clusterEnabled() === true and
  // clusterCurrentMachineName() === null. This is the "cluster configured
  // but this host is not in cluster.machines" condition that should
  // trigger the new diagnostic before heartbeatIsFresh runs.

  function freshenWorkerHeartbeat(): void {
    // Fresh so the test would otherwise reach (and fail at) heartbeatIsFresh.
    // The new guard must fire BEFORE that check, replacing the misleading
    // "offline — cannot start" error.
    const hbDir = getHeartbeatsDir();
    mkdirSync(hbDir, { recursive: true });
    writeFileSync(
      join(hbDir, "worker-a.json"),
      JSON.stringify({ epoch: Math.floor(Date.now() / 1000) }),
    );
  }

  test("slotStart off-cluster throws the off-cluster diagnostic, not 'offline'", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true });

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-offcluster-1", "Off-cluster start test");

    freshenWorkerHeartbeat();
    void slotAssign(1, "task-offcluster-1", "tmux", "", "", "", "worker-a");

    await expect(slotStart(1)).rejects.toThrow(/this host is not in cluster\.machines/);
    // Ensure the misleading "offline" error is NOT surfaced off-cluster.
    await expect(slotStart(1)).rejects.not.toThrow(/offline — cannot start/);
  });

  test("slotStop (non-force) off-cluster throws the off-cluster diagnostic", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true });

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-offcluster-2", "Off-cluster stop test");

    freshenWorkerHeartbeat();
    void slotAssign(1, "task-offcluster-2", "tmux", "", "", "", "worker-a");

    await expect(slotStop(1, false, false)).rejects.toThrow(/this host is not in cluster\.machines/);
  });

  test("slotResume off-cluster throws the off-cluster diagnostic", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true });

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-offcluster-3", "Off-cluster resume test");

    freshenWorkerHeartbeat();
    void slotAssign(1, "task-offcluster-3", "tmux", "", "", "", "worker-a");

    await expect(slotResume(1)).rejects.toThrow(/this host is not in cluster\.machines/);
  });

  test("slotStop --force off-cluster succeeds and clears local state", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true });

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-offcluster-4", "Off-cluster force-stop test");

    void slotAssign(1, "task-offcluster-4", "tmux", "", "", "", "worker-a");

    // Stamp Session Started so we can verify the force path cleared it.
    const slotData = readSlotJson(1, harness);
    slotData.sessionStarted = "2026-04-04T20:00Z";
    writeSlotJson(1, slotData, harness);

    // Force-stop must NOT throw the off-cluster diagnostic — it bypasses
    // ensureRemoteMachineReachable entirely, so the new guard inherits the
    // escape hatch for free.
    await slotStop(1, true, false);

    const data = readSlotJson(1, harness);
    expect(data.sessionStarted).toBeNull();

    // No intent recorded — force stop skips remote dispatch.
    const intent = getIntentForDashboard(1);
    expect(intent).toBeNull();
  });

  test("error names the assigned machine and lists three recovery paths", async () => {
    process.env.LUDICS_CONFIG = writeConfig(TMP, { cluster: true });

    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeSlotJson(1, emptySlotData(1), harness);
    writeSlotJson(2, emptySlotData(2), harness);
    writeTask(tasksDir, "task-offcluster-5", "Off-cluster recovery-paths test");

    freshenWorkerHeartbeat();
    void slotAssign(1, "task-offcluster-5", "tmux", "", "", "", "worker-a");

    let captured: Error | null = null;
    try {
      await slotStart(1);
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).not.toBeNull();
    const msg = captured!.message;
    // Names the assigned machine.
    expect(msg).toContain('"worker-a"');
    // Recovery path 1: run from configured node.
    expect(msg).toMatch(/Run from "worker-a"/);
    // Recovery path 2: dashboard launch button.
    expect(msg).toMatch(/dashboard launch button/);
    // Recovery path 3: re-assign with --machine <thisHost>.
    expect(msg).toMatch(/--machine <thisHost>/);
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

// gh-ludics-580 AC7: worker-resume routing. On a worker, the controller-live
// slots override (set around slotResume by maybeResumeDeadOrchestrators) must
// make readSlot return the worker's own machine, so a slot it legitimately owns
// routes to LOCAL execution instead of being refused "machine offline" against
// a stale local harness clone. This is the slotResume + setWorkerSlotsOverride
// unit seam the integration test in mag.test.ts exercises end-to-end.
describe("slotResume worker override routing (gh-ludics-580)", () => {
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;

  function writeClusterConfig(): void {
    const cfgDir = join(TMP, ".config", "ludics");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.yaml"), `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: leader-box
      host: leader-box.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: self-node
      host: self-node.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
    - name: worker-a
      host: worker-a.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);
    process.env.LUDICS_CONFIG = join(cfgDir, "config.yaml");
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "self-node"; // this host = the worker
  }

  function staleLocal(slot: number): import("./types.ts").SlotData {
    // The bug's trigger: local harness clone says a DIFFERENT, offline machine.
    return { ...emptySlotData(slot), process: "orch-runner", task: "task-stale", mode: "t3code", machine: "worker-a" };
  }
  function controllerLive(slot: number): import("./types.ts").SlotData {
    // Controller-live truth: this worker (self-node) owns the slot.
    return { ...emptySlotData(slot), process: "orch-runner", task: "task-live", mode: "t3code", machine: "self-node" };
  }

  afterEach(() => {
    setWorkerSlotsOverride(null); // never leak the override across tests
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
    else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
  });

  test("control: WITHOUT the override, slotResume reads the stale local clone and refuses (machine offline)", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeClusterConfig();
    writeSlotJson(2, emptySlotData(2), harness);
    writeSlotJson(1, staleLocal(1), harness); // machine=worker-a, no heartbeat → offline

    await expect(slotResume(1)).rejects.toThrow("offline — cannot resume");
  });

  test("WITH the override, slotResume routes locally (no offline refusal) and fails only on the t3code-state check", async () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });
    writeClusterConfig();
    writeSlotJson(2, emptySlotData(2), harness);
    writeSlotJson(1, staleLocal(1), harness); // stale local would say worker-a/offline

    // Controller-live override: slot 1 belongs to self-node (this worker).
    setWorkerSlotsOverride(new Map([[1, controllerLive(1)]]));

    // Invariant: readSlot returns self-node → isRemoteMachine(self-node)=false →
    // LOCAL execution. Resume then fails only because no t3code slot state was
    // persisted — NOT the machine-identity refusal. Mutation control: if the
    // override were ignored (readSlot → stale worker-a), this would reject with
    // "offline — cannot resume" and the assertions below would fail.
    await expect(slotResume(1)).rejects.toThrow("no persisted t3code state");
    await expect(slotResume(1)).rejects.not.toThrow("offline — cannot resume");
  });
});

// gh-ludics-584: persistSlotLiveness must persist to AUTHORITATIVE state
// worker-first — the worker branch POSTs to the controller WITHOUT reading the
// local slot clone, because that clone may be stale/empty (gh-ludics-580) and an
// `(empty)` clone would otherwise early-return and silently drop the escalation
// the resume circuit-breaker depends on.
describe("persistSlotLiveness — worker-first authoritative liveness (gh-ludics-584)", () => {
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;

  function writeClusterConfig(): void {
    const cfgDir = join(TMP, ".config", "ludics");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.yaml"), `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: leader-box
      host: leader-box.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: self-node
      host: self-node.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);
    process.env.LUDICS_CONFIG = join(cfgDir, "config.yaml");
  }

  afterEach(() => {
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
    else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
  });

  test("worker + STALE/EMPTY local clone → POSTs {liveness} to controller, never reads local (stale-clone case)", async () => {
    writeClusterConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "self-node"; // worker context

    // The #580 trap: the local clone is EMPTY (process="(empty)"). A readSlot-
    // first helper would early-return here and NEVER escalate the authoritative
    // slot. The controller-live slot is active, so escalation MUST still POST.
    writeSlotJson(1, emptySlotData(1)); // local clone = (empty)

    // Observe the real worker transport: clusterPostSlotUpdate → resolveAndPost
    // → clusterHttpPost → global `fetch`. Spying `fetch` (a true global) is
    // reliable, unlike spying the dynamically-imported cluster-http namespace.
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch);
    try {
      await persistSlotLiveness(1, "escalated");
    } finally {
      fetchSpy.mockRestore();
    }

    // Invariant: the authoritative (controller) slot is updated despite the
    // empty local clone. Mutation control: a `readSlot()`-before-branch helper
    // would early-return on (empty) → zero POSTs → this fails.
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/api/cluster/slot-update");
    expect(calls[0]!.body).toMatchObject({ slot: 1, liveness: "escalated" });

    // And the worker branch must NOT have written the local clone.
    expect(readSlotJson(1).liveness).toBeNull();
  });

  test("controller/standalone → writes liveness to the local authoritative slot, no HTTP POST", async () => {
    // Default writeConfig() (beforeEach) has no cluster block → isWorkerContext
    // is false → local harness is authoritative.
    writeSlotJson(1, { ...emptySlotData(1), process: "orch-runner", task: "task-x", machine: "" });

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      await persistSlotLiveness(1, "escalated");
    } finally {
      fetchSpy.mockRestore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readSlotJson(1).liveness).toBe("escalated");
  });

  test("controller/standalone + (empty) slot → no-op (no write, no POST)", async () => {
    writeSlotJson(1, emptySlotData(1)); // process = "(empty)"

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      await persistSlotLiveness(1, "escalated");
    } finally {
      fetchSpy.mockRestore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readSlotJson(1).liveness).toBeNull();
  });
});
