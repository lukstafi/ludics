import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AdapterContext } from "./types.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, persistState, type OrchestrationState } from "../orchestration/state.ts";

describe("tmux adapter — wrong-filename recovery flag pass-through", () => {
  // tmux-adapter.ts imports `parseOrchestrationAdapterArgs` from t3code
  // (`tmux-adapter.ts:37`) and threads the resulting orchestration.config
  // through `defaultOrchestrationConfig(orchestration.config)` at the start
  // path's persistState call (`tmux-adapter.ts:525`). This test locks in
  // that --no-auto-recover-wrong-filename actually arrives at the persisted
  // OrchestrationState.config without being overridden by the default.
  test("--no-auto-recover-wrong-filename round-trips through defaultOrchestrationConfig as false", async () => {
    const { parseOrchestrationAdapterArgs } = await import("./t3code.ts");
    const { defaultOrchestrationConfig } = await import("../orchestration/state.ts");
    const parsed = parseOrchestrationAdapterArgs("--pair --no-auto-recover-wrong-filename");
    expect(parsed.orchestration?.config.autoRecoverWrongFilename).toBe(false);
    // Mirrors the call at tmux-adapter.ts:525.
    const persisted = defaultOrchestrationConfig(parsed.orchestration!.config);
    expect(persisted.autoRecoverWrongFilename).toBe(false);
  });

  test("--auto-recover-wrong-filename round-trips as true", async () => {
    const { parseOrchestrationAdapterArgs } = await import("./t3code.ts");
    const { defaultOrchestrationConfig } = await import("../orchestration/state.ts");
    const parsed = parseOrchestrationAdapterArgs("--pair --auto-recover-wrong-filename");
    const persisted = defaultOrchestrationConfig(parsed.orchestration!.config);
    expect(persisted.autoRecoverWrongFilename).toBe(true);
  });

  test("default (no flag) → defaultOrchestrationConfig produces true", async () => {
    const { parseOrchestrationAdapterArgs } = await import("./t3code.ts");
    const { defaultOrchestrationConfig } = await import("../orchestration/state.ts");
    const parsed = parseOrchestrationAdapterArgs("--pair");
    const persisted = defaultOrchestrationConfig(parsed.orchestration!.config);
    expect(persisted.autoRecoverWrongFilename).toBe(true);
  });
});

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
    const state: OrchestrationState = {
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

describe("tmux adapter — missing orchestration error mentions --solo", () => {
  test("error text lists --solo reassignment as first option", async () => {
    const { start } = await import("./tmux-adapter.ts");
    const ctx: AdapterContext = {
      slot: 7,
      mode: "tmux",
      session: "",
      path: "/tmp/project",
      taskId: "task-x",
      adapterArgs: "", // no orchestration flags
      process: "(empty)",
      harnessDir: "/tmp/no-op-harness",
      stateRepoDir: "/tmp/state",
    };
    let thrown: Error | null = null;
    try {
      await start(ctx);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("tmux adapter requires orchestration flags");
    expect(thrown!.message).toContain("--solo --coder");
    expect(thrown!.message).toContain("--pair --coder");
  });
});

describe("writeTmuxSlotState atomic write", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-tmux-slot-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes state readable by readTmuxSlotState and leaves no .tmp", async () => {
    const { writeTmuxSlotState, readTmuxSlotState } = await import("./tmux-adapter.ts");
    const state = {
      slot: 4,
      adapter: "tmux",
      task: "task-xyz",
      started: "2026-04-24T00:00:00Z",
      mode: "solo",
      coder: { provider: "claude-code", model: "claude-opus-4-6" },
    } as unknown as Parameters<typeof writeTmuxSlotState>[0];
    writeTmuxSlotState(state, tmpDir);
    const round = readTmuxSlotState(4, tmpDir);
    expect(round).toEqual(state);
    const path = join(tmpDir, "orchestration", "tmux-slot-4.json");
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  test("auto-creates the orchestration directory", async () => {
    const { writeTmuxSlotState } = await import("./tmux-adapter.ts");
    const state = { slot: 9, adapter: "tmux" } as unknown as Parameters<typeof writeTmuxSlotState>[0];
    writeTmuxSlotState(state, tmpDir);
    expect(existsSync(join(tmpDir, "orchestration", "tmux-slot-9.json"))).toBe(true);
  });
});

// task-7476a03a — slot ttyd observability + flap-suppression. The next three
// describe blocks lock in (1) per-agent log path resolution, (2) bash-wrapper
// spawn argv shape, and (3) read-boundary preservation of the new optional
// ttydRestartCounts field.
describe("ttydLogPath — log location follows Mag's HOME/Library/Logs precedent", () => {
  let TMP = "";
  let savedHome: string | undefined;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-ttyd-log-"));
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("returns ~/Library/Logs/ludics-slot-{N}-{agent}-ttyd.log when HOME/Library/Logs exists", async () => {
    process.env.HOME = TMP;
    mkdirSync(join(TMP, "Library/Logs"), { recursive: true });
    const { ttydLogPath } = await import("./tmux-adapter.ts");
    expect(ttydLogPath(1, "coder")).toBe(join(TMP, "Library/Logs", "ludics-slot-1-coder-ttyd.log"));
    expect(ttydLogPath(6, "reviewer")).toBe(join(TMP, "Library/Logs", "ludics-slot-6-reviewer-ttyd.log"));
  });

  test("falls back to /tmp when HOME/Library/Logs is absent", async () => {
    process.env.HOME = TMP;
    // Do not create Library/Logs.
    const { ttydLogPath } = await import("./tmux-adapter.ts");
    expect(ttydLogPath(2, "coder")).toBe("/tmp/ludics-slot-2-coder-ttyd.log");
  });
});

describe("buildTtydSpawnArgs — bash wrapper appends to per-agent log file", () => {
  test("argv ends with bash -c containing exec ttyd and append-redirection to ttydLogPath", async () => {
    const mod = await import("./tmux-adapter.ts");
    const args = mod.buildTtydSpawnArgs(3, "coder", "coder", "task-7476a03a");
    // Last three argv entries are always: bash, -c, <command-string>
    expect(args[args.length - 3]).toBe("bash");
    expect(args[args.length - 2]).toBe("-c");
    const cmd = args[args.length - 1]!;
    // Must `exec` so proc.pid is ttyd's, not bash's. Append-redirection
    // (>>) preserves cause-of-death history across restarts.
    expect(cmd).toContain("exec ttyd");
    expect(cmd).toContain("--writable");
    const expectedLog = mod.ttydLogPath(3, "coder");
    expect(cmd).toContain(`>>'${expectedLog}'`);
    expect(cmd).toContain("2>&1");
    // The argv must still go through setsidWrap — either setsid prefix
    // (Linux) or perl POSIX::setsid fallback (macOS without setsid).
    const head = args[0]!;
    const usesSetsid = head.endsWith("/setsid") || head === "setsid";
    const usesPerl = head === "perl";
    expect(usesSetsid || usesPerl).toBe(true);
  });

  test("port and target derive from slot+role+taskId", async () => {
    const { buildTtydSpawnArgs } = await import("./tmux-adapter.ts");
    const cmd = buildTtydSpawnArgs(2, "reviewer", "reviewer", "task-abc")[
      buildTtydSpawnArgs(2, "reviewer", "reviewer", "task-abc").length - 1
    ]!;
    // Slot 2 reviewer port: 7681 + (2-1)*2 + 1 = 7684.
    expect(cmd).toContain("--port 7684");
    // Single-quoted target name.
    expect(cmd).toContain("-t 's2_reviewer_task-abc'");
  });

  test("HOME containing an apostrophe is escaped via '\\'' so the bash command stays parseable", async () => {
    const savedHome = process.env.HOME;
    const tmpRoot = mkdtempSync(join(tmpdir(), "ludics-quote-home-"));
    // Simulate /Users/O'Connor: a directory whose name actually contains '.
    const home = join(tmpRoot, "O'Connor");
    mkdirSync(join(home, "Library/Logs"), { recursive: true });
    process.env.HOME = home;
    try {
      // Re-import to re-resolve HOME (function reads process.env.HOME on each call).
      const mod = await import("./tmux-adapter.ts");
      const args = mod.buildTtydSpawnArgs(1, "coder", "coder", "task-xyz");
      const cmd = args[args.length - 1]!;
      // Invariant: the literal apostrophe in HOME must be encoded as the
      // POSIX close-reopen sequence '\''. A naive single-quote interpolation
      // would emit `'/.../O'Connor/.../...-ttyd.log'` — bash would parse
      // that as: <single-quoted "/.../O">, <Connor/.../...>, <single-quoted
      // ".log">, which has unbalanced state and command parsing fails or
      // misroutes redirection. Mutation: dropping the .replace() call here
      // makes this assertion fail.
      expect(cmd).toContain(`O'\\''Connor`);
      // Sanity: the escaped path is still the redirection target.
      expect(cmd).toMatch(/>>'.*O'\\''Connor.*ludics-slot-1-coder-ttyd\.log'/);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("readTmuxSlotState read-boundary preserves sparse ttydRestartCounts", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-ttyd-readboundary-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("legacy on-disk JSON without ttydRestartCounts reads back as undefined (no {} backfill)", async () => {
    const { readTmuxSlotState } = await import("./tmux-adapter.ts");
    const orchDir = join(tmpDir, "orchestration");
    mkdirSync(orchDir, { recursive: true });
    // Hand-write a legacy state — explicitly OMITs ttydRestartCounts.
    writeFileSync(
      join(orchDir, "tmux-slot-1.json"),
      JSON.stringify({ slot: 1, ttydPids: {} }),
    );
    const state = readTmuxSlotState(1, tmpDir);
    expect(state).not.toBeNull();
    // Invariant: read boundary keeps the field sparse — undefined, not {}.
    // Mutation: replacing the read with `parsed.ttydRestartCounts ??= {}` makes this fail.
    expect(state!.ttydRestartCounts).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(state, "ttydRestartCounts")).toBe(false);
  });

  test("ttydRestartCounts round-trips byte-faithfully when present (includes lastRestartAt)", async () => {
    const { readTmuxSlotState, writeTmuxSlotState } = await import("./tmux-adapter.ts");
    const fixture = {
      slot: 4,
      ttydPids: { coder: 1234 },
      ttydRestartCounts: {
        coder: { count: 3, firstRestartAt: 1700000000, lastRestartAt: 1700000060 },
        reviewer: {
          count: 10,
          firstRestartAt: 1700000100,
          lastRestartAt: 1700000400,
          backoffUntil: Number.MAX_SAFE_INTEGER,
        },
      },
    } as unknown as Parameters<typeof writeTmuxSlotState>[0];
    writeTmuxSlotState(fixture, tmpDir);
    const round = readTmuxSlotState(4, tmpDir);
    expect(round).toEqual(fixture);
    // Sentinel value AND new lastRestartAt field both survive JSON round-trip.
    expect(round!.ttydRestartCounts!.reviewer!.backoffUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect(round!.ttydRestartCounts!.coder!.lastRestartAt).toBe(1700000060);
    expect(round!.ttydRestartCounts!.reviewer!.lastRestartAt).toBe(1700000400);
  });

  test("legacy record without lastRestartAt round-trips with the field undefined", async () => {
    const { readTmuxSlotState, writeTmuxSlotState } = await import("./tmux-adapter.ts");
    const legacy = {
      slot: 5,
      ttydPids: {},
      ttydRestartCounts: {
        // Pre-fix shape — explicitly OMITs lastRestartAt.
        coder: { count: 1, firstRestartAt: 1700000000 },
      },
    } as unknown as Parameters<typeof writeTmuxSlotState>[0];
    writeTmuxSlotState(legacy, tmpDir);
    const round = readTmuxSlotState(5, tmpDir);
    expect(round!.ttydRestartCounts!.coder!.count).toBe(1);
    expect(round!.ttydRestartCounts!.coder!.firstRestartAt).toBe(1700000000);
    // Invariant: legacy field stays undefined on read; the runner falls
    // back to firstRestartAt only when this field is absent.
    expect(round!.ttydRestartCounts!.coder!.lastRestartAt).toBeUndefined();
  });
});
