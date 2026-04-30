import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runTasks, tasksSetPriority } from "./index.ts";

// task-2db5eca6: `tasks priority` CLI subcommand. Increases clear the
// auto-proposal debounce sentinel; decreases and no-ops keep it intact.

const TMP = join(import.meta.dir, ".test-tmp-priority-cli");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;

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

function harness(): string {
  return join(TMP, "ludics-state", "harness");
}

function writeTaskFile(id: string, priority: string): string {
  const tasksDir = join(harness(), "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const file = join(tasksDir, `${id}.md`);
  writeFileSync(file, `---\nid: ${id}\ntitle: "${id}"\nstatus: ready\npriority: ${priority}\n---\n`);
  return file;
}

function sentinelPath(id: string): string {
  return join(harness(), "mag", "auto-proposal-debounce", `${encodeURIComponent(id)}.epoch`);
}

function writeSentinel(id: string): string {
  const path = sentinelPath(id);
  mkdirSync(join(harness(), "mag", "auto-proposal-debounce"), { recursive: true });
  writeFileSync(path, String(Date.now()));
  return path;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harness();
  mkdirSync(harness(), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("tasksSetPriority", () => {
  // AC8: increase via CLI clears sentinel
  test("B → A clears the auto-proposal debounce", async () => {
    writeTaskFile("task-X", "B");
    const sentinel = writeSentinel("task-X");
    const origLog = console.log;
    console.log = () => {};
    try {
      await tasksSetPriority("task-X", "A");
    } finally {
      console.log = origLog;
    }
    expect(existsSync(sentinel)).toBe(false);
    const content = readFileSync(join(harness(), "tasks", "task-X.md"), "utf-8");
    expect(content).toContain("priority: A");
  });

  // AC9: no-change preserves sentinel
  test("B → B is a no-op and preserves the sentinel", async () => {
    writeTaskFile("task-Y", "B");
    const sentinel = writeSentinel("task-Y");
    const origLog = console.log;
    console.log = () => {};
    try {
      await tasksSetPriority("task-Y", "B");
    } finally {
      console.log = origLog;
    }
    expect(existsSync(sentinel)).toBe(true);
    const content = readFileSync(join(harness(), "tasks", "task-Y.md"), "utf-8");
    expect(content).toContain("priority: B");
  });

  // AC10: decrease via CLI preserves the sentinel — same asymmetry as slot-postpone
  test("B → C (decrease) preserves the sentinel", async () => {
    writeTaskFile("task-Z", "B");
    const sentinel = writeSentinel("task-Z");
    const origLog = console.log;
    console.log = () => {};
    try {
      await tasksSetPriority("task-Z", "C");
    } finally {
      console.log = origLog;
    }
    expect(existsSync(sentinel)).toBe(true);
    const content = readFileSync(join(harness(), "tasks", "task-Z.md"), "utf-8");
    expect(content).toContain("priority: C");
  });

  // AC10 bridging: A → S is a 2-step jump increase across the priority scale —
  // confirms the increase gate compares numeric ranks rather than relying on the
  // single-step PRIORITY_INCREASE map.
  test("A → S clears the sentinel (multi-step increase)", async () => {
    writeTaskFile("task-W", "A");
    const sentinel = writeSentinel("task-W");
    const origLog = console.log;
    console.log = () => {};
    try {
      await tasksSetPriority("task-W", "S");
    } finally {
      console.log = origLog;
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  test("missing task file throws", async () => {
    await expect(tasksSetPriority("task-missing", "A")).rejects.toThrow(/task not found/);
  });
});

describe("runTasks priority subcommand", () => {
  // AC11: validation
  test("rejects invalid level", async () => {
    writeTaskFile("task-X", "B");
    await expect(runTasks(["priority", "task-X", "Z"])).rejects.toThrow(/invalid priority/);
  });

  test("rejects missing args", async () => {
    await expect(runTasks(["priority"])).rejects.toThrow(/task ID required/);
    await expect(runTasks(["priority", "task-X"])).rejects.toThrow(/level required/);
  });

  test("rejects trailing arguments", async () => {
    writeTaskFile("task-X", "B");
    await expect(runTasks(["priority", "task-X", "A", "extra"])).rejects.toThrow(/trailing/);
  });

  // AC8 end-to-end via dispatcher
  test("dispatcher routes B → A and clears the sentinel", async () => {
    writeTaskFile("task-X", "B");
    const sentinel = writeSentinel("task-X");
    const origLog = console.log;
    console.log = () => {};
    try {
      await runTasks(["priority", "task-X", "A"]);
    } finally {
      console.log = origLog;
    }
    expect(existsSync(sentinel)).toBe(false);
  });
});
