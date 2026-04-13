import { describe, expect, test } from "bun:test";
import { slotDataToMarkdown } from "./json.ts";
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
      liveness: "LIVE_SENTINEL",
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
