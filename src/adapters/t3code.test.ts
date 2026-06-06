import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildOrchestratedDesiredThreadConfig, canReuseSlotThread, orchestratedThreadTitle, parseOrchestrationAdapterArgs, startOrchestrationProcess, stop, selectOrchestrationFlags, selectOrchestrationFlagsForTask, isT3codeIntegrationPausedError, resolveAgentModel, classModel, providerDefaultModel } from "./t3code.ts";
import type { T3CodeThreadRecord } from "../t3code/types.ts";
import { mergeAdapterState } from "../slots/markdown.ts";
import { emptySlotData } from "../slots/json.ts";
import type { SlotData } from "../slots/types.ts";
import type { AdapterContext } from "./types.ts";
import { persistState, defaultOrchestrationConfig, initAgentRuntimeState } from "../orchestration/state.ts";

// gh-ludics-539: selectOrchestrationFlags() throws T3codeIntegrationPausedError
// when the t3code integration is paused and the resolved adapter is `t3code`.
// Harness that writes a temp config.yaml + isolates HOME / LUDICS_CONFIG so
// globalAdapter() and t3codeIntegrationEnabled() resolve deterministically.
function installT3codeConfigHarness(): {
  write: (opts: { t3codeEnabled: boolean; adapter?: "t3code" | "tmux" }) => void;
} {
  let tmpDir = "";
  const orig = { HOME: process.env.HOME, CONFIG: process.env.LUDICS_CONFIG };
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-t3code-flag-"));
    process.env.HOME = tmpDir;
  });
  afterEach(() => {
    if (orig.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = orig.HOME;
    if (orig.CONFIG === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = orig.CONFIG;
    rmSync(tmpDir, { recursive: true, force: true });
  });
  return {
    write({ t3codeEnabled, adapter = "t3code" }) {
      const dir = join(tmpDir, ".config", "ludics");
      mkdirSync(dir, { recursive: true });
      const cfgPath = join(dir, "config.yaml");
      writeFileSync(
        cfgPath,
        `state_repo: owner/ludics-state\nstate_path: harness\nadapter: ${adapter}\n`
          + `mag:\n  t3code_integration_enabled: ${t3codeEnabled}\n`
          // task-c48b7beb: latest-within-class table is the single source of
          // truth; selectOrchestrationFlags / resolveAgentModel now resolve
          // through it and throw when a tracked class is absent, so the test
          // harness must populate it (mirrors a real config.yaml).
          + `  orchestration:\n`
          + `    model_classes:\n`
          + `      codex: gpt-5.5\n`
          + `      claude-opus: claude-opus-4-8\n`
          + `      claude-sonnet: claude-sonnet-4-6\n`,
      );
      process.env.LUDICS_CONFIG = cfgPath;
    },
  };
}

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
  // gh-ludics-539: flag on so the t3code-adapter gate does not throw.
  const cfg = installT3codeConfigHarness();
  beforeEach(() => cfg.write({ t3codeEnabled: true }));

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
  // gh-ludics-539: flag on so the t3code-adapter gate does not throw.
  const cfg = installT3codeConfigHarness();
  beforeEach(() => cfg.write({ t3codeEnabled: true }));

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
  // gh-ludics-539: flag on so the t3code-adapter gate does not throw.
  const cfg = installT3codeConfigHarness();
  beforeEach(() => cfg.write({ t3codeEnabled: true }));

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
      mag: { orchestration: { default_mode: "pair", default_coder: "claude-code", default_reviewer: "codex", model_classes: { codex: "gpt-5.5", "claude-opus": "claude-opus-4-8", "claude-sonnet": "claude-sonnet-4-6" } } },
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

describe("selectOrchestrationFlags — t3code integration gate (gh-ludics-539)", () => {
  const cfg = installT3codeConfigHarness();

  test("flag off + adapter t3code: throws T3codeIntegrationPausedError", () => {
    cfg.write({ t3codeEnabled: false, adapter: "t3code" });
    // Invariant: while paused, the function refuses a t3code adapter selection
    // rather than returning stale flags that would set up a broken t3code slot.
    let caught: unknown;
    try {
      selectOrchestrationFlags("medium");
    } catch (e) {
      caught = e;
    }
    expect(isT3codeIntegrationPausedError(caught)).toBe(true);
  });

  test("flag off + adapter t3code: selectOrchestrationFlagsForTask inherits the throw", () => {
    cfg.write({ t3codeEnabled: false, adapter: "t3code" });
    const content = "---\nid: test\ntitle: test\neffort: medium\n---\n";
    let caught: unknown;
    try {
      selectOrchestrationFlagsForTask(content, "medium");
    } catch (e) {
      caught = e;
    }
    expect(isT3codeIntegrationPausedError(caught)).toBe(true);
  });

  test("flag off + adapter tmux: does NOT throw (negative control — tmux orchestration unaffected)", () => {
    // Mutation evidence: the gate keys on the *resolved* adapter being t3code.
    // With globalAdapter() == tmux, the paused flag must not block tmux auto-fill.
    cfg.write({ t3codeEnabled: false, adapter: "tmux" });
    const result = selectOrchestrationFlags("medium");
    expect(result.adapter).toBe("tmux");
    expect(result.args).toContain("--pair");
  });

  test("flag on + adapter t3code: returns a normal selection", () => {
    cfg.write({ t3codeEnabled: true, adapter: "t3code" });
    const result = selectOrchestrationFlags("medium");
    expect(result.adapter).toBe("t3code");
    expect(result.args).toContain("--pair");
    expect(result.args).toContain("--plan");
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

// ---------------------------------------------------------------------------
// task-c48b7beb — latest-within-class default model resolution.
// ---------------------------------------------------------------------------

describe("resolveAgentModel — override precedence ladder (AC4)", () => {
  // Invariant: the unspecified-default tier (latest-within-class table) sits
  // BELOW every task-1fbd4edf override and ABOVE the provider's own default.
  // Each test sets up exactly the state that makes one tier win and asserts the
  // tiers below it do NOT leak through. The new (lowest) tier is the table.
  const TABLE = { codex: "gpt-5.5", "claude-opus": "claude-opus-4-8", "claude-sonnet": "claude-sonnet-4-6" };
  const bareCodex = { name: "reviewer", provider: "codex" as const, model: "", modelExplicit: false, role: "reviewer" as const };

  test("tier 1 — --reviewer-model flag wins over everything below", () => {
    const orchCfg = { reviewer_model: "cfg-rev", model_classes: TABLE };
    expect(resolveAgentModel(bareCodex, 1, orchCfg, undefined, "flag-rev")).toBe("flag-rev");
  });

  test("tier 2 — explicit token model wins over config + table", () => {
    const explicit = { ...bareCodex, model: "tok-model", modelExplicit: true };
    const orchCfg = { reviewer_model: "cfg-rev", model_classes: TABLE };
    expect(resolveAgentModel(explicit, 1, orchCfg, undefined, undefined)).toBe("tok-model");
  });

  test("tier 3 — reviewer_model config wins over the table", () => {
    const orchCfg = { reviewer_model: "cfg-rev", model_classes: TABLE };
    expect(resolveAgentModel(bareCodex, 1, orchCfg, undefined, undefined)).toBe("cfg-rev");
  });

  test("tier 4 — class table resolves the latest codex when nothing above is set", () => {
    // Harness: bare codex token, no flag, no reviewer_model — only the table.
    // Mutation: re-pinning DEFAULT_MODEL would make this a literal, not gpt-5.5.
    const orchCfg = { model_classes: TABLE };
    expect(resolveAgentModel(bareCodex, 1, orchCfg, undefined, undefined)).toBe("gpt-5.5");
  });

  test("class table picks the configured value, not a hardcoded string", () => {
    const orchCfg = { model_classes: { ...TABLE, codex: "gpt-9.9-custom" } };
    expect(resolveAgentModel(bareCodex, 1, orchCfg, undefined, undefined)).toBe("gpt-9.9-custom");
  });
});

describe("resolveAgentModel — runtime-path fails loudly when the class table is unset (AC3)", () => {
  // Runtime path (not the pure helper): resolveAgentModel is the function that
  // start() calls per agent BEFORE createWorktrees. Harness: a bare codex agent
  // with an orchCfg whose model_classes omits "codex" → the resolver throws,
  // so a misconfigured slot never silently runs a stale default.
  const bareCodex = { name: "reviewer", provider: "codex" as const, model: "", modelExplicit: false, role: "reviewer" as const };

  test("throws when model_classes is entirely absent", () => {
    expect(() => resolveAgentModel(bareCodex, 1, {}, undefined, undefined)).toThrow(
      /mag\.orchestration\.model_classes\.codex is required/,
    );
  });

  test("throws when the codex class is missing from the table", () => {
    const orchCfg = { model_classes: { "claude-opus": "claude-opus-4-8" } };
    expect(() => resolveAgentModel(bareCodex, 1, orchCfg, undefined, undefined)).toThrow(
      /mag\.orchestration\.model_classes\.codex is required/,
    );
  });

  test("classModel / providerDefaultModel throw on a missing class too", () => {
    expect(() => classModel("claude-opus", {})).toThrow(/model_classes\.claude-opus is required/);
    expect(() => providerDefaultModel("claude-code", {})).toThrow(/model_classes\.claude-sonnet is required/);
  });
});

describe("parseOrchestrationAdapterArgs — pair fallback tokens carry no baked version", () => {
  test("--pair with no --coder/--reviewer yields empty, non-explicit models", () => {
    // Mutation: re-introducing "coder:codex:gpt-5.4" sets a non-empty model and
    // flips these assertions; the empty model is what defers resolution to the
    // config table so role config overrides can still win (edge case 4).
    const parsed = parseOrchestrationAdapterArgs("--pair");
    expect(parsed.orchestration!.agents).toHaveLength(2);
    for (const agent of parsed.orchestration!.agents) {
      expect(agent.provider).toBe("codex");
      expect(agent.model).toBe("");
      expect(agent.modelExplicit).toBe(false);
    }
  });
});

describe("selectOrchestrationFlags — coder model suffix sourced from the config table (AC1)", () => {
  // gh-ludics-539 gate: flag on so the t3code-adapter selection does not throw.
  // The harness config carries model_classes, so the claude-code coder suffix
  // is the table value — not a hardcoded constant.
  const cfg = installT3codeConfigHarness();
  beforeEach(() => cfg.write({ t3codeEnabled: true }));

  test("medium effort claude-code coder emits the opus class suffix", () => {
    const { args } = selectOrchestrationFlags("medium");
    expect(args).toContain(":claude-opus-4-8");
  });

  test("tiny effort claude-code coder emits the sonnet class suffix", () => {
    const { args } = selectOrchestrationFlags("tiny");
    expect(args).toContain(":claude-sonnet-4-6");
  });

  test("a config override of model_classes.claude-opus flows into the medium suffix", () => {
    // Gate reads the real (harness) config; orchCfg reads the passed fakeConfig.
    const fakeConfig = {
      mag: { orchestration: { default_coder: "claude-code", default_reviewer: "codex", model_classes: { codex: "gpt-5.5", "claude-opus": "opus-test-override", "claude-sonnet": "claude-sonnet-4-6" } } },
    } as unknown as Parameters<typeof selectOrchestrationFlags>[1];
    const { args } = selectOrchestrationFlags("medium", fakeConfig);
    expect(args).toContain(":opus-test-override");
  });

  test("missing model_classes makes selection throw before any side effect", () => {
    const fakeConfig = {
      mag: { orchestration: { default_coder: "claude-code", default_reviewer: "codex" } },
    } as unknown as Parameters<typeof selectOrchestrationFlags>[1];
    expect(() => selectOrchestrationFlags("medium", fakeConfig)).toThrow(
      /mag\.orchestration\.model_classes\.claude-opus is required/,
    );
  });
});
