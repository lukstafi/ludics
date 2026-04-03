import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AdapterContext } from "./types.ts";

describe("tmux adapter exports", () => {
  test("adapter module is importable", async () => {
    const mod = await import("./tmux-adapter.ts");
    expect(typeof mod.readState).toBe("function");
    expect(typeof mod.start).toBe("function");
    expect(typeof mod.stop).toBe("function");
    expect(typeof mod.lastActivity).toBe("function");
    expect(typeof mod.readTmuxSlotState).toBe("function");
    expect(typeof mod.writeTmuxSlotState).toBe("function");
    expect(typeof mod.removeTmuxSlotState).toBe("function");
  });

  test("default export satisfies Adapter shape", async () => {
    const mod = await import("./tmux-adapter.ts");
    const adapter = mod.default;
    expect(adapter).toBeDefined();
    expect(typeof adapter.readState).toBe("function");
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(typeof adapter.lastActivity).toBe("function");
  });
});

describe("tmux adapter registration", () => {
  test("tmux adapter is registered in adapter index", async () => {
    // The adapter index should expose tmux via runAdapterAction
    const { readAdapterState } = await import("./index.ts");
    // Calling readAdapterState with mode=tmux should not throw "adapter not found"
    // (it will return null because there's no slot state, but the adapter is found)
    const ctx = {
      slot: 99,
      mode: "tmux",
      session: "test",
      path: "/tmp",
      taskId: "test",
      adapterArgs: "",
      process: "test",
      harnessDir: "/tmp/nonexistent-harness",
      stateRepoDir: "/tmp",
    };
    const result = await readAdapterState(ctx);
    // Should return null (no tmux slot state) rather than throwing
    expect(result).toBeNull();
  });
});

describe("orchestration state backend field", () => {
  test("OrchestrationState type allows backend field", async () => {
    const { defaultOrchestrationConfig, initAgentRuntimeState } = await import("../orchestration/state.ts");
    const state = {
      slot: 1,
      taskId: "test",
      mode: "pair" as const,
      phase: "setup" as const,
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: initAgentRuntimeState([]),
      config: defaultOrchestrationConfig({}),
      phaseStartedAt: 0,
      startedAt: "2026-01-01T00:00:00Z",
      projectDir: "/tmp",
      rootWorktree: "/tmp",
      peerSyncDir: "/tmp",
      threadIds: {},
      backend: "tmux" as const,
    };
    expect(state.backend).toBe("tmux");
  });

  test("backend field defaults to undefined for backward compat", async () => {
    const { defaultOrchestrationConfig, initAgentRuntimeState } = await import("../orchestration/state.ts");
    type OrchestrationState = import("../orchestration/state.ts").OrchestrationState;
    const state: OrchestrationState = {
      slot: 1,
      taskId: "test",
      mode: "pair" as const,
      phase: "setup" as const,
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: initAgentRuntimeState([]),
      config: defaultOrchestrationConfig({}),
      phaseStartedAt: 0,
      startedAt: "2026-01-01T00:00:00Z",
      projectDir: "/tmp",
      rootWorktree: "/tmp",
      peerSyncDir: "/tmp",
      threadIds: {},
    };
    expect(state.backend).toBeUndefined();
  });
});

describe("tmux adapter stop — preserveState", () => {
  let TMP = "";

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-tmux-stop-"));
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  function makeHarness(): string {
    const harness = join(TMP, "harness");
    mkdirSync(join(harness, "orchestration"), { recursive: true });
    return harness;
  }

  function makeCtx(harness: string): AdapterContext {
    return {
      slot: 1,
      mode: "tmux",
      session: "test",
      path: "/tmp",
      taskId: "test-task",
      adapterArgs: "",
      process: "test",
      harnessDir: harness,
      stateRepoDir: TMP,
    };
  }

  function writeTmuxState(harness: string): void {
    writeFileSync(
      join(harness, "orchestration", "tmux-slot-1.json"),
      JSON.stringify({ slot: 1, ttydPids: {}, orchestration: { stateFile: "slot-1.json", mode: "pair" } }),
    );
  }

  function writeOrchState(harness: string): void {
    const { defaultOrchestrationConfig, initAgentRuntimeState } = require("../orchestration/state.ts");
    const { persistState } = require("../orchestration/state.ts");
    const state = {
      slot: 1,
      taskId: "test-task",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: initAgentRuntimeState([]),
      config: defaultOrchestrationConfig({}),
      phaseStartedAt: 0,
      startedAt: "2026-01-01T00:00:00Z",
      projectDir: "/tmp/nonexistent-project",
      rootWorktree: "/tmp",
      peerSyncDir: "/tmp/nonexistent-peersync",
      threadIds: {},
      backend: "tmux",
    };
    persistState(state, harness);
  }

  test("preserveState: true keeps tmux slot state and orchestration state", async () => {
    const harness = makeHarness();
    writeTmuxState(harness);
    writeOrchState(harness);

    const { stop } = await import("./tmux-adapter.ts");
    const ctx = makeCtx(harness);
    const result = await stop(ctx, { preserveState: true });

    expect(result).toContain("stopped");
    expect(existsSync(join(harness, "orchestration", "tmux-slot-1.json"))).toBe(true);
    expect(existsSync(join(harness, "orchestration", "slot-1.json"))).toBe(true);
  });

  test("preserveState: false removes tmux slot state", async () => {
    const harness = makeHarness();
    // Write tmux state without orchestration reference — tests adapter state removal only
    writeFileSync(
      join(harness, "orchestration", "tmux-slot-1.json"),
      JSON.stringify({ slot: 1, ttydPids: {} }),
    );

    const { stop } = await import("./tmux-adapter.ts");
    const ctx = makeCtx(harness);
    const result = await stop(ctx, { preserveState: false });

    expect(result).toContain("stopped");
    expect(existsSync(join(harness, "orchestration", "tmux-slot-1.json"))).toBe(false);
  });
});
