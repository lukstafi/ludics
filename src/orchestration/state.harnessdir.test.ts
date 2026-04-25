import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultOrchestrationConfig,
  persistState,
  readOrchestrationState,
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
