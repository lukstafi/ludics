import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { canReuseSlotThread, orchestratedThreadTitle, parseT3CodeAdapterArgs, startOrchestrationProcess, stop } from "./t3code.ts";
import type { T3CodeThreadRecord } from "../t3code/types.ts";
import { mergeAdapterState } from "../slots/markdown.ts";
import { emptySlotData } from "../slots/json.ts";
import type { SlotData } from "../slots/types.ts";
import type { AdapterContext } from "./types.ts";

function makeThread(overrides: Partial<T3CodeThreadRecord> = {}): T3CodeThreadRecord {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    worktreePath: "/tmp/repo-a",
    title: "task-1",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-03-07T00:00:00Z",
    updatedAt: "2026-03-07T00:00:00Z",
    ...overrides,
  };
}

describe("canReuseSlotThread", () => {
  test("reuses a thread only when workspace and config still match", () => {
    const existing = makeThread();
    expect(
      canReuseSlotThread(existing, {
        worktreePath: "/tmp/repo-a",
        title: "task-1",
        model: "gpt-5.4",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBe(true);
  });

  test("rejects reuse when the slot points to a different workspace", () => {
    const existing = makeThread();
    expect(
      canReuseSlotThread(existing, {
        worktreePath: "/tmp/repo-b",
        title: "task-1",
        model: "gpt-5.4",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBe(false);
  });

  test("rejects reuse when model or mode changed", () => {
    const existing = makeThread();
    expect(
      canReuseSlotThread(existing, {
        worktreePath: "/tmp/repo-a",
        title: "task-1",
        model: "gpt-5.3-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBe(false);
    expect(
      canReuseSlotThread(existing, {
        worktreePath: "/tmp/repo-a",
        title: "task-1",
        model: "gpt-5.4",
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
    ).toBe(false);
  });
});

describe("parseT3CodeAdapterArgs", () => {
  test("parses classic single-thread options", () => {
    const parsed = parseT3CodeAdapterArgs("--model gpt-5.5 --title test --runtime-mode full-access");
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.title).toBe("test");
    expect(parsed.orchestration).toBeNull();
  });

  test("--duo is treated as --pair (hierarchical duo expansion happens at slot level)", () => {
    const parsed = parseT3CodeAdapterArgs("--duo --clarify --plan");
    expect(parsed.orchestration?.mode).toBe("pair");
    expect(parsed.orchestration?.config.enableClarify).toBe(true);
    expect(parsed.orchestration?.config.enablePlan).toBe(true);
    // --duo now produces pair-mode agents (coder + reviewer), not old duo agents
    expect(parsed.orchestration?.agents).toHaveLength(2);
    expect(parsed.orchestration?.agents[0]?.role).toBe("coder");
    expect(parsed.orchestration?.agents[1]?.role).toBe("reviewer");
  });

  test("parses pair role overrides", () => {
    const parsed = parseT3CodeAdapterArgs("--pair --coder codex:gpt-5.6 --reviewer reviewer:claude-code:gpt-5.7");
    expect(parsed.orchestration?.mode).toBe("pair");
    expect(parsed.orchestration?.agents[0]?.role).toBe("coder");
    expect(parsed.orchestration?.agents[0]?.provider).toBe("codex");
    expect(parsed.orchestration?.agents[1]?.name).toBe("reviewer");
    expect(parsed.orchestration?.agents[1]?.provider).toBe("claude-code");
  });
});

describe("orchestratedThreadTitle", () => {
  test("produces s<slot>_<role>_<taskId> when taskId is present", () => {
    expect(orchestratedThreadTitle(2, "coder", "task-0df412c1")).toBe(
      "s2_coder_task-0df412c1",
    );
  });

  test("falls back to role when taskId is empty string", () => {
    expect(orchestratedThreadTitle(3, "reviewer", "")).toBe(
      "s3_reviewer_reviewer",
    );
  });

  test("falls back to role when taskId is undefined", () => {
    expect(orchestratedThreadTitle(5, "agent-a", undefined)).toBe(
      "s5_agent-a_agent-a",
    );
  });

  test("falls back to role when taskId is 'null' string", () => {
    expect(orchestratedThreadTitle(1, "coder", "null")).toBe(
      "s1_coder_coder",
    );
  });

  test("uses agent name as role in duo mode", () => {
    expect(orchestratedThreadTitle(4, "agent-b", "task-abc")).toBe(
      "s4_agent-b_task-abc",
    );
  });
});

describe("startOrchestrationProcess export", () => {
  test("is exported as a function", () => {
    expect(typeof startOrchestrationProcess).toBe("function");
  });
});

describe("mergeAdapterState updates Session from adapter output", () => {
  const slotData: SlotData = {
    ...emptySlotData(2),
    process: "my-task",
    task: "gh-ludics-46",
    mode: "t3code",
    session: null,
    path: "/tmp/repo",
    started: "2026-03-15T00:00:00Z",
  };

  test("Session field is populated from adapter output", () => {
    const adapterOutput = [
      "**Mode:** t3code",
      "**Session:** thread-slot-2-abc123",
      "",
      "**Terminals:**",
      "- Web: http://localhost:3000/thread-slot-2-abc123",
      "",
      "**Runtime:**",
      "- Thread: my-task (thread-slot-2-abc123)",
      "",
      "**Git:**",
      "- Working directory: /tmp/repo",
    ].join("\n");

    const result = mergeAdapterState(slotData, adapterOutput);
    expect(result.session).toBe("thread-slot-2-abc123");
  });

  test("Session persists across multiple refreshes", () => {
    const firstOutput = [
      "**Mode:** t3code",
      "**Session:** thread-slot-2-abc123",
      "",
      "**Terminals:**",
      "- Web: http://localhost:3000/thread-slot-2-abc123",
      "",
      "**Runtime:**",
      "",
      "**Git:**",
    ].join("\n");

    const afterFirst = mergeAdapterState(slotData, firstOutput);
    expect(afterFirst.session).toBe("thread-slot-2-abc123");

    // Second refresh with same session ID
    const secondResult = mergeAdapterState(afterFirst, firstOutput);
    expect(secondResult.session).toBe("thread-slot-2-abc123");
  });

  test("Session is not cleared when adapter output lacks Session line", () => {
    const withSession: SlotData = { ...slotData, session: "thread-existing" };

    const adapterOutput = [
      "**Mode:** t3code",
      "",
      "**Terminals:**",
      "- Web: http://localhost:3000/thread-existing",
      "",
      "**Runtime:**",
      "",
      "**Git:**",
    ].join("\n");

    const result = mergeAdapterState(withSession, adapterOutput);
    expect(result.session).toBe("thread-existing");
  });
});

describe("t3code adapter stop — preserveState", () => {
  let TMP = "";

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-t3code-stop-"));
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  function makeHarness(): string {
    const harness = join(TMP, "harness");
    mkdirSync(join(harness, "orchestration"), { recursive: true });
    mkdirSync(join(harness, "t3code"), { recursive: true });
    return harness;
  }

  function makeCtx(harness: string): AdapterContext {
    return {
      slot: 1,
      mode: "t3code",
      session: "test",
      path: "/tmp",
      taskId: "test-task",
      adapterArgs: "",
      process: "test",
      harnessDir: harness,
      stateRepoDir: TMP,
    };
  }

  function writeT3codeSlotState(harness: string): void {
    writeFileSync(
      join(harness, "t3code", "slot-1.json"),
      JSON.stringify({
        slot: 1,
        threads: [{ threadId: "t-1", projectId: "p-1", worktreePath: "/tmp/x", title: "test", model: "gpt-5.4", runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-03-07", updatedAt: "2026-03-07" }],
        orchestration: { stateFile: "slot-1.json" },
      }),
    );
  }

  function writeOrchState(harness: string): void {
    const { persistState, defaultOrchestrationConfig, initAgentRuntimeState } = require("../orchestration/state.ts");
    persistState({
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
      backend: "t3code",
    }, harness);
  }

  test("preserveState: true keeps t3code slot state and orchestration state", async () => {
    const harness = makeHarness();
    writeT3codeSlotState(harness);
    writeOrchState(harness);

    const ctx = makeCtx(harness);
    const result = await stop(ctx, { preserveState: true });

    expect(result).toContain("stopped");
    expect(existsSync(join(harness, "t3code", "slot-1.json"))).toBe(true);
    expect(existsSync(join(harness, "orchestration", "slot-1.json"))).toBe(true);
  });

  test("preserveState: false removes t3code slot state", async () => {
    const harness = makeHarness();
    // Write t3code state without orchestration reference — tests adapter state removal only
    writeFileSync(
      join(harness, "t3code", "slot-1.json"),
      JSON.stringify({
        slot: 1,
        threads: [{ threadId: "t-1", projectId: "p-1", worktreePath: "/tmp/x", title: "test", model: "gpt-5.4", runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-03-07", updatedAt: "2026-03-07" }],
      }),
    );

    const ctx = makeCtx(harness);
    const result = await stop(ctx, { preserveState: false });

    expect(result).toContain("stopped");
    expect(existsSync(join(harness, "t3code", "slot-1.json"))).toBe(false);
  });
});
