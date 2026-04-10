import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import * as events from "../events.ts";

const TMP = join(import.meta.dir, ".test-tmp-abandon");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;

// --- Mocks ---

const mockFindSlotForTask = mock(() => null as number | null);
const mockSlotClear = mock(() => {});

mock.module("../slots/index.ts", () => ({
  findSlotForTask: mockFindSlotForTask,
  slotClear: mockSlotClear,
}));

// Import after mocks are installed
const { tasksAbandon } = await import("./index.ts");

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

function writeTaskFile(
  tasksDir: string,
  id: string,
  extra: Record<string, string | boolean> = {},
): void {
  const fields = [
    `id: ${id}`,
    `title: "Test task ${id}"`,
    `project: test-project`,
    `status: ${extra.status ?? "ready"}`,
    `priority: B`,
    `completed: null`,
  ];
  if (extra.deferred_launch !== undefined) {
    fields.push(`deferred_launch: ${extra.deferred_launch}`);
  }
  if (extra.approved !== undefined) {
    fields.push(`approved: ${extra.approved}`);
  }
  writeFileSync(join(tasksDir, `${id}.md`), `---\n${fields.join("\n")}\n---\n`);
}

let eventSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);

  mockFindSlotForTask.mockReset();
  mockSlotClear.mockReset();
  mockFindSlotForTask.mockReturnValue(null);

  eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
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
  eventSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

describe("tasksAbandon", () => {
  test("abandon unslotted task — sets status to abandoned, sets completed, emits event", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskFile(tasksDir, "task-aaa", { status: "ready" });
    mockFindSlotForTask.mockReturnValue(null);

    tasksAbandon("task-aaa");

    const content = readFileSync(join(tasksDir, "task-aaa.md"), "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).toMatch(/completed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(mockSlotClear).not.toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledTimes(1);
    const event = eventSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.event_type).toBe("task_abandon");
    expect(event.status).toBe("abandoned");
  });

  test("abandon slotted task — calls slotClear, removes deferral flags, emits event", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskFile(tasksDir, "task-bbb", {
      status: "in-progress",
      deferred_launch: true,
      approved: true,
    });
    mockFindSlotForTask.mockReturnValue(2);

    tasksAbandon("task-bbb");

    expect(mockSlotClear).toHaveBeenCalledWith(2, "abandoned");
    const content = readFileSync(join(tasksDir, "task-bbb.md"), "utf-8");
    expect(content).not.toContain("deferred_launch");
    expect(content).not.toContain("approved");
    expect(eventSpy).toHaveBeenCalledTimes(1);
  });

  test("abandon task in terminal status — throws error", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    for (const status of ["done", "abandoned", "merged"]) {
      writeTaskFile(tasksDir, "task-term", { status });
      eventSpy.mockClear();

      expect(() => tasksAbandon("task-term")).toThrow("terminal status");
    }
  });

  test("abandon missing task — throws error", () => {
    const harness = join(TMP, "ludics-state", "harness");
    mkdirSync(join(harness, "tasks"), { recursive: true });

    mockFindSlotForTask.mockReturnValue(null);

    expect(() => tasksAbandon("task-nonexistent")).toThrow("task not found");
  });

  test("frontmatter cleanup — deferred_launch and approved fields removed after abandon", () => {
    const harness = join(TMP, "ludics-state", "harness");
    const tasksDir = join(harness, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeTaskFile(tasksDir, "task-ccc", {
      status: "ready",
      deferred_launch: true,
      approved: true,
    });
    mockFindSlotForTask.mockReturnValue(null);

    tasksAbandon("task-ccc");

    const content = readFileSync(join(tasksDir, "task-ccc.md"), "utf-8");
    expect(content).toContain("status: abandoned");
    expect(content).not.toContain("deferred_launch");
    expect(content).not.toContain("approved");
    expect(content).toMatch(/completed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });
});
