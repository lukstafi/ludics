import { describe, expect, test } from "bun:test";
import { canReuseSlotThread, orchestratedThreadTitle, parseT3CodeAdapterArgs, startOrchestrationProcess } from "./t3code.ts";
import type { T3CodeThreadRecord } from "../t3code/types.ts";
import { mergeAdapterState } from "../slots/markdown.ts";

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

  test("parses duo orchestration defaults", () => {
    const parsed = parseT3CodeAdapterArgs("--duo --clarify --plan");
    expect(parsed.orchestration?.mode).toBe("duo");
    expect(parsed.orchestration?.config.enableClarify).toBe(true);
    expect(parsed.orchestration?.config.enablePlan).toBe(true);
    expect(parsed.orchestration?.agents).toHaveLength(2);
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
  const slotBlock = [
    "## Slot 2",
    "",
    "**Process:** my-task",
    "**Task:** gh-ludics-46",
    "**Mode:** t3code",
    "**Session:** null",
    "**Path:** /tmp/repo",
    "**Started:** 2026-03-15T00:00:00Z",
    "**Adapter Args:** null",
    "",
    "**Terminals:**",
    "",
    "**Runtime:**",
    "",
    "**Git:**",
  ].join("\n");

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

    const result = mergeAdapterState(slotBlock, adapterOutput);
    expect(result).toContain("**Session:** thread-slot-2-abc123");
    expect(result).not.toContain("**Session:** null");
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

    const afterFirst = mergeAdapterState(slotBlock, firstOutput);
    expect(afterFirst).toContain("**Session:** thread-slot-2-abc123");

    // Second refresh with same session ID
    const secondResult = mergeAdapterState(afterFirst, firstOutput);
    expect(secondResult).toContain("**Session:** thread-slot-2-abc123");
    expect(secondResult).not.toContain("**Session:** null");
  });

  test("Session is not cleared when adapter output lacks Session line", () => {
    // First, set session
    const withSession = slotBlock.replace("**Session:** null", "**Session:** thread-existing");

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
    expect(result).toContain("**Session:** thread-existing");
  });
});
