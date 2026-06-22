import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
    // Dual-stack bind: `-6` must sit between `ttyd` and `--port` so ttyd serves
    // both A and AAAA for the advertised MagicDNS host. Mutation: dropping `-6`
    // fails this assertion (IPv6-preferring clients would hit a dead family).
    expect(cmd).toContain("--writable -6 --port");
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

describe("ttydMatchesSession — exact session-identity match (task-1373e911)", () => {
  // The matcher reads the live ttyd argv via `ps -p <pid> -o command=`
  // (safeSyncOutput) and must match the EXACT `--port`/`-t` tokens, not a
  // substring. We spy safeSyncOutput on the spawn module so no real `ps` runs.
  let spawnMod: typeof import("../spawn.ts");
  let psSpy: ReturnType<typeof spyOn>;

  function mockPs(line: string): void {
    psSpy = spyOn(spawnMod, "safeSyncOutput").mockImplementation(
      () => ({ ok: line !== "", exitCode: line === "" ? 1 : 0, stdout: line, stderr: "", timedOut: false }),
    );
  }

  afterEach(() => {
    psSpy.mockRestore();
  });

  test("alive ttyd attached to the expected slot/agent target → true", async () => {
    spawnMod = await import("../spawn.ts");
    const { ttydMatchesSession } = await import("./tmux-adapter.ts");
    // Slot 1 coder port = 7681, target = s1_coder_task-abc.
    mockPs("ttyd --writable -6 --port 7681 tmux attach -t s1_coder_task-abc");
    expect(ttydMatchesSession(4321, 1, "coder", "coder", "task-abc")).toBe(true);
  });

  test("alive ttyd attached to a DIFFERENT target → false", async () => {
    spawnMod = await import("../spawn.ts");
    const { ttydMatchesSession } = await import("./tmux-adapter.ts");
    mockPs("ttyd --writable -6 --port 7681 tmux attach -t s1_coder_task-other");
    expect(ttydMatchesSession(4321, 1, "coder", "coder", "task-abc")).toBe(false);
  });

  test("empty/failed ps output → true (safe default, never churn on transient ps failure)", async () => {
    spawnMod = await import("../spawn.ts");
    const { ttydMatchesSession } = await import("./tmux-adapter.ts");
    mockPs("");
    expect(ttydMatchesSession(4321, 1, "coder", "coder", "task-abc")).toBe(true);
  });

  test("prefix target is REJECTED: expected s1_coder_task-abc vs actual s1_coder_task-abcdef → false", async () => {
    spawnMod = await import("../spawn.ts");
    const { ttydMatchesSession } = await import("./tmux-adapter.ts");
    // Invariant: exact adjacent-token equality on `-t <target>`. Mutation:
    // reverting the matcher to `cmd.includes(target)` makes this WRONGLY return
    // true — a wrong-session ttyd would be treated as healthy and never
    // restarted, defeating the optional wrong-session hardening (AC5).
    mockPs("ttyd --writable -6 --port 7681 tmux attach -t s1_coder_task-abcdef");
    expect(ttydMatchesSession(4321, 1, "coder", "coder", "task-abc")).toBe(false);
  });

  test("prefix port is REJECTED: expected --port 7681 vs actual --port 76810 → false", async () => {
    spawnMod = await import("../spawn.ts");
    const { ttydMatchesSession } = await import("./tmux-adapter.ts");
    // Token equality also guards the port (substring `includes("7681")` would
    // match "76810"). Target matches; only the port differs.
    mockPs("ttyd --writable -6 --port 76810 tmux attach -t s1_coder_task-abc");
    expect(ttydMatchesSession(4321, 1, "coder", "coder", "task-abc")).toBe(false);
  });

  test("target with WHITESPACE (custom agent name) still matches its own session → true", async () => {
    spawnMod = await import("../spawn.ts");
    const { ttydMatchesSession, tmuxTarget } = await import("./tmux-adapter.ts");
    // slotSessionName does not sanitize the agent name, so a quoted custom
    // agent name with a space yields a target with a space. `ps -o command=`
    // flattens argv with spaces, so the OLD whitespace-split matcher truncated
    // the target to its first word ("s1_my") and spuriously failed — restarting
    // a HEALTHY ttyd on every tick (flap). Codex P2. The target is the final
    // argv element, so we compare the slice after the last ` -t ` exactly.
    const target = tmuxTarget(1, "my agent", "task-abc"); // -> "s1_my agent_task-abc"
    expect(target).toContain(" "); // sanity: the harness condition (a space) holds
    mockPs(`ttyd --writable -6 --port 7681 tmux attach -t ${target}`);
    expect(ttydMatchesSession(4321, 1, "coder", "my agent", "task-abc")).toBe(true);
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

// ---------------------------------------------------------------------------
// Scope (3a) cold-start CWD invariant — tmux backend.
// (`proposal-commit-on-main-and-worktree-resume`.)
//
// Pins that an agent launched at cold-start has its tmux session born
// inside the agent's per-agent worktree path returned from
// `createWorktrees`. The load-bearing chain in `setupOrchestratedSlot` is
//   for each agent:
//     createTmuxAgentSession(slot, agent.name, agent.worktreePath, taskId)
//       → tmuxNewSession(name, cwd)
// — and the per-agent loop now lives in the named helper
// `startTmuxAgentSessionsForOrchestratedSlot` so the test exercises the
// same body `setupOrchestratedSlot` calls. A real `createWorktrees(..., "duo")`
// produces distinct duo paths; the spy on `tmuxNewSession` sees those exact
// paths per agent. A mutation in the helper that swaps `agent.worktreePath`
// for `peerSyncDir` (or any other slot-shared path) flips the test
// PASS→FAIL — verified locally.
//
// Subsequent-turn CWD is not asserted: `TmuxTransport.sendTurn` injects
// prompts without `cd`, so the cold-start CWD is preserved by construction.
// ---------------------------------------------------------------------------

import { createWorktrees, cleanupWorktrees } from "../orchestration/worktrees.ts";
import type { AgentConfig } from "../orchestration/state.ts";

const TMUX_TMP = join(import.meta.dir, ".test-tmp-tmux-cwd");

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  writeFileSync(join(repo, "README.md"), "init\n");
  Bun.spawnSync(["git", "add", "README.md"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
}

describe("tmux adapter cold-start CWD", () => {
  test("setupOrchestratedSlot per-agent loop sees distinct duo worktree paths from createWorktrees as tmuxNewSession cwd", async () => {
    if (!Bun.which("git")) return;
    const tmuxMod = await import("./tmux.ts");
    const { spyOn } = await import("bun:test");

    // Driving the same helper `setupOrchestratedSlot` calls (rather than
    // a hand-built agent fixture) guarantees that any future refactor of
    // the per-agent loop is also exercised by this test.
    const { startTmuxAgentSessionsForOrchestratedSlot } = await import("./tmux-adapter.ts");

    rmSync(TMUX_TMP, { recursive: true, force: true });
    mkdirSync(TMUX_TMP, { recursive: true });
    const repo = join(TMUX_TMP, "repo-cwd");
    initRepo(repo);

    // Real createWorktrees with mode "duo" — produces two distinct
    // per-agent worktree paths and registers the branches with git.
    const setup = createWorktrees(
      repo,
      "task-coldstart",
      [{ name: "coder" }, { name: "reviewer" }],
      "main",
      9,
      "duo",
    );
    expect(setup.agentWorktrees.coder).not.toBe(setup.agentWorktrees.reviewer);
    expect(setup.agentWorktrees.coder).not.toBe(setup.peerSyncDir);
    expect(setup.agentWorktrees.reviewer).not.toBe(setup.peerSyncDir);

    // Spy on the inner tmux primitives BEFORE the helper runs.
    const captured: Array<{ name: string; cwd: string | undefined }> = [];
    const newSessionSpy = spyOn(tmuxMod, "tmuxNewSession").mockImplementation((name: string, cwd?: string) => {
      captured.push({ name, cwd });
    });
    const hasSessionSpy = spyOn(tmuxMod, "tmuxHasSession").mockReturnValue(false);
    // bootAgentCli routes through tmuxSendCommand; mock so it doesn't
    // shell out to a tmux that may not be installed.
    const sendCommandSpy = spyOn(tmuxMod, "tmuxSendCommand").mockImplementation(() => true);
    // Avoid the post-create `tmux set-option ... mouse off` shelling out.
    const safeSpawnMod = await import("../spawn.ts");
    const safeSpy = spyOn(safeSpawnMod, "safeSyncOutput").mockReturnValue({
      ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false,
    });

    try {
      // Mirror the AgentConfig shape `setupOrchestratedSlot` constructs
      // at tmux-adapter.ts: each agent's worktreePath is sourced from
      // setup.agentWorktrees[agent.name] returned by createWorktrees.
      const agents: AgentConfig[] = [
        {
          name: "coder",
          provider: "claude-code",
          role: "coder",
          model: "claude-sonnet-4-6",
          branch: setup.branches.coder!,
          worktreePath: setup.agentWorktrees.coder!,
        },
        {
          name: "reviewer",
          provider: "codex",
          role: "reviewer",
          model: "gpt-5.4",
          branch: setup.branches.reviewer!,
          worktreePath: setup.agentWorktrees.reviewer!,
        },
      ];

      // Drive the exact helper that `setupOrchestratedSlot` invokes per
      // round (`tmux-adapter.ts:594-597`). startTtyd is disabled so the
      // test does not depend on a real ttyd binary; the AC scope is the
      // tmux session's CWD, not ttyd lifecycle.
      startTmuxAgentSessionsForOrchestratedSlot(
        9, agents, setup.peerSyncDir, "task-coldstart", false,
      );

      // Per-agent invariant: each tmuxNewSession call's cwd argument is
      // the agent's distinct per-agent worktree path returned from
      // createWorktrees — NOT the slot-shared peerSyncDir or the project
      // dir. Mutation: replacing `agent.worktreePath` with
      // `peerSyncDir` (or `setup.rootWorktree`, or `repo`) in the loop
      // body collapses both calls onto a single path, which fails the
      // distinct-paths assertion below.
      expect(captured).toHaveLength(2);
      const byAgent = new Map(captured.map((c) => [c.name, c.cwd]));
      // Distinct: each per-agent session's cwd matches that agent's
      // worktree, not aliased to a shared path.
      const coderSessionName = captured[0]!.name;
      const reviewerSessionName = captured[1]!.name;
      expect(byAgent.get(coderSessionName)).toBe(setup.agentWorktrees.coder!);
      expect(byAgent.get(reviewerSessionName)).toBe(setup.agentWorktrees.reviewer!);
      expect(byAgent.get(coderSessionName)).not.toBe(byAgent.get(reviewerSessionName));
      // Defensive: neither cwd is the shared peerSyncDir / projectDir —
      // pins the negative case the reviewer's mutation aimed at.
      expect(byAgent.get(coderSessionName)).not.toBe(setup.peerSyncDir);
      expect(byAgent.get(coderSessionName)).not.toBe(repo);
      expect(byAgent.get(reviewerSessionName)).not.toBe(setup.peerSyncDir);
      expect(byAgent.get(reviewerSessionName)).not.toBe(repo);
    } finally {
      newSessionSpy.mockRestore();
      hasSessionSpy.mockRestore();
      sendCommandSpy.mockRestore();
      safeSpy.mockRestore();
      cleanupWorktrees(repo, "task-coldstart", [{ name: "coder" }, { name: "reviewer" }], 9, "duo");
      rmSync(TMUX_TMP, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// task-c48b7beb — tmux resolveAgentModel resolves the latest-within-class
// default via the shared providerDefaultModel, with the same override
// precedence and the same loud failure as the t3code adapter.
// ---------------------------------------------------------------------------
describe("tmux resolveAgentModel — latest-within-class default", () => {
  const TABLE = { codex: "gpt-5.5", "claude-opus": "claude-opus-4-8", "claude-sonnet": "claude-sonnet-4-6" };
  const bareCodex = { name: "reviewer", provider: "codex", model: "", modelExplicit: false, role: "reviewer" as const };

  test("bare codex agent with no overrides resolves to the table's codex value", async () => {
    const { resolveAgentModel } = await import("./tmux-adapter.ts");
    // Harness: no flag override, no reviewer_model config — only the table.
    // Mutation: dropping the providerDefaultModel tier returns "" instead.
    expect(resolveAgentModel(bareCodex, 1, { model_classes: TABLE }, undefined, undefined)).toBe("gpt-5.5");
  });

  test("non-blank reviewer_model config still wins over the class default", async () => {
    const { resolveAgentModel } = await import("./tmux-adapter.ts");
    expect(
      resolveAgentModel(bareCodex, 1, { reviewer_model: "cfg-rev", model_classes: TABLE }, undefined, undefined),
    ).toBe("cfg-rev");
  });

  test("throws loudly when the resolved class is absent from the table", async () => {
    const { resolveAgentModel } = await import("./tmux-adapter.ts");
    expect(() => resolveAgentModel(bareCodex, 1, { model_classes: {} }, undefined, undefined)).toThrow(
      /mag\.orchestration\.model_classes\.codex is required/,
    );
  });
});

describe("agentCliCommand — passes --model + Fable remediation (task-13dee93b AC5/8/9)", () => {
  test("claude-code agent passes the resolved model via --model, no remediation for non-Fable", async () => {
    const { agentCliCommand } = await import("./tmux-adapter.ts");
    const cmd = agentCliCommand({ provider: "claude-code", model: "claude-opus-4-8", role: "coder", thinkingEffort: "high" });
    expect(cmd).toContain("--model claude-opus-4-8");
    expect(cmd).toContain("--effort"); // effort still mapped
    // Mutation guard: a non-Fable model carries NO remediation wrapper.
    expect(cmd).not.toContain("claude-fable unavailable");
    expect(cmd).not.toContain("||");
  });

  test("a claude-fable coder appends the nonzero-exit remediation naming coder_class + claude-opus", async () => {
    const { agentCliCommand } = await import("./tmux-adapter.ts");
    const cmd = agentCliCommand({ provider: "claude-code", model: "claude-fable-5", role: "coder" });
    expect(cmd).toContain("--model claude-fable-5");
    expect(cmd).toContain("claude-fable unavailable");
    expect(cmd).toContain("coder_class");
    expect(cmd).toContain("claude-opus");
  });

  test("a claude-fable reviewer names reviewer_class, not coder_class", async () => {
    const { agentCliCommand } = await import("./tmux-adapter.ts");
    const cmd = agentCliCommand({ provider: "claude-code", model: "claude-fable-5", role: "reviewer" });
    expect(cmd).toContain("reviewer_class");
    expect(cmd).not.toContain("coder_class");
  });

  // Codex PR review (P2): the remediation must follow a config-bumped Fable id,
  // not the hardcoded claude-fable-5. Resolve the class from orchCfg.model_classes.
  test("a config-bumped Fable model id still triggers the remediation (via orchCfg)", async () => {
    const { agentCliCommand } = await import("./tmux-adapter.ts");
    const orchCfg = { model_classes: { "claude-fable": "claude-fable-6-future" } };
    const cmd = agentCliCommand(
      { provider: "claude-code", model: "claude-fable-6-future", role: "coder" },
      orchCfg,
    );
    expect(cmd).toContain("--model claude-fable-6-future");
    expect(cmd).toContain("claude-fable unavailable");
    expect(cmd).toContain("coder_class");
  });

  test("a non-Fable model with the same orchCfg gets NO remediation (mutation guard)", async () => {
    const { agentCliCommand } = await import("./tmux-adapter.ts");
    const orchCfg = { model_classes: { "claude-fable": "claude-fable-6-future" } };
    const cmd = agentCliCommand(
      { provider: "claude-code", model: "claude-opus-4-8", role: "coder" },
      orchCfg,
    );
    expect(cmd).toContain("--model claude-opus-4-8");
    expect(cmd).not.toContain("claude-fable unavailable");
  });

  test("no --model is emitted when model is absent", async () => {
    const { agentCliCommand } = await import("./tmux-adapter.ts");
    expect(agentCliCommand({ provider: "claude-code" })).not.toContain("--model");
  });

  test("codex agent is unaffected (no --model, no remediation)", async () => {
    const { agentCliCommand } = await import("./tmux-adapter.ts");
    const cmd = agentCliCommand({ provider: "codex", model: "gpt-5.5", thinkingEffort: "high" });
    expect(cmd).toContain("codex --yolo");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("claude-fable unavailable");
  });
});

// gh-ludics-580 AC5 + AC9: per-slot tmux state must move to a non-harness
// worker cache on a federation worker, while controller/standalone keeps using
// the git-tracked harness tree (harnessDir/orchestration/tmux-slot-N.json).
describe("readTmuxSlotState/writeTmuxSlotState/removeTmuxSlotState — worker-cache migration", () => {
  let TMP: string;
  let harness: string;
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;

  function writeClusterConfig(homeDir: string): string {
    const cfg = join(homeDir, "config.yaml");
    writeFileSync(cfg, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: leader-box
      host: leader-box.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: minipc-wsl
      host: minipc-wsl.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);
    return cfg;
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "tmux-worker-cache-"));
    process.env.HOME = TMP;
    harness = join(TMP, "harness");
    mkdirSync(harness, { recursive: true });
    process.env.LUDICS_CONFIG = writeClusterConfig(TMP);
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("worker: write/read round-trip via $HOME/.ludics-orch-cache/tmux, harness untouched", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // → worker context
    const { readTmuxSlotState, writeTmuxSlotState, removeTmuxSlotState } = await import("./tmux-adapter.ts");
    const state = {
      slot: 4,
      ttydPids: { coder: 4242 },
      orchestration: { stateFile: join(harness, "orchestration", "slot-4.json"), mode: "pair", pid: 9999 },
    } as unknown as Parameters<typeof writeTmuxSlotState>[0];
    writeTmuxSlotState(state, harness);

    const round = readTmuxSlotState(4, harness);
    expect(round).not.toBeNull();
    expect(round!.slot).toBe(4);
    expect(round!.ttydPids.coder).toBe(4242);
    expect(round!.orchestration?.pid).toBe(9999);

    const cachePath = join(TMP, ".ludics-orch-cache", "tmux", "slot-4.json");
    expect(existsSync(cachePath)).toBe(true);
    expect(existsSync(join(harness, "orchestration", "tmux-slot-4.json"))).toBe(false);

    removeTmuxSlotState(4, harness);
    expect(existsSync(cachePath)).toBe(false);
    expect(readTmuxSlotState(4, harness)).toBeNull();
  });

  test("controller: write/read uses harness tree, cache untouched, no leftover .tmp", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "leader-box"; // role leader → controller
    const { readTmuxSlotState, writeTmuxSlotState, removeTmuxSlotState } = await import("./tmux-adapter.ts");
    const state = { slot: 2, ttydPids: { coder: 1 } } as unknown as Parameters<typeof writeTmuxSlotState>[0];
    writeTmuxSlotState(state, harness);

    const harnessPath = join(harness, "orchestration", "tmux-slot-2.json");
    expect(existsSync(harnessPath)).toBe(true);
    expect(existsSync(`${harnessPath}.tmp`)).toBe(false);
    expect(existsSync(join(TMP, ".ludics-orch-cache", "tmux", "slot-2.json"))).toBe(false);
    expect(readTmuxSlotState(2, harness)?.ttydPids.coder).toBe(1);

    removeTmuxSlotState(2, harness);
    expect(existsSync(harnessPath)).toBe(false);
  });
});
