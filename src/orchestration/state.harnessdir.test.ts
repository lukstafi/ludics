import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultOrchestrationConfig,
  initAgentRuntimeState,
  migrateState,
  persistState,
  readOrchestrationState,
  type AgentTurnLifecycle,
  type OrchestrationState,
} from "./state.ts";

const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let REAL = "";
let DECOY = "";

function baseState(slot: number, harnessDir?: string): OrchestrationState {
  return {
    slot,
    taskId: "task-hdtest",
    mode: "pair",
    phase: "setup",
    round: 1,
    mergeRound: 0,
    agents: [],
    agentStates: {},
    config: defaultOrchestrationConfig(),
    phaseStartedAt: 0,
    startedAt: new Date().toISOString(),
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/root",
    peerSyncDir: "/tmp/peer-sync",
    threadIds: {},
    backend: "tmux",
    ...(harnessDir !== undefined ? { harnessDir } : {}),
  };
}

beforeEach(() => {
  REAL = mkdtempSync(join(tmpdir(), "ludics-state-real-"));
  DECOY = mkdtempSync(join(tmpdir(), "ludics-state-decoy-"));
  mkdirSync(join(REAL, "orchestration"), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = DECOY;
});

afterEach(() => {
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(REAL, { recursive: true, force: true });
  rmSync(DECOY, { recursive: true, force: true });
});

describe("OrchestrationState.harnessDir", () => {
  test("round-trip persistence: persistState + readOrchestrationState preserves harnessDir field", () => {
    const state = baseState(1, REAL);
    persistState(state, REAL);
    const loaded = readOrchestrationState(1, REAL);
    expect(loaded).not.toBeNull();
    expect(loaded!.harnessDir).toBe(REAL);
  });

  test("legacy state (no harnessDir field) is backfilled from the readOrchestrationState arg", () => {
    // Simulate a state file persisted before the field was introduced — write the JSON
    // directly with the field omitted.
    const legacy = baseState(2);
    delete (legacy as Partial<OrchestrationState>).harnessDir;
    expect((legacy as Partial<OrchestrationState>).harnessDir).toBeUndefined();

    const path = join(REAL, "orchestration", "slot-2.json");
    writeFileSync(path, JSON.stringify(legacy, null, 2));

    const loaded = readOrchestrationState(2, REAL);
    expect(loaded).not.toBeNull();
    // Backfilled to the caller-supplied harness, NOT the decoy (LUDICS_HARNESS_DIR).
    expect(loaded!.harnessDir).toBe(REAL);
    expect(loaded!.harnessDir).not.toBe(DECOY);
  });

  test("backfill uses `??=` — an existing non-empty harnessDir wins over the arg", () => {
    // If the state was persisted with harnessDir already set, the arg must not overwrite
    // (otherwise the caller's re-parametrization would silently clobber committed intent).
    const state = baseState(3, "/already/set");
    const path = join(REAL, "orchestration", "slot-3.json");
    writeFileSync(path, JSON.stringify(state, null, 2));

    const loaded = readOrchestrationState(3, REAL);
    expect(loaded).not.toBeNull();
    expect(loaded!.harnessDir).toBe("/already/set");
  });

  // task-f60547cd PR #399 P1: runner.ts now invokes
  // `persistState(state, state.harnessDir ?? defaultHarnessDir())` at every
  // in-body site (previously bare `persistState(state)`), so orchestration
  // snapshots land in the caller-selected harness instead of the process
  // global when runOrchestrationForSlot(slot, harnessDir) is invoked with
  // a harness that differs from LUDICS_HARNESS_DIR. This test exercises
  // the exact pattern runner.ts now uses.
  test("persistState(state, state.harnessDir ?? defaultHarnessDir()) writes to state.harnessDir, not LUDICS_HARNESS_DIR", () => {
    mkdirSync(join(REAL, "orchestration"), { recursive: true });
    mkdirSync(join(DECOY, "orchestration"), { recursive: true });

    const state = baseState(4, REAL); // state.harnessDir = REAL; env points at DECOY

    // Exact pattern used throughout runner.ts (line 876, 1429, 1448, …, 1855, …).
    persistState(state, state.harnessDir ?? DECOY);

    // Snapshot lands in REAL harness only.
    const realPath = join(REAL, "orchestration", "slot-4.json");
    const decoyPath = join(DECOY, "orchestration", "slot-4.json");
    expect(existsSync(realPath)).toBe(true);
    expect(existsSync(decoyPath)).toBe(false);
  });

  test("persistState with a literal state (no harnessDir set) falls through to the global — runner seeds it at top of runOrchestration to avoid this", () => {
    // Regression anchor: without the top-of-runOrchestration seed
    // (runner.ts:1854 `state.harnessDir ??= defaultHarnessDir()`), a
    // literal state with no harnessDir would coerce to the env-var global
    // in this ??-fallback pattern. The seed is what guarantees the
    // in-body persistState calls never silently default to the global
    // once runOrchestration has been entered.
    mkdirSync(join(DECOY, "orchestration"), { recursive: true });

    const state = baseState(5); // no harnessDir
    expect(state.harnessDir).toBeUndefined();

    persistState(state, state.harnessDir ?? DECOY);

    // Fallback writes to DECOY (defaultHarnessDir() target) — this is the
    // behaviour the top-of-runOrchestration seed prevents for real runs.
    expect(existsSync(join(DECOY, "orchestration", "slot-5.json"))).toBe(true);
  });
});

// gh-ludics-411 AC 3 read-boundary regression: writing a corrupted slot
// state file to disk and asserting readOrchestrationState() applies the
// per-field policy (throw / coerce / drop). This proves the validator
// is wired through the read path, not just the migrateState() helper —
// the helper-level cases live in phases.test.ts.
describe("readOrchestrationState — boundary validators (gh-ludics-411 AC 3)", () => {
  function writeSlot(slot: number, mutate: (s: OrchestrationState) => void): void {
    const state = baseState(slot, REAL);
    state.agents = [
      { name: "coder", provider: "claude-code", role: "coder", model: "claude-sonnet-4-6", branch: "a", worktreePath: "/tmp/a" },
    ];
    state.agentStates = initAgentRuntimeState(["coder"]);
    mutate(state);
    const path = join(REAL, "orchestration", `slot-${slot}.json`);
    writeFileSync(path, JSON.stringify(state, null, 2));
  }

  function lifecycle(overrides: Partial<AgentTurnLifecycle> = {}): AgentTurnLifecycle {
    return {
      dispatchCommandId: "c1",
      dispatchedAt: "2026-04-22T00:00:00Z",
      phaseToken: "p1",
      observedTurnId: null,
      state: "settled",
      turnStartedAt: null,
      turnCompletedAt: null,
      completionSource: null,
      statusFileFingerprint: null,
      lastStopHookAt: null,
      ...overrides,
    };
  }

  test("throws when slot JSON has corrupt mode (\"throw\" policy at read boundary)", () => {
    writeSlot(7, (s) => { (s as { mode: string }).mode = "weird"; });
    expect(() => readOrchestrationState(7, REAL)).toThrow(/mode.*weird/);
  });

  // --- Pilot mode migration triple (state-migration convention) ---

  // (1) Positive backfill: mode "pilot" is a legal value and survives the
  // read-boundary / migrateState validator unchanged (no coercion, no throw).
  test("accepts mode \"pilot\" through readOrchestrationState (positive)", () => {
    writeSlot(20, (s) => { (s as { mode: string }).mode = "pilot"; });
    let calls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { calls.push(args); });
    try {
      const loaded = readOrchestrationState(20, REAL);
      calls = [...spy.mock.calls];
      expect(loaded).not.toBeNull();
      expect(loaded!.mode).toBe("pilot");
      const modeLogs = calls.filter((c) => String(c[0] ?? "").includes("OrchestrationState.mode"));
      expect(modeLogs).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  // (2) Negative control: an out-of-union mode value still triggers the
  // "throw" policy even with pilot now in the allowlist.
  test("still throws on a non-pilot invalid mode (negative control)", () => {
    writeSlot(21, (s) => { (s as { mode: string }).mode = "copilot"; });
    expect(() => readOrchestrationState(21, REAL)).toThrow(/mode.*copilot/);
  });

  // (3) JSON round-trip: a pilot state serializes and deserializes through
  // migrateState with mode preserved.
  test("pilot state survives a JSON round-trip through migrateState", () => {
    const state = baseState(22, REAL);
    state.mode = "pilot";
    state.agents = [
      { name: "coder", provider: "claude-code", role: "coder", model: "claude-sonnet-4-6", branch: "a", worktreePath: "/tmp/a" },
    ];
    state.agentStates = initAgentRuntimeState(["coder"]);
    const reparsed = JSON.parse(JSON.stringify(state)) as OrchestrationState;
    const migrated = migrateState(reparsed, 22);
    expect(migrated.mode).toBe("pilot");
  });

  test("coerces invalid backend to globalAdapter() and logs once at read boundary", async () => {
    const { globalAdapter } = await import("../config.ts");
    const expectedFallback = globalAdapter();
    writeSlot(8, (s) => { (s as { backend: string }).backend = "junk"; });
    let calls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { calls.push(args); });
    try {
      const loaded = readOrchestrationState(8, REAL);
      calls = [...spy.mock.calls];
      expect(loaded).not.toBeNull();
      expect(loaded!.backend).toBe(expectedFallback);
      const backendLogs = calls.filter((c) => String(c[0] ?? "").includes("backend"));
      expect(backendLogs.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("drops invalid agents[].role at read boundary (\"drop\" policy)", () => {
    writeSlot(9, (s) => { (s.agents[0] as { role?: string }).role = "narrator"; });
    const loaded = readOrchestrationState(9, REAL);
    expect(loaded).not.toBeNull();
    expect(loaded!.agents[0].role).toBeUndefined();
  });

  test("coerces invalid turnLifecycle.state and PRESERVES sentinel-null completionSource without logging", () => {
    writeSlot(10, (s) => {
      s.agentStates.coder.turnLifecycle = lifecycle({
        state: "galaxy-brain" as "settled",
        completionSource: null,
      });
    });
    let calls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { calls.push(args); });
    try {
      const loaded = readOrchestrationState(10, REAL);
      calls = [...spy.mock.calls];
      expect(loaded).not.toBeNull();
      const lc = loaded!.agentStates.coder.turnLifecycle;
      expect(lc?.state).toBe("error");
      expect(lc?.completionSource).toBeNull();
      // turnLifecycle.state coerced once; completionSource:null fast-path = no log.
      const stateLogs = calls.filter((c) => String(c[0] ?? "").includes("turnLifecycle.state"));
      const csLogs = calls.filter((c) => String(c[0] ?? "").includes("completionSource"));
      expect(stateLogs.length).toBe(1);
      expect(csLogs).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  // Positive control: a fully-valid slot state file flows through the read
  // boundary without any validator-driven console.error or mutation.
  // Required by the AC self-check format (positive-control sibling fixture).
  test("happy path: legal slot JSON round-trips silently through readOrchestrationState", () => {
    writeSlot(11, (s) => {
      s.backend = "tmux";
      s.agentStates.coder.turnLifecycle = lifecycle({
        state: "running",
        completionSource: "snapshot",
      });
    });
    let calls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { calls.push(args); });
    try {
      const loaded = readOrchestrationState(11, REAL);
      calls = [...spy.mock.calls];
      expect(loaded).not.toBeNull();
      expect(loaded!.mode).toBe("pair");
      expect(loaded!.backend).toBe("tmux");
      expect(loaded!.agents[0].role).toBe("coder");
      expect(loaded!.agentStates.coder.turnLifecycle?.state).toBe("running");
      expect(loaded!.agentStates.coder.turnLifecycle?.completionSource).toBe("snapshot");
      const validatorLogs = calls.filter((c) => {
        const msg = String(c[0] ?? "");
        return msg.includes("OrchestrationState.") || msg.includes("invalid");
      });
      expect(validatorLogs).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
