import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slotDataToMarkdown, normalizeTaskId } from "./json.ts";
import { migrateMarkdownToSlotData } from "./migration.ts";
import type { SlotData } from "./types.ts";

describe("slotDataToMarkdown round-trip fidelity", () => {
  test("fully-populated SlotData has every field in markdown output", () => {
    const data: SlotData = {
      slot: 3,
      process: "running",
      task: "task-abc123",
      mode: "coder",
      session: "sess-42",
      path: "/home/user/project",
      started: "2026-04-10T12:00:00Z",
      adapterArgs: "--fast --verbose",
      machine: "dev-box-1",
      sessionStarted: "2026-04-10T11:55:00Z",
      liveness: "alive",
      terminals: "tmux:0:bash\ntmux:1:vim",
      runtime: "bun 1.2.0\nnode 22.0.0",
      git: "main +3 -1\nmodified: src/index.ts",
    };

    const md = slotDataToMarkdown(data);

    // Key-value fields appear with correct labels and values
    expect(md).toContain("## Slot 3");
    expect(md).toContain("**Process:** running");
    expect(md).toContain("**Task:** task-abc123");
    expect(md).toContain("**Mode:** coder");
    expect(md).toContain("**Session:** sess-42");
    expect(md).toContain("**Path:** /home/user/project");
    expect(md).toContain("**Started:** 2026-04-10T12:00:00Z");
    expect(md).toContain("**Adapter Args:** --fast --verbose");
    expect(md).toContain("**Machine:** dev-box-1");
    expect(md).toContain("**Session Started:** 2026-04-10T11:55:00Z");
    expect(md).toContain("**Liveness:** alive");

    // Multi-line section fields
    expect(md).toContain("**Terminals:**\ntmux:0:bash\ntmux:1:vim");
    expect(md).toContain("**Runtime:**\nbun 1.2.0\nnode 22.0.0");
    expect(md).toContain("**Git:**\nmain +3 -1\nmodified: src/index.ts");
  });

  test("null fields serialize as 'null' string", () => {
    const data: SlotData = {
      slot: 1,
      process: "idle",
      task: null,
      mode: null,
      session: null,
      path: null,
      started: null,
      adapterArgs: null,
      machine: null,
      sessionStarted: null,
      liveness: null,
      terminals: "",
      runtime: "",
      git: "",
    };

    const md = slotDataToMarkdown(data);

    expect(md).toContain("**Task:** null");
    expect(md).toContain("**Mode:** null");
    expect(md).toContain("**Session:** null");
    expect(md).toContain("**Path:** null");
    expect(md).toContain("**Started:** null");
    expect(md).toContain("**Adapter Args:** null");
    expect(md).toContain("**Machine:** null");
    expect(md).toContain("**Session Started:** null");
    expect(md).toContain("**Liveness:** null");
  });

  test("serialize -> deserialize round-trip preserves all fields (populated)", () => {
    const original: SlotData = {
      slot: 1,
      process: "running",
      task: "task-abc123",
      mode: "coder",
      session: "sess-42",
      path: "/home/user/project",
      started: "2026-04-10T12:00:00Z",
      adapterArgs: "--fast --verbose",
      machine: "dev-box-1",
      sessionStarted: "2026-04-10T11:55:00Z",
      liveness: "alive",
      terminals: "tmux:0:bash\ntmux:1:vim",
      runtime: "bun 1.2.0\nnode 22.0.0",
      git: "main +3 -1\nmodified: src/index.ts",
    };

    const tmp = mkdtempSync(join(tmpdir(), "ludics-rt-"));
    try {
      const md = slotDataToMarkdown(original);
      const slotsFile = join(tmp, "slots.md");
      writeFileSync(slotsFile, md);

      const parsed = migrateMarkdownToSlotData(slotsFile, 1);
      const result = parsed.get(1)!;

      expect(result).toEqual(original);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("serialize -> deserialize round-trip preserves null/empty fields", () => {
    const original: SlotData = {
      slot: 1,
      process: "idle",
      task: null,
      mode: null,
      session: null,
      path: null,
      started: null,
      adapterArgs: null,
      machine: null,
      sessionStarted: null,
      liveness: null,
      terminals: "",
      runtime: "",
      git: "",
    };

    const tmp = mkdtempSync(join(tmpdir(), "ludics-rt-"));
    try {
      const md = slotDataToMarkdown(original);
      const slotsFile = join(tmp, "slots.md");
      writeFileSync(slotsFile, md);

      const parsed = migrateMarkdownToSlotData(slotsFile, 1);
      const result = parsed.get(1)!;

      expect(result).toEqual(original);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("round-trip preserves 'escalated' liveness through markdown migration", () => {
    // Regression: the SlotLiveness enum narrowing (task-4cd94043) must not
    // silently collapse "escalated" to null on legacy markdown migration.
    const original: SlotData = {
      slot: 1,
      process: "running",
      task: "task-xyz",
      mode: "tmux",
      session: null,
      path: null,
      started: null,
      adapterArgs: null,
      machine: null,
      sessionStarted: null,
      liveness: "escalated",
      terminals: "",
      runtime: "",
      git: "",
    };

    const tmp = mkdtempSync(join(tmpdir(), "ludics-rt-esc-"));
    try {
      const md = slotDataToMarkdown(original);
      expect(md).toContain("**Liveness:** escalated");
      const slotsFile = join(tmp, "slots.md");
      writeFileSync(slotsFile, md);
      const parsed = migrateMarkdownToSlotData(slotsFile, 1);
      expect(parsed.get(1)!.liveness).toBe("escalated");
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("migration coerces unknown liveness string to null (forward-compat guard)", async () => {
    // parseSlotLiveness is the validation boundary: a future release writing
    // an unknown token (or a hand-edited slots.md) should degrade gracefully
    // to null rather than land an invalid enum value in runtime state.
    const { parseSlotLiveness } = await import("./types.ts");
    expect(parseSlotLiveness("alive")).toBe("alive");
    expect(parseSlotLiveness("interrupted")).toBe("interrupted");
    expect(parseSlotLiveness("escalated")).toBe("escalated");
    expect(parseSlotLiveness("  escalated  ")).toBe("escalated");
    expect(parseSlotLiveness(null)).toBeNull();
    expect(parseSlotLiveness(undefined)).toBeNull();
    expect(parseSlotLiveness("")).toBeNull();
    expect(parseSlotLiveness("bogus")).toBeNull();
    expect(parseSlotLiveness(42)).toBeNull();
  });

  test("round-trip preserves trailing spaces in section content", () => {
    const original: SlotData = {
      slot: 1,
      process: "running",
      task: null,
      mode: null,
      session: null,
      path: null,
      started: null,
      adapterArgs: null,
      machine: null,
      sessionStarted: null,
      liveness: null,
      terminals: "tmux:0:bash  ",
      runtime: "bun 1.2.0\t",
      git: "main  ",
    };

    const tmp = mkdtempSync(join(tmpdir(), "ludics-rt-"));
    try {
      const md = slotDataToMarkdown(original);
      const slotsFile = join(tmp, "slots.md");
      writeFileSync(slotsFile, md);

      const parsed = migrateMarkdownToSlotData(slotsFile, 1);
      const result = parsed.get(1)!;

      // Trailing spaces/tabs on content lines must survive round-trip
      expect(result.terminals).toBe("tmux:0:bash  ");
      expect(result.runtime).toBe("bun 1.2.0\t");
      expect(result.git).toBe("main  ");
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("normalizeTaskId returns undefined for absent/legacy-null inputs and trims real ids", () => {
    // Absent forms — every shape that callers used to gate with
    // `taskId && taskId !== "null"` must collapse to undefined here so guards
    // upstream can be a single truthiness check.
    expect(normalizeTaskId(null)).toBeUndefined();
    expect(normalizeTaskId(undefined)).toBeUndefined();
    expect(normalizeTaskId("")).toBeUndefined();
    expect(normalizeTaskId("   ")).toBeUndefined();
    expect(normalizeTaskId("null")).toBeUndefined();
    expect(normalizeTaskId("NULL")).toBeUndefined();
    expect(normalizeTaskId("  null  ")).toBeUndefined();

    // Real task ids pass through (with trim).
    expect(normalizeTaskId("task-abc123")).toBe("task-abc123");
    expect(normalizeTaskId("  task-abc123  ")).toBe("task-abc123");
  });

  test("every SlotData key is represented in the output", () => {
    const data: SlotData = {
      slot: 2,
      process: "PROC_SENTINEL",
      task: "TASK_SENTINEL",
      mode: "MODE_SENTINEL",
      session: "SESS_SENTINEL",
      path: "PATH_SENTINEL",
      started: "STARTED_SENTINEL",
      adapterArgs: "ADAPTER_SENTINEL",
      machine: "MACHINE_SENTINEL",
      sessionStarted: "SESSSTART_SENTINEL",
      // `liveness` is a narrow enum (SlotLiveness) — use the real "alive" value
      // rather than a made-up sentinel so the type still covers this key.
      liveness: "alive",
      terminals: "TERM_SENTINEL",
      runtime: "RT_SENTINEL",
      git: "GIT_SENTINEL",
    };

    const md = slotDataToMarkdown(data);

    // Every sentinel value must appear — this catches any field omission
    const keys = Object.keys(data) as (keyof SlotData)[];
    for (const key of keys) {
      const value = String(data[key]);
      expect(md).toContain(value);
    }
  });
});
