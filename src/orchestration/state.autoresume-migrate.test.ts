// gh-ludics-584: migration triple for the resume circuit-breaker field
// `OrchestrationState.autoResumeNoProgress` — positive backfill (legacy state
// without the field loads clean), negative-control coercion/drop of corrupt
// persisted values, and a JSON round-trip fidelity check.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultOrchestrationConfig,
  migrateState,
  type OrchestrationState,
} from "./state.ts";
import { withSyntheticHarness } from "../test-utils.ts";

// migrateState/defaultOrchestrationConfig transitively read config; isolate the
// harness env so this file keeps the lint:test-isolation pin.
withSyntheticHarness(beforeEach, afterEach);

function baseState(): OrchestrationState {
  return {
    slot: 3,
    taskId: "task-66a3bbff",
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
  };
}

describe("migrateState — autoResumeNoProgress (gh-ludics-584)", () => {
  test("positive: legacy state without the field loads with it undefined, no throw", () => {
    const legacy = baseState();
    expect("autoResumeNoProgress" in legacy).toBe(false);
    const migrated = migrateState(legacy, 3);
    // Invariant: absent field stays absent (new-field default), not fabricated.
    expect(migrated.autoResumeNoProgress).toBeUndefined();
  });

  test("negative control: corrupt record with non-string taskId/phase is dropped", () => {
    const state = baseState();
    // Simulate a malformed on-disk record (e.g. truncated/old write).
    (state as unknown as { autoResumeNoProgress: unknown }).autoResumeNoProgress = {
      taskId: 123, phase: null, consecutiveTicks: 2,
    };
    const migrated = migrateState(state, 3);
    // Invariant: a malformed key cannot drive the same-(taskId,phase) compare,
    // so the whole record is dropped rather than silently mis-counting.
    expect(migrated.autoResumeNoProgress).toBeUndefined();
  });

  test("negative control: valid key with bad consecutiveTicks is clamped to 0", () => {
    const state = baseState();
    (state as unknown as { autoResumeNoProgress: unknown }).autoResumeNoProgress = {
      taskId: "task-66a3bbff", phase: "setup", consecutiveTicks: -5,
    };
    const migrated = migrateState(state, 3);
    expect(migrated.autoResumeNoProgress).toEqual({
      taskId: "task-66a3bbff", phase: "setup", consecutiveTicks: 0,
    });
  });

  test("negative control: NaN/non-number consecutiveTicks is clamped to 0", () => {
    const state = baseState();
    (state as unknown as { autoResumeNoProgress: unknown }).autoResumeNoProgress = {
      taskId: "task-66a3bbff", phase: "setup", consecutiveTicks: "oops",
    };
    const migrated = migrateState(state, 3);
    expect(migrated.autoResumeNoProgress?.consecutiveTicks).toBe(0);
  });

  test("round-trip: a valid record survives serialize → parse → migrate unchanged", () => {
    const state = baseState();
    state.autoResumeNoProgress = { taskId: "task-66a3bbff", phase: "setup", consecutiveTicks: 2 };
    const roundTripped = JSON.parse(JSON.stringify(state)) as OrchestrationState;
    const migrated = migrateState(roundTripped, 3);
    expect(migrated.autoResumeNoProgress).toEqual({
      taskId: "task-66a3bbff", phase: "setup", consecutiveTicks: 2,
    });
  });
});
