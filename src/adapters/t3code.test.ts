import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildOrchestratedDesiredThreadConfig, canReuseSlotThread, orchestratedThreadTitle, parseOrchestrationAdapterArgs, startOrchestrationProcess, stop, selectOrchestrationFlags, selectOrchestrationFlagsForTask } from "./t3code.ts";
import type { T3CodeThreadRecord } from "../t3code/types.ts";
import { mergeAdapterState } from "../slots/markdown.ts";
import { emptySlotData } from "../slots/json.ts";
import type { SlotData } from "../slots/types.ts";
import type { AdapterContext } from "./types.ts";
import { persistState, defaultOrchestrationConfig, initAgentRuntimeState } from "../orchestration/state.ts";

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

describe("parseOrchestrationAdapterArgs", () => {
  test("parses classic single-thread options", () => {
    const parsed = parseOrchestrationAdapterArgs("--model gpt-5.5 --title test --runtime-mode full-access");
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.title).toBe("test");
    expect(parsed.orchestration).toBeNull();
  });

  test("--duo is treated as --pair (hierarchical duo expansion happens at slot level)", () => {
    const parsed = parseOrchestrationAdapterArgs("--duo --clarify --plan");
    expect(parsed.orchestration?.mode).toBe("pair");
    expect(parsed.orchestration?.config.enableClarify).toBe(true);
    expect(parsed.orchestration?.config.enablePlan).toBe(true);
    // --duo now produces pair-mode agents (coder + reviewer), not old duo agents
    expect(parsed.orchestration?.agents).toHaveLength(2);
    expect(parsed.orchestration?.agents[0]?.role).toBe("coder");
    expect(parsed.orchestration?.agents[1]?.role).toBe("reviewer");
  });

  test("parses pair role overrides", () => {
    const parsed = parseOrchestrationAdapterArgs("--pair --coder codex:gpt-5.6 --reviewer reviewer:claude-code:gpt-5.7");
    expect(parsed.orchestration?.mode).toBe("pair");
    expect(parsed.orchestration?.agents[0]?.role).toBe("coder");
    expect(parsed.orchestration?.agents[0]?.provider).toBe("codex");
    expect(parsed.orchestration?.agents[1]?.name).toBe("reviewer");
    expect(parsed.orchestration?.agents[1]?.provider).toBe("claude-code");
  });

  test("--auto-recover-wrong-filename sets autoRecoverWrongFilename to true", () => {
    const parsed = parseOrchestrationAdapterArgs("--pair --auto-recover-wrong-filename");
    expect(parsed.orchestration?.config.autoRecoverWrongFilename).toBe(true);
  });

  test("--no-auto-recover-wrong-filename sets autoRecoverWrongFilename to false", () => {
    const parsed = parseOrchestrationAdapterArgs("--pair --no-auto-recover-wrong-filename");
    expect(parsed.orchestration?.config.autoRecoverWrongFilename).toBe(false);
  });

  test("default autoRecoverWrongFilename is true when no flag is passed", () => {
    const parsed = parseOrchestrationAdapterArgs("--pair");
    // Adapter parser writes a partial config; the absence of an explicit
    // toggle leaves the field unset, and defaultOrchestrationConfig() (used
    // when the partial is plumbed through tmux/t3code start paths) supplies
    // the default. The runtime-effective default is asserted in
    // wrong-filename-recovery.test.ts; this assertion locks in that the
    // adapter parser does NOT silently force the field to false.
    expect(parsed.orchestration?.config.autoRecoverWrongFilename).not.toBe(false);
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

describe("selectOrchestrationFlags — skip_plan", () => {
  test("medium effort without skipPlan includes --plan", () => {
    const { args } = selectOrchestrationFlags("medium");
    expect(args).toContain("--plan");
  });

  test("medium effort with skipPlan: true omits --plan", () => {
    const { args } = selectOrchestrationFlags("medium", undefined, { skipPlan: true });
    expect(args).not.toContain("--plan");
  });

  test("large effort with skipPlan: true still includes --plan --gather", () => {
    const { args } = selectOrchestrationFlags("large", undefined, { skipPlan: true });
    expect(args).toContain("--plan");
    expect(args).toContain("--gather");
  });

  test("small effort with skipPlan: true has no phase flags", () => {
    const { args } = selectOrchestrationFlags("small", undefined, { skipPlan: true });
    expect(args).not.toContain("--plan");
    expect(args).not.toContain("--gather");
  });

  test("small effort without skipPlan has no phase flags", () => {
    const { args } = selectOrchestrationFlags("small");
    expect(args).not.toContain("--plan");
    expect(args).not.toContain("--gather");
  });

  test("large effort without skipPlan includes --plan --gather", () => {
    const { args } = selectOrchestrationFlags("large");
    expect(args).toContain("--plan");
    expect(args).toContain("--gather");
  });

  test("unknown effort has no phase flags", () => {
    const { args } = selectOrchestrationFlags("");
    expect(args).not.toContain("--plan");
    expect(args).not.toContain("--gather");
  });
});

describe("selectOrchestrationFlagsForTask — skip_plan from frontmatter", () => {
  test("medium task with skip_plan: true omits --plan", () => {
    const content = "---\nid: test\ntitle: test\neffort: medium\nskip_plan: true\n---\n";
    const { args } = selectOrchestrationFlagsForTask(content, "medium");
    expect(args).not.toContain("--plan");
  });

  test("medium task without skip_plan includes --plan", () => {
    const content = "---\nid: test\ntitle: test\neffort: medium\n---\n";
    const { args } = selectOrchestrationFlagsForTask(content, "medium");
    expect(args).toContain("--plan");
  });

  test("large task with skip_plan: true still includes --plan --gather", () => {
    const content = "---\nid: test\ntitle: test\neffort: large\nskip_plan: true\n---\n";
    const { args } = selectOrchestrationFlagsForTask(content, "large");
    expect(args).toContain("--plan");
    expect(args).toContain("--gather");
  });

  test("small task with skip_plan: true in frontmatter still omits --plan", () => {
    const content = "---\nid: test\ntitle: test\neffort: small\nskip_plan: true\n---\n";
    const { args } = selectOrchestrationFlagsForTask(content, "small");
    expect(args).not.toContain("--plan");
    expect(args).not.toContain("--gather");
  });

  test("small task without skip_plan omits --plan", () => {
    const content = "---\nid: test\ntitle: test\neffort: small\n---\n";
    const { args } = selectOrchestrationFlagsForTask(content, "small");
    expect(args).not.toContain("--plan");
    expect(args).not.toContain("--gather");
  });
});

describe("parseOrchestrationAdapterArgs — --solo", () => {
  test("parses --solo with --coder into a single-agent orchestration", () => {
    // Token format: name:provider:model
    const parsed = parseOrchestrationAdapterArgs("--solo --coder coder:claude-code:claude-sonnet-4-6");
    expect(parsed.orchestration).not.toBeNull();
    expect(parsed.orchestration!.mode).toBe("solo");
    expect(parsed.orchestration!.agents).toHaveLength(1);
    expect(parsed.orchestration!.agents[0]!.role).toBe("coder");
    expect(parsed.orchestration!.agents[0]!.provider).toBe("claude-code");
    expect(parsed.orchestration!.agents[0]!.model).toBe("claude-sonnet-4-6");
    expect(parsed.orchestration!.agents[0]!.name).toBe("coder");
  });

  test("parses --solo --coder <provider> (bare provider) with default model", () => {
    const parsed = parseOrchestrationAdapterArgs("--solo --coder claude-code");
    expect(parsed.orchestration!.mode).toBe("solo");
    expect(parsed.orchestration!.agents).toHaveLength(1);
    expect(parsed.orchestration!.agents[0]!.provider).toBe("claude-code");
  });

  test("--solo without --coder throws", () => {
    expect(() => parseOrchestrationAdapterArgs("--solo")).toThrow(/--solo requires --coder/);
  });

  test("--solo combined with --reviewer throws", () => {
    expect(() =>
      parseOrchestrationAdapterArgs("--solo --coder claude-code --reviewer codex")
    ).toThrow(/--solo is incompatible with --reviewer/);
  });

  test("--solo combined with --duo-peer-slot throws", () => {
    expect(() =>
      parseOrchestrationAdapterArgs("--solo --coder claude-code --duo-peer-slot=2")
    ).toThrow(/--solo is incompatible with --duo-peer-slot/);
  });

  test("--solo combined with --reviewer-model throws (reviewer-only override)", () => {
    expect(() =>
      parseOrchestrationAdapterArgs("--solo --coder claude-code --reviewer-model gpt-5.4")
    ).toThrow(/--solo is incompatible with --reviewer-model/);
  });

  test("--solo combined with --reviewer-effort throws", () => {
    expect(() =>
      parseOrchestrationAdapterArgs("--solo --coder claude-code --reviewer-effort low")
    ).toThrow(/--solo is incompatible with --reviewer-effort/);
  });

  test("--solo combined with --reviewer-thinking-effort throws", () => {
    expect(() =>
      parseOrchestrationAdapterArgs("--solo --coder claude-code --reviewer-thinking-effort low")
    ).toThrow(/--solo is incompatible with --reviewer-thinking-effort/);
  });

  test("--solo accepts shared --effort flag (coder half applied)", () => {
    // --effort is a shared flag that sets both coder and reviewer effort.
    // In solo the reviewer half is discarded; this is not a reviewer-only flag
    // so it must not be rejected.
    const parsed = parseOrchestrationAdapterArgs("--solo --coder claude-code --effort high");
    expect(parsed.orchestration!.mode).toBe("solo");
    expect(parsed.orchestration!.coderThinkingEffort).toBe("high");
    expect(parsed.orchestration!.reviewerThinkingEffort).toBeUndefined();
  });

  test("--solo accepts --coder-model and --coder-effort", () => {
    const parsed = parseOrchestrationAdapterArgs("--solo --coder claude-code --coder-model claude-opus-4-6 --coder-effort high");
    expect(parsed.orchestration!.mode).toBe("solo");
    expect(parsed.orchestration!.coderModelOverride).toBe("claude-opus-4-6");
    expect(parsed.orchestration!.coderThinkingEffort).toBe("high");
  });

  test("--solo supports --plan / --clarify config flags (orthogonal to mode)", () => {
    // Even though auto-select for tiny omits pre-work phases, explicit --solo --plan
    // is valid: config flags are orthogonal to mode.
    const parsed = parseOrchestrationAdapterArgs("--solo --coder claude-code --plan");
    expect(parsed.orchestration!.config.enablePlan).toBe(true);
  });
});

describe("selectOrchestrationFlags — tiny effort", () => {
  test("tiny effort emits --solo with Sonnet for claude-code default", () => {
    const { adapter, args, isDuo } = selectOrchestrationFlags("tiny");
    expect(args).toContain("--solo");
    expect(args).toContain("--coder claude-code");
    expect(args).toContain(":claude-sonnet-4-6");
    expect(args).not.toContain("--pair");
    expect(args).not.toContain("--reviewer");
    expect(args).not.toContain("--plan");
    expect(args).not.toContain("--gather");
    expect(isDuo).toBe(false);
    expect(adapter).toMatch(/t3code|tmux/);
  });

  test("tiny effort ignores orchCfg.default_mode (forces solo)", () => {
    const fakeConfig = {
      mag: { orchestration: { default_mode: "pair", default_coder: "claude-code", default_reviewer: "codex" } },
    } as unknown as Parameters<typeof selectOrchestrationFlags>[1];
    const { args, isDuo } = selectOrchestrationFlags("tiny", fakeConfig);
    expect(args).toContain("--solo");
    expect(args).not.toContain("--pair");
    expect(isDuo).toBe(false);
  });

  test("tiny effort with codex coder emits no model suffix", () => {
    const fakeConfig = {
      mag: { orchestration: { default_coder: "codex", default_reviewer: "codex" } },
    } as unknown as Parameters<typeof selectOrchestrationFlags>[1];
    const { args } = selectOrchestrationFlags("tiny", fakeConfig);
    expect(args).toContain("--solo --coder codex");
    expect(args).not.toContain(":claude-sonnet");
  });
});

// ---------------------------------------------------------------------------
// Scope (3a) cold-start CWD invariant — t3code backend.
// (`proposal-commit-on-main-and-worktree-resume`.)
//
// Pins that an agent's `DesiredThreadConfig` (the payload dispatched to the
// t3code server's `thread.create`) carries `worktreePath: agent.worktreePath`
// — i.e. the per-agent path returned by `createWorktrees` flows unchanged
// to the boundary the t3code server stores on the thread, which then drives
// the spawned agent's CWD.
//
// Asserting at the boundary is sufficient: the t3code server-side handling
// of `worktreePath` is out of scope for this task. Subsequent-turn CWD is
// not asserted because `T3CodeTransport.sendTurn` dispatches against the
// stored thread without ever sending a different worktreePath.
// ---------------------------------------------------------------------------

describe("t3code adapter cold-start DesiredThreadConfig", () => {
  test("orchestrated DesiredThreadConfig carries the agent's worktreePath unchanged at the thread.create boundary", () => {
    // Each agent in duo mode gets a distinct per-agent worktree from
    // createWorktrees; the AC pins that worktreePath flows into the
    // dispatched DesiredThreadConfig per agent without aliasing or
    // collapsing onto the slot's primary worktree.
    const coderAgent = {
      name: "coder",
      role: "coder",
      model: "claude-sonnet-4-6",
      provider: "claude-code" as const,
      branch: "ludics/task-cs/coder",
      worktreePath: "/tmp/proj-task-cs-coder",
    };
    const reviewerAgent = {
      name: "reviewer",
      role: "reviewer",
      model: "gpt-5.4",
      provider: "codex" as const,
      branch: "ludics/task-cs/reviewer",
      worktreePath: "/tmp/proj-task-cs-reviewer",
    };

    const slot = 7;
    const opts = { runtimeMode: "full-access" as const, interactionMode: "default" as const };

    const desiredCoder = buildOrchestratedDesiredThreadConfig(coderAgent, slot, "task-cs", opts);
    const desiredReviewer = buildOrchestratedDesiredThreadConfig(reviewerAgent, slot, "task-cs", opts);

    // The named-seam invariant: each per-agent DesiredThreadConfig's
    // worktreePath equals the agent's per-agent worktree. Mutation:
    // collapsing the runner's per-agent loop to use a single workspace
    // root would make these expectations diverge.
    expect(desiredCoder.worktreePath).toBe("/tmp/proj-task-cs-coder");
    expect(desiredReviewer.worktreePath).toBe("/tmp/proj-task-cs-reviewer");
    expect(desiredCoder.worktreePath).not.toBe(desiredReviewer.worktreePath);

    // Branch and provider are also per-agent — sanity that the helper
    // does not silently ignore agent fields.
    expect(desiredCoder.branch).toBe("ludics/task-cs/coder");
    expect(desiredReviewer.branch).toBe("ludics/task-cs/reviewer");
    expect(desiredCoder.provider).toBe("claude-code");
    expect(desiredReviewer.provider).toBe("codex");
  });
});
